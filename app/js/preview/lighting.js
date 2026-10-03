// Lighting of the 3D preview: presets, the light rig (key + fill + hemisphere) whose
// shadow camera is fitted tightly to the artwork, and a small procedural studio
// environment map used for reflections of silk / metallic filaments.
import {
  BackSide, BoxGeometry, Color, DirectionalLight, FrontSide, HemisphereLight, Matrix4, Mesh, MeshBasicMaterial,
  Object3D, PlaneGeometry, PMREMGenerator, Scene, Vector3,
} from 'three';

/**
 * @typedef {{
 *   name:string, description:string, exposure:number, env:number, background:number,
 *   key:{dir:number[], color:string, intensity:number, softnessMm:number, shadow:number},
 *   fill:{dir:number[], color:string, intensity:number},
 *   hemi:{dir:number[], sky:string, ground:string, intensity:number},
 *   wall:{brightness:number, pool:{strength:number, center:number[], radius:number},
 *         glow:{strength:number, color:string, falloff:number}}
 * }} LightingPreset
 * Directions are given in *artwork space* (x right, y up, z out of the artwork towards the
 * viewer) and point from the artwork towards the light. `softnessMm` is the shadow blur,
 * `shadow` the shadow opacity. `wall.pool` darkens the backdrop away from a light pool
 * (centre in fractions of the artwork size, radius as multiple of it); `wall.glow` adds a
 * halo around the artwork (light box behind a lithophane). `background` scales the wall
 * colour for the fog / clear colour far away.
 */

/** @type {Readonly<Record<string, LightingPreset>>} */
export const LIGHTING_PRESETS = Object.freeze({
  gallery: {
    name: 'Gallery',
    description: 'Warm picture light from the top left with a soft fill',
    exposure: 1,
    env: 0.25,
    background: 0.5,
    key: { dir: [-0.55, 0.85, 0.6], color: '#fff0dc', intensity: 3.2, softnessMm: 2.5, shadow: 0.92 },
    fill: { dir: [0.85, -0.1, 0.75], color: '#dfe8ff', intensity: 0.3 },
    hemi: { dir: [0, 0.5, 1], sky: '#fbf8f2', ground: '#6f665e', intensity: 0.5 },
    wall: { brightness: 1, pool: { strength: 0.42, center: [-0.06, 0.12], radius: 1.25 }, glow: { strength: 0, color: '#000000', falloff: 0.05 } },
  },
  morning: {
    name: 'Morning',
    description: 'Low, golden sun from the left',
    exposure: 1,
    env: 0.3,
    background: 0.55,
    key: { dir: [-1, 0.2, 0.42], color: '#ffe4c2', intensity: 3, softnessMm: 2, shadow: 0.9 },
    fill: { dir: [0.9, 0.3, 0.6], color: '#cddcff', intensity: 0.3 },
    hemi: { dir: [0, 0.5, 1], sky: '#e1eaff', ground: '#8a7f74', intensity: 0.55 },
    wall: { brightness: 1, pool: { strength: 0.32, center: [-0.25, 0.05], radius: 1.3 }, glow: { strength: 0, color: '#000000', falloff: 0.05 } },
  },
  evening: {
    name: 'Evening',
    description: 'Low, warm sunset light from the right',
    exposure: 1,
    env: 0.22,
    background: 0.42,
    key: { dir: [1, 0.12, 0.33], color: '#ffb46e', intensity: 3.3, softnessMm: 2, shadow: 0.92 },
    fill: { dir: [-0.9, 0.2, 0.6], color: '#a9b9ff', intensity: 0.28 },
    hemi: { dir: [0, 0.5, 1], sky: '#ffd9b8', ground: '#5d5062', intensity: 0.45 },
    wall: { brightness: 1, pool: { strength: 0.34, center: [0.25, 0.05], radius: 1.3 }, glow: { strength: 0, color: '#000000', falloff: 0.05 } },
  },
  overcast: {
    name: 'Overcast',
    description: 'Soft, diffuse daylight with very gentle shadows',
    exposure: 0.88,
    env: 0.45,
    background: 0.65,
    key: { dir: [-0.2, 0.7, 0.8], color: '#f4f6fa', intensity: 1, softnessMm: 9, shadow: 0.5 },
    fill: { dir: [0, -0.3, 1], color: '#ffffff', intensity: 0 },
    hemi: { dir: [0, 0.6, 1], sky: '#eef2f7', ground: '#6f747c', intensity: 1.2 },
    wall: { brightness: 1, pool: { strength: 0.12, center: [0, 0.1], radius: 1.6 }, glow: { strength: 0, color: '#000000', falloff: 0.05 } },
  },
  raking: {
    name: 'Raking',
    description: 'Very low grazing light from the top: dramatic relief',
    exposure: 1.05,
    env: 0.12,
    background: 0.28,
    key: { dir: [0.06, 1, 0.12], color: '#fff3e6', intensity: 4.6, softnessMm: 1.2, shadow: 0.96 },
    fill: { dir: [0, -0.4, 1], color: '#cfdcff', intensity: 0.08 },
    hemi: { dir: [0, 0.5, 1], sky: '#f2f0ec', ground: '#4a4541', intensity: 0.22 },
    wall: { brightness: 1, pool: { strength: 0.55, center: [0, 0.35], radius: 1.05 }, glow: { strength: 0, color: '#000000', falloff: 0.05 } },
  },
  backlit: {
    name: 'Backlit',
    description: 'Dim room, light shining from behind the artwork (lithophanes)',
    exposure: 1.1,
    env: 0.06,
    background: 0.1,
    key: { dir: [0, 0.6, 1], color: '#c9d4e6', intensity: 0.25, softnessMm: 6, shadow: 0.6 },
    fill: { dir: [0, -0.4, 1], color: '#ffffff', intensity: 0 },
    hemi: { dir: [0, 0.5, 1], sky: '#b9c4d6', ground: '#2a2622', intensity: 0.2 },
    wall: { brightness: 0.35, pool: { strength: 0.5, center: [0, 0], radius: 1.2 }, glow: { strength: 1.3, color: '#ffcf94', falloff: 0.035 } },
  },
});

/** Ids of all lighting presets, in UI order. */
export const LIGHTING_IDS = Object.freeze(Object.keys(LIGHTING_PRESETS));

/**
 * Returns a preset by id, falling back to 'gallery' for unknown ids.
 * @param {string} id
 * @returns {LightingPreset}
 */
export function lightingPreset(id) {
  return LIGHTING_PRESETS[id] || LIGHTING_PRESETS.gallery;
}

/**
 * Corners of the artwork's bounding box in *mount* space: x/y centred on the artwork, z from
 * 0 (back) to the highest relief point.
 * @param {{w:number, h:number, z:number}} extent
 * @returns {Vector3[]}
 */
export function artworkCorners(extent) {
  const corners = [];
  for (const x of [-extent.w / 2, extent.w / 2]) {
    for (const y of [-extent.h / 2, extent.h / 2]) {
      for (const z of [0, extent.z]) corners.push(new Vector3(x, y, z));
    }
  }
  return corners;
}

/**
 * Key light (shadow casting), fill light and hemisphere light. Light directions follow the
 * artwork orientation (wall or table), the key light's orthographic shadow camera is fitted to
 * the artwork so shadow resolution is independent of the artwork size (100 – 1500 mm).
 */
export class LightingRig {
  /**
   * @param {Scene} scene
   * @param {{shadowMapSize?:number}} [options]
   */
  constructor(scene, { shadowMapSize = 2048 } = {}) {
    this.scene = scene;
    this.target = new Object3D();
    this.key = new DirectionalLight();
    this.key.castShadow = true;
    this.key.shadow.mapSize.set(shadowMapSize, shadowMapSize);
    this.key.target = this.target;
    this.fill = new DirectionalLight();
    this.fill.target = this.target;
    this.hemi = new HemisphereLight();
    this.preset = LIGHTING_PRESETS.gallery;
    scene.add(this.target, this.key, this.fill, this.hemi);
  }

  /**
   * Applies colours and intensities of a preset (directions are set by {@link place}).
   * @param {string} id preset id
   * @returns {LightingPreset} the applied preset
   */
  apply(id) {
    const p = lightingPreset(id);
    this.preset = p;
    this.key.color.set(p.key.color);
    this.key.intensity = p.key.intensity;
    this.key.shadow.intensity = p.key.shadow;
    this.fill.color.set(p.fill.color);
    this.fill.intensity = p.fill.intensity;
    this.fill.visible = p.fill.intensity > 0;
    this.hemi.color.set(p.hemi.sky);
    this.hemi.groundColor.set(p.hemi.ground);
    this.hemi.intensity = p.hemi.intensity;
    this.scene.environmentIntensity = p.env;
    return p;
  }

  /**
   * Orients the lights for the current mount and fits the shadow camera to the artwork.
   * @param {import('three').Quaternion} orientation mount (artwork → world) rotation
   * @param {{w:number, h:number, z:number}} extent artwork size in mm (incl. tile gaps)
   * @param {number} [backdropGapMm] distance of the wall / table behind the artwork's back
   */
  place(orientation, extent, backdropGapMm = 0.3) {
    const p = this.preset;
    const keyLocal = new Vector3(...p.key.dir).normalize();
    const keyDir = keyLocal.clone().applyQuaternion(orientation);
    const fillDir = new Vector3(...p.fill.dir).normalize().applyQuaternion(orientation);
    const hemiDir = new Vector3(...p.hemi.dir).normalize().applyQuaternion(orientation);
    const corners = artworkCorners(extent).map((c) => c.applyQuaternion(orientation));
    const radius = Math.max(...corners.map((c) => c.length()));
    // Shadows on the backdrop reach this far behind the artwork along the light direction.
    const receiverDepth = (extent.z + backdropGapMm + 1) / Math.max(keyLocal.z, 0.05);

    this.target.position.set(0, 0, 0);
    this.target.updateMatrixWorld();
    this.key.position.copy(keyDir).multiplyScalar(radius * 2 + receiverDepth);
    this.fill.position.copy(fillDir).multiplyScalar(radius * 2);
    this.hemi.position.copy(hemiDir);
    this.key.updateMatrixWorld();
    this.fill.updateMatrixWorld();
    this.hemi.updateMatrixWorld();
    this._fitShadow(keyDir, corners, receiverDepth);
  }

  /**
   * Fits the orthographic shadow camera to the casters' bounding box in light space. Only the
   * casters' footprint needs to be covered: anything outside it cannot be in shadow.
   * @param {Vector3} keyDir unit vector towards the light (world)
   * @param {Vector3[]} corners caster bounding box corners (world)
   * @param {number} receiverDepth extra depth behind the casters that receives shadows
   */
  _fitShadow(keyDir, corners, receiverDepth) {
    const shadow = this.key.shadow;
    const cam = shadow.camera;
    cam.up.set(0, 1, 0);
    if (Math.abs(keyDir.y) > 0.9) cam.up.set(0, 0, 1);
    cam.position.copy(this.key.position);
    cam.lookAt(this.target.position);
    cam.updateMatrixWorld(true);
    const view = new Matrix4().copy(cam.matrixWorld).invert();
    const min = new Vector3(Infinity, Infinity, Infinity);
    const max = new Vector3(-Infinity, -Infinity, -Infinity);
    for (const c of corners) {
      const v = c.clone().applyMatrix4(view);
      min.min(v);
      max.max(v);
    }
    const mapSize = shadow.mapSize.x;
    const span = Math.max(max.x - min.x, max.y - min.y);
    const texel = span / mapSize;
    const pad = texel * 8 + span * 0.01;
    cam.left = min.x - pad;
    cam.right = max.x + pad;
    cam.bottom = min.y - pad;
    cam.top = max.y + pad;
    cam.near = Math.max(0.01, -max.z - pad);
    cam.far = -min.z + receiverDepth + pad;
    cam.updateProjectionMatrix();
    // Blur radius is given in shadow-map texels; keep it within what 5 PCF taps can smooth.
    shadow.radius = Math.min(10, Math.max(1, this.preset.key.softnessMm / texel));
    shadow.normalBias = texel * 1.5;
    shadow.bias = -0.00005;
    shadow.needsUpdate = true;
  }

  /** Removes the lights from the scene and frees the shadow map. */
  dispose() {
    this.key.shadow.dispose();
    this.scene.remove(this.target, this.key, this.fill, this.hemi);
  }
}

/**
 * Renders a small procedural photo studio (neutral walls, a large softbox top-left, a strip
 * light on the right) into a prefiltered environment map. Gives silk and metallic filaments
 * something believable to reflect without loading an HDR file.
 * @param {import('three').WebGLRenderer} renderer
 * @returns {import('three').WebGLRenderTarget} call `.dispose()` when done; use `.texture`
 */
export function createStudioEnvironment(renderer) {
  const scene = new Scene();
  const box = new BoxGeometry(1, 1, 1);
  const plane = new PlaneGeometry(1, 1);
  const materials = [];
  const add = (geometry, color, scale, position, rotation = [0, 0, 0], side = FrontSide) => {
    const material = new MeshBasicMaterial({ color, side });
    materials.push(material);
    const mesh = new Mesh(geometry, material);
    mesh.scale.set(...scale);
    mesh.position.set(...position);
    mesh.rotation.set(...rotation);
    scene.add(mesh);
  };
  add(box, new Color(0.36, 0.35, 0.33), [14, 8, 14], [0, 2.5, 0], [0, 0, 0], BackSide);   // room
  add(plane, new Color(0.12, 0.11, 0.1), [14, 14, 1], [0, -1.4, 0], [-Math.PI / 2, 0, 0]); // floor
  add(plane, new Color(1, 0.95, 0.88).multiplyScalar(9), [4.5, 3, 1], [-3, 6.4, 3], [Math.PI / 2, 0, 0]); // softbox
  add(plane, new Color(0.9, 0.94, 1).multiplyScalar(3.5), [3, 5, 1], [6.9, 3, 1], [0, -Math.PI / 2, 0]); // strip
  add(plane, new Color(1, 0.98, 0.95).multiplyScalar(2), [6, 1.2, 1], [0, 6.45, -4], [Math.PI / 2, 0, 0]); // ceiling
  const pmrem = new PMREMGenerator(renderer);
  const target = pmrem.fromScene(scene, 0.04);
  pmrem.dispose();
  box.dispose();
  plane.dispose();
  materials.forEach((m) => m.dispose());
  return target;
}
