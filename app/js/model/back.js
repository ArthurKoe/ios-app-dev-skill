// Back side of a tile: engraved label and magnet pockets as an underside height grid. DOM-free.
//
// The grid uses the same tile-local frame as the top surface (x → right, y ↑ towards the
// artwork's top edge, row 0 = top), viewed from the front. z is the height of the underside:
// 0 = flat bottom, > 0 = recessed into the tile.

import { measureText, rasterizeText } from './font.js';

/** Largest label cap height (incl. stroke), in mm. */
const MAX_LABEL_MM = 12;
/** Free space kept left and right of the label, in mm. */
const LABEL_MARGIN_MM = 3;
/** Plastic kept between a magnet pocket and the tile edge / another pocket, in mm. */
const POCKET_WALL_MM = 1.2;
/** Material kept between any back feature and the top surface, in mm. */
const TOP_CLEARANCE_MM = 0.8;
/** Recesses shallower than this after clamping are dropped, in mm. */
const MIN_FEATURE_MM = 0.1;

/**
 * Builds the underside grid of a tile: the engraved label (tile label + ' ↑', mirrored in x so it
 * reads correctly once the tile is turned face-down about its vertical axis, centred, the arrow
 * pointing to the artwork's top) and magnet pockets (discs of magnets.diameterMm, depthMm deep;
 * see magnetPositions). Every recess stays at least 0.8 mm below the top surface when `topGrid` is
 * given (defaults to tile.top).
 * Pockets are carved half a sample diagonal wider than their diameter so the full-depth floor of
 * the heightfield pocket is never narrower than the magnet.
 * @param {{label:string, widthMm:number, heightMm:number, top?:import('../types.js').Grid}} tile
 * @param {import('../types.js').Layout} layout
 * @param {object} project normalised project (uses project.back)
 * @param {number} [backResMm=0.25] sample spacing of the back grid
 * @param {import('../types.js').Grid|null} [topGrid=tile.top] top surface of the same tile
 * @returns {import('../types.js').Grid|null} null when the tile has no back features
 */
export function buildBackGrid(tile, layout, project, backResMm = 0.25, topGrid = tile.top ?? null) {
  const back = project.back ?? {};
  const magnets = back.magnets ?? {};
  const labelDepth = back.labels ? positive(back.labelDepthMm, 0) : 0;
  const magnetDepth = magnets.enabled ? positive(magnets.depthMm, 0) : 0;
  const W = positive(tile.widthMm, layout.tileW);
  const H = positive(tile.heightMm, layout.tileH);
  const pockets = magnetDepth > 0 ? magnetPositions(W, H, magnets) : [];
  if (labelDepth === 0 && pockets.length === 0) return null;

  const res = positive(backResMm, 0.25);
  const nx = Math.max(2, Math.round(W / res)) + 1;
  const ny = Math.max(2, Math.round(H / res)) + 1;
  const grid = { nx, ny, z: new Float32Array(nx * ny) };
  const frame = { W, H, sx: W / (nx - 1), sy: H / (ny - 1) };

  const carveRadius = positive(magnets.diameterMm, 0) / 2 + Math.SQRT1_2 * Math.max(frame.sx, frame.sy);
  for (const p of pockets) carveDisc(grid, frame, p.x, p.y, carveRadius, magnetDepth);
  if (labelDepth > 0) engraveLabel(grid, frame, `${tile.label} ↑`, labelDepth);
  if (topGrid) limitToTop(grid, frame, topGrid);
  return grid.z.some((v) => v > 0) ? grid : null;
}

/**
 * Magnet pocket centres in tile-local mm (x → right, y ↑). magnets.perTile:
 * 1 top-centre · 2 left/right middle · 3 top-centre + bottom corners · 4 corners ·
 * 5 corners + top-centre · 6 corners + left/right middle · 7 corners + left/right/top middle ·
 * 8 corners + all edge middles. Positions are insetMm from the edges. Pockets that would not keep
 * 1.2 mm of wall to the tile edge or to an already placed pocket are skipped.
 * @param {number} widthMm tile width
 * @param {number} heightMm tile height
 * @param {{perTile?:number, diameterMm?:number, insetMm?:number}} magnets
 * @returns {{x:number, y:number}[]}
 */
export function magnetPositions(widthMm, heightMm, magnets) {
  const count = Math.min(8, Math.round(finite(magnets.perTile, 0)));
  const diameter = positive(magnets.diameterMm, 0);
  if (count < 1 || diameter === 0) return [];
  const r = diameter / 2;
  const i = finite(magnets.insetMm, 25);
  const W = widthMm;
  const H = heightMm;
  const top = [W / 2, H - i];
  const bottom = [W / 2, i];
  const left = [i, H / 2];
  const right = [W - i, H / 2];
  const corners = [[i, H - i], [W - i, H - i], [i, i], [W - i, i]];
  const patterns = {
    1: [top],
    2: [left, right],
    3: [top, corners[2], corners[3]],
    4: corners,
    5: [...corners, top],
    6: [...corners, left, right],
    7: [...corners, left, right, top],
    8: [...corners, top, bottom, left, right],
  };
  const placed = [];
  for (const [x, y] of patterns[count]) {
    const inside = x - r >= POCKET_WALL_MM && x + r <= W - POCKET_WALL_MM
      && y - r >= POCKET_WALL_MM && y + r <= H - POCKET_WALL_MM;
    const apart = placed.every((p) => Math.hypot(p.x - x, p.y - y) >= diameter + POCKET_WALL_MM);
    if (inside && apart) placed.push({ x, y });
  }
  return placed;
}

/**
 * Label size for a tile: height min(12, tileH/6) mm, stroke 14 % of the height (0.8 … 1.8 mm),
 * both scaled down when the text would not fit the tile width.
 * @param {number} widthMm tile width
 * @param {number} heightMm tile height
 * @param {string} text
 * @returns {{heightMm:number, strokeMm:number}}
 */
export function labelSpec(widthMm, heightMm, text) {
  let height = Math.min(MAX_LABEL_MM, heightMm / 6);
  let stroke = Math.min(1.8, Math.max(0.8, height * 0.14));
  const maxWidth = widthMm - 2 * LABEL_MARGIN_MM;
  const width = measureText(text, height, stroke);
  if (maxWidth > 0 && width > maxWidth) {
    const f = maxWidth / width;
    height *= f;
    stroke *= f;
  }
  return { heightMm: height, strokeMm: stroke };
}

// ---------------------------------------------------------------------------------------------

/**
 * @typedef {{W:number, H:number, sx:number, sy:number}} BackFrame tile size and grid spacing (mm)
 */

/**
 * Recesses a disc to `depth` (keeps deeper existing recesses).
 * @param {import('../types.js').Grid} grid
 * @param {BackFrame} f
 * @param {number} cx centre x (mm)
 * @param {number} cy centre y (mm, ↑)
 * @param {number} radius
 * @param {number} depth
 */
function carveDisc(grid, f, cx, cy, radius, depth) {
  const { nx, ny, z } = grid;
  const c0 = Math.max(0, Math.floor((cx - radius) / f.sx));
  const c1 = Math.min(nx - 1, Math.ceil((cx + radius) / f.sx));
  const r0 = Math.max(0, Math.floor((f.H - cy - radius) / f.sy));
  const r1 = Math.min(ny - 1, Math.ceil((f.H - cy + radius) / f.sy));
  const radius2 = radius * radius;
  for (let r = r0; r <= r1; r++) {
    const dy = f.H - r * f.sy - cy;
    for (let c = c0; c <= c1; c++) {
      const dx = c * f.sx - cx;
      const i = r * nx + c;
      if (dx * dx + dy * dy <= radius2 && z[i] < depth) z[i] = depth;
    }
  }
}

/**
 * Engraves `text` centred on the tile, mirrored in x: seen from behind (tile turned face-down
 * about its vertical axis) the tile point x appears at W − x, so text column u maps to
 * x = (W/2 + textWidth/2) − u, while y is unchanged and the text's top points to the artwork top.
 * @param {import('../types.js').Grid} grid
 * @param {BackFrame} f
 * @param {string} text
 * @param {number} depth
 */
function engraveLabel(grid, f, text, depth) {
  const { nx, ny, z } = grid;
  const spec = labelSpec(f.W, f.H, text);
  const res = Math.min(f.sx, f.sy);
  const glyphs = rasterizeText(text, spec.heightMm, spec.strokeMm, res);
  const textW = (glyphs.w - 1) * res;
  const textH = (glyphs.h - 1) * res;
  const right = f.W / 2 + textW / 2; // tile x of the text's first column
  const top = f.H / 2 + textH / 2; // tile y of the text's first row
  const c0 = Math.max(0, Math.floor((right - textW) / f.sx));
  const c1 = Math.min(nx - 1, Math.ceil(right / f.sx));
  const r0 = Math.max(0, Math.floor((f.H - top) / f.sy));
  const r1 = Math.min(ny - 1, Math.ceil((f.H - top + textH) / f.sy));
  for (let r = r0; r <= r1; r++) {
    const mr = Math.round((top - (f.H - r * f.sy)) / res);
    if (mr < 0 || mr >= glyphs.h) continue;
    for (let c = c0; c <= c1; c++) {
      const mc = Math.round((right - c * f.sx) / res);
      if (mc < 0 || mc >= glyphs.w || !glyphs.mask[mr * glyphs.w + mc]) continue;
      const i = r * nx + c;
      if (z[i] < depth) z[i] = depth;
    }
  }
}

/**
 * Keeps every recess at least TOP_CLEARANCE_MM below the top surface (the lowest of the four
 * surrounding top samples); recesses that become shallower than 0.1 mm are removed.
 * @param {import('../types.js').Grid} grid
 * @param {BackFrame} f
 * @param {import('../types.js').Grid} topGrid spans the same W × H rectangle
 */
function limitToTop(grid, f, topGrid) {
  const { nx, ny, z } = grid;
  const tnx = topGrid.nx;
  const tny = topGrid.ny;
  const tz = topGrid.z;
  const fx = (tnx - 1) / f.W;
  const fy = (tny - 1) / f.H;
  for (let r = 0; r < ny; r++) {
    const tr0 = Math.min(tny - 1, Math.floor(r * f.sy * fy));
    const tr1 = Math.min(tny - 1, tr0 + 1);
    for (let c = 0; c < nx; c++) {
      const i = r * nx + c;
      if (z[i] === 0) continue;
      const tc0 = Math.min(tnx - 1, Math.floor(c * f.sx * fx));
      const tc1 = Math.min(tnx - 1, tc0 + 1);
      const lowest = Math.min(tz[tr0 * tnx + tc0], tz[tr0 * tnx + tc1], tz[tr1 * tnx + tc0], tz[tr1 * tnx + tc1]);
      const allowed = lowest - TOP_CLEARANCE_MM;
      if (z[i] > allowed) z[i] = allowed >= MIN_FEATURE_MM ? allowed : 0;
    }
  }
}

function finite(v, fallback) {
  return typeof v === 'number' && Number.isFinite(v) ? v : fallback;
}

function positive(v, fallback) {
  return typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : fallback;
}
