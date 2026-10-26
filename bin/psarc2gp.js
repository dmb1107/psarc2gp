#!/usr/bin/env node
// psarc2gp: convert Rocksmith 2014 CDLC (.psarc) to Guitar Pro 8 (.gp) with the recording embedded.
import fs from "node:fs";
import path from "node:path";
import { convertPsarc, loadSong, outputName } from "../src/convert.js";

const HELP = `usage: psarc2gp [options] <file.psarc | folder> [...]

Writes "Artist - Title.gp" next to each .psarc (or into --out). Folders convert every .psarc inside.

options:
  -f, --force       overwrite an existing .gp (default: skip it, so edits made in Guitar Pro are kept)
  -o, --out <dir>   write .gp files into this folder
  -r, --recursive   also look in subfolders
      --no-audio    don't embed the recording
      --no-mute     leave the instrument tracks unmuted (default: muted, only the recording plays)
      --midi        General MIDI sounds instead of Guitar Pro's RSE sounds (MIDI lags the recording)
      --atex        also write the intermediate alphaTex (.atex) for debugging
  -q, --quiet       only print errors
  -h, --help`;

function parseArgs(argv) {
  const opts = { force: false, out: null, recursive: false, audio: true, mute: true, rse: true, atex: false, quiet: false, inputs: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "-f" || a === "--force") opts.force = true;
    else if (a === "-o" || a === "--out") opts.out = argv[++i];
    else if (a === "-r" || a === "--recursive") opts.recursive = true;
    else if (a === "--no-audio") opts.audio = false;
    else if (a === "--no-mute") opts.mute = false;
    else if (a === "--midi") opts.rse = false;
    else if (a === "--atex") opts.atex = true;
    else if (a === "-q" || a === "--quiet") opts.quiet = true;
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

const opts = parseArgs(process.argv.slice(2));
if (!opts.inputs.length) { console.log(HELP); process.exit(2); }
const log = (...a) => { if (!opts.quiet) console.log(...a); };

let failed = 0;
let converted = 0;
let skipped = 0;
for (const file of collect(opts.inputs, opts.recursive)) {
  if (file.missing) { console.error(`ERR  not found: ${file.missing}`); failed++; continue; }
  const name = path.basename(file);
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
    const result = convertPsarc(buf, { withAudio: opts.audio, mute: opts.mute, rse: opts.rse, song });
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
log(`\n${converted} converted, ${skipped} skipped, ${failed} failed`);
process.exit(failed ? 1 : 0);
