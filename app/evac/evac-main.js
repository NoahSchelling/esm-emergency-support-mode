// Browser-only wiring of the evacuee view and the evacuee/supporter switch.
// Independent of ../main.js: if the supporter view fails to load, this view
// still works. Every text is inserted with textContent, never as HTML.
//
// Privacy: the position stays in this page. The only requests are for the
// page's own files and the evacuation data file on the same site.

import { evacViewModel, parseSimParam, scenarioFromSimKey, receptionLine, arrowLabel, facingText, SHOCK_TEXT, SCENARIOS } from './model.js';
import { heightsView, mapSiteUrl, elevationShort, ELEVATION_SOURCE } from '../shell/heights.js';

const $ = (id) => document.getElementById(id);
const SVG = 'http://www.w3.org/2000/svg';
// The whole view is redrawn once a second. The compass alone follows the
// heading more often (LIVE_MS), each turn with a 0.3 s ease (app.css).
const REFRESH_MS = 1000;
const LIVE_MS = 100;
// ！！仮の値！！ While the phone is being turned, tracker.read() refuses for
// about a second (the samples spread out), and again for about a second
// after it stops. For up to this long after the last accepted reading, the
// latest sample of the same sensor is used, so the figure does not flip to
// north-up and back in the middle of a turn (the live loop turns it with the
// same sample). A turn that lasts longer still gives the north-up figure.
const TURN_HOLD_MS = 4000;
// ！！仮の値！！ The hold needs a sample this recent: when the sensor stops
// sending, the figure falls back as before.
const FRESH_SAMPLE_MS = 500;

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
let lastStableHeading = null; // { heading, atMs }: last reading tracker.read() accepted

$('evac-exclude').addEventListener('click', () => {
  const c = current?.status === 'ok' ? current.value.candidates[0] : null;
  if (!evacOk || !c || c.bearing_deg === null) return;
  exclusions.push(E.createExclusion(c.bearing_deg, Date.now(), { siteId: c.id }));
  render();
});

// ---------------------------------------------------------------- start (user gesture)

// A toggle switch: ON starts the position and the orientation, OFF stops them.
$('evac-start').addEventListener('change', () => {
  if (!$('evac-start').checked) {
    if (locSensor) locSensor.stop();
    if (orientation) orientation.stop();
    orientation = null;
    $('evac-perm').textContent = '位置と方位を使うのをやめました。';
    render();
    return;
  }
  // iPhone Safari: ask for the orientation permission first, directly in
  // the event handler of the tap (no await before it).
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
    if (evacOk && !orientation && $('evac-start').checked && (p === 'granted' || p === 'not_required')) {
      orientation = E.startOrientation(tracker);
    }
  });
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
  // Directions marked as blocked: a cross on the rim (turns with the dial).
  const exclG = svg('g', { class: 'c-excls' });
  dial.append(exclG);
  let exclMarks = [];
  let exclKey = '';
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
  // Heading up: the fixed upward triangle (black, plain) = the direction the
  // device faces.
  const up = svg('g', { class: 'c-up' });
  up.append(svg('path', { d: 'M0,-46 L28,4 L-28,4 Z', class: 'evac-arrow-shape' }));
  s.append(up);
  s.append(svg('circle', { cx: 0, cy: 0, r: 5, class: 'evac-center' }));
  const st = { dial: null, dot: null, rim: null, target: null };
  const turn = (el, key, deg) => {
    st[key] = nearAngle(st[key], deg);
    el.style.transform = `rotate(${st[key]}deg)`;
  };
  const turnDial = (deg) => {
    turn(dial, 'dial', deg);
    // Labels and crosses stay upright whichever way the dial turns.
    for (const [tx, a] of labels) tx.style.transform = `rotate(${-(st.dial + a)}deg)`;
    for (const [x, a] of exclMarks) x.style.transform = `rotate(${-(st.dial + a)}deg)`;
  };
  const turnTarget = (deg) => {
    turn(target, 'target', deg);
    flag.style.transform = `rotate(${-st.target}deg)`;
  };
  return {
    el: s,
    // Follow the heading between full redraws (heading up only).
    live({ dialDeg, arrowDeg }) {
      turnDial(dialDeg);
      if (Number.isFinite(arrowDeg)) turnTarget(arrowDeg);
    },
    // list: [{ center_deg, until_ms }] (true bearings of the blocked directions)
    setExclusions(list) {
      const key = list.map((x) => `${x.center_deg}|${x.until_ms}`).join(',');
      if (key === exclKey) return;
      exclKey = key;
      const groups = [];
      exclMarks = list.map((x) => {
        const g = svg('g', { transform: `rotate(${x.center_deg})` });
        const mark = svg('g', { class: 'c-excl-mark' });
        mark.style.transformBox = 'fill-box';
        mark.style.transformOrigin = 'center';
        for (const cls of ['c-excl', 'c-excl-x']) {
          mark.append(svg('line', { x1: -9, y1: -109, x2: 9, y2: -91, class: cls }));
          mark.append(svg('line', { x1: 9, y1: -109, x2: -9, y2: -91, class: cls }));
        }
        g.append(mark);
        groups.push(g);
        return [mark, x.center_deg];
      });
      exclG.replaceChildren(...groups);
      s.dataset.exclusions = String(list.length);
      turnDial(st.dial ?? 0);
    },
    // view: { kind: 'arrow' | 'north-up' | 'none', headingUp, dialDeg, targetDeg, arrowDeg, facingDeg, label }
    set(v) {
      turnDial(v.dialDeg);
      flag.style.transform = `rotate(${-(st.target ?? 0)}deg)`;
      dot.style.display = v.kind === 'north-up' ? '' : 'none';
      if (v.kind === 'north-up') turn(dot, 'dot', v.targetDeg);
      target.style.display = v.kind === 'arrow' ? '' : 'none';
      if (v.kind === 'arrow') turnTarget(v.arrowDeg);
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
  const headingCtx = {
    nowMs: now,
    screenAngleDeg: E.currentScreenAngle(),
    declinationWestDeg: E.declinationWestDeg(here.latitude, here.longitude),
  };
  let heading = tracker ? tracker.read(headingCtx) : null;
  if (heading?.status === 'ok') lastStableHeading = { heading, atMs: now };
  else if (lastStableHeading && now - lastStableHeading.atMs <= TURN_HOLD_MS) {
    // Only the stability check failed (the same sensor still gives fresh
    // values): the phone is being turned. Use its latest value.
    const latest = tracker.latest(headingCtx);
    if (latest?.status === 'ok' && latest.value.basis === lastStableHeading.heading.value.basis
      && now - latest.value.at_ms <= FRESH_SAMPLE_MS) heading = latest;
  }
  if (hazard && data && loc?.status === 'ok' && !(ctx && ctx.hasEvacData === false)) {
    const v = loc.value;
    const fixAt = Date.parse(loc.observed_at);
    // The compass is checked against the GPS course of the device itself.
    // In a demo the position is the demo's fixed point, but the course of
    // the real device (when the sensors are on) still checks the compass.
    const real = ctx?.position && locSensor ? locSensor.read() : null;
    const course = real?.status === 'ok'
      ? { heading_deg: real.value.heading_deg, speed_mps: real.value.speed_mps, at_ms: Date.parse(real.observed_at) }
      : { heading_deg: v.heading_deg, speed_mps: v.speed_mps, at_ms: fixAt };
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
    }, {
      now,
      // In a demo the position is a fixed demo point, so the arrow never
      // leads anyone anywhere; a heading without an accuracy value (Android)
      // is not checked against walking there. Real use keeps the check.
      ...(ctx?.position ? { requireConfirmationWhenAccuracyUnknown: false } : {}),
    });
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
  // What the compass may follow between redraws: only what this redraw
  // accepted (heading up). A north-up figure never turns.
  liveView = null;
  if (m.mode === 'arrow') {
    const c0 = current?.status === 'ok' ? current.value.candidates[0] : null;
    liveView = c0 && Number.isFinite(c0.bearing_deg) ? { kind: 'arrow', bearing: c0.bearing_deg } : null;
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
    if (headingUp) liveView = { kind: 'none' };
    compass.set({ kind: 'none', headingUp, dialDeg: headingUp ? -facing : 0, facingDeg: facing,
      label: headingUp ? `上の矢印が向いている方角（${facingText(facing)}）` : '北を上にした方位の図。向いている方角が分かりません' });
    fig.dataset.kind = 'none';
    delete fig.dataset.deg;
  }
  $('facing').textContent = Number.isFinite(facing) ? facingText(facing) : orientation ? '分かりません' : '—';
  // Visible, not folded: the north-up figure is on purpose, not an old screen.
  const northUp = m.mode === 'text' && m.northUpBearing !== null;
  setText('compass-state', northUp
    ? `北が上の図です（方位を確かめられないため）。${/GPS の進行方向/.test(m.arrowReason ?? '') ? 'スマートフォンの上を進む方向に向けて少し歩くと、回る図に戻ります。' : ''}`
    : '');
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
  renderExclusions(now);

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

// ---------------------------------------------------------------- blocked directions

const hhmm = (ms) => {
  const t = new Date(ms + 9 * 3600 * 1000);
  return `${String(t.getUTCHours()).padStart(2, '0')}:${String(t.getUTCMinutes()).padStart(2, '0')}`;
};

// "▶現在通れない方向": time, direction, cancel. Each one is cancelled by
// itself after 10 minutes (modules/evac EXCLUSION_DEFAULTS).
function renderExclusions(now) {
  const list = evacOk ? E.activeExclusions(exclusions, now) : [];
  compass.setExclusions(list);
  const key = list.map((x) => `${x.center_deg}|${x.until_ms}`).join(',');
  const ul = $('evac-exclusions');
  if (ul.dataset.key === key && ul.childElementCount) return;
  ul.dataset.key = key;
  $('evac-exclusions-summary').textContent = list.length ? `現在通れない方向（${list.length}）` : '現在通れない方向';
  if (!list.length) {
    const li = document.createElement('li');
    li.className = 'excl-empty';
    li.textContent = 'ありません。';
    ul.replaceChildren(li);
    return;
  }
  ul.replaceChildren(...list.map((x) => {
    const li = document.createElement('li');
    const t = document.createElement('time');
    t.textContent = hhmm(x.created_ms);
    const d = document.createElement('span');
    d.textContent = E.compassName(x.center_deg);
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'evac-undo';
    b.textContent = '取り消し';
    b.setAttribute('aria-label', `${hhmm(x.created_ms)} ${E.compassName(x.center_deg)} を取り消し`);
    b.addEventListener('click', () => {
      exclusions = exclusions.filter((e) => e !== x);
      render();
    });
    li.append(t, d, b);
    return li;
  }));
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
  // The note only while tsunami information is shown.
  $('heights-note').hidden = !ctx?.tsunamiInfo;
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
  const url = mapSiteUrl(coords);
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
      li.append(a); // site name and link only; private sites say so
      if (l.kind === 'private') li.append('（民間）');
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

// ---------------------------------------------------------------- the compass between redraws

// Heading up only: the dial and the target follow the latest heading every
// LIVE_MS. Nothing is sent anywhere; this only reads the device sensors.
// tracker.latest() skips the 1 s stability check of tracker.read(): the
// figure follows the phone as it turns. Whether the figure is heading up at
// all is still decided by render() once a second with tracker.read().
let liveView = null;
let lastLive = 0;
function liveTick(t) {
  requestAnimationFrame(liveTick);
  if (!liveView || !orientation || !tracker || t - lastLive < LIVE_MS) return;
  lastLive = t;
  const loc = locSensor ? locSensor.read() : null;
  const here = context?.position ?? (loc?.status === 'ok' ? loc.value : { latitude: 36, longitude: 138 });
  const h = tracker.latest({
    nowMs: Date.now(),
    screenAngleDeg: E.currentScreenAngle(),
    declinationWestDeg: E.declinationWestDeg(here.latitude, here.longitude),
  });
  if (h?.status !== 'ok') return;
  const facing = h.value.true_heading_deg;
  const arrowDeg = liveView.kind === 'arrow' ? E.screenArrowDeg(liveView.bearing, h.value) : null;
  if (liveView.kind === 'arrow' && !Number.isFinite(arrowDeg)) return;
  compass.live({ dialDeg: -facing, arrowDeg });
  $('facing').textContent = facingText(facing);
}
if (typeof requestAnimationFrame === 'function') requestAnimationFrame(liveTick);

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
