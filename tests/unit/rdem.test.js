import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { deflateSync } from 'node:zlib';
import { decodeRDEM } from '../../app/js/core/rdem.js';
import { readJSON } from './helpers.js';

const REPO = new URL('../../', import.meta.url);
const fixture = await readJSON('tests/fixtures/rdem_expected.json');

/**
 * Minimal RDEM encoder (mirrors pipeline/rdem.py) for synthetic test chunks.
 * @param {number} w
 * @param {number} h
 * @param {Int16Array} q stored values (-32768 = nodata)
 * @param {{water?:Uint8Array, scale?:number, offset?:number, version?:number}} [opts]
 */
function encodeRDEM(w, h, q, { water, scale = 1, offset = 0, version = 1 } = {}) {
  const res = new Int16Array(w * h);
  for (let r = 0; r < h; r++) {
    for (let c = 0; c < w; c++) {
      const i = r * w + c;
      let pred = 0;
      if (r === 0 && c > 0) pred = q[i - 1];
      else if (c === 0 && r > 0) pred = q[i - w];
      else if (r > 0 && c > 0) pred = q[i - 1] + q[i - w] - q[i - w - 1];
      res[i] = q[i] - pred; // Int16Array store wraps like the format
    }
  }
  const elevStream = deflateSync(Buffer.from(res.buffer));
  let maskStream = Buffer.alloc(0);
  if (water) {
    const bits = new Uint8Array(Math.ceil((w * h) / 8));
    water.forEach((v, i) => { if (v) bits[i >> 3] |= 0x80 >> (i & 7); });
    maskStream = deflateSync(bits);
  }
  let mn = Infinity;
  let mx = -Infinity;
  for (const v of q) if (v !== -32768) { mn = Math.min(mn, v * scale + offset); mx = Math.max(mx, v * scale + offset); }
  const header = new DataView(new ArrayBuffer(36));
  'RDEM'.split('').forEach((ch, i) => header.setUint8(i, ch.charCodeAt(0)));
  header.setUint8(4, version);
  header.setUint8(5, water ? 1 : 0);
  header.setUint16(8, w, true);
  header.setUint16(10, h, true);
  header.setFloat32(12, scale, true);
  header.setFloat32(16, offset, true);
  header.setUint32(20, elevStream.length, true);
  header.setUint32(24, maskStream.length, true);
  header.setFloat32(28, mn, true);
  header.setFloat32(32, mx, true);
  return Buffer.concat([Buffer.from(header.buffer), elevStream, maskStream]);
}

for (const c of fixture.cases) {
  test(`decodes ${c.path} exactly like the Python reference decoder`, async () => {
    const buf = await readFile(new URL(c.path, REPO));
    const chunk = await decodeRDEM(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength));
    assert.equal(chunk.width, c.width);
    assert.equal(chunk.height, c.height);
    assert.equal(chunk.min, c.min);
    assert.equal(chunk.max, c.max);
    assert.ok(chunk.elev instanceof Float32Array);
    assert.equal(chunk.elev.length, c.width * c.height);
    for (const s of c.samples) {
      const i = s.row * c.width + s.col;
      assert.equal(chunk.elev[i], s.elev, `elev at (${s.row}, ${s.col})`);
      assert.equal(chunk.water?.[i] === 1, s.water, `water at (${s.row}, ${s.col})`);
    }
    assert.equal(chunk.water !== null, c.hasWater);
    let sum = 0;
    let lo = Infinity;
    let hi = -Infinity;
    for (const e of chunk.elev) {
      if (Number.isNaN(e)) continue;
      sum += e;
      lo = Math.min(lo, e);
      hi = Math.max(hi, e);
    }
    assert.ok(Math.abs(sum - c.sum) <= 1e-3 * Math.abs(c.sum), `sum ${sum} vs ${c.sum}`);
    assert.equal(lo, c.min);
    assert.equal(hi, c.max);
    if (c.hasWater) {
      assert.ok(chunk.water instanceof Uint8Array);
      let count = 0;
      for (const w of chunk.water) count += w;
      assert.equal(count, c.waterCount);
    }
  });
}

test('accepts typed-array views as input', async () => {
  const c = fixture.cases[1];
  const buf = await readFile(new URL(c.path, REPO));
  const chunk = await decodeRDEM(buf); // a Node Buffer is a Uint8Array view into a pool
  assert.equal(chunk.width, c.width);
  assert.equal(chunk.elev[c.samples[3].row * c.width + c.samples[3].col], c.samples[3].elev);
});

test('round-trips synthetic data: nodata, int16 wrap-around, scale/offset and odd mask sizes', async () => {
  const w = 13;
  const h = 7;
  const q = new Int16Array(w * h);
  const water = new Uint8Array(w * h);
  for (let i = 0; i < q.length; i++) {
    q[i] = ((i * 7919) % 65536) - 32767; // large jumps force residual wrap-around
    water[i] = i % 3 === 0 ? 1 : 0;
  }
  q[0] = -32768;
  q[20] = -32768;
  q[w * h - 1] = -32768;
  const buf = encodeRDEM(w, h, q, { water, scale: 0.5, offset: 100 });
  const chunk = await decodeRDEM(buf);
  assert.equal(chunk.width, w);
  assert.equal(chunk.height, h);
  for (let i = 0; i < q.length; i++) {
    if (q[i] === -32768) assert.ok(Number.isNaN(chunk.elev[i]), `nodata at ${i}`);
    else assert.equal(chunk.elev[i], Math.fround(q[i] * 0.5 + 100), `value at ${i}`);
  }
  assert.deepEqual(Array.from(chunk.water), Array.from(water));
});

test('chunks without a water mask decode with water = null', async () => {
  const q = Int16Array.from({ length: 12 }, (_, i) => 1000 + i * 3);
  const chunk = await decodeRDEM(encodeRDEM(4, 3, q));
  assert.equal(chunk.water, null);
  assert.deepEqual(Array.from(chunk.elev), Array.from(q));
  assert.equal(chunk.min, 1000);
  assert.equal(chunk.max, 1033);
});

test('rejects malformed input', async () => {
  const good = encodeRDEM(2, 2, Int16Array.from([1, 2, 3, 4]));
  const badMagic = Buffer.from(good);
  badMagic[0] = 0x58;
  await assert.rejects(decodeRDEM(badMagic), /magic/);
  await assert.rejects(decodeRDEM(encodeRDEM(2, 2, Int16Array.from([1, 2, 3, 4]), { version: 2 })), /version/);
  await assert.rejects(decodeRDEM(good.subarray(0, 20)), /truncated/);
  await assert.rejects(decodeRDEM(good.subarray(0, good.length - 3)), /truncated/);
});

test('decodes a 900×750 chunk well under 50 ms', async () => {
  const buf = await readFile(new URL(fixture.cases[0].path, REPO));
  await decodeRDEM(buf); // warm-up (JIT)
  await decodeRDEM(buf);
  // best of several runs: robust against other test files running in parallel
  let best = Infinity;
  for (let k = 0; k < 9; k++) {
    const t0 = performance.now();
    await decodeRDEM(buf);
    best = Math.min(best, performance.now() - t0);
  }
  assert.ok(best < 50, `decode time ${best.toFixed(1)} ms`);
});
