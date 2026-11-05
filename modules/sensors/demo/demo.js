// Browser-only test page. Not part of the modules; it just wires buttons to them.
import * as sensors from '../index.js';

const $ = (id) => document.getElementById(id);
const show = (id, r) => {
  $(id).textContent = JSON.stringify(r, null, 2);
};

let s = null;
let peakRec = null;
let stopReplay = null;
let recorder = null;
let env = null;

function build(e) {
  stopReplay?.();
  if (s) for (const x of Object.values(s)) x.stop();
  env = e;
  s = {
    location: sensors.createLocationSensor({ env }),
    motion: sensors.createMotionSensor({ env }),
    orientation: sensors.createOrientationSensor({ env }),
    online: sensors.createOnlineSensor({ env }),
    network: sensors.createNetworkSensor({ env }),
    battery: sensors.createBatterySensor({ env }),
  };
  s.motion.start();
  s.orientation.start();
  s.online.start();
  s.network.start();
  s.battery.start();
  peakRec = null;
}

$('start-device').addEventListener('click', () => {
  build(sensors.createDeviceEnv());
  $('mode').textContent = '端末のセンサー（source: device）';
});

$('start-replay').addEventListener('click', async () => {
  const rec = await (await fetch('../fixtures/sample-session.json')).json();
  const player = sensors.createReplayPlayer(rec);
  build(player.env);
  s.location.start();
  $('mode').textContent = '再生（source: simulated）';
  stopReplay = player.playRealtime({ speed: 1 });
});

// iOS Safari: the permission request must happen inside the click handler.
$('perm').addEventListener('click', () => {
  if (!s) return;
  sensors.requestMotionAndOrientationPermission(s.motion, s.orientation).then((r) => show('out-perm', r));
});

$('locate').addEventListener('click', () => {
  if (!s) return;
  s.location.locateOnce().then((r) => show('out-location', r));
});

$('peak-start').addEventListener('click', () => {
  if (s) peakRec = s.motion.startPeakRecording();
});
$('peak-stop').addEventListener('click', () => {
  if (peakRec) show('out-peak-rec', peakRec.stop());
});

$('rec-start').addEventListener('click', () => {
  if (env) recorder = sensors.createRecorder({ env, description: '試験用ページで記録' });
});
$('rec-stop').addEventListener('click', () => {
  if (!recorder) return;
  const data = recorder.stop();
  recorder = null;
  const a = $('rec-download');
  a.href = URL.createObjectURL(new Blob([JSON.stringify(data)], { type: 'application/json' }));
  a.hidden = false;
});

setInterval(() => {
  if (!s) return;
  show('out-motion', s.motion.read());
  show('out-peak', s.motion.peak(10));
  if (peakRec) show('out-peak-rec', peakRec.read());
  show('out-location', s.location.read());
  show('out-orientation', s.orientation.read());
  show('out-online', s.online.read());
  show('out-network', s.network.read());
  show('out-battery', s.battery.read());
}, 500);

// Expose for automated browser checks only.
globalThis.__sensorDemo = { sensors, get s() { return s; } };
