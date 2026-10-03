// Colour band editor: which filament prints which elevation range, with the resulting
// colour-change heights (Z / layer) – identical for every tile.

import { effectiveBandSpecs, resolveBands } from '../catalog/bands.js';
import { getTheme } from '../catalog/themes.js';
import { LIMITS } from '../state/store.js';
import { h, replaceChildren } from './dom.js';
import { icon } from './icons.js';
import { createFilamentPicker } from './filamentPicker.js';
import { toggleField } from './controls.js';

/**
 * Text describing where a band starts on the print.
 * @param {object|undefined} band resolved band (or undefined when it was merged away)
 * @param {number} index spec index
 * @returns {{text:string, state:'base'|'ok'|'unused'|'merged'}}
 */
export function bandInfo(band, index) {
  if (!band) return { text: 'merged – too close to the next band', state: 'merged' };
  if (index === 0 || band.zFrom === 0) return { text: 'from the build plate', state: 'base' };
  if (band.unused) return { text: `Z ${band.zFrom.toFixed(2)} mm · above the highest summit`, state: 'unused' };
  return { text: `Z ${band.zFrom.toFixed(2)} mm · layer ${band.layerFrom}`, state: 'ok' };
}

/**
 * @param {{store:object}} ctx
 * @returns {{el:HTMLElement, sync:(p:object, rt:object)=>void}}
 */
export function createBandEditor({ store }) {
  const autoFit = toggleField({
    label: 'Fit bands to the terrain', testId: 'band-autofit',
    hint: 'Keeps the theme\'s proportions when the frame or exaggeration changes. Editing a threshold switches this off.',
    get: (p) => p.colors.autoFit, set: (v) => store.set({ colors: { autoFit: v } }),
    disabled: (p) => !getTheme(p.colors.themeId),
  });
  const list = h('ol', { class: 'band-list', 'data-testid': 'band-list' });
  const addBtn = h('button', { type: 'button', class: 'btn btn-small btn-ghost', 'data-testid': 'band-add' }, icon('plus', { size: 16 }), 'Add colour');
  const el = h('div', { class: 'band-editor' }, autoFit.el, list, addBtn);
  let state = { specs: [], resolved: [], zmap: null };
  let renderedKey = '';
  let deferred = null;

  /** Writes edited specs: turns autoFit off and copies the effective bands into the project. */
  const commit = (specs) => store.set((d) => {
    d.colors.bands = specs;
    d.colors.autoFit = false;
    d.colors.mode = 'bands';
  });

  addBtn.addEventListener('click', () => {
    const { specs, zmap } = state;
    if (specs.length >= LIMITS.maxBands) return;
    const last = specs[specs.length - 1];
    const lastFrom = last?.fromM ?? zmap?.floorM ?? 0;
    const top = zmap?.maxElevM ?? lastFrom + 1000;
    const fromM = Math.round(((lastFrom + Math.max(top, lastFrom + 100)) / 2) / 10) * 10;
    const used = new Set(specs.map((s) => s.filamentId));
    const owned = store.get().filaments.owned.find((id) => !used.has(id));
    commit([...specs, { filamentId: owned ?? 'pla-snow-white', fromM }]);
  });

  el.addEventListener('focusout', () => {
    // Re-render that was postponed while the user was typing a threshold.
    if (deferred) setTimeout(() => {
      if (deferred && !el.contains(document.activeElement)) {
        const args = deferred;
        deferred = null;
        render(...args);
      }
    }, 0);
  });

  function row(spec, i, band, p) {
    const picker = createFilamentPicker({
      label: `Filament of band ${i + 1}`,
      onChange: (id) => commit(state.specs.map((s, j) => (j === i ? { ...s, filamentId: id } : s))),
    });
    picker.update(p, spec.filamentId);
    picker.select.dataset.key = `filament-${i}`;
    const threshold = i === 0
      ? h('span', { class: 'band-from band-bottom' }, 'Bottom')
      : h('label', { class: 'band-from' },
        h('span', { class: 'visually-hidden' }, `Band ${i + 1} starts at elevation`),
        h('input', {
          type: 'number', class: 'input input-number input-compact', step: 50, value: String(spec.fromM ?? ''),
          'data-testid': `band-from-${i}`, 'data-key': `from-${i}`, 'data-committed': String(spec.fromM ?? ''),
          onChange: (e) => {
            const v = parseFloat(e.target.value);
            if (!Number.isFinite(v)) return;
            e.target.dataset.committed = e.target.value;
            commit(state.specs.map((s, j) => (j === i ? { ...s, fromM: v } : s)));
          },
        }),
        h('span', { class: 'unit' }, 'm'));
    const info = bandInfo(band, i);
    const remove = h('button', {
      type: 'button', class: 'icon-btn', 'aria-label': `Remove band ${i + 1}`, disabled: state.specs.length <= 1,
      'data-key': `remove-${i}`,
      onClick: () => {
        const next = state.specs.filter((_, j) => j !== i);
        if (next.length) next[0] = { ...next[0], fromM: null };
        commit(next);
      },
    }, icon('trash', { size: 16 }));
    return h('li', { class: `band-row band-${info.state}` },
      h('div', { class: 'band-main' }, picker.el, threshold, remove),
      h('div', { class: 'band-info', 'data-testid': `band-info-${i}` }, info.text));
  }

  function render(p, specs, resolved) {
    // Keep keyboard focus on the same control across re-renders.
    const activeKey = list.contains(document.activeElement) ? /** @type {HTMLElement} */ (document.activeElement).dataset.key : null;
    const bySpec = new Map(resolved.map((b) => [b.specIndex, b]));
    replaceChildren(list, specs.map((spec, i) => row(spec, i, bySpec.get(i), p)));
    addBtn.disabled = specs.length >= LIMITS.maxBands;
    if (activeKey) /** @type {HTMLElement|null} */ (list.querySelector(`[data-key="${activeKey}"]`))?.focus();
  }

  return {
    el,
    sync(p, rt) {
      autoFit.sync(p, rt);
      const zmap = rt.zmap ?? null;
      const specs = effectiveBandSpecs(p, zmap);
      const resolved = resolveBands(p, zmap, specs);
      state = { specs, resolved, zmap };
      const key = JSON.stringify([specs, resolved.map((b) => [b.specIndex, b.zFrom, b.layerFrom, b.unused]), p.filaments]);
      if (key === renderedKey) return;
      renderedKey = key;
      // Do not throw away a threshold the user is still typing.
      const active = /** @type {HTMLInputElement|null} */ (document.activeElement);
      if (active?.tagName === 'INPUT' && list.contains(active) && active.value !== active.dataset.committed) {
        deferred = [p, specs, resolved];
        return;
      }
      deferred = null;
      render(p, specs, resolved);
    },
  };
}
