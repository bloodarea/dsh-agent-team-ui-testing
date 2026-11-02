/**
 * Same-origin WebSocket push transport for preview frames.
 *
 * `createFramePusher(source, options)` is one transport for exactly one FrameSource (one
 * workspace runtime): it owns that source's clients, backpressure counters and flush schedule,
 * and it does NOT register any route.
 *
 * `attachFramePush(ctx, options)` registers the single `/plugins/ui-testing/frames` upgrade route
 * and dispatches each connection to the pusher of the runtime selected by the scope protocol:
 *
 *   1. RFC 6455 header validation (no await, no side effects);
 *   2. authentication — scoped connections go through the strict owner-only `authenticate`
 *      callback; unscoped (legacy) connections keep the historical requestRejection/loopback gate;
 *   3. async scope/binding resolution → a cold or live runtime (never starts Chromium);
 *   4. 101 Switching Protocols only after auth, scope and client capacity all succeeded.
 *
 * Wire format (server -> client):
 *   text  : {"type":"hello","transport":"ws","pushIntervalMs":40,"epoch":N,"seq":N,
 *            "scopeId":"…","runtimeId":"…"}
 *   binary: [uint32BE headerLength][JSON header][JPEG bytes]
 *           header = {v:1, seq, epoch, capturedAtMs, receivedAtMs, width, height,
 *                     pageWidth, pageHeight, scrollX, scrollY, format:"jpeg", scopeId, runtimeId,
 *                     dropped:{coalesced,blocked,stale,rejected}}
 *           (scrollX/scrollY are the capture-time top-level scroll, docs/canvas-viewport.md §5.1.)
 * Client -> server messages are ignored except close/ping control frames.
 */

import { createHash } from 'node:crypto';

const WS_GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';
const MAX_CLIENTS = 8;
/** Global cap across every per-scope pusher (one plugin, many workspaces). */
const GLOBAL_MAX_CLIENTS = 32;
const MAX_CLIENT_BUFFER = 64 * 1024;
const PUSH_INTERVAL_MS = 40;
const LOOPBACK = /^(?:::1|::ffff:127\.|127\.)/;

function isLoopback(address) {
  return typeof address === 'string' && LOOPBACK.test(address);
}

function acceptKey(key) {
  return createHash('sha1').update(key + WS_GUID).digest('base64');
}

function reject(socket, status, reason) {
  if (!socket || socket.destroyed) return;
  try {
    socket.write(`HTTP/1.1 ${status} ${reason}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
  } catch { /* ignore */ }
  try { socket.destroy(); } catch { /* ignore */ }
}

/** Encode one unmasked server->client WebSocket frame. */
function encodeFrame(opcode, payload) {
  const body = Buffer.isBuffer(payload) ? payload : Buffer.from(payload);
  const length = body.length;
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
    header.writeUInt32BE(0, 2);
    header.writeUInt32BE(length, 6);
  }
  header[0] = 0x80 | opcode;
  return Buffer.concat([header, body]);
}

function sendText(client, text) {
  if (client.closed || client.socket.destroyed) return false;
  return client.socket.write(encodeFrame(0x1, Buffer.from(text, 'utf8')));
}

function sendClose(client, code = 1000) {
  if (client.closed || client.socket.destroyed) return;
  const payload = Buffer.alloc(2);
  payload.writeUInt16BE(code, 0);
  try { client.socket.write(encodeFrame(0x8, payload)); } catch { /* ignore */ }
}

/**
 * One frame pusher for one FrameSource. No route, no scope knowledge: the caller supplies
 * `scopeInfo()` for the hello/binary metadata.
 *
 * @param {import('./frame-source.js').FrameSource} source
 * @param {{log?: Function, intervalMs?: number, maxClients?: number, now?: Function,
 *          scopeInfo?: () => {scopeId?: string|null, runtimeId?: string|null},
 *          onOpen?: () => void, onClose?: () => void}} [options]
 */
export function createFramePusher(source, options = {}) {
  const log = typeof options.log === 'function' ? options.log : () => {};
  const intervalMs = Number.isFinite(options.intervalMs) ? Math.max(0, Number(options.intervalMs)) : PUSH_INTERVAL_MS;
  const maxClients = Number.isFinite(options.maxClients) ? Math.max(1, Math.floor(Number(options.maxClients))) : MAX_CLIENTS;
  const now = typeof options.now === 'function' ? options.now : Date.now;
  const scopeInfo = typeof options.scopeInfo === 'function' ? options.scopeInfo : () => ({});
  const onOpen = typeof options.onOpen === 'function' ? options.onOpen : () => {};
  const onClose = typeof options.onClose === 'function' ? options.onClose : () => {};

  const counters = { pushed: 0, coalesced: 0, blocked: 0, stale: 0, rejected: 0, protocolErrors: 0 };
  const clients = new Set();
  let disposed = false;
  let lastPushedAt = 0;

  function info() {
    try { return scopeInfo() || {}; } catch { return {}; }
  }

  function encodeBinaryFrame(frame) {
    const scope = info();
    const header = Buffer.from(JSON.stringify({
      v: 1,
      seq: frame.seq,
      epoch: frame.epoch,
      capturedAtMs: frame.capturedAt,
      receivedAtMs: frame.receivedAt,
      width: frame.width,
      height: frame.height,
      pageWidth: frame.pageWidth,
      pageHeight: frame.pageHeight,
      // Capture-time top-level scroll: 0 is legal, missing values were normalized by FrameSource.
      scrollX: frame.scrollX,
      scrollY: frame.scrollY,
      format: frame.format,
      scopeId: scope.scopeId === undefined ? null : scope.scopeId,
      runtimeId: scope.runtimeId === undefined ? null : scope.runtimeId,
      dropped: { ...counters, clients: clients.size },
    }), 'utf8');
    const length = Buffer.alloc(4);
    length.writeUInt32BE(header.length, 0);
    // Decode the base64 JPEG once per frame, not once per connected viewer.
    if (!frame.bytes) frame.bytes = Buffer.from(frame.data, 'base64');
    return Buffer.concat([length, header, frame.bytes]);
  }

  function closeClient(client, code = 1001) {
    if (client.closed) return;
    // Complete the closing handshake while the socket is still writable, then mark it closed.
    sendClose(client, code);
    client.closed = true;
    const removed = clients.delete(client);
    if (client.timer !== null) {
      clearTimeout(client.timer);
      client.timer = null;
    }
    try { client.unsubscribe(); } catch { /* ignore */ }
    try { client.socket.end(); } catch { /* ignore */ }
    setTimeout(() => { try { client.socket.destroy(); } catch { /* ignore */ } }, 250).unref?.();
    if (removed) { try { onClose(); } catch { /* ignore */ } }
  }

  /** Flush the newest frame if one exists and the interval has elapsed. */
  function flush(client) {
    client.timer = null;
    if (client.closed) return;
    if (client.blocked) {
      counters.blocked += 1;
      return;
    }
    const frame = source.latest();
    if (frame === undefined) return;
    if (frame.seq === client.lastSeq) return;
    if (frame.epoch < source.epoch) {
      // A frame from a page that has already navigated away; wait for the new epoch.
      counters.stale += 1;
      return;
    }
    let payload;
    try {
      payload = encodeFrame(0x2, encodeBinaryFrame(frame));
    } catch (error) {
      counters.protocolErrors += 1;
      log('frame push: encode failed: ' + String((error && error.message) || error));
      return;
    }
    const start = now();
    let writable;
    try {
      writable = client.socket.write(payload);
    } catch {
      counters.protocolErrors += 1;
      closeClient(client, 1011);
      return;
    }
    client.lastSeq = frame.seq;
    client.lastSentAt = start;
    lastPushedAt = start;
    counters.pushed += 1;
    if (!writable) client.blocked = true;
  }

  function schedule(client) {
    if (client.closed) return;
    if (client.blocked) {
      counters.blocked += 1;
      return;
    }
    if (client.timer !== null) {
      counters.coalesced += 1;
      return;
    }
    const wait = Math.max(0, intervalMs - (now() - client.lastSentAt));
    if (wait === 0) {
      flush(client);
      return;
    }
    client.timer = setTimeout(() => flush(client), wait);
    client.timer.unref?.();
  }

  function handleClientData(client, chunk) {
    if (client.closed) return;
    client.buffer = client.buffer.length > 0 ? Buffer.concat([client.buffer, chunk]) : chunk;
    if (client.buffer.length > MAX_CLIENT_BUFFER) {
      counters.protocolErrors += 1;
      closeClient(client, 1009);
      return;
    }
    while (client.buffer.length >= 2) {
      const buffer = client.buffer;
      const opcode = buffer[0] & 0x0f;
      const masked = (buffer[1] & 0x80) !== 0;
      let length = buffer[1] & 0x7f;
      let offset = 2;
      if (length === 126) {
        if (buffer.length < 4) return;
        length = buffer.readUInt16BE(2);
        offset = 4;
      } else if (length === 127) {
        if (buffer.length < 10) return;
        if (buffer.readUInt32BE(2) !== 0) { counters.protocolErrors += 1; closeClient(client, 1009); return; }
        length = buffer.readUInt32BE(6);
        offset = 10;
      }
      if (!masked) { counters.protocolErrors += 1; closeClient(client, 1002); return; }
      if (buffer.length < offset + 4 + length) return;
      const mask = buffer.subarray(offset, offset + 4);
      const payload = Buffer.allocUnsafe(length);
      for (let index = 0; index < length; index += 1) payload[index] = buffer[offset + 4 + index] ^ mask[index & 3];
      client.buffer = buffer.subarray(offset + 4 + length);
      if (opcode === 0x8) { closeClient(client, 1000); return; }
      if (opcode === 0x9) {
        try { client.socket.write(encodeFrame(0xA, payload)); } catch { closeClient(client, 1011); return; }
      }
      // 0x1/0x2/0xA: not used by this protocol; ignore without closing.
    }
  }

  /** Handshake one already-authorised, already-scoped socket. Sends 101 only after capacity. */
  function handleUpgrade(req, socket, head) {
    if (disposed) { reject(socket, 503, 'Service Unavailable'); return false; }
    const headers = req.headers || {};
    if (String(headers.upgrade || '').toLowerCase() !== 'websocket' || !String(headers.connection || '').toLowerCase().includes('upgrade')) {
      reject(socket, 400, 'Bad Request');
      return false;
    }
    const key = headers['sec-websocket-key'];
    if (typeof key !== 'string' || !/^[A-Za-z0-9+/=]{16,}$/.test(key) || String(headers['sec-websocket-version'] || '') !== '13') {
      reject(socket, 400, 'Bad Request');
      return false;
    }
    if (clients.size >= maxClients) {
      counters.rejected += 1;
      reject(socket, 503, 'Service Unavailable');
      return false;
    }
    try {
      socket.write([
        'HTTP/1.1 101 Switching Protocols',
        'Upgrade: websocket',
        'Connection: Upgrade',
        `Sec-WebSocket-Accept: ${acceptKey(key)}`,
        '',
        '',
      ].join('\r\n'));
      socket.setNoDelay?.(true);
    } catch {
      reject(socket, 500, 'Internal Server Error');
      return false;
    }

    const client = {
      socket,
      closed: false,
      blocked: false,
      timer: null,
      lastSeq: -1,
      lastSentAt: 0,
      buffer: Buffer.alloc(0),
      unsubscribe: () => {},
    };
    client.unsubscribe = source.subscribe(() => schedule(client));
    socket.on('drain', () => {
      client.blocked = false;
      schedule(client);
    });
    // Client control frames (close/ping) and protocol errors must be read, otherwise a
    // browser-initiated close never completes and stalled clients accumulate against the cap.
    socket.on('data', (chunk) => handleClientData(client, chunk));
    socket.on('error', () => closeClient(client, 1011));
    socket.on('close', () => closeClient(client, 1001));
    clients.add(client);
    try { onOpen(); } catch { /* ignore */ }

    const scope = info();
    sendText(client, JSON.stringify({
      type: 'hello',
      transport: 'ws',
      pushIntervalMs: intervalMs,
      epoch: source.epoch,
      seq: source.seq,
      scopeId: scope.scopeId === undefined ? null : scope.scopeId,
      runtimeId: scope.runtimeId === undefined ? null : scope.runtimeId,
    }));
    if (head && head.length > 0) handleClientData(client, head);
    schedule(client);
    return true;
  }

  return {
    handleUpgrade,
    clientCount: () => clients.size,
    closeClients() {
      for (const client of [...clients]) closeClient(client, 1001);
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      for (const client of [...clients]) closeClient(client, 1001);
      clients.clear();
    },
    metrics() {
      const scope = info();
      return {
        transport: 'ws',
        pushIntervalMs: intervalMs,
        scopeId: scope.scopeId === undefined ? null : scope.scopeId,
        runtimeId: scope.runtimeId === undefined ? null : scope.runtimeId,
        clients: clients.size,
        lastPushedAt,
        ...counters,
      };
    },
  };
}

/**
 * Mount the single upgrade route and dispatch by scope. `resolve` is async and returns
 * `{ runtime, scope, entry }`; it must not start Chromium (cold entries are fine).
 *
 * @param {import('@deepseek-ai/cordis').Context} ctx
 * @param {{log?: Function, path?: string, authenticate?: (req) => number,
 *          parseScope?: (url: string) => object, statusFor?: (error: any) => number,
 *          resolve: (scopeRequest: object) => Promise<{runtime: object, scope?: object, entry?: object}>,
 *          onConnect?: (runtime: object, entry?: object) => void}} options
 */
export function attachFramePush(ctx, options = {}) {
  const log = typeof options.log === 'function' ? options.log : () => {};
  const path = options.path || '/plugins/ui-testing/frames';
  const parseScope = typeof options.parseScope === 'function' ? options.parseScope : () => ({ mode: 'legacy' });
  const statusFor = typeof options.statusFor === 'function' ? options.statusFor : () => 400;
  const pushers = new WeakMap();
  const allPushers = new Set();
  const counters = { rejected: 0, scopeErrors: 0 };
  let disposed = false;

  function pusherFor(runtime) {
    let pusher = pushers.get(runtime);
    if (pusher) return pusher;
    pusher = createFramePusher(runtime.frames, {
      log,
      path,
      scopeInfo: () => ({ scopeId: runtime.scope ? runtime.scope.id : null, runtimeId: runtime.runtimeId }),
      onOpen: () => {
        try { runtime.addViewer?.(); } catch { /* ignore */ }
        // The newly viewed page must become the front target to receive screencast frames.
        try { runtime.activate?.(); } catch { /* ignore */ }
        try { options.onConnect?.(runtime); } catch { /* ignore */ }
      },
      onClose: () => { try { runtime.removeViewer?.(); } catch { /* ignore */ } },
    });
    pushers.set(runtime, pusher);
    allPushers.add(pusher);
    // Runtime.metrics() asks its transport for push counters; the same object also closes this
    // runtime's clients on /close without touching other workspaces.
    runtime.frameTransport = pusher;
    return pusher;
  }

  /** Legacy unscoped upgrades keep the historical requestRejection / loopback gate. */
  function legacyAuth(req) {
    let connection;
    try { connection = typeof ctx.get === 'function' ? ctx.get('connection') : undefined; } catch { connection = undefined; }
    let rejection;
    if (connection && typeof connection.requestRejection === 'function') {
      try { rejection = connection.requestRejection(req); } catch { rejection = 401; }
    } else if (!isLoopback(req.socket && req.socket.remoteAddress)) {
      rejection = 403;
    }
    if (rejection === undefined || rejection === null || rejection === false) return 0;
    return rejection === 403 ? 403 : 401;
  }

  async function handleUpgrade(req, socket, head) {
    if (disposed) { reject(socket, 503, 'Service Unavailable'); return; }
    const headers = req.headers || {};
    if (String(headers.upgrade || '').toLowerCase() !== 'websocket' || !String(headers.connection || '').toLowerCase().includes('upgrade')) {
      reject(socket, 400, 'Bad Request');
      return;
    }
    const key = headers['sec-websocket-key'];
    if (typeof key !== 'string' || !/^[A-Za-z0-9+/=]{16,}$/.test(key) || String(headers['sec-websocket-version'] || '') !== '13') {
      reject(socket, 400, 'Bad Request');
      return;
    }

    // The scope/auth/resolve steps await: a socket that closes meanwhile must not be written to.
    let gone = false;
    const markGone = () => { gone = true; };
    socket.once('close', markGone);
    socket.once('error', markGone);
    try {
      // Scope-parameter presence decides "scoped" before parsing: authenticate first, then parse.
      let scoped = false;
      try {
        const query = new URL(req.url || '/', 'http://localhost').searchParams;
        scoped = ['scopeVersion', 'sessionId', 'scope', 'binding'].some((name) => {
          const value = query.get(name);
          return value !== null && value !== '';
        });
      } catch { scoped = true; }
      let status;
      if (scoped) status = typeof options.authenticate === 'function' ? options.authenticate(req) : 503;
      else status = legacyAuth(req);
      if (status) {
        counters.rejected += 1;
        reject(socket, status, status === 401 ? 'Unauthorized' : status === 403 ? 'Forbidden' : 'Service Unavailable');
        return;
      }
      let scopeRequest;
      try {
        scopeRequest = parseScope(req.url);
      } catch (error) {
        counters.scopeErrors += 1;
        reject(socket, statusFor(error), 'Bad Request');
        return;
      }
      let resolved;
      try {
        resolved = await options.resolve(scopeRequest);
      } catch (error) {
        counters.scopeErrors += 1;
        reject(socket, statusFor(error), 'Scope Unavailable');
        return;
      }
      if (gone || socket.destroyed) return;
      // Global socket cap across all workspaces; each pusher also enforces its own maxClients.
      let totalClients = 0;
      for (const candidate of allPushers) totalClients += candidate.clientCount();
      if (totalClients >= GLOBAL_MAX_CLIENTS) {
        counters.rejected += 1;
        reject(socket, 503, 'Service Unavailable');
        return;
      }
      const pusher = pusherFor(resolved.runtime);
      pusher.handleUpgrade(req, socket, head);
    } catch (error) {
      log('frame push upgrade failed: ' + String((error && error.message) || error));
      if (!gone && !socket.destroyed) reject(socket, 500, 'Internal Server Error');
    } finally {
      socket.removeListener('close', markGone);
      socket.removeListener('error', markGone);
    }
  }

  const unregister = ctx.webServer.registerUpgrade({ path, handler: handleUpgrade });

  return {
    path,
    handleUpgrade,
    release(runtime) {
      const pusher = pushers.get(runtime);
      if (!pusher) return;
      try { pusher.dispose(); } catch { /* ignore */ }
      allPushers.delete(pusher);
      pushers.delete(runtime);
      if (runtime.frameTransport === pusher) runtime.frameTransport = undefined;
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      try { unregister(); } catch { /* ignore */ }
      for (const pusher of [...allPushers]) { try { pusher.dispose(); } catch { /* ignore */ } }
      allPushers.clear();
    },
    metrics() {
      const list = [];
      for (const pusher of allPushers) list.push(pusher.metrics());
      return { transport: 'ws', path, clients: list.reduce((sum, item) => sum + (item.clients || 0), 0), pushers: list.length, ...counters };
    },
  };
}
