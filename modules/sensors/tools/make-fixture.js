// Generate fixtures/sample-session.json: a fictional 60-second session.
// Usage (from the repository root): node modules/sensors/tools/make-fixture.js
//
// All values are synthetic. The position is a fictional round-number grid
// point, not anyone's real location. The "shake" is a synthetic sine burst
// (as if the phone were shaken by hand); it is not an earthquake record.

import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const out = join(here, '..', 'fixtures', 'sample-session.json');

// Deterministic pseudo-random numbers (mulberry32) so the output is stable.
function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const rand = rng(20261105);
const noise = (amp) => (rand() * 2 - 1) * amp;
const r3 = (v) => Math.round(v * 1000) / 1000;
const r6 = (v) => Math.round(v * 1e6) / 1e6;

const events = [];
const add = (t_ms, type, data) => events.push(data === undefined ? { t_ms, type } : { t_ms, type, data });

// Position every 5 s, drifting a few metres around the fictional point.
for (let t = 0; t <= 40_000; t += 5000) {
  add(t, 'position', {
    latitude: r6(35.0 + (t / 40_000) * 0.0005),
    longitude: r6(135.0 + noise(0.0002)),
    accuracy: Math.round(20 + rand() * 20),
  });
}

// Motion at 10 Hz. Quiet, a synthetic shake burst at 20-23 s, and a gap at 45-52 s
// (no events) so the value becomes stale.
for (let t = 0; t <= 60_000; t += 100) {
  if (t >= 45_000 && t < 52_000) continue;
  const burst = t >= 20_000 && t < 23_000;
  const amp = burst ? 6 * Math.sin(((t - 20_000) / 3000) * Math.PI) : 0;
  const ax = r3(amp * Math.sin(t / 40) + noise(0.05));
  const ay = r3(amp * 0.5 * Math.cos(t / 55) + noise(0.05));
  const az = r3(noise(0.05));
  add(t, 'devicemotion', {
    acceleration: { x: ax, y: ay, z: az },
    accelerationIncludingGravity: { x: ax, y: r3(ay + 1.2), z: r3(az + 9.73) },
    rotationRate: { alpha: r3(burst ? amp * 20 * Math.sin(t / 70) : noise(0.5)), beta: r3(noise(0.5)), gamma: r3(noise(0.5)) },
    interval: 100,
  });
}

// Orientation at 2 Hz (stops in the same gap).
for (let t = 0; t <= 60_000; t += 500) {
  if (t >= 45_000 && t < 52_000) continue;
  add(t, 'deviceorientation', {
    alpha: r3((90 + t / 1000) % 360),
    beta: r3(30 + noise(1)),
    gamma: r3(noise(1)),
    absolute: false,
  });
}

add(30_000, 'offline');
add(30_000, 'connection', { type: 'none', effectiveType: '4g', downlink: 0, rtt: 0 });
add(40_000, 'online');
add(40_000, 'connection', { type: 'cellular', effectiveType: '3g', downlink: 1.5, rtt: 300 });
add(35_000, 'battery', { level: 0.41, dischargingTime: 5400 });
add(50_000, 'battery', { level: 0.4, dischargingTime: 5100 });

// Stable order: by time, then insertion order.
const ordered = events.map((e, i) => [e, i]).sort((a, b) => a[0].t_ms - b[0].t_ms || a[1] - b[1]).map(([e]) => e);

const recording = {
  format: 'sensor-recording/1',
  description:
    '架空の 60 秒のデータ（tools/make-fixture.js で生成）。位置は架空の座標。20〜23 秒の揺れは手で端末を振った想定の合成波で、地震の記録ではない。45〜52 秒は揺れと向きのイベントが止まる。30〜40 秒はオフライン。',
  start_time: '2026-11-05T10:00:00.000+09:00',
  environment: {
    secure: true,
    geolocation: true,
    geolocation_permission: 'granted',
    motion: true,
    motion_permission: 'prompt',
    orientation: true,
    orientation_permission: 'prompt',
    online: true,
    connection: { type: 'wifi', effectiveType: '4g', downlink: 10, rtt: 50, saveData: false },
    battery: { level: 0.42, charging: false, chargingTime: null, dischargingTime: 5700 },
  },
  events: ordered,
};

writeFileSync(out, JSON.stringify(recording) + '\n');
console.log(`wrote ${out} (${ordered.length} events)`);
