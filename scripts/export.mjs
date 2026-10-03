#!/usr/bin/env node
// Headless exporter: turns a saved Relief Studio project (.json) into STL/3MF tiles
// using exactly the same pipeline as the web app. Handy for very large prints,
// scripting and CI.
//
//   node scripts/export.mjs my-project.json --out ./prints
//   node scripts/export.mjs my-project.json --tiles A1,B2 --format 3mf --check
//   node scripts/export.mjs --preset alps "Matterhorn & Monte Rosa" --out ./prints
//
// Options:
//   --out <dir>        output directory (default ./export)
//   --format stl|3mf   file format (default stl)
//   --tiles A1,B2      only these tiles (default all)
//   --check            verify every mesh is watertight (exit code 1 otherwise)
//   --preset <region> <name>   frame a region preset (on the default project, or on the given file)
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { join, resolve } from 'node:path';

import {
  DEFAULT_PROJECT, artworkAspect, frameForRect, slugify,
} from '../app/js/state/project.js';
import { normalizeProject } from '../app/js/state/store.js';
import {
  buildTiles, computeArtwork, encodeTileFile, estimateTiles, meshTile, tileFileName,
} from '../app/js/engine/pipeline.js';
import { checkWatertight, meshStats } from '../app/js/mesh/analyze.js';

const ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)));
const DATA_URL = pathToFileURL(join(ROOT, 'data') + '/');

async function fileFetch(input) {
  const url = input instanceof URL ? input : new URL(String(input), DATA_URL);
  try {
    return new Response(await readFile(fileURLToPath(url)), { status: 200 });
  } catch {
    return new Response('not found', { status: 404 });
  }
}

function parseArgs(argv) {
  const opts = { out: 'export', format: 'stl', tiles: null, check: false, file: null, preset: null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--out') opts.out = argv[++i];
    else if (a === '--format') opts.format = argv[++i];
    else if (a === '--tiles') opts.tiles = new Set(argv[++i].split(',').map((s) => s.trim().toUpperCase()));
    else if (a === '--check') opts.check = true;
    else if (a === '--preset') opts.preset = [argv[++i], argv[++i]];
    else if (a === '--help' || a === '-h') opts.help = true;
    else opts.file = a;
  }
  return opts;
}

function fmtGrams(g) {
  return g >= 1000 ? `${(g / 1000).toFixed(2)} kg` : `${Math.round(g)} g`;
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.help || (!opts.file && !opts.preset)) {
    console.log(await readFile(fileURLToPath(import.meta.url), 'utf8').then((s) => s.split('\n').slice(1, 17).map((l) => l.replace(/^\/\/ ?/, '')).join('\n')));
    process.exit(opts.help ? 0 : 1);
  }
  const regionsIndex = JSON.parse(await readFile(join(ROOT, 'data', 'regions.json'), 'utf8'));
  let project = structuredClone(DEFAULT_PROJECT);
  if (opts.file) {
    // normalizeProject fills everything the file leaves out with the defaults.
    project = JSON.parse(await readFile(opts.file, 'utf8'));
  }
  if (opts.preset) {
    const [regionId, name] = opts.preset;
    const region = regionsIndex.regions.find((r) => r.id === regionId);
    if (!region) throw new Error(`unknown region ${regionId}; available: ${regionsIndex.regions.map((r) => r.id).join(', ')}`);
    const manifest = JSON.parse(await readFile(join(ROOT, 'data', region.manifest), 'utf8'));
    const preset = manifest.presets.find((p) => p.name.toLowerCase() === name.toLowerCase());
    if (!preset) throw new Error(`unknown preset "${name}"; available: ${manifest.presets.map((p) => p.name).join(', ')}`);
    // Same framing as the app: the preset rectangle widened to the artwork proportions and kept
    // inside the stored data where possible.
    project.regionId = regionId;
    project.name = preset.name;
    project.frame = frameForRect(preset, artworkAspect(normalizeProject(project).layout), region.bounds);
  }
  const warnings = [];
  project = normalizeProject(project, { warnings });
  warnings.forEach((w) => console.warn(`note: ${w}`));
  if (!['stl', '3mf'].includes(opts.format)) throw new Error(`unknown format "${opts.format}" (stl or 3mf)`);

  const t0 = performance.now();
  const log = (msg) => console.log(`[${((performance.now() - t0) / 1000).toFixed(1)}s] ${msg}`);
  log(`project "${project.name}" – region ${project.regionId}, ${project.layout.cols}×${project.layout.rows} tiles, style ${project.style.id}`);
  const artwork = await computeArtwork(project, {
    regionsIndex, dataBaseUrl: DATA_URL.href, quality: 'export', fetchImpl: fileFetch,
    onProgress: () => {},
  });
  const { layout, zmap, stats } = artwork;
  log(`terrain ${stats.minElev.toFixed(0)}–${stats.maxElev.toFixed(0)} m from ${stats.source} (${stats.levelLabel ?? ''}), `
    + `grid ${layout.nx}×${layout.ny}, scale 1:${layout.scaleDenominator.toLocaleString('en')}, `
    + `exaggeration ${zmap.exaggeration}×, max height ${zmap.maxZMm.toFixed(1)} mm`);
  if (zmap.maxZMm > project.printer.maxZ) console.warn(`warning: ${zmap.maxZMm.toFixed(1)} mm is taller than the printer's ${project.printer.maxZ} mm`);

  const tiles = buildTiles(artwork, project, { quality: 'export' });
  const { bands, estimate } = estimateTiles(tiles, project, zmap);
  await mkdir(opts.out, { recursive: true });
  const prefix = slugify(project.name);
  let failures = 0;
  let written = 0;
  for (const tile of tiles) {
    if (opts.tiles && !opts.tiles.has(tile.label)) continue;
    const mesh = meshTile(tile, project, { quality: 'export', toleranceMm: artwork.field.meshToleranceMm });
    const stats = meshStats(mesh);
    if (opts.check) {
      const wt = checkWatertight(mesh);
      if (!wt.ok) failures++;
      log(`${tile.label}: watertight=${wt.ok} boundary=${wt.boundaryEdges} nonManifold=${wt.nonManifoldEdges} inconsistent=${wt.inconsistentEdges}`);
    }
    const name = tileFileName(prefix, tile.label, opts.format);
    const buffer = encodeTileFile(mesh, {
      format: opts.format, name: `${prefix} ${tile.label}`, title: `${project.name} – tile ${tile.label}`,
      bands, layerHeightMm: project.colors.layerHeightMm,
    });
    await writeFile(join(opts.out, name), new Uint8Array(buffer));
    written++;
    log(`${name}: ${stats.triangles.toLocaleString('en')} triangles, ${(stats.volumeMm3 / 1000).toFixed(1)} cm³, ${(buffer.byteLength / 1e6).toFixed(1)} MB`);
  }
  if (!written) throw new Error(`no tile matches --tiles ${[...opts.tiles].join(',')}`);
  log(`filament: ${fmtGrams(estimate.grams)} · ~${Math.round(estimate.minutes / 60)} h printing (all ${tiles.length} tiles)`);
  for (const f of estimate.byFilament) log(`  ${f.name.padEnd(22)} ${fmtGrams(f.grams)}`);
  for (const b of bands.slice(1).filter((x) => !x.unused)) log(`  colour change at Z ${b.zFrom.toFixed(2)} mm (layer ${b.layerFrom}) → ${b.name}`);
  if (failures) {
    console.error(`${failures} tile(s) failed the watertight check`);
    process.exit(1);
  }
  if (opts.check) log(`all ${written} tile(s) are watertight`);
}

main().catch((err) => {
  // Usage errors read better without a stack trace; DEBUG=1 shows it.
  console.error(process.env.DEBUG ? err?.stack || String(err) : `error: ${err?.message ?? err}`);
  process.exit(1);
});
