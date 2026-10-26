// Assemble an alphaTex document (all tracks, bar metadata, sync points) from a loaded song.
import { buildTimeline, measureAt, syncPoints } from "./timeline.js";
import { convertArrangement, pitchName } from "./arrangement.js";
import { SOUNDS, chooseSound } from "../gp/rse.js";

const q = (s) => `"${String(s ?? "").replace(/["\\]/g, "'")}"`;

const titleCase = (s) => s.replace(/[_-]+/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());

export function buildAlphaTex(song, { warn = () => {} } = {}) {
  const ref = song.arrangements[0];
  for (const a of song.arrangements.slice(1)) {
    const same = a.sng.beats.length === ref.sng.beats.length && a.sng.beats.every((b, i) => Math.abs(b.time - ref.sng.beats[i].time) < 0.001);
    if (!same) warn(`${a.name}: beat grid differs from ${ref.name}; using ${ref.name}'s grid for all tracks`);
  }
  const allNotes = song.arrangements.flatMap((a) => a.notes.map((n) => n.time));
  const measures = buildTimeline(ref.sng.beats, ref.sng.events, {
    anyNotesIn: (s, e) => allNotes.some((t) => t >= s - 0.002 && t < e - 0.002),
  });

  const sectionAt = new Map();
  for (const s of ref.sng.sections) {
    const mi = measureAt(measures, s.start, 0.05);
    if (mi >= 0 && !sectionAt.has(mi)) sectionAt.set(mi, titleCase(s.name));
  }

  const lines = [
    `\\title ${q(song.meta.title)}`,
    `\\artist ${q(song.meta.artist)}`,
    `\\album ${q(song.meta.album)}`,
    `\\tab ${q(`Rocksmith CDLC${song.meta.charter ? ` by ${song.meta.charter}` : ""} (converted by psarc2gp)`)}`,
    ".",
  ];

  const nameCount = {};
  const trackReports = [];
  song.arrangements.forEach((arr, ti) => {
    const conv = convertArrangement(arr, measures, { warn: (m) => warn(`${arr.name}: ${m}`) });
    nameCount[arr.name] = (nameCount[arr.name] ?? 0) + 1;
    const n = song.arrangements.filter((a) => a.name === arr.name).length;
    const name = `${arr.name}${n > 1 && nameCount[arr.name] > 1 ? ` ${nameCount[arr.name]}` : ""}${arr.bonus ? " (bonus)" : ""}`;
    const bassSound = arr.isBass || conv.isBassRange;
    // the MIDI program matches the RSE sound convert.js puts on the track, so Guitar Pro's instrument
    // type and icon agree with it (and MIDI-engine output gets the same kind of instrument)
    const sound = chooseSound(arr, { bass: bassSound });
    lines.push(`\\track ${q(name)}`);
    lines.push("\\staff {score tabs}");
    lines.push(`\\tuning (${conv.tuning.slice(0, conv.nStrings).reverse().map(pitchName).join(" ")})`);
    lines.push(`\\instrument ${SOUNDS[sound].program}`);
    // guitar and bass are written an octave above sounding pitch (as Guitar Pro does)
    lines.push("\\displaytranspose 12");
    if (arr.capo > 0) lines.push(`\\capo ${arr.capo}`);

    let lastTs = null;
    let lastTempo = null;
    let shownTempo = null;
    const bars = conv.bars.map((body, mi) => {
      const meta = [];
      if (mi === 0 && bassSound) meta.push("\\clef bass");
      if (ti === 0) {
        const m = measures[mi];
        const ts = `${m.display.num}/${m.display.den}`;
        if (ts !== lastTs) { meta.push(`\\ts (${m.display.num} ${m.display.den})`); lastTs = ts; }
        // Playback timing comes from the sync points; tempo marks are for reading. Show the first one
        // and real tempo changes, keep small bar-to-bar drift hidden.
        if (m.tempo !== lastTempo) {
          const real = shownTempo === null || Math.abs(m.tempo - shownTempo) / shownTempo > 0.08;
          meta.push(real ? `\\tempo ${m.tempo}` : `\\tempo (${m.tempo} "" 0 hide)`);
          if (real) shownTempo = m.tempo;
          lastTempo = m.tempo;
        }
        if (sectionAt.has(mi)) meta.push(`\\section ${q(sectionAt.get(mi))}`);
      }
      return meta.length ? `${meta.join(" ")} ${body}` : body;
    });
    lines.push(bars.join(" |\n"));
    trackReports.push({ name, ...conv.stats, tuning: conv.tuning.slice(0, conv.nStrings).map(pitchName).join(" "), sound });
  });

  const sync = syncPoints(measures);
  lines.push(".");
  for (const s of sync) lines.push(`\\sync (${s.bar} 0 ${s.ms.toFixed(1)} ${+s.ratio.toFixed(6)})`);
  return { tex: lines.join("\n") + "\n", measures, sync, tracks: trackReports };
}
