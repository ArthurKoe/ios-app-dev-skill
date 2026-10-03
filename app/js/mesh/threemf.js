// 3MF (3D Manufacturing Format, core specification 1.x) package writer.
//
// Package parts:
//   [Content_Types].xml   OPC content types
//   _rels/.rels           root relationship → /3D/3dmodel.model
//   3D/3dmodel.model      the model: one <object> per input mesh, one build <item> per object
//   Metadata/Prusa_Slicer_custom_gcode_per_print_z.xml   (only with colorChanges, EXPERIMENTAL)
//
// The model XML is written straight into a growable byte buffer (numbers formatted digit by digit),
// so meshes with millions of triangles need neither giant JS strings nor per-number allocations;
// most of the time goes into deflate (2 M triangles: ~136 MB of XML, ~5 s in total, ~18 MB zipped).

import { zipSync } from '../../vendor/fflate/fflate.js';

const CORE_NS = 'http://schemas.microsoft.com/3dmanufacturing/core/2015/02';
const MODEL_REL = 'http://schemas.microsoft.com/3dmanufacturing/2013/01/3dmodel';
const PRUSA_COLOR_FILE = 'Metadata/Prusa_Slicer_custom_gcode_per_print_z.xml';
const ARRANGE_GAP_MM = 5;
/** Height offset for colour changes when the layer height is unknown (see write3MF). */
const UNKNOWN_LAYER_OFFSET_MM = 0.01;

/**
 * Writes a 3MF package (millimetres).
 *
 * Objects without a `transform` are placed side by side along +x with a 5 mm gap (the first one at
 * its own coordinates) so several tiles in one file do not overlap on the build plate.
 *
 * Colour changes (EXPERIMENTAL): when `colorChanges` is non-empty, PrusaSlicer's
 * `Metadata/Prusa_Slicer_custom_gcode_per_print_z.xml` is added with one M600 colour change per
 * entry (single-extruder mode), so PrusaSlicer opens the file with the filament swaps already on
 * the layer slider. Other slicers ignore this part. `zMm` is the height at which the new colour
 * starts (ResolvedBand.zFrom, the top of the last layer in the previous colour). PrusaSlicer applies
 * a change to the first layer whose top is >= print_z, so print_z = zMm + layerHeightMm (the top of
 * the first layer in the new colour); without `layerHeightMm` a 0.01 mm offset selects the same layer
 * for any layer height.
 *
 * @param {{name:string, mesh:import('../types.js').Mesh, transform?:number[]}[]} objects
 *   `transform`: 3MF affine matrix as 12 numbers (m00 m01 m02 m10 m11 m12 m20 m21 m22 m30 m31 m32)
 * @param {{title?:string, colorChanges?:{zMm:number, color:string}[], layerHeightMm?:number,
 *   level?:number}} [options] `level` = deflate level 0–9 for the model part (default 1: model XML
 *   compresses ~8:1 already at level 1, higher levels are 2–3× slower for ~3 % smaller files)
 * @returns {Uint8Array} zip archive
 */
export function write3MF(objects, { title, colorChanges, layerHeightMm, level = 1 } = {}) {
  if (!Array.isArray(objects) || objects.length === 0) throw new RangeError('write3MF needs at least one object');
  const hasColors = Array.isArray(colorChanges) && colorChanges.length > 0;
  /** @type {Record<string, Uint8Array | [Uint8Array, {level:number}]>} */
  const files = {
    '[Content_Types].xml': utf8(contentTypesXml(hasColors)),
    '_rels/.rels': utf8(relsXml()),
    '3D/3dmodel.model': [modelXml(objects, title), { level }],
  };
  if (hasColors) files[PRUSA_COLOR_FILE] = utf8(prusaColorChangesXml(colorChanges, layerHeightMm));
  return zipSync(files, { level: 6 });
}

/**
 * PrusaSlicer's per-print-z custom G-code list with one colour change (type 0, M600) per entry.
 * @param {{zMm:number, color:string}[]} colorChanges
 * @param {number} [layerHeightMm]
 * @returns {string}
 */
export function prusaColorChangesXml(colorChanges, layerHeightMm) {
  const offset = layerHeightMm > 0 ? layerHeightMm : UNKNOWN_LAYER_OFFSET_MM;
  const codes = colorChanges
    .map(({ zMm, color }) => {
      if (!Number.isFinite(zMm)) throw new RangeError(`invalid colour change height ${zMm}`);
      return { printZ: zMm + offset, color: normalizeColor(color) };
    })
    .sort((a, b) => a.printZ - b.printZ)
    .map(({ printZ, color }) =>
      `<code print_z="${num(printZ)}" type="0" extruder="1" color="${color}" extra="" gcode="M600"/>`);
  return [
    '<?xml version="1.0" encoding="utf-8"?>',
    '<custom_gcodes_per_print_z>',
    ...codes,
    '<mode value="SingleExtruder"/>',
    '</custom_gcodes_per_print_z>',
    '',
  ].join('\n');
}

/**
 * @param {boolean} withXml declare the .xml content type (Metadata part present)
 * @returns {string}
 */
function contentTypesXml(withXml) {
  return '<?xml version="1.0" encoding="UTF-8"?>\n'
    + '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">\n'
    + ' <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>\n'
    + ' <Default Extension="model" ContentType="application/vnd.ms-package.3dmanufacturing-3dmodel+xml"/>\n'
    + (withXml ? ' <Default Extension="xml" ContentType="application/xml"/>\n' : '')
    + '</Types>\n';
}

/** @returns {string} */
function relsXml() {
  return '<?xml version="1.0" encoding="UTF-8"?>\n'
    + '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">\n'
    + ` <Relationship Target="/3D/3dmodel.model" Id="rel0" Type="${MODEL_REL}"/>\n`
    + '</Relationships>\n';
}

/**
 * @param {{name:string, mesh:import('../types.js').Mesh, transform?:number[]}[]} objects
 * @param {string|undefined} title
 * @returns {Uint8Array} UTF-8 model XML
 */
function modelXml(objects, title) {
  let estimate = 1024;
  for (const { mesh } of objects) estimate += mesh.positions.length * 15 + mesh.indices.length * 17 + 256;
  const w = new ByteWriter(estimate);
  w.text('<?xml version="1.0" encoding="UTF-8"?>\n');
  w.text(`<model unit="millimeter" xml:lang="en-US" xmlns="${CORE_NS}">\n`);
  if (title) w.text(` <metadata name="Title">${escapeXml(title)}</metadata>\n`);
  w.text(' <metadata name="Application">Relief Studio</metadata>\n');
  w.text(' <resources>\n');
  objects.forEach(({ name, mesh }, i) => writeObject(w, i + 1, name, mesh));
  w.text(' </resources>\n <build>\n');
  let nextX = 0;
  objects.forEach(({ mesh, transform }, i) => {
    let matrix = transform;
    if (!matrix) {
      const [minX, maxX] = xRange(mesh.positions);
      const dx = i === 0 ? 0 : nextX - minX;
      matrix = [1, 0, 0, 0, 1, 0, 0, 0, 1, dx, 0, 0];
      nextX = maxX + dx + ARRANGE_GAP_MM;
    } else if (transform.length !== 12 || !transform.every(Number.isFinite)) {
      throw new RangeError('3MF transform must be 12 finite numbers');
    }
    const isIdentity = matrix.every((v, k) => v === (k === 0 || k === 4 || k === 8 ? 1 : 0));
    w.text(`  <item objectid="${i + 1}"${isIdentity ? '' : ` transform="${matrix.map(num).join(' ')}"`}/>\n`);
  });
  w.text(' </build>\n</model>\n');
  return w.bytes();
}

/**
 * @param {ByteWriter} w
 * @param {number} id
 * @param {string} name
 * @param {import('../types.js').Mesh} mesh
 */
function writeObject(w, id, name, mesh) {
  const { positions: p, indices: idx } = mesh;
  if (p.length % 3 !== 0 || idx.length % 3 !== 0) throw new RangeError(`mesh "${name}" has a partial vertex or triangle`);
  const nv = p.length / 3;
  w.text(`  <object id="${id}" type="model" name="${escapeXml(name ?? `object ${id}`)}">\n   <mesh>\n    <vertices>\n`);
  for (let i = 0; i < p.length; i += 3) {
    w.ascii('<vertex x="');
    w.decimal(p[i]);
    w.ascii('" y="');
    w.decimal(p[i + 1]);
    w.ascii('" z="');
    w.decimal(p[i + 2]);
    w.ascii('"/>\n');
  }
  w.text('    </vertices>\n    <triangles>\n');
  for (let i = 0; i < idx.length; i += 3) {
    const a = idx[i], b = idx[i + 1], c = idx[i + 2];
    if (a >= nv || b >= nv || c >= nv) throw new RangeError(`triangle ${i / 3} references a missing vertex`);
    w.ascii('<triangle v1="');
    w.uint(a);
    w.ascii('" v2="');
    w.uint(b);
    w.ascii('" v3="');
    w.uint(c);
    w.ascii('"/>\n');
  }
  w.text('    </triangles>\n   </mesh>\n  </object>\n');
}

/**
 * Growable UTF-8 byte buffer with allocation-free number formatting.
 */
class ByteWriter {
  /** @param {number} capacity initial size in bytes */
  constructor(capacity) {
    this.buf = new Uint8Array(Math.max(64, Math.ceil(capacity)));
    this.pos = 0;
    this.encoder = new TextEncoder();
  }

  /** @param {number} n bytes about to be written */
  reserve(n) {
    if (this.pos + n <= this.buf.length) return;
    const next = new Uint8Array(Math.max(this.buf.length * 2, this.pos + n));
    next.set(this.buf.subarray(0, this.pos));
    this.buf = next;
  }

  /** Any text (UTF-8 encoded). @param {string} s */
  text(s) {
    const bytes = this.encoder.encode(s);
    this.reserve(bytes.length);
    this.buf.set(bytes, this.pos);
    this.pos += bytes.length;
  }

  /** Short ASCII-only literal. @param {string} s */
  ascii(s) {
    this.reserve(s.length);
    for (let i = 0; i < s.length; i++) this.buf[this.pos++] = s.charCodeAt(i);
  }

  /** Non-negative integer. @param {number} v */
  uint(v) {
    this.reserve(16);
    const buf = this.buf;
    let n = v;
    const start = this.pos;
    do {
      const q = Math.floor(n / 10);
      buf[this.pos++] = 48 + (n - q * 10);
      n = q;
    } while (n > 0);
    for (let i = start, j = this.pos - 1; i < j; i++, j--) {
      const t = buf[i];
      buf[i] = buf[j];
      buf[j] = t;
    }
  }

  /** Same text as num(v): at most 4 decimals, no trailing zeros, no "-0". @param {number} v */
  decimal(v) {
    if (!Number.isFinite(v)) throw new RangeError(`cannot write non-finite coordinate ${v}`);
    const r = Math.round(v * 1e4);
    if (r === 0) {
      this.ascii('0');
      return;
    }
    if (r < 0) this.ascii('-');
    const a = Math.abs(r);
    const whole = Math.floor(a / 1e4);
    let frac = a - whole * 1e4;
    this.uint(whole);
    if (frac === 0) return;
    let digits = 4;
    while (frac % 10 === 0) {
      frac /= 10;
      digits--;
    }
    this.reserve(digits + 1);
    const buf = this.buf;
    buf[this.pos++] = 46; // '.'
    for (let i = digits - 1; i >= 0; i--) {
      buf[this.pos + i] = 48 + (frac % 10);
      frac = Math.floor(frac / 10);
    }
    this.pos += digits;
  }

  /** @returns {Uint8Array} the written bytes (view, no copy) */
  bytes() {
    return this.buf.subarray(0, this.pos);
  }
}

/**
 * Compact decimal: at most 4 decimals, no trailing zeros, no "-0".
 * @param {number} v
 * @returns {string}
 */
function num(v) {
  const r = Math.round(v * 1e4) / 1e4;
  return r === 0 ? '0' : String(r);
}

/**
 * @param {Float32Array} p
 * @returns {[number, number]}
 */
function xRange(p) {
  let lo = Infinity;
  let hi = -Infinity;
  for (let i = 0; i < p.length; i += 3) {
    if (p[i] < lo) lo = p[i];
    if (p[i] > hi) hi = p[i];
  }
  return p.length ? [lo, hi] : [0, 0];
}

/**
 * @param {string} color '#rgb' or '#rrggbb'
 * @returns {string} '#RRGGBB'
 */
function normalizeColor(color) {
  const m = /^#?([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(String(color).trim());
  if (!m) throw new RangeError(`invalid colour ${color}`);
  const hex = m[1].length === 3 ? [...m[1]].map((c) => c + c).join('') : m[1];
  return `#${hex.toUpperCase()}`;
}

/**
 * @param {string} s
 * @returns {string}
 */
function escapeXml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' })[c]);
}

/**
 * @param {string} s
 * @returns {Uint8Array}
 */
function utf8(s) {
  return new TextEncoder().encode(s);
}
