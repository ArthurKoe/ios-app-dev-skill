// Unit tests: model/font.js and model/back.js (engraved labels, magnet pockets)
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { FONT_CHARS, measureText, rasterizeText } from '../../app/js/model/font.js';
import { buildBackGrid, labelSpec, magnetPositions } from '../../app/js/model/back.js';

const close = (a, b, eps, msg) => assert.ok(Math.abs(a - b) <= eps, msg ?? `${a} ≉ ${b}`);

function makeProject(back = {}) {
  return {
    back: {
      labels: true, labelDepthMm: 0.6,
      ...back,
      magnets: { enabled: false, diameterMm: 10.2, depthMm: 3.2, perTile: 4, insetMm: 25, ...(back.magnets ?? {}) },
    },
  };
}

const layout = { tileW: 120, tileH: 100 };
const tile = (extra = {}) => ({ label: 'B3', widthMm: 120, heightMm: 100, ...extra });

/** Value of the back grid at tile-local (x, y ↑) in mm (nearest sample). */
function at(grid, W, H, x, y) {
  const c = Math.round((x / W) * (grid.nx - 1));
  const r = Math.round(((H - y) / H) * (grid.ny - 1));
  return grid.z[r * grid.nx + c];
}

/** Bounding box (mm, tile-local) of all recessed samples. */
function bbox(grid, W, H) {
  let x0 = Infinity; let x1 = -Infinity; let y0 = Infinity; let y1 = -Infinity;
  for (let r = 0; r < grid.ny; r++) {
    for (let c = 0; c < grid.nx; c++) {
      if (!grid.z[r * grid.nx + c]) continue;
      const x = (c * W) / (grid.nx - 1);
      const y = H - (r * H) / (grid.ny - 1);
      x0 = Math.min(x0, x); x1 = Math.max(x1, x); y0 = Math.min(y0, y); y1 = Math.max(y1, y);
    }
  }
  return { x0, x1, y0, y1 };
}

const maxOf = (arr) => arr.reduce((a, b) => (b > a ? b : a), -Infinity);

/** Crops a binary mask to the bounding box of its set pixels. */
function cropInk(mask, w, h) {
  let c0 = w; let c1 = -1; let r0 = h; let r1 = -1;
  for (let r = 0; r < h; r++) {
    for (let c = 0; c < w; c++) {
      if (!mask[r * w + c]) continue;
      c0 = Math.min(c0, c); c1 = Math.max(c1, c); r0 = Math.min(r0, r); r1 = Math.max(r1, r);
    }
  }
  const cw = c1 - c0 + 1;
  const ch = r1 - r0 + 1;
  const out = new Uint8Array(cw * ch);
  for (let r = 0; r < ch; r++) out.set(mask.subarray((r0 + r) * w + c0, (r0 + r) * w + c0 + cw), r * cw);
  return { w: cw, h: ch, mask: out };
}

// -------------------------------------------------------------------------------------- font

test('font: every glyph renders, glyphs are distinct, space is blank', () => {
  assert.ok(FONT_CHARS.includes('↑') && FONT_CHARS.includes('-') && FONT_CHARS.includes('.'));
  for (const ch of 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789') assert.ok(FONT_CHARS.includes(ch), ch);
  const seen = new Map();
  for (const ch of FONT_CHARS) {
    const g = rasterizeText(ch, 10, 1, 0.1);
    const ink = g.mask.reduce((a, b) => a + b, 0);
    if (ch === ' ') {
      assert.equal(ink, 0);
      continue;
    }
    assert.ok(ink > 20, `glyph ${ch} is (nearly) empty`);
    const key = `${g.w}:${g.mask.join('')}`;
    assert.ok(!seen.has(key), `glyph ${ch} looks exactly like ${seen.get(key)}`);
    seen.set(key, ch);
  }
});

test('font: geometry, case folding, unknown characters, stroke width', () => {
  const g = rasterizeText('A1', 12, 1.5, 0.25);
  assert.equal(g.h, Math.round(12 / 0.25) + 1);
  assert.equal(g.w, Math.round(g.widthMm / 0.25) + 1);
  assert.equal(g.heightMm, 12);
  assert.deepEqual(rasterizeText('abc', 8, 1, 0.2).mask, rasterizeText('ABC', 8, 1, 0.2).mask);
  assert.ok(measureText('A?B', 8, 1) > measureText('AB', 8, 1));
  assert.ok(measureText('AB', 8, 1) > measureText('A', 8, 1));
  assert.ok(measureText('I', 8, 1) < measureText('M', 8, 1));

  // A vertical stem of 'I' is ≈ strokeMm wide.
  const stem = rasterizeText('I', 12, 1.6, 0.1);
  const mid = Math.round(stem.h / 2);
  let ink = 0;
  for (let c = 0; c < stem.w; c++) ink += stem.mask[mid * stem.w + c];
  close(ink * 0.1, 1.6, 0.25, `stem width ${ink * 0.1}`);
});

test('font: legibility checks (O vs 0, arrow symmetry and direction, dot and dash position)', () => {
  const centre = (g) => g.mask[Math.round(g.h / 2) * g.w + Math.round(g.w / 2)];
  assert.equal(centre(rasterizeText('O', 12, 1.2, 0.1)), 0);
  assert.equal(centre(rasterizeText('0', 12, 1.2, 0.1)), 1);

  const arrow = rasterizeText('↑', 12, 1.2, 0.1);
  let asymmetric = 0;
  for (let r = 0; r < arrow.h; r++) {
    for (let c = 0; c < arrow.w; c++) if (arrow.mask[r * arrow.w + c] !== arrow.mask[r * arrow.w + arrow.w - 1 - c]) asymmetric++;
  }
  assert.ok(asymmetric < arrow.mask.reduce((a, b) => a + b, 0) * 0.03, `arrow asymmetry ${asymmetric}`);
  const rowInk = (g, r) => g.mask.subarray(r * g.w, (r + 1) * g.w).reduce((a, b) => a + b, 0);
  // Arrow head is in the upper half: the widest row is above the middle.
  let widest = 0;
  for (let r = 1; r < arrow.h; r++) if (rowInk(arrow, r) > rowInk(arrow, widest)) widest = r;
  assert.ok(widest < arrow.h / 2, `widest arrow row ${widest} of ${arrow.h}`);

  const dot = rasterizeText('.', 12, 1.2, 0.1);
  for (let r = 0; r < dot.h * 0.7; r++) assert.equal(rowInk(dot, r), 0);
  const dash = rasterizeText('-', 12, 1.2, 0.1);
  for (let r = 0; r < dash.h * 0.3; r++) assert.equal(rowInk(dash, r), 0);
  assert.ok(rowInk(dash, Math.round(dash.h / 2)) > 0);
});

// -------------------------------------------------------------------------------------- back

test('buildBackGrid: null without back features, grid size from the resolution', () => {
  assert.equal(buildBackGrid(tile(), layout, makeProject({ labels: false }), 0.25), null);
  assert.equal(buildBackGrid(tile(), layout, makeProject({ labels: true, labelDepthMm: 0 }), 0.25), null);
  // Magnets that do not fit a tiny tile and no label → null.
  const tiny = { label: 'A1', widthMm: 20, heightMm: 20 };
  assert.equal(buildBackGrid(tiny, layout, makeProject({ labels: false, magnets: { enabled: true, insetMm: 5 } }), 0.25), null);
  const g = buildBackGrid(tile(), layout, makeProject(), 0.25);
  assert.equal(g.nx, 481);
  assert.equal(g.ny, 401);
  assert.equal(g.z.length, 481 * 401);
});

test('buildBackGrid: four corner pockets at the inset, full diameter at full depth', () => {
  const p = makeProject({ labels: false, magnets: { enabled: true, perTile: 4, insetMm: 20, diameterMm: 10, depthMm: 3 } });
  const g = buildBackGrid(tile(), layout, p, 0.25);
  const W = 120;
  const H = 100;
  for (const [x, y] of [[20, 20], [100, 20], [20, 80], [100, 80]]) {
    assert.equal(at(g, W, H, x, y), 3);
    for (let a = 0; a < 360; a += 15) {
      const dx = Math.cos((a * Math.PI) / 180);
      const dy = Math.sin((a * Math.PI) / 180);
      assert.equal(at(g, W, H, x + 5 * dx, y + 5 * dy), 3, 'pocket rim at full depth');
      assert.equal(at(g, W, H, x + 5.6 * dx, y + 5.6 * dy), 0, 'nothing beyond the rim');
    }
  }
  assert.equal(at(g, W, H, 60, 20), 0);
  assert.equal(at(g, W, H, 60, 50), 0);
  assert.equal(at(g, W, H, 20, 50), 0);
});

test('magnetPositions: patterns for 1/2/3/4/6/8 magnets, skipping pockets that do not fit', () => {
  const m = (perTile, extra = {}) => magnetPositions(120, 100, { perTile, diameterMm: 10, insetMm: 20, ...extra });
  assert.deepEqual(m(1), [{ x: 60, y: 80 }]);
  assert.deepEqual(m(2), [{ x: 20, y: 50 }, { x: 100, y: 50 }]);
  assert.deepEqual(m(3), [{ x: 60, y: 80 }, { x: 20, y: 20 }, { x: 100, y: 20 }]);
  assert.deepEqual(m(4), [{ x: 20, y: 80 }, { x: 100, y: 80 }, { x: 20, y: 20 }, { x: 100, y: 20 }]);
  assert.equal(m(6).length, 6);
  assert.equal(m(8).length, 8);
  assert.equal(m(12).length, 8);
  assert.deepEqual(m(0), []);
  // Inset smaller than the radius + wall → nothing fits.
  assert.deepEqual(m(4, { insetMm: 5 }), []);
  // Crowded tile: placed pockets never overlap and stay inside the tile.
  const crowded = magnetPositions(40, 40, { perTile: 4, diameterMm: 10.2, insetMm: 25 });
  assert.ok(crowded.length >= 1 && crowded.length < 4);
  for (const a of crowded) {
    assert.ok(a.x - 5.1 >= 1.2 && a.x + 5.1 <= 38.8 && a.y - 5.1 >= 1.2 && a.y + 5.1 <= 38.8);
    for (const b of crowded) if (a !== b) assert.ok(Math.hypot(a.x - b.x, a.y - b.y) >= 10.2 + 1.2);
  }
});

test('buildBackGrid: 1 magnet at top-centre, 2 at left/right middle', () => {
  const W = 120;
  const H = 100;
  const one = buildBackGrid(tile(), layout, makeProject({ labels: false, magnets: { enabled: true, perTile: 1, insetMm: 20 } }), 0.25);
  assert.equal(at(one, W, H, 60, 80), Math.fround(3.2));
  assert.equal(at(one, W, H, 60, 20), 0);
  const two = buildBackGrid(tile(), layout, makeProject({ labels: false, magnets: { enabled: true, perTile: 2, insetMm: 20 } }), 0.25);
  assert.equal(at(two, W, H, 20, 50), Math.fround(3.2));
  assert.equal(at(two, W, H, 100, 50), Math.fround(3.2));
  assert.equal(at(two, W, H, 60, 80), 0);
});

test('labelSpec: min(12, tileH/6) tall, shrinks to fit narrow tiles', () => {
  const big = labelSpec(246, 246, 'A1 ↑');
  assert.equal(big.heightMm, 12);
  close(big.strokeMm, 1.68, 1e-9);
  const small = labelSpec(200, 60, 'A1 ↑');
  assert.equal(small.heightMm, 10);
  const narrow = labelSpec(30, 246, 'A1 ↑');
  assert.ok(narrow.heightMm < 12);
  close(measureText('A1 ↑', narrow.heightMm, narrow.strokeMm), 24, 1e-6);
});

test('buildBackGrid: label is centred, engraved to labelDepthMm and mirrored in x', () => {
  const W = 120;
  const H = 100;
  const res = 0.25;
  const g = buildBackGrid(tile({ label: 'A7' }), layout, makeProject({ labelDepthMm: 0.8 }), res);
  const values = new Set(g.z);
  assert.deepEqual([...values].sort(), [0, Math.fround(0.8)]);
  const box = bbox(g, W, H);
  close((box.x0 + box.x1) / 2, W / 2, 0.5, `x centre ${(box.x0 + box.x1) / 2}`);
  close((box.y0 + box.y1) / 2, H / 2, 0.5, `y centre ${(box.y0 + box.y1) / 2}`);
  const spec = labelSpec(W, H, 'A7 ↑');
  close(box.y1 - box.y0, spec.heightMm, 0.6);

  // Compare with the plain rendering: the grid must match it mirrored in x only (seen from behind
  // after turning the tile about its vertical axis), never flipped in y.
  const text = rasterizeText('A7 ↑', spec.heightMm, spec.strokeMm, res);
  const engraved = cropInk(Uint8Array.from(g.z, (v) => (v > 0 ? 1 : 0)), g.nx, g.ny);
  const glyphs = cropInk(text.mask, text.w, text.h);
  const ink = glyphs.mask.reduce((a, b) => a + b, 0);
  const mismatch = (flipX, flipY) => {
    let n = 0;
    const w = Math.min(engraved.w, glyphs.w);
    const h = Math.min(engraved.h, glyphs.h);
    for (let r = 0; r < h; r++) {
      for (let c = 0; c < w; c++) {
        const gr = flipY ? glyphs.h - 1 - r : r;
        const gc = flipX ? glyphs.w - 1 - c : c;
        if (engraved.mask[r * engraved.w + c] !== glyphs.mask[gr * glyphs.w + gc]) n++;
      }
    }
    return n;
  };
  assert.ok(Math.abs(engraved.w - glyphs.w) <= 1 && Math.abs(engraved.h - glyphs.h) <= 1);
  assert.ok(mismatch(true, false) < ink * 0.05, `mirrored mismatch ${mismatch(true, false)} of ${ink}`);
  assert.ok(mismatch(false, false) > ink * 0.3, 'an unmirrored label would read backwards');
  assert.ok(mismatch(true, true) > ink * 0.3, 'the text (and arrow) must not be upside down');
});

test('buildBackGrid: magnets and label combine, deeper feature wins', () => {
  const W = 120;
  const H = 100;
  const g = buildBackGrid(tile(), layout, makeProject({ magnets: { enabled: true, perTile: 4, insetMm: 20 } }), 0.25);
  assert.equal(at(g, W, H, 20, 20), Math.fround(3.2));
  assert.deepEqual([...new Set(g.z)].sort((a, b) => a - b), [0, Math.fround(0.6), Math.fround(3.2)]);
});

test('buildBackGrid: recesses stay ≥ 0.8 mm below the top surface', () => {
  const top = (v) => ({ nx: 5, ny: 5, z: new Float32Array(25).fill(v) });
  const p = makeProject({ magnets: { enabled: true, perTile: 4, insetMm: 20 } });
  const g = buildBackGrid(tile(), layout, p, 0.25, top(2));
  assert.equal(maxOf(g.z), Math.fround(1.2));
  // Defaults to tile.top.
  const fromTile = buildBackGrid(tile({ top: top(1) }), layout, makeProject(), 0.25);
  close(maxOf(fromTile.z), 0.2, 1e-6);
  // Too thin for any recess → nothing left.
  assert.equal(buildBackGrid(tile({ top: top(0.85) }), layout, makeProject(), 0.25), null);
  // A thin spot only limits the recess locally (1 mm top grid, thin patch under one pocket's left half).
  const uneven = { nx: 121, ny: 101, z: new Float32Array(121 * 101).fill(10) };
  for (let r = 0; r < 101; r++) {
    for (let c = 0; c < 121; c++) {
      const y = 100 - r;
      if (c >= 95 && c <= 97 && y >= 18 && y <= 22) uneven.z[r * 121 + c] = 1.5;
    }
  }
  const local = buildBackGrid(tile(), layout, p, 0.25, uneven);
  close(at(local, 120, 100, 96, 20), 0.7, 1e-6);
  assert.equal(at(local, 120, 100, 104, 20), Math.fround(3.2));
  assert.equal(at(local, 120, 100, 20, 80), Math.fround(3.2));
});
