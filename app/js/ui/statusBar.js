// Status bar: data source, scale, artwork size, tiles, filament and print time at a glance.

import { h } from './dom.js';
import { formatDuration, formatGrams, formatMm, formatScale } from './format.js';

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
    filament: item('Filament', 'status-filament'),
    time: item('Print time', 'status-time'),
  };
  const state = h('span', { class: 'status-state', 'data-testid': 'status-state' });
  container.replaceChildren(state, ...Object.values(items).map((i) => i.el));

  return {
    update(project, rt) {
      const layout = rt.layout;
      const stats = rt.preview?.stats;
      const est = rt.estimate;
      set(items.data, stats ? `${stats.source === 'live' ? 'Live · ' : ''}${stats.levelLabel}` : '…',
        stats ? `Elevation data used for the preview${stats.missingFraction > 0 ? ` (${(stats.missingFraction * 100).toFixed(1)} % without data)` : ''}` : '');
      set(items.scale, layout ? formatScale(layout.scaleDenominator) : '–');
      set(items.size, layout ? `${formatMm(layout.artW, { cm: true })} × ${formatMm(layout.artH, { cm: true })}` : '–');
      set(items.tiles, layout ? `${layout.cols} × ${layout.rows} · ${formatMm(layout.tileW, { digits: 0 })}${layout.tileW === layout.tileH ? '' : ` × ${formatMm(layout.tileH, { digits: 0 })}`}` : '–');
      set(items.filament, est ? formatGrams(est.grams) : '–');
      set(items.time, est ? formatDuration(est.minutes) : '–');
      const text = rt.exporting ? 'Exporting…' : rt.busy ? 'Updating…' : rt.error ? 'Preview failed' : rt.preview ? 'Ready' : 'Starting…';
      if (state.textContent !== text) state.textContent = text;
      state.dataset.state = rt.busy || rt.exporting ? 'busy' : rt.error ? 'error' : 'ready';
    },
  };
}

function item(label, testId) {
  const value = h('span', { class: 'status-value', 'data-testid': testId });
  const el = h('span', { class: 'status-item' }, h('span', { class: 'status-label' }, label), value);
  return { el, value };
}

function set(it, text, title = '') {
  if (it.value.textContent !== text) it.value.textContent = text;
  if (title) it.el.title = title;
  else it.el.removeAttribute('title');
}
