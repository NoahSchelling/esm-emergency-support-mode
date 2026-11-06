// Unit tests for the evacuee view logic (node --test). No browser needed.
// Positions: Shizuoka Prefectural Office (approximate) and a fictional
// round-number point outside the prefecture.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import {
  SCENARIOS, scenarioFromSimKey, parseSimParam, minutesAgoText, receptionLine, evacViewModel,
  arrowLabel, SHOCK_TEXT, STRAIGHT_LINE_NOTE,
} from '../evac/model.js';
import { loadEvacData, computeEvacDirections } from '../../modules/evac/node.js';

const NOW = Date.parse('2026-11-07T12:00:00+09:00');
const SAFE_CLAIM = /安全です|安全な場所|安全を確認|異常なし|異常はありません|正常|問題ありません|大丈夫|危険はありません|安心|心配ありません|避難できます|通れます/;
const data = await loadEvacData();
const LOC = { status: 'ok', value: { latitude: 34.9769, longitude: 138.3831, accuracy_m: 20 }, detail: '', source: 'device' };

function compute(extra = {}) {
  return computeEvacDirections(data, { latitude: 34.9769, longitude: 138.3831, accuracy: 20, hazard: 'tsunami', position_at_ms: NOW, ...extra }, { now: NOW });
}
const HEADING_OK = {
  status: 'ok',
  value: { top_true_heading_deg: 0, true_heading_deg: 0, beta: 0, gamma: 0, screen_angle_deg: 0, tilt_deg: 0, accuracy_deg: 10, basis: 'ios_compass', at_ms: NOW },
  detail: '',
};

test('scenario: only the tsunami mock, marked as simulated', () => {
  assert.deepEqual(Object.keys(SCENARIOS), ['tsunami']);
  assert.match(SCENARIOS.tsunami.instruction, /^【模擬】/);
  // quoted as the text of a simulated announcement, not the app's own words
  assert.match(SCENARIOS.tsunami.instruction, /発表文：「.+」$/);
  assert.match(SCENARIOS.tsunami.origin, /気象庁・市町村の発表ではありません/);
  assert.match(SCENARIOS.tsunami.lifted, /^【模擬】.*解除/);
  assert.equal(scenarioFromSimKey('toString'), null);
  assert.equal(scenarioFromSimKey('tsunami_warning'), 'tsunami');
  assert.equal(scenarioFromSimKey('major_tsunami_warning'), 'tsunami');
  assert.equal(scenarioFromSimKey('heavy_rain_warning'), null);
  assert.equal(parseSimParam('?sim=tsunami'), 'tsunami');
  assert.equal(parseSimParam('?sim=__proto__'), null);
  assert.equal(parseSimParam(''), null);
});

test('reception time: minutes ago; none is not "no new warnings"', () => {
  assert.equal(minutesAgoText(NOW - 30_000, NOW), '1 分以内');
  assert.equal(minutesAgoText(NOW - 5 * 60_000, NOW), '5 分前');
  assert.equal(minutesAgoText(NOW - 3 * 3600_000, NOW), '3 時間前');
  assert.equal(minutesAgoText(NOW + 60_000, NOW), null);
  assert.match(receptionLine({ receivedMs: NOW - 5 * 60_000, simulated: true }, NOW), /公的情報の受信：5 分前（11:55）【模擬】/);
  const none = receptionLine(null, NOW);
  assert.match(none, /受信していません/);
  assert.match(none, /新しい発表がないという意味ではありません/);
});

test('view: no scenario -> no site, fallback shown', () => {
  const m = evacViewModel({ scenario: null, location: LOC, result: null, nowMs: NOW });
  assert.equal(m.mode, 'message');
  assert.equal(m.primary, null);
  assert.equal(m.showFallback, true);
  assert.match(m.message, /公的な発表を受けていない/);
  assert.equal(m.straightLineNote, STRAIGHT_LINE_NOTE);
});

test('view: no location / data error / loading', () => {
  const noLoc = evacViewModel({ scenario: 'tsunami', location: { status: 'denied', detail: '位置情報の利用が許可されていません。' }, nowMs: NOW });
  assert.match(noLoc.message, /位置が分からないため、方向を示せません。位置情報の利用が許可されていません/);
  assert.equal(noLoc.arrowDeg, null);
  const bad = evacViewModel({ scenario: 'tsunami', location: LOC, dataError: 'HTTP 404', nowMs: NOW });
  assert.match(bad.message, /読み込めませんでした/);
  assert.equal(bad.showFallback, true);
  assert.match(evacViewModel({ scenario: 'tsunami', location: LOC, nowMs: NOW }).message, /読み込んでいます/);
});

test('view: no heading -> text mode with north-up bearing, no arrow', () => {
  const m = evacViewModel({ scenario: 'tsunami', location: LOC, result: compute(), nowMs: NOW });
  assert.equal(m.mode, 'text');
  assert.equal(m.arrowDeg, null);
  assert.ok(Number.isFinite(m.northUpBearing));
  assert.match(m.arrowReason, /矢印を出していません/);
  assert.match(m.primary.distance, /^直線で約 /);
  assert.match(m.primary.direction, /^北から約 \d+ 度/);
  assert.match(m.primary.hazards, /津波/);
  assert.equal(m.canExclude, true);
  assert.ok(m.others.length <= 2);
});

test('view: heading ok -> arrow mode', () => {
  const r = compute({ heading: HEADING_OK });
  const m = evacViewModel({ scenario: 'tsunami', location: LOC, result: r, nowMs: NOW });
  assert.equal(m.mode, 'arrow');
  assert.equal(m.arrowDeg, r.value.candidates[0].arrow_deg);
  assert.equal(m.arrowReason, '');
});

test('view: unknown result shows the module detail and the fallback', () => {
  const r = computeEvacDirections(data, { latitude: 35.0, longitude: 135.0, accuracy: 20, hazard: 'tsunami' }, { now: NOW });
  const m = evacViewModel({ scenario: 'tsunami', location: LOC, result: r, nowMs: NOW });
  assert.equal(m.mode, 'message');
  assert.match(m.message, /データの中に見つかりません/);
  assert.equal(m.showFallback, true);
});

test('arrow label for screen readers', () => {
  assert.equal(arrowLabel(0), '画面の上の方向');
  assert.equal(arrowLabel(90), '画面の上から右へ約 90 度');
  assert.equal(arrowLabel(270), '画面の上から左へ約 90 度');
  assert.equal(arrowLabel(180), '画面の下の方向');
  assert.equal(arrowLabel(359.6), '画面の上の方向');
});

test('wording: no safety claims, shock text is neutral (no injury words, no shindo)', () => {
  assert.equal(SHOCK_TEXT, '端末が強い衝撃を検知しました');
  const views = [
    evacViewModel({ scenario: null, nowMs: NOW }),
    evacViewModel({ scenario: 'tsunami', location: LOC, result: compute(), nowMs: NOW }),
  ];
  for (const v of views) {
    const s = JSON.stringify(v);
    assert.doesNotMatch(s, SAFE_CLAIM);
    assert.doesNotMatch(s, /震度|(?<!だ)けが|怪我|転倒|負傷/);
  }
  assert.doesNotMatch(JSON.stringify(SCENARIOS), /安全|震度/);
});

test('evac sources: no innerHTML, no external scripts, no green, no input fields', async () => {
  for (const f of ['../evac/model.js', '../evac/evac-main.js', '../index.html', '../app.css']) {
    const src = await readFile(new URL(f, import.meta.url), 'utf8');
    assert.doesNotMatch(src, /innerHTML|outerHTML|insertAdjacentHTML|document\.write/, f);
    assert.doesNotMatch(src, /\bimport[^;]*from\s+['"]https?:/, f);
    if (f.endsWith('.css')) assert.doesNotMatch(src.replace(/\/\*[\s\S]*?\*\//g, ''), /\bgreen\b|lime|#0f0\b|#00ff00|#008000/i, f);
  }
  const html = await readFile(new URL('../index.html', import.meta.url), 'utf8');
  const evacPart = html.slice(html.indexOf('<main id="view-evac"'), html.indexOf('<main id="view-support"'));
  assert.ok(evacPart.length > 100);
  assert.doesNotMatch(evacPart, /<input|<textarea|<select/);
  assert.match(evacPart, /直線の方向です。道順ではありません。/);
});

test('view: simulated lift stops the direction display and says so', () => {
  const m = evacViewModel({ scenario: null, lifted: 'tsunami', location: LOC, result: null, nowMs: NOW });
  assert.equal(m.mode, 'message');
  assert.equal(m.primary, null);
  assert.match(m.message, /解除を受けたため、方向の表示をやめました/);
  assert.match(m.instruction, /^【模擬】/);
  assert.equal(m.showFallback, true);
});

test('view: an old position is told, and the exclusion target carries the site id', () => {
  const r = compute({ position_at_ms: NOW - 20_000, heading: HEADING_OK });
  const m = evacViewModel({ scenario: 'tsunami', location: LOC, result: r, nowMs: NOW });
  assert.equal(m.mode, 'text');
  assert.match(m.positionAgeText, /約 20 秒前/);
  assert.match(m.arrowReason, /20 秒前/);
  assert.equal(m.excludeTarget.site_id, r.value.candidates[0].id);
  const fresh = evacViewModel({ scenario: 'tsunami', location: LOC, result: compute({ heading: HEADING_OK }), nowMs: NOW });
  assert.equal(fresh.positionAgeText, '');
});

test('view: a non-finite arrow angle is never drawn', () => {
  const r = compute({ heading: HEADING_OK });
  const fake = JSON.parse(JSON.stringify(r));
  fake.value.candidates[0].arrow_deg = NaN;
  assert.equal(evacViewModel({ scenario: 'tsunami', location: LOC, result: fake, nowMs: NOW }).mode, 'text');
});
