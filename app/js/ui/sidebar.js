// Sidebar shell: numbered, collapsible sections; on narrow screens a bottom sheet with tabs.

import { h, readPref, writePref } from './dom.js';
import { icon } from './icons.js';

/**
 * @typedef {{id:string, title:string, short?:string, content:{el:HTMLElement, sync:(p:object, rt:object)=>void},
 *            summary?:(p:object, rt:object)=>string, collapsed?:boolean}} SectionDef
 */

const NARROW = '(max-width: 899px)';

/**
 * Builds the sidebar into `container`.
 * @param {HTMLElement} container
 * @param {SectionDef[]} sections
 * @returns {{update:(p:object, rt:object)=>void, open:(id:string)=>void}}
 */
export function createSidebar(container, sections) {
  const collapsed = new Set(parseList(readPref('collapsed', defaultCollapsed(sections))));
  let active = readPref('activeSection', sections[0].id);
  if (!sections.some((s) => s.id === active)) active = sections[0].id;
  const narrow = matchMedia(NARROW);
  /** Last (project, runtime) – hidden bodies are synced lazily when they open. */
  let lastArgs = null;

  const tabs = h('div', { class: 'sheet-tabs', role: 'tablist', 'aria-label': 'Settings sections' });
  const list = h('div', { class: 'sections' });
  const items = sections.map((s, i) => {
    const num = String(i + 1);
    const bodyId = `section-${s.id}`;
    const summary = h('span', { class: 'panel-summary' });
    const head = h('button', {
      type: 'button', class: 'panel-head', 'aria-controls': bodyId, id: `${bodyId}-head`,
      onClick: () => toggle(s.id),
    }, h('span', { class: 'panel-num', 'aria-hidden': 'true' }, num),
    h('span', { class: 'panel-title' }, s.title), summary, h('span', { class: 'panel-chevron' }, icon('chevron', { size: 16 })));
    const body = h('div', { class: 'panel-body', id: bodyId, role: 'region', 'aria-labelledby': `${bodyId}-head` }, s.content.el);
    const panel = h('section', { class: 'panel', 'data-section': s.id }, h('h2', { class: 'panel-heading' }, head), body);
    const tab = h('button', {
      type: 'button', role: 'tab', class: 'sheet-tab', id: `${bodyId}-tab`, 'aria-controls': bodyId,
      onClick: () => activate(s.id, true),
    }, h('span', { class: 'sheet-tab-num', 'aria-hidden': 'true' }, num), h('span', null, s.short ?? s.title));
    tabs.append(tab);
    list.append(panel);
    return { def: s, panel, head, body, tab, summary };
  });
  container.replaceChildren(tabs, list);

  tabs.addEventListener('keydown', (e) => {
    if (e.key !== 'ArrowRight' && e.key !== 'ArrowLeft') return;
    const idx = sections.findIndex((s) => s.id === active);
    const next = sections[(idx + (e.key === 'ArrowRight' ? 1 : sections.length - 1)) % sections.length];
    activate(next.id, true);
    items.find((it) => it.def.id === next.id).tab.focus();
    e.preventDefault();
  });

  function toggle(id) {
    if (narrow.matches) return;
    if (collapsed.has(id)) collapsed.delete(id);
    else collapsed.add(id);
    writePref('collapsed', [...collapsed].join(','));
    render();
  }

  function activate(id, user) {
    active = id;
    if (user) writePref('activeSection', id);
    render();
    if (user && narrow.matches) container.querySelector('.sections').scrollTop = 0;
  }

  function render() {
    const isNarrow = narrow.matches;
    container.classList.toggle('is-sheet', isNarrow);
    for (const it of items) {
      const open = isNarrow ? it.def.id === active : !collapsed.has(it.def.id);
      if (open && it.body.hidden && lastArgs) it.def.content.sync(...lastArgs);
      it.panel.classList.toggle('is-collapsed', !open);
      it.body.hidden = !open;
      it.head.setAttribute('aria-expanded', String(open));
      it.tab.setAttribute('aria-selected', String(it.def.id === active));
      it.tab.tabIndex = it.def.id === active ? 0 : -1;
    }
  }

  narrow.addEventListener('change', render);
  render();

  return {
    update(p, rt) {
      lastArgs = [p, rt];
      for (const it of items) {
        if (!it.body.hidden) it.def.content.sync(p, rt);
        if (it.def.summary) {
          const text = it.def.summary(p, rt);
          if (it.summary.textContent !== text) it.summary.textContent = text;
        }
      }
    },
    open(id) {
      if (narrow.matches) activate(id, true);
      else if (collapsed.has(id)) toggle(id);
      items.find((x) => x.def.id === id)?.panel.scrollIntoView({ behavior: 'smooth', block: 'start' });
    },
  };
}

function defaultCollapsed(sections) {
  return sections.filter((s) => s.collapsed).map((s) => s.id).join(',');
}

function parseList(text) {
  return String(text ?? '').split(',').filter(Boolean);
}
