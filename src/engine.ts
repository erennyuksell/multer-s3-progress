// A multer storage engine that stores to S3 compatible object storage and
// reports how much of the file has actually left for the bucket.
//
// WHY NOT multer-s3: it hands the stream to lib-storage, whose progress event
// in node fires once a part is stored, so a file under the part size reports
// nothing until it is done and its `size` is 0 for anything larger. This engine
// buffers up to one part to learn the exact size, then sends the bytes itself,
// counting them on the way out. Past one part lib-storage still does the
// bookkeeping, over a client that counts the bodies it sends: see
// `counting-client.ts`.
//
// Nothing here imports from the application: the client, the key and everything
// else arrives through options, so the folder can be published as it is.

import type { Request } from 'express';
import type { StorageEngine } from 'multer';
import { PassThrough, Readable, Transform, finished } from 'stream';
import { DeleteObjectCommand, PutObjectCommand } from '@aws-sdk/client-s3';
import { Upload } from '@aws-sdk/lib-storage';
import { countedBody, countingClient } from './counting-client';
import type { S3StorageOptions, S3StoredFile, S3UploadProgress } from './types';

/** S3 refuses a part below this, so it is also the smallest sensible buffer. */
const MIN_PART_SIZE = 5 * 1024 * 1024;
const DEFAULT_ATTEMPTS = 3;

interface ResolvedTarget {
  bucket: string;
  key: string;
  contentType?: string;
  extra: Partial<PutObjectCommand['input']>;
}

/** Everything that can be known before a byte of the file has been read. */
async function resolveTarget(
  options: S3StorageOptions,
  req: Request,
  file: Express.Multer.File,
): Promise<Omit<ResolvedTarget, 'contentType'>> {
  const bucket =
    typeof options.bucket === 'function' ? await options.bucket(req, file) : options.bucket;
  const key = await options.key(req, file);
  const extra = options.params ? await options.params(req, file) : {};

  if (!bucket) throw new Error('s3-engine: bucket is empty');
  if (!key) throw new Error('s3-engine: key is empty');

  return { bucket, key, extra };
}

/**
 * Settled once the start of the file is in hand, so a resolver can read it.
 *
 * Waiting costs nothing: those bytes are buffered for the size either way, and
 * nothing has gone to the bucket yet.
 */
async function resolveContentType(
  options: S3StorageOptions,
  req: Request,
  file: Express.Multer.File,
  head: Buffer,
): Promise<string | undefined> {
  if (!options.contentType) return file.mimetype;
  return options.contentType(req, file, head);
}

/**
 * Reads the stream until it ends or `limit` bytes are held.
 *
 * An ended stream gives the whole file in `head`, which is what makes an exact
 * `ContentLength` possible. Otherwise `rest` replays the buffered bytes and then
 * the remainder, so the reader downstream sees the file unchanged.
 */
function readUpTo(
  source: Readable,
  limit: number,
  done: (err: Error | null, head: Buffer, ended: boolean, rest: Readable) => void,
): void {
  const chunks: Buffer[] = [];
  let length = 0;
  let settled = false;

  const settle = (err: Error | null, ended: boolean) => {
    if (settled) return;
    settled = true;
    source.removeListener('data', onData);
    // Assigned below, and nothing can settle before a later tick.
    stop();

    if (err) {
      done(err, Buffer.alloc(0), false, source);
      return;
    }

    const buffered = Buffer.concat(chunks, length);
    if (ended) {
      done(null, buffered, true, source);
      return;
    }

    // Paused here and resumed by `pipe`, so no chunk is lost in between.
    source.pause();
    const rest = new PassThrough();
    if (buffered.length > 0) rest.write(buffered);
    source.pipe(rest);
    // A failure of the source is not passed on by `pipe`. Destroying `rest`
    // without an error stops the reader instead of leaving it waiting.
    finished(source, { writable: false }, (streamErr) => {
      if (streamErr) rest.destroy();
    });
    done(null, buffered, false, rest);
  };

  const onData = (chunk: Buffer) => {
    chunks.push(chunk);
    length += chunk.length;
    if (length > limit) settle(null, false);
  };

  source.on('data', onData);
  // `finished` rather than an 'end' and an 'error' listener: it also settles a
  // stream that ended or failed before this call, which will not emit either
  // event again and would leave the upload waiting for a file that is over.
  // It settles a stream torn down without ending too, so a truncated file
  // fails instead of being stored short.
  const stop = finished(source, { writable: false }, (streamErr) =>
    settle(streamErr ?? null, !streamErr),
  );
}

/** A 4xx other than 429 is the caller's fault and will fail again the same way. */
function isRetryable(error: unknown): boolean {
  const status = (error as { $metadata?: { httpStatusCode?: number } })?.$metadata?.httpStatusCode;
  if ((error as { name?: string })?.name === 'AbortError') return false;
  if (typeof status !== 'number') return true;
  return status === 429 || status >= 500;
}

const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export function s3Storage(options: S3StorageOptions): StorageEngine {
  const partSize = Math.max(options.partSize ?? MIN_PART_SIZE, MIN_PART_SIZE);
  const attempts = Math.max(options.attempts ?? DEFAULT_ATTEMPTS, 1);

  const report = (req: Request, file: Express.Multer.File, progress: S3UploadProgress) => {
    if (!options.onProgress) return;
    try {
      options.onProgress(progress, file, req);
    } catch {
      // A progress listener must never fail the upload.
    }
  };

  /** One PUT of bytes we already hold, so the exact size is known up front. */
  async function putWhole(
    req: Request,
    file: Express.Multer.File,
    target: ResolvedTarget,
    body: Buffer,
    abort: AbortController,
  ): Promise<S3StoredFile> {
    let lastError: unknown;

    for (let attempt = 1; attempt <= attempts; attempt++) {
      let loaded = 0;
      try {
        const response = await options.client.send(
          new PutObjectCommand({
            ...target.extra,
            Bucket: target.bucket,
            Key: target.key,
            ContentType: target.contentType,
            ContentLength: body.length,
            Body: countedBody(body, (bytes) => {
              loaded += bytes;
              report(req, file, { loaded, total: body.length, part: 1, done: false });
            }),
          }),
          { abortSignal: abort.signal },
        );

        report(req, file, { loaded: body.length, total: body.length, part: 1, done: true });
        return {
          bucket: target.bucket,
          key: target.key,
          size: body.length,
          contentType: target.contentType,
          etag: response.ETag,
        };
      } catch (err) {
        lastError = err;
        if (attempt === attempts || !isRetryable(err)) break;
        // The body is rebuilt on the next pass: a consumed stream cannot be resent.
        await delay(200 * attempt);
      }
    }

    throw lastError;
  }

  /**
   * Anything past one part goes to lib-storage, which retries a failed part on
   * its own. It sends over a counting client, so the bytes of a part in flight
   * are reported as they go out rather than only once the part is stored.
   */
  async function putMultipart(
    req: Request,
    file: Express.Multer.File,
    target: ResolvedTarget,
    body: Readable,
    abort: AbortController,
  ): Promise<S3StoredFile> {
    let size = 0;
    const counted = new Transform({
      transform(chunk: Buffer, _encoding, next) {
        size += chunk.length;
        next(null, chunk);
      },
    });
    body.pipe(counted);
    finished(body, { writable: false }, (err) => {
      if (err) counted.destroy();
    });

    const upload = new Upload({
      client: countingClient(options.client),
      abortController: abort,
      partSize,
      queueSize: options.queueSize ?? 4,
      params: {
        ...target.extra,
        Bucket: target.bucket,
        Key: target.key,
        ContentType: target.contentType,
        Body: counted,
      },
    });

    // A stream has no total, so only `loaded` is meaningful here.
    let lastPart = 1;
    upload.on('httpUploadProgress', (event) => {
      lastPart = event.part ?? lastPart;
      report(req, file, {
        loaded: event.loaded ?? 0,
        total: event.total,
        part: lastPart,
        done: false,
      });
    });

    const response = await upload.done();
    report(req, file, { loaded: size, total: size, part: lastPart, done: true });

    return {
      bucket: target.bucket,
      key: target.key,
      size,
      contentType: target.contentType,
      etag: (response as { ETag?: string }).ETag,
    };
  }

  return {
    _handleFile(req, file, cb) {
      const source = file.stream;
      const abort = new AbortController();
      // The request is over for this file either way: stop the upload rather
      // than leave parts in the bucket that are neither completed nor aborted.
      finished(source, { writable: false }, (err) => {
        if (err) abort.abort();
      });

      resolveTarget(options, req as Request, file).then(
        (base) => {
          readUpTo(source, partSize, (readErr, head, ended, rest) => {
            if (readErr) {
              cb(readErr);
              return;
            }

            resolveContentType(options, req as Request, file, head).then(
              (contentType) => {
                const target: ResolvedTarget = { ...base, contentType };
                const stored = ended
                  ? putWhole(req as Request, file, target, head, abort)
                  : putMultipart(req as Request, file, target, rest, abort);

                stored.then(
                  (info) => cb(null, info as Partial<Express.Multer.File>),
                  (err: Error) => cb(err),
                );
              },
              (err: Error) => {
                // Drain, so busboy can read past this file to the rest of the body.
                rest.resume();
                cb(err);
              },
            );
          });
        },
        (err: Error) => {
          // Drain, so busboy can read past this file to the rest of the body.
          source.resume();
          cb(err);
        },
      );
    },

    _removeFile(req, file, cb) {
      const stored = file as unknown as S3StoredFile;
      if (!stored.key) {
        cb(null);
        return;
      }

      options.client.send(new DeleteObjectCommand({ Bucket: stored.bucket, Key: stored.key })).then(
        () => cb(null),
        (err: Error) => cb(err),
      );
    },
  };
}
