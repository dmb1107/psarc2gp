// Preview of a Guitar Pro file in Explorer's preview pane: the score of one track, played from the
// file's embedded recording with alphaTab (the cursor follows the sync points). The add-in serves the
// selected file at https://file.psarc2gp/current.gp and passes Explorer's colours as ?bg=&fg= (rrggbb).
"use strict";

const $ = (id) => document.getElementById(id);
const ALPHATAB = "/node_modules/@coderline/alphatab/dist/";

// --- colours -----------------------------------------------------------------------------------
const params = new URLSearchParams(location.search);
const param = (name) => (/^[0-9a-f]{6}$/i.test(params.get(name) ?? "") ? `#${params.get(name)}` : null);
const systemDark = matchMedia("(prefers-color-scheme: dark)").matches;
const bg = param("bg") ?? (systemDark ? "#202020" : "#ffffff");
const fg = param("fg") ?? (systemDark ? "#ffffff" : "#1b1b1b");
const rgb = (hex) => [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16));
const mix = (a, b, t) => `rgb(${rgb(a).map((v, i) => Math.round(v * t + rgb(b)[i] * (1 - t))).join(",")})`;
const dark = rgb(bg).reduce((s, v) => s + v, 0) < 3 * 128;
const accent = dark ? "#60cdff" : "#005fb8"; // Windows 11's default accent, as used on dark / light
for (const [k, v] of Object.entries({ "--bg": bg, "--fg": fg, "--accent": accent })) document.documentElement.style.setProperty(k, v);

// --- helpers -----------------------------------------------------------------------------------
const NOTE = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"];
const pitch = (midi) => `${NOTE[midi % 12]}${Math.floor(midi / 12) - 1}`;
const tuningOf = (track) => [...track.staves[0].tuning].reverse().map(pitch).join(" "); // alphaTab lists the highest string first
const clock = (ms) => { const s = Math.max(0, Math.floor(ms / 1000)); return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`; };

// the track picked last time is remembered by name (WebView2 keeps this between previews)
const TRACK_KEY = "psarc2gp.preview.track";
const remembered = () => { try { return localStorage.getItem(TRACK_KEY); } catch { return null; } };
const remember = (name) => { try { localStorage.setItem(TRACK_KEY, name); } catch { /* not kept */ } };

// first track to show: the one picked last time, else a bass part (lowest string below D3), else the first
function firstTrack(score) {
  const byName = score.tracks.findIndex((t) => t.name === remembered());
  if (byName >= 0) return byName;
  const bass = score.tracks.findIndex((t) => /bass/i.test(t.name) || Math.max(...t.staves[0].tuning) < 50);
  return Math.max(0, bass);
}

// --- preview -----------------------------------------------------------------------------------
// ?file=/path.gp (same site) opens another file, for trying the page in a browser
const FILE = /^\/[^/]/.test(params.get("file") ?? "") ? params.get("file") : "https://file.psarc2gp/current.gp";

async function main() {
  const response = await fetch(FILE);
  if (!response.ok) throw new Error(`could not read the file (${response.status})`);
  const score = alphaTab.importer.ScoreLoader.loadScoreFromBytes(new Uint8Array(await response.arrayBuffer()), new alphaTab.Settings());

  $("title").textContent = score.title || "Untitled";
  $("byline").textContent = [score.artist, score.album].filter(Boolean).join(" · ");

  const glyph = fg;
  const api = new alphaTab.AlphaTabApi($("score"), {
    core: { fontDirectory: `${ALPHATAB}font/` },
    display: {
      layoutMode: "Page",
      scale: 0.8,
      padding: [12, 12],
      resources: {
        mainGlyphColor: glyph,
        secondaryGlyphColor: mix(fg, bg, 0.45),
        scoreInfoColor: glyph,
        staffLineColor: mix(fg, bg, 0.4),
        barSeparatorColor: mix(fg, bg, 0.55),
        barNumberColor: mix(fg, bg, 0.6),
      },
    },
    player: {
      // the recording when the file has one (all psarc2gp files do), otherwise alphaTab's synthesizer
      playerMode: alphaTab.PlayerMode.EnabledAutomatic,
      soundFont: `${ALPHATAB}soundfont/sonivox.sf2`,
      scrollElement: $("viewport"),
      enableCursor: true,
      enableUserInteraction: true,
    },
  });

  // track tabs
  const buttons = score.tracks.map((track, i) => {
    const b = document.createElement("button");
    b.type = "button";
    b.textContent = track.name;
    b.title = tuningOf(track);
    b.addEventListener("click", () => { show(i); remember(track.name); });
    $("tracks").append(b);
    return b;
  });
  let current = -1;
  function show(i) {
    if (i === current) return;
    current = i;
    buttons.forEach((b, j) => b.setAttribute("aria-pressed", String(j === i)));
    $("tuning").textContent = tuningOf(score.tracks[i]);
    $("status").textContent = "Drawing the score…";
    if (api.score) api.renderTracks([score.tracks[i]]);
    else api.renderScore(score, [i]);
  }
  show(firstTrack(score));

  // player controls
  const play = $("play"), seek = $("seek");
  let seeking = false;
  const showTime = (now, end) => { $("time").textContent = `${clock(now)} / ${clock(end)}`; };
  // (no api.midiLoaded: in alphaTab 1.8.4 subscribing to it recurses forever when the synthesizer
  // plays, i.e. for files without a recording; the position events carry the length too)
  api.playerReady.on(() => { play.disabled = false; seek.disabled = false; });
  api.playerStateChanged.on((e) => {
    const playing = e.state === alphaTab.synth.PlayerState.Playing;
    play.classList.toggle("playing", playing);
    play.setAttribute("aria-label", playing ? "Pause" : "Play");
    play.title = playing ? "Pause (Space)" : "Play (Space)";
  });
  api.playerPositionChanged.on((e) => {
    if (seeking) return;
    seek.max = e.endTime;
    seek.value = e.currentTime;
    showTime(e.currentTime, e.endTime);
  });
  play.addEventListener("click", () => api.playPause());
  seek.addEventListener("input", () => { seeking = true; showTime(+seek.value, +seek.max); });
  seek.addEventListener("change", () => { api.timePosition = +seek.value; seeking = false; });
  document.addEventListener("keydown", (e) => {
    if (e.code !== "Space" || e.target instanceof HTMLButtonElement || e.repeat) return;
    e.preventDefault();
    if (!play.disabled) api.playPause();
  });

  api.renderFinished.on(() => { $("status").textContent = ""; });
  api.error.on((err) => { $("status").textContent = `Can't show the score: ${err.message ?? err}`; });
}

main().catch((err) => {
  console.error(err);
  $("status").textContent = `Can't preview this file: ${err.message}`;
});
