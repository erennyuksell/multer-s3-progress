// Multer storage engine for S3 compatible object storage, with upload progress.
//
// Self-contained on purpose: no import from the application, so this folder can
// be lifted into its own package. Its only dependencies are the AWS SDK client,
// lib-storage and the multer and express types.

// Side effect only: it types `file.key` and the rest for anyone reading them
// off `req.file`.
import './multer-file';

export { s3Storage } from './engine';
export type {
  S3StorageOptions,
  S3StoredFile,
  S3Resolver,
  S3ContentTypeResolver,
  S3UploadProgress,
} from './types';

// Opt in to storing what a file turns out to be. Needs `file-type` installed.
export { AUTO_CONTENT_TYPE } from './content-type';

// Useful on its own to anyone sending with lib-storage: it turns its per part
// progress into per slice progress without touching the client it is given.
export { countingClient } from './counting-client';
export type { CountedProgress, CountedProgressListener } from './counting-client';
