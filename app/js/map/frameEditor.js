// Interactive editing of the print frame on a Leaflet map.
//
//  * drag inside the frame          → move the centre (shape, size and rotation are kept)
//  * drag one of the corner handles → resize symmetrically about the centre, aspect ratio locked
//  * drag the handle above the top  → rotate (bearing from the centre; Shift snaps to 15°)
//  * Esc during a gesture           → cancel and restore the frame the gesture started from
//
// Works with mouse, pen and touch through pointer events. Map dragging is disabled while a
// gesture is in progress. Updates are reported through `onInput(frame, final)`: throttled to
// animation frames while the pointer moves (final = false), then once on release (final = true).
import * as L from '../../vendor/leaflet/leaflet-src.esm.js';
import { frameUVToLatLon, tmForward } from '../core/projection.js';

/** @typedef {import('../types.js').Frame} Frame */
/** @typedef {'move'|'resize'|'rotate'} GestureKind */

/** Smallest allowed frame side in kilometres. */
export const MIN_FRAME_KM = 1;
/** Largest allowed frame side in kilometres. */
export const MAX_FRAME_KM = 4000;
/** Rotation snapping step (degrees) while Shift is held. */
export const ROTATION_SNAP_DEG = 15;
/** Largest |latitude| of the frame centre the editor produces. */
export const MAX_CENTER_LAT = 84;

/** Corner handles in frame UV space (u left→right, v top→bottom). */
export const CORNERS = Object.freeze([
  Object.freeze({ id: 'tl', u: 0, v: 0, title: 'Drag to resize (top left)' }),
  Object.freeze({ id: 'tr', u: 1, v: 0, title: 'Drag to resize (top right)' }),
  Object.freeze({ id: 'br', u: 1, v: 1, title: 'Drag to resize (bottom right)' }),
  Object.freeze({ id: 'bl', u: 0, v: 1, title: 'Drag to resize (bottom left)' }),
]);

const DEG = Math.PI / 180;
/** Screen distance between the top edge and the rotation handle. */
const ROTATE_HANDLE_GAP_PX = 30;
/** Pointer travel below which a press is a click, not a drag. */
const DRAG_THRESHOLD_PX = 3;
const RESIZE_CURSORS = ['ew-resize', 'nwse-resize', 'ns-resize', 'nesw-resize'];
const ROTATE_GLYPH =
  '<svg viewBox="0 0 24 24" width="14" height="14" aria-hidden="true" fill="none" stroke="currentColor"' +
  ' stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round">' +
  '<path d="M19.4 13.5A7.5 7.5 0 1 1 17 6.6"/><path d="M18.6 2.6 18 8l-5.3-.9"/></svg>';

// ---------------------------------------------------------------------------------------------
// Pure frame geometry
// ---------------------------------------------------------------------------------------------

/**
 * Wraps an angle into (-180, 180].
 * @param {number} deg
 * @returns {number}
 */
export function normalizeRotation(deg) {
  const r = ((deg % 360) + 360) % 360;
  return r > 180 ? r - 360 : r;
}

/**
 * Clamps a frame width so that both sides stay within [MIN_FRAME_KM, MAX_FRAME_KM] while the
 * aspect ratio is kept. Falls back to clamping the width alone for extreme aspect ratios.
 * @param {number} widthKm requested width
 * @param {number} aspect   width / height
 * @returns {number} clamped width in km
 */
export function clampFrameWidth(widthKm, aspect) {
  let lo = Math.max(MIN_FRAME_KM, MIN_FRAME_KM * aspect);
  let hi = Math.min(MAX_FRAME_KM, MAX_FRAME_KM * aspect);
  if (lo > hi) {
    lo = MIN_FRAME_KM;
    hi = MAX_FRAME_KM;
  }
  return Math.min(hi, Math.max(lo, widthKm));
}

/**
 * Position of a geographic point in frame-local metres: transverse Mercator around the frame
 * centre followed by the inverse frame rotation (x to the frame's right, y to its top).
 * @param {Frame} frame
 * @param {number} lat
 * @param {number} lon
 * @returns {[number, number]} [x, y] metres
 */
export function toFrameLocal(frame, lat, lon) {
  const [x, y] = tmForward(lat, lon, frame.lat, frame.lon);
  const t = (frame.rotationDeg || 0) * DEG;
  const c = Math.cos(t);
  const s = Math.sin(t);
  return [x * c - y * s, x * s + y * c];
}

/**
 * Resizes a frame symmetrically about its centre so that a corner lands on the given point,
 * keeping the aspect ratio: widthKm = 2·max(|x|, |y|·aspect) in frame-local coordinates.
 * @param {Frame} frame
 * @param {number} lat position of the dragged corner
 * @param {number} lon
 * @returns {Frame}
 */
export function resizeFrameToCorner(frame, lat, lon) {
  const aspect = frame.widthKm / frame.heightKm;
  const [x, y] = toFrameLocal(frame, lat, lon);
  const widthKm = clampFrameWidth((2 * Math.max(Math.abs(x), Math.abs(y) * aspect)) / 1000, aspect);
  return { ...frame, widthKm, heightKm: widthKm / aspect };
}

/**
 * Bearing (degrees clockwise from north) from the frame centre to a point, measured in the
 * frame's transverse Mercator projection.
 * @param {Frame} frame
 * @param {number} lat
 * @param {number} lon
 * @returns {number} degrees in (-180, 180]
 */
export function bearingFromCenter(frame, lat, lon) {
  const [x, y] = tmForward(lat, lon, frame.lat, frame.lon);
  return Math.atan2(x, y) / DEG;
}

/**
 * Rotates a frame by the change in bearing of the pointer, optionally snapping the result.
 * @param {Frame} frame frame at the start of the gesture
 * @param {number} startBearingDeg pointer bearing at the start of the gesture
 * @param {number} bearingDeg current pointer bearing
 * @param {boolean} [snap=false] snap to multiples of ROTATION_SNAP_DEG
 * @returns {Frame}
 */
export function rotateFrame(frame, startBearingDeg, bearingDeg, snap = false) {
  let rotation = (frame.rotationDeg || 0) + bearingDeg - startBearingDeg;
  if (snap) rotation = Math.round(rotation / ROTATION_SNAP_DEG) * ROTATION_SNAP_DEG;
  return { ...frame, rotationDeg: normalizeRotation(rotation) };
}

/**
 * Picks the CSS resize cursor closest to a screen direction.
 * @param {number} dx screen x component (right)
 * @param {number} dy screen y component (down)
 * @returns {string}
 */
export function resizeCursor(dx, dy) {
  const deg = ((Math.atan2(dy, dx) / DEG) % 180 + 180) % 180;
  return RESIZE_CURSORS[Math.round(deg / 45) % 4];
}

// ---------------------------------------------------------------------------------------------
// Interactive editor
// ---------------------------------------------------------------------------------------------

/**
 * Handles and pointer gestures for the print frame. The editor does not draw the frame itself;
 * the owner draws it and calls {@link FrameEditor#update} whenever the drawn frame changes.
 *
 * All frames passed in and out are "display frames": their longitude lies on the world copy that
 * is drawn, so it may leave [-180, 180]; the owner normalises before publishing.
 */
export class FrameEditor {
  /**
   * @param {L.Map} map
   * @param {object} options
   * @param {string} options.handlePane  pane for the handle markers
   * @param {string} options.stemPane    pane for the line joining the frame and the rotation handle
   * @param {() => Frame|null} options.getFrame  the frame as currently drawn
   * @param {(frame: Frame, final: boolean) => void} options.onInput  gesture updates
   */
  constructor(map, { handlePane, stemPane, getFrame, onInput }) {
    this.map = map;
    this._getFrame = getFrame;
    this._onInput = onInput;
    /** @type {null | {kind: GestureKind, pointerId: number, target: Element, start: Frame,
     *   startLatLng: L.LatLng, startClient: [number, number], grabOffset: L.Point|null,
     *   corner: {u:number, v:number}|null, startBearing: number, moved: boolean,
     *   last: {clientX:number, clientY:number, shiftKey:boolean}, pending: Frame|null,
     *   dragging: boolean}} */
    this._gesture = null;
    this._raf = 0;
    this._visible = false;
    /** @type {WeakSet<Element>} elements that already carry our pointer listeners */
    this._bound = new WeakSet();
    /**
     * Whether a press inside the frame starts a move. The owner turns this off while the frame
     * covers the whole view, so that dragging pans the map instead.
     */
    this.bodyDraggable = true;

    this._onPointerMove = this._onPointerMove.bind(this);
    this._onPointerUp = this._onPointerUp.bind(this);
    this._onPointerCancel = this._onPointerCancel.bind(this);
    this._onKey = this._onKey.bind(this);
    this._flush = this._flush.bind(this);

    this._corners = CORNERS.map((corner) => {
      const marker = this._createHandle(handlePane, {
        className: `rs-handle rs-handle-corner rs-corner-${corner.id}`,
        html: '<span class="rs-handle-dot"></span>',
        title: corner.title,
      }, 'resize', corner);
      return { corner, marker };
    });
    this._rotateHandle = this._createHandle(handlePane, {
      className: 'rs-handle rs-handle-rotate',
      html: `<span class="rs-handle-dot">${ROTATE_GLYPH}</span>`,
      title: 'Drag to rotate · hold Shift to snap to 15°',
    }, 'rotate', null);
    this._stem = L.polyline([], {
      pane: stemPane, interactive: false, className: 'rs-rotate-stem', weight: 1.5,
    });
  }

  /** True while the user is dragging the frame or one of its handles. */
  get active() {
    return this._gesture !== null;
  }

  /**
   * Makes a vector layer (the frame body) draggable. Re-binds automatically whenever the layer
   * is (re-)added to the map.
   * @param {L.Path} layer
   */
  attachBody(layer) {
    const bind = () => this._bindElement(layer.getElement(), 'move', null);
    layer.on('add', bind);
    if (layer.getElement()) bind();
  }

  /**
   * Positions the handles for the drawn frame; `null` hides them.
   * @param {Frame|null} frame
   */
  update(frame) {
    if (!frame) {
      this._setVisible(false);
      return;
    }
    this._setVisible(true);
    const map = this.map;
    const centre = map.latLngToLayerPoint([frame.lat, frame.lon]);
    for (const { corner, marker } of this._corners) {
      const ll = frameUVToLatLon(frame, corner.u, corner.v);
      marker.setLatLng(ll);
      const p = map.latLngToLayerPoint(ll);
      const el = marker.getElement();
      if (el) el.style.cursor = resizeCursor(p.x - centre.x, p.y - centre.y);
    }
    const top = frameUVToLatLon(frame, 0.5, 0);
    const topPt = map.latLngToLayerPoint(top);
    let dx = topPt.x - centre.x;
    let dy = topPt.y - centre.y;
    const len = Math.hypot(dx, dy);
    if (len > 1e-6) {
      dx /= len;
      dy /= len;
    } else {
      dx = 0;
      dy = -1;
    }
    const handle = map.layerPointToLatLng(
      L.point(topPt.x + dx * ROTATE_HANDLE_GAP_PX, topPt.y + dy * ROTATE_HANDLE_GAP_PX));
    this._rotateHandle.setLatLng(handle);
    this._stem.setLatLngs([top, handle]);
  }

  /** Ends any gesture (without reporting it) and removes the handles from the map. */
  destroy() {
    this._endGesture();
    this._setVisible(false);
    for (const { marker } of this._corners) marker.off();
    this._rotateHandle.off();
  }

  // -- handles ---------------------------------------------------------------------------------

  /**
   * @param {string} pane
   * @param {{className:string, html:string, title:string}} icon
   * @param {GestureKind} kind
   * @param {{u:number, v:number}|null} corner
   * @returns {L.Marker}
   */
  _createHandle(pane, { className, html, title }, kind, corner) {
    const marker = L.marker([0, 0], {
      pane,
      icon: L.divIcon({ className, html, iconSize: [30, 30] }),
      interactive: true,
      keyboard: false,
      title,
      bubblingMouseEvents: false,
    });
    marker.on('add', () => this._bindElement(marker.getElement(), kind, corner));
    return marker;
  }

  /** @param {boolean} visible */
  _setVisible(visible) {
    if (visible === this._visible) return;
    this._visible = visible;
    const layers = [this._stem, this._rotateHandle, ...this._corners.map((c) => c.marker)];
    for (const layer of layers) {
      if (visible) layer.addTo(this.map);
      else layer.remove();
    }
  }

  /**
   * @param {Element|undefined} el
   * @param {GestureKind} kind
   * @param {{u:number, v:number}|null} corner
   */
  _bindElement(el, kind, corner) {
    if (!el || this._bound.has(el)) return;
    this._bound.add(el);
    el.addEventListener('pointerdown', (e) => this._onPointerDown(e, kind, corner));
    // Keep Leaflet's map drag / box zoom (mousedown, emulated touchstart) from seeing a press
    // that started a gesture; unhandled presses fall through and pan the map.
    L.DomEvent.on(el, 'mousedown touchstart', (e) => {
      if (this._gesture) L.DomEvent.stopPropagation(e);
    });
  }

  // -- gestures --------------------------------------------------------------------------------

  /**
   * @param {PointerEvent} e
   * @param {GestureKind} kind
   * @param {{u:number, v:number}|null} corner
   */
  _onPointerDown(e, kind, corner) {
    if (this._gesture || !e.isPrimary || e.button !== 0) return;
    if (kind === 'move' && !this.bodyDraggable) return;
    const start = this._getFrame();
    if (!start) return;
    e.preventDefault();
    e.stopPropagation();

    const map = this.map;
    const startLatLng = map.mouseEventToLatLng(e);
    let grabOffset = null;
    if (kind === 'resize') {
      const cornerLL = frameUVToLatLon(start, corner.u, corner.v);
      grabOffset = map.mouseEventToContainerPoint(e).subtract(map.latLngToContainerPoint(cornerLL));
    }
    const target = /** @type {Element} */ (e.currentTarget);
    this._gesture = {
      kind,
      pointerId: e.pointerId,
      target,
      start: { ...start },
      startLatLng,
      startClient: [e.clientX, e.clientY],
      grabOffset,
      corner,
      startBearing: kind === 'rotate' ? bearingFromCenter(start, startLatLng.lat, startLatLng.lng) : 0,
      moved: false,
      last: { clientX: e.clientX, clientY: e.clientY, shiftKey: e.shiftKey },
      pending: null,
      dragging: map.dragging.enabled(),
    };
    try {
      target.setPointerCapture(e.pointerId);
    } catch {
      // Capture is an optimisation (events outside the window); window listeners still work.
    }
    map.dragging.disable();
    window.addEventListener('pointermove', this._onPointerMove);
    window.addEventListener('pointerup', this._onPointerUp);
    window.addEventListener('pointercancel', this._onPointerCancel);
    window.addEventListener('keydown', this._onKey);
    window.addEventListener('keyup', this._onKey);
    const container = map.getContainer();
    container.classList.add('rs-editing', `rs-editing-${kind}`);
    // Keep the grabbed handle's resize cursor while the pointer runs ahead of the handle.
    if (kind === 'resize') {
      container.style.setProperty('--rs-resize-cursor', /** @type {HTMLElement} */ (target).style.cursor);
    }
  }

  /** @param {PointerEvent} e */
  _onPointerMove(e) {
    const g = this._gesture;
    if (!g || e.pointerId !== g.pointerId) return;
    e.preventDefault();
    g.last = { clientX: e.clientX, clientY: e.clientY, shiftKey: e.shiftKey };
    if (!g.moved) {
      const travel = Math.hypot(e.clientX - g.startClient[0], e.clientY - g.startClient[1]);
      if (travel < DRAG_THRESHOLD_PX) return;
      g.moved = true;
    }
    this._recompute();
  }

  /** @param {PointerEvent} e */
  _onPointerUp(e) {
    const g = this._gesture;
    if (!g || e.pointerId !== g.pointerId) return;
    g.last = { clientX: e.clientX, clientY: e.clientY, shiftKey: e.shiftKey };
    if (g.moved) this._recompute();
    this._finish(false);
  }

  /** @param {PointerEvent} e */
  _onPointerCancel(e) {
    const g = this._gesture;
    if (g && e.pointerId === g.pointerId) this._finish(true);
  }

  /** Escape cancels; Shift toggles rotation snapping without moving the pointer. */
  _onKey(/** @type {KeyboardEvent} */ e) {
    const g = this._gesture;
    if (!g) return;
    if (e.key === 'Escape' && e.type === 'keydown') {
      e.preventDefault();
      this._finish(true);
    } else if (e.key === 'Shift' && g.kind === 'rotate' && g.moved) {
      g.last = { ...g.last, shiftKey: e.type === 'keydown' };
      this._recompute();
    }
  }

  /** Computes the frame for the latest pointer position and schedules a throttled update. */
  _recompute() {
    const g = this._gesture;
    g.pending = this._frameFor(g);
    if (!this._raf) this._raf = requestAnimationFrame(this._flush);
  }

  _flush() {
    this._raf = 0;
    const g = this._gesture;
    if (g && g.pending) this._onInput(g.pending, false);
  }

  /**
   * @param {NonNullable<FrameEditor['_gesture']>} g
   * @returns {Frame}
   */
  _frameFor(g) {
    const map = this.map;
    const { start } = g;
    if (g.kind === 'move') {
      const zoom = map.getZoom();
      const pointer = map.mouseEventToLatLng(g.last);
      const delta = map.project(pointer, zoom).subtract(map.project(g.startLatLng, zoom));
      const centre = map.unproject(map.project([start.lat, start.lon], zoom).add(delta), zoom);
      const lat = Math.max(-MAX_CENTER_LAT, Math.min(MAX_CENTER_LAT, centre.lat));
      return { ...start, lat, lon: centre.lng };
    }
    if (g.kind === 'resize') {
      const handlePoint = map.mouseEventToContainerPoint(g.last).subtract(g.grabOffset);
      const ll = map.containerPointToLatLng(handlePoint);
      return resizeFrameToCorner(start, ll.lat, ll.lng);
    }
    const pointer = map.mouseEventToLatLng(g.last);
    const bearing = bearingFromCenter(start, pointer.lat, pointer.lng);
    return rotateFrame(start, g.startBearing, bearing, g.last.shiftKey);
  }

  /**
   * Ends the gesture and reports the final frame (the start frame when cancelled).
   * @param {boolean} cancelled
   */
  _finish(cancelled) {
    const g = this._endGesture();
    if (!g || !g.moved) return;
    const frame = cancelled ? g.start : g.pending;
    if (frame) this._onInput(frame, true);
  }

  /** Tears down listeners and map state of the current gesture and returns it. */
  _endGesture() {
    const g = this._gesture;
    if (!g) return null;
    this._gesture = null;
    if (this._raf) cancelAnimationFrame(this._raf);
    this._raf = 0;
    window.removeEventListener('pointermove', this._onPointerMove);
    window.removeEventListener('pointerup', this._onPointerUp);
    window.removeEventListener('pointercancel', this._onPointerCancel);
    window.removeEventListener('keydown', this._onKey);
    window.removeEventListener('keyup', this._onKey);
    try {
      if (g.target.hasPointerCapture?.(g.pointerId)) g.target.releasePointerCapture(g.pointerId);
    } catch {
      // The element may already be detached; capture is released with it.
    }
    if (g.dragging) this.map.dragging.enable();
    const container = this.map.getContainer();
    container.classList.remove('rs-editing', `rs-editing-${g.kind}`);
    container.style.removeProperty('--rs-resize-cursor');
    return g;
  }
}
