// tools/verify-songsterr.js: its checks pass on a clean conversion and catch what they're for
// (a lost note, a moved syllable, a half-time video, a bad point). Real bundles in .samples/songsterr/ are checked when present.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { verifySongsterr, checkNotes, checkLyrics, tempoCheck, writtenSeconds } from "../tools/verify-songsterr.js";
import { convertSongsterr, inspectSongsterr } from "../src/songsterr/convert.js";

const require = createRequire(import.meta.url);
const alphaTab = require("@coderline/alphatab");

const note = (fret, string, extra = {}) => ({ fret, string, ...extra });
const beat = (type, notes, extra = {}) => {
  const tuplet = extra.tuplet ?? 1;
  let [n, d] = [1, type];
  if (tuplet > 1) [n, d] = [n * 2, d * 3];
  const rest = !notes.length;
  return { notes: rest ? [{ rest: true }] : notes, type, duration: extra.graceNote ? [1, 32] : [n, d], ...(rest ? { rest: true } : {}), ...extra };
};
const tuning = [64, 59, 55, 50, 45, 40];

// 4/4 at 120 bpm (2 s a bar), bars 1-2 repeated from the first bar, then bar 3: 5 played bars
function song() {
  const measures = [
    { repeatStart: true, voices: [
      { beats: [beat(4, [note(3, 5)]), beat(8, [note(5, 4)], { tuplet: 3 }), beat(8, [note(7, 4)], { tuplet: 3 }), beat(8, [note(5, 4)], { tuplet: 3 }),
        beat(32, [note(2, 3)], { graceNote: "beforeBeat" }), beat(2, [note(4, 3), note(5, 2)])] },
      { beats: [beat(2, [note(0, 0)]), beat(2, [])] },
    ] },
    { repeat: 2, voices: [{ beats: [beat(1, [note(0, 5)])] }] },
    { voices: [{ beats: [beat(2, [note(12, 0, { tie: false })]), beat(2, [note(12, 0, { tie: true })])] }] },
  ];
  const data = { name: "Guitar", instrumentId: 29, tuning, songId: 1, revisionId: 2, automations: { tempo: [{ measure: 0, position: 0, bpm: 120, type: 4 }] }, measures };
  return {
    kind: "psarc2gp-songsterr", version: 1, page: "https://www.songsterr.com/a/wsa/x-s1", cdn: "https://cdn.example",
    song: { songId: 1, revisionId: 2, image: "v0", artist: "Artist", title: "Title", tracks: [{ name: "Guitar", instrumentId: 29, tuning, isGuitar: true }] },
    videos: [
      { videoId: "ontime", feature: null, points: [0.5, 2.5, 4.5, 6.5, 8.5] },
      { videoId: "halftime", feature: "alternative", points: [0.5, 4.5, 8.5, 12.5, 16.5] },
      { videoId: "badpoint", feature: "backing", points: [0.5, 2.5, 7.5, 8.5, 10.5] },
    ],
    trackData: [data],
  };
}

test("a clean conversion passes every check", async () => {
  const r = await verifySongsterr(song());
  assert.deepEqual(r.problems, []);
  assert.equal(r.playedBars, 5);
  assert.equal(r.syncPoints, 6);
  assert.equal(r.tracks[0].notes, 11); // bar 1: 7 + 1 in voice 2, bar 2: 1, bar 3: 2
  assert.equal(r.tracks[0].notFound + r.tracks[0].extra + r.tracks[0].incompleteBars, 0);
  assert.equal(r.tempo[0].median, 1);
});

test("a note lost or moved in the .gp is reported", async () => {
  const b = song();
  const { gp } = await convertSongsterr(b);
  const back = alphaTab.importer.ScoreLoader.loadScoreFromBytes(gp, new alphaTab.Settings());
  const beats = back.tracks[0].staves[0].bars[0].voices[0].beats;
  beats[0].notes[0].fret = 4; // 3 → 4 on the low E
  const c = checkNotes(b.trackData[0], back.tracks[0], back.masterBars);
  assert.equal(c.notFound, 1);
  assert.equal(c.extra, 1);
  assert.match(c.missing[0], /bar 1 tick 0 string 1 fret 3/);
});

test("vocals: a syllable missing or on the wrong note in the .gp is reported", async () => {
  const b = song();
  Object.assign(b.song.tracks[0], { name: "Vox", isVocalTrack: true, isGuitar: false });
  b.trackData[0].newLyrics = [{ line: 1, offset: 1, text: "one two-three four five six seven eight" }];
  const r = await verifySongsterr(b);
  assert.deepEqual(r.problems, []);
  assert.equal(r.tracks[0].syllables, 8); // the tied note in bar 3 gets none
  const back = alphaTab.importer.ScoreLoader.loadScoreFromBytes((await convertSongsterr(b, { tracks: [0] })).gp, new alphaTab.Settings());
  const beats = back.tracks[0].staves[0].bars[0].voices[0].beats;
  [beats[1].lyrics, beats[2].lyrics] = [beats[2].lyrics, beats[1].lyrics];
  const c = checkLyrics(b.trackData[0], back.tracks[0]);
  assert.equal(c.wrong, 4);
  assert.match(c.first, /bar 1 tick 960 line 1 "two-"/);
});

test("a half-time video and a bad point are problems for the video the .gp uses", async () => {
  const half = await verifySongsterr(song(), { video: "halftime" });
  assert.ok(half.problems.some((p) => /50% of the tab's written tempo \(half time\?\)/.test(p)), half.problems.join("\n"));
  const bad = await verifySongsterr(song(), { video: "badpoint" });
  assert.ok(bad.problems.some((p) => /far from the song's tempo, likely bad points \(first: played bar 2/.test(p)), bad.problems.join("\n"));
  // --all-videos lists them all, but only the chosen video's numbers are problems
  const all = await verifySongsterr(song(), { allVideos: true });
  assert.deepEqual(all.problems, []);
  assert.deepEqual(all.tempo.map((t) => [t.videoId, t.median]), [["ontime", 1], ["halftime", 0.5], ["badpoint", 1]]);
  assert.equal(all.tempo.find((t) => t.videoId === "badpoint").outliers, 1);
});

test("written seconds follow tempo changes in play order, mid-bar ones too", async () => {
  const b = song();
  b.trackData[0].automations.tempo.push({ measure: 1, position: 2, bpm: 60, type: 4 });
  const { score, played } = await inspectSongsterr(b);
  // bar 1 at 120 (2 s); bar 2 half at 120, half at 60 (1 + 2 s); bar 1's own marking sets 120 again on
  // the second pass; bar 3 carries the 60 (4 s)
  assert.deepEqual(writtenSeconds(score, played), [2, 3, 2, 3, 4]);
  const t = tempoCheck([0, 2, 5, 7, 10], writtenSeconds(score, played), score, played);
  assert.equal(t.median, 1);
  assert.equal(t.outliers.length, 0);
});

const samples = path.join(import.meta.dirname, "..", ".samples", "songsterr");
const real = fs.existsSync(samples) ? fs.readdirSync(samples).filter((f) => f.endsWith(".json")) : [];
for (const f of real) {
  test(`real bundle ${f}: every note found, sync in Guitar Pro's layout`, async () => {
    const r = await verifySongsterr(JSON.parse(fs.readFileSync(path.join(samples, f), "utf8")));
    for (const t of r.tracks) assert.equal(t.notFound + t.extra + t.incompleteBars, 0, `${t.track}: ${[...t.missing, ...t.extras].slice(0, 3).join("; ")}`);
    // tempo flags and videos synced to other revisions are about Songsterr's points, not the conversion
    assert.deepEqual(r.problems.filter((p) => !/tempo|no video fits/.test(p)), []);
  });
}
