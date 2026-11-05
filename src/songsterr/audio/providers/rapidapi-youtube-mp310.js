// RapidAPI "YouTube MP3" (youtube-mp310.p.rapidapi.com): asks for an MP3 of a YouTube video, then reads
// it from the download link the API returns. Tried in the lab (2026-11-04): the API answered in 0.7 s with
// { downloadUrl }, the gateway and the file host both send CORS headers, and the 3.7 MB MP3 took 10 s
// (converted on request). The error answers below follow RapidAPI's gateway conventions (401/403 key,
// 429 quota or rate limit) and haven't all been seen from this API yet.
import { AudioError } from "../errors.js";
import { readQuota } from "../quota.js";

export const id = "rapidapi-youtube-mp310";
export const label = "RapidAPI YouTube MP3";
export const needsSecret = true;

const HOST = "youtube-mp310.p.rapidapi.com";
const isAbort = (e, signal) => signal?.aborted || e?.name === "AbortError";

// The allowance the gateway reported rides along on the result (meta.quota) and on any error after it
// answered (err.quota), so a failed video still updates what the setup page shows.
export async function fetchAudio(options) {
  const seen = { quota: null };
  try {
    return await run(options, seen);
  } catch (e) {
    if (e instanceof AudioError && seen.quota && !e.quota) e.quota = seen.quota;
    throw e;
  }
}

async function run({ videoId, secret, fetch = globalThis.fetch, signal, onProgress = () => {} }, seen) {
  if (!/^[\w-]{11}$/.test(videoId ?? "")) throw new AudioError("not-found", `${JSON.stringify(videoId)} isn't a YouTube video id`);
  if (!secret) throw new AudioError("auth", "no RapidAPI key", { missingSecret: true });

  onProgress({ stage: "converting" });
  const api = `https://${HOST}/download/mp3?url=${encodeURIComponent(`https://www.youtube.com/watch?v=${videoId}`)}`;
  let r;
  try {
    r = await fetch(api, { headers: { "x-rapidapi-key": secret, "x-rapidapi-host": HOST }, signal });
  } catch (e) {
    if (isAbort(e, signal)) throw e;
    throw new AudioError("unavailable", `couldn't reach ${HOST} (${e.message})`);
  }
  seen.quota = readQuota(r.headers);
  const text = await r.text().catch(() => "");
  let body = null;
  try { body = JSON.parse(text); } catch { /* not JSON */ }
  const said = String(body?.message ?? body?.error ?? body?.msg ?? text).replace(/\s+/g, " ").trim().slice(0, 200);
  if (!r.ok) throw classify(r.status, said);

  const link = body?.downloadUrl ?? body?.link ?? body?.url;
  if (typeof link !== "string" || !link) {
    if (/private|unavailable|not found|removed|copyright|region|age/i.test(said)) throw new AudioError("not-found", `the API said: ${said}`);
    throw new AudioError("failed", `no download link in the API's answer${said ? `: ${said}` : ""}`);
  }
  let url;
  try { url = new URL(link); } catch { throw new AudioError("failed", "the API's download link isn't a URL"); }
  if (url.protocol !== "https:" && url.protocol !== "http:") throw new AudioError("failed", "the API's download link isn't a web address");

  onProgress({ stage: "downloading", received: 0, total: null });
  let f;
  try {
    f = await fetch(url.href, { signal });
  } catch (e) {
    if (isAbort(e, signal)) throw e;
    throw new AudioError("unavailable", `couldn't read the file from ${url.host} (${e.message})`);
  }
  if (!f.ok) throw new AudioError(f.status === 404 || f.status === 410 ? "failed" : "unavailable", `the file host ${url.host} answered ${f.status}`);
  const bytes = await readBody(f, signal, onProgress);
  return { bytes, format: null, provider: id, meta: { downloadHost: url.host, quota: seen.quota } };
}

// RapidAPI gateway answers (shared with the other RapidAPI provider)
export function classify(status, said) {
  const detail = `the API answered ${status}${said ? `: ${said}` : ""}`;
  if (status === 401 || status === 403) return new AudioError("auth", detail);
  if (status === 429) return /quota|monthly|daily|plan/i.test(said) ? new AudioError("quota", detail) : new AudioError("unavailable", `${detail} (too many requests; try again in a minute)`);
  if (status === 404 && /endpoint|does not exist|api doesn't exist/i.test(said)) return new AudioError("unavailable", detail);
  if ([400, 404, 410, 422].includes(status)) return new AudioError("not-found", detail);
  if (status >= 500) return new AudioError("unavailable", detail);
  return new AudioError("failed", detail);
}

// The response body as bytes, reporting progress when the body can be streamed.
export async function readBody(response, signal, onProgress = () => {}) {
  const total = Number(response.headers.get("content-length")) || null;
  const reader = response.body?.getReader?.();
  if (!reader) return new Uint8Array(await response.arrayBuffer());
  const chunks = [];
  let received = 0;
  for (;;) {
    if (signal?.aborted) { reader.cancel().catch(() => {}); throw signal.reason ?? new DOMException("aborted", "AbortError"); }
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    received += value.length;
    onProgress({ stage: "downloading", received, total });
  }
  const out = new Uint8Array(received);
  let o = 0;
  for (const c of chunks) { out.set(c, o); o += c.length; }
  return out;
}
