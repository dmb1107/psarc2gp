// Wwise RIFF/Vorbis (.wem) -> standard Ogg Vorbis.
//
// JavaScript port of the parts of ww2ogg (https://github.com/hcs64/ww2ogg, BSD license, see
// LICENSE-ww2ogg.txt) needed for Rocksmith 2014 audio: modern Wwise headers, external packed
// codebooks, stripped setup header, and "modified" audio packets.
//
// Unlike ww2ogg, this also writes correct granule positions (what the separate "revorb" tool is
// normally used for), so players can seek and report the right duration.
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import { OggWriter } from "./ogg.js";

const CODEBOOKS_PATH = fileURLToPath(new URL("./packed_codebooks_aoTuV_603.bin", import.meta.url));
let codebookLibrary = null;

export class WemError extends Error {}

// ---------------------------------------------------------------- bit I/O (LSB first, like Vorbis)
class BitReader {
  constructor(buf, offset = 0) {
    this.buf = buf;
    this.pos = offset * 8;
    this.start = this.pos;
  }
  read(n) {
    let v = 0;
    for (let i = 0; i < n; i++) {
      const byte = this.buf[this.pos >>> 3];
      if (byte === undefined) throw new WemError("unexpected end of data");
      if ((byte >>> (this.pos & 7)) & 1) v += 2 ** i;
      this.pos++;
    }
    return v;
  }
  get bitsRead() { return this.pos - this.start; }
}

class BitWriter {
  constructor() {
    this.bytes = new Uint8Array(1024);
    this.bitLength = 0;
  }
  write(value, n) {
    for (let i = 0; i < n; i++) {
      const byteIndex = this.bitLength >>> 3;
      if (byteIndex >= this.bytes.length) {
        const grown = new Uint8Array(this.bytes.length * 2);
        grown.set(this.bytes);
        this.bytes = grown;
      }
      if (Math.floor(value / 2 ** i) % 2) this.bytes[byteIndex] |= 1 << (this.bitLength & 7);
      this.bitLength++;
    }
  }
  writeBytes(src) {
    const shift = this.bitLength & 7;
    let idx = this.bitLength >>> 3;
    const need = idx + src.length + 1;
    if (need > this.bytes.length) {
      const grown = new Uint8Array(Math.max(need, this.bytes.length * 2));
      grown.set(this.bytes);
      this.bytes = grown;
    }
    if (shift === 0) {
      this.bytes.set(src, idx);
    } else {
      for (let i = 0; i < src.length; i++, idx++) {
        this.bytes[idx] |= (src[i] << shift) & 0xff;
        this.bytes[idx + 1] = src[i] >>> (8 - shift);
      }
    }
    this.bitLength += src.length * 8;
  }
  finish() { return this.bytes.slice(0, (this.bitLength + 7) >>> 3); }
}

const ilog = (v) => { let r = 0; while (v) { r++; v >>>= 1; } return r; };

function maptype1Quantvals(entries, dimensions) {
  const bits = ilog(entries);
  let vals = entries >>> Math.floor(((bits - 1) * (dimensions - 1)) / dimensions);
  for (;;) {
    let acc = 1, acc1 = 1;
    for (let i = 0; i < dimensions; i++) { acc *= vals; acc1 *= vals + 1; }
    if (acc <= entries && acc1 > entries) return vals;
    if (acc > entries) vals--; else vals++;
  }
}

// ------------------------------------------------------------------------- packed codebook library
function loadCodebooks() {
  if (codebookLibrary) return codebookLibrary;
  const data = fs.readFileSync(CODEBOOKS_PATH);
  const offsetOffset = data.readUInt32LE(data.length - 4);
  const count = (data.length - offsetOffset) / 4;
  const offsets = [];
  for (let i = 0; i < count; i++) offsets.push(data.readUInt32LE(offsetOffset + i * 4));
  codebookLibrary = {
    get(i) {
      if (i < 0 || i >= count - 1) throw new WemError(`invalid codebook id ${i}`);
      return data.subarray(offsets[i], offsets[i + 1]);
    },
  };
  return codebookLibrary;
}

// Expand one codebook from Wwise's packed form into the standard Vorbis codebook bitstream.
function rebuildCodebook(cb, out) {
  const bis = new BitReader(cb);
  const dimensions = bis.read(4);
  const entries = bis.read(14);
  out.write(0x564342, 24); // "BCV"
  out.write(dimensions, 16);
  out.write(entries, 24);

  const ordered = bis.read(1);
  out.write(ordered, 1);
  if (ordered) {
    out.write(bis.read(5), 5); // initial length
    let current = 0;
    while (current < entries) {
      const bits = ilog(entries - current);
      const number = bis.read(bits);
      out.write(number, bits);
      current += number;
    }
    if (current > entries) throw new WemError("codebook entry count out of range");
  } else {
    const lengthBits = bis.read(3);
    const sparse = bis.read(1);
    if (lengthBits === 0 || lengthBits > 5) throw new WemError("nonsense codeword length");
    out.write(sparse, 1);
    for (let i = 0; i < entries; i++) {
      let present = 1;
      if (sparse) { present = bis.read(1); out.write(present, 1); }
      if (present) out.write(bis.read(lengthBits), 5);
    }
  }

  const lookupType = bis.read(1);
  out.write(lookupType, 4);
  if (lookupType === 1) {
    out.write(bis.read(32), 32); // min
    out.write(bis.read(32), 32); // max
    const valueLength = bis.read(4);
    out.write(valueLength, 4);
    out.write(bis.read(1), 1); // sequence flag
    const quantvals = maptype1Quantvals(entries, dimensions);
    for (let i = 0; i < quantvals; i++) out.write(bis.read(valueLength + 1), valueLength + 1);
  } else if (lookupType !== 0) {
    throw new WemError(`unexpected codebook lookup type ${lookupType}`);
  }
  // Every packed codebook must be consumed exactly (ww2ogg's check: one extra byte if the last is full).
  if (Math.floor(bis.bitsRead / 8) + 1 !== cb.length) throw new WemError("codebook size mismatch");
}

// --------------------------------------------------------------------------------- RIFF parsing
function parseRiff(buf) {
  const tag = buf.toString("latin1", 0, 4);
  if (tag !== "RIFF") throw new WemError(tag === "RIFX" ? "big-endian Wwise files are not supported" : "not a RIFF file");
  if (buf.toString("latin1", 8, 12) !== "WAVE") throw new WemError("missing WAVE");
  const riffSize = buf.readUInt32LE(4) + 8;
  const chunks = {};
  let p = 12;
  while (p + 8 <= Math.min(riffSize, buf.length)) {
    const id = buf.toString("latin1", p, p + 4);
    const size = buf.readUInt32LE(p + 4);
    chunks[id] = { offset: p + 8, size };
    p += 8 + size;
  }
  const fmt = chunks["fmt "];
  const data = chunks.data;
  if (!fmt || !data) throw new WemError("expected fmt and data chunks");
  if (buf.readUInt16LE(fmt.offset) !== 0xffff) throw new WemError("not Wwise Vorbis (codec id != 0xFFFF)");

  let vorbOffset, vorbSize;
  if (chunks.vorb) {
    vorbOffset = chunks.vorb.offset;
    vorbSize = chunks.vorb.size;
  } else if (fmt.size === 0x42) {
    vorbOffset = fmt.offset + 0x18; // vorb data lives inside the extended fmt chunk
    vorbSize = -1;
  } else {
    throw new WemError("expected 0x42-byte fmt chunk when vorb chunk is missing");
  }
  if (![-1, 0x2a, 0x32, 0x34].includes(vorbSize)) {
    throw new WemError(`unsupported Wwise Vorbis header layout (vorb size 0x${vorbSize.toString(16)})`);
  }

  const info = {
    channels: buf.readUInt16LE(fmt.offset + 2),
    sampleRate: buf.readUInt32LE(fmt.offset + 4),
    avgBytesPerSecond: buf.readUInt32LE(fmt.offset + 8),
    dataOffset: data.offset,
    dataSize: data.size,
    sampleCount: buf.readUInt32LE(vorbOffset),
  };
  const noGranule = vorbSize === -1 || vorbSize === 0x2a;
  info.packetHeaderSize = noGranule ? 2 : 6;
  if (noGranule) {
    const modSignal = buf.readUInt32LE(vorbOffset + 4);
    info.modPackets = ![0x4a, 0x4b, 0x69, 0x70].includes(modSignal);
    info.setupOffset = buf.readUInt32LE(vorbOffset + 0x10);
    info.firstAudioOffset = buf.readUInt32LE(vorbOffset + 0x14);
    info.blocksize0Pow = buf[vorbOffset + 0x28];
    info.blocksize1Pow = buf[vorbOffset + 0x29];
  } else {
    info.modPackets = false;
    info.setupOffset = buf.readUInt32LE(vorbOffset + 0x18);
    info.firstAudioOffset = buf.readUInt32LE(vorbOffset + 0x1c);
    info.blocksize0Pow = buf[vorbOffset + 0x30];
    info.blocksize1Pow = buf[vorbOffset + 0x31];
  }
  return info;
}

// ------------------------------------------------------------------------- Vorbis header packets
function vorbisHeader(type) {
  const w = new BitWriter();
  w.write(type, 8);
  for (const c of "vorbis") w.write(c.charCodeAt(0), 8);
  return w;
}

function identificationPacket(info) {
  const w = vorbisHeader(1);
  w.write(0, 32); // version
  w.write(info.channels, 8);
  w.write(info.sampleRate, 32);
  w.write(0, 32); // bitrate max
  w.write(info.avgBytesPerSecond * 8, 32);
  w.write(0, 32); // bitrate min
  w.write(info.blocksize0Pow, 4);
  w.write(info.blocksize1Pow, 4);
  w.write(1, 1); // framing
  return w.finish();
}

function commentPacket() {
  const w = vorbisHeader(3);
  const vendor = "converted from Audiokinetic Wwise by psarc2gp (ww2ogg port)";
  w.write(vendor.length, 32);
  for (const c of vendor) w.write(c.charCodeAt(0), 8);
  w.write(0, 32); // no user comments
  w.write(1, 1); // framing
  return w.finish();
}

// Rebuild the full Vorbis setup header from Wwise's stripped one. Returns the packet bytes and the
// per-mode block flags needed to rebuild audio packets and compute granule positions.
function setupPacket(buf, info) {
  const packetOffset = info.dataOffset + info.setupOffset;
  const size = buf.readUInt16LE(packetOffset);
  const ss = new BitReader(buf, packetOffset + info.packetHeaderSize);
  const os = vorbisHeader(5);
  const books = loadCodebooks();

  const codebookCount = ss.read(8) + 1;
  os.write(codebookCount - 1, 8);
  for (let i = 0; i < codebookCount; i++) rebuildCodebook(books.get(ss.read(10)), os);

  os.write(0, 6); // time domain transform count - 1
  os.write(0, 16); // dummy time value

  // floors
  const floorCount = ss.read(6) + 1;
  os.write(floorCount - 1, 6);
  for (let i = 0; i < floorCount; i++) {
    os.write(1, 16); // floor type 1
    const partitions = ss.read(5);
    os.write(partitions, 5);
    const partitionClass = [];
    let maxClass = 0;
    for (let j = 0; j < partitions; j++) {
      const c = ss.read(4);
      os.write(c, 4);
      partitionClass.push(c);
      maxClass = Math.max(maxClass, c);
    }
    const classDimensions = [];
    for (let j = 0; j <= maxClass; j++) {
      const dim = ss.read(3);
      os.write(dim, 3);
      classDimensions.push(dim + 1);
      const subclasses = ss.read(2);
      os.write(subclasses, 2);
      if (subclasses) {
        const masterbook = ss.read(8);
        os.write(masterbook, 8);
        if (masterbook >= codebookCount) throw new WemError("invalid floor1 masterbook");
      }
      for (let k = 0; k < 1 << subclasses; k++) {
        const bookPlus1 = ss.read(8);
        os.write(bookPlus1, 8);
        if (bookPlus1 - 1 >= codebookCount) throw new WemError("invalid floor1 subclass book");
      }
    }
    os.write(ss.read(2), 2); // multiplier - 1
    const rangeBits = ss.read(4);
    os.write(rangeBits, 4);
    for (let j = 0; j < partitions; j++) {
      for (let k = 0; k < classDimensions[partitionClass[j]]; k++) os.write(ss.read(rangeBits), rangeBits);
    }
  }

  // residues
  const residueCount = ss.read(6) + 1;
  os.write(residueCount - 1, 6);
  for (let i = 0; i < residueCount; i++) {
    const type = ss.read(2);
    os.write(type, 16);
    if (type > 2) throw new WemError("invalid residue type");
    os.write(ss.read(24), 24); // begin
    os.write(ss.read(24), 24); // end
    os.write(ss.read(24), 24); // partition size - 1
    const classifications = ss.read(6) + 1;
    os.write(classifications - 1, 6);
    const classbook = ss.read(8);
    os.write(classbook, 8);
    if (classbook >= codebookCount) throw new WemError("invalid residue classbook");
    const cascade = [];
    for (let j = 0; j < classifications; j++) {
      const low = ss.read(3);
      os.write(low, 3);
      const flag = ss.read(1);
      os.write(flag, 1);
      let high = 0;
      if (flag) { high = ss.read(5); os.write(high, 5); }
      cascade.push(high * 8 + low);
    }
    for (let j = 0; j < classifications; j++) {
      for (let k = 0; k < 8; k++) {
        if (cascade[j] & (1 << k)) {
          const book = ss.read(8);
          os.write(book, 8);
          if (book >= codebookCount) throw new WemError("invalid residue book");
        }
      }
    }
  }

  // mappings
  const mappingCount = ss.read(6) + 1;
  os.write(mappingCount - 1, 6);
  for (let i = 0; i < mappingCount; i++) {
    os.write(0, 16); // mapping type 0
    const submapsFlag = ss.read(1);
    os.write(submapsFlag, 1);
    let submaps = 1;
    if (submapsFlag) { const s = ss.read(4); os.write(s, 4); submaps = s + 1; }
    const squarePolar = ss.read(1);
    os.write(squarePolar, 1);
    if (squarePolar) {
      const steps = ss.read(8) + 1;
      os.write(steps - 1, 8);
      const bits = ilog(info.channels - 1);
      for (let j = 0; j < steps; j++) {
        const magnitude = ss.read(bits);
        const angle = ss.read(bits);
        os.write(magnitude, bits);
        os.write(angle, bits);
        if (angle === magnitude || magnitude >= info.channels || angle >= info.channels) throw new WemError("invalid coupling");
      }
    }
    const reserved = ss.read(2);
    os.write(reserved, 2);
    if (reserved) throw new WemError("mapping reserved field nonzero");
    if (submaps > 1) {
      for (let j = 0; j < info.channels; j++) {
        const mux = ss.read(4);
        os.write(mux, 4);
        if (mux >= submaps) throw new WemError("mapping mux >= submaps");
      }
    }
    for (let j = 0; j < submaps; j++) {
      os.write(ss.read(8), 8); // time config
      const floor = ss.read(8);
      os.write(floor, 8);
      if (floor >= floorCount) throw new WemError("invalid floor mapping");
      const residue = ss.read(8);
      os.write(residue, 8);
      if (residue >= residueCount) throw new WemError("invalid residue mapping");
    }
  }

  // modes
  const modeCount = ss.read(6) + 1;
  os.write(modeCount - 1, 6);
  const modeBlockflag = [];
  for (let i = 0; i < modeCount; i++) {
    const blockflag = ss.read(1);
    os.write(blockflag, 1);
    modeBlockflag.push(blockflag === 1);
    os.write(0, 16); // window type
    os.write(0, 16); // transform type
    const mapping = ss.read(8);
    os.write(mapping, 8);
    if (mapping >= mappingCount) throw new WemError("invalid mode mapping");
  }
  os.write(1, 1); // framing

  if (Math.floor((ss.bitsRead + 7) / 8) !== size) throw new WemError("setup packet size mismatch");
  if (packetOffset + info.packetHeaderSize + size !== info.dataOffset + info.firstAudioOffset) {
    throw new WemError("first audio packet does not follow setup packet");
  }
  return { bytes: os.finish(), modeBlockflag, modeBits: ilog(modeCount - 1) };
}

// ----------------------------------------------------------------------------------- conversion
export function wemToOgg(buf) {
  const info = parseRiff(buf);
  const ogg = new OggWriter();
  ogg.addPacket(identificationPacket(info), 0, { flush: true });
  ogg.addPacket(commentPacket(), 0);
  const setup = setupPacket(buf, info);
  ogg.addPacket(setup.bytes, 0, { flush: true });

  const { modeBlockflag, modeBits } = setup;
  const blocksize = [1 << info.blocksize0Pow, 1 << info.blocksize1Pow];
  const end = info.dataOffset + info.dataSize;
  const readSize = (off) => buf.readUInt16LE(off);
  const modeOf = (payloadOffset) => {
    // In modified packets the mode number is the first field (the packet-type bit was stripped).
    const r = new BitReader(buf, payloadOffset);
    if (!info.modPackets) r.read(1);
    return r.read(modeBits);
  };

  let offset = info.dataOffset + info.firstAudioOffset;
  let prevLong = false;
  let prevBlock = null;
  let granule = 0;
  while (offset < end) {
    if (offset + info.packetHeaderSize > end) throw new WemError("audio packet header truncated");
    const size = readSize(offset);
    const payload = offset + info.packetHeaderSize;
    const next = payload + size;
    if (next > end) throw new WemError("audio packet truncated");

    let packet;
    let mode;
    if (info.modPackets) {
      const w = new BitWriter();
      w.write(0, 1); // packet type: audio
      const r = new BitReader(buf, payload);
      mode = r.read(modeBits);
      w.write(mode, modeBits);
      const remainder = r.read(8 - modeBits);
      if (modeBlockflag[mode]) {
        // Long window: Vorbis needs the previous and next window types, which Wwise removed.
        let nextLong = false;
        if (next + info.packetHeaderSize <= end && readSize(next) > 0) {
          nextLong = modeBlockflag[modeOf(next + info.packetHeaderSize)];
        }
        w.write(prevLong ? 1 : 0, 1);
        w.write(nextLong ? 1 : 0, 1);
      }
      prevLong = modeBlockflag[mode];
      w.write(remainder, 8 - modeBits);
      w.writeBytes(buf.subarray(payload + 1, next));
      packet = w.finish();
    } else {
      packet = buf.subarray(payload, next);
      mode = modeOf(payload);
    }

    // Granule position = samples fully decoded after this packet.
    const block = blocksize[modeBlockflag[mode] ? 1 : 0];
    if (prevBlock !== null) granule += prevBlock / 4 + block / 4;
    prevBlock = block;

    const last = next >= end;
    ogg.addPacket(packet, last ? Math.min(granule, info.sampleCount) : granule, { last });
    offset = next;
  }
  return { ogg: ogg.finish(), sampleRate: info.sampleRate, channels: info.channels, sampleCount: info.sampleCount };
}
