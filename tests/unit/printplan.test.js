import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { buildPrintPlanHtml, tileLayoutSvg } from '../../app/js/export/printPlan.js';
import { createDefaultProject } from '../../app/js/state/project.js';
import {
  contrastText, escapeHtml, formatDuration, formatGrams, formatKm, formatMetres, formatScale,
} from '../../app/js/ui/format.js';

const ATTRIBUTION = 'Contains modified Copernicus DEM data © DLR e.V. 2010-2014';
const PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

function syntheticPlan(overrides = {}) {
  const project = createDefaultProject();
  project.name = 'Alps <script>alert("x")</script> & co';
  project.layout = { cols: 3, rows: 2, tileW: 200, tileH: 180 };
  project.filaments.owned = ['pla-snow-white'];
  Object.assign(project, overrides.project ?? {});
  const layout = {
    cols: 3, rows: 2, tileW: 200, tileH: 180, artW: 600, artH: 360,
    scaleMPerMm: 1500, scaleDenominator: 1_500_000, spx: 500, spy: 450, nx: 1501, ny: 901, dx: 0.4, dy: 0.4,
    fitsBed: true, rotateOnBed: false, warnings: [],
  };
  const zmap = { floorM: 100, mmPerM: 0.004, baseMm: 3, exaggeration: 6, minElevM: 120, maxElevM: 4600, maxZMm: 21 };
  const bands = [
    { filamentId: 'pla-forest-green', zFrom: 0, zTo: 6.4, layerFrom: 1, elevFromM: null, color: '#2f5d3a', finish: 'matte', name: 'Forest Green' },
    { filamentId: 'pla-stone-grey', zFrom: 6.4, zTo: 12.2, layerFrom: 33, elevFromM: 900, color: '#8a8780', finish: 'matte', name: 'Stone Grey' },
    { filamentId: 'custom-1', zFrom: 12.2, zTo: Infinity, layerFrom: 62, elevFromM: 2600, color: '#f4f4f1', finish: 'silk', name: 'Ice <b>Silk</b>' },
    { filamentId: 'pla-gold', zFrom: 30, zTo: Infinity, layerFrom: 150, elevFromM: 9000, color: '#c9a227', finish: 'silk', name: 'Gold', unused: true },
  ];
  const labels = ['A1', 'A2', 'A3', 'B1', 'B2', 'B3'];
  const estimate = {
    grams: 2450, metres: 820, minutes: 3125, cost: 49.2, spools: 2.45,
    byFilament: [
      { filamentId: 'pla-forest-green', name: 'Forest Green', color: '#2f5d3a', grams: 1500, metres: 500, cost: 30, spools: 1.5 },
      { filamentId: 'pla-snow-white', name: 'Snow & "White"', color: '#f4f4f1', grams: 950, metres: 320, cost: 19.2, spools: 0.95 },
    ],
    tiles: labels.map((label, i) => ({ label, grams: 400 + i, minutes: 500 + i, maxZ: 10 + i })),
  };
  const stats = { minElev: 120, maxElev: 4600, missingFraction: 0, source: 'local', levelLabel: 'Copernicus GLO-30', pixelSizeM: 31 };
  return buildPrintPlanHtml({
    project, layout, zmap, bands, estimate, stats,
    screenshotDataUrl: PNG, attribution: ATTRIBUTION, regionName: 'The Alps', styleName: 'Classic relief',
    generatedAt: new Date('2026-10-03T12:00:00Z'),
    files: labels.map((label) => ({ label, name: `alps_${label}.stl` })),
    ...overrides.args,
  });
}

describe('buildPrintPlanHtml', () => {
  test('is a standalone HTML document with inline CSS and no external resources', () => {
    const html = syntheticPlan();
    assert.match(html, /^<!doctype html>/);
    assert.match(html, /<style>[\s\S]*@page[\s\S]*<\/style>/);
    assert.doesNotMatch(html, /<link\b|<script\b|src="http/);
  });

  test('lists every tile in the table and the layout diagram', () => {
    const html = syntheticPlan();
    for (const label of ['A1', 'A2', 'A3', 'B1', 'B2', 'B3']) {
      assert.match(html, new RegExp(`<td class="tag">${label}</td>`), `tile row ${label}`);
      assert.match(html, new RegExp(`class="lbl">${label}</text>`), `diagram label ${label}`);
      assert.ok(html.includes(`alps_${label}.stl`));
    }
    assert.equal((html.match(/class="tile"/g) ?? []).length, 6);
    assert.ok(html.includes('600 mm') && html.includes('360 mm'), 'overall dimensions');
    assert.ok(html.includes('1:1,500,000'), 'scale');
  });

  test('contains the colour change table with layers, heights and swatches', () => {
    const html = syntheticPlan();
    assert.match(html, /Colour changes/);
    assert.match(html, /same for every tile/);
    assert.match(html, /<td class="num">33<\/td><td class="num">6\.40 mm<\/td>/);
    assert.match(html, /<td class="num">62<\/td><td class="num">12\.20 mm<\/td>/);
    assert.match(html, /background:#8a8780/);
    assert.match(html, /Not reached by this terrain: Gold/);
  });

  test('includes the shopping list, instructions and data attribution', () => {
    const html = syntheticPlan();
    assert.match(html, /Filament shopping list/);
    assert.match(html, /2\.45 kg/);
    assert.match(html, /€49\.20/);
    assert.match(html, /<span class="pill">owned<\/span>/);
    assert.match(html, /face up/);
    assert.match(html, /No supports/);
    assert.match(html, /A1 is the <strong>top-left<\/strong>/);
    assert.match(html, /elephant-foot/);
    assert.ok(html.includes(escapeHtml(ATTRIBUTION)));
    assert.ok(html.includes(`<img src="${PNG}"`));
  });

  test('escapes user-provided text', () => {
    const html = syntheticPlan();
    assert.ok(!html.includes('<script>alert'), 'project name must be escaped');
    assert.ok(html.includes('Alps &lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt; &amp; co'));
    assert.ok(!html.includes('<b>Silk</b>'));
    assert.ok(html.includes('Ice &lt;b&gt;Silk&lt;/b&gt;'));
    assert.ok(html.includes('Snow &amp; &quot;White&quot;'));
  });

  test('rejects non-image screenshot URLs and handles single-colour projects', () => {
    const project = createDefaultProject();
    project.colors.mode = 'single';
    const html = syntheticPlan({
      project: { colors: project.colors },
      args: { screenshotDataUrl: 'javascript:alert(1)', bands: [{ filamentId: 'w', zFrom: 0, zTo: Infinity, layerFrom: 1, elevFromM: null, color: '#ffffff', finish: 'matte', name: 'White' }] },
    });
    assert.ok(!html.includes('javascript:'));
    assert.ok(!html.includes('<img'));
    assert.match(html, /no colour changes needed/);
    assert.doesNotMatch(html, /Colour changes/);
  });

  test('mentions live-data attribution for live sources and magnets when enabled', () => {
    const project = createDefaultProject();
    project.back.magnets.enabled = true;
    const html = syntheticPlan({
      project: { back: project.back },
      args: { stats: { minElev: 0, maxElev: 100, source: 'live', levelLabel: 'AWS Terrain Tiles z12', pixelSizeM: 30 } },
    });
    assert.match(html, /AWS Terrain Tiles/);
    assert.match(html, /magnets/);
  });
});

describe('tileLayoutSvg', () => {
  test('draws one labelled rectangle per tile', () => {
    const svg = tileLayoutSvg({ cols: 4, rows: 2, tileW: 246, tileH: 246, artW: 984, artH: 492 });
    assert.equal((svg.match(/<rect /g) ?? []).length, 8);
    assert.ok(svg.includes('>A1</text>') && svg.includes('>B4</text>'));
    assert.match(svg, /viewBox="0 0 [\d.]+ [\d.]+"/);
  });
});

describe('format helpers', () => {
  test('format numbers for humans', () => {
    assert.equal(formatGrams(840.4), '840 g');
    assert.equal(formatGrams(1240), '1.24 kg');
    assert.equal(formatMetres(1534), '1.53 km');
    assert.equal(formatDuration(45), '45 min');
    assert.equal(formatDuration(200), '3 h 20 min');
    assert.equal(formatDuration(3000), '2 d 2 h');
    assert.equal(formatKm(0.85), '850 m');
    assert.equal(formatKm(12.345), '12.3 km');
    assert.equal(formatScale(851234), '1:851,000');
    assert.equal(escapeHtml(`<a href="x">'&'</a>`), '&lt;a href=&quot;x&quot;&gt;&#39;&amp;&#39;&lt;/a&gt;');
    assert.equal(contrastText('#ffffff'), '#000000');
    assert.equal(contrastText('#1f3b5a'), '#ffffff');
  });
});
