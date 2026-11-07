// Tests for the alert border level. Run: node --test 'modules/alert/test/*.test.js'
// Positions: fictional points computed from the coast data, the Shizuoka
// prefectural office (approximate), and a fictional point outside the data.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { loadCoastData, nearestCoast, alertState, levelOfKind, LEVEL_STYLE, ALERT_DEFAULTS, DEFAULT_COAST_URL } from '../node.js';

const coast = await loadCoastData();
const SAFE_CLAIM = /安全です|安全な場所|異常なし|異常はありません|正常|問題ありません|大丈夫|安心|心配ありません/;

test('kind names -> level (fixed table, names as published)', () => {
  const cases = [
    ['大雨注意報', 2], ['乾燥注意報', 2], ['大雨警報', 3], ['暴風警報', 3], ['波浪警報', 3],
    ['レベル3大雨警報', 3], ['レベル4大雨危険警報', 4], ['レベル4土砂災害危険警報', 4], ['土砂災害警戒情報', 4],
    ['大雨特別警報', 5], ['レベル5大雨特別警報', 5],
    ['津波注意報', 2], ['津波警報', 3], ['津波警報（津波）', 3], ['大津波警報', 5], ['津波警報（大津波）', 5],
  ];
  for (const [name, level] of cases) assert.equal(levelOfKind(name)?.level, level, name);
  for (const name of ['緊急地震速報（警報）', '津波予報（若干の海面変動）', '大雨警報解除', '', null]) assert.equal(levelOfKind(name), null, String(name));
  assert.equal(levelOfKind('大雨警報', '解除'), null);
  assert.equal(levelOfKind('大雨警報', '発表警報・注意報はなし'), null);
  assert.equal(levelOfKind('津波警報').tsunami, true);
  assert.equal(levelOfKind('大雨警報').tsunami, false);
});

test('colours: yellow / red / purple, level 5 purple fading, never green', () => {
  assert.equal(LEVEL_STYLE[2].color, '#F2E700');
  assert.equal(LEVEL_STYLE[3].color, '#FF2800');
  assert.equal(LEVEL_STYLE[4].color, '#AA00AA');
  assert.equal(LEVEL_STYLE[5].color, '#AA00AA');
  assert.equal(LEVEL_STYLE[5].blink, 'fade3s');
  assert.equal(LEVEL_STYLE[0].color, null);
  for (const s of Object.values(LEVEL_STYLE)) {
    if (!s.color) continue;
    const [r, g, b] = [1, 3, 5].map((i) => parseInt(s.color.slice(i, i + 2), 16));
    assert.ok(!(g > r + 40 && g > b + 40), s.color);
  }
});

test('nothing received -> unknown (never "normal")', () => {
  const r = alertState({ received: false });
  assert.equal(r.status, 'unknown');
  assert.equal(r.level, null);
  assert.equal(r.color, null);
  assert.match(r.detail, /受け取れていません/);
  assert.match(r.detail, /警報が出ていないという意味ではありません/);
});

test('only items for the location count; the highest level wins', () => {
  const items = [
    { area_code: '2210001', area_name: '静岡市南部', kinds: [{ name: '大雨注意報' }, { name: '大雨警報' }] },
    { area_code: '2213001', area_name: '浜松市南部', kinds: [{ name: '大雨特別警報' }] },
  ];
  const r = alertState({ items, areaCodes: ['2210001', '220000'] });
  assert.equal(r.level, 3);
  assert.equal(r.color, '#FF2800');
  assert.equal(r.blink, 'none');
  assert.match(r.detail, /この地域への発表：大雨注意報、大雨警報/);
  const none = alertState({ items, areaCodes: ['2220300'] });
  assert.equal(none.level, 0);
  assert.equal(none.color, null);
  assert.match(none.detail, /安全という意味ではありません/);
});

test('level 5 fades; imminent (tsunami warning near the coast) blinks hard', () => {
  const sp = alertState({ items: [{ area_code: 'x', kinds: [{ name: '大雨特別警報' }] }], areaCodes: ['x'] });
  assert.equal(sp.level, 5);
  assert.equal(sp.blink, 'fade3s');
  const near = { distance_m: 500, region_code: '380', region_name: '静岡県' };
  const tw = alertState({ items: [{ area_code: '380', area_name: '静岡県', kinds: [{ name: '津波警報' }] }], coast: near });
  assert.equal(tw.level, 3);
  assert.equal(tw.imminent, true);
  assert.equal(tw.blink, 'hard1s');
  assert.equal(tw.color, '#FF2800');
  const major = alertState({ items: [{ area_code: '380', kinds: [{ name: '大津波警報' }] }], coast: near });
  assert.equal(major.imminent, true);
  assert.equal(major.blink, 'hard1s');
  assert.equal(major.color, '#AA00AA');
});

test('imminent boundary and conditions', () => {
  const at = (d) => ({ distance_m: d, region_code: '380', region_name: '静岡県' });
  const items = [{ area_code: '380', kinds: [{ name: '津波警報' }] }];
  assert.equal(alertState({ items, coast: at(ALERT_DEFAULTS.imminentCoastDistanceM) }).imminent, true);
  assert.equal(alertState({ items, coast: at(ALERT_DEFAULTS.imminentCoastDistanceM + 1) }).imminent, false);
  // advisory only: not imminent
  assert.equal(alertState({ items: [{ area_code: '380', kinds: [{ name: '津波注意報' }] }], coast: at(100) }).imminent, false);
  // warning for another region: neither counted nor imminent
  const other = alertState({ items: [{ area_code: '250', kinds: [{ name: '大津波警報' }] }], coast: at(100) });
  assert.equal(other.imminent, false);
  assert.equal(other.level, 0);
  // released
  assert.equal(alertState({ items: [{ area_code: '380', kinds: [{ name: '津波警報', status: '解除' }] }], coast: at(100) }).imminent, false);
  // no coast (far / unknown): official level only
  const far = alertState({ items: [{ area_code: '380', kinds: [{ name: '大津波警報' }] }], areaCodes: ['380'], coast: null });
  assert.equal(far.level, 5);
  assert.equal(far.imminent, false);
  assert.equal(far.blink, 'fade3s');
});

test('wording: no safety claims, no shindo, no injury words', () => {
  const states = [
    alertState({ received: false }),
    alertState({ items: [], areaCodes: ['x'] }),
    alertState({ items: [{ area_code: '380', kinds: [{ name: '大津波警報' }] }], coast: { distance_m: 10, region_code: '380', region_name: '静岡県' } }),
  ];
  for (const s of states) {
    assert.doesNotMatch(JSON.stringify(s), SAFE_CLAIM);
    assert.doesNotMatch(JSON.stringify(s), /震度|けが|怪我|転倒/);
  }
});

test('coast data: shape, attribution, regions', async () => {
  const raw = JSON.parse(await readFile(DEFAULT_COAST_URL, 'utf8'));
  assert.equal(raw.format, 'coast-lines/1');
  assert.deepEqual(Object.keys(raw.regions).sort(), ['250', '310', '311', '312', '380']);
  assert.equal(raw.regions['380'].name, '静岡県');
  assert.equal(raw.regions['250'].name, '福島県');
  assert.match(raw.attribution, /気象庁/);
  assert.match(raw.processed, /気象庁が作成したものではありません/);
  assert.ok(raw.simplification.max_error_m < 25);
});

test('nearest coast: demo points, prefectural office, outside the data', () => {
  const yaizu = nearestCoast(coast, 34.86, 138.32); // fictional demo point
  assert.equal(yaizu.region_code, '380');
  assert.ok(yaizu.distance_m > 500 && yaizu.distance_m < 620, String(yaizu.distance_m));
  const soma = nearestCoast(coast, 37.8, 140.9809); // fictional demo point
  assert.equal(soma.region_code, '250');
  assert.ok(soma.distance_m > 450 && soma.distance_m < 560, String(soma.distance_m));
  const office = nearestCoast(coast, 34.9769, 138.3831); // Shizuoka prefectural office (approximate)
  assert.ok(office.distance_m > 4000 && office.distance_m < 5500);
  assert.equal(nearestCoast(coast, 35.0, 135.0), null); // fictional, far from every kept region
});

test('inundation estimate takes priority over the distance to the coast', () => {
  const items = [{ area_code: '250', kinds: [{ name: '大津波警報' }] }];
  const far = { distance_m: 1040, region_code: '250', region_name: '福島県' };
  const near = { distance_m: 300, region_code: '250', region_name: '福島県' };
  // Inside the estimated area: imminent even beyond 1000 m.
  const inside = alertState({ items, coast: far, inundation: true });
  assert.equal(inside.imminent, true);
  assert.equal(inside.basis, 'inundation');
  assert.equal(inside.blink, 'hard1s');
  assert.match(inside.detail, /浸水想定の区域の中/);
  // Outside the estimated area: not imminent even close to the coast; the
  // level from the announcement stays, and no reassuring words.
  const outside = alertState({ items, coast: near, inundation: false });
  assert.equal(outside.imminent, false);
  assert.equal(outside.basis, 'inundation');
  assert.equal(outside.level, 5);
  assert.equal(outside.blink, 'fade3s');
  assert.doesNotMatch(outside.detail, SAFE_CLAIM);
  assert.doesNotMatch(outside.detail, /区域の外/);
  // Unknown: the distance guide, labelled as the app's own guide.
  const unknownNear = alertState({ items, coast: near, inundation: null });
  assert.equal(unknownNear.imminent, true);
  assert.equal(unknownNear.basis, 'distance');
  assert.match(unknownNear.detail, /このアプリの目安です。公的な基準ではありません/);
  const unknownFar = alertState({ items, coast: far });
  assert.equal(unknownFar.imminent, false);
  assert.equal(unknownFar.basis, 'distance');
  assert.match(unknownFar.detail, /このアプリの目安です。公的な基準ではありません/);
  // No tsunami warning: no basis, inundation alone never raises the level.
  const none = alertState({ items: [], areaCodes: ['250'], coast: near, inundation: true });
  assert.equal(none.imminent, false);
  assert.equal(none.level, 0);
  assert.equal(none.basis, null);
});
