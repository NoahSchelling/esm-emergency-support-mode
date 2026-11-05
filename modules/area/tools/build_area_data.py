#!/usr/bin/env python3
"""Build the on-device area lookup JSON from JMA forecast-area GIS data.

Standard library only. The JMA zips are large (100-150 MB each) and are not
kept in the repository; download them first (see modules/area/data/SOURCE.md),
then run, for example:

  python3 -I modules/area/tools/build_area_data.py \
      --weather   20260226_AreaInformationCity_weather_GIS.zip \
      --quake     20241128_AreaInformationCity_quake_GIS.zip \
      --prefecture 20190125_AreaForecastLocalM_prefecture_GIS.zip \
      --group     20230517_AreaForecastLocalM_matome_GIS.zip \
      --primary   20190125_AreaForecastLocalM_1saibun_GIS.zip \
      --codes     jmaxml_20261104_Code.zip \
      --out       modules/area/data/shizuoka.json

Names and codes are copied from the JMA data without changes. Geometry is
simplified (Douglas-Peucker) and quantized; the maximum resulting error is
written into the JSON so that the runtime can widen its search radius by it.
"""

import argparse
import io
import json
import math
import random
import re
import struct
import sys
import zipfile

EARTH_R = 6371008.8  # mean earth radius in metres
QUANT = 100000  # coordinates are stored as integers of 1e-5 degree


# ---------------------------------------------------------------- readers

def _member(z, ext):
    names = [n for n in z.namelist() if n.lower().endswith(ext)]
    if len(names) != 1:
        raise SystemExit("expected exactly one %s in zip, found %d" % (ext, len(names)))
    return names[0]


def read_dbf(data):
    """Return list of dicts. JMA GIS dbf files are UTF-8 (checked: cp932 fails)."""
    nrec, hlen, rlen = struct.unpack("<IHH", data[4:12])
    fields = []
    off = 32
    while data[off] != 0x0D:
        name = data[off:off + 11].split(b"\0")[0].decode("ascii")
        fields.append((name, data[off + 16]))
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


def read_shp_records(z, wanted):
    """Stream a polygon .shp and return {record_index: [ring, ...]} for wanted indices.

    Each ring is a list of (lon, lat) tuples as stored (closed: first == last).
    """
    out = {}
    with z.open(_member(z, ".shp")) as f:
        header = f.read(100)
        shape_type = struct.unpack("<i", header[32:36])[0]
        if shape_type != 5:
            raise SystemExit("unsupported shape type %d (expected polygon)" % shape_type)
        idx = 0
        while True:
            rh = f.read(8)
            if len(rh) < 8:
                break
            _num, clen = struct.unpack(">ii", rh)
            content = f.read(clen * 2)
            if idx in wanted:
                st = struct.unpack("<i", content[0:4])[0]
                if st == 0:
                    out[idx] = []
                else:
                    nparts, npoints = struct.unpack("<ii", content[36:44])
                    parts = list(struct.unpack("<%di" % nparts, content[44:44 + 4 * nparts]))
                    pts_off = 44 + 4 * nparts
                    flat = struct.unpack("<%dd" % (2 * npoints), content[pts_off:pts_off + 16 * npoints])
                    pts = list(zip(flat[0::2], flat[1::2]))
                    parts.append(npoints)
                    out[idx] = [pts[parts[k]:parts[k + 1]] for k in range(nparts)]
            idx += 1
    return out


def load_layer(path, code_field, prefix):
    z = zipfile.ZipFile(path)
    rows = read_dbf(z.read(_member(z, ".dbf")))
    wanted = {i for i, r in enumerate(rows) if r[code_field].startswith(prefix)}
    geoms = read_shp_records(z, wanted)
    feats = []
    for i in sorted(wanted):
        feats.append({"row": rows[i], "rings": geoms.get(i, [])})
    return feats


def read_xlsx_sheets(xlsx_bytes):
    z = zipfile.ZipFile(io.BytesIO(xlsx_bytes))
    strs = []
    if "xl/sharedStrings.xml" in z.namelist():
        ss = z.read("xl/sharedStrings.xml").decode("utf-8")
        for si in re.findall(r"<si>(.*?)</si>", ss, re.S):
            # keep only <t> of the main text, skip phonetic runs (<rPh>)
            si = re.sub(r"<rPh.*?</rPh>", "", si, flags=re.S)
            strs.append("".join(re.findall(r"<t[^>]*>(.*?)</t>", si, re.S)))
    wb = z.read("xl/workbook.xml").decode("utf-8")
    rels_xml = z.read("xl/_rels/workbook.xml.rels").decode("utf-8")
    rels = {}
    for rel in re.findall(r"<Relationship [^>]*/>", rels_xml):
        rid = re.search(r'Id="([^"]+)"', rel).group(1)
        tgt = re.search(r'Target="([^"]+)"', rel).group(1)
        rels[rid] = tgt
    sheets = {}
    for tag in re.findall(r"<sheet [^>]*/>", wb):
        name = re.search(r'name="([^"]+)"', tag).group(1)
        rid = re.search(r'r:id="([^"]+)"', tag).group(1)
        target = rels[rid].lstrip("/")
        if not target.startswith("xl/"):
            target = "xl/" + target
        xml = z.read(target).decode("utf-8")
        rows = []
        for row in re.findall(r"<row[^>]*>(.*?)</row>", xml, re.S):
            cells = {}
            for c in re.finditer(r'<c r="([A-Z]+)\d+"([^>]*?)(?:/>|>(.*?)</c>)', row, re.S):
                body = c.group(3) or ""
                v = re.search(r"<v>(.*?)</v>", body, re.S)
                if v:
                    val = v.group(1)
                    if 't="s"' in c.group(2):
                        val = strs[int(val)]
                else:
                    t = re.findall(r"<t[^>]*>(.*?)</t>", body, re.S)
                    if not t:
                        continue
                    val = "".join(t)
                cells[c.group(1)] = val
            rows.append(cells)
        sheets[name] = rows
    return sheets


def load_code_tables(path):
    z = zipfile.ZipFile(path)
    names = [i for i in z.infolist() if "AreaInformationCity-AreaForecastLocalM" in i.filename]
    if len(names) != 1:
        raise SystemExit("code table AreaInformationCity-AreaForecastLocalM not found in %s" % path)
    sheets = read_xlsx_sheets(z.read(names[0]))
    city = None
    relation = None
    for name, rows in sheets.items():
        if name == "AreaInformationCity":
            city = rows
        elif name.startswith("AreaForecastLocalM") and "警報" in name and "関係表" in name:
            relation = rows
    if city is None or relation is None:
        raise SystemExit("expected sheets not found in code table: %s" % list(sheets))
    return names[0].filename, city, relation


# ---------------------------------------------------------------- geometry

def to_xy(lon, lat, lat0):
    k = math.pi / 180 * EARTH_R
    return (lon * k * math.cos(math.radians(lat0)), lat * k)


def seg_dist(px, py, ax, ay, bx, by):
    dx, dy = bx - ax, by - ay
    if dx == 0 and dy == 0:
        return math.hypot(px - ax, py - ay)
    t = ((px - ax) * dx + (py - ay) * dy) / (dx * dx + dy * dy)
    t = max(0.0, min(1.0, t))
    return math.hypot(px - (ax + t * dx), py - (ay + t * dy))


def dp_keep(xy, tol):
    """Douglas-Peucker on an open polyline; returns sorted indices kept."""
    n = len(xy)
    keep = [False] * n
    keep[0] = keep[-1] = True
    stack = [(0, n - 1)]
    while stack:
        a, b = stack.pop()
        if b <= a + 1:
            continue
        ax, ay = xy[a]
        bx, by = xy[b]
        best, bi = -1.0, -1
        for i in range(a + 1, b):
            d = seg_dist(xy[i][0], xy[i][1], ax, ay, bx, by)
            if d > best:
                best, bi = d, i
        if best > tol:
            keep[bi] = True
            stack.append((a, bi))
            stack.append((bi, b))
    return [i for i in range(n) if keep[i]]


def simplify_ring(ring, tol, lat0):
    pts = ring[:-1] if ring[0] == ring[-1] else ring[:]
    if len(pts) < 3:
        return None
    xy = [to_xy(lon, lat, lat0) for lon, lat in pts]
    # split the closed ring at the vertex farthest from vertex 0
    far = max(range(len(xy)), key=lambda i: (xy[i][0] - xy[0][0]) ** 2 + (xy[i][1] - xy[0][1]) ** 2)
    if far == 0:
        return None
    first = dp_keep(xy[:far + 1], tol)
    second = dp_keep(xy[far:] + [xy[0]], tol)
    idx = first + [far + i for i in second[1:-1]]
    out = [pts[i] for i in idx]
    if len(out) < 3:
        return None
    return out


def ring_area_m2(ring, lat0):
    xy = [to_xy(lon, lat, lat0) for lon, lat in ring]
    s = 0.0
    for i in range(len(xy)):
        x1, y1 = xy[i]
        x2, y2 = xy[(i + 1) % len(xy)]
        s += x1 * y2 - x2 * y1
    return abs(s) / 2


def point_in_rings(lon, lat, rings):
    """Even-odd rule over all rings (outer rings and holes)."""
    inside = False
    for ring in rings:
        n = len(ring)
        j = n - 1
        for i in range(n):
            xi, yi = ring[i]
            xj, yj = ring[j]
            if (yi > lat) != (yj > lat):
                x = (xj - xi) * (lat - yi) / (yj - yi) + xi
                if lon < x:
                    inside = not inside
            j = i
    return inside


def dist_to_rings_m(lon, lat, rings, lat0):
    px, py = to_xy(lon, lat, lat0)
    best = float("inf")
    for ring in rings:
        n = len(ring)
        for i in range(n):
            ax, ay = to_xy(ring[i][0], ring[i][1], lat0)
            bx, by = to_xy(ring[(i + 1) % n][0], ring[(i + 1) % n][1], lat0)
            d = seg_dist(px, py, ax, ay, bx, by)
            if d < best:
                best = d
    return best


def bbox_of(rings):
    xs = [p[0] for r in rings for p in r]
    ys = [p[1] for r in rings for p in r]
    return (min(xs), min(ys), max(xs), max(ys))


def encode_ring(ring):
    """Quantize to 1e-5 degree integers and delta-encode: [x0, y0, dx1, dy1, ...]."""
    out = []
    px = py = 0
    for k, (lon, lat) in enumerate(ring):
        x = int(round(lon * QUANT))
        y = int(round(lat * QUANT))
        if k == 0:
            out += [x, y]
        else:
            if x == px and y == py:
                continue
            out += [x - px, y - py]
        px, py = x, y
    return out


def decode_ring(enc):
    ring = []
    x = y = 0
    for k in range(0, len(enc), 2):
        if k == 0:
            x, y = enc[0], enc[1]
        else:
            x += enc[k]
            y += enc[k + 1]
        ring.append((x / QUANT, y / QUANT))
    return ring


# ---------------------------------------------------------------- build

def simplify_feature(rings, tol, lat0, min_area_m2, stats, dropped):
    out = []
    for ring in rings:
        stats["rings_in"] += 1
        stats["vertices_in"] += len(ring)
        s = simplify_ring(ring, tol, lat0)
        if s is None or ring_area_m2(s, lat0) < min_area_m2:
            stats["rings_dropped"] += 1
            stats["dropped_area_m2"] += ring_area_m2(ring[:-1], lat0) if len(ring) > 3 else 0.0
            dropped.append(ring)
            continue
        # round-trip through the stored encoding so later checks see stored geometry
        s = decode_ring(encode_ring(s))
        if len(s) < 3:
            stats["rings_dropped"] += 1
            dropped.append(ring)
            continue
        stats["vertices_out"] += len(s)
        out.append(s)
    return out


def interior_samples(rings, n, rng):
    x0, y0, x1, y1 = bbox_of(rings)
    pts = []
    tries = 0
    while len(pts) < n and tries < n * 200:
        tries += 1
        lon = rng.uniform(x0, x1)
        lat = rng.uniform(y0, y1)
        if point_in_rings(lon, lat, rings):
            pts.append((lon, lat))
    return pts


def main(argv):
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--weather", required=True, help="市町村等（気象警報等） zip")
    ap.add_argument("--quake", required=True, help="市町村等（地震津波関係） zip")
    ap.add_argument("--prefecture", required=True, help="府県予報区等 zip")
    ap.add_argument("--group", help="市町村等をまとめた地域等 zip (verification only)")
    ap.add_argument("--primary", help="一次細分区域等 zip (verification only)")
    ap.add_argument("--codes", required=True, help="個別コード表 zip (jmaxml_*_Code.zip)")
    ap.add_argument("--pref-code", default="22", help="2-digit prefecture code prefix (default 22 = 静岡県)")
    ap.add_argument("--tolerance-m", type=float, default=30.0, help="Douglas-Peucker tolerance in metres")
    ap.add_argument("--min-ring-area-m2", type=float, default=2000.0, help="drop rings smaller than this after simplification")
    ap.add_argument("--check-points", type=int, default=1000, help="random points for the simplification check")
    ap.add_argument("--seed", type=int, default=20261105)
    ap.add_argument("--out", required=True)
    args = ap.parse_args(argv)

    pc = args.pref_code
    rng = random.Random(args.seed)
    log = []

    def note(msg):
        log.append(msg)
        print(msg, file=sys.stderr)

    weather = load_layer(args.weather, "regioncode", pc)
    quake = load_layer(args.quake, "regioncode", pc)
    pref = load_layer(args.prefecture, "code", pc + "0000")
    if len(pref) != 1:
        raise SystemExit("prefecture %s0000 not found exactly once" % pc)
    code_file, city_rows, rel_rows = load_code_tables(args.codes)

    # ---- hierarchy from the official code table
    city_parent = {}
    city_name_ct = {}
    for r in city_rows:
        code = r.get("A", "")
        if re.fullmatch(pc + r"\d{5}", code) and r.get("F") == "1":
            city_parent[code] = r.get("E", "")
            city_name_ct[code] = r.get("C", "")
    rel = {}
    for r in rel_rows:
        code = r.get("A", "")
        if re.fullmatch(pc + r"\d{4}", code):
            rel[code] = {
                "group": {"code": r["A"], "name": r["B"]},
                "primary": {"code": r["C"], "name": r["D"]},
                "prefecture": {"code": r["E"], "name": r["F"]},
            }

    gis_codes = {f["row"]["regioncode"] for f in weather}
    if gis_codes != set(city_parent):
        note("MISMATCH warning-city codes: only in GIS %s, only in code table %s"
             % (sorted(gis_codes - set(city_parent)), sorted(set(city_parent) - gis_codes)))
        raise SystemExit(2)
    for f in weather:
        r = f["row"]
        if city_name_ct[r["regioncode"]] != r["name"]:
            note("name differs for %s: GIS %r, code table %r" % (r["regioncode"], r["name"], city_name_ct[r["regioncode"]]))
    pr = pref[0]["row"]
    for g in rel.values():
        if g["prefecture"] != {"code": pr["code"], "name": pr["name"]}:
            raise SystemExit("prefecture in relation table differs from GIS: %r" % g["prefecture"])
    note("code table: %s, warning cities %d, groups %d" % (code_file, len(city_parent), len(rel)))

    # ---- full-resolution geometry for verification
    lat0 = 35.0
    full = {
        "city": [(f["row"]["regioncode"], f["rings"]) for f in weather],
        "municipality": [(f["row"]["regioncode"], f["rings"]) for f in quake],
        "prefecture": [(pr["code"], pref[0]["rings"])],
    }

    if args.group or args.primary:
        layers = []
        if args.group:
            layers.append(("group", load_layer(args.group, "code", pc)))
        if args.primary:
            layers.append(("primary", load_layer(args.primary, "code", pc)))
        for key, feats in layers:
            for f in feats:
                f["bbox"] = bbox_of(f["rings"])
            agree = disagree = 0
            for code, rings in full["city"]:
                expect = rel[city_parent[code]][key]["code"]
                for lon, lat in interior_samples(rings, 15, rng):
                    hits = [g["row"]["code"] for g in feats
                            if g["bbox"][0] <= lon <= g["bbox"][2] and g["bbox"][1] <= lat <= g["bbox"][3]
                            and point_in_rings(lon, lat, g["rings"])]
                    if hits == [expect]:
                        agree += 1
                    else:
                        disagree += 1
                        note("hierarchy check %s: city %s sample in %s, code table says %s" % (key, code, hits, expect))
            note("hierarchy check %s: %d sample points agree, %d disagree" % (key, agree, disagree))

    # ---- simplify
    stats = {}
    simp = {}
    dropped = {}
    for key, feats in full.items():
        st = {"rings_in": 0, "rings_dropped": 0, "vertices_in": 0, "vertices_out": 0, "dropped_area_m2": 0.0}
        simp[key] = []
        for code, rings in feats:
            dr = []
            simp[key].append((code, simplify_feature(rings, args.tolerance_m, lat0, args.min_ring_area_m2, st, dr)))
            dropped[(key, code)] = dr
        stats[key] = st
        note("%s: rings %d -> %d, vertices %d -> %d, dropped ring area %.0f m2"
             % (key, st["rings_in"], st["rings_in"] - st["rings_dropped"], st["vertices_in"],
                st["vertices_out"], st["dropped_area_m2"]))

    # quantization error: half a unit in each axis
    quant_err = math.hypot(0.5 / QUANT * math.pi / 180 * EARTH_R, 0.5 / QUANT * math.pi / 180 * EARTH_R)
    max_err = args.tolerance_m + quant_err

    # ---- check: wherever simplified and full geometry disagree, the point
    # must lie within max_err of the simplified boundary (that is what the
    # runtime margin relies on).
    px0, py0, px1, py1 = bbox_of(full["prefecture"][0][1])
    worst = 0.0
    disagreements = 0
    on_dropped = 0
    checked = 0
    for key in ("city", "municipality", "prefecture"):
        fb = [(c, r, bbox_of(r)) for c, r in full[key] if r]
        sb = dict(simp[key])
        for _ in range(args.check_points):
            lon = rng.uniform(px0, px1)
            lat = rng.uniform(py0, py1)
            # bias half of the points to lie near a boundary vertex
            if rng.random() < 0.5:
                c, rings, _b = fb[rng.randrange(len(fb))]
                ring = rings[rng.randrange(len(rings))]
                v = ring[rng.randrange(len(ring))]
                lon = v[0] + rng.uniform(-0.002, 0.002)
                lat = v[1] + rng.uniform(-0.002, 0.002)
            checked += 1
            for code, rings, b in fb:
                if not (b[0] - 0.01 <= lon <= b[2] + 0.01 and b[1] - 0.01 <= lat <= b[3] + 0.01):
                    continue
                a = point_in_rings(lon, lat, rings)
                s = point_in_rings(lon, lat, sb[code]) if sb[code] else False
                if a != s:
                    disagreements += 1
                    if any(point_in_rings(lon, lat, [r]) for r in dropped[(key, code)]):
                        on_dropped += 1
                        continue
                    d = dist_to_rings_m(lon, lat, sb[code], lat0) if sb[code] else float("inf")
                    worst = max(worst, d)
    note("simplification check: %d points, %d containment disagreements (%d of them on dropped small "
         "rings), worst distance to simplified boundary for the rest %.1f m (allowed %.1f m)"
         % (checked, disagreements, on_dropped, worst, max_err))
    if worst > max_err:
        raise SystemExit("simplification check failed: error larger than max_error_m")

    # ---- output
    def feature(row, rings, extra):
        enc = [encode_ring(r) for r in rings]
        b = bbox_of(rings) if rings else None
        f = {"code": row["regioncode"] if "regioncode" in row else row["code"],
             "name": row["name"]}
        if "regionname" in row:
            f["region_name"] = row["regionname"]
        if "namekana" in row:
            f["kana"] = row["namekana"]
        f.update(extra)
        f["bbox"] = [int(round(v * QUANT)) for v in b] if b else None
        f["rings"] = enc
        return f

    simp_city = dict(simp["city"])
    simp_muni = dict(simp["municipality"])
    out = {
        "format": "bw-area/1",
        "prefecture": {"code": pr["code"], "name": pr["name"]},
        "coordinate_system": "JGD2011 (longitude, latitude in degrees)",
        "encoding": {
            "unit_per_degree": QUANT,
            "rings": "flat integer list: x0, y0, then deltas dx, dy; ring is implicitly closed",
            "bbox": "[min_lon, min_lat, max_lon, max_lat] in the same integer unit",
        },
        "simplification": {
            "method": "Douglas-Peucker per ring in a local equirectangular projection (lat0 = %.1f)" % lat0,
            "tolerance_m": args.tolerance_m,
            "quantization_error_m": round(quant_err, 2),
            "max_error_m": round(max_err, 2),
            "min_ring_area_m2": args.min_ring_area_m2,
            "stats": {k: {kk: (round(vv) if isinstance(vv, float) else vv) for kk, vv in v.items()}
                      for k, v in stats.items()},
        },
        "source": {
            "attribution": "出典：気象庁ホームページ（https://www.data.jma.go.jp/developer/gis.html）",
            "processed": "気象庁「予報区等GISデータ」（https://www.data.jma.go.jp/developer/gis.html）を加工して作成"
                         "（静岡県分の切り出し・形状の簡略化・座標の丸め。加工と編集の責任は本プロジェクトにある）",
            "gsi_approval": "この地図の作成に当たっては、国土地理院長の承認を得て、同院発行の数値地図25000（空間データ基盤）、"
                            "数値地図（国土基本情報）、電子国土基本図（地図情報）を使用した。"
                            "（承認番号　平30情使 第401号・令２情使 第125号・令３情使 第90号・令３情使 第123号・"
                            "令３情使 第648号・令４情使 第437号・令５情使 第71号・令６情使 第382号・令７情使 第395号）",
            "files": {
                "city": args.weather.rsplit("/", 1)[-1],
                "municipality": args.quake.rsplit("/", 1)[-1],
                "prefecture": args.prefecture.rsplit("/", 1)[-1],
                "codes": args.codes.rsplit("/", 1)[-1] + " / " + code_file,
            },
        },
        "layers": {
            "city": {
                "type": "市町村等（気象警報等）",
                "features": [feature(f["row"], simp_city[f["row"]["regioncode"]],
                                     {"group": city_parent[f["row"]["regioncode"]]}) for f in weather],
            },
            "municipality": {
                "type": "市町村等（地震津波関係）",
                "features": [feature(f["row"], simp_muni[f["row"]["regioncode"]], {}) for f in quake],
            },
            "prefecture": {
                "type": "府県予報区等",
                "features": [feature(pr, simp["prefecture"][0][1], {})],
            },
        },
        "groups": {code: g for code, g in sorted(rel.items())},
        "build_log": log,
    }
    with open(args.out, "w", encoding="utf-8") as fh:
        json.dump(out, fh, ensure_ascii=False, separators=(",", ":"))
        fh.write("\n")
    print("wrote %s" % args.out, file=sys.stderr)


if __name__ == "__main__":
    main(sys.argv[1:])
