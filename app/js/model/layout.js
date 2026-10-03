// Artwork layout: tile grid, map scale, sample grid and printer-bed fit. DOM-free.

import { styleResolutionHint } from './styles.js';

/** Finest elevation data available anywhere (Copernicus GLO-30), in ground metres. */
const FINEST_DATA_M = 30;
/** Above this many artwork samples an export gets slow and memory hungry. */
const LARGE_GRID_SAMPLES = 50e6;
/** Above this many tiles the print job becomes a marathon. */
const MANY_TILES = 40;
/** Relative frame/artwork aspect difference that distorts the map visibly. */
const ASPECT_TOLERANCE = 0.01;
/** Smallest tile fitTileToBed will suggest, in mm. */
const MIN_TILE_MM = 20;
/** Finest export sample spacing the pipeline uses, in mm. */
const MIN_EXPORT_RES_MM = 0.1;

/**
 * Computes the artwork layout for a project at a given sample spacing.
 * `artW = cols·tileW`, `artH = rows·tileH`; `spx = max(2, round(tileW/res))` (same for y) so every
 * tile has the same number of samples and neighbouring tiles share their boundary samples.
 * @param {object} project normalised project (frame, printer, layout, relief)
 * @param {number} resolutionMm target sample spacing in mm (falls back to relief.resolutionMm)
 * @returns {import('../types.js').Layout}
 */
export function computeLayout(project, resolutionMm) {
  const cfg = project.layout ?? {};
  const cols = Math.max(1, Math.round(positive(cfg.cols, 1)));
  const rows = Math.max(1, Math.round(positive(cfg.rows, 1)));
  const tileW = positive(cfg.tileW, 100);
  const tileH = positive(cfg.tileH, 100);
  const res = positive(resolutionMm, positive(project.relief?.resolutionMm, 0.4));

  const artW = cols * tileW;
  const artH = rows * tileH;
  const widthKm = positive(project.frame?.widthKm, artW / 1000);
  const scaleMPerMm = (widthKm * 1000) / artW;
  const scaleDenominator = Math.round(scaleMPerMm * 1000);

  const spx = Math.max(2, Math.round(tileW / res));
  const spy = Math.max(2, Math.round(tileH / res));
  const nx = cols * spx + 1;
  const ny = rows * spy + 1;
  const dx = tileW / spx;
  const dy = tileH / spy;

  const { fitsBed, rotateOnBed } = tileBedFit(project.printer, tileW, tileH);
  const warnings = layoutWarnings({ project, tileW, tileH, artW, artH, cols, rows, scaleMPerMm, fitsBed });

  return {
    cols, rows, tileW, tileH, artW, artH,
    scaleMPerMm, scaleDenominator,
    spx, spy, nx, ny, dx, dy,
    fitsBed, rotateOnBed, warnings,
  };
}

/**
 * Largest square tile that fits the printer bed with `marginMm` free on every side
 * (rounded down to whole millimetres, at least 20 mm).
 * @param {{bedW:number, bedH:number}} printer
 * @param {number} [marginMm=5]
 * @returns {{tileW:number, tileH:number}}
 */
export function fitTileToBed(printer, marginMm = 5) {
  const bed = Math.min(positive(printer?.bedW, 200), positive(printer?.bedH, 200));
  const side = Math.max(MIN_TILE_MM, Math.floor(bed - 2 * Math.max(0, marginMm) + 1e-9));
  return { tileW: side, tileH: side };
}

/**
 * Whether a tile fits the bed as-is or only when rotated by 90° on the bed.
 * @param {{bedW:number, bedH:number}|undefined} printer
 * @param {number} tileW
 * @param {number} tileH
 * @returns {{fitsBed:boolean, rotateOnBed:boolean}}
 */
export function tileBedFit(printer, tileW, tileH) {
  const bedW = positive(printer?.bedW, Infinity);
  const bedH = positive(printer?.bedH, Infinity);
  const eps = 1e-6;
  const direct = tileW <= bedW + eps && tileH <= bedH + eps;
  const rotated = tileH <= bedW + eps && tileW <= bedH + eps;
  return { fitsBed: direct || rotated, rotateOnBed: !direct && rotated };
}

/**
 * Export sample spacing: min(relief.resolutionMm, style hint), never below 0.1 mm
 * (the same rule engine/pipeline.js applies).
 * @param {object} project
 * @returns {number} mm
 */
export function exportResolutionMm(project) {
  const res = positive(project.relief?.resolutionMm, 0.4);
  const hint = styleResolutionHint(project);
  return Math.max(MIN_EXPORT_RES_MM, hint > 0 ? Math.min(res, hint) : res);
}

/**
 * User-facing layout warnings (short sentences). Grid-size and data-resolution warnings refer to
 * the export resolution so the preview already shows what the export will run into.
 * @param {{project:object, tileW:number, tileH:number, artW:number, artH:number, cols:number, rows:number,
 *          scaleMPerMm:number, fitsBed:boolean}} p
 * @returns {string[]}
 */
function layoutWarnings({ project, tileW, tileH, artW, artH, cols, rows, scaleMPerMm, fitsBed }) {
  const warnings = [];
  const printer = project.printer ?? {};
  if (!fitsBed) {
    warnings.push(`Tiles (${mm(tileW)} × ${mm(tileH)} mm) do not fit the ${mm(printer.bedW)} × ${mm(printer.bedH)} mm bed.`);
  }
  const frame = project.frame;
  if (frame?.widthKm > 0 && frame?.heightKm > 0) {
    const frameAspect = frame.heightKm / frame.widthKm;
    if (Math.abs(frameAspect / (artH / artW) - 1) > ASPECT_TOLERANCE) {
      warnings.push('The map area and the tile layout have different proportions; the map will be stretched.');
    }
  }
  if (cols * rows > MANY_TILES) warnings.push(`${cols * rows} tiles – that is a very long print job.`);
  const res = exportResolutionMm(project);
  const samples = (cols * Math.max(2, Math.round(tileW / res)) + 1) * (rows * Math.max(2, Math.round(tileH / res)) + 1);
  if (samples > LARGE_GRID_SAMPLES) {
    warnings.push(`Very fine export grid (${Math.round(samples / 1e6)} M samples) – a coarser resolution exports faster.`);
  }
  if (res * scaleMPerMm < FINEST_DATA_M) {
    warnings.push('The map is zoomed in beyond the ~30 m elevation data; fine detail will look soft.');
  }
  return warnings;
}

function positive(v, fallback) {
  return typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : fallback;
}

function mm(v) {
  return Number.isFinite(v) ? String(Math.round(v * 10) / 10) : '?';
}
