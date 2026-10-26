# psarc2gp: notes for Claude Code

Converts Rocksmith 2014 CDLC (`.psarc`) into Guitar Pro 8 files with the original recording embedded
and a sync point on every beat. The user runs it from Windows Explorer's **Send to** menu and practices
and edits in Guitar Pro 8.

Read before changing behaviour:
- `docs/PRODUCT.md`: what it's for, requirements, decisions and why
- `docs/HANDOFF.md`: current state, evidence, what's unverified, how to tell a change is good, next steps
- `README.md`: user-facing usage and the notation choices

## Commands

```
npm install
npm test                                   # unit tests; integration tests run if .samples/ has charts
node bin/psarc2gp.js [-f] [-o dir] <file.psarc | folder> ...
node tools/verify.js .samples/*.psarc      # bars complete, notes present, onset error vs chart
node tools/compare-tonelib.js X.psarc X.song
node tools/roundtrip.js out/*.gp           # re-open .gp files and report what Guitar Pro will see
node tools/inspect.js | tex.js | wem2ogg.js   # look inside a .psarc / dump alphaTex / extract audio
```

## Layout

```
bin/psarc2gp.js     CLI (also what the Windows Send To entries call)
src/convert.js      .psarc → .gp
src/rocksmith/      PSARC archive, SNG arrangement parser, song loader
src/audio/          Wwise → Ogg (ww2ogg port), Ogg page writer, packed codebooks (BSD, keep the license file)
src/notation/       timeline (bars, meters, count-in, sync points), arrangement (grid choice, durations,
                    techniques), score (assembles alphaTex)
src/gp/             post-processing of alphaTab's .gp: RSE sounds per track (rse.js), zip rewrite (zip.js)
windows/            Send To installer and wrappers (CRLF line endings, see .gitattributes)
tools/              verification and debugging helpers; tools/tonelib.js reads ToneLib .song as a test oracle
test/               node:test; samples.test.js uses real charts from .samples/
```

## Ground rules

- **Sync accuracy comes first.** Every chart beat gets a sync point. Don't trade that for notation
  convenience. Measure with `tools/verify.js`.
- **Never overwrite** an existing `.gp` by default; users edit those files in Guitar Pro.
- **No copyrighted material in git**: charts, audio, converted `.gp` files. Samples live in `.samples/`.
- One runtime (Node ≥ 20), one pinned dependency (alphaTab), no native tools. This keeps installation
  trivial and a future browser version possible.
- Notation should give the best practice experience, not mimic ToneLib; when you deviate from ToneLib,
  record why (README "Notation choices").
- Visual changes need a visual check (render the `.gp`, or ask the user to open it in Guitar Pro).

## Facts that are easy to get wrong

- String numbering differs everywhere: Rocksmith 0 = lowest string; alphaTex 1 = highest;
  alphaTab's model 1 = lowest.
- SNG structures are packed little-endian. Size them as packed, not native-aligned (an alignment bug once
  broke 6 of 11 arrangements while the first test song parsed fine).
- A cent offset of −1200 means an extended-range chart (e.g. B-E-A-D bass, a 6-string bass in a guitar
  slot): real pitch is an octave below the offsets.
- Time-signature denominators come from `TS:n/d` chart events; the beat grid only gives beat counts.
- Modern Wwise audio has no per-packet granule positions. The ww2ogg port computes them (normally a separate
  "revorb" step); without them, seeking and duration break.
- Guitar Pro stores sync-point frame offsets at 44.1 kHz regardless of the audio's sample rate (alphaTab
  handles this).
- `\displaytranspose 12` (positive) writes guitar/bass an octave above sounding pitch, the standard
  convention. Bass tracks also need `\clef bass`.
- alphaTab treats a tuplet group as complete only with equal-length values (or a power-of-two total);
  mixed triplet values crashed its renderer, hence one value per triplet beat.
- alphaTab writes every track for Guitar Pro's **MIDI** engine. In Guitar Pro that plays through the system
  MIDI synth and lags the audio track; **RSE** (Guitar Pro's sampled engine) stays in time with it (the user
  confirmed by ear). So `src/gp/rse.js` rewrites each track's sound in `score.gpif` after export, using sound
  definitions copied from Guitar Pro 8 files. It throws if alphaTab's XML changes shape; re-check it when
  upgrading alphaTab. Instrument tracks are written muted (`playbackInfo.isMute`); the audio track is not.
- Bar-length checks must sum `beat.displayDuration` (grace notes count 0); `playbackDuration` lends
  time to grace notes from neighbouring beats.
- ToneLib re-bars count-ins, so its bar numbers are offset from ours by a constant; the comparison
  tool detects the offset.
