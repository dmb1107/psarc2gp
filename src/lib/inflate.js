// Deflate decompression (RFC 1951; RFC 1950 zlib wrapper) in plain JavaScript. Browsers have
// DecompressionStream, but it is asynchronous and rejects data after the end of the stream, dropping
// output it has already decoded; Rocksmith arrangements have such trailing bytes. This stops at the end
// of the final block and ignores whatever follows, like zlib with Z_SYNC_FLUSH. Tested against node:zlib.

const LENGTH_BASE = [3, 4, 5, 6, 7, 8, 9, 10, 11, 13, 15, 17, 19, 23, 27, 31, 35, 43, 51, 59, 67, 83, 99, 115, 131, 163, 195, 227, 258];
const LENGTH_EXTRA = [0, 0, 0, 0, 0, 0, 0, 0, 1, 1, 1, 1, 2, 2, 2, 2, 3, 3, 3, 3, 4, 4, 4, 4, 5, 5, 5, 5, 0];
const DIST_BASE = [1, 2, 3, 4, 5, 7, 9, 13, 17, 25, 33, 49, 65, 97, 129, 193, 257, 385, 513, 769, 1025, 1537, 2049, 3073, 4097, 6145, 8193, 12289, 16385, 24577];
const DIST_EXTRA = [0, 0, 0, 0, 1, 1, 2, 2, 3, 3, 4, 4, 5, 5, 6, 6, 7, 7, 8, 8, 9, 9, 10, 10, 11, 11, 12, 12, 13, 13];
const CODE_LENGTH_ORDER = [16, 17, 18, 0, 8, 7, 9, 6, 10, 5, 11, 4, 12, 3, 13, 2, 14, 1, 15];

export class InflateError extends Error {}

// Lookup table for a canonical Huffman code: indexed by the next `bits` input bits (LSB first), each entry
// is symbol << 4 | code length (0 marks a bit pattern no code starts with).
function huffman(lengths) {
  const bits = Math.max(1, ...lengths);
  const count = new Uint16Array(16);
  for (const l of lengths) count[l]++;
  count[0] = 0;
  const next = new Uint16Array(16);
  for (let l = 1, code = 0; l < 16; l++) { code = (code + count[l - 1]) << 1; next[l] = code; }
  const table = new Uint16Array(1 << bits);
  lengths.forEach((l, sym) => {
    if (!l) return;
    let code = next[l]++, rev = 0;
    for (let i = 0; i < l; i++) { rev = (rev << 1) | (code & 1); code >>= 1; }
    for (let i = rev; i < table.length; i += 1 << l) table[i] = (sym << 4) | l;
  });
  return { table, bits };
}

const FIXED_LITERALS = huffman(Array.from({ length: 288 }, (_, i) => (i < 144 ? 8 : i < 256 ? 9 : i < 280 ? 7 : 8)));
const FIXED_DISTANCES = huffman(new Array(30).fill(5));

// zlib: true expects (and checks) the 2-byte zlib header and the Adler-32 trailer when it is present.
// sizeHint: expected output size, to allocate once.
export function inflate(data, { zlib = true, sizeHint = 0 } = {}) {
  let pos = 0, bitBuf = 0, bitCnt = 0;
  if (zlib) {
    if (data.length < 2 || (data[0] & 0x0f) !== 8 || ((data[0] << 8) | data[1]) % 31 !== 0) throw new InflateError("not a zlib stream");
    if (data[1] & 0x20) throw new InflateError("zlib preset dictionary not supported");
    pos = 2;
  }
  let out = new Uint8Array(Math.max(sizeHint, 1024));
  let len = 0;
  const room = (n) => {
    if (len + n <= out.length) return;
    const bigger = new Uint8Array(Math.max(out.length * 2, len + n));
    bigger.set(out.subarray(0, len));
    out = bigger;
  };

  // input past the end reads as zeros, a few bytes' worth, so a table lookup can look ahead
  const need = (n) => {
    while (bitCnt < n) {
      if (pos >= data.length + 4) throw new InflateError("unexpected end of data");
      bitBuf |= (pos < data.length ? data[pos] : 0) << bitCnt;
      pos++;
      bitCnt += 8;
    }
  };
  const bits = (n) => {
    if (!n) return 0;
    need(n);
    const v = bitBuf & ((1 << n) - 1);
    bitBuf >>>= n;
    bitCnt -= n;
    return v;
  };
  const decode = ({ table, bits: width }) => {
    need(width);
    const e = table[bitBuf & ((1 << width) - 1)];
    if (!e) throw new InflateError("invalid Huffman code");
    bitBuf >>>= e & 15;
    bitCnt -= e & 15;
    return e >> 4;
  };

  let final = 0;
  while (!final) {
    final = bits(1);
    const type = bits(2);
    if (type === 0) {
      // stored block: byte-aligned length, its complement, then the bytes
      bitBuf = 0;
      pos -= bitCnt >> 3; // give back whole bytes read ahead
      bitCnt = 0;
      if (pos + 4 > data.length) throw new InflateError("unexpected end of data");
      const n = data[pos] | (data[pos + 1] << 8);
      if ((n ^ (data[pos + 2] | (data[pos + 3] << 8))) !== 0xffff) throw new InflateError("corrupt stored block");
      pos += 4;
      if (pos + n > data.length) throw new InflateError("unexpected end of data");
      room(n);
      out.set(data.subarray(pos, pos + n), len);
      len += n;
      pos += n;
      continue;
    }
    let literals, distances;
    if (type === 1) {
      literals = FIXED_LITERALS;
      distances = FIXED_DISTANCES;
    } else if (type === 2) {
      const nLit = bits(5) + 257, nDist = bits(5) + 1, nCode = bits(4) + 4;
      const codeLengths = new Array(19).fill(0);
      for (let i = 0; i < nCode; i++) codeLengths[CODE_LENGTH_ORDER[i]] = bits(3);
      const lengthCode = huffman(codeLengths);
      const lengths = [];
      while (lengths.length < nLit + nDist) {
        const sym = decode(lengthCode);
        if (sym < 16) lengths.push(sym);
        else {
          if (sym === 16 && !lengths.length) throw new InflateError("repeat with no previous length");
          const [value, repeat] = sym === 16 ? [lengths.at(-1), 3 + bits(2)] : sym === 17 ? [0, 3 + bits(3)] : [0, 11 + bits(7)];
          for (let i = 0; i < repeat; i++) lengths.push(value);
        }
      }
      if (lengths.length > nLit + nDist) throw new InflateError("too many code lengths");
      literals = huffman(lengths.slice(0, nLit));
      distances = huffman(lengths.slice(nLit));
    } else {
      throw new InflateError("invalid block type");
    }

    for (;;) {
      const sym = decode(literals);
      if (sym < 256) {
        room(1);
        out[len++] = sym;
      } else if (sym === 256) {
        break;
      } else {
        const li = sym - 257;
        if (li >= 29) throw new InflateError("invalid length code");
        const n = LENGTH_BASE[li] + bits(LENGTH_EXTRA[li]);
        const di = decode(distances);
        if (di >= 30) throw new InflateError("invalid distance code");
        const dist = DIST_BASE[di] + bits(DIST_EXTRA[di]);
        if (dist > len) throw new InflateError("distance before start of output");
        room(n);
        for (let i = 0; i < n; i++, len++) out[len] = out[len - dist];
      }
    }
  }
  pos -= bitCnt >> 3; // unread whole bytes belong to whatever follows
  if (pos > data.length) throw new InflateError("unexpected end of data");

  if (zlib && pos + 4 <= data.length) {
    let a = 1, b = 0;
    for (let i = 0; i < len; i++) { a = (a + out[i]) % 65521; b = (b + a) % 65521; }
    const stored = ((data[pos] << 24) | (data[pos + 1] << 16) | (data[pos + 2] << 8) | data[pos + 3]) >>> 0;
    if (stored !== ((b << 16) | a) >>> 0) throw new InflateError("incorrect data check");
  }
  return out.subarray(0, len);
}
