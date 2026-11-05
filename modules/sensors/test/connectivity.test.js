// Tests for online.js, network.js and battery.js.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createOnlineSensor } from '../online.js';
import { createNetworkSensor } from '../network.js';
import { createBatterySensor } from '../battery.js';
import { createReplayPlayer } from '../replay.js';
import { createDeviceEnv } from '../env.js';
import { recording, assertContract } from './helpers.js';

test('online: reports the state and notifies on online/offline events', () => {
  const p = createReplayPlayer(
    recording({ secure: true, online: true }, [
      { t_ms: 1000, type: 'offline' },
      { t_ms: 2000, type: 'online' },
    ]),
  );
  const s = createOnlineSensor({ env: p.env });
  const seen = [];
  s.subscribe((r) => seen.push(r.value.online));
  const r = assertContract(s.start(), 'online');
  assert.equal(r.status, 'ok');
  assert.equal(r.value.online, true);
  assert.match(r.detail, /届くとは限りません/);
  p.advanceTo(1000);
  assert.equal(assertContract(s.read(), 'online').value.online, false);
  p.advanceTo(2000);
  assert.deepEqual(seen, [true, false, true]);
  s.read();
  s.read();
  assert.equal(seen.length, 3, 'read() must not notify subscribers');
  s.stop();
  assert.equal(p._internals.win.listenerCount('online'), 0);
});

test('online: insecure / unsupported', () => {
  const pi = createReplayPlayer(recording({ secure: false, online: true }));
  assert.equal(assertContract(createOnlineSensor({ env: pi.env }).start(), 'online').status, 'insecure');
  const pu = createReplayPlayer(recording({ secure: true, online: null }));
  assert.equal(assertContract(createOnlineSensor({ env: pu.env }).read(), 'online').status, 'unsupported');
});

test('network: reports type and estimate, follows change events', () => {
  const p = createReplayPlayer(
    recording({ secure: true, connection: { type: 'wifi', effectiveType: '4g', downlink: 10, rtt: 50, saveData: false } }, [
      { t_ms: 500, type: 'connection', data: { type: 'cellular', effectiveType: '3g', downlink: 1.2, rtt: 300 } },
    ]),
  );
  const s = createNetworkSensor({ env: p.env });
  const seen = [];
  s.subscribe((r) => seen.push(r.value?.type));
  const r = assertContract(s.start(), 'network');
  assert.deepEqual(r.value, { type: 'wifi', effective_type: '4g', downlink_mbps: 10, rtt_ms: 50, save_data: false });
  p.advanceTo(500);
  assert.equal(s.read().value.type, 'cellular');
  assert.deepEqual(seen, ['wifi', 'cellular']);
});

test('network: Chrome desktop style (no type, only effectiveType)', () => {
  const p = createReplayPlayer(recording({ secure: true, connection: { effectiveType: '4g' } }));
  const r = assertContract(createNetworkSensor({ env: p.env }).read(), 'network');
  assert.equal(r.status, 'ok');
  assert.equal(r.value.type, null);
  assert.match(r.detail, /報告されていません/);
});

test('network: "unsupported" when navigator.connection is missing (e.g. iOS Safari)', () => {
  const p = createReplayPlayer(recording({ secure: true, connection: null }));
  const r = assertContract(createNetworkSensor({ env: p.env }).start(), 'network');
  assert.equal(r.status, 'unsupported');
  const pi = createReplayPlayer(recording({ secure: false, connection: { type: 'wifi' } }));
  assert.equal(createNetworkSensor({ env: pi.env }).read().status, 'insecure');
});

test('battery: level, charging and change events', async () => {
  const p = createReplayPlayer(
    recording({ secure: true, battery: { level: 0.8, charging: false, chargingTime: null, dischargingTime: 7200 } }, [
      { t_ms: 1000, type: 'battery', data: { level: 0.79 } },
      { t_ms: 2000, type: 'battery', data: { charging: true, chargingTime: 3600 } },
    ]),
  );
  const s = createBatterySensor({ env: p.env });
  assert.equal(s.read().status, 'unknown');
  const r = assertContract(await s.start(), 'battery');
  assert.equal(r.status, 'ok');
  assert.deepEqual(r.value, {
    level: 0.8,
    level_percent: 80,
    charging: false,
    charging_time_sec: null,
    discharging_time_sec: 7200,
  });
  const seen = [];
  s.subscribe((x) => seen.push(x.value.level_percent));
  p.advanceTo(2000);
  assert.ok(seen.length >= 2);
  const now = assertContract(s.read(), 'battery');
  assert.equal(now.value.level_percent, 79);
  assert.equal(now.value.charging, true);
  assert.equal(now.value.charging_time_sec, 3600);
});

test('battery: "unsupported" without getBattery, "insecure" on HTTP, "denied" on NotAllowedError', async () => {
  const pu = createReplayPlayer(recording({ secure: true, battery: null }));
  assert.equal(assertContract(await createBatterySensor({ env: pu.env }).start(), 'battery').status, 'unsupported');
  const pi = createReplayPlayer(recording({ secure: false, battery: { level: 1 } }));
  assert.equal((await createBatterySensor({ env: pi.env }).start()).status, 'insecure');
  const pd = createReplayPlayer(recording({ secure: true, battery: { level: 1 } }));
  pd.env.navigator.getBattery = () => Promise.reject(Object.assign(new Error('no'), { name: 'NotAllowedError' }));
  assert.equal(assertContract(await createBatterySensor({ env: pd.env }).start(), 'battery').status, 'denied');
  const pe = createReplayPlayer(recording({ secure: true, battery: { level: 1 } }));
  pe.env.navigator.getBattery = () => {
    throw new Error('boom');
  };
  assert.equal((await createBatterySensor({ env: pe.env }).start()).status, 'error');
});

test('battery: invalid level -> "error" with no value', async () => {
  const p = createReplayPlayer(recording({ secure: true, battery: { level: 3 } }));
  const r = assertContract(await createBatterySensor({ env: p.env }).start(), 'battery');
  assert.equal(r.status, 'error');
  assert.equal(r.value, null);
});

test('all three load in Node.js with the default env', async () => {
  const env = createDeviceEnv({ navigator: {} });
  assert.equal(createOnlineSensor({ env }).read().status, 'unsupported');
  assert.equal(createNetworkSensor({ env }).read().status, 'unsupported');
  assert.equal((await createBatterySensor({ env }).start()).status, 'unsupported');
});
