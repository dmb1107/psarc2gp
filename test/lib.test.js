// The plain-JavaScript AES and inflate that let the converter run in browsers, checked against Node's.
import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import zlib from "node:zlib";
import { aesCtr, aesCfbDecrypt } from "../src/lib/aes.js";
import { inflate, InflateError } from "../src/lib/inflate.js";

const same = (a, b, msg) => assert.ok(Buffer.from(a).equals(Buffer.from(b)), msg);

// deterministic test data: random bytes, or text-like bytes that compress well
function bytes(n, seed, alphabet = 256) {
  const out = new Uint8Array(n);
  let x = seed >>> 0;
  for (let i = 0; i < n; i++) { x = (Math.imul(x, 1103515245) + 12345) >>> 0; out[i] = (x >>> 16) % alphabet; }
  return out;
}

test("AES-256-CTR matches node:crypto", () => {
  for (const n of [0, 1, 15, 16, 17, 100, 4096 + 7]) {
    const key = crypto.randomBytes(32), iv = crypto.randomBytes(16), data = crypto.randomBytes(n);
    const d = crypto.createDecipheriv("aes-256-ctr", key, iv);
    same(aesCtr(key, iv, data), Buffer.concat([d.update(data), d.final()]), `length ${n}`);
  }
  // the counter carries across all 16 bytes
  const key = crypto.randomBytes(32), iv = Buffer.from("7f" + "ff".repeat(15), "hex"), data = crypto.randomBytes(64);
  const d = crypto.createDecipheriv("aes-256-ctr", key, iv);
  same(aesCtr(key, iv, data), Buffer.concat([d.update(data), d.final()]), "counter overflow");
});

test("AES-256-CFB decryption matches node:crypto", () => {
  for (const n of [0, 5, 16, 33, 968, 1088]) {
    const key = crypto.randomBytes(32), iv = crypto.randomBytes(16), data = crypto.randomBytes(n);
    const d = crypto.createDecipheriv("aes-256-cfb", key, iv);
    same(aesCfbDecrypt(key, iv, data), Buffer.concat([d.update(data), d.final()]), `length ${n}`);
  }
});

test("inflate matches node:zlib", () => {
  const inputs = [new Uint8Array(0), bytes(1, 1), bytes(1000, 2), bytes(70000, 3, 4), bytes(300000, 4, 20), bytes(200000, 5), new Uint8Array(100000).fill(9)];
  for (const [i, data] of inputs.entries()) {
    for (const level of [0, 1, 6, 9]) {
      same(inflate(zlib.deflateSync(data, { level })), data, `input ${i}, zlib, level ${level}`);
      same(inflate(zlib.deflateRawSync(data, { level }), { zlib: false }), data, `input ${i}, raw, level ${level}`);
    }
    // fixed Huffman codes only
    same(inflate(zlib.deflateSync(data, { strategy: zlib.constants.Z_FIXED })), data, `input ${i}, fixed codes`);
  }
});

test("inflate ignores bytes after the stream, rejects damaged ones", () => {
  const data = bytes(300000, 6, 16);
  const z = zlib.deflateSync(data);
  same(inflate(Buffer.concat([z, Buffer.alloc(70, 0xab)])), data, "trailing bytes");
  assert.throws(() => inflate(z.subarray(0, z.length - 100)), InflateError, "truncated");
  const bad = Buffer.from(z);
  bad[bad.length - 1] ^= 1;
  assert.throws(() => inflate(bad), /data check/, "checksum");
  assert.throws(() => inflate(bytes(100, 7)), InflateError, "not zlib");
});
