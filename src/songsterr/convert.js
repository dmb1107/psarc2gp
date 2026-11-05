// Songsterr bundle (+ audio) -> Guitar Pro 8 (.gp) with a sync point on every played bar.
// Runs in Node and in browsers, like src/convert.js: bundle and bytes in, bytes out.
import * as alphaTab from "../../node_modules/@coderline/alphatab/dist/alphaTab.core.mjs";
import { validateBundle, loadTracks, defaultTrackIndices, convertibleTrackIndices, songsterrOutputName, songsterrLink, songsterrNotices } from "./bundle.js";
import { buildAlphaTex } from "./score.js";
import { playedBars, chooseVideo, describeVideos, fitVideos, emptyTail, restBarsUntil, syncFromPoints } from "./sync.js";
import { SOUNDS, useRseSounds } from "../gp/rse.js";
import { rewriteZipEntry } from "../gp/zip.js";
import { syncPointsInPlayOrder } from "../gp/syncpoints.js";
import { utf8 } from "../lib/bytes.js";

export { validateBundle, songsterrOutputName };

const QUARTER_TICKS = 960; // alphaTab's MIDI resolution


function loadScore(tex) {
  const settings = new alphaTab.Settings();
  settings.core.logLevel = alphaTab.LogLevel.Error;
  return { score: alphaTab.importer.ScoreLoader.loadAlphaTex(tex, settings), settings };
}

// The tab built as a score, its played bars, and the videos with their fit (stray points left out:
// sync.js fitVideos).
function structureOf(bundle, tracks, warn) {
  const built = buildAlphaTex(bundle, tracks, { warn });
  const { score, settings } = loadScore(built.tex);
  const played = playedBars(alphaTab, score, settings);
  const quarters = played.map((p) => score.masterBars[p.bar].calculateDuration() / QUARTER_TICKS);
  return { built, score, settings, played, fitted: fitVideos(bundle.videos, quarters, score.masterBars.length) };
}

// The structure step on its own (no audio): played bars and the videos that fit. Used to list videos
// and by the web app before it fetches any audio.
export async function inspectSongsterr(bundle, { tracks = null, fetch, warn = () => {} } = {}) {
  validateBundle(bundle);
  const indices = tracks ?? defaultTrackIndices(bundle);
  if (!indices.length) throw new Error(tracks ? "no tracks chosen" : "all of this song's tracks are empty");
  const data = await loadTracks(bundle, indices, { fetch });
  const structure = (tracks) => structureOf(bundle, tracks, warn);
  let kept = data, emptyBarsLeftOut = 0;
  let r = structure(data);
  if (!r.fitted.some((v) => v.fit)) {
    // no video fits the whole tab: maybe its sync stops at the last note, before empty bars (sync.js
    // emptyTail). Which bars are empty is decided on every track with notes, not only the chosen ones.
    const all = await loadTracks(bundle, convertibleTrackIndices(bundle), { fetch });
    const keep = emptyTail(all.map((d) => d.data), r.played, bundle.videos);
    if (keep !== null) {
      emptyBarsLeftOut = r.score.masterBars.length - keep;
      kept = data.map((d) => ({ ...d, data: { ...d.data, measures: d.data.measures.slice(0, keep) } }));
      r = structure(kept);
    }
  }
  const { built, score, settings, played, fitted } = r;
  // data: the tabs as loaded (the web app keeps them); kept: what the score is built from
  return { data, kept, emptyBarsLeftOut, built, score, settings, played, fitted, videos: describeVideos(fitted, played.length, score.masterBars.length) };
}

// Options:
//   tracks     track indices (default: every track with notes)
//   video      "default" | "backing" | "solo" | "playthrough" | "alternative" | a YouTube video id
//   audio      { bytes, format: "mp3" | "m4a", seconds, provider, offsetMs } or null (no audio track; then a tab
//              that no video fits still converts, without sync points), or an
//              async function ({ videoId, feature, lastPoint }) → that, called once the video is chosen
//              (so the audio of the right video is fetched, and only after the tab converted)
//   rse, mute  as convertPsarc
//   fetch      for tracks the bundle doesn't carry (CDN)
export async function convertSongsterr(bundle, { tracks = null, video = "default", audio = null, rse = true, mute = true, fetch, onWarning = () => {} } = {}) {
  const warnings = [];
  const warn = (m) => { warnings.push(m); onWarning(m); };
  const inspected = await inspectSongsterr(bundle, { tracks, fetch, warn });
  let { built, score, settings, played } = inspected;
  const { fitted, emptyBarsLeftOut, kept } = inspected;
  let written = score.masterBars.length;
  if (emptyBarsLeftOut) warn(`the tab's last ${emptyBarsLeftOut} bars are rests on every track and the videos' sync stops before them: they were left out`);
  let chosen = null;
  try {
    chosen = chooseVideo(fitted, video, played.length, written);
  } catch (e) {
    // without a recording the sync points do nothing, so a tab no video fits still converts
    if (audio !== null) throw e;
    warn(`${e.message}; converted without sync points (no recording)`);
  }
  if (chosen?.strayPoint != null) {
    const k = chosen.strayPoint - 1; // the played bar it fell in
    warn(`video ${chosen.videoId} has one sync point more than the tab has played bars: point ${chosen.strayPoint + 1} splits played bar ${k + 1} (written bar ${played[k].bar + 1}) in two and was left out`);
  }
  if (chosen && chosen.points.length !== played.length) warn(`video ${chosen.videoId} has one point per written bar, not per played bar: repeats are timed from the first pass`);
  if (typeof audio === "function") audio = await audio({ videoId: chosen.videoId, feature: chosen.feature ?? "default", lastPoint: chosen.points.at(-1) });

  const barQuarters = (i) => score.masterBars[i].calculateDuration() / QUARTER_TICKS;
  const offsetMs = audio?.offsetMs ?? 0;
  let points = chosen?.points;
  let sync = chosen && syncFromPoints(points, played, barQuarters, { writtenCount: written, offsetMs });
  // the recording goes on after the tab: rest bars until it ends (sync.js restBarsUntil)
  let restBarsAdded = 0;
  if (sync && audio?.seconds != null) {
    const more = restBarsUntil(points, played, barQuarters, sync.endSeconds, audio.seconds - offsetMs / 1000);
    if (more.length) {
      const padded = kept.map((d) => ({ ...d, data: { ...d.data, measures: [...d.data.measures, ...more.map(() => ({ voices: [] }))] } }));
      const r = structureOf(bundle, padded, () => {});
      if (r.played.length !== played.length + more.length) throw new Error(`adding ${more.length} rest bars gave ${r.played.length} played bars, not ${played.length + more.length}`);
      ({ built, score, settings, played } = r);
      written = score.masterBars.length;
      points = [...points, ...more];
      restBarsAdded = more.length;
      sync = syncFromPoints(points, played, barQuarters, { writtenCount: written, offsetMs });
      warn(`the recording goes on ${(audio.seconds - offsetMs / 1000 - more[0]).toFixed(1)} s after the tab's last bar: ${more.length} rest bar(s) added at the song's closing tempo (the file ends at bar ${written})`);
    }
  }
  if (sync) score.applyFlatSyncPoints(sync.flat);
  score.notices = songsterrNotices(bundle, chosen);

  const odd = (sync?.tempos ?? []).map((t, k) => ({ t, k })).filter(({ t }) => !(t >= 20 && t <= 400));
  if (odd.length) warn(`${odd.length} played bar(s) get an implausible tempo from the video's points (first: played bar ${odd[0].k + 1}, ${Math.round(odd[0].t)} bpm); the video may not fit`);
  if (chosen && audio?.seconds != null && audio.seconds < chosen.points.at(-1) + (audio.offsetMs ?? 0) / 1000) {
    warn(`the audio (${audio.seconds.toFixed(1)} s) ends before the last bar starts (${chosen.points.at(-1).toFixed(1)} s)`);
  }

  mute = mute && !!audio;
  // vocal tracks stay silent even without a recording (the user's choice): unmute one in Guitar Pro to
  // hear the melody on its clarinet
  score.tracks.forEach((t, i) => { t.playbackInfo.isMute = mute || built.tracks[i].kind === "vocals"; });
  if (audio) {
    score.backingTrack = new alphaTab.model.BackingTrack();
    score.backingTrack.rawAudioFile = audio.bytes;
  }
  let gp = new alphaTab.exporter.Gp7Exporter().export(score, settings);
  const keys = built.tracks.map((t) => t.sound);
  gp = await rewriteZipEntry(gp, "Content/score.gpif", (xml) => {
    const gpif = syncPointsInPlayOrder(utf8(xml), played);
    return rse ? useRseSounds(gpif, keys) : gpif;
  });

  const s = bundle.song;
  return {
    gp,
    tex: built.tex,
    name: songsterrOutputName(s),
    meta: { artist: s.artist, title: s.title, link: songsterrLink(bundle), songsterrId: s.songId, revisionId: s.revisionId, videoId: chosen?.videoId ?? null, audioProvider: audio?.provider ?? null },
    report: {
      bars: written,
      playedBars: played.length,
      emptyBarsLeftOut,
      restBarsAdded,
      syncPoints: sync?.flat.length ?? 0,
      video: chosen && { videoId: chosen.videoId, feature: chosen.feature ?? "default", firstPoint: sync.startSeconds, end: sync.endSeconds, strayPoint: chosen.strayPoint ?? null },
      audioSeconds: audio?.seconds ?? null,
      audioProvider: audio?.provider ?? null,
      tracks: built.tracks.map((t) => ({ ...t, soundName: rse ? SOUNDS[t.sound].label : `MIDI program ${SOUNDS[t.sound].program}` })),
      muted: mute,
      warnings,
    },
  };
}
