// Loads the modules with dynamic import. A module that fails to load (or is
// skipped with ?without=) is reported as not loaded, so the rest of the
// screen keeps working. Works in browsers and Node.js: the caller passes the
// importer, so paths are resolved relative to app/main.js.

export const MODULE_PATHS = Object.freeze({
  sensors: '../modules/sensors/index.js',
  area: '../modules/area/browser/load.js',
  mode: '../modules/mode/index.js',
  fragment: '../modules/fragment/index.js',
  advice: '../modules/advice/index.js',
});

/**
 * Names listed in the "without" query parameter, e.g. "?without=area,fragment".
 * Unknown names are ignored.
 * @param {string} search location.search
 */
export function parseWithout(search) {
  const raw = new URLSearchParams(search ?? '').get('without');
  if (!raw) return [];
  return raw
    .split(',')
    .map((s) => s.trim())
    .filter((s) => Object.hasOwn(MODULE_PATHS, s));
}

/**
 * @param {object} opts
 * @param {(path: string) => Promise<object>} opts.importer
 * @param {string[]} [opts.without] module names not to load
 * @returns {Promise<Record<string, {loaded: boolean, module: object|null, reason: string|null, path: string}>>}
 */
export async function loadModules({ importer, without = [] }) {
  const skip = new Set(without);
  const entries = await Promise.all(
    Object.entries(MODULE_PATHS).map(async ([name, path]) => {
      if (skip.has(name)) return [name, { loaded: false, module: null, reason: 'skipped', path }];
      try {
        const module = await importer(path);
        return [name, { loaded: true, module, reason: null, path }];
      } catch (e) {
        return [name, { loaded: false, module: null, reason: String(e?.message ?? e), path }];
      }
    }),
  );
  return Object.fromEntries(entries);
}
