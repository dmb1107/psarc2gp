// RapidAPI "YouTube MP3" (youtube-mp36.p.rapidapi.com, by niketagup), the backup provider (2026-11-05):
// runs when the first provider can't deliver a video (its file host answered 502 on some videos every
// time). It replaced "YouTube Info & Download API", whose file hosts send no CORS header on the MP3 (a web
// page can't read it; the CLI could). GET /dl?id=<video> answers { status: "ok" | "processing" | "fail",
// link, msg }; while "processing" it is asked again every second (only an "ok" counts against the quota:
// 300 a month on the free plan). Its MP3 links are "secure links" that may answer 404 unless the request
// carries X-RUN: md5 of the RapidAPI username, so the secret is "<key>" or "<key>:<that md5>".
import { AudioError } from "../errors.js";
import { classify, readBody } from "./rapidapi-youtube-mp310.js";
import { readQuota } from "../quota.js";

export const id = "rapidapi-youtube-mp36";
export const label = "RapidAPI YouTube MP3 (mp36)";
export const needsSecret = true;

const HOST = "youtube-mp36.p.rapidapi.com";
// how often a "processing" video is asked about again, and for how long (tests make these short)
export const timing = { pollMs: 1000, maxWaitMs: 4 * 60 * 1000 };

const isAbort = (e, signal) => signal?.aborted || e?.name === "AbortError";
const NOT_FOUND = /private|unavailable|not found|removed|copyright|region|country|age|sign in|members|invalid (video|id)/i;

function sleep(ms, signal) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(signal.reason ?? new DOMException("aborted", "AbortError"));
    const t = setTimeout(resolve, ms);
    signal?.addEventListener?.("abort", () => { clearTimeout(t); reject(signal.reason ?? new DOMException("aborted", "AbortError")); }, { once: true });
  });
}

// "<key>" or "<key>:<md5 of the RapidAPI username>"
export function parseSecret(secret) {
  const [key, xrun = null] = String(secret).split(":");
  return { key, xrun: xrun || null };
}

// the allowance seen rides along on the result (meta.quota) and on errors (err.quota), as in mp310
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
  const { key, xrun } = parseSecret(secret);

  onProgress({ stage: "converting" });
  const api = `https://${HOST}/dl?id=${encodeURIComponent(videoId)}`;
  const until = Date.now() + timing.maxWaitMs;
  let body = null;
  for (let first = true; ; first = false) {
    if (!first) await sleep(timing.pollMs, signal);
    let r;
    try {
      r = await fetch(api, { headers: { "x-rapidapi-key": key, "x-rapidapi-host": HOST }, signal });
    } catch (e) {
      if (isAbort(e, signal)) throw e;
      throw new AudioError("unavailable", `couldn't reach ${HOST} (${e.message})`);
    }
    seen.quota = readQuota(r.headers) ?? seen.quota;
    const text = await r.text().catch(() => "");
    body = null;
    try { body = JSON.parse(text); } catch { /* not JSON */ }
    const said = String(body?.msg ?? body?.message ?? body?.error ?? text).replace(/\s+/g, " ").trim().slice(0, 200);
    if (!r.ok) throw classify(r.status, said);
    const status = String(body?.status ?? "").toLowerCase();
    if (status === "ok" && typeof body.link === "string" && body.link) break;
    if (status === "processing") {
      onProgress({ stage: "converting", received: Number(body.progress) || null, total: 100 });
      if (Date.now() > until) throw new AudioError("unavailable", `the conversion didn't finish in ${Math.round(timing.maxWaitMs / 1000)} s`);
      continue;
    }
    if (NOT_FOUND.test(said)) throw new AudioError("not-found", `the API said: ${said}`);
    throw new AudioError("failed", `the API didn't deliver an MP3${said ? `: ${said}` : ""}`);
  }

  let url;
  try { url = new URL(body.link); } catch { throw new AudioError("failed", "the API's MP3 link isn't a URL"); }
  if (url.protocol !== "https:" && url.protocol !== "http:") throw new AudioError("failed", "the API's MP3 link isn't a web address");
  onProgress({ stage: "downloading", received: 0, total: null });
  let f;
  try {
    f = await fetch(url.href, { headers: xrun ? { "x-run": xrun } : {}, signal });
  } catch (e) {
    if (isAbort(e, signal)) throw e;
    throw new AudioError("unavailable", `couldn't read the file from ${url.host} (${e.message})`);
  }
  if (!f.ok) {
    const hint = f.status === 404 && !xrun ? " (its links may need the X-RUN value with the key: \"<key>:<md5 of the RapidAPI username>\")" : "";
    throw new AudioError(f.status === 404 || f.status === 410 ? "failed" : "unavailable", `the file host ${url.host} answered ${f.status}${hint}`);
  }
  const bytes = await readBody(f, signal, onProgress);
  return { bytes, format: null, provider: id, meta: { downloadHost: url.host, quota: seen.quota } };
}
