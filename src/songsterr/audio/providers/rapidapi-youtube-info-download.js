// RapidAPI "YouTube Info & Download API" (youtube-info-download-api.p.rapidapi.com), the backup provider
// (added 2026-11-05, when the first provider's file host answered 502 on some videos every time). Its own
// workers convert (savenow.to), not the first provider's. Three steps: GET /ajax/download.php starts a
// job and returns a progress_url; the progress_url (free, no key, outside the RapidAPI quota) is polled
// until progress is 1000 and success 1, which brings a download_url; the file comes from there. The
// RapidAPI gateway and the progress host both answer pages from other origins (checked from a page).
// Billing is per download by format (MP3: 4 units; the free plan has 500 a day); errors cost nothing.
import { AudioError } from "../errors.js";
import { classify, readBody } from "./rapidapi-youtube-mp310.js";

export const id = "rapidapi-youtube-info-download";
export const label = "RapidAPI YouTube Info & Download";
export const needsSecret = true;

const HOST = "youtube-info-download-api.p.rapidapi.com";
// asked for 192 kbit/s (plenty for practising, a smaller .gp), but the API sent 320 anyway (Kerosene!,
// 2026-11-05: 11.8 MB for 5:08); max_duration (minutes) refuses an hour-long video instead of billing
// it at a multiple
const QUALITY = 192;
const MAX_MINUTES = 30;
// how often the job is checked and for how long (tests make these short)
export const timing = { pollMs: 1500, maxWaitMs: 4 * 60 * 1000 };

const isAbort = (e, signal) => signal?.aborted || e?.name === "AbortError";
const said = (body, text) => String(body?.message ?? body?.error ?? body?.text ?? text ?? "").replace(/\s+/g, " ").trim().slice(0, 200);
const NOT_FOUND = /private|unavailable|not found|removed|copyright|region|age|sign in|members/i;

function sleep(ms, signal) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(signal.reason ?? new DOMException("aborted", "AbortError"));
    const t = setTimeout(resolve, ms);
    signal?.addEventListener?.("abort", () => { clearTimeout(t); reject(signal.reason ?? new DOMException("aborted", "AbortError")); }, { once: true });
  });
}

async function getJson(fetch, url, init, signal, what) {
  let r;
  try {
    r = await fetch(url, { ...init, signal });
  } catch (e) {
    if (isAbort(e, signal)) throw e;
    throw new AudioError("unavailable", `couldn't reach ${what} (${e.message})`);
  }
  const text = await r.text().catch(() => "");
  let body = null;
  try { body = JSON.parse(text); } catch { /* not JSON */ }
  return { r, body, text };
}

export async function fetchAudio({ videoId, secret, fetch = globalThis.fetch, signal, onProgress = () => {} }) {
  if (!/^[\w-]{11}$/.test(videoId ?? "")) throw new AudioError("not-found", `${JSON.stringify(videoId)} isn't a YouTube video id`);
  if (!secret) throw new AudioError("auth", "no RapidAPI key", { missingSecret: true });

  onProgress({ stage: "converting" });
  const video = `https://www.youtube.com/watch?v=${videoId}`;
  const api = `https://${HOST}/ajax/download.php?format=mp3&audio_quality=${QUALITY}&max_duration=${MAX_MINUTES}&url=${encodeURIComponent(video)}`;
  const start = await getJson(fetch, api, { headers: { "x-rapidapi-key": secret, "x-rapidapi-host": HOST } }, signal, HOST);
  const quotaRemaining = start.r.headers.get("x-ratelimit-units-remaining") ?? start.r.headers.get("x-ratelimit-requests-remaining");
  if (!start.r.ok) throw classify(start.r.status, said(start.body, start.text));
  if (!start.body?.success || typeof start.body.progress_url !== "string") {
    const m = said(start.body, start.text);
    if (/duration|too long|longer than/i.test(m)) throw new AudioError("failed", `the API refused the video: ${m}`);
    if (NOT_FOUND.test(m)) throw new AudioError("not-found", `the API said: ${m}`);
    throw new AudioError("failed", `the API didn't start a conversion${m ? `: ${m}` : ""}`);
  }
  let progressUrl;
  try { progressUrl = new URL(start.body.progress_url); } catch { throw new AudioError("failed", "the API's progress link isn't a URL"); }
  if (progressUrl.protocol !== "https:") throw new AudioError("failed", "the API's progress link isn't https");

  // the job: progress 0..1000; success 1 with a download_url when done
  const until = Date.now() + timing.maxWaitMs;
  let link = null;
  for (let first = true; ; first = false) {
    if (!first) await sleep(timing.pollMs, signal);
    const p = await getJson(fetch, progressUrl.href, {}, signal, progressUrl.host);
    if (!p.r.ok) {
      // the job went missing or the host is down: either way, another provider may manage
      throw new AudioError(p.r.status === 404 ? "failed" : "unavailable", `the conversion's progress answered ${p.r.status}${said(p.body, p.text) ? `: ${said(p.body, p.text)}` : ""}`);
    }
    const b = p.body ?? {};
    const progress = Number(b.progress) || 0;
    onProgress({ stage: "converting", received: progress, total: 1000 });
    if (Number(b.success) === 1 && b.download_url) { link = b.download_url; break; }
    if (Number(b.success) < 0 || /error|fail/i.test(String(b.text ?? ""))) {
      const m = said(b);
      throw new AudioError(NOT_FOUND.test(m) ? "not-found" : "failed", `the conversion failed${m ? `: ${m}` : ""}`);
    }
    if (Date.now() > until) throw new AudioError("unavailable", `the conversion didn't finish in ${Math.round(timing.maxWaitMs / 1000)} s (at ${progress / 10}%)`);
  }
  let url;
  try { url = new URL(link); } catch { throw new AudioError("failed", "the download link isn't a URL"); }
  if (url.protocol !== "https:" && url.protocol !== "http:") throw new AudioError("failed", "the download link isn't a web address");

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
  return { bytes, format: null, provider: id, meta: { downloadHost: url.host, quotaRemaining: quotaRemaining == null ? null : Number(quotaRemaining) } };
}
