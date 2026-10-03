// Spherical transverse Mercator projection and helpers for the rotated map frame.
// DOM-free; see docs/ARCHITECTURE.md ("Coordinate conventions").

/** @typedef {import('../types.js').Frame} Frame */

/** Mean Earth radius in metres (IUGG). */
export const EARTH_RADIUS = 6371008.8;

const D2R = Math.PI / 180;
const R2D = 180 / Math.PI;

/**
 * Wraps a longitude into [-180, 180).
 * @param {number} lon degrees
 * @returns {number}
 */
export function normalizeLon(lon) {
  return lon - 360 * Math.floor((lon + 180) / 360);
}

/**
 * Spherical transverse Mercator, forward.
 * @param {number} lat degrees
 * @param {number} lon degrees
 * @param {number} lat0 latitude of the projection origin (degrees)
 * @param {number} lon0 central meridian (degrees)
 * @returns {[number, number]} [x east, y north] in metres from the origin
 */
export function tmForward(lat, lon, lat0, lon0) {
  const phi = lat * D2R;
  const dl = (lon - lon0) * D2R;
  const cosPhi = Math.cos(phi);
  const B = cosPhi * Math.sin(dl);
  const x = EARTH_RADIUS * Math.atanh(B);
  // atan2(sinφ, cosφ·cosΔλ) == atan2(tanφ, cosΔλ) for |φ| < 90°, but stays finite at the poles.
  const y = EARTH_RADIUS * (Math.atan2(Math.sin(phi), cosPhi * Math.cos(dl)) - lat0 * D2R);
  return [x, y];
}

/**
 * Spherical transverse Mercator, inverse.
 * The returned longitude is continuous around `lon0` (lon0 ± 180°), so it may leave
 * [-180, 180] for frames that cross the antimeridian; use {@link normalizeLon} for lookups.
 * @param {number} x metres east of the origin
 * @param {number} y metres north of the origin
 * @param {number} lat0 degrees
 * @param {number} lon0 degrees
 * @returns {[number, number]} [lat, lon] degrees
 */
export function tmInverse(x, y, lat0, lon0) {
  const k = x / EARTH_RADIUS;
  const D = y / EARTH_RADIUS + lat0 * D2R;
  const lat = Math.asin(Math.sin(D) / Math.cosh(k)) * R2D;
  const lon = lon0 + Math.atan2(Math.sinh(k), Math.cos(D)) * R2D;
  return [lat, lon];
}

/**
 * Converts frame-local metres (before rotation) into lat/lon.
 * @param {Frame} frame
 * @param {number} xm metres to the right of the frame centre
 * @param {number} ym metres up from the frame centre
 * @returns {[number, number]} [lat, lon]
 */
export function frameLocalToLatLon(frame, xm, ym) {
  const t = (frame.rotationDeg || 0) * D2R;
  const c = Math.cos(t);
  const s = Math.sin(t);
  return tmInverse(xm * c + ym * s, -xm * s + ym * c, frame.lat, frame.lon);
}

/**
 * Frame UV (u left→right, v top→bottom, both 0..1) to lat/lon.
 * @param {Frame} frame
 * @param {number} u
 * @param {number} v
 * @returns {[number, number]} [lat, lon]
 */
export function frameUVToLatLon(frame, u, v) {
  return frameLocalToLatLon(frame, (u - 0.5) * frame.widthKm * 1000, (0.5 - v) * frame.heightKm * 1000);
}

/**
 * Lat/lon to frame UV; inverse of {@link frameUVToLatLon}. Values outside 0..1 lie outside the frame.
 * @param {Frame} frame
 * @param {number} lat
 * @param {number} lon
 * @returns {[number, number]} [u, v]
 */
export function latLonToFrameUV(frame, lat, lon) {
  const [x, y] = tmForward(lat, lon, frame.lat, frame.lon);
  const t = (frame.rotationDeg || 0) * D2R;
  const c = Math.cos(t);
  const s = Math.sin(t);
  const xr = x * c - y * s;
  const yr = x * s + y * c;
  return [xr / (frame.widthKm * 1000) + 0.5, 0.5 - yr / (frame.heightKm * 1000)];
}

/**
 * Outline of the frame as a lat/lon ring, clockwise (seen on a north-up map) starting at the
 * top-left corner: top edge, right edge, bottom edge, left edge. The ring is not closed.
 * @param {Frame} frame
 * @param {number} [segmentsPerEdge=16]
 * @returns {Array<[number, number]>} [[lat, lon], ...] with 4 * segmentsPerEdge points
 */
export function framePolygon(frame, segmentsPerEdge = 16) {
  const n = Math.max(1, Math.floor(segmentsPerEdge));
  const ring = [];
  for (let i = 0; i < n; i++) ring.push(frameUVToLatLon(frame, i / n, 0));
  for (let i = 0; i < n; i++) ring.push(frameUVToLatLon(frame, 1, i / n));
  for (let i = 0; i < n; i++) ring.push(frameUVToLatLon(frame, 1 - i / n, 1));
  for (let i = 0; i < n; i++) ring.push(frameUVToLatLon(frame, 0, 1 - i / n));
  return ring;
}

/**
 * Lat/lon bounding box of the frame (densely sampled outline, so curved TM edges are covered).
 * Longitudes are continuous around frame.lon and may exceed ±180 near the antimeridian.
 * @param {Frame} frame
 * @returns {{south:number, west:number, north:number, east:number}}
 */
export function frameBounds(frame) {
  let south = Infinity;
  let north = -Infinity;
  let west = Infinity;
  let east = -Infinity;
  for (const [lat, lon] of framePolygon(frame, 64)) {
    if (lat < south) south = lat;
    if (lat > north) north = lat;
    if (lon < west) west = lon;
    if (lon > east) east = lon;
  }
  return { south, west, north, east };
}

/**
 * Great-circle distance.
 * @param {number} lat1
 * @param {number} lon1
 * @param {number} lat2
 * @param {number} lon2
 * @returns {number} kilometres
 */
export function haversineKm(lat1, lon1, lat2, lon2) {
  const dLat = (lat2 - lat1) * D2R;
  const dLon = (lon2 - lon1) * D2R;
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(lat1 * D2R) * Math.cos(lat2 * D2R) * Math.sin(dLon / 2) ** 2;
  return (2 * EARTH_RADIUS / 1000) * Math.asin(Math.min(1, Math.sqrt(a)));
}
