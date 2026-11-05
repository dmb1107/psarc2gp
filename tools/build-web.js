// Build the web app as a static site, ready to upload to any web host (GitHub Pages, Netlify,
// Cloudflare Pages, a plain web server): node tools/build-web.js [out folder, default dist/site]
//
// Layout: web/ (the page), src/ (the converter), vendor/alphatab/ (the parts of alphaTab the page uses,
// with the minified core), and index.html pointing at web/. Nothing is compiled: the files are copied
// and the alphaTab paths, which point into node_modules during development, are rewritten.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";

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

// The build number at the foot of the setup page: GitHub Actions' run number and the commit (linked), or
// "Local build" and a + when the working tree has changes. It's in the HTML, so it names the page that's
// actually running (a cached old copy shows its own number).
const DEV_BUILD = "Development copy (not built)";
const git = (...args) => { try { return execFileSync("git", args, { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim(); } catch { return ""; } };
const fullSha = process.env.GITHUB_SHA ?? git("rev-parse", "HEAD");
const sha = fullSha.slice(0, 7);
const dirty = !process.env.GITHUB_SHA && git("status", "--porcelain") !== "";
const run = process.env.GITHUB_RUN_NUMBER;
const repo = process.env.GITHUB_REPOSITORY;
const day = new Date().toISOString().slice(0, 10);
const commit = !/^[0-9a-f]{7}$/.test(sha) ? ""
  : repo && /^[\w.-]+\/[\w.-]+$/.test(repo) && /^[0-9a-f]{40}$/.test(fullSha)
    ? ` · <a href="https://github.com/${repo}/commit/${fullSha}" target="_blank" rel="noopener">${sha}</a>`
    : ` · ${sha}${dirty ? "+" : ""}`;
const build = `${/^\d+$/.test(run ?? "") ? `Build ${run}` : "Local build"}${commit} · ${day}`;
const page = path.join(out, "web", "index.html");
const html = fs.readFileSync(page, "utf8");
if (!html.includes(DEV_BUILD)) throw new Error(`web/index.html has no "${DEV_BUILD}" to replace with the build number`);
fs.writeFileSync(page, html.replace(DEV_BUILD, build));

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
<title>tab2gp</title>
<link rel="icon" href="web/icon.svg" type="image/svg+xml">
<meta http-equiv="refresh" content="0; url=web/">
<a href="web/">tab2gp</a>
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
