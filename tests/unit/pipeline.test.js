// Integration tests of engine/pipeline.js: stored elevation data → artwork → tiles → watertight
// meshes → STL / 3MF, for every art style, exactly as the worker and scripts/export.mjs run it.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { DATA_URL, fileFetch, readJSON } from './helpers.js';
import {
  PREVIEW_MAX_SAMPLES, buildPreview, buildTiles, computeArtwork, encodeTileFile, estimateTiles, meshTile,
  previewResolution, sanitizePrefix, tileFileName,
} from '../../app/js/engine/pipeline.js';
import { normalizeProject } from '../../app/js/state/store.js';
import { createDefaultProject } from '../../app/js/state/project.js';
import { ART_STYLES } from '../../app/js/catalog/artStyles.js';
import { checkWatertight, meshStats } from '../../app/js/mesh/analyze.js';
import { parseBinarySTL } from '../../app/js/mesh/stl.js';
import { strFromU8, unzipSync } from '../../app/vendor/fflate/fflate.js';

const regionsIndex = await readJSON('data/regions.json');
const ctx = { regionsIndex, dataBaseUrl: DATA_URL.href, fetchImpl: fileFetch };

/** A small Mount Fuji project (2 × 1 tiles of 60 mm, coarse export grid → fast). */
function fuji(overrides = {}) {
  return normalizeProject({
    name: 'Fuji pipeline',
    regionId: 'fuji',
    frame: { lat: 35.36, lon: 138.73, widthKm: 24, rotationDeg: 0 },
    layout: { cols: 2, rows: 1, tileW: 60, tileH: 60 },
    relief: { resolutionMm: 0.5, smoothingMm: 0.3 },
    ...overrides,
  });
}

describe('defaults', () => {
  test('the default project fits the relief to ~30 mm automatically and matches the X1 build volume', () => {
    const p = createDefaultProject();
    assert.equal(p.relief.autoExaggeration, true);
    assert.equal(p.relief.targetReliefMm, 30);
    assert.equal(p.printer.maxZ, 256);
  });

  test('the whole-Alps default previews from stored data with a ~30 mm relief', async () => {
    const project = normalizeProject(createDefaultProject());
    const artwork = await computeArtwork(project, { ...ctx, quality: 'preview' });
    assert.equal(artwork.stats.source, 'local');
    assert.ok(artwork.layout.nx * artwork.layout.ny <= PREVIEW_MAX_SAMPLES);
    const relief = artwork.zmap.maxZMm - artwork.zmap.baseMm;
    assert.ok(relief > 27 && relief < 33, `relief ${relief.toFixed(1)} mm`);
    assert.ok(artwork.zmap.exaggeration > 3 && artwork.zmap.exaggeration < 10, `exaggeration ${artwork.zmap.exaggeration}`);
  });
});

describe('computeArtwork', () => {
  test('reports progress with fractions in [0, 1] for every stage', async () => {
    const seen = [];
    await computeArtwork(fuji({ frame: { lat: 35.37, lon: 138.72, widthKm: 23, rotationDeg: 0 } }), {
      ...ctx, quality: 'export', onProgress: (p) => seen.push(p),
    });
    assert.ok(seen.length >= 3);
    for (const p of seen) assert.ok(p.fraction >= 0 && p.fraction <= 1 && typeof p.message === 'string', JSON.stringify(p));
    assert.deepEqual([...new Set(seen.map((p) => p.stage))], ['data', 'sample', 'model']);
  });

  test('zmap.maxZMm is the real highest point of the artwork (terrain value kept separately)', async () => {
    const emboss = await computeArtwork(fuji({ style: { id: 'contours', params: { mode: 'emboss', depthMm: 1 } } }), { ...ctx, quality: 'preview' });
    let max = 0;
    for (const v of emboss.field.z) max = Math.max(max, v);
    assert.ok(Math.abs(emboss.zmap.maxZMm - max) < 1e-3);

    // ~12 ribs on a 60 mm tall artwork, each 1 mm above the previous one (the summit rib is ~6th).
    const ribs = await computeArtwork(fuji({ style: { id: 'ridgelines', params: { staggerMm: 1 } } }), { ...ctx, quality: 'preview' });
    assert.ok(ribs.zmap.maxZMm > ribs.zmap.terrainMaxZMm + 3, `${ribs.zmap.maxZMm} vs terrain ${ribs.zmap.terrainMaxZMm}`);

    const litho = await computeArtwork(fuji({ style: { id: 'lithophane', params: {} } }), { ...ctx, quality: 'preview' });
    assert.ok(litho.zmap.maxZMm <= 3.2 + 1e-6, `lithophane max ${litho.zmap.maxZMm}`);
    assert.ok(litho.zmap.terrainMaxZMm > 10);
  });

  test('previewResolution keeps the preview grid within the sample budget', () => {
    const p = normalizeProject({ layout: { cols: 8, rows: 8, tileW: 300, tileH: 300 } });
    const res = previewResolution(p);
    const n = (8 * Math.round(300 / res) + 1) ** 2;
    assert.ok(n <= PREVIEW_MAX_SAMPLES, `${n} samples`);
  });
});

describe('every art style exports watertight tiles', () => {
  for (const style of ART_STYLES) {
    test(style.id, async () => {
      const project = fuji({ style: { id: style.id, params: {} }, back: { labels: true, magnets: { enabled: true, perTile: 2, insetMm: 15 } } });
      const artwork = await computeArtwork(project, { ...ctx, quality: 'export' });
      const tiles = buildTiles(artwork, project, { quality: 'export' });
      assert.deepEqual(tiles.map((t) => t.label), ['A1', 'A2']);
      const { bands, estimate } = estimateTiles(tiles, project, artwork.zmap);
      assert.ok(estimate.grams > 0);
      for (const tile of tiles) {
        assert.ok(tile.bottom, 'labels and magnets give every tile a back grid');
        const mesh = meshTile(tile, project, { quality: 'export', toleranceMm: artwork.field.meshToleranceMm });
        const wt = checkWatertight(mesh);
        assert.ok(wt.ok, `${style.id} ${tile.label}: ${JSON.stringify(wt)}`);
        const stats = meshStats(mesh);
        assert.ok(stats.volumeMm3 > 0);
        assert.ok(stats.bbox.min[2] >= -1e-6 && stats.bbox.max[2] <= artwork.zmap.maxZMm + 1e-3);
        assert.ok(Math.abs(stats.bbox.max[0] - 60) < 1e-3 && Math.abs(stats.bbox.max[1] - 60) < 1e-3);

        // STL round trip keeps the topology.
        const stl = encodeTileFile(mesh, { format: 'stl', name: `fuji ${tile.label}`, bands });
        assert.ok(checkWatertight(parseBinarySTL(stl)).ok);
      }
    });
  }
});

describe('encodeTileFile', () => {
  test('3MF carries the object and the colour changes one layer above each change height', async () => {
    const project = fuji({ colors: { layerHeightMm: 0.16, firstLayerMm: 0.2 } });
    const artwork = await computeArtwork(project, { ...ctx, quality: 'export' });
    const tiles = buildTiles(artwork, project, { quality: 'export' });
    const { bands } = estimateTiles(tiles, project, artwork.zmap);
    const used = bands.slice(1).filter((b) => !b.unused);
    assert.ok(used.length >= 2, 'Alpine Classic gives several colour changes on Fuji');
    const mesh = meshTile(tiles[0], project, { quality: 'export' });
    const bytes = new Uint8Array(encodeTileFile(mesh, {
      format: '3mf', name: 'fuji A1', title: 'Fuji – tile A1', bands, layerHeightMm: project.colors.layerHeightMm,
    }));
    const files = unzipSync(bytes);
    const model = strFromU8(files['3D/3dmodel.model']);
    assert.equal((model.match(/<triangle /g) ?? []).length, mesh.indices.length / 3);
    const changes = files['Metadata/Prusa_Slicer_custom_gcode_per_print_z.xml'];
    assert.ok(changes, `colour change file in ${Object.keys(files).join(', ')}`);
    const printZ = [...strFromU8(changes).matchAll(/print_z="([\d.]+)"/g)].map((m) => Number(m[1]));
    assert.deepEqual(printZ, used.map((b) => Number((b.zFrom + 0.16).toFixed(4))));
  });

  test('file names are sanitised', () => {
    assert.equal(sanitizePrefix('  Matterhorn & Monte Rosa! '), 'Matterhorn-Monte-Rosa');
    assert.equal(tileFileName('the alps', 'B3', '3mf'), 'the-alps_B3.3mf');
    assert.equal(sanitizePrefix('***'), 'relief');
  });
});

describe('buildPreview', () => {
  test('returns tile meshes with water flags, bands and an estimate', async () => {
    const project = fuji();
    const artwork = await computeArtwork(project, { ...ctx, quality: 'preview' });
    const preview = buildPreview(artwork, project);
    assert.equal(preview.tiles.length, 2);
    for (const t of preview.tiles) {
      assert.ok(t.mesh.indices.length > 0);
      assert.equal(t.mesh.water.length, t.mesh.positions.length / 3);
    }
    assert.ok(preview.bands.length >= 1 && preview.estimate.grams > 0);
    assert.equal(preview.zmap, artwork.zmap);
  });
});
