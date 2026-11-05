// Songsterr audio: providers, fallback, checks, the encrypted key file. No network: every provider runs
// against a fake fetch with answers shaped like the real ones (JSON and headers only; audio bodies are
// synthetic frames written here, no recordings in git).
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { getAudio, PROVIDERS, needsSecrets, AudioError, describeAudioError, AUDIO_ERROR_CODES, config } from "../src/songsterr/audio/index.js";
import { encryptSecrets, decryptSecrets } from "../src/songsterr/secrets.js";
import { convertSongsterr } from "../src/songsterr/convert.js";

// MPEG-1 layer III, 128 kbit/s, 44.1 kHz frames: 1152 samples each (~26 ms)
function mp3(frames) {
  const out = new Uint8Array(417 * frames);
  for (let i = 0; i < frames; i++) out.set([0xff, 0xfb, 0x90, 0x00], 417 * i);
  return out;
}
const MP3_10S = mp3(Math.ceil((10 * 44100) / 1152));
const WEBM = Uint8Array.from([0x1a, 0x45, 0xdf, 0xa3, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]);
const VIDEO = "dQw4w9WgXcQ";

const json = (status, body, headers = {}) => () => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });
const bytes = (b, status = 200) => () => new Response(b, { status, headers: { "content-length": String(b.length) } });
const offline = () => { throw new TypeError("fetch failed"); };

// a fake fetch: the first matching route answers; every request is recorded
function fakeFetch(routes) {
  const calls = [];
  const f = async (url, init = {}) => {
    calls.push({ url: String(url), headers: init.headers ?? {} });
    for (const [prefix, answer] of routes) if (String(url).startsWith(prefix)) return answer();
    throw new Error(`unexpected request ${url}`);
  };
  f.calls = calls;
  return f;
}

// ---- the provider contract: every provider that fetches audio itself must pass these scenarios.
// Adding a provider means adding its fake answers here (the test below fails until you do).

const API = "https://youtube-mp310.p.rapidapi.com/";
const FILE = "https://files.example/";
const SCENARIOS = {
  "rapidapi-youtube-mp310": {
    secret: "test-key-123",
    ok: (audio) => fakeFetch([[API, json(200, { downloadUrl: `${FILE}a.mp3` }, { "x-ratelimit-requests-remaining": "41" })], [FILE, bytes(audio)]]),
    auth: () => fakeFetch([[API, json(403, { message: "You are not subscribed to this API." })]]),
    quota: () => fakeFetch([[API, json(429, { message: "You have exceeded the MONTHLY quota for Requests on your current plan, BASIC." })]]),
    "not-found": () => fakeFetch([[API, json(200, { error: "Video unavailable" })]]),
    unavailable: () => fakeFetch([[API, offline]]),
  },
};

test("every fetching provider has contract scenarios and the shared shape", () => {
  for (const p of Object.values(PROVIDERS)) {
    assert.equal(typeof p.id, "string");
    assert.equal(typeof p.label, "string");
    assert.equal(typeof p.needsSecret, "boolean");
    assert.equal(typeof p.fetchAudio, "function");
    if (p.id !== "file") assert.ok(SCENARIOS[p.id], `no contract scenarios for provider ${p.id}`);
  }
  for (const id of config.providers) assert.ok(PROVIDERS[id], `config names unknown provider ${id}`);
  assert.ok(config.providers.includes("file"), "a dropped file must always be offered");
});

for (const [id, s] of Object.entries(SCENARIOS)) {
  const run = (fetch, extra = {}) => getAudio(VIDEO, { providers: [id], secrets: { [id]: s.secret }, fetch, ...extra });

  test(`provider ${id}: delivers checked audio, key never in a URL`, async () => {
    const fetch = s.ok(MP3_10S);
    const progress = [];
    const a = await run(fetch, { minSeconds: 9, onProgress: (e) => progress.push(e) });
    assert.equal(a.provider, id);
    assert.equal(a.format, "mp3");
    assert.ok(Math.abs(a.seconds - 10) < 0.05);
    assert.equal(a.offsetMs, config.offsets[id] ?? 0);
    assert.deepEqual(a.bytes, MP3_10S);
    assert.ok(progress.every((e) => e.provider === id) && progress.some((e) => e.stage === "downloading"));
    for (const c of fetch.calls) assert.ok(!c.url.includes(s.secret), "the key must not be in a URL");
  });

  for (const code of ["auth", "quota", "not-found", "unavailable"]) {
    test(`provider ${id}: ${code} answers become AudioError "${code}"`, async () => {
      await assert.rejects(run(s[code]()), (e) => e instanceof AudioError && e.code === code && e.provider === id);
    });
  }

  test(`provider ${id}: wrong format and too-short audio are refused as "failed"`, async () => {
    await assert.rejects(run(s.ok(WEBM)), (e) => e.code === "failed" && /webm audio isn't supported: Guitar Pro 8 plays MP3 and M4A/.test(e.message));
    await assert.rejects(run(s.ok(MP3_10S), { minSeconds: 30 }), (e) => e.code === "failed" && /10\.0 s long but the tab's last bar starts at 30\.0 s/.test(e.message));
  });

  test(`provider ${id}: no key means auth with missingSecret, and nothing is requested`, async () => {
    const fetch = s.ok(MP3_10S);
    await assert.rejects(getAudio(VIDEO, { providers: [id], secrets: {}, fetch }), (e) => e.code === "auth" && e.missingSecret);
    assert.equal(fetch.calls.length, 0);
  });

  test(`provider ${id}: cancelling stops it`, async () => {
    const ac = new AbortController();
    ac.abort();
    const fetch = async (url, init) => { init.signal.throwIfAborted(); throw new Error("not reached"); };
    await assert.rejects(run(fetch, { signal: ac.signal }), (e) => e.name === "AbortError");
  });
}

test("RapidAPI: the key goes in the RapidAPI headers, other answers map to codes", async () => {
  const id = "rapidapi-youtube-mp310";
  const run = (routes) => getAudio(VIDEO, { providers: [id], secrets: { [id]: "k" }, fetch: fakeFetch(routes) });
  const f = SCENARIOS[id].ok(MP3_10S);
  const a = await getAudio(VIDEO, { providers: [id], secrets: { [id]: "k" }, fetch: f });
  assert.equal(f.calls[0].headers["x-rapidapi-key"], "k");
  assert.equal(f.calls[0].headers["x-rapidapi-host"], "youtube-mp310.p.rapidapi.com");
  assert.ok(f.calls[0].url.includes(encodeURIComponent(`https://www.youtube.com/watch?v=${VIDEO}`)));
  assert.equal(a.meta.quotaRemaining, 41);
  assert.equal(a.meta.downloadHost, "files.example");
  await assert.rejects(run([[API, json(401, { message: "Invalid API key." })]]), { code: "auth" });
  await assert.rejects(run([[API, json(429, { message: "Too many requests" })]]), { code: "unavailable" });
  await assert.rejects(run([[API, json(400, { message: "Invalid video" })]]), { code: "not-found" });
  await assert.rejects(run([[API, json(502, { message: "Bad gateway" })]]), { code: "unavailable" });
  await assert.rejects(run([[API, json(200, { status: "processing" })]]), (e) => e.code === "failed" && /no download link/.test(e.message));
  await assert.rejects(run([[API, json(200, { downloadUrl: "javascript:alert(1)" })]]), { code: "failed" });
  await assert.rejects(run([[API, json(200, { downloadUrl: `${FILE}x` })], [FILE, bytes(new Uint8Array(1), 503)]]), { code: "unavailable" });
  await assert.rejects(run([[API, json(200, { downloadUrl: `${FILE}x` })], [FILE, offline]]), { code: "unavailable" });
  await assert.rejects(getAudio("not a video", { providers: [id], secrets: { [id]: "k" }, fetch: offline }), { code: "not-found" });
});

// ---- fallback order and the file provider

test("fallback: unavailable/failed go on to the next provider, auth/quota/not-found stop", async () => {
  const id = "rapidapi-youtube-mp310";
  const s = SCENARIOS[id];
  // down, no file given: the service's error is reported, with a file offered
  let e = await getAudio(VIDEO, { secrets: { [id]: "k" }, fetch: s.unavailable() }).catch((x) => x);
  assert.equal(e.code, "unavailable");
  assert.equal(e.provider, id);
  assert.equal(e.fileFallback, true);
  assert.deepEqual(e.attempts.map((a) => a.provider), [id, "file"]);
  // a bad key stops at once (another provider wouldn't help, and the user should hear about the key)
  e = await getAudio(VIDEO, { secrets: { [id]: "k" }, fetch: s.auth() }).catch((x) => x);
  assert.equal(e.code, "auth");
  assert.deepEqual(e.attempts.map((a) => a.provider), [id]);
  assert.match(describeAudioError(e), /refused the key/);
  for (const code of AUDIO_ERROR_CODES) assert.ok(describeAudioError(new AudioError(code, "x")).length > 10);
});

test("a given file is used on its own, checked like any provider's audio", async () => {
  const fetch = fakeFetch([]);
  const a = await getAudio(VIDEO, { file: { bytes: MP3_10S, name: "song.mp3" }, fetch });
  assert.equal(a.provider, "file");
  assert.equal(a.meta.name, "song.mp3");
  assert.equal(fetch.calls.length, 0);
  await assert.rejects(getAudio(VIDEO, { file: { bytes: WEBM } }), { code: "failed" });
  await assert.rejects(getAudio(VIDEO, { providers: ["file"] }), (e) => e.noFile && describeAudioError(e) === "no audio file given");
  assert.equal(needsSecrets(["file"]), false);
  assert.equal(needsSecrets(), true);
  await assert.rejects(getAudio(VIDEO, { providers: ["nope"] }), /unknown audio provider "nope"/);
});

test("convert: an audio function is called with the chosen video and its last point", async () => {
  const b = {
    kind: "psarc2gp-songsterr", version: 1, cdn: "https://cdn.example",
    song: { songId: 1, revisionId: 2, image: "img", artist: "A", title: "T", tracks: [{ name: "Bass", instrumentId: 34, tuning: [43, 38, 33, 28] }] },
    videos: [{ videoId: "v1", feature: null, points: [1, 3] }],
    trackData: [{ name: "Bass", instrumentId: 34, tuning: [43, 38, 33, 28], strings: 4, songId: 1, revisionId: 2,
      automations: { tempo: [{ measure: 0, position: 0, bpm: 120, type: 4 }] },
      measures: [1, 2].map(() => ({ signature: [4, 4], voices: [{ beats: [{ type: 1, duration: [1, 1], rest: true, notes: [{ rest: true }] }] }] })) }],
  };
  let asked = null;
  const r = await convertSongsterr(b, { audio: async (v) => { asked = v; return getAudio(v.videoId, { file: { bytes: MP3_10S }, minSeconds: v.lastPoint }); } });
  assert.deepEqual(asked, { videoId: "v1", feature: "default", lastPoint: 3 });
  assert.equal(r.report.audioProvider, "file");
  assert.equal(r.meta.audioProvider, "file");
  assert.ok(r.report.audioSeconds > 9.9);
});

// ---- the encrypted key file

test("secrets: round trip, wrong password, tampering, and nothing readable in the file", async () => {
  const secrets = { "rapidapi-youtube-mp310": "abcdef0123456789abcdef0123456789abcdef0123456789ab" };
  const enc = await encryptSecrets(secrets, "pw", { iterations: 1000 });
  const text = JSON.stringify(enc);
  assert.ok(!text.includes("abcdef0123") && !text.includes("rapidapi"), "plain key or provider name in the file");
  assert.deepEqual(await decryptSecrets(enc, "pw"), secrets);
  await assert.rejects(decryptSecrets(enc, "PW"), { code: "password", message: "wrong password" });
  await assert.rejects(decryptSecrets(enc, ""), { code: "password" });
  const data = Uint8Array.from(atob(enc.data), (c) => c.charCodeAt(0));
  data[0] ^= 1;
  await assert.rejects(decryptSecrets({ ...enc, data: btoa(String.fromCharCode(...data)) }, "pw"), { code: "password" });
  await assert.rejects(decryptSecrets({ ...enc, version: 2 }, "pw"), { code: "format" });
  await assert.rejects(decryptSecrets({ kind: "other" }, "pw"), { code: "format" });
  // a fresh salt and IV each time
  const again = await encryptSecrets(secrets, "pw", { iterations: 1000 });
  assert.notEqual(again.salt, enc.salt);
  assert.notEqual(again.data, enc.data);
  await assert.rejects(encryptSecrets({}, "pw"), /no secrets/);
});

test("tools/encrypt-secrets.js writes, keeps keys on Enter, changes the password", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "psarc2gp-secrets-"));
  try {
    const file = path.join(dir, "s.json");
    const tool = path.join(import.meta.dirname, "..", "tools", "encrypt-secrets.js");
    const run = (input) => spawnSync(process.execPath, [tool, "--file", file, "--iterations", "1000"], { input, encoding: "utf8", timeout: 20000 });
    let r = run("key-one\npw1\npw1\n");
    assert.equal(r.status, 0, r.stderr);
    assert.deepEqual(await decryptSecrets(JSON.parse(fs.readFileSync(file, "utf8")), "pw1"), { "rapidapi-youtube-mp310": "key-one" });
    r = run("pw1\n\npw2\npw2\n"); // keep the key, new password
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stderr, /revokes nothing/);
    assert.deepEqual(await decryptSecrets(JSON.parse(fs.readFileSync(file, "utf8")), "pw2"), { "rapidapi-youtube-mp310": "key-one" });
    r = run("wrong\nwrong\nwrong\n");
    assert.equal(r.status, 1);
    r = run("pw2\nkey-two\nnew\nother\n"); // confirmation differs
    assert.equal(r.status, 1);
    assert.match(r.stderr, /differ; nothing written/);
  } finally {
    fs.rmSync(dir, { recursive: true });
  }
});

// ---- CLI paths that need no network

test("CLI: fetching audio asks for the key file and password, and says how to do without", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "psarc2gp-songsterr-audio-"));
  try {
    const f = path.join(dir, "song.json");
    fs.writeFileSync(f, JSON.stringify({
      kind: "psarc2gp-songsterr", version: 1, cdn: "https://cdn.example",
      song: { songId: 1, revisionId: 2, image: "img", artist: "A", title: "T", tracks: [{ name: "Bass", instrumentId: 34, tuning: [43, 38, 33, 28] }] },
      videos: [{ videoId: "v1", feature: null, points: [1, 3] }],
      trackData: [{ name: "Bass", instrumentId: 34, tuning: [43, 38, 33, 28], strings: 4, songId: 1, revisionId: 2,
        automations: { tempo: [{ measure: 0, position: 0, bpm: 120, type: 4 }] },
        measures: [1, 2].map(() => ({ signature: [4, 4], voices: [{ beats: [{ type: 1, duration: [1, 1], rest: true, notes: [{ rest: true }] }] }] })) }],
    }));
    const secrets = path.join(dir, "secrets.json");
    const cli = path.join(import.meta.dirname, "..", "bin", "psarc2gp.js");
    const run = (env, ...args) => {
      const e = { ...process.env, PSARC2GP_SECRETS: secrets, ...env };
      delete e.PSARC2GP_PASSWORD;
      if (env.PSARC2GP_PASSWORD) e.PSARC2GP_PASSWORD = env.PSARC2GP_PASSWORD;
      return spawnSync(process.execPath, [cli, ...args], { encoding: "utf8", timeout: 20000, env: e, input: "" });
    };
    let r = run({}, f);
    assert.equal(r.status, 1);
    assert.match(r.stderr, /doesn't exist yet \(tools\/encrypt-secrets\.js writes it\); or give the audio with --audio <file/);
    fs.writeFileSync(secrets, JSON.stringify(await encryptSecrets({ "rapidapi-youtube-mp310": "k" }, "right", { iterations: 1000 })));
    r = run({}, f);
    assert.match(r.stderr, /needs the password: set PSARC2GP_PASSWORD/);
    r = run({ PSARC2GP_PASSWORD: "wrong" }, f);
    assert.match(r.stderr, /wrong password for the shared audio key/);
    r = run({}, "--audio-provider", "file", f);
    assert.match(r.stderr, /no audio file given/);
    r = run({}, "--audio-provider", "nope", f);
    assert.equal(r.status, 2);
    assert.match(r.stderr, /unknown audio provider "nope"/);
    // a file needs no password
    const audio = path.join(dir, "a.mp3");
    fs.writeFileSync(audio, MP3_10S);
    r = run({}, "--audio", audio, f);
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /0:10 of audio\n/);
    r = run({}, "-f", "--nudge", "40", "--audio", audio, f);
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /sync shifted 40 ms \(40 nudge\)/);
    r = run({}, "--nudge", "soon", "--audio", audio, f);
    assert.equal(r.status, 2);
  } finally {
    fs.rmSync(dir, { recursive: true });
  }
});
