// three.js preview of the tiled relief artwork: hanging on a wall or lying on a table,
// coloured per fragment by the filament band table, with gallery lighting presets.
// Renders on demand only (camera moves, animations, state changes) to save battery.
import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import {
  createBackdropMaterial, createLabelSprite, createReliefMaterial, updateBackdropMaterial,
  updateReliefMaterial,
} from './materials.js';
import { LightingRig, artworkCorners, createStudioEnvironment } from './lighting.js';

/** View state applied when the corresponding `setView` field is omitted. */
export const DEFAULT_VIEW = Object.freeze({
  lighting: 'gallery', wallColor: '#ece8e1', wallMode: true, exploded: false, seams: true, labels: true,
});

/** Appearance applied when the corresponding `setAppearance` field is omitted. */
export const DEFAULT_APPEARANCE = Object.freeze({
  mode: 'bands', bands: [], layerHeightMm: 0.2, firstLayerMm: 0.2, layerLines: true,
  flatShading: false, highlightWater: false,
});

/** Gap between tiles in the exploded view, as a fraction of the tile size. */
export const EXPLODE_FRACTION = 0.08;
/** Hairline gap between tiles when seams are shown, mm. */
export const SEAM_GAP_MM = 0.4;
/** Faces meeting at a sharper angle than this get split normals (crisp tile edges). */
export const CREASE_ANGLE_DEG = 50;

const BACKDROP_GAP_MM = 0.3;
const LITHOPHANE_WALL = '#1d1c1b';
const CAMERA_FOV = 32;
const FRAME_MARGIN = 1.14;
const WALL_VIEW_DIR = [-0.24, 0.17, 1];   // camera in front, slightly from above-left
const TABLE_VIEW_DIR = [0, 1, 1];         // 45° above the table, from the artwork's bottom edge
const TABLE_ORIENTATION = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(1, 0, 0), -Math.PI / 2);
const WALL_ORIENTATION = new THREE.Quaternion();
const BUILD_SLICE_MS = 12;
const TILE_EASE_MS = 110;
const RESIZE_REFRAME = 0.15;

/**
 * Computes per-corner normals for an indexed triangle mesh, splitting vertices where faces meet
 * at more than `creaseAngleDeg` (tile walls vs. relief top, hex columns, terraces), smooth
 * elsewhere. Area-weighted. Unreferenced vertices are dropped. Pure; no three.js objects.
 * @param {Float32Array} positions xyz per vertex
 * @param {Uint32Array|Uint16Array|number[]} indices CCW triangles
 * @param {number} [creaseAngleDeg]
 * @returns {{positions:Float32Array, normals:Float32Array, indices:Uint32Array|Uint16Array,
 *            remap:Uint32Array}} `remap[newVertex]` = source vertex index
 */
export function creaseNormals(positions, indices, creaseAngleDeg = CREASE_ANGLE_DEG) {
  const nV = Math.floor(positions.length / 3);
  const nC = indices.length - (indices.length % 3);
  const nT = nC / 3;
  const cosCrease = Math.cos((creaseAngleDeg * Math.PI) / 180);
  const cosHalf = Math.cos((creaseAngleDeg * Math.PI) / 360);

  // Face normals: area weighted (cross product) and unit length.
  const fa = new Float32Array(nT * 3);
  const fu = new Float32Array(nT * 3);
  for (let t = 0; t < nT; t++) {
    const a = indices[t * 3], b = indices[t * 3 + 1], c = indices[t * 3 + 2];
    if (a >= nV || b >= nV || c >= nV) throw new RangeError(`triangle ${t} references a missing vertex`);
    const ax = positions[a * 3], ay = positions[a * 3 + 1], az = positions[a * 3 + 2];
    const ux = positions[b * 3] - ax, uy = positions[b * 3 + 1] - ay, uz = positions[b * 3 + 2] - az;
    const vx = positions[c * 3] - ax, vy = positions[c * 3 + 1] - ay, vz = positions[c * 3 + 2] - az;
    const nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
    const len = Math.sqrt(nx * nx + ny * ny + nz * nz);
    fa[t * 3] = nx; fa[t * 3 + 1] = ny; fa[t * 3 + 2] = nz;
    if (len > 0) { fu[t * 3] = nx / len; fu[t * 3 + 1] = ny / len; fu[t * 3 + 2] = nz / len; }
  }

  // Vertex → incident corners (CSR).
  const start = new Uint32Array(nV + 1);
  for (let i = 0; i < nC; i++) start[indices[i] + 1]++;
  for (let v = 0; v < nV; v++) start[v + 1] += start[v];
  const cursor = start.slice(0, nV);
  const incident = new Uint32Array(nC);
  for (let i = 0; i < nC; i++) incident[cursor[indices[i]]++] = i;

  let cap = nV + (nV >> 3) + 16;
  let outPos = new Float32Array(cap * 3);
  let outNrm = new Float32Array(cap * 3);
  let remap = new Uint32Array(cap);
  const outIndex = new Uint32Array(nC);
  let count = 0;
  const grow = () => {
    cap = Math.ceil(cap * 1.5) + 16;
    const p = new Float32Array(cap * 3); p.set(outPos); outPos = p;
    const n = new Float32Array(cap * 3); n.set(outNrm); outNrm = n;
    const r = new Uint32Array(cap); r.set(remap); remap = r;
  };

  const addVertex = (v, x, y, z) => {
    if (count === cap) grow();
    const id = count++;
    outPos[id * 3] = positions[v * 3]; outPos[id * 3 + 1] = positions[v * 3 + 1]; outPos[id * 3 + 2] = positions[v * 3 + 2];
    outNrm[id * 3] = x; outNrm[id * 3 + 1] = y; outNrm[id * 3 + 2] = z;
    remap[id] = v;
    return id;
  };

  for (let v = 0; v < nV; v++) {
    const s = start[v], e = start[v + 1];
    if (s === e) continue;
    // Fast path: every face within half the crease angle of the average normal means every
    // pair of faces is within the crease angle → one smooth vertex.
    let ax = 0, ay = 0, az = 0;
    for (let j = s; j < e; j++) {
      const fj = (incident[j] / 3) | 0;
      ax += fa[fj * 3]; ay += fa[fj * 3 + 1]; az += fa[fj * 3 + 2];
    }
    const alen = Math.sqrt(ax * ax + ay * ay + az * az);
    let smooth = alen > 0;
    for (let j = s; smooth && j < e; j++) {
      const fj = (incident[j] / 3) | 0;
      const ux = fu[fj * 3], uy = fu[fj * 3 + 1], uz = fu[fj * 3 + 2];
      if ((ux !== 0 || uy !== 0 || uz !== 0) && (ux * ax + uy * ay + uz * az) < cosHalf * alen) smooth = false;
    }
    if (smooth) {
      const id = addVertex(v, ax, ay, az);
      for (let j = s; j < e; j++) outIndex[incident[j]] = id;
      continue;
    }
    const first = count;
    for (let i = s; i < e; i++) {
      const fi = (incident[i] / 3) | 0;
      const ix = fu[fi * 3], iy = fu[fi * 3 + 1], iz = fu[fi * 3 + 2];
      const degenerate = ix === 0 && iy === 0 && iz === 0;
      let sx = 0, sy = 0, sz = 0;
      for (let j = s; j < e; j++) {
        const fj = (incident[j] / 3) | 0;
        if (degenerate || j === i || ix * fu[fj * 3] + iy * fu[fj * 3 + 1] + iz * fu[fj * 3 + 2] >= cosCrease) {
          sx += fa[fj * 3]; sy += fa[fj * 3 + 1]; sz += fa[fj * 3 + 2];
        }
      }
      // Corners with the same face set produce bit-identical sums → share one vertex.
      sx = Math.fround(sx); sy = Math.fround(sy); sz = Math.fround(sz);
      let id = -1;
      for (let u = first; u < count; u++) {
        if (outNrm[u * 3] === sx && outNrm[u * 3 + 1] === sy && outNrm[u * 3 + 2] === sz) { id = u; break; }
      }
      if (id < 0) id = addVertex(v, sx, sy, sz);
      outIndex[incident[i]] = id;
    }
  }

  const normals = outNrm.slice(0, count * 3);
  for (let i = 0; i < count; i++) {
    const x = normals[i * 3], y = normals[i * 3 + 1], z = normals[i * 3 + 2];
    const len = Math.sqrt(x * x + y * y + z * z);
    if (len > 0) { normals[i * 3] = x / len; normals[i * 3 + 1] = y / len; normals[i * 3 + 2] = z / len; } else normals[i * 3 + 2] = 1;
  }
  return {
    positions: outPos.slice(0, count * 3),
    normals,
    indices: count <= 65536 ? Uint16Array.from(outIndex) : outIndex,
    remap: remap.slice(0, count),
  };
}

/**
 * Builds the render geometry of one tile mesh: crease-aware normals and an `aWater`
 * (normalized byte) attribute from `mesh.water` (one flag per source vertex).
 * @param {{positions:Float32Array, indices:Uint32Array, water?:Uint8Array}} mesh tile-local mm, z up
 * @param {number} [creaseAngleDeg]
 * @returns {THREE.BufferGeometry}
 */
export function buildTileGeometry(mesh, creaseAngleDeg = CREASE_ANGLE_DEG) {
  const { positions, normals, indices, remap } = creaseNormals(mesh.positions, mesh.indices, creaseAngleDeg);
  const water = new Uint8Array(remap.length);
  if (mesh.water) {
    for (let i = 0; i < remap.length; i++) water[i] = mesh.water[remap[i]] ? 255 : 0;
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  geometry.setAttribute('normal', new THREE.BufferAttribute(normals, 3));
  geometry.setAttribute('aWater', new THREE.BufferAttribute(water, 1, true));
  geometry.setIndex(new THREE.BufferAttribute(indices, 1));
  geometry.computeBoundingBox();
  geometry.computeBoundingSphere();
  return geometry;
}

/**
 * Camera distance from `target` along unit vector `dir` at which every point fits into a
 * perspective view with the given vertical field of view and aspect ratio.
 * @param {THREE.Vector3[]} points world positions
 * @param {THREE.Vector3} target
 * @param {THREE.Vector3} dir unit vector from the target towards the camera
 * @param {number} fovDeg vertical field of view
 * @param {number} aspect width / height
 */
export function fitDistance(points, target, dir, fovDeg, aspect) {
  const zAxis = dir.clone().normalize();
  const helper = Math.abs(zAxis.y) > 0.999 ? new THREE.Vector3(0, 0, -1) : new THREE.Vector3(0, 1, 0);
  const xAxis = new THREE.Vector3().crossVectors(helper, zAxis).normalize();
  const yAxis = new THREE.Vector3().crossVectors(zAxis, xAxis);
  const tanV = Math.tan((fovDeg * Math.PI) / 360);
  const tanH = tanV * aspect;
  const rel = new THREE.Vector3();
  let d = 0;
  for (const p of points) {
    rel.subVectors(p, target);
    const z = rel.dot(zAxis);
    d = Math.max(d, z + Math.abs(rel.dot(xAxis)) / tanH, z + Math.abs(rel.dot(yAxis)) / tanV);
  }
  return d;
}

/** Copies the defined fields of `patch` over `base`. */
function mergeDefined(base, patch) {
  const out = { ...base };
  for (const [k, v] of Object.entries(patch || {})) if (v !== undefined) out[k] = v;
  return out;
}

/** Yields to the event loop so long tile builds do not block input or painting. */
function yieldToEventLoop() {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

/**
 * Interactive 3D preview of the tiled artwork.
 *
 * Coordinates: one world unit = 1 mm. Each tile mesh is tile-local (x ∈ [0,tileW],
 * y ∈ [0,tileH], z up) and placed at its artwork origin (x0, y0). In wall mode the artwork's
 * x/y/z map to world x/y/z (relief towards the viewer); in table mode it lies flat (z up).
 */
export class Preview3D {
  /**
   * @param {HTMLElement} container element the canvas fills (should have a size)
   * @param {{maxPixelRatio?:number, toneMapping?:'aces'|'agx'}} [options]
   * @throws {Error} when WebGL is unavailable
   */
  constructor(container, { maxPixelRatio = 2, toneMapping = 'aces' } = {}) {
    this.container = container;
    this._maxPixelRatio = maxPixelRatio;
    this._view = { ...DEFAULT_VIEW };
    this._appearance = { ...DEFAULT_APPEARANCE };
    this._tiles = [];
    this._art = { artW: 600, artH: 400, maxZ: 25 };
    this._extent = { w: 600, h: 400, z: 25 };
    this._buildGen = 0;
    this._pending = Promise.resolve();
    this._frameWaiters = [];
    this._frames = 0;
    this._raf = 0;
    this._lastStep = 0;
    this._width = 0;
    this._height = 0;
    this._framedSize = 0;
    this._userMoved = false;
    this._shadowsDirty = true;
    this._animating = false;
    this._building = false;
    this._disposed = false;

    const renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: 'high-performance' });
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    renderer.toneMapping = toneMapping === 'agx' ? THREE.AgXToneMapping : THREE.ACESFilmicToneMapping;
    renderer.shadowMap.enabled = true;
    // r186 removed PCFSoftShadowMap; PCFShadowMap with `shadow.radius` gives soft PCF shadows.
    renderer.shadowMap.type = THREE.PCFShadowMap;
    renderer.shadowMap.autoUpdate = false;
    const canvas = renderer.domElement;
    Object.assign(canvas.style, { display: 'block', width: '100%', height: '100%', touchAction: 'none', outline: 'none' });
    canvas.setAttribute('aria-label', '3D preview of the relief artwork');
    container.appendChild(canvas);
    this.renderer = renderer;

    this.scene = new THREE.Scene();
    this.scene.background = new THREE.Color();
    this.scene.fog = new THREE.Fog(0xffffff, 1e4, 2e4);
    this.camera = new THREE.PerspectiveCamera(CAMERA_FOV, 1, 1, 1e5);

    this._mount = new THREE.Group();
    this._artwork = new THREE.Group();
    this._backdropMaterial = createBackdropMaterial();
    this._backdrop = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), this._backdropMaterial);
    this._backdrop.position.z = -BACKDROP_GAP_MM;
    this._backdrop.receiveShadow = true;
    this._backdropSize = 0;
    this._mount.add(this._backdrop, this._artwork);
    this.scene.add(this._mount);
    this._material = createReliefMaterial();
    updateReliefMaterial(this._material, this._appearance);

    const shadowMapSize = renderer.capabilities.maxTextureSize >= 16384 ? 4096 : 2048;
    this._rig = new LightingRig(this.scene, { shadowMapSize });
    this._environment = createStudioEnvironment(renderer);
    this.scene.environment = this._environment.texture;

    const controls = new OrbitControls(this.camera, canvas);
    controls.enableDamping = true;
    controls.dampingFactor = 0.09;
    controls.screenSpacePanning = true;
    controls.zoomToCursor = true;
    this.controls = controls;

    this._onChange = () => this.requestRender();
    this._onStart = () => { this._userMoved = true; };
    this._onDblClick = () => this.resetCamera();
    this._onContextRestored = () => { this._shadowsDirty = true; this.requestRender(); };
    this._frame = this._frame.bind(this);
    controls.addEventListener('change', this._onChange);
    controls.addEventListener('start', this._onStart);
    canvas.addEventListener('dblclick', this._onDblClick);
    canvas.addEventListener('webglcontextrestored', this._onContextRestored);
    this._resizeObserver = new ResizeObserver(() => this.resize());
    this._resizeObserver.observe(container);

    this._refreshScene();
    this.resize();
    this.resetCamera();
  }

  /** Rendering statistics (frames rendered so far, tiles, triangles, build state). */
  get info() {
    return {
      frames: this._frames,
      tiles: this._tiles.length,
      triangles: this._tiles.reduce((n, t) => n + t.triangles, 0),
      building: this._building,
      disposed: this._disposed,
      extent: { ...this._extent },
    };
  }

  /**
   * Replaces the displayed tiles. Geometry is built in time slices (≈12 ms) off-scene and
   * swapped in atomically; a newer call supersedes a build in progress.
   * @param {Array<{label:string, row:number, col:number, x0:number, y0:number, widthMm:number,
   *   heightMm:number, mesh:{positions:Float32Array, indices:Uint32Array, water?:Uint8Array}}>} tiles
   * @param {{artW:number, artH:number, maxZ?:number}} art artwork size in mm
   * @returns {Promise<void>} resolves when the new tiles are in the scene (or superseded)
   */
  setTiles(tiles, art) {
    if (this._disposed) return Promise.resolve();
    const gen = ++this._buildGen;
    const job = this._buildTiles(Array.isArray(tiles) ? tiles : [], art || {}, gen);
    this._pending = job.catch(() => {});
    return job;
  }

  /**
   * Changes how the tiles are coloured. Omitted fields keep their current value.
   * @param {{mode?:'bands'|'single'|'lithophane', bands?:import('../types.js').ResolvedBand[],
   *   layerHeightMm?:number, firstLayerMm?:number, layerLines?:boolean, flatShading?:boolean,
   *   highlightWater?:boolean}} appearance
   */
  setAppearance(appearance) {
    if (this._disposed) return;
    const prevLitho = this._appearance.mode === 'lithophane';
    this._appearance = mergeDefined(this._appearance, appearance);
    updateReliefMaterial(this._material, this._appearance);
    if (prevLitho !== (this._appearance.mode === 'lithophane')) this._refreshScene();
    this.requestRender();
  }

  /**
   * Changes lighting, backdrop and tile arrangement. Omitted fields keep their current value.
   * @param {{lighting?:string, wallColor?:string, wallMode?:boolean, exploded?:boolean,
   *   seams?:boolean, labels?:boolean}} view
   */
  setView(view) {
    if (this._disposed) return;
    const prev = this._view;
    this._view = mergeDefined(prev, view);
    const modeChanged = prev.wallMode !== this._view.wallMode;
    const spacingChanged = prev.exploded !== this._view.exploded || prev.seams !== this._view.seams;
    for (const t of this._tiles) t.label.visible = !!this._view.labels;
    this._refreshScene({ animate: spacingChanged && !modeChanged });
    if (modeChanged) this.resetCamera();
    this.requestRender();
  }

  /** Frames the whole artwork from the default viewpoint of the current mode. */
  resetCamera() {
    if (this._disposed) return;
    const c = this.controls;
    const { position, target } = this._framingPose(this.camera.aspect);
    // Without damping, update() consumes any residual orbit inertia instead of easing it in.
    c.enableDamping = false;
    c.update();
    this.camera.position.copy(position);
    this.camera.up.set(0, 1, 0);
    this.camera.lookAt(target);
    c.target.copy(target);
    c.update();
    c.enableDamping = true;
    this._framedSize = Math.max(this._extent.w, this._extent.h);
    this._userMoved = false;
    this.requestRender();
  }

  /**
   * Renders the current view offscreen at the given size.
   * @param {{width?:number, height?:number, fit?:boolean}} [options] `fit` frames the whole
   *   artwork instead of using the current camera
   * @returns {Promise<string>} PNG data URL
   */
  async screenshot({ width = 1600, height = 1000, fit = false } = {}) {
    if (this._disposed) throw new Error('Preview3D has been disposed');
    await this._pending;
    this._snapTiles();
    const gl = this.renderer.getContext();
    const limit = Math.min(8192, gl.getParameter(gl.MAX_RENDERBUFFER_SIZE), ...gl.getParameter(gl.MAX_VIEWPORT_DIMS));
    const k = Math.min(1, limit / Math.max(width, height));
    const w = Math.max(1, Math.round(width * k));
    const h = Math.max(1, Math.round(height * k));
    const camera = this.camera.clone();
    camera.aspect = w / h;
    if (fit) {
      const pose = this._framingPose(w / h);
      camera.position.copy(pose.position);
      camera.up.set(0, 1, 0);
      camera.lookAt(pose.target);
    }
    camera.updateProjectionMatrix();
    const renderer = this.renderer;
    const ratio = renderer.getPixelRatio();
    const size = renderer.getSize(new THREE.Vector2());
    renderer.setPixelRatio(1);
    renderer.setSize(w, h, false);
    this._prepareShadows();
    renderer.render(this.scene, camera);
    const url = renderer.domElement.toDataURL('image/png');
    renderer.setPixelRatio(ratio);
    renderer.setSize(size.x, size.y, false);
    this._render();
    return url;
  }

  /** Re-reads the container size (also called automatically by a ResizeObserver). */
  resize() {
    if (this._disposed) return;
    const w = Math.floor(this.container.clientWidth);
    const h = Math.floor(this.container.clientHeight);
    this._width = w;
    this._height = h;
    if (!w || !h) return;
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, this._maxPixelRatio));
    this.renderer.setSize(w, h, false);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
    if (!this._userMoved) this.resetCamera();
    this.requestRender();
  }

  /**
   * Resolves after the pending tile build has finished and the next frame was rendered.
   * @returns {Promise<void>}
   */
  async whenRendered() {
    await this._pending;
    if (this._disposed) return;
    await new Promise((resolve) => {
      this._frameWaiters.push(resolve);
      this.requestRender();
    });
  }

  /** Schedules one frame (no-op when one is already scheduled). */
  requestRender() {
    if (this._disposed || this._raf) return;
    this._raf = requestAnimationFrame(this._frame);
  }

  /** Frees GPU resources, listeners and removes the canvas. The instance is unusable afterwards. */
  dispose() {
    if (this._disposed) return;
    this._disposed = true;
    this._buildGen++;
    if (this._raf) cancelAnimationFrame(this._raf);
    this._raf = 0;
    this._resizeObserver.disconnect();
    const canvas = this.renderer.domElement;
    canvas.removeEventListener('dblclick', this._onDblClick);
    canvas.removeEventListener('webglcontextrestored', this._onContextRestored);
    this.controls.removeEventListener('change', this._onChange);
    this.controls.removeEventListener('start', this._onStart);
    this.controls.dispose();
    this._disposeTiles(this._tiles);
    this._tiles = [];
    this._backdrop.geometry.dispose();
    this._backdropMaterial.dispose();
    this._material.dispose();
    this._rig.dispose();
    this.scene.environment = null;
    this._environment.dispose();
    this.renderer.dispose();
    this.renderer.forceContextLoss();
    canvas.remove();
    this._frameWaiters.splice(0).forEach((resolve) => resolve());
  }

  // ------------------------------------------------------------------------------ internals

  async _buildTiles(tiles, art, gen) {
    const built = [];
    const stale = () => gen !== this._buildGen || this._disposed;
    this._building = true;
    try {
      let sliceStart = performance.now();
      for (const tile of tiles) {
        if (stale()) break;
        built.push(this._buildTile(tile));
        if (performance.now() - sliceStart > BUILD_SLICE_MS) {
          await yieldToEventLoop();
          sliceStart = performance.now();
        }
      }
      if (stale()) {
        this._disposeTiles(built);
        return;
      }
      this._swapTiles(built, art);
    } catch (err) {
      this._disposeTiles(built);
      throw err;
    } finally {
      if (gen === this._buildGen) this._building = false;
    }
  }

  _buildTile(tile) {
    const geometry = buildTileGeometry(tile.mesh);
    const mesh = new THREE.Mesh(geometry, this._material);
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    mesh.name = `tile-${tile.label}`;
    const w = tile.widthMm, h = tile.heightMm;
    const zMax = geometry.boundingBox.isEmpty() ? 0 : geometry.boundingBox.max.z;
    const labelH = THREE.MathUtils.clamp(Math.min(w, h) * 0.1, 5, 60);
    const label = createLabelSprite(String(tile.label), labelH);
    label.position.set(w / 2, h / 2, zMax + labelH * 0.6);
    label.visible = !!this._view.labels;
    const group = new THREE.Group();
    group.add(mesh, label);
    return {
      group, mesh, label, row: tile.row, col: tile.col, x0: tile.x0, y0: tile.y0, w, h, zMax,
      triangles: geometry.index.count / 3, current: new THREE.Vector3(), target: new THREE.Vector3(),
    };
  }

  _swapTiles(built, art) {
    const old = this._tiles;
    for (const t of old) this._artwork.remove(t.group);
    this._disposeTiles(old);
    this._tiles = built;
    for (const t of built) this._artwork.add(t.group);
    const right = built.reduce((m, t) => Math.max(m, t.x0 + t.w), 0);
    const top = built.reduce((m, t) => Math.max(m, t.y0 + t.h), 0);
    const zMax = built.reduce((m, t) => Math.max(m, t.zMax), 0);
    this._art = {
      artW: art.artW > 0 ? art.artW : right || this._art.artW,
      artH: art.artH > 0 ? art.artH : top || this._art.artH,
      maxZ: Math.max(art.maxZ > 0 ? art.maxZ : 0, zMax, 1),
    };
    this._refreshScene();
    const size = Math.max(this._extent.w, this._extent.h);
    if (!this._userMoved || Math.abs(size - this._framedSize) > this._framedSize * RESIZE_REFRAME) this.resetCamera();
    this.requestRender();
  }

  _disposeTiles(tiles) {
    for (const t of tiles) {
      t.mesh.geometry.dispose();
      t.label.material.map.dispose();
      t.label.material.dispose();
    }
  }

  /** Recomputes tile placement, backdrop, lights, fog and camera limits from the state. */
  _refreshScene({ animate = false } = {}) {
    const view = this._view;
    const litho = this._appearance.mode === 'lithophane';
    const orientation = view.wallMode ? WALL_ORIENTATION : TABLE_ORIENTATION;
    this._mount.quaternion.copy(orientation);
    this._mount.updateMatrixWorld(true);

    const previous = this._extent;
    this._extent = this._layoutTiles(animate);
    const extent = this._extent;
    const fitExtent = animate
      ? { w: Math.max(previous.w, extent.w), h: Math.max(previous.h, extent.h), z: extent.z }
      : extent;
    const size = Math.max(extent.w, extent.h);

    if (Math.abs(this._backdropSize - size) > size * 0.01) {
      this._backdrop.geometry.dispose();
      this._backdrop.geometry = new THREE.PlaneGeometry(size * 20, size * 20);
      this._backdropSize = size;
    }
    const preset = this._rig.apply(litho ? 'backlit' : view.lighting);
    const wallColor = litho ? LITHOPHANE_WALL : view.wallColor;
    updateBackdropMaterial(this._backdropMaterial, {
      color: wallColor, brightness: preset.wall.brightness, extentW: extent.w, extentH: extent.h,
      pool: preset.wall.pool, glow: preset.wall.glow,
    });
    this.renderer.toneMappingExposure = preset.exposure;
    this.scene.background.set(wallColor).multiplyScalar(preset.wall.brightness * preset.background);
    this.scene.fog.color.copy(this.scene.background);
    this.scene.fog.near = size * 5;
    this.scene.fog.far = size * 9;
    this._rig.place(orientation, fitExtent, BACKDROP_GAP_MM);

    const c = this.controls;
    if (view.wallMode) {
      c.minAzimuthAngle = -1.25; c.maxAzimuthAngle = 1.25;
      c.minPolarAngle = 0.2; c.maxPolarAngle = Math.PI - 0.2;
    } else {
      c.minAzimuthAngle = -Infinity; c.maxAzimuthAngle = Infinity;
      c.minPolarAngle = 0; c.maxPolarAngle = 1.45;
    }
    c.minDistance = size * 0.06;
    c.maxDistance = size * 3.2;
    this.camera.near = Math.max(0.05, size * 0.003);
    this.camera.far = size * 30;
    this.camera.updateProjectionMatrix();
    this._shadowsDirty = true;
    this.requestRender();
  }

  /** Sets tile target positions for the current spacing; returns the artwork extent. */
  _layoutTiles(animate) {
    const tiles = this._tiles;
    const art = this._art;
    let cols = 1, rows = 1, tileSize = 0;
    for (const t of tiles) {
      cols = Math.max(cols, t.col + 1);
      rows = Math.max(rows, t.row + 1);
      tileSize = Math.max(tileSize, t.w, t.h);
    }
    const gap = this._view.exploded ? EXPLODE_FRACTION * tileSize : this._view.seams ? SEAM_GAP_MM : 0;
    const w = art.artW + (cols - 1) * gap;
    const h = art.artH + (rows - 1) * gap;
    for (const t of tiles) {
      t.target.set(t.x0 + t.col * gap - w / 2, t.y0 + (rows - 1 - t.row) * gap - h / 2, 0);
      if (!animate) t.current.copy(t.target);
      t.group.position.copy(t.current);
    }
    this._animating = animate && tiles.length > 0;
    this._lastStep = 0;
    return { w, h, z: art.maxZ };
  }

  /** Eases tiles towards their targets; returns true while still moving. */
  _stepTiles(now) {
    if (!this._animating) return false;
    const dt = this._lastStep ? Math.min(50, now - this._lastStep) : 16;
    this._lastStep = now;
    const k = 1 - Math.exp(-dt / TILE_EASE_MS);
    let moving = false;
    for (const t of this._tiles) {
      t.current.lerp(t.target, k);
      if (t.current.distanceToSquared(t.target) < 1e-4) t.current.copy(t.target);
      else moving = true;
      t.group.position.copy(t.current);
    }
    this._shadowsDirty = true;
    if (!moving) {
      this._animating = false;
      this._rig.place(this._mount.quaternion, this._extent, BACKDROP_GAP_MM);
    }
    return moving;
  }

  _snapTiles() {
    if (!this._animating) return;
    for (const t of this._tiles) {
      t.current.copy(t.target);
      t.group.position.copy(t.current);
    }
    this._animating = false;
    this._rig.place(this._mount.quaternion, this._extent, BACKDROP_GAP_MM);
    this._shadowsDirty = true;
  }

  /** Default camera pose for the current mode and artwork, for a view of `aspect`. */
  _framingPose(aspect) {
    const extent = this._extent;
    const orientation = this._mount.quaternion;
    const target = new THREE.Vector3(0, 0, extent.z * 0.35).applyQuaternion(orientation);
    const dir = new THREE.Vector3(...(this._view.wallMode ? WALL_VIEW_DIR : TABLE_VIEW_DIR)).normalize();
    const corners = artworkCorners(extent).map((p) => p.applyQuaternion(orientation));
    const distance = fitDistance(corners, target, dir, this.camera.fov, aspect || 1) * FRAME_MARGIN;
    return { position: target.clone().addScaledVector(dir, distance), target };
  }

  _prepareShadows() {
    if (!this._shadowsDirty) return;
    this.renderer.shadowMap.needsUpdate = true;
    this._shadowsDirty = false;
  }

  _render() {
    if (this._disposed || !this._width || !this._height) return;
    this._prepareShadows();
    this.renderer.render(this.scene, this.camera);
    this._frames++;
  }

  _frame(now) {
    this._raf = 0;
    const moving = this._stepTiles(now);
    this.controls.update();
    this._render();
    if (moving) this.requestRender();
    this._frameWaiters.splice(0).forEach((resolve) => resolve());
  }
}
