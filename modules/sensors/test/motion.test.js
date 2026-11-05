import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createMotionSensor, MOTION_LABEL } from '../motion.js';
import { createReplayPlayer } from '../replay.js';
import { recording, assertContract } from './helpers.js';

const base = { secure: true, motion: true, motion_permission: 'not_required' };

function m(t_ms, ax, rot = 0) {
  return {
    t_ms,
    type: 'devicemotion',
    data: {
      acceleration: { x: ax, y: 0, z: 0 },
      accelerationIncludingGravity: { x: ax, y: 0, z: 9.8 },
      rotationRate: { alpha: rot, beta: 0, gamma: 0 },
      interval: 16,
    },
  };
}

test('raw values are reported with the label, never called seismic intensity', () => {
  const p = createReplayPlayer(recording(base, [m(100, 0.5, 3)]));
  const s = createMotionSensor({ env: p.env });
  s.start();
  p.advanceTo(100);
  const r = assertContract(s.read(), 'motion');
  assert.equal(r.status, 'ok');
  assert.equal(r.source, 'simulated');
  assert.deepEqual(r.value.acceleration, { x: 0.5, y: 0, z: 0 });
  assert.deepEqual(r.value.acceleration_including_gravity, { x: 0.5, y: 0, z: 9.8 });
  assert.deepEqual(r.value.rotation_rate, { alpha: 3, beta: 0, gamma: 0 });
  assert.equal(r.value.interval_ms, 16);
  assert.equal(r.value.label, MOTION_LABEL);
  assert.equal(MOTION_LABEL, 'この端末が記録した揺れ（震度ではありません）');
  assert.ok(r.detail.startsWith(MOTION_LABEL));
});

test('BW-S1: no text calls the values seismic intensity or judges an earthquake', async () => {
  const p = createReplayPlayer(recording(base, [m(0, 30, 300)]));
  const s = createMotionSensor({ env: p.env });
  s.start();
  p.advanceTo(0);
  const texts = [s.read(), s.peak(1), (await s.requestPermission())].map((r) => JSON.stringify(r));
  for (const t of texts) {
    // "震度" may appear only inside the fixed negation "震度ではありません".
    assert.doesNotMatch(t.replaceAll('震度ではありません', ''), /震度/);
    assert.doesNotMatch(t.replaceAll('地震の有無や強さの判断には使えません', ''), /地震/);
    assert.doesNotMatch(t, /警報|速報|注意報|避難/);
  }
});

test('peak(windowSec) returns the maximum over the window', () => {
  const p = createReplayPlayer(
    recording(base, [m(0, 1), m(1000, -4, 20), m(2000, 2), m(9000, 0.1), m(10000, 0.2)]),
  );
  const s = createMotionSensor({ env: p.env, staleAfterSec: 60 });
  s.start();
  p.advanceTo(10000);
  const all = assertContract(s.peak(30), 'motion_peak');
  assert.equal(all.status, 'ok');
  assert.equal(all.value.acceleration_max.x, 4);
  assert.equal(all.value.rotation_rate_max.alpha, 20);
  assert.equal(all.value.sample_count, 5);
  assert.equal(all.value.label, MOTION_LABEL);
  const recent = s.peak(2);
  assert.equal(recent.value.sample_count, 2);
  assert.ok(Math.abs(recent.value.acceleration_max.x - 0.2) < 1e-9);
  // magnitude includes gravity for acceleration_including_gravity
  assert.ok(all.value.acceleration_including_gravity_max.magnitude > 9.8);
});

test('peak with no samples is "unknown", not zero', () => {
  const p = createReplayPlayer(recording(base, [m(0, 1)]));
  const s = createMotionSensor({ env: p.env, staleAfterSec: 60 });
  s.start();
  p.advanceTo(30_000);
  const r = assertContract(s.peak(5), 'motion_peak');
  assert.equal(r.status, 'unknown');
  assert.equal(r.value, null);
  assert.match(r.detail, /揺れがなかったという意味ではありません/);
});

test('peak window cannot exceed historySec', () => {
  const p = createReplayPlayer(recording(base));
  const s = createMotionSensor({ env: p.env, historySec: 10 });
  assert.throws(() => s.peak(11), RangeError);
});

test('history is pruned to historySec', () => {
  const events = [];
  for (let t = 0; t <= 20_000; t += 100) events.push(m(t, t === 1000 ? 9 : 0.1));
  const p = createReplayPlayer(recording(base, events));
  const s = createMotionSensor({ env: p.env, historySec: 5 });
  s.start();
  p.advanceTo(20_000);
  const r = s.peak(5);
  assert.ok(r.value.acceleration_max.x < 1, 'old peak must have been dropped');
});

test('startPeakRecording keeps the maximum until stop()', () => {
  const p = createReplayPlayer(recording(base, [m(0, 7), m(1000, 1), m(2000, 3), m(5000, 8)]));
  const s = createMotionSensor({ env: p.env, historySec: 1 });
  s.start();
  p.advanceTo(500);
  const rec = s.startPeakRecording();
  assert.equal(rec.read().status, 'unknown');
  p.advanceTo(2500);
  const r = assertContract(rec.stop(), 'motion_peak');
  assert.equal(r.status, 'ok');
  assert.equal(r.value.acceleration_max.x, 3);
  assert.equal(r.value.sample_count, 2);
  p.advanceTo(5000);
  assert.equal(rec.read().value.acceleration_max.x, 3, 'stopped recording does not change');
});

test('stale after the configured seconds', () => {
  const p = createReplayPlayer(recording(base, [m(0, 1)]));
  const s = createMotionSensor({ env: p.env, staleAfterSec: 0.5 });
  s.start();
  p.advanceTo(400);
  assert.equal(s.read().status, 'ok');
  p.advanceTo(501);
  const r = assertContract(s.read(), 'motion');
  assert.equal(r.status, 'stale');
});

test('iOS-style permission: no events before requestPermission, then granted', async () => {
  const p = createReplayPlayer(recording({ ...base, motion_permission: 'prompt' }, [m(100, 1), m(200, 2)]));
  const s = createMotionSensor({ env: p.env });
  s.start();
  p.advanceTo(100);
  assert.equal(s.read().status, 'unknown');
  const perm = assertContract(await s.requestPermission(), 'motion_permission');
  assert.equal(perm.status, 'ok');
  assert.equal(perm.value.permission, 'granted');
  p.advanceTo(200);
  assert.equal(s.read().status, 'ok');
});

test('requestPermission calls the browser API synchronously (user gesture)', () => {
  const p = createReplayPlayer(recording({ ...base, motion_permission: 'prompt' }));
  let called = false;
  p.env.DeviceMotionEvent.requestPermission = () => {
    called = true;
    return Promise.resolve('granted');
  };
  const s = createMotionSensor({ env: p.env });
  s.requestPermission();
  assert.equal(called, true, 'must be called before returning, not after an await');
});

test('permission denied -> "denied" for both read() and peak()', async () => {
  const p = createReplayPlayer(recording({ ...base, motion_permission: 'denied' }, [m(100, 1)]));
  const s = createMotionSensor({ env: p.env });
  s.start();
  const perm = assertContract(await s.requestPermission(), 'motion_permission');
  assert.equal(perm.status, 'denied');
  p.advanceTo(100);
  assert.equal(s.read().status, 'denied');
  assert.equal(s.peak(1).status, 'denied');
});

test('requestPermission outside a gesture (NotAllowedError) -> "error" with guidance', async () => {
  const p = createReplayPlayer(recording({ ...base, motion_permission: 'prompt' }));
  p.env.DeviceMotionEvent.requestPermission = () =>
    Promise.reject(Object.assign(new Error('x'), { name: 'NotAllowedError' }));
  const s = createMotionSensor({ env: p.env });
  const r = assertContract(await s.requestPermission(), 'motion_permission');
  assert.equal(r.status, 'error');
  assert.match(r.detail, /ボタン/);
});

test('not required on Android-like browsers', async () => {
  const p = createReplayPlayer(recording(base));
  const r = await createMotionSensor({ env: p.env }).requestPermission();
  assert.equal(r.status, 'ok');
  assert.equal(r.value.permission, 'not_required');
});

test('insecure / unsupported / empty event', async () => {
  const insecure = createReplayPlayer(recording({ ...base, secure: false }));
  const si = createMotionSensor({ env: insecure.env });
  assert.equal(assertContract(si.start(), 'motion').status, 'insecure');
  assert.equal((await si.requestPermission()).status, 'insecure');
  assert.equal(si.peak(1).status, 'insecure');

  const none = createReplayPlayer(recording({ secure: true, motion: false }));
  assert.equal(createMotionSensor({ env: none.env }).start().status, 'unsupported');

  const empty = createReplayPlayer(recording(base, [{ t_ms: 0, type: 'devicemotion', data: {} }]));
  const se = createMotionSensor({ env: empty.env });
  se.start();
  empty.advanceTo(0);
  assert.equal(assertContract(se.read(), 'motion').status, 'unsupported');
});
