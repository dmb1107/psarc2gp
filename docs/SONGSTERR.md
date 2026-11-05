# Songsterr songs → synced Guitar Pro files: plan

Status: **plan agreed in outline, not built** (2026-11-04). Every part has been tried end to end in
throwaway experiments (lab pages in `.samples/songsterr-lab/`, git-ignored): Songsterr data by bookmarklet,
audio by conversion API, a `.gp` in Guitar Pro 8. No hosting needed. Product intent for the rest of the project is in
[PRODUCT.md](PRODUCT.md); this document adds a second input, replaces decision 5 there (".psarc is the only
input") and becomes decisions 15+ when built.

Reviewed 2026-11-04 before building: stale "each user's own key" text removed (the shared, encrypted key is
the decision), and gaps added below (repeat endings and jumps, library name clashes, revoking access,
audio duration parsing, MP3 offset, per-bar sync as a ground-rule change). A psarc baseline snapshot was
taken at commit 2167034 (15 charts, 0 errors), see "Don't break psarc".

## Goal

From a Songsterr song the user is viewing, get a Guitar Pro 8 file (CLI or web app) with:

- the tab's tracks as notation + tab (guitar and bass first, then drums; vocals kept as notation with lyrics)
- the audio of the **same YouTube video Songsterr plays** embedded as the audio track
- a sync point on every played bar, taken from **Songsterr's own video sync points**

Everything that works for `.psarc` today keeps working unchanged (see "Don't break psarc").

## How the data is obtained: a bookmarklet, no requests of our own

Songsterr's API refuses automated clients (finding 5), and building around that filter is off the table.
What works instead: a **bookmarklet** ("Open in psarc2gp") the user clicks while viewing a song on
songsterr.com in their own browser. Songsterr's page has already loaded everything for that visitor; the
bookmarklet only reads it and hands it to psarc2gp:

| Needed | Where the bookmarklet reads it | Request to Songsterr |
|---|---|---|
| song metadata (revision, `image`, artist, title, tracks, tunings, video list) | the page's own state, `<script id="state" type="application/json">` → `meta.current` | none |
| video sync points | the page's own `/api/video-points/{id}/{rev}/list` response, read from the browser cache (`fetch(url, { cache: "only-if-cached", mode: "same-origin" })`, which fails rather than going to the network) | none |
| track JSON | Songsterr's CDN, fetched by psarc2gp itself (the CDN allows other origins and plain requests); a **saved** bundle carries every track's JSON too (below) | none to the API |

If the cache read fails (another browser, cache cleared), the bookmarklet asks the user's browser for the
points once (one same-origin request from the user's session, like the page's own), and says so.

The state also holds the signed-in visitor's account (email, name, linked accounts): the bookmarklet copies
**only the song fields** and never sends the rest anywhere.

Handoff: the bookmarklet opens the web app (`window.open`, while the click still counts as a user
gesture), waits for its "ready" message and `postMessage`s the bundle to the web app's origin only; the web
app accepts bundles only from `https://www.songsterr.com`. A "save bundle (.json)" link is the fallback,
and is also how the CLI gets songs (below). A saved bundle includes every track's JSON (fetched from the CDN
by the bookmarklet when the user saves), so it converts offline, keeps working if the CDN later wants a
signed-in session, and is a complete test fixture. The `postMessage` bundle leaves the tracks out; the web
app fetches only the ones the user picks. Bundles hold copyrighted tabs: `.samples/` only, never git.

The handoff depends on `window.opener` surviving the `window.open`. A strict `Cross-Origin-Opener-Policy`
on either side would cut it; the lab handoff worked, so neither side blocks it today. If that changes,
"save bundle" still works, and the bookmarklet should say so when no "ready" arrives within a few seconds.

Proven in the lab (user's Firefox 159, Turnstile – UNDERWATER BOI): the bookmarklet ran on Songsterr's
page, read the metadata from the state and all 8 videos' points from the cache, identical to what the API
returns, and handed them to a page on another origin. Not yet tried: Chrome and Safari, phones.

## What we know (experiments, 2026-11-04)

Songs: Enter Sandman (song 19, revision 10176590; no repeats, anacrusis) and Turnstile – UNDERWATER BOI
(song 514895, revision 5672979; repeats).

| Data | Address | Readable from another site? |
|---|---|---|
| metadata | `www.songsterr.com/api/meta/{songId}` (the page itself uses `…/revisions?translateTo=en`) | No CORS; also in the page's state |
| video points | `www.songsterr.com/api/video-points/{songId}/{revisionId}/list` | No CORS |
| one track's tab | `dqsljvtekg760.cloudfront.net/{songId}/{revisionId}/{image}/{partIndex}.json` | **Yes**: `Access-Control-Allow-Origin: *` |

The CDN host is in the song page's `<link rel="dns-prefetch">`; the bookmarklet passes it along in case it
changes.

1. **Points are bar start times in video seconds** (2 decimals), with no end point for the last bar.
2. **Points are per *played* bar.** UNDERWATER BOI: 71 written bars, four repeated sections (×2, ×3, ×2,
   ×4) = 99 played bars; every video has 99 points. Enter Sandman (no repeats): 174 bars, 174 points. Each
   pass through a repeat gets its own point.
3. **Not every listed video fits the revision.** Enter Sandman lists 96 videos; most have 171–173 points
   (synced to older revisions, often with the first two points equal). Only an entry whose point count
   equals the played-bar count is usable. On UNDERWATER BOI all 8 fit.
4. **Points can be negative** (a video that starts after the tab's beginning: one alternative starts at
   −12.64 s), which means a positive `FramePadding`.
5. **Songsterr's API refuses automated clients.** After about a dozen scripted requests, `api/meta`
   returned 403 to every non-browser request for over an hour while a real browser on the same connection
   got the data; the CDN kept answering plain requests. Hence the bookmarklet design above.
6. **Anacrusis:** Enter Sandman's track JSON has `anacrusis: true` with bar 0 a whole rest in 4/4, and the
   default video gives bar 0 only 0.26 s. Needs handling (see Sync).
7. **`backing` videos name the tracks they leave out** (`tracks: [4]` = no drums, `[0, 1]` = no guitars):
   useful for "play along without your part".
8. **Tab JSON is clean to convert.** Durations are rationals (`[1, 8]`, `[3, 8]` dotted, `[1, 24]` +
   `tuplet`), string 0 is the **highest** string, tuning is listed high to low as MIDI numbers. Bars carry
   `signature`, `marker` (sections), `repeatStart`, `repeat` (count). Seen on guitar/bass: ties, slides,
   hammer/pull (`hp`), bends, vibrato, palm mute, let ring, dead and ghost notes, accents, staccato,
   harmonics, grace notes, tremolo bar, wah; tempo automations per track.
   **Not yet seen:** alternate endings (voltas) and jumps (D.S., D.C., coda, fine). Neither test song has
   them. They change which bars are played, so the point mapping depends on them: find a song with each,
   save its bundle, and record the field names here before writing the mapping.
9. **alphaTab already writes the sync, repeats included.** A test score with a repeated bar and
   `\sync (bar occurrence ms ratio)` exported `BarOccurrence` 0/1, a separate `ModifiedTempo` for the
   slower second pass (96 vs 120, correct) and `FramePadding` from the first point. So the psarc pipeline
   (alphaTex → alphaTab → `.gp` → RSE rewrite) works for Songsterr with no hand-written GPIF code.
10. **Audio format:** alphaTab embeds the audio bytes as they are; Guitar Pro detects the format. User check
    in GP8: **MP3 and M4A (AAC) play and stay on the clicks; Ogg Opus and WebM Opus don't play.** So
    YouTube's M4A stream is embedded as downloaded, no transcoding.

## Design

```
Songsterr page ──bookmarklet──► bundle { meta, points, cdn }
                                   │
          ┌────────────────────────┴───────────────────────┐
          ▼                                                ▼
   web app (postMessage)                          CLI (saved bundle .json)
          │                                                │
          └──► src/songsterr/: tracks from CDN → alphaTex + \sync → alphaTab → .gp
                                   ▲
YouTube videoId ──► MP3 bytes from a third-party conversion API (shared key, unlocked by a password),
                    read by the page / CLI; or an audio file the user drops in
```

### 1. Bookmarklet: `web/songsterr-bookmarklet.js`

Built from the lab version into the web app's Songsterr page as a "drag this to your bookmarks bar" button
(the button's code carries the web app's own address). Reads as above, shows a small status panel on the
Songsterr page, opens the web app with the bundle, offers "save bundle" as the fallback. Kept small and
self-contained; it sends nothing anywhere but the user's own web app tab.

### 2. Converter core: `src/songsterr/` (platform-neutral, like the rest of `src/`)

- **bundle.js**: validate a bundle (kind, version, song/revision IDs present, points shaped right); fetch
  each wanted track's JSON from the CDN (`fetch` passed in).
- **score.js**: Songsterr JSON → alphaTex, written for Songsterr data rather than bent to fit
  Rocksmith's: bars, time signatures, tempo automations, sections, repeats, rational durations → alphaTex
  durations/dots/tuplets, ties, techniques (finding 8), tuning, capo; drums as a percussion track (v2);
  vocals as a notation-only staff with lyrics, or left out with a warning if they don't convert cleanly.
  Reuse `src/notation` helpers only where they fit as they are; the psarc modules aren't changed for
  Songsterr's sake.
- **Sync** (in score.js):
  - pick the video: the default entry if its point count matches; otherwise a matching `alternative`
    (all countries first); `backing` and the other kinds when asked for. Non-matching entries are listed as
    unusable, never stretched to fit.
  - map points to played bars in alphaTab's playback order → `\sync (bar occurrence ms 0)` (ratio 0 = bar
    start, as the psarc code writes it). Playback order means repeats expanded, **alternate endings taken
    on their pass, and jumps (D.S./D.C./coda/fine) followed**. Compute the order once, in one function, and
    check it against alphaTab's own (its MIDI generator's bar sequence) in a test, so the two never drift;
    if alphaTab 1.8.4 doesn't follow jumps, write the jumps out as plain bars or refuse the song with a clear
    message rather than sync it wrong. If a song's points ever equal the written-bar count instead, map one
    per written bar; anything else is refused for that video.
  - last bar: end time = its start + its written length at the previous bar's audio tempo. (The lab's
    `audio.html` reused the previous bar's audio length instead, which is wrong when the last bar's length
    differs.)
  - anacrusis: give a pickup bar the length the points give it (try alphaTab's anacrusis flag; verify in GP8).
  - one point per bar, not per beat: tempo changes inside a bar aren't in Songsterr's data, so the audio
    tempo is constant across each bar. This is a deliberate exception to "every chart beat gets a sync point"
    (see Ground-rule changes).
- **convert.js**: `convertSongsterr({ bundle, tracks, video, audio }) → { gp, report }` with the same
  RSE/mute options as `convertPsarc`. Sounds from Songsterr's `instrumentId` (bass → finger bass,
  distortion/overdrive → drive guitar, clean/acoustic → clean). Output name
  **`Artist - Title (Songsterr).gp`**, same safety rules (never overwrite by default). The suffix matters:
  the web library's key is the lowercased file name (`songId(name)` in `web/library.js`), so a plain
  `Artist - Title.gp` would collide with the `.psarc` version of the same song (the queue says "exists" and
  "Replace" overwrites the psarc file), and the CLI would skip it in a shared output folder. Another video
  or revision of the same Songsterr song is still the same name: "exists"/"Replace" as today, with the
  video and revision shown so the user knows what they're replacing.

### 3. Audio: a third-party conversion API, no hosting of our own

Requirements (the user's): the audio is inside the `.gp`, because it must work in Guitar Pro (the web app's
alphaTab player is only a backup); users download and install nothing; no hosting if avoidable. Browsers
can't fetch YouTube audio themselves, so a conversion service does it: **RapidAPI "YouTube MP3"**
(`youtube-mp310.p.rapidapi.com`, free BASIC plan and paid tiers), called from the page with the user's key.

Tried in the lab (`.samples/songsterr-lab/audio.html`, 2026-11-04, user's key, UNDERWATER BOI default video):

| Step | Result |
|---|---|
| `GET /download/mp3?url=<YouTube URL>` with `x-rapidapi-key` | 200 in 0.7 s → `{ downloadUrl }` on `robotilab.online`; the gateway sends CORS headers for our origins |
| read the MP3 from the page | 3.7 MB in 10 s (converted on request); the file host sends `Access-Control-Allow-Origin: *` |
| decode, compare with the points | 185.0 s; last bar starts at 182.2 s, so the whole tab is covered |
| `.gp` with the MP3 embedded, Songsterr's points | user in GP8: sections appear to line up ("hard to tell" with placeholder notes; recheck with real notes) |

MP3 is embedded as delivered (GP8 plays MP3; the click test landed on the beat). Same video ID → same
timeline as Songsterr's points; nothing is cut. **But don't assume a zero offset:** re-encoding to MP3
usually adds an encoder delay (typically ~25–50 ms of silence at the start), and whether Guitar Pro skips it
depends on the file's gapless header. Measure it once in step 2 (a song with a clear attack on bar 1, or
the click test against Songsterr's points) and put the result in that provider's `offsets` entry.

#### Swappable audio sources (the user's requirement)

Conversion APIs come and go, so **how the audio is fetched is a plug-in**, chosen by configuration. Moving
to another API, or to a server of our own if outages recur, means adding one provider file and changing the
config; nothing else in the converter, the web app or the CLI changes.

```
src/songsterr/audio/
  index.js            getAudio(videoId, options): runs the configured providers in order, validates the result
  config.js           which providers, in what order, and their offsets (plain data, no secrets)
  validate.js         format and length checks, shared by every provider
  duration.js         MP3 and M4A duration from the bytes (no decoder needed)
  providers/
    rapidapi-youtube-mp310.js   today's provider
    file.js                     "use an audio file I have" (always available, needs no secret)
    helper.js                   our own server, if one is ever needed (contract below; not built until then)
```

- **One contract for every provider:**
  `fetchAudio({ videoId, secret, fetch, signal, onProgress }) → { bytes, format, provider, meta }`. `fetch` is
  passed in (browser and Node alike, and fakes in tests); `secret` is that provider's credential, if any;
  `signal` cancels; `onProgress` feeds the queue's status ("converting…", "downloading 2.1 / 3.7 MB").
- **One error vocabulary:** providers throw `AudioError` with a code: `auth` (bad or missing key), `quota`
  (used up), `unavailable` (service down, removed, CORS refused), `not-found` (video private, removed or
  blocked in the region), `failed` (conversion error, bad output). The web app and CLI show messages by
  code, so swapping providers never changes the wording users see.
- **Shared checks after every provider** (validate.js): the bytes are MP3 or M4A, the formats Guitar Pro 8
  plays (Opus/WebM refused with a clear message, since GP8 won't play them); the audio is long enough to
  cover the last sync point; a size sanity limit. A provider that returns something else is treated as
  `failed`.
- **Duration without a decoder** (duration.js): the length check and the report's `audioSeconds` need the
  audio's duration, but Node and the conversion worker have no `decodeAudioData`. MP3: the Xing/Info or
  VBRI header's frame count (plus LAME's delay/padding fields, which also give the encoder offset above),
  else count frame headers. M4A: `mvhd`/`mdhd` duration ÷ timescale. Plain Uint8Array/DataView code, tested
  on tiny synthetic files (frame headers and boxes written by the test, no real audio in git).
- **Configuration**, `src/songsterr/audio/config.js`, committed (no secrets in it):
  `export default { providers: ["rapidapi-youtube-mp310", "file"], offsets: { "rapidapi-youtube-mp310": 0 } }`.
  A module rather than a JSON file under `web/`: Node and the browser import it the same way, so `src/`
  stays free of fs-or-fetch code (only ww2ogg's codebook load needs that). The list is the fallback order:
  on `unavailable` or `failed`, the next provider is tried; on `auth`, `quota` or `not-found` the user is
  told, since another API wouldn't fix a private video. `file` last means the user is always offered "drop
  an audio file". The CLI uses the same config, overridable with `--audio-provider`.
- **Per-provider offset** (`offsets`, ms, default 0): if a provider's audio turns out shifted (encoder
  padding, a trimmed start), one number corrects every song from it, measured once with a known song.
- **Secrets per provider:** the encrypted key file (below) holds `{ providerId: secret }`, so a new API's
  key is added and rotated with the same tool and the same password.
- **Provenance:** each Songsterr song in the library and each CLI report records which provider supplied
  the audio, so a bad provider can be spotted and its songs redone.
- **Tests:** a contract test every provider must pass, using recorded responses and a fake `fetch`
  (success, bad key, quota, missing video, wrong format, too short); plus the shared checks. Recorded
  responses keep only the JSON and headers; audio bodies are synthetic bytes (no recordings in git).

**If hosting becomes necessary** (the API disappears, or alternatives keep failing): `helper.js` talks to
a small server of ours with a fixed, minimal interface, fixed now so the server can be written later
without touching the client:
`GET {base}/audio/{videoId}` with `Authorization: Bearer <token>` → `200` audio bytes (`audio/mpeg` or
`audio/mp4`), or `401`/`429`/`404`/`502` mapped onto the same error codes; CORS for the web app's origins;
nothing stored. Its `base` URL goes in the config and its token in the encrypted secrets, like an API
key. Where it would run (home machine, cloud function, paid host) is decided then; data-centre IPs are often
refused by YouTube.

#### The API key

The user's decision: friends use the user's own RapidAPI key (free plan, no payment details on the account,
so low risk; one shared monthly quota), but the key must not be readable from GitHub.

- **A RapidAPI account just for this.** A RapidAPI key works for every API its account subscribes to, so
  the shared key should come from an account subscribed only to YouTube MP3 (free plan, no card). Then the
  worst a leaked key can do is use up that quota.

- **Encrypted in the repo and site.** `web/songsterr-secrets.json` holds the audio providers' secrets,
  `{ providerId: secret }` (today just the RapidAPI key), encrypted together with one password (WebCrypto:
  PBKDF2-SHA-256 with a high iteration count and a random salt → AES-GCM). Without the password it is opaque
  bytes no key scanner recognizes. Plain secrets are never committed, never in a build secret, never in a
  log. `tools/encrypt-secrets.js` writes the file from secrets and a password typed at its prompt (not passed
  as arguments, so they stay out of shell history); adding a provider's key, rotating a key or changing the
  password = run it again and push. The user chose a simple password (low risk accepted: the encrypted file is public, so a short
  password can be guessed offline).
- **Revoking access means a new key, not a new password.** Every earlier version of the encrypted file
  stays in git history (and in anyone's clone), and the old password still opens it. If it held the same
  key, changing the password locks nobody out. To cut access: regenerate the key in RapidAPI, then encrypt
  the new key (with a new password if wanted) and push. Browsers that stored the old key get `auth` and
  ask for the password again.
- **Unlocking:** the web app decrypts the key in the browser and keeps it in that browser's storage.
  Ways in: a password prompt the first time Songsterr audio is needed; an **invite link**
  `…/#unlock=<password>`; and the **bookmarklet**, which carries the password and hands it over with each
  song.
- **The invite link and the app's routes.** The app already routes by fragment (`#/`, `#/play/<id>`).
  `#unlock=` is read before the first `route()` runs and removed with `history.replaceState` (setting
  `location.hash` would leave it in the back history), then routing continues at `#/`. What the fragment
  does and doesn't protect: it isn't sent to GitHub Pages in requests, but the full link, password
  included, stays wherever it is pasted (the chat app that carries the invite, the browser's history and
  bookmark sync). Fine for this key; send invites by direct message, not a public channel.
- **The CLI unlocks the same file:** it reads `web/songsterr-secrets.json` and asks for the password at a
  prompt, or takes it from `PSARC2GP_PASSWORD` (for scripts). One place for the key, rotated with one tool;
  no separate key in the environment.
- **Safari's 7-day rule** (it deletes a site's stored data after 7 days of Safari use without a visit)
  doesn't cost a prompt: the bookmarklet lives in the bookmarks, which Safari never clears, and re-supplies
  the password; a bookmarked invite link does the same for direct visits; a web app added to the Dock or
  Home Screen is exempt anyway. (The bookmarklet runs inside Songsterr's page, so that page could in theory
  see the password: accepted for a low-risk key.)
- **Settings panel:** key set or not, enter or change the password, remove it, and "Copy invite link" for
  the user to send to friends.
- **Everything else works without the password** (the user's requirement). `.psarc` conversion, the
  library, the player and `.gp` uploads never ask for it and never load the key file. Songsterr songs without
  the password still convert when the user drops in an audio file; only "fetch the audio for me" needs it.
  A missing, wrong or forgotten password shows a prompt in the Songsterr flow only, never a broken page.
- Related, not caused by this: Safari's 7-day rule also clears the **library** (IndexedDB) for Safari users
  who stay away a week. Add a short Safari notice: keep the downloaded `.gp` files, or add the app to the
  Dock / Home Screen.

**Guitar Pro's own YouTube audio track (tried, 2026-11-04): dead in 8.1.5.** Guitar Pro has a hidden
`<Source>YouTube</Source>` mode with `<YouTubeVideoUrl>` (both direct children of `<BackingTrack>`; alphaTab
nests `YouTubeVideoUrl` inside `<ChannelStrip>`, where Guitar Pro doesn't read it). With the layout fixed,
Guitar Pro read the video ID and requested `https://www.youtube.com/get_video_info?video_id=…`, which YouTube
retired in 2021 (`410 Gone`, in Guitar Pro's `log.txt`); the track showed an empty waveform and played
nothing, with or without a silent asset attached. A newer Guitar Pro might fix this; worth retrying the
lab's YouTube-source files after a Guitar Pro update.

Also ruled out: embedding a YouTube-to-MP3 site (it can't hand the file to our page, so the user would still
download it; ad-heavy and fragile); recording the audio as it plays in the page (user: no); a download tool
on users' machines (user: no).

### 4. CLI

`node bin/psarc2gp.js <file.psarc | folder | songsterr-bundle.json> ...`: `.json` bundles saved by the
bookmarklet go the new way, everything else is unchanged (folders are still searched for `.psarc` only, so
a stray `.json` in a chart folder is never picked up). The CLI uses the tracks inside the saved bundle (the
CDN only for a bundle without them) and fetches the audio through the same providers (password as in §3).
Output goes next to the bundle or into `--out`, named as in §2. Options:
`--video default|backing|solo|playthrough|<videoId>`, `--list-videos`, `--audio file`, `--no-audio`,
`--audio-provider <id>`.

### 5. Web app

- A Songsterr page: the bookmarklet button to drag (it carries the web app's address, plus the password
  once this browser is unlocked; before that it works without one and the song needs a dropped audio file,
  so the page says to drag it again after unlocking), and the settings panel from §3: key unlocked or
  not, enter or change the password, forget it, "Copy invite link".
- Receiving a bundle: show the song, the usable videos (default preselected; backing tracks with what they
  leave out) and the tracks; fetch the tracks from the CDN and the audio through the providers, convert in
  the existing worker, and add the song to the library with `source: "songsterr"` plus
  `songsterrId`/`revisionId`/`videoId`/`audioProvider` (not `songId`, which is already `library.js`'s
  name-to-key function).
- Not unlocked yet: the password prompt appears in this flow only, or the user drops an audio file instead.
  `.psarc` conversion is unaffected and still never uploads anything.
- Changing the library's record shape needs no IndexedDB version bump (records are schemaless and the new
  fields are optional), but the list view must cope with records that lack them.

## Ground-rule changes (record in CLAUDE.md/PRODUCT.md when building)

- **Songsterr is a second input**, read by a bookmarklet in the user's own browser; psarc2gp never calls
  Songsterr's API itself and never works around its bot filter.
- **The audio comes from a third-party conversion API with one shared key**, committed only encrypted
  (`web/songsterr-secrets.json`), unlocked by a password, sent only to that API, and stored decrypted only
  in the user's browser. No server of ours, no tools to install; the `.psarc` path keeps "one runtime, one
  dependency, no native tools" and never touches the network. The site stays static: it sends a video ID
  to the API, never a chart, tab or account data. (PRODUCT.md decision 11, "no server ever receives
  files", still holds: a video ID isn't a file.)
- **Sync for Songsterr songs is per bar, not per beat**, because that is what Songsterr's points give. The
  "every chart beat gets a sync point" rule stays for `.psarc`; for Songsterr the rule is "every played bar
  gets a sync point, from the chosen video's own points, never stretched to fit".
- **New easy-to-get-wrong facts:** Songsterr string 0 = highest (alphaTex string = Songsterr + 1); points
  are per played bar with no end point; listed videos often don't fit the revision; the page state holds
  the visitor's account, so copy song fields only; changing the secrets password revokes nothing (rotate
  the key); Songsterr output is named `… (Songsterr).gp` because library keys are file names.

## Don't break psarc

- `src/convert.js` and `src/notation/` stay as they are; Songsterr code lives in `src/songsterr/`. Shared
  helpers move only if `tools/snapshot.js` shows identical output for the whole library.
- Before each merge: `npm test`, and `tools/snapshot.js --compare` against the baseline reports no change.
  Baseline: `.samples/psarc-baseline.json` (git-ignored), taken on the Mac at commit 2167034 from the
  user's Rocksmith CDLC folder in their Google Drive music folder (15 charts, 0 errors, ~17 s). Re-run the
  same command after a change and compare:
  `node tools/snapshot.js .samples/psarc-after.json "<music folder>/Rocksmith_Custom_DLC"` then
  `node tools/snapshot.js --compare .samples/psarc-baseline.json .samples/psarc-after.json`.
  `.samples/` on the Mac has no charts of its own, so `npm test`'s sample tests skip there; the snapshot is
  the psarc check on this machine. The PC library is the wider check before a release.
- If `main` changes the converter while this branch is open, retake the baseline from `main` first, or the
  comparison shows `main`'s changes as regressions.
- The web app's psarc queue path stays as is; Songsterr songs are a new kind of queue item.

## Verification

- Unit tests on small hand-written Songsterr-shaped JSON (no copyrighted tabs in git): durations, tuplets,
  ties, techniques, repeats, alternate endings, jumps, string numbering, video choice, point→bar mapping
  for each count case (and our played order equal to alphaTab's), last bar, anacrusis, negative points,
  bundle validation, output name, MP3/M4A duration.
- Bundles and track JSON for 3–4 real songs in `.samples/songsterr/` (git-ignored), used by tests when
  present: one simple, one with repeats (UNDERWATER BOI), one with tempo changes, one with time-signature
  changes, one with alternate endings, one with a D.S./coda. Where the user has a `.gp` of the same song in
  the GuitarPro folder of their music library, compare bar counts and notes with it as a second opinion.
- `tools/verify-songsterr.js`: bars complete, every note present, one sync point per played bar, implied
  tempo per bar within a sane range of the written tempo (flags bad points or the wrong video).
- `tools/render-check.cjs` on the output; the user opens files in GP8 and listens (repeats and the first
  bar are the ones to watch).
- Bookmarklet in Chrome, Firefox and Safari on desktop.
- Later, optional: measure the points' accuracy against the audio (gpsync research).

## Order of work

0. Before code: save bundles (with track JSON) for a song with alternate endings and one with a D.S./coda,
   record their field names in finding 8, and check whether alphaTab 1.8.4's playback follows jumps.
   The lab bookmarklet needs only the "include tracks" addition for this.
1. `src/songsterr/` core (bundle, score with sync and played order, convert) + CLI reading a saved bundle
   with `--audio file`; tests. psarc snapshot unchanged against the baseline. First real check:
   UNDERWATER BOI bass with **real notes** and its default video, played by the user in GP8 (the
   placeholder test was "hard to tell").
2. `src/songsterr/audio/` (contract, config, shared checks, duration.js, the RapidAPI and file providers,
   contract tests) and `tools/encrypt-secrets.js` (on the dedicated RapidAPI account's key); used by the
   CLI. Measure the provider's MP3 offset and record it in config.js.
3. The real bookmarklet + the web app's Songsterr page: settings panel and unlocking (prompt, invite link
   before routing, bookmarklet), bundle handling, video choice, conversion in the worker, library.
4. `tools/verify-songsterr.js`; bookmarklet in Chrome and Safari.
5. README, PRODUCT.md decisions (5 replaced, 15+ added), CLAUDE.md facts and ground rules. Then drums and
   vocals.

## Risks

- **Songsterr changes its page** (state layout, API addresses, CDN). Mitigation: the bookmarklet is small
  and easy to update (users drag the button again); clear messages when a field is missing; saved bundles
  as test fixtures. A stricter `Cross-Origin-Opener-Policy` would break the `postMessage` handoff (§1);
  "save bundle" is the fallback. If the CDN starts wanting a signed-in session, saved bundles (which carry
  the tracks) keep working and the web app would need the bookmarklet to send the tracks too.
- **The conversion API goes away or changes** (such services come and go). Mitigation: audio sources are
  plug-ins chosen by config, with a fallback order (§3); another API is one provider file plus a config
  change; "drop an audio file" always works; our own server has a fixed interface ready if needed.
- **Quota.** The free plan's monthly quota is per key, and the user and friends share one key, so one busy
  user can use it up for everyone. Mitigation: `quota` gets its own message ("this month's shared audio
  allowance is used up; drop an audio file or try next month"); converted songs keep their audio, so only
  new songs need the API; if it's hit regularly, a paid tier or a second provider in the config.
- **Key exposure.** Anyone with the password, and any script on Songsterr's page while the bookmarklet runs,
  can read the key. Accepted for a free, card-less, single-API account; revoke by rotating the key (§3).
- **Terms of service.** Extracting Songsterr's data and downloading YouTube audio likely break both sites'
  terms. Fine for personal practice is the user's judgment (agreed); nothing (tabs, audio, `.gp`, bundles,
  keys) goes into git or onto the public site.
- **Point quality** varies per video and contributor. Mitigation: count check, tempo sanity check, choice
  of video.

## User's answers (2026-11-04)

1. GP8 plays MP3 and M4A (notes on the clicks); the Opus files don't play.
2. Hosting: the user's existing web host turned out to have no hosting plan; then, no downloads or
   installs on users' machines, and no hosting if avoidable → the conversion API (§3).
3. Any YouTube tool is fine; Guitar Pro is the hard requirement, alphaTab only a backup.
4. Guitar and bass, then drums; keep vocals if Guitar Pro handles them.
5. Terms of service: OK on the personal-practice basis.

## Alternatives considered

- Calling Songsterr's API from the CLI or a server: blocked by its bot filter (finding 5); faking a browser
  to get past it is ruled out.
- Embedding Songsterr in our page: refused by `X-Frame-Options: Deny`, and a cross-origin frame can't be
  read anyway.
- A userscript (Tampermonkey etc.): same reading as the bookmarklet, but every user installs an extension
  first.
- Asking Songsterr for API access: still worth doing; it would let the CLI work without a saved bundle.
- Computing our own sync points from the audio (gpsync research): the fallback for songs whose videos
  don't fit the tab, or tabs from elsewhere.
