#!/usr/bin/env python3
"""Build the on-device evacuation-site JSON (Shizuoka) from GSI open data.

Standard library only. Input is the GSI "designated emergency evacuation
site" (shitei kinkyu hinan basho) prefecture CSV plus two small list files
from the same download site. See modules/evac/data/SOURCE.md.

  python3 -I modules/evac/tools/build_evac_data.py --fetch DIR
      Download the three input files into DIR (an empty directory outside
      the repository). Nothing is built.

  python3 -I modules/evac/tools/build_evac_data.py \
      --csv DIR/22000_2.csv \
      --pref-list DIR/prefectureListData.csv \
      --muni-list DIR/publicHistoryListData.csv \
      --retrieved 2026-11-07 \
      --out modules/evac/data/shizuoka_evac.json

The output depends only on the input files and the arguments: the same
input gives a byte-identical JSON (rows are sorted by the common ID).
Names and remarks are copied as they are (only surrounding white space is
removed and line breaks inside a remark become a space).
"""

import argparse
import csv
import hashlib
import io
import json
import os
import sys
import urllib.request

BASE_URL = "https://hinanmap.gsi.go.jp/hinanjocp/defaultFtpData/"
PAGE_URL = "https://hinanmap.gsi.go.jp/index.html"
LIST_PAGE_URL = "https://hinanmap.gsi.go.jp/hinanjocp/hinanbasho/koukaidate.html"
INFO_URL = "https://www.gsi.go.jp/bousaichiri/hinanbasho.html"
NOTICE_URL = "https://www.gsi.go.jp/bousaichiri/hinanbasho-menseki.html"
TERMS_URL = "https://www.gsi.go.jp/kikakuchousei/kikakuchousei40182.html"

PREF_CODE = "22000"
PREF_NAME = "静岡県"
CSV_NAME = PREF_CODE + "_2.csv"  # "_2" = designated emergency evacuation sites
FILES = {
    CSV_NAME: "csv/" + CSV_NAME,
    "prefectureListData.csv": "publicHistoryCSV/prefectureListData.csv",
    "publicHistoryListData.csv": "publicHistoryCSV/publicHistoryListData.csv",
}

# Rough bounding box of Shizuoka prefecture. Rows outside are dropped and
# reported (they would be data errors).
BBOX = {"lat_min": 34.4, "lat_max": 35.8, "lon_min": 137.3, "lon_max": 139.3}

# Column name in the GSI CSV -> key used in the JSON. The order is the order
# of the "hazards" flag string of every site.
HAZARDS = [
    ("洪水", "flood"),
    ("崖崩れ、土石流及び地滑り", "landslide"),
    ("高潮", "storm_surge"),
    ("地震", "earthquake"),
    ("津波", "tsunami"),
    ("大規模な火事", "large_fire"),
    ("内水氾濫", "inland_flood"),
    ("火山現象", "volcano"),
]

EXPECTED_HEADER = (
    ["NO", "共通ID", "施設・場所名", "住所"]
    + [c for c, _ in HAZARDS]
    + ["指定避難所との住所同一", "緯度", "経度", "備考"]
)

NOTICES = [
    # The four notes of the GSI data ("ご利用上の注意"), copied as published.
    "本データは、災害対策基本法第49条の4・第49条の7に基づき市町村長が指定した指定緊急避難場所・指定避難所の情報を各市町村に登録いただいたものです。なお、最新でない場合や未掲載の場合があるため、最新かつ詳細の状況などは必ず当該市町村にご確認ください。",
    "「指定緊急避難場所」と「指定避難所」の違いや、指定緊急避難場所が災害種別ごとに指定されていることを理解した上でご利用ください。",
    "本データは随時更新されますので、利用される場合は、ご注意ください。",
    "本データを用いた情報を第三者に提供する場合は、上記1．～3．の注意事項が正確に伝わるよう、十分にご留意ください。",
]


def fetch(dest):
    if os.path.exists(dest) and os.listdir(dest):
        raise SystemExit("--fetch needs an empty directory: %s" % dest)
    os.makedirs(dest, exist_ok=True)
    for name, path in sorted(FILES.items()):
        url = BASE_URL + path
        req = urllib.request.Request(url, headers={"User-Agent": "evac-data-build/1"})
        with urllib.request.urlopen(req, timeout=60) as res:
            body = res.read()
            last_modified = res.headers.get("Last-Modified", "")
        with open(os.path.join(dest, name), "wb") as f:
            f.write(body)
        print("%s  %d bytes  Last-Modified: %s" % (name, len(body), last_modified))
    print("Pass the Last-Modified of %s with --csv-last-modified if you want it recorded." % CSV_NAME)


def read_csv_rows(path):
    with open(path, "rb") as f:
        raw = f.read()
    text = raw.decode("utf-8-sig")  # GSI files are UTF-8 with BOM
    return list(csv.reader(io.StringIO(text, newline=""))), hashlib.sha256(raw).hexdigest()


def pref_updated(path):
    rows, _ = read_csv_rows(path)
    for r in rows:
        if len(r) >= 3 and r[0] == PREF_CODE:
            if r[1] != PREF_NAME:
                raise SystemExit("prefecture list: unexpected name %r" % r[1])
            return r[2]
    raise SystemExit("prefecture list: %s not found" % PREF_CODE)


def municipalities(path):
    """Return {code: {"name":..., "published":..., "updated":...}} for the prefecture."""
    rows, _ = read_csv_rows(path)
    out = {}
    for r in rows:
        if len(r) < 4 or not r[0].startswith(PREF_CODE[:2]) or len(r[0]) != 5:
            continue
        name = r[1]
        if not name.startswith(PREF_NAME):
            raise SystemExit("municipality list: %s has unexpected name %r" % (r[0], name))
        out[r[0]] = {"name": name[len(PREF_NAME):], "published": r[2], "updated": r[3]}
    if not out:
        raise SystemExit("municipality list: no rows for the prefecture")
    return out


def clean(s):
    return " ".join(s.split())


def build(args):
    rows, csv_sha = read_csv_rows(args.csv)
    header, body = rows[0], rows[1:]
    if header != EXPECTED_HEADER:
        raise SystemExit("unexpected CSV header:\n%r\nexpected:\n%r" % (header, EXPECTED_HEADER))
    munis = municipalities(args.muni_list)
    sites = []
    dropped = []
    for r in body:
        if not any(v.strip() for v in r):
            continue
        rec = dict(zip(header, r))
        cid = rec["共通ID"].strip()
        code = cid[1:6]
        if not (cid.startswith("E") and len(cid) == 14 and code in munis):
            raise SystemExit("unexpected common ID %r (NO %s)" % (cid, rec["NO"]))
        try:
            lat = float(rec["緯度"])
            lon = float(rec["経度"])
        except ValueError:
            dropped.append((cid, "coordinates are not numbers"))
            continue
        if not (BBOX["lat_min"] <= lat <= BBOX["lat_max"] and BBOX["lon_min"] <= lon <= BBOX["lon_max"]):
            dropped.append((cid, "outside the prefecture bounding box"))
            continue
        flags = ""
        for col, _ in HAZARDS:
            v = rec[col].strip()
            if v not in ("", "1"):
                raise SystemExit("unexpected hazard flag %r in %s (%s)" % (v, col, cid))
            flags += "1" if v == "1" else "0"
        if "1" not in flags:
            dropped.append((cid, "no hazard type"))
            continue
        sites.append([cid, clean(rec["施設・場所名"]), code, round(lat, 6), round(lon, 6), flags, clean(rec["備考"])])
    sites.sort(key=lambda s: s[0])
    ids = [s[0] for s in sites]
    if len(ids) != len(set(ids)):
        raise SystemExit("duplicate common IDs")

    used = sorted({s[2] for s in sites})
    counts = {c: 0 for c in used}
    for s in sites:
        counts[s[2]] += 1

    out = {
        "format": "evac-sites/1",
        "kind": "designated_emergency_evacuation_sites",
        "prefecture": {"code": PREF_CODE, "name": PREF_NAME},
        "source": {
            "title": "指定緊急避難場所データ（国土地理院）",
            "publisher": "国土地理院",
            "page_url": PAGE_URL,
            "list_page_url": LIST_PAGE_URL,
            "info_url": INFO_URL,
            "notice_url": NOTICE_URL,
            "terms_url": TERMS_URL,
            "terms": "国土地理院コンテンツ利用規約（公共データ利用規約 第1.0版）と、指定緊急避難場所・指定避難所データのご利用上の注意",
            "file": BASE_URL + FILES[CSV_NAME],
            "file_sha256": csv_sha,
            "file_last_modified": args.csv_last_modified,
            "gsi_updated": pref_updated(args.pref_list),
            "retrieved": args.retrieved,
        },
        "attribution": "出典：国土地理院ウェブサイト（指定緊急避難場所データ）" + PAGE_URL,
        "processed": "「指定緊急避難場所データ」（国土地理院）（" + PAGE_URL + "）をもとに本プロジェクトが作成（静岡県分の抽出、項目の選択、災害の種別の符号化、座標の丸め）。国土地理院が作成したものではありません",
        "notices": NOTICES,
        "coverage_note": "市町村が登録し、公開に同意した指定緊急避難場所だけが含まれます。載っていない場所、最新でない情報がありえます。最新の状況は市町村に確かめてください。",
        "hazards": [{"key": k, "label": c} for c, k in HAZARDS],
        "municipalities": {
            c: {"name": munis[c]["name"], "gsi_updated": munis[c]["updated"], "sites": counts[c]} for c in used
        },
        "fields": ["id", "name", "municipality", "lat", "lon", "hazards", "remarks"],
        "sites": sites,
    }
    text = json.dumps(out, ensure_ascii=False, separators=(",", ":"))
    # One site per line keeps diffs readable.
    text = text.replace(',"sites":[[', ',"sites":[\n[').replace("],[", "],\n[")
    with open(args.out, "w", encoding="utf-8", newline="\n") as f:
        f.write(text + "\n")
    print("sites: %d  dropped: %d  municipalities: %d  csv sha256: %s" % (len(sites), len(dropped), len(used), csv_sha))
    for cid, why in dropped:
        print("  dropped %s: %s" % (cid, why))
    missing = sorted(set(munis) - set(used))
    if missing:
        print("  municipalities in the list with no site: %s" % ", ".join(missing))


def main(argv=None):
    p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument("--fetch", metavar="DIR", help="download the input files into an empty DIR and stop")
    p.add_argument("--csv")
    p.add_argument("--pref-list")
    p.add_argument("--muni-list")
    p.add_argument("--retrieved", help="date the files were downloaded (YYYY-MM-DD, JST)")
    p.add_argument("--csv-last-modified", default="", help="Last-Modified header of the CSV (optional)")
    p.add_argument("--out")
    args = p.parse_args(argv)
    if args.fetch:
        fetch(args.fetch)
        return
    for name in ("csv", "pref_list", "muni_list", "retrieved", "out"):
        if not getattr(args, name):
            p.error("--%s is required" % name.replace("_", "-"))
    build(args)


if __name__ == "__main__":
    sys.exit(main())
