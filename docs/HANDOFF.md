# Handoff: state of the project (2026-10-25)

Written at the end of the first build session, for whoever picks up the work next. Product intent
and decisions are in [PRODUCT.md](PRODUCT.md). How to do the next things is up to you.

## Where things stand

The full pipeline works end to end: `.psarc` → Guitar Pro 8 `.gp` with notation, embedded audio and
per-beat sync. It has been run on six real charts (13 arrangements) and checked several ways
(below). The user has bought Guitar Pro 8 and confirmed an earlier test file plays in sync there.

History (see `git log`):
1. PSARC/SNG reader and Wwise → Ogg converter (ww2ogg port)
2. Notation converter, `.gp` output with per-beat sync, CLI, Windows Send To, tests
3. Notation fixes from comparisons against ToneLib on four charts
4. RSE sounds and muted instrument tracks by default (fixes the synth lagging the recording)

## Evidence

| Song (sample) | Arrangements | Notes | 95th-pct onset error | ToneLib onset agreement |
|---|---|---|---|---|
| SAULT – Wildfires | Bass, Bass 2 | 1,180 | 0.5 ms | 100 % |
| Bruno Mars/Anderson .Paak – Skate | Lead, Rhythm, Bass | 3,159 | ≤ 0.5 ms | 100 % |
| Car Seat Headrest – Destroyed by Hippie Powers | Lead, Rhythm, Bass | 7,195 | ≤ 1 ms | 99.9–100 % |
| Masayoshi Takanaka – Oh! Tengo Suerte | Bass (odd meters, fast runs) | 721 | 0.8 ms | 96 % |
| Thundercat – No More Lies | Bass (E♭) | 613 | 0.5 ms | no .song yet |
| Thundercat – Them Changes | Bass, Bass 2 (B-E-A-D), 6-string bass | 2,177 | 0.5 ms | no .song yet |

Also checked: every bar complete in every track; every chart note present; each `.gp` re-opens with
its audio and all sync points; every track renders in alphaTab without errors; the converted audio
matches ToneLib's decode; Ogg output passes ffmpeg's strict CRC check and reports the exact sample count.
The ToneLib differences that remain are deliberate or judgment calls (PRODUCT.md, decision 6).

## Resolved: synth lagged the recording in Guitar Pro

The user heard the synth bass late against the recording in *Destroyed by Hippie Powers*, bar 56 (the
`9 9` notes). Investigated and fixed:

- **Chart vs recording:** fine. Measured from the bass's own pitch (energy at the note's harmonics),
  the recorded F♯ notes in bars 56–57 start within −15…+17 ms of the chart times. Across the song the
  chart sits within a few ms of the recording (one section around 4:10–4:25 measured ~+37 ms, but that
  measurement is noisy).
- **Converter vs chart:** fine. Notes in bar 56 are written exactly on their 8th-note positions, and
  the sync points carry the exact beat times (frame offsets) and matching tempos.
- **Cause:** alphaTab writes every track with `<AudioEngineState>MIDI</AudioEngineState>`, so Guitar Pro
  played the synth through the system **MIDI output** (on Windows usually the Microsoft GS Wavetable
  Synth, which adds its own latency) instead of its built-in **RSE** engine, which renders alongside the
  audio track. The user switched the track to an RSE sound and the lag was gone; switching back to MIDI
  brought it back.
- **Fix:** converted tracks now get RSE sounds (`src/gp/rse.js`: bass → "Electric Bass (finger)",
  guitars → clean / overdriven / distortion / acoustic from the chart's Rocksmith tone descriptors) and
  start muted, so the recording plays alone until the user unmutes a part. The sound definitions are
  copied from Guitar Pro 8.1 files and the patched track XML has the same elements, in the same order, as
  Guitar Pro writes. `--midi` and `--no-mute` restore the old behaviour.
- **Still to confirm in Guitar Pro 8:** that a freshly converted file opens with RSE sounds on every
  track, plays them in time, and shows the instrument tracks muted. Also whether the RSE bass covers the
  low B of 5/6-string bass parts (*Them Changes*).

A reference clip (recording plus a zero-latency synth at the chart's note times) was made for the
user to rule out the chart by ear; rendering such clips would make a useful verification tool.

## Not yet verified

- **Windows install and Send To.** `windows/*.cmd` and `install-sendto.ps1` were written without a
  Windows machine. This is the user's primary way of using the tool, so it's the first thing to check.
- **Guitar Pro 8 with the latest files.** The user opened earlier builds in GP8; the current output
  (RSE sounds, muted tracks) has only been checked by re-opening with alphaTab and comparing the XML with
  Guitar Pro's own files.
- Mac `_m.psarc` files, capo charts, and slap/pop, tremolo picking, pinch harmonics in a real chart
  (none of the samples use them).
- Notation of *No More Lies* and *Them Changes* against ToneLib (the user may send the `.song` files).

## Test data

Charts are copyrighted and must never be committed. The user has the files. Put them in `.samples/`
(gitignored) or point `PSARC2GP_SAMPLES` at a folder:

- `Name_p.psarc`: the CDLC as downloaded
- `Name_p.song`: optional ToneLib export of the same chart, **same base name**; enables the ToneLib
  comparison test

With samples present, `npm test` runs the integration tests on every song; without them they skip.

## How to tell a change is good

1. `npm test` passes with all samples present.
2. `node tools/verify.js .samples/*.psarc`: no incomplete bars, nothing "not found", p95 onset error
   still about 1 ms.
3. `node tools/compare-tonelib.js X.psarc X.song` for songs with `.song` files: investigate any drop in
   onset agreement. Differences can be fine if they make the notation better; say why.
4. For anything visible (notation, layout), **look at it**. Render the `.gp` (e.g. alphaTab in a
   headless browser) or have the user open it in Guitar Pro. Several real problems this session were
   only visible that way (wrong clef/octave, tempo-mark clutter, a renderer crash on mixed tuplets).
5. Re-convert the samples and re-open them (`tools/roundtrip.js`).

## Suggested next steps

In rough priority order; these are outcomes, not implementation plans.

1. **Prove the Windows experience**: install from a fresh copy on Windows, Send To on one file, several
   files, and a folder; open the results in Guitar Pro 8; confirm sync, RSE sounds, muted instrument
   tracks, audio-track mute/solo, speed change, looping. Fix whatever breaks.
2. **Review notation with the user** in Guitar Pro on a few songs and tune the notation choices to their
   taste (e.g. chord lengths when the chart gives none, grace notes, triplets).
3. **Broaden the test corpus**: a guitar chart with heavy bends, a slap-bass chart, a capo chart, a Mac
   `_m.psarc`, a chart with tremolo picking. Add the `.song` exports where possible.
4. **Lyrics / vocal melody track.**
5. Remaining techniques: strum direction, let-ring, fingering.
6. Later: standalone executable; dark practice view; web version (see PRODUCT.md "Later").

## Known quirks

- Sections come from the first arrangement; parts occasionally place them a beat apart.
- A 6-string bass charted in a guitar slot keeps Rocksmith's name ("Rhythm (bonus)") but gets a bass
  sound and bass clef.
- Tempo marks show the first tempo and changes over 8 %; smaller bar-to-bar drift is hidden (playback
  timing comes from the sync points anyway).
- Count-in bars are added only when the chart starts at least about a second (and half a bar) into the
  recording; shorter lead-ins are trimmed by Guitar Pro's audio padding.
- The last note of a song with no charted length stops at the end of its bar (ToneLib holds it longer).

## Glossary

- **CDLC**: custom (fan-made) Rocksmith songs, usually from CustomsForge.
- **PSARC**: the Rocksmith archive. Holds encrypted arrangements (`.sng`), audio (`.wem`), manifests,
  art.
- **Arrangement**: one instrument part (Lead, Rhythm, Bass, alternates, bonus). Rocksmith stores each
  phrase at many difficulty levels; the converter uses each phrase's hardest level (the full chart).
- **Beat grid / ebeats**: one timestamp per beat, with downbeats marked. This is what the sync points are
  built from.
- **Sync point**: Guitar Pro's link between a position in the score and a time in the audio track.
- **RSE**: Guitar Pro's Realistic Sound Engine, its built-in sampled instruments. Plays in time with the
  audio track; a track set to MIDI plays through the system synth and lags.
- **ToneLib Jam / `.song`**: the user's previous player; its `.song` export is a zip with a score XML
  and Ogg audio, used here only as a reference.
- **alphaTab / alphaTex**: the open-source notation library that writes the `.gp` file, and its text
  input format, which the converter generates.
