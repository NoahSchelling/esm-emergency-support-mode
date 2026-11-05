// Node.js-only loader. Reads the bundled data file from disk (no network).
import { readFile } from 'node:fs/promises';
import { prepareAreaData } from './area.js';

export const DEFAULT_DATA_URL = new URL('./data/shizuoka.json', import.meta.url);

export async function loadAreaData(path = DEFAULT_DATA_URL) {
  const text = await readFile(path, 'utf8');
  return prepareAreaData(JSON.parse(text));
}

export * from './area.js';
