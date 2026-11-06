// The web app's Songsterr parts: on the setup page, the shared audio key (unlock, invite link, forget) and
// the bookmarklet to drag; on the Songsterr page (#/songsterr), songs arriving from the bookmarklet or a
// saved song file, and the form that picks tracks, video and audio before the song joins the conversion queue.
//
// The key: web/songsterr-secrets.json holds the audio providers' secrets encrypted with one password
// (src/songsterr/secrets.js). The password is kept in this browser's localStorage once it has opened the
// file; the key itself is decrypted when needed and kept in memory only. Everything else in the app works
// without it; only "fetch the audio for me" needs it.
//
// Nothing here touches the page at import time, so tests can import buildBookmarklet in Node.
import { decryptSecrets } from "../src/songsterr/secrets.js";
import { validateBundle, defaultTrackIndices, trackKind, songsterrOutputName } from "../src/songsterr/bundle.js";
import { chooseVideo } from "../src/songsterr/sync.js";
import audioConfig from "../src/songsterr/audio/config.js";

export const SONGSTERR_ORIGIN = "https://www.songsterr.com";
const PASSWORD_KEY = "psarc2gp.web.songsterr.password";

// ------------------------------------------------------------------------------------------ key
const store = {
  get() { try { return localStorage.getItem(PASSWORD_KEY); } catch { return null; } },
  set(v) { try { localStorage.setItem(PASSWORD_KEY, v); } catch { /* not kept: asked again next time */ } },
  clear() { try { localStorage.removeItem(PASSWORD_KEY); } catch { /* nothing kept */ } },
};
let password = null; // this page's copy, also when storage is blocked
let secrets = null;
let keyFile; // undefined: not read yet; null: this site has no key file

async function readKeyFile() {
  if (keyFile !== undefined) return keyFile;
  const r = await fetch(new URL("songsterr-secrets.json", import.meta.url), { cache: "no-cache" }).catch(() => null);
  keyFile = r?.ok ? await r.json() : r?.status === 404 ? null : undefined;
  if (keyFile === undefined) throw new Error("couldn't read the shared key file (offline?)");
  return keyFile;
}

export const hasKeyFile = async () => !!(await readKeyFile().catch(() => true));
export const currentPassword = () => password ?? store.get();
export const isUnlocked = () => !!currentPassword();

// Opens the key file with this password and keeps the password. Throws SecretsError ("password") when
// it's wrong.
export async function unlock(pw) {
  const file = await readKeyFile();
  if (!file) throw new Error("this copy of tab2gp has no shared audio key");
  secrets = await decryptSecrets(file, pw);
  password = pw;
  store.set(pw);
  changed();
  return secrets;
}

// The decrypted secrets, or null when locked. A kept password that no longer opens the file (the key was
// re-encrypted with a new one) is forgotten, so the page asks again.
export async function getSecrets() {
  if (secrets) return secrets;
  const pw = currentPassword();
  if (!pw) return null;
  try {
    return await unlock(pw);
  } catch (e) {
    if (e.code === "password") forget();
    else throw e;
    return null;
  }
}

export function forget() {
  password = null;
  secrets = null;
  store.clear();
  changed();
}

const listeners = new Set();
const changed = () => { for (const f of listeners) f(); };

// ------------------------------------------------------------------------------- the allowance
// What the audio services last said about the shared key's monthly allowance, per provider, as this browser
// saw it: { providerId: { remaining, limit, resetAt, seenAt } } (src/songsterr/audio/quota.js). The key
// is shared, so friends' fetches since then aren't counted; the setup page says so.
const QUOTA_KEY = "psarc2gp.web.songsterr.quota";
export function knownQuotas() {
  try {
    const v = JSON.parse(localStorage.getItem(QUOTA_KEY) ?? "{}");
    return v && typeof v === "object" ? v : {};
  } catch { return {}; }
}
export function rememberQuotas(quotas) {
  if (!quotas || typeof quotas !== "object" || !Object.keys(quotas).length) return;
  const all = knownQuotas();
  for (const [id, q] of Object.entries(quotas)) {
    if (Number.isFinite(q?.remaining) && !(all[id]?.seenAt > q.seenAt)) all[id] = q;
  }
  try { localStorage.setItem(QUOTA_KEY, JSON.stringify(all)); } catch { /* not kept */ }
  changed();
}

// "#unlock=<password>" opens the key, then leaves the address (and the back history) without it.
// Call before the first route(); returns a promise of a message for the page, or null.
export function takeInviteFromAddress() {
  const m = location.hash.match(/^#unlock=(.*)$/);
  if (!m) return null;
  history.replaceState(null, "", `${location.pathname}${location.search}#/`);
  let pw;
  try { pw = decodeURIComponent(m[1]); } catch { pw = m[1]; }
  return unlock(pw).then(
    () => "Unlocked: tab2gp can now fetch the audio of Songsterr songs in this browser.",
    (e) => (e.code === "password" ? "The invite link's password doesn't open the shared audio key (it may have been changed): ask for a new link." : `Couldn't use the invite link: ${e.message}`));
}

export const appAddress = () => new URL(".", location.href).href;
export const inviteLink = (pw = currentPassword()) => `${appAddress()}#unlock=${encodeURIComponent(pw)}`;

// ------------------------------------------------------------------------------------ bookmarklet
// The bookmarklet's source with the app's address and the password filled in, as a javascript: URL.
// Comments go and lines are joined (bookmarks are one line in some browsers; the source is written for it).
export function buildBookmarklet(source, { app, password: pw = "" }) {
  const body = source
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace('"__APP__"', JSON.stringify(app))
    .replace('"__PASSWORD__"', JSON.stringify(pw ?? ""))
    .split("\n").map((l) => l.trim()).filter(Boolean).join(" ");
  return `javascript:${encodeURIComponent(body)}`;
}

let bookmarkletSource = null;
const loadBookmarklet = () => (bookmarkletSource ??= fetch(new URL("songsterr-bookmarklet.js", import.meta.url)).then((r) => {
  if (!r.ok) throw new Error(`bookmarklet ${r.status}`);
  return r.text();
}));

// -------------------------------------------------------------------------------------- the page
const $ = (id) => document.getElementById(id);
function el(tag, props = {}, ...children) {
  const e = Object.assign(document.createElement(tag), props);
  e.append(...children);
  return e;
}

const FEATURE = {
  default: "Songsterr's video",
  alternative: "Another recording",
  backing: "Backing track",
  solo: "Solo",
  playthrough: "Playthrough",
};

let ask = null; // (message, transfer, onProgress) → worker answer
let enqueue = null; // (job, { show }) → adds a Songsterr song to the conversion queue (show: go to the library)
let idle = () => true; // () → nothing in this tab's conversion queue
let notify = () => {}; // (text) → the app's notice line
// The songs on this page, in arrival order, each { bundle, from, info, error, inspecting, picks, video }
// (picks and video: the user's choices, kept while another song is shown). `current` is the one in the form.
const songs = [];
let current = null;
let receiving = false; // a bookmarklet said hello; its song is on the way
let fileError = null; // a picked or dropped file that isn't a song
let tracksShownFor = null; // the track list is built once per song, so re-renders keep the user's picks

// ask/enqueue/idle/notify come from app.js (the worker and the queue live there)
export function initSongsterrPage(options) {
  ({ ask, enqueue } = options);
  idle = options.idle ?? idle;
  notify = options.notify ?? notify;
  joinTabs();
  listeners.add(renderKey);
  listeners.add(renderQuota);
  listeners.add(renderBookmarklet);
  listeners.add(renderAudio);
  window.addEventListener("message", onMessage);

  $("ss-unlock-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    await tryUnlock($("ss-password"), $("ss-key-message"));
  });
  $("ss-forget").addEventListener("click", () => {
    forget();
    $("ss-key-message").textContent = "Forgotten in this browser. Drag the bookmark button again if yours carried the password.";
  });
  $("ss-invite").addEventListener("click", async () => {
    const link = inviteLink();
    try {
      await navigator.clipboard.writeText(link);
      $("ss-key-message").textContent = "Invite link copied. Send it by direct message, not in a public place: it contains the password.";
    } catch {
      prompt("Copy this invite link (it contains the password, so send it by direct message):", link);
    }
  });
  $("ss-bookmarklet").addEventListener("click", (e) => {
    e.preventDefault();
    alert("Drag this button to your bookmarks bar, then click the bookmark on a Songsterr song page.");
  });
  $("ss-pick").addEventListener("change", (e) => {
    const [file] = e.target.files;
    e.target.value = "";
    if (file) openSongFile(file);
  });
  $("ss-form").addEventListener("submit", (e) => { e.preventDefault(); convert(); });
  $("ss-form").addEventListener("change", (e) => {
    if (e.target.name === "audio" || e.target.id === "ss-audio-file") renderAudio();
    if (e.target.name === "track") {
      if (current) current.picks = checkedTracks();
      renderTracksNote();
    }
    if (e.target.id === "ss-video" && current) current.video = e.target.value;
  });
  $("ss-convert-all").addEventListener("click", convertAll);
  renderKey();
  renderQuota();
  renderBookmarklet();
  renderSong();
}

async function tryUnlock(input, message) {
  const pw = input.value;
  if (!pw) { input.focus(); return false; }
  message.textContent = "Checking…";
  try {
    await unlock(pw);
    input.value = "";
    message.textContent = "Unlocked in this browser.";
    return true;
  } catch (e) {
    message.textContent = e.code === "password" ? "That password doesn't open the shared audio key." : e.message;
    input.select();
    return false;
  }
}

async function renderKey() {
  const unlocked = isUnlocked();
  const exists = await hasKeyFile();
  $("ss-key-none").hidden = exists;
  $("ss-key-locked").hidden = !exists || unlocked;
  $("ss-key-unlocked").hidden = !exists || !unlocked;
}

// "Audio fetches left this month": one line per audio service, main one first
export function quotaLines(quotas, now = Date.now()) {
  const day = (t) => new Date(t).toLocaleDateString(undefined, { day: "numeric", month: "short" });
  const seen = (t) => (new Date(t).toDateString() === new Date(now).toDateString()
    ? `today, ${new Date(t).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" })}` : day(t));
  const ids = audioConfig.providers.filter((id) => id !== "file");
  return ids.filter((id) => quotas[id]).map((id) => {
    const q = quotas[id];
    const name = id === ids[0] ? "Main service" : "Backup service";
    if (q.resetAt != null && q.resetAt <= now) return `${name}: renewed on ${day(q.resetAt)} (${q.remaining} were left on ${day(q.seenAt)}); the new count shows after the next fetch`;
    const left = q.limit != null ? `${q.remaining} of ${q.limit} left` : `${q.remaining} left`;
    return `${name}: ${left}${q.resetAt != null ? `, renews on ${day(q.resetAt)}` : ""} (as of ${seen(q.seenAt)})`;
  });
}

async function renderQuota() {
  const box = $("ss-quota");
  const lines = quotaLines(knownQuotas());
  box.hidden = !(await hasKeyFile()) || (!lines.length && !isUnlocked());
  $("ss-quota-list").replaceChildren(...lines.map((t) => el("li", { textContent: t })));
  $("ss-quota-list").hidden = !lines.length;
  $("ss-quota-note").textContent = lines.length
    ? "Counted when this browser last fetched a song's audio: songs your friends fetched since then aren't in it. When the main service runs out, the backup takes over."
    : "Not known in this browser yet: it shows here after tab2gp fetches a song's audio.";
}

async function renderBookmarklet() {
  const link = $("ss-bookmarklet");
  try {
    link.href = buildBookmarklet(await loadBookmarklet(), { app: appAddress(), password: currentPassword() ?? "" });
    link.removeAttribute("aria-disabled");
  } catch (e) {
    link.removeAttribute("href");
    link.setAttribute("aria-disabled", "true");
  }
  $("ss-bookmarklet-key").textContent = isUnlocked()
    ? "The button carries the shared key's password, so the bookmark unlocks tab2gp in any browser it's used in. Keep it to yourself."
    : "If you have the shared key's password, unlock above first and then drag the button: it then carries the password, so you're never asked again.";
}

// ------------------------------------------------------------------------- songs from Songsterr
// One tab for many songs: every click on the bookmark opens a tab2gp tab. When another tab2gp tab is
// already open, the new one hands the song to it and closes itself, so a dozen songs end up on one page.
// The tab that takes songs is the oldest open one (it holds the MAIN_LOCK Web Lock; the next one in line
// takes over when it closes). A main tab that doesn't answer within HANDOVER_MS (frozen by the browser in
// the background) is passed over: the new tab keeps the song, and the late main tab ignores it.
const TABS_CHANNEL = "psarc2gp-tabs";
const MAIN_LOCK = "psarc2gp-main";
export const HANDOVER_MS = 2000;
let channel = null;
let isMain = true;
let mainKnown = Promise.resolve();
let openedByBookmark = false; // this tab was opened by the bookmarklet (and may close itself)

function joinTabs() {
  openedByBookmark = !!window.opener && location.hash === "#/songsterr";
  if (typeof BroadcastChannel !== "function" || !navigator.locks) return; // every tab keeps its own songs
  channel = new BroadcastChannel(TABS_CHANNEL);
  channel.addEventListener("message", onTabMessage);
  const hold = () => new Promise(() => {}); // held until the tab closes
  mainKnown = new Promise((known) => {
    navigator.locks.request(MAIN_LOCK, { ifAvailable: true }, (lock) => {
      isMain = !!lock;
      known();
      if (lock) return hold();
      navigator.locks.request(MAIN_LOCK, () => { isMain = true; renderSong(); return hold(); });
      return null;
    }).catch(() => { isMain = true; known(); });
  });
}

function onTabMessage({ data }) {
  if (!isMain || data?.type !== "song" || !(Date.now() - data.sentAt < HANDOVER_MS)) return;
  channel.postMessage({ type: "taken", id: data.id });
  takeSong(data.bundle, data.password, { handedOver: true });
}

// → true once the main tab has taken it
function handOver(bundle, password) {
  return new Promise((resolve) => {
    const id = crypto.randomUUID();
    const done = (taken) => { clearTimeout(timer); channel.removeEventListener("message", taken_); resolve(taken); };
    const taken_ = ({ data }) => { if (data?.type === "taken" && data.id === id) done(true); };
    const timer = setTimeout(() => done(false), HANDOVER_MS);
    channel.addEventListener("message", taken_);
    channel.postMessage({ type: "song", id, sentAt: Date.now(), bundle, password });
  });
}

async function onMessage(e) {
  if (e.origin !== SONGSTERR_ORIGIN || !e.data || typeof e.data !== "object") return;
  const reply = (data) => { try { e.source?.postMessage(data, e.origin); } catch { /* tab gone */ } };
  if (e.data.type === "psarc2gp-hello") {
    reply({ type: "psarc2gp-ready" });
    if (!receiving) showWaiting();
    return;
  }
  if (e.data.type !== "psarc2gp-song") return;
  const { bundle, password: pw } = e.data;
  await mainKnown;
  // only a tab that has nothing else to do passes songs on (one the user works in keeps what it's sent)
  if (!isMain && channel && openedByBookmark && !songs.length && idle() && await handOver(bundle, pw)) {
    reply({ type: "psarc2gp-received" });
    receiving = false;
    window.close(); // allowed: the bookmarklet opened this tab
    // still open (the browser kept it)
    $("ss-notice").textContent = `Sent ${songName(bundle)} to the tab2gp tab that was already open. You can close this one.`;
    renderSong();
    return;
  }
  reply({ type: "psarc2gp-received" });
  takeSong(bundle, pw);
}

function takeSong(bundle, pw, { handedOver = false } = {}) {
  if (typeof pw === "string" && pw && pw !== currentPassword()) {
    unlock(pw).catch((err) => {
      if (err.code === "password") $("ss-notice").textContent = "The bookmark's password no longer opens the shared audio key: unlock with the new one on the Setup page, then drag the button again.";
    });
  }
  // a song handed over from another tab doesn't stop the song playing here
  const show = !(handedOver && location.hash.startsWith("#/play/"));
  if (!show) notify(`${songName(bundle)} from Songsterr is waiting on the Songsterr page (Songs waiting, at the top).`);
  openBundle(bundle, "bookmarklet", { show, select: !handedOver });
}

const songName = (bundle) => {
  const s = bundle?.song;
  return s?.artist || s?.title ? `“${[s.artist, s.title].filter(Boolean).join(" – ")}”` : "the song";
};

function showPage() {
  if (location.hash !== "#/songsterr") location.hash = "#/songsterr";
}

function showWaiting() {
  receiving = true;
  showPage();
  renderSong();
}

export async function openSongFile(file) {
  showPage();
  let bundle;
  try {
    bundle = JSON.parse(await file.text());
  } catch {
    fileError = `${file.name} isn't a song file saved from Songsterr (not JSON)`;
    renderSong();
    return;
  }
  openBundle(bundle, "file");
}

// show: go to the Songsterr page; select: show this song in the form (a song handed over from another
// tab only when the form is empty, so it doesn't replace the one being looked at)
async function openBundle(bundle, from, { show = true, select = true } = {}) {
  if (show) showPage();
  receiving = false;
  fileError = null;
  try {
    validateBundle(bundle);
  } catch (e) {
    fileError = e.message;
    renderSong();
    return;
  }
  const same = songs.find((s) => s.bundle.song.songId === bundle.song.songId && s.bundle.song.revisionId === bundle.song.revisionId);
  if (same) {
    if (select || !current) current = same;
    renderSong();
    return;
  }
  bundle.trackData ??= bundle.song.tracks.map(() => null);
  const me = { bundle, from, info: null, inspecting: true };
  songs.push(me);
  if (select || !current) current = me;
  renderSong();
  // the tracks converted by default (every one with notes): they give the played-bar count, which says
  // which videos fit, and are kept for the conversion
  const pick = defaultTrackIndices(bundle);
  if (!pick.length) {
    me.error = "all of this song's tracks are empty";
    me.inspecting = false;
    renderSong();
    return;
  }
  const answer = await ask({ kind: "songsterr-inspect", bundle, tracks: pick });
  me.inspecting = false;
  if (answer.ok) {
    me.info = answer.info;
    for (const t of answer.info.trackData) bundle.trackData[t.index] = t.data;
  } else {
    me.error = answer.error;
  }
  renderSong();
}

// the song leaves the page (converted or removed); the next one takes its place in the form
function dropSong(s) {
  const i = songs.indexOf(s);
  if (i < 0) return;
  songs.splice(i, 1);
  if (current === s) current = songs[i] ?? songs[i - 1] ?? null;
}

// the videos that fit, in the order the form lists them; the suggested one: chooseVideo's pick, else the first
const RANK = { default: 0, alternative: 1, backing: 2, solo: 3, playthrough: 4 };
const everywhere = (v) => !v.countries || v.countries.includes("All");
const usableVideos = (info) => info.videos.filter((v) => v.fit)
  .sort((a, b) => (RANK[a.feature] ?? 5) - (RANK[b.feature] ?? 5) || everywhere(b) - everywhere(a));
function suggestedVideo(info) {
  // info.videos carry the worker's fit (including videos with a stray point left out)
  try { return chooseVideo(info.videos, "default", info.playedBars, info.bars).videoId; } catch { /* none fits */ }
  return usableVideos(info)[0]?.videoId ?? "";
}
const pickedTracks = (s) => s.picks ?? defaultTrackIndices(s.bundle).filter((i) => convertible(s.bundle.song.tracks[i]));
// ready for "Convert all": read, and a video fits
const ready = (s) => !!s.info && !s.error && usableVideos(s.info).length > 0 && pickedTracks(s).length > 0;

export const pageTitle = () => `${songs.length > 1 ? `(${songs.length}) ` : ""}Songs from Songsterr · tab2gp`;

const convertible = (t) => !t.isEmpty;
const checkedTracks = () => [...document.querySelectorAll('#ss-tracks input[name="track"]:checked')].map((i) => Number(i.value));

function renderSong() {
  if (!ask) return;
  const c = current;
  $("ss-waiting").hidden = !receiving;
  const error = c?.error ?? fileError;
  $("ss-error").hidden = !error;
  $("ss-error").textContent = error ? `Can't convert this song: ${error}` : "";
  renderList();
  const show = !!c?.bundle;
  $("ss-form").hidden = !show;
  $("ss-empty").hidden = show || receiving || !!error;
  if (!show) return;
  const { song } = c.bundle;
  $("ss-title").textContent = `${song.artist} – ${song.title}`;
  $("ss-byline").textContent = `Songsterr song ${song.songId}, revision ${song.revisionId}` +
    (c.from === "file" ? " · from a saved file" : "") + (c.info ? ` · ${c.info.bars} bars, ${c.info.playedBars} played with repeats` +
      (c.info.emptyBarsLeftOut ? ` (and ${c.info.emptyBarsLeftOut} empty bars at the end, left out)` : "") : "");

  if (tracksShownFor !== c) {
    const picked = new Set(pickedTracks(c));
    $("ss-tracks").replaceChildren(...song.tracks.map((t, i) => {
      const ok = convertible(t);
      const why = t.isEmpty ? "empty" : trackKind(t) === "vocals" ? "vocals: notes and lyrics" : "";
      return el("label", { className: `check${ok ? "" : " off"}` },
        el("input", { type: "checkbox", name: "track", value: String(i), checked: ok && picked.has(i), disabled: !ok }),
        el("span", { textContent: t.name || `Track ${i + 1}` }),
        el("span", { className: "muted", textContent: why || t.instrument || "" }));
    }));
    // another song: an audio file picked for the last one isn't this one's
    $("ss-audio-file").value = "";
    $("ss-convert-message").textContent = "";
  }
  tracksShownFor = c;
  renderTracksNote();
  renderVideos();
  renderAudio();
}

// "Songs waiting": shown with two songs or more, one line each; a click shows that song in the form
function renderList() {
  const box = $("ss-songs");
  box.hidden = songs.length < 2;
  const nav = $("nav-songsterr");
  nav.hidden = !songs.length;
  nav.textContent = `Songs waiting: ${songs.length}`;
  if (location.hash === "#/songsterr") document.title = pageTitle();
  if (box.hidden) return;
  $("ss-songs-title").textContent = `${songs.length} songs waiting`;
  $("ss-songs-list").replaceChildren(...songs.map((s) => {
    const state = s.inspecting ? "Reading the tab…" : s.error ? "Can't convert" : !s.info ? "" :
      !usableVideos(s.info).length ? "No video fits" : !pickedTracks(s).length ? "No track picked" : "Ready";
    const li = el("li", { className: s === current ? "current" : "" },
      el("button", { type: "button", className: "link", textContent: `${s.bundle.song.artist} – ${s.bundle.song.title}`,
        onclick: () => { current = s; renderSong(); } }),
      el("span", { className: `muted${state === "Ready" ? "" : " warn"}`, textContent: state }),
      el("button", { type: "button", className: "quiet", title: "Remove from this list", textContent: "×",
        onclick: () => { dropSong(s); renderSong(); } }));
    if (s === current) li.setAttribute("aria-current", "true");
    return li;
  }));
  const n = songs.filter(ready).length;
  const all = $("ss-convert-all");
  all.textContent = n === songs.length ? `Convert all ${n}` : `Convert the ${n} ready`;
  all.disabled = !n || !isUnlocked();
  $("ss-songs-note").textContent = !isUnlocked()
    ? "Converting them all at once fetches each song's audio for you: unlock the shared audio key first (on the Setup page). Or convert them one by one with your own audio files."
    : "Each with the tracks and video picked for it (the suggested ones unless you changed them), and the video's audio fetched for you.";
}

function renderTracksNote() {
  $("ss-tracks-note").textContent = checkedTracks().length ? "" : "Pick at least one track.";
}

function renderVideos() {
  const c = current;
  const select = $("ss-video");
  if (!c.info) {
    select.replaceChildren(el("option", { textContent: c.inspecting ? "Reading the tab…" : "—" }));
    select.disabled = true;
    $("ss-video-note").textContent = "";
    return;
  }
  const usable = usableVideos(c.info);
  const preferred = c.video ?? suggestedVideo(c.info);
  const names = c.bundle.song.tracks.map((t) => t.name);
  select.replaceChildren(...(usable.length ? [] : [el("option", { value: "", textContent: "No video fits" })]), ...usable.map((v) => {
    const parts = [FEATURE[v.feature] ?? v.feature];
    if (v.feature === "backing" && v.leavesOut?.length) parts.push(`without ${v.leavesOut.map((i) => names[i] ?? `track ${i + 1}`).join(", ")}`);
    if (!everywhere(v)) parts.push(v.countries.length <= 3 ? `only in ${v.countries.join(", ")}` : `only in ${v.countries.length} countries`);
    if (v.fit === "written") parts.push("repeats timed from their first pass");
    if (v.strayPoint != null) parts.push("one stray sync point left out");
    return el("option", { value: v.videoId, textContent: `${parts.join(", ")} (${v.videoId})`, selected: v.videoId === preferred });
  }));
  select.disabled = !usable.length;
  const others = c.info.videos.length - usable.length;
  $("ss-video-note").textContent = !usable.length
    ? `None of the ${c.info.videos.length} videos fits this revision of the tab (they were synced to another one), so the recording can't be synced. Choose "No recording" to convert the tab on its own, or try another revision on Songsterr.`
    : [c.info.emptyBarsLeftOut && `The tab's last ${c.info.emptyBarsLeftOut} bars are rests on every track and the videos' sync stops before them, so they're left out; rest bars carry the recording to its end.`,
      others && `${others} other video${others === 1 ? " was" : "s were"} synced to another revision of the tab and can't be used.`].filter(Boolean).join(" ");
}

function renderAudio() {
  if (!current?.bundle) return;
  const choice = document.querySelector('#ss-form input[name="audio"]:checked')?.value ?? "fetch";
  $("ss-audio-file").disabled = choice !== "file";
  $("ss-audio-password").hidden = !(choice === "fetch" && !isUnlocked());
  // with no recording, a tab that no video fits still converts (without sync points)
  const busy = current.inspecting || !current.info || (choice !== "none" && !current.info.videos.some((v) => v.fit));
  $("ss-convert").disabled = busy;
  if (songs.length > 1) renderList(); // "Convert all" waits for the key
}

// the song goes to the conversion queue; with more songs waiting the page stays, showing the next one
function send(s, job) {
  dropSong(s);
  enqueue(job, { show: !songs.length });
  if (songs.length) $("ss-notice").textContent = `${songName(s.bundle)} is converting: follow it in the library.`;
  renderSong();
}

async function convert() {
  const c = current;
  if (!c?.bundle || !c.info) return;
  const message = $("ss-convert-message");
  message.textContent = "";
  const tracks = checkedTracks();
  if (!tracks.length) { message.textContent = "Pick at least one track."; return; }
  const video = $("ss-video").value;
  const choice = document.querySelector('#ss-form input[name="audio"]:checked')?.value ?? "fetch";
  const job = { bundle: c.bundle, tracks, video, audio: choice, name: songsterrOutputName(c.bundle.song) };
  if (choice === "file") {
    const [file] = $("ss-audio-file").files;
    if (!file) { message.textContent = "Choose the audio file (.mp3 or .m4a) first."; return; }
    job.file = file;
  }
  if (choice === "fetch") {
    if (!isUnlocked() && !(await tryUnlock($("ss-password-inline"), message))) return;
    try {
      job.secrets = await getSecrets();
    } catch (e) {
      message.textContent = e.message;
      return;
    }
    if (!job.secrets) { message.textContent = "The kept password no longer opens the shared audio key: enter the new one."; renderAudio(); return; }
  }
  if (current !== c) return; // another song was picked while the key was opened
  send(c, job);
}

// every ready song, each with its own picks (or the suggested ones) and the audio fetched
async function convertAll() {
  const note = $("ss-songs-note");
  let secrets;
  try {
    secrets = await getSecrets();
  } catch (e) {
    note.textContent = e.message;
    return;
  }
  if (!secrets) { note.textContent = "The kept password no longer opens the shared audio key: unlock with the new one on the Setup page."; renderAudio(); return; }
  const waiting = songs.length;
  const go = songs.filter(ready);
  for (const s of go) {
    dropSong(s);
    enqueue({ bundle: s.bundle, tracks: pickedTracks(s), video: s.video ?? suggestedVideo(s.info), audio: "fetch", secrets, name: songsterrOutputName(s.bundle.song) },
      { show: !songs.length });
  }
  if (songs.length) $("ss-notice").textContent = `${go.length} of ${waiting} songs are converting (follow them in the library); the ones left here need a look.`;
  renderSong();
}
