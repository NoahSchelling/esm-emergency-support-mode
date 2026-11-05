// Test helpers: build small recordings inline.
import assert from 'node:assert/strict';

export const START = '2026-11-05T10:00:00+09:00';

// Fictional test coordinates (a round-number grid point). Not a real person's location.
export const FICTIONAL = { latitude: 35.0, longitude: 135.0, accuracy: 25 };

export function recording(environment, events = []) {
  return { format: 'sensor-recording/1', description: 'test', start_time: START, environment, events };
}

const KEYS = ['kind', 'status', 'value', 'observed_at', 'source', 'detail'];
const STATUSES = ['ok', 'denied', 'unsupported', 'insecure', 'error', 'stale', 'unknown'];

// Every result must follow the shared contract.
export function assertContract(r, kind) {
  assert.deepEqual(Object.keys(r).sort(), [...KEYS].sort());
  assert.equal(r.kind, kind);
  assert.ok(STATUSES.includes(r.status), `status ${r.status}`);
  if (r.status !== 'ok') assert.equal(r.value, null, 'value must be null unless ok');
  assert.match(r.observed_at, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}([+-]\d{2}:\d{2}|Z)$/);
  assert.equal(typeof r.source, 'string');
  assert.equal(typeof r.detail, 'string');
  assert.ok(r.detail.length > 0);
  // BW-S3: never describe a missing/unknown reading as safe or normal.
  assert.doesNotMatch(r.detail, /安全です|異常なし|異常はありません|問題ありません|大丈夫/);
  return r;
}

export const flush = () => new Promise((r) => setImmediate(r));
