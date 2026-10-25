// Debug helper: extract the full-song audio of a .psarc as .ogg.  usage: node tools/wem2ogg.js in.psarc out.ogg
import fs from "node:fs";
import { loadSong } from "../src/rocksmith/song.js";
import { wemToOgg } from "../src/audio/ww2ogg.js";
const song = loadSong(fs.readFileSync(process.argv[2]));
const t0 = Date.now();
const r = wemToOgg(song.wem);
fs.writeFileSync(process.argv[3], r.ogg);
console.log(`${process.argv[3]}: ${(r.ogg.length / 1e6).toFixed(2)} MB, ${r.channels}ch ${r.sampleRate} Hz, ${(r.sampleCount / r.sampleRate).toFixed(3)} s, ${Date.now() - t0} ms`);
