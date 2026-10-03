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
//   --preset <region> <name>   start from the default project with a region preset
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { join, resolve } from 'node:path';

import { DEFAULT_PROJECT } from '../app/js/state/project.js';
import { normalizeProject } from '../app/js/state/store.js';
import { computeArtwork, buildTiles, meshTile } from '../app/js/engine/pipeline.js';
import { writeBinarySTL } from '../app/js/mesh/stl.js';
import { write3MF } from '../app/js/mesh/threemf.js';
import { checkWatertight, meshStats } from '../app/js/mesh/analyze.js';
import { resolveBands } from '../app/js/catalog/bands.js';
import { estimateTile, estimateProject } from '../app/js/estimate/filament.js';

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
    project = { ...project, ...JSON.parse(await readFile(opts.file, 'utf8')) };
  }
  if (opts.preset) {
    const [regionId, name] = opts.preset;
    const region = regionsIndex.regions.find((r) => r.id === regionId);
    if (!region) throw new Error(`unknown region ${regionId}`);
    const manifest = JSON.parse(await readFile(join(ROOT, 'data', region.manifest), 'utf8'));
    const preset = manifest.presets.find((p) => p.name.toLowerCase() === name.toLowerCase());
    if (!preset) throw new Error(`unknown preset "${name}"; available: ${manifest.presets.map((p) => p.name).join(', ')}`);
    project.regionId = regionId;
    project.name = preset.name;
    project.frame = { lat: preset.lat, lon: preset.lon, widthKm: preset.widthKm, heightKm: preset.heightKm, rotationDeg: 0 };
  }
  project = normalizeProject(project, { regionsIndex });

  const t0 = performance.now();
  const log = (msg) => console.log(`[${((performance.now() - t0) / 1000).toFixed(1)}s] ${msg}`);
  log(`project "${project.name}" – region ${project.regionId}, ${project.layout.cols}×${project.layout.rows} tiles`);
  const artwork = await computeArtwork(project, {
    regionsIndex, dataBaseUrl: DATA_URL.href, quality: 'export', fetchImpl: fileFetch,
    onProgress: () => {},
  });
  const { layout, zmap, stats } = artwork;
  log(`terrain ${stats.minElev.toFixed(0)}–${stats.maxElev.toFixed(0)} m from ${stats.source} (${stats.levelLabel ?? ''}), `
    + `grid ${layout.nx}×${layout.ny}, scale 1:${layout.scaleDenominator.toLocaleString('en')}, max height ${zmap.maxZMm.toFixed(1)} mm`);

  const bands = resolveBands(project, zmap);
  const tiles = buildTiles(artwork, project, { quality: 'export' });
  await mkdir(opts.out, { recursive: true });
  const prefix = (project.name || 'relief').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'relief';
  const estimates = [];
  let failures = 0;
  for (const tile of tiles) {
    if (opts.tiles && !opts.tiles.has(tile.label)) continue;
    const mesh = meshTile(tile, project, { quality: 'export' });
    const stats = meshStats(mesh);
    if (opts.check) {
      const wt = checkWatertight(mesh);
      if (!wt.ok) failures++;
      log(`${tile.label}: watertight=${wt.ok} boundary=${wt.boundaryEdges} nonManifold=${wt.nonManifoldEdges}`);
    }
    const name = `${prefix}_${tile.label}.${opts.format}`;
    const bytes = opts.format === '3mf'
      ? write3MF([{ name: tile.label, mesh }], { title: `${project.name} ${tile.label}` })
      : new Uint8Array(writeBinarySTL(mesh, `${project.name} ${tile.label}`));
    await writeFile(join(opts.out, name), bytes);
    estimates.push(estimateTile(tile, bands, project));
    log(`${name}: ${stats.triangles.toLocaleString('en')} triangles, ${(stats.volumeMm3 / 1000).toFixed(1)} cm³, ${(bytes.length / 1e6).toFixed(1)} MB`);
  }
  const total = estimateProject(estimates, bands, project);
  log(`filament: ${fmtGrams(total.grams)} · ~${Math.round(total.minutes / 60)} h printing`);
  for (const f of total.byFilament) log(`  ${f.name.padEnd(22)} ${fmtGrams(f.grams)}`);
  if (failures) {
    console.error(`${failures} tile(s) failed the watertight check`);
    process.exit(1);
  }
}

main().catch((err) => {
  console.error(err?.stack || String(err));
  process.exit(1);
});
