// Contract that any future advice provider must satisfy.
//
// BW-S4: this repository implements NO advice (mental health or medical).
// This file only describes the shape of a provider and checks what comes back,
// so that a later addition cannot bypass the common result format, mislabel its
// source, or pass itself off as a public announcement.
//
// A provider is: { id: string, topics: string[], provide(request): Promise<Result>|Result }
// Result is the common shape: { kind: 'advice', status, value, observed_at, source, detail }.

export const STATUSES = ['ok', 'denied', 'unsupported', 'insecure', 'error', 'stale', 'unknown'];
// Sources that must never be claimed by an advice provider: they mean "public announcement"
// or "the user's own report" (BW-S1: advice is not a public announcement).
export const RESERVED_SOURCES = ['jma', 'user', 'device'];
const ISO_WITH_TZ = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$/;
// Words that present an absence of news as safety (BW-S3). Advice must not use them.
const SAFETY_CLAIM = /安全です|安心して|大丈夫です|心配ありません|異常なし|問題ありません/;

/** @returns {string[]} problems (empty when the result is acceptable) */
export function validateProviderResult(result, provider) {
  const problems = [];
  if (result === null || typeof result !== 'object') return ['結果がオブジェクトではありません'];
  const keys = Object.keys(result).sort().join(',');
  if (keys !== 'detail,kind,observed_at,source,status,value') problems.push('共通の形（kind, status, value, observed_at, source, detail）と違います');
  if (result.kind !== 'advice') problems.push('kind が "advice" ではありません');
  if (!STATUSES.includes(result.status)) problems.push('status が決められた値ではありません');
  if (result.status !== 'ok' && result.value !== null) problems.push('status が ok でないのに value があります');
  if (result.status === 'ok' && (result.value === null || result.value === undefined)) problems.push('status が ok なのに value がありません');
  if (typeof result.observed_at !== 'string' || !ISO_WITH_TZ.test(result.observed_at)) problems.push('observed_at がタイムゾーン付きの ISO 8601 ではありません');
  if (typeof result.detail !== 'string' || result.detail === '') problems.push('detail がありません');
  if (typeof result.source !== 'string' || result.source === '') problems.push('source がありません');
  else if (RESERVED_SOURCES.includes(result.source)) problems.push(`source "${result.source}" は助言の提供元には使えません`);
  else if (result.source !== 'simulated' && result.source !== provider.id) problems.push('source が提供元の id と一致しません（模擬のときだけ "simulated"）');
  if (result.status === 'ok') {
    const v = result.value;
    if (v === null || typeof v !== 'object' || typeof v.text !== 'string' || v.text === '') problems.push('value.text（助言の文面）がありません');
    else if (SAFETY_CLAIM.test(v.text)) problems.push('「新しい発表がない」ことを安全と読ませる言い方があります（BW-S3）');
    if (v && v.officialInformationFirst !== true) problems.push('value.officialInformationFirst が true ではありません（公的情報の優先を示す必要があります、BW-S2）');
    if (v && v.notAnnouncement !== true) problems.push('value.notAnnouncement が true ではありません（公的発表ではないことを示す必要があります、BW-S1）');
  }
  if (typeof result.detail === 'string' && SAFETY_CLAIM.test(result.detail)) problems.push('detail に安全を言い切る言い方があります（BW-S3）');
  return problems;
}
