// One error vocabulary for every audio provider, so swapping providers never changes what users read.
//
//   auth         bad or missing key (missingSecret: true when there was no key at all)
//   quota        the key's allowance is used up
//   unavailable  service down, removed, unreachable or refused by CORS (noFile: the file provider got no file)
//   not-found    the video is private, removed or blocked in the region
//   failed       conversion error or unusable output (wrong format, too short, too big)
//
// On every code but auth the next provider in the config is tried: a backup has its own allowance (quota),
// and one provider's "not found" may be its own failure to reach the video (refused requests cost nothing).
// auth stops there, so the user hears about the key. Until 2026-11-05, with one provider, quota and
// not-found stopped too. When every provider fails, the first one's error is what the user reads.

export const AUDIO_ERROR_CODES = ["auth", "quota", "unavailable", "not-found", "failed"];
export const STOPS_FALLBACK = new Set(["auth"]);

export class AudioError extends Error {
  constructor(code, message, extra = {}) {
    if (!AUDIO_ERROR_CODES.includes(code)) throw new Error(`unknown audio error code ${code}`);
    super(message);
    this.name = "AudioError";
    this.code = code;
    Object.assign(this, extra);
  }
}

// What the user reads, by code. `err.message` keeps the provider's detail for logs and reports.
const WORDING = {
  auth: "the audio service refused the key (it may have been replaced: ask for the new password)",
  quota: "this month's shared audio allowance is used up; try again next month",
  unavailable: "the audio service isn't available right now; try again later",
  "not-found": "this video's audio can't be fetched (it may be private, removed or blocked in your region)",
  failed: "the audio service couldn't deliver usable audio for this video",
};

export function describeAudioError(err) {
  if (!(err instanceof AudioError)) return err?.message ?? String(err);
  if (err.missingSecret) return "fetching the audio needs the password";
  if (err.noFile) return "no audio file given";
  return WORDING[err.code];
}
