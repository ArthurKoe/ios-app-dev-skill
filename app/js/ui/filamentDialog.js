// Filament library: mark the filaments you own and add custom ones.

import { FILAMENT_FAMILIES, FINISHES, allFilaments } from '../catalog/filaments.js';
import { MATERIALS } from '../catalog/materials.js';
import { createDialog } from './dialog.js';
import { h, replaceChildren } from './dom.js';
import { icon } from './icons.js';

/**
 * Creates the (lazily rendered) filament library dialog.
 * @param {{store:object, toast:object}} ctx
 * @returns {{open:()=>void}}
 */
export function createFilamentDialog({ store, toast }) {
  const filter = h('input', { type: 'search', class: 'input', placeholder: 'Filter filaments', 'aria-label': 'Filter filaments by name, colour, finish or material' });
  const ownedOnly = h('input', { type: 'checkbox' });
  const list = h('div', { class: 'filament-library', 'data-testid': 'filament-library' });
  const form = customForm(store, toast);
  const body = [
    h('p', { class: 'hint' }, 'Tick the filaments you have on your shelf – they are listed first in every colour picker and the estimate tells you what you still need to buy.'),
    h('div', { class: 'library-tools' }, filter, h('label', { class: 'check' }, ownedOnly, ' Only mine')),
    list,
    h('h3', { class: 'subhead' }, 'Add a custom filament'),
    form,
  ];
  const dialog = createDialog({
    title: 'Filament library', body, className: 'dialog-wide',
    footer: h('button', { type: 'button', class: 'btn btn-primary', onClick: () => dialog.close() }, 'Done'),
    onClose: () => unsubscribe?.(),
  });
  let unsubscribe = null;

  const render = () => {
    const activeKey = list.contains(document.activeElement) ? /** @type {HTMLElement} */ (document.activeElement).dataset.key : null;
    renderList();
    if (activeKey) /** @type {HTMLElement|null} */ (list.querySelector(`[data-key="${CSS.escape(activeKey)}"]`))?.focus();
  };
  const renderList = () => {
    const p = store.get();
    const q = filter.value.trim().toLowerCase();
    const owned = new Set(p.filaments.owned);
    const customIds = new Set(p.filaments.custom.map((f) => f.id));
    const items = allFilaments(p).filter((f) => (!ownedOnly.checked || owned.has(f.id))
      && (!q || `${f.name} ${f.material} ${f.finish} ${f.color}`.toLowerCase().includes(q)));
    const groups = new Map();
    for (const f of items) {
      const g = customIds.has(f.id) ? 'Custom' : FILAMENT_FAMILIES[f.family] ?? 'Other';
      if (!groups.has(g)) groups.set(g, []);
      groups.get(g).push(f);
    }
    if (!items.length) {
      replaceChildren(list, h('p', { class: 'hint' }, 'No filaments match.'));
      return;
    }
    replaceChildren(list, [...groups].map(([name, fils]) => h('section', { class: 'library-group' },
      h('h4', { class: 'library-group-title' }, name),
      h('ul', { class: 'library-list' }, fils.map((f) => h('li', { class: 'library-item' },
        h('label', { class: 'library-own' },
          h('input', {
            type: 'checkbox', checked: owned.has(f.id), 'aria-label': `I own ${f.name}`, 'data-key': f.id,
            onChange: (e) => store.set((d) => {
              const set = new Set(d.filaments.owned);
              if (e.target.checked) set.add(f.id);
              else set.delete(f.id);
              d.filaments.owned = [...set];
            }),
          }),
          h('span', { class: 'chip-swatch', style: { background: f.color }, 'data-finish': f.finish, 'aria-hidden': 'true' }),
          h('span', { class: 'library-name' }, f.name),
          h('span', { class: 'library-meta' }, `${f.material} · ${FINISHES[f.finish]?.label ?? f.finish}${f.pricePerKg ? ` · €${f.pricePerKg}/kg` : ''}`)),
        customIds.has(f.id) ? h('button', {
          type: 'button', class: 'icon-btn', 'aria-label': `Delete ${f.name}`,
          onClick: () => removeCustom(store, toast, f.id),
        }, icon('trash', { size: 16 })) : null))))));
  };
  filter.addEventListener('input', render);
  ownedOnly.addEventListener('change', render);

  return {
    open() {
      render();
      unsubscribe?.();
      unsubscribe = store.subscribe((p, prev, info) => {
        if (info.changes.keys.includes('filaments')) render();
      });
      dialog.open();
    },
  };
}

function customForm(store, toast) {
  const name = h('input', { type: 'text', class: 'input', required: true, maxlength: 60, placeholder: 'e.g. Glacier Mint', 'aria-label': 'Filament name' });
  const color = h('input', { type: 'color', class: 'color-input', value: '#7fb7a4', 'aria-label': 'Colour' });
  const material = h('select', { class: 'input select', 'aria-label': 'Material' },
    Object.values(MATERIALS).map((m) => h('option', { value: m.id }, m.name)));
  const finish = h('select', { class: 'input select', 'aria-label': 'Finish' },
    Object.entries(FINISHES).map(([id, f]) => h('option', { value: id }, f.label ?? id)));
  const price = h('input', { type: 'number', class: 'input input-number', min: 0, max: 1000, step: 0.5, placeholder: 'optional', 'aria-label': 'Price per kg in euro' });
  const form = h('form', { class: 'custom-filament-form' },
    h('label', { class: 'stack' }, h('span', null, 'Name'), name),
    h('label', { class: 'stack' }, h('span', null, 'Colour'), color),
    h('label', { class: 'stack' }, h('span', null, 'Material'), material),
    h('label', { class: 'stack' }, h('span', null, 'Finish'), finish),
    h('label', { class: 'stack' }, h('span', null, 'Price €/kg'), price),
    h('button', { type: 'submit', class: 'btn btn-primary' }, icon('plus', { size: 16 }), 'Add'));
  form.addEventListener('submit', (e) => {
    e.preventDefault();
    const label = name.value.trim();
    if (!label) {
      name.focus();
      return;
    }
    const id = `custom-${label.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 24) || 'filament'}-${Date.now().toString(36)}`;
    const pricePerKg = parseFloat(price.value);
    store.set((d) => {
      d.filaments.custom.push({
        id, name: label, color: color.value, material: material.value, finish: finish.value,
        ...(Number.isFinite(pricePerKg) ? { pricePerKg } : {}),
      });
      d.filaments.owned.push(id);
    });
    toast.success(`Added “${label}” to your filaments.`);
    form.reset();
    color.value = '#7fb7a4';
  });
  return form;
}

function removeCustom(store, toast, id) {
  const p = store.get();
  const inUse = p.colors.singleFilamentId === id || p.colors.bands.some((b) => b.filamentId === id);
  if (inUse) {
    toast.warn('This filament is used by your colour bands – pick another filament there first.');
    return;
  }
  store.set((d) => {
    d.filaments.custom = d.filaments.custom.filter((f) => f.id !== id);
    d.filaments.owned = d.filaments.owned.filter((x) => x !== id);
  });
}
