// Project model: the single JSON-serialisable source of truth (see docs/ARCHITECTURE.md).
// DOM-free.

import { frameBounds } from '../core/projection.js';

/** Default project. Values are binding (docs/ARCHITECTURE.md). */
export const DEFAULT_PROJECT = {
  version: 1,
  name: 'The Alps',
  regionId: 'alps',
  source: 'auto',
  frame: { lat: 45.95, lon: 10.75, widthKm: 900, heightKm: 450, rotationDeg: 0 },
  printer: { presetId: 'bambu-x1', bedW: 256, bedH: 256, maxZ: 250, nozzleMm: 0.4 },
  layout: { cols: 4, rows: 2, tileW: 246, tileH: 246 },
  relief: {
    exaggeration: 4, autoExaggeration: false, targetReliefMm: 25,
    baseMm: 3,
    floor: { mode: 'auto', elevationM: 0 },
    smoothingMm: 0.4,
    resolutionMm: 0.4,
    simplifyMm: 0.02,
    water: { mode: 'recess', depthMm: 0.6 },
    maxHeightMm: 0,
  },
  style: { id: 'classic', params: {} },
  border: { enabled: false, widthMm: 6, heightMm: 2 },
  colors: {
    mode: 'bands',
    themeId: 'alpine-classic',
    autoFit: true,
    bands: [
      { filamentId: 'pla-forest-green', fromM: null },
      { filamentId: 'pla-olive', fromM: 900 },
      { filamentId: 'pla-stone-grey', fromM: 1800 },
      { filamentId: 'pla-snow-white', fromM: 2700 },
    ],
    singleFilamentId: 'pla-snow-white',
    layerHeightMm: 0.2, firstLayerMm: 0.2,
  },
  filaments: { owned: [], custom: [] },
  back: {
    labels: true, labelDepthMm: 0.6,
    magnets: { enabled: false, diameterMm: 10.2, depthMm: 3.2, perTile: 4, insetMm: 25 },
  },
  print: { material: 'PLA', infillPct: 15, walls: 3, topLayers: 5, bottomLayers: 4,
           speedClass: 'standard' },
  view: { lighting: 'gallery', wallColor: '#ece8e1', wallMode: true, exploded: false,
          seams: true, layerLines: true, labels: true, highlightWater: false },
};

/** Top-level keys whose change requires re-sampling / re-meshing the terrain. */
export const TERRAIN_KEYS = Object.freeze(['regionId', 'source', 'frame', 'printer', 'layout', 'relief', 'style', 'border']);
/** Top-level keys that only change colours, estimates or material settings. */
export const APPEARANCE_KEYS = Object.freeze(['colors', 'print', 'filaments']);

/**
 * Fresh, mutable deep copy of the default project.
 * @returns {typeof DEFAULT_PROJECT}
 */
export function createDefaultProject() {
  return structuredClone(DEFAULT_PROJECT);
}

/**
 * Classifies what changed between two projects so the app only redoes the necessary work.
 * @param {object|null} prev
 * @param {object} next
 * @returns {{any:boolean, terrain:boolean, appearance:boolean, view:boolean, back:boolean, name:boolean,
 *            keys:string[]}} keys = changed top-level keys
 */
export function classifyChange(prev, next) {
  const keys = [];
  for (const key of Object.keys(next)) {
    if (!prev || !sameValue(prev[key], next[key])) keys.push(key);
  }
  const has = (list) => keys.some((k) => list.includes(k));
  return {
    any: keys.length > 0,
    terrain: has(TERRAIN_KEYS),
    appearance: has(APPEARANCE_KEYS),
    view: keys.includes('view'),
    back: keys.includes('back'),
    name: keys.includes('name'),
    keys,
  };
}

/**
 * Structural equality for JSON-like values (objects, arrays, primitives).
 * @param {*} a
 * @param {*} b
 * @returns {boolean}
 */
export function sameValue(a, b) {
  if (a === b) return true;
  if (typeof a !== 'object' || typeof b !== 'object' || a === null || b === null) {
    return Number.isNaN(a) && Number.isNaN(b);
  }
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  if (Array.isArray(a)) {
    if (a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) if (!sameValue(a[i], b[i])) return false;
    return true;
  }
  const ka = Object.keys(a);
  if (ka.length !== Object.keys(b).length) return false;
  for (const k of ka) if (!Object.hasOwn(b, k) || !sameValue(a[k], b[k])) return false;
  return true;
}

/**
 * Artwork aspect ratio (height / width) of a layout.
 * @param {{cols:number, rows:number, tileW:number, tileH:number}} layout
 * @returns {number}
 */
export function artworkAspect(layout) {
  return (layout.rows * layout.tileH) / (layout.cols * layout.tileW);
}

/**
 * Artwork size in mm.
 * @param {{cols:number, rows:number, tileW:number, tileH:number}} layout
 * @returns {{artW:number, artH:number}}
 */
export function artworkSize(layout) {
  return { artW: layout.cols * layout.tileW, artH: layout.rows * layout.tileH };
}

/**
 * Smallest frame with the given aspect (height/width) that contains a rectangle of
 * `widthKm × heightKm` centred at (lat, lon).
 * @param {{lat:number, lon:number, widthKm:number, heightKm:number}} rect
 * @param {number} aspect artwork height / width
 * @param {number} [rotationDeg=0]
 * @returns {import('../types.js').Frame}
 */
export function frameContainingRect(rect, aspect, rotationDeg = 0) {
  const widthKm = Math.max(rect.widthKm, rect.heightKm / aspect);
  return { lat: rect.lat, lon: rect.lon, widthKm, heightKm: widthKm * aspect, rotationDeg };
}

const KM_PER_DEG_LAT = 110.574;
const KM_PER_DEG_LON_EQ = 111.32;
/** Inward margin (degrees) so a nudged frame counts as inside the bounds. */
const INSIDE_MARGIN_DEG = 1e-4;

/**
 * Shifts a frame (same size and rotation) towards the inside of `bounds` – e.g. so a preset
 * widened to the artwork aspect still uses a region's stored data – but never so far that
 * the `keep` rectangle (centred at keep.lat/keep.lon) would leave the frame. Frames larger
 * than the bounds stay as close as the slack allows.
 * @param {import('../types.js').Frame} frame
 * @param {{lat:number, lon:number, widthKm:number, heightKm:number}} keep
 * @param {{south:number, west:number, north:number, east:number}} bounds
 * @returns {import('../types.js').Frame}
 */
export function nudgeFrameInside(frame, keep, bounds) {
  const slackLon = Math.max(0, (frame.widthKm - keep.widthKm) / 2) / (KM_PER_DEG_LON_EQ * Math.cos((keep.lat * Math.PI) / 180));
  const slackLat = Math.max(0, (frame.heightKm - keep.heightKm) / 2) / KM_PER_DEG_LAT;
  const out = { ...frame };
  // A few passes: the frame's lat/lon extent changes slightly as it moves (projection).
  for (let pass = 0; pass < 4; pass++) {
    const b = frameBounds(out);
    const dLon = Math.max(0, bounds.west + INSIDE_MARGIN_DEG - b.west) - Math.max(0, b.east - (bounds.east - INSIDE_MARGIN_DEG));
    const dLat = Math.max(0, bounds.south + INSIDE_MARGIN_DEG - b.south) - Math.max(0, b.north - (bounds.north - INSIDE_MARGIN_DEG));
    if (dLon === 0 && dLat === 0) break;
    out.lon = keep.lon + Math.min(slackLon, Math.max(-slackLon, out.lon + dLon - keep.lon));
    out.lat = keep.lat + Math.min(slackLat, Math.max(-slackLat, out.lat + dLat - keep.lat));
  }
  return out;
}

/**
 * Approximate ground rectangle of a lat/lon bounding box (centre + size in km).
 * @param {{south:number, west:number, north:number, east:number}} b
 * @returns {{lat:number, lon:number, widthKm:number, heightKm:number}}
 */
export function boundsToRect(b) {
  const lat = (b.south + b.north) / 2;
  const span = ((b.east - b.west) % 360 + 360) % 360 || 360;
  const lon = wrapLon(b.west + span / 2);
  return {
    lat, lon,
    widthKm: span * KM_PER_DEG_LON_EQ * Math.cos((lat * Math.PI) / 180),
    heightKm: (b.north - b.south) * KM_PER_DEG_LAT,
  };
}

/**
 * Wraps a longitude into [-180, 180).
 * @param {number} lon
 * @returns {number}
 */
export function wrapLon(lon) {
  return ((((lon + 180) % 360) + 360) % 360) - 180;
}

/**
 * File-name friendly slug of a project name (used as the default export prefix).
 * @param {string} name
 * @returns {string}
 */
export function slugify(name) {
  const slug = String(name ?? '')
    .normalize('NFKD').replace(/[̀-ͯ]/g, '')
    .toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '')
    .slice(0, 40);
  return slug || 'relief';
}
