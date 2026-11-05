// "Use an audio file I have": always available, needs no key. The web app passes a dropped file, the
// CLI the file given with --audio.
import { AudioError } from "../errors.js";

export const id = "file";
export const label = "an audio file";
export const needsSecret = false;

export async function fetchAudio({ file }) {
  if (!file?.bytes?.length) throw new AudioError("unavailable", "no audio file given", { noFile: true });
  return { bytes: file.bytes, format: null, provider: id, meta: { name: file.name ?? null } };
}
