// Reusable form controls bound to the project. Every control returns {el, sync(project, runtime)}:
// `sync` refreshes the displayed value (skipping inputs the user is typing in), visibility and
// disabled state. Values are written through the `set` callback (usually store.set).

import { h, uid } from './dom.js';
import { icon } from './icons.js';

/**
 * @typedef {(project:object, runtime:object)=>any} Getter
 * @typedef {{el:HTMLElement, sync:(project:object, runtime:object)=>void}} Control
 * @typedef {{label:string, hint?:string|Node, get:Getter, set:(value:any)=>void,
 *            visible?:(project:object, runtime:object)=>boolean, disabled?:(project:object, runtime:object)=>boolean,
 *            testId?:string}} BaseOptions
 */

/**
 * Number input with optional unit; commits on change (Enter / blur), Escape reverts.
 * @param {BaseOptions & {min?:number, max?:number, step?:number, unit?:string, digits?:number, readOnly?:boolean}} o
 * @returns {Control}
 */
export function numberField(o) {
  const id = uid('num');
  const input = h('input', {
    id, type: 'number', inputmode: 'decimal', class: 'input input-number',
    min: o.min, max: o.max, step: o.step ?? 'any', readonly: o.readOnly, 'data-testid': o.testId,
    'aria-describedby': o.hint ? `${id}-hint` : null,
  });
  let current = null;
  input.addEventListener('change', () => {
    const v = parseFloat(input.value);
    if (Number.isFinite(v)) o.set(v);
    else input.value = display(current, o.digits);
  });
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      input.value = display(current, o.digits);
      input.blur();
    }
  });
  const el = fieldShell(o, id, h('div', { class: 'field-control' }, input, o.unit ? h('span', { class: 'unit' }, o.unit) : null));
  return {
    el,
    sync(p, rt) {
      if (!applyCommon(el, o, p, rt, [input])) return;
      current = o.get(p, rt);
      if (document.activeElement !== input) input.value = display(current, o.digits);
    },
  };
}

/**
 * Slider with a coupled number box. The slider writes continuously while dragging.
 * @param {BaseOptions & {min:number, max:number, step:number, unit?:string, digits?:number,
 *         inputMin?:number, inputMax?:number}} o inputMin/inputMax widen the number box beyond the slider
 * @returns {Control}
 */
export function rangeField(o) {
  const id = uid('rng');
  const slider = h('input', {
    id, type: 'range', class: 'slider', min: o.min, max: o.max, step: o.step,
    'aria-describedby': o.hint ? `${id}-hint` : null, 'data-testid': o.testId,
  });
  const box = h('input', {
    type: 'number', inputmode: 'decimal', class: 'input input-number input-compact',
    min: o.inputMin ?? o.min, max: o.inputMax ?? o.max, step: o.step, 'aria-label': `${o.label} value`,
  });
  let current = null;
  slider.addEventListener('input', () => o.set(parseFloat(slider.value)));
  box.addEventListener('change', () => {
    const v = parseFloat(box.value);
    if (Number.isFinite(v)) o.set(v);
    else box.value = display(current, o.digits);
  });
  const el = h('div', { class: 'field field-range' },
    h('div', { class: 'field-row' },
      h('label', { class: 'field-label', for: id }, o.label),
      h('div', { class: 'field-control' }, box, o.unit ? h('span', { class: 'unit' }, o.unit) : null)),
    slider,
    hintEl(o, id));
  return {
    el,
    sync(p, rt) {
      if (!applyCommon(el, o, p, rt, [slider, box])) return;
      current = o.get(p, rt);
      slider.value = String(current);
      updateSliderFill(slider);
      if (document.activeElement !== box) box.value = display(current, o.digits);
    },
  };
}

/**
 * Select box. `options` is a list of [value, label] pairs, a list of {group, options} or a function
 * of (project, runtime) returning either (re-rendered only when the option list changes).
 * @param {BaseOptions & {options:any}} o
 * @returns {Control}
 */
export function selectField(o) {
  const id = uid('sel');
  const select = h('select', { id, class: 'input select', 'aria-describedby': o.hint ? `${id}-hint` : null, 'data-testid': o.testId });
  select.addEventListener('change', () => o.set(select.value));
  let optionsKey = '';
  const el = fieldShell(o, id, h('div', { class: 'field-control' }, select));
  return {
    el,
    sync(p, rt) {
      if (!applyCommon(el, o, p, rt, [select])) return;
      const opts = typeof o.options === 'function' ? o.options(p, rt) : o.options;
      const key = JSON.stringify(opts);
      if (key !== optionsKey) {
        optionsKey = key;
        fillSelect(select, opts);
      }
      select.value = String(o.get(p, rt));
    },
  };
}

/**
 * Fills a <select> with [value,label] pairs or {group, options} groups.
 * @param {HTMLSelectElement} select
 * @param {Array<[string,string]|{group:string, options:Array<[string,string]>}>} opts
 */
export function fillSelect(select, opts) {
  select.replaceChildren(...opts.map((o) => (Array.isArray(o)
    ? h('option', { value: o[0] }, o[1])
    : h('optgroup', { label: o.group }, ...o.options.map(([v, l]) => h('option', { value: v }, l))))));
}

/**
 * On/off switch (checkbox).
 * @param {BaseOptions} o
 * @returns {Control}
 */
export function toggleField(o) {
  const id = uid('tgl');
  const input = h('input', {
    id, type: 'checkbox', class: 'switch-input', role: 'switch',
    'aria-describedby': o.hint ? `${id}-hint` : null, 'data-testid': o.testId,
  });
  input.addEventListener('change', () => o.set(input.checked));
  const el = h('div', { class: 'field field-toggle' },
    h('label', { class: 'switch', for: id }, input, h('span', { class: 'switch-track', 'aria-hidden': 'true' }), h('span', { class: 'switch-label' }, o.label)),
    hintEl(o, id));
  return {
    el,
    sync(p, rt) {
      if (!applyCommon(el, o, p, rt, [input])) return;
      input.checked = Boolean(o.get(p, rt));
    },
  };
}

/**
 * Segmented control (radio group) for a few options.
 * @param {BaseOptions & {options:Array<[string,string]>, compact?:boolean}} o
 * @returns {Control}
 */
export function segmentedField(o) {
  const name = uid('seg');
  const inputs = o.options.map(([value, label]) => {
    const input = h('input', { type: 'radio', name, value, class: 'seg-input' });
    input.addEventListener('change', () => {
      if (input.checked) o.set(value);
    });
    return { input, label: h('label', { class: 'seg-option', 'data-value': value }, input, h('span', null, label)) };
  });
  const group = h('div', { class: `segmented${o.compact ? ' segmented-compact' : ''}`, role: 'radiogroup', 'aria-label': o.label, 'data-testid': o.testId },
    inputs.map((i) => i.label));
  const el = h('div', { class: 'field' },
    o.label ? h('div', { class: 'field-row' }, h('span', { class: 'field-label', id: `${name}-label` }, o.label)) : null,
    group, hintEl(o, name));
  if (o.label) group.setAttribute('aria-labelledby', `${name}-label`);
  return {
    el,
    sync(p, rt) {
      if (!applyCommon(el, o, p, rt, inputs.map((i) => i.input))) return;
      const v = String(o.get(p, rt));
      for (const { input } of inputs) input.checked = input.value === v;
    },
  };
}

/**
 * Integer stepper (− value +).
 * @param {BaseOptions & {min:number, max:number}} o
 * @returns {Control}
 */
export function stepperField(o) {
  const id = uid('stp');
  let current = o.min;
  const out = h('input', {
    id, type: 'number', class: 'input input-number stepper-value', min: o.min, max: o.max, step: 1,
    inputmode: 'numeric', 'data-testid': o.testId,
  });
  const dec = h('button', { type: 'button', class: 'icon-btn stepper-btn', 'aria-label': `Fewer ${o.label.toLowerCase()}`, onClick: () => o.set(current - 1) }, icon('minus'));
  const inc = h('button', { type: 'button', class: 'icon-btn stepper-btn', 'aria-label': `More ${o.label.toLowerCase()}`, onClick: () => o.set(current + 1) }, icon('plus'));
  out.addEventListener('change', () => {
    const v = parseInt(out.value, 10);
    if (Number.isFinite(v)) o.set(Math.min(o.max, Math.max(o.min, v)));
    else out.value = String(current);
  });
  const el = fieldShell(o, id, h('div', { class: 'field-control stepper' }, dec, out, inc));
  return {
    el,
    sync(p, rt) {
      if (!applyCommon(el, o, p, rt, [out, dec, inc])) return;
      current = o.get(p, rt);
      if (document.activeElement !== out) out.value = String(current);
      dec.disabled = current <= o.min;
      inc.disabled = current >= o.max;
    },
  };
}

/**
 * Colour picker with hex label.
 * @param {BaseOptions} o
 * @returns {Control}
 */
export function colorField(o) {
  const id = uid('col');
  const input = h('input', { id, type: 'color', class: 'color-input', 'data-testid': o.testId });
  const code = h('code', { class: 'color-code' });
  input.addEventListener('input', () => o.set(input.value));
  const el = fieldShell(o, id, h('div', { class: 'field-control' }, input, code));
  return {
    el,
    sync(p, rt) {
      if (!applyCommon(el, o, p, rt, [input])) return;
      const v = o.get(p, rt);
      input.value = v;
      code.textContent = v;
    },
  };
}

/**
 * Read-only value row ("Artwork size  98.4 × 49.2 cm").
 * @param {{label:string, get:Getter, hint?:string, visible?:Function, testId?:string}} o
 * @returns {Control}
 */
export function valueRow(o) {
  const value = h('output', { class: 'value-out', 'data-testid': o.testId });
  const el = h('div', { class: 'field field-value' }, h('div', { class: 'field-row' }, h('span', { class: 'field-label' }, o.label), value), hintEl(o, uid('val')));
  return {
    el,
    sync(p, rt) {
      if (!applyCommon(el, o, p, rt, [])) return;
      const v = o.get(p, rt);
      if (value.textContent !== v) value.textContent = v;
    },
  };
}

/**
 * Hint paragraph (explanations of printing concepts, warnings).
 * @param {string|Node|((project:object, runtime:object)=>string)} text a function is re-evaluated on every sync
 * @param {{tone?:'info'|'warn', visible?:Function}} [opts]
 * @returns {Control}
 */
export function hintBlock(text, { tone = 'info', visible } = {}) {
  const body = h('span', null, typeof text === 'function' ? '' : text);
  const el = h('p', { class: `hint-block hint-${tone}` }, icon(tone === 'warn' ? 'warning' : 'info', { size: 16 }), body);
  return {
    el,
    sync(p, rt) {
      el.hidden = visible ? !visible(p, rt) : false;
      if (el.hidden || typeof text !== 'function') return;
      const next = text(p, rt);
      if (body.textContent !== next) body.textContent = next;
    },
  };
}

/**
 * Groups controls so a section can sync them together.
 * @param {Control[]} controls
 * @param {{class?:string, visible?:Function}} [opts]
 * @returns {Control}
 */
export function group(controls, opts = {}) {
  const el = h('div', { class: opts.class ?? 'field-group' }, controls.map((c) => c.el));
  return {
    el,
    sync(p, rt) {
      const show = opts.visible ? opts.visible(p, rt) : true;
      el.hidden = !show;
      if (show) for (const c of controls) c.sync(p, rt);
    },
  };
}

// ---------------------------------------------------------------------------------------------

function fieldShell(o, id, control) {
  return h('div', { class: 'field' },
    h('div', { class: 'field-row' }, h('label', { class: 'field-label', for: id }, o.label), control),
    hintEl(o, id));
}

function hintEl(o, id) {
  if (!o.hint) return null;
  return h('p', { class: 'hint', id: `${id}-hint` }, o.hint);
}

/** Applies visibility / disabled state; returns false when hidden (no further sync needed). */
function applyCommon(el, o, p, rt, inputs) {
  const show = o.visible ? o.visible(p, rt) : true;
  el.hidden = !show;
  if (!show) return false;
  const disabled = o.disabled ? Boolean(o.disabled(p, rt)) : false;
  el.classList.toggle('is-disabled', disabled);
  for (const input of inputs) input.disabled = disabled;
  return true;
}

function display(v, digits) {
  if (typeof v !== 'number' || !Number.isFinite(v)) return '';
  return digits === undefined ? String(v) : String(Number(v.toFixed(digits)));
}

function updateSliderFill(slider) {
  const min = parseFloat(slider.min);
  const max = parseFloat(slider.max);
  const v = parseFloat(slider.value);
  const pct = max > min ? ((v - min) / (max - min)) * 100 : 0;
  slider.style.setProperty('--fill', `${Math.min(100, Math.max(0, pct))}%`);
}

