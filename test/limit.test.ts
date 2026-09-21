// test/limit.test.ts
// What the engine does with a file multer's size limit cuts short.
//
// busboy does not fail the file stream at the limit: it emits 'limit', marks the
// stream truncated and ends it normally. Read as an ordinary end, the engine
// stored the cut-off bytes, and multer, which waits for pending writes before it
// rolls the request back, only answered once they were stored and deleted again.
// With a slow bucket that was the whole upload of the first `fileSize` bytes: an
// answer of "too large" took 11 seconds for a 45 MB file against R2.

import express, { type ErrorRequestHandler } from 'express';
import http from 'http';
import multer from 'multer';
import { S3Client } from '@aws-sdk/client-s3';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { s3Storage } from '../src/index';
import { close, createFakeS3, listen } from './fake-s3';

const MB = 1024 * 1024;
const BUCKET = 'test-bucket';
/** How long the fake bucket takes to answer each part: a bucket slower than the client. */
const PART_DELAY_MS = 2000;

/** Names each call the bucket receives and holds every part back for a while. */
function slowFakeS3(objects: Map<string, number>, calls: string[]): http.Server {
  const inner = createFakeS3(objects);
  return http.createServer((req, res) => {
    const url = new URL(req.url || '/', 'http://fake-s3');
    const multipart = url.searchParams.has('uploadId');
    if (req.method === 'POST')
      calls.push(multipart ? 'CompleteMultipartUpload' : 'CreateMultipartUpload');
    else if (req.method === 'PUT') calls.push(multipart ? 'UploadPart' : 'PutObject');
    else calls.push(multipart ? 'AbortMultipartUpload' : 'DeleteObject');
    const delay = req.method === 'PUT' && multipart ? PART_DELAY_MS : 0;
    setTimeout(() => inner.emit('request', req, res), delay);
  });
}

describe('a file over the size limit', () => {
  const objects = new Map<string, number>();
  const calls: string[] = [];
  let fakeS3: http.Server;
  let app: http.Server;
  let client: S3Client;
  let baseUrl = '';
  let keys = 0;

  beforeAll(async () => {
    fakeS3 = slowFakeS3(objects, calls);
    client = new S3Client({
      region: 'auto',
      endpoint: await listen(fakeS3),
      credentials: { accessKeyId: 'test', secretAccessKey: 'test' },
      forcePathStyle: true,
      requestChecksumCalculation: 'WHEN_REQUIRED',
    });
    const key = () => `limit-${++keys}.bin`;

    const server = express();
    // Unbounded: only `fileSize`, as most apps pass it. The engine is not told.
    const unbounded: Array<[string, number]> = [
      ['/multipart', 7 * MB],
      ['/single', 1 * MB],
    ];
    for (const [path, fileSize] of unbounded) {
      const storage = s3Storage({ client, bucket: BUCKET, key });
      server.post(path, multer({ storage, limits: { fileSize } }).single('file'), (_req, res) => {
        res.json({ stored: true });
      });
    }
    // Bounded: the counts are given, and the same limits go to multer and the engine.
    // One part in flight at a time, so without the check the limit would be reached
    // only after the bucket took the part before it.
    const bounded: Array<[string, multer.Options['limits']]> = [
      ['/bounded', { fileSize: 7 * MB, files: 1, fields: 0 }],
      ['/bounded-small', { fileSize: 1 * MB, files: 1, fields: 0 }],
      ['/bounded-fields', { fileSize: 1 * MB, files: 1, fields: 2, fieldSize: 100 }],
    ];
    for (const [path, limits] of bounded) {
      const storage = s3Storage({ client, bucket: BUCKET, key, limits, queueSize: 1 });
      server.post(path, multer({ storage, limits }).single('file'), (_req, res) => {
        res.json({ stored: true });
      });
    }
    const onError: ErrorRequestHandler = (err, _req, res, _next) => {
      res.status(400).json({ code: (err as { code?: string }).code });
    };
    server.use(onError);
    app = http.createServer(server);
    baseUrl = await listen(app);
  });

  afterAll(async () => {
    client.destroy();
    await close(app);
    await close(fakeS3);
  });

  beforeEach(() => {
    objects.clear();
    calls.length = 0;
  });

  async function waitFor(check: () => boolean, what: string): Promise<void> {
    const deadline = Date.now() + 10000;
    while (!check()) {
      if (Date.now() > deadline) throw new Error(`gave up waiting for ${what}`);
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
  }

  async function upload(path: string, bytes: number, fields: Record<string, string> = {}) {
    const form = new FormData();
    for (const [name, value] of Object.entries(fields)) form.append(name, value);
    form.append('file', new Blob([new Uint8Array(bytes).fill(7)]), 'big.bin');
    const started = Date.now();
    const res = await fetch(`${baseUrl}${path}`, { method: 'POST', body: form });
    return { status: res.status, body: await res.json(), elapsed: Date.now() - started };
  }

  it('is abandoned the moment it goes over, not stored and then deleted', async () => {
    const reply = await upload('/multipart', 12 * MB);

    expect(reply.status).toBe(400);
    expect(reply.body).toEqual({ code: 'LIMIT_FILE_SIZE' });
    // Not waiting for a part the bucket is still holding back.
    expect(reply.elapsed).toBeLessThan(PART_DELAY_MS);
    // The answer does not wait for the clean-up, which follows on its own.
    await waitFor(() => calls.includes('AbortMultipartUpload'), 'the upload to be aborted');
    expect(calls).not.toContain('CompleteMultipartUpload');
    expect(objects.size).toBe(0);
  }, 20000);

  it('never sends the cut-off bytes of a file that fits in one part', async () => {
    const reply = await upload('/single', 3 * MB);

    expect(reply.status).toBe(400);
    expect(reply.body).toEqual({ code: 'LIMIT_FILE_SIZE' });
    expect(calls).not.toContain('PutObject');
    expect(calls).not.toContain('DeleteObject');
    expect(objects.size).toBe(0);
  }, 20000);

  it('is refused before the bucket hears of it when the body cannot fit the limits', async () => {
    const reply = await upload('/bounded', 12 * MB);

    expect(reply.status).toBe(400);
    expect(reply.body).toEqual({ code: 'LIMIT_FILE_SIZE' });
    expect(reply.elapsed).toBeLessThan(PART_DELAY_MS);
    expect(calls).toEqual([]);
    expect(objects.size).toBe(0);
  }, 20000);

  it('stores a file of exactly the limit, which fits', async () => {
    const reply = await upload('/bounded-small', 1 * MB);

    expect(reply.status).toBe(200);
    expect(objects.size).toBe(1);
  });

  it('refuses a file just over the limit without sending it', async () => {
    const reply = await upload('/bounded-small', 1 * MB + 16 * 1024);

    expect(reply.status).toBe(400);
    expect(reply.body).toEqual({ code: 'LIMIT_FILE_SIZE' });
    expect(calls).toEqual([]);
  });

  it('counts the fields the limits allow as part of a body that fits', async () => {
    // multer refuses a field of exactly `fieldSize` (unlike a file, it gets no extra byte).
    const text = 'x'.repeat(99);
    const reply = await upload('/bounded-fields', 1 * MB, { name: text, type: text });

    expect(reply.status).toBe(200);
    expect(objects.size).toBe(1);
  });
});
