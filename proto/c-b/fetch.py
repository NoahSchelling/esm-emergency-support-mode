"""Fetch a few earthquake and R06 warning bulletins from the JMA PULL feeds.

Usage:
  python3 proto/c-b/fetch.py --out DIR [--quakes N] [--warnings N] [--long-feed]
  python3 proto/c-b/fetch.py --out DIR NAME.xml ...     # fetch specific bulletins

Only https://www.data.jma.go.jp/ is contacted. Bulletins whose Control/Status
is not "通常" are not saved (BW-S1). A manifest (fetched.json) records the
source URL and the HTTP Date header of every saved file.
"""

from __future__ import annotations

import argparse
import datetime as dt
import json
import pathlib
import re
import sys
import urllib.parse
import urllib.request
import xml.etree.ElementTree as ET

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent))
from bulletin import BulletinError, parse_bulletin  # noqa: E402

ALLOWED_HOST = "www.data.jma.go.jp"
FEED_BASE = "https://www.data.jma.go.jp/developer/xml/feed/"
DATA_BASE = "https://www.data.jma.go.jp/developer/xml/data/"
NAME_RE = re.compile(r"^\d{14}_\d_[A-Z]{4}\d{2}_\d{6}\.xml$")
MAX_BYTES = 2_000_000
ATOM = "{http://www.w3.org/2005/Atom}"
USER_AGENT = "hackathon-tomato-proto-c-b/0.1"

QUAKE_TITLES = ("震源・震度に関する情報", "震度速報", "震源に関する情報")
WARNING_PREFIX = "気象警報・注意報（Ｒ０６）"


class FetchError(RuntimeError):
    pass


def check_url(url: str) -> str:
    u = urllib.parse.urlsplit(url)
    if u.scheme != "https" or u.hostname != ALLOWED_HOST:
        raise FetchError(f"取得先が許可されていません: {url}")
    if u.path.startswith("/developer/xml/data/"):
        name = u.path.rsplit("/", 1)[-1]
        if not NAME_RE.match(name):
            raise FetchError(f"電文のファイル名の形ではありません: {name}")
    elif not u.path.startswith("/developer/xml/feed/"):
        raise FetchError(f"取得先のパスが許可されていません: {url}")
    return url


def get(url: str, timeout: float = 15) -> tuple[bytes, str]:
    check_url(url)
    req = urllib.request.Request(url, headers={"User-Agent": USER_AGENT})
    with urllib.request.urlopen(req, timeout=timeout) as r:
        data = r.read(MAX_BYTES + 1)
        if len(data) > MAX_BYTES:
            raise FetchError(f"大きすぎます: {url}")
        return data, r.headers.get("Date", "")


def feed_entries(data: bytes) -> list[dict]:
    if b"<!DOCTYPE" in data or b"<!ENTITY" in data:
        raise FetchError("DTD を含むフィードは読みません")
    root = ET.fromstring(data)
    out = []
    for e in root.findall(ATOM + "entry"):
        link = e.find(ATOM + "link")
        out.append({
            "title": (e.findtext(ATOM + "title") or "").strip(),
            "updated": (e.findtext(ATOM + "updated") or "").strip(),
            "url": link.get("href", "") if link is not None else "",
        })
    out.sort(key=lambda x: x["updated"], reverse=True)
    return out


def select(entries: list[dict], quakes: int, warnings: int) -> list[str]:
    q = [e["url"] for e in entries if e["title"] in QUAKE_TITLES][:quakes]
    w = [e["url"] for e in entries if e["title"].startswith(WARNING_PREFIX)][:warnings]
    return q + w


def fetch_bulletins(urls: list[str], out: pathlib.Path) -> list[dict]:
    out.mkdir(parents=True, exist_ok=True)
    manifest_path = out / "fetched.json"
    manifest = json.loads(manifest_path.read_text("utf-8")) if manifest_path.exists() else {}
    saved = []
    for url in urls:
        try:
            data, date = get(url)
            name = url.rsplit("/", 1)[-1]
            b = parse_bulletin(data, name, url)
        except (FetchError, BulletinError, OSError, ET.ParseError) as e:
            print(f"skip: {url}: {e}", file=sys.stderr)
            continue
        if b.status != "通常":
            print(f"skip (運用種別が通常ではない: {b.status}): {url}", file=sys.stderr)
            continue
        (out / name).write_bytes(data)
        manifest[name] = {
            "url": url,
            "http_date": date,
            "fetched_at_utc": dt.datetime.now(dt.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
            "title": b.control_title,
        }
        saved.append({"name": name, **manifest[name]})
        print(f"saved: {name}  {b.control_title}  {b.head_title}")
    manifest_path.write_text(json.dumps(manifest, ensure_ascii=False, indent=2, sort_keys=True) + "\n", "utf-8")
    return saved


def main(argv: list[str] | None = None) -> int:
    p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument("--out", required=True, type=pathlib.Path)
    p.add_argument("--quakes", type=int, default=2)
    p.add_argument("--warnings", type=int, default=2)
    p.add_argument("--long-feed", action="store_true", help="長期フィード（数日分）から選ぶ")
    p.add_argument("names", nargs="*", help="取得する電文のファイル名（指定するとフィードは見ない）")
    a = p.parse_args(argv)

    if a.names:
        urls = [DATA_BASE + n for n in a.names]
    else:
        suffix = "_l" if a.long_feed else ""
        entries = []
        for feed in ("eqvol", "extra"):
            data, _ = get(f"{FEED_BASE}{feed}{suffix}.xml")
            entries += feed_entries(data)
        urls = select(entries, a.quakes, a.warnings)
    if not urls:
        print("該当する電文がフィードにありませんでした", file=sys.stderr)
        return 1
    saved = fetch_bulletins(urls, a.out)
    return 0 if saved else 1


if __name__ == "__main__":
    sys.exit(main())
