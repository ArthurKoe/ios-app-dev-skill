// Colour bands: which filament prints which height range, snapped to layer boundaries.

import { getFilament } from './filaments.js';
import { applyTheme, getTheme } from './themes.js';
import { getArtStyle } from './artStyles.js';

/** @typedef {import('../types.js').ZMap} ZMap */
/** @typedef {import('../types.js').ResolvedBand} ResolvedBand */
/** @typedef {{filamentId:string, fromM:number|null}} BandSpec */

const DEFAULT_SINGLE_FILAMENT = 'pla-snow-white';
const DEFAULT_LAYER_MM = 0.2;

/**
 * @param {unknown} v
 * @param {number} fallback
 * @returns {number} v when it is a finite positive number, else fallback
 */
function positiveOr(v, fallback) {
  return typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : fallback;
}

/** @param {number} v @returns {number} v rounded to 1e-6 (removes float noise from k·h sums) */
function round6(v) {
  return Math.round(v * 1e6) / 1e6;
}

/**
 * Layer geometry of a project: layer 1 spans [0, first], layer n ≥ 2 spans
 * [first + (n-2)·h, first + (n-1)·h].
 * @param {object} project
 * @returns {{layerHeightMm:number, firstLayerMm:number}}
 */
export function layerSettings(project) {
  const layerHeightMm = positiveOr(project?.colors?.layerHeightMm, DEFAULT_LAYER_MM);
  return { layerHeightMm, firstLayerMm: positiveOr(project?.colors?.firstLayerMm, layerHeightMm) };
}

/**
 * The band specification in effect for a project:
 * - 'single' mode, or an art style without band support (lithophane) →
 *   `[{filamentId: colors.singleFilamentId, fromM: null}]`;
 * - 'bands' + autoFit + a known theme + a zmap → `applyTheme(theme, zmap)`;
 * - otherwise `project.colors.bands` (first band's `fromM` forced to null; an empty list
 *   falls back to the single filament).
 * @param {object} project
 * @param {ZMap|null} [zmap]
 * @returns {BandSpec[]}
 */
export function effectiveBandSpecs(project, zmap) {
  const colors = project?.colors ?? {};
  const single = [{ filamentId: colors.singleFilamentId ?? DEFAULT_SINGLE_FILAMENT, fromM: null }];
  if (colors.mode === 'single' || !getArtStyle(project?.style?.id).supportsBands) return single;

  const theme = colors.autoFit ? getTheme(colors.themeId) : null;
  if (theme && zmap) {
    const specs = applyTheme(theme, zmap);
    if (specs.length > 0) return specs;
  }
  const bands = Array.isArray(colors.bands) ? colors.bands.filter((b) => b && b.filamentId) : [];
  if (bands.length === 0) return single;
  return bands.map((b, i) => {
    const fromM = b.fromM === null || b.fromM === undefined || b.fromM === '' ? NaN : Number(b.fromM);
    return { filamentId: b.filamentId, fromM: i > 0 && Number.isFinite(fromM) ? fromM : null };
  });
}

/**
 * Converts an elevation to the printed top height (mm) following the ZMap formula and the
 * optional `relief.maxHeightMm` clamp.
 * @param {ZMap} zmap
 * @param {number} elevM
 * @param {number} maxHeightMm 0 = no clamp
 * @returns {number}
 */
export function elevationToZ(zmap, elevM, maxHeightMm = 0) {
  const z = zmap.baseMm + Math.max(0, elevM - zmap.floorM) * zmap.mmPerM;
  return maxHeightMm > 0 ? Math.min(z, maxHeightMm) : z;
}

/**
 * Resolves band specs into printable bands with filament changes on layer boundaries.
 *
 * - The first band starts at z = 0 (layer 1); the last one ends at +Infinity.
 * - A threshold at elevation e maps to z = elevationToZ(e) and snaps to the nearest layer top
 *   z_k = firstLayerMm + k·layerHeightMm (k ≥ 0); that filament starts at layer k + 2.
 * - Bands that become empty because a later threshold snaps to the same or a lower layer are
 *   dropped (the later band wins); specs other than the first without a finite `fromM` are ignored.
 * - Consecutive bands with the same filament are merged (no pointless colour change).
 * - Bands starting at or above `zmap.maxZMm` are kept but flagged `unused: true`.
 * - Every band carries the filament's colour, finish and name, and `specIndex`, the index of
 *   the spec it came from.
 * Without a zmap only the first band can be resolved.
 * @param {object} project
 * @param {ZMap|null} zmap
 * @param {BandSpec[]} [specs]
 * @returns {Array<ResolvedBand & {unused:boolean, specIndex:number}>}
 */
export function resolveBands(project, zmap, specs = effectiveBandSpecs(project, zmap)) {
  const list = Array.isArray(specs) && specs.length > 0 ? specs : effectiveBandSpecs(project, zmap);
  const { layerHeightMm: h, firstLayerMm: first } = layerSettings(project);
  const maxHeightMm = positiveOr(project?.relief?.maxHeightMm, 0);

  // k = index of the layer top where the band starts (-1 = from the build plate).
  const candidates = [];
  list.forEach((spec, i) => {
    if (i === 0) {
      candidates.push({ spec, i, k: -1 });
      return;
    }
    if (!zmap || spec.fromM === null || !Number.isFinite(Number(spec.fromM))) return;
    const z = elevationToZ(zmap, Number(spec.fromM), maxHeightMm);
    candidates.push({ spec, i, k: Math.max(0, Math.round((z - first) / h)) });
  });

  // Walk down from the top: a band survives only if it starts strictly below the next survivor.
  const kept = [];
  let limit = Infinity;
  for (let j = candidates.length - 1; j >= 0; j--) {
    if (candidates[j].k < limit) {
      kept.push(candidates[j]);
      limit = candidates[j].k;
    }
  }
  kept.reverse();
  const merged = kept.filter((c, j) => j === 0 || c.spec.filamentId !== kept[j - 1].spec.filamentId);

  const maxZ = zmap && Number.isFinite(zmap.maxZMm) ? zmap.maxZMm : Infinity;
  const bands = merged.map(({ spec, i, k }) => {
    const f = getFilament(project, spec.filamentId);
    const zFrom = k < 0 ? 0 : round6(first + k * h);
    return {
      filamentId: spec.filamentId,
      zFrom,
      zTo: Infinity,
      layerFrom: k + 2,
      elevFromM: i === 0 ? null : Number(spec.fromM),
      color: f.color,
      finish: f.finish,
      name: f.name,
      unused: k >= 0 && zFrom >= maxZ - 1e-6,
      specIndex: i,
    };
  });
  for (let j = 0; j < bands.length - 1; j++) bands[j].zTo = bands[j + 1].zFrom;
  return bands;
}

/**
 * Filament-change schedule for the print plan: the starting filament (layer 1, z 0) followed
 * by every change that actually happens (unused bands are omitted).
 * @param {Array<ResolvedBand & {unused?:boolean}>} resolvedBands
 * @returns {Array<{layer:number, z:number, filamentId:string, filamentName:string, color:string}>}
 */
export function formatColorChangeTable(resolvedBands) {
  return (resolvedBands ?? [])
    .filter((b) => !b.unused)
    .map((b) => ({ layer: b.layerFrom, z: b.zFrom, filamentId: b.filamentId, filamentName: b.name, color: b.color }));
}
