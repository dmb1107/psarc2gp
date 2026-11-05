#!/usr/bin/env node
// psarc2gp: convert Rocksmith 2014 CDLC (.psarc) to Guitar Pro 8 (.gp) with the recording embedded.
import fs from "node:fs";
import path from "node:path";
import { convertPsarc, loadSong, outputName } from "../src/convert.js";
import { convertSongsterr, inspectSongsterr, songsterrOutputName, validateBundle } from "../src/songsterr/convert.js";
import { audioInfo } from "../src/songsterr/audio/duration.js";

const HELP = `usage: psarc2gp [options] <file.psarc | folder | songsterr-bundle.json> [...]

Writes "Artist - Title.gp" next to each .psarc (or into --out). Folders convert every .psarc inside.
A Songsterr bundle (.json, saved by the web app's bookmarklet) becomes "Artist - Title (Songsterr).gp",
synced to the chosen video's points.

options:
  -f, --force       overwrite an existing .gp (default: skip it, so edits made in Guitar Pro are kept)
  -o, --out <dir>   write .gp files into this folder
  -r, --recursive   also look in subfolders
      --no-audio    don't embed the recording
      --no-mute     leave the instrument tracks unmuted (default: muted, only the recording plays)
      --midi        General MIDI sounds instead of Guitar Pro's RSE sounds (MIDI lags the recording)
      --atex        also write the intermediate alphaTex (.atex) for debugging
      --pause       keep the console window open when done (used by the Windows Send To entries)
  -q, --quiet       only print errors
  -h, --help

Songsterr bundles:
      --audio <file>        the video's audio as MP3 or M4A (one bundle at a time)
      --video <which>       default | backing | solo | playthrough | alternative | <YouTube video id>
      --list-videos         list the bundle's videos and whether they fit the tab, then stop
      --tracks <i,j,...>    track numbers to convert (default: every guitar and bass track; see --list-videos)`;

function parseArgs(argv) {
  const opts = { force: false, out: null, recursive: false, audio: true, mute: true, rse: true, atex: false, pause: false, quiet: false, inputs: [],
    audioFile: null, video: "default", listVideos: false, tracks: null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "-f" || a === "--force") opts.force = true;
    else if (a === "-o" || a === "--out") opts.out = argv[++i];
    else if (a === "-r" || a === "--recursive") opts.recursive = true;
    else if (a === "--no-audio") opts.audio = false;
    else if (a === "--no-mute") opts.mute = false;
    else if (a === "--midi") opts.rse = false;
    else if (a === "--atex") opts.atex = true;
    else if (a === "--pause") opts.pause = true;
    else if (a === "-q" || a === "--quiet") opts.quiet = true;
    else if (a === "--audio") opts.audioFile = argv[++i];
    else if (a === "--video") opts.video = argv[++i];
    else if (a === "--list-videos") opts.listVideos = true;
    else if (a === "--tracks") opts.tracks = String(argv[++i] ?? "").split(",").filter(Boolean).map(Number);
    else if (a === "-h" || a === "--help") { console.log(HELP); process.exit(0); }
    else if (a.startsWith("-")) { console.error(`unknown option ${a}\n\n${HELP}`); process.exit(2); }
    else opts.inputs.push(a);
  }
  return opts;
}

function collect(inputs, recursive) {
  const files = [];
  const walk = (dir) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      let st;
      try { st = e.isSymbolicLink() ? fs.statSync(p) : e; } catch { continue; } // follow links
      if (st.isDirectory() && recursive) walk(p);
      else if (st.isFile() && e.name.toLowerCase().endsWith(".psarc")) files.push(p);
    }
  };
  for (const input of inputs) {
    if (!fs.existsSync(input)) { files.push({ missing: input }); continue; }
    if (fs.statSync(input).isDirectory()) walk(input); else files.push(input);
  }
  return files;
}

// Send To opens a console window that closes when we exit: after errors wait for a key so they can be
// read, otherwise close after 10 seconds. Never waits without a terminal (scripts, tests).
// Returns whether it waited.
async function pauseBeforeExit(failed) {
  if (!process.stdin.isTTY) return false;
  console.log(failed
    ? "\nSome files could not be converted - see the messages above. Press any key to close."
    : "\nDone. This window closes in 10 seconds.");
  process.stdin.setRawMode(true);
  process.stdin.resume();
  await new Promise((resolve) => {
    const timer = failed ? null : setTimeout(resolve, 10_000);
    process.stdin.once("data", () => { clearTimeout(timer); resolve(); });
  });
  return true;
}

const opts = parseArgs(process.argv.slice(2));
if (!opts.inputs.length) { console.log(HELP); process.exit(2); }
const log = (...a) => { if (!opts.quiet) console.log(...a); };

let failed = 0;
let converted = 0;
let skipped = 0;
const files = collect(opts.inputs, opts.recursive);
const isBundle = (f) => typeof f === "string" && f.toLowerCase().endsWith(".json");
if (opts.audioFile && files.filter(isBundle).length !== 1) {
  console.error("ERR  --audio goes with exactly one Songsterr bundle");
  process.exit(2);
}
if (opts.tracks?.some((t) => !Number.isInteger(t) || t < 0)) {
  console.error("ERR  --tracks takes track numbers, e.g. --tracks 0,2");
  process.exit(2);
}

const fmtTime = (s) => `${Math.floor(s / 60)}:${String(Math.round(s % 60)).padStart(2, "0")}`;

async function convertBundle(file) {
  const name = path.basename(file);
  const t0 = Date.now();
  let bundle;
  try { bundle = JSON.parse(fs.readFileSync(file, "utf8")); } catch (e) { throw new Error(`not JSON (${e.message})`); }
  validateBundle(bundle);
  if (opts.listVideos) {
    const { videos, played, score, data } = await inspectSongsterr(bundle, { tracks: opts.tracks });
    log(`${name}: ${bundle.song.artist} - ${bundle.song.title}, revision ${bundle.song.revisionId}`);
    log(`    ${score.masterBars.length} bars, ${played.length} played (repeats included)`);
    log("    tracks:");
    bundle.song.tracks.forEach((t, i) => log(`      ${String(i).padStart(2)}  ${t.name}${data.some((d) => d.index === i) ? (opts.tracks ? "  (chosen)" : "  (converted by default)") : ""}`));
    log("    videos:");
    const rank = (v) => (v.fit ? 0 : 2) + (v.feature === "default" ? 0 : 1);
    for (const v of [...videos].sort((x, y) => rank(x) - rank(y))) {
      const extra = [v.leavesOut && `leaves out track ${v.leavesOut.join(", ")}`, v.fit === "written" && "one point per written bar"].filter(Boolean);
      log(`      ${v.fit ? "fits " : "  -  "} ${v.feature.padEnd(12)} ${v.videoId}  ${v.points} points${extra.length ? `  (${extra.join("; ")})` : ""}`);
    }
    return "listed";
  }
  const outDir = opts.out ?? path.dirname(file);
  const outPath = path.join(outDir, songsterrOutputName(bundle.song));
  if (fs.existsSync(outPath) && !opts.force) {
    log(`SKIP ${name}: ${path.basename(outPath)} already exists (use --force to overwrite)`);
    return "skipped";
  }
  let audio = null;
  if (opts.audio) {
    if (!opts.audioFile) throw new Error("give the video's audio with --audio <file.mp3|file.m4a>, or --no-audio (fetching it for you comes later)");
    const bytes = new Uint8Array(fs.readFileSync(opts.audioFile));
    const info = audioInfo(bytes);
    audio = { bytes, format: info.format, seconds: info.seconds, provider: "file" };
  }
  const result = await convertSongsterr(bundle, { tracks: opts.tracks, video: opts.video, audio, mute: opts.mute, rse: opts.rse });
  fs.mkdirSync(outDir, { recursive: true });
  fs.writeFileSync(outPath, result.gp);
  if (opts.atex) fs.writeFileSync(outPath.replace(/\.gp$/, ".atex"), result.tex);
  const r = result.report;
  log(`OK   ${path.basename(outPath)}  (${((Date.now() - t0) / 1000).toFixed(1)} s)`);
  log(`    ${r.bars} bars (${r.playedBars} played), ${r.syncPoints} sync points from video ${r.video.videoId} (${r.video.feature})` +
    `${r.audioSeconds ? `, ${fmtTime(r.audioSeconds)} of audio` : ""}`);
  for (const t of r.tracks) log(`    ${t.name}: ${t.notes} notes, tuning ${t.tuning}, ${t.soundName}${r.muted ? " (muted)" : ""}${t.graceNotes ? `; ${t.graceNotes} grace notes` : ""}`);
  for (const w of r.warnings) log(`    warning: ${w}`);
  return "converted";
}
if (!files.length) {
  console.error(`ERR  no .psarc files found${opts.recursive ? "" : " (subfolders are not searched; use --recursive)"}`);
  failed++;
}
for (const file of files) {
  if (file.missing) { console.error(`ERR  not found: ${file.missing}`); failed++; continue; }
  const name = path.basename(file);
  if (isBundle(file)) {
    try {
      const r = await convertBundle(file);
      if (r === "converted") converted++;
      else if (r === "skipped") skipped++;
    } catch (err) {
      console.error(`ERR  ${name}: ${err.message}`);
      if (process.env.PSARC2GP_DEBUG) console.error(err.stack);
      failed++;
    }
    continue;
  }
  try {
    const t0 = Date.now();
    const buf = fs.readFileSync(file);
    const song = loadSong(buf);
    const outDir = opts.out ?? path.dirname(file);
    const outPath = path.join(outDir, outputName(song.meta));
    if (fs.existsSync(outPath) && !opts.force) {
      log(`SKIP ${name}: ${path.basename(outPath)} already exists (use --force to overwrite)`);
      skipped++;
      continue;
    }
    const result = await convertPsarc(buf, { withAudio: opts.audio, mute: opts.mute, rse: opts.rse, song });
    fs.mkdirSync(outDir, { recursive: true });
    fs.writeFileSync(outPath, result.gp);
    if (opts.atex) fs.writeFileSync(outPath.replace(/\.gp$/, ".atex"), result.tex);
    const r = result.report;
    log(`OK   ${path.basename(outPath)}  (${((Date.now() - t0) / 1000).toFixed(1)} s)`);
    log(`    ${r.bars} bars, ${r.syncPoints} sync points${r.audioSeconds ? `, ${Math.floor(r.audioSeconds / 60)}:${String(Math.round(r.audioSeconds % 60)).padStart(2, "0")} of audio` : ""}`);
    for (const t of r.tracks) {
      const extras = [
        t.tripletBeats && `${t.tripletBeats} triplet beats`,
        t.beats32nd && `${t.beats32nd} beats in 32nds`,
        t.beats64th && `${t.beats64th} beats in 64ths`,
        t.graceNotes && `${t.graceNotes} grace notes`,
        t.droppedDuplicates && `${t.droppedDuplicates} duplicate notes dropped`,
      ].filter(Boolean);
      log(`    ${t.name}: ${t.notes} notes, tuning ${t.tuning}, ${t.soundName}${r.muted ? " (muted)" : ""}${extras.length ? `; ${extras.join(", ")}` : ""}`);
    }
    for (const w of r.warnings) log(`    warning: ${w}`);
    converted++;
  } catch (err) {
    console.error(`ERR  ${name}: ${err.message}`);
    if (process.env.PSARC2GP_DEBUG) console.error(err.stack);
    failed++;
  }
}
if (!(opts.listVideos && !converted && !skipped && !failed && files.every(isBundle))) log(`\n${converted} converted, ${skipped} skipped, ${failed} failed`);
// once the errors have been read, exit 0: Windows Terminal keeps a window open after a non-zero exit
if (opts.pause && await pauseBeforeExit(failed)) process.exit(0);
process.exit(failed ? 1 : 0);
