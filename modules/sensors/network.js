// Connection type (Network Information API: navigator.connection).
// Not available on iOS Safari or Firefox -> "unsupported".
// effectiveType is the browser's estimate of speed, not the actual
// connection technology.

import { STATUS } from './result.js';
import { createSensorState, insecureDetail } from './state.js';
import { resolveEnv } from './env.js';

export const KIND = 'network';

// ！！仮の値！！ read() samples the live object, so this normally never triggers.
export const DEFAULT_STALE_AFTER_SEC = 60;

function str(v) {
  return typeof v === 'string' && v !== '' ? v : null;
}
function num(v) {
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

export function connectionToValue(c) {
  return {
    type: str(c.type),
    effective_type: str(c.effectiveType),
    downlink_mbps: num(c.downlink),
    rtt_ms: num(c.rtt),
    save_data: typeof c.saveData === 'boolean' ? c.saveData : null,
  };
}

export function createNetworkSensor({ env, staleAfterSec = DEFAULT_STALE_AFTER_SEC } = {}) {
  env = resolveEnv(env);
  const state = createSensorState({ kind: KIND, env, staleAfterSec });
  let listeningOn = null;

  const conn = () => env.navigator?.connection ?? env.navigator?.mozConnection ?? env.navigator?.webkitConnection;

  function sample() {
    if (env.isSecureContext === false) return { status: STATUS.INSECURE, detail: insecureDetail('通信の種類') };
    const c = conn();
    if (!c) {
      return { status: STATUS.UNSUPPORTED, detail: 'この端末・ブラウザは通信の種類を報告しません（iPhone の Safari など）。' };
    }
    const value = connectionToValue(c);
    if (value.type === null && value.effective_type === null) {
      return { status: STATUS.UNSUPPORTED, detail: 'この端末・ブラウザは通信の種類の値を出していません。' };
    }
    const parts = [];
    if (value.type === null) parts.push('接続の種類（Wi-Fi・携帯回線など）は報告されていません。');
    if (value.effective_type !== null) parts.push('速さの目安（effective_type）はブラウザの推定で、実際の回線の種類ではありません。');
    return { status: STATUS.OK, value, detail: ['ブラウザが報告した通信の種類です。', ...parts].join('') };
  }

  const onChange = () => state.set(sample());

  return {
    kind: KIND,
    read() {
      return state.set(sample(), { notify: false });
    },
    subscribe: state.subscribe,
    start() {
      const r = state.set(sample());
      const c = conn();
      if (r.status === STATUS.OK && typeof c?.addEventListener === 'function' && !listeningOn) {
        c.addEventListener('change', onChange);
        listeningOn = c;
      }
      return r;
    },
    stop() {
      if (listeningOn) {
        listeningOn.removeEventListener('change', onChange);
        listeningOn = null;
      }
    },
  };
}
