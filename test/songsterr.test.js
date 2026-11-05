// Songsterr input: hand-written Songsterr-shaped JSON (no real tabs in git); real saved bundles in
// .samples/songsterr/*.json are converted too when present.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import * as alphaTab from "../node_modules/@coderline/alphatab/dist/alphaTab.core.mjs";
import { validateBundle, loadTracks, defaultTrackIndices, trackUrl, trackKind, songsterrLink } from "../src/songsterr/bundle.js";
import { buildAlphaTex } from "../src/songsterr/score.js";
import { playedBars, chooseVideo, syncFromPoints, findStrayPoint, fitVideos, describeVideos } from "../src/songsterr/sync.js";
import { convertSongsterr, inspectSongsterr, songsterrOutputName } from "../src/songsterr/convert.js";
import { detectFormat, mp3Info, m4aInfo, audioInfo } from "../src/songsterr/audio/duration.js";

// ---- fixtures

const note = (fret, string, extra = {}) => ({ fret, string, ...extra });
const beat = (type, notes, extra = {}) => {
  const tuplet = extra.tuplet ?? 1;
  const dots = extra.dots ?? 0;
  let [n, d] = [1, type];
  if (dots === 1) [n, d] = [3, type * 2];
  if (dots === 2) [n, d] = [7, type * 4];
  if (tuplet > 1) [n, d] = [n * 2, d * 3];
  const rest = !notes.length;
  return { notes: rest ? [{ rest: true }] : notes, type, duration: [n, d], ...(rest ? { rest: true } : {}), ...extra };
};
const bar = (beats, extra = {}) => ({ voices: [{ beats }], ...extra });
const restBar = (extra = {}) => bar([beat(1, [])], extra);

function track(measures, { name = "Bass", instrumentId = 34, tuning = [43, 38, 33, 28], ...rest } = {}) {
  return { name, instrumentId, tuning, strings: tuning.length, songId: 1, revisionId: 2, automations: { tempo: [{ measure: 0, position: 0, bpm: 120, type: 4 }] }, measures, ...rest };
}

function bundle(trackDatas, videos, metas) {
  return {
    kind: "psarc2gp-songsterr", version: 1, page: "https://www.songsterr.com/a/wsa/x-s1", savedAt: "2026-11-04T00:00:00Z",
    cdn: "https://cdn.example",
    song: {
      songId: 1, revisionId: 2, image: "v0-abc", artist: "Artist", title: "Title", defaultTrack: 0,
      tracks: metas ?? trackDatas.map((t) => ({ name: t.name, instrumentId: t.instrumentId, tuning: t.tuning, isBassGuitar: t.instrumentId >= 32 && t.instrumentId <= 39, isGuitar: t.instrumentId >= 24 && t.instrumentId <= 31 })),
    },
    videos,
    trackData: trackDatas,
  };
}
const video = (points, extra = {}) => ({ videoId: extra.videoId ?? "vid" + points.length, feature: null, tracks: null, countries: null, points, ...extra });
const evenPoints = (n, sec = 2, start = 0) => Array.from({ length: n }, (_, i) => +(start + i * sec).toFixed(3));

function load(tex) {
  const settings = new alphaTab.Settings();
  settings.core.logLevel = alphaTab.LogLevel.Error;
  return { score: alphaTab.importer.ScoreLoader.loadAlphaTex(tex, settings), settings };
}

// ---- notation

test("durations, dots, tuplets and string numbering (Songsterr string 0 = highest = alphaTex 1)", () => {
  const t = track([
    bar([beat(4, [note(3, 0)]), beat(8, [note(5, 3)], { dots: 1 }), beat(16, [note(0, 1)]),
      beat(8, [note(1, 2)], { tuplet: 3, tupletStart: true }), beat(8, [note(2, 2)], { tuplet: 3 }), beat(8, [], { tuplet: 3, tupletStop: true }),
      beat(4, [note(7, 0), note(7, 1)])]),
  ]);
  const { tex } = buildAlphaTex(bundle([t], []), [{ index: 0, meta: { name: "Bass", instrumentId: 34 }, data: t }]);
  assert.match(tex, /3\.1\.4 5\.4\.8\{d\} 0\.2\.16 1\.3\.8\{tu 3\} 2\.3\.8\{tu 3\} r\.8\{tu 3\} \(7\.1 7\.2\)\.4/);
  assert.match(tex, /\\tuning \(G2 D2 A1 E1\)/); // high to low, as Songsterr lists it
  assert.match(tex, /\\clef bass/);
  const { score } = load(tex);
  const b = score.tracks[0].staves[0].bars[0];
  assert.equal(b.voices[0].beats.reduce((a, x) => a + x.displayDuration, 0), score.masterBars[0].calculateDuration());
  // alphaTab's model counts strings from the lowest: alphaTex 1 (highest) on a 4-string = 4
  assert.equal(b.voices[0].beats[0].notes[0].string, 4);
});

test("mixed-value triplet groups load and fill the bar", () => {
  const t = track([bar([
    beat(1, [note(11, 0)], { tuplet: 3, tupletStart: true }), beat(4, [note(9, 0)], { tuplet: 3 }),
    beat(16, [note(9, 0, { tie: true })], { tuplet: 3 }), beat(8, [note(7, 0)], { tuplet: 3, dots: 1, tupletStop: true }),
  ])], { name: "Lead", instrumentId: 30, tuning: [64, 59, 55, 50, 45, 40] });
  const { tex } = buildAlphaTex(bundle([t], []), [{ index: 0, meta: { name: "Lead", instrumentId: 30 }, data: t }]);
  const { score } = load(tex);
  const beats = score.tracks[0].staves[0].bars[0].voices[0].beats;
  assert.equal(beats.reduce((a, x) => a + x.displayDuration, 0), score.masterBars[0].calculateDuration());
});

test("techniques map to alphaTex effects", () => {
  const t = track([bar([
    beat(8, [note(5, 0, { hp: true })]), beat(8, [note(7, 0, { slide: "shift" })]),
    beat(8, [note(9, 0, { vibrato: true, accentuated: 2 })], { palmMute: true }),
    beat(8, [note(0, 1, { dead: true }), note(3, 2, { ghost: true })]),
    beat(8, [note(12, 0, { harmonic: "natural" })], { letRing: true }), beat(8, [note(5, 0, { slide: "belowlegato" })]),
    beat(32, [note(4, 1)], { graceNote: "onBeat" }),
    beat(8, [note(7, 1, { bend: { tone: 100, points: [{ position: 0, tone: 0 }, { position: 30, tone: 100 }, { position: 60, tone: 100 }] } })]),
    beat(8, [note(7, 1, { staccato: true })], { velocity: "ff" }),
  ])], { name: "Lead", instrumentId: 29, tuning: [64, 59, 55, 50, 45, 40] });
  const warnings = [];
  const { tex } = buildAlphaTex(bundle([t], []), [{ index: 0, meta: { name: "Lead", instrumentId: 29 }, data: t }], { warn: (m) => warnings.push(m) });
  for (const s of ["5.1{h}", "7.1{ss}", "9.1{v hac pm}", "(0.2{x} 3.3{g})", "12.1{nh lr}", "5.1{sib sl}", "4.2.32{gr ob}", "7.2{be (0 0 30 4 60 4)}", "7.2{st}.8{dy ff}"]) {
    assert.ok(tex.includes(s), `${s} in:\n${tex}`);
  }
  assert.deepEqual(warnings, []);
  load(tex); // parses
});

test("bar structure: repeats, sections, time signatures, tempo, anacrusis", () => {
  const t = track([
    bar([beat(8, [])], { signature: [4, 4], marker: { text: "Intro" } }),
    restBar({ repeatStart: true }), restBar({ repeat: 3 }),
    bar([beat(4, []), beat(4, []), beat(4, [])], { signature: [3, 4], marker: { text: "Verse" } }),
  ], { anacrusis: true });
  const { tex } = buildAlphaTex(bundle([t], []), [{ index: 0, meta: { name: "Bass", instrumentId: 34 }, data: t }]);
  const { score, settings } = load(tex);
  assert.equal(score.masterBars[0].isAnacrusis, true);
  assert.equal(score.masterBars[0].calculateDuration(), 480); // an eighth-note pickup
  assert.equal(score.masterBars[1].isRepeatStart, true);
  assert.equal(score.masterBars[2].repeatCount, 3);
  assert.equal(score.masterBars[3].timeSignatureNumerator, 3);
  assert.equal(score.masterBars[0].section.text, "Intro");
  assert.equal(score.masterBars[0].tempoAutomations[0].value, 120);
  assert.deepEqual(playedBars(alphaTab, score, settings).map((p) => `${p.bar}.${p.occurrence}`), ["0.0", "1.0", "2.0", "1.1", "2.1", "1.2", "2.2", "3.0"]);
});

// Autumn Leaves (songsterr.com s463684): tripletFeel "8th" on bar 1 only, swing for the whole song
test("triplet feel carries on until changed", () => {
  const t = track([restBar({ tripletFeel: "8th" }), restBar(), restBar({ tripletFeel: "16th" }), restBar({ tripletFeel: "shuffle?" })]);
  const warnings = [];
  const { tex } = buildAlphaTex(bundle([t], []), [{ index: 0, meta: { name: "Bass", instrumentId: 34 }, data: t }], { warn: (w) => warnings.push(w) });
  const { TripletFeel } = alphaTab.model;
  assert.deepEqual(load(tex).score.masterBars.map((m) => m.tripletFeel), [TripletFeel.Triplet8th, TripletFeel.Triplet8th, TripletFeel.Triplet16th, TripletFeel.Triplet16th]);
  assert.deepEqual(warnings, ['bar 4: triplet feel "shuffle?" isn\'t known; left out']);
});

// shaped like Für Elise (songsterr.com s382321): a repeat from bar 1 with 1st and 2nd endings, the repeat
// sign on the 1st ending, a second repeated section with endings, bar rests stored as whole rests
test("alternate endings: Songsterr's layout plays 1st ending, back, 2nd ending", () => {
  const barRest = (extra = {}) => ({ voices: [{ rest: true, beats: [beat(1, [])] }], rest: true, ...extra });
  const e = (n) => [beat(8, [note(0, 1)]), beat(8, [note(2, 1)]), beat(8, [note(3, 1)])].slice(0, n);
  const t = track([
    bar(e(1), { signature: [1, 8] }),
    bar(e(3), { signature: [3, 8] }),
    bar(e(2), { signature: [1, 4], repeat: 2, alternateEnding: [1] }),
    bar(e(3), { signature: [3, 8], alternateEnding: [2] }),
    bar(e(3), { repeatStart: true }),
    bar(e(3), { repeat: 3, alternateEnding: [1, 2] }),
    bar(e(3), { alternateEnding: [3] }),
    bar(e(3)),
  ], { name: "Treble", instrumentId: 0, tuning: [76, 71, 67, 62, 57, 52] });
  const lower = track(t.measures.map((m, i) => ({ ...barRest(), ...Object.fromEntries(Object.entries(m).filter(([k]) => k !== "voices")), ...(i === 0 ? { clef: "F4" } : {}) })),
    { name: "Bass", instrumentId: 0, tuning: [64, 59, 55, 50, 45, 40] });
  const warnings = [];
  const { tex } = buildAlphaTex(bundle([t, lower], []), [
    { index: 0, meta: { name: "Treble", instrumentId: 0, isPiano: true }, data: t },
    { index: 1, meta: { name: "Bass", instrumentId: 0, isPiano: true }, data: lower },
  ], { warn: (w) => warnings.push(w) });
  assert.deepEqual(warnings, []); // no "repeat end without a start", no short bars from the whole rests
  assert.ok(tex.includes("\\ae (1 2)") && tex.includes("\\clef F4"), tex);
  const { score, settings } = load(tex);
  assert.deepEqual(score.masterBars.map((m) => m.alternateEndings), [0, 0, 1, 2, 0, 3, 4, 0]); // bit flags
  assert.equal(score.tracks[1].staves[0].bars[0].clef, alphaTab.model.Clef.F4);
  assert.deepEqual(playedBars(alphaTab, score, settings).map((p) => p.bar), [0, 1, 2, 0, 1, 3, 4, 5, 4, 5, 4, 6, 7]);
});

test("bar fields that could change the played order stop the conversion", () => {
  const t = track([restBar(), restBar({ direction: "D.S. al Coda" })]);
  assert.throws(() => buildAlphaTex(bundle([t], []), [{ index: 0, meta: { name: "Bass", instrumentId: 34 }, data: t }]), /bar fields psarc2gp doesn't know yet: "direction" \(bar 2\)/);
});

// alphaTab's played order (used for the sync points) follows alternate endings and jumps
test("alphaTab's played order: alternate endings, D.S. al Coda, D.C. al Fine", () => {
  const order = (body) => {
    const { score, settings } = load(`\\track "x"\n${body}`);
    return playedBars(alphaTab, score, settings).map((p) => p.bar);
  };
  assert.deepEqual(order("\\ro r.1 | \\ae 1 r.1 | \\ae 2 \\rc 2 r.1 | r.1"), [0, 1, 0, 2, 3]);
  assert.deepEqual(order("r.1 | \\jump segno r.1 | \\jump dacoda r.1 | \\jump dalsegnoalcoda r.1 | \\jump coda r.1"), [0, 1, 2, 3, 1, 2, 4]);
  assert.deepEqual(order("r.1 | \\jump fine r.1 | \\jump dacapoalfine r.1"), [0, 1, 2, 0, 1]);
});

// ---- sync

test("points map to played bars; the last bar ends at the previous bar's tempo", () => {
  const played = [{ bar: 0, occurrence: 0 }, { bar: 1, occurrence: 0 }, { bar: 1, occurrence: 1 }, { bar: 2, occurrence: 0 }];
  const q = [4, 4, 2]; // bar 2 is 2/4
  const s = syncFromPoints([0.5, 2.5, 4.5, 6.5], played, (i) => q[i]);
  assert.deepEqual(s.flat.map((p) => [p.barIndex, p.barOccurence, p.barPosition, p.millisecondOffset]),
    [[0, 0, 0, 500], [1, 0, 0, 2500], [1, 1, 0, 4500], [2, 0, 0, 6500], [2, 0, 1, 7500]]);
  assert.equal(s.endSeconds, 7.5);
  assert.deepEqual(s.tempos, [120, 120, 120, 120]);
  const shifted = syncFromPoints([0.5, 2.5, 4.5, 6.5], played, (i) => q[i], { offsetMs: -40 });
  assert.equal(shifted.flat[0].millisecondOffset, 460);
  assert.throws(() => syncFromPoints([0, 1, 2], played, (i) => q[i], { writtenCount: 3 + 5 }), /3 sync points for 4 played bars/);
});

test("video choice: default if it fits, else an alternative available everywhere; misfits refused", () => {
  const vids = [
    video(evenPoints(5), { videoId: "def" }),
    video(evenPoints(9), { videoId: "alt-region", feature: "alternative", countries: ["US"] }),
    video(evenPoints(9), { videoId: "alt-all", feature: "alternative", countries: ["All"] }),
    video(evenPoints(9), { videoId: "back", feature: "backing", tracks: [2] }),
  ];
  assert.equal(chooseVideo(vids, "default", 9, 6).videoId, "alt-all");
  assert.equal(chooseVideo(vids, "backing", 9, 6).videoId, "back");
  assert.equal(chooseVideo(vids, "alt-region", 9, 6).videoId, "alt-region");
  assert.throws(() => chooseVideo(vids, "def", 9, 6), /video def has 5 sync points, but this tab revision plays 9 bars/);
  assert.throws(() => chooseVideo(vids, "solo", 9, 6), /no "solo" video fits/);
  assert.throws(() => chooseVideo(vids, "nope", 9, 6), /isn't listed/);
});

test("a stray point that splits one bar is left out; anything less clear is refused", () => {
  const quarters = Array(10).fill(4); // ten 4/4 bars at 2 s each
  const even = evenPoints(10, 2, 0.5);
  const split = [...even.slice(0, 7), 13.5, ...even.slice(7)]; // bar 7 (12.5-14.5) gets a point in its middle
  assert.equal(findStrayPoint(split, quarters), 7);
  // a point a quarter into the bar is just as stray
  assert.equal(findStrayPoint([...even.slice(0, 3), 6.9, ...even.slice(3)], quarters), 3);
  // one more point at the end (an end point, or a bar the tab doesn't have): no bar is split, refused
  assert.equal(findStrayPoint([...even, 20.5], quarters), null);
  // a split somewhere in a song whose tempo is all over the place: refused
  const rubato = [0, 2, 5, 6, 6.5, 9, 10, 13, 14, 17, 19];
  assert.equal(findStrayPoint(rubato, quarters), null);
  // two points too many, or the right count: not this function's business
  assert.equal(findStrayPoint([...split, 22], quarters), null);
  assert.equal(findStrayPoint(even, quarters), null);
  // fitVideos marks it, chooseVideo takes it, the summary says so
  const vids = fitVideos([video(split, { videoId: "stray" }), video(evenPoints(8), { videoId: "old" })], quarters, 10);
  assert.deepEqual(vids.map((v) => [v.videoId, v.fit, v.strayPoint ?? null, v.points.length]), [["stray", "played", 7, 10], ["old", null, null, 8]]);
  assert.equal(chooseVideo(vids, "default", 10, 10).videoId, "stray");
  assert.equal(chooseVideo(describeVideos(vids, 10, 10), "default", 10, 10).videoId, "stray"); // what the web form has
});

test("convert: a video with a stray point syncs every bar from the others, with a warning", async () => {
  const t = track([restBar(), restBar(), restBar(), restBar(), restBar()]);
  const b = bundle([t], [video([0, 2, 4, 5, 6, 8], { videoId: "stray" })]);
  const warnings = [];
  const r = await convertSongsterr(b, { audio: null, onWarning: (w) => warnings.push(w) });
  assert.equal(r.report.video.videoId, "stray");
  assert.equal(r.report.video.strayPoint, 3);
  assert.equal(r.report.syncPoints, 6);
  assert.match(warnings.join("\n"), /point 4 splits played bar 3 \(written bar 3\) in two and was left out/);
  const back = alphaTab.importer.ScoreLoader.loadScoreFromBytes(r.gp, new alphaTab.Settings());
  assert.deepEqual(back.masterBars.map((m) => m.syncPoints?.[0]?.syncPointValue.millisecondOffset), [0, 2000, 4000, 6000, 8000]);
});

test("convert: no video fits → the tab still converts without a recording (no sync points), never with one", async () => {
  const t = track([restBar(), restBar(), restBar()]);
  const b = bundle([t], [video(evenPoints(4), { videoId: "other-revision" })]);
  const warnings = [];
  const r = await convertSongsterr(b, { audio: null, onWarning: (w) => warnings.push(w) });
  assert.equal(r.report.syncPoints, 0);
  assert.equal(r.report.video, null);
  assert.equal(r.meta.videoId, null);
  assert.match(warnings.join("\n"), /no video fits this tab revision .*converted without sync points/);
  const back = alphaTab.importer.ScoreLoader.loadScoreFromBytes(r.gp, new alphaTab.Settings());
  assert.equal(back.masterBars.flatMap((m) => m.syncPoints ?? []).length, 0);
  assert.doesNotMatch(back.notices, /Recording and sync/);
  const audio = { bytes: syntheticMp3(10), format: "mp3", seconds: 10, provider: "file" };
  await assert.rejects(convertSongsterr(b, { audio }), /no video fits/);
  await assert.rejects(convertSongsterr(b, { audio: async () => audio }), /no video fits/);
});

test("convert: repeats synced per pass, negative first point becomes FramePadding, name has the suffix", async () => {
  const t = track([restBar({ repeatStart: true }), restBar({ repeat: 2 }), restBar()]);
  const b = bundle([t], [video(evenPoints(5, 2, -1.5), { videoId: "early" })]);
  const audio = { bytes: syntheticMp3(10), format: "mp3", seconds: 10, provider: "file" };
  const r = await convertSongsterr(b, { audio });
  assert.equal(r.name, "Artist - Title (Songsterr).gp");
  assert.equal(r.report.playedBars, 5);
  assert.equal(r.report.syncPoints, 6);
  const back = alphaTab.importer.ScoreLoader.loadScoreFromBytes(r.gp, new alphaTab.Settings());
  const pts = back.exportFlatSyncPoints().map((p) => [p.barIndex, p.barOccurence, p.barPosition]);
  assert.deepEqual(pts.sort(), [[0, 0, 0], [0, 1, 0], [1, 0, 0], [1, 1, 0], [2, 0, 0], [2, 0, 1]].sort());
  assert.equal(back.backingTrack.rawAudioFile.length, audio.bytes.length);
  const gpif = new TextDecoder().decode(await unzipEntry(r.gp, "Content/score.gpif"));
  assert.match(gpif, /<FramePadding>66150<\/FramePadding>/); // 1.5 s at 44.1 kHz
  assert.ok(back.tracks.every((x) => x.playbackInfo.isMute));
  // Guitar Pro's layout: <Bar> counts played bars, <BarIndex> is the written bar, stored in play order.
  // With alphaTab's own layout (written bar in both), GP8 squeezed the audio into the first bars when a
  // repeat started at bar 1, as here.
  const sync = [...gpif.matchAll(/<Automation><Type>SyncPoint<\/Type>[\s\S]*?<\/Automation>/g)].map(([a]) =>
    ["Bar", "BarIndex", "BarOccurrence", "Position"].map((k) => Number(a.match(new RegExp(`<${k}>([^<]*)</${k}>`))[1])));
  assert.deepEqual(sync, [[0, 0, 0, 0], [1, 1, 0, 0], [2, 0, 1, 0], [3, 1, 1, 0], [4, 2, 0, 0], [4, 2, 0, 1]]);
  const ms = back.exportFlatSyncPoints().sort((x, y) => x.millisecondOffset - y.millisecondOffset).map((p) => Math.round(p.millisecondOffset));
  assert.deepEqual(ms.slice(0, 5), [-1500, 500, 2500, 4500, 6500]);
});

test("sync points in play order: refuses XML it doesn't recognize", async () => {
  const { syncPointsInPlayOrder } = await import("../src/gp/syncpoints.js");
  assert.throws(() => syncPointsInPlayOrder("<GPIF></GPIF>", []), /no <MasterTrack>/);
  const one = '<MasterTrack><Automations><Automation><Type>SyncPoint</Type><Bar>0</Bar><Position>0</Position><Value><BarIndex>3</BarIndex><BarOccurrence>0</BarOccurrence></Value></Automation></Automations></MasterTrack>';
  assert.throws(() => syncPointsInPlayOrder(one, [{ bar: 0, occurrence: 0 }]), /bar 4 pass 1, which isn't played/);
  assert.match(syncPointsInPlayOrder(one, [{ bar: 0, occurrence: 0 }, { bar: 3, occurrence: 0 }]), /<Bar>1<\/Bar>/);
});

test("convert: tracks fetched from the CDN when the bundle doesn't carry them", async () => {
  const t = track([restBar(), restBar()]);
  const b = bundle([t], [video([0, 2])]);
  delete b.trackData;
  const urls = [];
  const fetch = async (url) => { urls.push(url); return { ok: true, status: 200, json: async () => t }; };
  const r = await convertSongsterr(b, { fetch });
  assert.deepEqual(urls, ["https://cdn.example/1/2/v0-abc/0.json"]);
  assert.equal(r.report.bars, 2);
  assert.equal(trackUrl(b, 3), "https://cdn.example/1/2/v0-abc/3.json");
});

test("drums and vocals are not converted yet; default tracks are guitars and basses", async () => {
  const g = track([restBar()], { name: "Gtr", instrumentId: 30, tuning: [64, 59, 55, 50, 45, 40] });
  const metas = [{ name: "Vox", isVocalTrack: true, instrumentId: 54 }, { name: "Gtr", instrumentId: 30 }, { name: "Drums", instrumentId: 1024, isDrums: true }];
  const b = bundle([null, g, null], [video([0])], metas);
  assert.deepEqual(defaultTrackIndices(b), [1]);
  await assert.rejects(convertSongsterr(b, { tracks: [2] }), /is drums/);
  const r = await convertSongsterr(b, {});
  assert.equal(r.report.tracks[0].sound, "distortion");
});

test("bundle validation", () => {
  const ok = bundle([track([restBar()])], [video([0])]);
  assert.equal(validateBundle(ok), ok);
  const bad = (f, re) => { const b = structuredClone(ok); f(b); assert.throws(() => validateBundle(b), re); };
  bad((b) => { b.kind = "x"; }, /kind is "x"/);
  bad((b) => { b.version = 2; }, /version 2/);
  bad((b) => { delete b.song.revisionId; }, /revision id missing/);
  bad((b) => { b.videos[0].points = [1, "2"]; }, /not a list of numbers/);
  bad((b) => { b.videos[0].points = [2, 1]; }, /go backwards/);
  bad((b) => { b.trackData[0].revisionId = 9; }, /revision 9, not 2/);
  bad((b) => { b.trackData = []; }, /doesn't match the track list/);
});

test("output name: suffix keeps it apart from the .psarc version; unsafe characters removed", () => {
  assert.equal(songsterrOutputName({ artist: 'AC/DC', title: 'T.N.T. "live"?' }), "ACDC - T.N.T. live (Songsterr).gp");
  assert.equal(songsterrOutputName({}), "Unknown - Untitled (Songsterr).gp");
});

test("the .gp names its Songsterr page and video in Guitar Pro's Notices", async () => {
  const g = track([restBar(), restBar()], { name: "Gtr", instrumentId: 30, tuning: [64, 59, 55, 50, 45, 40] });
  const b = bundle([g], [video([0, 2], { videoId: "Pb7-ICi-r8Y" }), video([1, 3], { videoId: "KBlpI7YLuKs", feature: "backing" })]);
  b.page = "https://www.songsterr.com/a/wsa/x-bass-tab-s1?utm=y#bar5";
  assert.equal(songsterrLink(b), "https://www.songsterr.com/a/wsa/x-bass-tab-s1");
  const r = await convertSongsterr(b, {});
  assert.equal(r.meta.link, "https://www.songsterr.com/a/wsa/x-bass-tab-s1");
  const score = alphaTab.importer.ScoreLoader.loadScoreFromBytes(r.gp, new alphaTab.Settings());
  assert.equal(score.notices, "Tab: https://www.songsterr.com/a/wsa/x-bass-tab-s1 (revision 2)\nRecording and sync: https://www.youtube.com/watch?v=Pb7-ICi-r8Y");
  const backing = await convertSongsterr(b, { video: "backing" });
  assert.match(alphaTab.importer.ScoreLoader.loadScoreFromBytes(backing.gp, new alphaTab.Settings()).notices, /v=KBlpI7YLuKs \(backing\)$/);
  // no page, or someone else's: the canonical address from the id
  for (const page of [undefined, "https://evil.example/a/wsa/x-s1", "https://www.songsterr.com/a/wsa/other-s99"]) {
    assert.equal(songsterrLink({ page, song: { songId: 514895, artist: "Turnstile", title: "UNDERWATER BOI" } }), "https://www.songsterr.com/a/wsa/turnstile-underwater-boi-tab-s514895");
  }
  assert.equal(songsterrLink({ song: { songId: 7, artist: "Beyoncé", title: "Déjà Vu!" } }), "https://www.songsterr.com/a/wsa/beyonce-deja-vu-tab-s7");
});

// ---- audio duration (synthetic files: frame headers and boxes written here, no real audio)

// MPEG-1 layer III, 128 kbit/s, 44.1 kHz, stereo frames, optionally led by an Info + LAME frame
function syntheticMp3(frames, { info = true, delay = 576, padding = 1000, id3 = true } = {}) {
  const frameLen = 417; // 144 * 128000 / 44100, no padding bit
  const frame = () => { const f = new Uint8Array(frameLen); f.set([0xff, 0xfb, 0x90, 0x00]); return f; };
  const parts = [];
  if (id3) parts.push(Uint8Array.from([0x49, 0x44, 0x33, 4, 0, 0, 0, 0, 0, 10, ...new Array(10).fill(0)]));
  if (info) {
    const f = frame();
    const dv = new DataView(f.buffer);
    const x = 4 + 32;
    f.set([0x49, 0x6e, 0x66, 0x6f], x); // "Info"
    dv.setUint32(x + 4, 1); // frames field only
    dv.setUint32(x + 8, frames);
    const p = x + 12;
    f.set(new TextEncoder().encode("LAME3.100"), p);
    f[p + 21] = delay >> 4; f[p + 22] = ((delay & 15) << 4) | (padding >> 8); f[p + 23] = padding & 255;
    parts.push(f);
  }
  for (let i = 0; i < frames; i++) parts.push(frame());
  const out = new Uint8Array(parts.reduce((a, p) => a + p.length, 0));
  let o = 0;
  for (const p of parts) { out.set(p, o); o += p.length; }
  return out;
}

function box(type, ...children) {
  const body = children.reduce((a, c) => a + c.length, 0);
  const out = new Uint8Array(8 + body);
  new DataView(out.buffer).setUint32(0, 8 + body);
  out.set(new TextEncoder().encode(type), 4);
  let o = 8;
  for (const c of children) { out.set(c, o); o += c.length; }
  return out;
}
const u32 = (...v) => { const b = new Uint8Array(4 * v.length); v.forEach((x, i) => new DataView(b.buffer).setUint32(4 * i, x)); return b; };

test("MP3 duration from the Info/LAME header (delay and padding removed) or by counting frames", () => {
  const withInfo = mp3Info(syntheticMp3(100));
  assert.equal(withInfo.header, "Info");
  assert.equal(withInfo.encoderDelay, 576);
  assert.equal(withInfo.encoderPadding, 1000);
  assert.ok(Math.abs(withInfo.seconds - (100 * 1152 - 1576) / 44100) < 1e-9);
  const counted = mp3Info(syntheticMp3(50, { info: false, id3: false }));
  assert.equal(counted.frames, 50);
  assert.ok(Math.abs(counted.seconds - (50 * 1152) / 44100) < 1e-9);
  assert.equal(detectFormat(syntheticMp3(3, { info: false, id3: false })), "mp3");
});

test("M4A duration from the audio track's mdhd, and refusal of formats Guitar Pro 8 doesn't play", () => {
  const ftyp = box("ftyp", new TextEncoder().encode("M4A "), u32(0));
  const mdhd = box("mdhd", u32(0, 0, 0, 44100, 44100 * 185));
  const hdlr = box("hdlr", u32(0, 0), new TextEncoder().encode("soun"), new Uint8Array(12));
  const moov = box("moov", box("mvhd", u32(0, 0, 0, 1000, 1)), box("trak", box("mdia", mdhd, hdlr)));
  const file = new Uint8Array([...ftyp, ...moov]);
  assert.equal(m4aInfo(file).seconds, 185);
  assert.equal(audioInfo(file).format, "m4a");
  assert.throws(() => audioInfo(Uint8Array.from([0x1a, 0x45, 0xdf, 0xa3, 0, 0, 0, 0, 0, 0, 0, 0])), /webm audio isn't supported: Guitar Pro 8 plays MP3 and M4A/);
  assert.throws(() => audioInfo(new TextEncoder().encode("OggS........")), /ogg audio isn't supported/);
});

// ---- CLI

test("CLI: a bundle needs --audio or --no-audio, then converts; --list-videos lists", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "psarc2gp-songsterr-"));
  try {
    const f = path.join(dir, "song.json");
    fs.writeFileSync(f, JSON.stringify(bundle([track([restBar(), restBar()])], [video([0, 2], { videoId: "abc" })])));
    const cli = path.join(import.meta.dirname, "..", "bin", "psarc2gp.js");
    const env = { ...process.env, PSARC2GP_SECRETS: path.join(dir, "no-secrets.json") };
    delete env.PSARC2GP_PASSWORD; // never fetch real audio from a test
    const run = (...args) => spawnSync(process.execPath, [cli, ...args], { encoding: "utf8", timeout: 20000, env, input: "" });
    let r = run(f);
    assert.equal(r.status, 1);
    assert.match(r.stderr, /--audio <file/);
    r = run("--list-videos", f);
    assert.equal(r.status, 0);
    assert.match(r.stdout, /fits\s+default\s+abc\s+2 points/);
    r = run("--no-audio", f);
    assert.equal(r.status, 0, r.stderr);
    assert.ok(fs.existsSync(path.join(dir, "Artist - Title (Songsterr).gp")));
    r = run("--no-audio", f);
    assert.match(r.stdout, /SKIP/);
    const mp3 = path.join(dir, "a.mp3");
    fs.writeFileSync(mp3, syntheticMp3(200));
    r = run("-f", "--audio", mp3, f);
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /0:05 of audio/);
  } finally {
    fs.rmSync(dir, { recursive: true });
  }
});

// ---- real bundles, when present (git-ignored)

const samples = path.join(import.meta.dirname, "..", ".samples", "songsterr");
const real = fs.existsSync(samples) ? fs.readdirSync(samples).filter((f) => f.endsWith(".json")) : [];
for (const f of real) {
  test(`real bundle ${f}: every bar complete, one sync point per played bar`, async () => {
    const b = JSON.parse(fs.readFileSync(path.join(samples, f), "utf8"));
    // songs without guitar or bass (piano pieces): every track that isn't drums or vocals
    const tracks = defaultTrackIndices(b).length ? null : b.song.tracks.map((t, i) => i).filter((i) => !["drums", "vocals"].includes(trackKind(b.song.tracks[i])));
    const r = await convertSongsterr(b, { tracks });
    // a tab no video fits (all synced to other revisions) converts without sync points
    assert.equal(r.report.syncPoints, r.report.video ? r.report.playedBars + 1 : 0);
    const back = alphaTab.importer.ScoreLoader.loadScoreFromBytes(r.gp, new alphaTab.Settings());
    for (const tr of back.tracks) tr.staves[0].bars.forEach((x, i) => {
      assert.equal(x.voices[0].beats.reduce((a, y) => a + y.displayDuration, 0), back.masterBars[i].calculateDuration(), `${tr.name} bar ${i + 1}`);
    });
    const { played } = await inspectSongsterr(b, { tracks });
    assert.equal(played.length, r.report.playedBars);
  });
}

// minimal zip reader for one stored/deflated entry (test only)
async function unzipEntry(zip, name) {
  const dv = new DataView(zip.buffer, zip.byteOffset, zip.byteLength);
  let p = 0;
  while (dv.getUint32(p, true) === 0x04034b50) {
    const method = dv.getUint16(p + 8, true);
    const size = dv.getUint32(p + 18, true);
    const nameLen = dv.getUint16(p + 26, true);
    const extra = dv.getUint16(p + 28, true);
    const n = new TextDecoder().decode(zip.subarray(p + 30, p + 30 + nameLen));
    const data = zip.subarray(p + 30 + nameLen + extra, p + 30 + nameLen + extra + size);
    if (n === name) {
      if (method === 0) return data;
      const zlib = await import("node:zlib");
      return new Uint8Array(zlib.inflateRawSync(data));
    }
    p += 30 + nameLen + extra + size;
  }
  throw new Error(`${name} not in zip`);
}
