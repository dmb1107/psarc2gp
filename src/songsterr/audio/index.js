// The audio of a YouTube video for a Songsterr song, from swappable providers.
//
// Every provider (providers/*.js) exports id, label, needsSecret and
//   fetchAudio({ videoId, secret, fetch, signal, onProgress, file }) → { bytes, format, provider, meta }
// and throws AudioError (errors.js) with one of the shared codes. getAudio runs the configured providers
// in order, falls through on "unavailable"/"failed", and checks the result (validate.js) the same way
// whichever provider supplied it. Platform-neutral: fetch is passed in.
import config from "./config.js";
import { AudioError, STOPS_FALLBACK } from "./errors.js";
import { checkAudio } from "./validate.js";
import * as rapidapi from "./providers/rapidapi-youtube-mp310.js";
import * as file from "./providers/file.js";

export { AudioError, describeAudioError, AUDIO_ERROR_CODES } from "./errors.js";
export { config };

export const PROVIDERS = Object.fromEntries([rapidapi, file].map((p) => [p.id, p]));

export function provider(id) {
  const p = PROVIDERS[id];
  if (!p) throw new Error(`unknown audio provider ${JSON.stringify(id)} (known: ${Object.keys(PROVIDERS).join(", ")})`);
  return p;
}

// Whether running these providers needs the secrets (the password): lets callers skip asking for it.
export const needsSecrets = (providers = config.providers) => providers.some((id) => provider(id).needsSecret);

// Options:
//   providers   ids in fallback order (default: config.providers); a given `file` is used on its own
//   secrets     { providerId: secret } (decrypted from web/songsterr-secrets.json)
//   file        { bytes, name } an audio file the user supplied
//   minSeconds  the audio must reach this far (the last sync point)
//   fetch, signal, onProgress({ provider, stage, received, total })
// Returns { bytes, format, seconds, provider, offsetMs, meta }. On failure throws the first meaningful
// AudioError, with `attempts` ([{ provider, error }]) and `fileFallback` (a file would be accepted).
export async function getAudio(videoId, { providers = config.providers, secrets = {}, file: given = null, minSeconds = 0,
  fetch = globalThis.fetch, signal, onProgress = () => {}, offsets = config.offsets, maxBytes = config.maxBytes } = {}) {
  const order = given ? ["file"] : providers;
  const attempts = [];
  for (const id of order) {
    const p = provider(id);
    try {
      const secret = secrets?.[id] ?? null;
      if (p.needsSecret && !secret) throw new AudioError("auth", `no key for ${p.label}`, { missingSecret: true });
      const r = await p.fetchAudio({ videoId, secret, fetch, signal, file: given, onProgress: (e) => onProgress({ provider: id, ...e }) });
      const info = checkAudio(r.bytes, { minSeconds, maxBytes });
      return {
        bytes: r.bytes, format: info.format, seconds: info.seconds, provider: id, offsetMs: offsets?.[id] ?? 0,
        meta: { ...r.meta, sampleRate: info.sampleRate ?? null, encoder: info.encoder ?? null, encoderDelay: info.encoderDelay ?? null },
      };
    } catch (e) {
      if (signal?.aborted || e?.name === "AbortError") throw e;
      const error = e instanceof AudioError ? e : new AudioError("failed", e?.message ?? String(e));
      error.provider = id;
      attempts.push({ provider: id, error });
      if (STOPS_FALLBACK.has(error.code)) break;
    }
  }
  if (!attempts.length) throw new Error("no audio providers configured");
  const primary = (attempts.find((a) => !a.error.noFile) ?? attempts[0]).error;
  primary.attempts = attempts;
  primary.fileFallback = !given && order.includes("file");
  throw primary;
}
