// Section 2 – Printer & tiles: printer preset / custom bed, tile size, columns × rows.

import { CUSTOM_PRINTER_ID, getPrinter, printerGroups } from '../catalog/printers.js';
import { fitTileToBed, tileBedFit } from '../model/layout.js';
import { h, replaceChildren } from './dom.js';
import { group, hintBlock, numberField, selectField, stepperField, valueRow } from './controls.js';
import { formatMm, formatNumber, formatScale } from './format.js';
import { icon } from './icons.js';

/**
 * @param {{store:object, toast:object}} ctx
 * @returns {{el:HTMLElement, sync:(p:object, rt:object)=>void}}
 */
export function createPrinterSection({ store, toast }) {
  const printer = selectField({
    label: 'Printer', testId: 'printer',
    options: printerGroups().map((g) => ({ group: g.group, options: g.printers.map((pr) => [pr.id, pr.name]) })),
    get: (p) => p.printer.presetId,
    set: (id) => selectPrinter(store, toast, id),
  });
  const isCustom = (p) => p.printer.presetId === CUSTOM_PRINTER_ID;
  const bed = group([
    numberField({ label: 'Bed width', unit: 'mm', step: 1, min: 40, max: 1000, digits: 1,
      get: (p) => p.printer.bedW, set: (v) => store.set({ printer: { bedW: v } }) }),
    numberField({ label: 'Bed depth', unit: 'mm', step: 1, min: 40, max: 1000, digits: 1,
      get: (p) => p.printer.bedH, set: (v) => store.set({ printer: { bedH: v } }) }),
    numberField({ label: 'Max height', unit: 'mm', step: 1, min: 10, max: 1000, digits: 0,
      get: (p) => p.printer.maxZ, set: (v) => store.set({ printer: { maxZ: v } }) }),
  ], { class: 'field-trio', visible: isCustom });
  const bedInfo = valueRow({
    label: 'Build volume', visible: (p) => !isCustom(p),
    get: (p) => `${formatNumber(p.printer.bedW, 0)} × ${formatNumber(p.printer.bedH, 0)} × ${formatNumber(p.printer.maxZ, 0)} mm`,
  });

  const maxBtn = h('button', {
    type: 'button', class: 'btn btn-small btn-ghost', 'data-testid': 'tile-max',
    onClick: () => {
      const { tileW, tileH } = fitTileToBed(store.get().printer);
      store.set({ layout: { tileW, tileH } });
    },
  }, 'Max for bed');
  const tileSize = group([
    numberField({ label: 'Tile width', unit: 'mm', step: 1, min: 20, max: 1000, digits: 1, testId: 'tile-w',
      get: (p) => p.layout.tileW, set: (v) => store.set({ layout: { tileW: v } }) }),
    numberField({ label: 'Tile height', unit: 'mm', step: 1, min: 20, max: 1000, digits: 1, testId: 'tile-h',
      get: (p) => p.layout.tileH, set: (v) => store.set({ layout: { tileH: v } }) }),
  ], { class: 'field-pair' });
  const grid = group([
    stepperField({ label: 'Columns', min: 1, max: 8, testId: 'cols', get: (p) => p.layout.cols, set: (v) => store.set({ layout: { cols: v } }) }),
    stepperField({ label: 'Rows', min: 1, max: 8, testId: 'rows', get: (p) => p.layout.rows, set: (v) => store.set({ layout: { rows: v } }) }),
  ], { class: 'field-pair' });

  const diagram = tileDiagram();
  const size = valueRow({ label: 'Artwork size', testId: 'art-size',
    get: (p, rt) => `${formatMm(rt.layout.artW, { cm: true })} × ${formatMm(rt.layout.artH, { cm: true })}` });
  const scale = valueRow({ label: 'Map scale', testId: 'art-scale',
    get: (p, rt) => `${formatScale(rt.layout.scaleDenominator)} · 1 mm = ${formatNumber(rt.layout.scaleMPerMm, 0)} m` });
  const warnings = warningList();
  const seamHint = hintBlock('Tiles share their edges exactly, so the relief continues seamlessly across the joints. '
    + 'Keep ~5 mm free around each tile on the bed for the brim and skirt.');

  const controls = [printer, bed, bedInfo, tileSize, grid, diagram, size, scale, warnings, seamHint];
  const el = h('div', { class: 'section-printer' },
    printer.el, bed.el, bedInfo.el,
    h('div', { class: 'subhead-row' }, h('h3', { class: 'subhead' }, 'Tiles'), maxBtn),
    tileSize.el, grid.el, diagram.el, size.el, scale.el, warnings.el, seamHint.el);
  return {
    el,
    sync(p, rt) {
      for (const c of controls) c.sync(p, rt);
    },
  };
}

/** Applies a printer preset; shrinks the tiles when they no longer fit the new bed. */
function selectPrinter(store, toast, id) {
  const preset = getPrinter(id);
  const current = store.get();
  const printer = id === CUSTOM_PRINTER_ID
    ? { presetId: id }
    : { presetId: id, bedW: preset.bedW, bedH: preset.bedH, maxZ: preset.maxZ, nozzleMm: preset.nozzleMm ?? 0.4 };
  const bed = { ...current.printer, ...printer };
  const patch = { printer };
  if (!tileBedFit(bed, current.layout.tileW, current.layout.tileH).fitsBed) {
    patch.layout = fitTileToBed(bed);
    toast.info(`Tiles resized to ${patch.layout.tileW} mm so they fit the ${preset.name} bed.`);
  }
  store.set(patch);
}

/** Miniature of the tile grid with labels (proportional). */
function tileDiagram() {
  const el = h('div', { class: 'tile-diagram', 'aria-hidden': 'true' });
  let key = '';
  return {
    el,
    sync(p, rt) {
      const { cols, rows, tileW, tileH } = rt.layout;
      const next = `${cols}x${rows}:${tileW}x${tileH}`;
      if (next === key) return;
      key = next;
      el.style.setProperty('--cols', String(cols));
      el.style.aspectRatio = `${cols * tileW} / ${rows * tileH}`;
      const cells = [];
      for (let r = 0; r < rows; r++) {
        for (let c = 0; c < cols; c++) cells.push(h('span', { class: 'tile-cell' }, String.fromCharCode(65 + r) + (c + 1)));
      }
      replaceChildren(el, cells);
    },
  };
}

function warningList() {
  const el = h('ul', { class: 'warning-list', 'data-testid': 'layout-warnings' });
  let key = '';
  return {
    el,
    sync(p, rt) {
      const list = rt.layout.warnings ?? [];
      const tall = rt.zmap && rt.zmap.maxZMm > p.printer.maxZ
        ? [`The relief is ${formatNumber(rt.zmap.maxZMm, 1)} mm tall – more than the printer's ${formatNumber(p.printer.maxZ, 0)} mm build height. `
          + `Lower the ${p.relief.autoExaggeration ? 'target relief' : 'exaggeration'} under Relief.`]
        : [];
      const all = [...list, ...tall];
      const next = all.join('|');
      if (next === key) return;
      key = next;
      el.hidden = all.length === 0;
      replaceChildren(el, all.map((w) => h('li', null, icon('warning', { size: 16 }), h('span', null, w))));
    },
  };
}
