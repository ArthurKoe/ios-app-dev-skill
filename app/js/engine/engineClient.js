// Main-thread client of the engine worker (engine.worker.js). Promise-based, latest wins.

/**
 * @typedef {{regionsIndex:object, dataBaseUrl:string}} EngineContext
 * @typedef {{stage:string, fraction:number, message:string}} EngineProgress
 */

/** Error used to reject superseded or cancelled requests. */
export class EngineAbortError extends Error {
  constructor(message = 'Cancelled') {
    super(message);
    this.name = 'AbortError';
  }
}

/**
 * Talks to the engine worker. A new preview (or export) request supersedes the previous one of
 * the same kind: its promise rejects with an AbortError (check with `isAbortError`).
 */
export class EngineClient {
  /**
   * @param {string|URL} workerUrl URL of engine.worker.js
   */
  constructor(workerUrl) {
    this._worker = new Worker(workerUrl, { type: 'module', name: 'relief-engine' });
    this._nextId = 1;
    /** @type {Map<number, {type:string, resolve:Function, reject:Function, onProgress?:Function, onFile?:Function}>} */
    this._pending = new Map();
    this._worker.onmessage = (e) => this._handle(e.data);
    this._worker.onerror = (e) => {
      e.preventDefault?.();
      this._failAll(new Error(e.message ? `Engine crashed: ${e.message}` : 'The engine worker failed to start.'));
    };
    this._worker.onmessageerror = () => this._failAll(new Error('The engine sent an unreadable message.'));
  }

  /**
   * Computes the preview (tile meshes, bands, estimate, stats, layout, zmap).
   * @param {object} project
   * @param {EngineContext} ctx
   * @param {(p:EngineProgress)=>void} [onProgress]
   * @returns {Promise<object>}
   */
  preview(project, ctx, onProgress) {
    return this._request('preview', project, ctx, {}, { onProgress });
  }

  /**
   * Re-resolves colour bands and estimates for the last preview (fast; colour / print changes).
   * @param {object} project
   * @param {EngineContext} ctx
   * @returns {Promise<{bands:object[], estimate:object}>}
   */
  estimate(project, ctx) {
    return this._request('estimate', project, ctx, {}, {});
  }

  /**
   * Exports tiles at full resolution; each finished tile file is passed to `onFile`.
   * @param {object} project
   * @param {EngineContext} ctx
   * @param {{format?:'stl'|'3mf', tiles?:string[]|null, prefix?:string}} opts
   * @param {(file:{name:string, buffer:ArrayBuffer, label:string, index:number, total:number, triangles:number})=>void} onFile
   * @param {(p:EngineProgress)=>void} [onProgress]
   * @returns {Promise<object>} final result with files, estimate, bands, stats, layout, zmap
   */
  exportTiles(project, ctx, opts, onFile, onProgress) {
    return this._request('export', project, ctx, opts ?? {}, { onFile, onProgress });
  }

  /**
   * Cancels running requests (all, or only those of one type).
   * @param {'preview'|'estimate'|'export'} [type]
   */
  cancel(type) {
    for (const [id, job] of this._pending) {
      if (type && job.type !== type) continue;
      this._worker.postMessage({ id: this._nextId++, type: 'cancel', options: { jobId: id } });
      this._pending.delete(id);
      job.reject(new EngineAbortError());
    }
  }

  /** Terminates the worker; pending requests reject. */
  dispose() {
    this._failAll(new EngineAbortError('Engine disposed'));
    this._worker.terminate();
  }

  _request(type, project, ctx, options, handlers) {
    if (type === 'preview' || type === 'export') this.cancel(type);
    const id = this._nextId++;
    return new Promise((resolve, reject) => {
      this._pending.set(id, { type, resolve, reject, ...handlers });
      this._worker.postMessage({
        id, type, project,
        regionsIndex: ctx?.regionsIndex ?? null,
        // Relative data URLs are meant relative to the page, not to the worker script.
        dataBaseUrl: new URL(ctx?.dataBaseUrl ?? './data/', globalThis.document?.baseURI ?? globalThis.location.href).href,
        options,
      });
    });
  }

  _handle(msg) {
    const job = this._pending.get(msg?.id);
    if (!job) return; // cancelled or superseded
    switch (msg.type) {
      case 'progress':
        job.onProgress?.({ stage: msg.stage, fraction: msg.fraction, message: msg.message });
        break;
      case 'file':
        job.onFile?.(msg);
        break;
      case 'result':
        this._pending.delete(msg.id);
        job.resolve(msg.result);
        break;
      case 'error':
        this._pending.delete(msg.id);
        job.reject(msg.name === 'AbortError' ? new EngineAbortError(msg.message) : engineError(msg));
        break;
      default:
        break;
    }
  }

  _failAll(error) {
    const jobs = [...this._pending.values()];
    this._pending.clear();
    for (const job of jobs) job.reject(error);
  }
}

/**
 * Rebuilds a worker error on the main thread (keeps the original name and the worker's stack).
 * @param {{name?:string, message:string, stack?:string}} msg
 * @returns {Error}
 */
function engineError(msg) {
  const err = new Error(msg.message);
  if (msg.name && msg.name !== 'Error') err.name = msg.name;
  if (msg.stack) err.stack = msg.stack;
  return err;
}

/**
 * True for errors caused by cancellation / supersession (not worth showing to the user).
 * @param {unknown} err
 * @returns {boolean}
 */
export function isAbortError(err) {
  return Boolean(err) && /** @type {any} */ (err).name === 'AbortError';
}
