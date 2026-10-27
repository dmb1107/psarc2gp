// The practice player: one track's notation + tab, played from the file's recording (alphaTab follows
// the sync points) or from alphaTab's synthesizer, with track choice, looping and speed. Same base as the
// Explorer preview (windows/preview/web), plus practice controls.
//
// alphaTab plays the recording or the synthesizer, not both at once. Switching rebuilds its player, so
// the position (in score ticks: the synthesizer runs at the score's tempo, not the recording's timing),
// the loop range and the play state are carried over by hand.
import * as alphaTab from "../node_modules/@coderline/alphatab/dist/alphaTab.mjs";

const ALPHATAB = new URL("../node_modules/@coderline/alphatab/dist/", import.meta.url).href;
const { PlayerMode } = alphaTab;
const { PlayerState } = alphaTab.synth;

const NOTE = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"];
const pitch = (midi) => `${NOTE[midi % 12]}${Math.floor(midi / 12) - 1}`;
const tuningOf = (track) => [...track.staves[0].tuning].reverse().map(pitch).join(" "); // alphaTab lists the highest string first
const clock = (ms) => { const s = Math.max(0, Math.floor(ms / 1000)); return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`; };

// colours for alphaTab, from the page's CSS variables (alphaTab draws the score itself)
function scoreColors() {
  const css = getComputedStyle(document.documentElement);
  const hex = (name) => css.getPropertyValue(name).trim();
  const rgb = (h) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16));
  const fg = hex("--fg"), bg = hex("--bg");
  const mix = (t) => `rgb(${rgb(fg).map((v, i) => Math.round(v * t + rgb(bg)[i] * (1 - t))).join(",")})`;
  return {
    mainGlyphColor: fg, scoreInfoColor: fg,
    secondaryGlyphColor: mix(0.45), staffLineColor: mix(0.4), barSeparatorColor: mix(0.55), barNumberColor: mix(0.6),
  };
}

// the track picked last time is remembered by name; otherwise a bass part, else the first
const TRACK_KEY = "psarc2gp.web.track";
function firstTrack(score) {
  let name = null;
  try { name = localStorage.getItem(TRACK_KEY); } catch { /* not kept */ }
  const byName = score.tracks.findIndex((t) => t.name === name);
  if (byName >= 0) return byName;
  return Math.max(0, score.tracks.findIndex((t) => /bass/i.test(t.name) || Math.max(...t.staves[0].tuning) < 50));
}

export class Player {
  constructor(el) {
    this.el = el; // { score, viewport, play, time, seek, recording, synth, speed, speedValue, loop, clearRange, tracks, tuning, soloWrap, solo, hint, status }
    this.api = null;
    this.onLength = null; // (seconds) => {}: the song's length, once the player knows it
    this.wire();
  }

  // ------------------------------------------------------------------------------------ controls
  wire() {
    const { el } = this;
    el.play.addEventListener("click", () => this.api?.playPause());
    el.seek.addEventListener("input", () => { this.seeking = true; this.showTime(+el.seek.value, +el.seek.max); });
    el.seek.addEventListener("change", () => { if (this.api) this.api.timePosition = +el.seek.value; this.seeking = false; });
    el.recording.addEventListener("click", () => this.setSource("recording"));
    el.synth.addEventListener("click", () => this.setSource("synth"));
    el.speed.addEventListener("input", () => this.setSpeed(+el.speed.value));
    el.speedValue.addEventListener("click", () => this.setSpeed(100));
    el.loop.addEventListener("click", () => this.setLooping(!this.looping));
    el.clearRange.addEventListener("click", () => {
      if (!this.api) return;
      this.api.playbackRange = null;
      this.api.clearPlaybackRangeHighlight();
    });
    el.solo.addEventListener("change", () => this.applyMix());
    document.addEventListener("keydown", (e) => {
      if (!this.api || e.code !== "Space" || e.repeat || e.target.closest?.("button, input, select, textarea, a")) return;
      e.preventDefault();
      this.api.playPause();
    });
  }

  showTime(now, end) { this.el.time.textContent = `${clock(now)} / ${clock(end)}`; }

  setSpeed(percent) {
    this.el.speed.value = percent;
    this.el.speedValue.textContent = `${percent}%`;
    if (this.api) this.api.playbackSpeed = percent / 100;
  }

  setLooping(on) {
    this.looping = on;
    this.el.loop.setAttribute("aria-pressed", String(on));
    if (this.api) this.api.isLooping = on;
    this.showHint();
  }

  showHint() {
    const range = !!this.api?.playbackRange;
    this.el.clearRange.hidden = !range;
    this.el.hint.textContent = range
      ? (this.looping ? "Looping the selected passage." : "Passage selected: playback stops at its end. Turn on Loop to repeat it.")
      : (this.looping ? "Looping the whole song. Drag across the score to loop a passage." : "Click the score to jump there; drag across it to select a passage.");
  }

  setReady(ready) {
    for (const b of [this.el.play, this.el.seek, this.el.recording, this.el.synth]) b.disabled = !ready;
    if (!this.hasRecording) this.el.recording.disabled = true;
  }

  // -------------------------------------------------------------------------------------- opening
  open(bytes) {
    this.close();
    const { el } = this;
    const score = alphaTab.importer.ScoreLoader.loadScoreFromBytes(bytes, new alphaTab.Settings());
    this.score = score;
    this.hasRecording = !!score.backingTrack?.rawAudioFile;
    this.source = this.hasRecording ? "recording" : "synth";
    this.current = -1;
    this.restore = null;
    this.seeking = false;

    const api = new alphaTab.AlphaTabApi(el.score, {
      core: { fontDirectory: `${ALPHATAB}font/` },
      display: { layoutMode: "Page", scale: 0.9, padding: [16, 16], resources: scoreColors() },
      player: {
        playerMode: this.hasRecording ? PlayerMode.EnabledBackingTrack : PlayerMode.EnabledSynthesizer,
        soundFont: `${ALPHATAB}soundfont/sonivox.sf2`,
        scrollElement: el.viewport,
        enableCursor: true,
        enableUserInteraction: true,
      },
    });
    this.api = api;
    this.setReady(false);
    this.showSource();
    this.setSpeed(100);
    this.setLooping(false);
    this.showTime(0, 0);
    el.seek.value = 0;

    // (no api.midiLoaded: in alphaTab 1.8.4 subscribing to it recurses forever when the synthesizer
    // plays; the position events carry the length too)
    api.playerReady.on(() => {
      this.setReady(true);
      this.applyMix();
      const r = this.restore;
      this.restore = null;
      if (r) {
        if (r.range) api.playbackRange = r.range;
        api.tickPosition = r.tick;
        if (r.playing) api.play();
      }
      this.showHint();
    });
    api.playerStateChanged.on((e) => {
      const playing = e.state === PlayerState.Playing;
      el.play.classList.toggle("playing", playing);
      el.play.setAttribute("aria-label", playing ? "Pause" : "Play");
      el.play.title = playing ? "Pause (Space)" : "Play (Space)";
    });
    api.playerPositionChanged.on((e) => {
      if (e.endTime && this.source === (this.hasRecording ? "recording" : "synth")) this.onLength?.(e.endTime / 1000);
      if (this.seeking) return;
      el.seek.max = e.endTime;
      el.seek.value = e.currentTime;
      this.showTime(e.currentTime, e.endTime);
    });
    api.playbackRangeChanged.on(() => this.showHint());
    api.renderFinished.on(() => { el.status.textContent = ""; });
    api.error.on((err) => { el.status.textContent = `Something went wrong: ${err.message ?? err}`; });

    // track tabs
    el.tracks.replaceChildren();
    this.buttons = score.tracks.map((track, i) => {
      const b = document.createElement("button");
      b.type = "button";
      b.textContent = track.name;
      b.title = tuningOf(track);
      b.addEventListener("click", () => {
        this.showTrack(i);
        try { localStorage.setItem(TRACK_KEY, track.name); } catch { /* not kept */ }
      });
      el.tracks.append(b);
      return b;
    });
    this.showTrack(firstTrack(score));
    return score;
  }

  close() {
    if (!this.api) return;
    this.api.destroy();
    this.api = null;
    this.score = null;
    this.el.score.replaceChildren();
    this.el.tracks.replaceChildren();
  }

  showTrack(i) {
    if (i === this.current) return;
    this.current = i;
    this.buttons.forEach((b, j) => b.setAttribute("aria-pressed", String(j === i)));
    this.el.tuning.textContent = tuningOf(this.score.tracks[i]);
    this.el.status.textContent = "Drawing the score…";
    if (this.api.score) this.api.renderTracks([this.score.tracks[i]]);
    else this.api.renderScore(this.score, [i]);
    this.applyMix();
  }

  // ------------------------------------------------------------------------- recording / synth
  showSource() {
    this.el.recording.setAttribute("aria-pressed", String(this.source === "recording"));
    this.el.synth.setAttribute("aria-pressed", String(this.source === "synth"));
    this.el.soloWrap.hidden = this.source !== "synth";
  }

  setSource(source) {
    const api = this.api;
    if (!api || source === this.source || (source === "recording" && !this.hasRecording)) return;
    this.restore = { tick: api.tickPosition, range: api.playbackRange, playing: api.playerState === PlayerState.Playing };
    api.pause();
    this.source = source;
    this.showSource();
    this.setReady(false);
    api.settings.player.playerMode = source === "synth" ? PlayerMode.EnabledSynthesizer : PlayerMode.EnabledBackingTrack;
    api.updateSettings();
  }

  // synthesizer: psarc2gp files keep their instrument tracks muted (for Guitar Pro), so unmute them here;
  // "only this track" solos the one on screen
  applyMix() {
    const api = this.api;
    if (!api || this.source !== "synth" || !api.isReadyForPlayback) return;
    const tracks = this.score.tracks;
    api.changeTrackMute(tracks, false);
    api.changeTrackSolo(tracks, false);
    if (this.el.solo.checked) api.changeTrackSolo([tracks[this.current]], true);
  }

  // re-colour the score after a theme change
  updateColors() {
    if (!this.api) return;
    this.api.settings.fillFromJson({ display: { resources: scoreColors() } });
    this.api.updateSettings();
    this.api.render();
  }
}
