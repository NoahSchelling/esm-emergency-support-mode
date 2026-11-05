// Location (Geolocation API): latitude, longitude, accuracy in metres.
// The position never leaves this module except through read()/subscribe();
// nothing here sends it anywhere.

import { STATUS, secondsToMs } from './result.js';
import { createSensorState, insecureDetail } from './state.js';
import { resolveEnv } from './env.js';

export const KIND = 'location';

// ！！仮の値！！ default seconds before a location is considered stale.
export const DEFAULT_STALE_AFTER_SEC = 120;
// ！！仮の値！！ default timeout for one position request.
export const DEFAULT_TIMEOUT_SEC = 30;

function finiteOrNull(v) {
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

export function errorToState(err) {
  switch (err?.code) {
    case 1:
      return {
        status: STATUS.DENIED,
        detail: '位置情報の利用が許可されていません。端末やブラウザの設定で許可を変えられます。',
      };
    case 2:
      return { status: STATUS.ERROR, detail: '位置を取得できませんでした（端末が位置を出せない状態です）。' };
    case 3:
      return { status: STATUS.ERROR, detail: '時間内に位置を取得できませんでした。' };
    default:
      return { status: STATUS.ERROR, detail: '位置の取得で不明なエラーが起きました。' };
  }
}

export function positionToState(pos, now) {
  const c = pos?.coords ?? {};
  const lat = finiteOrNull(c.latitude);
  const lon = finiteOrNull(c.longitude);
  const acc = finiteOrNull(c.accuracy);
  if (lat === null || lon === null || lat < -90 || lat > 90 || lon < -180 || lon > 180 || acc === null || acc < 0) {
    return { status: STATUS.ERROR, detail: '受け取った位置の値が不正でした。' };
  }
  const ts = finiteOrNull(pos.timestamp);
  return {
    status: STATUS.OK,
    value: {
      latitude: lat,
      longitude: lon,
      accuracy_m: acc,
      altitude_m: finiteOrNull(c.altitude),
      altitude_accuracy_m: finiteOrNull(c.altitudeAccuracy),
      heading_deg: finiteOrNull(c.heading),
      speed_mps: finiteOrNull(c.speed),
    },
    detail: `端末が報告した位置です（誤差はおよそ ${Math.round(acc)} メートル）。`,
    // Use the time the device obtained the fix, so a cached old fix is
    // judged stale correctly.
    observedAtMs: ts ?? now,
  };
}

export function createLocationSensor({
  env,
  staleAfterSec = DEFAULT_STALE_AFTER_SEC,
  enableHighAccuracy = true,
  timeoutSec = DEFAULT_TIMEOUT_SEC,
  maximumAgeSec = 0,
} = {}) {
  env = resolveEnv(env);
  const state = createSensorState({ kind: KIND, env, staleAfterSec });
  const options = {
    enableHighAccuracy,
    timeout: secondsToMs('timeoutSec', timeoutSec),
    maximumAge: maximumAgeSec * 1000,
  };
  let watchId = null;

  function precheck() {
    if (env.isSecureContext === false) {
      return { status: STATUS.INSECURE, detail: insecureDetail('位置情報') };
    }
    if (!env.navigator?.geolocation) {
      return { status: STATUS.UNSUPPORTED, detail: 'この端末・ブラウザは位置情報に対応していません。' };
    }
    return null;
  }

  const onPosition = (pos) => state.set(positionToState(pos, env.now()));
  const onError = (err) => state.set(errorToState(err));

  return {
    kind: KIND,
    read: state.read,
    subscribe: state.subscribe,

    // Start watching. Browsers may show the permission prompt here, so it is
    // best called from a button press.
    start() {
      const pre = precheck();
      if (pre) return state.set(pre);
      if (watchId === null) {
        watchId = env.navigator.geolocation.watchPosition(onPosition, onError, options);
        if (state.status !== STATUS.OK) {
          state.set({ status: STATUS.UNKNOWN, detail: '位置を問い合わせています。まだ値はありません。' });
        }
      }
      return state.read();
    },

    stop() {
      if (watchId !== null) {
        env.navigator.geolocation.clearWatch(watchId);
        watchId = null;
      }
    },

    // One-shot request. Resolves with a result (never rejects).
    locateOnce() {
      const pre = precheck();
      if (pre) return Promise.resolve(state.set(pre));
      return new Promise((resolve) => {
        env.navigator.geolocation.getCurrentPosition(
          (pos) => resolve(onPosition(pos)),
          (err) => resolve(onError(err)),
          options,
        );
      });
    },
  };
}
