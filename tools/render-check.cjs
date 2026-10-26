// Render every track of each .gp in headless Chromium with alphaTab and report renderer errors.
// Catches problems the model-level checks miss (e.g. a renderer crash on mixed tuplet values).
//   usage: node tools/render-check.cjs out/*.gp [--png dir]   (--png also saves a screenshot per track)
// Needs Playwright with Chromium, which is not a project dependency:
//   npm install --no-save playwright && npx playwright install chromium
const fs = require("fs");
const os = require("os");
const path = require("path");

let chromium;
try { ({ chromium } = require("playwright")); } catch {
  console.error("Playwright not found. Install it for this check only:\n  npm install --no-save playwright && npx playwright install chromium");
  process.exit(2);
}

const args = process.argv.slice(2);
const pngIdx = args.indexOf("--png");
const pngDir = pngIdx >= 0 ? args.splice(pngIdx, 2)[1] : null;
const dist = path.dirname(require.resolve("@coderline/alphatab"));

(async () => {
  const browser = await chromium.launch({ args: ["--allow-file-access-from-files"] });
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "render-check-"));
  let failed = 0;
  for (const gp of args) {
    const b64 = fs.readFileSync(gp).toString("base64");
    const html = `<!doctype html><html><body style="width:1400px;background:#fff"><div id="at"></div>
<script src="file://${dist}/alphaTab.js"></script><script>
  const bytes = Uint8Array.from(atob("${b64}"), c => c.charCodeAt(0));
  window.__errors = []; window.__rendered = 0; window.__ready = false; window.__done = false;
  const api = new alphaTab.AlphaTabApi(document.getElementById("at"), {
    core: { fontDirectory: "file://${dist}/font/", useWorkers: false, enableLazyLoading: false },
    display: { layoutMode: "page", scale: 0.8 }, player: { enablePlayer: false } });
  api.error.on(e => window.__errors.push(String(e && e.message || e)));
  let n = 0;
  api.scoreLoaded.on(s => { n = s.tracks.length; });
  api.renderFinished.on(() => { window.__rendered++; window.__ready = true; });
  window.next = () => { window.__ready = false; if (window.__rendered < n) api.renderTracks([api.score.tracks[window.__rendered]]); else window.__done = true; };
  api.load(bytes, [0]);
</script></body></html>`;
    const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });
    const consoleErrors = [];
    page.on("console", (m) => { if (m.type() === "error") consoleErrors.push(m.text().slice(0, 200)); });
    const file = path.join(tmp, "page.html");
    fs.writeFileSync(file, html);
    await page.goto("file://" + file);
    let ok = true;
    try {
      for (;;) {
        await page.waitForFunction(() => window.__ready || window.__errors.length, null, { timeout: 90000 });
        if (await page.evaluate(() => window.__errors.length)) break;
        const i = await page.evaluate(() => window.__rendered);
        if (pngDir) {
          fs.mkdirSync(pngDir, { recursive: true });
          await page.screenshot({ path: path.join(pngDir, `${path.basename(gp, ".gp")} - track ${i}.png`), fullPage: true });
        }
        await page.evaluate(() => window.next());
        if (await page.evaluate(() => window.__done)) break;
      }
    } catch { ok = false; }
    const errs = await page.evaluate(() => window.__errors);
    const done = await page.evaluate(() => window.__rendered);
    const good = ok && !errs.length && !consoleErrors.length;
    if (!good) failed++;
    console.log(`${good ? "OK  " : "FAIL"} ${path.basename(gp)} (${done} tracks rendered)${errs.length ? " " + errs[0] : ""}${consoleErrors.length ? " console: " + consoleErrors[0] : ""}${ok ? "" : " (timed out)"}`);
    await page.close();
  }
  await browser.close();
  fs.rmSync(tmp, { recursive: true, force: true });
  process.exit(failed ? 1 : 0);
})();
