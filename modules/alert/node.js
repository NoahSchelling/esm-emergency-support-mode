// Node.js-only loader. Reads the bundled coast data from disk (no network).
import { readFile } from 'node:fs/promises';
import { prepareCoastData } from './alert.js';

export const DEFAULT_COAST_URL = new URL('./data/coast.json', import.meta.url);

export async function loadCoastData(path = DEFAULT_COAST_URL) {
  return prepareCoastData(JSON.parse(await readFile(path, 'utf8')));
}

export * from './alert.js';
