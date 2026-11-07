// Browser-only: the sub-menu (mode, theme), the alert border around the page,
// the status line, the demo replay, and the current-location mode.
// Every text is inserted with textContent, never as HTML.
//
// Privacy: the position stays in this page. Requests: the page's own files,
// the bundled data files, and (current-location mode) a fixed GET of the C-A
// status with no query. The position is never put in a URL.

import { DEMOS, DEMO_IDS, DEMO_AREA_CODE, replayState, tsunamiInEffect } from './demos.js';
import { itemsFromStatus, areaCodesFromArea, tsunamiWarningFor } from './live.js';

const $ = (id) => document.getElementById(id);
const TICK_MS = 250;
const CA_POLL_MS = 15000; // ！！仮の値！！
const CA_STATUS_URL = '/api/ca/status';

async function tryImport(path) {
  try {
    return await import(new URL(path, import.meta.url));
  } catch (e) {
    return { __error: String(e?.message || e) };
  }
}

function store(key, value) {
  try {
    if (value === undefined) return globalThis.localStorage?.getItem(key) ?? null;
    globalThis.localStorage?.setItem(key, value);
  } catch {
    // storage may be unavailable (private mode); the page works without it
  }
  return null;
}

// ---------------------------------------------------------------- theme

const THEMES = ['auto', 'light', 'dark'];
function applyTheme(t) {
  const theme = THEMES.includes(t) ? t : 'auto';
  if (theme === 'auto') delete document.documentElement.dataset.theme;
  else document.documentElement.dataset.theme = theme;
  for (const b of document.querySelectorAll('[data-theme-choice]')) b.setAttribute('aria-pressed', String(b.dataset.themeChoice === theme));
  store('bw-theme', theme);
}
applyTheme(store('bw-theme'));
for (const b of document.querySelectorAll('[data-theme-choice]')) b.addEventListener('click', () => applyTheme(b.dataset.themeChoice));

// ---------------------------------------------------------------- menu

const menuBtn = $('menu-button');
const menu = $('menu-panel');
function setMenu(open) {
  menu.hidden = !open;
  menuBtn.setAttribute('aria-expanded', String(open));
}
menuBtn.addEventListener('click', () => setMenu(menu.hidden));
document.addEventListener('keydown', (e) => { if (e.key === 'Escape') setMenu(false); });
setMenu(false);

// ---------------------------------------------------------------- mode

const params = new URLSearchParams(globalThis.location?.search ?? '');
const requested = params.get('demo');
let mode = requested && DEMO_IDS.includes(requested) ? requested : 'live';
let demoStart = Date.now();
let demoPaused = false;
let pausedAt = 0;

function setMode(m) {
  mode = m === 'live' || DEMO_IDS.includes(m) ? m : 'live';
  demoStart = Date.now();
  demoPaused = false;
  for (const b of document.querySelectorAll('[data-mode-choice]')) b.setAttribute('aria-pressed', String(b.dataset.modeChoice === mode));
  $('demo-controls').hidden = mode === 'live';
  if (mode === 'live') pollCa().then(render);
  render();
}
for (const b of document.querySelectorAll('[data-mode-choice]')) b.addEventListener('click', () => { setMode(b.dataset.modeChoice); setMenu(false); });
$('demo-restart').addEventListener('click', () => { demoStart = Date.now(); demoPaused = false; $('demo-pause').textContent = '一時停止'; render(); });
$('demo-pause').addEventListener('click', () => {
  if (demoPaused) {
    demoStart += Date.now() - pausedAt;
    demoPaused = false;
  } else {
    pausedAt = Date.now();
    demoPaused = true;
  }
  $('demo-pause').textContent = demoPaused ? '再開' : '一時停止';
});

// ---------------------------------------------------------------- modules

const A = await tryImport('../../modules/alert/browser/load.js');
const AR = await tryImport('../../modules/area/browser/load.js');
const S = await tryImport('../../modules/sensors/index.js');
let coast = null;
let areaData = null;
if (!A.__error) A.loadCoastData().then((d) => { coast = d; }, () => {});
if (!AR.__error) AR.loadAreaData().then((d) => { areaData = d; }, () => {});
const locSensor = S.__error ? null : S.createLocationSensor({ env: S.createDeviceEnv() });
// The location is asked for with the evacuee view's button (a user gesture).
$('evac-start')?.addEventListener('click', () => locSensor?.start());

// ---------------------------------------------------------------- C-A (current-location mode)

let caStatus = null;
let caOkAt = null;
let caFailed = false;
async function pollCa() {
  if (mode !== 'live') return;
  try {
    const res = await fetch(CA_STATUS_URL, { cache: 'no-store', credentials: 'omit' });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    caStatus = await res.json();
    caOkAt = Date.now();
    caFailed = false;
  } catch {
    caFailed = true;
  }
}

// ---------------------------------------------------------------- state

function liveInputs(now) {
  const loc = locSensor ? locSensor.read() : null;
  const received = Boolean(caStatus) && !caFailed && caOkAt !== null && now - caOkAt < 3 * CA_POLL_MS;
  const { items, simulated } = itemsFromStatus(caStatus);
  let areaCodes = [];
  let near = null;
  let note = '';
  if (loc?.status === 'ok') {
    const v = loc.value;
    if (areaData && !AR.__error) {
      const r = AR.locateArea(areaData, { latitude: v.latitude, longitude: v.longitude, accuracy: v.accuracy_m });
      areaCodes = areaCodesFromArea(r);
      if (!areaCodes.length) note = 'この位置の区域のデータがありません（いまは静岡県だけです）。';
    }
    if (coast) near = A.nearestCoast(coast, v.latitude, v.longitude);
  } else {
    note = '位置が分からないため、この地域への発表を選べません。「位置と方位を使う」を押してください。';
  }
  return { items, areaCodes, coast: near, received, areaKnown: areaCodes.length > 0, simulated, note, position: null, receivedMs: caOkAt };
}

// ?demostep=ms shortens each replay step (for automated checks and quick
// rehearsals); ignored unless it is a number from 200 to 60000.
const stepOverride = Number(params.get('demostep'));
const STEP_MS = Number.isFinite(stepOverride) && stepOverride >= 200 && stepOverride <= 60000 ? stepOverride : null;

function demoInputs(now) {
  const base = DEMOS[mode];
  const demo = STEP_MS ? { ...base, stepMs: STEP_MS } : base;
  const elapsed = (demoPaused ? pausedAt : now) - demoStart;
  const st = replayState(demo, elapsed);
  const near = coast ? A.nearestCoast(coast, demo.position.latitude, demo.position.longitude) : null;
  return {
    items: st.items,
    areaCodes: [DEMO_AREA_CODE],
    coast: near,
    received: true,
    simulated: true,
    note: '',
    position: demo.position,
    receivedMs: demoStart,
    demo,
    replay: st,
  };
}

let lastDispatch = '';
function tellEvacuee(inp, state) {
  let detail;
  if (inp.demo) {
    const ts = tsunamiInEffect(inp.replay);
    const hazard = inp.demo.hazardOnTsunami && ts ? inp.demo.hazardOnTsunami : null;
    detail = {
      mode,
      hazard,
      def: hazard ? {
        hazard,
        instruction: inp.demo.kind === 'record'
          ? `【過去の記録の再生】${inp.replay.event.time} ${ts.name}（${ts.area}）`
          : `【模擬】${ts.name}（模擬・${ts.area}）`,
        origin: inp.demo.banner,
      } : null,
      message: hazard && !inp.demo.hasEvacData
        ? 'このデモには避難場所のデータがありません（いまは静岡県のデータだけを持っています）。'
        : hazard ? '' : 'このデモの記録では、いま避難場所の方向を示す発表（津波警報など）は出ていません。',
      position: inp.position,
      hasEvacData: inp.demo.hasEvacData,
      receivedMs: inp.receivedMs,
      simulated: true,
      label: inp.demo.kind === 'record' ? '【過去の記録の再生】' : '【模擬】',
    };
  } else {
    const tw = tsunamiWarningFor(state.status === 'ok' ? inp.items : [], inp.coast);
    detail = {
      mode,
      hazard: tw ? 'tsunami' : null,
      def: tw ? {
        hazard: 'tsunami',
        instruction: `気象庁の発表：${tw.name}（${tw.area}）${inp.simulated ? '【模擬データ】' : ''}`,
        origin: '気象庁の発表の種類と対象を中継しています。内容は気象庁・市町村の発表を確かめてください。',
      } : null,
      message: '',
      position: null,
      hasEvacData: true,
      receivedMs: inp.receivedMs,
      simulated: inp.simulated,
    };
  }
  const key = JSON.stringify(detail);
  if (key !== lastDispatch) {
    lastDispatch = key;
    // Kept for a listener that starts later (module load order is not fixed).
    globalThis.__appContext = detail;
    globalThis.dispatchEvent(new CustomEvent('app:context', { detail }));
  }
}

let current = null;
function render() {
  const now = Date.now();
  const inp = mode === 'live' ? liveInputs(now) : demoInputs(now);
  const unknown = (detail) => ({ status: 'unknown', level: null, imminent: false, color: null, blink: 'none', detail, sources: [] });
  let state;
  if (A.__error) state = unknown('外枠のモジュールを読み込めませんでした。');
  else if (!inp.demo && inp.received && !inp.areaKnown) state = unknown('この地域への発表を選べません。発表がないという意味ではありません。');
  else state = A.alertState(inp);
  if (!inp.demo && inp.simulated && state.status === 'ok') state = { ...state, detail: `【模擬データ】${state.detail}` };
  current = { mode, inp, state };

  const frame = $('alert-frame');
  frame.dataset.level = state.level === null ? 'unknown' : String(state.level);
  frame.dataset.blink = state.blink;
  frame.style.setProperty('--frame-color', state.color ?? 'var(--bg)');

  $('status-mode').textContent = mode === 'live' ? '現在位置' : `デモ：${DEMOS[mode].label}`;
  const mark = inp.demo ? (inp.demo.kind === 'record' ? '【過去の記録の再生】' : '【模擬】') : '';
  $('status-text').textContent = mark + [state.detail, inp.note].filter(Boolean).join(' ');
  $('status-line').dataset.level = frame.dataset.level;
  $('status-line').dataset.imminent = String(state.imminent);

  const demoBox = $('demo-box');
  demoBox.hidden = !inp.demo;
  if (inp.demo) {
    $('demo-banner').textContent = inp.demo.banner;
    $('demo-place').textContent = `位置：${inp.demo.place}`;
    $('demo-now').textContent = [inp.replay.event.time, inp.replay.event.text].filter(Boolean).join('　');
    $('demo-inEffect').textContent = inp.replay.inEffect.length ? `出ている発表：${inp.replay.inEffect.join('、')}` : '出ている発表：なし（記録の上で）';
    $('demo-log').replaceChildren(...inp.replay.log.map((e) => {
      const li = document.createElement('li');
      li.textContent = [e.time, e.text].filter(Boolean).join('　');
      return li;
    }).reverse());
    $('demo-sources').replaceChildren(...inp.demo.sources.map((s) => {
      const li = document.createElement('li');
      li.textContent = s;
      return li;
    }));
    $('demo-sources-wrap').hidden = inp.demo.sources.length === 0;
    $('demo-step').textContent = `${inp.replay.index + 1} / ${inp.demo.events.length}${inp.replay.finished ? '（再生は終わりました）' : ''}`;
  }
  tellEvacuee(inp, state);
}

setMode(mode);
pollCa().then(render);
setInterval(pollCa, CA_POLL_MS);
setInterval(render, TICK_MS);

// For automated browser checks only.
globalThis.__shell = {
  get state() { return current; },
  setMode,
  applyTheme,
  pollCa,
};
