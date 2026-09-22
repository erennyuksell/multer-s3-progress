// Public types of the S3 storage engine. Nothing here imports from the app.

import type { Request } from 'express';
import type { PutObjectCommandInput, S3Client } from '@aws-sdk/client-s3';
import type { Options } from 'multer';

/** Bytes handed to the HTTP layer for one file so far. */
export interface S3UploadProgress {
  loaded: number;
  /**
   * Total bytes of the file, when it is known. A single PUT knows it before the
   * first byte goes out; a multipart upload of a stream learns it only at the end,
   * so a caller that needs a percentage should pass the size it already has.
   */
  total?: number;

  /** Part number of a multipart upload. A single PUT reports 1. */
  part: number;
  /** True once the object is stored, which is after the last byte is sent. */
  done: boolean;
}

export type S3Resolver<T> = (req: Request, file: Express.Multer.File) => T | Promise<T>;

/**
 * Decides the content type of a file with the start of it in hand.
 *
 * `head` is what the engine had to buffer anyway: the whole file when it fits
 * in one part, its first `partSize` bytes when it does not. Returning undefined
 * stores the object without a content type. Anything other than a string or
 * undefined fails the upload.
 */
export type S3ContentTypeResolver = (
  req: Request,
  file: Express.Multer.File,
  head: Buffer,
) => string | undefined | Promise<string | undefined>;

export interface S3StorageOptions {
  /**
   * The client the engine sends with. Build it however you like: the engine
   * neither modifies it nor asks anything of it, and its retries still work.
   *
   * With Cloudflare R2, `requestChecksumCalculation: 'WHEN_REQUIRED'` is worth
   * setting. The default adds a CRC32 trailer that strips `content-length` from
   * a streamed body, which can fail over a slow link with `InvalidChunkSizeError`.
   */
  client: S3Client;
  bucket: string | S3Resolver<string>;
  /** Object key. The caller owns naming, including making it unique. */
  key: S3Resolver<string>;
  /**
   * Content type of the stored object. Defaults to `file.mimetype`, which is
   * what the client called the file.
   *
   * Pass `AUTO_CONTENT_TYPE` to store what the bytes say instead.
   */
  contentType?: S3ContentTypeResolver;
  /**
   * Anything else the caller wants on the request: metadata, cache control, tags.
   * Undefined adds nothing.
   */
  params?: S3Resolver<Partial<PutObjectCommandInput>>;
  /** Bytes buffered before the upload is sent as multipart. Minimum and default 5 MiB. */
  partSize?: number;
  /** Concurrent part uploads of a multipart upload. Default 4. */
  queueSize?: number;
  /**
   * Attempts for a single PUT, including the first. Default 3.
   *
   * The engine retries this call itself because the SDK never retries a request
   * it has streamed: it cannot know the body can be sent again. The parts of a
   * multipart upload are sent as buffers, so those are left to the client.
   */
  attempts?: number;
  /**
   * Called as bytes leave for the bucket, at most once per 64 KiB, and once more
   * when the object is stored.
   */
  onProgress?: (progress: S3UploadProgress, file: Express.Multer.File, req: Request) => void;
  /**
   * The `limits` you give multer. The engine cannot read them from multer, so
   * pass the same object to both.
   *
   * With `fileSize`, `files` and `fields` set, the engine works out the largest
   * body a request within them can have, and refuses a larger `Content-Length`
   * with multer's own `LIMIT_FILE_SIZE` before a byte reaches the bucket. Without
   * the counts the text in a request has no bound, so it skips that check rather
   * than risk refusing a request that fits. Either way a file cut off at
   * `fileSize` is stopped there and never stored.
   */
  limits?: Options['limits'];
}

/**
 * What the engine adds to `file` once the object is stored.
 *
 * No `location`, which `multer-s3` provides: a URL is only meaningful for a
 * public bucket, and building one takes endpoint rules this engine would have to
 * duplicate. Compose it from `bucket` and `key`, or sign one.
 */
export interface S3StoredFile {
  bucket: string;
  key: string;
  size: number;
  contentType?: string;
  etag?: string;
  /**
   * Version the bucket gave the object. Set only when the bucket keeps versions,
   * so never on R2, which does not.
   */
  versionId?: string;
}
