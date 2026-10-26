# psarc2gp

Converts Rocksmith 2014 custom songs (CDLC `.psarc`) into Guitar Pro 8 files (`.gp`) with the original
recording embedded as the audio track and **a sync point on every beat**, so the score scrolls, the cursor
highlights notes in time with the recording, and you can pause, jump back, loop, or switch to the
synthesized instrument without drifting.

- Notation (standard + tab) for every arrangement in the file: lead, rhythm, bass, alternates, bonus parts
- Audio decoded from Rocksmith's Wwise format to Ogg Vorbis (built-in port of ww2ogg, no extra tools)
- Every Rocksmith beat is pinned to its exact time in the recording; nothing to line up by hand
- Runs offline in about 1–3 seconds per song

## Install (Windows)

1. Install [Node.js](https://nodejs.org) 20 or newer (the LTS installer is fine).
2. Put this folder somewhere permanent, e.g. `C:\Tools\psarc2gp`.
3. Double-click `windows\install.cmd`. It installs the one dependency and adds two entries to the
   **Send to** menu. `windows\uninstall.cmd` removes them.

## Use

Select one or more `.psarc` files (or a folder of them), right-click, **Send to → Guitar Pro (synced)**.
On Windows 11 the Send to menu is under **Show more options** (or press Shift+F10).

`Artist - Title.gp` is written next to each `.psarc`. If that file already exists it is left alone, so
edits you made in Guitar Pro are never overwritten; use **Guitar Pro (synced, overwrite)** to regenerate.

Command line (any OS):

```
node bin/psarc2gp.js [options] <file.psarc | folder> ...

  -f, --force       overwrite an existing .gp
  -o, --out <dir>   write .gp files into this folder
  -r, --recursive   also look in subfolders
      --no-audio    don't embed the recording
      --atex        also write the intermediate alphaTex (.atex) for debugging
  -q, --quiet       only print errors
```

## In Guitar Pro

- The recording is the **Audio Track**; it has its own volume, mute and solo next to the instrument
  tracks. Mute it and unmute the bass (or any) track to hear the synth instead, or play both.
- Slow down with **relative speed (%)**, not a fixed tempo; Guitar Pro disables the audio track in
  fixed-tempo mode.
- The audio always plays straight through, so don't fold sections into repeat signs.
- The cursor may look a little ahead of the sound. That is the audio output latency of your sound
  device, not the file; the synth and the recording stay together.

## How it works

```
.psarc ─┬─ table of contents (AES-256-CFB) ─ zlib blocks ─ files
        ├─ arrangements (.sng, AES-256-CTR + zlib) ─ beat grid, notes at max difficulty, chords, techniques
        │     └─ notation: bars from the beat grid, each beat snapped to the best grid
        │        (16ths, 8th/16th triplets, 32nds, 64ths), durations from sustains → alphaTex
        ├─ audio (.wem, Wwise Vorbis) ─ ww2ogg port ─ Ogg Vorbis with correct granule positions
        └─ alphaTab: alphaTex + audio + per-beat sync points → Guitar Pro 7/8 file
```

Rocksmith charts store notes as timestamps, not rhythms. Each note is placed on its measure's beat grid
using the finest subdivision that beat needs, so a note's written position maps back to its Rocksmith time.
Across the test songs, half of all notes are within 0.5 ms of the chart and 95 % within 15 ms. Loosely
timed charts reach about 35 ms at worst. Notation agrees with ToneLib's on 100 % of onsets and 99.8 % of
durations for the chart it was checked against.

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

Not converted (yet): lyrics/vocals, fingering, strum direction, let-ring, tone changes. Capo charts
convert but haven't been checked against a real capo chart. Mac (`_m.psarc`) files are supported but
untested.

## Development

```
npm install
npm test                       # unit tests; plus integration tests if ./.samples has .psarc files
node tools/verify.js a.psarc   # bar completeness, every note present, onset error vs Rocksmith times
node tools/compare-tonelib.js a.psarc a.song   # notation vs a ToneLib export of the same chart
node tools/inspect.js a.psarc  # what's inside
node tools/tex.js a.psarc out.atex   # the generated alphaTex
node tools/wem2ogg.js a.psarc out.ogg
node tools/roundtrip.js out.gp # re-open a .gp and report tracks, bars, sync points, audio
```

Charts are copyrighted, so none are in the repo. For the integration tests, put `.psarc` files (and
optionally ToneLib `.song` exports with the same base name) in `.samples/`, or set `PSARC2GP_SAMPLES`.

```
bin/psarc2gp.js          command line
src/convert.js           psarc → .gp
src/rocksmith/           PSARC archive, SNG arrangements, song loader
src/audio/               Wwise → Ogg (ww2ogg port), Ogg page writer, packed codebooks
src/notation/            timeline (bars, meters, sync), arrangement (quantizing, techniques), score
windows/                 Send To installer and wrappers
tools/                   verification and debugging helpers
```

## Credits and licenses

- [ww2ogg](https://github.com/hcs64/ww2ogg) by Adam Gashlin (BSD): `src/audio/ww2ogg.js` is a port, and
  `packed_codebooks_aoTuV_603.bin` comes from it. See `src/audio/LICENSE-ww2ogg.txt`.
- [alphaTab](https://github.com/CoderLine/alphaTab) (MPL-2.0) builds and writes the Guitar Pro file.
- The archive keys are the public Rocksmith 2014 keys used by the community CDLC tools.

Convert only custom songs you have the right to use.
