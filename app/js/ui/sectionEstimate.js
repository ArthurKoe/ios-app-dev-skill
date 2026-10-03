// Section 7 – Estimate: filament per colour, totals, per-tile numbers and print settings.

import { h, replaceChildren } from './dom.js';
import { hintBlock, rangeField, segmentedField, stepperField } from './controls.js';
import { formatDuration, formatGrams, formatMetres, formatMm, formatMoney, formatNumber } from './format.js';

/**
 * @param {{store:object}} ctx
 * @returns {{el:HTMLElement, sync:(p:object, rt:object)=>void}}
 */
export function createEstimateSection({ store }) {
  const totals = h('div', { class: 'estimate-totals', 'data-testid': 'estimate-totals' });
  const filaments = h('div', { class: 'table-wrap' });
  const tiles = h('details', { class: 'tile-details' });
  const notOwned = h('p', { class: 'hint-block hint-warn', hidden: true });
  const print = (patch) => store.set({ print: patch });
  const settings = [
    rangeField({ label: 'Infill', unit: '%', min: 0, max: 100, step: 5, digits: 0, testId: 'infill',
      hint: '10–15 % is plenty: relief tiles are mostly top surface and walls.',
      get: (p) => p.print.infillPct, set: (v) => print({ infillPct: v }) }),
    stepperField({ label: 'Walls', min: 1, max: 12, get: (p) => p.print.walls, set: (v) => print({ walls: v }) }),
    segmentedField({ label: 'Print speed', compact: true, options: [['slow', 'Slow'], ['standard', 'Standard'], ['fast', 'Fast']],
      get: (p) => p.print.speedClass, set: (v) => print({ speedClass: v }) }),
  ];
  const model = hintBlock('Estimated from the preview surface with your infill, walls and top/bottom layers, plus time for layer changes and 3 min per manual colour change. Real slicer numbers typically land within ±15 %.');
  const el = h('div', { class: 'section-estimate' }, totals, filaments, notOwned, tiles,
    h('h3', { class: 'subhead' }, 'Print settings'), settings.map((c) => c.el), model.el);
  let key = '';

  return {
    el,
    sync(p, rt) {
      for (const c of settings) c.sync(p, rt);
      model.sync(p, rt);
      const est = rt.estimate;
      const nextKey = est ? JSON.stringify([est.grams, est.minutes, est.cost, est.byFilament, est.tiles?.map((t) => [t.grams, t.minutes, t.maxZ]), est.notOwned]) : '';
      if (nextKey === key) return;
      key = nextKey;
      if (!est) {
        replaceChildren(totals, h('p', { class: 'hint' }, 'Waiting for the preview…'));
        replaceChildren(filaments);
        tiles.hidden = true;
        return;
      }
      renderTotals(totals, est);
      renderFilaments(filaments, est);
      renderTiles(tiles, est);
      const missing = est.notOwned ?? [];
      notOwned.hidden = missing.length === 0;
      if (missing.length) {
        const names = est.byFilament.filter((f) => missing.includes(f.filamentId)).map((f) => f.name);
        notOwned.textContent = `Not in your library yet: ${names.join(', ')}.`;
      }
    },
  };
}

function stat(label, value, testId) {
  return h('div', { class: 'stat' }, h('span', { class: 'stat-value', 'data-testid': testId }, value), h('span', { class: 'stat-label' }, label));
}

function renderTotals(el, est) {
  replaceChildren(el,
    stat('filament', formatGrams(est.grams), 'estimate-grams'),
    stat('print time', formatDuration(est.minutes), 'estimate-time'),
    stat('material cost', formatMoney(est.cost), 'estimate-cost'),
    stat('colour changes', formatNumber(est.colorChanges ?? 0, 0), 'estimate-changes'));
}

function renderFilaments(el, est) {
  const rows = est.byFilament.map((f) => h('tr', null,
    h('td', null, h('span', { class: 'chip-swatch', style: { background: f.color }, 'data-finish': f.finish, 'aria-hidden': 'true' }), ' ', f.name),
    h('td', { class: 'num' }, formatGrams(f.grams)),
    h('td', { class: 'num' }, formatMetres(f.metres)),
    h('td', { class: 'num' }, formatNumber(f.spools, 0)),
    h('td', { class: 'num' }, formatMoney(f.cost))));
  replaceChildren(el, h('table', { class: 'data-table', 'data-testid': 'estimate-filaments' },
    h('caption', { class: 'visually-hidden' }, 'Filament per colour'),
    h('thead', null, h('tr', null, h('th', { scope: 'col' }, 'Filament'), h('th', { scope: 'col', class: 'num' }, 'Weight'),
      h('th', { scope: 'col', class: 'num' }, 'Length'), h('th', { scope: 'col', class: 'num', title: '1 kg spools' }, 'Spools'),
      h('th', { scope: 'col', class: 'num' }, 'Cost'))),
    h('tbody', null, rows),
    h('tfoot', null, h('tr', null, h('th', { scope: 'row' }, 'Total'), h('td', { class: 'num' }, formatGrams(est.grams)),
      h('td', { class: 'num' }, formatMetres(est.metres)), h('td', { class: 'num' }, formatNumber(est.spools, 0)),
      h('td', { class: 'num' }, formatMoney(est.cost))))));
}

function renderTiles(el, est) {
  el.hidden = false;
  const list = est.tiles ?? [];
  const longest = list.reduce((m, t) => Math.max(m, t.minutes ?? 0), 0);
  replaceChildren(el,
    h('summary', null, `Per tile (${list.length}) · longest ${formatDuration(longest)}`),
    h('div', { class: 'table-wrap' }, h('table', { class: 'data-table', 'data-testid': 'estimate-tiles' },
      h('thead', null, h('tr', null, h('th', { scope: 'col' }, 'Tile'), h('th', { scope: 'col', class: 'num' }, 'Height'),
        h('th', { scope: 'col', class: 'num' }, 'Filament'), h('th', { scope: 'col', class: 'num' }, 'Time'))),
      h('tbody', null, list.map((t) => h('tr', null,
        h('th', { scope: 'row' }, t.label),
        h('td', { class: 'num' }, formatMm(t.maxZ, { digits: 1 })),
        h('td', { class: 'num' }, formatGrams(t.grams)),
        h('td', { class: 'num' }, formatDuration(t.minutes))))))));
}
