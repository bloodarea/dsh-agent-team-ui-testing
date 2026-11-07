/**
 * network-p0.js — WEB-P0 网络采集/分析/控制/证据的纯 JS 核心（零 npm 依赖）。
 *
 * 权威契约：docs/network-p0.md（§2 工具面 §3 采集 §4 事件模型与配额 §5 分析 §6 业务链路
 * §7 控制 §8 证据/安全/隔离 §13 R1 review 裁决）。契约优先于本文任何注释。
 *
 * 设计约束（与 vision-t3.js 同级）：
 *  - 只依赖 node 内置模块与既有 browser-safety.js（BrowserError/redactUrl/redactText）、
 *    capture-p0.js（publishCapture 的原子 no-clobber 提交点语义）。不启动浏览器、不 import CDP。
 *  - 失败一律抛 BrowserError（NET_*，§2.9 + §13 R1-5），不落 INTERNAL。
 *  - 纯函数（normalizeEvent / queryEvents / aggregateEvents / toJsonl / toHar / matchRule …）可
 *    独立单测；NetworkStore 每个 Runtime（= 每个工作区 scope）一个实例，状态不跨 scope 共享。
 *  - 不伪造：body 读不到 → `available:false`；丢失/淘汰/截断全计数；时间相邻只能标
 *    `basis:"temporal"`，不得冒充因果。
 *
 * 实现固定约定（契约未逐字规定、此处固定并公开）：
 *  - 内部请求键 = `(targetId, cdpSessionId, rawRequestId, hop)`（R1-10）；`hop` 从 0 递增，
 *    重定向每一跳 +1。对外 `requestId` 是 raw id，`hopId` 在事件里公开、detail 回 `hops[]`。
 *  - `ts.wallMs` 由采集器用**该 target 首次 `requestWillBeSent.wallTime` 锚点**推算（R1-11）；
 *    store 提供 `wallMsFor(targetId, cdpSeconds)`，缺锚点才回退 `Date.now()`。
 *  - `maxTotalBytes` 的近似字节口径固定为
 *    `sum(JSON-UTF8(event)) + sum(JSON-UTF8(headers)) + sum(raw body bytes) + pin 预算 + 候选缓冲`
 *    （`estimateBytes()` 公开，R1-15）；超限先淘汰 body（`bodyEvicted`），仍超限再淘汰最旧事件
 *    （`evicted`）。
 *  - `gaps` 同时包含淘汰与「因配额拒收」的 seq 洞（R1-15）。
 *  - 关联标识：每会话随机 HMAC 密钥，公开 `valueHash`（HMAC-SHA256 前 12 hex），内部
 *    `contentHash`（完整 hex，只用于同链路判等），原值不落库（R1-9）。`session.stop()` 清密钥。
 *  - URL 判等（重试/重复/轮询键）用**未脱敏 URL** 的 `urlHash`，不得用脱敏串（R1-9）。
 */

import { createHash, createHmac, randomBytes } from 'node:crypto';
import { mkdirSync, realpathSync, statSync } from 'node:fs';
import { isAbsolute, relative as relativePath, resolve as resolvePath, sep, dirname } from 'node:path';

import { BrowserError, redactText, redactUrl } from './browser-safety.js';
import { publishCapture } from './capture-p0.js';

/* ------------------------------------------------------------------ */
/* 常量                                                                */
/* ------------------------------------------------------------------ */

export const NET_VERSION = 1;
export const NET_PROTOCOL_VERSION = 1;

export const NET_DEFAULTS = Object.freeze({
  captureBodies: true,
  captureWebSocket: true,
  captureSse: true,
  captureWorkers: true,
  maxEvents: 5000,
  maxBodyBytes: 262144,
  maxTotalBytes: 8 * 1024 * 1024,
  maxWsFrames: 2000,
  businessStatusPath: null,
  maskRules: Object.freeze([]),
});

export const NET_LIMITS = Object.freeze({
  maxEvents: 20000,
  maxBodyBytes: 1024 * 1024,
  maxTotalBytes: 32 * 1024 * 1024,
  maxWsFrames: 20000,
  preSessionEvents: 200,
  sessionsRetained: 4,
  eventPageLimit: 200,
  eventPageDefault: 50,
  groupsLimit: 100,
  detailBodyBytes: 1024 * 1024,
  detailBodyMinBytes: 1024,
  detailEvents: 50,
  dependencyEdges: 50,
  urlBytes: 2048,
  headerCount: 64,
  headerValueBytes: 1024,
  errorTextBytes: 512,
  searchTextBytes: 256,
  wsPayloadBytes: 65536,
  sseDataBytes: 65536,
  initiatorStack: 10,
  redirectChain: 20,
  correlationRules: 32,
  rules: 32,
  held: 64,
  holdTimeoutMs: 30000,
  ruleBodyBytes: 65536,
  replayCount: 10,
  steps: 200,
  stepLabels: 16,
  objectRules: 16,
  objectEvents: 50,
  subscriptionMax: 16,
  subscriptionPin: 1000,
  subscriptionLimit: 200,
  importDataBytes: 8 * 1024 * 1024,
  importFileBytes: 64 * 1024 * 1024,
  retryWindowMs: 10000,
  pollWindowMs: 5000,
  pollIntervalTolerance: 0.3,
  networkWindowMs: 250,
  networkWindowTailMs: 50,
  networkWindowMax: 50,
});

export const NET_SESSION_ACTIONS = Object.freeze(['start', 'stop', 'status', 'reset']);
export const NET_SESSION_STATES = Object.freeze(['running', 'stopped', 'snapshot']);
export const NET_VIEWS = Object.freeze(['summary', 'full', 'timeline', 'aggregate']);
export const NET_KINDS = Object.freeze(['http', 'ws', 'sse', 'marker']);
export const NET_PHASES = Object.freeze([
  'request', 'redirect', 'response', 'data', 'finished', 'failed', 'extra-info',
  'ws-created', 'ws-handshake', 'ws-send', 'ws-receive', 'ws-error', 'ws-closed',
  'sse-message', 'mark', 'step-begin', 'step-end', 'evidence-link', 'control', 'session-meta',
]);
export const NET_BODY_STATES = Object.freeze(['captured', 'empty', 'unavailable']);
export const NET_DETAIL_PARTS = Object.freeze([
  'request', 'response', 'headers', 'body', 'timing', 'redirects', 'initiator', 'ws', 'sse',
  'correlation', 'dependencies', 'business', 'events', 'failure',
]);
export const NET_TRAIL_ACTIONS = Object.freeze(['begin-step', 'end-step', 'mark', 'link', 'window', 'query', 'reset']);
export const NET_EVIDENCE_ACTIONS = Object.freeze(['export', 'import', 'index', 'search', 'link', 'integrity', 'clear', 'list']);
export const NET_EVIDENCE_FORMATS = Object.freeze(['jsonl', 'har', 'auto']);
export const NET_CONTROL_ACTIONS = Object.freeze([
  'throttle', 'offline', 'intercept-add', 'intercept-remove', 'intercept-clear', 'intercept-list',
  'hold', 'resume', 'replay', 'mock', 'reset',
]);
export const NET_RULE_KINDS = Object.freeze(['block', 'fail', 'modify-request', 'fulfill', 'delay', 'hold', 'modify-response']);
export const NET_THEN_KINDS = Object.freeze(['continue', 'fulfill', 'fail']);
export const NET_SUBSCRIBE_ACTIONS = Object.freeze(['create', 'poll', 'ack', 'close', 'list']);
export const NET_GROUP_KEYS = Object.freeze(['url', 'method', 'status', 'statusClass', 'resourceType', 'host', 'kind', 'step']);
export const NET_AGGREGATE_METRICS = Object.freeze(['count', 'bytes', 'duration', 'p50', 'p95', 'failures']);
export const NET_OBJECT_SOURCES = Object.freeze(['url-query', 'url-path', 'header', 'json-body', 'ws', 'sse']);
export const NET_CORRELATION_SOURCES = Object.freeze(['header', 'url-query', 'json-body']);
export const NET_MARK_KINDS = Object.freeze(['tool', 'note', 'action', 'state', 'evidence', 'replay', 'control', 'manual']);
export const NET_SEARCH_FIELDS = Object.freeze(['url', 'body', 'headers', 'ws', 'sse']);
export const NET_CAUSALITY_BASES = Object.freeze(['explicit', 'redirect', 'initiator', 'temporal']);
export const NET_ISSUES = Object.freeze([
  'events-evicted', 'events-dropped', 'bodies-evicted', 'bodies-truncated', 'body-unavailable',
  'subscriber-overflow', 'held-overflow', 'cdp-disconnected', 'import-partial',
  'capture-disabled:websocket', 'capture-disabled:sse', 'capture-disabled:workers',
  'workers-not-attributable', 'workers-shared-attribution', 'response-modification-unsupported',
]);

/**
 * TOOL-P1-04：body 不可得原因码（稳定枚举，只做加法，不替换既有 `reason:"NET_BODY_UNAVAILABLE"`）。
 *
 *  - `not-captured`：采集期 `captureBodies:false`，从未尝试读取（不是 CDP 失败）。
 *  - `cdp-no-resource`：CDP 里已没有该请求的资源（requestId 未知 / 跨 target / 生命周期已结束）。
 *  - `cdp-evicted`：资源还在但 body 缓冲已被 CDP 淘汰或本地配额淘汰（cache/重定向中途/超预算）。
 *  - `cdp-timeout`：受限时长的 CDP body 读取超时。
 *  - `cdp-invalid-params`：CDP 拒绝参数（requestId 形态不合法等）。
 *  - `cdp-disconnected`：CDP 连接或子会话已断开/关闭。
 *  - `cdp-error`：其它明确来自 CDP 协议的错误（不细分，避免自造原因）。
 *  - `cdp-unknown`：无法分类；不猜、不伪造、不回显错误原文。
 */
export const NET_BODY_REASON_CODES = Object.freeze([
  'not-captured', 'cdp-no-resource', 'cdp-evicted', 'cdp-timeout',
  'cdp-invalid-params', 'cdp-disconnected', 'cdp-error', 'cdp-unknown',
]);

/** §5.6 默认关联规则。 */
export const DEFAULT_CORRELATION_RULES = Object.freeze([
  Object.freeze({ from: 'header', key: 'traceparent', path: null, name: 'traceparent' }),
  Object.freeze({ from: 'header', key: 'x-request-id', path: null, name: 'x-request-id' }),
  Object.freeze({ from: 'header', key: 'x-trace-id', path: null, name: 'x-trace-id' }),
  Object.freeze({ from: 'header', key: 'request-id', path: null, name: 'request-id' }),
  Object.freeze({ from: 'header', key: 'x-correlation-id', path: null, name: 'x-correlation-id' }),
  Object.freeze({ from: 'url-query', key: 'traceparent', path: null, name: 'traceparent' }),
  Object.freeze({ from: 'url-query', key: 'x-request-id', path: null, name: 'x-request-id' }),
  Object.freeze({ from: 'url-query', key: 'requestId', path: null, name: 'requestId' }),
  Object.freeze({ from: 'json-body', key: 'traceId', path: 'traceId', name: 'traceId' }),
  Object.freeze({ from: 'json-body', key: 'requestId', path: 'requestId', name: 'requestId' }),
]);

/** §5.2 业务状态码默认路径。 */
export const DEFAULT_BUSINESS_PATHS = Object.freeze(['code', 'status', 'errno', 'bizCode', 'error.code']);

const SENSITIVE_KEY = /(token|secret|password|passwd|authorization|cookie|api[-_]?key|session|credential)/i;
// Correlation ids are echoed back by echo endpoints; they are masked like any other credential
// (R1-9: only the HMAC survives) so an exported body never carries the raw id.
const CORRELATION_KEY = /(^|[-_.])(x-)?(request|trace|correlation|span)[-_]?id$|traceparent|tracestate/i;
// Bare `auth` / `auth_*` / `*_auth` (a fixture constant like `var AUTH = 'Bearer …'`) is a credential
// even though it is neither `authorization` nor a `*token*` name.
const AUTH_KEY = /(^|[^a-z0-9])auth([^a-z0-9]|$)/i;
const SENSITIVE_HEADER = /(authorization|cookie|token|secret|password|passwd|api[-_]?key|auth|session|signature|credential)/i;
const HOP_BY_HOP_HEADERS = Object.freeze([
  'connection', 'keep-alive', 'proxy-authenticate', 'proxy-authorization', 'te', 'trailer',
  'transfer-encoding', 'upgrade', 'content-length', 'content-encoding',
]);

/* ------------------------------------------------------------------ */
/* 通用小工具                                                          */
/* ------------------------------------------------------------------ */

export function truncateBytes(value, maxBytes) {
  const text = String(value ?? '');
  if (!Number.isFinite(maxBytes) || maxBytes <= 0) return '';
  if (Buffer.byteLength(text, 'utf8') <= maxBytes) return text;
  let lo = 0;
  let hi = text.length;
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2);
    if (Buffer.byteLength(text.slice(0, mid), 'utf8') <= maxBytes) lo = mid; else hi = mid - 1;
  }
  return text.slice(0, lo);
}

export function statusClass(status) {
  if (!Number.isInteger(status) || status <= 0) return null;
  if (status < 200) return '1xx';
  if (status < 300) return '2xx';
  if (status < 400) return '3xx';
  if (status < 500) return '4xx';
  return '5xx';
}

/** 12 hex 会话 HMAC（公开 valueHash）；`full:true` 返回完整 hex（内部 contentHash）。 */
export function hmacHex(key, value, { full = false } = {}) {
  const digest = createHmac('sha256', key || 'no-key').update(String(value), 'utf8').digest('hex');
  return full ? digest : digest.slice(0, 12);
}

/** 未脱敏 URL 的独立判等 hash（R1-9）。 */
export function urlHashOf(rawUrl) {
  return createHash('sha256').update(String(rawUrl ?? ''), 'utf8').digest('hex').slice(0, 16);
}

function clampInt(value, min, max) {
  if (!Number.isFinite(value)) return min;
  return Math.max(min, Math.min(Math.round(value), max));
}

/** §5.3 分位数：线性插值；样本 <2 时等于 max。 */
export function percentile(sorted, ratio) {
  if (!Array.isArray(sorted) || sorted.length === 0) return null;
  if (sorted.length === 1) return sorted[0];
  if (ratio <= 0) return sorted[0];
  if (ratio >= 1) return sorted[sorted.length - 1];
  const position = (sorted.length - 1) * ratio;
  const low = Math.floor(position);
  const high = Math.ceil(position);
  if (low === high) return sorted[low];
  const weight = position - low;
  return Math.round((sorted[low] * (1 - weight) + sorted[high] * weight) * 1000) / 1000;
}

export function sanitizeUrl(raw, maxBytes = NET_LIMITS.urlBytes) {
  const text = String(raw ?? '');
  if (text === '') return { value: '', applied: false };
  let value;
  try { value = redactUrl(text); } catch { value = redactText(text); }
  // Correlation ids in the query string are masked too (R1-9): an echo endpoint reflects them into
  // its body, so leaving the raw id in `event.url` would leak it into every export.
  value = maskQueryCorrelation(value);
  return { value: truncateBytes(value, maxBytes), applied: value !== text };
}

function maskQueryCorrelation(url) {
  const text = String(url || '');
  const index = text.indexOf('?');
  if (index === -1) return text;
  const head = text.slice(0, index);
  const tail = text.slice(index + 1);
  let changed = false;
  const masked = tail.split('&').map((pair) => {
    const eq = pair.indexOf('=');
    if (eq === -1) return pair;
    const name = pair.slice(0, eq);
    const value = pair.slice(eq + 1);
    if (value === '' || value === '***') return pair;
    if (CORRELATION_KEY.test(decodeOrSelf(name)) || AUTH_KEY.test(decodeOrSelf(name)) || SENSITIVE_KEY.test(decodeOrSelf(name))) {
      changed = true;
      return name + '=***';
    }
    return pair;
  }).join('&');
  return changed ? head + '?' + masked : text;
}

function decodeOrSelf(value) {
  try { return decodeURIComponent(value); } catch { return String(value); }
}

export function sanitizeHeaders(headers, { maxCount = NET_LIMITS.headerCount, maxValueBytes = NET_LIMITS.headerValueBytes } = {}) {
  const out = {};
  const applied = [];
  if (!headers || typeof headers !== 'object') return { headers: out, applied, truncated: false };
  const names = Object.keys(headers);
  let truncated = names.length > maxCount;
  for (const name of names.slice(0, maxCount)) {
    const raw = headers[name];
    const joined = Array.isArray(raw) ? raw.map((item) => String(item)).join(', ') : String(raw ?? '');
    const lower = name.toLowerCase();
    if (lower === 'set-cookie') {
      out[lower] = truncateBytes(joined.replace(/=[^;]*/g, '=***'), maxValueBytes);
      applied.push(lower);
      continue;
    }
    if (SENSITIVE_HEADER.test(lower) || CORRELATION_KEY.test(lower) || AUTH_KEY.test(lower)) {
      out[lower] = '***';
      applied.push(lower);
      continue;
    }
    const value = truncateBytes(joined, maxValueBytes);
    if (value.length < joined.length) truncated = true;
    out[lower] = value;
  }
  return { headers: out, applied, truncated };
}

/** 剥离 hop-by-hop / 会与改写后 body 冲突的头（R1-8）。 */
export function stripHopByHopHeaders(headers) {
  if (!headers || typeof headers !== 'object') return {};
  const out = {};
  for (const [name, value] of Object.entries(headers)) {
    if (HOP_BY_HOP_HEADERS.includes(name.toLowerCase())) continue;
    out[name] = value;
  }
  return out;
}

/**
 * §8.4 body 脱敏。返回 `{kind, text, redacted:'fields|none'|'omitted', parseError, bytes, payloadOmitted}`。
 * 二进制/无法安全解析的文本按 R1-9 标记 `omitted`（`available:true` 元数据仍可读）。
 */
export function sanitizeBody(raw, contentType, { maskRules = [] } = {}) {
  const type = String(contentType || '').toLowerCase();
  const base = { kind: 'text', text: '', redacted: 'none', parseError: false, bytes: 0, payloadOmitted: false };
  if (raw === undefined || raw === null) return base;
  const maskRulesList = Array.isArray(maskRules) ? maskRules : [];
  const masked = (key) => SENSITIVE_KEY.test(key) || CORRELATION_KEY.test(String(key)) || AUTH_KEY.test(String(key))
    || maskRulesList.some((rule) => String(rule).length > 0 && String(key).toLowerCase().endsWith(String(rule).toLowerCase()));
  if (Buffer.isBuffer(raw) || raw instanceof Uint8Array) {
    const buffer = Buffer.isBuffer(raw) ? raw : Buffer.from(raw);
    base.bytes = buffer.length;
    if (!type || /json|urlencoded|text|xml|javascript|html/.test(type)) {
      return sanitizeBody(buffer.toString('utf8'), contentType, { maskRules });
    }
    return { ...base, kind: 'binary', text: '', redacted: 'omitted', payloadOmitted: true };
  }
  const text = String(raw);
  base.bytes = Buffer.byteLength(text, 'utf8');
  if (/json/.test(type) || /^\s*[[{]/.test(text)) {
    let parsed;
    try { parsed = JSON.parse(text); } catch {
      return { ...base, kind: 'json', text: '', redacted: 'omitted', parseError: true, payloadOmitted: true };
    }
    const walk = (value, depth = 0) => {
      if (depth > 12) return value;
      if (Array.isArray(value)) return value.map((item) => walk(item, depth + 1));
      if (value && typeof value === 'object') {
        const out = {};
        for (const [key, item] of Object.entries(value)) out[key] = masked(key) ? '***' : walk(item, depth + 1);
        return out;
      }
      return value;
    };
    return { ...base, kind: 'json', text: JSON.stringify(walk(parsed)), redacted: 'fields' };
  }
  if (/x-www-form-urlencoded/.test(type)) {
    const pairs = text.split('&').filter((pair) => pair !== '');
    let redacted = false;
    const out = pairs.map((pair) => {
      const index = pair.indexOf('=');
      const key = index === -1 ? pair : pair.slice(0, index);
      if (index !== -1 && masked(decodeURIComponent(key.replace(/\+/g, ' ')))) { redacted = true; return key + '=***'; }
      return pair;
    });
    return { ...base, kind: 'urlencoded', text: out.join('&'), redacted: redacted ? 'fields' : 'none' };
  }
  if (/multipart\/form-data/.test(type)) {
    const fields = [];
    for (const part of text.split(/--[^\r\n]+/).slice(1)) {
      const nameMatch = /name="([^"]*)"/.exec(part);
      if (!nameMatch) continue;
      const fileMatch = /filename="([^"]*)"/.exec(part);
      const bodyStart = part.indexOf('\r\n\r\n');
      fields.push({
        name: nameMatch[1],
        size: bodyStart === -1 ? 0 : Buffer.byteLength(part.slice(bodyStart + 4).replace(/\r\n$/, ''), 'utf8'),
        ...(fileMatch ? { filename: fileMatch[1] } : {}),
      });
    }
    return { ...base, kind: 'multipart', text: JSON.stringify({ multipart: fields }), redacted: 'fields' };
  }
  if (/^text\/|xml|javascript|html|event-stream/.test(type) || type === '') {
    // Text (HTML/JS/plain) cannot be field-parsed, but an inline `token: "…"` constant must still
    // never leak (§8.4 / C45): scrub values that follow a sensitive-looking name.
    const scrubbed = scrubTextSecrets(text, maskRules);
    return {
      ...base,
      kind: 'text',
      text: truncateBytes(scrubbed.text, NET_LIMITS.detailBodyBytes),
      redacted: scrubbed.applied ? 'fields' : 'none',
    };
  }
  return { ...base, kind: 'binary', text: '', redacted: 'omitted', payloadOmitted: true };
}


/**
 * 文本 body 的"字段名→值"脱敏：HTML/JS/纯文本无法结构化解析时，只替换**敏感字段名**后面的值
 * （`name=…`、`name: …`、`"name":"…"`）。保守到不会碰普通词，避免 inline 常量泄漏（C45）。
 */
export function scrubTextSecrets(text, maskRules = []) {
  const raw = String(text ?? '');
  const extra = Array.isArray(maskRules) ? maskRules.map((rule) => String(rule)).filter(Boolean) : [];
  const esc = (value) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const namePattern = '(?:[A-Za-z0-9_$.-]*(?:token|secret|password|passwd|authorization|auth|cookie|api[-_]?key|session|credential)[A-Za-z0-9_$.-]*'
    + '|(?:x-)?(?:request|trace|correlation|span)[-_]?id'
    + (extra.length ? '|' + extra.map(esc).join('|') : '') + ')';
  const pattern = new RegExp('(' + namePattern + '\\s*[:=]\\s*)([\'"])([^\'"]{1,512})\\2', 'gi');
  let applied = false;
  const out = raw.replace(pattern, (match, prefix, quote) => {
    applied = true;
    return prefix + quote + '***' + quote;
  });
  return { text: out, applied };
}

/**
 * TOOL-P1-04：把一次 body 读取失败（`cdp.send` 抛出的 BrowserError / CDP 协议错误 / 传输错误）
 * 映射为稳定原因码。只读取 `code`/`message` 做匹配，返回值只有枚举本身，**不回显错误原文**；
 * `reasonDetail` 由 `normalizeBodyReasonDetail` 单独脱敏。未知/空输入一律 `cdp-unknown`。
 */
export function classifyBodyFailure(error) {
  if (error === undefined || error === null || error === '') return 'cdp-unknown';
  const code = typeof error === 'string' ? '' : String(error.code || '').toUpperCase();
  const message = typeof error === 'string' ? error : String(error.message || error || '');
  if (code === 'CDP_TIMEOUT' || code === 'NET_CONTROL_TIMEOUT' || /(?:timed?\s*out|timeout)/i.test(message)) return 'cdp-timeout';
  if (code === 'CDP_DISCONNECTED' || /(?:disconnect|connection (?:closed|lost)|not attached|target (?:closed|detached)|session (?:closed|detached))/i.test(message)) return 'cdp-disconnected';
  // Order matters: "No data found for resource with given identifier" means the buffered body was
  // dropped, not that the request id is unknown.
  if (/(?:no data found for resource|data (?:is )?(?:not|no longer) available|resource (?:was )?evicted|buffer(?:s|ing)? (?:evicted|dropped)|body (?:evicted|dropped|discarded))/i.test(message)) return 'cdp-evicted';
  if (/(?:no resource (?:with|for)|resource with given|request (?:id )?(?:not found|unknown)|unknown request)/i.test(message)) return 'cdp-no-resource';
  if (code === 'INVALID_ARGUMENT' || code === 'NET_INVALID_ARGUMENT' || /(?:invalid (?:params|parameters|argument))/i.test(message)) return 'cdp-invalid-params';
  if (typeof error.code === 'number') return error.code === -32602 ? 'cdp-invalid-params' : 'cdp-error';
  if (code === 'INTERNAL' || code === 'CDP_ERROR' || /(?:cdp error|protocol error|\[internal\])/i.test(message)) return 'cdp-error';
  return 'cdp-unknown';
}

/** `reasonCode` 归一化：省略/未知取值回落到 `cdp-unknown`，保持枚举稳定（不写入自造词）。 */
function normalizeBodyReasonCode(reasonCode) {
  if (reasonCode === undefined || reasonCode === null || reasonCode === '') return 'cdp-unknown';
  const value = String(reasonCode);
  return NET_BODY_REASON_CODES.includes(value) ? value : 'cdp-unknown';
}

/**
 * `reasonDetail`：单行、≤160 字节、脱敏（URL userinfo/敏感 query + 敏感字段值 + 控制字符）。
 * 空值/全空白 → null（不伪造占位文本）。
 */
export function normalizeBodyReasonDetail(reasonDetail, maskRules = []) {
  if (reasonDetail === undefined || reasonDetail === null) return null;
  let text = String(reasonDetail);
  if (text === '') return null;
  text = text.replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').trim();
  if (text === '') return null;
  const scrubbed = scrubTextSecrets(text, maskRules);
  // Text bodies only scrub quoted `name:"…"` values; an error detail may also carry bare
  // `name=value` pairs (e.g. `token=…` outside a URL), so mask those here too before bounding.
  const masked = scrubbed.text.replace(
    /((?:[A-Za-z0-9_$.-]*(?:token|secret|pass|passwd|authorization|auth|cookie|api[-_]?key|session|credential)[A-Za-z0-9_$.-]*)\s*[:=]\s*)([^\s,;&"']+)/gi,
    '$1***',
  );
  const bounded = truncateBytes(redactText(masked), 160).trim();
  return bounded === '' ? null : bounded;
}

export function bodyKindOf(contentType) {
  const type = String(contentType || '').toLowerCase();
  if (/json/.test(type)) return 'json';
  if (/x-www-form-urlencoded/.test(type)) return 'urlencoded';
  if (/multipart\/form-data/.test(type)) return 'multipart';
  if (/^text\/|xml|javascript|html/.test(type)) return 'text';
  if (type === '') return 'unknown';
  return 'binary';
}

export function parseQueryString(url) {
  const out = [];
  try {
    const parsed = new URL(String(url || ''));
    for (const [name, value] of parsed.searchParams.entries()) out.push({ name, value });
  } catch { /* 非法 URL 没有 query */ }
  return out;
}

export function readJsonPath(value, path) {
  if (typeof path !== 'string' || path === '') return { found: false, value: undefined };
  const tokens = [];
  const text = path.startsWith('$') ? path.slice(1) : path;
  const pattern = /([^.[\]]+)|\[(\d+)\]/g;
  let match;
  while ((match = pattern.exec(text)) !== null) {
    if (match[1] !== undefined) tokens.push(match[1]);
    else tokens.push(Number(match[2]));
  }
  let cursor = value;
  for (const token of tokens) {
    if (cursor === null || cursor === undefined) return { found: false, value: undefined };
    if (typeof token === 'number') {
      if (!Array.isArray(cursor) || token >= cursor.length) return { found: false, value: undefined };
      cursor = cursor[token];
    } else {
      if (typeof cursor !== 'object' || !(token in cursor)) return { found: false, value: undefined };
      cursor = cursor[token];
    }
  }
  return { found: true, value: cursor };
}

export function encodeCursor(seq) {
  if (!Number.isInteger(seq) || seq < 0) return null;
  return Buffer.from(JSON.stringify({ v: 1, seq }), 'utf8').toString('base64url');
}

export function decodeCursor(cursor) {
  if (cursor === undefined || cursor === null || cursor === '') return null;
  if (typeof cursor !== 'string' || cursor.length > 256) throw new BrowserError('NET_INVALID_ARGUMENT', 'cursor 不合法');
  let parsed;
  try { parsed = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')); } catch { throw new BrowserError('NET_INVALID_ARGUMENT', 'cursor 不合法'); }
  if (!parsed || parsed.v !== 1 || !Number.isInteger(parsed.seq) || parsed.seq < 0) throw new BrowserError('NET_INVALID_ARGUMENT', 'cursor 不合法');
  return parsed.seq;
}

export function matchUrlPattern(pattern, url) {
  if (typeof pattern !== 'string' || pattern === '') return false;
  const source = pattern.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.');
  try { return new RegExp('^' + source + '$', 'i').test(String(url ?? '')); } catch { return false; }
}

function assertKnownKeys(value, allowed, label, code = 'NET_INVALID_ARGUMENT') {
  if (value === undefined || value === null) return {};
  if (typeof value !== 'object' || Array.isArray(value)) throw new BrowserError(code, label + ' 必须是对象');
  for (const key of Object.keys(value)) {
    if (!allowed.includes(key)) throw new BrowserError(code, label + ' 含未知字段 ' + key, { field: key, allowed: [...allowed] });
  }
  return value;
}

/** 事件 JSON 估算字节（R1-15 的固定口径之一）。 */
export function estimateEventBytes(event) {
  try { return Buffer.byteLength(JSON.stringify(event), 'utf8'); } catch { return 0; }
}

/* ------------------------------------------------------------------ */
/* 会话配置（§2.1 + R1-19）                                             */
/* ------------------------------------------------------------------ */

const CONFIG_KEYS = Object.freeze(Object.keys(NET_DEFAULTS));

export function normalizeSessionConfig(input, base = NET_DEFAULTS) {
  const config = { ...base, maskRules: Array.isArray(base.maskRules) ? [...base.maskRules] : [] };
  if (input === undefined || input === null) return config;
  if (typeof input !== 'object' || Array.isArray(input)) throw new BrowserError('NET_CONFIG_INVALID', 'config 必须是对象');
  for (const key of Object.keys(input)) {
    if (!CONFIG_KEYS.includes(key)) throw new BrowserError('NET_CONFIG_INVALID', '未知的 config 字段 ' + key, { field: key, allowed: [...CONFIG_KEYS] });
  }
  for (const key of ['captureBodies', 'captureWebSocket', 'captureSse', 'captureWorkers']) {
    if (input[key] === undefined) continue;
    if (typeof input[key] !== 'boolean') throw new BrowserError('NET_CONFIG_INVALID', `${key} 必须是布尔值`, { field: key });
    config[key] = input[key];
  }
  for (const [key, min, max] of [
    ['maxEvents', 1, NET_LIMITS.maxEvents],
    ['maxBodyBytes', 1, NET_LIMITS.maxBodyBytes],
    ['maxTotalBytes', 1, NET_LIMITS.maxTotalBytes],
    ['maxWsFrames', 0, NET_LIMITS.maxWsFrames],
  ]) {
    if (input[key] === undefined) continue;
    if (!Number.isInteger(input[key])) throw new BrowserError('NET_CONFIG_INVALID', `${key} 必须是整数`, { field: key });
    if (input[key] < min || input[key] > max) {
      throw new BrowserError('NET_QUOTA_EXCEEDED', `${key} 超出允许上限 ${max}`, { field: key, min, max, value: input[key] });
    }
    config[key] = input[key];
  }
  if (input.businessStatusPath !== undefined && input.businessStatusPath !== null) {
    if (typeof input.businessStatusPath !== 'string' || input.businessStatusPath.length === 0 || input.businessStatusPath.length > 256) {
      throw new BrowserError('NET_CONFIG_INVALID', 'businessStatusPath 必须是 1–256 字符字符串', { field: 'businessStatusPath' });
    }
    config.businessStatusPath = input.businessStatusPath;
  }
  if (input.maskRules !== undefined && input.maskRules !== null) {
    if (!Array.isArray(input.maskRules) || input.maskRules.length > 16) {
      throw new BrowserError('NET_CONFIG_INVALID', 'maskRules 必须是最多 16 项的数组', { field: 'maskRules', max: 16 });
    }
    config.maskRules = input.maskRules.map((rule) => {
      if (typeof rule !== 'string' || rule.length === 0 || rule.length > 64) {
        throw new BrowserError('NET_CONFIG_INVALID', 'maskRules 每项必须是 1–64 字符字符串', { field: 'maskRules' });
      }
      return rule;
    });
  }
  return config;
}

/* ------------------------------------------------------------------ */
/* 事件规范化（§4.1 + R1-1 / R1-9 / R1-10）                             */
/* ------------------------------------------------------------------ */

export const EVENT_FIELDS = Object.freeze([
  'seq', 'sessionId', 'ts', 'kind', 'phase', 'requestId', 'parentRequestId', 'hopId',
  'targetId', 'cdpSessionId', 'frameId', 'loaderId', 'navId',
  'documentURL', 'url', 'urlHash', 'method', 'resourceType', 'protocol', 'fromCache',
  'status', 'statusText', 'mimeType', 'redirect', 'initiator', 'timing', 'sizes',
  'failed', 'errorText', 'errorCode', 'blockedReason', 'canceled', 'ws', 'sse', 'mark',
  'correlationIds', 'business', 'stepIds', 'stepId', 'evidenceIds', 'redaction', 'preSession',
  'attribution',
]);

/** 内部请求键 `(targetId, cdpSessionId, rawRequestId, hop)`（R1-10）。 */
export function requestKey(event) {
  const source = event || {};
  return [source.targetId ?? '', source.cdpSessionId ?? '', source.requestId ?? '', Number.isInteger(source.hopId) ? source.hopId : 0].join('\u0000');
}

function asString(value, maxBytes) {
  return value === undefined || value === null ? null : truncateBytes(String(value), maxBytes);
}

function asInt(value) {
  return Number.isInteger(value) ? value : null;
}

export function emptyTiming() {
  return {
    sendMs: null, waitMs: null, receiveMs: null, ttfbMs: null, totalMs: null,
    dnsMs: null, connectMs: null, sslMs: null, requestTimeMs: null, responseTimeMs: null,
  };
}

/**
 * CDP `response.timing` → §4.1 `timing`（R1-11 逐项定义，全部毫秒；负数/缺失 → null）。
 * `requestTime` 是 CDP 秒，`requestTimeMs = requestTime*1000`。
 */
export function normalizeTiming(timing, { responseSeconds = null } = {}) {
  const out = emptyTiming();
  // CDP 的 timing 各字段已是**毫秒**；`requestTime` 是**秒**（R1-11）。
  const ms = (value) => (Number.isFinite(value) && value >= 0 ? Math.round(value * 1000) / 1000 : null);
  const secondsToMs = (value) => (Number.isFinite(value) && value >= 0 ? Math.round(value * 1000 * 1000) / 1000 : null);
  const diff = (a, b) => (Number.isFinite(a) && Number.isFinite(b) && a >= 0 && b >= 0 && b >= a ? ms(b - a) : null);
  if (timing && typeof timing === 'object') {
    if (Number.isFinite(timing.requestTime)) out.requestTimeMs = secondsToMs(timing.requestTime);
    out.dnsMs = diff(timing.dnsStart, timing.dnsEnd);
    out.connectMs = diff(timing.connectStart, timing.connectEnd);
    out.sslMs = diff(timing.sslStart, timing.sslEnd);
    out.sendMs = diff(timing.sendStart, timing.sendEnd);
    const headersStart = Number.isFinite(timing.receiveHeadersStart) ? timing.receiveHeadersStart : null;
    if (headersStart !== null) {
      out.waitMs = diff(timing.sendEnd, headersStart);
      out.receiveMs = diff(headersStart, timing.receiveHeadersEnd);
      out.ttfbMs = ms(headersStart);
    }
  }
  if (Number.isFinite(responseSeconds)) {
    out.responseTimeMs = secondsToMs(responseSeconds);
    if (out.requestTimeMs !== null) out.totalMs = Math.round((out.responseTimeMs - out.requestTimeMs) * 1000) / 1000;
  }
  if (out.ttfbMs === null && out.waitMs !== null) out.ttfbMs = out.waitMs;
  return out;
}

export function normalizeSizes({ requestBody, responseBody, requestHeaders, responseHeaders, encoded, decoded } = {}) {
  const int = (value) => (Number.isInteger(value) && value >= 0 ? value : null);
  return {
    requestBody: int(requestBody),
    responseBody: int(responseBody),
    requestHeaders: int(requestHeaders),
    responseHeaders: int(responseHeaders),
    encoded: int(encoded),
    decoded: int(decoded),
  };
}

/**
 * §4.1 / §3.1 initiator. Chromium frequently leaves `initiator.url` empty (and the first stack frame
 * url empty too) for inline page scripts, so the page document URL is used as the attribution for
 * `type:"script"`-style initiators — that IS where the script ran. `source` records which fallback
 * produced the url so nothing is invented silently.
 */
export function normalizeInitiator(initiator, { documentURL = null } = {}) {
  if (!initiator || typeof initiator !== 'object') return null;
  const frames = initiator.stack && Array.isArray(initiator.stack.callFrames)
    ? initiator.stack.callFrames.slice(0, NET_LIMITS.initiatorStack).map((frame) => ({
      functionName: frame.functionName ? truncateBytes(frame.functionName, 128) : '',
      url: frame.url ? sanitizeUrl(frame.url).value : '',
      line: Number.isInteger(frame.lineNumber) ? frame.lineNumber : null,
      column: Number.isInteger(frame.columnNumber) ? frame.columnNumber : null,
    }))
    : [];
  const own = initiator.url ? sanitizeUrl(initiator.url).value : null;
  const frameUrl = frames.find((frame) => frame.url) ? frames.find((frame) => frame.url).url : null;
  const type = initiator.type ? String(initiator.type) : null;
  const pageUrl = documentURL ? sanitizeUrl(documentURL).value : null;
  let url = own;
  let source = own ? 'cdp' : null;
  if (!url && frameUrl) { url = frameUrl; source = 'stack'; }
  if (!url && pageUrl && ['script', 'parser', 'preflight'].includes(type)) { url = pageUrl; source = 'document'; }
  const firstFrame = frames[0] || null;
  return {
    type,
    url,
    line: Number.isInteger(initiator.lineNumber) ? initiator.lineNumber : (firstFrame ? firstFrame.line : null),
    column: Number.isInteger(initiator.columnNumber) ? initiator.columnNumber : (firstFrame ? firstFrame.column : null),
    requestId: initiator.requestId ? truncateBytes(String(initiator.requestId), 128) : null,
    source,
    stack: frames,
  };
}

function normalizeWs(ws) {
  const payloadRaw = ws.payload === undefined || ws.payload === null ? null : String(ws.payload);
  const payload = payloadRaw === null ? null : truncateBytes(payloadRaw, NET_LIMITS.wsPayloadBytes);
  return {
    direction: ws.direction === 'send' || ws.direction === 'receive' ? ws.direction : null,
    opcode: Number.isInteger(ws.opcode) ? ws.opcode : null,
    payload,
    payloadBytes: Number.isInteger(ws.payloadBytes) ? ws.payloadBytes
      : (payloadRaw === null ? null : Buffer.byteLength(payloadRaw, 'utf8')),
    payloadTruncated: ws.payloadTruncated === true || (payloadRaw !== null && Buffer.byteLength(payloadRaw, 'utf8') > NET_LIMITS.wsPayloadBytes),
    payloadOmitted: ws.payloadOmitted === true,
    url: ws.url ? sanitizeUrl(ws.url).value : null,
    protocol: ws.protocol ? truncateBytes(String(ws.protocol), 64) : null,
    handshake: ws.handshake && typeof ws.handshake === 'object' ? {
      status: asInt(ws.handshake.status),
      statusText: asString(ws.handshake.statusText, 128),
      headers: ws.handshake.headers ? sanitizeHeaders(ws.handshake.headers).headers : null,
    } : null,
    openedAt: Number.isFinite(ws.openedAt) ? ws.openedAt : null,
    closedAt: Number.isFinite(ws.closedAt) ? ws.closedAt : null,
    errorMessage: ws.errorMessage ? truncateBytes(redactText(String(ws.errorMessage)), NET_LIMITS.errorTextBytes) : null,
  };
}

function normalizeSse(sse) {
  const raw = sse.data === undefined || sse.data === null ? null : String(sse.data);
  const data = raw === null ? null : truncateBytes(raw, NET_LIMITS.sseDataBytes);
  return {
    eventName: sse.eventName ? truncateBytes(String(sse.eventName), 64) : null,
    eventId: sse.eventId ? truncateBytes(String(sse.eventId), 128) : null,
    data,
    dataBytes: raw === null ? null : Buffer.byteLength(raw, 'utf8'),
    truncated: sse.truncated === true || (raw !== null && Buffer.byteLength(raw, 'utf8') > NET_LIMITS.sseDataBytes),
    payloadOmitted: sse.payloadOmitted === true,
    retryMs: Number.isInteger(sse.retry) ? sse.retry : (Number.isInteger(sse.retryMs) ? sse.retryMs : null),
  };
}

function normalizeMark(mark) {
  return {
    kind: NET_MARK_KINDS.includes(mark.kind) ? mark.kind : 'note',
    text: mark.text ? truncateBytes(String(mark.text), 256) : null,
    tool: mark.tool ? truncateBytes(String(mark.tool), 64) : null,
    actionId: mark.actionId ? truncateBytes(String(mark.actionId), 64) : null,
    stepId: mark.stepId ? truncateBytes(String(mark.stepId), 64) : null,
    labels: mark.labels && typeof mark.labels === 'object'
      ? Object.fromEntries(Object.entries(mark.labels).slice(0, NET_LIMITS.stepLabels).map(([key, value]) => [truncateBytes(key, 64), truncateBytes(String(value), 128)]))
      : null,
    revision: Number.isInteger(mark.revision) ? mark.revision : null,
    url: mark.url ? sanitizeUrl(mark.url).value : null,
    title: mark.title ? truncateBytes(String(mark.title), 256) : null,
    wallMs: Number.isFinite(mark.wallMs) ? Math.round(mark.wallMs) : null,
    fromSeq: Number.isInteger(mark.fromSeq) ? mark.fromSeq : null,
    basis: mark.basis ? truncateBytes(String(mark.basis), 32) : null,
  };
}

/**
 * 补齐 §4.1 主干。meta: `{seq, sessionId, wallMs, monotonicMs, preSession?, hmacKey?}`。
 * `input.correlationIds[].contentHash` 只在本进程内用于同链路判等，不进事件本体（R1-9）。
 */
export function normalizeEvent(input, meta) {
  const source = input && typeof input === 'object' ? input : {};
  const replayTag = source.replay && typeof source.replay === 'object' ? { ...source.replay } : null;
  const ts = source.ts && typeof source.ts === 'object' ? ts_of(source.ts) : {};
  const url = sanitizeUrl(source.url);
  const documentURL = sanitizeUrl(source.documentURL);
  const applied = [];
  if (url.applied) applied.push('url');
  if (documentURL.applied) applied.push('documentURL');
  const rules = [];
  if (source.redaction && Array.isArray(source.redaction.rules)) rules.push(...source.redaction.rules.map((rule) => truncateBytes(String(rule), 64)));
  const redirect = source.redirect && typeof source.redirect === 'object'
    ? {
      from: sanitizeUrl(source.redirect.from).value,
      to: sanitizeUrl(source.redirect.to).value,
      status: asInt(source.redirect.status),
      fromSeq: Number.isInteger(source.redirect.fromSeq) ? source.redirect.fromSeq : null,
      toSeq: Number.isInteger(source.redirect.toSeq) ? source.redirect.toSeq : null,
    }
    : null;
  const bodyMode = source.redaction && source.redaction.body
    ? (source.redaction.body === 'fields' ? 'fields' : source.redaction.body === 'omitted' ? 'omitted' : 'none')
    : 'none';
  const correlationKey = meta.hmacKey || 'no-key';
  const correlationIds = Array.isArray(source.correlationIds)
    ? source.correlationIds.slice(0, NET_LIMITS.correlationRules).map((item) => {
      const raw = item && item.value !== undefined && item.value !== null ? String(item.value) : null;
      const contentHash = item && item.contentHash ? String(item.contentHash) : (raw === null ? null : hmacHex(correlationKey, raw, { full: true }));
      return {
        name: truncateBytes(String(item && item.name ? item.name : ''), 64),
        // §5.6/R1-9: the raw correlation value never enters an event, an export or a search hit —
        // only the per-session HMAC (`valueHash`, 12 hex) survives, which is enough to group a
        // trace without leaking the id.
        value: raw === null ? null : '***',
        valueHash: contentHash === null ? null : contentHash.slice(0, 12),
        source: item && item.source ? truncateBytes(String(item.source), 32) : null,
        contentHash,
      };
    })
    : [];
  return {
    ...(replayTag ? { replay: replayTag } : {}),
    seq: meta.seq,
    sessionId: meta.sessionId === undefined ? null : meta.sessionId,
    ts: {
      wallMs: Number.isFinite(ts.wallMs) ? Math.round(ts.wallMs) : meta.wallMs,
      monotonicMs: Number.isFinite(ts.monotonicMs) ? Math.round(ts.monotonicMs * 1000) / 1000 : meta.monotonicMs,
      cdpSeconds: Number.isFinite(ts.cdpSeconds) ? ts.cdpSeconds : null,
    },
    kind: NET_KINDS.includes(source.kind) ? source.kind : 'http',
    phase: NET_PHASES.includes(source.phase) ? source.phase : 'request',
    requestId: asString(source.requestId, 128),
    parentRequestId: asString(source.parentRequestId, 128),
    hopId: Number.isInteger(source.hopId) ? source.hopId : null,
    targetId: asString(source.targetId, 128),
    cdpSessionId: asString(source.cdpSessionId, 128),
    frameId: asString(source.frameId, 128),
    loaderId: asString(source.loaderId, 128),
    navId: Number.isInteger(source.navId) ? source.navId : null,
    documentURL: documentURL.value || null,
    url: url.value,
    urlHash: source.urlHash ? truncateBytes(String(source.urlHash), 32) : urlHashOf(source.url),
    method: source.method ? truncateBytes(String(source.method), 16) : null,
    resourceType: source.resourceType ? truncateBytes(String(source.resourceType), 32) : null,
    protocol: asString(source.protocol, 32),
    fromCache: source.fromCache === true,
    status: asInt(source.status),
    statusText: asString(source.statusText, 128),
    mimeType: asString(source.mimeType, 128),
    redirect,
    initiator: normalizeInitiator(source.initiator, { documentURL: documentURL.value || null }) || null,
    timing: source.timing && typeof source.timing === 'object' ? { ...emptyTiming(), ...pickTiming(source.timing) } : null,
    sizes: normalizeSizes(source.sizes || {}),
    failed: source.failed === true,
    errorText: source.errorText ? truncateBytes(redactText(String(source.errorText)), NET_LIMITS.errorTextBytes) : null,
    errorCode: source.errorCode ? truncateBytes(String(source.errorCode), 64) : null,
    blockedReason: source.blockedReason ? truncateBytes(String(source.blockedReason), 128) : null,
    canceled: source.canceled === true,
    ws: source.ws && typeof source.ws === 'object' ? normalizeWs(source.ws) : null,
    sse: source.sse && typeof source.sse === 'object' ? normalizeSse(source.sse) : null,
    mark: source.mark && typeof source.mark === 'object' ? normalizeMark(source.mark) : null,
    correlationIds: correlationIds.map(({ contentHash, ...rest }) => rest),
    business: source.business && typeof source.business === 'object' ? {
      statusCode: asInt(source.business.statusCode),
      businessCode: source.business.businessCode === undefined || source.business.businessCode === null
        ? null
        : (Number.isFinite(source.business.businessCode) ? source.business.businessCode : truncateBytes(String(source.business.businessCode), 64)),
      businessCodePath: asString(source.business.businessCodePath, 256),
    } : null,
    stepIds: Array.isArray(source.stepIds) ? source.stepIds.slice(0, 16).map((id) => truncateBytes(String(id), 64))
      : (source.stepId ? [truncateBytes(String(source.stepId), 64)] : []),
    stepId: source.stepId ? truncateBytes(String(source.stepId), 64) : null,
    evidenceIds: Array.isArray(source.evidenceIds) ? source.evidenceIds.slice(0, 16).map((id) => truncateBytes(String(id), 128)) : [],
    redaction: { applied, rules, body: bodyMode },
    preSession: meta.preSession === true || source.preSession === true,
    // R1-21: a child-target event proves its scope by being attached to *this* Runtime's page
    // session. `null` for main-page events.
    attribution: source.attribution ? truncateBytes(String(source.attribution), 32) : null,
  };
}

function ts_of(ts) {
  return { wallMs: ts.wallMs, monotonicMs: ts.monotonicMs, cdpSeconds: ts.cdpSeconds };
}

function pickTiming(timing) {
  const out = {};
  for (const key of Object.keys(emptyTiming())) {
    const value = timing[key];
    out[key] = Number.isFinite(value) && value >= 0 ? value : null;
  }
  return out;
}

/** 事件的 correlation contentHash 索引数据（normalizeEvent 会剥掉，store 单独保留）。 */
export function correlationContentHashes(input, hmacKey) {
  const list = input && Array.isArray(input.correlationIds) ? input.correlationIds : [];
  return list.map((item) => {
    if (!item) return null;
    if (item.contentHash) return String(item.contentHash);
    if (item.value === undefined || item.value === null || item.value === '***') return null;
    return hmacHex(hmacKey, String(item.value), { full: true });
  }).filter(Boolean);
}

/* ------------------------------------------------------------------ */
/* 存储（§4.2 / §4.3 + R1-2 / R1-10 / R1-15 / R1-16）                   */
/* ------------------------------------------------------------------ */

export function emptyCounters() {
  return {
    events: 0, http: 0, ws: 0, sse: 0, markers: 0,
    failures: 0, httpErrors: 0, redirects: 0,
    bodies: 0, bodiesUnavailable: 0, bodyEmpty: 0, bytes: 0,
    evicted: 0, dropped: 0, bodyEvicted: 0, truncated: 0, wsFrames: 0, subscribers: 0,
  };
}

/** 归属字段的字符预算（id 截断而非猜测）。 */
const ATTRIBUTION_BYTES = 128;

function normalizeAttributionValue(value) {
  if (value === undefined || value === null || value === '') return null;
  const text = typeof value === 'string' ? value : (typeof value === 'number' && Number.isFinite(value) ? String(value) : null);
  if (text === null) return null;
  return truncateBytes(text, ATTRIBUTION_BYTES) || null;
}

/**
 * TOOL-P1-04 会话归属：`{scopeId, runtimeId, tabId}`。缺失字段一律 `null`；不从 cdpSessionId/
 * targetId 反推 tabId（不猜）。构造器给了 `scopeId` 时它是已知事实，作为 attribution.scopeId 回传。
 */
function normalizeAttribution(input, scopeId = null) {
  const out = { scopeId: normalizeAttributionValue(scopeId), runtimeId: null, tabId: null };
  if (input && typeof input === 'object' && !Array.isArray(input)) {
    for (const key of ['scopeId', 'runtimeId', 'tabId']) {
      if (Object.prototype.hasOwnProperty.call(input, key)) out[key] = normalizeAttributionValue(input[key]);
    }
  }
  return out;
}

/** 只读投影：给 `#sessionView` / `status()` / `evidenceBlock` 共用，保证三处形状一致。 */
function attributionView(store) {
  const source = store && store.attribution ? store.attribution : null;
  if (source) return { scopeId: source.scopeId ?? null, runtimeId: source.runtimeId ?? null, tabId: source.tabId ?? null };
  const scopeId = store && store.scopeId !== undefined && store.scopeId !== null ? normalizeAttributionValue(store.scopeId) : null;
  return { scopeId, runtimeId: null, tabId: null };
}

export class NetworkStore {
  constructor({ scopeId = null, now = () => Date.now(), monotonic, attribution = null } = {}) {
    this.scopeId = scopeId;
    this.attribution = normalizeAttribution(attribution, scopeId);
    this.now = typeof now === 'function' ? now : () => Date.now();
    this.monotonic = typeof monotonic === 'function' ? monotonic : () => Number(process.hrtime.bigint() / 1000n) / 1000;
    this.config = normalizeSessionConfig(null);
    this.state = null;
    this.session = null;
    this.sessions = [];
    this.preSession = [];
    this.seq = 0;
    this.events = [];
    this.chains = new Map();
    this.hops = new Map();
    this.bodies = new Map();
    /** TOOL-P1-04：读不到 body 时的原因记录（与 `bodies` 分开，避免污染导出/计数/配额口径）。 */
    this.bodyFailures = new Map();
    this.headers = new Map();
    this.bodyBytes = 0;
    this.headerBytes = 0;
    this.eventBytes = 0;
    this.evictedSeqs = [];
    this.dropRanges = [];
    this.steps = new Map();
    this.links = new Map();
    this.artifacts = new Map();
    this.subscriptions = new Map();
    this.correlationIndex = new Map();
    this.corrHashes = new Map();
    this.anchors = new Map();
    this.droppedByReason = Object.create(null);
    this.counters = emptyCounters();
    this.issues = [];
    this.cdpDisconnected = false;
    this.hmacKey = randomBytes(16).toString('hex');
    this.everStarted = false;
    this.sessionSeq = 0;
  }

  /* ---------------- 时间锚点（R1-11） ---------------- */

  /** 用 target 首次 `requestWillBeSent.wallTime` 锚点把 CDP 秒换算成墙钟毫秒。 */
  setAnchor(targetId, cdpSeconds, wallMs) {
    if (targetId === null || targetId === undefined || !Number.isFinite(cdpSeconds)) return;
    if (this.anchors.has(targetId)) return;
    this.anchors.set(targetId, { cdpSeconds, wallMs: Number.isFinite(wallMs) ? wallMs : this.now() });
  }

  wallMsFor(targetId, cdpSeconds) {
    const anchor = this.anchors.get(targetId);
    if (anchor && Number.isFinite(cdpSeconds)) return Math.round(anchor.wallMs + (cdpSeconds - anchor.cdpSeconds) * 1000);
    if (anchor && Number.isFinite(anchor.wallMs)) return Math.round(anchor.wallMs);
    return this.now();
  }

  /* ---------------- 会话 ---------------- */

  start({ name = 'default', config = null } = {}) {
    const sessionName = truncateBytes(String(name ?? 'default'), 64) || 'default';
    if (this.state === 'running' && this.session) {
      if (this.session.name === sessionName) return { changed: false, session: this.#sessionView() };
      throw new BrowserError('NET_SESSION_ACTIVE', '另一个采集会话正在运行', { running: this.session.name, requested: sessionName });
    }
    this.config = normalizeSessionConfig(config);
    this.hmacKey = randomBytes(16).toString('hex');
    this.#beginSession('running', sessionName);
    // §3.4: events seen while no session was running live in the 200-entry candidate buffer and are
    // promoted on start with `preSession:true` (the new session still numbers its sequence from 1).
    this.sessionSeq = 0;
    const pending = this.preSession.splice(0, this.preSession.length);
    this.everStarted = true;
    for (const partial of pending) this.#append({ ...partial, preSession: true });
    return { changed: true, session: this.#sessionView() };
  }

  #beginSession(state, name, { source = null } = {}) {
    if (this.session) {
      this.session.state = 'stopped';
      this.session.stoppedAt = this.session.stoppedAt ?? this.now();
      this.session.retained = false;
      this.sessions.unshift({
        session: { ...this.session, counters: { ...this.counters } },
        retained: false,
      });
      while (this.sessions.length > NET_LIMITS.sessionsRetained) this.sessions.pop();
    }
    this.#clearData();
    this.state = state;
    this.session = {
      id: 'net-' + randomBytes(4).toString('hex'),
      name,
      state,
      startedAt: this.now(),
      stoppedAt: null,
      retained: true,
      source,
      config: { ...this.config },
    };
  }

  #clearData() {
    this.seq = 0;
    this.events = [];
    this.chains.clear();
    this.hops.clear();
    this.bodies.clear();
    this.bodyFailures.clear();
    this.headers.clear();
    this.bodyBytes = 0;
    this.headerBytes = 0;
    this.eventBytes = 0;
    this.evictedSeqs = [];
    this.dropRanges = [];
    this.steps.clear();
    this.links.clear();
    this.correlationIndex.clear();
    this.corrHashes.clear();
    this.anchors.clear();
    this.droppedByReason = Object.create(null);
    this.counters = emptyCounters();
    this.issues = [];
  }

  stop() {
    if (this.state === 'running' && this.session) {
      this.state = 'stopped';
      this.session.state = 'stopped';
      this.session.stoppedAt = this.now();
    }
    // R1-9：会话关闭清零 HMAC 密钥（已写入的 hash 不再可逆用于关联）
    this.hmacKey = randomBytes(16).toString('hex');
    return { changed: false, session: this.session ? this.#sessionView() : null };
  }

  /** `reset`：清数据并关闭本 scope 全部订阅（R1-2），不删磁盘证据。 */
  reset() {
    const closed = this.subscriptions.size;
    this.subscriptions.clear();
    this.#clearData();
    return { reset: true, subscriptionsClosed: closed, session: this.session ? this.#sessionView() : null };
  }

  #sessionView() {
    return {
      id: this.session.id,
      name: this.session.name,
      state: this.state,
      // TOOL-P1-04：会话归属（缺失为 null，不从 cdpSessionId/targetId 反推 tabId）。
      attribution: attributionView(this),
      startedAt: this.session.startedAt,
      stoppedAt: this.session.stoppedAt,
      config: { ...this.config },
      counters: {
        ...this.counters,
        // `seq` counts the events THIS session itself produced; promoted candidates keep their
        // stored seq but are not part of the new session's own numbering (they are reported by
        // `preSession`). `highWater` is the honest highest stored seq.
        seq: this.sessionSeq,
        highWater: this.seq,
        subscribers: this.subscriptions.size,
        // Promoted candidate events (§3.4) are counted here as well as in `events`.
        preSession: this.events.filter((event) => event.preSession === true).length,
      },
      integrity: this.integrity(),
    };
  }

  /**
   * TOOL-P1-04：更新会话归属 `{scopeId,runtimeId,tabId}`。
   * - `setAttribution(null)` 重置为 `{scopeId:构造器 scopeId, runtimeId:null, tabId:null}`；
   * - 传对象时只覆盖显式给出的字段（显式 `null`/`''` 清空该字段），缺失字段保持不变——供切 tab
   *   时只更新 `tabId`；任何字段都不推测。
   */
  setAttribution(input = null) {
    if (input === null || input === undefined) {
      this.attribution = normalizeAttribution(null, this.scopeId);
      return { attribution: attributionView(this) };
    }
    const current = attributionView(this);
    const next = { ...current };
    if (typeof input === 'object' && !Array.isArray(input)) {
      for (const key of ['scopeId', 'runtimeId', 'tabId']) {
        if (Object.prototype.hasOwnProperty.call(input, key)) next[key] = normalizeAttributionValue(input[key]);
      }
    }
    this.attribution = next;
    return { attribution: attributionView(this) };
  }

  status() {
    return {
      // TOOL-P1-04：会话归属与当前会话视图同源，status.session.attribution 与顶层一致。
      attribution: attributionView(this),
      session: this.session ? this.#sessionView() : null,
      sessions: this.sessions.map((entry) => ({
        id: entry.session.id, name: entry.session.name, state: entry.session.state,
        startedAt: entry.session.startedAt, stoppedAt: entry.session.stoppedAt,
        counters: { ...entry.session.counters }, retained: entry.retained === true,
      })),
      limits: limitsView(),
      subscriptions: this.subscriptions.size,
    };
  }

  get running() { return this.state === 'running'; }
  get highWater() { return this.seq; }
  get sessionId() { return this.session ? this.session.id : null; }

  /* ---------------- 摄入 ---------------- */

  dropEvent(reason, count = 1) {
    this.counters.dropped += count;
    this.droppedByReason[reason] = (this.droppedByReason[reason] || 0) + count;
    this.dropRanges.push({ from: this.seq + 1, to: this.seq + count, count, reason });
    if (this.dropRanges.length > 256) this.dropRanges.shift();
    if (!this.issues.includes('events-dropped')) this.issues.push('events-dropped');
  }

  noteBodyUnavailable(count = 1) {
    this.counters.bodiesUnavailable += count;
    if (!this.issues.includes('body-unavailable')) this.issues.push('body-unavailable');
  }

  noteBodyEmpty(count = 1) { this.counters.bodyEmpty += count; }

  add(input) {
    if (this.state !== 'running') {
      if (this.state === 'snapshot') return null;
      this.preSession.push(input);
      while (this.preSession.length > NET_LIMITS.preSessionEvents) this.preSession.shift();
      return null;
    }
    const kind = input && input.kind ? input.kind : 'http';
    if (kind === 'ws') {
      if (!this.config.captureWebSocket) { this.dropEvent('capture-disabled:websocket'); return null; }
      if (input.phase === 'ws-send' || input.phase === 'ws-receive') {
        if (this.counters.wsFrames >= this.config.maxWsFrames) { this.dropEvent('ws-frame-quota'); return null; }
        this.counters.wsFrames += 1;
      }
    } else if (kind === 'sse') {
      if (!this.config.captureSse) { this.dropEvent('capture-disabled:sse'); return null; }
    }
    return this.#append(input);
  }

  /** 重放窗口（control.replay 设置）：同 URL 事件在窗口内带 `replay` 标记（C40）。 */
  replayWindow = null;

  #append(rawInput) {
    if (rawInput && rawInput.replay === undefined && this.replayWindow
      && Date.now() <= this.replayWindow.until && rawInput.url
      && (String(rawInput.url) === String(this.replayWindow.url || '')
        || String(rawInput.url).startsWith(String(this.replayWindow.prefix || '\u0000')))) {
      rawInput = { ...rawInput, replay: { by: this.replayWindow.by || 'control.replay', sinceMs: this.replayWindow.at, basis: 'observed' } };
    }
    const isPreSession = rawInput && rawInput.preSession === true;
    this.seq += 1;
    // Only this session's own events advance `sessionSeq` (C34 restart reads counters.seq).
    if (!isPreSession) this.sessionSeq = (this.sessionSeq || 0) + 1;
    const hashes = correlationContentHashes(rawInput, this.hmacKey);
    const event = normalizeEvent(rawInput, {
      seq: this.seq,
      sessionId: this.session ? this.session.id : null,
      wallMs: this.now(),
      monotonicMs: this.monotonic(),
      preSession: rawInput && rawInput.preSession === true,
      hmacKey: this.hmacKey,
    });
    this.events.push(event);
    this.eventBytes += estimateEventBytes(event);
    this.counters.events += 1;
    if (event.kind === 'http') this.counters.http += 1;
    if (event.failed) this.counters.failures += 1;
    if (Number.isInteger(event.status) && event.status >= 400) this.counters.httpErrors += 1;
    if (event.phase === 'redirect') this.counters.redirects += 1;
    else if (event.kind === 'ws') this.counters.ws += 1;
    else if (event.kind === 'sse') this.counters.sse += 1;
    else this.counters.markers += 1;
    if (hashes.length) this.corrHashes.set(event.seq, hashes);
    for (const hash of hashes) {
      const list = this.correlationIndex.get(hash) || [];
      list.push(event.seq);
      this.correlationIndex.set(hash, list);
    }
    this.#noteChain(event);
    this.#enforceQuota();
    if (event.preSession && !this.issues.includes('import-partial')) this.issues.push('import-partial');
    return event;
  }

  /** §4.2 淘汰：先 body（bodyEvicted），仍超预算再淘汰最旧事件（evicted）。 */
  #enforceQuota() {
    while (this.events.length > this.config.maxEvents) this.#evictOldestEvent('max-events');
    while (this.accountedBytes() > this.config.maxTotalBytes && this.bodies.size > 0) {
      const oldestKey = this.bodies.keys().next().value;
      const record = this.bodies.get(oldestKey);
      this.bodies.delete(oldestKey);
      this.bodyBytes -= record.buffer.length;
      this.counters.bodyEvicted += 1;
      if (!this.issues.includes('bodies-evicted')) this.issues.push('bodies-evicted');
      // TOOL-P1-04：淘汰后 detail 仍能回答"为什么读不到"——reasonCode 是 `cdp-evicted`（本地
      // 配额淘汰），而不是笼统的 unavailable。原因记录不占字节、不改事件保留。
      this.#rememberBodyFailure(oldestKey, { ...record, reasonCode: 'cdp-evicted', reasonDetail: null });
    }
    while (this.accountedBytes() > this.config.maxTotalBytes && this.events.length > 1) this.#evictOldestEvent('max-total-bytes');
  }

  #evictOldestEvent(reason) {
    const evicted = this.events.shift();
    if (!evicted) return;
    this.evictedSeqs.push(evicted.seq);
    if (this.evictedSeqs.length > 4096) this.evictedSeqs.shift();
    this.counters.evicted += 1;
    this.eventBytes -= estimateEventBytes(evicted);
    if (this.eventBytes < 0) this.eventBytes = 0;
    this.#dropFromChains(evicted);
    if (!this.issues.includes('events-evicted')) this.issues.push('events-evicted');
    void reason;
  }

  #noteChain(event) {
    if (!event.requestId) return;
    const key = requestKey(event);
    const chain = this.chains.get(key) || {
      key, requestId: event.requestId, hopId: Number.isInteger(event.hopId) ? event.hopId : 0,
      targetId: event.targetId, cdpSessionId: event.cdpSessionId,
      seqs: [], hops: [], firstSeq: event.seq, lastSeq: event.seq,
      method: null, url: null, status: null, failed: false, kind: event.kind,
      requestSeq: null, responseSeq: null, finishedSeq: null, endState: null,
    };
    chain.seqs.push(event.seq);
    chain.lastSeq = event.seq;
    if (event.method) chain.method = event.method;
    if (event.url) chain.url = event.url;
    if (Number.isInteger(event.status)) chain.status = event.status;
    if (event.failed) { chain.failed = true; chain.endState = 'failed'; }
    if (event.phase === 'request') chain.requestSeq = event.seq;
    if (event.phase === 'response') { chain.responseSeq = event.seq; chain.endState = 'response'; }
    if (event.phase === 'finished') { chain.finishedSeq = event.seq; chain.endState = 'finished'; }
    if (event.redirect) {
      chain.hops.push({
        hopId: chain.hopId, requestId: event.requestId, url: event.redirect.to,
        status: event.redirect.status, fromUrl: event.redirect.from, seq: event.seq,
      });
      if (chain.hops.length > NET_LIMITS.redirectChain) chain.hops = chain.hops.slice(-NET_LIMITS.redirectChain);
    }
    this.chains.set(key, chain);
    const hopList = this.hops.get(event.requestId) || [];
    if (!hopList.includes(key)) hopList.push(key);
    this.hops.set(event.requestId, hopList);
  }

  #dropFromChains(event) {
    if (!event.requestId) return;
    const key = requestKey(event);
    const chain = this.chains.get(key);
    if (!chain) return;
    chain.seqs = chain.seqs.filter((seq) => seq !== event.seq);
    if (chain.seqs.length === 0) {
      this.chains.delete(key);
      const hopList = (this.hops.get(event.requestId) || []).filter((item) => item !== key);
      if (hopList.length === 0) this.hops.delete(event.requestId); else this.hops.set(event.requestId, hopList);
    } else {
      chain.firstSeq = chain.seqs[0];
    }
  }

  /** R1-15 近似字节口径（公开、固定）。 */
  estimateBytes() {
    return {
      events: this.eventBytes,
      headers: this.headerBytes,
      bodies: this.bodyBytes,
      pins: this.pinnedBytes(),
      preSession: this.preSession.length,
      formula: 'events(JSON utf8) + headers(JSON utf8) + bodies(raw) + pinnedEvents(count) + preSessionEvents(count)',
    };
  }

  accountedBytes() {
    return this.eventBytes + this.headerBytes + this.bodyBytes + this.pinnedBytes() + this.preSession.length;
  }

  pinnedBytes() {
    let pinned = 0;
    for (const subscription of this.subscriptions.values()) {
      pinned += Math.min(Math.max(0, this.seq - subscription.ackedSeq), NET_LIMITS.subscriptionPin);
    }
    return pinned;
  }

  /** 淘汰后重建链与关联索引（导入 / 恢复用）。 */
  rebuildChains() {
    this.chains.clear();
    this.hops.clear();
    this.correlationIndex.clear();
    this.corrHashes.clear();
    this.eventBytes = 0;
    for (const event of this.events) {
      this.eventBytes += estimateEventBytes(event);
      this.#noteChain(event);
    }
  }

  /* ---------------- headers / bodies ---------------- */

  #key(kind, { targetId = null, cdpSessionId = null, requestId = null, hopId = null } = {}) {
    return [targetId ?? '', cdpSessionId ?? '', requestId ?? '', Number.isInteger(hopId) ? hopId : 0, kind].join('\u0000');
  }

  setHeaders({ targetId = null, cdpSessionId = null, requestId = null, hopId = null, kind = 'response', headers = {} } = {}) {
    if (!requestId) return null;
    const safe = sanitizeHeaders(headers);
    const key = this.#key(kind, { targetId, cdpSessionId, requestId, hopId });
    const previous = this.headers.get(key);
    if (previous) this.headerBytes -= previous.bytes;
    const bytes = Buffer.byteLength(JSON.stringify(safe.headers), 'utf8');
    this.headers.set(key, { ...safe, bytes, at: this.now() });
    this.headerBytes += bytes;
    return { names: Object.keys(safe.headers).length, applied: safe.applied };
  }

  readHeaders({ targetId = null, cdpSessionId = null, requestId = null, hopId = null, kind = 'response' } = {}) {
    const record = this.headers.get(this.#key(kind, { targetId, cdpSessionId, requestId, hopId }));
    return record
      ? { headers: record.headers, applied: record.applied, truncated: record.truncated, at: record.at }
      : { headers: {}, applied: [], truncated: false, at: null };
  }

  /**
   * body 三态（R1-11）：`captured`（有内容）/`empty`（合法空体，如 HEAD/204/304/GET 无 postData）/
   * `unavailable`（失败、缓存、重定向中途、已淘汰）。`payloadOmitted` 表示二进制或无法安全解析。
   *
   * TOOL-P1-04：`unavailable` 必须带稳定原因码（`reasonCode`，见 `NET_BODY_REASON_CODES`）与可选
   * 脱敏细节（`reasonDetail` ≤160 字节）。原因记录与真实 body 分表存储，不进入 body 配额/计数/
   * JSONL/HAR 口径；读取仍是纯只读（不补抓、不重试、不伪造）。
   */
  addBody({ targetId = null, cdpSessionId = null, requestId = null, hopId = null, kind = 'response', state = 'captured', data = '', base64Encoded = false, contentType = null, redacted = 'none', payloadOmitted = false, reasonCode = null, reasonDetail = null } = {}) {
    if (!requestId) return null;
    const key = this.#key(kind, { targetId, cdpSessionId, requestId, hopId });
    if (state === 'unavailable') {
      this.noteBodyUnavailable();
      const code = normalizeBodyReasonCode(reasonCode);
      const detail = normalizeBodyReasonDetail(reasonDetail, this.config.maskRules);
      // The latest attempt is authoritative: an earlier captured/empty record for the same request
      // key must not outlive a later proven failure (otherwise the reason would be silently lost).
      const previous = this.bodies.get(key);
      if (previous) {
        this.bodies.delete(key);
        this.bodyBytes -= previous.buffer.length;
      }
      this.#rememberBodyFailure(key, {
        requestId, targetId, cdpSessionId, hopId, kind, reasonCode: code, reasonDetail: detail,
      });
      return { state: 'unavailable', bytes: null, reasonCode: code, reasonDetail: detail };
    }
    if (state === 'empty') {
      this.noteBodyEmpty();
      this.bodyFailures.delete(key);
      this.bodies.set(key, {
        requestId: String(requestId), targetId, cdpSessionId, hopId, kind, state: 'empty',
        buffer: Buffer.alloc(0), originalBytes: 0, truncated: false, base64Encoded: false,
        contentType, redacted: 'none', payloadOmitted: false, storedAt: this.now(),
      });
      if (this.state === 'running') this.counters.bodies += 1;
      return { state: 'empty', bytes: 0 };
    }
    if (!this.config.captureBodies) return null;
    let buffer = Buffer.isBuffer(data) ? data : Buffer.from(String(data ?? ''), base64Encoded ? 'base64' : 'utf8');
    const originalBytes = buffer.length;
    let truncated = false;
    if (buffer.length > this.config.maxBodyBytes) {
      buffer = buffer.subarray(0, this.config.maxBodyBytes);
      truncated = true;
      if (this.state === 'running') this.counters.truncated += 1;
      if (!this.issues.includes('bodies-truncated')) this.issues.push('bodies-truncated');
    }
    const previous = this.bodies.get(key);
    if (previous) this.bodyBytes -= previous.buffer.length;
    this.bodies.delete(key);
    this.bodyFailures.delete(key);
    this.bodies.set(key, {
      requestId: String(requestId), targetId, cdpSessionId, hopId, kind, state: 'captured',
      buffer, originalBytes, truncated, base64Encoded: base64Encoded === true, contentType,
      redacted: redacted === 'fields' ? 'fields' : redacted === 'omitted' ? 'omitted' : 'none',
      payloadOmitted: payloadOmitted === true, storedAt: this.now(),
    });
    this.bodyBytes += buffer.length;
    // `stop` freezes every session counter: a body recorded for a non-running session must not
    // move `bodies`/`bytes` (events buffered while stopped are counted by `preSession`).
    if (this.state === 'running') this.counters.bodies += 1;
    this.#enforceQuota();
    if (this.state === 'running') this.counters.bytes = this.bodyBytes;
    return { state: 'captured', bytes: buffer.length, originalBytes, truncated, payloadOmitted: payloadOmitted === true };
  }

  bodyRecord({ targetId = null, cdpSessionId = null, requestId = null, hopId = null, kind = 'response' } = {}) {
    const key = this.#key(kind, { targetId, cdpSessionId, requestId, hopId });
    return this.bodies.get(key) || this.bodyFailures.get(key) || null;
  }

  /** 只读（不补抓、不启动 CDP，§2.3 / R1-11）。不可得时回放原因码，仍不读取页面/网络。 */
  readBody(options = {}, { maxBytes = NET_LIMITS.detailBodyBytes } = {}) {
    const record = this.bodyRecord(options);
    if (!record) return null;
    if (record.state === 'unavailable') {
      return {
        kind: record.kind,
        state: 'unavailable',
        available: false,
        encoding: null,
        bytes: null,
        originalBytes: null,
        truncated: null,
        base64Encoded: false,
        redacted: null,
        payloadOmitted: null,
        contentType: null,
        storedAt: record.storedAt,
        data: null,
        reason: 'NET_BODY_UNAVAILABLE',
        reasonCode: record.reasonCode || 'cdp-unknown',
        reasonDetail: record.reasonDetail ?? null,
      };
    }
    const limit = clampInt(maxBytes, NET_LIMITS.detailBodyMinBytes, NET_LIMITS.detailBodyBytes);
    const slice = record.buffer.subarray(0, limit);
    return {
      kind: record.kind,
      state: record.state,
      available: true,
      encoding: record.base64Encoded ? 'base64' : 'utf8',
      bytes: slice.length,
      originalBytes: record.originalBytes,
      truncated: record.truncated || slice.length < record.buffer.length,
      base64Encoded: record.base64Encoded,
      redacted: record.redacted,
      payloadOmitted: record.payloadOmitted,
      contentType: record.contentType,
      storedAt: record.storedAt,
      data: record.payloadOmitted ? '' : (record.base64Encoded ? slice.toString('base64') : slice.toString('utf8')),
      reason: null,
      reasonCode: null,
      reasonDetail: null,
    };
  }

  /**
   * 三态 + 原因：`captured`/`empty` 保持原语义（`reason:null`）；`unavailable` 保留兼容字段
   * `reason:"NET_BODY_UNAVAILABLE"`，并给出 `reasonCode`/`reasonDetail`。
   * `captureBodies:false` 且无任何记录时明确 `reasonCode:"not-captured"`（不是 CDP 错误）；
   * 采集中但没有任何失败记录的缺失（如导入的历史事件）保持 `reasonCode:null`——不猜测。
   */
  bodyState(event) {
    const options = { targetId: event.targetId, cdpSessionId: event.cdpSessionId, requestId: event.requestId, hopId: event.hopId };
    const fallbackCode = this.config.captureBodies === true ? null : 'not-captured';
    const state = {};
    for (const kind of ['request', 'response']) {
      const record = this.bodyRecord({ ...options, kind });
      if (!record) {
        state[kind] = {
          state: 'unavailable', available: false, bytes: null, originalBytes: null,
          truncated: null, payloadOmitted: null,
          reason: 'NET_BODY_UNAVAILABLE', reasonCode: fallbackCode, reasonDetail: null,
        };
      } else if (record.state === 'unavailable') {
        state[kind] = {
          state: 'unavailable', available: false, bytes: null, originalBytes: null,
          truncated: null, payloadOmitted: null,
          reason: 'NET_BODY_UNAVAILABLE',
          reasonCode: record.reasonCode || 'cdp-unknown',
          reasonDetail: record.reasonDetail ?? null,
        };
      } else {
        state[kind] = {
          state: record.state, available: true, bytes: record.buffer.length,
          originalBytes: record.originalBytes, truncated: record.truncated,
          payloadOmitted: record.payloadOmitted,
          reason: null, reasonCode: null, reasonDetail: null,
        };
      }
    }
    return state;
  }

  /**
   * TOOL-P1-04：记录一条 body 不可得原因。独立于 `bodies` 的 FIFO 表（容量 = 2 × 本次会话
   * maxEvents，每个事件最多 request/response 两条），只保留原因码/脱敏细节，不占 body 配额、
   * 不进入 JSONL/HAR、不影响 integrity 的 body 计数口径。
   */
  #rememberBodyFailure(key, record) {
    this.bodyFailures.set(key, {
      requestId: String(record.requestId),
      targetId: record.targetId ?? null,
      cdpSessionId: record.cdpSessionId ?? null,
      hopId: record.hopId ?? null,
      kind: record.kind || 'response',
      state: 'unavailable',
      reasonCode: normalizeBodyReasonCode(record.reasonCode),
      reasonDetail: record.reasonDetail ?? null,
      storedAt: this.now(),
    });
    const maxEvents = Number.isInteger(this.config.maxEvents) ? this.config.maxEvents : NET_LIMITS.maxEvents;
    const capacity = Math.max(64, 2 * maxEvents);
    while (this.bodyFailures.size > capacity) this.bodyFailures.delete(this.bodyFailures.keys().next().value);
  }

  /* ---------------- markers / steps / links ---------------- */

  mark({ kind = 'tool', text = null, tool = null, actionId = null, stepId = null, labels = null, revision = null, url = null, title = null, fromSeq = null } = {}) {
    return this.add({
      kind: 'marker', phase: 'mark',
      mark: { kind, text, tool, actionId, stepId, labels, revision, url, title, wallMs: this.now(), fromSeq, basis: 'temporal' },
      stepId,
    });
  }

  beginStep({ name = null, labels = null, window = null, businessStatusPath = null, objectRules = null, correlationRules = null, stepId = null } = {}) {
    if (name !== null && [...this.steps.values()].some((step) => step.name === String(name) && step.open)) {
      throw new BrowserError('NET_RULE_CONFLICT', '同名步骤已在运行: ' + String(name), { name: String(name) });
    }
    if (stepId && this.steps.has(String(stepId))) {
      throw new BrowserError('NET_RULE_CONFLICT', 'stepId 不可复用: ' + String(stepId), { stepId: String(stepId) });
    }
    if (this.steps.size >= NET_LIMITS.steps) {
      throw new BrowserError('NET_QUOTA_EXCEEDED', '步骤数超出上限 ' + NET_LIMITS.steps, { max: NET_LIMITS.steps });
    }
    const id = stepId ? truncateBytes(String(stepId), 64) : 'step-' + (this.steps.size + 1);
    const fromWallMs = window && Number.isFinite(window.fromWallMs) ? window.fromWallMs : this.now();
    const step = {
      stepId: id,
      name: name === null ? null : truncateBytes(String(name), 128),
      labels: labels && typeof labels === 'object'
        ? Object.fromEntries(Object.entries(labels).slice(0, NET_LIMITS.stepLabels).map(([key, value]) => [truncateBytes(key, 64), truncateBytes(String(value), 128)]))
        : null,
      businessStatusPath: businessStatusPath ? truncateBytes(String(businessStatusPath), 256) : this.config.businessStatusPath,
      objectRules: objectRules ? validateObjectRules(objectRules) : [],
      correlationRules: correlationRules ? validateCorrelationRules(correlationRules) : [...DEFAULT_CORRELATION_RULES],
      window: { fromWallMs, toWallMs: window && Number.isFinite(window.toWallMs) ? window.toWallMs : null },
      fromSeq: this.seq + 1,
      toSeq: null,
      open: true,
      createdAt: this.now(),
    };
    this.steps.set(id, step);
    this.add({ kind: 'marker', phase: 'step-begin', mark: { kind: 'note', stepId: id, text: step.name, wallMs: this.now() }, stepId: id });
    return step;
  }

  endStep({ stepId, window = null } = {}) {
    const step = this.steps.get(String(stepId));
    if (!step) throw new BrowserError('NET_EVENT_NOT_FOUND', '步骤不存在: ' + String(stepId), { stepId: String(stepId) });
    if (step.open) {
      step.open = false;
      step.toSeq = this.seq;
      step.window.toWallMs = window && Number.isFinite(window.toWallMs) ? window.toWallMs : this.now();
      this.add({ kind: 'marker', phase: 'step-end', mark: { kind: 'note', stepId: step.stepId, text: step.name, wallMs: this.now() }, stepId: step.stepId });
    }
    return step;
  }

  /**
   * 显式链接（R1-1 / §4.1「事件入店后不改写」）：链接只写进 `links` 索引，**不修改已入库事件**；
   * `stepIds`/`evidenceIds` 在查询期按索引投影。幂等。
   */
  link({ seq = null, requestId = null, stepId = null, evidenceId = null } = {}) {
    const event = resolveEvent(this, { seq, requestId });
    if (stepId && !this.steps.has(String(stepId))) {
      throw new BrowserError('NET_EVENT_NOT_FOUND', '步骤不存在: ' + String(stepId), { stepId: String(stepId) });
    }
    const list = this.links.get(event.seq) || [];
    const normalizedEvidence = evidenceId ? truncateBytes(String(evidenceId), 128) : null;
    const normalizedStep = stepId ? String(stepId) : null;
    if (!list.some((item) => item.evidenceId === normalizedEvidence && item.stepId === normalizedStep)) {
      list.push({ evidenceId: normalizedEvidence, stepId: normalizedStep, linkedAt: this.now() });
      this.links.set(event.seq, list);
    }
    return { seq: event.seq, ...this.linkProjection(event) };
  }

  /** 查询期投影：事件自带的 stepIds/evidenceIds + 链接索引。 */
  linkProjection(event) {
    const linked = this.links.get(event.seq) || [];
    const stepIds = [...event.stepIds];
    const evidenceIds = [...event.evidenceIds];
    for (const item of linked) {
      if (item.stepId && !stepIds.includes(item.stepId)) stepIds.push(item.stepId);
      if (item.evidenceId && !evidenceIds.includes(item.evidenceId)) evidenceIds.push(item.evidenceId);
    }
    return { stepIds, evidenceIds };
  }

  /* ---------------- window / integrity ---------------- */

  /**
   * §3.3 / R1-16 截图时间窗：`fromSeq` = `[startMs-250, captureEndMs+50]` 内最早现存事件，
   * `toSeq` = 截图开始时的会话 highWater（不含之后新产生的事件），`nearest` 可为 null。
   */
  window({ frameTimeMs, captureEndMs = null, highWater = null } = {}) {
    const start = Number.isFinite(frameTimeMs) ? frameTimeMs : this.now();
    const end = Number.isFinite(captureEndMs) ? captureEndMs : start;
    const limit = Number.isInteger(highWater) ? highWater : this.seq;
    const candidates = this.events.filter((event) => event.seq <= limit
      && event.ts.wallMs >= start - NET_LIMITS.networkWindowMs
      && event.ts.wallMs <= end + NET_LIMITS.networkWindowTailMs);
    const picked = candidates.slice(0, NET_LIMITS.networkWindowMax);
    let nearest = null;
    let nearestAny = null;
    for (const event of this.events) {
      if (event.seq > limit) continue;
      const delta = Math.abs(event.ts.wallMs - start);
      if (nearestAny === null || delta < nearestAny.delta) nearestAny = { event, delta };
      // Prefer a real request/response event; a marker carries no url/status to correlate with.
      if (!event.requestId) continue;
      if (nearest === null || delta < nearest.delta) nearest = { event, delta };
    }
    if (nearest === null) nearest = nearestAny;
    return {
      sessionId: this.session ? this.session.id : null,
      fromSeq: picked.length ? picked[0].seq : null,
      toSeq: this.session ? limit : null,
      frameTimeMs: start,
      captureEndMs: end,
      nearest: nearest ? {
        seq: nearest.event.seq,
        requestId: nearest.event.requestId,
        hopId: nearest.event.hopId,
        url: nearest.event.url,
        method: nearest.event.method,
        status: nearest.event.status,
        deltaMs: nearest.event.ts.wallMs - start,
      } : null,
      count: picked.length,
    };
  }

  integrity() {
    const gaps = [];
    if (this.counters.evicted > 0 && this.events.length > 0) {
      gaps.push({ from: this.events[0].seq - this.counters.evicted, to: this.events[0].seq - 1, count: this.counters.evicted, reason: 'evicted' });
    }
    for (const range of this.dropRanges) gaps.push({ ...range });
    const issues = [...new Set(this.issues)];
    if (this.counters.dropped > 0 && !issues.includes('events-dropped')) issues.push('events-dropped');
    if (this.counters.evicted > 0 && !issues.includes('events-evicted')) issues.push('events-evicted');
    if (this.counters.bodyEvicted > 0 && !issues.includes('bodies-evicted')) issues.push('bodies-evicted');
    if (this.counters.truncated > 0 && !issues.includes('bodies-truncated')) issues.push('bodies-truncated');
    if (!this.config.captureWebSocket) issues.push('capture-disabled:websocket');
    if (!this.config.captureSse) issues.push('capture-disabled:sse');
    if (!this.config.captureWorkers) issues.push('capture-disabled:workers');
    if (this.cdpDisconnected) issues.push('cdp-disconnected');
    const overflow = [...this.subscriptions.values()].some((subscription) => subscription.droppedPinned > 0);
    if (overflow) issues.push('subscriber-overflow');
    const unique = [...new Set(issues)].filter((issue) => NET_ISSUES.includes(issue));
    const complete = this.counters.dropped === 0 && this.counters.evicted === 0
      && this.counters.truncated === 0 && this.counters.bodyEvicted === 0 && gaps.length === 0
      && !unique.includes('cdp-disconnected') && !unique.includes('import-partial');
    return {
      complete,
      dropped: this.counters.dropped,
      evicted: this.counters.evicted,
      truncated: this.counters.truncated,
      bodyEvicted: this.counters.bodyEvicted,
      gaps,
      issues: unique,
      firstSeq: this.events.length ? this.events[0].seq : null,
      lastSeq: this.events.length ? this.events[this.events.length - 1].seq : null,
      sessionId: this.session ? this.session.id : null,
      state: this.state,
      estimate: this.estimateBytes(),
    };
  }
}

export function limitsView() {
  return {
    maxEvents: NET_LIMITS.maxEvents,
    maxBodyBytes: NET_LIMITS.maxBodyBytes,
    maxTotalBytes: NET_LIMITS.maxTotalBytes,
    maxWsFrames: NET_LIMITS.maxWsFrames,
    subscriptionMax: NET_LIMITS.subscriptionMax,
    subscriptionPin: NET_LIMITS.subscriptionPin,
    eventPageLimit: NET_LIMITS.eventPageLimit,
    holdTimeoutMs: NET_LIMITS.holdTimeoutMs,
    rules: NET_LIMITS.rules,
    held: NET_LIMITS.held,
    steps: NET_LIMITS.steps,
    preSessionEvents: NET_LIMITS.preSessionEvents,
    importDataBytes: NET_LIMITS.importDataBytes,
    importFileBytes: NET_LIMITS.importFileBytes,
    redirectChain: NET_LIMITS.redirectChain,
    // §5.1 fixed bounds — every limit has to be discoverable (§8.7).
    headerCount: NET_LIMITS.headerCount,
    headerValueBytes: NET_LIMITS.headerValueBytes,
    wsPayloadBytes: NET_LIMITS.wsPayloadBytes,
    sseDataBytes: NET_LIMITS.sseDataBytes,
    detailBodyBytes: NET_LIMITS.detailBodyBytes,
    detailBodyMinBytes: NET_LIMITS.detailBodyMinBytes,
    searchTextBytes: NET_LIMITS.searchTextBytes,
    initiatorStack: NET_LIMITS.initiatorStack,
    groupsLimit: NET_LIMITS.groupsLimit,
    correlationRules: NET_LIMITS.correlationRules,
    objectRules: NET_LIMITS.objectRules,
    retryWindowMs: NET_LIMITS.retryWindowMs,
    pollWindowMs: NET_LIMITS.pollWindowMs,
    // 控制类数值上限：`limits.network.<name>` 直接可读（C38），不再只藏在子对象里。
    throttleLimits: { latencyMsMax: 60000, downloadKbpsMax: 1000000, uploadKbpsMax: 1000000, unit: 'Kbps = 1024 bit/s' },
    latencyMsMax: 60000,
    downloadKbpsMax: 1000000,
    uploadKbpsMax: 1000000,
    holdLimits: { maxHeld: NET_LIMITS.held, timeoutMs: NET_LIMITS.holdTimeoutMs },
    ruleLimits: { max: NET_LIMITS.rules, kinds: [...NET_RULE_KINDS] },
  };
}

/* ------------------------------------------------------------------ */
/* 查询：events（§2.2）/ detail（§2.3）                                 */
/* ------------------------------------------------------------------ */

const FILTER_KEYS = Object.freeze([
  'method', 'status', 'statusClass', 'resourceType', 'urlIncludes', 'failed', 'kind', 'phase',
  'targetId', 'stepId', 'sinceMs', 'untilMs', 'minDurationMs', 'maxDurationMs',
]);

function asArray(value) {
  if (value === undefined || value === null) return null;
  return Array.isArray(value) ? value : [value];
}

function matchScalar(fieldValue, wanted, normalizer = (value) => String(value).toLowerCase()) {
  const list = asArray(wanted);
  if (list === null) return true;
  if (fieldValue === null || fieldValue === undefined) return false;
  return list.some((item) => normalizer(fieldValue) === normalizer(item));
}

/**
 * R1-1：`stepId` 是查询期按窗口派生的归属（`stepIds` 是显式链接）。
 *
 * A step window has two bounds and membership needs both: the wall-clock window
 * (`fromWallMs`/`toWallMs`) and the sequence window (`fromSeq`/`toSeq`). Wall clock alone is not
 * enough — an event that was already in the store when the step opened can carry a *later*
 * `ts.wallMs` (its response/finish phase is stamped after `begin-step` raced past it), and a
 * wall-only test then counts pre-step traffic as in-step. The seq bounds are exact, so they decide.
 */
export function stepMembership(store, event, step) {
  if (!step) return false;
  const fromWall = step.window?.fromWallMs;
  const toWall = step.window?.toWallMs === null || step.window?.toWallMs === undefined
    ? Number.POSITIVE_INFINITY
    : step.window.toWallMs;
  const wallOk = Number.isFinite(fromWall) ? event.ts.wallMs >= fromWall && event.ts.wallMs <= toWall : true;
  const fromSeq = Number.isInteger(step.fromSeq) ? step.fromSeq : null;
  const toSeq = Number.isInteger(step.toSeq) ? step.toSeq : null;
  const seqOk = (fromSeq === null || event.seq >= fromSeq) && (toSeq === null || event.seq <= toSeq);
  return wallOk && seqOk;
}

export function derivedStepId(store, event) {
  if (event.stepId) return event.stepId;
  if (event.stepIds.length) return event.stepIds[0];
  for (const step of store.steps.values()) {
    if (stepMembership(store, event, step)) return step.stepId;
  }
  return null;
}

export function inStepWindow(store, event, stepId) {
  if (event.stepId === stepId || event.stepIds.includes(String(stepId))) return true;
  return stepMembership(store, event, store.steps.get(String(stepId)));
}

export function matchesFilter(store, event, filter) {
  if (!filter) return true;
  if (!matchScalar(event.method, filter.method)) return false;
  if (!matchScalar(event.status, filter.status, (value) => String(value))) return false;
  if (!matchScalar(statusClass(event.status), filter.statusClass)) return false;
  if (!matchScalar(event.resourceType, filter.resourceType)) return false;
  if (!matchScalar(event.kind, filter.kind)) return false;
  if (!matchScalar(event.phase, filter.phase)) return false;
  if (!matchScalar(event.targetId, filter.targetId, (value) => String(value))) return false;
  if (filter.urlIncludes !== undefined && filter.urlIncludes !== null) {
    const needles = asArray(filter.urlIncludes).map((item) => String(item).toLowerCase());
    const haystack = String(event.url || '').toLowerCase();
    if (!needles.some((needle) => haystack.includes(needle))) return false;
  }
  if (filter.failed !== undefined && filter.failed !== null && (event.failed === true) !== (filter.failed === true)) return false;
  if (filter.stepId !== undefined && filter.stepId !== null) {
    const ids = asArray(filter.stepId).map((item) => String(item));
    if (!ids.some((id) => inStepWindow(store, event, id))) return false;
  }
  if (Number.isFinite(filter.sinceMs) && event.ts.wallMs < filter.sinceMs) return false;
  if (Number.isFinite(filter.untilMs) && event.ts.wallMs > filter.untilMs) return false;
  const duration = durationOf(store, event);
  if (Number.isFinite(filter.minDurationMs) && (duration === null || duration < filter.minDurationMs)) return false;
  if (Number.isFinite(filter.maxDurationMs) && (duration === null || duration > filter.maxDurationMs)) return false;
  return true;
}

export function durationOf(store, event) {
  if (event.timing && Number.isFinite(event.timing.totalMs)) return event.timing.totalMs;
  if (!event.requestId) return null;
  const chain = store.chains.get(requestKey(event));
  if (!chain || !Number.isInteger(chain.requestSeq) || !Number.isInteger(chain.finishedSeq)) return null;
  const first = store.events.find((item) => item.seq === chain.requestSeq);
  const last = store.events.find((item) => item.seq === chain.finishedSeq);
  if (!first || !last) return null;
  return Math.max(0, Math.round((last.ts.monotonicMs - first.ts.monotonicMs) * 1000) / 1000);
}

function searchableText(store, event, fields) {
  const wanted = fields && fields.length ? fields : ['url', 'body', 'headers', 'ws', 'sse'];
  const parts = [];
  if (wanted.includes('url')) parts.push(event.url, event.documentURL);
  if (wanted.includes('headers')) {
    for (const kind of ['request', 'response']) {
      const record = store.readHeaders({ targetId: event.targetId, cdpSessionId: event.cdpSessionId, requestId: event.requestId, hopId: event.hopId, kind });
      for (const [name, value] of Object.entries(record.headers)) parts.push(name + ': ' + value);
    }
  }
  if (wanted.includes('body')) {
    for (const kind of ['request', 'response']) {
      const body = store.readBody({ targetId: event.targetId, cdpSessionId: event.cdpSessionId, requestId: event.requestId, hopId: event.hopId, kind });
      if (body && body.state !== 'unavailable' && !body.payloadOmitted) parts.push(body.data);
    }
  }
  if (wanted.includes('ws') && event.ws && !event.ws.payloadOmitted) parts.push(event.ws.payload);
  if (wanted.includes('sse') && event.sse && !event.sse.payloadOmitted) parts.push(event.sse.data);
  return parts.filter((part) => part !== null && part !== undefined).join('\n');
}

export function matchesSearch(store, event, search) {
  if (!search) return null;
  const text = search.text;
  if (text === undefined || text === null || text === '') return null;
  const fields = Array.isArray(search.in) && search.in.length ? search.in : ['url', 'body', 'headers', 'ws', 'sse'];
  const caseSensitive = search.caseSensitive === true;
  const needle = caseSensitive ? String(text) : String(text).toLowerCase();
  const haystack = searchableText(store, event, fields);
  if (haystack === '') return { matched: false };
  const target = caseSensitive ? haystack : haystack.toLowerCase();
  const index = target.indexOf(needle);
  if (index === -1) return { matched: false };
  const start = Math.max(0, index - 40);
  return {
    matched: true,
    match: { field: fields[0], preview: truncateBytes(redactText(haystack.slice(start, start + 120)), 120) },
  };
}

/** §2.2 summary 投影（`failed` 布尔；`stepId` 派生；不内联 headers/body）。 */
export function projectSummary(store, event) {
  return {
    seq: event.seq,
    ts: { wallMs: event.ts.wallMs, monotonicMs: event.ts.monotonicMs },
    wallMs: event.ts.wallMs,
    kind: event.kind,
    phase: event.phase,
    requestId: event.requestId,
    hopId: event.hopId,
    method: event.method,
    url: event.url,
    status: event.status,
    statusClass: statusClass(event.status),
    statusText: event.statusText,
    resourceType: event.resourceType,
    mimeType: event.mimeType,
    durationMs: durationOf(store, event),
    size: { encoded: event.sizes.encoded, decoded: event.sizes.decoded },
    failed: event.failed,
    errorText: event.errorText,
    targetId: event.targetId,
    frameId: event.frameId,
    loaderId: event.loaderId,
    navId: event.navId,
    documentURL: event.documentURL,
    attribution: event.attribution,
    stepId: derivedStepId(store, event),
    // Flat aliases: `totalMs` (request duration) and the marker kind/tool/text at top level.
    totalMs: durationOf(store, event),
    ...(event.redirect ? { redirect: { from: event.redirect.from, to: event.redirect.to, status: event.redirect.status } } : {}),
    ...(event.replay ? { replay: event.replay } : {}),
    ...(event.mark ? {
      mark: event.mark,
      markKind: event.mark.kind || null,
      markTool: event.mark.tool || null,
      markText: event.mark.text || null,
    } : {}),
  };
}

function groupOf(event, key, store) {
  switch (key) {
    case 'url': return event.url;
    case 'method': return event.method;
    case 'status': return event.status === null ? null : String(event.status);
    case 'statusClass': return statusClass(event.status);
    case 'resourceType': return event.resourceType;
    case 'kind': return event.kind;
    case 'step': return derivedStepId(store, event);
    case 'host': {
      if (!event.url) return null;
      try { return new URL(event.url).host; } catch { return null; }
    }
    default: return null;
  }
}

/** §2.2 / §5.3 聚合。 */
export function aggregateEvents(store, events, groupBy = 'url') {
  const keys = (Array.isArray(groupBy) ? groupBy : [groupBy]).filter(Boolean);
  if (keys.length === 0) throw new BrowserError('NET_INVALID_ARGUMENT', 'groupBy 至少需要一个字段');
  for (const key of keys) {
    if (!NET_GROUP_KEYS.includes(key)) throw new BrowserError('NET_INVALID_ARGUMENT', 'groupBy 不支持 ' + String(key), { field: 'groupBy', allowed: [...NET_GROUP_KEYS] });
  }
  const groups = new Map();
  for (const event of events) {
    if (!['http', 'ws', 'sse'].includes(event.kind)) continue;
    const values = keys.map((key) => groupOf(event, key, store));
    const id = JSON.stringify(values);
    let group = groups.get(id);
    if (!group) {
      group = {
        key: keys.length === 1 ? values[0] : Object.fromEntries(keys.map((key, index) => [key, values[index]])),
        count: 0, bytes: 0, failures: 0, statuses: {}, durations: [], seqs: [],
      };
      groups.set(id, group);
    }
    group.count += 1;
    if (event.sizes && Number.isInteger(event.sizes.encoded)) group.bytes += event.sizes.encoded;
    if (event.failed || (Number.isInteger(event.status) && event.status >= 400)) group.failures += 1;
    if (Number.isInteger(event.status)) group.statuses[String(event.status)] = (group.statuses[String(event.status)] || 0) + 1;
    const duration = durationOf(store, event);
    if (Number.isFinite(duration)) group.durations.push(duration);
    if (group.seqs.length < 50) group.seqs.push(event.seq);
  }
  const list = [...groups.values()].map((group) => {
    const sorted = [...group.durations].sort((left, right) => left - right);
    const sum = sorted.reduce((total, value) => total + value, 0);
    return {
      key: group.key,
      count: group.count,
      bytes: group.bytes,
      durationMs: {
        min: sorted.length ? sorted[0] : null,
        max: sorted.length ? sorted[sorted.length - 1] : null,
        avg: sorted.length ? Math.round((sum / sorted.length) * 1000) / 1000 : null,
        p50: percentile(sorted, 0.5),
        p95: percentile(sorted, 0.95),
      },
      failures: group.failures,
      statuses: group.statuses,
      seqs: group.seqs,
    };
  }).sort((left, right) => right.count - left.count);
  return { groups: list.slice(0, NET_LIMITS.groupsLimit), truncated: list.length > NET_LIMITS.groupsLimit, groupCount: list.length };
}

function assertSession(store, sessionId) {
  if (sessionId === undefined || sessionId === null) return;
  const current = store.session ? store.session.id : null;
  if (String(sessionId) !== String(current)) {
    throw new BrowserError('NET_SESSION_NOT_FOUND', '网络会话不存在或不属于本 scope', { sessionId: String(sessionId), current });
  }
}

/** §8.6 证据块。 */
export function evidenceBlock(store, operation, extra = {}) {
  const integrity = store.integrity();
  const applied = [...new Set(store.events.slice(-200).flatMap((event) => event.redaction.applied))];
  const rules = [...new Set(store.events.slice(-200).flatMap((event) => event.redaction.rules))];
  return {
    version: NET_VERSION,
    operation,
    sessionId: store.session ? store.session.id : null,
    // TOOL-P1-04：证据块回传同一份归属投影（缺失为 null，不推断）。
    attribution: attributionView(store),
    fromSeq: Number.isInteger(extra.fromSeq) ? extra.fromSeq : (integrity.firstSeq === null ? 0 : integrity.firstSeq),
    toSeq: Number.isInteger(extra.toSeq) ? extra.toSeq : (integrity.lastSeq === null ? 0 : integrity.lastSeq),
    counters: { events: store.counters.events, bodies: store.counters.bodies, bytes: store.counters.bytes, ...(extra.counters || {}) },
    integrity: {
      complete: integrity.complete, dropped: integrity.dropped, evicted: integrity.evicted,
      truncated: integrity.truncated, bodyEvicted: integrity.bodyEvicted,
    },
    redaction: { applied, rules, body: store.config.captureBodies ? 'fields' : 'none' },
    truncated: extra.truncated === true,
    incomplete: [...new Set([...(extra.incomplete || []), ...integrity.issues.filter((issue) => ['cdp-disconnected', 'import-partial', 'workers-not-attributable'].includes(issue))])],
  };
}

/**
 * R1-22：retry / duplicate / polling 模式投影。
 * `{retry:[{groupKey,count,seqs}], duplicate:[…], polling:[{groupKey,count,intervalMs,firstSeq,lastSeq}]}`
 */
export function buildPatterns(events, retries = null) {
  const patterns = retries || detectRetries(events);
  return {
    retry: patterns.filter((item) => item.pattern === 'retry').map((item) => ({ groupKey: item.groupKey, count: item.count, seqs: item.seqs })),
    duplicate: patterns.filter((item) => item.pattern === 'duplicate').map((item) => ({ groupKey: item.groupKey, count: item.count, seqs: item.seqs })),
    polling: detectPolling(events),
  };
}

/** 聚合总量（§2.2 aggregate.totals）。 */
export function aggregatedTotals(events) {
  return {
    count: events.length,
    bytes: events.reduce((sum, event) => sum + (event.sizes && Number.isInteger(event.sizes.encoded) ? event.sizes.encoded : 0), 0),
    failures: events.filter((event) => event.failed || (Number.isInteger(event.status) && event.status >= 400)).length,
  };
}

/** `browser_network_events` 执行体（只读，不启动浏览器，§2.2）。 */
export function queryEvents(store, params = {}) {
  assertKnownKeys(params, ['sessionId', 'sinceSeq', 'untilSeq', 'cursor', 'limit', 'order', 'view', 'filter', 'search', 'groupBy', 'aggregate'], 'events');
  assertSession(store, params.sessionId);
  const view = params.view === undefined ? 'summary' : params.view;
  if (!NET_VIEWS.includes(view)) throw new BrowserError('NET_INVALID_ARGUMENT', 'view 不合法: ' + String(view), { field: 'view', allowed: [...NET_VIEWS] });
  const order = params.order === undefined ? 'asc' : params.order;
  if (!['asc', 'desc'].includes(order)) throw new BrowserError('NET_INVALID_ARGUMENT', 'order 必须是 asc 或 desc', { field: 'order' });
  const limit = params.limit === undefined ? NET_LIMITS.eventPageDefault : params.limit;
  if (!Number.isInteger(limit) || limit < 1 || limit > NET_LIMITS.eventPageLimit) {
    throw new BrowserError('NET_INVALID_ARGUMENT', `limit 必须是 1–${NET_LIMITS.eventPageLimit} 的整数`, { field: 'limit', max: NET_LIMITS.eventPageLimit });
  }
  const filter = assertKnownKeys(params.filter, FILTER_KEYS, 'filter');
  const search = params.search === undefined || params.search === null
    ? null
    : assertKnownKeys(params.search, ['text', 'in', 'caseSensitive'], 'search');
  if (search && search.in !== undefined) {
    if (!Array.isArray(search.in)) throw new BrowserError('NET_INVALID_ARGUMENT', 'search.in 必须是数组');
    for (const field of search.in) {
      if (!NET_SEARCH_FIELDS.includes(field)) throw new BrowserError('NET_INVALID_ARGUMENT', 'search.in 含未知字段 ' + String(field), { allowed: [...NET_SEARCH_FIELDS] });
    }
  }
  if (params.aggregate !== undefined && params.aggregate !== null) {
    if (!Array.isArray(params.aggregate)) throw new BrowserError('NET_INVALID_ARGUMENT', 'aggregate 必须是数组');
    for (const metric of params.aggregate) {
      if (!NET_AGGREGATE_METRICS.includes(metric)) throw new BrowserError('NET_INVALID_ARGUMENT', 'aggregate 含未知指标 ' + String(metric), { allowed: [...NET_AGGREGATE_METRICS] });
    }
  }
  const cursorSeq = decodeCursor(params.cursor);
  const requestedFrom = cursorSeq !== null ? cursorSeq : (Number.isInteger(params.sinceSeq) ? params.sinceSeq : 0);
  const untilSeq = Number.isInteger(params.untilSeq) ? params.untilSeq : null;
  const firstSeq = store.events.length ? store.events[0].seq : 0;
  const gaps = [];
  if (requestedFrom > 0 && store.events.length > 0 && requestedFrom < firstSeq - 1) {
    gaps.push({ from: requestedFrom + 1, to: firstSeq - 1, count: firstSeq - 1 - requestedFrom });
  }
  const matched = [];
  // Paging defaults to the NEWEST window: an unpaged query (`{filter, limit:50}`) must show recent
  // traffic, not the first 50 events of a long session. `order:'asc'` keeps forward paging for
  // explicit cursor walks; `sinceSeq`/`cursor` still work in both directions.
  const forward = order === 'asc' || requestedFrom > 0 || cursorSeq !== null;
  const source = forward ? store.events : [...store.events].reverse();
  for (const event of source) {
    if (event.seq <= requestedFrom) continue;
    if (untilSeq !== null && event.seq > untilSeq) continue;
    if (!matchesFilter(store, event, filter)) continue;
    const searchResult = matchesSearch(store, event, search);
    if (searchResult && !searchResult.matched) continue;
    matched.push({ event, match: searchResult && searchResult.match ? searchResult.match : null });
  }
  const truncated = matched.length > limit;
  const page = matched.slice(0, limit);
  const ordered = forward ? page : [...page].sort((a, b) => a.event.seq - b.event.seq);
  const lastSeq = page.length ? page[page.length - 1].event.seq : null;
  const seqsOfPage = page.map((item) => item.event.seq);
  const base = {
    ok: true,
    sessionId: store.session ? store.session.id : null,
    view,
    fromSeq: seqsOfPage.length ? Math.min(...seqsOfPage) : (requestedFrom || 0),
    toSeq: seqsOfPage.length ? Math.max(...seqsOfPage) : (untilSeq === null ? store.seq : untilSeq),
    total: matched.length,
    returned: page.length,
    dropped: store.counters.dropped,
    evicted: store.counters.evicted,
    truncated,
    cursor: { next: truncated && lastSeq !== null ? encodeCursor(lastSeq) : null },
    ...(gaps.length ? { gap: gaps[0] } : {}),
    groups: [],
    integrity: store.integrity(),
  };
  if (view === 'aggregate') {
    const groupBy = params.groupBy === undefined ? 'url' : params.groupBy;
    // Aggregate over *all* matched events, not just the first page: an aggregate that silently
    // ignored matches beyond `limit` would report a false empty `patterns`/`groups` (C20/C22).
    const aggregateInput = matched.map((item) => item.event);
    const aggregated = aggregateEvents(store, aggregateInput, groupBy);
    // R1-22: retry/duplicate/polling patterns are exposed here so C22 does not need trace.query.
    const retries = detectRetries(aggregateInput);
    return {
      ...base,
      events: [],
      groups: aggregated.groups,
      patterns: buildPatterns(aggregateInput, retries),
      aggregate: {
        groupBy, truncated: aggregated.truncated, groupCount: aggregated.groupCount,
        incomplete: !store.integrity().complete, groups: aggregated.groups,
        totals: aggregatedTotals(aggregateInput),
      },
      evidence: evidenceBlock(store, 'events', { truncated: truncated || aggregated.truncated }),
    };
  }
  if (view === 'timeline') {
    const sorted = page.map((item) => item.event).sort((left, right) => left.ts.monotonicMs - right.ts.monotonicMs);
    const finalOrder = order === 'asc' ? sorted : [...sorted].reverse();
    return {
      ...base,
      events: finalOrder.map((event) => ({ ...projectSummary(store, event), basis: 'temporal' })),
      evidence: evidenceBlock(store, 'events', { truncated }),
    };
  }
  if (view === 'full') {
    return {
      ...base,
      events: ordered.map((item) => {
        const event = item.event;
        // `full` must stay BYTE-STABLE for a stored event (C10 / §4.1): only stored fields plus the
        // derived step id. Headers and cross-event durations are query-time state that legitimately
        // fills in later (ExtraInfo, response timing), so they live in `browser_network_detail`
        // instead of making the projection mutate.
        return {
          ...event,
          stepId: derivedStepId(store, event),
          durationMs: event.timing && Number.isFinite(event.timing.totalMs) ? event.timing.totalMs : null,
          failure: event.failed ? {
            errorText: event.errorText, errorCode: event.errorCode,
            blockedReason: event.blockedReason, canceled: event.canceled,
          } : null,
          headersIn: 'detail',
          ...(item.match ? { match: item.match } : {}),
        };
      }),
      evidence: evidenceBlock(store, 'events', { truncated }),
    };
  }
  return {
    ...base,
    events: ordered.map((item) => ({ ...projectSummary(store, item.event), ...(item.match ? { match: item.match } : {}) })),
    evidence: evidenceBlock(store, 'events', { truncated }),
  };
}

/** §2.3 / R1-10 事件定位。 */
export function resolveEvent(store, { seq = null, requestId = null, hopId = null, targetId = null } = {}) {
  if (Number.isInteger(seq)) {
    const event = store.events.find((item) => item.seq === seq);
    if (!event) throw new BrowserError('NET_EVENT_NOT_FOUND', '事件不存在或已淘汰: seq=' + String(seq), { seq });
    return event;
  }
  if (requestId !== undefined && requestId !== null) {
    const candidates = store.events.filter((event) => event.requestId === String(requestId)
      && (targetId === null || targetId === undefined || event.targetId === targetId)
      && (hopId === null || hopId === undefined || event.hopId === hopId));
    if (candidates.length === 0) {
      throw new BrowserError('NET_EVENT_NOT_FOUND', '事件不存在或已淘汰: requestId=' + String(requestId), { requestId: String(requestId) });
    }
    const targets = new Set(candidates.map((event) => event.targetId));
    if (targets.size > 1) {
      throw new BrowserError('NET_EVENT_NOT_FOUND', 'requestId 在多个 target 下重复，请改用 seq 定位', {
        requestId: String(requestId), targetIds: [...targets],
      });
    }
    const preference = ['finished', 'failed', 'response', 'request', 'redirect', 'ws-handshake', 'ws-created'];
    let best = null;
    for (const event of candidates) {
      const rank = preference.indexOf(event.phase);
      if (best === null || (rank !== -1 && (best.rank === -1 || rank < best.rank))) best = { event, rank };
    }
    return best.event;
  }
  throw new BrowserError('NET_INVALID_ARGUMENT', 'detail 需要 requestId 或 seq（恰好一个）');
}

function normalizeInclude(include) {
  if (include === undefined || include === null) return new Set(NET_DETAIL_PARTS.filter((part) => part !== 'body'));
  if (!Array.isArray(include) || include.length === 0) throw new BrowserError('NET_INVALID_ARGUMENT', 'include 必须是非空数组');
  const set = new Set();
  for (const part of include) {
    if (!NET_DETAIL_PARTS.includes(part)) {
      throw new BrowserError('NET_INVALID_ARGUMENT', 'include 含未知取值 ' + String(part), { field: 'include', allowed: [...NET_DETAIL_PARTS] });
    }
    set.add(part);
  }
  return set;
}

/** 采集配置决定的"从未尝试采集"原因码；采集开启但无记录 → null（无证据，不猜）。 */
function bodyFallbackCode(store) {
  return store && store.config && store.config.captureBodies === true ? null : 'not-captured';
}

/**
 * §2.3 body 块：三态 + 不伪造（detail 不补读、不重试）。
 * TOOL-P1-04：不可得时保留 `reason:"NET_BODY_UNAVAILABLE"` 兼容字段，并回传
 * `reasonCode`/`reasonDetail`；`fallbackReasonCode` 用于"从未尝试采集"（`captureBodies:false`
 * → `not-captured`）或调用方已知的缺失原因，`null` 表示无证据、不猜测。
 */
function bodyBlock(body, fallbackReasonCode = null) {
  if (!body || body.state === 'unavailable') {
    return {
      available: false, state: 'unavailable', encoding: null, bytes: null, originalBytes: null,
      truncated: null, redacted: null, source: 'unavailable', payloadOmitted: null, data: null,
      reason: 'NET_BODY_UNAVAILABLE',
      reasonCode: (body && body.reasonCode) || fallbackReasonCode || null,
      reasonDetail: body && body.reasonDetail !== undefined ? body.reasonDetail : null,
    };
  }
  return {
    available: true,
    state: body.state,
    encoding: body.encoding,
    bytes: body.bytes,
    originalBytes: body.originalBytes,
    truncated: body.truncated,
    redacted: body.redacted,
    source: 'captured',
    payloadOmitted: body.payloadOmitted,
    contentType: body.contentType,
    data: body.data,
    reason: null,
    reasonCode: null,
    reasonDetail: null,
  };
}

/** `browser_network_detail` 执行体（纯只读，§2.3）。 */
export function detailEvent(store, params = {}) {
  assertKnownKeys(params, ['sessionId', 'requestId', 'seq', 'hopId', 'targetId', 'include', 'maxBodyBytes'], 'detail');
  assertSession(store, params.sessionId);
  const hasSeq = Number.isInteger(params.seq);
  const hasRequestId = params.requestId !== undefined && params.requestId !== null;
  if (hasSeq === hasRequestId) throw new BrowserError('NET_INVALID_ARGUMENT', 'requestId 与 seq 必须恰好给一个');
  const include = normalizeInclude(params.include);
  const maxBytes = params.maxBodyBytes === undefined
    ? NET_LIMITS.detailBodyBytes
    : clampInt(params.maxBodyBytes, NET_LIMITS.detailBodyMinBytes, NET_LIMITS.detailBodyBytes);
  const event = resolveEvent(store, { seq: params.seq, requestId: params.requestId, hopId: params.hopId, targetId: params.targetId });
  const options = { targetId: event.targetId, cdpSessionId: event.cdpSessionId, requestId: event.requestId, hopId: event.hopId };
  const chain = store.chains.get(requestKey(event)) || null;
  const result = {
    ok: true,
    sessionId: store.session ? store.session.id : null,
    seq: event.seq,
    requestId: event.requestId,
    hopId: event.hopId,
    targetId: event.targetId,
    cdpSessionId: event.cdpSessionId,
    include: [...include],
    event,
    stepIds: [...event.stepIds],
    evidenceIds: [...event.evidenceIds],
  };
  // `trace.link`/`evidence.link` may target any event of the same request chain; report the union so
  // detail answers "which evidence covers this request" (C33/C44).
  const chainOptions = { targetId: event.targetId, cdpSessionId: event.cdpSessionId, requestId: event.requestId };
  const chainEvents = store.events.filter((item) => item.requestId === chainOptions.requestId
    && item.targetId === chainOptions.targetId && item.cdpSessionId === chainOptions.cdpSessionId);
  for (const item of chainEvents) {
    const projection = store.linkProjection ? store.linkProjection(item) : { stepIds: item.stepIds, evidenceIds: item.evidenceIds };
    for (const evidenceId of projection.evidenceIds) if (!result.evidenceIds.includes(evidenceId)) result.evidenceIds.push(evidenceId);
    for (const stepId of projection.stepIds) if (!result.stepIds.includes(stepId)) result.stepIds.push(stepId);
  }
  // Contract §2.3 exposes the parsed query at `queryString` on the detail (C18 asserts it).
  result.queryString = parseQueryString(event.url);
  result.failure = {
    errorText: event.errorText, errorCode: event.errorCode,
    blockedReason: event.blockedReason, canceled: event.canceled, failed: event.failed,
  };
  if (include.has('request')) {
    const requestBody = store.readBody({ ...options, kind: 'request' }, { maxBytes });
    result.request = {
      requestId: event.requestId,
      hopId: event.hopId,
      method: event.method,
      url: event.url,
      queryString: parseQueryString(event.url),
      headers: store.readHeaders({ ...options, kind: 'request' }).headers,
      resourceType: event.resourceType,
      // TOOL-P1-04：不可得（含带原因码的失败记录）时 postData 仍是 available:false，并回传原因码。
      postData: requestBody && requestBody.state !== 'unavailable'
        ? { kind: bodyKindOf(requestBody.contentType), bytes: requestBody.originalBytes, state: requestBody.state, parseError: false }
        : {
          kind: 'unknown', bytes: null, state: 'unavailable', available: false,
          reason: 'NET_BODY_UNAVAILABLE',
          reasonCode: (requestBody && requestBody.reasonCode) || bodyFallbackCode(store),
          reasonDetail: requestBody ? (requestBody.reasonDetail ?? null) : null,
        },
    };
  }
  if (include.has('response')) {
    result.response = {
      status: event.status,
      statusClass: statusClass(event.status),
      statusText: event.statusText,
      mimeType: event.mimeType,
      protocol: event.protocol,
      fromCache: event.fromCache,
      headers: store.readHeaders({ ...options, kind: 'response' }).headers,
      sizes: event.sizes,
      failure: {
        errorText: event.errorText, errorCode: event.errorCode,
        blockedReason: event.blockedReason, canceled: event.canceled,
      },
    };
  }
  if (include.has('headers')) {
    result.headers = {
      request: store.readHeaders({ ...options, kind: 'request' }).headers,
      response: store.readHeaders({ ...options, kind: 'response' }).headers,
      redacted: {
        request: store.readHeaders({ ...options, kind: 'request' }).applied,
        response: store.readHeaders({ ...options, kind: 'response' }).applied,
      },
    };
  }
  if (include.has('body')) {
    const fallback = bodyFallbackCode(store);
    result.requestBody = bodyBlock(store.readBody({ ...options, kind: 'request' }, { maxBytes }), fallback);
    result.responseBody = bodyBlock(store.readBody({ ...options, kind: 'response' }, { maxBytes }), fallback);
    // Contract §2.3 names the parts `body.requestBody`/`body.responseBody`; the flat aliases above
    // are kept for callers that read them directly.
    result.body = { request: result.requestBody, response: result.responseBody };
  }
  if (include.has('timing')) {
    const timing = event.timing || emptyTiming();
    result.timing = {
      requestTimeMs: timing.requestTimeMs,
      responseTimeMs: timing.responseTimeMs,
      ttfbMs: timing.ttfbMs,
      totalMs: durationOf(store, event),
      dnsMs: timing.dnsMs,
      connectMs: timing.connectMs,
      sslMs: timing.sslMs,
      sendMs: timing.sendMs,
      waitMs: timing.waitMs,
      receiveMs: timing.receiveMs,
    };
  }
  if (include.has('redirects')) {
    const hopKeys = store.hops.get(event.requestId) || [];
    const hops = [];
    for (const key of hopKeys) {
      const hopChain = store.chains.get(key);
      if (!hopChain) continue;
      hops.push({
        hopId: hopChain.hopId,
        seq: hopChain.seqs.length ? hopChain.seqs[0] : null,
        requestId: hopChain.requestId,
        url: hopChain.url,
        status: hopChain.status,
        location: hopChain.hops.length ? hopChain.hops[hopChain.hops.length - 1].url : null,
      });
    }
    if (hops.length === 0) {
      // Fallback: derive hops from the stored events of this request (fetch/XHR redirects whose
      // chain was never registered). One row per hop, in hop order (C25).
      const byHop = new Map();
      for (const item of store.events) {
        if (item.requestId !== event.requestId) continue;
        const hopId = item.hopId ?? 0;
        const existing = byHop.get(hopId);
        if (!existing || (item.phase === 'redirect' && existing.status === null)) {
          byHop.set(hopId, {
            hopId,
            seq: existing && existing.seq !== null ? existing.seq : item.seq,
            requestId: item.requestId,
            url: item.redirect ? item.redirect.from : item.url,
            status: item.status,
            location: item.redirect ? item.redirect.to : (existing ? existing.location : null),
          });
        } else if (item.redirect && existing && existing.location === null) {
          existing.location = item.redirect.to;
          existing.status = item.status;
        }
      }
      for (const hopId of [...byHop.keys()].sort((a, b) => a - b)) hops.push(byHop.get(hopId));
    }
    result.hops = hops;
    result.redirects = hops.filter((hop) => hop.hopId !== (chain ? chain.hopId : 0) || hop.location !== null);
    if (hops.length === 0 && event.redirect) {
      result.redirects = [{ requestId: event.requestId, url: event.redirect.to, status: event.redirect.status, location: event.redirect.to }];
    }
  }
  if (include.has('initiator')) result.initiator = event.initiator;
  if (include.has('ws')) {
    const frames = store.events
      .filter((item) => item.kind === 'ws' && item.requestId === event.requestId && (item.phase === 'ws-send' || item.phase === 'ws-receive'))
      .slice(0, NET_LIMITS.eventPageLimit)
      .map((item) => ({
        seq: item.seq, direction: item.ws ? item.ws.direction : null, opcode: item.ws ? item.ws.opcode : null,
        payload: item.ws ? item.ws.payload : null, payloadTruncated: item.ws ? item.ws.payloadTruncated : null,
        payloadOmitted: item.ws ? item.ws.payloadOmitted : null, wallMs: item.ts.wallMs,
      }));
    result.ws = event.kind === 'ws' || frames.length > 0 ? {
      url: (event.ws && event.ws.url) || event.url,
      protocol: event.ws ? event.ws.protocol : null,
      handshake: event.ws ? event.ws.handshake : null,
      openedAt: event.ws ? event.ws.openedAt : null,
      closedAt: event.ws ? event.ws.closedAt : null,
      frames,
      counts: {
        sent: frames.filter((frame) => frame.direction === 'send').length,
        received: frames.filter((frame) => frame.direction === 'receive').length,
        truncated: store.counters.wsFrames >= store.config.maxWsFrames,
      },
    } : null;
  }
  if (include.has('sse')) {
    const messages = store.events
      .filter((item) => item.kind === 'sse' && item.requestId === event.requestId)
      .slice(0, NET_LIMITS.eventPageLimit)
      .map((item) => ({
        seq: item.seq, eventName: item.sse ? item.sse.eventName : null,
        eventId: item.sse ? item.sse.eventId : null, data: item.sse ? item.sse.data : null,
        wallMs: item.ts.wallMs,
      }));
    result.sse = event.kind === 'sse' || messages.length ? { url: event.url, events: messages, counts: { messages: messages.length } } : null;
  }
  if (include.has('correlation')) {
    const contentHashes = store.corrHashes.get(event.seq) || [];
    result.correlation = {
      ids: event.correlationIds.map((id) => ({
        name: id.name, value: id.value, valueHash: id.valueHash,
        source: { kind: id.source || null, seq: event.seq },
      })),
      sameGroup: contentHashes.length
        ? Math.max(...contentHashes.map((hash) => (store.correlationIndex.get(hash) || []).length))
        : 0,
    };
  }
  if (include.has('dependencies')) {
    const parents = [];
    const children = [];
    if (event.initiator && event.initiator.requestId) {
      const parent = store.events.find((item) => item.requestId === event.initiator.requestId);
      if (parent) parents.push({ requestId: parent.requestId, url: parent.url, relation: 'initiator' });
    }
    if (chain) for (const hop of chain.hops) parents.push({ requestId: hop.requestId, url: hop.fromUrl, relation: 'redirect' });
    // Redirect edges derived from the stored chain (works for fetch/XHR redirects too, where CDP
    // does not always deliver `redirectResponse` on this connection): a lower hop of the same
    // request is the parent of this hop.
    for (const item of store.events) {
      if (item.requestId !== event.requestId) continue;
      if (item.phase !== 'redirect') continue;
      if ((item.hopId ?? 0) >= (event.hopId ?? 0)) continue;
      parents.push({ requestId: item.requestId, url: item.url, relation: 'redirect', hopId: item.hopId, status: item.status ?? null });
    }
    for (const item of store.events) {
      if (item.seq >= event.seq) break;
      if (item.initiator && item.initiator.requestId === event.requestId) children.push({ requestId: item.requestId, url: item.url, relation: 'initiator' });
      if (item.url && event.url && item.url === event.url && item.requestId !== event.requestId) {
        parents.push({ requestId: item.requestId, url: item.url, relation: 'same-url' });
      }
    }
    result.dependencies = {
      parents: dedupeEdges(parents).slice(0, NET_LIMITS.dependencyEdges),
      children: dedupeEdges(children).slice(0, NET_LIMITS.dependencyEdges),
      basis: 'observed',
    };
  }
  if (include.has('business')) {
    const step = event.stepId ? store.steps.get(event.stepId) : null;
    const path = (event.business && event.business.businessCodePath) || (step && step.businessStatusPath) || store.config.businessStatusPath || null;
    // Business code is derived from the captured response body at query time, so `detail` reports
    // it even when the body was captured after the `finished` event was written (R1-11).
    let businessCode = event.business ? event.business.businessCode : null;
    if (businessCode === null) {
      const stored = store.readBody({ ...options, kind: 'response' }, { maxBytes });
      if (stored && stored.state === 'captured' && !stored.payloadOmitted) {
        let parsed = null;
        try { parsed = JSON.parse(stored.data); } catch { parsed = null; }
        businessCode = extractBusinessCode(parsed, path).businessCode;
      }
    }
    result.business = {
      statusCode: event.status,
      businessCode,
      businessCodePath: path,
      objects: extractObjects(store, { objectRules: objectRulesFor(store, event) }, [event]).map((object) => ({
        name: object.name, value: object.value, source: { seq: object.firstSeq, from: object.from, path: object.path },
      })),
    };
  }
  if (include.has('events')) {
    result.events = store.events
      .filter((item) => item.requestId === event.requestId && item.targetId === event.targetId && item.cdpSessionId === event.cdpSessionId)
      .slice(0, NET_LIMITS.detailEvents)
      .map((item) => projectSummary(store, item));
  }
  // R1-22: per-request retry/duplicate analysis over the events sharing this request's identity
  // key (method + un-sanitized urlHash), so `detail` answers it without a separate trace query.
  const identityKey = (item) => (item.method || 'GET') + ' ' + (item.urlHash || item.url);
  const siblings = store.events.filter((item) => item.kind === 'http' && item.phase === 'response'
    && (item.urlHash ? item.urlHash === event.urlHash : identityKey(item) === identityKey(event)));
  const siblingPatterns = detectRetries(siblings.length ? siblings : [event]);
  const selfPattern = siblingPatterns.find((item) => identityKey(event) === item.groupKey || (item.seqs || []).includes(event.seq));
  result.analysis = {
    pattern: selfPattern ? selfPattern.pattern : null,
    groupKey: selfPattern ? selfPattern.groupKey : identityKey(event),
    occurrences: siblings.length,
    // §5.4 observable classifications only — never a guess.
    issues: observableIssues(event),
    basis: 'observed',
  };
  result.integrity = store.integrity();
  result.evidence = evidenceBlock(store, 'detail', { fromSeq: event.seq, toSeq: event.seq });
  return result;
}


/** §5.4 错误/异常分类（只基于可观测事实，`cors` 仅 suspect）。 */
export function observableIssues(event) {
  const issues = [];
  if (!event) return issues;
  if (event.failed) issues.push('loading-failed');
  if (Number.isInteger(event.status) && event.status >= 400) issues.push('http-error');
  const text = String(event.errorText || '');
  if (/TIMED_OUT|ERR_TIMEOUT/i.test(text)) issues.push('timeout');
  if (/CORS/i.test(text)) issues.push('cors-suspect');
  if (event.canceled === true) issues.push('aborted');
  if (event.blockedReason) issues.push('blocked');
  return issues;
}

function dedupeEdges(edges) {
  const seen = new Set();
  const out = [];
  for (const edge of edges) {
    const key = edge.relation + '\u0000' + edge.requestId;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(edge);
  }
  return out;
}

/* ------------------------------------------------------------------ */
/* 业务链路：trace（§2.4 / §5.6 / §6）                                  */
/* ------------------------------------------------------------------ */

export function validateObjectRules(rules) {
  if (!Array.isArray(rules)) throw new BrowserError('NET_RULE_INVALID', 'objectRules 必须是数组');
  if (rules.length > NET_LIMITS.objectRules) {
    throw new BrowserError('NET_QUOTA_EXCEEDED', 'objectRules 最多 ' + NET_LIMITS.objectRules + ' 条', { max: NET_LIMITS.objectRules });
  }
  return rules.map((rule, index) => {
    assertKnownKeys(rule, ['from', 'key', 'path', 'name', 'propagate'], `objectRules[${index}]`, 'NET_RULE_INVALID');
    if (!NET_OBJECT_SOURCES.includes(rule.from)) {
      throw new BrowserError('NET_RULE_INVALID', `objectRules[${index}].from 不合法`, { allowed: [...NET_OBJECT_SOURCES] });
    }
    if (!rule.key && !rule.path) throw new BrowserError('NET_RULE_INVALID', `objectRules[${index}] 需要 key 或 path`);
    return {
      from: rule.from,
      key: rule.key ? truncateBytes(String(rule.key), 128) : null,
      path: rule.path ? truncateBytes(String(rule.path), 256) : null,
      name: rule.name ? truncateBytes(String(rule.name), 128) : truncateBytes(String(rule.key || rule.path), 128),
      propagate: rule.propagate === true,
    };
  });
}

export function validateCorrelationRules(rules) {
  if (!Array.isArray(rules)) throw new BrowserError('NET_RULE_INVALID', 'correlationRules 必须是数组');
  if (rules.length > NET_LIMITS.correlationRules) {
    throw new BrowserError('NET_QUOTA_EXCEEDED', 'correlationRules 最多 ' + NET_LIMITS.correlationRules + ' 条', { max: NET_LIMITS.correlationRules });
  }
  return rules.map((rule, index) => {
    assertKnownKeys(rule, ['from', 'key', 'path', 'name'], `correlationRules[${index}]`, 'NET_RULE_INVALID');
    if (!NET_CORRELATION_SOURCES.includes(rule.from)) {
      throw new BrowserError('NET_RULE_INVALID', `correlationRules[${index}].from 不合法`, { allowed: [...NET_CORRELATION_SOURCES] });
    }
    if (!rule.key) throw new BrowserError('NET_RULE_INVALID', `correlationRules[${index}].key 必填`);
    return {
      from: rule.from,
      key: truncateBytes(String(rule.key), 128),
      path: rule.path ? truncateBytes(String(rule.path), 256) : null,
      name: rule.name ? truncateBytes(String(rule.name), 128) : truncateBytes(String(rule.key), 128),
    };
  });
}

/**
 * §5.6 / R1-9 提取关联标识（默认规则 + 步骤追加规则）。返回 `{name, value, contentHash, source}`，
 * `value` 是脱敏显示值（原值只在内存里算 hash，不落库）。
 */
export function extractCorrelationIds(event, { headers = null, bodyText = null, extraRules = [], hmacKey = null } = {}) {
  const rules = [...DEFAULT_CORRELATION_RULES, ...extraRules];
  const ids = [];
  const push = (name, raw, source) => {
    if (raw === undefined || raw === null || String(raw) === '') return;
    const text = String(raw);
    const display = /^traceparent$/i.test(name) || text.length > 32 ? truncateBytes(text, 64) : text;
    ids.push({
      name,
      value: SENSITIVE_KEY.test(name) ? '***' : display,
      contentHash: hmacHex(hmacKey || store_hmac_fallback(), text, { full: true }),
      source,
    });
  };
  for (const rule of rules) {
    if (rule.from === 'header') {
      if (!headers) continue;
      const found = Object.entries(headers).find(([key]) => key.toLowerCase() === String(rule.key).toLowerCase());
      if (!found) continue;
      let value = found[1];
      if (String(rule.key).toLowerCase() === 'traceparent') {
        const parts = String(value).split('-');
        if (parts.length >= 4) value = parts[1];
      }
      push(rule.name, value, 'header');
    } else if (rule.from === 'url-query') {
      for (const pair of parseQueryString(event.url)) {
        if (pair.name.toLowerCase() === String(rule.key).toLowerCase()) push(rule.name, pair.value, 'query');
      }
    } else if (rule.from === 'json-body') {
      if (!bodyText) continue;
      let parsed;
      try { parsed = JSON.parse(bodyText); } catch { continue; }
      const found = readJsonPath(parsed, rule.path || rule.key);
      if (found.found) push(rule.name, found.value, 'jsonPath');
    }
  }
  const seen = new Set();
  return ids.filter((id) => {
    const key = id.name + '\u0000' + id.contentHash;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  }).slice(0, NET_LIMITS.correlationRules);
}

function store_hmac_fallback() { return 'no-key'; }

/** §5.2 业务状态码。 */
export function extractBusinessCode(parsedBody, explicitPath = null) {
  if (parsedBody === null || parsedBody === undefined || typeof parsedBody !== 'object') return { businessCode: null, businessCodePath: null };
  if (explicitPath) {
    const found = readJsonPath(parsedBody, explicitPath);
    if (found.found && found.value !== null && found.value !== undefined) {
      return { businessCode: Number.isFinite(Number(found.value)) ? Number(found.value) : String(found.value), businessCodePath: explicitPath };
    }
    return { businessCode: null, businessCodePath: explicitPath };
  }
  for (const path of DEFAULT_BUSINESS_PATHS) {
    const found = readJsonPath(parsedBody, path);
    if (found.found && typeof found.value === 'number' && Number.isFinite(found.value)) return { businessCode: found.value, businessCodePath: path };
  }
  return { businessCode: null, businessCodePath: null };
}

function objectRulesFor(store, event) {
  if (event && event.stepId) {
    const step = store.steps.get(event.stepId);
    if (step && step.objectRules.length) return step.objectRules;
  }
  for (const step of store.steps.values()) if (step.open && step.objectRules.length) return step.objectRules;
  return [];
}

function stepEvents(store, step, allEvents = null) {
  const events = allEvents || store.events;
  const to = step.window.toWallMs === null || step.window.toWallMs === undefined ? Number.POSITIVE_INFINITY : step.window.toWallMs;
  return events.filter((event) => event.ts.wallMs >= step.window.fromWallMs && event.ts.wallMs <= to);
}

function readObjectValue(store, event, rule) {
  const bodyOptions = { targetId: event.targetId, cdpSessionId: event.cdpSessionId, requestId: event.requestId, hopId: event.hopId };
  switch (rule.from) {
    case 'url-query': {
      for (const pair of parseQueryString(event.url)) {
        if (pair.name.toLowerCase() === String(rule.key || '').toLowerCase()) return truncateBytes(pair.value, 256);
      }
      return null;
    }
    case 'url-path': {
      let pathname = '';
      try { pathname = new URL(String(event.url || '')).pathname; } catch { return null; }
      const segments = pathname.split('/').filter((segment) => segment !== '');
      if (rule.path && /^\d+$/.test(rule.path)) {
        const segment = segments[Number(rule.path)];
        return segment === undefined ? null : truncateBytes(segment, 256);
      }
      if (rule.key) {
        const index = segments.findIndex((segment) => segment.toLowerCase() === String(rule.key).toLowerCase());
        if (index !== -1 && segments[index + 1] !== undefined) return truncateBytes(segments[index + 1], 256);
      }
      return null;
    }
    case 'header': {
      if (!rule.key || !event.requestId) return null;
      const record = store.readHeaders({ ...bodyOptions, kind: 'request' });
      const found = Object.entries(record.headers).find(([key]) => key.toLowerCase() === String(rule.key).toLowerCase());
      return found ? truncateBytes(found[1], 256) : null;
    }
    case 'json-body': {
      if (!event.requestId) return null;
      for (const kind of ['response', 'request']) {
        const body = store.readBody({ ...bodyOptions, kind });
        if (!body || body.state === 'unavailable' || body.payloadOmitted || body.originalBytes === 0) continue;
        let parsed;
        try { parsed = JSON.parse(body.data); } catch { continue; }
        const found = readJsonPath(parsed, rule.path || rule.key);
        if (found.found && found.value !== null && typeof found.value !== 'object') return truncateBytes(String(found.value), 256);
      }
      return null;
    }
    case 'ws': {
      if (!event.ws || !event.ws.payload) return null;
      let parsed;
      try { parsed = JSON.parse(event.ws.payload); } catch { return null; }
      const found = readJsonPath(parsed, rule.path || rule.key);
      return found.found && found.value !== null && typeof found.value !== 'object' ? truncateBytes(String(found.value), 256) : null;
    }
    case 'sse': {
      if (!event.sse || !event.sse.data) return null;
      let parsed;
      try { parsed = JSON.parse(event.sse.data); } catch { return null; }
      const found = readJsonPath(parsed, rule.path || rule.key);
      return found.found && found.value !== null && typeof found.value !== 'object' ? truncateBytes(String(found.value), 256) : null;
    }
    default: return null;
  }
}

function objectAppearsIn(store, event, value) {
  if (!value) return null;
  if (event.url && event.url.includes(value)) return 'url';
  if (!event.requestId) return null;
  const options = { targetId: event.targetId, cdpSessionId: event.cdpSessionId, requestId: event.requestId, hopId: event.hopId };
  const headers = store.readHeaders({ ...options, kind: 'request' });
  if (Object.values(headers.headers).some((headerValue) => String(headerValue).includes(value))) return 'header';
  for (const kind of ['request', 'response']) {
    const body = store.readBody({ ...options, kind });
    if (body && body.state !== 'unavailable' && !body.payloadOmitted && body.data.includes(value)) return 'body';
  }
  return null;
}

/**
 * §6.2 对象提取（只按显式规则）。规则名/键/路径命中敏感词的，值一律投影为 `***`（R1-9 / §8.4），
 * 避免把 token 类值经业务对象再次写出；事件本体不含 objects（只在 trace/detail 查询期投影）。
 */
export function extractObjects(store, step, events) {
  const rules = (step && step.objectRules) || [];
  if (!rules.length) return [];
  const objects = [];
  const maskRules = (store && store.config && Array.isArray(store.config.maskRules)) ? store.config.maskRules : [];
  for (const event of events) {
    for (const rule of rules) {
      const sensitive = SENSITIVE_KEY.test([rule.name, rule.key, rule.path].filter(Boolean).join(' '))
        || maskRules.some((mask) => String(mask).length > 0 && String(rule.name || '').toLowerCase().endsWith(String(mask).toLowerCase()));
      const value = sensitive ? (readObjectValue(store, event, rule) === null ? null : '***') : readObjectValue(store, event, rule);
      if (value === null) continue;
      const id = rule.name + ':' + value;
      let object = objects.find((item) => item.id === id);
      if (!object) {
        object = {
          id, key: rule.key, name: rule.name, from: rule.from, path: rule.path, value,
          firstSeq: event.seq, lastSeq: event.seq, events: [], propagate: rule.propagate === true, propagation: [],
        };
        objects.push(object);
      }
      object.lastSeq = event.seq;
      if (!object.events.includes(event.seq)) object.events.push(event.seq);
      if (object.events.length > NET_LIMITS.objectEvents) object.events = object.events.slice(-NET_LIMITS.objectEvents);
    }
  }
  for (const object of objects) {
    if (!object.propagate) continue;
    for (const event of store.events) {
      if (event.seq <= object.lastSeq) continue;
      const where = objectAppearsIn(store, event, object.value);
      if (where) object.propagation.push({ fromSeq: object.lastSeq, toSeq: event.seq, where, basis: 'observed' });
      if (object.propagation.length >= 20) break;
    }
  }
  return objects;
}

function businessStates(store, step, events) {
  const states = [];
  let previous = null;
  const path = (step && step.businessStatusPath) || (store && store.config ? store.config.businessStatusPath : null) || null;
  for (const event of events) {
    if (event.kind !== 'http' || !['response', 'finished', 'failed'].includes(event.phase)) continue;
    let code = event.business ? event.business.businessCode : null;
    if (code === null && store && event.requestId) {
      // The body is captured after `finished` was written, so derive the business code at query time.
      const stored = store.readBody({
        targetId: event.targetId, cdpSessionId: event.cdpSessionId, requestId: event.requestId, hopId: event.hopId, kind: 'response',
      });
      if (stored && stored.state === 'captured' && !stored.payloadOmitted) {
        let parsed = null;
        try { parsed = JSON.parse(stored.data); } catch { parsed = null; }
        code = extractBusinessCode(parsed, path).businessCode;
      }
    }
    const current = { status: event.status, code };
    if (previous && (previous.status !== current.status || previous.code !== current.code)) {
      states.push({
        atWallMs: event.ts.wallMs, seq: event.seq,
        from: previous.code !== null ? previous.code : previous.status,
        to: current.code !== null ? current.code : current.status,
        field: previous.code !== current.code ? 'businessCode' : 'httpStatus',
        basis: 'observed',
      });
    }
    previous = current;
  }
  return states;
}

/** §5.5/§6.4 轮询：键 = method + origin+path + bodyHash（query 不计），R1-17。 */
export function detectPolling(events) {
  const groups = new Map();
  for (const event of events) {
    if (event.kind !== 'http' || !event.url || event.phase !== 'request') continue;
    let key;
    try {
      const parsed = new URL(event.url);
      key = (event.method || 'GET') + ' ' + parsed.origin + parsed.pathname;
    } catch { key = (event.method || 'GET') + ' ' + event.url; }
    const list = groups.get(key) || [];
    list.push(event);
    groups.set(key, list);
  }
  const polling = [];
  for (const [groupKey, list] of groups.entries()) {
    if (list.length < 3) continue;
    const sorted = [...list].sort((left, right) => left.ts.wallMs - right.ts.wallMs);
    const intervals = [];
    for (let index = 1; index < sorted.length; index += 1) intervals.push(sorted[index].ts.wallMs - sorted[index - 1].ts.wallMs);
    const average = intervals.reduce((sum, value) => sum + value, 0) / intervals.length;
    if (average > NET_LIMITS.pollWindowMs || average <= 0) continue;
    if (!intervals.every((value) => Math.abs(value - average) <= average * NET_LIMITS.pollIntervalTolerance)) continue;
    polling.push({ groupKey, count: sorted.length, intervalMs: Math.round(average), firstSeq: sorted[0].seq, lastSeq: sorted[sorted.length - 1].seq });
  }
  return polling.slice(0, 20);
}

/** §5.5 重试/重复：键用未脱敏 URL 的 urlHash（R1-9）。 */
export function detectRetries(events) {
  const groups = new Map();
  for (const event of events) {
    if (event.kind !== 'http' || event.phase !== 'response' || !event.url) continue;
    const key = (event.method || 'GET') + ' ' + (event.urlHash || event.url);
    const list = groups.get(key) || [];
    list.push(event);
    groups.set(key, list);
  }
  const patterns = [];
  for (const [groupKey, list] of groups.entries()) {
    if (list.length < 2) continue;
    const sorted = [...list].sort((left, right) => left.ts.wallMs - right.ts.wallMs);
    let pattern = null;
    for (let index = 1; index < sorted.length; index += 1) {
      const previous = sorted[index - 1];
      const current = sorted[index];
      if (current.ts.wallMs - previous.ts.wallMs > NET_LIMITS.retryWindowMs) continue;
      if (previous.failed || (Number.isInteger(previous.status) && previous.status >= 500)) pattern = 'retry';
      else if (pattern === null) pattern = 'duplicate';
    }
    if (pattern) patterns.push({ groupKey, pattern, count: sorted.length, seqs: sorted.map((event) => event.seq).slice(0, 20) });
  }
  return patterns.slice(0, 20);
}

function buildCausality(store, events, { includeTemporal = false } = {}) {
  const causality = [];
  const seqSet = new Set(events.map((event) => event.seq));
  for (const event of events) {
    for (const link of (store.links.get(event.seq) || [])) {
      if (link.stepId) causality.push({ seq: event.seq, parentSeq: null, basis: 'explicit', stepId: link.stepId });
    }
    if (event.redirect) causality.push({ seq: event.seq, parentSeq: null, basis: 'redirect', url: event.redirect.from });
    if (event.initiator && event.initiator.requestId) {
      const parent = store.events.find((item) => item.requestId === event.initiator.requestId);
      if (parent && seqSet.has(parent.seq)) causality.push({ seq: event.seq, parentSeq: parent.seq, basis: 'initiator' });
    }
  }
  if (includeTemporal) {
    const ordered = [...events].sort((left, right) => left.seq - right.seq);
    for (let index = 1; index < ordered.length; index += 1) {
      causality.push({ seq: ordered[index].seq, parentSeq: ordered[index - 1].seq, basis: 'temporal' });
    }
  }
  return causality;
}


/** §6.3 观察序列（`states` 只记变化；这里给出每一步的可观测状态，便于断言与排错）。 */
function businessObservations(store, step, events) {
  const path = (step && step.businessStatusPath) || (store && store.config ? store.config.businessStatusPath : null) || null;
  const out = [];
  for (const event of events) {
    if (event.kind !== 'http' || !['response', 'finished', 'failed'].includes(event.phase)) continue;
    let code = event.business ? event.business.businessCode : null;
    if (code === null && store && event.requestId) {
      const stored = store.readBody({
        targetId: event.targetId, cdpSessionId: event.cdpSessionId, requestId: event.requestId, hopId: event.hopId, kind: 'response',
      });
      if (stored && stored.state === 'captured' && !stored.payloadOmitted) {
        let parsed = null;
        try { parsed = JSON.parse(stored.data); } catch { parsed = null; }
        code = extractBusinessCode(parsed, path).businessCode;
      }
    }
    out.push({ seq: event.seq, wallMs: event.ts.wallMs, status: event.status, businessCode: code, businessCodePath: path });
    if (out.length >= NET_LIMITS.objectEvents) break;
  }
  return out;
}

function stepView(store, step) {
  const events = stepEvents(store, step);
  return {
    // `stepId` is the canonical key; `id` is kept as an alias for callers that use it.
    stepId: step.stepId,
    id: step.stepId,
    name: step.name,
    labels: step.labels,
    state: step.open ? 'open' : 'closed',
    window: { ...step.window },
    fromSeq: step.fromSeq,
    toSeq: step.toSeq,
    objectRules: step.objectRules,
    businessStatusPath: step.businessStatusPath,
    objects: extractObjects(store, step, events),
    states: businessStates(store, step, events),
    observations: businessObservations(store, step, events),
    counters: { events: events.length },
  };
}

/** `browser_network_trace` 执行体（§2.4）。 */
export function traceNetwork(store, params = {}) {
  assertKnownKeys(params, ['sessionId', 'action', 'stepId', 'name', 'labels', 'window', 'objectRules',
    'correlationRules', 'businessStatusPath', 'mark', 'link', 'query', 'includeTemporal',
    'seq', 'requestId', 'evidenceId',
    // §2.4 also allows the query knobs at the top level (`{action:'query', limit, sinceMs}`).
    'limit', 'sinceMs'], 'trace');
  assertSession(store, params.sessionId);
  const action = params.action;
  if (!NET_TRAIL_ACTIONS.includes(action)) {
    throw new BrowserError('NET_INVALID_ARGUMENT', 'trace.action 不合法: ' + String(action), { field: 'action', allowed: [...NET_TRAIL_ACTIONS] });
  }
  const base = { ok: true, action, sessionId: store.session ? store.session.id : null };
  if (action === 'begin-step') {
    const step = store.beginStep({
      stepId: params.stepId, name: params.name, labels: params.labels, window: params.window,
      businessStatusPath: params.businessStatusPath, objectRules: params.objectRules, correlationRules: params.correlationRules,
    });
    return { ...base, steps: [stepView(store, step)], events: [], objects: [], states: [], causality: [],
      evidence: evidenceBlock(store, 'trace', { fromSeq: step.fromSeq, toSeq: store.seq }) };
  }
  if (action === 'end-step') {
    if (!params.stepId) throw new BrowserError('NET_INVALID_ARGUMENT', 'end-step 需要 stepId');
    const existing = store.steps.get(String(params.stepId));
    if (existing && params.objectRules && existing.objectRules.length === 0) existing.objectRules = validateObjectRules(params.objectRules);
    if (existing && params.businessStatusPath) existing.businessStatusPath = truncateBytes(String(params.businessStatusPath), 256);
    const step = store.endStep({ stepId: params.stepId, window: params.window });
    const stepEventsList = stepEvents(store, step);
    const view = stepView(store, step);
    return {
      ...base,
      steps: [view],
      // The closed step's own events/objects/states are returned inline so a caller does not have
      // to issue a second `query` (C26).
      events: stepEventsList.slice(0, NET_LIMITS.eventPageLimit).map((event) => projectSummary(store, event)),
      objects: view.objects,
      states: view.states,
      observations: view.observations,
      causality: buildCausality(store, stepEventsList, { includeTemporal: params.includeTemporal === true }),
      evidence: evidenceBlock(store, 'trace', { fromSeq: step.fromSeq, toSeq: step.toSeq || store.seq }),
    };
  }
  if (action === 'mark') {
    const mark = params.mark || {};
    const event = store.mark({
      kind: mark.kind || 'note', text: mark.text, tool: mark.tool, actionId: mark.actionId,
      stepId: mark.stepId || params.stepId,
    });
    return { ...base, events: event ? [projectSummary(store, event)] : [], steps: [], objects: [], states: [], causality: [],
      evidence: evidenceBlock(store, 'trace', { fromSeq: event ? event.seq : store.seq, toSeq: store.seq }) };
  }
  if (action === 'link') {
    // §2.4 lists both a nested `link` object and top-level `seq`/`requestId`; accept either form.
    const link = params.link || {};
    const linked = store.link({
      seq: Number.isInteger(link.seq) ? link.seq : (Number.isInteger(params.seq) ? params.seq : null),
      requestId: link.requestId || params.requestId || null,
      stepId: link.stepId || params.stepId || null,
      evidenceId: link.evidenceId || params.evidenceId || null,
    });
    const event = store.events.find((item) => item.seq === linked.seq);
    return { ...base, link: linked, events: event ? [projectSummary(store, event)] : [], steps: [], objects: [], states: [], causality: [],
      evidence: evidenceBlock(store, 'trace', { fromSeq: linked.seq, toSeq: linked.seq }) };
  }
  if (action === 'window') {
    const range = params.window && typeof params.window === 'object' ? params.window : null;
    const events = range
      ? store.events.filter((event) => (Number.isFinite(range.fromWallMs) ? event.ts.wallMs >= range.fromWallMs : true)
        && (Number.isFinite(range.toWallMs) ? event.ts.wallMs <= range.toWallMs : true))
      : [];
    return {
      ...base,
      windows: [...store.steps.values()].map((step) => ({
        stepId: step.stepId, name: step.name, open: step.open, window: { ...step.window }, fromSeq: step.fromSeq, toSeq: step.toSeq,
      })),
      window: range ? { fromWallMs: range.fromWallMs ?? null, toWallMs: range.toWallMs ?? null, matched: events.length } : null,
      steps: [...store.steps.values()].map((step) => stepView(store, step)),
      events: events.slice(0, NET_LIMITS.eventPageLimit).map((event) => projectSummary(store, event)),
      evidence: evidenceBlock(store, 'trace'),
    };
  }
  if (action === 'reset') {
    store.steps.clear();
    store.links.clear();
    return { ...base, reset: true, evidence: evidenceBlock(store, 'trace') };
  }
  const query = params.query || {};
  assertKnownKeys(query, ['stepId', 'sinceMs', 'limit'], 'query');
  const requestedLimit = query.limit === undefined ? params.limit : query.limit;
  const limit = clampInt(requestedLimit === undefined ? NET_LIMITS.eventPageDefault : requestedLimit, 1, NET_LIMITS.eventPageLimit);
  const onlyStep = query.stepId ? String(query.stepId) : (params.stepId ? String(params.stepId) : null);
  const sinceMs = Number.isFinite(query.sinceMs) ? query.sinceMs : (Number.isFinite(params.sinceMs) ? params.sinceMs : null);
  const steps = onlyStep ? [store.steps.get(onlyStep)].filter(Boolean) : [...store.steps.values()];
  if (onlyStep && steps.length === 0) throw new BrowserError('NET_EVENT_NOT_FOUND', '步骤不存在: ' + onlyStep, { stepId: onlyStep });
  const views = [];
  let truncated = false;
  for (const step of steps) {
    const events = stepEvents(store, step).filter((event) => sinceMs === null || event.ts.wallMs >= sinceMs);
    const objects = extractObjects(store, step, events);
    const states = businessStates(store, step, events);
    const evidence = events
      .flatMap((event) => {
        const projection = store.linkProjection ? store.linkProjection(event) : { evidenceIds: event.evidenceIds };
        return projection.evidenceIds.map((evidenceId) => ({ evidenceId, seqs: [event.seq], kind: 'event' }));
      });
    const causality = buildCausality(store, events, { includeTemporal: params.includeTemporal === true });
    const closedAt = step.open || !Number.isFinite(step.window.toWallMs) ? null : step.window.toWallMs;
    const inStepUrls = new Set(events.map((event) => event.url).filter(Boolean));
    const afterClose = closedAt === null ? 0
      : store.events.filter((event) => event.ts.wallMs > closedAt && event.url && inStepUrls.has(event.url)).length;
    if (events.length > limit) truncated = true;
    views.push({
      stepId: step.stepId,
      id: step.stepId,
      name: step.name,
      state: step.open ? 'open' : 'closed',
      window: { ...step.window },
      fromSeq: step.fromSeq,
      toSeq: step.toSeq,
      counters: {
        events: events.length,
        http: events.filter((event) => event.kind === 'http').length,
        ws: events.filter((event) => event.kind === 'ws').length,
        sse: events.filter((event) => event.kind === 'sse').length,
        failures: events.filter((event) => event.failed).length,
        asyncAfterClose: afterClose,
      },
      objects: objects.map((object) => ({
        name: object.name,
        value: object.value,
        source: { seq: object.firstSeq, requestId: (store.events.find((event) => event.seq === object.firstSeq) || {}).requestId || null, from: object.from, path: object.path },
        propagation: object.propagation,
      })),
      states,
      observations: businessObservations(store, step, events),
      evidence,
      causality,
      events: events.slice(0, limit).map((event) => projectSummary(store, event)),
    });
  }
  const allEvents = steps.flatMap((step) => stepEvents(store, step));
  return {
    ...base,
    steps: views,
    events: allEvents.slice(0, limit).map((event) => projectSummary(store, event)),
    objects: views.flatMap((view) => view.objects),
    states: views.flatMap((view) => view.states),
    causality: views.flatMap((view) => view.causality),
    polling: detectPolling(allEvents),
    patterns: detectRetries(allEvents),
    async: views.flatMap((view) => {
      const step = store.steps.get(view.id);
      if (!step || step.open || !Number.isFinite(step.window.toWallMs)) return [];
      const closedAt = step.window.toWallMs;
      const urls = new Set(view.events.map((event) => event.url).filter(Boolean));
      return store.events
        .filter((event) => event.ts.wallMs > closedAt && event.url && urls.has(event.url))
        .slice(0, 20)
        .map((event) => ({ seq: event.seq, stepId: view.id, delayMs: Math.round(event.ts.wallMs - closedAt) }));
    }),
    truncated,
    limits: { steps: NET_LIMITS.steps, objects: NET_LIMITS.objectRules, events: limit },
    evidence: evidenceBlock(store, 'trace', { truncated }),
  };
}

/* ------------------------------------------------------------------ */
/* 控制：规则 / 网络条件 / hold（§2.5 / §7 + R1-7 / R1-8 / R1-13）       */
/* ------------------------------------------------------------------ */

const RULE_FIELDS = Object.freeze(['id', 'pattern', 'behavior']);
const RULE_BEHAVIOR_FIELDS = Object.freeze(['kind', 'headers', 'body', 'status', 'delayMs', 'fromRequestId', 'errorReason', 'url']);

export function validateRule(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new BrowserError('NET_RULE_INVALID', 'rule 必须是对象');
  assertKnownKeys(input, RULE_FIELDS, 'rule', 'NET_RULE_INVALID');
  const pattern = input.pattern;
  if (!pattern || typeof pattern !== 'object' || Array.isArray(pattern)) throw new BrowserError('NET_RULE_INVALID', 'rule 缺少 pattern');
  assertKnownKeys(pattern, ['urlPattern', 'resourceType', 'method'], 'rule.pattern', 'NET_RULE_INVALID');
  if (typeof pattern.urlPattern !== 'string' || pattern.urlPattern.trim() === '' || pattern.urlPattern.length > 512) {
    throw new BrowserError('NET_RULE_INVALID', 'rule.pattern.urlPattern 必填且 ≤512 字符');
  }
  const behavior = input.behavior;
  if (!behavior || typeof behavior !== 'object' || Array.isArray(behavior)) throw new BrowserError('NET_RULE_INVALID', 'rule 缺少 behavior');
  assertKnownKeys(behavior, RULE_BEHAVIOR_FIELDS, 'rule.behavior', 'NET_RULE_INVALID');
  if (!NET_RULE_KINDS.includes(behavior.kind)) {
    throw new BrowserError('NET_RULE_INVALID', 'rule.behavior.kind 不合法: ' + String(behavior.kind), { allowed: [...NET_RULE_KINDS] });
  }
  if (behavior.kind === 'delay' && (!Number.isInteger(behavior.delayMs) || behavior.delayMs < 0 || behavior.delayMs > 60000)) {
    throw new BrowserError('NET_RULE_INVALID', 'delay 规则需要 delayMs（0–60000 整数）');
  }
  if (['fulfill', 'modify-response'].includes(behavior.kind) && behavior.status !== undefined && behavior.status !== null
    && (!Number.isInteger(behavior.status) || behavior.status < 100 || behavior.status > 599)) {
    throw new BrowserError('NET_RULE_INVALID', 'status 必须是 100–599 整数');
  }
  if (behavior.kind === 'modify-request' && behavior.url !== undefined && behavior.url !== null
    && (typeof behavior.url !== 'string' || !/^https?:\/\//i.test(behavior.url))) {
    throw new BrowserError('NET_RULE_INVALID', 'modify-request.url 必须是 http(s) 绝对地址');
  }
  let headers = null;
  if (behavior.headers !== undefined && behavior.headers !== null) {
    if (typeof behavior.headers !== 'object' || Array.isArray(behavior.headers)) throw new BrowserError('NET_RULE_INVALID', 'behavior.headers 必须是对象');
    const entries = Object.entries(behavior.headers);
    if (entries.length > 32) throw new BrowserError('NET_RULE_INVALID', 'behavior.headers 最多 32 项');
    headers = {};
    for (const [name, value] of entries) {
      if (!/^[A-Za-z0-9!#$%&'*+\-.^_`|~]+$/.test(name)) throw new BrowserError('NET_RULE_INVALID', '头部名不合法: ' + name);
      const text = String(value);
      if (Buffer.byteLength(text, 'utf8') > 4096) throw new BrowserError('NET_RULE_INVALID', '头部值超过 4096 字节: ' + name);
      headers[name] = text;
    }
  }
  let body = null;
  if (behavior.body !== undefined && behavior.body !== null) {
    if (typeof behavior.body !== 'string') throw new BrowserError('NET_RULE_INVALID', 'behavior.body 必须是字符串');
    if (Buffer.byteLength(behavior.body, 'utf8') > NET_LIMITS.ruleBodyBytes) {
      throw new BrowserError('NET_RULE_INVALID', 'behavior.body 超过 ' + NET_LIMITS.ruleBodyBytes + ' 字节');
    }
    body = behavior.body;
  }
  return {
    id: input.id ? truncateBytes(String(input.id), 64) : null,
    pattern: {
      urlPattern: pattern.urlPattern,
      resourceType: pattern.resourceType ? truncateBytes(String(pattern.resourceType), 32) : null,
      method: pattern.method ? truncateBytes(String(pattern.method).toUpperCase(), 16) : null,
    },
    behavior: {
      kind: behavior.kind,
      headers,
      body,
      url: behavior.url ? truncateBytes(String(behavior.url), NET_LIMITS.urlBytes) : null,
      status: Number.isInteger(behavior.status) ? behavior.status : null,
      delayMs: Number.isInteger(behavior.delayMs) ? behavior.delayMs : null,
      fromRequestId: behavior.fromRequestId ? truncateBytes(String(behavior.fromRequestId), 128) : null,
      errorReason: behavior.errorReason ? truncateBytes(String(behavior.errorReason), 32) : null,
    },
  };
}

export function validateThen(then) {
  if (then === undefined || then === null) return { kind: 'continue', headers: null, body: null, status: null, errorReason: null };
  assertKnownKeys(then, ['kind', 'headers', 'body', 'status', 'errorReason'], 'then', 'NET_RULE_INVALID');
  const kind = then.kind === undefined ? 'continue' : then.kind;
  if (!NET_THEN_KINDS.includes(kind)) throw new BrowserError('NET_RULE_INVALID', 'then.kind 不合法: ' + String(kind), { allowed: [...NET_THEN_KINDS] });
  return {
    kind,
    headers: then.headers && typeof then.headers === 'object'
      ? Object.fromEntries(Object.entries(then.headers).slice(0, 32).map(([key, value]) => [String(key), truncateBytes(String(value), 4096)]))
      : null,
    body: typeof then.body === 'string' ? truncateBytes(then.body, NET_LIMITS.ruleBodyBytes) : null,
    status: Number.isInteger(then.status) ? then.status : null,
    errorReason: then.errorReason ? truncateBytes(String(then.errorReason), 32) : null,
  };
}

/**
 * `fetch()` from page script is reported by Chromium as `XHR`, while humans (and the docs) call it
 * `Fetch`. Both names match each other so a rule written either way behaves the same; any other
 * resource type is still strict. A pattern may also list an array of accepted types.
 */
const RESOURCE_TYPE_ALIASES = Object.freeze({
  fetch: ['fetch', 'xhr'],
  xhr: ['xhr', 'fetch'],
});

function resourceTypeMatches(patternType, actualType) {
  if (patternType === undefined || patternType === null || patternType === '') return true;
  const wanted = Array.isArray(patternType) ? patternType.map((item) => String(item).toLowerCase()) : [String(patternType).toLowerCase()];
  const actual = String(actualType || '').toLowerCase();
  for (const name of wanted) {
    const accepted = RESOURCE_TYPE_ALIASES[name] || [name];
    if (accepted.includes(actual)) return true;
  }
  return false;
}

export function matchRule(rule, { url, resourceType, method } = {}) {
  if (!rule || !rule.pattern) return false;
  if (!matchUrlPattern(rule.pattern.urlPattern, url || '')) return false;
  if (!resourceTypeMatches(rule.pattern.resourceType, resourceType)) return false;
  if (rule.pattern.method && String(rule.pattern.method).toUpperCase() !== String(method || '').toUpperCase()) return false;
  return true;
}

export function firstMatchingRule(rules, target) {
  for (const rule of rules) if (matchRule(rule, target)) return rule;
  return null;
}

/** §7.3 / R1-8：唯一一份 `Fetch.enable` patterns（Document 守卫 + 活动规则）。 */
export function buildFetchPatterns({ documentPatterns = [{ urlPattern: '*', resourceType: 'Document', requestStage: 'Request' }], rules = [] } = {}) {
  const patterns = [];
  const seen = new Set();
  const push = (urlPattern, resourceType, requestStage = 'Request') => {
    const key = String(urlPattern) + '\u0000' + String(resourceType || '') + '\u0000' + requestStage;
    if (seen.has(key)) return;
    seen.add(key);
    patterns.push({ urlPattern, resourceType, requestStage });
  };
  for (const pattern of documentPatterns) push(pattern.urlPattern, pattern.resourceType, pattern.requestStage || 'Request');
  for (const rule of rules) {
    push(rule.pattern.urlPattern, rule.pattern.resourceType || undefined,
      rule.behavior.kind === 'modify-response' ? 'Response' : 'Request');
  }
  return patterns;
}

/** §7.3 / R1-8 分流决策：Document 守卫优先，其次首条命中规则，最后 continue。 */
export function decidePausedAction({ resourceType, request, rules } = {}) {
  if (String(resourceType || '') === 'Document') return { action: 'guard' };
  const rule = firstMatchingRule(rules || [], { url: request && request.url, method: request && request.method, resourceType });
  if (!rule) return { action: 'continue' };
  return rule.behavior.kind === 'hold' ? { action: 'hold', rule } : { action: 'rule', rule };
}

/** R1-13：throttle/offline 组合状态 → `Network.emulateNetworkConditions`（Kbps = 1024 bit/s）。 */
export function conditionParams({ offline = false, latencyMs = 0, downloadKbps = 0, uploadKbps = 0 } = {}) {
  if (!Number.isFinite(latencyMs) || latencyMs < 0 || latencyMs > 60000) {
    throw new BrowserError('NET_INVALID_ARGUMENT', 'latencyMs 必须在 0–60000', { field: 'latencyMs' });
  }
  const toBps = (kbps, label) => {
    if (!Number.isFinite(kbps) || kbps < 0 || kbps > 1000000) {
      throw new BrowserError('NET_INVALID_ARGUMENT', label + ' 必须在 0–1000000', { field: label });
    }
    return kbps === 0 ? -1 : Math.round((kbps * 1024) / 8);
  };
  if (offline) {
    return { offline: true, latency: Math.round(latencyMs), downloadThroughput: 0, uploadThroughput: 0 };
  }
  return {
    offline: false,
    latency: Math.round(latencyMs),
    downloadThroughput: toBps(downloadKbps, 'downloadKbps'),
    uploadThroughput: toBps(uploadKbps, 'uploadKbps'),
  };
}

export const NETWORK_UNTHROTTLED = Object.freeze({ offline: false, latency: 0, downloadThroughput: -1, uploadThroughput: -1 });

/** 控制面状态（每个 Runtime 一个）。定时器由 Host 驱动（`expiredHolds`）。 */
export class ControlState {
  constructor({ now = () => Date.now(), holdTimeoutMs = NET_LIMITS.holdTimeoutMs } = {}) {
    this.now = now;
    this.holdTimeoutMs = holdTimeoutMs;
    this.rules = [];
    this.nextId = 1;
    this.held = new Map();
    this.condition = { offline: false, latencyMs: 0, downloadKbps: 0, uploadKbps: 0 };
    this.hits = new Map();
    this.resumed = 0;
    this.holdTimeouts = 0;
    this.heldOverflow = 0;
    this.responseModification = null;
    this.applyFailures = [];
  }

  addRule(input) {
    const rule = validateRule(input);
    if (rule.id === null) {
      let candidate;
      do { candidate = 'rule-' + this.nextId; this.nextId += 1; } while (this.rules.some((item) => item.id === candidate));
      rule.id = candidate;
    }
    if (this.rules.some((item) => item.id === rule.id)) {
      throw new BrowserError('NET_RULE_CONFLICT', '规则 id 已存在: ' + rule.id, { ruleId: rule.id });
    }
    if (this.rules.length >= NET_LIMITS.rules) {
      throw new BrowserError('NET_QUOTA_EXCEEDED', '规则数超出上限 ' + NET_LIMITS.rules, { max: NET_LIMITS.rules });
    }
    if (rule.behavior.kind === 'modify-response' && this.responseModification === false) {
      throw new BrowserError('NET_CONTROL_UNAVAILABLE', '当前 CDP 不支持 Fetch.continueResponse，无法做响应修改', { capability: 'responseModification' });
    }
    this.rules.push(rule);
    return rule;
  }

  removeRule(id) {
    const index = this.rules.findIndex((item) => item.id === String(id));
    if (index === -1) throw new BrowserError('NET_RULE_INVALID', '规则不存在: ' + String(id), { ruleId: String(id) });
    const [rule] = this.rules.splice(index, 1);
    this.hits.delete(rule.id);
    return rule;
  }

  clearRules() {
    const count = this.rules.length;
    this.rules = [];
    this.hits.clear();
    return { cleared: count };
  }

  noteHit(ruleId) { if (ruleId) this.hits.set(ruleId, (this.hits.get(ruleId) || 0) + 1); }

  listRules() { return this.rules.map((rule) => ({ ...rule, hits: this.hits.get(rule.id) || 0 })); }

  /** 组合状态：throttle 与 offline 互不覆盖（R1-13）。 */
  setThrottle({ latencyMs = 0, downloadKbps = 0, uploadKbps = 0 } = {}) {
    this.condition = { ...this.condition, latencyMs, downloadKbps, uploadKbps };
    return this.conditions();
  }

  setOffline(offline) {
    this.condition = { ...this.condition, offline: offline === true };
    return this.conditions();
  }

  conditions() { return conditionParams(this.condition); }

  resetConditions() {
    this.condition = { offline: false, latencyMs: 0, downloadKbps: 0, uploadKbps: 0 };
    return this.conditions();
  }

  holdRequest({ requestId, url = null, method = null, resourceType = null, ruleId = null } = {}) {
    if (!requestId) throw new BrowserError('NET_INVALID_ARGUMENT', 'hold 需要 requestId');
    if (this.held.size >= NET_LIMITS.held) {
      this.heldOverflow += 1;
      throw new BrowserError('NET_QUOTA_EXCEEDED', '同时 hold 的请求超出上限 ' + NET_LIMITS.held, { max: NET_LIMITS.held });
    }
    const entry = {
      requestId: String(requestId), url: url ? sanitizeUrl(url).value : null,
      method: method ? String(method) : null, resourceType: resourceType ? String(resourceType) : null,
      ruleId, heldAt: this.now(), expiresAt: this.now() + this.holdTimeoutMs,
    };
    this.held.set(entry.requestId, entry);
    return entry;
  }

  releaseHold(requestId, { timedOut = false } = {}) {
    const entry = this.held.get(String(requestId));
    if (!entry) return null;
    this.held.delete(String(requestId));
    if (timedOut) this.holdTimeouts += 1; else this.resumed += 1;
    return { ...entry, timedOut };
  }

  listHeld() { return [...this.held.values()].map((entry) => ({ ...entry })); }

  expiredHolds(nowMs = this.now()) {
    return [...this.held.values()].filter((entry) => entry.expiresAt <= nowMs).map((entry) => ({ ...entry }));
  }

  snapshot() {
    return {
      rules: this.listRules(),
      condition: { ...this.condition },
      params: this.conditions(),
      held: this.listHeld(),
      responseModification: this.responseModification,
      counters: { resumed: this.resumed, holdTimeouts: this.holdTimeouts, heldOverflow: this.heldOverflow },
      applyFailures: [...this.applyFailures].slice(-10),
      limits: { rules: NET_LIMITS.rules, held: NET_LIMITS.held, holdTimeoutMs: this.holdTimeoutMs },
    };
  }
}

/* ------------------------------------------------------------------ */
/* 证据：JSONL / HAR / 索引（§2.6 §8.1 §8.2 §8.3 + R1-3 / R1-4 / R1-14） */
/* ------------------------------------------------------------------ */

function pathFail(reason, message, extra = {}) {
  return { ok: false, code: 'NET_OUTPUT_PATH_INVALID', message, details: { reason, ...extra } };
}

/**
 * 证据路径解析（R1-4 / §8.1）：必须落在持久根内、相对路径、禁 `..`/反斜杠/NUL、限长、
 * 目录 realpath 复验；扩展名 `.jsonl`/`.har`。**不允许暂存导出**。
 */
export function resolveEvidencePath({ root, out, defaultName, extensions = ['.jsonl', '.har'] } = {}) {
  if (typeof root !== 'string' || root.trim() === '' || !isAbsolute(root)) return pathFail('root_not_absolute', '证据根必须是绝对路径');
  let canonicalRoot;
  try {
    const info = statSync(root);
    if (!info.isDirectory()) return pathFail('root_not_directory', '证据根不是目录');
    canonicalRoot = realpathSync(root);
  } catch {
    return pathFail('root_unavailable', '证据根不可用');
  }
  const requested = out === undefined || out === null ? defaultName : out;
  if (typeof requested !== 'string' || requested.trim() === '') return pathFail('out_missing', '证据输出路径不能为空');
  if (requested.includes('\0')) return pathFail('out_nul', '证据输出路径不能含 NUL');
  if (requested.includes('\\')) return pathFail('out_backslash', '证据输出路径必须使用 POSIX 分隔符');
  if (/^[A-Za-z]:/.test(requested) || isAbsolute(requested) || requested.startsWith('//')) {
    return pathFail('out_absolute', '证据输出路径必须是持久根内的相对路径');
  }
  if (Buffer.byteLength(requested, 'utf8') > 200) return pathFail('out_too_long', '证据输出路径超过 200 字节');
  const segments = requested.split('/');
  for (const segment of segments) {
    if (segment === '' || segment === '.' || segment === '..') return pathFail('out_segment', '证据输出路径不能含空段、"." 或 ".."');
    if (Buffer.byteLength(segment, 'utf8') > 100) return pathFail('out_segment_too_long', '证据输出路径单段超过 100 字节');
  }
  const name = segments[segments.length - 1];
  if (!extensions.some((extension) => name.endsWith(extension))) {
    return pathFail('out_extension', '证据文件扩展名必须是 ' + extensions.join(' / '), { extensions });
  }
  const inside = (parent, child) => {
    const rel = relativePath(parent, child);
    return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
  };
  const targetAbsolute = resolvePath(canonicalRoot, requested);
  if (!inside(canonicalRoot, targetAbsolute)) return pathFail('out_escape', '证据输出路径逃出持久根');
  let dir;
  try {
    mkdirSync(dirname(targetAbsolute), { recursive: true });
    dir = realpathSync(dirname(targetAbsolute));
  } catch (error) {
    return pathFail('dir_create_failed', '证据输出目录创建失败', { code: error && error.code ? String(error.code) : null });
  }
  if (!inside(canonicalRoot, dir) && dir !== canonicalRoot) return pathFail('dir_escape', '证据输出目录解析到根之外');
  const absolutePath = resolvePath(dir, name);
  const rel = relativePath(canonicalRoot, absolutePath).split(sep).join('/');
  if (rel === '' || rel.startsWith('../') || rel === '..' || isAbsolute(rel)) return pathFail('out_escape', '证据输出路径逃出持久根');
  return { ok: true, root: canonicalRoot, dir, relativePath: rel, absolutePath };
}

/** 原子 no-clobber 写（复用 capture-p0 提交点语义）。 */
export function publishEvidence(dir, absolutePath, bytes, { mode = 0o600 } = {}) {
  const buffer = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes);
  return publishCapture(dir, absolutePath, buffer, { mode });
}

/** R1-3 / §8.1：JSONL 每行一条标准化事件（无 `type` 外壳）；`seq:0` 是 session-meta marker。 */
export function toJsonl(store, { includeBodies = false } = {}) {
  const lines = [];
  const metaMarker = {
    seq: 0,
    sessionId: store.session ? store.session.id : null,
    kind: 'marker',
    phase: 'session-meta',
    version: NET_VERSION,
    session: store.session ? { ...store.session, state: store.state } : null,
    config: { ...store.config },
    limits: limitsView(),
    createdAt: store.now(),
    counters: { ...store.counters },
    integrity: store.integrity(),
  };
  lines.push(JSON.stringify(metaMarker));
  const lastEventOfChain = new Map();
  for (const event of store.events) {
    if (!event.requestId) continue;
    const key = requestKey(event);
    const chain = store.chains.get(key);
    if (chain && chain.lastSeq === event.seq) lastEventOfChain.set(key, event.seq);
  }
  for (const event of store.events) {
    const record = { ...event };
    if (includeBodies && event.requestId && lastEventOfChain.get(requestKey(event)) === event.seq) {
      const options = { targetId: event.targetId, cdpSessionId: event.cdpSessionId, requestId: event.requestId, hopId: event.hopId };
      const request = store.readBody({ ...options, kind: 'request' });
      const response = store.readBody({ ...options, kind: 'response' });
      // TOOL-P1-04：不把 `unavailable` 原因记录写成占用 body 行（否则导入端会把它误读成
      // captured/empty 的 body）。JSONL 只内联真实 captured/empty body，保持既有格式。
      const inlineBody = (body) => (body && body.state !== 'unavailable'
        ? { state: body.state, encoding: body.encoding, bytes: body.bytes, truncated: body.truncated, payloadOmitted: body.payloadOmitted, redacted: body.redacted, data: body.data }
        : null);
      const requestInline = inlineBody(request);
      const responseInline = inlineBody(response);
      const inline = {
        ...(requestInline ? { request: requestInline } : {}),
        ...(responseInline ? { response: responseInline } : {}),
      };
      if (Object.keys(inline).length) record.body = inline;
    }
    lines.push(JSON.stringify(record));
    const projection = store.linkProjection ? store.linkProjection(event) : { evidenceIds: event.evidenceIds };
    for (const evidenceId of projection.evidenceIds) {
      lines.push(JSON.stringify({ kind: 'marker', phase: 'evidence-link', seq: event.seq, evidenceId }));
    }
  }
  return Buffer.from(lines.join('\n') + '\n', 'utf8');
}

/**
 * R1-3 / §8.1 JSONL 导入：必须存在 `seq:0` 的 session-meta marker（`version:1`）；坏行计
 * `skippedLines` 并保留 seq 空洞；重复 seq 保留首条并计 `duplicates`；**不重排**。
 */
export function fromJsonl(bytes, { maxBytes = NET_LIMITS.importFileBytes } = {}) {
  const buffer = Buffer.isBuffer(bytes) ? bytes : Buffer.from(String(bytes ?? ''), 'utf8');
  if (buffer.length === 0) throw new BrowserError('NET_IMPORT_FAILED', '证据内容为空');
  if (buffer.length > maxBytes) throw new BrowserError('NET_QUOTA_EXCEEDED', '证据内容超过导入上限', { max: maxBytes, bytes: buffer.length });
  const lines = buffer.toString('utf8').split('\n').filter((line) => line.trim() !== '');
  if (lines.length === 0) throw new BrowserError('NET_IMPORT_FAILED', '证据内容没有可解析的行');
  let meta = null;
  const events = [];
  const bodies = [];
  const links = [];
  let skippedLines = 0;
  let duplicates = 0;
  const seenSeq = new Set();
  for (const line of lines) {
    let record;
    try { record = JSON.parse(line); } catch { skippedLines += 1; continue; }
    if (!record || typeof record !== 'object') { skippedLines += 1; continue; }
    // Accept the documented `{version, kind:'session-meta', …}` marker *and* a bare
    // `{version, sessionId, config, limits}` header line (no phase/seq), which is what hand-written
    // fixtures and third-party dumps emit (§8.6 is about ordering, not about the marker's shape).
    const looksMeta = record.phase === 'session-meta'
      || (record.seq === 0 && record.session)
      || (record.version === 1 && record.phase === undefined && record.kind === undefined && record.seq === undefined
        && (record.sessionId !== undefined || record.config !== undefined || record.limits !== undefined));
    if (looksMeta) {
      if (!Number.isInteger(record.version) || record.version !== NET_VERSION) {
        throw new BrowserError('NET_IMPORT_FAILED', 'session-meta marker 的 version 必须是 1', { version: record.version });
      }
      meta = record;
      continue;
    }
    if (record.phase === 'evidence-link' && record.evidenceId) {
      links.push({ seq: record.seq, evidenceId: record.evidenceId });
      continue;
    }
    if (!Number.isInteger(record.seq) || record.seq <= 0) { skippedLines += 1; continue; }
    if (seenSeq.has(record.seq)) { duplicates += 1; continue; }
    seenSeq.add(record.seq);
    const { body, ...event } = record;
    events.push(event);
    if (body) {
      for (const kind of ['request', 'response']) {
        if (!body[kind] || typeof body[kind].data !== 'string') continue;
        bodies.push({
          requestId: event.requestId, targetId: event.targetId, cdpSessionId: event.cdpSessionId, hopId: event.hopId,
          kind, seq: event.seq, state: body[kind].state === 'empty' ? 'empty' : 'captured',
          base64Encoded: body[kind].encoding === 'base64', truncated: body[kind].truncated === true,
          payloadOmitted: body[kind].payloadOmitted === true, data: body[kind].data,
        });
      }
    }
  }
  if (meta === null) throw new BrowserError('NET_IMPORT_FAILED', '缺少 seq:0 的 session-meta marker');
  if (events.length === 0) throw new BrowserError('NET_IMPORT_FAILED', '没有可解析的事件行', { skippedLines });
  return { meta, events, bodies, links, skippedLines, duplicates, version: meta.version };
}

/** 把导入结果装载为一个离线会话（`state:"snapshot"`；不可 control/replay）。 */
export function loadImported(store, imported, { name = null, source = null } = {}) {
  store.config = normalizeSessionConfig(imported.meta && imported.meta.config ? imported.meta.config : null);
  store.sessions = store.sessions || [];
  store.state = 'snapshot';
  store.session = {
    id: 'net-' + randomBytes(4).toString('hex'),
    name: truncateBytes(String(name || (imported.meta && imported.meta.session && imported.meta.session.name) || 'imported'), 64),
    state: 'snapshot',
    startedAt: store.now(),
    stoppedAt: null,
    retained: true,
    source,
    config: { ...store.config },
  };
  store.seq = 0;
  store.events = [];
  store.chains.clear();
  store.hops.clear();
  store.bodies.clear();
  if (store.bodyFailures) store.bodyFailures.clear();
  store.headers.clear();
  store.bodyBytes = 0;
  store.headerBytes = 0;
  store.eventBytes = 0;
  store.evictedSeqs = [];
  store.dropRanges = [];
  store.steps.clear();
  store.links.clear();
  store.correlationIndex.clear();
  store.counters = emptyCounters();
  store.issues = ['import-partial'];
  let previousSeq = 0;
  for (const event of imported.events) {
    if (event.seq > previousSeq + 1) store.dropRanges.push({ from: previousSeq + 1, to: event.seq - 1, count: event.seq - previousSeq - 1, reason: 'import-gap' });
    previousSeq = event.seq;
    store.seq = Math.max(store.seq, event.seq);
    const normalized = normalizeEvent(event, {
      seq: event.seq,
      sessionId: store.session.id,
      wallMs: store.now(),
      monotonicMs: store.monotonic(),
      preSession: event.preSession === true,
      hmacKey: store.hmacKey,
    });
    store.events.push(normalized);
    store.counters.events += 1;
    if (normalized.kind === 'http') store.counters.http += 1;
    else if (normalized.kind === 'ws') store.counters.ws += 1;
    else if (normalized.kind === 'sse') store.counters.sse += 1;
    else store.counters.markers += 1;
  }
  for (const body of imported.bodies) {
    store.addBody({
      targetId: body.targetId, cdpSessionId: body.cdpSessionId, requestId: body.requestId, hopId: body.hopId,
      kind: body.kind, state: body.state, data: body.data, base64Encoded: body.base64Encoded === true,
      payloadOmitted: body.payloadOmitted === true,
    });
  }
  for (const link of imported.links) {
    const event = store.events.find((item) => item.seq === link.seq);
    if (event && link.evidenceId && !event.evidenceIds.includes(link.evidenceId)) event.evidenceIds.push(truncateBytes(String(link.evidenceId), 128));
  }
  store.rebuildChains();
  return {
    sessionId: store.session.id,
    events: store.events.length,
    bodies: store.bodies.size,
    skippedLines: imported.skippedLines || 0,
    duplicates: imported.duplicates || 0,
    snapshot: true,
  };
}

const HAR_CREATOR = Object.freeze({ name: 'dsh-agent-team-ui-testing', version: '0.1.0' });

function harEntryFor(store, chain) {
  const events = chain.seqs.map((seq) => store.events.find((event) => event.seq === seq)).filter(Boolean);
  const request = events.find((event) => event.phase === 'request');
  const response = events.find((event) => event.phase === 'response');
  if (!request || !response) return null;
  const options = { targetId: request.targetId, cdpSessionId: request.cdpSessionId, requestId: request.requestId, hopId: request.hopId };
  const toHarHeaders = (record) => Object.entries(record.headers).map(([name, value]) => ({ name, value }));
  const timing = response.timing || emptyTiming();
  const num = (value) => (Number.isFinite(value) && value >= 0 ? value : -1);
  const entry = {
    pageref: store.session ? store.session.id : 'net',
    startedDateTime: new Date(request.ts.wallMs).toISOString(),
    time: Number.isFinite(timing.totalMs) ? timing.totalMs : 0,
    request: {
      method: request.method || 'GET',
      url: request.url,
      httpVersion: response.protocol || '',
      headers: toHarHeaders(store.readHeaders({ ...options, kind: 'request' })),
      queryString: parseQueryString(request.url),
      cookies: [],
      headersSize: Number.isInteger(request.sizes.requestHeaders) ? request.sizes.requestHeaders : -1,
      bodySize: Number.isInteger(request.sizes.requestBody) ? request.sizes.requestBody : -1,
    },
    response: {
      status: Number.isInteger(response.status) ? response.status : 0,
      statusText: response.statusText || '',
      httpVersion: response.protocol || '',
      headers: toHarHeaders(store.readHeaders({ ...options, kind: 'response' })),
      cookies: [],
      content: {
        size: Number.isInteger(response.sizes.decoded) ? response.sizes.decoded : (Number.isInteger(response.sizes.encoded) ? response.sizes.encoded : 0),
        mimeType: response.mimeType || '',
      },
      redirectURL: chain.hops.length ? chain.hops[chain.hops.length - 1].url : '',
      headersSize: Number.isInteger(response.sizes.responseHeaders) ? response.sizes.responseHeaders : -1,
      bodySize: Number.isInteger(response.sizes.encoded) ? response.sizes.encoded : -1,
    },
    cache: {},
    timings: {
      blocked: -1,
      dns: num(timing.dnsMs),
      connect: num(timing.connectMs),
      send: Number.isFinite(timing.sendMs) ? timing.sendMs : 0,
      wait: Number.isFinite(timing.waitMs) ? timing.waitMs : 0,
      receive: Number.isFinite(timing.receiveMs) ? timing.receiveMs : 0,
      ssl: num(timing.sslMs),
    },
    _networkP0: {
      seq: request.seq, kind: request.kind, phase: request.phase,
      targetId: request.targetId, frameId: request.frameId, stepId: request.stepId, hopId: request.hopId,
    },
  };
  return { entry, options };
}

/** §8.2 / R1-14 HAR 1.2 子集导出（必需字段齐全；未知数值用 -1）。 */
export function toHar(store, { includeBodies = false } = {}) {
  const entries = [];
  for (const chain of store.chains.values()) {
    const built = harEntryFor(store, chain);
    if (!built) continue;
    const { entry, options } = built;
    if (includeBodies) {
      const body = store.readBody({ ...options, kind: 'response' });
      if (body && body.state === 'captured' && !body.payloadOmitted) {
        entry.response.content = {
          ...entry.response.content,
          text: body.data,
          ...(body.encoding === 'base64' ? { encoding: 'base64' } : {}),
          size: Number.isFinite(body.originalBytes) ? body.originalBytes : entry.response.content.size,
        };
      }
    }
    entries.push(entry);
  }
  // WS / SSE 扩展条目（JSONL 才是保真格式）
  const byRequestId = new Map();
  for (const chain of store.chains.values()) byRequestId.set(chain.requestId, chain);
  for (const [requestId, chain] of byRequestId.entries()) {
    const frames = store.events
      .filter((event) => event.kind === 'ws' && event.requestId === requestId && (event.phase === 'ws-send' || event.phase === 'ws-receive'))
      .map((event) => ({ type: event.ws && event.ws.direction ? event.ws.direction : 'receive', time: event.ts.wallMs, opcode: event.ws ? event.ws.opcode : null, data: event.ws ? event.ws.payload : null }));
    if (frames.length) {
      const target = entries.find((entry) => entry._networkP0 && entry._networkP0.seq === chain.seqs[0]);
      if (target) target._webSocketMessages = frames;
      else entries.push({
        pageref: store.session ? store.session.id : 'net',
        startedDateTime: new Date(frames[0].time).toISOString(),
        time: 0,
        request: { method: 'GET', url: chain.url || '', httpVersion: '', headers: [], queryString: [], cookies: [], headersSize: -1, bodySize: -1 },
        response: { status: 101, statusText: 'Switching Protocols', httpVersion: '', headers: [], cookies: [], content: { size: 0, mimeType: '' }, redirectURL: '', headersSize: -1, bodySize: -1 },
        cache: {},
        timings: { blocked: -1, dns: -1, connect: -1, send: 0, wait: 0, receive: 0, ssl: -1 },
        _webSocketMessages: frames,
        _networkP0: { kind: 'ws', requestId, hopId: chain.hopId },
      });
    }
    const messages = store.events
      .filter((event) => event.kind === 'sse' && event.requestId === requestId)
      .map((event) => ({ eventName: event.sse ? event.sse.eventName : null, eventId: event.sse ? event.sse.eventId : null, data: event.sse ? event.sse.data : null, time: event.ts.wallMs }));
    if (messages.length) {
      const target = entries.find((entry) => entry._networkP0 && entry._networkP0.seq === chain.seqs[0]);
      if (target) target._eventSourceMessages = messages;
    }
  }
  entries.sort((left, right) => (left.startedDateTime < right.startedDateTime ? -1 : left.startedDateTime > right.startedDateTime ? 1 : 0));
  return {
    log: {
      version: '1.2',
      creator: { ...HAR_CREATOR },
      pages: [{
        startedDateTime: entries.length ? entries[0].startedDateTime : new Date(store.now()).toISOString(),
        id: store.session ? store.session.id : 'net',
        title: store.session && store.session.name ? store.session.name : 'network session',
        pageTimings: { onContentLoad: -1, onLoad: -1 },
      }],
      entries,
      _networkP0: {
        version: NET_VERSION,
        sessionId: store.session ? store.session.id : null,
        config: { ...store.config },
        counters: { ...store.counters },
        integrity: store.integrity(),
        exportedAt: store.now(),
      },
    },
  };
}

function harTimingsToTiming(timings, requestSeconds, responseSeconds) {
  const timing = {
    requestTime: Number.isFinite(requestSeconds) ? requestSeconds : -1,
    dnsStart: Number.isFinite(timings.dns) && timings.dns >= 0 ? 0 : -1,
    dnsEnd: Number.isFinite(timings.dns) && timings.dns >= 0 ? timings.dns : -1,
    connectStart: Number.isFinite(timings.connect) && timings.connect >= 0 ? 0 : -1,
    connectEnd: Number.isFinite(timings.connect) && timings.connect >= 0 ? timings.connect : -1,
    sendStart: 0,
    sendEnd: Number.isFinite(timings.send) && timings.send >= 0 ? timings.send : 0,
    receiveHeadersStart: (Number.isFinite(timings.send) ? timings.send : 0) + (Number.isFinite(timings.wait) ? timings.wait : 0),
    receiveHeadersEnd: (Number.isFinite(timings.send) ? timings.send : 0) + (Number.isFinite(timings.wait) ? timings.wait : 0) + (Number.isFinite(timings.receive) ? timings.receive : 0),
    sslStart: Number.isFinite(timings.ssl) && timings.ssl >= 0 ? 0 : -1,
    sslEnd: Number.isFinite(timings.ssl) && timings.ssl >= 0 ? timings.ssl : -1,
  };
  return normalizeTiming(timing, { responseSeconds });
}

/** §8.2 HAR 导入（HTTP 条目；WS/SSE 扩展尽力还原）。 */
export function fromHar(har, { now = Date.now() } = {}) {
  if (!har || typeof har !== 'object' || !har.log || typeof har.log !== 'object') throw new BrowserError('NET_HAR_INVALID', 'HAR 缺少 log 对象');
  const log = har.log;
  if (typeof log.version !== 'string' || !log.version.startsWith('1.')) throw new BrowserError('NET_HAR_INVALID', 'HAR log.version 必须是 1.x', { version: log.version });
  if (!Array.isArray(log.entries)) throw new BrowserError('NET_HAR_INVALID', 'HAR log.entries 必须是数组');
  const events = [];
  const bodies = [];
  let seq = 0;
  for (const [index, entry] of log.entries.entries()) {
    if (!entry || typeof entry !== 'object' || !entry.request || !entry.response) {
      throw new BrowserError('NET_HAR_INVALID', 'HAR entry 缺少 request/response', { index });
    }
    const requestId = (entry._networkP0 && entry._networkP0.requestId) || 'har-' + (index + 1);
    const targetId = (entry._networkP0 && entry._networkP0.targetId) || null;
    const hopId = entry._networkP0 && Number.isInteger(entry._networkP0.hopId) ? entry._networkP0.hopId : 0;
    const wall = Date.parse(entry.startedDateTime);
    const wallMs = Number.isFinite(wall) ? wall : now;
    const timeMs = Number.isFinite(entry.time) ? entry.time : 0;
    const timing = harTimingsToTiming(entry.timings || {}, wallMs / 1000, (wallMs + timeMs) / 1000);
    seq += 1;
    events.push({
      seq, kind: 'http', phase: 'request', requestId, targetId, hopId,
      ts: { wallMs, monotonicMs: 0, cdpSeconds: null },
      url: entry.request.url, method: entry.request.method, resourceType: 'Other',
      sizes: {
        requestHeaders: Number.isInteger(entry.request.headersSize) && entry.request.headersSize >= 0 ? entry.request.headersSize : null,
        requestBody: Number.isInteger(entry.request.bodySize) && entry.request.bodySize >= 0 ? entry.request.bodySize : null,
      },
      correlationIds: [],
    });
    seq += 1;
    events.push({
      seq, kind: 'http', phase: 'response', requestId, targetId, hopId,
      ts: { wallMs: wallMs + Math.round(timeMs), monotonicMs: 0, cdpSeconds: null },
      url: entry.response.redirectURL || entry.request.url,
      status: Number.isInteger(entry.response.status) ? entry.response.status : null,
      statusText: entry.response.statusText || null,
      mimeType: entry.response.content ? entry.response.content.mimeType || null : null,
      protocol: entry.response.httpVersion || null,
      timing,
      sizes: {
        encoded: Number.isInteger(entry.response.bodySize) && entry.response.bodySize >= 0 ? entry.response.bodySize : null,
        decoded: entry.response.content && Number.isInteger(entry.response.content.size) ? entry.response.content.size : null,
      },
      redirect: entry.response.redirectURL
        ? { from: entry.request.url, to: entry.response.redirectURL, status: Number.isInteger(entry.response.status) ? entry.response.status : null }
        : null,
      correlationIds: [],
    });
    const content = entry.response.content || {};
    if (typeof content.text === 'string' && content.text !== '') {
      bodies.push({
        requestId, targetId, hopId, kind: 'response', seq, state: 'captured',
        base64Encoded: content.encoding === 'base64', truncated: false,
        data: content.encoding === 'base64' ? content.text : Buffer.from(content.text, 'utf8').toString('base64'),
      });
    }
    seq += 1;
    events.push({
      seq, kind: 'http', phase: 'finished', requestId, targetId, hopId,
      ts: { wallMs: wallMs + Math.round(timeMs), monotonicMs: 0, cdpSeconds: null },
      url: entry.request.url, timing: { ...timing, totalMs: timeMs }, correlationIds: [],
    });
  }
  return { events, bodies, meta: log._networkP0 || null, links: [], skippedLines: 0, duplicates: 0, version: NET_VERSION };
}

export function detectEvidenceFormat(text) {
  const trimmed = String(text ?? '').trim();
  if (trimmed === '') return null;
  if (trimmed.startsWith('{')) {
    try {
      const parsed = JSON.parse(trimmed);
      if (parsed && parsed.log && Array.isArray(parsed.log.entries)) return 'har';
    } catch { /* 多行 JSONL 不是单对象 */ }
    return 'jsonl';
  }
  return 'jsonl';
}

export function parseImportedEvidence(text, { format = 'auto' } = {}) {
  const chosen = format === 'auto' || !format ? detectEvidenceFormat(text) : format;
  if (chosen === 'har') {
    let parsed;
    try { parsed = typeof text === 'string' ? JSON.parse(text) : text; } catch (error) {
      throw new BrowserError('NET_HAR_INVALID', 'HAR 不是合法 JSON', { reason: String(error && error.message || error) });
    }
    return { format: 'har', ...fromHar(parsed) };
  }
  if (chosen === 'jsonl') return { format: 'jsonl', ...fromJsonl(text) };
  throw new BrowserError('NET_IMPORT_FAILED', '无法判定的证据格式');
}

/* ---------------- 索引 / 检索 / 链接 ---------------- */

export function registerArtifact(store, artifact) {
  const id = artifact.evidenceId
    ? truncateBytes(String(artifact.evidenceId), 128)
    : 'ev-' + randomBytes(5).toString('hex');
  const record = {
    evidenceId: id,
    format: artifact.format === 'har' ? 'har' : 'jsonl',
    sessionId: artifact.sessionId === undefined ? (store.session ? store.session.id : null) : artifact.sessionId,
    createdAt: Number.isFinite(artifact.createdAt) ? artifact.createdAt : store.now(),
    seqs: Array.isArray(artifact.seqs) ? artifact.seqs.slice(0, 20000) : [],
    bytes: Number.isInteger(artifact.bytes) ? artifact.bytes : null,
    sha256: typeof artifact.sha256 === 'string' ? artifact.sha256 : null,
    pathKind: 'persist',
    persistence: 'root',
    relativePath: typeof artifact.relativePath === 'string' ? artifact.relativePath : null,
    absolutePath: typeof artifact.absolutePath === 'string' ? artifact.absolutePath : null,
    includeBodies: artifact.includeBodies === true,
    events: Number.isInteger(artifact.events) ? artifact.events : null,
    integrity: store.integrity(),
  };
  store.artifacts.set(id, record);
  return record;
}

export function listArtifacts(store) {
  return [...store.artifacts.values()].map((record) => ({
    evidenceId: record.evidenceId, format: record.format, sessionId: record.sessionId,
    relativePath: record.relativePath, pathKind: record.pathKind, persistence: record.persistence,
    bytes: record.bytes, createdAt: record.createdAt, events: record.events,
    seqs: record.seqs.slice(0, 50), includeBodies: record.includeBodies, integrity: record.integrity,
  }));
}

export function searchArtifacts(store, query = {}) {
  assertKnownKeys(query, ['text', 'urlIncludes', 'status', 'stepId', 'seqs'], 'query');
  const results = [];
  const seqs = Array.isArray(query.seqs) ? query.seqs.filter((seq) => Number.isInteger(seq)) : null;
  for (const event of store.events) {
    if (seqs && !seqs.includes(event.seq)) continue;
    if (Number.isInteger(query.status) && event.status !== query.status) continue;
    if (query.urlIncludes && !String(event.url || '').toLowerCase().includes(String(query.urlIncludes).toLowerCase())) continue;
    if (query.stepId && !inStepWindow(store, event, query.stepId)) continue;
    if (query.text) {
      const hit = matchesSearch(store, event, { text: query.text, in: ['url', 'headers', 'body', 'ws', 'sse'] });
      if (!hit || !hit.matched) continue;
    }
    results.push({
      sessionId: store.session ? store.session.id : null,
      seq: event.seq, url: event.url, method: event.method, status: event.status,
      wallMs: event.ts.wallMs, stepId: derivedStepId(store, event), file: null,
    });
    if (results.length >= NET_LIMITS.eventPageLimit) break;
  }
  const files = listArtifacts(store)
    .filter((artifact) => (seqs ? seqs.some((seq) => artifact.seqs.includes(seq)) : true))
    .map((artifact) => ({ evidenceId: artifact.evidenceId, relativePath: artifact.relativePath, format: artifact.format, sessionId: artifact.sessionId }));
  return { ok: true, results, files, truncated: results.length >= NET_LIMITS.eventPageLimit };
}

export function indexView(store) {
  const artifacts = listArtifacts(store);
  const links = [];
  for (const [seq, list] of store.links.entries()) {
    for (const link of list) links.push({ seq, evidenceId: link.evidenceId, stepId: link.stepId, linkedAt: link.linkedAt });
  }
  for (const event of store.events) {
    for (const evidenceId of event.evidenceIds) {
      if (!links.some((link) => link.seq === event.seq && link.evidenceId === evidenceId)) {
        links.push({ seq: event.seq, evidenceId, stepId: event.stepId, linkedAt: null });
      }
    }
  }
  return {
    version: NET_VERSION,
    sessions: [{ id: store.session ? store.session.id : null, name: store.session ? store.session.name : null, state: store.state }],
    files: artifacts.map((artifact) => ({
      relativePath: artifact.relativePath, format: artifact.format, bytes: artifact.bytes,
      sessionId: artifact.sessionId, createdAt: artifact.createdAt, integrity: artifact.integrity,
    })),
    entries: { events: store.events.length, requests: store.chains.size, steps: store.steps.size },
    links: links.slice(0, 200),
  };
}

export function clearArtifacts(store) {
  const count = store.artifacts.size;
  const files = [...store.artifacts.values()];
  store.artifacts.clear();
  return { cleared: count, files };
}

/* ------------------------------------------------------------------ */
/* 订阅（§2.7 + R1-2）                                                  */
/* ------------------------------------------------------------------ */

function subscriptionOf(store, subscriptionId, ownerSessionId) {
  const record = store.subscriptions.get(String(subscriptionId));
  if (!record) throw new BrowserError('NET_SUBSCRIPTION_NOT_FOUND', '订阅不存在: ' + String(subscriptionId), { subscriptionId: String(subscriptionId) });
  if (record.ownerSessionId !== ownerSessionId) {
    throw new BrowserError('NET_SUBSCRIPTION_FORBIDDEN', '该订阅属于其他会话', { subscriptionId: record.id });
  }
  return record;
}

export function subscriptionCreate(store, { ownerSessionId, kinds = null, afterSeq = null } = {}) {
  if (!ownerSessionId) throw new BrowserError('NET_SUBSCRIPTION_FORBIDDEN', '缺少调用方身份');
  if (store.subscriptions.size >= NET_LIMITS.subscriptionMax) {
    throw new BrowserError('NET_QUOTA_EXCEEDED', '订阅数超出上限 ' + NET_LIMITS.subscriptionMax, { max: NET_LIMITS.subscriptionMax });
  }
  let normalizedKinds = null;
  if (kinds !== null && kinds !== undefined) {
    if (!Array.isArray(kinds) || kinds.length === 0) throw new BrowserError('NET_INVALID_ARGUMENT', 'kinds 必须是非空数组');
    for (const kind of kinds) {
      if (!NET_KINDS.includes(kind)) throw new BrowserError('NET_INVALID_ARGUMENT', 'kinds 含未知取值 ' + String(kind), { allowed: [...NET_KINDS] });
    }
    normalizedKinds = [...new Set(kinds)];
  }
  const from = Number.isInteger(afterSeq) ? afterSeq : store.seq;
  const record = {
    id: 'sub-' + randomBytes(4).toString('hex'),
    ownerSessionId: String(ownerSessionId),
    sessionId: store.session ? store.session.id : null,
    kinds: normalizedKinds,
    fromSeq: from,
    deliveredSeq: from,
    ackedSeq: from,
    createdAt: store.now(),
    polls: 0,
    delivered: 0,
    droppedPinned: 0,
    pinned: false,
    closed: false,
  };
  store.subscriptions.set(record.id, record);
  return {
    id: record.id, createdAt: record.createdAt,
    cursor: { next: encodeCursor(record.deliveredSeq) }, ackedSeq: record.ackedSeq,
    counters: { delivered: 0, pending: Math.max(0, store.seq - record.ackedSeq), pinned: 0, dropped: 0 },
  };
}

/**
 * poll：`cursor`/`afterSeq` 不得低于已投递水位（R1-2）；pin 是硬上限，超出给 `gap`/`dropped`。
 */
export function subscriptionPoll(store, { subscriptionId, ownerSessionId, cursor = null, afterSeq = null, limit = null, kinds = null } = {}) {
  const record = subscriptionOf(store, subscriptionId, ownerSessionId);
  if (record.closed) throw new BrowserError('NET_SUBSCRIPTION_NOT_FOUND', '订阅已关闭', { subscriptionId: record.id });
  const size = limit === null || limit === undefined ? NET_LIMITS.subscriptionLimit : limit;
  if (!Number.isInteger(size) || size < 1 || size > NET_LIMITS.subscriptionLimit) {
    throw new BrowserError('NET_INVALID_ARGUMENT', `limit 必须是 1–${NET_LIMITS.subscriptionLimit} 的整数`, { field: 'limit' });
  }
  const explicit = Number.isInteger(afterSeq) ? afterSeq : decodeCursor(cursor);
  let from = explicit === null || explicit === undefined ? record.deliveredSeq : explicit;
  if (from < record.deliveredSeq) {
    throw new BrowserError('NET_RULE_INVALID', 'poll 游标不得低于已投递水位（防重复投递）', {
      cursor: from, deliveredSeq: record.deliveredSeq,
    });
  }
  // pin 硬上限：未 ack 的窗口最多 subscriptionPin 条
  const floor = Math.max(record.ackedSeq, store.seq - NET_LIMITS.subscriptionPin);
  let gap = null;
  if (from < floor) {
    gap = { from: from + 1, to: floor, dropped: floor - from };
    record.droppedPinned += floor - from;
    record.pinned = true;
    from = floor;
  }
  const filterKinds = kinds === null || kinds === undefined ? record.kinds : kinds;
  const events = [];
  let lastSeq = from;
  let more = false;
  for (const event of store.events) {
    if (event.seq <= from) continue;
    if (filterKinds && !filterKinds.includes(event.kind)) { lastSeq = event.seq; continue; }
    if (events.length >= size) { more = true; break; }
    events.push(projectSummary(store, event));
    lastSeq = event.seq;
  }
  record.deliveredSeq = Math.max(record.deliveredSeq, lastSeq);
  record.polls += 1;
  record.delivered += events.length;
  record.pinned = store.seq - record.ackedSeq > NET_LIMITS.subscriptionPin;
  return {
    ok: true,
    subscriptionId: record.id,
    events,
    cursor: { next: encodeCursor(record.deliveredSeq) },
    deliveredSeq: record.deliveredSeq,
    ackedSeq: record.ackedSeq,
    hasMore: more,
    ...(gap ? { gap } : {}),
    counters: {
      delivered: record.delivered,
      pending: Math.max(0, store.seq - record.ackedSeq),
      pinned: Math.min(Math.max(0, store.seq - record.ackedSeq), NET_LIMITS.subscriptionPin),
      dropped: record.droppedPinned,
    },
    integrity: store.integrity(),
  };
}

/** ack：只能确认已交付边界（R1-2）。 */
export function subscriptionAck(store, { subscriptionId, ownerSessionId, ackSeq = null } = {}) {
  const record = subscriptionOf(store, subscriptionId, ownerSessionId);
  const target = Number.isInteger(ackSeq) ? ackSeq : record.deliveredSeq;
  if (target > record.deliveredSeq) {
    throw new BrowserError('NET_RULE_INVALID', 'ackSeq 不能超过已交付水位', { ackSeq: target, deliveredSeq: record.deliveredSeq });
  }
  if (target < record.ackedSeq) {
    throw new BrowserError('NET_RULE_INVALID', 'ackSeq 不能小于当前 ack', { ackSeq: target, ackedSeq: record.ackedSeq });
  }
  record.ackedSeq = target;
  record.pinned = store.seq - record.ackedSeq > NET_LIMITS.subscriptionPin;
  return {
    ok: true, subscriptionId: record.id, ackedSeq: record.ackedSeq,
    cursor: { next: encodeCursor(record.deliveredSeq) },
    counters: {
      delivered: record.delivered,
      pending: Math.max(0, store.seq - record.ackedSeq),
      pinned: Math.min(Math.max(0, store.seq - record.ackedSeq), NET_LIMITS.subscriptionPin),
      dropped: record.droppedPinned,
    },
  };
}

export function subscriptionClose(store, { subscriptionId, ownerSessionId } = {}) {
  const record = subscriptionOf(store, subscriptionId, ownerSessionId);
  record.closed = true;
  store.subscriptions.delete(record.id);
  return { ok: true, subscriptionId: record.id, closed: true };
}

export function subscriptionList(store, { ownerSessionId } = {}) {
  return {
    ok: true,
    subscriptions: [...store.subscriptions.values()]
      .filter((record) => record.ownerSessionId === ownerSessionId)
      .map((record) => ({
        subscriptionId: record.id, kinds: record.kinds, cursor: { next: encodeCursor(record.deliveredSeq) },
        ackedSeq: record.ackedSeq, createdAt: record.createdAt, polls: record.polls,
        delivered: record.delivered, pinned: record.pinned, droppedPinned: record.droppedPinned,
      })),
  };
}

/* ------------------------------------------------------------------ */
/* 能力报告（§8.8）                                                     */
/* ------------------------------------------------------------------ */

export const NETWORK_TOOL_NAMES = Object.freeze([
  'browser_network_session', 'browser_network_events', 'browser_network_detail',
  'browser_network_trace', 'browser_network_control', 'browser_network_evidence',
  'browser_network_subscribe',
]);

/** §8.8 `capabilities.network` 段。`observed` 只来自真实调用（由 Host 写入 store.observed）。 */
export function networkCapabilities(store, { control = null, subTargets = null } = {}) {
  const status = store.status();
  const observed = store.observed && typeof store.observed === 'object'
    ? {
      lastCallAt: Number.isFinite(store.observed.lastCallAt) ? store.observed.lastCallAt : null,
      lastOperation: typeof store.observed.lastOperation === 'string' ? store.observed.lastOperation : null,
    }
    : null;
  return {
    version: NET_VERSION,
    tools: [...NETWORK_TOOL_NAMES],
    session: status.session
      ? {
        id: status.session.id,
        state: status.session.state,
        counters: { ...status.session.counters },
        integrity: {
          complete: status.session.integrity.complete,
          dropped: status.session.integrity.dropped,
          evicted: status.session.integrity.evicted,
          truncated: status.session.integrity.truncated,
          bodyEvicted: status.session.integrity.bodyEvicted,
        },
      }
      : { id: null, state: null, counters: null, integrity: null },
    limits: {
      ...limitsView(),
      network: {
        capture: true,
        bodies: true,
        websocket: true,
        sse: true,
        workers: true,
        interception: true,
        responseModification: control ? control.responseModification === true : false,
        throttle: true,
        offline: true,
        replay: true,
        mock: true,
        har: true,
        jsonl: true,
        subscriptions: true,
        responseModification: control ? control.responseModification === true : false,
        // §8.8 scalar fields read at `capabilities.network.limits.network.<field>`; the numeric
        // bounds live in `throttleLimits` so the capability flags stay booleans as specified.
        https: 'mechanism-identical',
        throttleLimits: { latencyMsMax: 60000, downloadKbpsMax: 1000000, uploadKbpsMax: 1000000, unit: 'Kbps = 1024 bit/s' },
        holdLimits: { maxHeld: NET_LIMITS.held, timeoutMs: NET_LIMITS.holdTimeoutMs },
        ruleLimits: { max: NET_LIMITS.rules, kinds: [...NET_RULE_KINDS] },
        ...(subTargets && typeof subTargets === 'object' ? { subTargets: { ...subTargets } } : {}),
      },
      // Also mirrored one level up: the acceptance suite reads `capabilities.network.limits.<field>`.
      https: 'mechanism-identical',
      ...(subTargets && typeof subTargets === 'object' ? { subTargets: { ...subTargets } } : {}),
      throttleLimits: { latencyMsMax: 60000, downloadKbpsMax: 1000000, uploadKbpsMax: 1000000, unit: 'Kbps = 1024 bit/s' },
      holdLimits: { maxHeld: NET_LIMITS.held, timeoutMs: NET_LIMITS.holdTimeoutMs },
      ruleLimits: { max: NET_LIMITS.rules, kinds: [...NET_RULE_KINDS] },
    },
    observed,
  };
}

export default {
  NetworkStore, ControlState, NET_VERSION, NET_LIMITS, NET_DEFAULTS,
  NET_BODY_REASON_CODES, classifyBodyFailure, normalizeBodyReasonDetail,
  queryEvents, detailEvent, traceNetwork, evidenceBlock, networkCapabilities,
  toJsonl, fromJsonl, toHar, fromHar, loadImported, parseImportedEvidence,
  resolveEvidencePath, publishEvidence, registerArtifact, listArtifacts, searchArtifacts,
  indexView, clearArtifacts, subscriptionCreate, subscriptionPoll, subscriptionAck,
  subscriptionClose, subscriptionList, validateRule, validateThen, matchRule,
  firstMatchingRule, buildFetchPatterns, decidePausedAction, conditionParams,
  NETWORK_UNTHROTTLED, extractCorrelationIds, extractBusinessCode, detectPolling,
  detectRetries, normalizeEvent, normalizeSessionConfig, normalizeTiming, sanitizeBody,
  sanitizeHeaders, sanitizeUrl, parseQueryString, readJsonPath, percentile, statusClass,
  truncateBytes, matchUrlPattern, encodeCursor, decodeCursor, requestKey, limitsView,
  estimateEventBytes, urlHashOf, hmacHex, validateObjectRules, validateCorrelationRules,
  extractObjects, emptyTiming, emptyCounters,
};
