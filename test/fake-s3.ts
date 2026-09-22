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
  /**
   * Store this many PutObject calls and then answer them with a 500 anyway, as
   * when the answer to a PUT that worked is lost.
   */
  storeThenFailPuts?: number;
  /** Answer this many UploadPart calls with a 500 before storing, to exercise a retry. */
  failPartsBefore?: number;
  /**
   * Keep every version of a key, as a bucket with versioning on does: a write
   * answers with its version, a delete without one only adds a delete marker.
   */
  versioned?: boolean;
  /**
   * Refuse to delete a version: 403 AccessDenied, as AWS answers MFA Delete,
   * Object Lock or a policy without `s3:DeleteObjectVersion`, or 400
   * InvalidRequest, as MinIO answers Object Lock. A plain delete still works.
   */
  denyVersionDeletes?: 403 | 400;
}

/** What a read of one version of a key returns. */
interface StoredVersion {
  id?: string;
  size: number;
  etag: string;
  contentType?: string;
}

function readBody(req: http.IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

const internalError = (res: http.ServerResponse) =>
  res
    .writeHead(500, { 'Content-Type': 'application/xml' })
    .end(
      '<Error><Code>InternalError</Code><Message>We encountered an internal error</Message></Error>',
    );

const accessDenied = (res: http.ServerResponse) =>
  res
    .writeHead(403, { 'Content-Type': 'application/xml' })
    .end('<Error><Code>AccessDenied</Code><Message>Access Denied</Message></Error>');

const wormProtected = (res: http.ServerResponse) =>
  res
    .writeHead(400, { 'Content-Type': 'application/xml' })
    .end(
      '<Error><Code>InvalidRequest</Code><Message>Object is WORM protected and cannot be overwritten</Message></Error>',
    );

/**
 * Path-style S3 with just what the engine needs: PutObject for a body that
 * fits in one part, the multipart trio for anything larger, HeadObject, and
 * DeleteObject for multer's rollback. `objects` maps each stored key to the
 * size of what a read of it would return, and `versionCount` to how many
 * versions of a key are kept.
 */
export function createFakeS3(
  objects: Map<string, number>,
  behavior: FakeS3Behavior = { failDeletes: false },
  versionCount = new Map<string, number>(),
): http.Server {
  const parts = new Map<string, { key: string; sizes: number[]; contentType?: string }>();
  /** Every version of each key, oldest first. A null is a delete marker. */
  const versions = new Map<string, (StoredVersion | null)[]>();

  const current = (key: string) => versions.get(key)?.at(-1) ?? null;

  const sync = (key: string) => {
    const read = current(key);
    if (read) objects.set(key, read.size);
    else objects.delete(key);
    versionCount.set(key, (versions.get(key) ?? []).filter(Boolean).length);
  };

  /** Stores a write, and answers with the headers that describe it. */
  const store = (key: string, version: Omit<StoredVersion, 'id'>): Record<string, string> => {
    const id = behavior.versioned ? crypto.randomUUID() : undefined;
    const kept = behavior.versioned ? (versions.get(key) ?? []) : [];
    versions.set(key, [...kept, { ...version, id }]);
    sync(key);
    return id ? { 'x-amz-version-id': id } : {};
  };

  const remove = (key: string, versionId: string | null) => {
    const kept = versions.get(key) ?? [];
    if (!behavior.versioned) versions.delete(key);
    else if (versionId)
      versions.set(
        key,
        kept.filter((version) => version?.id !== versionId),
      );
    else versions.set(key, [...kept, null]);
    sync(key);
  };

  return http.createServer(async (req, res) => {
    const url = new URL(req.url || '/', 'http://fake-s3');
    const key = decodeURIComponent(url.pathname.split('/').slice(2).join('/'));
    const body = await readBody(req);
    const decoded = req.headers['x-amz-decoded-content-length'];
    const length = decoded ? Number(decoded) : body.length;
    const etag = `"${crypto.createHash('md5').update(body).digest('hex')}"`;
    const contentType = req.headers['content-type'];
    const isPart = url.searchParams.has('partNumber');

    if (req.method === 'PUT' && !isPart && (behavior.failPutsBefore ?? 0) > 0) {
      behavior.failPutsBefore = (behavior.failPutsBefore ?? 0) - 1;
      internalError(res);
    } else if (req.method === 'PUT' && !isPart && (behavior.storeThenFailPuts ?? 0) > 0) {
      behavior.storeThenFailPuts = (behavior.storeThenFailPuts ?? 0) - 1;
      store(key, { size: length, etag, contentType });
      internalError(res);
    } else if (req.method === 'PUT' && isPart && (behavior.failPartsBefore ?? 0) > 0) {
      behavior.failPartsBefore = (behavior.failPartsBefore ?? 0) - 1;
      internalError(res);
    } else if (req.method === 'PUT' && isPart) {
      parts.get(url.searchParams.get('uploadId') || '')?.sizes.push(length);
      res.writeHead(200, { ETag: etag }).end();
    } else if (req.method === 'PUT') {
      res.writeHead(200, { ETag: etag, ...store(key, { size: length, etag, contentType }) }).end();
    } else if (req.method === 'POST' && url.searchParams.has('uploads')) {
      const uploadId = crypto.randomUUID();
      parts.set(uploadId, { key, sizes: [], contentType });
      res
        .writeHead(200, { 'Content-Type': 'application/xml' })
        .end(
          `<InitiateMultipartUploadResult><Key>${key}</Key><UploadId>${uploadId}</UploadId></InitiateMultipartUploadResult>`,
        );
    } else if (req.method === 'POST' && url.searchParams.has('uploadId')) {
      const upload = parts.get(url.searchParams.get('uploadId') || '');
      const stored = upload
        ? store(upload.key, {
            size: upload.sizes.reduce((sum, size) => sum + size, 0),
            etag,
            contentType: upload.contentType,
          })
        : {};
      res
        .writeHead(200, { 'Content-Type': 'application/xml', ...stored })
        .end(
          `<CompleteMultipartUploadResult><Key>${key}</Key><ETag>${etag}</ETag></CompleteMultipartUploadResult>`,
        );
    } else if (req.method === 'HEAD') {
      const read = current(key);
      if (!read) {
        res.writeHead(404).end();
        return;
      }
      res
        .writeHead(200, {
          ETag: read.etag,
          'Content-Length': read.size,
          ...(read.contentType ? { 'Content-Type': read.contentType } : {}),
          ...(read.id ? { 'x-amz-version-id': read.id } : {}),
        })
        .end();
    } else if (req.method === 'DELETE' && behavior.failDeletes) {
      accessDenied(res);
    } else if (
      req.method === 'DELETE' &&
      behavior.denyVersionDeletes &&
      url.searchParams.has('versionId')
    ) {
      if (behavior.denyVersionDeletes === 400) wormProtected(res);
      else accessDenied(res);
    } else if (req.method === 'DELETE') {
      remove(key, url.searchParams.get('versionId'));
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
