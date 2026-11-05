// End-to-end checks on converted Songsterr songs (the Songsterr counterpart of verify.js).
//   usage: node tools/verify-songsterr.js bundle.json ... [--video <feature | videoId>] [--all-videos] [--tracks 0,1] [--json out.json]
// Each bundle is converted in memory (no audio, nothing written), the .gp is read back with alphaTab, and:
//  - every bar of every track and voice is exactly full
//  - every Songsterr note is in the notation, on its string and fret, at its place in the bar (and nothing extra)
//  - vocals: every syllable of the lyrics under its note (placed by Songsterr's rule, src/songsterr/score.js)
//  - one sync point per played bar (repeats expanded) plus the end point, in play order, times rising,
//    and score.gpif numbering them by played bar the way Guitar Pro 8 reads them (src/gp/syncpoints.js)
//  - the tempo the video's points give each played bar, against the tab's written tempo: a song-wide
//    ratio far from 1 means the wrong video (or a tab marked in half/double time); single bars far from the
//    song's own ratio mean bad points. --all-videos does this for every video that fits the revision.
// Exit code 1 when any song has a problem.
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { convertSongsterr, inspectSongsterr } from "../src/songsterr/convert.js";
import { convertibleTrackIndices } from "../src/songsterr/bundle.js";
import { chooseVideo } from "../src/songsterr/sync.js";
import { placeLyrics } from "../src/songsterr/score.js";
import { readZip, entryData } from "../src/gp/zip.js";
import { utf8 } from "../src/lib/bytes.js";

const require = createRequire(import.meta.url);
const alphaTab = require("@coderline/alphatab");

const WHOLE = 3840; // alphaTab ticks per whole note
const QUARTER = 960;

// Thresholds for the tempo check (video tempo / written tempo)
export const TEMPO = {
  songWide: [0.67, 1.5], // median outside this: probably the wrong video or a half/double-time marking
  bar: [0.5, 2], // one bar against the song's median: a bad point
  uneven: [0.8, 1.25], // reported, not a problem (rubato, ritardando, loose points)
  plausibleBpm: [20, 400],
};

// Every track the converter can take (guitars, basses, drums, vocals, pianos, …), so the check covers
// more than the default selection (as test/songsterr.test.js does)
export function tracksToCheck(bundle) {
  return convertibleTrackIndices(bundle);
}

export async function verifySongsterr(bundle, { video = "default", allVideos = false, tracks, fetch } = {}) {
  tracks ??= tracksToCheck(bundle);
  const problems = [];
  const notes = [];
  const r = await convertSongsterr(bundle, { tracks, video, fetch });
  const { data, played, score: texScore, fitted } = await inspectSongsterr(bundle, { tracks, fetch });
  const back = alphaTab.importer.ScoreLoader.loadScoreFromBytes(r.gp, new alphaTab.Settings());
  if (back.masterBars.length !== r.report.bars) problems.push(`the .gp has ${back.masterBars.length} bars, the tab ${r.report.bars}`);

  // ---- bars and notes, per track
  const trackResults = r.report.tracks.map((t, ti) => {
    const c = checkNotes(data.find((d) => d.index === t.index).data, back.tracks[ti], back.masterBars);
    if (c.incompleteBars) problems.push(`${t.name}: ${c.incompleteBars} incomplete bar(s)`);
    if (c.notFound) problems.push(`${t.name}: ${c.notFound} note(s) not found (first: ${c.missing[0]})`);
    if (c.extra) problems.push(`${t.name}: ${c.extra} note(s) not in the tab (first: ${c.extras[0]})`);
    if (t.kind !== "vocals") return { track: t.name, ...c };
    const l = checkLyrics(data.find((d) => d.index === t.index).data, back.tracks[ti]);
    if (l.wrong) problems.push(`${t.name}: ${l.wrong} syllable(s) missing or misplaced (first: ${l.first})`);
    return { track: t.name, ...c, syllables: l.syllables, lyricsWrong: l.wrong };
  });

  const s = bundle.song;
  const result = (rest) => ({
    title: `${s.artist} - ${s.title}`, revision: s.revisionId, bars: r.report.bars, playedBars: played.length,
    tracks: trackResults, warnings: r.report.warnings, problems, notes, ...rest,
  });
  if (!r.report.video) {
    problems.push(`no video fits this revision (${played.length} played bars; the videos have ${[...new Set(bundle.videos.map((v) => v.points.length))].sort((a, b) => a - b).join(", ")} points): nothing to sync`);
    return result({ syncPoints: 0, video: null, tempo: [] });
  }

  // ---- sync points, as alphaTab reads them back
  const points = new Map(); // "bar:occurrence:ratio" -> ms
  let count = 0;
  back.masterBars.forEach((mb, bar) => {
    for (const a of mb.syncPoints ?? []) {
      count++;
      const k = `${bar}:${a.syncPointValue.barOccurence}:${a.ratioPosition}`;
      if (points.has(k)) problems.push(`two sync points for bar ${bar + 1} pass ${a.syncPointValue.barOccurence + 1}`);
      points.set(k, a.syncPointValue.millisecondOffset);
    }
  });
  if (count !== played.length + 1) problems.push(`${count} sync points for ${played.length} played bars (expected one each, plus the end)`);
  const missingSync = played.filter((p) => !points.has(`${p.bar}:${p.occurrence}:0`));
  if (missingSync.length) problems.push(`${missingSync.length} played bar(s) without a sync point (first: bar ${missingSync[0].bar + 1} pass ${missingSync[0].occurrence + 1})`);
  const last = played.at(-1);
  if (!points.has(`${last.bar}:${last.occurrence}:1`)) problems.push("no end point on the last played bar");
  const times = [...played.map((p) => points.get(`${p.bar}:${p.occurrence}:0`)), points.get(`${last.bar}:${last.occurrence}:1`)];
  const backwards = times.findIndex((t, i) => i && !(t > times[i - 1]));
  if (backwards > 0) problems.push(`sync times don't rise at played bar ${backwards + 1}`);

  // ---- score.gpif: <Bar> is the played-bar number, points stored in play order (what Guitar Pro 8 reads)
  const gpif = utf8(entryData(readZip(r.gp).find((e) => e.name === "Content/score.gpif")));
  const sp = (gpif.match(/<Automation>(?:(?!<\/Automation>)[\s\S])*<Type>SyncPoint<\/Type>[\s\S]*?<\/Automation>/g) ?? []).map((a) => {
    const num = (tag) => Number(a.match(new RegExp(`<${tag}>([^<]*)</${tag}>`))?.[1]);
    return { bar: num("Bar"), index: num("BarIndex"), occurrence: num("BarOccurrence") };
  });
  const badGpif = sp.findIndex((p, i) => {
    const want = played[Math.min(i, played.length - 1)];
    return p.bar !== Math.min(i, played.length - 1) || p.index !== want.bar || p.occurrence !== want.occurrence;
  });
  if (sp.length !== played.length + 1) problems.push(`score.gpif has ${sp.length} sync points, expected ${played.length + 1}`);
  else if (badGpif >= 0) problems.push(`score.gpif: sync point ${badGpif + 1} isn't in Guitar Pro's played-bar layout (Bar ${sp[badGpif].bar}, BarIndex ${sp[badGpif].index}, pass ${sp[badGpif].occurrence + 1})`);

  // ---- tempo: the chosen video, or every video that fits
  const written = writtenSeconds(texScore, played);
  const videos = allVideos
    ? fitted.filter((v) => v.fit === "played")
    : [chooseVideo(fitted, video, played.length, texScore.masterBars.length)];
  const tempo = videos.map((v) => {
    const t = tempoCheck(v.points, written, texScore, played);
    const label = `video ${v.videoId} (${v.feature ?? "default"})`;
    const chosen = v.videoId === r.report.video.videoId;
    const add = (list, m) => list.push(allVideos && !chosen ? `${label}: ${m}` : m);
    // a problem only for the video the .gp uses; for the others it's information (in the table)
    const bad = chosen ? problems : [];
    if (t.implausible.length) add(bad, `${t.implausible.length} played bar(s) at an implausible tempo (first: played bar ${t.implausible[0].k + 1}, ${t.implausible[0].bpm} bpm)`);
    if (!(t.median >= TEMPO.songWide[0] && t.median <= TEMPO.songWide[1])) {
      add(bad, `the video plays at ${pct(t.median)} of the tab's written tempo${near(t.median, 0.5) ? " (half time?)" : near(t.median, 2) ? " (double time?)" : ""}: the wrong video, or a tab tempo marking that's off`);
    }
    if (t.outliers.length) add(bad, `${t.outliers.length} played bar(s) far from the song's tempo, likely bad points (first: played bar ${t.outliers[0].k + 1}, written bar ${t.outliers[0].bar + 1}, ${pct(t.outliers[0].rel)} of the median)`);
    if (t.uneven && chosen) add(notes, `${t.uneven} of ${t.bars} played bars more than 20% off the median tempo`);
    return { videoId: v.videoId, feature: v.feature ?? "default", chosen, strayPoint: v.strayPoint ?? null, ...t, outliers: t.outliers.length, implausible: t.implausible.length };
  });

  return result({ syncPoints: count, video: r.report.video.videoId, tempo });
}

// One track: Songsterr's tab JSON against the track alphaTab read back from the .gp. Notes are matched by
// bar, voice, place in the bar (ticks; grace notes only by bar), string and fret; drum notes by their
// percussion articulation id (Songsterr's `fret`) instead of string and fret.
export function checkNotes(src, track, masterBars) {
  const nStrings = track.staves[0].tuning.length;
  const drums = track.staves[0].isPercussion;
  const articulationId = (n) => (track.percussionArticulations[n.percussionArticulation]?.id ?? n.percussionArticulation);
  let incomplete = 0;
  let expected = 0;
  const want = new Map();
  const got = new Map();
  const add = (m, k) => m.set(k, (m.get(k) ?? 0) + 1);
  src.measures.forEach((m, bi) => {
    (m.voices ?? []).forEach((v, vi) => {
      let at = [0, 1];
      for (const b of v.beats ?? []) {
        const grace = !!b.graceNote;
        const onset = grace ? "g" : Math.round((at[0] / at[1]) * WHOLE);
        for (const n of b.notes ?? []) {
          if (n.rest) continue;
          // Songsterr string 0 = highest; alphaTab's model 1 = lowest
          add(want, drums ? `${bi}/${vi}/${onset}/drum/${Math.round(n.fret)}` : `${bi}/${vi}/${onset}/${nStrings - n.string}/${Math.max(0, Math.round(n.fret ?? 0))}`);
          expected++;
        }
        if (!grace && Array.isArray(b.duration)) at = addFrac(at, b.duration);
      }
    });
  });
  track.staves[0].bars.forEach((bar, bi) => {
    const length = masterBars[bi].calculateDuration();
    bar.voices.forEach((v, vi) => {
      if (v.isEmpty) return;
      if (v.beats.reduce((s, b) => s + b.displayDuration, 0) !== length) incomplete++; // grace notes count 0
      for (const b of v.beats) for (const n of b.notes) {
        const at = b.graceType !== 0 ? "g" : b.displayStart;
        add(got, drums ? `${bi}/${vi}/${at}/drum/${articulationId(n)}` : `${bi}/${vi}/${at}/${n.string}/${n.fret}`);
      }
    });
  });
  const diff = (a, b) => [...a].flatMap(([k, c]) => Array(Math.max(0, c - (b.get(k) ?? 0))).fill(k));
  const where = (k) => {
    const [bar, voice, at, string, fret] = k.split("/");
    return `bar ${+bar + 1}${+voice ? ` voice ${+voice + 1}` : ""} ${at === "g" ? "grace" : `tick ${at}`} ${string === "drum" ? `drum ${fret}` : `string ${string} fret ${fret}`}`;
  };
  const missing = diff(want, got).map(where);
  const extras = diff(got, want).map(where);
  return { bars: track.staves[0].bars.length, incompleteBars: incomplete, notes: expected, notFound: missing.length, extra: extras.length, missing, extras };
}

// Vocals: the syllables the lyrics put on each note of the first voice (bar, tick in the bar, line, text)
// against the lyrics alphaTab read back from the .gp.
export function checkLyrics(src, track) {
  const { placed } = placeLyrics(src.newLyrics, src.measures);
  const want = new Set();
  src.measures.forEach((m, bi) => {
    let at = [0, 1];
    for (const [i, b] of (m.voices?.[0]?.beats ?? []).entries()) {
      const onset = b.graceNote ? "g" : Math.round((at[0] / at[1]) * WHOLE);
      (placed.get(`${bi}/${i}`) ?? []).forEach((s, row) => { if (s) want.add(`${bi}/${onset}/${row}/${s}`); });
      if (!b.graceNote && Array.isArray(b.duration)) at = addFrac(at, b.duration);
    }
  });
  const got = new Set();
  track.staves[0].bars.forEach((bar, bi) => {
    for (const b of bar.voices[0]?.beats ?? []) (b.lyrics ?? []).forEach((s, row) => { if (s) got.add(`${bi}/${b.graceType !== 0 ? "g" : b.displayStart}/${row}/${s}`); });
  });
  const wrong = [...want].filter((k) => !got.has(k)).concat([...got].filter((k) => !want.has(k)));
  const where = (k) => { const [bar, at, row, ...s] = k.split("/"); return `bar ${+bar + 1} tick ${at} line ${+row + 1} "${s.join("/")}"`; };
  return { syllables: want.size, wrong: wrong.length, first: wrong.length ? where(wrong[0]) : null };
}

const gcd = (a, b) => (b ? gcd(b, a % b) : Math.abs(a));
function addFrac([a, b], [c, d]) { const n = a * d + c * b, m = b * d, g = gcd(n, m) || 1; return [n / g, m / g]; }
const pct = (x) => `${Math.round(x * 100)}%`;
const near = (x, y) => Math.abs(Math.log2(x / y)) < 0.15;
const median = (xs) => { const a = [...xs].sort((x, y) => x - y); return a.length ? (a.length % 2 ? a[a.length >> 1] : (a[a.length / 2 - 1] + a[a.length / 2]) / 2) : NaN; };

// Seconds each played bar lasts at the tab's written tempo, following tempo changes in play order
// (mid-bar changes split the bar).
export function writtenSeconds(score, played) {
  let bpm = score.tempo || 120;
  return played.map(({ bar }) => {
    const mb = score.masterBars[bar];
    const quarters = mb.calculateDuration() / QUARTER;
    const changes = [...(mb.tempoAutomations ?? [])].sort((a, b) => a.ratioPosition - b.ratioPosition);
    let sec = 0, at = 0;
    for (const c of changes) {
      sec += ((c.ratioPosition - at) * quarters * 60) / bpm;
      at = c.ratioPosition;
      bpm = c.value;
    }
    return sec + ((1 - at) * quarters * 60) / bpm;
  });
}

// The video's tempo per played bar against the written tempo. The last played bar has no end point (its
// length is derived from the bar before), so it isn't judged.
export function tempoCheck(points, written, score, played) {
  const rows = [];
  for (let k = 0; k + 1 < points.length; k++) {
    const sec = points[k + 1] - points[k];
    const quarters = score.masterBars[played[k].bar].calculateDuration() / QUARTER;
    rows.push({ k, bar: played[k].bar, sec, bpm: sec > 0 ? Math.round((60 * quarters) / sec) : Infinity, rel: sec > 0 ? written[k] / sec : Infinity });
  }
  const ok = rows.filter((x) => isFinite(x.rel));
  const m = median(ok.map((x) => x.rel));
  const within = (x, [lo, hi]) => x >= lo && x <= hi;
  return {
    bars: rows.length,
    median: +m.toFixed(3),
    implausible: rows.filter((x) => !within(x.bpm, TEMPO.plausibleBpm)),
    outliers: ok.filter((x) => !within(x.rel / m, TEMPO.bar)),
    uneven: ok.filter((x) => !within(x.rel / m, TEMPO.uneven)).length,
  };
}

if (process.argv[1] && process.argv[1].endsWith("verify-songsterr.js")) {
  const args = process.argv.slice(2);
  const take = (flag) => { const i = args.indexOf(flag); return i >= 0 ? args.splice(i, 2)[1] : null; };
  const flag = (f) => { const i = args.indexOf(f); if (i >= 0) args.splice(i, 1); return i >= 0; };
  const video = take("--video") ?? "default";
  const jsonPath = take("--json");
  const tracksArg = take("--tracks");
  const allVideos = flag("--all-videos");
  const results = [];
  for (const f of args) {
    let r;
    try {
      const bundle = JSON.parse(fs.readFileSync(f, "utf8"));
      r = await verifySongsterr(bundle, { video, allVideos, tracks: tracksArg ? tracksArg.split(",").map(Number) : undefined });
    } catch (err) {
      r = { file: f, error: err.message, problems: [err.message] };
      console.log(`${path.basename(f)}\n   ERROR ${err.message}`);
      results.push(r);
      continue;
    }
    r.file = f;
    results.push(r);
    console.log(`${r.title} (revision ${r.revision}): ${r.bars} bars, ${r.playedBars} played, ${r.syncPoints} sync points${r.video ? `, video ${r.video}` : ""}`);
    for (const t of r.tracks) console.log(`   ${t.track.padEnd(22)} bars ${t.bars} incomplete ${t.incompleteBars}  notes ${t.notes} not found ${t.notFound} extra ${t.extra}${t.syllables != null ? `  syllables ${t.syllables} misplaced ${t.lyricsWrong}` : ""}`);
    for (const t of r.tempo) console.log(`   ${t.chosen ? "*" : " "} tempo ${t.videoId} ${t.feature.padEnd(11)}${t.strayPoint != null ? ` (point ${t.strayPoint + 1} left out)` : ""} video/tab ${pct(t.median).padStart(4)}  bad points ${t.outliers}  implausible ${t.implausible}  uneven ${t.uneven}/${t.bars}`);
    for (const w of r.warnings) console.log(`   warning: ${w}`);
    for (const n of r.notes) console.log(`   note: ${n}`);
    for (const p of r.problems) console.log(`   PROBLEM: ${p}`);
  }
  if (jsonPath) fs.writeFileSync(jsonPath, JSON.stringify(results, null, 1));
  const bad = results.filter((r) => r.problems.length);
  if (results.length > 1) console.log(`\n${results.length} songs: ${results.length - bad.length} ok, ${bad.length} with problems`);
  if (bad.length) process.exitCode = 1;
}
