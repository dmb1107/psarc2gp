// Song-wide bar structure from Rocksmith's beat grid.
//
// Rocksmith charts carry one timestamp per beat ("ebeats"), with beat 0 of each measure marked, and
// optional "TS:n/d" events that give the time signature (the grid alone only gives the beat count).
// Everything here is measured in ticks with 48 ticks per quarter note (fits 32nds and triplets).
export const TPQ = 48;

export function buildTimeline(beats, events, { anyNotesIn = () => true } = {}) {
  if (!beats.length) throw new Error("chart has no beat grid");
  const ts = events
    .map((e) => /^TS:(\d+)\/(\d+)$/.exec(e.name) && { time: e.time, num: +RegExp.$1, den: +RegExp.$2 })
    .filter(Boolean)
    .sort((a, b) => a.time - b.time);
  const denAt = (t) => {
    let den = 4;
    for (const e of ts) if (e.time <= t + 0.01) den = e.den; else break;
    return den;
  };

  // group beats into measures (a measure starts at every beat with index 0)
  const groups = [];
  for (const b of beats) {
    if (b.beat === 0 || !groups.length) groups.push([]);
    groups[groups.length - 1].push(b.time);
  }

  // the final measure ends one beat (the grid's last beat interval) after its last beat
  const lastInterval = beats.length > 1 ? beats[beats.length - 1].time - beats[beats.length - 2].time : 0.5;
  const measures = groups.map((times, index) => {
    const end = groups[index + 1]?.[0] ?? times[times.length - 1] + lastInterval;
    let den = denAt(times[0]);
    let num = times.length;
    let beatTicks = (4 * TPQ) / den;
    let display = { num, den };
    if (den === 1) {
      // a "1/1" bar (seen as a lead-in hack) is shown as 4/4 with one Rocksmith beat per whole note
      display = { num: 4 * num, den: 4 };
    }
    return { index, start: times[0], end, beatTimes: times, num, den, beatTicks, ticks: num * beatTicks, display, leadIn: false };
  });

  // Lead-in hack: an opening bar of a single (often very long) beat with nothing played in it is
  // rewritten as an ordinary rest bar in the following bar's meter. Only its start is synced.
  const first = measures[0];
  if (measures.length > 1 && first.num === 1 && !anyNotesIn(first.start, first.end)) {
    const nxt = measures[1];
    first.leadIn = true;
    first.display = { ...nxt.display };
    first.beatTicks = nxt.beatTicks;
    first.num = nxt.num;
    first.ticks = nxt.ticks;
  }

  // Pre-roll: when the chart's first beat comes well after the start of the recording, add rest bars
  // in front so the score starts with the audio (otherwise Guitar Pro would skip the intro).
  const ref = measures.find((m) => !m.leadIn) ?? first;
  const refBar = ref.end - ref.start;
  const preRoll = [];
  if (first.start >= Math.max(1.0, refBar * 0.5)) {
    const k = Math.max(1, Math.round(first.start / refBar));
    for (let i = 0; i < k; i++) {
      preRoll.push({
        start: (first.start * i) / k, end: (first.start * (i + 1)) / k, beatTimes: [(first.start * i) / k],
        num: ref.num, den: ref.den, beatTicks: ref.beatTicks, ticks: ref.ticks, display: { ...ref.display }, leadIn: true, preRoll: true,
      });
    }
  }
  const all = [...preRoll, ...measures];

  let tick = 0;
  all.forEach((m, index) => {
    m.index = index;
    m.startTick = tick;
    tick += m.ticks;
    // quarter-note tempo implied by this bar's beats
    const beatSeconds = (m.end - m.start) / (m.leadIn ? m.num : m.beatTimes.length);
    m.tempo = Math.min(999, Math.max(20, Math.round((60 / beatSeconds) * (m.beatTicks / TPQ))));
  });
  // stretched lead-in / pre-roll bars would show a meaningless tempo; show the opening tempo instead
  for (const m of all) if (m.leadIn) m.tempo = ref.tempo;
  return all;
}

// Index of the measure that contains time t (notes a hair before a downbeat belong to it).
export function measureAt(measures, t, slack = 0.002) {
  let lo = 0, hi = measures.length - 1;
  if (t < measures[0].start - slack) return -1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (measures[mid].start <= t + slack) lo = mid; else hi = mid - 1;
  }
  return lo;
}

// Per-beat sync points: every Rocksmith beat is pinned to its exact time in the recording.
export function syncPoints(measures) {
  const pts = [];
  for (const m of measures) {
    if (m.leadIn) {
      pts.push({ bar: m.index, ratio: 0, ms: m.start * 1000 });
      continue;
    }
    m.beatTimes.forEach((t, j) => pts.push({ bar: m.index, ratio: j / m.beatTimes.length, ms: t * 1000 }));
  }
  const last = measures[measures.length - 1];
  pts.push({ bar: last.index, ratio: 1, ms: last.end * 1000 });
  return pts;
}
