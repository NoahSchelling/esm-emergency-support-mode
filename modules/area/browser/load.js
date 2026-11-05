// Browser-only loader. Fetches the bundled data file from the same site as
// this module. Only the data file is requested; the position never leaves
// the device (the lookup itself runs in ../area.js).
import { prepareAreaData } from '../area.js';

export const DEFAULT_DATA_URL = new URL('../data/shizuoka.json', import.meta.url);

export async function loadAreaData(url = DEFAULT_DATA_URL) {
  // fetch() sends cookies only to the same origin by default.
  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(`area data could not be loaded (HTTP ${res.status})`);
  }
  return prepareAreaData(await res.json());
}

export * from '../area.js';
