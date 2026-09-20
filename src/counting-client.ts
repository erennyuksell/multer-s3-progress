// Byte level progress for the bodies a client sends, asking nothing of it.
//
// lib-storage hands each part to the SDK as a Buffer, and the HTTP layer writes a
// Buffer in a single call (`httpRequest.end(body)` in @smithy/node-http-handler),
// so nothing is visible until the whole part is stored: a 7 MiB file reports
// twice. Given a stream instead, the same layer pulls the bytes slice by slice,
// which is all a counter needs.
//
// The swap happens in the HTTP layer, after signing and after the length and
// checksum headers are set, so all of them still describe the same bytes.
//
// The client itself is never modified. `Client.send` reads the request handler
// from `this.config` on every call (@smithy/smithy-client), so a proxy that only
// answers `config` differently is enough, and it lives no longer than the upload.

import { EventEmitter } from 'events';
import { Readable } from 'stream';
import type { S3Client } from '@aws-sdk/client-s3';

/** Slice of a counted body. Small enough to report progress smoothly. */
const PROGRESS_SLICE = 64 * 1024;

/** A body this small is one slice anyway, so counting it buys nothing. */
const MIN_COUNTED_BODY = PROGRESS_SLICE;

/** lib-storage listens for this to follow a part of its own upload. */
const PROGRESS_EVENT = 'xhr.upload.progress';

type S3Config = S3Client['config'];
type S3RequestHandler = S3Config['requestHandler'];

/** What is used of a request here. The SDK's own type is not imported, so this folder needs no smithy dependency. */
interface CountableRequest {
  body?: unknown;
}

interface HandlerLike {
  handle(request: unknown, options?: unknown): unknown;
  metadata?: unknown;
  updateHttpClientConfig?(key: unknown, value: unknown): void;
  httpHandlerConfigs?(): unknown;
  destroy?(): void;
}

export interface CountedProgress {
  loaded: number;
  total: number;
}

/** Called for every slice that leaves. `request` carries the part number of a multipart upload. */
export type CountedProgressListener = (progress: CountedProgress, request: unknown) => void;

/**
 * A stream over bytes already held, counted as the HTTP layer takes them.
 *
 * `read` runs only once the reader has taken the previous slice, so the count
 * stays within one slice of the socket.
 */
export function countedBody(data: Buffer, onBytes: (bytes: number) => void): Readable {
  let offset = 0;
  return new Readable({
    read() {
      if (offset >= data.length) {
        this.push(null);
        return;
      }

      const end = Math.min(offset + PROGRESS_SLICE, data.length);
      const slice = data.subarray(offset, end);
      offset = end;
      onBytes(slice.length);
      this.push(slice);
    },
  });
}

/** Passes every request on, after turning a body worth counting into a counted stream. */
class CountingRequestHandler extends EventEmitter {
  constructor(private readonly inner: HandlerLike) {
    super();
    // One listener per part in flight, so the default limit of 10 would warn
    // on a large queue. The handler belongs to a single upload either way.
    this.setMaxListeners(0);
  }

  handle(request: CountableRequest, options?: unknown): unknown {
    const body = request.body;
    if (!Buffer.isBuffer(body) || body.length < MIN_COUNTED_BODY) {
      return this.inner.handle(request, options);
    }

    const total = body.length;
    let loaded = 0;
    request.body = countedBody(body, (bytes) => {
      loaded += bytes;
      this.emit(PROGRESS_EVENT, { loaded, total }, request);
    });

    // The bytes go back on the request once the call is over. A body left as
    // a stream would answer the SDK's question "can this be retried" with no,
    // since a stream it has read is empty the second time. Today that check
    // reads the request as it stood before signing, and signing hands this
    // layer a copy, so it sees the buffer either way. Putting the bytes back
    // keeps the answer right if that copy is ever dropped, and right is yes:
    // the next attempt arrives here as a buffer and is counted from the start.
    const restore = <T>(result: T): T => {
      request.body = body;
      return result;
    };

    return Promise.resolve(this.inner.handle(request, options)).then(restore, (error: unknown) => {
      restore(null);
      throw error;
    });
  }

  /** Read by middleware that branches on the protocol, http/1.1 against h2. */
  get metadata(): unknown {
    return this.inner.metadata;
  }

  updateHttpClientConfig(key: unknown, value: unknown): void {
    this.inner.updateHttpClientConfig?.(key, value);
  }

  httpHandlerConfigs(): unknown {
    return this.inner.httpHandlerConfigs?.() ?? {};
  }

  destroy(): void {
    this.inner.destroy?.();
  }
}

/**
 * The same client, counting the bodies it sends, for the length of one upload.
 *
 * Only `config` is answered differently, and that copy is thrown away with the
 * upload: the client given in is not touched and its other calls are unaffected.
 *
 * A listener is optional. lib-storage adds its own, one per part in flight, and
 * reports the total through `httpUploadProgress`.
 */
export function countingClient(client: S3Client, onProgress?: CountedProgressListener): S3Client {
  const handler = new CountingRequestHandler(
    client.config.requestHandler as unknown as HandlerLike,
  );
  if (onProgress) handler.on(PROGRESS_EVENT, onProgress);

  const config: S3Config = {
    ...client.config,
    requestHandler: handler as unknown as S3RequestHandler,
    // `send` keeps a resolved handler per command when this is on, and that
    // cache would hold on to the counting handler for the caller's own calls.
    cacheMiddleware: false,
  };

  return new Proxy(client, {
    get(target, property, receiver) {
      if (property === 'config') return config;
      // Not bound: `send` has to run with `this` set to the proxy, or it
      // would read the config of the client instead of the one above.
      return Reflect.get(target, property, receiver);
    },
  });
}
