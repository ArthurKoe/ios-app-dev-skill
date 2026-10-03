// Status bar: data source, scale, artwork size, tiles, relief height, filament and print time at a glance.

import { h } from './dom.js';
import { icon } from './icons.js';
import { formatDuration, formatGrams, formatMm, formatNumber, formatScale } from './format.js';

/**
 * Builds the status bar into `container`.
 * @param {HTMLElement} container
 * @returns {{update:(project:object, rt:object)=>void}}
 */
export function createStatusBar(container) {
  const items = {
    data: item('Data', 'status-data'),
    scale: item('Scale', 'status-scale'),
    size: item('Artwork', 'status-size'),
    tiles: item('Tiles', 'status-tiles'),
    height: item('Height', 'status-height'),
    filament: item('Filament', 'status-filament'),
    time: item('Print time', 'status-time'),
  };
  const warnIcon = icon('warning', { size: 14 });
  warnIcon.classList.add('status-warn-icon');
  items.height.el.prepend(warnIcon);
  const state = h('span', { class: 'status-state', 'data-testid': 'status-state', role: 'status' });
  container.replaceChildren(state, ...Object.values(items).map((i) => i.el));

  return {
    update(project, rt) {
      const layout = rt.layout;
      const stats = rt.preview?.stats;
      const est = rt.estimate;
      const zmap = rt.zmap;
      set(items.data, stats ? dataLabel(stats) : '…',
        stats ? `Elevation data of the preview: ${stats.source === 'live' ? 'live AWS Terrain Tiles' : stats.levelLabel}`
          + `${stats.missingFraction > 0 ? ` (${(stats.missingFraction * 100).toFixed(1)} % without data)` : ''}` : '');
      set(items.scale, layout ? formatScale(layout.scaleDenominator) : '–',
        layout ? `1 mm on the print = ${formatNumber(layout.scaleMPerMm, 0)} m on the ground` : '');
      set(items.size, layout ? `${formatMm(layout.artW, { cm: true })} × ${formatMm(layout.artH, { cm: true })}` : '–');
      set(items.tiles, layout ? `${layout.cols} × ${layout.rows} · ${formatMm(layout.tileW, { digits: 0 })}${layout.tileW === layout.tileH ? '' : ` × ${formatMm(layout.tileH, { digits: 0 })}`}` : '–');
      const tooTall = Boolean(zmap) && zmap.maxZMm > project.printer.maxZ + 1e-6;
      set(items.height, zmap ? `${formatMm(zmap.maxZMm, { digits: 1 })} · ${formatNumber(zmap.exaggeration, 1)}×` : '–',
        zmap ? (tooTall
          ? `The tallest point (${formatMm(zmap.maxZMm, { digits: 1 })}) is higher than the printer's ${formatNumber(project.printer.maxZ, 0)} mm build height – lower the exaggeration or the target relief.`
          : `Tallest point incl. the ${formatMm(zmap.baseMm, { digits: 1 })} base, at ${formatNumber(zmap.exaggeration, 1)}× vertical exaggeration${project.relief.autoExaggeration ? ' (automatic)' : ''}`) : '');
      items.height.el.classList.toggle('is-warn', tooTall);
      set(items.filament, est ? formatGrams(est.grams) : '–');
      set(items.time, est ? formatDuration(est.minutes) : '–', est ? 'Total for all tiles, one after the other' : '');
      const text = rt.exporting ? 'Exporting…' : rt.busy ? 'Updating…' : rt.error ? 'Preview failed' : rt.preview ? 'Ready' : 'Starting…';
      if (state.textContent !== text) state.textContent = text;
      state.dataset.state = rt.busy || rt.exporting ? 'busy' : rt.error ? 'error' : 'ready';
    },
  };
}

/**
 * Short data-source label: "Copernicus 32 m", "Live · ~38 m".
 * @param {{source:string, levelLabel?:string, pixelSizeM?:number}} stats
 * @returns {string}
 */
function dataLabel(stats) {
  const px = Number.isFinite(stats.pixelSizeM) ? `${formatNumber(stats.pixelSizeM, 0)} m` : '';
  if (stats.source === 'live') return `Live terrain tiles${px ? ` · ~${px}` : ''}`;
  return `Copernicus${px ? ` · ${px}` : ''}`;
}

function item(label, testId) {
  const value = h('span', { class: 'status-value', 'data-testid': testId });
  const el = h('span', { class: 'status-item', 'data-key': testId.replace('status-', '') }, h('span', { class: 'status-label' }, label), value);
  return { el, value };
}

function set(it, text, title = '') {
  if (it.value.textContent !== text) it.value.textContent = text;
  if (title) it.el.title = title;
  else it.el.removeAttribute('title');
}
