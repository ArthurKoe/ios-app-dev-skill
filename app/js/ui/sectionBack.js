// Section 6 – Back side: engraved tile labels and magnet pockets.

import { h } from './dom.js';
import { group, hintBlock, numberField, rangeField, stepperField, toggleField } from './controls.js';

/**
 * @param {{store:object}} ctx
 * @returns {{el:HTMLElement, sync:(p:object, rt:object)=>void}}
 */
export function createBackSection({ store }) {
  const back = (patch) => store.set({ back: patch });
  const magnets = (patch) => back({ magnets: patch });
  const on = (p) => p.back.magnets.enabled;

  const controls = [
    toggleField({
      label: 'Engrave tile labels', testId: 'labels',
      hint: 'Each tile gets its name (A1, A2, …) and an arrow pointing to the top engraved into the underside, so assembly is foolproof. A1 is the top-left tile seen from the front.',
      get: (p) => p.back.labels, set: (v) => back({ labels: v }),
    }),
    rangeField({
      label: 'Label depth', unit: 'mm', min: 0.2, max: 1.5, step: 0.1, digits: 2, inputMax: 3,
      get: (p) => p.back.labelDepthMm, set: (v) => back({ labelDepthMm: v }), visible: (p) => p.back.labels,
    }),
    toggleField({
      label: 'Magnet pockets', testId: 'magnets',
      hint: 'Round pockets for neodymium disc magnets: hang the tiles on a steel sheet or a painted metal board and take them down any time.',
      get: on, set: (v) => magnets({ enabled: v }),
    }),
    group([
      group([
        numberField({ label: 'Diameter', unit: 'mm', step: 0.1, min: 2, max: 40, digits: 2,
          hint: 'Magnet size + 0.2 mm clearance.',
          get: (p) => p.back.magnets.diameterMm, set: (v) => magnets({ diameterMm: v }) }),
        numberField({ label: 'Depth', unit: 'mm', step: 0.1, min: 0.5, max: 20, digits: 2,
          hint: 'Magnet thickness + 0.2 mm.',
          get: (p) => p.back.magnets.depthMm, set: (v) => magnets({ depthMm: v }) }),
      ], { class: 'field-pair' }),
      group([
        stepperField({ label: 'Per tile', min: 1, max: 8, get: (p) => p.back.magnets.perTile, set: (v) => magnets({ perTile: v }) }),
        numberField({ label: 'Inset', unit: 'mm', step: 1, min: 3, max: 300, digits: 0,
          hint: 'Distance from the tile edge.',
          get: (p) => p.back.magnets.insetMm, set: (v) => magnets({ insetMm: v }) }),
      ], { class: 'field-pair' }),
      hintBlock('The base is thickened automatically so at least 0.8 mm of plastic remains above every pocket.'),
    ], { visible: on }),
  ];
  return {
    el: h('div', { class: 'section-back' }, controls.map((c) => c.el)),
    sync(p, rt) {
      for (const c of controls) c.sync(p, rt);
    },
  };
}
