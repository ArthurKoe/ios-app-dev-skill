import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { DATA_URL, fileFetch, readJSON } from './helpers.js';
import { frameBounds, frameUVToLatLon } from '../../app/js/core/projection.js';
import { ChunkCache, decodedBytes, retryOnce, runPool, sharedChunkCache } from '../../app/js/dem/cache.js';
import { LocalRegionSource } from '../../app/js/dem/localSource.js';
import { TerrariumSource, terrariumToElevation, MERCATOR_MAX_LAT } from '../../app/js/dem/terrariumSource.js';
import { ChunkGrid, chooseSource, findRegion, frameInsideBounds, sampleFrame } from '../../app/js/dem/sampler.js';
import * as sources from '../../app/js/dem/sources.js';

const FUJI_MANIFEST_URL = new URL('fuji/manifest.json', DATA_URL);
const fixture = await readJSON('tests/fixtures/rdem_expected.json');
const fujiManifest = await readJSON('data/fuji/manifest.json');
const SUMMIT = { lat: fixture.point.lat, lon: fixture.point.lon };
/** The "Mount Fuji" preset: 40 × 35 km around the summit. */
const FUJI_FRAME = { lat: 35.36, lon: 138.73, widthKm: 40, heightKm: 35, rotationDeg: 0 };
/** 40 × 35 km reaching from the summit down to the head of Suruga Bay. */
const SURUGA_FRAME = { lat: 35.22, lon: 138.72, widthKm: 40, heightKm: 35, rotationDeg: 0 };
const LAKE_YAMANAKA = [35.418, 138.875];
const LAKE_MOTOSU = [35.465, 138.58];
const SURUGA_BAY = [35.08, 138.75];

/** fetch wrapper that records requested URLs and the peak number of concurrent requests. */
function recordingFetch(inner = fileFetch, { delayMs = 0 } = {}) {
  const f = async (url, init) => {
    f.urls.push(String(url));
    f.inFlight++;
    f.maxInFlight = Math.max(f.maxInFlight, f.inFlight);
    try {
      if (delayMs) await new Promise((r) => setTimeout(r, delayMs));
      init?.signal?.throwIfAborted();
      return await inner(url, init);
    } finally {
      f.inFlight--;
    }
  };
  f.urls = [];
  f.inFlight = 0;
  f.maxInFlight = 0;
  return f;
}

/** Fuji source with its own cache so fetch counts are not affected by other tests. */
function fujiSource(manifest = fujiManifest, fetchImpl = fileFetch) {
  return new LocalRegionSource(structuredClone(manifest), FUJI_MANIFEST_URL, { fetchImpl, cache: new ChunkCache() });
}

function countOnes(a) {
  let n = 0;
  for (const v of a) n += v;
  return n;
}

// ------------------------------------------------------------------------------------- cache

describe('ChunkCache', () => {
  test('evicts least-recently-used entries by decoded bytes', () => {
    const cache = new ChunkCache(100);
    cache.set('a', { elev: new Float32Array(10) }); // 40 B
    cache.set('b', { elev: new Float32Array(10) }); // 80 B
    assert.equal(cache.bytes, 80);
    assert.ok(cache.get('a')); // a is now most recent
    cache.set('c', { elev: new Float32Array(5), water: new Uint8Array(5) }); // 25 B → 105 > 100
    assert.equal(cache.has('b'), false, 'b was least recently used');
    assert.ok(cache.has('a') && cache.has('c'));
    assert.equal(cache.bytes, 65);
    assert.equal(cache.size, 2);
    cache.set('huge', { elev: new Float32Array(100) });
    assert.equal(cache.has('huge'), false, 'entries larger than the capacity are not kept');
    cache.set('a', { elev: new Float32Array(1) });
    assert.equal(cache.bytes, 29, 'replacing an entry updates the byte count');
    assert.equal(cache.delete('a'), true);
    cache.clear();
    assert.equal(cache.bytes, 0);
    assert.equal(cache.size, 0);
  });

  test('decodedBytes sums the typed arrays of a chunk', () => {
    assert.equal(decodedBytes({ width: 3, elev: new Float32Array(6), water: new Uint8Array(6), min: 1 }), 30);
    assert.equal(decodedBytes({ elev: new Float32Array(2), water: null }), 8);
    assert.equal(decodedBytes(null), 0);
  });

  test('load() shares in-flight loads and does not cache failures or nulls', async () => {
    const cache = new ChunkCache(1e6);
    let calls = 0;
    const loader = async () => { calls++; await new Promise((r) => setTimeout(r, 5)); return { elev: new Float32Array(4) }; };
    const [a, b] = await Promise.all([cache.load('k', loader), cache.load('k', loader)]);
    assert.equal(calls, 1);
    assert.equal(a, b);
    assert.equal(await cache.load('k', loader), a);
    assert.equal(calls, 1);

    await assert.rejects(cache.load('bad', async () => { throw new Error('boom'); }), /boom/);
    assert.equal(cache.has('bad'), false);
    assert.equal(await cache.load('bad', async () => null), null);
    assert.equal(cache.has('bad'), false);
  });

  test('sharedChunkCache defaults to 600 MB', () => {
    assert.equal(sharedChunkCache.maxBytes, 600e6);
  });
});

describe('loading helpers', () => {
  test('runPool limits concurrency and stops after a failure', async () => {
    let active = 0;
    let peak = 0;
    const done = [];
    await runPool([...Array(20).keys()], 6, async (i) => {
      active++;
      peak = Math.max(peak, active);
      await new Promise((r) => setTimeout(r, 2));
      active--;
      done.push(i);
    });
    assert.equal(peak, 6);
    assert.equal(done.length, 20);

    const started = [];
    await assert.rejects(runPool([...Array(50).keys()], 3, async (i) => {
      started.push(i);
      await new Promise((r) => setTimeout(r, 1));
      if (i === 4) throw new Error('fail');
    }), /fail/);
    assert.ok(started.length < 10, `started ${started.length} items after the failure`);
  });

  test('retryOnce retries once, but not after an abort', async () => {
    let n = 0;
    assert.equal(await retryOnce(async () => { if (n++ === 0) throw new Error('flaky'); return 'ok'; }), 'ok');
    n = 0;
    await assert.rejects(retryOnce(async () => { n++; throw new Error('down'); }), /down/);
    assert.equal(n, 2);
    const ctl = new AbortController();
    ctl.abort();
    n = 0;
    await assert.rejects(retryOnce(async () => { n++; throw new Error('x'); }, ctl.signal), { name: 'AbortError' });
    assert.equal(n, 1);
  });
});

// ------------------------------------------------------------------------------------- ChunkGrid

describe('ChunkGrid', () => {
  /** 2 × 2 chunks of 3 rows × 4 cols holding the plane e = 10·gy + gx (global pixels). */
  function planeGrid({ hole = null, skip = null } = {}) {
    const grid = new ChunkGrid({ rowMin: 5, rowMax: 6, colMin: 7, colMax: 8, chunkRows: 3, chunkCols: 4 });
    for (const cr of [5, 6]) {
      for (const cc of [7, 8]) {
        if (skip && skip[0] === cr && skip[1] === cc) continue;
        const elev = new Float32Array(12);
        const water = new Uint8Array(12);
        for (let y = 0; y < 3; y++) {
          for (let x = 0; x < 4; x++) {
            const gy = cr * 3 + y;
            const gx = cc * 4 + x;
            elev[y * 4 + x] = hole && hole[0] === gy && hole[1] === gx ? NaN : 10 * gy + gx;
            water[y * 4 + x] = gx % 2;
          }
        }
        grid.set(cr, cc, { width: 4, height: 3, elev, water });
      }
    }
    return grid;
  }

  test('bilinear interpolation is seamless across chunk boundaries', () => {
    const grid = planeGrid();
    const plane = (gy, gx) => 10 * gy + gx;
    for (const [gy, gx] of [[15.5, 28.5], [17.25, 31.75], [17.9, 31.1], [15, 28], [20, 35], [16.4, 33.6], [18, 32]]) {
      assert.ok(Math.abs(grid.value(gy, gx) - plane(gy, gx)) < 1e-9, `(${gy}, ${gx})`);
    }
    assert.ok(Number.isNaN(grid.value(14, 30)), 'row 14 is outside the window');
    assert.equal(grid.value(14.5, 30), 180, 'only the neighbours inside the window count');
    assert.ok(Number.isNaN(grid.value(17, 36.5)), 'right of the last column');
  });

  test('nodata neighbours are skipped and the remaining weights renormalised', () => {
    const grid = planeGrid({ hole: [16, 29] });
    const fy = 0.25;
    const fx = 0.5;
    // neighbours: (16,29)=NaN, (16,30), (17,29), (17,30)
    const w = [fx * (1 - fy), (1 - fx) * fy, fx * fy]; // weights of (16,30), (17,29), (17,30)
    const v = [190, 199, 200];
    const expected = (w[0] * v[0] + w[1] * v[1] + w[2] * v[2]) / (w[0] + w[1] + w[2]);
    assert.ok(Math.abs(grid.value(16 + fy, 29 + fx) - expected) < 1e-9);
    assert.equal(grid.value(16, 30), 190, 'exact pixel next to the hole');
    assert.ok(Number.isNaN(grid.value(16, 29)), 'exactly on the hole: no weight left');
  });

  test('a missing chunk only removes its own pixels', () => {
    const grid = planeGrid({ skip: [6, 8] }); // global rows 18-20, cols 32-35
    assert.ok(Number.isNaN(grid.value(19, 33.5)));
    // straddles the missing chunk: (17,31) and (17,32) and (18,31) exist, (18,32) is missing
    const fy = 0.5;
    const fx = 0.5;
    const expected = (0.25 * 201 + 0.25 * 202 + 0.25 * 211) / 0.75;
    assert.ok(Math.abs(grid.value(17 + fy, 31 + fx) - expected) < 1e-9);
  });

  test('water() returns the nearest pixel flag, -1 without data', () => {
    const grid = planeGrid({ hole: [16, 29], skip: [6, 8] });
    assert.equal(grid.water(16.2, 28.4), 0); // nearest (16, 28)
    assert.equal(grid.water(16.2, 28.6), -1); // nearest (16, 29) is nodata
    assert.equal(grid.water(15.4, 30.6), 1); // nearest (15, 31)
    assert.equal(grid.water(19, 33), -1); // missing chunk
  });

  test('rejects chunks of the wrong size or outside the window', () => {
    const grid = new ChunkGrid({ rowMin: 0, rowMax: 0, colMin: 0, colMax: 0, chunkRows: 2, chunkCols: 2 });
    assert.throws(() => grid.set(0, 0, { width: 3, height: 2, elev: new Float32Array(6), water: null }), /expected 2×2/);
    assert.throws(() => grid.set(1, 0, { width: 2, height: 2, elev: new Float32Array(4), water: null }), RangeError);
  });

  test('wrapCols makes chunk columns wrap around the globe', () => {
    const grid = new ChunkGrid({ rowMin: 0, rowMax: 0, colMin: -1, colMax: 0, chunkRows: 2, chunkCols: 2, wrapCols: 4 });
    grid.set(0, -1, { width: 2, height: 2, elev: Float32Array.from([30, 31, 30, 31]), water: null });
    grid.set(0, 0, { width: 2, height: 2, elev: Float32Array.from([0, 1, 0, 1]), water: null });
    assert.equal(grid.get(0, 3), grid.get(0, -1), 'column 3 is column -1');
    assert.equal(grid.value(0.5, 6.5), 30.5);
    assert.equal(grid.value(0.5, 7.5), 15.5, 'interpolates from the last column to column 0');
    assert.equal(grid.value(0.5, -0.5), 15.5, 'same position, unwrapped');
  });
});

// ------------------------------------------------------------------------------------- local source

describe('LocalRegionSource (data/fuji)', () => {
  test('load() reads the manifest; chunk URLs resolve relative to it', async () => {
    const f = recordingFetch();
    const src = await LocalRegionSource.load(FUJI_MANIFEST_URL, { fetchImpl: f, cache: new ChunkCache() });
    assert.equal(src.id, 'fuji');
    assert.deepEqual(src.bounds, { south: 35, west: 138, north: 36, east: 139 });
    assert.equal(src.manifest.levels.length, 2);
    await src.prepare({ ...FUJI_FRAME, widthKm: 2, heightKm: 2 }, 30);
    assert.ok(f.urls.slice(1).every((u) => u.startsWith(new URL('L', FUJI_MANIFEST_URL).href.slice(0, -1))));
    assert.ok(f.urls.some((u) => u.endsWith('/fuji/L0/218_1274.rdem')));
    await assert.rejects(LocalRegionSource.load(new URL('nowhere/manifest.json', DATA_URL), { fetchImpl: fileFetch }), /HTTP 404/);
  });

  test('chooseLevel picks the coarsest level fine enough, else the finest', () => {
    const fuji = fujiSource();
    assert.equal(fuji.chooseLevel(10), 0);
    assert.equal(fuji.chooseLevel(30.9), 0);
    assert.equal(fuji.chooseLevel(60), 0);
    assert.equal(fuji.chooseLevel(92.8), 1);
    assert.equal(fuji.chooseLevel(5000), 1);
    const levels = [30, 90, 180, 360].map((pixelSizeM, level) => ({
      level, pixelSizeM, complete: level !== 0, chunks: [], bytes: 0, ppdLat: 1, ppdLon: 1, chunkRows: 1, chunkCols: 1,
    }));
    const src = new LocalRegionSource({ id: 'x', bounds: {}, levels }, 'file:///tmp/x/manifest.json');
    assert.deepEqual([5, 30, 89, 90, 179, 200, 359.9, 360, 1e6].map((g) => src.chooseLevel(g)), [0, 0, 0, 1, 1, 2, 2, 3, 3]);
    assert.equal(src.fallbackLevel(0), 1);
    assert.equal(src.fallbackLevel(3), -1);
  });

  test('samples the Mt Fuji summit at L0 like the reference decoder', async () => {
    const src = fujiSource();
    const info = await src.prepare({ lat: SUMMIT.lat, lon: SUMMIT.lon, widthKm: 3, heightKm: 3, rotationDeg: 0 }, 25);
    assert.equal(info.level, 0);
    assert.equal(info.levelIndex, 0);
    assert.equal(info.fallbackLevel, 1);
    assert.equal(info.pixelSizeM, 30.9);
    assert.match(info.label, /GLO-30/);
    const e = src.sample(SUMMIT.lat, SUMMIT.lon);
    assert.ok(Math.abs(e - fixture.point.elev) <= fixture.point.tolerance, `summit ${e} vs ${fixture.point.elev}`);
    assert.equal(src.isWater(SUMMIT.lat, SUMMIT.lon), false);
    assert.ok(Number.isNaN(src.sample(34.5, 138.5)), 'outside the region');
    assert.equal(src.isWater(34.5, 138.5), false);
  });

  test('prepare() loads exactly the chunks intersecting frameBounds (+2 px) at the chosen and fallback level', async () => {
    const frame = { lat: 35.4, lon: 138.5, widthKm: 30, heightKm: 20, rotationDeg: 20 };
    const f = recordingFetch();
    const src = fujiSource(fujiManifest, f);
    const progress = [];
    const info = await src.prepare(frame, 40, { onProgress: (p) => progress.push(p) });

    const b = frameBounds(frame);
    const expected = [];
    for (const L of fujiManifest.levels) {
      const r0 = Math.floor(((90 - b.north) * L.ppdLat - 2) / L.chunkRows);
      const r1 = Math.floor(((90 - b.south) * L.ppdLat + 2) / L.chunkRows);
      const c0 = Math.floor(((b.west + 180) * L.ppdLon - 2) / L.chunkCols);
      const c1 = Math.floor(((b.east + 180) * L.ppdLon + 2) / L.chunkCols);
      for (const [cr, cc] of L.chunks) {
        if (cr >= r0 && cr <= r1 && cc >= c0 && cc <= c1) expected.push(new URL(`L${L.level}/${cr}_${cc}.rdem`, FUJI_MANIFEST_URL).href);
      }
    }
    assert.deepEqual([...f.urls].sort(), expected.sort());
    assert.equal(info.chunks, expected.length);
    assert.equal(info.level, 0);

    const last = progress.at(-1);
    assert.deepEqual(progress[0], { loaded: 0, total: expected.length, bytes: 0, fraction: 0 });
    assert.equal(last.loaded, expected.length);
    assert.equal(last.total, expected.length);
    assert.equal(last.fraction, 1);
    assert.equal(info.bytes, last.bytes);
    const fileBytes = (await Promise.all(expected.map(async (u) => (await fileFetch(new URL(u))).arrayBuffer())))
      .reduce((s, buf) => s + buf.byteLength, 0);
    assert.equal(last.bytes, fileBytes);
    assert.ok(progress.every((p, i) => i === 0 || p.loaded === progress[i - 1].loaded + 1));

    // decoded chunks are cached by URL: a repeated preview does not refetch
    f.urls.length = 0;
    await src.prepare(frame, 40);
    assert.equal(f.urls.length, 0);
    assert.ok(src.cache.size >= expected.length);
  });

  test('downloads at most 6 chunks at a time', async () => {
    const f = recordingFetch(fileFetch, { delayMs: 10 });
    const src = fujiSource(fujiManifest, f);
    const info = await src.prepare({ lat: 35.5, lon: 138.5, widthKm: 85, heightKm: 105, rotationDeg: 0 }, 35);
    assert.ok(info.chunks >= 12);
    assert.equal(f.maxInFlight, 6);
  });

  test('samples the Mount Fuji frame: summit height and the Fuji Five Lakes', async () => {
    const src = fujiSource();
    await src.prepare(FUJI_FRAME, 100);
    const s = await sampleFrame(src, FUJI_FRAME, 400, 350);
    assert.equal(s.elev.length, 400 * 350);
    assert.equal(s.missing, 0);
    assert.ok(s.maxElev >= 3700 && s.maxElev <= 3780, `max ${s.maxElev}`);
    assert.ok(s.minElev > 0, 'no sea in this frame');
    const water = countOnes(s.water);
    assert.ok(water > 400 && water < 0.05 * s.water.length, `${water} water samples`);
    for (const [lat, lon] of [LAKE_YAMANAKA, LAKE_MOTOSU]) {
      assert.equal(src.isWater(lat, lon), true, `lake at ${lat}, ${lon}`);
      const e = src.sample(lat, lon);
      assert.ok(e > 850 && e < 1000, `lake level ${e}`);
    }
    // lakes are flat: all water samples of Lake Yamanaka share one level
    const levels = new Set();
    for (let i = 0; i < s.elev.length; i++) if (s.water[i] && Math.abs(s.elev[i] - 981) < 5) levels.add(s.elev[i]);
    assert.ok(levels.size > 0);
  });

  test('finds the sea of Suruga Bay', async () => {
    const src = fujiSource();
    await src.prepare(SURUGA_FRAME, 100);
    const s = await sampleFrame(src, SURUGA_FRAME, 400, 350);
    assert.equal(s.missing, 0);
    assert.ok(s.maxElev >= 3700 && s.maxElev <= 3780, `max ${s.maxElev}`);
    assert.ok(s.minElev <= 0.5, `min ${s.minElev}`);
    assert.equal(src.isWater(...SURUGA_BAY), true);
    assert.ok(Math.abs(src.sample(...SURUGA_BAY)) < 0.5);
    // the bottom rows (south) contain sea at ~0 m
    let sea = 0;
    for (let i = 349 * 400; i < 350 * 400; i++) if (s.water[i] && Math.abs(s.elev[i]) < 1) sea++;
    assert.ok(sea > 40, `${sea} sea samples on the southern edge`);
  });

  test('falls back to the next coarser complete level outside partial L0 coverage', async () => {
    const partial = structuredClone(fujiManifest);
    partial.levels[0].complete = false;
    partial.levels[0].coverage = 'mountainous areas only';
    partial.levels[0].chunks = partial.levels[0].chunks.filter(([cr, cc]) => !(cr === 218 && cc === 1274));
    const l1Only = structuredClone(fujiManifest);
    l1Only.levels = [l1Only.levels[1]];

    const frame = { lat: 35.4, lon: 138.72, widthKm: 30, heightKm: 30, rotationDeg: 0 };
    const full = fujiSource();
    const a = fujiSource(partial);
    const b = fujiSource(l1Only);
    await full.prepare(frame, 35);
    const info = await a.prepare(frame, 35);
    await b.prepare(frame, 35);
    assert.equal(info.level, 0);
    assert.equal(info.fallbackLevel, 1);
    assert.match(info.label, /L1 fallback/);

    // the summit lies in the removed L0 chunk → value comes from L1
    const fromL1 = b.sample(SUMMIT.lat, SUMMIT.lon);
    assert.equal(a.sample(SUMMIT.lat, SUMMIT.lon), fromL1);
    assert.ok(Math.abs(fromL1 - fixture.point.elev) > 5, 'L1 differs from L0 at the summit');
    // elsewhere (L0 chunks 218_1275 and 217_1274) L0 is still used
    for (const [lat, lon] of [[35.4512, 138.8031], [35.5207, 138.6033]]) {
      assert.equal(a.sample(lat, lon), full.sample(lat, lon));
      assert.notEqual(a.sample(lat, lon), b.sample(lat, lon));
    }
  });

  test('a partial level without chunks in the frame is replaced by its fallback', async () => {
    const partial = structuredClone(fujiManifest);
    partial.levels[0].complete = false;
    partial.levels[0].chunks = [[216, 1272]];
    const info = await fujiSource(partial).prepare({ ...FUJI_FRAME, widthKm: 10, heightKm: 10 }, 35);
    assert.equal(info.level, 1);
    assert.equal(info.fallbackLevel, null);
  });

  test('steps to a coarser level when the estimated download or decoded size is too large', async () => {
    const src = fujiSource();
    const fine = await src.prepare(FUJI_FRAME, 35);
    assert.equal(fine.level, 0);
    assert.ok(fine.estimatedBytes > 1.5e6);
    const coarse = await src.prepare(FUJI_FRAME, 35, { maxBytes: 1.5e6 });
    assert.equal(coarse.level, 1);
    assert.ok(coarse.estimatedBytes <= 1.5e6);
    // decoded memory: 8 L0 chunks (900×750×5 B) + 4 L1 chunks (600×500×5 B) ≈ 33 MB
    assert.equal((await src.prepare(FUJI_FRAME, 35, { maxDecodedBytes: 40e6 })).level, 0);
    assert.equal((await src.prepare(FUJI_FRAME, 35, { maxDecodedBytes: 20e6 })).level, 1);
  });

  test('honours AbortSignal', async () => {
    const pre = new AbortController();
    pre.abort();
    await assert.rejects(fujiSource().prepare(FUJI_FRAME, 35, { signal: pre.signal }), { name: 'AbortError' });

    const f = recordingFetch(fileFetch, { delayMs: 15 });
    const ctl = new AbortController();
    const src = fujiSource(fujiManifest, f);
    const p = src.prepare({ lat: 35.5, lon: 138.5, widthKm: 85, heightKm: 105, rotationDeg: 0 }, 35, {
      signal: ctl.signal,
      onProgress: ({ loaded }) => { if (loaded === 1) ctl.abort(); },
    });
    await assert.rejects(p, { name: 'AbortError' });
    assert.ok(f.urls.length < 20, `${f.urls.length} requests before the abort took effect`);
  });

  test('retries a failed chunk download once', async () => {
    const failedOnce = new Set();
    const flaky = async (url, init) => {
      if (String(url).endsWith('.rdem') && !failedOnce.has(String(url))) {
        failedOnce.add(String(url));
        throw new TypeError('network glitch');
      }
      return fileFetch(url, init);
    };
    const info = await fujiSource(fujiManifest, flaky).prepare({ ...FUJI_FRAME, widthKm: 5, heightKm: 5 }, 35);
    assert.ok(info.chunks > 0);

    const broken = async (url, init) => (String(url).endsWith('.rdem') ? new Response('', { status: 500 }) : fileFetch(url, init));
    await assert.rejects(fujiSource(fujiManifest, broken).prepare(FUJI_FRAME, 35), /HTTP 500/);
  });

  test('a chunk file missing on the server is skipped and covered by the fallback level', async () => {
    const missing = async (url, init) => (String(url).endsWith('/L0/218_1274.rdem') ? new Response('', { status: 404 }) : fileFetch(url, init));
    const src = fujiSource(fujiManifest, missing);
    const frame = { lat: SUMMIT.lat, lon: SUMMIT.lon, widthKm: 3, heightKm: 3, rotationDeg: 0 };
    const info = await src.prepare(frame, 35);
    const l1 = fujiSource({ ...fujiManifest, levels: [fujiManifest.levels[1]] });
    await l1.prepare(frame, 35);
    assert.equal(src.sample(SUMMIT.lat, SUMMIT.lon), l1.sample(SUMMIT.lat, SUMMIT.lon));
    assert.ok(info.chunks >= 1);
  });

  test('samples outside the data are reported as missing and filled with 0', async () => {
    const src = fujiSource();
    const frame = { lat: 35.0, lon: 138.5, widthKm: 20, heightKm: 20, rotationDeg: 0 };
    await src.prepare(frame, 200);
    const s = await sampleFrame(src, frame, 101, 101);
    // the southern half of the frame lies south of the region (35°N)
    assert.ok(s.missing >= 49 * 101 && s.missing <= 52 * 101, `${s.missing} missing`);
    assert.equal(s.elev[100 * 101 + 50], 0);
    assert.ok(s.maxElev > 100);
  });
});

// ------------------------------------------------------------------------------------- sampleFrame

describe('sampleFrame', () => {
  /** Source that records every lookup position. */
  function recordingSource(fn = () => 1) {
    return {
      lats: [],
      lons: [],
      async prepare() { return {}; },
      sample(lat, lon) { this.lats.push(lat); this.lons.push(lon); return fn(lat, lon); },
      isWater() { return false; },
    };
  }

  test('sample (r, c) is taken at frameUVToLatLon(frame, c/(nx-1), r/(ny-1))', async () => {
    for (const frame of [
      { lat: 46.2, lon: 9.1, widthKm: 300, heightKm: 180, rotationDeg: 0 },
      { lat: -43.5, lon: 170, widthKm: 80, heightKm: 60, rotationDeg: 37 },
      { lat: 64, lon: -150, widthKm: 500, heightKm: 900, rotationDeg: -100 },
    ]) {
      const nx = 23;
      const ny = 17;
      const src = recordingSource();
      await sampleFrame(src, frame, nx, ny);
      assert.equal(src.lats.length, nx * ny);
      let worst = 0;
      for (let r = 0; r < ny; r++) {
        for (let c = 0; c < nx; c++) {
          const [lat, lon] = frameUVToLatLon(frame, c / (nx - 1), r / (ny - 1));
          const i = r * nx + c;
          worst = Math.max(worst, Math.abs(src.lats[i] - lat), Math.abs(src.lons[i] - lon));
        }
      }
      assert.ok(worst < 1e-9, `worst position error ${worst}° at rotation ${frame.rotationDeg}`);
    }
  });

  test('fills missing samples with 0, counts them and computes min/max over valid ones', async () => {
    const frame = { lat: 10, lon: 20, widthKm: 50, heightKm: 50, rotationDeg: 0 };
    const src = recordingSource((lat, lon) => (lon < 20 ? NaN : 100 + (lat - 10) * 1000));
    src.isWater = (lat) => lat > 10;
    const s = await sampleFrame(src, frame, 11, 5);
    assert.equal(s.missing, 5 * 5);
    for (let r = 0; r < 5; r++) {
      for (let c = 0; c < 5; c++) assert.equal(s.elev[r * 11 + c], 0);
    }
    let lo = Infinity;
    let hi = -Infinity;
    for (let r = 0; r < 5; r++) {
      for (let c = 5; c < 11; c++) {
        const e = Math.fround(100 + (frameUVToLatLon(frame, c / 10, r / 4)[0] - 10) * 1000);
        lo = Math.min(lo, e);
        hi = Math.max(hi, e);
      }
    }
    assert.ok(Math.abs(s.maxElev - hi) < 1e-3 && Math.abs(s.minElev - lo) < 1e-3, `${s.minElev}..${s.maxElev}`);
    assert.equal(s.water[0], 1);
    assert.equal(s.water[4 * 11], 0);
    assert.ok(s.elev instanceof Float32Array && s.water instanceof Uint8Array);

    const none = await sampleFrame(recordingSource(() => NaN), frame, 3, 3);
    assert.deepEqual([none.missing, none.minElev, none.maxElev], [9, 0, 0]);
  });

  test('validates sizes, reports progress and honours AbortSignal', async () => {
    const frame = { lat: 0, lon: 0, widthKm: 10, heightKm: 10, rotationDeg: 0 };
    await assert.rejects(sampleFrame(recordingSource(), frame, 1, 5), RangeError);
    const progress = [];
    await sampleFrame(recordingSource(), frame, 4, 4, { onProgress: (p) => progress.push(p) });
    assert.deepEqual(progress.at(-1), { loaded: 4, total: 4, fraction: 1 });
    const ctl = new AbortController();
    ctl.abort();
    await assert.rejects(sampleFrame(recordingSource(), frame, 4, 4, { signal: ctl.signal }), { name: 'AbortError' });

    // a long run yields to the event loop, so an abort issued meanwhile is honoured
    const slow = recordingSource(() => { const t = performance.now(); while (performance.now() - t < 0.02); return 1; });
    const ctl2 = new AbortController();
    setTimeout(() => ctl2.abort(), 20);
    await assert.rejects(sampleFrame(slow, frame, 200, 200, { signal: ctl2.signal }), { name: 'AbortError' });
  });

  test('samples 3 M points from Fuji L0 in < 3 s', async () => {
    const src = fujiSource();
    await src.prepare(FUJI_FRAME, 20);
    let best = Infinity;
    let s;
    for (let k = 0; k < 3; k++) { // best of 3: robust against other test files running in parallel
      const t0 = performance.now();
      s = await sampleFrame(src, FUJI_FRAME, 2000, 1500);
      best = Math.min(best, performance.now() - t0);
    }
    assert.equal(s.missing, 0);
    assert.ok(s.maxElev > 3700);
    // ~0.5 s on one idle core; the generous bound only catches real regressions on busy CI machines.
    assert.ok(best < 3000, `${best.toFixed(0)} ms for 3 M samples`);
  });
});

// ------------------------------------------------------------------------------------- chooseSource

describe('chooseSource', () => {
  const index = {
    regions: [
      { id: 'fuji', bounds: { south: 35, west: 138, north: 36, east: 139 }, manifest: 'fuji/manifest.json' },
      { id: 'alps', bounds: { south: 43, west: 4, north: 49, east: 17 }, manifest: 'alps/manifest.json' },
    ],
  };
  const inside = { lat: 35.36, lon: 138.73, widthKm: 40, heightKm: 35, rotationDeg: 0 };
  const straddling = { lat: 35.05, lon: 138.73, widthKm: 40, heightKm: 35, rotationDeg: 0 };

  test('auto uses local data when the frame lies inside the region', () => {
    assert.equal(chooseSource({ source: 'auto', regionId: 'fuji', frame: inside }, index), 'local');
    assert.equal(chooseSource({ source: 'auto', regionId: 'fuji', frame: straddling }, index), 'live');
    assert.equal(chooseSource({ source: 'auto', regionId: 'alps', frame: inside }, index), 'live');
    assert.equal(chooseSource({ source: 'auto', regionId: 'world', frame: inside }, index), 'live');
    assert.equal(chooseSource({ regionId: 'alps', frame: { lat: 45.95, lon: 10.75, widthKm: 900, heightKm: 450, rotationDeg: 0 } }, index), 'local');
    assert.equal(chooseSource({ source: 'auto', regionId: 'fuji', frame: inside }, index.regions), 'local', 'accepts the regions array');
  });

  test('explicit choices are honoured', () => {
    assert.equal(chooseSource({ source: 'live', regionId: 'fuji', frame: inside }, index), 'live');
    assert.equal(chooseSource({ source: 'local', regionId: 'fuji', frame: straddling }, index), 'local');
    assert.equal(chooseSource({ source: 'local', regionId: 'world', frame: inside }, index), 'live', 'no stored data for world');
    assert.equal(chooseSource({ source: 'auto', regionId: 'fuji', frame: inside }, null), 'live');
  });

  test('helpers: findRegion and frameInsideBounds', () => {
    assert.equal(findRegion(index, 'alps').id, 'alps');
    assert.equal(findRegion(index, 'nope'), null);
    assert.equal(frameInsideBounds(inside, index.regions[0].bounds), true);
    assert.equal(frameInsideBounds({ ...inside, rotationDeg: 45, widthKm: 120 }, index.regions[0].bounds), false);
  });

  test('sources.js re-exports chooseSource', () => {
    assert.equal(sources.chooseSource, chooseSource);
  });
});

// ------------------------------------------------------------------------------------- Terrarium

/** Web Mercator global pixel coordinates (pixel centres at integers) at zoom z. */
function mercPixel(lat, lon, z) {
  const world = 256 * 2 ** z;
  const phi = (lat * Math.PI) / 180;
  const y = 0.5 - Math.log(Math.tan(Math.PI / 4 + phi / 2)) / (2 * Math.PI);
  return [y * world - 0.5, ((lon + 180) / 360) * world - 0.5];
}

/** Encodes an elevation (multiple of 1/256 m) as Terrarium RGB. */
function terrariumRGB(e) {
  const v = e + 32768;
  const i = Math.floor(v);
  return [i >> 8, i & 255, Math.round((v - i) * 256)];
}

/**
 * Synthetic Terrarium server: fetch returns "z/x/y" as the body, decodePng renders
 * elevation(gy, gx, z) for every pixel of that tile.
 */
function syntheticTiles(elevation, { missing = new Set() } = {}) {
  const fetchImpl = async (url) => {
    fetchImpl.urls.push(url);
    const m = /tiles\/(\d+)\/(\d+)\/(\d+)\.png$/.exec(url);
    if (!m || missing.has(`${m[1]}/${m[2]}/${m[3]}`)) return new Response('', { status: 404 });
    return new Response(`${m[1]}/${m[2]}/${m[3]}`, { status: 200 });
  };
  fetchImpl.urls = [];
  const decodePng = async (blob) => {
    const [z, x, y] = (await blob.text()).split('/').map(Number);
    const data = new Uint8ClampedArray(256 * 256 * 4);
    for (let j = 0; j < 256; j++) {
      for (let i = 0; i < 256; i++) {
        const [r, g, b] = terrariumRGB(elevation(y * 256 + j, x * 256 + i, z));
        const p = (j * 256 + i) * 4;
        data[p] = r;
        data[p + 1] = g;
        data[p + 2] = b;
        data[p + 3] = 255;
      }
    }
    return { width: 256, height: 256, data };
  };
  return { fetchImpl, decodePng, urlTemplate: 'https://tiles.test/tiles/{z}/{x}/{y}.png' };
}

describe('TerrariumSource', () => {
  test('chooseZoom: coarsest zoom with ground pixel <= spacing, clamped to [1, maxZoom]', () => {
    const src = new TerrariumSource({ maxZoom: 15 });
    const R = 6371008.8;
    for (const lat of [0, 35, 46, -60]) {
      for (const g of [3, 10, 30, 75, 300, 2000, 20000]) {
        let z = 0;
        while (z < 15 && (2 * Math.PI * R * Math.cos((lat * Math.PI) / 180)) / (256 * 2 ** z) > g) z++;
        assert.equal(src.chooseZoom(g, lat), Math.max(1, z), `lat ${lat}, spacing ${g}`);
      }
    }
    assert.equal(src.chooseZoom(1e7, 0), 1);
    assert.equal(src.chooseZoom(0.5, 0), 15);
    assert.equal(new TerrariumSource({ maxZoom: 12 }).chooseZoom(1, 46), 12);
    assert.ok(Math.abs(src.pixelSizeM(13, 0) - (2 * Math.PI * R) / (256 * 8192)) < 1e-9);
  });

  test('terrariumToElevation decodes R*256 + G + B/256 - 32768 and flags the sea', () => {
    const data = Uint8ClampedArray.from([
      ...terrariumRGB(1234.5), 255,
      ...terrariumRGB(0), 255,
      ...terrariumRGB(-250.25), 255,
      ...terrariumRGB(8848), 255,
    ]);
    const t = terrariumToElevation({ width: 2, height: 2, data });
    assert.deepEqual(Array.from(t.elev), [1234.5, 0, 0, 8848]);
    assert.deepEqual(Array.from(t.water), [0, 1, 1, 0]);
    const deep = terrariumToElevation({ width: 2, height: 2, data }, true);
    assert.deepEqual(Array.from(deep.elev), [1234.5, 0, -250.25, 8848]);
    assert.deepEqual(Array.from(deep.water), [0, 1, 1, 0]);
  });

  test('prepare + sample: bilinear across tile boundaries with injected fetch/decodePng', async () => {
    const frame = { lat: 46, lon: 10, widthKm: 20, heightKm: 20, rotationDeg: 15 };
    const z = 10;
    const [cy, cx] = mercPixel(frame.lat, frame.lon, z).map(Math.round);
    const plane = (gy, gx) => 1000 + 0.5 * (gx - cx) - 0.25 * (gy - cy);
    const tiles = syntheticTiles((gy, gx) => plane(gy, gx));
    const src = new TerrariumSource({ ...tiles, cache: new ChunkCache() });
    const progress = [];
    const info = await src.prepare(frame, 120, { onProgress: (p) => progress.push(p) });
    assert.equal(info.zoom, z);
    assert.equal(info.level, z);
    assert.equal(info.missingTiles, 0);
    assert.ok(info.chunks >= 2 && info.chunks <= 9, `${info.chunks} tiles`);
    assert.equal(tiles.fetchImpl.urls.length, info.chunks);
    assert.ok(tiles.fetchImpl.urls.every((u) => u.startsWith('https://tiles.test/tiles/10/')));
    assert.match(info.label, /z10/);
    assert.ok(Math.abs(info.pixelSizeM - src.pixelSizeM(10, 46)) < 1e-9);
    assert.equal(progress.at(-1).fraction, 1);

    // tile boundaries inside the frame
    const b = frameBounds(frame);
    const x0 = Math.ceil(mercPixel(b.north, b.west, z)[1] / 256) * 256;
    let checked = 0;
    for (const [lat, lon] of [
      [46, 10], [46.05, 9.95], [45.93, 10.08], [46.07, 10.1],
      [frame.lat, ((x0 + 0.5) / (256 * 2 ** z)) * 360 - 180], // right at a tile seam
      [frame.lat, ((x0 - 0.5) / (256 * 2 ** z)) * 360 - 180],
      [frame.lat, ((x0 - 0.25) / (256 * 2 ** z)) * 360 - 180],
    ]) {
      const [gy, gx] = mercPixel(lat, lon, z);
      assert.ok(Math.abs(src.sample(lat, lon) - plane(gy, gx)) < 1e-6, `(${lat}, ${lon})`);
      assert.equal(src.isWater(lat, lon), false);
      checked++;
    }
    assert.equal(checked, 7);
    assert.ok(Number.isNaN(src.sample(40, 10)), 'outside the prepared tiles');
    assert.ok(Number.isNaN(src.sample(89, 10)), 'beyond the Mercator limit');
    assert.equal(MERCATOR_MAX_LAT.toFixed(4), '85.0511');

    // repeated preview: tiles come from the cache
    tiles.fetchImpl.urls.length = 0;
    await src.prepare(frame, 120);
    assert.equal(tiles.fetchImpl.urls.length, 0);
  });

  test('sea pixels (<= 0 m) are water at 0 m, unless bathymetry is kept', async () => {
    const frame = { lat: 43.7, lon: 7.3, widthKm: 10, heightKm: 10, rotationDeg: 0 };
    const z = 11;
    const cx = Math.round(mercPixel(frame.lat, frame.lon, z)[1]);
    const coast = (gy, gx) => (gx < cx ? -120 : 300);
    const west = [43.7, 7.26];
    const east = [43.7, 7.34];

    const src = new TerrariumSource({ ...syntheticTiles(coast), cache: new ChunkCache() });
    assert.equal((await src.prepare(frame, 60)).zoom, z);
    assert.equal(src.sample(...west), 0);
    assert.equal(src.isWater(...west), true);
    assert.equal(src.sample(...east), 300);
    assert.equal(src.isWater(...east), false);

    const s = await sampleFrame(src, frame, 51, 51);
    assert.equal(s.missing, 0);
    assert.equal(s.minElev, 0);
    assert.equal(s.water[25 * 51 + 2], 1);
    assert.equal(s.water[25 * 51 + 48], 0);

    const deep = new TerrariumSource({ ...syntheticTiles(coast), cache: new ChunkCache(), keepBathymetry: true });
    await deep.prepare(frame, 60);
    assert.equal(deep.sample(...west), -120);
    assert.equal(deep.isWater(...west), true);
  });

  test('404 tiles are missing; maxTiles lowers the zoom', async () => {
    const frame = { lat: 46, lon: 10, widthKm: 20, heightKm: 20, rotationDeg: 0 };
    const z = 10;
    const [gy, gx] = mercPixel(46, 10, z);
    const tx = Math.floor((gx + 0.5) / 256);
    const ty = Math.floor((gy + 0.5) / 256);
    const tiles = syntheticTiles(() => 500, { missing: new Set([`${z}/${tx}/${ty}`]) });
    const src = new TerrariumSource({ ...tiles, cache: new ChunkCache() });
    const info = await src.prepare(frame, 120);
    assert.equal(info.missingTiles, 1);
    assert.ok(Number.isNaN(src.sample(46, 10)));

    const big = { lat: 46, lon: 10, widthKm: 400, heightKm: 300, rotationDeg: 0 };
    const t2 = syntheticTiles(() => 500);
    const src2 = new TerrariumSource({ ...t2, cache: new ChunkCache() });
    const wanted = src2.chooseZoom(120, 46);
    const info2 = await src2.prepare(big, 120, { maxTiles: 12 });
    assert.ok(info2.zoom < wanted, `zoom ${info2.zoom} < ${wanted}`);
    assert.ok(t2.fetchImpl.urls.length <= 12);
    assert.equal(src2.tileRange(frameBounds(big), info2.zoom).count, t2.fetchImpl.urls.length);
    assert.ok(src2.tileRange(frameBounds(big), info2.zoom + 1).count > 12);
    assert.equal(src2.sample(46, 10), 500);
  });

  test('frames across the antimeridian wrap tile columns', async () => {
    const frame = { lat: -16.5, lon: 179.95, widthKm: 30, heightKm: 20, rotationDeg: 0 };
    const z = 10;
    const n = 2 ** z;
    const tiles = syntheticTiles((gy, gx) => 100 + Math.floor(gx / 256) / 8); // per-tile constant
    const src = new TerrariumSource({ ...tiles, cache: new ChunkCache() });
    const info = await src.prepare(frame, 150);
    assert.equal(info.zoom, z);
    const xs = new Set(tiles.fetchImpl.urls.map((u) => Number(u.split('/').at(-2))));
    assert.ok(xs.has(0) && xs.has(n - 1), `tile columns ${[...xs]}`);
    assert.ok([...xs].every((x) => x >= 0 && x < n));
    assert.equal(src.sample(-16.5, 179.9), 100 + (n - 1) / 8);
    assert.equal(src.sample(-16.5, -179.9), 100);
    assert.equal(src.sample(-16.5, 179.9 - 360), 100 + (n - 1) / 8, 'longitudes are normalised');
    const seam = src.sample(-16.5, 180);
    assert.ok(seam > 100 && seam < 100 + (n - 1) / 8, `seam ${seam}`);
    const s = await sampleFrame(src, frame, 31, 21);
    assert.equal(s.missing, 0);
  });
});

// ------------------------------------------------------------------------------------- factory

describe('createSource', () => {
  const fuji = { id: 'fuji', manifest: 'fuji/manifest.json', bounds: fujiManifest.bounds };

  test('returns one cached instance per region and for live data', async () => {
    sources.clearSources();
    const a = await sources.createSource('local', { region: fuji, dataBaseUrl: DATA_URL, fetchImpl: fileFetch });
    const b = await sources.createSource('local', { region: fuji, dataBaseUrl: DATA_URL.href.slice(0, -1), fetchImpl: fileFetch });
    assert.ok(a instanceof LocalRegionSource);
    assert.equal(a, b);
    assert.equal(a.id, 'fuji');
    assert.equal(a.cache, sharedChunkCache);
    const c = await sources.createSource('local', { region: fuji, dataBaseUrl: DATA_URL, fetchImpl: async (u, i) => fileFetch(u, i) });
    assert.notEqual(c, a, 'a different fetchImpl gets its own instance');

    const live1 = await sources.createSource('live', { fetchImpl: fileFetch });
    const live2 = await sources.createSource('live', { fetchImpl: fileFetch });
    assert.ok(live1 instanceof TerrariumSource);
    assert.equal(live1, live2);
    assert.equal(live1.urlTemplate, 'https://s3.amazonaws.com/elevation-tiles-prod/terrarium/{z}/{x}/{y}.png');
    sources.clearSources();
    assert.notEqual(await sources.createSource('live', { fetchImpl: fileFetch }), live1);
  });

  test('the local source works end to end and keeps decoded chunks across previews', async () => {
    sources.clearSources();
    const f = recordingFetch();
    const src = await sources.createSource('local', { region: fuji, dataBaseUrl: DATA_URL, fetchImpl: f });
    const frame = { lat: 35.62, lon: 138.2, widthKm: 8, heightKm: 6, rotationDeg: 10 };
    await src.prepare(frame, 100);
    const first = f.urls.length;
    const s = await sampleFrame(src, frame, 50, 40);
    assert.equal(s.missing, 0);
    sources.clearSources();
    const again = await sources.createSource('local', { region: fuji, dataBaseUrl: DATA_URL, fetchImpl: f });
    await again.prepare(frame, 100);
    assert.equal(f.urls.length, first + 1, 'only the manifest is fetched again');
  });

  test('rejects bad arguments and does not cache failed loads', async () => {
    assert.throws(() => sources.createSource('cloud', {}), /Unknown/);
    assert.throws(() => sources.createSource('local', { dataBaseUrl: DATA_URL }), /region/);
    const bad = { id: 'ghost', manifest: 'ghost/manifest.json' };
    const p1 = sources.createSource('local', { region: bad, dataBaseUrl: DATA_URL, fetchImpl: fileFetch });
    await assert.rejects(p1, /404/);
    const p2 = sources.createSource('local', { region: bad, dataBaseUrl: DATA_URL, fetchImpl: fileFetch });
    assert.notEqual(p2, p1);
    await assert.rejects(p2, /404/);
  });
});
