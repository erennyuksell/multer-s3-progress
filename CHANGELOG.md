# Changelog

Versions follow semver. Before 1.0 a minor version may change behavior, and
says so here.

## 0.3.0 (2026-11-24)

### Added

- **`size`: a file whose size the client declared is streamed to the bucket as
  it arrives**, in one PUT of that length. Without it the engine holds up to one
  part to learn the size, so a file under `partSize` reaches the bucket only after
  its last byte has come in, and a larger one leaves its last part to write then.
  Against R2, a 3 MB and a 12 MB PUT streamed at 1 MB/s were stored 197 ms and
  239 ms after their last byte.
- `DeclaredSizeError` (`code: 'DECLARED_SIZE_MISMATCH'`): a file that ends short
  of its declared size or runs past it. The last chunk is held back until the
  file ends, so a longer file can never fill the PUT and be stored cut short;
  nothing of it is stored. A declared size over `limits.fileSize` fails with
  `LIMIT_FILE_SIZE` before a byte is read.

A streamed PUT cannot be sent again, so `attempts` does not apply to it. Without
`size` nothing changes.

## 0.2.1 (2026-10-08)

### Fixed

- A rollback on Cloudflare R2 deletes the object. R2 returns a version id from
  every write but answers a delete that names one with 501 NotImplemented, and
  0.2.0 took that for a failure: the rollback rejected and the file stayed in
  the bucket. A 501 now falls back to a plain delete, as a refusal does.

## 0.2.0 (2026-09-22)

### Changed

- **A rollback in a versioned bucket deletes the version it stored** rather
  than adding a delete marker, so an object the key held before comes back.
  This needs `s3:DeleteObjectVersion`. Refused, by MFA Delete, Object Lock or
  the policy, it falls back to the delete marker.
- Needs node 20 or newer, as the AWS SDK does, and multer 2.3.0 or newer, the
  first that takes a file of exactly `fileSize` bytes.
- A `contentType` resolver answering anything but a string or undefined, or
  `params` answering anything but an object or undefined, fails the upload with
  a `TypeError`.

### Added

- `file.versionId`, the version a bucket that keeps versions gave the object.

### Fixed

- The types resolve for a CommonJS consumer under `node16` or `nodenext`
  module resolution, which was handed the ESM declarations.
- `file-type` is asked for from 17 on. 16 was allowed but never worked: it has
  no `fileTypeFromBuffer`.
- A single PUT that failed after the bucket had stored it is no longer stored a
  second time. Before a retry the engine asks with a HEAD (it needs
  `s3:GetObject`) whether the same bytes are already there.

## 0.1.0

First release. Not published to npm; depended on from git.

- Multer storage engine for S3 compatible storage, with byte level upload
  progress on both the single PUT and the multipart path.
- Reports the real size of a file, which `multer-s3` leaves at 0 past one part.
- `countingClient`, usable on its own with `@aws-sdk/lib-storage`.
- An upload is aborted, and nothing is left in the bucket, when the client
  goes away or the file goes over multer's size limit. With `limits`, a body
  that cannot fit them is refused before a byte is read.
- The single PUT is retried by the engine, since the SDK never retries a body
  it has streamed.
- `AUTO_CONTENT_TYPE`, which stores what `file-type` reads in the bytes.
