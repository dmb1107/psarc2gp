# psarc2gp

Converts Rocksmith 2014 custom songs (CDLC `.psarc`) into Guitar Pro 8 files (`.gp`) with the original
recording embedded as the audio track and **a sync point on every beat**, so the score scrolls, the cursor
highlights notes in time with the recording, and you can pause, jump back, loop, or switch to the
synthesized instrument without drifting.

- Notation (standard + tab) for every arrangement in the file: lead, rhythm, bass, alternates, bonus parts
- Audio decoded from Rocksmith's Wwise format to Ogg Vorbis (built-in port of ww2ogg, no extra tools)
- Every Rocksmith beat is pinned to its exact time in the recording; nothing to line up by hand
- Instrument tracks use Guitar Pro's own RSE sounds (bass, clean/overdriven/distorted/acoustic guitar), which
  play in time with the recording, and start muted so you hear just the song until you unmute a part
- Runs offline in about 1–3 seconds per song

## Install (Windows)

1. Install [Node.js](https://nodejs.org) 20 or newer (the LTS installer is fine).
2. Put this folder somewhere permanent, e.g. `C:\Tools\psarc2gp`.
3. Double-click `windows\install.cmd`. It installs the one dependency and adds two entries to the
   **Send to** menu. `windows\uninstall.cmd` removes them. The entries run Node.js from where it is
   installed now; if you move this folder or reinstall Node.js somewhere else, run `install.cmd` again.

## Use

Select one or more `.psarc` files (or a folder of them), right-click, **Send to → Guitar Pro (synced)**.
On Windows 11 the Send to menu is under **Show more options** (or press Shift+F10).
A folder converts the `.psarc` files directly inside it, not those in subfolders. Windows hands over at
most about 32,000 characters of file names (a few hundred files); for more, send their folder.
A window shows the progress and closes 10 seconds after it's done; if a file failed, it stays open until
you press a key.

`Artist - Title.gp` is written next to each `.psarc`. If that file already exists it is left alone, so
edits you made in Guitar Pro are never overwritten; use **Guitar Pro (synced, overwrite)** to regenerate.

To put every `.gp` into one folder instead (a Google Drive folder, say), install with that folder from a
terminal: `C:\Tools\psarc2gp\windows\install.cmd "G:\My Drive\Guitar Pro"`. Running `install.cmd`
without a folder goes back to writing next to each `.psarc`. In one folder, a second chart of the same
song is skipped like any existing file.

Command line (any OS):

```
node bin/psarc2gp.js [options] <file.psarc | folder> ...

  -f, --force       overwrite an existing .gp
  -o, --out <dir>   write .gp files into this folder
  -r, --recursive   also look in subfolders
      --no-audio    don't embed the recording
      --no-mute     leave the instrument tracks unmuted
      --midi        General MIDI sounds instead of RSE (these lag the recording in Guitar Pro)
      --atex        also write the intermediate alphaTex (.atex) for debugging
      --pause       keep the console window open when done (used by the Send To entries)
  -q, --quiet       only print errors
```

## In Guitar Pro

- The recording is the **Audio Track**; it has its own volume, mute and solo next to the instrument
  tracks. The instrument tracks start **muted**: unmute the bass (or any) track to hear its synth along with
  the recording, or mute the recording to hear the synth alone.
- Instrument tracks use **RSE** sounds (Guitar Pro's Realistic Sound Engine, its built-in sampled
  instruments). RSE plays inside Guitar Pro's audio engine together with the audio track, so the two stay
  in time. Tracks set to MIDI play through your computer's MIDI synth instead (on Windows usually the
  Microsoft GS Wavetable Synth), which adds its own delay and sounds late against the recording. If you
  change a track's sound, pick an RSE one. Guitar sounds are chosen from the chart's Rocksmith tones
  (clean, overdrive, distortion, acoustic).
- Slow down with **relative speed (%)**, not a fixed tempo; Guitar Pro disables the audio track in
  fixed-tempo mode.
- The audio always plays straight through, so don't fold sections into repeat signs.
- The cursor may look a little ahead of the sound. That is the audio output latency of your sound
  device, not the file; the synth and the recording stay together.

## Preview in Explorer (optional)

With Explorer's preview pane open (**View → Preview pane**, or Alt+P), selecting a `.gp` file shows its
score and starts playing the recording, with a cursor that follows along, without opening Guitar Pro.
Pick a track at the top (it starts on a bass part, then remembers your pick); Space pauses and plays.
It follows Windows' light or dark mode and works for any Guitar Pro 7/8 file; files without a recording
play through alphaTab's synthesizer. A preview doesn't change the file's *Date accessed*.

To install it, install the .NET SDK once (`winget install Microsoft.DotNet.SDK.10`), then double-click
`windows\install-preview.cmd`. It builds the add-in and registers it; Windows asks for admin rights once.
`windows\uninstall-preview.cmd` removes it. If you move the psarc2gp folder, run the installer again.

## Web app (any computer with a browser)

The same converter runs in a web page, with a practice player and a library kept in the browser. Files
never leave the computer: conversion runs inside the page (in a background worker) and songs are stored
in the browser's own storage (IndexedDB). Nothing is uploaded, and the site is a set of static files.

- **Convert:** drop `.psarc` files or a folder on the page, or use *Choose files* / *Choose a folder*.
  Each song is added to the library; a song already there is kept unless you click *Replace it*.
  Existing `.gp` files can be added too. The page points newcomers to
  [CustomsForge Ignition](https://ignition4.customsforge.com/) for songs.
- **Library:** search, sort (recently played, added, artist, title), download the `.gp`, remove.
  Songs stay in that browser on that computer; clearing the site's data in the browser deletes them, so
  download the files you want to keep.
- **Player:** notation + tab of one track at a time (tabs at the top) with the cursor following the
  recording. *Recording / Synth* switches between the original recording and alphaTab's synthesizer
  (with *Only this track* on, just the part on screen), keeping your place. *Speed* goes from 25 % to
  150 % (the recording keeps its pitch). Drag across the score to select a passage, then *Loop* repeats
  it; with nothing selected, Loop repeats the song. Space plays and pauses.
- The synthesizer plays at the score's written tempo, which can differ slightly from the recording's,
  and it can't play together with the recording (an alphaTab limit). Guitar Pro can mix both.

Run it locally with `npm run web` and open <http://localhost:8765/web/>. To put it online,
`npm run build:web` writes the static site to `dist/site` (about 6 MB); upload that folder to any static
host (GitHub Pages, Netlify, Cloudflare Pages). It works in current Chrome, Edge and Firefox; Safari needs
version 18.4 or later (macOS 15.4 / iOS 18.4) to play the recording (Ogg Vorbis).

**GitHub Pages:** `.github/workflows/pages.yml` runs the tests, builds the site and publishes it on every
push to `main`. One-time setup in the repository: *Settings → Pages → Build and deployment → Source:
GitHub Actions*. The site is then at `https://<user>.github.io/<repo>/`. Every path in the site is
relative, so it works from a subfolder; Pages is case-sensitive, so file names must match exactly.

## How it works

```
.psarc ─┬─ table of contents (AES-256-CFB) ─ zlib blocks ─ files
        ├─ arrangements (.sng, AES-256-CTR + zlib) ─ beat grid, notes at max difficulty, chords, techniques
        │     └─ notation: bars from the beat grid, each beat snapped to the best grid
        │        (16ths, 8th/16th triplets, 32nds, 64ths), durations from sustains → alphaTex
        ├─ audio (.wem, Wwise Vorbis) ─ ww2ogg port ─ Ogg Vorbis with correct granule positions
        └─ alphaTab: alphaTex + audio + per-beat sync points → Guitar Pro 7/8 file
```

Rocksmith charts store notes as timestamps, not rhythms. Each beat gets the grid (16ths, 8th or 16th
triplets, 32nds, 64ths) with the lowest timing error plus a small readability cost, so plain 16ths win
unless a finer grid clearly fits better. On the six test songs, 95 % of notes on every track land within
1 ms of their Rocksmith time; the worst cases (about 40 ms) are main notes right after grace notes in
loosely charted runs. Against ToneLib's notation of the same charts, 96–100 % of note onsets agree.

### Notation choices (where it intentionally differs from ToneLib)

- **Notes the chart gives no length** (most guitar chords, many bass notes) fill to the next note but stop
  at the bar line. In Rocksmith no sustain means a short hit, and this avoids guessed ties across bars.
  Notes the chart *does* sustain are held as charted, through to the next note if they end within a beat of it.
- **Linked notes** (Rocksmith "link next", e.g. a held note ending in a slide) are written as ties,
  not re-picked notes.
- **Quick slides and hammer-ons into a note** become grace notes: on the beat if the grace is on the
  grid, before the beat if the main note is.
- **Triplet beats** use one note value per beat with ties, so tuplet groups are always complete.
- **Count-in:** charts that start well into the recording get rest bars in front so the intro plays.

### What gets converted

| Rocksmith | Guitar Pro |
|---|---|
| notes, chords (with names when the chord changes), double stops | notes / chords |
| sustain, linked notes | durations, ties |
| hammer-on / pull-off | hammer/pull slur from the origin note |
| slide to a fret, unpitched slide | shift / legato slide, slide out up/down |
| quick slide or hammer into a note | on-beat grace note |
| bend (with release / prebend) | bend |
| vibrato, palm mute, muted notes, harmonics, pinch harmonics, accents | same |
| tap, slap, pop, tremolo picking | same |
| tunings incl. drop/E♭ and extended-range charts (cent offset −1200) | real tuning (e.g. B-E-A-D, 6-string bass) |
| sections, time signatures (incl. odd meters), tempo | sections, time signatures, tempo marks |
| intro audio before the first charted beat | rest bars at the start |
| amp tones (clean / overdrive / distortion / acoustic) | RSE instrument sound per track |

Not converted (yet): lyrics/vocals, fingering, strum direction, let-ring, tone changes. Capo charts
convert but haven't been checked against a real capo chart. Mac (`_m.psarc`) files are supported but
untested.

## Development

Project background, requirements and decisions: [docs/PRODUCT.md](docs/PRODUCT.md). Current state,
verification and next steps: [docs/HANDOFF.md](docs/HANDOFF.md).

```
npm install
npm test                       # unit tests; plus integration tests if ./.samples has .psarc files
node tools/verify.js a.psarc   # bar completeness, every note present, onset error vs Rocksmith times
node tools/sweep.js folder     # the same checks on every .psarc in a folder, converted in memory
node tools/snapshot.js a.json folder   # fingerprint the output; --compare a.json b.json after a change
node tools/compare-tonelib.js a.psarc a.song   # notation vs a ToneLib export of the same chart
node tools/inspect.js a.psarc  # what's inside
node tools/tex.js a.psarc out.atex   # the generated alphaTex
node tools/wem2ogg.js a.psarc out.ogg
node tools/roundtrip.js out.gp # re-open a .gp and report tracks, bars, sync points, audio
node tools/render-check.cjs out.gp --png shots/   # render every track in headless Chromium (needs Playwright)
npm run web                    # serve the project at http://localhost:8765/ (web app at /web/)
npm run build:web              # static site in dist/site
```

Charts are copyrighted, so none are in the repo. For the integration tests, put `.psarc` files (and
optionally ToneLib `.song` exports with the same base name) in `.samples/`, or set `PSARC2GP_SAMPLES`.

```
bin/psarc2gp.js          command line
src/convert.js           psarc → .gp (runs in Node and in browsers)
src/rocksmith/           PSARC archive, SNG arrangements, song loader
src/audio/               Wwise → Ogg (ww2ogg port), Ogg page writer, packed codebooks
src/notation/            timeline (bars, meters, sync), arrangement (quantizing, techniques), score
src/gp/                  RSE sounds patched into the .gp, minimal zip rewrite
src/lib/                 byte helpers, AES (CTR, CFB) and inflate in plain JavaScript
web/                     the web app: page, conversion worker, library (IndexedDB), player
windows/                 Send To installer (the entries start node.exe directly)
windows/preview/         Explorer preview pane add-in (C#, WebView2) and the page it shows (web/)
tools/                   verification and debugging helpers
```

## Credits and licenses

- [ww2ogg](https://github.com/hcs64/ww2ogg) by Adam Gashlin (BSD): `src/audio/ww2ogg.js` is a port, and
  `packed_codebooks_aoTuV_603.bin` comes from it. See `src/audio/LICENSE-ww2ogg.txt`.
- [alphaTab](https://github.com/CoderLine/alphaTab) (MPL-2.0) builds and writes the Guitar Pro file.
- The archive keys are the public Rocksmith 2014 keys used by the community CDLC tools.
- The web app and the Explorer preview play with alphaTab's player and its Sonivox sound font
  (Apache-2.0), and draw with the Bravura music font (SIL OFL); `npm run build:web` includes their
  licence files.
- The Explorer preview uses Microsoft Edge WebView2 (its SDK is restored from NuGet when the add-in is
  built) and shows the score with alphaTab.

Convert only custom songs you have the right to use.
