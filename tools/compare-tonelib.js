// Compare the converter's notation with ToneLib's for the same chart.
// usage: node tools/compare-tonelib.js song.psarc song.song [barOffset]
// barOffset: ToneLib bar index minus converter bar index (ToneLib sometimes re-bars the count-in);
// detected automatically when omitted.
import fs from "node:fs";
import { createRequire } from "node:module";
import { loadSong } from "../src/rocksmith/song.js";
import { buildAlphaTex } from "../src/notation/score.js";
import { loadToneLib } from "./tonelib.js";

const require = createRequire(import.meta.url);
const alphaTab = require("@coderline/alphatab");
const [psarcPath, songPath, offsetArg] = process.argv.slice(2);

const ours = alphaTab.importer.ScoreLoader.loadAlphaTex(buildAlphaTex(loadSong(fs.readFileSync(psarcPath))).tex, new alphaTab.Settings());
const tl = loadToneLib(fs.readFileSync(songPath));

// struck notes per bar: "onset@string/fret" with onset in ticks from the bar start, plus durations
function barNotes(bar) {
  const out = new Map();
  const voice = bar.voices[0];
  voice.beats.forEach((b, bi) => {
    for (const n of b.notes) {
      if (n.isTieDestination) continue;
      // total length including tied continuations
      let len = b.playbackDuration;
      let cur = n;
      while (cur.tieDestination) { cur = cur.tieDestination; len += cur.beat.playbackDuration; }
      out.set(`${b.playbackStart}@${n.string}/${n.fret}`, len);
    }
  });
  return out;
}

function compareTracks(a, b, offset) {
  let matched = 0, onlyOurs = 0, onlyTl = 0, sameLen = 0;
  const diffs = [];
  for (let i = 0; i < a.staves[0].bars.length; i++) {
    const tb = b.staves[0].bars[i + offset];
    if (!tb) continue;
    const x = barNotes(a.staves[0].bars[i]);
    const y = barNotes(tb);
    for (const [k, len] of x) {
      if (y.has(k)) { matched++; if (y.get(k) === len) sameLen++; } else { onlyOurs++; if (diffs.length < 8) diffs.push(`bar ${i + 1}: ours has ${k}`); }
    }
    for (const k of y.keys()) if (!x.has(k)) { onlyTl++; if (diffs.length < 8) diffs.push(`bar ${i + 1}: ToneLib has ${k}`); }
  }
  return { matched, onlyOurs, onlyTl, sameLen, diffs };
}

let offset = offsetArg !== undefined ? +offsetArg : null;
if (offset === null) {
  let best = -1;
  for (let o = -4; o <= 4; o++) {
    const r = compareTracks(ours.tracks[0], tl.tracks[0], o);
    if (r.matched > best) { best = r.matched; offset = o; }
  }
}
console.log(`bar offset ToneLib-ours: ${offset}`);
ours.tracks.forEach((t, i) => {
  const r = compareTracks(t, tl.tracks[i] ?? tl.tracks[0], offset);
  const total = r.matched + r.onlyOurs;
  console.log(`${t.name}: onsets matched ${r.matched}/${total} (${(100 * r.matched / total).toFixed(1)}%), only ours ${r.onlyOurs}, only ToneLib ${r.onlyTl}; same duration ${r.sameLen}/${r.matched} (${(100 * r.sameLen / r.matched).toFixed(1)}%)`);
  for (const d of r.diffs) console.log("   ", d);
});
