// Browser checks of the shell (menu, theme, alert border, demos, current-
// location mode) with Playwright. Skipped when Playwright is not installed.
// PW_CHANNEL=chrome uses an installed Chrome. APP_SCREENSHOT_DIR saves
// screenshots (outside the repository).
//
// Positions: the Shizuoka prefectural office (approximate) and the fictional
// Yaizu demo point computed from the coast data (about 560 m from the coast).
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { createAppServer } from '../serve.js';

const require = createRequire(import.meta.url);
let playwright = null;
try {
  playwright = require('playwright');
} catch {
  // not available
}
const skip = playwright ? false : 'playwright is not available';
const SHOTS = process.env.APP_SCREENSHOT_DIR || null;
const CHANNEL = process.env.PW_CHANNEL || undefined;
const PREF_OFFICE = { latitude: 34.9769, longitude: 138.3831, accuracy: 20 };
const YAIZU_POINT = { latitude: 34.86, longitude: 138.32, accuracy: 20 };

let browser;
const servers = [];
let base;
let baseCa;
let caTsunami = '大津波警報';

function listen(s) {
  servers.push(s);
  return new Promise((r) => s.listen(0, '127.0.0.1', () => r(s.address().port)));
}

before(async () => {
  if (skip) return;
  base = `http://127.0.0.1:${await listen(createAppServer())}`;
  // Fake C-A: a live-shaped status with one tsunami message for Shizuoka (fictional).
  const ca = createServer((req, res) => {
    const t = Date.now();
    const items = caTsunami ? [{ type: '津波予報', area_code: '380', area_name: '静岡県', kinds: [{ name: caTsunami, status: null }] }] : [];
    const e = { id: 'urn:test:1', title: '津波警報・注意報・予報a', updated: t, author: '気象庁', link: null, mock: false,
      detail: { status: '通常', title: '津波警報・注意報・予報a', report_datetime: t, items } };
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ server_time: t, source: { mode: 'live' }, stale_after: 600, last_received_at: t, latest: e, recent: [e] }));
  });
  const caPort = await listen(ca);
  baseCa = `http://127.0.0.1:${await listen(createAppServer({ ca: `http://127.0.0.1:${caPort}` }))}`;
  browser = await playwright.chromium.launch(CHANNEL ? { channel: CHANNEL } : {});
});

after(async () => {
  await browser?.close();
  for (const s of servers) s.close();
});

async function open(t, { query = '', width = 375, height = 800, scheme = 'light', geo = PREF_OFFICE, server = null } = {}) {
  const ctx = await browser.newContext({ viewport: { width, height }, colorScheme: scheme, geolocation: geo, permissions: ['geolocation'] });
  t.after(() => ctx.close());
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  const requests = [];
  page.on('request', (r) => requests.push(r.url()));
  await page.goto(`${server ?? base}/app/${query}`);
  await page.waitForFunction(() => globalThis.__shell && globalThis.__evac);
  return { page, errors, requests };
}

const shell = (page) => page.evaluate(() => {
  const s = globalThis.__shell.state;
  const f = document.getElementById('alert-frame');
  const cs = getComputedStyle(f);
  return {
    mode: s.mode, level: s.state.level, imminent: s.state.imminent, blink: s.state.blink, detail: s.state.detail,
    frameLevel: f.dataset.level, animation: cs.animationName, frameWidth: cs.borderTopWidth,
    frameColorVar: f.style.getPropertyValue('--frame-color'),
    text: document.body.innerText,
  };
});

async function shot(page, name) {
  if (SHOTS) await page.screenshot({ path: join(SHOTS, `${name}.png`), fullPage: false });
}

test('default: current location; no C-A -> unknown, border shows the background', { skip }, async (t) => {
  const { page, errors } = await open(t);
  await page.waitForTimeout(500);
  const s = await shell(page);
  assert.equal(s.mode, 'live');
  assert.equal(s.frameLevel, 'unknown');
  assert.equal(s.frameWidth, '10px');
  assert.equal(s.animation, 'none');
  assert.match(s.text, /公的な発表を受け取れていません。警報が出ていないという意味ではありません/);
  assert.equal(await page.isVisible('#demo-box'), false);
  assert.deepEqual(errors.filter((e) => /shell|evac/.test(e)), []);
});

test('menu: opens, lists the modes and themes, chooses a demo', { skip }, async (t) => {
  const { page } = await open(t);
  assert.equal(await page.isVisible('#menu-panel'), false);
  await page.click('#menu-button');
  assert.equal(await page.getAttribute('#menu-button', 'aria-expanded'), 'true');
  assert.equal(await page.locator('[data-mode-choice]').count(), 5);
  assert.equal(await page.locator('[data-theme-choice]').count(), 3);
  await page.click('[data-mode-choice="tokyo"]');
  assert.equal(await page.isVisible('#menu-panel'), false);
  const s = await shell(page);
  assert.equal(s.mode, 'tokyo');
  assert.match(s.text, /【過去の記録の再生】/);
  assert.match(s.text, /いま出ている発表ではありません/);
});

test('Fukushima record: major tsunami warning near the coast blinks hard (1 s, no fade)', { skip }, async (t) => {
  const { page } = await open(t, { query: '?demo=fukushima&demostep=300' });
  await page.waitForFunction(() => globalThis.__shell.state.state.level === 5, null, { timeout: 5000 });
  // the evacuee view redraws every 250 ms
  await page.waitForFunction(() => /避難場所のデータがありません/.test(document.getElementById('view-evac').innerText), null, { timeout: 2000 });
  const s = await shell(page);
  assert.equal(s.imminent, true);
  assert.equal(s.blink, 'hard1s');
  assert.equal(s.animation, 'frame-hard');
  assert.equal(s.frameColorVar, '#AA00AA');
  assert.match(s.text, /このデモには避難場所のデータがありません/);
  await shot(page, 'shell-fukushima');
  // at the end everything is lifted
  await page.waitForFunction(() => globalThis.__shell.state.inp.replay.finished, null, { timeout: 8000 });
  const end = await shell(page);
  assert.equal(end.level, 0);
  assert.equal(end.animation, 'none');
});

test('Tokyo record: heavy-rain special warning is purple with a 3 s fade', { skip }, async (t) => {
  const { page } = await open(t, { query: '?demo=tokyo&demostep=300' });
  await page.waitForFunction(() => globalThis.__shell.state.state.level === 5, null, { timeout: 6000 });
  const s = await shell(page);
  assert.equal(s.imminent, false);
  assert.equal(s.blink, 'fade3s');
  assert.equal(s.animation, 'frame-fade');
  assert.equal(s.frameColorVar, '#AA00AA');
  assert.match(s.text, /大雨特別警報/);
  await shot(page, 'shell-tokyo');
});

test('Chiba record: warnings are red, the sediment disaster alert is purple, steady', { skip }, async (t) => {
  const { page } = await open(t, { query: '?demo=chiba&demostep=400' });
  await page.waitForFunction(() => globalThis.__shell.state.state.level === 3, null, { timeout: 3000 });
  assert.equal((await shell(page)).frameColorVar, '#FF2800');
  await page.waitForFunction(() => globalThis.__shell.state.state.level === 4, null, { timeout: 4000 });
  const s = await shell(page);
  assert.equal(s.frameColorVar, '#AA00AA');
  assert.equal(s.animation, 'none');
});

test('Shizuoka simulated: the evacuee view shows a site from the demo point', { skip }, async (t) => {
  const { page } = await open(t, { query: '?demo=shizuoka&demostep=60000' });
  await page.waitForFunction(() => globalThis.__evac.result?.status === 'ok', null, { timeout: 5000 });
  const s = await shell(page);
  assert.equal(s.imminent, true);
  assert.equal(s.animation, 'frame-hard');
  const r = await page.evaluate(() => globalThis.__evac.result);
  assert.equal(r.source, 'simulated');
  assert.ok(r.value.candidates[0].hazards.includes('津波'));
  assert.match(s.text, /【模擬】津波警報（模擬・静岡県）/);
  await shot(page, 'shell-shizuoka');
});

test('current location with C-A: official major tsunami warning near the coast', { skip }, async (t) => {
  caTsunami = '大津波警報';
  const { page, requests } = await open(t, { server: baseCa, geo: YAIZU_POINT });
  await page.click('#evac-start');
  await page.waitForFunction(() => globalThis.__shell.state.state.imminent === true, null, { timeout: 8000 });
  await page.waitForFunction(() => /気象庁の発表：大津波警報/.test(document.getElementById('view-evac').innerText), null, { timeout: 2000 });
  const s = await shell(page);
  assert.equal(s.level, 5);
  assert.match(s.text, /公的情報の受信：1 分以内/);
  assert.equal(s.animation, 'frame-hard');
  assert.match(s.text, /気象庁の発表：大津波警報（静岡県）/);
  await page.waitForFunction(() => globalThis.__evac.result?.status === 'ok', null, { timeout: 8000 });
  // the position is not sent: same-origin requests only, no coordinates in URLs
  for (const u of requests) assert.ok(u.startsWith(baseCa), u);
  assert.ok(!requests.some((u) => /34\.86|138\.32/.test(u)));
});

test('current location with C-A, far from the coast: level only, no imminent blink', { skip }, async (t) => {
  caTsunami = '大津波警報';
  const { page } = await open(t, { server: baseCa, geo: PREF_OFFICE });
  await page.click('#evac-start');
  await page.waitForFunction(() => globalThis.__shell.state.state.level === 5, null, { timeout: 8000 });
  const s = await shell(page);
  assert.equal(s.imminent, false);
  assert.equal(s.animation, 'frame-fade');
});

test('theme switch: light / dark override the device, kept after reload', { skip }, async (t) => {
  const { page } = await open(t, { scheme: 'light' });
  const bg = () => page.evaluate(() => getComputedStyle(document.body).backgroundColor);
  const light = await bg();
  await page.click('#menu-button');
  await page.click('[data-theme-choice="dark"]');
  const dark = await bg();
  assert.notEqual(dark, light);
  assert.equal(await page.evaluate(() => document.documentElement.dataset.theme), 'dark');
  await page.reload();
  await page.waitForFunction(() => globalThis.__shell);
  assert.equal(await bg(), dark);
  await page.click('#menu-button');
  await page.click('[data-theme-choice="auto"]');
  assert.equal(await bg(), light);
});

function luminance([r, g, b]) {
  const f = (c) => { c /= 255; return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4; };
  return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
}
function contrast(a, b) {
  const [x, y] = [luminance(a), luminance(b)].sort((p, q) => q - p);
  return (x + 0.05) / (y + 0.05);
}

for (const width of [375, 1200]) {
  for (const theme of ['light', 'dark']) {
    test(`layout ${width}px ${theme} theme: menu, status and demo readable, no horizontal scroll`, { skip }, async (t) => {
      const { page } = await open(t, { width, query: '?demo=tokyo&demostep=60000', scheme: theme === 'dark' ? 'light' : 'dark' });
      await page.click('#menu-button');
      await page.click(`[data-theme-choice="${theme}"]`);
      await page.click('#menu-button');
      await page.waitForTimeout(200);
      const m = await page.evaluate(() => ({ sw: document.documentElement.scrollWidth, cw: document.documentElement.clientWidth }));
      assert.ok(m.sw <= m.cw, `horizontal scroll ${m.sw} > ${m.cw}`);
      const items = await page.evaluate(() => {
        const parse = (s) => (s.match(/\d+(\.\d+)?/g) || []).slice(0, 4).map(Number);
        const bgOf = (el) => {
          for (let e = el; e; e = e.parentElement) {
            const c = parse(getComputedStyle(e).backgroundColor);
            if (c.length === 3 || (c.length === 4 && c[3] > 0)) return c.slice(0, 3);
          }
          return parse(getComputedStyle(document.body).backgroundColor).slice(0, 3);
        };
        const out = [];
        for (const el of document.querySelectorAll('.topbar *, #menu-panel *, #status-line *, #demo-box *')) {
          if (!el.offsetParent) continue;
          if (![...el.childNodes].some((n) => n.nodeType === 3 && n.textContent.trim())) continue;
          out.push({ id: el.id, tag: el.tagName, fg: parse(getComputedStyle(el).color).slice(0, 3), bg: bgOf(el) });
        }
        const btns = [...document.querySelectorAll('#menu-button, #menu-panel button')].filter((b) => b.offsetParent).map((b) => b.getBoundingClientRect().height);
        return { out, btns };
      });
      assert.ok(items.out.length > 10);
      for (const it of items.out) {
        const c = contrast(it.fg, it.bg);
        assert.ok(c >= 4.5, `${it.tag}#${it.id}: ${c.toFixed(2)}`);
        const [r, g, b] = it.fg;
        assert.ok(!(g > r + 40 && g > b + 40), `green text ${it.fg}`);
      }
      for (const h of items.btns) assert.ok(h >= 48, `button height ${h}`);
      await shot(page, `shell-layout-${width}-${theme}`);
    });
  }
}
