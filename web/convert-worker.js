// Runs the converter off the page's main thread, so the page stays responsive during the 1–3 s a song
// takes. Messages in:
//   { id, kind: "psarc" | "gp", name, bytes: ArrayBuffer }
//   { id, kind: "songsterr-inspect", bundle, tracks }      which videos fit (fetches those tracks' tabs)
//   { id, kind: "songsterr", bundle, tracks, video, audio: "fetch" | "file" | "none", file, secrets, nudge }
// out: { id, progress } while working, then { id, ok, song | info | error, code? }.
import * as alphaTab from "../node_modules/@coderline/alphatab/dist/alphaTab.core.mjs"; // not alphaTab.mjs (see src/convert.js)

// Imported dynamically, not statically: the converter loads its codebooks with a top-level await, and
// Chrome delivers a module worker's messages while its top level is still awaiting, before onmessage is
// set, so a song added right after the page opened was lost (stuck at "Converting…").
const converter = import("../src/convert.js");
const songsterr = import("../src/songsterr/convert.js");
const audioModule = import("../src/songsterr/audio/index.js");

async function fromPsarc(bytes) {
  const { convertPsarc, outputName } = await converter;
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

// The tracks' tabs come back with the answer, so the page keeps them and nothing is fetched twice.
async function inspect({ bundle, tracks }) {
  const { inspectSongsterr } = await songsterr;
  const { data, played, score, videos } = await inspectSongsterr(bundle, { tracks });
  return { bars: score.masterBars.length, playedBars: played.length, videos, trackData: data.map((d) => ({ index: d.index, data: d.data })) };
}

async function fromSongsterr({ bundle, tracks, video, audio: choice, file, secrets, nudge = 0 }, progress) {
  const { convertSongsterr } = await songsterr;
  const { getAudio } = await audioModule;
  let audio = null;
  if (choice === "fetch" || choice === "file") {
    audio = async ({ videoId, lastPoint }) => {
      progress({ stage: "audio", videoId });
      const got = await getAudio(videoId, {
        secrets, minSeconds: lastPoint,
        file: choice === "file" ? { bytes: new Uint8Array(file.bytes), name: file.name } : null,
        onProgress: progress,
      });
      progress({ stage: "building" });
      return { ...got, offsetMs: got.offsetMs + nudge };
    };
  }
  progress({ stage: "tabs" });
  const result = await convertSongsterr(bundle, { tracks, video, audio });
  const { report, meta } = result;
  return {
    name: result.name,
    title: meta.title ?? "", artist: meta.artist ?? "", album: "",
    tracks: report.tracks.map((t) => t.name),
    seconds: report.audioSeconds,
    warnings: report.warnings,
    songsterr: { songsterrId: meta.songsterrId, revisionId: meta.revisionId, videoId: meta.videoId, feature: report.video?.feature ?? null, audioProvider: meta.audioProvider },
    gp: result.gp.slice(),
  };
}

self.onmessage = async ({ data: msg }) => {
  const { id, kind } = msg;
  const progress = (p) => self.postMessage({ id, progress: p });
  try {
    if (kind === "songsterr-inspect") {
      self.postMessage({ id, ok: true, info: await inspect(msg) });
      return;
    }
    const song = kind === "songsterr" ? await fromSongsterr(msg, progress)
      : kind === "psarc" ? await fromPsarc(new Uint8Array(msg.bytes)) : fromGp(new Uint8Array(msg.bytes), msg.name);
    self.postMessage({ id, ok: true, song }, [song.gp.buffer]);
  } catch (err) {
    // AudioError's class doesn't survive postMessage: send its code and the wording users read
    const am = await audioModule.catch(() => null);
    const audioError = !!am && err instanceof am.AudioError;
    self.postMessage({
      id, ok: false,
      // the user's own file: its own message says what's wrong with it ("… s long but the last bar starts …")
      error: audioError ? (err.provider === "file" ? `the audio file doesn't fit: ${err.message}` : am.describeAudioError(err)) : err?.message ?? String(err),
      detail: audioError ? err.message : null,
      code: audioError ? err.code : null,
      missingSecret: !!err?.missingSecret,
    });
  }
};
