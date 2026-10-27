// Minimal Ogg page writer for a single logical Vorbis stream.
import { concat, view } from "../lib/bytes.js";

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let r = i << 24;
    for (let k = 0; k < 8; k++) r = r & 0x80000000 ? (r << 1) ^ 0x04c11db7 : r << 1;
    t[i] = r >>> 0;
  }
  return t;
})();

export function oggCrc(bytes) {
  let crc = 0;
  for (let i = 0; i < bytes.length; i++) crc = ((crc << 8) ^ CRC_TABLE[((crc >>> 24) ^ bytes[i]) & 0xff]) >>> 0;
  return crc >>> 0;
}

const TARGET_PAGE_BYTES = 4096;
const MAX_SEGMENTS = 255;

export class OggWriter {
  constructor(serial = 0x70736172) {
    this.serial = serial;
    this.seq = 0;
    this.pages = [];
    this.segments = []; // lacing values of the open page
    this.chunks = []; // payload pieces of the open page
    this.payloadBytes = 0;
    this.pageGranule = -1n; // granule of the last packet that completed on the open page
    this.startsContinued = false; // open page begins with the tail of a packet
  }

  // Add one packet. `granule` is the absolute sample position once this packet is decoded.
  addPacket(bytes, granule, { flush = false, last = false } = {}) {
    const len = bytes.length;
    // Lacing: floor(len/255) segments of 255, then one final segment (< 255, possibly 0).
    const segmentCount = Math.floor(len / 255) + 1;
    if (this.segments.length && this.segments.length + segmentCount > MAX_SEGMENTS) this._flushPage();
    let pos = 0;
    let left = segmentCount;
    for (;;) {
      const take = Math.min(MAX_SEGMENTS - this.segments.length, left);
      for (let i = 0; i < take; i++) {
        const segLen = Math.min(255, len - pos);
        this.segments.push(segLen);
        this.chunks.push(bytes.subarray(pos, pos + segLen));
        this.payloadBytes += segLen;
        pos += segLen;
      }
      left -= take;
      if (!left) break;
      this._flushPage({ continuedNext: true }); // packet spans pages
    }
    this.pageGranule = BigInt(granule);
    if (flush || last || this.payloadBytes >= TARGET_PAGE_BYTES) this._flushPage({ last });
  }

  _flushPage({ continuedNext = false, last = false } = {}) {
    if (!this.segments.length) return;
    const header = new Uint8Array(27 + this.segments.length);
    const h = view(header);
    header.set([0x4f, 0x67, 0x67, 0x53]); // "OggS"
    header[5] = (this.startsContinued ? 1 : 0) | (this.seq === 0 ? 2 : 0) | (last ? 4 : 0);
    h.setBigInt64(6, this.pageGranule, true);
    h.setUint32(14, this.serial, true);
    h.setUint32(18, this.seq++, true);
    header[26] = this.segments.length;
    this.segments.forEach((s, i) => { header[27 + i] = s; });
    const page = concat([header, ...this.chunks]);
    view(page).setUint32(22, oggCrc(page), true);
    this.pages.push(page);
    this.segments = [];
    this.chunks = [];
    this.payloadBytes = 0;
    this.pageGranule = -1n;
    this.startsContinued = continuedNext;
  }

  finish() {
    this._flushPage({ last: true });
    return concat(this.pages);
  }
}
