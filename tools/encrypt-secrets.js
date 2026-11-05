#!/usr/bin/env node
// Write web/songsterr-secrets.json: the audio providers' keys, encrypted with one password.
//   node tools/encrypt-secrets.js [--file <path>] [--iterations <n>]
// Asks for the current password (if the file exists), each provider's key (Enter keeps the current one)
// and the new password (Enter keeps the current one). Nothing is taken from arguments, so keys and
// passwords stay out of the shell history.
//
// Adding a provider's key, replacing a key or changing the password = run it again, commit, push.
// A new password revokes nothing (old versions of the file stay in git history): to cut access,
// regenerate the key at the provider, then run this with the new key.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { encryptSecrets, decryptSecrets, DEFAULT_ITERATIONS } from "../src/songsterr/secrets.js";
import { PROVIDERS } from "../src/songsterr/audio/index.js";
import { ask } from "../bin/prompt.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
let file = path.join(root, "web", "songsterr-secrets.json");
let iterations = DEFAULT_ITERATIONS;
const argv = process.argv.slice(2);
for (let i = 0; i < argv.length; i++) {
  if (argv[i] === "--file") file = path.resolve(argv[++i]);
  else if (argv[i] === "--iterations") iterations = Number(argv[++i]);
  else { console.error("usage: node tools/encrypt-secrets.js [--file <path>] [--iterations <n>]"); process.exit(2); }
}
const fail = (m) => { console.error(m); process.exit(1); };
const shown = path.relative(process.cwd(), file) || file;

let current = {};
let currentPassword = null;
if (fs.existsSync(file)) {
  const enc = JSON.parse(fs.readFileSync(file, "utf8"));
  for (let tries = 0; ; tries++) {
    const pw = await ask(`Current password for ${shown}: `, { hidden: true });
    if (pw == null) fail("no password given");
    try { current = await decryptSecrets(enc, pw); currentPassword = pw; break; } catch (e) {
      if (e.code !== "password" || tries === 2) fail(e.message);
      console.error("Wrong password, try again.");
    }
  }
  console.error(`It holds keys for: ${Object.keys(current).join(", ") || "nothing"}`);
}

const next = { ...current };
let keysChanged = false;
for (const p of Object.values(PROVIDERS).filter((p) => p.needsSecret)) {
  const has = !!current[p.id];
  const v = await ask(`${p.label} key (${p.id})${has ? ", Enter keeps the current one" : ", Enter to skip"}: `, { hidden: true });
  if (!v) continue;
  if (/\s/.test(v)) fail("that key contains spaces; nothing written");
  if (v !== current[p.id]) { next[p.id] = v; keysChanged = true; }
}
if (!Object.keys(next).length) fail("no keys given; nothing written");

let password = currentPassword;
let changed = keysChanged;
const pw = await ask(`New password${currentPassword ? " (Enter keeps the current one)" : ""}: `, { hidden: true });
if (pw) {
  if ((await ask("The new password again: ", { hidden: true })) !== pw) fail("the passwords differ; nothing written");
  if (pw !== currentPassword) { password = pw; changed = true; }
}
if (!password) fail("a password is needed; nothing written");
if (!changed) { console.error("Nothing changed; file left as it was."); process.exit(0); }

const enc = await encryptSecrets(next, password, { iterations });
fs.writeFileSync(file, JSON.stringify(enc, null, 2) + "\n");
console.error(`Wrote ${shown} (keys for: ${Object.keys(next).join(", ")}). Commit and push it.`);
if (currentPassword && password !== currentPassword && !keysChanged) console.error("Note: a new password alone revokes nothing; replace the key to cut access.");
