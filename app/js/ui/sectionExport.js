// Section 8 – Export: file format, tile selection, file name prefix, export / print plan / save.

import { slugify } from '../state/project.js';
import { h, readPref, replaceChildren, writePref } from './dom.js';
import { icon } from './icons.js';
import { hintBlock, segmentedField, valueRow } from './controls.js';
import { formatBytes, formatNumber } from './format.js';

/** Bytes per triangle in a binary STL. */
const STL_TRIANGLE_BYTES = 50;

/**
 * @param {{store:object, actions:object}} ctx
 * @returns {{el:HTMLElement, sync:(p:object, rt:object)=>void}}
 */
export function createExportSection({ actions }) {
  const ui = { format: readPref('exportFormat', 'stl') === '3mf' ? '3mf' : 'stl', which: 'all', picked: new Set(), prefix: '' };
  const refresh = () => last && sync(...last);
  let last = null;

  const format = segmentedField({
    label: 'Format', testId: 'export-format',
    options: [['stl', 'STL (zip)'], ['3mf', '3MF (zip)']],
    get: () => ui.format,
    set: (v) => {
      ui.format = v;
      writePref('exportFormat', v);
      refresh();
    },
  });
  const formatHint = hintBlock('3MF files carry the colour changes for PrusaSlicer (experimental – check the layer preview before printing). STL works with every slicer; enter the colour changes from the print plan.', {
    visible: () => ui.format === '3mf',
  });
  const which = segmentedField({
    label: 'Tiles', compact: true, testId: 'export-which',
    options: [['all', 'All tiles'], ['pick', 'Choose…']],
    get: () => ui.which,
    set: (v) => {
      ui.which = v;
      refresh();
    },
  });
  const picker = h('div', { class: 'tile-picker', role: 'group', 'aria-label': 'Tiles to export' });
  let pickerKey = '';
  const prefix = h('input', { type: 'text', id: 'export-prefix', class: 'input', maxlength: 60, spellcheck: 'false', 'data-testid': 'export-prefix' });
  const names = h('p', { class: 'hint', 'data-testid': 'export-names' });
  prefix.addEventListener('input', () => {
    ui.prefix = prefix.value.trim();
  });
  const fileInfo = valueRow({
    label: 'Size per tile',
    get: (p, rt) => {
      const tri = 2 * rt.layout.spx * rt.layout.spy;
      return `≤ ${formatNumber(tri / 1e6, 1)} M triangles · ≤ ${formatBytes(tri * STL_TRIANGLE_BYTES)}`;
    },
    hint: 'Upper bound at the export resolution; mesh simplification usually shrinks files by 70–95 %.',
  });

  const exportLabel = h('span', null, 'Export tiles');
  const exportBtn = h('button', { type: 'button', class: 'btn btn-primary btn-block', 'data-testid': 'export-button' }, icon('download', { size: 18 }), exportLabel);
  const planBtn = h('button', { type: 'button', class: 'btn btn-ghost', 'data-testid': 'print-plan-button', onClick: () => actions.openPrintPlan() }, icon('print', { size: 16 }), 'Print plan');
  const saveBtn = h('button', { type: 'button', class: 'btn btn-ghost', onClick: () => actions.saveProjectFile() }, icon('save', { size: 16 }), 'Save project (.json)');
  exportBtn.addEventListener('click', () => {
    const p = actions.currentProject();
    const labels = ui.which === 'pick' ? [...ui.picked] : null;
    if (labels && labels.length === 0) return;
    actions.startExport({ format: ui.format, tiles: labels, prefix: ui.prefix || slugify(p.name) });
  });

  const el = h('div', { class: 'section-export' },
    format.el, formatHint.el, which.el, picker,
    h('div', { class: 'field' }, h('div', { class: 'field-row' }, h('label', { class: 'field-label', for: 'export-prefix' }, 'File names'), prefix), names),
    fileInfo.el, exportBtn, h('div', { class: 'button-row' }, planBtn, saveBtn),
    hintBlock('The zip contains one file per tile, a printable print plan with the colour-change table and assembly steps, and this project file.').el);

  function sync(p, rt) {
    last = [p, rt];
    format.sync(p, rt);
    formatHint.sync(p, rt);
    which.sync(p, rt);
    fileInfo.sync(p, rt);
    const placeholder = slugify(p.name);
    prefix.placeholder = placeholder;
    if (document.activeElement !== prefix) prefix.value = ui.prefix;
    names.textContent = `${ui.prefix || placeholder}_A1.${ui.format}, ${ui.prefix || placeholder}_A2.${ui.format}, …`;

    const { cols, rows } = p.layout;
    const labels = [];
    for (let r = 0; r < rows; r++) for (let c = 0; c < cols; c++) labels.push(String.fromCharCode(65 + r) + (c + 1));
    for (const l of [...ui.picked]) if (!labels.includes(l)) ui.picked.delete(l);
    picker.hidden = ui.which !== 'pick';
    const key = `${cols}x${rows}|${[...ui.picked].sort().join()}`;
    if (key !== pickerKey && !picker.hidden) {
      pickerKey = key;
      picker.style.setProperty('--cols', String(cols));
      replaceChildren(picker, labels.map((label) => h('button', {
        type: 'button', class: 'tile-toggle', 'aria-pressed': String(ui.picked.has(label)),
        onClick: () => {
          if (ui.picked.has(label)) ui.picked.delete(label);
          else ui.picked.add(label);
          refresh();
        },
      }, label)));
    }
    const count = ui.which === 'pick' ? ui.picked.size : labels.length;
    exportBtn.disabled = count === 0 || rt.exporting;
    exportLabel.textContent = rt.exporting ? 'Exporting…' : `Export ${count} tile${count === 1 ? '' : 's'}`;
  }

  return { el, sync };
}
