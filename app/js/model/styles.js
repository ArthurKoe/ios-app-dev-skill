// Art styles: sampled terrain → printable top surface of the whole artwork. DOM-free.
//
// Pipeline of buildArtworkField():
//   1. replace non-finite elevations by the floor, Gaussian smoothing (σ = smoothingMm / dx samples)
//   2. water 'flat' / 'recess': every connected water body is reset to the mean of its original
//      elevations, so smoothing never tilts a lake
//   3. the art style turns elevations into heights (mm); 'recess' lowers water by depthMm
//   4. optional border rim, then the final clamp to the minimum printable thickness / max height

import { elevationToZ, zTop } from './zmap.js';
import { gaussianBlur, gradientMagnitude, hillshade } from './filters.js';

/** Default parameters of every art style (docs/ARCHITECTURE.md, "Art styles"). */
const STYLE_DEFAULTS = deepFreeze({
  classic: {},
  terraced: { stepMode: 'count', count: 16, stepM: 200, snapToLayers: true },
  lowpoly: { facetMm: 1.2 },
  ridgelines: { spacingMm: 5, thicknessMm: 1.2, direction: 'horizontal', staggerMm: 0 },
  hex: { shape: 'hex', cellMm: 8, gapMm: 0.6, stepMm: 0 },
  contours: { intervalM: 200, majorEvery: 5, lineWidthMm: 0.6, depthMm: 0.4, mode: 'engrave' },
  lithophane: { minMm: 0.8, maxMm: 3.2, sunAzimuth: 315, sunAltitude: 35, contrast: 1 },
});

/** Ids of all art styles, in menu order. */
export const STYLE_IDS = Object.freeze(Object.keys(STYLE_DEFAULTS));

/** Material always kept under the top surface and above the deepest back feature, in mm. */
const MIN_SOLID_MM = 0.6;
/** Major contour lines are this much wider than minor ones. */
const MAJOR_LINE_FACTOR = 1.6;
const WATER_MODES = new Set(['none', 'flat', 'recess']);
const SQRT3 = Math.sqrt(3);

/**
 * Default parameters of an art style (a fresh copy; {} for unknown ids).
 * @param {string} styleId
 * @returns {object}
 */
export function styleDefaults(styleId) {
  return Object.hasOwn(STYLE_DEFAULTS, styleId) ? { ...STYLE_DEFAULTS[styleId] } : {};
}

/**
 * The project's style id (unknown → 'classic') and its parameters: defaults overlaid with
 * project.style.params values of the same type (numbers must be finite).
 * @param {object} project
 * @returns {{id:string, params:object}}
 */
export function resolveStyle(project) {
  const requested = project.style?.id;
  const id = Object.hasOwn(STYLE_DEFAULTS, requested) ? requested : 'classic';
  const given = project.style?.params ?? {};
  const params = { ...STYLE_DEFAULTS[id] };
  for (const [key, def] of Object.entries(params)) {
    const v = given[key];
    if (typeof v === typeof def && (typeof v !== 'number' || Number.isFinite(v))) params[key] = v;
  }
  return { id, params };
}

/**
 * Finest sample spacing the project's style needs to look right, or null when any spacing works.
 * ridgelines: thicknessMm/3 · hex: max(gapMm/2, 0.15) when gapMm > 0 · contours: lineWidthMm/2.
 * @param {object} project
 * @returns {number|null} mm
 */
export function styleResolutionHint(project) {
  const { id, params } = resolveStyle(project);
  switch (id) {
    case 'ridgelines': return params.thicknessMm > 0 ? params.thicknessMm / 3 : null;
    case 'hex': return params.gapMm > 0 ? Math.max(params.gapMm / 2, 0.15) : null;
    case 'contours': return params.lineWidthMm > 0 ? params.lineWidthMm / 2 : null;
    default: return null;
  }
}

/**
 * Thinnest top surface allowed: max(0.6, magnet pocket depth, label depth) + 0.6 mm
 * (back features only count when enabled).
 * @param {object} project
 * @returns {number} mm
 */
export function minTopThicknessMm(project) {
  const back = project.back ?? {};
  const magnetDepth = back.magnets?.enabled ? finite(back.magnets.depthMm, 0) : 0;
  const labelDepth = back.labels ? finite(back.labelDepthMm, 0) : 0;
  return Math.max(MIN_SOLID_MM, magnetDepth, labelDepth) + MIN_SOLID_MM;
}

/**
 * Builds the top surface of the whole artwork.
 *
 * Border rim (border.enabled): every sample within border.widthMm of the artwork's outer edge is
 * set to a flat rim at baseMm + border.heightMm (lithophane: maxMm + border.heightMm, an opaque
 * frame), replacing the terrain there; rim samples are never water.
 * Final clamp: z ≥ minTopThicknessMm(project) (lithophane: z ≥ minMm) and z ≤ relief.maxHeightMm
 * when that is > 0. Non-finite input elevations are treated as the floor; the result has no NaN.
 *
 * @param {{elev:Float32Array, water?:Uint8Array|null}} sampled elevations (m) at layout.nx × layout.ny
 * @param {import('../types.js').Layout} layout
 * @param {import('../types.js').ZMap & {maxHeightMm?:number}} zmap
 * @param {object} project normalised project (relief, style, border, colors, back)
 * @returns {{z:Float32Array, water:Uint8Array, maxZMm:number, meshToleranceMm?:number}} z in mm; water = 1
 *   where the printed surface is a water body (all 0 for water mode 'none' and for lithophanes);
 *   maxZMm = highest point actually produced (unlike zmap.maxZMm it includes style effects such as
 *   embossed contours, rib stagger or the thin lithophane panel)
 */
export function buildArtworkField(sampled, layout, zmap, project) {
  const { nx, ny } = layout;
  const n = nx * ny;
  if (!sampled?.elev || sampled.elev.length !== n) {
    throw new RangeError(`buildArtworkField: expected ${n} elevation samples (${nx} × ${ny}), got ${sampled?.elev?.length ?? 0}`);
  }
  const { id, params } = resolveStyle(project);
  const relief = project.relief ?? {};
  const waterMode = WATER_MODES.has(relief.water?.mode) ? relief.water.mode : 'none';
  const srcWater = sampled.water?.length === n ? sampled.water : null;
  const keepWater = waterMode !== 'none' && srcWater !== null && id !== 'lithophane';

  const raw = finiteElevations(sampled.elev, zmap.floorM);
  const sigma = relief.smoothingMm > 0 && layout.dx > 0 ? relief.smoothingMm / layout.dx : 0;
  const elev = gaussianBlur(raw, nx, ny, sigma); // always a new array
  const water = keepWater ? Uint8Array.from(srcWater) : new Uint8Array(n);
  if (keepWater) flattenWaterBodies(elev, raw, water, nx, ny);

  const ctx = {
    layout, zmap, project, params, elev, water,
    recessMm: waterMode === 'recess' ? Math.max(0, finite(relief.water?.depthMm, 0)) : 0,
  };
  const z = STYLE_BUILDERS[id](ctx);
  applyBorder(z, water, layout, project.border, rimHeightMm(id, params, zmap, project.border));
  const minZ = id === 'lithophane' ? lithophaneRange(params)[0] : minTopThicknessMm(project);
  const maxZMm = clampField(z, minZ, zmap.maxHeightMm);

  const field = { z, water, maxZMm };
  if (id === 'lowpoly') field.meshToleranceMm = positive(params.facetMm, STYLE_DEFAULTS.lowpoly.facetMm);
  return field;
}

/**
 * Cell lattice of the hex style, centred on the artwork centre.
 * 'hex': pointy-top hexagons, cellMm across the flats (= centre distance of neighbours);
 * 'square': axis-aligned squares of side cellMm.
 * `locate(x, y, out)` writes out[0] = cell index (0 … count-1) and out[1] = distance from (x, y)
 * to the cell's outline (mm, ≥ 0 inside), for artwork coordinates x → right, y ↑.
 * @param {{artW:number, artH:number}} layout
 * @param {'hex'|'square'} shape
 * @param {number} cellMm
 * @returns {{count:number, locate:(x:number, y:number, out:Float64Array)=>void}}
 */
export function createCellLattice(layout, shape, cellMm) {
  const cx0 = layout.artW / 2;
  const cy0 = layout.artH / 2;
  const half = cellMm / 2;
  if (shape === 'square') {
    const qMax = Math.ceil(cx0 / cellMm) + 1;
    const rMax = Math.ceil(cy0 / cellMm) + 1;
    const qSpan = 2 * qMax + 1;
    return {
      count: qSpan * (2 * rMax + 1),
      locate(x, y, out) {
        const px = x - cx0;
        const py = y - cy0;
        const q = Math.round(px / cellMm);
        const r = Math.round(py / cellMm);
        out[0] = (r + rMax) * qSpan + (q + qMax);
        out[1] = half - Math.max(Math.abs(px - q * cellMm), Math.abs(py - r * cellMm));
      },
    };
  }
  const rowH = (cellMm * SQRT3) / 2;
  const rMax = Math.ceil(cy0 / rowH) + 1;
  const qMax = Math.ceil(cx0 / cellMm + rMax / 2) + 1;
  const qSpan = 2 * qMax + 1;
  return {
    count: qSpan * (2 * rMax + 1),
    locate(x, y, out) {
      const px = x - cx0;
      const py = y - cy0;
      // Axial coordinates (pointy-top), then cube rounding to the nearest centre.
      const rf = py / rowH;
      const qf = px / cellMm - rf / 2;
      const sf = -qf - rf;
      let q = Math.round(qf);
      let r = Math.round(rf);
      const s = Math.round(sf);
      const dq = Math.abs(q - qf);
      const dr = Math.abs(r - rf);
      const ds = Math.abs(s - sf);
      if (dq > dr && dq > ds) q = -r - s;
      else if (dr > ds) r = -q - s;
      const ex = px - (q + r / 2) * cellMm;
      const ey = py - r * rowH;
      const a = Math.abs(ex);
      const b = Math.abs(0.5 * ex + (SQRT3 / 2) * ey);
      const c = Math.abs(-0.5 * ex + (SQRT3 / 2) * ey);
      out[0] = (r + rMax) * qSpan + (q + qMax);
      out[1] = half - (a > b ? (a > c ? a : c) : (b > c ? b : c));
    },
  };
}

// ---------------------------------------------------------------------------------------------
// Styles. Each builder receives the shared context and returns the artwork heights (mm).

/**
 * @typedef {{layout:import('../types.js').Layout, zmap:object, project:object, params:object,
 *            elev:Float32Array, water:Uint8Array, recessMm:number}} StyleContext
 */

/** @type {Record<string, (ctx:StyleContext)=>Float32Array>} */
const STYLE_BUILDERS = {
  classic: classicRelief,
  lowpoly: classicRelief, // same surface; the coarse mesh tolerance creates the facets
  terraced,
  ridgelines,
  hex: cellColumns,
  contours: contourLines,
  lithophane,
};

/**
 * Smooth shaded relief: z = zTop(elevation), water recessed.
 * @param {StyleContext} ctx
 * @returns {Float32Array}
 */
function classicRelief({ elev, zmap, water, recessMm }) {
  return recessWater(elevationToZ(elev, zmap), water, recessMm);
}

/**
 * Stepped terraces. Terrace k covers elevations [origin + k·step, origin + (k+1)·step) and is
 * printed at zTop(origin + k·step). 'count': origin = floor, step = (maxElev − floor)/count and
 * k ≤ count − 1 (exactly `count` terraces); 'meters': origin = 0 m, step = stepM, so terrace
 * edges follow real contour lines. snapToLayers moves every terrace top to the nearest layer top
 * firstLayerMm + j·layerHeightMm. Water is recessed after quantisation so lakes stay visible.
 * @param {StyleContext} ctx
 * @returns {Float32Array}
 */
function terraced({ elev, zmap, params, project, water, recessMm }) {
  let origin = 0;
  let step = positive(params.stepM, STYLE_DEFAULTS.terraced.stepM);
  let maxK = Infinity;
  if (params.stepMode !== 'meters') {
    const count = Math.max(1, Math.round(positive(params.count, STYLE_DEFAULTS.terraced.count)));
    const range = zmap.maxElevM - zmap.floorM;
    origin = zmap.floorM;
    step = range > 0 ? range / count : 1;
    maxK = range > 0 ? count - 1 : 0;
  }
  const first = positive(project.colors?.firstLayerMm, 0.2);
  const layer = positive(project.colors?.layerHeightMm, 0.2);
  const snap = params.snapToLayers !== false;
  const z = new Float32Array(elev.length);
  for (let i = 0; i < elev.length; i++) {
    let k = Math.floor((elev[i] - origin) / step);
    if (k > maxK) k = maxK;
    const top = zTop(zmap, origin + k * step);
    z[i] = snap ? first + Math.round((top - first) / layer) * layer : top;
  }
  return recessWater(z, water, recessMm);
}

/**
 * Parallel ribs ("Unknown Pleasures"). Rib k is centred spacingMm/2 + k·spacingMm from the top
 * edge ('horizontal', ribs run along x) or from the left edge ('vertical', ribs run along y), over
 * the whole artwork so ribs continue across tile seams. A rib is thicknessMm wide (at least one
 * sample line) and its height is the terrain profile along its centre line plus k·staggerMm;
 * everything between ribs is the flat base.
 * @param {StyleContext} ctx
 * @returns {Float32Array}
 */
function ridgelines({ elev, zmap, layout, params, water, recessMm }) {
  const terrain = recessWater(elevationToZ(elev, zmap), water, recessMm);
  const { nx, ny } = layout;
  const vertical = params.direction === 'vertical';
  const step = vertical ? layout.dx : layout.dy;
  const lines = vertical ? nx : ny; // sample lines across the ribs
  const spacing = positive(params.spacingMm, STYLE_DEFAULTS.ridgelines.spacingMm);
  const half = Math.max(positive(params.thicknessMm, STYLE_DEFAULTS.ridgelines.thicknessMm) / 2, 0.5 * step * (1 + 1e-6));
  const stagger = finite(params.staggerMm, 0);
  const extent = (lines - 1) * step;
  const z = new Float32Array(nx * ny).fill(zmap.baseMm);

  for (let j = 0; j < lines; j++) {
    const d = j * step;
    const k = Math.max(0, Math.round((d - spacing / 2) / spacing));
    const centre = spacing / 2 + k * spacing;
    const onRib = Math.abs(d - centre) <= half && centre <= extent + 1e-9;
    const pos = Math.min(centre / step, lines - 1);
    const j0 = Math.floor(pos);
    const j1 = Math.min(j0 + 1, lines - 1);
    const t = pos - j0;
    const lift = k * stagger;
    if (vertical) {
      for (let r = 0, i = j; r < ny; r++, i += nx) {
        if (onRib) z[i] = terrain[r * nx + j0] * (1 - t) + terrain[r * nx + j1] * t + lift;
        else water[i] = 0;
      }
    } else {
      const o = j * nx;
      const o0 = j0 * nx;
      const o1 = j1 * nx;
      for (let c = 0; c < nx; c++) {
        if (onRib) z[o + c] = terrain[o0 + c] * (1 - t) + terrain[o1 + c] * t + lift;
        else water[o + c] = 0;
      }
    }
  }
  return z;
}

/**
 * Hexagonal (or square) columns. Each cell of the artwork-wide lattice is printed at the mean
 * terrain height of the samples inside it (optionally quantised to base + j·stepMm). Samples within
 * gapMm/2 of a cell outline (at least half a sample, so gaps stay continuous) drop to the base.
 * @param {StyleContext} ctx
 * @returns {Float32Array}
 */
function cellColumns({ elev, zmap, layout, params, water, recessMm }) {
  const terrain = recessWater(elevationToZ(elev, zmap), water, recessMm);
  const { nx, ny, dx, dy, artH } = layout;
  const lattice = createCellLattice(layout, params.shape, positive(params.cellMm, STYLE_DEFAULTS.hex.cellMm));
  const sum = new Float64Array(lattice.count);
  const count = new Uint32Array(lattice.count);
  const hit = new Float64Array(2);
  for (let r = 0, i = 0; r < ny; r++) {
    const y = artH - r * dy;
    for (let c = 0; c < nx; c++, i++) {
      lattice.locate(c * dx, y, hit);
      sum[hit[0]] += terrain[i];
      count[hit[0]]++;
    }
  }

  const gap = Math.max(0, finite(params.gapMm, 0));
  const halfGap = gap > 0 ? Math.max(gap / 2, 0.5 * Math.max(dx, dy)) : -Infinity;
  const quantum = Math.max(0, finite(params.stepMm, 0));
  const base = zmap.baseMm;
  const z = terrain; // overwritten in place: every sample's cell mean is already accumulated
  for (let r = 0, i = 0; r < ny; r++) {
    const y = artH - r * dy;
    for (let c = 0; c < nx; c++, i++) {
      lattice.locate(c * dx, y, hit);
      if (hit[1] < halfGap) {
        z[i] = base;
        water[i] = 0;
        continue;
      }
      const mean = sum[hit[0]] / count[hit[0]];
      z[i] = quantum > 0 ? base + Math.round((mean - base) / quantum) * quantum : mean;
    }
  }
  return z;
}

/**
 * Classic relief with contour lines every intervalM metres (absolute elevations). A sample is on
 * a line when |e − nearest level| / |∇e| (its distance to the contour in print mm) is below half
 * the line width (major lines, every majorEvery-th level, are 1.6× wider; lines are at least one
 * sample wide so they stay continuous on coarse grids). Lines are lowered ('engrave') or raised
 * ('emboss') by depthMm. Water surfaces get no lines.
 * @param {StyleContext} ctx
 * @returns {Float32Array}
 */
function contourLines({ elev, zmap, layout, params, water, recessMm }) {
  const z = recessWater(elevationToZ(elev, zmap), water, recessMm);
  const { nx, ny, dx, dy } = layout;
  const interval = positive(params.intervalM, STYLE_DEFAULTS.contours.intervalM);
  const majorEvery = Math.max(0, Math.round(finite(params.majorEvery, 0)));
  const width = positive(params.lineWidthMm, STYLE_DEFAULTS.contours.lineWidthMm);
  const minHalf = 0.5 * Math.max(dx, dy);
  const halfMinor = Math.max(width / 2, minHalf);
  const halfMajor = Math.max((MAJOR_LINE_FACTOR * width) / 2, minHalf);
  const offset = (params.mode === 'emboss' ? 1 : -1) * Math.max(0, finite(params.depthMm, 0));
  const grad = gradientMagnitude(elev, nx, ny, dx, dy); // metres per printed mm
  for (let i = 0; i < z.length; i++) {
    const g = grad[i];
    if (water[i] || !(g > 1e-6)) continue;
    const k = Math.round(elev[i] / interval);
    const half = majorEvery > 0 && k % majorEvery === 0 ? halfMajor : halfMinor;
    if (Math.abs(elev[i] - k * interval) / g < half) z[i] += offset;
  }
  return z;
}

/**
 * Backlit lithophane: thickness = maxMm − (maxMm − minMm)·shade^contrast, where shade is the
 * hillshade (sunAzimuth/sunAltitude) of the exaggerated relief surface. Bright = thin. Base and
 * water settings do not apply.
 * @param {StyleContext} ctx
 * @returns {Float32Array}
 */
function lithophane({ elev, zmap, layout, params }) {
  const { nx, ny, dx, dy } = layout;
  const surface = elevationToZ(elev, zmap);
  const shade = hillshade(surface, nx, ny, dx, dy, finite(params.sunAzimuth, 315), finite(params.sunAltitude, 35));
  const [lo, hi] = lithophaneRange(params);
  const gamma = positive(params.contrast, 1);
  const span = hi - lo;
  for (let i = 0; i < shade.length; i++) {
    const s = gamma === 1 ? shade[i] : Math.pow(shade[i], gamma);
    shade[i] = hi - span * s;
  }
  return shade;
}

// ---------------------------------------------------------------------------------------------
// Helpers

/**
 * [minMm, maxMm] of a lithophane, ordered.
 * @param {object} params
 * @returns {[number, number]}
 */
function lithophaneRange(params) {
  const a = positive(params.minMm, STYLE_DEFAULTS.lithophane.minMm);
  const b = positive(params.maxMm, STYLE_DEFAULTS.lithophane.maxMm);
  return a <= b ? [a, b] : [b, a];
}

/**
 * Height of the flat border rim.
 * @param {string} id style id
 * @param {object} params style params
 * @param {{baseMm:number}} zmap
 * @param {{heightMm?:number}|undefined} border
 * @returns {number} mm
 */
function rimHeightMm(id, params, zmap, border) {
  const above = Math.max(0, finite(border?.heightMm, 0));
  return (id === 'lithophane' ? lithophaneRange(params)[1] : zmap.baseMm) + above;
}

/**
 * Returns `elev` itself when all values are finite, otherwise a copy with non-finite values
 * replaced by `fill`.
 * @param {Float32Array} elev
 * @param {number} fill
 * @returns {Float32Array}
 */
function finiteElevations(elev, fill) {
  for (let i = 0; i < elev.length; i++) {
    if (!Number.isFinite(elev[i])) {
      const out = Float32Array.from(elev);
      for (let j = i; j < out.length; j++) if (!Number.isFinite(out[j])) out[j] = fill;
      return out;
    }
  }
  return elev;
}

/**
 * Sets every 4-connected water body to the mean of its original elevations (lakes stay flat after
 * smoothing; the shore keeps its smoothed values).
 * @param {Float32Array} elev smoothed elevations, modified in place
 * @param {Float32Array} raw elevations before smoothing
 * @param {Uint8Array} water mask
 * @param {number} nx
 * @param {number} ny
 */
function flattenWaterBodies(elev, raw, water, nx, ny) {
  const n = nx * ny;
  let total = 0;
  for (let i = 0; i < n; i++) if (water[i]) total++;
  if (total === 0) return;
  const seen = new Uint8Array(n);
  const queue = new Int32Array(total); // breadth-first queue, doubles as the member list
  for (let seed = 0; seed < n; seed++) {
    if (!water[seed] || seen[seed]) continue;
    let head = 0;
    let tail = 0;
    let sum = 0;
    seen[seed] = 1;
    queue[tail++] = seed;
    while (head < tail) {
      const i = queue[head++];
      sum += raw[i];
      const c = i % nx;
      if (c > 0 && water[i - 1] && !seen[i - 1]) { seen[i - 1] = 1; queue[tail++] = i - 1; }
      if (c < nx - 1 && water[i + 1] && !seen[i + 1]) { seen[i + 1] = 1; queue[tail++] = i + 1; }
      if (i >= nx && water[i - nx] && !seen[i - nx]) { seen[i - nx] = 1; queue[tail++] = i - nx; }
      if (i + nx < n && water[i + nx] && !seen[i + nx]) { seen[i + nx] = 1; queue[tail++] = i + nx; }
    }
    const level = sum / tail;
    for (let k = 0; k < tail; k++) elev[queue[k]] = level;
  }
}

/**
 * Lowers water samples by depthMm (no-op for 0).
 * @param {Float32Array} z modified in place
 * @param {Uint8Array} water
 * @param {number} depthMm
 * @returns {Float32Array} z
 */
function recessWater(z, water, depthMm) {
  if (depthMm > 0) for (let i = 0; i < z.length; i++) if (water[i]) z[i] -= depthMm;
  return z;
}

/**
 * Flat rim: samples within border.widthMm of the artwork edge get `rimZ` and are not water.
 * @param {Float32Array} z
 * @param {Uint8Array} water
 * @param {import('../types.js').Layout} layout
 * @param {{enabled?:boolean, widthMm?:number}|undefined} border
 * @param {number} rimZ
 */
function applyBorder(z, water, layout, border, rimZ) {
  const width = finite(border?.widthMm, 0);
  if (!border?.enabled || !(width > 0)) return;
  const { nx, ny, dx, dy, artW, artH } = layout;
  const w = width + 1e-9;
  for (let r = 0; r < ny; r++) {
    const yTop = r * dy;
    const wholeRow = yTop <= w || artH - yTop <= w;
    for (let c = 0, i = r * nx; c < nx; c++, i++) {
      const x = c * dx;
      if (wholeRow || x <= w || artW - x <= w) {
        z[i] = rimZ;
        water[i] = 0;
      }
    }
  }
}

/**
 * Clamps to [lo, max(cap, lo)] (no upper bound for cap ≤ 0); NaN becomes lo.
 * @param {Float32Array} z modified in place
 * @param {number} lo
 * @param {number|undefined} cap
 * @returns {number} the largest value after clamping
 */
function clampField(z, lo, cap) {
  const hi = cap > 0 ? Math.max(cap, lo) : Infinity;
  let max = lo;
  for (let i = 0; i < z.length; i++) {
    let v = z[i];
    if (!(v >= lo)) v = lo;
    else if (v > hi) v = hi;
    z[i] = v;
    if (v > max) max = v;
  }
  return Math.fround(max);
}

function finite(v, fallback) {
  return typeof v === 'number' && Number.isFinite(v) ? v : fallback;
}

function positive(v, fallback) {
  return typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : fallback;
}

function deepFreeze(obj) {
  for (const v of Object.values(obj)) if (v && typeof v === 'object') deepFreeze(v);
  return Object.freeze(obj);
}
