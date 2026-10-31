/**
 * Same-origin WebSocket push transport for preview frames.
 *
 * One exact HTTP upgrade route (`/plugins/ui-testing/frames`) hands the raw socket to this
 * module, which performs the RFC 6455 handshake itself (no dependency, no media server).
 * Frames are sent latest-only with a minimum interval; a socket that applies backpressure
 * causes frames to be dropped (never queued), so the preview cannot accumulate latency.
 *
 * Wire format (server -> client):
 *   text  : {"type":"hello","transport":"ws","pushIntervalMs":40,"epoch":N,"seq":N}
 *   binary: [uint32BE headerLength][JSON header][JPEG bytes]
 *           header = {v:1, seq, epoch, capturedAtMs, receivedAtMs, width, height,
 *                     pageWidth, pageHeight, format:"jpeg", dropped:{coalesced,blocked,stale,rejected}}
 * Client -> server messages are ignored except close/ping control frames.
 */

import { createHash } from 'node:crypto';

const WS_GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';
const MAX_CLIENTS = 8;
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
  if (socket.destroyed) return;
  try {
    socket.write(`HTTP/1.1 ${status} ${reason}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
  } catch { /* ignore */ }
  socket.destroy();
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
 * Mount the push transport.
 * @param {import('@deepseek-ai/cordis').Context} ctx host context carrying webServer.
 * @param {import('./frame-source.js').FrameSource} source frame store.
 * @param {{log?: (text: string) => void, path?: string, intervalMs?: number, maxClients?: number, now?: () => number}} [options]
 * @returns {{dispose: () => void, closeClients: () => void, metrics: () => object, path: string}}
 */
export function attachFramePush(ctx, source, options = {}) {
  const log = typeof options.log === 'function' ? options.log : () => {};
  const path = options.path || '/plugins/ui-testing/frames';
  const intervalMs = Number.isFinite(options.intervalMs) ? Math.max(0, Number(options.intervalMs)) : PUSH_INTERVAL_MS;
  const maxClients = Number.isFinite(options.maxClients) ? Math.max(1, Math.floor(Number(options.maxClients))) : MAX_CLIENTS;
  const now = typeof options.now === 'function' ? options.now : Date.now;

  const counters = { pushed: 0, coalesced: 0, blocked: 0, stale: 0, rejected: 0, protocolErrors: 0 };
  const clients = new Set();
  let disposed = false;
  let lastPushedAt = 0;

  function encodeBinaryFrame(frame) {
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
      format: frame.format,
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
    clients.delete(client);
    if (client.timer !== null) {
      clearTimeout(client.timer);
      client.timer = null;
    }
    try { client.unsubscribe(); } catch { /* ignore */ }
    try { client.socket.end(); } catch { /* ignore */ }
    setTimeout(() => { try { client.socket.destroy(); } catch { /* ignore */ } }, 250).unref?.();
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
    } catch (error) {
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
    const delay = Math.max(0, intervalMs - (now() - client.lastSentAt));
    if (delay === 0) {
      flush(client);
      return;
    }
    client.timer = setTimeout(() => flush(client), delay);
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

  function handleUpgrade(req, socket, head) {
    if (disposed) {
      reject(socket, 503, 'Service Unavailable');
      return;
    }
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

    // Same-origin browser sessions are authorised by the host connection service. When the
    // service is absent (tests, minimal compositions), only loopback callers may connect.
    const connection = typeof ctx.get === 'function' ? ctx.get('connection') : undefined;
    let rejection;
    if (connection && typeof connection.requestRejection === 'function') {
      try { rejection = connection.requestRejection(req); } catch { rejection = 401; }
    } else if (!isLoopback(req.socket && req.socket.remoteAddress)) {
      rejection = 403;
    }
    if (rejection) {
      counters.rejected += 1;
      reject(socket, rejection, rejection === 401 ? 'Unauthorized' : 'Forbidden');
      return;
    }
    if (clients.size >= maxClients) {
      counters.rejected += 1;
      reject(socket, 503, 'Service Unavailable');
      return;
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
      return;
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

    sendText(client, JSON.stringify({
      type: 'hello',
      transport: 'ws',
      pushIntervalMs: intervalMs,
      epoch: source.epoch,
      seq: source.seq,
    }));
    if (head && head.length > 0) handleClientData(client, head);
    schedule(client);
  }

  const unregister = ctx.webServer.registerUpgrade({ path, handler: handleUpgrade });

  return {
    path,
    dispose() {
      if (disposed) return;
      disposed = true;
      try { unregister(); } catch { /* ignore */ }
      for (const client of [...clients]) closeClient(client, 1001);
      clients.clear();
    },
    closeClients() {
      for (const client of [...clients]) closeClient(client, 1001);
    },
    metrics() {
      return {
        transport: 'ws',
        path,
        pushIntervalMs: intervalMs,
        clients: clients.size,
        lastPushedAt,
        ...counters,
      };
    },
  };
}
