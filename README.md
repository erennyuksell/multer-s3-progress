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

// The same limits go to multer and to the engine, which cannot read them from multer.
const limits = { fileSize: 25 * 1024 * 1024, files: 1, fields: 0 };

const upload = multer({
  limits,
  storage: s3Storage({
    client: new S3Client({ region: 'auto', endpoint, credentials }),
    bucket: 'my-bucket',
    key: (req, file) => `${Date.now()}_${file.originalname}`,
    limits,
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

Asked for upstream more than once: progress events in
[#65](https://github.com/anacronw/multer-s3/issues/65) and [#114](https://github.com/anacronw/multer-s3/issues/114), both closed without one; the
size of a multipart upload in [#204](https://github.com/anacronw/multer-s3/pull/204), an open pull request, and
[#208](https://github.com/anacronw/multer-s3/issues/208); an upload cancelled part way leaving a zero byte object
behind in [#164](https://github.com/anacronw/multer-s3/issues/164).

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

`contentType` defaults to `file.mimetype`, which is what the client called the
file. To store what it turns out to be instead:

```bash
npm install file-type   # 21.x on node 20, 22.x on node 22
```

```ts
import { s3Storage, AUTO_CONTENT_TYPE } from 'multer-s3-progress';

s3Storage({ client, bucket, key, contentType: AUTO_CONTENT_TYPE });
```

`file-type` is an optional peer dependency, loaded only when a file is stored
this way, from 17 on, which is where `fileTypeFromBuffer` comes from. It is not
pinned here: it has been ESM only since 17 and its node
requirement moves, so the version is yours to choose, and the dynamic import
keeps it working from a CommonJS application.

Or decide yourself: `contentType` is `(req, file, head) => string | undefined`,
where `head` is the start of the file the engine had buffered anyway. That is
the one place the shape differs from `multer-s3`, whose version took a callback
and had to hand back a replacement stream because it had consumed the real one
to see those bytes. Here they are already in hand, so nothing is taken apart.

### Files a browser would run

A browser opens some types as a page and runs the scripts in them: HTML, SVG,
XML and a few more. The stored type is what the client said, and
`AUTO_CONTENT_TYPE` keeps that for text formats `file-type` cannot place, these
among them. So if you serve uploads from your own domain, whoever uploads a page
runs it there as if you had written it.

What protects against that is how the files are served, which is yours to
decide: send them as downloads, or open inline only the types you mean to show,
such as PDFs and images. When the browser gets the object from the bucket
itself (a signed URL, a public bucket), store the header with it through
`params`, which sees the request and the file:

```ts
s3Storage({ client, bucket, key, params: () => ({ ContentDisposition: 'attachment' }) });
```

Importing the package also types what it puts on the file, so `req.file.key`
and `req.file.bucket` read without a cast. They are optional, because multer's
`File` is shared with every other storage engine and a file that went to disk
has none of them.

`total` is known for a single PUT and unknown for a multipart upload, because a
stream has no length until it ends. A caller that needs a percentage for large
files should send the size it already has along with the file.

### Fields sent with the file

multer reads the body in order and hands the file to the engine as soon as it
reaches it, and `key`, `bucket` and `params` are called before a byte of the
file is read. A text field that comes after the file is not on `req.body` yet,
so they see it as missing.
It is the question asked most often on multer-s3
([#71](https://github.com/anacronw/multer-s3/issues/71), [#76](https://github.com/anacronw/multer-s3/issues/76), [#102](https://github.com/anacronw/multer-s3/issues/102), [#128](https://github.com/anacronw/multer-s3/issues/128)).

Append the fields before the file on the client, since `FormData` keeps the
order they were appended in, or put what the key needs in the URL, where
`req.params` and `req.query` are ready before the body is read.

## About the client

Build it however you like. The engine neither modifies it nor requires anything
of it, and its retries still work.

Three details are worth knowing:

- **The engine retries the single PUT itself**, three times by default. The SDK
  never retries a request it has streamed, since it cannot know the body can be
  sent again, so this is the only retry that call gets and the two never stack.
  Multipart parts are sent as buffers and are retried by the client. A PUT can
  fail after the bucket stored it, when the answer is lost, so before sending
  it again the engine asks with a HEAD whether these exact bytes are there
  (same size, type and MD5 ETag). Otherwise a versioned bucket would keep a
  second copy the engine never hears of. The HEAD needs `s3:GetObject`, and
  without an answer the PUT is sent again as before.
- **`requestChecksumCalculation: 'WHEN_REQUIRED'` for R2.** R2 accepted the SDK
  default in a September 2026 test, so this is not about storing the object. It
  is about progress: the default adds a CRC32 trailer, and computing it reads
  the body before the request goes out, so the whole file is counted in the
  first few milliseconds and the progress means nothing. In the same test, a
  2 MB upload reported 100 % after 5 ms and then sat silent for 2.65 s. The
  trailer also replaces `content-length` on a streamed body, which has been
  reported to fail over a slow link with `InvalidChunkSizeError` since SDK 3.729.
- **Keep `@aws-sdk/client-s3` and `@aws-sdk/lib-storage` at the same version.**
  They share internal packages, and a mismatched pair fails in ways that look
  like someone else's bug: a bucket name repeated in the URL and
  `this.client.config.endpoint is not a function` were both traced to one in
  multer-s3 [#192](https://github.com/anacronw/multer-s3/issues/192). Both are peer dependencies here, so the pair is yours
  to keep in step.

## About multer

`multer` 2.3.0 or newer. Two releases matter:

- **2.1.0 is the first that notices a client going away mid upload.** Before
  it, busboy stops feeding the file stream without ending it, so the engine
  never hears that the file is over: the request waits for a write that never
  finishes and the multipart upload sits open in the bucket. From 2.1.0 multer
  fails the request and destroys the file stream, which this engine takes as its
  signal to abort. There is a test for it.
- **2.3.0 is the first that takes a file of exactly `fileSize` bytes.** Before
  it, busboy stopped at the limit itself, and multer refused the file as too
  large. The engine goes by the same signal, so on 2.2 it refused it too, and
  its tests pin the behavior of 2.3.

2.1.0 also added `defParamCharset`. Without it a filename is read as
latin1, so a name written in UTF-8 by the browser reaches your `key` function one
character per byte. Passing `'utf8'` fixes that at the source, but it is not
strictly better: latin1 keeps the bytes as they arrived, so a name a client
really did send in latin1 survives and can be repaired afterwards, while utf8
turns it into replacement characters that cannot. Pass it when you know your
clients send UTF-8, which browsers do.

## Size limits

Give the engine the `limits` you give multer. Two things follow from them.

**A file over `fileSize` is stopped where it goes over.** busboy does not fail
the stream at the limit: it emits `'limit'`, marks the stream `truncated` and
ends it as if the file were whole. Taken as an ordinary end, the cut-off bytes
would be stored, and multer, which waits for the engine before it answers, would
say "too large" only once they were in the bucket and deleted again. The engine
aborts on `'limit'` instead: nothing is stored, and a multipart upload already
open is aborted in the bucket. This happens with or without `limits`.

**A request that cannot fit is refused before a byte is read.** multer only
notices a file is too large once it has read that far, and the engine holds at
most `partSize * queueSize` bytes (20 MiB by default). Above that, reaching the
limit takes as long as the bucket needs for the parts before it. Against R2, a
25.5 MB file sent to a 25 MB limit was refused after 14.8 s when the cut-off
bytes were stored and deleted, and after 10.6 s when stopped at the limit alone.
With `fileSize`, `files` and `fields` in `limits`, the engine works out the
largest body a request within them can have and refuses a larger
`Content-Length` at once, with multer's own `MulterError('LIMIT_FILE_SIZE')`, so
your error handling sees the error it already knows. The same 25.5 MB file was
refused in 0.04 s, and a file just under the limit was still stored.

It needs the counts because it must never refuse a request that fits. Without
`files` and `fields` the text in a request has no bound, so the check is
skipped rather than guessed. Each field counts at `fieldSize` (multer's default
is 1 MiB), so a small `fieldSize` keeps the check tight; each part is allowed
4 KiB for its boundary and headers. A request sent without `Content-Length`
(chunked) is left to the limit.

If you wrap this engine and hand it a stream of your own in place of
`file.stream`, forward the `'limit'` event and the `truncated` flag, or the
engine cannot see the limit.

## Coming from multer-s3

The options are the same shape: `bucket`, `key`, `contentType`, `params`. The
differences:

- **The client's type is kept.** `multer-s3` stored `application/octet-stream`
  unless told otherwise, so an image downloaded instead of showing. See
  [Files a browser would run](#files-a-browser-would-run) for what that means.
- **No `file.location`.** A URL only means something for a public bucket, and
  building one takes endpoint rules this engine would rather not duplicate, so
  it would have been right on one code path and missing on the other. Compose it
  from `file.bucket` and `file.key`, or sign one.
- **A rollback deletes the version it stored.** In a bucket that keeps
  versions, multer-s3 deletes the key, which only adds a delete marker: the
  version it stored stays, and if the key held an object before the request,
  that object is hidden too. This engine deletes the version it wrote, so the
  object before it is current again. That takes `s3:DeleteObjectVersion`
  rather than `s3:DeleteObject`, and MFA Delete and Object Lock refuse it
  outright. Refused, the engine falls back to the delete marker: what the key
  held before is hidden as well, but the file multer is rolling back is not
  left current. Tested against MinIO, with versioning on and with Object Lock.
- **`AUTO_CONTENT_TYPE` reads more of the file.** `multer-s3` took the first
  chunk off the stream and had `file-type` 3.9.0 pinned into it, which is a
  release from 2018 and part of why that package could not move. Here the bytes
  are the ones the engine had buffered anyway, megabytes rather than one chunk,
  and `file-type` is an optional peer dependency at whatever version you want.
  It matters: a `.docx` read a few kilobytes in is only a zip.

`file.bucket`, `file.key`, `file.size`, `file.contentType`, `file.etag` and
`file.versionId` are set as before, and `size` is now the real size rather than
0 on a large file. `versionId` is set only by a bucket that keeps versions.

## What it does not do

ACLs, server side encryption, storage classes and tagging are not options. Pass
anything the request needs through `params`, which is merged into the command
input as it is.

Metadata in `params` travels as HTTP headers, and S3 takes only US-ASCII
values there. With SDK 3.1136 on node 22, against MinIO:

- `Ayşe` fails before it is sent, with `Invalid character in header content`:
  node refuses a header character above U+00FF.
- `Müge` is stored, and read back RFC 2047 encoded as `=?UTF-8?q?M=C3=BCge?=`,
  which is also what AWS documents for such values.
- An `undefined` value is stored as the string `"undefined"`. That is the case
  multer-s3 [#178](https://github.com/anacronw/multer-s3/issues/178) hit, back when the SDK threw on it instead.

Encode the values, with `encodeURIComponent` for instance, and leave out the
ones you do not have.

**It does not change the file.** Resizing an image, compressing it, stripping
its EXIF: the bytes that arrive are the bytes stored. That was asked of
multer-s3 more than anything else ([#47](https://github.com/anacronw/multer-s3/issues/47), [#48](https://github.com/anacronw/multer-s3/issues/48), [#81](https://github.com/anacronw/multer-s3/issues/81), [#118](https://github.com/anacronw/multer-s3/issues/118)), and pull requests
[#56](https://github.com/anacronw/multer-s3/pull/56), [#116](https://github.com/anacronw/multer-s3/pull/116) and [#201](https://github.com/anacronw/multer-s3/pull/201) tried it. The engine exists to say how much of what the user
sent has reached the bucket, and with a transform in between the count and the
size would be of a different file than the one the user is waiting on. Take the
file with multer's `memoryStorage` and send what you make of it yourself, or
transform the stored object after the upload.

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
