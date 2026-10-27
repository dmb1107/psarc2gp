// Screenshots of the web app for the README: docs/images/{library,player}-{light,dark}.png.
// Taken in headless Chrome (or Edge) over the DevTools protocol (Node's own WebSocket), so there is nothing
// to install. The library shot shows the songs given here, converted by the page as a user would; the player
// shot shows a demo song written below (original music, so the README shows nobody's chart).
//   node tools/screenshots.js [song.psarc ...] [--out docs/images] [--browser path/to/chrome.exe]
//   node tools/screenshots.js --demo out.gp          (just write the demo song)
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import * as alphaTab from "../node_modules/@coderline/alphatab/dist/alphaTab.core.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);
const option = (name, fallback) => { const i = args.indexOf(name); return i >= 0 ? args.splice(i, 2)[1] : fallback; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---- the demo song: "Night Drive", guitar and bass over Am F C G, 100 bpm --------------------------------
const TEMPO = 100;
const SECTIONS = { 0: "Intro", 4: "Verse", 8: "Chorus" };
const AM = "0.1 1.2 2.3 2.4 0.5", F = "1.1 1.2 2.3 3.4 3.5 1.6", C = "0.1 1.2 0.3 2.4 3.5", G = "3.1 0.2 0.3 0.4 2.5 3.6";
const chord = (notes, dur, name) => `(${notes}).${dur}${name ? `{ch "${name}"}` : ""}`;
const muted = (notes, name) => [`(${notes}).8{ch "${name}"}`, ...Array(7).fill(`(${notes}).8`)].join(" ");
const strum = (notes, name) => [chord(notes, 4, name), chord(notes, 8), chord(notes, 8), chord(notes, 4), chord(notes, 4)].join(" ");
const GUITAR = [
  ...[[AM, "Am"], [F, "F"], [C, "C"], [G, "G"]].map(([n, name]) => `${chord(n, 2, name)} ${chord(n, 2)}`),
  muted("0.5{pm} 2.4{pm}", "A5"), muted("1.6{pm} 3.5{pm}", "F5"), muted("3.5{pm} 5.4{pm}", "C5"), muted("3.6{pm} 5.5{pm}", "G5"),
  strum(F, "F"), strum(G, "G"), strum(AM, "Am"), chord(AM, 1, "Am"),
];
const BASS = [
  "0.3.8 0.3.8 0.3.8 0.3.8 0.3.8 0.3.8 7.3.8 5.3.8",
  "1.4.8 1.4.8 1.4.8 1.4.8 1.4.8 1.4.8 3.4.8 5.4.8",
  "3.3.8 3.3.8 3.3.8 3.3.8 3.3.8 3.3.8 2.2.8 0.2.8",
  "3.4.8 3.4.8 3.4.8 3.4.8 3.4.4 3.4{sl}.4",
  "5.4.4 5.4.8 7.4.8 5.3{h}.8 7.3.8 5.4.4",
  "1.4.4 1.4.8 3.4.8 3.3{h}.8 5.3.8 1.4.4",
  "3.3.4 3.3.8 5.3.8 2.2{h}.8 5.2.8 3.3.4",
  "3.4.4 3.4.8 5.4.8 5.3{sl}.8 7.3.8 0.3.4",
  "1.4.4{d} 1.4.8 1.4.4 3.4.4",
  "3.4.4{d} 3.4.8 3.4.4 5.4.4",
  "5.4.4{d} 5.4.8 7.3.4 5.3.4",
  "5.4{v}.1",
];

function demoTex() {
  const bars = (list, first = "") => list.map((body, i) => [
    i === 0 && `${first}\\ts (4 4) \\tempo ${TEMPO}`, SECTIONS[i] && `\\section "${SECTIONS[i]}"`, body,
  ].filter(Boolean).join(" ")).join(" |\n");
  const msPerBar = 4 * 60000 / TEMPO;
  return [
    `\\title "Night Drive"`, `\\artist "psarc2gp demo"`, ".",
    `\\track "Guitar"`, `\\staff {score tabs}`, `\\tuning (E4 B3 G3 D3 A2 E2)`, `\\instrument 27`, `\\displaytranspose 12`,
    bars(GUITAR) + " |",
    `\\track "Bass"`, `\\staff {score tabs}`, `\\tuning (G2 D2 A1 E1)`, `\\instrument 33`, `\\displaytranspose 12`,
    bars(BASS, "\\clef bass ") + " |",
    ...BASS.map((_, i) => `\\sync (${i} 0 ${i * msPerBar} 0)`), `\\sync (${BASS.length - 1} 0 ${BASS.length * msPerBar} 1)`,
  ].join("\n");
}

// A stand-in for the recording: every note plucked (Karplus-Strong), as a 16-bit mono WAV.
function demoRecording(score) {
  const RATE = 44100, seconds = (ticks) => ticks / 960 * 60 / TEMPO;
  let seed = 1;
  const random = () => (seed = (seed * 1103515245 + 12345) % 2147483648) / 1073741824 - 1;
  const out = new Float32Array(Math.ceil((score.masterBars.length * 4 * 60 / TEMPO + 1) * RATE));
  for (const track of score.tracks) for (const bar of track.staves[0].bars) for (const beat of bar.voices[0].beats) {
    for (const note of beat.notes) {
      if (note.isTieDestination) continue;
      const period = Math.round(RATE / (440 * 2 ** ((note.realValue - 69) / 12)));
      const line = Float32Array.from({ length: period }, random);
      const from = Math.round(seconds(bar.masterBar.start + beat.playbackStart) * RATE);
      const n = Math.min(out.length - from, Math.round((seconds(beat.playbackDuration) + 0.05) * RATE));
      const gain = track.name === "Bass" ? 0.5 : 0.18;
      for (let i = 0; i < n; i++) {
        const j = i % period, v = line[j];
        line[j] = 0.4985 * (v + line[(j + 1) % period]);
        out[from + i] += v * gain * Math.min(1, (n - i) / 1500); // stop at the note's end
      }
    }
  }
  const peak = out.reduce((m, v) => Math.max(m, Math.abs(v)), 0) || 1;
  const wav = new DataView(new ArrayBuffer(44 + out.length * 2));
  const ascii = (at, s) => [...s].forEach((c, i) => wav.setUint8(at + i, c.charCodeAt(0)));
  ascii(0, "RIFF"); wav.setUint32(4, 36 + out.length * 2, true); ascii(8, "WAVEfmt ");
  wav.setUint32(16, 16, true); wav.setUint16(20, 1, true); wav.setUint16(22, 1, true); wav.setUint32(24, RATE, true);
  wav.setUint32(28, RATE * 2, true); wav.setUint16(32, 2, true); wav.setUint16(34, 16, true);
  ascii(36, "data"); wav.setUint32(40, out.length * 2, true);
  out.forEach((v, i) => wav.setInt16(44 + i * 2, Math.round(v / peak * 0.8 * 32767), true));
  return new Uint8Array(wav.buffer);
}

function demoSong() {
  const settings = new alphaTab.Settings();
  settings.core.logLevel = alphaTab.LogLevel.Error;
  const score = alphaTab.importer.ScoreLoader.loadAlphaTex(demoTex(), settings);
  score.backingTrack = new alphaTab.model.BackingTrack();
  score.backingTrack.rawAudioFile = demoRecording(score);
  return new alphaTab.exporter.Gp7Exporter().export(score, settings);
}

const demoOut = option("--demo", null);
if (demoOut) {
  fs.writeFileSync(demoOut, demoSong());
  console.log(`wrote ${demoOut}`);
  process.exit(0);
}

// ---- the browser, over the DevTools protocol --------------------------------------------------------------
const outDir = path.resolve(option("--out", path.join(root, "docs", "images")));
const browserPath = option("--browser", [ // Chrome first: headless Edge exited at once on the user's PC
  "C:/Program Files/Google/Chrome/Application/chrome.exe",
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  "/usr/bin/google-chrome", "/usr/bin/chromium",
  "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe",
  "C:/Program Files/Microsoft/Edge/Application/msedge.exe",
  "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
].find((p) => fs.existsSync(p)));
if (!browserPath) throw new Error("no Edge or Chrome found: pass --browser <path>");
const songs = args.map((a) => path.resolve(a));
const PORT = 8799, VIEW = { width: 1200, height: 900 };

fs.mkdirSync(outDir, { recursive: true });
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "psarc2gp-shots-"));
const demoPath = path.join(tmp, "Night Drive.gp");
fs.writeFileSync(demoPath, demoSong());

const server = spawn(process.execPath, [path.join(root, "tools", "serve.js"), root, "--port", String(PORT)], { stdio: "ignore" });
const browser = spawn(browserPath, [
  "--headless", "--remote-debugging-port=0", `--user-data-dir=${path.join(tmp, "profile")}`, "--no-first-run",
  "--no-default-browser-check", "--mute-audio", "--hide-scrollbars", "--autoplay-policy=no-user-gesture-required",
  "about:blank",
], { stdio: "ignore" });

async function cdp() {
  const portFile = path.join(tmp, "profile", "DevToolsActivePort");
  for (let i = 0; !fs.existsSync(portFile) || !fs.readFileSync(portFile, "utf8").includes("\n"); i++) {
    if (i > 100) throw new Error("the browser didn't start");
    await sleep(100);
  }
  const port = fs.readFileSync(portFile, "utf8").split("\n")[0];
  const targets = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
  const ws = new WebSocket(targets.find((t) => t.type === "page").webSocketDebuggerUrl);
  await new Promise((ok, fail) => { ws.onopen = ok; ws.onerror = fail; });
  let id = 0;
  const pending = new Map();
  ws.onmessage = ({ data }) => {
    const m = JSON.parse(data);
    const p = pending.get(m.id);
    if (!p) return;
    pending.delete(m.id);
    if (m.error) p.fail(new Error(`${p.method}: ${m.error.message}`)); else p.ok(m.result);
  };
  const send = (method, params = {}) => new Promise((ok, fail) => {
    pending.set(++id, { ok, fail, method });
    ws.send(JSON.stringify({ id, method, params }));
  });
  return { send, close: () => ws.close() };
}

let send, close = () => {};
const evaluate = async (expression) => {
  const r = await send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? r.exceptionDetails.text);
  return r.result.value;
};
const waitFor = async (expression, ms = 60000) => {
  for (const t0 = Date.now(); Date.now() - t0 < ms; await sleep(200)) if (await evaluate(expression)) return;
  const queue = await evaluate(`document.getElementById("queue")?.innerText`).catch(() => "");
  throw new Error(`timed out waiting for ${expression}${queue ? `\nqueue: ${queue}` : ""}`);
};
const colors = (value) => send("Emulation.setEmulatedMedia", { features: [{ name: "prefers-color-scheme", value }] });
// the viewport's top, down to just below `bottom` (an expression for a y position)
const shoot = async (name, bottom) => {
  await sleep(600);
  const height = Math.min(VIEW.height, Math.ceil(await evaluate(bottom)));
  const { data } = await send("Page.captureScreenshot", { format: "png", clip: { x: 0, y: 0, width: VIEW.width, height, scale: 1 } });
  fs.writeFileSync(path.join(outDir, name), Buffer.from(data, "base64"));
  console.log(`  ${path.relative(root, path.join(outDir, name))}`);
};
const mouse = (type, x, y) => send("Input.dispatchMouseEvent", { type, x, y, button: "left", buttons: type === "mouseReleased" ? 0 : 1, clickCount: 1 });

try {
  ({ send, close } = await cdp());
  for (let i = 0; i < 100; i++) { try { await fetch(`http://127.0.0.1:${PORT}/web/`); break; } catch { await sleep(100); } }
  await send("Page.enable");
  await send("Runtime.enable");
  await send("Emulation.setDeviceMetricsOverride", { ...VIEW, deviceScaleFactor: 2, mobile: false });
  await colors("light");
  await send("Page.navigate", { url: `http://127.0.0.1:${PORT}/web/#/` });
  await waitFor(`!!document.getElementById("pick-files") && document.readyState === "complete"`);

  // add the songs through the page's file picker, as a user would
  const { root: doc } = await send("DOM.getDocument");
  const { nodeId } = await send("DOM.querySelector", { nodeId: doc.nodeId, selector: "#pick-files" });
  await send("DOM.setFileInputFiles", { nodeId, files: [...songs, demoPath] });
  await waitFor(`document.querySelectorAll("#queue li").length === ${songs.length + 1}
    && !/Waiting|Converting|Adding/.test(document.getElementById("queue").innerText)`, 180000);
  console.log((await evaluate(`document.getElementById("queue").innerText`)).replace(/\n(?!Note)/g, " | "));

  // open the demo once so the library knows its length and lists it as recently played
  const openDemo = `[...document.querySelectorAll("#songs .song")].find((b) => b.innerText.startsWith("Night Drive")).click()`;
  await evaluate(openDemo);
  await waitFor(`!document.getElementById("play").disabled`);
  await evaluate(`location.hash = "#/"`);
  await waitFor(`!document.getElementById("library-view").hidden`);
  await evaluate(`document.getElementById("clear-queue").click()`);
  for (const scheme of ["light", "dark"]) {
    await colors(scheme);
    await shoot(`library-${scheme}.png`, `document.getElementById("songs").getBoundingClientRect().bottom + 24`);
  }

  for (const scheme of ["light", "dark"]) {
    await colors(scheme);
    await send("Page.reload");
    await waitFor(`document.readyState === "complete" && !!document.querySelector("#songs .song")`);
    await evaluate(openDemo);
    await waitFor(`!document.getElementById("play").disabled && document.querySelectorAll("#score svg").length > 0`);
    await sleep(800);
    // select the first two bars of the verse: from the "Verse" label down into the bass staff
    const at = await evaluate(`(() => {
      const label = [...document.querySelectorAll("#score text")].find((t) => t.textContent.trim() === "Verse");
      const r = label.getBoundingClientRect();
      return { x: r.left, y: r.bottom };
    })()`);
    // a click seeks to a beat and moves the bar cursor onto its bar: that measures bars 5 and 6
    const barAt = async (x) => {
      await mouse("mousePressed", x, at.y + 60);
      await mouse("mouseReleased", x, at.y + 60);
      await sleep(300);
      return evaluate(`(() => { const r = document.querySelector(".at-cursor-bar").getBoundingClientRect(); return { x: r.left, end: r.right }; })()`);
    };
    const bar5 = await barAt(at.x + 20);
    const bar6 = await barAt(bar5.end + 20);
    const [from, to] = [bar5.x + 12, bar6.end - 12];
    await mouse("mousePressed", from, at.y + 60);
    for (let k = 1; k <= 8; k++) await mouse("mouseMoved", from + (to - from) * k / 8, at.y + 60);
    await mouse("mouseReleased", to, at.y + 60);
    await evaluate(`document.getElementById("loop").click()`);
    await evaluate(`document.getElementById("play").click()`);
    await sleep(1800);
    await evaluate(`document.getElementById("play").click()`);
    await evaluate(`document.activeElement?.blur(); document.getElementById("viewport").scrollTop = 0`);
    await shoot(`player-${scheme}.png`, `Math.max(...[...document.querySelectorAll("#score svg")].map((s) => s.getBoundingClientRect().bottom)) + 20`);
  }
} finally {
  close();
  browser.kill();
  server.kill();
  await sleep(500);
  fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
}
