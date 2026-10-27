// Minimal zip read/rewrite for .gp files (a .gp is a zip holding Content/score.gpif, the audio, etc.).
// Used to patch score.gpif after alphaTab has written the file. Entries that aren't replaced are copied
// byte for byte (no recompression), so the embedded audio passes through untouched.
import { inflate } from "../lib/inflate.js";
import { concat, toBytes, utf8, view } from "../lib/bytes.js";

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
  const v = view(buf);
  const u16 = (p) => v.getUint16(p, true);
  const u32 = (p) => v.getUint32(p, true);
  let end = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 22 - 0xffff); i--) {
    if (u32(i) === END) { end = i; break; }
  }
  if (end < 0) throw new Error("not a zip file (no end of central directory)");
  const count = u16(end + 10);
  let p = u32(end + 16);
  const entries = [];
  for (let i = 0; i < count; i++) {
    if (u32(p) !== CENTRAL) throw new Error("corrupt zip central directory");
    const method = u16(p + 10);
    const crc = u32(p + 16);
    const csize = u32(p + 20);
    const size = u32(p + 24);
    const nameLen = u16(p + 28);
    const extraLen = u16(p + 30);
    const commentLen = u16(p + 32);
    const local = u32(p + 42);
    const name = utf8(buf, p + 46, p + 46 + nameLen);
    if (u32(local) !== LOCAL) throw new Error(`corrupt zip entry ${name}`);
    const dataStart = local + 30 + u16(local + 26) + u16(local + 28);
    entries.push({ name, method, crc, size, raw: buf.subarray(dataStart, dataStart + csize) });
    p += 46 + nameLen + extraLen + commentLen;
  }
  return entries;
}

export function entryData(entry) {
  if (entry.method === 0) return entry.raw;
  if (entry.method === 8) return inflate(entry.raw, { zlib: false, sizeHint: entry.size });
  throw new Error(`unsupported zip compression method ${entry.method} (${entry.name})`);
}

// Raw deflate via the platform's CompressionStream (browsers and Node). The zlib format minus its 2-byte
// header and Adler-32 trailer is raw deflate; "deflate-raw" came later to CompressionStream.
async function deflateRaw(data) {
  const stream = new Blob([data]).stream().pipeThrough(new CompressionStream("deflate"));
  const z = new Uint8Array(await new Response(stream).arrayBuffer());
  return z.subarray(2, z.length - 4);
}

export async function makeEntry(name, data) {
  data = toBytes(data);
  return { name, method: 8, crc: crc32(data), size: data.length, raw: await deflateRaw(data) };
}

export function writeZip(entries) {
  const locals = [];
  const centrals = [];
  let offset = 0;
  for (const e of entries) {
    const name = toBytes(e.name);
    const h = new Uint8Array(30);
    const hv = view(h);
    hv.setUint32(0, LOCAL, true);
    hv.setUint16(4, 20, true); // version needed
    hv.setUint16(6, 0x0800, true); // UTF-8 names
    hv.setUint16(8, e.method, true);
    hv.setUint32(10, 0, true); // time/date
    hv.setUint32(14, e.crc, true);
    hv.setUint32(18, e.raw.length, true);
    hv.setUint32(22, e.size, true);
    hv.setUint16(26, name.length, true);
    hv.setUint16(28, 0, true);
    const c = new Uint8Array(46);
    const cv = view(c);
    cv.setUint32(0, CENTRAL, true);
    cv.setUint16(4, 20, true); // version made by
    cv.setUint16(6, 20, true);
    cv.setUint16(8, 0x0800, true);
    cv.setUint16(10, e.method, true);
    cv.setUint32(12, 0, true);
    cv.setUint32(16, e.crc, true);
    cv.setUint32(20, e.raw.length, true);
    cv.setUint32(24, e.size, true);
    cv.setUint16(28, name.length, true);
    cv.setUint32(42, offset, true);
    locals.push(h, name, e.raw);
    centrals.push(c, name);
    offset += 30 + name.length + e.raw.length;
  }
  const cdSize = centrals.reduce((s, b) => s + b.length, 0);
  const end = new Uint8Array(22);
  const ev = view(end);
  ev.setUint32(0, END, true);
  ev.setUint16(8, entries.length, true);
  ev.setUint16(10, entries.length, true);
  ev.setUint32(12, cdSize, true);
  ev.setUint32(16, offset, true);
  return concat([...locals, ...centrals, end]);
}

// Replace one file inside a zip: fn(oldData: Uint8Array) -> new data (Uint8Array or string).
export async function rewriteZipEntry(zipBuf, name, fn) {
  const entries = readZip(zipBuf);
  const i = entries.findIndex((e) => e.name === name);
  if (i < 0) throw new Error(`${name} not found in zip`);
  entries[i] = await makeEntry(name, fn(entryData(entries[i])));
  return writeZip(entries);
}
