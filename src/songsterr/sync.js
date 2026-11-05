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
export function fitOf(video, playedCount, writtenCount) {
  if (video.fit !== undefined) return video.fit;
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

// The videos with their fit; a video with one stray point (findStrayPoint) fits with that point left
// out: { ...video, points (without it), fit: "played", strayPoint: its index in the original list }.
export function fitVideos(videos, quarters, writtenCount) {
  return videos.map((v) => {
    const fit = fitOf(v, quarters.length, writtenCount);
    if (fit) return { ...v, fit };
    const j = findStrayPoint(v.points, quarters);
    if (j === null) return { ...v, fit: null };
    return { ...v, points: v.points.filter((_, i) => i !== j), fit: "played", strayPoint: j };
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
