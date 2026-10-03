// Built-in single-stroke font for engraving tile labels. DOM-free.
//
// Glyphs are polylines on a grid CAP units tall (y up from the baseline), most 4 units wide.
// Text is rendered by distance-to-segment with round caps, so strokes have a constant width.

/** Cap height in glyph units. */
const CAP = 6;
/** Gap between neighbouring glyphs in glyph units. */
const GAP = 2;

/**
 * Glyph table: [advance width, ...polylines as flat [x0, y0, x1, y1, …] lists].
 * A zero-length polyline draws a dot.
 * @type {Record<string, (number|number[])[]>}
 */
const GLYPHS = {
  A: [4, [0, 0, 0, 4, 2, 6, 4, 4, 4, 0], [0, 2.5, 4, 2.5]],
  B: [4, [0, 0, 0, 6, 3, 6, 4, 5, 4, 4, 3, 3, 0, 3], [3, 3, 4, 2, 4, 1, 3, 0, 0, 0]],
  C: [4, [4, 5, 3, 6, 1, 6, 0, 5, 0, 1, 1, 0, 3, 0, 4, 1]],
  D: [4, [0, 0, 0, 6, 2, 6, 4, 4, 4, 2, 2, 0, 0, 0]],
  E: [4, [4, 6, 0, 6, 0, 0, 4, 0], [0, 3, 3, 3]],
  F: [4, [4, 6, 0, 6, 0, 0], [0, 3, 3, 3]],
  G: [4, [4, 5, 3, 6, 1, 6, 0, 5, 0, 1, 1, 0, 3, 0, 4, 1, 4, 3, 2, 3]],
  H: [4, [0, 0, 0, 6], [4, 0, 4, 6], [0, 3, 4, 3]],
  I: [2, [0, 6, 2, 6], [1, 6, 1, 0], [0, 0, 2, 0]],
  J: [4, [4, 6, 4, 1, 3, 0, 1, 0, 0, 1]],
  K: [4, [0, 0, 0, 6], [4, 6, 0, 2], [1, 3, 4, 0]],
  L: [4, [0, 6, 0, 0, 4, 0]],
  M: [5, [0, 0, 0, 6, 2.5, 2.5, 5, 6, 5, 0]],
  N: [4, [0, 0, 0, 6, 4, 0, 4, 6]],
  O: [4, [1, 0, 0, 1, 0, 5, 1, 6, 3, 6, 4, 5, 4, 1, 3, 0, 1, 0]],
  P: [4, [0, 0, 0, 6, 3, 6, 4, 5, 4, 4, 3, 3, 0, 3]],
  Q: [4, [1, 0, 0, 1, 0, 5, 1, 6, 3, 6, 4, 5, 4, 1, 3, 0, 1, 0], [2.5, 1.5, 4, 0]],
  R: [4, [0, 0, 0, 6, 3, 6, 4, 5, 4, 4, 3, 3, 0, 3], [2, 3, 4, 0]],
  S: [4, [4, 5, 3, 6, 1, 6, 0, 5, 0, 4, 1, 3, 3, 3, 4, 2, 4, 1, 3, 0, 1, 0, 0, 1]],
  T: [4, [0, 6, 4, 6], [2, 6, 2, 0]],
  U: [4, [0, 6, 0, 1, 1, 0, 3, 0, 4, 1, 4, 6]],
  V: [4, [0, 6, 2, 0, 4, 6]],
  W: [5, [0, 6, 1.25, 0, 2.5, 4, 3.75, 0, 5, 6]],
  X: [4, [0, 0, 4, 6], [0, 6, 4, 0]],
  Y: [4, [0, 6, 2, 3, 4, 6], [2, 3, 2, 0]],
  Z: [4, [0, 6, 4, 6, 0, 0, 4, 0]],
  0: [4, [1, 0, 0, 1, 0, 5, 1, 6, 3, 6, 4, 5, 4, 1, 3, 0, 1, 0], [1, 1.5, 3, 4.5]],
  1: [3, [0, 4.5, 1.5, 6, 1.5, 0], [0, 0, 3, 0]],
  2: [4, [0, 5, 1, 6, 3, 6, 4, 5, 4, 4, 0, 0, 4, 0]],
  3: [4, [0, 5, 1, 6, 3, 6, 4, 5, 4, 4, 3, 3, 4, 2, 4, 1, 3, 0, 1, 0, 0, 1], [1.5, 3, 3, 3]],
  4: [4, [3, 0, 3, 6, 0, 2, 4, 2]],
  5: [4, [4, 6, 0, 6, 0, 3.5, 3, 3.5, 4, 2.5, 4, 1, 3, 0, 0, 0]],
  6: [4, [4, 5, 3, 6, 1, 6, 0, 5, 0, 1, 1, 0, 3, 0, 4, 1, 4, 2, 3, 3, 0, 3]],
  7: [4, [0, 6, 4, 6, 1.5, 0]],
  8: [4, [1, 3, 0, 4, 0, 5, 1, 6, 3, 6, 4, 5, 4, 4, 3, 3, 1, 3, 0, 2, 0, 1, 1, 0, 3, 0, 4, 1, 4, 2, 3, 3]],
  9: [4, [0, 1, 1, 0, 3, 0, 4, 1, 4, 5, 3, 6, 1, 6, 0, 5, 0, 4, 1, 3, 4, 3]],
  '-': [3, [0, 3, 3, 3]],
  '.': [1, [0.5, 0, 0.5, 0]],
  ' ': [2.5],
  '↑': [4, [2, 0, 2, 6], [0, 4, 2, 6, 4, 4]],
};

/** Every character the font can draw (lower-case letters are drawn as capitals). */
export const FONT_CHARS = Object.keys(GLYPHS).join('');

/**
 * Width of a rendered text in mm (including the stroke's round caps).
 * @param {string} text
 * @param {number} heightMm total height including the stroke
 * @param {number} strokeMm stroke width
 * @returns {number}
 */
export function measureText(text, heightMm, strokeMm) {
  return layoutText(text, heightMm, strokeMm).widthMm;
}

/**
 * Renders text with the built-in stroke font into a binary mask.
 * Pixel (r, c) is centred at x = c·resMm from the left, y = r·resMm from the top (row 0 = top of
 * the text). Characters without a glyph render as blanks.
 * @param {string} text
 * @param {number} heightMm total text height including the stroke (cap height + stroke)
 * @param {number} strokeMm stroke width (clamped to half the height)
 * @param {number} resMm pixel spacing
 * @returns {{w:number, h:number, mask:Uint8Array, widthMm:number, heightMm:number}}
 */
export function rasterizeText(text, heightMm, strokeMm, resMm) {
  const layout = layoutText(text, heightMm, strokeMm);
  const res = resMm > 0 ? resMm : 0.1;
  const w = Math.max(1, Math.round(layout.widthMm / res) + 1);
  const h = Math.max(1, Math.round(layout.heightMm / res) + 1);
  const mask = new Uint8Array(w * h);
  const radius = layout.strokeMm / 2;
  const radius2 = radius * radius;
  const segs = layout.segments;
  for (let s = 0; s < segs.length; s += 4) {
    const ax = segs[s];
    const ay = segs[s + 1];
    const vx = segs[s + 2] - ax;
    const vy = segs[s + 3] - ay;
    const len2 = vx * vx + vy * vy;
    const c0 = Math.max(0, Math.floor((Math.min(ax, ax + vx) - radius) / res));
    const c1 = Math.min(w - 1, Math.ceil((Math.max(ax, ax + vx) + radius) / res));
    const r0 = Math.max(0, Math.floor((Math.min(ay, ay + vy) - radius) / res));
    const r1 = Math.min(h - 1, Math.ceil((Math.max(ay, ay + vy) + radius) / res));
    for (let r = r0; r <= r1; r++) {
      const py = r * res - ay;
      for (let c = c0; c <= c1; c++) {
        const px = c * res - ax;
        let t = len2 > 0 ? (px * vx + py * vy) / len2 : 0;
        t = t < 0 ? 0 : t > 1 ? 1 : t;
        const ex = px - t * vx;
        const ey = py - t * vy;
        if (ex * ex + ey * ey <= radius2) mask[r * w + c] = 1;
      }
    }
  }
  return { w, h, mask, widthMm: layout.widthMm, heightMm: layout.heightMm };
}

/**
 * Lays out text: stroke segments in mm (x from the left, y from the top) and the overall size.
 * @param {string} text
 * @param {number} heightMm
 * @param {number} strokeMm
 * @returns {{segments:number[], widthMm:number, heightMm:number, strokeMm:number}}
 */
function layoutText(text, heightMm, strokeMm) {
  const height = heightMm > 0 ? heightMm : 1;
  const stroke = Math.min(strokeMm > 0 ? strokeMm : height * 0.12, height / 2);
  const unit = (height - stroke) / CAP;
  const pad = stroke / 2;
  const segments = [];
  let pen = 0;
  let first = true;
  for (const ch of String(text ?? '')) {
    const glyph = GLYPHS[ch] ?? GLYPHS[ch.toUpperCase()] ?? GLYPHS[' '];
    if (!first) pen += GAP;
    first = false;
    for (let p = 1; p < glyph.length; p++) {
      const pts = /** @type {number[]} */ (glyph[p]);
      // Consecutive point pairs; a single point becomes a zero-length segment (a dot).
      for (let a = 0; a < pts.length; a += 2) {
        const b = a + 2 < pts.length ? a + 2 : a;
        if (b === a && a > 0) break;
        segments.push(pad + (pen + pts[a]) * unit, pad + (CAP - pts[a + 1]) * unit,
          pad + (pen + pts[b]) * unit, pad + (CAP - pts[b + 1]) * unit);
      }
    }
    pen += /** @type {number} */ (glyph[0]);
  }
  return { segments, widthMm: pen * unit + stroke, heightMm: height, strokeMm: stroke };
}
