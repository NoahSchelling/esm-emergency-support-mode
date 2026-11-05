// Area lookup: latitude/longitude (+ accuracy) -> municipality and JMA
// warning/advisory area codes, computed entirely on the device.
//
// This file has no I/O and no platform-specific APIs, so it can be imported
// from both browsers and Node.js. Loading the data file is done by
// ./node.js (Node.js) or ./browser/load.js (browsers).
//
// Names and codes are returned exactly as they appear in the JMA data.
// The function never decides between areas when the accuracy circle (plus
// the known simplification error of the data) touches more than one area.

const KIND = 'area';
const EARTH_R = 6371008.8;
const M_PER_DEG = (Math.PI / 180) * EARTH_R;
const SUPPORTED_FORMAT = 'bw-area/1';

// ------------------------------------------------------------ result helpers

function pad(n, w = 2) {
  return String(n).padStart(w, '0');
}

// ISO 8601 in Japan Standard Time with an explicit offset.
export function toIsoJst(date) {
  const t = new Date(date.getTime() + 9 * 3600 * 1000);
  return (
    `${t.getUTCFullYear()}-${pad(t.getUTCMonth() + 1)}-${pad(t.getUTCDate())}` +
    `T${pad(t.getUTCHours())}:${pad(t.getUTCMinutes())}:${pad(t.getUTCSeconds())}` +
    `.${pad(t.getUTCMilliseconds(), 3)}+09:00`
  );
}

function result(status, value, detail, source, now) {
  return {
    kind: KIND,
    status,
    value: status === 'ok' ? value : null,
    observed_at: toIsoJst(now),
    source,
    detail,
  };
}

// ------------------------------------------------------------ data

function decodeRing(enc, unit) {
  if (!Array.isArray(enc) || enc.length < 6 || enc.length % 2 !== 0) {
    throw new Error('ring must be an even-length integer list with at least 3 points');
  }
  const out = new Float64Array(enc.length);
  let x = 0;
  let y = 0;
  for (let i = 0; i < enc.length; i += 2) {
    if (!Number.isInteger(enc[i]) || !Number.isInteger(enc[i + 1])) {
      throw new Error('ring values must be integers');
    }
    if (i === 0) {
      x = enc[0];
      y = enc[1];
    } else {
      x += enc[i];
      y += enc[i + 1];
    }
    out[i] = x / unit;
    out[i + 1] = y / unit;
  }
  return out;
}

function prepareLayer(layer, unit, name) {
  if (!layer || !Array.isArray(layer.features)) {
    throw new Error(`layer ${name} is missing`);
  }
  return {
    type: layer.type,
    features: layer.features.map((f) => {
      if (typeof f.code !== 'string' || typeof f.name !== 'string') {
        throw new Error(`layer ${name}: feature without code/name`);
      }
      const rings = f.rings.map((r) => decodeRing(r, unit));
      let minX = Infinity;
      let minY = Infinity;
      let maxX = -Infinity;
      let maxY = -Infinity;
      for (const r of rings) {
        for (let i = 0; i < r.length; i += 2) {
          if (r[i] < minX) minX = r[i];
          if (r[i] > maxX) maxX = r[i];
          if (r[i + 1] < minY) minY = r[i + 1];
          if (r[i + 1] > maxY) maxY = r[i + 1];
        }
      }
      return {
        code: f.code,
        name: f.name,
        region_name: f.region_name ?? null,
        group: f.group ?? null,
        rings,
        bbox: [minX, minY, maxX, maxY],
      };
    }),
  };
}

/**
 * Validate and decode the JSON produced by tools/build_area_data.py.
 * Throws an Error when the data is not usable.
 */
export function prepareAreaData(json) {
  if (!json || json.format !== SUPPORTED_FORMAT) {
    throw new Error(`unsupported area data format (expected ${SUPPORTED_FORMAT})`);
  }
  const unit = json.encoding?.unit_per_degree;
  const maxErr = json.simplification?.max_error_m;
  if (!Number.isFinite(unit) || unit <= 0) throw new Error('encoding.unit_per_degree is invalid');
  if (!Number.isFinite(maxErr) || maxErr < 0) throw new Error('simplification.max_error_m is invalid');
  const layers = {
    city: prepareLayer(json.layers?.city, unit, 'city'),
    municipality: prepareLayer(json.layers?.municipality, unit, 'municipality'),
    prefecture: prepareLayer(json.layers?.prefecture, unit, 'prefecture'),
  };
  if (layers.prefecture.features.length !== 1) throw new Error('exactly one prefecture is expected');
  const groups = json.groups ?? {};
  for (const f of layers.city.features) {
    if (!groups[f.group]) throw new Error(`city ${f.code}: group ${f.group} not in groups`);
  }
  return {
    prepared: true,
    prefecture: json.prefecture,
    maxErrorM: maxErr,
    attribution: json.source?.attribution ?? null,
    processed: json.source?.processed ?? null,
    groups,
    layers,
  };
}

// ------------------------------------------------------------ geometry

function pointInRings(lon, lat, rings) {
  // even-odd rule over all rings, so holes are handled as well
  let inside = false;
  for (const r of rings) {
    const n = r.length / 2;
    for (let i = 0, j = n - 1; i < n; j = i++) {
      const xi = r[2 * i];
      const yi = r[2 * i + 1];
      const xj = r[2 * j];
      const yj = r[2 * j + 1];
      if (yi > lat !== yj > lat) {
        const x = ((xj - xi) * (lat - yi)) / (yj - yi) + xi;
        if (lon < x) inside = !inside;
      }
    }
  }
  return inside;
}

// Distance in metres from (lon, lat) to the nearest ring edge, using a local
// equirectangular projection centred on the point.
function distanceToRingsM(lon, lat, rings) {
  const kx = M_PER_DEG * Math.cos((lat * Math.PI) / 180);
  const ky = M_PER_DEG;
  let best = Infinity;
  for (const r of rings) {
    const n = r.length / 2;
    for (let i = 0, j = n - 1; i < n; j = i++) {
      const ax = (r[2 * j] - lon) * kx;
      const ay = (r[2 * j + 1] - lat) * ky;
      const bx = (r[2 * i] - lon) * kx;
      const by = (r[2 * i + 1] - lat) * ky;
      const dx = bx - ax;
      const dy = by - ay;
      const len2 = dx * dx + dy * dy;
      let t = len2 === 0 ? 0 : -(ax * dx + ay * dy) / len2;
      if (t < 0) t = 0;
      else if (t > 1) t = 1;
      const d = Math.hypot(ax + t * dx, ay + t * dy);
      if (d < best) best = d;
    }
  }
  return best;
}

function nearBbox(lon, lat, bbox, marginM) {
  const dLat = marginM / M_PER_DEG;
  const cos = Math.max(Math.cos((lat * Math.PI) / 180), 1e-6);
  const dLon = marginM / (M_PER_DEG * cos);
  return (
    lon >= bbox[0] - dLon && lon <= bbox[2] + dLon && lat >= bbox[1] - dLat && lat <= bbox[3] + dLat
  );
}

// Every feature whose area may overlap the circle (centre, marginM).
function candidatesIn(layer, lon, lat, marginM) {
  const out = [];
  for (const f of layer.features) {
    if (!nearBbox(lon, lat, f.bbox, marginM)) continue;
    const inside = pointInRings(lon, lat, f.rings);
    if (inside || distanceToRingsM(lon, lat, f.rings) <= marginM) {
      out.push({ feature: f, centerInside: inside });
    }
  }
  return out;
}

// ------------------------------------------------------------ levels

function level(type, items, outsidePossible) {
  // items: [{ code, name, center_inside, ... }] already de-duplicated
  const determined = items.length === 1 && !outsidePossible;
  return {
    type,
    determined,
    area: determined ? { code: items[0].code, name: items[0].name } : null,
    candidates: items,
  };
}

function upperLevel(type, cityHits, groups, key, outsidePossible) {
  const map = new Map();
  for (const h of cityHits) {
    const a = groups[h.feature.group][key];
    const prev = map.get(a.code);
    if (prev) prev.center_inside = prev.center_inside || h.centerInside;
    else map.set(a.code, { code: a.code, name: a.name, center_inside: h.centerInside });
  }
  return level(type, [...map.values()], outsidePossible);
}

function featureLevel(type, hits, outsidePossible) {
  return level(
    type,
    hits.map((h) => ({
      code: h.feature.code,
      name: h.feature.name,
      region_name: h.feature.region_name,
      center_inside: h.centerInside,
    })),
    outsidePossible,
  );
}

function names(lv) {
  return lv.candidates.map((c) => c.name).join('、');
}

// ------------------------------------------------------------ main

/**
 * Look up the areas for a position.
 *
 * @param {object} data   result of prepareAreaData()
 * @param {object} input  { latitude, longitude, accuracy (metres, required), source? }
 *                        source "simulated" marks replayed/mock positions.
 * @param {object} [options] { now: Date } for tests
 * @returns {{kind, status, value, observed_at, source, detail}}
 */
export function locateArea(data, input, options = {}) {
  const now = options.now instanceof Date ? options.now : new Date();
  const source = input && input.source === 'simulated' ? 'simulated' : 'jma';

  if (!data || data.prepared !== true) {
    return result('error', null, '区域のデータが読み込まれていないため、判定できません。', source, now);
  }
  if (!input || typeof input !== 'object') {
    return result('error', null, '位置が渡されていないため、判定できません。', source, now);
  }
  const { latitude: lat, longitude: lon, accuracy } = input;
  if (!Number.isFinite(lat) || !Number.isFinite(lon) || lat < -90 || lat > 90 || lon < -180 || lon > 180) {
    return result('error', null, '緯度・経度が正しい数値ではないため、判定できません。', source, now);
  }
  if (!Number.isFinite(accuracy) || accuracy < 0) {
    return result(
      'error',
      null,
      '位置の誤差（メートル）が指定されていないか、正しくないため、判定できません。誤差が分からないまま区域を決めることはしません。',
      source,
      now,
    );
  }

  const prefName = data.prefecture?.name ?? '対象の県';
  const margin = accuracy + data.maxErrorM;
  const radiusText = `誤差の半径 ${Math.round(accuracy)}m に、データの簡略化による誤差 ${data.maxErrorM}m を足した範囲`;

  const pref = data.layers.prefecture.features[0];
  let prefInside = false;
  let prefDist = Infinity;
  if (nearBbox(lon, lat, pref.bbox, margin)) {
    prefInside = pointInRings(lon, lat, pref.rings);
    prefDist = distanceToRingsM(lon, lat, pref.rings);
  }
  if (!prefInside && prefDist > margin) {
    return result(
      'unknown',
      null,
      `${prefName}の区域の外（海上、または他の都道府県）と判定しました（${radiusText}）。` +
        `このモジュールは${prefName}だけを扱うため、市町村と区域は判定できません。` +
        '新しい警報・注意報がないことを意味しません。',
      source,
      now,
    );
  }
  const outsidePossible = !prefInside || prefDist <= margin;

  const cityHits = candidatesIn(data.layers.city, lon, lat, margin);
  const muniHits = candidatesIn(data.layers.municipality, lon, lat, margin);
  if (cityHits.length === 0 || muniHits.length === 0) {
    return result(
      'unknown',
      null,
      `${prefName}の区域の境界の近くですが、市町村と区域を判定できませんでした（${radiusText}）。` +
        '小さな島や岩礁は、データの簡略化で省いているため判定できないことがあります。',
      source,
      now,
    );
  }

  const value = {
    determined: false,
    outside_possible: outsidePossible,
    accuracy_m: accuracy,
    checked_radius_m: margin,
    municipality: featureLevel('市町村等（地震津波関係）', muniHits, outsidePossible),
    warning_areas: {
      prefecture: upperLevel('府県予報区等', cityHits, data.groups, 'prefecture', outsidePossible),
      primary: upperLevel('一次細分区域等', cityHits, data.groups, 'primary', outsidePossible),
      group: upperLevel('市町村等をまとめた地域等', cityHits, data.groups, 'group', outsidePossible),
      city: featureLevel('市町村等（気象警報等）', cityHits, outsidePossible),
    },
    attribution: data.attribution,
    processed: data.processed,
  };
  const all = [value.municipality, ...Object.values(value.warning_areas)];
  value.determined = all.every((lv) => lv.determined);

  let detail;
  if (value.determined) {
    detail =
      `${value.municipality.area.name}（市町村等）、` +
      `${value.warning_areas.city.area.name}（警報・注意報の市町村等）の区域内と判定しました。` +
      `${radiusText}が 1 つの区域に収まっています。`;
  } else {
    const parts = [];
    if (outsidePossible) {
      parts.push(`範囲の一部が${prefName}の区域の外（海上、または他の都道府県）にかかっています`);
    }
    for (const lv of all) {
      if (lv.candidates.length > 1) parts.push(`${lv.type}の候補が ${lv.candidates.length} 件あります（${names(lv)}）`);
    }
    detail = `${radiusText}で調べたところ、${parts.join('。')}。1 つに決めず、候補をすべて返します。`;
  }
  return result('ok', value, detail, source, now);
}
