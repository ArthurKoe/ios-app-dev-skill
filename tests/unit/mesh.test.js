// Mesh generation and file writers. Broken solids waste filament, so every solid built here is
// checked for: closed 2-manifold with consistent orientation, Euler characteristic of a sphere,
// outward normals per face class (top +z, underside -z, walls = side normal → no folded walls),
// no zero-area triangles, no duplicated vertex positions, positive volume that matches the
// integral of (top - bottom).

import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { unzipSync, strFromU8 } from '../../app/vendor/fflate/fflate.js';
import { triangulateGrid } from '../../app/js/mesh/triangulate.js';
import { buildSolid } from '../../app/js/mesh/solid.js';
import {
  meshStats, checkWatertight, countDegenerateTriangles, countDuplicateVertices,
} from '../../app/js/mesh/analyze.js';
import { writeBinarySTL, parseBinarySTL } from '../../app/js/mesh/stl.js';
import { write3MF, prusaColorChangesXml } from '../../app/js/mesh/threemf.js';

// ---------------------------------------------------------------------------------------------
// Synthetic inputs

/** Deterministic pseudo-random numbers (mulberry32). */
function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Multi-octave value noise scaled to [minMm, maxMm] (fBm, smoothstep interpolation).
 * @returns {Float32Array}
 */
function fractalTerrain(nx, ny, { seed = 1, octaves = 7, baseCells = 3, persistence = 0.5, minMm = 3, maxMm = 28 } = {}) {
  const rnd = rng(seed);
  const acc = new Float64Array(nx * ny);
  let amp = 1;
  let cells = baseCells;
  const span = Math.max(nx, ny) - 1;
  for (let o = 0; o < octaves; o++) {
    const lx = Math.ceil(cells * (nx - 1) / span) + 2;
    const ly = Math.ceil(cells * (ny - 1) / span) + 2;
    const lattice = Float64Array.from({ length: lx * ly }, () => rnd() * 2 - 1);
    const ox = rnd();
    const oy = rnd();
    for (let r = 0; r < ny; r++) {
      const fy = (r / span) * cells + oy;
      const iy = Math.floor(fy);
      const ty = smooth(fy - iy);
      for (let c = 0; c < nx; c++) {
        const fx = (c / span) * cells + ox;
        const ix = Math.floor(fx);
        const tx = smooth(fx - ix);
        const i0 = iy * lx + ix;
        const top = lattice[i0] * (1 - tx) + lattice[i0 + 1] * tx;
        const bot = lattice[i0 + lx] * (1 - tx) + lattice[i0 + lx + 1] * tx;
        acc[r * nx + c] += amp * (top * (1 - ty) + bot * ty);
      }
    }
    amp *= persistence;
    cells *= 2;
  }
  let lo = Infinity;
  let hi = -Infinity;
  for (const v of acc) {
    lo = Math.min(lo, v);
    hi = Math.max(hi, v);
  }
  const z = new Float32Array(nx * ny);
  for (let i = 0; i < z.length; i++) z[i] = minMm + ((acc[i] - lo) / (hi - lo)) * (maxMm - minMm);
  return z;
}

function smooth(t) {
  return t * t * (3 - 2 * t);
}

/** Grid from a function of (x, y) in mm (row 0 = top edge). */
function gridFrom(nx, ny, widthMm, heightMm, f) {
  const z = new Float32Array(nx * ny);
  for (let r = 0; r < ny; r++) {
    for (let c = 0; c < nx; c++) z[r * nx + c] = f((c / (nx - 1)) * widthMm, heightMm - (r / (ny - 1)) * heightMm);
  }
  return { nx, ny, z };
}

/** Integral of the bilinear (trapezoid) interpolant of a grid over the rectangle. */
function integrate(grid, widthMm, heightMm) {
  const { nx, ny, z } = grid;
  let sum = 0;
  for (let r = 0; r < ny; r++) {
    const wr = r === 0 || r === ny - 1 ? 0.5 : 1;
    for (let c = 0; c < nx; c++) sum += wr * (c === 0 || c === nx - 1 ? 0.5 : 1) * z[r * nx + c];
  }
  return (sum * widthMm * heightMm) / ((nx - 1) * (ny - 1));
}

/** Underside with round magnet pockets, an engraved label block and a pocket cut by the east edge. */
function pocketBottom(nx, ny, widthMm, heightMm, { magnetDepth = 3.2, labelDepth = 0.6 } = {}) {
  const magnets = [[25, 25], [widthMm - 25, 25], [25, heightMm - 25], [widthMm - 25, heightMm - 25]];
  return gridFrom(nx, ny, widthMm, heightMm, (x, y) => {
    if (magnets.some(([mx, my]) => (x - mx) ** 2 + (y - my) ** 2 <= 5.1 ** 2)) return magnetDepth;
    if (Math.abs(x - widthMm / 2) < 15 && Math.abs(y - heightMm / 2) < 6 && Math.round(x * 2) % 3 !== 0) return labelDepth;
    if (x > widthMm - 4 && Math.abs(y - heightMm / 2) < 8) return 1.5; // pocket open to the east wall
    return 0;
  });
}

// ---------------------------------------------------------------------------------------------
// Checks

const SIDE_NORMALS = [
  { on: (x, y, w, h) => y === 0, n: [0, -1, 0] },
  { on: (x, y, w, h) => x === w, n: [1, 0, 0] },
  { on: (x, y, w, h) => y === h, n: [0, 1, 0] },
  { on: (x, y, w, h) => x === 0, n: [-1, 0, 0] },
];

/**
 * Asserts everything a printable solid must satisfy; returns its stats.
 * @param {object} mesh
 * @param {{widthMm:number, heightMm:number, top:object, bottom?:object|null, topToleranceMm?:number,
 *   bottomToleranceMm?:number, volumeRel?:number}} spec
 */
function assertPrintableSolid(mesh, spec) {
  const { widthMm: w, heightMm: h, top, bottom = null, topToleranceMm = 0, bottomToleranceMm = 0.01 } = spec;
  const nv = mesh.positions.length / 3;
  const nt = mesh.indices.length / 3;
  assert.ok(mesh.positions instanceof Float32Array, 'positions are Float32Array');
  assert.ok(mesh.indices instanceof Uint32Array, 'indices are Uint32Array');

  const wt = checkWatertight(mesh);
  assert.deepEqual(wt, { ok: true, boundaryEdges: 0, nonManifoldEdges: 0, inconsistentEdges: 0, degenerateTriangles: 0 });
  assert.equal(nv - nt / 2, 2, 'Euler characteristic V - E + F = 2 (closed, genus 0)');
  assert.equal(countDegenerateTriangles(mesh, 1e-9), 0, 'no zero-area triangles');
  assert.equal(countDuplicateVertices(mesh), 0, 'no duplicated vertex positions');

  const stats = meshStats(mesh);
  assert.ok(stats.volumeMm3 > 0, 'positive volume');
  assert.deepEqual([stats.bbox.min[0], stats.bbox.min[1], stats.bbox.max[0], stats.bbox.max[1]],
    [0, 0, Math.fround(w), Math.fround(h)], 'footprint is exactly the tile rectangle');

  // Face classes: top vertices come first.
  const nTop = triangulateGrid(top.z, top.nx, top.ny, topToleranceMm).coords.length / 2;
  const p = mesh.positions;
  const fw = Math.fround(w);
  const fh = Math.fround(h);
  let walls = 0;
  for (let i = 0; i < mesh.indices.length; i += 3) {
    const a = mesh.indices[i] * 3, b = mesh.indices[i + 1] * 3, c = mesh.indices[i + 2] * 3;
    const ux = p[b] - p[a], uy = p[b + 1] - p[a + 1], uz = p[b + 2] - p[a + 2];
    const vx = p[c] - p[a], vy = p[c + 1] - p[a + 1], vz = p[c + 2] - p[a + 2];
    const n = [uy * vz - uz * vy, uz * vx - ux * vz, ux * vy - uy * vx];
    const side = SIDE_NORMALS.find((s) => [a, b, c].every((k) => s.on(p[k], p[k + 1], fw, fh)));
    if (side) {
      walls++;
      const along = n[0] * side.n[0] + n[1] * side.n[1];
      assert.ok(along > 0, `wall triangle ${i / 3} faces outward (no folded wall)`);
      assert.ok(Math.abs(n[2]) < 1e-9 * along + 1e-12, 'wall triangle is vertical');
    } else if (mesh.indices[i] < nTop && mesh.indices[i + 1] < nTop && mesh.indices[i + 2] < nTop) {
      assert.ok(n[2] > 0, `top triangle ${i / 3} faces up`);
    } else {
      assert.ok(n[2] < 0, `underside triangle ${i / 3} faces down`);
    }
  }
  assert.ok(walls >= 8, 'four walls');

  // Walls are vertical, so the volume is exactly ∫ top surface - ∫ underside of the two
  // piecewise-linear surfaces (up to float32 rounding of the vertex positions).
  const exact = surfaceIntegral(top, w, h, topToleranceMm)
    - (bottom ? surfaceIntegral(bottom, w, h, bottomToleranceMm) : 0);
  assert.ok(Math.abs(stats.volumeMm3 - exact) <= 1e-5 * exact, `volume ${stats.volumeMm3} = surface integral ${exact}`);
  if (spec.volumeRel !== undefined) {
    const expected = integrate(top, w, h) - (bottom ? integrate(bottom, w, h) : 0);
    const rel = Math.abs(stats.volumeMm3 - expected) / expected;
    assert.ok(rel < spec.volumeRel, `volume ${stats.volumeMm3.toFixed(1)} vs integral ${expected.toFixed(1)} (rel ${rel})`);
  }
  return stats;
}

/** Exact integral of the piecewise-linear surface triangulateGrid builds for a grid. */
function surfaceIntegral(grid, widthMm, heightMm, toleranceMm) {
  const { coords, triangles } = triangulateGrid(grid.z, grid.nx, grid.ny, toleranceMm);
  const cell = (widthMm / (grid.nx - 1)) * (heightMm / (grid.ny - 1));
  let sum = 0;
  for (let i = 0; i < triangles.length; i += 3) {
    const [a, b, c] = [triangles[i], triangles[i + 1], triangles[i + 2]];
    const zMean = (grid.z[coords[2 * a + 1] * grid.nx + coords[2 * a]] + grid.z[coords[2 * b + 1] * grid.nx + coords[2 * b]]
      + grid.z[coords[2 * c + 1] * grid.nx + coords[2 * c]]) / 3;
    sum += (gridArea2(coords, a, b, c) / 2) * cell * zMean;
  }
  return sum;
}

/** Signed doubled area of triangle (a, b, c) in artwork grid orientation (x = gx, y = -gy). */
function gridArea2(coords, a, b, c) {
  const ax = coords[2 * a], ay = -coords[2 * a + 1];
  const bx = coords[2 * b], by = -coords[2 * b + 1];
  const cx = coords[2 * c], cy = -coords[2 * c + 1];
  return (bx - ax) * (cy - ay) - (by - ay) * (cx - ax);
}

/** Asserts a triangulation covers the rectangle exactly, CCW, without border T-junctions. */
function assertRectangleTriangulation({ coords, triangles }, nx, ny) {
  assert.ok(coords instanceof Uint32Array && triangles instanceof Uint32Array);
  const nv = coords.length / 2;
  let area2 = 0;
  for (let i = 0; i < triangles.length; i += 3) {
    const s = gridArea2(coords, triangles[i], triangles[i + 1], triangles[i + 2]);
    assert.ok(s > 0, `triangle ${i / 3} is CCW in artwork orientation`);
    area2 += s;
  }
  assert.equal(area2, 2 * (nx - 1) * (ny - 1), 'triangles tile the rectangle exactly');

  // Border edges (used by one triangle) must form one loop through every vertex on the border.
  const uses = new Map();
  for (let i = 0; i < triangles.length; i += 3) {
    for (let k = 0; k < 3; k++) {
      const a = triangles[i + k];
      const b = triangles[i + ((k + 1) % 3)];
      const key = Math.min(a, b) * nv + Math.max(a, b);
      uses.set(key, (uses.get(key) ?? 0) + 1);
    }
  }
  const onBorderEdge = new Set();
  let borderEdges = 0;
  for (const [key, count] of uses) {
    assert.ok(count <= 2, 'interior edges are shared by exactly two triangles');
    if (count === 1) {
      borderEdges++;
      onBorderEdge.add(Math.floor(key / nv));
      onBorderEdge.add(key % nv);
    }
  }
  const onBorder = [];
  for (let v = 0; v < nv; v++) {
    const gx = coords[2 * v];
    const gy = coords[2 * v + 1];
    assert.ok(gx < nx && gy < ny, 'grid coordinates in range');
    if (gx === 0 || gy === 0 || gx === nx - 1 || gy === ny - 1) onBorder.push(v);
  }
  assert.equal(borderEdges, onBorder.length, 'border loop has one edge per border vertex');
  for (const v of onBorder) assert.ok(onBorderEdge.has(v), `border vertex ${v} is a hull vertex (no T-junction)`);
}

/** Max |surface - sample| over all grid samples, by rasterising each triangle. */
function maxApproximationError({ coords, triangles }, z, nx) {
  let worst = 0;
  for (let i = 0; i < triangles.length; i += 3) {
    const [a, b, c] = [triangles[i], triangles[i + 1], triangles[i + 2]];
    const P = [a, b, c].map((v) => [coords[2 * v], coords[2 * v + 1], z[coords[2 * v + 1] * nx + coords[2 * v]]]);
    const det = (P[1][0] - P[0][0]) * (P[2][1] - P[0][1]) - (P[2][0] - P[0][0]) * (P[1][1] - P[0][1]);
    const minX = Math.min(P[0][0], P[1][0], P[2][0]), maxX = Math.max(P[0][0], P[1][0], P[2][0]);
    const minY = Math.min(P[0][1], P[1][1], P[2][1]), maxY = Math.max(P[0][1], P[1][1], P[2][1]);
    for (let y = minY; y <= maxY; y++) {
      for (let x = minX; x <= maxX; x++) {
        const l1 = ((x - P[0][0]) * (P[2][1] - P[0][1]) - (P[2][0] - P[0][0]) * (y - P[0][1])) / det;
        const l2 = ((P[1][0] - P[0][0]) * (y - P[0][1]) - (x - P[0][0]) * (P[1][1] - P[0][1])) / det;
        const l0 = 1 - l1 - l2;
        if (l0 < -1e-12 || l1 < -1e-12 || l2 < -1e-12) continue;
        const zi = l0 * P[0][2] + l1 * P[1][2] + l2 * P[2][2];
        worst = Math.max(worst, Math.abs(zi - z[y * nx + x]));
      }
    }
  }
  return worst;
}

// ---------------------------------------------------------------------------------------------

describe('triangulateGrid', () => {
  test('regular grid: 2 triangles per cell, CCW in artwork orientation, all samples', () => {
    const nx = 7, ny = 5;
    const z = fractalTerrain(nx, ny, { seed: 3 });
    const tin = triangulateGrid(z, nx, ny, 0);
    assert.equal(tin.coords.length, nx * ny * 2);
    assert.equal(tin.triangles.length, (nx - 1) * (ny - 1) * 6);
    for (let v = 0; v < nx * ny; v++) assert.deepEqual([tin.coords[2 * v], tin.coords[2 * v + 1]], [v % nx, Math.floor(v / nx)]);
    assertRectangleTriangulation(tin, nx, ny);
    assert.equal(maxApproximationError(tin, z, nx), 0);
  });

  test('regular grid splits each cell along the diagonal with the smaller height difference', () => {
    // a=0 b=1 / d=2 e=3: |a-e| = 0 < |b-d| = 10 → diagonal a–e; then the opposite case.
    const edges = (tri) => {
      const s = new Set();
      for (let i = 0; i < tri.length; i += 3) {
        for (let k = 0; k < 3; k++) {
          const a = tri[i + k], b = tri[i + ((k + 1) % 3)];
          s.add(`${Math.min(a, b)}-${Math.max(a, b)}`);
        }
      }
      return s;
    };
    const ae = triangulateGrid(new Float32Array([5, 10, 0, 5]), 2, 2, 0);
    assert.ok(edges(ae.triangles).has('0-3') && !edges(ae.triangles).has('1-2'));
    const bd = triangulateGrid(new Float32Array([0, 5, 5, 10]), 2, 2, 0);
    assert.ok(edges(bd.triangles).has('1-2') && !edges(bd.triangles).has('0-3'));
    // Along a ridge the diagonal follows the ridge instead of cutting it.
    const ridge = gridFrom(9, 9, 8, 8, (x, y) => 10 - Math.abs(x - y));
    const tin = triangulateGrid(ridge.z, 9, 9, 0);
    assert.equal(maxApproximationError(tin, ridge.z, 9), 0);
  });

  test('tolerance <= 0, NaN or undefined means full grid', () => {
    const z = fractalTerrain(6, 4);
    for (const tol of [0, -1, Number.NaN, undefined]) {
      assert.equal(triangulateGrid(z, 6, 4, tol).triangles.length, 5 * 3 * 6);
    }
  });

  for (const tol of [0.01, 0.1, 1]) {
    test(`Delatin ${tol} mm: valid CCW cover of the rectangle, no border T-junctions, error <= tolerance`, () => {
      const nx = 161, ny = 97;
      const z = fractalTerrain(nx, ny, { seed: 11, octaves: 8 });
      const tin = triangulateGrid(z, nx, ny, tol);
      assertRectangleTriangulation(tin, nx, ny);
      assert.ok(tin.triangles.length / 3 < 2 * (nx - 1) * (ny - 1), 'fewer triangles than the full grid');
      assert.ok(maxApproximationError(tin, z, nx) <= tol + 1e-6);
    });
  }

  test('Delatin keeps flat areas coarse and inserts border samples into border edges', () => {
    const nx = 65, ny = 33;
    // Flat plate with a cliff touching the north and south borders.
    const z = new Float32Array(nx * ny).fill(2);
    for (let r = 0; r < ny; r++) for (let c = 40; c < nx; c++) z[r * nx + c] = 9;
    const tin = triangulateGrid(z, nx, ny, 0.05);
    assertRectangleTriangulation(tin, nx, ny);
    assert.ok(maxApproximationError(tin, z, nx) < 1e-9);
    assert.ok(tin.triangles.length / 3 < 200, `flat areas stay coarse (${tin.triangles.length / 3} triangles)`);
    assert.equal(triangulateGrid(new Float32Array(nx * ny).fill(4), nx, ny, 0.01).triangles.length, 6, 'flat grid → 2 triangles');
  });

  test('rejects invalid grids', () => {
    assert.throws(() => triangulateGrid(new Float32Array(3), 3, 1, 0), RangeError);
    assert.throws(() => triangulateGrid(new Float32Array(5), 2, 2, 0), RangeError);
    assert.throws(() => triangulateGrid(new Float32Array(4), 2.5, 2, 0), RangeError);
  });
});

describe('buildSolid', () => {
  test('flat box: exact volume, area, bounding box and triangle count', () => {
    const top = { nx: 3, ny: 4, z: new Float32Array(12).fill(5) };
    const mesh = buildSolid({ top, bottom: null, widthMm: 20, heightMm: 30 });
    const stats = assertPrintableSolid(mesh, { widthMm: 20, heightMm: 30, top });
    assert.ok(Math.abs(stats.volumeMm3 - 3000) < 1e-9);
    assert.ok(Math.abs(stats.areaMm2 - 1700) < 1e-9);
    assert.deepEqual(stats.bbox, { min: [0, 0, 0], max: [20, 30, 5] });
    // top 12 + flat bottom 2 (4 corners only) + walls (3+2-2)*2 + (4+2-2)*2
    assert.equal(stats.triangles, 12 + 2 + 6 + 8);
    assert.equal(stats.vertices, 12 + 4);
    assert.equal(mesh.water, undefined);
  });

  for (const tol of [0, 0.01, 0.1, 1]) {
    test(`fractal terrain, top tolerance ${tol} mm: watertight, outward, volume = integral`, () => {
      const nx = 241, ny = 161;
      const top = { nx, ny, z: fractalTerrain(nx, ny, { seed: 7, octaves: 8 }) };
      const spec = { widthMm: 120, heightMm: 80, top, topToleranceMm: tol, volumeRel: 0.005 };
      const mesh = buildSolid({ top, widthMm: 120, heightMm: 80, topToleranceMm: tol });
      assertPrintableSolid(mesh, spec);
    });
  }

  test('terraces and cliffs (exact flat runs and vertical-ish steps on the border)', () => {
    const nx = 181, ny = 121;
    const base = fractalTerrain(nx, ny, { seed: 5, octaves: 6, minMm: 2, maxMm: 30 });
    const terraced = base.map((v) => 2 + Math.floor((v - 2) / 2.4) * 2.4);
    const cliffs = gridFrom(nx, ny, 90, 60, (x, y) => (x > 30 && x < 60) || y > 45 ? 25 : 1.2);
    for (const z of [terraced, cliffs.z]) {
      const top = { nx, ny, z };
      for (const tol of [0, 0.05]) {
        const mesh = buildSolid({ top, widthMm: 90, heightMm: 60, topToleranceMm: tol });
        assertPrintableSolid(mesh, { widthMm: 90, heightMm: 60, top, topToleranceMm: tol, volumeRel: 0.005 });
      }
    }
  });

  test('walls stay unfolded where a flat 4-corner underside faces spikes and ramps on the border', () => {
    // A naive zipper fans every top border segment to a bottom corner; tall spikes near the
    // corners and ramps pointing at a corner make such fans overlap or degenerate.
    const w = 40, h = 30, nx = 81, ny = 61;
    const top = gridFrom(nx, ny, w, h, (x, y) => {
      const ramp = Math.max(1, x, y);                 // collinear with the bottom corner (0, 0, 0)
      const spike = Math.abs(x - 3) < 0.6 || Math.abs(y - 27) < 0.6 ? 60 : 0;
      return Math.max(ramp, spike, 40 - x > 0 && x > 36 ? 80 - 2 * x : 0);
    });
    for (const tol of [0, 0.01]) {
      const mesh = buildSolid({ top, widthMm: w, heightMm: h, topToleranceMm: tol });
      assertPrintableSolid(mesh, { widthMm: w, heightMm: h, top, topToleranceMm: tol, volumeRel: 0.005 });
    }
  });

  test('underside with pockets at a different resolution than the top', () => {
    const w = 120, h = 80;
    const top = { nx: 241, ny: 161, z: fractalTerrain(241, 161, { seed: 9, minMm: 4, maxMm: 25 }) };
    const bottom = pocketBottom(481, 321, w, h);
    for (const [topTol, botTol] of [[0, 0], [0.02, 0.01], [0.5, 0.01]]) {
      const mesh = buildSolid({ top, bottom, widthMm: w, heightMm: h, topToleranceMm: topTol, bottomToleranceMm: botTol });
      const stats = assertPrintableSolid(mesh, {
        widthMm: w, heightMm: h, top, bottom, topToleranceMm: topTol, bottomToleranceMm: botTol, volumeRel: 0.005,
      });
      assert.equal(stats.bbox.min[2], 0);
    }
    // A coarser underside than the top works as well.
    const coarse = pocketBottom(61, 41, w, h);
    const mesh = buildSolid({ top, bottom: coarse, widthMm: w, heightMm: h, bottomToleranceMm: 0 });
    assertPrintableSolid(mesh, { widthMm: w, heightMm: h, top, bottom: coarse, bottomToleranceMm: 0, volumeRel: 0.005 });
  });

  test('very thin solids (0.05 mm) stay valid', () => {
    const w = 30, h = 20;
    const thinTop = gridFrom(31, 21, w, h, (x, y) => 0.05 + 0.01 * Math.sin(x) * Math.cos(y));
    assertPrintableSolid(buildSolid({ top: thinTop, widthMm: w, heightMm: h }),
      { widthMm: w, heightMm: h, top: thinTop, volumeRel: 0.005 });
    // 0.05 mm left above a 3.2 mm pocket, the pocket reaching the border.
    const top = { nx: 31, ny: 21, z: new Float32Array(31 * 21).fill(3.25) };
    const bottom = gridFrom(61, 41, w, h, (x, y) => (x > 10 ? 3.2 : 0));
    const mesh = buildSolid({ top, bottom, widthMm: w, heightMm: h, bottomToleranceMm: 0 });
    const stats = assertPrintableSolid(mesh, { widthMm: w, heightMm: h, top, bottom, bottomToleranceMm: 0, volumeRel: 0.005 });
    assert.ok(stats.volumeMm3 > 0 && stats.volumeMm3 < w * h * 3.25);
  });

  test('2 x 2 grids and extreme aspect ratios (3 x 500 samples)', () => {
    const tiny = { nx: 2, ny: 2, z: new Float32Array([1, 2, 3, 4]) };
    let mesh = buildSolid({ top: tiny, widthMm: 5, heightMm: 7 });
    assertPrintableSolid(mesh, { widthMm: 5, heightMm: 7, top: tiny, volumeRel: 1e-9 });
    assert.equal(mesh.indices.length / 3, 2 + 2 + 4 * 2);
    const tinyBottom = { nx: 2, ny: 2, z: new Float32Array([0.5, 0, 0, 0.5]) };
    mesh = buildSolid({ top: tiny, bottom: tinyBottom, widthMm: 5, heightMm: 7 });
    assertPrintableSolid(mesh, { widthMm: 5, heightMm: 7, top: tiny, bottom: tinyBottom });

    for (const [nx, ny, w, h] of [[3, 500, 1.2, 400], [500, 3, 400, 1.2]]) {
      const top = { nx, ny, z: fractalTerrain(nx, ny, { seed: nx, octaves: 6 }) };
      for (const tol of [0, 0.1]) {
        const m = buildSolid({ top, widthMm: w, heightMm: h, topToleranceMm: tol });
        assertPrintableSolid(m, { widthMm: w, heightMm: h, top, topToleranceMm: tol, volumeRel: 0.005 });
      }
      const bottom = gridFrom(nx, ny, w, h, (x, y) => ((x + y) % 50 < 10 ? 1 : 0));
      const m = buildSolid({ top, bottom, widthMm: w, heightMm: h, bottomToleranceMm: 0 });
      assertPrintableSolid(m, { widthMm: w, heightMm: h, top, bottom, bottomToleranceMm: 0, volumeRel: 0.005 });
    }
  });

  test('non-square tile with grid spacing that is not representable in binary', () => {
    const w = 246.3, h = 123.7;
    const top = { nx: 617, ny: 311, z: fractalTerrain(617, 311, { seed: 21, octaves: 7 }) };
    const mesh = buildSolid({ top, widthMm: w, heightMm: h, topToleranceMm: 0.02 });
    assertPrintableSolid(mesh, { widthMm: w, heightMm: h, top, topToleranceMm: 0.02, volumeRel: 0.005 });
  });

  test('water flags: one per vertex, copied from the top samples, 0 elsewhere', () => {
    const nx = 41, ny = 31;
    const top = { nx, ny, z: fractalTerrain(nx, ny, { seed: 2 }) };
    const topWater = new Uint8Array(nx * ny);
    for (let r = 10; r < 20; r++) for (let c = 0; c < 15; c++) topWater[r * nx + c] = 1;
    for (let r = 10; r < 20; r++) for (let c = 0; c < 15; c++) top.z[r * nx + c] = 4; // flat lake
    for (const tol of [0, 0.05]) {
      const mesh = buildSolid({ top, bottom: pocketBottom(81, 61, 40, 30), widthMm: 40, heightMm: 30, topToleranceMm: tol, topWater });
      assert.ok(mesh.water instanceof Uint8Array);
      assert.equal(mesh.water.length, mesh.positions.length / 3);
      const tin = triangulateGrid(top.z, nx, ny, tol);
      const nTop = tin.coords.length / 2;
      for (let v = 0; v < mesh.water.length; v++) {
        const expected = v < nTop ? topWater[tin.coords[2 * v + 1] * nx + tin.coords[2 * v]] : 0;
        assert.equal(mesh.water[v], expected);
      }
      assert.ok(mesh.water.some((f) => f === 1));
    }
  });

  test('rejects bad sizes and mismatched water flags', () => {
    const top = { nx: 2, ny: 2, z: new Float32Array(4).fill(1) };
    assert.throws(() => buildSolid({ top, widthMm: 0, heightMm: 5 }), RangeError);
    assert.throws(() => buildSolid({ top, widthMm: 5, heightMm: Number.NaN }), RangeError);
    assert.throws(() => buildSolid({ top, widthMm: 5, heightMm: 5, topWater: new Uint8Array(3) }), RangeError);
    assert.throws(() => buildSolid({ top: { nx: 2, ny: 2, z: new Float32Array(3) }, widthMm: 5, heightMm: 5 }), RangeError);
  });
});

describe('analyze', () => {
  // Unit cube, outward CCW.
  const cube = () => ({
    positions: new Float32Array([0, 0, 0, 1, 0, 0, 1, 1, 0, 0, 1, 0, 0, 0, 1, 1, 0, 1, 1, 1, 1, 0, 1, 1]),
    indices: new Uint32Array([
      0, 2, 1, 0, 3, 2, // bottom
      4, 5, 6, 4, 6, 7, // top
      0, 1, 5, 0, 5, 4, // y = 0
      1, 2, 6, 1, 6, 5, // x = 1
      2, 3, 7, 2, 7, 6, // y = 1
      3, 0, 4, 3, 4, 7, // x = 0
    ]),
  });

  test('meshStats of a unit cube (and its inside-out twin)', () => {
    const stats = meshStats(cube());
    assert.equal(stats.triangles, 12);
    assert.equal(stats.vertices, 8);
    assert.ok(Math.abs(stats.volumeMm3 - 1) < 1e-12);
    assert.ok(Math.abs(stats.areaMm2 - 6) < 1e-12);
    assert.deepEqual(stats.bbox, { min: [0, 0, 0], max: [1, 1, 1] });
    const flipped = cube();
    for (let i = 0; i < flipped.indices.length; i += 3) [flipped.indices[i + 1], flipped.indices[i + 2]] = [flipped.indices[i + 2], flipped.indices[i + 1]];
    assert.ok(Math.abs(meshStats(flipped).volumeMm3 + 1) < 1e-12);
    assert.equal(checkWatertight(flipped).ok, true, 'consistently inside-out is still closed');
    assert.deepEqual(meshStats({ positions: new Float32Array(0), indices: new Uint32Array(0) }).bbox, { min: [0, 0, 0], max: [0, 0, 0] });
  });

  test('checkWatertight finds holes, flipped faces, non-manifold edges and degenerate triangles', () => {
    assert.equal(checkWatertight(cube()).ok, true);

    const holed = cube();
    holed.indices = holed.indices.slice(3);
    assert.deepEqual(checkWatertight(holed), { ok: false, boundaryEdges: 3, nonManifoldEdges: 0, inconsistentEdges: 0, degenerateTriangles: 0 });

    const flipped = cube();
    [flipped.indices[1], flipped.indices[2]] = [flipped.indices[2], flipped.indices[1]];
    assert.deepEqual(checkWatertight(flipped), { ok: false, boundaryEdges: 0, nonManifoldEdges: 0, inconsistentEdges: 3, degenerateTriangles: 0 });

    const doubled = cube();
    doubled.indices = Uint32Array.from([...doubled.indices, 0, 2, 1]);
    const d = checkWatertight(doubled);
    assert.equal(d.ok, false);
    assert.equal(d.nonManifoldEdges, 3);

    const degenerate = cube();
    degenerate.indices = Uint32Array.from([...degenerate.indices, 0, 0, 1]);
    assert.equal(checkWatertight(degenerate).degenerateTriangles, 1);
    assert.equal(checkWatertight(degenerate).ok, false);
  });

  test('countDegenerateTriangles and countDuplicateVertices', () => {
    const m = cube();
    assert.equal(countDegenerateTriangles(m), 0);
    assert.equal(countDuplicateVertices(m), 0);
    m.positions[6 * 3] = 1; m.positions[6 * 3 + 1] = 0; m.positions[6 * 3 + 2] = 1; // vertex 6 := vertex 5
    assert.equal(countDuplicateVertices(m), 1);
    assert.ok(countDegenerateTriangles(m) >= 2);
  });
});

describe('STL', () => {
  const terrainSolid = () => {
    const top = { nx: 121, ny: 81, z: fractalTerrain(121, 81, { seed: 4 }) };
    return buildSolid({ top, bottom: pocketBottom(97, 65, 60, 40), widthMm: 60, heightMm: 40, topToleranceMm: 0.02 });
  };

  test('binary layout: header with name, little-endian count, 50 bytes per facet, unit outward normals', () => {
    const mesh = terrainSolid();
    const n = mesh.indices.length / 3;
    const buf = writeBinarySTL(mesh, 'Alps A1');
    assert.ok(buf instanceof ArrayBuffer);
    assert.equal(buf.byteLength, 84 + 50 * n);
    const header = new TextDecoder().decode(new Uint8Array(buf, 0, 80));
    assert.ok(header.includes('Alps A1'));
    assert.ok(!header.toLowerCase().startsWith('solid'), 'binary header must not look like ASCII STL');
    const view = new DataView(buf);
    assert.equal(view.getUint32(80, true), n);
    const p = mesh.positions;
    for (let t = 0; t < n; t += 97) {
      const o = 84 + 50 * t;
      const nrm = [0, 4, 8].map((k) => view.getFloat32(o + k, true));
      assert.ok(Math.abs(Math.hypot(...nrm) - 1) < 1e-5, 'unit normal');
      const [a, b, c] = [0, 1, 2].map((k) => mesh.indices[3 * t + k] * 3);
      assert.deepEqual([12, 16, 20].map((k) => view.getFloat32(o + k, true)), [p[a], p[a + 1], p[a + 2]]);
      const u = [p[b] - p[a], p[b + 1] - p[a + 1], p[b + 2] - p[a + 2]];
      const v = [p[c] - p[a], p[c + 1] - p[a + 1], p[c + 2] - p[a + 2]];
      const cross = [u[1] * v[2] - u[2] * v[1], u[2] * v[0] - u[0] * v[2], u[0] * v[1] - u[1] * v[0]];
      assert.ok(cross[0] * nrm[0] + cross[1] * nrm[1] + cross[2] * nrm[2] > 0, 'normal agrees with winding');
      assert.equal(view.getUint16(o + 48, true), 0);
    }
  });

  test('round trip: same triangles, vertices, topology and volume', () => {
    const mesh = terrainSolid();
    const parsed = parseBinarySTL(writeBinarySTL(mesh, 'round trip'));
    assert.equal(parsed.indices.length, mesh.indices.length);
    assert.equal(parsed.positions.length, mesh.positions.length, 'shared corners are merged back');
    assert.ok(parsed.header.endsWith('round trip'));
    for (let i = 0; i < mesh.indices.length; i++) {
      const a = mesh.indices[i] * 3;
      const b = parsed.indices[i] * 3;
      assert.ok(mesh.positions[a] === parsed.positions[b] && mesh.positions[a + 1] === parsed.positions[b + 1]
        && mesh.positions[a + 2] === parsed.positions[b + 2]);
    }
    assert.equal(checkWatertight(parsed).ok, true);
    assert.ok(Math.abs(meshStats(parsed).volumeMm3 - meshStats(mesh).volumeMm3) < 1e-6);
  });

  test('parser accepts typed-array views, rejects truncated files; long / non-ASCII names are safe', () => {
    const mesh = buildSolid({ top: { nx: 2, ny: 2, z: new Float32Array(4).fill(1) }, widthMm: 1, heightMm: 1 });
    const buf = writeBinarySTL(mesh, `Zürich ${'x'.repeat(200)}`);
    const header = new Uint8Array(buf, 0, 80);
    assert.ok(header.every((b) => b >= 0x20 && b < 0x7f));
    const padded = new Uint8Array(buf.byteLength + 16);
    padded.set(new Uint8Array(buf), 8);
    const parsed = parseBinarySTL(padded.subarray(8, 8 + buf.byteLength));
    assert.equal(parsed.indices.length, mesh.indices.length);
    assert.throws(() => parseBinarySTL(buf.slice(0, buf.byteLength - 1)), RangeError);
    assert.throws(() => parseBinarySTL(new ArrayBuffer(20)), RangeError);
    assert.equal(writeBinarySTL({ positions: new Float32Array(0), indices: new Uint32Array(0) }).byteLength, 84);
  });
});

describe('3MF', () => {
  /** Parses vertices/triangles of every <object> in a 3MF model. */
  function parseModel(xml) {
    const objects = [];
    for (const m of xml.matchAll(/<object id="(\d+)" type="model" name="([^"]*)">([\s\S]*?)<\/object>/g)) {
      const vertices = [...m[3].matchAll(/<vertex x="([^"]+)" y="([^"]+)" z="([^"]+)"\/>/g)].flatMap((v) => v.slice(1, 4).map(Number));
      const triangles = [...m[3].matchAll(/<triangle v1="(\d+)" v2="(\d+)" v3="(\d+)"\/>/g)].flatMap((t) => t.slice(1, 4).map(Number));
      objects.push({ id: Number(m[1]), name: m[2], mesh: { positions: Float32Array.from(vertices), indices: Uint32Array.from(triangles) } });
    }
    return objects;
  }

  const tile = (seed) => {
    const top = { nx: 61, ny: 41, z: fractalTerrain(61, 41, { seed }) };
    return buildSolid({ top, widthMm: 60, heightMm: 40, topToleranceMm: 0.05 });
  };

  test('valid package: content types, root relationship, millimetre model with all vertices and triangles', () => {
    const mesh = tile(1);
    const zip = write3MF([{ name: 'Alps A1', mesh }], { title: 'The Alps <A1> & "friends"' });
    assert.ok(zip instanceof Uint8Array);
    assert.deepEqual([zip[0], zip[1], zip[2], zip[3]], [0x50, 0x4b, 0x03, 0x04], 'zip signature');
    const files = unzipSync(zip);
    assert.deepEqual(Object.keys(files).sort(), ['3D/3dmodel.model', '[Content_Types].xml', '_rels/.rels']);
    const types = strFromU8(files['[Content_Types].xml']);
    assert.match(types, /Extension="rels" ContentType="application\/vnd\.openxmlformats-package\.relationships\+xml"/);
    assert.match(types, /Extension="model" ContentType="application\/vnd\.ms-package\.3dmanufacturing-3dmodel\+xml"/);
    const rels = strFromU8(files['_rels/.rels']);
    assert.match(rels, /Target="\/3D\/3dmodel\.model"/);
    assert.match(rels, /Type="http:\/\/schemas\.microsoft\.com\/3dmanufacturing\/2013\/01\/3dmodel"/);

    const xml = strFromU8(files['3D/3dmodel.model']);
    assert.match(xml, /^<\?xml version="1\.0" encoding="UTF-8"\?>/);
    assert.match(xml, /<model unit="millimeter" xml:lang="en-US" xmlns="http:\/\/schemas\.microsoft\.com\/3dmanufacturing\/core\/2015\/02">/);
    assert.match(xml, /<metadata name="Title">The Alps &lt;A1&gt; &amp; &quot;friends&quot;<\/metadata>/);
    assert.match(xml, /<build>\s*<item objectid="1"\/>\s*<\/build>/);
    assert.ok(!/\d\.\d{5,}/.test(xml), 'numbers have at most 4 decimals');

    const [obj] = parseModel(xml);
    assert.equal(obj.name, 'Alps A1');
    assert.equal(obj.mesh.positions.length, mesh.positions.length);
    assert.equal(obj.mesh.indices.length, mesh.indices.length);
    assert.deepEqual(obj.mesh.indices, mesh.indices);
    for (let i = 0; i < mesh.positions.length; i++) assert.ok(Math.abs(obj.mesh.positions[i] - mesh.positions[i]) <= 5.1e-5);
    assert.equal(checkWatertight(obj.mesh).ok, true);
    const v0 = meshStats(mesh).volumeMm3;
    assert.ok(Math.abs(meshStats(obj.mesh).volumeMm3 - v0) / v0 < 1e-4);
  });

  test('numbers are written compactly: rounded to 4 decimals, no trailing zeros, no -0', () => {
    const values = [0, -0, 1, -1, 0.5, 0.30000001, 245.99998, 246, 0.00004, -0.00004, -0.00006, 0.0001, 0.0123,
      123.45675, 12345.6789, -987.6543, 3.1415926, 1e-7, 99999.99996, 7.25, 0.1, 0.2, 1000000, -2.00005];
    const positions = Float32Array.from(values);
    const mesh = { positions, indices: new Uint32Array([0, 1, 2, 5, 4, 7]) };
    const xml = strFromU8(unzipSync(write3MF([{ name: 'n', mesh }]))['3D/3dmodel.model']);
    const written = [...xml.matchAll(/<vertex x="([^"]+)" y="([^"]+)" z="([^"]+)"\/>/g)].flatMap((m) => m.slice(1, 4));
    const reference = (v) => {
      const r = Math.round(v * 1e4) / 1e4;
      return r === 0 ? '0' : String(r);
    };
    assert.deepEqual(written, Array.from(positions, reference));
    assert.ok(written.every((t) => /^-?\d+(\.\d{0,3}[1-9])?$/.test(t)), written.join(' '));
    const triangles = [...xml.matchAll(/<triangle v1="(\d+)" v2="(\d+)" v3="(\d+)"\/>/g)].flatMap((m) => m.slice(1, 4).map(Number));
    assert.deepEqual(triangles, [...mesh.indices]);

    const broken = { positions: new Float32Array([0, 0, 0, 1, 0, Number.NaN, 0, 1, 0]), indices: new Uint32Array([0, 1, 2]) };
    assert.throws(() => write3MF([{ name: 'nan', mesh: broken }]), RangeError);
    assert.throws(() => write3MF([{ name: 'oob', mesh: { positions: new Float32Array(9), indices: new Uint32Array([0, 1, 3]) } }]), RangeError);
    assert.throws(() => write3MF([{ name: 'len', mesh: { positions: new Float32Array(10), indices: new Uint32Array([0, 1, 2]) } }]), RangeError);
  });

  test('several objects get one build item each, laid out side by side unless a transform is given', () => {
    const files = unzipSync(write3MF([
      { name: 'A1', mesh: tile(1) },
      { name: 'A2', mesh: tile(2) },
      { name: 'B1', mesh: tile(3), transform: [1, 0, 0, 0, 1, 0, 0, 0, 1, 0, -50.5, 0] },
    ]));
    const xml = strFromU8(files['3D/3dmodel.model']);
    assert.deepEqual(parseModel(xml).map((o) => [o.id, o.name]), [[1, 'A1'], [2, 'A2'], [3, 'B1']]);
    const items = [...xml.matchAll(/<item objectid="(\d+)"(?: transform="([^"]+)")?\/>/g)].map((m) => [Number(m[1]), m[2]]);
    assert.deepEqual(items, [[1, undefined], [2, '1 0 0 0 1 0 0 0 1 65 0 0'], [3, '1 0 0 0 1 0 0 0 1 0 -50.5 0']]);
    assert.throws(() => write3MF([{ name: 'x', mesh: tile(1), transform: [1, 2] }]), RangeError);
    assert.throws(() => write3MF([]), RangeError);
  });

  test('colour changes (experimental): PrusaSlicer custom G-code list, sorted, at the first new layer', () => {
    const zip = write3MF([{ name: 'A1', mesh: tile(1) }], {
      title: 'bands',
      colorChanges: [{ zMm: 4.2, color: '#f4f4f1' }, { zMm: 1.8, color: '#5a6' }],
      layerHeightMm: 0.2,
    });
    const files = unzipSync(zip);
    const xml = strFromU8(files['Metadata/Prusa_Slicer_custom_gcode_per_print_z.xml']);
    assert.match(xml, /^<\?xml version="1\.0" encoding="utf-8"\?>\n<custom_gcodes_per_print_z>\n/);
    const codes = [...xml.matchAll(/<code print_z="([^"]+)" type="0" extruder="1" color="([^"]+)" extra="" gcode="M600"\/>/g)]
      .map((m) => [Number(m[1]), m[2]]);
    assert.deepEqual(codes, [[2, '#55AA66'], [4.4, '#F4F4F1']]);
    assert.match(xml, /<mode value="SingleExtruder"\/>\n<\/custom_gcodes_per_print_z>/);
    assert.match(strFromU8(files['[Content_Types].xml']), /Extension="xml" ContentType="application\/xml"/);

    // Without a layer height the change lands just above zMm (PrusaSlicer picks the next layer).
    assert.match(prusaColorChangesXml([{ zMm: 1.8, color: '#123456' }]), /print_z="1\.81"/);
    assert.throws(() => prusaColorChangesXml([{ zMm: 1, color: 'green' }]), RangeError);
    assert.throws(() => prusaColorChangesXml([{ zMm: Number.NaN, color: '#fff' }]), RangeError);

    const plain = unzipSync(write3MF([{ name: 'A1', mesh: tile(1) }], { colorChanges: [] }));
    assert.equal(plain['Metadata/Prusa_Slicer_custom_gcode_per_print_z.xml'], undefined);
    assert.doesNotMatch(strFromU8(plain['[Content_Types].xml']), /Extension="xml"/);
  });
});
