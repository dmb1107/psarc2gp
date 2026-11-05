// The web app's Songsterr parts that run without a browser: the bookmarklet, built as the page builds it
// and run against a fake Songsterr page (handoff, what it copies, the fallbacks).
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";
import { buildBookmarklet, SONGSTERR_ORIGIN } from "../web/songsterr.js";
import { validateBundle } from "../src/songsterr/bundle.js";

const SOURCE = fs.readFileSync(new URL("../web/songsterr-bookmarklet.js", import.meta.url), "utf8");
const APP = "http://localhost:8765/web/";

const bookmarkletBody = (opts) => decodeURIComponent(buildBookmarklet(SOURCE, opts).slice("javascript:".length));

test("bookmarklet: one line, parses, carries the app address and the password", () => {
  const url = buildBookmarklet(SOURCE, { app: APP, password: 'pa"ss\\word' });
  assert.match(url, /^javascript:/);
  const body = bookmarkletBody({ app: APP, password: 'pa"ss\\word' });
  assert.ok(!body.includes("\n"), "joined into one line");
  assert.ok(!body.includes("__APP__") && !body.includes("__PASSWORD__"));
  assert.ok(body.includes(JSON.stringify(APP)));
  assert.ok(body.includes(JSON.stringify('pa"ss\\word')));
  assert.doesNotThrow(() => new vm.Script(body), "the one-line bookmarklet is valid JavaScript");
  assert.ok(url.length < 20000, `bookmark URL is ${url.length} characters`);
});

// A Songsterr song page, as far as the bookmarklet sees it.
function fakeSongsterr({ cached = true, pointsStatus = 200, popup = true, host = "www.songsterr.com", path = "/a/wsa/turnstile-underwater-boi-tab-s514895" } = {}) {
  const state = {
    meta: { current: { songId: 514895, revisionId: 5672979, image: "abc-def", artist: "Turnstile", title: "UNDERWATER BOI", defaultTrack: 0,
      tracks: [{ name: "Lead", instrumentId: 30, isGuitar: true }, { name: "Bass", instrumentId: 34, isBassGuitar: true }], secretField: "not copied" } },
    user: { email: "visitor@example.com", name: "Visitor" },
  };
  const points = [{ videoId: "Pb7-ICi-r8Y", feature: null, tracks: null, countries: null, points: [0.1, 2.1, 4.1], extra: "dropped" }];
  const requests = [];
  const make = (tag) => ({
    tag, style: {}, children: [], textContent: "",
    append(...c) { this.children.push(...c); }, appendChild(c) { this.children.push(c); return c; },
    remove() { this.removed = true; }, click() { this.onclick?.({ preventDefault() {} }); },
  });
  const body = make("body");
  const win = { posted: [], postMessage(data, origin) { this.posted.push({ data, origin }); } };
  const listeners = [];
  const timers = [];
  const env = {
    location: { hostname: host, pathname: path, href: `https://${host}${path}#x` },
    document: {
      body,
      createElement: make,
      getElementById: (id) => (id === "state" ? { textContent: JSON.stringify(state) } : null),
      querySelectorAll: () => [{ href: "https://d1234.cloudfront.net/" }],
    },
    window: { open: (url, name) => { env.opened = { url, name }; return popup ? win : null; }, addEventListener: (t, f) => listeners.push(f) },
    fetch: async (url, opts = {}) => {
      requests.push({ url, cache: opts.cache });
      if (opts.cache === "only-if-cached" && !cached) throw new TypeError("not cached");
      return { ok: pointsStatus === 200, status: pointsStatus, json: async () => points };
    },
    setInterval: (f) => { timers.push(f); return timers.length; }, clearInterval() {}, setTimeout: () => 0,
    URL, Blob, JSON,
  };
  const text = () => {
    const all = [];
    (function walk(e) { if (e.textContent) all.push(e.textContent); e.children?.forEach(walk); })(body);
    return all.join("\n");
  };
  return { env, win, requests, timers, text, message: (data, from = win, origin = new URL(APP).origin) => listeners.forEach((f) => f({ source: from, origin, data })) };
}

// objects made inside the vm have its own prototypes: compare their JSON
const plain = (x) => JSON.parse(JSON.stringify(x));

const run = async (page, password = "") => {
  vm.runInNewContext(bookmarkletBody({ app: APP, password }), page.env);
  for (let i = 0; i < 5; i++) await new Promise((r) => setImmediate(r)); // the points read
};

test("bookmarklet: hands the song over after the app says ready, song fields only", async () => {
  const page = fakeSongsterr();
  await run(page, "secret");
  assert.deepEqual(page.env.opened, { url: `${APP}#/songsterr`, name: "psarc2gp" });
  assert.deepEqual(page.requests, [{ url: "/api/video-points/514895/5672979/list", cache: "only-if-cached" }]);

  page.timers[0](); // the hello timer
  assert.deepEqual(plain(page.win.posted.at(-1)), { data: { type: "psarc2gp-hello" }, origin: "http://localhost:8765" });
  assert.ok(!page.win.posted.some((p) => p.data.type === "psarc2gp-song"), "nothing sent before the app is ready");

  page.message({ type: "psarc2gp-ready" }, {}); // from another window: ignored
  page.message({ type: "psarc2gp-ready" }, page.win, "https://evil.example"); // from another origin: ignored
  assert.ok(!page.win.posted.some((p) => p.data.type === "psarc2gp-song"));

  page.message({ type: "psarc2gp-ready" });
  const sent = page.win.posted.filter((p) => p.data.type === "psarc2gp-song");
  assert.equal(sent.length, 1);
  assert.equal(sent[0].origin, "http://localhost:8765");
  const { bundle, password } = sent[0].data;
  assert.equal(password, "secret");
  assert.equal(bundle.cdn, "https://d1234.cloudfront.net");
  assert.equal(bundle.page, "https://www.songsterr.com/a/wsa/turnstile-underwater-boi-tab-s514895");
  assert.deepEqual(plain(Object.keys(bundle.song).sort()), ["artist", "defaultTrack", "image", "revisionId", "songId", "title", "tracks"]);
  assert.deepEqual(plain(bundle.videos), [{ videoId: "Pb7-ICi-r8Y", feature: null, tracks: null, countries: null, points: [0.1, 2.1, 4.1] }]);
  assert.ok(!JSON.stringify(sent[0].data).includes("visitor@example.com"), "the visitor's account isn't copied");
  assert.doesNotThrow(() => validateBundle(bundle));

  page.message({ type: "psarc2gp-ready" }); // a second ready doesn't send it again
  assert.equal(page.win.posted.filter((p) => p.data.type === "psarc2gp-song").length, 1);
  page.message({ type: "psarc2gp-received" });
  assert.match(page.text(), /Sent to psarc2gp/);
});

test("bookmarklet: no password when the button was built locked", async () => {
  const page = fakeSongsterr();
  await run(page, "");
  page.message({ type: "psarc2gp-ready" });
  assert.equal(page.win.posted.find((p) => p.data.type === "psarc2gp-song").data.password, null);
});

test("bookmarklet: asks for the points once when they aren't cached", async () => {
  const page = fakeSongsterr({ cached: false });
  await run(page);
  assert.deepEqual(page.requests.map((r) => r.cache ?? null), ["only-if-cached", null]);
  assert.match(page.text(), /asked for once/);
  page.message({ type: "psarc2gp-ready" });
  assert.ok(page.win.posted.some((p) => p.data.type === "psarc2gp-song"));
});

test("bookmarklet: says what's wrong instead of sending", async () => {
  const elsewhere = fakeSongsterr({ host: "example.com" });
  await run(elsewhere);
  assert.match(elsewhere.text(), /Open a song on www\.songsterr\.com/);
  assert.equal(elsewhere.env.opened, undefined, "no tab opened");

  const blocked = fakeSongsterr({ popup: false });
  await run(blocked);
  assert.match(blocked.text(), /blocked the new tab/);
  assert.match(blocked.text(), /Save the song as a file/);

  const refused = fakeSongsterr({ cached: false, pointsStatus: 403 });
  await run(refused);
  assert.match(refused.text(), /Couldn't read the video timings \(Songsterr answered 403\)/);
  refused.message({ type: "psarc2gp-ready" });
  assert.ok(!refused.win.posted.some((p) => p.data.type === "psarc2gp-song"));
});

test("the page accepts songs from Songsterr's origin only", () => {
  assert.equal(SONGSTERR_ORIGIN, "https://www.songsterr.com");
});
