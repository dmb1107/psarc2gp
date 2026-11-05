/* The "Open in tab2gp" bookmarklet. It runs on a Songsterr song page in the user's own browser, reads
   what the page has already loaded (the song fields of the page's state, the video sync points from the
   browser's cache) and hands them to the tab2gp web app tab it opens. It makes no request to
   Songsterr's API unless the points aren't cached (then one, like the page's own), and it sends nothing
   anywhere but the web app's origin.

   The web app's Songsterr page builds the bookmark from this file: "__APP__" becomes the app's address and
   "__PASSWORD__" the shared key's password (or ""), then the whole text goes into a javascript: URL.
   A bookmark is one line in some browsers: block comments only, and every statement ends with ";".

   Handoff: the app tab may still be loading, and window.opener may not survive, so this side says
   "hello" every 250 ms; the app answers "ready" to whoever said it (from www.songsterr.com only), gets
   the song, and confirms with "received". Messages are sent to the app's origin only. */
(() => {
  const APP = "__APP__";
  const PASSWORD = "__PASSWORD__";
  const DEFAULT_CDN = "https://dqsljvtekg760.cloudfront.net";
  const origin = new URL(APP).origin;

  const old = document.getElementById("psarc2gp-panel");
  if (old) old.remove();
  const panel = document.createElement("div");
  panel.id = "psarc2gp-panel";
  panel.style.cssText = "position:fixed;z-index:2147483647;right:12px;bottom:12px;width:360px;max-width:calc(100vw - 24px);max-height:60vh;overflow:auto;padding:10px 12px;background:#1b1b1b;color:#f3f3f3;font:13px/1.45 system-ui,sans-serif;border-radius:8px;box-shadow:0 4px 20px rgba(0,0,0,.45);text-align:left";
  const head = document.createElement("div");
  head.style.cssText = "display:flex;justify-content:space-between;align-items:center;font-weight:600;margin-bottom:4px";
  head.textContent = "tab2gp";
  const close = document.createElement("button");
  close.textContent = "×";
  close.title = "Close";
  close.style.cssText = "all:unset;cursor:pointer;font-size:18px;line-height:1;padding:0 4px";
  close.onclick = () => panel.remove();
  head.appendChild(close);
  const lines = document.createElement("div");
  panel.append(head, lines);
  document.body.appendChild(panel);
  const say = (text, color) => {
    const p = document.createElement("div");
    p.textContent = text;
    if (color) p.style.color = color;
    lines.appendChild(p);
    return p;
  };
  const fail = (text) => say(text, "#ff99a4");

  const id = Number((location.pathname.match(/-s(\d+)(?:$|[/?#])/) || [])[1]);
  if (location.hostname !== "www.songsterr.com" || !id) {
    fail("Open a song on www.songsterr.com first, then click the bookmark again.");
    return;
  }
  /* song fields only: the state also holds the visitor's account, which is never copied */
  let song;
  try {
    const st = JSON.parse(document.getElementById("state").textContent);
    const c = st.meta && st.meta.current;
    if (!c || c.songId !== id) throw new Error("this song isn't in the page's data yet");
    song = { songId: c.songId, revisionId: c.revisionId, image: c.image, artist: c.artist, title: c.title, defaultTrack: c.defaultTrack, tracks: c.tracks };
  } catch (e) {
    fail("Couldn't read the song from this page (" + (e && e.message || e) + "). Wait until the tab has loaded, or reload the page, and click again.");
    return;
  }
  say(song.artist + " – " + song.title);
  const pre = [...document.querySelectorAll('link[rel="dns-prefetch"],link[rel="preconnect"]')].map((l) => l.href).find((h) => /cloudfront\.net/.test(h));
  const cdn = pre ? new URL(pre).origin : DEFAULT_CDN;
  const bundle = { kind: "psarc2gp-songsterr", version: 1, page: location.href.split("#")[0], savedAt: new Date().toISOString(), cdn, song, videos: null };

  /* open the app now, while the click still counts as a user gesture (popup blockers) */
  const win = window.open(APP + "#/songsterr", "psarc2gp");
  const status = say(win ? "Opening tab2gp…" : "The browser blocked the new tab: allow pop-ups for songsterr.com and click again, or save the song below.");

  /* fallback: save the song as a file (with every track's tab) to open in tab2gp or the CLI */
  const save = document.createElement("a");
  save.href = "#";
  save.textContent = "Save the song as a file (.json)";
  save.style.cssText = "display:block;margin-top:6px;color:#60cdff;text-decoration:underline;cursor:pointer";
  let saving = false;
  save.onclick = async (e) => {
    if (save.download) return;
    e.preventDefault();
    if (saving || !bundle.videos) return;
    saving = true;
    try {
      const trackData = [];
      for (let i = 0; i < song.tracks.length; i++) {
        save.textContent = "Reading track " + (i + 1) + " of " + song.tracks.length + "…";
        const r = await fetch(cdn + "/" + song.songId + "/" + song.revisionId + "/" + song.image + "/" + i + ".json");
        trackData.push(r.ok ? await r.json() : null);
      }
      save.href = URL.createObjectURL(new Blob([JSON.stringify({ ...bundle, trackData })], { type: "application/json" }));
      save.download = "songsterr-" + song.songId + ".json";
      save.textContent = "Save " + save.download + " (again)";
      save.click();
    } catch (err) {
      save.textContent = "Couldn't read the tracks (" + (err && err.message || err) + "); click to try again";
    }
    saving = false;
  };

  let ready = false, sent = false, hello = null;
  const send = () => {
    if (!ready || !bundle.videos || sent) return;
    sent = true;
    win.postMessage({ type: "psarc2gp-song", bundle, password: PASSWORD || null }, origin);
  };
  window.addEventListener("message", (e) => {
    if (!win || e.source !== win || e.origin !== origin || !e.data) return;
    if (e.data.type === "psarc2gp-ready") { ready = true; clearInterval(hello); send(); }
    if (e.data.type === "psarc2gp-received") {
      status.textContent = "Sent to tab2gp: carry on in its tab.";
      status.style.color = "#9fe0a0";
      setTimeout(() => panel.remove(), 8000);
    }
  });
  if (win) {
    hello = setInterval(() => { try { win.postMessage({ type: "psarc2gp-hello" }, origin); } catch (e) { /* not there yet */ } }, 250);
    setTimeout(() => {
      clearInterval(hello);
      if (!ready) { status.textContent = "tab2gp didn't answer. Is its tab open at " + APP + "? Save the song below and open the file there instead."; status.style.color = "#ff99a4"; }
    }, 20000);
  }

  /* video sync points: the page's own response from the browser cache; one same-origin request if it isn't there */
  (async () => {
    const url = "/api/video-points/" + song.songId + "/" + song.revisionId + "/list";
    let points = null;
    try {
      const r = await fetch(url, { cache: "only-if-cached", mode: "same-origin", credentials: "same-origin" });
      if (r.ok) points = await r.json();
    } catch (e) { /* not cached */ }
    if (!points) {
      try {
        const r = await fetch(url, { credentials: "same-origin" });
        if (!r.ok) throw new Error("Songsterr answered " + r.status);
        points = await r.json();
        say("The video timings weren't in the browser's cache, so they were asked for once.");
      } catch (e) {
        fail("Couldn't read the video timings (" + (e && e.message || e) + "). Play the video on this page once, then click again.");
        clearInterval(hello);
        status.textContent = "";
        return;
      }
    }
    bundle.videos = points.map((v) => ({ videoId: v.videoId, feature: v.feature, tracks: v.tracks, countries: v.countries, points: v.points }));
    panel.appendChild(save);
    send();
  })();
})();
