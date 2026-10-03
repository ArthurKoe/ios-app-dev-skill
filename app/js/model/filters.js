// Raster filters on row-major Float32 grids (row 0 = top/north edge). DOM-free.

/**
 * Normalised 1-D Gaussian kernel with radius ceil(3σ).
 * @param {number} sigma standard deviation in samples (> 0)
 * @returns {Float32Array} weights for the offsets -R … +R (length 2R+1)
 */
export function gaussianKernel(sigma) {
  const radius = Math.max(0, Math.ceil(3 * sigma));
  const kernel = new Float32Array(2 * radius + 1);
  const twoSigma2 = 2 * sigma * sigma;
  let sum = 0;
  for (let i = -radius; i <= radius; i++) {
    const w = Math.exp(-(i * i) / twoSigma2);
    kernel[i + radius] = w;
    sum += w;
  }
  for (let i = 0; i < kernel.length; i++) kernel[i] /= sum;
  return kernel;
}

/**
 * Separable Gaussian blur with clamped (replicated) edges.
 * Horizontal pass over a padded row buffer, vertical pass accumulating whole rows so all inner
 * loops run over contiguous memory; symmetric taps are paired (≈ 0.5 s for 4000 × 2500 samples
 * at σ = 1 in Node 22).
 * @param {Float32Array} z input grid (not modified)
 * @param {number} nx columns
 * @param {number} ny rows
 * @param {number} sigma standard deviation in samples; ≤ 0 returns a copy
 * @returns {Float32Array} new blurred grid
 */
export function gaussianBlur(z, nx, ny, sigma) {
  const n = nx * ny;
  if (!(sigma > 0) || n === 0) return new Float32Array(z);
  const kernel = gaussianKernel(sigma);
  const radius = (kernel.length - 1) >> 1;
  const centre = kernel[radius];

  // Horizontal pass over a row padded with its edge values (symmetric kernel: pair the taps).
  const tmp = new Float32Array(n);
  const padded = new Float32Array(nx + 2 * radius);
  for (let r = 0; r < ny; r++) {
    const o = r * nx;
    const first = z[o];
    const last = z[o + nx - 1];
    for (let i = 0; i < radius; i++) {
      padded[i] = first;
      padded[radius + nx + i] = last;
    }
    for (let c = 0; c < nx; c++) padded[radius + c] = z[o + c];
    for (let c = 0; c < nx; c++) {
      const m = c + radius;
      let s = centre * padded[m];
      for (let j = 1; j <= radius; j++) s += kernel[radius + j] * (padded[m - j] + padded[m + j]);
      tmp[o + c] = s;
    }
  }

  // Vertical pass: out row r = Σ_j w_j · (tmp row clamp(r - j) + tmp row clamp(r + j)).
  const out = new Float32Array(n);
  const lastRow = ny - 1;
  for (let r = 0; r < ny; r++) {
    const o = r * nx;
    for (let c = 0; c < nx; c++) out[o + c] = centre * tmp[o + c];
    for (let j = 1; j <= radius; j++) {
      const w = kernel[radius + j];
      const a = (r - j > 0 ? r - j : 0) * nx;
      const b = (r + j < lastRow ? r + j : lastRow) * nx;
      for (let c = 0; c < nx; c++) out[o + c] += w * (tmp[a + c] + tmp[b + c]);
    }
  }
  return out;
}

/**
 * Lambertian hillshade from central differences (one-sided at the edges).
 * Columns run east, rows run south (row 0 = north edge). Units of `elev`, `dxM` and `dyM` just
 * need to agree (metres for terrain, millimetres for a printed surface).
 * @param {Float32Array} elev heights
 * @param {number} nx columns
 * @param {number} ny rows
 * @param {number} dxM sample spacing along x
 * @param {number} dyM sample spacing along y
 * @param {number} [azimuthDeg=315] direction the light comes from, clockwise from north/up
 * @param {number} [altitudeDeg=45] light elevation above the horizon
 * @returns {Float32Array} illumination 0 (shadow) … 1 (facing the light)
 */
export function hillshade(elev, nx, ny, dxM, dyM, azimuthDeg = 315, altitudeDeg = 45) {
  const az = (azimuthDeg * Math.PI) / 180;
  const alt = (altitudeDeg * Math.PI) / 180;
  const lx = Math.sin(az) * Math.cos(alt);
  const ly = Math.cos(az) * Math.cos(alt);
  const lz = Math.sin(alt);
  const out = new Float32Array(nx * ny);
  forEachGradient(elev, nx, ny, dxM, dyM, (i, gx, gy) => {
    const d = (lz - gx * lx - gy * ly) / Math.sqrt(gx * gx + gy * gy + 1);
    out[i] = d > 0 ? (d < 1 ? d : 1) : 0;
  });
  return out;
}

/**
 * Magnitude of the gradient |∇z| (central differences, one-sided at the edges).
 * @param {Float32Array} z heights
 * @param {number} nx columns
 * @param {number} ny rows
 * @param {number} dx sample spacing along x
 * @param {number} dy sample spacing along y
 * @returns {Float32Array} slope in z-units per spacing-unit
 */
export function gradientMagnitude(z, nx, ny, dx, dy) {
  const out = new Float32Array(nx * ny);
  forEachGradient(z, nx, ny, dx, dy, (i, gx, gy) => {
    out[i] = Math.sqrt(gx * gx + gy * gy);
  });
  return out;
}

/**
 * Calls fn(index, dz/dx (east), dz/dy (north)) for every sample.
 * @param {Float32Array} z
 * @param {number} nx
 * @param {number} ny
 * @param {number} dx
 * @param {number} dy
 * @param {(i:number, gx:number, gy:number)=>void} fn
 */
function forEachGradient(z, nx, ny, dx, dy, fn) {
  for (let r = 0; r < ny; r++) {
    const rn = r > 0 ? r - 1 : 0;
    const rs = r < ny - 1 ? r + 1 : ny - 1;
    const invY = rs > rn ? 1 / ((rs - rn) * dy) : 0;
    const on = rn * nx;
    const os = rs * nx;
    const o = r * nx;
    for (let c = 0; c < nx; c++) {
      const cw = c > 0 ? c - 1 : 0;
      const ce = c < nx - 1 ? c + 1 : nx - 1;
      const invX = ce > cw ? 1 / ((ce - cw) * dx) : 0;
      fn(o + c, (z[o + ce] - z[o + cw]) * invX, (z[on + c] - z[os + c]) * invY);
    }
  }
}
