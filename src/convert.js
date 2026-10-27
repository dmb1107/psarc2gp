// .psarc -> Guitar Pro 8 (.gp) with the recording embedded and a sync point on every beat.
// Runs in Node and in browsers (the web app converts in a worker): bytes in, bytes out.
// the core module: alphaTab.mjs would turn a worker that imports it into an alphaTab worker
import * as alphaTab from "../node_modules/@coderline/alphatab/dist/alphaTab.core.mjs";
import { loadSong } from "./rocksmith/song.js";
import { wemToOgg } from "./audio/ww2ogg.js";
import { buildAlphaTex } from "./notation/score.js";
import { SOUNDS, useRseSounds } from "./gp/rse.js";
import { rewriteZipEntry } from "./gp/zip.js";
import { utf8 } from "./lib/bytes.js";

export { loadSong };

// Options:
//   withAudio   embed the recording as the audio track
//   rse         give instrument tracks Guitar Pro RSE sounds (false: General MIDI, as alphaTab writes them).
//               RSE plays in time with the audio track; Guitar Pro's MIDI output lags it.
//   mute        mute the instrument tracks so only the recording plays until a track is unmuted
//               (ignored without audio, which would leave nothing to hear)
export async function convertPsarc(psarcBuffer, { withAudio = true, rse = true, mute = true, onWarning = () => {}, song = null } = {}) {
  const warnings = [];
  const warn = (m) => { warnings.push(m); onWarning(m); };

  song ??= loadSong(psarcBuffer);
  const { tex, measures, sync, tracks } = buildAlphaTex(song, { warn });

  const settings = new alphaTab.Settings();
  settings.core.logLevel = alphaTab.LogLevel.Error;
  const score = alphaTab.importer.ScoreLoader.loadAlphaTex(tex, settings);
  mute = mute && withAudio;
  for (const t of score.tracks) t.playbackInfo.isMute = mute;

  let audio = null;
  if (withAudio) {
    audio = wemToOgg(song.wem);
    score.backingTrack = new alphaTab.model.BackingTrack();
    score.backingTrack.rawAudioFile = audio.ogg;
  }
  let gp = new alphaTab.exporter.Gp7Exporter().export(score, settings);
  if (rse) {
    const keys = tracks.map((t) => t.sound);
    gp = await rewriteZipEntry(gp, "Content/score.gpif", (xml) => useRseSounds(utf8(xml), keys));
  }

  return {
    gp,
    tex,
    meta: song.meta,
    report: {
      bars: measures.length,
      syncPoints: sync.length,
      audioSeconds: audio ? audio.sampleCount / audio.sampleRate : null,
      tracks: tracks.map((t) => ({ ...t, soundName: rse ? SOUNDS[t.sound].label : `MIDI program ${SOUNDS[t.sound].program}` })),
      muted: mute,
      warnings,
    },
  };
}

export function outputName(meta) {
  const clean = (s) => String(s ?? "").replace(/[<>:"/\|?*\x00-\x1f]/g, "").replace(/\s+/g, " ").trim();
  return `${clean(meta.artist) || "Unknown"} - ${clean(meta.title) || "Untitled"}.gp`;
}
