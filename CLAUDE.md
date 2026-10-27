# psarc2gp: notes for Claude Code

Converts Rocksmith 2014 CDLC (`.psarc`) into Guitar Pro 8 files with the original recording embedded
and a sync point on every beat. The user runs it from Windows Explorer's **Send to** menu and practices
and edits in Guitar Pro 8. The web app (`web/`) runs the same converter in a browser, with a library kept in
the browser and a practice player; the user shares it with a couple of friends.

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
node tools/sweep.js <folder> ...           # verify.js on a whole library, converted in memory
node tools/snapshot.js a.json <folder> ... # fingerprint the output; --compare a.json b.json after a change
node tools/compare-tonelib.js X.psarc X.song
node tools/roundtrip.js out/*.gp           # re-open .gp files and report what Guitar Pro will see
node tools/render-check.cjs out/*.gp [--png dir]   # render every track in headless Chromium (needs Playwright)
node tools/inspect.js | tex.js | wem2ogg.js   # look inside a .psarc / dump alphaTex / extract audio
windows\install-preview.cmd                # build + register the Explorer preview (.NET SDK; admin prompt)
npm run web                                # serve the project at http://localhost:8765/ (web app: /web/)
npm run build:web                          # static site in dist/site (alphaTab paths rewritten to vendor/)
node tools/screenshots.js .samples/*.psarc # retake docs/images (README) in headless Chrome over CDP
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
src/lib/            Uint8Array helpers, AES-256 CTR/CFB and inflate in plain JS (tested against node:crypto/zlib)
web/                the web app: index.html + app.js (library view, conversion queue, routing),
                    convert-worker.js (src/convert.js in a module worker), library.js (IndexedDB),
                    player.js (alphaTab player: tracks, recording/synth, speed, loop)
windows/            Send To installer (CRLF line endings, see .gitattributes; keep the .ps1 ASCII-only,
                    Windows PowerShell 5.1 reads BOM-less files as ANSI)
windows/preview/    Explorer preview pane add-in: C# (.NET Framework 4.8) hosting WebView2, which shows
                    web/index.html; the page reads the .gp and plays it with alphaTab from node_modules
tools/              verification and debugging helpers; tools/tonelib.js reads ToneLib .song as a test oracle
.github/workflows/  pages.yml: on push to main, test, build the web app and publish it on GitHub Pages
test/               node:test; samples.test.js uses real charts from .samples/
```

## Ground rules

- **Sync accuracy comes first.** Every chart beat gets a sync point. Don't trade that for notation
  convenience. Measure with `tools/verify.js`.
- **Never overwrite** an existing `.gp` by default; users edit those files in Guitar Pro.
- **No copyrighted material in git**: charts, audio, converted `.gp` files. Samples live in `.samples/`.
- **The repo is public** (GitHub Pages). Keep the user's email, Windows user name and personal folder paths
  out of tracked files and commit metadata; write `%USERPROFILE%\...` or a placeholder.
- The converter: one runtime (Node ≥ 20), one pinned dependency (alphaTab), no native tools, and the same
  code runs in browsers (the web app). Keep `src/` platform-neutral: Uint8Array/DataView, not Buffer; no
  `node:` imports (the one exception, ww2ogg's codebook load, picks fs or fetch by URL scheme).
- The web app never uploads anything: conversion runs in the page, songs live in the browser's IndexedDB.
  Keep it a static site (no server code), so nobody hosting it ever handles charts or recordings. The optional Explorer preview
  (windows/preview) is the one native part (the user's decision): keep it separate from the converter.
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
- Send To entries must start `node.exe` directly, never through a `.cmd`. Explorer quotes a dropped
  path only if it has a space, so cmd.exe splits names at `&` (and would run the rest as a command), eats
  `^`, and refuses command lines over 8191 characters (about 75 files). A direct start takes ~32,000
  characters. Explorer itself expands `%NAME%` in dropped names; nothing can undo that.
- Song metadata comes from the instrument manifests; vocals manifests have no SongName/ArtistName and
  can come first in the archive.
- Some charts aren't on their own beat grid (notes 15–30 ms off the nearest 16th). verify.js then
  reports p95 onset errors of 10–30 ms; that's the chart, not a regression (see HANDOFF.md).

Web app and browser port:
- Browsers' DecompressionStream rejects bytes after the end of a zlib stream and then drops output it
  already decoded (Chrome lost everything past 128 KiB). SNG payloads have such bytes, hence our own
  inflate (src/lib/inflate.js), which stops at the final block like zlib's Z_SYNC_FLUSH. WebCrypto has no
  AES-CFB (the PSARC table of contents) and is async, hence src/lib/aes.js.
- Only the zip rewrite is async (CompressionStream; "deflate" minus its zlib wrapper = raw deflate), so
  `convertPsarc` and `rewriteZipEntry` return promises; `loadSong` and `wemToOgg` stay synchronous.
- Importing alphaTab.mjs inside a worker turns that worker into an alphaTab render/synth worker (its
  listener then throws on our messages). src/convert.js and web/convert-worker.js import alphaTab.core.mjs.
- Chrome delivers a module worker's messages while its top level is still in a top-level await, before
  `onmessage` is set: they are lost. ww2ogg.js awaits its codebooks, so convert-worker.js imports the
  converter dynamically and sets `onmessage` first (a song added right after the page opened hung at
  "Converting…"; 8 of 8 early messages were lost before the fix).
- README screenshots: `tools/screenshots.js` drives headless Chrome with the DevTools protocol (Node's
  WebSocket, no Playwright). Headless Edge exits at once on the user's PC. The player shot uses a demo
  song written in that file (original music, so no chart's notation is published).
- alphaTab plays the recording (EnabledBackingTrack) or the synthesizer, never both. Switching recreates
  its player: carry tickPosition (not time: the synth ignores sync points and runs at the score's
  tempo), playbackRange and play state across, and restore them on playerReady. Speed and looping survive.
- The synth ignores tracks' saved mute state; psarc2gp files have every instrument muted, and the player
  unmutes/solos per channel itself (changeTrackMute/changeTrackSolo).
- alphaTab measures the container width once; `scrollbar-gutter: stable` on the scroll element keeps
  the score from being laid out 15 px too wide when the scrollbar appears.
- Dragging across the score selects a playback range (enableUserInteraction); a click seeks and clears it.
- The library keeps list fields and the .gp Blob in separate object stores, so marking a song played
  doesn't rewrite the file; updateSong reads and writes in one transaction (two updates at once lost one).
- GitHub Pages serves the site from a subfolder (`/<repo>/`) and is case-sensitive: every URL in web/
  must be relative and match the file name exactly (Windows hides case mistakes). The "site" launch
  config serves `dist/`, so the built site runs at `/site/`, a subfolder like on Pages.

Explorer preview (windows/preview):
- On the user's PC, registry writes to HKCU made from Claude Code's shell are invisible to every other
  process (Explorer, COM): they land in a private view (the session runs under the Claude app's
  package). `Test-Path` and `AssocQueryString` in that shell still see them. Read the real registry
  through WMI (`Invoke-CimMethod -Namespace root/default -ClassName StdRegProv -MethodName EnumKey ...`)
  and have the user run anything that must write HKCU. Files (the Send To shortcuts) are not affected.
  This once looked like "COM ignores new per-user classes until sign-in" (wrong); that is why the
  preview's COM class is in HKLM (the installer elevates itself for that part).
- The preview handler is registered under `HKCU\Software\Classes\.gp\shellex\{8895b1c6-...}`, the
  documented place and the one PowerToys uses for its previewers.
- prevhost calls .NET objects on RPC threads (MTA). WinForms and WebView2 need an STA with a message
  loop: everything window-related runs on `UiThread`.
- WebView2 can't start at low integrity: the class sets `DisableLowILProcessIsolation`. Its loader DLL is
  in bin\runtimes\win-x64\native (`SetLoaderDllFolderPath`); prevhost's folder is System32, so assemblies
  next to ours are resolved by hand.
- prevhost keeps the DLL loaded: stop prevhost.exe before rebuilding (the installer does).
- The add-in reads the .gp itself, without updating its Date accessed (the user sorts songs by it), and
  serves it to the page from memory; the page and alphaTab come from the project folder via a virtual host.
- alphaTab 1.8.4: subscribing to `api.midiLoaded` recurses forever when the synthesizer plays (files
  without a recording). Don't use it.
- Explorer passes white and black through IPreviewHandlerVisuals even in dark mode; Windows' app theme
  (`AppsUseLightTheme`) decides, and dark uses Explorer's own #191919.
- The preview starts playing on its own: the WebView2 environment is created with
  `--autoplay-policy=no-user-gesture-required` (browsers otherwise wait for a click).
- To try the page in a browser, serve the project folder and open
  `/windows/preview/web/index.html?file=/path/to/song.gp`.
