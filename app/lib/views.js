// Turns module results into lines of text for the screen. Every function
// returns [] when the result has no value, so the caller shows the status
// and detail instead. Nothing here judges danger or safety (BW-S1, BW-S3).
// Works in browsers and Node.js.

const isOk = (r) => r && r.status === 'ok' && r.value;

// ---------------------------------------------------------------- area

function candidateNames(lv) {
  return (lv?.candidates ?? []).map((c) => c.name).join('、');
}

/** Lines for a modules/area locateArea() result. Coordinates are never shown. */
export function areaLines(r) {
  if (!isOk(r)) return [];
  const v = r.value;
  const wa = v.warning_areas ?? {};
  const levels = [v.municipality, wa.prefecture, wa.primary, wa.group, wa.city].filter(Boolean);
  if (v.determined) {
    return [
      `市町村等：${v.municipality.area.name}`,
      `警報・注意報の区域：${[wa.prefecture, wa.primary, wa.group, wa.city].map((lv) => lv.area.name).join(' / ')}`,
      `調べた範囲：半径 約 ${Math.round(v.checked_radius_m)} m`,
    ];
  }
  const lines = ['位置の誤差の範囲に複数の区域がかかるため、1 つに決めていません。候補をすべて出します。'];
  if (v.outside_possible) lines.push('範囲の一部が、対象の県の区域の外（海上、または他の都道府県）にかかっています。');
  for (const lv of levels) {
    const names = candidateNames(lv);
    if (names) lines.push(`${lv.type}の候補：${names}`);
  }
  lines.push(`調べた範囲：半径 約 ${Math.round(v.checked_radius_m)} m`);
  return lines;
}

// ---------------------------------------------------------------- fragment

const DATE_BASIS_NOTES = Object.freeze({
  'input-year-assumed': '年は今年と推定',
  'assumed-today': '日付がないため今日と推定',
  'relative-word': '「今日」「昨日」の語から',
  unresolved: '日付は決めていません',
});

function readingText(rd) {
  const parts = [];
  if (rd.time) {
    const basis = DATE_BASIS_NOTES[rd.time.dateBasis];
    parts.push(`時刻 ${rd.time.date ? `${rd.time.date} ` : ''}${rd.time.text}${basis ? `（${basis}）` : ''}`);
  }
  if (rd.epicenter) parts.push(`震源 ${rd.epicenter}`);
  if (rd.magnitude) parts.push(`規模 M${rd.magnitude.value}${rd.magnitude.qualifier ? `（「${rd.magnitude.qualifier}」付き）` : ''}`);
  if (rd.depth) parts.push(`深さ ${rd.depth.km} km${rd.depth.unitAssumed ? '（単位は km と推定）' : ''}`);
  if (rd.intensity) parts.push(`震度 ${rd.intensity.scale}${rd.intensity.max ? '（最大）' : ''}`);
  if (rd.area) parts.push(`地域 ${rd.area}`);
  return parts.join('、');
}

/** Lines for a modules/fragment parseFragment() result. Every reading is listed. */
export function fragmentLines(r) {
  if (!isOk(r)) return [];
  const v = r.value;
  const lines = [];
  const readings = (v.readings ?? []).map(readingText).filter(Boolean);
  if (readings.length > 1) {
    lines.push(`読み方が ${readings.length} 通りあります。どれか 1 つに決めていません。`);
  }
  readings.forEach((t, i) => lines.push(`読み方 ${i + 1}：${t}`));
  if (v.question) {
    const q = v.question.texts?.length ? `「${v.question.texts.join('、')}」` : '';
    lines.push(`問い${q}がありました。この画面は問いに答えません。公的な発表を確かめてください。`);
  }
  const unrec = Array.isArray(v.unrecognized) ? v.unrecognized : [v.unrecognized].filter(Boolean);
  if (unrec.length) lines.push(`読み取れなかった部分：${unrec.join('、')}`);
  for (const n of v.notes ?? []) lines.push(n);
  return lines;
}

// ---------------------------------------------------------------- motion

function num(v) {
  return Number.isFinite(v) ? v.toFixed(2) : '—';
}

function vecText(v) {
  if (!v) return 'この端末では値がありません';
  return `x ${num(v.x)} / y ${num(v.y)} / z ${num(v.z)} m/s²`;
}

/**
 * Lines for the motion sensor: the current raw values and the recent peak.
 * Raw device values only; never a seismic intensity.
 */
export function motionLines(cur, peak) {
  const lines = [];
  if (isOk(cur)) {
    lines.push(`加速度（重力を除く）：${vecText(cur.value.acceleration)}`);
    lines.push(`加速度（重力を含む）：${vecText(cur.value.acceleration_including_gravity)}`);
  }
  if (isOk(peak)) {
    const p = peak.value;
    const mag = (m) => (m && Number.isFinite(m.magnitude) ? `${num(m.magnitude)} m/s²` : 'この端末では値がありません');
    lines.push(`直近の最大値（重力を除く、大きさ）：${mag(p.acceleration_max)}`);
    lines.push(`直近の最大値（重力を含む、大きさ）：${mag(p.acceleration_including_gravity_max)}`);
    if (Number.isFinite(p.sample_count)) lines.push(`記録した回数：${p.sample_count}`);
  }
  return lines;
}

// ---------------------------------------------------------------- mode

/** Lines for a modules/mode result (current() or step().result). */
export function modeLines(r) {
  if (!isOk(r)) return [];
  const v = r.value;
  const lines = [];
  if (v.mode === 'normal') {
    lines.push('平常は「新しい公的発表を受けていない」状態で、安全という意味ではありません。');
  }
  if (v.stage != null) {
    lines.push(`段階 ${v.stage}/${v.stage_count}「${v.stage_label}」`);
    if (String(v.stage_label).includes('安全')) {
      lines.push(`段階の名前の「${v.stage_label}」は、安全になったという意味ではありません。`);
    }
  }
  if (v.emergency_by === 'public') lines.push('公的発表（模擬を含む）を受けて緊急になりました。');
  if (v.emergency_by === 'user') lines.push('あなたの申告で緊急になりました。');
  for (const a of v.active_announcements ?? []) lines.push(`受けている発表：${a.label}`);
  if (v.floor_active) {
    const why = (v.floor_reasons ?? []).map((f) => f.label).join('、');
    lines.push(`下限：${why || '公的発表'}を受けているため、平常には戻せません。`);
  }
  return lines;
}
