// Browser-only wiring of the evacuee view and the evacuee/supporter switch.
// Independent of ../main.js: if the supporter view fails to load, this view
// still works. Every text is inserted with textContent, never as HTML.
//
// Privacy: the position stays in this page. The only requests are for the
// page's own files and the evacuation data file on the same site.

import { evacViewModel, parseSimParam, scenarioFromSimKey, receptionLine, arrowLabel, facingText, SHOCK_TEXT, SCENARIOS } from './model.js';
import { heightsView, mapRouteUrl, elevationShort, ELEVATION_SOURCE } from '../shell/heights.js';

const $ = (id) => document.getElementById(id);
const SVG = 'http://www.w3.org/2000/svg';
// The compass (the direction the device faces) is redrawn once a second.
const REFRESH_MS = 1000;

// ---------------------------------------------------------------- view switch

// Default is the evacuee view. It never switches by itself. Two radio
// buttons in the menu; the choice applies at once.
function showView(name) {
  const evac = name !== 'support';
  $('view-evac').hidden = !evac;
  $('view-support').hidden = evac;
  $('tab-evac').checked = evac;
  $('tab-support').checked = !evac;
}
$('tab-evac').addEventListener('change', () => { if ($('tab-evac').checked) showView('evac'); });
$('tab-support').addEventListener('change', () => { if ($('tab-support').checked) showView('support'); });
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
const LK = await tryImport('../shell/lookup.js');
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

// From the shell (../shell/shell-main.js): current-location mode or a demo.
// It decides the hazard (only from an official or replayed/simulated
// tsunami warning) and, in demos, the fixed position.
let context = null;
function takeContext(d) {
  const prevHazard = context?.def?.hazard ?? null;
  context = d;
  if ((d?.def?.hazard ?? null) !== prevHazard) exclusions = [];
  if (d && Number.isFinite(d.receivedMs)) reception = { receivedMs: d.receivedMs, simulated: Boolean(d.simulated), label: d.label };
  simulated = Boolean(scenario) || Boolean(d?.simulated);
}
globalThis.addEventListener('app:context', (ev) => takeContext(ev.detail ?? null));

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
// A context sent before this module finished loading.
if (globalThis.__appContext) takeContext(globalThis.__appContext);
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

// ---------------------------------------------------------------- compass
//
// One figure, built once and kept in place (it never moves when texts
// change). Heading up: a large upward arrow, fixed, is the direction the
// device faces; the dial (north, east, south, west) and the evacuation
// target turn around it.
// - heading up with a target (the module accepted the heading): the dial
//   turns so that the top of the screen is the direction faced, and the
//   target mark sits on the rim in the target's direction on the screen.
// - heading up without a target: a compass (the dial turns).
// - a target without an accepted heading: heading up would draw the target
//   from a heading we could not check, so the dial stays north-up, the
//   target is a dot with a dashed line and there is no upward arrow (the
//   arrow would claim a direction faced). The direction faced, if known, is
//   an outlined mark on the rim.
// - no heading and no target: a north-up dial.

// Angles accumulate so that a turn from 359° to 1° goes the short way.
function nearAngle(prev, next) {
  if (!Number.isFinite(prev)) return next;
  const delta = ((((next - prev) % 360) + 540) % 360) - 180;
  return prev + delta;
}

const compass = (() => {
  const s = svg('svg', { viewBox: '-120 -120 240 240', class: 'compass-svg', role: 'img', 'aria-label': '方位の図' });
  const dial = svg('g', { class: 'c-dial' });
  dial.append(svg('circle', { cx: 0, cy: 0, r: 100, class: 'c-face' }));
  for (let a = 0; a < 360; a += 30) {
    const major = a % 90 === 0;
    dial.append(svg('line', { x1: 0, y1: -100, x2: 0, y2: major ? -86 : -92, class: major ? 'c-tick c-tick-major' : 'c-tick', transform: `rotate(${a})` }));
  }
  // Labels stay upright whichever way the dial turns.
  const labels = [];
  for (const [label, a] of [['北', 0], ['東', 90], ['南', 180], ['西', 270]]) {
    const g = svg('g', { transform: `rotate(${a})` });
    const tx = svg('text', { x: 0, y: -70, 'text-anchor': 'middle', 'dominant-baseline': 'central', class: label === '北' ? 'c-n c-label' : 'c-dir c-label' });
    tx.textContent = label;
    g.append(tx);
    dial.append(g);
    labels.push([tx, a]);
  }
  // North-up figure: the target as a dot with a dashed line (never an arrow).
  const dot = svg('g', { class: 'c-target' });
  dot.append(svg('line', { x1: 0, y1: 0, x2: 0, y2: -100, class: 'evac-bearing' }));
  dot.append(svg('circle', { cx: 0, cy: -100, r: 12, class: 'evac-bearing-dot' }));
  dial.append(dot);
  // North-up figure: the direction faced, an outlined mark on the rim.
  const facingRim = svg('path', { d: 'M0,-118 L10,-104 L-10,-104 Z', class: 'c-facing-unconfirmed' });
  dial.append(facingRim);
  s.append(dial);
  // Heading up: the target on the rim, in its direction on the screen.
  const target = svg('g', { class: 'c-target-up' });
  target.append(svg('line', { x1: 0, y1: -30, x2: 0, y2: -92, class: 'c-target-line' }));
  target.append(svg('circle', { cx: 0, cy: -102, r: 15, class: 'evac-bearing-dot c-target-dot' }));
  const flag = svg('text', { x: 0, y: -102, 'text-anchor': 'middle', 'dominant-baseline': 'central', class: 'c-target-label' });
  flag.textContent = '避';
  target.append(flag);
  s.append(target);
  // Heading up: the fixed upward arrow = the direction the device faces.
  const up = svg('g', { class: 'c-up' });
  up.append(svg('path', { d: 'M0,-58 L26,-14 L9,-14 L9,40 L-9,40 L-9,-14 L-26,-14 Z', class: 'evac-arrow-shape' }));
  s.append(up);
  s.append(svg('circle', { cx: 0, cy: 0, r: 5, class: 'evac-center' }));
  const st = { dial: null, dot: null, rim: null, target: null };
  const turn = (el, key, deg) => {
    st[key] = nearAngle(st[key], deg);
    el.style.transform = `rotate(${st[key]}deg)`;
  };
  return {
    el: s,
    // view: { kind: 'arrow' | 'north-up' | 'none', headingUp, dialDeg, targetDeg, arrowDeg, facingDeg, label }
    set(v) {
      turn(dial, 'dial', v.dialDeg);
      for (const [tx, a] of labels) tx.style.transform = `rotate(${-(st.dial + a)}deg)`;
      flag.style.transform = `rotate(${-(st.target ?? 0)}deg)`;
      dot.style.display = v.kind === 'north-up' ? '' : 'none';
      if (v.kind === 'north-up') turn(dot, 'dot', v.targetDeg);
      target.style.display = v.kind === 'arrow' ? '' : 'none';
      if (v.kind === 'arrow') {
        turn(target, 'target', v.arrowDeg);
        flag.style.transform = `rotate(${-st.target}deg)`;
      }
      up.style.display = v.headingUp ? '' : 'none';
      const rim = !v.headingUp && Number.isFinite(v.facingDeg);
      facingRim.style.display = rim ? '' : 'none';
      if (rim) turn(facingRim, 'rim', v.facingDeg);
      s.dataset.orientation = v.headingUp ? 'heading-up' : 'north-up';
      s.setAttribute('aria-label', v.label);
    },
  };
})();
$('evac-figure').replaceChildren(compass.el);

function setText(id, t) {
  const e = $(id);
  e.textContent = t;
  e.hidden = !t;
}

function render() {
  const now = Date.now();
  // A live context without an official hazard does not hide the built-in
  // simulated scenario (?sim= or the supporter view's simulated buttons).
  const ctx = context && (context.mode !== 'live' || context.def || !scenario) ? context : null;
  // In a demo the position is the demo's fixed point (marked simulated).
  const loc = ctx?.position
    ? { status: 'ok', source: 'simulated', observed_at: new Date(now).toISOString(), detail: '',
      value: { latitude: ctx.position.latitude, longitude: ctx.position.longitude, accuracy_m: ctx.position.accuracy, heading_deg: null, speed_mps: null } }
    : locSensor ? locSensor.read() : null;
  current = null;
  const hazard = ctx ? ctx.def?.hazard ?? null : scenario ? SCENARIOS[scenario].hazard : null;
  // The direction the device faces. Without a position, the magnetic
  // declination of central Japan is used for this readout only.
  const here = loc?.status === 'ok' ? loc.value : { latitude: 36, longitude: 138 };
  const heading = tracker ? tracker.read({
    nowMs: now,
    screenAngleDeg: E.currentScreenAngle(),
    declinationWestDeg: E.declinationWestDeg(here.latitude, here.longitude),
  }) : null;
  if (hazard && data && loc?.status === 'ok' && !(ctx && ctx.hasEvacData === false)) {
    const v = loc.value;
    const fixAt = Date.parse(loc.observed_at);
    const course = { heading_deg: v.heading_deg, speed_mps: v.speed_mps, at_ms: fixAt };
    compassCheck.update(heading, E.courseFrom(course, now), now);
    current = E.computeEvacDirections(data, {
      latitude: v.latitude,
      longitude: v.longitude,
      accuracy: v.accuracy_m,
      hazard,
      heading,
      course,
      position_at_ms: fixAt,
      compass_confirmed_at_ms: compassCheck.confirmedAtMs,
      exclusions,
      ...(simulated || loc.source === 'simulated' ? { source: 'simulated' } : {}),
    }, { now });
  }
  exclusions = evacOk ? E.activeExclusions(exclusions, now) : [];
  const m = evacViewModel({ scenario, lifted, context: ctx, location: loc, dataError, result: current, nowMs: now });

  $('view-evac').dataset.mode = m.mode;
  // The line above the compass (from the shell) carries the announcement;
  // the quoted instruction is shown only for the built-in simulation.
  setText('evac-instruction', ctx ? '' : m.instruction);
  setText('evac-instruction-origin', m.instructionOrigin);
  setText('evac-message', m.message);

  const fig = $('evac-figure');
  const resultFacing = current?.status === 'ok' ? current.value.heading.true_heading_deg : null;
  const facing = Number.isFinite(resultFacing) ? resultFacing
    : heading?.status === 'ok' ? heading.value.true_heading_deg : null;
  if (m.mode === 'arrow') {
    compass.set({ kind: 'arrow', headingUp: true, dialDeg: -facing, arrowDeg: m.arrowDeg, facingDeg: facing,
      label: `上の矢印が向いている方角（${facingText(facing)}）。避難場所は${arrowLabel(m.arrowDeg)}` });
    fig.dataset.kind = 'arrow';
    fig.dataset.deg = String(m.arrowDeg);
  } else if (m.mode === 'text' && m.northUpBearing !== null) {
    compass.set({ kind: 'north-up', headingUp: false, dialDeg: 0, targetDeg: m.northUpBearing, facingDeg: facing,
      label: `北を上にした図。避難場所は北から約 ${Math.round(m.northUpBearing)} 度の方向` });
    fig.dataset.kind = 'north-up';
    fig.dataset.deg = String(m.northUpBearing);
  } else {
    const headingUp = Number.isFinite(facing);
    compass.set({ kind: 'none', headingUp, dialDeg: headingUp ? -facing : 0, facingDeg: facing,
      label: headingUp ? `上の矢印が向いている方角（${facingText(facing)}）` : '北を上にした方位の図。向いている方角が分かりません' });
    fig.dataset.kind = 'none';
    delete fig.dataset.deg;
  }
  $('facing').textContent = Number.isFinite(facing) ? facingText(facing) : orientation ? '分かりません' : '—';
  setText('evac-figure-caption', m.mode === 'text' && m.northUpBearing !== null ? '避難目標が出ているときに向きを確かめられないと、北を上にした図にします（点と点線が避難場所の方向です）。' : '');
  setText('evac-arrow-reason', m.arrowReason);

  const p = m.primary;
  setText('evac-name', p ? p.name : '');
  setText('evac-muni', p ? p.municipality : '');
  $('evac-none').hidden = Boolean(p);
  $('evac-straight').hidden = !p;
  $('evac-direction-lead').hidden = !p;
  // Short under the compass ("北北西"); the whole sentence is in the fold.
  setText('evac-distance', p ? p.distance.replace(/^直線で/, '') : '');
  setText('evac-direction', p ? (/（([^）]+)）/.exec(p.direction)?.[1] ?? p.direction) : '');
  setText('evac-direction-full', p ? `${p.distance}。${p.direction}` : '');
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
  $('evac-others-summary').textContent = `ほかの候補（${m.others.length} か所）`;

  $('evac-fallback').hidden = !m.showFallback;
  $('evac-reception').textContent = receptionLine(reception, now);
  if (simulated) {
    $('sim-banner').hidden = false;
    $('demo-info').hidden = false;
  }
  renderHeights(m);
}

// ---------------------------------------------------------------- heights and map link

// Elevation of designated sites: their coordinates are public, so they are
// looked up without the consent (the person's position is not sent).
const siteElevations = new Map();
function siteElevation(id, coords) {
  if (!coords || LK.__error) return { status: 'unavailable' };
  if (!siteElevations.has(id)) {
    siteElevations.set(id, { status: 'loading' });
    LK.fetchElevation(coords.latitude, coords.longitude).then((r) => { siteElevations.set(id, r); });
  }
  return siteElevations.get(id);
}

function renderHeights(m) {
  const c = current?.status === 'ok' ? current.value.candidates[0] : null;
  const coords = c && evacOk && data ? E.siteCoordinates(data, c.id) : null;
  const site = c ? siteElevation(c.id, coords) : null;
  const ctx = context;
  const view = heightsView({
    forecast: ctx?.forecast ?? null,
    observed: ctx?.observed ?? null,
    here: ctx?.here ?? { status: 'none' },
    site,
    siteName: c?.name ?? '',
    mark: ctx?.mark ?? '',
    received: ctx ? ctx.received !== false : false,
  });
  // Always under the compass: the elevation here, short.
  const hereRow = view.rows.find((r) => r.key === 'here');
  $('here-elev').textContent = elevationShort(ctx?.here ?? { status: 'none' });
  $('here-warn').hidden = !hereRow?.warn;
  $('here-warn').textContent = hereRow?.warn ? `⚠️${hereRow.warnText}` : '';
  const dl = $('heights-rows');
  dl.replaceChildren(...view.rows.flatMap((r) => {
    const dt = document.createElement('dt');
    dt.textContent = r.label;
    const dd = document.createElement('dd');
    dd.dataset.key = r.key;
    dd.dataset.warn = String(r.warn);
    dd.append(r.text);
    if (r.warn) {
      const w = document.createElement('span');
      w.className = 'warn';
      w.textContent = `⚠️${r.warnText}`;
      dd.append(w);
    }
    return [dt, dd];
  }));
  const srcs = [ELEVATION_SOURCE];
  if (view.siteNote) srcs.push(view.siteNote.replace(/。$/, ''));
  if (ctx?.here?.status === 'ok' && ctx.here.source) srcs.push(`いる場所：${ctx.here.source}`);
  srcs.push('予想・観測された津波の高さ：気象庁の発表（デモでは記録・模擬の値）。⚠️は予想と実測の高いほうと比べています');
  $('heights-source').textContent = `${srcs.join('。')}。`;
  const url = mapRouteUrl(coords);
  $('evac-map-wrap').hidden = !url || m.mode === 'message';
  if (url) $('evac-map-link').href = url;
  globalThis.__handoffSources = {
    ...(globalThis.__handoffSources ?? {}),
    site: m.primary ? { name: m.primary.name, municipality: m.primary.municipality, distance: m.primary.distance } : null,
    heights: view.rows.map((r) => ({ label: r.label, text: r.text, warnText: r.warnText })),
    terrainNote: view.note,
  };
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
      li.append(a); // site name and link only
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
