// Guitar Pro RSE sounds for converted tracks.
//
// alphaTab writes every track for Guitar Pro's MIDI engine. In Guitar Pro that plays through the system
// MIDI synth (on Windows the Microsoft GS Wavetable Synth), which lags the audio track by its own output
// latency. RSE (Realistic Sound Engine) is Guitar Pro's built-in sampled-instrument engine; it renders in
// the same audio engine as the audio track, so the synth stays in time with the recording. This module
// picks an RSE sound for each arrangement and patches it into score.gpif after alphaTab has written it.
//
// The sound definitions are copied from files saved by Guitar Pro 8.1 (alphaTab's GP8 test files).

const sound = (label, path, program, patch, pickup, effects) => ({ label, path, program, patch, pickup, effects });

export const SOUNDS = {
  bass: sound("Electric Bass (finger)", "Stringed/Basses/Clean Bass", 33, "Pre-Bass", 0, [
    ["A10_StackClassic", "0.45 0 0 0.63 0.37 0.39 0.39 0.54808"],
    ["E31_EqBEq", "0.656566 0.59596 0.59596 0.676768 0.666667 0.616162 0.707071 0.181818"],
    ["M07_DynamicClassicDynamic", "0.7 0.64856 0.80469"],
  ]),
  clean: sound("Electric Guitar (clean)", "Stringed/Electric Guitars/Clean Guitar", 27, "Strat-Guitar", 1, [
    ["A01_ComboTop30", "0.61 0.59 0.38 0.511667 0.21 0.29 0 0"],
    ["E30_EqGEq", "0.161616 0.464646 0.464646 0.464646 0.464646 0.464646 0.464646 0.606061"],
    ["M07_DynamicClassicDynamic", "0.59523 0.15714 0.66187"],
  ]),
  overdrive: sound("Overdriven Guitar", "Stringed/Electric Guitars/Overdrive Guitar", 29, "Strat-Guitar", 4, [
    ["E03_OverdriveScreamer", "0.84 0.5 0.84"],
    ["A05_StackBritishVintage", "0.85 0.67 0.36 0.66 0.52"],
    ["E30_EqGEq", "0.494949 0.373737 0.494949 0.40404 0.484848 0.484848 0.484848 0.363636"],
  ]),
  distortion: sound("Distortion Guitar", "Stringed/Electric Guitars/Distortion Guitar", 30, "Classic-Guitar", 2, [
    ["E03_OverdriveScreamer", "0.85 0 0.67"],
    ["A06_StackBritishStack", "1 0.91 0.67 0.32 0.69 0.51 0.95 0"],
    ["E30_EqGEq", "0.171717 0.474747 0.474747 0.474747 0.474747 0.474747 0.474747 0.222222"],
  ]),
  acoustic: sound("Acoustic Guitar (steel)", "Stringed/Acoustic Guitars/Steel Guitar", 25, "D-Steel", 0, [
    ["E30_EqGEq", "0.121212 0.484848 0.484848 0.484848 0.484848 0.585859 0.585859 0.69697"],
    ["M07_DynamicClassicDynamic", "0.5 0.23333 0.6142"],
    ["M04_StudioReverbRoomAmbience", "1 0.43 0.4 0.5 0.2"],
  ]),
};

// Rocksmith tone descriptors ("$[35722]DISTORTION") -> sound. Most driven wins.
const DESCRIPTOR_SOUND = [
  [/DISTORTION|HIGH ?GAIN|FUZZ|METAL/, "distortion"],
  [/OVERDRIVE|CRUNCH|DRIVE/, "overdrive"],
  [/ACOUSTIC/, "acoustic"],
];

// Pick a sound for an arrangement: bass for bass parts (incl. extended-range parts in a guitar slot),
// otherwise from the arrangement's base tone (or all its tones if the base tone isn't listed).
export function chooseSound(arr, { bass }) {
  if (bass) return "bass";
  const tones = arr.tones?.list ?? [];
  const base = String(arr.tones?.base ?? "").toLowerCase();
  const baseTone = tones.find((t) => [t.name, t.key].some((n) => String(n ?? "").toLowerCase() === base));
  const descriptors = (baseTone ? [baseTone] : tones).flatMap((t) => t.descriptors ?? []).map((d) => String(d).replace(/^\$\[\d+\]/, "").toUpperCase());
  for (const [re, key] of DESCRIPTOR_SOUND) if (descriptors.some((d) => re.test(d))) return key;
  return "clean";
}

const cdata = (s) => `<![CDATA[${s}]]>`;
const automationValue = (s) => `${s.path};${s.label};User`;

function soundsXml(s) {
  const effects = s.effects.map(([id, p]) => `<Effect id="${id}"><Parameters>${p}</Parameters></Effect>`).join("");
  return `<Sounds><Sound><Name>${cdata(s.label)}</Name><Label>${cdata(s.label)}</Label><Path>${s.path}</Path><Role>User</Role>` +
    `<MIDI><LSB>0</LSB><MSB>0</MSB><Program>${s.program}</Program></MIDI>` +
    `<RSE><SoundbankPatch>${s.patch}</SoundbankPatch><ElementsSettings></ElementsSettings>` +
    `<Pickups><OverloudPosition>${s.pickup}</OverloudPosition><Volumes>1 1</Volumes><Tones>1 1</Tones></Pickups>` +
    `<EffectChain>${effects}</EffectChain></RSE></Sound></Sounds>`;
}

function replaceOnce(xml, pattern, replacement, what) {
  let n = 0;
  const out = xml.replace(pattern, (...m) => { n++; return typeof replacement === "function" ? replacement(...m) : replacement; });
  if (n !== 1) throw new Error(`score.gpif: expected one ${what}, found ${n} (alphaTab output changed?)`);
  return out;
}

// Switch every instrument track in an alphaTab-written score.gpif to the given RSE sounds
// (soundKeys[i] for track i). Throws if the XML doesn't look like what alphaTab 1.8 writes, so a library
// upgrade that changes the output fails loudly instead of producing a half-patched file.
export function useRseSounds(gpif, soundKeys) {
  const start = gpif.indexOf("<Tracks><Track ");
  const end = gpif.indexOf("</Tracks>", start);
  if (start < 0 || end < 0) throw new Error("score.gpif: no <Tracks> element");
  let seen = 0;
  const tracks = gpif.slice(start, end).replace(/<Track id="(\d+)">([\s\S]*?)<\/Track>/g, (all, id, body) => {
    const key = soundKeys[+id];
    const s = SOUNDS[key];
    if (!s) throw new Error(`no RSE sound "${key}" for track ${id}`);
    seen++;
    body = replaceOnce(body, /<Sounds>[\s\S]*?<\/Sounds>/g, "", "<Sounds>");
    // Guitar Pro writes <Sounds> right after <ForcedSound>; alphaTab writes it after <Staves>
    body = replaceOnce(body, /<ForcedSound>-?\d+<\/ForcedSound>/g, (m) => m + soundsXml(s), "<ForcedSound>");
    body = replaceOnce(body, /<AudioEngineState>MIDI<\/AudioEngineState>/g, "<AudioEngineState>RSE</AudioEngineState>", "MIDI engine state");
    let automations = 0;
    body = body.replace(/(<Automation><Type>Sound<\/Type>[\s\S]*?<Value>)([\s\S]*?)(<\/Value>)/g, (m, a, _v, b) => { automations++; return a + cdata(automationValue(s)) + b; });
    if (!automations) throw new Error(`score.gpif: track ${id} has no sound automation`);
    if (key === "bass") body = body.replace("<PlayingStyle>StringedPick</PlayingStyle>", "<PlayingStyle>StringedFinger</PlayingStyle>");
    return `<Track id="${id}">${body}</Track>`;
  });
  if (seen !== soundKeys.length) throw new Error(`score.gpif: expected ${soundKeys.length} tracks, found ${seen}`);
  return gpif.slice(0, start) + tracks + gpif.slice(end);
}
