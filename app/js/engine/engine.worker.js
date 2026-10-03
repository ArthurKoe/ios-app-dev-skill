// Engine module worker: runs the pipeline off the UI thread.
//
// In:  {id, type:'preview'|'estimate'|'export'|'cancel', project, regionsIndex, dataBaseUrl, options}
// Out: {id, type:'progress', stage, fraction, message}
//      {id, type:'file', name, buffer, label, index, total, triangles}     (export only, one per tile)
//      {id, type:'result', result}
//      {id, type:'error', message, name, stack}
//
// A new 'preview' supersedes (aborts) the running preview, a new 'export' the running export
// ("latest wins"). 'cancel' aborts options.jobId, or every running job when absent.

import {
  buildTiles, computeArtwork, encodeTileFile, estimateTiles, meshTile,
  previewFromTileFields, sanitizePrefix, tileFileName,
} from './pipeline.js';

/** @type {Map<number, {type:string, controller:AbortController}>} */
const running = new Map();
/** Last preview's tile fields, reused by 'estimate' requests. */
let lastPreview = null;

self.onmessage = (event) => {
  const msg = event.data;
  if (!msg || typeof msg !== 'object') return;
  if (msg.type === 'cancel') {
    cancel(msg.options?.jobId);
    return;
  }
  const handler = HANDLERS[msg.type];
  if (!handler) {
    post({ id: msg.id, type: 'error', message: `Unknown engine request "${msg.type}"`, name: 'TypeError' });
    return;
  }
  if (msg.type === 'preview' || msg.type === 'export') {
    for (const [id, job] of running) if (job.type === msg.type) cancel(id);
  }
  const controller = new AbortController();
  running.set(msg.id, { type: msg.type, controller });
  handler(msg, controller.signal)
    .then((result) => {
      if (!controller.signal.aborted) post({ id: msg.id, type: 'result', result: result.value }, result.transfer);
    })
    .catch((err) => {
      const aborted = controller.signal.aborted || err?.name === 'AbortError';
      // The main thread reports (and logs) failures; the stack travels along for debugging.
      post({
        id: msg.id, type: 'error', name: aborted ? 'AbortError' : err?.name ?? 'Error',
        message: aborted ? 'Cancelled' : errorMessage(err), stack: aborted ? undefined : err?.stack,
      });
    })
    .finally(() => running.delete(msg.id));
};

const HANDLERS = {
  /** Samples, models and meshes the whole artwork at preview resolution. */
  async preview(msg, signal) {
    const { project } = msg;
    const progress = progressReporter(msg.id);
    const artwork = await computeArtwork(project, pipelineOptions(msg, 'preview', signal, progress));
    await yieldToEvents(signal);
    progress({ stage: 'mesh', fraction: 0, message: 'Building tiles…' });
    const tileFields = buildTiles(artwork, project, { quality: 'preview' });
    await yieldToEvents(signal);
    const preview = previewFromTileFields(artwork, project, tileFields);
    signal.throwIfAborted();
    lastPreview = { tileFields, zmap: artwork.zmap };
    return { value: preview, transfer: meshBuffers(preview.tiles) };
  },

  /** Re-resolves bands and estimates on the last preview's tile fields (colour / print changes). */
  async estimate(msg) {
    if (!lastPreview) throw new Error('No preview available yet');
    const { bands, estimate } = estimateTiles(lastPreview.tileFields, msg.project, lastPreview.zmap);
    return { value: { bands, estimate }, transfer: [] };
  },

  /** Builds the export-resolution tiles and streams one STL/3MF file per tile. */
  async export(msg, signal) {
    const { project } = msg;
    const options = msg.options ?? {};
    const format = options.format === '3mf' ? '3mf' : 'stl';
    const prefix = sanitizePrefix(options.prefix || project.name);
    const progress = progressReporter(msg.id);
    const artwork = await computeArtwork(project, pipelineOptions(msg, 'export', signal, progress));
    await yieldToEvents(signal);
    progress({ stage: 'model', fraction: 0.5, message: 'Cutting tiles and back side…' });
    const tileFields = buildTiles(artwork, project, { quality: 'export' });
    const { bands, estimate } = estimateTiles(tileFields, project, artwork.zmap);
    const wanted = Array.isArray(options.tiles) && options.tiles.length ? new Set(options.tiles) : null;
    const indices = tileFields.map((t, i) => i).filter((i) => !wanted || wanted.has(tileFields[i].label));
    const files = [];
    for (let k = 0; k < indices.length; k++) {
      const i = indices[k];
      const tile = tileFields[i];
      progress({ stage: 'mesh', fraction: k / indices.length, message: `Meshing tile ${tile.label} (${k + 1}/${indices.length})…` });
      await yieldToEvents(signal);
      const mesh = meshTile(tile, project, { quality: 'export', toleranceMm: artwork.field.meshToleranceMm });
      const name = tileFileName(prefix, tile.label, format);
      const buffer = encodeTileFile(mesh, { format, name: `${prefix} ${tile.label}`, title: `${project.name} – tile ${tile.label}`, bands, layerHeightMm: project.colors?.layerHeightMm });
      signal.throwIfAborted();
      post({ id: msg.id, type: 'file', name, buffer, label: tile.label, index: k, total: indices.length, triangles: mesh.indices.length / 3 }, [buffer]);
      files.push({ name, label: tile.label, bytes: buffer.byteLength, triangles: mesh.indices.length / 3 });
      tileFields[i] = null; // free the grids early – exports can be large
    }
    progress({ stage: 'mesh', fraction: 1, message: 'Export complete' });
    return {
      value: {
        files, format, prefix, bands, estimate,
        stats: artwork.stats, layout: artwork.layout, zmap: artwork.zmap, resolutionMm: artwork.resolutionMm,
      },
      transfer: [],
    };
  },
};

function pipelineOptions(msg, quality, signal, progress) {
  return {
    regionsIndex: msg.regionsIndex,
    dataBaseUrl: msg.dataBaseUrl,
    quality,
    signal,
    onProgress: progress,
  };
}

function progressReporter(id) {
  let lastSent = 0;
  let lastKey = '';
  return ({ stage, fraction = 0, message = '' }) => {
    const now = Date.now();
    const key = `${stage}|${message}`;
    // Throttle: at most ~20 messages per second unless the stage or message changes.
    if (key === lastKey && now - lastSent < 50 && fraction < 1) return;
    lastSent = now;
    lastKey = key;
    post({ id, type: 'progress', stage, fraction, message });
  };
}

function cancel(jobId) {
  for (const [id, job] of running) {
    if (jobId === undefined || jobId === null || id === jobId) job.controller.abort();
  }
}

function meshBuffers(tiles) {
  const buffers = new Set();
  for (const t of tiles) {
    for (const arr of [t.mesh?.positions, t.mesh?.indices, t.mesh?.water, t.water]) {
      if (arr?.buffer instanceof ArrayBuffer) buffers.add(arr.buffer);
    }
  }
  return [...buffers];
}

/** Lets queued messages (cancel / newer jobs) run, then throws if this job was aborted. */
function yieldToEvents(signal) {
  return new Promise((resolve, reject) => {
    setTimeout(() => (signal.aborted ? reject(signal.reason ?? new DOMException('Cancelled', 'AbortError')) : resolve()), 0);
  });
}

function post(message, transfer = []) {
  self.postMessage(message, transfer);
}

function errorMessage(err) {
  if (!err) return 'Unknown error';
  return typeof err === 'string' ? err : err.message || String(err);
}
