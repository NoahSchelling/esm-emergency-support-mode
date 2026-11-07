// Browser-only loader. Fetches the bundled coast data from the same site.
// Only the data file is requested; the position never leaves the device.
import { prepareCoastData } from '../alert.js';

export const DEFAULT_COAST_URL = new URL('../data/coast.json', import.meta.url);

export async function loadCoastData(url = DEFAULT_COAST_URL) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`coast data could not be loaded (HTTP ${res.status})`);
  return prepareCoastData(await res.json());
}

export * from '../alert.js';
