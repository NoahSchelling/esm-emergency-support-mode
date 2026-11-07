// Pure view logic for the evacuee screen (loads in browsers and Node.js).
// Turns module results into the few strings and flags the screen shows.
// No DOM here; ./evac-main.js does the drawing.
//
// Wording rules: no "safe"/"normal" claims (BW-S3), no own warnings
// (BW-S1), no medical words for the shock slot (BW-S4), no "shindo".

// Simulated scenarios. Only the tsunami mock exists in this round.
// The instruction is the text of a SIMULATED public announcement; it is
// always shown with the 【模擬】 mark. ！！仮の値！！ wording.
export const SCENARIOS = Object.freeze({
  tsunami: Object.freeze({
    hazard: 'tsunami',
    label: '津波の模擬',
    // Quoted as the text of a simulated announcement, not as the app's own words.
    instruction: '【模擬】津波警報（模擬）の発表文：「沿岸部や川沿いにいる人は、ただちに高台や避難ビルへ避難してください。」',
    origin: '訓練用の模擬の発表です。気象庁・市町村の発表ではありません。実際の避難は、公的な発表と指示に従ってください。',
    lifted: '【模擬】津波警報（模擬）の解除を受けたため、方向の表示をやめました。市町村の発表を確かめてください。',
  }),
});

// Keys of the simulated public announcements in the supporter view
// (modules/mode categories) that start the tsunami scenario.
const SIM_KEY_TO_SCENARIO = Object.freeze({
  tsunami_warning: 'tsunami',
  major_tsunami_warning: 'tsunami',
});

export function scenarioFromSimKey(key) {
  return Object.hasOwn(SIM_KEY_TO_SCENARIO, key) ? SIM_KEY_TO_SCENARIO[key] : null;
}

// "?sim=tsunami" starts the tsunami mock (for demos and automated checks).
export function parseSimParam(search) {
  const v = new URLSearchParams(search ?? '').get('sim');
  return v && Object.hasOwn(SCENARIOS, v) ? v : null;
}

export function formatJstHm(ms) {
  const t = new Date(ms + 9 * 3600 * 1000);
  return `${String(t.getUTCHours()).padStart(2, '0')}:${String(t.getUTCMinutes()).padStart(2, '0')}`;
}

export function minutesAgoText(receivedMs, nowMs) {
  if (!Number.isFinite(receivedMs) || !Number.isFinite(nowMs)) return null;
  const min = Math.floor((nowMs - receivedMs) / 60000);
  if (min < 0) return null;
  if (min < 1) return '1 分以内';
  if (min < 120) return `${min} 分前`;
  return `${Math.floor(min / 60)} 時間前`;
}

// reception: { receivedMs, simulated } or null
export function receptionLine(reception, nowMs) {
  const ago = reception ? minutesAgoText(reception.receivedMs, nowMs) : null;
  if (!ago) return '公的情報：受信していません（受信していないことは、新しい発表がないという意味ではありません）';
  return `公的情報の受信：${ago}（${formatJstHm(reception.receivedMs)}）${reception.simulated ? (reception.label || '【模擬】') : ''}`;
}

export const STRAIGHT_LINE_NOTE = '直線の方向です。道順ではありません。';
export const SHOCK_TEXT = '端末が強い衝撃を検知しました';

// Text of the arrow for screen readers.
export function arrowLabel(deg) {
  const d = Math.round(deg) % 360;
  if (d === 0) return '画面の上の方向';
  if (d === 180) return '画面の下の方向';
  return d < 180 ? `画面の上から右へ約 ${d} 度` : `画面の上から左へ約 ${360 - d} 度`;
}

// Direction the device faces, in 8 directions and degrees: "北東 45°".
const DIRS8 = ['北', '北東', '東', '南東', '南', '南西', '西', '北西'];
export function facingText(deg) {
  if (!Number.isFinite(deg)) return '';
  const d = ((Math.round(deg) % 360) + 360) % 360;
  return `${DIRS8[Math.round(d / 45) % 8]} ${d}°`;
}

function courseRelText(rel) {
  if (rel === null || rel === undefined) return '';
  if (Math.abs(rel) <= 10) return '進んでいる方向とほぼ同じです。';
  return rel > 0 ? `進んでいる方向から右へ約 ${rel} 度です。` : `進んでいる方向から左へ約 ${-rel} 度です。`;
}

/**
 * Build what the evacuee screen shows.
 * state: { scenario, location (sensor result or null), dataError (string|null),
 *          result (computeEvacDirections result or null), nowMs }
 */
// `context` (from ../shell/shell-main.js) overrides the built-in scenario:
// { def: { hazard, instruction, origin } | null, message, hasEvacData }.
export function evacViewModel({ scenario = null, lifted = null, context = null, location = null, dataError = null, result = null, nowMs }) {
  const sc = context ? context.def : scenario ? SCENARIOS[scenario] : null;
  const base = {
    instruction: sc ? sc.instruction : '',
    instructionOrigin: sc ? sc.origin : '',
    straightLineNote: STRAIGHT_LINE_NOTE,
    mode: 'message', // 'arrow' | 'text' | 'message'
    message: '',
    primary: null,
    others: [],
    arrowDeg: null,
    arrowReason: '',
    northUpBearing: null,
    courseText: '',
    exclusions: [],
    canExclude: false,
    showFallback: false,
    notes: [],
    excludeTarget: null,
    positionAgeText: '',
  };
  if (!sc && lifted && SCENARIOS[lifted]) {
    return { ...base, instruction: SCENARIOS[lifted].lifted, instructionOrigin: SCENARIOS[lifted].origin, message: SCENARIOS[lifted].lifted, showFallback: true };
  }
  if (context && (context.message || !sc)) {
    return {
      ...base,
      message: context.message || '津波警報などを受けていないため、避難目標は出していません。',
      showFallback: true,
    };
  }
  if (!sc) {
    return {
      ...base,
      message: '災害の種別を示す発表を受けていないため、避難目標は出していません。',
      showFallback: true,
    };
  }
  if (dataError) {
    return { ...base, message: `避難場所のデータを読み込めませんでした（${dataError}）。`, showFallback: true };
  }
  if (!location || location.status !== 'ok') {
    const why = location?.detail || '「位置と方位を使う」を押すと、位置を問い合わせます。';
    return { ...base, message: `位置が分からないため、方向を示せません。${why}` };
  }
  if (!result) return { ...base, message: '避難場所のデータを読み込んでいます。' };
  if (result.status !== 'ok') {
    return { ...base, message: result.detail, showFallback: result.status === 'unknown' };
  }
  const v = result.value;
  const [first, ...rest] = v.candidates;
  const arrowOk = Number.isFinite(first.arrow_deg);
  const primary = {
    name: first.name,
    municipality: first.municipality ?? '',
    distance: `直線で${first.distance_text}`,
    direction: first.direction_text,
    hazards: `対応：${first.hazards.join('、')}`,
    remarks: first.remarks ? `備考：${first.remarks}` : '',
    courseRel: v.course.show ? courseRelText(first.course_relative_deg) : '',
  };
  return {
    ...base,
    mode: arrowOk ? 'arrow' : 'text',
    primary,
    others: rest.map((c) => `${c.name}（${c.municipality ?? ''}）：直線で${c.distance_text}、${c.direction_text}`),
    arrowDeg: arrowOk ? first.arrow_deg : null,
    arrowReason: arrowOk ? '' : `矢印を出していません：${first.arrow_reason}`,
    northUpBearing: first.bearing_deg,
    courseText: v.course.show ? v.course.text : '',
    exclusions: v.exclusions.map((x) => ({ text: `${x.text}（${formatJstHm(x.until_ms)} まで）`, until_ms: x.until_ms, center_deg: x.center_deg })),
    canExclude: first.bearing_deg !== null,
    excludeTarget: first.bearing_deg !== null ? { bearing_deg: first.bearing_deg, site_id: first.id } : null,
    positionAgeText: v.position_age_s !== null && v.position_age_s >= 15 ? `この位置は約 ${v.position_age_s} 秒前に取ったものです。` : '',
    notes: [v.coverage_note],
  };
}
