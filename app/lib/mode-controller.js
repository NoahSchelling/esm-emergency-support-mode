// Holds the mode state machine's state and its records for the screen, and
// feeds it user requests, simulated public announcements and clock ticks.
//
// The mode module is passed in (it is loaded dynamically and may be
// missing). Simulated inputs always use source "simulated"; C-A messages
// are not connected to the mode yet (the mapping is undecided).

import { toJstIso } from './time.js';

// Same keys and labels as modules/mode (not exported from its index.js).
export const USER_REQUESTS = Object.freeze({
  no_emergency: '緊急にしない',
  set_elevated: '警戒高めにして',
  set_normal: '平常に戻して',
  set_emergency: '緊急にして',
});

// Simulated public announcements offered as buttons. Keys are mode categories.
export const SIMULATED_EVENTS = Object.freeze({
  eew_warning: Object.freeze({ label: '模擬：緊急地震速報（警報）を受けた' }),
  tsunami_warning: Object.freeze({ label: '模擬：津波警報を受けた' }),
  special_warning: Object.freeze({ label: '模擬：特別警報を受けた' }),
  eew_forecast: Object.freeze({ label: '模擬：緊急地震速報（予報）を受けた' }),
  warning: Object.freeze({ label: '模擬：警報を受けた' }),
});

/**
 * @param {object} M the mode module (modules/mode/index.js)
 * @param {object} [opts]
 * @param {() => number} [opts.now] clock in epoch ms
 * @param {object} [opts.config] mode config overrides
 */
export function createModeController(M, { now = () => Date.now(), config } = {}) {
  const options = config === undefined ? {} : { config };
  let state = M.initialState(toJstIso(now()));
  let last = null;     // result of the last input
  let reason = null;   // last record that changed the mode or stage
  const records = [];
  const lastSimIds = new Map();
  let seq = 0;

  function apply(event) {
    const out = M.step(state, event, options);
    state = out.state;
    last = out.result;
    for (const rec of out.records) {
      records.push(rec);
      if (rec.changed) reason = rec;
    }
    return out.result;
  }

  return {
    get current() {
      return M.current(state, options);
    },
    get state() {
      return state;
    },
    get last() {
      return last;
    },
    get reason() {
      return reason;
    },
    get records() {
      return records.slice();
    },
    request(key) {
      return apply({ type: 'user', request: key, at: toJstIso(now()), source: 'user' });
    },
    simulatePublic(category) {
      seq += 1;
      const id = `app-sim-${category}-${seq}`;
      lastSimIds.set(category, id);
      return apply({ type: 'public', id, category, at: toJstIso(now()), source: 'simulated' });
    },
    simulateLift(category) {
      const target = lastSimIds.get(category) ?? `app-sim-${category}-none`;
      return apply({ type: 'public_end', target_id: target, reason: 'lift', at: toJstIso(now()), source: 'simulated' });
    },
    tick() {
      return apply({ type: 'tick', at: toJstIso(now()) });
    },
  };
}
