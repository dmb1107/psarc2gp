# Handoff: state of the project (2026-10-25)

Written at the end of the first build session and updated at the end of the second, the first on the
user's Windows PC, for whoever picks up the work next. Product intent and decisions are in
[PRODUCT.md](PRODUCT.md). How to do the next things is up to you.

## Where things stand

The full pipeline works end to end: `.psarc` → Guitar Pro 8 `.gp` with notation, embedded audio and
per-beat sync. It is installed on the user's Windows PC at `C:\Tools\psarc2gp` with working Send To
entries, and converts all 206 charts in their library (below). The user has bought Guitar Pro 8 and
confirmed an earlier test file plays in sync there.

History (see `git log`):
1. PSARC/SNG reader and Wwise → Ogg converter (ww2ogg port)
2. Notation converter, `.gp` output with per-beat sync, CLI, Windows Send To, tests
3. Notation fixes from comparisons against ToneLib on four charts
4. RSE sounds and muted instrument tracks by default (fixes the synth lagging the recording)
5. Windows: Send To entries start node.exe directly; song names no longer lost when the vocals manifest
   comes first; `tools/sweep.js` (branch `windows-sendto-node`)

## Evidence

| Song (sample) | Arrangements | Notes | 95th-pct onset error | ToneLib onset agreement |
|---|---|---|---|---|
| SAULT – Wildfires | Bass, Bass 2 | 1,180 | 0.5 ms | 100 % |
| Bruno Mars/Anderson .Paak – Skate | Lead, Rhythm, Bass | 3,159 | ≤ 0.5 ms | 100 % |
| Car Seat Headrest – Destroyed by Hippie Powers | Lead, Rhythm, Bass | 7,195 | ≤ 1 ms | 99.9–100 % |
| Masayoshi Takanaka – Oh! Tengo Suerte | Bass (odd meters, fast runs) | 721 | 0.8 ms | 96 % |
| Thundercat – No More Lies | Bass (E♭) | 613 | 0.5 ms | no .song yet |
| Thundercat – Them Changes | Bass, Bass 2 (B-E-A-D), 6-string bass | 2,177 | 0.5 ms | no .song yet |
| Olivia Rodrigo – brutal (vocals manifest first) | Lead, Rhythm, Bass | 2,362 | 0.5 ms | no .song |

Also checked: every bar complete in every track; every chart note present; each `.gp` re-opens with
its audio and all sync points; every track renders in alphaTab without errors; the converted audio
matches ToneLib's decode; Ogg output passes ffmpeg's strict CRC check and reports the exact sample count.
The ToneLib differences that remain are deliberate or judgment calls (PRODUCT.md, decision 6).

## Windows: verified on the user's PC (2026-10-25)

Windows 11 Pro (build 26200), Node.js 24.22.1 and Git 2.56 (installed with winget). On this PC
`.samples/` holds Skate, Destroyed by Hippie Powers, Oh! Tengo Suerte and brutal: `npm test` passes
40/40 and `tools/verify.js` gives the numbers above.

- `windows\install.cmd` installs the dependency and creates the two Send To shortcuts. They now start
  `node.exe bin\psarc2gp.js --pause [--force]` directly and carry Guitar Pro's icon.
- Real Explorer drops, made through the shell's `IDropTarget` on the installed shortcuts (what the
  Send To menu calls), with real charts: a folder of two songs, a single song, the same song again
  (skipped, `.gp` untouched), the overwrite entry (replaced), and a corrupt file (the window stays open
  until a key is pressed; otherwise it closes 10 s after finishing). The `.gp` files re-open with all
  tracks, sync points and audio.
- **Why no `.cmd` wrapper any more.** Explorer quotes a dropped path only if it contains a space, so
  through `cmd.exe /c wrapper.cmd %*`:

  | Dropped | Through the old `.cmd` | Starting node.exe directly |
  |---|---|---|
  | `Simon&Garfunkel_p.psarc` | cut at `&`; cmd runs the rest as a command | intact |
  | `a^b_p.psarc` | `^` removed | intact |
  | 101 files (11,500 characters) | nothing runs: "The command line is too long" (8191 limit) | all 101 |
  | 280 files (31,900 characters) | nothing runs | all 280 |
  | 340 files (38,800 characters) | nothing runs | nothing runs (Windows' 32,767 limit) |
  | `100%PATH%_p.psarc` | `%PATH%` expanded | `%PATH%` expanded: Explorer does this itself |

  None of the user's 206 file names contains these characters, but selecting all 101 charts in their
  backup folder would have failed.
- Not verified: the right-click menu itself, clicked by hand (the drop handler behind it was); and
  double-clicking `install.cmd` from a zip that Explorer extracted (the files then carry the internet
  zone mark, so Windows may ask before running it).

## Library sweep (2026-10-25)

`node tools/sweep.js <folders>` converts every chart in memory and runs the verify.js checks. On the
user's library (`Downloads` and `Documents\backup_music_stuff\Rocksmith_Custom_DLC`, 206 files,
484 arrangements, 453,000 notes):

- All 206 convert, about 2 s each. No incomplete bars, no missing notes.
- 11 (5 %) had lost their artist and title: the vocals manifest came first in the archive and has
  neither, so every one of them would have been written as `Unknown - Untitled.gp` and all but the first
  skipped. Fixed (metadata now comes from the instrument manifests); the samples test checks it.
- Onset error, worst track per song: p95 ≤ 1 ms for 153 songs, 1–10 ms for 22, over 10 ms for 31
  (15 %). The last group are charts whose notes aren't on their own beat grid: notes sit 15–30 ms off the
  nearest 16th (e.g. Sweet Child O' Mine lead, median −20 ms; most Tame Impala and Sticky Fingers charts),
  so the best grid still leaves that much error. Sync points (the recording) are unaffected; it shows as
  synth timing and as finer note values in the score. Two bass tracks stand out: J. Cole – Crooked Smile
  (one note 185 ms off, p95 0.8 ms) and Kendrick Lamar – Bitch, Don't Kill My Vibe (p95 56 ms).
- STRFKR – Rawnald Gregory Erickson II has a ToneLib export (`Documents\backup_music_stuff\Tonelib`).
  It is one of the loose charts (p95 19–28 ms), and its bass was charted on a different tempo map: its
  beats drift up to 300 ms from the guitars' (the converter warns and writes all tracks on the first
  track's grid; bass notes still land within 28 ms of their chart times). ToneLib's onsets agree 46 %
  (Lead), 21 % (Rhythm), 2 % (Bass), so it's kept out of `.samples` (it would fail the thresholds).
  ToneLib gives that bass 5 strings; `compare-tonelib.js` now names strings by their open pitch.

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

- **The Send To menu clicked by hand** (everything behind it is verified, see above).
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

On the user's PC the library is in `%USERPROFILE%\Downloads` and
`%USERPROFILE%\Documents\backup_music_stuff\Rocksmith_Custom_DLC`; ToneLib exports are in
`...\backup_music_stuff\Tonelib`.

## How to tell a change is good

1. `npm test` passes with all samples present.
2. `node tools/verify.js .samples/*.psarc`: no incomplete bars, nothing "not found", p95 onset error
   still about 1 ms.
3. `node tools/compare-tonelib.js X.psarc X.song` for songs with `.song` files: investigate any drop in
   onset agreement. Differences can be fine if they make the notation better; say why.
4. For anything visible (notation, layout), **look at it**. `node tools/render-check.cjs out/*.gp --png
   shots/` renders every track with alphaTab in headless Chromium and saves page images (Playwright is
   not a project dependency; the tool says how to install it), or have the user open it in Guitar Pro.
   Several real problems this session were only visible that way (wrong clef/octave, tempo-mark
   clutter, a renderer crash on mixed tuplets).
5. Re-convert the samples and re-open them (`tools/roundtrip.js`).
6. For changes to parsing or notation, `node tools/sweep.js <library folders>` before and after: no new
   failures, nothing incomplete or missing, the p95 distribution no worse.

## Suggested next steps

In rough priority order; these are outcomes, not implementation plans.

1. **Finish proving the Windows experience in Guitar Pro 8** (the user): right-click → Send to on a few
   songs, open the results, confirm sync, RSE sounds, muted instrument tracks, audio-track mute/solo,
   speed change, looping, and the low B of Them Changes. Fix whatever breaks.
2. **Review notation with the user** in Guitar Pro on a few songs and tune the notation choices to their
   taste (e.g. chord lengths when the chart gives none, grace notes, triplets).
3. **Loosely charted songs** (15 % of the user's library, see "Library sweep"): decide how to write
   notes that sit 15–30 ms off the grid (fine 32nd/64th offsets vs. the readable beat position), and
   look at the two outlier bass tracks. Measure with `tools/sweep.js`.
4. **Broaden the test corpus**: a guitar chart with heavy bends, a slap-bass chart, a capo chart, a Mac
   `_m.psarc`, a chart with tremolo picking. Add the `.song` exports where possible.
5. **Lyrics / vocal melody track.**
6. Remaining techniques: strum direction, let-ring, fingering.
7. Later: standalone executable; dark practice view; web version (see PRODUCT.md "Later").

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
