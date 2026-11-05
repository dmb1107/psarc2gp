// Audio format and duration from the bytes alone, no decoder (Node and the conversion worker have no
// decodeAudioData). MP3: the Xing/Info or VBRI header's frame count (plus LAME's encoder delay and
// padding), else the frames counted one by one. M4A: the movie header's duration, or the fragment
// index's for fragmented (DASH) files.
import { view } from "../../lib/bytes.js";

const ascii = (b, at, n) => String.fromCharCode(...b.subarray(at, at + n));

// "mp3" | "m4a" | "webm" | "ogg" | "wav" | "flac" | null
export function detectFormat(b) {
  if (b.length < 12) return null;
  if (ascii(b, 4, 4) === "ftyp") return "m4a";
  if (ascii(b, 0, 3) === "ID3") return "mp3";
  if (b[0] === 0x1a && b[1] === 0x45 && b[2] === 0xdf && b[3] === 0xa3) return "webm";
  if (ascii(b, 0, 4) === "OggS") return "ogg";
  if (ascii(b, 0, 4) === "RIFF" && ascii(b, 8, 4) === "WAVE") return "wav";
  if (ascii(b, 0, 4) === "fLaC") return "flac";
  if (mp3Header(b, 0) && mp3Header(b, mp3Header(b, 0).length)) return "mp3";
  return null;
}

// ---- MP3

const BITRATES = { // kbit/s by [version 1 / 2+][layer 1..3][index]
  1: [null, [0, 32, 64, 96, 128, 160, 192, 224, 256, 288, 320, 352, 384, 416, 448],
    [0, 32, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320, 384],
    [0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320]],
  2: [null, [0, 32, 48, 56, 64, 80, 96, 112, 128, 144, 160, 176, 192, 224, 256],
    [0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160],
    [0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160]],
};
const RATES = { 3: [44100, 48000, 32000], 2: [22050, 24000, 16000], 0: [11025, 12000, 8000] }; // by version bits

// Frame header at `at`, or null: { sampleRate, samples, length, sideInfo, mono }
export function mp3Header(b, at) {
  if (at + 4 > b.length || b[at] !== 0xff || (b[at + 1] & 0xe0) !== 0xe0) return null;
  const ver = (b[at + 1] >> 3) & 3; // 3 = MPEG-1, 2 = MPEG-2, 0 = MPEG-2.5
  const layerBits = (b[at + 1] >> 1) & 3; // 1 = layer III, 2 = II, 3 = I
  const bri = b[at + 2] >> 4;
  const sri = (b[at + 2] >> 2) & 3;
  if (ver === 1 || layerBits === 0 || bri === 0 || bri === 15 || sri === 3) return null;
  const layer = 4 - layerBits;
  const v1 = ver === 3;
  const bitrate = BITRATES[v1 ? 1 : 2][layer][bri] * 1000;
  const sampleRate = RATES[ver][sri];
  const pad = (b[at + 2] >> 1) & 1;
  const mono = b[at + 3] >> 6 === 3;
  const samples = layer === 1 ? 384 : layer === 2 || v1 ? 1152 : 576;
  const length = layer === 1 ? (Math.floor((12 * bitrate) / sampleRate) + pad) * 4 : Math.floor(((samples / 8) * bitrate) / sampleRate) + pad;
  const sideInfo = layer !== 3 ? 0 : v1 ? (mono ? 17 : 32) : mono ? 9 : 17;
  return { sampleRate, samples, length, sideInfo, mono };
}

function skipId3(b) {
  if (ascii(b, 0, 3) !== "ID3" || b.length < 10) return 0;
  const size = ((b[6] & 0x7f) << 21) | ((b[7] & 0x7f) << 14) | ((b[8] & 0x7f) << 7) | (b[9] & 0x7f);
  return 10 + size + (b[5] & 0x10 ? 10 : 0);
}

// first frame header at or after `from` that is followed by another one (avoids false syncs in tags)
function firstFrame(b, from) {
  for (let i = from; i + 4 <= b.length; i++) {
    const h = mp3Header(b, i);
    if (h && (i + h.length + 4 > b.length || mp3Header(b, i + h.length))) return i;
  }
  return -1;
}

export function mp3Info(b) {
  const start = firstFrame(b, skipId3(b));
  if (start < 0) throw new Error("no MP3 frames found");
  const h = mp3Header(b, start);
  const dv = view(b);
  const x = start + 4 + h.sideInfo;
  const tag = ascii(b, x, 4);
  if (tag === "Xing" || tag === "Info") {
    const flags = dv.getUint32(x + 4);
    let p = x + 8;
    let frames = null;
    if (flags & 1) { frames = dv.getUint32(p); p += 4; }
    if (flags & 2) p += 4;
    if (flags & 4) p += 100;
    if (flags & 8) p += 4;
    if (frames !== null) {
      let delay = 0, padding = 0, encoder = null;
      if (p + 24 <= b.length && /^(LAME|Lavf|Lavc|L3.99)/.test(ascii(b, p, 4))) {
        encoder = ascii(b, p, 9).replace(/\0.*$/, "").trim();
        const d = p + 21;
        delay = (b[d] << 4) | (b[d + 1] >> 4);
        padding = ((b[d + 1] & 0x0f) << 8) | b[d + 2];
      }
      const samples = frames * h.samples - delay - padding;
      return { format: "mp3", sampleRate: h.sampleRate, seconds: samples / h.sampleRate, frames, encoderDelay: delay, encoderPadding: padding, encoder, header: tag };
    }
  }
  const vbri = start + 4 + 32;
  if (ascii(b, vbri, 4) === "VBRI") {
    const frames = dv.getUint32(vbri + 14);
    return { format: "mp3", sampleRate: h.sampleRate, seconds: (frames * h.samples) / h.sampleRate, frames, encoderDelay: dv.getUint16(vbri + 6), encoderPadding: 0, encoder: null, header: "VBRI" };
  }
  // no frame-count header: walk the frames
  let frames = 0;
  let samples = 0;
  let i = start;
  while (i + 4 <= b.length) {
    const f = mp3Header(b, i);
    if (!f) break;
    frames++;
    samples += f.samples;
    i += f.length;
  }
  return { format: "mp3", sampleRate: h.sampleRate, seconds: samples / h.sampleRate, frames, encoderDelay: null, encoderPadding: null, encoder: null, header: null };
}

// ---- M4A (ISO base media)

function* boxes(b, start, end) {
  const dv = view(b);
  let p = start;
  while (p + 8 <= end) {
    let size = dv.getUint32(p);
    const type = ascii(b, p + 4, 4);
    let head = 8;
    if (size === 1) { size = Number(dv.getBigUint64(p + 8)); head = 16; } else if (size === 0) size = end - p;
    if (size < head || p + size > end) return;
    yield { type, start: p, body: p + head, end: p + size };
    p += size;
  }
}
const find = (b, start, end, type) => { for (const x of boxes(b, start, end)) if (x.type === type) return x; return null; };

export function m4aInfo(b) {
  const dv = view(b);
  const moov = find(b, 0, b.length, "moov");
  let timescale = null, seconds = null;
  if (moov) {
    // the audio track's media header is exact; the movie header is the fallback
    for (const trak of boxes(b, moov.body, moov.end)) {
      if (trak.type !== "trak") continue;
      const mdia = find(b, trak.body, trak.end, "mdia");
      const hdlr = mdia && find(b, mdia.body, mdia.end, "hdlr");
      if (!hdlr || ascii(b, hdlr.body + 8, 4) !== "soun") continue;
      const mdhd = find(b, mdia.body, mdia.end, "mdhd");
      if (mdhd) {
        const v = b[mdhd.body];
        timescale = dv.getUint32(mdhd.body + (v === 1 ? 20 : 12));
        const d = v === 1 ? Number(dv.getBigUint64(mdhd.body + 24)) : dv.getUint32(mdhd.body + 16);
        if (d > 0 && d !== 0xffffffff && timescale) seconds = d / timescale;
      }
      break;
    }
    if (seconds === null) {
      const mvhd = find(b, moov.body, moov.end, "mvhd");
      if (mvhd) {
        const v = b[mvhd.body];
        const ts = dv.getUint32(mvhd.body + (v === 1 ? 20 : 12));
        const d = v === 1 ? Number(dv.getBigUint64(mvhd.body + 24)) : dv.getUint32(mvhd.body + 16);
        if (d > 0 && d !== 0xffffffff && ts) seconds = d / ts;
        timescale ??= ts;
      }
      const mvex = find(b, moov.body, moov.end, "mvex");
      const mehd = mvex && find(b, mvex.body, mvex.end, "mehd");
      if (seconds === null && mehd) {
        const v = b[mehd.body];
        const d = v === 1 ? Number(dv.getBigUint64(mehd.body + 4)) : dv.getUint32(mehd.body + 4);
        if (d > 0 && timescale) seconds = d / timescale;
      }
    }
  }
  if (seconds === null) {
    // fragmented file without a total: add up the segment index
    let total = 0, ts = null;
    for (const x of boxes(b, 0, b.length)) {
      if (x.type !== "sidx") continue;
      const v = b[x.body];
      ts = dv.getUint32(x.body + 8);
      let p = x.body + (v === 0 ? 20 : 28);
      const count = dv.getUint16(p + 2);
      p += 4;
      for (let i = 0; i < count; i++, p += 12) total += dv.getUint32(p + 4);
    }
    if (ts) seconds = total / ts;
  }
  if (seconds === null) throw new Error("M4A file without a duration");
  return { format: "m4a", seconds, timescale };
}

// { format, seconds, … } for the formats Guitar Pro 8 plays; throws for the rest
export function audioInfo(b) {
  const format = detectFormat(b);
  if (format === "mp3") return mp3Info(b);
  if (format === "m4a") return m4aInfo(b);
  throw new Error(format ? `${format} audio isn't supported: Guitar Pro 8 plays MP3 and M4A (AAC)` : "not an audio file psarc2gp recognizes (MP3 or M4A expected)");
}
