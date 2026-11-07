// Unit tests for the shell (demo scripts, replay, current-location inputs).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import { DEMOS, DEMO_IDS, replayState, tsunamiInEffect } from '../shell/demos.js';
import { itemsFromStatus, areaCodesFromArea, tsunamiWarningFor } from '../shell/live.js';
import { alertState, loadCoastData, nearestCoast } from '../../modules/alert/node.js';
import { loadAreaData, locateArea } from '../../modules/area/node.js';

const coast = await loadCoastData();
const SAFE_CLAIM = /安全です|安全な場所|異常なし|異常はありません|正常|問題ありません|大丈夫|安心|心配ありません/;

function levelsOf(demo) {
  const out = [];
  for (let i = 0; i < demo.events.length; i++) {
    const st = replayState(demo, i * demo.stepMs);
    const near = nearestCoast(coast, demo.position.latitude, demo.position.longitude);
    const s = alertState({ items: st.items, areaCodes: ['demo'], coast: near, inundation: demo.lookup.inundation });
    out.push(`${s.level}${s.imminent ? '!' : ''}`);
  }
  return out;
}

test('four demos: Shizuoka simulated, the others past records with sources', () => {
  assert.deepEqual(DEMO_IDS, ['shizuoka', 'fukushima', 'chiba', 'tokyo']);
  assert.equal(DEMOS.shizuoka.kind, 'simulated');
  assert.match(DEMOS.shizuoka.banner, /模擬/);
  for (const id of ['fukushima', 'chiba', 'tokyo']) {
    const d = DEMOS[id];
    assert.equal(d.kind, 'record');
    assert.match(d.banner, /過去の記録の再生/);
    assert.match(d.banner, /いま出ている発表ではありません/);
    assert.ok(d.sources.length >= 2);
    for (const s of d.sources) assert.match(s, /https:\/\//);
  }
  for (const e of DEMOS.shizuoka.events) assert.match(e.text, /【模擬】/);
});

test('replay: steps, the last state stays, set/keep semantics', () => {
  const d = DEMOS.fukushima;
  assert.equal(replayState(d, 0).index, 0);
  assert.equal(replayState(d, d.stepMs * 2).event.time, '2011-03-11 14:49');
  // an information event keeps the previous set
  assert.deepEqual(replayState(d, d.stepMs * 3).inEffect, ['津波警報（大津波）']);
  const end = replayState(d, d.stepMs * 100);
  assert.equal(end.index, d.events.length - 1);
  assert.equal(end.finished, true);
  assert.deepEqual(end.inEffect, []);
  assert.equal(replayState(d, -5).index, 0);
});

test('border levels through each demo (! = imminent)', () => {
  assert.deepEqual(levelsOf(DEMOS.shizuoka), ['0', '2', '3!', '5!', '5!', '2', '0']);
  assert.deepEqual(levelsOf(DEMOS.fukushima), ['0', '0', '5!', '5!', '5!', '5!', '5!', '3!', '2', '0']);
  assert.deepEqual(levelsOf(DEMOS.chiba), ['3', '3', '3', '4', '0']);
  assert.deepEqual(levelsOf(DEMOS.tokyo), ['3', '3', '3', '3', '4', '5', '4', '3', '0']);
});

test('tsunami in effect drives the evacuee view only in tsunami demos', () => {
  const s = DEMOS.shizuoka;
  assert.equal(tsunamiInEffect(replayState(s, 0)), null); // the earthquake only
  assert.equal(tsunamiInEffect(replayState(s, s.stepMs)), null); // advisory
  assert.equal(tsunamiInEffect(replayState(s, s.stepMs * 2)).name, '津波警報');
  assert.equal(tsunamiInEffect(replayState(s, s.stepMs * 4)).max_height.description, '10m以上');
  assert.equal(tsunamiInEffect(replayState(s, s.stepMs * 5)), null); // advisory
  assert.equal(tsunamiInEffect(replayState(DEMOS.tokyo, DEMOS.tokyo.stepMs * 5)), null);
  assert.equal(DEMOS.tokyo.hazardOnTsunami, null);
});

test('demo texts: no safety claims, no shindo used for the device, no injury words', () => {
  const all = JSON.stringify(DEMOS);
  assert.doesNotMatch(all, SAFE_CLAIM);
  assert.doesNotMatch(all, /けが|怪我|転倒/);
});

const T = Date.parse('2026-11-07T12:00:00+09:00');
function entry(title, t, items, status = '通常') {
  return { id: `${title}-${t}`, title, updated: t, detail: { title, status, report_datetime: t, items } };
}

test('C-A status -> items: newest message per title, training messages ignored', () => {
  const st = {
    source: { mode: 'live' },
    recent: [
      entry('気象警報・注意報（Ｒ０６）', T, [{ area_code: '2210001', kinds: [{ name: '大雨警報' }] }]),
      entry('気象警報・注意報（Ｒ０６）', T - 60000, [{ area_code: '2210001', kinds: [{ name: '大雨注意報' }] }]),
      entry('津波警報・注意報・予報a', T, [{ area_code: '380', kinds: [{ name: '津波警報' }] }]),
      entry('訓練', T, [{ area_code: '2210001', kinds: [{ name: '大雨特別警報' }] }], '訓練'),
      { id: 'no-detail', title: 'x', updated: T, detail: null },
    ],
  };
  const r = itemsFromStatus(st);
  assert.equal(r.count, 2);
  assert.equal(r.simulated, false);
  assert.deepEqual(r.items.map((i) => i.kinds[0].name).sort(), ['大雨警報', '津波警報']);
  assert.equal(itemsFromStatus({ ...st, source: { mode: 'mock' } }).simulated, true);
  assert.deepEqual(itemsFromStatus(null).items, []);
});

test('area codes from the area module, tsunami warning for the nearest coast', async () => {
  const data = await loadAreaData();
  const codes = areaCodesFromArea(locateArea(data, { latitude: 34.9769, longitude: 138.3831, accuracy: 20 }));
  assert.ok(codes.includes('2210001'));
  assert.ok(codes.includes('220000'));
  assert.deepEqual(areaCodesFromArea({ status: 'unknown', value: null }), []);
  const near = nearestCoast(coast, 34.86, 138.32);
  assert.equal(tsunamiWarningFor([{ area_code: '380', area_name: '静岡県', kinds: [{ name: '大津波警報' }] }], near).name, '大津波警報');
  assert.equal(tsunamiWarningFor([{ area_code: '380', kinds: [{ name: '津波注意報' }] }], near), null);
  assert.equal(tsunamiWarningFor([{ area_code: '250', kinds: [{ name: '大津波警報' }] }], near), null);
});

test('shell sources: no innerHTML, no external imports, position never in a URL', async () => {
  const files = (await readdir(new URL('../shell/', import.meta.url))).map((f) => `../shell/${f}`);
  for (const f of files) {
    const src = await readFile(new URL(f, import.meta.url), 'utf8');
    assert.doesNotMatch(src, /innerHTML|outerHTML|insertAdjacentHTML|document\.write/, f);
    assert.doesNotMatch(src, /\bimport[^;]*from\s+['"]https?:/, f);
    assert.doesNotMatch(src, /fetch\([^)]*(latitude|longitude|lat=|lon=)/, f);
  }
});
