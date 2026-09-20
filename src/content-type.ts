// Storing what a file turns out to be rather than what it was called.
//
// The detection is `file-type`, which knows 100+ formats and is what node
// reaches for. It is deliberately not a dependency of this package: it has been
// ESM only since 17, and pinning it the way `multer-s3` pinned it (at 3.9.0,
// the last release before that move) is part of how that package got stuck.
// Install the version your node takes, 21.x on node 20 and 22.x on node 22, and
// it is loaded from here the first time a file is stored.

import type { S3ContentTypeResolver } from './types';

interface FileTypeResult {
  readonly ext: string;
  readonly mime: string;
}

interface FileTypeModule {
  fileTypeFromBuffer(buffer: Uint8Array): Promise<FileTypeResult | undefined>;
}

let loading: Promise<FileTypeModule> | undefined;

/**
 * Loaded once, and dynamically, which is what lets an ESM only library be used
 * from the CommonJS build of this one.
 */
function loadFileType(): Promise<FileTypeModule> {
  if (!loading) {
    loading = (import('file-type') as Promise<unknown>).then(
      (module) => module as FileTypeModule,
      (cause) => {
        // Let the next upload try again rather than remember the failure.
        loading = undefined;
        throw new Error(
          'AUTO_CONTENT_TYPE reads the file with `file-type`, which is not installed. ' +
            'Add it: npm install file-type (21.x on node 20, 22.x on node 22).',
          { cause },
        );
      },
    );
  }
  return loading;
}

/**
 * Stores the type the bytes say the file is, rather than the one it was sent
 * with.
 *
 *     s3Storage({ client, bucket, key, contentType: AUTO_CONTENT_TYPE })
 *
 * The same idea as `multerS3.AUTO_CONTENT_TYPE`, read differently. That one
 * took the first chunk off the stream and handed back a replacement stream to
 * put it back; here the bytes are the ones the engine had buffered anyway, so
 * the stream is left alone. It also sees far more of the file than one chunk,
 * which is what a format needs when its header is not at the very start: a
 * `.docx` read 4 KB in is only a zip.
 *
 * A file `file-type` does not recognise, a text file for instance, keeps the
 * type the client gave it.
 */
export const AUTO_CONTENT_TYPE: S3ContentTypeResolver = async (_req, file, head) => {
  if (head.length === 0) return file.mimetype;

  const { fileTypeFromBuffer } = await loadFileType();
  const found = await fileTypeFromBuffer(head);
  return found?.mime ?? file.mimetype;
};
