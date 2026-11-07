// Browser-only: the menu (8 items), the alert border around the page, the
// top notices, the two panes (main / current alert text) with swipe and
// edge buttons, the demo replay, the current-location mode, the history of
// received announcements, the one consent for lookups that send the
// position, and the inputs of the handoff memo.
// Every text is inserted with textContent, never as HTML.
//
// Privacy: without consent the position stays in this page. Requests: the
// page's own files, the bundled data files, and (current-location mode) a
// fixed GET of the C-A status with no query. Only after the consent in the
// menu (事前情報収集), the position is sent to the GSI elevation API and a
// map tile around it is fetched from the hazard map portal (./lookup.js).

import { DEMOS, DEMO_IDS, DEMO_AREA_CODE, replayState, tsunamiInEffect, demoElapsedHours, recordTimeMs } from './demos.js';
import { itemsFromStatus, areaCodesFromArea, tsunamiWarningFor, forecastHeightFor } from './live.js';
import { createHistory, entriesFromItems, disasterStartMs, historyLine } from './history.js';
import { readConsent, writeConsent, CONSENT_TEXT, CONSENT_STOP } from './consent.js';
import { CONTACT_GROUPS, CHECKED, telHref } from './contacts.js';
import { stageAt, guideProminence } from '../handoff/handoff.js';
import { formatJstHm, minutesAgoText } from '../evac/model.js';

const $ = (id) => document.getElementById(id);
const TICK_MS = 250;
const CA_POLL_MS = 15000; // ！！仮の値！！
const CA_STATUS_URL = '/api/ca/status';
const MAX_NOTICES = 3;

async function tryImport(path) {
  try {
    return await import(new URL(path, import.meta.url));
  } catch (e) {
    return { __error: String(e?.message || e) };
  }
}

function storage() {
  try {
    return globalThis.localStorage ?? null;
  } catch {
    return null; // storage may be unavailable (private mode); the page works without it
  }
}

function li(text) {
  const e = document.createElement('li');
  e.textContent = text;
  return e;
}

function link(label, url) {
  const a = document.createElement('a');
  a.href = url;
  a.rel = 'noopener noreferrer';
  a.target = '_blank';
  a.textContent = label;
  return a;
}

// Light only: an older saved theme choice is ignored and removed.
delete document.documentElement.dataset.theme;
try { storage()?.removeItem('bw-theme'); } catch { /* ignore */ }

// ---------------------------------------------------------------- menu

const menuBtn = $('menu-button');
const menu = $('menu-panel');
function setMenu(open) {
  menu.hidden = !open;
  menuBtn.setAttribute('aria-expanded', String(open));
  menuBtn.textContent = open ? 'メニューを閉じる' : 'メニュー';
}
menuBtn.addEventListener('click', () => setMenu(menu.hidden));
$('menu-close').addEventListener('click', () => { setMenu(false); menuBtn.focus(); });
document.addEventListener('keydown', (e) => { if (e.key === 'Escape') setMenu(false); });
for (const id of ['tab-evac', 'tab-support']) $(id).addEventListener('click', () => setMenu(false));
setMenu(false);

// ---------------------------------------------------------------- panes (swipe, edge buttons)

const PANES = ['main', 'alert'];
let pane = 'main';
function showPane(name) {
  pane = PANES.includes(name) ? name : 'main';
  $('pane-main').hidden = pane !== 'main';
  $('pane-alert').hidden = pane !== 'alert';
  $('pager').dataset.pane = pane;
  const next = pane === 'main' ? '現在の警戒情報の画面へ' : 'メイン画面へ';
  $('pager-prev').setAttribute('aria-label', next);
  $('pager-next').setAttribute('aria-label', next);
}
// Two panes: either direction switches to the other one.
function flipPane() { showPane(pane === 'main' ? 'alert' : 'main'); }
$('pager-prev').addEventListener('click', flipPane);
$('pager-next').addEventListener('click', flipPane);

// The swipe must start in the middle of the screen (15 %..85 % of the
// width): the edges belong to the OS "back" gesture.
let touch = null;
const pagerEl = $('pager');
pagerEl.addEventListener('touchstart', (e) => {
  const t = e.touches[0];
  const w = globalThis.innerWidth || 1;
  touch = e.touches.length === 1 && t.clientX > w * 0.15 && t.clientX < w * 0.85 ? { x: t.clientX, y: t.clientY } : null;
}, { passive: true });
pagerEl.addEventListener('touchend', (e) => {
  if (!touch) return;
  const t = e.changedTouches[0];
  const dx = t.clientX - touch.x;
  const dy = t.clientY - touch.y;
  touch = null;
  if (Math.abs(dx) >= 60 && Math.abs(dx) > 1.5 * Math.abs(dy)) flipPane();
}, { passive: true });
showPane('main');

// ---------------------------------------------------------------- notices (top)

// New information is shown at the top and read aloud (role="alert"). It
// stays until the person closes it.
const notices = [];
let noticeSeq = 0;
// A newer notice about the same thing (key) replaces the older one.
function notify(text, key = null) {
  if (key !== null) {
    const i = notices.findIndex((x) => x.key === key);
    if (i >= 0) notices.splice(i, 1);
  }
  notices.unshift({ id: ++noticeSeq, text, key });
  renderNotices();
}
function renderNotices() {
  const box = $('notices');
  const shown = notices.slice(0, MAX_NOTICES);
  box.replaceChildren(...shown.map((n) => {
    const d = document.createElement('div');
    d.className = 'notice';
    d.setAttribute('role', 'alert');
    d.dataset.noticeId = String(n.id);
    const p = document.createElement('p');
    p.textContent = n.text;
    const b = document.createElement('button');
    b.type = 'button';
    b.textContent = '閉じる';
    b.addEventListener('click', () => {
      const i = notices.findIndex((x) => x.id === n.id);
      if (i >= 0) notices.splice(i, 1);
      renderNotices();
    });
    d.append(p, b);
    return d;
  }));
  if (notices.length > MAX_NOTICES) {
    const more = document.createElement('p');
    more.className = 'note notices-more';
    more.textContent = `ほかに ${notices.length - MAX_NOTICES} 件の知らせがあります（閉じると表示します）。`;
    box.append(more);
  }
}

// ---------------------------------------------------------------- mode (demo ON/OFF and place)

const params = new URLSearchParams(globalThis.location?.search ?? '');
const requested = params.get('demo');
let demoPlace = requested && DEMO_IDS.includes(requested) ? requested : 'shizuoka';
let demoOn = Boolean(requested && DEMO_IDS.includes(requested));
let mode = demoOn ? demoPlace : 'live';
let demoStart = Date.now();
let demoPaused = false;
let pausedAt = 0;
let lastLevel = null; // for the "no longer in effect" notice

function setMode(m) {
  if (DEMO_IDS.includes(m)) {
    demoPlace = m;
    demoOn = true;
  } else {
    demoOn = false;
  }
  mode = demoOn ? demoPlace : 'live';
  demoStart = Date.now();
  demoPaused = false;
  $('demo-pause').textContent = '一時停止';
  for (const b of document.querySelectorAll('[data-demo-place]')) b.setAttribute('aria-pressed', String(b.dataset.demoPlace === demoPlace));
  const t = $('demo-toggle');
  t.setAttribute('aria-pressed', String(demoOn));
  t.textContent = demoOn ? `デモ：ON（${DEMOS[demoPlace].label}）　押すと OFF` : 'デモ：OFF（押すと ON）';
  $('demo-controls').hidden = mode === 'live';
  lastLevel = null;
  if (mode === 'live') pollCa().then(render);
  render();
}
for (const b of document.querySelectorAll('[data-demo-place]')) {
  b.addEventListener('click', () => {
    demoPlace = b.dataset.demoPlace;
    if (demoOn) setMode(demoPlace);
    else for (const x of document.querySelectorAll('[data-demo-place]')) x.setAttribute('aria-pressed', String(x.dataset.demoPlace === demoPlace));
  });
}
$('demo-toggle').addEventListener('click', () => { setMode(demoOn ? 'live' : demoPlace); setMenu(false); });
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
const MC = await tryImport('../../modules/mode/config.js');
const L = await tryImport('./lookup.js');
let coast = null;
let areaData = null;
if (!A.__error) A.loadCoastData().then((d) => { coast = d; }, () => {});
if (!AR.__error) AR.loadAreaData().then((d) => { areaData = d; }, () => {});
const locSensor = S.__error ? null : S.createLocationSensor({ env: S.createDeviceEnv() });
// The location is asked for with the evacuee view's button (a user gesture).
$('evac-start')?.addEventListener('click', () => locSensor?.start());

// ---------------------------------------------------------------- consent (one, for all lookups)

let consent = readConsent(storage());
function renderConsent() {
  $('consent-state').textContent = consent.granted
    ? `同意しています（${formatJstHm(consent.at)} から）。位置が大きく変わったときに、標高と浸水想定を調べます。`
    : '同意していません。いる場所の位置は外に送りません。';
  const b = $('consent-toggle');
  b.setAttribute('aria-pressed', String(consent.granted));
  b.textContent = consent.granted ? '同意をやめる' : '同意して標高と浸水想定を調べる';
}
$('consent-text').replaceChildren(...CONSENT_TEXT.map(li));
$('consent-stop').textContent = CONSENT_STOP;
$('consent-toggle').addEventListener('click', () => {
  consent = writeConsent(storage(), !consent.granted);
  liveLookup = { key: null, here: null, inundation: null };
  renderConsent();
  render();
});
renderConsent();

// Live lookups (only with consent and a position).
let liveLookup = { key: null, here: null, inundation: null };
function updateLiveLookup(v) {
  if (L.__error) return;
  const key = `${Math.round(v.latitude * 2000)}:${Math.round(v.longitude * 2000)}`;
  if (liveLookup.key === key) return;
  liveLookup = { key, here: { status: 'loading' }, inundation: null };
  L.fetchElevation(v.latitude, v.longitude).then((r) => { if (liveLookup.key === key) liveLookup.here = r; });
  L.inundationAt(v.latitude, v.longitude).then((r) => { if (liveLookup.key === key) liveLookup.inundation = r; });
}

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

// ---------------------------------------------------------------- history

const history = createHistory(storage());
function renderHistory() {
  const list = history.list();
  $('history-list').replaceChildren(...(list.length
    ? list.slice().reverse().map((e) => li(historyLine(e, formatJstFull)))
    : [li('まだ記録がありません（受け取っていないことは、発表がなかったという意味ではありません）。')]));
}
function formatJstFull(ms) {
  const t = new Date(ms + 9 * 3600 * 1000).toISOString();
  return `${t.slice(0, 10)} ${t.slice(11, 16)}`;
}
$('history-clear').addEventListener('click', () => {
  history.clear();
  renderHistory();
});
renderHistory();

function levelOf(name, status) {
  return A.__error ? null : A.levelOfKind(name, status);
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
    if (consent.granted) updateLiveLookup(v);
  } else {
    note = '位置が分からないため、この地域への発表を選べません。「位置と方位を使う」を押してください。';
  }
  const here = !consent.granted
    ? { status: 'no-consent' }
    : loc?.status === 'ok' ? (liveLookup.here ?? { status: 'loading' }) : { status: 'none' };
  return {
    items, areaCodes, coast: near, received, areaKnown: areaCodes.length > 0, simulated, note, position: null, receivedMs: caOkAt,
    inundation: consent.granted ? liveLookup.inundation : null,
    here,
    mark: simulated ? '【模擬データ】' : '',
  };
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
    inundation: demo.lookup?.inundation ?? null,
    here: demo.lookup ? { status: 'ok', value_m: demo.lookup.elevation_m, source: `${demo.lookup.elevation_source}、${demo.lookup.checked} に調べた値` } : { status: 'none' },
    mark: demo.kind === 'record' ? '【過去の記録の再生】' : '【模擬】',
  };
}

let lastDispatch = '';
function tellEvacuee(inp, state) {
  const forecast = forecastHeightFor(state.status === 'ok' ? inp.items : [], inp.coast);
  const common = { forecast, here: inp.here, received: inp.received, mark: inp.mark };
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
      ...common,
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
      ...common,
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

// Record newly received announcements in the history and tell the person.
function recordAndNotify(inp, state) {
  if (state.status !== 'ok') return;
  let entries;
  if (inp.demo) {
    const t = recordTimeMs(inp.replay.event.time);
    entries = entriesFromItems(inp.items, {
      at: t ?? Date.now(),
      source: inp.demo.kind === 'record' ? 'record' : 'simulated',
      mark: inp.mark,
      idPrefix: `demo|${inp.demo.id}|${demoStart}`,
      levelOf,
    });
  } else {
    const codes = new Set([...inp.areaCodes, inp.coast?.region_code].filter(Boolean).map(String));
    entries = [];
    for (const it of inp.items) {
      if (!codes.has(String(it.area_code))) continue;
      entries.push(...entriesFromItems([it], {
        at: caOkAt ?? Date.now(),
        source: inp.simulated ? 'mock' : 'live',
        mark: inp.mark,
        idPrefix: `live|${it.report_ms ?? ''}`,
        levelOf,
      }));
    }
  }
  const added = history.add(entries);
  for (const e of added) {
    notify(`新しい情報：${e.mark}${e.name}（${e.area}）${e.height ? ` 予想される津波の高さ ${e.height}` : ''}`, `${e.source}|${e.area}`);
  }
  if (added.length) renderHistory();
  if (lastLevel !== null && lastLevel > 0 && state.level === 0) {
    notify(`${inp.mark}受け取っている範囲では、この地域への注意報・警報がなくなりました。解除の内容は公的な発表で確かめてください。`, 'level0');
  }
  lastLevel = state.level;
}

// Hours since the disaster and the stage of modules/mode (names and hours).
function elapsedHours(inp, now) {
  if (inp.demo) return demoElapsedHours(inp.demo, inp.replay);
  const t0 = disasterStartMs(history.list());
  return t0 === null ? null : Math.max(0, (now - t0) / 3600000);
}

let current = null;
function render() {
  const now = Date.now();
  const inp = mode === 'live' ? liveInputs(now) : demoInputs(now);
  const unknown = (detail) => ({ status: 'unknown', level: null, imminent: false, basis: null, color: null, blink: 'none', detail, sources: [] });
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

  // Demo mark at the top: visible whichever pane is shown.
  const strip = $('demo-strip');
  strip.hidden = !inp.demo;
  strip.textContent = inp.demo ? `${inp.demo.banner}（デモ：${inp.demo.label}）` : '';

  // Sub-screen 1: the current alert as text.
  $('status-mode').textContent = mode === 'live' ? '現在位置' : `デモ：${DEMOS[mode].label}`;
  $('status-text').textContent = inp.mark + [state.detail, inp.note].filter(Boolean).join(' ');
  $('status-line').dataset.level = frame.dataset.level;
  $('status-line').dataset.imminent = String(state.imminent);
  const shownItems = state.status === 'ok' ? state.sources : [];
  $('alert-items').replaceChildren(...(shownItems.length
    ? shownItems.map((s) => li(`${inp.mark}${s.name}（${s.area_name ?? '対象地域'}）`))
    : [li(state.status === 'ok'
      ? '受け取っている範囲では、この地域への注意報・警報はありません。発表がないことは、安全という意味ではありません。'
      : '発表を受け取れていない、または地域を選べません。警報が出ていないという意味ではありません。')]));
  if (inp.demo) {
    $('alert-received').textContent = `記録の時刻：${inp.replay.event.time || '（模擬のため時刻なし）'}　${inp.mark}いま出ている発表ではありません。`;
  } else if (inp.received && caOkAt) {
    $('alert-received').textContent = `受信時刻：${formatJstHm(caOkAt)}（${minutesAgoText(caOkAt, now) ?? ''}）${inp.mark}`;
  } else {
    $('alert-received').textContent = '受信時刻：受け取れていません。警報が出ていないという意味ではありません。';
  }

  const demoBox = $('demo-box');
  demoBox.hidden = !inp.demo;
  if (inp.demo) {
    $('demo-banner').textContent = inp.demo.banner;
    $('demo-place').textContent = `位置：${inp.demo.place}`;
    $('demo-now').textContent = [inp.replay.event.time, inp.replay.event.text].filter(Boolean).join('　');
    $('demo-inEffect').textContent = inp.replay.inEffect.length ? `出ている発表：${inp.replay.inEffect.join('、')}` : '出ている発表：なし（記録の上で）';
    $('demo-log').replaceChildren(...inp.replay.log.map((e) => li([e.time, e.text].filter(Boolean).join('　'))).reverse());
    $('demo-step').textContent = `${inp.replay.index + 1} / ${inp.demo.events.length}${inp.replay.finished ? '（再生は終わりました）' : ''}`;
  }

  recordAndNotify(inp, state);

  // The handoff guide grows as the survival stage comes near (never switches by itself).
  const hours = elapsedHours(inp, now);
  const stage = MC.__error ? null : stageAt(hours, MC.DEFAULT_STAGES, MC.DEFAULT_STAGE_HOURS);
  const prominence = guideProminence(stage);
  const guide = $('handoff-open');
  guide.dataset.prominence = prominence;
  $('handoff-guide-note').textContent = prominence === 'high'
    ? `${inp.mark}発災から時間がたちました（段階の目安：${stage.name}）。水・食料・電源・連絡などの困りごとを、メモにまとめて Claude や窓口に相談できます。`
    : prominence === 'mid' ? `${inp.mark}落ち着いたら、困っていることを引き継ぎメモにまとめられます。` : '';
  globalThis.__handoffSources = {
    ...(globalThis.__handoffSources ?? {}),
    mark: inp.mark,
    elapsedHours: hours,
    stageName: stage?.name ?? null,
    announcements: history.list().map((e) => historyLine(e, formatJstFull)),
  };

  tellEvacuee(inp, state);
}

// ---------------------------------------------------------------- static menu parts

function fillMenu() {
  // Sources of the records and data.
  const src = [];
  for (const id of DEMO_IDS) for (const s of DEMOS[id].sources) src.push(`デモ（${DEMOS[id].label}）：${s}`);
  src.push('避難場所：国土地理院「指定緊急避難場所データ」 https://hinanmap.gsi.go.jp/index.html');
  src.push('海岸線（津波予報区）：気象庁の GIS データ（modules/alert/data/SOURCE.md）');
  src.push('標高：国土地理院の標高 API https://maps.gsi.go.jp/development/elevation_s.html');
  src.push('津波浸水想定：ハザードマップポータルサイト（国土地理院）のタイル https://disaportal.gsi.go.jp/');
  src.push('予想される津波の高さ：気象庁の津波警報・注意報の電文（試作 C-A が中継）。デモの静岡県は模擬の値です。');
  src.push(`公的機関のリンクと連絡先：各機関の公式ページで ${CHECKED} に確かめたもの（項目ごとに確かめたページを出しています）`);
  $('sources-list').replaceChildren(...src.map(li));

  const linksBox = $('links-list');
  const contactsBox = $('contacts-list');
  for (const g of CONTACT_GROUPS) {
    const lg = document.createElement('div');
    lg.className = 'contact-group';
    const h = document.createElement('h3');
    h.textContent = g.title;
    const ul = document.createElement('ul');
    ul.className = 'lines';
    for (const l of g.links) {
      const item = document.createElement('li');
      item.append(link(l.label, l.value));
      if (l.note) item.append(`（${l.note}）`);
      ul.append(item);
    }
    lg.append(h, ul);
    linksBox.append(lg);

    const cg = document.createElement('div');
    cg.className = 'contact-group';
    const h2 = document.createElement('h3');
    h2.textContent = g.title;
    const ul2 = document.createElement('ul');
    ul2.className = 'lines';
    for (const p of g.phones) {
      const item = document.createElement('li');
      item.append(`${p.label}：`);
      const a = document.createElement('a');
      a.href = telHref(p.value);
      a.className = 'contact-num';
      a.textContent = p.value;
      item.append(a);
      if (p.note) item.append(`（${p.note}）`);
      const s = document.createElement('span');
      s.className = 'note';
      s.append(' 出典：');
      s.append(link('公式ページ', p.src));
      s.append(`（${CHECKED} 確認）`);
      item.append(s);
      ul2.append(item);
    }
    cg.append(h2, ul2);
    contactsBox.append(cg);
  }
  const checked = document.createElement('p');
  checked.className = 'note';
  checked.textContent = `確認した日：${CHECKED}。番号は変わることがあります。かける前に公式ページで確かめてください。`;
  linksBox.append(checked.cloneNode(true));
  contactsBox.append(checked);
}
fillMenu();

setMode(mode);
pollCa().then(render);
setInterval(pollCa, CA_POLL_MS);
setInterval(render, TICK_MS);

// For automated browser checks only.
globalThis.__shell = {
  get state() { return current; },
  get pane() { return pane; },
  get notices() { return notices.slice(); },
  setMode,
  showPane,
  pollCa,
  history,
};
