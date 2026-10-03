// Splits the artwork height field into per-tile fields. DOM-free.

import { buildBackGrid } from './back.js';

/**
 * Tile label: row letter + 1-based column ('A1' = top-left).
 * @param {number} row 0-based, 0 = top
 * @param {number} col 0-based, 0 = left
 * @returns {string}
 */
export function tileLabel(row, col) {
  return String.fromCharCode(65 + row) + (col + 1);
}

/**
 * Cuts the artwork field into `rows × cols` tile fields (row-major, A1 first).
 * Tile (row, col) takes artwork samples rows row·spy … (row+1)·spy and columns col·spx … (col+1)·spx,
 * so neighbouring tiles share identical boundary samples. `water` holds the matching slice of the
 * field's water mask (when the field has one). `bottom` is the back-side grid from model/back.js
 * (labels, magnet pockets) or null when withBack is false or the project has no back features.
 * @param {{z:Float32Array, water?:Uint8Array|null}} field artwork field (layout.nx × layout.ny)
 * @param {import('../types.js').Layout} layout
 * @param {object} project
 * @param {{withBack?:boolean, backResMm?:number}} [opts]
 * @returns {import('../types.js').TileField[]}
 */
export function extractTileFields(field, layout, project, { withBack = true, backResMm = 0.25 } = {}) {
  const { cols, rows, spx, spy, nx, ny, tileW, tileH, artH } = layout;
  if (field.z.length !== nx * ny) {
    throw new RangeError(`extractTileFields: field has ${field.z.length} samples, layout expects ${nx * ny}`);
  }
  const water = field.water?.length === nx * ny ? field.water : null;
  const tiles = [];
  for (let row = 0; row < rows; row++) {
    for (let col = 0; col < cols; col++) {
      const r0 = row * spy;
      const c0 = col * spx;
      /** @type {import('../types.js').TileField} */
      const tile = {
        label: tileLabel(row, col),
        row,
        col,
        x0: col * tileW,
        y0: artH - (row + 1) * tileH,
        widthMm: tileW,
        heightMm: tileH,
        top: { nx: spx + 1, ny: spy + 1, z: sliceGrid(field.z, nx, r0, c0, spx + 1, spy + 1, Float32Array) },
        bottom: null,
      };
      if (water) tile.water = sliceGrid(water, nx, r0, c0, spx + 1, spy + 1, Uint8Array);
      if (withBack) tile.bottom = buildBackGrid(tile, layout, project, backResMm);
      tiles.push(tile);
    }
  }
  return tiles;
}

/**
 * Copies a w × h window starting at (r0, c0) out of a row-major grid with `stride` columns.
 * @template {Float32Array|Uint8Array} T
 * @param {T} src
 * @param {number} stride
 * @param {number} r0
 * @param {number} c0
 * @param {number} w
 * @param {number} h
 * @param {{new(n:number):T}} Type
 * @returns {T}
 */
function sliceGrid(src, stride, r0, c0, w, h, Type) {
  const out = new Type(w * h);
  for (let r = 0; r < h; r++) {
    const s = (r0 + r) * stride + c0;
    out.set(src.subarray(s, s + w), r * w);
  }
  return out;
}
