// Display names and badge classes for the common result statuses.
// No label may read as "safe" or "normal" (BW-S3): "ok" only means a value
// was obtained. Works in browsers and Node.js.

export const STATUS_LABELS = Object.freeze({
  ok: '取れた',
  denied: '許可なし',
  unsupported: '非対応',
  insecure: '使えない（HTTPS ではない）',
  error: '失敗',
  stale: '古い（更新が止まっている）',
  unknown: 'まだ値がない・分からない',
  missing: '未実装',
});

// Appended to the detail of every result that has no value.
export const NO_VALUE_NOTE = '値がないことは、異常がない・安全という意味ではありません。';

export function statusLabel(status) {
  return Object.hasOwn(STATUS_LABELS, status) ? STATUS_LABELS[status] : `状態が分からない（${String(status)}）`;
}

// Colours (app.css): blue = obtained, orange = not obtained / unknown,
// red = stale, grey = not implemented. Never green.
const STATUS_CLASSES = Object.freeze({
  ok: 'st-ok',
  stale: 'st-stale',
  missing: 'st-missing',
  mock: 'st-mock',
});

export function statusClass(status) {
  return Object.hasOwn(STATUS_CLASSES, status) ? STATUS_CLASSES[status] : 'st-none';
}

/**
 * Badge text for a result. okLabel replaces "取れた" for results that are
 * not sensor readings (e.g. "判定した", "読み取れた", "受信あり").
 */
export function resultLabel(r, okLabel = null) {
  if (!r) return statusLabel('unknown');
  if (r.missing) return STATUS_LABELS.missing;
  if (r.status === 'ok' && okLabel) return okLabel;
  return statusLabel(r.status);
}

export function resultClass(r) {
  if (!r) return statusClass('unknown');
  return r.missing ? statusClass('missing') : statusClass(r.status);
}

/**
 * Result in the common shape for a module that could not be loaded.
 * status "unsupported" with no value; `missing: true` makes it show as 未実装.
 * @param {string} kind
 * @param {number} nowMs epoch milliseconds
 * @param {(ms: number) => string} toIso formatter for observed_at
 */
export function missingResult(kind, nowMs, toIso) {
  return Object.freeze({
    kind,
    status: 'unsupported',
    value: null,
    observed_at: toIso(nowMs),
    source: 'app',
    detail: `${kind} のモジュールを読み込めなかったため、未実装として扱っています。`,
    missing: true,
  });
}
