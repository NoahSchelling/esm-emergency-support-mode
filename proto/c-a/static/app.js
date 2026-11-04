// Prototype C-A screen. Plain JavaScript, no libraries.
// All external text is inserted with textContent (never as HTML).
"use strict";

const UI_REFRESH_MS = 3000;          // how often this page asks the local server
const LINK_LOST_MS = 10000;          // page considers the server unreachable after this
const NO_NEW_WARNING_MSG = "新しい警報は受信していません。安全という意味ではありません。";

let status = null;                   // last status received from the server
let clockOffset = 0;                 // server_time - local time
let lastStatusOkLocal = null;        // local time of last successful /api/status
let firstTryLocal = Date.now();
let pausedByDemo = false;            // demo: stop this page from polling

const $ = (id) => document.getElementById(id);

const timeFmt = new Intl.DateTimeFormat("ja-JP", {
  timeZone: "Asia/Tokyo", year: "numeric", month: "2-digit", day: "2-digit",
  hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false,
});

function fmtTime(ms) {
  if (ms == null) return "—";
  return timeFmt.format(new Date(ms)) + "（日本時間）";
}

function fmtDuration(ms) {
  if (ms < 0) ms = 0;
  const s = Math.floor(ms / 1000);
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), r = s % 60;
  if (h > 0) return `${h} 時間 ${m} 分 ${r} 秒`;
  if (m > 0) return `${m} 分 ${r} 秒`;
  return `${r} 秒`;
}

function fmtSeconds(sec) {
  return fmtDuration(sec * 1000);
}

function serverNow() {
  return Date.now() + clockOffset;
}

function setText(id, text) {
  $(id).textContent = text;
}

function el(tag, text, cls) {
  const e = document.createElement(tag);
  if (text != null) e.textContent = text;
  if (cls) e.className = cls;
  return e;
}

function isMock() {
  return status && status.source.mode === "mock";
}

// ------------------------------------------------------------ fetching

async function refresh() {
  if (pausedByDemo) return;
  try {
    const res = await fetch("/api/status", { cache: "no-store" });
    if (!res.ok) throw new Error("HTTP " + res.status);
    const s = await res.json();
    status = s;
    clockOffset = s.server_time - Date.now();
    lastStatusOkLocal = Date.now();
    renderStatic();
  } catch (e) {
    // Keep the last known state; tick() shows that the link is lost.
  }
  tick();
}

// ------------------------------------------------------------ rendering

// Parts that only change when a new status arrives.
function renderStatic() {
  const s = status;
  const mode = s.source.mode;

  document.title = (mode === "mock" ? "【模擬データ】" : "") + "公的発表の受信状況（試作 C-A）";

  $("banner-pending").hidden = mode !== "pending";
  const bm = $("banner-mock");
  bm.hidden = mode !== "mock";
  if (mode === "mock") {
    bm.textContent = "模擬データ：表示中の内容は気象庁の発表ではありません。"
      + (s.source.reason ? "（" + s.source.reason + "）" : "");
  }

  const bd = $("banner-demo");
  if (s.demo.stall) {
    bd.hidden = false;
    bd.textContent = "デモ：人工的に更新を途絶させています（"
      + (s.demo.stall === "fail" ? "取得失敗" : "内容が更新されない") + "）。"
      + fmtTime(s.demo.stall_since) + " から。";
  } else {
    bd.hidden = true;
  }

  setText("last-received", fmtTime(s.last_received_at));
  setText("last-fetch", fmtTime(s.last_fetch_ok_at));
  setText("last-error", s.last_error || "なし");
  setText("threshold-note",
    ` ${fmtSeconds(s.stale_after)} 以上新しい受信がないと「途絶えている可能性」を表示します。`
    + `サーバーは ${fmtSeconds(s.poll_interval)} ごとに取得します。`);

  renderLatest(s.latest);
  renderRecent(s.recent);
  renderFeeds(s.feeds);

  $("demo").hidden = !s.demo.enabled;
  $("btn-inject").hidden = !s.demo.can_inject_warning;

  if (mode === "live") {
    setText("source-note", "出典：気象庁 防災情報 XML。受信した内容をそのまま表示しています。"
      + "並べ替え・項目の抜き出し・経過時間の計算はこの試作による加工です。");
  } else if (mode === "mock") {
    setText("source-note", "模擬データ：この試作のプログラムが作った架空のデータです。気象庁の発表ではありません。"
      + (s.source.detail ? "実データを取得できなかった理由：" + s.source.detail : ""));
  } else {
    setText("source-note", "");
  }
}

function mockTag(parent) {
  if (isMock()) parent.appendChild(el("span", "模擬", "tag mock"));
}

function statusTag(parent, entry) {
  const st = entry.detail && entry.detail.status;
  if (st && st !== "通常") parent.appendChild(el("span", "運用種別：" + st, "tag"));
}

function areasText(entry) {
  const d = entry.detail;
  if (!d) return "読み込み中、または読み込んでいません";
  if (d.error) return "電文を取得できませんでした（" + d.error + "）";
  if (!d.areas || d.areas.length === 0) return "電文の見出しから読み取れませんでした";
  return d.areas.join("、");
}

function timeText(entry) {
  const d = entry.detail;
  if (d && d.report_datetime) return fmtTime(d.report_datetime) + "　※電文に書かれた発表時刻";
  return fmtTime(entry.updated) + "　※フィード上の更新時刻（電文の発表時刻は読み取れず）";
}

function renderLatest(e) {
  $("latest-empty").hidden = !!e;
  $("latest").hidden = !e;
  if (!e) return;
  const t = $("l-title");
  t.textContent = "";
  mockTag(t);
  statusTag(t, e);
  t.appendChild(document.createTextNode(e.title));
  setText("l-areas", areasText(e));
  setText("l-time", timeText(e));
  setText("l-author", e.author || "—");
  setText("l-infotype", (e.detail && e.detail.info_type) || "読み取れず");
  setText("l-content", e.content || "—");
  const l = $("l-link");
  l.textContent = "";
  if (isMock()) {
    l.textContent = "模擬データのため、元の電文はありません";
  } else if (e.link && e.link.startsWith("https://")) {
    const a = el("a", e.link);
    a.href = e.link;
    a.rel = "noopener noreferrer";
    a.target = "_blank";
    l.appendChild(a);
  } else {
    l.textContent = "—";
  }
}

function entryLine(e) {
  const li = el("li");
  mockTag(li);
  statusTag(li, e);
  li.appendChild(el("strong", e.title));
  li.appendChild(el("div", `対象地域：${areasText(e)}`, "muted"));
  li.appendChild(el("div", `発表時刻：${timeText(e)}`, "muted"));
  if (e.author) li.appendChild(el("div", `発表官署：${e.author}`, "muted"));
  return li;
}

function renderRecent(list) {
  const ul = $("recent");
  ul.textContent = "";
  if (!list || list.length === 0) {
    ul.appendChild(el("li", "まだ受信していません。", "muted"));
    return;
  }
  list.forEach((e) => ul.appendChild(entryLine(e)));
}

function renderFeeds(feeds) {
  const tb = $("feeds");
  tb.textContent = "";
  feeds.forEach((f) => {
    const tr = el("tr");
    tr.appendChild(el("td", f.label));
    tr.appendChild(el("td", fmtTime(f.last_ok_at)));
    tr.appendChild(el("td", fmtTime(f.last_changed_at)));
    tr.appendChild(el("td", f.error || "なし"));
    tb.appendChild(tr);
  });
}

// Parts that depend on the current time. Runs every second.
function tick() {
  const nowLocal = Date.now();

  // 1. Is this page still getting status from the local server?
  const linkLost = lastStatusOkLocal == null
    ? nowLocal - firstTryLocal > LINK_LOST_MS
    : nowLocal - lastStatusOkLocal > LINK_LOST_MS;
  const lm = $("link-msg");
  lm.hidden = !linkLost;
  if (linkLost) {
    lm.textContent = lastStatusOkLocal == null
      ? "この画面はサーバーから状態を受け取れていません。"
      : `この画面はサーバーから状態を受け取れていません（${fmtDuration(nowLocal - lastStatusOkLocal)} 前から）。表示は古いままです。`;
    if (pausedByDemo) lm.textContent += "（デモ：画面側の受信を人工的に止めています）";
  }

  if (!status) {
    setText("elapsed", "—");
    renderWarning(false, linkLost);
    renderStale(linkLost, linkLost);
    return;
  }

  // 2. Elapsed time since last receipt (keeps counting even if the link is lost).
  const sNow = serverNow();
  let stale;
  if (status.last_received_at == null) {
    const sinceStart = sNow - status.started_at;
    setText("elapsed", "まだ受信していません");
    stale = sinceStart > status.stale_after * 1000;
  } else {
    const elapsed = sNow - status.last_received_at;
    setText("elapsed", fmtDuration(elapsed));
    stale = elapsed > status.stale_after * 1000;
  }
  renderStale(stale, linkLost);
  renderWarning(stale, linkLost);
}

function renderStale(stale, linkLost) {
  const show = stale || linkLost;
  const msg = "更新が途絶えている可能性があります。表示中の情報は古い可能性があります。"
    + "気象庁や自治体の発表を直接確認してください。";
  $("banner-stale").hidden = !show;
  $("banner-stale").textContent = msg;
  $("stale-msg").hidden = !show;
  $("stale-msg").textContent = msg;
}

function renderWarning(stale, linkLost) {
  const msg = $("warning-msg");
  const extra = $("warning-extra");
  const list = $("warning-list");
  list.textContent = "";

  if (!status || status.source.mode === "pending" || status.last_received_at == null) {
    msg.textContent = "まだ受信していないため、警報の有無は分かりません。安全という意味ではありません。";
    extra.hidden = true;
    return;
  }

  const win = fmtSeconds(status.warning_window);
  const warnings = status.warnings_in_window || [];
  const notes = [];
  if (warnings.length === 0) {
    msg.textContent = NO_NEW_WARNING_MSG;
    notes.push(`直近 ${win} に、種類名に「警報」を含む電文を受信していない、という意味です。`);
  } else {
    msg.textContent = `直近 ${win} に、種類名に「警報」を含む電文を ${warnings.length} 件受信しました。内容は元の発表で確認してください。`;
    warnings.forEach((e) => list.appendChild(entryLine(e)));
  }
  if (stale || linkLost) {
    notes.push("受信が途絶えている可能性があるため、警報が出ていても受け取れていないかもしれません。");
  }
  extra.hidden = notes.length === 0;
  extra.textContent = notes.join(" ");
}

// ------------------------------------------------------------ demo controls

document.querySelectorAll("[data-demo]").forEach((b) => {
  b.addEventListener("click", async () => {
    try {
      await fetch("/api/demo/" + b.dataset.demo, { method: "POST" });
    } catch (e) { /* the page will show the link state */ }
    setTimeout(refresh, 300);
  });
});

$("btn-pause").addEventListener("click", () => {
  pausedByDemo = !pausedByDemo;
  $("btn-pause").textContent = pausedByDemo
    ? "画面側の受信を再開する（いま止めています）"
    : "画面側の受信を止める／再開する";
  if (!pausedByDemo) refresh();
});

refresh();
setInterval(refresh, UI_REFRESH_MS);
setInterval(tick, 1000);
