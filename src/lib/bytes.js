// Byte helpers on plain Uint8Arrays, so the converter runs in browsers as well as Node (whose Buffer is a
// Uint8Array too).

export const view = (bytes) => new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);

export const fromHex = (hex) => Uint8Array.from(hex.match(/../g), (h) => parseInt(h, 16));

export function latin1(bytes, start = 0, end = bytes.length) {
  let s = "";
  for (let i = start; i < end; i++) s += String.fromCharCode(bytes[i]);
  return s;
}

const decoder = new TextDecoder();
export const utf8 = (bytes, start = 0, end = bytes.length) => decoder.decode(bytes.subarray(start, end));

const encoder = new TextEncoder();
export const toBytes = (data) => (typeof data === "string" ? encoder.encode(data) : data);

export function concat(parts) {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) { out.set(p, at); at += p.length; }
  return out;
}
