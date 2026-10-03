// Printer presets (pure data). Build volumes are the manufacturers' published print
// volumes in millimetres (width × depth × height).

/**
 * @typedef {{
 *   id:string, name:string, brand:string, group:string,
 *   bedW:number, bedH:number, maxZ:number, nozzleMm:number
 * }} PrinterPreset
 */

/** Id of the preset used by a new project. */
export const DEFAULT_PRINTER_ID = 'bambu-x1';

/** Id of the free-form entry whose bed size the user types in. */
export const CUSTOM_PRINTER_ID = 'custom';

/**
 * @param {string} brand
 * @param {string} id
 * @param {string} name
 * @param {number} bedW
 * @param {number} bedH
 * @param {number} maxZ
 * @returns {PrinterPreset}
 */
function preset(brand, id, name, bedW, bedH, maxZ) {
  return Object.freeze({ id, name, brand, group: brand, bedW, bedH, maxZ, nozzleMm: 0.4 });
}

/**
 * Current FDM printers, grouped by brand (the `group` drives the dropdown's optgroups).
 * The last entry is the 'custom' printer.
 * @type {ReadonlyArray<PrinterPreset>}
 */
export const PRINTERS = Object.freeze([
  preset('Bambu Lab', 'bambu-x1', 'X1 / X1 Carbon', 256, 256, 256),
  preset('Bambu Lab', 'bambu-p1s', 'P1S', 256, 256, 256),
  preset('Bambu Lab', 'bambu-p1p', 'P1P', 256, 256, 256),
  preset('Bambu Lab', 'bambu-p2s', 'P2S', 256, 256, 256),
  preset('Bambu Lab', 'bambu-a1', 'A1', 256, 256, 256),
  preset('Bambu Lab', 'bambu-a1-mini', 'A1 mini', 180, 180, 180),
  preset('Bambu Lab', 'bambu-h2d', 'H2D', 350, 320, 325),
  preset('Bambu Lab', 'bambu-h2s', 'H2S', 340, 320, 340),

  preset('Prusa Research', 'prusa-mk4s', 'MK4 / MK4S', 250, 210, 220),
  preset('Prusa Research', 'prusa-mk3s', 'MK3S+', 250, 210, 210),
  preset('Prusa Research', 'prusa-core-one', 'CORE One', 250, 220, 270),
  preset('Prusa Research', 'prusa-mini', 'MINI+', 180, 180, 180),
  preset('Prusa Research', 'prusa-xl', 'XL', 360, 360, 360),

  preset('Creality', 'creality-ender3-v3', 'Ender-3 V3', 220, 220, 250),
  preset('Creality', 'creality-ender3-v3-se', 'Ender-3 V3 SE', 220, 220, 250),
  preset('Creality', 'creality-k1', 'K1 / K1C', 220, 220, 250),
  preset('Creality', 'creality-k1-max', 'K1 Max', 300, 300, 300),
  preset('Creality', 'creality-k2-plus', 'K2 Plus', 350, 350, 350),

  preset('Elegoo', 'elegoo-neptune4-pro', 'Neptune 4 Pro', 225, 225, 265),
  preset('Elegoo', 'elegoo-centauri-carbon', 'Centauri Carbon', 256, 256, 256),

  preset('Anycubic', 'anycubic-kobra3', 'Kobra 3', 250, 250, 260),
  preset('Anycubic', 'anycubic-kobra-s1', 'Kobra S1', 250, 250, 250),

  preset('Qidi', 'qidi-q1-pro', 'Q1 Pro', 245, 245, 240),
  preset('Qidi', 'qidi-plus4', 'Plus4', 305, 305, 280),

  preset('Sovol', 'sovol-sv08', 'SV08', 350, 350, 345),

  preset('Voron', 'voron-24-300', 'Voron 2.4 (300)', 300, 300, 300),
  preset('Voron', 'voron-24-350', 'Voron 2.4 (350)', 350, 350, 350),

  preset('Other', CUSTOM_PRINTER_ID, 'Custom printer…', 220, 220, 250),
]);

const BY_ID = new Map(PRINTERS.map((p) => [p.id, p]));

/**
 * Looks up a printer preset. Unknown ids resolve to the 'custom' entry (never undefined).
 * @param {string} id
 * @returns {PrinterPreset}
 */
export function getPrinter(id) {
  return BY_ID.get(id) ?? BY_ID.get(CUSTOM_PRINTER_ID);
}

/**
 * Display label including the brand, e.g. "Bambu Lab A1 mini".
 * @param {PrinterPreset} printer
 * @returns {string}
 */
export function printerLabel(printer) {
  return printer.id === CUSTOM_PRINTER_ID ? printer.name : `${printer.brand} ${printer.name}`;
}

/**
 * Printers grouped for a `<select>` with optgroups, in catalogue order.
 * @returns {Array<{group:string, printers:PrinterPreset[]}>}
 */
export function printerGroups() {
  /** @type {Map<string, PrinterPreset[]>} */
  const groups = new Map();
  for (const p of PRINTERS) {
    if (!groups.has(p.group)) groups.set(p.group, []);
    groups.get(p.group).push(p);
  }
  return [...groups].map(([group, printers]) => ({ group, printers }));
}
