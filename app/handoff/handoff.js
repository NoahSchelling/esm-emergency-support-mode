// Handoff memo (pure; browsers and Node.js). The app fills a Markdown draft
// that the person (or family, or a helper on site) can copy or download and
// hand to Claude (with the Skill in skills/handoff-interview/) or to a
// person. BW-S4: the memo and the guide never give medical or mental-health
// advice; they only collect facts and point to public contacts.
//
// The automatic part sits between two markers, so it can be rebuilt from
// the history and the current values without touching what the person
// wrote by hand.

export const AUTO_START = '<!-- 自動で埋めた部分：ここから -->';
export const AUTO_END = '<!-- 自動で埋めた部分：ここまで -->';
export const DRAFT_KEY = 'bw-handoff-draft';
export const STORAGE_NOTE = 'この下書きはこの端末に保存されます。人に渡す前や、不要になったら「内容削除」を押してください。';

// For people without the Skill: paste this memo into Claude as it is.
export const INSTRUCTION = [
  '> **Claude へのお願い（このメモを貼り付けた人へ：この部分は消さずに渡してください）**',
  '> このメモは、防災アプリ「緊急支援モード」が作った伝達メモの下書きです。',
  '> 次のように手伝ってください。',
  '> - 一度に一つずつ、短い質問で、被災の状況・困っていること・体や気持ちの不調の内容を聞き取ってください。答えられない質問は飛ばしてください。',
  '> - 聞き取った内容を、医師・保健師・自治体の窓口などの専門家に見せられる Markdown にまとめてください。',
  '> - 水・食料・電源・連絡・公的な支援の窓口・手続きの段取りは、一緒に考えてください。',
  '> - 病気やけが、心の状態についての診断や助言はしないでください。急ぐときは 119、迷うときは #7119（使える地域）や自治体の相談窓口を案内してください。',
  '> - このメモの中の公的発表は、受信した記録です。最新の発表は気象庁・自治体で確かめるよう伝えてください。',
].join('\n');

// Stage from the hours since the start of the disaster, using the stage
// names and hours of modules/mode (passed in). -> { index, name } | null
export function stageAt(hours, stages, stageHours) {
  if (!Number.isFinite(hours) || hours < 0 || !Array.isArray(stages) || !stages.length) return null;
  let i = 0;
  let acc = 0;
  while (i < stageHours.length && hours >= acc + stageHours[i]) {
    acc += stageHours[i];
    i += 1;
  }
  return { index: i, name: stages[Math.min(i, stages.length - 1)] };
}

// How prominent the "Claude に相談する" guide is. It grows as the survival
// stage (index 2 in modules/mode: 発災直後, 安全確保後, サバイバル, ...)
// comes near. It never switches screens by itself.
//   'low'  : before or right after the disaster (index 0, or unknown)
//   'mid'  : index 1 (the survival stage comes next)
//   'high' : index 2 and later
export function guideProminence(stage) {
  if (!stage) return 'low';
  if (stage.index >= 2) return 'high';
  if (stage.index === 1) return 'mid';
  return 'low';
}

export function elapsedText(hours) {
  if (!Number.isFinite(hours)) return '分かりません';
  if (hours < 1) return `約 ${Math.max(1, Math.round(hours * 60))} 分`;
  if (hours < 48) return `約 ${Math.round(hours)} 時間`;
  return `約 ${Math.round(hours / 24)} 日`;
}

/**
 * Build the automatic part.
 * v: {
 *   createdText,            // when the memo was made (JST text)
 *   elapsedHours, stageName, // since the disaster (null when unknown)
 *   mark,                   // '【模擬】' / '【過去の記録の再生】' / ''
 *   announcements: [line],  // from the history, oldest first
 *   site: { name, municipality, distance } | null,
 *   heights: [{ label, text, warnText }],
 *   terrainNote,
 *   battery, network        // short texts
 * }
 * The position (latitude/longitude) is never written.
 */
export function buildAuto(v) {
  const L = [];
  L.push(AUTO_START);
  L.push('## アプリが自動で埋めた内容');
  if (v.mark) L.push('', `**${v.mark} この部分は、デモの内容です。実際の状況ではありません。**`);
  L.push('', `- 作成：${v.createdText}`);
  L.push(`- 発災からの時間：${elapsedText(v.elapsedHours)}${v.stageName ? `（段階の目安：${v.stageName}。！！仮の値！！）` : ''}`);
  L.push('', '### 受信した公的発表（この端末の情報履歴から、古い順）');
  if (v.announcements?.length) for (const a of v.announcements) L.push(`- ${a}`);
  else L.push('- 記録がありません（受信していないことは、発表がなかったという意味ではありません）');
  L.push('', '### 向かった避難場所（アプリが示した方向）');
  if (v.site) L.push(`- ${v.site.name}${v.site.municipality ? `（${v.site.municipality}）` : ''}${v.site.distance ? `、${v.site.distance}` : ''}`);
  else L.push('- 記録がありません');
  L.push('', '### 標高と予想される津波の高さ');
  if (v.heights?.length) for (const h of v.heights) L.push(`- ${h.label}：${h.text}${h.warnText ? `（⚠️${h.warnText}）` : ''}`);
  else L.push('- 記録がありません');
  if (v.terrainNote) L.push(`- ${v.terrainNote}`);
  L.push('', '### 端末の状態');
  L.push(`- 電池：${v.battery || '分かりません'}`);
  L.push(`- 通信：${v.network || '分かりません'}`);
  L.push('', '- 位置の座標は入れていません。必要なら、場所の目印（住所・建物の名前）を下に手で書いてください。');
  L.push(AUTO_END);
  return L.join('\n');
}

export function manualTemplate() {
  return [
    '## 本人・家族・支援者が書く内容',
    '',
    '- いる場所の目印：',
    '- 一緒にいる人の数：',
    '- 困っていること（水・食料・電源・連絡・薬など）：',
    '- 体や気持ちの不調の内容（あるがまま書く。判断はしない）：',
    '- 連絡を取りたい相手・窓口：',
    '- そのほか：',
  ].join('\n');
}

export function newDraft(auto) {
  return ['# 伝達メモ（緊急支援モード）', '', INSTRUCTION, '', auto, '', manualTemplate(), ''].join('\n');
}

// Replace the automatic part of a draft; if the markers are gone, put the
// new automatic part after the instruction (the hand-written text stays).
export function mergeAuto(draft, auto) {
  if (typeof draft !== 'string' || !draft.trim()) return newDraft(auto);
  const a = draft.indexOf(AUTO_START);
  const b = draft.indexOf(AUTO_END);
  if (a >= 0 && b > a) return draft.slice(0, a) + auto + draft.slice(b + AUTO_END.length);
  return `${auto}\n\n${draft}`;
}

export function downloadName(nowMs) {
  const t = new Date(nowMs + 9 * 3600 * 1000).toISOString();
  return `handoff_${t.slice(0, 10).replace(/-/g, '')}_${t.slice(11, 16).replace(':', '')}.md`;
}
