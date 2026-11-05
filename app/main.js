// Browser-only wiring of the screen. The logic lives in ./lib/ (pure, also
// loadable in Node.js) and in ../modules/. Every external or user text is
// inserted with textContent, never as HTML.
//
// Privacy: the position, the typed fragment and sensor values stay in this
// page. The only requests are for the page's own files, the area data file
// and (when served by serve.js with --ca) a fixed GET of the C-A status.

import { loadModules, parseWithout } from './lib/loader.js';
import { resultLabel, resultClass, statusLabel, statusClass, missingResult, NO_VALUE_NOTE } from './lib/labels.js';
import { makeMockStatus, summarize } from './lib/announcements.js';
import { createModeController, SIMULATED_EVENTS, USER_REQUESTS } from './lib/mode-controller.js';
import { areaLines, fragmentLines, motionLines, modeLines } from './lib/views.js';
import { formatJst, toJstIso } from './lib/time.js';

const $ = (id) => document.getElementById(id);
const CA_STATUS_URL = '/api/ca/status';
const ANN_POLL_MS = 15000; // ！！仮の値！！
const MODE_TICK_MS = 30000; // ！！仮の値！！
const UI_REFRESH_MS = 500;
const MOTION_PEAK_SEC = 10; // ！！仮の値！！

function setBadge(id, r, okLabel = null) {
  const e = $(id);
  e.textContent = resultLabel(r, okLabel);
  e.className = `badge ${resultClass(r)}`;
}

function setLines(id, lines) {
  const ul = $(id);
  ul.replaceChildren(...lines.map((t) => {
    const li = document.createElement('li');
    li.textContent = t;
    return li;
  }));
}

function noValueDetail(r) {
  if (!r) return '';
  if (r.status === 'ok') return r.detail ?? '';
  return `${r.detail ?? ''} ${NO_VALUE_NOTE}`.trim();
}

let simulatedShown = false;
function markSimulated() {
  simulatedShown = true;
  $('sim-banner').hidden = false;
}

const without = parseWithout(location.search);
const mods = await loadModules({ importer: (p) => import(new URL(p, import.meta.url)), without });

setLines('module-list', Object.entries(mods).map(([name, m]) => (
  m.loaded ? `${name}：読み込み済み` : `${name}：未実装（${m.reason === 'skipped' ? '読み込みを止めています' : '読み込めませんでした'}）`
)));

// ---------------------------------------------------------------- advice (BW-S4)

if (mods.advice.loaded) {
  $('policy-text').textContent = mods.advice.module.POLICY_TEXT;
} else {
  $('policy-text').textContent = 'このアプリは、メンタルヘルスの助言も医療の助言も行いません。助言の入口のモジュールは未実装です。';
}

// ---------------------------------------------------------------- sensors

const S = mods.sensors.loaded ? mods.sensors.module : null;
const sensors = {};
if (S) {
  const env = S.createDeviceEnv();
  sensors.location = S.createLocationSensor({ env });
  sensors.motion = S.createMotionSensor({ env });
  sensors.orientation = S.createOrientationSensor({ env });
  sensors.online = S.createOnlineSensor({ env });
  sensors.network = S.createNetworkSensor({ env });
  sensors.battery = S.createBatterySensor({ env });
  // These add listeners only; no permission prompt is shown here.
  sensors.motion.start();
  sensors.orientation.start();
  sensors.online.start();
  sensors.network.start();
  sensors.battery.start();
}
const MOTION_TITLE = S ? S.MOTION_LABEL : 'この端末が記録した揺れ（震度ではありません）';
$('h-motion').textContent = MOTION_TITLE;

const SENSOR_ROWS = [
  ['location', '位置'],
  ['motion', '揺れ'],
  ['orientation', '向き'],
  ['online', '通信の有無'],
  ['network', '通信の種類'],
  ['battery', '電池'],
];

function sensorValueText(key, r) {
  if (r.status !== 'ok' || !r.value) return '';
  const v = r.value;
  switch (key) {
    case 'location': return `誤差 約 ${Math.round(v.accuracy_m)} m（緯度・経度は表示しません）`;
    case 'online': return v.online ? 'オンライン（公的な情報源に届くとは限りません）' : 'オフライン';
    case 'network': return [v.type && `種類 ${v.type}`, v.effective_type && `実効 ${v.effective_type}`].filter(Boolean).join('、') || '値の一部のみ';
    case 'battery': return v.level_percent == null ? '残量は分かりません' : `残量 ${v.level_percent}%${v.charging ? '（充電中）' : ''}`;
    case 'orientation': return ['alpha_deg', 'beta_deg', 'gamma_deg'].map((k, i) => `${'αβγ'[i]} ${v[k] == null ? '—' : Math.round(v[k])}°`).join(' / ');
    case 'motion': return '下の「この端末が記録した揺れ」を見てください';
    default: return '';
  }
}

function renderSensors() {
  const rows = SENSOR_ROWS.map(([key, name]) => {
    const r = S ? sensors[key].read() : missingResult(key, Date.now(), toJstIso);
    const tr = document.createElement('tr');
    tr.dataset.sensor = key;
    tr.dataset.status = r.missing ? 'missing' : r.status;
    const th = document.createElement('td');
    th.textContent = name;
    const td = document.createElement('td');
    const badge = document.createElement('span');
    badge.className = `badge ${resultClass(r)}`;
    badge.textContent = resultLabel(r);
    td.append(badge);
    const val = sensorValueText(key, r);
    if (val) td.append(' ', val);
    const d = document.createElement('span');
    d.className = 'detail';
    d.textContent = noValueDetail(r);
    td.append(d);
    tr.append(th, td);
    return tr;
  });
  $('sensor-rows').replaceChildren(...rows);
}

function renderMotion() {
  if (!S) {
    const r = missingResult('motion', Date.now(), toJstIso);
    setBadge('motion-badge', r);
    $('motion-status').textContent = 'センサーのモジュールが未実装です。';
    setLines('motion-lines', []);
    $('motion-detail').textContent = noValueDetail(r);
    return;
  }
  const cur = sensors.motion.read();
  const peak = sensors.motion.peak(MOTION_PEAK_SEC);
  setBadge('motion-badge', cur);
  $('motion-status').textContent = cur.status === 'ok' ? `${formatJst(cur.observed_at)} の値` : '';
  $('sec-motion').dataset.status = cur.status;
  setLines('motion-lines', motionLines(cur, peak));
  $('motion-detail').textContent = cur.status === 'ok'
    ? (peak.status === 'ok' ? `最大値は直近 ${MOTION_PEAK_SEC} 秒の値です。` : noValueDetail(peak))
    : noValueDetail(cur);
}

// iOS Safari: the permission request must be made directly in the click
// handler, with no await before it.
$('btn-perm').addEventListener('click', () => {
  if (!S) return;
  S.requestMotionAndOrientationPermission(sensors.motion, sensors.orientation).then(() => {
    sensors.motion.start();
    sensors.orientation.start();
    renderSensors();
  });
});
if (!S) $('btn-perm').disabled = true;

// ---------------------------------------------------------------- area

const A = mods.area.loaded ? mods.area.module : null;
let areaData = null;
let areaDataError = null;
let lastArea = null;
let lastAreaAt = null;

async function ensureAreaData() {
  if (areaData || !A) return areaData;
  try {
    areaData = await A.loadAreaData();
  } catch (e) {
    areaDataError = String(e.message || e);
  }
  return areaData;
}

function renderArea() {
  let r = lastArea;
  if (!A) r = missingResult('area', Date.now(), toJstIso);
  $('sec-area').dataset.status = r ? (r.missing ? 'missing' : r.status) : 'none';
  if (!r) return;
  setBadge('area-badge', r, '判定した');
  const locStale = S && sensors.location.read().status === 'stale';
  let s = r.missing ? '区域の判定のモジュールが未実装です。' : statusLabel(r.status);
  if (r.status === 'ok') s = `${formatJst(lastAreaAt)} に取った位置で判定しました。${locStale ? 'この位置は古くなっています。取り直してください。' : ''}`;
  $('area-status').textContent = s;
  setLines('area-lines', areaLines(r));
  $('area-detail').textContent = noValueDetail(r);
  $('area-attribution').textContent = r.value ? `${r.value.attribution}。${r.value.processed}。` : '';
}

$('btn-locate').addEventListener('click', () => {
  if (!S) {
    lastArea = missingResult('location', Date.now(), toJstIso);
    renderArea();
    return;
  }
  // locateOnce() is called first, directly in the handler, so the browser
  // ties the permission prompt to this button press.
  const pending = sensors.location.locateOnce();
  $('area-status').textContent = '位置を問い合わせています…';
  Promise.all([pending, ensureAreaData()]).then(([loc]) => {
    lastAreaAt = Date.now();
    if (!A) {
      lastArea = missingResult('area', Date.now(), toJstIso);
    } else if (loc.status !== 'ok') {
      lastArea = { kind: 'area', status: loc.status, value: null, observed_at: loc.observed_at, source: loc.source, detail: `位置が取れないため、区域は判定できません。${loc.detail}` };
    } else if (!areaData) {
      lastArea = { kind: 'area', status: 'error', value: null, observed_at: toJstIso(Date.now()), source: 'device', detail: `区域のデータを読み込めませんでした（${areaDataError}）。` };
    } else {
      const v = loc.value;
      lastArea = A.locateArea(areaData, {
        latitude: v.latitude, longitude: v.longitude, accuracy: v.accuracy_m,
        ...(loc.source === 'simulated' ? { source: 'simulated' } : {}),
      });
    }
    renderArea();
    renderSensors();
  });
});
if (!A) renderArea();

// ---------------------------------------------------------------- announcements

let caStatus = null;          // last status from C-A
let caEverOk = false;
let caLastOkMs = null;
let caLinkOk = true;
let caError = null;
let mockCount = 3;
let mockBaseMs = Date.now();
let annOrigin = null;         // 'ca' | 'app-mock'

async function pollAnnouncements() {
  try {
    const res = await fetch(CA_STATUS_URL, { cache: 'no-store', credentials: 'omit' });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    caStatus = await res.json();
    caEverOk = true;
    caLastOkMs = Date.now();
    caLinkOk = true;
    caError = null;
    annOrigin = 'ca';
  } catch (e) {
    caError = String(e.message || e);
    // Once real data came from C-A, never fall back to mock data: that
    // would hide a real outage.
    if (caEverOk) caLinkOk = false;
    else annOrigin = 'app-mock';
  }
  renderAnnouncements();
}

function currentAnnouncementResult() {
  const now = Date.now();
  if (annOrigin === 'app-mock') {
    return summarize(makeMockStatus(mockBaseMs, mockCount), { origin: 'app-mock', nowMs: now });
  }
  return summarize(caStatus, { origin: 'ca', nowMs: now, linkOk: caLinkOk, lastOkMs: caLastOkMs, error: caError });
}

function p(text) {
  const e = document.createElement('p');
  e.textContent = text;
  return e;
}

function renderAnnouncements() {
  const r = currentAnnouncementResult();
  const mock = r.source === 'simulated';
  $('sec-ann').dataset.status = r.status;
  $('sec-ann').dataset.source = r.source;
  $('ann-mock').hidden = !mock;
  if (mock) markSimulated();
  setBadge('ann-badge', r, '受信あり');
  $('ann-origin').textContent = annOrigin === 'ca' ? '試作 C-A のサーバーから' : annOrigin === 'app-mock' ? '画面の中で作った模擬データ' : '';
  $('btn-ann-mock').hidden = annOrigin !== 'app-mock';
  $('ann-detail').textContent = noValueDetail(r);
  if (r.status === 'ok') {
    const L = r.value.latest;
    const nodes = [
      p(`${L.mock ? '【模擬データ】' : ''}${L.title}`),
      p(`発表：${L.author}、${formatJst(L.updated)}`),
    ];
    if (L.areas.length) nodes.push(p(`対象地域：${L.areas.join('、')}`));
    if (L.headline) nodes.push(p(`見出し：${L.headline}`));
    if (L.control_status && L.control_status !== '通常') nodes.push(p(`運用種別：${L.control_status}（通常の発表ではありません）`));
    if (L.link) {
      const a = document.createElement('a');
      a.href = L.link;
      a.rel = 'noopener noreferrer';
      a.target = '_blank';
      a.textContent = '元の電文（気象庁）';
      const wrap = document.createElement('p');
      wrap.append(a);
      nodes.push(wrap);
    }
    $('ann-latest').replaceChildren(...nodes);
    setLines('ann-recent', r.value.recent.map((e) => `${e.mock ? '【模擬】' : ''}${formatJst(e.updated)} ${e.title}（${e.author}）`));
  } else {
    $('ann-latest').replaceChildren(p(statusLabel(r.status)));
    setLines('ann-recent', []);
  }
}

$('btn-ann-mock').addEventListener('click', () => {
  mockCount++;
  mockBaseMs = Date.now();
  renderAnnouncements();
});

// ---------------------------------------------------------------- fragment

const F = mods.fragment.loaded ? mods.fragment.module : null;

function renderFragment(r) {
  $('sec-frag').dataset.status = r.missing ? 'missing' : r.status;
  setBadge('frag-badge', r, '読み取れた');
  const label = r.missing ? '断片の解析のモジュールが未実装です。'
    : r.status === 'ok' ? '読み取った内容（あなたの申告。公的に確認された情報ではありません）'
      : r.status === 'unknown' ? '読み取れませんでした。安全・異常なしという意味ではありません。'
        : statusLabel(r.status);
  $('frag-status').textContent = label;
  setLines('frag-lines', fragmentLines(r));
  $('frag-detail').textContent = noValueDetail(r);
}

$('frag-form').addEventListener('submit', (ev) => {
  ev.preventDefault();
  const text = $('frag-input').value;
  const r = F ? F.parseFragment(text) : missingResult('fragment', Date.now(), toJstIso);
  renderFragment(r);
});
if (!F) {
  renderFragment(missingResult('fragment', Date.now(), toJstIso));
}

// ---------------------------------------------------------------- mode

const M = mods.mode.loaded ? mods.mode.module : null;
const modeCtl = M ? createModeController(M) : null;

function renderMode() {
  const r = modeCtl ? modeCtl.current : missingResult('mode', Date.now(), toJstIso);
  $('sec-mode').dataset.mode = r.value?.mode ?? (r.missing ? 'missing' : r.status);
  const badge = $('mode-badge');
  if (r.status === 'ok') {
    // No green / "normal" styling for 平常 (BW-S3): grey, orange, red.
    const cls = { normal: 'missing', elevated: 'unknown', emergency: 'stale' }[r.value.mode];
    badge.textContent = r.value.stage != null ? `段階 ${r.value.stage}/${r.value.stage_count}` : 'モード';
    badge.className = `badge ${statusClass(cls)}`;
    $('mode-label').textContent = r.value.mode_label;
  } else {
    setBadge('mode-badge', r);
    $('mode-label').textContent = r.missing ? '状態機械のモジュールが未実装です。' : statusLabel(r.status);
  }
  setLines('mode-lines', modeLines(r));
  const rec = modeCtl?.reason;
  $('mode-reason').textContent = rec
    ? `${formatJst(rec.at)}：${rec.detail}${rec.cause?.source === 'simulated' ? '（模擬の入力）' : ''}`
    : (modeCtl ? '起動してから、まだ切り替わっていません。' : '—');
  const last = modeCtl?.last;
  $('mode-last').textContent = last && last.status !== 'ok' ? `直前の入力：${statusLabel(last.status)}。${last.detail}` : '';
}

if (modeCtl) {
  for (const [key, label] of Object.entries(USER_REQUESTS)) {
    const b = document.createElement('button');
    b.type = 'button';
    b.dataset.request = key;
    b.textContent = label;
    b.addEventListener('click', () => { modeCtl.request(key); renderMode(); });
    $('mode-requests').append(b);
  }
  for (const [key, def] of Object.entries(SIMULATED_EVENTS)) {
    const b = document.createElement('button');
    b.type = 'button';
    b.dataset.sim = key;
    b.textContent = def.label;
    b.addEventListener('click', () => { modeCtl.simulatePublic(key); markSimulated(); renderMode(); });
    $('mode-sim').append(b);
  }
  const lift = document.createElement('button');
  lift.type = 'button';
  lift.dataset.sim = 'lift_tsunami_warning';
  lift.textContent = '模擬：津波警報の解除を受けた';
  lift.addEventListener('click', () => { modeCtl.simulateLift('tsunami_warning'); markSimulated(); renderMode(); });
  $('mode-sim').append(lift);
  setInterval(() => { modeCtl.tick(); renderMode(); }, MODE_TICK_MS);
} else {
  $('mode-controls').hidden = true;
}

// ---------------------------------------------------------------- start

renderMode();
renderSensors();
renderMotion();
pollAnnouncements();
setInterval(pollAnnouncements, ANN_POLL_MS);
setInterval(() => { renderSensors(); renderMotion(); if (lastArea) renderArea(); }, UI_REFRESH_MS);

// For automated browser checks only.
globalThis.__app = {
  mods, sensors, get modeCtl() { return modeCtl; }, pollAnnouncements,
  get simulatedShown() { return simulatedShown; },
};
