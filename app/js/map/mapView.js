// Leaflet map for choosing the print frame: base maps, region overviews and outlines, the
// rotated frame with its tile grid and labels, and the interactive frame editor.
import * as L from '../../vendor/leaflet/leaflet-src.esm.js';
import { framePolygon, frameUVToLatLon, latLonToFrameUV } from '../core/projection.js';
import { FrameEditor, MAX_CENTER_LAT, normalizeRotation } from './frameEditor.js';

/** @typedef {import('../types.js').Frame} Frame */
/** @typedef {import('../types.js').Layout} Layout */
/**
 * @typedef {{id:string, name:string, bounds:{south:number, west:number, north:number, east:number},
 *   thumbnail?:string, overview?:string}} RegionEntry
 *   one entry of data/regions.json "regions"; image paths are relative to the data directory
 */

const OSM_ATTRIBUTION =
  '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors';

/**
 * Available base maps. `none` shows no tiles, only the region overview images.
 * @type {Readonly<Record<string, {label:string, title:string, url:string|null, maxZoom:number,
 *   options:object}>>}
 */
export const BASE_LAYERS = Object.freeze({
  topo: Object.freeze({
    label: 'Topo',
    title: 'Topographic map (OpenTopoMap)',
    url: 'https://{s}.tile.opentopomap.org/{z}/{x}/{y}.png',
    maxZoom: 17,
    options: {
      subdomains: 'abc',
      attribution: `Map data: ${OSM_ATTRIBUTION}, <a href="http://viewfinderpanoramas.org">SRTM</a>` +
        ' | Map style: &copy; <a href="https://opentopomap.org">OpenTopoMap</a>' +
        ' (<a href="https://creativecommons.org/licenses/by-sa/3.0/">CC-BY-SA</a>)',
    },
  }),
  osm: Object.freeze({
    label: 'Streets',
    title: 'Street map (OpenStreetMap)',
    url: 'https://tile.openstreetmap.org/{z}/{x}/{y}.png',
    maxZoom: 19,
    options: { attribution: OSM_ATTRIBUTION },
  }),
  satellite: Object.freeze({
    label: 'Satellite',
    title: 'Satellite imagery (Esri World Imagery)',
    url: 'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}',
    maxZoom: 19,
    options: {
      attribution: 'Tiles &copy; Esri &mdash; Source: Esri, Maxar, Earthstar Geographics, ' +
        'and the GIS User Community',
    },
  }),
  none: Object.freeze({
    label: 'Plain',
    title: 'No base map – shaded relief of the stored regions only',
    url: null,
    maxZoom: 15,
    options: {},
  }),
});

/** Leaflet panes used by the map view, bottom to top. */
export const PANES = Object.freeze({
  overview: 'rs-overview',
  regions: 'rs-regions',
  frame: 'rs-frame',
  labels: 'rs-labels',
  handles: 'rs-handles',
});
const PANE_Z_INDEX = { overview: 250, regions: 380, frame: 420, labels: 610, handles: 640 };

const FRAME_SEGMENTS = 16;
const GRID_SEGMENTS = 16;
/** Tile labels are hidden when a tile is smaller than this on screen (px). */
const LABEL_MIN_TILE_PX = 34;
const WORLD_BOUNDS = [[-56, -168], [74, 192]];
const DEFAULT_OVERVIEW_OPACITY = 0.8;
/** A region's thumbnail is used until the region is wider than this on screen (thumb width). */
const THUMB_MAX_PX = 480;

// ---------------------------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------------------------

/**
 * Tile label: row letter (A = top row) followed by the 1-based column number (A1 = top left).
 * @param {number} row
 * @param {number} col
 * @returns {string}
 */
export function tileLabel(row, col) {
  return String.fromCharCode(65 + row) + (col + 1);
}

/**
 * Interior tile grid lines of a frame as curved polylines through frameUVToLatLon:
 * vertical lines u = c/cols (top → bottom) followed by horizontal lines v = r/rows (left → right).
 * @param {Frame} frame
 * @param {number} cols
 * @param {number} rows
 * @param {number} [segments=16] segments per line
 * @returns {Array<Array<[number, number]>>}
 */
export function frameGridLines(frame, cols, rows, segments = GRID_SEGMENTS) {
  const lines = [];
  for (let c = 1; c < cols; c++) {
    const line = [];
    for (let i = 0; i <= segments; i++) line.push(frameUVToLatLon(frame, c / cols, i / segments));
    lines.push(line);
  }
  for (let r = 1; r < rows; r++) {
    const line = [];
    for (let i = 0; i <= segments; i++) line.push(frameUVToLatLon(frame, i / segments, r / rows));
    lines.push(line);
  }
  return lines;
}

/**
 * Wraps a longitude into [-180, 180).
 * @param {number} lon
 * @returns {number}
 */
function wrapLon(lon) {
  return lon - 360 * Math.floor((lon + 180) / 360);
}

/**
 * The copy of `lon` (± k·360°) closest to `refLon`.
 * @param {number} lon
 * @param {number} refLon
 * @returns {number}
 */
function nearestWorldCopy(lon, refLon) {
  return lon + 360 * Math.round((refLon - lon) / 360);
}

/** @param {number} v @param {number} digits */
function round(v, digits) {
  const k = 10 ** digits;
  return Math.round(v * k) / k;
}

/**
 * Canonical frame for publishing: lon in [-180, 180), lat clamped, rotation in (-180, 180],
 * values rounded to ~0.1 m / 0.01°.
 * @param {Frame} frame
 * @returns {Frame}
 */
function canonicalFrame(frame) {
  const lon = round(wrapLon(frame.lon), 6);
  const rotationDeg = round(normalizeRotation(frame.rotationDeg || 0), 2);
  return {
    lat: round(Math.max(-MAX_CENTER_LAT, Math.min(MAX_CENTER_LAT, frame.lat)), 6),
    lon: lon >= 180 ? lon - 360 : lon,
    widthKm: round(frame.widthKm, 4),
    heightKm: round(frame.heightKm, 4),
    rotationDeg: rotationDeg <= -180 ? rotationDeg + 360 : rotationDeg,
  };
}

/** @param {Frame} f */
function isValidFrame(f) {
  return !!f && Number.isFinite(f.lat) && Number.isFinite(f.lon) && f.widthKm > 0 && f.heightKm > 0 &&
    Number.isFinite(f.widthKm) && Number.isFinite(f.heightKm);
}

/**
 * True when the whole visible map lies inside the frame (checked at the four view corners).
 * @param {L.Map} map
 * @param {Frame} frame
 */
function frameCoversView(map, frame) {
  const view = map.getBounds();
  return [view.getNorthWest(), view.getNorthEast(), view.getSouthEast(), view.getSouthWest()].every((ll) => {
    const [u, v] = latLonToFrameUV(frame, ll.lat, ll.lng);
    return u >= 0 && u <= 1 && v >= 0 && v <= 1;
  });
}

/** @param {RegionEntry} region */
function regionLatLngBounds(region) {
  const b = region.bounds;
  return L.latLngBounds([b.south, b.west], [b.north, b.east]);
}

/** @param {string} text */
function escapeHtml(text) {
  return String(text).replace(/[&<>"']/g, (ch) => `&#${ch.charCodeAt(0)};`);
}

/**
 * Short attribution for the DEM overviews; the full licence text is in the tooltip.
 * @param {string|undefined} full
 */
function demAttribution(full) {
  const title = full ? ` title="${escapeHtml(full)}"` : '';
  const href = 'https://spacedata.copernicus.eu/collections/copernicus-digital-elevation-model';
  return `Relief: <a href="${href}"${title}>Copernicus DEM</a> &copy; DLR e.V., Airbus DS`;
}

// ---------------------------------------------------------------------------------------------
// Controls
// ---------------------------------------------------------------------------------------------

/** Segmented control for the base map. */
const BaseLayerSwitcher = L.Control.extend({
  options: { position: 'topright', onSelect: (/** @type {string} */ _id) => {} },

  initialize(options) {
    L.setOptions(this, options);
    /** @type {Map<string, HTMLButtonElement>} */
    this._buttons = new Map();
    this._active = null;
  },

  onAdd() {
    const el = L.DomUtil.create('div', 'leaflet-bar rs-layer-switch');
    el.setAttribute('role', 'group');
    el.setAttribute('aria-label', 'Base map');
    for (const [id, def] of Object.entries(BASE_LAYERS)) {
      const button = /** @type {HTMLButtonElement} */ (L.DomUtil.create('button', 'rs-layer-btn', el));
      button.type = 'button';
      button.textContent = def.label;
      button.title = def.title;
      button.dataset.layer = id;
      L.DomEvent.on(button, 'click', (e) => {
        L.DomEvent.stop(e);
        this.options.onSelect(id);
      });
      this._buttons.set(id, button);
    }
    L.DomEvent.disableClickPropagation(el);
    L.DomEvent.disableScrollPropagation(el);
    this.setActive(this._active);
    return el;
  },

  /** @param {string|null} id */
  setActive(id) {
    this._active = id;
    for (const [key, button] of this._buttons) {
      button.classList.toggle('is-active', key === id);
      button.setAttribute('aria-pressed', String(key === id));
    }
  },
});

/** Single button that zooms the map to the frame. */
const FitFrameControl = L.Control.extend({
  options: { position: 'topleft', onFit: () => {} },

  onAdd() {
    const el = L.DomUtil.create('div', 'leaflet-bar rs-fit-control');
    const button = /** @type {HTMLAnchorElement} */ (L.DomUtil.create('a', 'rs-fit-btn', el));
    button.href = '#';
    button.setAttribute('role', 'button');
    button.title = 'Zoom to frame';
    button.setAttribute('aria-label', 'Zoom to frame');
    button.innerHTML =
      '<svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true" fill="none" stroke="currentColor"' +
      ' stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round">' +
      '<path d="M4 9V4h5M15 4h5v5M20 15v5h-5M9 20H4v-5"/></svg>';
    L.DomEvent.on(button, 'click', (e) => {
      L.DomEvent.stop(e);
      this.options.onFit();
    });
    L.DomEvent.disableClickPropagation(el);
    return el;
  },
});

// ---------------------------------------------------------------------------------------------
// MapView
// ---------------------------------------------------------------------------------------------

/**
 * Map with the print frame.
 *
 * Events (CustomEvent, read `event.detail`):
 *  * `framechange`    `{frame, final}` – the user moved, resized or rotated the frame
 *                     (final = false while dragging, throttled to animation frames; true on release)
 *  * `regionselect`   `{regionId}` – a region outline was clicked
 *  * `baselayerchange` `{baseLayer}` – the user picked a base map in the layer switcher
 *
 * None of the setters emit events.
 */
export class MapView extends EventTarget {
  /**
   * @param {HTMLElement} container element that receives the map (must have a size)
   * @param {object} [options]
   * @param {{regions?: RegionEntry[], attribution?: string}|null} [options.regionsIndex] data/regions.json
   * @param {string} [options.dataBaseUrl='data/'] URL of the data directory (relative to the page)
   * @param {keyof typeof BASE_LAYERS} [options.baseLayer='topo'] initial base map
   */
  constructor(container, { regionsIndex = null, dataBaseUrl = 'data/', baseLayer = 'topo' } = {}) {
    super();
    this.container = container;
    /** @type {RegionEntry[]} */
    this.regions = Array.isArray(regionsIndex?.regions) ? regionsIndex.regions : [];
    const base = dataBaseUrl.endsWith('/') ? dataBaseUrl : `${dataBaseUrl}/`;
    this._dataBaseUrl = new URL(base, document.baseURI);
    this._demAttribution = demAttribution(regionsIndex?.attribution);
    /** @type {Frame|null} last frame set or edited (canonical) */
    this._frame = null;
    /** @type {Frame|null} frame as drawn (longitude on the visible world copy) */
    this._shown = null;
    this._grid = { cols: 1, rows: 1 };
    this._regionId = 'world';
    this._baseId = null;
    this._overviewOpacity = DEFAULT_OVERVIEW_OPACITY;
    /** @type {L.TileLayer|null} */
    this._tileLayer = null;
    /** @type {Map<string, {layer: L.ImageOverlay, url: string}>} region id → overview overlay */
    this._overviews = new Map();
    /** @type {Map<string, L.Rectangle>} */
    this._outlines = new Map();
    /** @type {(() => void)|null} fit waiting for a running zoom animation to end */
    this._deferredFit = null;
    /** @type {[L.LatLngBounds, L.FitBoundsOptions]|null} fit waiting for the map to get a size */
    this._pendingFit = null;
    /** @type {L.Marker[]} */
    this._labelMarkers = [];
    /** @type {string[]} text shown by each label marker */
    this._labelTexts = [];

    container.classList.add('rs-map');
    const map = L.map(container, {
      zoomSnap: 0.25,
      zoomDelta: 0.5,
      wheelPxPerZoomLevel: 100,
      minZoom: 2,
      worldCopyJump: false,
    });
    /** The underlying Leaflet map. */
    this.map = map;
    for (const [key, name] of Object.entries(PANES)) {
      map.createPane(name).style.zIndex = String(PANE_Z_INDEX[key]);
    }
    map.setView([30, 10], 2);

    L.control.scale({ imperial: false, position: 'bottomleft' }).addTo(map);
    new FitFrameControl({ onFit: () => this.fitFrame() }).addTo(map);
    this._switcher = new BaseLayerSwitcher({ onSelect: (id) => this._selectBaseLayer(id) });
    this._switcher.addTo(map);

    this._createRegionOutlines();

    const framePane = PANES.frame;
    this._frameHalo = L.polygon([], {
      pane: framePane, interactive: false, className: 'rs-frame-halo', weight: 6, fill: false,
    });
    this._gridLines = L.polyline([], {
      pane: framePane, interactive: false, className: 'rs-frame-grid', weight: 1.25,
    });
    this._frameOutline = L.polygon([], {
      pane: framePane, className: 'rs-frame-outline', weight: 2.5, fillOpacity: 0.08,
      bubblingMouseEvents: false,
    });
    this._labelLayer = L.layerGroup([], { pane: PANES.labels });

    this._editor = new FrameEditor(map, {
      handlePane: PANES.handles,
      stemPane: framePane,
      getFrame: () => (this._shown ? { ...this._shown } : null),
      onInput: (frame, final) => this._onEditorInput(frame, final),
    });
    this._editor.attachBody(this._frameOutline);

    map.on('zoomend viewreset', this._refreshScreenGeometry, this);
    map.on('moveend', this._onMoveEnd, this);
    this.setBaseLayer(baseLayer);
  }

  /** Id of the active base map. */
  get baseLayer() {
    return this._baseId;
  }

  /** Id of the current region ('world' when none). */
  get regionId() {
    return this._regionId;
  }

  /**
   * Current frame (as last set or edited), or null.
   * @returns {Frame|null}
   */
  getFrame() {
    return this._frame ? { ...this._frame } : null;
  }

  /**
   * Shows the region's overview image, highlights its outline and fits the map to it.
   * 'world' (or an unknown id) shows the whole world.
   * @param {string} regionId
   */
  setRegion(regionId) {
    const region = this.regions.find((r) => r.id === regionId) || null;
    this._regionId = region ? region.id : 'world';
    for (const [id, outline] of this._outlines) {
      outline.getElement()?.classList.toggle('is-current', id === this._regionId);
    }
    // The overview follows on 'moveend' (always fired by the fit), sized for the new view.
    if (region) this._fitView(regionLatLngBounds(region), { padding: [24, 24] });
    else this._fitView(L.latLngBounds(WORLD_BOUNDS), {});
  }

  /**
   * Draws the frame outline, the tile grid (layout.cols × layout.rows) and the tile labels.
   * Passing `null` removes the frame. Never emits events.
   * @param {Frame|null} frame
   * @param {Pick<Layout, 'cols'|'rows'>|null} [layout]
   */
  setFrame(frame, layout) {
    if (layout) {
      this._grid = {
        cols: Math.max(1, Math.round(layout.cols) || 1),
        rows: Math.max(1, Math.round(layout.rows) || 1),
      };
    }
    if (frame == null) {
      this._frame = null;
      this._clearFrame();
      return;
    }
    if (!isValidFrame(frame)) throw new TypeError('MapView.setFrame: invalid frame');
    this._frame = {
      lat: frame.lat, lon: frame.lon, widthKm: frame.widthKm, heightKm: frame.heightKm,
      rotationDeg: frame.rotationDeg || 0,
    };
    // Keep the frame on the world copy it is already drawn on (or the one nearest the view).
    const refLon = this._shown ? this._shown.lon : this.map.getCenter().lng;
    this._render({ ...this._frame, lon: nearestWorldCopy(this._frame.lon, refLon) });
  }

  /** Fits the map view to the frame (including room for the handles). */
  fitFrame() {
    if (!this._shown) return;
    const bounds = L.latLngBounds(framePolygon(this._shown, 8));
    this._fitView(bounds, { padding: [56, 56], maxZoom: 16 });
  }

  /**
   * Switches the base map.
   * @param {keyof typeof BASE_LAYERS} id 'topo' | 'osm' | 'satellite' | 'none'
   */
  setBaseLayer(id) {
    const def = BASE_LAYERS[id];
    if (!def) throw new RangeError(`MapView.setBaseLayer: unknown base layer "${id}"`);
    if (id === this._baseId) return;
    if (this._tileLayer) this._tileLayer.remove();
    this._tileLayer = def.url
      ? L.tileLayer(def.url, { ...def.options, maxZoom: def.maxZoom }).addTo(this.map)
      : null;
    this.map.setMaxZoom(def.maxZoom);
    if (this._baseId) this.container.classList.remove(`rs-base-${this._baseId}`);
    this.container.classList.add(`rs-base-${id}`);
    this._baseId = id;
    this._switcher.setActive(id);
    this._syncOverviews();
  }

  /**
   * Opacity of the region overview images over a tiled base map (always opaque on 'none').
   * @param {number} opacity 0..1
   */
  setOverviewOpacity(opacity) {
    this._overviewOpacity = Math.max(0, Math.min(1, opacity));
    this._syncOverviews();
  }

  /** Call after the container changed size. */
  resize() {
    this.map.invalidateSize();
    // A fit requested while the map was hidden (e.g. the 3D tab on a phone) is applied now.
    if (this._pendingFit && this._hasSize()) {
      const [bounds, options] = this._pendingFit;
      this._pendingFit = null;
      this._fitView(bounds, options);
    }
  }

  /** True when the map container is laid out (not display:none or collapsed). */
  _hasSize() {
    return this.container.clientWidth > 0 && this.container.clientHeight > 0;
  }

  /** Removes the map and all listeners. */
  destroy() {
    this._editor.destroy();
    this.map.remove();
    this.container.classList.remove('rs-map', `rs-base-${this._baseId}`);
  }

  /**
   * Programmatic, non-animated fitBounds. Leaflet starts animations on the next frame and ignores
   * view changes while one runs, so animating would let an earlier request override a later one;
   * if the user is in the middle of an animated zoom, the latest request is applied when it ends.
   * @param {L.LatLngBounds} bounds
   * @param {L.FitBoundsOptions} options
   */
  _fitView(bounds, options) {
    const map = this.map;
    if (!this._hasSize()) {
      this._pendingFit = [bounds, options];
      return;
    }
    this._pendingFit = null;
    const fit = () => map.fitBounds(bounds, { ...options, animate: false });
    if (this._deferredFit) map.off('zoomend', this._deferredFit);
    this._deferredFit = null;
    if (map._animatingZoom) {
      this._deferredFit = () => {
        this._deferredFit = null;
        fit();
      };
      map.once('zoomend', this._deferredFit);
    } else {
      fit();
    }
  }

  // -- regions ---------------------------------------------------------------------------------

  _createRegionOutlines() {
    for (const region of this.regions) {
      const bounds = regionLatLngBounds(region);
      const common = { pane: PANES.regions, fill: false };
      L.rectangle(bounds, { ...common, interactive: false, className: 'rs-region-halo', weight: 3.5 })
        .addTo(this.map);
      const outline = L.rectangle(bounds, {
        ...common, interactive: false, className: 'rs-region-outline', weight: 1.5, dashArray: '6 5',
      }).addTo(this.map);
      // Wide transparent stroke: a comfortable click target along the outline.
      const hit = L.rectangle(bounds, {
        ...common, className: 'rs-region-hit', weight: 14, opacity: 0, bubblingMouseEvents: false,
      }).addTo(this.map);
      hit.getElement()?.setAttribute('data-region', region.id);
      hit.bindTooltip(escapeHtml(region.name), {
        sticky: true, direction: 'top', offset: [0, -8], className: 'rs-region-tip',
      });
      hit.on('click', () => {
        this.dispatchEvent(new CustomEvent('regionselect', { detail: { regionId: region.id } }));
      });
      this._outlines.set(region.id, outline);
    }
  }

  /**
   * Shows the shaded-relief overview of the current region, or of every region on the plain base
   * map. Only regions near the view are loaded, as thumbnails while they are small on screen.
   */
  _syncOverviews() {
    const plain = this._baseId === 'none';
    const opacity = plain ? 1 : this._overviewOpacity;
    const view = this.map.getBounds().pad(0.2);
    for (const region of this.regions) {
      const bounds = regionLatLngBounds(region);
      const entry = this._overviews.get(region.id);
      if (!(plain || region.id === this._regionId) || !view.intersects(bounds)) {
        entry?.layer.remove();
        continue;
      }
      const url = this._overviewUrl(region, bounds, entry?.url);
      if (!entry) {
        const layer = L.imageOverlay(url, bounds, {
          pane: PANES.overview,
          interactive: false,
          className: 'rs-overview',
          alt: `Shaded relief of ${region.name}`,
          attribution: this._demAttribution,
        });
        this._overviews.set(region.id, { layer, url });
        layer.addTo(this.map).setOpacity(opacity);
      } else {
        if (entry.url !== url) {
          entry.layer.setUrl(url);
          entry.url = url;
        }
        entry.layer.addTo(this.map).setOpacity(opacity);
      }
    }
  }

  /**
   * Thumbnail while the region is narrower than the thumbnail on screen, else the full overview
   * (kept once loaded).
   * @param {RegionEntry} region
   * @param {L.LatLngBounds} bounds
   * @param {string|undefined} currentUrl
   */
  _overviewUrl(region, bounds, currentUrl) {
    const full = new URL(region.overview || `${region.id}/overview.jpg`, this._dataBaseUrl).href;
    if (!region.thumbnail || currentUrl === full) return full;
    const widthPx = this.map.latLngToContainerPoint(bounds.getNorthEast()).x -
      this.map.latLngToContainerPoint(bounds.getSouthWest()).x;
    return widthPx > THUMB_MAX_PX ? full : new URL(region.thumbnail, this._dataBaseUrl).href;
  }

  // -- base layers -----------------------------------------------------------------------------

  /** @param {string} id */
  _selectBaseLayer(id) {
    if (id === this._baseId) return;
    this.setBaseLayer(id);
    this.dispatchEvent(new CustomEvent('baselayerchange', { detail: { baseLayer: id } }));
  }

  // -- frame -----------------------------------------------------------------------------------

  /**
   * Draws a frame whose longitude is already on the world copy to show.
   * @param {Frame} display
   */
  _render(display) {
    this._shown = display;
    const { cols, rows } = this._grid;
    const ring = framePolygon(display, FRAME_SEGMENTS);
    this._frameHalo.setLatLngs(ring);
    this._frameOutline.setLatLngs(ring);
    this._gridLines.setLatLngs(frameGridLines(display, cols, rows, GRID_SEGMENTS));
    if (!this.map.hasLayer(this._frameOutline)) {
      // Order matters (SVG paint order): halo, grid, then the interactive outline on top.
      this._frameHalo.addTo(this.map);
      this._gridLines.addTo(this.map);
      this._frameOutline.addTo(this.map);
      this._labelLayer.addTo(this.map);
    }
    this._syncLabels(display, cols, rows);
    this._refreshScreenGeometry();
  }

  _clearFrame() {
    this._shown = null;
    for (const layer of [this._frameHalo, this._gridLines, this._frameOutline, this._labelLayer]) {
      layer.remove();
    }
    this._editor.update(null);
  }

  /**
   * One small label per tile at the tile centre; markers are reused between redraws.
   * @param {Frame} frame
   * @param {number} cols
   * @param {number} rows
   */
  _syncLabels(frame, cols, rows) {
    const count = cols * rows;
    while (this._labelMarkers.length > count) {
      this._labelLayer.removeLayer(this._labelMarkers.pop());
      this._labelTexts.pop();
    }
    for (let row = 0; row < rows; row++) {
      for (let col = 0; col < cols; col++) {
        const i = row * cols + col;
        const text = tileLabel(row, col);
        const latLng = frameUVToLatLon(frame, (col + 0.5) / cols, (row + 0.5) / rows);
        const marker = this._labelMarkers[i];
        if (!marker) {
          this._labelMarkers.push(L.marker(latLng, {
            pane: PANES.labels, interactive: false, keyboard: false, icon: labelIcon(text),
          }).addTo(this._labelLayer));
          this._labelTexts.push(text);
        } else {
          marker.setLatLng(latLng);
          if (this._labelTexts[i] !== text) {
            marker.setIcon(labelIcon(text));
            this._labelTexts[i] = text;
          }
        }
      }
    }
  }

  /** Re-positions screen-space dependent pieces (handles, label visibility) after zooming. */
  _refreshScreenGeometry() {
    const frame = this._shown;
    if (!frame) return;
    this._editor.update(frame);
    const { cols, rows } = this._grid;
    const tl = this.map.latLngToLayerPoint(frameUVToLatLon(frame, 0, 0));
    const tr = this.map.latLngToLayerPoint(frameUVToLatLon(frame, 1, 0));
    const bl = this.map.latLngToLayerPoint(frameUVToLatLon(frame, 0, 1));
    const tilePx = Math.min(tl.distanceTo(tr) / cols, tl.distanceTo(bl) / rows);
    this.map.getPane(PANES.labels).classList.toggle('rs-labels-hidden', tilePx < LABEL_MIN_TILE_PX);
    this._updateBodyDrag();
  }

  _onMoveEnd() {
    this._syncOverviews();
    if (!this._shown || this._editor.active) return;
    // After panning across the antimeridian, redraw the frame on the world copy in view.
    const lon = nearestWorldCopy(this._shown.lon, this.map.getCenter().lng);
    if (Math.abs(lon - this._shown.lon) > 180) this._render({ ...this._shown, lon });
    else this._updateBodyDrag();
  }

  /**
   * Zoomed into a frame that fills the whole view, a drag inside it pans the map (the frame
   * cannot be moved out from under the pointer anyway); otherwise it moves the frame.
   */
  _updateBodyDrag() {
    const covers = !!this._shown && frameCoversView(this.map, this._shown);
    this._editor.bodyDraggable = !covers;
    this.container.classList.toggle('rs-frame-covers-view', covers);
  }

  /**
   * @param {Frame} display frame from the editor (longitude on the drawn world copy)
   * @param {boolean} final
   */
  _onEditorInput(display, final) {
    const frame = canonicalFrame(display);
    this._frame = frame;
    this._render({ ...frame, lon: nearestWorldCopy(frame.lon, display.lon) });
    this.dispatchEvent(new CustomEvent('framechange', { detail: { frame: { ...frame }, final } }));
  }
}

/**
 * @param {string} text
 * @returns {L.DivIcon}
 */
function labelIcon(text) {
  return L.divIcon({
    className: 'rs-tile-label',
    html: `<span>${escapeHtml(text)}</span>`,
    iconSize: null,
  });
}
