import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import {
  DEFAULT_PROJECT, artworkAspect, boundsToRect, classifyChange, createDefaultProject,
  frameContainingRect, nudgeFrameInside, sameValue, slugify, wrapLon,
} from '../../app/js/state/project.js';
import { frameBounds } from '../../app/js/core/projection.js';
import { MIN_ABOVE_POCKET_MM, createStore, deepMerge, normalizeBands, normalizeProject } from '../../app/js/state/store.js';
import {
  STORAGE_KEY, base64UrlToBytes, bytesToBase64Url, createAutosave, loadInitialProject, loadLocal,
  projectFromHash, projectFromJSON, projectToHash, projectToJSON, saveLocal,
} from '../../app/js/state/persistence.js';

/** Minimal in-memory Storage. */
function memoryStorage(initial = {}) {
  const data = new Map(Object.entries(initial));
  return {
    getItem: (k) => (data.has(k) ? data.get(k) : null),
    setItem: (k, v) => data.set(k, String(v)),
    removeItem: (k) => data.delete(k),
    get size() { return data.size; },
  };
}

describe('DEFAULT_PROJECT', () => {
  test('matches the documented contract values', () => {
    assert.equal(DEFAULT_PROJECT.version, 1);
    assert.equal(DEFAULT_PROJECT.regionId, 'alps');
    assert.deepEqual(DEFAULT_PROJECT.frame, { lat: 45.95, lon: 10.75, widthKm: 900, heightKm: 450, rotationDeg: 0 });
    assert.deepEqual(DEFAULT_PROJECT.layout, { cols: 4, rows: 2, tileW: 246, tileH: 246 });
    assert.deepEqual(DEFAULT_PROJECT.printer, { presetId: 'bambu-x1', bedW: 256, bedH: 256, maxZ: 250, nozzleMm: 0.4 });
    assert.equal(DEFAULT_PROJECT.relief.exaggeration, 4);
    assert.deepEqual(DEFAULT_PROJECT.relief.water, { mode: 'recess', depthMm: 0.6 });
    assert.equal(DEFAULT_PROJECT.colors.bands.length, 4);
    assert.equal(DEFAULT_PROJECT.colors.bands[0].fromM, null);
    assert.deepEqual(DEFAULT_PROJECT.back.magnets, { enabled: false, diameterMm: 10.2, depthMm: 3.2, perTile: 4, insetMm: 25 });
    assert.equal(DEFAULT_PROJECT.view.wallColor, '#ece8e1');
  });

  test('is already normalised (normalizeProject is the identity on it)', () => {
    const warnings = [];
    assert.deepEqual(normalizeProject(DEFAULT_PROJECT, { warnings }), DEFAULT_PROJECT);
    assert.deepEqual(warnings, []);
  });

  test('is JSON-serialisable without loss', () => {
    assert.deepEqual(JSON.parse(JSON.stringify(DEFAULT_PROJECT)), DEFAULT_PROJECT);
  });

  test('createDefaultProject returns an independent copy', () => {
    const p = createDefaultProject();
    p.frame.lat = 0;
    p.colors.bands.push({ filamentId: 'x', fromM: 1 });
    assert.equal(DEFAULT_PROJECT.frame.lat, 45.95);
    assert.equal(DEFAULT_PROJECT.colors.bands.length, 4);
  });
});

describe('normalizeProject', () => {
  test('fills missing fields from defaults and ignores garbage', () => {
    const p = normalizeProject({ name: '  My   Alps ', frame: { lat: 'x', widthKm: 100 }, relief: null, colors: { bands: 'nope' } });
    assert.equal(p.name, 'My Alps');
    assert.equal(p.frame.lat, DEFAULT_PROJECT.frame.lat);
    assert.equal(p.frame.widthKm, 100);
    assert.deepEqual(p.relief, DEFAULT_PROJECT.relief);
    assert.deepEqual(p.colors.bands, DEFAULT_PROJECT.colors.bands);
    assert.deepEqual(normalizeProject(null), normalizeProject({}));
  });

  test('does not modify its input', () => {
    const input = createDefaultProject();
    input.layout.cols = 99;
    const copy = structuredClone(input);
    normalizeProject(input);
    assert.deepEqual(input, copy);
  });

  test('locks the frame aspect to the artwork aspect, keeping the width', () => {
    const p = normalizeProject({ ...createDefaultProject(), layout: { cols: 2, rows: 3, tileW: 200, tileH: 150 } });
    assert.equal(p.frame.widthKm, 900);
    assert.ok(Math.abs(p.frame.heightKm - 900 * (450 / 400)) < 1e-9);
    assert.ok(Math.abs(p.frame.heightKm / p.frame.widthKm - artworkAspect(p.layout)) < 1e-12);
  });

  test('clamps numbers and validates enums', () => {
    const p = normalizeProject({
      frame: { lat: 95, lon: 190, widthKm: -5, rotationDeg: 270 },
      layout: { cols: 20, rows: 0.2, tileW: 5, tileH: 5000 },
      relief: { exaggeration: 100, smoothingMm: -1, water: { mode: 'lava' }, floor: { mode: 'sky' } },
      source: 'cloud',
      colors: { mode: 'rainbow', layerHeightMm: 5 },
      print: { infillPct: 140, speedClass: 'warp' },
      view: { lighting: 'disco', wallColor: 'red' },
    });
    assert.equal(p.frame.lat, 84);
    assert.equal(p.frame.lon, -170);
    assert.equal(p.frame.widthKm, 0.5);
    assert.equal(p.frame.rotationDeg, -90);
    assert.equal(p.layout.cols, 8);
    assert.equal(p.layout.rows, 1);
    assert.equal(p.layout.tileW, 20);
    assert.equal(p.layout.tileH, 1000);
    assert.equal(p.relief.exaggeration, 30);
    assert.equal(p.relief.smoothingMm, 0);
    assert.equal(p.relief.water.mode, 'recess');
    assert.equal(p.relief.floor.mode, 'auto');
    assert.equal(p.source, 'auto');
    assert.equal(p.colors.mode, 'bands');
    assert.equal(p.colors.layerHeightMm, 0.6);
    assert.equal(p.print.infillPct, 100);
    assert.equal(p.print.speedClass, 'standard');
    assert.equal(p.view.lighting, 'gallery');
    assert.equal(p.view.wallColor, '#ece8e1');
  });

  test('raises the base above magnet pockets and warns', () => {
    const warnings = [];
    const p = normalizeProject({
      ...createDefaultProject(),
      back: { labels: true, labelDepthMm: 0.6, magnets: { enabled: true, diameterMm: 10, depthMm: 3.2, perTile: 4, insetMm: 25 } },
    }, { warnings });
    assert.equal(p.relief.baseMm, 3.2 + MIN_ABOVE_POCKET_MM);
    assert.equal(warnings.length, 1);
    assert.match(warnings[0], /magnet/);

    const ok = [];
    const thick = normalizeProject({ ...p, relief: { ...p.relief, baseMm: 6 } }, { warnings: ok });
    assert.equal(thick.relief.baseMm, 6);
    assert.deepEqual(ok, []);
  });

  test('keeps magnets disabled from forcing the base', () => {
    const p = normalizeProject({ relief: { baseMm: 1.6 } });
    assert.equal(p.relief.baseMm, 1.6); // labels 0.6 mm need only 1.4 mm
  });

  test('sorts bands and keeps exactly one bottom band', () => {
    const bands = normalizeBands([
      { filamentId: 'c', fromM: 2000 },
      { filamentId: 'a', fromM: null },
      { filamentId: 'b', fromM: 500.4 },
      { filamentId: 'z', fromM: null },
      { filamentId: '', fromM: 10 },
    ]);
    assert.deepEqual(bands, [
      { filamentId: 'a', fromM: null },
      { filamentId: 'b', fromM: 500 },
      { filamentId: 'c', fromM: 2000 },
    ]);
    const firstNotNull = normalizeBands([{ filamentId: 'b', fromM: 900 }, { filamentId: 'a', fromM: 100 }]);
    assert.deepEqual(firstNotNull, [{ filamentId: 'a', fromM: null }, { filamentId: 'b', fromM: 900 }]);
  });

  test('sanitises custom filaments, owned ids and style params', () => {
    const p = normalizeProject({
      filaments: {
        owned: ['a', 'a', 3, 'b'],
        custom: [{ id: 'my', name: ' Glacier ', color: '#ABCDEF', finish: 'silk', material: 'PETG', pricePerKg: 25 },
          { id: 'my', name: 'dup', color: 'nope' }, 'junk'],
      },
      style: { id: 'terraced', params: { count: 12, nested: { x: 1 }, snap: true, bad: NaN } },
    });
    assert.deepEqual(p.filaments.owned, ['a', 'b']);
    assert.deepEqual(p.filaments.custom, [{ id: 'my', name: 'Glacier', material: 'PETG', color: '#abcdef', finish: 'silk', pricePerKg: 25 }]);
    assert.deepEqual(p.style.params, { count: 12, snap: true });
  });
});

describe('createStore', () => {
  test('applies partial patches (deep merge), normalises and notifies', () => {
    const store = createStore(createDefaultProject());
    const calls = [];
    const off = store.subscribe((project, prev, info) => calls.push({ project, prev, info }));
    store.set({ layout: { cols: 2 } }, { source: 'test' });
    assert.equal(store.get().layout.cols, 2);
    assert.equal(store.get().layout.rows, 2);
    assert.equal(store.get().frame.heightKm, 900); // 492 × 492 artwork → square frame
    assert.equal(calls.length, 1);
    assert.equal(calls[0].info.source, 'test');
    assert.equal(calls[0].info.changes.terrain, true);
    assert.deepEqual(calls[0].info.changes.keys.sort(), ['frame', 'layout']);
    off();
    store.set({ name: 'x' });
    assert.equal(calls.length, 1);
  });

  test('accepts mutating or returning patch functions and freezes the state', () => {
    const store = createStore(createDefaultProject());
    store.set((d) => { d.colors.bands.reverse(); });
    assert.deepEqual(store.get().colors.bands, DEFAULT_PROJECT.colors.bands); // re-sorted ascending
    store.set(() => ({ ...createDefaultProject(), name: 'Returned' }));
    assert.equal(store.get().name, 'Returned');
    assert.throws(() => { 'use strict'; store.get().frame.lat = 1; }, TypeError);
  });

  test('passes warnings and extra meta to subscribers', () => {
    const store = createStore(createDefaultProject());
    let info;
    store.subscribe((p, prev, i) => { info = i; });
    store.set({ back: { magnets: { enabled: true } } }, { final: false });
    assert.equal(info.final, false);
    assert.equal(info.warnings.length, 1);
    assert.equal(store.get().relief.baseMm, 4);
  });

  test('notifies even when nothing changed (so controls can resync clamped input)', () => {
    const store = createStore(createDefaultProject());
    let info;
    store.subscribe((p, prev, i) => { info = i; });
    store.set({ layout: { cols: 4 } });
    assert.equal(info.changes.any, false);
  });
});

describe('project helpers', () => {
  test('classifyChange groups top-level keys', () => {
    const a = createDefaultProject();
    const b = structuredClone(a);
    b.colors.layerHeightMm = 0.12;
    b.view.exploded = true;
    const c = classifyChange(a, b);
    assert.deepEqual(c, { any: true, terrain: false, appearance: true, view: true, back: false, name: false, keys: ['colors', 'view'] });
    const d = structuredClone(a);
    d.style.params.count = 3;
    assert.equal(classifyChange(a, d).terrain, true);
    assert.equal(classifyChange(a, structuredClone(a)).any, false);
  });

  test('sameValue compares structurally', () => {
    assert.ok(sameValue({ a: [1, { b: null }] }, { a: [1, { b: null }] }));
    assert.ok(!sameValue({ a: [1] }, { a: [1, 2] }));
    assert.ok(!sameValue({ a: 1 }, { b: 1 }));
    assert.ok(sameValue(NaN, NaN));
  });

  test('frameContainingRect returns the smallest frame of the given aspect', () => {
    const wide = frameContainingRect({ lat: 10, lon: 20, widthKm: 100, heightKm: 20 }, 0.5);
    assert.deepEqual(wide, { lat: 10, lon: 20, widthKm: 100, heightKm: 50, rotationDeg: 0 });
    const tall = frameContainingRect({ lat: 10, lon: 20, widthKm: 30, heightKm: 40 }, 0.5);
    assert.equal(tall.widthKm, 80);
    assert.equal(tall.heightKm, 40);
  });

  test('nudgeFrameInside moves a widened preset frame back inside the stored bounds', () => {
    const bounds = { south: 35, west: 138, north: 36, east: 139 };
    const preset = { lat: 35.36, lon: 138.73, widthKm: 40, heightKm: 35 };
    const frame = frameContainingRect(preset, 0.5);
    assert.ok(frameBounds(frame).east > bounds.east, 'precondition: spills over the east edge');
    const nudged = nudgeFrameInside(frame, preset, bounds);
    const b = frameBounds(nudged);
    assert.ok(b.east <= bounds.east && b.west >= bounds.west && b.south >= bounds.south && b.north <= bounds.north);
    assert.equal(nudged.widthKm, frame.widthKm);
    // the preset rectangle is still inside the frame
    const kmPerDegLon = 111.32 * Math.cos((preset.lat * Math.PI) / 180);
    assert.ok(Math.abs(nudged.lon - preset.lon) * kmPerDegLon <= (frame.widthKm - preset.widthKm) / 2 + 1e-6);
    // already inside → unchanged; too large → shifted at most by the slack
    const inside = { lat: 35.5, lon: 138.5, widthKm: 20, heightKm: 10, rotationDeg: 0 };
    assert.deepEqual(nudgeFrameInside(inside, inside, bounds), inside);
    const huge = { lat: 35.5, lon: 138.9, widthKm: 300, heightKm: 150, rotationDeg: 0 };
    assert.deepEqual(nudgeFrameInside(huge, huge, bounds), huge);
  });

  test('boundsToRect, wrapLon and slugify', () => {
    const r = boundsToRect({ south: 0, west: 179, north: 1, east: -179 });
    assert.ok(Math.abs(r.lon - -180) < 1e-9 || Math.abs(r.lon - 180) < 1e-9);
    assert.ok(Math.abs(r.widthKm - 2 * 111.32 * Math.cos((0.5 * Math.PI) / 180)) < 1e-6);
    assert.equal(wrapLon(190), -170);
    assert.equal(wrapLon(-190), 170);
    assert.equal(slugify('Über die Alpen!'), 'uber-die-alpen');
    assert.equal(slugify('***'), 'relief');
  });

  test('deepMerge replaces arrays and merges objects', () => {
    const t = { a: { b: 1, c: [1, 2] }, d: 1 };
    deepMerge(t, { a: { c: [3] }, e: { f: 1 } });
    assert.deepEqual(t, { a: { b: 1, c: [3] }, d: 1, e: { f: 1 } });
  });
});

describe('persistence', () => {
  test('hash round trip preserves the project and uses base64url only', () => {
    const p = normalizeProject({
      ...createDefaultProject(),
      name: 'Matterhorn – Zermatt «äöü» 🏔',
      frame: { lat: 45.98, lon: 7.66, widthKm: 30, heightKm: 1, rotationDeg: 12.5 },
      filaments: { owned: ['pla-snow-white'], custom: [{ id: 'c1', name: 'Ice', color: '#a0c4ff', material: 'PLA', finish: 'silk' }] },
    });
    const hash = projectToHash(p);
    assert.match(hash, /^#p=[A-Za-z0-9_-]+$/);
    assert.deepEqual(projectFromHash(hash), p);
    assert.deepEqual(projectFromHash(hash.slice(1)), p);
  });

  test('invalid hashes decode to null', () => {
    assert.equal(projectFromHash(''), null);
    assert.equal(projectFromHash('#view=3d'), null);
    assert.equal(projectFromHash('#p=!!!not-base64'), null);
    assert.equal(projectFromHash('#p=' + bytesToBase64Url(new Uint8Array([1, 2, 3]))), null);
  });

  test('base64url helpers round trip arbitrary bytes', () => {
    const bytes = new Uint8Array(70000);
    for (let i = 0; i < bytes.length; i++) bytes[i] = (i * 7919) & 255;
    assert.deepEqual(base64UrlToBytes(bytesToBase64Url(bytes)), bytes);
  });

  test('JSON import/export', () => {
    const p = createDefaultProject();
    assert.deepEqual(projectFromJSON(projectToJSON(p)), p);
    assert.throws(() => projectFromJSON('{oops'), /not valid JSON/);
    assert.throws(() => projectFromJSON('{"hello":1}'), /does not look like/);
    assert.throws(() => projectFromJSON(JSON.stringify({ ...p, version: 7 })), /newer/);
  });

  test('localStorage helpers never throw', () => {
    const storage = memoryStorage();
    const p = normalizeProject({ name: 'Stored' });
    assert.equal(saveLocal(p, storage), true);
    assert.deepEqual(loadLocal(storage), p);
    const broken = { getItem() { throw new Error('denied'); }, setItem() { throw new Error('quota'); } };
    assert.equal(saveLocal(p, broken), false);
    assert.equal(loadLocal(broken), null);
    assert.equal(loadLocal(memoryStorage({ [STORAGE_KEY]: '{corrupt' })), null);
  });

  test('load order: hash > localStorage > defaults', () => {
    const fromHash = normalizeProject({ name: 'From hash' });
    const fromStorage = normalizeProject({ name: 'From storage' });
    const storage = memoryStorage({ [STORAGE_KEY]: JSON.stringify(fromStorage) });
    const a = loadInitialProject({ hash: projectToHash(fromHash), storage });
    assert.equal(a.origin, 'hash');
    assert.equal(a.project.name, 'From hash');
    const b = loadInitialProject({ hash: '', storage });
    assert.equal(b.origin, 'storage');
    assert.equal(b.project.name, 'From storage');
    const c = loadInitialProject({ hash: '#p=garbage', storage: memoryStorage() });
    assert.equal(c.origin, 'default');
    assert.deepEqual(c.project, DEFAULT_PROJECT);
    assert.equal(c.warnings.length, 1);
  });

  test('autosave is debounced and flushable', async () => {
    const storage = memoryStorage();
    const store = createStore(createDefaultProject());
    const autosave = createAutosave(store, { delayMs: 20, storage });
    store.set({ name: 'One' });
    store.set({ name: 'Two' });
    assert.equal(storage.getItem(STORAGE_KEY), null);
    await new Promise((r) => setTimeout(r, 60));
    assert.equal(JSON.parse(storage.getItem(STORAGE_KEY)).name, 'Two');
    store.set({ name: 'Three' });
    autosave.flush();
    assert.equal(JSON.parse(storage.getItem(STORAGE_KEY)).name, 'Three');
    autosave.dispose();
    store.set({ name: 'Four' });
    await new Promise((r) => setTimeout(r, 40));
    assert.equal(JSON.parse(storage.getItem(STORAGE_KEY)).name, 'Three');
  });
});
