/**
 * WEB-T4 dynamic-network fixture routes (single-page commerce chain + truth ledger).
 *
 * Owner: executor-network (task-3). Contract: tests/ui_test_fixture/t4-prep-contract.md §2
 * (frozen by the Lead) and the route/truth table in tests/ui_test_fixture/t4-network.md.
 *
 * This module is wired into `server.mjs` (Lead-owned) through three exported functions:
 *   handleT4NetworkRoute(req, res, url, state)   -> true when the request was fully handled
 *   handleT4NetworkUpgrade({req,socket,head,pathname,state}) -> true when the socket was taken
 *   disposeT4Network(state)                      -> release timers / SSE / WS sockets
 *
 * Routes (all loopback-only, zero dependency, deterministic: no randomness, no real credentials,
 * every response carries `cache-control: no-store` + `x-fixture: dsh-ui-testing`):
 *   GET  /web-t4-network.html                 single-page commerce chain page
 *   GET  /t4/network/t4-network-ledger.js     page-side truth ledger script
 *   GET  /api/t4/ledger?runId=t4-run-1        server-side request ledger (truth)
 *   POST|GET /api/t4/reset                    reset this fixture instance (also applies `scenario`)
 *   POST|GET /api/t4/cart                     cart add (idempotent per x-idempotency-key) / read
 *   POST /api/t4/orders                       create order (idempotent; fail-order / slow-order)
 *   GET  /api/t4/orders/:id                   current order status (server timers advance it)
 *   POST /api/t4/orders/:id/cancel            cancel the order (terminal state)
 *   GET  /api/t4/order-events?orderId=…       SSE: pending / +200 paid / +400 fulfilled / +600 close
 *   GET  /t4/ws (upgrade)                     WS: hello, +400 ms cart-updated, ping -> pong
 *
 * State is per fixture instance (`startFixtureServer()` passes one mutable object per server),
 * never process-global: two fixture servers in one process do not share counters.
 *
 * Truth: tests/ui_test_fixture/t4-network.md (frozen values runId=t4-run-1, traceId=t4-trace-1,
 * orderId=ORD-T4-1, price 4200 = ¥42.00, scenarios normal/no-ws/no-sse/poll-off/dup/fail-cart/
 * fail-order/slow-order).
 */
import { createHash } from 'node:crypto';
import { json, methodNotAllowed, notFound, readJsonBody, sendFile } from './t4-http-utils.mjs';

export const T4_RUN_ID = 't4-run-1';
export const T4_TRACE_ID = 't4-trace-1';
export const T4_ORDER_ID = 'ORD-T4-1';
/** Unit price in fen (¥42.00). Both the main product and the remote add-on use it. */
export const T4_PRICE = 4200;
export const T4_MAIN_SKU = 'sku-t4-main';
export const T4_REMOTE_SKU = 'sku-t4-remote';
export const T4_SCENARIOS = Object.freeze([
  'normal', 'no-ws', 'no-sse', 'poll-off', 'dup', 'fail-cart', 'fail-order', 'slow-order',
]);
/** slow-order delay (ms); the acceptance suite asserts browser duration >= 700 ms (tolerance). */
export const T4_SLOW_ORDER_MS = 800;
/** WS payload cap (same order of magnitude as the legacy /n/ws fixture). */
const MAX_WS_PAYLOAD = 64 * 1024;
const WS_GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';
/** Only these page assets are served under /t4/network/ (never a free-form file read). */
const NETWORK_ASSETS = new Set(['t4-network-ledger.js']);

/* ------------------------------------------------------------------------------------------------
 * State (per fixture instance; lazily initialised because server.mjs hands us a shared `{}`)
 * ---------------------------------------------------------------------------------------------- */

function freshState(scenario = 'normal') {
  return {
    t4Network: true,
    scenario,
    cart: { count: 0, revision: 0, items: [] },
    order: null,
    orderTimers: [],
    /** idempotencyKey -> {kind, body} (successful response only; failures are never cached) */
    dedupe: new Map(),
    /** idempotencyKey -> attempts observed (fail-order: the first attempt is rejected) */
    failOrderAttempts: new Map(),
    seq: 0,
    ledger: [],
    sseClients: new Set(),
    wsClients: new Set(),
    timers: new Set(),
  };
}

/** Mutate the server-owned object in place so the fixture keeps one state across calls. */
function ensureState(state) {
  if (state && state.t4Network === true) return state;
  const fresh = freshState();
  if (state && typeof state === 'object') {
    for (const key of Object.keys(state)) delete state[key];
    Object.assign(state, fresh);
    return state;
  }
  return fresh;
}

function later(state, ms, fn) {
  const timer = setTimeout(() => {
    state.timers.delete(timer);
    fn();
  }, ms);
  timer.unref?.();
  state.timers.add(timer);
  return timer;
}

const sleep = (ms) => new Promise((resolve) => {
  const timer = setTimeout(resolve, ms);
  timer.unref?.();
});

function resetState(state, scenario) {
  // Keep the open WS sockets: resetting the cart must not silently leak half-open sockets. The page
  // closes and reopens them itself on scenario switches (see t4-network-ledger.js).
  const wsClients = state.wsClients;
  for (const client of [...state.sseClients]) closeSseClient(state, client);
  for (const timer of state.orderTimers) clearTimeout(timer);
  for (const timer of state.timers) clearTimeout(timer);
  state.timers.clear();
  state.orderTimers = [];
  state.cart = { count: 0, revision: 0, items: [] };
  state.order = null;
  state.dedupe = new Map();
  state.failOrderAttempts = new Map();
  state.ledger = [];
  state.seq = 0;
  state.scenario = scenario;
  state.sseClients = new Set();
  state.wsClients = wsClients;
}

/* ------------------------------------------------------------------------------------------------
 * Cart / order truth helpers
 * ---------------------------------------------------------------------------------------------- */

function priceOfSku(sku) {
  // Both skus are ¥42.00 by contract; an unknown sku is still priced deterministically.
  return sku === T4_REMOTE_SKU || sku === T4_MAIN_SKU ? T4_PRICE : T4_PRICE;
}

function cartSnapshot(state) {
  return {
    count: state.cart.count,
    revision: state.cart.revision,
    items: state.cart.items.map((item) => ({ sku: item.sku, qty: item.qty, price: item.price })),
  };
}

function addCartItem(state, sku, qty) {
  const item = state.cart.items.find((entry) => entry.sku === sku);
  if (item) item.qty += qty;
  else state.cart.items.push({ sku, qty, price: priceOfSku(sku) });
  state.cart.count += qty;
  state.cart.revision += 1;
}

function cartTotal(state) {
  return state.cart.items.reduce((sum, item) => sum + item.price * item.qty, 0);
}

function orderSnapshot(state) {
  if (!state.order) return null;
  return {
    orderId: state.order.orderId,
    status: state.order.status,
    total: state.order.total,
    createdAtWallMs: state.order.createdAtWallMs,
  };
}

function scheduleOrderStatus(state, order) {
  state.orderTimers.push(later(state, 200, () => {
    if (state.order === order && order.status === 'pending') order.status = 'paid';
  }));
  state.orderTimers.push(later(state, 400, () => {
    if (state.order === order && (order.status === 'pending' || order.status === 'paid')) order.status = 'fulfilled';
  }));
}

function ensureOrder(state) {
  if (state.order) return state.order;
  const order = {
    orderId: T4_ORDER_ID,
    status: 'pending',
    total: cartTotal(state),
    createdAtWallMs: Date.now(),
  };
  state.order = order;
  scheduleOrderStatus(state, order);
  return order;
}

function currentOrderStatus(state, orderId) {
  if (!state.order || state.order.orderId !== orderId) return null;
  return state.order.status;
}

/* ------------------------------------------------------------------------------------------------
 * SSE clients
 * ---------------------------------------------------------------------------------------------- */

function writeSseEvent(state, client, id, status) {
  if (client.closed || client.res.writableEnded) return;
  const payload = { orderId: client.orderId, status, atWallMs: Date.now() };
  client.res.write(`id: ${id}\nevent: order\ndata: ${JSON.stringify(payload)}\n\n`);
}

function closeSseClient(state, client) {
  if (client.closed) return;
  client.closed = true;
  for (const timer of client.timers) clearTimeout(timer);
  client.timers = [];
  state.sseClients.delete(client);
  try {
    if (!client.res.writableEnded) client.res.end();
  } catch { /* socket already gone */ }
}

/* ------------------------------------------------------------------------------------------------
 * WebSocket helpers (minimal RFC 6455 codec, text + ping/pong/close only)
 * ---------------------------------------------------------------------------------------------- */

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
  header[0] = 0x80 | opcode;
  return Buffer.concat([header, data]);
}

const wsEncodeText = (text) => wsEncodeFrame(0x1, text);

function wsCloseFrame(code) {
  const payload = Buffer.alloc(2);
  payload.writeUInt16BE(code, 0);
  return wsEncodeFrame(0x8, payload);
}

/** Decode as many complete (masked) client frames as possible. */
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

function closeWsClient(state, client) {
  if (client.closed) return;
  client.closed = true;
  for (const timer of client.timers) clearTimeout(timer);
  client.timers = [];
  state.wsClients.delete(client);
  try {
    if (!client.socket.destroyed) {
      client.socket.write(wsCloseFrame(1000));
      client.socket.end();
    }
  } catch { /* socket already gone */ }
  try { client.socket.destroy(); } catch { /* socket already gone */ }
}

/* ------------------------------------------------------------------------------------------------
 * Request ledger + response headers
 * ---------------------------------------------------------------------------------------------- */

function headerOf(req, name) {
  const value = req.headers[name];
  if (value === undefined) return '';
  return Array.isArray(value) ? value.join(', ') : String(value);
}

/** Echo the caller's correlation headers (fixed fake values, no redaction needed at the source). */
function replyHeaders(req, extra = {}) {
  return {
    'x-request-id': headerOf(req, 'x-request-id'),
    'x-trace-id': headerOf(req, 'x-trace-id'),
    'x-op-id': headerOf(req, 'x-op-id'),
    ...extra,
  };
}

/**
 * 405 for an /api/t4/* route. The shared helper cannot echo the caller's correlation headers, and
 * contract §2 requires every API response to echo x-request-id / x-trace-id / x-op-id.
 */
function methodNotAllowedApi(req, res, allowed) {
  json(res, 405, { error: 'method-not-allowed', status: 405, allowed }, replyHeaders(req, { allow: allowed.join(', ') }));
}

function recordRequest(state, req, path) {
  const entry = {
    seq: (state.seq += 1),
    method: req.method || 'GET',
    path,
    traceId: headerOf(req, 'x-trace-id') || null,
    opId: headerOf(req, 'x-op-id') || null,
    requestId: headerOf(req, 'x-request-id') || null,
    idempotencyKey: headerOf(req, 'x-idempotency-key') || null,
    status: null,
    deduped: false,
    retried: false,
    atWallMs: Date.now(),
  };
  state.ledger.push(entry);
  return entry;
}

/* ------------------------------------------------------------------------------------------------
 * Routes
 * ---------------------------------------------------------------------------------------------- */

/**
 * All /api/t4/* + page routes. Returns true when this module handled the request (response already
 * written), false when the path belongs to another fixture (server.mjs then falls through to 404).
 */
export async function handleT4NetworkRoute(req, res, url, state) {
  const { pathname } = url;
  const method = req.method || 'GET';

  if (pathname === '/web-t4-network.html') {
    if (method !== 'GET') return methodNotAllowed(res, ['GET']);
    await sendFile(res, 'web-t4-network.html');
    return true;
  }

  if (pathname.startsWith('/t4/network/')) {
    if (method !== 'GET') return methodNotAllowed(res, ['GET']);
    const asset = pathname.slice('/t4/network/'.length);
    if (!NETWORK_ASSETS.has(asset)) {
      notFound(res, 't4-asset-not-found');
      return true;
    }
    await sendFile(res, asset);
    return true;
  }

  // Only the upgrade path speaks WebSocket (see handleT4NetworkUpgrade).
  if (pathname === '/t4/ws') {
    json(res, 426, { error: 't4-upgrade-required', status: 426 });
    return true;
  }

  if (!pathname.startsWith('/api/t4/')) return false;
  const st = ensureState(state);

  /* ------------------------------- reset (fixture control) ---------------------------------- */
  if (pathname === '/api/t4/reset') {
    if (method !== 'POST' && method !== 'GET') return methodNotAllowedApi(req, res, ['POST', 'GET']);
    let requested = url.searchParams.get('scenario');
    if (method === 'POST') {
      const body = await readJsonBody(req);
      if (!body.ok) {
        json(res, 400, { ok: false, error: { code: 'INVALID_ARGUMENT', message: body.error } }, replyHeaders(req));
        return true;
      }
      if (body.value && typeof body.value.scenario === 'string' && body.value.scenario) requested = body.value.scenario;
    }
    const scenario = requested || 'normal';
    if (!T4_SCENARIOS.includes(scenario)) {
      json(res, 400, {
        ok: false,
        error: { code: 'INVALID_SCENARIO', message: `unknown scenario: ${scenario}`, allowed: T4_SCENARIOS.slice() },
      }, replyHeaders(req));
      return true;
    }
    // The reset request itself is NOT recorded in the ledger: check 13 asserts the ledger is empty
    // right after a reset (a self-recording reset would make that assertion impossible).
    resetState(st, scenario);
    json(res, 200, {
      ok: true,
      runId: T4_RUN_ID,
      scenario,
      state: { cart: cartSnapshot(st), order: orderSnapshot(st) },
    }, replyHeaders(req));
    return true;
  }

  /* ----------------------------------------- cart ------------------------------------------- */
  if (pathname === '/api/t4/cart') {
    if (method === 'POST') {
      const body = await readJsonBody(req);
      const entry = recordRequest(st, req, pathname + url.search);
      if (!body.ok) {
        entry.status = 400;
        json(res, 400, { code: 400, error: { code: 'INVALID_ARGUMENT', message: body.error } }, replyHeaders(req));
        return true;
      }
      const value = body.value || {};
      const rawQty = Number(value.qty);
      const qty = Number.isFinite(rawQty) ? Math.min(Math.max(Math.round(rawQty), 1), 9) : 1;
      const sku = typeof value.sku === 'string' && value.sku ? value.sku : T4_MAIN_SKU;
      const key = headerOf(req, 'x-idempotency-key') || null;

      if (st.scenario === 'fail-cart') {
        entry.status = 500;
        json(res, 500, {
          error: { code: 'CART_REJECTED', message: '购物车更新被拒绝（fixture 场景 fail-cart）' },
        }, replyHeaders(req));
        return true;
      }

      if (key && st.dedupe.has(key)) {
        const stored = st.dedupe.get(key);
        entry.status = 200;
        entry.deduped = true;
        json(res, 200, { ...stored, deduped: true }, replyHeaders(req));
        return true;
      }

      addCartItem(st, sku, qty);
      const payload = { code: 0, cart: cartSnapshot(st), deduped: false };
      if (key) st.dedupe.set(key, payload);
      entry.status = 200;
      json(res, 200, payload, replyHeaders(req));
      return true;
    }
    if (method === 'GET') {
      const entry = recordRequest(st, req, pathname + url.search);
      entry.status = 200;
      json(res, 200, { code: 0, cart: cartSnapshot(st) }, replyHeaders(req));
      return true;
    }
    return methodNotAllowedApi(req, res, ['GET', 'POST']);
  }

  /* ---------------------------------------- orders ------------------------------------------ */
  if (pathname === '/api/t4/orders') {
    if (method !== 'POST') return methodNotAllowedApi(req, res, ['POST']);
    const body = await readJsonBody(req);
    const entry = recordRequest(st, req, pathname + url.search);
    if (!body.ok) {
      entry.status = 400;
      json(res, 400, { code: 400, error: { code: 'INVALID_ARGUMENT', message: body.error } }, replyHeaders(req));
      return true;
    }
    const key = headerOf(req, 'x-idempotency-key') || null;

    if (key && st.dedupe.has(key)) {
      const stored = st.dedupe.get(key);
      entry.status = 200;
      entry.deduped = true;
      json(res, 200, { ...stored, deduped: true }, replyHeaders(req));
      return true;
    }

    const attempt = key ? (st.failOrderAttempts.get(key) || 0) + 1 : 1;
    if (key) st.failOrderAttempts.set(key, attempt);
    if (st.scenario === 'fail-order' && attempt === 1) {
      entry.status = 500;
      json(res, 500, {
        error: { code: 'ORDER_REJECTED', message: '订单创建被拒绝（fixture 场景 fail-order，同 key 重试可成功）' },
      }, replyHeaders(req));
      return true;
    }

    const retried = st.scenario === 'fail-order' && attempt >= 2;
    if (st.scenario === 'slow-order') await sleep(T4_SLOW_ORDER_MS);
    const order = ensureOrder(st);
    const payload = { code: 0, order: orderSnapshot(st), deduped: false, retried };
    if (key) st.dedupe.set(key, payload);
    entry.status = 200;
    entry.retried = retried;
    json(res, 200, payload, replyHeaders(req));
    return true;
  }

  const cancelMatch = /^\/api\/t4\/orders\/([^/]+)\/cancel$/.exec(pathname);
  if (cancelMatch) {
    if (method !== 'POST') return methodNotAllowedApi(req, res, ['POST']);
    const orderId = decodeURIComponent(cancelMatch[1]);
    const entry = recordRequest(st, req, pathname);
    if (!st.order || st.order.orderId !== orderId) {
      entry.status = 404;
      json(res, 404, { error: { code: 'ORDER_NOT_FOUND', message: `unknown order: ${orderId}` } }, replyHeaders(req));
      return true;
    }
    if (st.order.status !== 'cancelled') {
      st.order.status = 'cancelled';
      for (const timer of st.orderTimers) clearTimeout(timer);
      st.orderTimers = [];
      for (const client of [...st.sseClients]) {
        if (client.orderId !== orderId) continue;
        writeSseEvent(st, client, client.lastId + 1, 'cancelled');
        closeSseClient(st, client);
      }
    }
    entry.status = 200;
    json(res, 200, { code: 0, order: orderSnapshot(st), cancelled: true }, replyHeaders(req));
    return true;
  }

  const orderMatch = /^\/api\/t4\/orders\/([^/]+)$/.exec(pathname);
  if (orderMatch) {
    if (method !== 'GET') return methodNotAllowedApi(req, res, ['GET']);
    const orderId = decodeURIComponent(orderMatch[1]);
    const entry = recordRequest(st, req, pathname);
    if (!st.order || st.order.orderId !== orderId) {
      entry.status = 404;
      json(res, 404, { error: { code: 'ORDER_NOT_FOUND', message: `unknown order: ${orderId}` } }, replyHeaders(req));
      return true;
    }
    entry.status = 200;
    json(res, 200, { code: 0, order: orderSnapshot(st) }, replyHeaders(req));
    return true;
  }

  /* ---------------------------------------- SSE --------------------------------------------- */
  if (pathname === '/api/t4/order-events') {
    if (method !== 'GET') return methodNotAllowedApi(req, res, ['GET']);
    const orderId = url.searchParams.get('orderId') || T4_ORDER_ID;
    res.writeHead(200, {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-store',
      'x-fixture': 'dsh-ui-testing',
      connection: 'keep-alive',
      ...replyHeaders(req),
    });
    res.flushHeaders?.();
    const client = { res, orderId, timers: [], closed: false, lastId: 0 };
    st.sseClients.add(client);
    const send = (id, status) => {
      client.lastId = id;
      writeSseEvent(st, client, id, status);
    };
    const initial = currentOrderStatus(st, orderId) || 'pending';
    send(1, initial);
    client.timers.push(later(st, 200, () => {
      if (client.closed) return;
      if (currentOrderStatus(st, orderId) === 'cancelled') return;
      send(2, 'paid');
    }));
    client.timers.push(later(st, 400, () => {
      if (client.closed) return;
      if (currentOrderStatus(st, orderId) === 'cancelled') return;
      send(3, 'fulfilled');
    }));
    client.timers.push(later(st, 600, () => closeSseClient(st, client)));
    res.on('close', () => {
      client.closed = true;
      for (const timer of client.timers) clearTimeout(timer);
      client.timers = [];
      st.sseClients.delete(client);
    });
    return true;
  }

  /* ---------------------------------------- ledger ------------------------------------------ */
  if (pathname === '/api/t4/ledger') {
    if (method !== 'GET') return methodNotAllowedApi(req, res, ['GET']);
    // The ledger read is not recorded either: it is diagnostic, not part of the business chain.
    json(res, 200, {
      ok: true,
      runId: url.searchParams.get('runId') || T4_RUN_ID,
      traceId: T4_TRACE_ID,
      scenario: st.scenario,
      requests: st.ledger.map((entry) => ({ ...entry })),
      state: { cart: cartSnapshot(st), order: orderSnapshot(st) },
    }, replyHeaders(req));
    return true;
  }

  json(res, 404, { error: 't4-route-not-found', status: 404 }, replyHeaders(req));
  return true;
}

/**
 * WebSocket upgrade dispatch. `server.mjs` calls this for every upgrade path except `/n/ws`
 * (owned by the legacy network fixture). Returning false makes the server destroy the socket.
 */
export function handleT4NetworkUpgrade({ req, socket, head, pathname, state }) {
  if (pathname !== '/t4/ws') return false;
  const st = ensureState(state);
  const key = headerOf(req, 'sec-websocket-key');
  if (!key) {
    try { socket.write('HTTP/1.1 400 Bad Request\r\nconnection: close\r\ncontent-length: 0\r\n\r\n'); } catch { /* gone */ }
    socket.destroy();
    return true;
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

  const client = {
    socket,
    closed: false,
    timers: [],
    buffer: Buffer.alloc(0),
    fragments: Buffer.alloc(0),
    remotePushed: false,
  };
  st.wsClients.add(client);

  const send = (payload) => {
    if (client.closed || socket.destroyed) return;
    socket.write(wsEncodeText(JSON.stringify(payload)));
  };

  // hello is sent immediately so the page can prove the channel is open deterministically.
  send({ type: 'hello', runId: T4_RUN_ID, scenario: st.scenario, atWallMs: Date.now() });

  // Fixed server push: +400 ms, remote cart add (sku-t4-remote x1) + cart-updated. Never repeated.
  if (st.scenario !== 'no-ws') {
    const pushTimer = setTimeout(() => {
      if (client.closed || socket.destroyed || client.remotePushed) return;
      client.remotePushed = true;
      addCartItem(st, T4_REMOTE_SKU, 1);
      send({
        type: 'cart-updated',
        frameId: 'ws-frame-1',
        sku: T4_REMOTE_SKU,
        qty: 1,
        cart: cartSnapshot(st),
        atWallMs: Date.now(),
      });
    }, 400);
    pushTimer.unref?.();
    client.timers.push(pushTimer);
  }

  if (head && head.length) client.buffer = Buffer.concat([client.buffer, head]);
  socket.on('data', (chunk) => {
    if (client.closed) return;
    client.buffer = Buffer.concat([client.buffer, chunk]);
    const decoded = wsDecodeFrames(client.buffer);
    client.buffer = decoded.rest;
    if (decoded.tooLarge) {
      closeWsClient(st, client);
      return;
    }
    for (const frame of decoded.frames) {
      if (frame.opcode === 0x8) {
        closeWsClient(st, client);
        return;
      }
      if (frame.opcode === 0x9) {
        if (!socket.destroyed) socket.write(wsEncodeFrame(0xa, frame.payload));
        continue;
      }
      if (frame.opcode === 0xa) continue;
      if (frame.opcode === 0x1 || frame.opcode === 0x0) {
        client.fragments = Buffer.concat([client.fragments, frame.payload]);
        if (!frame.fin) continue;
        const text = client.fragments.toString('utf8');
        client.fragments = Buffer.alloc(0);
        let parsed = null;
        try { parsed = JSON.parse(text); } catch { parsed = null; }
        if (parsed && parsed.type === 'ping') {
          send({ type: 'pong', nonce: parsed.nonce ?? null, atWallMs: Date.now() });
        } else if (text === 'ping') {
          send({ type: 'pong', nonce: null, atWallMs: Date.now() });
        } else {
          // Unknown client frame: echo it back as a text frame (same behaviour as /n/ws).
          send({ type: 'echo', data: text, atWallMs: Date.now() });
        }
      }
    }
  });
  socket.on('error', () => closeWsClient(st, client));
  socket.on('close', () => {
    client.closed = true;
    for (const timer of client.timers) clearTimeout(timer);
    client.timers = [];
    st.wsClients.delete(client);
  });
  return true;
}

/** Release timers/SSE/WS sockets created by this fixture. Called once by fixture.close(). */
export function disposeT4Network(state) {
  if (!state || state.t4Network !== true) return;
  for (const timer of state.timers) clearTimeout(timer);
  state.timers.clear();
  for (const timer of state.orderTimers) clearTimeout(timer);
  state.orderTimers = [];
  for (const client of [...state.sseClients]) closeSseClient(state, client);
  for (const client of [...state.wsClients]) closeWsClient(state, client);
  state.wsClients = new Set();
  state.sseClients = new Set();
}
