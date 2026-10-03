# Elevation data format

All elevation data lives in `data/` and is produced by `pipeline/build.py` from the
[Copernicus DEM](https://spacedata.copernicus.eu/collections/copernicus-digital-elevation-model)
(GLO-30 = 1 arc-second ≈ 30 m, GLO-90 = 3 arc-seconds ≈ 90 m) hosted on the AWS open data
registry. Heights are EGM2008 orthometric heights in metres, rounded to 1 m.

```
data/
  regions.json                 index of all regions (+ "worldPresets" for live data)
  <region-id>/
    manifest.json              region metadata, levels, chunk lists, presets
    overview.jpg               shaded relief in Web Mercator, covers manifest.bounds exactly
    thumb.jpg                  480 px wide thumbnail of the same
    L0/<cr>_<cc>.rdem          GLO-30 detail chunks (optional, may be partial)
    L1/<cr>_<cc>.rdem          GLO-90 chunks (always complete for the bounds)
    L2/ … Ln/                  2x decimated overviews of L1
```

## Grid geometry

Every level is a regular latitude/longitude grid anchored at (90° N, 180° W) with
**pixel-is-point** semantics:

```
global row  gy = (90 - lat) * ppdLat         (integer at pixel centres)
global col  gx = (lon + 180) * ppdLon
pixel (gy, gx) is the elevation exactly at that lat/lon
```

`ppdLat`/`ppdLon` = pixels per degree. Longitude spacing is chosen per region so pixels are
roughly square on the ground (e.g. the Alps L0 uses 3600 × 2400 ppd ≈ 31 × 32 m).

Chunks tile the global grid: chunk `(cr, cc)` holds global rows
`cr*chunkRows … cr*chunkRows + chunkRows - 1` and columns `cc*chunkCols …`.
File name: `L<level>/<cr>_<cc>.rdem`. Only chunks listed in `manifest.levels[i].chunks`
exist. Pixels outside the region bounds inside an existing chunk are *nodata*.

Bilinear interpolation between neighbouring pixels may need up to 4 chunks.

## Levels (manifest.levels)

```jsonc
{
  "level": 1,                 // 0 = GLO-30 detail, 1 = GLO-90, 2.. = overviews
  "source": "Copernicus GLO-90",
  "ppdLat": 1200, "ppdLon": 800,
  "chunkDeg": 0.5, "chunkRows": 600, "chunkCols": 400,
  "pixelSizeM": 92.8,         // max(ground pixel height, width) at the region's mid latitude
  "complete": true,           // false: only some chunks exist (e.g. Alps L0 = mountains only)
  "coverage": "mountainous areas only",   // only on partial levels
  "bytes": 61234567,
  "chunks": [[82, 368], [82, 369], ...]   // [cr, cc] of every existing chunk
}
```

Levels are ordered finest first. A sampler that wants ground spacing `g` metres picks the
coarsest level with `pixelSizeM <= g` (or the finest level), and falls back to the next
coarser level wherever a chunk is missing.

## RDEM chunk encoding (version 1)

Little-endian binary:

| offset | size | field |
|-------:|-----:|-------|
| 0  | 4 | magic `"RDEM"` |
| 4  | 1 | version = 1 |
| 5  | 1 | flags (bit 0: water mask present) |
| 6  | 2 | reserved |
| 8  | 2 | width (uint16) |
| 10 | 2 | height (uint16) |
| 12 | 4 | scale (float32, metres per stored unit, 1.0) |
| 16 | 4 | offset (float32, metres, 0.0) |
| 20 | 4 | elevation stream byte length E (uint32) |
| 24 | 4 | mask stream byte length M (uint32, 0 when no mask) |
| 28 | 4 | min elevation, metres (float32) |
| 32 | 4 | max elevation, metres (float32) |
| 36 | E | zlib (RFC 1950) stream of `width*height` int16 LE residuals |
| 36+E | M | zlib stream of the water mask, 1 bit per pixel, row-major, MSB first |

Stored value `v` (int16): elevation = `v * scale + offset`; `v = -32768` means nodata.

Residuals come from a 2-D gradient predictor, all arithmetic wrapped to int16:

```
pred(0,0) = 0
pred(0,c) = v(0,c-1)
pred(r,0) = v(r-1,0)
pred(r,c) = v(r,c-1) + v(r-1,c) - v(r-1,c-1)
residual  = int16(v - pred)        decode: v = int16(residual + pred)
```

In the browser the zlib streams are decoded with `new DecompressionStream('deflate')`.

**Water mask**: 1 = lake or sea. Lakes in the Copernicus DEM are exactly flat and the sea is
0 m, so the pipeline marks flat connected areas ≥ 0.3 km² (and open ocean) as water.

## Overview image

`overview.jpg` is a hypsometric-tinted, multi-directional hillshade rendered in Web Mercator
rows so `L.imageOverlay(url, [[south, west], [north, east]])` lines up exactly.

## Live data (anywhere on Earth)

Outside the stored regions the app samples [AWS Terrain Tiles](https://registry.opendata.aws/terrain-tiles/)
(Terrarium PNG: `elevation = R*256 + G + B/256 - 32768`), which are CORS-enabled.
