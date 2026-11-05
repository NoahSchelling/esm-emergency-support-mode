// Test helpers: build simulated events with fixed times (JST).
export const T0 = "2026-11-05T10:00:00+09:00";

export function at(minutes) {
  const ms = Date.parse(T0) + minutes * 60 * 1000;
  // Keep the +09:00 offset so the times stay readable in JST.
  const d = new Date(ms + 9 * 3600 * 1000);
  return d.toISOString().replace("Z", "+09:00").replace(".000", "");
}

export function hours(h) {
  return at(h * 60);
}

export const pub = (id, category, t, extra = {}) => ({
  type: "public",
  id,
  category,
  at: t,
  source: "simulated",
  ...extra,
});

export const end = (target_id, reason, t) => ({
  type: "public_end",
  target_id,
  reason,
  at: t,
  source: "simulated",
});

export const user = (request, t) => ({ type: "user", request, at: t });

export const tick = (t) => ({ type: "tick", at: t, source: "simulated" });
