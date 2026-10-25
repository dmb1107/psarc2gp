// Print a summary of what loadSong() extracts from each .psarc given on the command line.
import fs from "node:fs";
import { loadSong } from "../src/rocksmith/song.js";
for (const f of process.argv.slice(2)) {
  const t0 = Date.now();
  const song = loadSong(fs.readFileSync(f));
  console.log(`${song.meta.artist} - ${song.meta.title} (${Date.now() - t0} ms) wem ${(song.wem.length / 1e6).toFixed(2)} MB, lyrics ${song.vocals?.length ?? 0}`);
  for (const a of song.arrangements) console.log(`   ${a.name}${a.bonus ? " (bonus)" : ""} [${a.key}] notes=${a.notes.length} tuning=${a.tuning} cents=${a.centOffset} beats=${a.sng.beats.length}`);
}
