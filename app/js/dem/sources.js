// Factory for elevation sources. Instances are cached per region / 'live' for the lifetime of the
// realm (the engine worker), so their prepared chunks and the shared LRU cache survive across
// previews.

import { LocalRegionSource } from './localSource.js';
import { TerrariumSource } from './terrariumSource.js';

export { chooseSource } from './sampler.js';

/** @type {Map<string, {fetchImpl:any, promise:Promise<LocalRegionSource|TerrariumSource>}>} */
const instances = new Map();

/**
 * Resolves the data directory against the page/worker location.
 * @param {string|URL} dataBaseUrl
 * @returns {string}
 */
function resolveBase(dataBaseUrl) {
  const raw = String(dataBaseUrl ?? '');
  const withSlash = raw === '' || raw.endsWith('/') ? raw : `${raw}/`;
  try {
    return new URL(withSlash, globalThis.location?.href).href;
  } catch {
    throw new TypeError(`Cannot resolve dataBaseUrl "${raw}" (pass an absolute URL outside the browser)`);
  }
}

/**
 * Returns the (cached) elevation source for a kind.
 * 'local': a {@link LocalRegionSource} for `region` (entry of data/regions.json; its `manifest`
 * path resolves against dataBaseUrl). 'live': the {@link TerrariumSource}.
 * A cached instance is reused when the fetchImpl is the same; failed loads are not cached.
 * @param {'local'|'live'} kind
 * @param {{region?:{id:string, manifest:string}, dataBaseUrl?:string|URL, fetchImpl?:typeof fetch,
 *          urlTemplate?:string, maxZoom?:number}} [opts] urlTemplate/maxZoom configure 'live'
 * @returns {Promise<LocalRegionSource|TerrariumSource>}
 */
export function createSource(kind, { region, dataBaseUrl, fetchImpl, urlTemplate, maxZoom } = {}) {
  let key;
  let make;
  if (kind === 'live') {
    key = `live|${urlTemplate ?? ''}|${maxZoom ?? ''}`;
    make = async () => new TerrariumSource({ fetchImpl, urlTemplate, maxZoom });
  } else if (kind === 'local') {
    if (!region?.manifest) throw new Error('createSource("local") needs a region entry from regions.json');
    const manifestUrl = new URL(region.manifest, resolveBase(dataBaseUrl)).href;
    key = `local|${region.id}|${manifestUrl}`;
    make = () => LocalRegionSource.load(manifestUrl, { fetchImpl });
  } else {
    throw new Error(`Unknown elevation source kind "${kind}"`);
  }
  const hit = instances.get(key);
  if (hit && hit.fetchImpl === fetchImpl) return hit.promise;
  const promise = make();
  instances.set(key, { fetchImpl, promise });
  promise.catch(() => {
    if (instances.get(key)?.promise === promise) instances.delete(key);
  });
  return promise;
}

/** Forgets all cached source instances (decoded chunks stay in the shared chunk cache). */
export function clearSources() {
  instances.clear();
}
