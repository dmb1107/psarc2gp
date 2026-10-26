// Health check of a whole library: converts every .psarc in memory (nothing is written) and runs the
// verify.js checks on each.  usage: node tools/sweep.js <folder | file.psarc> ... [--json results.json]
import fs from "node:fs";
import path from "node:path";
import { convertPsarc, loadSong, outputName } from "../src/convert.js";
import { verify } from "./verify.js";

const args = process.argv.slice(2);
const jsonAt = args.indexOf("--json");
const jsonPath = jsonAt >= 0 ? args.splice(jsonAt, 2)[1] : null;
const files = args.flatMap((a) => fs.statSync(a).isDirectory()
  ? fs.readdirSync(a).filter((f) => f.toLowerCase().endsWith(".psarc")).map((f) => path.join(a, f))
  : [a]);

const results = [];
for (const [i, file] of files.entries()) {
  const r = { file };
  try {
    const buf = fs.readFileSync(file);
    const song = loadSong(buf);
    const { report } = convertPsarc(buf, { song });
    const v = verify(buf);
    Object.assign(r, {
      ok: true, name: outputName(song.meta), named: !!(song.meta.artist && song.meta.title),
      tracks: v.results.map((x) => ({ track: x.track, notes: x.notes, incomplete: x.incompleteBars, notFound: x.notFound, ...x.onsetErrorMs })),
      problems: v.problems, warnings: report.warnings,
    });
    r.p95 = Math.max(...r.tracks.map((t) => t.p95));
  } catch (err) {
    Object.assign(r, { ok: false, error: err.message });
  }
  results.push(r);
  const status = !r.ok ? "ERR " : r.problems.length || !r.named ? "PROB" : "ok  ";
  const detail = !r.ok ? r.error : [`p95 ${r.p95} ms`, !r.named && "no artist/title", ...r.problems].filter(Boolean).join("; ");
  console.log(`${String(i + 1).padStart(4)}/${files.length} ${status} ${path.basename(file)}  ${detail}`);
}
if (jsonPath) fs.writeFileSync(jsonPath, JSON.stringify(results, null, 1));

const ok = results.filter((r) => r.ok);
const tracks = ok.flatMap((r) => r.tracks);
const sum = (f) => tracks.reduce((s, t) => s + f(t), 0);
console.log(`\n${files.length} songs: ${ok.length} converted, ${files.length - ok.length} failed, ${ok.filter((r) => !r.named).length} without artist/title`);
console.log(`${tracks.length} tracks, ${sum((t) => t.notes)} notes: ${sum((t) => t.incomplete)} incomplete bars, ${sum((t) => t.notFound)} notes not found`);
const bins = [[-1, 1], [1, 5], [5, 10], [10, 20], [20, Infinity]];
console.log(`songs by worst track's p95 onset error: ${bins.map(([a, b]) => `${a < 0 ? 0 : a}${b === Infinity ? "+" : `-${b}`} ms: ${ok.filter((r) => r.p95 > a && r.p95 <= b).length}`).join(", ")}`);
