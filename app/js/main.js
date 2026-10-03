// Relief Studio – application shell: wires the project store, map, 3D preview, engine worker,
// sidebar, export and persistence together.

import { getArtStyle } from './catalog/artStyles.js';
import { resolveBands } from './catalog/bands.js';
import { chooseSource } from './dem/sampler.js';
import { EngineClient, isAbortError } from './engine/engineClient.js';
import { buildPrintPlanHtml } from './export/printPlan.js';
import { createZipWriter, downloadBlob } from './export/zip.js';
import { MapView } from './map/mapView.js';
import { computeLayout, exportResolutionMm } from './model/layout.js';
import { Preview3D } from './preview/preview3d.js';
import { createAutosave, loadInitialProject, projectFromJSON, projectToHash, projectToJSON } from './state/persistence.js';
import {
  DEFAULT_PROJECT, artworkAspect, boundsToRect, createDefaultProject, frameForRect, sameValue, slugify,
} from './state/project.js';
import { createStore } from './state/store.js';
import { createBackSection } from './ui/sectionBack.js';
import { createColorsSection } from './ui/sectionColors.js';
import { createEstimateSection } from './ui/sectionEstimate.js';
import { createExportSection } from './ui/sectionExport.js';
import { WORLD_ID, createPlaceSection, regionName } from './ui/sectionPlace.js';
import { createPrinterSection } from './ui/sectionPrinter.js';
import { createReliefSection } from './ui/sectionRelief.js';
import { createStyleSection } from './ui/sectionStyle.js';
import { createExportDialog } from './ui/exportDialog.js';
import { createFilamentDialog } from './ui/filamentDialog.js';
import { createHeader } from './ui/header.js';
import { createHelpDialog } from './ui/helpDialog.js';
import { createProgress } from './ui/progress.js';
import { createSidebar } from './ui/sidebar.js';
import { createStatusBar } from './ui/statusBar.js';
import { createToaster } from './ui/toasts.js';
import { createViewModes } from './ui/viewModes.js';
import { createViewToolbar } from './ui/viewToolbar.js';
import { debounce, downloadText, h, readPref, writePref } from './ui/dom.js';
import { formatKm, formatNumber } from './ui/format.js';

/** Location of the elevation data, relative to the page. */
const DATA_BASE_URL = './data/';
/** Delay between the last terrain-affecting change and the preview request. */
const PREVIEW_DEBOUNCE_MS = 300;
/** Delay between the last colour / print-setting change and the estimate request. */
const ESTIMATE_DEBOUNCE_MS = 120;
/** A frame with more missing samples than this gets a warning. */
const MISSING_DATA_WARN = 0.01;
const EMPTY_INDEX = Object.freeze({ regions: [], worldPresets: [], attribution: '' });

const $ = (id) => /** @type {HTMLElement} */ (document.getElementById(id));

start().catch((err) => {
  console.error(err);
  showFatal(err);
});

async function start() {
  const toast = createToaster($('toasts'));
  const dataBase = new URL(DATA_BASE_URL, document.baseURI);
  const regionsIndex = await loadRegionsIndex(dataBase, toast);
  const initial = loadInitialProject();
  const store = createStore(initial.project);
  initial.warnings.forEach((w) => toast.warn(w));
  ensureKnownRegion(store, regionsIndex, toast);

  /** Mutable app state that is not part of the project (results, busy flags, caches). */
  const runtime = {
    regionsIndex,
    manifests: new Map(),
    layout: computeLayout(store.get(), exportResolutionMm(store.get())),
    preview: null,
    previewStyleId: null,
    zmap: null,
    bands: [],
    estimate: null,
    busy: true,
    error: null,
    exporting: false,
  };
  const engineCtx = { regionsIndex, dataBaseUrl: DATA_BASE_URL };
  const engine = new EngineClient(new URL('./engine/engine.worker.js', import.meta.url));
  const progress = createProgress({ bar: $('progress-bar'), caption: $('preview-status') });
  const mapView = createMap(regionsIndex, toast);
  /** The 3D preview is created last: the first preview request is already running by then. */
  let preview = null;
  const manifestRequests = new Map();

  // -------------------------------------------------------------------------- actions
  const dataUrl = (path) => new URL(path, dataBase).href;
  const findRegion = (id) => regionsIndex.regions.find((r) => r.id === id) ?? null;

  function ensureManifest(regionId) {
    const region = findRegion(regionId);
    if (!region || manifestRequests.has(regionId)) return manifestRequests.get(regionId) ?? Promise.resolve(null);
    const request = fetch(dataUrl(region.manifest))
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`))))
      .catch((err) => {
        console.warn('Could not load the region manifest', err);
        return { presets: [] };
      })
      .then((manifest) => {
        runtime.manifests.set(regionId, manifest);
        scheduleUI();
        return manifest;
      });
    manifestRequests.set(regionId, request);
    return request;
  }

  /** Frame with the artwork aspect around `rect`, kept inside the region's stored data if possible. */
  function frameFor(rect, regionId) {
    return frameForRect(rect, artworkAspect(store.get().layout), findRegion(regionId)?.bounds ?? null);
  }

  const actions = {
    dataUrl,
    ensureManifest,
    currentProject: () => store.get(),
    async selectRegion(regionId) {
      if (regionId === WORLD_ID) {
        // Keep the frame (and the name): pick a world preset, search a place or drag the frame.
        store.set({ regionId: WORLD_ID }, { source: 'region' });
        return;
      }
      const region = findRegion(regionId);
      if (!region) return;
      const manifest = await ensureManifest(regionId);
      // Open on the widest preset (the whole range); the smaller ones are a click away.
      const rect = widestPreset(manifest?.presets) ?? boundsToRect(region.bounds);
      const p = store.get();
      // A project still named after a region (not renamed by the user) follows the new region's name.
      const named = [DEFAULT_PROJECT.name, regionName(regionsIndex, p.regionId), ...regionsIndex.regions.map((r) => r.name)];
      const name = named.includes(p.name) ? region.name : p.name;
      store.set({ regionId, name, frame: frameFor(rect, regionId) }, { source: 'region' });
      mapView?.fitFrame();
    },
    applyPreset(preset) {
      store.set({ frame: frameFor(preset, store.get().regionId) }, { source: 'preset' });
      mapView?.fitFrame();
      const f = store.get().frame;
      if (f.widthKm < preset.widthKm * 0.98 || f.heightKm < preset.heightKm * 0.98) {
        toast.info(`${preset.name} is cropped to ${formatKm(f.widthKm)} × ${formatKm(f.heightKm)} so it matches the artwork `
          + 'proportions and stays on the stored high-resolution data.');
      }
    },
    goToPlace(place) {
      const [south, west, north, east] = place.bbox;
      const rect = boundsToRect({ south, west, north, east });
      const p = store.get();
      const inside = (r) => r && place.lat >= r.bounds.south && place.lat <= r.bounds.north
        && place.lon >= r.bounds.west && place.lon <= r.bounds.east;
      const regionId = inside(findRegion(p.regionId)) ? p.regionId : regionsIndex.regions.find(inside)?.id ?? WORLD_ID;
      const frame = rect.widthKm > 5 || rect.heightKm > 5
        ? frameFor({ ...rect, lat: place.lat, lon: place.lon, widthKm: rect.widthKm * 1.15, heightKm: rect.heightKm * 1.15 }, regionId)
        : { ...p.frame, lat: place.lat, lon: place.lon };
      store.set({ regionId, frame }, { source: 'search' });
      mapView?.fitFrame();
    },
    openFilamentLibrary: () => filamentDialog.open(),
    startExport: (opts) => runExport(opts),
    openPrintPlan,
    saveProjectFile() {
      const p = store.get();
      downloadText(projectToJSON(p), `${slugify(p.name)}.relief.json`);
    },
    newProject() {
      if (!confirm('Start a new project? The current one will be replaced (save it first if you want to keep it).')) return;
      store.set(() => createDefaultProject(), { source: 'new' });
      ensureKnownRegion(store, regionsIndex, toast);
      mapView?.fitFrame();
    },
    async openProject(file) {
      try {
        const warnings = [];
        const project = projectFromJSON(await file.text(), { warnings });
        store.set(() => project, { source: 'open' });
        ensureKnownRegion(store, regionsIndex, toast);
        warnings.forEach((w) => toast.warn(w));
        mapView?.fitFrame();
        toast.success(`Opened “${project.name}”.`);
      } catch (err) {
        toast.error(err.message);
      }
    },
    async shareLink() {
      const url = `${location.origin}${location.pathname}${location.search}${projectToHash(store.get())}`;
      history.replaceState(null, '', url);
      hashIsCurrent = true;
      try {
        await navigator.clipboard.writeText(url);
        toast.success('Link copied – anyone with it opens exactly this design.');
      } catch {
        toast.info('The share link is now in the address bar – copy it from there.');
      }
    },
    openHelp: () => helpDialog.open(),
  };

  // -------------------------------------------------------------------------- UI
  const ctx = { store, runtime, actions, toast };
  const header = createHeader($('app-header'), { store, actions });
  const sidebar = createSidebar($('sidebar'), [
    { id: 'place', title: 'Place', short: 'Place', content: createPlaceSection(ctx),
      summary: (p) => `${regionName(regionsIndex, p.regionId)} · ${formatKm(p.frame.widthKm)}` },
    { id: 'printer', title: 'Printer & tiles', short: 'Tiles', content: createPrinterSection(ctx),
      summary: (p) => `${p.layout.cols} × ${p.layout.rows} tiles` },
    { id: 'relief', title: 'Relief', short: 'Relief', content: createReliefSection(ctx),
      summary: (p, rt) => (rt.zmap
        ? `${formatNumber(rt.zmap.exaggeration, 1)}×${p.relief.autoExaggeration ? ' auto' : ''} · ${formatNumber(rt.zmap.maxZMm, 0)} mm`
        : `${p.relief.autoExaggeration ? 'auto' : `${formatNumber(p.relief.exaggeration, 1)}×`}`) },
    { id: 'style', title: 'Art style', short: 'Style', content: createStyleSection(ctx),
      summary: (p) => getArtStyle(p.style.id).name },
    { id: 'colors', title: 'Colours & filament', short: 'Colours', content: createColorsSection(ctx),
      summary: (p, rt) => (p.colors.mode === 'single' || !getArtStyle(p.style.id).supportsBands
        ? 'Single colour'
        : `${(rt.bands?.length ? rt.bands.filter((b) => !b.unused) : p.colors.bands).length} colours`) },
    { id: 'back', title: 'Back side', short: 'Back', content: createBackSection(ctx), collapsed: true,
      summary: (p) => [p.back.labels ? 'labels' : '', p.back.magnets.enabled ? 'magnets' : ''].filter(Boolean).join(' + ') || 'flat' },
    { id: 'estimate', title: 'Estimate', short: 'Estimate', content: createEstimateSection(ctx) },
    { id: 'export', title: 'Export', short: 'Export', content: createExportSection(ctx) },
  ]);
  const statusBar = createStatusBar($('status-bar'));
  const toolbar = createViewToolbar($('view-toolbar'), {
    store,
    onResetCamera: () => preview?.resetCamera(),
    onScreenshot: saveScreenshot,
  });
  const viewModes = createViewModes($('view-modes'), $('workspace'), () => {
    mapView?.resize();
    preview?.resize();
  });
  const filamentDialog = createFilamentDialog({ store, toast });
  const helpDialog = createHelpDialog();
  const exportDialog = createExportDialog({ onCancel: () => engine.cancel('export') });

  let uiFrame = 0;
  function scheduleUI() {
    if (uiFrame) return;
    uiFrame = requestAnimationFrame(() => {
      uiFrame = 0;
      const p = store.get();
      header.update(p);
      sidebar.update(p, runtime);
      statusBar.update(p, runtime);
      toolbar.update(p);
      // A failed update leaves the previous preview visible, greyed out as outdated.
      $('preview3d').classList.toggle('is-stale', Boolean(runtime.error));
    });
  }

  // -------------------------------------------------------------------------- preview & estimate
  let previewTimer = null;
  function schedulePreview(delay = PREVIEW_DEBOUNCE_MS) {
    clearTimeout(previewTimer);
    runtime.busy = true;
    previewTimer = setTimeout(runPreview, delay);
  }

  /** Closes the toast of the last failed preview once a preview succeeds again. */
  let closeErrorToast = null;
  async function runPreview() {
    const project = store.get();
    runtime.busy = true;
    runtime.error = null;
    progress.start('Preparing preview…');
    scheduleUI();
    try {
      const result = await engine.preview(project, engineCtx, (p) => progress.update(p));
      runtime.preview = result;
      runtime.previewStyleId = project.style.id;
      runtime.zmap = result.zmap;
      runtime.estimate = result.estimate;
      preview?.setTiles(result.tiles, { artW: result.layout.artW, artH: result.layout.artH, maxZ: result.zmap.maxZMm });
      applyAppearance();
      if (!sameEstimateInputs(project, store.get())) scheduleEstimate();
      reportDataQuality(result.stats, project);
      runtime.busy = false;
      progress.done();
      closeErrorToast?.();
      closeErrorToast = null;
    } catch (err) {
      if (isAbortError(err)) return; // superseded – the newer request owns the busy state
      logFailure('Preview failed', err);
      runtime.busy = false;
      runtime.error = err.message;
      progress.fail(isNetworkError(err) ? 'No elevation data – see the message below' : 'Preview failed');
      closeErrorToast?.();
      closeErrorToast = toast.error(friendlyError(err, project, regionsIndex));
    } finally {
      scheduleUI();
    }
  }

  const scheduleEstimate = debounce(async () => {
    if (!runtime.preview) return;
    try {
      const { estimate } = await engine.estimate(store.get(), engineCtx);
      runtime.estimate = estimate;
      scheduleUI();
    } catch (err) {
      if (!isAbortError(err)) console.warn('Estimate failed', err);
    }
  }, ESTIMATE_DEBOUNCE_MS);

  /** Colours follow the bands of the displayed preview (its zmap and style). */
  function applyAppearance() {
    const p = store.get();
    runtime.bands = resolveBands(p, runtime.zmap);
    const styleId = runtime.previewStyleId ?? p.style.id;
    preview?.setAppearance({
      mode: styleId === 'lithophane' ? 'lithophane' : p.colors.mode,
      bands: runtime.bands,
      layerHeightMm: p.colors.layerHeightMm,
      firstLayerMm: p.colors.firstLayerMm,
      layerLines: p.view.layerLines,
      flatShading: styleId === 'lowpoly',
      highlightWater: p.view.highlightWater,
    });
  }

  function applyView() {
    const v = store.get().view;
    preview?.setView({ lighting: v.lighting, wallColor: v.wallColor, wallMode: v.wallMode, exploded: v.exploded, seams: v.seams, labels: v.labels });
  }

  /** Data-quality notes, each shown once per situation (not after every preview). */
  const reported = new Set();
  function reportDataQuality(stats, project) {
    const once = (key, show) => {
      if (reported.has(key)) return;
      reported.add(key);
      show();
    };
    if (stats.missingFraction > MISSING_DATA_WARN) {
      const pct = (stats.missingFraction * 100).toFixed(0);
      once(`missing|${project.regionId}|${pct}`, () => toast.warn(`About ${pct} % of the frame has no elevation data and is printed at the floor level.`));
    }
    const region = findRegion(project.regionId);
    if (region && stats.source === 'live' && project.source === 'auto') {
      once(`live|${project.regionId}`, () => toast.info(`The frame reaches beyond the stored ${region.name} data, so live elevation tiles are used.`));
    }
  }

  // -------------------------------------------------------------------------- export & print plan
  function printPlanFor(project, data, screenshotDataUrl, files = []) {
    return buildPrintPlanHtml({
      project, layout: data.layout, zmap: data.zmap, bands: data.bands, estimate: data.estimate, stats: data.stats,
      screenshotDataUrl,
      attribution: data.stats.source === 'local' ? regionsIndex.attribution : '',
      regionName: regionName(regionsIndex, project.regionId),
      styleName: getArtStyle(project.style.id).name,
      files,
      resolutionMm: exportResolutionMm(project),
    });
  }

  async function screenshotOrNull() {
    try {
      return preview ? await preview.screenshot({ width: 1600, height: 1000, fit: true }) : null;
    } catch (err) {
      console.warn('Screenshot failed', err);
      return null;
    }
  }

  async function runExport({ format, tiles, prefix }) {
    if (runtime.exporting) return;
    const project = store.get();
    const labels = tiles ?? tileLabels(project.layout);
    runtime.exporting = true;
    scheduleUI();
    exportDialog.open(labels, format);
    const writer = createZipWriter();
    const add = (name, data) => writer.add(name, data).catch(() => {}); // errors surface in finish()
    try {
      const result = await engine.exportTiles(project, engineCtx, { format, tiles, prefix },
        (file) => {
          exportDialog.tileDone(file);
          add(file.name, file.buffer);
        },
        (p) => exportDialog.progress(p));
      exportDialog.status('Writing the print plan…');
      add('print-plan.html', printPlanFor(project, result, await screenshotOrNull(), result.files));
      add(`${result.prefix}.relief.json`, projectToJSON(project));
      exportDialog.status('Compressing…');
      const blob = await writer.finish();
      const filename = `${result.prefix}.zip`;
      downloadBlob(blob, filename);
      exportDialog.done({ blob, filename }, () => downloadBlob(blob, filename));
    } catch (err) {
      if (isAbortError(err)) {
        exportDialog.cancelled();
      } else {
        logFailure('Export failed', err);
        exportDialog.fail(friendlyError(err, project, regionsIndex));
      }
    } finally {
      runtime.exporting = false;
      scheduleUI();
    }
  }

  async function openPrintPlan() {
    if (!runtime.preview) {
      toast.info('The print plan is ready as soon as the preview has finished.');
      return;
    }
    const win = window.open('', '_blank');
    const project = store.get();
    const html = printPlanFor(project, { ...runtime.preview, estimate: runtime.estimate, bands: runtime.bands }, await screenshotOrNull());
    const blob = new Blob([html], { type: 'text/html' });
    if (win) {
      const url = URL.createObjectURL(blob);
      win.location.href = url;
      setTimeout(() => URL.revokeObjectURL(url), 60_000);
    } else {
      downloadBlob(blob, `${slugify(project.name)}-print-plan.html`);
      toast.info('Pop-ups are blocked, so the print plan was downloaded instead.');
    }
  }

  async function saveScreenshot() {
    if (!preview) return;
    try {
      const url = await preview.screenshot({ width: 2400, height: 1500 });
      const blob = await (await fetch(url)).blob();
      downloadBlob(blob, `${slugify(store.get().name)}.png`);
    } catch (err) {
      toast.error(`Screenshot failed: ${err.message}`);
    }
  }

  // -------------------------------------------------------------------------- change handling
  let hashIsCurrent = initial.origin === 'hash';
  /** True while a map drag has changed the frame that has not been previewed yet. */
  let draggedUnpreviewed = false;
  store.subscribe((p, prev, info) => {
    info.warnings.forEach((w) => toast.warn(w));
    const c = info.changes;
    // Map drags update the store live (map, layout, status) but preview only on release. The final
    // event usually repeats the last intermediate frame, so the change has to be remembered.
    const dragging = info.source === 'map' && info.final === false;
    if (dragging && c.terrain) draggedUnpreviewed = true;
    const dragEnded = !dragging && draggedUnpreviewed;
    if (dragEnded) draggedUnpreviewed = false;
    const affectsLayout = c.keys.some((k) => ['frame', 'layout', 'printer', 'relief', 'style'].includes(k));
    if (affectsLayout) runtime.layout = computeLayout(p, exportResolutionMm(p));
    if (mapView && c.keys.includes('regionId')) mapView.setRegion(p.regionId);
    if (mapView && !dragging && (affectsLayout || dragEnded || c.keys.includes('regionId'))) mapView.setFrame(p.frame, runtime.layout);
    if ((c.terrain || dragEnded) && !dragging) schedulePreview();
    if (c.appearance || c.view) applyAppearance();
    if (c.appearance) scheduleEstimate();
    if (c.view) applyView();
    if (c.name) document.title = `${p.name} – Relief Studio`;
    if (c.any && hashIsCurrent && info.source !== 'init') {
      hashIsCurrent = false;
      history.replaceState(null, '', location.pathname + location.search);
    }
    scheduleUI();
  });
  const autosave = createAutosave(store, { onError: () => toast.warn('Autosave is unavailable in this browser – use Save to keep your project.') });
  addEventListener('pagehide', () => autosave.flush());

  if (mapView) {
    mapView.addEventListener('framechange', (e) => store.set({ frame: e.detail.frame }, { source: 'map', final: e.detail.final }));
    mapView.addEventListener('regionselect', (e) => actions.selectRegion(e.detail.regionId));
    mapView.addEventListener('baselayerchange', (e) => writePref('baseLayer', e.detail.baseLayer));
    mapView.setRegion(store.get().regionId);
    mapView.setFrame(store.get().frame, runtime.layout);
    mapView.fitFrame();
  }

  installShortcuts({ actions, viewModes });
  document.title = `${store.get().name} – Relief Studio`;
  scheduleUI();
  // Post the first preview request before the (slow on weak GPUs) WebGL set-up, so the worker
  // loads and meshes the terrain while the 3D view initialises.
  runPreview();
  preview = createPreview(toast);
  applyView();
  applyAppearance();

  /** Test / debugging hook (see tests/e2e/). */
  window.__relief = {
    store, engine, mapView, runtime,
    get preview() { return preview; },
    get lastPreview() { return runtime.preview; },
  };
}

// ---------------------------------------------------------------------------------------------

async function loadRegionsIndex(dataBase, toast) {
  try {
    const res = await fetch(new URL('regions.json', dataBase));
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const index = await res.json();
    return { ...EMPTY_INDEX, ...index, regions: index.regions ?? [], worldPresets: index.worldPresets ?? [] };
  } catch (err) {
    console.warn('regions.json could not be loaded', err);
    toast.warn('The stored elevation data could not be loaded – only live data is available.');
    return EMPTY_INDEX;
  }
}

/** Projects that reference a region missing from this build fall back to live data. */
function ensureKnownRegion(store, regionsIndex, toast) {
  const id = store.get().regionId;
  if (id === WORLD_ID || regionsIndex.regions.some((r) => r.id === id)) return;
  store.set({ regionId: WORLD_ID }, { source: 'init' });
  if (regionsIndex.regions.length) toast.info(`The region “${id}” is not part of this build, so live elevation data is used.`);
}

function createMap(regionsIndex, toast) {
  try {
    return new MapView($('map'), { regionsIndex, dataBaseUrl: DATA_BASE_URL, baseLayer: readPref('baseLayer', 'topo') });
  } catch (err) {
    console.error(err);
    $('map').append(h('p', { class: 'pane-error' }, 'The map could not be shown.'));
    toast.error(`Map unavailable: ${err.message}`);
    return null;
  }
}

function createPreview(toast) {
  try {
    return new Preview3D($('preview3d'));
  } catch (err) {
    console.error(err);
    $('preview3d').append(h('p', { class: 'pane-error' }, '3D preview needs WebGL, which is not available in this browser. Everything else – estimates and export – still works.'));
    toast.warn('3D preview unavailable (no WebGL).');
    return null;
  }
}

function installShortcuts({ actions, viewModes }) {
  addEventListener('keydown', (e) => {
    const typing = /^(INPUT|SELECT|TEXTAREA)$/.test(/** @type {HTMLElement} */ (e.target).tagName) || e.target.isContentEditable;
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') {
      e.preventDefault();
      actions.saveProjectFile();
      return;
    }
    if (typing || e.ctrlKey || e.metaKey || e.altKey || document.querySelector('dialog[open]')) return;
    if (e.key === '?') actions.openHelp();
    else if (e.key === '1') viewModes.set('split');
    else if (e.key === '2') viewModes.set('map');
    else if (e.key === '3') viewModes.set('3d');
  });
}

/**
 * The preset covering the largest ground area (null for none).
 * @param {Array<{widthKm:number, heightKm:number}>|undefined} presets
 * @returns {object|null}
 */
function widestPreset(presets) {
  return (presets ?? []).reduce((best, p) => (!best || p.widthKm * p.heightKm > best.widthKm * best.heightKm ? p : best), null);
}

function tileLabels(layout) {
  const out = [];
  for (let r = 0; r < layout.rows; r++) for (let c = 0; c < layout.cols; c++) out.push(String.fromCharCode(65 + r) + (c + 1));
  return out;
}

/** True when two projects would produce the same estimate (only colours/print/filaments differ otherwise). */
function sameEstimateInputs(a, b) {
  return sameValue(a.colors, b.colors) && sameValue(a.print, b.print) && sameValue(a.filaments, b.filaments);
}

/** Network / HTTP failures while loading elevation data (expected offline, not a bug). */
function isNetworkError(err) {
  return /fetch|network|Failed to load|HTTP [45]\d\d|NetworkError|timed? ?out/i.test(err?.message ?? String(err));
}

/** Logs a failure: expected network problems as warnings, everything else as errors (with the worker stack). */
function logFailure(what, err) {
  if (isNetworkError(err)) console.warn(`${what}: ${err?.message ?? err}`);
  else console.error(what, err);
}

/**
 * A short, actionable message for the user (no stack traces).
 * @param {unknown} err
 * @param {object} project
 * @param {object} regionsIndex
 * @returns {string}
 */
function friendlyError(err, project, regionsIndex) {
  const msg = err?.message ?? String(err);
  if (isNetworkError(err)) {
    if (chooseSource(project, regionsIndex) === 'live') {
      const region = regionsIndex.regions.find((r) => r.id === project.regionId);
      return region
        ? `The frame reaches beyond the stored ${region.name} data, and live elevation tiles could not be loaded (offline?). `
          + 'Move the frame inside the dashed region outline, or set Elevation data to “Stored”.'
        : 'Live elevation tiles (AWS Terrain Tiles) could not be loaded – check the internet connection, or pick one of the regions with stored data.';
    }
    return 'The stored elevation data could not be loaded – check the connection and reload the page.';
  }
  if (/memory|allocation|Array buffer/i.test(msg)) {
    return 'Not enough memory for this export – use a coarser export detail, fewer tiles or export tiles one by one.';
  }
  return `Something went wrong: ${msg}`;
}

function showFatal(err) {
  const box = h('div', { class: 'fatal', role: 'alert' },
    h('h1', null, 'Relief Studio could not start'),
    h('p', null, String(err?.message ?? err)),
    h('p', null, 'Please reload the page. If the problem persists, try a current version of Chrome, Edge, Firefox or Safari.'));
  document.body.append(box);
}
