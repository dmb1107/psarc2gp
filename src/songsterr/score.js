// Songsterr tab JSON -> alphaTex (notation + tab for each chosen track, bar structure, sections).
//
// Songsterr's data is already rhythmic notation (it comes from Guitar Pro-style editing): every beat has
// a note value (`type`), `dots`, an optional `tuplet`, and its exact length as a rational `duration`
// ([1, 8] = an eighth). Strings count from the highest (0); tuning is listed high to low as MIDI numbers.
// So this is a translation, not the timing analysis the .psarc path needs.
//
// Sync points are not written here: convert.js maps the video's points onto alphaTab's own played-bar
// order after loading this alphaTex (see sync.js).
import { trackKind } from "./bundle.js";

const q = (s) => `"${String(s ?? "").replace(/["\\]/g, "'").replace(/\s+/g, " ").trim()}"`;
const NOTE_NAMES = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"];
export const pitchName = (midi) => `${NOTE_NAMES[midi % 12]}${Math.floor(midi / 12) - 1}`;

// Bar fields that don't change which bars are played, and the ones handled (repeats, alternate endings).
// Anything else (D.S./D.C./coda directions, …) may change the played-bar order the sync points are counted
// in; until those fields are seen in real data and handled, a bar carrying one stops the conversion
// instead of syncing it wrong.
const BAR_FIELDS_LAYOUT = new Set(["voices", "keySignature", "rest", "marker", "signature", "tripletFeel", "width", "text", "clef"]);
// swing, set on the bar where it starts and kept until changed (seen: "8th", Autumn Leaves s463684);
// alphaTex's \tf carries forward the same way. Guitar Pro plays it; the written notes stay straight.
const TRIPLET_FEELS = { "8th": "triplet-8th", "16th": "triplet-16th", none: "none", off: "none" };
const BAR_FIELDS_HANDLED = new Set(["repeatStart", "repeat", "alternateEnding"]);
// Songsterr clef names (seen: "F4" on a piano's lower staff) → alphaTex
const CLEFS = { G2: "G2", F4: "F4", C3: "C3", C4: "C4", treble: "G2", bass: "F4", alto: "C3", tenor: "C4", neutral: "Neutral" };

const VALUES = new Set([1, 2, 4, 8, 16, 32, 64, 128]);
// major keys by accidental count, -7 (7 flats) .. +7 (7 sharps)
const KEYS = ["cb", "gb", "db", "ab", "eb", "bb", "f", "c", "g", "d", "a", "e", "b", "f#", "c#"];

// Guitar Pro RSE sound for a track (keys of src/gp/rse.js SOUNDS), from its General MIDI instrument
export function soundFor(meta) {
  const kind = trackKind(meta);
  if (kind === "bass") return "bass";
  if (kind === "drums") return "drums";
  if (kind === "vocals") return "voice";
  const p = meta.instrumentId;
  if (p === 30) return "distortion";
  if (p === 29) return "overdrive";
  if (p === 24 || p === 25) return "acoustic";
  return "clean";
}

// Bar-level structure shared by all tracks, from the first track (Songsterr keeps bars identical across
// tracks; differences are reported).
export function readStructure(tracks, { warn = () => {} } = {}) {
  const ref = tracks[0].data;
  const n = ref.measures.length;
  for (const t of tracks.slice(1)) {
    if (t.data.measures.length !== n) throw new Error(`${t.meta.name}: ${t.data.measures.length} bars, but ${tracks[0].meta.name} has ${n}`);
  }
  const unknown = new Map();
  let sig = [4, 4];
  let openRepeat = null;
  let afterRepeat = false;
  const bars = ref.measures.map((m, i) => {
    for (const k of Object.keys(m)) {
      if (!BAR_FIELDS_LAYOUT.has(k) && !BAR_FIELDS_HANDLED.has(k)) unknown.set(k, [...(unknown.get(k) ?? []), i + 1]);
    }
    if (Array.isArray(m.signature)) sig = m.signature;
    const bar = { index: i, num: sig[0], den: sig[1], tsChange: Array.isArray(m.signature) || i === 0 };
    if (m.marker?.text) bar.section = m.marker.text;
    if (m.tripletFeel !== undefined) {
      const tf = m.tripletFeel ? TRIPLET_FEELS[m.tripletFeel] : "none";
      if (tf) bar.tripletFeel = tf;
      else warn(`bar ${i + 1}: triplet feel ${JSON.stringify(m.tripletFeel)} isn't known; left out`);
    }
    if (m.keySignature && Number.isInteger(m.keySignature.accidentalCount)) bar.key = m.keySignature.accidentalCount;
    if (m.repeatStart) { bar.repeatStart = true; openRepeat = i; }
    // alternate endings: the numbers of the passes that play this bar; the repeat sign that sends the
    // player back sits on the last bar of the 1st ending, as in Guitar Pro (alphaTab plays that layout)
    if (m.alternateEnding !== undefined) {
      const e = m.alternateEnding;
      if (!Array.isArray(e) || !e.length || !e.every((x) => Number.isInteger(x) && x >= 1 && x <= 8)) throw new Error(`bar ${i + 1}: alternate ending ${JSON.stringify(e)} isn't a list of pass numbers`);
      bar.endings = [...e].sort((a, b) => a - b);
    }
    if (m.repeat) {
      bar.repeatCount = Math.max(2, m.repeat);
      // a repeat without a start goes back to bar 1, the usual reading for the song's first repeat
      if (openRepeat === null && afterRepeat) warn(`bar ${i + 1}: repeat end without a start; repeating from bar 1`);
      openRepeat = null;
      afterRepeat = true;
    }
    return bar;
  });
  for (const t of tracks.slice(1)) {
    t.data.measures.forEach((m, i) => {
      const a = bars[i];
      if (!!m.repeatStart !== !!a.repeatStart || (m.repeat ?? 0) !== (ref.measures[i].repeat ?? 0) ||
        JSON.stringify(m.alternateEnding ?? null) !== JSON.stringify(ref.measures[i].alternateEnding ?? null)) {
        throw new Error(`${t.meta.name}: bar ${i + 1}'s repeats differ from ${tracks[0].meta.name}'s`);
      }
    });
  }
  if (unknown.size) {
    const list = [...unknown].map(([k, at]) => `"${k}" (bar ${at.slice(0, 3).join(", ")}${at.length > 3 ? ", …" : ""})`).join(", ");
    throw new Error(`this tab uses bar fields psarc2gp doesn't know yet: ${list}. They may change which bars are played ` +
      "(D.S./D.C./coda directions), so the sync points can't be placed safely. Please save the bundle and report it.");
  }
  bars.anacrusis = !!ref.anacrusis;
  const tempo = (ref.automations?.tempo ?? []).filter((a) => isFinite(a.bpm) && a.measure >= 0 && a.measure < n);
  for (const a of tempo) {
    const b = bars[a.measure];
    // bpm is per `type` note value (4 = quarter); alphaTab tempos are quarter notes per minute
    const bpm = Math.round((a.bpm * 4) / (a.type || 4) * 100) / 100;
    // position: beat within the bar (not seen other than 0 yet)
    const ratio = a.position > 0 ? Math.min(0.99, a.position / b.num) : 0;
    (b.tempo ??= []).push({ bpm, ratio });
  }
  if (!bars[0].tempo) bars[0].tempo = [{ bpm: 120, ratio: 0 }];
  return bars;
}

// One beat's note value in alphaTex: "8", plus {d}/{dd} and {tu 3} as beat effects
function valueOf(beat, where) {
  const type = beat.type;
  if (!VALUES.has(type)) throw new Error(`${where}: note value 1/${type} isn't supported`);
  const eff = [];
  if (beat.dots === 1) eff.push("d");
  else if (beat.dots === 2) eff.push("dd");
  if (beat.tuplet && beat.tuplet > 1) eff.push(`tu ${beat.tuplet}`);
  return { dur: String(type), eff };
}

const quarterTones = (tone) => Math.round(tone / 25); // Songsterr/Guitar Pro: 100 = a whole tone
const pointsTex = (points) => {
  const pts = points.filter((p) => isFinite(p.position) && isFinite(p.tone));
  return pts.map((p) => `${Math.max(0, Math.min(60, Math.round(p.position)))} ${quarterTones(p.tone)}`).join(" ");
};

// "shift", "legato", "downwards"/"upwards" (slide out), "below"/"above" (slide in), and combinations
// such as "belowlegato" (slide in from below, legato slide to the next note)
const SLIDE_IN = { below: "sib", above: "sia" };
const SLIDE_OUT = { shift: "ss", legato: "sl", downwards: "sod", upwards: "sou" };
function slideEffects(slide, stats) {
  let s = String(slide);
  const eff = [];
  const inKey = Object.keys(SLIDE_IN).find((k) => s.startsWith(k));
  if (inKey) { eff.push(SLIDE_IN[inKey]); s = s.slice(inKey.length); }
  if (s && SLIDE_OUT[s]) eff.push(SLIDE_OUT[s]);
  else if (s) stats.unsupported.add(`slide "${slide}"`);
  return eff;
}

const HARMONICS = { natural: "nh", artificial: "ah", pinch: "ph", tap: "th", semi: "sh", feedback: "fh" };

// Drums: Songsterr stores a drum note's instrument in `fret` as a Guitar Pro percussion articulation id
// (mostly the General MIDI drum number; 91–98 are Guitar Pro's extra ones: 92 half-open hi-hat, 91 snare
// rim shot, 97/98 crash choke), with `string` the staff position. The ids alphaTab 1.8.4 knows
// (PercussionMapper.instrumentArticulations, not exported; test/songsterr.test.js checks this list
// against alphaTab). alphaTex names notes, not numbers, so each id used gets `\articulation (pN N)`.
export const DRUM_ARTICULATIONS = new Set([
  29, 30, 31, 33, 34, 35, 36, 37, 38, 39, 40, 41, 42, 43, 44, 45, 46, 47, 48, 49, 50, 51, 52, 53, 54, 55,
  56, 57, 58, 59, 60, 61, 62, 63, 64, 65, 66, 67, 68, 69, 70, 71, 72, 73, 74, 75, 76, 77, 78, 79, 80, 81,
  82, 83, 84, 85, 86, 87, 91, 92, 93, 94, 95, 96, 97, 98, 99, 100, 101, 102, 103, 104, 105, 106, 107, 108,
  109, 110, 111, 112, 113, 114, 115, 116, 117, 118, 119, 120, 122, 123, 124, 125, 126, 127,
]);
const DRUM_NOTE_FIELDS = new Set(["fret", "string", "tie", "ghost", "accentuated", "staccato", "rest"]);

function drumNoteTex(n, stats, used) {
  const id = Math.round(n.fret);
  if (!DRUM_ARTICULATIONS.has(id)) { stats.unsupported.add(`drum note ${n.fret}`); stats.skippedDrums++; return null; }
  used.add(id);
  const eff = [];
  if (n.tie) eff.push("t");
  if (n.ghost) eff.push("g");
  if (n.accentuated === 2) eff.push("hac");
  else if (n.accentuated) eff.push("ac");
  if (n.staccato) eff.push("st");
  for (const k of Object.keys(n)) if (!DRUM_NOTE_FIELDS.has(k)) stats.unsupported.add(k);
  stats.notes++;
  return `p${id}${eff.length ? `{${eff.join(" ")}}` : ""}`;
}

function noteTex(n, beat, nStrings, stats) {
  const string = n.string + 1; // Songsterr 0 = highest string; alphaTex 1 = highest
  if (!(string >= 1 && string <= nStrings)) { stats.skippedNotes++; return null; }
  const fret = Math.max(0, Math.round(n.fret ?? 0));
  const eff = [];
  if (n.tie) eff.push("t");
  if (n.dead) eff.push("x");
  if (n.ghost) eff.push("g");
  if (n.hp) eff.push("h");
  if (n.slide) eff.push(...slideEffects(n.slide, stats));
  if (n.vibrato || n.leftHandVibrato === "slight") eff.push("v");
  else if (n.leftHandVibrato === "wide") eff.push("vw");
  if (n.accentuated === 2) eff.push("hac");
  else if (n.accentuated) eff.push("ac");
  if (n.staccato) eff.push("st");
  if (n.harmonic) {
    const h = HARMONICS[n.harmonic];
    // alphaTex numbers here are integers ("2.4" would read as fret.string); fractional harmonic frets
    // (2.4, 3.2, 5.8: nodes between frets) are written without a value
    if (h) eff.push(h === "ah" && Number.isInteger(n.harmonicFret) ? `ah ${n.harmonicFret}` : h);
    else stats.unsupported.add(`harmonic "${n.harmonic}"`);
  }
  if (n.bend?.points?.length && !n.tie) {
    const pts = pointsTex(n.bend.points);
    if (pts) eff.push(`be (${pts})`);
  }
  if (beat.palmMute) eff.push("pm");
  if (beat.letRing) eff.push("lr");
  for (const k of Object.keys(n)) if (!NOTE_FIELDS.has(k)) stats.unsupported.add(k);
  stats.notes++;
  return `${fret}.${string}${eff.length ? `{${eff.join(" ")}}` : ""}`;
}
const NOTE_FIELDS = new Set(["fret", "string", "tie", "dead", "ghost", "hp", "slide", "vibrato", "leftHandVibrato", "accentuated", "staccato", "harmonic", "harmonicFret", "bend", "rest"]);
const BEAT_FIELDS = new Set(["notes", "type", "duration", "dots", "tuplet", "tupletStart", "tupletStop", "rest", "beamStart", "beamStop",
  "palmMute", "letRing", "graceNote", "tremoloBar", "brushStroke", "upStroke", "downStroke", "velocity", "gradualVelocity", "text",
  "wahwah", "vibrato", "vibratoWithTremoloBar", "chord"]);
const DYNAMICS = new Set(["ppp", "pp", "p", "mp", "mf", "f", "ff", "fff"]);

function beatTex(beat, noteOf, stats, where, state, extra = []) {
  const { dur, eff } = valueOf(beat, where);
  eff.push(...extra);
  if (beat.graceNote) eff.push(beat.graceNote === "onBeat" ? "gr ob" : "gr bb");
  if (beat.velocity && DYNAMICS.has(beat.velocity) && beat.velocity !== state.dynamics) {
    eff.push(`dy ${beat.velocity}`);
    state.dynamics = beat.velocity;
  }
  if (beat.gradualVelocity === "crescendo") eff.push("cre");
  else if (beat.gradualVelocity === "decrescendo") eff.push("dec");
  if (beat.text?.text) eff.push(`txt ${q(beat.text.text)}`);
  if (beat.wahwah === "open") eff.push("waho");
  else if (beat.wahwah === "closed") eff.push("wahc");
  if (beat.brushStroke?.direction === "down") eff.push("bd");
  else if (beat.brushStroke?.direction === "up") eff.push("bu");
  else if (beat.upStroke) eff.push("su");
  else if (beat.downStroke) eff.push("sd");
  if (beat.vibratoWithTremoloBar === "wide") eff.push("vw");
  else if (beat.vibratoWithTremoloBar) eff.push("v");
  if (beat.tremoloBar?.points?.length) {
    const pts = pointsTex(beat.tremoloBar.points);
    if (pts) eff.push(`tbe (${pts})`);
  }
  for (const k of Object.keys(beat)) if (!BEAT_FIELDS.has(k)) stats.unsupported.add(k);
  const effTex = eff.length ? `{${eff.join(" ")}}` : "";

  const notes = (beat.notes ?? []).filter((n) => !n.rest).map(noteOf).filter(Boolean);
  if (!notes.length) {
    if (beat.graceNote) return ""; // a grace "rest" means nothing
    return `r.${dur}${effTex}`;
  }
  if (beat.graceNote) stats.graceNotes++;
  return `${notes.length === 1 ? notes[0] : `(${notes.join(" ")})`}.${dur}${effTex}`;
}

// Lyrics. Songsterr keeps a track's lyrics as Guitar Pro does: up to 5 lines (`newLyrics`), each a text
// and the bar it starts on (`offset`, 1 = the first bar). Spaces and line breaks separate words, a dash
// ends a syllable ("ne-ver"), "+" joins words under one note, [..] is a comment. The syllables go on the
// notes of the first voice in order, skipping rests and tied notes. Two spaces in a row leave a note
// without a syllable; that empty syllable may fall on a tied note. Checked against Songsterr's own page
// (2026-11-05): every syllable on the same note in Enter Sandman (303) and Come As You Are (232).
//
// lyricChunks splits a text into syllables exactly like alphaTab 1.8.4's Lyrics.finish(false) (one entry
// per note, "" for a note left empty; test/songsterr.test.js compares the two). alphaTab's own placement
// (Track.applyLyrics) doesn't skip tied notes, so the syllables are placed here and written per beat.
export function lyricChunks(text) {
  const chunks = [];
  const add = (s) => {
    s = s.split("+").join(" ");
    chunks.push(s.replace(/_+$/, ""));
  };
  const str = String(text ?? "");
  // states: 0 between words, 1 word start, 2 in a word, 3 in a [comment], 4 after a dash
  let state = 1, skipSpace = false, start = 0, p = 0;
  while (p < str.length) {
    const c = str[p];
    if (state === 0) {
      if (c === " " ? !skipSpace : c !== "\n" && c !== "\r" && c !== "\t") { if (c !== " ") skipSpace = false; state = 1; continue; }
    } else if (state === 1) {
      if (c === "[") state = 3;
      else { start = p; state = 2; continue; }
    } else if (state === 3) {
      if (c === "]") state = 1;
    } else if (state === 2) {
      if (c === "-") state = 4;
      else if (c === " " || c === "\n" || c === "\r") { add(str.slice(start, p)); state = 0; }
    } else if (state === 4 && c !== "-") {
      add(str.slice(start, p));
      skipSpace = true;
      state = 0;
      continue;
    }
    p++;
  }
  if (state === 2 && p !== start) add(str.slice(start, p));
  return chunks;
}

// The syllable of each beat of the first voice: Map "bar/beat" → [line 0 text, line 1 text, …]
export function placeLyrics(lines, measures) {
  const placed = new Map();
  const used = [];
  (lines ?? []).forEach((line, li) => {
    const chunks = lyricChunks(line?.text);
    if (!chunks.some(Boolean)) return;
    const row = Number.isInteger(line.line) && line.line >= 1 && line.line <= 5 ? line.line - 1 : li;
    let c = 0;
    const from = Math.max(0, (Number.isInteger(line.offset) ? line.offset : 1) - 1);
    for (let mi = from; mi < measures.length && c < chunks.length; mi++) {
      for (const [bi, b] of (measures[mi].voices?.[0]?.beats ?? []).entries()) {
        if (c >= chunks.length) break;
        const notes = (b.notes ?? []).filter((n) => !n.rest);
        if (b.rest || !notes.length) continue;
        if (notes.every((n) => n.tie) && chunks[c] !== "") continue;
        const s = chunks[c++];
        if (!s) continue;
        const k = `${mi}/${bi}`;
        if (!placed.has(k)) placed.set(k, []);
        placed.get(k)[row] = s;
      }
    }
    used.push({ row, syllables: chunks.filter(Boolean).length, placed: chunks.slice(0, c).filter(Boolean).length });
  });
  return { placed, lines: used };
}

const lyricsTex = (rows) => {
  const out = [];
  rows.forEach((s, row) => { if (s) out.push(rows.length === 1 && row === 0 ? `lyrics ${q(s)}` : `lyrics ${row} ${q(s)}`); });
  return out;
};

// exact bar length check (grace notes take no time, as in Guitar Pro)
const gcd = (a, b) => (b ? gcd(b, a % b) : Math.abs(a));
function addFrac([a, b], [c, d]) { const n = a * d + c * b, m = b * d, g = gcd(n, m) || 1; return [n / g, m / g]; }

export function buildAlphaTex(bundle, tracks, { warn = () => {} } = {}) {
  const bars = readStructure(tracks, { warn });
  const s = bundle.song;
  const lines = [
    `\\title ${q(s.title)}`,
    `\\artist ${q(s.artist)}`,
    `\\tab ${q(`Songsterr tab, revision ${s.revisionId} (converted by psarc2gp)`)}`,
    ".",
  ];
  const reports = [];
  const names = new Map();
  tracks.forEach((t, ti) => {
    const kind = trackKind(t.meta);
    const drums = kind === "drums";
    const vocals = kind === "vocals";
    const tuning = drums ? [] : t.data.tuning ?? t.meta.tuning;
    if (!drums && (!Array.isArray(tuning) || !tuning.length)) throw new Error(`${t.meta.name}: no tuning`);
    const nStrings = tuning.length;
    const usedDrums = new Set();
    const sound = soundFor(t.meta);
    const base = t.meta.name || t.data.name || `Track ${t.index + 1}`;
    names.set(base, (names.get(base) ?? 0) + 1);
    const name = names.get(base) > 1 ? `${base} ${names.get(base)}` : base;
    const stats = { notes: 0, graceNotes: 0, skippedNotes: 0, skippedDrums: 0, unsupported: new Set(), badBars: [] };
    lines.push(`\\track ${q(name)}`);
    // drums: a percussion staff (no tab); the articulation names are declared once the notes are known
    const articulationLine = drums ? lines.push("\\staff {score}", "\\instrument percussion", "") - 1 : -1;
    if (!drums) {
      // vocals: notation only (Songsterr stores them as frets on a made-up tuning; the pitches are what
      // counts), played by a clarinet as in Guitar Pro's own vocal tracks (src/gp/rse.js "voice")
      lines.push(vocals ? "\\staff {score}" : "\\staff {score tabs}");
      lines.push(`\\tuning (${tuning.map(pitchName).join(" ")})`);
      lines.push(`\\instrument ${vocals ? SOUNDS_PROGRAM_VOICE : Math.max(0, Math.min(127, t.meta.instrumentId ?? 27))}`);
    }
    const lyrics = vocals ? placeLyrics(t.data.newLyrics, t.data.measures) : null;
    // a low voice (a man's) is written in the treble clef an octave up, with the 8 below the clef
    const lowVoice = vocals && medianPitch(t.data.measures, tuning) < 60;
    if (kind === "guitar" || kind === "bass") lines.push("\\displaytranspose 12");
    const capo = drums ? 0 : t.data.capo ?? t.meta.capo;
    if (capo > 0) lines.push(`\\capo ${capo}`);

    const nVoices = Math.max(...t.data.measures.map((m) => m.voices?.length ?? 0));
    for (let vi = 0; vi < Math.max(1, nVoices); vi++) {
      if (vi > 0) lines.push("\\voice");
      const state = { dynamics: null };
      let lastKey = null;
      const body = t.data.measures.map((m, mi) => {
        const bar = bars[mi];
        const meta = [];
        if (vi === 0) {
          const clef = drums ? undefined : CLEFS[m.clef]; // a percussion staff keeps alphaTab's own clef
          if (m.clef !== undefined && !clef && !drums) stats.unsupported.add(`clef ${m.clef}`);
          if (clef) meta.push(`\\clef ${clef}`);
          else if (mi === 0 && kind === "bass") meta.push("\\clef bass");
          else if (mi === 0 && drums) meta.push("\\clef neutral"); // alphaTab gives a percussion staff a treble clef
          else if (mi === 0 && lowVoice) meta.push("\\clef G2 \\ottava 8vb");
          if (ti === 0) {
            if (mi === 0 && bars.anacrusis) meta.push("\\ac");
            if (bar.tsChange) meta.push(`\\ts (${bar.num} ${bar.den})`);
            if (bar.tripletFeel) meta.push(`\\tf ${bar.tripletFeel}`);
            if (bar.repeatStart) meta.push("\\ro");
            if (bar.endings) meta.push(bar.endings.length > 1 ? `\\ae (${bar.endings.join(" ")})` : `\\ae ${bar.endings[0]}`);
            if (bar.repeatCount) meta.push(`\\rc ${bar.repeatCount}`);
            for (const tp of bar.tempo ?? []) meta.push(tp.ratio ? `\\tempo (${tp.bpm} "" ${tp.ratio})` : `\\tempo ${tp.bpm}`);
            if (bar.section) meta.push(`\\section ${q(bar.section)}`);
          }
          if (bar.key !== undefined && bar.key !== lastKey && bar.key >= -7 && bar.key <= 7) {
            meta.push(`\\ks ${KEYS[bar.key + 7]}`);
            lastKey = bar.key;
          }
        }
        const voice = m.voices?.[vi];
        let beats = [];
        let len = [0, 1];
        for (const [bi, b] of (voice?.beats ?? []).entries()) {
          const noteOf = drums ? (n) => drumNoteTex(n, stats, usedDrums) : (n) => noteTex(n, b, nStrings, stats);
          const words = vi === 0 && lyrics?.placed.get(`${mi}/${bi}`);
          const tex = beatTex(b, noteOf, stats, `${name}, bar ${mi + 1}, beat ${bi + 1}`, state, words ? lyricsTex(words) : []);
          if (tex) beats.push(tex);
          if (!b.graceNote && Array.isArray(b.duration)) len = addFrac(len, b.duration);
        }
        const want = [bar.num, bar.den];
        const full = len[0] * want[1] === want[0] * len[1];
        // a bar rest (voice.rest) can be stored as one whole rest whatever the time signature
        const barRest = voice?.rest === true && (voice.beats ?? []).every((b) => b.rest || b.notes?.every((n) => n.rest));
        if (!beats.length || (!full && !(mi === 0 && bars.anacrusis))) {
          // a voice that's empty or doesn't fill its bar: if it's a second voice, fill with a rest;
          // otherwise keep what's there and let alphaTab pad/report it
          if (!beats.length || barRest) beats = [restFor(want)];
          else stats.badBars.push(mi + 1);
        }
        return `${meta.length ? `${meta.join(" ")} ` : ""}${beats.join(" ")}`;
      });
      lines.push(body.join(" |\n"));
    }
    if (drums) lines[articulationLine] = [...usedDrums].sort((a, b) => a - b).map((id) => `\\articulation (p${id} ${id})`).join(" ");
    if (stats.skippedDrums) warn(`${name}: ${stats.skippedDrums} drum note(s) of kinds alphaTab doesn't know were left out`);
    if (stats.badBars.length) warn(`${name}: ${stats.badBars.length} bar(s) don't add up to their time signature (bar ${stats.badBars.slice(0, 5).join(", ")})`);
    if (stats.skippedNotes) warn(`${name}: ${stats.skippedNotes} note(s) on strings the tuning doesn't have were left out`);
    if (stats.unsupported.size) warn(`${name}: not converted: ${[...stats.unsupported].join(", ")}`);
    for (const l of lyrics?.lines ?? []) {
      if (l.placed < l.syllables) warn(`${name}: lyrics line ${l.row + 1} has ${l.syllables - l.placed} syllable(s) more than the notes after its start; left out`);
    }
    reports.push({
      name, kind, index: t.index, notes: stats.notes, graceNotes: stats.graceNotes, sound,
      ...(lyrics && { syllables: lyrics.lines.reduce((a, l) => a + l.placed, 0) }),
      tuning: drums ? "" : [...tuning].reverse().map(pitchName).join(" "), // lowest first, as psarc reports it
    });
  });
  return { tex: lines.join("\n") + "\n", bars, tracks: reports };
}

const SOUNDS_PROGRAM_VOICE = 71; // General MIDI clarinet, the program of rse.js's "voice" sound

// the middle pitch of a stringed track's notes (MIDI number), or Infinity with no notes
function medianPitch(measures, tuning) {
  const p = [];
  for (const m of measures) for (const v of m.voices ?? []) for (const b of v.beats ?? []) {
    for (const n of b.notes ?? []) if (!n.rest && tuning[n.string] !== undefined) p.push(tuning[n.string] + (n.fret ?? 0));
  }
  return p.length ? p.sort((a, b) => a - b)[p.length >> 1] : Infinity;
}

// a rest filling a bar of num/den (whole-bar rests in common meters, otherwise a run of den-notes)
function restFor([num, den]) {
  if (num === den) return "r.1";
  if (num * 2 === den) return "r.2";
  return Array.from({ length: num }, () => `r.${den}`).join(" ");
}
