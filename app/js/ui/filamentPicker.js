// Filament dropdown with a colour chip; owned filaments are listed first.

import { FILAMENT_FAMILIES, allFilaments, getFilament } from '../catalog/filaments.js';
import { h } from './dom.js';
import { fillSelect } from './controls.js';

/**
 * Option groups for a filament <select>: "My filaments" (owned) first, then colour families,
 * then custom filaments.
 * @param {object} project
 * @returns {Array<{group:string, options:Array<[string,string]>}>}
 */
export function filamentOptionGroups(project) {
  const owned = new Set(project.filaments.owned);
  const all = allFilaments(project);
  const label = (f) => `${f.name}${f.material && f.material !== 'PLA' ? ` · ${f.material}` : ''}`;
  const groups = [];
  const mine = all.filter((f) => owned.has(f.id));
  if (mine.length) groups.push({ group: 'My filaments', options: mine.map((f) => [f.id, label(f)]) });
  const families = new Map(Object.entries(FILAMENT_FAMILIES).map(([k, v]) => [k, { group: v, options: [] }]));
  const custom = { group: 'Custom', options: [] };
  for (const f of all) {
    if (owned.has(f.id)) continue;
    const target = f.custom ? custom : families.get(f.family) ?? custom;
    target.options.push([f.id, label(f)]);
  }
  for (const g of [...families.values(), custom]) if (g.options.length) groups.push(g);
  return groups;
}

/**
 * Creates a filament picker.
 * @param {{label:string, onChange:(id:string)=>void, testId?:string}} opts
 * @returns {{el:HTMLElement, update:(project:object, filamentId:string, disabled?:boolean)=>void, select:HTMLSelectElement}}
 */
export function createFilamentPicker({ label, onChange, testId }) {
  const chip = h('span', { class: 'chip-swatch', 'aria-hidden': 'true' });
  const select = /** @type {HTMLSelectElement} */ (h('select', { class: 'input select', 'aria-label': label, 'data-testid': testId }));
  select.addEventListener('change', () => onChange(select.value));
  let key = '';
  return {
    el: h('div', { class: 'filament-picker' }, chip, select),
    select,
    update(project, filamentId, disabled = false) {
      const groups = filamentOptionGroups(project);
      const missing = !groups.some((g) => g.options.some(([id]) => id === filamentId));
      if (missing) groups.push({ group: 'Unknown', options: [[filamentId, getFilament(project, filamentId).name]] });
      const nextKey = JSON.stringify(groups);
      if (nextKey !== key) {
        key = nextKey;
        fillSelect(select, groups);
      }
      select.value = filamentId;
      select.disabled = disabled;
      const f = getFilament(project, filamentId);
      chip.style.background = f.color;
      chip.dataset.finish = f.finish;
      chip.title = `${f.name} (${f.finish})`;
    },
  };
}
