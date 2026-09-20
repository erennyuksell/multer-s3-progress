# Changelog

## 0.1.0

First release.

- Multer storage engine for S3 compatible storage, with byte level upload
  progress on both the single PUT and the multipart path.
- Reports the real size of a file, which `multer-s3` leaves at 0 past one part.
- `countingClient`, usable on its own with `@aws-sdk/lib-storage`.
