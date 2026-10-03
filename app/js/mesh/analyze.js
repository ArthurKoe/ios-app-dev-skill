// Mesh statistics and integrity checks (pure, allocation-light, fine for millions of triangles).

/**
 * Basic statistics of an indexed triangle mesh.
 *
 * The volume is the sum of signed tetrahedra (origin, a, b, c) / 6: exact for a closed, outward
 * oriented mesh and negative when the mesh is inside out.
 *
 * @param {import('../types.js').Mesh} mesh
 * @returns {{triangles:number, vertices:number, volumeMm3:number, areaMm2:number,
 *   bbox:{min:number[], max:number[]}}} bbox is all zeros for an empty mesh
 */
export function meshStats(mesh) {
  const { positions: p, indices: idx } = mesh;
  let volume6 = 0;
  let area2 = 0;
  for (let i = 0; i < idx.length; i += 3) {
    const a = idx[i] * 3;
    const b = idx[i + 1] * 3;
    const c = idx[i + 2] * 3;
    const ax = p[a], ay = p[a + 1], az = p[a + 2];
    const bx = p[b], by = p[b + 1], bz = p[b + 2];
    const cx = p[c], cy = p[c + 1], cz = p[c + 2];
    volume6 += ax * (by * cz - bz * cy) + ay * (bz * cx - bx * cz) + az * (bx * cy - by * cx);
    const ux = bx - ax, uy = by - ay, uz = bz - az;
    const vx = cx - ax, vy = cy - ay, vz = cz - az;
    const nx = uy * vz - uz * vy;
    const ny = uz * vx - ux * vz;
    const nz = ux * vy - uy * vx;
    area2 += Math.sqrt(nx * nx + ny * ny + nz * nz);
  }
  const min = [Infinity, Infinity, Infinity];
  const max = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < p.length; i += 3) {
    for (let k = 0; k < 3; k++) {
      const v = p[i + k];
      if (v < min[k]) min[k] = v;
      if (v > max[k]) max[k] = v;
    }
  }
  if (p.length === 0) {
    min.fill(0);
    max.fill(0);
  }
  return {
    triangles: idx.length / 3,
    vertices: p.length / 3,
    volumeMm3: volume6 / 6,
    areaMm2: area2 / 2,
    bbox: { min, max },
  };
}

/**
 * Checks that a mesh is a closed, consistently oriented 2-manifold: every undirected edge is used
 * by exactly two triangles, once in each direction.
 *
 * Counts are per undirected edge: `boundaryEdges` used once, `nonManifoldEdges` used three or more
 * times, `inconsistentEdges` used twice in the same direction (a flipped neighbour).
 * `degenerateTriangles` counts triangles that repeat a vertex index or reference a missing vertex
 * (their edges are skipped).
 *
 * Runs in O(triangles) with a compressed adjacency list (no hash maps).
 *
 * @param {import('../types.js').Mesh} mesh
 * @returns {{ok:boolean, boundaryEdges:number, nonManifoldEdges:number, inconsistentEdges:number,
 *   degenerateTriangles:number}}
 */
export function checkWatertight(mesh) {
  const idx = mesh.indices;
  const nv = mesh.positions.length / 3;
  let degenerateTriangles = 0;

  // Outgoing directed edges per vertex, CSR layout.
  const start = new Uint32Array(nv + 1);
  for (let i = 0; i < idx.length; i += 3) {
    const a = idx[i], b = idx[i + 1], c = idx[i + 2];
    if (a === b || b === c || c === a || a >= nv || b >= nv || c >= nv) {
      degenerateTriangles++;
      continue;
    }
    start[a + 1]++;
    start[b + 1]++;
    start[c + 1]++;
  }
  for (let v = 0; v < nv; v++) start[v + 1] += start[v];
  const fill = start.slice(0, nv);
  const target = new Uint32Array(start[nv]);
  for (let i = 0; i < idx.length; i += 3) {
    const a = idx[i], b = idx[i + 1], c = idx[i + 2];
    if (a === b || b === c || c === a || a >= nv || b >= nv || c >= nv) continue;
    target[fill[a]++] = b;
    target[fill[b]++] = c;
    target[fill[c]++] = a;
  }
  for (let v = 0; v < nv; v++) insertionSort(target, start[v], start[v + 1]);

  let boundaryEdges = 0;
  let nonManifoldEdges = 0;
  let inconsistentEdges = 0;
  for (let a = 0; a < nv; a++) {
    for (let j = start[a], end = start[a + 1]; j < end;) {
      const b = target[j];
      let forward = 0;
      while (j < end && target[j] === b) {
        forward++;
        j++;
      }
      const backward = countTarget(target, start[b], start[b + 1], a);
      // Visit every undirected edge once: from its smaller end, or from the only end that has it.
      if (a > b && backward > 0) continue;
      const uses = forward + backward;
      if (uses === 1) boundaryEdges++;
      else if (uses > 2) nonManifoldEdges++;
      else if (forward !== 1) inconsistentEdges++;
    }
  }
  return {
    ok: boundaryEdges === 0 && nonManifoldEdges === 0 && inconsistentEdges === 0 && degenerateTriangles === 0,
    boundaryEdges,
    nonManifoldEdges,
    inconsistentEdges,
    degenerateTriangles,
  };
}

/**
 * Number of triangles whose area is <= `minAreaMm2` (zero-area slivers break some slicers).
 * @param {import('../types.js').Mesh} mesh
 * @param {number} [minAreaMm2=0]
 * @returns {number}
 */
export function countDegenerateTriangles(mesh, minAreaMm2 = 0) {
  const { positions: p, indices: idx } = mesh;
  const limit = 2 * minAreaMm2;
  let n = 0;
  for (let i = 0; i < idx.length; i += 3) {
    const a = idx[i] * 3, b = idx[i + 1] * 3, c = idx[i + 2] * 3;
    const ux = p[b] - p[a], uy = p[b + 1] - p[a + 1], uz = p[b + 2] - p[a + 2];
    const vx = p[c] - p[a], vy = p[c + 1] - p[a + 1], vz = p[c + 2] - p[a + 2];
    const nx = uy * vz - uz * vy;
    const ny = uz * vx - ux * vz;
    const nz = ux * vy - uy * vx;
    if (Math.sqrt(nx * nx + ny * ny + nz * nz) <= limit) n++;
  }
  return n;
}

/**
 * Number of vertices whose position exactly equals that of an earlier vertex.
 * @param {import('../types.js').Mesh} mesh
 * @returns {number}
 */
export function countDuplicateVertices(mesh) {
  const p = mesh.positions;
  const nv = p.length / 3;
  const order = new Uint32Array(nv);
  for (let i = 0; i < nv; i++) order[i] = i;
  order.sort((i, j) => (p[i * 3] - p[j * 3]) || (p[i * 3 + 1] - p[j * 3 + 1]) || (p[i * 3 + 2] - p[j * 3 + 2]));
  let dup = 0;
  for (let k = 1; k < nv; k++) {
    const a = order[k - 1] * 3;
    const b = order[k] * 3;
    if (p[a] === p[b] && p[a + 1] === p[b + 1] && p[a + 2] === p[b + 2]) dup++;
  }
  return dup;
}

/**
 * Sorts arr[from, to) ascending in place (adjacency lists are short: ~6 entries).
 * @param {Uint32Array} arr
 * @param {number} from
 * @param {number} to
 */
function insertionSort(arr, from, to) {
  for (let i = from + 1; i < to; i++) {
    const v = arr[i];
    let j = i - 1;
    while (j >= from && arr[j] > v) {
      arr[j + 1] = arr[j];
      j--;
    }
    arr[j + 1] = v;
  }
}

/**
 * Occurrences of `value` in the sorted range arr[from, to).
 * @param {Uint32Array} arr
 * @param {number} from
 * @param {number} to
 * @param {number} value
 * @returns {number}
 */
function countTarget(arr, from, to, value) {
  let n = 0;
  for (let j = from; j < to; j++) {
    const t = arr[j];
    if (t === value) n++;
    else if (t > value) break;
  }
  return n;
}
