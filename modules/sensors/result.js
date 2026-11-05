// Common result shape shared by every module in this repository.
// Works in both browsers and Node.js (no globals are touched at import time).

export const STATUS = Object.freeze({
  OK: 'ok',
  DENIED: 'denied',
  UNSUPPORTED: 'unsupported',
  INSECURE: 'insecure',
  ERROR: 'error',
  STALE: 'stale',
  UNKNOWN: 'unknown',
});

const VALID_STATUS = new Set(Object.values(STATUS));

function pad(n, width = 2) {
  return String(n).padStart(width, '0');
}

// ISO 8601 with an explicit offset taken from the runtime's local time zone
// (e.g. "2026-11-05T10:00:00.000+09:00").
export function toIsoWithOffset(ms) {
  if (!Number.isFinite(ms)) throw new TypeError('time must be a finite number of milliseconds');
  const date = new Date(ms);
  const offsetMin = -date.getTimezoneOffset();
  const local = new Date(ms + offsetMin * 60000);
  const sign = offsetMin >= 0 ? '+' : '-';
  const abs = Math.abs(offsetMin);
  return (
    `${local.getUTCFullYear()}-${pad(local.getUTCMonth() + 1)}-${pad(local.getUTCDate())}` +
    `T${pad(local.getUTCHours())}:${pad(local.getUTCMinutes())}:${pad(local.getUTCSeconds())}` +
    `.${pad(local.getUTCMilliseconds(), 3)}${sign}${pad(Math.floor(abs / 60))}:${pad(abs % 60)}`
  );
}

function deepFreeze(obj) {
  if (obj && typeof obj === 'object' && !Object.isFrozen(obj)) {
    Object.freeze(obj);
    for (const v of Object.values(obj)) deepFreeze(v);
  }
  return obj;
}

// Build a result. `value` is dropped unless status is "ok", so a caller can
// never show a value next to "denied", "stale", etc.
export function makeResult({ kind, status, value = null, observedAtMs, source, detail }) {
  if (typeof kind !== 'string' || kind === '') throw new TypeError('kind is required');
  if (!VALID_STATUS.has(status)) throw new TypeError(`invalid status: ${status}`);
  if (typeof source !== 'string' || source === '') throw new TypeError('source is required');
  if (typeof detail !== 'string') throw new TypeError('detail must be a string');
  const keep = status === STATUS.OK && value !== null && value !== undefined;
  return deepFreeze({
    kind,
    status,
    value: keep ? structuredClone(value) : null,
    observed_at: toIsoWithOffset(observedAtMs),
    source,
    detail,
  });
}

// Convert a "seconds" argument to milliseconds, with validation.
export function secondsToMs(name, sec) {
  if (sec === Infinity) return Infinity;
  if (typeof sec !== 'number' || !Number.isFinite(sec) || sec <= 0) {
    throw new RangeError(`${name} must be a positive number of seconds (or Infinity)`);
  }
  return sec * 1000;
}
