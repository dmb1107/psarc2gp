# psarc2gp: product notes

What this tool is for, who it serves, what it must do, and why it is built the way it is. This is
the product view; technical design belongs to whoever implements the next changes.

## Problem

The user learns songs (mostly on bass) from Rocksmith custom songs (CDLC, `.psarc`) downloaded from
CustomsForge. The practice workflow that works for them is a **notation + tab view that scrolls and
highlights notes in time with the original recording**, with:

- pause, jump back, and loop, with the recording following the cursor
- switching between the recording and a synthesized instrument (e.g. hear the synth bass) at any time
- standard notation with tab underneath
- fast, reliable editing of the notation (fixing a chart, simplifying a passage)

They did this in ToneLib Jam, which opens `.psarc` directly but is glitchy and slow to edit in. They
are explicitly **not** interested in Rocksmith/Guitar-Hero-style note-highway players.

## Solution

Use **Guitar Pro 8** (which the user has bought) as the player and editor. It already has an audio
track with sync points, notation + tab, mixing, looping, speed control and a good editor. psarc2gp
converts a `.psarc` into a Guitar Pro file that has:

- every arrangement (lead, rhythm, bass, alternates, bonus) as notation + tab
- the original recording embedded as the audio track
- a sync point on every beat of the chart, so the score stays locked to the recording

Primary interaction: right-click `.psarc` file(s) or a folder in Windows Explorer → **Send to →
Guitar Pro (synced)**. A command line exists underneath for everything else.

User environment: Windows PC (Guitar Pro 8, Focusrite Scarlett audio interface on ASIO) is the main
machine; an Apple-silicon Mac is secondary.

## Requirements

Status: ✅ done and verified · ◐ done, not verified on the real target · ☐ not done

### Must

| Requirement | Status |
|---|---|
| Open a Rocksmith 2014 `.psarc` directly, no other tools needed (no ToneLib, no Rocksmith toolkit) | ✅ |
| Embed the full-song recording as the Guitar Pro audio track | ✅ |
| Least possible drift between score and recording: a sync point on every chart beat | ✅ |
| Synth instruments play in time with the recording (Guitar Pro RSE sounds, not MIDI) | ◐ written as RSE; the user confirmed RSE fixes the lag, the new files not yet opened in GP8 |
| Open with only the recording audible; instrument tracks muted until the user unmutes one | ◐ same |
| Notation + tab for every arrangement, readable and editable in Guitar Pro 8 | ✅ (one file confirmed in GP8 by the user; the rest checked by re-opening and rendering) |
| Right-click "Send to" conversion on Windows, single files, multiple files, or folders | ✅ installed and run on the user's PC (Windows 11) through Explorer's drop handler: a file, a folder, 101 files, odd names; the menu click itself not yet done by hand |
| Never overwrite a `.gp` the user may have edited, unless they ask (separate "overwrite" entry) | ✅ |
| Works offline and runs in seconds per song | ✅ (1–3 s) |

### Should

| Requirement | Status |
|---|---|
| Convert the common techniques: slides, hammer-ons/pull-offs, bends, vibrato, mutes, palm mutes, harmonics, accents, tapping, slap/pop, tremolo, chords with names | ✅ (slap/pop, tremolo, pinch harmonics not present in any test chart yet) |
| Real tunings, including drop/E♭ and extended-range charts (B-E-A-D bass, 6-string bass) | ✅ |
| Odd meters, tempo changes, section names | ✅ |
| Keep the intro audio that plays before the chart's first beat | ✅ |
| Mac `_m.psarc` files | ◐ supported, untested |
| Capo charts | ◐ supported, untested |
| Preview a `.gp` in Explorer's preview pane: score, recording playing on its own, cursor following it (the user's request) | ✅ works in Explorer on the user's PC (confirmed by the user; autoplay and dark mode checked in a real Explorer window) |
| Web app to share with a couple of friends: convert `.psarc` in the browser with no upload, a library kept in the browser, a player with track choice, looping, speed and a recording/synth switch (the user's request) | ◐ works in Chromium (the app's browser pane), locally and as the built static site; not yet hosted, not tried in Firefox/Safari, not heard by ear |

### Later (not started; ordering is a suggestion)

- Lyrics / vocal melody track (every test chart has timed, pitched lyrics)
- Strum direction, let-ring, left-hand fingering
- A dark-mode practice view. Guitar Pro desktop has no dark score page, and OS colour inversion hides
  the playback cursor. The web app's player is one now (dark or light, synced, loop and speed), but
  read-only: editing stays in Guitar Pro.
- A standalone Windows executable (no Node.js install)

### Non-goals

- Note-highway / game-style playback
- Modifying TuxGuitar or ToneLib
- Official (purchased) Rocksmith DLC, or distributing charts, audio, or converted files

## Quality bar (measured on six test songs, 13 arrangements)

- Every bar of every track is complete; every note in the chart appears in the score.
- 95 % of notes on every track land within **1 ms** of their Rocksmith time once mapped through the
  sync points; worst case about 40 ms (main notes after grace notes in loosely charted runs).
- The chart itself lines up with the recording within 2–4 ms, with no drift across a song (measured
  by bass-onset detection on one song).
- Agreement with ToneLib's notation of the same charts: 96–100 % of note onsets.
- The embedded audio matches ToneLib's decode of the same song (correlation 0.998–0.999, zero offset).
- On the user's whole library (206 charts): every chart converts with complete bars and every note;
  p95 onset error ≤ 1 ms for 74 % of songs. The 15 % over 10 ms are charts whose notes aren't on their
  own beat grid (HANDOFF.md, "Library sweep").

Any change should keep these, and `tools/verify.js` / `tools/sweep.js` / `npm test` measure them.

## Decision log

1. **Guitar Pro 8 instead of a TuxGuitar fork.** TuxGuitar has no audio-track concept, its playback
   clock free-runs (would drift against audio), and a fork was estimated at months of work. Guitar Pro 8
   already does audio + sync points + editing. The user chose to buy it.
2. **Per-beat sync points from the Rocksmith beat grid** (the "least drift" option the user asked for).
   Measured alternatives on the first song: one sync point per bar, up to 20 ms off; ToneLib's own
   tempo map, 22 ms; RocksmithToTab output + Guitar Pro's "sync from tempo", about 75 ms drift by the
   end of the song (estimated by replicating its tempo math); per-beat, 0.5 ms.
3. **Own notation converter instead of RocksmithToTab.** RocksmithToTab (2016, Windows-only) ignores
   extended-range cent offsets, guesses time-signature denominators, and couldn't be tested here.
   Owning the converter made it testable on every song and keeps one program.
4. **Port ww2ogg instead of shipping vgmstream.** One program, no external executables, testable
   anywhere, and a browser version stays possible.
5. **`.psarc` is the only input.** ToneLib `.song` files are used only as a test reference for notation.
6. **Notation aims for the best practice experience, not for matching ToneLib** (the user's
   instruction). Deliberate differences, all documented in the README:
   - notes with no charted length fill to the next note but not across a bar line (ToneLib ties
     them across); notes with a charted length are held as charted
   - Rocksmith "linked" notes are ties, not re-picked notes
   - quick slides/hammer-ons into a note are grace notes (on or before the beat, whichever note is on
     the grid)
   - each beat uses the grid with the lowest timing error plus a small readability cost
   - triplet beats use one note value per beat (complete tuplet groups)
   - charts that start late get count-in rest bars so the intro plays
7. **Output naming and safety:** `Artist - Title.gp` next to the input, or in one folder chosen at
   install (the user's: `<Google Drive folder>`, on Google Drive); existing files are skipped
   unless the user picks the overwrite entry.
8. **RSE sounds and muted instrument tracks by default** (the user's request after finding the synth
   late). Guitar Pro's MIDI output lags the audio track; RSE doesn't. Guitar sounds follow the chart's
   Rocksmith tones; bass parts (including a bass charted in a guitar slot) get the finger bass.
9. **Send To entries start `node.exe` directly, no `.cmd` wrapper.** Tested on the user's PC: through
   cmd.exe a name with `&` was cut short (the rest run as a command) and 101 selected files started
   nothing ("command line too long", limit ~75 files). Started directly, all 101 arrived intact (limit
   ~280 long paths). The pause/close-after-10-s behaviour moved into the CLI (`--pause`).
10. **An Explorer preview pane add-in, the one native part** (the user asked to preview `.gp` audio in
    Explorer, then chose a native preview handler over a Node-only "Play recording" menu entry). C# on
    .NET Framework 4.8 and WebView2, both part of Windows 11, so nothing to install at run time; the page
    it shows uses alphaTab, so the score and the synced playback come from the same library that writes
    the files. Kept apart from the converter (own folder and installer), so the converter's rules still
    hold. Its COM class is registered machine-wide (one admin prompt). The user chose that over
    signing out, on a diagnosis that turned out wrong (the registry writes were only visible inside
    Claude's own session, see CLAUDE.md); a per-user install without admin rights would probably work.
11. **A web app that converts inside the browser; no server ever receives files** (the user: "don't do
    a real server upload"; to share with a couple of friends). A server that took in CDLC and handed
    back `.gp` files with the recording would be storing and distributing copyrighted audio (a
    non-goal), would cost money to run, and would make people upload 5–40 MB per song. As a static site
    it can sit on any free host. The library lives in the browser's IndexedDB (the user asked for a
    library kept in the browser), so it is per browser and per computer; downloads are the backup.
12. **One converter for Node and browsers.** `src/` now works on plain byte arrays, with AES and inflate
    written in JavaScript (`src/lib`), because the browser's own decompressor drops data when bytes follow
    a zlib stream (Rocksmith arrangements have them) and WebCrypto has no AES-CFB. Checked: all 225 charts
    in the user's library convert to the same alphaTex, audio and `.gp` contents as before, in the same
    time; the browser's `.gp` files are identical to Node's.
13. **Web player: recording or synth, not both.** alphaTab can't mix its synthesizer with the recording,
    so the user's "toggle between synth and song" is a switch that keeps the place, the loop and the
    speed. The synth plays at the score's written tempo and, by default, only the track on screen.
14. **Hosted on GitHub Pages, built by GitHub Actions** (the user's choice over Netlify drag-and-drop:
    updating the site is a push). Free Pages needs a public repo. The repo holds no charts, audio or
    `.gp` files; before the first push the user chose to rewrite the history so that commits carry
    GitHub's noreply address instead of their email and the docs carry no personal paths. The library
    page links to CustomsForge Ignition for songs (the user's request).

## Observations from real use

- The user's first converted file played correctly in Guitar Pro 8: the synth and recording are in
  time. The playback cursor appears slightly ahead of what is heard; switching to ASIO made no
  difference, and the user is fine with it. It's most likely output latency or how Guitar Pro draws its
  cursor. **Decided not to compensate in the file**: shifting sync points would put the synth out of
  time with the recording and be wrong on other machines.
- Guitar Pro desktop has no dark score page (confirmed by Arobas support). The user will revisit this.
- With the recording turned down and the synth bass up, the user heard some synth notes late (Destroyed
  by Hippie Powers, bar 56). The chart and the file were checked and are aligned. Cause confirmed: the
  tracks used Guitar Pro's MIDI output; switching the track to RSE fixed it, and MIDI was late again.
  Converted files now use RSE sounds and start with the instrument tracks muted (decision 8).
- The user keeps track of songs by sorting Explorer on **Date accessed**. Their `.gp` files go to
  `<Google Drive folder>` (Google Drive for desktop), whose drive reports FAT32 and never records
  access times, so opening a song there doesn't show up. Local NTFS folders do. Offered a local folder
  instead; the user chose to keep Google Drive. Previews deliberately don't count as an access.

## Open questions for the user

- Should bonus/alternate arrangements always be included, or only the main ones?
- Should a guitar-slot arrangement that is really a bass (e.g. a 6-string bass part) be renamed
  ("6-String Bass") rather than keeping Rocksmith's "Rhythm (bonus)"?
- Sections are taken from the first arrangement. Is that right when parts disagree slightly?
