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
 *   GET  /web-t3.html     -> web-t3.html (T3 static-vision fixture page)
 *   GET  /capture-p0.html -> capture-p0.html (P0 capture pixel-truth page; fixed CSS boxes/colours)
 *   GET  /blank.html      -> blank.html (P0 capture blank-page fixture: pure white body)
 *
 * Network fixture (/n/*, truth table in tests/ui_test_fixture/README.md §NET; only 127.0.0.1,
 * every response carries `cache-control: no-store` + `x-fixture: dsh-ui-testing`):
 *   GET      /n/json              -> 200 {"message":"net-fixture-ok","items":[1,2,3],"query":{...}}
 *   POST|PUT /n/echo              -> 200 {"method","kind","parsed","headers","bytes"}
 *   GET      /n/status/404        -> 404 {"error":"net-not-found","status":404}
 *   GET      /n/status/500        -> 500 {"error":"net-server-error","status":500}
 *   GET      /n/slow?ms=N         -> 200 after min(N,5000) ms: {"delayed":true,"ms":<effective>}
 *   GET      /n/redirect/1        -> 302 /n/redirect/2 -> 302 /n/final -> 200 {"landed":true}
 *   GET      /n/final             -> 200 {"landed":true}
 *   GET      /n/gzip              -> 200 content-encoding: gzip, {"gzip":true,"message":"net-gzip-ok"}
 *   GET      /n/chunked           -> 200 transfer-encoding: chunked, "chunk-1\nchunk-2\nchunk-3\n" in 3 chunks
 *   GET      /n/large?bytes=N     -> 200 {"pad":"x"*clamp(N ?? 20000, 0, 1000000)}
 *   GET      /n/sse               -> 200 text/event-stream, 3 fixed events (10/30/60 ms) then close
 *   GET      /n/ws (upgrade)      -> 101, echoes text frames, pushes "server-push-1" 10 ms after open
 *   GET      /n/poll?n=N          -> 200 {"poll":clamp(N ?? 1, 1, 100)}
 *   GET      /n/flaky?key=K       -> 503 on the first request per key, 200 afterwards; &reset=1 clears
 *   GET      /n/token?token=T     -> 200 {"token":"T","length":<n>} (redaction assertions)
 *   GET|OPT  /n/cors              -> 200/204 with Access-Control-Allow-* (preflight included)
 *   GET      /n/worker.js         -> Worker script (self.fetch('/n/worker-data'))
 *   GET      /n/shared-worker.js  -> SharedWorker script (one fetch per connection)
 *   GET      /n/sw.js             -> ServiceWorker script (scope "/", NO fetch handler, postMessage only)
 *   GET      /n/worker-data       -> 200 {"from":"worker-data","ok":true}
 *   GET      /n/iframe.html       -> same document as /web-network-frame.html
 *   GET      /n/iframe-data       -> 200 {"from":"iframe-data","ok":true}
 *   GET      /web-network.html    -> web-network.html (network fixture page, window.__net ledger)
 *   GET      /web-network-frame.html -> web-network-frame.html (iframe target, window.__netFrame)
 *   GET      /web-network-oopif.html -> web-network-oopif.html (cross-site iframe probe, window.__net.oopif)
 *
 * Shop business chain (/shop/* pages + /api/shop/* API; truth table in README.md §SHOP). Five real
 * MPA pages, full-page navigation, frozen runId=chain-1 and orderId ORD-chain-1-1. Every API
 * response carries `code:0`, `cache-control: no-store`, `x-correlation-id` + `x-shop-trace`
 * (both `trace-shop-chain-1`) and a unique `x-request-id: shop-req-<n>`.
 *   GET  /shop/products.html      -> products list page (auto GET /api/shop/products)
 *   GET  /shop/product.html       -> product detail page (auto GET /api/shop/products/sku-1)
 *   GET  /shop/order.html         -> order page (auto GET /api/shop/orders?orderId=…)
 *   GET  /shop/checkout.html      -> checkout page (auto POST /api/shop/checkout + 3× status polls)
 *   GET  /shop/orders.html        -> my-orders page (auto GET /api/shop/orders/list)
 *   GET  /shop/shop-ledger.js     -> shared window.__shop ledger script
 *   GET  /api/shop/products[?runId=chain-1]        -> 3 deterministic products
 *   GET  /api/shop/products/:id                    -> one product (sku-1 has stock 10)
 *   POST /api/shop/orders                          -> idempotent per runId: ORD-<runId>-1
 *   GET  /api/shop/orders?orderId=…                -> current order (created -> paid after checkout)
 *   POST /api/shop/checkout                        -> {orderId, status:"paid", paidAt:<fixed>}
 *   GET  /api/shop/orders/status?orderId=…         -> {orderId, status}
 *   GET  /api/shop/orders/list?runId=chain-1       -> [{orderId, status, total}]
 *   GET  /api/shop/reset?runId=chain-1             -> fixture-only state reset
 */
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { createHash } from 'node:crypto';
import { gzipSync } from 'node:zlib';

const HERE = dirname(fileURLToPath(import.meta.url));
const HOST = '127.0.0.1';
const MAX_BODY_BYTES = 64 * 1024;
const MAX_DELAY_MS = 5000;
// Network fixture (/n/*) limits: every knob is clamped so a probe can never ask for an
// unbounded payload or an unbounded delay.
const MAX_LARGE_BYTES = 1000 * 1000;
const DEFAULT_LARGE_BYTES = 20000;
const MAX_POLL_N = 100;
const MAX_WS_PAYLOAD = 64 * 1024;
// Fake, deterministic credential values. They exist only so acceptance can assert that the
// runtime redacts URL tokens / sensitive headers; they grant nothing.
export const NET_FAKE_TOKEN = 'SECRET_netfixture01';
export const NET_FAKE_AUTH = 'Bearer SECRET_netfixture02';

// Shop business-chain fixture (/api/shop/*): deterministic catalog, fixed paidAt, fixed trace id.
export const SHOP_TRACE = 'trace-shop-chain-1';
export const SHOP_PAID_AT = '2026-11-01T00:00:00.000Z';
const SHOP_PRODUCTS = [
  { id: 'sku-1', name: 'Widget A', price: 1999, stock: 10 },
  { id: 'sku-2', name: 'Widget B', price: 2999, stock: 5 },
  { id: 'sku-3', name: 'Widget C', price: 3999, stock: 2 },
];

const STATIC_FILES = new Map([
  ['/', 'index.html'],
  ['/index.html', 'index.html'],
  ['/second.html', 'second.html'],
  // T2 (structured input) fixture pages; contract values in tests/ui_test_fixture/README.md.
  ['/web-t2.html', 'web-t2.html'],
  ['/web-t2-second.html', 'web-t2-second.html'],
  // T3 (static vision) deterministic target; truth table in tests/ui_test_fixture/README.md.
  ['/web-t3.html', 'web-t3.html'],
  // P0 capture fixtures (docs/capture-p0.md; truth table in tests/ui_test_fixture/README.md).
  ['/capture-p0.html', 'capture-p0.html'],
  ['/blank.html', 'blank.html'],
  // Network fixture (/n/*): truth table in tests/ui_test_fixture/README.md §NET.
  ['/web-network.html', 'web-network.html'],
  ['/web-network-frame.html', 'web-network-frame.html'],
  // The iframe target is also reachable under /n/ so probes can load it directly; the bytes are
  // the same document as /web-network-frame.html (single source of truth).
  ['/n/iframe.html', 'web-network-frame.html'],
  // OOPIF probe page: main document on 127.0.0.1, iframe on http://localhost:<port> (cross-site).
  ['/web-network-oopif.html', 'web-network-oopif.html'],
  // Shop business-chain fixture (/shop/*, truth table in tests/ui_test_fixture/README.md §SHOP):
  // five real MPA pages, full-page navigation, fake runId=chain-1.
  ['/shop/products.html', 'shop-products.html'],
  ['/shop/product.html', 'shop-product.html'],
  ['/shop/order.html', 'shop-order.html'],
  ['/shop/checkout.html', 'shop-checkout.html'],
  ['/shop/orders.html', 'shop-orders.html'],
]);

function json(res, status, value, extraHeaders) {
  const body = JSON.stringify(value);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(body),
    'cache-control': 'no-store',
    // The fixture is for local acceptance only; keep it out of any shared cache.
    'x-fixture': 'dsh-ui-testing',
    ...(extraHeaders || {}),
  });
  res.end(body);
}

/* ------------------------------------------------------------------------------------------------
 * Network fixture (/n/*) helpers. Truth table: tests/ui_test_fixture/README.md §NET.
 * Everything here is dependency-free and deterministic: no clocks in payloads, no randomness.
 * ---------------------------------------------------------------------------------------------- */

// Headers echoed back by /n/echo. Every key is always present; a missing header is `null` so a
// probe can assert absence deterministically (instead of "key missing" ambiguity).
const ECHO_HEADERS = ['content-type', 'content-length', 'x-net-probe', 'x-net-token', 'authorization'];

/** All query params as a plain object, in URL order; a repeated key becomes an array of strings. */
function queryObject(searchParams) {
  const out = {};
  for (const [key, value] of searchParams) {
    if (!Object.prototype.hasOwnProperty.call(out, key)) out[key] = value;
    else if (Array.isArray(out[key])) out[key].push(value);
    else out[key] = [out[key], value];
  }
  return out;
}

/** Integer clamp with a default for missing/invalid input. */
function clampInt(raw, fallback, min, max) {
  const value = Number(raw);
  if (raw === null || raw === undefined || raw === '' || !Number.isFinite(value)) return fallback;
  return Math.min(Math.max(Math.round(value), min), max);
}

function echoHeader(req, name) {
  const value = req.headers[name];
  if (value === undefined) return null;
  return Array.isArray(value) ? value.join(', ') : value;
}

function echoHeaders(req) {
  const out = {};
  for (const name of ECHO_HEADERS) out[name] = echoHeader(req, name);
  return out;
}

/** urlencoded body -> object; a repeated field becomes an array of strings. */
function parseUrlEncoded(raw) {
  const out = {};
  for (const [key, value] of new URLSearchParams(raw)) {
    if (!Object.prototype.hasOwnProperty.call(out, key)) out[key] = value;
    else if (Array.isArray(out[key])) out[key].push(value);
    else out[key] = [out[key], value];
  }
  return out;
}

/** multipart/form-data body -> field object; file parts become {filename, type, size}. */
function parseMultipart(raw, boundary) {
  const out = {};
  const separator = `--${boundary}`;
  const parts = raw.split(separator).slice(1);
  for (const chunk of parts) {
    if (chunk.startsWith('--')) break; // closing delimiter
    const part = chunk.replace(/^\r\n/, '').replace(/\r\n$/, '');
    const split = part.indexOf('\r\n\r\n');
    if (split < 0) continue;
    const headerText = part.slice(0, split);
    const value = part.slice(split + 4);
    const nameMatch = /;\s*name="([^"]*)"/i.exec(headerText) || /name="([^"]*)"/i.exec(headerText);
    if (!nameMatch) continue;
    const name = nameMatch[1];
    const filenameMatch = /;\s*filename="([^"]*)"/i.exec(headerText);
    const typeMatch = /content-type:\s*(.+)/i.exec(headerText);
    if (filenameMatch) {
      out[name] = {
        filename: filenameMatch[1],
        type: typeMatch ? typeMatch[1].trim() : null,
        size: Buffer.byteLength(value, 'utf8'),
      };
      continue;
    }
    if (!Object.prototype.hasOwnProperty.call(out, name)) out[name] = value;
    else if (Array.isArray(out[name])) out[name].push(value);
    else out[name] = [out[name], value];
  }
  return out;
}

/** Classify + parse an echo body by its declared content-type (never throws). */
function parseEchoBody(raw, contentType) {
  const text = raw.toString('utf8');
  if (!text.trim()) return { kind: 'empty', parsed: null };
  const type = (contentType || '').toLowerCase();
  if (type.includes('application/json')) {
    try {
      return { kind: 'json', parsed: JSON.parse(text) };
    } catch {
      return { kind: 'text', parsed: text };
    }
  }
  if (type.includes('application/x-www-form-urlencoded')) return { kind: 'urlencoded', parsed: parseUrlEncoded(text) };
  const boundaryMatch = /boundary=(?:"([^"]+)"|([^;]+))/i.exec(contentType || '');
  if (type.includes('multipart/form-data') && boundaryMatch) {
    return { kind: 'multipart', parsed: parseMultipart(text, boundaryMatch[1] || boundaryMatch[2].trim()) };
  }
  if (type.includes('multipart/form-data')) return { kind: 'text', parsed: text };
  // No / unknown content-type: try JSON, else raw text (deterministic, documented).
  try {
    const parsed = JSON.parse(text);
    if (parsed && typeof parsed === 'object') return { kind: 'json', parsed };
  } catch { /* raw text */ }
  return { kind: 'text', parsed: text };
}

function netHeaders(extraHeaders) {
  return { 'cache-control': 'no-store', 'x-fixture': 'dsh-ui-testing', ...(extraHeaders || {}) };
}

function redirect(res, location) {
  res.writeHead(302, netHeaders({ location, 'content-length': 0 }));
  res.end();
}

/* ---------------------------------- WebSocket (zero dependency) --------------------------------- */

const WS_GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';

function wsEncodeFrame(opcode, payload) {
  const data = Buffer.isBuffer(payload) ? payload : Buffer.from(String(payload), 'utf8');
  const length = data.length;
  let header;
  if (length < 126) {
    header = Buffer.alloc(2);
    header[1] = length;
  } else if (length < 65536) {
    header = Buffer.alloc(4);
    header[1] = 126;
    header.writeUInt16BE(length, 2);
  } else {
    header = Buffer.alloc(10);
    header[1] = 127;
    header.writeBigUInt64BE(BigInt(length), 2);
  }
  header[0] = 0x80 | opcode; // FIN + opcode (server frames are never masked)
  return Buffer.concat([header, data]);
}

function wsEncodeText(text) {
  return wsEncodeFrame(0x1, text);
}

function wsCloseFrame(code) {
  const payload = Buffer.alloc(2);
  payload.writeUInt16BE(code, 0);
  return wsEncodeFrame(0x8, payload);
}

/** Decode as many complete client frames as possible. Supports text/close/ping/pong + fragments. */
function wsDecodeFrames(buffer) {
  const frames = [];
  let offset = 0;
  while (buffer.length - offset >= 2) {
    const b0 = buffer[offset];
    const b1 = buffer[offset + 1];
    const fin = (b0 & 0x80) !== 0;
    const opcode = b0 & 0x0f;
    const masked = (b1 & 0x80) !== 0;
    let length = b1 & 0x7f;
    let cursor = offset + 2;
    if (length === 126) {
      if (buffer.length - cursor < 2) break;
      length = buffer.readUInt16BE(cursor);
      cursor += 2;
    } else if (length === 127) {
      if (buffer.length - cursor < 8) break;
      const big = buffer.readBigUInt64BE(cursor);
      if (big > BigInt(MAX_WS_PAYLOAD)) return { frames, rest: Buffer.alloc(0), tooLarge: true };
      length = Number(big);
      cursor += 8;
    }
    if (length > MAX_WS_PAYLOAD) return { frames, rest: Buffer.alloc(0), tooLarge: true };
    let maskKey = null;
    if (masked) {
      if (buffer.length - cursor < 4) break;
      maskKey = buffer.subarray(cursor, cursor + 4);
      cursor += 4;
    }
    if (buffer.length - cursor < length) break;
    const payload = Buffer.from(buffer.subarray(cursor, cursor + length));
    if (maskKey) for (let i = 0; i < payload.length; i += 1) payload[i] ^= maskKey[i % 4];
    frames.push({ fin, opcode, payload });
    offset = cursor + length;
  }
  return { frames, rest: buffer.subarray(offset), tooLarge: false };
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

/* ------------------------------- /api/shop/* business chain ---------------------------------- */

/**
 * Deterministic e-commerce chain API. Every response carries the same correlation header
 * (`x-shop-trace: trace-shop-chain-1`), a unique per-request id (`x-request-id: shop-req-<n>`),
 * `cache-control: no-store` and the business code `code: 0`. Truth table: README.md §SHOP.
 *
 * Orders are keyed by runId and created idempotently: the first `POST /api/shop/orders` for a
 * runId mints `ORD-<runId>-1`, later POSTs with the same runId return that same order.
 * The order status is a small state machine: `created` -> `paid` after `POST /api/shop/checkout`.
 */
async function handleShopRoute(req, res, url, state) {
  const { pathname, searchParams } = url;
  const method = req.method || 'GET';

  // Ledger script shared by the five shop pages (one implementation, no CDP dependency).
  if (pathname === '/shop/shop-ledger.js') {
    if (method !== 'GET') return methodNotAllowed(res, ['GET']);
    const body = await readFile(join(HERE, 'shop-ledger.js'), 'utf8');
    res.writeHead(200, netHeaders({
      'content-type': 'text/javascript; charset=utf-8',
      'content-length': Buffer.byteLength(body),
    }));
    res.end(body);
    return true;
  }

  if (!pathname.startsWith('/api/shop/')) return false;
  state.shop.seq += 1;
  const requestId = `shop-req-${state.shop.seq}`;
  const reply = (payload, extraHeaders) => json(res, 200, payload, {
    // x-correlation-id is the header the default-rule correlation extractor reads; x-shop-trace is
    // the human-readable duplicate. The pages send BOTH as request headers too.
    'x-correlation-id': SHOP_TRACE,
    'x-shop-trace': SHOP_TRACE,
    'x-request-id': requestId,
    ...(extraHeaders || {}),
  });
  const readJsonBody = async () => {
    const raw = await readBody(req);
    if (!raw.trim()) return {};
    try {
      return JSON.parse(raw);
    } catch {
      return {};
    }
  };
  const findOrderById = (orderId) => {
    for (const order of state.shop.orders.values()) if (order.orderId === orderId) return order;
    return null;
  };
  const ensureOrder = (runId, productId) => {
    if (!state.shop.orders.has(runId)) {
      const product = SHOP_PRODUCTS.find((entry) => entry.id === productId) || SHOP_PRODUCTS[0];
      state.shop.orders.set(runId, {
        orderId: `ORD-${runId}-1`,
        runId,
        productId: product.id,
        total: product.price,
        status: 'created',
        paidAt: null,
        payMethod: null,
      });
    }
    return state.shop.orders.get(runId);
  };

  if (pathname === '/api/shop/products') {
    if (method !== 'GET') return methodNotAllowed(res, ['GET']);
    reply({
      code: 0,
      data: { products: SHOP_PRODUCTS.map(({ id, name, price }) => ({ id, name, price })) },
    });
    return true;
  }

  if (pathname.startsWith('/api/shop/products/')) {
    if (method !== 'GET') return methodNotAllowed(res, ['GET']);
    const productId = decodeURIComponent(pathname.slice('/api/shop/products/'.length));
    const product = SHOP_PRODUCTS.find((entry) => entry.id === productId);
    if (!product) {
      reply({ code: 0, data: { product: null } });
      return true;
    }
    reply({ code: 0, data: { product: { ...product } } });
    return true;
  }

  if (pathname === '/api/shop/orders/status') {
    if (method !== 'GET') return methodNotAllowed(res, ['GET']);
    const orderId = searchParams.get('orderId') || '';
    const order = findOrderById(orderId);
    reply({ code: 0, data: { orderId, status: order ? order.status : 'created' } });
    return true;
  }

  if (pathname === '/api/shop/orders/list') {
    if (method !== 'GET') return methodNotAllowed(res, ['GET']);
    const runId = searchParams.get('runId') || 'chain-1';
    const orders = [];
    for (const order of state.shop.orders.values()) {
      if (order.runId === runId) {
        orders.push({ orderId: order.orderId, status: order.status, total: order.total });
      }
    }
    reply({ code: 0, data: { orders } });
    return true;
  }

  if (pathname === '/api/shop/orders') {
    if (method === 'POST') {
      const body = await readJsonBody();
      const runId = typeof body.runId === 'string' && body.runId ? body.runId : 'chain-1';
      const productId = typeof body.productId === 'string' && body.productId ? body.productId : 'sku-1';
      const order = ensureOrder(runId, productId);
      order.runId = runId;
      reply({
        code: 0,
        data: {
          order: {
            orderId: order.orderId,
            productId: order.productId,
            total: order.total,
            status: order.status,
          },
        },
      });
      return true;
    }
    if (method === 'GET') {
      const orderId = searchParams.get('orderId') || '';
      const order = findOrderById(orderId);
      reply({
        code: 0,
        data: {
          order: order
            ? { orderId: order.orderId, productId: order.productId, total: order.total, status: order.status }
            : { orderId, productId: null, total: 0, status: 'created' },
        },
      });
      return true;
    }
    return methodNotAllowed(res, ['GET', 'POST']);
  }

  if (pathname === '/api/shop/checkout') {
    if (method !== 'POST') return methodNotAllowed(res, ['POST']);
    const body = await readJsonBody();
    const runId = typeof body.runId === 'string' && body.runId ? body.runId : 'chain-1';
    let order = state.shop.orders.get(runId);
    if (!order && typeof body.orderId === 'string' && body.orderId) {
      // Direct API use (no preceding order POST): adopt the given orderId so the route still
      // behaves deterministically instead of inventing a different id.
      order = {
        orderId: body.orderId,
        runId,
        productId: 'sku-1',
        total: SHOP_PRODUCTS[0].price,
        status: 'created',
        paidAt: null,
        payMethod: null,
      };
      state.shop.orders.set(runId, order);
    }
    if (!order) order = ensureOrder(runId, 'sku-1');
    order.runId = runId;
    order.status = 'paid';
    order.paidAt = SHOP_PAID_AT;
    order.payMethod = typeof body.payMethod === 'string' ? body.payMethod : 'card';
    reply({ code: 0, data: { orderId: order.orderId, status: order.status, paidAt: order.paidAt } });
    return true;
  }

  // Fixture-only helper: forget all orders of one runId so a chain can be replayed inside the same
  // server process (the acceptance suite normally just starts a fresh fixture instead).
  if (pathname === '/api/shop/reset') {
    const runId = searchParams.get('runId') || 'chain-1';
    state.shop.orders.delete(runId);
    reply({ code: 0, data: { runId, reset: true } });
    return true;
  }

  reply({ code: 0, data: null });
  return true;
}

/* ------------------------------------- /n/* network routes ------------------------------------- */

function methodNotAllowed(res, allowed) {
  json(res, 405, { error: 'net-method-not-allowed', status: 405 }, { allow: allowed.join(',') });
}

/**
 * All network fixture routes. Every response is deterministic (no clocks in payloads, no
 * randomness) and carries `cache-control: no-store` + `x-fixture: dsh-ui-testing`.
 * Returns true when the request was handled. Truth table: README.md §NET.
 */
async function handleNetworkRoute(req, res, url, state) {
  const { pathname, searchParams } = url;
  if (!pathname.startsWith('/n/')) return false;
  const method = req.method || 'GET';

  if (pathname === '/n/json') {
    if (method !== 'GET') return methodNotAllowed(res, ['GET']);
    json(res, 200, { message: 'net-fixture-ok', items: [1, 2, 3], query: queryObject(searchParams) });
    return true;
  }

  if (pathname === '/n/echo') {
    if (method !== 'POST' && method !== 'PUT') return methodNotAllowed(res, ['POST', 'PUT']);
    const raw = Buffer.from(await readBody(req), 'utf8');
    const { kind, parsed } = parseEchoBody(raw, echoHeader(req, 'content-type'));
    json(res, 200, { method, kind, parsed, headers: echoHeaders(req), bytes: raw.length });
    return true;
  }

  if (pathname === '/n/status/404') {
    if (method !== 'GET') return methodNotAllowed(res, ['GET']);
    json(res, 404, { error: 'net-not-found', status: 404 });
    return true;
  }
  if (pathname === '/n/status/500') {
    if (method !== 'GET') return methodNotAllowed(res, ['GET']);
    json(res, 500, { error: 'net-server-error', status: 500 });
    return true;
  }

  if (pathname === '/n/slow') {
    if (method !== 'GET') return methodNotAllowed(res, ['GET']);
    const ms = clampDelay(searchParams.get('ms'));
    setTimeout(() => {
      if (res.writableEnded) return;
      json(res, 200, { delayed: true, ms });
    }, ms);
    return true;
  }

  // Fixed two-hop redirect chain: /n/redirect/1 -> /n/redirect/2 -> /n/final. No free-form
  // target parameter, so the route can never become an open redirect.
  if (pathname === '/n/redirect/1') {
    if (method !== 'GET') return methodNotAllowed(res, ['GET']);
    redirect(res, '/n/redirect/2');
    return true;
  }
  if (pathname === '/n/redirect/2') {
    if (method !== 'GET') return methodNotAllowed(res, ['GET']);
    redirect(res, '/n/final');
    return true;
  }
  if (pathname === '/n/final') {
    if (method !== 'GET') return methodNotAllowed(res, ['GET']);
    json(res, 200, { landed: true });
    return true;
  }

  if (pathname === '/n/gzip') {
    if (method !== 'GET') return methodNotAllowed(res, ['GET']);
    const gz = gzipSync(Buffer.from(JSON.stringify({ gzip: true, message: 'net-gzip-ok' }), 'utf8'));
    res.writeHead(200, netHeaders({
      'content-type': 'application/json; charset=utf-8',
      'content-encoding': 'gzip',
      'content-length': gz.length,
    }));
    res.end(gz);
    return true;
  }

  if (pathname === '/n/chunked') {
    if (method !== 'GET') return methodNotAllowed(res, ['GET']);
    res.writeHead(200, netHeaders({ 'content-type': 'text/plain; charset=utf-8' }));
    res.flushHeaders();
    const segments = ['chunk-1\n', 'chunk-2\n', 'chunk-3\n'];
    segments.forEach((segment, index) => {
      setTimeout(() => {
        if (res.writableEnded) return;
        res.write(segment);
        if (index === segments.length - 1) res.end();
      }, index * 10);
    });
    return true;
  }

  if (pathname === '/n/large') {
    if (method !== 'GET') return methodNotAllowed(res, ['GET']);
    const size = clampInt(searchParams.get('bytes'), DEFAULT_LARGE_BYTES, 0, MAX_LARGE_BYTES);
    json(res, 200, { pad: 'x'.repeat(size) });
    return true;
  }

  if (pathname === '/n/sse') {
    if (method !== 'GET') return methodNotAllowed(res, ['GET']);
    res.writeHead(200, netHeaders({
      'content-type': 'text/event-stream; charset=utf-8',
      connection: 'keep-alive',
    }));
    res.flushHeaders();
    state.liveSockets.add(res);
    const events = [
      { delay: 10, id: 1, data: 'sse-1' },
      { delay: 30, id: 2, data: 'sse-2' },
      { delay: 60, id: 3, data: 'sse-3' },
    ];
    const timers = [];
    const cleanup = () => {
      for (const timer of timers) clearTimeout(timer);
      timers.length = 0;
      state.liveSockets.delete(res);
    };
    res.on('close', cleanup);
    for (const event of events) {
      timers.push(setTimeout(() => {
        if (res.writableEnded) return;
        res.write(`id: ${event.id}\nevent: tick\ndata: ${event.data}\n\n`);
        if (event.id === events.length) {
          res.end();
          cleanup();
        }
      }, event.delay));
    }
    return true;
  }

  if (pathname === '/n/poll') {
    if (method !== 'GET') return methodNotAllowed(res, ['GET']);
    json(res, 200, { poll: clampInt(searchParams.get('n'), 1, 1, MAX_POLL_N) });
    return true;
  }

  // Stateful per-key counter: the FIRST request for a key answers 503, every later one 200.
  // `?reset=1` clears the key so a probe can replay the 503 deterministically.
  if (pathname === '/n/flaky') {
    if (method !== 'GET') return methodNotAllowed(res, ['GET']);
    const key = searchParams.get('key') || 'default';
    if (searchParams.get('reset') === '1') {
      state.flakyAttempts.delete(key);
      json(res, 200, { key, reset: true, attempt: 0 });
      return true;
    }
    if (state.flakyAttempts.size > 500) state.flakyAttempts.clear();
    const attempt = (state.flakyAttempts.get(key) || 0) + 1;
    state.flakyAttempts.set(key, attempt);
    if (attempt === 1) json(res, 503, { key, attempt, ok: false, error: 'net-flaky' });
    else json(res, 200, { key, attempt, ok: true });
    return true;
  }

  if (pathname === '/n/token') {
    if (method !== 'GET') return methodNotAllowed(res, ['GET']);
    const token = searchParams.get('token') || '';
    json(res, 200, { token, length: token.length });
    return true;
  }

  if (pathname === '/n/cors') {
    const corsHeaders = {
      'access-control-allow-origin': '*',
      'access-control-allow-methods': 'GET,POST,PUT,OPTIONS',
      'access-control-allow-headers': 'content-type,x-net-probe,x-net-token,authorization',
      'access-control-max-age': '0',
    };
    if (method === 'OPTIONS') {
      res.writeHead(204, netHeaders(corsHeaders));
      res.end();
      return true;
    }
    if (method === 'GET') {
      json(res, 200, { cors: true }, corsHeaders);
      return true;
    }
    return methodNotAllowed(res, ['GET', 'OPTIONS']);
  }

  if (pathname === '/n/worker.js') {
    if (method !== 'GET') return methodNotAllowed(res, ['GET']);
    const body = await readFile(join(HERE, 'net-worker.js'), 'utf8');
    res.writeHead(200, netHeaders({
      'content-type': 'text/javascript; charset=utf-8',
      'content-length': Buffer.byteLength(body),
    }));
    res.end(body);
    return true;
  }
  // SharedWorker script: same-origin only, fetches /n/worker-data once per connection.
  if (pathname === '/n/shared-worker.js') {
    if (method !== 'GET') return methodNotAllowed(res, ['GET']);
    const body = await readFile(join(HERE, 'net-shared-worker.js'), 'utf8');
    res.writeHead(200, netHeaders({
      'content-type': 'text/javascript; charset=utf-8',
      'content-length': Buffer.byteLength(body),
    }));
    res.end(body);
    return true;
  }
  // Service worker script (127.0.0.1 is a potentially-trustworthy origin, so registration is
  // allowed over plain http). It registers NO fetch handler on purpose: it must not intercept the
  // fixture's own /n/* requests, only answer postMessage.
  if (pathname === '/n/sw.js') {
    if (method !== 'GET') return methodNotAllowed(res, ['GET']);
    const body = await readFile(join(HERE, 'net-sw.js'), 'utf8');
    res.writeHead(200, netHeaders({
      'content-type': 'text/javascript; charset=utf-8',
      'content-length': Buffer.byteLength(body),
      // Scope is widened to "/" so the service worker can control the fixture page itself
      // (/web-network.html lives outside /n/); it registers no fetch handler, so widening the
      // scope cannot intercept or alter any fixture request.
      'service-worker-allowed': '/',
    }));
    res.end(body);
    return true;
  }
  if (pathname === '/n/worker-data') {
    if (method !== 'GET') return methodNotAllowed(res, ['GET']);
    json(res, 200, { from: 'worker-data', ok: true });
    return true;
  }
  if (pathname === '/n/iframe-data') {
    if (method !== 'GET') return methodNotAllowed(res, ['GET']);
    json(res, 200, { from: 'iframe-data', ok: true });
    return true;
  }
  // /n/iframe.html is served from STATIC_FILES (same document as /web-network-frame.html).
  if (pathname === '/n/ws') {
    // Only the upgrade path (see server.on('upgrade')) speaks WebSocket.
    json(res, 426, { error: 'net-upgrade-required', status: 426 });
    return true;
  }
  return false;
}

export async function startFixtureServer({ host = HOST, port = 0 } = {}) {
  if (host !== HOST) throw new Error(`fixture server must bind to ${HOST} (got ${host})`);
  // Network fixture state lives per server instance so two fixtures never share counters.
  const flakyAttempts = new Map();   // flaky key -> requests observed so far
  // Shop chain state: orders keyed by runId + a monotonic per-request id counter.
  const shopState = { orders: new Map(), seq: 0 };
  const liveSockets = new Set();     // ws sockets + SSE responses, force-closed by close()
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
      if (await handleShopRoute(req, res, url, { shop: shopState })) return;
      if (await handleNetworkRoute(req, res, url, { flakyAttempts, liveSockets })) return;
      json(res, 404, { error: 'not-found', status: 404 });
    } catch (error) {
      if (!res.headersSent) json(res, 500, { error: 'fixture-server-error', message: String(error && error.message || error) });
      else res.end();
    }
  });

  // WebSocket upgrade: zero dependency, text frames only (plus ping/pong/close). The socket
  // echoes every text frame verbatim and pushes the fixed `server-push-1` text 10 ms after open.
  server.on('upgrade', (req, socket, head) => {
    let pathname = '/';
    try {
      pathname = new URL(req.url || '/', `http://${HOST}`).pathname;
    } catch { /* fall through to destroy */ }
    if (pathname !== '/n/ws') {
      socket.destroy();
      return;
    }
    const key = echoHeader(req, 'sec-websocket-key');
    if (!key) {
      socket.write('HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n');
      socket.destroy();
      return;
    }
    const accept = createHash('sha1').update(`${key}${WS_GUID}`).digest('base64');
    socket.write([
      'HTTP/1.1 101 Switching Protocols',
      'Upgrade: websocket',
      'Connection: Upgrade',
      `Sec-WebSocket-Accept: ${accept}`,
      '',
      '',
    ].join('\r\n'));
    liveSockets.add(socket);
    let buffer = Buffer.alloc(0);
    let fragments = Buffer.alloc(0);
    let closed = false;
    const finish = (frame) => {
      if (closed) return;
      closed = true;
      if (frame) socket.write(frame);
      liveSockets.delete(socket);
      socket.end();
      socket.destroy();
    };
    socket.on('error', () => finish());
    socket.on('close', () => {
      closed = true;
      liveSockets.delete(socket);
    });
    // Fixed server push: deterministic text, 10 ms after the handshake.
    const pushTimer = setTimeout(() => {
      if (!closed && !socket.destroyed) socket.write(wsEncodeText('server-push-1'));
    }, 10);
    socket.on('close', () => clearTimeout(pushTimer));
    if (head && head.length) buffer = Buffer.concat([buffer, head]);
    socket.on('data', (chunk) => {
      buffer = Buffer.concat([buffer, chunk]);
      const decoded = wsDecodeFrames(buffer);
      buffer = decoded.rest;
      if (decoded.tooLarge) {
        finish(wsCloseFrame(1009));
        return;
      }
      for (const frame of decoded.frames) {
        if (frame.opcode === 0x8) {
          finish(wsCloseFrame(1000));
          return;
        }
        if (frame.opcode === 0x9) {
          socket.write(wsEncodeFrame(0xa, frame.payload));
          continue;
        }
        if (frame.opcode === 0xa) continue;
        if (frame.opcode === 0x1 || frame.opcode === 0x0) {
          fragments = Buffer.concat([fragments, frame.payload]);
          if (frame.fin) {
            const text = fragments.toString('utf8');
            fragments = Buffer.alloc(0);
            socket.write(wsEncodeText(text));
          }
        }
      }
    });
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
    // SSE responses and WebSocket sockets would otherwise keep the listener alive forever.
    for (const socket of liveSockets) {
      try {
        if (typeof socket.end === 'function') socket.end();
        if (typeof socket.destroy === 'function') socket.destroy();
      } catch { /* already gone */ }
    }
    liveSockets.clear();
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
