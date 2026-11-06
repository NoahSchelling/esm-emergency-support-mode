// Device heading for the evacuation arrow.
//
// Turns raw orientation samples into "which way does the top of the
// screen point, in degrees clockwise from TRUE north", or refuses.
// Refusing is the normal, safe outcome: the caller must then not draw an
// arrow (a wrong arrow is worse than no arrow).
//
// Sources:
//  - iOS Safari: event.webkitCompassHeading (degrees from MAGNETIC north,
//    clockwise) and event.webkitCompassAccuracy (+/- degrees; negative
//    means the value is not usable / needs calibration).
//  - Chrome on Android: the "deviceorientationabsolute" event. alpha is the
//    rotation about the screen normal, counter-clockwise, 0 when the top of
//    the device points north. We treat that north as MAGNETIC north
//    (Android's rotation-vector frame); this must be checked on devices
//    (docs/proto/evac.md).
//  - A plain "deviceorientation" event without absolute=true and without
//    webkitCompassHeading is NOT referenced to north and is never used.
//
// No I/O and no platform APIs (loads in browsers and Node.js).

import { norm360, angleDiff, magneticToTrue } from './geo.js';

const RAD = Math.PI / 180;

export const HEADING_DEFAULTS = Object.freeze({
  maxAgeMs: 2000, // ！！仮の値！！ orientation older than this is stale
  maxCompassAccuracyDeg: 20, // ！！仮の値！！ iOS webkitCompassAccuracy limit
  maxTiltDeg: 60, // ！！仮の値！！ screen must be within this angle of facing up
  windowMs: 1000, // ！！仮の値！！ samples used for the stability check
  minSamples: 3, // ！！仮の値！！ samples needed inside the window
  maxSpreadDeg: 20, // ！！仮の値！！ largest allowed deviation from the mean
  maxSamples: 240, // memory bound for the tracker
});

export const BASIS = Object.freeze({
  IOS: 'ios_compass', // webkitCompassHeading
  ABSOLUTE: 'absolute_orientation', // deviceorientationabsolute / absolute=true
});

function num(v) {
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

// Copy the fields we need out of a DeviceOrientationEvent (or a plain
// object of the same shape) together with the event type and the time it
// was received.
export function sampleFromEvent(e, { type = e?.type ?? 'deviceorientation', atMs } = {}) {
  return Object.freeze({
    type,
    alpha: num(e?.alpha),
    beta: num(e?.beta),
    gamma: num(e?.gamma),
    absolute: e?.absolute === true,
    webkit_heading: num(e?.webkitCompassHeading),
    webkit_accuracy: num(e?.webkitCompassAccuracy),
    at_ms: atMs,
  });
}

// Screen rotation in degrees (0, 90, 180, 270), from screen.orientation.angle
// or the legacy window.orientation (iOS; may be -90). Returns null when it
// cannot be determined. `portraitHint` (innerHeight >= innerWidth) is used
// only to accept an implied 0 when no API exists and the page is portrait.
export function screenAngleFrom({ orientationAngle, windowOrientation, portraitHint } = {}) {
  const a = num(orientationAngle) ?? num(windowOrientation);
  if (a !== null) {
    const n = norm360(a);
    if ([0, 90, 180, 270].includes(n)) return n;
    return null;
  }
  return portraitHint === true ? 0 : null;
}

// Angle between the screen normal and straight up (0 = lying flat, face up).
export function tiltDeg(beta, gamma) {
  const c = Math.cos(beta * RAD) * Math.cos(gamma * RAD);
  return Math.acos(Math.max(-1, Math.min(1, c))) / RAD;
}

function refuse(status, detail) {
  return { status, value: null, detail };
}

// One sample -> heading of the top of the SCREEN from true north.
// ctx: { nowMs, screenAngleDeg, declinationWestDeg }
export function headingFromSample(sample, ctx, opts = HEADING_DEFAULTS) {
  const o = { ...HEADING_DEFAULTS, ...opts };
  if (!sample) return refuse('unknown', '端末の向きの値がまだありません。');
  if (!Number.isFinite(sample.at_ms) || !Number.isFinite(ctx?.nowMs)) {
    return refuse('error', '向きの値の時刻が分かりません。');
  }
  if (ctx.nowMs - sample.at_ms > o.maxAgeMs) {
    return refuse('stale', '端末の向きの値が更新されていません（古い値は使いません）。');
  }
  let magneticTop;
  let basis;
  let accuracy = null;
  if (sample.webkit_heading !== null) {
    basis = BASIS.IOS;
    accuracy = sample.webkit_accuracy;
    if (accuracy === null || accuracy < 0) {
      return refuse('unknown', 'コンパスの精度が分かりません。端末のコンパスの校正が必要な場合があります。');
    }
    if (accuracy > o.maxCompassAccuracyDeg) {
      return refuse('unknown', `コンパスの精度が悪いため（±${Math.round(accuracy)}度）、矢印を出しません。`);
    }
    magneticTop = sample.webkit_heading;
  } else if (sample.alpha !== null && (sample.absolute || sample.type === 'deviceorientationabsolute')) {
    basis = BASIS.ABSOLUTE;
    magneticTop = 360 - sample.alpha;
  } else {
    return refuse('unsupported', 'この端末・ブラウザからは、北を基準にした向きが得られません。');
  }
  if (sample.beta === null || sample.gamma === null) {
    return refuse('unknown', '端末の傾きが分からないため、向きを使いません。');
  }
  const tilt = tiltDeg(sample.beta, sample.gamma);
  if (tilt > o.maxTiltDeg) {
    return refuse('unknown', '端末が立っているため、向きを正しく求められません。画面を上に向けて、水平に近づけて持ってください。');
  }
  const screenAngle = ctx.screenAngleDeg;
  if (!Number.isFinite(screenAngle)) {
    return refuse('unknown', '画面の向き（縦・横）が分からないため、向きを使いません。');
  }
  const decl = ctx.declinationWestDeg;
  if (!Number.isFinite(decl)) {
    return refuse('unknown', '磁北と真北のずれ（偏角）が分からないため、向きを使いません。');
  }
  const magneticScreenUp = norm360(magneticTop + screenAngle);
  return {
    status: 'ok',
    value: {
      true_heading_deg: magneticToTrue(magneticScreenUp, decl),
      magnetic_heading_deg: magneticScreenUp,
      declination_west_deg: decl,
      screen_angle_deg: screenAngle,
      tilt_deg: tilt,
      accuracy_deg: accuracy,
      basis,
    },
    detail: basis === BASIS.IOS
      ? `端末のコンパスの向き（精度 ±${Math.round(accuracy)}度）を、磁北から真北に直して使っています。`
      : '端末の向き（北を基準にした値。精度は端末から得られません）を、磁北から真北に直して使っています。',
  };
}

// Circular mean of angles in degrees, and the largest deviation from it.
export function circularStats(angles) {
  let s = 0;
  let c = 0;
  for (const a of angles) {
    s += Math.sin(a * RAD);
    c += Math.cos(a * RAD);
  }
  const r = Math.hypot(s, c) / angles.length;
  if (angles.length === 0 || r < 1e-9) return { mean: null, spread: 180, r: 0 };
  const mean = norm360(Math.atan2(s, c) / RAD);
  let spread = 0;
  for (const a of angles) spread = Math.max(spread, Math.abs(angleDiff(a, mean)));
  return { mean, spread, r };
}

// Keeps recent samples and returns a heading only when the newest sample is
// usable AND the recent samples agree with each other.
export function createHeadingTracker(opts = {}) {
  const o = { ...HEADING_DEFAULTS, ...opts };
  let samples = [];
  return {
    push(sample) {
      if (!sample || !Number.isFinite(sample.at_ms)) return;
      samples.push(sample);
      if (samples.length > o.maxSamples) samples = samples.slice(-o.maxSamples);
    },
    clear() {
      samples = [];
    },
    get size() {
      return samples.length;
    },
    // ctx: { nowMs, screenAngleDeg, declinationWestDeg }
    read(ctx) {
      const latest = samples.length ? samples[samples.length - 1] : null;
      const head = headingFromSample(latest, ctx, o);
      if (head.status !== 'ok') return head;
      const recent = samples.filter((s) => ctx.nowMs - s.at_ms <= o.windowMs);
      const values = [];
      for (const s of recent) {
        const h = headingFromSample(s, ctx, o);
        if (h.status === 'ok') values.push(h.value.true_heading_deg);
      }
      if (values.length < o.minSamples) {
        return refuse('unknown', '端末の向きの値がそろうのを待っています。');
      }
      const st = circularStats(values);
      if (st.mean === null || st.spread > o.maxSpreadDeg) {
        return refuse('unknown', '端末の向きの値が安定していません（端末を回している、金属や磁石が近い、など）。');
      }
      return {
        status: 'ok',
        value: { ...head.value, true_heading_deg: st.mean, spread_deg: st.spread, sample_count: values.length },
        detail: head.detail,
      };
    },
  };
}

// GPS course over ground (Geolocation coords.heading / coords.speed).
export const COURSE_DEFAULTS = Object.freeze({
  minSpeedMps: 1.0, // ！！仮の値！！ below this the GPS course is not used
  maxAgeMs: 10000, // ！！仮の値！！
  maxMismatchDeg: 60, // ！！仮の値！！ compass vs GPS course disagreement
});

// course: { heading_deg, speed_mps, at_ms } -> usable course or a reason.
export function courseFrom(course, nowMs, opts = COURSE_DEFAULTS) {
  const o = { ...COURSE_DEFAULTS, ...opts };
  if (!course) return { usable: false, reason: 'GPS の進行方向の値がありません。' };
  const speed = num(course.speed_mps);
  const heading = num(course.heading_deg);
  if (!Number.isFinite(course.at_ms) || nowMs - course.at_ms > o.maxAgeMs) {
    return { usable: false, reason: 'GPS の進行方向の値が古くなっています。' };
  }
  if (speed === null || heading === null) return { usable: false, reason: 'GPS の進行方向の値がありません。' };
  if (speed < o.minSpeedMps) return { usable: false, reason: '止まっている、またはゆっくり動いているため、GPS の進行方向は使いません。' };
  return { usable: true, heading_deg: norm360(heading), speed_mps: speed };
}
