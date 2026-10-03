// Overlay toolbar of the 3D preview: lighting, wall colour, wall/table, display toggles,
// camera reset and screenshot.

import { h } from './dom.js';
import { icon } from './icons.js';

const LIGHTING = [
  ['gallery', 'Gallery'], ['morning', 'Morning sun'], ['evening', 'Evening glow'],
  ['overcast', 'Overcast'], ['raking', 'Raking light'], ['backlit', 'Backlit'],
];
const TOGGLES = [
  ['exploded', 'explode', 'Exploded view – pull the tiles apart'],
  ['seams', 'seams', 'Show tile seams'],
  ['layerLines', 'layers', 'Show print layer lines'],
  ['labels', 'label', 'Show tile labels'],
  ['highlightWater', 'water', 'Highlight lakes and sea'],
];

/**
 * Builds the toolbar into `container`.
 * @param {HTMLElement} container
 * @param {{store:object, onResetCamera:()=>void, onScreenshot:()=>void}} ctx
 * @returns {{update:(project:object)=>void}}
 */
export function createViewToolbar(container, { store, onResetCamera, onScreenshot }) {
  const setView = (patch) => store.set({ view: patch });
  const lighting = h('select', { class: 'input select select-compact', 'aria-label': 'Lighting', title: 'Lighting', 'data-testid': 'view-lighting' },
    LIGHTING.map(([v, l]) => h('option', { value: v }, l)));
  lighting.addEventListener('change', () => setView({ lighting: lighting.value }));
  const wallColor = h('input', { type: 'color', class: 'color-input color-compact', 'aria-label': 'Wall colour', title: 'Wall colour' });
  wallColor.addEventListener('input', () => setView({ wallColor: wallColor.value }));
  const mount = h('button', { type: 'button', class: 'tool-btn', 'data-testid': 'view-mount', onClick: () => setView({ wallMode: !store.get().view.wallMode }) });
  const toggles = TOGGLES.map(([key, iconName, label]) => {
    const btn = h('button', {
      type: 'button', class: 'tool-btn', 'aria-pressed': 'false', 'aria-label': label, title: label, 'data-testid': `view-${key}`,
      onClick: () => setView({ [key]: !store.get().view[key] }),
    }, icon(iconName));
    return { key, btn };
  });
  const reset = h('button', { type: 'button', class: 'tool-btn', 'aria-label': 'Reset camera', title: 'Reset camera (double-click the view)', onClick: onResetCamera }, icon('reset'));
  const shot = h('button', { type: 'button', class: 'tool-btn', 'aria-label': 'Save screenshot (PNG)', title: 'Save screenshot (PNG)', 'data-testid': 'view-screenshot', onClick: onScreenshot }, icon('camera'));

  container.replaceChildren(
    h('div', { class: 'tool-group' }, icon('sun', { size: 16 }), lighting, wallColor),
    h('div', { class: 'tool-group' }, mount),
    h('div', { class: 'tool-group', role: 'group', 'aria-label': 'Display options' }, toggles.map((t) => t.btn)),
    h('div', { class: 'tool-group' }, reset, shot));
  container.setAttribute('role', 'toolbar');
  container.setAttribute('aria-label', '3D view');

  return {
    update(p) {
      const v = p.view;
      lighting.value = v.lighting;
      wallColor.value = v.wallColor;
      const label = v.wallMode ? 'Hanging on the wall – switch to table' : 'Lying on a table – switch to wall';
      mount.replaceChildren(icon(v.wallMode ? 'wall' : 'table'));
      mount.setAttribute('aria-label', label);
      mount.title = label;
      for (const { key, btn } of toggles) btn.setAttribute('aria-pressed', String(Boolean(v[key])));
    },
  };
}
