// The audio providers' secrets ({ providerId: secret }), encrypted with one password so the file can sit in
// the public repo and site (web/songsterr-secrets.json) without any key scanner recognizing it.
// PBKDF2-SHA-256 (random salt) → AES-256-GCM, with WebCrypto, which Node ≥ 20 and browsers both have.
// Written by tools/encrypt-secrets.js; read by the CLI and the web app.
//
// The file is public and every version stays in git history: a new password revokes nothing. To cut
// access, replace the key at the provider and encrypt the new one.

export const SECRETS_KIND = "psarc2gp-secrets";
export const SECRETS_VERSION = 1;
export const DEFAULT_ITERATIONS = 600_000;

export class SecretsError extends Error {
  constructor(code, message) { super(message); this.name = "SecretsError"; this.code = code; } // "password" | "format"
}

const subtle = () => {
  const s = globalThis.crypto?.subtle;
  if (!s) throw new Error("WebCrypto isn't available here (a browser needs an https:// or localhost page)");
  return s;
};
const b64 = (bytes) => btoa(String.fromCharCode(...bytes));
const unb64 = (s) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));

async function deriveKey(password, salt, iterations) {
  const base = await subtle().importKey("raw", new TextEncoder().encode(password), "PBKDF2", false, ["deriveKey"]);
  return subtle().deriveKey({ name: "PBKDF2", hash: "SHA-256", salt, iterations }, base, { name: "AES-GCM", length: 256 }, false, ["encrypt", "decrypt"]);
}

export async function encryptSecrets(secrets, password, { iterations = DEFAULT_ITERATIONS } = {}) {
  if (!password) throw new Error("a password is needed");
  if (!secrets || typeof secrets !== "object" || !Object.keys(secrets).length) throw new Error("no secrets to encrypt");
  for (const [k, v] of Object.entries(secrets)) if (typeof v !== "string" || !v) throw new Error(`secret ${k} is empty`);
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const key = await deriveKey(password, salt, iterations);
  const data = new Uint8Array(await subtle().encrypt({ name: "AES-GCM", iv }, key, new TextEncoder().encode(JSON.stringify(secrets))));
  return { kind: SECRETS_KIND, version: SECRETS_VERSION, kdf: "PBKDF2-SHA-256", iterations, salt: b64(salt), cipher: "AES-256-GCM", iv: b64(iv), data: b64(data) };
}

export async function decryptSecrets(file, password) {
  const bad = (m) => { throw new SecretsError("format", `the secrets file is unusable: ${m}`); };
  if (!file || file.kind !== SECRETS_KIND) bad("not a psarc2gp secrets file");
  if (file.version !== SECRETS_VERSION) bad(`version ${file.version}, this psarc2gp reads ${SECRETS_VERSION}`);
  if (file.kdf !== "PBKDF2-SHA-256" || file.cipher !== "AES-256-GCM" || !(file.iterations >= 1)) bad("unknown encryption");
  let salt, iv, data;
  try { [salt, iv, data] = [unb64(file.salt), unb64(file.iv), unb64(file.data)]; } catch { bad("damaged"); }
  if (!password) throw new SecretsError("password", "no password given");
  const key = await deriveKey(password, salt, file.iterations);
  let plain;
  try {
    plain = await subtle().decrypt({ name: "AES-GCM", iv }, key, data);
  } catch {
    throw new SecretsError("password", "wrong password");
  }
  const secrets = JSON.parse(new TextDecoder().decode(plain));
  if (!secrets || typeof secrets !== "object") bad("no secrets inside");
  return secrets;
}
