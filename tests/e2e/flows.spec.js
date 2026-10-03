// End-to-end user flows of the whole app: default project, regions and presets, live-data errors,
// frame dragging, printer / tile changes, colours, back side, STL + 3MF export, print plan,
// project files, share links and the phone layout.
import { test, expect } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import { strFromU8, unzipSync } from '../../app/vendor/fflate/fflate.js';
import { parseBinarySTL } from '../../app/js/mesh/stl.js';
import { checkWatertight } from '../../app/js/mesh/analyze.js';
import {
  expectFrameFollowsLayout, fujiProject, grams, markPreview, openWithProject, prepare, project,
  waitForNewPreview, waitIdle,
} from './helpers.js';

let consoleErrors;

test.beforeEach(async ({ page }) => {
  consoleErrors = await prepare(page);
});

test.afterEach(() => {
  expect(consoleErrors, 'console errors').toEqual([]);
});

/** Counts the preview requests the app sends to the engine from now on. */
async function countPreviewRequests(page) {
  await page.evaluate(() => {
    const engine = window.__relief.engine;
    const original = engine.preview.bind(engine);
    window.__previewRequests = 0;
    engine.preview = (...args) => {
      window.__previewRequests += 1;
      return original(...args);
    };
  });
  return () => page.evaluate(() => window.__previewRequests);
}

/** Opens a collapsed sidebar section (desktop layout). */
async function openSection(page, id) {
  const panel = page.locator(`.panel[data-section="${id}"]`);
  if (await panel.evaluate((el) => el.classList.contains('is-collapsed'))) await panel.locator('.panel-head').click();
  await panel.scrollIntoViewIfNeeded();
}

/** Parses a 3MF model part into an indexed mesh. */
function meshFrom3MF(xml) {
  const positions = [];
  const indices = [];
  for (const m of xml.matchAll(/<vertex x="([-\d.e]+)" y="([-\d.e]+)" z="([-\d.e]+)"\s*\/>/g)) positions.push(+m[1], +m[2], +m[3]);
  for (const m of xml.matchAll(/<triangle v1="(\d+)" v2="(\d+)" v3="(\d+)"\s*\/>/g)) indices.push(+m[1], +m[2], +m[3]);
  return { positions: Float32Array.from(positions), indices: Uint32Array.from(indices) };
}

/** Clicks Export and returns the unzipped download. */
async function exportZip(page) {
  const button = page.getByTestId('export-button');
  await button.scrollIntoViewIfNeeded();
  const downloadPromise = page.waitForEvent('download', { timeout: 120_000 });
  await button.click();
  const download = await downloadPromise;
  await expect(page.getByTestId('export-close')).toBeVisible();
  const entries = unzipSync(new Uint8Array(await readFile(await download.path())));
  await page.getByTestId('export-close').click();
  return { name: download.suggestedFilename(), entries };
}

test('the default project previews the whole Alps on 4 × 2 tiles with a complete status bar', async ({ page }) => {
  await page.goto('/');
  await waitForNewPreview(page);
  const p = await project(page);
  expect(p.regionId).toBe('alps');
  expect(p.layout).toMatchObject({ cols: 4, rows: 2 });
  expect(p.relief.autoExaggeration).toBe(true);
  const info = await page.evaluate(() => {
    const r = window.__relief;
    return { tiles: r.lastPreview.tiles.length, source: r.lastPreview.stats.source, maxZ: r.runtime.zmap.maxZMm, base: r.runtime.zmap.baseMm };
  });
  expect(info.tiles).toBe(8);
  expect(info.source).toBe('local');
  expect(info.maxZ - info.base).toBeGreaterThan(25);
  expect(info.maxZ - info.base).toBeLessThan(35);

  expect(grams(await page.getByTestId('estimate-grams').textContent())).toBeGreaterThan(0);
  await expect(page.getByTestId('status-state')).toHaveText('Ready');
  await expect(page.getByTestId('status-scale')).toHaveText(/^1:[\d,]+$/);
  await expect(page.getByTestId('status-size')).toHaveText(/cm × .*cm/);
  await expect(page.getByTestId('status-filament')).toHaveText(/\d.*(g|kg)$/);
  await expect(page.getByTestId('status-time')).toHaveText(/\d/);
  await expect(page.getByTestId('status-height')).toHaveText(/mm · [\d.]+×/);
  await expect(page.locator('.status-item.is-warn')).toHaveCount(0);

  // A small preset keeps a sensible height thanks to the automatic exaggeration (no 400 mm towers).
  await markPreview(page);
  await page.getByRole('button', { name: 'Matterhorn & Monte Rosa', exact: true }).click();
  await waitForNewPreview(page);
  const m = await page.evaluate(() => ({
    frame: window.__relief.store.get().frame, zmap: window.__relief.runtime.zmap, stats: window.__relief.lastPreview.stats,
  }));
  expect(m.frame.lat).toBeCloseTo(45.96, 1);
  expect(m.frame.widthKm).toBeLessThan(60);
  expect(m.stats.source).toBe('local');
  expect(m.stats.pixelSizeM).toBeLessThan(40);
  expect(m.zmap.maxZMm).toBeLessThan(60);
  await expect(page.getByTestId('status-height')).toHaveText(/mm · 0\.5×/);
});

test('regions and presets reframe the map; live-data failures show a friendly message and the app recovers', async ({ page }) => {
  await openWithProject(page, fujiProject({ name: 'Mount Fuji' }));

  // Another stored region opens on its widest preset, from stored data.
  await markPreview(page);
  await page.getByTestId('region-button').click();
  await page.locator('.region-card[data-region="hawaii"]').click();
  await waitForNewPreview(page);
  let p = await project(page);
  expect(p.regionId).toBe('hawaii');
  // A project still named after its region follows the new region's name.
  expect(p.name).toBe(await page.evaluate(() => window.__relief.runtime.regionsIndex.regions.find((r) => r.id === 'hawaii').name));
  expect(await page.evaluate(() => window.__relief.lastPreview.stats.source)).toBe('local');
  expectFrameFollowsLayout(p);

  // A preset centres the frame on it, widened to the artwork proportions.
  await markPreview(page);
  await page.getByRole('button', { name: 'Kīlauea', exact: true }).click();
  await waitForNewPreview(page);
  p = await project(page);
  expect(p.frame.lat).toBeCloseTo(19.4, 0);
  expect(p.frame.widthKm).toBeGreaterThanOrEqual(30 - 1e-6);
  expectFrameFollowsLayout(p);

  // Live data (blocked in the test sandbox) fails with an actionable message, not a stack trace.
  await page.getByTestId('region-button').click();
  await page.locator('.region-card[data-region="world"]').click();
  await expect(page.getByTestId('status-state')).toHaveText('Preview failed', { timeout: 60_000 });
  const toast = page.locator('.toast-error');
  await expect(toast).toContainText('Live elevation tiles');
  await expect(toast).not.toContainText(/at \w+ \(|TypeError|\.js:/);
  await expect(page.locator('#preview3d')).toHaveClass(/is-stale/);
  expect((await project(page)).name).not.toBe('Anywhere on Earth');

  // …and the next stored-data preview works again and clears the error.
  await markPreview(page);
  await page.getByTestId('region-button').click();
  await page.locator('.region-card[data-region="fuji"]').click();
  await waitForNewPreview(page);
  await expect(page.getByTestId('status-state')).toHaveText('Ready');
  await expect(page.locator('.toast-error')).toHaveCount(0);
  await expect(page.locator('#preview3d')).not.toHaveClass(/is-stale/);
  expect((await project(page)).name).toBe('Mount Fuji');
});

test('dragging the frame on the map moves it and re-previews once, on release', async ({ page }) => {
  await openWithProject(page, fujiProject());
  const before = await project(page);
  const requests = await countPreviewRequests(page);
  // Let the map finish fitting the frame, then grab the frame body.
  await page.waitForFunction(() => {
    const map = window.__relief.mapView.map;
    return !map._animatingZoom && !(map._panAnim && map._panAnim._inProgress);
  });
  await page.waitForTimeout(300);
  const box = await page.locator('path.rs-frame-outline').boundingBox();
  const from = { x: box.x + box.width * 0.5, y: box.y + box.height * 0.5 };
  expect(await page.evaluate(({ x, y }) => document.elementFromPoint(x, y)?.classList.contains('rs-frame-outline'), from)).toBe(true);
  await markPreview(page);
  await page.mouse.move(from.x, from.y);
  await page.mouse.down();
  await page.mouse.move(from.x + 80, from.y - 30, { steps: 15 });
  expect(await requests(), 'no preview while dragging').toBe(0);
  await page.mouse.up();
  await waitForNewPreview(page);
  expect(await requests()).toBe(1);
  const after = await project(page);
  expect(after.frame.lon).toBeGreaterThan(before.frame.lon);
  expect(after.frame.lat).toBeGreaterThan(before.frame.lat);
  expect(after.frame.widthKm).toBeCloseTo(before.frame.widthKm, 6);
});

test('changing the printer and the tile count resizes tiles and the frame follows the artwork aspect', async ({ page }) => {
  await openWithProject(page, fujiProject({ layout: { cols: 2, rows: 1, tileW: 240, tileH: 240 } }));
  await openSection(page, 'printer');

  await markPreview(page);
  await page.getByTestId('printer').selectOption('bambu-a1-mini');
  await expect(page.locator('.toast')).toContainText('Tiles resized to 170 mm');
  await waitForNewPreview(page);
  let p = await project(page);
  expect(p.printer).toMatchObject({ presetId: 'bambu-a1-mini', bedW: 180, bedH: 180, maxZ: 180 });
  expect(p.layout).toMatchObject({ tileW: 170, tileH: 170 });

  const width = p.frame.widthKm;
  await markPreview(page);
  await page.getByRole('button', { name: 'More rows' }).click();
  await waitForNewPreview(page);
  p = await project(page);
  expect(p.layout.rows).toBe(2);
  expect(p.frame.widthKm).toBeCloseTo(width, 6);
  expectFrameFollowsLayout(p);
  expect(await page.evaluate(() => window.__relief.lastPreview.tiles.map((t) => t.label))).toEqual(['A1', 'A2', 'B1', 'B2']);
  await expect(page.getByTestId('art-size')).toHaveText('34 cm × 34 cm');
  await expect(page.locator('.tile-diagram .tile-cell')).toHaveCount(4);
});

test('a relief taller than the printer is flagged in the status bar and the printer section', async ({ page }) => {
  await openWithProject(page, fujiProject({ relief: { autoExaggeration: false, exaggeration: 30 } }));
  await expect(page.locator('.status-item.is-warn')).toHaveCount(1);
  await expect(page.getByTestId('status-height')).toHaveText(/mm · 30×/);
  await openSection(page, 'printer');
  await expect(page.getByTestId('layout-warnings')).toContainText('more than the printer');

  // Automatic exaggeration brings it back to ~30 mm.
  await openSection(page, 'relief');
  await markPreview(page);
  await page.getByTestId('auto-exaggeration').check();
  await waitForNewPreview(page);
  await expect(page.locator('.status-item.is-warn')).toHaveCount(0);
  const z = await page.evaluate(() => window.__relief.runtime.zmap);
  expect(z.maxZMm - z.baseMm).toBeLessThan(35);
  await expect(page.getByTestId('max-z')).toContainText('(auto)');

  // Moving the exaggeration slider switches Automatic off and keeps the chosen factor.
  await markPreview(page);
  await page.getByTestId('exaggeration').fill('2');
  await waitForNewPreview(page);
  const p = await project(page);
  expect(p.relief.autoExaggeration).toBe(false);
  expect(p.relief.exaggeration).toBe(2);
});

test('every art style previews; lithophanes are thin single-colour panels', async ({ page }) => {
  await openWithProject(page, fujiProject({ layout: { cols: 2, rows: 1, tileW: 100, tileH: 100 } }));
  await openSection(page, 'style');
  for (const id of ['terraced', 'lowpoly', 'ridgelines', 'hex', 'contours', 'lithophane', 'classic']) {
    await markPreview(page);
    await page.getByTestId(`style-${id}`).click();
    await waitForNewPreview(page);
    const r = await page.evaluate(() => ({
      style: window.__relief.store.get().style.id, maxZ: window.__relief.runtime.zmap.maxZMm,
      bands: window.__relief.runtime.bands.length, tiles: window.__relief.lastPreview.tiles.length,
    }));
    expect(r.style).toBe(id);
    expect(r.tiles).toBe(2);
    if (id === 'lithophane') {
      expect(r.maxZ).toBeLessThanOrEqual(3.2 + 1e-6);
      expect(r.bands).toBe(1);
    } else {
      expect(r.maxZ).toBeGreaterThan(10);
    }
  }
  // Ridgeline stagger is limited to 1 mm (it adds up over ~100 ribs).
  await page.getByTestId('style-ridgelines').click();
  await expect(page.getByTestId('param-staggerMm')).toHaveAttribute('max', '1');
});

test('colour themes and an edited band threshold update bands, preview colours and the estimate', async ({ page }) => {
  await openWithProject(page, fujiProject());
  await openSection(page, 'colors');
  await page.getByTestId('theme-glacier').click();
  await expect(page.getByTestId('estimate-filaments')).toContainText('Glacier Blue');
  const before = await page.evaluate(() => window.__relief.runtime.estimate.byFilament.map((f) => f.grams));

  // A new start elevation for the second band, between its neighbours (bands stay sorted).
  const lower = Number(await page.getByTestId('band-from-1').inputValue());
  const upper = Number(await page.getByTestId('band-from-2').inputValue());
  const target = Math.round((lower + upper) / 20) * 10 + 10;
  const threshold = page.getByTestId('band-from-1');
  await threshold.fill(String(target));
  await threshold.press('Enter');
  await expect.poll(() => project(page).then((p) => p.colors.bands[1]?.fromM)).toBe(target);
  const p = await project(page);
  expect(p.colors.autoFit).toBe(false);
  await expect(page.getByTestId('band-info-1')).toContainText(/Z [\d.]+ mm · layer \d+/);
  await expect.poll(() => page.evaluate(() => window.__relief.runtime.bands[1]?.elevFromM)).toBe(target);
  await expect.poll(() => page.evaluate(() => window.__relief.runtime.estimate.byFilament.map((f) => f.grams)))
    .not.toEqual(before);

  await page.getByTestId('theme-museum-plaster').click();
  await expect(page.getByTestId('estimate-filaments').locator('tbody tr')).toHaveCount(1);
});

test('exports STL and 3MF zips whose tiles are valid and watertight, with magnets and labels on the back', async ({ page }) => {
  await openWithProject(page, fujiProject({
    name: 'Fuji flows',
    frame: { lat: 35.36, lon: 138.73, widthKm: 20, rotationDeg: 10 },
    layout: { cols: 2, rows: 1, tileW: 80, tileH: 80 },
    relief: { resolutionMm: 0.6 },
  }));
  await openSection(page, 'back');
  await page.getByTestId('magnets').check();
  await expect(page.locator('.toast-warn')).toContainText('Base raised');
  let p = await project(page);
  expect(p.back.magnets.enabled).toBe(true);
  expect(p.relief.baseMm).toBeGreaterThanOrEqual(p.back.magnets.depthMm + 0.8 - 1e-9);
  await waitIdle(page);

  const stl = await exportZip(page);
  expect(stl.name).toBe('fuji-flows.zip');
  const stlFiles = Object.keys(stl.entries).filter((n) => n.endsWith('.stl')).sort();
  expect(stlFiles).toEqual(['fuji-flows_A1.stl', 'fuji-flows_A2.stl']);
  for (const name of stlFiles) {
    const mesh = parseBinarySTL(stl.entries[name]);
    expect(checkWatertight(mesh).ok, `${name} watertight`).toBe(true);
    expect(mesh.indices.length / 3).toBeGreaterThan(1000);
  }
  expect(strFromU8(stl.entries['print-plan.html'])).toContain('magnet pockets');

  await openSection(page, 'export');
  await page.locator('[data-testid="export-format"] .seg-option[data-value="3mf"]').click();
  const mf = await exportZip(page);
  const mfFiles = Object.keys(mf.entries).filter((n) => n.endsWith('.3mf')).sort();
  expect(mfFiles).toEqual(['fuji-flows_A1.3mf', 'fuji-flows_A2.3mf']);
  for (const name of mfFiles) {
    const inner = unzipSync(mf.entries[name]);
    const mesh = meshFrom3MF(strFromU8(inner['3D/3dmodel.model']));
    expect(mesh.indices.length / 3).toBeGreaterThan(1000);
    expect(checkWatertight(mesh).ok, `${name} watertight`).toBe(true);
    expect(strFromU8(inner['Metadata/Prusa_Slicer_custom_gcode_per_print_z.xml'])).toContain('M600');
  }
  p = await project(page);
  expect(JSON.parse(strFromU8(mf.entries['fuji-flows.relief.json']))).toEqual(JSON.parse(JSON.stringify(p)));
});

test('the print plan opens in a new tab with the tile layout and colour changes', async ({ page, context }) => {
  await openWithProject(page, fujiProject({ name: 'Plan test' }));
  await openSection(page, 'export');
  const popupPromise = context.waitForEvent('page');
  await page.getByTestId('print-plan-button').click();
  const plan = await popupPromise;
  await plan.waitForLoadState();
  await expect(plan).toHaveTitle('Plan test – print plan');
  await expect(plan.locator('body')).toContainText('Colour changes');
  for (const label of ['A1', 'A2', 'B1', 'B2']) await expect(plan.locator('td.tag', { hasText: label }).first()).toBeVisible();
  await expect(plan.locator('img')).toHaveCount(1);
  await plan.close();
});

test('save a project file, change things, and open the file again', async ({ page }) => {
  await openWithProject(page, fujiProject({ name: 'Saved design', style: { id: 'terraced', params: { count: 9 } } }));
  const original = await project(page);
  const downloadPromise = page.waitForEvent('download');
  await page.getByTestId('action-save').click();
  const download = await downloadPromise;
  expect(download.suggestedFilename()).toBe('saved-design.relief.json');
  const path = await download.path();
  expect(JSON.parse(await readFile(path, 'utf8'))).toEqual(JSON.parse(JSON.stringify(original)));

  await page.getByTestId('project-name').fill('Something else');
  await page.getByTestId('project-name').press('Enter');
  await markPreview(page);
  await page.getByTestId('style-classic').click();
  await waitForNewPreview(page);
  expect((await project(page)).name).toBe('Something else');

  await markPreview(page);
  await page.getByTestId('open-file').setInputFiles(path);
  await expect(page.locator('.toast-success')).toContainText('Opened “Saved design”');
  await waitForNewPreview(page);
  expect(await project(page)).toEqual(original);
  await expect(page.getByTestId('project-name')).toHaveValue('Saved design');
  await expect(page.getByTestId('style-terraced')).toHaveAttribute('aria-pressed', 'true');
});

test('a share link reopens exactly the same design', async ({ page, context }) => {
  await openWithProject(page, fujiProject({ name: 'Shared', colors: { themeId: 'gold-peaks', mode: 'bands', autoFit: true } }));
  await page.getByTestId('action-share').click();
  await expect(page).toHaveURL(/#p=/);
  await expect(page.locator('.toast')).toContainText(/Link copied|address bar/);
  const url = page.url();
  const original = await project(page);

  const other = await context.newPage();
  await prepare(other);
  await other.goto(url);
  await waitForNewPreview(other);
  expect(await project(other)).toEqual(original);
  await expect(other).toHaveTitle('Shared – Relief Studio');
  await other.close();
});

test.describe('phone layout (390 × 844)', () => {
  test.use({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });

  test('one pane at a time, settings in tabs, no horizontal scrolling', async ({ page }) => {
    await openWithProject(page, fujiProject());
    await expect(page.getByTestId('view-mode-split')).toBeHidden();
    await expect(page.locator('#preview3d canvas')).toBeVisible();
    await expect(page.locator('#map')).toBeHidden();
    await page.getByTestId('view-mode-map').click();
    await expect(page.locator('#map')).toBeVisible();
    await expect(page.locator('path.rs-frame-outline')).toBeVisible();

    await page.getByRole('tab', { name: /Estimate/ }).click();
    await expect(page.getByTestId('estimate-grams')).toBeVisible();
    await page.getByRole('tab', { name: /Export/ }).click();
    await expect(page.getByTestId('export-button')).toBeAttached();
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    expect(overflow).toBe(0);
    await expect(page.getByTestId('status-filament')).toBeVisible();
  });
});
