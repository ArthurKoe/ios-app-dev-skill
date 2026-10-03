// Section 4 – Art style: style cards, parameters generated from the registry, border rim.

import { ART_STYLES, getArtStyle, isParamVisible, styleParams } from '../catalog/artStyles.js';
import { h, replaceChildren } from './dom.js';
import { group, hintBlock, numberField, rangeField, selectField, toggleField } from './controls.js';

/**
 * @param {{store:object}} ctx
 * @returns {{el:HTMLElement, sync:(p:object, rt:object)=>void}}
 */
export function createStyleSection({ store }) {
  // Remembers tweaked parameters per style for this session, so switching back restores them.
  const memory = new Map();
  const cards = ART_STYLES.map((style) => {
    const card = h('button', {
      type: 'button', class: 'style-card', 'data-style': style.id, 'aria-pressed': 'false', 'data-testid': `style-${style.id}`,
      onClick: () => {
        const p = store.get();
        if (p.style.id === style.id) return;
        memory.set(p.style.id, p.style.params);
        store.set({ style: { id: style.id, params: memory.get(style.id) ?? {} } });
      },
    },
    h('span', { class: 'style-icon', html: style.icon }),
    h('span', { class: 'style-name' }, style.name),
    h('span', { class: 'style-desc' }, style.description));
    return { style, card };
  });
  const grid = h('div', { class: 'style-grid', role: 'group', 'aria-label': 'Art style' }, cards.map((c) => c.card));

  const params = h('div', { class: 'style-params' });
  let paramControls = [];
  let paramsFor = null;

  const lithoHint = hintBlock('Print a lithophane in white (or natural) PLA and hang it in front of a light: thin areas glow, thick areas stay dark. Colour bands are ignored.', {
    visible: (p) => p.style.id === 'lithophane',
  });
  const border = group([
    toggleField({ label: 'Border rim', testId: 'border',
      hint: 'A raised frame around the whole artwork (it only appears on the outer tile edges).',
      get: (p) => p.border.enabled, set: (v) => store.set({ border: { enabled: v } }) }),
    group([
      numberField({ label: 'Rim width', unit: 'mm', step: 0.5, min: 1, max: 40, digits: 1,
        get: (p) => p.border.widthMm, set: (v) => store.set({ border: { widthMm: v } }) }),
      numberField({ label: 'Rim height', unit: 'mm', step: 0.5, min: 0, max: 30, digits: 1,
        hint: 'Above the base.',
        get: (p) => p.border.heightMm, set: (v) => store.set({ border: { heightMm: v } }) }),
    ], { class: 'field-pair', visible: (p) => p.border.enabled }),
  ]);

  const el = h('div', { class: 'section-style' }, grid, params, lithoHint.el, h('h3', { class: 'subhead' }, 'Frame'), border.el);
  return {
    el,
    sync(p, rt) {
      for (const { style, card } of cards) {
        const on = style.id === p.style.id;
        card.setAttribute('aria-pressed', String(on));
        card.classList.toggle('is-selected', on);
      }
      if (paramsFor !== p.style.id) {
        paramsFor = p.style.id;
        paramControls = getArtStyle(p.style.id).params.map((def) => paramControl(def, store));
        replaceChildren(params, paramControls.map((c) => c.el));
      }
      for (const c of paramControls) c.sync(p, rt);
      lithoHint.sync(p, rt);
      border.sync(p, rt);
    },
  };
}

/** Control for one style parameter definition (range | number | select | checkbox, showIf). */
function paramControl(def, store) {
  const get = (p) => styleParams(p)[def.key];
  const set = (v) => store.set((d) => {
    d.style.params[def.key] = v;
  });
  const visible = (p) => isParamVisible(def, styleParams(p));
  const common = { label: def.label, hint: def.help, get, set, visible, testId: `param-${def.key}` };
  switch (def.type) {
    case 'checkbox':
      return toggleField(common);
    case 'select':
      return selectField({ ...common, options: def.options });
    case 'number':
      return numberField({ ...common, min: def.min, max: def.max, step: def.step, unit: def.unit, digits: decimals(def.step) });
    default:
      return rangeField({ ...common, min: def.min, max: def.max, step: def.step, unit: def.unit, digits: decimals(def.step) });
  }
}

function decimals(step) {
  const s = String(step ?? 1);
  return s.includes('.') ? s.split('.')[1].length : 0;
}
