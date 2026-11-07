// Browser checks of the evacuee view with Playwright (Chromium).
// Skipped when Playwright is not installed. PW_CHANNEL=chrome (or msedge)
// uses an installed browser instead of Playwright's own Chromium.
// Set APP_SCREENSHOT_DIR to save screenshots (outside the repository).
//
// Positions: Shizuoka Prefectural Office (approximate, public facility) and
// a fictional round-number point outside the prefecture.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
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
const OUTSIDE = { latitude: 35.0, longitude: 135.0, accuracy: 30 }; // fictional, outside Shizuoka
const PERMS = ['geolocation', 'accelerometer', 'gyroscope', 'magnetometer'];


// The evacuee/supporter switch is in the menu (item 2) since the redesign.
async function switchRole(page, role) {
  if (!(await page.isVisible('#menu-panel'))) await page.click('#menu-button');
  await page.evaluate(() => { document.getElementById('menu-role').open = true; });
  await page.click(role === 'support' ? '#tab-support' : '#tab-evac');
}

let browser;
let server;
let base;

before(async () => {
  if (skip) return;
  server = createAppServer();
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${server.address().port}`;
  browser = await playwright.chromium.launch(CHANNEL ? { channel: CHANNEL } : {});
});

after(async () => {
  await browser?.close();
  server?.close();
});

// iPhone-like: no deviceorientationabsolute, requestPermission exists.
const IPHONE_INIT = () => {
  delete Window.prototype.ondeviceorientationabsolute;
  delete window.ondeviceorientationabsolute;
  window.__permCalls = 0;
  DeviceOrientationEvent.requestPermission = () => { window.__permCalls++; return Promise.resolve('granted'); };
};

// Fake Geolocation that also reports a GPS course (Playwright's own
// geolocation emulation has no heading/speed). window.__fakeGeo controls it:
// { latitude, longitude, accuracy, heading, speed, ageMs }.
const FAKE_GEO = (g) => {
  window.__fakeGeo = g;
  const emit = (ok) => {
    const f = window.__fakeGeo;
    ok({
      timestamp: Date.now() - (f.ageMs || 0),
      coords: {
        latitude: f.latitude, longitude: f.longitude, accuracy: f.accuracy,
        altitude: null, altitudeAccuracy: null, heading: f.heading ?? null, speed: f.speed ?? null,
      },
    });
  };
  const geo = {
    getCurrentPosition(ok) { setTimeout(() => emit(ok), 10); },
    watchPosition(ok) { emit(ok); return setInterval(() => emit(ok), 300); },
    clearWatch(id) { clearInterval(id); },
  };
  Object.defineProperty(Navigator.prototype, 'geolocation', { get: () => geo, configurable: true });
};

// Declination at the prefectural office from the GSI 2020.0 approximation,
// worked out by hand and written as a literal so the test does not reuse the
// module's code: dphi = -2.0231, dlambda = 0.3831 ->
// 495.822 - 37.350 - 2.960 + 0.029 + 0.005 - 0.096 = 455.45' = 7.59 deg.
const DECL_PREF_OFFICE = 7.59;

async function open(t, { width = 375, height = 800, scheme = 'light', geo = PREF_OFFICE, query = '?sim=tsunami', init = null, fakeGeo = null } = {}) {
  const ctx = await browser.newContext({
    viewport: { width, height },
    colorScheme: scheme,
    geolocation: geo,
    permissions: PERMS,
  });
  t.after(() => ctx.close());
  // External lookups are answered by fakes (no network in the tests).
  await ctx.route('https://cyberjapandata2.gsi.go.jp/**', (r) => r.fulfill({ json: { elevation: 12.3, hsrc: '5m（写真測量）' } }));
  await ctx.route('https://disaportaldata.gsi.go.jp/**', (r) => r.fulfill({ status: 404, body: '' }));
  const page = await ctx.newPage();
  const requests = [];
  page.on('request', (r) => requests.push(r.url()));
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  if (init) await page.addInitScript(init);
  if (fakeGeo) await page.addInitScript(FAKE_GEO, fakeGeo);
  await page.goto(`${base}/app/${query}`);
  await page.waitForFunction(() => globalThis.__evac);
  return { page, requests, errors };
}

async function start(page) {
  await page.click('#evac-start');
  await page.waitForFunction(() => globalThis.__evac.result?.status === 'ok' || globalThis.__evac.result?.status === 'unknown', null, { timeout: 15000 });
}

// Fire orientation events every 100 ms for `ms` milliseconds.
async function fireAbsolute(page, alpha, ms = 1200, extra = {}) {
  await page.evaluate(async ({ alpha, ms, extra }) => {
    const end = Date.now() + ms;
    while (Date.now() < end) {
      window.dispatchEvent(new DeviceOrientationEvent('deviceorientationabsolute', { alpha, beta: 20, gamma: 0, absolute: true, ...extra }));
      // Chrome on Android also fires a relative stream; it must be ignored.
      window.dispatchEvent(new DeviceOrientationEvent('deviceorientation', { alpha: (alpha + 123) % 360, beta: 20, gamma: 0, absolute: false }));
      await new Promise((r) => setTimeout(r, 100));
    }
  }, { alpha, ms, extra });
}

async function fireIphone(page, heading, accuracy, ms = 1200) {
  await page.evaluate(async ({ heading, accuracy, ms }) => {
    const end = Date.now() + ms;
    while (Date.now() < end) {
      const e = new DeviceOrientationEvent('deviceorientation', { alpha: 10, beta: 20, gamma: 0, absolute: false });
      Object.defineProperty(e, 'webkitCompassHeading', { value: heading });
      Object.defineProperty(e, 'webkitCompassAccuracy', { value: accuracy });
      window.dispatchEvent(e);
      await new Promise((r) => setTimeout(r, 100));
    }
  }, { heading, accuracy, ms });
}

const state = (page) => page.evaluate(() => ({
  mode: document.getElementById('view-evac').dataset.mode,
  figure: document.getElementById('evac-figure').dataset.kind,
  deg: Number(document.getElementById('evac-figure').dataset.deg),
  result: globalThis.__evac.result,
  // small texts are folded since the redesign: read them opened
  text: (() => {
    const v = document.getElementById('view-evac');
    const open = [...v.querySelectorAll('details')].filter((d) => !d.open);
    for (const d of open) d.open = true;
    const t = v.innerText;
    for (const d of open) d.open = false;
    return t;
  })(),
}));

async function shot(page, name) {
  if (SHOTS) await page.screenshot({ path: join(SHOTS, `${name}.png`), fullPage: true });
}

test('default is the evacuee view; switching is manual only', { skip }, async (t) => {
  const { page } = await open(t);
  assert.equal(await page.isVisible('#view-evac'), true);
  assert.equal(await page.isVisible('#view-support'), false);
  assert.equal(await page.isChecked('#tab-evac'), true);
  await switchRole(page, 'support');
  assert.equal(await page.isVisible('#view-support'), true);
  assert.equal(await page.isVisible('#view-evac'), false);
  // a simulated public announcement does not switch the view
  await page.evaluate(() => globalThis.dispatchEvent(new CustomEvent('app:simulated-public', { detail: { key: 'tsunami_warning' } })));
  await page.waitForTimeout(400);
  assert.equal(await page.isVisible('#view-support'), true);
  await switchRole(page, 'evac');
  assert.equal(await page.isVisible('#view-evac'), true);
});

test('evacuee view has no input fields', { skip }, async (t) => {
  const { page } = await open(t);
  assert.equal(await page.locator('#view-evac input, #view-evac textarea, #view-evac select').count(), 0);
});

test('no scenario: no site is picked; says why and where to check', { skip }, async (t) => {
  const { page } = await open(t, { query: '' });
  await page.click('#evac-start');
  await page.waitForTimeout(800);
  const s = await state(page);
  assert.equal(s.figure, 'none');
  assert.match(s.text, /を受けていないため、避難目標は出していません/);
  assert.equal(await page.isVisible('#evac-fallback'), true);
  // site names and links only (no descriptions)
  assert.match(s.text, /地理院地図（指定緊急避難場所）/);
  assert.doesNotMatch(s.text, /民間のサイトです/);
  // no target: the straight-line note is not needed
  assert.match(s.text, /避難目標\s*なし/);
  assert.equal(await page.isVisible('#evac-straight'), false);
});

test('tsunami mock, no compass: text + north-up figure, never an arrow', { skip }, async (t) => {
  const { page, requests } = await open(t);
  await start(page);
  await page.waitForTimeout(500);
  const s = await state(page);
  assert.equal(s.result.status, 'ok');
  assert.equal(s.result.source, 'simulated');
  assert.equal(s.mode, 'text');
  assert.equal(s.figure, 'north-up');
  const c = s.result.value.candidates[0];
  assert.ok(c.hazards.includes('津波'));
  assert.equal(c.arrow_deg, null);
  assert.equal(s.deg, c.bearing_deg);
  assert.match(s.text, /【模擬】津波警報/);
  assert.match(s.text, /北を上にした図にします（点と点線が避難場所の方向です）/);
  assert.match(s.text, /北から約 \d+ 度/);
  assert.match(s.text, /直線で約 /);
  assert.match(s.text, /直線の方向です。道順ではありません/);
  assert.match(s.text, /公的情報の受信：1 分以内.*【模擬】/);
  assert.ok(s.text.includes(c.name));
  // Same-origin requests (page, modules, data) and, without consent, only the
  // elevation of the designated site (public coordinates). The person's
  // position is not sent; no hazard map tile is fetched.
  const ELEV = 'https://cyberjapandata2.gsi.go.jp/general/dem/scripts/getelevation.php?';
  for (const u of requests) assert.ok(u.startsWith(base) || u.startsWith(ELEV), u);
  assert.ok(!requests.some((u) => /34\.97|138\.38/.test(u)));
  assert.ok(!requests.some((u) => u.includes('disaportaldata')));
  await shot(page, 'evac-text-375-light');
});

test('Android-like, standing still: no compass accuracy -> no arrow, says why', { skip }, async (t) => {
  const { page } = await open(t);
  assert.equal(await page.evaluate(() => 'ondeviceorientationabsolute' in window), true);
  await start(page);
  await fireAbsolute(page, 90);
  const s = await state(page);
  assert.equal(s.result.value.heading.basis, 'absolute_orientation');
  assert.equal(s.figure, 'north-up');
  assert.match(s.text, /方位の精度が分からないため、矢印を出していません/);
});

test('Android-like, walking with the course matching the compass: arrow = bearing - heading', { skip }, async (t) => {
  // alpha 90 -> top edge to magnetic 270 -> true about 262.6. GPS course 262 at 1.5 m/s.
  const { page, errors } = await open(t, { fakeGeo: { ...PREF_OFFICE, heading: 262, speed: 1.5 } });
  await start(page);
  await fireAbsolute(page, 90);
  const s = await state(page);
  assert.equal(s.mode, 'arrow', s.text);
  assert.equal(s.figure, 'arrow');
  const v = s.result.value;
  const expectedHeading = 270 - DECL_PREF_OFFICE;
  assert.ok(Math.abs(v.heading.true_heading_deg - expectedHeading) < 0.2, `${v.heading.true_heading_deg} vs ${expectedHeading}`);
  const c = v.candidates[0];
  // Portrait, tilted back by beta = 20 deg: seen from above, the screen's
  // up-down direction is shortened by cos(beta), so the drawn angle theta
  // satisfies tan(theta) = tan(d) * cos(beta), d = bearing - heading.
  const d = ((c.bearing_deg - expectedHeading) * Math.PI) / 180;
  const b20 = (20 * Math.PI) / 180;
  const expectedArrow = ((Math.atan2(Math.sin(d) * Math.cos(b20), Math.cos(d)) * 180) / Math.PI + 360) % 360;
  assert.ok(Math.abs(c.arrow_deg - expectedArrow) < 0.3, `${c.arrow_deg} vs ${expectedArrow}`);
  assert.equal(s.deg, c.arrow_deg);
  assert.match(await page.getAttribute('.compass-svg', 'aria-label'), /画面の上/);
  assert.match(s.text, /いま進んでいる方向（GPS）/);
  assert.deepEqual(errors.filter((e) => /evac/.test(e)), []);
  await shot(page, 'evac-arrow-android-375-light');

  // orientation events stop -> the arrow disappears (stale), text remains
  await page.waitForTimeout(2600);
  const s2 = await state(page);
  assert.equal(s2.figure, 'north-up');
  assert.match(s2.text, /矢印を出していません/);
});

test('Android-like, walking against the compass: mismatch -> no arrow', { skip }, async (t) => {
  const { page } = await open(t, { fakeGeo: { ...PREF_OFFICE, heading: 80, speed: 1.5 } });
  await start(page);
  await fireAbsolute(page, 90);
  const s = await state(page);
  assert.equal(s.figure, 'north-up');
  assert.match(s.text, /食い違って/);
});

test('old position (20 s): no arrow, the age is shown', { skip }, async (t) => {
  const { page } = await open(t, { init: IPHONE_INIT, fakeGeo: { ...PREF_OFFICE, ageMs: 20000 } });
  await start(page);
  await fireIphone(page, 180, 10);
  const s = await state(page);
  assert.equal(s.figure, 'north-up');
  assert.match(s.text, /約 2\d 秒前に取ったもの/);
});

test('landscape screen: no arrow until the sign is checked on devices', { skip }, async (t) => {
  const LANDSCAPE = () => {
    Object.defineProperty(ScreenOrientation.prototype, 'angle', { get: () => 90, configurable: true });
  };
  const { page } = await open(t, { init: LANDSCAPE });
  assert.equal(await page.evaluate(() => screen.orientation.angle), 90);
  await start(page);
  await fireAbsolute(page, 90);
  const s = await state(page);
  assert.equal(s.figure, 'north-up');
  assert.match(s.text, /縦向きで持って/);
});

test('simulated lift: the direction display stops and says so', { skip }, async (t) => {
  const { page } = await open(t);
  await start(page);
  assert.equal((await state(page)).result.status, 'ok');
  await page.evaluate(() => globalThis.dispatchEvent(new CustomEvent('app:simulated-lift', { detail: { key: 'tsunami_warning' } })));
  await page.waitForTimeout(1200); // the evacuee view redraws once a second
  const s = await state(page);
  assert.equal(s.figure, 'none');
  assert.match(s.text, /解除を受けたため、方向の表示をやめました/);
  assert.equal(await page.isVisible('#evac-name'), false);
});

test('Android-like: jittery compass hides the arrow', { skip }, async (t) => {
  const { page } = await open(t);
  await start(page);
  await page.evaluate(async () => {
    for (let i = 0; i < 12; i++) {
      window.dispatchEvent(new DeviceOrientationEvent('deviceorientationabsolute', { alpha: i % 2 ? 0 : 60, beta: 20, gamma: 0, absolute: true }));
      await new Promise((r) => setTimeout(r, 100));
    }
  });
  const s = await state(page);
  assert.equal(s.figure, 'north-up');
  assert.match(s.text, /安定していません/);
});

test('Android-like: phone held upright -> no arrow', { skip }, async (t) => {
  const { page } = await open(t);
  await start(page);
  await fireAbsolute(page, 0, 1200, { beta: 85 });
  const s = await state(page);
  assert.equal(s.figure, 'north-up');
  assert.match(s.text, /水平に近づけて/);
});

test('iPhone-like (webkitCompassHeading): permission asked on the button, arrow shown', { skip }, async (t) => {
  const { page } = await open(t, { init: IPHONE_INIT });
  assert.equal(await page.evaluate(() => 'ondeviceorientationabsolute' in window), false);
  await start(page);
  assert.equal(await page.evaluate(() => window.__permCalls), 1);
  await fireIphone(page, 180, 10);
  const s = await state(page);
  assert.equal(s.mode, 'arrow');
  const v = s.result.value;
  assert.equal(v.heading.basis, 'ios_compass');
  const expectedHeading = 180 - DECL_PREF_OFFICE;
  assert.ok(Math.abs(v.heading.true_heading_deg - expectedHeading) < 0.2, `${v.heading.true_heading_deg} vs ${expectedHeading}`);
  // Heading up: the upward arrow (direction faced) is fixed; the dial turns
  // by minus the heading and the target mark by its angle on the screen.
  const fig = await page.evaluate(() => {
    const deg = (el) => Number(/rotate\((-?[\d.]+)deg\)/.exec(el.style.transform)?.[1]);
    return {
      orientation: document.querySelector('.compass-svg').dataset.orientation,
      up: getComputedStyle(document.querySelector('.c-up')).display,
      upTransform: document.querySelector('.c-up').style.transform,
      dial: deg(document.querySelector('.c-dial')),
      target: deg(document.querySelector('.c-target-up')),
      dot: getComputedStyle(document.querySelector('.c-target')).display,
      facing: document.getElementById('facing').textContent,
    };
  });
  assert.equal(fig.orientation, 'heading-up');
  assert.notEqual(fig.up, 'none');
  assert.equal(fig.upTransform, '');
  assert.ok(Math.abs(((fig.dial + v.heading.true_heading_deg) % 360 + 360) % 360) < 0.6 || Math.abs(((fig.dial + v.heading.true_heading_deg) % 360 + 360) % 360 - 360) < 0.6, `dial ${fig.dial}`);
  assert.ok(Math.abs((((fig.target - s.deg) % 360) + 360) % 360) < 0.6, `target ${fig.target} vs ${s.deg}`);
  assert.equal(fig.dot, 'none');
  assert.match(fig.facing, /^南 \d+°$/);
  await shot(page, 'evac-arrow-iphone-375-light');
});

test('iPhone-like: uncalibrated compass (accuracy -1) -> no arrow, says calibration', { skip }, async (t) => {
  const { page } = await open(t, { init: IPHONE_INIT });
  await start(page);
  await fireIphone(page, 180, -1);
  const s = await state(page);
  assert.equal(s.figure, 'north-up');
  assert.match(s.text, /校正/);
  // not heading up: no upward arrow, the target is a dot on a north-up dial
  assert.equal(await page.evaluate(() => document.querySelector('.compass-svg').dataset.orientation), 'north-up');
  assert.equal(await page.evaluate(() => getComputedStyle(document.querySelector('.c-up')).display), 'none');
});

test('"通れない": excludes the direction, shows it, and can be undone', { skip }, async (t) => {
  const { page } = await open(t);
  await start(page);
  const before = (await state(page)).result.value.candidates[0];
  await page.click('#evac-exclude');
  await page.waitForTimeout(400);
  const s = await state(page);
  assert.equal(s.result.status, 'ok');
  const after = s.result.value.candidates[0];
  assert.notEqual(after.id, before.id);
  assert.ok(!s.result.value.candidates.some((c) => c.id === before.id));
  assert.match(s.text, /除外中：北から約 \d+ 度/);
  assert.match(s.text, /まで）/);
  assert.match(s.text, /あなたの判断です/);
  await shot(page, 'evac-excluded-375-light');
  await page.click('.evac-undo');
  await page.waitForTimeout(400);
  const s3 = await state(page);
  assert.equal(s3.result.value.candidates[0].id, before.id);
  assert.doesNotMatch(s3.text, /除外中/);
});

test('outside the data: unknown, "not found in the data", fallback links', { skip }, async (t) => {
  const { page } = await open(t, { geo: OUTSIDE });
  await start(page);
  await page.waitForTimeout(400);
  const s = await state(page);
  assert.equal(s.result.status, 'unknown');
  assert.match(s.text, /データの中に見つかりません/);
  assert.match(s.text, /近くに避難場所がないという意味ではありません/);
  assert.equal(await page.isVisible('#evac-fallback'), true);
  assert.equal(s.figure, 'none');
});

test('shock slot exists, hidden until detection is implemented, plain wording', { skip }, async (t) => {
  const { page } = await open(t);
  assert.equal(await page.isVisible('#evac-shock'), false);
  await page.evaluate(() => globalThis.__evac.showShockSlot(true));
  assert.equal((await page.textContent('#evac-shock')).trim(), '端末が強い衝撃を検知しました');
});

// ---------------------------------------------------------------- layout and colours

function luminance([r, g, b]) {
  const f = (c) => { c /= 255; return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4; };
  return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
}
function contrast(a, b) {
  const [x, y] = [luminance(a), luminance(b)].sort((p, q) => q - p);
  return (x + 0.05) / (y + 0.05);
}

for (const width of [375, 1200]) {
  for (const scheme of ['light', 'dark']) {
    test(`layout ${width}px ${scheme}: no horizontal scroll, readable, no green, big buttons`, { skip }, async (t) => {
      const { page } = await open(t, { width, scheme });
      await start(page);
      await fireAbsolute(page, 30);
      await page.evaluate(() => globalThis.__evac.showShockSlot(true));
      await page.click('#evac-exclude');
      await page.waitForTimeout(300);
      await page.evaluate(() => { document.querySelector('.evac-about').open = true; });
      const m = await page.evaluate(() => ({ sw: document.documentElement.scrollWidth, cw: document.documentElement.clientWidth }));
      assert.ok(m.sw <= m.cw, `horizontal scroll: ${m.sw} > ${m.cw}`);
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
        for (const el of document.querySelectorAll('#view-evac *, .view-switch button')) {
          if (!el.offsetParent || el.closest('svg')) continue;
          const own = [...el.childNodes].some((n) => n.nodeType === 3 && n.textContent.trim());
          if (!own) continue;
          const cs = getComputedStyle(el);
          out.push({ tag: el.tagName, id: el.id, cls: el.className, fg: parse(cs.color).slice(0, 3), bg: bgOf(el), opacity: Number(cs.opacity), fontSize: parseFloat(cs.fontSize) });
        }
        const btns = [...document.querySelectorAll('#view-evac button.evac-big, .view-switch button')].map((b) => b.getBoundingClientRect().height);
        const arrow = getComputedStyle(document.querySelector('.evac-arrow-shape, .evac-bearing') ?? document.body).fill;
        return { out, btns, arrow };
      });
      for (const it of items.out) {
        if (it.opacity < 1) continue; // disabled button
        const c = contrast(it.fg, it.bg);
        assert.ok(c >= 4.5, `${it.tag}#${it.id}.${it.cls}: contrast ${c.toFixed(2)}`);
        const [r, g, b] = it.fg;
        assert.ok(!(g > r + 40 && g > b + 40), `green text ${it.fg}`);
        const [br, bgc, bb] = it.bg;
        assert.ok(!(bgc > br + 40 && bgc > bb + 40), `green background ${it.bg}`);
      }
      for (const h of items.btns) assert.ok(h >= 48, `button height ${h}`);
      const name = items.out.find((i) => i.id === 'evac-name');
      assert.ok(name && name.fontSize >= 22, 'large name text');
      await shot(page, `evac-layout-${width}-${scheme}`);
    });
  }
}
