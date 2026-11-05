// Tests for the area lookup. Run: node --test modules/area/test/
// Positions are public facilities (city/town offices, the prefectural
// office), points in the sea, points outside the prefecture, or points
// computed from the data itself (boundary points). No personal locations.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { loadAreaData, locateArea, prepareAreaData, toIsoJst, DEFAULT_DATA_URL } from '../node.js';

const data = await loadAreaData();
const raw = JSON.parse(await readFile(DEFAULT_DATA_URL, 'utf8'));
const NOW = new Date('2026-11-05T05:00:00Z');

function locate(latitude, longitude, accuracy, extra = {}) {
  return locateArea(data, { latitude, longitude, accuracy, ...extra }, { now: NOW });
}

function assertShape(r) {
  assert.deepEqual(Object.keys(r).sort(), ['detail', 'kind', 'observed_at', 'source', 'status', 'value']);
  assert.equal(r.kind, 'area');
  assert.match(r.observed_at, /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}\+09:00$/);
  assert.equal(typeof r.detail, 'string');
  assert.ok(r.detail.length > 0);
  if (r.status !== 'ok') assert.equal(r.value, null);
}

// Public facilities. Coordinates are approximate positions of the buildings.
// expected: [municipality code, municipality name, warning city code,
//            warning city name, group code, primary code]
const FACILITIES = [
  ['静岡県庁', 34.9769, 138.3831, ['2210100', '静岡葵区', '2210001', '静岡市南部', '220011', '220010']],
  ['浜松市役所', 34.7108, 137.7261, ['2213800', '浜松中央区', '2213001', '浜松市南部', '220042', '220040']],
  ['沼津市役所', 35.0956, 138.8636, ['2220300', '沼津市', '2220300', '沼津市', '220031', '220030']],
  ['富士宮市役所', 35.2219, 138.6214, ['2220700', '富士宮市', '2220700', '富士宮市', '220032', '220030']],
  ['熱海市役所', 35.0959, 139.0716, ['2220500', '熱海市', '2220500', '熱海市', '220021', '220020']],
  ['下田市役所', 34.6795, 138.9453, ['2221900', '下田市', '2221900', '下田市', '220022', '220020']],
];

for (const [label, lat, lon, [mCode, mName, cCode, cName, gCode, pCode]] of FACILITIES) {
  test(`public facility: ${label}`, () => {
    const r = locate(lat, lon, 20);
    assertShape(r);
    assert.equal(r.status, 'ok');
    assert.equal(r.source, 'jma');
    const v = r.value;
    assert.equal(v.determined, true);
    assert.equal(v.outside_possible, false);
    assert.deepEqual(v.municipality.area, { code: mCode, name: mName });
    assert.deepEqual(v.warning_areas.city.area, { code: cCode, name: cName });
    assert.equal(v.warning_areas.group.area.code, gCode);
    assert.equal(v.warning_areas.primary.area.code, pCode);
    assert.deepEqual(v.warning_areas.prefecture.area, { code: '220000', name: '静岡県' });
    assert.match(v.attribution, /出典：気象庁ホームページ/);
  });
}

test('an island (Hatsushima) belongs to Atami', () => {
  const r = locate(35.0405, 139.1705, 20);
  assert.equal(r.status, 'ok');
  assert.equal(r.value.warning_areas.city.area.code, '2220500');
});

test('names and codes are the JMA values', () => {
  const r = locate(34.9769, 138.3831, 20);
  const c = r.value.municipality.candidates[0];
  assert.equal(c.region_name, '静岡県静岡市のうち葵区');
  const city = r.value.warning_areas.city.candidates[0];
  assert.equal(city.region_name, '気象庁予報警報規程別表第四の二に示す「静岡市南部」の区域');
});

// ---- boundaries: find points on a shared boundary from the data itself

function decode(enc, unit) {
  const pts = [];
  let x = 0;
  let y = 0;
  for (let i = 0; i < enc.length; i += 2) {
    if (i === 0) [x, y] = [enc[0], enc[1]];
    else [x, y] = [x + enc[i], y + enc[i + 1]];
    pts.push([x / unit, y / unit]);
  }
  return pts;
}

function featureOf(layer, code) {
  const f = raw.layers[layer].features.find((x) => x.code === code);
  assert.ok(f, `${layer} ${code} exists`);
  return f.rings.map((r) => decode(r, raw.encoding.unit_per_degree));
}

// A vertex of feature A that is also (within 1e-5 deg) a vertex of feature B.
function sharedVertex(layer, codeA, codeB) {
  const a = featureOf(layer, codeA).flat();
  const b = featureOf(layer, codeB).flat();
  const key = (p) => `${Math.round(p[0] * 1e5)},${Math.round(p[1] * 1e5)}`;
  const setB = new Set(b.map(key));
  const hit = a.find((p) => setB.has(key(p)));
  assert.ok(hit, `shared vertex between ${codeA} and ${codeB}`);
  return hit;
}

test('boundary between Numazu and Mishima: both returned, none chosen', () => {
  const [lon, lat] = sharedVertex('city', '2220300', '2220600');
  const r = locate(lat, lon, 0);
  assertShape(r);
  assert.equal(r.status, 'ok');
  const city = r.value.warning_areas.city;
  assert.equal(city.determined, false);
  assert.equal(city.area, null);
  const codes = city.candidates.map((c) => c.code);
  assert.ok(codes.includes('2220300') && codes.includes('2220600'), codes.join(','));
  assert.equal(r.value.determined, false);
  assert.match(r.detail, /1 つに決めず/);
});

test('boundary between Shizuoka-shi north and south: upper levels differ too', () => {
  const [lon, lat] = sharedVertex('city', '2210001', '2210002');
  const r = locate(lat, lon, 10);
  assert.equal(r.status, 'ok');
  const wa = r.value.warning_areas;
  const cityCodes = wa.city.candidates.map((c) => c.code);
  assert.ok(cityCodes.includes('2210001') && cityCodes.includes('2210002'));
  // 静岡市南部 is in 中部南, 静岡市北部 in 中部北
  const groupCodes = wa.group.candidates.map((c) => c.code);
  assert.ok(groupCodes.includes('220011') && groupCodes.includes('220012'));
  assert.equal(wa.group.determined, false);
  // both belong to 中部 / 静岡県, but those are still not "determined" only
  // if the circle may leave the prefecture
  assert.equal(wa.primary.candidates.length, 1);
  assert.equal(wa.primary.determined, !r.value.outside_possible);
});

test('a point near a boundary with a small accuracy still gets all nearby areas', () => {
  // 35 m away from a shared vertex is still inside the data error margin
  const [lon, lat] = sharedVertex('municipality', '2210100', '2210200');
  const r = locate(lat + 35 / 111195, lon, 5);
  assert.equal(r.status, 'ok');
  assert.ok(r.value.municipality.candidates.length >= 2);
  assert.equal(r.value.municipality.area, null);
});

test('the error circle widens the candidates', () => {
  const small = locate(34.9769, 138.3831, 20);
  const large = locate(34.9769, 138.3831, 20000);
  assert.equal(small.value.warning_areas.city.candidates.length, 1);
  assert.ok(large.value.warning_areas.city.candidates.length > 1);
  assert.equal(large.value.warning_areas.city.area, null);
  // the candidate that holds the centre is marked, but not chosen
  const centre = large.value.warning_areas.city.candidates.filter((c) => c.center_inside);
  assert.deepEqual(centre.map((c) => c.code), ['2210001']);
});

// ---- sea and outside the prefecture

test('sea (Suruga Bay): unknown', () => {
  const r = locate(34.85, 138.55, 50);
  assertShape(r);
  assert.equal(r.status, 'unknown');
  assert.match(r.detail, /区域の外/);
  assert.match(r.detail, /警報・注意報がないことを意味しません/);
});

test('sea (Enshu-nada, offshore): unknown', () => {
  const r = locate(34.4, 137.9, 100);
  assert.equal(r.status, 'unknown');
});

test('outside the prefecture (Tokyo Station): unknown', () => {
  const r = locate(35.681, 139.767, 20);
  assert.equal(r.status, 'unknown');
  assert.equal(r.value, null);
});

test('outside the prefecture near the border (Hakone town office): unknown', () => {
  const r = locate(35.2329, 139.1069, 30);
  assert.equal(r.status, 'unknown');
});

test('sea with an error circle that reaches land: candidates, outside possible', () => {
  const r = locate(34.85, 138.55, 30000);
  assert.equal(r.status, 'ok');
  assert.equal(r.value.outside_possible, true);
  assert.equal(r.value.determined, false);
  // even the prefecture is not "determined" because the circle leaves it
  assert.equal(r.value.warning_areas.prefecture.determined, false);
  assert.equal(r.value.warning_areas.prefecture.area, null);
  assert.ok(r.value.warning_areas.city.candidates.every((c) => !c.center_inside));
  assert.match(r.detail, /区域の外/);
});

test('coast: a point just offshore with a wide enough circle is not decided', () => {
  // the prefecture outline vertex closest to the Shizuoka prefectural office
  // side of Suruga Bay, moved 300 m further south (sea side)
  const outline = featureOf('prefecture', '220000').flat();
  const [lon, lat] = outline.reduce((best, p) =>
    Math.hypot(p[0] - 138.48, p[1] - 34.95) < Math.hypot(best[0] - 138.48, best[1] - 34.95) ? p : best,
  );
  const sea = [lat - 300 / 111195, lon];
  const narrow = locate(sea[0], sea[1], 10);
  const wide = locate(sea[0], sea[1], 1000);
  assert.notEqual(narrow.status, 'error');
  assert.equal(wide.status, 'ok');
  assert.equal(wide.value.outside_possible, true);
  assert.equal(wide.value.determined, false);
});

// ---- inputs and data errors

test('missing accuracy: error, not a guess', () => {
  const r = locateArea(data, { latitude: 34.9769, longitude: 138.3831 }, { now: NOW });
  assertShape(r);
  assert.equal(r.status, 'error');
  assert.match(r.detail, /誤差/);
});

test('negative accuracy, NaN and out-of-range values: error', () => {
  assert.equal(locate(34.9769, 138.3831, -1).status, 'error');
  assert.equal(locate(Number.NaN, 138.3831, 10).status, 'error');
  assert.equal(locate(34.9769, 200, 10).status, 'error');
  assert.equal(locate('34.9', 138.3831, 10).status, 'error');
  assert.equal(locateArea(data, null).status, 'error');
});

test('no data loaded: error', () => {
  const r = locateArea(null, { latitude: 34.9769, longitude: 138.3831, accuracy: 10 }, { now: NOW });
  assertShape(r);
  assert.equal(r.status, 'error');
});

test('invalid data is rejected when preparing', () => {
  assert.throws(() => prepareAreaData({ format: 'other' }));
  assert.throws(() => prepareAreaData({ ...raw, simplification: {} }));
});

test('simulated input is marked as simulated', () => {
  const r = locate(34.9769, 138.3831, 20, { source: 'simulated' });
  assert.equal(r.source, 'simulated');
  const u = locate(35.681, 139.767, 20, { source: 'simulated' });
  assert.equal(u.source, 'simulated');
});

test('observed_at is ISO 8601 with the +09:00 offset', () => {
  assert.equal(toIsoJst(new Date('2026-11-05T15:30:00.250Z')), '2026-11-06T00:30:00.250+09:00');
  assert.equal(locate(34.9769, 138.3831, 20).observed_at, '2026-11-05T14:00:00.000+09:00');
});

test('the result does not echo the position back', () => {
  const r = locate(34.9769, 138.3831, 20);
  const text = JSON.stringify(r);
  assert.ok(!text.includes('34.9769') && !text.includes('138.3831'));
});
