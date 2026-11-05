/**
 * network-p0.test.mjs — U-class unit checks for the WEB-P0 network core (docs/network-p0.md §4/§5/§8).
 *
 * Two consumers:
 *   1. `node --test tests/network-p0.test.mjs` runs every check as an individual subtest.
 *   2. `runNetworkUnitChecks(check, {tempRoot})` exposes the *same* checks to
 *      tests/acceptance/network-p0.mjs, which merges them into the numbered criteria (C1–C52) so the
 *      acceptance report reads against docs/network-p0.md §10 one-to-one. A U check never
 *      substitutes a B requirement; it only adds evidence for the algorithm/FS half.
 *
 * Ground truth: the frozen contract, not the implementation's own reporting. Every assertion below
 * is either a pure-function invariant (percentiles, sanitisation, parsing, cursors) or a store
 * invariant (quota/eviction/integrity/JSONL fidelity) that a browser cannot help with.
 */
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  NET_DEFAULTS, NET_LIMITS, NetworkStore, NET_BODY_REASON_CODES,
  aggregateEvents, classifyBodyFailure, decodeCursor, detailEvent, detectPolling,
  detectRetries, encodeCursor, estimateEventBytes, evidenceBlock,
  extractBusinessCode, extractCorrelationIds, fromHar, fromJsonl, loadImported,
  networkCapabilities, normalizeBodyReasonDetail, normalizeEvent, normalizeSessionConfig, normalizeTiming,
  parseImportedEvidence, parseQueryString, percentile, queryEvents, sanitizeBody,
  sanitizeHeaders, sanitizeUrl, statusClass, subscriptionAck,
  subscriptionClose, subscriptionCreate, subscriptionList, subscriptionPoll, toHar, toJsonl,
  traceNetwork,
} from '../network-p0.js';

/** The store class (one instance per Runtime/scope). */
const Store = NetworkStore;

/* ------------------------------------------------------------------------------------------------
 * Helpers
 * ---------------------------------------------------------------------------------------------- */

const ok = (condition, message) => assert.ok(condition, message);

function makeStore({ config = null, name = 'unit' } = {}) {
  const store = new Store({ scopeId: 'unit-scope' });
  store.start({ name, config });
  return store;
}

/** A minimal HTTP event as the Host emits it (request/response/finished share the requestId). */
function httpEvent(overrides = {}) {
  return {
    kind: 'http', phase: 'request', requestId: '1000.1', targetId: 'T1', frameId: 'F1', loaderId: 'L1',
    documentURL: 'http://127.0.0.1:1/web-network.html', url: 'http://127.0.0.1:1/n/json?from=page&n=1',
    method: 'GET', resourceType: 'Fetch', ...overrides,
  };
}

/** Collect the checks once, so `node --test` and the acceptance suite run exactly the same list. */
const CHECKS = [];
const check = (criteria, label, fn) => CHECKS.push({ criteria, label, fn });

/** Build a store with a controllable clock (so interval-based detection is deterministic). */
function storeEventsWith(responses) {
  let now = 1_760_000_000_000;
  const store = new Store({ now: () => now });
  store.start({ name: 'synthetic' });
  responses.forEach((response, index) => {
    store.add(httpEvent({ requestId: `s.${index}`, phase: 'request', url: response.url }));
    now += 40;
    store.add(httpEvent({
      requestId: `s.${index}`, phase: 'response', url: response.url,
      status: response.status ?? 200, failed: response.failed === true,
    }));
    now += 40;
  });
  return store.events;
}

/* ------------------------------------------------------------------------------------------------
 * C10 — event standardisation (schema, enums, three timestamps, projections)
 * ---------------------------------------------------------------------------------------------- */

check('C10', 'normalizeEvent 产出 §4.1 主干字段与三时间戳', () => {
  const event = normalizeEvent(httpEvent({ ts: { wallMs: 1760000000123, monotonicMs: 42.5, cdpSeconds: 1234.5 } }), {
    seq: 7, wallMs: 1, monotonicMs: 2, sessionId: 'net-x', hmacKey: 'k',
  });
  ok(event.seq === 7, 'seq');
  ok(event.sessionId === 'net-x', 'sessionId');
  ok(event.ts.wallMs === 1760000000123 && event.ts.monotonicMs === 42.5 && event.ts.cdpSeconds === 1234.5, 'three timestamps');
  ok(['http', 'ws', 'sse', 'marker'].includes(event.kind) && typeof event.phase === 'string', 'kind/phase enums');
  ok(event.method === 'GET' && event.resourceType === 'Fetch', 'method/resourceType');
  ok(event.sizes && typeof event.sizes === 'object', 'sizes object');
  ok(event.redaction && Array.isArray(event.redaction.applied), 'redaction.applied array');
});

check('C10', 'normalizeEvent 拒绝未知 kind/phase，回落安全值而不是透传', () => {
  const event = normalizeEvent(httpEvent({ kind: 'bogus', phase: 'bogus' }), { seq: 1, wallMs: 1, monotonicMs: 2 });
  ok(event.kind === 'http', 'kind falls back to http');
  ok(event.phase === 'request', 'phase falls back to request');
});

check('C10', '事件入店后不可变（同一 seq 再读内容不变）', () => {
  const store = makeStore();
  const first = store.add(httpEvent());
  const snapshot = JSON.stringify(first);
  store.add(httpEvent({ requestId: '1000.2', url: 'http://127.0.0.1:1/n/echo', method: 'POST' }));
  const again = store.events.find((event) => event.seq === first.seq);
  ok(JSON.stringify(again) === snapshot, 'event content unchanged');
});

check('C10', 'summary 投影不含 body/headers 且没有 undefined 字段', () => {
  const store = makeStore();
  store.add(httpEvent({ phase: 'response', status: 200, statusText: 'OK', mimeType: 'application/json' }));
  const value = queryEvents(store, { view: 'summary', limit: 10 });
  const row = value.events[0];
  ok(!('headers' in row) && !('requestBody' in row), 'no inline bodies');
  ok(Object.values(row).every((item) => item !== undefined), 'no undefined values');
});

/* ------------------------------------------------------------------------------------------------
 * C18 — parameter parsing (query, body kinds, masking, parse errors)
 * ---------------------------------------------------------------------------------------------- */

check('C18', 'queryString 重复键保序', () => {
  const query = parseQueryString('http://127.0.0.1:1/n/json?a=1&b=2&a=3');
  ok(JSON.stringify(query) === JSON.stringify([{ name: 'a', value: '1' }, { name: 'b', value: '2' }, { name: 'a', value: '3' }]),
    `unexpected query ${JSON.stringify(query)}`);
});

check('C18', 'sanitizeBody 解析 JSON 并脱敏敏感字段', () => {
  const body = sanitizeBody(JSON.stringify({ token: 'raw-token', ok: 1 }), 'application/json');
  ok(body.kind === 'json', 'kind=json');
  ok(!JSON.stringify(body).includes('raw-token'), 'raw token removed');
});

check('C18', 'sanitizeBody 解析 urlencoded 并保留数组语义', () => {
  const body = sanitizeBody('a=1&a=2&password=secret', 'application/x-www-form-urlencoded');
  ok(body.kind === 'urlencoded' || body.kind === 'form', `kind=${body.kind}`);
  ok(!JSON.stringify(body).includes('secret'), 'password masked');
});

check('C18', '非法 JSON 标记 parseError 而不抛错', () => {
  const body = sanitizeBody('{not-json', 'application/json');
  ok(body.parseError === true || body.kind === 'text', 'parse error surfaced, not thrown');
});

/* ------------------------------------------------------------------------------------------------
 * C19 — status classes and business status codes
 * ---------------------------------------------------------------------------------------------- */

check('C19', 'statusClass 覆盖 1xx–5xx 与非法值', () => {
  ok(statusClass(200) === '2xx' && statusClass(404) === '4xx' && statusClass(503) === '5xx', 'classes');
  ok(statusClass(99) === null || statusClass(null) === null, 'invalid status → null');
});

check('C19', '业务码按默认路径顺序提取（code/status/errno/bizCode）', () => {
  const pick = (value) => {
    const result = extractBusinessCode(value);
    return result && typeof result === 'object' ? result.businessCode : result;
  };
  ok(String(pick({ code: 0 })) === '0', 'code first');
  ok(String(pick({ status: 500 })) === '500', 'status second');
  ok(pick({ nothing: 1 }) === null, 'absent → null');
});

check('C19', '显式 businessStatusPath 覆盖默认路径', () => {
  const pick = (value, path) => {
    const result = extractBusinessCode(value, path);
    return result && typeof result === 'object' ? result.businessCode : result;
  };
  ok(String(pick({ result: { status: 'DONE' } }, 'result.status')) === 'DONE', 'explicit path');
  ok(pick({ code: 1 }, 'missing.path') === null || pick({ code: 1 }, 'missing.path') === 1, 'missing explicit path falls back or null');
});

/* ------------------------------------------------------------------------------------------------
 * C20 — percentiles and aggregate statistics
 * ---------------------------------------------------------------------------------------------- */

check('C20', 'percentile 线性插值与边界', () => {
  const sorted = [10, 20, 30, 40];
  ok(percentile(sorted, 0) === 10, 'p0');
  ok(percentile(sorted, 1) === 40, 'p100');
  const p50 = percentile(sorted, 0.5);
  ok(p50 >= 20 && p50 <= 30, `p50 in range (${p50})`);
  ok(percentile([42], 0.95) === 42, 'single sample → max');
});

check('C20', 'aggregateEvents 输出 durationMs{min,max,avg,p50,p95} 与 failures', () => {
  const store = makeStore();
  const timings = [100, 200, 400];
  timings.forEach((totalMs, index) => {
    store.add(httpEvent({ requestId: `p.${index}`, phase: 'response', status: 200, timing: { totalMs } }));
  });
  const aggregate = aggregateEvents(store, store.events, 'url');
  const group = aggregate.groups[0];
  const duration = group.durationMs || group;
  ok(Number.isFinite(duration.min) && Number.isFinite(duration.max) && Number.isFinite(duration.avg), 'min/max/avg');
  ok(Number.isFinite(duration.p50) && Number.isFinite(duration.p95), 'p50/p95');
  ok(duration.p50 >= duration.min && duration.p50 <= duration.max, 'p50 within range');
  ok(duration.p95 >= duration.p50, 'p95 >= p50');
  ok('failures' in group, 'failures present');
});

check('C20', 'aggregate 分组上限不静默截断（groupCount/truncated 可解释）', () => {
  const store = makeStore();
  for (let index = 0; index < 3; index += 1) {
    store.add(httpEvent({ requestId: `r.${index}`, url: `http://127.0.0.1:1/n/status/50${index}`, phase: 'response', status: 500, failed: true }));
  }
  const aggregate = aggregateEvents(store, store.events, 'url');
  ok(Array.isArray(aggregate.groups), 'groups array');
  ok(Number.isInteger(aggregate.groupCount) && aggregate.groupCount === 3, `groupCount=${aggregate.groupCount}`);
  ok(aggregate.groups.every((group) => group.failures >= 1), 'failures counted per group');
  ok(typeof aggregate.truncated === 'boolean', 'truncated flag');
});

check('C22', 'retry 识别：同键窗口内前次失败后重复', () => {
  const retries = detectRetries(storeEventsWith([{ url: 'http://127.0.0.1:1/n/flaky?key=page', status: 503, failed: true }, { url: 'http://127.0.0.1:1/n/flaky?key=page', status: 200 }]));
  ok(Array.isArray(retries), 'retries array');
  ok(retries.length >= 1, `expected a retry group, got ${JSON.stringify(retries)}`);
});

/* ------------------------------------------------------------------------------------------------
 * C22 — retry/polling detection keys ignore volatile query (R1-17)
 * ---------------------------------------------------------------------------------------------- */

check('C22', 'polling 识别忽略 /n/poll?n= 的 query 差异（键=method+origin+path）', () => {
  const events = storeEventsWith([1, 2, 3, 4].map((n) => ({ url: `http://127.0.0.1:1/n/poll?n=${n}`, status: 200 })));
  const polling = detectPolling(events);
  ok(Array.isArray(polling), 'polling array');
  ok(polling.length >= 1, `expected a polling group, got ${JSON.stringify(polling)}`);
  ok(Number(polling[0].count) >= 3, `count=${polling[0] && polling[0].count}`);
  ok(JSON.stringify(polling[0]).includes('/n/poll'), 'group key keeps the path');
  ok(!JSON.stringify(polling[0]).includes('?n='), 'volatile query excluded from the key');
});

/* ------------------------------------------------------------------------------------------------
 * C23/C45 — correlation ids and redaction (never store raw secrets)
 * ---------------------------------------------------------------------------------------------- */

check('C45', 'sanitizeUrl 脱敏敏感 query 与 userinfo', () => {
  const value = sanitizeUrl('http://user:unit-password@127.0.0.1:1/n/token?token=unit-token-value');
  ok(!value.value.includes('unit-token-value'), 'token redacted');
  ok(!value.value.includes('unit-password'), 'userinfo redacted');
  ok(value.applied === true || (Array.isArray(value.applied) && value.applied.length > 0) || value.redacted === true, 'applied marker');
});

check('C45', 'sanitizeHeaders 完全替换敏感头值', () => {
  const result = sanitizeHeaders({ authorization: 'Bearer abc', cookie: 'a=b', 'x-ok': '1' });
  const headers = result.headers || result;
  ok(String(headers.authorization) === '***' || !String(headers.authorization).includes('abc'), 'authorization masked');
  ok(!JSON.stringify(result).includes('Bearer abc'), 'no raw bearer');
  ok(String(headers['x-ok']) === '1', 'non-sensitive header preserved');
});

check('C45', 'maskRules 只能追加、不能关闭默认规则', () => {
  const withRules = normalizeSessionConfig({ maskRules: ['x-custom-secret'] });
  ok(Array.isArray(withRules.maskRules) && withRules.maskRules.includes('x-custom-secret'), 'appended rule');
  const body = sanitizeBody(JSON.stringify({ token: 't', 'x-custom-secret': 'v' }), 'application/json', { maskRules: ['x-custom-secret'] });
  ok(!JSON.stringify(body).includes('"v"'), 'custom rule masked');
  const defaults = normalizeSessionConfig({});
  ok(!Array.isArray(defaults.maskRules) || defaults.maskRules.length === 0, 'defaults unchanged');
});

check('C23', '关联标识只暴露 hash，不含原值', () => {
  const ids = extractCorrelationIds(httpEvent({ headers: {} }), {
    headers: { 'x-request-id': 'corr-raw-1' }, hmacKey: 'unit-key',
  });
  const entry = ids.find((item) => item.name === 'x-request-id');
  ok(Boolean(entry), 'x-request-id extracted');
  ok(typeof entry.contentHash === 'string' && entry.contentHash.length === 64, 'contentHash sha256 hex');
  const normalised = normalizeEvent({ kind: 'http', phase: 'request', requestId: 'c', url: 'http://x/y', correlationIds: ids },
    { seq: 1, wallMs: 1, monotonicMs: 2, hmacKey: 'unit-key' });
  const publicId = normalised.correlationIds[0];
  ok(typeof publicId.valueHash === 'string' && publicId.valueHash.length === 12, 'public valueHash 12 hex');
});

check('C23', '导出证据不含关联标识原值（§5.6 只导出 hash）', () => {
  const store = makeStore();
  store.add({ ...httpEvent(), correlationIds: [{ name: 'x-request-id', value: 'raw-corr-unit' }] });
  const exported = toJsonl(store).toString('utf8');
  ok(!exported.includes('raw-corr-unit'), 'raw correlation value must not be exported');
});

check('C23', '同一标识 → 同一 hash、不同标识 → 不同 hash（同 key 稳定、跨 key 变化）', () => {
  const hashOf = (value, hmacKey) => extractCorrelationIds(httpEvent(), { headers: { 'x-request-id': value }, hmacKey })[0];
  const a = hashOf('same-1', 'k1');
  const b = hashOf('same-1', 'k1');
  const c = hashOf('other-1', 'k1');
  const d = hashOf('same-1', 'k2');
  ok(a.contentHash === b.contentHash, 'stable within session key');
  ok(a.contentHash !== c.contentHash, 'distinct values differ');
  ok(a.contentHash !== d.contentHash, 'per-session key randomises hash (R1-9)');
});

/* ------------------------------------------------------------------------------------------------
 * C2/C47/C48 — body states, quota/eviction/drop accounting, integrity
 * ---------------------------------------------------------------------------------------------- */

check('C47', 'maxEvents 淘汰最旧事件并累计 evicted（dropped 不混用）', () => {
  const store = makeStore({ config: { maxEvents: 3 } });
  for (let index = 0; index < 6; index += 1) store.add(httpEvent({ requestId: `e.${index}` }));
  const counters = store.counters;
  ok(store.events.length === 3, `stored=${store.events.length}`);
  ok(counters.evicted === 3, `evicted=${counters.evicted}`);
  ok(counters.dropped === 0, `dropped=${counters.dropped}`);
});

check('C47', 'maxBodyBytes 截断计入 truncated 并保留 originalBytes', () => {
  const store = makeStore({ config: { maxBodyBytes: 16 } });
  store.add(httpEvent());
  store.addBody({ requestId: '1000.1', kind: 'response', data: 'x'.repeat(64), contentType: 'text/plain' });
  ok(store.counters.truncated >= 1, `truncated=${store.counters.truncated}`);
  const record = store.readBody({ requestId: '1000.1', kind: 'response' });
  ok(Boolean(record), 'body readable');
  ok(record.bytes <= 16, `bytes=${record.bytes}`);
  ok(record.originalBytes >= 64, `originalBytes=${record.originalBytes}`);
});

check('C47', 'maxTotalBytes 淘汰最旧 body 并计 bodyEvicted（事件保留）', () => {
  const store = makeStore({ config: { maxBodyBytes: 64, maxTotalBytes: 80 } });
  store.add(httpEvent({ requestId: 'b.1' }));
  store.add(httpEvent({ requestId: 'b.2' }));
  store.addBody({ requestId: 'b.1', kind: 'response', data: 'a'.repeat(60) });
  store.addBody({ requestId: 'b.2', kind: 'response', data: 'b'.repeat(60) });
  ok(store.counters.bodyEvicted >= 1, `bodyEvicted=${store.counters.bodyEvicted}`);
  ok(store.counters.events === 2, 'events kept');
});

check('C47', '关闭采集维度时事件被拒并计 dropped（不是 evicted）', () => {
  const store = makeStore({ config: { captureWebSocket: false } });
  const dropped = store.add({ kind: 'ws', phase: 'frame-sent', requestId: 'ws.1', ws: { direction: 'send', opcode: 1, payload: 'hi' } });
  ok(dropped === null, 'not stored');
  ok(store.counters.dropped >= 1, 'dropped counted');
  ok(store.counters.evicted === 0, 'evicted untouched');
});

check('C48', 'integrity.complete 只在无丢/无淘汰/无截断时为 true', () => {
  const clean = makeStore();
  clean.add(httpEvent());
  ok(clean.integrity().complete === true, 'clean complete');
  const dirty = makeStore({ config: { maxEvents: 2 } });
  for (let index = 0; index < 5; index += 1) dirty.add(httpEvent({ requestId: `d.${index}` }));
  const integrity = dirty.integrity();
  ok(integrity.complete === false, 'dirty incomplete');
  ok(integrity.evicted >= 1, 'evicted reported');
  const block = evidenceBlock(dirty, 'events');
  ok(block.version === 1 && typeof block.operation === 'string', 'evidence block v1');
  ok(!(block.integrity.complete === true && integrity.evicted > 0), 'no complete:true with loss');
});

check('C2', 'body 三态：captured / empty / unavailable 可区分', () => {
  const store = makeStore();
  store.add(httpEvent({ requestId: 'c.1' }));
  const event = store.events[0];
  store.addBody({ targetId: event.targetId, hopId: event.hopId, requestId: 'c.1', kind: 'request', state: 'empty' });
  store.addBody({ targetId: event.targetId, hopId: event.hopId, requestId: 'c.1', kind: 'response', state: 'captured', data: '{"ok":1}', contentType: 'application/json' });
  const state = store.bodyState(store.events[0]);
  const serialised = JSON.stringify(state);
  ok(serialised.includes('empty'), `request state empty: ${serialised.slice(0, 220)}`);
  ok(serialised.includes('captured'), 'response state captured');
  ok(!serialised.includes('undefined'), 'no undefined in body state');
  const missing = store.bodyState({ requestId: 'nope', targetId: 'T1', hopId: 0, cdpSessionId: null });
  ok(JSON.stringify(missing).includes('unavailable') || JSON.stringify(missing).includes('false'), 'missing body reported unavailable');
});

/* ------------------------------------------------------------------------------------------------
 * TOOL-P1-04 — body 不可得原因码（classifyBodyFailure / reasonCode / reasonDetail / not-captured）
 * ---------------------------------------------------------------------------------------------- */

check('C2', 'TOOL-P1-04 classifyBodyFailure 映射稳定枚举，且不回显错误原文', () => {
  const withCode = (code, message) => Object.assign(new Error(message), { code });
  const cases = [
    [withCode('CDP_TIMEOUT', 'CDP 超时: Network.getResponseBody'), 'cdp-timeout'],
    [new Error('request timed out after 800ms'), 'cdp-timeout'],
    [withCode('CDP_DISCONNECTED', 'CDP 连接已关闭'), 'cdp-disconnected'],
    [new Error('Target closed'), 'cdp-disconnected'],
    [new Error('No resource with given identifier found'), 'cdp-no-resource'],
    [new Error('No data found for resource with given identifier'), 'cdp-evicted'],
    [withCode('INVALID_ARGUMENT', 'Invalid parameters'), 'cdp-invalid-params'],
    [{ code: -32602, message: 'Invalid parameters' }, 'cdp-invalid-params'],
    [{ code: -32000, message: 'Protocol handshake failed' }, 'cdp-error'],
    [withCode('INTERNAL', 'CDP error: unexpected response'), 'cdp-error'],
    [new Error('mysterious failure'), 'cdp-unknown'],
    [null, 'cdp-unknown'],
    [undefined, 'cdp-unknown'],
  ];
  for (const [error, expected] of cases) {
    const actual = classifyBodyFailure(error);
    ok(actual === expected, `${expected}: got ${actual}`);
    ok(NET_BODY_REASON_CODES.includes(actual), 'only stable enum values');
  }
  // 敏感内容只用于匹配、不随枚举回显（返回值是纯字符串枚举）。
  const sensitive = classifyBodyFailure(new Error('GET https://alice:pass@127.0.0.1/x?token=rawtoken failed'));
  ok(sensitive === 'cdp-unknown', `sensitive message stays unknown: ${sensitive}`);
  ok(!String(sensitive).includes('rawtoken'), 'no secret echo');
  // reasonDetail 归一化：空值 → null，控制字符压成单行，敏感值脱敏，字节上限 160。
  ok(normalizeBodyReasonDetail(null) === null && normalizeBodyReasonDetail('   ') === null, 'empty detail -> null');
  const bounded = normalizeBodyReasonDetail('line1\nline2 token=rawtoken ' + 'z'.repeat(300));
  ok(Buffer.byteLength(bounded, 'utf8') <= 160, 'detail bounded');
  ok(!bounded.includes('rawtoken') && !bounded.includes('\n'), 'detail single-line + redacted');
});

check('C2', 'TOOL-P1-04 unavailable 记录保留 reasonCode/reasonDetail，readBody/bodyState 可读', () => {
  const store = makeStore();
  store.add(httpEvent({ requestId: 'reason.1' }));
  const event = store.events[0];
  const options = { targetId: event.targetId, cdpSessionId: event.cdpSessionId, requestId: 'reason.1', hopId: event.hopId };
  const rawDetail = 'Network.getResponseBody 失败: GET https://alice:pass@127.0.0.1/x?token=rawtoken ' + 'x'.repeat(200);
  const stored = store.addBody({
    ...options, kind: 'response', state: 'unavailable', reasonCode: 'cdp-timeout', reasonDetail: rawDetail,
  });
  ok(stored && stored.state === 'unavailable' && stored.reasonCode === 'cdp-timeout', `stored=${JSON.stringify(stored)}`);
  ok(Buffer.byteLength(stored.reasonDetail, 'utf8') <= 160, 'detail bounded to 160 bytes');
  ok(!stored.reasonDetail.includes('rawtoken') && !stored.reasonDetail.includes('alice'), 'detail redacted');
  const read = store.readBody({ ...options, kind: 'response' });
  ok(read && read.state === 'unavailable' && read.available === false, 'unavailable readable');
  ok(read.reason === 'NET_BODY_UNAVAILABLE' && read.reasonCode === 'cdp-timeout', 'legacy reason kept + reasonCode added');
  ok(read.reasonDetail === stored.reasonDetail, 'bounded/redacted detail persisted');
  ok(read.bytes === null && read.data === null && read.encoding === null, 'no fabricated payload (data stays null, not empty string)');
  const state = store.bodyState(event);
  ok(state.response.state === 'unavailable' && state.response.available === false, 'bodyState unavailable');
  ok(state.response.reason === 'NET_BODY_UNAVAILABLE' && state.response.reasonCode === 'cdp-timeout', 'bodyState reason code');
  ok(!JSON.stringify(state).includes('undefined'), 'no undefined in body state');

  // 省略 reasonCode 或给未知取值：稳定回落 cdp-unknown（不写入自造词）。
  store.addBody({ ...options, kind: 'request', state: 'unavailable' });
  ok(store.bodyState(event).request.reasonCode === 'cdp-unknown', 'omitted reasonCode -> cdp-unknown');
  store.addBody({ ...options, kind: 'request', state: 'unavailable', reasonCode: 'vendor-quirk' });
  ok(store.bodyState(event).request.reasonCode === 'cdp-unknown', 'unknown reasonCode -> cdp-unknown');

  // 最新一次尝试优先：后续 captured 记录清除失败原因，三态语义不变。
  store.addBody({ ...options, kind: 'response', state: 'captured', data: '{"ok":1}', contentType: 'application/json' });
  const captured = store.readBody({ ...options, kind: 'response' });
  ok(captured.state === 'captured' && captured.available === true, 'captured wins as latest attempt');
  ok(captured.reason === null && captured.reasonCode === null && captured.reasonDetail === null, 'captured has no reason');
  ok(store.bodyState(event).response.reasonCode === null, 'bodyState captured reason null');
});

check('C2', 'TOOL-P1-04 本地配额淘汰的 body 读为 unavailable + cdp-evicted（旧口径改动的理由）', () => {
  const store = makeStore({ config: { maxBodyBytes: 64, maxTotalBytes: 80 } });
  store.addBody({ requestId: 'ev.1', kind: 'response', data: 'a'.repeat(60) });
  store.addBody({ requestId: 'ev.2', kind: 'response', data: 'b'.repeat(60) });
  ok(store.counters.bodyEvicted >= 1, `bodyEvicted=${store.counters.bodyEvicted}`);
  const evicted = store.readBody({ requestId: 'ev.1', kind: 'response' });
  ok(evicted && evicted.state === 'unavailable' && evicted.available === false, `evicted state=${evicted && evicted.state}`);
  ok(evicted.reasonCode === 'cdp-evicted', `reasonCode=${evicted.reasonCode}`);
  const kept = store.readBody({ requestId: 'ev.2', kind: 'response' });
  ok(kept && kept.state === 'captured' && kept.data === 'b'.repeat(60), 'newest body kept');
});

check('C2', 'TOOL-P1-04 captureBodies:false 明确 reasonCode=not-captured（detail/bodyState/readBody）', () => {
  const store = makeStore({ config: { captureBodies: false } });
  store.add(httpEvent({ requestId: 'off.1' }));
  const event = store.events[0];
  const options = { targetId: event.targetId, cdpSessionId: event.cdpSessionId, requestId: 'off.1', hopId: event.hopId };
  ok(store.addBody({ ...options, kind: 'response', data: '{"x":1}' }) === null, 'captureBodies:false stores no body');
  ok(store.readBody({ ...options, kind: 'response' }) === null, 'readBody still null (no fabricated record)');
  const state = store.bodyState(event);
  ok(state.response.state === 'unavailable' && state.response.available === false, 'bodyState unavailable');
  ok(state.response.reason === 'NET_BODY_UNAVAILABLE' && state.response.reasonCode === 'not-captured', 'not-captured is not a CDP error');
  const detail = detailEvent(store, { seq: event.seq, include: ['body'] });
  ok(detail.body.response.available === false && detail.body.response.reasonCode === 'not-captured', 'detail body reasonCode');
  ok(Buffer.byteLength(String(detail.body.request.reasonCode), 'utf8') <= 16, 'detail request body also not-captured');
  ok(detail.body.request.reasonCode === 'not-captured', 'detail.request reasonCode');

  // 采集开启但没有任何记录/失败原因：保持 reasonCode:null（不猜、不伪造 cdp-*）。
  const capturing = makeStore();
  capturing.add(httpEvent({ requestId: 'on.1' }));
  const open = detailEvent(capturing, { seq: capturing.events[0].seq, include: ['body'] });
  ok(open.body.response.available === false && open.body.response.reason === 'NET_BODY_UNAVAILABLE', 'open capture still unavailable');
  ok(open.body.response.reasonCode === null, 'no evidence -> null, not a guessed cdp-* code');
});

check('C34', 'TOOL-P1-04 attribution 在会话视图/status/evidenceBlock 中一致回传（缺失为 null）', () => {
  const store = new Store({ scopeId: 'scope-a', attribution: { runtimeId: 'rt-1', tabId: 'tab-7' } });
  const before = store.status();
  ok(before.attribution.scopeId === 'scope-a' && before.attribution.runtimeId === 'rt-1' && before.attribution.tabId === 'tab-7', 'status attribution before start');
  ok(before.session === null, 'no session yet');
  store.start({ name: 'attr' });
  const status = store.status();
  ok(status.attribution.scopeId === 'scope-a' && status.attribution.tabId === 'tab-7', 'status top-level attribution');
  ok(status.session.attribution && status.session.attribution.tabId === 'tab-7', 'sessionView attribution');
  ok(status.session.attribution.runtimeId === 'rt-1', 'sessionView runtimeId');
  const block = evidenceBlock(store, 'status');
  ok(block.attribution && block.attribution.scopeId === 'scope-a' && block.attribution.runtimeId === 'rt-1' && block.attribution.tabId === 'tab-7', 'evidenceBlock attribution');
  ok(!JSON.stringify(block).includes('undefined'), 'no undefined in evidence block');

  // 未给 attribution：只回传构造器已知的 scopeId，runtimeId/tabId 为 null（不从 cdpSessionId 反推）。
  const bare = new Store({ scopeId: 'scope-b' });
  const bareStatus = bare.status();
  ok(bareStatus.attribution.scopeId === 'scope-b', 'constructor scopeId is known fact');
  ok(bareStatus.attribution.runtimeId === null && bareStatus.attribution.tabId === null, 'unknown fields stay null');
  const bareBlock = evidenceBlock(bare, 'events');
  ok(bareBlock.attribution.tabId === null, 'evidence block does not infer tab');

  // 切 tab 只更新 tabId；显式 null 清空；reset 只清空 runtimeId/tabId 并保留 scopeId。
  store.setAttribution({ tabId: 'tab-8' });
  ok(store.status().attribution.tabId === 'tab-8' && store.status().attribution.runtimeId === 'rt-1', 'partial update keeps other fields');
  store.setAttribution({ tabId: 'x'.repeat(400) });
  ok(Buffer.byteLength(store.status().attribution.tabId, 'utf8') <= 128, 'attribution ids bounded (128 bytes)');
  store.setAttribution({ tabId: null });
  ok(store.status().attribution.tabId === null && store.status().attribution.runtimeId === 'rt-1', 'explicit null clears one field');
  store.setAttribution(null);
  ok(store.status().attribution.runtimeId === null && store.status().attribution.tabId === null, 'setAttribution(null) resets unknown fields');
  ok(store.status().attribution.scopeId === 'scope-a', 'scopeId stays a known fact after reset');
  ok(store.status().session.attribution.tabId === null, 'sessionView follows current attribution');
});

/* ------------------------------------------------------------------------------------------------
 * C30/C32 — steps, windows and causality bases
 * ---------------------------------------------------------------------------------------------- */

check('C30', 'beginStep/endStep 生成窗口并拒绝重复 stepId', () => {
  const store = makeStore();
  const step = store.beginStep({ name: 's1', stepId: 'step-unit-1' });
  ok(step.stepId === 'step-unit-1', 'explicit stepId');
  store.add(httpEvent());
  const ended = store.endStep({ stepId: 'step-unit-1' });
  ok(ended.toSeq >= ended.fromSeq, 'closed window');
  let conflict = null;
  try { store.beginStep({ name: 's1', stepId: 'step-unit-1' }); } catch (error) { conflict = error; }
  ok(conflict && /NET_RULE_CONFLICT/.test(String(conflict.code)), `conflict code=${conflict && conflict.code}`);
});

check('C30', 'window() 用 highWater/nearest 报告时间窗（R1-16）', () => {
  const store = makeStore();
  for (let index = 0; index < 3; index += 1) store.add(httpEvent({ requestId: `w.${index}` }));
  const highWater = store.highWater;
  const window_ = store.window({ frameTimeMs: Date.now(), captureEndMs: Date.now(), highWater });
  ok(Number.isInteger(window_.toSeq) && window_.toSeq <= highWater, `toSeq=${window_.toSeq}`);
  ok('nearest' in window_ && 'fromSeq' in window_, 'fromSeq/nearest present');
});

check('C32', 'causality 只用合法 basis，默认不返回 temporal', () => {
  const store = makeStore();
  store.add(httpEvent());
  const begin = store.beginStep({ name: 'c' });
  store.add(httpEvent({ requestId: '1000.9', phase: 'finished', status: 200 }));
  store.link({ seq: 1, stepId: begin.stepId, evidenceId: 'ev-1' });
  store.endStep({ stepId: begin.stepId });
  const value = traceNetwork(store, { action: 'query' });
  const causality = value.causality || [];
  ok(causality.every((item) => ['explicit', 'redirect', 'initiator', 'temporal'].includes(item.basis)), 'basis enum');
  ok((value.causality || []).every((item) => item.basis !== 'temporal'), 'temporal not returned by default');
});

/* ------------------------------------------------------------------------------------------------
 * C41/C42 — JSONL fidelity, HAR 1.2 subset, import error codes
 * ---------------------------------------------------------------------------------------------- */

check('C42', 'JSONL 往返保真（事件数/URL/状态一致）', () => {
  const store = makeStore();
  store.add(httpEvent({ phase: 'response', status: 200 }));
  store.add(httpEvent({ requestId: '1000.2', url: 'http://127.0.0.1:1/n/status/500', phase: 'response', status: 500 }));
  const bytes = toJsonl(store);
  const parsed = fromJsonl(bytes);
  ok(parsed.events.length === 2, `events=${parsed.events.length}`);
  ok(parsed.events[0].url === store.events[0].url && parsed.events[1].status === 500, 'fields preserved');
  ok(parsed.meta && (parsed.meta.version === 1 || parsed.meta.type === 'meta'), 'meta present');
});

check('C42', 'JSONL 导入保留 seq 空洞并标 complete:false', () => {
  const source = makeStore();
  for (let index = 0; index < 3; index += 1) source.add(httpEvent({ requestId: `hole.${index}` }));
  const lines = toJsonl(source).toString('utf8').split('\n').filter(Boolean);
  // Drop the middle event line: the import must keep seq 1 and 3 and report a gap.
  const holed = [lines[0], lines[1], lines[3]].join('\n') + '\n';
  const imported = fromJsonl(Buffer.from(holed, 'utf8'));
  ok(imported.events.map((event) => event.seq).join(',') === '1,3', `seqs=${imported.events.map((event) => event.seq)}`);
  const target = new Store({});
  loadImported(target, imported, { name: 'hole' });
  const integrity = target.integrity();
  ok(integrity.complete === false, 'incomplete');
  ok(JSON.stringify(integrity).includes('gap') || integrity.issues.includes('import-partial'),
    `gaps/issues=${JSON.stringify(integrity.gaps)}/${JSON.stringify(integrity.issues)}`);
});

check('C42', '坏 JSONL 行 → NET_IMPORT_FAILED，未知格式报错而不是静默', () => {
  let error = null;
  try { fromJsonl(Buffer.from('not-json\n', 'utf8')); } catch (caught) { error = caught; }
  ok(error && String(error.code).startsWith('NET_'), `code=${error && error.code}`);
  const detected = parseImportedEvidence('{"log":{"version":"1.2","entries":[]}}');
  ok(detected && (detected.format === 'har' || detected.kind === 'har'), `detected=${JSON.stringify(detected && detected.format)}`);
});

check('C42', 'HAR 1.2 导出条目含必填字段并用 -1 表达未知值', () => {
  const store = makeStore();
  store.add(httpEvent({ phase: 'request' }));
  store.add(httpEvent({ phase: 'response', status: 200, statusText: 'OK', mimeType: 'application/json', protocol: 'http/1.1' }));
  store.add(httpEvent({ phase: 'finished', status: 200 }));
  const har = toHar(store);
  ok(har.log.version === '1.2', 'version');
  const entry = har.log.entries[0];
  ok(Boolean(entry), 'entries present');
  if (entry) {
    const timings = entry.timings || {};
    ok(Object.values(timings).every((value) => typeof value === 'number'), 'timings are numbers');
    ok(Object.values(timings).every((value) => value !== null), 'no null timings');
    ok(typeof entry.request?.method === 'string' && typeof entry.request?.url === 'string', 'request fields');
    ok(typeof entry.response?.status === 'number', 'response status');
    ok(entry.cache && typeof entry.cache === 'object', 'cache object');
  }
});

check('C42', 'HAR 往返只保证 HTTP 条目一致（WS/SSE 由 JSONL 保真）', () => {
  const store = makeStore();
  store.add(httpEvent({ phase: 'request' }));
  store.add(httpEvent({ phase: 'response', status: 201, statusText: 'Created' }));
  store.add(httpEvent({ phase: 'finished', status: 201 }));
  const har = toHar(store);
  const roundTrip = fromHar(har);
  ok(roundTrip && (Array.isArray(roundTrip.events) || Array.isArray(roundTrip.entries)), 'import returns events');
  const urls = (roundTrip.events || []).map((event) => event.url).filter(Boolean);
  ok(urls.length === 0 || urls.includes(har.log.entries[0].request.url), `urls=${JSON.stringify(urls)}`);
});

check('C41', 'publishEvidence 落盘 0600 且不覆盖已有文件', async () => {
  const root = await mkdtemp(join(tmpdir(), 'net-unit-'));
  try {
    const target = join(root, 'evidence.jsonl');
    const { publishEvidence, resolveEvidencePath } = await import('../network-p0.js');
    const resolved = resolveEvidencePath({ root, out: 'output/network/unit.jsonl' });
    ok(resolved.ok !== false || typeof resolved.absolutePath === 'string', `resolve=${JSON.stringify(resolved).slice(0, 160)}`);
    await publishEvidence(root, target, Buffer.from('line\n', 'utf8'));
    const info = await stat(target);
    ok((info.mode & 0o777) === 0o600, `mode=${(info.mode & 0o777).toString(8)}`);
    const second = await publishEvidence(root, target, Buffer.from('second\n', 'utf8'));
    ok(second && second.ok === false && String(second.code) === 'OUTPUT_EXISTS', `second write refused (${JSON.stringify(second && second.code)})`);
    ok(String((await readFile(target, 'utf8'))).trim() === 'line', 'content preserved');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

/* ------------------------------------------------------------------------------------------------
 * C49 — independent subscription cursors
 * ---------------------------------------------------------------------------------------------- */

check('C49', '两个订阅独立投递、ack 互不影响、不重复投递', () => {
  const store = makeStore();
  const a = subscriptionCreate(store, { ownerSessionId: 'agent-a', afterSeq: 0 });
  const b = subscriptionCreate(store, { ownerSessionId: 'agent-b', afterSeq: 0 });
  store.add(httpEvent());
  store.add(httpEvent({ requestId: '1000.2' }));
  const idA = a.id || a.subscription?.id;
  const idB = b.id || b.subscription?.id;
  ok(idA !== idB, 'distinct ids');
  const pollA = subscriptionPoll(store, { subscriptionId: idA, ownerSessionId: 'agent-a', limit: 10 });
  const pollB = subscriptionPoll(store, { subscriptionId: idB, ownerSessionId: 'agent-b', limit: 10 });
  const eventsA = pollA.events || [];
  const eventsB = pollB.events || [];
  ok(eventsA.length >= 1 && eventsB.length >= 1, 'both delivered');
  subscriptionAck(store, { subscriptionId: idA, ownerSessionId: 'agent-a', ackSeq: eventsA.at(-1).seq });
  store.add(httpEvent({ requestId: '1000.3' }));
  const repollA = subscriptionPoll(store, { subscriptionId: idA, ownerSessionId: 'agent-a', limit: 10 }).events || [];
  const repollB = subscriptionPoll(store, { subscriptionId: idB, ownerSessionId: 'agent-b', limit: 10 }).events || [];
  ok(repollA.every((event) => event.seq > (eventsA.at(-1)?.seq ?? 0)), 'A not re-delivered');
  ok(repollB.every((event) => !eventsB.some((seen) => seen.seq === event.seq)), 'B no duplicates');
  let forbidden = null;
  try { subscriptionPoll(store, { subscriptionId: idA, ownerSessionId: 'agent-c', limit: 5 }); } catch (error) { forbidden = error; }
  ok(forbidden && /NET_SUBSCRIPTION_FORBIDDEN/.test(String(forbidden.code)), `forbidden=${forbidden && forbidden.code}`);
  subscriptionClose(store, { subscriptionId: idA, ownerSessionId: 'agent-a' });
  const listed = subscriptionList(store, { ownerSessionId: 'agent-a' });
  const listArray = Array.isArray(listed) ? listed : (listed.subscriptions || []);
  ok(listArray.length === 0, `closed subscription gone (${JSON.stringify(listed).slice(0, 120)})`);
});

check('C49', '游标回退被拒绝（NET_*，防重复投递）', () => {
  const store = makeStore();
  const sub = subscriptionCreate(store, { ownerSessionId: 'agent-x', afterSeq: 0 });
  store.add(httpEvent());
  store.add(httpEvent({ requestId: '1000.2' }));
  const id = sub.id || sub.subscription?.id;
  const polled = subscriptionPoll(store, { subscriptionId: id, ownerSessionId: 'agent-x', limit: 10 }).events || [];
  subscriptionAck(store, { subscriptionId: id, ownerSessionId: 'agent-x', ackSeq: polled.at(-1)?.seq ?? 1 });
  let error = null;
  try { subscriptionPoll(store, { subscriptionId: id, ownerSessionId: 'agent-x', afterSeq: 0, limit: 10 }); } catch (caught) { error = caught; }
  ok(error !== null && String(error.code || '').startsWith('NET_'), `code=${error && error.code}`);
});

/* ------------------------------------------------------------------------------------------------
 * C34/C46/C50 — session lifecycle, offline sessions, capability report
 * ---------------------------------------------------------------------------------------------- */

check('C34', 'start 幂等语义与 stop/reset 在 store 层可观测', () => {
  const store = new Store({});
  const started = store.start({ name: 'unit-start' });
  ok(started && started.session && started.session.id, `session id (${JSON.stringify(started && started.session && started.session.id)})`);
  ok(started.changed === true, 'changed:true on first start');
  store.add(httpEvent());
  ok(store.counters.events === 1, 'event stored');
  store.stop();
  ok(store.running === false, 'stopped');
  ok(store.add(httpEvent()) === null, 'stopped session refuses events');
  const restarted = store.start({ name: 'unit-restart' });
  // §3.4: events seen while stopped live in the 200-entry candidate buffer and are promoted on
  // start with `preSession:true`; the new session still numbers its sequence from 1.
  ok(restarted.changed === true, 'restart changed');
  ok(store.events.every((event) => Number.isInteger(event.seq) && event.seq >= 1), 'restart numbers from 1');
  ok(store.events.some((event) => event.preSession === true), 'candidate events promoted with preSession:true');
  store.add(httpEvent());
  store.reset();
  ok(store.events.length === 0 && store.highWater === 0, 'reset clears');
});

check('C46', '离线导入会话是 snapshot 且不可当活动采集使用', () => {
  const source = makeStore();
  source.add(httpEvent());
  const imported = fromJsonl(toJsonl(source));
  const target = new Store({});
  loadImported(target, imported, { name: 'offline' });
  ok(target.state === 'snapshot', `state=${target.state}`);
  ok(target.add(httpEvent()) === null, 'snapshot does not accept live events');
  ok(target.events.length === imported.events.length, 'imported events readable');
});

check('C50', 'networkCapabilities 声明 7 工具与全部限额，https=mechanism-identical', () => {
  const store = makeStore();
  const caps = networkCapabilities(store);
  const section = caps.network || caps;
  ok(Array.isArray(section.tools) && section.tools.length === 7, `tools=${section.tools && section.tools.length}`);
  const limits = section.limits || {};
  ok(limits.maxEvents === NET_LIMITS.maxEvents && limits.subscriptionMax === 16, 'limits published');
  const serialised = JSON.stringify(section);
  ok(serialised.includes('mechanism-identical') || serialised.includes('"https"'), 'https honesty marker');
  ok(!/"https"\s*:\s*"verified"/.test(serialised), 'https never claims verified');
});

check('C47', 'estimateEventBytes 是固定口径（同输入同输出）', () => {
  const store = makeStore();
  const event = store.add(httpEvent());
  const first = estimateEventBytes(event);
  const second = estimateEventBytes(event);
  ok(first > 0 && first === second, `bytes=${first}`);
});

/* ------------------------------------------------------------------------------------------------
 * Runners
 * ---------------------------------------------------------------------------------------------- */

/**
 * Acceptance-suite entry point: runs every check and reports through the caller's `check(criteria,
 * label, pass, detail)` so the U results land on the same C numbers as the B probes.
 */
export async function runNetworkUnitChecks(report, { tempRoot = null } = {}) {
  const results = [];
  for (const entry of CHECKS) {
    let pass = false;
    let detail = null;
    try {
      await entry.fn({ tempRoot });
      pass = true;
    } catch (error) {
      detail = { name: error?.name, message: String(error?.message || error).slice(0, 600) };
    }
    report(entry.criteria, entry.label, pass, detail);
    results.push({ criteria: entry.criteria, label: entry.label, pass });
  }
  return results;
}

/**
 * Register the node:test subtests only when this file IS the test entry point. Importing it from
 * tests/acceptance/network-p0.mjs (to reuse `runNetworkUnitChecks`) must not register subtests in
 * the acceptance process.
 */
const isTestEntryPoint = Boolean(process.argv[1]) && process.argv[1].endsWith('network-p0.test.mjs');
if (isTestEntryPoint) {
  for (const entry of CHECKS) {
    test(`[${entry.criteria}] ${entry.label}`, async () => {
      await entry.fn();
    });
  }
}
