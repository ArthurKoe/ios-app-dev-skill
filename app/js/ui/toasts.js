// Toast notifications (bottom corner, aria-live).

import { h } from './dom.js';
import { icon } from './icons.js';

const ICONS = { info: 'info', success: 'check', warn: 'warning', error: 'warning' };
const DEFAULT_TIMEOUT = { info: 4500, success: 3500, warn: 8000, error: 12000 };

/**
 * Creates a toaster rendering into `container`.
 * Identical messages shown while a toast is still visible are not repeated.
 * @param {HTMLElement} container
 * @returns {{show:(message:string, opts?:{type?:'info'|'success'|'warn'|'error', timeout?:number,
 *            action?:{label:string, onClick:()=>void}})=>()=>void,
 *            info:(m:string)=>void, success:(m:string)=>void, warn:(m:string)=>void, error:(m:string)=>void}}
 */
export function createToaster(container) {
  container.classList.add('toasts');
  container.setAttribute('aria-live', 'polite');
  container.setAttribute('aria-relevant', 'additions');
  const visible = new Map();

  function show(message, { type = 'info', timeout = DEFAULT_TIMEOUT[type], action } = {}) {
    const key = `${type}|${message}`;
    if (visible.has(key)) return visible.get(key);
    const close = () => {
      if (!visible.has(key)) return;
      visible.delete(key);
      clearTimeout(timer);
      el.classList.add('is-leaving');
      setTimeout(() => el.remove(), 200);
    };
    const el = h('div', { class: `toast toast-${type}`, role: type === 'error' ? 'alert' : 'status' },
      h('span', { class: 'toast-icon' }, icon(ICONS[type] ?? 'info', { size: 18 })),
      h('p', { class: 'toast-text' }, message),
      action ? h('button', { type: 'button', class: 'btn btn-small btn-ghost', onClick: () => { action.onClick(); close(); } }, action.label) : null,
      h('button', { type: 'button', class: 'icon-btn toast-close', 'aria-label': 'Dismiss', onClick: close }, icon('close', { size: 16 })));
    container.append(el);
    let timer = timeout > 0 ? setTimeout(close, timeout) : null;
    el.addEventListener('mouseenter', () => clearTimeout(timer));
    el.addEventListener('mouseleave', () => {
      if (timeout > 0) timer = setTimeout(close, 2500);
    });
    visible.set(key, close);
    return close;
  }

  return {
    show,
    info: (m) => show(m, { type: 'info' }),
    success: (m) => show(m, { type: 'success' }),
    warn: (m) => show(m, { type: 'warn' }),
    error: (m) => show(m, { type: 'error' }),
  };
}
