"""Parse JMA disaster-information XML bulletins into a small, display-ready form.

Only two families are supported in this prototype:
  * earthquake information (VXSE51 / VXSE52 / VXSE53)
  * R06-format weather warnings/advisories (VPWW55-61)

The "view" built here is the exact scope that a paraphrase is allowed to cover.
Values are copied from the XML as-is; the only conversions are code->label
mappings with the same meaning (seismic intensity "5-" -> "5弱", ISO time ->
Japanese date/time notation).
"""

from __future__ import annotations

import datetime as dt
import re
import xml.etree.ElementTree as ET
from dataclasses import dataclass, field

NS = {
    "jmx": "http://xml.kishou.go.jp/jmaxml1/",
    "ib": "http://xml.kishou.go.jp/jmaxml1/informationBasis1/",
    "seis": "http://xml.kishou.go.jp/jmaxml1/body/seismology1/",
    "met": "http://xml.kishou.go.jp/jmaxml1/body/meteorology1/",
    "eb": "http://xml.kishou.go.jp/jmaxml1/elementBasis1/",
}

# Seismic intensity codes used in MaxInt / Int, mapped to the label used in
# JMA's own Japanese text ("震度５弱" etc.).
INTENSITY_LABELS = {
    "0": "0", "1": "1", "2": "2", "3": "3", "4": "4",
    "5-": "5弱", "5+": "5強", "6-": "6弱", "6+": "6強", "7": "7",
}

# Warning levels kept in the view. Municipality-level items are left out of
# the view (they are long lists); a paraphrase must not mention them either.
WARNING_VIEW_LEVELS = (
    "気象警報・注意報（府県予報区等）",
    "気象警報・注意報（一次細分区域等）",
)

NO_WARNING_STATUS = "発表警報・注意報はなし"


class BulletinError(ValueError):
    """The bulletin cannot be parsed or is outside this prototype's scope."""


@dataclass
class IntensityArea:
    level: str  # "都道府県" or "細分区域"
    name: str
    pref: str
    label: str  # e.g. "3", "5弱"


@dataclass
class WarningKind:
    name: str
    status: str
    notes: list[str] = field(default_factory=list)


@dataclass
class WarningArea:
    level: str
    name: str
    status_if_none: str | None  # set when the area has no kind (e.g. "発表警報・注意報はなし")
    kinds: list[WarningKind] = field(default_factory=list)


@dataclass
class Bulletin:
    source_name: str
    source_url: str
    category: str  # "earthquake" | "warning"
    control_title: str
    control_datetime: str
    status: str
    editorial_office: str
    publishing_office: str
    head_title: str
    report_datetime: dt.datetime
    target_datetime: dt.datetime | None
    info_type: str
    headline_text: str
    # earthquake
    origin_time: dt.datetime | None = None
    hypocenter: str | None = None
    coordinate_description: str | None = None
    depth_km: str | None = None  # "50", or "ごく浅い" / "不明"
    magnitude: str | None = None  # "4.7"
    magnitude_description: str | None = None
    max_intensity: str | None = None
    intensity_areas: list[IntensityArea] = field(default_factory=list)
    forecast_comments: list[str] = field(default_factory=list)
    # warning
    warning_areas: list[WarningArea] = field(default_factory=list)
    # cancellation text (InfoType 取消)
    body_text: str | None = None
    # every <Name> in the XML, used to spot names outside the view
    all_names: set[str] = field(default_factory=set)

    def view(self) -> list[dict]:
        """The original, as label/value rows. This is what the UI shows."""
        rows = [
            {"label": "情報の種類", "value": self.head_title},
            {"label": "情報の形態", "value": self.info_type},
            {"label": "発表時刻", "value": format_jst(self.report_datetime)},
            {"label": "見出し", "value": self.headline_text},
        ]
        if self.body_text:
            rows.append({"label": "本文", "value": self.body_text})
        if self.category == "earthquake":
            if self.origin_time:
                rows.append({"label": "発生時刻", "value": format_jst(self.origin_time)})
            if self.hypocenter:
                rows.append({"label": "震央地名", "value": self.hypocenter})
            if self.coordinate_description:
                rows.append({"label": "位置と深さ", "value": self.coordinate_description})
            if self.magnitude_description:
                rows.append({"label": "規模", "value": self.magnitude_description})
            if self.max_intensity:
                rows.append({"label": "最大震度", "value": "震度" + self.max_intensity})
            for a in self.intensity_areas:
                rows.append({"label": f"震度（{a.level}）", "value": f"{a.name}：震度{a.label}"})
            for c in self.forecast_comments:
                rows.append({"label": "付加文", "value": c})
        elif self.category == "warning":
            for a in self.warning_areas:
                level = a.level.replace("気象警報・注意報", "").strip("（）")
                if a.kinds:
                    parts = []
                    for k in a.kinds:
                        notes = f"（{'、'.join(k.notes)}）" if k.notes else ""
                        parts.append(f"{k.name}{notes} {k.status}")
                    value = f"{a.name}：" + "／".join(parts)
                else:
                    value = f"{a.name}：{a.status_if_none}"
                rows.append({"label": f"地域（{level}）", "value": value})
        return rows


def format_jst(t: dt.datetime) -> str:
    t = t.astimezone(dt.timezone(dt.timedelta(hours=9)))
    return f"{t.year}年{t.month}月{t.day}日{t.hour}時{t.minute:02d}分"


def _text(el: ET.Element | None, path: str) -> str:
    if el is None:
        return ""
    found = el.find(path, NS)
    return (found.text or "").strip() if found is not None and found.text else ""


def _parse_time(s: str) -> dt.datetime | None:
    if not s:
        return None
    return dt.datetime.fromisoformat(s.replace("Z", "+00:00"))


_COORD_RE = re.compile(r"^([+-]\d+(?:\.\d+)?)([+-]\d+(?:\.\d+)?)([+-]\d+)?/?$")


def _depth_from_coordinate(coord: str, description: str) -> str | None:
    if "ごく浅い" in description:
        return "ごく浅い"
    if "不明" in description:
        return "不明"
    m = _COORD_RE.match(coord.strip())
    if not m or m.group(3) is None:
        return None
    meters = abs(int(m.group(3)))
    km = meters / 1000
    return str(int(km)) if km == int(km) else str(km)


def parse_bulletin(data: bytes, source_name: str, source_url: str = "") -> Bulletin:
    # Refuse DTDs: the bulletins never use them, and this blocks entity tricks.
    if b"<!DOCTYPE" in data or b"<!ENTITY" in data:
        raise BulletinError("DTD を含む XML は読みません")
    try:
        root = ET.fromstring(data)
    except ET.ParseError as e:
        raise BulletinError(f"XML を解析できません: {e}") from e

    control = root.find("jmx:Control", NS)
    head = root.find("ib:Head", NS)
    if control is None or head is None:
        raise BulletinError("Control または Head がありません")

    control_title = _text(control, "jmx:Title")
    report_dt = _parse_time(_text(head, "ib:ReportDateTime"))
    if report_dt is None:
        raise BulletinError("発表時刻（ReportDateTime）がありません")

    seis_body = root.find("seis:Body", NS)
    met_body = root.find("met:Body", NS)
    if seis_body is not None and control_title in ("震度速報", "震源に関する情報", "震源・震度に関する情報"):
        category = "earthquake"
    elif met_body is not None and control_title.startswith("気象警報・注意報（Ｒ０６）"):
        category = "warning"
    else:
        raise BulletinError(f"この試作では扱わない電文です: {control_title}")

    b = Bulletin(
        source_name=source_name,
        source_url=source_url,
        category=category,
        control_title=control_title,
        control_datetime=_text(control, "jmx:DateTime"),
        status=_text(control, "jmx:Status"),
        editorial_office=_text(control, "jmx:EditorialOffice"),
        publishing_office=_text(control, "jmx:PublishingOffice"),
        head_title=_text(head, "ib:Title"),
        report_datetime=report_dt,
        target_datetime=_parse_time(_text(head, "ib:TargetDateTime")),
        info_type=_text(head, "ib:InfoType"),
        headline_text=_text(head, "ib:Headline/ib:Text"),
    )
    # Names of every area-like element (prefecture, sub-area, municipality,
    # station), including those outside the view.
    for el in root.iter():
        if el.tag.rsplit("}", 1)[-1] in ("Area", "Pref", "City", "IntensityStation"):
            for child in el:
                if child.tag.endswith("}Name") and child.text and child.text.strip():
                    b.all_names.add(child.text.strip())

    body = seis_body if category == "earthquake" else met_body
    b.body_text = _text(body, "seis:Text" if category == "earthquake" else "met:Text") or None

    if category == "earthquake":
        _parse_earthquake(body, b)
    else:
        _parse_warning(body, b)
    return b


def _parse_earthquake(body: ET.Element, b: Bulletin) -> None:
    eq = body.find("seis:Earthquake", NS)
    if eq is not None:
        b.origin_time = _parse_time(_text(eq, "seis:OriginTime"))
        area = eq.find("seis:Hypocenter/seis:Area", NS)
        if area is not None:
            b.hypocenter = _text(area, "seis:Name") or None
            coord = area.find("eb:Coordinate", NS)
            if coord is not None:
                b.coordinate_description = coord.get("description", "").strip() or None
                b.depth_km = _depth_from_coordinate(coord.text or "", coord.get("description", ""))
        mag = eq.find("eb:Magnitude", NS)
        if mag is not None:
            b.magnitude = (mag.text or "").strip() or None
            b.magnitude_description = mag.get("description", "").strip() or None

    obs = body.find("seis:Intensity/seis:Observation", NS)
    if obs is not None:
        mx = _text(obs, "seis:MaxInt")
        b.max_intensity = INTENSITY_LABELS.get(mx, mx) or None
        for pref in obs.findall("seis:Pref", NS):
            pname = _text(pref, "seis:Name")
            pmax = _text(pref, "seis:MaxInt")
            b.intensity_areas.append(
                IntensityArea("都道府県", pname, pname, INTENSITY_LABELS.get(pmax, pmax)))
            for area in pref.findall("seis:Area", NS):
                amax = _text(area, "seis:MaxInt")
                b.intensity_areas.append(
                    IntensityArea("細分区域", _text(area, "seis:Name"), pname,
                                  INTENSITY_LABELS.get(amax, amax)))

    comments = body.find("seis:Comments", NS)
    if comments is not None:
        for fc in comments.findall("seis:ForecastComment", NS):
            for t in fc.findall("seis:Text", NS):
                if t.text and t.text.strip():
                    b.forecast_comments.append(t.text.strip())


def _parse_warning(body: ET.Element, b: Bulletin) -> None:
    for w in body.findall("met:Warning", NS):
        level = w.get("type", "")
        if level not in WARNING_VIEW_LEVELS:
            continue
        for item in w.findall("met:Item", NS):
            area_name = _text(item, "met:Area/met:Name")
            kinds: list[WarningKind] = []
            status_if_none = None
            for k in item.findall("met:Kind", NS):
                name = _text(k, "met:Name")
                status = _text(k, "met:Status")
                if not name:
                    status_if_none = status or NO_WARNING_STATUS
                    continue
                notes = [(n.text or "").strip() for n in k.findall("met:Addition/met:Note", NS)
                         if n.text and n.text.strip()]
                kinds.append(WarningKind(name, status, notes))
            b.warning_areas.append(WarningArea(level, area_name, status_if_none, kinds))
