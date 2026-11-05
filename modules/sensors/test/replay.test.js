// End-to-end: replay the fixture through every sensor via index.js.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import * as sensors from '../index.js';
import { recording, assertContract, flush, FICTIONAL } from './helpers.js';

const fixture = JSON.parse(readFileSync(new URL('../fixtures/sample-session.json', import.meta.url)));

function setup() {
  const player = sensors.createReplayPlayer(fixture);
  const env = player.env;
  const s = {
    location: sensors.createLocationSensor({ env }),
    motion: sensors.createMotionSensor({ env }),
    orientation: sensors.createOrientationSensor({ env }),
    online: sensors.createOnlineSensor({ env }),
    network: sensors.createNetworkSensor({ env }),
    battery: sensors.createBatterySensor({ env }),
  };
  return { player, s };
}

test('fixture is valid and synthetic', () => {
  sensors.validateRecording(fixture);
  assert.match(fixture.description, /架空/);
  assert.match(fixture.description, /地震の記録ではない/);
  for (const e of fixture.events.filter((e) => e.type === 'position')) {
    assert.ok(Math.abs(e.data.latitude - 35) < 0.01 && Math.abs(e.data.longitude - 135) < 0.01, 'fictional point');
  }
});

test('full replay: every result follows the contract and is "simulated"', async () => {
  const { player, s } = setup();
  s.location.start();
  s.motion.start();
  s.orientation.start();
  s.online.start();
  s.network.start();
  await s.battery.start();
  // Motion/orientation need the iOS-style permission in this fixture.
  const perm = await sensors.requestMotionAndOrientationPermission(s.motion, s.orientation);
  assert.equal(perm.motion.status, 'ok');
  assert.equal(perm.orientation.status, 'ok');

  const timeline = {};
  for (let t = 0; t <= 60_000; t += 1000) {
    player.advanceTo(t);
    for (const [name, sensor] of Object.entries(s)) {
      const r = assertContract(sensor.read(), sensor.kind);
      assert.equal(r.source, 'simulated');
      (timeline[name] ??= []).push(r.status);
    }
    assertContract(s.motion.peak(5), 'motion_peak');
  }
  await flush();

  // Motion is stale during the 45-52 s gap and ok again afterwards.
  assert.equal(timeline.motion[44], 'ok');
  assert.equal(timeline.motion[48], 'stale');
  assert.equal(timeline.motion[55], 'ok');
  assert.equal(timeline.orientation[48], 'stale');
  // Location: last fix at 40 s, default staleAfterSec 120 -> still ok at 60 s.
  assert.equal(timeline.location[60], 'ok');
  // Offline between 30 and 40 s.
  player.advanceTo(60_000);
  assert.equal(s.online.read().value.online, true);
  assert.equal(s.network.read().value.type, 'cellular');
  assert.equal(s.battery.read().value.level_percent, 40);
});

test('peak over the shake burst is larger than over a quiet window', () => {
  const { player, s } = setup();
  s.motion.start();
  s.motion.requestPermission();
  return flush().then(() => {
    player.advanceTo(15_000);
    const quiet = s.motion.peak(5).value.acceleration_max.magnitude;
    const rec = s.motion.startPeakRecording();
    player.advanceTo(25_000);
    const burst = rec.stop();
    assert.equal(burst.status, 'ok');
    assert.ok(burst.value.acceleration_max.magnitude > quiet * 10);
    assert.equal(burst.value.label, sensors.MOTION_LABEL);
  });
});

test('recorder captures events in the replay format (round trip)', async () => {
  const src = sensors.createReplayPlayer(
    recording(
      {
        secure: true,
        geolocation: true,
        motion: true,
        motion_permission: 'not_required',
        orientation: true,
        online: true,
        connection: { type: 'wifi', effectiveType: '4g' },
        battery: { level: 0.5, charging: true, chargingTime: 600, dischargingTime: null },
      },
      [
        { t_ms: 100, type: 'position', data: FICTIONAL },
        { t_ms: 200, type: 'devicemotion', data: { acceleration: { x: 1, y: 2, z: 3 }, interval: 16 } },
        { t_ms: 300, type: 'offline' },
        { t_ms: 400, type: 'battery', data: { level: 0.49 } },
      ],
    ),
  );
  const noLoc = sensors.createRecorder({ env: src.env });
  const withLoc = sensors.createRecorder({ env: src.env, includeLocation: true });
  await noLoc.ready;
  await withLoc.ready;
  src.advanceTo(400);
  const a = noLoc.stop();
  const b = withLoc.stop();
  sensors.validateRecording(a);
  assert.deepEqual(
    a.events.map((e) => e.type),
    ['devicemotion', 'offline', 'battery'],
    'location is not recorded by default',
  );
  assert.equal(a.environment.geolocation, false);
  assert.ok(b.events.some((e) => e.type === 'position'));
  assert.match(b.description, /リポジトリに入れない/);

  // Replay the captured recording.
  const again = sensors.createReplayPlayer(a);
  const motion = sensors.createMotionSensor({ env: again.env });
  motion.start();
  again.advanceTo(a.events[0].t_ms);
  assert.deepEqual(motion.read().value.acceleration, { x: 1, y: 2, z: 3 });
  assert.equal(motion.read().source, 'simulated');
});

test('recorder respects maxEvents', () => {
  const events = Array.from({ length: 10 }, (_, i) => ({ t_ms: i, type: 'devicemotion', data: { acceleration: { x: i, y: 0, z: 0 } } }));
  const src = sensors.createReplayPlayer(recording({ secure: true, motion: true }, events));
  const r = sensors.createRecorder({ env: src.env, maxEvents: 3 });
  src.advanceTo(9);
  const out = r.stop();
  assert.equal(out.events.length, 3);
  assert.match(out.description, /打ち切り/);
});

test('player cannot go backwards and validates recordings', () => {
  const { player } = setup();
  player.advanceTo(1000);
  assert.throws(() => player.advanceTo(500), RangeError);
  assert.throws(() => sensors.createReplayPlayer({ format: 'x' }), TypeError);
  assert.throws(
    () => sensors.createReplayPlayer(recording({}, [{ t_ms: 5, type: 'online' }, { t_ms: 1, type: 'online' }])),
    TypeError,
  );
});

test('observed_at carries a time zone offset', () => {
  assert.match(sensors.toIsoWithOffset(Date.parse('2026-11-05T01:00:00Z')), /[+-]\d{2}:\d{2}$/);
  assert.equal(
    Date.parse(sensors.toIsoWithOffset(Date.parse('2026-11-05T01:02:03.456Z'))),
    Date.parse('2026-11-05T01:02:03.456Z'),
  );
});

test('makeResult drops value unless status is ok', () => {
  const r = sensors.makeResult({ kind: 'x', status: 'stale', value: { a: 1 }, observedAtMs: 0, source: 'simulated', detail: 'd' });
  assert.equal(r.value, null);
  assert.throws(() => sensors.makeResult({ kind: 'x', status: 'safe', observedAtMs: 0, source: 's', detail: 'd' }), TypeError);
  const ok = sensors.makeResult({ kind: 'x', status: 'ok', value: { a: 1 }, observedAtMs: 0, source: 's', detail: 'd' });
  assert.ok(Object.isFrozen(ok.value));
});
