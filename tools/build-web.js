// Build the web app as a static site, ready to upload to any web host (GitHub Pages, Netlify,
// Cloudflare Pages, a plain web server): node tools/build-web.js [out folder, default dist/site]
//
// Layout: web/ (the page), src/ (the converter), vendor/alphatab/ (the parts of alphaTab the page uses,
// with the minified core), and index.html pointing at web/. Nothing is compiled: the files are copied
// and the alphaTab paths, which point into node_modules during development, are rewritten.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const out = path.resolve(process.argv[2] ?? path.join(root, "dist", "site"));
const alphaTab = path.join(root, "node_modules", "@coderline", "alphatab");
const DEV_PATH = "../node_modules/@coderline/alphatab/dist/";
const SITE_PATH = "../vendor/alphatab/";

if (!fs.existsSync(alphaTab)) throw new Error("alphaTab is missing: run npm install first");
fs.rmSync(out, { recursive: true, force: true });

function copy(from, to, { rewrite = false } = {}) {
  fs.mkdirSync(path.dirname(to), { recursive: true });
  if (rewrite && to.endsWith(".js")) {
    const text = fs.readFileSync(from, "utf8").replaceAll(DEV_PATH, SITE_PATH);
    if (text.includes("node_modules")) throw new Error(`${path.relative(root, from)} still refers to node_modules`);
    fs.writeFileSync(to, text);
  } else {
    fs.copyFileSync(from, to);
  }
}
function copyDir(from, to, options) {
  for (const entry of fs.readdirSync(from, { withFileTypes: true })) {
    const f = path.join(from, entry.name), t = path.join(to, entry.name);
    if (entry.isDirectory()) copyDir(f, t, options);
    else copy(f, t, options);
  }
}

copyDir(path.join(root, "web"), path.join(out, "web"), { rewrite: true });
copyDir(path.join(root, "src"), path.join(out, "src"), { rewrite: true });

const vendor = path.join(out, "vendor", "alphatab");
const dist = path.join(alphaTab, "dist");
copy(path.join(dist, "alphaTab.mjs"), path.join(vendor, "alphaTab.mjs"));
copy(path.join(dist, "alphaTab.core.min.mjs"), path.join(vendor, "alphaTab.core.mjs")); // same module, minified
copy(path.join(dist, "alphaTab.worker.mjs"), path.join(vendor, "alphaTab.worker.mjs"));
copy(path.join(dist, "alphaTab.worklet.mjs"), path.join(vendor, "alphaTab.worklet.mjs"));
copyDir(path.join(dist, "font"), path.join(vendor, "font"));
copy(path.join(dist, "soundfont", "sonivox.sf2"), path.join(vendor, "soundfont", "sonivox.sf2"));
copy(path.join(dist, "soundfont", "LICENSE"), path.join(vendor, "soundfont", "LICENSE"));
copy(path.join(alphaTab, "LICENSE"), path.join(vendor, "LICENSE"));

fs.writeFileSync(path.join(out, "index.html"), `<!doctype html>
<meta charset="utf-8">
<title>psarc2gp</title>
<meta http-equiv="refresh" content="0; url=web/">
<a href="web/">psarc2gp</a>
`);
fs.writeFileSync(path.join(out, ".nojekyll"), ""); // GitHub Pages: serve files as they are

let files = 0, bytes = 0;
(function count(dir) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (e.isDirectory()) count(path.join(dir, e.name));
    else { files++; bytes += fs.statSync(path.join(dir, e.name)).size; }
  }
})(out);
console.log(`built ${out}: ${files} files, ${(bytes / 1e6).toFixed(1)} MB`);
console.log(`try it: node tools/serve.js "${out}"`);
