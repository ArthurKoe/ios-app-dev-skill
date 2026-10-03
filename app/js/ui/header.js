// App header: logo, editable project name and the project actions.

import { h } from './dom.js';
import { icon } from './icons.js';

/**
 * Builds the header into `container`.
 * @param {HTMLElement} container
 * @param {{store:object, actions:{newProject:()=>void, openProject:(file:File)=>void, saveProjectFile:()=>void,
 *          shareLink:()=>void, openHelp:()=>void}}} ctx
 * @returns {{update:(project:object)=>void}}
 */
export function createHeader(container, { store, actions }) {
  const name = h('input', {
    type: 'text', class: 'project-name', maxlength: 80, spellcheck: 'false', 'aria-label': 'Project name', 'data-testid': 'project-name',
  });
  name.addEventListener('change', () => store.set({ name: name.value }));
  name.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') name.blur();
    if (e.key === 'Escape') {
      name.value = store.get().name;
      name.blur();
    }
  });
  const file = h('input', { type: 'file', accept: '.json,application/json', hidden: true, 'data-testid': 'open-file' });
  file.addEventListener('change', () => {
    if (file.files?.[0]) actions.openProject(file.files[0]);
    file.value = '';
  });
  const button = (label, iconName, onClick, testId, extra = {}) => h('button', {
    type: 'button', class: 'header-btn', title: label, onClick, 'data-testid': testId, ...extra,
  }, icon(iconName), h('span', { class: 'header-btn-label' }, label));

  container.replaceChildren(
    h('div', { class: 'brand' }, h('span', { class: 'brand-mark', 'aria-hidden': 'true' }, icon('logo', { size: 26 })), h('span', { class: 'brand-name' }, 'Relief Studio')),
    h('div', { class: 'project' }, name),
    h('nav', { class: 'header-actions', 'aria-label': 'Project' },
      button('New', 'file', actions.newProject, 'action-new'),
      button('Open…', 'open', () => file.click(), 'action-open'),
      button('Save', 'save', actions.saveProjectFile, 'action-save'),
      button('Share link', 'share', actions.shareLink, 'action-share'),
      button('Help', 'help', actions.openHelp, 'action-help', { 'aria-keyshortcuts': '?' }),
      file));

  return {
    update(p) {
      if (document.activeElement !== name) name.value = p.name;
    },
  };
}
