import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';

const TAXONOMY = {
  NAV_FAILED: ['navigation', true], CDP_TIMEOUT: ['timeout', true],
  CDP_DISCONNECTED: ['disconnected', true], TARGET_NOT_FOUND: ['action', false],
  EVAL_ERROR: ['app', false], INVALID_ARGUMENT: ['input', false], BUSY: ['concurrency', true],
  UNSUPPORTED: ['capability', false], INTERNAL: ['internal', false], ABORTED: ['cancelled', true],
};
export class BrowserError extends Error {
  constructor(code, message, details = {}) {
    super(`[${code}] ${redactText(message)}`);
    this.name = 'BrowserError';
    this.code = code;
    [this.category, this.retryable] = TAXONOMY[code] || TAXONOMY.INTERNAL;
    this.details = details;
  }
  payload() {
    return { code: this.code, category: this.category, retryable: this.retryable,
      message: this.message, details: this.details };
  }
}
export function asBrowserError(error) {
  return error instanceof BrowserError ? error : new BrowserError('INTERNAL', String(error?.message || error));
}
export function checkAbort(signal) {
  if (signal?.aborted) throw new BrowserError('ABORTED', '操作已取消');
}
export function abortable(promise, signal) {
  checkAbort(signal);
  if (!signal) return promise;
  return new Promise((resolve, reject) => {
    const abort = () => { cleanup(); reject(new BrowserError('ABORTED', '操作已取消')); };
    const cleanup = () => signal.removeEventListener('abort', abort);
    signal.addEventListener('abort', abort, { once: true });
    Promise.resolve(promise).then((value) => { cleanup(); resolve(value); }, (error) => { cleanup(); reject(error); });
  });
}
const sensitive = /token|key|secret|password|auth|code|session/i;
export function redactUrl(raw) {
  try {
    const url = new URL(raw);
    if (url.username) url.username = '***';
    if (url.password) url.password = '***';
    for (const key of [...url.searchParams.keys()]) if (sensitive.test(key)) url.searchParams.set(key, '***');
    if (url.hash) url.hash = '***';
    return url.toString();
  } catch { return String(raw).replace(/\b(token|key|secret|password|auth|code|session)=[^&\s]*/gi, '$1=***'); }
}
export function redactText(value) {
  return String(value).replace(/https?:\/\/[^\s<>"']+/gi, (url) => redactUrl(url));
}
function blockedAddress(address, allowPrivate) {
  let value = address.toLowerCase().replace(/^\[|\]$/g, '');
  if (value.startsWith('::ffff:')) {
    const tail = value.slice(7);
    if (isIP(tail) === 4) value = tail;
    else {
      const parts = tail.split(':');
      if (parts.length === 2) {
        const n = parseInt(parts[0], 16) * 65536 + parseInt(parts[1], 16);
        value = [n >>> 24, (n >>> 16) & 255, (n >>> 8) & 255, n & 255].join('.');
      }
    }
  }
  if (isIP(value) === 4) {
    const [a, b] = value.split('.').map(Number);
    if (a === 0 || (a === 169 && b === 254) || a >= 224) return true;
    return !allowPrivate && (a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168));
  }
  if (isIP(value) === 6) {
    if (value === '::' || /^ff/i.test(value) || /^fe[89ab]/i.test(value)) return true;
    return !allowPrivate && /^f[cd]/i.test(value);
  }
  return true;
}
export async function validateTarget(raw, { origins = [], allowPrivate = process.env.DSH_UI_TESTING_ALLOW_PRIVATE === '1', signal } = {}) {
  checkAbort(signal);
  let url;
  try { url = new URL(raw); } catch { throw new BrowserError('INVALID_ARGUMENT', '地址不是合法 URL'); }
  if (!['http:', 'https:'].includes(url.protocol)) throw new BrowserError('INVALID_ARGUMENT', '只支持 http/https 地址');
  if (url.username || url.password) throw new BrowserError('INVALID_ARGUMENT', '导航地址不能包含凭据');
  const blockedOrigins = [...origins, process.env.DSH_WEB_URL].filter(Boolean).map((origin) => {
    try { return new URL(origin).origin; } catch { return null; }
  });
  if (blockedOrigins.includes(url.origin)) throw new BrowserError('INVALID_ARGUMENT', '不能导航到 DSH 自身 origin');
  const hostname = url.hostname.replace(/^\[|\]$/g, '');
  let addresses;
  try {
    addresses = isIP(hostname) ? [{ address: hostname }] : await abortable(lookup(hostname, { all: true }), signal);
  } catch (error) {
    if (error instanceof BrowserError) throw error;
    throw new BrowserError('NAV_FAILED', '导航域名解析失败', { url: redactUrl(raw) });
  }
  if (!addresses.length || addresses.some(({ address }) => blockedAddress(address, allowPrivate))) {
    throw new BrowserError('INVALID_ARGUMENT', '导航目标地址不在允许范围', { url: redactUrl(raw) });
  }
  return url.href;
}

/** Minimal cancellable CDP transport. Each settlement removes its timer and abort listener. */
export class Cdp {
  constructor(url) {
    this.url = url; this.nextId = 1; this.pending = new Map(); this.listeners = new Set(); this.closed = false;
  }
  connect({ signal, timeoutMs = 30000 } = {}) {
    checkAbort(signal);
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(this.url);
      this.ws = ws;
      let settled = false;
      const finish = (error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer); signal?.removeEventListener('abort', abort);
        if (error) { this.close(); reject(error); } else resolve(this);
      };
      const abort = () => finish(new BrowserError('ABORTED', 'CDP 连接已取消'));
      const timer = setTimeout(() => finish(new BrowserError('CDP_TIMEOUT', 'CDP 连接超时')), timeoutMs);
      signal?.addEventListener('abort', abort, { once: true });
      ws.onopen = () => finish();
      ws.onerror = () => finish(new BrowserError('CDP_DISCONNECTED', 'CDP 连接失败'));
      ws.onclose = () => {
        this.closed = true;
        finish(new BrowserError('CDP_DISCONNECTED', 'CDP 连接已关闭'));
        this.rejectPending();
      };
      ws.onmessage = (event) => {
        let message;
        try { message = JSON.parse(event.data); } catch { return; }
        if (message.id !== undefined) {
          const entry = this.pending.get(message.id);
          if (entry) entry.finish(message.error ? new BrowserError('INTERNAL', message.error.message || 'CDP error') : null, message.result);
        } else for (const listener of this.listeners) listener(message);
      };
    });
  }
  send(method, params = {}, { signal, timeoutMs = 30000, sessionId } = {}) {
    if (this.closed) return Promise.reject(new BrowserError('CDP_DISCONNECTED', 'CDP 连接已关闭'));
    if (signal?.aborted) return Promise.reject(new BrowserError('ABORTED', '操作已取消'));
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const abort = () => finish(new BrowserError('ABORTED', '操作已取消', { method }));
      const finish = (error, value) => {
        if (!this.pending.delete(id)) return;
        clearTimeout(timer); signal?.removeEventListener('abort', abort);
        if (error) reject(error); else resolve(value);
      };
      const timer = setTimeout(() => finish(new BrowserError('CDP_TIMEOUT', 'CDP 超时: ' + method)), timeoutMs);
      this.pending.set(id, { finish, timer });
      signal?.addEventListener('abort', abort, { once: true });
      try { this.ws.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) })); }
      catch {
        finish(new BrowserError('CDP_DISCONNECTED', 'CDP 发送失败'));
        this.close();
      }
    });
  }
  rejectPending() {
    for (const entry of [...this.pending.values()]) entry.finish(new BrowserError('CDP_DISCONNECTED', 'CDP 连接已关闭'));
  }
  on(listener) { this.listeners.add(listener); return () => this.listeners.delete(listener); }
  close() { this.closed = true; this.rejectPending(); try { this.ws?.close(); } catch { /* already closed */ } }
}
