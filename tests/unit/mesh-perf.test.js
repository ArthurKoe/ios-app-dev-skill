// Performance guard for export-sized meshes: a 1001 x 1001 sample tile (0.25 mm spacing on a
// 250 mm tile) simplified with Delatin, plus STL / 3MF writing of the 2 M triangle full grid.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { unzipSync } from '../../app/vendor/fflate/fflate.js';
import { buildSolid } from '../../app/js/mesh/solid.js';
import { checkWatertight, meshStats } from '../../app/js/mesh/analyze.js';
import { writeBinarySTL } from '../../app/js/mesh/stl.js';
import { write3MF } from '../../app/js/mesh/threemf.js';

const N = 1001;
const SIZE_MM = 250;

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

/** Square fBm value-noise terrain, 8 octaves, scaled to 3..28 mm. */
function fractalTerrain(n, seed) {
  const rnd = rng(seed);
  const acc = new Float64Array(n * n);
  let amp = 1;
  for (let o = 0, cells = 3; o < 8; o++, cells *= 2, amp *= 0.5) {
    const l = cells + 2;
    const lattice = Float64Array.from({ length: l * l }, () => rnd() * 2 - 1);
    const off = [rnd(), rnd()];
    for (let r = 0; r < n; r++) {
      const fy = (r / (n - 1)) * cells + off[1];
      const iy = Math.floor(fy);
      const ty = (fy - iy) ** 2 * (3 - 2 * (fy - iy));
      for (let c = 0; c < n; c++) {
        const fx = (c / (n - 1)) * cells + off[0];
        const ix = Math.floor(fx);
        const tx = (fx - ix) ** 2 * (3 - 2 * (fx - ix));
        const i0 = iy * l + ix;
        acc[r * n + c] += amp * ((lattice[i0] * (1 - tx) + lattice[i0 + 1] * tx) * (1 - ty)
          + (lattice[i0 + l] * (1 - tx) + lattice[i0 + l + 1] * tx) * ty);
      }
    }
  }
  let lo = Infinity;
  let hi = -Infinity;
  for (const v of acc) {
    lo = Math.min(lo, v);
    hi = Math.max(hi, v);
  }
  return Float32Array.from(acc, (v) => 3 + ((v - lo) / (hi - lo)) * 25);
}

function timed(label, fn) {
  const t0 = performance.now();
  const result = fn();
  const ms = performance.now() - t0;
  console.log(`  ${label}: ${ms.toFixed(0)} ms`);
  return { result, ms };
}

test(`${N} x ${N} fractal terrain: Delatin 0.02 mm under 20 s, fewer triangles, watertight; big STL / 3MF`, () => {
  const top = { nx: N, ny: N, z: fractalTerrain(N, 42) };

  const full = timed('buildSolid (full grid)', () => buildSolid({ top, widthMm: SIZE_MM, heightMm: SIZE_MM }));
  const fullTriangles = full.result.indices.length / 3;
  assert.ok(fullTriangles > 2 * (N - 1) * (N - 1));

  const simplified = timed('buildSolid (Delatin 0.02 mm)', () => buildSolid({
    top, widthMm: SIZE_MM, heightMm: SIZE_MM, topToleranceMm: 0.02,
  }));
  const triangles = simplified.result.indices.length / 3;
  console.log(`  ${triangles.toLocaleString('en')} triangles (full grid ${fullTriangles.toLocaleString('en')}, `
    + `${((100 * triangles) / fullTriangles).toFixed(1)} %)`);
  assert.ok(simplified.ms < 20_000, `Delatin solid took ${simplified.ms.toFixed(0)} ms`);
  assert.ok(triangles < fullTriangles, 'simplification reduces the triangle count');

  assert.equal(checkWatertight(simplified.result).ok, true);
  const check = timed('checkWatertight (full grid)', () => checkWatertight(full.result));
  assert.equal(check.result.ok, true);
  const vSimplified = meshStats(simplified.result).volumeMm3;
  const vFull = meshStats(full.result).volumeMm3;
  assert.ok(Math.abs(vSimplified - vFull) / vFull < 0.001, 'simplification keeps the volume');

  const stl = timed(`writeBinarySTL (${fullTriangles.toLocaleString('en')} triangles)`, () => writeBinarySTL(full.result, 'perf'));
  assert.equal(stl.result.byteLength, 84 + 50 * fullTriangles);
  assert.ok(stl.ms < 10_000);

  const threeMF = timed(`write3MF (${fullTriangles.toLocaleString('en')} triangles)`, () => write3MF([{ name: 'perf', mesh: full.result }]));
  console.log(`  3MF size ${(threeMF.result.length / 1e6).toFixed(1)} MB`);
  assert.ok(threeMF.ms < 30_000);
  const model = unzipSync(threeMF.result, { filter: (f) => f.name === '3D/3dmodel.model' })['3D/3dmodel.model'];
  assert.equal(countOccurrences(model, '<triangle '), fullTriangles, 'every triangle is in the model');
  assert.equal(countOccurrences(model, '<vertex '), full.result.positions.length / 3, 'every vertex is in the model');
});

/** Counts occurrences of an ASCII needle in a byte array. */
function countOccurrences(bytes, needle) {
  const codes = Array.from(needle, (ch) => ch.charCodeAt(0));
  let count = 0;
  outer: for (let i = bytes.indexOf(codes[0]); i !== -1; i = bytes.indexOf(codes[0], i + 1)) {
    for (let k = 1; k < codes.length; k++) if (bytes[i + k] !== codes[k]) continue outer;
    count++;
  }
  return count;
}
