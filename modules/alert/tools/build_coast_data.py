#!/usr/bin/env python3
"""Build the coastline / tsunami forecast region JSON from JMA GIS data.

Standard library only. Input is the JMA "津波予報区" GIS zip (polyline
shapefile, about 90 MB; not kept in the repository):

  https://www.data.jma.go.jp/developer/gis/20240520_AreaTsunami_GIS.zip

  python3 -I modules/alert/tools/build_coast_data.py \
      --zip 20240520_AreaTsunami_GIS.zip \
      --retrieved 2026-11-07 \
      --out modules/alert/data/coast.json

Only the regions listed in REGIONS are kept. Lines are simplified with
Douglas-Peucker (TOLERANCE_M) and stored as integer 1e-5 degree deltas.
The maximum error is written into the JSON. Names and codes are copied
from the JMA data. The same input gives a byte-identical JSON.
"""

import argparse
import hashlib
import io
import json
import math
import struct
import sys
import zipfile

EARTH_R = 6371008.8
QUANT = 100000  # 1e-5 degree
TOLERANCE_M = 20.0
# Tsunami forecast regions kept (code: why).
REGIONS = {
    "380": "Shizuoka (current-location mode, Shizuoka demo)",
    "250": "Fukushima (Fukushima demo)",
    "310": "Chiba Kujukuri/Sotobo (Chiba demo)",
    "311": "Chiba Uchibo (Chiba demo)",
    "312": "Tokyo Bay inner (Chiba / Tokyo demos)",
}


def member(z, ext):
    names = [n for n in z.namelist() if n.lower().endswith(ext)]
    if len(names) != 1:
        raise SystemExit("expected one %s in the zip, found %d" % (ext, len(names)))
    return names[0]


def read_dbf(data):
    nrec, hlen, rlen = struct.unpack("<IHH", data[4:12])
    fields = []
    off = 32
    while data[off] != 0x0D:
        fields.append((data[off:off + 11].split(b"\0")[0].decode("ascii"), data[off + 16]))
        off += 32
    rows = []
    for i in range(nrec):
        rec = data[hlen + i * rlen: hlen + (i + 1) * rlen]
        pos = 1
        row = {}
        for name, length in fields:
            row[name] = rec[pos:pos + length].decode("utf-8").strip()
            pos += length
        rows.append(row)
    return rows


def read_polylines(z, wanted):
    """Return {record_index: [part, ...]}; each part is [(lon, lat), ...]."""
    out = {}
    with z.open(member(z, ".shp")) as f:
        header = f.read(100)
        if struct.unpack("<i", header[32:36])[0] != 3:
            raise SystemExit("expected a polyline shapefile (type 3)")
        idx = 0
        while True:
            rh = f.read(8)
            if len(rh) < 8:
                break
            length = struct.unpack(">i", rh[4:8])[0] * 2
            body = f.read(length)
            if idx in wanted:
                stype = struct.unpack("<i", body[0:4])[0]
                if stype != 3:
                    raise SystemExit("record %d is not a polyline" % idx)
                nparts, npoints = struct.unpack("<ii", body[36:44])
                parts = list(struct.unpack("<%di" % nparts, body[44:44 + 4 * nparts]))
                pts_off = 44 + 4 * nparts
                pts = [struct.unpack("<2d", body[pts_off + 16 * k: pts_off + 16 * k + 16]) for k in range(npoints)]
                parts.append(npoints)
                out[idx] = [pts[parts[p]:parts[p + 1]] for p in range(nparts)]
            idx += 1
    return out


def to_xy(lon, lat, lat0):
    k = math.pi / 180 * EARTH_R
    return (lon * k * math.cos(lat0 * math.pi / 180), lat * k)


def seg_dist(p, a, b):
    ax, ay = a
    bx, by = b
    px, py = p
    dx, dy = bx - ax, by - ay
    L = dx * dx + dy * dy
    t = 0.0 if L == 0 else max(0.0, min(1.0, ((px - ax) * dx + (py - ay) * dy) / L))
    return math.hypot(px - (ax + t * dx), py - (ay + t * dy))


def simplify(pts, tol, lat0):
    """Iterative Douglas-Peucker on (lon, lat) points; keeps the end points."""
    if len(pts) < 3:
        return list(pts)
    xy = [to_xy(lo, la, lat0) for lo, la in pts]
    keep = [False] * len(pts)
    keep[0] = keep[-1] = True
    stack = [(0, len(pts) - 1)]
    while stack:
        i, j = stack.pop()
        best, bi = -1.0, -1
        for k in range(i + 1, j):
            d = seg_dist(xy[k], xy[i], xy[j])
            if d > best:
                best, bi = d, k
        if best > tol:
            keep[bi] = True
            stack.append((i, bi))
            stack.append((bi, j))
    return [p for p, k in zip(pts, keep) if k]


def encode(pts):
    out = []
    px = py = 0
    for i, (lo, la) in enumerate(pts):
        x = int(round(lo * QUANT))
        y = int(round(la * QUANT))
        if i == 0:
            out += [x, y]
        else:
            out += [x - px, y - py]
        px, py = x, y
    return out


def max_error(orig, simp, lat0):
    """Largest distance from an original vertex to the simplified line (m)."""
    sxy = [to_xy(round(lo * QUANT) / QUANT, round(la * QUANT) / QUANT, lat0) for lo, la in simp]
    worst = 0.0
    for lo, la in orig:
        p = to_xy(lo, la, lat0)
        d = min(seg_dist(p, sxy[k], sxy[k + 1]) for k in range(len(sxy) - 1)) if len(sxy) > 1 else 0.0
        worst = max(worst, d)
    return worst


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--zip", required=True)
    ap.add_argument("--retrieved", required=True)
    ap.add_argument("--out", required=True)
    a = ap.parse_args(argv)
    raw = open(a.zip, "rb").read()
    z = zipfile.ZipFile(io.BytesIO(raw))
    rows = read_dbf(z.read(member(z, ".dbf")))
    wanted = {i: r for i, r in enumerate(rows) if r["code"] in REGIONS}
    if set(r["code"] for r in wanted.values()) != set(REGIONS):
        raise SystemExit("some regions were not found in the data")
    lines = read_polylines(z, set(wanted))
    regions = {}
    worst = 0.0
    vin = vout = 0
    for idx in sorted(wanted):
        r = wanted[idx]
        enc = []
        for part in lines[idx]:
            lat0 = sum(p[1] for p in part) / len(part)
            s = simplify(part, TOLERANCE_M, lat0)
            vin += len(part)
            vout += len(s)
            worst = max(worst, max_error(part, s, lat0))
            if len(s) >= 2:
                enc.append(encode(s))
        regions[r["code"]] = {"name": r["name"], "kana": r["namekana"], "lines": enc}
    out = {
        "format": "coast-lines/1",
        "source": {
            "title": "予報区等GISデータ「津波予報区」（気象庁）",
            "page_url": "https://www.data.jma.go.jp/developer/gis.html",
            "file": "https://www.data.jma.go.jp/developer/gis/20240520_AreaTsunami_GIS.zip",
            "file_sha256": hashlib.sha256(raw).hexdigest(),
            "retrieved": a.retrieved,
        },
        "attribution": "出典：気象庁ホームページ（https://www.data.jma.go.jp/developer/gis.html）",
        "processed": "気象庁「予報区等GISデータ」の「津波予報区」をもとに本プロジェクトが作成（予報区の抽出、線の簡略化、座標の丸め）。気象庁が作成したものではありません",
        "unit": 1 / QUANT,
        "simplification": {"method": "Douglas-Peucker", "tolerance_m": TOLERANCE_M, "max_error_m": round(worst + 1.0, 1)},
        "regions": regions,
    }
    text = json.dumps(out, ensure_ascii=False, separators=(",", ":"), sort_keys=False)
    with open(a.out, "w", encoding="utf-8", newline="\n") as f:
        f.write(text + "\n")
    print("regions: %d  vertices: %d -> %d  max error: %.1f m (+1 m rounding)" % (len(regions), vin, vout, worst))


if __name__ == "__main__":
    sys.exit(main())
