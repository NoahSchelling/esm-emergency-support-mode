// Geometry helpers: great-circle distance and bearing, angle arithmetic,
// compass point names, and the GSI approximation of magnetic declination.
// No I/O and no platform APIs (loads in browsers and Node.js).

export const EARTH_R = 6371008.8; // mean earth radius in metres
const RAD = Math.PI / 180;

// Normalise any angle in degrees to [0, 360).
export function norm360(deg) {
  const r = deg % 360;
  const v = r < 0 ? r + 360 : r;
  return v === 360 || Object.is(v, -0) ? 0 : v;
}

// Signed smallest difference a - b in degrees, in (-180, 180].
export function angleDiff(a, b) {
  let d = norm360(a - b);
  if (d > 180) d -= 360;
  return d;
}

// Great-circle (haversine) distance in metres.
export function distanceM(lat1, lon1, lat2, lon2) {
  const p1 = lat1 * RAD;
  const p2 = lat2 * RAD;
  const dp = (lat2 - lat1) * RAD;
  const dl = (lon2 - lon1) * RAD;
  const h = Math.sin(dp / 2) ** 2 + Math.cos(p1) * Math.cos(p2) * Math.sin(dl / 2) ** 2;
  return 2 * EARTH_R * Math.asin(Math.min(1, Math.sqrt(h)));
}

// Initial great-circle bearing from point 1 to point 2, degrees clockwise
// from true north, in [0, 360).
export function bearingDeg(lat1, lon1, lat2, lon2) {
  const p1 = lat1 * RAD;
  const p2 = lat2 * RAD;
  const dl = (lon2 - lon1) * RAD;
  const y = Math.sin(dl) * Math.cos(p2);
  const x = Math.cos(p1) * Math.sin(p2) - Math.sin(p1) * Math.cos(p2) * Math.cos(dl);
  return norm360(Math.atan2(y, x) / RAD);
}

// 16-point compass names in Japanese, clockwise from north.
export const COMPASS_16 = Object.freeze([
  '北', '北北東', '北東', '東北東', '東', '東南東', '南東', '南南東',
  '南', '南南西', '南西', '西南西', '西', '西北西', '北西', '北北西',
]);

export function compassName(deg) {
  return COMPASS_16[Math.round(norm360(deg) / 22.5) % 16];
}

// Magnetic declination (GSI approximation for epoch 2020.0).
// Source: Geospatial Information Authority of Japan, "近似式から求める"
// https://vldb.gsi.go.jp/sokuchi/geomag/menu_04/index.html
//   D = 8°15.822' + 18.462'Δφ - 7.726'Δλ + 0.007'Δφ² - 0.007'ΔφΔλ - 0.655'Δλ²
//   Δφ = φ - 37°, Δλ = λ - 138° (degrees). D is positive WEST of true north.
// It ignores local magnetic anomalies and has lower accuracy on remote
// islands. The value is for 2020-01-01; the field drifts over time.
export const DECLINATION_MODEL = Object.freeze({
  name: 'GSI 2020.0 quadratic approximation',
  epoch: '2020-01-01',
  url: 'https://vldb.gsi.go.jp/sokuchi/geomag/menu_04/index.html',
  // Range in which we use it (roughly Japan; the GSI calculator accepts
  // 20-50N, 120-154E). Outside it the declination is "unknown".
  lat_min: 20, lat_max: 50, lon_min: 120, lon_max: 154,
});

export function declinationWestDeg(lat, lon) {
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null;
  const m = DECLINATION_MODEL;
  if (lat < m.lat_min || lat > m.lat_max || lon < m.lon_min || lon > m.lon_max) return null;
  const dp = lat - 37;
  const dl = lon - 138;
  const minutes = 8 * 60 + 15.822 + 18.462 * dp - 7.726 * dl + 0.007 * dp * dp - 0.007 * dp * dl - 0.655 * dl * dl;
  return minutes / 60;
}

// Convert a heading measured from magnetic north to one from true north.
// With west declination D, magnetic north lies D degrees west of true north,
// so true = magnetic - D.
export function magneticToTrue(magneticDeg, declWestDeg) {
  return norm360(magneticDeg - declWestDeg);
}
