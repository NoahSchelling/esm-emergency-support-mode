// Tests for the evacuation direction module.
// Run: node --test 'modules/evac/test/*.test.js'
// Synthetic sites sit around a fictional round-number point. Real-data
// tests use approximate positions of public buildings only.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import {
  loadEvacData, prepareEvacData, computeEvacDirections, createExclusion, activeExclusions,
  createHeadingTracker, distanceText, directionText, FALLBACK_LINKS, STRAIGHT_LINE_NOTE, DEFAULT_DATA_URL,
} from '../node.js';

const NOW = Date.parse('2026-11-07T12:00:00+09:00');
const P = { latitude: 35.0, longitude: 138.0 }; // fictional round-number point
const HAZARD_KEYS = ['flood', 'landslide', 'storm_surge', 'earthquake', 'tsunami', 'large_fire', 'inland_flood', 'volcano'];
const HAZARD_LABELS = ['洪水', '崖崩れ、土石流及び地滑り', '高潮', '地震', '津波', '大規模な火事', '内水氾濫', '火山現象'];
const SAFE_CLAIM = /安全です|安全な場所|安全を確認|異常なし|異常はありません|正常|問題ありません|大丈夫|近くにありません|危険はありません|安心|心配ありません|避難できます|通れます/;

function flags(...keys) {
  return HAZARD_KEYS.map((k) => (keys.includes(k) ? '1' : '0')).join('');
}

// Fictional sites. North ~0.67 km (tsunami+earthquake), east ~1.0 km
// (tsunami), south ~1.5 km (earthquake only), west ~2.0 km (tsunami),
// far north-east ~8 km (tsunami, beyond the default 5 km).
function synthetic(extraSites = []) {
  return prepareEvacData({
    format: 'evac-sites/1',
    prefecture: { code: '22000', name: '静岡県' },
    source: { gsi_updated: '2026-10-27', retrieved: '2026-11-07' },
    attribution: '出典：テスト',
    processed: 'テスト用に作成',
    notices: ['注意 1', '注意 2', '注意 3', '注意 4'],
    coverage_note: '市町村が登録し、公開に同意した指定緊急避難場所だけが含まれます。',
    hazards: HAZARD_KEYS.map((key, i) => ({ key, label: HAZARD_LABELS[i] })),
    municipalities: { 99999: { name: '架空町', gsi_updated: '2026-10-27', sites: 5 } },
    fields: ['id', 'name', 'municipality', 'lat', 'lon', 'hazards', 'remarks'],
    sites: [
      ['T-N', '北の架空広場', '99999', 35.006, 138.0, flags('tsunami', 'earthquake'), ''],
      ['T-E', '東の架空高台', '99999', 35.0, 138.011, flags('tsunami'), '「洪水」では2階以上に避難'],
      ['T-S', '南の架空公園', '99999', 34.9865, 138.0, flags('earthquake'), ''],
      ['T-W', '西の架空校庭', '99999', 35.0, 137.978, flags('tsunami', 'flood'), ''],
      ['T-FAR', '遠くの架空丘', '99999', 35.05, 138.06, flags('tsunami'), ''],
      ...extraSites,
    ],
  });
}

const data = synthetic();
const run = (input, opts = {}) => computeEvacDirections(data, { ...P, accuracy: 10, hazard: 'tsunami', position_at_ms: NOW, ...input }, { now: NOW, ...opts });

// A heading tracker result as the app would pass it (portrait, lying flat).
function headingOk(trueHeading, extra = {}) {
  return {
    status: 'ok',
    value: {
      top_true_heading_deg: trueHeading, true_heading_deg: trueHeading, beta: 0, gamma: 0,
      screen_angle_deg: 0, tilt_deg: 0, accuracy_deg: 10, basis: 'ios_compass', at_ms: NOW, ...extra,
    },
    detail: 'テスト',
  };
}
const androidHeading = (h) => headingOk(h, { accuracy_deg: null, basis: 'absolute_orientation' });

function assertShape(r) {
  assert.deepEqual(Object.keys(r).sort(), ['detail', 'kind', 'observed_at', 'source', 'status', 'value']);
  assert.equal(r.kind, 'evac_direction');
  assert.match(r.observed_at, /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}\+09:00$/);
  assert.ok(Object.isFrozen(r));
  if (r.status !== 'ok') assert.equal(r.value, null);
}

function allText(r) {
  return JSON.stringify(r);
}

test('hazard filter: tsunami gives only tsunami sites, nearest first, at most 3', () => {
  const r = run({});
  assertShape(r);
  assert.equal(r.status, 'ok');
  assert.equal(r.source, 'gsi');
  assert.deepEqual(r.value.candidates.map((c) => c.id), ['T-N', 'T-E', 'T-W']);
  for (const c of r.value.candidates) assert.ok(c.hazards.includes('津波'));
  const d = r.value.candidates.map((c) => c.distance_m);
  assert.deepEqual(d, [...d].sort((a, b) => a - b));
  assert.equal(r.value.hazard.label, '津波');
  assert.equal(r.value.straight_line_note, STRAIGHT_LINE_NOTE);
  assert.match(r.detail, /直線の方向です。道順ではありません/);
});

test('hazard filter: earthquake gives N and S only; south site never appears for tsunami', () => {
  const r = run({ hazard: 'earthquake' });
  assert.deepEqual(r.value.candidates.map((c) => c.id), ['T-N', 'T-S']);
  assert.ok(!run({}).value.candidates.some((c) => c.id === 'T-S'));
});

test('bearings to the synthetic sites: N, E, W', () => {
  const [n, e, w] = run({}).value.candidates;
  assert.equal(n.bearing_deg, 0); // never 360
  assert.ok(Math.abs(e.bearing_deg - 90) < 0.1);
  assert.ok(Math.abs(w.bearing_deg - 270) < 0.1);
  assert.match(n.direction_text, /北から約 0 度（北）の方向/);
  assert.match(e.direction_text, /北から約 90 度（東）/);
  assert.equal(e.remarks, '「洪水」では2階以上に避難');
});

test('no heading: no arrow at all, but text directions remain', () => {
  const r = run({});
  assert.equal(r.value.arrow.show, false);
  for (const c of r.value.candidates) {
    assert.equal(c.arrow_deg, null);
    assert.ok(c.arrow_reason.length > 0);
    assert.match(c.direction_text, /北から約/);
  }
});

for (const status of ['unknown', 'stale', 'unsupported', 'denied', 'error']) {
  test(`heading ${status}: no arrow`, () => {
    const r = run({ heading: { status, value: null, detail: `向き：${status}` } });
    assert.equal(r.value.arrow.show, false);
    assert.equal(r.value.arrow.reason, `向き：${status}`);
    assert.ok(r.value.candidates.every((c) => c.arrow_deg === null));
  });
}

test('heading ok: arrow = bearing - heading (screen-up), across the 0/360 boundary', () => {
  const r = run({ heading: headingOk(90) });
  assert.equal(r.value.arrow.show, true);
  const [n, e, w] = r.value.candidates;
  assert.equal(n.arrow_deg, 270); // site north, facing east -> turn left
  assert.equal(e.arrow_deg, 0);
  assert.equal(w.arrow_deg, 180);
  // rounding must not produce 360
  for (const r of [run({ heading: headingOk(0.04) }), run({ heading: headingOk(359.97) })]) {
    for (const c of r.value.candidates) assert.ok(c.arrow_deg >= 0 && c.arrow_deg < 360, String(c.arrow_deg));
  }
  const r2 = run({ heading: headingOk(350) });
  assert.equal(r2.value.candidates[0].arrow_deg, 10);
  assert.equal(r2.value.heading.true_heading_deg, 350);
});

test('GPS course: shown only when moving; a large compass/course mismatch hides the arrow', () => {
  const still = run({ heading: headingOk(0), course: { heading_deg: 180, speed_mps: 0.2, at_ms: NOW } });
  assert.equal(still.value.course.show, false);
  assert.equal(still.value.arrow.show, true); // stationary: course is not used at all
  assert.ok(still.value.candidates.every((c) => c.course_relative_deg === null));

  const moving = run({ heading: headingOk(0), course: { heading_deg: 10, speed_mps: 1.5, at_ms: NOW } });
  assert.equal(moving.value.course.show, true);
  assert.equal(moving.value.arrow.show, true);
  assert.equal(moving.value.candidates[1].course_relative_deg, 80);
  assert.match(moving.value.course.text, /GPS/);

  const mismatch = run({ heading: headingOk(0), course: { heading_deg: 180, speed_mps: 1.5, at_ms: NOW } });
  assert.equal(mismatch.value.arrow.show, false);
  assert.match(mismatch.value.arrow.reason, /食い違って/);
  assert.ok(mismatch.value.candidates.every((c) => c.arrow_deg === null));
  // the course itself is still shown as text
  assert.equal(mismatch.value.course.show, true);
});

test('position error: inside the error circle no direction; wide uncertainty hides the arrow', () => {
  // accuracy 800 m: north site (~667 m) is inside the circle -> no bearing
  const r = run({ accuracy: 800, heading: headingOk(0) });
  const n = r.value.candidates.find((c) => c.id === 'T-N');
  assert.equal(n.bearing_deg, null);
  assert.equal(n.arrow_deg, null);
  assert.match(n.direction_text, /誤差.*より近いため、方向を示せません/);
  // east site (~1.0 km): asin(0.8) = 53 deg > 30 -> text only
  const e = r.value.candidates.find((c) => c.id === 'T-E');
  assert.ok(e.bearing_uncertainty_deg > 30);
  assert.equal(e.arrow_deg, null);
  assert.match(e.arrow_reason, /幅が大きく/);
  assert.match(e.direction_text, /誤差 ±\d+度/);
  // the arrow decision for the device itself is still "show"
  assert.equal(r.value.arrow.show, true);
});

test('position error above the limit -> unknown; missing accuracy -> error', () => {
  const r = run({ accuracy: 5000 });
  assertShape(r);
  assert.equal(r.status, 'unknown');
  assert.match(r.detail, /誤差が大きすぎる/);
  assert.equal(run({ accuracy: undefined }).status, 'error');
  assert.equal(run({ accuracy: -1 }).status, 'error');
  assert.equal(run({ latitude: 95 }).status, 'error');
});

test('hazard must be given and known (no hazard is picked by the module)', () => {
  for (const hazard of [undefined, '', 'unknown', 'shindo']) {
    const r = run({ hazard });
    assertShape(r);
    assert.equal(r.status, 'error');
    assert.match(r.detail, /種別/);
  }
});

test('no candidate: unknown, says "not found in the data", never "none nearby"', () => {
  const r = run({ hazard: 'volcano' });
  assertShape(r);
  assert.equal(r.status, 'unknown');
  assert.match(r.detail, /データの中に見つかりません/);
  assert.match(r.detail, /近くに避難場所がないという意味ではありません/);
  assert.match(r.detail, /公開に同意/);
  assert.doesNotMatch(r.detail, SAFE_CLAIM);
  // a site 8 km away is beyond the limit
  const far = computeEvacDirections(data, { latitude: 35.06, longitude: 138.07, accuracy: 10, hazard: 'earthquake' }, { now: NOW });
  assert.equal(far.status, 'unknown');
});

test('exclusion: hides the current direction and moves to the next candidate', () => {
  const first = run({}).value.candidates[0];
  const ex = createExclusion(first.bearing_deg, NOW);
  assert.equal(ex.half_width_deg, 30);
  assert.equal(ex.until_ms - ex.created_ms, 10 * 60000);
  const r = run({ exclusions: [ex] });
  assert.deepEqual(r.value.candidates.map((c) => c.id), ['T-E', 'T-W']);
  assert.equal(r.value.excluded_count, 1); // T-FAR is beyond 5 km anyway
  assert.equal(r.status, 'ok');
  assert.equal(r.value.exclusions.length, 1);
  assert.match(r.value.exclusions[0].text, /北から約 0 度（北）の方向の前後 30 度/);
  assert.match(r.detail, /除外した 1 か所/);
});

test('exclusion: boundary of the range and the 0/360 wrap', () => {
  // center 330 +/- 30 covers 300..360 and includes north (0)
  assert.deepEqual(run({ exclusions: [createExclusion(330, NOW)] }).value.candidates.map((c) => c.id), ['T-E', 'T-W']);
  // center 31: north (0) is 31 deg away -> not excluded
  assert.equal(run({ exclusions: [createExclusion(31, NOW)] }).value.candidates[0].id, 'T-N');
  // east (90) is exactly 30 deg from 60 -> excluded (inclusive)
  assert.ok(!run({ exclusions: [createExclusion(60, NOW)] }).value.candidates.some((c) => c.id === 'T-E'));
});

test('exclusion: expires, can be undone, and all-excluded gives unknown', () => {
  const ex = createExclusion(0, NOW - 11 * 60000);
  assert.equal(activeExclusions([ex], NOW).length, 0);
  assert.equal(run({ exclusions: [ex] }).value.candidates[0].id, 'T-N');
  // undo = the caller removes it from the list
  assert.equal(run({ exclusions: [] }).value.excluded_count, 0);
  const all = [createExclusion(0, NOW), createExclusion(90, NOW), createExclusion(270, NOW)];
  const r = run({ exclusions: all });
  assert.equal(r.status, 'unknown');
  assert.match(r.detail, /除外した 3 か所/);
  assert.match(r.detail, /データの中に見つかりません/);
  assert.throws(() => createExclusion(NaN, NOW));
});

test('privacy: the result never contains the position', () => {
  const pos = { latitude: 35.0012345, longitude: 138.0012345 };
  const r = computeEvacDirections(data, { ...pos, accuracy: 10, hazard: 'tsunami', heading: headingOk(10) }, { now: NOW });
  const s = allText(r);
  assert.doesNotMatch(s, /35\.001|138\.001/);
  assert.doesNotMatch(s, /"(latitude|longitude|lat|lon)"/);
  // site coordinates are not echoed either (they would let anyone rebuild the position)
  assert.doesNotMatch(s, /35\.006|137\.978/);
  // nor values derived from the position (declination, accuracy)
  assert.doesNotMatch(s, /declination|accuracy_m/);
});

test('wording: no safety claims, no shindo, no injury words', () => {
  const variants = [run({}), run({ heading: headingOk(0) }), run({ hazard: 'volcano' }), run({ accuracy: 5000 }), run({ hazard: 'x' })];
  for (const r of variants) {
    const s = allText(r);
    assert.doesNotMatch(s, SAFE_CLAIM);
    // (?<!だ) skips "だけが" ("only"), which is not the injury word.
    assert.doesNotMatch(s, /震度|(?<!だ)けが|怪我|転倒|負傷/);
  }
});

test('simulated input is marked simulated', () => {
  assert.equal(run({ source: 'simulated' }).source, 'simulated');
});

test('text helpers', () => {
  assert.equal(distanceText(4), '約 10 m');
  assert.equal(distanceText(344), '約 340 m');
  assert.equal(distanceText(999), '約 1000 m');
  assert.equal(distanceText(1049), '約 1.0 km');
  assert.equal(distanceText(12345), '約 12.3 km');
  assert.equal(directionText(359.6), '北から約 0 度（北）の方向');
  assert.equal(directionText(135, 5), '北から約 135 度（南東）の方向');
  assert.equal(directionText(135, 12), '北から約 135 度（南東、誤差 ±12度）の方向');
});

test('works with a real heading tracker result', () => {
  const t = createHeadingTracker();
  for (const dt of [300, 200, 100, 0]) {
    t.push({ type: 'deviceorientationabsolute', alpha: 0, beta: 10, gamma: 0, absolute: true, webkit_heading: null, webkit_accuracy: null, at_ms: NOW - dt });
  }
  const heading = t.read({ nowMs: NOW, screenAngleDeg: 0, declinationWestDeg: 7.5 });
  // Android-like heading (no accuracy): confirmed by a recent GPS match
  const r = run({ heading, compass_confirmed_at_ms: NOW - 1000 });
  assert.equal(r.value.arrow.show, true);
  // top points magnetic north = true 352.5; east site at 90 -> turn 97.5 right
  assert.ok(Math.abs(r.value.candidates[1].arrow_deg - 97.5) < 0.2);
});

// ---------------------------------------------------------------- real data

const real = await loadEvacData();
const raw = JSON.parse(await readFile(DEFAULT_DATA_URL, 'utf8'));

test('real data: shape, attribution, notices, coverage note', () => {
  assert.equal(raw.format, 'evac-sites/1');
  assert.equal(raw.sites.length, 2885);
  assert.equal(raw.notices.length, 4);
  assert.match(raw.attribution, /国土地理院/);
  assert.match(raw.processed, /国土地理院が作成したものではありません/);
  assert.match(raw.coverage_note, /公開に同意/);
  assert.equal(raw.source.gsi_updated, '2026-10-27');
  assert.equal(Object.keys(raw.municipalities).length, 35);
  for (const s of raw.sites) {
    assert.match(s[0], /^E22\d{11}$/);
    assert.match(s[5], /^[01]{8}$/);
    assert.ok(s[3] > 34.4 && s[3] < 35.8 && s[4] > 137.3 && s[4] < 139.3);
  }
});

// Approximate positions of public buildings.
const PUBLIC = [
  ['静岡県庁', 34.9769, 138.3831],
  ['下田市役所', 34.6795, 138.9453],
  ['沼津市役所', 35.0956, 138.8636],
];

for (const [label, latitude, longitude] of PUBLIC) {
  test(`real data: tsunami near ${label} lists only tsunami sites, nearest first`, () => {
    const r = computeEvacDirections(real, { latitude, longitude, accuracy: 30, hazard: 'tsunami' }, { now: NOW });
    assertShape(r);
    assert.equal(r.status, 'ok');
    assert.ok(r.value.candidates.length >= 1 && r.value.candidates.length <= 3);
    for (const c of r.value.candidates) {
      assert.ok(c.hazards.includes('津波'), c.name);
      assert.ok(c.municipality);
    }
    const d = r.value.candidates.map((c) => c.distance_m);
    assert.deepEqual(d, [...d].sort((a, b) => a - b));
    assert.equal(r.value.data_updated, '2026-10-27');
  });
}

test('real data: a point far outside Shizuoka -> unknown (not found in the data)', () => {
  const r = computeEvacDirections(real, { latitude: 35.0, longitude: 135.0, accuracy: 30, hazard: 'tsunami' }, { now: NOW });
  assert.equal(r.status, 'unknown');
  assert.match(r.detail, /データの中に見つかりません/);
});

test('fallback links: https, fixed (no position), private ones say they are not official', () => {
  assert.ok(FALLBACK_LINKS.length >= 2);
  assert.equal(FALLBACK_LINKS[0].kind, 'public');
  for (const l of FALLBACK_LINKS) {
    assert.match(l.url, /^https:\/\//);
    assert.doesNotMatch(l.url, /[{}]|lat=|lon=|latitude|longitude/);
    if (l.kind === 'private') assert.match(l.note, /公的な発表ではありません/);
  }
});

test('module sources: no platform APIs in the pure files, no network in them', async () => {
  for (const f of ['../geo.js', '../heading.js', '../evac.js', '../fallback.js', '../index.js']) {
    const src = await readFile(new URL(f, import.meta.url), 'utf8');
    const code = src.replace(/\/\/.*$/gm, '');
    assert.doesNotMatch(code, /\bfetch\(|XMLHttpRequest|sendBeacon|WebSocket|navigator\.|window\.|document\./, f);
  }
});


// ---------------------------------------------------------------- review fixes (2026-11-07)

test('position age: a fix older than 15 s, or without a time, gives no arrow', () => {
  const ok = run({ heading: headingOk(0), position_at_ms: NOW - 14000 });
  assert.equal(ok.value.arrow.show, true);
  assert.equal(ok.value.position_age_s, 14);
  const old = run({ heading: headingOk(0), position_at_ms: NOW - 16000 });
  assert.equal(old.value.arrow.show, false);
  assert.match(old.value.arrow.reason, /16 秒前/);
  assert.ok(old.value.candidates.every((c) => c.arrow_deg === null));
  // the text direction is still given
  assert.match(old.value.candidates[0].direction_text, /北から約/);
  const none = run({ heading: headingOk(0), position_at_ms: undefined });
  assert.equal(none.value.arrow.show, false);
  assert.match(none.value.arrow.reason, /時刻が分からない/);
});

test('heading age is checked here too (not only in the tracker)', () => {
  assert.equal(run({ heading: headingOk(0, { at_ms: NOW - 3600_000 }) }).value.arrow.show, false);
  assert.equal(run({ heading: headingOk(0, { at_ms: NOW + 60_000 }) }).value.arrow.show, false);
});

test('Android (no accuracy): no arrow until confirmed by the GPS course; expires', () => {
  const none = run({ heading: androidHeading(0) });
  assert.equal(none.value.arrow.show, false);
  assert.match(none.value.arrow.reason, /精度が分からない/);
  assert.equal(none.value.heading.accuracy_known, false);
  assert.equal(run({ heading: androidHeading(0), compass_confirmed_at_ms: NOW - 19_000 }).value.arrow.show, true);
  assert.equal(run({ heading: androidHeading(0), compass_confirmed_at_ms: NOW - 21_000 }).value.arrow.show, false);
  // while walking, it must keep agreeing with the course (25 deg off -> no arrow)
  const walking = run({ heading: androidHeading(0), compass_confirmed_at_ms: NOW, course: { heading_deg: 25, speed_mps: 1.5, at_ms: NOW } });
  assert.equal(walking.value.arrow.show, false);
  assert.match(walking.value.arrow.reason, /一致していない/);
  // an iPhone heading with a good accuracy needs no confirmation
  assert.equal(run({ heading: headingOk(0) }).value.arrow.show, true);
});

test('compass check: a match confirms, a large mismatch clears', async () => {
  const { createCompassCheck, courseFrom } = await import('../heading.js');
  const chk = createCompassCheck();
  const moving = (deg) => courseFrom({ heading_deg: deg, speed_mps: 1.5, at_ms: NOW }, NOW);
  chk.update(androidHeading(10), moving(30), NOW); // 20 deg apart -> match
  assert.equal(chk.confirmedAtMs, NOW);
  chk.update(androidHeading(10), courseFrom({ heading_deg: 200, speed_mps: 0.2, at_ms: NOW }, NOW), NOW + 1); // standing still
  assert.equal(chk.confirmedAtMs, NOW);
  chk.update(androidHeading(10), moving(35), NOW + 2); // 25 deg: no longer a match -> clears
  assert.equal(chk.confirmedAtMs, null);
  chk.update(androidHeading(10), moving(10), NOW + 3);
  assert.equal(chk.confirmedAtMs, NOW + 3);
  chk.update({ status: 'stale', value: null }, moving(10), NOW + 4); // heading gap clears
  assert.equal(chk.confirmedAtMs, null);
});

test('exclusion with the site id: the site does not come back after moving', () => {
  const first = run({}).value.candidates[0];
  assert.equal(first.id, 'T-N');
  const ex = createExclusion(first.bearing_deg, NOW, { siteId: first.id });
  assert.equal(ex.site_id, 'T-N');
  // move about 900 m east: T-N is now to the north-west (outside 0 +/- 30)
  const at = { latitude: 35.0, longitude: 138.0099, accuracy: 10, hazard: 'tsunami', position_at_ms: NOW };
  const moved = computeEvacDirections(data, { ...at, exclusions: [ex] }, { now: NOW });
  assert.ok(!moved.value.candidates.some((c) => c.id === 'T-N'));
  // with a direction-only exclusion it would come back
  const dirOnly = computeEvacDirections(data, { ...at, exclusions: [createExclusion(first.bearing_deg, NOW)] }, { now: NOW });
  assert.ok(dirOnly.value.candidates.some((c) => c.id === 'T-N'));
});

test('bearing uncertainty boundary: about 30 deg still allows the arrow, more does not', () => {
  // asin(acc / d) = 30 deg -> acc = d / 2. T-E is about 1002 m away.
  const d = run({}).value.candidates.find((c) => c.id === 'T-E').distance_m;
  const at = run({ accuracy: d / 2 - 1, heading: headingOk(0) }).value.candidates.find((c) => c.id === 'T-E');
  assert.ok(at.arrow_deg !== null, JSON.stringify(at));
  const over = run({ accuracy: d / 2 + 5, heading: headingOk(0) }).value.candidates.find((c) => c.id === 'T-E');
  assert.equal(over.arrow_deg, null);
});

test('malformed heading values never fall back to an arrow pointing up (N1)', () => {
  const bad = [
    headingOk(0, { screen_angle_deg: undefined }),
    headingOk(0, { beta: 90 }), // screen normal horizontal
    headingOk(0, { beta: undefined }),
    headingOk(0, { screen_angle_deg: 90 }), // landscape not allowed
    headingOk(0, { beta: 50 }), // beyond the tilt limit
    headingOk(NaN),
    headingOk(0, { accuracy_deg: 'x' }),
  ];
  for (const h of bad) {
    const r = run({ heading: h });
    assert.equal(r.value.arrow.show, false, JSON.stringify(h.value));
    assert.ok(r.value.candidates.every((c) => c.arrow_deg === null));
  }
});

test('siteCoordinates: public site coordinates by id, only on request', async () => {
  const r = computeEvacDirections(data, { latitude: 35.0012345, longitude: 138.0012345, accuracy: 10, hazard: 'tsunami', heading: headingOk(10) }, { now: NOW });
  const id = r.value.candidates[0].id;
  const { siteCoordinates } = await import('../evac.js');
  const c = siteCoordinates(data, id);
  assert.ok(Number.isFinite(c.latitude) && Number.isFinite(c.longitude));
  assert.equal(siteCoordinates(data, 'no-such-id'), null);
  assert.equal(siteCoordinates(null, id), null);
});
