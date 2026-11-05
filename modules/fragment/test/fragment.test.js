import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { parseFragment } from '../index.js';

// Fixed clock: 2026-11-05 18:00 JST, so 08:46 and 16:53 are in the past.
const NOW = '2026-11-05T18:00:00+09:00';
const parse = (s, o = {}) => parseFragment(s, { now: NOW, ...o });
const only = (r) => {
  assert.equal(r.status, 'ok', r.detail);
  assert.equal(r.value.readings.length, 1, JSON.stringify(r.value.readings));
  return r.value.readings[0];
};
const ALL_FIELDS = ['time', 'epicenter', 'magnitude', 'depth', 'intensity', 'area'];

test('result shape: every result has the common fields', () => {
  for (const s of ['0846 M5.5', '揺れた', '', null]) {
    const r = parse(s);
    assert.deepEqual(Object.keys(r).sort(), ['detail', 'kind', 'observed_at', 'source', 'status', 'value']);
    assert.equal(r.kind, 'fragment');
    assert.match(r.observed_at, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\+09:00$/);
    assert.equal(typeof r.detail, 'string');
    if (r.status !== 'ok') assert.equal(r.value, null);
  }
});

test('example: 0846 M5.5 d50km 最大5弱', () => {
  const r = parse('0846 M5.5 d50km 最大5弱');
  const x = only(r);
  assert.equal(x.time.text, '08:46');
  assert.equal(x.time.iso, '2026-11-05T08:46:00+09:00');
  assert.equal(x.time.dateBasis, 'assumed-today');
  assert.deepEqual(x.magnitude, { value: 5.5, qualifier: null });
  assert.deepEqual(x.depth, { km: 50, unitAssumed: false });
  assert.deepEqual(x.intensity, { scale: '5弱', max: true });
  assert.equal(x.epicenter, null);
  assert.equal(x.area, null);
  assert.equal(r.value.question, null);
  assert.deepEqual(r.value.unrecognized, []);
  assert.equal(r.source, 'user');
  assert.equal(r.value.officiallyConfirmed, false);
});

test('example: 16:53 三陸沖 M7.4', () => {
  const x = only(parse('16:53 三陸沖 M7.4'));
  assert.equal(x.time.iso, '2026-11-05T16:53:00+09:00');
  assert.equal(x.epicenter, '三陸沖');
  assert.deepEqual(x.magnitude, { value: 7.4, qualifier: null });
  assert.equal(x.area, null);
  assert.equal(x.intensity, null);
});

test('example: 震度4 千葉北東部 -> intensity and area', () => {
  const x = only(parse('震度4 千葉北東部'));
  assert.deepEqual(x.intensity, { scale: '4', max: false });
  assert.equal(x.area, '千葉北東部');
  assert.equal(x.epicenter, null);
});

test('example: 津波？ -> a question, nothing else asserted', () => {
  const r = parse('津波？');
  const x = only(r);
  assert.deepEqual(r.value.question, { texts: ['津波'] });
  for (const f of ALL_FIELDS) assert.equal(x[f], null);
  assert.match(r.detail, /判断はしていません/);
});

test('examples: 揺れた / 大きい are unknown, never "safe"', () => {
  for (const s of ['揺れた', '大きい']) {
    const r = parse(s);
    assert.equal(r.status, 'unknown');
    assert.equal(r.value, null);
    assert.match(r.detail, /読み取れませんでした/);
    assert.match(r.detail, /安全かどうかの判断はしていません/);
    assert.doesNotMatch(r.detail, /異常なし|問題ありません|安心/);
  }
});

test('example: 5弱 returns both readings and decides neither', () => {
  const r = parse('5弱');
  assert.equal(r.status, 'ok');
  assert.equal(r.value.ambiguous, true);
  assert.equal(r.value.readings.length, 2);
  const intensity = r.value.readings.find((x) => x.intensity);
  const magnitude = r.value.readings.find((x) => x.magnitude);
  assert.deepEqual(intensity.intensity, { scale: '5弱', max: false });
  assert.equal(intensity.magnitude, null);
  assert.deepEqual(magnitude.magnitude, { value: 5, qualifier: '弱' });
  assert.equal(magnitude.intensity, null);
  assert.match(r.detail, /どれかに決めていません/);
});

test('a marked intensity or magnitude is not ambiguous', () => {
  assert.equal(parse('震度5弱').value.ambiguous, false);
  assert.equal(parse('最大5弱').value.ambiguous, false);
  assert.equal(parse('M5').value.ambiguous, false);
});

test('5弱 next to a real magnitude: the two-magnitude reading is not offered', () => {
  const r = parse('M7.4 5弱');
  const x = only(r);
  assert.match(r.detail, /候補から外しました/); // the exclusion is disclosed, not silent
  assert.deepEqual(x.magnitude, { value: 7.4, qualifier: null });
  assert.deepEqual(x.intensity, { scale: '5弱', max: false });
});

test('full-width digits and letters are read', () => {
  const x = only(parse('０８４６　Ｍ５．５　ｄ５０ｋｍ　最大５弱'));
  assert.equal(x.time.text, '08:46');
  assert.equal(x.magnitude.value, 5.5);
  assert.equal(x.depth.km, 50);
  assert.equal(x.intensity.scale, '5弱');
  assert.equal(only(parse('震度５強')).intensity.scale, '5強');
  assert.equal(only(parse('１６：５３')).time.text, '16:53');
});

test('kanji digits and shorthand signs for intensity', () => {
  assert.equal(only(parse('震度五弱')).intensity.scale, '5弱');
  assert.equal(only(parse('震度5-')).intensity.scale, '5弱');
  assert.equal(only(parse('震度6+')).intensity.scale, '6強');
  assert.equal(only(parse('震度７')).intensity.scale, '7');
});

test('other time notations', () => {
  assert.equal(only(parse('8時46分')).time.text, '08:46');
  assert.equal(only(parse('8:46頃')).time.text, '08:46');
  assert.equal(only(parse('午後4:30')).time.text, '16:30');
  assert.equal(only(parse('4:30 PM')).time.text, '16:30');
});

test('missing units: depth marker without a unit is flagged as assumed km', () => {
  const r = parse('d50');
  const x = only(r);
  assert.deepEqual(x.depth, { km: 50, unitAssumed: true });
  assert.match(r.detail, /単位の記載がない/);
});

test('missing units: bare numbers are not guessed', () => {
  for (const s of ['50', '5.5', '4', '7.4']) {
    const r = parse(s);
    assert.equal(r.status, 'unknown', s);
    assert.equal(r.value, null);
  }
  const r = parse('0846 M5.5 50');
  assert.equal(only(r).depth, null);
  assert.deepEqual(r.value.unrecognized, ['50']);
});

test('a depth unit that is not km is not read as km', () => {
  const r = parse('d50m');
  assert.equal(r.status, 'unknown');
  assert.equal(parse('M5.5 d50m').value.readings[0].depth, null);
});

test('震度5 without 弱/強 stays "5" and says so', () => {
  const r = parse('震度5');
  assert.equal(only(r).intensity.scale, '5');
  assert.match(r.detail, /5弱か5強かは分かりません/);
});

test('time vs magnitude mix-ups are not read', () => {
  for (const s of ['M0846', 'M16:53', 'M8.46', 'M12', 'M0']) {
    const r = parse(s);
    assert.equal(r.status, 'unknown', s);
    assert.equal(r.value, null);
  }
  const x = only(parse('5.5 0846'));
  assert.equal(x.time.text, '08:46');
  assert.equal(x.magnitude, null);
  assert.equal(only(parse('M5.5 0846')).magnitude.value, 5.5);
  assert.equal(only(parse('0846 M5.5')).time.text, '08:46');
});

test('invalid times are not read', () => {
  for (const s of ['2575', '25:00', '08:61', '8時70分', '08:46:30', '16.53']) {
    assert.equal(parse(s).status, 'unknown', s);
  }
});

test('typos and unreadable markers are left unread, not corrected', () => {
  const r = parse('震ど4 千葉北東部');
  assert.equal(r.status, 'ok');
  // No usable intensity marker, so the place has no cue: both roles stay as candidates.
  assert.equal(r.value.readings.length, 2);
  for (const x of r.value.readings) assert.equal(x.intensity, null);
  assert.deepEqual(r.value.readings.map((x) => x.area ?? x.epicenter), ['千葉北東部', '千葉北東部']);
  assert.ok(r.value.unrecognized.includes('震ど4'));
  for (const s of ['m5,5', '震度8', '震度4弱', 'M5.5.', '震度5-6']) {
    const y = parse(s);
    if (y.status === 'ok') {
      for (const x2 of y.value.readings) {
        assert.equal(x2.intensity === null || x2.intensity.scale !== '8', true, s);
      }
    }
  }
  assert.equal(parse('震度8').status, 'unknown');
  assert.equal(parse('震度4弱').status, 'unknown');
  assert.equal(parse('震度5-6').status, 'unknown');
});

test('range words stop an exact reading', () => {
  assert.equal(parse('震度5弱以上').status, 'unknown');
  assert.equal(parse('M7クラス').status, 'ok'); // M7 is read; クラス stays unrecognized
  assert.deepEqual(parse('M7クラス').value.unrecognized, ['クラス']);
  assert.equal(parse('M7以上').status, 'unknown');
});

test('comma decimal is not silently truncated', () => {
  const r = parse('M5,5');
  assert.equal(r.status, 'unknown');
});

test('a place with no cue is returned as both epicenter and area', () => {
  const r = parse('千葉 M5.5');
  assert.equal(r.value.readings.length, 2);
  assert.ok(r.value.readings.some((x) => x.epicenter === '千葉' && x.area === null));
  assert.ok(r.value.readings.some((x) => x.area === '千葉' && x.epicenter === null));
  assert.equal(r.value.ambiguous, true);
});

test('an explicit 震源 marker settles the epicenter', () => {
  const x = only(parse('震源は千葉県東方沖 M6.0'));
  assert.equal(x.epicenter, '千葉県東方沖');
  assert.equal(only(parse('震源 能登')).epicenter, '能登');
  assert.equal(parse('震源 不明').status, 'unknown');
});

test('sea names are epicenters; coastal names are areas', () => {
  assert.equal(only(parse('日向灘')).epicenter, '日向灘');
  assert.equal(only(parse('三陸沿岸')).area, '三陸沿岸');
});

test('place followed by a particle', () => {
  const x = only(parse('千葉北東部で震度4'));
  assert.equal(x.area, '千葉北東部');
});

test('words that merely end like place names are not places', () => {
  for (const s of ['全部', '津波', '余震', '揺れた千葉']) {
    assert.equal(parse(s).status === 'ok' && parse(s).value.readings.some((x) => x.area || x.epicenter), false, s);
  }
});

test('questions: item inside a question is not asserted', () => {
  const r = parse('M7.4?');
  const x = only(r);
  assert.equal(x.magnitude, null);
  assert.deepEqual(r.value.question, { texts: ['M7.4'] });
  const y = parse('0846 M5.5 津波来る？');
  assert.equal(only(y).magnitude.value, 5.5);
  assert.deepEqual(y.value.question, { texts: ['津波来る'] });
});

test('a bare question mark is a question with no text', () => {
  const r = parse('？');
  assert.equal(r.status, 'ok');
  assert.deepEqual(r.value.question, { texts: [] });
});

test('multiple questions', () => {
  const r = parse('津波？ 余震？');
  assert.deepEqual(r.value.question, { texts: ['津波', '余震'] });
});

test('date: missing date is assumed to be today and says so in detail', () => {
  const r = parse('0846');
  const x = only(r);
  assert.equal(x.time.dateBasis, 'assumed-today');
  assert.equal(x.time.date, '2026-11-05');
  assert.match(r.detail, /今日（2026-11-05、日本時間）とみなしました。これは推定です/);
});

test('date: assumeToday=false leaves the date unset', () => {
  const r = parse('0846', { assumeToday: false });
  const x = only(r);
  assert.equal(x.time.date, null);
  assert.equal(x.time.iso, null);
  assert.equal(x.time.dateBasis, null);
  assert.doesNotMatch(r.detail, /今日/);
});

test('date: a time later than now is not placed on today', () => {
  const r = parseFragment('16:53 三陸沖 M7.4', { now: '2026-11-05T12:00:00+09:00' });
  const x = only(r);
  assert.equal(x.time.dateBasis, 'unresolved');
  assert.equal(x.time.date, null);
  assert.equal(x.time.iso, null);
  assert.equal(x.time.text, '16:53');
  assert.match(r.detail, /決めていません/);
});

test('date: explicit dates are used and not called assumptions', () => {
  const a = only(parse('2026-11-04 2330'));
  assert.equal(a.time.iso, '2026-11-04T23:30:00+09:00');
  assert.equal(a.time.dateBasis, 'input');
  const b = parse('11/4 23:30');
  assert.equal(only(b).time.iso, '2026-11-04T23:30:00+09:00');
  assert.equal(only(b).time.dateBasis, 'input-year-assumed');
  assert.match(b.detail, /今年とみなしました/);
  assert.equal(only(parse('昨日 23:30')).time.date, '2026-11-04');
  assert.equal(only(parse('11月5日 0846')).time.iso, '2026-11-05T08:46:00+09:00');
  // An unreadable date must not be replaced by "today".
  const bad = parse('2月30日 0846');
  assert.equal(only(bad).time.date, null);
  assert.equal(only(bad).time.iso, null);
  assert.equal(only(bad).time.dateBasis, null);
  assert.doesNotMatch(bad.detail, /今日/);
  assert.ok(bad.value.unrecognized.includes('2月30日'));
});

test('date: UTC clock near midnight still gives the Japan date', () => {
  const r = parseFragment('0030', { now: '2026-11-04T15:40:00Z' }); // 00:40 JST on 11-05
  assert.equal(only(r).time.date, '2026-11-05');
});

test('two different magnitudes are two readings, not a pick', () => {
  const r = parse('M5.5 M6.0');
  assert.equal(r.value.readings.length, 2);
  assert.deepEqual(r.value.readings.map((x) => x.magnitude.value).sort(), [5.5, 6]);
});

test('source: simulated flag changes source only', () => {
  const r = parse('0846 M5.5', { simulated: true });
  assert.equal(r.source, 'simulated');
  assert.equal(r.status, 'ok');
});

test('invalid input types and sizes', () => {
  assert.equal(parseFragment(undefined, { now: NOW }).status, 'error');
  assert.equal(parseFragment(123, { now: NOW }).status, 'error');
  assert.equal(parseFragment({}, { now: NOW }).status, 'error');
  assert.equal(parseFragment('   ', { now: NOW }).status, 'unknown');
  assert.equal(parseFragment('あ'.repeat(201), { now: NOW }).status, 'unsupported');
  assert.equal(parseFragment('0846', { now: 'not a date' }).status, 'error');
});

test('invisible characters do not hide a value', () => {
  const x = only(parse('M​5.5'));
  assert.equal(x.magnitude.value, 5.5);
});

test('BW-S1/S4: nothing is added, no danger level, no advice', () => {
  const r = parse('怖い 震度4 千葉北東部');
  assert.equal(r.status, 'ok');
  assert.deepEqual(r.value.unrecognized, ['怖い']);
  const keys = JSON.stringify(Object.keys(r.value));
  assert.doesNotMatch(keys, /danger|risk|advice|safe|level|warning/i);
  assert.doesNotMatch(r.detail, /落ち着|深呼吸|避難|逃げ|医療|相談|病院|休んで|大丈夫/);
  const t = parse('怖い');
  assert.equal(t.status, 'unknown');
  assert.doesNotMatch(t.detail, /落ち着|深呼吸|避難|逃げ|医療|相談|病院|休んで|大丈夫/);
});

test('BW-S1: output holds only things present in the input', () => {
  const r = parse('M5.5');
  const x = only(r);
  for (const f of ALL_FIELDS.filter((f) => f !== 'magnitude')) assert.equal(x[f], null, f);
});

test('every ok result states that it is an unconfirmed user report', () => {
  for (const s of ['0846 M5.5', '津波？', '5弱', '震度4 千葉北東部']) {
    const r = parse(s);
    assert.equal(r.source, 'user');
    assert.equal(r.value.officiallyConfirmed, false);
    assert.match(r.detail, /公的に確認された情報ではありません/);
  }
});

test('too many readings is "unknown", not a silent pick', () => {
  const r = parse('千葉 東京 埼玉 神奈川 茨城 5弱');
  assert.equal(r.status, 'unknown');
  assert.equal(r.value, null);
  assert.match(r.detail, /どれにも決められませんでした/);
});

test('portable: sources use no Node.js or browser-only APIs', () => {
  const dir = fileURLToPath(new URL('..', import.meta.url));
  for (const f of readdirSync(dir).filter((n) => n.endsWith('.js'))) {
    const src = readFileSync(`${dir}/${f}`, 'utf8');
    assert.doesNotMatch(src, /from\s+['"]node:|require\(|\bprocess\.|\bwindow\b|\bdocument\b|\bBuffer\b|\blocalStorage\b|\bfetch\(/, f);
  }
});
