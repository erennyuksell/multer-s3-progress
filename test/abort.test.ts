// test/abort.test.ts
// What the engine does when the client goes away in the middle of an upload.
// The socket is driven by hand, because that is the only way to leave a request
// half sent the way a dropped connection does.
//
// multer is what notices: from 2.1.0 it fails a request whose client went away
// and destroys the file stream. What is tested here is the engine's side of
// that, which is stopping rather than completing an upload nobody is waiting
// for, and leaving nothing behind in the bucket.

import express, { type ErrorRequestHandler } from 'express';
import http from 'http';
import multer from 'multer';
import net from 'net';
import { S3Client } from '@aws-sdk/client-s3';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { s3Storage } from '../src/index';
import { close, createFakeS3, listen } from './fake-s3';

const MB = 1024 * 1024;
const BUCKET = 'test-bucket';
const BOUNDARY = 'abort-test';
const openSockets: net.Socket[] = [];

/** Names each call the bucket receives, so a test can wait for one. */
function observedFakeS3(objects: Map<string, number>, calls: string[]): http.Server {
  const inner = createFakeS3(objects);
  return http.createServer((req, res) => {
    const url = new URL(req.url || '/', 'http://fake-s3');
    const multipart = url.searchParams.has('uploadId');
    if (req.method === 'POST')
      calls.push(multipart ? 'CompleteMultipartUpload' : 'CreateMultipartUpload');
    else if (req.method === 'PUT') calls.push(multipart ? 'UploadPart' : 'PutObject');
    else calls.push(multipart ? 'AbortMultipartUpload' : 'DeleteObject');
    inner.emit('request', req, res);
  });
}

function partHead(name: string): Buffer {
  return Buffer.from(
    `--${BOUNDARY}\r\nContent-Disposition: form-data; name="file"; filename="${name}"\r\n` +
      `Content-Type: application/octet-stream\r\n\r\n`,
  );
}

/**
 * Sends a multipart POST that declares `declaredBytes` of body but writes only
 * `body`, so the request stays open the way one does whose connection is about
 * to drop.
 */
async function sendPartialUpload(
  url: string,
  body: Buffer,
  declaredBytes: number,
): Promise<net.Socket> {
  const { hostname, port, pathname } = new URL(url);
  const socket = net.connect(Number(port), hostname);
  openSockets.push(socket);
  socket.on('error', () => undefined);
  await new Promise((resolve) => socket.once('connect', resolve));

  socket.write(
    `POST ${pathname} HTTP/1.1\r\nHost: ${hostname}\r\n` +
      `Content-Type: multipart/form-data; boundary=${BOUNDARY}\r\n` +
      `Content-Length: ${declaredBytes}\r\n\r\n`,
  );
  await new Promise<void>((resolve) => {
    socket.write(body, () => resolve());
  });
  return socket;
}

async function waitFor(condition: () => boolean, what: string, timeoutMs = 5000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

describe('an upload whose client disconnects', () => {
  const objects = new Map<string, number>();
  const calls: string[] = [];
  const events: string[] = [];
  let fakeS3: http.Server;
  let app: http.Server;
  let baseUrl: string;
  let key = '';
  let keys = 0;

  beforeAll(async () => {
    fakeS3 = observedFakeS3(objects, calls);
    const endpoint = await listen(fakeS3);
    const client = new S3Client({
      region: 'auto',
      endpoint,
      credentials: { accessKeyId: 'test', secretAccessKey: 'test' },
      forcePathStyle: true,
      requestChecksumCalculation: 'WHEN_REQUIRED',
    });

    const failed: ErrorRequestHandler = (_err, _req, res, _next) => {
      events.push('failed');
      res.status(400).json({ ok: false });
    };
    const upload = multer({ storage: s3Storage({ client, bucket: BUCKET, key: () => key }) });
    const server = express();
    server.post('/upload', upload.single('file'), (_req, res) => {
      events.push('next');
      res.json({ ok: true });
    });
    server.use(failed);

    app = http.createServer(server);
    baseUrl = await listen(app);
  });

  afterAll(async () => {
    await close(app);
    await close(fakeS3);
  });

  beforeEach(() => {
    objects.clear();
    calls.length = 0;
    events.length = 0;
    keys += 1;
    key = `abort-${keys}.bin`;
  });

  afterEach(() => {
    for (const socket of openSockets.splice(0)) socket.destroy();
  });

  it('is aborted rather than completed, and leaves nothing in the bucket', async () => {
    const socket = await sendPartialUpload(
      `${baseUrl}/upload`,
      Buffer.concat([partHead('big.bin'), Buffer.alloc(7 * MB, 3)]),
      12 * MB,
    );
    await waitFor(() => calls.includes('UploadPart'), 'the first part to reach the bucket');

    socket.destroy();

    await waitFor(() => events.includes('failed'), 'the request to fail');
    await waitFor(() => calls.includes('AbortMultipartUpload'), 'the upload to be aborted');
    expect(calls).not.toContain('CompleteMultipartUpload');
    expect(events).not.toContain('next');
    expect(objects.size).toBe(0);
  }, 20000);
});
