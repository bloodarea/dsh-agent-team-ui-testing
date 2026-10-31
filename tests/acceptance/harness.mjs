/**
 * Acceptance harness: loads the *real* plugin entry (../../index.js), mounts it on a fake Cordis
 * context, and exposes the registered agent tools plus the plugin's HTTP handler.
 *
 * The browser under test is the plugin's own headless Chromium (index.js spawns it through
 * CDP). Nothing in this file talks to CDP directly: all page operations go through the exact
 * tool implementations the Agent would call. The fake context implements the Cordis surface
 * index.js actually uses:
 *
 *   effect(fn, label)        -> runs fn() now, returns a disposer
 *   tools.register(def)      -> captures the tool definition, returns a disposer
 *   webServer.register(entry)-> captures the HTTP handler, returns a disposer
 *   webServer.registerUpgrade({path, handler}) -> captures the upgrade route
 *   ctx.get('connection')    -> configurable fake connection service (requestRejection)
 *   skills.register(skill)   -> captures the skill registration, returns a disposer
 *   logger.info(text)        -> captures plugin logs
 *   inject(deps, cb)         -> invokes cb with this same context immediately
 *
 * For the WebSocket frame pipeline the harness also starts a *real* node:http server
 * (startPluginHttpServer) that dispatches to the captured prefix route and upgrade routes, plus
 * a Node 22 native WebSocket client helper (connectFrameWebSocket) and an upgrade handler
 * invoker with a socket stub (invokeUpgradeRoute) for auth/loopback security probes.
 *
 * Everything is zero-dependency and read-only for the repository besides the evidence directory.
 */
import { EventEmitter } from 'node:events';
import { readFileSync, readdirSync } from 'node:fs';
import { readdir, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { apply } from '../../index.js';

/** The tool surface frozen in docs/runtime-t1.md and implemented by index.js. */
export const EXPECTED_TOOLS = Object.freeze([
  Object.freeze({ name: 'browser_navigate', required: ['url'] }),
  Object.freeze({ name: 'browser_eval', required: ['expression'] }),
  Object.freeze({ name: 'browser_screenshot', required: [] }),
  Object.freeze({ name: 'browser_input', required: ['events'] }),
  Object.freeze({ name: 'browser_network', required: [] }),
  Object.freeze({ name: 'browser_computed_style', required: ['selector'] }),
  Object.freeze({ name: 'browser_state', required: [] }),
  Object.freeze({ name: 'browser_capabilities', required: [] }),
]);

export const PROFILE_PREFIX = 'dsh-ui-testing-';

export function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function waitFor(check, { timeoutMs = 10000, intervalMs = 100, label = 'condition' } = {}) {
  return new Promise((resolve, reject) => {
    const started = Date.now();
    let lastError;
    const tick = async () => {
      try {
        const value = await check();
        if (value) return resolve(value);
      } catch (error) {
        lastError = error;
      }
      if (Date.now() - started >= timeoutMs) {
        const detail = lastError ? ` (last error: ${lastError.message})` : '';
        return reject(new Error(`timed out after ${timeoutMs}ms waiting for ${label}${detail}`));
      }
      setTimeout(tick, intervalMs);
    };
    tick();
  });
}

/** Profile directories the plugin creates under tmpdir() (`mkdtemp(join(tmpdir(), 'dsh-ui-testing-'))`). */
export async function snapshotProfileDirs() {
  try {
    const names = await readdir(tmpdir());
    return names.filter((name) => name.startsWith(PROFILE_PREFIX)).map((name) => join(tmpdir(), name));
  } catch {
    return [];
  }
}

/**
 * Find headless Chromium main processes whose `--user-data-dir` is one of the plugin's temp
 * profiles. Only /proc is read; no process is signalled unless the caller explicitly asks.
 */
export function scanPluginChromeProcesses() {
  const found = [];
  let entries;
  try {
    entries = readdirSync('/proc');
  } catch {
    return found;
  }
  for (const entry of entries) {
    if (!/^\d+$/.test(entry)) continue;
    let raw;
    try {
      raw = readFileSync(`/proc/${entry}/cmdline`);
    } catch {
      continue;
    }
    if (!raw.length) continue;
    const args = raw.toString('utf8').split('\0').filter(Boolean);
    if (!args.length) continue;
    if (!args.some((arg) => arg === '--headless=new')) continue;
    const profileArg = args.find((arg) => arg.startsWith('--user-data-dir='));
    if (!profileArg) continue;
    const profileDir = profileArg.slice('--user-data-dir='.length);
    if (!profileDir.includes(PROFILE_PREFIX)) continue;
    let parentPid;
    try {
      const status = readFileSync(`/proc/${entry}/stat`, 'utf8');
      parentPid = Number(status.slice(status.lastIndexOf(')') + 2).split(' ')[1]);
    } catch { continue; }
    found.push({ pid: Number(entry), parentPid, profileDir, bin: args[0], args });
  }
  return found;
}

export function isProcessAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

export async function pathExists(target) {
  try {
    await stat(target);
    return true;
  } catch {
    return false;
  }
}

/** Create the fake Cordis context surface used by index.js. */
export function createFakeCordisContext({ connection, attachments } = {}) {
  const toolDefs = new Map();
  const httpHandlers = [];
  const upgradeHandlers = [];
  const skillRegistrations = [];
  const logs = [];
  const effects = [];
  const events = new EventEmitter();

  const recordEffect = (fn, label) => {
    let cleanup;
    let threw;
    try {
      cleanup = fn();
    } catch (error) {
      threw = error;
    }
    const entry = {
      label: label || 'effect',
      dispose() {
        if (typeof cleanup === 'function') return cleanup();
        return undefined;
      },
    };
    effects.push(entry);
    if (threw) throw threw;
    return () => {
      const index = effects.indexOf(entry);
      if (index >= 0) effects.splice(index, 1);
      return entry.dispose();
    };
  };

  const ctx = {
    // index.js uses ctx.tools.register(...) inside ctx.effect(...).
    tools: {
      register(definition) {
        toolDefs.set(definition.name, definition);
        return () => { toolDefs.delete(definition.name); };
      },
    },
    // index.js registers { kind: 'prefix', path, handler }.
    webServer: {
      register(entry) {
        httpHandlers.push(entry);
        return () => {
          const index = httpHandlers.indexOf(entry);
          if (index >= 0) httpHandlers.splice(index, 1);
        };
      },
      // WebSocket upgrade route: { path, handler: (req, socket, head) => void }.
      registerUpgrade(route) {
        upgradeHandlers.push(route);
        return () => {
          const index = upgradeHandlers.indexOf(route);
          if (index >= 0) upgradeHandlers.splice(index, 1);
        };
      },
    },
    // Optional skills service (index.js guards with ctx.inject(['skills'], ...)).
    skills: {
      register(skill) {
        skillRegistrations.push(skill);
        return () => {
          const index = skillRegistrations.indexOf(skill);
          if (index >= 0) skillRegistrations.splice(index, 1);
        };
      },
    },
    logger: {
      info(text) { logs.push(String(text)); },
      warn(text) { logs.push('WARN ' + String(text)); },
      error(text) { logs.push('ERROR ' + String(text)); },
      debug() {},
    },
    effect: recordEffect,
    attachments,
    on(name, listener) {
      events.on(name, listener);
      return recordEffect(() => () => events.off(name, listener), `event:${name}`);
    },
    async emit(name, ...args) {
      await Promise.all(events.listeners(name).map((listener) => listener(...args)));
    },
    inject(deps, callback) {
      const list = Array.isArray(deps) ? deps : [deps];
      // Mirror optional service injection: absence must exercise the base64 fallback path.
      if (list.some((name) => !ctx[name])) return () => {};
      const sub = { ...ctx, effect: recordEffect };
      sub.skills = ctx.skills;
      const disposer = callback(sub);
      return () => {
        if (typeof disposer === 'function') disposer();
      };
    },
    get(name) {
      if (name === 'tools') return ctx.tools;
      if (name === 'webServer') return ctx.webServer;
      if (name === 'skills') return ctx.skills;
      if (name === 'logger') return ctx.logger;
      if (name === 'connection') return ctx.__internal.connection;
      if (name === 'attachments') return ctx.attachments;
      return undefined;
    },
    // Cordis services can also be read as properties (ctx.connection?.requestRejection(...)).
    get connection() { return ctx.__internal.connection; },
  };
  ctx.__internal = { toolDefs, httpHandlers, upgradeHandlers, skillRegistrations, logs, effects, connection: connection ?? undefined };
  return ctx;
}

function findHttpHandler(ctx, pathname) {
  for (const entry of ctx.__internal.httpHandlers) {
    if (entry.kind !== 'prefix') continue;
    if (pathname === entry.path || pathname.startsWith(entry.path + '/')) return entry;
  }
  return undefined;
}

/**
 * Minimal fake IncomingMessage/ServerResponse pair. The plugin's readJson() attaches its
 * listeners synchronously when the handler starts, so emitting the body on next tick works.
 */
export function callHttpHandler(ctx, { method = 'GET', path = '/', body, rawBody } = {}) {
  const entry = findHttpHandler(ctx, path.split('?')[0]);
  if (!entry) return Promise.reject(new Error(`no HTTP handler registered for ${path}`));
  const req = new EventEmitter();
  req.url = path;
  req.method = method;
  req.headers = {};
  req.destroy = () => {};
  const res = {
    statusCode: 0,
    headers: {},
    body: '',
    finished: false,
    writeHead(status, headers) {
      this.statusCode = status;
      this.headers = { ...headers };
      return this;
    },
    end(chunk) {
      if (chunk !== undefined && chunk !== null) this.body += Buffer.isBuffer(chunk) ? chunk.toString('utf8') : String(chunk);
      this.finished = true;
    },
  };
  const handlerPromise = entry.handler(req, res);
  process.nextTick(() => {
    if (rawBody !== undefined || body !== undefined) {
      const payload = rawBody !== undefined ? rawBody : JSON.stringify(body);
      req.emit('data', Buffer.from(payload, 'utf8'));
    }
    req.emit('end');
  });
  return Promise.resolve(handlerPromise).then(() => {
    let json;
    try { json = JSON.parse(res.body); } catch { json = undefined; }
    return { statusCode: res.statusCode, headers: res.headers, body: res.body, json };
  });
}

/**
 * Mount the real plugin on a fake context.
 * @returns tools/invoke/request helpers plus lifecycle/cleanup helpers.
 */
export async function createHarness({ name = 'harness', connection, attachments } = {}) {
  const ctx = createFakeCordisContext({ connection, attachments });
  apply(ctx);
  const tools = ctx.__internal.toolDefs;

  const invoke = async (toolName, args = {}, exec) => {
    const definition = tools.get(toolName);
    if (!definition) throw new Error(`tool not registered: ${toolName}`);
    const startedAt = Date.now();
    try {
      const value = await definition.execute(args, exec);
      const content = definition.output?.render ? await definition.output.render(args, value) : [];
      return { invoked: toolName, args, ok: true, value, content, durationMs: Date.now() - startedAt };
    } catch (error) {
      return {
        invoked: toolName,
        args,
        ok: false,
        threw: true,
        error: {
          name: error && error.name,
          message: String((error && error.message) || error),
          code: error && error.code,
          category: error && error.category,
          retryable: error && error.retryable,
          details: error && error.details,
          keys: error && typeof error === 'object' ? Object.keys(error) : [],
        },
        durationMs: Date.now() - startedAt,
      };
    }
  };

  const request = (options) => callHttpHandler(ctx, options);

  const dispose = async () => {
    for (const entry of [...ctx.__internal.effects].reverse()) {
      try { await entry.dispose(); } catch { /* cleanup must not mask results */ }
    }
    ctx.__internal.effects.length = 0;
  };

  const closeBrowser = async () => {
    try {
      return await request({ method: 'POST', path: '/plugins/ui-testing/close', body: {} });
    } catch (error) {
      return { statusCode: 0, error: String(error && error.message || error) };
    }
  };

  return {
    name,
    ctx,
    tools,
    toolNames: () => [...tools.keys()],
    toolDefinitions: () => [...tools.values()],
    invoke,
    request,
    closeBrowser,
    dispose,
    logs: ctx.__internal.logs,
    skillRegistrations: ctx.__internal.skillRegistrations,
    upgradeRoutes: () => [...ctx.__internal.upgradeHandlers],
    httpRoutes: () => [...ctx.__internal.httpHandlers],
    setConnection: (service) => { ctx.__internal.connection = service; },
    getConnection: () => ctx.__internal.connection,
  };
}

/* ------------------------------------------------------------------------------------------------
 * WebSocket frame pipeline helpers: real HTTP server around the plugin's registered routes,
 * Node 22 native WebSocket client, binary frame parsing and upgrade-handler socket-stub probing.
 * ---------------------------------------------------------------------------------------------- */

/** Fake `connection` service with a mutable requestRejection result (401 / 403 / undefined). */
export function createFakeConnectionService({ rejection } = {}) {
  let current = rejection;
  const calls = [];
  return {
    calls,
    requestRejection(request) {
      calls.push(request);
      return typeof current === 'function' ? current(request) : current;
    },
    setRejection(value) { current = value; },
    getRejection() { return current; },
  };
}

/**
 * Start a real node:http server that dispatches to the routes the plugin registered on the fake
 * context: prefix HTTP handler(s) via server.on('request') and exact upgrade routes via
 * server.on('upgrade'). Used to drive the plugin's frame WebSocket surface with a real browser-
 * grade client while still executing the exact production handler code.
 *
 * @returns { url, wsUrl, port, close } — wsUrl is the ws:// base (no path).
 */
export async function startPluginHttpServer(harness, { host = '127.0.0.1', port = 0 } = {}) {
  const { createServer } = await import('node:http');
  const httpHandlers = harness.ctx.__internal.httpHandlers;
  const upgradeHandlers = harness.ctx.__internal.upgradeHandlers;
  const sockets = new Set();
  const requests = [];
  const upgrades = [];

  const matchHttp = (pathname) => {
    let best;
    for (const entry of httpHandlers) {
      if (entry.kind === 'prefix' && (pathname === entry.path || pathname.startsWith(entry.path + '/'))) {
        if (!best || entry.path.length > best.path.length) best = entry;
      } else if (entry.kind === 'exact' && pathname === entry.path) {
        best = entry;
      }
    }
    return best;
  };

  const server = createServer((req, res) => {
    requests.push({ method: req.method, url: req.url, at: Date.now() });
    const pathname = new URL(req.url || '/', `http://${host}`).pathname;
    const entry = matchHttp(pathname);
    if (!entry) {
      res.writeHead(404, { 'content-type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ ok: false, error: 'no route for ' + pathname }));
      return;
    }
    Promise.resolve(entry.handler(req, res)).catch((error) => {
      if (!res.headersSent) {
        res.writeHead(500, { 'content-type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ ok: false, error: String((error && error.message) || error) }));
      } else {
        try { res.end(); } catch { /* ignore */ }
      }
    });
  });

  server.on('connection', (socket) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
  });

  server.on('upgrade', (req, socket, head) => {
    const pathname = new URL(req.url || '/', `http://${host}`).pathname;
    upgrades.push({ url: req.url, pathname, at: Date.now() });
    const entry = upgradeHandlers.find((route) => route.path === pathname);
    if (!entry) {
      try {
        socket.write('HTTP/1.1 404 Not Found\r\nconnection: close\r\ncontent-length: 0\r\n\r\n');
      } catch { /* ignore */ }
      try { socket.destroy(); } catch { /* ignore */ }
      return;
    }
    Promise.resolve(entry.handler(req, socket, head)).catch(() => {
      try { socket.destroy(); } catch { /* ignore */ }
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
  const actualPort = typeof address === 'object' && address ? address.port : port;
  const base = `http://${host}:${actualPort}`;
  return {
    host,
    port: actualPort,
    url: base,
    wsUrl: `ws://${host}:${actualPort}`,
    server,
    httpHandlers: () => [...httpHandlers],
    upgradeHandlers: () => [...upgradeHandlers],
    requests,
    upgrades,
    close: () => new Promise((resolve) => {
      try { server.closeAllConnections?.(); } catch { /* ignore */ }
      for (const socket of sockets) { try { socket.destroy(); } catch { /* ignore */ } }
      server.close(() => resolve());
      setTimeout(resolve, 1500).unref?.();
    }),
  };
}

/** Parse one binary frame message: [uint32BE headerLength][JSON header][JPEG bytes]. */
export function parseFrameBinary(buffer) {
  if (!buffer || buffer.length < 4) return undefined;
  const headerLength = buffer.readUInt32BE(0);
  if (!Number.isInteger(headerLength) || headerLength <= 0 || 4 + headerLength > buffer.length) return undefined;
  let header;
  try {
    header = JSON.parse(buffer.subarray(4, 4 + headerLength).toString('utf8'));
  } catch {
    return undefined;
  }
  return { header, jpeg: buffer.subarray(4 + headerLength), totalBytes: buffer.length, headerLength };
}

export function isJpegBuffer(buffer) {
  return Boolean(buffer && buffer.length >= 4 && buffer[0] === 0xff && buffer[1] === 0xd8);
}

function handleWsMessage(client, event) {
  const data = event?.data;
  if (typeof data === 'string') {
    let parsed = data;
    try { parsed = JSON.parse(data); } catch { /* keep raw text */ }
    client.textMessages.push(parsed);
    if (parsed && typeof parsed === 'object' && parsed.type === 'hello') client.hellos.push(parsed);
    return;
  }
  let buffer;
  if (data instanceof ArrayBuffer) buffer = Buffer.from(data);
  else if (ArrayBuffer.isView(data)) buffer = Buffer.from(data.buffer, data.byteOffset, data.byteLength);
  else if (Buffer.isBuffer(data)) buffer = data;
  else if (typeof Blob !== 'undefined' && data instanceof Blob) {
    data.arrayBuffer().then((ab) => recordBinaryFrame(client, Buffer.from(ab))).catch(() => {});
    return;
  } else return;
  recordBinaryFrame(client, buffer);
}

function recordBinaryFrame(client, buffer) {
  client.binaryMessages.push(buffer);
  const parsed = parseFrameBinary(buffer);
  if (!parsed) {
    client.malformedBinary.push(buffer.subarray(0, 64).toString('hex'));
    return;
  }
  client.frames.push({ ...parsed, receivedAt: Date.now() });
}

/**
 * Connect a Node 22 native WebSocket client. Resolves once the handshake opens; rejects on
 * handshake failure/timeout. The returned client accumulates `hellos`, `frames`, text messages.
 */
export function connectFrameWebSocket(url, { timeoutMs = 6000 } = {}) {
  const client = {
    url,
    ws: undefined,
    opened: false,
    closed: false,
    error: undefined,
    closeCode: undefined,
    closeReason: '',
    hellos: [],
    textMessages: [],
    frames: [],
    binaryMessages: [],
    malformedBinary: [],
    openedAt: undefined,
  };
  return new Promise((resolve, reject) => {
    let settled = false;
    let ws;
    try {
      ws = new WebSocket(url);
    } catch (error) {
      client.error = String((error && error.message) || error);
      reject(client);
      return;
    }
    client.ws = ws;
    try { ws.binaryType = 'arraybuffer'; } catch { /* ignore */ }
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      client.error = 'timeout waiting for websocket open';
      try { ws.close(); } catch { /* ignore */ }
      reject(client);
    }, timeoutMs);
    ws.addEventListener('open', () => {
      client.opened = true;
      client.openedAt = Date.now();
      if (!settled) { settled = true; clearTimeout(timer); resolve(client); }
    });
    ws.addEventListener('message', (event) => handleWsMessage(client, event));
    ws.addEventListener('error', (event) => {
      client.error = String(event?.message || event?.error?.message || 'websocket error');
      if (!settled) { settled = true; clearTimeout(timer); reject(client); }
    });
    ws.addEventListener('close', (event) => {
      client.closed = true;
      client.closeCode = event?.code;
      client.closeReason = event?.reason;
      if (!settled) { settled = true; clearTimeout(timer); reject(client); }
    });
  });
}

/** Await a predicate over a connected WebSocket client's accumulated messages. */
export function waitForWebSocket(client, predicate, { timeoutMs = 8000, intervalMs = 50, label = 'websocket message' } = {}) {
  return waitFor(() => {
    const value = predicate(client);
    return value || undefined;
  }, { timeoutMs, intervalMs, label });
}

export function closeFrameWebSocket(client, { code = 1000, reason = 'acceptance done' } = {}) {
  return new Promise((resolve) => {
    if (!client?.ws || client.closed) return resolve();
    const timer = setTimeout(resolve, 2000);
    client.ws.addEventListener('close', () => { clearTimeout(timer); resolve(); }, { once: true });
    try { client.ws.close(code, reason); } catch { clearTimeout(timer); resolve(); }
  });
}

/**
 * Socket stub for directly invoking a captured upgrade handler (auth / loopback probes).
 * Implements the small Duplex surface upgrade handlers typically use.
 */
export class FakeUpgradeSocket extends EventEmitter {
  constructor({ remoteAddress = '203.0.113.9', remotePort = 41234, localAddress = '127.0.0.1', localPort = 3080 } = {}) {
    super();
    this.remoteAddress = remoteAddress;
    this.remotePort = remotePort;
    this.localAddress = localAddress;
    this.localPort = localPort;
    this.written = [];
    this.writtenBytes = 0;
    this.ended = false;
    this.destroyed = false;
    this.destroyError = undefined;
    this.writable = true;
    this.readable = true;
  }

  write(chunk) {
    if (!this.writable) return false;
    this.written.push(Buffer.from(chunk));
    this.writtenBytes += Buffer.byteLength(chunk);
    return true;
  }

  end(chunk) {
    if (chunk !== undefined) this.write(chunk);
    this.ended = true;
    this.writable = false;
    this.emit('finish');
    return this;
  }

  destroy(error) {
    this.destroyed = true;
    this.destroyError = error;
    this.writable = false;
    this.readable = false;
    this.emit('close');
    return this;
  }

  setTimeout() { return this; }
  setNoDelay() { return this; }
  setKeepAlive() { return this; }
  ref() { return this; }
  unref() { return this; }
  get writtenText() { return Buffer.concat(this.written).toString('latin1'); }
}

/** Invoke the captured upgrade route directly with a forged remote address (no real TCP). */
export function invokeUpgradeRoute(harness, {
  path = '/plugins/ui-testing/frames',
  remoteAddress = '203.0.113.9',
  headers = {},
} = {}) {
  const entry = harness.upgradeRoutes().find((route) => route.path === path);
  if (!entry) return undefined;
  const socket = new FakeUpgradeSocket({ remoteAddress });
  const req = {
    method: 'GET',
    url: path,
    httpVersion: '1.1',
    socket,
    connection: socket,
    complete: false,
    headers: {
      host: 'fixture.example',
      connection: 'Upgrade',
      upgrade: 'websocket',
      'sec-websocket-key': 'dGhlIHNhbXBsZSBub25jZQ==',
      'sec-websocket-version': '13',
      ...headers,
    },
  };
  let thrown;
  let result;
  try {
    result = entry.handler(req, socket, Buffer.alloc(0));
  } catch (error) {
    thrown = error;
  }
  const settled = Promise.resolve(result).then(
    () => ({ thrown: undefined }),
    (error) => ({ thrown: error }),
  );
  return { entry, req, socket, result, thrown, settled };
}
