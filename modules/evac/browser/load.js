// Browser-only loader. Fetches the bundled data file from the same site as
// this module. Only the data file is requested; the position never leaves
// the device (the calculation runs in ../evac.js).
import { prepareEvacData } from '../evac.js';

export const DEFAULT_DATA_URL = new URL('../data/shizuoka_evac.json', import.meta.url);

export async function loadEvacData(url = DEFAULT_DATA_URL) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`evacuation data could not be loaded (HTTP ${res.status})`);
  return prepareEvacData(await res.json());
}

export * from '../index.js';
export * from './orientation.js';
