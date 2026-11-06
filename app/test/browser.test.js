// Browser checks of the supporter view with Playwright (Chromium). Skipped
// when Playwright is not installed. Set APP_SCREENSHOT_DIR to save
// screenshots (outside the repo).
//
// Positions are a public facility (Shizuoka Prefectural Office, approximate)
// and a fictional round-number grid point.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { createAppServer } from '../serve.js';
import { makeMockStatus } from '../lib/announcements.js';

const require = createRequire(import.meta.url);
let playwright = null;
try {
  playwright = require('playwright');
} catch {
  // not available
}
const skip = playwright ? false : 'playwright is not available';
const SHOTS = process.env.APP_SCREENSHOT_DIR || null;
// PW_CHANNEL=chrome (or msedge) uses an installed browser instead of the
// Chromium bundled with Playwright.
const CHANNEL = process.env.PW_CHANNEL || undefined;

const PREF_OFFICE = { latitude: 34.9769, longitude: 138.3831, accuracy: 20 };
const FICTIONAL = { latitude: 35.0, longitude: 135.0, accuracy: 30 };
const PERMS = ['geolocation', 'accelerometer', 'gyroscope', 'magnetometer'];

let browser;
const servers = [];
let caLive = true;
let caBase;

function listen(server) {
  servers.push(server);
  return new Promise((r) => server.listen(0, '127.0.0.1', () => r(server.address().port)));
}

before(async () => {
  if (skip) return;
  // Fake C-A server: live-shaped status built from fictional entries.
  const caPort = await listen(createServer((req, res) => {
    if (!caLive) return res.writeHead(503).end();
    const st = makeMockStatus(Date.now(), 2);
    st.source = { mode: 'live', reason: null, detail: null };
    st.recent = st.recent.map((e, i) => ({ ...e, mock: false, title: `試験用の電文${i + 1}`, author: '試験用官署', link: 'https://example.invalid/test.xml' }));
    st.latest = st.recent[0];
    res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(st));
  }));
  const noCa = await listen(createAppServer());
  const withCa = await listen(createAppServer({ ca: `http://127.0.0.1:${caPort}` }));
  caBase = `http://127.0.0.1:${withCa}`;
  globalThis.__base = `http://127.0.0.1:${noCa}`;
  browser = await playwright.chromium.launch(CHANNEL ? { channel: CHANNEL } : {});
});

after(async () => {
  await browser?.close();
  await Promise.all(servers.map((s) => new Promise((r) => s.close(r))));
});

async function open(url, opts = {}) {
  const context = await browser.newContext({ permissions: PERMS, geolocation: PREF_OFFICE, ...opts });
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto(url);
  // Wait for both scripts: evac-main.js shows the evacuee view when it loads,
  // so switching earlier could be undone.
  await page.waitForFunction(() => globalThis.__app && globalThis.__evac);
  // The evacuee view is the default; these checks are for the supporter view.
  await page.click('#tab-support');
  assert.equal(await page.isVisible('#view-support'), true);
  assert.equal(await page.isVisible('#view-evac'), false);
  return { context, page, errors };
}

const text = (page, sel) => page.textContent(sel);

// WCAG contrast ratio between two computed "rgb(...)" colors.
function contrast(a, b) {
  const lum = (c) => {
    const [r, g, bl] = c.match(/\d+(\.\d+)?/g).slice(0, 3).map(Number).map((v) => {
      const s = v / 255;
      return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
    });
    return 0.2126 * r + 0.7152 * g + 0.0722 * bl;
  };
  const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p);
  return (x + 0.05) / (y + 0.05);
}

for (const width of [375, 1200]) {
  for (const colorScheme of ['light', 'dark']) {
    test(`layout ${width}px ${colorScheme}: no horizontal scroll, readable`, { skip }, async () => {
      const { context, page, errors } = await open(`${globalThis.__base}/app/`, { viewport: { width, height: 900 }, colorScheme });
      await page.click('#btn-locate');
      await page.waitForFunction(() => document.querySelector('#sec-area').dataset.status === 'ok');
      await page.fill('#frag-input', '0846 M5.5 d50km 最大5弱');
      await page.click('#btn-frag');
      await page.click('#mode-controls summary');
      const m = await page.evaluate(() => ({
        sw: document.documentElement.scrollWidth,
        iw: window.innerWidth,
      }));
      assert.ok(m.sw <= m.iw, `scrollWidth ${m.sw} > ${m.iw}`);
      // Contrast of body text and every badge (AA, 4.5:1).
      const pairs = await page.evaluate(() => {
        const out = [];
        const bodyBg = getComputedStyle(document.body).backgroundColor;
        out.push(['body', getComputedStyle(document.body).color, bodyBg]);
        for (const e of document.querySelectorAll('.badge, .detail, .note, .banner, button')) {
          if (!e.offsetParent && !e.classList.contains('banner')) continue;
          const cs = getComputedStyle(e);
          const bg = cs.backgroundColor === 'rgba(0, 0, 0, 0)' ? bodyBg : cs.backgroundColor;
          out.push([e.className || e.tagName, cs.color, bg]);
        }
        return out;
      });
      for (const [name, fg, bg] of pairs) {
        assert.ok(contrast(fg, bg) >= 4.5, `${name}: ${fg} on ${bg} = ${contrast(fg, bg).toFixed(2)}`);
      }
      if (SHOTS) await page.screenshot({ path: join(SHOTS, `app-${width}-${colorScheme}.png`), fullPage: true });
      assert.deepEqual(errors, []);
      await context.close();
    });
  }
}

test('area: spoofed position switches between determined, outside and denied', { skip }, async () => {
  const { context, page } = await open(`${globalThis.__base}/app/`);
  assert.match(await text(page, '#area-status'), /まだ位置を取っていません/);
  await page.click('#btn-locate');
  await page.waitForFunction(() => document.querySelector('#sec-area').dataset.status === 'ok');
  assert.match(await text(page, '#area-lines'), /静岡葵区/);
  assert.match(await text(page, '#area-attribution'), /気象庁/);
  // Coordinates are never shown on the screen.
  assert.doesNotMatch(await page.textContent('body'), /34\.97|138\.38/);

  await context.setGeolocation(FICTIONAL);
  await page.click('#btn-locate');
  await page.waitForFunction(() => document.querySelector('#sec-area').dataset.status === 'unknown');
  assert.match(await text(page, '#area-detail'), /判定できません/);
  assert.match(await text(page, '#area-badge'), /分からない/);

  await context.clearPermissions();
  await page.click('#btn-locate');
  await page.waitForFunction(() => document.querySelector('#sec-area').dataset.status === 'denied');
  assert.equal(await text(page, '#area-badge'), '許可なし');
  assert.match(await text(page, '#area-detail'), /安全という意味ではありません/);
  assert.equal(await page.getAttribute('tr[data-sensor=location]', 'data-status'), 'denied');
  await context.close();
});

test('motion: permission button, dispatched events, then stale', { skip }, async () => {
  const { context, page } = await open(`${globalThis.__base}/app/`);
  assert.equal(await text(page, '#h-motion'), 'この端末が記録した揺れ（震度ではありません）');
  await page.click('#btn-perm');
  await page.waitForFunction(() => globalThis.__app.sensors.motion);
  const fire = () => page.evaluate(() => {
    for (let i = 0; i < 5; i++) {
      window.dispatchEvent(new DeviceMotionEvent('devicemotion', {
        acceleration: { x: 0.2 * i, y: 0.1, z: -0.1 },
        accelerationIncludingGravity: { x: 0.2, y: 0.1, z: 9.8 },
        rotationRate: { alpha: 1, beta: 2, gamma: 3 },
        interval: 16,
      }));
    }
    // main.js listens to "deviceorientationabsolute" when the browser has it
    // (Chrome), and to "deviceorientation" otherwise.
    const absolute = 'ondeviceorientationabsolute' in globalThis;
    window.dispatchEvent(new DeviceOrientationEvent(absolute ? 'deviceorientationabsolute' : 'deviceorientation', { alpha: 90, beta: 10, gamma: -3, absolute }));
  });
  await fire();
  await page.waitForFunction(() => document.querySelector('#sec-motion').dataset.status === 'ok');
  const lines = await text(page, '#motion-lines');
  assert.match(lines, /m\/s²/);
  assert.match(lines, /直近の最大値/);
  assert.equal(await page.getAttribute('tr[data-sensor=motion]', 'data-status'), 'ok');
  assert.equal(await page.getAttribute('tr[data-sensor=orientation]', 'data-status'), 'ok');
  // No new events for longer than staleAfterSec (2 s) -> stale, not "ok".
  await page.waitForFunction(() => document.querySelector('#sec-motion').dataset.status === 'stale', null, { timeout: 6000 });
  assert.match(await text(page, '#motion-badge'), /古い/);
  assert.equal(await page.getAttribute('tr[data-sensor=motion]', 'data-status'), 'stale');
  await context.close();
});

test('announcements: simulated data is always labelled', { skip }, async () => {
  const { context, page } = await open(`${globalThis.__base}/app/`);
  await page.waitForFunction(() => document.querySelector('#sec-ann').dataset.status === 'ok');
  assert.equal(await page.getAttribute('#sec-ann', 'data-source'), 'simulated');
  assert.equal(await page.isVisible('#ann-mock'), true);
  assert.equal(await page.isVisible('#sim-banner'), true);
  assert.match(await text(page, '#ann-latest'), /【模擬データ】/);
  const before = await page.$$eval('#ann-recent li', (l) => l.length);
  await page.click('#btn-ann-mock');
  const afterCount = await page.$$eval('#ann-recent li', (l) => l.length);
  assert.equal(afterCount, Math.min(before + 1, 5));
  await context.close();
});

test('announcements: relayed from C-A, then link lost -> stale, never mock', { skip }, async () => {
  caLive = true;
  const { context, page } = await open(`${caBase}/app/`);
  await page.waitForFunction(() => document.querySelector('#sec-ann').dataset.status === 'ok');
  assert.equal(await page.getAttribute('#sec-ann', 'data-source'), 'jma');
  assert.equal(await page.isVisible('#ann-mock'), false);
  assert.match(await text(page, '#ann-origin'), /試作 C-A/);
  assert.match(await text(page, '#ann-latest'), /試験用の電文1/);
  caLive = false;
  await page.evaluate(() => globalThis.__app.pollAnnouncements());
  await page.waitForFunction(() => document.querySelector('#sec-ann').dataset.status === 'stale');
  assert.match(await text(page, '#ann-detail'), /受け取れていません/);
  assert.equal(await page.getAttribute('#sec-ann', 'data-source'), 'jma');
  caLive = true;
  await context.close();
});

test('fragment: your report (unconfirmed), unknown is not safe, readings are all shown', { skip }, async () => {
  const { context, page } = await open(`${globalThis.__base}/app/`);
  assert.match(await text(page, '#sec-frag'), /あなたの申告（未確認）/);
  await page.fill('#frag-input', '揺れた');
  await page.click('#btn-frag');
  assert.equal(await page.getAttribute('#sec-frag', 'data-status'), 'unknown');
  assert.match(await text(page, '#frag-status'), /安全・異常なしという意味ではありません/);
  await page.fill('#frag-input', '5弱');
  await page.click('#btn-frag');
  assert.equal(await page.getAttribute('#sec-frag', 'data-status'), 'ok');
  assert.equal(await page.$$eval('#frag-lines li', (l) => l.filter((x) => /^読み方 \d/.test(x.textContent)).length), 2);
  await context.close();
});

test('mode: simulated announcement switches to emergency with a reason', { skip }, async () => {
  const { context, page } = await open(`${globalThis.__base}/app/`);
  assert.equal(await page.getAttribute('#sec-mode', 'data-mode'), 'normal');
  assert.match(await text(page, '#mode-lines'), /安全という意味ではありません/);
  await page.click('#mode-controls summary');
  await page.click('button[data-sim=tsunami_warning]');
  assert.equal(await page.getAttribute('#sec-mode', 'data-mode'), 'emergency');
  assert.equal(await text(page, '#mode-label'), '緊急');
  assert.match(await text(page, '#mode-reason'), /津波警報.*（模擬の入力）/);
  await page.click('button[data-request=set_normal]');
  assert.match(await text(page, '#mode-last'), /許可なし|denied|下限/);
  assert.equal(await page.isVisible('#sim-banner'), true);
  await context.close();
});

test('missing modules show 未実装 and the page keeps working', { skip }, async () => {
  const { context, page, errors } = await open(`${globalThis.__base}/app/?without=sensors,area,mode,fragment,advice`);
  await page.waitForFunction(() => document.querySelector('#sec-frag').dataset.status === 'missing');
  assert.equal(await text(page, '#frag-badge'), '未実装');
  assert.equal(await text(page, '#mode-badge'), '未実装');
  assert.equal(await text(page, '#motion-badge'), '未実装');
  assert.equal(await page.getAttribute('#sec-area', 'data-status'), 'missing');
  assert.equal(await page.$$eval('#sensor-rows tr', (r) => r.every((x) => x.dataset.status === 'missing')), true);
  assert.match(await text(page, '#policy-text'), /行いません/);
  // Announcements still work (simulated).
  await page.waitForFunction(() => document.querySelector('#sec-ann').dataset.status === 'ok');
  assert.deepEqual(errors, []);
  await context.close();
});
