// End-to-end checks on converted songs.  usage: node tools/verify.js a.psarc [b.psarc ...]
//  - every bar of every track is exactly full
//  - every Rocksmith note appears in the notation (string + fret)
//  - each written note, mapped back to seconds through the sync points, lands on its Rocksmith time
import fs from "node:fs";
import { createRequire } from "node:module";
import { loadSong } from "../src/rocksmith/song.js";
import { buildAlphaTex } from "../src/notation/score.js";
import { NoteMask } from "../src/rocksmith/sng.js";

const require = createRequire(import.meta.url);
const alphaTab = require("@coderline/alphatab");

export function verify(psarcBuf) {
  const song = loadSong(psarcBuf);
  const { tex, sync } = buildAlphaTex(song);
  const score = alphaTab.importer.ScoreLoader.loadAlphaTex(tex, new alphaTab.Settings());
  const problems = [];

  // seconds of a position given as (bar, ratio within bar), by linear interpolation of sync points
  const keyed = sync.map((s) => ({ x: s.bar + s.ratio, t: s.ms / 1000 }));
  const timeAt = (bar, ratio) => {
    const x = bar + ratio;
    let i = 0;
    while (i + 2 < keyed.length && keyed[i + 1].x <= x) i++;
    const a = keyed[i], b = keyed[i + 1];
    return a.t + ((x - a.x) / (b.x - a.x)) * (b.t - a.t);
  };

  const results = song.arrangements.map((arr, ti) => {
    const track = score.tracks[ti];
    const nStrings = arr.isBass ? 4 : 6;
    let incomplete = 0;
    const written = [];
    track.staves[0].bars.forEach((bar, bi) => {
      const mb = score.masterBars[bi];
      const want = mb.calculateDuration();
      // notated length (tuplets and dots included; grace notes count 0)
      const got = bar.voices[0].beats.reduce((s, b) => s + b.displayDuration, 0);
      if (got !== want) incomplete++;
      for (const b of bar.voices[0].beats) for (const n of b.notes) {
        // alphaTab's model numbers strings from the lowest (1); Rocksmith from the lowest (0)
        written.push({ t: timeAt(bi, b.playbackStart / want), string: n.string - 1, fret: n.fret, tie: n.isTieDestination });
      }
    });
    // expected: every Rocksmith onset (chords expanded through their templates)
    // linked continuations (Rocksmith "link next" children) are written as tied notes
    const expected = [];
    for (const n of arr.notes) {
      const linked = (n.mask & NoteMask.CHILD) !== 0;
      if (n.mask & NoteMask.CHORD && n.chordId >= 0) {
        arr.sng.chords[n.chordId].frets.forEach((f, s) => { if (f >= 0 && s < nStrings) expected.push({ t: n.time, string: s, fret: f, linked }); });
      } else expected.push({ t: n.time, string: n.string, fret: n.fret, linked });
    }
    const byKey = new Map();
    for (const w of written) {
      const k = `${w.string}/${w.fret}`;
      if (!byKey.has(k)) byKey.set(k, []);
      byKey.get(k).push(w);
    }
    const errs = [];
    const missingList = [];
    for (const e of expected) {
      let best = Infinity;
      for (const w of byKey.get(`${e.string}/${e.fret}`) ?? []) if (!w.tie || e.linked) best = Math.min(best, Math.abs(w.t - e.t));
      if (best > 0.25) missingList.push(e); else errs.push(best * 1000);
    }
    const missing = missingList.length;
    errs.sort((a, b) => a - b);
    if (incomplete) problems.push(`${track.name}: ${incomplete} incomplete bars`);
    if (missing) problems.push(`${track.name}: ${missing} notes not found`);
    return {
      track: track.name, bars: track.staves[0].bars.length, incompleteBars: incomplete,
      notes: expected.length, notFound: missing, missingList,
      onsetErrorMs: { median: +(errs[errs.length >> 1] ?? 0).toFixed(1), p95: +(errs[Math.floor(errs.length * 0.95)] ?? 0).toFixed(1), max: +(errs.at(-1) ?? 0).toFixed(1) },
    };
  });
  return { title: `${song.meta.artist} - ${song.meta.title}`, results, problems };
}

if (process.argv[1] && process.argv[1].endsWith("verify.js")) {
  for (const f of process.argv.slice(2)) {
    const r = verify(fs.readFileSync(f));
    console.log(r.title);
    for (const x of r.results) console.log(`   ${x.track.padEnd(18)} bars ${x.bars} incomplete ${x.incompleteBars}  notes ${x.notes} not found ${x.notFound}  onset error median ${x.onsetErrorMs.median} / p95 ${x.onsetErrorMs.p95} / max ${x.onsetErrorMs.max} ms`);
  }
}
