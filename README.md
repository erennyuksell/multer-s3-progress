# multer-s3-progress

A multer storage engine for S3 compatible storage that reports real upload
progress. Written to replace `multer-s3`, which has been unmaintained since
2022 and cannot report progress in node.

```bash
npm install multer-s3-progress @aws-sdk/client-s3 @aws-sdk/lib-storage
```

```ts
import multer from 'multer';
import { S3Client } from '@aws-sdk/client-s3';
import { s3Storage } from 'multer-s3-progress';

const upload = multer({
  storage: s3Storage({
    client: new S3Client({ region: 'auto', endpoint, credentials }),
    bucket: 'my-bucket',
    key: (req, file) => `${Date.now()}_${file.originalname}`,
    onProgress: ({ loaded, total, done }) => console.log(loaded, total, done),
  }),
});
```

## Why it exists

`multer-s3` hands the file stream to `@aws-sdk/lib-storage`. In node, that
library learns of progress only when a part is stored, so:

- a file smaller than the part size reports nothing until it is done,
- a larger file is stored correctly but comes back with `size: 0`,
- the caller cannot tell a slow upload from a stuck one.

Open issues and pull requests upstream: anacronw/multer-s3 #65, #114, #164,
#204, #208.

## How it works

The engine buffers up to one part (5 MiB by default).

- **The stream ends inside that buffer.** The exact size is known, so the bytes
  go out as a single `PutObject` whose body the engine feeds in 64 KiB slices,
  counting them as the HTTP layer takes them.
- **The stream is larger.** The buffered head and the remainder go to
  `lib-storage`, which does the multipart bookkeeping. The size is counted on
  the way through, which is what `multer-s3` gets wrong, and the parts are
  counted too, see below.

Either way a slice is counted when the HTTP layer asks for the next one, which
it does only once the socket has taken the previous one. The count therefore
runs at most 64 KiB ahead of the wire.

Sending the single `PUT` as a stream has a second effect worth knowing: the
signer hashes a buffer body to sign it and marks a streamed one
`UNSIGNED-PAYLOAD`, so this path does not pay a SHA-256 pass over the file on
the event loop.

### Counting what lib-storage sends

`lib-storage` hands each part to the SDK as a `Buffer`, and the HTTP layer
writes a buffer in a single call (`httpRequest.end(body)` in
`@smithy/node-http-handler`), so nothing is visible until the whole part is
stored. Given a stream instead, the same layer pulls the bytes slice by slice.

`counting-client.ts` makes that swap in the HTTP layer, which is late enough
that the signature and the length and checksum headers already describe the same
bytes. It does not touch the client it is given: `Client.send` reads the request
handler from `this.config` on every call, so a proxy that answers `config`
differently is enough, and it lives no longer than the upload.

`lib-storage` then aggregates the parts itself. It already listens for
`xhr.upload.progress` on a request handler that is an `EventEmitter`, which is
how it follows a browser upload, and it tells concurrent parts apart by the
part number on the request.

## Measured against Cloudflare R2

On a link of about 1.5 MB/s, September 2026:

| File             | Updates | Longest silence | After the last update |
| ---------------- | ------- | --------------- | --------------------- |
| 2 MB, single PUT | 32      | 1.14 s          | 0.33 s                |
| 7 MB, multipart  | 114     | 0.45 s          | 0.33 s                |
| 20 MB, multipart | 324     | 0.43 s          | 0.32 s                |

Before the parts were counted, 7 MB reported twice: at 29 % and at 100 %.

Two things to expect. The updates arrive in bursts as the socket drains rather
than evenly, and on a single PUT the first few land in the same millisecond:
that is the send buffer taking the first 256 KB, and it is also the 1.14 s
silence that follows. And the count reaches the total a fraction before the
object is stored, because the response only comes after the last byte.

### Tested against

- **Cloudflare R2**, September 2026: the numbers above.
- **MinIO** RELEASE.2025-09-07T16-13-09Z, path style addressing: the same update
  counts, exact sizes, single PUT and multipart both stored and deleted.
- **An in-process fake S3** in the spec, which is where the edges are: a refused
  PUT, a refused part, a source that breaks halfway, a source that was already
  gone, a file with no bytes, and a rollback.

Not tried against AWS S3 itself, Backblaze B2 or Wasabi.

## Usage

```ts
const engine = s3Storage({
  client,
  bucket: 'my-bucket',
  key: (req, file) => `${req.params.id}/${Date.now()}_${file.originalname}`,
  onProgress: ({ loaded, total, done }) => report(loaded, total, done),
});
```

`contentType` defaults to `file.mimetype`, which is whatever the caller decided
about the file, so content detection stays out of this engine.

Importing the package also types what it puts on the file, so `req.file.key`
and `req.file.bucket` read without a cast. They are optional, because multer's
`File` is shared with every other storage engine and a file that went to disk
has none of them.

`total` is known for a single PUT and unknown for a multipart upload, because a
stream has no length until it ends. A caller that needs a percentage for large
files should send the size it already has along with the file.

## About the client

Build it however you like. The engine neither modifies it nor requires anything
of it, and its retries still work.

Two details are worth knowing:

- **The engine retries the single PUT itself**, three times by default. The SDK
  never retries a request it has streamed, since it cannot know the body can be
  sent again, so this is the only retry that call gets and the two never stack.
  Multipart parts are sent as buffers and are retried by the client.
- **`requestChecksumCalculation: 'WHEN_REQUIRED'` for R2.** R2 accepted the SDK
  default in a September 2026 test, so this is not about storing the object. It
  is about progress: the default adds a CRC32 trailer, and computing it reads
  the body before the request goes out, so the whole file is counted in the
  first few milliseconds and the progress means nothing. In the same test, a
  2 MB upload reported 100 % after 5 ms and then sat silent for 2.65 s. The
  trailer also replaces `content-length` on a streamed body, which has been
  reported to fail over a slow link with `InvalidChunkSizeError` since SDK 3.729.

## About multer

`multer` 2.1.0 or newer, which is the first release that notices a client going
away mid upload. Before it, busboy stops feeding the file stream without ending
it, so the engine never hears that the file is over: the request waits for a
write that never finishes and the multipart upload sits open in the bucket. From
2.1.0 multer fails the request and destroys the file stream, which this engine
takes as its signal to abort. There is a test for it.

The same release added `defParamCharset`. Pass `defParamCharset: 'utf8'` to
multer if your users upload files with non ASCII names, or "Haritasi.pdf" with a
Turkish dotless i reaches your `key` function one character per byte.

## Coming from multer-s3

The options are the same shape: `bucket`, `key`, `contentType`, `params`. Two
differences:

- **No `file.location`.** A URL only means something for a public bucket, and
  building one takes endpoint rules this engine would rather not duplicate, so
  it would have been right on one code path and missing on the other. Compose it
  from `file.bucket` and `file.key`, or sign one.
- **No content type detection.** `multer-s3` had `AUTO_CONTENT_TYPE`, which read
  the first bytes of the file. `contentType` defaults to `file.mimetype` and
  takes a function, so detection stays a decision of the caller.

`file.bucket`, `file.key`, `file.size`, `file.contentType` and `file.etag` are
set as before, and `size` is now the real size rather than 0 on a large file.

## What it does not do

ACLs, server side encryption, storage classes and tagging are not options. Pass
anything the request needs through `params`, which is merged into the command
input as it is.

## Development

```bash
npm install
npm run ci      # typecheck, lint, format, tests against an in-process fake bucket
npm run build   # dist/, esm and cjs, with types
```

The numbers above come from `scripts/smoke.ts`, which sends real files to a real
bucket and deletes them again. Against a local MinIO:

```bash
docker run -d --rm -p 9010:9000 -e MINIO_ROOT_USER=minioadmin \
  -e MINIO_ROOT_PASSWORD=minioadmin quay.io/minio/minio server /data

S3_ENDPOINT=http://127.0.0.1:9010 S3_BUCKET=smoke S3_KEY_ID=minioadmin \
S3_SECRET=minioadmin S3_PATH_STYLE=1 S3_CREATE_BUCKET=1 npm run smoke
```
