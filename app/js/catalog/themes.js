// Colour themes for relief art: filament sequences with elevation thresholds.

/**
 * A band starts at `fromFrac` (0..1 of the frame's floor..max elevation) or at an absolute
 * `fromM` (metres). The first band always starts at the bottom and needs neither.
 * @typedef {{filamentId:string, fromFrac?:number, fromM?:number}} ThemeBand
 * @typedef {{id:string, name:string, description:string, mode:'bands'|'single', bands:ThemeBand[]}} Theme
 */

/** Theme applied to new projects. */
export const DEFAULT_THEME_ID = 'alpine-classic';

/**
 * @param {string} id
 * @param {string} name
 * @param {string} description
 * @param {Array<string|[string, number]|[string, {fromM:number}]>} seq first entry = bottom filament;
 *   later entries are [filamentId, fraction] or [filamentId, {fromM}]
 * @returns {Theme}
 */
function theme(id, name, description, seq) {
  const bands = seq.map((entry, i) => {
    if (i === 0) return Object.freeze({ filamentId: /** @type {string} */ (entry) });
    const [filamentId, at] = /** @type {[string, number|{fromM:number}]} */ (entry);
    return Object.freeze(typeof at === 'number' ? { filamentId, fromFrac: at } : { filamentId, fromM: at.fromM });
  });
  return Object.freeze({ id, name, description, mode: bands.length > 1 ? 'bands' : 'single', bands: Object.freeze(bands) });
}

/** @type {ReadonlyArray<Theme>} */
export const THEMES = Object.freeze([
  theme('alpine-classic', 'Alpine Classic',
    'Forest valleys, olive slopes, grey rock and snowy summits – the classic Alpine look.',
    ['pla-forest-green', ['pla-olive', 0.19], ['pla-stone-grey', 0.37], ['pla-snow-white', 0.56]]),
  theme('snowcapped', 'Snowcapped',
    'Charcoal rock and grey ridges with bright snow only on the highest peaks.',
    ['pla-matte-charcoal', ['pla-stone-grey', 0.3], ['pla-snow-white', 0.62]]),
  theme('museum-plaster', 'Museum Plaster',
    'A single warm matte white like a plaster cast – light and shadow do all the work.',
    ['pla-matte-bone']),
  theme('glacier', 'Glacier',
    'Cool slate valleys rising through glacier blue and ice to white summits.',
    ['pla-slate', ['pla-glacier-blue', 0.35], ['pla-ice-blue', 0.58], ['pla-snow-white', 0.78]]),
  theme('desert-canyon', 'Desert Canyon',
    'Deep canyon red through terracotta and ochre up to sun-bleached sand.',
    ['pla-canyon-red', ['pla-terracotta', 0.22], ['pla-ochre', 0.45], ['pla-desert-sand', 0.7]]),
  theme('gold-peaks', 'Gold Peaks',
    'Matte black terrain with silk-gold summits that catch the light.',
    ['pla-matte-black', ['pla-silk-gold', 0.55]]),
  theme('midnight-silver', 'Midnight Silver',
    'Deep navy lowlands beneath shimmering silk-silver mountains.',
    ['pla-deep-navy', ['pla-silk-silver', 0.45]]),
  theme('hypsometric-atlas', 'Hypsometric Atlas',
    'School-atlas elevation tints: greens, khaki and browns up to white.',
    ['pla-forest-green', ['pla-alpine-meadow', 0.1], ['pla-khaki', 0.28], ['pla-umber', 0.48], ['pla-snow-white', 0.75]]),
  theme('forest-stone', 'Forest & Stone',
    'Pine forests and mossy slopes giving way to bare grey stone.',
    ['pla-pine-green', ['pla-moss-green', 0.3], ['pla-stone-grey', 0.6]]),
  theme('copper-ridge', 'Copper Ridge',
    'Charcoal base with glowing silk-copper ridges – warm and dramatic.',
    ['pla-matte-charcoal', ['pla-silk-copper', 0.5]]),
  theme('island', 'Island',
    'Ocean blue at sea level, sandy shores, green hills, brown highlands and a white summit.',
    ['pla-ocean-blue', ['pla-desert-sand', { fromM: 1 }], ['pla-forest-green', { fromM: 30 }],
      ['pla-earth-brown', 0.45], ['pla-snow-white', 0.85]]),
  theme('nordic-fjord', 'Nordic Fjord',
    'Navy sea, slate cliffs and pale grey fells under snowy tops.',
    ['pla-deep-navy', ['pla-slate', { fromM: 1 }], ['pla-light-grey', 0.4], ['pla-snow-white', 0.7]]),
  theme('woodcut', 'Woodcut',
    'Walnut, oak and birch wood fills stacked like layered timber art – pairs well with Terraced.',
    ['pla-wood-walnut', ['pla-wood-oak', 0.33], ['pla-wood-birch', 0.66]]),
  theme('marble', 'Marble',
    'Granite-speckled lowlands and white marble mountains, like a carved stone sculpture.',
    ['pla-marble-granite', ['pla-marble-white', 0.45]]),
]);

const BY_ID = new Map(THEMES.map((t) => [t.id, t]));

/**
 * @param {string} id
 * @returns {Theme|null}
 */
export function getTheme(id) {
  return BY_ID.get(id) ?? null;
}

/**
 * Turns a theme into concrete band specs for a terrain.
 * `fromFrac` is relative to `zmap.floorM .. zmap.maxElevM` and rounded to whole metres;
 * `fromM` passes through. The first band always gets `fromM: null` (starts at the bottom).
 * @param {Theme} theme
 * @param {{floorM:number, maxElevM:number}} zmap
 * @returns {Array<{filamentId:string, fromM:number|null}>}
 */
export function applyTheme(theme, zmap) {
  if (!theme || !Array.isArray(theme.bands)) return [];
  const floor = zmap?.floorM;
  const span = (zmap?.maxElevM ?? NaN) - floor;
  return theme.bands.map((b, i) => {
    let fromM = null;
    if (i > 0) {
      if (Number.isFinite(b.fromM)) fromM = b.fromM;
      else if (Number.isFinite(b.fromFrac) && Number.isFinite(span)) fromM = Math.round(floor + b.fromFrac * Math.max(0, span));
    }
    return { filamentId: b.filamentId, fromM };
  });
}
