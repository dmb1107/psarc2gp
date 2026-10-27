// The song library: .gp files kept in this browser's IndexedDB, with what the list shows about each.
// Nothing leaves the computer. If IndexedDB is unavailable (some private windows), songs are kept in
// memory until the page closes.
//
// "songs" holds { id, name, title, artist, album, tracks: [name], seconds, size, added, played, source },
// source being "psarc" (converted here) or "gp" (added as it was);
// "files" holds the .gp itself (a Blob) under the same id, so listing and marking a song as played
// don't touch the file. id is the lower-cased file name ("artist - title.gp"), so converting a song
// twice finds the first one.

const DB_NAME = "psarc2gp";
const SONGS = "songs";
const FILES = "files";

const request = (r) => new Promise((resolve, reject) => {
  r.onsuccess = () => resolve(r.result);
  r.onerror = () => reject(r.error);
});
const done = (tx) => new Promise((resolve, reject) => {
  tx.oncomplete = () => resolve();
  tx.onerror = tx.onabort = () => reject(tx.error ?? new Error("storage error"));
});

let dbPromise = null;
const memory = { [SONGS]: new Map(), [FILES]: new Map() };

function db() {
  dbPromise ??= new Promise((resolve) => {
    let r;
    try { r = indexedDB.open(DB_NAME, 1); } catch { resolve(null); return; }
    r.onupgradeneeded = () => {
      r.result.createObjectStore(SONGS, { keyPath: "id" });
      r.result.createObjectStore(FILES);
    };
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => resolve(null);
    r.onblocked = () => resolve(null);
  });
  return dbPromise;
}

async function read(store, fn) {
  const d = await db();
  if (!d) return fn(memory[store]);
  return request(fn(d.transaction(store).objectStore(store)));
}

export const songId = (name) => name.toLowerCase();

// false when songs only last until the page closes
export const isPersistent = async () => !!(await db());

export const allSongs = () => read(SONGS, (s) => (s instanceof Map ? [...s.values()] : s.getAll()));
export const getSong = (id) => read(SONGS, (s) => s.get(id));
export const getFile = (id) => read(FILES, (s) => s.get(id));

// song: the list entry; gp: the file (Blob)
export async function putSong(song, gp) {
  const d = await db();
  if (!d) {
    memory[SONGS].set(song.id, song);
    memory[FILES].set(song.id, gp);
    return;
  }
  const tx = d.transaction([SONGS, FILES], "readwrite");
  tx.objectStore(SONGS).put(song);
  tx.objectStore(FILES).put(gp, song.id);
  await done(tx);
  // ask the browser not to clear the library when disk space runs low (granted silently or not at all)
  navigator.storage?.persist?.().catch(() => {});
}

export async function deleteSong(id) {
  const d = await db();
  if (!d) {
    memory[SONGS].delete(id);
    memory[FILES].delete(id);
    return;
  }
  const tx = d.transaction([SONGS, FILES], "readwrite");
  tx.objectStore(SONGS).delete(id);
  tx.objectStore(FILES).delete(id);
  await done(tx);
}

// change list fields of a song (not its file); read and write in one transaction, so updates made at
// the same time don't undo each other
export async function updateSong(id, changes) {
  const d = await db();
  if (!d) {
    const song = memory[SONGS].get(id);
    if (song) memory[SONGS].set(id, { ...song, ...changes });
    return;
  }
  const tx = d.transaction(SONGS, "readwrite");
  const store = tx.objectStore(SONGS);
  const r = store.get(id);
  r.onsuccess = () => { if (r.result) store.put({ ...r.result, ...changes }); };
  await done(tx);
}

// { usage, quota } in bytes, when the browser says
export async function storageEstimate() {
  try { return await navigator.storage.estimate(); } catch { return null; }
}
