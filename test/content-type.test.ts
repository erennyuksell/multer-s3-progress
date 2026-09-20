// test/content-type.test.ts
// What AUTO_CONTENT_TYPE makes of a file. The detection is `file-type`; what is
// checked here is that it is given enough of the file to answer well, and that
// a file it cannot place keeps the type the client sent.

import { describe, expect, it } from 'vitest';
import { AUTO_CONTENT_TYPE } from '../src/index';

const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});

function crc32(data: Buffer): number {
  let crc = 0xffffffff;
  for (const byte of data) crc = CRC_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

/** A zip with uncompressed entries, which is all an Office file is. */
function storedZip(entries: Record<string, string>): Buffer {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;

  for (const [name, text] of Object.entries(entries)) {
    const nameBytes = Buffer.from(name, 'utf8');
    const data = Buffer.from(text, 'utf8');
    const crc = crc32(data);

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(nameBytes.length, 26);
    locals.push(local, nameBytes, data);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(data.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(nameBytes.length, 28);
    central.writeUInt32LE(offset, 42);
    centrals.push(central, nameBytes);

    offset += local.length + nameBytes.length + data.length;
  }

  const centralDirectory = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(Object.keys(entries).length, 8);
  end.writeUInt16LE(Object.keys(entries).length, 10);
  end.writeUInt32LE(centralDirectory.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, centralDirectory, end]);
}

const DOCX = storedZip({
  '[Content_Types].xml':
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
    '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
    '<Default Extension="xml" ContentType="application/xml"/>' +
    '<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>',
  'word/document.xml': '<?xml version="1.0"?><w:document/>',
});

/** A real 1x1 PNG: file-type reads past the signature to tell PNG from APNG. */
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
);

const file = (mimetype: string): Express.Multer.File =>
  ({ fieldname: 'file', originalname: 'x', mimetype }) as unknown as Express.Multer.File;

const auto = (head: Buffer, claimed = 'application/octet-stream') =>
  AUTO_CONTENT_TYPE({} as never, file(claimed), head);

describe('AUTO_CONTENT_TYPE', () => {
  it('stores what the bytes say when the client had no idea', async () => {
    await expect(auto(Buffer.from('%PDF-1.7\n'))).resolves.toBe('application/pdf');
    await expect(auto(PNG)).resolves.toBe('image/png');
  });

  it('overrules a client that was plainly wrong', async () => {
    await expect(auto(Buffer.from('%PDF-1.7\n'), 'image/png')).resolves.toBe('application/pdf');
  });

  it('calls a .docx a .docx, not a zip', async () => {
    // The engine hands over everything it buffered rather than a first chunk,
    // which is what tells an Office file apart from the zip it is made of.
    await expect(auto(DOCX)).resolves.toBe(
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    );
  });

  it('keeps the claim for a file that has no signature to read', async () => {
    await expect(auto(Buffer.from('id,name\n1,eren\n'), 'text/csv')).resolves.toBe('text/csv');
    await expect(auto(Buffer.alloc(0), 'text/plain')).resolves.toBe('text/plain');
  });
});
