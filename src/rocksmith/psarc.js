// Rocksmith 2014 PSARC archive reader (PC and Mac).
//
// Layout: 32-byte big-endian header, then a table of contents (AES-256-CFB encrypted in Rocksmith
// archives), then zlib-compressed 64 KiB blocks. Entry 0 is the newline-separated file listing.
import { aesCfbDecrypt } from "../lib/aes.js";
import { inflate } from "../lib/inflate.js";
import { concat, fromHex, latin1, utf8, view } from "../lib/bytes.js";

// Public Rocksmith 2014 key used by every CDLC toolkit to read the archive table of contents.
const PSARC_KEY = fromHex("C53DB23870A1A2F71CAE64061FDD0E1157309DC85204D4C5BFDF25090DF2572C");
const ENCRYPTED_TOC = 4;

export class PsarcError extends Error {}

export function readPsarc(buf) {
  if (buf.length < 32 || latin1(buf, 0, 4) !== "PSAR") {
    throw new PsarcError("not a PSARC file");
  }
  const header = view(buf);
  const compression = latin1(buf, 8, 12);
  if (compression !== "zlib") throw new PsarcError(`unsupported compression ${compression}`);
  const tocLength = header.getUint32(12);
  const entrySize = header.getUint32(16);
  const entryCount = header.getUint32(20);
  const blockSize = header.getUint32(24);
  const flags = header.getUint32(28);

  let toc = buf.subarray(32, tocLength);
  if (flags === ENCRYPTED_TOC) toc = aesCfbDecrypt(PSARC_KEY, new Uint8Array(16), toc);
  const t = view(toc);
  // big-endian unsigned integer of 2 to 5 bytes
  const uintBE = (p, width) => { let v = 0; for (let i = 0; i < width; i++) v = v * 256 + toc[p + i]; return v; };

  const entries = [];
  for (let i = 0; i < entryCount; i++) {
    const e = i * entrySize;
    entries.push({
      blockIndex: t.getUint32(e + 16),
      length: uintBE(e + 20, 5),
      offset: uintBE(e + 25, 5),
    });
  }
  // Block-size table: one big-endian integer per block, width depends on the block size.
  const sizeWidth = blockSize <= 0x10000 ? 2 : blockSize <= 0x1000000 ? 3 : 4;
  const zSizes = [];
  for (let p = entryCount * entrySize; p + sizeWidth <= toc.length; p += sizeWidth) zSizes.push(uintBE(p, sizeWidth));

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
          chunk = raw[0] === 0x78 ? inflate(raw, { sizeHint: Math.min(blockSize, entry.length - have) }) : raw;
        } catch {
          chunk = raw;
        }
      }
      parts.push(chunk);
      have += chunk.length;
    }
    return concat(parts).subarray(0, entry.length);
  };

  const names = utf8(extract(entries[0])).split("\n").filter((n) => n.length);
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
