// Prototype C-B front end. All external strings are inserted with textContent.
"use strict";

function el(tag, attrs, ...children) {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (k === "class") e.className = v;
    else e.setAttribute(k, v);
  }
  for (const c of children) {
    if (c == null) continue;
    e.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
  return e;
}

function checksList(checks) {
  if (!checks || checks.length === 0) return null;
  const failed = checks.filter((c) => !c.ok);
  const ul = el("ul");
  for (const c of checks) {
    ul.append(el("li", {}, el("span", { class: c.ok ? "" : "x" }, c.ok ? "一致　" : "食い違い　"),
      `${c.name}：${c.detail}`));
  }
  const summary = failed.length
    ? `照合の結果（食い違い ${failed.length} 件 / 確認 ${checks.length} 件）`
    : `照合の結果（確認 ${checks.length} 件、食い違いは見つかりませんでした）`;
  const d = el("details", {}, el("summary", {}, summary), ul);
  if (failed.length) d.open = true;
  return d;
}

function viewTable(rows) {
  const t = el("table", { class: "view" });
  for (const r of rows) t.append(el("tr", {}, el("th", { scope: "row" }, r.label), el("td", {}, r.value)));
  return t;
}

function card(item) {
  const link = item.source_url
    ? el("a", { href: item.source_url, rel: "noopener noreferrer" }, "元の電文（気象庁ホームページ）")
    : null;
  const header = el("header", {},
    el("div", { class: "title" }, item.head_title),
    el("div", { class: "time" }, "発表時刻：", el("strong", {}, item.report_jst)),
    el("div", { class: "meta" },
      `${item.editorial_office}　／　情報の形態：${item.info_type}　／　${item.control_title}`),
    el("div", { class: "meta" }, link, item.fetched_at_utc ? `　取得：${item.fetched_at_utc}（UTC）` : ""),
  );

  const left = el("div", { class: "col" }, el("h3", {}, "原文（電文の値。市町村・観測点・予想の値は省略）"),
    viewTable(item.view));

  const p = item.paraphrase;
  const right = el("div", { class: "col" }, el("h3", {}, "言い換え（試作）"));
  if (p.shown) {
    right.append(el("p", { class: "para" }, p.text));
  } else {
    right.append(el("p", { class: "blocked" }, p.reason));
  }
  const cl = checksList(p.checks);
  if (cl) right.append(cl);

  return el("article", { class: "card" }, header, el("div", { class: "cols" }, left, right));
}

function testsTable(rows) {
  const tbody = document.querySelector("#tests tbody");
  tbody.replaceChildren();
  for (const t of rows) {
    const reasons = el("ul");
    for (const f of t.failed) reasons.append(el("li", {}, `${f.name}：${f.detail}`));
    tbody.append(el("tr", {},
      el("td", {}, `${t.bulletin}（${t.report_jst}）`),
      el("td", {}, `${t.id}：${t.error}`),
      el("td", {}, t.blocked ? "止めた" : "通してしまった"),
      el("td", {}, t.failed.length ? reasons : "—"),
    ));
  }
}

async function load() {
  const errorBox = document.getElementById("error");
  try {
    const r = await fetch("/api/items", { cache: "no-store" });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const s = await r.json();
    document.getElementById("paraphraser").textContent = `言い換えの作り方：${s.paraphraser}`;
    document.getElementById("source").textContent =
      `${s.source_note}（各電文の「元の電文」のリンク先）`;
    const items = document.getElementById("items");
    items.replaceChildren(...s.items.map(card));
    if (s.items.length === 0) items.append(el("p", {}, "表示できる電文がありません。"));
    if (s.load_errors.length) {
      errorBox.hidden = false;
      errorBox.textContent = "読めなかった電文があります：" + s.load_errors.join("／");
    }
    testsTable(s.selftest);
  } catch (e) {
    errorBox.hidden = false;
    errorBox.textContent = `サーバーから内容を受け取れませんでした（${e.message}）。`;
  }
}

load();
