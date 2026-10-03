// Binary STL writer and reader.
//
// Layout: 80-byte header, uint32 triangle count, then per triangle 50 bytes: normal (3 × float32),
// three vertices (9 × float32), uint16 attribute byte count (0). All little endian.

const HEADER_BYTES = 80;
const RECORD_BYTES = 50;

/**
 * Serialises an indexed triangle mesh as binary STL.
 *
 * The header holds `Relief Studio STL: <name>` (ASCII, space padded). It never starts with
 * "solid", which some readers take as the signature of an ASCII STL. Facet normals are computed
 * from the vertices (unit length; zero for zero-area triangles).
 *
 * @param {import('../types.js').Mesh} mesh
 * @param {string} [name='relief']
 * @returns {ArrayBuffer}
 */
export function writeBinarySTL(mesh, name = 'relief') {
  const { positions: p, indices: idx } = mesh;
  const count = idx.length / 3;
  if (!Number.isInteger(count)) throw new RangeError('index count is not a multiple of 3');
  const buffer = new ArrayBuffer(HEADER_BYTES + 4 + count * RECORD_BYTES);
  const bytes = new Uint8Array(buffer);
  bytes.set(headerBytes(name));
  const view = new DataView(buffer);
  view.setUint32(HEADER_BYTES, count, true);

  let o = HEADER_BYTES + 4;
  for (let i = 0; i < idx.length; i += 3, o += RECORD_BYTES) {
    const a = idx[i] * 3;
    const b = idx[i + 1] * 3;
    const c = idx[i + 2] * 3;
    const ax = p[a], ay = p[a + 1], az = p[a + 2];
    const bx = p[b], by = p[b + 1], bz = p[b + 2];
    const cx = p[c], cy = p[c + 1], cz = p[c + 2];
    const ux = bx - ax, uy = by - ay, uz = bz - az;
    const vx = cx - ax, vy = cy - ay, vz = cz - az;
    let nx = uy * vz - uz * vy;
    let ny = uz * vx - ux * vz;
    let nz = ux * vy - uy * vx;
    const len = Math.sqrt(nx * nx + ny * ny + nz * nz);
    if (len > 0) {
      nx /= len;
      ny /= len;
      nz /= len;
    }
    view.setFloat32(o, nx, true);
    view.setFloat32(o + 4, ny, true);
    view.setFloat32(o + 8, nz, true);
    view.setFloat32(o + 12, ax, true);
    view.setFloat32(o + 16, ay, true);
    view.setFloat32(o + 20, az, true);
    view.setFloat32(o + 24, bx, true);
    view.setFloat32(o + 28, by, true);
    view.setFloat32(o + 32, bz, true);
    view.setFloat32(o + 36, cx, true);
    view.setFloat32(o + 40, cy, true);
    view.setFloat32(o + 44, cz, true);
    // attribute byte count stays 0
  }
  return buffer;
}

/**
 * Parses a binary STL into an indexed mesh. Corners with bit-identical coordinates are merged into
 * one vertex (+0 and -0 count as equal), so a mesh written by writeBinarySTL round-trips to the
 * same topology. Stored facet normals are ignored.
 *
 * @param {ArrayBuffer|ArrayBufferView} buffer
 * @returns {import('../types.js').Mesh & {header: string}} header = the 80 header bytes as text
 *   (trailing spaces / NULs removed)
 */
export function parseBinarySTL(buffer) {
  const bytes = ArrayBuffer.isView(buffer)
    ? new Uint8Array(buffer.buffer, buffer.byteOffset, buffer.byteLength)
    : new Uint8Array(buffer);
  if (bytes.byteLength < HEADER_BYTES + 4) throw new RangeError('not a binary STL: file too short');
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const count = view.getUint32(HEADER_BYTES, true);
  const expected = HEADER_BYTES + 4 + count * RECORD_BYTES;
  if (bytes.byteLength < expected) {
    throw new RangeError(`not a binary STL: ${count} triangles need ${expected} bytes, got ${bytes.byteLength}`);
  }

  const corners = count * 3;
  const raw = new Float32Array(corners * 3);
  for (let t = 0, o = HEADER_BYTES + 4 + 12, k = 0; t < count; t++, o += RECORD_BYTES) {
    for (let j = 0; j < 36; j += 4) raw[k++] = view.getFloat32(o + j, true) + 0; // + 0 turns -0 into +0
  }
  const { positions, indices } = mergeCorners(raw, corners);
  const header = String.fromCharCode(...bytes.subarray(0, HEADER_BYTES)).replace(/[\0 ]+$/, '');
  return { positions, indices, header };
}

/**
 * @param {string} name
 * @returns {Uint8Array} 80 bytes
 */
function headerBytes(name) {
  const text = `Relief Studio STL: ${name}`.replace(/[^\x20-\x7e]/g, '?').slice(0, HEADER_BYTES);
  const out = new Uint8Array(HEADER_BYTES).fill(0x20);
  for (let i = 0; i < text.length; i++) out[i] = text.charCodeAt(i);
  return out;
}

/**
 * Deduplicates corner positions with an open-addressing hash table on the float bit patterns.
 * @param {Float32Array} raw xyz per corner
 * @param {number} corners
 * @returns {{positions: Float32Array, indices: Uint32Array}}
 */
function mergeCorners(raw, corners) {
  const bits = new Uint32Array(raw.buffer, raw.byteOffset, raw.length);
  let cap = 16;
  while (cap < corners * 2) cap *= 2;
  const mask = cap - 1;
  const table = new Int32Array(cap).fill(-1);
  const unique = new Uint32Array(corners * 3); // bit patterns of the unique vertices
  const indices = new Uint32Array(corners);
  let nv = 0;
  for (let c = 0; c < corners; c++) {
    const x = bits[c * 3];
    const y = bits[c * 3 + 1];
    const z = bits[c * 3 + 2];
    let h = (Math.imul(x, 0x9e3779b1) ^ Math.imul(y, 0x85ebca77) ^ Math.imul(z, 0xc2b2ae3d)) >>> 0;
    h = (h ^ (h >>> 15)) & mask;
    for (;;) {
      const v = table[h];
      if (v === -1) {
        table[h] = nv;
        unique[nv * 3] = x;
        unique[nv * 3 + 1] = y;
        unique[nv * 3 + 2] = z;
        indices[c] = nv++;
        break;
      }
      if (unique[v * 3] === x && unique[v * 3 + 1] === y && unique[v * 3 + 2] === z) {
        indices[c] = v;
        break;
      }
      h = (h + 1) & mask;
    }
  }
  const positions = new Float32Array(unique.buffer.slice(0, nv * 3 * 4));
  return { positions, indices };
}
