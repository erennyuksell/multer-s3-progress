// test/engine.test.ts
// The storage engine against an in-process fake bucket. No request leaves the
// machine. The numbers in the README come from `scripts/smoke.ts`, which runs
// against a real one.

import http from 'http';
import { PassThrough, Readable } from 'stream';
import { S3Client } from '@aws-sdk/client-s3';
import type { StorageEngine } from 'multer';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  AUTO_CONTENT_TYPE,
  s3Storage,
  type S3StoredFile,
  type S3UploadProgress,
} from '../src/index';
import { close, createFakeS3, type FakeS3Behavior, listen } from './fake-s3';

const MB = 1024 * 1024;
const BUCKET = 'test-bucket';
/** The size busboy hands over at a time, roughly. */
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
    originalname: 'evrak.bin',
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

function remove(engine: StorageEngine, stored: S3StoredFile): Promise<void> {
  return new Promise((resolve, reject) => {
    engine._removeFile({} as never, stored as never, (err) => (err ? reject(err) : resolve()));
  });
}

describe('s3-engine', () => {
  const objects = new Map<string, number>();
  const versionCount = new Map<string, number>();
  const behavior: FakeS3Behavior = { failDeletes: false };
  let events: S3UploadProgress[] = [];
  let fakeS3: http.Server;
  let client: S3Client;
  let keys = 0;
  let key = '';

  /** An engine writing to a key of its own, so the specs cannot collide. */
  const engine = (
    onProgress = (progress: S3UploadProgress) => {
      events.push(progress);
    },
  ) => s3Storage({ client, bucket: BUCKET, key: () => key, onProgress });

  beforeAll(async () => {
    fakeS3 = createFakeS3(objects, behavior, versionCount);
    const endpoint = await listen(fakeS3);
    client = new S3Client({
      region: 'auto',
      endpoint,
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
    versionCount.clear();
    events = [];
    behavior.failDeletes = false;
    behavior.failPutsBefore = 0;
    behavior.storeThenFailPuts = 0;
    behavior.failPartsBefore = 0;
    behavior.versioned = false;
    behavior.denyVersionDeletes = undefined;
    keys += 1;
    key = `spec-${keys}.bin`;
  });

  it('reports the bytes of a single PUT as they leave for the bucket', async () => {
    const bytes = 512 * 1024;

    const stored = await handle(engine(), fileFrom(bytesInChunks(bytes)));

    expect(stored.size).toBe(bytes);
    expect(stored.key).toBe(key);
    expect(objects.get(key)).toBe(bytes);

    // Several reports, never going backwards, the last one when it is stored.
    expect(events.length).toBeGreaterThan(1);
    expect(events.every((event) => event.total === bytes)).toBe(true);
    const loaded = events.map((event) => event.loaded);
    expect(loaded).toEqual([...loaded].sort((left, right) => left - right));
    expect(events[events.length - 1]).toEqual({ loaded: bytes, total: bytes, part: 1, done: true });
  });

  it('reports the exact size and the bytes on the way of a file that goes multipart', async () => {
    const bytes = 5 * MB + 1;

    const stored = await handle(engine(), fileFrom(bytesInChunks(bytes)));

    // multer-s3 reported 0 here, which is what the size backfill script had to repair.
    expect(stored.size).toBe(bytes);
    expect(objects.get(key)).toBe(bytes);

    // lib-storage on its own reports once per stored part, so twice for this
    // file. Counting the bodies it sends turns that into a report per slice.
    const sent = events.filter((event) => !event.done);
    expect(sent.length).toBeGreaterThan(20);
    expect(sent.some((event) => event.loaded > 0 && event.loaded < 5 * MB)).toBe(true);

    const loaded = sent.map((event) => event.loaded);
    expect(loaded).toEqual([...loaded].sort((left, right) => left - right));

    const last = events[events.length - 1];
    expect(last.done).toBe(true);
    expect(last.loaded).toBe(bytes);
  }, 30000);

  it('retries a single PUT the bucket refused', async () => {
    behavior.failPutsBefore = 1;
    const bytes = 64 * 1024;

    const stored = await handle(engine(), fileFrom(bytesInChunks(bytes)));

    // The SDK will not retry a request it has streamed, so this is the
    // engine's own retry, with the body rebuilt for the second attempt.
    expect(stored.size).toBe(bytes);
    expect(objects.get(key)).toBe(bytes);
  });

  it('does not store a file twice when a PUT that failed had stored it', async () => {
    behavior.versioned = true;
    behavior.storeThenFailPuts = 1;
    const engineUnderTest = engine();

    const stored = await handle(engineUnderTest, fileFrom(bytesInChunks(4096)));

    // Asked before sending again, the bucket said the file was there: one
    // version, and it is the one the engine reports, so a rollback removes it.
    expect(versionCount.get(key)).toBe(1);
    expect(stored.versionId).toBeDefined();
    expect(events[events.length - 1]).toEqual({ loaded: 4096, total: 4096, part: 1, done: true });

    await remove(engineUnderTest, stored);

    expect(objects.has(key)).toBe(false);
  });

  it('retries a part of a multipart upload the bucket refused', async () => {
    behavior.failPartsBefore = 1;
    const bytes = 5 * MB + 1;

    const stored = await handle(engine(), fileFrom(bytesInChunks(bytes)));

    // Parts are sent as buffers and the client retries them, which counting
    // the bodies does not take away. The size also shows that the refused
    // attempt was not stored on top of the one that worked.
    expect(stored.size).toBe(bytes);
    expect(objects.get(key)).toBe(bytes);
  }, 30000);

  it('does not fail an upload because a progress listener threw', async () => {
    const throwing = engine(() => {
      throw new Error('listener down');
    });

    const stored = await handle(throwing, fileFrom(bytesInChunks(4096)));

    expect(stored.size).toBe(4096);
    expect(objects.get(key)).toBe(4096);
  });

  it('stores a file with no bytes in it', async () => {
    const stored = await handle(engine(), fileFrom(Readable.from([])));

    expect(stored.size).toBe(0);
    expect(objects.get(key)).toBe(0);
  });

  it('fails instead of storing a file whose source broke halfway', async () => {
    const source = new PassThrough();
    const stored = handle(engine(), fileFrom(source));

    source.write(Buffer.alloc(6 * MB, 3));
    setTimeout(() => source.destroy(new Error('connection dropped')), 50);

    await expect(stored).rejects.toThrow();
    // Nothing was completed, so there is no half file under that key.
    expect(objects.has(key)).toBe(false);
  }, 30000);

  it('fails rather than waiting when the source failed before it was read', async () => {
    const source = new PassThrough();
    const stored = handle(engine(), fileFrom(source));

    // A stream that is already over emits nothing more, so an engine that
    // waits for 'end' or 'error' here would never answer and hang the request.
    source.destroy(new Error('client went away'));

    await expect(stored).rejects.toThrow();
    expect(objects.has(key)).toBe(false);
  });

  it('stores the type the bytes turned out to be when asked to', async () => {
    // A real 1x1 PNG: file-type reads past the signature to tell PNG from APNG.
    const png = Buffer.from(
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
      'base64',
    );
    const engineUnderTest = s3Storage({
      client,
      bucket: BUCKET,
      key: () => key,
      contentType: AUTO_CONTENT_TYPE,
    });

    // The client called it a nameless blob, which is what is sent when nothing
    // knows any better.
    const stored = await handle(engineUnderTest, fileFrom(Readable.from([png])));

    expect(stored.contentType).toBe('image/png');
  });

  it('stores what the client called the file when it is not asked to look', async () => {
    const stored = await handle(engine(), fileFrom(bytesInChunks(4096)));

    expect(stored.contentType).toBe('application/octet-stream');
  });

  it('stores the file when params has nothing to add and says so with undefined', async () => {
    const engineUnderTest = s3Storage({
      client,
      bucket: BUCKET,
      key: () => key,
      params: () => undefined as never,
    });

    const stored = await handle(engineUnderTest, fileFrom(bytesInChunks(4096)));

    expect(stored.size).toBe(4096);
    expect(objects.get(key)).toBe(4096);
  });

  it('fails the upload, not the process, when a resolver answers nonsense', async () => {
    const badType = s3Storage({
      client,
      bucket: BUCKET,
      key: () => key,
      contentType: () => 42 as never,
    });
    const badParams = s3Storage({
      client,
      bucket: BUCKET,
      key: () => key,
      params: () => 'x' as never,
    });

    await expect(handle(badType, fileFrom(bytesInChunks(4096)))).rejects.toThrow(
      /contentType must resolve/,
    );
    await expect(handle(badParams, fileFrom(bytesInChunks(4096)))).rejects.toThrow(
      /params must resolve/,
    );
    expect(objects.has(key)).toBe(false);
  });

  it('deletes the object it stored when multer rolls the request back', async () => {
    const engineUnderTest = engine();
    const stored = await handle(engineUnderTest, fileFrom(bytesInChunks(4096)));
    expect(objects.has(key)).toBe(true);

    await remove(engineUnderTest, stored);

    expect(objects.has(key)).toBe(false);
  });

  it('returns the version a versioned bucket gave the object, single PUT and multipart', async () => {
    behavior.versioned = true;

    const whole = await handle(engine(), fileFrom(bytesInChunks(4096)));
    const multipart = await handle(engine(), fileFrom(bytesInChunks(5 * MB + 1)));

    expect(whole.versionId).toMatch(/^[0-9a-f-]{36}$/);
    expect(multipart.versionId).toMatch(/^[0-9a-f-]{36}$/);
    expect(multipart.versionId).not.toBe(whole.versionId);
  }, 30000);

  it('rolls back only its own version, so an object the key held before comes back', async () => {
    behavior.versioned = true;
    const engineUnderTest = engine();
    await handle(engineUnderTest, fileFrom(bytesInChunks(1000)));
    const stored = await handle(engineUnderTest, fileFrom(bytesInChunks(4096)));
    expect(objects.get(key)).toBe(4096);

    await remove(engineUnderTest, stored);

    expect(objects.get(key)).toBe(1000);
  });

  it.each([403, 400] as const)(
    'hides its version behind a delete marker when the bucket refuses to delete a version (%i)',
    async (status) => {
      behavior.versioned = true;
      behavior.denyVersionDeletes = status;
      const engineUnderTest = engine();
      await handle(engineUnderTest, fileFrom(bytesInChunks(1000)));
      const stored = await handle(engineUnderTest, fileFrom(bytesInChunks(4096)));

      await remove(engineUnderTest, stored);

      // The object before it is hidden too, but the rolled back file is not left current.
      expect(objects.has(key)).toBe(false);
    },
  );

  it('reports a rollback the bucket refused altogether', async () => {
    behavior.versioned = true;
    const engineUnderTest = engine();
    const stored = await handle(engineUnderTest, fileFrom(bytesInChunks(4096)));
    behavior.failDeletes = true;

    await expect(remove(engineUnderTest, stored)).rejects.toThrow();
    expect(objects.get(key)).toBe(4096);
  });

  it('sets no version when the bucket keeps none', async () => {
    const stored = await handle(engine(), fileFrom(bytesInChunks(4096)));

    expect(stored.versionId).toBeUndefined();
  });

  it('leaves the client it was given alone', async () => {
    const before = client.config.requestHandler;

    await handle(engine(), fileFrom(bytesInChunks(6 * MB)));

    expect(client.config.requestHandler).toBe(before);
    expect(objects.get(key)).toBe(6 * MB);
  }, 30000);
});
