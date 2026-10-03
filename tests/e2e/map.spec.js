// End-to-end tests for the map module (app/js/map/*) using the standalone demo page app/dev/map.html.
import { test, expect } from '@playwright/test';

const DEMO = '/app/dev/map.html';
const EXTERNAL_TILES = /tile\.opentopomap\.org|tile\.openstreetmap\.org|server\.arcgisonline\.com/;
const NOMINATIM = /nominatim\.openstreetmap\.org\/search/;
// 1×1 transparent PNG so base-map tiles "load" without internet access.
const BLANK_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==',
  'base64');
const ALPS = { lat: 45.95, lon: 10.75, widthKm: 900, heightKm: 450, rotationDeg: 0 };

/** Console errors and page errors, ignoring failed requests to external hosts. */
function collectErrors(page) {
  const errors = [];
  page.on('pageerror', (err) => errors.push(`pageerror: ${err.message}`));
  page.on('console', (msg) => {
    if (msg.type() !== 'error') return;
    const url = msg.location()?.url || '';
    const external = url && !url.startsWith('http://localhost');
    if (/Failed to load resource/.test(msg.text()) && external) return;
    errors.push(`${msg.text()} ${url}`.trim());
  });
  return errors;
}

/** Waits until the map is not animating and two animation frames have been painted. */
async function settle(page) {
  await page.waitForFunction(() => {
    const map = window.mapView.map;
    return !map._animatingZoom && !(map._panAnim && map._panAnim._inProgress);
  });
  await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));
}

/** Page coordinates of a lat/lon. */
async function pagePoint(page, lat, lon) {
  return page.evaluate(([la, lo]) => {
    const p = window.mapView.map.latLngToContainerPoint([la, lo]);
    const r = window.mapView.map.getContainer().getBoundingClientRect();
    return { x: r.left + p.x, y: r.top + p.y };
  }, [lat, lon]);
}

async function centreOf(locator) {
  const box = await locator.boundingBox();
  return { x: box.x + box.width / 2, y: box.y + box.height / 2 };
}

/** Drags with the mouse in small steps (pointer events, like a user). */
async function drag(page, from, to, steps = 12) {
  await page.mouse.move(from.x, from.y);
  await page.mouse.down();
  await page.mouse.move(to.x, to.y, { steps });
  await page.mouse.up();
}

const frameEvents = (page) => page.evaluate(() => window.events.filter((e) => e.type === 'framechange'));

let errors;

test.beforeEach(async ({ page }) => {
  errors = collectErrors(page);
  await page.route(EXTERNAL_TILES,
    (route) => route.fulfill({ status: 200, contentType: 'image/png', body: BLANK_PNG }));
  await page.goto(DEMO);
  await page.waitForFunction(() => window.demoReady === true);
  await settle(page);
});

test.afterEach(() => {
  expect(errors, 'no console errors').toEqual([]);
});

test('draws the frame polygon, the tile grid and 8 tile labels', async ({ page }) => {
  await expect(page.locator('path.rs-frame-outline')).toHaveCount(1);
  await expect(page.locator('path.rs-frame-grid')).toHaveCount(1);
  const labels = page.locator('.rs-tile-label');
  await expect(labels).toHaveCount(8);
  expect(await labels.allTextContents()).toEqual(['A1', 'A2', 'A3', 'A4', 'B1', 'B2', 'B3', 'B4']);
  await expect(labels.first().locator('span')).toBeVisible();
  await expect(page.locator('.rs-handle-corner')).toHaveCount(4);
  await expect(page.locator('.rs-handle-rotate')).toHaveCount(1);

  // A1 is the top-left tile, B4 the bottom-right one.
  const a1 = await centreOf(labels.filter({ hasText: 'A1' }));
  const b4 = await centreOf(labels.filter({ hasText: 'B4' }));
  expect(a1.x).toBeLessThan(b4.x);
  expect(a1.y).toBeLessThan(b4.y);

  // The grid has 3 vertical + 1 horizontal interior lines (one "M" per polyline part).
  const d = await page.locator('path.rs-frame-grid').getAttribute('d');
  expect(d.match(/M/g)).toHaveLength(4);
});

test('dragging the frame body moves the centre and keeps the shape', async ({ page }) => {
  const mapCentreBefore = await page.evaluate(() => window.mapView.map.getCenter());
  const start = await pagePoint(page, ALPS.lat, ALPS.lon);
  const hit = await page.evaluate(({ x, y }) => document.elementFromPoint(x, y)?.getAttribute('class'), start);
  expect(hit).toContain('rs-frame-outline');

  const delta = { x: 160, y: 70 };
  await drag(page, start, { x: start.x + delta.x, y: start.y + delta.y });
  await settle(page);

  const events = await frameEvents(page);
  expect(events.length).toBeGreaterThanOrEqual(2);
  expect(events.slice(0, -1).every((e) => e.final === false)).toBe(true);
  const last = events.at(-1);
  expect(last.final).toBe(true);
  expect(last.frame.lon).toBeGreaterThan(ALPS.lon + 0.5);
  expect(last.frame.lat).toBeLessThan(ALPS.lat - 0.2);
  expect(last.frame.widthKm).toBeCloseTo(ALPS.widthKm, 6);
  expect(last.frame.heightKm).toBeCloseTo(ALPS.heightKm, 6);
  expect(last.frame.rotationDeg).toBe(0);

  // The centre followed the pointer exactly and the map itself did not pan.
  const moved = await pagePoint(page, last.frame.lat, last.frame.lon);
  expect(Math.abs(moved.x - (start.x + delta.x))).toBeLessThan(1.5);
  expect(Math.abs(moved.y - (start.y + delta.y))).toBeLessThan(1.5);
  const mapCentreAfter = await page.evaluate(() => window.mapView.map.getCenter());
  expect(mapCentreAfter.lat).toBeCloseTo(mapCentreBefore.lat, 9);
  expect(mapCentreAfter.lng).toBeCloseTo(mapCentreBefore.lng, 9);
  expect(await page.evaluate(() => window.mapView.map.dragging.enabled())).toBe(true);
});

test('dragging a corner handle resizes about the centre with a locked aspect ratio', async ({ page }) => {
  const handle = page.locator('.rs-handle-corner.rs-corner-br');
  const from = await centreOf(handle);
  await drag(page, from, { x: from.x + 90, y: from.y + 20 });
  await settle(page);

  let last = (await frameEvents(page)).at(-1);
  expect(last.final).toBe(true);
  expect(last.frame.widthKm).toBeGreaterThan(ALPS.widthKm + 50);
  expect(last.frame.widthKm / last.frame.heightKm).toBeCloseTo(2, 4);
  expect(last.frame.lat).toBeCloseTo(ALPS.lat, 6);
  expect(last.frame.lon).toBeCloseTo(ALPS.lon, 6);

  // Zoom to the grown frame (map control), then shrink it with the opposite corner.
  await page.locator('.rs-fit-btn').click();
  await settle(page);
  const tl = await centreOf(page.locator('.rs-handle-corner.rs-corner-tl'));
  await drag(page, tl, { x: tl.x + 200, y: tl.y + 100 });
  await settle(page);
  const widthBefore = last.frame.widthKm;
  last = (await frameEvents(page)).at(-1);
  expect(last.final).toBe(true);
  expect(last.frame.widthKm).toBeLessThan(widthBefore - 100);
  expect(last.frame.widthKm / last.frame.heightKm).toBeCloseTo(2, 4);
});

test('the rotation handle rotates the frame and Shift snaps to 15°', async ({ page }) => {
  const centre = await pagePoint(page, ALPS.lat, ALPS.lon);
  const from = await centreOf(page.locator('.rs-handle-rotate'));
  const radius = Math.hypot(from.x - centre.x, from.y - centre.y);
  // Swing ≈ 33° clockwise around the centre, then hold Shift: snaps to 30°.
  const angle = 33 * Math.PI / 180;
  const to = { x: centre.x + radius * Math.sin(angle), y: centre.y - radius * Math.cos(angle) };
  await page.mouse.move(from.x, from.y);
  await page.mouse.down();
  await page.mouse.move(to.x, to.y, { steps: 10 });
  await page.keyboard.down('Shift');
  await page.mouse.move(to.x + 1, to.y, { steps: 1 });
  await page.mouse.up();
  await page.keyboard.up('Shift');
  await settle(page);

  const last = (await frameEvents(page)).at(-1);
  expect(last.final).toBe(true);
  expect(last.frame.rotationDeg).toBe(30);
  expect(last.frame.widthKm).toBeCloseTo(ALPS.widthKm, 6);
  expect(last.frame.lat).toBeCloseTo(ALPS.lat, 6);
});

test('Escape cancels a drag and restores the original frame', async ({ page }) => {
  const start = await pagePoint(page, ALPS.lat, ALPS.lon);
  await page.mouse.move(start.x, start.y);
  await page.mouse.down();
  await page.mouse.move(start.x + 120, start.y + 40, { steps: 6 });
  await page.keyboard.press('Escape');
  await page.mouse.up();
  await settle(page);

  const events = await frameEvents(page);
  const finals = events.filter((e) => e.final);
  expect(finals).toHaveLength(1);
  expect(finals[0].frame).toEqual(ALPS);
  expect(events.at(-1).final).toBe(true);
});

test('zoomed into a frame that fills the view, dragging inside pans the map instead', async ({ page }) => {
  await page.evaluate(([lat, lon]) => window.mapView.map.setView([lat, lon], 11, { animate: false }),
    [ALPS.lat, ALPS.lon]);
  await settle(page);
  await expect(page.locator('#map')).toHaveClass(/rs-frame-covers-view/);
  const before = await page.evaluate(() => window.mapView.map.getCenter());
  const start = await pagePoint(page, ALPS.lat, ALPS.lon);
  await drag(page, start, { x: start.x - 150, y: start.y - 50 });
  await settle(page);
  const after = await page.evaluate(() => window.mapView.map.getCenter());
  expect(after.lng).toBeGreaterThan(before.lng);
  expect(after.lat).toBeLessThan(before.lat);
  expect(await frameEvents(page)).toEqual([]);

  // Zoomed back out, the frame edges are visible again and the body moves the frame.
  await page.evaluate(() => window.mapView.fitFrame());
  await settle(page);
  await expect(page.locator('#map')).not.toHaveClass(/rs-frame-covers-view/);
});

test.describe('touch', () => {
  test.use({ hasTouch: true });

  test('a one-finger drag moves the frame without panning the map', async ({ page }) => {
    const cdp = await page.context().newCDPSession(page);
    const touch = (type, x, y) => cdp.send('Input.dispatchTouchEvent', {
      type, touchPoints: type === 'touchEnd' ? [] : [{ x, y }],
    });
    const mapCentre = await page.evaluate(() => window.mapView.map.getCenter());
    const start = await pagePoint(page, ALPS.lat, ALPS.lon);
    await touch('touchStart', start.x, start.y);
    for (let i = 1; i <= 10; i++) {
      await touch('touchMove', start.x + i * 10, start.y + i * 4);
      await page.evaluate(() => new Promise(requestAnimationFrame));
    }
    await touch('touchEnd');
    await settle(page);

    const last = (await frameEvents(page)).at(-1);
    expect(last.final).toBe(true);
    const moved = await pagePoint(page, last.frame.lat, last.frame.lon);
    expect(Math.abs(moved.x - (start.x + 100))).toBeLessThan(1.5);
    expect(Math.abs(moved.y - (start.y + 40))).toBeLessThan(1.5);
    expect(await page.evaluate(() => window.mapView.map.getCenter())).toEqual(mapCentre);
  });
});

test('setFrame redraws without emitting and labels hide when tiles are tiny', async ({ page }) => {
  const outline = page.locator('path.rs-frame-outline');
  const before = await outline.getAttribute('d');
  await page.evaluate(() => window.mapView.setFrame(
    { lat: 46.5, lon: 8.3, widthKm: 300, heightKm: 150, rotationDeg: 10 }, { cols: 3, rows: 2 }));
  await expect(page.locator('.rs-tile-label')).toHaveCount(6);
  expect(await outline.getAttribute('d')).not.toEqual(before);
  expect(await page.evaluate(() => window.events.length)).toBe(0);

  await page.evaluate(() => window.mapView.setRegion('world'));
  await settle(page);
  await expect(page.locator('.leaflet-rs-labels-pane')).toHaveClass(/rs-labels-hidden/);
  await page.evaluate(() => window.mapView.fitFrame());
  await settle(page);
  await expect(page.locator('.leaflet-rs-labels-pane')).not.toHaveClass(/rs-labels-hidden/);
  expect(await page.evaluate(() => window.events.length)).toBe(0);
});

test('layer switcher, region overviews and region outlines', async ({ page }) => {
  const regions = await page.evaluate(() => window.mapView.regions.map((r) => r.id));
  test.skip(!regions.includes('fuji'), 'needs the sample region data/fuji');

  await page.locator('.rs-layer-btn[data-layer="satellite"]').click();
  await expect(page.locator('#map')).toHaveClass(/rs-base-satellite/);
  await expect(page.locator('.rs-layer-btn[data-layer="satellite"]')).toHaveAttribute('aria-pressed', 'true');

  // Plain base map, whole world: every region is shown, as a thumbnail while small on screen.
  await page.evaluate(() => window.mapView.setRegion('world'));
  await settle(page);
  await page.locator('.rs-layer-btn[data-layer="none"]').click();
  expect(await page.evaluate(() => window.mapView.baseLayer)).toBe('none');
  const overviews = page.locator('img.rs-overview');
  await expect(overviews).toHaveCount(regions.length);
  const sources = await overviews.evaluateAll((imgs) => imgs.map((img) => img.getAttribute('src')));
  // (The start region's full overview, already loaded, is kept.)
  const thumbs = sources.filter((src) => /\/data\/[\w-]+\/thumb\.jpg$/.test(src));
  expect(thumbs.length).toBeGreaterThanOrEqual(regions.length - 1);
  await expect.poll(() => overviews.evaluateAll((imgs) => imgs.every((img) => img.complete && img.naturalWidth > 0)))
    .toBe(true);

  // Zoomed to a region, its full-resolution overview replaces the thumbnail.
  await page.evaluate(() => window.mapView.setRegion('fuji'));
  await settle(page);
  const fuji = page.locator('img.rs-overview[src$="/data/fuji/overview.jpg"]');
  await expect(fuji).toHaveCount(1);

  // Back on a tiled map only the current region's overview remains.
  await page.locator('.rs-layer-btn[data-layer="topo"]').click();
  await expect(overviews).toHaveCount(1);
  await expect(overviews).toHaveAttribute('src', /data\/fuji\/overview\.jpg$/);
  await expect(page.locator('path.rs-region-outline.is-current')).toHaveCount(1);

  // Clicking the region outline emits 'regionselect'.
  const edge = await pagePoint(page, 35.5, 138);
  await page.mouse.click(edge.x, edge.y);
  const log = await page.evaluate(() => window.events.map((e) => `${e.type}:${e.regionId || e.baseLayer}`));
  expect(log).toEqual([
    'baselayerchange:satellite', 'baselayerchange:none', 'baselayerchange:topo', 'regionselect:fuji',
  ]);
});

test('searchPlaces maps Nominatim results and reports failures gracefully', async ({ page }) => {
  const requested = [];
  await page.route(NOMINATIM, (route) => {
    requested.push(route.request().url());
    const q = new URL(route.request().url()).searchParams.get('q');
    if (q === 'broken') {
      return route.fulfill({ status: 503, headers: { 'access-control-allow-origin': '*' }, body: 'down' });
    }
    return route.fulfill({
      contentType: 'application/json',
      headers: { 'access-control-allow-origin': '*' },
      body: JSON.stringify([{
        lat: '45.9765', lon: '7.6585', name: 'Matterhorn', type: 'peak',
        display_name: 'Matterhorn, Zermatt, Wallis, Schweiz',
        boundingbox: ['45.9265', '46.0265', '7.6085', '7.7085'],
      }]),
    });
  });
  const result = await page.evaluate(async () => {
    const { searchPlaces } = await import('/app/js/map/search.js');
    const places = await searchPlaces('Matterhorn');
    const failure = await searchPlaces('broken').then(() => null, (err) => ({ name: err.name, code: err.code }));
    const coordinates = await searchPlaces('46.55, 7.98');
    return { places, failure, coordinates };
  });
  expect(requested).toHaveLength(2); // typed coordinates are answered without a request
  expect(requested[0]).toMatch(/^https:\/\/nominatim\.openstreetmap\.org\/search\?format=jsonv2&limit=6&q=Matterhorn/);
  expect(result.places).toEqual([{
    name: 'Matterhorn, Zermatt, Wallis, Schweiz', title: 'Matterhorn', type: 'peak',
    lat: 45.9765, lon: 7.6585, bbox: [45.9265, 7.6085, 46.0265, 7.7085],
  }]);
  expect(result.failure).toEqual({ name: 'PlaceSearchError', code: 'http' });
  expect(result.coordinates[0]).toMatchObject({ lat: 46.55, lon: 7.98, type: 'coordinates' });
  // The failed request logs a console error for the external host only, which is ignored.
});
