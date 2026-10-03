// Loading / meshing progress: a thin bar over the workspace and a caption in the 3D view.

import { h } from './dom.js';

const STAGES = {
  data: { label: 'Loading elevation data', from: 0, to: 0.45 },
  sample: { label: 'Sampling terrain', from: 0.45, to: 0.7 },
  model: { label: 'Shaping relief', from: 0.7, to: 0.8 },
  mesh: { label: 'Building tiles', from: 0.8, to: 1 },
};

/**
 * Maps a stage-local engine progress to an overall 0..1 fraction.
 * @param {{stage:string, fraction:number}} p
 * @returns {number}
 */
export function overallFraction(p) {
  const s = STAGES[p.stage] ?? { from: 0, to: 1 };
  const f = Number.isFinite(p.fraction) ? Math.min(1, Math.max(0, p.fraction)) : 0;
  return s.from + (s.to - s.from) * f;
}

/**
 * Creates the progress indicator.
 * @param {{bar:HTMLElement, caption:HTMLElement}} els bar: container of the thin bar; caption: overlay text box
 * @returns {{start:(message:string)=>void, update:(p:{stage:string, fraction:number, message?:string})=>void,
 *            done:()=>void, fail:(message:string)=>void, readonly busy:boolean}}
 */
export function createProgress({ bar, caption }) {
  const fill = h('div', { class: 'progress-fill' });
  bar.replaceChildren(fill);
  bar.setAttribute('role', 'progressbar');
  bar.setAttribute('aria-label', 'Preview progress');
  bar.setAttribute('aria-valuemin', '0');
  bar.setAttribute('aria-valuemax', '100');
  const text = h('span', { class: 'progress-text' });
  const spinner = h('span', { class: 'spinner', 'aria-hidden': 'true' });
  caption.replaceChildren(spinner, text);
  caption.setAttribute('role', 'status');
  let busy = false;
  let showTimer = null;
  let hideTimer = null;

  function set(fraction, message) {
    fill.style.transform = `scaleX(${fraction})`;
    bar.setAttribute('aria-valuenow', String(Math.round(fraction * 100)));
    if (message !== undefined) text.textContent = message;
  }

  return {
    get busy() { return busy; },
    start(message) {
      busy = true;
      clearTimeout(hideTimer);
      bar.hidden = false;
      bar.classList.remove('is-error');
      caption.classList.remove('is-error');
      spinner.hidden = false;
      set(0.02, message);
      // Only show the caption for jobs that take a moment (avoids flicker on fast updates).
      clearTimeout(showTimer);
      showTimer = setTimeout(() => { if (busy) caption.hidden = false; }, 250);
    },
    update(p) {
      if (!busy) return;
      const stage = STAGES[p.stage];
      const msg = p.message || stage?.label;
      set(Math.max(0.02, overallFraction(p)), msg);
    },
    done() {
      busy = false;
      clearTimeout(showTimer);
      set(1);
      caption.hidden = true;
      hideTimer = setTimeout(() => { if (!busy) bar.hidden = true; }, 350);
    },
    fail(message) {
      busy = false;
      clearTimeout(showTimer);
      bar.classList.add('is-error');
      caption.classList.add('is-error');
      spinner.hidden = true;
      set(1, message);
      caption.hidden = false;
      hideTimer = setTimeout(() => {
        bar.hidden = true;
        caption.hidden = true;
        spinner.hidden = false;
      }, 6000);
    },
  };
}
