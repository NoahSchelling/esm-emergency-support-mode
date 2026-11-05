// Browser check with Playwright (Chromium): fake geolocation and dispatched
// devicemotion/deviceorientation events against the demo page.
// Skipped automatically when Playwright is not installed.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { networkInterfaces } from 'node:os';
import { fileURLToPath } from 'node:url';
import { dirname, join, normalize, extname } from 'node:path';

const require = createRequire(import.meta.url);
let playwright = null;
try {
  playwright = require('playwright');
} catch {
  // not available
}
const skip = playwright ? false : 'playwright is not available';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.json': 'application/json' };
let server;
let port;
let browser;

before(async () => {
  if (skip) return;
  server = createServer(async (req, res) => {
    const path = normalize(decodeURIComponent(new URL(req.url, 'http://x').pathname)).replace(/^([/\\])+/, '');
    if (path.startsWith('..')) return res.writeHead(403).end();
    try {
      const body = await readFile(join(root, path));
      res.writeHead(200, { 'content-type': TYPES[extname(path)] ?? 'application/octet-stream' }).end(body);
    } catch {
      res.writeHead(404).end();
    }
  });
  await new Promise((r) => server.listen(0, '0.0.0.0', r));
  port = server.address().port;
  browser = await playwright.chromium.launch();
});

after(async () => {
  await browser?.close();
  await new Promise((r) => (server ? server.close(r) : r()));
});

async function readJson(page, id) {
  return JSON.parse((await page.textContent(`#${id}`)) || 'null');
}

// Fictional test coordinates (round-number grid point).
const GEO = { latitude: 35.0, longitude: 135.0, accuracy: 30 };

const SENSOR_PERMISSIONS = ['geolocation', 'accelerometer', 'gyroscope', 'magnetometer'];

test('device mode on localhost (secure): geolocation and dispatched sensor events', { skip }, async () => {
  const context = await browser.newContext({ geolocation: GEO, permissions: SENSOR_PERMISSIONS });
  const page = await context.newPage();
  await page.goto(`http://127.0.0.1:${port}/demo/index.html`);
  await page.click('#start-device');

  await page.click('#locate');
  await page.waitForFunction(() => document.querySelector('#out-location').textContent.includes('"ok"'));
  const loc = await readJson(page, 'out-location');
  assert.equal(loc.status, 'ok');
  assert.equal(loc.source, 'device');
  assert.equal(loc.value.latitude, 35);
  assert.equal(loc.value.longitude, 135);
  assert.equal(loc.value.accuracy_m, 30);

  await page.click('#perm');
  await page.waitForFunction(() => document.querySelector('#out-perm').textContent.length > 0);
  const perm = await readJson(page, 'out-perm');
  // Recent Chromium also has requestPermission() and answers "granted".
  assert.equal(perm.motion.status, 'ok', perm.motion.detail);
  assert.ok(['granted', 'not_required'].includes(perm.motion.value.permission));
  assert.equal(perm.orientation.status, 'ok', perm.orientation.detail);

  await page.click('#peak-start');
  await page.evaluate(() => {
    for (const x of [1, -5, 2]) {
      window.dispatchEvent(
        new DeviceMotionEvent('devicemotion', {
          acceleration: { x, y: 0, z: 0 },
          accelerationIncludingGravity: { x, y: 0, z: 9.8 },
          rotationRate: { alpha: 10, beta: 0, gamma: 0 },
          interval: 16,
        }),
      );
    }
    window.dispatchEvent(new DeviceOrientationEvent('deviceorientation', { alpha: 90, beta: 10, gamma: -3, absolute: false }));
  });
  const motion = await page.evaluate(() => globalThis.__sensorDemo.s.motion.read());
  assert.equal(motion.status, 'ok');
  assert.deepEqual(motion.value.acceleration, { x: 2, y: 0, z: 0 });
  assert.equal(motion.value.label, 'この端末が記録した揺れ（震度ではありません）');
  await page.click('#peak-stop');
  const peak = await readJson(page, 'out-peak-rec');
  assert.equal(peak.status, 'ok');
  assert.equal(peak.value.acceleration_max.x, 5);
  assert.equal(peak.value.sample_count, 3);

  const ori = await page.evaluate(() => globalThis.__sensorDemo.s.orientation.read());
  assert.equal(ori.status, 'ok');
  assert.equal(ori.value.alpha_deg, 90);

  // Online/offline notifications.
  await page.evaluate(() => {
    globalThis.__seen = [];
    globalThis.__sensorDemo.s.online.subscribe((r) => globalThis.__seen.push(r.value?.online));
  });
  await context.setOffline(true);
  await page.waitForFunction(() => globalThis.__seen.includes(false));
  assert.equal((await page.evaluate(() => globalThis.__sensorDemo.s.online.read())).value.online, false);
  await context.setOffline(false);
  await page.waitForFunction(() => globalThis.__seen.includes(true));

  // Network / battery: Chromium has both APIs; accept unsupported elsewhere.
  const net = await page.evaluate(() => globalThis.__sensorDemo.s.network.read());
  assert.ok(['ok', 'unsupported'].includes(net.status), net.status);
  const bat = await page.evaluate(() => globalThis.__sensorDemo.s.battery.start());
  assert.ok(['ok', 'unsupported'].includes(bat.status), bat.status);

  // Stale: no motion events for longer than the default 2 s.
  await page.waitForTimeout(2200);
  assert.equal((await page.evaluate(() => globalThis.__sensorDemo.s.motion.read())).status, 'stale');
  await context.close();
});

test('permissions not granted -> "denied" (location, motion, orientation)', { skip }, async () => {
  const context = await browser.newContext();
  const page = await context.newPage();
  await page.goto(`http://127.0.0.1:${port}/demo/index.html`);
  await page.click('#start-device');
  // Headless Chromium answers an unhandled prompt as denied.
  const r = await page.evaluate(() => globalThis.__sensorDemo.s.location.locateOnce());
  assert.equal(r.status, 'denied');
  assert.equal(r.value, null);
  await page.click('#perm');
  await page.waitForFunction(() => document.querySelector('#out-perm').textContent.length > 0);
  const perm = await readJson(page, 'out-perm');
  // Chromium with requestPermission() answers "denied" or "prompt" without the
  // sensor permissions; neither may be reported as ok.
  assert.ok(['denied', 'unknown'].includes(perm.motion.status), perm.motion.detail);
  assert.ok(['denied', 'unknown'].includes(perm.orientation.status), perm.orientation.detail);
  const motion = await page.evaluate(() => globalThis.__sensorDemo.s.motion.read());
  assert.notEqual(motion.status, 'ok');
  assert.equal(motion.value, null);
  assert.notEqual((await page.evaluate(() => globalThis.__sensorDemo.s.motion.peak(5))).status, 'ok');
  await context.close();
});

test('replay mode in the browser reports source "simulated"', { skip }, async () => {
  const context = await browser.newContext();
  const page = await context.newPage();
  await page.goto(`http://127.0.0.1:${port}/demo/index.html`);
  await page.click('#start-replay');
  await page.click('#perm');
  await page.waitForFunction(() => document.querySelector('#out-motion').textContent.includes('"ok"'), null, { timeout: 5000 });
  const m = await readJson(page, 'out-motion');
  assert.equal(m.source, 'simulated');
  const loc = await readJson(page, 'out-location');
  assert.equal(loc.source, 'simulated');
  await context.close();
});

function lanAddress() {
  for (const list of Object.values(networkInterfaces())) {
    for (const a of list ?? []) if (a.family === 'IPv4' && !a.internal) return a.address;
  }
  return null;
}

test('plain HTTP on a non-local address -> "insecure"', { skip: skip || (lanAddress() ? false : 'no LAN address') }, async () => {
  const context = await browser.newContext({ geolocation: GEO, permissions: ['geolocation'] });
  const page = await context.newPage();
  await page.goto(`http://${lanAddress()}:${port}/demo/index.html`);
  assert.equal(await page.evaluate(() => window.isSecureContext), false);
  await page.click('#start-device');
  const r = await page.evaluate(async () => {
    const s = globalThis.__sensorDemo.s;
    return {
      location: await s.location.locateOnce(),
      motion: s.motion.read(),
      perm: await s.motion.requestPermission(),
      orientation: s.orientation.read(),
      battery: await s.battery.start(),
      network: s.network.read(),
      online: s.online.read(),
    };
  });
  for (const [k, v] of Object.entries(r)) assert.equal(v.status, 'insecure', k);
  await context.close();
});
