// Mode state machine: (previous state, event) -> new state.
// Inputs are only public announcements and user requests (plus the passage
// of time). The module never estimates danger by itself (BW-S1), never
// reports "safe" (BW-S3) and returns stage names only (BW-S4).
// Pure ES module: loads in browsers and in Node.js.

import { createConfig, PROVISIONAL_NOTE } from "./config.js";
import { MODES, MODE_LABELS, MODE_RANK, classify } from "./categories.js";

export const STATE_VERSION = 1;
const KIND = "mode";
const HOUR_MS = 3600 * 1000;

const NOT_SAFE_NOTE = "平常は「新しい公的発表を受けていない」状態で、安全という意味ではありません。";
const END_NOT_SAFE_NOTE = "解除・取消は「安全」という意味ではありません。";

const USER_REQUESTS = Object.freeze({
  no_emergency: "緊急にしない",
  set_elevated: "警戒高めにして",
  set_normal: "平常に戻して",
  set_emergency: "緊急にして",
});

let defaultConfig = null;
function getDefaultConfig() {
  if (defaultConfig === null) defaultConfig = createConfig();
  return defaultConfig;
}

const ISO_TZ = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:\d{2})$/;

/** True when value is an ISO 8601 date-time string with a time zone. */
export function isIsoWithZone(value) {
  if (typeof value !== "string" || !ISO_TZ.test(value) || Number.isNaN(Date.parse(value))) return false;
  // Reject dates that Date.parse silently rolls over (e.g. February 30).
  const [y, mo, d] = value.slice(0, 10).split("-").map(Number);
  const hh = Number(value.slice(11, 13));
  const mm = Number(value.slice(14, 16));
  const cal = new Date(Date.UTC(y, mo - 1, d));
  return (
    cal.getUTCFullYear() === y && cal.getUTCMonth() === mo - 1 && cal.getUTCDate() === d && hh < 24 && mm < 60
  );
}

/**
 * Initial state: normal mode with no active announcements.
 * Normal does not mean safe (BW-S3).
 * @param {string} at ISO 8601 with time zone
 */
export function initialState(at) {
  if (!isIsoWithZone(at)) {
    throw new TypeError("initialState needs an ISO 8601 time with a time zone");
  }
  return Object.freeze({
    version: STATE_VERSION,
    mode: MODES.NORMAL,
    stage: null,
    emergency_started_at: null,
    emergency_by: null,
    active: Object.freeze([]),
    updated_at: at,
  });
}

function validateState(s, config) {
  if (s === null || typeof s !== "object") return "前の状態がありません。";
  if (s.version !== STATE_VERSION) return "前の状態の版が違います。";
  if (!Object.hasOwn(MODE_RANK, s.mode)) return "前の状態のモードが不正です。";
  if (!Array.isArray(s.active)) return "前の状態の発表の一覧が不正です。";
  if (!isIsoWithZone(s.updated_at)) return "前の状態の時刻が不正です。";
  for (const a of s.active) {
    if (
      a === null ||
      typeof a !== "object" ||
      typeof a.id !== "string" ||
      a.id.length === 0 ||
      typeof a.label !== "string" ||
      !["strong", "weak", "none"].includes(a.strength) ||
      typeof a.floor !== "boolean" ||
      (a.floor_until !== null && !isIsoWithZone(a.floor_until)) ||
      !isIsoWithZone(a.received_at)
    ) {
      return "前の状態の発表の一覧に、不正な項目があります。";
    }
  }
  if (![null, "public", "user"].includes(s.emergency_by)) return "前の状態の緊急の原因が不正です。";
  if (s.mode === MODES.EMERGENCY) {
    if (!Number.isInteger(s.stage) || s.stage < 1 || s.stage > config.stages.length) {
      return "前の状態の段階が、設定の段階の数と合いません。";
    }
    if (!isIsoWithZone(s.emergency_started_at)) return "前の状態の緊急の開始時刻が不正です。";
  } else if (s.stage !== null) {
    return "緊急でないのに段階が入っています。";
  }
  return null;
}

function laterOf(a, b) {
  return Date.parse(a) >= Date.parse(b) ? a : b;
}

function snap(s) {
  return { mode: s.mode, stage: s.stage };
}

function freezeState(s) {
  return Object.freeze({ ...s, active: Object.freeze(s.active.map((a) => Object.freeze({ ...a }))) });
}

function floorEntries(s) {
  return s.active.filter((a) => a.floor);
}

function stageLabel(config, stage) {
  return stage === null ? null : config.stages[stage - 1];
}

function describe(s, config) {
  const m = MODE_LABELS[s.mode];
  if (s.mode === MODES.EMERGENCY) {
    return `${m}（段階 ${s.stage}/${config.stages.length}「${stageLabel(config, s.stage)}」）`;
  }
  return m;
}

function view(s, config, changed) {
  const floors = floorEntries(s);
  return {
    mode: s.mode,
    mode_label: MODE_LABELS[s.mode],
    stage: s.stage,
    stage_label: stageLabel(config, s.stage),
    stage_count: config.stages.length,
    emergency_by: s.emergency_by,
    floor_active: floors.length > 0,
    floor_reasons: floors.map((a) => ({ id: a.id, label: a.label })),
    active_announcements: s.active.map((a) => ({ id: a.id, label: a.label, strength: a.strength })),
    changed,
  };
}

function causeOf(event, source) {
  const c = { type: event.type, source, at: event.at };
  for (const k of ["id", "category", "intensity", "target_id", "reason", "request"]) {
    if (event[k] !== undefined) c[k] = event[k];
  }
  return c;
}

function record(at, rule, from, to, cause, outcome, detail) {
  return Object.freeze({
    at,
    rule,
    from: Object.freeze({ ...from }),
    to: Object.freeze({ ...to }),
    changed: from.mode !== to.mode || from.stage !== to.stage,
    outcome,
    cause: Object.freeze({ ...cause }),
    detail,
  });
}

function deepFreeze(o) {
  if (o !== null && typeof o === "object" && !Object.isFrozen(o)) {
    for (const v of Object.values(o)) deepFreeze(v);
    Object.freeze(o);
  }
  return o;
}

function result(status, value, at, source, detail) {
  return Object.freeze({
    kind: KIND,
    status,
    value: status === "ok" ? deepFreeze(value) : null,
    observed_at: at,
    source,
    detail,
  });
}

function withNote(s, text) {
  return s.mode === MODES.NORMAL ? `${text} ${NOT_SAFE_NOTE}` : text;
}

function enterEmergency(s, at, by) {
  return { ...s, mode: MODES.EMERGENCY, stage: 1, emergency_started_at: at, emergency_by: by };
}

function leaveEmergency(s, mode) {
  return { ...s, mode, stage: null, emergency_started_at: null, emergency_by: null };
}

// ---------------------------------------------------------------- handlers

function onPublic(prev, event, config, source) {
  const at = event.at;
  if (typeof event.id !== "string" || event.id.length === 0) {
    return { error: "公的発表に id がありません。" };
  }
  const cls = classify(event.category, event.intensity);
  const cause = causeOf(event, source);
  if (!cls.ok) {
    const rec = record(at, "-", snap(prev), snap(prev), cause, "unknown", cls.reason);
    return { state: prev, status: "unknown", detail: `${cls.reason}モードは変えていません（判定できないことは「異常なし」ではありません）。`, records: [rec] };
  }
  const same = prev.active.find((a) => a.id === event.id);
  const isUpdate = same !== undefined && (same.category !== event.category || same.intensity !== event.intensity);
  if (same && !isUpdate) {
    const text = `${cls.label}（${event.id}）はすでに受けています。モードは${describe(prev, config)}のままです。`;
    const rec = record(at, "-", snap(prev), snap(prev), cause, "duplicate", text);
    return { state: { ...prev, updated_at: laterOf(prev.updated_at, at) }, status: "ok", detail: withNote(prev, text), records: [rec], changed: false };
  }
  const entry = {
    id: event.id,
    category: event.category,
    label: cls.label,
    strength: cls.strength,
    floor: cls.floor,
    floor_until:
      cls.floor && event.category === "intensity" && config.intensityFloorHours !== null
        ? new Date(Date.parse(at) + config.intensityFloorHours * HOUR_MS).toISOString()
        : null,
    received_at: at,
    source,
  };
  if (event.intensity !== undefined) entry.intensity = event.intensity;
  // A follow-up report with the same id but different content replaces the
  // old entry and is evaluated again, so an upgrade (e.g. warning -> major
  // tsunami warning) is never dropped as a duplicate.
  const kept = prev.active.filter((a) => a.id !== event.id);
  let next = { ...prev, active: [...kept, entry], updated_at: laterOf(prev.updated_at, at) };
  let rule;
  let text;
  if (cls.strength === "strong") {
    rule = "R1";
    if (prev.mode === MODES.EMERGENCY) {
      text = `${cls.label}を受けました。すでに緊急です（${describe(prev, config)}）。`;
    } else {
      next = enterEmergency(next, at, "public");
      text = `${cls.label}を受けたため、緊急に移りました（${describe(next, config)}）。`;
    }
  } else if (cls.strength === "weak") {
    rule = "R2";
    if (prev.mode === MODES.NORMAL) {
      next.mode = MODES.ELEVATED;
      text = `${cls.label}を受けたため、警戒高めに上げました（弱い公的発表では緊急には移りません）。`;
    } else {
      text = `${cls.label}を受けました。弱い公的発表なので、モードは${describe(prev, config)}のままです。`;
    }
  } else {
    rule = "-";
    text = `${cls.label}を受けました。規則の対象（震度3以上）ではないため、モードは${describe(prev, config)}のままです。`;
  }
  if (isUpdate) {
    text = `同じ id（${event.id}）の続報で内容が変わりました（前：${same.label}）。${text}`;
  }
  if (cls.floor) {
    text += ` この発表を受けている間は、利用者の申告があっても警戒高めより下げません（下限）。`;
  }
  const rec = record(at, rule, snap(prev), snap(next), cause, isUpdate ? "updated" : "applied", text);
  return { state: next, status: "ok", detail: withNote(next, text), records: [rec] };
}

function onPublicEnd(prev, event, config, source) {
  const at = event.at;
  if (typeof event.target_id !== "string" || event.target_id.length === 0) {
    return { error: "解除・取消に target_id がありません。" };
  }
  if (event.reason !== "lift" && event.reason !== "cancel") {
    return { error: '解除・取消の reason は "lift" か "cancel" にしてください。' };
  }
  const cause = causeOf(event, source);
  const word = event.reason === "cancel" ? "取消" : "解除";
  const target = prev.active.find((a) => a.id === event.target_id);
  if (!target) {
    const text = `${word}の対象（${event.target_id}）を受けた記録がありません。モードは${describe(prev, config)}のままです。`;
    const rec = record(at, "R5", snap(prev), snap(prev), cause, "unknown", text);
    return { state: prev, status: "unknown", detail: `${text} ${END_NOT_SAFE_NOTE}`, records: [rec] };
  }
  if (Date.parse(at) < Date.parse(target.received_at)) {
    const text = `${word}（${at}）は、対象の${target.label}を受けた時刻（${target.received_at}）より前の時刻です。古い入力として扱い、従っていません。モードは${describe(prev, config)}のままです。`;
    const rec = record(at, "R5", snap(prev), snap(prev), cause, "stale", text);
    return { state: prev, status: "stale", detail: text, records: [rec] };
  }
  let next = {
    ...prev,
    active: prev.active.filter((a) => a.id !== event.target_id),
    updated_at: laterOf(prev.updated_at, at),
  };
  let text;
  if (prev.mode === MODES.EMERGENCY) {
    const strongLeft = next.active.some((a) => a.strength === "strong");
    if (config.onEndInEmergency === "to_elevated" && !strongLeft && prev.emergency_by === "public") {
      next = leaveEmergency(next, MODES.ELEVATED);
      text = `${target.label}の${word}を受けました。緊急から警戒高めに移りました。平常には自動で戻しません。平常に戻すのは利用者の申告によります。`;
    } else {
      const why = strongLeft
        ? "ほかの強い公的発表を受けている"
        : prev.emergency_by === "user"
          ? "緊急は利用者の申告による"
          : "設定で、解除・取消では緊急から下げない";
      text = `${target.label}の${word}を受けました。${why}ため、${describe(prev, config)}のままです。`;
    }
  } else if (prev.mode === MODES.ELEVATED) {
    text = `${target.label}の${word}を受けました。警戒高めのままです。平常には自動で戻しません。平常に戻すのは利用者の申告によります。`;
  } else {
    text = `${target.label}の${word}を受けました。モードは平常のままです。`;
  }
  if (target.floor && !next.active.some((a) => a.floor)) {
    text += " 下限はなくなりました。";
  }
  text += ` ${END_NOT_SAFE_NOTE}`;
  const rec = record(at, "R5", snap(prev), snap(next), cause, "applied", text);
  return { state: next, status: "ok", detail: withNote(next, text), records: [rec] };
}

function onUser(prev, event, config, source) {
  const at = event.at;
  const cause = causeOf(event, source);
  if (!Object.hasOwn(USER_REQUESTS, event.request)) {
    const text = `申告「${String(event.request)}」は受け付けられる申告の一覧にないため、従っていません。`;
    const rec = record(at, "R4", snap(prev), snap(prev), cause, "unknown", text);
    return { state: prev, status: "unknown", detail: text, records: [rec] };
  }
  const ask = USER_REQUESTS[event.request];
  let target;
  if (event.request === "no_emergency") {
    target = prev.mode === MODES.EMERGENCY ? MODES.ELEVATED : prev.mode;
  } else if (event.request === "set_elevated") {
    target = MODES.ELEVATED;
  } else if (event.request === "set_normal") {
    target = MODES.NORMAL;
  } else {
    target = MODES.EMERGENCY;
  }
  const floors = floorEntries(prev);
  if (MODE_RANK[target] < MODE_RANK[MODES.ELEVATED] && floors.length > 0) {
    const labels = floors.map((a) => `${a.label}（${a.id}）`).join("、");
    const text = `申告「${ask}」には従えません。${labels}を受けている間は、警戒高めより下げられないためです（下限）。モードは${describe(prev, config)}のままです。`;
    const rec = record(at, "R3", snap(prev), snap(prev), cause, "denied", text);
    return { state: prev, status: "denied", detail: text, records: [rec] };
  }
  let next = { ...prev, updated_at: laterOf(prev.updated_at, at) };
  let text;
  if (target === prev.mode) {
    // An explicit request keeps emergency even after announcements end.
    if (target === MODES.EMERGENCY) next.emergency_by = "user";
    text = `申告「${ask}」を受けました。モードはすでに${describe(prev, config)}です。`;
  } else if (target === MODES.EMERGENCY) {
    next = enterEmergency(next, at, "user");
    text = `申告「${ask}」により、緊急に移りました（${describe(next, config)}）。`;
  } else {
    next = prev.mode === MODES.EMERGENCY ? leaveEmergency(next, target) : { ...next, mode: target };
    text = `申告「${ask}」により、${MODE_LABELS[target]}にしました。`;
    if (target === MODES.ELEVATED && event.request === "no_emergency") {
      text += " 新しい強い公的発表を受けたときは、また緊急に移ります。";
    }
  }
  const rec = record(at, "R4", snap(prev), snap(next), cause, "applied", text);
  return { state: next, status: "ok", detail: withNote(next, text), records: [rec] };
}

// Apply what the passage of time implies, at the time of any event:
// expiry of configured intensity floors (rule 3) and stage progression
// (rule 6). The event that carries the time is recorded as the cause.
function catchUp(prev, at, cause, config) {
  const records = [];
  const notes = [];
  const nowMs = Date.parse(at);
  let next = prev;
  if (prev.active.some((a) => a.floor && a.floor_until !== null && Date.parse(a.floor_until) <= nowMs)) {
    next = {
      ...next,
      active: next.active.map((a) => {
        if (a.floor && a.floor_until !== null && Date.parse(a.floor_until) <= nowMs) {
          const text = `${a.label}（${a.id}）による下限の期間（設定値）が過ぎました。モードは変えていません。`;
          records.push(record(at, "R3", snap(prev), snap(prev), cause, "floor_expired", text));
          notes.push(text);
          return { ...a, floor: false, floor_until: null };
        }
        return a;
      }),
    };
  }
  if (next.mode === MODES.EMERGENCY) {
    const elapsedH = (nowMs - Date.parse(next.emergency_started_at)) / HOUR_MS;
    let target = 1;
    let sum = 0;
    for (let i = 0; i < config.stageHours.length; i += 1) {
      sum += config.stageHours[i];
      if (elapsedH >= sum) target = i + 2;
      else break;
    }
    while (next.stage < target) {
      const from = snap(next);
      next = { ...next, stage: next.stage + 1 };
      const text = `緊急の開始から時間が経過したため、段階 ${next.stage}/${config.stages.length}「${stageLabel(config, next.stage)}」に進みました。${PROVISIONAL_NOTE}`;
      records.push(record(at, "R6", from, snap(next), cause, "applied", text));
      notes.push(text);
    }
  }
  return { state: next, records, notes };
}

function onTick(prev, event, config) {
  const text = `時間の経過を受けました。モードは${describe(prev, config)}です。`;
  return {
    state: { ...prev, updated_at: laterOf(prev.updated_at, event.at) },
    status: "ok",
    detail: withNote(prev, text),
    records: [],
  };
}

const HANDLERS = Object.freeze({
  public: onPublic,
  public_end: onPublicEnd,
  user: onUser,
  tick: onTick,
});

const DEFAULT_SOURCES = Object.freeze({ user: "user", tick: "clock" });

/**
 * Compute the next state from the previous state and one event.
 * Does not mutate prev. Every call returns the common result shape and the
 * records that explain which input caused what (rule 7).
 *
 * @param {object} prev previous state (from initialState or an earlier step)
 * @param {object} event structured event (see README.md)
 * @param {object} [options]
 * @param {object} [options.config] result of createConfig()
 * @param {() => Date} [options.now] clock used only when the event has no valid time
 * @returns {{state: object, result: object, records: object[]}}
 */
export function step(prev, event, options = {}) {
  const now = options.now ?? (() => new Date());
  const fail = (detail, source = "unknown") => {
    const at = event && isIsoWithZone(event?.at) ? event.at : now().toISOString();
    return { state: prev, result: result("error", null, at, source, detail), records: [] };
  };
  let config;
  try {
    config = options.config === undefined ? getDefaultConfig() : createConfig(options.config);
  } catch (e) {
    return fail(`設定が正しくありません（${e.message}）。状態を更新していません。`);
  }
  const stateError = validateState(prev, config);
  if (stateError) return fail(`${stateError} 状態を更新していません。`);
  if (event === null || typeof event !== "object") return fail("イベントがありません。");
  const handler = Object.hasOwn(HANDLERS, event.type) ? HANDLERS[event.type] : undefined;
  if (!handler) return fail(`イベントの種類「${String(event.type)}」は扱えません。`);
  const source = event.source ?? DEFAULT_SOURCES[event.type];
  if (typeof source !== "string" || source.length === 0) {
    return fail("公的発表のイベントには source（例 \"jma\"、\"simulated\"）が必要です。");
  }
  if ((event.type === "public" || event.type === "public_end") && source === "user") {
    return fail("公的発表のイベントの source に \"user\" は使えません。", source);
  }
  if (event.type === "user" && source !== "user" && source !== "simulated") {
    return fail("利用者の申告の source は \"user\" か \"simulated\" にしてください。", source);
  }
  if (!isIsoWithZone(event.at)) {
    return fail("イベントの時刻 at が、タイムゾーン付きの ISO 8601 ではありません。", source);
  }
  const cause = causeOf(event, source);
  if (event.type === "tick" && Date.parse(event.at) < Date.parse(prev.updated_at)) {
    const text = `時刻 ${event.at} は、前の状態の時刻（${prev.updated_at}）より前です。古い入力として扱い、何も変えていません。`;
    return { state: prev, result: result("stale", null, event.at, source, text), records: [] };
  }
  const caught = catchUp(prev, event.at, cause, config);
  const out = handler(caught.state, event, config, source);
  if (out.error) return fail(out.error, source);
  const state = out.state === prev ? prev : freezeState(out.state);
  const changed = out.changed ?? (state.mode !== prev.mode || state.stage !== prev.stage);
  const value = out.status === "ok" ? view(state, config, changed) : null;
  const detail = [...caught.notes, out.detail].join(" ");
  return {
    state,
    result: result(out.status, value, event.at, source, detail),
    records: [...caught.records, ...out.records],
  };
}

/**
 * Apply events in order. Convenience for replay and tests.
 * @returns {{state: object, results: object[], records: object[]}}
 */
export function run(initial, events, options = {}) {
  let state = initial;
  const results = [];
  const records = [];
  for (const ev of events) {
    const out = step(state, ev, options);
    state = out.state;
    results.push(out.result);
    records.push(...out.records);
  }
  return { state, results, records };
}

/**
 * Current view of a state without applying an event.
 */
export function current(state, options = {}) {
  const config = options.config ?? getDefaultConfig();
  const err = validateState(state, config);
  if (err) {
    const at = state && isIsoWithZone(state.updated_at) ? state.updated_at : (options.now ?? (() => new Date()))().toISOString();
    return result("error", null, at, "unknown", err);
  }
  const text = `モードは${describe(state, config)}です。`;
  return result("ok", view(state, config, false), state.updated_at, "state", withNote(state, text));
}

/**
 * Placeholder interface for stage-specific support content.
 * Psychological and medical advice is out of scope by policy (BW-S4), so
 * this always returns "unsupported". Kept so a future, separately reviewed
 * module can plug in without changing the state machine.
 */
export function supportFor(state, options = {}) {
  const at = state && isIsoWithZone(state.updated_at) ? state.updated_at : (options.now ?? (() => new Date()))().toISOString();
  return Object.freeze({
    kind: "mode_support",
    status: "unsupported",
    value: null,
    observed_at: at,
    source: "policy",
    detail: "段階に応じた心理的な対応・医療の助言は、方針（BW-S4）により実装していません。公的機関や専門の窓口の情報を確かめてください。",
  });
}
