// Closed, printable solids from a top height grid and an optional underside grid.
//
// The solid of one tile consists of
//   * the top surface: triangulated top grid (CCW from above → normals +z),
//   * the underside: triangulated bottom grid with reversed winding (normals -z); without a bottom
//     grid a flat z = 0 rectangle made of the four corners only (2 triangles),
//   * four side walls, each a planar polygon bounded by the top and the bottom border polylines of
//     that side. The walls reuse the border vertices of both surfaces (no new vertices), so every
//     border edge of the top and of the bottom is shared with exactly one wall triangle.
//
// Walls are triangulated as monotone polygons (sweep along the side): this "zipper" connects the
// two polylines but, unlike a naive alternating zipper, never produces overlapping or inverted
// triangles - e.g. when a four-corner flat bottom faces a mountainous top border, a fan from the
// bottom corners would fold over itself. Triangle winding is derived from the polygon's boundary
// order (not from floating point signs), so the result is a closed, consistently oriented
// 2-manifold for any input; geometric validity needs top > bottom along the border, which the
// relief pipeline guarantees (minimum thickness >= 0.6 mm).

import { triangulateGrid, triangulateRegular } from './triangulate.js';

const FLAT_BOTTOM = Object.freeze({ nx: 2, ny: 2, z: new Float32Array(4) });

/** Side order: walking counter-clockwise around the rectangle seen from above. */
const SIDES = Object.freeze([
  { axis: 0, sign: 1 },  // south: y = 0,      t = +x
  { axis: 1, sign: 1 },  // east:  x = width,  t = +y
  { axis: 0, sign: -1 }, // north: y = height, t = -x
  { axis: 1, sign: -1 }, // west:  x = 0,      t = -y
]);

/**
 * Builds a closed, consistently oriented (outward CCW) triangle mesh of a tile.
 *
 * Coordinates: x ∈ [0, widthMm], y ∈ [0, heightMm]; grid sample (r, c) of an nx × ny grid sits at
 * x = c / (nx - 1) * widthMm, y = heightMm - r / (ny - 1) * heightMm, so grid corners are exactly on
 * the rectangle corners for any resolution. Top and bottom grids may have different resolutions.
 *
 * Preconditions: top.z > bottom surface everywhere (strictly). Non-finite heights throw.
 *
 * @param {object} args
 * @param {import('../types.js').Grid} args.top top surface heights (mm)
 * @param {import('../types.js').Grid|null} [args.bottom] underside heights (0 = flat, > 0 = pocket);
 *   null → flat underside at z = 0 made of the four corners only
 * @param {number} args.widthMm
 * @param {number} args.heightMm
 * @param {number} [args.topToleranceMm=0] max vertical error of the top surface (0 = full grid)
 * @param {number} [args.bottomToleranceMm=0.01] max vertical error of the underside (0 = full grid)
 * @param {Uint8Array|null} [args.topWater] one flag per top grid sample
 * @returns {import('../types.js').Mesh & {water?: Uint8Array}} positions (Float32Array xyz),
 *   indices (Uint32Array); `water` holds one flag per vertex (0 for underside vertices) when
 *   `topWater` was given. Vertices are ordered: top surface first, then underside.
 */
export function buildSolid({
  top, bottom = null, widthMm, heightMm, topToleranceMm = 0, bottomToleranceMm = 0.01, topWater = null,
}) {
  if (!(widthMm > 0) || !(heightMm > 0) || !Number.isFinite(widthMm) || !Number.isFinite(heightMm)) {
    throw new RangeError(`invalid solid size ${widthMm} x ${heightMm} mm`);
  }
  if (topWater && topWater.length !== top.nx * top.ny) {
    throw new RangeError(`topWater has ${topWater.length} flags, expected ${top.nx * top.ny}`);
  }
  assertFiniteHeights(top, 'top');
  if (bottom) assertFiniteHeights(bottom, 'bottom');
  const under = bottom ?? FLAT_BOTTOM;
  const topTin = triangulateGrid(top.z, top.nx, top.ny, topToleranceMm);
  const botTin = bottom
    ? triangulateGrid(bottom.z, bottom.nx, bottom.ny, bottomToleranceMm)
    : triangulateRegular(FLAT_BOTTOM.z, 2, 2);

  const nTop = topTin.coords.length / 2;
  const nBot = botTin.coords.length / 2;
  const positions = new Float32Array((nTop + nBot) * 3);
  writeSurfacePositions(positions, 0, topTin.coords, top, widthMm, heightMm);
  writeSurfacePositions(positions, nTop, botTin.coords, under, widthMm, heightMm);

  const topChains = borderChains(topTin.coords, top.nx, top.ny, 0);
  const botChains = borderChains(botTin.coords, under.nx, under.ny, nTop);

  const nTopTri = topTin.triangles.length / 3;
  const nBotTri = botTin.triangles.length / 3;
  let nWallTri = 0;
  for (let s = 0; s < 4; s++) nWallTri += topChains[s].length + botChains[s].length - 2;
  const indices = new Uint32Array((nTopTri + nBotTri + nWallTri) * 3);

  indices.set(topTin.triangles, 0);
  let o = nTopTri * 3;
  const bt = botTin.triangles;
  for (let i = 0; i < bt.length; i += 3, o += 3) {
    indices[o] = bt[i] + nTop;
    indices[o + 1] = bt[i + 2] + nTop;
    indices[o + 2] = bt[i + 1] + nTop;
  }
  for (let s = 0; s < 4; s++) {
    o = triangulateWall(positions, topChains[s], botChains[s], SIDES[s].axis, SIDES[s].sign, indices, o);
  }

  /** @type {import('../types.js').Mesh & {water?: Uint8Array}} */
  const mesh = { positions, indices };
  if (topWater) mesh.water = vertexWaterFlags(topTin.coords, top.nx, topWater, nTop + nBot);
  return mesh;
}

/**
 * @param {import('../types.js').Grid} grid
 * @param {string} label
 */
function assertFiniteHeights(grid, label) {
  const z = grid.z;
  for (let i = 0; i < z.length; i++) {
    if (!Number.isFinite(z[i])) {
      throw new RangeError(`${label} grid height at row ${Math.floor(i / grid.nx)}, column ${i % grid.nx} is ${z[i]}`);
    }
  }
}

/**
 * Writes xyz of the vertices of a triangulated grid into `positions`.
 * @param {Float32Array} positions
 * @param {number} first index of the first vertex to write
 * @param {Uint32Array} coords grid coordinates [gx, gy, ...]
 * @param {import('../types.js').Grid} grid
 * @param {number} widthMm
 * @param {number} heightMm
 */
function writeSurfacePositions(positions, first, coords, grid, widthMm, heightMm) {
  const { nx, ny, z } = grid;
  const xs = new Float64Array(nx);
  const ys = new Float64Array(ny);
  for (let c = 0; c < nx; c++) xs[c] = (c / (nx - 1)) * widthMm;
  for (let r = 0; r < ny; r++) ys[r] = heightMm - (r / (ny - 1)) * heightMm;
  for (let k = 0, o = first * 3; k < coords.length; k += 2, o += 3) {
    const gx = coords[k];
    const gy = coords[k + 1];
    positions[o] = xs[gx];
    positions[o + 1] = ys[gy];
    positions[o + 2] = z[gy * nx + gx];
  }
}

/**
 * Border polylines of a rectangle triangulation, one per side in SIDES order, each sorted along the
 * side's walking direction and including both corners.
 * @param {Uint32Array} coords
 * @param {number} nx
 * @param {number} ny
 * @param {number} offset added to every vertex index
 * @returns {Uint32Array[]} [south, east, north, west]
 */
function borderChains(coords, nx, ny, offset) {
  const south = new Int32Array(nx).fill(-1); // indexed by gx
  const north = new Int32Array(nx).fill(-1);
  const east = new Int32Array(ny).fill(-1);  // indexed by gy
  const west = new Int32Array(ny).fill(-1);
  for (let k = 0; k < coords.length; k += 2) {
    const gx = coords[k];
    const gy = coords[k + 1];
    const v = offset + k / 2;
    if (gy === ny - 1) claim(south, gx, v);
    if (gy === 0) claim(north, gx, v);
    if (gx === 0) claim(west, gy, v);
    if (gx === nx - 1) claim(east, gy, v);
  }
  return [
    compact(south, false), // SW → SE (+x)
    compact(east, true),   // SE → NE (+y = decreasing row)
    compact(north, true),  // NE → NW (-x)
    compact(west, false),  // NW → SW (-y = increasing row)
  ];
}

/**
 * @param {Int32Array} slots
 * @param {number} i
 * @param {number} v
 */
function claim(slots, i, v) {
  if (slots[i] !== -1) throw new Error('triangulation has duplicate border vertices');
  slots[i] = v;
}

/**
 * @param {Int32Array} slots vertex index per position along the side, -1 = no vertex
 * @param {boolean} reverse
 * @returns {Uint32Array}
 */
function compact(slots, reverse) {
  if (slots[0] === -1 || slots[slots.length - 1] === -1) throw new Error('triangulation is missing a corner');
  let n = 0;
  for (let i = 0; i < slots.length; i++) if (slots[i] !== -1) n++;
  const out = new Uint32Array(n);
  let j = reverse ? n - 1 : 0;
  const step = reverse ? -1 : 1;
  for (let i = 0; i < slots.length; i++) {
    if (slots[i] !== -1) {
      out[j] = slots[i];
      j += step;
    }
  }
  return out;
}

/**
 * Triangulates one side wall: the planar polygon bounded by the bottom polyline (walked in +t) and
 * the top polyline (walked back in -t). In the wall plane (t along the side, z up) that polygon is
 * counter-clockwise and, because t runs counter-clockwise around the tile, its normal t × z points
 * outward. Uses the monotone-polygon sweep (de Berg et al., ch. 3) along t; each emitted triangle
 * is written in the cyclic order of the polygon boundary, which is its outward CCW winding.
 *
 * @param {Float32Array} positions
 * @param {Uint32Array} top top border vertex indices sorted by t (both corners included)
 * @param {Uint32Array} bot bottom border vertex indices sorted by t (both corners included)
 * @param {0|1} axis coordinate that varies along the side (0 = x, 1 = y)
 * @param {1|-1} sign t = sign * position[axis]
 * @param {Uint32Array} out index buffer
 * @param {number} o write offset into `out`
 * @returns {number} new write offset (advanced by 3 * (top.length + bot.length - 2))
 */
function triangulateWall(positions, top, bot, axis, sign, out, o) {
  const nt = top.length;
  const nb = bot.length;
  const n = nt + nb;
  // Boundary cycle (CCW in the wall plane): bot[0..nb-1], then top[nt-1..0].
  // cycle id of bot[i] = i, of top[k] = nb + nt - 1 - k.
  const vert = new Uint32Array(n);   // cycle id → mesh vertex
  for (let i = 0; i < nb; i++) vert[i] = bot[i];
  for (let k = 0; k < nt; k++) vert[nb + nt - 1 - k] = top[k];

  // Sweep order: bot[0] first, top[nt-1] last, the rest merged by t (ties: bottom first).
  const order = new Uint32Array(n);  // sweep position → cycle id
  const upper = new Uint8Array(n);   // by cycle id: 1 = top chain
  for (let c = nb; c < n; c++) upper[c] = 1;
  const ts = new Float64Array(n);    // by cycle id
  const zs = new Float64Array(n);
  for (let c = 0; c < n; c++) {
    const p = vert[c] * 3;
    ts[c] = sign * positions[p + axis];
    zs[c] = positions[p + 2];
  }
  order[0] = 0;
  order[n - 1] = nb; // top[nt - 1]
  let i = 1;          // next bottom index
  let k = 0;          // next top index
  for (let s = 1; s < n - 1; s++) {
    const cb = i;
    const ct = nb + nt - 1 - k;
    const takeBottom = i < nb && (k >= nt - 1 || ts[cb] <= ts[ct]);
    if (takeBottom) {
      order[s] = cb;
      i++;
    } else {
      order[s] = ct;
      k++;
    }
  }

  const emit = (a, b, c) => {
    // Sort the three cycle ids ascending → boundary (= CCW) order.
    let t;
    if (a > b) { t = a; a = b; b = t; }
    if (b > c) { t = b; b = c; c = t; }
    if (a > b) { t = a; a = b; b = t; }
    out[o++] = vert[a];
    out[o++] = vert[b];
    out[o++] = vert[c];
  };
  // Is the diagonal u–s inside the polygon, i.e. does `last` stick out beyond it?
  const isEar = (u, last, s) => {
    const cross = (ts[u] - ts[s]) * (zs[last] - zs[s]) - (zs[u] - zs[s]) * (ts[last] - ts[s]);
    return upper[u] ? cross > 0 : cross < 0;
  };

  const stack = new Uint32Array(n);
  let sp = 0;
  stack[sp++] = order[0];
  stack[sp++] = order[1];
  for (let s = 2; s < n - 1; s++) {
    const u = order[s];
    if (upper[u] !== upper[stack[sp - 1]]) {
      for (let j = 0; j < sp - 1; j++) emit(u, stack[j], stack[j + 1]);
      const prev = stack[sp - 1];
      sp = 0;
      stack[sp++] = prev;
      stack[sp++] = u;
    } else {
      let last = stack[--sp];
      while (sp > 0 && isEar(u, last, stack[sp - 1])) {
        emit(u, last, stack[sp - 1]);
        last = stack[--sp];
      }
      stack[sp++] = last;
      stack[sp++] = u;
    }
  }
  const u = order[n - 1];
  for (let j = 0; j < sp - 1; j++) emit(u, stack[j], stack[j + 1]);
  return o;
}

/**
 * @param {Uint32Array} coords top grid coordinates of the top vertices
 * @param {number} nx top grid width
 * @param {Uint8Array} topWater per top sample
 * @param {number} vertexCount total vertex count
 * @returns {Uint8Array}
 */
function vertexWaterFlags(coords, nx, topWater, vertexCount) {
  const water = new Uint8Array(vertexCount);
  for (let k = 0, v = 0; k < coords.length; k += 2, v++) {
    water[v] = topWater[coords[k + 1] * nx + coords[k]] ? 1 : 0;
  }
  return water;
}
