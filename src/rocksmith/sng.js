// Rocksmith 2014 SNG arrangement reader.
//
// An .sng file is: u32 magic (0x4A), u32 platform flags, 16-byte IV, AES-256-CTR payload, 56-byte
// signature. The decrypted payload is u32 uncompressed length + zlib stream. The decompressed data is
// a sequence of little-endian, tightly packed, count-prefixed sections.
import crypto from "node:crypto";
import zlib from "node:zlib";

const SNG_KEY_PC = Buffer.from("CB648DF3D12A16BF71701414E69619EC171CCA5D2A142E3E59DE7ADDA18A3A30", "hex");
const SNG_KEY_MAC = Buffer.from("9821330E34B91F70D0A48CBD625993126970CEA09192C0E6CDA676CC9838289F", "hex");

export function decryptSng(buf, { mac = false } = {}) {
  const magic = buf.readUInt32LE(0);
  if (magic !== 0x4a) throw new Error(`bad SNG magic 0x${magic.toString(16)}`);
  const iv = buf.subarray(8, 24);
  const d = crypto.createDecipheriv("aes-256-ctr", mac ? SNG_KEY_MAC : SNG_KEY_PC, iv);
  const plain = Buffer.concat([d.update(buf.subarray(24)), d.final()]);
  const length = plain.readUInt32LE(0);
  // finishFlush lets zlib stop at the end of the stream and ignore the trailing signature bytes.
  const raw = zlib.inflateSync(plain.subarray(4), { finishFlush: zlib.constants.Z_SYNC_FLUSH });
  if (raw.length !== length) throw new Error(`SNG length mismatch: header ${length}, got ${raw.length}`);
  return raw;
}

class Reader {
  constructor(buf) {
    this.b = buf;
    this.p = 0;
  }
  i8() { const v = this.b.readInt8(this.p); this.p += 1; return v; }
  u8() { const v = this.b.readUInt8(this.p); this.p += 1; return v; }
  i16() { const v = this.b.readInt16LE(this.p); this.p += 2; return v; }
  i32() { const v = this.b.readInt32LE(this.p); this.p += 4; return v; }
  u32() { const v = this.b.readUInt32LE(this.p); this.p += 4; return v; }
  f32() { const v = this.b.readFloatLE(this.p); this.p += 4; return v; }
  f64() { const v = this.b.readDoubleLE(this.p); this.p += 8; return v; }
  skip(n) { this.p += n; }
  str(n) {
    const s = this.b.subarray(this.p, this.p + n);
    this.p += n;
    const end = s.indexOf(0);
    return s.toString("utf8", 0, end < 0 ? n : end);
  }
  times(n, fn) { const out = new Array(n); for (let i = 0; i < n; i++) out[i] = fn(); return out; }
  list(fn) { return this.times(this.i32(), fn); }
}

const bendPoint = (r) => {
  const p = { time: r.f32(), step: r.f32() };
  r.skip(4); // unknown short + 2 unknown bytes
  return p;
};

function readNote(r) {
  const n = {
    mask: r.u32(), flags: r.u32(), hash: r.u32(), time: r.f32(),
    string: r.i8(), fret: r.i8(), anchorFret: r.i8(), anchorWidth: r.i8(),
    chordId: r.i32(), chordNotesId: r.i32(), phraseId: r.i32(), phraseIterationId: r.i32(),
  };
  r.skip(4); // fingerprint ids
  n.nextIterNote = r.i16(); n.prevIterNote = r.i16(); n.parentPrevNote = r.i16();
  n.slideTo = r.i8(); n.slideUnpitchTo = r.i8(); n.leftHand = r.i8(); n.tap = r.i8();
  n.pickDirection = r.i8(); n.slap = r.i8(); n.pluck = r.i8();
  n.vibrato = r.i16(); n.sustain = r.f32(); n.maxBend = r.f32();
  n.bends = r.list(() => bendPoint(r));
  return n;
}

export function parseSng(raw) {
  const r = new Reader(raw);
  const s = {};
  s.beats = r.list(() => ({ time: r.f32(), measure: r.i16(), beat: r.i16(), phraseIteration: r.i32(), mask: r.i32() }));
  s.phrases = r.list(() => {
    const ph = { solo: r.u8(), disparity: r.u8(), ignore: r.u8() };
    r.skip(1);
    ph.maxDifficulty = r.i32(); ph.links = r.i32(); ph.name = r.str(32);
    return ph;
  });
  s.chords = r.list(() => ({
    mask: r.u32(), frets: r.times(6, () => r.i8()), fingers: r.times(6, () => r.i8()),
    notes: r.times(6, () => r.i32()), name: r.str(32),
  }));
  s.chordNotes = r.list(() => {
    const masks = r.times(6, () => r.u32());
    const bends = r.times(6, () => {
      const pts = r.times(32, () => bendPoint(r));
      const used = r.i32();
      return pts.slice(0, used);
    });
    return { masks, bends, slideTo: r.times(6, () => r.i8()), slideUnpitchTo: r.times(6, () => r.i8()), vibrato: r.times(6, () => r.i16()) };
  });
  s.vocals = r.list(() => ({ time: r.f32(), note: r.i32(), length: r.f32(), lyric: r.str(48) }));
  if (s.vocals.length) {
    r.list(() => r.skip(32)); // symbol headers
    r.list(() => r.skip(144)); // symbol textures
    r.list(() => r.skip(44)); // symbol definitions
  }
  s.phraseIterations = r.list(() => ({ phraseId: r.i32(), start: r.f32(), next: r.f32(), difficulty: r.times(3, () => r.i32()) }));
  r.list(() => r.skip(16)); // phrase extra info by level
  r.list(() => { r.skip(4); r.skip(4 * r.i32()); }); // linked difficulties
  r.list(() => r.skip(260)); // actions
  s.events = r.list(() => ({ time: r.f32(), name: r.str(256) }));
  s.tones = r.list(() => ({ time: r.f32(), id: r.i32() }));
  r.list(() => r.skip(8)); // dna
  s.sections = r.list(() => {
    const sec = { name: r.str(32), number: r.i32(), start: r.f32(), end: r.f32(), startPI: r.i32(), endPI: r.i32() };
    r.skip(36);
    return sec;
  });
  s.levels = r.list(() => {
    const difficulty = r.i32();
    r.list(() => r.skip(28)); // anchors
    r.list(() => r.skip(12)); // anchor extensions
    r.list(() => r.skip(20)); // fingerprints (chord handshapes)
    r.list(() => r.skip(20)); // fingerprints (arpeggios)
    const notes = r.list(() => readNote(r));
    r.skip(4 * r.i32()); // average notes per iteration
    r.skip(4 * r.i32()); // notes in iteration (1)
    r.skip(4 * r.i32()); // notes in iteration (2)
    return { difficulty, notes };
  });
  const m = {};
  m.maxScore = r.f64(); m.maxNotesAndChords = r.f64(); m.maxNotesAndChordsReal = r.f64(); m.pointsPerNote = r.f64();
  m.firstBeatLength = r.f32(); m.startTime = r.f32(); m.capo = r.i8(); m.lastConversion = r.str(32);
  m.part = r.i16(); m.songLength = r.f32();
  m.tuning = r.times(r.i32(), () => r.i16());
  m.firstNoteTime = r.f32(); r.f32(); m.maxDifficulty = r.i32();
  s.meta = m;
  if (r.p !== raw.length) throw new Error(`SNG parse ended at ${r.p} of ${raw.length} bytes`);
  return s;
}

// Rocksmith stores each phrase at many difficulty levels. The full chart is every phrase iteration
// taken at its phrase's maximum difficulty.
export function maxDifficultyNotes(sng) {
  const out = [];
  for (const pi of sng.phraseIterations) {
    const maxD = sng.phrases[pi.phraseId].maxDifficulty;
    const level = sng.levels.find((l) => l.difficulty === maxD) ?? sng.levels[sng.levels.length - 1];
    for (const n of level.notes) if (n.time >= pi.start && n.time < pi.next) out.push(n);
  }
  return out.sort((a, b) => a.time - b.time);
}

export const NoteMask = Object.freeze({
  CHORD: 0x02, OPEN: 0x04, FRET_HAND_MUTE: 0x08, TREMOLO: 0x10, HARMONIC: 0x20, PALM_MUTE: 0x40,
  SLAP: 0x80, PLUCK: 0x100, HAMMER_ON: 0x200, PULL_OFF: 0x400, SLIDE: 0x800, BEND: 0x1000,
  SUSTAIN: 0x2000, TAP: 0x4000, PINCH_HARMONIC: 0x8000, VIBRATO: 0x10000, MUTE: 0x20000,
  IGNORE: 0x40000, LEFT_HAND: 0x80000, RIGHT_HAND: 0x100000, HIGH_DENSITY: 0x200000,
  SLIDE_UNPITCHED: 0x400000, SINGLE: 0x800000, CHORD_NOTES: 0x1000000, DOUBLE_STOP: 0x2000000,
  ACCENT: 0x4000000, PARENT: 0x8000000, CHILD: 0x10000000, ARPEGGIO: 0x20000000, STRUM: 0x80000000,
});
