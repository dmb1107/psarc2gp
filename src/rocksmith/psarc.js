// Rocksmith 2014 PSARC archive reader (PC and Mac).
//
// Layout: 32-byte big-endian header, then a table of contents (AES-256-CFB encrypted in Rocksmith
// archives), then zlib-compressed 64 KiB blocks. Entry 0 is the newline-separated file listing.
import crypto from "node:crypto";
import zlib from "node:zlib";

// Public Rocksmith 2014 key used by every CDLC toolkit to read the archive table of contents.
const PSARC_KEY = Buffer.from("C53DB23870A1A2F71CAE64061FDD0E1157309DC85204D4C5BFDF25090DF2572C", "hex");
const ENCRYPTED_TOC = 4;

export class PsarcError extends Error {}

export function readPsarc(buf) {
  if (buf.length < 32 || buf.toString("latin1", 0, 4) !== "PSAR") {
    throw new PsarcError("not a PSARC file");
  }
  const compression = buf.toString("latin1", 8, 12);
  if (compression !== "zlib") throw new PsarcError(`unsupported compression ${compression}`);
  const tocLength = buf.readUInt32BE(12);
  const entrySize = buf.readUInt32BE(16);
  const entryCount = buf.readUInt32BE(20);
  const blockSize = buf.readUInt32BE(24);
  const flags = buf.readUInt32BE(28);

  let toc = buf.subarray(32, tocLength);
  if (flags === ENCRYPTED_TOC) {
    const padded = Buffer.alloc(Math.ceil(toc.length / 16) * 16);
    toc.copy(padded);
    const d = crypto.createDecipheriv("aes-256-cfb", PSARC_KEY, Buffer.alloc(16));
    toc = Buffer.concat([d.update(padded), d.final()]).subarray(0, toc.length);
  }

  const entries = [];
  for (let i = 0; i < entryCount; i++) {
    const e = toc.subarray(i * entrySize, (i + 1) * entrySize);
    entries.push({
      blockIndex: e.readUInt32BE(16),
      length: e.readUIntBE(20, 5),
      offset: e.readUIntBE(25, 5),
    });
  }
  // Block-size table: one big-endian integer per block, width depends on the block size.
  const sizeWidth = blockSize <= 0x10000 ? 2 : blockSize <= 0x1000000 ? 3 : 4;
  const sizeTable = toc.subarray(entryCount * entrySize);
  const zSizes = [];
  for (let p = 0; p + sizeWidth <= sizeTable.length; p += sizeWidth) zSizes.push(sizeTable.readUIntBE(p, sizeWidth));

  const extract = (entry) => {
    const parts = [];
    let have = 0;
    let offset = entry.offset;
    let block = entry.blockIndex;
    while (have < entry.length) {
      const zSize = zSizes[block++];
      let chunk;
      if (zSize === 0) {
        chunk = buf.subarray(offset, offset + blockSize);
        offset += blockSize;
      } else {
        const raw = buf.subarray(offset, offset + zSize);
        offset += zSize;
        // Blocks that did not compress well are stored raw; zlib streams start with 0x78.
        try {
          chunk = raw[0] === 0x78 ? zlib.inflateSync(raw) : raw;
        } catch {
          chunk = raw;
        }
      }
      parts.push(chunk);
      have += chunk.length;
    }
    return Buffer.concat(parts).subarray(0, entry.length);
  };

  const names = extract(entries[0]).toString("utf8").split("\n").filter((n) => n.length);
  const files = new Map();
  names.forEach((name, i) => files.set(name.replace(/^\/+/, ""), entries[i + 1]));

  return {
    names: [...files.keys()],
    has: (name) => files.has(name),
    read: (name) => {
      const entry = files.get(name);
      if (!entry) throw new PsarcError(`missing file in archive: ${name}`);
      return extract(entry);
    },
  };
}
