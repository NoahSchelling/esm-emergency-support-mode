// Browser-only wiring of the evacuee view and the evacuee/supporter switch.
// Independent of ../main.js: if the supporter view fails to load, this view
// still works. Every text is inserted with textContent, never as HTML.
//
// Privacy: the position stays in this page. The only requests are for the
// page's own files and the evacuation data file on the same site.

import { evacViewModel, parseSimParam, scenarioFromSimKey, receptionLine, arrowLabel, SHOCK_TEXT, SCENARIOS } from './model.js';

const $ = (id) => document.getElementById(id);
const SVG = 'http://www.w3.org/2000/svg';
const REFRESH_MS = 250;

// ---------------------------------------------------------------- view switch

// Default is the evacuee view. It never switches by itself.
function showView(name) {
  const evac = name !== 'support';
  $('view-evac').hidden = !evac;
  $('view-support').hidden = evac;
  $('tab-evac').setAttribute('aria-pressed', String(evac));
  $('tab-support').setAttribute('aria-pressed', String(!evac));
}
$('tab-evac').addEventListener('click', () => showView('evac'));
$('tab-support').addEventListener('click', () => showView('support'));
showView('evac');

// ---------------------------------------------------------------- modules

async function tryImport(path) {
  try {
    return await import(new URL(path, import.meta.url));
  } catch (e) {
    return { __error: String(e?.message || e) };
  }
}

const E = await tryImport('../../modules/evac/browser/load.js');
const S = await tryImport('../../modules/sensors/index.js');
const evacOk = !E.__error;
const sensorsOk = !S.__error;

let data = null;
let dataError = evacOk ? null : '方向の計算のモジュールを読み込めませんでした';
if (evacOk) {
  E.loadEvacData().then((d) => { data = d; }, (e) => { dataError = String(e?.message || e); });
}

const tracker = evacOk ? E.createHeadingTracker() : null;
// Android gives no compass accuracy: its heading is used for the arrow only
// shortly after it agreed with the GPS course.
const compassCheck = evacOk ? E.createCompassCheck() : null;
const locSensor = sensorsOk ? S.createLocationSensor({ env: S.createDeviceEnv() }) : null;
let orientation = null;

// ---------------------------------------------------------------- scenario & reception

let scenario = parseSimParam(globalThis.location?.search);
let lifted = null;
let reception = scenario ? { receivedMs: Date.now(), simulated: true } : null;
let simulated = Boolean(scenario);

// From the supporter view (../main.js): simulated public announcements.
globalThis.addEventListener('app:simulated-public', (ev) => {
  const sc = scenarioFromSimKey(ev.detail?.key);
  if (sc) {
    scenario = sc;
    lifted = null;
    reception = { receivedMs: Date.now(), simulated: true };
    simulated = true;
  }
});
// From the supporter view: a simulated lift (解除) of the announcement.
globalThis.addEventListener('app:simulated-lift', (ev) => {
  const sc = scenarioFromSimKey(ev.detail?.key);
  if (sc && scenario === sc) {
    lifted = sc;
    scenario = null;
    exclusions = [];
    reception = { receivedMs: Date.now(), simulated: true };
  }
});
// From the supporter view: the latest reception of public information.
globalThis.addEventListener('app:announcement', (ev) => {
  const d = ev.detail ?? {};
  if (Number.isFinite(d.receivedMs) && (!reception || d.receivedMs >= reception.receivedMs)) {
    reception = { receivedMs: d.receivedMs, simulated: Boolean(d.simulated) };
  }
});

// ---------------------------------------------------------------- exclusions

let exclusions = [];
let current = null; // last computeEvacDirections result

$('evac-exclude').addEventListener('click', () => {
  const c = current?.status === 'ok' ? current.value.candidates[0] : null;
  if (!evacOk || !c || c.bearing_deg === null) return;
  exclusions.push(E.createExclusion(c.bearing_deg, Date.now(), { siteId: c.id }));
  render();
});

// ---------------------------------------------------------------- start (user gesture)

$('evac-start').addEventListener('click', () => {
  // iPhone Safari: ask for the orientation permission first, directly in
  // the click handler (no await before it).
  const perm = evacOk ? E.requestOrientationPermission() : Promise.resolve('unsupported');
  if (locSensor) locSensor.start();
  perm.then((p) => {
    $('evac-perm').textContent = {
      granted: '方位の利用が許可されました。',
      not_required: '',
      denied: '方位の利用が許可されませんでした。矢印は出さず、文と北を上にした図で示します。',
      unsupported: 'この端末・ブラウザでは方位が使えません。文と北を上にした図で示します。',
      error: '方位の許可を確かめられませんでした。文と北を上にした図で示します。',
    }[p] ?? '';
    if (evacOk && !orientation && (p === 'granted' || p === 'not_required')) {
      orientation = E.startOrientation(tracker);
    }
  });
  $('evac-start').textContent = '位置と方位を使っています';
});
if (!sensorsOk) $('evac-perm').textContent = '位置のモジュールを読み込めませんでした。';

// ---------------------------------------------------------------- drawing

function svg(tag, attrs) {
  const e = document.createElementNS(SVG, tag);
  for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, String(v));
  return e;
}

// Large arrow pointing to the top of the screen, rotated by `deg`.
function drawArrow(deg) {
  const s = svg('svg', { viewBox: '-100 -100 200 200', class: 'evac-arrow-svg', role: 'img', 'aria-label': arrowLabel(deg) });
  const g = svg('g', { transform: `rotate(${deg})` });
  g.append(svg('path', { d: 'M0,-88 L46,-20 L16,-20 L16,80 L-16,80 L-16,-20 L-46,-20 Z', class: 'evac-arrow-shape' }));
  s.append(g);
  return s;
}

// North-up figure: not tied to how the device is held.
function drawNorthUp(bearing) {
  const s = svg('svg', { viewBox: '-100 -100 200 200', class: 'evac-north-svg', role: 'img', 'aria-label': `北を上にした図。避難場所は北から約 ${Math.round(bearing)} 度の方向` });
  s.append(svg('circle', { cx: 0, cy: 0, r: 80, class: 'evac-ring' }));
  for (const [t, x, y] of [['北', 0, -84], ['東', 86, 6], ['南', 0, 98], ['西', -86, 6]]) {
    const tx = svg('text', { x, y, 'text-anchor': 'middle', class: t === '北' ? 'evac-n' : 'evac-dir' });
    tx.textContent = t;
    s.append(tx);
  }
  // A dot on the dial and a dashed line, deliberately NOT an arrow: this
  // figure does not turn with the device.
  const g = svg('g', { transform: `rotate(${bearing})` });
  g.append(svg('line', { x1: 0, y1: 0, x2: 0, y2: -80, class: 'evac-bearing' }));
  g.append(svg('circle', { cx: 0, cy: -80, r: 11, class: 'evac-bearing-dot' }));
  s.append(g);
  s.append(svg('circle', { cx: 0, cy: 0, r: 4, class: 'evac-center' }));
  return s;
}

function setText(id, t) {
  const e = $(id);
  e.textContent = t;
  e.hidden = !t;
}

function render() {
  const now = Date.now();
  const loc = locSensor ? locSensor.read() : null;
  current = null;
  if (scenario && data && loc?.status === 'ok') {
    const v = loc.value;
    const heading = tracker.read({
      nowMs: now,
      screenAngleDeg: E.currentScreenAngle(),
      declinationWestDeg: E.declinationWestDeg(v.latitude, v.longitude),
    });
    const fixAt = Date.parse(loc.observed_at);
    const course = { heading_deg: v.heading_deg, speed_mps: v.speed_mps, at_ms: fixAt };
    compassCheck.update(heading, E.courseFrom(course, now), now);
    current = E.computeEvacDirections(data, {
      latitude: v.latitude,
      longitude: v.longitude,
      accuracy: v.accuracy_m,
      hazard: SCENARIOS[scenario].hazard,
      heading,
      course,
      position_at_ms: fixAt,
      compass_confirmed_at_ms: compassCheck.confirmedAtMs,
      exclusions,
      ...(simulated || loc.source === 'simulated' ? { source: 'simulated' } : {}),
    }, { now });
  }
  exclusions = evacOk ? E.activeExclusions(exclusions, now) : [];
  const m = evacViewModel({ scenario, lifted, location: loc, dataError, result: current, nowMs: now });

  $('view-evac').dataset.mode = m.mode;
  setText('evac-instruction', m.instruction);
  setText('evac-instruction-origin', m.instructionOrigin);
  setText('evac-message', m.message);

  const fig = $('evac-figure');
  if (m.mode === 'arrow') {
    fig.replaceChildren(drawArrow(m.arrowDeg));
    fig.dataset.kind = 'arrow';
    fig.dataset.deg = String(m.arrowDeg);
  } else if (m.mode === 'text' && m.northUpBearing !== null) {
    fig.replaceChildren(drawNorthUp(m.northUpBearing));
    fig.dataset.kind = 'north-up';
    fig.dataset.deg = String(m.northUpBearing);
  } else {
    fig.replaceChildren();
    fig.dataset.kind = 'none';
    delete fig.dataset.deg;
  }
  setText('evac-figure-caption', m.mode === 'text' && m.northUpBearing !== null ? '北を上にした図です。端末の向きとは関係ありません。' : '');
  setText('evac-arrow-reason', m.arrowReason);

  const p = m.primary;
  setText('evac-name', p ? p.name : '');
  setText('evac-muni', p ? p.municipality : '');
  setText('evac-distance', p ? p.distance : '');
  setText('evac-direction', p ? p.direction : '');
  setText('evac-hazards', p ? p.hazards : '');
  setText('evac-remarks', p ? p.remarks : '');
  setText('evac-course', [m.courseText, p?.courseRel].filter(Boolean).join(' '));
  setText('evac-position-age', m.positionAgeText);

  $('evac-exclude').disabled = !m.canExclude;
  const ex = $('evac-exclusions');
  ex.replaceChildren(...m.exclusions.map((x) => {
    const li = document.createElement('li');
    li.append(`除外中：${x.text} `);
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'evac-undo';
    b.textContent = '取り消す';
    b.addEventListener('click', () => {
      exclusions = exclusions.filter((e) => !(e.until_ms === x.until_ms && e.center_deg === x.center_deg));
      render();
    });
    li.append(b);
    return li;
  }));
  $('evac-exclusions-wrap').hidden = m.exclusions.length === 0;

  const others = $('evac-others');
  others.replaceChildren(...m.others.map((t) => {
    const li = document.createElement('li');
    li.textContent = t;
    return li;
  }));
  $('evac-others-wrap').hidden = m.others.length === 0;

  $('evac-fallback').hidden = !m.showFallback;
  $('evac-reception').textContent = receptionLine(reception, now);
  if (simulated) $('sim-banner').hidden = false;
}

// ---------------------------------------------------------------- static parts

function fillStatic() {
  // Fallback links (public first; private ones say they are not official).
  if (evacOk) {
    $('evac-fallback-list').replaceChildren(...E.FALLBACK_LINKS.map((l) => {
      const li = document.createElement('li');
      const a = document.createElement('a');
      a.href = l.url;
      a.rel = 'noopener noreferrer';
      a.target = '_blank';
      a.textContent = l.label;
      li.append(a, `（${l.kind === 'public' ? '公的' : '民間'}）${l.note}`);
      return li;
    }));
  }
  $('evac-shock-text').textContent = SHOCK_TEXT;
}

function fillDataNotes() {
  if (!data) return false;
  $('evac-data-updated').textContent = `データ：国土地理院の更新日 ${data.source.gsi_updated}（取得 ${data.source.retrieved}）`;
  $('evac-notices').replaceChildren(...data.notices.slice(0, 3).map((t) => {
    const li = document.createElement('li');
    li.textContent = t;
    return li;
  }));
  $('evac-coverage').textContent = data.coverage_note;
  $('evac-attribution').textContent = `${data.attribution}。${data.processed}。`;
  return true;
}

fillStatic();
let notesFilled = false;
render();
setInterval(() => {
  if (!notesFilled) notesFilled = fillDataNotes();
  render();
}, REFRESH_MS);

// For automated browser checks only.
globalThis.__evac = {
  get result() { return current; },
  get scenario() { return scenario; },
  get exclusions() { return exclusions; },
  get tracker() { return tracker; },
  showShockSlot(show) { $('evac-shock').hidden = !show; }, // placeholder: detection comes later
  render,
};
