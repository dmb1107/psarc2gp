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
// "written" (one per written bar, only meaningful when they differ), or null (doesn't fit).
export function fitOf(video, playedCount, writtenCount) {
  const n = video.points.length;
  if (n === playedCount) return "played";
  if (n === writtenCount) return "written";
  return null;
}

export function describeVideos(videos, playedCount, writtenCount) {
  return videos.map((v) => ({
    videoId: v.videoId,
    feature: v.feature ?? "default",
    leavesOut: v.tracks ?? null, // backing videos name the tracks they leave out
    countries: v.countries ?? null,
    points: v.points.length,
    fit: fitOf(v, playedCount, writtenCount),
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
    pick = videos.find((v) => !v.feature && fits(v))
      ?? videos.find((v) => v.feature === "alternative" && everywhere(v) && fits(v))
      ?? videos.find((v) => v.feature === "alternative" && fits(v));
  } else if (["backing", "solo", "playthrough", "alternative"].includes(want)) {
    pick = videos.find((v) => v.feature === want && everywhere(v) && fits(v)) ?? videos.find((v) => v.feature === want && fits(v));
  } else {
    const v = videos.find((x) => x.videoId === want);
    if (!v) throw new Error(`video ${want} isn't listed for this song`);
    if (!fits(v)) throw new Error(`video ${want} has ${v.points.length} sync points, but this tab revision plays ${playedCount} bars: it was synced to another revision`);
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
