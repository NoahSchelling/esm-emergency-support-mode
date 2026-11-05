import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createLocationSensor } from '../location.js';
import { createReplayPlayer } from '../replay.js';
import { createDeviceEnv } from '../env.js';
import { recording, assertContract, FICTIONAL, flush } from './helpers.js';

const base = { secure: true, geolocation: true, geolocation_permission: 'granted' };

test('reports latitude, longitude and accuracy from replayed positions', () => {
  const p = createReplayPlayer(
    recording(base, [{ t_ms: 1000, type: 'position', data: FICTIONAL }]),
  );
  const s = createLocationSensor({ env: p.env });
  assertContract(s.start(), 'location');
  assert.equal(s.read().status, 'unknown');
  p.advanceTo(1000);
  const r = assertContract(s.read(), 'location');
  assert.equal(r.status, 'ok');
  assert.equal(r.source, 'simulated');
  assert.equal(r.value.latitude, 35.0);
  assert.equal(r.value.longitude, 135.0);
  assert.equal(r.value.accuracy_m, 25);
  assert.equal(Date.parse(r.observed_at), Date.parse('2026-11-05T10:00:01+09:00'));
});

test('becomes stale after staleAfterSec without updates, and the threshold is configurable', () => {
  const rec = recording(base, [{ t_ms: 0, type: 'position', data: FICTIONAL }]);
  const p = createReplayPlayer(rec);
  const s = createLocationSensor({ env: p.env, staleAfterSec: 10 });
  s.start();
  p.advanceTo(0);
  p.advanceBy(10_000);
  assert.equal(s.read().status, 'ok');
  p.advanceBy(1);
  const r = assertContract(s.read(), 'location');
  assert.equal(r.status, 'stale');
  assert.equal(r.value, null);

  const p2 = createReplayPlayer(rec);
  const s2 = createLocationSensor({ env: p2.env, staleAfterSec: 60 });
  s2.start();
  p2.advanceTo(30_000);
  assert.equal(s2.read().status, 'ok');
});

test('rejects invalid staleAfterSec', () => {
  const p = createReplayPlayer(recording(base));
  assert.throws(() => createLocationSensor({ env: p.env, staleAfterSec: 0 }), RangeError);
  assert.throws(() => createLocationSensor({ env: p.env, staleAfterSec: -1 }), RangeError);
});

test('permission denied -> "denied"', async () => {
  const p = createReplayPlayer(recording({ ...base, geolocation_permission: 'denied' }));
  const s = createLocationSensor({ env: p.env });
  s.start();
  await flush();
  const r = assertContract(s.read(), 'location');
  assert.equal(r.status, 'denied');
  const once = assertContract(await s.locateOnce(), 'location');
  assert.equal(once.status, 'denied');
});

test('not HTTPS -> "insecure"', async () => {
  const p = createReplayPlayer(recording({ ...base, secure: false }));
  const s = createLocationSensor({ env: p.env });
  assert.equal(assertContract(s.start(), 'location').status, 'insecure');
  assert.equal((await s.locateOnce()).status, 'insecure');
});

test('no geolocation -> "unsupported"', () => {
  const p = createReplayPlayer(recording({ secure: true, geolocation: false }));
  const s = createLocationSensor({ env: p.env });
  assert.equal(assertContract(s.start(), 'location').status, 'unsupported');
});

test('position errors map to "error", and an invalid value is not passed through', () => {
  const p = createReplayPlayer(
    recording(base, [
      { t_ms: 0, type: 'position_error', data: { code: 3 } },
      { t_ms: 100, type: 'position', data: { latitude: 200, longitude: 0, accuracy: 5 } },
    ]),
  );
  const s = createLocationSensor({ env: p.env });
  s.start();
  p.advanceTo(0);
  assert.equal(s.read().status, 'error');
  p.advanceTo(100);
  const r = assertContract(s.read(), 'location');
  assert.equal(r.status, 'error');
  assert.equal(r.value, null);
});

test('locateOnce waits for the next position and subscribers are notified', async () => {
  const p = createReplayPlayer(recording(base, [{ t_ms: 500, type: 'position', data: FICTIONAL }]));
  const s = createLocationSensor({ env: p.env });
  const seen = [];
  s.subscribe((r) => seen.push(r.status));
  const pending = s.locateOnce();
  p.advanceTo(500);
  const r = await pending;
  assert.equal(r.status, 'ok');
  assert.deepEqual(seen, ['ok']);
});

test('stop() clears the watch', () => {
  const p = createReplayPlayer(recording(base));
  const s = createLocationSensor({ env: p.env });
  s.start();
  assert.equal(p._internals.geo.watcherCount(), 1);
  s.stop();
  assert.equal(p._internals.geo.watcherCount(), 0);
});

test('loads in Node.js with the default device env and reports "unsupported"', () => {
  const s = createLocationSensor({ env: createDeviceEnv({ navigator: {} }) });
  const r = assertContract(s.start(), 'location');
  assert.equal(r.status, 'unsupported');
  assert.equal(r.source, 'device');
});
