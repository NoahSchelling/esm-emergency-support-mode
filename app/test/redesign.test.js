// Unit tests for the redesign parts: heights, history, consent, contacts,
// handoff memo, forecast heights, demo lookups.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { heightsView, lowerThanForecast, mapRouteUrl, elevationText, TERRAIN_NOTE, MAP_ROUTE_NOTE } from '../shell/heights.js';
import { createHistory, entriesFromItems, disasterStartMs } from '../shell/history.js';
import { readConsent, writeConsent, CONSENT_TEXT, CONSENT_STOP } from '../shell/consent.js';
import { CONTACT_GROUPS, CHECKED, telHref } from '../shell/contacts.js';
import { buildAuto, newDraft, mergeAuto, stageAt, guideProminence, elapsedText, downloadName, AUTO_START, AUTO_END, INSTRUCTION, STORAGE_NOTE } from '../handoff/handoff.js';
import { forecastHeightFor, itemsFromStatus } from '../shell/live.js';
import { DEMOS, DEMO_IDS, replayState, demoElapsedHours, recordTimeMs } from '../shell/demos.js';
import { levelOfKind, alertState, loadCoastData, nearestCoast } from '../../modules/alert/node.js';
import { DEFAULT_STAGES, DEFAULT_STAGE_HOURS } from '../../modules/mode/config.js';

const SAFE_CLAIM = /安全です|安全な場所|異常なし|異常はありません|正常|問題ありません|大丈夫|安心|心配ありません/;
const MEDICAL = /診断します|治療|処方|服用|安静にして|カウンセリング|うつ病|PTSD|症状から判断/;

function memStorage() {
  const m = new Map();
  return {
    getItem: (k) => (m.has(k) ? m.get(k) : null),
    setItem: (k, v) => m.set(k, String(v)),
    removeItem: (k) => m.delete(k),
    get size() { return m.size; },
  };
}

test('heights: warning when lower than or equal to the forecast, or no upper limit', () => {
  const f3 = { text: '3m', value_m: 3, unbounded: false, area: '静岡県', kind: '津波警報' };
  const f10 = { text: '10m以上', value_m: 10, unbounded: true, area: '福島県', kind: '大津波警報' };
  const ok = (v) => ({ status: 'ok', value_m: v });
  assert.equal(lowerThanForecast(ok(1.4), f3), true);
  assert.equal(lowerThanForecast(ok(3), f3), true);
  assert.equal(lowerThanForecast(ok(12), f3), false);
  assert.equal(lowerThanForecast(ok(40), f10), true); // no upper limit
  assert.equal(lowerThanForecast({ status: 'no-consent' }, f3), false);
  assert.equal(lowerThanForecast(ok(1), null), false);
  const v = heightsView({ forecast: f10, here: ok(5.9), site: ok(7), siteName: '仮の避難場所', mark: '【過去の記録の再生】' });
  assert.equal(v.note, TERRAIN_NOTE);
  assert.equal(v.rows.length, 3);
  assert.ok(v.rows.every((r) => r.warn));
  assert.match(v.rows[0].text, /10m以上（大津波警報・福島県）【過去の記録の再生】/);
  assert.match(v.rows[2].label, /地面の標高/);
  assert.match(v.siteNote, /タワーやビルの上の階/);
});

test('heights: the terrain note is always there; never "safe"', () => {
  const cases = [
    heightsView({}),
    heightsView({ forecast: null, here: { status: 'ok', value_m: 40.7 }, received: true }),
    heightsView({ forecast: null, here: { status: 'no-consent' }, received: false }),
    heightsView({ forecast: { text: '1m', value_m: 1, unbounded: false, area: 'A' }, here: { status: 'ok', value_m: 30 } }),
  ];
  for (const v of cases) {
    assert.equal(v.note, '地形によって津波は予想より高くなる可能性があります。');
    assert.doesNotMatch(JSON.stringify(v), SAFE_CLAIM);
  }
  // high ground and a bounded forecast: no warning, and still no reassurance
  assert.equal(cases[3].warn, false);
  assert.match(cases[1].rows[0].text, /発表がないことは、安全という意味ではありません/);
  assert.match(cases[2].rows[0].text, /受け取れていません/);
  assert.match(elevationText({ status: 'no-consent' }), /同意していないため/);
  assert.equal(elevationText({ status: 'ok', value_m: 1.44 }), '約 1.4 m');
});

test('map link: official Google Maps URL format, walking, destination only, no key', () => {
  const u = mapRouteUrl({ latitude: 34.861234, longitude: 138.321234 });
  assert.equal(u, 'https://www.google.com/maps/dir/?api=1&destination=34.86123%2C138.32123&travelmode=walking');
  assert.doesNotMatch(u, /origin|key=/);
  assert.equal(mapRouteUrl(null), null);
  assert.match(MAP_ROUTE_NOTE, /通れない道や浸水を考えていません/);
});

test('forecast height: from C-A items or the demo, for the nearest coast region only', () => {
  const coast = { region_code: '380', region_name: '静岡県', distance_m: 500 };
  const items = [
    { area_code: '250', area_name: '福島県', kinds: [{ name: '大津波警報' }], max_height: { description: '１０ｍ超', value_m: 10, unbounded: true } },
    { area_code: '380', area_name: '静岡県', kinds: [{ name: '津波警報' }], max_height: { description: '３ｍ', value_m: 3, unbounded: false } },
  ];
  assert.deepEqual(forecastHeightFor(items, coast), { text: '３ｍ', value_m: 3, unbounded: false, area: '静岡県', kind: '津波警報' });
  assert.equal(forecastHeightFor(items, null), null);
  assert.equal(forecastHeightFor([{ ...items[1], kinds: [{ name: '津波警報', status: '解除' }] }], coast), null);
  const q = forecastHeightFor([{ area_code: '380', kinds: [{ name: '大津波警報' }], max_height: { description: '巨大', value_m: null, unbounded: true } }], coast);
  assert.equal(q.unbounded, true);
  assert.equal(q.value_m, null);
  // report_ms is attached for the history
  const st = itemsFromStatus({ source: { mode: 'live' }, recent: [{ title: 't', detail: { title: 't', report_datetime: 1000, items: [items[1]] } }] });
  assert.equal(st.items[0].report_ms, 1000);
});

test('demos: Fukushima and Shizuoka heights 3m -> 6m -> 10m以上; looked-up elevation and inundation', async () => {
  const heightsOf = (d) => d.events.map((_, i) => replayState(d, i * d.stepMs).items[0]?.max_height?.description ?? '-');
  assert.deepEqual(heightsOf(DEMOS.shizuoka), ['3m', '6m', '10m以上', '1m', '-']);
  assert.deepEqual(heightsOf(DEMOS.fukushima).slice(2, 5), ['3m', '6m', '10m以上']);
  for (const e of DEMOS.shizuoka.events) assert.match(e.text, /模擬/);
  for (const id of DEMO_IDS) {
    const l = DEMOS[id].lookup;
    assert.ok(Number.isFinite(l.elevation_m), id);
    assert.ok(l.inundation === true || l.inundation === false || l.inundation === null, id);
    assert.equal(l.checked, '2026-11-07');
  }
  // Fukushima: beyond 1000 m from the coast line but inside the estimate -> imminent
  const coast = await loadCoastData();
  const d = DEMOS.fukushima;
  const near = nearestCoast(coast, d.position.latitude, d.position.longitude);
  assert.ok(near.distance_m > 1000, String(near.distance_m));
  const st = replayState(d, 2 * d.stepMs);
  const s = alertState({ items: st.items, areaCodes: ['demo'], coast: near, inundation: d.lookup.inundation });
  assert.equal(s.imminent, true);
  assert.equal(s.basis, 'inundation');
  const sd = alertState({ items: st.items, areaCodes: ['demo'], coast: near, inundation: null });
  assert.equal(sd.imminent, false);
});

test('demo elapsed hours: recorded times, simulated hours', () => {
  assert.equal(recordTimeMs('2011-03-11 14:46'), Date.UTC(2011, 2, 11, 5, 46));
  assert.equal(recordTimeMs('2019-09-09 05時前'), Date.UTC(2019, 8, 8, 20, 0));
  assert.equal(recordTimeMs(''), null);
  const f = DEMOS.fukushima;
  const last = replayState(f, 100 * f.stepMs);
  assert.ok(demoElapsedHours(f, last) > 50);
  const s = DEMOS.shizuoka;
  assert.equal(demoElapsedHours(s, replayState(s, 0)), 0.05);
});

test('history: dedup by id, kept in storage, cleared; disaster start', () => {
  const st = memStorage();
  const h = createHistory(st);
  const items = [{ area_code: '380', area_name: '静岡県', kinds: [{ name: '津波警報' }, { name: '若干の海面変動' }], max_height: { description: '3m' } }];
  const e = entriesFromItems(items, { at: 1000, source: 'live', mark: '', idPrefix: 'live|1', levelOf: levelOfKind });
  assert.equal(e.length, 1); // only kinds with a level
  assert.equal(h.add(e).length, 1);
  assert.equal(h.add(e).length, 0);
  assert.equal(createHistory(st).list().length, 1); // restored from storage
  h.add(entriesFromItems([{ area_code: '380', area_name: '静岡県', kinds: [{ name: '大雨注意報' }] }], { at: 500, source: 'live', idPrefix: 'live|0', levelOf: levelOfKind }));
  assert.equal(disasterStartMs(h.list()), 1000); // level 3 and up only
  assert.equal(disasterStartMs(h.list(), ['record']), null);
  h.clear();
  assert.equal(h.list().length, 0);
  assert.equal(st.getItem('bw-history'), null);
  // broken storage: still works
  const broken = { getItem() { throw new Error('x'); }, setItem() { throw new Error('x'); }, removeItem() { throw new Error('x'); } };
  const hb = createHistory(broken);
  assert.equal(hb.add(e).length, 1);
  hb.clear();
});

test('consent: one consent, stored, withdrawn; the text says what is sent and how to stop', () => {
  const st = memStorage();
  assert.equal(readConsent(st).granted, false);
  writeConsent(st, true, 1234);
  assert.deepEqual(readConsent(st), { granted: true, at: 1234 });
  writeConsent(st, false);
  assert.equal(readConsent(st).granted, false);
  const all = CONSENT_TEXT.join('');
  assert.match(all, /標高 API/);
  assert.match(all, /津波浸水想定/);
  assert.match(all, /公的な基準ではありません/);
  assert.match(CONSENT_STOP, /同意をやめる/);
});

test('contacts: national always first, the four demo places, sources and the checked date', () => {
  assert.equal(CONTACT_GROUPS[0].id, 'national');
  assert.deepEqual(CONTACT_GROUPS.map((g) => g.id), ['national', 'shizuoka', 'fukushima', 'chiba', 'tokyo']);
  assert.equal(CHECKED, '2026-11-07');
  for (const g of CONTACT_GROUPS) {
    for (const x of [...g.links, ...g.phones]) {
      assert.match(x.src, /^https:\/\//, x.label);
      assert.match(x.src, /\.(go\.jp|lg\.jp|metro\.tokyo\.lg\.jp|pref\.shizuoka\.jp|city\.chiba\.jp|city\.soma\.fukushima\.jp|city\.nerima\.tokyo\.jp|ntt-east\.co\.jp)\//, x.label);
    }
    for (const p of g.phones) assert.match(p.value, /^(#?\d{3,4}|\d{2,5}-\d{2,4}-\d{3,4})$/, p.label);
  }
  const national = CONTACT_GROUPS[0].phones.map((p) => p.value);
  for (const n of ['119', '110', '118']) assert.ok(national.includes(n));
  assert.equal(telHref('#7119'), 'tel:%237119');
  assert.equal(telHref('03-6758-3900'), 'tel:0367583900');
});

test('handoff: draft with instruction, auto part between markers, no coordinates, no advice', () => {
  const auto = buildAuto({
    createdText: '2026-11-07 18:00（日本時間）',
    elapsedHours: 30,
    stageName: 'サバイバル',
    mark: '【模擬】',
    announcements: ['2026-11-07 17:00 【模擬】津波警報（静岡県） 予想される津波の高さ 3m'],
    site: { name: '仮の避難場所', municipality: '焼津市', distance: '直線で約 280 m' },
    heights: [{ label: 'いる場所の標高', text: '約 1.4 m', warnText: '予想の高さ以下です' }],
    terrainNote: TERRAIN_NOTE,
    battery: '残量 40%',
    network: 'オンライン',
  });
  assert.ok(auto.startsWith(AUTO_START) && auto.endsWith(AUTO_END));
  assert.match(auto, /約 30 時間/);
  assert.match(auto, /⚠ 予想の高さ以下です/);
  assert.match(auto, /デモの内容です/);
  assert.match(auto, /位置の座標は入れていません/);
  assert.doesNotMatch(auto, /\d+\.\d{4,}/); // no coordinates
  const d = newDraft(auto);
  assert.ok(d.includes(INSTRUCTION));
  assert.match(INSTRUCTION, /一度に一つずつ/);
  assert.match(INSTRUCTION, /診断や助言はしないでください/);
  assert.match(INSTRUCTION, /119/);
  assert.doesNotMatch(d, MEDICAL);
  assert.doesNotMatch(d, SAFE_CLAIM);
  // rebuild keeps the hand-written part
  const edited = d.replace('- そのほか：', '- そのほか：手で書いた文');
  const auto2 = buildAuto({ createdText: 'x', elapsedHours: null, announcements: [], heights: [] });
  const merged = mergeAuto(edited, auto2);
  assert.match(merged, /手で書いた文/);
  assert.match(merged, /記録がありません/);
  assert.doesNotMatch(merged, /約 30 時間/);
  assert.equal(mergeAuto('', auto2), newDraft(auto2));
  assert.match(mergeAuto('free text only', auto2), /free text only$/);
  assert.match(STORAGE_NOTE, /内容削除/);
  assert.match(downloadName(Date.UTC(2026, 10, 7, 9, 5)), /^handoff_20261107_1805\.md$/);
});

test('handoff guide: grows toward the survival stage of modules/mode', () => {
  assert.equal(stageAt(0.1, DEFAULT_STAGES, DEFAULT_STAGE_HOURS).index, 0);
  assert.equal(stageAt(1, DEFAULT_STAGES, DEFAULT_STAGE_HOURS).index, 1);
  assert.equal(stageAt(7, DEFAULT_STAGES, DEFAULT_STAGE_HOURS).name, 'サバイバル');
  assert.equal(stageAt(null, DEFAULT_STAGES, DEFAULT_STAGE_HOURS), null);
  assert.equal(guideProminence(null), 'low');
  assert.equal(guideProminence({ index: 0 }), 'low');
  assert.equal(guideProminence({ index: 1 }), 'mid');
  assert.equal(guideProminence({ index: 4 }), 'high');
  assert.equal(elapsedText(0.2), '約 12 分');
  assert.equal(elapsedText(30), '約 30 時間');
  assert.equal(elapsedText(72), '約 3 日');
});

test('sources: no innerHTML, no green, no dark theme in the redesigned files', async () => {
  for (const f of ['../shell/shell-main.js', '../evac/evac-main.js', '../handoff/handoff-main.js', '../shell/lookup.js']) {
    const src = await readFile(new URL(f, import.meta.url), 'utf8');
    assert.doesNotMatch(src, /innerHTML|insertAdjacentHTML|outerHTML/, f);
  }
  const css = (await readFile(new URL('../app.css', import.meta.url), 'utf8')).replace(/\/\*[\s\S]*?\*\//g, '');
  assert.doesNotMatch(css, /prefers-color-scheme:\s*dark|data-theme="dark"/);
  assert.doesNotMatch(css, /#0f0\b|#00ff00|\bgreen\b|lime/i);
  const html = await readFile(new URL('../index.html', import.meta.url), 'utf8');
  assert.doesNotMatch(html, /data-theme-choice/);
  const menu = [...html.matchAll(/<details class="menu-item" id="[^"]+">\s*<summary>([^<]+)<\/summary>/g)].map((m) => m[1]);
  assert.deepEqual(menu, ['事前情報収集', '避難者／支援者の切り替え', 'これまでの情報履歴', '記録の出典', '公的機関のウェブサイトリンク', '公的機関の連絡先', '独自情報の情報取得URL', 'デモモード']);
});
