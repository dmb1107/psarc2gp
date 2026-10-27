// Fingerprint what the converter makes of a library, to compare two versions of the code: hashes of the
// alphaTex, the Ogg audio, the report, and every .gp zip entry's contents (not the compressed bytes).
//   node tools/snapshot.js before.json <folder | file.psarc> ...    (run before a change)
//   node tools/snapshot.js after.json <same inputs>                  (after it)
//   node tools/snapshot.js --compare before.json after.json
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { convertPsarc, loadSong } from "../src/convert.js";
import { readZip, entryData } from "../src/gp/zip.js";
import { wemToOgg } from "../src/audio/ww2ogg.js";

const sha = (b) => crypto.createHash("sha1").update(b).digest("hex").slice(0, 16);
const args = process.argv.slice(2);

if (args[0] === "--compare") {
  const [a, b] = args.slice(1).map((f) => JSON.parse(fs.readFileSync(f, "utf8")));
  let same = 0, msA = 0, msB = 0;
  const diffs = [];
  for (const [file, x] of Object.entries(a)) {
    const y = b[file];
    if (!y) { diffs.push(`${file}: only in the first`); continue; }
    msA += x.ms; msB += y.ms;
    const d = [];
    if (x.error || y.error) {
      if (x.error !== y.error) d.push(`error: ${x.error ?? "none"} -> ${y.error ?? "none"}`);
    } else {
      for (const k of ["tex", "ogg", "report", "gpSize"]) if (x[k] !== y[k]) d.push(k);
      for (const name of new Set([...Object.keys(x.entries), ...Object.keys(y.entries)])) {
        if (x.entries[name] !== y.entries[name]) d.push(`entry ${name}`);
      }
    }
    if (d.length) diffs.push(`${file}: ${d.join(", ")}`); else same++;
  }
  for (const file of Object.keys(b)) if (!a[file]) diffs.push(`${file}: only in the second`);
  console.log(`${Object.keys(a).length} files: ${same} identical, ${diffs.length} different; time ${(msA / 1000).toFixed(0)} s -> ${(msB / 1000).toFixed(0)} s`);
  for (const d of diffs) console.log(`  ${d}`);
  process.exit(diffs.length ? 1 : 0);
}

const [outPath, ...inputs] = args;
if (!outPath || !inputs.length) {
  console.error("usage: node tools/snapshot.js out.json <folder | file.psarc> ...  |  --compare a.json b.json");
  process.exit(2);
}
const files = inputs.flatMap((a) => fs.statSync(a).isDirectory()
  ? fs.readdirSync(a).filter((f) => f.toLowerCase().endsWith(".psarc")).map((f) => path.join(a, f))
  : [a]);

const out = {};
for (const [i, file] of files.entries()) {
  const t0 = performance.now();
  const r = {};
  try {
    const buf = fs.readFileSync(file);
    const song = loadSong(buf);
    const { gp, tex, report } = await convertPsarc(buf, { song });
    r.tex = sha(tex);
    r.ogg = sha(wemToOgg(song.wem).ogg);
    r.report = sha(JSON.stringify(report));
    r.gpSize = gp.length;
    r.entries = Object.fromEntries(readZip(gp).map((e) => [e.name, sha(entryData(e))]));
  } catch (err) {
    r.error = err.message;
  }
  r.ms = Math.round(performance.now() - t0);
  out[path.basename(file)] = r;
  if ((i + 1) % 20 === 0 || i + 1 === files.length) console.log(`${i + 1}/${files.length}`);
}
fs.writeFileSync(outPath, JSON.stringify(out, null, 1));
