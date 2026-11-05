// Which audio providers run, in what order, and their measured offsets. Plain data, no secrets
// (keys live encrypted in web/songsterr-secrets.json). Moving to another conversion API = add a file in
// providers/, register it in index.js, and change this list.
export default {
  // fallback order: on "unavailable" or "failed" the next one is tried. "file" last means the user is
  // always offered "use an audio file I have".
  // The backup (rapidapi-youtube-mp36) runs when the first can't deliver a video: its file host answered
  // 502 on some videos every time (2026-11-05).
  providers: ["rapidapi-youtube-mp310", "rapidapi-youtube-mp36", "file"],
  // ms added to every sync point for audio from that provider (encoder delay, trimmed starts);
  // measure once with a known song. rapidapi-youtube-mp310 (UNDERWATER BOI, 2026-11-05): 44.1 kHz MP3s from
  // ffmpeg with no Info/LAME header, so the encoder's 576-sample delay (13 ms) is never skipped; attacks
  // measured 20 ms after Songsterr's beats with a decoder that keeps the 529-sample decoder delay, 8 ms
  // with macOS's, which drops it. 13 ms (the encoder delay) sits in between whichever Guitar Pro uses.
  // rapidapi-youtube-mp36 (Kerosene!, 2026-11-05): 128 kbit/s with a Xing/LAME header (Lavc59.37, delay 576,
  // padding 704); decoded without skipping, sample for sample in step with rapidapi-youtube-mp310's MP3 of
  // the same video (cross-correlation at 10, 100, 200, 280 s: 0 samples, r > 0.99). Decoders that read the
  // header (ffmpeg, Apple, Chrome, Firefox) skip those 13 ms, so 0. Unknown: whether Guitar Pro reads it
  // (if not, this audio plays 13 ms late there).
  offsets: { "rapidapi-youtube-mp310": 13, "rapidapi-youtube-mp36": 0 },
  // larger than any song's MP3 or M4A; a bigger answer is something else
  maxBytes: 200 * 1024 * 1024,
};
