// Split / Map / 3D switch for the workspace (a per-viewer preference). Narrow screens have no
// room for two panes, so there "Split" is hidden and shows the 3D view until Map is picked.

import { h, readPref, writePref } from './dom.js';
import { icon } from './icons.js';

const MODES = [['split', 'Split', 'split'], ['map', 'Map', 'map'], ['3d', '3D', 'cube']];
const NARROW = '(max-width: 899px)';

/**
 * Builds the view-mode switch.
 * @param {HTMLElement} container where the segmented control goes
 * @param {HTMLElement} workspace element that gets `data-view="split|map|3d"`
 * @param {(mode:string)=>void} onChange called after the layout changed
 * @returns {{set:(mode:string)=>void, get:()=>string}} get returns the mode actually shown
 */
export function createViewModes(container, workspace, onChange) {
  let mode = readPref('viewMode', 'split');
  if (!MODES.some(([m]) => m === mode)) mode = 'split';
  const narrow = matchMedia(NARROW);
  const buttons = MODES.map(([id, label, iconName]) => h('button', {
    type: 'button', class: 'seg-btn', 'aria-pressed': 'false', 'data-mode': id, 'data-testid': `view-mode-${id}`,
    onClick: () => set(id),
  }, icon(iconName, { size: 16 }), h('span', null, label)));
  container.replaceChildren(h('div', { class: 'view-modes', role: 'group', 'aria-label': 'Workspace view' }, buttons));

  /** The mode shown on this screen (split falls back to 3D when narrow). */
  const effective = () => (mode === 'split' && narrow.matches ? '3d' : mode);

  function apply() {
    const shown = effective();
    workspace.dataset.view = shown;
    for (const b of buttons) {
      b.setAttribute('aria-pressed', String(b.dataset.mode === shown));
      b.hidden = b.dataset.mode === 'split' && narrow.matches;
    }
  }

  function set(next) {
    mode = next;
    writePref('viewMode', next);
    apply();
    onChange(effective());
  }

  narrow.addEventListener('change', () => {
    apply();
    onChange(effective());
  });
  apply();
  return { set, get: effective };
}
