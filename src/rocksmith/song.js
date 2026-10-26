// Loads everything the converter needs from one PSARC: song metadata, arrangements, lyrics, audio.
import { readPsarc } from "./psarc.js";
import { decryptSng, parseSng, maxDifficultyNotes } from "./sng.js";

const ARRANGEMENT_ORDER = { Lead: 0, Rhythm: 1, Combo: 2, Bass: 3 };

export function loadSong(psarcBuffer) {
  const archive = readPsarc(psarcBuffer);
  const mac = archive.names.some((n) => n.startsWith("songs/bin/macos/"));
  const sngDir = mac ? "songs/bin/macos/" : "songs/bin/generic/";
  const manifests = archive.names.filter((n) => n.startsWith("manifests/") && n.endsWith(".json"));

  const arrangements = [];
  let vocals = null;
  let meta = null;
  for (const mPath of manifests) {
    const attrs = Object.values(JSON.parse(archive.read(mPath).toString("utf8")).Entries)[0].Attributes;
    const key = mPath.split("/").pop().replace(/\.json$/, "");
    const sngPath = sngDir + key + ".sng";
    if (!archive.has(sngPath)) continue;
    const sng = parseSng(decryptSng(archive.read(sngPath), { mac }));
    meta ??= {
      title: attrs.SongName, artist: attrs.ArtistName, album: attrs.AlbumName, year: attrs.SongYear,
      length: attrs.SongLength, charter: attrs.CharterName ?? attrs.PackageAuthor,
    };
    if (attrs.ArrangementName === "Vocals" || key.endsWith("_vocals")) {
      vocals = sng.vocals;
      continue;
    }
    const props = attrs.ArrangementProperties ?? {};
    arrangements.push({
      key,
      name: attrs.ArrangementName,
      isBass: attrs.ArrangementName === "Bass" || props.pathBass === 1,
      bonus: props.bonusArr === 1,
      represent: props.represent === 1,
      tuning: sng.meta.tuning,
      centOffset: attrs.CentOffset ?? 0,
      capo: Math.max(0, sng.meta.capo),
      // amp tones, used to pick a fitting Guitar Pro sound (clean / overdrive / distortion / acoustic)
      tones: {
        base: attrs.Tone_Base ?? null,
        list: (attrs.Tones ?? []).map((t) => ({ name: t.Name, key: t.Key, descriptors: t.ToneDescriptors ?? [] })),
      },
      sng,
      notes: maxDifficultyNotes(sng),
    });
  }
  if (!arrangements.length) throw new Error("no playable arrangements found");
  arrangements.sort((a, b) => (ARRANGEMENT_ORDER[a.name] ?? 9) - (ARRANGEMENT_ORDER[b.name] ?? 9) || a.bonus - b.bonus || a.key.localeCompare(b.key));

  // The full song is the largest Wwise file; the other one is the in-game preview clip.
  const wems = archive.names.filter((n) => n.endsWith(".wem"));
  if (!wems.length) throw new Error("no audio (.wem) in archive");
  const wemBuffers = wems.map((n) => archive.read(n)).sort((a, b) => b.length - a.length);

  return { meta, arrangements, vocals, wem: wemBuffers[0] };
}
