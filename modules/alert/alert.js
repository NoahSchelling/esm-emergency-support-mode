// Alert level for the page border, from public announcements (relay) and,
// for tsunami warnings only, the distance to the coast line.
//
// BW-S1: the level comes from the NAME of the official kind (注意報 /
// 警報 / 危険警報 / 特別警報 / 津波警報 ...) through a fixed table. Nothing
// here predicts or judges a hazard. The "imminent" state during an official
// tsunami warning first uses the national tsunami inundation estimate (is
// the point inside the estimated area?). Only when that is unknown (no data,
// no consent to look it up) the distance to the coast is used as the app's
// own rough guide; it is a ！！仮の値！！ and the screen says it is not an
// official criterion.
// BW-S3: "no announcement received" is never reported as level 0 / normal;
// it is "unknown".
//
// No I/O and no platform APIs (browsers and Node.js).

export const KIND = 'alert_level';
const EARTH_R = 6371008.8;
const RAD = Math.PI / 180;

// ！！仮の値！！ distance to the coast line (tsunami forecast region line)
// within which an official tsunami warning / major tsunami warning makes the
// state "imminent".
export const ALERT_DEFAULTS = Object.freeze({
  imminentCoastDistanceM: 1000,
});

// Shown whenever the distance guide decided the imminent state.
export const DISTANCE_GUIDE_NOTE = '海岸線からの距離は、このアプリの目安です。公的な基準ではありません。';

// Border colours. Yellow / red / purple follow the JMA warning level
// colours (level 2 / 3 / 4). JMA uses black for level 5; by the project's
// decision level 5 uses the purple of level 4 and blinks instead.
export const LEVEL_STYLE = Object.freeze({
  0: { color: null, blink: 'none', label: '発表なし（受け取っている範囲）' },
  2: { color: '#F2E700', blink: 'none', label: '注意報' },
  3: { color: '#FF2800', blink: 'none', label: '警報' },
  4: { color: '#AA00AA', blink: 'none', label: '危険警報' },
  5: { color: '#AA00AA', blink: 'fade3s', label: '特別警報・大津波警報' },
});

// ---------------------------------------------------------------- kinds

// Level of one official kind name. Returns null for names that do not set
// a border level (e.g. 緊急地震速報, 解除, なし, plain information).
// ！！仮の値！！ the table itself (docs/proto/alert.md).
export function levelOfKind(name, status = null) {
  if (typeof name !== 'string' || name === '') return null;
  if (status && /解除|発表警報・注意報はなし/.test(status)) return null;
  if (/解除|なし$/.test(name)) return null;
  if (/緊急地震速報/.test(name)) return null;
  const tsunami = /津波/.test(name);
  if (tsunami) {
    if (/大津波/.test(name)) return { level: 5, tsunami: true, warning: true };
    if (/津波警報/.test(name)) return { level: 3, tsunami: true, warning: true };
    if (/津波注意報/.test(name)) return { level: 2, tsunami: true, warning: false };
    return null; // 津波予報（若干の海面変動）など
  }
  if (/特別警報/.test(name)) return { level: 5, tsunami: false, warning: true };
  if (/危険警報|土砂災害警戒情報/.test(name)) return { level: 4, tsunami: false, warning: true };
  if (/警報/.test(name)) return { level: 3, tsunami: false, warning: true };
  if (/注意報/.test(name)) return { level: 2, tsunami: false, warning: false };
  return null;
}

// ---------------------------------------------------------------- coast

export function prepareCoastData(json) {
  if (!json || json.format !== 'coast-lines/1') throw new Error(`unsupported coast data: ${json?.format}`);
  const unit = json.unit;
  const regions = Object.entries(json.regions).map(([code, r]) => ({
    code,
    name: r.name,
    lines: r.lines.map((enc) => {
      const pts = [];
      let x = 0;
      let y = 0;
      for (let i = 0; i < enc.length; i += 2) {
        x = i === 0 ? enc[0] : x + enc[i];
        y = i === 0 ? enc[1] : y + enc[i + 1];
        pts.push([x * unit, y * unit]);
      }
      return pts;
    }),
  }));
  return Object.freeze({ regions, maxErrorM: json.simplification.max_error_m, attribution: json.attribution, processed: json.processed });
}

function segDistM(lat, lon, a, b) {
  // Local equirectangular projection around the point (fine for < ~50 km).
  const kx = Math.cos(lat * RAD) * RAD * EARTH_R;
  const ky = RAD * EARTH_R;
  const ax = (a[0] - lon) * kx;
  const ay = (a[1] - lat) * ky;
  const bx = (b[0] - lon) * kx;
  const by = (b[1] - lat) * ky;
  const dx = bx - ax;
  const dy = by - ay;
  const L = dx * dx + dy * dy;
  const t = L === 0 ? 0 : Math.max(0, Math.min(1, -(ax * dx + ay * dy) / L));
  return Math.hypot(ax + t * dx, ay + t * dy);
}

// Nearest tsunami forecast region line. Returns null when farther than
// maxSearchM from every kept region (the data covers only some regions).
export function nearestCoast(coast, lat, lon, maxSearchM = 30000) {
  const pad = maxSearchM / 111000 / Math.max(0.2, Math.cos(lat * RAD));
  let best = null;
  for (const r of coast.regions) {
    for (const line of r.lines) {
      for (let i = 0; i + 1 < line.length; i++) {
        const a = line[i];
        const b = line[i + 1];
        if ((a[0] < lon - pad && b[0] < lon - pad) || (a[0] > lon + pad && b[0] > lon + pad)
          || (a[1] < lat - pad && b[1] < lat - pad) || (a[1] > lat + pad && b[1] > lat + pad)) continue;
        const d = segDistM(lat, lon, a, b);
        if (!best || d < best.distance_m) best = { distance_m: d, region_code: r.code, region_name: r.name };
      }
    }
  }
  if (!best || best.distance_m > maxSearchM) return null;
  return best;
}

// ---------------------------------------------------------------- state

/**
 * items: [{ area_code, kinds: [{ name, status }] }] currently in effect
 *        (already narrowed to the latest telegram per type by the caller).
 * areaCodes: codes that describe the person's location (warning areas,
 *        prefecture, ...). Items for other areas are ignored.
 * coast: result of nearestCoast() (or null when unknown / far).
 * received: false when no announcement source is reachable -> unknown.
 * inundation: true (inside the national tsunami inundation estimate),
 *        false (outside it, where the data covers the place), or null
 *        (unknown: no data or no consent). It takes priority over the
 *        distance to the coast.
 * observed: the highest observed tsunami height published for the nearest
 *        coast region, with the level of its height class (decided by the
 *        caller), or null: { level, text, place }. Decided 2026-11-08 by the
 *        project owner: the border uses the HIGHER of the announcements and
 *        this observation. Once a tsunami has been observed there is still
 *        time before it arrives, and the screen must not make anyone give up
 *        evacuating. It only raises the level (never lowers it), and it
 *        counts as a tsunami warning for the imminent state.
 */
export function alertState({ items = [], areaCodes = [], coast = null, received = true, inundation = null, observed = null }, opts = {}) {
  const o = { ...ALERT_DEFAULTS, ...opts };
  if (!received) {
    return {
      status: 'unknown', level: null, imminent: false, color: null, blink: 'none',
      detail: '公的な発表を受け取れていません。警報が出ていないという意味ではありません。',
      sources: [],
    };
  }
  const codes = new Set(areaCodes.map(String));
  if (coast?.region_code) codes.add(String(coast.region_code));
  let level = 0;
  let tsunamiWarning = null;
  const sources = [];
  for (const it of items) {
    if (!codes.has(String(it.area_code))) continue;
    for (const k of it.kinds ?? []) {
      const lv = levelOfKind(k.name, k.status);
      if (!lv) continue;
      sources.push({ name: k.name, area_name: it.area_name ?? null, level: lv.level });
      if (lv.level > level) level = lv.level;
      if (lv.tsunami && lv.warning && coast && String(it.area_code) === String(coast.region_code)) {
        if (!tsunamiWarning || lv.level > tsunamiWarning.level) tsunamiWarning = { name: k.name, level: lv.level };
      }
    }
  }
  // A published tsunami observation for the nearest coast region raises the
  // level when its height class is higher than the announcements.
  let raisedBy = null;
  if (coast && observed && Number.isInteger(observed.level) && observed.level > level) {
    level = observed.level;
    raisedBy = observed;
    sources.push({ name: `津波の観測 ${observed.text}（${observed.place}）`, area_name: coast.region_name ?? null, level: observed.level, observed: true });
  }
  if (coast && observed && Number.isInteger(observed.level) && observed.level >= 3
    && (!tsunamiWarning || observed.level > tsunamiWarning.level)) {
    tsunamiWarning = { name: tsunamiWarning?.name ?? '津波の観測', level: Math.max(observed.level, tsunamiWarning?.level ?? 0) };
  }
  // Imminent state, only during an official tsunami warning for the nearest
  // coast region. The inundation estimate decides first; the distance to the
  // coast is used only when the estimate is unknown.
  let basis = null;
  let imminent = false;
  if (tsunamiWarning && coast) {
    if (inundation === true || inundation === false) {
      basis = 'inundation';
      imminent = inundation;
    } else {
      basis = 'distance';
      imminent = coast.distance_m <= o.imminentCoastDistanceM;
    }
  }
  const style = LEVEL_STYLE[level] ?? LEVEL_STYLE[0];
  const announced = `この地域への発表：${[...new Set(sources.filter((s) => !s.observed).map((s) => s.name))].join('、') || 'なし'}。`
    + (raisedBy ? `観測された津波の高さ（${raisedBy.text}、${raisedBy.place}）が発表より高い区分のため、外枠はその色です。` : '');
  let detail;
  if (imminent && basis === 'inundation') {
    detail = `${tsunamiWarning.name}が出ています。この位置は、国の津波浸水想定の区域の中です。${raisedBy ? `観測された津波の高さ（${raisedBy.text}、${raisedBy.place}）で外枠を上げています。` : ''}公的な発表と指示を優先してください。`;
  } else if (imminent) {
    detail = `${tsunamiWarning.name}が出ている海岸線から約 ${Math.round(coast.distance_m / 10) * 10} m の位置です。${DISTANCE_GUIDE_NOTE}公的な発表と指示を優先してください。`;
  } else if (level === 0) {
    detail = '受け取っている範囲では、この地域への注意報・警報はありません。発表がないことは、安全という意味ではありません。';
  } else if (basis === 'distance') {
    // No reassuring words when the border does not blink fast.
    detail = `${announced}浸水想定の区域かどうかが分からないため、海岸線からの距離を使っています。${DISTANCE_GUIDE_NOTE}`;
  } else {
    detail = announced;
  }
  return {
    status: 'ok',
    level,
    imminent,
    basis,
    color: imminent ? (style.color ?? LEVEL_STYLE[3].color) : style.color,
    blink: imminent ? 'hard1s' : style.blink,
    detail,
    sources,
  };
}
