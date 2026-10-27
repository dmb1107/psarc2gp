import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { crc32, readZip, writeZip, makeEntry, entryData, rewriteZipEntry } from "../src/gp/zip.js";
import { SOUNDS, chooseSound, useRseSounds } from "../src/gp/rse.js";

const alphaTab = createRequire(import.meta.url)("@coderline/alphatab");

test("crc32 check value", () => {
  assert.equal(crc32(Buffer.from("123456789")), 0xcbf43926);
});

test("zip: rewrite one entry, copy the rest byte for byte", async () => {
  const big = Buffer.alloc(100000, 7);
  const zip = writeZip([await makeEntry("a.txt", "hello"), await makeEntry("dir/", ""), await makeEntry("big.bin", big)]);
  const out = await rewriteZipEntry(zip, "a.txt", (d) => Buffer.from(d).toString() + " world");
  const before = readZip(zip);
  const after = readZip(out);
  assert.deepEqual(after.map((e) => e.name), ["a.txt", "dir/", "big.bin"]);
  assert.equal(Buffer.from(entryData(after[0])).toString(), "hello world");
  assert.ok(Buffer.from(after[2].raw).equals(before[2].raw));
  assert.ok(Buffer.from(entryData(after[2])).equals(big));
});

test("sound choice from Rocksmith tones", () => {
  const arr = (base, ...tones) => ({ tones: { base, list: tones.map(([name, ...descriptors]) => ({ name, key: name, descriptors })) } });
  assert.equal(chooseSound(arr(null), { bass: true }), "bass");
  assert.equal(chooseSound(arr(null), { bass: false }), "clean");
  assert.equal(chooseSound(arr("LEAD", ["CLEAN", "$[35720]CLEAN"], ["LEAD", "$[35724]LEAD"]), { bass: false }), "clean");
  assert.equal(chooseSound(arr("crunch", ["clean", "$[35720]CLEAN"], ["crunch", "$[35716]OVERDRIVE"]), { bass: false }), "overdrive");
  // base tone not in the list: the most driven of all tones
  assert.equal(chooseSound(arr("Dist", ["OD2", "$[35720]CLEAN"], ["OD2", "$[35722]DISTORTION"], ["OD", "$[35716]OVERDRIVE"]), { bass: false }), "distortion");
  assert.equal(chooseSound(arr("ac", ["ac", "$[35721]ACOUSTIC"]), { bass: false }), "acoustic");
});

test("RSE sounds and mute survive Guitar Pro export and re-import", async () => {
  const tex = `\\title "t" .
\\track "Bass" \\staff {score tabs} \\tuning (G2 D2 A1 E1) \\instrument 33 0.4.4 2.4.4 3.4.4 5.4.4 |
\\track "Lead" \\staff {score tabs} \\instrument 30 0.6.4 2.6.4 3.6.4 5.6.4 |`;
  const settings = new alphaTab.Settings();
  const score = alphaTab.importer.ScoreLoader.loadAlphaTex(tex, settings);
  for (const t of score.tracks) t.playbackInfo.isMute = true;
  const gp = Buffer.from(new alphaTab.exporter.Gp7Exporter().export(score, settings));
  const out = await rewriteZipEntry(gp, "Content/score.gpif", (x) => useRseSounds(Buffer.from(x).toString(), ["bass", "distortion"]));

  const gpif = Buffer.from(entryData(readZip(out).find((e) => e.name === "Content/score.gpif"))).toString();
  const tracks = gpif.match(/<Track id="\d+">[\s\S]*?<\/Track>/g);
  assert.equal(tracks.length, 2);
  for (const [t, key] of [[tracks[0], "bass"], [tracks[1], "distortion"]]) {
    const s = SOUNDS[key];
    assert.match(t, /<AudioEngineState>RSE<\/AudioEngineState>/);
    assert.match(t, /<PlaybackState>Mute<\/PlaybackState>/);
    assert.equal(t.match(/<Sound>/g).length, 1);
    assert.ok(t.includes(`<SoundbankPatch>${s.patch}</SoundbankPatch>`));
    assert.ok(t.includes(`<Value><![CDATA[${s.path};${s.label};User]]></Value>`));
    // same element order as Guitar Pro writes
    assert.ok(t.indexOf("<ForcedSound>") < t.indexOf("<Sounds>") && t.indexOf("<Sounds>") < t.indexOf("<MidiConnection>"));
  }
  assert.match(tracks[0], /<PlayingStyle>StringedFinger<\/PlayingStyle>/);

  const back = alphaTab.importer.ScoreLoader.loadScoreFromBytes(new Uint8Array(out), settings);
  assert.deepEqual(back.tracks.map((t) => [t.playbackInfo.program, t.playbackInfo.isMute]), [[33, true], [30, true]]);
});

test("RSE patch refuses XML it doesn't recognise", () => {
  assert.throws(() => useRseSounds("<GPIF></GPIF>", ["bass"]), /no <Tracks>/);
  assert.throws(() => useRseSounds('<Tracks><Track id="0"><Name/></Track></Tracks>', ["bass"]), /expected one <Sounds>/);
});
