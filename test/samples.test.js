// Integration tests against real CDLC. Charts are copyrighted, so they are not in the repo: put .psarc
// files (and optionally ToneLib .song exports with the same base name) in ./.samples or point
// PSARC2GP_SAMPLES at a folder. Without samples these tests are skipped.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { loadSong } from "../src/rocksmith/song.js";
import { wemToOgg } from "../src/audio/ww2ogg.js";
import { convertPsarc } from "../src/convert.js";
import { verify } from "../tools/verify.js";

const dir = process.env.PSARC2GP_SAMPLES ?? path.join(import.meta.dirname, "..", ".samples");
const files = fs.existsSync(dir) ? fs.readdirSync(dir).filter((f) => f.endsWith(".psarc")).map((f) => path.join(dir, f)) : [];
const hasFfmpeg = (() => { try { execFileSync("ffmpeg", ["-version"], { stdio: "ignore" }); return true; } catch { return false; } })();

test("sample songs", { skip: files.length ? false : "no samples (see test/samples.test.js)" }, async (t) => {
  for (const file of files) {
    await t.test(path.basename(file), async (t) => {
      const buf = fs.readFileSync(file);

      await t.test("metadata: artist and title (they name the .gp file)", () => {
        const { meta } = loadSong(buf);
        assert.ok(meta.artist && meta.title, `artist ${meta.artist}, title ${meta.title}`);
      });

      await t.test("notation: bars full, every note present, onsets on their Rocksmith times", () => {
        const r = verify(buf);
        assert.deepEqual(r.problems, []);
        for (const x of r.results) {
          assert.ok(x.onsetErrorMs.p95 <= 20, `${x.track}: p95 onset error ${x.onsetErrorMs.p95} ms`);
          assert.ok(x.onsetErrorMs.max <= 60, `${x.track}: max onset error ${x.onsetErrorMs.max} ms`);
        }
      });

      await t.test("audio: Ogg length equals the Wwise sample count", () => {
        const { ogg: bytes, sampleCount } = wemToOgg(loadSong(buf).wem);
        const ogg = Buffer.from(bytes);
        // granule position of the last page = total samples
        const lastPage = ogg.lastIndexOf(Buffer.from("OggS"));
        assert.equal(Number(ogg.readBigInt64LE(lastPage + 6)), sampleCount);
        if (hasFfmpeg) {
          const tmp = path.join(fs.mkdtempSync(path.join(import.meta.dirname, "..", "out-")), "a.ogg");
          fs.writeFileSync(tmp, ogg);
          execFileSync("ffmpeg", ["-v", "error", "-err_detect", "crccheck+explode", "-i", tmp, "-f", "null", "-"]);
          fs.rmSync(path.dirname(tmp), { recursive: true });
        }
      });

      await t.test(".gp output re-opens with audio and sync points", async () => {
        const { createRequire } = await import("node:module");
        const alphaTab = createRequire(import.meta.url)("@coderline/alphatab");
        const { gp, report } = await convertPsarc(buf);
        const score = alphaTab.importer.ScoreLoader.loadScoreFromBytes(new Uint8Array(gp), new alphaTab.Settings());
        assert.ok(score.backingTrack?.rawAudioFile?.length > 100000);
        assert.equal(score.masterBars.flatMap((m) => m.syncPoints ?? []).length, report.syncPoints);
        // instrument tracks: muted, on Guitar Pro's RSE engine (MIDI output lags the audio track)
        assert.ok(score.tracks.every((t) => t.playbackInfo.isMute));
        const { readZip, entryData } = await import("../src/gp/zip.js");
        const gpif = Buffer.from(entryData(readZip(gp).find((e) => e.name === "Content/score.gpif"))).toString();
        assert.equal(gpif.match(/<AudioEngineState>RSE<\/AudioEngineState>/g)?.length, score.tracks.length);
        assert.ok(!gpif.includes("<AudioEngineState>MIDI"));
      });

      const songFile = file.replace(/\.psarc$/, ".song");
      if (fs.existsSync(songFile)) {
        await t.test("matches ToneLib's notation for the same chart", () => {
          const out = execFileSync(process.execPath, [path.join(import.meta.dirname, "..", "tools", "compare-tonelib.js"), file, songFile], { encoding: "utf8" });
          for (const m of out.matchAll(/onsets matched \d+\/\d+ \(([\d.]+)%\).*same duration \d+\/\d+ \(([\d.]+)%\)/g)) {
            assert.ok(+m[1] >= 95, `onset agreement ${m[1]}%`);
            // durations differ by design where the chart gives no sustain (see README)
            assert.ok(+m[2] >= 85, `duration agreement ${m[2]}%`);
          }
        });
      }
    });
  }
});
