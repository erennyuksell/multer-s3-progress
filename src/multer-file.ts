// What the engine puts on `file` once the object is stored, so a caller reading
// `req.file.key` does not have to cast.
//
// Optional on purpose: multer's `File` is shared by every storage engine, and a
// request that went to disk has none of these. `multer-s3` declares them as
// required, which types a promise the type cannot keep.

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    // eslint-disable-next-line @typescript-eslint/no-namespace
    namespace Multer {
      interface File {
        /** Bucket the object was stored in. */
        bucket?: string;
        /** Key of the stored object. */
        key?: string;
        /** Content type the object was stored with. */
        contentType?: string;
        /** ETag the bucket answered with. */
        etag?: string;
      }
    }
  }
}

export {};
