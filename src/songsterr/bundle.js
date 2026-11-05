// Songsterr bundles: what the bookmarklet reads from a Songsterr song page (song fields of the page's
// state, the video sync points) plus, in a saved bundle, every track's tab JSON from Songsterr's CDN.
//
//   {
//     kind: "psarc2gp-songsterr", version: 1, page, savedAt,
//     cdn: "https://….cloudfront.net",
//     song: { songId, revisionId, image, artist, title, defaultTrack, tracks: [ { name, instrumentId, tuning, isGuitar, … } ] },
//     videos: [ { videoId, feature, tracks, countries, points: [seconds, …] } ],
//     trackData: [ <track JSON> | null, … ]   (saved bundles; index = track index in song.tracks)
//   }
//
// Platform-neutral: no fs, and fetch is passed in.

export const BUNDLE_KIND = "psarc2gp-songsterr";
export const BUNDLE_VERSION = 1;
export const DEFAULT_CDN = "https://dqsljvtekg760.cloudfront.net";

const isNum = (x) => typeof x === "number" && Number.isFinite(x);

// Throws with a message a user can act on; returns the bundle.
export function validateBundle(b) {
  const fail = (m) => { throw new Error(`not a usable Songsterr bundle: ${m}`); };
  if (!b || typeof b !== "object") fail("not a JSON object");
  if (b.kind !== BUNDLE_KIND) fail(`kind is ${JSON.stringify(b.kind)}, expected "${BUNDLE_KIND}"`);
  if (b.version !== BUNDLE_VERSION) fail(`version ${b.version} (this psarc2gp reads version ${BUNDLE_VERSION}; update one of them)`);
  const s = b.song;
  if (!s || !Number.isInteger(s.songId) || !Number.isInteger(s.revisionId)) fail("song id or revision id missing");
  if (typeof s.image !== "string" || !s.image) fail("song image (the tab's file version) missing");
  if (!Array.isArray(s.tracks) || !s.tracks.length) fail("no tracks listed");
  if (!Array.isArray(b.videos)) fail("no video list");
  for (const v of b.videos) {
    if (typeof v.videoId !== "string" || !v.videoId) fail("a video without a videoId");
    if (!Array.isArray(v.points) || !v.points.every(isNum)) fail(`video ${v.videoId}: points are not a list of numbers`);
    for (let i = 1; i < v.points.length; i++) {
      if (v.points[i] < v.points[i - 1]) fail(`video ${v.videoId}: points go backwards at ${i}`);
    }
  }
  if (b.trackData != null) {
    if (!Array.isArray(b.trackData) || b.trackData.length !== s.tracks.length) fail("trackData doesn't match the track list");
    b.trackData.forEach((t, i) => { if (t != null) checkTrackJson(t, s, i); });
  }
  return b;
}

function checkTrackJson(t, song, i) {
  if (!t || !Array.isArray(t.measures) || !t.measures.length) throw new Error(`track ${i}: no bars in the tab data`);
  if (t.songId != null && t.songId !== song.songId) throw new Error(`track ${i}: tab data is for song ${t.songId}, not ${song.songId}`);
  if (t.revisionId != null && t.revisionId !== song.revisionId) throw new Error(`track ${i}: tab data is for revision ${t.revisionId}, not ${song.revisionId}`);
}

export function trackUrl(bundle, index) {
  const s = bundle.song;
  return `${bundle.cdn || DEFAULT_CDN}/${s.songId}/${s.revisionId}/${s.image}/${index}.json`;
}

// Tab JSON for the given track indices: from the bundle when it carries them, otherwise from the CDN.
export async function loadTracks(bundle, indices, { fetch = globalThis.fetch, signal } = {}) {
  const out = [];
  for (const i of indices) {
    if (!(i >= 0 && i < bundle.song.tracks.length)) throw new Error(`no track ${i} (the song has ${bundle.song.tracks.length})`);
    let data = bundle.trackData?.[i] ?? null;
    if (!data) {
      if (!fetch) throw new Error(`track ${i} isn't in the bundle and there's no network fetch to get it`);
      const url = trackUrl(bundle, i);
      const r = await fetch(url, { signal });
      if (!r.ok) throw new Error(`track ${i}: the tab CDN answered ${r.status}`);
      data = await r.json();
      checkTrackJson(data, bundle.song, i);
    }
    out.push({ index: i, meta: bundle.song.tracks[i], data });
  }
  return out;
}

// Tracks converted when none are asked for: guitars and basses (drums and vocals come later).
export function defaultTrackIndices(bundle) {
  return bundle.song.tracks.map((t, i) => ({ t, i })).filter(({ t }) => !t.isEmpty && ["guitar", "bass"].includes(trackKind(t))).map(({ i }) => i);
}

export function trackKind(meta) {
  if (meta.isDrums || meta.instrumentId === 1024) return "drums";
  if (meta.isVocalTrack) return "vocals";
  if (meta.isBassGuitar || (meta.instrumentId >= 32 && meta.instrumentId <= 39)) return "bass";
  if (meta.isGuitar || (meta.instrumentId >= 24 && meta.instrumentId <= 31)) return "guitar";
  return "other";
}
