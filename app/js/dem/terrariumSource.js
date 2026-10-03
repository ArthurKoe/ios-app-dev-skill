// Live elevation anywhere on Earth from AWS Terrain Tiles (Terrarium-encoded PNG, Web Mercator).
// DOM-free: the default PNG decoder uses createImageBitmap + OffscreenCanvas (available in
// browsers and workers); Node tests inject `decodePng`.

import { EARTH_RADIUS, frameBounds, normalizeLon } from '../core/projection.js';
import { fetchBody, retryOnce, runPool, sharedChunkCache } from './cache.js';
import { ChunkGrid } from './sampler.js';

/** @typedef {import('../types.js').Frame} Frame */
/** @typedef {import('./cache.js').ChunkCache} ChunkCache */
/** @typedef {(blob:Blob) => Promise<{width:number, height:number, data:Uint8ClampedArray|Uint8Array}>} PngDecoder */

export const TERRARIUM_URL = 'https://s3.amazonaws.com/elevation-tiles-prod/terrarium/{z}/{x}/{y}.png';
/** Latitude limit of the Web Mercator tile pyramid. */
export const MERCATOR_MAX_LAT = 85.0511287798066;

const D2R = Math.PI / 180;
const CONCURRENCY = 6;
const MARGIN_PX = 2;

/**
 * Decodes a PNG without colour management or premultiplication (exact RGB values).
 * @type {PngDecoder}
 */
export async function decodePngWithCanvas(blob) {
  if (typeof createImageBitmap !== 'function' || typeof OffscreenCanvas !== 'function') {
    throw new Error('PNG decoding needs createImageBitmap and OffscreenCanvas (pass decodePng instead)');
  }
  const bitmap = await createImageBitmap(blob, { premultiplyAlpha: 'none', colorSpaceConversion: 'none' });
  try {
    const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    ctx.drawImage(bitmap, 0, 0);
    const img = ctx.getImageData(0, 0, bitmap.width, bitmap.height);
    return { width: img.width, height: img.height, data: img.data };
  } finally {
    bitmap.close();
  }
}

/**
 * Converts Terrarium RGBA pixels to elevations: e = R*256 + G + B/256 - 32768.
 * Pixels with e <= 0 are flagged as water; unless `keepBathymetry`, they are reported at 0 m
 * (sea level, like the Copernicus data of the stored regions) instead of the ocean floor.
 * @param {{width:number, height:number, data:Uint8ClampedArray|Uint8Array}} img
 * @param {boolean} [keepBathymetry=false]
 * @returns {{width:number, height:number, elev:Float32Array, water:Uint8Array}}
 */
export function terrariumToElevation(img, keepBathymetry = false) {
  const { width, height, data } = img;
  const n = width * height;
  const elev = new Float32Array(n);
  const water = new Uint8Array(n);
  for (let i = 0, p = 0; i < n; i++, p += 4) {
    const e = data[p] * 256 + data[p + 1] + data[p + 2] / 256 - 32768;
    if (e <= 0) {
      water[i] = 1;
      elev[i] = keepBathymetry ? e : 0;
    } else {
      elev[i] = e;
    }
  }
  return { width, height, elev, water };
}

/** Web Mercator y in 0 (north edge) … 1 (south edge). */
function mercatorY(lat) {
  const phi = Math.max(-MERCATOR_MAX_LAT, Math.min(MERCATOR_MAX_LAT, lat)) * D2R;
  return 0.5 - Math.log(Math.tan(Math.PI / 4 + phi / 2)) / (2 * Math.PI);
}

/**
 * Elevation from AWS Terrain Tiles. Tiles are 256 px, pixel-is-area (pixel centres at +0.5).
 * Call {@link TerrariumSource#prepare} for a frame before sampling it.
 */
export class TerrariumSource {
  /**
   * @param {{urlTemplate?:string, maxZoom?:number, fetchImpl?:typeof fetch, decodePng?:PngDecoder,
   *          cache?:ChunkCache, tileSize?:number, keepBathymetry?:boolean}} [opts]
   *   cache defaults to the shared LRU cache; keepBathymetry=false reports the sea at 0 m
   */
  constructor({ urlTemplate = TERRARIUM_URL, maxZoom = 15, fetchImpl, decodePng, cache, tileSize = 256,
    keepBathymetry = false } = {}) {
    this.id = 'live';
    this.bounds = { south: -MERCATOR_MAX_LAT, west: -180, north: MERCATOR_MAX_LAT, east: 180 };
    this.urlTemplate = urlTemplate;
    this.maxZoom = maxZoom;
    this.fetchImpl = fetchImpl ?? ((input, init) => globalThis.fetch(input, init));
    this.decodePng = decodePng ?? decodePngWithCanvas;
    this.cache = cache ?? sharedChunkCache;
    this.tileSize = tileSize;
    this.keepBathymetry = keepBathymetry;
    /** @type {ChunkGrid|null} */
    this._grid = null;
    this._worldPx = 0;
  }

  /**
   * Ground size of one tile pixel at a zoom level and latitude.
   * @param {number} z
   * @param {number} lat
   * @returns {number} metres
   */
  pixelSizeM(z, lat) {
    return (2 * Math.PI * EARTH_RADIUS * Math.cos(lat * D2R)) / (this.tileSize * 2 ** z);
  }

  /**
   * Coarsest zoom whose ground pixel size is <= groundSpacingM, clamped to [1, maxZoom].
   * @param {number} groundSpacingM
   * @param {number} lat
   * @returns {number}
   */
  chooseZoom(groundSpacingM, lat) {
    if (!(groundSpacingM > 0)) return this.maxZoom;
    const z = Math.ceil(Math.log2(this.pixelSizeM(0, lat) / groundSpacingM) - 1e-9);
    return Math.min(this.maxZoom, Math.max(1, z));
  }

  /**
   * Tile index window covering the bounds (+ margin) at zoom z. Columns are unwrapped (may be
   * negative or >= 2^z across the antimeridian) and limited to one turn around the globe.
   * @returns {{rowMin:number, rowMax:number, colMin:number, colMax:number, count:number}}
   */
  tileRange(bounds, z) {
    const n = 2 ** z;
    const size = this.tileSize;
    const world = size * n;
    const x0 = ((bounds.west + 180) / 360) * world - 0.5 - MARGIN_PX;
    const x1 = ((bounds.east + 180) / 360) * world - 0.5 + MARGIN_PX;
    const y0 = mercatorY(bounds.north) * world - 0.5 - MARGIN_PX;
    const y1 = mercatorY(bounds.south) * world - 0.5 + MARGIN_PX;
    const rowMin = Math.max(0, Math.floor(y0 / size));
    const rowMax = Math.min(n - 1, Math.floor(y1 / size));
    let colMin = Math.floor(x0 / size);
    let colMax = Math.floor(x1 / size);
    if (colMax - colMin + 1 > n) {
      colMin = 0;
      colMax = n - 1;
    }
    return { rowMin, rowMax, colMin, colMax, count: (rowMax - rowMin + 1) * (colMax - colMin + 1) };
  }

  /**
   * Fetches every tile needed to sample the frame (6 in parallel, one retry, 404 = missing tile).
   * The zoom is lowered while more than maxTiles tiles would be needed.
   * @param {Frame} frame
   * @param {number} groundSpacingM
   * @param {{onProgress?:(p:{loaded:number,total:number,bytes:number,fraction:number})=>void,
   *          signal?:AbortSignal, maxTiles?:number}} [opts]
   * @returns {Promise<{level:number, zoom:number, pixelSizeM:number, chunks:number, missingTiles:number,
   *   bytes:number, label:string}>}
   */
  async prepare(frame, groundSpacingM, { onProgress, signal, maxTiles = 400 } = {}) {
    signal?.throwIfAborted();
    const bounds = frameBounds(frame);
    let z = this.chooseZoom(groundSpacingM, frame.lat);
    let range = this.tileRange(bounds, z);
    while (range.count > maxTiles && z > 1) {
      z--;
      range = this.tileRange(bounds, z);
    }
    const n = 2 ** z;
    const tasks = [];
    for (let ty = range.rowMin; ty <= range.rowMax; ty++) {
      for (let tx = range.colMin; tx <= range.colMax; tx++) {
        const x = ((tx % n) + n) % n;
        const url = this.urlTemplate.replace('{z}', String(z)).replace('{x}', String(x)).replace('{y}', String(ty));
        tasks.push({ ty, tx, url });
      }
    }
    const records = new Array(tasks.length).fill(null);
    let loaded = 0;
    let bytes = 0;
    const total = tasks.length;
    onProgress?.({ loaded, total, bytes, fraction: total ? 0 : 1 });
    await runPool(tasks, CONCURRENCY, async (task, i) => {
      const rec = await retryOnce(() => this.cache.load(task.url, () => this._fetchTile(task.url, signal)), signal);
      records[i] = rec;
      loaded++;
      bytes += rec?.fileBytes ?? 0;
      onProgress?.({ loaded, total, bytes, fraction: loaded / total });
    }, signal);
    signal?.throwIfAborted();

    const grid = new ChunkGrid({ ...range, chunkRows: this.tileSize, chunkCols: this.tileSize, wrapCols: n });
    let chunks = 0;
    tasks.forEach((task, i) => {
      if (records[i] === null) return;
      grid.set(task.ty, task.tx, records[i]);
      chunks++;
    });
    this._grid = grid;
    this._worldPx = this.tileSize * n;

    const pixelSizeM = this.pixelSizeM(z, frame.lat);
    return {
      level: z,
      zoom: z,
      pixelSizeM,
      chunks,
      missingTiles: total - chunks,
      bytes,
      label: `AWS Terrain Tiles z${z} · ${Math.round(pixelSizeM)} m`,
    };
  }

  /**
   * Downloads and decodes one tile.
   * @returns {Promise<object|null>} decoded tile + fileBytes, or null when the tile does not exist
   */
  async _fetchTile(url, signal) {
    const blob = await fetchBody(this.fetchImpl, url, signal, 'blob');
    if (blob === null) return null;
    const img = await this.decodePng(blob);
    return { ...terrariumToElevation(img, this.keepBathymetry), fileBytes: blob.size };
  }

  /**
   * Bilinear elevation in metres from the prepared tiles.
   * @param {number} lat
   * @param {number} lon
   * @returns {number} NaN outside the prepared tiles or beyond the Mercator latitude limit
   */
  sample(lat, lon) {
    if (this._grid === null || !(Math.abs(lat) <= MERCATOR_MAX_LAT)) return NaN;
    const w = this._worldPx;
    return this._grid.value(mercatorY(lat) * w - 0.5, ((normalizeLon(lon) + 180) / 360) * w - 0.5);
  }

  /**
   * True when the nearest tile pixel is at or below sea level (Terrarium has no lake mask).
   * @param {number} lat
   * @param {number} lon
   * @returns {boolean}
   */
  isWater(lat, lon) {
    if (this._grid === null || !(Math.abs(lat) <= MERCATOR_MAX_LAT)) return false;
    const w = this._worldPx;
    return this._grid.water(mercatorY(lat) * w - 0.5, ((normalizeLon(lon) + 180) / 360) * w - 0.5) === 1;
  }
}
