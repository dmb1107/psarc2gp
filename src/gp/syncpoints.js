// Guitar Pro's layout for sync points in songs with repeats. In a file Guitar Pro 8 writes, a SyncPoint
// automation's <Bar> is the *played* bar number (repeats expanded: 0, 1, … 25, 26, …), <Value><BarIndex> is
// the written bar, <BarOccurrence> the pass, and the points are stored in play order. alphaTab 1.8.4 writes
// the written bar in both and groups the points by bar. GP8 copes with that unless a repeat starts at the
// first bar: then both passes of bar 1 say "played bar 0" and GP8 squeezes the whole recording into the
// first bars (Lágrima, 2026-11-05; a test score repeating bars 1-4 showed 1:20 instead of 0:30). alphaTab's
// reader takes the bar from <BarIndex>, so the rewritten file still opens the same in alphaTab.
//
// played: [{ bar, occurrence }] in play order (sync.js playedBars). Throws if the XML isn't shaped as
// alphaTab 1.8 writes it, like rse.js, so an alphaTab upgrade fails loudly.
export function syncPointsInPlayOrder(gpif, played) {
  const playIndex = new Map(played.map((p, i) => [`${p.bar}:${p.occurrence}`, i]));
  const start = gpif.indexOf("<MasterTrack>");
  const end = gpif.indexOf("</MasterTrack>", start);
  if (start < 0 || end < 0) throw new Error("score.gpif: no <MasterTrack> element");
  const master = gpif.slice(start, end);
  const a0 = master.indexOf("<Automations>");
  const a1 = master.indexOf("</Automations>", a0);
  if (a0 < 0 || a1 < 0) throw new Error("score.gpif: no master track <Automations>");
  const inner = master.slice(a0 + "<Automations>".length, a1);
  const automations = inner.match(/<Automation>[\s\S]*?<\/Automation>/g) ?? [];
  if (automations.join("") !== inner.replace(/^\s+|\s+$/g, "")) throw new Error("score.gpif: unexpected content in the master track automations");

  const other = [];
  const sync = [];
  for (const a of automations) {
    if (!a.includes("<Type>SyncPoint</Type>")) { other.push(a); continue; }
    const num = (tag) => {
      const m = a.match(new RegExp(`<${tag}>([^<]*)</${tag}>`));
      if (!m) throw new Error(`score.gpif: a sync point without <${tag}>`);
      return Number(m[1]);
    };
    const bar = num("BarIndex"), occurrence = num("BarOccurrence"), position = num("Position");
    const p = playIndex.get(`${bar}:${occurrence}`);
    if (p === undefined) throw new Error(`score.gpif: sync point for bar ${bar + 1} pass ${occurrence + 1}, which isn't played`);
    if ((a.match(/<Bar>\d+<\/Bar>/g) ?? []).length !== 1) throw new Error("score.gpif: a sync point without exactly one <Bar>");
    sync.push({ p, position, xml: a.replace(/<Bar>\d+<\/Bar>/, `<Bar>${p}</Bar>`) });
  }
  sync.sort((x, y) => x.p - y.p || x.position - y.position);
  const rebuilt = master.slice(0, a0) + "<Automations>" + [...other, ...sync.map((s) => s.xml)].join("") + master.slice(a1);
  return gpif.slice(0, start) + rebuilt + gpif.slice(end);
}
