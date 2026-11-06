// Node.js-only loader. Reads the bundled data file from disk (no network).
import { readFile } from 'node:fs/promises';
import { prepareEvacData } from './evac.js';

export const DEFAULT_DATA_URL = new URL('./data/shizuoka_evac.json', import.meta.url);

export async function loadEvacData(path = DEFAULT_DATA_URL) {
  return prepareEvacData(JSON.parse(await readFile(path, 'utf8')));
}

export * from './index.js';
