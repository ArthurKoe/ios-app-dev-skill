// Split / Map / 3D switch for the workspace (a per-viewer preference).

import { h, readPref, writePref } from './dom.js';
import { icon } from './icons.js';

const MODES = [['split', 'Split', 'split'], ['map', 'Map', 'map'], ['3d', '3D', 'cube']];

/**
 * Builds the view-mode switch.
 * @param {HTMLElement} container where the segmented control goes
 * @param {HTMLElement} workspace element that gets `data-view="split|map|3d"`
 * @param {(mode:string)=>void} onChange called after the layout changed
 * @returns {{set:(mode:string)=>void, get:()=>string}}
 */
export function createViewModes(container, workspace, onChange) {
  let mode = readPref('viewMode', 'split');
  if (!MODES.some(([m]) => m === mode)) mode = 'split';
  const buttons = MODES.map(([id, label, iconName]) => h('button', {
    type: 'button', class: 'seg-btn', 'aria-pressed': 'false', 'data-mode': id, 'data-testid': `view-mode-${id}`,
    onClick: () => set(id),
  }, icon(iconName, { size: 16 }), h('span', null, label)));
  container.replaceChildren(h('div', { class: 'view-modes', role: 'group', 'aria-label': 'Workspace view' }, buttons));

  function set(next) {
    mode = next;
    writePref('viewMode', next);
    workspace.dataset.view = next;
    for (const b of buttons) b.setAttribute('aria-pressed', String(b.dataset.mode === next));
    onChange(next);
  }
  workspace.dataset.view = mode;
  for (const b of buttons) b.setAttribute('aria-pressed', String(b.dataset.mode === mode));
  return { set, get: () => mode };
}
