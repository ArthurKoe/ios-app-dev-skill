// Filament materials (pure data): densities, typical street prices and print hints.

/**
 * @typedef {{
 *   id:string, name:string, densityGcm3:number, pricePerKg:number,
 *   minLayer:number,              // smallest sensible layer height, mm
 *   nozzleTempC:[number, number], bedTempC:[number, number],
 *   notes:string
 * }} Material
 */

/**
 * @param {string} id
 * @param {Omit<Material, 'id'>} fields
 * @returns {Material}
 */
function material(id, fields) {
  return Object.freeze({ id, ...fields });
}

/**
 * Materials keyed by id. Prices are typical EUR per kg for a 1 kg spool.
 * @type {Readonly<Record<string, Material>>}
 */
export const MATERIALS = Object.freeze({
  PLA: material('PLA', {
    name: 'PLA', densityGcm3: 1.24, pricePerKg: 20, minLayer: 0.08,
    nozzleTempC: [190, 220], bedTempC: [55, 65],
    notes: 'Easiest to print with crisp detail and the widest colour range – the default for indoor wall art.',
  }),
  'PLA-Matte': material('PLA-Matte', {
    name: 'PLA Matte', densityGcm3: 1.31, pricePerKg: 22, minLayer: 0.08,
    nozzleTempC: [200, 220], bedTempC: [55, 65],
    notes: 'Mineral-filled PLA that hides layer lines and looks like plaster or stone – ideal for relief maps.',
  }),
  'PLA-Silk': material('PLA-Silk', {
    name: 'PLA Silk', densityGcm3: 1.32, pricePerKg: 25, minLayer: 0.12,
    nozzleTempC: [205, 230], bedTempC: [55, 65],
    notes: 'Glossy metallic sheen that makes peaks shimmer under a spotlight; print a little slower for the best lustre.',
  }),
  'PLA-Marble': material('PLA-Marble', {
    name: 'PLA Marble', densityGcm3: 1.26, pricePerKg: 26, minLayer: 0.12,
    nozzleTempC: [200, 220], bedTempC: [55, 65],
    notes: 'Random dark speckles give a carved-stone look; every tile turns out slightly different.',
  }),
  'PLA-Wood': material('PLA-Wood', {
    name: 'PLA Wood', densityGcm3: 1.15, pricePerKg: 28, minLayer: 0.16,
    nozzleTempC: [190, 220], bedTempC: [50, 60],
    notes: 'Wood-fibre filled with a warm, matte grain; a 0.6 mm nozzle avoids clogs and suits terraced styles.',
  }),
  PETG: material('PETG', {
    name: 'PETG', densityGcm3: 1.27, pricePerKg: 20, minLayer: 0.1,
    nozzleTempC: [230, 250], bedTempC: [70, 85],
    notes: 'Tough and slightly glossy; translucent colours glow when backlit but it strings more than PLA.',
  }),
  ABS: material('ABS', {
    name: 'ABS', densityGcm3: 1.04, pricePerKg: 20, minLayer: 0.1,
    nozzleTempC: [240, 260], bedTempC: [90, 110],
    notes: 'Heat resistant and acetone-smoothable, but large flat tiles warp without an enclosure.',
  }),
  ASA: material('ASA', {
    name: 'ASA', densityGcm3: 1.07, pricePerKg: 25, minLayer: 0.1,
    nozzleTempC: [240, 260], bedTempC: [90, 110],
    notes: 'UV-stable for sunny walls or outdoor pieces; needs an enclosure to keep large tiles flat.',
  }),
});

/**
 * Looks up a material; unknown ids fall back to PLA (never undefined).
 * @param {string} id
 * @returns {Material}
 */
export function getMaterial(id) {
  return MATERIALS[id] ?? MATERIALS.PLA;
}
