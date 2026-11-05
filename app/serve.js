// Static server for the app (Node.js standard library only).
//
//   node app/serve.js [--port 8080] [--host 127.0.0.1] [--ca http://127.0.0.1:8000]
//
// Serves the repository root so that /app/ can import /modules/. With --ca,
// GET /api/ca/status is forwarded to the C-A server's /api/status, so the
// page can read it from the same origin. Nothing from the page (position,
// typed text, sensor values) is forwarded: the proxy sends a fixed GET with
// no query, no body and no cookies.

import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join, normalize, extname, sep } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
};
// Only these top-level directories are served.
const ALLOWED = new Set(['app', 'modules']);

export function parseArgs(argv) {
  const o = { port: 8080, host: '127.0.0.1', ca: null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--port') o.port = Number(argv[++i]);
    else if (a === '--host') o.host = argv[++i];
    else if (a === '--ca') o.ca = argv[++i];
    else throw new Error(`unknown option: ${a}`);
  }
  return o;
}

export function createAppServer({ ca = null, root = ROOT, fetchImpl = globalThis.fetch } = {}) {
  return createServer(async (req, res) => {
    const headers = { 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' };
    const url = new URL(req.url, 'http://x');
    if (req.method !== 'GET') return res.writeHead(405, headers).end();
    if (url.pathname === '/') {
      return res.writeHead(302, { ...headers, location: '/app/' }).end();
    }
    if (url.pathname === '/api/ca/status') {
      if (!ca) return res.writeHead(404, headers).end('C-A is not configured');
      try {
        const r = await fetchImpl(new URL('/api/status', ca), { redirect: 'error', signal: AbortSignal.timeout(5000) });
        const body = Buffer.from(await r.arrayBuffer());
        return res.writeHead(r.status, { ...headers, 'content-type': 'application/json; charset=utf-8' }).end(body);
      } catch {
        return res.writeHead(502, headers).end('C-A server unreachable');
      }
    }
    let path = normalize(decodeURIComponent(url.pathname)).replace(/^([/\\])+/, '');
    if (path.endsWith(sep) || path === 'app') path = join(path, 'index.html');
    const top = path.split(/[/\\]/)[0];
    if (path.startsWith('..') || !ALLOWED.has(top)) return res.writeHead(404, headers).end();
    try {
      const file = join(root, path);
      if ((await stat(file)).isDirectory()) return res.writeHead(302, { ...headers, location: `/${path}/` }).end();
      const body = await readFile(file);
      return res.writeHead(200, { ...headers, 'content-type': TYPES[extname(path)] ?? 'application/octet-stream' }).end(body);
    } catch {
      return res.writeHead(404, headers).end();
    }
  });
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const o = parseArgs(process.argv.slice(2));
  createAppServer({ ca: o.ca }).listen(o.port, o.host, () => {
    console.log(`app: http://${o.host}:${o.port}/app/${o.ca ? `  (C-A: ${o.ca})` : '  (C-A: none -> simulated data)'}`);
  });
}
