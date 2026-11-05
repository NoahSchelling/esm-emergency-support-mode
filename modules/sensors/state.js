// Internal helper: holds the latest reading of one sensor, applies the
// "stale" rule on every read, and notifies subscribers.

import { STATUS, makeResult, secondsToMs, toIsoWithOffset } from './result.js';

export const NOT_YET_DETAIL = 'まだ値を受け取っていません（値がないことは、異常がないという意味ではありません）。';

export function createSensorState({ kind, env, staleAfterSec }) {
  const staleAfterMs = secondsToMs('staleAfterSec', staleAfterSec);
  let current = {
    status: STATUS.UNKNOWN,
    value: null,
    detail: NOT_YET_DETAIL,
    observedAtMs: env.now(),
  };
  const listeners = new Set();

  function read() {
    const now = env.now();
    if (current.status === STATUS.OK && now - current.observedAtMs > staleAfterMs) {
      return makeResult({
        kind,
        status: STATUS.STALE,
        observedAtMs: now,
        source: env.source,
        detail:
          `値が ${staleAfterMs / 1000} 秒以上更新されていません` +
          `（最後の値の時刻：${toIsoWithOffset(current.observedAtMs)}）。古い値は返しません。`,
      });
    }
    return makeResult({ kind, ...current, source: env.source });
  }

  function set({ status, value = null, detail, observedAtMs = env.now() }) {
    current = { status, value, detail, observedAtMs };
    const result = read();
    for (const fn of [...listeners]) {
      try {
        fn(result);
      } catch (err) {
        // A broken listener must not stop the others.
        queueMicrotask(() => {
          throw err;
        });
      }
    }
    return result;
  }

  function subscribe(fn) {
    if (typeof fn !== 'function') throw new TypeError('listener must be a function');
    listeners.add(fn);
    return () => listeners.delete(fn);
  }

  return { read, set, subscribe, get status() { return current.status; } };
}

export function insecureDetail(what) {
  return `HTTPS ではない画面のため、${what}を使えません（ブラウザが HTTPS でのみ許可しています）。`;
}
