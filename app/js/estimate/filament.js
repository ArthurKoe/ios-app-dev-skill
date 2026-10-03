// Filament, print-time and cost estimates for relief tiles.
//
// Model (per grid sample column [zb, zt], areas by the trapezoidal rule so a bilinear surface
// is integrated exactly):
//   - bottom skin: firstLayer + (bottomLayers-1)·layer above zb is solid,
//   - top skin: topLayers·layer·√(1+|∇z|²) below zt is solid (steeper ⇒ more perimeters),
//   - an outer ring of walls × line width (0.45 mm for a 0.4 mm nozzle) is solid,
//   - everything in between is filled with infillPct.
// Band (filament) volumes come from the overlap of each column with the band's z range.
// Pockets from the bottom grid (magnets, engraved labels) raise zb locally; the correction is
// evaluated on the bottom grid's own resolution.

import { getFilament } from '../catalog/filaments.js';
import { MATERIALS, getMaterial } from '../catalog/materials.js';
import { layerSettings } from '../catalog/bands.js';

/** @typedef {import('../types.js').TileField} TileField */
/** @typedef {import('../types.js').ResolvedBand} ResolvedBand */
/** @typedef {import('../types.js').Grid} Grid */

/** Sustained volumetric flow per speed class, mm³/s. */
export const SPEED_CLASSES = Object.freeze({
  slow: Object.freeze({ label: 'Slow (quality)', flowMm3s: 6 }),
  standard: Object.freeze({ label: 'Standard', flowMm3s: 11 }),
  fast: Object.freeze({ label: 'Fast', flowMm3s: 18 }),
});
export const FILAMENT_DIAMETER_MM = 1.75;
export const SPOOL_GRAMS = 1000;
export const SECONDS_PER_LAYER = 4;
export const MINUTES_PER_COLOR_CHANGE = 3;
/** Extrusion width relative to the nozzle diameter (0.45 mm for a 0.4 mm nozzle). */
const LINE_WIDTH_FACTOR = 0.45 / 0.4;
const FILAMENT_AREA_MM2 = Math.PI * (FILAMENT_DIAMETER_MM / 2) ** 2;

/**
 * @param {unknown} v
 * @param {number} fallback
 * @returns {number} v if finite and ≥ 0, else fallback
 */
function nonNegative(v, fallback) {
  return typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : fallback;
}

/**
 * Slicer settings relevant to the estimate, with defaults for missing values.
 * @param {object} project
 * @returns {{infill:number, bottomSkinMm:number, topSkinMm:number, wallMm:number, flowMm3s:number,
 *   layerHeightMm:number, firstLayerMm:number}}
 */
export function printModel(project) {
  const print = project?.print ?? {};
  const { layerHeightMm, firstLayerMm } = layerSettings(project);
  const bottomLayers = Math.round(nonNegative(print.bottomLayers, 4));
  const nozzle = nonNegative(project?.printer?.nozzleMm, 0) || 0.4;
  return {
    infill: Math.min(1, nonNegative(print.infillPct, 15) / 100),
    bottomSkinMm: bottomLayers > 0 ? firstLayerMm + (bottomLayers - 1) * layerHeightMm : 0,
    topSkinMm: Math.round(nonNegative(print.topLayers, 5)) * layerHeightMm,
    wallMm: Math.round(nonNegative(print.walls, 3)) * nozzle * LINE_WIDTH_FACTOR,
    flowMm3s: (SPEED_CLASSES[print.speedClass] ?? SPEED_CLASSES.standard).flowMm3s,
    layerHeightMm,
    firstLayerMm,
  };
}

/**
 * Trapezoidal-rule widths of the n samples spanning [0, length]: the length of each sample's
 * cell [x - d/2, x + d/2] ∩ [0, length].
 * @param {number} n
 * @param {number} length
 * @returns {Float64Array}
 */
function cellWidths(n, length) {
  const d = length / (n - 1);
  const w = new Float64Array(n).fill(d);
  w[0] = w[n - 1] = d / 2;
  return w;
}

/**
 * Fraction of each sample's cell lying within `ringMm` of either end of [0, length]. Summed with
 * the cell widths this reproduces the ring length 2·ringMm exactly.
 * @param {number} n
 * @param {number} length
 * @param {number} ringMm
 * @returns {Float64Array}
 */
function edgeFractions(n, length, ringMm) {
  const d = length / (n - 1);
  const wz = Math.min(ringMm, length / 2);
  const out = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    const a = Math.max(0, i * d - d / 2);
    const b = Math.min(length, i * d + d / 2);
    const inZone = Math.max(0, Math.min(b, wz) - a) + Math.max(0, b - Math.max(a, length - wz));
    out[i] = b > a ? Math.min(1, inZone / (b - a)) : 0;
  }
  return out;
}

/**
 * Band boundaries as typed arrays: band b covers [from[b], to[b]); the first starts at 0, the
 * last ends at +Infinity. Bands must be ascending (as produced by resolveBands).
 * @param {ResolvedBand[]} bands
 * @param {object} project
 * @returns {{ids:string[], from:Float64Array, to:Float64Array}}
 */
function bandTable(bands, project) {
  const list = Array.isArray(bands) && bands.length > 0
    ? bands
    : [{ filamentId: project?.colors?.singleFilamentId ?? 'pla-snow-white', zFrom: 0 }];
  const n = list.length;
  const from = new Float64Array(n);
  const to = new Float64Array(n);
  for (let b = 0; b < n; b++) from[b] = b === 0 ? 0 : (Number.isFinite(list[b].zFrom) ? list[b].zFrom : Infinity);
  for (let b = 0; b < n; b++) to[b] = b + 1 < n ? from[b + 1] : Infinity;
  return { ids: list.map((b) => b.filamentId), from, to };
}

/**
 * Adds one material column [zb, zt) to the per-band accumulators.
 * `vol[b]` receives w × overlap with the band; `inf[b]` receives wInf × overlap of the band
 * with the infill zone [zb + bottomSkin, zt - topSkin] (solid = vol - (1 - infill) · inf).
 * @param {Float64Array} vol
 * @param {Float64Array} inf
 * @param {Float64Array} from
 * @param {Float64Array} to
 * @param {number} zb column bottom
 * @param {number} zt column top
 * @param {number} lo bottom of the infill zone
 * @param {number} hi top of the infill zone
 * @param {number} w column area (signed)
 * @param {number} wInf column area outside the solid wall ring (signed)
 */
function addColumn(vol, inf, from, to, zb, zt, lo, hi, w, wInf) {
  const nb = from.length;
  for (let b = 0; b < nb; b++) {
    const a0 = from[b];
    if (a0 >= zt) break;
    const e = to[b] < zt ? to[b] : zt;
    const a = a0 > zb ? a0 : zb;
    if (e <= a) continue;
    vol[b] += w * (e - a);
    if (hi > lo) {
      const ia = a > lo ? a : lo;
      const ie = e < hi ? e : hi;
      if (ie > ia) inf[b] += wInf * (ie - ia);
    }
  }
}

/**
 * Bilinear sample of a grid at fractional (column, row) coordinates.
 * @param {Float32Array} z
 * @param {number} nx
 * @param {number} ny
 * @param {number} gc
 * @param {number} gr
 * @returns {number}
 */
function bilinear(z, nx, ny, gc, gr) {
  const c0 = Math.min(nx - 2, Math.max(0, Math.floor(gc)));
  const r0 = Math.min(ny - 2, Math.max(0, Math.floor(gr)));
  const tx = gc - c0;
  const ty = gr - r0;
  const i = r0 * nx + c0;
  const top = z[i] + (z[i + 1] - z[i]) * tx;
  const bot = z[i + nx] + (z[i + nx + 1] - z[i + nx]) * tx;
  return top + (bot - top) * ty;
}

/**
 * √(1+|∇z|²) at sample (r, c) of the top grid (central differences, one-sided at edges).
 * @param {Float32Array} z
 * @param {number} nx
 * @param {number} ny
 * @param {number} r
 * @param {number} c
 * @param {number} dx
 * @param {number} dy
 * @returns {number}
 */
function slopeFactorAt(z, nx, ny, r, c, dx, dy) {
  const cl = c > 0 ? c - 1 : c;
  const cr = c < nx - 1 ? c + 1 : c;
  const ru = r > 0 ? r - 1 : r;
  const rd = r < ny - 1 ? r + 1 : r;
  const gx = (z[r * nx + cr] - z[r * nx + cl]) / ((cr - cl) * dx);
  const gy = (z[ru * nx + c] - z[rd * nx + c]) / ((rd - ru) * dy);
  return Math.sqrt(1 + gx * gx + gy * gy);
}

/**
 * Integrates the top grid into per-band geometric (`vol`) and infill-zone (`inf`) volumes.
 * @param {Grid} top
 * @param {number} widthMm
 * @param {number} heightMm
 * @param {ReturnType<typeof printModel>} m
 * @param {Float64Array} vol
 * @param {Float64Array} inf
 * @param {Float64Array} from
 * @param {Float64Array} to
 * @returns {number} highest top sample (mm)
 */
function integrateTop(top, widthMm, heightMm, m, vol, inf, from, to) {
  const { nx, ny, z } = top;
  const dx = widthMm / (nx - 1);
  const dy = heightMm / (ny - 1);
  const wx = cellWidths(nx, widthMm);
  const wy = cellWidths(ny, heightMm);
  const fx = edgeFractions(nx, widthMm, m.wallMm);
  const fy = edgeFractions(ny, heightMm, m.wallMm);
  const invSpanX = new Float64Array(nx);
  for (let c = 0; c < nx; c++) invSpanX[c] = 1 / (((c < nx - 1 ? c + 1 : c) - (c > 0 ? c - 1 : c)) * dx);
  const sb = m.bottomSkinMm;
  const st0 = m.topSkinMm;
  let maxZ = 0;
  for (let r = 0; r < ny; r++) {
    const rUp = r > 0 ? r - 1 : r;
    const rDown = r < ny - 1 ? r + 1 : r;
    const invY = 1 / ((rDown - rUp) * dy);
    const ru = rUp * nx;
    const rd = rDown * nx;
    const row = r * nx;
    const wr = wy[r];
    const keepY = 1 - fy[r];
    for (let c = 0; c < nx; c++) {
      const i = row + c;
      const t = z[i];
      if (!(t > 0)) continue;
      if (t > maxZ) maxZ = t;
      const gx = (z[c < nx - 1 ? i + 1 : i] - z[c > 0 ? i - 1 : i]) * invSpanX[c];
      const gy = (z[ru + c] - z[rd + c]) * invY;
      const w = wr * wx[c];
      addColumn(vol, inf, from, to, 0, t, sb, t - st0 * Math.sqrt(1 + gx * gx + gy * gy), w, w * keepY * (1 - fx[c]));
    }
  }
  return maxZ;
}

/**
 * Applies the bottom-grid pockets: every pocket sample replaces the column [0, t) by [p, t),
 * which moves the bottom skin up and removes material from the lowest bands.
 * @param {Grid} bottom underside heights (0 = flat, > 0 = pocket depth), same rectangle as top
 * @param {Grid} top
 * @param {number} widthMm
 * @param {number} heightMm
 * @param {ReturnType<typeof printModel>} m
 * @param {Float64Array} vol
 * @param {Float64Array} inf
 * @param {Float64Array} from
 * @param {Float64Array} to
 * @returns {number} removed geometric volume, mm³
 */
function subtractPockets(bottom, top, widthMm, heightMm, m, vol, inf, from, to) {
  const { nx: bx, ny: by, z: bz } = bottom;
  const { nx, ny, z } = top;
  const wbx = cellWidths(bx, widthMm);
  const wby = cellWidths(by, heightMm);
  const fbx = edgeFractions(bx, widthMm, m.wallMm);
  const fby = edgeFractions(by, heightMm, m.wallMm);
  const sx = (nx - 1) / (bx - 1);
  const sy = (ny - 1) / (by - 1);
  const dx = widthMm / (nx - 1);
  const dy = heightMm / (ny - 1);
  const sb = m.bottomSkinMm;
  let removed = 0;
  for (let r = 0; r < by; r++) {
    for (let c = 0; c < bx; c++) {
      const p = bz[r * bx + c];
      if (!(p > 0)) continue;
      const gc = c * sx;
      const gr = r * sy;
      const t = bilinear(z, nx, ny, gc, gr);
      if (!(t > 0)) continue;
      const depth = Math.min(p, t);
      const st = m.topSkinMm * slopeFactorAt(z, nx, ny, Math.round(gr), Math.round(gc), dx, dy);
      const w = wby[r] * wbx[c];
      const wInf = w * (1 - fby[r]) * (1 - fbx[c]);
      addColumn(vol, inf, from, to, 0, t, sb, t - st, -w, -wInf);
      addColumn(vol, inf, from, to, depth, t, depth + sb, t - st, w, wInf);
      removed += w * depth;
    }
  }
  return removed;
}

/**
 * Material density (g/cm³) and price (per kg) of a filament: the filament's own material when
 * known, else the project's print material; a filament's own `pricePerKg` wins.
 * @param {object} project
 * @param {string} filamentId
 */
function filamentEconomics(project, filamentId) {
  const f = getFilament(project, filamentId);
  const mat = MATERIALS[f.material] ?? getMaterial(project?.print?.material);
  return { filament: f, material: mat, densityGcm3: mat.densityGcm3, pricePerKg: f.pricePerKg ?? mat.pricePerKg };
}

/**
 * Estimates material and time for one tile.
 * Uses the tile's own grid spacing (widthMm/(nx-1), heightMm/(ny-1)); `bands` must be ascending
 * (resolveBands output). An empty band list prints everything in `colors.singleFilamentId`.
 * @param {TileField} tile
 * @param {ResolvedBand[]} bands
 * @param {object} project
 * @returns {{
 *   label:string, volumeMm3:number, solidMm3:number, grams:number, metres:number, minutes:number,
 *   maxZ:number, layers:number, colorChanges:number, pocketMm3:number,
 *   byFilament:Record<string, {grams:number, metres:number, volumeMm3:number}>,
 *   byBand:Array<{filamentId:string, volumeMm3:number, solidMm3:number}>
 * }} `volumeMm3` is the geometric volume; `solidMm3` and byFilament[*].volumeMm3 are the
 *   extruded material after the infill model.
 */
export function estimateTile(tile, bands, project) {
  const m = printModel(project);
  const { ids, from, to } = bandTable(bands, project);
  const nb = ids.length;
  const vol = new Float64Array(nb);
  const inf = new Float64Array(nb);
  const top = tile.top;
  let maxZ = 0;
  let pocketMm3 = 0;
  if (top && top.nx >= 2 && top.ny >= 2) {
    maxZ = integrateTop(top, tile.widthMm, tile.heightMm, m, vol, inf, from, to);
    const bottom = tile.bottom;
    if (bottom && bottom.nx >= 2 && bottom.ny >= 2) {
      pocketMm3 = subtractPockets(bottom, top, tile.widthMm, tile.heightMm, m, vol, inf, from, to);
    }
  }

  const byFilament = {};
  const byBand = [];
  let volumeMm3 = 0;
  let solidMm3 = 0;
  let grams = 0;
  for (let b = 0; b < nb; b++) {
    const geo = Math.max(0, vol[b]);
    const solid = Math.max(0, vol[b] - (1 - m.infill) * inf[b]);
    const g = solid / 1000 * filamentEconomics(project, ids[b]).densityGcm3;
    volumeMm3 += geo;
    solidMm3 += solid;
    grams += g;
    byBand.push({ filamentId: ids[b], volumeMm3: geo, solidMm3: solid });
    const acc = byFilament[ids[b]] ??= { grams: 0, metres: 0, volumeMm3: 0 };
    acc.grams += g;
    acc.volumeMm3 += solid;
    acc.metres += solid / FILAMENT_AREA_MM2 / 1000;
  }

  let colorChanges = 0;
  for (let b = 1; b < nb; b++) if (from[b] < maxZ - 1e-9) colorChanges++;
  const layers = maxZ <= m.firstLayerMm ? 1 : 1 + Math.ceil((maxZ - m.firstLayerMm) / m.layerHeightMm - 1e-9);
  const minutes = solidMm3 / m.flowMm3s / 60 + layers * SECONDS_PER_LAYER / 60 + colorChanges * MINUTES_PER_COLOR_CHANGE;

  return {
    label: tile.label,
    volumeMm3,
    solidMm3,
    grams,
    metres: solidMm3 / FILAMENT_AREA_MM2 / 1000,
    minutes,
    maxZ,
    layers,
    colorChanges,
    pocketMm3,
    byFilament,
    byBand,
  };
}

/**
 * Totals for a whole project from its tile estimates.
 * Filaments are listed in band order (then any others that appear in the tiles); cost uses the
 * filament's own price or its material's price; spools are 1 kg spools rounded up per filament.
 * `notOwned` lists used filaments missing from `project.filaments.owned` (empty when the user
 * has not recorded any owned filaments).
 * @param {ReturnType<typeof estimateTile>[]} tileEstimates
 * @param {ResolvedBand[]} bands
 * @param {object} project
 * @returns {{
 *   grams:number, metres:number, minutes:number, cost:number, spools:number,
 *   colorChanges:number, longestTileMinutes:number, notOwned:string[],
 *   byFilament:Array<{filamentId:string, name:string, color:string, finish:string, material:string,
 *     grams:number, metres:number, cost:number, spools:number}>,
 *   tiles:ReturnType<typeof estimateTile>[]
 * }}
 */
export function estimateProject(tileEstimates, bands, project) {
  const tiles = Array.isArray(tileEstimates) ? tileEstimates.slice() : [];
  /** @type {Map<string, {grams:number, metres:number}>} */
  const agg = new Map();
  for (const b of bands ?? []) if (!agg.has(b.filamentId)) agg.set(b.filamentId, { grams: 0, metres: 0 });

  let minutes = 0;
  let colorChanges = 0;
  let longestTileMinutes = 0;
  for (const t of tiles) {
    minutes += t.minutes;
    colorChanges += t.colorChanges;
    longestTileMinutes = Math.max(longestTileMinutes, t.minutes);
    for (const [id, v] of Object.entries(t.byFilament ?? {})) {
      const acc = agg.get(id) ?? { grams: 0, metres: 0 };
      acc.grams += v.grams;
      acc.metres += v.metres;
      agg.set(id, acc);
    }
  }

  const byFilament = [];
  let grams = 0;
  let metres = 0;
  let cost = 0;
  let spools = 0;
  for (const [filamentId, v] of agg) {
    if (!(v.grams > 0)) continue;
    const { filament, material, pricePerKg } = filamentEconomics(project, filamentId);
    const entry = {
      filamentId,
      name: filament.name,
      color: filament.color,
      finish: filament.finish,
      material: material.id,
      grams: v.grams,
      metres: v.metres,
      cost: v.grams / 1000 * pricePerKg,
      spools: Math.ceil(v.grams / SPOOL_GRAMS - 1e-9),
    };
    byFilament.push(entry);
    grams += entry.grams;
    metres += entry.metres;
    cost += entry.cost;
    spools += entry.spools;
  }

  const owned = project?.filaments?.owned;
  const notOwned = Array.isArray(owned) && owned.length > 0
    ? byFilament.map((f) => f.filamentId).filter((id) => !owned.includes(id))
    : [];

  return { grams, metres, minutes, cost, spools, colorChanges, longestTileMinutes, notOwned, byFilament, tiles };
}
