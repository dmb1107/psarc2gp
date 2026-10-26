// Preview of a Guitar Pro file in Explorer's preview pane. The add-in serves the selected file at
// https://file.psarc2gp/current.gp and passes Explorer's colours as ?bg=rrggbb&fg=rrggbb.
"use strict";

const $ = (id) => document.getElementById(id);
const params = new URLSearchParams(location.search);
for (const [param, cssVar] of [["bg", "--bg"], ["fg", "--fg"]]) {
  const v = params.get(param);
  if (/^[0-9a-f]{6}$/i.test(v ?? "")) document.documentElement.style.setProperty(cssVar, `#${v}`);
}

const NOTE = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"];
const pitch = (midi) => `${NOTE[midi % 12]}${Math.floor(midi / 12) - 1}`;

async function main() {
  const response = await fetch("https://file.psarc2gp/current.gp");
  if (!response.ok) throw new Error(`could not read the file (${response.status})`);
  const bytes = new Uint8Array(await response.arrayBuffer());
  const score = alphaTab.importer.ScoreLoader.loadScoreFromBytes(bytes, new alphaTab.Settings());

  $("title").textContent = score.title || "Untitled";
  $("byline").textContent = [score.artist, score.album].filter(Boolean).join(" · ");

  for (const track of score.tracks) {
    const row = document.createElement("div");
    row.className = "track";
    const name = document.createElement("span");
    name.textContent = track.name;
    const tuning = document.createElement("span");
    // alphaTab lists tunings highest string first
    tuning.textContent = [...track.staves[0].tuning].reverse().map(pitch).join(" ");
    row.append(name, tuning);
    $("tracks").append(row);
  }

  const audio = score.backingTrack?.rawAudioFile;
  if (audio?.length) {
    $("audio").src = URL.createObjectURL(new Blob([audio], { type: "audio/ogg" }));
    $("player").hidden = false;
  }
  $("status").textContent = audio?.length ? "" : "No recording in this file.";
}

main().catch((err) => { $("status").textContent = `Can't preview this file: ${err.message}`; });
