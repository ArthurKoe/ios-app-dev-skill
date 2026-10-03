#!/usr/bin/env python3
"""Build the relief-map elevation pyramid from the Copernicus DEM.

Downloads Copernicus GLO-90 (and optionally GLO-30) tiles from the public AWS
open-data buckets, derives water masks (lakes are exactly flat in the
Copernicus DEM, the sea is 0 m), resamples longitudes to near-square pixels,
builds overview levels and writes everything as RDEM chunks plus a
manifest.json per region and a data/regions.json index.

Usage:
    python3 pipeline/build.py                 # build all regions
    python3 pipeline/build.py alps fuji       # build selected regions
    python3 pipeline/build.py --custom my-area "My Area" 46 7 47 9 --glo30 all

See docs/DATA_FORMAT.md for the on-disk layout.
"""
from __future__ import annotations

import argparse
import concurrent.futures as cf
import json
import math
import os
import sys
import time
import urllib.request
from pathlib import Path

import numpy as np
from scipy import ndimage

sys.path.insert(0, str(Path(__file__).resolve().parent))
import rdem  # noqa: E402
from regions import REGIONS, WORLD_PRESETS  # noqa: E402

ROOT = Path(__file__).resolve().parent.parent
DATA = ROOT / "data"
CACHE = Path(os.environ.get("RELIEF_CACHE", ROOT / ".cache" / "copernicus"))

BUCKET = {
    30: "https://copernicus-dem-30m.s3.amazonaws.com",
    90: "https://copernicus-dem-90m.s3.amazonaws.com",
}
RES_CODE = {30: "10", 90: "30"}
ATTRIBUTION = ("Contains modified Copernicus DEM data (GLO-30/GLO-90) "
               "© DLR e.V. 2010-2014 and © Airbus Defence and Space GmbH 2014-2018, "
               "provided under COPERNICUS by the European Union and ESA; all rights reserved.")

M_PER_DEG = 111_320.0
WATER_MIN_KM2 = 0.3
OVERVIEW_MAX_PX = 1_500_000


# --------------------------------------------------------------------------- download

def tile_id(res: int, lat: int, lon: int) -> str:
    ns = "N" if lat >= 0 else "S"
    ew = "E" if lon >= 0 else "W"
    return f"Copernicus_DSM_COG_{RES_CODE[res]}_{ns}{abs(lat):02d}_00_{ew}{abs(lon):03d}_00_DEM"


_TILE_LISTS: dict[int, set[str]] = {}


def tile_list(res: int) -> set[str]:
    if res not in _TILE_LISTS:
        path = CACHE / f"tileList{res}.txt"
        if not path.exists():
            path.parent.mkdir(parents=True, exist_ok=True)
            _download(f"{BUCKET[res]}/tileList.txt", path)
        _TILE_LISTS[res] = set(path.read_text().split())
    return _TILE_LISTS[res]


def _download(url: str, dest: Path, tries: int = 5) -> None:
    tmp = dest.with_suffix(dest.suffix + ".part")
    for attempt in range(tries):
        try:
            with urllib.request.urlopen(url, timeout=120) as r, open(tmp, "wb") as f:
                while True:
                    block = r.read(1 << 20)
                    if not block:
                        break
                    f.write(block)
            tmp.replace(dest)
            return
        except Exception as exc:  # pragma: no cover - network flakiness
            if attempt == tries - 1:
                raise
            wait = 2 ** attempt
            print(f"  retry {url} in {wait}s ({exc})", flush=True)
            time.sleep(wait)


def fetch_tile(res: int, lat: int, lon: int) -> Path | None:
    tid = tile_id(res, lat, lon)
    if tid not in tile_list(res):
        return None  # open ocean - Copernicus has no tile
    dest = CACHE / f"glo{res}" / f"{tid}.tif"
    if not dest.exists():
        dest.parent.mkdir(parents=True, exist_ok=True)
        _download(f"{BUCKET[res]}/{tid}/{tid}.tif", dest)
    return dest


def fetch_many(res: int, cells: list[tuple[int, int]]) -> dict[tuple[int, int], Path | None]:
    out = {}
    with cf.ThreadPoolExecutor(max_workers=8) as ex:
        futs = {ex.submit(fetch_tile, res, a, b): (a, b) for a, b in cells}
        for fut in cf.as_completed(futs):
            out[futs[fut]] = fut.result()
    return out


def read_tile(path: Path) -> np.ndarray:
    import rasterio
    with rasterio.open(path) as ds:
        a = ds.read(1).astype(np.float32)
        if ds.nodata is not None:
            a[a == ds.nodata] = np.nan
    a[a < -1000] = np.nan
    return a


# --------------------------------------------------------------------------- raster helpers

def pick_ppd_lon(ppd_lat: int, native_lon: int, mid_lat: float, candidates: list[int]) -> int:
    """Longitude sampling that gives near-square pixels without upsampling the source."""
    iso = ppd_lat * math.cos(math.radians(mid_lat))
    ok = [c for c in candidates if c <= native_lon]
    return min(ok, key=lambda c: abs(c - iso))


def native_lon_ppd(res: int, lat_cell: int) -> int:
    """Copernicus longitude spacing per latitude band (pixels per degree)."""
    base = 3600 if res == 30 else 1200
    a = abs(lat_cell + 0.5)
    if a < 50:
        f = 1
    elif a < 60:
        f = 1.5
    elif a < 70:
        f = 2
    elif a < 80:
        f = 3
    elif a < 85:
        f = 5
    else:
        f = 10
    return int(round(base / f))


def resample_lon(a: np.ndarray, n_in: float, n_out: float) -> np.ndarray:
    """Resample along axis 1 from n_in to n_out pixels per degree.

    Both grids have pixel centres at k / n (pixel-is-point, anchored at the left
    edge of the array).  Down-sampling uses an exact box (area) filter,
    up-sampling linear interpolation.  NaN-aware.
    """
    if n_in == n_out:
        return a
    h, w = a.shape
    deg = w / n_in
    w_out = int(round(deg * n_out))
    f = n_in / n_out
    centres = np.arange(w_out) * f
    valid = np.isfinite(a)
    v = np.where(valid, a, 0).astype(np.float64)
    wt = valid.astype(np.float64)
    if f >= 1:
        cv = np.concatenate([np.zeros((h, 1)), np.cumsum(v, axis=1)], axis=1)
        cw = np.concatenate([np.zeros((h, 1)), np.cumsum(wt, axis=1)], axis=1)

        def integral(c, t):
            t = np.clip(t, -0.5, w - 0.5)
            k = np.clip(np.floor(t + 0.5).astype(np.int64), 0, w - 1)
            frac = t + 0.5 - k
            return c[:, k] + frac * (c[:, k + 1] - c[:, k])

        t0, t1 = centres - f / 2, centres + f / 2
        num = integral(cv, t1) - integral(cv, t0)
        den = integral(cw, t1) - integral(cw, t0)
    else:
        k = np.clip(np.floor(centres).astype(np.int64), 0, w - 2)
        frac = centres - k
        num = v[:, k] * (1 - frac) + v[:, k + 1] * frac
        den = wt[:, k] * (1 - frac) + wt[:, k + 1] * frac
    with np.errstate(invalid="ignore", divide="ignore"):
        out = np.where(den > 1e-6, num / np.maximum(den, 1e-12), np.nan)
    return out.astype(np.float32)


def down2(a: np.ndarray) -> np.ndarray:
    """2x decimation with a [1,2,1]/4 kernel centred on even pixels (NaN-aware)."""
    def along(x, axis):
        x = np.moveaxis(x, axis, -1)
        p = np.concatenate([x[..., :1], x, x[..., -1:]], axis=-1)
        n = x.shape[-1]
        idx = np.arange(0, n, 2)
        out = p[..., idx] + 2 * p[..., idx + 1] + p[..., idx + 2]
        return np.moveaxis(out, -1, axis)
    valid = np.isfinite(a)
    v = np.where(valid, a, 0).astype(np.float64)
    w = valid.astype(np.float64)
    nv = along(along(v, 0), 1)
    nw = along(along(w, 0), 1)
    with np.errstate(invalid="ignore", divide="ignore"):
        out = np.where(nw > 0.5, nv / np.maximum(nw, 1e-12), np.nan)
    return out.astype(np.float32)


def detect_water(elev: np.ndarray, min_px: int) -> np.ndarray:
    """Lakes are exactly flat and the sea is exactly 0 m in the Copernicus DEM."""
    finite = np.isfinite(elev)
    e = np.where(finite, elev, -1e6).astype(np.float32)
    mx = ndimage.maximum_filter(e, 3)
    mn = ndimage.minimum_filter(e, 3)
    flat = (mx == mn) & finite
    lab, n = ndimage.label(flat, structure=np.ones((3, 3), bool))
    if n == 0:
        return np.zeros_like(finite)
    sizes = np.bincount(lab.ravel())
    keep = sizes >= min_px
    keep[0] = False
    mask = keep[lab]
    del lab
    # grow one pixel into the shoreline ring that sits at (or below) the water level
    level = ndimage.maximum_filter(np.where(mask, e, -1e6), 3)
    grow = ndimage.binary_dilation(mask) & (e <= level + 0.01) & finite
    return mask | grow


def water_min_px(ppd_lat: float, ppd_lon: float, lat: float) -> int:
    px_area = (M_PER_DEG / ppd_lat) * (M_PER_DEG * math.cos(math.radians(lat)) / ppd_lon)
    return max(8, int(WATER_MIN_KM2 * 1e6 / px_area))


# --------------------------------------------------------------------------- chunk writer

class LevelWriter:
    def __init__(self, region_dir: Path, level: int, ppd_lat: float, ppd_lon: float,
                 chunk_deg: float, source: str, mid_lat: float):
        self.dir = region_dir / f"L{level}"
        self.dir.mkdir(parents=True, exist_ok=True)
        self.level = level
        self.ppd_lat, self.ppd_lon = ppd_lat, ppd_lon
        self.chunk_deg = chunk_deg
        self.rows = int(round(ppd_lat * chunk_deg))
        self.cols = int(round(ppd_lon * chunk_deg))
        assert abs(self.rows - ppd_lat * chunk_deg) < 1e-9 and abs(self.cols - ppd_lon * chunk_deg) < 1e-9
        self.source = source
        self.mid_lat = mid_lat
        self.chunks: list[list[int]] = []
        self.bytes = 0
        self.min = math.inf
        self.max = -math.inf

    def write_mosaic(self, elev: np.ndarray, water: np.ndarray, north: float, west: float,
                     keep=None) -> None:
        """Write every chunk overlapping a mosaic whose top-left pixel centre is (north, west)."""
        gy0 = (90 - north) * self.ppd_lat
        gx0 = (west + 180) * self.ppd_lon
        assert abs(gy0 - round(gy0)) < 1e-6 and abs(gx0 - round(gx0)) < 1e-6, (gy0, gx0)
        gy0, gx0 = int(round(gy0)), int(round(gx0))
        h, w = elev.shape
        for cr in range(gy0 // self.rows, (gy0 + h - 1) // self.rows + 1):
            for cc in range(gx0 // self.cols, (gx0 + w - 1) // self.cols + 1):
                y0, x0 = cr * self.rows - gy0, cc * self.cols - gx0
                e = np.full((self.rows, self.cols), np.nan, np.float32)
                m = np.zeros((self.rows, self.cols), bool)
                sy0, sx0 = max(0, y0), max(0, x0)
                sy1, sx1 = min(h, y0 + self.rows), min(w, x0 + self.cols)
                if sy1 <= sy0 or sx1 <= sx0:
                    continue
                e[sy0 - y0:sy1 - y0, sx0 - x0:sx1 - x0] = elev[sy0:sy1, sx0:sx1]
                m[sy0 - y0:sy1 - y0, sx0 - x0:sx1 - x0] = water[sy0:sy1, sx0:sx1]
                self.write_chunk(cr, cc, e, m, keep)

    def write_chunk(self, cr: int, cc: int, e: np.ndarray, m: np.ndarray, keep=None) -> None:
        fin = np.isfinite(e)
        if not fin.any():
            return
        if keep is not None and not keep(e, m):
            return
        buf = rdem.encode(e, m & fin)
        (self.dir / f"{cr}_{cc}.rdem").write_bytes(buf)
        self.chunks.append([cr, cc])
        self.bytes += len(buf)
        self.min = min(self.min, float(np.nanmin(e)))
        self.max = max(self.max, float(np.nanmax(e)))

    def meta(self) -> dict:
        ps_lat = M_PER_DEG / self.ppd_lat
        ps_lon = M_PER_DEG * math.cos(math.radians(self.mid_lat)) / self.ppd_lon
        self.chunks.sort()
        return {
            "level": self.level,
            "source": self.source,
            "ppdLat": self.ppd_lat,
            "ppdLon": self.ppd_lon,
            "chunkDeg": self.chunk_deg,
            "chunkRows": self.rows,
            "chunkCols": self.cols,
            "pixelSizeM": round(max(ps_lat, ps_lon), 1),
            "complete": None,  # filled by caller
            "bytes": self.bytes,
            "chunks": self.chunks,
        }


# --------------------------------------------------------------------------- overview image

HYPSO = [  # elevation (m), RGB
    (-50, (154, 192, 214)),
    (0, (122, 160, 104)),
    (250, (150, 182, 116)),
    (700, (205, 205, 145)),
    (1300, (205, 170, 120)),
    (2000, (170, 140, 115)),
    (2700, (160, 155, 150)),
    (3400, (215, 213, 210)),
    (4300, (246, 246, 246)),
    (9000, (255, 255, 255)),
]
WATER_RGB = np.array([150, 190, 222], np.float32)


def render_overview(elev: np.ndarray, water: np.ndarray, north: float, south: float,
                    west: float, east: float, out_path: Path, thumb_path: Path,
                    max_width: int = 3072) -> dict:
    from PIL import Image
    h, w = elev.shape
    ppd_lat = h / (north - south)
    ppd_lon = w / (east - west)
    lats = north - np.arange(h) / ppd_lat
    e = np.where(np.isfinite(elev), elev, 0).astype(np.float64)
    dy = M_PER_DEG / ppd_lat
    dx = (M_PER_DEG * np.cos(np.radians(lats)) / ppd_lon)[:, None]
    gy, gx = np.gradient(e)
    exag = 1.6
    sx = gx / dx * exag
    sy = -gy / dy * exag  # rows go south
    shade = np.zeros_like(e)
    for az, alt, wgt in ((315, 45, 0.6), (270, 50, 0.2), (0, 50, 0.2)):
        a, b = math.radians(az), math.radians(alt)
        lx, ly, lz = math.sin(a) * math.cos(b), math.cos(a) * math.cos(b), math.sin(b)
        n = np.sqrt(sx * sx + sy * sy + 1)
        shade += wgt * np.clip((-sx * lx - sy * ly + lz) / n, 0, 1)
    stops = np.array([s[0] for s in HYPSO], np.float64)
    cols = np.array([s[1] for s in HYPSO], np.float64)
    rgb = np.stack([np.interp(e, stops, cols[:, i]) for i in range(3)], -1)
    rgb = rgb * (0.45 + 0.75 * shade[..., None])
    wm = water.astype(bool)
    rgb[wm] = WATER_RGB * (0.9 + 0.1 * shade[wm][:, None])
    rgb = np.clip(rgb, 0, 255).astype(np.uint8)

    # resample to Web Mercator rows so Leaflet can overlay it with plain lat/lon bounds
    def merc(lat):
        return math.log(math.tan(math.pi / 4 + math.radians(lat) / 2))
    out_w = min(max_width, w)
    span_x = math.radians(east - west)
    out_h = max(1, int(round(out_w * (merc(north) - merc(south)) / span_x)))
    ys = np.linspace(merc(north), merc(south), out_h)
    lat_rows = np.degrees(2 * np.arctan(np.exp(ys)) - math.pi / 2)
    src_rows = np.clip(np.round((north - lat_rows) * ppd_lat).astype(int), 0, h - 1)
    src_cols = np.clip(np.round(np.linspace(0, w - 1, out_w)).astype(int), 0, w - 1)
    img = Image.fromarray(rgb[src_rows][:, src_cols])
    img.save(out_path, quality=84, optimize=True, progressive=True)
    tw = 480
    th = max(1, int(round(out_h * tw / out_w)))
    img.resize((tw, th), Image.LANCZOS).save(thumb_path, quality=82, optimize=True)
    return {"width": out_w, "height": out_h}


# --------------------------------------------------------------------------- region build

def mountain_chunk(e: np.ndarray, m: np.ndarray) -> bool:
    v = e[np.isfinite(e)]
    if v.size == 0:
        return False
    lo, hi = np.percentile(v, [1, 99])
    return hi >= 1100 or (hi - lo) >= 650


def build_region(reg: dict) -> dict:
    rid = reg["id"]
    south, west, north, east = reg["bounds"]
    mid_lat = (south + north) / 2
    rdir = DATA / rid
    if rdir.exists():
        import shutil
        shutil.rmtree(rdir)
    rdir.mkdir(parents=True)
    cells = [(a, b) for a in range(south, north) for b in range(west, east)]
    t0 = time.time()
    print(f"[{rid}] {len(cells)} cells, fetching GLO-90 ...", flush=True)
    paths90 = fetch_many(90, cells)

    # ---- L1: GLO-90 mosaic at native resolution, water mask, longitude resample
    native = max(native_lon_ppd(90, a) for a in range(south, north))
    ppd1 = pick_ppd_lon(1200, native, mid_lat, [1200, 1000, 800, 600, 400, 300, 200])
    H = (north - south) * 1200
    elev = np.zeros((H, (east - west) * native), np.float32)
    ocean = np.zeros(elev.shape, bool)
    for (a, b), p in paths90.items():
        y0 = (north - a - 1) * 1200
        x0 = (b - west) * native
        if p is None:
            ocean[y0:y0 + 1200, x0:x0 + native] = True
            continue
        t = read_tile(p)
        if t.shape[1] != native:
            t = resample_lon(t, t.shape[1], native)
        elev[y0:y0 + 1200, x0:x0 + native] = t[:1200]
    water = detect_water(elev, water_min_px(1200, native, mid_lat)) | ocean
    elev = resample_lon(elev, native, ppd1)
    water = resample_lon(water.astype(np.float32), native, ppd1) >= 0.5
    levels = []
    w1 = LevelWriter(rdir, 1, 1200, ppd1, 0.5, "Copernicus GLO-90", mid_lat)
    w1.write_mosaic(elev, water, north, west)
    m1 = w1.meta()
    m1["complete"] = True
    levels.append(m1)
    print(f"[{rid}] L1 {elev.shape} ppdLon={ppd1} chunks={len(w1.chunks)} "
          f"{w1.bytes / 1e6:.1f} MB ({time.time() - t0:.0f}s)", flush=True)

    # ---- overview levels by 2x decimation
    lvl_elev, lvl_water = elev, water
    ppd_lat, ppd_lon, chunk_deg, lvl = 1200, ppd1, 0.5, 1
    overview_src = (elev, water)
    while (lvl_elev.size > OVERVIEW_MAX_PX and ppd_lat % 2 == 0 and ppd_lon % 2 == 0):
        lvl += 1
        lvl_elev = down2(lvl_elev)
        lvl_water = down2(lvl_water.astype(np.float32)) >= 0.5
        ppd_lat, ppd_lon, chunk_deg = ppd_lat // 2, ppd_lon // 2, chunk_deg * 2
        wk = LevelWriter(rdir, lvl, ppd_lat, ppd_lon, chunk_deg, "Copernicus GLO-90 (overview)", mid_lat)
        wk.write_mosaic(lvl_elev, lvl_water, north, west)
        mk = wk.meta()
        mk["complete"] = True
        levels.append(mk)
        if lvl_elev.shape[1] >= 2048:
            overview_src = (lvl_elev, lvl_water)
        print(f"[{rid}] L{lvl} {lvl_elev.shape} chunks={len(wk.chunks)} {wk.bytes / 1e6:.1f} MB", flush=True)

    elev_min = float(np.nanmin(elev))
    elev_max = float(np.nanmax(elev))
    ov = render_overview(overview_src[0], overview_src[1], north, south, west, east,
                         rdir / "overview.jpg", rdir / "thumb.jpg")
    del elev, water, lvl_elev, lvl_water, overview_src

    # ---- L0: GLO-30 detail
    glo30 = reg.get("glo30")
    if glo30:
        cells30 = cells if glo30 in ("all", "mountains") else [tuple(c) for c in glo30]
        keep = mountain_chunk if glo30 == "mountains" else None
        print(f"[{rid}] fetching {len(cells30)} GLO-30 tiles ...", flush=True)
        native30 = max(native_lon_ppd(30, a) for a, _ in cells30)
        ppd0 = pick_ppd_lon(3600, native30, mid_lat, [3600, 3000, 2400, 1800, 1200, 900, 600])
        w0 = LevelWriter(rdir, 0, 3600, ppd0, 0.25, "Copernicus GLO-30", mid_lat)
        paths30 = fetch_many(30, cells30)
        for (a, b) in sorted(paths30):
            p = paths30[(a, b)]
            if p is None:
                continue
            t = read_tile(p)[:3600]
            nat = t.shape[1]
            wm = detect_water(t, water_min_px(3600, nat, a + 0.5))
            t = resample_lon(t, nat, ppd0)
            wm = resample_lon(wm.astype(np.float32), nat, ppd0) >= 0.5
            w0.write_mosaic(t, wm, a + 1, b, keep=keep)
            elev_max = max(elev_max, float(np.nanmax(t)))
        m0 = w0.meta()
        m0["complete"] = glo30 == "all"
        m0["coverage"] = ("mountainous areas only" if glo30 == "mountains" else
                          "whole region" if glo30 == "all" else
                          "selected 1° cells: " + ", ".join(f"{a},{b}" for a, b in cells30))
        levels.insert(0, m0)
        print(f"[{rid}] L0 ppdLon={ppd0} chunks={len(w0.chunks)} {w0.bytes / 1e6:.1f} MB", flush=True)

    manifest = {
        "id": rid,
        "name": reg["name"],
        "group": reg.get("group", ""),
        "subtitle": reg.get("subtitle", ""),
        "bounds": {"south": south, "west": west, "north": north, "east": east},
        "elevation": {"min": round(elev_min, 1), "max": round(elev_max, 1)},
        "format": "rdem-1",
        "attribution": ATTRIBUTION,
        "levels": levels,
        "overview": {"image": "overview.jpg", "thumbnail": "thumb.jpg", "projection": "EPSG:3857",
                     **ov},
        "presets": [
            {"name": p[0], "lat": p[1], "lon": p[2], "widthKm": p[3], "heightKm": p[4]}
            for p in reg.get("presets", [])
        ],
    }
    (rdir / "manifest.json").write_text(json.dumps(manifest, separators=(",", ":")))
    total = sum(l["bytes"] for l in levels)
    print(f"[{rid}] done: {total / 1e6:.1f} MB in {time.time() - t0:.0f}s", flush=True)
    return manifest


def write_index() -> None:
    regions = []
    for d in sorted(DATA.iterdir()):
        mf = d / "manifest.json"
        if not mf.exists():
            continue
        m = json.loads(mf.read_text())
        best = min(l["pixelSizeM"] for l in m["levels"])
        regions.append({
            "id": m["id"], "name": m["name"], "group": m["group"], "subtitle": m["subtitle"],
            "bounds": m["bounds"], "elevation": m["elevation"],
            "bestResolutionM": best,
            "bytes": sum(l["bytes"] for l in m["levels"]),
            "manifest": f"{m['id']}/manifest.json",
            "thumbnail": f"{m['id']}/thumb.jpg",
            "presetCount": len(m["presets"]),
        })
    order = {r["id"]: i for i, r in enumerate(REGIONS)}
    regions.sort(key=lambda r: order.get(r["id"], 999))
    index = {
        "version": 1,
        "attribution": ATTRIBUTION,
        "regions": regions,
        "worldPresets": [
            {"name": p[0], "lat": p[1], "lon": p[2], "widthKm": p[3], "heightKm": p[4]}
            for p in WORLD_PRESETS
        ],
    }
    (DATA / "regions.json").write_text(json.dumps(index, indent=1))
    print(f"index: {len(regions)} regions, {sum(r['bytes'] for r in regions) / 1e6:.1f} MB")


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("regions", nargs="*", help="region ids (default: all)")
    ap.add_argument("--custom", nargs=6, metavar=("ID", "NAME", "SOUTH", "WEST", "NORTH", "EAST"),
                    help="build an ad-hoc region from whole-degree bounds")
    ap.add_argument("--glo30", default=None, help="for --custom: 'all' to add 30 m data")
    ap.add_argument("--index-only", action="store_true")
    args = ap.parse_args()
    DATA.mkdir(exist_ok=True)
    if not args.index_only:
        if args.custom:
            rid, name, s, w, n, e = args.custom
            build_region({"id": rid, "name": name, "group": "Custom", "subtitle": "",
                          "bounds": [int(s), int(w), int(n), int(e)], "glo30": args.glo30,
                          "presets": []})
        else:
            wanted = set(args.regions)
            for reg in REGIONS:
                if not wanted or reg["id"] in wanted:
                    build_region(reg)
    write_index()


if __name__ == "__main__":
    main()
