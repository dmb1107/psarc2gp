// Re-open written .gp files with alphaTab and report what Guitar Pro will see.
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const alphaTab = require("@coderline/alphatab");
for (const f of process.argv.slice(2)) {
  const s = alphaTab.importer.ScoreLoader.loadScoreFromBytes(new Uint8Array(fs.readFileSync(f)), new alphaTab.Settings());
  let incomplete = 0;
  for (const t of s.tracks) t.staves[0].bars.forEach((b, i) => {
    if (b.voices[0].beats.reduce((a, x) => a + x.displayDuration, 0) !== s.masterBars[i].calculateDuration()) incomplete++; // notated length (graces count 0)
  });
  const sp = s.masterBars.flatMap((m) => m.syncPoints ?? []);
  const mono = sp.every((p, i) => !i || p.syncPointValue.millisecondOffset >= sp[i - 1].syncPointValue.millisecondOffset);
  console.log(`${path.basename(f)}: ${s.tracks.length} tracks [${s.tracks.map((t) => `${t.name}/${t.staves[0].tuning.length}str/prog${t.playbackInfo.program}`).join(", ")}], ${s.masterBars.length} bars, incomplete ${incomplete}, sync ${sp.length} (monotonic ${mono}), audio ${(s.backingTrack?.rawAudioFile?.length / 1e6).toFixed(2)} MB, sections ${s.masterBars.filter((m) => m.section).length}`);
}
