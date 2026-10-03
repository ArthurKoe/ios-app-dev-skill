import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { PRINTERS, DEFAULT_PRINTER_ID, getPrinter, printerGroups, printerLabel } from '../../app/js/catalog/printers.js';
import { MATERIALS, getMaterial } from '../../app/js/catalog/materials.js';
import { FILAMENTS, FINISHES, FILAMENT_FAMILIES, allFilaments, getFilament } from '../../app/js/catalog/filaments.js';
import { THEMES, DEFAULT_THEME_ID, applyTheme, getTheme } from '../../app/js/catalog/themes.js';
import { ART_STYLES, styleParams, getArtStyle, artStyleDefaults, isParamVisible } from '../../app/js/catalog/artStyles.js';
import { effectiveBandSpecs, resolveBands, formatColorChangeTable, elevationToZ } from '../../app/js/catalog/bands.js';

const HEX = /^#[0-9a-f]{6}$/;

/** Minimal project with the DEFAULT_PROJECT colour settings. */
function project(colors = {}, extra = {}) {
  return {
    relief: { maxHeightMm: 0 },
    style: { id: 'classic', params: {} },
    filaments: { owned: [], custom: [] },
    ...extra,
    colors: {
      mode: 'bands',
      themeId: 'alpine-classic',
      autoFit: false,
      bands: [
        { filamentId: 'pla-forest-green', fromM: null },
        { filamentId: 'pla-olive', fromM: 900 },
        { filamentId: 'pla-stone-grey', fromM: 1800 },
        { filamentId: 'pla-snow-white', fromM: 2700 },
      ],
      singleFilamentId: 'pla-snow-white',
      layerHeightMm: 0.2,
      firstLayerMm: 0.2,
      ...colors,
    },
  };
}

// 1 m of elevation = 0.01 mm, floor 0, base 3 mm: elevation e → z = 3 + e/100.
const ZMAP = { floorM: 0, mmPerM: 0.01, baseMm: 3, exaggeration: 4, minElevM: 0, maxElevM: 4000, maxZMm: 43 };

describe('printers', () => {
  test('ids are unique, sizes positive, default and custom exist', () => {
    const ids = PRINTERS.map((p) => p.id);
    assert.equal(new Set(ids).size, ids.length);
    for (const p of PRINTERS) {
      assert.ok(p.bedW > 0 && p.bedH > 0 && p.maxZ > 0, p.id);
      assert.ok(p.name && p.brand && p.group, p.id);
    }
    assert.equal(DEFAULT_PRINTER_ID, 'bambu-x1');
    assert.ok(ids.includes('custom'));
  });

  test('build volumes of well-known printers', () => {
    const dims = (id) => { const p = getPrinter(id); return [p.bedW, p.bedH, p.maxZ]; };
    assert.deepEqual(dims('bambu-x1'), [256, 256, 256]);
    assert.deepEqual(dims('bambu-a1-mini'), [180, 180, 180]);
    assert.deepEqual(dims('bambu-h2d'), [350, 320, 325]);
    assert.deepEqual(dims('prusa-mk4s'), [250, 210, 220]);
    assert.deepEqual(dims('prusa-core-one'), [250, 220, 270]);
    assert.deepEqual(dims('prusa-xl'), [360, 360, 360]);
    assert.deepEqual(dims('creality-k1-max'), [300, 300, 300]);
    assert.deepEqual(dims('creality-k2-plus'), [350, 350, 350]);
    assert.deepEqual(dims('elegoo-neptune4-pro'), [225, 225, 265]);
    assert.deepEqual(dims('anycubic-kobra3'), [250, 250, 260]);
  });

  test('lookup, grouping and labels', () => {
    assert.equal(getPrinter('no-such-printer').id, 'custom');
    const groups = printerGroups();
    assert.equal(groups.reduce((n, g) => n + g.printers.length, 0), PRINTERS.length);
    assert.equal(groups[0].group, 'Bambu Lab');
    assert.equal(printerLabel(getPrinter('bambu-a1-mini')), 'Bambu Lab A1 mini');
  });
});

describe('materials', () => {
  test('densities and prices', () => {
    const expected = { PLA: 1.24, 'PLA-Matte': 1.31, 'PLA-Silk': 1.32, 'PLA-Marble': 1.26, 'PLA-Wood': 1.15, PETG: 1.27, ABS: 1.04, ASA: 1.07 };
    for (const [id, density] of Object.entries(expected)) {
      assert.equal(MATERIALS[id].densityGcm3, density, id);
      assert.equal(MATERIALS[id].id, id);
      assert.ok(MATERIALS[id].pricePerKg > 0 && MATERIALS[id].minLayer > 0 && MATERIALS[id].notes.length > 10, id);
    }
    assert.equal(getMaterial('unobtainium').id, 'PLA');
  });
});

describe('filaments', () => {
  test('presets are valid and reference known materials and finishes', () => {
    assert.ok(FILAMENTS.length >= 35);
    const ids = FILAMENTS.map((f) => f.id);
    assert.equal(new Set(ids).size, ids.length);
    for (const f of FILAMENTS) {
      assert.match(f.color, HEX, f.id);
      assert.ok(f.finish in FINISHES, `${f.id} finish ${f.finish}`);
      assert.ok(f.material in MATERIALS, `${f.id} material ${f.material}`);
      assert.ok(f.family in FILAMENT_FAMILIES, `${f.id} family`);
    }
    for (const id of ['pla-snow-white', 'pla-forest-green', 'pla-olive', 'pla-stone-grey']) assert.ok(ids.includes(id), id);
    assert.deepEqual(
      { ...getFilament(null, 'pla-snow-white') },
      { id: 'pla-snow-white', name: 'Snow White', material: 'PLA', color: '#f4f4f1', finish: 'matte', family: 'neutral' },
    );
  });

  test('every finish has render properties', () => {
    for (const finish of ['basic', 'matte', 'silk', 'metallic', 'marble', 'wood', 'glitter', 'translucent']) {
      const f = FINISHES[finish];
      assert.ok(f.label, finish);
      assert.ok(f.roughness >= 0 && f.roughness <= 1 && f.metalness >= 0 && f.metalness <= 1, finish);
    }
    assert.deepEqual([FINISHES.matte.roughness, FINISHES.matte.metalness], [0.92, 0]);
    assert.deepEqual([FINISHES.silk.roughness, FINISHES.silk.metalness], [0.35, 0.45]);
  });

  test('custom filaments are listed, override presets and unknown ids fall back', () => {
    const p = {
      filaments: {
        custom: [
          { id: 'my-red', name: 'My Red', color: '#AA0000', material: 'PETG', finish: 'silk', pricePerKg: 31 },
          { id: 'pla-olive', name: 'Olive (my brand)', color: '#707040' },
          { id: 'broken', color: 'red', finish: 'shiny' },
        ],
      },
    };
    const all = allFilaments(p);
    assert.equal(all.length, FILAMENTS.length + 2);
    assert.equal(all.find((f) => f.id === 'pla-olive').name, 'Olive (my brand)');
    assert.equal(all.at(-2).id, 'my-red');
    assert.deepEqual(getFilament(p, 'my-red'), {
      id: 'my-red', name: 'My Red', material: 'PETG', color: '#aa0000', finish: 'silk', family: 'custom', custom: true, pricePerKg: 31,
    });
    const broken = getFilament(p, 'broken');
    assert.equal(broken.color, '#9a9a9a');
    assert.equal(broken.finish, 'basic');
    const unknown = getFilament(p, 'nope');
    assert.equal(unknown.id, 'nope');
    assert.equal(unknown.missing, true);
    assert.match(unknown.color, HEX);
    assert.equal(allFilaments(undefined).length, FILAMENTS.length);
  });
});

describe('themes', () => {
  test('ids unique, required themes exist, every filament resolves', () => {
    const ids = THEMES.map((t) => t.id);
    assert.equal(new Set(ids).size, ids.length);
    assert.ok(THEMES.length >= 12);
    for (const id of ['alpine-classic', 'snowcapped', 'museum-plaster', 'glacier', 'desert-canyon', 'gold-peaks',
      'midnight-silver', 'hypsometric-atlas', 'forest-stone', 'copper-ridge', 'island', 'woodcut', 'marble']) {
      assert.ok(getTheme(id), id);
    }
    assert.equal(DEFAULT_THEME_ID, 'alpine-classic');
    for (const t of THEMES) {
      assert.ok(t.name && t.description, t.id);
      assert.equal(t.mode, t.bands.length > 1 ? 'bands' : 'single', t.id);
      assert.equal(t.bands[0].fromFrac, undefined, t.id);
      assert.equal(t.bands[0].fromM, undefined, t.id);
      let lastFrac = 0;
      t.bands.forEach((b, i) => {
        assert.equal(getFilament(null, b.filamentId).missing, undefined, `${t.id}: ${b.filamentId}`);
        if (i > 0 && b.fromFrac !== undefined) {
          assert.ok(b.fromFrac > lastFrac && b.fromFrac < 1, `${t.id} fractions ascending`);
          lastFrac = b.fromFrac;
        }
        if (i > 0) assert.ok(Number.isFinite(b.fromFrac) || Number.isFinite(b.fromM), `${t.id} band ${i} threshold`);
      });
    }
    assert.equal(getTheme('museum-plaster').mode, 'single');
    assert.equal(getTheme('nope'), null);
  });

  test('applyTheme maps fractions to floor..max and passes fromM through', () => {
    const zmap = { floorM: 200, maxElevM: 4200 };
    assert.deepEqual(applyTheme(getTheme('alpine-classic'), zmap), [
      { filamentId: 'pla-forest-green', fromM: null },
      { filamentId: 'pla-olive', fromM: 960 },
      { filamentId: 'pla-stone-grey', fromM: 1680 },
      { filamentId: 'pla-snow-white', fromM: 2440 },
    ]);
    const island = applyTheme(getTheme('island'), { floorM: 0, maxElevM: 3700 });
    assert.deepEqual(island.map((b) => b.fromM), [null, 1, 30, Math.round(0.45 * 3700), Math.round(0.85 * 3700)]);
    assert.deepEqual(applyTheme(getTheme('museum-plaster'), zmap), [{ filamentId: 'pla-matte-bone', fromM: null }]);
    assert.deepEqual(applyTheme(null, zmap), []);
  });
});

describe('art styles', () => {
  // The contract table (docs/ARCHITECTURE.md).
  const TABLE = {
    classic: {},
    terraced: { stepMode: 'count', count: 16, stepM: 200, snapToLayers: true },
    lowpoly: { facetMm: 1.2 },
    ridgelines: { spacingMm: 5, thicknessMm: 1.2, direction: 'horizontal', staggerMm: 0 },
    hex: { shape: 'hex', cellMm: 8, gapMm: 0.6, stepMm: 0 },
    contours: { intervalM: 200, majorEvery: 5, lineWidthMm: 0.6, depthMm: 0.4, mode: 'engrave' },
    lithophane: { minMm: 0.8, maxMm: 3.2, sunAzimuth: 315, sunAltitude: 35, contrast: 1 },
  };

  test('seven styles with defaults exactly as in the contract table', () => {
    assert.deepEqual(ART_STYLES.map((s) => s.id), Object.keys(TABLE));
    for (const s of ART_STYLES) {
      assert.deepEqual(artStyleDefaults(s.id), TABLE[s.id], s.id);
      assert.deepEqual(styleParams({ style: { id: s.id, params: {} } }), TABLE[s.id], s.id);
    }
  });

  test('styles and params are complete for the UI', () => {
    for (const s of ART_STYLES) {
      assert.ok(s.name && s.description, s.id);
      assert.match(s.icon, /^<svg [^>]*viewBox="0 0 48 48"[^>]*>.*<\/svg>$/s, s.id);
      assert.match(s.icon, /stroke="currentColor"/, s.id);
      assert.equal(typeof s.supportsBands, 'boolean');
      assert.equal(typeof s.usesBase, 'boolean');
      const keys = s.params.map((p) => p.key);
      for (const p of s.params) {
        assert.ok(p.label && p.help, `${s.id}.${p.key}`);
        assert.ok(['range', 'number', 'select', 'checkbox'].includes(p.type));
        assert.equal(typeof p.unit, 'string');
        if (p.type === 'range' || p.type === 'number') {
          assert.ok(p.min <= p.default && p.default <= p.max && p.step > 0, `${s.id}.${p.key} range`);
        }
        if (p.type === 'select') assert.ok(p.options.some(([v]) => v === p.default), `${s.id}.${p.key} options`);
        if (p.type === 'checkbox') assert.equal(typeof p.default, 'boolean');
        for (const [k, v] of Object.entries(p.showIf ?? {})) {
          const ref = s.params.find((q) => q.key === k);
          assert.ok(keys.includes(k) && (ref.type !== 'select' || ref.options.some(([o]) => o === v)), `${s.id}.${p.key} showIf`);
        }
      }
    }
    const litho = getArtStyle('lithophane');
    assert.deepEqual([litho.supportsBands, litho.usesBase], [false, false]);
    assert.ok(ART_STYLES.filter((s) => s.id !== 'lithophane').every((s) => s.supportsBands && s.usesBase));
  });

  test('styleParams merges, validates and clamps', () => {
    const p = { style: { id: 'hex', params: { cellMm: 12, gapMm: 99, shape: 'triangle', stepMm: '0.5', stale: 1 } } };
    assert.deepEqual(styleParams(p), { shape: 'hex', cellMm: 12, gapMm: 3, stepMm: 0.5 });
    assert.deepEqual(styleParams({ style: { id: 'terraced', params: { snapToLayers: 'yes', count: NaN } } }),
      { stepMode: 'count', count: 16, stepM: 200, snapToLayers: true });
    assert.deepEqual(styleParams({ style: { id: 'unknown' } }), {});
    assert.deepEqual(styleParams({}), {});
  });

  test('showIf controls visibility', () => {
    const terraced = getArtStyle('terraced');
    const count = terraced.params.find((p) => p.key === 'count');
    const stepM = terraced.params.find((p) => p.key === 'stepM');
    assert.equal(isParamVisible(count, { stepMode: 'count' }), true);
    assert.equal(isParamVisible(stepM, { stepMode: 'count' }), false);
    assert.equal(isParamVisible(stepM, { stepMode: 'meters' }), true);
    assert.equal(isParamVisible(terraced.params[0], {}), true);
  });
});

describe('bands', () => {
  test('effectiveBandSpecs: single, manual, autoFit theme, lithophane', () => {
    assert.deepEqual(effectiveBandSpecs(project({ mode: 'single', singleFilamentId: 'pla-silk-gold' }), ZMAP),
      [{ filamentId: 'pla-silk-gold', fromM: null }]);
    assert.deepEqual(effectiveBandSpecs(project(), ZMAP).map((b) => b.fromM), [null, 900, 1800, 2700]);
    assert.deepEqual(effectiveBandSpecs(project({ autoFit: true }), ZMAP), applyTheme(getTheme('alpine-classic'), ZMAP));
    // autoFit without terrain or with an unknown theme keeps the manual bands
    assert.deepEqual(effectiveBandSpecs(project({ autoFit: true }), null).map((b) => b.fromM), [null, 900, 1800, 2700]);
    assert.equal(effectiveBandSpecs(project({ autoFit: true, themeId: 'nope' }), ZMAP).length, 4);
    // lithophane prints in one filament
    assert.deepEqual(effectiveBandSpecs(project({}, { style: { id: 'lithophane' } }), ZMAP),
      [{ filamentId: 'pla-snow-white', fromM: null }]);
    // empty band list falls back to the single filament; first band never has a threshold
    assert.deepEqual(effectiveBandSpecs(project({ bands: [] }), ZMAP), [{ filamentId: 'pla-snow-white', fromM: null }]);
    assert.deepEqual(effectiveBandSpecs(project({ bands: [{ filamentId: 'pla-olive', fromM: 500 }] }), ZMAP),
      [{ filamentId: 'pla-olive', fromM: null }]);
  });

  test('resolveBands snaps changes to layer tops with correct layer numbers', () => {
    // z(900) = 12.0 → k = (12.0-0.2)/0.2 = 59 → layer 61; z(1800) = 21.0 → k = 104; z(2700) = 30.0 → k = 149
    const bands = resolveBands(project(), ZMAP);
    assert.deepEqual(bands.map((b) => [b.filamentId, b.zFrom, b.zTo, b.layerFrom, b.elevFromM, b.unused]), [
      ['pla-forest-green', 0, 12, 1, null, false],
      ['pla-olive', 12, 21, 61, 900, false],
      ['pla-stone-grey', 21, 30, 106, 1800, false],
      ['pla-snow-white', 30, Infinity, 151, 2700, false],
    ]);
    const green = getFilament(null, 'pla-forest-green');
    assert.deepEqual([bands[0].color, bands[0].finish, bands[0].name], [green.color, green.finish, green.name]);
    assert.deepEqual(bands.map((b) => b.specIndex), [0, 1, 2, 3]);
  });

  test('layer formula with a thicker first layer and rounding to the nearest layer top', () => {
    // first 0.3, h 0.12: z(1000) = 13.0 → k = round(12.7/0.12) = round(105.83) = 106 → z = 0.3 + 12.72 = 13.02
    const p = project({ firstLayerMm: 0.3, layerHeightMm: 0.12, bands: [
      { filamentId: 'pla-forest-green', fromM: null }, { filamentId: 'pla-snow-white', fromM: 1000 }] });
    const [, white] = resolveBands(p, ZMAP);
    assert.equal(white.zFrom, 13.02);
    assert.equal(white.layerFrom, 108);
    // layer n ≥ 2 spans [first + (n-2)h, first + (n-1)h] → layer 108 starts at 0.3 + 106·0.12
    assert.equal(+(0.3 + (white.layerFrom - 2) * 0.12).toFixed(6), white.zFrom);
    // a threshold below the first layer top still starts at layer 2 (k clamped to 0)
    const low = resolveBands(project({ bands: [{ filamentId: 'pla-olive' }, { filamentId: 'pla-snow-white', fromM: -1e6 }] }),
      { ...ZMAP, baseMm: 0 });
    assert.deepEqual([low[1].zFrom, low[1].layerFrom], [0.2, 2]);
  });

  test('collapsed thresholds drop the emptied band, duplicates merge, high bands are flagged unused', () => {
    const p = project({ bands: [
      { filamentId: 'pla-forest-green', fromM: null },
      { filamentId: 'pla-olive', fromM: 900 }, // z 12.00
      { filamentId: 'pla-stone-grey', fromM: 905 }, // z 12.05 → same layer top as olive: olive is empty
      { filamentId: 'pla-stone-grey', fromM: 1500 }, // same filament again → merged
      { filamentId: 'pla-snow-white', fromM: 4500 }, // z 48 > maxZ 43 → unused
      { filamentId: 'pla-silk-gold', fromM: 'x' }, // invalid threshold → ignored
    ] });
    const bands = resolveBands(p, ZMAP);
    assert.deepEqual(bands.map((b) => [b.filamentId, b.zFrom, b.unused, b.specIndex]), [
      ['pla-forest-green', 0, false, 0],
      ['pla-stone-grey', 12, false, 2],
      ['pla-snow-white', 48, true, 4],
    ]);
    assert.equal(bands[1].zTo, 48);
    assert.equal(bands[2].zTo, Infinity);
    // a threshold below an earlier one hides the earlier band (later band wins)
    const out = resolveBands(project({ bands: [
      { filamentId: 'pla-forest-green' }, { filamentId: 'pla-olive', fromM: 2000 }, { filamentId: 'pla-snow-white', fromM: 1000 }] }), ZMAP);
    assert.deepEqual(out.map((b) => [b.filamentId, b.zFrom]), [['pla-forest-green', 0], ['pla-snow-white', 13]]);
  });

  test('thresholds below the floor land on the base top; maxHeightMm clamps', () => {
    const zmap = { ...ZMAP, floorM: 1000 };
    const [, olive] = resolveBands(project({ bands: [{ filamentId: 'pla-forest-green' }, { filamentId: 'pla-olive', fromM: 500 }] }), zmap);
    assert.equal(olive.zFrom, 3);
    assert.equal(elevationToZ(ZMAP, 2700, 20), 20);
    const clamped = resolveBands(project({}, { relief: { maxHeightMm: 20 } }), { ...ZMAP, maxZMm: 20 });
    assert.deepEqual(clamped.map((b) => [b.zFrom, b.unused]), [[0, false], [12, false], [20, true]]);
  });

  test('single mode and autoFit fractions', () => {
    const single = resolveBands(project({ mode: 'single' }), ZMAP);
    assert.equal(single.length, 1);
    assert.deepEqual([single[0].filamentId, single[0].zFrom, single[0].zTo, single[0].layerFrom], ['pla-snow-white', 0, Infinity, 1]);
    // alpine-classic over floor 0..4000 m: 760, 1480, 2240 m → z 10.6, 17.8, 25.4 mm
    const fitted = resolveBands(project({ autoFit: true }), ZMAP);
    assert.deepEqual(fitted.map((b) => [b.elevFromM, b.zFrom, b.layerFrom]), [[null, 0, 1], [760, 10.6, 54], [1480, 17.8, 90], [2240, 25.4, 128]]);
    // without a zmap only the first band can be resolved
    assert.deepEqual(resolveBands(project(), null).map((b) => b.filamentId), ['pla-forest-green']);
  });

  test('formatColorChangeTable lists the start filament and real changes only', () => {
    const p = project({ bands: [
      { filamentId: 'pla-forest-green' }, { filamentId: 'pla-olive', fromM: 900 }, { filamentId: 'pla-snow-white', fromM: 9000 }] });
    assert.deepEqual(formatColorChangeTable(resolveBands(p, ZMAP)), [
      { layer: 1, z: 0, filamentId: 'pla-forest-green', filamentName: 'Forest Green', color: getFilament(null, 'pla-forest-green').color },
      { layer: 61, z: 12, filamentId: 'pla-olive', filamentName: 'Olive', color: getFilament(null, 'pla-olive').color },
    ]);
  });
});
