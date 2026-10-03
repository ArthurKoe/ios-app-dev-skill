// Section 5 – Colours & filament: material, single colour or elevation bands, themes,
// band editor, layer heights and the filament library.

import { getArtStyle } from '../catalog/artStyles.js';
import { getFilament } from '../catalog/filaments.js';
import { MATERIALS, getMaterial } from '../catalog/materials.js';
import { THEMES, applyTheme } from '../catalog/themes.js';
import { h } from './dom.js';
import { icon } from './icons.js';
import { hintBlock, rangeField, segmentedField, selectField } from './controls.js';
import { createBandEditor } from './bandEditor.js';
import { createFilamentPicker } from './filamentPicker.js';

/**
 * @param {{store:object, runtime:object, actions:object}} ctx
 * @returns {{el:HTMLElement, sync:(p:object, rt:object)=>void}}
 */
export function createColorsSection(ctx) {
  const { store, actions } = ctx;
  const bandsSupported = (p) => getArtStyle(p.style.id).supportsBands;

  const material = selectField({
    label: 'Material', testId: 'material',
    options: Object.values(MATERIALS).map((m) => [m.id, m.name]),
    get: (p) => p.print.material, set: (v) => store.set({ print: { material: v } }),
  });
  const materialNote = h('p', { class: 'hint' });
  const mode = segmentedField({
    label: 'Colours', testId: 'color-mode',
    options: [['single', 'Single colour'], ['bands', 'Elevation bands']],
    get: (p) => p.colors.mode, set: (v) => store.set({ colors: { mode: v } }),
    disabled: (p) => !bandsSupported(p),
  });
  const lithoNote = hintBlock('Lithophanes are printed in one light colour – the image comes from the thickness.', {
    visible: (p) => !bandsSupported(p),
  });

  const themes = themeSwatches(ctx);
  const single = createFilamentPicker({
    label: 'Filament', testId: 'single-filament',
    onChange: (id) => store.set({ colors: { singleFilamentId: id } }),
  });
  const singleField = h('div', { class: 'field' }, h('div', { class: 'field-row' }, h('span', { class: 'field-label' }, 'Filament'), single.el));
  const bands = createBandEditor({ store });
  const waterHint = waterThemeHint(ctx);
  const bandHint = hintBlock('Each colour starts at a fixed layer. Your slicer pauses there so you can swap the filament – the layers are the same for every tile, so one colour-change list works for the whole artwork.');

  const layer = rangeField({
    label: 'Layer height', unit: 'mm', min: 0.08, max: 0.32, step: 0.02, digits: 2, inputMax: 0.6, testId: 'layer-height',
    hint: 'Thinner layers show finer contours and smoother colour transitions but print slower.',
    get: (p) => p.colors.layerHeightMm, set: (v) => store.set({ colors: { layerHeightMm: v } }),
  });
  const first = rangeField({
    label: 'First layer', unit: 'mm', min: 0.1, max: 0.4, step: 0.02, digits: 2, inputMax: 0.8,
    get: (p) => p.colors.firstLayerMm, set: (v) => store.set({ colors: { firstLayerMm: v } }),
  });
  const libraryBtn = h('button', { type: 'button', class: 'btn btn-ghost', 'data-testid': 'open-library', onClick: () => actions.openFilamentLibrary() },
    icon('palette', { size: 16 }), 'Filament library…');

  const el = h('div', { class: 'section-colors' },
    material.el, materialNote, mode.el, lithoNote.el,
    h('h3', { class: 'subhead' }, 'Theme'), themes.el, waterHint.el,
    singleField, bands.el, bandHint.el,
    h('h3', { class: 'subhead' }, 'Layers'), layer.el, first.el,
    h('div', { class: 'button-row' }, libraryBtn));

  return {
    el,
    sync(p, rt) {
      material.sync(p, rt);
      const note = getMaterial(p.print.material).notes ?? '';
      if (materialNote.textContent !== note) materialNote.textContent = note;
      mode.sync(p, rt);
      lithoNote.sync(p, rt);
      themes.sync(p, rt);
      waterHint.sync(p, rt);
      const isSingle = p.colors.mode === 'single' || !bandsSupported(p);
      singleField.hidden = !isSingle;
      if (isSingle) single.update(p, p.colors.singleFilamentId);
      bands.el.hidden = isSingle;
      bandHint.el.hidden = isSingle;
      if (!isSingle) bands.sync(p, rt);
      layer.sync(p, rt);
      first.sync(p, rt);
    },
  };
}

/**
 * Theme buttons showing the filament colours as stripes.
 * @param {{store:object, runtime:object}} ctx
 */
function themeSwatches({ store, runtime }) {
  const buttons = THEMES.map((theme) => {
    const stripes = h('span', { class: 'theme-stripes', 'aria-hidden': 'true' });
    const btn = h('button', {
      type: 'button', class: 'theme-swatch', title: theme.description, 'aria-pressed': 'false', 'data-testid': `theme-${theme.id}`,
      onClick: () => selectTheme(store, runtime, theme),
    }, stripes, h('span', { class: 'theme-name' }, theme.name));
    return { theme, btn, stripes, key: '' };
  });
  const el = h('div', { class: 'theme-grid', role: 'group', 'aria-label': 'Colour themes' }, buttons.map((b) => b.btn));
  return {
    el,
    sync(p) {
      for (const b of buttons) {
        const colors = b.theme.bands.map((band) => getFilament(p, band.filamentId).color);
        const key = colors.join();
        if (key !== b.key) {
          b.key = key;
          b.stripes.replaceChildren(...colors.map((c) => h('span', { style: { background: c } })));
        }
        const on = p.colors.themeId === b.theme.id;
        b.btn.setAttribute('aria-pressed', String(on));
        b.btn.classList.toggle('is-selected', on);
      }
    },
  };
}

/** Themes whose lowest band is a water colour. */
const WATER_THEMES = new Set(['island', 'nordic-fjord']);
/** Share of sea / lake samples from which the water-theme suggestion appears. */
const WATER_HINT_SHARE = 0.15;

/**
 * Suggests a theme with blue water when much of the frame is sea or lakes (otherwise the sea is
 * printed in the lowest land colour).
 * @param {{store:object, runtime:object}} ctx
 */
function waterThemeHint({ store, runtime }) {
  const text = h('span');
  const button = h('button', {
    type: 'button', class: 'btn btn-small btn-ghost', 'data-testid': 'water-theme',
    onClick: () => selectTheme(store, runtime, THEMES.find((t) => t.id === 'island')),
  }, 'Use the Island theme');
  const el = h('div', { class: 'hint-block hint-info water-hint', hidden: true },
    icon('water', { size: 16 }), h('div', null, text, ' ', button));
  return {
    el,
    sync(p, rt) {
      const share = rt.preview?.stats?.waterFraction ?? 0;
      const show = share >= WATER_HINT_SHARE && p.colors.mode === 'bands' && getArtStyle(p.style.id).supportsBands
        && !WATER_THEMES.has(p.colors.themeId);
      el.hidden = !show;
      if (show) text.textContent = `About ${Math.round(share * 100)} % of this frame is sea or lakes, printed in the lowest colour. Island and Nordic Fjord print water in blue.`;
    },
  };
}

/** Applies a theme: single-colour themes switch to single mode; band themes fit to the terrain. */
function selectTheme(store, runtime, theme) {
  const p = store.get();
  const region = runtime.regionsIndex?.regions?.find((r) => r.id === p.regionId);
  const zmap = runtime.zmap ?? { floorM: 0, maxElevM: region?.elevation?.max ?? 4000 };
  store.set((d) => {
    d.colors.themeId = theme.id;
    if (theme.mode === 'single') {
      d.colors.mode = 'single';
      d.colors.singleFilamentId = theme.bands[0].filamentId;
    } else {
      d.colors.mode = 'bands';
      d.colors.autoFit = true;
      d.colors.bands = applyTheme(theme, zmap);
    }
  });
}
