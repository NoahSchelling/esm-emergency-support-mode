// Tests for bearings, declination and device heading.
// Run: node --test 'modules/evac/test/*.test.js'
// Positions are fictional round-number points or approximate positions of
// public buildings. No personal locations.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  norm360, angleDiff, bearingDeg, distanceM, compassName, declinationWestDeg, magneticToTrue,
  headingFromSample, sampleFromEvent, screenAngleFrom, tiltDeg, createHeadingTracker, circularStats,
  courseFrom, BASIS, screenArrowDeg, screenUpOffsetDeg,
} from '../index.js';
import { startOrientation, currentScreenAngle, requestOrientationPermission } from '../browser/orientation.js';

const close = (a, b, eps, msg) => assert.ok(Math.abs(a - b) <= eps, `${msg ?? ''} expected ${b} got ${a}`);
// Fictional round-number point.
const P = [35.0, 138.0];

test('bearing: north, east, south, west', () => {
  close(bearingDeg(...P, 35.01, 138.0), 0, 1e-9, 'N');
  close(bearingDeg(...P, 35.0, 138.01), 90, 0.01, 'E');
  close(bearingDeg(...P, 34.99, 138.0), 180, 1e-9, 'S');
  close(bearingDeg(...P, 35.0, 137.99), 270, 0.01, 'W');
  close(bearingDeg(...P, 35.01, 138.0122), 45, 0.5, 'NE');
  // just west of north: must be close to 360, reported in [0, 360)
  const b = bearingDeg(...P, 35.01, 137.9999);
  assert.ok(b > 359 && b < 360, String(b));
});

test('distance: 0.01 degree of latitude is about 1.11 km', () => {
  close(distanceM(...P, 35.01, 138.0), 1111.95, 1);
  assert.equal(distanceM(...P, ...P), 0);
});

test('angles: 0/360 boundary', () => {
  assert.equal(norm360(360), 0);
  assert.equal(norm360(720), 0);
  assert.equal(norm360(-90), 270);
  assert.equal(Object.is(norm360(-0), 0), true);
  close(norm360(-0.5), 359.5, 1e-9);
  assert.equal(angleDiff(359, 1), -2);
  assert.equal(angleDiff(1, 359), 2);
  assert.equal(angleDiff(180, 0), 180);
  assert.equal(angleDiff(0, 180), 180);
  assert.equal(compassName(359), '北');
  assert.equal(compassName(11.2), '北');
  assert.equal(compassName(11.3), '北北東');
  assert.equal(compassName(180), '南');
  assert.equal(compassName(270), '西');
});

test('declination: reproduces the GSI worked example (Tokyo, 7°36.5\' west)', () => {
  // Example on the GSI page: φ = 35.68, λ = 139.70 -> 7°36.5'
  close(declinationWestDeg(35.68, 139.70), 7 + 36.5 / 60, 0.01);
  // Shizuoka prefectural office (approximate position): about 7.4 deg west
  const d = declinationWestDeg(34.9769, 138.3831);
  assert.ok(d > 7 && d < 8, String(d));
  assert.equal(declinationWestDeg(0, 0), null);
  assert.equal(declinationWestDeg(NaN, 138), null);
});

test('declination: magnetic -> true subtracts a west declination', () => {
  close(magneticToTrue(0, 7.5), 352.5, 1e-9);
  close(magneticToTrue(90, 7.5), 82.5, 1e-9);
  close(magneticToTrue(5, 7.5), 357.5, 1e-9);
});

const NOW = 1_000_000;
const CTX = { nowMs: NOW, screenAngleDeg: 0, declinationWestDeg: 7.5 };
const ios = (h, acc = 10, extra = {}) => ({ type: 'deviceorientation', alpha: 10, beta: 20, gamma: 0, absolute: false, webkit_heading: h, webkit_accuracy: acc, at_ms: NOW, ...extra });
const abs = (alpha, extra = {}) => ({ type: 'deviceorientationabsolute', alpha, beta: 20, gamma: 0, absolute: true, webkit_heading: null, webkit_accuracy: null, at_ms: NOW, ...extra });

test('heading: iOS webkitCompassHeading, corrected to true north', () => {
  const r = headingFromSample(ios(90), CTX);
  assert.equal(r.status, 'ok');
  assert.equal(r.value.basis, BASIS.IOS);
  close(r.value.true_heading_deg, 82.5, 1e-9);
  close(headingFromSample(ios(0), CTX).value.true_heading_deg, 352.5, 1e-9);
  close(headingFromSample(ios(359), CTX).value.true_heading_deg, 351.5, 1e-9);
});

test('heading: iOS bad or unknown accuracy refuses', () => {
  assert.equal(headingFromSample(ios(90, -1), CTX).status, 'unknown');
  assert.match(headingFromSample(ios(90, -1), CTX).detail, /校正/);
  assert.equal(headingFromSample(ios(90, null), CTX).status, 'unknown');
  assert.equal(headingFromSample(ios(90, 35), CTX).status, 'unknown');
  assert.equal(headingFromSample(ios(90, 20), CTX).status, 'ok');
});

test('heading: Android deviceorientationabsolute alpha (counter-clockwise)', () => {
  // alpha 0: top points (magnetic) north
  close(headingFromSample(abs(0), CTX).value.true_heading_deg, 352.5, 1e-9);
  // alpha 90: device turned 90 deg counter-clockwise -> top points west
  close(headingFromSample(abs(90), CTX).value.true_heading_deg, 262.5, 1e-9);
  close(headingFromSample(abs(270), CTX).value.true_heading_deg, 82.5, 1e-9);
  assert.equal(headingFromSample(abs(90), CTX).value.basis, BASIS.ABSOLUTE);
  // absolute=true on a plain deviceorientation event is accepted too
  assert.equal(headingFromSample(abs(0, { type: 'deviceorientation' }), CTX).status, 'ok');
});

test('heading: a relative deviceorientation (not north-referenced) is never used', () => {
  const rel = { type: 'deviceorientation', alpha: 0, beta: 20, gamma: 0, absolute: false, webkit_heading: null, webkit_accuracy: null, at_ms: NOW };
  const r = headingFromSample(rel, CTX);
  assert.equal(r.status, 'unsupported');
  assert.equal(r.value, null);
});

test('heading: stale, missing, tilted, unknown screen angle, unknown declination', () => {
  assert.equal(headingFromSample(null, CTX).status, 'unknown');
  assert.equal(headingFromSample(ios(90, 10, { at_ms: NOW - 2001 }), CTX).status, 'stale');
  assert.equal(headingFromSample(ios(90, 10, { beta: 70 }), CTX).status, 'unknown');
  assert.equal(headingFromSample(ios(90, 10, { beta: 0, gamma: 65 }), CTX).status, 'unknown');
  assert.equal(headingFromSample(ios(90, 10, { beta: 179 }), CTX).status, 'unknown'); // face down
  assert.equal(headingFromSample(ios(90, 10, { beta: null }), CTX).status, 'unknown');
  assert.equal(headingFromSample(ios(90), { ...CTX, screenAngleDeg: null }).status, 'unknown');
  assert.equal(headingFromSample(ios(90), { ...CTX, declinationWestDeg: null }).status, 'unknown');
  close(tiltDeg(0, 0), 0, 1e-9);
  close(tiltDeg(60, 0), 60, 1e-9);
});

test('heading: landscape / upside-down is refused by default (sign not yet checked on devices)', () => {
  for (const a of [90, 180, 270]) {
    const r = headingFromSample(ios(0), { ...CTX, screenAngleDeg: a });
    assert.equal(r.status, 'unknown');
    assert.match(r.detail, /縦向きで持って/);
  }
  assert.equal(headingFromSample(ios(0), { ...CTX, screenAngleDeg: 45 }).status, 'unknown');
});

test('heading: with landscape allowed, screen-up turns by the screen angle (flat-ish, no roll)', () => {
  const L = { allowLandscape: true };
  // Device top points magnetic north; rotated so screen-up is the device's right edge.
  close(headingFromSample(ios(0), { ...CTX, screenAngleDeg: 90 }, L).value.true_heading_deg, 82.5, 1e-9);
  close(headingFromSample(ios(0), { ...CTX, screenAngleDeg: 270 }, L).value.true_heading_deg, 262.5, 1e-9);
  close(headingFromSample(abs(90), { ...CTX, screenAngleDeg: 90 }, L).value.true_heading_deg, 352.5, 1e-9);
  close(headingFromSample(ios(300), { ...CTX, screenAngleDeg: 180 }, L).value.true_heading_deg, 112.5, 1e-9);
});

test('heading: tilt boundary (45 deg allowed, 46 refused) and future samples refused', () => {
  assert.equal(headingFromSample(ios(90, 10, { beta: 45, gamma: 0 }), CTX).status, 'ok');
  assert.equal(headingFromSample(ios(90, 10, { beta: 46, gamma: 0 }), CTX).status, 'unknown');
  assert.equal(headingFromSample(ios(90, 10, { at_ms: NOW + 1000 }), CTX).status, 'ok');
  assert.equal(headingFromSample(ios(90, 10, { at_ms: NOW + 10000 }), CTX).status, 'error');
});

test('tracker: iPhone-style and absolute samples mixed in the window are refused', () => {
  const t = createHeadingTracker();
  t.push(ios(90, 10, { at_ms: NOW - 300 }));
  t.push(abs(270, { at_ms: NOW - 200 })); // same true heading, different source
  t.push(ios(90, 10, { at_ms: NOW - 100 }));
  t.push(ios(90, 10, { at_ms: NOW }));
  assert.equal(t.read(CTX).status, 'unknown');
});

// ---------------------------------------------------------------- independent physical check
// Build the device attitude with the W3C rotation (R = Rz(alpha) Rx(beta)
// Ry(gamma)), draw the arrow on the screen at the angle the module returns,
// and look at where that arrow points when projected straight down onto the
// ground. It must point at the target bearing. This does not reuse the
// module's formulas.

function rotW3C(alpha, beta, gamma) {
  const r = Math.PI / 180;
  const [ca, sa, cb, sb, cg, sg] = [Math.cos(alpha * r), Math.sin(alpha * r), Math.cos(beta * r), Math.sin(beta * r), Math.cos(gamma * r), Math.sin(gamma * r)];
  const Rz = [[ca, -sa, 0], [sa, ca, 0], [0, 0, 1]];
  const Rx = [[1, 0, 0], [0, cb, -sb], [0, sb, cb]];
  const Ry = [[cg, 0, sg], [0, 1, 0], [-sg, 0, cg]];
  const mul = (A, B) => A.map((row) => B[0].map((_, j) => row.reduce((s, v, k) => s + v * B[k][j], 0)));
  return mul(mul(Rz, Rx), Ry);
}
const apply = (M, v) => M.map((row) => row[0] * v[0] + row[1] * v[1] + row[2] * v[2]);
// Screen-up and screen-right in device coordinates for each screen angle
// (90 = device turned counter-clockwise, its right edge is screen-up).
const SCREEN = { 0: [[0, 1, 0], [1, 0, 0]], 90: [[1, 0, 0], [0, -1, 0]], 180: [[0, -1, 0], [-1, 0, 0]], 270: [[-1, 0, 0], [0, 1, 0]] };

function groundBearingOfScreenArrow(alpha, beta, gamma, screenAngle, thetaDeg) {
  const [U, R] = SCREEN[screenAngle];
  const th = (thetaDeg * Math.PI) / 180;
  const vDev = [0, 1, 2].map((i) => Math.cos(th) * U[i] + Math.sin(th) * R[i]);
  const w = apply(rotW3C(alpha, beta, gamma), vDev); // east, north, up
  return norm360((Math.atan2(w[0], w[1]) * 180) / Math.PI);
}

test('physical check: the drawn arrow points at the target for many attitudes (portrait and landscape)', () => {
  let n = 0;
  for (const screenAngle of [0, 90, 180, 270]) {
    for (const alpha of [0, 37, 123, 250, 359]) {
      for (const [beta, gamma] of [[0, 0], [20, 0], [40, 10], [-30, 25], [10, -40], [30, 30]]) {
        if (tiltDeg(beta, gamma) > 45) continue;
        const sample = abs(alpha, { beta, gamma });
        const h = headingFromSample(sample, { nowMs: NOW, screenAngleDeg: screenAngle, declinationWestDeg: 0 }, { allowLandscape: true });
        assert.equal(h.status, 'ok');
        for (const target of [0, 45, 90, 181, 300]) {
          const theta = screenArrowDeg(target, h.value);
          const got = groundBearingOfScreenArrow(alpha, beta, gamma, screenAngle, theta);
          assert.ok(Math.abs(angleDiff(got, target)) < 1e-6, `a=${alpha} b=${beta} g=${gamma} s=${screenAngle} t=${target}: ${got}`);
          n++;
        }
        // the reported screen-up heading is where an arrow at 0 deg points
        const up = groundBearingOfScreenArrow(alpha, beta, gamma, screenAngle, 0);
        assert.ok(Math.abs(angleDiff(up, h.value.true_heading_deg)) < 1e-6);
      }
    }
  }
  assert.ok(n > 300);
});

test('physical check: the review example (landscape, beta 30, gamma 30) is no longer 16 deg off', () => {
  const h = headingFromSample(abs(0, { beta: 30, gamma: 30 }), { nowMs: NOW, screenAngleDeg: 90, declinationWestDeg: 0 }, { allowLandscape: true });
  close(h.value.true_heading_deg, 73.9, 0.1); // screen-up projected, not 90
  close(screenUpOffsetDeg(0, 0, 90), 90, 1e-9);
  close(screenUpOffsetDeg(20, 0, 0), 0, 1e-9);
});

test('screen angle: APIs, legacy -90, odd values, portrait hint', () => {
  assert.equal(screenAngleFrom({ orientationAngle: 90 }), 90);
  assert.equal(screenAngleFrom({ windowOrientation: -90 }), 270);
  assert.equal(screenAngleFrom({ orientationAngle: 0, windowOrientation: 90 }), 0);
  assert.equal(screenAngleFrom({ orientationAngle: 45 }), null);
  assert.equal(screenAngleFrom({ portraitHint: true }), 0);
  assert.equal(screenAngleFrom({ portraitHint: false }), null);
  assert.equal(screenAngleFrom({}), null);
  assert.equal(currentScreenAngle({ screen: { orientation: { angle: 270 } } }), 270);
  assert.equal(currentScreenAngle({ orientation: -90 }), 270);
  assert.equal(currentScreenAngle({ innerWidth: 800, innerHeight: 400 }), null);
});

test('tracker: stable samples give the circular mean; boundary 358/0/2 stays near 0', () => {
  const t = createHeadingTracker();
  for (const [h, dt] of [[357.5, 300], [359.5, 200], [1.5, 100], [359.5, 0]]) t.push(ios(h, 10, { at_ms: NOW - dt }));
  const r = t.read(CTX);
  assert.equal(r.status, 'ok');
  // magnetic ~359.5 -> true ~352
  close(r.value.true_heading_deg, 352, 1);
  assert.ok(r.value.spread_deg < 5);
  const st = circularStats([358, 0, 2]);
  close(st.mean > 180 ? st.mean - 360 : st.mean, 0, 1e-9);
});

test('tracker: jittery, too few, or a bad latest sample refuses', () => {
  const t = createHeadingTracker();
  t.push(ios(0, 10, { at_ms: NOW - 200 }));
  t.push(ios(40, 10, { at_ms: NOW - 100 }));
  t.push(ios(0, 10, { at_ms: NOW }));
  assert.equal(t.read(CTX).status, 'unknown');
  assert.match(t.read(CTX).detail, /安定していません/);

  const few = createHeadingTracker();
  few.push(ios(90));
  assert.equal(few.read(CTX).status, 'unknown');

  const bad = createHeadingTracker();
  for (const dt of [300, 200, 100]) bad.push(ios(90, 10, { at_ms: NOW - dt }));
  bad.push(ios(90, -1));
  assert.equal(bad.read(CTX).status, 'unknown');

  const old = createHeadingTracker();
  for (const dt of [5000, 4000, 3000]) old.push(ios(90, 10, { at_ms: NOW - dt }));
  assert.equal(old.read(CTX).status, 'stale');
});

test('GPS course: used only when moving fast enough and fresh', () => {
  assert.equal(courseFrom(null, NOW).usable, false);
  assert.equal(courseFrom({ heading_deg: 90, speed_mps: 0.3, at_ms: NOW }, NOW).usable, false);
  assert.match(courseFrom({ heading_deg: 90, speed_mps: 0, at_ms: NOW }, NOW).reason, /止まっている/);
  assert.equal(courseFrom({ heading_deg: null, speed_mps: 3, at_ms: NOW }, NOW).usable, false);
  assert.equal(courseFrom({ heading_deg: 90, speed_mps: 3, at_ms: NOW - 60000 }, NOW).usable, false);
  const c = courseFrom({ heading_deg: 450, speed_mps: 1.5, at_ms: NOW }, NOW);
  assert.equal(c.usable, true);
  assert.equal(c.heading_deg, 90);
});

test('sampleFromEvent copies only numbers', () => {
  const s = sampleFromEvent({ type: 'deviceorientation', alpha: 1, beta: 'x', gamma: null, webkitCompassHeading: 12, webkitCompassAccuracy: 5 }, { atMs: 5 });
  assert.deepEqual({ ...s }, { type: 'deviceorientation', alpha: 1, beta: null, gamma: null, absolute: false, webkit_heading: 12, webkit_accuracy: 5, at_ms: 5 });
});

function fakeWindow({ absolute }) {
  const w = new EventTarget();
  if (absolute) w.ondeviceorientationabsolute = null;
  return w;
}
function fire(w, type, props) {
  w.dispatchEvent(Object.assign(new Event(type), props));
}

test('browser wiring: on Android-like browsers the relative stream is ignored', () => {
  const w = fakeWindow({ absolute: true });
  const t = createHeadingTracker();
  let now = NOW - 300;
  const h = startOrientation(t, { w, now: () => now });
  for (let i = 0; i < 3; i++) {
    fire(w, 'deviceorientationabsolute', { alpha: 90, beta: 20, gamma: 0, absolute: true });
    fire(w, 'deviceorientation', { alpha: 0, beta: 20, gamma: 0, absolute: false });
    now += 100;
  }
  const r = t.read({ ...CTX, nowMs: now });
  assert.equal(r.status, 'ok');
  close(r.value.true_heading_deg, 262.5, 1e-6);
  assert.equal(h.lastEventType, 'deviceorientationabsolute');
  h.stop();
  fire(w, 'deviceorientationabsolute', { alpha: 0, beta: 20, gamma: 0, absolute: true });
  assert.equal(t.size, 3);
});

test('browser wiring: iPhone-like events with webkitCompassHeading', () => {
  const w = fakeWindow({ absolute: false });
  const t = createHeadingTracker();
  let now = NOW - 300;
  startOrientation(t, { w, now: () => now });
  for (let i = 0; i < 3; i++) {
    fire(w, 'deviceorientation', { alpha: 123, beta: 20, gamma: 0, absolute: false, webkitCompassHeading: 180, webkitCompassAccuracy: 10 });
    now += 100;
  }
  close(t.read({ ...CTX, nowMs: now }).value.true_heading_deg, 172.5, 1e-6);
});

test('browser wiring: relative-only browsers give "unsupported", not an arrow', () => {
  const w = fakeWindow({ absolute: false });
  const t = createHeadingTracker();
  startOrientation(t, { w, now: () => NOW });
  fire(w, 'deviceorientation', { alpha: 0, beta: 20, gamma: 0, absolute: false });
  assert.equal(t.read(CTX).status, 'unsupported');
});

test('permission: iOS-style requestPermission is called synchronously', async () => {
  let called = false;
  const w = { DeviceOrientationEvent: { requestPermission() { called = true; return Promise.resolve('granted'); } } };
  const p = requestOrientationPermission(w);
  assert.equal(called, true); // before any await
  assert.equal(await p, 'granted');
  assert.equal(await requestOrientationPermission({ DeviceOrientationEvent: function E() {} }), 'not_required');
  assert.equal(await requestOrientationPermission({}), 'unsupported');
  assert.equal(await requestOrientationPermission({ DeviceOrientationEvent: { requestPermission: () => Promise.resolve('denied') } }), 'denied');
});
