// Project store with change notifications, and project normalisation (invariants + clamps).
// DOM-free.

import { DEFAULT_PROJECT, artworkAspect, classifyChange, wrapLon } from './project.js';

const SOURCES = ['auto', 'local', 'live'];
const FLOOR_MODES = ['auto', 'sea', 'fixed'];
const WATER_MODES = ['none', 'flat', 'recess'];
const COLOR_MODES = ['single', 'bands'];
const SPEED_CLASSES = ['slow', 'standard', 'fast'];
const LIGHTING = ['gallery', 'morning', 'evening', 'overcast', 'raking', 'backlit'];
const FINISH_IDS = ['basic', 'matte', 'silk', 'metallic', 'marble', 'wood', 'glitter', 'translucent'];
const HEX = /^#[0-9a-f]{6}$/i;

/** Minimum material kept above engraved labels / magnet pockets, in mm. */
export const MIN_ABOVE_POCKET_MM = 0.8;
/** Hard limits used by normalizeProject (exported so the UI can use the same ranges). */
export const LIMITS = Object.freeze({
  lat: [-84, 84], widthKm: [0.5, 5000], rotationDeg: [-180, 180],
  bed: [40, 1000], maxZ: [10, 1000], nozzleMm: [0.1, 1.2],
  tiles: [1, 8], tileMm: [20, 1000],
  exaggeration: [0.5, 30], targetReliefMm: [2, 300], baseMm: [0.6, 60],
  floorElevationM: [-500, 9000], smoothingMm: [0, 10], resolutionMm: [0.1, 2],
  simplifyMm: [0, 1], waterDepthMm: [0, 5], maxHeightMm: [0, 1000],
  borderWidthMm: [1, 40], borderHeightMm: [0, 30],
  layerHeightMm: [0.04, 0.6], firstLayerMm: [0.08, 0.8],
  labelDepthMm: [0.2, 3], magnetDiameterMm: [2, 40], magnetDepthMm: [0.5, 20],
  magnetsPerTile: [1, 8], magnetInsetMm: [3, 300],
  infillPct: [0, 100], walls: [1, 12], skinLayers: [0, 40], pricePerKg: [0, 1000],
  maxBands: 16, nameLength: 80,
});

/**
 * Creates the project store.
 * `set(patch, meta)` accepts a partial object (deep-merged; arrays replace) or a function
 * that receives a mutable draft and either mutates it or returns a replacement.
 * Every `set` normalises the result and notifies subscribers with
 * `(project, prev, {source, warnings, changes, ...meta})` – also when nothing changed, so
 * controls can resync clamped values.
 * @param {object} initialProject
 * @returns {{get:()=>object, set:(patch:object|Function, meta?:{source?:string, [k:string]:any})=>object,
 *            subscribe:(fn:Function)=>()=>void}}
 */
export function createStore(initialProject) {
  let project = deepFreeze(normalizeProject(initialProject ?? DEFAULT_PROJECT));
  const subscribers = new Set();
  return {
    get: () => project,
    set(patch, meta = {}) {
      const prev = project;
      const draft = structuredClone(prev);
      let next;
      if (typeof patch === 'function') {
        const returned = patch(draft);
        next = returned === undefined ? draft : returned;
      } else {
        next = deepMerge(draft, patch ?? {});
      }
      const warnings = [];
      project = deepFreeze(normalizeProject(next, { warnings, prev }));
      const info = { source: 'ui', ...meta, warnings, changes: classifyChange(prev, project) };
      for (const fn of [...subscribers]) fn(project, prev, info);
      return project;
    },
    subscribe(fn) {
      subscribers.add(fn);
      return () => subscribers.delete(fn);
    },
  };
}

/**
 * Returns a normalised copy of a (possibly partial or outdated) project: missing fields are
 * filled from DEFAULT_PROJECT, numbers clamped to LIMITS, enums validated, and invariants enforced:
 *  - frame.heightKm = frame.widthKm × artwork aspect (the width is kept when the layout changes)
 *  - base ≥ deepest back feature (magnet pocket / label) + 0.8 mm (raised with a warning)
 *  - colour bands sorted ascending, first band starts at the bottom (fromM = null)
 * @param {object} input
 * @param {{warnings?:string[], prev?:object}} [ctx] warnings receives human-readable notes
 * @returns {object} new project object (input is not modified)
 */
export function normalizeProject(input, ctx = {}) {
  const warnings = ctx.warnings ?? [];
  const p = mergeDefaults(DEFAULT_PROJECT, isObject(input) ? input : {});

  p.version = DEFAULT_PROJECT.version;
  p.name = (typeof p.name === 'string' ? p.name.replace(/\s+/g, ' ').trim() : '').slice(0, LIMITS.nameLength) || 'Untitled relief';
  p.regionId = typeof p.regionId === 'string' && p.regionId ? p.regionId : DEFAULT_PROJECT.regionId;
  p.source = oneOf(p.source, SOURCES, 'auto');

  normalizePrinter(p.printer);
  normalizeLayout(p.layout);
  normalizeFrame(p.frame, artworkAspect(p.layout));
  normalizeRelief(p.relief);
  normalizeStyle(p.style);
  p.border.enabled = Boolean(p.border.enabled);
  p.border.widthMm = clamp(p.border.widthMm, ...LIMITS.borderWidthMm, 6);
  p.border.heightMm = clamp(p.border.heightMm, ...LIMITS.borderHeightMm, 2);
  normalizeColors(p.colors);
  normalizeFilaments(p.filaments);
  normalizeBack(p.back);
  normalizePrint(p.print);
  normalizeView(p.view);
  enforceBaseForBackFeatures(p, warnings);
  return p;
}

/**
 * Deep merge: plain objects merge recursively, everything else (arrays, primitives) replaces.
 * Mutates and returns `target`.
 * @param {object} target
 * @param {object} patch
 * @returns {object}
 */
export function deepMerge(target, patch) {
  for (const [key, value] of Object.entries(patch)) {
    if (isObject(value) && isObject(target[key])) deepMerge(target[key], value);
    else target[key] = structuredClone(value);
  }
  return target;
}

// ---------------------------------------------------------------------------------------------

function normalizePrinter(pr) {
  pr.presetId = typeof pr.presetId === 'string' && pr.presetId ? pr.presetId : 'custom';
  pr.bedW = round(clamp(pr.bedW, ...LIMITS.bed, 256), 1);
  pr.bedH = round(clamp(pr.bedH, ...LIMITS.bed, 256), 1);
  pr.maxZ = round(clamp(pr.maxZ, ...LIMITS.maxZ, 250), 1);
  pr.nozzleMm = round(clamp(pr.nozzleMm, ...LIMITS.nozzleMm, 0.4), 2);
}

function normalizeLayout(l) {
  l.cols = Math.round(clamp(l.cols, ...LIMITS.tiles, 4));
  l.rows = Math.round(clamp(l.rows, ...LIMITS.tiles, 2));
  l.tileW = round(clamp(l.tileW, ...LIMITS.tileMm, 246), 1);
  l.tileH = round(clamp(l.tileH, ...LIMITS.tileMm, 246), 1);
}

function normalizeFrame(f, aspect) {
  f.lat = clamp(f.lat, ...LIMITS.lat, DEFAULT_PROJECT.frame.lat);
  f.lon = wrapLon(finite(f.lon, DEFAULT_PROJECT.frame.lon));
  const maxWidth = Math.min(LIMITS.widthKm[1], LIMITS.widthKm[1] / aspect);
  f.widthKm = clamp(f.widthKm, LIMITS.widthKm[0], maxWidth, DEFAULT_PROJECT.frame.widthKm);
  f.heightKm = f.widthKm * aspect;
  let rot = finite(f.rotationDeg, 0) % 360;
  if (rot > 180) rot -= 360;
  if (rot <= -180) rot += 360;
  f.rotationDeg = rot;
}

function normalizeRelief(r) {
  r.exaggeration = round(clamp(r.exaggeration, ...LIMITS.exaggeration, 4), 2);
  r.autoExaggeration = Boolean(r.autoExaggeration);
  r.targetReliefMm = clamp(r.targetReliefMm, ...LIMITS.targetReliefMm, 25);
  r.baseMm = round(clamp(r.baseMm, ...LIMITS.baseMm, 3), 2);
  r.floor.mode = oneOf(r.floor.mode, FLOOR_MODES, 'auto');
  r.floor.elevationM = clamp(r.floor.elevationM, ...LIMITS.floorElevationM, 0);
  r.smoothingMm = clamp(r.smoothingMm, ...LIMITS.smoothingMm, 0.4);
  r.resolutionMm = round(clamp(r.resolutionMm, ...LIMITS.resolutionMm, 0.4), 3);
  r.simplifyMm = clamp(r.simplifyMm, ...LIMITS.simplifyMm, 0.02);
  r.water.mode = oneOf(r.water.mode, WATER_MODES, 'recess');
  r.water.depthMm = clamp(r.water.depthMm, ...LIMITS.waterDepthMm, 0.6);
  r.maxHeightMm = clamp(r.maxHeightMm, ...LIMITS.maxHeightMm, 0);
}

function normalizeStyle(s) {
  s.id = typeof s.id === 'string' && s.id ? s.id : 'classic';
  const params = {};
  for (const [k, v] of Object.entries(isObject(s.params) ? s.params : {})) {
    if ((typeof v === 'number' && Number.isFinite(v)) || typeof v === 'string' || typeof v === 'boolean') params[k] = v;
  }
  s.params = params;
}

function normalizeColors(c) {
  c.mode = oneOf(c.mode, COLOR_MODES, 'bands');
  c.themeId = typeof c.themeId === 'string' ? c.themeId : '';
  c.autoFit = Boolean(c.autoFit);
  c.bands = normalizeBands(c.bands);
  c.singleFilamentId = typeof c.singleFilamentId === 'string' && c.singleFilamentId
    ? c.singleFilamentId : DEFAULT_PROJECT.colors.singleFilamentId;
  c.layerHeightMm = round(clamp(c.layerHeightMm, ...LIMITS.layerHeightMm, 0.2), 3);
  c.firstLayerMm = round(clamp(c.firstLayerMm, ...LIMITS.firstLayerMm, 0.2), 3);
}

/**
 * Sorts bands ascending by start elevation; the first band always starts at the bottom
 * (fromM = null) and additional bottom bands are dropped.
 * @param {unknown} bands
 * @returns {{filamentId:string, fromM:number|null}[]}
 */
export function normalizeBands(bands) {
  const clean = (Array.isArray(bands) ? bands : [])
    .filter((b) => isObject(b) && typeof b.filamentId === 'string' && b.filamentId)
    .map((b) => ({ filamentId: b.filamentId, fromM: Number.isFinite(b.fromM) ? Math.round(b.fromM) : null }));
  if (!clean.length) return structuredClone(DEFAULT_PROJECT.colors.bands);
  const order = clean.map((b, i) => [b, i]);
  order.sort(([a, ia], [b, ib]) => (a.fromM ?? -Infinity) - (b.fromM ?? -Infinity) || ia - ib);
  const sorted = order.map(([b]) => b);
  const out = [{ filamentId: sorted[0].filamentId, fromM: null }];
  for (const b of sorted.slice(1)) if (b.fromM !== null) out.push(b);
  return out.slice(0, LIMITS.maxBands);
}

function normalizeFilaments(f) {
  f.owned = [...new Set((Array.isArray(f.owned) ? f.owned : []).filter((id) => typeof id === 'string' && id))];
  const seen = new Set();
  f.custom = (Array.isArray(f.custom) ? f.custom : []).filter(isObject).map((c) => ({
    id: typeof c.id === 'string' && c.id ? c.id : `custom-${Math.random().toString(36).slice(2, 8)}`,
    name: (typeof c.name === 'string' && c.name.trim() ? c.name.trim() : 'Custom filament').slice(0, 60),
    material: typeof c.material === 'string' && c.material ? c.material : 'PLA',
    color: typeof c.color === 'string' && HEX.test(c.color) ? c.color.toLowerCase() : '#888888',
    finish: oneOf(c.finish, FINISH_IDS, 'basic'),
    ...(Number.isFinite(c.pricePerKg) ? { pricePerKg: clamp(c.pricePerKg, ...LIMITS.pricePerKg, 20) } : {}),
  })).filter((c) => !seen.has(c.id) && seen.add(c.id));
}

function normalizeBack(b) {
  b.labels = Boolean(b.labels);
  b.labelDepthMm = round(clamp(b.labelDepthMm, ...LIMITS.labelDepthMm, 0.6), 2);
  const m = b.magnets;
  m.enabled = Boolean(m.enabled);
  m.diameterMm = round(clamp(m.diameterMm, ...LIMITS.magnetDiameterMm, 10.2), 2);
  m.depthMm = round(clamp(m.depthMm, ...LIMITS.magnetDepthMm, 3.2), 2);
  m.perTile = Math.round(clamp(m.perTile, ...LIMITS.magnetsPerTile, 4));
  m.insetMm = clamp(m.insetMm, ...LIMITS.magnetInsetMm, 25);
}

function normalizePrint(pr) {
  pr.material = typeof pr.material === 'string' && pr.material ? pr.material : 'PLA';
  pr.infillPct = Math.round(clamp(pr.infillPct, ...LIMITS.infillPct, 15));
  pr.walls = Math.round(clamp(pr.walls, ...LIMITS.walls, 3));
  pr.topLayers = Math.round(clamp(pr.topLayers, ...LIMITS.skinLayers, 5));
  pr.bottomLayers = Math.round(clamp(pr.bottomLayers, ...LIMITS.skinLayers, 4));
  pr.speedClass = oneOf(pr.speedClass, SPEED_CLASSES, 'standard');
}

function normalizeView(v) {
  v.lighting = oneOf(v.lighting, LIGHTING, 'gallery');
  v.wallColor = typeof v.wallColor === 'string' && HEX.test(v.wallColor) ? v.wallColor.toLowerCase() : DEFAULT_PROJECT.view.wallColor;
  for (const key of ['wallMode', 'exploded', 'seams', 'layerLines', 'labels', 'highlightWater']) v[key] = Boolean(v[key]);
}

function enforceBaseForBackFeatures(p, warnings) {
  const { back, relief } = p;
  const magnetDepth = back.magnets.enabled ? back.magnets.depthMm : 0;
  const labelDepth = back.labels ? back.labelDepthMm : 0;
  const deepest = Math.max(magnetDepth, labelDepth);
  if (deepest <= 0) return;
  const required = round(deepest + MIN_ABOVE_POCKET_MM, 2);
  if (relief.baseMm + 1e-9 < required) {
    const what = magnetDepth >= labelDepth ? `${fmt(magnetDepth)} mm magnet pockets` : `${fmt(labelDepth)} mm deep labels`;
    warnings.push(`Base raised from ${fmt(relief.baseMm)} mm to ${fmt(required)} mm so the ${what} keep ${MIN_ABOVE_POCKET_MM} mm of material above them.`);
    relief.baseMm = required;
  }
}

/** Fills `value` with defaults: objects recurse, arrays/primitives must match the default's type. */
function mergeDefaults(defaults, value) {
  const out = {};
  for (const [key, def] of Object.entries(defaults)) {
    const v = value?.[key];
    if (isObject(def)) {
      // Open-ended maps (style.params) keep unknown keys; normalizeStyle filters them.
      out[key] = Object.keys(def).length === 0 ? (isObject(v) ? structuredClone(v) : {}) : mergeDefaults(def, isObject(v) ? v : {});
    } else if (Array.isArray(def)) {
      out[key] = Array.isArray(v) ? structuredClone(v) : structuredClone(def);
    } else if (def === null ? (v === null || typeof v === 'number') : typeof v === typeof def) {
      out[key] = v;
    } else {
      out[key] = def;
    }
  }
  return out;
}

function deepFreeze(obj) {
  if (obj && typeof obj === 'object' && !Object.isFrozen(obj)) {
    Object.freeze(obj);
    for (const v of Object.values(obj)) deepFreeze(v);
  }
  return obj;
}

function isObject(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

function finite(v, fallback) {
  return typeof v === 'number' && Number.isFinite(v) ? v : fallback;
}

function clamp(v, lo, hi, fallback) {
  const n = finite(v, fallback);
  return Math.min(hi, Math.max(lo, n));
}

function oneOf(v, allowed, fallback) {
  return allowed.includes(v) ? v : fallback;
}

function round(v, decimals) {
  const f = 10 ** decimals;
  return Math.round(v * f) / f;
}

function fmt(v) {
  return String(round(v, 2));
}
