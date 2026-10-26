// Test oracle: read a ToneLib .song (zip with the_song.dat score XML) into an alphaTab Score, so the
// converter's notation can be compared bar by bar with ToneLib's quantization of the same chart.
import zlib from "node:zlib";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const alphaTab = require("@coderline/alphatab");

function unzipEntry(buf, wanted) {
  // walk the central directory
  let eocd = buf.length - 22;
  while (eocd >= 0 && buf.readUInt32LE(eocd) !== 0x06054b50) eocd--;
  const count = buf.readUInt16LE(eocd + 10);
  let p = buf.readUInt32LE(eocd + 16);
  for (let i = 0; i < count; i++) {
    const method = buf.readUInt16LE(p + 10);
    const csize = buf.readUInt32LE(p + 20);
    const nlen = buf.readUInt16LE(p + 28), xlen = buf.readUInt16LE(p + 30), clen = buf.readUInt16LE(p + 32);
    const local = buf.readUInt32LE(p + 42);
    const name = buf.toString("utf8", p + 46, p + 46 + nlen);
    if (name === wanted) {
      const lnlen = buf.readUInt16LE(local + 26), lxlen = buf.readUInt16LE(local + 28);
      const data = buf.subarray(local + 30 + lnlen + lxlen, local + 30 + lnlen + lxlen + csize);
      return method === 8 ? zlib.inflateRawSync(data) : data;
    }
    p += 46 + nlen + xlen + clen;
  }
  throw new Error(`${wanted} not found in .song`);
}

const attrs = (s) => Object.fromEntries([...s.matchAll(/(\w+)="([^"]*)"/g)].map((m) => [m[1], m[2]]));
const NOTE = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"];

export function toneLibToAlphaTex(songBuf) {
  const xml = unzipEntry(songBuf, "the_song.dat").toString("utf8").replace(/\0+$/, "");
  const barIndex = xml.slice(xml.indexOf("<BarIndex>"), xml.indexOf("</BarIndex>"));
  const master = [...barIndex.matchAll(/<Bar ([^>]*?)(\/>|>([\s\S]*?)<\/Bar>)/g)].map((m) => {
    const a = attrs(m[1]);
    const ts = m[3] && /<time_sign ([^>]*)\/>/.exec(m[3]);
    return { tempo: a.tempo, ts: ts && attrs(ts[1]) };
  });
  const lines = ["\\title \"ToneLib\"", "."];
  const tracks = [...xml.matchAll(/<Track ([\s\S]*?)>([\s\S]*?)<\/Track>/g)];
  tracks.forEach((t, ti) => {
    const ta = attrs(t[1]);
    const strings = [...t[2].matchAll(/<String ([^>]*)\/>/g)].map((s) => attrs(s[1])).sort((a, b) => a.id - b.id);
    lines.push(`\\track "${ta.name} ${ti + 1}"`, "\\staff {score tabs}",
      `\\tuning (${strings.map((s) => `${NOTE[s.tuning % 12]}${Math.floor(s.tuning / 12) - 1}`).join(" ")})`);
    const bars = [...t[2].matchAll(/<Bar id="\d+">([\s\S]*?)<\/Bar>/g)].map((b, bi) => {
      const head = [];
      if (ti === 0 && master[bi]?.ts) head.push(`\\ts (${master[bi].ts.numerator} ${master[bi].ts.duration})`);
      if (ti === 0 && master[bi]?.tempo) head.push(`\\tempo ${parseInt(master[bi].tempo, 10)}`);
      const beats = [...b[1].matchAll(/<Beat ([^>]*?)(\/>|>([\s\S]*?)<\/Beat>)/g)].map((bm) => {
        const ba = attrs(bm[1]);
        const notes = [...(bm[3] ?? "").matchAll(/<Note ([^>]*?)(\/>|>([\s\S]*?)<\/Note>)/g)].map((nm) => {
          const na = attrs(nm[1]);
          const eff = [];
          if (na.tied === "yes") eff.push("t");
          if (/dead="yes"/.test(nm[3] ?? "")) eff.push("x");
          return `${na.fret}.${na.string}${eff.length ? `{${eff.join(" ")}}` : ""}`;
        });
        const beff = [];
        if (ba.dotted === "1") beff.push("d");
        if (ba.n && ba.t) beff.push(`tu ${ba.n} ${ba.t}`); // n notes in the time of t
        const body = !notes.length ? "r" : notes.length === 1 ? notes[0] : `(${notes.join(" ")})`;
        return `${body}.${ba.duration}${beff.length ? `{${beff.join(" ")}}` : ""}`;
      });
      return [...head, ...beats].join(" ");
    });
    lines.push(bars.join(" |\n"));
  });
  return lines.join("\n");
}

export function loadToneLib(songBuf) {
  return alphaTab.importer.ScoreLoader.loadAlphaTex(toneLibToAlphaTex(songBuf), new alphaTab.Settings());
}
