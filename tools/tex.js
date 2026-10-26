// Debug helper: write the generated alphaTex for a .psarc and try loading it.
// usage: node tools/tex.js in.psarc out.atex
import fs from "node:fs";
import { createRequire } from "node:module";
import { loadSong } from "../src/rocksmith/song.js";
import { buildAlphaTex } from "../src/notation/score.js";

const require = createRequire(import.meta.url);
const alphaTab = require("@coderline/alphatab");
const song = loadSong(fs.readFileSync(process.argv[2]));
const { tex, tracks, measures, sync } = buildAlphaTex(song, { warn: (m) => console.log("warn:", m) });
fs.writeFileSync(process.argv[3], tex);
console.log(`bars ${measures.length}, sync ${sync.length}`, tracks);
const score = alphaTab.importer.ScoreLoader.loadAlphaTex(tex, new alphaTab.Settings());
console.log("parsed OK:", score.tracks.length, "tracks", score.masterBars.length, "bars");
