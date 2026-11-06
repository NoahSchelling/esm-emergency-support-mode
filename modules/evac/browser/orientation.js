// Browser-only wiring: orientation events -> heading tracker, and the
// current screen rotation. Nothing is sent anywhere.
//
// - iOS Safari: "deviceorientation" events carry webkitCompassHeading.
//   DeviceOrientationEvent.requestPermission() must be called directly from
//   a button's click handler (no await before it).
// - Chrome on Android: "deviceorientationabsolute" carries a north-referenced
//   alpha. Its plain "deviceorientation" events are NOT north-referenced and
//   are ignored once an absolute source exists.

import { sampleFromEvent, screenAngleFrom } from '../heading.js';

export function currentScreenAngle(w = globalThis) {
  return screenAngleFrom({
    orientationAngle: w.screen?.orientation?.angle,
    windowOrientation: typeof w.orientation === 'number' ? w.orientation : undefined,
    portraitHint: Number.isFinite(w.innerHeight) && Number.isFinite(w.innerWidth) ? w.innerHeight >= w.innerWidth : undefined,
  });
}

export function supportsAbsoluteOrientation(w = globalThis) {
  return 'ondeviceorientationabsolute' in w;
}

// Start listening. Returns { stop, get lastEventType }.
export function startOrientation(tracker, { w = globalThis, now = () => Date.now() } = {}) {
  const absolute = supportsAbsoluteOrientation(w);
  let lastType = null;
  const onAbs = (e) => {
    lastType = 'deviceorientationabsolute';
    tracker.push(sampleFromEvent(e, { type: 'deviceorientationabsolute', atMs: now() }));
  };
  const onRel = (e) => {
    const s = sampleFromEvent(e, { type: 'deviceorientation', atMs: now() });
    const northReferenced = s.webkit_heading !== null || s.absolute;
    // On Chrome for Android the relative stream would overwrite the absolute
    // one; keep it out unless it is north-referenced (iOS, or absolute=true).
    if (absolute && !northReferenced) return;
    lastType = 'deviceorientation';
    tracker.push(s);
  };
  if (absolute) w.addEventListener('deviceorientationabsolute', onAbs);
  w.addEventListener('deviceorientation', onRel);
  return {
    stop() {
      if (absolute) w.removeEventListener('deviceorientationabsolute', onAbs);
      w.removeEventListener('deviceorientation', onRel);
    },
    get lastEventType() {
      return lastType;
    },
    absoluteSupported: absolute,
  };
}

// iOS Safari permission. Call synchronously inside a click handler.
// Resolves to 'granted' | 'denied' | 'not_required' | 'unsupported' | 'error'.
export function requestOrientationPermission(w = globalThis) {
  const E = w.DeviceOrientationEvent;
  if (typeof E === 'undefined') return Promise.resolve('unsupported');
  if (typeof E.requestPermission !== 'function') return Promise.resolve('not_required');
  let p;
  try {
    p = E.requestPermission();
  } catch {
    return Promise.resolve('error');
  }
  return Promise.resolve(p).then((r) => (r === 'granted' ? 'granted' : r === 'denied' ? 'denied' : 'error'), () => 'error');
}
