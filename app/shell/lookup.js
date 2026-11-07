// Browser-only lookups that leave the device:
//   - GSI elevation API (CORS enabled): elevation of a point.
//   - Hazard map portal tiles (CORS enabled): is a point inside the national
//     tsunami inundation estimate? The pixel at the point is read; a coloured
//     pixel = inside, a transparent one = outside, no tile = unknown.
//
// The caller decides what may be sent: the person's position only after the
// consent in ./consent.js; the public coordinates of a designated site
// without it. Results are cached per ~50 m cell so moving a little does not
// send again.

export const ELEVATION_URL = 'https://cyberjapandata2.gsi.go.jp/general/dem/scripts/getelevation.php';
export const TSUNAMI_TILE_URL = 'https://disaportaldata.gsi.go.jp/raster/04_tsunami_newlegend_data';
export const TILE_ZOOM = 16;
const TIMEOUT_MS = 10000;

const cache = new Map();
function cellKey(kind, lat, lon) {
  return `${kind}:${Math.round(lat * 2000)}:${Math.round(lon * 2000)}`;
}

async function withTimeout(url) {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), TIMEOUT_MS);
  try {
    return await fetch(url, { signal: ctl.signal, credentials: 'omit', referrerPolicy: 'no-referrer', cache: 'force-cache' });
  } finally {
    clearTimeout(t);
  }
}

function once(key, run) {
  if (cache.has(key)) return cache.get(key);
  const p = run().catch(() => null);
  cache.set(key, p);
  // A failure may be retried later.
  p.then((v) => { if (v === null || v?.status === 'unavailable') setTimeout(() => cache.delete(key), 60000); });
  return p;
}

// -> { status: 'ok', value_m, source } | { status: 'unavailable' }
export function fetchElevation(lat, lon) {
  return once(cellKey('e', lat, lon), async () => {
    const url = `${ELEVATION_URL}?lon=${lon.toFixed(6)}&lat=${lat.toFixed(6)}&outtype=JSON`;
    const res = await withTimeout(url);
    if (!res.ok) return { status: 'unavailable' };
    const j = await res.json();
    const v = Number(j?.elevation);
    if (!Number.isFinite(v)) return { status: 'unavailable' };
    return { status: 'ok', value_m: v, source: typeof j.hsrc === 'string' ? j.hsrc : '' };
  }).then((r) => r ?? { status: 'unavailable' });
}

export function tileOf(lat, lon, z = TILE_ZOOM) {
  const n = 2 ** z;
  const x = ((lon + 180) / 360) * n;
  const r = (lat * Math.PI) / 180;
  const y = ((1 - Math.log(Math.tan(r) + 1 / Math.cos(r)) / Math.PI) / 2) * n;
  return { z, x: Math.floor(x), y: Math.floor(y), px: Math.floor((x % 1) * 256), py: Math.floor((y % 1) * 256) };
}

// -> true (inside) | false (outside, the tile exists) | null (unknown)
export function inundationAt(lat, lon) {
  return once(cellKey('i', lat, lon), async () => {
    const t = tileOf(lat, lon);
    const res = await withTimeout(`${TSUNAMI_TILE_URL}/${t.z}/${t.x}/${t.y}.png`);
    if (res.status === 404) return { value: null };
    if (!res.ok) return { value: null };
    const bmp = await createImageBitmap(await res.blob());
    const canvas = typeof OffscreenCanvas === 'function' ? new OffscreenCanvas(256, 256) : Object.assign(document.createElement('canvas'), { width: 256, height: 256 });
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    ctx.drawImage(bmp, 0, 0, 256, 256);
    const a = ctx.getImageData(t.px, t.py, 1, 1).data[3];
    return { value: a > 0 };
  }).then((r) => (r && typeof r.value === 'boolean' ? r.value : null));
}
