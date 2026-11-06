# psarc2gp: notes for Claude Code

Converts Rocksmith 2014 CDLC (`.psarc`) into Guitar Pro 8 files with the original recording embedded
and a sync point on every beat; and Songsterr songs (handed over by a bookmarklet, or saved as `.json`)
into the same kind of file with the video's audio and a sync point on every played bar. The user runs it from Windows Explorer's **Send to** menu and practices
and edits in Guitar Pro 8. The web app (`web/`) runs the same converter in a browser, with a library kept in
the browser and a practice player; the user shares it with a couple of friends.

Read before changing behaviour:
- `docs/PRODUCT.md`: what it's for, requirements, decisions and why
- `docs/HANDOFF.md`: current state, evidence, what's unverified, how to tell a change is good, next steps
- `docs/SONGSTERR.md`: the Songsterr input: findings about Songsterr's data, design, what was measured
- `README.md`: user-facing usage and the notation choices

## Commands

```
npm install
npm test                                   # unit tests; integration tests run if .samples/ has charts
node bin/psarc2gp.js [-f] [-o dir] <file.psarc | folder> ...
node tools/verify.js .samples/*.psarc      # bars complete, notes present, onset error vs chart
node tools/sweep.js <folder> ...           # verify.js on a whole library, converted in memory
node tools/verify-songsterr.js bundle.json ... [--all-videos]  # Songsterr: notes, bars, sync layout, video tempo
node tools/snapshot.js a.json <folder> ... # fingerprint the output; --compare a.json b.json after a change
node bin/psarc2gp.js song.json [--audio a.mp3]   # Songsterr bundle; no --audio fetches it (shared key's password)
node tools/encrypt-secrets.js              # write web/songsterr-secrets.json (audio keys, one password)
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
src/songsterr/      Songsterr song → .gp: bundle.js (format, validation, CDN, names), score.js (tab JSON →
                    alphaTex), sync.js (points → played bars, video choice), convert.js, secrets.js
                    (encrypted key file), audio/ (providers in config.js order, errors, MP3/M4A duration)
src/gp/             post-processing of alphaTab's .gp: RSE sounds per track (rse.js), sync points in GP8's
                    played-bar layout (syncpoints.js), zip rewrite (zip.js)
src/lib/            Uint8Array helpers, AES-256 CTR/CFB and inflate in plain JS (tested against node:crypto/zlib)
web/                the web app: index.html + app.js (library view, conversion queue, routing),
                    convert-worker.js (src/convert.js and src/songsterr/ in a module worker), library.js
                    (IndexedDB), player.js (alphaTab player: tracks, recording/synth, speed, loop),
                    songsterr.js (setup page's shared key and bookmarklet, invite link; Songsterr song form), songsterr-bookmarklet.js
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
  convenience. Measure with `tools/verify.js`. For Songsterr: every played bar gets a sync point from the
  chosen video's own points (Songsterr times bars, not beats), never stretched to fit; a video whose
  count doesn't fit isn't used (the two exceptions the user chose, one stray point and empty bars at the
  end, leave a point or rests out; they never stretch: SONGSTERR.md finding 3). Rest bars after the tab,
  timed at the closing tempo, carry a recording that outlasts the tab to its end (PRODUCT.md 24). Measure with `tools/verify-songsterr.js`.
- **Never call Songsterr's API ourselves** or work around its bot filter. Its data comes from the
  bookmarklet in the user's browser (page state, browser cache) or a saved bundle; its CDN is fine.
- **Don't break psarc.** Songsterr code lives in `src/songsterr/`; `src/convert.js` and `src/notation/`
  don't change for it. After a change: `tools/snapshot.js --compare` against a baseline, every song
  identical (docs/SONGSTERR.md, "Don't break psarc").
- **Never overwrite** an existing `.gp` by default; users edit those files in Guitar Pro.
- **No copyrighted material in git**: charts, Songsterr tabs and bundles, audio, converted `.gp` files.
  Samples live in `.samples/` (saved Songsterr songs in `.samples/songsterr/`).
- **Secrets only encrypted**: the shared audio key is committed only inside `web/songsterr-secrets.json`
  (written by `tools/encrypt-secrets.js`); never in plain text, a log, a test or a build secret.
- **The repo is public** (GitHub Pages). Keep the user's email, Windows user name and personal folder paths
  out of tracked files and commit metadata; write `%USERPROFILE%\...` or a placeholder.
- The converter: one runtime (Node ≥ 20), one pinned dependency (alphaTab), no native tools, and the same
  code runs in browsers (the web app). Keep `src/` platform-neutral: Uint8Array/DataView, not Buffer; no
  `node:` imports (the one exception, ww2ogg's codebook load, picks fs or fetch by URL scheme).
- The web app never uploads anything: conversion runs in the page, songs live in the browser's IndexedDB.
  The one outgoing request with user intent is a YouTube video ID to the audio provider (and the
  provider's download), for Songsterr songs only; never a chart, tab or account data.
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
- Guitar Pro numbers a sync point's `<Bar>` by **played** bar (repeats expanded) and stores the points in
  play order; `<Value><BarIndex>` is the written bar. alphaTab writes the written bar in both, which GP8
  misreads when a repeat starts at bar 1 (the whole recording lands in the first bars). Songsterr output is
  rewritten by `src/gp/syncpoints.js`; re-check it when upgrading alphaTab. psarc output has no repeats.
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

Songsterr:
- Songsterr string 0 is the **highest** string (alphaTex string = Songsterr + 1); tunings are listed high
  to low as MIDI numbers. Durations are rationals; `type`/`dots`/`tuplet` are the written value.
- Video points are bar start times per **played** bar (repeats expanded, alternate endings on their pass),
  with no end point for the last bar. Map them in alphaTab's own play order (`playedBars` in sync.js reads
  its MIDI generator), not an order of our own.
- Many listed videos were timed for older revisions and don't fit (wrong count); not even the default
  always fits. A video whose points go backwards (a typo on Songsterr: s421905's 2VCQhkaRRNY has 130.98 s
  between 65.34 and 69.78) doesn't fit and is never repaired (`backwardsAt` in sync.js); the song's
  other videos still are (bundle validation once refused the whole song). A negative first point means the video starts after the tab (positive FramePadding).
- The page state (`<script id="state">`) also holds the signed-in visitor's account: the bookmarklet copies
  song fields only.
- Changing the secrets password revokes nothing (old versions of the file stay in git history with the
  old password): revoke by rotating the key at the provider.
- Output is `Artist - Title.gp`, the same name as the psarc version of the song (the user's choice; it was
  `… (Songsterr).gp`). Library keys are file names, so the two versions meet as "Already in your library"
  and Replace overwrites the other one; the CLI skips an existing file.
- A drum note's `fret` is a Guitar Pro percussion articulation id (mostly the GM drum number; 91–98 are
  GP's extras, e.g. 92 half-open hi-hat), `string` only its staff place. alphaTex names articulations
  (`\articulation (p42 42)`, then `p42.8`); names like `a36` or `d38` parse as pitches. alphaTab gives a
  percussion staff a treble clef unless told `\clef neutral`. `DRUM_ARTICULATIONS` in score.js is
  alphaTab 1.8.4's id list (not exported; a test reads it from alphaTab's error text): re-check on upgrade.
- Vocal lyrics (`newLyrics`) are Guitar Pro's format. Songsterr places syllables on the first voice's notes
  skipping rests and tied notes, and two spaces leave a note empty (that empty one may land on a tie);
  alphaTab's `applyLyrics` doesn't skip ties, so score.js places them and writes them per beat. Checked
  against Songsterr's page (SONGSTERR.md step 7). Vocal tracks are always muted (the user's choice).
- An unknown bar field stops the conversion (it might change the play order, e.g. a D.S. or coda, none
  seen yet): add it to SONGSTERR.md finding 8 and map it, don't skip it.
- Two audio providers, in config.js order: the backup (youtube-mp36) runs when the first fails with
  anything but auth (it has its own allowance), and is skipped while the key file has no key for it. Its
  secret is `<key>:<md5 of the RapidAPI username>` (its MP3 links 404 without the X-RUN header). The first
  provider's MP3s have no gapless header, so their 13 ms encoder delay plays; the backup's have one, so 0:
  `offsets` in `src/songsterr/audio/config.js`. A backup must let pages read the MP3 itself (CORS), not
  just its JSON: test a real download in a browser before trusting one. The points' own lag varies per video by more than that.

Web app and browser port:
- The web app is branded **tab2gp** (the user's choice); the CLI, the repo/Pages URL and the Windows
  integration stay psarc2gp. Internal names keep `psarc2gp` on purpose: the IndexedDB name and
  localStorage keys (renaming them empties users' libraries and settings), the bookmarklet's message
  types (bookmarklets already in users' bookmarks would stop working), the bundle and
  secrets `kind`s (saved files would stop opening).
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
- The Songsterr bookmarklet and the app talk by hello/ready/received messages (the app answers whoever said
  hello, from https://www.songsterr.com only), not through `window.opener`. Claude's browser pane opens
  `window.open` in the same tab, so the cross-tab handoff can only be tried in a real browser; on the real
  Songsterr page, stub `window.open` with a same-origin iframe's window to check what it would send.
- One tab for many songs, the one in front (the user's choice): every bookmark click opens a new tab
  (`_blank`), which the browser shows. A page can't bring another tab to the front, so instead the new
  tab, once its song arrives, posts `takeover` on the `psarc2gp-tabs` BroadcastChannel; every older tab
  hands it its waiting songs (with their inspection) and its conversion queue, then closes itself
  (window.close works for tabs a script opened; one the user opened stays, emptied). A song being
  converted finishes in the old tab (its audio may already be fetched) and its result follows as
  `finished`, matched by ref. A tab in the player hands over but stays open. Tried with two tabs in
  Claude's browser pane (the old one closed); the click from Songsterr itself only in a real browser.
- `#unlock=<password>` (invite link) must be handled on hashchange too: pasted into an open app tab it's a
  fragment change, not a load. web/songsterr.js imports nothing that touches the page at load, so Node
  tests can import `buildBookmarklet`.
- GitHub Pages serves the site from a subfolder (`/<repo>/`) and is case-sensitive: every URL in web/
  must be relative and match the file name exactly (Windows hides case mistakes). The "site" launch
  config serves `dist/`, so the built site runs at `/site/`, a subfolder like on Pages.
- The setup page's foot shows the build (`Build <run> · <commit> · <date>`, written into the HTML by
  tools/build-web.js): what a visitor's tab is really running. Pages caches for 10 minutes, and a tab
  opened just after a deploy can still run the old scripts (one did, 2026-11-05).
- A Pages deployment is keyed by its commit. Once one is cancelled (it once hung at `updating_pages`),
  every later deploy of that commit fails at once with "Deployment cancelled": push a new commit instead
  of re-running the workflow.

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
