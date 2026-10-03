// Decoder for RDEM elevation chunks (version 1), see docs/DATA_FORMAT.md.
// DOM-free: uses DecompressionStream('deflate'), available in browsers, workers and Node >= 18.

const MAGIC = 0x4d454452; // "RDEM" read as little-endian uint32
const VERSION = 1;
const HEADER_BYTES = 36;
const NODATA = -32768;
const LITTLE_ENDIAN = new Uint8Array(new Uint16Array([1]).buffer)[0] === 1;

/**
 * @typedef {{width:number, height:number, elev:Float32Array, water:Uint8Array|null, min:number, max:number}} RDEMChunk
 *   elev: metres, row-major, NaN = nodata; water: 1 = lake/sea (null when the chunk has no mask)
 */

/**
 * Inflates a zlib (RFC 1950) stream.
 * @param {Uint8Array} bytes
 * @returns {Promise<ArrayBuffer>}
 */
async function inflateZlib(bytes) {
  const ds = new DecompressionStream('deflate');
  const writer = ds.writable.getWriter();
  // Errors surface through reader.read(); the writer side only needs to be drained.
  const written = writer.write(bytes).then(() => writer.close()).catch(() => {});
  const reader = ds.readable.getReader();
  const parts = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    parts.push(value);
    total += value.byteLength;
  }
  await written;
  if (parts.length === 1 && parts[0].byteOffset === 0 && parts[0].byteLength === parts[0].buffer.byteLength) {
    return parts[0].buffer;
  }
  const out = new Uint8Array(total);
  let o = 0;
  for (const p of parts) { out.set(p, o); o += p.byteLength; }
  return out.buffer;
}

/**
 * Reverses the 2-D gradient predictor and converts the stored int16 values to metres.
 * Uses d(r,c) = v(r,c) - v(r-1,c) = residual(r,c) + d(r,c-1); every value is wrapped to
 * int16 (the format's arithmetic) by the `<< 16 >> 16` pair and kept in `v` for the next row.
 * @param {Int16Array} v residuals on input, stored values on output
 * @param {number} w
 * @param {number} h
 * @param {number} scale metres per stored unit
 * @param {number} offset metres
 * @returns {Float32Array} metres, NaN = nodata
 */
function reconstruct(v, w, h, scale, offset) {
  const elev = new Float32Array(w * h);
  let acc = 0;
  for (let c = 0; c < w; c++) {
    acc = (acc + v[c]) | 0;
    const q = (acc << 16) >> 16;
    v[c] = q;
    elev[c] = q === NODATA ? NaN : q * scale + offset;
  }
  for (let r = 1; r < h; r++) {
    let d = 0;
    for (let i = r * w, end = i + w; i < end; i++) {
      d = (d + v[i]) | 0;
      const q = ((v[i - w] + d) << 16) >> 16;
      v[i] = q;
      elev[i] = q === NODATA ? NaN : q * scale + offset;
    }
  }
  return elev;
}

/**
 * Unpacks an MSB-first bit mask into one byte (0/1) per pixel.
 * @param {Uint8Array} bits
 * @param {number} count number of pixels
 * @returns {Uint8Array}
 */
function unpackBits(bits, count) {
  const out = new Uint8Array(count);
  const fullBytes = count >> 3;
  for (let b = 0, o = 0; b < fullBytes; b++, o += 8) {
    const x = bits[b];
    if (x === 0) continue;
    out[o] = x >> 7;
    out[o + 1] = (x >> 6) & 1;
    out[o + 2] = (x >> 5) & 1;
    out[o + 3] = (x >> 4) & 1;
    out[o + 4] = (x >> 3) & 1;
    out[o + 5] = (x >> 2) & 1;
    out[o + 6] = (x >> 1) & 1;
    out[o + 7] = x & 1;
  }
  for (let i = fullBytes << 3; i < count; i++) out[i] = (bits[i >> 3] >> (7 - (i & 7))) & 1;
  return out;
}

/**
 * Decodes one RDEM chunk.
 * @param {ArrayBuffer|ArrayBufferView} arrayBuffer
 * @returns {Promise<RDEMChunk>}
 */
export async function decodeRDEM(arrayBuffer) {
  const bytes = ArrayBuffer.isView(arrayBuffer)
    ? new Uint8Array(arrayBuffer.buffer, arrayBuffer.byteOffset, arrayBuffer.byteLength)
    : new Uint8Array(arrayBuffer);
  if (bytes.byteLength < HEADER_BYTES) throw new Error('RDEM: truncated header');
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (dv.getUint32(0, true) !== MAGIC) throw new Error('RDEM: bad magic');
  const version = dv.getUint8(4);
  if (version !== VERSION) throw new Error(`RDEM: unsupported version ${version}`);
  const flags = dv.getUint8(5);
  const width = dv.getUint16(8, true);
  const height = dv.getUint16(10, true);
  const scale = dv.getFloat32(12, true);
  const offset = dv.getFloat32(16, true);
  const elevLen = dv.getUint32(20, true);
  const maskLen = dv.getUint32(24, true);
  const min = dv.getFloat32(28, true);
  const max = dv.getFloat32(32, true);
  if (HEADER_BYTES + elevLen + maskLen > bytes.byteLength) throw new Error('RDEM: truncated data');

  const hasMask = (flags & 1) !== 0 && maskLen > 0;
  const [elevBuf, maskBuf] = await Promise.all([
    inflateZlib(bytes.subarray(HEADER_BYTES, HEADER_BYTES + elevLen)),
    hasMask ? inflateZlib(bytes.subarray(HEADER_BYTES + elevLen, HEADER_BYTES + elevLen + maskLen)) : null,
  ]);

  const n = width * height;
  if (elevBuf.byteLength !== n * 2) throw new Error('RDEM: elevation stream has the wrong size');
  if (!LITTLE_ENDIAN) {
    const b = new Uint8Array(elevBuf);
    for (let i = 0; i < b.length; i += 2) { const t = b[i]; b[i] = b[i + 1]; b[i + 1] = t; }
  }
  const elev = reconstruct(new Int16Array(elevBuf), width, height, scale, offset);

  let water = null;
  if (maskBuf) {
    const bits = new Uint8Array(maskBuf);
    if (bits.length < Math.ceil(n / 8)) throw new Error('RDEM: water mask stream is too short');
    water = unpackBits(bits, n);
  }
  return { width, height, elev, water, min, max };
}
