// Filament presets (generic, brand-neutral colours) and the render properties of each finish.

/**
 * @typedef {'basic'|'matte'|'silk'|'metallic'|'marble'|'wood'|'glitter'|'translucent'} Finish
 * @typedef {{
 *   id:string, name:string, material:string, color:string, finish:Finish,
 *   family?:string, pricePerKg?:number, custom?:boolean, missing?:boolean
 * }} Filament
 * @typedef {{
 *   label:string, roughness:number, metalness:number,
 *   sheen?:number, clearcoat?:number, transmission?:number, sparkle?:number, speckle?:number, grain?:number
 * }} FinishLook
 */

/**
 * Physically based render hints per finish – the single source of truth for the 3D preview
 * (preview/materials.js reads roughness/metalness from here). `roughness`/`metalness`
 * map to MeshStandardMaterial; the optional extras are 0..1 strengths a renderer may use
 * (sheen/clearcoat/transmission → MeshPhysicalMaterial, sparkle/speckle/grain → procedural).
 * @type {Readonly<Record<Finish, FinishLook>>}
 */
export const FINISHES = Object.freeze({
  basic: Object.freeze({ label: 'Basic', roughness: 0.6, metalness: 0, clearcoat: 0.1 }),
  matte: Object.freeze({ label: 'Matte', roughness: 0.92, metalness: 0 }),
  silk: Object.freeze({ label: 'Silk', roughness: 0.32, metalness: 0.5, sheen: 0.6, clearcoat: 0.3 }),
  metallic: Object.freeze({ label: 'Metallic', roughness: 0.3, metalness: 0.8 }),
  marble: Object.freeze({ label: 'Marble', roughness: 0.55, metalness: 0, speckle: 0.35 }),
  wood: Object.freeze({ label: 'Wood', roughness: 0.7, metalness: 0, grain: 0.4 }),
  glitter: Object.freeze({ label: 'Glitter', roughness: 0.45, metalness: 0.2, sparkle: 0.6 }),
  translucent: Object.freeze({ label: 'Translucent', roughness: 0.3, metalness: 0, transmission: 0.45 }),
});

/** Colour families used to group the filament picker. */
export const FILAMENT_FAMILIES = Object.freeze({
  neutral: 'Whites, greys & blacks',
  green: 'Greens',
  earth: 'Browns & earth',
  sand: 'Sand & terracotta',
  blue: 'Blues & ice',
  metal: 'Silk & metallic',
  special: 'Marble, wood & effects',
});

/**
 * @param {string} family
 * @param {string} id
 * @param {string} name
 * @param {string} material
 * @param {string} color
 * @param {Finish} finish
 * @returns {Filament}
 */
function filament(family, id, name, material, color, finish) {
  return Object.freeze({ id, name, material, color, finish, family });
}

/**
 * Generic filament presets. Colours approximate common retail spools.
 * @type {ReadonlyArray<Filament>}
 */
export const FILAMENTS = Object.freeze([
  filament('neutral', 'pla-snow-white', 'Snow White', 'PLA', '#f4f4f1', 'matte'),
  filament('neutral', 'pla-ivory', 'Ivory', 'PLA', '#ede5d0', 'basic'),
  filament('neutral', 'pla-matte-bone', 'Matte Bone White', 'PLA-Matte', '#e3dccb', 'matte'),
  filament('neutral', 'pla-light-grey', 'Light Grey', 'PLA', '#c3c5c6', 'basic'),
  filament('neutral', 'pla-stone-grey', 'Stone Grey', 'PLA', '#8e8c86', 'matte'),
  filament('neutral', 'pla-slate', 'Slate Grey', 'PLA', '#5b6166', 'basic'),
  filament('neutral', 'pla-matte-charcoal', 'Matte Charcoal', 'PLA-Matte', '#3b3b3c', 'matte'),
  filament('neutral', 'pla-jet-black', 'Jet Black', 'PLA', '#161617', 'basic'),
  filament('neutral', 'pla-matte-black', 'Matte Black', 'PLA-Matte', '#202021', 'matte'),

  filament('green', 'pla-pine-green', 'Pine Green', 'PLA', '#1f4a35', 'basic'),
  filament('green', 'pla-forest-green', 'Forest Green', 'PLA', '#2f5d3a', 'basic'),
  filament('green', 'pla-alpine-meadow', 'Alpine Meadow', 'PLA', '#6b9649', 'basic'),
  filament('green', 'pla-moss-green', 'Moss Green', 'PLA', '#5a7142', 'matte'),
  filament('green', 'pla-olive', 'Olive', 'PLA', '#77753f', 'matte'),
  filament('green', 'pla-matte-sage', 'Matte Sage', 'PLA-Matte', '#9aae88', 'matte'),

  filament('earth', 'pla-chocolate', 'Dark Chocolate', 'PLA', '#4a3226', 'basic'),
  filament('earth', 'pla-earth-brown', 'Earth Brown', 'PLA', '#6d4e35', 'matte'),
  filament('earth', 'pla-umber', 'Raw Umber', 'PLA', '#836646', 'basic'),
  filament('earth', 'pla-khaki', 'Khaki', 'PLA', '#a59768', 'matte'),
  filament('earth', 'pla-matte-latte', 'Matte Latte', 'PLA-Matte', '#b49c7e', 'matte'),

  filament('sand', 'pla-desert-sand', 'Desert Sand', 'PLA', '#d9c39e', 'matte'),
  filament('sand', 'pla-sandstone', 'Sandstone', 'PLA', '#c6a578', 'matte'),
  filament('sand', 'pla-ochre', 'Ochre', 'PLA', '#c48b30', 'basic'),
  filament('sand', 'pla-terracotta', 'Terracotta', 'PLA', '#b35f3c', 'matte'),
  filament('sand', 'pla-canyon-red', 'Canyon Red', 'PLA', '#8c3a25', 'basic'),

  filament('blue', 'pla-deep-navy', 'Deep Navy', 'PLA', '#1b2a4a', 'basic'),
  filament('blue', 'pla-ocean-blue', 'Ocean Blue', 'PLA', '#1f5f8b', 'basic'),
  filament('blue', 'pla-lake-teal', 'Lake Teal', 'PLA', '#2a7c78', 'basic'),
  filament('blue', 'pla-glacier-blue', 'Glacier Blue', 'PLA', '#9fcbe0', 'basic'),
  filament('blue', 'pla-ice-blue', 'Ice Blue', 'PLA', '#d2e8f1', 'matte'),
  filament('blue', 'petg-translucent-ice', 'Translucent Ice', 'PETG', '#cfe7f2', 'translucent'),
  filament('blue', 'petg-translucent-clear', 'Translucent Clear', 'PETG', '#e9eff1', 'translucent'),

  filament('metal', 'pla-silk-gold', 'Silk Gold', 'PLA-Silk', '#d4a838', 'silk'),
  filament('metal', 'pla-silk-champagne', 'Silk Champagne', 'PLA-Silk', '#e0cc9f', 'silk'),
  filament('metal', 'pla-silk-silver', 'Silk Silver', 'PLA-Silk', '#c1c5ca', 'silk'),
  filament('metal', 'pla-silk-copper', 'Silk Copper', 'PLA-Silk', '#b86a3b', 'silk'),
  filament('metal', 'pla-silk-bronze', 'Silk Bronze', 'PLA-Silk', '#8d6a3d', 'silk'),
  filament('metal', 'pla-silk-pearl', 'Silk Pearl', 'PLA-Silk', '#ece7dc', 'silk'),
  filament('metal', 'pla-silk-emerald', 'Silk Emerald', 'PLA-Silk', '#1e7a52', 'silk'),
  filament('metal', 'pla-silk-sapphire', 'Silk Sapphire', 'PLA-Silk', '#25508e', 'silk'),
  filament('metal', 'pla-metal-iron', 'Iron Grey Metallic', 'PLA', '#6b6e72', 'metallic'),

  filament('special', 'pla-marble-white', 'White Marble', 'PLA-Marble', '#e8e5de', 'marble'),
  filament('special', 'pla-marble-granite', 'Granite Marble', 'PLA-Marble', '#9a9791', 'marble'),
  filament('special', 'pla-wood-birch', 'Birch Wood', 'PLA-Wood', '#d6be91', 'wood'),
  filament('special', 'pla-wood-oak', 'Oak Wood', 'PLA-Wood', '#a57b4e', 'wood'),
  filament('special', 'pla-wood-walnut', 'Walnut Wood', 'PLA-Wood', '#5b3c26', 'wood'),
  filament('special', 'pla-galaxy-black', 'Galaxy Black', 'PLA', '#1b1b22', 'glitter'),
  filament('special', 'pla-starry-blue', 'Starry Night Blue', 'PLA', '#1d2a56', 'glitter'),
]);

const PRESETS_BY_ID = new Map(FILAMENTS.map((f) => [f.id, f]));

/** Colour used for filaments that cannot be resolved. */
export const FALLBACK_COLOR = '#9a9a9a';

const HEX_COLOR = /^#[0-9a-f]{6}$/i;

/**
 * Brings a user-defined filament into the preset shape (defaults for missing fields).
 * @param {Partial<Filament> & {id:string}} f
 * @returns {Filament}
 */
export function normalizeCustomFilament(f) {
  const finish = f.finish in FINISHES ? f.finish : 'basic';
  const out = {
    id: String(f.id),
    name: f.name ? String(f.name) : String(f.id),
    material: f.material ? String(f.material) : 'PLA',
    color: HEX_COLOR.test(f.color ?? '') ? f.color.toLowerCase() : FALLBACK_COLOR,
    finish,
    family: 'custom',
    custom: true,
  };
  if (Number.isFinite(f.pricePerKg) && f.pricePerKg > 0) out.pricePerKg = f.pricePerKg;
  return out;
}

/**
 * @param {object|null|undefined} project
 * @returns {Filament[]} normalized custom filaments of a project (ids must be non-empty)
 */
function customFilaments(project) {
  const list = project?.filaments?.custom;
  if (!Array.isArray(list)) return [];
  return list.filter((f) => f && f.id != null && f.id !== '').map(normalizeCustomFilament);
}

/**
 * All selectable filaments: the presets followed by the project's custom filaments.
 * A custom filament with the id of a preset replaces that preset in place.
 * @param {object} [project]
 * @returns {Filament[]}
 */
export function allFilaments(project) {
  const custom = customFilaments(project);
  if (custom.length === 0) return FILAMENTS.slice();
  const overrides = new Map(custom.map((f) => [f.id, f]));
  const out = FILAMENTS.map((f) => overrides.get(f.id) ?? f);
  for (const f of overrides.values()) if (!PRESETS_BY_ID.has(f.id)) out.push(f);
  return out;
}

/**
 * Resolves a filament id (custom filaments first, then presets). Unknown ids yield a neutral
 * grey placeholder flagged `missing: true` – never undefined.
 * @param {object|null|undefined} project
 * @param {string} id
 * @returns {Filament}
 */
export function getFilament(project, id) {
  const list = project?.filaments?.custom;
  if (Array.isArray(list)) {
    for (let i = list.length - 1; i >= 0; i--) {
      if (list[i] && list[i].id === id) return normalizeCustomFilament(list[i]);
    }
  }
  return PRESETS_BY_ID.get(id) ?? {
    id: String(id), name: 'Unknown filament', material: 'PLA', color: FALLBACK_COLOR,
    finish: 'basic', family: 'custom', missing: true,
  };
}
