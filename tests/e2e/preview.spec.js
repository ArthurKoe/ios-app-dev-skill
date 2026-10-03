// E2E tests of the three.js preview (app/js/preview/) using the standalone demo page, which
// builds synthetic terrain tiles inline. WebGL runs on SwiftShader in headless Chromium, so the
// viewport and mesh resolution are kept small.
import { test, expect } from '@playwright/test';

const DEMO = '/app/dev/preview.html?res=2.5';

test.use({ viewport: { width: 960, height: 600 } });

/** Collects console errors, uncaught exceptions and three.js warnings of a page. */
function watchConsole(page) {
  const errors = [];
  const warnings = [];
  page.on('console', (msg) => {
    if (msg.type() === 'error') errors.push(msg.text());
    else if (msg.type() === 'warning' && msg.text().startsWith('THREE.')) warnings.push(msg.text());
  });
  page.on('pageerror', (err) => errors.push(String(err)));
  return { errors, warnings };
}

async function openDemo(page) {
  await page.goto(DEMO);
  await page.waitForFunction(() => document.body.dataset.ready === 'true', null, { timeout: 90_000 });
}

/** Waits until pending tile builds are swapped in and a frame has been rendered. */
async function rendered(page) {
  await page.evaluate(() => window.preview.whenRendered());
}

async function press(page, group, value) {
  await page.click(`button[data-group="${group}"][data-value="${value}"]`);
  await rendered(page);
}

/**
 * Decodes a PNG (Buffer or data URL) in the page and returns size and luminance statistics.
 * @returns {Promise<{width:number, height:number, mean:number, std:number, rgb:number[], colors:number}>}
 */
async function imageStats(page, png) {
  const src = typeof png === 'string' ? png : `data:image/png;base64,${png.toString('base64')}`;
  return page.evaluate(async (url) => {
    const bitmap = await createImageBitmap(await (await fetch(url)).blob());
    const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
    const ctx = canvas.getContext('2d');
    ctx.drawImage(bitmap, 0, 0);
    const { data } = ctx.getImageData(0, 0, bitmap.width, bitmap.height);
    const rgb = [0, 0, 0];
    const colors = new Set();
    let n = 0, sum = 0, sum2 = 0;
    for (let i = 0; i < data.length; i += 4 * 5) {
      const l = 0.2126 * data[i] + 0.7152 * data[i + 1] + 0.0722 * data[i + 2];
      sum += l; sum2 += l * l; n++;
      rgb[0] += data[i]; rgb[1] += data[i + 1]; rgb[2] += data[i + 2];
      colors.add(((data[i] >> 4) << 8) | ((data[i + 1] >> 4) << 4) | (data[i + 2] >> 4));
    }
    const mean = sum / n;
    return {
      width: bitmap.width, height: bitmap.height, mean,
      std: Math.sqrt(Math.max(0, sum2 / n - mean * mean)), rgb: rgb.map((v) => v / n), colors: colors.size,
    };
  }, src);
}

async function canvasStats(page) {
  return imageStats(page, await page.locator('#view canvas').screenshot());
}

test('renders the tiled relief (canvas is not blank)', async ({ page }) => {
  const log = watchConsole(page);
  await openDemo(page);
  const info = await page.evaluate(() => window.preview.info);
  expect(info.tiles).toBe(6);
  expect(info.triangles).toBeGreaterThan(10_000);
  const stats = await canvasStats(page);
  expect(stats.std).toBeGreaterThan(12);
  expect(stats.colors).toBeGreaterThan(40);
  expect(log.errors).toEqual([]);
  expect(log.warnings).toEqual([]);
});

test('switches lighting, modes, styles and finishes without console errors', async ({ page }) => {
  const log = watchConsole(page);
  await openDemo(page);
  const gallery = await canvasStats(page);

  for (const id of ['morning', 'evening', 'overcast', 'raking', 'backlit', 'gallery']) {
    await press(page, 'lighting', id);
    expect(await page.evaluate(() => window.preview.renderer.toneMappingExposure)).toBeGreaterThan(0);
  }
  await press(page, 'lighting', 'evening');
  const evening = await canvasStats(page);
  // Evening light is warm: the red / blue balance moves towards red.
  expect(evening.rgb[0] - evening.rgb[2]).toBeGreaterThan(gallery.rgb[0] - gallery.rgb[2] + 5);
  await press(page, 'lighting', 'gallery');

  for (const id of ['silk', 'metallic', 'marble', 'wood', 'glitter', 'translucent', 'alpine']) {
    await press(page, 'palette', id);
  }
  for (const id of ['wallMode', 'exploded', 'seams', 'labels', 'layerLines', 'highlightWater']) {
    await press(page, 'toggles', id);
    await press(page, 'toggles', id);
  }

  await press(page, 'toggles', 'wallMode');
  const table = await canvasStats(page);
  expect(table.std).toBeGreaterThan(10);
  await press(page, 'toggles', 'wallMode');

  for (const id of ['terraced', 'lowpoly', 'lithophane']) await press(page, 'style', id);
  const litho = await canvasStats(page);
  expect(litho.std).toBeGreaterThan(10);
  // The lithophane hangs on a dark wall.
  expect(litho.mean).toBeLessThan(gallery.mean);
  await press(page, 'style', 'classic');

  await page.fill('#wallColor', '#3a5a7a');
  await rendered(page);
  const blueWall = await canvasStats(page);
  expect(blueWall.rgb[2]).toBeGreaterThan(blueWall.rgb[0]);

  expect(log.errors).toEqual([]);
  expect(log.warnings).toEqual([]);
});

test('exploded view spreads the tiles apart', async ({ page }) => {
  await openDemo(page);
  const before = await page.evaluate(() => window.preview.info.extent);
  await press(page, 'toggles', 'exploded');
  const after = await page.evaluate(() => window.preview.info.extent);
  // 3 columns, 2 rows of 160 mm tiles: gaps of 8 % of the tile size replace the 0.4 mm seams.
  expect(after.w - before.w).toBeCloseTo(2 * (0.08 * 160 - 0.4), 3);
  expect(after.h - before.h).toBeCloseTo(0.08 * 160 - 0.4, 3);
});

test('screenshot() renders offscreen at the requested size', async ({ page }) => {
  const log = watchConsole(page);
  await openDemo(page);
  const url = await page.evaluate(() => window.preview.screenshot({ width: 640, height: 400 }));
  expect(url.startsWith('data:image/png;base64,')).toBe(true);
  const stats = await imageStats(page, url);
  expect([stats.width, stats.height]).toEqual([640, 400]);
  expect(stats.std).toBeGreaterThan(12);

  const framed = await page.evaluate(() => window.preview.screenshot({ width: 300, height: 600, fit: true }));
  const framedStats = await imageStats(page, framed);
  expect([framedStats.width, framedStats.height]).toEqual([300, 600]);
  expect(framedStats.std).toBeGreaterThan(8);

  // The on-screen canvas keeps its size and content.
  const canvas = await page.evaluate(() => {
    const el = window.preview.renderer.domElement;
    return { buffer: [el.width, el.height], css: [el.clientWidth, el.clientHeight] };
  });
  expect(canvas.buffer).toEqual(canvas.css);
  expect((await canvasStats(page)).std).toBeGreaterThan(12);
  expect(log.errors).toEqual([]);
});

test('renders on demand only', async ({ page }) => {
  await openDemo(page);
  await page.waitForTimeout(500);
  const idle = await page.evaluate(() => window.preview.info.frames);
  await page.waitForTimeout(800);
  expect(await page.evaluate(() => window.preview.info.frames)).toBe(idle);

  const box = await page.locator('#view canvas').boundingBox();
  await page.mouse.move(box.x + box.width * 0.7, box.y + box.height * 0.6);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width * 0.6, box.y + box.height * 0.55, { steps: 4 });
  await page.mouse.up();
  await rendered(page);
  expect(await page.evaluate(() => window.preview.info.frames)).toBeGreaterThan(idle);
});

test('creaseNormals splits hard edges and keeps smooth surfaces shared', async ({ page }) => {
  await openDemo(page);
  const result = await page.evaluate(async () => {
    const { creaseNormals, buildTileGeometry } = await import('/app/js/preview/preview3d.js');
    // Unit cube, 8 vertices, 12 outward CCW triangles.
    const cube = new Float32Array([0, 0, 0, 1, 0, 0, 1, 1, 0, 0, 1, 0, 0, 0, 1, 1, 0, 1, 1, 1, 1, 0, 1, 1]);
    const cubeIdx = new Uint32Array([0, 2, 1, 0, 3, 2, 4, 5, 6, 4, 6, 7, 0, 1, 5, 0, 5, 4,
      1, 2, 6, 1, 6, 5, 2, 3, 7, 2, 7, 6, 3, 0, 4, 3, 4, 7]);
    const c = creaseNormals(cube, cubeIdx);
    const axisAligned = Array.from({ length: c.normals.length / 3 }, (_, i) => c.normals.slice(i * 3, i * 3 + 3))
      .every((n) => n.filter((v) => Math.abs(Math.abs(v) - 1) < 1e-6).length === 1 && n.filter((v) => v === 0).length === 2);
    // Gently curved 20 x 20 grid: no splits, every normal points up.
    const n = 20, pos = new Float32Array(n * n * 3), idx = [];
    for (let r = 0; r < n; r++) for (let q = 0; q < n; q++) pos.set([q, r, Math.sin(q * 0.3) * 0.5], (r * n + q) * 3);
    for (let r = 0; r < n - 1; r++) for (let q = 0; q < n - 1; q++) {
      const a = r * n + q;
      idx.push(a, a + 1, a + n + 1, a, a + n + 1, a + n);
    }
    const g = creaseNormals(pos, new Uint32Array(idx));
    let minUp = 1;
    for (let i = 2; i < g.normals.length; i += 3) minUp = Math.min(minUp, g.normals[i]);
    // Water flags follow the vertices through the split.
    const water = new Uint8Array(8); water[6] = 1;
    const geometry = buildTileGeometry({ positions: cube, indices: cubeIdx, water });
    const aWater = geometry.getAttribute('aWater');
    let wet = 0;
    for (let i = 0; i < aWater.count; i++) wet += aWater.getX(i) > 0 ? 1 : 0;
    geometry.dispose();
    return { cubeVertices: c.positions.length / 3, cubeIndices: c.indices.length, axisAligned,
      gridVertices: g.positions.length / 3, minUp, wet };
  });
  expect(result.cubeVertices).toBe(24);
  expect(result.cubeIndices).toBe(36);
  expect(result.axisAligned).toBe(true);
  expect(result.gridVertices).toBe(400);
  expect(result.minUp).toBeGreaterThan(0.8);
  expect(result.wet).toBe(3);
});

test('a newer setTiles supersedes an older one; dispose frees the canvas', async ({ page }) => {
  const log = watchConsole(page);
  await openDemo(page);
  const result = await page.evaluate(async () => {
    const preview = window.preview;
    // Height-field tile of n × n samples over 50 × 50 mm (top surface only is enough here).
    const tile = (label, col, n) => {
      const positions = new Float32Array(n * n * 3);
      const indices = new Uint32Array((n - 1) * (n - 1) * 6);
      for (let r = 0; r < n; r++) {
        for (let c = 0; c < n; c++) positions.set([c * 50 / (n - 1), 50 - r * 50 / (n - 1), 3 + Math.sin(c * 0.2) * Math.cos(r * 0.3)], (r * n + c) * 3);
      }
      let k = 0;
      for (let r = 0; r < n - 1; r++) {
        for (let c = 0; c < n - 1; c++) {
          const a = r * n + c;
          indices.set([a + n, a + n + 1, a + 1, a + n, a + 1, a], k);
          k += 6;
        }
      }
      return { label, row: 0, col, x0: col * 50, y0: 0, widthMm: 50, heightMm: 50, mesh: { positions, indices } };
    };
    // The first build is large enough to be time-sliced, so the second call overtakes it.
    const first = preview.setTiles([0, 1, 2, 3].map((c) => tile(`A${c + 1}`, c, 260)), { artW: 200, artH: 50, maxZ: 4 });
    const second = preview.setTiles([tile('A1', 0, 8), tile('A2', 1, 8)], { artW: 100, artH: 50, maxZ: 4 });
    await Promise.all([first, second]);
    await preview.whenRendered();
    const info = preview.info;
    const canvas = preview.renderer.domElement;
    preview.dispose();
    await preview.whenRendered();
    return { tiles: info.tiles, extent: info.extent, attached: canvas.isConnected, disposed: preview.info.disposed };
  });
  expect(result.tiles).toBe(2);
  expect(result.extent.w).toBeCloseTo(100.4, 3);
  expect(result.attached).toBe(false);
  expect(result.disposed).toBe(true);
  expect(log.errors).toEqual([]);
});
