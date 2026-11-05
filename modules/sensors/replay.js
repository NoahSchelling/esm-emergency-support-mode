// Replay a recorded sequence of sensor events through a fake environment.
// Every result produced from this environment has source "simulated".
// Works in Node.js (manual clock, for tests) and in browsers (real-time play).
//
// Recording format ("sensor-recording/1"):
// {
//   "format": "sensor-recording/1",
//   "description": "...",
//   "start_time": "2026-11-05T10:00:00+09:00",
//   "environment": {
//     "secure": true,                         // isSecureContext
//     "geolocation": true,                    // navigator.geolocation exists
//     "geolocation_permission": "granted",    // "granted" | "denied"
//     "motion": true, "motion_permission": "not_required",       // or "granted" | "denied"
//     "orientation": true, "orientation_permission": "not_required",
//     "online": true,                         // initial navigator.onLine (null = missing)
//     "connection": { "type": "wifi", ... },  // initial navigator.connection (null = missing)
//     "battery": { "level": 0.8, ... }        // initial battery (null = no getBattery)
//   },
//   "events": [ { "t_ms": 0, "type": "position", "data": {...} }, ... ]
// }
// Event types: position, position_error, devicemotion, deviceorientation,
// online, offline, connection, battery.

export const RECORDING_FORMAT = 'sensor-recording/1';

class FakeEventTarget {
  constructor() {
    this._listeners = new Map();
  }
  addEventListener(type, fn) {
    if (!this._listeners.has(type)) this._listeners.set(type, new Set());
    this._listeners.get(type).add(fn);
  }
  removeEventListener(type, fn) {
    this._listeners.get(type)?.delete(fn);
  }
  dispatchEvent(event) {
    for (const fn of [...(this._listeners.get(event.type) ?? [])]) fn.call(this, event);
    return true;
  }
  listenerCount(type) {
    return this._listeners.get(type)?.size ?? 0;
  }
}

export function createManualClock(startMs = 0) {
  let t = startMs;
  return {
    now: () => t,
    set(ms) {
      t = ms;
    },
    advance(ms) {
      t += ms;
    },
  };
}

function parseStart(recording) {
  const ms = Date.parse(recording.start_time ?? '');
  if (!Number.isFinite(ms)) throw new TypeError('recording.start_time must be an ISO 8601 time');
  return ms;
}

export function validateRecording(recording) {
  if (!recording || recording.format !== RECORDING_FORMAT) {
    throw new TypeError(`recording.format must be "${RECORDING_FORMAT}"`);
  }
  parseStart(recording);
  if (!Array.isArray(recording.events)) throw new TypeError('recording.events must be an array');
  let prev = -Infinity;
  for (const [i, ev] of recording.events.entries()) {
    if (!Number.isFinite(ev.t_ms) || ev.t_ms < prev) {
      throw new TypeError(`events[${i}].t_ms must be a number in ascending order`);
    }
    prev = ev.t_ms;
  }
  return recording;
}

function makePermissionFn(initial) {
  // Mimics iOS Safari: requestPermission exists and must be granted before
  // events arrive. "not_required" means the function does not exist.
  if (!initial || initial === 'not_required') return { fn: undefined, granted: () => true };
  let state = initial === 'prompt' ? 'prompt' : initial;
  return {
    fn: () => {
      if (state === 'prompt') state = 'granted';
      return Promise.resolve(state);
    },
    granted: () => state === 'granted',
  };
}

function makeGeolocation(clock, permission) {
  const watchers = new Map();
  let nextId = 1;
  let lastPosition = null;
  const pendingOnce = [];

  function toPosition(data) {
    return {
      coords: {
        latitude: data.latitude,
        longitude: data.longitude,
        accuracy: data.accuracy,
        altitude: data.altitude ?? null,
        altitudeAccuracy: data.altitudeAccuracy ?? null,
        heading: data.heading ?? null,
        speed: data.speed ?? null,
      },
      timestamp: clock.now(),
    };
  }
  function deniedError() {
    return { code: 1, message: 'User denied Geolocation (simulated)', PERMISSION_DENIED: 1 };
  }

  const geolocation = {
    watchPosition(success, error) {
      const id = nextId++;
      watchers.set(id, { success, error });
      if (permission === 'denied') queueMicrotask(() => error?.(deniedError()));
      return id;
    },
    clearWatch(id) {
      watchers.delete(id);
    },
    getCurrentPosition(success, error) {
      if (permission === 'denied') {
        queueMicrotask(() => error?.(deniedError()));
      } else if (lastPosition) {
        const p = lastPosition;
        queueMicrotask(() => success(p));
      } else {
        pendingOnce.push({ success, error });
      }
    },
  };

  function deliverPosition(data) {
    if (permission === 'denied') return;
    lastPosition = toPosition(data);
    for (const w of [...watchers.values()]) w.success(lastPosition);
    for (const p of pendingOnce.splice(0)) p.success(lastPosition);
  }
  function deliverError(data) {
    const err = { code: data.code, message: data.message ?? '' };
    for (const w of [...watchers.values()]) w.error?.(err);
    for (const p of pendingOnce.splice(0)) p.error?.(err);
  }
  return { geolocation, deliverPosition, deliverError, watcherCount: () => watchers.size };
}

function makeConnection(initial) {
  const conn = new FakeEventTarget();
  Object.assign(conn, initial);
  return conn;
}

function makeBattery(initial) {
  const battery = new FakeEventTarget();
  Object.assign(battery, normalizeBattery(initial));
  return battery;
}

function normalizeBattery(data) {
  // JSON cannot hold Infinity; null in a recording means Infinity here.
  const out = { ...data };
  for (const k of ['chargingTime', 'dischargingTime']) {
    if (k in out && out[k] === null) out[k] = Infinity;
  }
  return out;
}

export function createReplayEnv(recording, { clock } = {}) {
  validateRecording(recording);
  const envCfg = recording.environment ?? {};
  const startMs = parseStart(recording);
  const clk = clock ?? createManualClock(startMs);

  const win = new FakeEventTarget();
  const navigator = {};
  const motionPerm = makePermissionFn(envCfg.motion_permission);
  const orientPerm = makePermissionFn(envCfg.orientation_permission);

  if (envCfg.online !== null && envCfg.online !== undefined) navigator.onLine = Boolean(envCfg.online);

  let geo = null;
  if (envCfg.geolocation) {
    geo = makeGeolocation(clk, envCfg.geolocation_permission ?? 'granted');
    navigator.geolocation = geo.geolocation;
  }
  let connection = null;
  if (envCfg.connection) {
    connection = makeConnection(envCfg.connection);
    navigator.connection = connection;
  }
  let battery = null;
  if (envCfg.battery) {
    battery = makeBattery(envCfg.battery);
    navigator.getBattery = () => Promise.resolve(battery);
  }

  let DeviceMotionEvent;
  if (envCfg.motion) {
    DeviceMotionEvent = function DeviceMotionEvent() {};
    if (motionPerm.fn) DeviceMotionEvent.requestPermission = motionPerm.fn;
  }
  let DeviceOrientationEvent;
  if (envCfg.orientation) {
    DeviceOrientationEvent = function DeviceOrientationEvent() {};
    if (orientPerm.fn) DeviceOrientationEvent.requestPermission = orientPerm.fn;
  }

  const env = {
    source: 'simulated',
    now: () => clk.now(),
    isSecureContext: envCfg.secure !== false,
    navigator,
    window: win,
    DeviceMotionEvent,
    DeviceOrientationEvent,
  };

  function dispatch(ev) {
    const d = ev.data ?? {};
    switch (ev.type) {
      case 'position':
        geo?.deliverPosition(d);
        break;
      case 'position_error':
        geo?.deliverError(d);
        break;
      case 'devicemotion':
        if (envCfg.motion && motionPerm.granted()) {
          win.dispatchEvent({
            type: 'devicemotion',
            acceleration: d.acceleration ?? null,
            accelerationIncludingGravity: d.accelerationIncludingGravity ?? null,
            rotationRate: d.rotationRate ?? null,
            interval: d.interval ?? null,
          });
        }
        break;
      case 'deviceorientation':
        if (envCfg.orientation && orientPerm.granted()) {
          win.dispatchEvent({ type: 'deviceorientation', ...d });
        }
        break;
      case 'online':
      case 'offline':
        if ('onLine' in navigator) navigator.onLine = ev.type === 'online';
        win.dispatchEvent({ type: ev.type });
        break;
      case 'connection':
        if (connection) {
          Object.assign(connection, d);
          connection.dispatchEvent({ type: 'change' });
        }
        break;
      case 'battery':
        if (battery) {
          const before = { level: battery.level, charging: battery.charging };
          Object.assign(battery, normalizeBattery(d));
          if (battery.level !== before.level) battery.dispatchEvent({ type: 'levelchange' });
          if (battery.charging !== before.charging) battery.dispatchEvent({ type: 'chargingchange' });
          if ('chargingTime' in d) battery.dispatchEvent({ type: 'chargingtimechange' });
          if ('dischargingTime' in d) battery.dispatchEvent({ type: 'dischargingtimechange' });
        }
        break;
      default:
        throw new TypeError(`unknown event type: ${ev.type}`);
    }
  }

  return { env, clock: clk, startMs, dispatch, _internals: { win, geo, connection, battery } };
}

// Step through a recording. With the default manual clock, nothing happens
// until advanceTo/advanceBy is called, which makes tests deterministic.
export function createReplayPlayer(recording, options = {}) {
  const replay = createReplayEnv(recording, options);
  const events = recording.events;
  let index = 0;
  let elapsed = 0;

  function advanceTo(targetElapsedMs) {
    if (targetElapsedMs < elapsed) throw new RangeError('cannot go back in time');
    while (index < events.length && events[index].t_ms <= targetElapsedMs) {
      const ev = events[index++];
      replay.clock.set(replay.startMs + ev.t_ms);
      replay.dispatch(ev);
    }
    elapsed = targetElapsedMs;
    replay.clock.set(replay.startMs + elapsed);
  }

  return {
    env: replay.env,
    clock: replay.clock,
    get elapsedMs() {
      return elapsed;
    },
    get finished() {
      return index >= events.length;
    },
    get durationMs() {
      return events.length ? events[events.length - 1].t_ms : 0;
    },
    advanceTo,
    advanceBy(ms) {
      advanceTo(elapsed + ms);
    },
    // Real-time playback (browsers). Returns a stop function.
    playRealtime({ speed = 1, tickMs = 50, onTick } = {}) {
      const wallStart = Date.now() - elapsed / speed;
      const timer = setInterval(() => {
        advanceTo(Math.max(elapsed, (Date.now() - wallStart) * speed));
        onTick?.(elapsed);
      }, tickMs);
      return () => clearInterval(timer);
    },
    _internals: replay._internals,
  };
}
