// Browser-only wiring of the handoff memo panel. The draft is filled from
// the history and the current values (globalThis.__handoffSources, set by
// ../shell/shell-main.js and ../evac/evac-main.js), edited by hand, saved on
// this device as it is typed, and copied or downloaded as .md. "内容削除"
// clears the text and the saved copy. Nothing is sent anywhere.
// Every text is inserted with textContent / value, never as HTML.

import { buildAuto, newDraft, mergeAuto, downloadName, DRAFT_KEY } from './handoff.js';
import { formatJstHm } from '../evac/model.js';

const $ = (id) => document.getElementById(id);

function storage() {
  try {
    return globalThis.localStorage ?? null;
  } catch {
    return null;
  }
}
function loadDraft() {
  try { return storage()?.getItem(DRAFT_KEY) ?? null; } catch { return null; }
}
function saveDraft(text) {
  try { storage()?.setItem(DRAFT_KEY, text); return true; } catch { return false; }
}
function dropDraft() {
  try { storage()?.removeItem(DRAFT_KEY); } catch { /* ignore */ }
}

// Battery and network, read only when the memo is built.
let sensors = null;
async function deviceTexts() {
  try {
    if (!sensors) {
      const S = await import(new URL('../../modules/sensors/index.js', import.meta.url));
      const env = S.createDeviceEnv();
      sensors = { battery: S.createBatterySensor({ env }), online: S.createOnlineSensor({ env }), network: S.createNetworkSensor({ env }) };
      for (const x of Object.values(sensors)) x.start();
      await new Promise((r) => setTimeout(r, 300));
    }
    const b = sensors.battery.read();
    const o = sensors.online.read();
    const n = sensors.network.read();
    const battery = b.status === 'ok' && b.value.level_percent != null ? `残量 ${b.value.level_percent}%${b.value.charging ? '（充電中）' : ''}` : '分かりません（この端末・ブラウザでは取れません）';
    const parts = [];
    if (o.status === 'ok') parts.push(o.value.online ? 'オンライン（公的な情報源に届くとは限りません）' : 'オフライン');
    if (n.status === 'ok') {
      const t = [n.value.type && `種類 ${n.value.type}`, n.value.effective_type && `実効 ${n.value.effective_type}`].filter(Boolean).join('、');
      if (t) parts.push(t);
    }
    return { battery, network: parts.join('、') || '分かりません' };
  } catch {
    return { battery: '分かりません', network: '分かりません' };
  }
}

async function autoPart() {
  const src = globalThis.__handoffSources ?? {};
  const dev = await deviceTexts();
  const now = Date.now();
  const d = new Date(now + 9 * 3600 * 1000).toISOString();
  return buildAuto({
    createdText: `${d.slice(0, 10)} ${formatJstHm(now)}（日本時間）`,
    elapsedHours: Number.isFinite(src.elapsedHours) ? src.elapsedHours : null,
    stageName: src.stageName ?? null,
    mark: src.mark ?? '',
    announcements: src.announcements ?? [],
    site: src.site ?? null,
    heights: src.heights ?? [],
    terrainNote: src.terrainNote ?? '',
    battery: dev.battery,
    network: dev.network,
  });
}

const panel = $('handoff-panel');
const text = $('handoff-text');
function status(t) { $('handoff-status').textContent = t; }

async function open() {
  panel.hidden = false;
  const saved = loadDraft();
  if (saved) {
    text.value = saved;
    status('この端末に保存していた下書きを戻しました。');
  } else {
    text.value = newDraft(await autoPart());
    status('アプリが自動で埋めた下書きを作りました。');
  }
  panel.scrollIntoView?.({ block: 'start' });
  text.focus();
}

$('handoff-open').addEventListener('click', () => { open(); });
$('handoff-close').addEventListener('click', () => { panel.hidden = true; $('handoff-open').focus(); });
// Hand edits are saved on this device as they are typed.
text.addEventListener('input', () => {
  status(saveDraft(text.value) ? 'この端末に保存しました。' : 'この端末に保存できませんでした（閉じると消えます）。');
});
$('handoff-rebuild').addEventListener('click', async () => {
  text.value = mergeAuto(text.value, await autoPart());
  saveDraft(text.value);
  status('自動の部分を、情報履歴と今の値から作り直しました（手で書いた部分はそのままです）。');
});
$('handoff-clear').addEventListener('click', () => {
  text.value = '';
  dropDraft();
  status('下書きと、この端末に保存していた内容を削除しました。');
});
$('handoff-copy').addEventListener('click', async () => {
  try {
    await navigator.clipboard.writeText(text.value);
    status('コピーしました。');
  } catch {
    text.select();
    status('コピーできませんでした。選んだ文を長押しなどでコピーしてください。');
  }
});
$('handoff-download').addEventListener('click', () => {
  const blob = new Blob([text.value], { type: 'text/markdown;charset=utf-8' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = downloadName(Date.now());
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  status(`${a.download} を保存しました（端末のダウンロードの場所）。`);
});

// For automated browser checks only.
globalThis.__handoff = { open, autoPart };
