// Streaming zip writer (fflate Zip + ZipDeflate) producing a Blob, plus a download helper.

import { Zip, ZipDeflate, strToU8 } from '../../vendor/fflate/fflate.js';

/** Bytes compressed per step before yielding to the event loop (keeps the UI responsive). */
const SLICE_BYTES = 512 * 1024;

/**
 * Creates a streaming zip writer. Files are deflated (level 6) in slices with a yield between
 * slices, so large STL files never block the UI thread for long.
 * @param {{level?:number, mimeType?:string}} [opts]
 * @returns {{add:(name:string, data:Uint8Array|ArrayBuffer|string)=>Promise<void>,
 *            finish:()=>Promise<Blob>, readonly fileCount:number}}
 */
export function createZipWriter({ level = 6, mimeType = 'application/zip' } = {}) {
  const chunks = [];
  let fileCount = 0;
  let finished = false;
  let fail;
  let succeed;
  const done = new Promise((resolve, reject) => { succeed = resolve; fail = reject; });
  done.catch(() => {}); // surfaced via add()/finish()
  let error = null;
  const zip = new Zip((err, data, final) => {
    if (err) {
      error = err;
      fail(err);
      return;
    }
    chunks.push(data);
    if (final) succeed(new Blob(chunks, { type: mimeType }));
  });
  let queue = Promise.resolve();

  return {
    get fileCount() { return fileCount; },
    add(name, data) {
      if (finished) return Promise.reject(new Error('Zip already finished'));
      const bytes = toBytes(data);
      fileCount++;
      queue = queue.then(async () => {
        if (error) throw error;
        const file = new ZipDeflate(name, { level });
        zip.add(file);
        if (bytes.length === 0) {
          file.push(bytes, true);
          return;
        }
        for (let offset = 0; offset < bytes.length; offset += SLICE_BYTES) {
          const end = Math.min(bytes.length, offset + SLICE_BYTES);
          file.push(bytes.subarray(offset, end), end === bytes.length);
          if (error) throw error;
          if (end < bytes.length) await yieldToEventLoop();
        }
      });
      return queue;
    },
    async finish() {
      finished = true;
      await queue;
      zip.end();
      return done;
    },
  };
}

/**
 * Zips a list of files into a Blob.
 * @param {{name:string, data:Uint8Array|ArrayBuffer|string}[]} files
 * @param {{level?:number}} [opts]
 * @returns {Promise<Blob>}
 */
export async function zipFiles(files, opts) {
  const writer = createZipWriter(opts);
  for (const f of files) await writer.add(f.name, f.data);
  return writer.finish();
}

/**
 * Triggers a browser download of a Blob.
 * @param {Blob} blob
 * @param {string} filename
 */
export function downloadBlob(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.rel = 'noopener';
  a.style.display = 'none';
  document.body.append(a);
  a.click();
  a.remove();
  // Revoke later: some browsers read the URL asynchronously after click().
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
}

function toBytes(data) {
  if (typeof data === 'string') return strToU8(data);
  if (data instanceof Uint8Array) return data;
  if (data instanceof ArrayBuffer) return new Uint8Array(data);
  if (ArrayBuffer.isView(data)) return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
  throw new TypeError('Zip entries must be strings, ArrayBuffers or typed arrays');
}

function yieldToEventLoop() {
  return new Promise((resolve) => setTimeout(resolve, 0));
}
