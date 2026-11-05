// One group of tests per rule (R1-R7).
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { initialState, step, run, createConfig, current, supportFor } from "../index.js";
import { T0, at, hours, pub, end, user, tick } from "./helpers.js";

const S0 = initialState(T0);

describe("R1: strong public announcement moves to emergency", () => {
  for (const category of ["eew_warning", "tsunami_warning", "major_tsunami_warning", "special_warning", "j_alert"]) {
    test(category, () => {
      const { state, result, records } = step(S0, pub("a1", category, at(1)));
      assert.equal(state.mode, "emergency");
      assert.equal(state.stage, 1);
      assert.equal(result.status, "ok");
      assert.equal(result.value.mode, "emergency");
      assert.equal(result.value.stage_label, "発災直後");
      assert.equal(records[0].rule, "R1");
    });
  }
  test("from elevated as well", () => {
    const s1 = step(S0, pub("w1", "warning", at(1))).state;
    const s2 = step(s1, pub("e1", "eew_warning", at(2))).state;
    assert.equal(s2.mode, "emergency");
  });
  test("a second strong announcement keeps the stage", () => {
    const s1 = step(S0, pub("e1", "eew_warning", at(0))).state;
    const s2 = step(s1, tick(hours(1))).state;
    assert.equal(s2.stage, 2);
    const s3 = step(s2, pub("t1", "tsunami_warning", hours(1.1))).state;
    assert.equal(s3.mode, "emergency");
    assert.equal(s3.stage, 2);
  });
});

describe("R2: weak public announcement raises to elevated only", () => {
  for (const [category, extra] of [
    ["eew_forecast", {}],
    ["warning", {}],
    ["intensity", { intensity: "3" }],
    ["intensity", { intensity: "5+" }],
  ]) {
    test(`${category} ${extra.intensity ?? ""}`, () => {
      const { state, records } = step(S0, pub("w1", category, at(1), extra));
      assert.equal(state.mode, "elevated");
      assert.equal(state.stage, null);
      assert.equal(records[0].rule, "R2");
    });
  }
  test("weak does not lower emergency", () => {
    const s1 = step(S0, pub("e1", "eew_warning", at(1))).state;
    const s2 = step(s1, pub("w1", "warning", at(2))).state;
    assert.equal(s2.mode, "emergency");
  });
  test("intensity below 3 does not change the mode and is not reported as safe", () => {
    const { state, result } = step(S0, pub("i1", "intensity", at(1), { intensity: "2" }));
    assert.equal(state.mode, "normal");
    assert.equal(result.status, "ok");
    assert.match(result.detail, /安全という意味ではありません/);
  });
});

describe("R3: floor that the user cannot override", () => {
  for (const [category, extra] of [
    ["tsunami_warning", {}],
    ["major_tsunami_warning", {}],
    ["special_warning", {}],
    ["intensity", { intensity: "6-" }],
    ["intensity", { intensity: "7" }],
  ]) {
    test(`set_normal is denied during ${category} ${extra.intensity ?? ""}`, () => {
      const s1 = step(S0, pub("f1", category, at(1), extra)).state;
      const { state, result, records } = step(s1, user("set_normal", at(2)));
      assert.equal(result.status, "denied");
      assert.equal(result.value, null);
      assert.notEqual(state.mode, "normal");
      assert.equal(state, s1, "state is unchanged when denied");
      assert.equal(records[0].rule, "R3");
      assert.equal(records[0].outcome, "denied");
      assert.match(result.detail, /下限/);
    });
  }
  test("lowering to elevated is allowed during the floor", () => {
    const s1 = step(S0, pub("t1", "tsunami_warning", at(1))).state;
    const out = step(s1, user("no_emergency", at(2)));
    assert.equal(out.result.status, "ok");
    assert.equal(out.state.mode, "elevated");
  });
  test("eew_warning and j_alert are not floors", () => {
    for (const c of ["eew_warning", "j_alert"]) {
      const s1 = step(S0, pub("x", c, at(1))).state;
      const out = step(s1, user("set_normal", at(2)));
      assert.equal(out.result.status, "ok");
      assert.equal(out.state.mode, "normal");
    }
  });
  test("floor ends with the lift of the announcement", () => {
    const { state } = run(S0, [pub("t1", "tsunami_warning", at(1)), end("t1", "lift", at(60)), user("set_normal", at(61))]);
    assert.equal(state.mode, "normal");
  });
  test("intensity floor stays until cancelled by default", () => {
    const { state, results } = run(S0, [pub("q1", "intensity", at(1), { intensity: "6+" }), tick(hours(24 * 365)), user("set_normal", hours(24 * 365))]);
    assert.equal(results[2].status, "denied");
    assert.equal(state.mode, "elevated");
  });
  test("intensity floor can expire by configuration", () => {
    const config = createConfig({ intensityFloorHours: 24 });
    const { state, results, records } = run(
      S0,
      [pub("q1", "intensity", at(1), { intensity: "6-" }), tick(hours(25)), user("set_normal", hours(25))],
      { config },
    );
    assert.equal(results[2].status, "ok");
    assert.equal(state.mode, "normal");
    assert.ok(records.some((r) => r.outcome === "floor_expired" && r.rule === "R3"));
  });
});

describe("R4: user requests within the floor", () => {
  test("set_elevated raises from normal", () => {
    const out = step(S0, user("set_elevated", at(1)));
    assert.equal(out.state.mode, "elevated");
    assert.equal(out.result.source, "user");
    assert.equal(out.records[0].rule, "R4");
  });
  test("no_emergency lowers emergency to elevated, not to normal", () => {
    const s1 = step(S0, pub("e1", "eew_warning", at(1))).state;
    const out = step(s1, user("no_emergency", at(2)));
    assert.equal(out.state.mode, "elevated");
    assert.equal(out.state.stage, null);
  });
  test("no_emergency does not block a new strong announcement (rule 1)", () => {
    const { state } = run(S0, [pub("e1", "eew_warning", at(1)), user("no_emergency", at(2)), pub("e2", "eew_warning", at(3))]);
    assert.equal(state.mode, "emergency");
  });
  test("no_emergency is not undone by a repeat of the same announcement", () => {
    const { state } = run(S0, [pub("e1", "eew_warning", at(1)), user("no_emergency", at(2)), pub("e1", "eew_warning", at(3))]);
    assert.equal(state.mode, "elevated");
  });
  test("set_normal without a floor is followed", () => {
    const { state } = run(S0, [pub("w1", "warning", at(1)), user("set_normal", at(2))]);
    assert.equal(state.mode, "normal");
  });
  test("set_emergency moves to emergency and is kept after announcements end", () => {
    const { state } = run(S0, [user("set_emergency", at(1)), pub("t1", "tsunami_warning", at(2)), end("t1", "lift", at(30))]);
    assert.equal(state.mode, "emergency");
    assert.equal(state.emergency_by, "user");
  });
  test("unknown request is not followed", () => {
    const out = step(S0, user("make_it_safe", at(1)));
    assert.equal(out.result.status, "unknown");
    assert.equal(out.state, S0);
  });
});

describe("R5: lift/cancel never returns to normal automatically", () => {
  test("lift in emergency goes to elevated", () => {
    const { state, records, results } = run(S0, [pub("t1", "tsunami_warning", at(1)), end("t1", "lift", at(60))]);
    assert.equal(state.mode, "elevated");
    assert.deepEqual(records.map((r) => r.rule), ["R1", "R6", "R5"], "stage catch-up is recorded before the lift");
    assert.match(results[1].detail, /安全」という意味ではありません/);
  });
  test("lift in elevated stays elevated", () => {
    const { state } = run(S0, [pub("w1", "warning", at(1)), end("w1", "lift", at(60))]);
    assert.equal(state.mode, "elevated");
  });
  test("emergency is kept while another strong announcement is active", () => {
    const { state } = run(S0, [pub("e1", "eew_warning", at(1)), pub("t1", "tsunami_warning", at(2)), end("t1", "lift", at(60))]);
    assert.equal(state.mode, "emergency");
  });
  test('onEndInEmergency "keep" stays in emergency', () => {
    const config = createConfig({ onEndInEmergency: "keep" });
    const { state } = run(S0, [pub("t1", "tsunami_warning", at(1)), end("t1", "lift", at(60))], { config });
    assert.equal(state.mode, "emergency");
  });
  test("end of an unknown announcement is reported as unknown", () => {
    const out = step(S0, end("nope", "lift", at(1)));
    assert.equal(out.result.status, "unknown");
    assert.equal(out.state.mode, "normal");
  });
});

describe("R6: stages advance with time", () => {
  test("default 7 stages with provisional hours", () => {
    const s1 = step(S0, pub("e1", "eew_warning", at(0))).state;
    assert.equal(s1.stage, 1);
    assert.equal(step(s1, tick(at(14))).state.stage, 1);
    assert.equal(step(s1, tick(at(15))).state.stage, 2);
    assert.equal(step(s1, tick(hours(6.25))).state.stage, 3);
    const far = step(s1, tick(hours(24 * 365 * 3)));
    assert.equal(far.state.stage, 7);
    assert.equal(far.result.value.stage_label, "長期支援");
    assert.equal(far.records.length, 6, "one record per stage step");
    assert.ok(far.records.every((r) => r.rule === "R6"));
    assert.match(far.result.detail, /仮の値/);
  });
  test("stage count is configurable (6 stages)", () => {
    const config = createConfig({ stages: ["s1", "s2", "s3", "s4", "s5", "s6"], stageHours: [1, 1, 1, 1, 1] });
    const s1 = step(S0, pub("e1", "eew_warning", at(0)), { config }).state;
    const out = step(s1, tick(hours(100)), { config });
    assert.equal(out.state.stage, 6);
    assert.equal(out.result.value.stage_count, 6);
  });
  test("invalid configuration is rejected", () => {
    assert.throws(() => createConfig({ stages: ["a", "b"], stageHours: [1, 2] }));
    assert.throws(() => createConfig({ stages: ["a", "b"] }));
    assert.throws(() => createConfig({ stageHours: [0, 1, 1, 1, 1, 1] }));
    assert.throws(() => createConfig({ onEndInEmergency: "normal" }));
  });
  test("no stage outside emergency", () => {
    const out = step(step(S0, pub("w1", "warning", at(0))).state, tick(hours(1000)));
    assert.equal(out.state.stage, null);
    assert.equal(out.records.length, 0);
  });
  test("time going backwards does not advance", () => {
    const s1 = step(S0, pub("e1", "eew_warning", at(10))).state;
    const out = step(s1, tick(at(0)));
    assert.equal(out.state.stage, 1);
  });
});

describe("R7: every transition carries its cause", () => {
  test("records name the input", () => {
    const { records } = run(S0, [
      pub("e1", "eew_warning", at(0)),
      tick(at(20)),
      user("no_emergency", at(21)),
      pub("w1", "warning", at(22)),
      end("e1", "cancel", at(23)),
    ]);
    const changed = records.filter((r) => r.changed);
    assert.ok(changed.length >= 3);
    for (const r of records) {
      assert.ok(r.cause && r.cause.type && r.cause.source && r.cause.at, "cause is present");
      assert.ok(r.rule, "rule is present");
      assert.ok(r.from && r.to, "from/to are present");
      assert.ok(typeof r.detail === "string" && r.detail.length > 0);
    }
    assert.equal(records[0].cause.id, "e1");
    assert.equal(records[1].cause.type, "tick");
    assert.equal(records[2].cause.request, "no_emergency");
    assert.equal(records[4].cause.target_id, "e1");
    assert.equal(records[4].cause.reason, "cancel");
  });
  test("result shape is the common one", () => {
    const { result } = step(S0, pub("e1", "eew_warning", at(0)));
    assert.deepEqual(Object.keys(result).sort(), ["detail", "kind", "observed_at", "source", "status", "value"]);
    assert.equal(result.kind, "mode");
    assert.equal(result.source, "simulated");
    assert.equal(result.observed_at, at(0));
  });
});

describe("pure function and error handling", () => {
  test("prev state is not mutated", () => {
    const snapshot = JSON.stringify(S0);
    step(S0, pub("e1", "eew_warning", at(0)));
    assert.equal(JSON.stringify(S0), snapshot);
    assert.ok(Object.isFrozen(S0));
  });
  test("same input gives the same output", () => {
    const a = step(S0, pub("e1", "eew_warning", at(0)));
    const b = step(S0, pub("e1", "eew_warning", at(0)));
    assert.deepEqual(a, b);
  });
  test("unknown category is unknown, not ok", () => {
    const out = step(S0, pub("x", "volcano_whatever", at(0)));
    assert.equal(out.result.status, "unknown");
    assert.equal(out.result.value, null);
    assert.equal(out.state, S0);
  });
  test("unreadable intensity is unknown", () => {
    const out = step(S0, pub("x", "intensity", at(0), { intensity: "6 lower" }));
    assert.equal(out.result.status, "unknown");
  });
  test("missing time zone is an error", () => {
    const out = step(S0, pub("x", "eew_warning", "2026-11-05T10:00:00"), { now: () => new Date(T0) });
    assert.equal(out.result.status, "error");
    assert.equal(out.state, S0);
  });
  test("missing source for a public announcement is an error", () => {
    const out = step(S0, { type: "public", id: "x", category: "eew_warning", at: at(0) });
    assert.equal(out.result.status, "error");
  });
  test("broken previous state is an error", () => {
    const out = step({ mode: "panic" }, tick(at(0)));
    assert.equal(out.result.status, "error");
  });
  test("state from a 7-stage config is rejected by a 3-stage config", () => {
    const s = run(S0, [pub("e1", "eew_warning", at(0)), tick(hours(1000))]).state;
    const config = createConfig({ stages: ["a", "b", "c"], stageHours: [1, 1] });
    assert.equal(step(s, tick(hours(1001)), { config }).result.status, "error");
  });
  test("current() describes normal without calling it safe", () => {
    const r = current(S0);
    assert.equal(r.status, "ok");
    assert.match(r.detail, /安全という意味ではありません/);
  });
  test("supportFor() is a placeholder that returns unsupported (BW-S4)", () => {
    const r = supportFor(S0);
    assert.equal(r.status, "unsupported");
    assert.equal(r.value, null);
  });
  test("no output says the situation is safe (BW-S3)", () => {
    const { results, records } = run(S0, [
      pub("t1", "tsunami_warning", at(0)),
      end("t1", "lift", at(60)),
      user("set_normal", at(61)),
      tick(at(62)),
    ]);
    const texts = [...results.map((r) => r.detail), ...records.map((r) => r.detail)];
    for (const t of texts) {
      const stripped = t.replace(/安全という意味ではありません|「安全」という意味ではありません|安全確保後/g, "");
      assert.doesNotMatch(stripped, /安全|安心|大丈夫/, t);
    }
  });
});

describe("fixes from the independent review", () => {
  test("an expired intensity floor does not block a request without a tick", () => {
    const config = createConfig({ intensityFloorHours: 1 });
    const { state, results, records } = run(
      S0,
      [pub("q1", "intensity", at(0), { intensity: "6-" }), user("set_normal", hours(5))],
      { config },
    );
    assert.equal(results[1].status, "ok");
    assert.equal(state.mode, "normal");
    assert.equal(records[1].outcome, "floor_expired");
    assert.equal(records[1].cause.request, "set_normal");
  });
  test("stages catch up on any event, not only on ticks", () => {
    const { results, records } = run(S0, [pub("e1", "eew_warning", at(0)), pub("w1", "warning", hours(100))]);
    assert.equal(results[1].value.stage, 4);
    assert.equal(records.filter((r) => r.rule === "R6").length, 3);
    assert.ok(records.filter((r) => r.rule === "R6").every((r) => r.cause.id === "w1"));
  });
  test("a broken entry in the previous state is an error, not an exception", () => {
    const s = { ...S0, active: [null] };
    const out = step(s, tick(at(1)));
    assert.equal(out.result.status, "error");
  });
  test("a config that did not come from createConfig is validated", () => {
    const out = step(S0, tick(at(1)), { config: { stages: [], stageHours: [] } });
    assert.equal(out.result.status, "error");
  });
  test("a tick older than the state is stale", () => {
    const s1 = step(S0, pub("e1", "eew_warning", at(10))).state;
    const out = step(s1, tick(at(0)));
    assert.equal(out.result.status, "stale");
    assert.equal(out.result.value, null);
    assert.equal(out.state, s1);
  });
  test("a lift older than the announcement is stale and not applied", () => {
    const s1 = step(S0, pub("t1", "tsunami_warning", at(10))).state;
    const out = step(s1, end("t1", "lift", at(5)));
    assert.equal(out.result.status, "stale");
    assert.equal(out.state.mode, "emergency");
    assert.equal(out.state.active.length, 1);
  });
  test("same id with an upgraded category is applied, not dropped", () => {
    const { state, results, records } = run(S0, [
      pub("x", "warning", at(0)),
      pub("x", "major_tsunami_warning", at(1)),
      user("set_normal", at(2)),
    ]);
    assert.equal(results[1].value.mode, "emergency");
    assert.equal(records[1].outcome, "updated");
    assert.equal(results[2].status, "denied");
    assert.equal(state.active.length, 1);
  });
  test("public announcements cannot claim source user, requests cannot claim a public source", () => {
    assert.equal(step(S0, { ...pub("e1", "eew_warning", at(0)), source: "user" }).result.status, "error");
    assert.equal(step(S0, { ...user("set_emergency", at(0)), source: "jma" }).result.status, "error");
    assert.equal(step(S0, { ...user("set_emergency", at(0)), source: "simulated" }).result.status, "ok");
  });
  test("impossible calendar dates are rejected", () => {
    const out = step(S0, pub("e1", "eew_warning", "2026-02-30T10:00:00+09:00"), { now: () => new Date(T0) });
    assert.equal(out.result.status, "error");
  });
});
