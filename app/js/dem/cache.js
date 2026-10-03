// LRU cache for decoded elevation chunks, bounded by the bytes of their typed arrays, plus the
// small loading helpers (bounded concurrency, one retry) shared by the elevation sources.
// The shared cache lives as long as the worker, so repeated previews never refetch or re-decode.

/** Default capacity of the shared cache: 600 MB of decoded typed arrays. */
export const DEFAULT_CACHE_BYTES = 600e6;

/**
 * Bytes held by a decoded chunk (sum of the byteLength of every typed-array property).
 * @param {object|null} value
 * @returns {number}
 */
export function decodedBytes(value) {
  if (!value) return 0;
  let bytes = 0;
  for (const key of Object.keys(value)) {
    const v = value[key];
    if (ArrayBuffer.isView(v)) bytes += v.byteLength;
  }
  return bytes;
}

/**
 * Least-recently-used cache keyed by string (chunk URL). Concurrent loads of the same key
 * share one in-flight promise. Entries larger than the whole capacity are returned but not kept.
 */
export class ChunkCache {
  /** @param {number} [maxBytes] capacity in bytes */
  constructor(maxBytes = DEFAULT_CACHE_BYTES) {
    this.maxBytes = maxBytes;
    /** @type {Map<string, {value:any, bytes:number}>} insertion order = recency order */
    this._entries = new Map();
    /** @type {Map<string, Promise<any>>} */
    this._pending = new Map();
    this._bytes = 0;
  }

  /** Total bytes currently held. */
  get bytes() { return this._bytes; }

  /** Number of cached entries. */
  get size() { return this._entries.size; }

  /** @param {string} key */
  has(key) { return this._entries.has(key); }

  /**
   * Returns the cached value and marks it as most recently used.
   * @param {string} key
   * @returns {any|undefined}
   */
  get(key) {
    const e = this._entries.get(key);
    if (!e) return undefined;
    this._entries.delete(key);
    this._entries.set(key, e);
    return e.value;
  }

  /**
   * Stores a value, evicting least-recently-used entries until the cache fits its capacity.
   * @param {string} key
   * @param {any} value
   * @param {number} [bytes] defaults to {@link decodedBytes}(value)
   */
  set(key, value, bytes = decodedBytes(value)) {
    this.delete(key);
    if (bytes > this.maxBytes) return;
    this._entries.set(key, { value, bytes });
    this._bytes += bytes;
    this._evict();
  }

  /** @param {string} key */
  delete(key) {
    const e = this._entries.get(key);
    if (!e) return false;
    this._entries.delete(key);
    this._bytes -= e.bytes;
    return true;
  }

  /** Removes every entry (in-flight loads still resolve for their callers). */
  clear() {
    this._entries.clear();
    this._bytes = 0;
  }

  /**
   * Returns the cached value or runs `loader` once per key, caching a non-null result.
   * Concurrent callers for the same key share the in-flight promise; a failed load is not cached.
   * @param {string} key
   * @param {() => Promise<any>} loader
   * @returns {Promise<any>}
   */
  load(key, loader) {
    const hit = this.get(key);
    if (hit !== undefined) return Promise.resolve(hit);
    let p = this._pending.get(key);
    if (!p) {
      p = (async () => {
        try {
          const value = await loader();
          if (value != null) this.set(key, value);
          return value;
        } finally {
          this._pending.delete(key);
        }
      })();
      this._pending.set(key, p);
    }
    return p;
  }

  _evict() {
    for (const [key, e] of this._entries) {
      if (this._bytes <= this.maxBytes) break;
      this._entries.delete(key);
      this._bytes -= e.bytes;
    }
  }
}

/** Cache shared by every elevation source in this realm (page or worker). */
export const sharedChunkCache = new ChunkCache();

/**
 * Runs `fn` over `items` with at most `concurrency` calls in flight. Stops taking new items as
 * soon as one call fails or the signal aborts, and rejects with that error.
 * @template T
 * @param {T[]} items
 * @param {number} concurrency
 * @param {(item:T, index:number) => Promise<void>} fn
 * @param {AbortSignal} [signal]
 * @returns {Promise<void>}
 */
export async function runPool(items, concurrency, fn, signal) {
  let next = 0;
  let failed = false;
  const worker = async () => {
    while (!failed && next < items.length) {
      signal?.throwIfAborted();
      const i = next++;
      try {
        await fn(items[i], i);
      } catch (err) {
        failed = true;
        throw err;
      }
    }
  };
  const n = Math.max(1, Math.min(concurrency, items.length));
  await Promise.all(Array.from({ length: n }, worker));
}

/**
 * Calls `fn`, and once more if it fails for any reason other than `signal` being aborted.
 * @template T
 * @param {() => Promise<T>} fn
 * @param {AbortSignal} [signal]
 * @returns {Promise<T>}
 */
export async function retryOnce(fn, signal) {
  try {
    return await fn();
  } catch {
    signal?.throwIfAborted();
    return fn();
  }
}

/**
 * Fetches a URL as an ArrayBuffer or Blob.
 * @param {(url:string, init?:object) => Promise<Response>} fetchImpl
 * @param {string} url
 * @param {AbortSignal} [signal]
 * @param {'arrayBuffer'|'blob'} [as]
 * @returns {Promise<ArrayBuffer|Blob|null>} null on HTTP 404 (missing chunk/tile)
 */
export async function fetchBody(fetchImpl, url, signal, as = 'arrayBuffer') {
  const res = await fetchImpl(url, signal ? { signal } : undefined);
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
  return as === 'blob' ? res.blob() : res.arrayBuffer();
}
