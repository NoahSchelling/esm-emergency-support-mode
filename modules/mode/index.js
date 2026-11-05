// Public entry point of the mode module (works in browsers and Node.js).
export {
  createConfig,
  DEFAULT_STAGES,
  DEFAULT_STAGE_HOURS,
  DEFAULT_INTENSITY_FLOOR_HOURS,
  DEFAULT_ON_END_IN_EMERGENCY,
} from "./config.js";
export { MODES, MODE_LABELS, CATEGORIES, INTENSITY_SCALE, classify } from "./categories.js";
export { initialState, step, run, current, supportFor, isIsoWithZone, STATE_VERSION } from "./machine.js";
