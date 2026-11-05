// The web app's Songsterr page: the bookmarklet to drag, the shared audio key (unlock, invite link,
// forget), songs arriving from the bookmarklet or a saved song file, and the form that picks tracks, video
// and audio before the song joins the conversion queue.
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
  if (!file) throw new Error("this copy of psarc2gp has no shared audio key");
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

// "#unlock=<password>" opens the key, then leaves the address (and the back history) without it.
// Call before the first route(); returns a promise of a message for the page, or null.
export function takeInviteFromAddress() {
  const m = location.hash.match(/^#unlock=(.*)$/);
  if (!m) return null;
  history.replaceState(null, "", `${location.pathname}${location.search}#/`);
  let pw;
  try { pw = decodeURIComponent(m[1]); } catch { pw = m[1]; }
  return unlock(pw).then(
    () => "Unlocked: psarc2gp can now fetch the audio of Songsterr songs in this browser.",
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
let enqueue = null; // (job) → adds a Songsterr song to the conversion queue
let current = null; // { bundle, from, info, error, inspecting }
let tracksShownFor = null; // the track list is built once per song, so re-renders keep the user's picks

// ask/enqueue come from app.js (the worker and the queue live there)
export function initSongsterrPage(options) {
  ({ ask, enqueue } = options);
  listeners.add(renderKey);
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
    if (e.target.name === "track") renderTracksNote();
  });
  renderKey();
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
    ? "The button carries the shared key's password, so the bookmark unlocks psarc2gp in any browser it's used in. Keep it to yourself."
    : "If you have the shared key's password, unlock below first and then drag the button: it then carries the password, so you're never asked again.";
}

// ------------------------------------------------------------------------- songs from Songsterr
function onMessage(e) {
  if (e.origin !== SONGSTERR_ORIGIN || !e.data || typeof e.data !== "object") return;
  const reply = (data) => { try { e.source?.postMessage(data, e.origin); } catch { /* tab gone */ } };
  if (e.data.type === "psarc2gp-hello") {
    reply({ type: "psarc2gp-ready" });
    if (!current || current.from !== "bookmarklet-wait") showWaiting();
    return;
  }
  if (e.data.type !== "psarc2gp-song") return;
  reply({ type: "psarc2gp-received" });
  const pw = e.data.password;
  if (typeof pw === "string" && pw && pw !== currentPassword()) {
    unlock(pw).catch((err) => {
      if (err.code === "password") $("ss-key-message").textContent = "The bookmark's password no longer opens the shared audio key: unlock below with the new one, then drag the button again.";
    });
  }
  openBundle(e.data.bundle, "bookmarklet");
}

function showWaiting() {
  current = { from: "bookmarklet-wait" };
  if (location.hash !== "#/songsterr") location.hash = "#/songsterr";
  renderSong();
}

export async function openSongFile(file) {
  if (location.hash !== "#/songsterr") location.hash = "#/songsterr";
  let bundle;
  try {
    bundle = JSON.parse(await file.text());
  } catch {
    current = { error: `${file.name} isn't a song file saved from Songsterr (not JSON)` };
    renderSong();
    return;
  }
  openBundle(bundle, "file");
}

async function openBundle(bundle, from) {
  if (location.hash !== "#/songsterr") location.hash = "#/songsterr";
  try {
    validateBundle(bundle);
  } catch (e) {
    current = { error: e.message };
    renderSong();
    return;
  }
  bundle.trackData ??= bundle.song.tracks.map(() => null);
  const me = (current = { bundle, from, info: null, inspecting: true });
  renderSong();
  // the tracks that would be converted by default, or the first one that can be: enough to learn the
  // played-bar count, which says which videos fit
  const pick = defaultTrackIndices(bundle);
  if (!pick.length) {
    const other = bundle.song.tracks.findIndex((t) => convertible(t));
    if (other >= 0) pick.push(other);
  }
  if (!pick.length) {
    me.error = "none of this song's tracks can be converted yet (drums and vocals come later)";
    me.inspecting = false;
    renderSong();
    return;
  }
  const answer = await ask({ kind: "songsterr-inspect", bundle, tracks: pick });
  if (current !== me) return;
  me.inspecting = false;
  if (answer.ok) {
    me.info = answer.info;
    for (const t of answer.info.trackData) bundle.trackData[t.index] = t.data;
  } else {
    me.error = answer.error;
  }
  renderSong();
}

const convertible = (t) => !t.isEmpty && !["drums", "vocals"].includes(trackKind(t));

function renderSong() {
  if (!ask) return;
  const c = current;
  $("ss-waiting").hidden = c?.from !== "bookmarklet-wait";
  $("ss-error").hidden = !c?.error;
  $("ss-error").textContent = c?.error ? `Can't convert this song: ${c.error}` : "";
  const show = !!c?.bundle;
  $("ss-form").hidden = !show;
  $("ss-intro").hidden = show || !!c;
  if (!show) return;
  const { song } = c.bundle;
  $("ss-title").textContent = `${song.artist} – ${song.title}`;
  $("ss-byline").textContent = `Songsterr song ${song.songId}, revision ${song.revisionId}` +
    (c.from === "file" ? " · from a saved file" : "") + (c.info ? ` · ${c.info.bars} bars, ${c.info.playedBars} played with repeats` : "");

  const defaults = new Set(defaultTrackIndices(c.bundle));
  if (tracksShownFor !== c) $("ss-tracks").replaceChildren(...song.tracks.map((t, i) => {
    const ok = convertible(t);
    const why = t.isEmpty ? "empty" : trackKind(t) === "drums" ? "drums: not yet" : trackKind(t) === "vocals" ? "vocals: not yet" : "";
    return el("label", { className: `check${ok ? "" : " off"}` },
      el("input", { type: "checkbox", name: "track", value: String(i), checked: ok && (defaults.has(i) || (!defaults.size && i === song.tracks.findIndex(convertible))), disabled: !ok }),
      el("span", { textContent: t.name || `Track ${i + 1}` }),
      el("span", { className: "muted", textContent: why || t.instrument || "" }));
  }));
  tracksShownFor = c;
  renderTracksNote();
  renderVideos();
  renderAudio();
}

function renderTracksNote() {
  const n = [...document.querySelectorAll('#ss-tracks input[name="track"]:checked')].length;
  $("ss-tracks-note").textContent = n ? "" : "Pick at least one track.";
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
  const RANK = { default: 0, alternative: 1, backing: 2, solo: 3, playthrough: 4 };
  const everywhere = (v) => !v.countries || v.countries.includes("All");
  const usable = c.info.videos.filter((v) => v.fit)
    .sort((a, b) => (RANK[a.feature] ?? 5) - (RANK[b.feature] ?? 5) || everywhere(b) - everywhere(a));
  let preferred = null;
  // c.info.videos carry the worker's fit (including videos with a stray point left out)
  try { preferred = chooseVideo(c.info.videos, "default", c.info.playedBars, c.info.bars).videoId; } catch { /* none fits */ }
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
    : others ? `${others} other video${others === 1 ? " was" : "s were"} synced to another revision of the tab and can't be used.` : "";
}

function renderAudio() {
  if (!current?.bundle) return;
  const choice = document.querySelector('#ss-form input[name="audio"]:checked')?.value ?? "fetch";
  $("ss-audio-file").disabled = choice !== "file";
  $("ss-audio-password").hidden = !(choice === "fetch" && !isUnlocked());
  // with no recording, a tab that no video fits still converts (without sync points)
  const busy = current.inspecting || !current.info || (choice !== "none" && !current.info.videos.some((v) => v.fit));
  $("ss-convert").disabled = busy;
}

async function convert() {
  const c = current;
  if (!c?.bundle || !c.info) return;
  const message = $("ss-convert-message");
  message.textContent = "";
  const tracks = [...document.querySelectorAll('#ss-tracks input[name="track"]:checked')].map((i) => Number(i.value));
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
  enqueue(job);
}
