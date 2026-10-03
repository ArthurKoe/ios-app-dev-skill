// Export progress dialog: tile list with per-tile status, overall progress, cancel / download.

import { createDialog } from './dialog.js';
import { h, replaceChildren } from './dom.js';
import { icon } from './icons.js';
import { formatBytes, formatNumber } from './format.js';
import { overallFraction } from './progress.js';

/**
 * Creates the export dialog.
 * @param {{onCancel:()=>void}} opts
 * @returns {{
 *   open:(labels:string[], format:string)=>void,
 *   progress:(p:{stage:string, fraction:number, message:string})=>void,
 *   tileDone:(file:{label:string, buffer:ArrayBuffer, triangles:number})=>void,
 *   status:(message:string)=>void,
 *   done:(download:{blob:Blob, filename:string}, again:()=>void)=>void,
 *   fail:(message:string)=>void, cancelled:()=>void
 * }}
 */
export function createExportDialog({ onCancel }) {
  const message = h('p', { class: 'export-message', role: 'status' });
  const fill = h('div', { class: 'progress-fill' });
  const bar = h('div', { class: 'progress-track', role: 'progressbar', 'aria-valuemin': '0', 'aria-valuemax': '100', 'aria-label': 'Export progress' }, fill);
  const list = h('ul', { class: 'export-tiles', 'data-testid': 'export-tiles' });
  const cancelBtn = h('button', { type: 'button', class: 'btn btn-ghost', onClick: () => onCancel() }, 'Cancel');
  const againBtn = h('button', { type: 'button', class: 'btn btn-ghost', hidden: true }, icon('download', { size: 16 }), 'Download again');
  const closeBtn = h('button', { type: 'button', class: 'btn btn-primary', hidden: true, 'data-testid': 'export-close', onClick: () => dialog.close() }, 'Close');
  let running = false;
  const dialog = createDialog({
    title: 'Exporting tiles', className: 'dialog-export',
    body: [message, bar, list],
    footer: [againBtn, cancelBtn, closeBtn],
    dismissable: () => !running,
  });
  /** @type {Map<string, {row:HTMLElement, state:HTMLElement}>} */
  let rows = new Map();
  let order = [];
  let doneCount = 0;

  function setTile(label, state, detail = '') {
    const r = rows.get(label);
    if (!r) return;
    r.row.dataset.state = state;
    replaceChildren(r.state, state === 'done' ? icon('check', { size: 16 }) : state === 'working' ? h('span', { class: 'spinner' }) : null, detail);
  }

  function setBar(fraction) {
    fill.style.transform = `scaleX(${Math.max(0.02, Math.min(1, fraction))})`;
    bar.setAttribute('aria-valuenow', String(Math.round(fraction * 100)));
  }

  function finish(state) {
    running = false;
    cancelBtn.hidden = true;
    closeBtn.hidden = false;
    dialog.el.dataset.state = state;
    dialog.refreshDismissable();
  }

  return {
    open(labels, format) {
      running = true;
      order = labels;
      doneCount = 0;
      rows = new Map(labels.map((label) => {
        const state = h('span', { class: 'export-tile-state' }, 'waiting');
        const row = h('li', { class: 'export-tile', 'data-state': 'waiting' }, h('span', { class: 'export-tile-label' }, label), state);
        return [label, { row, state }];
      }));
      replaceChildren(list, [...rows.values()].map((r) => r.row));
      dialog.setTitle(`Exporting ${labels.length} tile${labels.length === 1 ? '' : 's'} as ${format.toUpperCase()}`);
      message.textContent = 'Loading full-resolution elevation data…';
      setBar(0);
      cancelBtn.hidden = false;
      closeBtn.hidden = true;
      againBtn.hidden = true;
      dialog.el.dataset.state = 'running';
      dialog.open();
    },
    progress(p) {
      if (!running) return;
      if (p.message) message.textContent = p.message;
      if (p.stage === 'mesh' && order.length) {
        setBar(0.55 + 0.4 * p.fraction);
        const next = order[doneCount];
        if (next && rows.get(next)?.row.dataset.state === 'waiting') setTile(next, 'working', 'meshing…');
      } else {
        setBar(overallFraction(p) * 0.55);
      }
    },
    tileDone(file) {
      doneCount += 1;
      setTile(file.label, 'done', `${formatNumber(file.triangles / 1000, 0)} k triangles · ${formatBytes(file.buffer.byteLength)}`);
      setBar(0.55 + 0.4 * (doneCount / Math.max(1, order.length)));
      const next = order[doneCount];
      if (next) setTile(next, 'working', 'meshing…');
    },
    status(text) {
      message.textContent = text;
    },
    done({ blob, filename }, again) {
      finish('done');
      dialog.setTitle(`Exported ${order.length} tile${order.length === 1 ? '' : 's'}`);
      setBar(1);
      message.textContent = `Done – ${filename} (${formatBytes(blob.size)}) has been downloaded.`;
      againBtn.hidden = false;
      againBtn.onclick = again;
    },
    fail(text) {
      finish('error');
      dialog.setTitle('Export failed');
      message.textContent = `Export failed: ${text}`;
    },
    cancelled() {
      finish('cancelled');
      dialog.setTitle('Export cancelled');
      message.textContent = 'Export cancelled.';
      for (const [label, r] of rows) if (r.row.dataset.state !== 'done') setTile(label, 'cancelled', 'cancelled');
    },
  };
}
