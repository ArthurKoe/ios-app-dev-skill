// Height-grid triangulation: a full regular grid or an adaptive Delatin TIN.
//
// Grid conventions (docs/ARCHITECTURE.md): row-major Float32Array, row 0 at the TOP edge, so grid
// coordinates (gx = column, gy = row) have gy pointing *down*. Artwork coordinates have y up, which
// flips the winding: every triangle returned here is counter-clockwise in artwork orientation
// (normal +z for a height field seen from above).

import Delatin from '../../vendor/delatin/delatin.js';

/**
 * Triangulates a height grid.
 *
 * - `toleranceMm <= 0` (or not a number): regular grid, two triangles per cell. Each cell is split
 *   along the diagonal whose end points differ less in height, which follows ridges and valleys
 *   instead of cutting across them.
 * - `toleranceMm > 0`: Delatin greedy refinement until no grid sample deviates more than
 *   `toleranceMm` from the surface. The four grid corners are always vertices.
 *
 * In both cases the triangulation covers the full rectangle, and every vertex that lies on its
 * border is a vertex of the border polyline (no T-junctions). Delatin inserts border samples by
 * splitting the border edge they lie on, so this holds by construction.
 *
 * @param {ArrayLike<number>} z heights, row-major, `nx * ny` values, row 0 = top (max y)
 * @param {number} nx samples per row (>= 2)
 * @param {number} ny number of rows (>= 2)
 * @param {number} toleranceMm maximum vertical error; <= 0 → full grid
 * @returns {{coords: Uint32Array, triangles: Uint32Array}} `coords` = [gx0, gy0, gx1, gy1, ...] grid
 *   coordinates of the vertices, `triangles` = vertex index triples, CCW in artwork orientation.
 */
export function triangulateGrid(z, nx, ny, toleranceMm) {
  assertGrid(z, nx, ny);
  return toleranceMm > 0 ? triangulateAdaptive(z, nx, ny, toleranceMm) : triangulateRegular(z, nx, ny);
}

/**
 * Full regular grid. Vertex index = gy * nx + gx.
 * @param {ArrayLike<number>} z
 * @param {number} nx
 * @param {number} ny
 * @returns {{coords: Uint32Array, triangles: Uint32Array}}
 */
export function triangulateRegular(z, nx, ny) {
  assertGrid(z, nx, ny);
  const coords = new Uint32Array(nx * ny * 2);
  for (let gy = 0, k = 0; gy < ny; gy++) {
    for (let gx = 0; gx < nx; gx++, k += 2) {
      coords[k] = gx;
      coords[k + 1] = gy;
    }
  }
  const triangles = new Uint32Array((nx - 1) * (ny - 1) * 6);
  let t = 0;
  for (let gy = 0; gy < ny - 1; gy++) {
    for (let gx = 0; gx < nx - 1; gx++) {
      // a b    (row gy, upper edge in artwork orientation)
      // d e    (row gy + 1)
      const a = gy * nx + gx;
      const b = a + 1;
      const d = a + nx;
      const e = d + 1;
      if (Math.abs(z[a] - z[e]) <= Math.abs(z[b] - z[d])) {
        triangles[t++] = d; triangles[t++] = e; triangles[t++] = a;
        triangles[t++] = a; triangles[t++] = e; triangles[t++] = b;
      } else {
        triangles[t++] = d; triangles[t++] = e; triangles[t++] = b;
        triangles[t++] = d; triangles[t++] = b; triangles[t++] = a;
      }
    }
  }
  return { coords, triangles };
}

/**
 * Adaptive Delatin triangulation (x = column, y = row in Delatin's frame). Delatin's own winding
 * is clockwise in its y-down frame, i.e. counter-clockwise in artwork orientation, so triangles
 * are passed through unchanged.
 * @param {ArrayLike<number>} z
 * @param {number} nx
 * @param {number} ny
 * @param {number} toleranceMm > 0
 * @returns {{coords: Uint32Array, triangles: Uint32Array}}
 */
export function triangulateAdaptive(z, nx, ny, toleranceMm) {
  assertGrid(z, nx, ny);
  const tin = new Delatin(z, nx, ny);
  tin.run(toleranceMm);
  return { coords: Uint32Array.from(tin.coords), triangles: Uint32Array.from(tin.triangles) };
}

/**
 * @param {ArrayLike<number>} z
 * @param {number} nx
 * @param {number} ny
 */
function assertGrid(z, nx, ny) {
  if (!Number.isInteger(nx) || !Number.isInteger(ny) || nx < 2 || ny < 2) {
    throw new RangeError(`grid must be at least 2 x 2 samples (got ${nx} x ${ny})`);
  }
  if (!z || z.length !== nx * ny) {
    throw new RangeError(`grid has ${z ? z.length : 0} values, expected ${nx} x ${ny} = ${nx * ny}`);
  }
}
