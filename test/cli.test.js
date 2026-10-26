import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

const cli = path.join(import.meta.dirname, "..", "bin", "psarc2gp.js");
const run = (...args) => spawnSync(process.execPath, [cli, ...args], { encoding: "utf8", timeout: 5000 });

test("a folder without .psarc files is reported, not silently done", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "psarc2gp-"));
  try {
    fs.mkdirSync(path.join(dir, "sub"));
    const r = run(dir);
    assert.equal(r.status, 1);
    assert.match(r.stderr, /no \.psarc files found \(subfolders are not searched/);
  } finally {
    fs.rmSync(dir, { recursive: true });
  }
});

test("--pause never waits without a terminal (scripts, tests)", () => {
  const r = run("--pause", path.join(os.tmpdir(), "psarc2gp-missing", "a&b^c%PATH%_p.psarc"));
  assert.equal(r.error, undefined); // no timeout
  assert.equal(r.status, 1);
  assert.match(r.stderr, /not found: .*a&b\^c%PATH%_p\.psarc/);
});
