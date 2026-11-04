"""Mechanical fact check between a JMA bulletin and a plain-language paraphrase.

The checker does not understand Japanese. It extracts surface tokens
(date/times, numbers, seismic intensities, warning kinds and statuses, area
names, cancel/correction words, and words that signal forecasts, guesses or
advice) and compares them with the facts in the bulletin's view.

Policy: when in doubt, block. A blocked paraphrase is not shown; the original
is always shown. False positives are acceptable, false negatives are not
(but some are unavoidable; see docs/proto/c-b.md).
"""

from __future__ import annotations

import datetime as dt
import re
import unicodedata
from dataclasses import dataclass, field

from bulletin import NO_WARNING_STATUS, Bulletin, format_jst

JST = dt.timezone(dt.timedelta(hours=9))

# Words that must never appear (BW-S3: no "safe"; BW-S4: no mental-health or
# medical advice).
BANNED_WORDS = (
    "安全", "安心", "大丈夫", "問題ない", "問題ありません", "心配いりません", "心配ない",
    "落ち着", "深呼吸", "不安", "ストレス", "こころ", "心のケア", "メンタル",
    "病院", "受診", "医師", "医療", "救急", "薬", "けが", "怪我", "体調", "健康", "相談",
)

# Words that signal forecasts, guesses, judgments or advice (BW-S1). Each may
# appear at most as many times as it appears in the original.
LIMITED_WORDS = (
    "注意して", "警戒", "避難", "備え", "確認して", "心配", "おそれ", "恐れ", "可能性",
    "見込", "予想", "予報", "今後", "引き続き", "でしょう", "かもしれ", "はず", "余震",
    "被害", "ください", "ましょう", "必要", "べき", "ほうが", "続く", "続き",
    "収ま", "おさま", "弱ま", "強ま", "強い", "激しい", "大きい", "大きな", "小さ", "弱い",
    "約", "およそ", "ほど", "程度", "きょう", "今日", "昨日", "きのう", "明日", "あす",
    "今夜", "未明", "直ちに", "すぐに", "念のため",
)

# Negations. A paraphrase must not negate more than the original does
# (e.g. "解除されていません" would otherwise pass as status 解除).
NEGATION_WORDS = ("ません", "ない", "なく", "ではな", "じゃな")

# Clock notation that the date/time check cannot read.
COLON_TIME_RE = re.compile(r"\d{1,2}[:：]\d{2}")

# Bare level words, counted after kind/status tokens and the title are removed.
LEVEL_WORDS = ("特別警報", "危険警報", "警報", "注意報")

CANCEL_WORDS = ("取消", "取り消", "取りけし")
CORRECT_WORDS = ("訂正",)

WARNING_PHENOMENA = (
    "暴風雪", "土砂災害", "大雨", "洪水", "高潮", "暴風", "強風", "風雪", "波浪", "大雪",
    "雷", "乾燥", "濃霧", "なだれ", "低温", "霜", "着氷", "着雪", "融雪",
)
WARNING_LEVELS = ("特別警報", "危険警報", "警報", "注意報")
KIND_RE = re.compile(
    "(?:" + "|".join(sorted(WARNING_PHENOMENA, key=len, reverse=True)) + ")"
    "(?:" + "|".join(WARNING_LEVELS) + ")"
)
WARNING_STATUSES = (
    NO_WARNING_STATUS,
    "特別警報から危険警報", "特別警報から警報", "特別警報から注意報",
    "危険警報から警報", "危険警報から注意報", "警報から注意報",
    "発表", "継続", "解除",
)

PREFECTURES = (
    "北海道", "青森県", "岩手県", "宮城県", "秋田県", "山形県", "福島県", "茨城県", "栃木県",
    "群馬県", "埼玉県", "千葉県", "東京都", "神奈川県", "新潟県", "富山県", "石川県", "福井県",
    "山梨県", "長野県", "岐阜県", "静岡県", "愛知県", "三重県", "滋賀県", "京都府", "大阪府",
    "兵庫県", "奈良県", "和歌山県", "鳥取県", "島根県", "岡山県", "広島県", "山口県", "徳島県",
    "香川県", "愛媛県", "高知県", "福岡県", "佐賀県", "長崎県", "熊本県", "大分県", "宮崎県",
    "鹿児島県", "沖縄県",
)

DATETIME_RE = re.compile(
    r"(?:(?:(\d{4})年)?(?:(\d{1,2})月)?(\d{1,2})日(?:の|、)?)?"
    r"(午前|午後)?(\d{1,2})時(?:(\d{1,2})分|(半))?"
)
DATE_RE = re.compile(r"(?:(\d{4})年)?(\d{1,2})月(\d{1,2})日")
INTENSITY_RE = re.compile(r"(最大)?震度(?:は)?([0-7](?:弱|強)?)(以上)?")
NUMBER_RE = re.compile(r"\d+(?:\.\d+)?")
MAGNITUDE_RE = re.compile(r"(?:M|マグニチュード)(?:は)?(\d+(?:\.\d+)?)")
DEPTH_RE = re.compile(r"(\d+(?:\.\d+)?)(?:km|キロメートル|キロ)")
KANJI_NUMERAL_RE = re.compile(
    r"[〇零一二三四五六七八九十百千]+(?:時|分|日|月|年|km|キロ|メートル|度|回|件|か所|箇所)"
    r"|震度[〇一二三四五六七]"
)
SENTENCE_SPLIT = re.compile(r"[。\n]")
CLAUSE_SPLIT = re.compile(r"[、,]")


def norm(s: str) -> str:
    """NFKC (full-width digits -> ASCII etc.) and drop all whitespace."""
    s = unicodedata.normalize("NFKC", s)
    return re.sub(r"\s+", "", s)


@dataclass
class Check:
    name: str
    ok: bool
    detail: str


@dataclass
class Result:
    checks: list[Check] = field(default_factory=list)

    @property
    def ok(self) -> bool:
        return bool(self.checks) and all(c.ok for c in self.checks)

    def failures(self) -> list[Check]:
        return [c for c in self.checks if not c.ok]

    def add(self, name: str, ok: bool, detail: str) -> None:
        self.checks.append(Check(name, ok, detail))


@dataclass
class _Facts:
    corpus: str
    title: str
    times: list[dt.datetime]
    required_times: list[tuple[str, dt.datetime]]
    numbers: set[str]
    view_areas: set[str]
    other_names: set[str]
    # earthquake
    intensity_pairs: set[tuple[str, str]]
    required_intensity: list[tuple[str, str]]
    intensities: set[str]
    max_intensity: str | None
    # warning
    kinds: set[str]
    triples: set[tuple[str, str | None, str]]
    required_triples: list[tuple[str, str, str]]
    notes: set[str]


def _facts(b: Bulletin) -> _Facts:
    corpus = norm("".join(r["value"] for r in b.view()))
    times = [t for t in (b.report_datetime, b.target_datetime, b.origin_time) if t]
    times += _times_in_text(norm(b.headline_text), b.report_datetime)
    times = [t.astimezone(JST) for t in times]
    numbers = set(NUMBER_RE.findall(corpus))
    for t in times:
        numbers.update({str(t.year), str(t.month), str(t.day), str(t.hour), str(t.minute)})
    required_times = [("発表時刻", b.report_datetime.astimezone(JST))]
    if b.origin_time:
        required_times.append(("発生時刻", b.origin_time.astimezone(JST)))

    view_areas: set[str] = set()
    intensity_pairs: set[tuple[str, str]] = set()
    required_intensity: list[tuple[str, str]] = []
    if b.hypocenter:
        view_areas.add(norm(b.hypocenter))
    for a in b.intensity_areas:
        name = norm(a.name)
        view_areas.add(name)
        intensity_pairs.add((name, a.label))
        if a.level == "細分区域":
            required_intensity.append((name, a.label))
            # a prefecture may be paired with any intensity observed in it
            intensity_pairs.add((norm(a.pref), a.label))
    intensities = {a.label for a in b.intensity_areas}
    intensities.update(m.group(2) for m in INTENSITY_RE.finditer(norm(b.headline_text)))

    kinds: set[str] = set()
    triples: set[tuple[str, str | None, str]] = set()
    required_triples: list[tuple[str, str, str]] = []
    notes: set[str] = set()
    for wa in b.warning_areas:
        name = norm(wa.name)
        view_areas.add(name)
        if not wa.kinds:
            triples.add((name, None, norm(wa.status_if_none or NO_WARNING_STATUS)))
        for k in wa.kinds:
            kn, ks = norm(k.name), norm(k.status)
            kinds.add(kn)
            triples.add((name, kn, ks))
            required_triples.append((name, kn, ks))
            notes.update(norm(n) for n in k.notes)

    other_names = {norm(n) for n in b.all_names} - view_areas
    return _Facts(
        corpus=corpus, title=norm(b.head_title), times=times, required_times=required_times,
        numbers=numbers, view_areas=view_areas, other_names=other_names,
        intensity_pairs=intensity_pairs, required_intensity=required_intensity,
        intensities=intensities, max_intensity=b.max_intensity,
        kinds=kinds, triples=triples, required_triples=required_triples, notes=notes,
    )


def _times_in_text(text: str, ref: dt.datetime) -> list[dt.datetime]:
    """Resolve '3日14時40分' style expressions in the original against the report time."""
    out = []
    ref = ref.astimezone(JST)
    for m in DATETIME_RE.finditer(text):
        y, mo, d, ampm, h, mi, half = m.groups()
        if d is None:
            continue
        hour = int(h) + (12 if ampm == "午後" and int(h) < 12 else 0)
        minute = 30 if half else int(mi or 0)
        try:
            out.append(dt.datetime(int(y or ref.year), int(mo or ref.month), int(d), hour, minute, tzinfo=JST))
        except ValueError:
            pass
    return out


def _time_matches(m: re.Match, t: dt.datetime) -> bool:
    y, mo, d, ampm, h, mi, half = m.groups()
    hour = int(h)
    if ampm == "午後" and hour < 12:
        hour += 12
    if ampm == "午前" and hour == 12:
        hour = 0
    minute = 30 if half else int(mi or 0)
    return (
        (y is None or int(y) == t.year)
        and (mo is None or int(mo) == t.month)
        and (d is None or int(d) == t.day)
        and hour == t.hour
        and minute == t.minute
    )


def _scan(text: str, vocab: set[str]) -> list[tuple[int, str]]:
    """Longest-match, non-overlapping scan for vocabulary words."""
    if not vocab:
        return []
    pat = re.compile("|".join(re.escape(v) for v in sorted(vocab, key=len, reverse=True)))
    return [(m.start(), m.group(0)) for m in pat.finditer(text)]


def verify(b: Bulletin, paraphrase: str) -> Result:
    r = Result()
    if b.status != "通常":
        r.add("運用種別", False, f"運用種別が「{b.status}」なので言い換えません（BW-S1）")
        return r
    if not paraphrase or not paraphrase.strip():
        r.add("言い換え", False, "言い換えが空です")
        return r

    f = _facts(b)
    p = norm(paraphrase)

    # 1. banned and limited words -------------------------------------------
    banned = [w for w in BANNED_WORDS if w in p]
    r.add("禁止語", not banned,
          f"使ってはいけない言葉: {'、'.join(banned)}" if banned else "安全・安心や心理・医療の言葉はない")
    over = [f"{w}（原文{f.corpus.count(w)}回→{p.count(w)}回）"
            for w in LIMITED_WORDS if p.count(w) > f.corpus.count(w)]
    r.add("付け足し", not over,
          "予報・推測・助言・程度を表す言葉が原文より多い: " + "、".join(over) if over
          else "予報・推測・助言・程度を表す言葉は原文の範囲内")
    neg = [f"{w}（原文{f.corpus.count(w)}回→{p.count(w)}回）"
           for w in NEGATION_WORDS if p.count(w) > f.corpus.count(w)]
    r.add("否定", not neg,
          "打ち消しの言い回しが原文より多い: " + "、".join(neg) if neg else "打ち消しの言い回しは原文の範囲内")
    colon = COLON_TIME_RE.findall(p)
    r.add("時刻の書き方", not colon,
          f"「時・分」以外の書き方の時刻（照合できない）: {'、'.join(colon)}" if colon else "時刻は「時・分」で書いている")
    kanji = KANJI_NUMERAL_RE.findall(p.replace("十分", ""))  # 十分 = "enough"
    r.add("漢数字", not kanji,
          f"数を漢数字で書いている（照合できない）: {'、'.join(kanji)}" if kanji else "数はすべて算用数字")

    # 2. cancellation / correction -------------------------------------------
    has_cancel = any(w in p for w in CANCEL_WORDS)
    has_correct = any(w in p for w in CORRECT_WORDS)
    if b.info_type == "取消":
        ok, detail = has_cancel, "原文は取消。言い換えに取消の語が要る"
    elif b.info_type == "訂正":
        ok, detail = has_correct, "原文は訂正。言い換えに訂正の語が要る"
    else:
        ok = not has_cancel and not has_correct
        detail = f"原文は「{b.info_type}」。取消・訂正の語があってはいけない"
    r.add("取消・訂正", ok, detail + ("（一致）" if ok else "（食い違い）"))

    # 3. kind of information ------------------------------------------------
    r.add("情報の種類", f.title in p,
          f"「{b.head_title}」" + ("がある" if f.title in p else "がない"))
    p_wo_title = p.replace(f.title, "＿")

    # 4. date/time -----------------------------------------------------------
    found_times = list(DATETIME_RE.finditer(p_wo_title))
    bad_times = [m.group(0) for m in found_times if not any(_time_matches(m, t) for t in f.times)]
    r.add("時刻（余分・誤り）", not bad_times,
          f"原文にない時刻: {'、'.join(bad_times)}" if bad_times else "書かれた時刻はすべて原文にある")
    for label, t in f.required_times:
        hit = any(m.group(3) and _time_matches(m, t) for m in found_times)
        r.add(f"時刻（{label}）", hit, f"{format_jst(t)}" + ("がある" if hit else "がない（日・時・分が要る）"))
    rest = DATETIME_RE.sub("＿", p_wo_title)
    bad_dates = []
    for m in DATE_RE.finditer(rest):
        y, mo, d = m.groups()
        if not any((y is None or int(y) == t.year) and int(mo) == t.month and int(d) == t.day for t in f.times):
            bad_dates.append(m.group(0))
    r.add("日付", not bad_dates, f"原文にない日付: {'、'.join(bad_dates)}" if bad_dates else "日付は原文の範囲内")
    rest = DATE_RE.sub("＿", rest)

    # 5. numbers ---------------------------------------------------------------
    stray = sorted({n for n in NUMBER_RE.findall(rest) if n not in f.numbers})
    r.add("数値（余分・誤り）", not stray,
          f"原文にない数値: {'、'.join(stray)}" if stray else "数値はすべて原文にある")
    if b.magnitude:
        mags = MAGNITUDE_RE.findall(rest)
        ok = bool(mags) and all(float(x) == float(b.magnitude) for x in mags)
        r.add("規模", ok, f"M{b.magnitude}" + ("と一致" if ok else f"と食い違う（言い換え: {'、'.join(mags) or 'なし'}）"))
    if b.depth_km:
        if b.depth_km in ("ごく浅い", "不明"):
            ok = b.depth_km in p
            r.add("深さ", ok, f"深さ「{b.depth_km}」" + ("がある" if ok else "がない"))
        else:
            depths = DEPTH_RE.findall(rest)
            ok = "深さ" in p and bool(depths) and all(float(x) == float(b.depth_km) for x in depths)
            r.add("深さ", ok, f"深さ{b.depth_km}km" + ("と一致" if ok else f"と食い違う（言い換え: {'、'.join(depths) or 'なし'}）"))

    # 6. fixed comments / notes ----------------------------------------------
    for c in b.forecast_comments:
        nc = norm(c).rstrip("。")
        r.add("付加文", nc in p, f"「{c}」" + ("がそのままある" if nc in p else "がそのままの形でない"))
    for n in sorted(f.notes):
        r.add("付加事項", n in p, f"「{n}」" + ("がある" if n in p else "がない"))

    # 7. area names --------------------------------------------------------------
    area_vocab = f.view_areas | f.other_names | set(PREFECTURES)
    found_areas = {a for _, a in _scan(rest, area_vocab)}
    outside = sorted(a for a in found_areas if a not in f.view_areas and (a in f.other_names or a in PREFECTURES))
    r.add("地域名（余分）", not outside,
          f"原文の表示範囲にない地域名: {'、'.join(outside)}" if outside else "地域名は原文の表示範囲内")
    if b.hypocenter:
        # The hypocenter name must be stated in a clause about the hypocenter,
        # and no other area may be named in such a clause.
        hn = norm(b.hypocenter)
        stated, others = False, set()
        for _, clauses in _sentences(rest):
            for c in clauses:
                if "震源" in c or "震央" in c:
                    names = {a for _, a in _scan(c, area_vocab)}
                    stated |= hn in names
                    others |= names - {hn}
        ok = stated and not others
        detail = f"「{b.hypocenter}」を震源の文に書いている" if ok else (
            f"震源の文に別の地域名がある: {'、'.join(sorted(others))}" if others
            else f"「{b.hypocenter}」を震源の文に書いていない")
        r.add("震央地名", ok, detail)

    # 8. intensities / warning kinds and their pairing with areas -----------
    if b.category == "earthquake":
        _check_intensity(r, f, rest, area_vocab)
    else:
        _check_warning(r, f, rest, area_vocab, p)
    return r


def _sentences(text: str):
    for s in SENTENCE_SPLIT.split(text):
        if s:
            yield s, [c for c in CLAUSE_SPLIT.split(s) if c]


def _check_intensity(r: Result, f: _Facts, text: str, area_vocab: set[str]) -> None:
    tokens = list(INTENSITY_RE.finditer(text))
    bad = []
    for m in tokens:
        if m.group(3):  # "震度3以上" must be copied from the original
            if m.group(0) not in f.corpus:
                bad.append(m.group(0))
        elif m.group(1):  # "最大震度X" must be the overall maximum
            if m.group(2) != f.max_intensity:
                bad.append(m.group(0))
        elif m.group(2) not in f.intensities:
            bad.append(m.group(0))
    r.add("震度（値）", not bad, f"原文と合わない震度: {'、'.join(bad)}" if bad else "震度の値は原文の範囲内")
    if f.max_intensity:
        has_max = any(m.group(2) == f.max_intensity and not m.group(3) for m in tokens)
        r.add("震度（最大）", has_max, f"震度{f.max_intensity}" + ("がある" if has_max else "がない"))

    # required: every sub-area with its intensity, in one sentence
    missing = []
    for area, label in f.required_intensity:
        if not any(
            area in {a for _, a in _scan(s, area_vocab)}
            and any(m.group(2) == label and not m.group(3) for m in INTENSITY_RE.finditer(s))
            for s, _ in _sentences(text)
        ):
            missing.append(f"{area}：震度{label}")
    r.add("震度（地域ごと）", not missing,
          f"同じ文に地域と震度がそろっていない: {'、'.join(missing)}" if missing else "地域ごとの震度がそろっている")

    # reverse: within a clause (or its sentence), each intensity must belong to a named area
    wrong = []
    for s, clauses in _sentences(text):
        s_areas = {a for _, a in _scan(s, area_vocab)}
        for c in clauses:
            c_areas = {a for _, a in _scan(c, area_vocab)} or s_areas
            for m in INTENSITY_RE.finditer(c):
                if m.group(3) or not c_areas:
                    continue
                if not any((a, m.group(2)) in f.intensity_pairs for a in c_areas):
                    wrong.append(f"{'・'.join(sorted(c_areas))}と震度{m.group(2)}")
    r.add("震度（組み合わせ）", not wrong,
          f"地域と震度の組み合わせが原文と違う: {'、'.join(wrong)}" if wrong else "地域と震度の組み合わせは原文どおり")


def _check_warning(r: Result, f: _Facts, text: str, area_vocab: set[str], full: str) -> None:
    status_vocab = {"".join(norm(s)) for s in WARNING_STATUSES}
    kinds_found = {m.group(0) for m in KIND_RE.finditer(text)}
    extra = sorted(kinds_found - f.kinds)
    r.add("警報の種類（余分）", not extra,
          f"原文にない警報・注意報: {'、'.join(extra)}" if extra else "警報・注意報の種類は原文の範囲内")

    stripped = KIND_RE.sub("＿", text)
    for s in sorted(status_vocab, key=len, reverse=True):
        stripped = stripped.replace(s, "＿")
    corpus_stripped = KIND_RE.sub("＿", f.corpus.replace(f.title, "＿"))
    for s in sorted(status_vocab, key=len, reverse=True):
        corpus_stripped = corpus_stripped.replace(s, "＿")
    over = [f"{w}（原文{corpus_stripped.count(w)}回→{stripped.count(w)}回）"
            for w in LEVEL_WORDS if stripped.count(w) > corpus_stripped.count(w)]
    r.add("警報の段階", not over,
          "種類名の外で段階を表す言葉が原文より多い: " + "、".join(over) if over else "段階を表す言葉は原文の範囲内")

    def statuses(t: str) -> list[str]:
        return [x for _, x in _scan(t, status_vocab)]

    missing = []
    for area, kind, status in f.required_triples:
        if not any(
            area in {a for _, a in _scan(s, area_vocab)}
            and kind in {m.group(0) for m in KIND_RE.finditer(s)}
            and status in statuses(s)
            for s, _ in _sentences(text)
        ):
            missing.append(f"{area}：{kind} {status}")
    r.add("地域ごとの種類と状態", not missing,
          f"同じ文に地域・種類・状態がそろっていない: {'、'.join(missing)}" if missing else "地域ごとの種類と状態がそろっている")

    wrong = []
    for s, clauses in _sentences(text):
        s_areas = {a for _, a in _scan(s, area_vocab)}
        s_kinds = {m.group(0) for m in KIND_RE.finditer(s)}
        for c in clauses:
            c_areas = {a for _, a in _scan(c, area_vocab)} or s_areas
            if not c_areas:
                continue
            c_kinds = {m.group(0) for m in KIND_RE.finditer(c)}
            for k in c_kinds:
                if not any((a, k, st) in f.triples for a in c_areas for st in status_vocab):
                    wrong.append(f"{'・'.join(sorted(c_areas))}と{k}")
            for st in statuses(c):
                ks = c_kinds or s_kinds
                if st == norm(NO_WARNING_STATUS):
                    ok = any((a, None, st) in f.triples for a in c_areas)
                elif ks:
                    ok = any((a, k, st) in f.triples for a in c_areas for k in ks)
                else:
                    ok = any(t[0] in c_areas and t[2] == st for t in f.triples)
                if not ok:
                    wrong.append(f"{'・'.join(sorted(c_areas))}と「{st}」")
    r.add("種類と状態（組み合わせ）", not wrong,
          f"地域・種類・状態の組み合わせが原文と違う: {'、'.join(sorted(set(wrong)))}" if wrong
          else "地域・種類・状態の組み合わせは原文どおり")
