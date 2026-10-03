# Relief Studio – architecture & module contracts

Relief Studio is a **static, build-free web app** (vanilla ES modules) that turns elevation
data into tiled, 3D-printable relief maps. It runs from any static file server
(`npm start` → `node scripts/serve.mjs`) or GitHub Pages. All heavy work (data loading,
sampling, meshing, STL writing) runs in a module Web Worker.

This document is the **contract** between modules. Signatures here are binding; if you need
something extra, add it without breaking what is listed.

## Ground rules

* Plain ES modules, relative imports **with `.js` extension**. No bundler, no TypeScript, no
  npm runtime dependencies. Only vendored libs in `app/vendor/`:
  * `app/vendor/three/three.module.js` (+ `addons/controls/OrbitControls.js`) – three r186.
    Pages use an import map: `"three": "./app/vendor/three/three.module.js"`,
    `"three/addons/": "./app/vendor/three/addons/"`.
  * `app/vendor/leaflet/leaflet-src.esm.js` (+ `leaflet.css`, `images/`) – Leaflet 1.9.4 ESM
    (`import * as L from '../../vendor/leaflet/leaflet-src.esm.js'`).
  * `app/vendor/fflate/fflate.js` – fflate 0.8 ESM (`zipSync`, `Zip`, `ZipDeflate`, `ZipPassThrough`, `deflateSync`, `inflateSync`, `strToU8`, …).
  * `app/vendor/delatin/delatin.js` – Delatin 0.2 (`export default class Delatin`).
* Modules under `app/js/core`, `dem`, `model`, `mesh`, `catalog`, `estimate`, `engine/pipeline.js`
  and `export/printPlan.js` must be **DOM-free** so they run in the worker and in Node 22
  unit tests (`node --test tests/unit`). Use `globalThis.fetch`, `DecompressionStream`,
  `OffscreenCanvas`/`createImageBitmap` only where stated, and allow injection for tests.
* Document public functions with JSDoc. Keep functions pure where possible.
* Units: millimetres for print geometry, metres for terrain, degrees for lat/lon.
* Never block the UI thread for > 50 ms; anything heavy goes through the engine worker.

## Coordinate conventions (important)

* **Frame** – the selected map rectangle:
  `{ lat, lon, widthKm, heightKm, rotationDeg }`. Centre in degrees, size on the ground,
  rotation = bearing of the frame's "up" direction in degrees clockwise from north.
  Ground positions are computed in a spherical **transverse Mercator** projection centred on
  `(lat, lon)` (see `core/projection.js`).
* **Frame UV** – `u ∈ [0,1]` left→right, `v ∈ [0,1]` top→bottom.
* **Artwork** – the whole printed piece: `artW × artH` mm, x to the right, y up, z out of the
  wall. Artwork aspect always equals frame aspect (`heightKm/widthKm = artH/artW`).
* **Grids** (`Float32Array`, row-major) have **row 0 at the TOP edge** (max y, north side),
  column 0 at the left edge. Sample `(r, c)` of an `nx × ny` grid spanning `W × H` mm sits at
  `x = c * W/(nx-1)`, `y = H - r * H/(ny-1)`. Grid corners are exactly on the edges.
* **Tiles** – `cols × rows`; tile `(row, col)` with row 0 at the top. Label =
  `String.fromCharCode(65 + row) + (col + 1)` → `A1` is top-left. Tile size `tileW × tileH`.
  Tile origin in artwork coords: `x0 = col*tileW`, `y0 = artH - (row+1)*tileH`.
  Each tile mesh is in **tile-local** coordinates: `x ∈ [0,tileW]`, `y ∈ [0,tileH]`, `z ≥ 0`,
  bottom face at z = 0 (plus pockets), relief up (+z). That is also the print orientation.
  Neighbouring tiles share their boundary samples so heights match across seams.

## Shared data shapes (JSDoc typedefs, defined in `app/js/types.js`)

```js
/** @typedef {{lat:number, lon:number, widthKm:number, heightKm:number, rotationDeg:number}} Frame */
/** @typedef {{nx:number, ny:number, z:Float32Array}} Grid  // values in mm unless stated */
/** @typedef {{positions:Float32Array, indices:Uint32Array}} Mesh  // indexed triangles, CCW = outward */
/** @typedef {{
 *   cols:number, rows:number, tileW:number, tileH:number, artW:number, artH:number,
 *   scaleMPerMm:number,      // ground metres per printed mm (frame.widthKm*1000/artW)
 *   scaleDenominator:number, // e.g. 850000 for 1:850,000
 *   spx:number, spy:number,  // samples per tile along x / y (segments, grid has spx+1 points)
 *   nx:number, ny:number,    // artwork grid size = cols*spx+1, rows*spy+1
 *   dx:number, dy:number,    // mm between samples (tileW/spx, tileH/spy)
 *   fitsBed:boolean, rotateOnBed:boolean, warnings:string[]
 * }} Layout */
/** @typedef {{
 *   floorM:number, mmPerM:number, baseMm:number, exaggeration:number,
 *   minElevM:number, maxElevM:number, maxZMm:number
 * }} ZMap  // zTop(e) = baseMm + max(0, e - floorM) * mmPerM */
/** @typedef {{
 *   label:string, row:number, col:number, x0:number, y0:number, widthMm:number, heightMm:number,
 *   top:Grid, water?:Uint8Array, bottom:Grid|null    // bottom.z = height of the underside (0 = flat, >0 = pocket)
 * }} TileField */
/** @typedef {{filamentId:string, zFrom:number, zTo:number, layerFrom:number, elevFromM:number|null,
 *   color:string, finish:string, name:string}} ResolvedBand */
```

## Project (the single source of truth) – `app/js/state/project.js`

Everything the user can change lives in one JSON-serialisable object. `DEFAULT_PROJECT`
must look like this (values are the defaults):

```js
export const DEFAULT_PROJECT = {
  version: 1,
  name: 'The Alps',
  regionId: 'alps',               // a region id from data/regions.json, or 'world'
  source: 'auto',                 // 'auto' | 'local' | 'live'
  frame: { lat: 45.95, lon: 10.75, widthKm: 900, heightKm: 450, rotationDeg: 0 },
  printer: { presetId: 'bambu-x1', bedW: 256, bedH: 256, maxZ: 256, nozzleMm: 0.4 },   // = the 'bambu-x1' preset
  layout: { cols: 4, rows: 2, tileW: 246, tileH: 246 },
  relief: {
    exaggeration: 4, autoExaggeration: true, targetReliefMm: 30,   // auto: exaggeration fits the relief to ~30 mm
    baseMm: 3,
    floor: { mode: 'auto', elevationM: 0 },     // 'auto' | 'sea' | 'fixed'
    smoothingMm: 0.4,                            // gaussian sigma in printed mm (sigma_samples = smoothingMm/dx), 0 = off
    resolutionMm: 0.4,                           // export sample spacing
    simplifyMm: 0.02,                            // export mesh max error (0 = full grid)
    water: { mode: 'recess', depthMm: 0.6 },    // 'none' | 'flat' | 'recess'
    maxHeightMm: 0,                              // 0 = no clamp
  },
  style: { id: 'classic', params: {} },          // params merged over the style's defaults
  border: { enabled: false, widthMm: 6, heightMm: 2 },   // rim around the artwork, heightMm above base
  colors: {
    mode: 'bands',                               // 'single' | 'bands'
    themeId: 'alpine-classic',
    autoFit: true,                               // recompute band elevations from the theme on terrain change
    bands: [                                     // ascending; first band starts at the bottom
      { filamentId: 'pla-forest-green', fromM: null },
      { filamentId: 'pla-olive', fromM: 900 },
      { filamentId: 'pla-stone-grey', fromM: 1800 },
      { filamentId: 'pla-snow-white', fromM: 2700 },
    ],
    singleFilamentId: 'pla-snow-white',
    layerHeightMm: 0.2, firstLayerMm: 0.2,
  },
  filaments: { owned: [], custom: [] },          // ids the user owns; user-defined filament objects
  back: {
    labels: true, labelDepthMm: 0.6,
    magnets: { enabled: false, diameterMm: 10.2, depthMm: 3.2, perTile: 4, insetMm: 25 },
  },
  print: { material: 'PLA', infillPct: 15, walls: 3, topLayers: 5, bottomLayers: 4,
           speedClass: 'standard' },             // 'slow' | 'standard' | 'fast'
  view: { lighting: 'gallery', wallColor: '#ece8e1', wallMode: true, exploded: false,
          seams: true, layerLines: true, labels: true, highlightWater: false },
};
```

`state/store.js` exports `createStore(initialProject)` → `{ get(), set(patchFn|partial, {source}), subscribe(fn) }`
and `normalizeProject(p, ctx)` which enforces invariants (frame aspect = artwork aspect,
clamps, base ≥ magnet depth + 0.8, bands sorted, style params limited to the style's own
parameters and ranges from `catalog/artStyles.js`, …). `state/persistence.js` handles
localStorage autosave, JSON file import/export and the `#p=` URL hash (deflate + base64url via fflate).

`state/project.js` also has the framing helpers used for presets, regions and place search:
`frameContainingRect(rect, aspect)`, `nudgeFrameInside(frame, keep, bounds)` and
`frameForRect(rect, aspect, bounds)` – the preset widened to the artwork aspect and kept on the
region's stored data, cropped (never below the preset's shorter side) when widening would leave it.
Choosing a region opens its widest preset.

## Module map & contracts

### core/ (pure)

**`core/projection.js`**
```js
export const EARTH_RADIUS = 6371008.8;
export function tmForward(lat, lon, lat0, lon0)   // → [x, y] metres (x east, y north)
export function tmInverse(x, y, lat0, lon0)       // → [lat, lon]
export function frameLocalToLatLon(frame, xm, ym) // xm right, ym up, metres from centre, before rotation
export function frameUVToLatLon(frame, u, v)      // → [lat, lon]
export function latLonToFrameUV(frame, lat, lon)  // → [u, v]
export function framePolygon(frame, segmentsPerEdge = 16) // → [[lat, lon], ...] ring, clockwise from top-left, not closed
export function frameBounds(frame)                // → {south, west, north, east}
export function haversineKm(lat1, lon1, lat2, lon2)
```
Spherical TM: forward `B = cosφ·sin(λ-λ0)`, `x = R·atanh(B)`, `y = R·(atan2(tanφ, cos(λ-λ0)) - φ0)`;
inverse `D = y/R + φ0`, `φ = asin(sin D / cosh(x/R))`, `λ = λ0 + atan2(sinh(x/R), cos D)`.
Rotation θ (clockwise): projected `x = xr·cosθ + yr·sinθ`, `y = -xr·sinθ + yr·cosθ`.

**`core/rdem.js`** – `export async function decodeRDEM(arrayBuffer)` →
`{ width, height, elev: Float32Array /* metres, NaN = nodata */, water: Uint8Array|null, min, max }`
(see docs/DATA_FORMAT.md). Uses `DecompressionStream('deflate')`.

### dem/ (pure, uses fetch)

```js
// dem/localSource.js
export class LocalRegionSource {
  static async load(manifestUrl, { fetchImpl } = {})   // reads manifest.json; chunk URLs resolve relative to it
  constructor(manifest, baseUrl, { fetchImpl })
  manifest; id; bounds;
  chooseLevel(groundSpacingM)          // index into manifest.levels (coarsest with pixelSizeM <= spacing, else finest)
  async prepare(frame, groundSpacingM, { onProgress, signal, maxBytes = 300e6 })
     // loads every chunk needed to sample the frame polygon (+1 px margin) at the chosen level
     // and the next coarser complete level as fallback; returns {level, pixelSizeM, chunks, bytes}
  sample(lat, lon)                     // bilinear metres, NaN if no data anywhere
  isWater(lat, lon)                    // nearest-pixel water flag (boolean)
}
// dem/terrariumSource.js
export class TerrariumSource {
  constructor({ urlTemplate = 'https://s3.amazonaws.com/elevation-tiles-prod/terrarium/{z}/{x}/{y}.png',
                maxZoom = 15, fetchImpl, decodePng })  // decodePng(blob) → {width,height,data:Uint8ClampedArray RGBA}; default uses createImageBitmap + OffscreenCanvas
  chooseZoom(groundSpacingM, lat)
  async prepare(frame, groundSpacingM, { onProgress, signal, maxTiles = 400 })
  sample(lat, lon); isWater(lat, lon)  // isWater: elevation <= 0 (Terrarium has no lake mask)
}
// dem/sampler.js
export function chooseSource(project, regionsIndex)   // → 'local' | 'live' (honours project.source; 'auto' = local when the frame lies inside the region bounds)
export async function sampleFrame(source, frame, nx, ny, { onProgress, signal })
  // → { elev: Float32Array(nx*ny) metres (NaN → filled with 0 and counted), water: Uint8Array(nx*ny),
  //     missing: number /* samples without data */, minElev, maxElev }
  // sample (r, c) is taken at frameUVToLatLon(frame, c/(nx-1), r/(ny-1))
```
A per-source chunk cache (LRU by bytes, ~600 MB decoded) is kept so repeated previews are fast.

### model/ (pure)

```js
// model/layout.js
export function computeLayout(project, resolutionMm)        // → Layout (see typedef). spx = max(2, round(tileW/res)), same for spy.
export function fitTileToBed(printer, marginMm = 5)        // → {tileW, tileH} largest square tile that fits the bed
// model/zmap.js
export function computeZMap(project, layout, stats)        // stats: {minElev, maxElev} of the frame → ZMap
   // floor: 'auto' → floor(minElev/50)*50 (never below 0 unless minElev < 0), 'sea' → 0, 'fixed' → elevationM
   // autoExaggeration: exaggeration = clamp(targetReliefMm / ((maxElev-floor)/scaleMPerMm), 0.5, 30), rounded to 0.1
   // mmPerM = exaggeration / scaleMPerMm ; zTop(e) = baseMm + max(0, e - floorM) * mmPerM, then maxHeightMm clamp
// model/filters.js
export function gaussianBlur(z, nx, ny, sigma)             // separable, edge-clamped, returns new Float32Array
export function hillshade(elev, nx, ny, dxM, dyM, azimuthDeg, altitudeDeg) // → Float32Array 0..1
export function gradientMagnitude(z, nx, ny, dx, dy)
// model/styles.js
export function buildArtworkField(sampled, layout, zmap, project)
   // sampled = {elev, water} from sampleFrame at layout.nx × layout.ny
   // → { z: Float32Array (mm, top surface of the whole artwork), water: Uint8Array, meshToleranceMm?:number }
   // applies smoothing, water mode, the art style (classic | terraced | lowpoly | ridgelines | hex | contours | lithophane)
   // and the border rim. Guarantees z >= 0.6 mm everywhere (and >= max back pocket depth + 0.6).
   // Water: smoothing must not tilt lakes (restore the flat lake level inside the mask);
   // 'recess' lowers water by depthMm (never below the minimum thickness).
export function styleDefaults(styleId)          // → default params of a style (must equal the table below)
export function styleResolutionHint(project)    // → mm|null: finest sample spacing the style needs to look right
   // (ridgelines: thicknessMm/3, hex: max(gapMm/2, 0.15) when gapMm>0, contours: lineWidthMm/2). The pipeline
   // uses min(resolutionMm, hint) for export (never below 0.1 mm).
// model/tiles.js
export function extractTileFields(field, layout, project, { withBack = true, backResMm = 0.25 })
   // → TileField[] (row-major, A1 first). top = sub-grid of the artwork field (shared edges),
   //   bottom = model/back.js result or null when no back features / withBack=false
// model/back.js
export function buildBackGrid(tile, layout, project, backResMm)   // → Grid|null (labels engraved, magnet pockets)
   // labels: text = tile label + ' ↑' (arrow points to the artwork top), mirrored so it reads correctly
   // when the tile is turned face-down around its vertical axis, height ≈ min(12, tileH/6) mm, centred.
// model/font.js
export function rasterizeText(text, heightMm, strokeMm, resMm)   // → {w, h, mask:Uint8Array} built-in stroke font (A–Z, 0–9, '-', '↑', ' ')
```

Art styles (ids and params; defaults live in `catalog/artStyles.js`):

| id | idea | params |
|----|------|--------|
| `classic` | smooth shaded relief | – |
| `terraced` | stepped contour terraces (like layered wood art) | `stepMode` 'count'/'meters', `count` 16, `stepM` 200, `snapToLayers` true |
| `lowpoly` | crystalline triangles | `facetMm` 1.2 (used as mesh tolerance, also for preview) |
| `ridgelines` | thin parallel ribs following the terrain profile ("Unknown Pleasures") | `spacingMm` 5, `thicknessMm` 1.2, `direction` 'horizontal'/'vertical', `staggerMm` 0 (UI range 0–1 mm: rib k is lifted k·stagger) |
| `hex` | hexagonal (or square) columns | `shape` 'hex'/'square', `cellMm` 8, `gapMm` 0.6, `stepMm` 0 |
| `contours` | relief with engraved/embossed contour lines | `intervalM` 200, `majorEvery` 5, `lineWidthMm` 0.6, `depthMm` 0.4, `mode` 'engrave'/'emboss' |
| `lithophane` | backlit lithophane of the hillshade (print in white) | `minMm` 0.8, `maxMm` 3.2, `sunAzimuth` 315, `sunAltitude` 35, `contrast` 1 |

### mesh/ (pure)

```js
// mesh/triangulate.js
export function triangulateGrid(z, nx, ny, toleranceMm)
  // → { coords: Uint32Array [gx0,gy0, gx1,gy1, ...] grid coordinates, triangles: Uint32Array }
  // toleranceMm <= 0 → regular grid (2 triangles per cell); otherwise Delatin.run(tolerance).
  // Triangles are returned CCW in *artwork* orientation (y up, i.e. gy flipped).
// mesh/solid.js
export function buildSolid({ top, bottom, widthMm, heightMm, topToleranceMm = 0, bottomToleranceMm = 0.01, topWater = null })
  // top/bottom: Grid spanning the full rectangle (row 0 = y = heightMm). bottom null → flat z=0 face
  // made of the 4 corners only. Walls stitch the top and bottom boundary polylines ("zipper").
  // → Mesh, closed 2-manifold, outward CCW, no duplicate vertices on shared edges.
  //   If topWater (Uint8Array, one flag per top grid sample) is given, the result also has
  //   mesh.water: Uint8Array with one flag per vertex (0 for wall/bottom vertices) for the preview.
// mesh/stl.js
export function writeBinarySTL(mesh, name = 'relief')     // → ArrayBuffer (80 B header, facet normals)
export function parseBinarySTL(buffer)                     // → Mesh (for tests)
// mesh/threemf.js
export function write3MF(objects /* [{name, mesh}] */, { title, colorChanges /* [{zMm, color}] */ } = {}) // → Uint8Array zip
// mesh/analyze.js
export function meshStats(mesh)        // → {triangles, vertices, volumeMm3, areaMm2, bbox:{min:[x,y,z], max:[x,y,z]}}
export function checkWatertight(mesh)  // → {ok, boundaryEdges, nonManifoldEdges, inconsistentEdges}
```

### catalog/ (pure data)

```js
// catalog/printers.js
export const PRINTERS = [{ id, name, bedW, bedH, maxZ }, ...]   // incl. 'custom'
// catalog/materials.js
export const MATERIALS = { PLA: { name, densityGcm3: 1.24, pricePerKg: 20, minLayer, notes }, PETG, ABS, ASA, 'PLA-Silk', 'PLA-Matte', 'PLA-Wood', 'PLA-Marble' }
// catalog/filaments.js
export const FILAMENTS = [{ id: 'pla-snow-white', name: 'Snow White', material: 'PLA', color: '#f4f4f1', finish: 'matte' }, ...]
export function allFilaments(project)         // presets + project.filaments.custom
export function getFilament(project, id)
// finishes: 'basic' | 'matte' | 'silk' | 'metallic' | 'marble' | 'wood' | 'glitter' | 'translucent'
export const FINISHES = { matte: { roughness: 0.92, metalness: 0 }, silk: { roughness: 0.32, metalness: 0.5 }, ... }
// FINISHES is the single source of the finish looks: preview/materials.js derives FINISH_LOOK from it.
// catalog/themes.js
export const THEMES = [{ id, name, description, mode: 'bands'|'single', bands: [{ filamentId, fromFrac?, fromM? }] }]
export function applyTheme(theme, zmap)      // → [{filamentId, fromM}] (fromFrac is relative to zmap.floorM..zmap.maxElevM; fromM passes through)
// catalog/artStyles.js
export const ART_STYLES = [{ id, name, description, params: [{ key, label, type: 'range'|'number'|'select'|'checkbox',
                              min, max, step, unit, options: [[value, label]], default, showIf: {key: value} }],
                              supportsBands: true, usesBase: true }]
export function styleParams(project)          // defaults merged with project.style.params
// catalog/bands.js
export function effectiveBandSpecs(project, zmap)
   // → [{filamentId, fromM}] : 'single' mode → [{filamentId: colors.singleFilamentId, fromM: null}];
   //   'bands' + autoFit + known theme → applyTheme(theme, zmap) (fractions of floorM..maxElevM);
   //   otherwise project.colors.bands.
export function resolveBands(project, zmap, specs = effectiveBandSpecs(project, zmap))
   // → ResolvedBand[] ; colour changes snapped to layer tops:
   // z_k = firstLayerMm + k*layerHeightMm. Band i covers [zFrom, zTo); first band starts at 0, last ends at +Infinity.
   // layerFrom is the 1-based layer number at which that filament starts. 'single' mode → one band.
   // Layer 1 spans [0, firstLayerMm]; layer n≥2 spans [firstLayerMm+(n-2)·h, firstLayerMm+(n-1)·h].
   // A change at z = firstLayerMm + k·h therefore starts at layer k+2. Thresholds that collapse onto
   // the previous one are dropped; bands starting above zmap.maxZMm are kept but flagged unused:true.
```

### estimate/ (pure)

```js
// estimate/filament.js
export function estimateTile(tile /* TileField */, bands /* ResolvedBand[] */, project)
  // → { volumeMm3, solidMm3 /* after infill model */, grams, metres, minutes, maxZ,
  //     byFilament: { [filamentId]: { grams, metres, volumeMm3 } }, colorChanges: number }
export function estimateProject(tileEstimates, bands, project)
  // → { grams, metres, minutes, cost, spools, byFilament: [{ filamentId, name, color, grams, metres, cost, spools }], tiles: [...] }
```
Model: per grid cell column `[zb, zt]` – bottom skin (bottomLayers × layer) and top skin
(topLayers × layer × √(1+|∇z|²)) are solid, outer ring of `walls × 0.45 mm` is solid, the rest
uses `infillPct`. Grams = volume × density. Metres for 1.75 mm filament. Time from a
volumetric flow per speed class (slow 6, standard 11, fast 18 mm³/s) + 4 s per layer +
3 min per manual colour change. Cost from material price unless a filament has its own.

### engine/

```js
// engine/pipeline.js (pure; used by the worker and by Node tests)
export async function computeArtwork(project, { regionsIndex, dataBaseUrl, quality /* 'preview'|'export' */, fetchImpl, onProgress, signal })
  // preview: resolution chosen so nx*ny <= 600k; export: project.relief.resolutionMm
  // → { layout, zmap, stats: {minElev, maxElev, missingFraction, waterFraction, source:'local'|'live', levelLabel, pixelSizeM},
  //     sampled, field, resolutionMm, quality }
  // After the field is built, zmap.maxZMm is replaced by field.maxZMm – the highest point actually
  // printed (embossed contours, rib stagger and the thin lithophane panel included); the terrain-only
  // value stays available as zmap.terrainMaxZMm. Height warnings, preview framing, band 'unused'
  // flags and the print plan all use zmap.maxZMm.
export function buildTiles(artwork, project, { quality })      // → TileField[] (preview: withBack=false)
export function meshTile(tileField, project, { quality, toleranceMm })  // → Mesh
export function buildPreview(artwork, project)                // → { tiles: [{...TileField meta, mesh}], bands, estimate, stats, layout, zmap }
export function estimateTiles(tileFields, project, zmap)      // → { bands, estimate } (also used by the worker's 'estimate' request)
export function encodeTileFile(mesh, { format, name, title, bands, layerHeightMm }) // → ArrayBuffer (STL, or 3MF with the
  // colour changes of the non-'unused' bands; layerHeightMm = project.colors.layerHeightMm)
// engine/engine.worker.js – module worker. Messages in: {id, type:'preview'|'estimate'|'export'|'cancel', project, regionsIndex, dataBaseUrl, options}
//   'estimate' re-runs only band resolution + estimates on the last preview's tile fields (colour/print-setting changes).
//   out: {id, type:'progress', stage, fraction, message} | {id, type:'result', result} | {id, type:'error', name, message, stack}
//   dataBaseUrl must be absolute (EngineClient resolves it against document.baseURI); the worker never
//   resolves it against its own script URL. Errors are reported (and logged) by the main thread only.
//   export streams {id, type:'file', name, buffer} per tile (STL/3MF) before the final result.
// engine/engineClient.js
export class EngineClient { constructor(workerUrl); preview(project, ctx, onProgress) → Promise; exportTiles(project, ctx, opts, onFile, onProgress) → Promise; cancel(); }
```

### export/

```js
// export/zip.js       – streaming zip (fflate Zip) → Blob; downloadBlob(blob, name)
// export/printPlan.js – export function buildPrintPlanHtml({ project, layout, zmap, bands, estimate, stats, screenshotDataUrl,
//                        attribution, regionName, styleName, files, resolutionMm }) → string (standalone, printable)
```

### preview/ (DOM, three.js)

```js
export class Preview3D {
  constructor(container)
  setTiles(tiles /* [{label,row,col,x0,y0,widthMm,heightMm, mesh, water?}] */, art /* {artW, artH, maxZ} */)
  setAppearance({ mode /* 'bands'|'single'|'lithophane' */, bands /* ResolvedBand[] */, layerHeightMm, layerLines, flatShading, highlightWater })
  setView({ lighting /* 'gallery'|'morning'|'evening'|'overcast'|'raking'|'backlit' */, wallColor, wallMode, exploded, seams, labels })
  resetCamera(); async screenshot({ width, height }) /* → dataURL */; resize(); dispose()
}
```
Colours come from the band table **per fragment by tile-local z**, so the preview shows
exactly where filament changes happen.

### map/ (DOM, Leaflet)

```js
export class MapView extends EventTarget {
  constructor(container, { regionsIndex, dataBaseUrl })
  setRegion(regionId)          // overview overlay + fit bounds ('world' → world view)
  setFrame(frame, layout)      // draw frame polygon, tile grid + labels; never emits
  fitFrame()                   // a fit requested while the map is hidden is applied by the next resize()
  resize()                     // call after the map pane changed size or became visible
  setBaseLayer(id)             // 'topo' | 'osm' | 'satellite' | 'none'
  // events: 'framechange' (detail {frame, final}) from dragging/resizing/rotating,
  //         'regionselect' (detail {regionId}) when a region outline is clicked
}
// map/search.js – export async function searchPlaces(query) → [{name, lat, lon, bbox}] (Nominatim)
```

### ui/ & main

`index.html` (repo root) + `app/css/app.css` + `app/js/main.js` wire everything:
sidebar sections (Place, Printer & tiles, Relief, Art style, Colours & filament, Back side,
Estimate, Export), map + 3D preview (split / map / 3D), status bar, progress, toasts.
Changes debounce (~300 ms) into `engine.preview`. Export streams tiles into a zip.

* Start-up posts the first preview request before the WebGL set-up, so the worker meshes the
  terrain while the 3D view initialises.
* The status bar shows data source, scale, artwork size, tiles, height (tallest point · exaggeration,
  flagged when it exceeds `printer.maxZ`), filament and print time.
* Failed previews keep the last result on screen (greyed out) and show one actionable toast;
  network failures (live AWS Terrain Tiles offline / blocked) are logged as warnings, not errors.
* Narrow screens (< 900 px): the settings become a bottom sheet with tabs, and the workspace shows
  one pane at a time (Split falls back to 3D).
* `window.__relief` exposes `{store, engine, mapView, preview, runtime, lastPreview}` for tests.

`scripts/export.mjs` is the headless exporter (same pipeline, `--check` runs `checkWatertight`
on every tile): `node scripts/export.mjs project.json --format 3mf --check` or
`node scripts/export.mjs --preset alps "Mont Blanc massif" --out ./prints`.

## Testing

* `npm test` → `node --test tests/unit/` (pure modules; DEM tests read `data/fuji` via a file
  `fetchImpl`, see `tests/unit/helpers.js`). `tests/unit/pipeline.test.js` runs the whole
  pipeline (stored data → watertight STL / 3MF) for every art style.
* `npm run e2e` → Playwright (`tests/e2e/`) against `node scripts/serve.mjs` on port 4173,
  Chromium at `/opt/pw-browsers` in this environment. `flows.spec.js` covers the user flows of the
  whole app (regions, presets, live-data errors, dragging, printer/tiles, styles, colours, export,
  print plan, project files, share links, phone layout); external hosts are blocked in all tests.
