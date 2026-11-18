/**
 * security-scope.test.mjs — U-class unit checks for the FR-01 Scope & Safety Controller
 * (acceptance GATE-01, INF-01..INF-08).
 *
 * Pure-module invariants only (no browser, no CDP): origin/path matching, config normalisation,
 * budget/concurrency/window enforcement, passive/active mode, stop semantics and the audit trail.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  SCOPE_DEFAULTS, SCOPE_ERROR_CODES, ScopeStore, normalizePathPrefix, normalizeScopeConfig,
  originOf, pathMatches,
} from '../security-scope.js';

const ok = (condition, message) => assert.ok(condition, message);

function makeStore({ config = null, now = null } = {}) {
  let clock = now ?? Date.now();
  const store = new ScopeStore({ scopeId: 'unit', now: () => clock });
  if (config) store.configure(config, {});
  return { store, tick: (ms) => { clock += ms; } };
}

/** Runs fn, asserts it throws a scope refusal with the given code. */
function refuse(fn, code, label) {
  assert.throws(fn, (error) => error && error.code === code, label + ' (expected ' + code + ')');
}

/* -----------------------------------------------------------------------------------------------
 * INF-01: exact-origin matching
 * ---------------------------------------------------------------------------------------------- */

test('INF-01 originOf: exact origin, refuses non-HTTP and unparsable', () => {
  ok(originOf('http://127.0.0.1:8088/x') === 'http://127.0.0.1:8088');
  ok(originOf('https://example.com:443') === 'https://example.com');
  ok(originOf('file:///x') === null);
  ok(originOf('nope') === null);
  ok(originOf(null) === null);
});

test('INF-01 same-site (port/protocol/host mismatch) is out of scope', () => {
  const { store } = makeStore({ config: { allowedOrigins: ['http://127.0.0.1:8088'], mode: 'active' } });
  ok(store.checkDispatch('http://127.0.0.1:8088/api', { kind: 'request' }).ok === true);
  refuse(() => store.checkDispatch('http://127.0.0.1:9999/api', {}), SCOPE_ERROR_CODES.ORIGIN_VIOLATION, 'port');
  refuse(() => store.checkDispatch('https://127.0.0.1:8088/api', {}), SCOPE_ERROR_CODES.ORIGIN_VIOLATION, 'protocol');
  refuse(() => store.checkDispatch('http://app.localhost:8088/api', {}), SCOPE_ERROR_CODES.ORIGIN_VIOLATION, 'host');
});

/* -----------------------------------------------------------------------------------------------
 * INF-01/INF-02: path constraints
 * ---------------------------------------------------------------------------------------------- */

test('INF-01 path prefix matching: /x matches /x and /x/y, never /xy', () => {
  ok(pathMatches('/x', ['/x']) === true);
  ok(pathMatches('/x/y', ['/x']) === true);
  ok(pathMatches('/xy', ['/x']) === false);
  ok(pathMatches('/x', ['/']) === true);
  ok(pathMatches('/anything', []) === true, 'empty constraints = no tightening');
});

test('INF-01 path violation refuses with 0 dispatches and PATH_VIOLATION', () => {
  const { store } = makeStore({ config: { allowedOrigins: ['http://127.0.0.1:8088'], allowedPaths: ['/api'], mode: 'active' } });
  ok(store.checkDispatch('http://127.0.0.1:8088/api/users', {}).ok === true);
  refuse(() => store.checkDispatch('http://127.0.0.1:8088/admin', {}), SCOPE_ERROR_CODES.PATH_VIOLATION, 'outside prefix');
  ok(store.status().counters.dispatches === 1, 'the refused call added no dispatch');
  ok(store.status().counters.rejected === 1, 'the refusal is counted');
});

/* -----------------------------------------------------------------------------------------------
 * 配置规范化
 * ---------------------------------------------------------------------------------------------- */

test('config normalisation: whitelist mandatory, shapes enforced, budget bounded', () => {
  assert.throws(() => normalizeScopeConfig({}), (e) => e.code === SCOPE_ERROR_CODES.INVALID_ARGUMENT, 'no whitelist refused');
  assert.throws(() => normalizeScopeConfig({ allowedOrigins: ['http://x/y'] }), (e) => e.code === SCOPE_ERROR_CODES.INVALID_ARGUMENT, 'non-exact origin refused');
  assert.throws(() => normalizeScopeConfig({ allowedOrigins: ['http://a:1'], maxConcurrent: 17 }), (e) => e.code === SCOPE_ERROR_CODES.INVALID_ARGUMENT, 'concurrency cap');
  assert.throws(() => normalizeScopeConfig({ allowedOrigins: ['http://a:1'], maxRequests: 0 }), (e) => e.code === SCOPE_ERROR_CODES.INVALID_ARGUMENT, 'zero budget');
  assert.throws(() => normalizeScopeConfig({ allowedOrigins: ['http://a:1'], mode: 'aggressive' }), (e) => e.code === SCOPE_ERROR_CODES.INVALID_ARGUMENT, 'bad mode');
  const config = normalizeScopeConfig({ allowedOrigins: ['http://a:1', 'http://a:1', 'http://b:2'], allowedPaths: ['/api/', '/api'], maxRequests: 10 });
  ok(config.allowedOrigins.length === 2, 'duplicate origins collapse');
  ok(config.allowedPaths.length === 1, 'duplicate path prefixes collapse');
  ok(config.maxRequests === 10);
  ok(config.mode === 'passive', 'default mode is passive');
});

/* -----------------------------------------------------------------------------------------------
 * INF-04: budget (time-window)
 * ---------------------------------------------------------------------------------------------- */

test('INF-04 budget exhaustion refuses with BUDGET_EXCEEDED and 0 dispatches', () => {
  const { store } = makeStore({ config: { allowedOrigins: ['http://a:1'], maxRequests: 3, mode: 'active' } });
  for (let i = 0; i < 3; i += 1) ok(store.checkDispatch('http://a:1/x', {}).ok === true);
  refuse(() => store.checkDispatch('http://a:1/x', {}), SCOPE_ERROR_CODES.BUDGET_EXCEEDED, 'over budget');
  ok(store.status().counters.dispatches === 3);
});

test('INF-04 window reset restores budget after timeWindowMs', () => {
  const { store, tick } = makeStore({ config: { allowedOrigins: ['http://a:1'], maxRequests: 2, timeWindowMs: 1000, mode: 'active' } });
  store.checkDispatch('http://a:1/x', {});
  store.checkDispatch('http://a:1/x', {});
  refuse(() => store.checkDispatch('http://a:1/x', {}), SCOPE_ERROR_CODES.BUDGET_EXCEEDED, 'window exhausted');
  tick(1001);
  ok(store.checkDispatch('http://a:1/x', {}).ok === true, 'new window restores budget');
});

/* -----------------------------------------------------------------------------------------------
 * INF-05: concurrency
 * ---------------------------------------------------------------------------------------------- */

test('INF-05 concurrency ceiling refuses with CONCURRENCY_EXCEEDED; release restores', () => {
  const { store } = makeStore({ config: { allowedOrigins: ['http://a:1'], maxConcurrent: 2, mode: 'active' } });
  store.checkDispatch('http://a:1/x', {});
  store.checkDispatch('http://a:1/y', {});
  refuse(() => store.checkDispatch('http://a:1/z', {}), SCOPE_ERROR_CODES.CONCURRENCY_EXCEEDED, 'at ceiling');
  store.completeDispatch();
  ok(store.checkDispatch('http://a:1/z', {}).ok === true, 'release restores capacity');
});

/* -----------------------------------------------------------------------------------------------
 * INF-06: passive/active mode
 * ---------------------------------------------------------------------------------------------- */

test('INF-06 passive mode refuses active dispatches; exploratory navigation passes', () => {
  const { store } = makeStore({ config: { allowedOrigins: ['http://a:1'], mode: 'passive' } });
  ok(store.checkDispatch('http://a:1/', { kind: 'navigate', active: false }).ok === true, 'exploratory nav passes');
  refuse(() => store.checkDispatch('http://a:1/', { kind: 'request' }), SCOPE_ERROR_CODES.PASSIVE_MODE, 'active request refused');
  refuse(() => store.checkDispatch('http://a:1/', { kind: 'cookie-export' }), SCOPE_ERROR_CODES.PASSIVE_MODE, 'cookie export refused');
});

test('INF-06 active mode allows everything in scope', () => {
  const { store } = makeStore({ config: { allowedOrigins: ['http://a:1'], mode: 'active' } });
  ok(store.checkDispatch('http://a:1/', { kind: 'request' }).ok === true);
  ok(store.checkDispatch('http://a:1/', { kind: 'cookie-export' }).ok === true);
});

/* -----------------------------------------------------------------------------------------------
 * INF-07: stop semantics
 * ---------------------------------------------------------------------------------------------- */

test('INF-07 stop is idempotent and irreversible; afterwards 0 new dispatches', () => {
  const { store } = makeStore({ config: { allowedOrigins: ['http://a:1'], mode: 'active' } });
  store.checkDispatch('http://a:1/x', {});
  const first = store.stop({ reason: 'user' });
  ok(first.ok === true && first.alreadyStopped === false);
  const second = store.stop({});
  ok(second.alreadyStopped === true, 'stop is idempotent');
  refuse(() => store.checkDispatch('http://a:1/x', {}), SCOPE_ERROR_CODES.STOPPED, 'stopped refuses everything');
  refuse(() => store.configure({ allowedOrigins: ['http://a:1'] }, {}), SCOPE_ERROR_CODES.STOPPED, 'reconfigure refused');
  ok(store.status().counters.dispatches === 1, 'dispatch counter frozen');
});

test('INF-07 unconfigured store: checkDispatch refuses NOT_CONFIGURED', () => {
  const { store } = makeStore({});
  refuse(() => store.checkDispatch('http://a:1/', {}), SCOPE_ERROR_CODES.NOT_CONFIGURED, 'nothing configured');
});

/* -----------------------------------------------------------------------------------------------
 * INF-06: audit trail
 * ---------------------------------------------------------------------------------------------- */

test('INF-06 audit records dispatches and refusals with actionId and reason codes', () => {
  const { store } = makeStore({ config: { allowedOrigins: ['http://a:1'], mode: 'active' } });
  store.checkDispatch('http://a:1/x', { actionId: 'act-1' });
  try { store.checkDispatch('http://b:1/x', { actionId: 'act-2' }); } catch { /* expected */ }
  const all = store.auditEntries({});
  ok(all.some((entry) => entry.kind === 'dispatch' && entry.actionId === 'act-1'), 'dispatch audited');
  ok(all.some((entry) => entry.kind === 'reject' && entry.actionId === 'act-2' && entry.code === SCOPE_ERROR_CODES.ORIGIN_VIOLATION), 'refusal audited with code');
  ok(store.auditEntries({ kind: 'reject' }).length === 1, 'kind filter works');
});

test('INF-06 audit ring keeps the newest entries and counts dropped ones', () => {
  // A tight 2100-dispatch loop would hit the INF-05 rate limiter; this test is about the ring
  // buffer, so it explicitly disables the rate ceiling instead of silently bypassing it.
  const { store } = makeStore({
    config: { allowedOrigins: ['http://a:1'], maxRequests: 5000, mode: 'active', maxRequestsPerSecond: 0 },
  });
  for (let i = 0; i < 2100; i += 1) {
    store.checkDispatch('http://a:1/x', {});
    store.completeDispatch(); // dispatches must be paired, or the concurrency ceiling refuses
  }
  // configure (1) + 2100 dispatches = 2101 entries; ring keeps 2000, so 101 dropped.
  ok(store.audit.length === 2000, 'ring capped');
  ok(store.auditDropped === 101, 'dropped counter tracks the overflow');
  ok(store.audit[0].seq === 102, 'kept entries are the newest (seq is global)');
});

/* -----------------------------------------------------------------------------------------------
 * CAS 重配置
 * ---------------------------------------------------------------------------------------------- */

test('reconfigure CAS: matching revision applies; mismatch refuses without applying', () => {
  const { store } = makeStore({ config: { allowedOrigins: ['http://a:1'], mode: 'passive' } });
  ok(store.configRevision === 1, 'first configure increments');
  const config = store.configure({ allowedOrigins: ['http://a:1'], mode: 'active' }, { expectedConfigRevision: 1 });
  ok(config.mode === 'active' && store.configRevision === 2, 'matching CAS applies');
  assert.throws(() => store.configure({ allowedOrigins: ['http://a:1'], mode: 'passive' }, { expectedConfigRevision: 0 }),
    (e) => e.code === SCOPE_ERROR_CODES.INVALID_ARGUMENT, 'stale CAS refuses');
  ok(store.config.mode === 'active', 'refused patch was not applied');
});

/* -----------------------------------------------------------------------------------------------
 * REG-04: status projection never exposes exploration URLs
 * ---------------------------------------------------------------------------------------------- */

test('REG-04 status projection carries counters and boundaries, never target URLs', () => {
  const { store } = makeStore({ config: { allowedOrigins: ['http://a:1'], mode: 'active' } });
  store.checkDispatch('http://a:1/secret-path-123', {});
  const projection = JSON.stringify(store.status());
  ok(!projection.includes('secret-path-123'), 'status never leaks the exploration trail');
  ok(JSON.stringify(store.auditEntries({})).includes('secret-path-123'), 'audit keeps it for evidence export');
});

/* -----------------------------------------------------------------------------------------------
 * INF-08 / GATE-07：危险操作识别
 * ---------------------------------------------------------------------------------------------- */

import { classifyDanger, DANGEROUS_PATH_PATTERNS, DANGEROUS_METHODS } from '../security-scope.js';

test('INF-08 destructive methods (DELETE) are flagged on any path', () => {
  const verdict = classifyDanger({ method: 'DELETE', url: 'http://a:1/api/orders/1', allowedOrigins: ['http://a:1'] });
  ok(verdict.dangerous === true && verdict.reason === 'destructive-method');
});

test('INF-08 dangerous path semantics: payment, registration, purge', () => {
  ok(classifyDanger({ method: 'POST', url: 'http://a:1/api/checkout/commit', allowedOrigins: ['http://a:1'] }).dangerous === true, 'checkout commit');
  ok(classifyDanger({ method: 'POST', url: 'http://a:1/api/pay', allowedOrigins: ['http://a:1'] }).dangerous === true, 'pay');
  ok(classifyDanger({ method: 'POST', url: 'http://a:1/api/register', allowedOrigins: ['http://a:1'] }).dangerous === true, 'register');
  ok(classifyDanger({ method: 'POST', url: 'http://a:1/api/cart/add', allowedOrigins: ['http://a:1'] }).dangerous === false, 'normal cart add is fine');
});

test('INF-08 out-of-scope origin is an external-callback candidate', () => {
  const verdict = classifyDanger({ method: 'POST', url: 'http://evil:2/cb', allowedOrigins: ['http://a:1'] });
  ok(verdict.dangerous === true && verdict.reason === 'out-of-scope-origin');
});

test('INF-08 normal active-test writes are classified writeOperation, not dangerous', () => {
  const verdict = classifyDanger({ method: 'POST', url: 'http://a:1/api/tickets', allowedOrigins: ['http://a:1'] });
  ok(verdict.dangerous === false && verdict.writeOperation === true);
  ok(classifyDanger({ method: 'GET', url: 'http://a:1/api/products', allowedOrigins: ['http://a:1'] }).dangerous === false);
});

test('INF-08 danger gate: destructive dispatch refuses with 0 dispatches unless escalated', () => {
  const { store } = makeStore({ config: { allowedOrigins: ['http://a:1'], mode: 'active' } });
  refuse(() => store.checkDispatch('http://a:1/api/checkout/commit', { method: 'POST' }), SCOPE_ERROR_CODES.DANGEROUS_OPERATION, 'payment');
  ok(store.status().counters.dispatches === 0, 'refused call dispatched nothing');
  ok(store.status().counters.rejected === 1, 'rejection audited');
  // Explicit escalation is a per-call decision, still in scope and still budgeted.
  ok(store.checkDispatch('http://a:1/api/checkout/commit', { method: 'POST', allowDangerous: true }).ok === true,
    'allowDangerous:true is an explicit per-call escalation');
  // The next call without escalation is refused again (no sticky permission).
  refuse(() => store.checkDispatch('http://a:1/api/checkout/commit', { method: 'POST' }), SCOPE_ERROR_CODES.DANGEROUS_OPERATION, 'not sticky');
});

test('INF-08 danger gate does not block normal exploration', () => {
  const { store } = makeStore({ config: { allowedOrigins: ['http://a:1'], mode: 'active' } });
  ok(store.checkDispatch('http://a:1/api/products', { method: 'GET' }).ok === true, 'GET products fine');
  ok(store.checkDispatch('http://a:1/api/tickets', { method: 'POST' }).ok === true, 'POST ticket is a normal write');
  refuse(() => store.checkDispatch('http://a:1/api/orders/1', { method: 'DELETE' }), SCOPE_ERROR_CODES.DANGEROUS_OPERATION, 'DELETE refused');
});

/* -----------------------------------------------------------------------------------------------
 * INF-05：速率限制（滚动 1 秒窗口）
 * ---------------------------------------------------------------------------------------------- */

test('INF-05 rate limit refuses the burst beyond maxRequestsPerSecond', () => {
  let clock = 1000;
  const store = new ScopeStore({ scopeId: 'rate', now: () => clock });
  store.configure({ allowedOrigins: ['http://a:1'], mode: 'active', maxRequestsPerSecond: 3 });
  let refused = 0;
  for (let index = 0; index < 5; index += 1) {
    try { store.checkDispatch('http://a:1/x', { method: 'GET' }); store.completeDispatch(); }
    catch (error) { if (error.code === SCOPE_ERROR_CODES.RATE_EXCEEDED) refused += 1; else throw error; }
  }
  ok(refused === 2, 'five dispatches with a 3/s cap refuse two');
  ok(store.status().counters.dispatches === 3, 'only three actually dispatched');
  ok(store.status().counters.rejected === 2, 'refusals audited');
});

test('INF-05 the rate window rolls: after one second the budget returns', () => {
  let clock = 1000;
  const store = new ScopeStore({ scopeId: 'rate2', now: () => clock });
  store.configure({ allowedOrigins: ['http://a:1'], mode: 'active', maxRequestsPerSecond: 2 });
  store.checkDispatch('http://a:1/x', { method: 'GET' });
  store.checkDispatch('http://a:1/x', { method: 'GET' });
  refuse(() => store.checkDispatch('http://a:1/x', { method: 'GET' }), SCOPE_ERROR_CODES.RATE_EXCEEDED, 'at cap');
  clock += 1001;
  ok(store.checkDispatch('http://a:1/x', { method: 'GET' }).ok === true, 'new window restores the rate');
});

test('INF-05 maxRequestsPerSecond=0 disables the limiter', () => {
  const store = new ScopeStore({ scopeId: 'rate3', now: () => 1000 });
  store.configure({ allowedOrigins: ['http://a:1'], mode: 'active', maxRequestsPerSecond: 0, maxConcurrent: 16 });
  for (let index = 0; index < 50; index += 1) {
    ok(store.checkDispatch('http://a:1/x', { method: 'GET' }).ok === true, 'dispatch ' + index);
    store.completeDispatch();
  }
  ok(store.status().counters.dispatches === 50);
  ok(store.status().config.maxRequestsPerSecond === 0);
});

test('INF-05 rate is reported in the status projection and bounded', () => {
  const store = new ScopeStore({ scopeId: 'rate4' });
  store.configure({ allowedOrigins: ['http://a:1'], maxRequestsPerSecond: 37 });
  ok(store.status().config.maxRequestsPerSecond === 37, 'status exposes the configured rate');
  assert.throws(() => normalizeScopeConfig({ allowedOrigins: ['http://a:1'], maxRequestsPerSecond: 1001 }),
    (error) => error.code === SCOPE_ERROR_CODES.INVALID_ARGUMENT, 'over the ceiling refused');
  assert.throws(() => normalizeScopeConfig({ allowedOrigins: ['http://a:1'], maxRequestsPerSecond: -1 }),
    (error) => error.code === SCOPE_ERROR_CODES.INVALID_ARGUMENT, 'negative refused');
  ok(normalizeScopeConfig({ allowedOrigins: ['http://a:1'] }).maxRequestsPerSecond === 20, 'default is 20/s');
});
