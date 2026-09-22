# Changelog

Versions follow semver. Before 1.0 a minor version may change behavior, and
says so here.

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
