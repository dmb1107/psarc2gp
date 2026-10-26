import test from "node:test";
import assert from "node:assert/strict";
import { buildTimeline, syncPoints, TPQ } from "../src/notation/timeline.js";
import { convertArrangement } from "../src/notation/arrangement.js";
import { NoteMask as M } from "../src/rocksmith/sng.js";

// beat grid helper: `bars` bars of `num` beats at `bpm`, starting at `start` seconds
function grid(bars, num, bpm, start = 0) {
  const beats = [];
  const spb = 60 / bpm;
  for (let m = 0; m < bars; m++) for (let b = 0; b < num; b++) beats.push({ time: start + (m * num + b) * spb, measure: m + 1, beat: b });
  return beats;
}

function note(time, string, fret, extra = {}) {
  return { time, string, fret, sustain: 0, mask: M.SINGLE, chordId: -1, chordNotesId: -1, slideTo: -1, slideUnpitchTo: -1, vibrato: 0, bends: [], tap: -1, slap: -1, pluck: -1, ...extra };
}

const bass = (notes) => ({ isBass: true, tuning: [0, 0, 0, 0, 0, 0], centOffset: 0, notes, sng: { chords: [], chordNotes: [] } });

test("measures, ticks and per-beat sync points", () => {
  const ms = buildTimeline(grid(3, 4, 120), []);
  assert.equal(ms.length, 3);
  assert.equal(ms[0].ticks, 4 * TPQ);
  assert.equal(ms[1].startTick, 4 * TPQ);
  assert.equal(ms[0].tempo, 120);
  const sp = syncPoints(ms);
  assert.equal(sp.length, 3 * 4 + 1);
  assert.deepEqual(sp[5], { bar: 1, ratio: 0.25, ms: 2500 });
  assert.equal(sp.at(-1).ms, 6000);
});

test("time-signature events supply the denominator", () => {
  const beats = grid(2, 6, 180);
  const ms = buildTimeline(beats, [{ time: 0, name: "TS:6/8" }]);
  assert.deepEqual(ms[0].display, { num: 6, den: 8 });
  assert.equal(ms[0].beatTicks, TPQ / 2);
});

test("a late first beat gets pre-roll bars so the score starts with the audio", () => {
  const ms = buildTimeline(grid(4, 4, 120, 4.0), []);
  assert.equal(ms.length, 6, "two 2-second bars of pre-roll");
  assert.ok(ms[0].preRoll && ms[1].preRoll);
  assert.equal(syncPoints(ms)[0].ms, 0);
});

test("a one-beat empty lead-in bar becomes a normal rest bar", () => {
  const beats = [{ time: 0, measure: 1, beat: 0 }, ...grid(2, 4, 120, 5).map((b) => ({ ...b, measure: b.measure + 1 }))];
  const ms = buildTimeline(beats, [{ time: 0, name: "TS:1/1" }, { time: 5, name: "TS:4/4" }], { anyNotesIn: () => false });
  assert.ok(ms[0].leadIn);
  assert.deepEqual(ms[0].display, { num: 4, den: 4 });
});

test("straight 16ths, dotted values, ties and rests", () => {
  const ms = buildTimeline(grid(1, 4, 120), []);
  // beat = 0.5 s: notes on 1 (held 0.6 beat), the "a" of 1, and 3 (held 0.8 beat, then silence)
  const arr = bass([note(0, 1, 5, { sustain: 0.3 }), note(0.375, 1, 7), note(1.0, 0, 3, { sustain: 0.4 })]);
  const { bars } = convertArrangement(arr, ms);
  // a held note stopping within a beat of the next note is held to it; an unsustained note fills to
  // the next note; a sustain ending more than a beat before the next event leaves a rest
  assert.equal(bars[0], "5.3.8{d} 7.3.16 7.3{t}.4 3.4.8{d} r.16 r.4");
});

test("8th-note triplets are written as uniform triplet values", () => {
  const ms = buildTimeline(grid(1, 4, 120), []);
  const t = 0.5 / 3;
  const arr = bass([note(0, 0, 1), note(t, 0, 2), note(2 * t, 0, 3), note(0.5, 0, 5, { sustain: 1.4 })]);
  const { bars } = convertArrangement(arr, ms);
  assert.match(bars[0], /^1\.4\.8\{tu 3\} 2\.4\.8\{tu 3\} 3\.4\.8\{tu 3\} 5\.4\.2\{d\}$/);
});

test("sustains that cross the bar line are tied into the next bar", () => {
  const ms = buildTimeline(grid(2, 4, 120), []);
  const arr = bass([note(1.0, 0, 3, { sustain: 2.0 })]);
  const { bars } = convertArrangement(arr, ms);
  assert.equal(bars[0], "r.2 3.4.2");
  assert.equal(bars[1], "3.4{t}.2 r.2");
});

test("hammer-ons mark the origin note; quick slides into a note become grace notes", () => {
  const ms = buildTimeline(grid(1, 4, 120), []);
  const arr = bass([
    note(0, 1, 5), note(0.25, 1, 7, { mask: M.SINGLE | M.HAMMER_ON }),
    note(1.0, 2, 5, { mask: M.SINGLE | M.SLIDE | M.PARENT, slideTo: 6 }), note(1.03, 2, 6, { mask: M.SINGLE | M.CHILD, sustain: 0.4 }),
  ]);
  const { bars, stats } = convertArrangement(arr, ms);
  assert.equal(stats.graceNotes, 1);
  assert.equal(bars[0], "5.3{h}.8 7.3.8 7.3{t}.4 5.2{sl}.64{gr ob} 6.2.8{d} r.16 r.4");
});

test("extended-range charts (cent offset -1200) get their real tuning", async () => {
  const { tuningOf } = await import("../src/notation/arrangement.js");
  assert.deepEqual(tuningOf({ isBass: true, tuning: [7, 7, 7, 7, 7, 7], centOffset: -1200 }), [23, 28, 33, 38]); // B0 E1 A1 D2
});
