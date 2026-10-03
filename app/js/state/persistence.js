// Project persistence: localStorage autosave, JSON files and the shareable `#p=` URL hash.
// DOM-free (storage and location are injectable), so it runs in Node tests.

import { deflateSync, inflateSync, strFromU8, strToU8 } from '../../vendor/fflate/fflate.js';
import { createDefaultProject } from './project.js';
import { normalizeProject } from './store.js';

/** localStorage key of the autosaved project. */
export const STORAGE_KEY = 'relief-studio.project.v1';
const HASH_PREFIX = '#p=';

/**
 * Serialises a project to pretty-printed JSON (for "Save project").
 * @param {object} project
 * @returns {string}
 */
export function projectToJSON(project) {
  return JSON.stringify(project, null, 2);
}

/**
 * Parses and normalises a project from JSON text.
 * @param {string} text
 * @param {{warnings?:string[]}} [ctx]
 * @returns {object} normalised project
 * @throws {Error} when the text is not a Relief Studio project
 */
export function projectFromJSON(text, ctx = {}) {
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    throw new Error('This file is not valid JSON.');
  }
  if (!data || typeof data !== 'object' || Array.isArray(data) || !('frame' in data) || !('layout' in data)) {
    throw new Error('This file does not look like a Relief Studio project.');
  }
  if (typeof data.version === 'number' && data.version > 1) {
    throw new Error(`Project version ${data.version} is newer than this app supports.`);
  }
  return normalizeProject(data, ctx);
}

/**
 * Encodes a project as a URL hash: `#p=` + base64url(deflate(JSON)).
 * @param {object} project
 * @returns {string}
 */
export function projectToHash(project) {
  return HASH_PREFIX + bytesToBase64Url(deflateSync(strToU8(JSON.stringify(project)), { level: 9 }));
}

/**
 * Decodes a `#p=` hash (with or without the leading '#'). Returns null when the hash holds
 * no project or cannot be decoded.
 * @param {string} hash
 * @param {{warnings?:string[]}} [ctx]
 * @returns {object|null}
 */
export function projectFromHash(hash, ctx = {}) {
  const value = String(hash ?? '').replace(/^#/, '');
  if (!value.startsWith('p=')) return null;
  try {
    const json = strFromU8(inflateSync(base64UrlToBytes(value.slice(2))));
    return projectFromJSON(json, ctx);
  } catch {
    return null;
  }
}

/**
 * Writes the project to storage. Never throws (quota / private mode / disabled storage).
 * @param {object} project
 * @param {Storage} [storage]
 * @returns {boolean} true when saved
 */
export function saveLocal(project, storage = defaultStorage()) {
  try {
    if (!storage) return false;
    storage.setItem(STORAGE_KEY, JSON.stringify(project));
    return true;
  } catch {
    return false;
  }
}

/**
 * Reads the autosaved project, or null.
 * @param {Storage} [storage]
 * @returns {object|null}
 */
export function loadLocal(storage = defaultStorage()) {
  try {
    const text = storage?.getItem(STORAGE_KEY);
    return text ? projectFromJSON(text) : null;
  } catch {
    return null;
  }
}

/**
 * Removes the autosaved project. Never throws.
 * @param {Storage} [storage]
 */
export function clearLocal(storage = defaultStorage()) {
  try {
    storage?.removeItem(STORAGE_KEY);
  } catch {
    // storage unavailable – nothing to clear
  }
}

/**
 * Initial project, in priority order: URL hash > localStorage > defaults.
 * @param {{hash?:string, storage?:Storage}} [opts]
 * @returns {{project:object, origin:'hash'|'storage'|'default', warnings:string[]}}
 */
export function loadInitialProject({ hash = globalThis.location?.hash ?? '', storage = defaultStorage() } = {}) {
  const warnings = [];
  const fromHash = projectFromHash(hash, { warnings });
  if (fromHash) return { project: fromHash, origin: 'hash', warnings };
  if (String(hash).startsWith(HASH_PREFIX)) warnings.push('The shared link could not be read; your last project was opened instead.');
  const fromStorage = loadLocal(storage);
  if (fromStorage) return { project: fromStorage, origin: 'storage', warnings };
  return { project: normalizeProject(createDefaultProject()), origin: 'default', warnings };
}

/**
 * Debounced autosave of every store change into storage.
 * @param {{get:()=>object, subscribe:(fn:Function)=>()=>void}} store
 * @param {{delayMs?:number, storage?:Storage, onError?:()=>void}} [opts]
 * @returns {{flush:()=>void, dispose:()=>void}}
 */
export function createAutosave(store, { delayMs = 800, storage = defaultStorage(), onError } = {}) {
  let timer = null;
  let failedOnce = false;
  const flush = () => {
    if (timer !== null) clearTimeout(timer);
    timer = null;
    if (!saveLocal(store.get(), storage) && !failedOnce) {
      failedOnce = true;
      onError?.();
    }
  };
  const unsubscribe = store.subscribe((project, prev, info) => {
    if (!info.changes.any) return;
    if (timer !== null) clearTimeout(timer);
    timer = setTimeout(flush, delayMs);
  });
  return {
    flush,
    dispose() {
      if (timer !== null) clearTimeout(timer);
      timer = null;
      unsubscribe();
    },
  };
}

/**
 * base64url (RFC 4648 §5, no padding) of bytes.
 * @param {Uint8Array} bytes
 * @returns {string}
 */
export function bytesToBase64Url(bytes) {
  let binary = '';
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode.apply(null, bytes.subarray(i, i + CHUNK));
  }
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/**
 * Inverse of bytesToBase64Url.
 * @param {string} text
 * @returns {Uint8Array}
 */
export function base64UrlToBytes(text) {
  const b64 = text.replace(/-/g, '+').replace(/_/g, '/');
  const binary = atob(b64 + '='.repeat((4 - (b64.length % 4)) % 4));
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
  return out;
}

function defaultStorage() {
  try {
    return globalThis.localStorage ?? null;
  } catch {
    return null;
  }
}
