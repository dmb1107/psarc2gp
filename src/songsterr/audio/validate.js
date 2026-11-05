// Checks run on every provider's result: a format Guitar Pro 8 plays (MP3 or M4A; it won't play Opus),
// long enough to reach the last sync point, and not absurdly large.
import { AudioError } from "./errors.js";
import { audioInfo } from "./duration.js";

export function checkAudio(bytes, { minSeconds = 0, maxBytes = Infinity } = {}) {
  if (!(bytes instanceof Uint8Array) || !bytes.length) throw new AudioError("failed", "no audio bytes");
  if (bytes.length > maxBytes) throw new AudioError("failed", `the audio is ${(bytes.length / 1048576).toFixed(0)} MB, more than any song should be`);
  let info;
  try { info = audioInfo(bytes); } catch (e) { throw new AudioError("failed", e.message); }
  if (!(info.seconds > 0)) throw new AudioError("failed", "the audio has no length");
  if (info.seconds < minSeconds) {
    throw new AudioError("failed", `the audio is ${info.seconds.toFixed(1)} s long but the tab's last bar starts at ${minSeconds.toFixed(1)} s in the video`);
  }
  return info;
}
