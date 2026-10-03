// Standalone, printable HTML "print plan" for a tiled relief. DOM-free (pure string building).

import {
  escapeHtml, formatDuration, formatElevation, formatGrams, formatKm, formatLatLon, formatMetres,
  formatMm, formatMoney, formatNumber, formatScale, contrastText,
} from '../ui/format.js';

const LIVE_ATTRIBUTION = 'Live elevation: AWS Terrain Tiles (Mapzen / Linux Foundation) – sources include SRTM, '
  + 'GMTED2010, ETOPO1, NED, EU-DEM and others; see registry.opendata.aws/terrain-tiles.';

/**
 * Builds a standalone print plan (inline CSS, A4-friendly) describing how to print and assemble the tiles.
 * @param {{
 *   project:object, layout:import('../types.js').Layout, zmap:import('../types.js').ZMap,
 *   bands:(import('../types.js').ResolvedBand & {unused?:boolean})[], estimate:object, stats:object,
 *   screenshotDataUrl?:string|null, attribution?:string, regionName?:string, styleName?:string,
 *   generatedAt?:Date, files?:{name:string, label:string}[], resolutionMm?:number|null
 * }} args resolutionMm = sample spacing actually used for the export (default relief.resolutionMm)
 * @returns {string} complete HTML document
 */
export function buildPrintPlanHtml({
  project, layout, zmap, bands = [], estimate = {}, stats = {}, screenshotDataUrl = null,
  attribution = '', regionName = '', styleName = '', generatedAt = new Date(), files = [], resolutionMm = null,
}) {
  const title = `${project.name} – print plan`;
  const sections = [
    headerSection(project, layout, regionName, generatedAt),
    screenshotSection(screenshotDataUrl, project.name),
    settingsSection(project, layout, zmap, stats, regionName, styleName, resolutionMm),
    layoutSection(project, layout, files),
    tilesSection(layout, estimate),
    colorSection(project, bands),
    shoppingSection(project, estimate),
    instructionsSection(project, bands),
    attributionSection(stats, attribution),
  ];
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(title)}</title>
<style>${STYLES}</style>
</head>
<body>
<main>
${sections.join('\n')}
</main>
</body>
</html>
`;
}

// ---------------------------------------------------------------------------------------------

function headerSection(project, layout, regionName, generatedAt) {
  const date = generatedAt instanceof Date && !Number.isNaN(generatedAt.getTime()) ? generatedAt.toISOString().slice(0, 10) : '';
  const art = `${formatMm(layout.artW, { cm: true })} × ${formatMm(layout.artH, { cm: true })}`;
  return `<header class="top">
  <div>
    <p class="kicker">Relief Studio · print plan</p>
    <h1>${escapeHtml(project.name)}</h1>
    <p class="sub">${escapeHtml(regionName || 'Custom area')} · ${escapeHtml(art)} · ${layout.cols * layout.rows} tile${layout.cols * layout.rows === 1 ? '' : 's'}${date ? ` · ${date}` : ''}</p>
  </div>
  <button class="no-print" type="button" onclick="window.print()">Print this plan</button>
</header>`;
}

function screenshotSection(dataUrl, name) {
  if (typeof dataUrl !== 'string' || !/^data:image\/(png|jpeg|webp);base64,[A-Za-z0-9+/=]+$/.test(dataUrl)) return '';
  return `<figure class="shot"><img src="${dataUrl}" alt="3D preview of ${escapeHtml(name)}"></figure>`;
}

function settingsSection(project, layout, zmap, stats, regionName, styleName, resolutionMm) {
  const { frame, relief, colors, print, back } = project;
  const rows = [
    ['Region', regionName || project.regionId],
    ['Frame centre', formatLatLon(frame.lat, frame.lon)],
    ['Frame size', `${formatKm(frame.widthKm)} × ${formatKm(frame.heightKm)}${frame.rotationDeg ? `, rotated ${formatNumber(frame.rotationDeg, 1)}°` : ''}`],
    ['Scale', `${formatScale(layout.scaleDenominator)} (1 mm = ${formatNumber(layout.scaleMPerMm, 0)} m)`],
    ['Artwork', `${formatMm(layout.artW, { digits: 0 })} × ${formatMm(layout.artH, { digits: 0 })}`],
    ['Tiles', `${layout.cols} × ${layout.rows} tiles of ${formatMm(layout.tileW, { digits: 1 })} × ${formatMm(layout.tileH, { digits: 1 })}`],
    ['Vertical exaggeration', `${formatNumber(zmap?.exaggeration ?? relief.exaggeration, 1)}×${relief.autoExaggeration ? ' (auto)' : ''}`],
    ['Base thickness', formatMm(zmap?.baseMm ?? relief.baseMm, { digits: 1 })],
    ['Elevation range', `${formatElevation(stats.minElev)} – ${formatElevation(stats.maxElev)} (floor ${formatElevation(zmap?.floorM)})`],
    ['Highest point on the print', formatMm(zmap?.maxZMm, { digits: 1 })],
    ['Art style', styleName || titleCase(project.style.id)],
    ['Sample spacing', formatMm(resolutionMm > 0 ? resolutionMm : relief.resolutionMm, { digits: 2 })],
    ['Elevation data', stats.levelLabel
      ? `${stats.levelLabel}${Number.isFinite(stats.pixelSizeM) && !/\d\s*m\b/.test(stats.levelLabel) ? ` (~${formatNumber(stats.pixelSizeM, 0)} m pixels)` : ''}`
      : '–'],
    ['Layers', `${formatMm(colors.firstLayerMm, { digits: 2 })} first layer, then ${formatMm(colors.layerHeightMm, { digits: 2 })}`],
    ['Material & infill', `${print.material}, ${print.infillPct}% infill, ${print.walls} walls`],
    ['Back side', [back.labels ? 'engraved tile labels' : null, back.magnets.enabled ? `${back.magnets.perTile} magnet pockets per tile (⌀${formatNumber(back.magnets.diameterMm, 1)} × ${formatNumber(back.magnets.depthMm, 1)} mm)` : null].filter(Boolean).join(', ') || 'flat'],
  ];
  return `<section>
  <h2>Key settings</h2>
  <table class="kv">${rows.map(([k, v]) => `<tr><th scope="row">${escapeHtml(k)}</th><td>${escapeHtml(v)}</td></tr>`).join('')}</table>
</section>`;
}

function layoutSection(project, layout, files) {
  const fileByLabel = new Map(files.map((f) => [f.label, f.name]));
  return `<section class="avoid-break">
  <h2>Tile layout</h2>
  <p>Seen from the front, as it will hang on the wall. Neighbouring tiles share their edges exactly, so the relief continues seamlessly across the joints.</p>
  ${tileLayoutSvg(layout)}
  ${fileByLabel.size ? `<p class="small">Files: ${[...fileByLabel.values()].map((n) => `<code>${escapeHtml(n)}</code>`).join(', ')}</p>` : ''}
</section>`;
}

/**
 * Inline SVG of the tile grid with labels and dimensions.
 * @param {{cols:number, rows:number, tileW:number, tileH:number, artW:number, artH:number}} layout
 * @returns {string}
 */
export function tileLayoutSvg(layout) {
  const { cols, rows, tileW, tileH, artW, artH } = layout;
  const pad = Math.max(artW, artH) * 0.09;
  const vbW = artW + pad * 2;
  const vbH = artH + pad * 2;
  const font = Math.min(tileW, tileH) * 0.22;
  const small = Math.max(artW, artH) * 0.028;
  const cells = [];
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const label = String.fromCharCode(65 + r) + (c + 1);
      const x = pad + c * tileW;
      const y = pad + r * tileH;
      cells.push(`<rect x="${n(x)}" y="${n(y)}" width="${n(tileW)}" height="${n(tileH)}" class="tile"/>`
        + `<text x="${n(x + tileW / 2)}" y="${n(y + tileH / 2)}" font-size="${n(font)}" class="lbl">${label}</text>`);
    }
  }
  const dimW = `${formatNumber(artW, 0)} mm`;
  const dimH = `${formatNumber(artH, 0)} mm`;
  const tileDim = `each tile ${formatNumber(tileW, 1)} × ${formatNumber(tileH, 1)} mm`;
  return `<svg class="grid" viewBox="0 0 ${n(vbW)} ${n(vbH)}" role="img" aria-label="Tile layout: ${cols} columns by ${rows} rows, ${escapeHtml(tileDim)}">
  ${cells.join('\n  ')}
  <line x1="${n(pad)}" y1="${n(pad * 0.45)}" x2="${n(pad + artW)}" y2="${n(pad * 0.45)}" class="dim"/>
  <text x="${n(pad + artW / 2)}" y="${n(pad * 0.32)}" font-size="${n(small)}" class="dimt">${dimW}</text>
  <line x1="${n(pad * 0.45)}" y1="${n(pad)}" x2="${n(pad * 0.45)}" y2="${n(pad + artH)}" class="dim"/>
  <text x="${n(pad * 0.32)}" y="${n(pad + artH / 2)}" font-size="${n(small)}" class="dimt" transform="rotate(-90 ${n(pad * 0.32)} ${n(pad + artH / 2)})">${dimH}</text>
  <text x="${n(pad + artW / 2)}" y="${n(pad + artH + pad * 0.62)}" font-size="${n(small)}" class="dimt">${escapeHtml(tileDim)} · ↑ top of the artwork</text>
</svg>`;
}

function tilesSection(layout, estimate) {
  const tiles = Array.isArray(estimate.tiles) ? estimate.tiles : [];
  const rows = [];
  for (let r = 0; r < layout.rows; r++) {
    for (let c = 0; c < layout.cols; c++) {
      const label = String.fromCharCode(65 + r) + (c + 1);
      const t = tiles.find((x) => x?.label === label) ?? tiles[r * layout.cols + c] ?? {};
      rows.push(`<tr><td class="tag">${label}</td><td>${formatNumber(layout.tileW, 1)} × ${formatNumber(layout.tileH, 1)} mm</td>`
        + `<td class="num">${formatMm(t.maxZ, { digits: 1 })}</td><td class="num">${formatGrams(t.grams)}</td>`
        + `<td class="num">${formatDuration(t.minutes)}</td><td class="check" aria-label="printed"></td></tr>`);
    }
  }
  return `<section class="avoid-break">
  <h2>Tiles</h2>
  <table class="data">
    <thead><tr><th>Tile</th><th>Size</th><th class="num">Max height</th><th class="num">Filament</th><th class="num">Print time</th><th>Done</th></tr></thead>
    <tbody>${rows.join('')}</tbody>
    <tfoot><tr><th colspan="3">Total</th><th class="num">${formatGrams(estimate.grams)}</th><th class="num">${formatDuration(estimate.minutes)}</th><th></th></tr></tfoot>
  </table>
</section>`;
}

function colorSection(project, bands) {
  const active = bands.filter((b) => !b.unused);
  if (project.colors.mode === 'single' || active.length <= 1) {
    const b = active[0] ?? bands[0];
    return `<section class="avoid-break">
  <h2>Filament</h2>
  <p>${b ? `${swatch(b.color)} <strong>${escapeHtml(b.name)}</strong> for the whole print – ` : ''}no colour changes needed.</p>
</section>`;
  }
  const rows = active.map((b, i) => `<tr><td class="num">${i === 0 ? 'start' : formatNumber(b.layerFrom, 0)}</td>`
    + `<td class="num">${i === 0 ? '0.00 mm' : `${b.zFrom.toFixed(2)} mm`}</td>`
    + `<td>${swatch(b.color)} ${escapeHtml(b.name)}</td>`
    + `<td class="num">${i === 0 ? 'lowest' : `from ${formatElevation(b.elevFromM)}`}</td></tr>`).join('');
  const unused = bands.filter((b) => b.unused);
  return `<section class="avoid-break">
  <h2>Colour changes</h2>
  <p>These layer heights are <strong>the same for every tile</strong>, because all tiles share one height scale. Add a colour change
  (filament change / M600 / pause) in your slicer at each layer below – start each layer change <em>before</em> the listed layer prints.
  Tiles whose relief never reaches a change simply finish in the previous colour.</p>
  <table class="data">
    <thead><tr><th class="num">Layer</th><th class="num">Z</th><th>Filament</th><th class="num">Terrain</th></tr></thead>
    <tbody>${rows}</tbody>
  </table>
  ${unused.length ? `<p class="small">Not reached by this terrain: ${unused.map((b) => escapeHtml(b.name)).join(', ')}.</p>` : ''}
</section>`;
}

function shoppingSection(project, estimate) {
  const list = Array.isArray(estimate.byFilament) ? estimate.byFilament : [];
  if (!list.length) return '';
  const owned = new Set(project.filaments?.owned ?? []);
  const rows = list.map((f) => `<tr><td>${swatch(f.color)} ${escapeHtml(f.name)}${owned.has(f.filamentId) ? ' <span class="pill">owned</span>' : ''}</td>`
    + `<td class="num">${formatGrams(f.grams)}</td><td class="num">${formatMetres(f.metres)}</td>`
    + `<td class="num">${formatNumber(f.spools, 2)}</td><td class="num">${formatMoney(f.cost)}</td></tr>`).join('');
  return `<section class="avoid-break">
  <h2>Filament shopping list</h2>
  <table class="data">
    <thead><tr><th>Filament</th><th class="num">Weight</th><th class="num">Length</th><th class="num">1 kg spools</th><th class="num">Cost</th></tr></thead>
    <tbody>${rows}</tbody>
    <tfoot><tr><th>Total</th><th class="num">${formatGrams(estimate.grams)}</th><th class="num">${formatMetres(estimate.metres)}</th>`
    + `<th class="num">${formatNumber(estimate.spools, 2)}</th><th class="num">${formatMoney(estimate.cost)}</th></tr></tfoot>
  </table>
  <p class="small">Estimates include infill and walls; add 10–15 % for purging, brims and failed prints. Buy each colour from one batch so the tiles match.</p>
</section>`;
}

function instructionsSection(project, bands) {
  const multi = project.colors.mode === 'bands' && bands.filter((b) => !b.unused).length > 1;
  const magnets = project.back.magnets.enabled;
  const labels = project.back.labels;
  const steps = [
    `<strong>Slice each tile face up</strong> – flat side on the bed, relief pointing up. No supports are needed: every surface rises from the one below it.`,
    `Use ${formatMm(project.colors.firstLayerMm, { digits: 2 })} for the first layer and ${formatMm(project.colors.layerHeightMm, { digits: 2 })} for all others${multi ? ' – the colour-change table depends on exactly these heights' : ''}.`,
    multi ? 'Add the colour changes from the table above to <em>each</em> tile (most slicers let you copy them between plates/projects).' : null,
    'Enable <strong>elephant-foot compensation</strong> (≈0.15–0.2 mm) or a light first-layer squish so the tile edges stay straight and the seams close tightly.',
    'Print tiles one at a time with the same filament spool / batch, settings and orientation. Mark each tile in the table when it is done.',
    labels ? 'Each tile has its label engraved on the back (A1 is the <strong>top-left</strong> tile seen from the front); the arrow points to the top of the artwork.' : 'Write the tile label on the back of each tile as soon as it comes off the printer (A1 = top-left seen from the front).',
    'Lay all tiles face down on a soft cloth in mirrored order, then flip them into place face up and check the relief lines up across every seam.',
    magnets
      ? `Glue ${project.back.magnets.perTile} magnets (⌀${formatNumber(project.back.magnets.diameterMm, 1)} mm) into the pockets of each tile – keep the polarity the same on every tile – and matching magnets or a steel sheet on the backing board.`
      : 'Glue the tiles to a rigid backing board (MDF, Dibond or foam board) with a thin, even layer of construction adhesive or double-sided mounting tape. Start with the centre tiles and work outwards.',
    'Press neighbouring tiles together while the adhesive sets; a straight edge clamped along the outside keeps rows aligned.',
    'Hang the board with picture hooks or a French cleat. Raking light from one side brings out the relief best.',
  ].filter(Boolean);
  return `<section>
  <h2>Print &amp; assembly</h2>
  <ol class="steps">${steps.map((s) => `<li>${s}</li>`).join('')}</ol>
</section>`;
}

function attributionSection(stats, attribution) {
  const parts = [];
  if (attribution) parts.push(escapeHtml(attribution));
  if (stats.source === 'live') parts.push(escapeHtml(LIVE_ATTRIBUTION));
  return `<footer>
  <p><strong>Data:</strong> ${parts.join(' ') || 'Elevation data © its respective providers.'}</p>
  <p>Made with Relief Studio.</p>
</footer>`;
}

function swatch(color) {
  const c = /^#[0-9a-f]{6}$/i.test(String(color)) ? color : '#888888';
  return `<span class="sw" style="background:${c};border-color:${contrastText(c) === '#000000' ? '#0003' : '#fff6'}"></span>`;
}

function titleCase(s) {
  return String(s ?? '').replace(/(^|[-_ ])(\w)/g, (_, sep, ch) => (sep ? ' ' : '') + ch.toUpperCase());
}

function n(v) {
  return Number(v.toFixed(2));
}

const STYLES = `
:root { color-scheme: light; --ink:#24221f; --muted:#6b665f; --line:#d9d4cc; --accent:#1f5f7a; --paper:#fff; }
* { box-sizing: border-box; }
body { margin: 0; background: #f3f1ed; color: var(--ink); font: 14px/1.5 system-ui, -apple-system, "Segoe UI", Roboto, sans-serif; }
main { max-width: 190mm; margin: 0 auto; padding: 12mm 10mm; background: var(--paper); }
h1 { font-size: 26px; margin: 0 0 4px; letter-spacing: -0.01em; }
h2 { font-size: 16px; margin: 0 0 8px; color: var(--accent); text-transform: uppercase; letter-spacing: 0.06em; }
section { margin: 0 0 22px; }
.top { display: flex; justify-content: space-between; align-items: flex-start; gap: 16px; border-bottom: 2px solid var(--ink); padding-bottom: 10px; margin-bottom: 18px; }
.kicker { margin: 0; color: var(--muted); font-size: 12px; text-transform: uppercase; letter-spacing: 0.08em; }
.sub { margin: 0; color: var(--muted); }
button { font: inherit; padding: 6px 14px; border: 1px solid var(--accent); background: var(--accent); color: #fff; border-radius: 6px; cursor: pointer; }
.shot { margin: 0 0 22px; }
.shot img { display: block; width: 100%; height: auto; border-radius: 6px; border: 1px solid var(--line); }
table { border-collapse: collapse; width: 100%; }
.kv th { text-align: left; font-weight: 500; color: var(--muted); width: 38%; padding: 3px 8px 3px 0; vertical-align: top; }
.kv td { padding: 3px 0; }
.data th, .data td { border-bottom: 1px solid var(--line); padding: 5px 6px; text-align: left; }
.data thead th { font-size: 12px; color: var(--muted); font-weight: 600; }
.data tfoot th { border-bottom: none; border-top: 2px solid var(--ink); }
.num { text-align: right !important; font-variant-numeric: tabular-nums; }
.tag { font-weight: 700; }
.check { width: 48px; }
.check::after { content: ""; display: inline-block; width: 14px; height: 14px; border: 1.5px solid var(--ink); border-radius: 3px; }
.sw { display: inline-block; width: 14px; height: 14px; border-radius: 3px; border: 1px solid; vertical-align: -2px; margin-right: 4px; }
.pill { font-size: 11px; color: var(--accent); border: 1px solid var(--accent); border-radius: 9px; padding: 0 6px; }
.grid { width: 100%; max-height: 120mm; display: block; margin: 6px 0; }
.grid .tile { fill: #f6f3ee; stroke: var(--ink); stroke-width: 0.6; vector-effect: non-scaling-stroke; }
.grid .lbl { font-weight: 700; fill: var(--ink); text-anchor: middle; dominant-baseline: central; }
.grid .dim { stroke: var(--muted); stroke-width: 0.6; vector-effect: non-scaling-stroke; }
.grid .dimt { fill: var(--muted); text-anchor: middle; dominant-baseline: central; }
.steps li { margin-bottom: 6px; }
.small { font-size: 12px; color: var(--muted); }
footer { border-top: 1px solid var(--line); padding-top: 8px; font-size: 11px; color: var(--muted); }
code { font-size: 12px; }
@page { size: A4; margin: 12mm; }
@media print {
  body { background: #fff; }
  main { padding: 0; max-width: none; }
  .no-print { display: none; }
  .avoid-break, tr, figure { break-inside: avoid; }
  h2 { break-after: avoid; }
}
`;
