// AES-256 decryption in the two modes Rocksmith uses: CTR (arrangements) and CFB-128 (the archive's
// table of contents). Both only need the forward cipher (FIPS-197). Plain JavaScript because WebCrypto
// has no CFB mode and is asynchronous; tested against node:crypto.

const SBOX = new Uint8Array(256);
const T0 = new Uint32Array(256), T1 = new Uint32Array(256), T2 = new Uint32Array(256), T3 = new Uint32Array(256);
const xtime = (x) => ((x << 1) ^ (x & 0x80 ? 0x1b : 0)) & 0xff;
(() => {
  // exp/log tables over GF(2^8) with generator 3, then the S-box (inverse + affine transform)
  const exp = new Uint8Array(256), log = new Uint8Array(256);
  for (let i = 0, x = 1; i < 255; i++) { exp[i] = x; log[x] = i; x ^= xtime(x); }
  const rotl8 = (v, n) => ((v << n) | (v >>> (8 - n))) & 0xff;
  for (let a = 0; a < 256; a++) {
    const inv = a ? exp[(255 - log[a]) % 255] : 0;
    const s = inv ^ rotl8(inv, 1) ^ rotl8(inv, 2) ^ rotl8(inv, 3) ^ rotl8(inv, 4) ^ 0x63;
    SBOX[a] = s;
    // round tables: S-box followed by MixColumns' column (2s, s, s, 3s), and its byte rotations
    const t = ((xtime(s) << 24) | (s << 16) | (s << 8) | (xtime(s) ^ s)) >>> 0;
    T0[a] = t;
    T1[a] = ((t >>> 8) | (t << 24)) >>> 0;
    T2[a] = ((t >>> 16) | (t << 16)) >>> 0;
    T3[a] = ((t >>> 24) | (t << 8)) >>> 0;
  }
})();

function expandKey(key) {
  if (key.length !== 32) throw new Error("AES-256 needs a 32-byte key");
  const w = new Uint32Array(60);
  for (let i = 0; i < 8; i++) w[i] = (key[4 * i] << 24) | (key[4 * i + 1] << 16) | (key[4 * i + 2] << 8) | key[4 * i + 3];
  const sub = (x) => (SBOX[x >>> 24] << 24) | (SBOX[(x >>> 16) & 0xff] << 16) | (SBOX[(x >>> 8) & 0xff] << 8) | SBOX[x & 0xff];
  for (let i = 8, rcon = 1; i < 60; i++) {
    let t = w[i - 1];
    if (i % 8 === 0) { t = sub((t << 8) | (t >>> 24)) ^ (rcon << 24); rcon = xtime(rcon); }
    else if (i % 8 === 4) t = sub(t);
    w[i] = w[i - 8] ^ t;
  }
  return w;
}

// Encrypts the 16 bytes at src[0..16) into dst[0..16).
function encryptBlock(w, src, dst) {
  const word = (i) => (src[i] << 24) | (src[i + 1] << 16) | (src[i + 2] << 8) | src[i + 3];
  let s0 = word(0) ^ w[0], s1 = word(4) ^ w[1], s2 = word(8) ^ w[2], s3 = word(12) ^ w[3];
  for (let r = 1; r < 14; r++) {
    const k = 4 * r;
    const t0 = T0[s0 >>> 24] ^ T1[(s1 >>> 16) & 0xff] ^ T2[(s2 >>> 8) & 0xff] ^ T3[s3 & 0xff] ^ w[k];
    const t1 = T0[s1 >>> 24] ^ T1[(s2 >>> 16) & 0xff] ^ T2[(s3 >>> 8) & 0xff] ^ T3[s0 & 0xff] ^ w[k + 1];
    const t2 = T0[s2 >>> 24] ^ T1[(s3 >>> 16) & 0xff] ^ T2[(s0 >>> 8) & 0xff] ^ T3[s1 & 0xff] ^ w[k + 2];
    const t3 = T0[s3 >>> 24] ^ T1[(s0 >>> 16) & 0xff] ^ T2[(s1 >>> 8) & 0xff] ^ T3[s2 & 0xff] ^ w[k + 3];
    s0 = t0; s1 = t1; s2 = t2; s3 = t3;
  }
  // last round: no MixColumns
  const last = (a, b, c, d, k) => ((SBOX[a >>> 24] << 24) | (SBOX[(b >>> 16) & 0xff] << 16) | (SBOX[(c >>> 8) & 0xff] << 8) | SBOX[d & 0xff]) ^ k;
  const out = [last(s0, s1, s2, s3, w[56]), last(s1, s2, s3, s0, w[57]), last(s2, s3, s0, s1, w[58]), last(s3, s0, s1, s2, w[59])];
  for (let i = 0; i < 4; i++) {
    dst[4 * i] = out[i] >>> 24; dst[4 * i + 1] = out[i] >>> 16; dst[4 * i + 2] = out[i] >>> 8; dst[4 * i + 3] = out[i];
  }
}

// CTR mode: the 16-byte IV is a big-endian counter, incremented once per block (same in both directions).
export function aesCtr(key, iv, data) {
  const w = expandKey(key);
  const counter = Uint8Array.from(iv);
  const stream = new Uint8Array(16);
  const out = new Uint8Array(data.length);
  for (let p = 0; p < data.length; p += 16) {
    encryptBlock(w, counter, stream);
    const n = Math.min(16, data.length - p);
    for (let j = 0; j < n; j++) out[p + j] = data[p + j] ^ stream[j];
    for (let j = 15; j >= 0 && ++counter[j] === 256; j--) counter[j] = 0;
  }
  return out;
}

// CFB-128 decryption: each plaintext block is the ciphertext XOR the encrypted previous ciphertext block.
export function aesCfbDecrypt(key, iv, data) {
  const w = expandKey(key);
  const prev = Uint8Array.from(iv);
  const stream = new Uint8Array(16);
  const out = new Uint8Array(data.length);
  for (let p = 0; p < data.length; p += 16) {
    encryptBlock(w, prev, stream);
    const n = Math.min(16, data.length - p);
    for (let j = 0; j < n; j++) out[p + j] = data[p + j] ^ stream[j];
    prev.set(data.subarray(p, p + n));
  }
  return out;
}
