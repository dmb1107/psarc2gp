// One Rocksmith arrangement -> alphaTex bars.
//
// Rocksmith notes are timestamps, not rhythms. Each note is placed on the beat grid of its measure,
// snapped to the best subdivision for that beat (16ths, 8th/16th triplets or 32nds), and durations
// come from sustains or the gap to the next note.
import { NoteMask as M } from "../rocksmith/sng.js";
import { TPQ, measureAt } from "./timeline.js";

// 16th, 8th triplet, 16th triplet, 32nd, 64th (ticks at 48 per quarter); first one that fits wins
const GRID_STEPS = [12, 16, 8, 6, 3];
const TRIPLET_STEPS = new Set([16, 8]);
const SNAP_TOLERANCE = 0.045; // fraction of a beat (~22 ms at 120 bpm); charts are grid-snapped

const STRAIGHT = new Map([[192, "1"], [144, "2d"], [96, "2"], [72, "4d"], [48, "4"], [36, "8d"], [24, "8"], [18, "16d"], [12, "16"], [9, "32d"], [6, "32"], [3, "64"]]);
const TRIPLET = new Map([[64, "2"], [32, "4"], [16, "8"], [8, "16"], [4, "32"]]);
const STRAIGHT_DESC = [...STRAIGHT.keys()];
const TRIPLET_DESC = [...TRIPLET.keys()];

const BASE_BASS = [28, 33, 38, 43]; // E1 A1 D2 G2
const BASE_GUITAR = [40, 45, 50, 55, 59, 64]; // E2 A2 D3 G3 B3 E4
const NOTE_NAMES = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"];
const pitchName = (midi) => `${NOTE_NAMES[midi % 12]}${Math.floor(midi / 12) - 1}`;

export function tuningOf(arr) {
  const base = arr.isBass ? BASE_BASS : BASE_GUITAR;
  const octave = Math.round(arr.centOffset / 100); // e.g. -1200 cents: charted an octave up (extended range)
  return base.map((b, i) => b + (arr.tuning[i] ?? 0) + octave); // lowest string first
}

function chooseGrid(fracs, beatTicks) {
  const steps = GRID_STEPS.filter((s) => beatTicks % s === 0);
  let best = null;
  for (const step of steps) {
    const slots = beatTicks / step;
    const err = Math.max(...fracs.map((f) => Math.abs(f * slots - Math.round(f * slots)) / slots));
    if (err <= SNAP_TOLERANCE) return { step, offGrid: false };
    if (!best || err < best.err) best = { step, err };
  }
  return { step: best?.step ?? 12, offGrid: true };
}

export function convertArrangement(arr, measures, { warn = () => {} } = {}) {
  const nStrings = arr.isBass ? 4 : 6;
  const tuning = tuningOf(arr);
  const isBassRange = tuning[0] < 40; // a guitar arrangement charted an octave up is really a bass
  const songTicks = measures.at(-1).startTick + measures.at(-1).ticks;

  // ---- quick slides / hammer-ons into a note (a few tens of ms apart) are grace notes; take them out
  // before grid fitting so they don't force the beat onto a 64th-note grid
  const graceOf = new Map();
  const isGrace = new Set();
  const singles = arr.notes.filter((n) => !(n.mask & M.CHORD));
  for (let i = 0; i < singles.length; i++) {
    const a = singles[i];
    const b = singles.slice(i + 1).find((x) => x.string === a.string);
    if (!b || isGrace.has(a)) continue;
    const mi = measureAt(measures, a.time);
    if (mi < 0) continue;
    const beatLen = (measures[mi].end - measures[mi].start) / measures[mi].beatTimes.length;
    const gap = b.time - a.time;
    const slideInto = a.slideTo === b.fret || a.slideUnpitchTo >= 0;
    const hopoInto = (b.mask & (M.HAMMER_ON | M.PULL_OFF)) !== 0 && b.fret !== a.fret;
    if (gap > 0 && gap < Math.min(0.08, 0.1 * beatLen) && (slideInto || hopoInto)) {
      isGrace.add(a);
      // an on-beat grace delays the main note by its own length: pick the value closest to the gap
      graceOf.set(b, { fret: a.fret, eff: slideInto ? (b.mask & M.CHILD ? "sl" : "ss") : "h", time: a.time, dur: gap / beatLen >= 0.09 ? "32" : "64" });
    }
  }

  // ---- locate every onset within its measure/beat
  const located = [];
  for (const n of arr.notes) {
    if (isGrace.has(n)) continue;
    const t = graceOf.get(n)?.time ?? n.time; // a note with a grace sits where the grace starts
    const mi = measureAt(measures, t);
    if (mi < 0) { warn(`note before first beat at ${t.toFixed(2)}s skipped`); continue; }
    const m = measures[mi];
    const grid = [...m.beatTimes, m.end];
    let j = 0;
    while (j + 1 < grid.length - 1 && grid[j + 1] <= t) j++;
    const frac = Math.min(1, Math.max(0, (t - grid[j]) / (grid[j + 1] - grid[j])));
    located.push({ n, mi, j, frac });
  }

  // ---- choose a subdivision per beat, then snap
  const beatGrid = new Map(); // "mi:j" -> step
  const byBeat = new Map();
  for (const l of located) {
    const k = `${l.mi}:${l.j}`;
    if (!byBeat.has(k)) byBeat.set(k, []);
    byBeat.get(k).push(l.frac);
  }
  let offGridBeats = 0;
  for (const [k, fracs] of byBeat) {
    const mi = +k.split(":")[0];
    const g = chooseGrid(fracs, measures[mi].beatTicks);
    if (g.offGrid) offGridBeats++;
    beatGrid.set(k, g.step);
  }
  const stepAt = (mi, j) => beatGrid.get(`${mi}:${j}`) ?? 12;
  const snap = (mi, j, frac) => {
    const m = measures[mi];
    const step = stepAt(mi, j);
    return m.startTick + j * m.beatTicks + Math.round((frac * m.beatTicks) / step) * step;
  };
  const timeToTick = (t) => {
    const mi = measureAt(measures, t);
    if (mi < 0) return 0;
    const m = measures[mi];
    if (t >= m.end) return m.startTick + m.ticks;
    const grid = [...m.beatTimes, m.end];
    let j = 0;
    while (j + 1 < grid.length - 1 && grid[j + 1] <= t) j++;
    return snap(mi, j, (t - grid[j]) / (grid[j + 1] - grid[j]));
  };

  // ---- build events (one per distinct onset tick)
  const events = new Map();
  let collisions = 0;
  let graceNotes = 0;
  let prevChord = -2;
  for (const { n, mi, j, frac } of located) {
    const tick = snap(mi, j, frac);
    if (!events.has(tick)) events.set(tick, { tick, notes: [], beatEff: new Set(), chordName: null });
    const ev = events.get(tick);
    const startTime = n.time;
    const sustainEnd = n.sustain > 0.001 ? timeToTick(n.time + n.sustain) : null;

    const addNote = (rsString, fret, mask, extra) => {
      const note = { rsString, string: nStrings - rsString, fret, mask, sustainEnd, startTime, sustain: n.sustain, eff: new Set(), ...extra };
      const i = ev.notes.findIndex((x) => x.rsString === rsString);
      if (i < 0) { ev.notes.push(note); return; }
      // Two notes on one string landed on the same grid position: a quick slide or hammer-on into
      // the second note. Write the first as an on-beat grace note leading into the second.
      const prev = ev.notes[i];
      const slideInto = prev.slideTo === fret || prev.slideUnpitchTo >= 0;
      const hopoInto = mask & (M.HAMMER_ON | M.PULL_OFF);
      if (slideInto || hopoInto) {
        ev.grace ??= [];
        ev.grace.push({ string: prev.string, fret: prev.fret, eff: slideInto ? (mask & M.CHILD ? "sl" : "ss") : "h" });
        prev.slideTo = -1; prev.slideUnpitchTo = -1;
        ev.notes[i] = note;
        graceNotes++;
      } else {
        collisions++;
      }
    };

    if (n.mask & M.CHORD && n.chordId >= 0) {
      const tpl = arr.sng.chords[n.chordId];
      const cn = n.chordNotesId >= 0 ? arr.sng.chordNotes[n.chordNotesId] : null;
      for (let s = 0; s < nStrings; s++) {
        if (tpl.frets[s] < 0) continue;
        const sm = (cn?.masks[s] ?? 0) | (n.mask & (M.PALM_MUTE | M.FRET_HAND_MUTE | M.ACCENT | M.MUTE));
        addNote(s, tpl.frets[s], sm, {
          slideTo: cn?.slideTo[s] ?? -1, slideUnpitchTo: cn?.slideUnpitchTo[s] ?? -1,
          vibrato: cn?.vibrato[s] ?? 0, bends: cn?.bends[s] ?? [],
        });
      }
      const name = tpl.name.trim();
      if (name && n.chordId !== prevChord) ev.chordName = name;
      prevChord = n.chordId;
    } else {
      addNote(n.string, n.fret, n.mask, { slideTo: n.slideTo, slideUnpitchTo: n.slideUnpitchTo, vibrato: n.vibrato, bends: n.bends, tap: n.tap, slap: n.slap, pluck: n.pluck });
      const g = graceOf.get(n);
      if (g) {
        (ev.grace ??= []).push({ string: nStrings - n.string, fret: g.fret, eff: g.eff, dur: g.dur });
        graceNotes++;
      }
    }
    if (n.mask & M.TAP || n.tap > 0) ev.beatEff.add("tt");
    if (n.mask & M.SLAP || n.slap > 0) ev.beatEff.add("s");
    if (n.mask & M.PLUCK || n.pluck > 0) ev.beatEff.add("p");
    if (n.mask & M.TREMOLO) ev.beatEff.add("tp 16");
  }
  const ordered = [...events.values()].sort((a, b) => a.tick - b.tick);

  // ---- techniques that depend on neighbouring notes (hammer-ons, slides, linked ties)
  const lastOnString = new Map();
  const pendingSlide = new Map();
  ordered.forEach((ev, ei) => {
    for (const note of ev.notes) {
      const mk = note.mask;
      const prev = lastOnString.get(note.rsString);
      const prevIsAdjacent = prev && prev.eventIndex === ei - 1;
      const slide = pendingSlide.get(note.rsString);
      if (slide) {
        slide.note.slideOut = note.fret === slide.to ? (mk & M.CHILD ? "sl" : "ss") : slide.to > slide.note.fret ? "sou" : "sod";
        pendingSlide.delete(note.rsString);
      }
      if (mk & M.CHILD && prevIsAdjacent && prev.note.fret === note.fret && prev.note.mask & M.PARENT && !(prev.note.slideTo >= 0)) {
        note.tie = true; // linked sustain continuation, not a new attack
      } else if (mk & (M.HAMMER_ON | M.PULL_OFF) && prevIsAdjacent && prev.note.fret !== note.fret) {
        prev.note.hopoOrigin = true;
      }
      if (note.slideTo >= 0 && note.slideTo !== note.fret) pendingSlide.set(note.rsString, { note, to: note.slideTo });
      else if (note.slideUnpitchTo >= 0) note.slideOut = note.slideUnpitchTo > note.fret ? "sou" : "sod";
      lastOnString.set(note.rsString, { note, eventIndex: ei });
    }
  });
  for (const { note, to } of pendingSlide.values()) note.slideOut = to > note.fret ? "sou" : "sod";

  // ---- durations (same rules ToneLib uses): a held note that stops within a beat of the next note
  // is held through to it; an unsustained note fills to the next note but not past its own bar.
  const segments = [];
  let cursor = 0;
  ordered.forEach((ev, i) => {
    if (ev.tick > cursor) segments.push({ start: cursor, end: ev.tick, ev: null });
    const next = ordered[i + 1]?.tick ?? songTicks;
    const [mi, j] = beatOf(measures, ev.tick);
    const m = measures[mi];
    const sus = ev.notes.map((x) => x.sustainEnd).filter((x) => x !== null);
    let end;
    if (sus.length) {
      end = Math.max(...sus);
      if (next - end <= m.beatTicks) end = next;
    } else {
      end = Math.min(next, m.startTick + m.ticks);
    }
    const minLen = stepAt(mi, j);
    end = Math.min(next, Math.max(end, ev.tick + minLen));
    segments.push({ start: ev.tick, end, ev });
    cursor = end;
  });
  if (cursor < songTicks) segments.push({ start: cursor, end: songTicks, ev: null });

  // ---- cut into notatable pieces per measure
  const bars = measures.map(() => []);
  for (const seg of segments) {
    let p = seg.start;
    let first = true;
    while (p < seg.end) {
      const mi = measureAtTick(measures, p);
      const m = measures[mi];
      const mEnd = Math.min(seg.end, m.startTick + m.ticks);
      const pieces = decompose(p - m.startTick, mEnd - m.startTick, m, (j) => stepAt(mi, j));
      pieces.forEach((pc, k) => {
        const isLast = p + pc.dur >= seg.end && k === pieces.length - 1;
        bars[mi].push({ ...pc, ev: seg.ev, first, last: isLast });
        first = false;
      });
      p = mEnd;
    }
  }

  const steps = [...beatGrid.values()];
  const stats = {
    events: ordered.length, notes: ordered.reduce((s, e) => s + e.notes.length, 0), graceNotes, droppedDuplicates: collisions,
    tripletBeats: steps.filter((s) => TRIPLET_STEPS.has(s)).length, beats32nd: steps.filter((s) => s === 6).length,
    beats64th: steps.filter((s) => s === 3).length, unsnappedBeats: offGridBeats,
  };
  return { bars: bars.map((pieces) => pieces.map(pieceToTex).join(" ")), tuning, nStrings, isBassRange, stats };
}

function beatOf(measures, tick) {
  const mi = measureAtTick(measures, tick);
  const m = measures[mi];
  return [mi, Math.min(m.num - 1, Math.floor((tick - m.startTick) / m.beatTicks))];
}

function measureAtTick(measures, tick) {
  let lo = 0, hi = measures.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (measures[mid].startTick <= tick) lo = mid; else hi = mid - 1;
  }
  return lo;
}

// Split [p, e) (ticks within one measure) into note values that read naturally: pieces starting on
// a beat may span beats; off-beat pieces stay inside their beat; triplet beats use triplet values.
function decompose(p, e, m, stepOfBeat) {
  const out = [];
  const bt = m.beatTicks;
  const isTriplet = (j) => TRIPLET_STEPS.has(stepOfBeat(j));
  while (p < e) {
    const j = Math.floor(p / bt);
    const beatStart = j * bt;
    const beatEnd = beatStart + bt;
    let dur = 0;
    let tuplet = false;
    if (p === beatStart && (!isTriplet(j) || e >= beatEnd)) {
      for (const d of STRAIGHT_DESC) {
        if (d > e - p) continue;
        if (d < bt && isTriplet(j)) continue;
        const endBeat = Math.floor((p + d) / bt);
        if ((p + d) % bt !== 0 && isTriplet(endBeat)) continue; // can't end mid-way into a triplet beat
        dur = d;
        break;
      }
    } else if (isTriplet(j)) {
      // One uniform unit per triplet beat (8th triplets, or 16th triplets in groups of three), with
      // ties for longer notes. Mixed values inside one tuplet group don't form complete groups in
      // alphaTab (and read poorly), so they are avoided.
      dur = Math.min(stepOfBeat(j), Math.min(e, beatEnd) - p);
      tuplet = true;
    } else {
      for (const d of STRAIGHT_DESC) if (d <= Math.min(e, beatEnd) - p) { dur = d; break; }
    }
    if (!dur) {
      // should not happen with grid-aligned input; fall back to the smallest value
      dur = Math.min(e - p, 3);
    }
    out.push({ tick: p, dur, tuplet });
    p += dur;
  }
  return out;
}

function pieceToTex(pc) {
  const table = pc.tuplet ? TRIPLET : STRAIGHT;
  const code = table.get(pc.dur) ?? "64";
  const dotted = code.endsWith("d");
  const dur = dotted ? code.slice(0, -1) : code;
  const beatEff = [];
  if (dotted) beatEff.push("d");
  if (pc.tuplet) beatEff.push("tu 3");
  if (!pc.ev) return `r.${dur}${beatEff.length ? `{${beatEff.join(" ")}}` : ""}`;

  if (pc.first) {
    for (const b of pc.ev.beatEff) if (b !== "tp 16") beatEff.push(b);
    if (pc.ev.chordName) beatEff.push(`ch "${pc.ev.chordName.replace(/"/g, "'")}"`);
  }
  if (pc.ev.beatEff.has("tp 16")) beatEff.push("tp 16");

  const notes = pc.ev.notes
    .slice()
    .sort((a, b) => a.string - b.string)
    .map((nt) => {
      const eff = [];
      if (!pc.first || nt.tie) eff.push("t");
      const mk = nt.mask;
      if (mk & (M.MUTE | M.FRET_HAND_MUTE)) eff.push("x");
      if (mk & M.PALM_MUTE) eff.push("pm");
      if (mk & M.PINCH_HARMONIC) eff.push("ph");
      else if (mk & M.HARMONIC) eff.push("nh");
      if (mk & M.VIBRATO || nt.vibrato > 0) eff.push("v");
      if (pc.first) {
        if (mk & M.ACCENT) eff.push("ac");
        const bend = bendTex(nt);
        if (bend) eff.push(bend);
      }
      if (pc.last) {
        if (nt.hopoOrigin) eff.push("h");
        if (nt.slideOut) eff.push(nt.slideOut);
      }
      return `${nt.fret}.${nt.string}${eff.length ? `{${eff.join(" ")}}` : ""}`;
    });
  const body = notes.length === 1 ? notes[0] : `(${notes.join(" ")})`;
  let grace = "";
  if (pc.first && pc.ev.grace) {
    const g = pc.ev.grace.map((x) => `${x.fret}.${x.string}{${x.eff}}`);
    grace = `${g.length === 1 ? g[0] : `(${g.join(" ")})`}.${pc.ev.grace[0].dur ?? "32"}{gr ob} `;
  }
  return `${grace}${body}.${dur}${beatEff.length ? `{${beatEff.join(" ")}}` : ""}`;
}

// Rocksmith bend points are (time, semitones). Guitar Pro bends are start -> peak -> end with
// positions 0-60 and values in quarter tones; that shape covers bends, releases and prebends.
function bendTex(nt) {
  const pts = (nt.bends ?? []).filter((b) => b.time > 0 || b.step > 0);
  if (!pts.length || !pts.some((b) => b.step > 0)) return null;
  const len = nt.sustain > 0.01 ? nt.sustain : 0.25;
  const q = (step) => Math.max(0, Math.min(12, Math.round(step * 2)));
  const startsBent = (pts[0].time - nt.startTime) / len <= 0.02;
  const start = startsBent ? q(pts[0].step) : 0;
  const peak = pts.reduce((a, b) => (b.step > a.step ? b : a));
  const peakPos = Math.max(1, Math.min(59, Math.round(((peak.time - nt.startTime) / len) * 60)));
  const end = q(pts[pts.length - 1].step);
  if (q(peak.step) === start) return `be (0 ${start} 60 ${end})`;
  return `be (0 ${start} ${peakPos} ${q(peak.step)} 60 ${end})`;
}

export { pitchName };
