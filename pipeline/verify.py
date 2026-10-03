#!/usr/bin/env python3
"""Sanity-check built regions against the original Copernicus GeoTIFFs.

For random points inside each region the elevation interpolated from our RDEM
chunks (every level) is compared with the elevation sampled from the source
tile.  A georeferencing mistake (off-by-one rows, wrong chunk indices, swapped
axes) shows up as large median errors.

Usage: python3 pipeline/verify.py [region ...]
"""
from __future__ import annotations

import json
import sys
from pathlib import Path

import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parent))
import rdem  # noqa: E402
from build import CACHE, DATA, fetch_tile, read_tile  # noqa: E402

_chunk_cache: dict[Path, tuple] = {}


def chunk(path: Path):
    if path not in _chunk_cache:
        _chunk_cache[path] = rdem.decode(path.read_bytes()) if path.exists() else None
    return _chunk_cache[path]


def sample_level(region_dir: Path, lvl: dict, lat: float, lon: float) -> float:
    gy = (90 - lat) * lvl["ppdLat"]
    gx = (lon + 180) * lvl["ppdLon"]
    y0, x0 = int(np.floor(gy)), int(np.floor(gx))
    fy, fx = gy - y0, gx - x0
    acc = wsum = 0.0
    for dy, dx, w in ((0, 0, (1 - fy) * (1 - fx)), (0, 1, (1 - fy) * fx), (1, 0, fy * (1 - fx)), (1, 1, fy * fx)):
        y, x = y0 + dy, x0 + dx
        cr, cc = y // lvl["chunkRows"], x // lvl["chunkCols"]
        c = chunk(region_dir / f"L{lvl['level']}" / f"{cr}_{cc}.rdem")
        if c is None:
            continue
        v = c[0][y - cr * lvl["chunkRows"], x - cc * lvl["chunkCols"]]
        if np.isfinite(v):
            acc += w * v
            wsum += w
    return acc / wsum if wsum > 0 else float("nan")


def sample_source(res: int, lat: float, lon: float) -> float:
    a, b = int(np.floor(lat)), int(np.floor(lon))
    p = fetch_tile(res, a, b)
    if p is None:
        return 0.0
    key = Path(str(p) + ".npy")
    t = _chunk_cache.get(key)
    if t is None:
        t = read_tile(p)
        _chunk_cache[key] = t
    h, w = t.shape
    gy = (a + 1 - lat) * (h if h in (1200, 3600) else 3600)
    gx = (lon - b) * w
    y0, x0 = int(np.floor(gy)), int(np.floor(gx))
    y0, x0 = min(y0, h - 2), min(x0, w - 2)
    fy, fx = gy - y0, gx - x0
    return float(t[y0, x0] * (1 - fy) * (1 - fx) + t[y0, x0 + 1] * (1 - fy) * fx
                 + t[y0 + 1, x0] * fy * (1 - fx) + t[y0 + 1, x0 + 1] * fy * fx)


def check_presets(m: dict) -> bool:
    """Every preset frame (unrotated) must lie inside the region bounds, or the app falls back to live data."""
    b = m["bounds"]
    ok = True
    for p in m["presets"]:
        dlat = p["heightKm"] / 2 / 111.32
        worst_lat = max(abs(p["lat"] - dlat), abs(p["lat"] + dlat))
        dlon = p["widthKm"] / 2 / (111.32 * np.cos(np.radians(min(worst_lat, 89))))
        inside = (p["lat"] - dlat >= b["south"] and p["lat"] + dlat <= b["north"]
                  and p["lon"] - dlon >= b["west"] and p["lon"] + dlon <= b["east"])
        if not inside:
            ok = False
            print(f"  BAD preset '{p['name']}' extends beyond the region bounds")
    return ok


def verify(region_id: str, n: int = 300) -> bool:
    rdir = DATA / region_id
    m = json.loads((rdir / "manifest.json").read_text())
    b = m["bounds"]
    rng = np.random.default_rng(42)
    lats = rng.uniform(b["south"] + 0.01, b["north"] - 0.01, n)
    lons = rng.uniform(b["west"] + 0.01, b["east"] - 0.01, n)
    ok = check_presets(m)
    for lvl in m["levels"]:
        res = 30 if lvl["level"] == 0 else 90
        errs = []
        for lat, lon in zip(lats, lons):
            ours = sample_level(rdir, lvl, lat, lon)
            if not np.isfinite(ours):
                continue
            ref = sample_source(res, lat, lon)
            errs.append(abs(ours - ref))
        errs = np.array(errs)
        if errs.size == 0:
            print(f"  {region_id} L{lvl['level']}: no samples inside coverage")
            continue
        med, p90 = float(np.median(errs)), float(np.percentile(errs, 90))
        # overview levels are smoothed, so allow more slack there
        limit = 6 if lvl["level"] <= 1 else 15 * 2 ** (lvl["level"] - 1)
        flag = "OK " if med <= limit else "BAD"
        ok &= med <= limit
        print(f"  {flag} {region_id} L{lvl['level']}: n={errs.size} median|Δ|={med:.1f} m  p90={p90:.1f} m  (limit {limit})")
    return ok


if __name__ == "__main__":
    ids = sys.argv[1:] or [d.name for d in sorted(DATA.iterdir()) if (d / "manifest.json").exists()]
    print(f"cache: {CACHE}")
    results = [verify(i) for i in ids]
    sys.exit(0 if all(results) else 1)
