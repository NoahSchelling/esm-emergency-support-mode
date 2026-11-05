// Configuration for the mode state machine.
// Pure ES module: no Node.js or browser specific APIs, so it loads in both.

// Default stage names (7-stage plan). Only names are returned; no content
// for psychological or medical support is attached to a stage (BW-S4).
export const DEFAULT_STAGES = Object.freeze([
  "発災直後",
  "安全確保後",
  "サバイバル",
  "復旧",
  "複合災害・波及対応",
  "長期回復支援",
  "長期支援",
]);

// Hours spent in stage i before moving to stage i+1 (length = stages - 1).
// PROVISIONAL VALUES (！！仮の値！！). They only follow the rough time scale
// in the stage descriptions (minutes, hours, days, weeks, months, years) and
// have not been decided by anyone. Do not treat them as a recommendation.
export const DEFAULT_STAGE_HOURS = Object.freeze([
  0.25, // 1 -> 2 : 15 minutes      ！！仮の値！！
  6, //    2 -> 3 : 6 hours         ！！仮の値！！
  72, //   3 -> 4 : 3 days          ！！仮の値！！
  336, //  4 -> 5 : 2 weeks         ！！仮の値！！
  2160, // 5 -> 6 : 90 days         ！！仮の値！！
  8760, // 6 -> 7 : 365 days        ！！仮の値！！
]);

// How long an observed intensity of 6- or more keeps the floor (rule 3).
// null = until the observation is cancelled. ！！仮の値！！ (see docs/proto/mode.md).
export const DEFAULT_INTENSITY_FLOOR_HOURS = null;

// What a lift/cancel does while in emergency mode (rule 5).
//   "to_elevated": leave emergency for elevated when no strong announcement
//                  remains active (literal reading of rule 5).
//   "keep":        stay in emergency; only the user can lower it.
// ！！仮の値！！ (the choice is open; see docs/proto/mode.md).
export const DEFAULT_ON_END_IN_EMERGENCY = "to_elevated";

export const PROVISIONAL_NOTE =
  "段階の切り替え時間などの設定値は仮の値です（！！仮の値！！）。";

/**
 * Build and validate a configuration.
 * @param {object} [overrides]
 * @param {string[]} [overrides.stages] stage names (any length >= 1)
 * @param {number[]} [overrides.stageHours] hours per stage, length stages-1
 * @param {number|null} [overrides.intensityFloorHours]
 * @param {"to_elevated"|"keep"} [overrides.onEndInEmergency]
 * @returns {Readonly<object>}
 * @throws {TypeError|RangeError} when the configuration is invalid
 */
export function createConfig(overrides = {}) {
  if (overrides === null || typeof overrides !== "object") {
    throw new TypeError("config overrides must be an object");
  }
  const stages = overrides.stages ?? DEFAULT_STAGES;
  if (!Array.isArray(stages) || stages.length < 1) {
    throw new RangeError("stages must be a non-empty array");
  }
  for (const name of stages) {
    if (typeof name !== "string" || name.length === 0) {
      throw new TypeError("each stage name must be a non-empty string");
    }
  }
  let stageHours = overrides.stageHours;
  if (stageHours === undefined) {
    if (overrides.stages !== undefined && stages.length !== DEFAULT_STAGES.length) {
      throw new RangeError("stageHours is required when the number of stages differs from the default");
    }
    stageHours = DEFAULT_STAGE_HOURS;
  }
  if (!Array.isArray(stageHours) || stageHours.length !== stages.length - 1) {
    throw new RangeError("stageHours must have exactly stages.length - 1 entries");
  }
  for (const h of stageHours) {
    if (typeof h !== "number" || !Number.isFinite(h) || h <= 0) {
      throw new RangeError("each stageHours entry must be a positive finite number");
    }
  }
  const intensityFloorHours =
    overrides.intensityFloorHours === undefined
      ? DEFAULT_INTENSITY_FLOOR_HOURS
      : overrides.intensityFloorHours;
  if (
    intensityFloorHours !== null &&
    (typeof intensityFloorHours !== "number" || !Number.isFinite(intensityFloorHours) || intensityFloorHours <= 0)
  ) {
    throw new RangeError("intensityFloorHours must be null or a positive finite number");
  }
  const onEndInEmergency = overrides.onEndInEmergency ?? DEFAULT_ON_END_IN_EMERGENCY;
  if (onEndInEmergency !== "to_elevated" && onEndInEmergency !== "keep") {
    throw new RangeError('onEndInEmergency must be "to_elevated" or "keep"');
  }
  return Object.freeze({
    stages: Object.freeze([...stages]),
    stageHours: Object.freeze([...stageHours]),
    intensityFloorHours,
    onEndInEmergency,
  });
}
