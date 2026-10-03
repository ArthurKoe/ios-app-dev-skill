// Section 3 – Relief: vertical exaggeration, base, floor, smoothing, water, resolution, limits.

import { h } from './dom.js';
import { hintBlock, numberField, rangeField, segmentedField, selectField, toggleField, valueRow } from './controls.js';
import { formatMm, formatNumber } from './format.js';

/** Relief height (above the base) beyond which a warning is shown, in mm. */
const TALL_RELIEF_MM = 60;

/** Export resolution presets (sample spacing in mm). */
export const RESOLUTION_PRESETS = Object.freeze([['0.25', 'Fine'], ['0.4', 'Standard'], ['0.6', 'Draft'], ['custom', 'Custom']]);

/**
 * @param {{store:object}} ctx
 * @returns {{el:HTMLElement, sync:(p:object, rt:object)=>void}}
 */
export function createReliefSection({ store }) {
  const set = (relief) => store.set({ relief });
  const auto = (p) => p.relief.autoExaggeration;

  const exaggeration = rangeField({
    label: 'Vertical exaggeration', unit: '×', min: 0.5, max: 15, step: 0.1, digits: 2, inputMax: 30, testId: 'exaggeration',
    hint: 'Mountains are flat at map scale – a 4 km peak on a 1:850,000 map is only 4.7 mm tall. Exaggeration stretches heights so the relief reads from across the room.',
    get: (p, rt) => (auto(p) && rt.zmap ? rt.zmap.exaggeration : p.relief.exaggeration),
    set: (v) => set({ exaggeration: v }),
    disabled: auto,
  });
  const autoToggle = toggleField({
    label: 'Automatic – aim for a relief height', testId: 'auto-exaggeration',
    get: (p) => p.relief.autoExaggeration, set: (v) => set({ autoExaggeration: v }),
  });
  const target = rangeField({
    label: 'Target relief', unit: 'mm', min: 5, max: 80, step: 1, digits: 1, inputMax: 300,
    hint: 'Height from the base to the highest summit.',
    get: (p) => p.relief.targetReliefMm, set: (v) => set({ targetReliefMm: v }), visible: auto,
  });
  const base = rangeField({
    label: 'Base thickness', unit: 'mm', min: 0.6, max: 15, step: 0.1, digits: 2, inputMax: 60, testId: 'base',
    hint: 'Solid plate under the lowest terrain. 2–4 mm keeps large tiles flat and stiff.',
    get: (p) => p.relief.baseMm, set: (v) => set({ baseMm: v }),
  });
  const floor = segmentedField({
    label: 'Floor', options: [['auto', 'Auto'], ['sea', 'Sea level'], ['fixed', 'Fixed']],
    hint: 'The elevation that sits on top of the base. Auto starts just below the lowest point so the full height range is used; Sea level keeps coasts honest.',
    get: (p) => p.relief.floor.mode, set: (v) => set({ floor: { mode: v } }),
  });
  const floorElevation = numberField({
    label: 'Floor elevation', unit: 'm', step: 50, min: -500, max: 9000, digits: 0,
    get: (p) => p.relief.floor.elevationM, set: (v) => set({ floor: { elevationM: v } }),
    visible: (p) => p.relief.floor.mode === 'fixed',
  });
  const smoothing = rangeField({
    label: 'Smoothing', unit: 'mm', min: 0, max: 3, step: 0.05, digits: 2, inputMax: 10,
    hint: 'Softens noise smaller than this on the print. 0.3–0.6 mm matches a 0.4 mm nozzle.',
    get: (p) => p.relief.smoothingMm, set: (v) => set({ smoothingMm: v }),
  });
  const water = selectField({
    label: 'Lakes & sea', options: [['recess', 'Recessed (flat, slightly lower)'], ['flat', 'Flat'], ['none', 'Like terrain']],
    get: (p) => p.relief.water.mode, set: (v) => set({ water: { mode: v } }),
  });
  const waterDepth = rangeField({
    label: 'Water depth', unit: 'mm', min: 0, max: 3, step: 0.1, digits: 2, inputMax: 5,
    hint: 'Lakes are lowered by this much so their shorelines catch the light.',
    get: (p) => p.relief.water.depthMm, set: (v) => set({ water: { depthMm: v } }),
    visible: (p) => p.relief.water.mode === 'recess',
  });

  // 'Custom' stays selected (even on a preset value) until another preset is picked.
  let customChosen = false;
  const isCustom = (p) => customChosen || resolutionPreset(p.relief.resolutionMm) === 'custom';
  const resolution = segmentedField({
    label: 'Export detail', options: RESOLUTION_PRESETS, compact: true, testId: 'resolution',
    get: (p) => (isCustom(p) ? 'custom' : resolutionPreset(p.relief.resolutionMm)),
    set: (v) => {
      customChosen = v === 'custom';
      set(customChosen ? {} : { resolutionMm: Number(v) });
    },
  });
  const resolutionCustom = numberField({
    label: 'Sample spacing', unit: 'mm', step: 0.05, min: 0.1, max: 2, digits: 3,
    get: (p) => p.relief.resolutionMm, set: (v) => set({ resolutionMm: v }),
    visible: isCustom,
  });
  const resolutionInfo = valueRow({
    label: 'On the ground',
    hint: 'Spacing between height samples in the exported STL. Finer than your nozzle width brings no extra detail but bigger files.',
    get: (p, rt) => `${formatNumber(p.relief.resolutionMm * rt.layout.scaleMPerMm, 0)} m between samples`,
  });
  const simplify = rangeField({
    label: 'Mesh simplification', unit: 'mm', min: 0, max: 0.2, step: 0.005, digits: 3, inputMax: 1,
    hint: 'Merges triangles that deviate less than this from the surface – much smaller files, invisible on the print. 0 = full grid.',
    get: (p) => p.relief.simplifyMm, set: (v) => set({ simplifyMm: v }),
  });
  const maxHeight = numberField({
    label: 'Max height', unit: 'mm', step: 1, min: 0, max: 1000, digits: 1,
    hint: 'Clips summits above this height (0 = no limit).',
    get: (p) => p.relief.maxHeightMm, set: (v) => set({ maxHeightMm: v }),
  });
  const result = valueRow({
    label: 'Tallest point', testId: 'max-z',
    get: (p, rt) => (rt.zmap ? `${formatMm(rt.zmap.maxZMm, { digits: 1 })} at ${formatNumber(rt.zmap.exaggeration, 1)}×` : '…'),
  });
  const thin = hintBlock('With so little relief the terrain is barely visible – raise the exaggeration or turn on Automatic.', {
    tone: 'warn', visible: (p, rt) => Boolean(rt.zmap) && rt.zmap.maxZMm - rt.zmap.baseMm < 3,
  });
  const tall = hintBlock('This relief is very tall: summits become fragile and every extra millimetre adds print time. '
    + 'For a smaller area, less exaggeration (or Automatic with ~25 mm) usually looks more natural.', {
    tone: 'warn', visible: (p, rt) => Boolean(rt.zmap) && rt.zmap.maxZMm - rt.zmap.baseMm > TALL_RELIEF_MM,
  });

  const controls = [
    exaggeration, autoToggle, target, result, thin, tall, base, floor, floorElevation, smoothing, water, waterDepth,
    resolution, resolutionCustom, resolutionInfo, simplify, maxHeight,
  ];
  const el = h('div', { class: 'section-relief' },
    exaggeration.el, autoToggle.el, target.el, result.el, thin.el, tall.el,
    h('h3', { class: 'subhead' }, 'Base & floor'), base.el, floor.el, floorElevation.el,
    h('h3', { class: 'subhead' }, 'Surface'), smoothing.el, water.el, waterDepth.el,
    h('h3', { class: 'subhead' }, 'Export'), resolution.el, resolutionCustom.el, resolutionInfo.el, simplify.el, maxHeight.el);
  return {
    el,
    sync(p, rt) {
      for (const c of controls) c.sync(p, rt);
    },
  };
}

/**
 * Preset id ('0.25' | '0.4' | '0.6' | 'custom') of a sample spacing.
 * @param {number} mm
 * @returns {string}
 */
export function resolutionPreset(mm) {
  const hit = RESOLUTION_PRESETS.find(([v]) => v !== 'custom' && Math.abs(Number(v) - mm) < 1e-9);
  return hit ? hit[0] : 'custom';
}

