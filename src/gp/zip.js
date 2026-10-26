// Minimal zip read/rewrite for .gp files (a .gp is a zip holding Content/score.gpif, the audio, etc.).
// Used to patch score.gpif after alphaTab has written the file. Entries that aren't replaced are copied
// byte for byte (no recompression), so the embedded audio passes through untouched.
import zlib from "node:zlib";

const LOCAL = 0x04034b50;
const CENTRAL = 0x02014b50;
const END = 0x06054b50;

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

export function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

// Entries in archive order: { name, method, crc, size, raw } where raw is the stored (compressed) data.
export function readZip(buf) {
  buf = Buffer.from(buf.buffer, buf.byteOffset, buf.byteLength);
  let end = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 22 - 0xffff); i--) {
    if (buf.readUInt32LE(i) === END) { end = i; break; }
  }
  if (end < 0) throw new Error("not a zip file (no end of central directory)");
  const count = buf.readUInt16LE(end + 10);
  let p = buf.readUInt32LE(end + 16);
  const entries = [];
  for (let i = 0; i < count; i++) {
    if (buf.readUInt32LE(p) !== CENTRAL) throw new Error("corrupt zip central directory");
    const method = buf.readUInt16LE(p + 10);
    const crc = buf.readUInt32LE(p + 16);
    const csize = buf.readUInt32LE(p + 20);
    const size = buf.readUInt32LE(p + 24);
    const nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const commentLen = buf.readUInt16LE(p + 32);
    const local = buf.readUInt32LE(p + 42);
    const name = buf.toString("utf8", p + 46, p + 46 + nameLen);
    if (buf.readUInt32LE(local) !== LOCAL) throw new Error(`corrupt zip entry ${name}`);
    const dataStart = local + 30 + buf.readUInt16LE(local + 26) + buf.readUInt16LE(local + 28);
    entries.push({ name, method, crc, size, raw: buf.subarray(dataStart, dataStart + csize) });
    p += 46 + nameLen + extraLen + commentLen;
  }
  return entries;
}

export function entryData(entry) {
  if (entry.method === 0) return entry.raw;
  if (entry.method === 8) return zlib.inflateRawSync(entry.raw);
  throw new Error(`unsupported zip compression method ${entry.method} (${entry.name})`);
}

export function makeEntry(name, data) {
  data = Buffer.from(data);
  return { name, method: 8, crc: crc32(data), size: data.length, raw: zlib.deflateRawSync(data) };
}

export function writeZip(entries) {
  const locals = [];
  const centrals = [];
  let offset = 0;
  for (const e of entries) {
    const name = Buffer.from(e.name, "utf8");
    const h = Buffer.alloc(30);
    h.writeUInt32LE(LOCAL, 0);
    h.writeUInt16LE(20, 4); // version needed
    h.writeUInt16LE(0x0800, 6); // UTF-8 names
    h.writeUInt16LE(e.method, 8);
    h.writeUInt32LE(0, 10); // time/date
    h.writeUInt32LE(e.crc, 14);
    h.writeUInt32LE(e.raw.length, 18);
    h.writeUInt32LE(e.size, 22);
    h.writeUInt16LE(name.length, 26);
    h.writeUInt16LE(0, 28);
    const c = Buffer.alloc(46);
    c.writeUInt32LE(CENTRAL, 0);
    c.writeUInt16LE(20, 4); // version made by
    c.writeUInt16LE(20, 6);
    c.writeUInt16LE(0x0800, 8);
    c.writeUInt16LE(e.method, 10);
    c.writeUInt32LE(0, 12);
    c.writeUInt32LE(e.crc, 16);
    c.writeUInt32LE(e.raw.length, 20);
    c.writeUInt32LE(e.size, 24);
    c.writeUInt16LE(name.length, 28);
    c.writeUInt32LE(offset, 42);
    locals.push(h, name, e.raw);
    centrals.push(c, name);
    offset += 30 + name.length + e.raw.length;
  }
  const cdSize = centrals.reduce((s, b) => s + b.length, 0);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(END, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(cdSize, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, ...centrals, end]);
}

// Replace one file inside a zip: fn(oldData: Buffer) -> new data (Buffer or string).
export function rewriteZipEntry(zipBuf, name, fn) {
  const entries = readZip(zipBuf);
  const i = entries.findIndex((e) => e.name === name);
  if (i < 0) throw new Error(`${name} not found in zip`);
  entries[i] = makeEntry(name, fn(entryData(entries[i])));
  return writeZip(entries);
}
