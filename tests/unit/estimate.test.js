import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { estimateTile, estimateProject, printModel, SPEED_CLASSES } from '../../app/js/estimate/filament.js';
import { resolveBands } from '../../app/js/catalog/bands.js';

const FILAMENT_AREA = Math.PI * 0.875 ** 2; // 1.75 mm filament, mm²
const close = (actual, expected, tol = 1e-6, msg = '') =>
  assert.ok(Math.abs(actual - expected) <= tol * Math.max(1, Math.abs(expected)), `${msg} ${actual} ≠ ${expected}`);

function project(print = {}, extra = {}) {
  return {
    printer: { nozzleMm: 0.4 },
    colors: { mode: 'single', singleFilamentId: 'pla-snow-white', layerHeightMm: 0.2, firstLayerMm: 0.2, bands: [] },
    filaments: { owned: [], custom: [{ id: 'my-white', name: 'My White', material: 'PETG', color: '#ffffff', pricePerKg: 40 }] },
    print: { material: 'PLA', infillPct: 15, walls: 3, topLayers: 5, bottomLayers: 4, speedClass: 'standard', ...print },
    ...extra,
  };
}

/** Tile whose top surface is f(x, y) (tile-local mm, y up) sampled on an nx × ny grid. */
function tile(widthMm, heightMm, nx, ny, f, bottom = null, label = 'A1') {
  const z = new Float32Array(nx * ny);
  for (let r = 0; r < ny; r++) {
    for (let c = 0; c < nx; c++) z[r * nx + c] = f(c * widthMm / (nx - 1), heightMm - r * heightMm / (ny - 1));
  }
  return { label, row: 0, col: 0, x0: 0, y0: 0, widthMm, heightMm, top: { nx, ny, z }, bottom };
}

const band = (filamentId, zFrom, zTo = Infinity) => ({ filamentId, zFrom, zTo, layerFrom: 0, elevFromM: null, color: '#000000', finish: 'basic', name: filamentId });
const SINGLE = [band('pla-snow-white', 0)];
const THREE = [band('pla-forest-green', 0, 4), band('pla-silk-gold', 4, 7), band('my-white', 7)];

// 100 × 80 mm box, 10 mm tall; ring = 3 walls × 0.45 mm = 1.35 mm.
const BOX = tile(100, 80, 11, 9, () => 10);
const AREA = 100 * 80;
const INNER = (100 - 2.7) * (80 - 2.7);
const RING = AREA - INNER;

describe('estimateTile', () => {
  test('solid box: analytic volume, 100 % infill is fully solid', () => {
    const e = estimateTile(BOX, SINGLE, project({ infillPct: 100 }));
    close(e.volumeMm3, AREA * 10);
    close(e.solidMm3, AREA * 10);
    close(e.grams, AREA * 10 / 1000 * 1.24);
    close(e.metres, AREA * 10 / FILAMENT_AREA / 1000);
    assert.equal(e.maxZ, 10);
    assert.equal(e.layers, 50);
    assert.equal(e.colorChanges, 0);
    close(e.minutes, AREA * 10 / 11 / 60 + 50 * 4 / 60);
    assert.equal(e.label, 'A1');
    assert.deepEqual(Object.keys(e.byFilament), ['pla-snow-white']);
    close(e.byFilament['pla-snow-white'].grams, e.grams);
  });

  test('solid box: 15 % infill follows the skin/wall/infill model exactly', () => {
    const e = estimateTile(BOX, SINGLE, project());
    // inner columns: 0.8 mm bottom + 1.0 mm top skin solid, 8.2 mm at 15 %; the wall ring is solid
    const expected = RING * 10 + INNER * (1.8 + 0.15 * 8.2);
    close(e.volumeMm3, AREA * 10);
    close(e.solidMm3, expected);
    close(e.grams, expected / 1000 * 1.24);
    assert.ok(e.grams < 0.5 * estimateTile(BOX, SINGLE, project({ infillPct: 100 })).grams);
    // fewer walls / skins → less material, fast speed → shorter time
    assert.ok(estimateTile(BOX, SINGLE, project({ walls: 1, topLayers: 3 })).solidMm3 < e.solidMm3);
    close(estimateTile(BOX, SINGLE, project({ speedClass: 'fast' })).minutes, expected / SPEED_CLASSES.fast.flowMm3s / 60 + 50 * 4 / 60);
  });

  test('model adapts to nozzle and first-layer settings', () => {
    const m = printModel(project({}, { printer: { nozzleMm: 0.6 }, colors: { layerHeightMm: 0.3, firstLayerMm: 0.25 } }));
    close(m.wallMm, 3 * 0.675);
    close(m.bottomSkinMm, 0.25 + 3 * 0.3);
    close(m.topSkinMm, 1.5);
    assert.equal(printModel({}).flowMm3s, 11);
  });

  test('band volumes split by column overlap', () => {
    const full = estimateTile(BOX, THREE, project({ infillPct: 100 }));
    assert.deepEqual(full.byBand.map((b) => b.filamentId), ['pla-forest-green', 'pla-silk-gold', 'my-white']);
    close(full.byBand[0].volumeMm3, AREA * 4);
    close(full.byBand[1].volumeMm3, AREA * 3);
    close(full.byBand[2].volumeMm3, AREA * 3);
    // grams use each filament's material density (PLA 1.24, PLA-Silk 1.32, custom PETG 1.27)
    close(full.byFilament['pla-forest-green'].grams, AREA * 4 / 1000 * 1.24);
    close(full.byFilament['pla-silk-gold'].grams, AREA * 3 / 1000 * 1.32);
    close(full.byFilament['my-white'].grams, AREA * 3 / 1000 * 1.27);
    close(full.grams, AREA * (4 * 1.24 + 3 * 1.32 + 3 * 1.27) / 1000);
    assert.equal(full.colorChanges, 2);
    close(full.minutes, AREA * 10 / 11 / 60 + 50 * 4 / 60 + 2 * 3);

    // 15 %: [0,4) = 0.8 skin + 3.2 infill, [4,7) = infill, [7,10) = 2 infill + 1 top skin
    const part = estimateTile(BOX, THREE, project());
    close(part.byBand[0].solidMm3, RING * 4 + INNER * (0.8 + 0.15 * 3.2));
    close(part.byBand[1].solidMm3, RING * 3 + INNER * 0.15 * 3);
    close(part.byBand[2].solidMm3, RING * 3 + INNER * (0.15 * 2 + 1));
    close(part.solidMm3, RING * 10 + INNER * (1.8 + 0.15 * 8.2));
  });

  test('bands above the tile are not printed and do not count as colour changes', () => {
    const bands = [...THREE.slice(0, 2), band('my-white', 7, 12), band('pla-jet-black', 12)];
    const e = estimateTile(tile(100, 80, 11, 9, () => 6), bands, project());
    assert.equal(e.colorChanges, 1);
    assert.equal(e.byBand[2].volumeMm3, 0);
    assert.equal(e.byFilament['my-white'].grams, 0);
  });

  test('bottom pockets are subtracted from the lowest band', () => {
    // bottom grid at 5 mm spacing; 5 × 5 interior samples 2 mm deep (each 25 mm²)
    const bnx = 21;
    const bny = 17;
    const bz = new Float32Array(bnx * bny);
    for (let r = 4; r <= 8; r++) for (let c = 6; c <= 10; c++) bz[r * bnx + c] = 2;
    const pocketed = { ...BOX, bottom: { nx: bnx, ny: bny, z: bz } };
    const pocket = 25 * 25 * 2;

    const full = estimateTile(pocketed, THREE, project({ infillPct: 100 }));
    close(full.pocketMm3, pocket);
    close(full.volumeMm3, AREA * 10 - pocket);
    close(full.byBand[0].volumeMm3, AREA * 4 - pocket);
    close(full.byBand[1].volumeMm3, AREA * 3);
    close(full.solidMm3, AREA * 10 - pocket);

    // 15 %: the bottom skin moves up onto the pocket ceiling, so only the displaced infill is saved
    const plain = estimateTile(BOX, THREE, project());
    const part = estimateTile(pocketed, THREE, project());
    close(plain.solidMm3 - part.solidMm3, 25 * 25 * 2 * 0.15);
    close(plain.byBand[0].solidMm3 - part.byBand[0].solidMm3, 25 * 25 * 2 * 0.15);
    close(part.byBand[1].solidMm3, plain.byBand[1].solidMm3);
  });

  test('top skin is slope-corrected', () => {
    // plane z = 5 + 0.1·x, no walls: solid = (1-f)·(bottomSkin + topSkin·√1.01)·A + f·V
    const plane = tile(100, 100, 11, 11, (x) => 5 + 0.1 * x);
    const e = estimateTile(plane, SINGLE, project({ walls: 0 }));
    close(e.volumeMm3, 100 * 100 * 10);
    close(e.solidMm3, 0.85 * (0.8 + 1.0 * Math.sqrt(1.01)) * 1e4 + 0.15 * 1e5);
    close(e.maxZ, 15, 1e-6);
  });

  test('without bands everything is printed in the single filament', () => {
    const e = estimateTile(BOX, [], project());
    assert.deepEqual(Object.keys(e.byFilament), ['pla-snow-white']);
  });

  test('handles a 1M-sample tile in well under 200 ms', () => {
    const n = 1000;
    const big = tile(246, 246, n, n, (x, y) => 3 + 20 * (0.5 + 0.5 * Math.sin(x / 15) * Math.cos(y / 21)));
    const p = { ...project(), colors: { mode: 'bands', autoFit: true, themeId: 'hypsometric-atlas', layerHeightMm: 0.2, firstLayerMm: 0.2 } };
    const bands = resolveBands(p, { floorM: 0, mmPerM: 0.005, baseMm: 3, exaggeration: 1, minElevM: 0, maxElevM: 4000, maxZMm: 23 });
    assert.equal(bands.length, 5);
    let best = Infinity;
    let e;
    for (let i = 0; i < 3; i++) {
      const t0 = performance.now();
      e = estimateTile(big, bands, p);
      best = Math.min(best, performance.now() - t0);
    }
    assert.ok(best < 200, `took ${best.toFixed(1)} ms`);
    assert.ok(e.grams > 0 && e.colorChanges === 4);
  });
});

describe('estimateProject', () => {
  test('totals equal the sum of the tiles; cost and spools per filament', () => {
    const p = project({ infillPct: 100 });
    const tiles = [
      estimateTile(BOX, THREE, p),
      estimateTile({ ...tile(100, 80, 11, 9, () => 5), label: 'A2' }, THREE, p),
    ];
    const total = estimateProject(tiles, THREE, p);
    close(total.grams, tiles[0].grams + tiles[1].grams);
    close(total.metres, tiles[0].metres + tiles[1].metres);
    close(total.minutes, tiles[0].minutes + tiles[1].minutes);
    assert.equal(total.colorChanges, 2 + 1);
    close(total.longestTileMinutes, tiles[0].minutes);
    assert.equal(total.tiles.length, 2);
    assert.deepEqual(total.byFilament.map((f) => f.filamentId), ['pla-forest-green', 'pla-silk-gold', 'my-white']);

    const [green, gold, mine] = total.byFilament;
    close(green.grams, AREA * 8 / 1000 * 1.24);
    close(green.cost, green.grams / 1000 * 20); // PLA price
    close(gold.cost, gold.grams / 1000 * 25); // PLA-Silk price
    close(mine.cost, mine.grams / 1000 * 40); // the custom filament's own price
    assert.equal(mine.name, 'My White');
    assert.equal(mine.material, 'PETG');
    close(total.cost, green.cost + gold.cost + mine.cost);
    assert.deepEqual(total.byFilament.map((f) => f.spools), [1, 1, 1]);
    assert.equal(total.spools, 3);
    assert.deepEqual(total.notOwned, []);
  });

  test('spools round up per filament and unowned filaments are reported', () => {
    // 250 × 250 × 20 mm at 100 % infill = 1250 cm³ ≈ 1550 g of PLA → 2 spools
    const p = project({ infillPct: 100 }, { filaments: { owned: ['pla-snow-white', 'pla-olive'], custom: [] } });
    const big = estimateTile(tile(250, 250, 6, 6, () => 20), SINGLE, p);
    const total = estimateProject([big], SINGLE, p);
    close(total.grams, 1250 * 1.24);
    assert.equal(total.byFilament[0].spools, 2);
    assert.equal(total.spools, 2);
    assert.deepEqual(total.notOwned, []);
    const other = estimateProject([estimateTile(BOX, THREE, p)], THREE, p);
    assert.deepEqual(other.notOwned, ['pla-forest-green', 'pla-silk-gold', 'my-white']);
  });

  test('empty project', () => {
    const total = estimateProject([], SINGLE, project());
    assert.deepEqual([total.grams, total.cost, total.spools, total.byFilament.length], [0, 0, 0, 0]);
  });
});
