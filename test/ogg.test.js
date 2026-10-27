import test from "node:test";
import assert from "node:assert/strict";
import { OggWriter, oggCrc } from "../src/audio/ogg.js";

test("Ogg CRC matches the standard check value", () => {
  assert.equal(oggCrc(Buffer.from("123456789")), 0x89a1897f);
});

function parsePages(bytes) {
  const buf = Buffer.from(bytes);
  const pages = [];
  let p = 0;
  while (p < buf.length) {
    assert.equal(buf.toString("latin1", p, p + 4), "OggS");
    const nseg = buf[p + 26];
    const lacing = [...buf.subarray(p + 27, p + 27 + nseg)];
    const size = 27 + nseg + lacing.reduce((a, b) => a + b, 0);
    const page = Buffer.from(buf.subarray(p, p + size));
    const crc = page.readUInt32LE(22);
    page.writeUInt32LE(0, 22);
    assert.equal(oggCrc(page), crc, "page CRC");
    pages.push({ flags: buf[p + 5], granule: buf.readBigInt64LE(p + 6), seq: buf.readUInt32LE(p + 18), lacing });
    p += size;
  }
  return pages;
}

test("pages carry correct flags, sequence numbers, lacing and granules", () => {
  const w = new OggWriter();
  w.addPacket(Buffer.alloc(30, 1), 0, { flush: true });
  for (let i = 1; i <= 50; i++) w.addPacket(Buffer.alloc(200, i), i * 1000);
  w.addPacket(Buffer.alloc(510, 7), 51000, { last: true }); // exact multiple of 255 needs a 0 lacing value
  const pages = parsePages(w.finish());
  assert.equal(pages[0].flags & 2, 2, "first page is BOS");
  assert.equal(pages.at(-1).flags & 4, 4, "last page is EOS");
  pages.forEach((pg, i) => assert.equal(pg.seq, i));
  assert.equal(pages.at(-1).granule, 51000n);
  assert.deepEqual(pages.at(-1).lacing.slice(-3), [255, 255, 0]);
});

test("a packet larger than one page spans pages with continuation flags", () => {
  const w = new OggWriter();
  w.addPacket(Buffer.alloc(70000, 3), 1234, { last: true });
  const pages = parsePages(w.finish());
  assert.ok(pages.length >= 2);
  assert.equal(pages[0].granule, -1n, "no packet ends on the first page");
  assert.equal(pages[1].flags & 1, 1, "second page continues the packet");
  assert.equal(pages.at(-1).granule, 1234n);
});
