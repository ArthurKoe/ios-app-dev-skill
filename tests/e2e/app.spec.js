// End-to-end tests of the Relief Studio shell: first preview, estimate, art style and colour
// theme changes, and a full STL export to a zip.
import { test, expect } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import { strFromU8, unzipSync } from '../../app/vendor/fflate/fflate.js';
import { projectToHash } from '../../app/js/state/persistence.js';
import { normalizeProject } from '../../app/js/state/store.js';

/** Hosts the sandbox cannot reach; tests must never depend on them. */
const EXTERNAL = /opentopomap\.org|openstreetmap\.org|arcgisonline\.com|nominatim|amazonaws\.com/;

/** A small Mount Fuji project (stored sample data, fast to sample and mesh). */
function fujiProject(overrides = {}) {
  return normalizeProject({
    name: 'Fuji test',
    regionId: 'fuji',
    frame: { lat: 35.36, lon: 138.73, widthKm: 30, rotationDeg: 0 },
    layout: { cols: 2, rows: 2, tileW: 120, tileH: 120 },
    ...overrides,
  });
}

/** Opens the app with a project in the URL hash and waits for the first preview. */
async function openWithProject(page, project) {
  await page.goto(`/${projectToHash(project)}`);
  await waitForNewPreview(page);
}

/** Remembers the current preview so waitForNewPreview can detect the next one. */
async function markPreview(page) {
  await page.evaluate(() => { window.__previewMark = window.__relief.lastPreview; });
}

/** Waits until a preview newer than the marked one has been applied and the app is idle. */
async function waitForNewPreview(page) {
  await page.waitForFunction(() => {
    const r = window.__relief;
    return Boolean(r?.lastPreview) && r.lastPreview !== window.__previewMark && !r.runtime.busy;
  }, null, { timeout: 90_000 });
}

/** Parses "1.24 kg" / "840 g" into grams. */
function grams(text) {
  const m = /([\d.,]+)\s*(kg|g)/.exec(text);
  if (!m) return NaN;
  const v = Number(m[1].replace(/,/g, ''));
  return m[2] === 'kg' ? v * 1000 : v;
}

let consoleErrors;

test.beforeEach(async ({ page }) => {
  consoleErrors = [];
  await page.route(EXTERNAL, (route) => route.abort());
  await page.addInitScript(() => {
    try {
      localStorage.clear();
      localStorage.setItem('relief-studio.ui.baseLayer', 'none');
    } catch {
      // storage unavailable – the default base layer is used
    }
  });
  page.on('console', (msg) => {
    if (msg.type() !== 'error') return;
    if (/Failed to load resource/.test(msg.text()) && EXTERNAL.test(msg.location()?.url ?? '')) return;
    consoleErrors.push(msg.text());
  });
  page.on('pageerror', (err) => consoleErrors.push(String(err)));
});

test.afterEach(() => {
  expect(consoleErrors, 'console errors').toEqual([]);
});

test('loads, renders the first preview and shows a filament estimate', async ({ page }) => {
  await openWithProject(page, fujiProject());

  await expect(page).toHaveTitle(/Fuji test – Relief Studio/);
  await expect(page.locator('.brand-name')).toHaveText('Relief Studio');
  await expect(page.getByTestId('project-name')).toHaveValue('Fuji test');

  const info = await page.evaluate(() => {
    const r = window.__relief;
    return {
      tiles: r.lastPreview.tiles.map((t) => ({ label: t.label, vertices: t.mesh.positions.length / 3, triangles: t.mesh.indices.length / 3 })),
      source: r.lastPreview.stats.source,
      maxZ: r.lastPreview.zmap.maxZMm,
    };
  });
  expect(info.tiles.map((t) => t.label)).toEqual(['A1', 'A2', 'B1', 'B2']);
  for (const t of info.tiles) expect(t.triangles).toBeGreaterThan(1000);
  expect(info.source).toBe('local');
  expect(info.maxZ).toBeGreaterThan(3);

  const total = await page.getByTestId('estimate-grams').textContent();
  expect(grams(total)).toBeGreaterThan(0);
  await expect(page.getByTestId('estimate-filaments').locator('tbody tr')).not.toHaveCount(0);
  await expect(page.getByTestId('status-filament')).toHaveText(/\d/);
  await expect(page.getByTestId('status-state')).toHaveText('Ready');
  await expect(page.getByTestId('status-data')).toContainText('Copernicus');
  await expect(page.locator('#preview3d canvas')).toBeVisible();
});

test('changing the art style and the colour theme updates the preview and the estimate', async ({ page }) => {
  await openWithProject(page, fujiProject());
  await markPreview(page);

  await page.getByTestId('style-terraced').click();
  await expect(page.getByTestId('style-terraced')).toHaveAttribute('aria-pressed', 'true');
  expect(await page.evaluate(() => window.__relief.store.get().style.id)).toBe('terraced');
  await waitForNewPreview(page);
  await expect(page.getByTestId('param-count')).toBeVisible();

  await page.getByTestId('theme-desert-canyon').click();
  await expect(page.getByTestId('theme-desert-canyon')).toHaveAttribute('aria-pressed', 'true');
  expect(await page.evaluate(() => window.__relief.store.get().colors.themeId)).toBe('desert-canyon');
  await expect(page.getByTestId('estimate-filaments')).toContainText('Canyon Red');
  await expect(page.getByTestId('band-list')).toContainText(/layer \d+/);

  await page.getByTestId('theme-museum-plaster').click();
  expect(await page.evaluate(() => window.__relief.store.get().colors.mode)).toBe('single');
  await expect(page.getByTestId('estimate-filaments').locator('tbody tr')).toHaveCount(1);
  const grams1 = grams(await page.getByTestId('estimate-grams').textContent());
  expect(grams1).toBeGreaterThan(0);
});

test('exports a zip with one valid binary STL per tile and a print plan', async ({ page }) => {
  await openWithProject(page, fujiProject({
    name: 'Fuji export',
    frame: { lat: 35.36, lon: 138.73, widthKm: 20, rotationDeg: 0 },
    layout: { cols: 2, rows: 1, tileW: 100, tileH: 100 },
    relief: { resolutionMm: 0.6 },
  }));

  const exportButton = page.getByTestId('export-button');
  await exportButton.scrollIntoViewIfNeeded();
  await expect(exportButton).toHaveText(/Export 2 tiles/);
  const downloadPromise = page.waitForEvent('download', { timeout: 120_000 });
  await exportButton.click();
  const download = await downloadPromise;
  expect(download.suggestedFilename()).toBe('fuji-export.zip');
  await expect(page.getByTestId('export-close')).toBeVisible();

  const entries = unzipSync(new Uint8Array(await readFile(await download.path())));
  const names = Object.keys(entries).sort();
  expect(names).toEqual(['fuji-export.relief.json', 'fuji-export_A1.stl', 'fuji-export_A2.stl', 'print-plan.html']);

  for (const name of names.filter((n) => n.endsWith('.stl'))) {
    const bytes = entries[name];
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const count = view.getUint32(80, true);
    expect(bytes.byteLength, `${name} size`).toBe(84 + 50 * count);
    expect(count, `${name} triangles`).toBeGreaterThan(1000);
    let minX = Infinity; let maxX = -Infinity; let minZ = Infinity; let maxZ = -Infinity;
    for (let i = 0; i < count; i++) {
      const base = 84 + i * 50;
      for (let k = 0; k < 3; k++) {
        const x = view.getFloat32(base + 12 + k * 12, true);
        const z = view.getFloat32(base + 12 + k * 12 + 8, true);
        minX = Math.min(minX, x); maxX = Math.max(maxX, x);
        minZ = Math.min(minZ, z); maxZ = Math.max(maxZ, z);
      }
    }
    expect(minX).toBeGreaterThanOrEqual(-1e-3);
    expect(maxX).toBeLessThanOrEqual(100 + 1e-3);
    expect(minZ).toBeGreaterThanOrEqual(-1e-3);
    expect(maxZ).toBeGreaterThan(3);
  }

  const plan = strFromU8(entries['print-plan.html']);
  expect(plan).toContain('<td class="tag">A1</td>');
  expect(plan).toContain('<td class="tag">A2</td>');
  expect(plan).toContain('Colour changes');
  expect(plan).toContain('Copernicus');
  const saved = JSON.parse(strFromU8(entries['fuji-export.relief.json']));
  expect(saved.layout).toMatchObject({ cols: 2, rows: 1, tileW: 100, tileH: 100 });
});
