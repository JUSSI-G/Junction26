r"""Make web/public/nordic.json: Northern Europe's coasts, borders and lakes for the 2D map.

    python scripts/make_nordic_map.py <ne_10m_admin_0_countries.geojson> <ne_10m_lakes.geojson>

Source: Natural Earth 1:10m (public domain), github.com/nvkelso/natural-earth-vector/geojson/.
Each polygon is clipped to the map's box (Sutherland–Hodgman) and simplified (Douglas–Peucker,
0.012° ≈ 1 km), coordinates rounded to 3 decimals: a few hundred kB instead of 18 MB.
"""
from __future__ import annotations

import json
import sys
from pathlib import Path

BOX = (-30.0, 40.0, 75.0, 82.0)          # lon_min, lat_min, lon_max, lat_max (well beyond any view)
TOL = 0.012
MIN_LAKE_POINTS = 6
OUT = Path(__file__).resolve().parents[1] / "web" / "public" / "nordic.json"


def clip(ring: list) -> list:
    """Sutherland–Hodgman against the four edges of BOX."""
    x0, y0, x1, y1 = BOX
    edges = [(lambda p: p[0] >= x0, lambda a, b: _ix(a, b, x=x0)),
             (lambda p: p[0] <= x1, lambda a, b: _ix(a, b, x=x1)),
             (lambda p: p[1] >= y0, lambda a, b: _ix(a, b, y=y0)),
             (lambda p: p[1] <= y1, lambda a, b: _ix(a, b, y=y1))]
    out = ring
    for inside, cut in edges:
        if not out:
            break
        src, out = out, []
        prev = src[-1]
        for cur in src:
            if inside(cur):
                if not inside(prev):
                    out.append(cut(prev, cur))
                out.append(cur)
            elif inside(prev):
                out.append(cut(prev, cur))
            prev = cur
    return out


def _ix(a, b, x=None, y=None):
    if x is not None:
        t = (x - a[0]) / (b[0] - a[0])
        return [x, a[1] + t * (b[1] - a[1])]
    t = (y - a[1]) / (b[1] - a[1])
    return [a[0] + t * (b[0] - a[0]), y]


def rdp(pts: list, tol: float) -> list:
    if len(pts) < 3:
        return pts
    keep = [False] * len(pts)
    keep[0] = keep[-1] = True
    stack = [(0, len(pts) - 1)]
    while stack:
        i, j = stack.pop()
        (ax, ay), (bx, by) = pts[i], pts[j]
        dx, dy = bx - ax, by - ay
        norm = (dx * dx + dy * dy) ** 0.5
        best, k = -1.0, -1
        for m in range(i + 1, j):
            if norm < 1e-9:      # a closed ring: first == last, so measure from that point
                d = ((pts[m][0] - ax) ** 2 + (pts[m][1] - ay) ** 2) ** 0.5
            else:
                d = abs(dy * (pts[m][0] - ax) - dx * (pts[m][1] - ay)) / norm
            if d > best:
                best, k = d, m
        if best > tol:
            keep[k] = True
            stack += [(i, k), (k, j)]
    return [p for p, f in zip(pts, keep) if f]


def rings(geom: dict) -> list:
    if geom["type"] == "Polygon":
        return [geom["coordinates"][0]]
    if geom["type"] == "MultiPolygon":
        return [p[0] for p in geom["coordinates"]]
    return []


def shape(ring: list) -> list | None:
    r = rdp(clip([list(p[:2]) for p in ring]), TOL)
    if len(r) < 4:
        return None
    return [[round(x, 3), round(y, 3)] for x, y in r]


def main() -> None:
    countries_path, lakes_path = sys.argv[1:3]
    countries = json.load(open(countries_path, encoding="utf-8"))
    lakes = json.load(open(lakes_path, encoding="utf-8"))
    land = []
    for f in countries["features"]:
        name = f["properties"].get("NAME_EN") or f["properties"].get("NAME")
        polys = [s for s in (shape(r) for r in rings(f["geometry"])) if s]
        if polys:
            land.append({"name": name, "iso": f["properties"].get("ISO_A2_EH") or f["properties"].get("ISO_A2"),
                         "polys": polys})
    water = []
    for f in lakes["features"]:
        for r in rings(f["geometry"]):
            s = shape(r)
            if s and len(s) >= MIN_LAKE_POINTS:
                water.append(s)
    OUT.parent.mkdir(parents=True, exist_ok=True)
    data = {"box": BOX, "source": "Natural Earth 1:10m (public domain)", "land": land, "lakes": water}
    OUT.write_text(json.dumps(data, separators=(",", ":")), encoding="utf-8")
    pts = sum(len(p) for c in land for p in c["polys"]) + sum(len(p) for p in water)
    print(f"{OUT}: {len(land)} countries, {len(water)} lakes, {pts:,} points, {OUT.stat().st_size / 1e3:.0f} kB")


if __name__ == "__main__":
    main()
