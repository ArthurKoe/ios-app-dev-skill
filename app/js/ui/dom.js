// Tiny DOM helpers shared by the UI modules.

const PROPERTY_KEYS = new Set(['value', 'checked', 'selected', 'indeterminate', 'textContent', 'disabled', 'hidden', 'open']);
let uidCounter = 0;

/**
 * Creates an element. `props`: `class`, `dataset`, `style` (object), `on<Event>` listeners,
 * `html` (trusted static markup only), DOM properties (value, checked, disabled, hidden, …)
 * and any other attribute. `null`/`undefined`/`false` props are skipped.
 * Children may be nodes, strings, numbers, arrays or null.
 * @param {string} tag
 * @param {Record<string, any>|null} [props]
 * @param {...any} children
 * @returns {HTMLElement}
 */
export function h(tag, props, ...children) {
  const el = document.createElement(tag);
  for (const [key, value] of Object.entries(props ?? {})) {
    if (value === null || value === undefined || value === false) continue;
    if (key === 'class') el.className = value;
    else if (key === 'dataset') Object.assign(el.dataset, value);
    else if (key === 'style' && typeof value === 'object') Object.assign(el.style, value);
    else if (key === 'html') el.innerHTML = value;
    else if (key.startsWith('on') && typeof value === 'function') el.addEventListener(key.slice(2).toLowerCase(), value);
    else if (PROPERTY_KEYS.has(key)) el[key] = value;
    else el.setAttribute(key, value === true ? '' : String(value));
  }
  append(el, children);
  return el;
}

/**
 * Appends children (nodes, strings, arrays; null/false skipped).
 * @param {Element} parent
 * @param {any[]} children
 * @returns {Element}
 */
export function append(parent, children) {
  for (const child of children.flat(Infinity)) {
    if (child === null || child === undefined || child === false) continue;
    parent.append(child instanceof Node ? child : document.createTextNode(String(child)));
  }
  return parent;
}

/**
 * Replaces all children of an element.
 * @param {Element} parent
 * @param {...any} children
 * @returns {Element}
 */
export function replaceChildren(parent, ...children) {
  parent.replaceChildren();
  return append(parent, children);
}

/**
 * Unique element id with a readable prefix.
 * @param {string} prefix
 * @returns {string}
 */
export function uid(prefix = 'rs') {
  uidCounter += 1;
  return `${prefix}-${uidCounter}`;
}

/**
 * Debounces a function; the returned function has `.flush()` and `.cancel()`.
 * @template {(...args:any[])=>void} F
 * @param {F} fn
 * @param {number} ms
 * @returns {F & {flush:()=>void, cancel:()=>void}}
 */
export function debounce(fn, ms) {
  let timer = null;
  let lastArgs = [];
  const run = () => {
    timer = null;
    fn(...lastArgs);
  };
  const debounced = (...args) => {
    lastArgs = args;
    if (timer !== null) clearTimeout(timer);
    timer = setTimeout(run, ms);
  };
  debounced.flush = () => {
    if (timer !== null) {
      clearTimeout(timer);
      run();
    }
  };
  debounced.cancel = () => {
    if (timer !== null) clearTimeout(timer);
    timer = null;
  };
  return /** @type {any} */ (debounced);
}

/**
 * Reads a nested value by dotted path ("relief.water.mode").
 * @param {object} obj
 * @param {string} path
 * @returns {any}
 */
export function getPath(obj, path) {
  return path.split('.').reduce((o, k) => (o === null || o === undefined ? undefined : o[k]), obj);
}

/**
 * Builds a nested partial object for a dotted path, e.g. ('relief.baseMm', 3) → {relief:{baseMm:3}}.
 * @param {string} path
 * @param {any} value
 * @returns {object}
 */
export function patchAt(path, value) {
  return path.split('.').reduceRight((acc, key) => ({ [key]: acc }), value);
}

/**
 * True while the element (or a descendant) has keyboard focus.
 * @param {Element} el
 * @returns {boolean}
 */
export function hasFocus(el) {
  return el.contains(document.activeElement);
}

/**
 * Downloads text as a file.
 * @param {string} text
 * @param {string} filename
 * @param {string} [type]
 */
export function downloadText(text, filename, type = 'application/json') {
  const url = URL.createObjectURL(new Blob([text], { type }));
  const a = h('a', { href: url, download: filename, style: { display: 'none' } });
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 30_000);
}

/**
 * Reads a per-viewer UI preference from localStorage (never throws).
 * @param {string} key
 * @param {string} fallback
 * @returns {string}
 */
export function readPref(key, fallback) {
  try {
    return globalThis.localStorage?.getItem(`relief-studio.ui.${key}`) ?? fallback;
  } catch {
    return fallback;
  }
}

/**
 * Stores a per-viewer UI preference (never throws).
 * @param {string} key
 * @param {string} value
 */
export function writePref(key, value) {
  try {
    globalThis.localStorage?.setItem(`relief-studio.ui.${key}`, value);
  } catch {
    // storage unavailable – the preference just is not remembered
  }
}
