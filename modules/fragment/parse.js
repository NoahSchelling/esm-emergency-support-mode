// Fragment parser: reads short, fragmentary quake reports typed by a user.
//
// Design rules (see CLAUDE.md, BW-S1 / BW-S3 / BW-S4):
//  - Only extract what is written. Never add facts or judge danger.
//  - Anything not extracted is null. Unreadable input is "unknown", never "safe".
//  - If an input can be read in two or more ways, return every reading.
//  - The result is the user's own report (source "user"), not an official fact.
//  - No advice of any kind (mental health, medical, or otherwise).
//
// Pure JavaScript: no Node.js or browser APIs are used, so it loads anywhere.

export const MAX_INPUT_LENGTH = 200;
export const MAX_READINGS = 16;

const MASK = '\u0001';
const JST_OFFSET_MS = 9 * 60 * 60 * 1000;

const PREFECTURES = [
  '北海道', '青森', '岩手', '宮城', '秋田', '山形', '福島', '茨城', '栃木', '群馬',
  '埼玉', '千葉', '東京', '神奈川', '新潟', '富山', '石川', '福井', '山梨', '長野',
  '岐阜', '静岡', '愛知', '三重', '滋賀', '京都', '大阪', '兵庫', '奈良', '和歌山',
  '鳥取', '島根', '岡山', '広島', '山口', '徳島', '香川', '愛媛', '高知', '福岡',
  '佐賀', '長崎', '熊本', '大分', '宮崎', '鹿児島', '沖縄',
];
const REGIONS = ['関東', '東北', '関西', '近畿', '東海', '北陸', '九州', '四国'];

const KANJI_DIGITS = { 〇: 0, 一: 1, 二: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7 };
const RANGE_WORD = /^\s*(以上|以下|未満|超|程度|前後|くらい|ぐらい|ほど|級|台)/;
const TRAILING_PARTICLES = ['付近', '周辺', 'あたり', '辺り', 'ごろ', '頃', 'です', 'らしい', 'かも', 'で', 'の', 'は', 'が', 'を', 'に', 'も', 'だ'];
const NOT_A_PLACE = new Set(['不明', '不詳', '未定', '未確認']);

const CJK = '[\\u3400-\\u9fff々ヶ]';
const CJK_KANA = '[\\u3400-\\u9fff々ヶァ-ヶー]';
const RUN = /[぀-ヿ㐀-鿿々ー]+/g;
const SEA_RE = new RegExp(`^${CJK_KANA}{1,10}(沖|灘|湾|海域|近海|海溝|トラフ|沖合|海)$`);
const COAST_RE = new RegExp(`^${CJK_KANA}{1,10}沿岸$`);
const PREF_RE = new RegExp(`^(${[...PREFECTURES, ...REGIONS].join('|')})(県|府|都|道)?(([東西南北]{1,2}|中|内陸)部?)?(地方|方面)?$`);
const ADMIN_RE = new RegExp(`^${CJK}{1,6}(市|区|町|村|郡|半島|諸島|列島|島|地方|地域)$`);
const DIRECTION_RE = new RegExp(`^${CJK}{1,6}([東西南北]{1,2}|中|内陸)部$`);

// ---------------------------------------------------------------- time utils

const pad = (n, w = 2) => String(n).padStart(w, '0');

function toDate(now) {
  if (now === undefined || now === null) return new Date();
  const d = now instanceof Date ? new Date(now.getTime()) : new Date(now);
  return Number.isNaN(d.getTime()) ? null : d;
}

function jstParts(date) {
  const j = new Date(date.getTime() + JST_OFFSET_MS);
  return { y: j.getUTCFullYear(), m: j.getUTCMonth() + 1, d: j.getUTCDate(), hh: j.getUTCHours(), mm: j.getUTCMinutes(), ss: j.getUTCSeconds() };
}

function formatJstIso(date) {
  const p = jstParts(date);
  return `${p.y}-${pad(p.m)}-${pad(p.d)}T${pad(p.hh)}:${pad(p.mm)}:${pad(p.ss)}+09:00`;
}

function isRealDate(y, m, d) {
  if (m < 1 || m > 12 || d < 1) return false;
  const t = new Date(Date.UTC(y, m - 1, d));
  return t.getUTCFullYear() === y && t.getUTCMonth() === m - 1 && t.getUTCDate() === d;
}

function shiftDays(y, m, d, delta) {
  const t = new Date(Date.UTC(y, m - 1, d + delta));
  return { y: t.getUTCFullYear(), m: t.getUTCMonth() + 1, d: t.getUTCDate() };
}

// ------------------------------------------------------------ text utilities

function normalize(input) {
  return input
    .normalize('NFKC')
    .replace(/[​-‍⁠﻿]/g, '')
    .replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, ' ');
}

const prevIs = (w, i, re) => i > 0 && re.test(w[i - 1]);

function stripParticles(run) {
  let s = run;
  for (let changed = true; changed;) {
    changed = false;
    for (const p of TRAILING_PARTICLES) {
      if (s.length > p.length && s.endsWith(p)) { s = s.slice(0, -p.length); changed = true; break; }
    }
  }
  return s;
}

function placeKind(name) {
  if (name.length < 2) return null;
  if (SEA_RE.test(name)) return 'sea';
  if (COAST_RE.test(name)) return 'coast';
  if (PREF_RE.test(name) || ADMIN_RE.test(name) || DIRECTION_RE.test(name)) return 'generic';
  return null;
}

// ------------------------------------------------------------- atom reading
// An "atom" is one piece of the input that was recognised. It has one or more
// options; more than one option means the piece can be read in several ways.

function readAtoms(n, ctx) {
  let w = n;
  const atoms = [];
  const dates = [];
  const times = [];
  const mask = (s, e) => { w = w.slice(0, s) + MASK.repeat(e - s) + w.slice(e); };
  const reject = (text, reason) => ctx.notes.push(`「${text}」は${reason}ため、読み取りませんでした。`);
  const scan = (re, fn) => {
    const flags = re.flags.includes('g') ? re.flags : `${re.flags}g`;
    for (const m of [...w.matchAll(new RegExp(re.source, flags))]) fn(m, m.index, m.index + m[0].length);
  };
  const add = (atom) => { atoms.push(atom); mask(atom.start, atom.end); };
  const ranged = (e) => RANGE_WORD.test(w.slice(e));

  // Magnitude with a marker (M / マグニチュード / 規模).
  scan(/(M|マグニチュード|規模)\s*(\d{1,2}(?:\.\d)?)(?!\d|[.,、:]\d)/i, (m, s, e) => {
    if (prevIs(w, s, /[0-9A-Za-z]/)) return;
    const v = Number.parseFloat(m[2]);
    if (!(v > 0 && v <= 10)) return reject(m[0], '規模として範囲外（0を超え10以下）の');
    if (ranged(e)) return reject(m[0], '幅のある書き方の');
    add({ kind: 'magnitude', start: s, end: e, raw: m[0], options: [{ field: 'magnitude', value: { value: v, qualifier: null } }] });
  });

  // Depth: marker (d / 深さ / 深度) with optional unit, or a number with a km unit.
  scan(/(?:(深さ|深度|depth|d)\s*約?\s*(\d+(?:\.\d+)?)\s*(km|キロメートル|キロ)?|(\d+(?:\.\d+)?)\s*(km|キロメートル|キロ))(?![A-Za-z\d]|\.\d)/i, (m, s, e) => {
    if (prevIs(w, s, /[0-9A-Za-z.]/)) return;
    const hasMarker = m[1] !== undefined;
    const v = Number.parseFloat(hasMarker ? m[2] : m[4]);
    if (!(v >= 0 && v <= 800)) return reject(m[0], '深さとして範囲外（0〜800km）の');
    if (ranged(e)) return reject(m[0], '幅のある書き方の');
    add({ kind: 'depth', start: s, end: e, raw: m[0], options: [{ field: 'depth', value: { km: v, unitAssumed: hasMarker && m[3] === undefined } }] });
  });

  // Intensity with a marker (震度 / 最大 / 最大震度).
  scan(/(最大震度|最大|震度)\s*(?:は|が)?\s*([0-7〇一二三四五六七])\s*(弱|強|-|\+)?(?!\d|[-~〜]\d)/, (m, s, e) => {
    const digit = /\d/.test(m[2]) ? Number(m[2]) : KANJI_DIGITS[m[2]];
    const sign = m[3] === '-' ? '弱' : m[3] === '+' ? '強' : m[3] ?? null;
    const isMax = m[1].startsWith('最大');
    if (ranged(e)) return reject(m[0], '幅のある書き方の');
    let scale;
    if (digit === 5 || digit === 6) {
      scale = sign ? `${digit}${sign}` : String(digit);
      if (!sign) ctx.notes.push(`「${m[0]}」には弱・強の記載がないため、${digit}弱か${digit}強かは分かりません。`);
    } else if (sign === null) {
      scale = String(digit);
    } else {
      return reject(m[0], '震度の階級にない書き方の');
    }
    add({ kind: 'intensity', start: s, end: e, raw: m[0], marker: isMax ? 'max' : 'intensity', options: [{ field: 'intensity', value: { scale, max: isMax } }] });
  });

  // Dates (collected here, merged with times later).
  const addDate = (m, s, e, y, mo, d, hasYear) => {
    if (prevIs(w, s, /[\d./]/)) return;
    const year = hasYear ? y : jstParts(ctx.now).y;
    if (!isRealDate(year, mo, d)) {
      ctx.dateRejected = true; // a date was written but unreadable: do not fill in "today" for it
      return reject(m[0], '日付として読めない');
    }
    dates.push({ y: year, m: mo, d, hasYear, word: null, raw: m[0] });
    mask(s, e);
  };
  scan(/(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})(?!\d)/, (m, s, e) => addDate(m, s, e, +m[1], +m[2], +m[3], true));
  scan(/(\d{4})年\s*(\d{1,2})月\s*(\d{1,2})日/, (m, s, e) => addDate(m, s, e, +m[1], +m[2], +m[3], true));
  scan(/(\d{1,2})月\s*(\d{1,2})日/, (m, s, e) => addDate(m, s, e, 0, +m[1], +m[2], false));
  scan(/(\d{1,2})\/(\d{1,2})(?![\d/])/, (m, s, e) => addDate(m, s, e, 0, +m[1], +m[2], false));
  scan(/今日|本日|きょう|昨日|きのう/, (m, s, e) => {
    dates.push({ y: null, m: null, d: null, hasYear: false, word: /昨日|きのう/.test(m[0]) ? 'yesterday' : 'today', raw: m[0] });
    mask(s, e);
  });

  // Times: "午後4:30", "8時46分", "08:46", "0846".
  const addTime = (m, s, e, hour, minute, mer, hasMarker) => {
    const bad = (why) => reject(m[0], why);
    if (prevIs(w, s, /[0-9A-Za-z.:/-]/) && !hasMarker) return;
    if (minute > 59) return bad('時刻として読めない');
    let h = hour;
    if (mer) {
      if (h < 1 || h > 12) return bad('午前・午後の指定と時の数が合わない');
      if (mer === 'am' && h === 12) return bad('午前12時の指すものが分からない（0時か12時か）');
      h = mer === 'pm' ? (h % 12) + 12 : h;
    } else if (h > 23) {
      return bad('時刻として読めない');
    }
    times.push({ hour: h, minute, raw: m[0] });
    mask(s, e);
  };
  const merOf = (a, b) => {
    const t = (a ?? b ?? '').toLowerCase();
    return t === '午前' || t === 'am' ? 'am' : t === '午後' || t === 'pm' ? 'pm' : null;
  };
  scan(/(午前|午後|am|pm)?\s*(\d{1,2}):(\d{2})(?!\d|:\d)\s*(am|pm)?/i, (m, s, e) => addTime(m, s, e, +m[2], +m[3], merOf(m[1], m[4])));
  scan(/(午前|午後)?\s*(\d{1,2})時\s*(\d{1,2})分/, (m, s, e) => addTime(m, s, e, +m[2], +m[3], merOf(m[1], null)));
  scan(/(\d{4})(?![\d:.]|[/-]\d|\s*[A-Za-z年月日時分%]|\s*キロ)/, (m, s, e) => addTime(m, s, e, +m[1].slice(0, 2), +m[1].slice(2), null));

  // Bare "5弱" style: may be an intensity or a magnitude, so keep both readings.
  scan(/([56])\s*(弱|強)(?!\d)/, (m, s, e) => {
    if (prevIs(w, s, /[0-9A-Za-z.]/)) return;
    if (ranged(e)) return reject(m[0], '幅のある書き方の');
    add({
      kind: 'ambiguous-number', start: s, end: e, raw: m[0],
      options: [
        { field: 'intensity', value: { scale: `${m[1]}${m[2]}`, max: false } },
        { field: 'magnitude', value: { value: Number(m[1]), qualifier: m[2] } },
      ],
    });
  });

  // Places. An explicit "震源" marker settles the role as epicenter.
  scan(/震源(?:地|域)?[\s:はが]*([぀-ヿ㐀-鿿々ー]+)/, (m, s, e) => {
    const name = stripParticles(m[1]);
    const ok = placeKind(name) !== null || (/^[㐀-鿿々ァ-ヶー]{2,8}$/.test(name) && !NOT_A_PLACE.has(name));
    if (!ok) return;
    add({ kind: 'place', start: s, end: e, raw: m[0], options: [{ field: 'epicenter', value: name }] });
  });
  const placeAtoms = [];
  for (const m of [...w.matchAll(RUN)]) {
    const name = stripParticles(m[0]);
    const kind = placeKind(name);
    if (!kind) continue;
    const s = m.index;
    const e = s + m[0].length;
    const options = kind === 'sea' ? [{ field: 'epicenter', value: name }]
      : kind === 'coast' ? [{ field: 'area', value: name }]
        : [{ field: 'epicenter', value: name }, { field: 'area', value: name }];
    placeAtoms.push({ kind: 'place', start: s, end: e, raw: m[0], options, generic: kind === 'generic' });
  }
  // A place right next to a "震度" intensity is read as the area it was felt in.
  for (const p of placeAtoms) {
    if (p.generic) {
      const near = atoms.some((a) => a.kind === 'intensity' && a.marker === 'intensity'
        && ((a.end <= p.start && /^[\s,、:]*$/.test(n.slice(a.end, p.start)))
          || (p.end <= a.start && /^[\s,、:]*$/.test(n.slice(p.end, a.start)))));
      if (near) p.options = [{ field: 'area', value: p.options[0].value }];
    }
    add(p);
  }

  return { atoms, dates, times };
}

// --------------------------------------------------------- time construction

function buildTimes(dates, times, ctx) {
  const out = [];
  const dateChoices = dates.length ? dates : [null];
  const timeChoices = times.length ? times : [null];
  const today = jstParts(ctx.now);
  for (const d of dateChoices) {
    for (const t of timeChoices) {
      if (!d && !t) continue;
      let ymd = null;
      let basis = null;
      if (d && d.word === 'today') { ymd = { y: today.y, m: today.m, d: today.d }; basis = 'relative-word'; }
      else if (d && d.word === 'yesterday') { ymd = shiftDays(today.y, today.m, today.d, -1); basis = 'relative-word'; }
      else if (d) { ymd = { y: d.y, m: d.m, d: d.d }; basis = d.hasYear ? 'input' : 'input-year-assumed'; }
      else if (ctx.assumeToday && !ctx.dateRejected) { ymd = { y: today.y, m: today.m, d: today.d }; basis = 'assumed-today'; }
      const dateText = ymd ? `${pad(ymd.y, 4)}-${pad(ymd.m)}-${pad(ymd.d)}` : null;
      let iso = null;
      if (ymd && t) {
        const epoch = Date.UTC(ymd.y, ymd.m - 1, ymd.d, t.hour, t.minute) - JST_OFFSET_MS;
        if (epoch > ctx.now.getTime() + 60 * 1000) {
          basis = 'unresolved';
          ctx.notes.push(`時刻「${pad(t.hour)}:${pad(t.minute)}」を${dateText}とすると現在より先になるため、日付を決めていません（昨日かもしれませんが、決めつけていません）。`);
          // Keep the date text out of the result: it would be a guess.
          out.push({ date: null, dateBasis: basis, hour: t.hour, minute: t.minute, text: `${pad(t.hour)}:${pad(t.minute)}`, iso: null });
          continue;
        }
        iso = `${dateText}T${pad(t.hour)}:${pad(t.minute)}:00+09:00`;
      }
      if (basis === 'assumed-today') ctx.assumedToday = dateText;
      if (basis === 'input-year-assumed') ctx.assumedYear = true;
      if (t) ctx.timeRead = true;
      out.push({ date: dateText, dateBasis: basis, hour: t ? t.hour : null, minute: t ? t.minute : null, text: t ? `${pad(t.hour)}:${pad(t.minute)}` : null, iso });
    }
  }
  return out;
}

// ----------------------------------------------------------- reading assembly

const FIELDS = ['time', 'epicenter', 'magnitude', 'depth', 'intensity', 'area'];
const emptyReading = () => Object.fromEntries(FIELDS.map((f) => [f, null]));

function buildReadings(atoms, ctx) {
  if (atoms.length === 0) return [emptyReading()];
  let assignments = [[]];
  for (const a of atoms) {
    const next = [];
    for (const base of assignments) for (const opt of a.options) next.push([...base, opt]);
    assignments = next;
    if (assignments.length > 4096) break;
  }
  const clean = [];
  const conflicted = [];
  for (const asg of assignments) {
    const byField = new Map();
    for (const o of asg) {
      const list = byField.get(o.field) ?? [];
      if (!list.some((v) => JSON.stringify(v) === JSON.stringify(o.value))) list.push(o.value);
      byField.set(o.field, list);
    }
    (([...byField.values()].some((l) => l.length > 1)) ? conflicted : clean).push(byField);
  }
  const chosen = clean.length ? clean : conflicted;
  if (clean.length && conflicted.length) {
    ctx.notes.push('同じ項目が2つになる読み方は候補から外しました（例：すでに規模があるのに、別の数字をさらに規模として読む読み方）。外した読み方の方が正しい場合があります。');
  }
  const readings = [];
  for (const byField of chosen) {
    let partial = [emptyReading()];
    for (const [field, values] of byField) {
      const next = [];
      for (const r of partial) for (const v of values) next.push({ ...r, [field]: v });
      partial = next;
    }
    readings.push(...partial);
  }
  const seen = new Set();
  return readings.filter((r) => { const k = JSON.stringify(r); if (seen.has(k)) return false; seen.add(k); return true; });
}

// ------------------------------------------------------------------ questions

function readQuestions(n, atoms) {
  const found = [];
  const dropped = new Set();
  const masked = [];
  const overlapping = (s, e) => atoms.filter((a) => a.start < e && s < a.end);
  const isBreak = (c) => /[\s、。,;!]/.test(c);
  for (let q = n.indexOf('?'); q !== -1; q = n.indexOf('?', q + 1)) {
    masked.push([q, q + 1]);
    let end = q;
    while (end > 0 && /\s/.test(n[end - 1])) end -= 1;
    const chunks = [];
    let cursor = end;
    for (;;) {
      let s = cursor;
      while (s > 0 && !isBreak(n[s - 1]) && n[s - 1] !== '?') s -= 1;
      if (s === cursor) break;
      const hit = overlapping(s, cursor);
      if (hit.length) {
        if (chunks.length === 0) { chunks.unshift([s, cursor]); hit.forEach((a) => dropped.add(a)); }
        break;
      }
      chunks.unshift([s, cursor]);
      let p = s;
      while (p > 0 && /\s/.test(n[p - 1])) p -= 1;
      if (p === s || p === 0 || n[p - 1] === '?' || isBreak(n[p - 1]) && !/\s/.test(n[p - 1])) break;
      cursor = p;
    }
    if (chunks.length) {
      found.push(chunks.map(([s, e]) => n.slice(s, e)).join(' '));
      chunks.forEach((c) => masked.push(c));
    }
  }
  return { texts: found, hasQuestion: n.includes('?'), dropped, masked };
}

// ------------------------------------------------------------------- main API

function makeResult(ctx, status, value, detail) {
  return { kind: 'fragment', status, value, observed_at: formatJstIso(ctx.now), source: ctx.source, detail };
}

/**
 * Read a short fragmentary report typed by a user.
 * @param {string} input raw text
 * @param {{now?: Date|string|number, assumeToday?: boolean, simulated?: boolean}} [options]
 *   now: the current time (for tests/replays). assumeToday: treat a missing date as today (default true).
 *   simulated: mark the result source as "simulated" (replayed or fake data).
 */
export function parseFragment(input, options = {}) {
  const now = toDate(options.now);
  const ctx = {
    now: now ?? new Date(),
    source: options.simulated ? 'simulated' : 'user',
    assumeToday: options.assumeToday !== false,
    notes: [],
    assumedToday: null,
    assumedYear: false,
    timeRead: false,
    dateRejected: false,
  };
  const SAFE = '危険かどうか、安全かどうかの判断はしていません。';
  if (now === null) return makeResult(ctx, 'error', null, `現在時刻の指定を読めませんでした。入力は読み取っていません。${SAFE}`);
  if (typeof input !== 'string') return makeResult(ctx, 'error', null, `入力が文字列ではありませんでした。入力は読み取っていません。${SAFE}`);
  if (input.length > MAX_INPUT_LENGTH) {
    return makeResult(ctx, 'unsupported', null, `入力が${MAX_INPUT_LENGTH}文字を超えています。このモジュールは短い断片の入力だけを読みます。入力は読み取っていません。${SAFE}`);
  }
  const n = normalize(input).trim();
  if (n === '') return makeResult(ctx, 'unknown', null, `入力が空でした。読み取れる項目がありません。${SAFE}`);

  const { atoms: allAtoms, dates, times } = readAtoms(n, ctx);
  const q = readQuestions(n, allAtoms);
  const atoms = allAtoms.filter((a) => !q.dropped.has(a));
  if (q.dropped.size) ctx.notes.push('「？」を付けて書かれた項目は、申告ではなく問いとして扱い、項目には入れていません。');

  // Dates and times that sit inside a question are dropped too (by position).
  const inQuestion = (raw) => q.texts.some((t) => t.includes(raw));
  const liveDates = dates.filter((d) => !inQuestion(d.raw));
  const liveTimes = times.filter((t) => !inQuestion(t.raw));
  const timeFields = buildTimes(liveDates, liveTimes, ctx);
  const allUnits = [...atoms, ...timeFields.map((t) => ({ kind: 'time', options: [{ field: 'time', value: t }] }))];
  // Several time candidates are alternatives of one field, so they stay separate atoms of the same field.
  const readings = buildReadings(allUnits, ctx);
  if (readings.length > MAX_READINGS) {
    return makeResult(ctx, 'unknown', null, `読み方が${MAX_READINGS}通りを超え、どれにも決められませんでした。短く分けて入力してください。${SAFE}`);
  }

  // Leftover text that was not read at all.
  let rest = n;
  for (const a of allAtoms) rest = rest.slice(0, a.start) + MASK.repeat(a.end - a.start) + rest.slice(a.end);
  for (const [s, e] of q.masked) rest = rest.slice(0, s) + MASK.repeat(e - s) + rest.slice(e);
  const usedRaws = [...dates, ...times].filter((x) => !inQuestion(x.raw)).map((x) => x.raw);
  for (const raw of usedRaws) rest = rest.replace(raw, (m) => MASK.repeat(m.length));
  const unrecognized = rest.split(/[\s\u0001、。,;]+/).filter((t) => t && !/^[\p{P}\p{S}]+$/u.test(t));

  const anyField = readings.some((r) => FIELDS.some((f) => r[f] !== null));
  const question = q.hasQuestion ? { texts: q.texts } : null;
  if (!anyField && !question) {
    const extra = unrecognized.length ? '読み取れなかった部分は、入力のまま残しています。' : '';
    return makeResult(ctx, 'unknown', null, `利用者の入力から、時刻・震源・規模・深さ・震度・地域・問いのどれも読み取れませんでした。${extra}${SAFE}`);
  }

  const ambiguous = readings.length > 1;
  const parts = ['利用者の申告を機械的に読み取りました。公的に確認された情報ではありません。'];
  if (ctx.timeRead) parts.push('時刻は日本時間として読みました（推定）。');
  if (ctx.assumedToday) parts.push(`日付の記載がないため、今日（${ctx.assumedToday}、日本時間）とみなしました。これは推定です。`);
  if (ctx.assumedYear) parts.push('年の記載がないため、今年とみなしました。これは推定です。');
  if (ambiguous) parts.push(`読み方が${readings.length}通りあります。すべてを候補として返し、どれかに決めていません。`);
  if (readings.some((r) => r.depth && r.depth.unitAssumed)) parts.push('深さに単位の記載がないため、kmとして読みました（推定）。');
  if (unrecognized.length) parts.push('読み取れなかった部分があります（value.unrecognized）。');
  parts.push(...ctx.notes);
  parts.push(SAFE);

  return makeResult(ctx, 'ok', {
    input,
    readings,
    ambiguous,
    question,
    unrecognized,
    notes: [...ctx.notes],
    officiallyConfirmed: false,
  }, parts.join(''));
}
