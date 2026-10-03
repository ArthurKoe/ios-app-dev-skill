// Elevation source for a stored region (data/<region>/manifest.json + RDEM chunks).
// DOM-free; see docs/DATA_FORMAT.md for the grid geometry and level semantics.

import { decodeRDEM } from '../core/rdem.js';
import { frameBounds, normalizeLon } from '../core/projection.js';
import { fetchBody, retryOnce, runPool, sharedChunkCache } from './cache.js';
import { ChunkGrid } from './sampler.js';

/** @typedef {import('../types.js').Frame} Frame */
/** @typedef {import('./cache.js').ChunkCache} ChunkCache */

/** Extra pixels loaded around the frame bounds so bilinear lookups at the edges have neighbours. */
const MARGIN_PX = 2;
/** Parallel chunk downloads. */
const CONCURRENCY = 6;
/** Decoded bytes per pixel: Float32 elevation + Uint8 water flag. */
const DECODED_BYTES_PER_PX = 5;

/**
 * Resolves a URL against the page/worker location (absolute URLs pass through unchanged).
 * @param {string|URL} url
 * @returns {string}
 */
function resolveUrl(url) {
  try {
    return new URL(String(url), globalThis.location?.href).href;
  } catch {
    throw new TypeError(`Cannot resolve URL "${url}" (pass an absolute URL outside the browser)`);
  }
}

/** @returns {(input:string, init?:object) => Promise<Response>} */
function defaultFetch() {
  return (input, init) => globalThis.fetch(input, init);
}

/**
 * Elevation data of one stored region, sampled bilinearly from RDEM chunks.
 * Call {@link LocalRegionSource#prepare} for a frame before sampling it.
 */
export class LocalRegionSource {
  /**
   * Loads a region manifest; chunk URLs resolve relative to the manifest URL.
   * @param {string|URL} manifestUrl
   * @param {{fetchImpl?:typeof fetch, cache?:ChunkCache}} [opts]
   * @returns {Promise<LocalRegionSource>}
   */
  static async load(manifestUrl, { fetchImpl, cache } = {}) {
    const url = resolveUrl(manifestUrl);
    const f = fetchImpl ?? defaultFetch();
    const res = await f(url);
    if (!res.ok) throw new Error(`Could not load region manifest ${url} (HTTP ${res.status})`);
    return new LocalRegionSource(await res.json(), url, { fetchImpl: f, cache });
  }

  /**
   * @param {object} manifest parsed manifest.json
   * @param {string|URL} baseUrl URL the chunk paths (L<level>/<cr>_<cc>.rdem) resolve against,
   *   normally the manifest URL itself
   * @param {{fetchImpl?:typeof fetch, cache?:ChunkCache}} [opts] cache defaults to the shared LRU cache
   */
  constructor(manifest, baseUrl, { fetchImpl, cache } = {}) {
    this.manifest = manifest;
    this.id = manifest.id;
    this.bounds = manifest.bounds;
    this.baseUrl = resolveUrl(baseUrl);
    this.fetchImpl = fetchImpl ?? defaultFetch();
    this.cache = cache ?? sharedChunkCache;
    /** Existing chunk keys per level index. */
    this._chunkSets = manifest.levels.map((l) => new Set(l.chunks.map(([cr, cc]) => `${cr}_${cc}`)));
    /** @type {Array<{grid:ChunkGrid, ppdLat:number, ppdLon:number}>} active levels, finest first */
    this._views = [];
  }

  /**
   * Index into manifest.levels for a ground sample spacing: the coarsest level whose
   * pixelSizeM <= groundSpacingM, or the finest level when none is fine enough.
   * @param {number} groundSpacingM
   * @returns {number}
   */
  chooseLevel(groundSpacingM) {
    const levels = this.manifest.levels;
    for (let i = levels.length - 1; i >= 0; i--) {
      if (levels[i].pixelSizeM <= groundSpacingM) return i;
    }
    return 0;
  }

  /**
   * Index of the next coarser complete level after `index`, or -1.
   * @param {number} index
   * @returns {number}
   */
  fallbackLevel(index) {
    const levels = this.manifest.levels;
    for (let j = index + 1; j < levels.length; j++) if (levels[j].complete !== false) return j;
    return -1;
  }

  /**
   * Existing chunks of a level that intersect the bounds (+ MARGIN_PX pixels).
   * @param {number} index level index
   * @param {{south:number, west:number, north:number, east:number}} b
   * @returns {{chunks:Array<[number, number]>, window:{rowMin:number,rowMax:number,colMin:number,colMax:number}}}
   */
  chunksFor(index, b) {
    const L = this.manifest.levels[index];
    const r0 = Math.floor(((90 - b.north) * L.ppdLat - MARGIN_PX) / L.chunkRows);
    const r1 = Math.floor(((90 - b.south) * L.ppdLat + MARGIN_PX) / L.chunkRows);
    const c0 = Math.floor(((b.west + 180) * L.ppdLon - MARGIN_PX) / L.chunkCols);
    const c1 = Math.floor(((b.east + 180) * L.ppdLon + MARGIN_PX) / L.chunkCols);
    const chunks = L.chunks.filter(([cr, cc]) => cr >= r0 && cr <= r1 && cc >= c0 && cc <= c1);
    if (chunks.length === 0) return { chunks, window: { rowMin: 0, rowMax: -1, colMin: 0, colMax: -1 } };
    const rows = chunks.map((c) => c[0]);
    const cols = chunks.map((c) => c[1]);
    return {
      chunks,
      window: { rowMin: Math.min(...rows), rowMax: Math.max(...rows), colMin: Math.min(...cols), colMax: Math.max(...cols) },
    };
  }

  /**
   * Picks the level(s) to load for a frame: the chosen level plus its complete fallback.
   * A partial level without chunks in the frame is skipped; a level is replaced by the next
   * coarser one while the estimated download (level.bytes / chunk count × chunks needed) exceeds
   * maxBytes or the decoded size of the chunks exceeds maxDecodedBytes.
   * @returns {{indices:number[], parts:Array<ReturnType<LocalRegionSource['chunksFor']>>, estBytes:number}}
   */
  _plan(bounds, groundSpacingM, maxBytes, maxDecodedBytes) {
    const levels = this.manifest.levels;
    let index = this.chooseLevel(groundSpacingM);
    for (;;) {
      const fb = this.fallbackLevel(index);
      const primary = this.chunksFor(index, bounds);
      if (primary.chunks.length === 0 && fb >= 0) {
        index = fb;
        continue;
      }
      const indices = [index];
      const parts = [primary];
      if (fb >= 0) {
        indices.push(fb);
        parts.push(this.chunksFor(fb, bounds));
      }
      let estBytes = 0;
      let decodedBytes = 0;
      indices.forEach((li, k) => {
        const L = levels[li];
        const n = parts[k].chunks.length;
        if (L.chunks.length) estBytes += (L.bytes / L.chunks.length) * n;
        decodedBytes += n * L.chunkRows * L.chunkCols * DECODED_BYTES_PER_PX;
      });
      if ((estBytes > maxBytes || decodedBytes > maxDecodedBytes) && index < levels.length - 1) {
        index++;
        continue;
      }
      return { indices, parts, estBytes };
    }
  }

  /**
   * Loads every chunk needed to sample the frame: the chunks intersecting frameBounds(frame)
   * (+2 px margin) at the chosen level and at the next coarser complete level (fallback for
   * partial levels and nodata). Downloads 6 at a time, retries once, decoded chunks go through the
   * LRU cache keyed by URL. Missing chunk files (404) are skipped.
   * @param {Frame} frame
   * @param {number} groundSpacingM intended sample spacing on the ground (metres)
   * @param {{onProgress?:(p:{loaded:number,total:number,bytes:number,fraction:number})=>void,
   *          signal?:AbortSignal, maxBytes?:number, maxDecodedBytes?:number}} [opts]
   *   progress bytes = file bytes of the chunks loaded so far; maxBytes limits the estimated
   *   download, maxDecodedBytes (default 1 GB) the memory of the decoded chunks
   * @returns {Promise<{level:number, levelIndex:number, fallbackLevel:number|null, pixelSizeM:number,
   *   chunks:number, bytes:number, estimatedBytes:number, source:string, label:string}>}
   */
  async prepare(frame, groundSpacingM, { onProgress, signal, maxBytes = 300e6, maxDecodedBytes = 1e9 } = {}) {
    signal?.throwIfAborted();
    const levels = this.manifest.levels;
    const { indices, parts, estBytes } = this._plan(frameBounds(frame), groundSpacingM, maxBytes, maxDecodedBytes);

    const tasks = [];
    indices.forEach((li, k) => {
      const L = levels[li];
      for (const [cr, cc] of parts[k].chunks) {
        tasks.push({ k, cr, cc, url: new URL(`L${L.level}/${cr}_${cc}.rdem`, this.baseUrl).href });
      }
    });
    const records = new Array(tasks.length).fill(null);
    let loaded = 0;
    let bytes = 0;
    const total = tasks.length;
    onProgress?.({ loaded, total, bytes, fraction: total ? 0 : 1 });
    await runPool(tasks, CONCURRENCY, async (task, i) => {
      const rec = await retryOnce(() => this.cache.load(task.url, () => this._fetchChunk(task.url, signal)), signal);
      records[i] = rec;
      loaded++;
      bytes += rec?.fileBytes ?? 0;
      onProgress?.({ loaded, total, bytes, fraction: loaded / total });
    }, signal);
    signal?.throwIfAborted();

    const views = indices.map((li, k) => {
      const L = levels[li];
      return {
        grid: new ChunkGrid({ ...parts[k].window, chunkRows: L.chunkRows, chunkCols: L.chunkCols }),
        ppdLat: L.ppdLat,
        ppdLon: L.ppdLon,
      };
    });
    let chunks = 0;
    tasks.forEach((task, i) => {
      if (records[i] === null) return;
      views[task.k].grid.set(task.cr, task.cc, records[i]);
      chunks++;
    });
    this._views = views;

    const L = levels[indices[0]];
    const fb = indices.length > 1 ? levels[indices[1]].level : null;
    return {
      level: L.level,
      levelIndex: indices[0],
      fallbackLevel: fb,
      pixelSizeM: L.pixelSizeM,
      chunks,
      bytes,
      estimatedBytes: Math.round(estBytes),
      source: L.source,
      label: `${L.source} · ${Math.round(L.pixelSizeM)} m (L${L.level}${L.complete === false ? ` + L${fb} fallback` : ''})`,
    };
  }

  /**
   * Downloads and decodes one chunk.
   * @returns {Promise<object|null>} decoded chunk + fileBytes, or null when the file is missing
   */
  async _fetchChunk(url, signal) {
    const buf = await fetchBody(this.fetchImpl, url, signal);
    if (buf === null) return null;
    const chunk = await decodeRDEM(buf);
    return { ...chunk, fileBytes: buf.byteLength };
  }

  /**
   * Bilinear elevation in metres at (lat, lon) from the prepared levels: the chosen level first,
   * the coarser fallback where it has no data.
   * @param {number} lat
   * @param {number} lon
   * @returns {number} NaN when no prepared level has data there
   */
  sample(lat, lon) {
    const y = 90 - lat;
    const x = normalizeLon(lon) + 180;
    const views = this._views;
    for (let k = 0; k < views.length; k++) {
      const v = views[k];
      const e = v.grid.value(y * v.ppdLat, x * v.ppdLon);
      if (e === e) return e;
    }
    return NaN;
  }

  /**
   * Water flag (lake or sea) of the nearest pixel of the finest prepared level with data there.
   * @param {number} lat
   * @param {number} lon
   * @returns {boolean}
   */
  isWater(lat, lon) {
    const y = 90 - lat;
    const x = normalizeLon(lon) + 180;
    const views = this._views;
    for (let k = 0; k < views.length; k++) {
      const v = views[k];
      const w = v.grid.water(y * v.ppdLat, x * v.ppdLon);
      if (w >= 0) return w === 1;
    }
    return false;
  }
}
