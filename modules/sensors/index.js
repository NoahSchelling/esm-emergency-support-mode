// Entry point: re-exports every sensor module.
// Loads in both browsers and Node.js; nothing touches browser globals at import time.

export { STATUS, makeResult, toIsoWithOffset } from './result.js';
export { createDeviceEnv } from './env.js';
export { createLocationSensor } from './location.js';
export { createMotionSensor, MOTION_LABEL } from './motion.js';
export { createOrientationSensor } from './orientation.js';
export { createOnlineSensor } from './online.js';
export { createNetworkSensor } from './network.js';
export { createBatterySensor } from './battery.js';
export { createReplayEnv, createReplayPlayer, createManualClock, validateRecording, RECORDING_FORMAT } from './replay.js';
export { createRecorder } from './recorder.js';

// Ask for motion and orientation permission together. Call this directly in
// a button's click handler: both browser requests are started synchronously,
// before anything is awaited (required by iOS Safari).
export function requestMotionAndOrientationPermission(motionSensor, orientationSensor) {
  const a = motionSensor.requestPermission();
  const b = orientationSensor.requestPermission();
  return Promise.all([a, b]).then(([motion, orientation]) => ({ motion, orientation }));
}
