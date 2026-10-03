// Unit tests: model/styles.js (art styles, smoothing, water, border rim, thickness clamps)
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { computeLayout } from '../../app/js/model/layout.js';
import { computeZMap, zTop } from '../../app/js/model/zmap.js';
import {
  STYLE_IDS, buildArtworkField, createCellLattice, minTopThicknessMm, resolveStyle, styleDefaults, styleResolutionHint,
} from '../../app/js/model/styles.js';

// Synthetic setup: 2 × 1 tiles of 60 × 60 mm, 12 km wide → 100 m per mm; exaggeration 1 →
// 0.01 mm per metre; floor at sea level, so zTop(e) = 3 + e / 100.
function makeProject(patch = {}) {
  const base = {
    frame: { lat: 46, lon: 10, widthKm: 12, heightKm: 6, rotationDeg: 0 },
    printer: { bedW: 256, bedH: 256, maxZ: 250, nozzleMm: 0.4 },
    layout: { cols: 2, rows: 1, tileW: 60, tileH: 60 },
    relief: {
      exaggeration: 1, autoExaggeration: false, targetReliefMm: 25, baseMm: 3,
      floor: { mode: 'sea', elevationM: 0 }, smoothingMm: 0, resolutionMm: 0.5, simplifyMm: 0.02,
      water: { mode: 'none', depthMm: 0.6 }, maxHeightMm: 0,
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

/** Samples elevation (and water) functions of artwork coordinates (x → right, y ↑, mm). */
function sample(layout, elevFn, waterFn = () => 0) {
  const { nx, ny, dx, dy, artH } = layout;
  const elev = new Float32Array(nx * ny);
  const water = new Uint8Array(nx * ny);
  for (let r = 0; r < ny; r++) {
    for (let c = 0; c < nx; c++) {
      const x = c * dx;
      const y = artH - r * dy;
      elev[r * nx + c] = elevFn(x, y, r, c);
      water[r * nx + c] = waterFn(x, y, r, c) ? 1 : 0;
    }
  }
  return { elev, water };
}

const mountain = (x, y) => 200 + 1800 * Math.exp(-((x - 60) ** 2 + (y - 30) ** 2) / (2 * 15 ** 2)) + 5 * x;

/** Builds layout, zmap and field for a project patch and terrain. */
function build(patch, elevFn = mountain, waterFn, res) {
  const project = makeProject(patch);
  const layout = computeLayout(project, res ?? project.relief.resolutionMm);
  const sampled = sample(layout, elevFn, waterFn);
  let min = Infinity;
  let max = -Infinity;
  for (const v of sampled.elev) if (Number.isFinite(v)) { min = Math.min(min, v); max = Math.max(max, v); }
  const zmap = computeZMap(project, layout, { minElev: min, maxElev: max });
  const field = buildArtworkField(sampled, layout, zmap, project);
  return { project, layout, zmap, sampled, field };
}

const minOf = (arr) => arr.reduce((a, b) => (b < a ? b : a), Infinity);
const close = (a, b, eps = 1e-4, msg) => assert.ok(Math.abs(a - b) <= eps, msg ?? `${a} ≉ ${b}`);

// --------------------------------------------------------------------------- defaults & hints

test('styleDefaults: equal the documented table', () => {
  assert.deepEqual(STYLE_IDS, ['classic', 'terraced', 'lowpoly', 'ridgelines', 'hex', 'contours', 'lithophane']);
  assert.deepEqual(styleDefaults('classic'), {});
  assert.deepEqual(styleDefaults('terraced'), { stepMode: 'count', count: 16, stepM: 200, snapToLayers: true });
  assert.deepEqual(styleDefaults('lowpoly'), { facetMm: 1.2 });
  assert.deepEqual(styleDefaults('ridgelines'), { spacingMm: 5, thicknessMm: 1.2, direction: 'horizontal', staggerMm: 0 });
  assert.deepEqual(styleDefaults('hex'), { shape: 'hex', cellMm: 8, gapMm: 0.6, stepMm: 0 });
  assert.deepEqual(styleDefaults('contours'), { intervalM: 200, majorEvery: 5, lineWidthMm: 0.6, depthMm: 0.4, mode: 'engrave' });
  assert.deepEqual(styleDefaults('lithophane'), { minMm: 0.8, maxMm: 3.2, sunAzimuth: 315, sunAltitude: 35, contrast: 1 });
  assert.deepEqual(styleDefaults('nope'), {});
  const copy = styleDefaults('hex');
  copy.cellMm = 99;
  assert.equal(styleDefaults('hex').cellMm, 8);
});

test('resolveStyle: params merged by type, unknown style falls back to classic', () => {
  const { id, params } = resolveStyle({ style: { id: 'hex', params: { cellMm: 12, gapMm: 'wide', stepMm: NaN, extra: 1 } } });
  assert.equal(id, 'hex');
  assert.deepEqual(params, { shape: 'hex', cellMm: 12, gapMm: 0.6, stepMm: 0 });
  assert.equal(resolveStyle({ style: { id: 'bogus' } }).id, 'classic');
  assert.equal(resolveStyle({}).id, 'classic');
});

test('styleResolutionHint: per style', () => {
  const hint = (id, params = {}) => styleResolutionHint(makeProject({ style: { id, params } }));
  close(hint('ridgelines'), 0.4, 1e-12);
  close(hint('ridgelines', { thicknessMm: 0.9 }), 0.3, 1e-12);
  close(hint('hex'), 0.3, 1e-12);
  assert.equal(hint('hex', { gapMm: 0.2 }), 0.15);
  assert.equal(hint('hex', { gapMm: 0 }), null);
  close(hint('contours'), 0.3, 1e-12);
  for (const id of ['classic', 'terraced', 'lowpoly', 'lithophane']) assert.equal(hint(id), null);
});

test('minTopThicknessMm: max(0.6, enabled back feature depths) + 0.6', () => {
  close(minTopThicknessMm(makeProject()), 1.2, 1e-12);
  close(minTopThicknessMm(makeProject({ back: { labels: false } })), 1.2, 1e-12);
  close(minTopThicknessMm(makeProject({ back: { labelDepthMm: 1 } })), 1.6, 1e-12);
  close(minTopThicknessMm(makeProject({ back: { magnets: { enabled: true } } })), 3.8, 1e-12);
});

// ------------------------------------------------------------------------------ all styles

test('every style: finite heights, minimum thickness, NaN input tolerated, input untouched', () => {
  const nanMountain = (x, y, r, c) => ((r * 31 + c) % 97 === 0 ? NaN : mountain(x, y));
  for (const id of STYLE_IDS) {
    for (const waterMode of ['none', 'flat', 'recess']) {
      const { field, sampled, layout, project } = build(
        { style: { id }, relief: { smoothingMm: 1, water: { mode: waterMode } }, border: { enabled: true } },
        nanMountain, (x, y) => x > 20 && x < 30 && y > 10 && y < 20,
      );
      assert.equal(field.z.length, layout.nx * layout.ny);
      assert.equal(field.water.length, layout.nx * layout.ny);
      const floor = id === 'lithophane' ? 0.8 : minTopThicknessMm(project);
      let max = -Infinity;
      for (const v of field.z) {
        assert.ok(Number.isFinite(v) && v >= floor - 1e-6, `${id}/${waterMode}: ${v}`);
        max = Math.max(max, v);
      }
      assert.equal(field.maxZMm, max, `${id}: field.maxZMm is the real maximum`);
      assert.ok(Number.isNaN(sampled.elev[0]), 'input elevations are not modified');
    }
  }
});

test('every style respects relief.maxHeightMm', () => {
  for (const id of STYLE_IDS) {
    const { field } = build({ style: { id, params: { mode: 'emboss', staggerMm: 3 } }, relief: { maxHeightMm: 12 }, border: { enabled: true, heightMm: 20 } });
    for (const v of field.z) assert.ok(v <= 12 + 1e-6, `${id}: ${v}`);
  }
});

test('buildArtworkField: rejects mismatched sample counts', () => {
  const project = makeProject();
  const layout = computeLayout(project, 1);
  const zmap = computeZMap(project, layout, { minElev: 0, maxElev: 100 });
  assert.throws(() => buildArtworkField({ elev: new Float32Array(10) }, layout, zmap, project), RangeError);
});

// ---------------------------------------------------------------------- classic & water

test('classic: z = zTop(elevation) without smoothing', () => {
  const { field, sampled, zmap } = build({});
  for (let i = 0; i < field.z.length; i += 37) close(field.z[i], zTop(zmap, sampled.elev[i]), 1e-4);
  assert.ok(field.water.every((v) => v === 0));
  assert.equal(field.meshToleranceMm, undefined);
});

test('water: lakes stay flat after smoothing, recess lowers them, none ignores the mask', () => {
  // Two lakes at different levels on a steep slope (rises 40 m per mm eastwards).
  const lakeA = (x, y) => x > 20 && x < 35 && y > 20 && y < 40;
  const lakeB = (x, y) => x > 80 && x < 95 && y > 10 && y < 30;
  const terrain = (x, y) => (lakeA(x, y) ? 500 : lakeB(x, y) ? 900 : 100 + 40 * x + 3 * y);
  const isWater = (x, y) => lakeA(x, y) || lakeB(x, y);
  const patch = (mode) => ({ relief: { smoothingMm: 2, water: { mode, depthMm: 0.6 } } });

  const flat = build(patch('flat'), terrain, isWater);
  const recess = build(patch('recess'), terrain, isWater);
  const none = build(patch('none'), terrain, isWater);
  const { nx, ny, dx, dy, artH } = flat.layout;
  let lakeSamples = 0;
  let tiltedInNone = 0;
  for (let r = 0; r < ny; r++) {
    for (let c = 0; c < nx; c++) {
      const x = c * dx;
      const y = artH - r * dy;
      const i = r * nx + c;
      assert.equal(flat.field.water[i], isWater(x, y) ? 1 : 0);
      if (!isWater(x, y)) continue;
      lakeSamples++;
      const level = zTop(flat.zmap, lakeA(x, y) ? 500 : 900);
      close(flat.field.z[i], level, 1e-4, `flat lake at (${x}, ${y}): ${flat.field.z[i]} vs ${level}`);
      close(recess.field.z[i], level - 0.6, 1e-4);
      if (Math.abs(none.field.z[i] - level) > 0.01) tiltedInNone++;
    }
  }
  assert.ok(lakeSamples > 500);
  assert.ok(tiltedInNone > 50, 'without water handling, smoothing tilts the lake shores');
  assert.ok(none.field.water.every((v) => v === 0));
  // Land next to the lake is smoothed, not flattened.
  const shore = (Math.round((artH - 30) / dy)) * nx + Math.round(36 / dx);
  assert.ok(Math.abs(flat.field.z[shore] - zTop(flat.zmap, terrain(36, 30))) > 0.01);
});

// --------------------------------------------------------------------------------- terraced

test('terraced (count): piecewise constant, ≤ count + 1 levels, tops on layer tops', () => {
  const patch = { style: { id: 'terraced', params: { count: 8 } }, colors: { firstLayerMm: 0.3, layerHeightMm: 0.2 } };
  const { field, layout, sampled } = build(patch);
  const levels = new Set(field.z);
  assert.ok(levels.size <= 9 && levels.size >= 6, `levels: ${levels.size}`);
  for (const z of levels) {
    const k = (z - 0.3) / 0.2;
    close(k, Math.round(k), 1e-4, `terrace top ${z} is not a layer top`);
  }
  let steps = 0;
  for (let r = 0; r < layout.ny; r++) {
    for (let c = 1; c < layout.nx; c++) if (field.z[r * layout.nx + c] !== field.z[r * layout.nx + c - 1]) steps++;
  }
  assert.ok(steps / (layout.nx * layout.ny) < 0.05, `too many steps: ${steps}`);
  // Monotone: clearly higher terrain never gets a lower terrace.
  const order = [...sampled.elev.keys()].sort((a, b) => sampled.elev[a] - sampled.elev[b]);
  for (let k = 1; k < order.length; k++) assert.ok(field.z[order[k]] >= field.z[order[k - 1]]);
});

test('terraced (meters, no snapping): terrace = zTop of the contour below', () => {
  const { field, sampled, zmap } = build({ style: { id: 'terraced', params: { stepMode: 'meters', stepM: 250, snapToLayers: false } } });
  for (let i = 0; i < field.z.length; i += 13) {
    close(field.z[i], zTop(zmap, Math.floor(sampled.elev[i] / 250) * 250), 1e-4);
  }
});

test('terraced: recessed lakes sit one depth below their terrace', () => {
  const lake = (x, y) => x > 70 && x < 80 && y > 40 && y < 50;
  const terrain = (x, y) => (lake(x, y) ? 1230 : mountain(x, y));
  const patch = (mode) => ({ style: { id: 'terraced', params: { count: 6 } }, relief: { water: { mode } } });
  const flat = build(patch('flat'), terrain, lake);
  const recess = build(patch('recess'), terrain, lake);
  let checked = 0;
  for (let i = 0; i < flat.field.z.length; i++) {
    if (!flat.field.water[i]) continue;
    close(recess.field.z[i], flat.field.z[i] - 0.6, 1e-4);
    checked++;
  }
  assert.ok(checked > 100);
});

// ---------------------------------------------------------------------------------- lowpoly

test('lowpoly: classic surface with facet tolerance', () => {
  const classic = build({});
  const low = build({ style: { id: 'lowpoly' } });
  assert.deepEqual(low.field.z, classic.field.z);
  assert.equal(low.field.meshToleranceMm, 1.2);
  assert.equal(build({ style: { id: 'lowpoly', params: { facetMm: 2.5 } } }).field.meshToleranceMm, 2.5);
});

// ------------------------------------------------------------------------------- ridgelines

test('ridgelines (horizontal): ribs follow the profile at their centre line, base in between', () => {
  const res = 0.25;
  const classic = build({}, mountain, undefined, res);
  const stagger = 0.5;
  const { field, layout } = build({ style: { id: 'ridgelines', params: { staggerMm: stagger } } }, mountain, undefined, res);
  const { nx, ny, dy } = layout;
  let ribRows = 0;
  let baseRows = 0;
  for (let r = 0; r < ny; r++) {
    const d = r * dy; // distance from the top edge
    const k = Math.max(0, Math.round((d - 2.5) / 5));
    const centre = 2.5 + 5 * k;
    const centreRow = Math.round(centre / dy);
    for (let c = 0; c < nx; c += 7) {
      const z = field.z[r * nx + c];
      if (Math.abs(d - centre) <= 0.6 + 1e-9) close(z, classic.field.z[centreRow * nx + c] + k * stagger, 1e-4);
      else close(z, 3, 1e-6);
    }
    if (Math.abs(d - centre) <= 0.6 + 1e-9) ribRows++;
    else baseRows++;
  }
  assert.equal(ribRows, 12 * 5); // 12 ribs over 60 mm, 5 sample rows (1.0 … 1.2 mm) each
  assert.ok(baseRows > ribRows);
});

test('ridgelines (vertical): ribs run along y and continue across tile seams', () => {
  const res = 0.25;
  const classic = build({}, mountain, undefined, res);
  const { field, layout } = build({ style: { id: 'ridgelines', params: { direction: 'vertical', spacingMm: 6, thicknessMm: 2 } } }, mountain, undefined, res);
  const { nx, ny, dx } = layout;
  for (let c = 0; c < nx; c++) {
    const x = c * dx;
    const k = Math.max(0, Math.round((x - 3) / 6));
    const centre = 3 + 6 * k;
    const onRib = Math.abs(x - centre) <= 1 + 1e-9;
    for (let r = 0; r < ny; r += 11) {
      const z = field.z[r * nx + c];
      if (onRib) close(z, classic.field.z[r * nx + Math.round(centre / dx)], 1e-4);
      else close(z, 3, 1e-6);
    }
  }
  // Rib centres keep the global 6 mm rhythm in the second tile (x = 63, 69, …).
  const r = Math.round(ny / 2);
  assert.ok(field.z[r * nx + Math.round(63 / dx)] > 3.5);
  assert.equal(field.z[r * nx + Math.round(66 / dx)], 3);
});

test('ridgelines: ribs get at least one sample line on coarse grids; water only on ribs', () => {
  const lake = (x, y) => x > 10 && x < 50 && y > 10 && y < 50;
  const { field, layout } = build({ style: { id: 'ridgelines' }, relief: { water: { mode: 'flat' } } }, mountain, lake, 2);
  const { nx, ny } = layout;
  let ribs = 0;
  for (let r = 0; r < ny; r++) {
    const row = field.z.subarray(r * nx, (r + 1) * nx);
    const isRib = row.some((v) => v > 3);
    if (isRib) ribs++;
    else for (let c = 0; c < nx; c++) assert.equal(field.water[r * nx + c], 0);
  }
  assert.equal(ribs, 12, 'every rib is visible at 2 mm resolution');
});

// ---------------------------------------------------------------------------------- hex / square

function checkCells(shape, params, res) {
  const classic = build({}, mountain, undefined, res);
  const { field, layout, zmap } = build({ style: { id: 'hex', params: { shape, ...params } } }, mountain, undefined, res);
  const cellMm = params.cellMm ?? 8;
  const gap = params.gapMm ?? 0.6;
  const lattice = createCellLattice(layout, shape, cellMm);
  const { nx, ny, dx, dy, artH } = layout;
  const sum = new Float64Array(lattice.count);
  const count = new Float64Array(lattice.count);
  const hit = new Float64Array(2);
  for (let r = 0; r < ny; r++) {
    for (let c = 0; c < nx; c++) {
      lattice.locate(c * dx, artH - r * dy, hit);
      sum[hit[0]] += classic.field.z[r * nx + c];
      count[hit[0]]++;
    }
  }
  const halfGap = gap > 0 ? Math.max(gap / 2, 0.5 * Math.max(dx, dy)) : -Infinity;
  let cells = new Set();
  for (let r = 0; r < ny; r++) {
    for (let c = 0; c < nx; c++) {
      lattice.locate(c * dx, artH - r * dy, hit);
      const z = field.z[r * nx + c];
      assert.ok(hit[1] >= -1e-9 && hit[1] <= cellMm / 2 + 1e-9, 'edge distance inside the cell');
      if (hit[1] < halfGap) {
        assert.equal(z, zmap.baseMm);
        continue;
      }
      let expected = sum[hit[0]] / count[hit[0]];
      if (params.stepMm > 0) expected = zmap.baseMm + Math.round((expected - zmap.baseMm) / params.stepMm) * params.stepMm;
      close(z, expected, 1e-4, `${shape} cell value ${z} ≠ mean ${expected}`);
      cells.add(hit[0]);
    }
  }
  return { cells: cells.size, field, layout };
}

test('hex: columns are the cell mean, gaps drop to the base', () => {
  const { cells } = checkCells('hex', {}, 0.25);
  // 120 × 60 mm with 8 mm hexagons: ≈ 120·60 / (8²·√3/2) ≈ 130 cells (+ partial ones)
  assert.ok(cells > 120 && cells < 200, `cells ${cells}`);
});

test('hex (square, quantised): constant squares on base + j·stepMm', () => {
  const { cells, field } = checkCells('square', { cellMm: 10, gapMm: 1, stepMm: 0.5 }, 0.25);
  assert.equal(cells, 13 * 7); // squares centred on the artwork centre: 13 columns (12 + 2 halves), 7 rows
  for (const v of field.z) close((v - 3) / 0.5, Math.round((v - 3) / 0.5), 1e-4);
});

test('hex: no gap when gapMm = 0', () => {
  const { field } = build({ style: { id: 'hex', params: { gapMm: 0 } } });
  const base = field.z.filter((v) => v === 3).length;
  assert.ok(base < field.z.length * 0.01);
});

// --------------------------------------------------------------------------------- contours

test('contours: lines where the contour levels cross, majors wider, engrave/emboss, none on water', () => {
  const res = 0.1;
  const ramp = (x, y, r, c) => c; // 1 m per column = 10 m per mm eastwards
  const waterColumn = (x, y, r, c) => c === 400;
  const patch = (mode) => ({ style: { id: 'contours', params: { mode } }, relief: { water: { mode: 'flat' } } });
  const classic = build({ relief: { water: { mode: 'flat' } } }, ramp, waterColumn, res);
  const engr = build(patch('engrave'), ramp, waterColumn, res);
  const emb = build(patch('emboss'), ramp, waterColumn, res);
  const { nx, ny } = engr.layout;
  const r = Math.round(ny / 2);
  const delta = (f, c) => f.field.z[r * nx + c] - classic.field.z[r * nx + c];
  // Minor line at 600 m (x = 60 mm): half width 0.3 mm = 3 columns.
  close(delta(engr, 600), -0.4, 1e-5);
  close(delta(engr, 602), -0.4, 1e-5);
  close(delta(engr, 598), -0.4, 1e-5);
  close(delta(engr, 604), 0, 1e-6);
  close(delta(emb, 600), 0.4, 1e-5);
  // Major line at 1000 m (x = 100 mm): half width 0.48 mm.
  close(delta(engr, 1004), -0.4, 1e-5);
  close(delta(engr, 1005), 0, 1e-6);
  // Between levels: untouched.
  close(delta(engr, 500), 0, 1e-6);
  close(delta(engr, 700), 0, 1e-6);
  // The water column at 400 m is not engraved, its land neighbours are.
  close(delta(engr, 400), 0, 1e-6);
  close(delta(engr, 402), -0.4, 1e-5);
  // Every column of a line is engraved along the whole height (lines are continuous).
  for (let rr = 1; rr < ny - 1; rr++) close(engr.field.z[rr * nx + 800] - classic.field.z[rr * nx + 800], -0.4, 1e-5);
});

// ------------------------------------------------------------------------------- lithophane

test('lithophane: thickness from the hillshade, bright = thin, base and water ignored', () => {
  // Flat plateau in the west, a cone in the east.
  const terrain = (x, y) => (x < 40 ? 1000 : 1000 + Math.max(0, 1500 - 60 * Math.hypot(x - 90, y - 30)));
  const lake = (x, y) => x > 5 && x < 15 && y > 5 && y < 15;
  const params = { minMm: 0.6, maxMm: 3 };
  const a = build({ style: { id: 'lithophane', params } }, terrain);
  const b = build({ style: { id: 'lithophane', params }, relief: { baseMm: 7, water: { mode: 'recess' } } }, terrain, lake);
  let maxDiff = 0;
  for (let i = 0; i < a.field.z.length; i++) maxDiff = Math.max(maxDiff, Math.abs(a.field.z[i] - b.field.z[i]));
  assert.ok(maxDiff < 1e-4, `base/water changed the lithophane by ${maxDiff} mm`);
  assert.ok(b.field.water.every((v) => v === 0));
  for (const v of a.field.z) assert.ok(v >= 0.6 - 1e-6 && v <= 3 + 1e-6);
  const { nx, dx, dy, artH } = a.layout;
  const at = (f, x, y) => f.field.z[Math.round((artH - y) / dy) * nx + Math.round(x / dx)];
  const flatThickness = 3 - 2.4 * Math.sin((35 * Math.PI) / 180);
  close(at(a, 20, 30), flatThickness, 1e-4);
  // North-west flank faces the 315° sun → thinner than the south-east flank.
  assert.ok(at(a, 80, 40) < flatThickness - 0.2);
  assert.ok(at(a, 100, 20) > flatThickness + 0.2);
  const c = build({ style: { id: 'lithophane', params: { ...params, contrast: 2 } } }, terrain);
  close(at(c, 20, 30), 3 - 2.4 * Math.sin((35 * Math.PI) / 180) ** 2, 1e-4);
});

// ------------------------------------------------------------------------- border & clamps

test('border rim: flat rim of baseMm + heightMm within widthMm of the edge', () => {
  const lake = (x) => x < 3;
  const { field, layout } = build({ border: { enabled: true, widthMm: 6, heightMm: 2 }, relief: { water: { mode: 'flat' } } }, mountain, lake);
  const { nx, ny, dx, dy, artW, artH } = layout;
  for (let r = 0; r < ny; r++) {
    for (let c = 0; c < nx; c++) {
      const x = c * dx;
      const yTop = r * dy;
      const inRim = Math.min(x, artW - x, yTop, artH - yTop) <= 6 + 1e-9;
      const i = r * nx + c;
      if (inRim) {
        assert.equal(field.z[i], 5);
        assert.equal(field.water[i], 0);
      }
    }
  }
  assert.notEqual(field.z[Math.round(ny / 2) * nx + Math.round(10 / dx)], 5);
  const litho = build({ style: { id: 'lithophane' }, border: { enabled: true, widthMm: 4, heightMm: 1 } });
  assert.equal(litho.field.z[0], Math.fround(3.2 + 1));
});

test('minimum thickness: recesses and low bases are lifted above back features', () => {
  const lake = (x, y) => x > 30 && x < 50 && y > 5 && y < 25;
  const terrain = (x, y) => (lake(x, y) ? 0 : mountain(x, y));
  const magnets = build({ relief: { baseMm: 1, water: { mode: 'recess', depthMm: 2 } }, back: { magnets: { enabled: true } } }, terrain, lake);
  close(minOf(magnets.field.z), 3.8, 1e-5);
  const labels = build({ relief: { baseMm: 1, water: { mode: 'recess', depthMm: 2 } } }, terrain, lake);
  close(minOf(labels.field.z), 1.2, 1e-5);
  const ridges = build({ style: { id: 'ridgelines' }, relief: { baseMm: 0.5 } });
  close(minOf(ridges.field.z), 1.2, 1e-5);
});
