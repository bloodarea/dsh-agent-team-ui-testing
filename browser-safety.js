import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';

const TAXONOMY = {
  NAV_FAILED: ['navigation', true], CDP_TIMEOUT: ['timeout', true],
  CDP_DISCONNECTED: ['disconnected', true], TARGET_NOT_FOUND: ['action', false],
  EVAL_ERROR: ['app', false], INVALID_ARGUMENT: ['input', false], BUSY: ['concurrency', true],
  UNSUPPORTED: ['capability', false], INTERNAL: ['internal', false], ABORTED: ['cancelled', true],
  // Independent HTTP client (docs/t1-http-request.md §6): HTTP timeouts are not CDP timeouts
  // (they must never trigger the page "close the browser before releasing the queue" path).
  HTTP_TIMEOUT: ['timeout', true], HTTP_FAILED: ['network', true], HTTP_REDIRECT_LIMIT: ['network', false],
  // Workspace isolation (docs/workspace-isolation.md): these must never fall back to INTERNAL.
  SCOPE_INVALID: ['input', false], SCOPE_NOT_FOUND: ['scope', false],
  SCOPE_UNAVAILABLE: ['scope', true], SCOPE_FORBIDDEN: ['authorization', false],
  RUNTIME_LIMIT: ['resource', true],
  // Web T2 (structured GUI, docs/t2-structured-gui.md): a ref that no longer points at the node it
  // was minted for, a selector that is not unique, a target that cannot be acted on, and a bounded
  // wait that ran out. RETRYABLE only tells the caller a retry *may* help — a stale ref needs a new
  // snapshot, not a replay.
  REF_STALE: ['action', false], TARGET_NOT_UNIQUE: ['action', false],
  NOT_INTERACTABLE: ['action', false], WAIT_TIMEOUT: ['timeout', true],
  // Shared viewport (docs/viewport-control.md §7.1, Lead freeze 2026-11-01): an optimistic
  // concurrency failure, not a bad argument and not a page failure. `state` + retryable=true means
  // "read the current view and decide again"; the patch was NOT applied and page lastError is kept.
  VIEWPORT_CONFLICT: ['state', true],
  // P0 capture infrastructure (docs/capture-p0.md): the capture pipeline has its own taxonomy so a
  // bad screenshot never masquerades as INTERNAL. Size/format refusals are not retryable (the same
  // page would produce the same bytes); a failed CDP capture and a failed output write are.
  // ABORTED/CDP_TIMEOUT/CDP_DISCONNECTED keep their existing codes for capture too.
  CAPTURE_FAILED: ['capture', true], INVALID_PNG: ['capture', false],
  CAPTURE_SIZE_MISMATCH: ['capture', false], CAPTURE_UPSCALED: ['capture', false],
  CAPTURE_TOO_LARGE: ['resource', false], OUTPUT_PATH_INVALID: ['input', false],
  OUTPUT_EXISTS: ['output', false], OUTPUT_WRITE_FAILED: ['output', true],
  // Web T3 (static vision, docs/t3-vision.md §3.3). Every code below is fixed by the contract:
  // a vision refusal must never degrade into INTERNAL, and a product/baseline that cannot be
  // read must never be reported as a visual FAIL. `vision` marks "the image/source side said no",
  // `action` marks "the live page no longer matches the screenshot", `output` marks the managed
  // baseline root on disk, `concurrency` marks the HEAD CAS loser.
  VISION_SOURCE_NOT_FOUND: ['vision', false], VISION_FORMAT_UNSUPPORTED: ['vision', false],
  VISION_LIMIT_EXCEEDED: ['resource', false], VISION_TIMEOUT: ['timeout', true],
  VISION_SIZE_MISMATCH: ['vision', false], VISION_EMPTY_COMPARISON: ['vision', false],
  VISION_STALE_IMAGE: ['action', false], VISION_HIT_MISMATCH: ['action', false],
  VISION_BASELINE_ROOT_UNAVAILABLE: ['output', false], VISION_BASELINE_NAME_INVALID: ['input', false],
  VISION_BASELINE_NOT_FOUND: ['vision', false], VISION_BASELINE_EXISTS: ['output', false],
  VISION_BASELINE_CONFLICT: ['concurrency', false],
  VISION_BASELINE_READ_FAILED: ['output', true], VISION_BASELINE_WRITE_FAILED: ['output', true],
  // Web P0 network collection (docs/network-p0.md §2.9). Codes, categories and retryability are
  // fixed by the contract table: `scope` = the session/store is not there, `action` = the cited
  // event is gone, `resource` = a declared budget, `concurrency` = the page/session is owned
  // elsewhere or an id/step name collides, `capability` = no CDP/page or an unsupported CDP call,
  // `output`/`input` = the evidence file side, `authorization` = cross-agent/cross-scope access.
  NET_SESSION_NOT_FOUND: ['scope', false], NET_SESSION_ACTIVE: ['concurrency', false],
  NET_SESSION_NOT_ACTIVE: ['scope', true], NET_CONFIG_INVALID: ['input', false],
  NET_EVENT_NOT_FOUND: ['action', false], NET_BODY_UNAVAILABLE: ['network', true],
  NET_QUOTA_EXCEEDED: ['resource', false], NET_RULE_INVALID: ['input', false],
  NET_RULE_CONFLICT: ['concurrency', false], NET_RULE_NOT_FOUND: ['input', false],
  NET_CONTROL_UNAVAILABLE: ['capability', false], NET_CONTROL_TIMEOUT: ['timeout', true],
  NET_EXPORT_FAILED: ['output', true], NET_IMPORT_FAILED: ['input', false],
  NET_HAR_INVALID: ['input', false], NET_SUBSCRIPTION_NOT_FOUND: ['scope', false],
  NET_SUBSCRIPTION_FORBIDDEN: ['authorization', false], NET_INTEGRITY_FAILED: ['integrity', false],
  NET_SCOPE_FORBIDDEN: ['authorization', false],
  // R1-5（docs/network-p0.md §13）：新 7 工具的参数/路径/根/写盘错误一律 NET_*，
  // 只有 BUSY/ABORTED/CDP_*/RUNTIME_LIMIT 这些平台码可以透传。
  NET_INVALID_ARGUMENT: ['input', false], NET_OUTPUT_ROOT_UNKNOWN: ['output', false],
  NET_OUTPUT_PATH_INVALID: ['input', false], NET_OUTPUT_WRITE_FAILED: ['output', true],
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
export async function validateTarget(raw, { origins = [], allowPrivate = process.env.DSH_UI_TESTING_ALLOW_PRIVATE === '1', signal, resolve = lookup } = {}) {
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
    // `resolve` is an injection point for probes (mixed public/private DNS, zero-dispatch
    // scenarios). Production always uses the real `dns/promises` lookup imported above.
    addresses = isIP(hostname) ? [{ address: hostname }] : await abortable(resolve(hostname, { all: true }), signal);
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
    if (this.closed) return Promise.reject(new BrowserError('CDP_DISCONNECTED', 'CDP 连接已关闭', { method }));
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
      this.pending.set(id, { finish, timer, method });
      signal?.addEventListener('abort', abort, { once: true });
      try { this.ws.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) })); }
      catch {
        finish(new BrowserError('CDP_DISCONNECTED', 'CDP 发送失败'));
        this.close();
      }
    });
  }
  rejectPending() {
    for (const entry of [...this.pending.values()]) entry.finish(new BrowserError('CDP_DISCONNECTED', 'CDP 连接已关闭', { method: entry.method }));
  }
  on(listener) { this.listeners.add(listener); return () => this.listeners.delete(listener); }
  close() { this.closed = true; this.rejectPending(); try { this.ws?.close(); } catch { /* already closed */ } }
}
