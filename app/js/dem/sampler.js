// Elevation sampling: chunk mosaics with bilinear lookup, source selection and frame sampling.
// DOM-free (runs in the engine worker and in Node).

import { EARTH_RADIUS, frameBounds } from '../core/projection.js';

/** @typedef {import('../types.js').Frame} Frame */
/**
 * @typedef {{width:number, height:number, elev:Float32Array, water:Uint8Array|null}} Chunk
 *   decoded chunk: elev in metres (NaN = nodata), water 1 = lake/sea
 */
/**
 * @typedef {object} ElevationSource
 * @property {(frame:Frame, groundSpacingM:number, opts?:object) => Promise<object>} prepare
 * @property {(lat:number, lon:number) => number} sample   bilinear metres, NaN without data
 * @property {(lat:number, lon:number) => boolean} isWater
 */

const D2R = Math.PI / 180;
const R2D = 180 / Math.PI;
const YIELD_MS = 40;

/**
 * Bilinear interpolation of four neighbours that ignores missing (NaN) values and renormalises the
 * remaining weights. a = (y0, x0), b = (y0, x0+1), c = (y0+1, x0), d = (y0+1, x0+1).
 * @returns {number} NaN when every neighbour with a non-zero weight is missing
 */
function blendValid(a, b, c, d, fx, fy) {
  const gx = 1 - fx;
  const gy = 1 - fy;
  let acc = 0;
  let ws = 0;
  if (a === a) { const w = gx * gy; acc += w * a; ws += w; }
  if (b === b) { const w = fx * gy; acc += w * b; ws += w; }
  if (c === c) { const w = gx * fy; acc += w * c; ws += w; }
  if (d === d) { const w = fx * fy; acc += w * d; ws += w; }
  return ws > 0 ? acc / ws : NaN;
}

/**
 * A rectangular window of equally sized chunks of one global pixel grid, with seamless
 * bilinear lookup across chunk boundaries. Global pixel (gy, gx) of chunk (cr, cc) is local
 * pixel (gy - cr*chunkRows, gx - cc*chunkCols). With `wrapCols` (chunks around the globe)
 * chunk columns wrap, so lookups work across the antimeridian.
 */
export class ChunkGrid {
  /**
   * @param {{rowMin:number, rowMax:number, colMin:number, colMax:number,
   *          chunkRows:number, chunkCols:number, wrapCols?:number}} spec inclusive chunk index window
   */
  constructor({ rowMin, rowMax, colMin, colMax, chunkRows, chunkCols, wrapCols = 0 }) {
    this.rowMin = rowMin;
    this.colMin = colMin;
    this.rows = Math.max(0, rowMax - rowMin + 1);
    this.cols = Math.max(0, colMax - colMin + 1);
    if (wrapCols > 0) this.cols = Math.min(this.cols, wrapCols);
    this.chunkRows = chunkRows;
    this.chunkCols = chunkCols;
    this.wrapCols = wrapCols;
    /** @type {Array<Chunk|null>} */
    this.cells = new Array(this.rows * this.cols).fill(null);
  }

  /** @returns {number} cell index or -1 when (cr, cc) is outside the window */
  _index(cr, cc) {
    const r = cr - this.rowMin;
    if (r < 0 || r >= this.rows) return -1;
    let c = cc - this.colMin;
    if (this.wrapCols > 0) c = ((c % this.wrapCols) + this.wrapCols) % this.wrapCols;
    if (c < 0 || c >= this.cols) return -1;
    return r * this.cols + c;
  }

  /**
   * Places a decoded chunk.
   * @param {number} cr chunk row
   * @param {number} cc chunk column
   * @param {Chunk} chunk must be chunkCols × chunkRows pixels
   */
  set(cr, cc, chunk) {
    const i = this._index(cr, cc);
    if (i < 0) throw new RangeError(`chunk ${cr}_${cc} is outside the grid window`);
    if (chunk.width !== this.chunkCols || chunk.height !== this.chunkRows) {
      throw new Error(`chunk ${cr}_${cc} is ${chunk.width}×${chunk.height}, expected ${this.chunkCols}×${this.chunkRows}`);
    }
    this.cells[i] = chunk;
  }

  /** @returns {Chunk|null} */
  get(cr, cc) {
    const i = this._index(cr, cc);
    return i < 0 ? null : this.cells[i];
  }

  /**
   * Elevation of one integer global pixel.
   * @returns {number} NaN when the chunk is not loaded or the pixel is nodata
   */
  pixel(gy, gx) {
    const cr = Math.floor(gy / this.chunkRows);
    const cc = Math.floor(gx / this.chunkCols);
    const ch = this.get(cr, cc);
    if (ch === null) return NaN;
    return ch.elev[(gy - cr * this.chunkRows) * this.chunkCols + (gx - cc * this.chunkCols)];
  }

  /**
   * Bilinear elevation at fractional global pixel coordinates; missing neighbours are skipped.
   * @param {number} gy
   * @param {number} gx
   * @returns {number} metres or NaN
   */
  value(gy, gx) {
    const y0 = Math.floor(gy);
    const x0 = Math.floor(gx);
    const fy = gy - y0;
    const fx = gx - x0;
    const CR = this.chunkRows;
    const CC = this.chunkCols;
    const cr = Math.floor(y0 / CR);
    const cc = Math.floor(x0 / CC);
    const ly = y0 - cr * CR;
    const lx = x0 - cc * CC;
    if (ly < CR - 1 && lx < CC - 1) {
      // all four neighbours inside one chunk (the common case)
      const ch = this.get(cr, cc);
      if (ch === null) return NaN;
      const e = ch.elev;
      const i = ly * CC + lx;
      const a = e[i];
      const b = e[i + 1];
      const c = e[i + CC];
      const d = e[i + CC + 1];
      if (a === a && b === b && c === c && d === d) {
        const top = a + (b - a) * fx;
        const bottom = c + (d - c) * fx;
        return top + (bottom - top) * fy;
      }
      return blendValid(a, b, c, d, fx, fy);
    }
    return blendValid(
      this.pixel(y0, x0), this.pixel(y0, x0 + 1), this.pixel(y0 + 1, x0), this.pixel(y0 + 1, x0 + 1), fx, fy);
  }

  /**
   * Water flag of the nearest pixel.
   * @returns {number} 1 water, 0 land, -1 no data at the nearest pixel
   */
  water(gy, gx) {
    const y = Math.round(gy);
    const x = Math.round(gx);
    const cr = Math.floor(y / this.chunkRows);
    const cc = Math.floor(x / this.chunkCols);
    const ch = this.get(cr, cc);
    if (ch === null) return -1;
    const i = (y - cr * this.chunkRows) * this.chunkCols + (x - cc * this.chunkCols);
    const e = ch.elev[i];
    if (e !== e) return -1;
    return ch.water ? ch.water[i] : 0;
  }
}

/**
 * Finds a region entry in a regions index.
 * @param {{regions?:object[]}|object[]|null|undefined} regionsIndex data/regions.json (or its regions array)
 * @param {string} regionId
 * @returns {object|null}
 */
export function findRegion(regionsIndex, regionId) {
  const regions = Array.isArray(regionsIndex) ? regionsIndex : regionsIndex?.regions ?? [];
  return regions.find((r) => r.id === regionId) ?? null;
}

/**
 * True when the whole frame (its lat/lon bounding box) lies inside `bounds`.
 * @param {Frame} frame
 * @param {{south:number, west:number, north:number, east:number}} bounds
 */
export function frameInsideBounds(frame, bounds) {
  const b = frameBounds(frame);
  const eps = 1e-9;
  return b.south >= bounds.south - eps && b.north <= bounds.north + eps
    && b.west >= bounds.west - eps && b.east <= bounds.east + eps;
}

/**
 * Picks the elevation source for a project.
 * 'live' → 'live'; 'local' → 'local' when project.regionId is a stored region (else 'live');
 * 'auto' → 'local' when the frame lies entirely inside that region's bounds, otherwise 'live'.
 * @param {{source?:string, regionId?:string, frame:Frame}} project
 * @param {{regions?:object[]}} regionsIndex
 * @returns {'local'|'live'}
 */
export function chooseSource(project, regionsIndex) {
  const mode = project?.source ?? 'auto';
  if (mode === 'live') return 'live';
  const region = findRegion(regionsIndex, project?.regionId);
  if (!region) return 'live';
  if (mode === 'local') return 'local';
  return frameInsideBounds(project.frame, region.bounds) ? 'local' : 'live';
}

/** Lets the event loop run (so a worker can receive 'cancel') without measurable cost. */
function yieldToEventLoop() {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

/**
 * Samples a prepared source on a regular nx × ny grid over the frame. Sample (r, c) is taken at
 * frameUVToLatLon(frame, c/(nx-1), r/(ny-1)); row 0 is the top edge of the frame.
 *
 * The inverse projection is factored into per-row and per-column terms
 * (angle-addition for sin/cos D, exp(a+b) = exp(a)·exp(b) for x/R), leaving one asin and one
 * atan2 per sample.
 * @param {ElevationSource} source a source whose prepare() covered this frame
 * @param {Frame} frame
 * @param {number} nx columns (>= 2)
 * @param {number} ny rows (>= 2)
 * @param {{onProgress?:(p:{loaded:number,total:number,fraction:number})=>void, signal?:AbortSignal}} [opts]
 *   progress reports rows done
 * @returns {Promise<{elev:Float32Array, water:Uint8Array, missing:number, minElev:number, maxElev:number}>}
 *   elev in metres with missing samples filled with 0 (and counted in `missing`);
 *   minElev/maxElev over valid samples (0 when there are none)
 */
export async function sampleFrame(source, frame, nx, ny, { onProgress, signal } = {}) {
  nx = Math.floor(nx);
  ny = Math.floor(ny);
  if (!(nx >= 2 && ny >= 2)) throw new RangeError(`sampleFrame needs nx, ny >= 2 (got ${nx} × ${ny})`);
  signal?.throwIfAborted();

  const R = EARTH_RADIUS;
  const t = (frame.rotationDeg || 0) * D2R;
  const cosT = Math.cos(t);
  const sinT = Math.sin(t);
  const lat0 = frame.lat * D2R;
  const lon0 = frame.lon;
  const W = frame.widthKm * 1000;
  const H = frame.heightKm * 1000;

  // Column terms: k = x/R = kc + kr, D = y/R + φ0 = dc + dr
  const expKc = new Float64Array(nx);
  const sinDc = new Float64Array(nx);
  const cosDc = new Float64Array(nx);
  for (let c = 0; c < nx; c++) {
    const xm = (c / (nx - 1) - 0.5) * W;
    expKc[c] = Math.exp((xm * cosT) / R);
    const dc = (-xm * sinT) / R;
    sinDc[c] = Math.sin(dc);
    cosDc[c] = Math.cos(dc);
  }

  const n = nx * ny;
  const elev = new Float32Array(n);
  const water = new Uint8Array(n);
  let missing = 0;
  let minElev = Infinity;
  let maxElev = -Infinity;
  let lastYield = performance.now();

  for (let r = 0; r < ny; r++) {
    const ym = (0.5 - r / (ny - 1)) * H;
    const expKr = Math.exp((ym * sinT) / R);
    const dr = (ym * cosT) / R + lat0;
    const sinDr = Math.sin(dr);
    const cosDr = Math.cos(dr);
    const row = r * nx;
    for (let c = 0; c < nx; c++) {
      const ek = expKc[c] * expKr;
      const iek = 1 / ek;
      const coshK = 0.5 * (ek + iek);
      const sinhK = 0.5 * (ek - iek);
      const sinD = sinDc[c] * cosDr + cosDc[c] * sinDr;
      const cosD = cosDc[c] * cosDr - sinDc[c] * sinDr;
      const q = sinD / coshK;
      const lat = Math.asin(q > 1 ? 1 : q < -1 ? -1 : q) * R2D;
      const lon = lon0 + Math.atan2(sinhK, cosD) * R2D;
      const e = source.sample(lat, lon);
      const i = row + c;
      if (e === e) {
        elev[i] = e;
        if (e < minElev) minElev = e;
        if (e > maxElev) maxElev = e;
      } else {
        missing++;
      }
      if (source.isWater(lat, lon)) water[i] = 1;
    }
    if (performance.now() - lastYield > YIELD_MS) {
      onProgress?.({ loaded: r + 1, total: ny, fraction: (r + 1) / ny });
      await yieldToEventLoop();
      signal?.throwIfAborted();
      lastYield = performance.now();
    }
  }
  onProgress?.({ loaded: ny, total: ny, fraction: 1 });
  if (missing === n) {
    minElev = 0;
    maxElev = 0;
  }
  return { elev, water, missing, minElev, maxElev };
}
