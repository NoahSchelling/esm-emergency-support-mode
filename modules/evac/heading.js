// Device heading for the evacuation arrow.
//
// Turns raw orientation samples into "which way does the device point,
// in degrees clockwise from TRUE north", and turns a target bearing into
// the angle at which to draw the on-screen arrow -- or refuses.
// Refusing is the normal, safe outcome: the caller must then not draw an
// arrow (a wrong arrow is worse than no arrow).
//
// Sources:
//  - iOS Safari: event.webkitCompassHeading (degrees from MAGNETIC north,
//    clockwise) and event.webkitCompassAccuracy (+/- degrees; negative
//    means the value is not usable / needs calibration).
//  - Chrome on Android: the "deviceorientationabsolute" event. alpha is the
//    rotation about the vertical, counter-clockwise, 0 when the top of the
//    device points north. We treat that north as MAGNETIC north (Android's
//    rotation-vector frame); this must be checked on devices
//    (docs/proto/evac.md). Android gives no accuracy, so its heading is only
//    used for an arrow after it agreed with the GPS course (createCompassCheck).
//  - A plain "deviceorientation" event without absolute=true and without
//    webkitCompassHeading is NOT referenced to north and is never used.
//
// Geometry (W3C DeviceOrientation): device frame X = right edge, Y = top
// edge, Z = out of the screen. Device-to-earth rotation R = Rz(alpha)
// Rx(beta) Ry(gamma); earth frame x = east, y = north, z = up.
//
// No I/O and no platform APIs (loads in browsers and Node.js).

import { norm360, angleDiff, magneticToTrue } from './geo.js';

const RAD = Math.PI / 180;

export const HEADING_DEFAULTS = Object.freeze({
  maxAgeMs: 2000, // ！！仮の値！！ orientation older than this is stale
  maxFutureMs: 1000, // samples stamped later than now + this are refused
  maxCompassAccuracyDeg: 20, // ！！仮の値！！ iOS webkitCompassAccuracy limit
  maxTiltDeg: 45, // ！！仮の値！！ screen must be within this angle of facing up
  // ！！仮の値！！ Landscape is refused until the sign of the screen angle and
  // whether iOS already includes it are checked on real devices.
  allowLandscape: false,
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

// ------------------------------------------------------------ screen geometry
// Everything below works in the frame "F0": the earth frame turned about the
// vertical so that the device's top edge points to 0 deg. Turning about the
// vertical does not change tilt, so F0 needs only beta and gamma.

// Device axes expressed in F0 (east, north, up) for a given beta/gamma.
function deviceAxesF0(beta, gamma) {
  const sb = Math.sin(beta * RAD);
  const cb = Math.cos(beta * RAD);
  const sg = Math.sin(gamma * RAD);
  const cg = Math.cos(gamma * RAD);
  return {
    X: [cg, sb * sg, -cb * sg], // right edge
    Y: [0, cb, sb], // top edge
    Z: [sg, -sb * cg, cb * cg], // screen normal
  };
}

const neg = (v) => v.map((c) => -c);
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];

// The screen's "up" and "right" axes for a screen rotation angle.
// 90 = device turned 90 deg counter-clockwise (top edge to the left), so the
// device's right edge becomes screen-up.
function screenAxesF0(beta, gamma, screenAngle) {
  const { X, Y, Z } = deviceAxesF0(beta, gamma);
  switch (screenAngle) {
    case 0: return { U: Y, R: X, N: Z };
    case 90: return { U: X, R: neg(Y), N: Z };
    case 180: return { U: neg(Y), R: neg(X), N: Z };
    case 270: return { U: neg(X), R: Y, N: Z };
    default: return null;
  }
}

// Heading of the screen-up axis relative to the device's top edge (degrees),
// using its vertical projection onto the ground. 0 in portrait.
export function screenUpOffsetDeg(beta, gamma, screenAngle) {
  const ax = screenAxesF0(beta, gamma, screenAngle);
  if (!ax) return null;
  return norm360(Math.atan2(ax.U[0], ax.U[1]) / RAD);
}

// Angle (clockwise from screen-up) at which an arrow drawn ON THE SCREEN
// points, seen from above, to `bearingTrue`. The arrow lies in the tilted
// screen plane; we pick the screen vector whose vertical projection onto the
// ground has the target bearing. h: a heading value from this module.
export function screenArrowDeg(bearingTrue, h) {
  const ax = screenAxesF0(h.beta, h.gamma, h.screen_angle_deg);
  if (!ax || Math.abs(ax.N[2]) < 1e-6) return null;
  const b = (bearingTrue - h.top_true_heading_deg) * RAD; // bearing in F0
  const t = [Math.sin(b), Math.cos(b), 0];
  const lambda = -dot(t, ax.N) / ax.N[2];
  const s = [t[0], t[1], t[2] + lambda];
  return norm360(Math.atan2(dot(s, ax.R), dot(s, ax.U)) / RAD);
}

function refuse(status, detail) {
  return { status, value: null, detail };
}

// One sample -> heading of the device's top edge and of the screen-up axis,
// from true north. ctx: { nowMs, screenAngleDeg, declinationWestDeg }
export function headingFromSample(sample, ctx, opts = HEADING_DEFAULTS) {
  const o = { ...HEADING_DEFAULTS, ...opts };
  if (!sample) return refuse('unknown', '端末の向きの値がまだありません。');
  if (!Number.isFinite(sample.at_ms) || !Number.isFinite(ctx?.nowMs)) {
    return refuse('error', '向きの値の時刻が分かりません。');
  }
  if (ctx.nowMs - sample.at_ms > o.maxAgeMs) {
    return refuse('stale', '端末の向きの値が更新されていません（古い値は使いません）。');
  }
  if (sample.at_ms - ctx.nowMs > o.maxFutureMs) {
    return refuse('error', '向きの値の時刻が現在より先です。');
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
      return refuse('unknown', `コンパスの精度が悪いため（±${Math.round(accuracy)}度）、向きを使いません。`);
    }
    magneticTop = sample.webkit_heading;
  } else if (sample.alpha !== null && (sample.absolute || sample.type === 'deviceorientationabsolute')) {
    basis = BASIS.ABSOLUTE;
    // Heading of the top edge's ground projection is -alpha whenever the
    // top edge is not pointing below the horizon (cos(beta) > 0, ensured by
    // the tilt limit below).
    magneticTop = 360 - sample.alpha;
  } else {
    return refuse('unsupported', 'この端末・ブラウザからは、北を基準にした向きが得られません。');
  }
  if (sample.beta === null || sample.gamma === null) {
    return refuse('unknown', '端末の傾きが分からないため、向きを使いません。');
  }
  const tilt = tiltDeg(sample.beta, sample.gamma);
  if (tilt > o.maxTiltDeg) {
    return refuse('unknown', '端末が傾いている（立っている）ため、向きを正しく求められません。画面を上に向けて、水平に近づけて持ってください。');
  }
  const screenAngle = ctx.screenAngleDeg;
  if (!Number.isFinite(screenAngle) || ![0, 90, 180, 270].includes(screenAngle)) {
    return refuse('unknown', '画面の向き（縦・横）が分からないため、向きを使いません。');
  }
  if (screenAngle !== 0 && !o.allowLandscape) {
    return refuse('unknown', '画面が横向き（または上下逆）のため、矢印を出しません。縦向きで持ってください。');
  }
  const decl = ctx.declinationWestDeg;
  if (!Number.isFinite(decl)) {
    return refuse('unknown', '磁北と真北のずれ（偏角）が分からないため、向きを使いません。');
  }
  const topTrue = magneticToTrue(magneticTop, decl);
  const offset = screenUpOffsetDeg(sample.beta, sample.gamma, screenAngle);
  return {
    status: 'ok',
    value: {
      top_true_heading_deg: topTrue,
      true_heading_deg: norm360(topTrue + offset), // screen-up, projected
      beta: sample.beta,
      gamma: sample.gamma,
      screen_angle_deg: screenAngle,
      tilt_deg: tilt,
      accuracy_deg: accuracy,
      basis,
      at_ms: sample.at_ms,
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
  const r = angles.length ? Math.hypot(s, c) / angles.length : 0;
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
    // The latest sample alone, without the stability check of read(). For
    // drawing only: the screen turns an already accepted figure with it
    // between two read() decisions. Never use it to decide whether to show
    // an arrow.
    latest(ctx) {
      return headingFromSample(samples.length ? samples[samples.length - 1] : null, ctx, o);
    },
    // ctx: { nowMs, screenAngleDeg, declinationWestDeg }
    read(ctx) {
      const latest = samples.length ? samples[samples.length - 1] : null;
      const head = headingFromSample(latest, ctx, o);
      if (head.status !== 'ok') return head;
      const recent = samples.filter((s) => ctx.nowMs - s.at_ms <= o.windowMs);
      const values = [];
      let mixed = false;
      for (const s of recent) {
        const h = headingFromSample(s, ctx, o);
        if (h.status !== 'ok') continue;
        if (h.value.basis !== head.value.basis) mixed = true;
        values.push(h.value.top_true_heading_deg);
      }
      if (values.length < o.minSamples) {
        return refuse('unknown', '端末の向きの値がそろうのを待っています。');
      }
      const st = circularStats(values);
      if (mixed || st.mean === null || st.spread > o.maxSpreadDeg) {
        return refuse('unknown', '端末の向きの値が安定していません（端末を回している、金属や磁石が近い、など）。');
      }
      const offset = screenUpOffsetDeg(head.value.beta, head.value.gamma, head.value.screen_angle_deg);
      return {
        status: 'ok',
        value: {
          ...head.value,
          top_true_heading_deg: st.mean,
          true_heading_deg: norm360(st.mean + offset),
          spread_deg: st.spread,
          sample_count: values.length,
        },
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
  if (!Number.isFinite(course.at_ms) || nowMs - course.at_ms > o.maxAgeMs || course.at_ms - nowMs > 1000) {
    return { usable: false, reason: 'GPS の進行方向の値が古くなっています。' };
  }
  if (speed === null || heading === null) return { usable: false, reason: 'GPS の進行方向の値がありません。' };
  if (speed < o.minSpeedMps) return { usable: false, reason: '止まっている、またはゆっくり動いているため、GPS の進行方向は使いません。' };
  return { usable: true, heading_deg: norm360(heading), speed_mps: speed };
}

// Compass check against the GPS course, for headings without an accuracy
// value (Android). While walking with the device top forward, the heading
// should match the course; a recent match "confirms" the compass for a
// while. A large disagreement clears the confirmation at once.
export const CONFIRM_DEFAULTS = Object.freeze({
  matchDeg: 20, // ！！仮の値！！ heading within this of the course = match
  validMs: 20000, // ！！仮の値！！ how long a match keeps the compass confirmed
});

export function createCompassCheck(opts = {}) {
  const o = { ...CONFIRM_DEFAULTS, ...COURSE_DEFAULTS, ...opts };
  let confirmedAt = null;
  return {
    // heading: tracker.read() result; course: courseFrom() result.
    update(heading, course, nowMs) {
      // A gap in the heading stream clears the confirmation: the bias may
      // have changed while we could not see it.
      if (heading?.status !== 'ok') {
        confirmedAt = null;
        return;
      }
      if (!course?.usable) return;
      const d = Math.abs(angleDiff(heading.value.top_true_heading_deg, course.heading_deg));
      confirmedAt = d <= o.matchDeg ? nowMs : null;
    },
    reset() {
      confirmedAt = null;
    },
    get confirmedAtMs() {
      return confirmedAt;
    },
  };
}
