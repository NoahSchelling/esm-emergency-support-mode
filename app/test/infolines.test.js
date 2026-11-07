// The one-line texts of the main screen (./shell/infolines.js) and the
// demo facts behind them.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { infoLines, formatMdHm, recordMdHm, tsunamiLine, quakeLine, classOf } from '../shell/infolines.js';
import { DEMOS, replayState } from '../shell/demos.js';
import { levelOfKind } from '../../modules/alert/alert.js';
import { elevationShort } from '../shell/heights.js';

test('date and time: no year, "3.11 14:46"', () => {
  assert.equal(formatMdHm(Date.UTC(2011, 2, 11, 5, 46)), '3.11 14:46');
  assert.equal(formatMdHm(Date.UTC(2026, 10, 6, 23, 5)), '11.7 08:05');
  assert.equal(formatMdHm(NaN), '');
  assert.equal(recordMdHm('2011-03-11 14:46'), '3.11 14:46');
  assert.equal(recordMdHm('2019-09-09 05時前'), '9.9 05時前');
  assert.equal(recordMdHm(''), '');
});

test('line formats: tsunami and earthquake', () => {
  assert.equal(tsunamiLine({ name: '大津波警報', height: '10m以上', place: '静岡県', basis: '予想' }), '大津波警報 10m以上、静岡県、予想');
  assert.equal(tsunamiLine({ name: '津波', height: '3m', place: '〇〇港', arrival: '15:10', basis: '実測' }), '津波 3m、〇〇港、到着 15:10、実測');
  assert.equal(tsunamiLine({ name: '津波注意報' }), '津波注意報');
  assert.equal(quakeLine({ maxInt: '6弱', area: '〇〇県〇〇地域', magnitude: '6.8', depth: '10km', basis: '実測' }), '地震 最大震度6弱、〇〇県〇〇地域、M6.8、深さ10km、実測');
  assert.equal(classOf('津波警報'), 'tsunami');
  assert.equal(classOf('大雨特別警報'), 'other');
});

test('priority: tsunami > earthquake > other; higher level first', () => {
  const items = [
    { area_name: '練馬区', kinds: [{ name: '大雨特別警報', status: null }], time: '2019-10-12 21:19' },
    { area_name: '静岡県', kinds: [{ name: '津波注意報', status: null }], report_ms: Date.UTC(2026, 0, 1, 0, 0) },
    { area_name: '静岡県', kinds: [{ name: '大津波警報', status: null }], max_height: { description: '10m以上' }, report_ms: Date.UTC(2026, 0, 1, 0, 5) },
    { area_name: '静岡県', kinds: [{ name: '津波予報（若干の海面変動）', status: null }] },
  ];
  const facts = [{ type: 'quake', area: '三陸沖', magnitude: '9.0', time: '2011-03-11 14:46' }];
  const lines = infoLines({ items, facts, levelOf: levelOfKind });
  assert.deepEqual(lines.map((l) => l.text), [
    '大津波警報 10m以上、静岡県、予想',
    '津波注意報、静岡県',
    '地震 三陸沖、M9.0',
    '大雨特別警報、練馬区',
  ]);
  assert.equal(lines[0].time, '1.1 09:05');
  assert.equal(lines[3].time, '10.12 21:19');
});

test('Fukushima replay: the warning stays first, observations and earthquakes go under it', () => {
  const demo = DEMOS.fukushima;
  const st = replayState(demo, demo.stepMs * 6); // 15:51, Soma observation
  const lines = infoLines({ items: st.items, facts: st.facts, levelOf: levelOfKind });
  assert.equal(lines[0].text, '津波警報（大津波） 10m以上、福島県、予想');
  assert.equal(lines[0].time, '3.11 15:30');
  assert.equal(lines[1].text, '津波 9.3m以上、相馬、実測');
  assert.equal(lines[2].text, '津波 333cm、小名浜、実測');
  assert.ok(lines.slice(3).every((l) => l.cls === 'quake'));
  // Before the tsunami warning, the earthquake is first.
  const early = replayState(demo, demo.stepMs * 1);
  const first = infoLines({ items: early.items, facts: early.facts, levelOf: levelOfKind });
  assert.equal(first[0].cls, 'quake');
});

test('replay items keep the time they were announced until they change', () => {
  const demo = DEMOS.fukushima;
  const st = replayState(demo, demo.stepMs * 5); // 15:39, after the 15:30 update
  assert.equal(st.items[0].time, '2011-03-11 15:30');
});

test('elevation under the compass: "約1.4m"', () => {
  assert.equal(elevationShort({ status: 'ok', value_m: 1.44 }), '約1.4m');
  assert.equal(elevationShort({ status: 'no-consent' }), '調べていません');
  assert.equal(elevationShort(null), '—');
});

test('warning against the higher of forecast and observed heights', async () => {
  const { heightsView, parseHeight, higherHeight, heightWarning, BELOW_TEXT, UNBOUNDED_TEXT } = await import('../shell/heights.js');
  const { observedLevel } = await import('../shell/infolines.js');
  assert.deepEqual(parseHeight('333cm'), { text: '333cm', value_m: 3.33, unbounded: false });
  assert.equal(parseHeight('9.3m以上').unbounded, true);
  assert.equal(parseHeight('１０ｍ超').unbounded, true);
  assert.equal(parseHeight('巨大').value_m, null);
  const here = { status: 'ok', value_m: 5.9 };
  const f3 = { text: '3m', value_m: 3, unbounded: false, area: '福島県', kind: '津波警報' };
  const o6 = { text: '6.1m', value_m: 6.1, unbounded: false, place: '相馬' };
  // forecast alone: higher ground, no mark
  assert.equal(heightWarning(here, f3), '');
  // the observation is higher than the forecast: compared with the observation
  assert.equal(higherHeight(f3, o6), o6);
  const v = heightsView({ forecast: f3, observed: o6, here });
  const row = v.rows.find((r) => r.key === 'here');
  assert.equal(row.warnText, BELOW_TEXT);
  assert.equal(BELOW_TEXT, '津波よりも下にいます');
  assert.match(v.rows.find((r) => r.key === 'observed').text, /6\.1m（相馬）/);
  // no upper limit (10m以上)
  const f10 = { text: '10m以上', value_m: 10, unbounded: true, area: '静岡県' };
  assert.equal(heightsView({ forecast: f10, here: { status: 'ok', value_m: 40 } }).rows.find((r) => r.key === 'here').warnText, UNBOUNDED_TEXT);
  assert.equal(UNBOUNDED_TEXT, '津波上限が予測不能です');
  // colours of observations: JMA height classes
  assert.equal(observedLevel({ value_m: 0.5 }), 2);
  assert.equal(observedLevel({ value_m: 2 }), 3);
  assert.equal(observedLevel({ value_m: 3.33 }), 5);
  assert.equal(observedLevel({ value_m: 9.3, unbounded: true }), 5);
});

test('observed tsunami lines are coloured by the higher of their class and the warning', () => {
  const items = [{ area_name: '福島県', kinds: [{ name: '津波注意報', status: null }], max_height: { description: '1m' } }];
  const facts = [{ type: 'tsunami-obs', height: '333cm', place: '小名浜', time: '' }];
  const lines = infoLines({ items, facts, levelOf: levelOfKind, parseHeight: (t) => ({ value_m: t === '333cm' ? 3.33 : null, unbounded: false }) });
  assert.equal(lines[0].level, 2); // the advisory itself
  assert.equal(lines[1].level, 5); // observed 3.33 m: higher than the advisory
});
