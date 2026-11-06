// Songsterr video sync points -> alphaTab sync points.
//
// Songsterr gives one point per *played* bar: the bar's start time in the video, in seconds, with no end
// point for the last bar. A video only fits a tab revision when it has exactly one point per played bar;
// many listed videos were synced to older revisions and are unusable (never stretched to fit).
//
// The played-bar order is taken from alphaTab itself (its MIDI generator walks repeats, alternate
// endings and D.C./D.S./coda/fine jumps the way playback does), so the points land on exactly the bar
// occurrences alphaTab and Guitar Pro play.

// [{ bar, occurrence }] in playback order, from alphaTab's MIDI generator
export function playedBars(alphaTab, score, settings) {
  const midi = new alphaTab.midi.MidiFile();
  const gen = new alphaTab.midi.MidiFileGenerator(score, settings, new alphaTab.midi.AlphaSynthMidiFileHandler(midi));
  gen.generate();
  const seen = new Map();
  return gen.tickLookup.masterBars.map((l) => {
    const bar = l.masterBar.index;
    const occurrence = seen.get(bar) ?? 0;
    seen.set(bar, occurrence + 1);
    return { bar, occurrence };
  });
}

// How a video's point count relates to the tab: "played" (one per played bar, the normal case),
// "written" (one per written bar, only meaningful when they differ), or null (doesn't fit). A video
// already fitted by fitVideos (or described by describeVideos) keeps its fit.
const pointCount = (v) => (Array.isArray(v.points) ? v.points.length : v.points);
// A video whose points go backwards has a mistake in Songsterr's timings (s421905's backing video
// 2VCQhkaRRNY: 130.98 s between 65.34 and 69.78): it doesn't fit, and it isn't repaired (that would be
// guessing a bar's time). Returns the index of the first point earlier than the one before it, or null.
export function backwardsAt(video) {
  if (!Array.isArray(video.points)) return video.backwardsAt ?? null; // described (describeVideos)
  const i = video.points.findIndex((t, k) => k > 0 && t < video.points[k - 1]);
  return i > 0 ? i : null;
}
export function fitOf(video, playedCount, writtenCount) {
  if (video.fit !== undefined) return video.fit;
  if (backwardsAt(video) !== null) return null;
  const n = pointCount(video);
  if (n === playedCount) return "played";
  if (n === writtenCount) return "written";
  return null;
}

// One point too many: a video synced to this revision can carry a stray point that splits a bar in two
// (Come As You Are, s14: bar 107 got two ~1 s points where every bar takes ~2 s). Returns the index of
// the point to leave out, or null. Only when the evidence is unambiguous: leaving out exactly one point
// makes every played bar's tempo plausible (within 50-200% of the song's median, the verifier's "bad
// point" limit), the bar it rejoins comes out within 80-125% of the median, and no other point does the
// same. Never a stretch: the remaining points are used as they are.
//   quarters[k]: written length in quarter notes of played bar k (playback order)
export function findStrayPoint(points, quarters) {
  if (points.length !== quarters.length + 1 || quarters.length < 4) return null;
  const median = (xs) => { const a = [...xs].sort((x, y) => x - y); return a.length % 2 ? a[a.length >> 1] : (a[a.length / 2 - 1] + a[a.length / 2]) / 2; };
  const found = [];
  for (let j = 1; j < points.length - 1; j++) {
    const p = points.filter((_, i) => i !== j);
    // seconds per quarter note of each played bar but the last (which has no end point)
    const spq = quarters.slice(0, -1).map((q, k) => (p[k + 1] - p[k]) / q);
    if (spq.some((x) => !(x > 0))) continue;
    const m = median(spq);
    const rejoined = spq[j - 1] / m;
    if (rejoined < 0.8 || rejoined > 1.25) continue;
    if (spq.every((x) => x / m >= 0.5 && x / m <= 2)) found.push(j);
  }
  return found.length === 1 ? found[0] : null;
}

// Empty bars at the end: Songsterr's sync stops at the last bar with a note, so a tab ending in bars of
// rests on every track has videos with one point per played bar up to there (Kerosene!, s676767: 102
// bars, notes up to bar 80 on every track, all five videos 80 points). Returns the number of written
// bars to keep, or null. Only when the evidence is unambiguous: the tracks given are all the song's
// tracks with notes (the caller loads them), the bars after the last note are empty on every one, hold
// no repeat or alternate ending, and are played once each at the very end; and a video has exactly one
// point per played bar before them. The bars left out are rests only; nothing is stretched.
//   tracks: track JSON of every track with notes; played: playback order of the whole tab
export function emptyTail(tracks, played, videos) {
  const written = tracks[0]?.measures.length ?? 0;
  const hasNote = (m) => m.voices?.some((v) => v.beats?.some((b) => !b.rest && b.notes?.some((n) => !n.rest)));
  let last = -1;
  for (const t of tracks) for (let i = t.measures.length - 1; i > last; i--) if (hasNote(t.measures[i])) { last = i; break; }
  const keep = last + 1;
  if (keep < 1 || keep >= written) return null;
  const structural = (m) => m.repeatStart || m.repeat || m.alternateEnding !== undefined;
  if (tracks.some((t) => t.measures.slice(keep).some(structural))) return null;
  const tail = written - keep;
  const end = played.slice(-tail);
  if (played.length <= tail || end.some((p, k) => p.bar !== keep + k || p.occurrence !== 0)) return null;
  if (played.slice(0, -tail).some((p) => p.bar >= keep)) return null;
  const want = played.length - tail;
  return videos.some((v) => pointCount(v) === want) ? keep : null;
}

// The recording goes on after the tab's last bar (an ending the tab doesn't write out, or the bars
// emptyTail left out): Guitar Pro and the player stop at the score's end, so rest bars are added until the
// recording ends. Returns their start times in video seconds (one per added bar, in the last bar's time
// signature), or []. They're timed at the song's closing tempo: the median seconds per quarter note of
// the last eight played bars. Only rests, so there's no note to be out of sync; the tab's own bars keep
// the video's points.
//   points: one per played bar; lastEnd: the end of the last bar (syncFromPoints' endSeconds), video time;
//   audioEnd: where the recording ends, in video time (its length minus the provider's offset)
export function restBarsUntil(points, played, barQuarters, lastEnd, audioEnd) {
  const n = played.length;
  if (points.length !== n || n < 2 || !(audioEnd > lastEnd)) return [];
  const spq = [];
  for (let k = Math.max(0, n - 9); k < n - 1; k++) spq.push((points[k + 1] - points[k]) / barQuarters(played[k].bar));
  spq.sort((a, b) => a - b);
  const m = spq.length % 2 ? spq[spq.length >> 1] : (spq[spq.length / 2 - 1] + spq[spq.length / 2]) / 2;
  const barSec = m * barQuarters(played[n - 1].bar);
  if (!(barSec > 0)) return [];
  // a remainder under a tenth of a bar (the recording's last fade, or rounding) gets no bar of its own
  const count = Math.min(Math.ceil((audioEnd - lastEnd) / barSec - 0.1), 1000);
  return Array.from({ length: Math.max(count, 0) }, (_, i) => lastEnd + i * barSec);
}

// A few bars short at the end: Songsterr's timings can stop before the tab's last bars, which still have
// notes (Money, s476662, revision 9740688: 97 bars at a steady 102 bpm, notes to bar 97 on the drums; all
// 34 videos have 95 points, following the tab's tempo to bar 95). The user's decision (2026-11-06): those
// bars follow at the song's closing tempo, as the rest bars after a tab do (restBarsUntil). Returns the
// points with one added per untimed bar, or null. Only when: at most MAX_UNTIMED_END bars lack a point;
// they are the tab's last written bars, each played once at the very end (no repeat reaches them); and
// every timed bar's tempo is plausible (50-200% of the median, the verifier's "bad point" limit). The
// timed bars keep the video's points; nothing is stretched. It can't prove the missing bars are the last
// ones (a revision that added bars in the middle would look the same), hence a last resort: only when no
// video fits otherwise (inspectSongsterr), and always with a warning.
//   quarters[k]: written length in quarter notes of played bar k; played: playback order
export const MAX_UNTIMED_END = 4;
export function untimedEnd(points, quarters, played) {
  const n = points.length;
  const missing = quarters.length - n;
  if (!played || missing < 1 || missing > MAX_UNTIMED_END || n < 8 || backwardsAt({ points }) !== null) return null;
  const written = Math.max(...played.map((p) => p.bar)) + 1;
  const first = written - missing;
  if (played.slice(-missing).some((p, k) => p.bar !== first + k || p.occurrence !== 0)) return null;
  if (played.slice(0, -missing).some((p) => p.bar >= first)) return null;
  const median = (xs) => { const a = [...xs].sort((x, y) => x - y); return a.length % 2 ? a[a.length >> 1] : (a[a.length / 2 - 1] + a[a.length / 2]) / 2; };
  const spq = quarters.slice(0, n - 1).map((q, k) => (points[k + 1] - points[k]) / q);
  if (spq.some((x) => !(x > 0))) return null;
  const m = median(spq);
  if (!spq.every((x) => x / m >= 0.5 && x / m <= 2)) return null;
  // the closing tempo: the median of the last eight timed bars
  const closing = median(spq.slice(-8));
  const out = [...points];
  for (let k = n; k < quarters.length; k++) out.push(out[k - 1] + quarters[k - 1] * closing);
  return out;
}

// The videos with their fit; a video with one stray point (findStrayPoint) fits with that point left
// out: { ...video, points (without it), fit: "played", strayPoint: its index in the original list }.
// With { played }, a video a few bars short at the end (untimedEnd) fits with points added for them:
// { ...video, points (with them), fit: "played", untimedEnd: how many }.
export function fitVideos(videos, quarters, writtenCount, { played = null } = {}) {
  return videos.map((v) => {
    const fit = fitOf(v, quarters.length, writtenCount);
    if (fit || backwardsAt(v) !== null) return { ...v, fit };
    const j = findStrayPoint(v.points, quarters);
    if (j !== null) return { ...v, points: v.points.filter((_, i) => i !== j), fit: "played", strayPoint: j };
    const longer = untimedEnd(v.points, quarters, played);
    if (longer) return { ...v, points: longer, fit: "played", untimedEnd: longer.length - v.points.length };
    return { ...v, fit: null };
  });
}

export function describeVideos(videos, playedCount, writtenCount) {
  return videos.map((v) => ({
    videoId: v.videoId,
    feature: v.feature ?? "default",
    leavesOut: v.tracks ?? null, // backing videos name the tracks they leave out
    countries: v.countries ?? null,
    points: pointCount(v),
    fit: fitOf(v, playedCount, writtenCount),
    strayPoint: v.strayPoint ?? null,
    untimedEnd: v.untimedEnd ?? null,
    backwardsAt: backwardsAt(v),
  }));
}

// Pick the video: "default" (Songsterr's default if it fits, else an alternative available everywhere,
// else any fitting alternative), a feature ("backing", "solo", "playthrough", "alternative"), or a
// YouTube video id. Throws when nothing fits, listing what there is.
export function chooseVideo(videos, want, playedCount, writtenCount) {
  const fits = (v) => fitOf(v, playedCount, writtenCount) !== null;
  const everywhere = (v) => !v.countries || v.countries.includes("All");
  let pick = null;
  want = want || "default";
  if (want === "default") {
    // Songsterr's own video has no feature (described videos say "default")
    pick = videos.find((v) => (!v.feature || v.feature === "default") && fits(v))
      ?? videos.find((v) => v.feature === "alternative" && everywhere(v) && fits(v))
      ?? videos.find((v) => v.feature === "alternative" && fits(v));
  } else if (["backing", "solo", "playthrough", "alternative"].includes(want)) {
    pick = videos.find((v) => v.feature === want && everywhere(v) && fits(v)) ?? videos.find((v) => v.feature === want && fits(v));
  } else {
    const v = videos.find((x) => x.videoId === want);
    if (!v) throw new Error(`video ${want} isn't listed for this song`);
    const back = backwardsAt(v);
    if (back !== null) throw new Error(`video ${want}'s sync points go backwards at point ${back + 1} (a mistake in Songsterr's timings), so it can't be used`);
    if (!fits(v)) throw new Error(`video ${want} has ${pointCount(v)} sync points, but this tab revision plays ${playedCount} bars: it was synced to another revision`);
    pick = v;
  }
  if (!pick) {
    const usable = videos.filter(fits).length;
    throw new Error(`no ${want === "default" ? "" : `"${want}" `}video fits this tab revision (${playedCount} played bars; ` +
      `${videos.length} videos listed, ${usable} usable)`);
  }
  return pick;
}

// Flat sync points (alphaTab's applyFlatSyncPoints format) for a video, plus the numbers the report and
// the checks need. offsetMs shifts every point (an audio source's measured offset).
//   barQuarters(i): written length of bar i in quarter notes
export function syncFromPoints(points, played, barQuarters, { writtenCount, offsetMs = 0 } = {}) {
  let pairs;
  if (points.length === played.length) {
    pairs = played.map((p, k) => ({ ...p, t: points[k] }));
  } else if (points.length === writtenCount) {
    // one point per written bar: only first passes get one; repeats follow the bar's tempo
    pairs = played.filter((p) => p.occurrence === 0).map((p) => ({ ...p, t: points[p.bar] }));
    pairs.sort((a, b) => a.t - b.t);
  } else {
    throw new Error(`${points.length} sync points for ${played.length} played bars`);
  }
  const flat = pairs.map((p) => ({ barIndex: p.bar, barOccurence: p.occurrence, barPosition: 0, millisecondOffset: p.t * 1000 + offsetMs }));

  // the last played bar has no end point: give it its written length at the previous bar's audio tempo
  const last = pairs[pairs.length - 1];
  let end;
  if (pairs.length >= 2) {
    const prev = pairs[pairs.length - 2];
    const secPerQuarter = (last.t - prev.t) / barQuarters(prev.bar);
    end = last.t + barQuarters(last.bar) * secPerQuarter;
  } else {
    end = last.t + barQuarters(last.bar) * 0.5; // a one-bar song: assume 120 bpm
  }
  flat.push({ barIndex: last.bar, barOccurence: last.occurrence, barPosition: 1, millisecondOffset: end * 1000 + offsetMs });

  // implied quarter-note tempo of each played bar (for the report and sanity checks)
  const tempos = pairs.map((p, k) => {
    const next = k + 1 < pairs.length ? pairs[k + 1].t : end;
    const sec = next - p.t;
    return sec > 0 ? (60 * barQuarters(p.bar)) / sec : Infinity;
  });
  return { flat, endSeconds: end, startSeconds: pairs[0].t, tempos };
}
