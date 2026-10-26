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
| Right-click "Send to" conversion on Windows, single files, multiple files, or folders | ◐ scripts written, not yet run on Windows |
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

### Later (not started; ordering is a suggestion)

- Lyrics / vocal melody track (every test chart has timed, pitched lyrics)
- Strum direction, let-ring, left-hand fingering
- A dark-mode practice view. Guitar Pro desktop has no dark score page, and OS colour inversion hides
  the playback cursor. One idea: an alphaTab-based viewer that plays the same `.gp` files.
- A standalone Windows executable (no Node.js install)
- Hosting as a web page (own server or GitHub Pages). Explicitly deferred by the user: don't design for it
  now, but don't make it harder (the core is pure JavaScript with no native tools on purpose).

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

Any change should keep these, and `tools/verify.js` / `npm test` measure them.

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
7. **Output naming and safety:** `Artist - Title.gp` next to the input; existing files are skipped
   unless the user picks the overwrite entry.
8. **RSE sounds and muted instrument tracks by default** (the user's request after finding the synth
   late). Guitar Pro's MIDI output lags the audio track; RSE doesn't. Guitar sounds follow the chart's
   Rocksmith tones; bass parts (including a bass charted in a guitar slot) get the finger bass.

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

## Open questions for the user

- Should bonus/alternate arrangements always be included, or only the main ones?
- Should a guitar-slot arrangement that is really a bass (e.g. a 6-string bass part) be renamed
  ("6-String Bass") rather than keeping Rocksmith's "Rhythm (bonus)"?
- Sections are taken from the first arrangement. Is that right when parts disagree slightly?
