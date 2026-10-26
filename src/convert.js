// .psarc -> Guitar Pro 8 (.gp) with the recording embedded and a sync point on every beat.
import { createRequire } from "node:module";
import { loadSong } from "./rocksmith/song.js";
import { wemToOgg } from "./audio/ww2ogg.js";
import { buildAlphaTex } from "./notation/score.js";

const require = createRequire(import.meta.url);
const alphaTab = require("@coderline/alphatab");

export { loadSong };

export function convertPsarc(psarcBuffer, { withAudio = true, onWarning = () => {}, song = null } = {}) {
  const warnings = [];
  const warn = (m) => { warnings.push(m); onWarning(m); };

  song ??= loadSong(psarcBuffer);
  const { tex, measures, sync, tracks } = buildAlphaTex(song, { warn });

  const settings = new alphaTab.Settings();
  settings.core.logLevel = alphaTab.LogLevel.Error;
  const score = alphaTab.importer.ScoreLoader.loadAlphaTex(tex, settings);

  let audio = null;
  if (withAudio) {
    audio = wemToOgg(song.wem);
    score.backingTrack = new alphaTab.model.BackingTrack();
    score.backingTrack.rawAudioFile = new Uint8Array(audio.ogg);
  }
  const gp = new alphaTab.exporter.Gp7Exporter().export(score, settings);

  return {
    gp: Buffer.from(gp),
    tex,
    meta: song.meta,
    report: {
      bars: measures.length,
      syncPoints: sync.length,
      audioSeconds: audio ? audio.sampleCount / audio.sampleRate : null,
      tracks,
      warnings,
    },
  };
}

export function outputName(meta) {
  const clean = (s) => String(s ?? "").replace(/[<>:"/\\|?*\x00-\x1f]/g, "").replace(/\s+/g, " ").trim();
  return `${clean(meta.artist) || "Unknown"} - ${clean(meta.title) || "Untitled"}.gp`;
}
