// Orientation (DeviceOrientationEvent): alpha / beta / gamma in degrees,
// plus the compass heading that iOS Safari adds (webkitCompassHeading).

import { STATUS } from './result.js';
import { createSensorState, insecureDetail } from './state.js';
import { requestEventPermission } from './permission.js';
import { resolveEnv } from './env.js';

export const KIND = 'orientation';
export const PERMISSION_KIND = 'orientation_permission';

// ！！仮の値！！ seconds without an event before the value is stale.
export const DEFAULT_STALE_AFTER_SEC = 2;

function num(v) {
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

export function eventToValue(e) {
  return {
    alpha_deg: num(e.alpha),
    beta_deg: num(e.beta),
    gamma_deg: num(e.gamma),
    absolute: typeof e.absolute === 'boolean' ? e.absolute : null,
    compass_heading_deg: num(e.webkitCompassHeading),
    compass_accuracy_deg: num(e.webkitCompassAccuracy),
  };
}

export function createOrientationSensor({
  env,
  staleAfterSec = DEFAULT_STALE_AFTER_SEC,
  // "deviceorientationabsolute" is available on Chrome for Android.
  eventName = 'deviceorientation',
} = {}) {
  env = resolveEnv(env);
  const state = createSensorState({ kind: KIND, env, staleAfterSec });
  let listening = false;

  function precheck() {
    if (env.isSecureContext === false) return { status: STATUS.INSECURE, detail: insecureDetail('向きのセンサー') };
    if (typeof env.DeviceOrientationEvent === 'undefined' || !env.window) {
      return { status: STATUS.UNSUPPORTED, detail: 'この端末・ブラウザは向きのセンサー（DeviceOrientation）に対応していません。' };
    }
    return null;
  }

  function onOrientation(e) {
    const value = eventToValue(e);
    if (value.alpha_deg === null && value.beta_deg === null && value.gamma_deg === null) {
      state.set({
        status: STATUS.UNSUPPORTED,
        detail: '向きのイベントは届きましたが、値が空でした（この端末には向きのセンサーがないか、値を出していません）。',
      });
      return;
    }
    state.set({
      status: STATUS.OK,
      value,
      detail: value.absolute
        ? '端末が報告した向きです（地球を基準にした値）。'
        : '端末が報告した向きです（基準の向きは端末によって異なり、北を指すとは限りません）。',
    });
  }

  return {
    kind: KIND,
    read: state.read,
    subscribe: state.subscribe,

    // Call this directly from a button's click handler (iOS Safari).
    requestPermission() {
      return requestEventPermission({
        env,
        kind: PERMISSION_KIND,
        EventClass: env.DeviceOrientationEvent,
        what: '向きのセンサー',
      }).then((r) => {
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
        env.window.addEventListener(eventName, onOrientation);
        listening = true;
      }
      return state.read();
    },

    stop() {
      if (listening) {
        env.window.removeEventListener(eventName, onOrientation);
        listening = false;
      }
    },
  };
}
