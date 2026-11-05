// The "environment" a sensor talks to. Sensors never touch browser globals
// directly; they use this object, so tests can swap in a replay environment
// (see replay.js) and the modules load in Node.js without a DOM.

export function createDeviceEnv(g = globalThis) {
  return {
    source: 'device',
    now: () => Date.now(),
    // undefined outside browsers; only an explicit false means "not HTTPS".
    get isSecureContext() {
      return g.isSecureContext;
    },
    get navigator() {
      return g.navigator;
    },
    get window() {
      return typeof g.addEventListener === 'function' ? g : null;
    },
    get DeviceMotionEvent() {
      return g.DeviceMotionEvent;
    },
    get DeviceOrientationEvent() {
      return g.DeviceOrientationEvent;
    },
  };
}

export function resolveEnv(env) {
  return env ?? createDeviceEnv();
}
