import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createOrientationSensor } from '../orientation.js';
import { createReplayPlayer } from '../replay.js';
import { recording, assertContract } from './helpers.js';

const base = { secure: true, orientation: true, orientation_permission: 'not_required' };
const o = (t_ms, data) => ({ t_ms, type: 'deviceorientation', data });

test('reports alpha/beta/gamma and the iOS compass heading', () => {
  const p = createReplayPlayer(
    recording(base, [o(0, { alpha: 10, beta: 20, gamma: -5, absolute: false, webkitCompassHeading: 270, webkitCompassAccuracy: 15 })]),
  );
  const s = createOrientationSensor({ env: p.env });
  s.start();
  p.advanceTo(0);
  const r = assertContract(s.read(), 'orientation');
  assert.equal(r.status, 'ok');
  assert.equal(r.source, 'simulated');
  assert.deepEqual(r.value, {
    alpha_deg: 10,
    beta_deg: 20,
    gamma_deg: -5,
    absolute: false,
    compass_heading_deg: 270,
    compass_accuracy_deg: 15,
  });
  assert.match(r.detail, /北を指すとは限りません/);
});

test('stale threshold is configurable', () => {
  const p = createReplayPlayer(recording(base, [o(0, { alpha: 1, beta: 2, gamma: 3 })]));
  const s = createOrientationSensor({ env: p.env, staleAfterSec: 5 });
  s.start();
  p.advanceTo(5000);
  assert.equal(s.read().status, 'ok');
  p.advanceTo(5001);
  assert.equal(assertContract(s.read(), 'orientation').status, 'stale');
});

test('iOS-style permission prompt, granted and denied', async () => {
  const granted = createReplayPlayer(
    recording({ ...base, orientation_permission: 'prompt' }, [o(10, { alpha: 1, beta: 2, gamma: 3 })]),
  );
  const s = createOrientationSensor({ env: granted.env });
  s.start();
  granted.advanceTo(5);
  assert.equal(s.read().status, 'unknown');
  assert.equal((await s.requestPermission()).status, 'ok');
  granted.advanceTo(10);
  assert.equal(s.read().status, 'ok');

  const denied = createReplayPlayer(recording({ ...base, orientation_permission: 'denied' }));
  const sd = createOrientationSensor({ env: denied.env });
  sd.start();
  assert.equal(assertContract(await sd.requestPermission(), 'orientation_permission').status, 'denied');
  assert.equal(sd.read().status, 'denied');
});

test('insecure, unsupported, empty event, custom event name', () => {
  assert.equal(
    createOrientationSensor({ env: createReplayPlayer(recording({ ...base, secure: false })).env }).start().status,
    'insecure',
  );
  assert.equal(
    createOrientationSensor({ env: createReplayPlayer(recording({ secure: true })).env }).start().status,
    'unsupported',
  );
  const empty = createReplayPlayer(recording(base, [o(0, { alpha: null, beta: null, gamma: null })]));
  const se = createOrientationSensor({ env: empty.env });
  se.start();
  empty.advanceTo(0);
  assert.equal(se.read().status, 'unsupported');

  const p = createReplayPlayer(recording(base));
  const sa = createOrientationSensor({ env: p.env, eventName: 'deviceorientationabsolute' });
  sa.start();
  assert.equal(p._internals.win.listenerCount('deviceorientationabsolute'), 1);
  sa.stop();
  assert.equal(p._internals.win.listenerCount('deviceorientationabsolute'), 0);
});
