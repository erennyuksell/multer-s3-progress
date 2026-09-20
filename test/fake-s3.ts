// test/fake-s3.ts
// In-process fake S3 for the engine tests. No request reaches a real bucket.

import crypto from 'crypto';
import http from 'http';
import { AddressInfo } from 'net';

export interface FakeS3Behavior {
  /** Answer DeleteObject with AccessDenied, which the SDK does not retry. */
  failDeletes: boolean;
  /** Answer this many PutObject calls with a 500 before storing, to exercise a retry. */
  failPutsBefore?: number;
  /** Answer this many UploadPart calls with a 500 before storing, to exercise a retry. */
  failPartsBefore?: number;
}

function readBody(req: http.IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

/**
 * Path-style S3 with just what the engine needs: PutObject for a body that
 * fits in one part, the multipart trio for anything larger, and DeleteObject for
 * multer's rollback. `objects` maps each stored key to its size.
 */
export function createFakeS3(
  objects: Map<string, number>,
  behavior: FakeS3Behavior = { failDeletes: false },
): http.Server {
  const parts = new Map<string, { key: string; sizes: number[] }>();

  return http.createServer(async (req, res) => {
    const url = new URL(req.url || '/', 'http://fake-s3');
    const key = decodeURIComponent(url.pathname.split('/').slice(2).join('/'));
    const body = await readBody(req);
    const decoded = req.headers['x-amz-decoded-content-length'];
    const length = decoded ? Number(decoded) : body.length;
    const etag = `"${crypto.createHash('md5').update(body).digest('hex')}"`;

    if (
      req.method === 'PUT' &&
      !url.searchParams.has('partNumber') &&
      (behavior.failPutsBefore ?? 0) > 0
    ) {
      behavior.failPutsBefore = (behavior.failPutsBefore ?? 0) - 1;
      res
        .writeHead(500, { 'Content-Type': 'application/xml' })
        .end(
          '<Error><Code>InternalError</Code><Message>We encountered an internal error</Message></Error>',
        );
    } else if (
      req.method === 'PUT' &&
      url.searchParams.has('partNumber') &&
      (behavior.failPartsBefore ?? 0) > 0
    ) {
      behavior.failPartsBefore = (behavior.failPartsBefore ?? 0) - 1;
      res
        .writeHead(500, { 'Content-Type': 'application/xml' })
        .end(
          '<Error><Code>InternalError</Code><Message>We encountered an internal error</Message></Error>',
        );
    } else if (req.method === 'PUT' && url.searchParams.has('partNumber')) {
      parts.get(url.searchParams.get('uploadId') || '')?.sizes.push(length);
      res.writeHead(200, { ETag: etag }).end();
    } else if (req.method === 'PUT') {
      objects.set(key, length);
      res.writeHead(200, { ETag: etag }).end();
    } else if (req.method === 'POST' && url.searchParams.has('uploads')) {
      const uploadId = crypto.randomUUID();
      parts.set(uploadId, { key, sizes: [] });
      res
        .writeHead(200, { 'Content-Type': 'application/xml' })
        .end(
          `<InitiateMultipartUploadResult><Key>${key}</Key><UploadId>${uploadId}</UploadId></InitiateMultipartUploadResult>`,
        );
    } else if (req.method === 'POST' && url.searchParams.has('uploadId')) {
      const upload = parts.get(url.searchParams.get('uploadId') || '');
      if (upload)
        objects.set(
          upload.key,
          upload.sizes.reduce((sum, size) => sum + size, 0),
        );
      res
        .writeHead(200, { 'Content-Type': 'application/xml' })
        .end(
          `<CompleteMultipartUploadResult><Key>${key}</Key><ETag>${etag}</ETag></CompleteMultipartUploadResult>`,
        );
    } else if (req.method === 'DELETE' && behavior.failDeletes) {
      res
        .writeHead(403, { 'Content-Type': 'application/xml' })
        .end('<Error><Code>AccessDenied</Code><Message>Access Denied</Message></Error>');
    } else if (req.method === 'DELETE') {
      objects.delete(key);
      res.writeHead(204).end();
    } else {
      res.writeHead(400).end();
    }
  });
}

export function listen(server: http.Server): Promise<string> {
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () =>
      resolve(`http://127.0.0.1:${(server.address() as AddressInfo).port}`),
    );
  });
}

export function close(server: http.Server): Promise<void> {
  return new Promise((resolve) => server.close(() => resolve()));
}
