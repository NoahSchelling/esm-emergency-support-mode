// Online / offline (navigator.onLine and the "online"/"offline" events).
// navigator.onLine === true only means the device has some network link;
// it does not mean public information sources are reachable.

import { STATUS } from './result.js';
import { createSensorState, insecureDetail } from './state.js';
import { resolveEnv } from './env.js';

export const KIND = 'online';

// ！！仮の値！！ read() samples navigator.onLine every time, so this only
// matters if read() cannot sample (it normally never becomes stale).
export const DEFAULT_STALE_AFTER_SEC = 60;

const ONLINE_DETAIL =
  '端末はネットワークにつながっていると報告しています（インターネットや公的な情報源に届くとは限りません）。';
const OFFLINE_DETAIL = '端末はネットワークにつながっていないと報告しています。';

export function createOnlineSensor({ env, staleAfterSec = DEFAULT_STALE_AFTER_SEC } = {}) {
  env = resolveEnv(env);
  const state = createSensorState({ kind: KIND, env, staleAfterSec });
  let listening = false;

  function precheck() {
    if (env.isSecureContext === false) return { status: STATUS.INSECURE, detail: insecureDetail('通信の状態') };
    if (typeof env.navigator?.onLine !== 'boolean') {
      return { status: STATUS.UNSUPPORTED, detail: 'この端末・ブラウザは通信の有無を報告しません。' };
    }
    return null;
  }

  function sample() {
    const pre = precheck();
    if (pre) return pre;
    const online = env.navigator.onLine;
    return { status: STATUS.OK, value: { online }, detail: online ? ONLINE_DETAIL : OFFLINE_DETAIL };
  }

  const onChange = () => state.set(sample());

  return {
    kind: KIND,
    read() {
      // Sample on every read so the answer is current.
      return state.set(sample(), { notify: false });
    },
    subscribe: state.subscribe,
    start() {
      const r = state.set(sample());
      if (r.status === STATUS.OK && env.window && !listening) {
        env.window.addEventListener('online', onChange);
        env.window.addEventListener('offline', onChange);
        listening = true;
      }
      return r;
    },
    stop() {
      if (listening) {
        env.window.removeEventListener('online', onChange);
        env.window.removeEventListener('offline', onChange);
        listening = false;
      }
    },
  };
}
