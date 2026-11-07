// Browser checks of the shell (menu, panes, notices, alert border, demos,
// current-location mode, consent, heights, history, handoff memo) with
// Playwright. Skipped when Playwright is not installed. PW_CHANNEL=chrome
// uses an installed Chrome. APP_SCREENSHOT_DIR saves screenshots (outside
// the repository). External lookups are answered by fakes (no network).
//
// Positions: the Shizuoka prefectural office (approximate) and the fictional
// Yaizu demo point computed from the coast data (about 560 m from the coast).
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import zlib from 'node:zlib';
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
const ELEV = 'https://cyberjapandata2.gsi.go.jp/general/dem/scripts/getelevation.php?';

// 1x1 RGBA PNGs (scaled up when drawn): opaque pink (inside) / transparent (outside).
function png1x1([r, g, b, a]) {
  const chunk = (type, data) => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const td = Buffer.concat([Buffer.from(type, 'ascii'), data]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(zlib.crc32(td));
    return Buffer.concat([len, td, crc]);
  };
  const ihdr = Buffer.from([0, 0, 0, 1, 0, 0, 0, 1, 8, 6, 0, 0, 0]);
  const idat = zlib.deflateSync(Buffer.from([0, r, g, b, a]));
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', idat), chunk('IEND', Buffer.alloc(0))]);
}
const PNG_INSIDE = png1x1([255, 216, 192, 255]);
const PNG_OUTSIDE = png1x1([0, 0, 0, 0]);

let browser;
const servers = [];
let base;
let baseCa;
let caTsunami = '大津波警報';
let tileInside = true;

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
    const items = caTsunami ? [{ type: '津波予報', area_code: '380', area_name: '静岡県', kinds: [{ name: caTsunami, status: null }],
      max_height: { description: '５ｍ', value_m: 5, unbounded: false } }] : [];
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

async function open(t, { query = '', width = 375, height = 800, scheme = 'light', geo = PREF_OFFICE, server = null, hasTouch = false } = {}) {
  const ctx = await browser.newContext({
    viewport: { width, height }, colorScheme: scheme, geolocation: geo, hasTouch, acceptDownloads: true,
    permissions: ['geolocation', 'clipboard-read', 'clipboard-write'],
  });
  t.after(() => ctx.close());
  await ctx.route('https://cyberjapandata2.gsi.go.jp/**', (r) => r.fulfill({ json: { elevation: 2.5, hsrc: '5m（写真測量）' } }));
  await ctx.route('https://disaportaldata.gsi.go.jp/**', (r) => r.fulfill({ status: 200, contentType: 'image/png', body: tileInside ? PNG_INSIDE : PNG_OUTSIDE }));
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  const requests = [];
  page.on('request', (r) => requests.push(r.url()));
  await page.goto(`${server ?? base}/app/${query}`);
  await page.waitForFunction(() => globalThis.__shell && globalThis.__evac && globalThis.__handoff);
  return { page, errors, requests };
}

const shell = (page) => page.evaluate(() => {
  const s = globalThis.__shell.state;
  const f = document.getElementById('alert-frame');
  const cs = getComputedStyle(f);
  return {
    mode: s.mode, level: s.state.level, imminent: s.state.imminent, blink: s.state.blink, detail: s.state.detail, basis: s.state.basis,
    frameLevel: f.dataset.level, animation: cs.animationName, frameWidth: cs.borderTopWidth,
    frameColorVar: f.style.getPropertyValue('--frame-color'),
    // the current alert text lives in the second pane (hidden by default)
    text: `${document.body.innerText}\n${document.getElementById('pane-alert').textContent}`,
  };
});

async function shot(page, name) {
  if (SHOTS) await page.screenshot({ path: join(SHOTS, `${name}.png`), fullPage: false });
}

function luminance([r, g, b]) {
  const f = (c) => { c /= 255; return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4; };
  return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
}
function contrast(a, b) {
  const [x, y] = [luminance(a), luminance(b)].sort((p, q) => q - p);
  return (x + 0.05) / (y + 0.05);
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
  assert.equal(await page.isVisible('#menu-button'), true);
  assert.deepEqual(errors.filter((e) => /shell|evac|handoff/.test(e)), []);
});

test('menu: 8 items in order, demo place and ON/OFF toggle, no theme switch', { skip }, async (t) => {
  const { page } = await open(t);
  assert.equal(await page.isVisible('#menu-panel'), false);
  await page.click('#menu-button');
  assert.equal(await page.getAttribute('#menu-button', 'aria-expanded'), 'true');
  const items = await page.$$eval('#menu-panel > details.menu-item > summary', (els) => els.map((e) => e.textContent.trim()));
  assert.deepEqual(items, ['事前情報収集', '避難者／支援者の切り替え', 'これまでの情報履歴', '記録の出典', '公的機関のウェブサイトリンク', '公的機関の連絡先', '独自情報の情報取得URL', 'デモモード']);
  assert.equal(await page.locator('[data-theme-choice]').count(), 0);
  await page.click('#menu-demo summary');
  assert.equal(await page.locator('[data-demo-place]').count(), 4);
  await page.click('[data-demo-place="tokyo"]');
  assert.equal((await shell(page)).mode, 'live'); // choosing a place alone does not start the demo
  await page.click('#demo-toggle');
  assert.equal(await page.isVisible('#menu-panel'), false);
  let s = await shell(page);
  assert.equal(s.mode, 'tokyo');
  assert.match(s.text, /【過去の記録の再生】/);
  assert.match(s.text, /いま出ている発表ではありません/);
  assert.equal(await page.isVisible('#demo-strip'), true);
  await page.click('#menu-button');
  assert.equal(await page.getAttribute('#demo-toggle', 'aria-pressed'), 'true');
  await page.click('#demo-toggle');
  s = await shell(page);
  assert.equal(s.mode, 'live');
  assert.equal(await page.isVisible('#demo-strip'), false);
  // links and contacts: sources and the checked date are on the screen
  await page.click('#menu-button');
  await page.click('#menu-contacts summary');
  const contacts = await page.textContent('#contacts-list');
  assert.match(contacts, /119/);
  assert.match(contacts, /2026-11-07 確認/);
  assert.ok(await page.locator('#contacts-list a[href^="tel:"]').count() > 20);
  assert.ok(await page.locator('#links-list a[href^="https://"]').count() > 20);
});

test('Fukushima record: inside the inundation estimate, the major tsunami warning blinks hard (1 s, no fade)', { skip }, async (t) => {
  const { page } = await open(t, { query: '?demo=fukushima&demostep=300' });
  await page.waitForFunction(() => globalThis.__shell.state.state.level === 5, null, { timeout: 5000 });
  // the evacuee view redraws every 250 ms
  await page.waitForFunction(() => /避難場所のデータがありません/.test(document.getElementById('view-evac').innerText), null, { timeout: 2000 });
  const s = await shell(page);
  assert.equal(s.imminent, true);
  assert.equal(s.basis, 'inundation');
  assert.equal(s.blink, 'hard1s');
  assert.equal(s.animation, 'frame-hard');
  assert.equal(s.frameColorVar, '#AA00AA');
  assert.match(s.text, /このデモには避難場所のデータがありません/);
  assert.match(s.text, /国の津波浸水想定の区域の中です/);
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
  // no consent and no inundation data: the distance guide, labelled as such
  assert.equal(s.basis, 'distance');
  assert.match(s.text, /このアプリの目安です。公的な基準ではありません/);
  // the forecast height from the message is on the main screen
  await page.waitForFunction(() => /５ｍ（大津波警報・静岡県）/.test(document.getElementById('heights').textContent), null, { timeout: 3000 });
  await page.waitForFunction(() => globalThis.__evac.result?.status === 'ok', null, { timeout: 8000 });
  // Without consent the position is not sent: same-origin requests and the
  // elevation of the designated site (public coordinates) only.
  for (const u of requests) assert.ok(u.startsWith(baseCa) || u.startsWith(ELEV), u);
  assert.ok(!requests.some((u) => /lat=34\.860000|lon=138\.320000/.test(u)), 'the position is not sent');
  assert.ok(!requests.some((u) => u.includes('disaportaldata')));
});

test('current location with C-A, far from the coast: level only, no imminent blink', { skip }, async (t) => {
  caTsunami = '大津波警報';
  const { page } = await open(t, { server: baseCa, geo: PREF_OFFICE });
  await page.click('#evac-start');
  await page.waitForFunction(() => globalThis.__shell.state.state.level === 5, null, { timeout: 8000 });
  const s = await shell(page);
  assert.equal(s.imminent, false);
  assert.equal(s.animation, 'frame-fade');
  assert.doesNotMatch(s.detail, /安全です|安全な場所|大丈夫|安心/);
});

test('consent: one consent; then the inundation estimate decides; withdrawing stops sending', { skip }, async (t) => {
  caTsunami = '大津波警報';
  tileInside = true;
  // The prefectural office is ~4.6 km from the coast line: by the distance
  // guide it is not imminent; inside the (fake) estimate it is.
  const { page, requests } = await open(t, { server: baseCa, geo: PREF_OFFICE });
  await page.click('#evac-start');
  await page.waitForFunction(() => globalThis.__shell.state.state.level === 5, null, { timeout: 8000 });
  assert.equal((await shell(page)).imminent, false);
  assert.ok(!requests.some((u) => /34\.97|138\.38/.test(u)));
  assert.match(await page.textContent('#heights'), /同意していないため/);
  await page.click('#menu-button');
  await page.click('#menu-prefetch summary');
  assert.match(await page.textContent('#consent-text'), /国土地理院の標高 API/);
  assert.match(await page.textContent('#consent-stop'), /同意をやめる/);
  await page.click('#consent-toggle');
  await page.waitForFunction(() => globalThis.__shell.state.state.imminent === true, null, { timeout: 8000 });
  assert.equal((await shell(page)).basis, 'inundation');
  await page.waitForFunction(() => /約 2\.5 m/.test(document.getElementById('heights').textContent), null, { timeout: 3000 });
  assert.ok(requests.some((u) => u.startsWith(ELEV) && /lat=34\.97/.test(u)));
  assert.ok(requests.some((u) => u.includes('disaportaldata')));
  assert.ok(await page.evaluate(() => localStorage.getItem('bw-consent-position-lookup') !== null));
  // withdraw
  await page.click('#consent-toggle');
  const n = requests.length;
  await page.waitForTimeout(800);
  assert.equal((await shell(page)).imminent, false);
  assert.equal(await page.evaluate(() => localStorage.getItem('bw-consent-position-lookup')), null);
  assert.ok(!requests.slice(n).some((u) => u.includes('disaportaldata') || /lat=34\.97/.test(u)));
});

test('consent, outside the estimate: no fast blink, no reassuring words', { skip }, async (t) => {
  caTsunami = '大津波警報';
  tileInside = false;
  const { page } = await open(t, { server: baseCa, geo: YAIZU_POINT });
  await page.evaluate(() => localStorage.setItem('bw-consent-position-lookup', JSON.stringify({ granted: true, at: Date.now() })));
  await page.reload();
  await page.waitForFunction(() => globalThis.__shell && globalThis.__evac);
  await page.click('#evac-start');
  await page.waitForFunction(() => globalThis.__shell.state.state.basis === 'inundation', null, { timeout: 8000 });
  const s = await shell(page);
  assert.equal(s.imminent, false);
  assert.equal(s.animation, 'frame-fade');
  assert.doesNotMatch(s.detail, /安全です|安全な場所|大丈夫|安心|区域の外/);
  tileInside = true;
});

test('light only: a dark device setting and an old saved theme still show the light page', { skip }, async (t) => {
  const { page } = await open(t, { scheme: 'dark' });
  const bg = () => page.evaluate(() => getComputedStyle(document.body).backgroundColor);
  assert.equal(await bg(), 'rgb(255, 255, 255)');
  await page.evaluate(() => localStorage.setItem('bw-theme', 'dark'));
  await page.reload();
  await page.waitForFunction(() => globalThis.__shell);
  assert.equal(await bg(), 'rgb(255, 255, 255)');
  assert.equal(await page.evaluate(() => document.documentElement.dataset.theme ?? null), null);
});

for (const width of [375, 1200]) {
  for (const scheme of ['light', 'dark']) {
    test(`layout ${width}px, device ${scheme}: menu, panes, notices readable, no horizontal scroll`, { skip }, async (t) => {
      const { page } = await open(t, { width, query: '?demo=tokyo&demostep=60000', scheme });
      await page.waitForTimeout(300);
      await page.click('#menu-button');
      await page.evaluate(() => { for (const d of document.querySelectorAll('#menu-panel details')) d.open = true; });
      await page.waitForTimeout(200);
      const m = await page.evaluate(() => ({ sw: document.documentElement.scrollWidth, cw: document.documentElement.clientWidth }));
      assert.ok(m.sw <= m.cw, `horizontal scroll ${m.sw} > ${m.cw}`);
      const check = async () => {
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
          for (const el of document.querySelectorAll('.topbar *, #notices *, #demo-strip, #menu-panel *, #pane-main *, #pane-alert *')) {
            if (!el.offsetParent || el.closest('svg') || el.closest('#view-support')) continue;
            if (![...el.childNodes].some((n) => n.nodeType === 3 && n.textContent.trim())) continue;
            out.push({ id: el.id, cls: String(el.className), tag: el.tagName, fg: parse(getComputedStyle(el).color).slice(0, 3), bg: bgOf(el) });
          }
          const btns = [...document.querySelectorAll('#menu-button, #menu-panel button')].filter((b) => b.offsetParent).map((b) => b.getBoundingClientRect().height);
          return { out, btns };
        });
        assert.ok(items.out.length > 10);
        for (const it of items.out) {
          const c = contrast(it.fg, it.bg);
          assert.ok(c >= 4.5, `${it.tag}#${it.id}.${it.cls}: ${c.toFixed(2)}`);
          const [r, g, b] = it.fg;
          assert.ok(!(g > r + 40 && g > b + 40), `green text ${it.fg}`);
        }
        for (const h of items.btns) assert.ok(h >= 48, `button height ${h}`);
      };
      await check();
      await shot(page, `shell-menu-${width}-${scheme}`);
      await page.click('#menu-close');
      await page.click('#pager-next');
      await check();
      await shot(page, `shell-alert-${width}-${scheme}`);
      // Edge buttons: translucent grey glyph, at least 3:1 against the page.
      const btn = await page.evaluate(() => ({
        color: getComputedStyle(document.getElementById('pager-prev')).color,
        bg: getComputedStyle(document.body).backgroundColor,
      }));
      const [r, g, b, a = 1] = (btn.color.match(/\d+(\.\d+)?/g) || []).map(Number);
      const [br, bgc, bb] = (btn.bg.match(/\d+(\.\d+)?/g) || []).map(Number);
      const mix = [r * a + br * (1 - a), g * a + bgc * (1 - a), b * a + bb * (1 - a)];
      assert.ok(a < 1, 'edge button is translucent');
      assert.ok(contrast(mix, [br, bgc, bb]) >= 3, `edge button contrast ${contrast(mix, [br, bgc, bb]).toFixed(2)}`);
    });
  }
}

test('panes: edge buttons and a swipe in the middle switch; a swipe from the edge does not', { skip }, async (t) => {
  const { page } = await open(t, { hasTouch: true, query: '?demo=shizuoka&demostep=60000' });
  const pane = () => page.evaluate(() => globalThis.__shell.pane);
  await page.waitForFunction(() => globalThis.__shell.state.state.level === 3, null, { timeout: 5000 });
  assert.equal(await pane(), 'main');
  assert.equal(await page.isVisible('#pager-prev'), true);
  assert.equal(await page.isVisible('#pager-next'), true);
  await page.click('#pager-next');
  assert.equal(await pane(), 'alert');
  assert.equal(await page.isVisible('#pane-alert'), true);
  assert.match(await page.textContent('#alert-items'), /【模擬】津波警報/);
  assert.match(await page.textContent('#alert-received'), /いま出ている発表ではありません/);
  await page.click('#pager-prev');
  assert.equal(await pane(), 'main');
  const swipe = (x0, x1) => page.evaluate(([a, b]) => {
    const el = document.getElementById('pager');
    const mk = (x) => new Touch({ identifier: 1, target: el, clientX: x, clientY: 400 });
    el.dispatchEvent(new TouchEvent('touchstart', { touches: [mk(a)], changedTouches: [mk(a)], bubbles: true }));
    el.dispatchEvent(new TouchEvent('touchend', { touches: [], changedTouches: [mk(b)], bubbles: true }));
  }, [x0, x1]);
  await swipe(250, 100); // middle, to the left
  assert.equal(await pane(), 'alert');
  await swipe(120, 300); // middle, to the right
  assert.equal(await pane(), 'main');
  await swipe(10, 200); // from the left edge: left to the OS
  assert.equal(await pane(), 'main');
  await swipe(250, 230); // too short
  assert.equal(await pane(), 'main');
});

test('notices: new information at the top, read aloud, stays until closed; history kept and deletable', { skip }, async (t) => {
  const { page } = await open(t, { query: '?demo=shizuoka&demostep=800' });
  await page.waitForSelector('#notices .notice');
  assert.match(await page.textContent('#notices .notice'), /新しい情報：【模擬】津波警報（静岡県） 予想される津波の高さ 3m/);
  assert.equal(await page.getAttribute('#notices .notice', 'role'), 'alert');
  // a newer notice about the same area replaces the older one; nothing disappears by itself
  await page.waitForFunction(() => /10m以上/.test(document.getElementById('notices').textContent), null, { timeout: 5000 });
  await page.waitForTimeout(1500);
  assert.ok(await page.locator('#notices .notice').count() >= 1);
  await page.click('#notices .notice button');
  // history in the menu, kept on this device
  await page.click('#menu-button');
  await page.click('#menu-history summary');
  assert.match(await page.textContent('#history-list'), /【模擬】大津波警報（静岡県） 予想される津波の高さ 6m/);
  assert.ok(await page.evaluate(() => JSON.parse(localStorage.getItem('bw-history')).length >= 3));
  await page.click('#history-clear');
  assert.equal(await page.evaluate(() => localStorage.getItem('bw-history')), null);
  assert.match(await page.textContent('#history-list'), /まだ記録がありません/);
});

test('heights: forecast, elevation, warning marks, terrain note always; map link with the site only', { skip }, async (t) => {
  const { page } = await open(t, { query: '?demo=shizuoka&demostep=60000' });
  await page.waitForFunction(() => globalThis.__evac.result?.status === 'ok', null, { timeout: 5000 });
  await page.waitForFunction(() => /地面の標高/.test(document.getElementById('heights').textContent)
    && /3m（津波警報/.test(document.getElementById('heights').textContent), null, { timeout: 5000 });
  const h = await page.textContent('#heights');
  assert.match(h, /予想される津波の高さ3m（津波警報・静岡県）【模擬】/);
  assert.match(h, /いる場所の標高約 1\.4 m⚠ 予想の高さ以下です/);
  assert.match(h, /地形によって津波は予想より高くなる可能性があります。/);
  assert.match(h, /タワーやビルの上の階の高さは含みません/);
  assert.doesNotMatch(h, /安全です|安全な場所|大丈夫|安心/);
  const href = await page.getAttribute('#evac-map-link', 'href');
  assert.match(href, /^https:\/\/www\.google\.com\/maps\/dir\/\?api=1&destination=[\d.]+%2C[\d.]+&travelmode=walking$/);
  assert.ok(!href.includes('34.86000%2C138.32000')); // the demo point is not in the URL
  assert.match(await page.textContent('#evac-map-wrap'), /通れない道や浸水を考えていません/);
  await shot(page, 'shell-heights');
});

test('handoff memo: auto draft, hand edits kept on the device, copy, download, delete', { skip }, async (t) => {
  const { page } = await open(t, { query: '?demo=fukushima&demostep=400' });
  await page.waitForFunction(() => globalThis.__shell.state.inp.replay.finished, null, { timeout: 8000 });
  // ~51 h after the start in the record: the guide is at its most visible
  await page.waitForFunction(() => document.getElementById('handoff-open').dataset.prominence === 'high', null, { timeout: 3000 });
  await page.click('#handoff-open');
  await page.waitForFunction(() => document.getElementById('handoff-text').value.length > 100);
  let v = await page.inputValue('#handoff-text');
  assert.match(v, /Claude へのお願い/);
  assert.match(v, /一度に一つずつ/);
  assert.match(v, /診断や助言はしないでください/);
  assert.match(v, /【過去の記録の再生】/);
  assert.match(v, /津波警報（大津波）（福島県） 予想される津波の高さ 10m以上/);
  assert.match(v, /発災からの時間：約 2 日/);
  assert.match(v, /位置の座標は入れていません/);
  assert.doesNotMatch(v, /37\.76|140\.98/);
  assert.match(await page.textContent('#handoff-storage-note'), /この端末に保存されます.*内容削除/);
  await page.fill('#handoff-text', `${v}\n手で書いた行`);
  await page.reload();
  await page.waitForFunction(() => globalThis.__handoff);
  await page.click('#handoff-open');
  await page.waitForFunction(() => /手で書いた行/.test(document.getElementById('handoff-text').value));
  await page.click('#handoff-rebuild');
  await page.waitForFunction(() => /作り直しました/.test(document.getElementById('handoff-status').textContent));
  v = await page.inputValue('#handoff-text');
  assert.match(v, /手で書いた行/);
  await page.click('#handoff-copy');
  // (the OS clipboard may turn line ends into CRLF)
  assert.equal((await page.evaluate(() => navigator.clipboard.readText())).replace(/\r\n/g, '\n'), v.replace(/\r\n/g, '\n'));
  const [dl] = await Promise.all([page.waitForEvent('download'), page.click('#handoff-download')]);
  assert.match(dl.suggestedFilename(), /^handoff_\d{8}_\d{4}\.md$/);
  await page.click('#handoff-clear');
  assert.equal(await page.inputValue('#handoff-text'), '');
  assert.equal(await page.evaluate(() => localStorage.getItem('bw-handoff-draft')), null);
});
