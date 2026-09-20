// scripts/smoke.ts
//
// Sends real files to a real bucket and prints what the progress looked like.
// Everything it writes goes under `smoke-test/` and is deleted again.
//
//   S3_ENDPOINT=... S3_BUCKET=... S3_KEY_ID=... S3_SECRET=... npm run smoke
//
// Against a local MinIO:
//
//   docker run -d --rm -p 9010:9000 -e MINIO_ROOT_USER=minioadmin \
//     -e MINIO_ROOT_PASSWORD=minioadmin quay.io/minio/minio server /data
//
//   S3_ENDPOINT=http://127.0.0.1:9010 S3_BUCKET=smoke S3_KEY_ID=minioadmin \
//   S3_SECRET=minioadmin S3_PATH_STYLE=1 S3_CREATE_BUCKET=1 npm run smoke

import { Readable } from 'stream';
import { CreateBucketCommand, HeadObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { s3Storage, type S3UploadProgress } from '../src/index';

const MB = 1024 * 1024;
/** The size busboy hands over at a time, roughly. */
const CHUNK = 256 * 1024;

function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is not set`);
  return value;
}

const target = {
  endpoint: required('S3_ENDPOINT'),
  bucket: required('S3_BUCKET'),
  accessKeyId: required('S3_KEY_ID'),
  secretAccessKey: required('S3_SECRET'),
  // An endpoint that is an address rather than a name cannot take the bucket as
  // a subdomain, which is how MinIO is usually reached.
  forcePathStyle: process.env.S3_PATH_STYLE === '1',
};

type Checksums = 'WHEN_REQUIRED' | 'WHEN_SUPPORTED';

function makeClient(checksums: Checksums): S3Client {
  return new S3Client({
    region: process.env.S3_REGION || 'auto',
    endpoint: target.endpoint,
    credentials: { accessKeyId: target.accessKeyId, secretAccessKey: target.secretAccessKey },
    forcePathStyle: target.forcePathStyle,
    requestChecksumCalculation: checksums,
  });
}

/** A stream that hands the bytes over in chunks, the way busboy would. */
function chunkedStream(bytes: number): Readable {
  const chunks: Buffer[] = [];
  for (let offset = 0; offset < bytes; offset += CHUNK) {
    chunks.push(Buffer.alloc(Math.min(CHUNK, bytes - offset), 7));
  }
  return Readable.from(chunks);
}

function fakeFile(bytes: number): Express.Multer.File {
  return {
    fieldname: 'file',
    originalname: 'smoke.bin',
    encoding: '7bit',
    mimetype: 'application/octet-stream',
    size: 0,
    stream: chunkedStream(bytes),
  } as unknown as Express.Multer.File;
}

async function run(label: string, bytes: number, checksums: Checksums) {
  const client = makeClient(checksums);
  const key = `smoke-test/${Date.now()}_${Math.random().toString(36).slice(2)}.bin`;
  const events: Array<S3UploadProgress & { at: number }> = [];
  const started = Date.now();

  const engine = s3Storage({
    client,
    bucket: target.bucket,
    key: () => key,
    onProgress: (progress) => events.push({ ...progress, at: Date.now() - started }),
  });

  const file = fakeFile(bytes);
  console.log(`\n=== ${label}: ${(bytes / MB).toFixed(1)} MB, checksums=${checksums}`);

  const stored = await new Promise<Record<string, unknown>>((resolve, reject) => {
    engine._handleFile({} as never, file, (err, info) =>
      err ? reject(err) : resolve(info as Record<string, unknown>),
    );
  });

  const elapsed = Date.now() - started;
  const onTheWay = events.filter((event) => !event.done);
  console.log(`  took ${elapsed} ms, ${events.length} reports (${onTheWay.length} on the way)`);
  console.log(
    `  size reported ${stored.size}, expected ${bytes}: ${stored.size === bytes ? 'ok' : 'WRONG'}`,
  );

  if (onTheWay.length) {
    const shown = process.env.SMOKE_ALL ? onTheWay : onTheWay.slice(0, 4);
    const sample = shown
      .map((event) => `${event.at}ms:${Math.round((event.loaded / bytes) * 100)}%`)
      .join('  ');
    console.log(`  first reports: ${sample}`);
    // The longest silence is what a progress ring actually shows as a freeze.
    const gaps = onTheWay.map(
      (event, index) => event.at - (index === 0 ? 0 : onTheWay[index - 1].at),
    );
    const tail = elapsed - onTheWay[onTheWay.length - 1].at;
    console.log(`  longest silence ${Math.max(...gaps)} ms, last report to done ${tail} ms`);
    console.log(`  throughput ${(bytes / MB / (elapsed / 1000)).toFixed(2)} MB/s`);
  }

  const head = await client.send(new HeadObjectCommand({ Bucket: target.bucket, Key: key }));
  console.log(
    `  size in the bucket ${head.ContentLength}: ${head.ContentLength === bytes ? 'ok' : 'WRONG'}`,
  );

  await new Promise<void>((resolve, reject) => {
    engine._removeFile({} as never, { ...file, ...stored } as never, (err) =>
      err ? reject(err) : resolve(),
    );
  });
  console.log('  cleaned up');
}

async function main() {
  console.log(`bucket ${target.bucket} at ${target.endpoint}`);

  if (process.env.S3_CREATE_BUCKET === '1') {
    const client = makeClient('WHEN_REQUIRED');
    await client.send(new CreateBucketCommand({ Bucket: target.bucket })).catch((err: Error) => {
      if (!/BucketAlreadyOwnedByYou|BucketAlreadyExists/.test(err.name)) throw err;
    });
    console.log('  bucket ready');
  }

  await run('single PUT', 2 * MB, 'WHEN_REQUIRED');
  if (process.env.SMOKE_ONLY_SINGLE) return;
  await run('multipart', 7 * MB, 'WHEN_REQUIRED');
  await run('multipart, larger', 20 * MB, 'WHEN_REQUIRED');

  // Why the README asks for WHEN_REQUIRED: the default checksum is computed by
  // reading the body before the request goes out, so every byte is counted in
  // the first few milliseconds and the progress stops meaning anything.
  await run('without the checksum setting', 2 * MB, 'WHEN_SUPPORTED');
}

main().then(
  () => process.exit(0),
  (err) => {
    console.error('FAILED:', err);
    process.exit(1);
  },
);
