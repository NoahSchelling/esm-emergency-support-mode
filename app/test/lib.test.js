// Unit tests for the pure parts of the app (node --test).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import { STATUS_LABELS, statusLabel, statusClass, missingResult, resultLabel } from '../lib/labels.js';
import { loadModules, parseWithout, MODULE_PATHS } from '../lib/loader.js';
import { makeMockStatus, summarize } from '../lib/announcements.js';
import { createModeController } from '../lib/mode-controller.js';
import { areaLines, fragmentLines, motionLines, modeLines } from '../lib/views.js';
import { toJstIso } from '../lib/time.js';
import * as mode from '../../modules/mode/index.js';
import { parseFragment } from '../../modules/fragment/index.js';
import { loadAreaData, locateArea } from '../../modules/area/node.js';

const here = dirname(fileURLToPath(import.meta.url));
const T0 = Date.parse('2026-11-05T10:00:00+09:00');
const SAFE_WORDS = /安全です|異常なし|異常はありません|正常|問題ありません|大丈夫/;

test('status labels distinguish every status and never say safe/normal', () => {
  for (const s of ['ok', 'denied', 'unsupported', 'insecure', 'error', 'stale', 'unknown', 'missing']) {
    assert.ok(STATUS_LABELS[s], s);
    assert.doesNotMatch(STATUS_LABELS[s], SAFE_WORDS);
  }
  assert.equal(new Set(Object.values(STATUS_LABELS)).size, Object.keys(STATUS_LABELS).length);
  assert.equal(statusLabel('ok'), '取れた');
  assert.equal(statusLabel('denied'), '許可なし');
  assert.equal(statusLabel('unsupported'), '非対応');
  assert.match(statusLabel('stale'), /古い/);
  assert.match(statusLabel('weird'), /分からない/);
  assert.equal(statusClass('ok'), 'st-ok');
  assert.equal(statusClass('unknown'), 'st-none');
});

test('missing modules become a 未実装 result with no value', () => {
  const r = missingResult('area', T0, toJstIso);
  assert.equal(r.status, 'unsupported');
  assert.equal(r.value, null);
  assert.equal(r.observed_at, '2026-11-05T10:00:00+09:00');
  assert.equal(resultLabel(r), '未実装');
  assert.equal(resultLabel({ status: 'ok' }, '読み取れた'), '読み取れた');
});

test('loader reports failed or skipped imports as not loaded', async () => {
  const mods = await loadModules({
    without: ['mode'],
    importer: async (p) => {
      if (p.includes('fragment')) throw new Error('not found');
      return { p };
    },
  });
  assert.equal(mods.sensors.loaded, true);
  assert.equal(mods.mode.loaded, false);
  assert.equal(mods.mode.reason, 'skipped');
  assert.equal(mods.fragment.loaded, false);
  assert.match(mods.fragment.reason, /not found/);
  assert.deepEqual(parseWithout('?without=area, fragment'), ['area', 'fragment']);
  assert.deepEqual(parseWithout(''), []);
});

test('loader paths point at the real module entry points', async () => {
  const mods = await loadModules({ importer: (p) => import(new URL(p, new URL('../main.js', import.meta.url))) });
  for (const [name, m] of Object.entries(mods)) {
    // area/browser/load.js uses import.meta.url + fetch only when called.
    assert.equal(m.loaded, true, `${name}: ${m.reason}`);
  }
  assert.equal(Object.keys(MODULE_PATHS).length, 5);
});

test('mock announcements are always marked simulated', () => {
  const st = makeMockStatus(T0, 3);
  for (const e of st.recent) {
    assert.match(e.title, /^模擬電文：/);
    assert.match(e.content, /模擬データ/);
    assert.equal(e.link, null);
  }
  const r = summarize(st, { origin: 'app-mock', nowMs: T0 });
  assert.equal(r.status, 'ok');
  assert.equal(r.source, 'simulated');
  assert.equal(r.value.mock, true);
  assert.equal(r.value.latest.mock, true);
  assert.match(r.detail, /模擬データ/);
  assert.match(r.detail, /安全という意味ではありません/);
});

test('C-A mock mode is also simulated; live is jma', () => {
  const st = makeMockStatus(T0, 2);
  assert.equal(summarize(st, { origin: 'ca', nowMs: T0 }).source, 'simulated');
  const live = { ...st, source: { mode: 'live' }, recent: st.recent.map((e) => ({ ...e, mock: false, link: 'https://example.invalid/a.xml' })) };
  live.latest = live.recent[0];
  const r = summarize(live, { origin: 'ca', nowMs: T0 });
  assert.equal(r.source, 'jma');
  assert.equal(r.value.latest.link, 'https://example.invalid/a.xml');
  // Non-https links are dropped.
  live.latest = { ...live.latest, link: 'javascript:alert(1)' };
  assert.equal(summarize(live, { origin: 'ca', nowMs: T0 }).value.latest.link, null);
});

test('no announcement, lost link and silence are not shown as safe', () => {
  const empty = { server_time: T0, source: { mode: 'live' }, stale_after: 600, last_received_at: null, latest: null, recent: [] };
  const a = summarize(empty, { origin: 'ca', nowMs: T0 });
  assert.equal(a.status, 'unknown');
  assert.equal(a.value, null);
  assert.match(a.detail, /有無は分かりません/);

  const st = makeMockStatus(T0 - 3600_000, 1);
  st.source = { mode: 'live' };
  st.server_time = T0;
  const b = summarize(st, { origin: 'ca', nowMs: T0 });
  assert.equal(b.value.maybe_stalled, true);
  assert.match(b.detail, /途絶えている可能性/);

  const c = summarize(st, { origin: 'ca', nowMs: T0, linkOk: false, lastOkMs: T0 - 60_000 });
  assert.equal(c.status, 'stale');
  assert.equal(c.value, null);
  assert.match(c.detail, /受け取れていません/);

  assert.equal(summarize(null, { origin: 'ca', nowMs: T0 }).status, 'unknown');
  for (const r of [a, b, c]) assert.doesNotMatch(r.detail, SAFE_WORDS);
});

test('mode controller: simulated public, tick, lift, user request', () => {
  let now = T0;
  const ctl = createModeController(mode, { now: () => now });
  assert.equal(ctl.current.value.mode, 'normal');
  assert.equal(ctl.reason, null);
  assert.match(modeLines(ctl.current).join(), /安全という意味ではありません/);

  now += 5000;
  ctl.simulatePublic('tsunami_warning');
  assert.equal(ctl.current.value.mode, 'emergency');
  assert.equal(ctl.reason.cause.source, 'simulated');
  assert.match(ctl.reason.detail, /津波警報/);

  now += 3600_000;
  ctl.tick();
  assert.equal(ctl.current.value.stage, 2);
  const lines = modeLines(ctl.current).join('\n');
  assert.match(lines, /段階 2\/7/);
  assert.match(lines, /安全になったという意味ではありません/);

  ctl.request('set_normal');
  assert.equal(ctl.last.status, 'denied');
  assert.equal(ctl.current.value.mode, 'emergency');

  now += 1000;
  ctl.simulateLift('tsunami_warning');
  assert.equal(ctl.current.value.mode, 'elevated');
  now += 1000;
  ctl.request('set_normal');
  assert.equal(ctl.current.value.mode, 'normal');
});

test('fragment view lists every reading and keeps the question unanswered', () => {
  const now = '2026-11-05T18:00:00+09:00';
  const amb = fragmentLines(parseFragment('5弱', { now }));
  assert.equal(amb.filter((l) => /^読み方 \d/.test(l)).length, 2);
  assert.ok(amb.some((l) => /決めていません/.test(l)));
  const q = fragmentLines(parseFragment('津波？', { now }));
  assert.ok(q.some((l) => /問いに答えません/.test(l)));
  assert.deepEqual(fragmentLines(parseFragment('揺れた', { now })), []);
});

test('area view: determined, candidates, outside', async () => {
  const data = await loadAreaData();
  const ok = areaLines(locateArea(data, { latitude: 34.9769, longitude: 138.3831, accuracy: 20 }));
  assert.match(ok[0], /静岡葵区/);
  const wide = areaLines(locateArea(data, { latitude: 34.9769, longitude: 138.3831, accuracy: 20000 }));
  assert.ok(wide.some((l) => /1 つに決めていません/.test(l)));
  assert.deepEqual(areaLines(locateArea(data, { latitude: 35.0, longitude: 135.0, accuracy: 20 })), []);
});

test('motion view shows raw values only', () => {
  assert.deepEqual(motionLines({ status: 'unsupported', value: null }, { status: 'unknown', value: null }), []);
  const lines = motionLines(
    { status: 'ok', value: { acceleration: { x: 0.1, y: 0, z: 0 }, acceleration_including_gravity: null } },
    { status: 'ok', value: { acceleration_max: { magnitude: 1.5 }, acceleration_including_gravity_max: { magnitude: 9.9 }, sample_count: 3 } },
  );
  assert.match(lines.join(), /m\/s²/);
  assert.doesNotMatch(lines.join(), /震度/);
});

test('app sources: no external URLs in scripts, no innerHTML, no green', async () => {
  const files = ['main.js', 'index.html', 'app.css', ...(await readdir(join(here, '../lib'))).map((f) => `lib/${f}`)];
  for (const f of files) {
    const src = await readFile(join(here, '..', f), 'utf8');
    assert.doesNotMatch(src, /innerHTML|outerHTML|insertAdjacentHTML|document\.write/, f);
    assert.doesNotMatch(src, /<script[^>]+src="https?:/, f);
    assert.doesNotMatch(src, /\bimport[^;]*from\s+['"]https?:/, f);
    if (f.endsWith('.css')) assert.doesNotMatch(src.replace(/\/\*[\s\S]*?\*\//g, ''), /\bgreen\b|lime|#0f0\b|#00ff00|#008000/i, f);
    assert.doesNotMatch(src, /異常なし'|安全です|正常'/, f);
  }
});
