// psarc2gp in the browser: convert Rocksmith .psarc files into Guitar Pro files, keep them in a library
// in this browser, and practise with them. Everything runs on this computer; nothing is uploaded.
import { Player } from "./player.js";
import { allSongs, deleteSong, getFile, getSong, isPersistent, putSong, songId, storageEstimate, updateSong } from "./library.js";

const $ = (id) => document.getElementById(id);
const prefs = {
  get(key) { try { return localStorage.getItem(`psarc2gp.web.${key}`); } catch { return null; } },
  set(key, value) { try { localStorage.setItem(`psarc2gp.web.${key}`, value); } catch { /* not kept */ } },
};

function el(tag, props = {}, ...children) {
  const e = Object.assign(document.createElement(tag), props);
  e.append(...children);
  return e;
}
function icon(path) {
  const span = el("span");
  span.innerHTML = `<svg viewBox="0 0 16 16" aria-hidden="true"><path d="${path}"/></svg>`;
  return span.firstChild;
}
const ICON_DOWNLOAD = "M7.25 1.5h1.5v7.19l2.47-2.47 1.06 1.06L8 11.56 3.72 7.28l1.06-1.06 2.47 2.47zM2.5 12.5h11V14h-11z";
const ICON_DELETE = "M6 1.5h4L10.5 3H14v1.5H2V3h3.5zM3.5 5.5h9l-.7 9H4.2zm2.25 1.5.3 6h1.2l-.2-6zm3.3 0-.2 6h1.2l.3-6z";

const clock = (seconds) => {
  if (seconds == null) return "";
  const s = Math.floor(seconds); // as the player shows it
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
};
const megabytes = (n) => (n >= 1e9 ? `${(n / 1e9).toFixed(1)} GB` : `${Math.max(1, Math.round(n / 1e6))} MB`);

function download(blob, name) {
  const url = URL.createObjectURL(blob);
  const a = el("a", { href: url, download: name });
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
}

// ---------------------------------------------------------------------------------------- player
const player = new Player({
  score: $("score"), viewport: $("viewport"), play: $("play"), time: $("time"), seek: $("seek"),
  recording: $("src-recording"), synth: $("src-synth"), speed: $("speed"), speedValue: $("speed-value"),
  loop: $("loop"), clearRange: $("clear-range"), tracks: $("tracks"), tuning: $("tuning"),
  soloWrap: $("solo-wrap"), solo: $("solo"), hint: $("hint"), status: $("status"),
});

// ----------------------------------------------------------------------------------------- theme
const THEMES = ["system", "light", "dark"];
let theme = THEMES.includes(prefs.get("theme")) ? prefs.get("theme") : "system";
function applyTheme() {
  if (theme === "system") delete document.documentElement.dataset.theme;
  else document.documentElement.dataset.theme = theme;
  $("theme").textContent = `Theme: ${theme}`;
  player.updateColors();
}
$("theme").addEventListener("click", () => {
  theme = THEMES[(THEMES.indexOf(theme) + 1) % THEMES.length];
  prefs.set("theme", theme);
  applyTheme();
});
matchMedia("(prefers-color-scheme: dark)").addEventListener("change", () => { if (theme === "system") player.updateColors(); });
applyTheme();

// --------------------------------------------------------------------------------------- library
let songs = [];

async function refreshLibrary() {
  songs = await allSongs();
  renderLibrary();
  showStorage();
}

const ORDER = {
  played: (a, b) => (b.played ?? 0) - (a.played ?? 0) || b.added - a.added,
  added: (a, b) => b.added - a.added,
  artist: (a, b) => a.artist.localeCompare(b.artist) || a.title.localeCompare(b.title),
  title: (a, b) => a.title.localeCompare(b.title) || a.artist.localeCompare(b.artist),
};

function renderLibrary() {
  const q = $("search").value.trim().toLowerCase();
  const list = songs.filter((s) => !q || `${s.title} ${s.artist} ${s.album}`.toLowerCase().includes(q));
  list.sort(ORDER[$("sort").value] ?? ORDER.played);
  $("count").textContent = songs.length ? `(${songs.length})` : "";
  $("empty").hidden = list.length > 0;
  $("empty").textContent = songs.length ? "No songs match." : "No songs yet. Converted songs appear here.";
  $("songs").replaceChildren(...list.map(songRow));
}

function songRow(s) {
  const open = el("button", { className: "song", type: "button", title: `Play ${s.title || s.name}` },
    el("span", { className: "song-name", textContent: s.title || s.name }),
    el("span", { className: "song-len", textContent: clock(s.seconds) }),
    el("span", { className: "song-meta", textContent: [s.artist, s.album].filter(Boolean).join(" · ") }),
    // a .gp added as it was can share its title with a converted one: show which file it is
    el("span", { className: "song-tracks", textContent: [s.source === "gp" && s.name, ...s.tracks].filter(Boolean).join(" · ") }));
  open.addEventListener("click", () => { location.hash = `#/play/${encodeURIComponent(s.id)}`; });

  const save = el("button", { className: "icon-button", type: "button", title: `Download ${s.name}` }, icon(ICON_DOWNLOAD));
  save.setAttribute("aria-label", `Download ${s.name}`);
  save.addEventListener("click", async () => download(await getFile(s.id), s.name));

  const remove = el("button", { className: "icon-button delete", type: "button", title: "Remove from the library" }, icon(ICON_DELETE));
  remove.setAttribute("aria-label", `Remove ${s.title} from the library`);
  remove.addEventListener("click", async () => {
    if (!confirm(`Remove "${s.title || s.name}" from this browser's library?\nDownload it first if you want to keep a copy.`)) return;
    await deleteSong(s.id);
    refreshLibrary();
  });
  return el("li", {}, open, save, remove);
}

async function showStorage() {
  if (!(await isPersistent())) {
    $("storage").textContent = "This browser isn't letting the page store data (a private window?), so songs last only until you close the page. Download the ones you want to keep.";
    return;
  }
  const used = songs.reduce((n, s) => n + (s.size ?? 0), 0);
  const estimate = await storageEstimate();
  const room = estimate?.quota ? ` Room for about ${megabytes(estimate.quota - (estimate.usage ?? 0))} more.` : "";
  $("storage").textContent = songs.length
    ? `${songs.length} song${songs.length === 1 ? "" : "s"}, ${megabytes(used)}, kept in this browser on this computer.${room} Clearing this site's data in the browser removes them; the download buttons give you the .gp files.`
    : "";
}

$("search").addEventListener("input", renderLibrary);
$("sort").value = ORDER[prefs.get("sort")] ? prefs.get("sort") : "played";
$("sort").addEventListener("change", () => { prefs.set("sort", $("sort").value); renderLibrary(); });

// ---------------------------------------------------------------------------------- conversion
// One file at a time, in a worker, in the order added.
const worker = new Worker(new URL("./convert-worker.js", import.meta.url), { type: "module" });
const queue = [];
let busy = null;
let nextId = 1;
const FINISHED = new Set(["done", "exists", "replaced", "error"]);

function enqueue(files) {
  const known = [...files].filter((f) => /\.(psarc|gp)$/i.test(f.name)).sort((a, b) => a.name.localeCompare(b.name));
  for (const file of known) queue.push({ id: nextId++, file, kind: /\.psarc$/i.test(file.name) ? "psarc" : "gp", state: "waiting" });
  if (!known.length && files.length) queue.push({ id: nextId++, file: files[0], state: "error", message: "not a .psarc or .gp file" });
  renderQueue();
  pump();
}

function pump() {
  if (busy) return;
  const item = queue.find((q) => q.state === "waiting");
  if (!item) return;
  busy = item;
  item.state = "working";
  renderQueue();
  item.file.arrayBuffer().then(
    (bytes) => worker.postMessage({ id: item.id, kind: item.kind, name: item.file.name, bytes }, [bytes]),
    (err) => finish(item, { ok: false, error: err.message }));
}

worker.addEventListener("message", ({ data }) => {
  const item = queue.find((q) => q.id === data.id);
  if (item) finish(item, data);
});
worker.addEventListener("error", (e) => {
  e.preventDefault();
  if (busy) finish(busy, { ok: false, error: e.message || "the converter didn't start (try reloading the page)" });
});

async function finish(item, result) {
  busy = null;
  try {
    if (!result.ok) throw new Error(result.error);
    const s = result.song;
    item.warnings = s.warnings;
    item.song = {
      id: songId(s.name), name: s.name, title: s.title, artist: s.artist, album: s.album,
      tracks: s.tracks, seconds: s.seconds, size: s.gp.byteLength, added: Date.now(), played: null, source: item.kind,
    };
    item.gp = new Blob([s.gp], { type: "application/octet-stream" });
    if (await getSong(item.song.id)) {
      item.state = "exists";
    } else {
      await putSong(item.song, item.gp);
      item.state = "done";
      refreshLibrary();
    }
  } catch (err) {
    item.state = "error";
    item.message = /quota/i.test(err.name ?? "") || /quota/i.test(err.message) ? "not enough room in this browser's storage" : err.message;
  }
  renderQueue();
  pump();
}

async function replace(item) {
  const old = await getSong(item.song.id);
  await putSong({ ...item.song, played: old?.played ?? null }, item.gp);
  item.state = "replaced";
  renderQueue();
  refreshLibrary();
}

function renderQueue() {
  $("queue-section").hidden = !queue.length;
  $("clear-queue").hidden = !queue.some((q) => FINISHED.has(q.state));
  $("queue").replaceChildren(...queue.map((item) => {
    const li = el("li", {}, el("span", { className: "q-name", textContent: item.song?.name ?? item.file.name }));
    const state = (text, cls = "") => li.append(el("span", { className: `q-state ${cls}`, textContent: text }));
    const button = (text, fn, cls = "") => {
      const b = el("button", { type: "button", className: cls, textContent: text });
      b.addEventListener("click", fn);
      li.append(b);
    };
    const play = () => button("Play", () => { location.hash = `#/play/${encodeURIComponent(item.song.id)}`; }, "primary");
    const save = () => button("Download", () => download(item.gp, item.song.name));
    switch (item.state) {
      case "waiting": state("Waiting"); break;
      case "working": li.append(el("span", { className: "spinner" })); state(item.kind === "psarc" ? "Converting…" : "Adding…"); break;
      case "done": state("Added to the library", "done"); play(); save(); break;
      case "exists": state("Already in your library"); button("Replace it", () => replace(item)); save(); break;
      case "replaced": state("Replaced", "done"); play(); save(); break;
      case "error": state(`Couldn't convert: ${item.message}`, "error"); break;
    }
    if (item.warnings?.length) li.append(el("p", { className: "q-warn", textContent: item.warnings.map((w) => `Note: ${w}`).join("\n") }));
    return li;
  }));
}

$("clear-queue").addEventListener("click", () => {
  for (let i = queue.length - 1; i >= 0; i--) if (FINISHED.has(queue[i].state)) queue.splice(i, 1);
  renderQueue();
});

// ---------------------------------------------------------------------------- adding files
for (const id of ["pick-files", "pick-folder"]) {
  $(id).addEventListener("change", (e) => {
    enqueue([...e.target.files]);
    e.target.value = "";
  });
}

// Files and folders dropped anywhere on the page. Folder contents are read through the entries API;
// webkitGetAsEntry must be called before the drop event returns.
async function droppedFiles(dataTransfer) {
  const entries = [...dataTransfer.items].map((i) => i.webkitGetAsEntry?.()).filter(Boolean);
  if (!entries.length) return [...dataTransfer.files];
  const files = [];
  async function walk(entry) {
    if (entry.isFile) {
      if (/\.(psarc|gp)$/i.test(entry.name)) files.push(await new Promise((resolve, reject) => entry.file(resolve, reject)));
    } else if (entry.isDirectory) {
      const reader = entry.createReader();
      for (;;) {
        const batch = await new Promise((resolve, reject) => reader.readEntries(resolve, reject));
        if (!batch.length) break;
        for (const e of batch) await walk(e);
      }
    }
  }
  for (const e of entries) await walk(e);
  return files;
}

let dragDepth = 0;
const hasFiles = (e) => [...(e.dataTransfer?.types ?? [])].includes("Files");
document.addEventListener("dragenter", (e) => { if (hasFiles(e) && dragDepth++ === 0) $("drop").classList.add("over"); });
document.addEventListener("dragleave", (e) => { if (hasFiles(e) && --dragDepth === 0) $("drop").classList.remove("over"); });
document.addEventListener("dragover", (e) => { if (hasFiles(e)) e.preventDefault(); });
document.addEventListener("drop", async (e) => {
  if (!hasFiles(e)) return;
  e.preventDefault();
  dragDepth = 0;
  $("drop").classList.remove("over");
  const files = droppedFiles(e.dataTransfer);
  if (location.hash.startsWith("#/play/")) location.hash = "#/";
  enqueue(await files);
});

// ---------------------------------------------------------------------------------------- views
let openSong = null;

async function route() {
  const m = location.hash.match(/^#\/play\/(.+)$/);
  if (!m) { showLibrary(); return; }
  const id = decodeURIComponent(m[1]);
  if (id === openSong?.id) return;
  const song = await getSong(id);
  if (!song) { location.replace("#/"); return; }
  openSong = song;
  $("library-view").hidden = true;
  $("player-view").hidden = false;
  $("title").textContent = song.title || song.name;
  $("byline").textContent = [song.artist, song.album].filter(Boolean).join(" · ");
  document.title = `${song.title || song.name} · psarc2gp`;
  $("status").textContent = "Loading…";
  try {
    const file = await getFile(id);
    if (openSong !== song) return; // another song was picked meanwhile
    player.open(new Uint8Array(await file.arrayBuffer()));
    updateSong(id, { played: Date.now() }).then(refreshLibrary);
  } catch (err) {
    $("status").textContent = `Can't open this song: ${err.message}`;
  }
}

function showLibrary() {
  if (openSong) {
    player.close();
    openSong = null;
  }
  $("player-view").hidden = true;
  $("library-view").hidden = false;
  document.title = "psarc2gp";
}

// songs added as .gp files have no length until the player has read them
player.onLength = (seconds) => {
  if (!openSong || openSong.seconds != null) return;
  openSong.seconds = seconds;
  updateSong(openSong.id, { seconds }).then(refreshLibrary);
};

$("download").addEventListener("click", async () => {
  if (openSong) download(await getFile(openSong.id), openSong.name);
});

window.addEventListener("hashchange", route);
refreshLibrary();
route();

