// Advice gateway: the single place where a future advice provider could be attached.
//
// BW-S4: the default gateway has NO provider, so every request returns
// status "unsupported". Nothing in this repository produces advice.
// The gateway never builds a request from user text or from fragment results,
// and never sends anything off the device by itself.

import { validateProviderResult } from './contract.js';

export const TOPICS = ['mental-health', 'medical'];
export const POLICY_TEXT =
  'このアプリは、メンタルヘルスの助言も医療の助言も行いません。実装していないためです。' +
  '避難や身の安全にかかわる判断は、気象庁・自治体などの公的な発表と指示を優先してください。';

const nowIso = (clock) => {
  const d = clock ? new Date(clock) : new Date();
  const j = new Date(d.getTime() + 9 * 3600 * 1000);
  const p = (n) => String(n).padStart(2, '0');
  return `${j.getUTCFullYear()}-${p(j.getUTCMonth() + 1)}-${p(j.getUTCDate())}T${p(j.getUTCHours())}:${p(j.getUTCMinutes())}:${p(j.getUTCSeconds())}+09:00`;
};

/**
 * @param {{providers?: Array<{id: string, topics: string[], provide: Function}>, now?: Date|string|number}} [config]
 *   providers: empty by default. Adding one needs a design review first (docs/proto/advice-interface.md).
 */
export function createAdviceGateway(config = {}) {
  const providers = [...(config.providers ?? [])];
  for (const p of providers) {
    if (!p || typeof p.id !== 'string' || !Array.isArray(p.topics) || typeof p.provide !== 'function') {
      throw new TypeError('provider must be { id: string, topics: string[], provide: function }');
    }
    if (p.topics.some((t) => !TOPICS.includes(t))) throw new TypeError('provider topics must be a subset of TOPICS');
  }
  const result = (status, detail, source = 'device') => ({ kind: 'advice', status, value: null, observed_at: nowIso(config.now), source, detail });

  return {
    /** Which topics have a provider attached. Empty for the default gateway. */
    supportedTopics: () => TOPICS.filter((t) => providers.some((p) => p.topics.includes(t))),
    /** @param {{topic: string}} request only the topic is passed to a provider: no text, no location. */
    async request(request) {
      if (request === null || typeof request !== 'object' || !TOPICS.includes(request.topic)) {
        return result('unsupported', `助言の種類（topic）が不明です。${POLICY_TEXT}`);
      }
      const provider = providers.find((p) => p.topics.includes(request.topic));
      if (!provider) return result('unsupported', POLICY_TEXT);
      let raw;
      try {
        raw = await provider.provide({ topic: request.topic });
      } catch {
        return result('error', '助言の提供元で失敗しました。助言は返せません。', provider.id);
      }
      const problems = validateProviderResult(raw, provider);
      if (problems.length) return result('error', `提供元の結果が約束を満たしていないため、使いません（${problems.join('、')}）。`, provider.id);
      return raw;
    },
  };
}

/** Default gateway: no provider attached. Always "unsupported". */
export const requestAdvice = (request, config) => createAdviceGateway(config).request(request);
