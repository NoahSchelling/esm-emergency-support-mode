// End-to-end flows requested for the mode state machine.
import { test } from "node:test";
import assert from "node:assert/strict";
import { initialState, run } from "../index.js";
import { T0, at, hours, pub, end, user, tick } from "./helpers.js";

const S0 = initialState(T0);

test("strong -> lift -> user returns to normal", () => {
  const { state, results, records } = run(S0, [
    pub("eew-1", "eew_warning", at(0)),
    tick(at(20)),
    end("eew-1", "lift", at(30)),
    tick(hours(5)),
    user("set_normal", hours(5)),
  ]);
  assert.deepEqual(
    results.map((r) => r.value?.mode ?? r.status),
    ["emergency", "emergency", "elevated", "elevated", "normal"],
  );
  assert.equal(state.mode, "normal");
  assert.deepEqual(
    records.filter((r) => r.changed).map((r) => r.rule),
    ["R1", "R6", "R5", "R4"],
  );
});

test("user asks for normal during a tsunami warning (floor holds)", () => {
  const { state, results } = run(S0, [
    pub("tsu-1", "tsunami_warning", at(0)),
    user("set_normal", at(5)),
    user("no_emergency", at(6)),
    user("set_normal", at(7)),
  ]);
  assert.equal(results[1].status, "denied");
  assert.match(results[1].detail, /津波警報/);
  assert.equal(results[2].status, "ok");
  assert.equal(results[2].value.mode, "elevated");
  assert.equal(results[3].status, "denied");
  assert.equal(state.mode, "elevated");
});

test("weak announcements keep coming (never emergency)", () => {
  const events = [];
  for (let i = 0; i < 20; i += 1) {
    events.push(pub(`fc-${i}`, "eew_forecast", at(i)));
    events.push(pub(`int-${i}`, "intensity", at(i), { intensity: i % 2 ? "4" : "5+" }));
    events.push(pub(`wr-${i}`, "warning", at(i)));
    events.push(tick(hours(i)));
  }
  const { state, results } = run(S0, events);
  assert.equal(state.mode, "elevated");
  assert.ok(results.every((r) => r.status === "ok" && r.value.mode !== "emergency"));
});

test("cancel (false alarm) of a strong announcement", () => {
  const { state, results, records } = run(S0, [
    pub("eew-9", "eew_warning", at(0)),
    end("eew-9", "cancel", at(1)),
  ]);
  assert.equal(state.mode, "elevated", "a cancel does not mean safe: stays elevated");
  assert.match(results[1].detail, /取消/);
  assert.match(results[1].detail, /平常には自動で戻しません/);
  assert.equal(records[1].cause.reason, "cancel");
  assert.equal(state.active.length, 0);
});

test("cancel of a floor announcement releases the floor but not the mode", () => {
  const { state, results } = run(S0, [
    pub("tsu-x", "major_tsunami_warning", at(0)),
    end("tsu-x", "cancel", at(2)),
    user("set_normal", at(3)),
  ]);
  assert.equal(results[1].value.mode, "elevated");
  assert.equal(results[1].value.floor_active, false);
  assert.equal(state.mode, "normal");
});
