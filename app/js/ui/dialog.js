// Modal dialog helper built on <dialog>.

import { h, uid } from './dom.js';
import { icon } from './icons.js';

/**
 * Creates a modal dialog (appended to <body>, reusable).
 * @param {{title:string, body:Node|Node[], footer?:Node|Node[], className?:string, onClose?:()=>void,
 *          dismissable?:boolean|(()=>boolean)}} opts dismissable: whether Esc / × / backdrop may close it
 * @returns {{el:HTMLDialogElement, open:()=>void, close:()=>void, setTitle:(t:string)=>void, isOpen:()=>boolean,
 *            refreshDismissable:()=>void}} refreshDismissable re-evaluates `dismissable` (shows / hides ×)
 */
export function createDialog({ title, body, footer = null, className = '', onClose, dismissable = true }) {
  const canDismiss = () => (typeof dismissable === 'function' ? dismissable() : dismissable);
  const titleEl = h('h2', { class: 'dialog-title' }, title);
  const closeBtn = h('button', { type: 'button', class: 'icon-btn dialog-close', 'aria-label': 'Close', onClick: () => { if (canDismiss()) close(); } }, icon('close'));
  const el = /** @type {HTMLDialogElement} */ (h('dialog', { class: `dialog ${className}` },
    h('div', { class: 'dialog-head' }, titleEl, closeBtn),
    h('div', { class: 'dialog-body' }, body),
    footer ? h('div', { class: 'dialog-foot' }, footer) : null));
  const titleId = uid('dlg');
  titleEl.id = titleId;
  el.setAttribute('aria-labelledby', titleId);
  el.addEventListener('cancel', (e) => {
    if (!canDismiss()) e.preventDefault();
  });
  el.addEventListener('close', () => onClose?.());
  el.addEventListener('click', (e) => {
    if (e.target === el && canDismiss()) close(); // backdrop click
  });
  document.body.append(el);

  function close() {
    if (el.open) el.close();
  }

  return {
    el,
    open() {
      closeBtn.hidden = !canDismiss();
      if (!el.open) el.showModal();
    },
    refreshDismissable() {
      closeBtn.hidden = !canDismiss();
    },
    close,
    setTitle(t) {
      titleEl.textContent = t;
    },
    isOpen: () => el.open,
  };
}
