import zlib from 'node:zlib';
import { checkRelativePath } from './fs-safe.mjs';

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let index = 0; index < 256; index += 1) {
    let value = index;
    for (let bit = 0; bit < 8; bit += 1) {
      value = value & 1 ? (value >>> 1) ^ 0xedb88320 : value >>> 1;
    }
    table[index] = value >>> 0;
  }
  return table;
})();

export function crc32(buffer) {
  let value = 0xffffffff;
  for (const byte of buffer) value = CRC_TABLE[(value ^ byte) & 0xff] ^ (value >>> 8);
  return (value ^ 0xffffffff) >>> 0;
}

const DOS_TIME = 0;
const DOS_DATE = 0x0021;
const UTF8_FLAG = 0x0800;

function normalizeEntries(entries) {
  const seen = new Set();
  const seenLower = new Set();
  return entries.map(entry => {
    const name = checkRelativePath(entry.path, 'ZIP entry path');
    const lower = name.toLowerCase();
    if (seen.has(name)) throw new Error(`Duplicate ZIP entry: ${name}`);
    if (seenLower.has(lower)) throw new Error(`Duplicate ZIP entry (case-insensitive): ${name}`);
    seen.add(name);
    seenLower.add(lower);
    const data = Buffer.isBuffer(entry.data) ? entry.data : Buffer.from(entry.data);
    const executable = Boolean(entry.executable);
    const mode = executable ? 0o100755 : 0o100644;
    return { name, data, mode };
  }).map(entry => {
    if (Buffer.byteLength(entry.name) > 65535) throw new Error(`ZIP entry name is too long: ${entry.name}`);
    return entry;
  }).sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
}

function localHeader(entry, compressed, crc) {
  const name = Buffer.from(entry.name, 'utf8');
  const header = Buffer.alloc(30);
  header.writeUInt32LE(0x04034b50, 0);
  header.writeUInt16LE(20, 4);
  header.writeUInt16LE(UTF8_FLAG, 6);
  header.writeUInt16LE(8, 8);
  header.writeUInt16LE(DOS_TIME, 10);
  header.writeUInt16LE(DOS_DATE, 12);
  header.writeUInt32LE(crc, 14);
  header.writeUInt32LE(compressed.length, 18);
  header.writeUInt32LE(entry.data.length, 22);
  header.writeUInt16LE(name.length, 26);
  header.writeUInt16LE(0, 28);
  return { header, name };
}

function centralHeader(entry, compressed, crc, offset) {
  const name = Buffer.from(entry.name, 'utf8');
  const header = Buffer.alloc(46);
  header.writeUInt32LE(0x02014b50, 0);
  header.writeUInt16LE(0x031e, 4);
  header.writeUInt16LE(20, 6);
  header.writeUInt16LE(UTF8_FLAG, 8);
  header.writeUInt16LE(8, 10);
  header.writeUInt16LE(DOS_TIME, 12);
  header.writeUInt16LE(DOS_DATE, 14);
  header.writeUInt32LE(crc, 16);
  header.writeUInt32LE(compressed.length, 20);
  header.writeUInt32LE(entry.data.length, 24);
  header.writeUInt16LE(name.length, 28);
  header.writeUInt16LE(0, 30);
  header.writeUInt16LE(0, 32);
  header.writeUInt16LE(0, 34);
  header.writeUInt16LE(0, 36);
  header.writeUInt32LE((entry.mode << 16) >>> 0, 38);
  header.writeUInt32LE(offset, 42);
  return { header, name };
}

export function createZip(entries) {
  const normalized = normalizeEntries(entries);
  if (normalized.length > 65535) throw new Error('ZIP contains too many entries');
  const localParts = [];
  const centralParts = [];
  let offset = 0;
  for (const entry of normalized) {
    const compressed = zlib.deflateRawSync(entry.data, { level: 9 });
    const crc = crc32(entry.data);
    const local = localHeader(entry, compressed, crc);
    const central = centralHeader(entry, compressed, crc, offset);
    localParts.push(local.header, local.name, compressed);
    centralParts.push(central.header, central.name);
    offset += local.header.length + local.name.length + compressed.length;
  }
  const centralSize = centralParts.reduce((sum, part) => sum + part.length, 0);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(0, 4);
  end.writeUInt16LE(0, 6);
  end.writeUInt16LE(normalized.length, 8);
  end.writeUInt16LE(normalized.length, 10);
  end.writeUInt32LE(centralSize, 12);
  end.writeUInt32LE(offset, 16);
  end.writeUInt16LE(0, 20);
  return Buffer.concat([...localParts, ...centralParts, end]);
}

export function readZip(buffer, {
  maxEntries = 10000,
  maxEntrySize = 25 * 1024 * 1024,
  maxTotalSize = 100 * 1024 * 1024,
} = {}) {
  const endOffset = buffer.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  if (endOffset < 0) throw new Error('ZIP end record not found');
  const count = buffer.readUInt16LE(endOffset + 10);
  const centralSize = buffer.readUInt32LE(endOffset + 12);
  const centralOffset = buffer.readUInt32LE(endOffset + 16);
  if (count === 0xffff) throw new Error('ZIP64 archives are not supported');
  if (count > maxEntries) throw new Error(`ZIP contains more than ${maxEntries} entries`);
  if (centralOffset + centralSize > endOffset) throw new Error('ZIP central directory is out of bounds');
  const entries = [];
  const seen = new Set();
  const seenLower = new Set();
  let total = 0;
  let cursor = centralOffset;
  for (let index = 0; index < count; index += 1) {
    if (cursor + 46 > buffer.length) throw new Error('ZIP central directory record is out of bounds');
    if (buffer.readUInt32LE(cursor) !== 0x02014b50) throw new Error('Invalid ZIP central directory record');
    const crc = buffer.readUInt32LE(cursor + 16);
    const compressedSize = buffer.readUInt32LE(cursor + 20);
    const size = buffer.readUInt32LE(cursor + 24);
    const nameLength = buffer.readUInt16LE(cursor + 28);
    const extraLength = buffer.readUInt16LE(cursor + 30);
    const commentLength = buffer.readUInt16LE(cursor + 32);
    const externalAttributes = buffer.readUInt32LE(cursor + 38);
    const localOffset = buffer.readUInt32LE(cursor + 42);
    const name = buffer.toString('utf8', cursor + 46, cursor + 46 + nameLength);
    const lower = name.toLowerCase();
    if (seen.has(name)) throw new Error(`Duplicate ZIP entry: ${name}`);
    if (seenLower.has(lower)) throw new Error(`Duplicate ZIP entry (case-insensitive): ${name}`);
    seen.add(name);
    seenLower.add(lower);
    if (size === 0xffffffff || compressedSize === 0xffffffff || localOffset === 0xffffffff) throw new Error('ZIP64 archives are not supported');
    if (size > maxEntrySize) throw new Error(`ZIP entry exceeds ${maxEntrySize} bytes: ${name}`);
    if (compressedSize > maxEntrySize) throw new Error(`ZIP entry compressed size exceeds ${maxEntrySize} bytes: ${name}`);
    total += size;
    if (total > maxTotalSize) throw new Error(`ZIP contents exceed ${maxTotalSize} bytes`);
    if (localOffset + 30 > buffer.length) throw new Error(`ZIP local header is out of bounds: ${name}`);
    if (buffer.readUInt32LE(localOffset) !== 0x04034b50) throw new Error(`Invalid ZIP local header: ${name}`);
    const localNameLength = buffer.readUInt16LE(localOffset + 26);
    const localExtraLength = buffer.readUInt16LE(localOffset + 28);
    const dataOffset = localOffset + 30 + localNameLength + localExtraLength;
    if (dataOffset + compressedSize > buffer.length) throw new Error(`ZIP entry data is out of bounds: ${name}`);
    const data = zlib.inflateRawSync(
      buffer.subarray(dataOffset, dataOffset + compressedSize),
      size > 0 ? { maxOutputLength: size } : undefined,
    );
    if (data.length !== size) throw new Error(`ZIP size mismatch: ${name}`);
    if (crc32(data) !== crc) throw new Error(`ZIP CRC mismatch: ${name}`);
    entries.push({ path: name, data, mode: (externalAttributes >>> 16) & 0xffff, externalAttributes });
    cursor += 46 + nameLength + extraLength + commentLength;
  }
  return entries;
}
