// Materials of the 3D preview: the relief material that colours every fragment by its
// tile-local height using the filament band table, the backdrop (wall / table) material
// with a soft light pool and lithophane glow, and the tile label sprites.
import {
  CanvasTexture, Color, LinearMipmapLinearFilter, MeshStandardMaterial, SRGBColorSpace,
  Sprite, SpriteMaterial, Vector2,
} from 'three';

/** Maximum number of filament bands the relief shader can show. */
export const MAX_BANDS = 12;

/**
 * Surface look of each filament finish in the preview. `code` is the shader id of the
 * procedural effect; `lift` brightens the base colour (translucent filaments look lighter).
 * @type {Record<string, {roughness:number, metalness:number, code:number, lift:number}>}
 */
export const FINISH_LOOK = Object.freeze({
  matte: { roughness: 0.92, metalness: 0, code: 0, lift: 0 },
  basic: { roughness: 0.6, metalness: 0, code: 1, lift: 0 },
  silk: { roughness: 0.32, metalness: 0.5, code: 2, lift: 0 },
  metallic: { roughness: 0.3, metalness: 0.8, code: 3, lift: 0 },
  marble: { roughness: 0.55, metalness: 0, code: 4, lift: 0 },
  wood: { roughness: 0.7, metalness: 0, code: 5, lift: 0 },
  glitter: { roughness: 0.45, metalness: 0.2, code: 6, lift: 0 },
  translucent: { roughness: 0.3, metalness: 0, code: 7, lift: 0.14 },
});

/** Colour used when no band table is given (a neutral white PLA). */
export const FALLBACK_BAND = Object.freeze({ zFrom: 0, color: '#f2f1ec', finish: 'matte' });

/** Blue tint of water areas when `highlightWater` is on (sRGB). */
export const WATER_TINT = '#3c78b4';

/** Warm white of the LED panel behind a lithophane (sRGB). */
export const LITHOPHANE_LIGHT = '#ffe3bd';

/** Fraction of light a lithophane loses per mm of material (Beer–Lambert, white PLA). */
export const LITHOPHANE_ABSORPTION_PER_MM = 1.15;

/**
 * Look-up of a finish, falling back to `basic` for unknown ids.
 * @param {string} finish
 */
export function finishLook(finish) {
  return FINISH_LOOK[finish] || FINISH_LOOK.basic;
}

/**
 * Converts a band table into the flat arrays uploaded to the shader. Pure (no GPU access).
 * Bands are sorted by `zFrom`; at most {@link MAX_BANDS} are kept, the first starts at 0.
 * @param {Array<{zFrom:number, color:string, finish?:string}>} bands ResolvedBand-like entries
 * @returns {{count:number, z:Float32Array, colors:Float32Array, surface:Float32Array}}
 *   `colors` = linear RGB triplets, `surface` = [roughness, metalness, finishCode, 0 (padding)]
 */
export function packBands(bands) {
  const list = (Array.isArray(bands) && bands.length ? [...bands] : [FALLBACK_BAND])
    .filter((b) => b && Number.isFinite(b.zFrom ?? 0))
    .sort((a, b) => (a.zFrom ?? 0) - (b.zFrom ?? 0))
    .slice(0, MAX_BANDS);
  if (!list.length) list.push(FALLBACK_BAND);
  const z = new Float32Array(MAX_BANDS);
  const colors = new Float32Array(MAX_BANDS * 3);
  const surface = new Float32Array(MAX_BANDS * 4);
  const c = new Color();
  const white = new Color(1, 1, 1);
  for (let i = 0; i < MAX_BANDS; i++) {
    const band = list[Math.min(i, list.length - 1)];
    const look = finishLook(band.finish);
    c.set(band.color || FALLBACK_BAND.color);          // sRGB hex → linear working space
    if (look.lift > 0) c.lerp(white, look.lift);
    z[i] = i === 0 ? 0 : band.zFrom ?? 0;
    colors.set([c.r, c.g, c.b], i * 3);
    surface.set([look.roughness, look.metalness, look.code, 0], i * 4);
  }
  return { count: list.length, z, colors, surface };
}

// ---------------------------------------------------------------------------------------
// Relief material
// ---------------------------------------------------------------------------------------

const RELIEF_VERTEX_PARS = /* glsl */ `
attribute float aWater;
varying vec3 vReliefPos;
varying vec3 vReliefNormal;
varying float vReliefWater;
`;

const RELIEF_VERTEX_MAIN = /* glsl */ `
vReliefPos = position;
vReliefNormal = normal;
vReliefWater = aWater;
`;

const RELIEF_FRAGMENT_PARS = /* glsl */ `
#define RELIEF_MAX_BANDS ${MAX_BANDS}
uniform int uBandCount;
uniform float uBandZ[ RELIEF_MAX_BANDS ];
uniform vec3 uBandColor[ RELIEF_MAX_BANDS ];
uniform vec4 uBandSurface[ RELIEF_MAX_BANDS ];
uniform float uLayerHeight;
uniform float uLayerPhase;
uniform float uLayerLines;
uniform float uWaterHighlight;
uniform vec3 uWaterColor;
uniform float uLithophane;
uniform vec3 uLithoLight;
uniform float uLithoAbsorb;
varying vec3 vReliefPos;
varying vec3 vReliefNormal;
varying float vReliefWater;

float reliefHash( vec3 p ) {
	p = fract( p * 0.3183099 + 0.1 );
	p *= 17.0;
	return fract( p.x * p.y * p.z * ( p.x + p.y + p.z ) );
}

float reliefNoise( vec3 x ) {
	vec3 i = floor( x );
	vec3 f = fract( x );
	f = f * f * ( 3.0 - 2.0 * f );
	return mix(
		mix( mix( reliefHash( i ), reliefHash( i + vec3( 1.0, 0.0, 0.0 ) ), f.x ),
		     mix( reliefHash( i + vec3( 0.0, 1.0, 0.0 ) ), reliefHash( i + vec3( 1.0, 1.0, 0.0 ) ), f.x ), f.y ),
		mix( mix( reliefHash( i + vec3( 0.0, 0.0, 1.0 ) ), reliefHash( i + vec3( 1.0, 0.0, 1.0 ) ), f.x ),
		     mix( reliefHash( i + vec3( 0.0, 1.0, 1.0 ) ), reliefHash( i + vec3( 1.0, 1.0, 1.0 ) ), f.x ), f.y ),
		f.z );
}

float reliefFbm( vec3 p ) {
	float sum = 0.0;
	float amp = 0.5;
	for ( int i = 0; i < 4; i ++ ) {
		sum += amp * reliefNoise( p );
		p = p * 2.03 + 17.17;
		amp *= 0.5;
	}
	return sum / 0.9375;
}

struct ReliefSurface {
	vec3 color;
	float roughness;
	float metalness;
	float finish;
	vec3 emissive;
};

// Filament colour, finish and print artefacts at the current fragment (tile-local mm).
ReliefSurface reliefSurface() {
	ReliefSurface s;
	vec3 p = vReliefPos;
	float z = p.z;
	float w = max( fwidth( z ), 1e-4 );
	vec3 col = uBandColor[ 0 ];
	vec2 rm = uBandSurface[ 0 ].xy;
	float finish = uBandSurface[ 0 ].z;
	// A surface exactly at a change height still belongs to the lower band (layer top).
	for ( int i = 1; i < RELIEF_MAX_BANDS; i ++ ) {
		if ( i >= uBandCount ) break;
		float t = clamp( ( z - uBandZ[ i ] - 0.002 ) / w + 0.5, 0.0, 1.0 );
		col = mix( col, uBandColor[ i ], t );
		rm = mix( rm, uBandSurface[ i ].xy, t );
		if ( t > 0.5 ) finish = uBandSurface[ i ].z;
	}
	s.emissive = vec3( 0.0 );
	vec3 n = normalize( vReliefNormal );

	if ( uLithophane > 0.5 ) {
		// Backlit lithophane: light transmitted through the local material thickness.
		float facing = mix( 0.3, 1.0, smoothstep( 0.0, 0.6, n.z ) );
		s.emissive = uLithoLight * col * exp( - uLithoAbsorb * max( z, 0.0 ) ) * facing;
		s.color = col * 0.22;
		s.roughness = 0.65;
		s.metalness = 0.0;
		s.finish = 0.0;
		return s;
	}

	if ( abs( finish - 4.0 ) < 0.5 ) {
		// Marble: soft meandering veins plus sparse dark specks.
		float warp = reliefFbm( p * vec3( 0.045, 0.045, 0.09 ) );
		float vein = abs( sin( ( p.x * 0.6 + p.y * 0.35 + p.z * 0.4 ) * 0.07 + warp * 7.0 ) );
		vein = 1.0 - smoothstep( 0.0, 0.14, vein );
		float speck = step( 0.972, reliefHash( floor( p * 2.4 ) ) );
		col *= 1.0 - 0.32 * vein - 0.3 * speck;
	} else if ( abs( finish - 5.0 ) < 0.5 ) {
		// Wood fill: fibrous grain and per-layer temperature banding.
		float grain = reliefFbm( vec3( p.x * 0.035, p.y * 0.035, p.z * 1.6 ) );
		float ring = 0.5 + 0.5 * sin( p.z * 2.4 + grain * 5.0 );
		col *= mix( 0.8, 1.07, ring * 0.6 + grain * 0.4 );
	} else if ( abs( finish - 7.0 ) < 0.5 ) {
		// Translucent: a little light scattered inside the material.
		s.emissive = col * 0.05;
	}

	if ( uLayerLines > 0.0 && uLayerHeight > 0.0 ) {
		// FDM layer lines: darker grooves at layer boundaries, only on sloped surfaces and
		// faded out when a layer becomes smaller than a pixel (avoids moire).
		float lz = ( z - uLayerPhase ) / uLayerHeight;
		float d = abs( fract( lz ) - 0.5 ) * 2.0;
		float aa = 1.0 - smoothstep( 0.3, 0.7, fwidth( lz ) );
		float slope = smoothstep( 0.03, 0.3, 1.0 - abs( n.z ) );
		col *= 1.0 - uLayerLines * 0.17 * smoothstep( 0.55, 1.0, d ) * aa * slope;
	}

	float water = uWaterHighlight * smoothstep( 0.25, 0.75, vReliefWater );
	col = mix( col, uWaterColor, water * 0.85 );
	rm = mix( rm, vec2( 0.2, 0.0 ), water );

	s.color = col;
	s.roughness = rm.x;
	s.metalness = rm.y;
	s.finish = finish;
	return s;
}

// Glitter flakes: tiny randomly tilted mirrors that flash when they reflect the key light.
vec3 reliefGlitter( vec3 col, vec3 n, vec3 viewDir, vec3 lightDir ) {
	vec3 cell = floor( vReliefPos * 3.0 );
	if ( reliefHash( cell ) < 0.9 ) return vec3( 0.0 );
	vec3 jitter = vec3( reliefHash( cell + 3.1 ), reliefHash( cell + 7.7 ), reliefHash( cell + 11.3 ) ) - 0.5;
	vec3 flake = normalize( n + jitter * 1.5 );
	float spec = pow( max( dot( flake, normalize( lightDir + viewDir ) ), 0.0 ), 80.0 );
	return mix( col, vec3( 1.0 ), 0.65 ) * spec * 4.0 * step( 0.0, dot( n, lightDir ) );
}
`;

const RELIEF_COLOR = /* glsl */ `
#include <color_fragment>
ReliefSurface reliefS = reliefSurface();
diffuseColor.rgb = reliefS.color;
`;

// Reflections of the (dim) room are boosted for metallic / silk filaments so their flakes read
// as metal rather than dark plastic; matte filaments are unaffected.
const RELIEF_SPECULAR = /* glsl */ `
#include <lights_fragment_maps>
#if defined( RE_IndirectSpecular )
	radiance *= 1.0 + 2.5 * reliefS.metalness;
#endif
`;

const RELIEF_EMISSIVE = /* glsl */ `
#include <emissivemap_fragment>
totalEmissiveRadiance += reliefS.emissive;
if ( abs( reliefS.finish - 6.0 ) < 0.5 ) {
	vec3 reliefLightDir = normal;
	#if NUM_DIR_LIGHTS > 0
		reliefLightDir = directionalLights[ 0 ].direction;
	#endif
	totalEmissiveRadiance += reliefGlitter( reliefS.color, normal, normalize( vViewPosition ), reliefLightDir );
}
`;

/**
 * Creates the shared relief material: a MeshStandardMaterial whose fragment shader picks
 * colour, roughness and metalness from the band table by tile-local z (see {@link packBands}).
 * Geometries need `position`, `normal` and an optional normalized `aWater` attribute.
 * @returns {MeshStandardMaterial} with `userData.uniforms` holding the relief uniforms
 */
export function createReliefMaterial() {
  const uniforms = {
    uBandCount: { value: 1 },
    uBandZ: { value: new Float32Array(MAX_BANDS) },
    uBandColor: { value: Array.from({ length: MAX_BANDS }, () => new Color(1, 1, 1)) },
    uBandSurface: { value: new Float32Array(MAX_BANDS * 4) },
    uLayerHeight: { value: 0.2 },
    uLayerPhase: { value: 0 },
    uLayerLines: { value: 1 },
    uWaterHighlight: { value: 0 },
    uWaterColor: { value: new Color(WATER_TINT) },
    uLithophane: { value: 0 },
    uLithoLight: { value: new Color(LITHOPHANE_LIGHT).multiplyScalar(2.6) },
    uLithoAbsorb: { value: LITHOPHANE_ABSORPTION_PER_MM },
  };
  const material = new MeshStandardMaterial({ color: 0xffffff, roughness: 0.8, metalness: 0, dithering: true });
  material.name = 'relief';
  material.userData.uniforms = uniforms;
  material.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, uniforms);
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', `#include <common>\n${RELIEF_VERTEX_PARS}`)
      .replace('#include <begin_vertex>', `#include <begin_vertex>\n${RELIEF_VERTEX_MAIN}`);
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', `#include <common>\n${RELIEF_FRAGMENT_PARS}`)
      .replace('#include <color_fragment>', RELIEF_COLOR)
      .replace('#include <roughnessmap_fragment>', 'float roughnessFactor = reliefS.roughness;')
      .replace('#include <metalnessmap_fragment>', 'float metalnessFactor = reliefS.metalness;')
      .replace('#include <emissivemap_fragment>', RELIEF_EMISSIVE)
      .replace('#include <lights_fragment_maps>', RELIEF_SPECULAR);
  };
  material.customProgramCacheKey = () => 'relief-studio-relief-v1';
  return material;
}

/**
 * Applies an appearance to a relief material created by {@link createReliefMaterial}.
 * @param {MeshStandardMaterial} material
 * @param {{mode?:string, bands?:Array, layerHeightMm?:number, firstLayerMm?:number,
 *          layerLines?:boolean, flatShading?:boolean, highlightWater?:boolean}} appearance
 */
export function updateReliefMaterial(material, appearance) {
  const u = material.userData.uniforms;
  const packed = packBands(appearance.bands);
  u.uBandCount.value = packed.count;
  u.uBandZ.value.set(packed.z);
  u.uBandSurface.value.set(packed.surface);
  u.uBandColor.value.forEach((c, i) => c.fromArray(packed.colors, i * 3));
  const h = Math.max(0, Number(appearance.layerHeightMm) || 0);
  const first = Number.isFinite(appearance.firstLayerMm) ? appearance.firstLayerMm : h;
  u.uLayerHeight.value = h;
  u.uLayerPhase.value = h > 0 ? ((first % h) + h) % h : 0;
  u.uLayerLines.value = appearance.layerLines ? 1 : 0;
  u.uWaterHighlight.value = appearance.highlightWater ? 1 : 0;
  u.uLithophane.value = appearance.mode === 'lithophane' ? 1 : 0;
  const flat = !!appearance.flatShading;
  if (material.flatShading !== flat) {
    material.flatShading = flat;
    material.needsUpdate = true;
  }
}

// ---------------------------------------------------------------------------------------
// Backdrop (wall / table)
// ---------------------------------------------------------------------------------------

const BACKDROP_FRAGMENT_PARS = /* glsl */ `
uniform vec2 uPoolCenter;
uniform vec2 uPoolRadius;
uniform float uPoolStrength;
uniform vec2 uGlowHalf;
uniform float uGlowFalloff;
uniform vec3 uGlowColor;
varying vec2 vBackdropPos;
`;

const BACKDROP_COLOR = /* glsl */ `
#include <color_fragment>
vec2 poolQ = ( vBackdropPos - uPoolCenter ) / uPoolRadius;
diffuseColor.rgb *= mix( 1.0 - uPoolStrength, 1.0, exp( - dot( poolQ, poolQ ) ) );
`;

const BACKDROP_EMISSIVE = /* glsl */ `
#include <emissivemap_fragment>
vec2 glowQ = abs( vBackdropPos ) - uGlowHalf;
float glowD = length( max( glowQ, 0.0 ) ) + min( max( glowQ.x, glowQ.y ), 0.0 );
totalEmissiveRadiance += uGlowColor * exp( - max( glowD, 0.0 ) / uGlowFalloff );
`;

/**
 * Creates the wall / table material: matte paint with a soft elliptical light pool (as if lit
 * by a gallery spot) and an optional glow around the artwork rectangle (lithophane light box).
 * Expects a plane geometry centred on the artwork centre, in mm.
 * @returns {MeshStandardMaterial} with `userData.uniforms`
 */
export function createBackdropMaterial() {
  const uniforms = {
    uPoolCenter: { value: new Vector2(0, 0) },
    uPoolRadius: { value: new Vector2(1000, 1000) },
    uPoolStrength: { value: 0 },
    uGlowHalf: { value: new Vector2(100, 100) },
    uGlowFalloff: { value: 20 },
    uGlowColor: { value: new Color(0, 0, 0) },
  };
  const material = new MeshStandardMaterial({ color: 0xece8e1, roughness: 0.95, metalness: 0, dithering: true });
  material.name = 'backdrop';
  material.userData.uniforms = uniforms;
  material.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, uniforms);
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nvarying vec2 vBackdropPos;')
      .replace('#include <begin_vertex>', '#include <begin_vertex>\nvBackdropPos = position.xy;');
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', `#include <common>\n${BACKDROP_FRAGMENT_PARS}`)
      .replace('#include <color_fragment>', BACKDROP_COLOR)
      .replace('#include <emissivemap_fragment>', BACKDROP_EMISSIVE);
  };
  material.customProgramCacheKey = () => 'relief-studio-backdrop-v1';
  return material;
}

/**
 * Updates the backdrop look.
 * @param {MeshStandardMaterial} material from {@link createBackdropMaterial}
 * @param {{color:string, brightness:number, extentW:number, extentH:number,
 *          pool:{strength:number, center:number[], radius:number},
 *          glow:{strength:number, color:string, falloff:number}}} look
 *   pool centre is relative to the artwork extent (fractions), radius a multiple of it.
 */
export function updateBackdropMaterial(material, look) {
  const u = material.userData.uniforms;
  material.color.set(look.color).multiplyScalar(look.brightness);
  const halfW = look.extentW / 2;
  const halfH = look.extentH / 2;
  const size = Math.max(look.extentW, look.extentH);
  u.uPoolCenter.value.set(look.pool.center[0] * look.extentW, look.pool.center[1] * look.extentH);
  u.uPoolRadius.value.set((halfW + size * 0.25) * look.pool.radius, (halfH + size * 0.25) * look.pool.radius);
  u.uPoolStrength.value = look.pool.strength;
  u.uGlowHalf.value.set(halfW, halfH);
  u.uGlowFalloff.value = Math.max(1, size * look.glow.falloff);
  u.uGlowColor.value.set(look.glow.color).multiplyScalar(look.glow.strength);
}

// ---------------------------------------------------------------------------------------
// Labels
// ---------------------------------------------------------------------------------------

/**
 * Creates a camera-facing label sprite (rounded dark pill with white text), `heightMm` tall.
 * Rendered on top of everything and excluded from tone mapping so it stays crisp.
 * @param {string} text
 * @param {number} heightMm
 * @returns {Sprite}
 */
export function createLabelSprite(text, heightMm) {
  const font = '600 88px system-ui, -apple-system, "Segoe UI", sans-serif';
  const h = 144;
  const canvas = document.createElement('canvas');
  const ctx = canvas.getContext('2d');
  ctx.font = font;
  canvas.width = Math.ceil(Math.max(h * 1.25, ctx.measureText(text).width + 88));
  canvas.height = h;                                   // resizing resets the context state
  ctx.fillStyle = 'rgba(24, 24, 27, 0.78)';
  ctx.beginPath();
  ctx.roundRect(0, 0, canvas.width, h, h / 2);
  ctx.fill();
  ctx.fillStyle = '#ffffff';
  ctx.font = font;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(text, canvas.width / 2, h / 2 + 4);
  const texture = new CanvasTexture(canvas);
  texture.colorSpace = SRGBColorSpace;
  texture.minFilter = LinearMipmapLinearFilter;
  texture.anisotropy = 4;
  const material = new SpriteMaterial({
    map: texture, transparent: true, depthTest: false, depthWrite: false, toneMapped: false, fog: false,
  });
  const sprite = new Sprite(material);
  sprite.scale.set(heightMm * (canvas.width / h), heightMm, 1);
  sprite.renderOrder = 10;
  sprite.name = `label-${text}`;
  return sprite;
}
