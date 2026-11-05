import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createAdviceGateway, requestAdvice, TOPICS, POLICY_TEXT, validateProviderResult } from '../index.js';

const NOW = '2026-11-05T18:00:00+09:00';
const ADVICE_WORDS = /深呼吸|落ち着|休んで|受診|病院|薬|相談して|眠れ|不安を|大丈夫/;

// A test-only stand-in. It contains placeholder text, not real advice.
const fake = (over = {}) => ({
  id: 'fake-provider',
  topics: ['mental-health'],
  provide: async () => ({
    kind: 'advice', status: 'ok',
    value: { text: '！！仮の値！！', officialInformationFirst: true, notAnnouncement: true },
    observed_at: NOW, source: 'simulated', detail: '試験用の模擬の提供元です。',
    ...over,
  }),
});

test('default: no provider, every topic is "unsupported" and carries no advice', async () => {
  for (const topic of TOPICS) {
    const r = await requestAdvice({ topic }, { now: NOW });
    assert.equal(r.kind, 'advice');
    assert.equal(r.status, 'unsupported');
    assert.equal(r.value, null);
    assert.equal(r.observed_at, '2026-11-05T18:00:00+09:00');
    assert.equal(r.detail, POLICY_TEXT);
    assert.doesNotMatch(r.detail, ADVICE_WORDS);
  }
  assert.deepEqual(createAdviceGateway().supportedTopics(), []);
});

test('default: unknown or malformed requests are "unsupported", not "ok"', async () => {
  for (const req of [undefined, null, {}, { topic: 'weather' }, 'medical', { topic: ['medical'] }]) {
    const r = await requestAdvice(req, { now: NOW });
    assert.equal(r.status, 'unsupported');
    assert.equal(r.value, null);
  }
});

test('policy text states the policy and puts public information first', () => {
  assert.match(POLICY_TEXT, /助言も医療の助言も行いません/);
  assert.match(POLICY_TEXT, /公的な発表と指示を優先/);
  assert.doesNotMatch(POLICY_TEXT, ADVICE_WORDS);
});

test('a provider that follows the contract is passed through; only the topic is sent to it', async () => {
  let seen;
  const p = fake();
  const inner = p.provide;
  p.provide = async (req) => { seen = req; return inner(req); };
  const g = createAdviceGateway({ providers: [p], now: NOW });
  assert.deepEqual(g.supportedTopics(), ['mental-health']);
  const r = await g.request({ topic: 'mental-health', text: 'secret words', location: { lat: 1, lon: 2 } });
  assert.equal(r.status, 'ok');
  assert.deepEqual(seen, { topic: 'mental-health' }); // no text, no location leaves the gateway
  assert.equal((await g.request({ topic: 'medical' })).status, 'unsupported'); // other topic still has no provider
});

test('contract: results that break the rules are replaced by "error"', async () => {
  const bad = {
    'wrong kind': { kind: 'fragment' },
    'claims jma': { source: 'jma' },
    'claims user': { source: 'user' },
    'claims device': { source: 'device' },
    'other id as source': { source: 'someone-else' },
    'ok without value': { value: null },
    'no official-first flag': { value: { text: 'x', officialInformationFirst: false, notAnnouncement: true } },
    'presents itself as an announcement': { value: { text: 'x', officialInformationFirst: true, notAnnouncement: false } },
    'safety claim in text': { value: { text: '今は安全です', officialInformationFirst: true, notAnnouncement: true } },
    'safety claim in detail': { detail: '異常なし' },
    'value on non-ok': { status: 'unknown' },
    'naive time': { observed_at: '2026-11-05T18:00:00' },
    'unknown status': { status: 'fine' },
    'extra key': { extra: 1 },
  };
  for (const [name, over] of Object.entries(bad)) {
    const g = createAdviceGateway({ providers: [fake(over)], now: NOW });
    const r = await g.request({ topic: 'mental-health' });
    assert.equal(r.status, 'error', name);
    assert.equal(r.value, null, name);
    assert.doesNotMatch(r.detail, /安全です/, name);
  }
});

test('contract: a provider that throws or returns nothing never yields advice', async () => {
  const thrower = { id: 't', topics: ['medical'], provide: () => { throw new Error('x'); } };
  const empty = { id: 'e', topics: ['medical'], provide: async () => undefined };
  for (const p of [thrower, empty]) {
    const r = await createAdviceGateway({ providers: [p], now: NOW }).request({ topic: 'medical' });
    assert.equal(r.status, 'error');
    assert.equal(r.value, null);
  }
});

test('contract: a non-ok status without value is acceptable (not available is not "safe")', () => {
  const r = { kind: 'advice', status: 'unknown', value: null, observed_at: NOW, source: 'simulated', detail: '判定できません。' };
  assert.deepEqual(validateProviderResult(r, { id: 'p' }), []);
});

test('bad providers are rejected when the gateway is built', () => {
  assert.throws(() => createAdviceGateway({ providers: [{ id: 'x' }] }), TypeError);
  assert.throws(() => createAdviceGateway({ providers: [{ id: 'x', topics: ['weather'], provide() {} }] }), TypeError);
});

test('BW-S4: the repository attaches no provider and fragment never calls advice', () => {
  const root = fileURLToPath(new URL('../../', import.meta.url));
  for (const f of readdirSync(`${root}fragment`).filter((n) => n.endsWith('.js'))) {
    const src = readFileSync(`${root}fragment/${f}`, 'utf8');
    assert.doesNotMatch(src, /(import|export)[^;]*from\s+['"][^'"]*advice/i, f); // comments may say "advice"; imports may not
    assert.doesNotMatch(src, /import\(\s*['"][^'"]*advice/i, f);
  }
  for (const f of readdirSync(`${root}advice`).filter((n) => n.endsWith('.js'))) {
    const src = readFileSync(`${root}advice/${f}`, 'utf8');
    assert.doesNotMatch(src, /providers:\s*\[\s*\w/, f); // no default provider list
    assert.doesNotMatch(src, /from\s+['"]node:|require\(|\bprocess\.|\bwindow\b|\bdocument\b|\bfetch\(|XMLHttpRequest/, f);
  }
});
