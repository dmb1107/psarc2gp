// Runs the converter off the page's main thread, so the page stays responsive during the 1–3 s a song
// takes. Messages: { id, kind: "psarc" | "gp", bytes: ArrayBuffer } in; { id, ok, song | error } out.
import { convertPsarc, outputName } from "../src/convert.js";
import * as alphaTab from "../node_modules/@coderline/alphatab/dist/alphaTab.core.mjs"; // not alphaTab.mjs (see src/convert.js)

function fromPsarc(bytes) {
  return convertPsarc(bytes).then(({ gp, meta, report }) => ({
    name: outputName(meta),
    title: meta.title ?? "", artist: meta.artist ?? "", album: meta.album ?? "",
    tracks: report.tracks.map((t) => t.name),
    seconds: report.audioSeconds,
    warnings: report.warnings,
    gp: gp.slice(), // own buffer, so it can be transferred
  }));
}

// a Guitar Pro file added as it is: read what the library shows
function fromGp(bytes, fileName) {
  const score = alphaTab.importer.ScoreLoader.loadScoreFromBytes(bytes, new alphaTab.Settings());
  return {
    name: fileName,
    title: score.title || fileName.replace(/\.gp$/i, ""), artist: score.artist ?? "", album: score.album ?? "",
    tracks: score.tracks.map((t) => t.name),
    seconds: null,
    warnings: score.backingTrack?.rawAudioFile ? [] : ["no recording in this file: it plays with the synthesizer only"],
    gp: bytes,
  };
}

self.onmessage = async ({ data: { id, kind, name, bytes } }) => {
  try {
    const input = new Uint8Array(bytes);
    const song = kind === "psarc" ? await fromPsarc(input) : fromGp(input, name);
    self.postMessage({ id, ok: true, song }, [song.gp.buffer]);
  } catch (err) {
    self.postMessage({ id, ok: false, error: err?.message ?? String(err) });
  }
};
