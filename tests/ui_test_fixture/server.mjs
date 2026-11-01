#!/usr/bin/env node
/**
 * Deterministic, offline, zero-dependency fixture server for the T1 web acceptance suite.
 *
 * It only ever listens on 127.0.0.1 and binds an ephemeral port (0), so it cannot be reached
 * from the network and cannot collide with another test run.
 *
 * Standalone:
 *   node tests/ui_test_fixture/server.mjs
 *   -> prints FIXTURE_URL=http://127.0.0.1:<port>/ and keeps running until SIGINT/SIGTERM.
 *
 * Programmatic:
 *   const { startFixtureServer } = await import('./server.mjs');
 *   const fixture = await startFixtureServer();
 *   fixture.url, fixture.port, fixture.close()
 *
 * Routes (all deterministic, no external network, no clocks in payloads):
 *   GET  /health          -> 200 {"ok":true,"status":"healthy","fixture":"dsh-ui-testing"}
 *   GET  /api/data        -> 200 {"message":"fixture-data-ok","items":[1,2,3],"source":"dsh-ui-testing-fixture"}
 *   GET  /api/error       -> 500 {"error":"fixture-internal-error","status":500}
 *   GET  /api/slow?ms=N   -> 200 after min(N,5000) ms: {"delayed":true,"ms":<effective>}
 *   POST /api/echo        -> 200 {"method":"POST","echo":<parsed body or raw text>}
 *   GET  /missing         -> 404 {"error":"not-found","status":404}
 *   GET  /redirect        -> 302 Location: /second.html?from=redirect#landed (Cache-Control: no-store)
 *   GET  /                -> index.html
 *   GET  /index.html      -> index.html
 *   GET  /second.html     -> second.html
 *   GET  /web-t2.html     -> web-t2.html (T2 structured-input fixture page)
 *   GET  /web-t2-second.html -> web-t2-second.html (T2 second page)
 *   GET  /capture-p0.html -> capture-p0.html (P0 capture pixel-truth page; fixed CSS boxes/colours)
 *   GET  /blank.html      -> blank.html (P0 capture blank-page fixture: pure white body)
 */
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
const HOST = '127.0.0.1';
const MAX_BODY_BYTES = 64 * 1024;
const MAX_DELAY_MS = 5000;

const STATIC_FILES = new Map([
  ['/', 'index.html'],
  ['/index.html', 'index.html'],
  ['/second.html', 'second.html'],
  // T2 (structured input) fixture pages; contract values in tests/ui_test_fixture/README.md.
  ['/web-t2.html', 'web-t2.html'],
  ['/web-t2-second.html', 'web-t2-second.html'],
  // P0 capture fixtures (docs/capture-p0.md; truth table in tests/ui_test_fixture/README.md).
  ['/capture-p0.html', 'capture-p0.html'],
  ['/blank.html', 'blank.html'],
]);

function json(res, status, value) {
  const body = JSON.stringify(value);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(body),
    'cache-control': 'no-store',
    // The fixture is for local acceptance only; keep it out of any shared cache.
    'x-fixture': 'dsh-ui-testing',
  });
  res.end(body);
}

function sendHtml(res, body) {
  res.writeHead(200, {
    'content-type': 'text/html; charset=utf-8',
    'content-length': Buffer.byteLength(body),
    'cache-control': 'no-store',
    'x-fixture': 'dsh-ui-testing',
  });
  res.end(body);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        reject(new Error('fixture request body too large'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

function clampDelay(raw) {
  const value = Number(raw);
  if (!Number.isFinite(value) || value <= 0) return 0;
  return Math.min(Math.round(value), MAX_DELAY_MS);
}

async function serveStatic(res, pathname) {
  const name = STATIC_FILES.get(pathname);
  if (!name) return false;
  const body = await readFile(join(HERE, name), 'utf8');
  sendHtml(res, body);
  return true;
}

export async function startFixtureServer({ host = HOST, port = 0 } = {}) {
  if (host !== HOST) throw new Error(`fixture server must bind to ${HOST} (got ${host})`);
  const server = createServer(async (req, res) => {
    try {
      const url = new URL(req.url || '/', `http://${HOST}`);
      const pathname = url.pathname;
      if (req.method === 'GET' && await serveStatic(res, pathname)) return;

      if (req.method === 'GET' && pathname === '/health') {
        json(res, 200, { ok: true, status: 'healthy', fixture: 'dsh-ui-testing' });
        return;
      }
      if (req.method === 'GET' && pathname === '/api/data') {
        json(res, 200, { message: 'fixture-data-ok', items: [1, 2, 3], source: 'dsh-ui-testing-fixture' });
        return;
      }
      if (req.method === 'GET' && pathname === '/api/error') {
        json(res, 500, { error: 'fixture-internal-error', status: 500 });
        return;
      }
      if (req.method === 'GET' && pathname === '/api/slow') {
        const ms = clampDelay(url.searchParams.get('ms'));
        setTimeout(() => {
          json(res, 200, { delayed: true, ms });
        }, ms);
        return;
      }
      // Fixed-target redirect for address/history acceptance. No free-form `to` parameter:
      // the Location is a constant so the route cannot be turned into an open redirect.
      if (req.method === 'GET' && pathname === '/redirect') {
        res.writeHead(302, {
          location: '/second.html?from=redirect#landed',
          'cache-control': 'no-store',
          'content-length': 0,
          'x-fixture': 'dsh-ui-testing',
        });
        res.end();
        return;
      }
      if (req.method === 'POST' && pathname === '/api/echo') {
        const raw = await readBody(req);
        let echo = raw;
        if (raw.trim()) {
          try { echo = JSON.parse(raw); } catch { /* echo raw text */ }
        }
        json(res, 200, { method: 'POST', echo });
        return;
      }
      if (pathname === '/favicon.ico') {
        res.writeHead(204, { 'cache-control': 'no-store' });
        res.end();
        return;
      }
      json(res, 404, { error: 'not-found', status: 404 });
    } catch (error) {
      if (!res.headersSent) json(res, 500, { error: 'fixture-server-error', message: String(error && error.message || error) });
      else res.end();
    }
  });

  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, () => {
      server.off('error', reject);
      resolve();
    });
  });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('fixture server did not bind a TCP port');
  const url = `http://${HOST}:${address.port}/`;
  let closed = false;
  const close = () => new Promise((resolve) => {
    if (closed) return resolve();
    closed = true;
    server.close(() => resolve());
    // Keep-alive connections from Chrome would otherwise delay close(); the acceptance suite
    // always tears the browser down first, so this is only a safety net.
    setTimeout(() => resolve(), 1000).unref?.();
  });
  return { url, port: address.port, host, close };
}

const isMain = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
if (isMain) {
  const fixture = await startFixtureServer();
  console.log(`FIXTURE_URL=${fixture.url}`);
  console.log('fixture server ready; listening on 127.0.0.1 only. Press Ctrl+C to stop.');
  const stop = async () => {
    await fixture.close();
    process.exit(0);
  };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
}
