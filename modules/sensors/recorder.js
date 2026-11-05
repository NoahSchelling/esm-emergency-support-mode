// Record raw sensor events from an environment into the replay format
// (see replay.js), so values captured on a real phone can be replayed in
// tests. The recording stays in memory; this module never sends it anywhere.
//
// Location is NOT recorded unless includeLocation is true, because a real
// position is personal information. Never commit a recording that contains a
// real position; replace it with fictional coordinates first.

import { RECORDING_FORMAT } from './replay.js';
import { toIsoWithOffset } from './result.js';
import { resolveEnv } from './env.js';

// ！！仮の値！！ upper bound on recorded events (devicemotion fires ~60 times a second).
export const DEFAULT_MAX_EVENTS = 20000;

function pick(obj, keys) {
  if (!obj) return null;
  const out = {};
  for (const k of keys) {
    const v = obj[k];
    out[k] = typeof v === 'number' && !Number.isFinite(v) ? null : (v ?? null);
  }
  return out;
}

const XYZ = ['x', 'y', 'z'];
const ABG = ['alpha', 'beta', 'gamma'];
const CONN = ['type', 'effectiveType', 'downlink', 'rtt', 'saveData'];
const BATT = ['level', 'charging', 'chargingTime', 'dischargingTime'];

export function createRecorder({ env, includeLocation = false, maxEvents = DEFAULT_MAX_EVENTS, description = '' } = {}) {
  env = resolveEnv(env);
  const startMs = env.now();
  const events = [];
  const cleanups = [];
  let truncated = false;
  let stopped = false;

  const push = (type, data) => {
    if (stopped) return;
    if (events.length >= maxEvents) {
      truncated = true;
      return;
    }
    events.push({ t_ms: env.now() - startMs, type, ...(data === undefined ? {} : { data }) });
  };
  const listen = (target, type, fn) => {
    target.addEventListener(type, fn);
    cleanups.push(() => target.removeEventListener(type, fn));
  };

  const nav = env.navigator ?? {};
  const environment = {
    secure: env.isSecureContext !== false,
    geolocation: includeLocation && Boolean(nav.geolocation),
    geolocation_permission: 'granted',
    motion: typeof env.DeviceMotionEvent !== 'undefined',
    motion_permission: typeof env.DeviceMotionEvent?.requestPermission === 'function' ? 'granted' : 'not_required',
    orientation: typeof env.DeviceOrientationEvent !== 'undefined',
    orientation_permission:
      typeof env.DeviceOrientationEvent?.requestPermission === 'function' ? 'granted' : 'not_required',
    online: typeof nav.onLine === 'boolean' ? nav.onLine : null,
    connection: nav.connection ? pick(nav.connection, CONN) : null,
    battery: null,
  };

  if (env.window) {
    listen(env.window, 'devicemotion', (e) =>
      push('devicemotion', {
        acceleration: pick(e.acceleration, XYZ),
        accelerationIncludingGravity: pick(e.accelerationIncludingGravity, XYZ),
        rotationRate: pick(e.rotationRate, ABG),
        interval: e.interval ?? null,
      }),
    );
    listen(env.window, 'deviceorientation', (e) =>
      push('deviceorientation', pick(e, ['alpha', 'beta', 'gamma', 'absolute', 'webkitCompassHeading', 'webkitCompassAccuracy'])),
    );
    listen(env.window, 'online', () => push('online'));
    listen(env.window, 'offline', () => push('offline'));
  }
  if (nav.connection?.addEventListener) {
    listen(nav.connection, 'change', () => push('connection', pick(nav.connection, CONN)));
  }
  let batteryReady = Promise.resolve();
  if (typeof nav.getBattery === 'function') {
    batteryReady = Promise.resolve()
      .then(() => nav.getBattery())
      .then((b) => {
        if (stopped || !b) return;
        environment.battery = pick(b, BATT);
        for (const ev of ['levelchange', 'chargingchange']) listen(b, ev, () => push('battery', pick(b, BATT)));
      })
      .catch(() => {});
  }
  if (environment.geolocation) {
    const id = nav.geolocation.watchPosition(
      (pos) => push('position', pick(pos.coords, ['latitude', 'longitude', 'accuracy', 'altitude', 'altitudeAccuracy', 'heading', 'speed'])),
      (err) => push('position_error', { code: err.code, message: err.message ?? '' }),
    );
    cleanups.push(() => nav.geolocation.clearWatch(id));
  }

  return {
    ready: batteryReady,
    get eventCount() {
      return events.length;
    },
    stop() {
      if (!stopped) {
        stopped = true;
        for (const c of cleanups.splice(0)) c();
      }
      return {
        format: RECORDING_FORMAT,
        description:
          description +
          (truncated ? `（上限 ${maxEvents} 件で打ち切り）` : '') +
          (includeLocation ? '【実際の位置を含む可能性あり。リポジトリに入れない】' : ''),
        start_time: toIsoWithOffset(startMs),
        environment,
        events: structuredClone(events),
      };
    },
  };
}
