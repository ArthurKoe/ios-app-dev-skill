// Section 1 – Place: region picker, presets, place search, frame numbers and data source.

import { searchPlaces } from '../map/search.js';
import { h, replaceChildren } from './dom.js';
import { icon } from './icons.js';
import { group, hintBlock, numberField, rangeField, segmentedField, valueRow } from './controls.js';
import { formatBytes, formatKm, formatNumber } from './format.js';

const GROUP_ORDER = ['Europe', 'Asia', 'Africa', 'North America', 'South America', 'Oceania', 'Antarctica'];
export const WORLD_ID = 'world';

/**
 * @param {{store:object, runtime:object, actions:object, toast:object}} ctx
 * @returns {{el:HTMLElement, sync:(p:object, rt:object)=>void}}
 */
export function createPlaceSection(ctx) {
  const { store, actions } = ctx;
  const picker = regionPicker(ctx);
  const presets = presetList(ctx);
  const search = placeSearch(ctx);

  const frameFields = group([
    group([
      numberField({ label: 'Centre latitude', unit: '°', step: 0.01, min: -84, max: 84, digits: 4, testId: 'frame-lat',
        get: (p) => p.frame.lat, set: (v) => store.set({ frame: { lat: v } }) }),
      numberField({ label: 'Centre longitude', unit: '°', step: 0.01, min: -180, max: 180, digits: 4, testId: 'frame-lon',
        get: (p) => p.frame.lon, set: (v) => store.set({ frame: { lon: v } }) }),
    ], { class: 'field-pair' }),
    group([
      numberField({ label: 'Width', unit: 'km', step: 1, min: 0.5, max: 5000, digits: 2, testId: 'frame-width',
        get: (p) => p.frame.widthKm, set: (v) => store.set({ frame: { widthKm: v } }) }),
      valueRow({ label: 'Height', testId: 'frame-height', get: (p) => formatKm(p.frame.heightKm),
        hint: 'Follows the artwork proportions.' }),
    ], { class: 'field-pair' }),
    rangeField({ label: 'Rotation', unit: '°', min: -180, max: 180, step: 1, digits: 1, testId: 'frame-rotation',
      hint: 'Turns the map so a valley or ridge runs along the artwork. 0° = north up.',
      get: (p) => p.frame.rotationDeg, set: (v) => store.set({ frame: { rotationDeg: v } }) }),
  ]);

  const source = segmentedField({
    label: 'Elevation data', testId: 'source',
    options: [['auto', 'Auto'], ['local', 'Stored'], ['live', 'Live']],
    get: (p) => p.source, set: (v) => store.set({ source: v }),
    hint: 'Auto uses the stored high-resolution Copernicus data while the frame lies inside the region, '
      + 'and live AWS Terrain Tiles (worldwide, needs internet) everywhere else.',
  });
  const sourceUsed = valueRow({
    label: 'In use',
    testId: 'source-used',
    get: (p, rt) => {
      const s = rt.preview?.stats;
      if (!s) return '…';
      return `${s.source === 'live' ? 'Live – ' : ''}${s.levelLabel}`;
    },
  });
  const missing = hintBlock('Part of the frame has no elevation data and prints at the floor level. Move the frame or use live data.', {
    tone: 'warn', visible: (p, rt) => (rt.preview?.stats?.missingFraction ?? 0) > 0.01,
  });

  const controls = [picker, presets, search, frameFields, source, sourceUsed, missing];
  const el = h('div', { class: 'section-place' },
    picker.el,
    h('h3', { class: 'subhead' }, 'Presets'), presets.el,
    h('h3', { class: 'subhead' }, 'Find a place'), search.el,
    h('h3', { class: 'subhead' }, 'Frame'),
    h('p', { class: 'hint' }, 'Drag the frame on the map to move it, its corners to resize and the round handle to rotate.'),
    frameFields.el, source.el, sourceUsed.el, missing.el);
  return {
    el,
    sync(p, rt) {
      for (const c of controls) c.sync(p, rt);
    },
  };
}

/**
 * Region display name ('Anywhere on Earth' for 'world').
 * @param {object|null} regionsIndex
 * @param {string} regionId
 * @returns {string}
 */
export function regionName(regionsIndex, regionId) {
  if (regionId === WORLD_ID) return 'Anywhere on Earth';
  return regionsIndex?.regions?.find((r) => r.id === regionId)?.name ?? regionId;
}

// ---------------------------------------------------------------------------------------------

function regionPicker({ actions, runtime }) {
  const current = h('span', { class: 'region-current-body' });
  const button = h('button', {
    type: 'button', class: 'region-current', 'aria-haspopup': 'dialog', 'aria-expanded': 'false', 'data-testid': 'region-button',
  }, current, h('span', { class: 'region-chevron' }, icon('chevron', { size: 16 })));
  const popover = h('div', { class: 'region-popover', hidden: true, role: 'dialog', 'aria-label': 'Choose a region' });
  const el = h('div', { class: 'region-picker' }, button, popover);
  let shownId = null;

  const close = (focus = true) => {
    popover.hidden = true;
    button.setAttribute('aria-expanded', 'false');
    if (focus) button.focus();
  };
  const open = () => {
    popover.hidden = false;
    button.setAttribute('aria-expanded', 'true');
    (popover.querySelector('[aria-current="true"]') ?? popover.querySelector('button'))?.focus();
  };
  button.addEventListener('click', () => (popover.hidden ? open() : close()));
  popover.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      e.stopPropagation();
      close();
    }
  });
  document.addEventListener('pointerdown', (e) => {
    if (!popover.hidden && !el.contains(/** @type {Node} */ (e.target))) close(false);
  });

  function card(region) {
    const isWorld = region.id === WORLD_ID;
    return h('button', {
      type: 'button', class: 'region-card', 'data-region': region.id,
      onClick: () => {
        close();
        actions.selectRegion(region.id);
      },
    },
    isWorld
      ? h('span', { class: 'region-thumb region-thumb-world' }, icon('globe', { size: 30 }))
      : h('img', { class: 'region-thumb', src: actions.dataUrl(region.thumbnail), alt: '', loading: 'lazy', width: 72, height: 54 }),
    h('span', { class: 'region-text' },
      h('span', { class: 'region-name' }, region.name),
      h('span', { class: 'region-sub' }, region.subtitle ?? ''),
      h('span', { class: 'region-meta' }, isWorld
        ? 'Live AWS Terrain Tiles · ~30–150 m'
        : `Best ${formatNumber(region.bestResolutionM, 0)} m${region.bytes ? ` · ${formatBytes(region.bytes)}` : ''}`)));
  }

  function rebuild() {
    const regions = runtime.regionsIndex?.regions ?? [];
    const groups = new Map();
    for (const r of regions) {
      const g = r.group || 'Other';
      if (!groups.has(g)) groups.set(g, []);
      groups.get(g).push(r);
    }
    const order = [...groups.keys()].sort((a, b) => rank(a) - rank(b) || a.localeCompare(b));
    replaceChildren(popover,
      order.map((g) => h('div', { class: 'region-group' }, h('h3', { class: 'region-group-title' }, g), groups.get(g).map(card))),
      h('div', { class: 'region-group' }, h('h3', { class: 'region-group-title' }, 'Everywhere else'),
        card({ id: WORLD_ID, name: 'Anywhere on Earth', subtitle: 'Live elevation data for any mountain range' })));
    shownId = null;
  }

  rebuild();
  return {
    el,
    sync(p) {
      if (shownId === p.regionId) return;
      shownId = p.regionId;
      const region = runtime.regionsIndex?.regions?.find((r) => r.id === p.regionId);
      replaceChildren(current,
        region
          ? h('img', { class: 'region-thumb', src: actions.dataUrl(region.thumbnail), alt: '', width: 72, height: 54 })
          : h('span', { class: 'region-thumb region-thumb-world' }, icon('globe', { size: 30 })),
        h('span', { class: 'region-text' },
          h('span', { class: 'region-name' }, region?.name ?? 'Anywhere on Earth'),
          h('span', { class: 'region-sub' }, region ? region.subtitle ?? '' : 'Live elevation data, worldwide')));
      for (const b of popover.querySelectorAll('.region-card')) {
        b.setAttribute('aria-current', String(b.dataset.region === p.regionId));
      }
    },
  };
}

function rank(groupName) {
  const i = GROUP_ORDER.indexOf(groupName);
  return i < 0 ? GROUP_ORDER.length : i;
}

/** Presets shown before "Show all". */
const PRESETS_COLLAPSED = 8;

function presetList({ actions, runtime }) {
  const el = h('div', { class: 'preset-list', role: 'group', 'aria-label': 'Presets' });
  let key = '';
  let regionId = null;
  let expanded = false;

  const presetsFor = (id) => (id === WORLD_ID
    ? runtime.regionsIndex?.worldPresets ?? []
    : runtime.manifests.get(id)?.presets ?? null);

  function render(list) {
    if (list === null) {
      replaceChildren(el, h('p', { class: 'hint' }, 'Loading presets…'));
      return;
    }
    if (!list.length) {
      replaceChildren(el, h('p', { class: 'hint' }, 'No presets for this region – drag the frame on the map.'));
      return;
    }
    const shown = expanded ? list : list.slice(0, PRESETS_COLLAPSED);
    replaceChildren(el, shown.map((preset) => h('button', {
      type: 'button', class: 'chip', title: `${preset.name} – ${formatKm(preset.widthKm)} × ${formatKm(preset.heightKm)}`,
      onClick: () => actions.applyPreset(preset),
    }, preset.name)),
    list.length > PRESETS_COLLAPSED ? h('button', {
      type: 'button', class: 'chip preset-more', 'aria-expanded': String(expanded),
      onClick: () => {
        expanded = !expanded;
        update();
      },
    }, expanded ? 'Show fewer' : `+ ${list.length - PRESETS_COLLAPSED} more`) : null);
  }

  function update() {
    const list = presetsFor(regionId);
    if (list === null) actions.ensureManifest(regionId);
    const next = `${regionId}|${list?.length ?? 'loading'}|${expanded}`;
    if (next === key) return;
    key = next;
    render(list);
  }

  return {
    el,
    sync(p) {
      if (p.regionId !== regionId) {
        regionId = p.regionId;
        expanded = false;
      }
      update();
    },
  };
}

function placeSearch({ actions, toast }) {
  const input = h('input', {
    type: 'search', class: 'input', placeholder: 'Mountain, town or “46.55, 7.98”', 'aria-label': 'Search for a place',
    autocomplete: 'off', enterkeyhint: 'search',
  });
  const button = h('button', { type: 'submit', class: 'icon-btn', 'aria-label': 'Search' }, icon('search'));
  const results = h('ul', { class: 'search-results', hidden: true, 'aria-live': 'polite' });
  const form = h('form', { class: 'search-form', role: 'search' }, input, button);
  let controller = null;
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const q = input.value.trim();
    if (!q) return;
    controller?.abort();
    controller = new AbortController();
    results.hidden = false;
    replaceChildren(results, h('li', { class: 'hint' }, 'Searching…'));
    try {
      const places = await searchPlaces(q, { signal: controller.signal });
      if (!places.length) {
        replaceChildren(results, h('li', { class: 'hint' }, 'No places found.'));
        return;
      }
      replaceChildren(results, places.map((place) => h('li', null, h('button', {
        type: 'button', class: 'search-result',
        onClick: () => {
          results.hidden = true;
          actions.goToPlace(place);
        },
      }, h('span', { class: 'search-title' }, place.title ?? place.name), h('span', { class: 'search-detail' }, place.name)))));
    } catch (err) {
      if (err?.name === 'AbortError') return;
      results.hidden = true;
      toast.warn(err?.message ?? 'Place search failed.');
    }
  });
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') results.hidden = true;
  });
  return { el: h('div', { class: 'place-search' }, form, results), sync() {} };
}
