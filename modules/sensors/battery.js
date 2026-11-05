// Battery (Battery Status API: navigator.getBattery()).
// Not available on iOS Safari or Firefox -> "unsupported".

import { STATUS } from './result.js';
import { createSensorState, insecureDetail } from './state.js';
import { resolveEnv } from './env.js';

export const KIND = 'battery';

// ！！仮の値！！ read() samples the live BatteryManager, so this normally never triggers.
export const DEFAULT_STALE_AFTER_SEC = 120;

const EVENTS = ['levelchange', 'chargingchange', 'chargingtimechange', 'dischargingtimechange'];

function secOrNull(v) {
  // The API uses Infinity for "unknown / not applicable".
  return typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : null;
}

export function batteryToState(b) {
  const level = b?.level;
  if (typeof level !== 'number' || !Number.isFinite(level) || level < 0 || level > 1) {
    return { status: STATUS.ERROR, detail: '受け取った電池の値が不正でした。' };
  }
  const charging = typeof b.charging === 'boolean' ? b.charging : null;
  return {
    status: STATUS.OK,
    value: {
      level,
      level_percent: Math.round(level * 100),
      charging,
      charging_time_sec: secOrNull(b.chargingTime),
      discharging_time_sec: secOrNull(b.dischargingTime),
    },
    detail: '端末が報告した電池の残りです。残り時間はブラウザの推定で、分からないときは null です。',
  };
}

export function createBatterySensor({ env, staleAfterSec = DEFAULT_STALE_AFTER_SEC } = {}) {
  env = resolveEnv(env);
  const state = createSensorState({ kind: KIND, env, staleAfterSec });
  let manager = null;
  let starting = null;

  const onChange = () => state.set(batteryToState(manager));

  function precheck() {
    if (env.isSecureContext === false) return { status: STATUS.INSECURE, detail: insecureDetail('電池の情報') };
    if (typeof env.navigator?.getBattery !== 'function') {
      return { status: STATUS.UNSUPPORTED, detail: 'この端末・ブラウザは電池の情報を報告しません（iPhone の Safari など）。' };
    }
    return null;
  }

  return {
    kind: KIND,
    read() {
      if (manager) return state.set(batteryToState(manager), { notify: false });
      return state.read();
    },
    subscribe: state.subscribe,

    // Resolves with a result (never rejects).
    start() {
      const pre = precheck();
      if (pre) return Promise.resolve(state.set(pre));
      if (manager) return Promise.resolve(state.read());
      if (starting) return starting;
      state.set({ status: STATUS.UNKNOWN, detail: '電池の情報を問い合わせています。まだ値はありません。' });
      let pending;
      try {
        pending = Promise.resolve(env.navigator.getBattery());
      } catch (err) {
        pending = Promise.reject(err);
      }
      starting = pending.then(
        (b) => {
          manager = b;
          if (typeof b?.addEventListener === 'function') {
            for (const ev of EVENTS) b.addEventListener(ev, onChange);
          }
          starting = null;
          return state.set(batteryToState(b));
        },
        (err) => {
          starting = null;
          if (err?.name === 'NotAllowedError' || err?.name === 'SecurityError') {
            return state.set({ status: STATUS.DENIED, detail: 'この画面では電池の情報の利用が許されていません。' });
          }
          return state.set({ status: STATUS.ERROR, detail: '電池の情報を取得できませんでした。' });
        },
      );
      return starting;
    },

    stop() {
      if (manager && typeof manager.removeEventListener === 'function') {
        for (const ev of EVENTS) manager.removeEventListener(ev, onChange);
      }
      manager = null;
    },
  };
}
