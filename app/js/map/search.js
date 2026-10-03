// Place search through the OpenStreetMap Nominatim API (https://nominatim.org/release-docs/latest/api/Search/).
// DOM-free: needs only fetch and AbortController, so it also runs in Node and in workers.

/** Nominatim search endpoint. */
export const NOMINATIM_SEARCH_URL = 'https://nominatim.openstreetmap.org/search';

/**
 * @typedef {{
 *   name: string,                              // full display name ("Matterhorn, Zermatt, …")
 *   title: string,                             // short name ("Matterhorn")
 *   type: string,                              // OSM type ("peak", "city", …; "coordinates" for typed coordinates)
 *   lat: number, lon: number,
 *   bbox: [number, number, number, number]     // [south, west, north, east] in degrees
 * }} Place
 */

/** Error raised for failed searches; `code` is 'timeout' | 'network' | 'http' | 'parse'. */
export class PlaceSearchError extends Error {
  /**
   * @param {string} message user-facing message
   * @param {'timeout'|'network'|'http'|'parse'} code
   * @param {{cause?: unknown, status?: number}} [details]
   */
  constructor(message, code, { cause, status } = {}) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = 'PlaceSearchError';
    this.code = code;
    if (status !== undefined) this.status = status;
  }
}

const COORDINATE_PAIR = /^\s*([-+]?\d{1,2}(?:\.\d+)?)\s*[,;\s]\s*([-+]?\d{1,3}(?:\.\d+)?)\s*$/;
/** Half size (degrees) of the box returned for typed coordinates. */
const COORDINATE_BOX_DEG = 0.05;

/**
 * Recognises a typed "lat, lon" pair (decimal degrees) so it can be used without a network request.
 * @param {string} query
 * @returns {Place|null}
 */
export function parseCoordinates(query) {
  const m = COORDINATE_PAIR.exec(query);
  if (!m) return null;
  const lat = Number(m[1]);
  const lon = Number(m[2]);
  if (Math.abs(lat) > 90 || Math.abs(lon) > 180) return null;
  const name = `${lat.toFixed(5)}, ${lon.toFixed(5)}`;
  const d = COORDINATE_BOX_DEG;
  return {
    name, title: name, type: 'coordinates', lat, lon,
    bbox: [Math.max(-90, lat - d), lon - d, Math.min(90, lat + d), lon + d],
  };
}

/**
 * Converts one Nominatim jsonv2 result into a {@link Place}; null when it has no usable position.
 * Nominatim's `boundingbox` is [south, north, west, east] (as strings).
 * @param {any} result
 * @returns {Place|null}
 */
export function toPlace(result) {
  const lat = Number(result?.lat);
  const lon = Number(result?.lon);
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null;
  const bb = Array.isArray(result.boundingbox) ? result.boundingbox.map(Number) : [];
  const bbox = bb.length === 4 && bb.every(Number.isFinite)
    ? /** @type {[number, number, number, number]} */ ([bb[0], bb[2], bb[1], bb[3]])
    : /** @type {[number, number, number, number]} */ ([lat - 0.01, lon - 0.01, lat + 0.01, lon + 0.01]);
  const name = String(result.display_name || result.name || `${lat}, ${lon}`);
  const title = String(result.name || name.split(',')[0]).trim() || name;
  return { name, title, type: String(result.type || result.category || 'place'), lat, lon, bbox };
}

/**
 * Searches places by name. Typed coordinates ("46.55, 7.98") are answered locally.
 *
 * Resolves to an empty array for an empty query or no matches. Rejects with a
 * {@link PlaceSearchError} on timeout, network failure, HTTP error or an unreadable response,
 * and with the caller's abort reason (an AbortError) when `options.signal` aborts.
 *
 * @param {string} query
 * @param {object} [options]
 * @param {AbortSignal} [options.signal] cancels the request
 * @param {number} [options.timeoutMs=8000]
 * @param {number} [options.limit=6] maximum number of results
 * @param {string} [options.language] preferred result language (defaults to navigator.language)
 * @param {typeof fetch} [options.fetchImpl=globalThis.fetch]
 * @returns {Promise<Place[]>}
 */
export async function searchPlaces(query, {
  signal, timeoutMs = 8000, limit = 6, language = globalThis.navigator?.language,
  fetchImpl = globalThis.fetch,
} = {}) {
  const q = String(query ?? '').trim();
  if (!q) return [];
  const coordinates = parseCoordinates(q);
  if (coordinates) return [coordinates];
  signal?.throwIfAborted();

  const params = new URLSearchParams({ format: 'jsonv2', limit: String(limit), q });
  if (language) params.set('accept-language', language);
  const url = `${NOMINATIM_SEARCH_URL}?${params}`;

  const controller = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, timeoutMs);
  const forwardAbort = () => controller.abort(signal.reason);
  signal?.addEventListener('abort', forwardAbort, { once: true });

  /** Maps any failure while talking to the server onto a PlaceSearchError (or the caller's abort). */
  const fail = (/** @type {unknown} */ err, /** @type {'network'|'parse'} */ code) => {
    if (signal?.aborted) return signal.reason ?? err;
    if (timedOut) {
      return new PlaceSearchError('Place search timed out – please try again.', 'timeout', { cause: err });
    }
    return code === 'network'
      ? new PlaceSearchError('Place search is unavailable (network error).', 'network', { cause: err })
      : new PlaceSearchError('Place search returned an unreadable response.', 'parse', { cause: err });
  };

  try {
    let response;
    try {
      response = await fetchImpl(url, { signal: controller.signal, headers: { Accept: 'application/json' } });
    } catch (err) {
      throw fail(err, 'network');
    }
    if (!response.ok) {
      const message = response.status === 429
        ? 'Too many place searches – please wait a moment.'
        : `Place search failed (HTTP ${response.status}).`;
      throw new PlaceSearchError(message, 'http', { status: response.status });
    }
    let data;
    try {
      data = await response.json();
    } catch (err) {
      throw fail(err, 'parse');
    }
    if (!Array.isArray(data)) throw fail(new TypeError('Expected a JSON array'), 'parse');
    return data.map(toPlace).filter((p) => p !== null);
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', forwardAbort);
  }
}
