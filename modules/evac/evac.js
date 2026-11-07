// Straight-line direction to publicly designated emergency evacuation sites
// (GSI "指定緊急避難場所データ"), computed entirely on the device.
//
// What this does: for a position and a hazard type, list the nearest sites
// designated for that hazard, with straight-line distance and the bearing
// from true north. When a usable device heading is given, it also returns
// how far to turn the on-screen arrow.
//
// What this does NOT do (BW-S1/BW-S3): it does not judge danger, does not
// estimate road conditions, does not pick a hazard by itself, and never
// says a place or a direction is safe. "No candidate" means "not found in
// the data", not "nothing nearby".
//
// Privacy: the position is used only inside this function and is not put
// into the result. Note that a distance and bearing to a known public site
// still reveal the approximate position, so treat results as private too.
//
// No I/O and no platform APIs (loads in browsers and Node.js).

import { distanceM, bearingDeg, angleDiff, norm360, compassName, declinationWestDeg } from './geo.js';
import { courseFrom, COURSE_DEFAULTS, CONFIRM_DEFAULTS, HEADING_DEFAULTS, screenArrowDeg, tiltDeg } from './heading.js';

export const KIND = 'evac_direction';
const SUPPORTED_FORMAT = 'evac-sites/1';

export const STRAIGHT_LINE_NOTE = '直線の方向です。道順ではありません。';

export const EVAC_DEFAULTS = Object.freeze({
  maxCandidates: 3, // ！！仮の値！！
  maxDistanceM: 5000, // ！！仮の値！！ sites farther than this are not offered
  maxAccuracyM: 1000, // ！！仮の値！！ position error above this -> unknown
  maxBearingUncertaintyDeg: 30, // ！！仮の値！！ arrow hidden above this
  maxPositionAgeMs: 15000, // ！！仮の値！！ arrow hidden when the fix is older
  maxHeadingAgeMs: HEADING_DEFAULTS.maxAgeMs,
  maxTiltDeg: HEADING_DEFAULTS.maxTiltDeg,
  allowLandscape: HEADING_DEFAULTS.allowLandscape,
  // ！！仮の値！！ A heading without an accuracy value (Android) is used for
  // the arrow only within confirmValidMs of a match with the GPS course.
  requireConfirmationWhenAccuracyUnknown: true,
  ...COURSE_DEFAULTS,
  ...CONFIRM_DEFAULTS,
});

export const EXCLUSION_DEFAULTS = Object.freeze({
  halfWidthDeg: 30, // ！！仮の値！！ excluded range is center +/- this
  durationMin: 10, // ！！仮の値！！ how long an exclusion lasts
});

// ------------------------------------------------------------ result helpers

function pad(n, w = 2) {
  return String(n).padStart(w, '0');
}

// ISO 8601 in Japan Standard Time with an explicit offset.
export function toIsoJst(ms) {
  const t = new Date(ms + 9 * 3600 * 1000);
  return (
    `${t.getUTCFullYear()}-${pad(t.getUTCMonth() + 1)}-${pad(t.getUTCDate())}` +
    `T${pad(t.getUTCHours())}:${pad(t.getUTCMinutes())}:${pad(t.getUTCSeconds())}` +
    `.${pad(t.getUTCMilliseconds(), 3)}+09:00`
  );
}

function deepFreeze(o) {
  if (o && typeof o === 'object' && !Object.isFrozen(o)) {
    Object.freeze(o);
    for (const v of Object.values(o)) deepFreeze(v);
  }
  return o;
}

function result(status, value, detail, source, nowMs) {
  return deepFreeze({
    kind: KIND,
    status,
    value: status === 'ok' ? value : null,
    observed_at: toIsoJst(nowMs),
    source,
    detail,
  });
}

// Re-check a heading value from the caller (do not trust its shape).
function headingShapeOk(hv, o) {
  const n = (v) => typeof v === 'number' && Number.isFinite(v);
  if (!n(hv.top_true_heading_deg) || !n(hv.true_heading_deg) || !n(hv.beta) || !n(hv.gamma)) return false;
  if (![0, 90, 180, 270].includes(hv.screen_angle_deg)) return false;
  if (hv.screen_angle_deg !== 0 && !o.allowLandscape) return false;
  if (tiltDeg(hv.beta, hv.gamma) > o.maxTiltDeg) return false;
  if (hv.accuracy_deg !== null && !n(hv.accuracy_deg)) return false;
  return true;
}

// Round an angle to 0.1 degree and keep it in [0, 360) (359.96 -> 0, not 360).
function round1(deg) {
  return norm360(Math.round(norm360(deg) * 10) / 10);
}

function toMs(now) {
  if (now === undefined) return Date.now();
  if (now instanceof Date) return now.getTime();
  return now;
}

// ------------------------------------------------------------ data

export function prepareEvacData(json) {
  if (!json || json.format !== SUPPORTED_FORMAT) {
    throw new Error(`unsupported evacuation data format: ${json?.format}`);
  }
  const hazards = json.hazards;
  if (!Array.isArray(hazards) || hazards.length === 0) throw new Error('hazards missing');
  const fields = json.fields;
  const idx = Object.fromEntries(['id', 'name', 'municipality', 'lat', 'lon', 'hazards', 'remarks'].map((f) => {
    const i = fields.indexOf(f);
    if (i < 0) throw new Error(`field missing: ${f}`);
    return [f, i];
  }));
  const n = json.sites.length;
  const lat = new Float64Array(n);
  const lon = new Float64Array(n);
  const sites = json.sites.map((row, i) => {
    const flags = row[idx.hazards];
    if (typeof flags !== 'string' || flags.length !== hazards.length || /[^01]/.test(flags)) {
      throw new Error(`bad hazard flags at row ${i}`);
    }
    const la = row[idx.lat];
    const lo = row[idx.lon];
    if (!Number.isFinite(la) || !Number.isFinite(lo)) throw new Error(`bad coordinates at row ${i}`);
    lat[i] = la;
    lon[i] = lo;
    return {
      id: row[idx.id],
      name: row[idx.name],
      municipality_code: row[idx.municipality],
      flags,
      remarks: row[idx.remarks] || '',
    };
  });
  return Object.freeze({
    format: json.format,
    prefecture: json.prefecture,
    source: json.source,
    attribution: json.attribution,
    processed: json.processed,
    notices: json.notices,
    coverage_note: json.coverage_note,
    hazards,
    hazardIndex: Object.fromEntries(hazards.map((h, i) => [h.key, i])),
    municipalities: json.municipalities,
    sites,
    lat,
    lon,
  });
}

export function hazardLabel(data, key) {
  const i = data?.hazardIndex?.[key];
  return i === undefined ? null : data.hazards[i].label;
}

// ------------------------------------------------------------ exclusions

// Create an exclusion around `centerDeg` (true bearing) starting now.
// `siteId` (optional) also excludes that site itself, so it does not come
// back when the person moves and its bearing changes.
export function createExclusion(centerDeg, nowMs, opts = {}) {
  const o = { ...EXCLUSION_DEFAULTS, ...opts };
  if (!Number.isFinite(centerDeg)) throw new RangeError('centerDeg must be a number');
  return Object.freeze({
    center_deg: norm360(centerDeg),
    half_width_deg: o.halfWidthDeg,
    site_id: typeof o.siteId === 'string' ? o.siteId : null,
    created_ms: nowMs,
    until_ms: nowMs + o.durationMin * 60000,
  });
}

export function activeExclusions(list, nowMs) {
  return (list ?? []).filter((x) => x && Number.isFinite(x.until_ms) && x.until_ms > nowMs
    && Number.isFinite(x.center_deg) && Number.isFinite(x.half_width_deg));
}

export function isExcluded(bearing, exclusions) {
  return exclusions.some((x) => Math.abs(angleDiff(bearing, x.center_deg)) <= x.half_width_deg);
}

function isExcludedSite(id, exclusions) {
  return exclusions.some((x) => x.site_id === id);
}

// ------------------------------------------------------------ text

export function distanceText(m) {
  if (m < 1000) return `約 ${Math.max(10, Math.round(m / 10) * 10)} m`;
  return `約 ${(Math.round(m / 100) / 10).toFixed(1)} km`;
}

export function directionText(bearing, uncertainty = null) {
  const deg = Math.round(norm360(bearing)) % 360;
  const unc = uncertainty !== null && uncertainty >= 10 ? `、誤差 ±${Math.round(uncertainty)}度` : '';
  return `北から約 ${deg} 度（${compassName(bearing)}${unc}）の方向`;
}

// ------------------------------------------------------------ main

function err(detail, source, nowMs) {
  return result('error', null, detail, source, nowMs);
}

/**
 * input: {
 *   latitude, longitude, accuracy   // degrees, degrees, metres (required)
 *   hazard                          // key such as 'tsunami' (required)
 *   exclusions                      // from createExclusion() (optional)
 *   heading                         // result of createHeadingTracker().read() (optional)
 *   course                          // { heading_deg, speed_mps, at_ms } from GPS (optional)
 *   position_at_ms                  // time the position was obtained (needed for an arrow)
 *   compass_confirmed_at_ms         // from createCompassCheck() (needed for an arrow when
 *                                   //   the heading has no accuracy value, i.e. Android)
 *   source                          // 'simulated' for mock / replay input
 * }
 * options: { now, ...EVAC_DEFAULTS overrides }
 */
export function computeEvacDirections(data, input, options = {}) {
  const o = { ...EVAC_DEFAULTS, ...options };
  const nowMs = toMs(o.now);
  const source = input?.source === 'simulated' ? 'simulated' : 'gsi';
  if (!data || !data.sites) return err('避難場所のデータがありません。', source, nowMs);
  const { latitude: la, longitude: lo, accuracy: acc, hazard } = input ?? {};
  if (!Number.isFinite(la) || !Number.isFinite(lo) || la < -90 || la > 90 || lo < -180 || lo > 180) {
    return err('位置の値が不正です。', source, nowMs);
  }
  if (!Number.isFinite(acc) || acc < 0) {
    return err('位置の誤差が分かりません。誤差が分からないまま方向は示しません。', source, nowMs);
  }
  const hIdx = data.hazardIndex[hazard];
  if (hIdx === undefined) {
    return err('災害の種別が指定されていない、または分からない種別です。種別が分からないまま避難場所は選びません。', source, nowMs);
  }
  const hLabel = data.hazards[hIdx].label;
  if (acc > o.maxAccuracyM) {
    return result('unknown', null,
      `位置の誤差が大きすぎるため（約 ${Math.round(acc)} m）、方向を示せません。位置を取り直してください。`, source, nowMs);
  }

  const excl = activeExclusions(input.exclusions, nowMs);
  const found = [];
  let excludedCount = 0;
  for (let i = 0; i < data.sites.length; i++) {
    const s = data.sites[i];
    if (s.flags[hIdx] !== '1') continue;
    const d = distanceM(la, lo, data.lat[i], data.lon[i]);
    if (d > o.maxDistanceM) continue;
    const bearingKnown = d > acc;
    const b = bearingDeg(la, lo, data.lat[i], data.lon[i]);
    if (excl.length && (isExcludedSite(s.id, excl) || (bearingKnown && isExcluded(b, excl)))) {
      excludedCount++;
      continue;
    }
    found.push({ i, d, b: bearingKnown ? b : null });
  }
  found.sort((a, b) => a.d - b.d || (data.sites[a.i].id < data.sites[b.i].id ? -1 : 1));
  const top = found.slice(0, o.maxCandidates);

  const exclusionsOut = excl.map((x) => ({
    center_deg: round1(x.center_deg),
    half_width_deg: x.half_width_deg,
    until: toIsoJst(x.until_ms),
    until_ms: x.until_ms,
    site_id: x.site_id,
    text: `${directionText(x.center_deg)}の前後 ${x.half_width_deg} 度`,
  }));

  if (top.length === 0) {
    const why = [
      `${hLabel}に対応した指定緊急避難場所は、データの中に見つかりません（直線で約 ${o.maxDistanceM / 1000} km 以内）。`,
      '近くに避難場所がないという意味ではありません。',
      excludedCount ? `「通れない」として除外した ${excludedCount} か所は数えていません。` : '',
      data.coverage_note,
      '市町村の発表とハザードマップを確かめてください。',
    ].filter(Boolean).join('');
    return result('unknown', null, why, source, nowMs);
  }

  // ---- heading / arrow decision (a wrong arrow is worse than none)
  const decl = declinationWestDeg(la, lo);
  const heading = input.heading ?? null;
  const hv = heading?.status === 'ok' ? heading.value : null;
  const course = courseFrom(input.course, nowMs, o);
  const posAt = input.position_at_ms;
  const posAgeMs = Number.isFinite(posAt) ? nowMs - posAt : null;
  const confirmedAt = input.compass_confirmed_at_ms;
  let arrow = { show: false, reason: '' };
  if (!hv) {
    arrow.reason = heading?.detail || '端末の向きが分かりません。';
  } else if (!headingShapeOk(hv, o)) {
    arrow.reason = '端末の向きの値の形が想定と違うため、矢印を出しません。';
  } else if (!Number.isFinite(hv.at_ms) || nowMs - hv.at_ms > o.maxHeadingAgeMs || hv.at_ms - nowMs > 1000) {
    arrow.reason = '端末の向きの値が古い、または時刻が分からないため、矢印を出しません。';
  } else if (decl === null) {
    arrow.reason = '磁北と真北のずれ（偏角）が分からないため、矢印を出しません。';
  } else if (posAgeMs === null || posAgeMs < -1000) {
    arrow.reason = '位置を取った時刻が分からないため、矢印を出しません。';
  } else if (posAgeMs > o.maxPositionAgeMs) {
    arrow.reason = `位置が ${Math.round(posAgeMs / 1000)} 秒前のもので、そのあと動いているかもしれないため、矢印を出しません。`;
  } else if (course.usable && Math.abs(angleDiff(hv.top_true_heading_deg, course.heading_deg)) > o.maxMismatchDeg) {
    arrow.reason = '端末の向きと GPS の進行方向が大きく食い違っているため、矢印を出しません。';
  } else if (o.requireConfirmationWhenAccuracyUnknown && hv.accuracy_deg === null && course.usable
    && Math.abs(angleDiff(hv.top_true_heading_deg, course.heading_deg)) > o.matchDeg) {
    // While walking, a heading without accuracy must keep agreeing with the course.
    arrow.reason = 'この端末からは方位の精度が分からず、いまは GPS の進行方向と一致していないため、矢印を出していません。';
  } else if (o.requireConfirmationWhenAccuracyUnknown && hv.accuracy_deg === null
    && !(Number.isFinite(confirmedAt) && nowMs - confirmedAt <= o.validMs && confirmedAt - nowMs <= 1000)) {
    arrow.reason = 'この端末からは方位の精度が分からないため、矢印を出していません。端末の上を進む方向に向けて歩くと、GPS の進行方向と照らし合わせて確かめます。';
  } else {
    arrow = { show: true, reason: '' };
  }

  const candidates = top.map(({ i, d, b }) => {
    const s = data.sites[i];
    const unc = b === null ? null : Math.asin(Math.min(1, acc / d)) * 180 / Math.PI;
    const raw = arrow.show && b !== null && unc <= o.maxBearingUncertaintyDeg ? screenArrowDeg(b, hv) : null;
    // Never fall back to "straight up" when the geometry cannot be solved.
    const arrowOk = Number.isFinite(raw);
    return {
      id: s.id,
      name: s.name,
      municipality: data.municipalities[s.municipality_code]?.name ?? null,
      distance_m: Math.round(d),
      distance_text: distanceText(d),
      bearing_deg: b === null ? null : round1(b),
      bearing_uncertainty_deg: unc === null ? null : Math.round(unc),
      direction_text: b === null
        ? `位置の誤差（約 ${Math.round(acc)} m）より近いため、方向を示せません。`
        : directionText(b, unc),
      arrow_deg: arrowOk ? round1(raw) : null,
      arrow_reason: arrowOk ? ''
        : !arrow.show ? arrow.reason
          : b === null ? '位置の誤差より近いため、矢印を出しません。'
            : unc > o.maxBearingUncertaintyDeg ? `位置の誤差のため方向の幅が大きく（±${Math.round(unc)}度）、矢印を出しません。`
              : '矢印の向きを計算できないため、矢印を出しません。',
      course_relative_deg: course.usable && b !== null ? Math.round(angleDiff(b, course.heading_deg)) : null,
      hazards: data.hazards.filter((_, k) => s.flags[k] === '1').map((h) => h.label),
      remarks: s.remarks,
    };
  });

  const value = {
    hazard: { key: hazard, label: hLabel },
    candidates,
    arrow,
    heading: hv
      ? { status: 'ok', true_heading_deg: round1(hv.true_heading_deg), basis: hv.basis, accuracy_known: hv.accuracy_deg !== null, detail: heading.detail }
      : { status: heading?.status ?? 'unknown', true_heading_deg: null, basis: null, accuracy_known: false, detail: heading?.detail ?? '端末の向きが分かりません。' },
    position_age_s: posAgeMs === null ? null : Math.max(0, Math.round(posAgeMs / 1000)),
    course: course.usable
      ? { show: true, heading_deg: Math.round(course.heading_deg), speed_mps: course.speed_mps, text: `いま進んでいる方向（GPS）：${directionText(course.heading_deg)}` }
      : { show: false, heading_deg: null, speed_mps: null, text: course.reason },
    exclusions: exclusionsOut,
    excluded_count: excludedCount,
    straight_line_note: STRAIGHT_LINE_NOTE,
    coverage_note: data.coverage_note,
    notices: data.notices,
    data_updated: data.source?.gsi_updated ?? null,
    data_retrieved: data.source?.retrieved ?? null,
    attribution: data.attribution,
    processed: data.processed,
  };
  const detail = [
    `${hLabel}に対応した、公的に指定された避難場所（指定緊急避難場所）への${STRAIGHT_LINE_NOTE}`,
    '近い順に示します。安全かどうか、通れるかどうかは判断していません。',
    excludedCount ? `「通れない」として除外した ${excludedCount} か所は外しています。` : '',
    data.coverage_note,
  ].filter(Boolean).join('');
  return result('ok', value, detail, source, nowMs);
}

// Public coordinates of one designated site (GSI data), looked up by id.
// Kept out of computeEvacDirections() results on purpose: together with the
// distance and bearing they would let anyone rebuild the position. The
// screen asks for them only to build a map link and to look up the site's
// elevation. Returns null for an unknown id.
export function siteCoordinates(data, id) {
  const i = data?.sites?.findIndex((s) => s.id === id) ?? -1;
  if (i < 0) return null;
  return { latitude: data.lat[i], longitude: data.lon[i] };
}
