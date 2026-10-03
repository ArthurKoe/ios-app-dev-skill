// Engine pipeline: elevation data → artwork height field → tile fields → meshes / estimates.
// Pure and DOM-free: used by engine.worker.js and by Node tests.

import { chooseSource, findRegion, sampleFrame } from '../dem/sampler.js';
import { createSource } from '../dem/sources.js';
import { computeLayout, exportResolutionMm } from '../model/layout.js';
import { computeZMap } from '../model/zmap.js';
import { buildArtworkField } from '../model/styles.js';
import { extractTileFields } from '../model/tiles.js';
import { buildSolid } from '../mesh/solid.js';
import { writeBinarySTL } from '../mesh/stl.js';
import { write3MF } from '../mesh/threemf.js';
import { resolveBands } from '../catalog/bands.js';
import { estimateProject, estimateTile } from '../estimate/filament.js';

/** Maximum number of artwork samples (nx × ny) for interactive previews. */
export const PREVIEW_MAX_SAMPLES = 600_000;
/** Sample spacing of the back-side grid (labels, magnet pockets) for export, in mm. */
export const BACK_RESOLUTION_MM = 0.25;

/** Last preview sampling (elevations only depend on source, frame and grid size). */
let sampleCache = null;

/**
 * Samples the elevation data for the project's frame and turns it into the artwork height field.
 * @param {object} project normalised project
 * @param {{regionsIndex:object, dataBaseUrl:string, quality?:'preview'|'export', fetchImpl?:typeof fetch,
 *          onProgress?:(p:{stage:string, fraction:number, message:string})=>void, signal?:AbortSignal}} opts
 * @returns {Promise<{layout:import('../types.js').Layout, zmap:import('../types.js').ZMap,
 *   stats:{minElev:number, maxElev:number, missingFraction:number, source:'local'|'live', levelLabel:string, pixelSizeM:number},
 *   sampled:{elev:Float32Array, water:Uint8Array, missing:number, minElev:number, maxElev:number},
 *   field:{z:Float32Array, water:Uint8Array, meshToleranceMm?:number}, resolutionMm:number, quality:string}>}
 */
export async function computeArtwork(project, { regionsIndex, dataBaseUrl, quality = 'preview', fetchImpl, onProgress, signal } = {}) {
  const report = (stage, fraction, message) => onProgress?.({ stage, fraction, message });
  const resolutionMm = quality === 'export' ? exportResolutionMm(project) : previewResolution(project);
  const layout = computeLayout(project, resolutionMm);
  const kind = chooseSource(project, regionsIndex);
  const region = findRegion(regionsIndex, project.regionId);
  const groundSpacingM = resolutionMm * layout.scaleMPerMm;
  const frame = project.frame;

  const cacheKey = JSON.stringify([kind, kind === 'local' ? region?.id : null, dataBaseUrl, frame, layout.nx, layout.ny]);
  let sampled;
  let level;
  if (quality === 'preview' && sampleCache?.key === cacheKey) {
    ({ level } = sampleCache);
    sampled = cloneSampled(sampleCache.sampled);
  } else {
    report('data', 0, kind === 'local' ? `Loading ${region?.name ?? 'region'} elevation data…` : 'Loading live elevation tiles…');
    const source = await createSource(kind, { region, dataBaseUrl, fetchImpl });
    signal?.throwIfAborted();
    const info = await source.prepare(frame, groundSpacingM, {
      signal,
      onProgress: (f) => report('data', progressFraction(f), f?.total > 1
        ? `Loading elevation data – ${f.loaded} of ${f.total} ${kind === 'local' ? 'chunks' : 'tiles'}…`
        : 'Loading elevation data…'),
    });
    signal?.throwIfAborted();
    level = {
      label: info?.label ?? (kind === 'local' ? `${region?.name ?? 'Local'} elevation data` : 'AWS Terrain Tiles'),
      pixelSizeM: info?.pixelSizeM ?? NaN,
    };
    report('sample', 0, `Sampling ${formatCount(layout.nx * layout.ny)} points…`);
    sampled = await sampleFrame(source, frame, layout.nx, layout.ny, {
      signal,
      onProgress: (f) => report('sample', progressFraction(f), 'Sampling terrain…'),
    });
    signal?.throwIfAborted();
    if (quality === 'preview') sampleCache = { key: cacheKey, level, sampled: cloneSampled(sampled) };
  }

  const stats = {
    minElev: sampled.minElev,
    maxElev: sampled.maxElev,
    missingFraction: sampled.missing / (layout.nx * layout.ny),
    source: kind,
    levelLabel: level.label,
    pixelSizeM: level.pixelSizeM,
  };
  report('model', 0, 'Shaping the relief…');
  const zmap = computeZMap(project, layout, stats);
  const field = buildArtworkField(sampled, layout, zmap, project);
  return { layout, zmap, stats, sampled, field, resolutionMm, quality };
}

/**
 * Splits the artwork field into per-tile fields (shared edges). Back features only for export.
 * @param {{field:object, layout:import('../types.js').Layout}} artwork
 * @param {object} project
 * @param {{quality?:'preview'|'export'}} [opts]
 * @returns {import('../types.js').TileField[]}
 */
export function buildTiles(artwork, project, { quality = 'preview' } = {}) {
  return extractTileFields(artwork.field, artwork.layout, project, {
    withBack: quality === 'export',
    backResMm: BACK_RESOLUTION_MM,
  });
}

/**
 * Builds the closed, printable solid of one tile in tile-local coordinates.
 * @param {import('../types.js').TileField} tileField
 * @param {object} project
 * @param {{quality?:'preview'|'export', toleranceMm?:number|null}} [opts] toleranceMm = the artwork
 *   field's meshToleranceMm; when null/undefined export uses relief.simplifyMm and preview the full grid
 * @returns {import('../types.js').Mesh & {water?:Uint8Array}}
 */
export function meshTile(tileField, project, { quality = 'preview', toleranceMm } = {}) {
  return buildSolid({
    top: tileField.top,
    bottom: tileField.bottom,
    widthMm: tileField.widthMm,
    heightMm: tileField.heightMm,
    topToleranceMm: toleranceMm ?? (quality === 'export' ? project.relief.simplifyMm : 0),
    topWater: quality === 'preview' ? tileField.water ?? null : null,
  });
}

/**
 * Builds everything the interactive preview needs from an artwork.
 * @param {Awaited<ReturnType<typeof computeArtwork>>} artwork
 * @param {object} project
 * @returns {{tiles:object[], bands:import('../types.js').ResolvedBand[], estimate:object, stats:object,
 *   layout:import('../types.js').Layout, zmap:import('../types.js').ZMap}}
 */
export function buildPreview(artwork, project) {
  return previewFromTileFields(artwork, project, buildTiles(artwork, project, { quality: 'preview' }));
}

/**
 * Like buildPreview, but reuses already extracted preview tile fields (the worker keeps them
 * for later 'estimate' requests).
 * @param {Awaited<ReturnType<typeof computeArtwork>>} artwork
 * @param {object} project
 * @param {import('../types.js').TileField[]} tileFields
 * @returns {ReturnType<typeof buildPreview>}
 */
export function previewFromTileFields(artwork, project, tileFields) {
  const { bands, estimate } = estimateTiles(tileFields, project, artwork.zmap);
  const tiles = tileFields.map((t) => {
    const mesh = meshTile(t, project, { quality: 'preview', toleranceMm: artwork.field.meshToleranceMm });
    return { ...tileMeta(t), mesh, water: mesh.water ?? null };
  });
  return {
    tiles, bands, estimate,
    stats: artwork.stats,
    layout: artwork.layout,
    zmap: artwork.zmap,
    resolutionMm: artwork.resolutionMm,
  };
}

/**
 * Resolves colour bands and filament / time / cost estimates for a set of tile fields.
 * @param {import('../types.js').TileField[]} tileFields
 * @param {object} project
 * @param {import('../types.js').ZMap} zmap
 * @returns {{bands:import('../types.js').ResolvedBand[], estimate:object}}
 */
export function estimateTiles(tileFields, project, zmap) {
  const bands = resolveBands(project, zmap);
  const perTile = tileFields.map((t) => ({ label: t.label, row: t.row, col: t.col, ...estimateTile(t, bands, project) }));
  return { bands, estimate: estimateProject(perTile, bands, project) };
}

/**
 * Serialises one tile mesh to the requested file format.
 * @param {import('../types.js').Mesh} mesh
 * @param {{format:'stl'|'3mf', name:string, title?:string, bands?:import('../types.js').ResolvedBand[]}} opts
 * @returns {ArrayBuffer}
 */
export function encodeTileFile(mesh, { format, name, title = name, bands = [] }) {
  if (format === '3mf') {
    const colorChanges = bands.slice(1).filter((b) => !b.unused && Number.isFinite(b.zFrom))
      .map((b) => ({ zMm: b.zFrom, color: b.color }));
    return toArrayBuffer(write3MF([{ name, mesh }], { title, colorChanges }));
  }
  return writeBinarySTL(mesh, name);
}

/**
 * File name of an exported tile: `<prefix>_<label>.<ext>`.
 * @param {string} prefix
 * @param {string} label
 * @param {'stl'|'3mf'} format
 * @returns {string}
 */
export function tileFileName(prefix, label, format) {
  return `${sanitizePrefix(prefix)}_${label}.${format === '3mf' ? '3mf' : 'stl'}`;
}

/**
 * Restricts a file name prefix to safe characters.
 * @param {string} prefix
 * @returns {string}
 */
export function sanitizePrefix(prefix) {
  return String(prefix ?? '').trim().replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^[-.]+|-+$/g, '').slice(0, 60) || 'relief';
}

/**
 * Sample spacing for the interactive preview: as fine as the export (never finer) while keeping
 * the artwork grid within PREVIEW_MAX_SAMPLES.
 * @param {object} project
 * @returns {number} mm
 */
export function previewResolution(project) {
  const { cols, rows, tileW, tileH } = project.layout;
  let res = Math.max(exportResolutionMm(project), Math.sqrt((cols * tileW * rows * tileH) / PREVIEW_MAX_SAMPLES));
  for (let i = 0; i < 200; i++) {
    const nx = cols * Math.max(2, Math.round(tileW / res)) + 1;
    const ny = rows * Math.max(2, Math.round(tileH / res)) + 1;
    if (nx * ny <= PREVIEW_MAX_SAMPLES) break;
    res *= 1.02;
  }
  return res;
}

/**
 * Metadata of a tile field without its grids.
 * @param {import('../types.js').TileField} t
 * @returns {{label:string, row:number, col:number, x0:number, y0:number, widthMm:number, heightMm:number}}
 */
export function tileMeta(t) {
  return { label: t.label, row: t.row, col: t.col, x0: t.x0, y0: t.y0, widthMm: t.widthMm, heightMm: t.heightMm };
}

/** Forgets the cached preview sampling (decoded elevation chunks stay cached in dem/). */
export function clearPipelineCaches() {
  sampleCache = null;
}

// ---------------------------------------------------------------------------------------------

function progressFraction(p) {
  const f = typeof p === 'number' ? p : p?.fraction ?? (p?.total ? p.done / p.total : 0);
  return Number.isFinite(f) ? Math.min(1, Math.max(0, f)) : 0;
}

function cloneSampled(s) {
  return { ...s, elev: s.elev.slice(), water: s.water ? s.water.slice() : s.water };
}

function toArrayBuffer(u8) {
  if (u8 instanceof ArrayBuffer) return u8;
  return u8.byteOffset === 0 && u8.byteLength === u8.buffer.byteLength ? u8.buffer : u8.slice().buffer;
}

function formatCount(n) {
  return n >= 1e6 ? `${(n / 1e6).toFixed(1)} M` : `${Math.round(n / 1000)} k`;
}
