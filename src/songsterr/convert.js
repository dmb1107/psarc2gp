// Songsterr bundle (+ audio) -> Guitar Pro 8 (.gp) with a sync point on every played bar.
// Runs in Node and in browsers, like src/convert.js: bundle and bytes in, bytes out.
import * as alphaTab from "../../node_modules/@coderline/alphatab/dist/alphaTab.core.mjs";
import { validateBundle, loadTracks, defaultTrackIndices, trackKind } from "./bundle.js";
import { buildAlphaTex } from "./score.js";
import { playedBars, chooseVideo, describeVideos, syncFromPoints } from "./sync.js";
import { SOUNDS, useRseSounds } from "../gp/rse.js";
import { rewriteZipEntry } from "../gp/zip.js";
import { syncPointsInPlayOrder } from "../gp/syncpoints.js";
import { utf8 } from "../lib/bytes.js";

export { validateBundle };

const QUARTER_TICKS = 960; // alphaTab's MIDI resolution

const clean = (s) => String(s ?? "").replace(/[<>:"/\\|?*\x00-\x1f]/g, "").replace(/\s+/g, " ").trim();

// "Artist - Title (Songsterr).gp": the suffix keeps it apart from a .psarc version of the same song
// (the web library keys songs by file name, and the CLI skips existing files)
export function songsterrOutputName(song) {
  return `${clean(song.artist) || "Unknown"} - ${clean(song.title) || "Untitled"} (Songsterr).gp`;
}

function loadScore(tex) {
  const settings = new alphaTab.Settings();
  settings.core.logLevel = alphaTab.LogLevel.Error;
  return { score: alphaTab.importer.ScoreLoader.loadAlphaTex(tex, settings), settings };
}

// The structure step on its own (no audio): played bars and the videos that fit. Used to list videos
// and by the web app before it fetches any audio.
export async function inspectSongsterr(bundle, { tracks = null, fetch, warn = () => {} } = {}) {
  validateBundle(bundle);
  const indices = tracks ?? defaultTrackIndices(bundle);
  if (!indices.length) {
    const others = bundle.song.tracks.map((t, i) => ({ t, i })).filter(({ t }) => !["drums", "vocals"].includes(trackKind(t)));
    throw new Error("this song has no guitar or bass track" + (others.length
      ? `; choose tracks by number (--tracks): ${others.map(({ t, i }) => `${i} ${t.name} (${t.instrument ?? `instrument ${t.instrumentId}`})`).join(", ")}`
      : " (drums and vocals aren't converted yet)"));
  }
  const data = await loadTracks(bundle, indices, { fetch });
  const built = buildAlphaTex(bundle, data, { warn });
  const { score, settings } = loadScore(built.tex);
  const played = playedBars(alphaTab, score, settings);
  return { data, built, score, settings, played, videos: describeVideos(bundle.videos, played.length, score.masterBars.length) };
}

// Options:
//   tracks     track indices (default: every guitar and bass track)
//   video      "default" | "backing" | "solo" | "playthrough" | "alternative" | a YouTube video id
//   audio      { bytes, format: "mp3" | "m4a", seconds, provider, offsetMs } or null (no audio track), or an
//              async function ({ videoId, feature, lastPoint }) → that, called once the video is chosen
//              (so the audio of the right video is fetched, and only after the tab converted)
//   rse, mute  as convertPsarc
//   fetch      for tracks the bundle doesn't carry (CDN)
export async function convertSongsterr(bundle, { tracks = null, video = "default", audio = null, rse = true, mute = true, fetch, onWarning = () => {} } = {}) {
  const warnings = [];
  const warn = (m) => { warnings.push(m); onWarning(m); };
  for (const i of tracks ?? []) {
    const kind = trackKind(bundle.song.tracks[i] ?? {});
    if (kind === "drums" || kind === "vocals") throw new Error(`track ${i} (${bundle.song.tracks[i].name}) is ${kind}; only guitar, bass and other fretted tracks are converted so far`);
  }
  const { built, score, settings, played } = await inspectSongsterr(bundle, { tracks, fetch, warn });
  const written = score.masterBars.length;
  const chosen = chooseVideo(bundle.videos, video, played.length, written);
  if (chosen.points.length !== played.length) warn(`video ${chosen.videoId} has one point per written bar, not per played bar: repeats are timed from the first pass`);
  if (typeof audio === "function") audio = await audio({ videoId: chosen.videoId, feature: chosen.feature ?? "default", lastPoint: chosen.points.at(-1) });

  const barQuarters = (i) => score.masterBars[i].calculateDuration() / QUARTER_TICKS;
  const sync = syncFromPoints(chosen.points, played, barQuarters, { writtenCount: written, offsetMs: audio?.offsetMs ?? 0 });
  score.applyFlatSyncPoints(sync.flat);

  const odd = sync.tempos.map((t, k) => ({ t, k })).filter(({ t }) => !(t >= 20 && t <= 400));
  if (odd.length) warn(`${odd.length} played bar(s) get an implausible tempo from the video's points (first: played bar ${odd[0].k + 1}, ${Math.round(odd[0].t)} bpm); the video may not fit`);
  if (audio?.seconds != null && audio.seconds < chosen.points.at(-1) + (audio.offsetMs ?? 0) / 1000) {
    warn(`the audio (${audio.seconds.toFixed(1)} s) ends before the last bar starts (${chosen.points.at(-1).toFixed(1)} s)`);
  }

  mute = mute && !!audio;
  for (const t of score.tracks) t.playbackInfo.isMute = mute;
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
    meta: { artist: s.artist, title: s.title, songsterrId: s.songId, revisionId: s.revisionId, videoId: chosen.videoId, audioProvider: audio?.provider ?? null },
    report: {
      bars: written,
      playedBars: played.length,
      syncPoints: sync.flat.length,
      video: { videoId: chosen.videoId, feature: chosen.feature ?? "default", firstPoint: sync.startSeconds, end: sync.endSeconds },
      audioSeconds: audio?.seconds ?? null,
      audioProvider: audio?.provider ?? null,
      tracks: built.tracks.map((t) => ({ ...t, soundName: rse ? SOUNDS[t.sound].label : `MIDI program ${SOUNDS[t.sound].program}` })),
      muted: mute,
      warnings,
    },
  };
}
