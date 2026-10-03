// Unit tests: model/layout.js, model/zmap.js, model/filters.js, model/tiles.js
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { computeLayout, fitTileToBed, exportResolutionMm } from '../../app/js/model/layout.js';
import { computeZMap, zTop, elevationToZ, autoExaggeration } from '../../app/js/model/zmap.js';
import { gaussianBlur, gaussianKernel, hillshade, gradientMagnitude } from '../../app/js/model/filters.js';
import { extractTileFields, tileLabel } from '../../app/js/model/tiles.js';

/** Self-contained project with the documented defaults (docs/ARCHITECTURE.md). */
function makeProject(patch = {}) {
  const base = {
    frame: { lat: 45.95, lon: 10.75, widthKm: 900, heightKm: 450, rotationDeg: 0 },
    printer: { presetId: 'bambu-x1', bedW: 256, bedH: 256, maxZ: 250, nozzleMm: 0.4 },
    layout: { cols: 4, rows: 2, tileW: 246, tileH: 246 },
    relief: {
      exaggeration: 4, autoExaggeration: false, targetReliefMm: 25, baseMm: 3,
      floor: { mode: 'auto', elevationM: 0 }, smoothingMm: 0.4, resolutionMm: 0.4, simplifyMm: 0.02,
      water: { mode: 'recess', depthMm: 0.6 }, maxHeightMm: 0,
    },
    style: { id: 'classic', params: {} },
    border: { enabled: false, widthMm: 6, heightMm: 2 },
    colors: { layerHeightMm: 0.2, firstLayerMm: 0.2 },
    back: { labels: true, labelDepthMm: 0.6, magnets: { enabled: false, diameterMm: 10.2, depthMm: 3.2, perTile: 4, insetMm: 25 } },
  };
  return merge(base, patch);
}

function merge(target, patch) {
  for (const [k, v] of Object.entries(patch)) {
    if (v && typeof v === 'object' && !Array.isArray(v) && target[k] && typeof target[k] === 'object') merge(target[k], v);
    else target[k] = v;
  }
  return target;
}

const close = (a, b, eps = 1e-9, msg) => assert.ok(Math.abs(a - b) <= eps, msg ?? `${a} ≉ ${b}`);

// ------------------------------------------------------------------------------------ layout

test('computeLayout: default Alps project', () => {
  const L = computeLayout(makeProject(), 0.4);
  assert.equal(L.cols, 4);
  assert.equal(L.rows, 2);
  assert.equal(L.artW, 984);
  assert.equal(L.artH, 492);
  close(L.scaleMPerMm, 900000 / 984);
  assert.equal(L.scaleDenominator, Math.round((900000 / 984) * 1000));
  assert.equal(L.spx, 615);
  assert.equal(L.spy, 615);
  assert.equal(L.nx, 4 * 615 + 1);
  assert.equal(L.ny, 2 * 615 + 1);
  close(L.dx, 246 / 615);
  close(L.dy, 246 / 615);
  assert.equal(L.fitsBed, true);
  assert.equal(L.rotateOnBed, false);
  assert.deepEqual(L.warnings, []);
});

test('computeLayout: spx/spy never below 2 and per-axis rounding', () => {
  const L = computeLayout(makeProject({ layout: { cols: 2, rows: 3, tileW: 100, tileH: 50 } }), 80);
  assert.equal(L.spx, 2);
  assert.equal(L.spy, 2);
  assert.equal(L.nx, 5);
  assert.equal(L.ny, 7);
  const M = computeLayout(makeProject({ layout: { cols: 1, rows: 1, tileW: 100, tileH: 50 } }), 0.3);
  assert.equal(M.spx, Math.round(100 / 0.3));
  assert.equal(M.spy, Math.round(50 / 0.3));
  close(M.dx, 100 / M.spx);
  close(M.dy, 50 / M.spy);
});

test('computeLayout: falls back to relief.resolutionMm for invalid resolutions', () => {
  const L = computeLayout(makeProject({ relief: { resolutionMm: 1 } }), NaN);
  assert.equal(L.spx, 246);
});

test('computeLayout: tile that only fits rotated sets rotateOnBed', () => {
  const p = makeProject({
    printer: { bedW: 300, bedH: 200 },
    layout: { cols: 2, rows: 1, tileW: 180, tileH: 280 },
    frame: { widthKm: 360, heightKm: 280 },
  });
  const L = computeLayout(p, 1);
  assert.equal(L.fitsBed, true);
  assert.equal(L.rotateOnBed, true);
  assert.deepEqual(L.warnings, []);
});

test('computeLayout: oversized tiles are flagged with a warning', () => {
  const p = makeProject({ layout: { cols: 2, rows: 1, tileW: 300, tileH: 300 }, frame: { widthKm: 600, heightKm: 300 } });
  const L = computeLayout(p, 1);
  assert.equal(L.fitsBed, false);
  assert.equal(L.rotateOnBed, false);
  assert.equal(L.warnings.length, 1);
  assert.match(L.warnings[0], /300 × 300 mm.*256 × 256 mm bed/);
});

test('computeLayout: aspect mismatch, extreme zoom and huge grids produce warnings', () => {
  const stretched = computeLayout(makeProject({ frame: { widthKm: 900, heightKm: 900 } }), 1);
  assert.ok(stretched.warnings.some((w) => /stretched/.test(w)));
  const zoomed = computeLayout(makeProject({ frame: { widthKm: 5, heightKm: 2.5 } }), 1);
  assert.ok(zoomed.warnings.some((w) => /30 m elevation data/.test(w)));
  const huge = computeLayout(makeProject({ layout: { cols: 8, rows: 8, tileW: 400, tileH: 400 }, frame: { widthKm: 900, heightKm: 900 }, relief: { resolutionMm: 0.1 } }), 2);
  assert.ok(huge.warnings.some((w) => /M samples/.test(w)), huge.warnings.join('|'));
  assert.ok(huge.warnings.some((w) => /^64 tiles .*very long print/.test(w)));
});

test('exportResolutionMm: min(resolutionMm, style hint), never below 0.1 mm', () => {
  assert.equal(exportResolutionMm(makeProject()), 0.4);
  close(exportResolutionMm(makeProject({ style: { id: 'ridgelines', params: { thicknessMm: 0.9 } } })), 0.3);
  assert.equal(exportResolutionMm(makeProject({ style: { id: 'contours', params: { lineWidthMm: 0.1 } } })), 0.1);
});

test('fitTileToBed: largest square tile with margins', () => {
  assert.deepEqual(fitTileToBed({ bedW: 256, bedH: 256 }), { tileW: 246, tileH: 246 });
  assert.deepEqual(fitTileToBed({ bedW: 350, bedH: 320 }, 10), { tileW: 300, tileH: 300 });
  assert.deepEqual(fitTileToBed({ bedW: 220.6, bedH: 300 }), { tileW: 210, tileH: 210 });
  assert.deepEqual(fitTileToBed({ bedW: 220, bedH: 220 }, 0), { tileW: 220, tileH: 220 });
  assert.deepEqual(fitTileToBed({ bedW: 25, bedH: 25 }), { tileW: 20, tileH: 20 });
});

// -------------------------------------------------------------------------------------- zmap

test('computeZMap: floor modes', () => {
  const L = computeLayout(makeProject(), 1);
  const floorOf = (mode, minElev, elevationM = 0) =>
    computeZMap(makeProject({ relief: { floor: { mode, elevationM } } }), L, { minElev, maxElev: 4000 }).floorM;
  assert.equal(floorOf('auto', 1234), 1200);
  assert.equal(floorOf('auto', 1200), 1200);
  assert.equal(floorOf('auto', 49), 0);
  assert.equal(floorOf('auto', 0), 0);
  assert.equal(floorOf('auto', -0.4), 0, 'sub-metre negative minima are DEM noise at the coast');
  assert.equal(floorOf('auto', -1), -50);
  assert.equal(floorOf('auto', -30), -50);
  assert.equal(floorOf('auto', -120), -150);
  assert.equal(floorOf('sea', 1234), 0);
  assert.equal(floorOf('fixed', 1234, 800), 800);
});

test('computeZMap: manual exaggeration and zTop formula', () => {
  const p = makeProject();
  const L = computeLayout(p, 1);
  const zm = computeZMap(p, L, { minElev: 120, maxElev: 4800 });
  assert.equal(zm.floorM, 100);
  assert.equal(zm.exaggeration, 4);
  close(zm.mmPerM, 4 / L.scaleMPerMm);
  assert.equal(zm.baseMm, 3);
  assert.equal(zm.minElevM, 120);
  assert.equal(zm.maxElevM, 4800);
  close(zm.maxZMm, 3 + 4700 * zm.mmPerM);
  close(zTop(zm, 100), 3);
  close(zTop(zm, -500), 3, 0, 'below the floor prints at the base');
  close(zTop(zm, 2100), 3 + 2000 * zm.mmPerM);
  assert.equal(zTop(zm, NaN), 3);
  const grid = elevationToZ(new Float32Array([100, 2100, NaN]), zm);
  close(grid[1], zTop(zm, 2100), 1e-5);
  assert.equal(grid[2], 3);
});

test('computeZMap: auto exaggeration hits the target relief, clamped and rounded', () => {
  const p = makeProject({ relief: { autoExaggeration: true, targetReliefMm: 25 } });
  const L = computeLayout(p, 1);
  const zm = computeZMap(p, L, { minElev: 300, maxElev: 4300 });
  const expected = Math.round((25 / (4000 / L.scaleMPerMm)) * 10) / 10;
  assert.equal(zm.exaggeration, expected);
  close(zm.mmPerM, expected / L.scaleMPerMm);
  assert.ok(Math.abs(zm.maxZMm - 3 - 25) < 0.3, `relief ≈ target, got ${zm.maxZMm - 3}`);
  assert.equal(autoExaggeration(25, 10, 900), 30);
  assert.equal(autoExaggeration(25, 1e7, 900), 0.5);
  assert.equal(autoExaggeration(25, 0, 900), 30, 'flat terrain does not divide by zero');
});

test('computeZMap: maxHeightMm clamps total height, border rim raises maxZMm', () => {
  const L = computeLayout(makeProject(), 1);
  const clamped = computeZMap(makeProject({ relief: { maxHeightMm: 10 } }), L, { minElev: 0, maxElev: 4800 });
  assert.equal(clamped.maxHeightMm, 10);
  assert.equal(clamped.maxZMm, 10);
  assert.equal(zTop(clamped, 4800), 10);
  assert.ok(zTop(clamped, 500) < 10);

  const flat = { minElev: 0, maxElev: 100 };
  const noRim = computeZMap(makeProject(), L, flat);
  const rim = computeZMap(makeProject({ border: { enabled: true, heightMm: 4 } }), L, flat);
  assert.ok(noRim.maxZMm < 7);
  assert.equal(rim.maxZMm, 7);
  const rimClamped = computeZMap(makeProject({ border: { enabled: true, heightMm: 4 }, relief: { maxHeightMm: 5 } }), L, flat);
  assert.equal(rimClamped.maxZMm, 5);
});

test('computeZMap: missing stats do not produce NaN', () => {
  const L = computeLayout(makeProject(), 1);
  const zm = computeZMap(makeProject(), L, { minElev: NaN, maxElev: undefined });
  for (const v of Object.values(zm)) assert.ok(Number.isFinite(v), JSON.stringify(zm));
});

// ----------------------------------------------------------------------------------- filters

test('gaussianKernel: radius ceil(3σ), normalised, symmetric', () => {
  for (const sigma of [0.3, 1, 2.5]) {
    const k = gaussianKernel(sigma);
    assert.equal(k.length, 2 * Math.ceil(3 * sigma) + 1);
    close(k.reduce((a, b) => a + b, 0), 1, 1e-6);
    for (let i = 0; i < k.length; i++) close(k[i], k[k.length - 1 - i], 1e-9);
  }
});

test('gaussianBlur: constants preserved, mass preserved, edges clamped, input untouched', () => {
  const nx = 41;
  const ny = 31;
  const flat = new Float32Array(nx * ny).fill(7.5);
  for (const v of gaussianBlur(flat, nx, ny, 3)) close(v, 7.5, 1e-5);

  const impulse = new Float32Array(nx * ny);
  impulse[15 * nx + 20] = 1;
  const blurred = gaussianBlur(impulse, nx, ny, 2);
  close(blurred.reduce((a, b) => a + b, 0), 1, 1e-5);
  close(blurred[15 * nx + 18], blurred[15 * nx + 22], 1e-7); // symmetric
  close(blurred[13 * nx + 20], blurred[17 * nx + 20], 1e-7);
  assert.ok(blurred[15 * nx + 20] > blurred[15 * nx + 21]);
  assert.equal(impulse[15 * nx + 20], 1);

  // Edge clamp: a left-edge step stays at full height at the very edge.
  const step = new Float32Array(nx * ny);
  for (let r = 0; r < ny; r++) for (let c = 0; c < 5; c++) step[r * nx + c] = 10;
  const s = gaussianBlur(step, nx, ny, 1.5);
  assert.ok(s[10 * nx] > 9.9, `edge ${s[10 * nx]}`);
  assert.ok(s[10 * nx + 4] > 5 && s[10 * nx + 5] < 5);
  close(s[10 * nx + 4] + s[10 * nx + 5], 10, 1e-5); // symmetric about the step at x = 4.5

  const copy = gaussianBlur(step, nx, ny, 0);
  assert.notEqual(copy, step);
  assert.deepEqual(copy, step);
});

test('gaussianBlur: 4000 × 2500 grid in reasonable time', () => {
  const nx = 4000;
  const ny = 2500;
  const z = new Float32Array(nx * ny);
  for (let i = 0; i < z.length; i++) z[i] = (i % 977) * 0.5;
  const t = performance.now();
  const out = gaussianBlur(z, nx, ny, 1);
  const ms = performance.now() - t;
  assert.equal(out.length, z.length);
  assert.ok(ms < 6000, `blur took ${ms.toFixed(0)} ms`);
});

test('hillshade: flat = sin(altitude); slopes facing the light are brighter', () => {
  const nx = 21;
  const ny = 21;
  const flat = new Float32Array(nx * ny);
  for (const v of hillshade(flat, nx, ny, 1, 1, 315, 35)) close(v, Math.sin((35 * Math.PI) / 180), 1e-6);

  // Ridge along y: west half rises eastwards (faces west), east half falls eastwards (faces east).
  const ridge = new Float32Array(nx * ny);
  for (let r = 0; r < ny; r++) for (let c = 0; c < nx; c++) ridge[r * nx + c] = 10 - Math.abs(c - 10);
  const shade = hillshade(ridge, nx, ny, 1, 1, 270, 45); // light from the west
  assert.ok(shade[10 * nx + 4] > shade[10 * nx + 16]);
  for (const v of shade) assert.ok(v >= 0 && v <= 1);

  // North-facing slope (height falls towards row 0 = north) is lit by a northern sun.
  const tilt = new Float32Array(nx * ny);
  for (let r = 0; r < ny; r++) for (let c = 0; c < nx; c++) tilt[r * nx + c] = r;
  close(hillshade(tilt, nx, ny, 1, 1, 0, 45)[10 * nx + 10], Math.cos(Math.PI / 4 - Math.atan(1)), 1e-6);
});

test('gradientMagnitude: exact for planes including the edges', () => {
  const nx = 9;
  const ny = 7;
  const dx = 0.5;
  const dy = 2;
  const z = new Float32Array(nx * ny);
  // z = 2·x + 3·y with x = c·dx, y = (ny-1-r)·dy (y up)
  for (let r = 0; r < ny; r++) for (let c = 0; c < nx; c++) z[r * nx + c] = 2 * c * dx + 3 * (ny - 1 - r) * dy;
  for (const g of gradientMagnitude(z, nx, ny, dx, dy)) close(g, Math.sqrt(13), 1e-5);
});

// ------------------------------------------------------------------------------------- tiles

test('extractTileFields: shared seams, origins, labels, water slices', () => {
  const p = makeProject({ layout: { cols: 3, rows: 2, tileW: 30, tileH: 20 }, frame: { widthKm: 90, heightKm: 40 } });
  const L = computeLayout(p, 1);
  const n = L.nx * L.ny;
  const z = new Float32Array(n);
  const water = new Uint8Array(n);
  for (let i = 0; i < n; i++) {
    z[i] = 1 + i * 1e-3;
    water[i] = i % 3 === 0 ? 1 : 0;
  }
  const tiles = extractTileFields({ z, water }, L, p, { withBack: false });
  assert.equal(tiles.length, 6);
  assert.deepEqual(tiles.map((t) => t.label), ['A1', 'A2', 'A3', 'B1', 'B2', 'B3']);
  const at = (row, col) => tiles[row * 3 + col];
  const t = at(1, 2);
  assert.equal(t.row, 1);
  assert.equal(t.col, 2);
  assert.equal(t.x0, 60);
  assert.equal(t.y0, 0);
  assert.equal(at(0, 0).y0, 20);
  assert.equal(t.widthMm, 30);
  assert.equal(t.heightMm, 20);
  assert.equal(t.top.nx, L.spx + 1);
  assert.equal(t.top.ny, L.spy + 1);
  assert.equal(t.bottom, null);

  const w = L.spx + 1;
  const h = L.spy + 1;
  for (let row = 0; row < 2; row++) {
    for (let col = 0; col < 3; col++) {
      const tile = at(row, col);
      // Every sample equals the artwork sample it came from.
      for (const [r, c] of [[0, 0], [h - 1, w - 1], [7, 11]]) {
        const src = (row * L.spy + r) * L.nx + col * L.spx + c;
        assert.equal(tile.top.z[r * w + c], z[src]);
        assert.equal(tile.water[r * w + c], water[src]);
      }
      if (col < 2) {
        const right = at(row, col + 1);
        for (let r = 0; r < h; r++) assert.equal(tile.top.z[r * w + w - 1], right.top.z[r * w]);
      }
      if (row < 1) {
        const below = at(row + 1, col);
        for (let c = 0; c < w; c++) assert.equal(tile.top.z[(h - 1) * w + c], below.top.z[c]);
      }
    }
  }
});

test('extractTileFields: back grids only when requested and enabled', () => {
  const p = makeProject({ layout: { cols: 2, rows: 1, tileW: 60, tileH: 60 }, frame: { widthKm: 120, heightKm: 60 } });
  const L = computeLayout(p, 1);
  const field = { z: new Float32Array(L.nx * L.ny).fill(5), water: null };
  const withBack = extractTileFields(field, L, p, { backResMm: 0.5 });
  assert.equal(withBack[0].bottom.nx, 121);
  assert.equal(withBack[0].bottom.ny, 121);
  assert.ok(withBack[0].bottom.z.some((v) => v > 0));
  assert.equal(withBack[0].water, undefined);
  const noLabels = makeProject({ layout: p.layout, frame: p.frame, back: { labels: false } });
  assert.equal(extractTileFields(field, L, noLabels)[1].bottom, null);
  assert.throws(() => extractTileFields({ z: new Float32Array(3) }, L, p), RangeError);
});

test('tileLabel: A1 top-left', () => {
  assert.equal(tileLabel(0, 0), 'A1');
  assert.equal(tileLabel(2, 9), 'C10');
});
