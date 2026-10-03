// Art-style registry for the UI: names, descriptions, icons and parameter definitions.
// Default values here are the single source of truth for style parameters.

/**
 * @typedef {{
 *   key:string, label:string, type:'range'|'number'|'select'|'checkbox',
 *   min:number|null, max:number|null, step:number|null, unit:string,
 *   options:Array<[string, string]>|null, default:(number|string|boolean),
 *   help:string, showIf:Record<string, (number|string|boolean)>|null
 * }} StyleParam
 * @typedef {{
 *   id:string, name:string, description:string, icon:string,
 *   params:StyleParam[], supportsBands:boolean, usesBase:boolean
 * }} ArtStyle
 */

/** Style used by new projects and for unknown ids. */
export const DEFAULT_STYLE_ID = 'classic';

/**
 * Numeric parameter (slider when `type` is 'range', text box when 'number').
 * @param {'range'|'number'} type
 * @param {string} key
 * @param {string} label
 * @param {number} def
 * @param {[number, number, number]} minMaxStep
 * @param {string} unit
 * @param {string} help
 * @param {Record<string, string|number|boolean>|null} [showIf]
 * @returns {StyleParam}
 */
function num(type, key, label, def, [min, max, step], unit, help, showIf = null) {
  return Object.freeze({ key, label, type, min, max, step, unit, options: null, default: def, help, showIf });
}

/**
 * @param {string} key
 * @param {string} label
 * @param {string} def
 * @param {Array<[string, string]>} options [value, label] pairs
 * @param {string} help
 * @returns {StyleParam}
 */
function select(key, label, def, options, help) {
  return Object.freeze({ key, label, type: 'select', min: null, max: null, step: null, unit: '', options, default: def, help, showIf: null });
}

/**
 * @param {string} key
 * @param {string} label
 * @param {boolean} def
 * @param {string} help
 * @returns {StyleParam}
 */
function checkbox(key, label, def, help) {
  return Object.freeze({ key, label, type: 'checkbox', min: null, max: null, step: null, unit: '', options: null, default: def, help, showIf: null });
}

/**
 * Wraps icon paths in a 48×48 line-art SVG that inherits the text colour.
 * @param {string} body
 * @returns {string}
 */
function icon(body) {
  return '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 48 48" width="48" height="48" fill="none" '
    + 'stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">'
    + body + '</svg>';
}

/**
 * Closed SVG path of a pointy-top hexagon.
 * @param {number} cx
 * @param {number} cy
 * @param {number} r circumradius
 * @returns {string}
 */
function hexPath(cx, cy, r) {
  const pts = [];
  for (let k = 0; k < 6; k++) {
    const a = Math.PI / 6 + k * Math.PI / 3;
    pts.push(`${(cx + r * Math.cos(a)).toFixed(1)} ${(cy + r * Math.sin(a)).toFixed(1)}`);
  }
  return `<path d="M${pts.join('L')}Z"/>`;
}

const ICONS = Object.freeze({
  classic: icon('<path d="M4 38c5-5 8-13 13-21 2.5-4 5.5-4 8 0l4 6c1.5 2.5 3.5 2.5 5 .5 2-2.5 4-1 5 1.5L44 38"/>'
    + '<path d="M4 38h40"/><path d="M14.5 22l3.5 2 3.5-2.5 3.5 2.5 3-1.5" opacity=".5"/>'),
  terraced: icon('<path d="M4 38h4v-5h5v-6h5v-6h4v-6h5v6h4v6h4v5h5v6h4"/><path d="M4 38h40" opacity=".45"/>'),
  lowpoly: icon('<path d="M4 38 16 18l8 8 7-15 13 27Z"/><path d="M16 18 20 38 24 26 32 38 31 11"/>'),
  ridgelines: icon('<path d="M4 14h10l3-4 3 3 3-5 3 6h18"/><path d="M4 22h8l4-3 3 1 4-5 4 6 3-1 2 2h12"/>'
    + '<path d="M4 30h9l4-4 4 2 3-5 4 7 3-2 3 2h10"/><path d="M4 38h8l4-4 4 3 4-6 4 6 4-3 3 4h9"/>'),
  hex: icon(hexPath(17, 17, 7.5) + hexPath(31, 17, 7.5) + hexPath(24, 29.5, 7.5) + '<path d="M17 37v4M31 37v4M24 37v4" opacity=".45"/>'),
  contours: icon('<path d="M6 30c0-10 8-22 19-22 10 0 17 8 17 17 0 9-8 15-18 15-9 0-18-2-18-10Z"/>'
    + '<path d="M13 28c0-7 6-14 12-14 6 0 10 5 10 10s-5 9-11 9c-6 0-11-1-11-5Z"/>'
    + '<path d="M20 26c0-3 3-6 5-6 3 0 4 2 4 4s-2 4-5 4c-2 0-4-1-4-2Z"/>'),
  lithophane: icon('<rect x="13" y="9" width="22" height="30" rx="1.5"/><path d="M13 33l6-8 4 4 5-8 7 10"/>'
    + '<circle cx="28" cy="16" r="2.5"/><path d="M8 16H4M8 24H4M8 32H4M44 16h-4M44 24h-4M44 32h-4" opacity=".6"/>'),
});

/**
 * The seven art styles in UI order.
 * @type {ReadonlyArray<ArtStyle>}
 */
export const ART_STYLES = Object.freeze([
  Object.freeze({
    id: 'classic', name: 'Classic relief',
    description: 'Smooth shaded terrain – timeless and true to the landscape.',
    icon: ICONS.classic, supportsBands: true, usesBase: true,
    params: Object.freeze([]),
  }),
  Object.freeze({
    id: 'terraced', name: 'Terraced',
    description: 'Flat stepped terraces like stacked layers of laser-cut wood.',
    icon: ICONS.terraced, supportsBands: true, usesBase: true,
    params: Object.freeze([
      select('stepMode', 'Steps by', 'count', [['count', 'Number of steps'], ['meters', 'Elevation interval']],
        'Divide the elevation range into a fixed number of terraces, or cut a terrace every N metres.'),
      num('range', 'count', 'Steps', 16, [3, 60, 1], '',
        'Number of terraces between the lowest and highest point.', { stepMode: 'count' }),
      num('number', 'stepM', 'Interval', 200, [10, 2000, 10], 'm',
        'Elevation difference between two terraces.', { stepMode: 'meters' }),
      checkbox('snapToLayers', 'Snap to print layers', true,
        'Round terrace heights to whole layers so every step prints perfectly flat.'),
    ]),
  }),
  Object.freeze({
    id: 'lowpoly', name: 'Low-poly',
    description: 'Crystalline triangular facets – a modern, geometric take on the mountains.',
    icon: ICONS.lowpoly, supportsBands: true, usesBase: true,
    params: Object.freeze([
      num('range', 'facetMm', 'Facet size', 1.2, [0.2, 5, 0.1], 'mm',
        'Maximum deviation of the triangles from the true surface – larger values give bigger facets.'),
    ]),
  }),
  Object.freeze({
    id: 'ridgelines', name: 'Ridgelines',
    description: 'Thin parallel ribs tracing the terrain profile, like the famous “Unknown Pleasures” cover.',
    icon: ICONS.ridgelines, supportsBands: true, usesBase: true,
    params: Object.freeze([
      num('range', 'spacingMm', 'Rib spacing', 5, [1.5, 20, 0.5], 'mm', 'Distance between neighbouring ribs.'),
      num('range', 'thicknessMm', 'Rib thickness', 1.2, [0.4, 4, 0.1], 'mm',
        'Wall thickness of each rib – use at least two extrusion widths (≈0.9 mm) for clean prints.'),
      select('direction', 'Direction', 'horizontal', [['horizontal', 'Horizontal (east–west)'], ['vertical', 'Vertical (north–south)']],
        'Orientation of the ribs on the artwork.'),
      num('range', 'staggerMm', 'Stagger', 0, [0, 1, 0.05], 'mm',
        'Lifts every rib this much above the one before it (counted from the top edge) for a stacked, layered look – it adds up over all ribs, so keep it small (0 = ribs follow the terrain only).'),
    ]),
  }),
  Object.freeze({
    id: 'hex', name: 'Hex columns',
    description: 'Terrain built from hexagonal (or square) columns, like basalt organ pipes.',
    icon: ICONS.hex, supportsBands: true, usesBase: true,
    params: Object.freeze([
      select('shape', 'Cell shape', 'hex', [['hex', 'Hexagon'], ['square', 'Square']], 'Shape of each column.'),
      num('range', 'cellMm', 'Cell size', 8, [2, 30, 0.5], 'mm', 'Width of one column across its flats.'),
      num('range', 'gapMm', 'Gap', 0.6, [0, 3, 0.1], 'mm', 'Groove between columns (0 = touching columns).'),
      num('range', 'stepMm', 'Height step', 0, [0, 5, 0.1], 'mm',
        'Rounds each column height to a multiple of this (0 = exact heights).'),
    ]),
  }),
  Object.freeze({
    id: 'contours', name: 'Contour lines',
    description: 'Shaded relief with engraved or embossed contour lines, like a topographic map.',
    icon: ICONS.contours, supportsBands: true, usesBase: true,
    params: Object.freeze([
      num('number', 'intervalM', 'Interval', 200, [10, 2000, 10], 'm', 'Elevation difference between contour lines.'),
      num('range', 'majorEvery', 'Major line every', 5, [1, 10, 1], '',
        'Every n-th line is drawn as a bolder index contour (1 = all lines bold).'),
      num('range', 'lineWidthMm', 'Line width', 0.6, [0.2, 2, 0.1], 'mm', 'Width of the minor contour lines.'),
      num('range', 'depthMm', 'Line depth', 0.4, [0.1, 2, 0.1], 'mm', 'How deep lines are cut or how high they stand.'),
      select('mode', 'Lines are', 'engrave', [['engrave', 'Engraved'], ['emboss', 'Embossed']],
        'Cut the lines into the surface or raise them above it.'),
    ]),
  }),
  Object.freeze({
    id: 'lithophane', name: 'Lithophane',
    description: 'A thin panel that reveals a shaded-relief image when lit from behind – print in white.',
    icon: ICONS.lithophane, supportsBands: false, usesBase: false,
    params: Object.freeze([
      num('range', 'minMm', 'Min thickness', 0.8, [0.4, 3, 0.1], 'mm', 'Thinnest (brightest) part of the panel.'),
      num('range', 'maxMm', 'Max thickness', 3.2, [1, 8, 0.1], 'mm', 'Thickest (darkest) part of the panel.'),
      num('range', 'sunAzimuth', 'Light direction', 315, [0, 360, 5], '°', 'Compass direction of the virtual sun (315° = north-west).'),
      num('range', 'sunAltitude', 'Light height', 35, [5, 85, 1], '°', 'Elevation of the virtual sun above the horizon – lower is more dramatic.'),
      num('range', 'contrast', 'Contrast', 1, [0.3, 3, 0.05], '×', 'Strengthens or softens the shading.'),
    ]),
  }),
]);

const BY_ID = new Map(ART_STYLES.map((s) => [s.id, s]));

/**
 * Looks up an art style; unknown ids resolve to the classic style (never undefined).
 * @param {string} id
 * @returns {ArtStyle}
 */
export function getArtStyle(id) {
  return BY_ID.get(id) ?? BY_ID.get(DEFAULT_STYLE_ID);
}

/**
 * Default parameter values of a style.
 * @param {string} id
 * @returns {Record<string, number|string|boolean>}
 */
export function artStyleDefaults(id) {
  const out = {};
  for (const p of getArtStyle(id).params) out[p.key] = p.default;
  return out;
}

/**
 * Validates one parameter value against its definition; invalid values yield the default.
 * Numbers are clamped to the parameter's range.
 * @param {StyleParam} p
 * @param {unknown} v
 * @returns {number|string|boolean}
 */
function coerceParam(p, v) {
  switch (p.type) {
    case 'checkbox':
      return typeof v === 'boolean' ? v : p.default;
    case 'select':
      return p.options.some(([value]) => value === v) ? /** @type {string} */ (v) : p.default;
    default: {
      const n = typeof v === 'string' && v.trim() !== '' ? Number(v) : v;
      if (typeof n !== 'number' || !Number.isFinite(n)) return p.default;
      return Math.min(p.max, Math.max(p.min, n));
    }
  }
}

/**
 * Effective parameters of the project's art style: the style defaults merged with
 * `project.style.params` (only known keys; invalid values fall back to the default,
 * numbers are clamped to the parameter range).
 * @param {{style?:{id?:string, params?:object}}} project
 * @returns {Record<string, number|string|boolean>}
 */
export function styleParams(project) {
  const style = getArtStyle(project?.style?.id);
  const given = project?.style?.params ?? {};
  const out = {};
  for (const p of style.params) {
    out[p.key] = Object.prototype.hasOwnProperty.call(given, p.key) ? coerceParam(p, given[p.key]) : p.default;
  }
  return out;
}

/**
 * Sanitises stored style parameters: keeps only the parameters the style defines, with invalid
 * values replaced by the default and numbers clamped to the parameter range (used by
 * normalizeProject, so hand-edited projects or links cannot ask for e.g. 0.01 mm hex cells).
 * @param {string} id style id (unknown ids → classic, which has no parameters)
 * @param {Record<string, unknown>} params
 * @returns {Record<string, number|string|boolean>}
 */
export function sanitizeStyleParams(id, params) {
  const out = {};
  for (const p of getArtStyle(id).params) {
    if (params && Object.prototype.hasOwnProperty.call(params, p.key)) out[p.key] = coerceParam(p, params[p.key]);
  }
  return out;
}

/**
 * Whether a parameter control should be shown for the current values (its `showIf` matches).
 * @param {StyleParam} param
 * @param {Record<string, unknown>} values effective parameter values (see styleParams)
 * @returns {boolean}
 */
export function isParamVisible(param, values) {
  if (!param.showIf) return true;
  return Object.entries(param.showIf).every(([k, v]) => values?.[k] === v);
}
