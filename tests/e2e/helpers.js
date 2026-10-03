// Shared helpers for the end-to-end tests of the Relief Studio app (index.html).
import { expect } from '@playwright/test';
import { projectToHash } from '../../app/js/state/persistence.js';
import { normalizeProject } from '../../app/js/state/store.js';

/** Hosts the sandbox cannot reach; tests must never depend on them. */
export const EXTERNAL = /opentopomap\.org|openstreetmap\.org|arcgisonline\.com|nominatim|amazonaws\.com/;

/**
 * A small Mount Fuji project (stored sample data, fast to sample and mesh).
 * @param {object} [overrides] top-level project keys
 */
export function fujiProject(overrides = {}) {
  return normalizeProject({
    name: 'Fuji test',
    regionId: 'fuji',
    frame: { lat: 35.36, lon: 138.73, widthKm: 30, rotationDeg: 0 },
    layout: { cols: 2, rows: 2, tileW: 120, tileH: 120 },
    ...overrides,
  });
}

/**
 * Blocks external hosts, clears storage, uses the plain base map and collects console errors.
 * Failed requests to external hosts and network warnings are expected and not collected.
 * @param {import('@playwright/test').Page} page
 * @returns {Promise<string[]>} live list of console errors
 */
export async function prepare(page) {
  const errors = [];
  await page.route(EXTERNAL, (route) => route.abort());
  await page.addInitScript(() => {
    try {
      if (!sessionStorage.getItem('keepStorage')) localStorage.clear();
      localStorage.setItem('relief-studio.ui.baseLayer', 'none');
    } catch {
      // storage unavailable – the default base layer is used
    }
  });
  page.on('console', (msg) => {
    if (msg.type() !== 'error') return;
    if (/Failed to load resource/.test(msg.text()) && EXTERNAL.test(msg.location()?.url ?? '')) return;
    errors.push(msg.text());
  });
  page.on('pageerror', (err) => errors.push(String(err)));
  return errors;
}

/** Opens the app with a project in the URL hash and waits for the first preview. */
export async function openWithProject(page, project) {
  await page.goto(`/${projectToHash(project)}`);
  await waitForNewPreview(page);
}

/** Remembers the current preview so waitForNewPreview can detect the next one. */
export async function markPreview(page) {
  await page.evaluate(() => { window.__previewMark = window.__relief.lastPreview; });
}

/** Waits until a preview newer than the marked one has been applied and the app is idle. */
export async function waitForNewPreview(page) {
  await page.waitForFunction(() => {
    const r = window.__relief;
    return Boolean(r?.lastPreview) && r.lastPreview !== window.__previewMark && !r.runtime.busy;
  }, null, { timeout: 90_000 });
}

/** Waits until no preview is pending (after a change that may or may not re-run the engine). */
export async function waitIdle(page) {
  await page.waitForFunction(() => window.__relief && !window.__relief.runtime.busy, null, { timeout: 90_000 });
}

/** The current project. */
export function project(page) {
  return page.evaluate(() => window.__relief.store.get());
}

/** Parses "1.24 kg" / "840 g" into grams. */
export function grams(text) {
  const m = /([\d.,]+)\s*(kg|g)/.exec(text);
  if (!m) return NaN;
  const v = Number(m[1].replace(/,/g, ''));
  return m[2] === 'kg' ? v * 1000 : v;
}

/** Asserts that the artwork aspect equals the frame aspect. */
export function expectFrameFollowsLayout(p) {
  const art = (p.layout.rows * p.layout.tileH) / (p.layout.cols * p.layout.tileW);
  expect(p.frame.heightKm / p.frame.widthKm).toBeCloseTo(art, 6);
}
