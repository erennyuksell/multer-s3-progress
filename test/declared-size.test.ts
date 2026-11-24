// A file whose size the client declared: streamed to the bucket as it arrives, in one PUT.

import http from 'http';
import { PassThrough, Readable } from 'stream';
import { S3Client } from '@aws-sdk/client-s3';
import { MulterError, type StorageEngine } from 'multer';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  DeclaredSizeError,
  s3Storage,
  type S3StoredFile,
  type S3UploadProgress,
} from '../src/index';
import { close, createFakeS3, listen } from './fake-s3';

const MB = 1024 * 1024;
const BUCKET = 'test-bucket';
const SOURCE_CHUNK = 256 * 1024;

function bytesInChunks(total: number): Readable {
  const chunks: Buffer[] = [];
  for (let offset = 0; offset < total; offset += SOURCE_CHUNK) {
    chunks.push(Buffer.alloc(Math.min(SOURCE_CHUNK, total - offset), 7));
  }
  return Readable.from(chunks);
}

function fileFrom(stream: Readable): Express.Multer.File {
  return {
    fieldname: 'fileData',
    originalname: 'pafta.dwg',
    encoding: '7bit',
    mimetype: 'application/octet-stream',
    size: 0,
    stream,
  } as unknown as Express.Multer.File;
}

function handle(engine: StorageEngine, file: Express.Multer.File): Promise<S3StoredFile> {
  return new Promise((resolve, reject) => {
    engine._handleFile({} as never, file, (err, info) =>
      err ? reject(err) : resolve(info as S3StoredFile),
    );
  });
}

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describe('a file of a declared size', () => {
  const objects = new Map<string, number>();
  let fakeS3: http.Server;
  let client: S3Client;
  let events: S3UploadProgress[] = [];
  let keys = 0;
  let key = '';

  const engine = (size: number | undefined, fileSize?: number) =>
    s3Storage({
      client,
      bucket: BUCKET,
      key: () => key,
      size: () => size,
      limits: fileSize === undefined ? undefined : { fileSize },
      onProgress: (progress) => {
        events.push(progress);
      },
    });

  beforeAll(async () => {
    fakeS3 = createFakeS3(objects);
    client = new S3Client({
      region: 'auto',
      endpoint: await listen(fakeS3),
      credentials: { accessKeyId: 'test', secretAccessKey: 'test' },
      forcePathStyle: true,
      requestChecksumCalculation: 'WHEN_REQUIRED',
    });
  });

  afterAll(async () => {
    client.destroy();
    await close(fakeS3);
  });

  beforeEach(() => {
    objects.clear();
    events = [];
    keys += 1;
    key = `declared-${keys}.bin`;
  });

  it('streams a file under one part to the bucket while it is still arriving', async () => {
    const bytes = 3 * MB;
    const source = new PassThrough();
    const stored = handle(engine(bytes), fileFrom(source));

    // Half the file in, the other half still to come.
    for (let sent = 0; sent < bytes / 2; sent += SOURCE_CHUNK)
      source.write(Buffer.alloc(SOURCE_CHUNK, 7));
    await wait(200);
    const beforeTheEnd = Math.max(0, ...events.map((event) => event.loaded));
    for (let sent = bytes / 2; sent < bytes; sent += SOURCE_CHUNK)
      source.write(Buffer.alloc(SOURCE_CHUNK, 7));
    source.end();

    // Without a declared size nothing of a file under 5 MiB leaves before its end.
    expect(beforeTheEnd).toBeGreaterThan(MB);
    const info = await stored;
    expect(info.size).toBe(bytes);
    expect(objects.get(key)).toBe(bytes);
    expect(events.every((event) => event.total === bytes)).toBe(true);
    const loaded = events.map((event) => event.loaded);
    expect(loaded).toEqual([...loaded].sort((left, right) => left - right));
    expect(events[events.length - 1]).toEqual({ loaded: bytes, total: bytes, part: 1, done: true });
  });

  it('stores a file over one part in a single PUT', async () => {
    const bytes = 12 * MB;
    const info = await handle(engine(bytes), fileFrom(bytesInChunks(bytes)));
    expect(info.size).toBe(bytes);
    expect(objects.get(key)).toBe(bytes);
    expect(events.filter((event) => event.part !== 1)).toEqual([]);
  }, 30000);

  it('refuses a file that ends short of its declared size and stores nothing', async () => {
    await expect(handle(engine(3 * MB), fileFrom(bytesInChunks(MB)))).rejects.toBeInstanceOf(
      DeclaredSizeError,
    );
    await wait(100);
    expect(objects.has(key)).toBe(false);
  });

  it('refuses a file larger than its declared size and stores nothing', async () => {
    const refused = handle(engine(MB), fileFrom(bytesInChunks(3 * MB)));
    await expect(refused).rejects.toMatchObject({ code: 'DECLARED_SIZE_MISMATCH', declared: MB });
    await wait(100);
    expect(objects.has(key)).toBe(false);
  });

  it('checks a small file that ends before streaming against its declared size', async () => {
    await expect(handle(engine(10_000), fileFrom(bytesInChunks(5_000)))).rejects.toBeInstanceOf(
      DeclaredSizeError,
    );
    const info = await handle(engine(5_000), fileFrom(bytesInChunks(5_000)));
    expect(info.size).toBe(5_000);
  });

  it('refuses a declared size over the file size limit before reading a byte', async () => {
    const refused = handle(engine(30 * MB, 25 * MB), fileFrom(bytesInChunks(MB)));
    await expect(refused).rejects.toBeInstanceOf(MulterError);
    expect(events).toEqual([]);
  });

  it('keeps the buffered path when no size is declared, or the value is not a byte count', async () => {
    for (const size of [undefined, -1, 1.5, Number.NaN]) {
      events = [];
      key = `declared-${++keys}.bin`;
      const info = await handle(engine(size), fileFrom(bytesInChunks(MB)));
      expect(info.size).toBe(MB);
    }
  });
});
