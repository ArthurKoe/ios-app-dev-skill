// Shared helpers for Node unit tests.
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

export const ROOT = fileURLToPath(new URL('../../', import.meta.url));
export const DATA_URL = new URL('../../data/', import.meta.url);

/**
 * fetch() replacement that serves file:// URLs (and paths relative to the repo root)
 * so DEM modules can be tested without a web server.
 */
export async function fileFetch(input) {
  const url = input instanceof URL ? input : new URL(String(input), new URL('../../', import.meta.url));
  try {
    const buf = await readFile(fileURLToPath(url));
    return new Response(buf, { status: 200 });
  } catch {
    return new Response('not found', { status: 404 });
  }
}

export async function readJSON(relPath) {
  return JSON.parse(await readFile(new URL(relPath, new URL('../../', import.meta.url)), 'utf8'));
}
