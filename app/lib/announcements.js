// Summarises the C-A status (/api/status) for the screen, and builds mock
// data in the same shape when C-A cannot be reached.
//
// BW-S1: announcements are relayed as received; nothing is inferred from
// their content. BW-S3: no announcement, a lost link or a long silence is
// never reported as "safe". Mock data is always marked as simulated.

import { formatJst, toJstIso } from './time.js';

const KIND = 'announcement';
const RECENT_MAX = 5;
const MOCK_STALE_AFTER_SEC = 600;
const MOCK_STEP_MS = 60_000;

const NOT_SAFE_NOTE = '新しい発表がないことは、安全という意味ではありません。';
const MOCK_NOTE = '模擬データです。気象庁の発表ではありません。';

// Fictional titles and areas; every one says it is mock data.
const MOCK_TITLES = ['気象警報・注意報', '震度速報', '津波警報・注意報・予報'];
const MOCK_AREAS = ['模擬地域A', '模擬地域B', '模擬地域C'];

/**
 * Status object shaped like C-A's /api/status, built from fictional entries.
 * Entries are numbered 1..count; the newest (highest number) comes first.
 * @param {number} baseMs time of the newest entry (epoch ms)
 * @param {number} count number of entries
 */
export function makeMockStatus(baseMs, count) {
  const recent = [];
  for (let i = 0; i < count; i++) {
    const n = count - i;
    recent.push({
      id: `urn:app-mock:${n}`,
      title: `模擬電文：${MOCK_TITLES[n % MOCK_TITLES.length]}（模擬番号 ${n}）`,
      updated: baseMs - i * MOCK_STEP_MS,
      author: '模擬官署',
      content: `これは模擬データです。気象庁の発表ではありません。（模擬番号 ${n}）`,
      link: null,
      mock: true,
      detail: {
        status: '通常',
        title: null,
        headline_text: 'これは模擬データです。気象庁の発表ではありません。',
        areas: [MOCK_AREAS[n % MOCK_AREAS.length]],
        error: null,
      },
    });
  }
  return {
    server_time: baseMs,
    source: { mode: 'mock', reason: '画面の中で作った模擬データ', detail: null },
    stale_after: MOCK_STALE_AFTER_SEC,
    last_received_at: count > 0 ? baseMs : null,
    latest: recent[0] ?? null,
    recent,
  };
}

// Only https links are shown; anything else (javascript:, mock://, ...) is dropped.
function safeLink(link) {
  if (typeof link !== 'string') return null;
  try {
    return new URL(link).protocol === 'https:' ? link : null;
  } catch {
    return null;
  }
}

function text(v) {
  return typeof v === 'string' ? v : '';
}

function normalizeEntry(e, simulated) {
  const d = e?.detail && typeof e.detail === 'object' ? e.detail : {};
  return {
    id: text(e?.id),
    title: text(e?.title) || '（題名なし）',
    author: text(e?.author) || '（発表者不明）',
    updated: e?.updated ?? null,
    content: text(e?.content),
    link: safeLink(e?.link),
    mock: simulated || e?.mock === true,
    areas: Array.isArray(d.areas) ? d.areas.filter((a) => typeof a === 'string') : [],
    headline: typeof d.headline_text === 'string' && d.headline_text !== '' ? d.headline_text : null,
    control_status: typeof d.status === 'string' ? d.status : null,
  };
}

function result(status, value, nowMs, source, detail) {
  return {
    kind: KIND,
    status,
    value: status === 'ok' ? value : null,
    observed_at: toJstIso(nowMs),
    source,
    detail,
  };
}

/**
 * @param {object|null} st C-A status (or makeMockStatus())
 * @param {object} opts
 * @param {'ca'|'app-mock'} opts.origin where st came from
 * @param {number} opts.nowMs
 * @param {boolean} [opts.linkOk] false when the last poll of C-A failed
 * @param {number|null} [opts.lastOkMs] time of the last successful poll
 * @param {string|null} [opts.error] last poll error
 */
export function summarize(st, { origin, nowMs, linkOk = true, lastOkMs = null, error = null } = {}) {
  const simulated = origin === 'app-mock' || !st || st.source?.mode !== 'live'
    || (Array.isArray(st.recent) && st.recent.some((e) => e?.mock === true));
  const source = simulated ? 'simulated' : 'jma';

  if (!linkOk) {
    const since = lastOkMs != null ? `${formatJst(lastOkMs)} を最後に、` : '';
    const why = error ? `（${error}）` : '';
    return result('stale', null, nowMs, source,
      `${since}試作 C-A のサーバーから受け取れていません${why}。新しい発表が出ていても、この画面には出ません。${NOT_SAFE_NOTE}`);
  }
  if (!st || typeof st !== 'object') {
    return result('unknown', null, nowMs, 'unknown',
      `公的発表をまだ受け取っていません。発表の有無は分かりません。${NOT_SAFE_NOTE}`);
  }
  if (!st.latest) {
    return result('unknown', null, nowMs, source,
      `受け取った公的発表が 1 件もありません。発表の有無は分かりません。${NOT_SAFE_NOTE}`);
  }

  const latest = normalizeEntry(st.latest, simulated);
  const recent = (Array.isArray(st.recent) ? st.recent : []).slice(0, RECENT_MAX).map((e) => normalizeEntry(e, simulated));
  const refMs = st.last_received_at ?? st.started_at ?? null;
  const serverMs = Number.isFinite(st.server_time) ? st.server_time : nowMs;
  const staleAfterMs = Number.isFinite(st.stale_after) ? st.stale_after * 1000 : null;
  const maybeStalled = refMs != null && staleAfterMs != null && serverMs - refMs > staleAfterMs;

  const parts = [];
  if (simulated) parts.push(MOCK_NOTE);
  if (maybeStalled) {
    parts.push(`更新が途絶えている可能性があります（最後に受け取ったのは ${formatJst(refMs)}）。表示中の情報は古い可能性があります。`);
  }
  parts.push(`最後に受け取った発表を、受け取ったまま表示しています。${NOT_SAFE_NOTE}`);

  return result('ok', {
    mock: simulated,
    latest,
    recent,
    maybe_stalled: maybeStalled,
    last_received_at: refMs,
  }, nowMs, source, parts.join(''));
}
