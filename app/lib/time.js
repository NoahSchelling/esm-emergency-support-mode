// Time formatting in Japan Standard Time (UTC+9, no daylight saving time),
// independent of the runtime's own time zone. Works in browsers and Node.js.

const JST_OFFSET_MS = 9 * 3600 * 1000;

function pad(n) {
  return String(n).padStart(2, '0');
}

function toMs(t) {
  if (typeof t === 'number') return Number.isFinite(t) ? t : NaN;
  if (t instanceof Date) return t.getTime();
  if (typeof t === 'string' && t !== '') return Date.parse(t);
  return NaN;
}

// Shift to JST and read the fields with the UTC getters.
function jstParts(ms) {
  const d = new Date(ms + JST_OFFSET_MS);
  return {
    y: d.getUTCFullYear(),
    mo: pad(d.getUTCMonth() + 1),
    d: pad(d.getUTCDate()),
    h: pad(d.getUTCHours()),
    mi: pad(d.getUTCMinutes()),
    s: pad(d.getUTCSeconds()),
  };
}

/**
 * ISO 8601 in JST with an explicit offset and whole seconds,
 * e.g. "2026-11-05T10:00:00+09:00".
 * @param {number} ms epoch milliseconds
 */
export function toJstIso(ms) {
  if (!Number.isFinite(ms)) throw new TypeError('time must be a finite number of milliseconds');
  const p = jstParts(ms);
  return `${p.y}-${p.mo}-${p.d}T${p.h}:${p.mi}:${p.s}+09:00`;
}

/**
 * Short human-readable JST time for the screen, e.g. "11/05 10:00:00".
 * Accepts epoch milliseconds, a Date or an ISO string. Unreadable input is
 * shown as unknown instead of guessing.
 */
export function formatJst(t) {
  const ms = toMs(t);
  if (!Number.isFinite(ms)) return '時刻不明';
  const p = jstParts(ms);
  return `${p.mo}/${p.d} ${p.h}:${p.mi}:${p.s}`;
}
