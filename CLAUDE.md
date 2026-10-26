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
node tools/sweep.js <folder> ...           # verify.js on a whole library, converted in memory
node tools/compare-tonelib.js X.psarc X.song
node tools/roundtrip.js out/*.gp           # re-open .gp files and report what Guitar Pro will see
node tools/render-check.cjs out/*.gp [--png dir]   # render every track in headless Chromium (needs Playwright)
node tools/inspect.js | tex.js | wem2ogg.js   # look inside a .psarc / dump alphaTex / extract audio
windows\install-preview.cmd                # build + register the Explorer preview (.NET SDK; admin prompt)
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
windows/            Send To installer (CRLF line endings, see .gitattributes; keep the .ps1 ASCII-only,
                    Windows PowerShell 5.1 reads BOM-less files as ANSI)
windows/preview/    Explorer preview pane add-in: C# (.NET Framework 4.8) hosting WebView2, which shows
                    web/index.html; the page reads the .gp and plays it with alphaTab from node_modules
tools/              verification and debugging helpers; tools/tonelib.js reads ToneLib .song as a test oracle
test/               node:test; samples.test.js uses real charts from .samples/
```

## Ground rules

- **Sync accuracy comes first.** Every chart beat gets a sync point. Don't trade that for notation
  convenience. Measure with `tools/verify.js`.
- **Never overwrite** an existing `.gp` by default; users edit those files in Guitar Pro.
- **No copyrighted material in git**: charts, audio, converted `.gp` files. Samples live in `.samples/`.
- The converter: one runtime (Node ≥ 20), one pinned dependency (alphaTab), no native tools. This keeps
  installation trivial and a future browser version possible. The optional Explorer preview
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
