// Elevation (metres) → printed height (mm) mapping. DOM-free.

/** Exaggeration range of the automatic mode (same as the UI limits). */
const AUTO_EXAGGERATION_MIN = 0.5;
const AUTO_EXAGGERATION_MAX = 30;
/** 'auto' floors are rounded down to this many metres. */
const AUTO_FLOOR_STEP_M = 50;
/** Minima above −1 m are sea-level noise of the 1 m-quantised DEM (e.g. Fuji's −0.1 m coast). */
const SEA_LEVEL_NOISE_M = 1;

/**
 * @typedef {import('../types.js').ZMap & {maxHeightMm:number}} ZMapEx
 * ZMap plus `maxHeightMm` (0 = no clamp), the total-height cap applied by zTop().
 */

/**
 * Computes how terrain elevations map to printed heights.
 * - floor: 'auto' → floor(minElev/50)·50 (never below 0 unless minElev ≤ −1 m, i.e. truly below
 *   sea level rather than DEM noise), 'sea' → 0, 'fixed' → relief.floor.elevationM.
 * - autoExaggeration: clamp(targetReliefMm / ((maxElev − floor)/scaleMPerMm), 0.5, 30), rounded to 0.1.
 * - mmPerM = exaggeration / scaleMPerMm; zTop(e) = baseMm + max(0, e − floorM)·mmPerM, capped at
 *   relief.maxHeightMm when that is > 0.
 * - maxZMm = zTop(maxElev), or the border rim (baseMm + border.heightMm) if that is higher, never above the cap.
 * @param {object} project normalised project (relief, border)
 * @param {import('../types.js').Layout} layout
 * @param {{minElev:number, maxElev:number}} stats elevation range of the frame in metres
 * @returns {ZMapEx}
 */
export function computeZMap(project, layout, stats) {
  const relief = project.relief ?? {};
  const minElevM = finite(stats?.minElev, 0);
  const maxElevM = Math.max(minElevM, finite(stats?.maxElev, minElevM));
  const floorM = resolveFloor(relief.floor, minElevM);
  const scaleMPerMm = positive(layout?.scaleMPerMm, 1);
  const exaggeration = relief.autoExaggeration
    ? autoExaggeration(positive(relief.targetReliefMm, 25), maxElevM - floorM, scaleMPerMm)
    : positive(relief.exaggeration, 1);
  const zmap = {
    floorM,
    mmPerM: exaggeration / scaleMPerMm,
    baseMm: Math.max(0, finite(relief.baseMm, 3)),
    exaggeration,
    minElevM,
    maxElevM,
    maxZMm: 0,
    maxHeightMm: relief.maxHeightMm > 0 ? relief.maxHeightMm : 0,
  };
  let maxZ = zTop(zmap, maxElevM);
  const border = project.border;
  if (border?.enabled && border.widthMm > 0) maxZ = Math.max(maxZ, zmap.baseMm + Math.max(0, finite(border.heightMm, 0)));
  zmap.maxZMm = zmap.maxHeightMm > 0 ? Math.min(maxZ, zmap.maxHeightMm) : maxZ;
  return zmap;
}

/**
 * Printed top height for an elevation: baseMm + max(0, e − floorM)·mmPerM, capped at
 * zmap.maxHeightMm when that is > 0. Non-finite elevations map to the base.
 * @param {import('../types.js').ZMap & {maxHeightMm?:number}} zmap
 * @param {number} elevM elevation in metres
 * @returns {number} mm
 */
export function zTop(zmap, elevM) {
  const d = elevM - zmap.floorM;
  const z = zmap.baseMm + (d > 0 ? d * zmap.mmPerM : 0);
  return zmap.maxHeightMm > 0 && z > zmap.maxHeightMm ? zmap.maxHeightMm : z;
}

/**
 * Converts a whole elevation grid to printed heights (same rule as zTop, tight loop).
 * @param {Float32Array} elev metres
 * @param {import('../types.js').ZMap & {maxHeightMm?:number}} zmap
 * @param {Float32Array} [out] destination (may be `elev` itself)
 * @returns {Float32Array} mm
 */
export function elevationToZ(elev, zmap, out = new Float32Array(elev.length)) {
  const { baseMm, floorM, mmPerM } = zmap;
  const cap = zmap.maxHeightMm > 0 ? zmap.maxHeightMm : Infinity;
  for (let i = 0; i < elev.length; i++) {
    const d = elev[i] - floorM;
    const z = baseMm + (d > 0 ? d * mmPerM : 0);
    out[i] = z < cap ? z : cap;
  }
  return out;
}

/**
 * Elevation printed at the base level.
 * @param {{mode?:string, elevationM?:number}|undefined} floor relief.floor
 * @param {number} minElevM lowest elevation of the frame
 * @returns {number} metres
 */
export function resolveFloor(floor, minElevM) {
  switch (floor?.mode) {
    case 'sea': return 0;
    case 'fixed': return finite(floor.elevationM, 0);
    default: {
      const min = minElevM > -SEA_LEVEL_NOISE_M ? Math.max(0, minElevM) : minElevM;
      const f = Math.floor(min / AUTO_FLOOR_STEP_M) * AUTO_FLOOR_STEP_M;
      return f === 0 ? 0 : f; // avoid -0
    }
  }
}

/**
 * Exaggeration that makes the frame's relief (maxElev − floor) print `targetReliefMm` tall.
 * @param {number} targetReliefMm
 * @param {number} reliefM elevation range above the floor
 * @param {number} scaleMPerMm ground metres per printed mm
 * @returns {number} clamped to [0.5, 30], rounded to 0.1
 */
export function autoExaggeration(targetReliefMm, reliefM, scaleMPerMm) {
  const natural = Math.max(reliefM, 1) / scaleMPerMm; // printed relief at 1× in mm
  const raw = targetReliefMm / natural;
  const clamped = Math.min(AUTO_EXAGGERATION_MAX, Math.max(AUTO_EXAGGERATION_MIN, raw));
  return Math.round(clamped * 10) / 10;
}

function finite(v, fallback) {
  return typeof v === 'number' && Number.isFinite(v) ? v : fallback;
}

function positive(v, fallback) {
  return typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : fallback;
}
