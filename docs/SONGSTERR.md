# Songsterr songs → synced Guitar Pro files: plan

Status: **plan agreed in outline, not built** (2026-11-04). Every part has been tried end to end in
throwaway experiments (lab pages in `.samples/songsterr-lab/`, git-ignored): Songsterr data by bookmarklet,
audio by conversion API, a `.gp` in Guitar Pro 8. No hosting needed. Product intent for the rest of the project is in
[PRODUCT.md](PRODUCT.md); this document adds a second input and becomes decisions 15+ there when built.

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
| track JSON | Songsterr's CDN, fetched by psarc2gp itself (the CDN allows other origins and plain requests) | none to the API |

If the cache read fails (another browser, cache cleared), the bookmarklet asks the user's browser for the
points once (one same-origin request from the user's session, like the page's own), and says so.

The state also holds the signed-in visitor's account (email, name, linked accounts): the bookmarklet copies
**only the song fields** and never sends the rest anywhere.

Handoff: the bookmarklet opens the web app (`window.open`, while the click still counts as a user
gesture), waits for its "ready" message and `postMessage`s the bundle to the web app's origin only; the web
app accepts bundles only from `https://www.songsterr.com`. A "save bundle (.json)" link is the fallback,
and is also how the CLI gets songs (below).

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
YouTube videoId ──► MP3 bytes from a third-party conversion API (user's own key), read by the page / CLI
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
  - map points to played bars in alphaTab's playback order (repeats expanded) → `\sync (bar occurrence ms 0)`;
    if a song's points ever equal the written-bar count instead, map one per written bar; anything else is
    refused for that video.
  - last bar: end time = its start + its written length at the previous bar's audio tempo.
  - anacrusis: give a pickup bar the length the points give it (try alphaTab's anacrusis flag; verify in GP8).
- **convert.js**: `convertSongsterr({ bundle, tracks, video, audio }) → { gp, report }` with the same
  RSE/mute options as `convertPsarc`. Sounds from Songsterr's `instrumentId` (bass → finger bass,
  distortion/overdrive → drive guitar, clean/acoustic → clean). Output name `Artist - Title.gp`, same
  safety rules (never overwrite by default).

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
timeline as Songsterr's points; nothing is cut.

#### Swappable audio sources (the user's requirement)

Conversion APIs come and go, so **how the audio is fetched is a plug-in**, chosen by configuration. Moving
to another API, or to a server of our own if outages recur, means adding one provider file and changing the
config; nothing else in the converter, the web app or the CLI changes.

```
src/songsterr/audio/
  index.js            getAudio(videoId, options): runs the configured providers in order, validates the result
  validate.js         format and length checks, shared by every provider
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
- **Configuration**, `web/songsterr-audio.json`, committed (no secrets in it):
  `{ "providers": ["rapidapi-youtube-mp310", "file"], "offsets": { "rapidapi-youtube-mp310": 0 } }`.
  The list is the fallback order: on `unavailable` or `failed`, the next provider is tried; on `auth`,
  `quota` or `not-found` the user is told, since another API wouldn't fix a private video. `file` last means
  the user is always offered "drop an audio file". The CLI reads the same file, overridable with
  `--audio-provider`.
- **Per-provider offset** (`offsets`, ms, default 0): if a provider's audio turns out shifted (encoder
  padding, a trimmed start), one number corrects every song from it, measured once with a known song.
- **Secrets per provider:** the encrypted key file (below) holds `{ providerId: secret }`, so a new API's
  key is added and rotated with the same tool and the same password.
- **Provenance:** each Songsterr song in the library and each CLI report records which provider supplied
  the audio, so a bad provider can be spotted and its songs redone.
- **Tests:** a contract test every provider must pass, using recorded responses and a fake `fetch`
  (success, bad key, quota, missing video, wrong format, too short); plus the shared checks.

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

- **Encrypted in the repo and site.** `web/songsterr-secrets.json` holds the audio providers' secrets,
  `{ providerId: secret }` (today just the RapidAPI key), encrypted together with one password (WebCrypto:
  PBKDF2-SHA-256 with a high iteration count and a random salt → AES-GCM). Without the password it is opaque
  bytes no key scanner recognizes. Plain secrets are never committed, never in a build secret, never in a
  log. `tools/encrypt-secrets.js` writes the file from secrets and a password typed at its prompt (not passed
  as arguments, so they stay out of shell history); adding a provider's key, rotating a key or changing the
  password = run it again and push. The user chose a simple password (low risk accepted: the encrypted file is public, so a short
  password can be guessed offline).
- **Unlocking:** the web app decrypts the key in the browser and keeps it in that browser's storage.
  Ways in: a password prompt the first time Songsterr audio is needed; an **invite link**
  `…/#unlock=<password>` (the fragment is never sent to GitHub Pages or link-preview bots; the app reads it,
  unlocks, and removes it from the address bar); and the **bookmarklet**, which carries the password and
  hands it over with each song.
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
bookmarklet go the new way, everything else is unchanged. The CLI fetches the tracks from the CDN and the
audio through the same API (key from the environment). Options:
`--video default|backing|solo|playthrough|<videoId>`, `--list-videos`, `--audio file`, `--no-audio`.

### 5. Web app

- A Songsterr page: the bookmarklet button to drag, and a field for the user's RapidAPI key (with a link to
  get a free one), kept in this browser only.
- Receiving a bundle: show the song, the usable videos (default preselected; backing tracks with what they
  leave out) and the tracks; fetch the tracks from the CDN and the audio through the API, convert in the
  existing worker, and add the song to the library with `source: "songsterr"` plus songId/revisionId/videoId.
- No key yet: the user is asked for one, or can drop an audio file instead. `.psarc` conversion is
  unaffected and still never uploads anything.

## Ground-rule changes (record in CLAUDE.md/PRODUCT.md when building)

- **Songsterr is a second input**, read by a bookmarklet in the user's own browser; psarc2gp never calls
  Songsterr's API itself and never works around its bot filter.
- **The audio comes from a third-party conversion API with the user's own key**, sent only to that API
  and kept only in the user's browser (or the CLI's environment). No server of ours, no tools to install;
  the `.psarc` path keeps "one runtime, one dependency, no native tools" and never touches the network.
  The site stays static: it sends a video ID to the API, never a chart, tab or account data.
- **New easy-to-get-wrong facts:** Songsterr string 0 = highest (alphaTex string = Songsterr + 1); points
  are per played bar with no end point; listed videos often don't fit the revision; the page state holds
  the visitor's account, so copy song fields only.

## Don't break psarc

- `src/convert.js` and `src/notation/` stay as they are; Songsterr code lives in `src/songsterr/`. Shared
  helpers move only if `tools/snapshot.js` shows identical output for the whole library.
- Before each merge: `npm test`, and `tools/snapshot.js --compare` over `.samples/` (and the user's library
  on the PC) reports no change.
- The web app's psarc queue path stays as is; Songsterr songs are a new kind of queue item.

## Verification

- Unit tests on small hand-written Songsterr-shaped JSON (no copyrighted tabs in git): durations, tuplets,
  ties, techniques, repeats, string numbering, video choice, point→bar mapping for each count case, last
  bar, anacrusis, negative points, bundle validation.
- Bundles and track JSON for 3–4 real songs in `.samples/songsterr/` (git-ignored), used by tests when
  present: one simple, one with repeats (UNDERWATER BOI), one with tempo changes, one with time-signature
  changes.
- `tools/verify-songsterr.js`: bars complete, every note present, one sync point per played bar, implied
  tempo per bar within a sane range of the written tempo (flags bad points or the wrong video).
- `tools/render-check.cjs` on the output; the user opens files in GP8 and listens (repeats and the first
  bar are the ones to watch).
- Bookmarklet in Chrome, Firefox and Safari on desktop.
- Later, optional: measure the points' accuracy against the audio (gpsync research).

## Order of work

1. `src/songsterr/` core (bundle, score with sync, convert) + CLI reading a saved bundle with `--audio file`;
   tests. psarc snapshot unchanged. First real check: UNDERWATER BOI bass with **real notes** and its
   default video, played by the user in GP8 (the placeholder test was "hard to tell").
2. `src/songsterr/audio/` (contract, shared checks, the RapidAPI and file providers, contract tests) and
   `tools/encrypt-secrets.js`; used by the CLI.
3. The real bookmarklet + the web app's Songsterr page: key field, bundle handling, video choice,
   conversion in the worker, library.
4. `tools/verify-songsterr.js`; bookmarklet in Chrome and Safari.
5. README, PRODUCT.md decisions, CLAUDE.md facts. Then drums and vocals.

## Risks

- **Songsterr changes its page** (state layout, API addresses, CDN). Mitigation: the bookmarklet is small
  and easy to update (users drag the button again); clear messages when a field is missing; saved bundles
  as test fixtures.
- **The conversion API goes away or changes** (such services come and go). Mitigation: audio sources are
  plug-ins chosen by config, with a fallback order (§3); another API is one provider file plus a config
  change; "drop an audio file" always works; our own server has a fixed interface ready if needed.
- **Quota.** The free plan's monthly quota is per key; each user has their own.
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
