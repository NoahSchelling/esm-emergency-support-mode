// Shaking (DeviceMotionEvent): raw acceleration and rotation rate, plus the
// maximum over a period of time.
//
// BW-S1: these are raw values recorded by this device. They are NOT a seismic
// intensity, and nothing here decides whether an earthquake happened or how
// strong it was. No thresholds, no alerts.

import { STATUS, makeResult, secondsToMs, toIsoWithOffset } from './result.js';
import { createSensorState, insecureDetail } from './state.js';
import { requestEventPermission } from './permission.js';
import { resolveEnv } from './env.js';

export const KIND = 'motion';
export const PEAK_KIND = 'motion_peak';
export const PERMISSION_KIND = 'motion_permission';

// Text to show next to any value from this module.
export const MOTION_LABEL = 'この端末が記録した揺れ（震度ではありません）';

// ！！仮の値！！ seconds without an event before the value is stale.
export const DEFAULT_STALE_AFTER_SEC = 2;
// ！！仮の値！！ seconds of samples kept for peak(windowSec).
export const DEFAULT_HISTORY_SEC = 60;

const NO_SAMPLE_DETAIL =
  'この間に揺れの値を受け取っていません（値がないことは、揺れがなかったという意味ではありません）。';

function num(v) {
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

function vec(v, keys) {
  if (!v) return null;
  const out = {};
  let any = false;
  for (const k of keys) {
    out[k] = num(v[k]);
    if (out[k] !== null) any = true;
  }
  return any ? out : null;
}

const XYZ = ['x', 'y', 'z'];
const ABG = ['alpha', 'beta', 'gamma'];

export function eventToSample(e) {
  return {
    acceleration: vec(e.acceleration, XYZ),
    acceleration_including_gravity: vec(e.accelerationIncludingGravity, XYZ),
    rotation_rate: vec(e.rotationRate, ABG),
    interval_ms: num(e.interval),
  };
}

function magnitude(v, keys) {
  let sum = 0;
  for (const k of keys) sum += (v[k] ?? 0) ** 2;
  return Math.sqrt(sum);
}

// Accumulates the maximum absolute value per axis and the maximum magnitude.
function createPeakAccumulator() {
  const fields = {
    acceleration: { keys: XYZ, max: null },
    acceleration_including_gravity: { keys: XYZ, max: null },
    rotation_rate: { keys: ABG, max: null },
  };
  let count = 0;
  let firstMs = null;
  let lastMs = null;
  return {
    add(sample, t) {
      count++;
      firstMs ??= t;
      lastMs = t;
      for (const [name, f] of Object.entries(fields)) {
        const v = sample[name];
        if (!v) continue;
        f.max ??= { ...Object.fromEntries(f.keys.map((k) => [k, null])), magnitude: 0 };
        for (const k of f.keys) {
          if (v[k] !== null) f.max[k] = Math.max(f.max[k] ?? 0, Math.abs(v[k]));
        }
        f.max.magnitude = Math.max(f.max.magnitude, magnitude(v, f.keys));
      }
    },
    value(fromMs, toMs) {
      return {
        acceleration_max: fields.acceleration.max,
        acceleration_including_gravity_max: fields.acceleration_including_gravity.max,
        rotation_rate_max: fields.rotation_rate.max,
        sample_count: count,
        from: toIsoWithOffset(fromMs),
        to: toIsoWithOffset(toMs),
        first_sample_at: firstMs === null ? null : toIsoWithOffset(firstMs),
        last_sample_at: lastMs === null ? null : toIsoWithOffset(lastMs),
        label: MOTION_LABEL,
      };
    },
    get count() {
      return count;
    },
  };
}

const PEAK_DETAIL =
  `${MOTION_LABEL}。期間内の最大値です（軸ごとの絶対値の最大と、大きさの最大。` +
  '単位は加速度が m/s²、回転が度/秒）。地震の有無や強さの判断には使えません。';

export function createMotionSensor({
  env,
  staleAfterSec = DEFAULT_STALE_AFTER_SEC,
  historySec = DEFAULT_HISTORY_SEC,
} = {}) {
  env = resolveEnv(env);
  const state = createSensorState({ kind: KIND, env, staleAfterSec });
  const historyMs = secondsToMs('historySec', historySec);
  let history = []; // { t, sample }
  let head = 0;
  const recorders = new Set();
  let listening = false;

  function precheck() {
    if (env.isSecureContext === false) return { status: STATUS.INSECURE, detail: insecureDetail('揺れのセンサー') };
    if (typeof env.DeviceMotionEvent === 'undefined' || !env.window) {
      return { status: STATUS.UNSUPPORTED, detail: 'この端末・ブラウザは揺れのセンサー（DeviceMotion）に対応していません。' };
    }
    return null;
  }

  function prune(now) {
    while (head < history.length && history[head].t < now - historyMs) head++;
    if (head > 1024 && head * 2 > history.length) {
      history = history.slice(head);
      head = 0;
    }
  }

  function onMotion(e) {
    const now = env.now();
    const sample = eventToSample(e);
    if (!sample.acceleration && !sample.acceleration_including_gravity && !sample.rotation_rate) {
      // Desktop browsers may fire the event with every field empty.
      state.set({
        status: STATUS.UNSUPPORTED,
        detail: '揺れのイベントは届きましたが、値が空でした（この端末には揺れのセンサーがないか、値を出していません）。',
      });
      return;
    }
    history.push({ t: now, sample });
    prune(now);
    for (const r of recorders) r.add(sample, now);
    state.set({
      status: STATUS.OK,
      value: { ...sample, label: MOTION_LABEL },
      detail: `${MOTION_LABEL}。生の値です（加速度は m/s²、回転は度/秒）。`,
      observedAtMs: now,
    });
  }

  function blockedResult(kind) {
    // When the sensor itself cannot be used, a peak is not "zero".
    const s = state.status;
    if (s === STATUS.DENIED || s === STATUS.INSECURE || s === STATUS.UNSUPPORTED) {
      const cur = state.read();
      return makeResult({ kind, status: s, observedAtMs: env.now(), source: env.source, detail: cur.detail });
    }
    return null;
  }

  return {
    kind: KIND,
    label: MOTION_LABEL,
    read: state.read,
    subscribe: state.subscribe,

    // Call this directly from a button's click handler (iOS Safari).
    requestPermission() {
      const p = requestEventPermission({
        env,
        kind: PERMISSION_KIND,
        EventClass: env.DeviceMotionEvent,
        what: '揺れのセンサー',
      });
      return p.then((r) => {
        if (r.status === STATUS.DENIED || r.status === STATUS.INSECURE || r.status === STATUS.UNSUPPORTED) {
          state.set({ status: r.status, detail: r.detail });
        }
        return r;
      });
    },

    start() {
      const pre = precheck();
      if (pre) return state.set(pre);
      if (!listening) {
        env.window.addEventListener('devicemotion', onMotion);
        listening = true;
      }
      return state.read();
    },

    stop() {
      if (listening) {
        env.window.removeEventListener('devicemotion', onMotion);
        listening = false;
      }
    },

    // Maximum over the last windowSec seconds (from the kept history).
    peak(windowSec) {
      const windowMs = secondsToMs('windowSec', windowSec);
      if (windowMs > historyMs) throw new RangeError('windowSec must not exceed historySec');
      const blocked = blockedResult(PEAK_KIND);
      if (blocked) return blocked;
      const now = env.now();
      const from = now - windowMs;
      const acc = createPeakAccumulator();
      for (let i = head; i < history.length; i++) {
        if (history[i].t >= from) acc.add(history[i].sample, history[i].t);
      }
      return peakResult(acc, from, now);
    },

    // Record the maximum from now until stop() is called.
    startPeakRecording() {
      const startedAt = env.now();
      const acc = createPeakAccumulator();
      recorders.add(acc);
      let finished = null;
      const snapshot = () => blockedResult(PEAK_KIND) ?? peakResult(acc, startedAt, env.now());
      return {
        read: () => finished ?? snapshot(),
        stop() {
          if (!finished) {
            recorders.delete(acc);
            finished = snapshot();
          }
          return finished;
        },
      };
    },
  };

  function peakResult(acc, fromMs, toMs) {
    if (acc.count === 0) {
      return makeResult({ kind: PEAK_KIND, status: STATUS.UNKNOWN, observedAtMs: toMs, source: env.source, detail: NO_SAMPLE_DETAIL });
    }
    return makeResult({
      kind: PEAK_KIND,
      status: STATUS.OK,
      value: acc.value(fromMs, toMs),
      observedAtMs: toMs,
      source: env.source,
      detail: PEAK_DETAIL,
    });
  }
}
