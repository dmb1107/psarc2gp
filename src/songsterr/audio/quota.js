// A RapidAPI key's monthly allowance, as the gateway reports it on every answer it relays:
//   x-ratelimit-requests-limit      requests a month on the plan
//   x-ratelimit-requests-remaining  left this month (shared by everyone with the key)
//   x-ratelimit-requests-reset      seconds until the allowance renews
// Only these names: the gateway's plain x-ratelimit-* headers can be a per-second or per-minute limit, which
// would read as a monthly count. Browsers see the headers because the gateway lists every header it adds in
// Access-Control-Expose-Headers (seen on its 403s, 2026-11-05: all its x-rapidapi-* headers were listed).
//
// → { remaining, limit, resetAt, seenAt } (limit and resetAt null when not sent; times in ms), or null.
export function readQuota(headers, now = Date.now()) {
  const num = (name) => {
    const v = headers?.get?.(name);
    if (v == null || String(v).trim() === "") return null;
    const n = Number(v);
    return Number.isFinite(n) && n >= 0 ? n : null;
  };
  const remaining = num("x-ratelimit-requests-remaining");
  if (remaining == null) return null;
  const reset = num("x-ratelimit-requests-reset");
  return { remaining, limit: num("x-ratelimit-requests-limit"), resetAt: reset == null ? null : now + reset * 1000, seenAt: now };
}

// a quota error without the headers still says how much is left
export const usedUp = (now = Date.now()) => ({ remaining: 0, limit: null, resetAt: null, seenAt: now });

// "241 of 300 left, renews in 12 days" (what the CLI prints; the web app words its own)
export function describeQuota(q, now = Date.now()) {
  if (!q) return "";
  const left = q.limit != null ? `${q.remaining} of ${q.limit} left` : `${q.remaining} left`;
  if (q.resetAt == null || q.resetAt <= now) return left;
  const days = Math.round((q.resetAt - now) / 86400000);
  return `${left}, renews ${days < 1 ? "within a day" : days === 1 ? "in 1 day" : `in ${days} days`}`;
}
