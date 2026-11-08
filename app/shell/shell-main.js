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
import { itemsFromStatus, areaCodesFromArea, tsunamiWarningFor, forecastHeightFor, observedHeightFor, currentFacts } from './live.js';
import { parseHeight } from './heights.js';
import { createHistory, entriesFromItems, disasterStartMs, historyLine } from './history.js';
import { readConsent, writeConsent, CONSENT_TEXT, CONSENT_STOP } from './consent.js';
import { CONTACT_GROUPS, CHECKED, telHref } from './contacts.js';
import { stageAt, guideProminence } from '../handoff/handoff.js';
import { minutesAgoText } from '../evac/model.js';
import { infoLines, formatMdHm, recordMdHm, observedLevel } from './infolines.js';

const $ = (id) => document.getElementById(id);
const TICK_MS = 250;
const CA_POLL_MS = 15000; // ！！仮の値！！
const CA_STATUS_URL = '/api/ca/status';
const NOTICE_MS = 2000;

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
// Hamburger button: the panel opens over the screen.
function setMenu(open) {
  menu.hidden = !open;
  menuBtn.setAttribute('aria-expanded', String(open));
  menuBtn.setAttribute('aria-label', open ? 'メニューを閉じる' : 'メニューを開く');
}
menuBtn.addEventListener('click', () => setMenu(menu.hidden));
$('menu-close').addEventListener('click', () => { setMenu(false); menuBtn.focus(); });
document.addEventListener('keydown', (e) => { if (e.key === 'Escape') setMenu(false); });
// A choice applies at once; the menu closes so the change can be seen.
for (const id of ['tab-evac', 'tab-support']) $(id).addEventListener('change', () => setMenu(false));
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

// Short notices at the top, read aloud, closed by themselves after
// NOTICE_MS. They only say that something changed: the information itself
// is in the line above the compass (#headline-card), so the screen does not
// repeat it.
export const UPDATED_TEXT = '情報が更新されました';
export const OBSERVED_FRAME_TEXT = '気象庁の観測値による色枠表示';
const notices = [];
let noticeSeq = 0;
// The same text again only restarts its timer.
function notify(text) {
  const old = notices.find((x) => x.text === text);
  if (old) clearTimeout(old.timer);
  const n = old ?? { id: ++noticeSeq, text };
  if (!old) notices.push(n);
  n.timer = setTimeout(() => {
    const i = notices.indexOf(n);
    if (i >= 0) notices.splice(i, 1);
    renderNotices();
  }, NOTICE_MS);
  renderNotices();
}
function renderNotices() {
  $('notices').replaceChildren(...notices.map((n) => {
    const d = document.createElement('div');
    d.className = 'notice';
    d.setAttribute('role', 'status');
    d.dataset.noticeId = String(n.id);
    const p = document.createElement('p');
    p.textContent = n.text;
    d.append(p);
    return d;
  }));
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
let lastObservedRaise = null; // level the observation raised the border to

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
  $('demo-place').value = demoPlace;
  $('demo-toggle').checked = demoOn;
  $('demo-controls').hidden = mode === 'live';
  lastLevel = null;
  lastObservedRaise = null;
  if (mode === 'live') pollCa().then(render);
  render();
}
// Place: a drop-down list. ON/OFF: a toggle switch. Both apply at once.
$('demo-place').addEventListener('change', () => {
  demoPlace = DEMO_IDS.includes($('demo-place').value) ? $('demo-place').value : demoPlace;
  if (demoOn) setMode(demoPlace);
});
$('demo-toggle').addEventListener('change', () => { setMode($('demo-toggle').checked ? demoPlace : 'live'); setMenu(false); });
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
$('evac-start')?.addEventListener('change', (e) => { if (e.target.checked) locSensor?.start(); else locSensor?.stop(); });

// ---------------------------------------------------------------- consent (one, for all lookups)

let consent = readConsent(storage());
function renderConsent() {
  $('consent-state').textContent = consent.granted
    ? `同意しています（${formatMdHm(consent.at)} から）。`
    : '同意していません。位置は外に送りません。';
  $('consent-yes').checked = consent.granted;
  $('consent-no').checked = !consent.granted;
}
$('consent-text').replaceChildren(...CONSENT_TEXT.map(li));
$('consent-stop').textContent = CONSENT_STOP;
// Two choices as radio buttons; the choice applies at once.
for (const id of ['consent-yes', 'consent-no']) {
  $(id).addEventListener('change', () => {
    const granted = $('consent-yes').checked;
    if (granted === consent.granted) return;
    consent = writeConsent(storage(), granted);
    liveLookup = { key: null, here: null, inundation: null };
    renderConsent();
    render();
  });
}
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
    ? list.slice().reverse().map((e) => li(historyLine(e, formatMdHm)))
    : [li('まだ記録がありません（受け取っていないことは、発表がなかったという意味ではありません）。')]));
}
$('history-clear').addEventListener('click', () => {
  history.clear();
  renderHistory();
});
renderHistory();

// A tsunami advisory or warning in effect for the nearest coast region.
function tsunamiInEffectFor(items, coast) {
  if (!coast) return false;
  return (items ?? []).some((it) => String(it.area_code) === String(coast.region_code)
    && (it.kinds ?? []).some((k) => /津波/.test(k.name) && levelOf(k.name, k.status)));
}

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
  const observed = state.status === 'ok' && inp.observed ? observedHeightFor(inp.facts, inp.coast, parseHeight) : null;
  // Tsunami information is shown (the note "津波は予想より高くなる場合あり。").
  const tsunamiInfo = state.status === 'ok' && (tsunamiInEffectFor(inp.items, inp.coast) || Boolean(forecast) || Boolean(observed));
  const common = { forecast, observed, tsunamiInfo, here: inp.here, received: inp.received, mark: inp.mark };
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
        ? 'このデモには避難場所のデータがありません（いまは静岡県だけです）。'
        : hazard ? '' : '津波警報などが出ていないため、避難目標は出していません。',
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
  if (added.length) {
    notify(UPDATED_TEXT);
    renderHistory();
  }
  if (lastLevel !== null && lastLevel > 0 && state.level === 0) notify(UPDATED_TEXT);
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
  // The highest observed tsunami height for the nearest coast region: the
  // border uses the higher of the announcements and its height class.
  // Used only while a tsunami announcement (advisory or warning) is in
  // effect for that region: once everything is lifted, an old observation
  // does not keep the border up.
  inp.facts = currentFacts(inp.replay?.facts ?? [], inp.items, recordTimeMs);
  const obs = tsunamiInEffectFor(inp.items, inp.coast) ? observedHeightFor(inp.facts, inp.coast, parseHeight) : null;
  inp.observed = obs ? { level: observedLevel(obs), text: obs.text, place: obs.place } : null;
  const unknown = (detail) => ({ status: 'unknown', level: null, imminent: false, basis: null, color: null, blink: 'none', detail, sources: [] });
  let state;
  if (A.__error) state = unknown('外枠のモジュールを読み込めませんでした。');
  else if (!inp.demo && inp.received && !inp.areaKnown) state = unknown('この地域への発表を選べません。発表がないという意味ではありません。');
  else state = A.alertState(inp);
  // The border raised by an observed height (above what the announcements
  // alone give): say so once, when it starts or goes higher.
  const base = inp.observed && state.status === 'ok' ? A.alertState({ ...inp, observed: null }) : null;
  const raised = base && state.level > (base.level ?? 0) ? state.level : null;
  if (raised !== null && (lastObservedRaise === null || raised > lastObservedRaise)) notify(OBSERVED_FRAME_TEXT);
  lastObservedRaise = raised;
  if (!inp.demo && inp.simulated && state.status === 'ok') state = { ...state, detail: `【模擬データ】${state.detail}` };
  current = { mode, inp, state };

  const frame = $('alert-frame');
  frame.dataset.level = state.level === null ? 'unknown' : String(state.level);
  frame.dataset.blink = state.blink;
  frame.style.setProperty('--frame-color', state.color ?? 'var(--bg)');

  renderHeadline(inp, state);

  // Sub-screen 1: the current alert as text.
  $('status-mode').textContent = mode === 'live' ? '現在位置' : `デモ：${DEMOS[mode].label}`;
  // No announcement in effect: a short instruction instead of the long
  // explanation of modules/alert (it still never says "safe").
  const detail = state.status === 'ok' && state.level === 0 ? '身の安全を確保してください' : state.detail;
  $('status-text').textContent = inp.mark + [detail, inp.note].filter(Boolean).join(' ');
  $('status-line').dataset.level = frame.dataset.level;
  $('status-line').dataset.imminent = String(state.imminent);
  const shownItems = state.status === 'ok' ? state.sources : [];
  $('alert-items').replaceChildren(...(shownItems.length
    ? shownItems.map((s) => li(`${inp.mark}${s.name}（${s.area_name ?? '対象地域'}）`))
    : [li(state.status === 'ok'
      ? '身の安全を確保してください'
      : '発表を受け取れていない、または地域を選べません。警報が出ていないという意味ではありません。')]));
  if (inp.demo) {
    $('alert-received').textContent = `記録の時刻 ${recordMdHm(inp.replay.event.time) || '（模擬のため時刻なし）'}　${inp.mark}いま出ている発表ではありません。`;
  } else if (inp.received && caOkAt) {
    $('alert-received').textContent = `受信 ${formatMdHm(caOkAt)}（${minutesAgoText(caOkAt, now) ?? ''}）${inp.mark}`;
  } else {
    $('alert-received').textContent = '受信：受け取れていません。警報が出ていないという意味ではありません。';
  }

  // Everything about the demo sits in one box at the very bottom.
  const strip = $('demo-strip');
  strip.hidden = !inp.demo;
  strip.textContent = inp.demo ? `${inp.demo.banner}（デモ：${inp.demo.label}）` : '';
  if (!inp.demo && inp.simulated) $('sim-banner').hidden = false;
  const demoBox = $('demo-box');
  demoBox.hidden = !inp.demo;
  if (inp.demo) {
    $('demo-banner').hidden = true; // the strip above already says it
    $('demo-where').textContent = `位置：${inp.demo.place}`;
    $('demo-now').textContent = [recordMdHm(inp.replay.event.time), inp.replay.event.text].filter(Boolean).join('　');
    $('demo-inEffect').textContent = inp.replay.inEffect.length ? `出ている発表：${inp.replay.inEffect.join('、')}` : '出ている発表：なし（記録の上で）';
    $('demo-log').replaceChildren(...inp.replay.log.map((e) => li([recordMdHm(e.time), e.text].filter(Boolean).join('　'))).reverse());
    $('demo-step').textContent = `${inp.replay.index + 1} / ${inp.demo.events.length}${inp.replay.finished ? '（再生は終わりました）' : ''}`;
  }
  $('demo-info').hidden = !inp.demo && $('sim-banner').hidden;

  recordAndNotify(inp, state);

  // The handoff guide grows as the survival stage comes near (never switches by itself).
  const hours = elapsedHours(inp, now);
  const stage = MC.__error ? null : stageAt(hours, MC.DEFAULT_STAGES, MC.DEFAULT_STAGE_HOURS);
  const prominence = guideProminence(stage);
  const guide = $('handoff-open');
  guide.dataset.prominence = prominence;
  $('handoff-guide-note').textContent = prominence === 'high'
    ? `${inp.mark}水・食料・電源・連絡などの困りごとを、メモにまとめて相談できます。`
    : prominence === 'mid' ? `${inp.mark}落ち着いたら、困りごとを伝達メモにまとめられます。` : '';
  globalThis.__handoffSources = {
    ...(globalThis.__handoffSources ?? {}),
    mark: inp.mark,
    elapsedHours: hours,
    stageName: stage?.name ?? null,
    announcements: history.list().map((e) => historyLine(e, formatMdHm)),
  };

  tellEvacuee(inp, state);
}

// ---------------------------------------------------------------- one line above the compass

// The first line (tsunami > earthquake > other) goes above the compass and
// slides in from the right edge when it changes; the others go under it.
let lastHeadline = '';
let lines = [];
function renderHeadline(inp, state) {
  const codes = new Set([...inp.areaCodes, inp.coast?.region_code].filter(Boolean).map(String));
  const items = state.status === 'ok' ? inp.items.filter((it) => codes.has(String(it.area_code))) : [];
  lines = infoLines({ items, facts: state.status === 'ok' ? inp.facts ?? [] : [], levelOf, parseHeight });
  const top = lines[0] ?? null;
  const text = top ? top.text
    : state.status === 'ok' ? '身の安全を確保してください'
      : inp.received ? 'この地域の発表を選べません' : '公的な発表を受け取れていません';
  const time = top ? top.time : '';
  const markText = inp.demo ? (inp.demo.kind === 'record' ? '記録の再生' : '模擬') : inp.simulated ? '模擬データ' : '';
  const card = $('headline-card');
  card.dataset.cls = top ? top.cls : 'none';
  card.dataset.level = top ? String(top.level ?? 'none') : state.status === 'ok' ? '0' : 'unknown';
  $('headline-mark').hidden = !markText;
  $('headline-mark').textContent = markText;
  $('headline-time').textContent = time;
  $('headline-text').textContent = text;
  const key = `${markText}|${time}|${text}`;
  if (key !== lastHeadline) {
    lastHeadline = key;
    const h = $('headline');
    h.classList.remove('slide-in');
    void h.offsetWidth; // restart the animation
    h.classList.add('slide-in');
  }
  const rest = lines.slice(1);
  $('info-more-card').hidden = rest.length === 0;
  $('info-more').replaceChildren(...rest.map((l) => {
    const e = document.createElement('li');
    e.dataset.cls = l.cls;
    e.dataset.level = String(l.level ?? 'none');
    if (l.time) {
      const t = document.createElement('time');
      t.textContent = l.time;
      e.append(t);
    }
    e.append(l.text);
    return e;
  }));
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
  get lines() { return lines.slice(); },
  setMode,
  // jump to a step of the demo replay (index of the event)
  seekDemo(i) {
    if (mode === 'live') return;
    const d = DEMOS[mode];
    demoStart = Date.now() - i * (STEP_MS ?? d.stepMs) - 1;
    render();
  },
  showPane,
  pollCa,
  history,
};
