/**
 * attack-surface.test.mjs — U-class unit checks for the FR-02 attack surface core
 * (DISC-01..04, DISC-07).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  SURFACE_LIMITS, buildSurfaceInventory, checkEvidenceLevels, extractApiOperations,
  extractPageRoutes, normalizeFormFact, observedAuthState, parseSurfaceUrl,
} from '../attack-surface.js';

const ok = (condition, message) => assert.ok(condition, message);

function httpEvent(overrides = {}) {
  return {
    kind: 'http', phase: 'request', requestId: 'r-' + Math.random().toString(36).slice(2, 8),
    url: 'http://127.0.0.1:8088/api/products', method: 'GET', resourceType: 'XHR',
    seq: overrides.seq ?? 10, ...overrides,
  };
}

/* ----------------------------------------------------------------------------------------------- */

test('parseSurfaceUrl: exact origin/path/query; refuses non-HTTP and junk', () => {
  const parsed = parseSurfaceUrl('http://127.0.0.1:8088/api/search?q=x&limit=2&q=y');
  ok(parsed.ok === true && parsed.origin === 'http://127.0.0.1:8088' && parsed.path === '/api/search');
  ok(parsed.query.q.length === 2 && parsed.query.limit[0] === '2');
  ok(parseSurfaceUrl('file:///x').ok === false);
  ok(parseSurfaceUrl('junk').ok === false);
  ok(parseSurfaceUrl(null).ok === false);
});

test('observedAuthState: header-name presence is the fact, values ignored', () => {
  ok(observedAuthState({ requestHeaders: { Cookie: '***' } }) === 'cookie-header');
  ok(observedAuthState({ requestHeaders: { Authorization: '***' } }) === 'authorization-header');
  ok(observedAuthState({ requestHeaders: { 'X-Other': 'v' } }) === 'no-auth-header-observed');
  ok(observedAuthState({}) === 'no-auth-header-observed');
  ok(observedAuthState(null) === 'no-auth-header-observed');
});

test('DISC-01 extractApiOperations aggregates requests by method+origin+path', () => {
  const events = [
    httpEvent({ seq: 1, method: 'GET', url: 'http://a:1/api/products', requestId: 'r1' }),
    httpEvent({ seq: 2, method: 'GET', url: 'http://a:1/api/products', requestId: 'r1' }),
    httpEvent({ seq: 3, method: 'POST', url: 'http://a:1/api/cart/add', requestId: 'r2' }),
  ];
  const { operations } = extractApiOperations(events);
  ok(operations.length === 2, 'GET and POST on different paths are separate operations');
  const get = operations.find((op) => op.method === 'GET');
  ok(get.requestCount === 2 && get.firstSeq === 1 && get.lastSeq === 2);
  ok(get.evidence === 'observed');
});

test('DISC-04 parameter sources: query names merged; path hints for numeric/uuid tails', () => {
  const events = [
    httpEvent({ url: 'http://a:1/api/search?q=x&limit=2', requestId: 'r1' }),
    httpEvent({ url: 'http://a:1/api/search?q=z&page=1', requestId: 'r2' }),
    httpEvent({ url: 'http://a:1/api/users/123/orders', requestId: 'r3' }),
    httpEvent({ url: 'http://a:1/api/orders/9b1deb4d-3b7d-4bad-9bdd-2b0d7b3dcb6d', requestId: 'r4' }),
  ];
  const { operations } = extractApiOperations(events);
  const search = operations.find((op) => op.path === '/api/search');
  ok(search.params.query.includes('q') && search.params.query.includes('limit') && search.params.query.includes('page'));
  const userOrders = operations.find((op) => op.path === '/api/users/123/orders');
  ok(userOrders.params.pathHints.some((hint) => hint.includes('/api/users/{users-id}')), 'numeric segment hinted mid-path');
  const orderDetail = operations.find((op) => op.path.startsWith('/api/orders/'));
  ok(orderDetail.params.pathHints.length === 1, 'uuid tail hinted');
});

test('DISC-04 auth observation: cookie header observed marks authenticated; none stays null', () => {
  const events = [
    httpEvent({ url: 'http://a:1/api/me', requestId: 'r1', requestHeaders: { Cookie: '***' } }),
    httpEvent({ url: 'http://a:1/api/products', requestId: 'r2' }),
  ];
  const { operations } = extractApiOperations(events);
  const me = operations.find((op) => op.path === '/api/me');
  ok(me.authObserved === 'cookie-header');
  const products = operations.find((op) => op.path === '/api/products');
  ok(products.authObserved === null, 'no header observed = null, never guessed');
});

test('originFilter keeps only the authorized origin (INF-01 surface view)', () => {
  const events = [
    httpEvent({ url: 'http://a:1/api/x', requestId: 'r1' }),
    httpEvent({ url: 'http://b:2/api/y', requestId: 'r2' }),
  ];
  const { operations } = extractApiOperations(events, { originFilter: 'http://a:1' });
  ok(operations.length === 1 && operations[0].origin === 'http://a:1');
});

test('DISC-02 extractPageRoutes: only Document requests, aggregated by path', () => {
  const events = [
    httpEvent({ resourceType: 'Document', url: 'http://a:1/', requestId: 'd1', seq: 1 }),
    httpEvent({ resourceType: 'Document', url: 'http://a:1/index.html', requestId: 'd2', seq: 2 }),
    httpEvent({ resourceType: 'XHR', url: 'http://a:1/api/x', requestId: 'd3', seq: 3 }),
  ];
  const { routes } = extractPageRoutes(events);
  ok(routes.length === 2, 'two distinct document paths');
  ok(routes.every((route) => route.evidence === 'observed'));
});

test('DISC-03 normalizeFormFact: shape enforced, junk refused, evidence inferred', () => {
  const fact = normalizeFormFact({ action: '/api/login', method: 'POST', fields: [{ name: 'username', type: 'text' }, { name: 'password', type: 'password' }], submitText: 'Sign in' });
  ok(fact.evidence === 'inferred' && fact.method === 'POST' && fact.fields.length === 2);
  ok(normalizeFormFact(null) === null);
  ok(normalizeFormFact({ method: 'CONNECT' }) === null);
  ok(normalizeFormFact({ action: '/x', fields: 'no' }).fields.length === 0, 'missing fields tolerated as empty');
});

test('buildSurfaceInventory: counts consistent; truncation flags propagate', () => {
  const events = [httpEvent({ url: 'http://a:1/api/x', requestId: 'r1' })];
  const inventory = buildSurfaceInventory({
    events, forms: [{ action: '/api/login', method: 'POST', fields: [] }],
    origin: 'http://a:1', unverifiedPaths: ['/api/secret-from-js'],
    documentUrl: 'http://a:1/', documentTitle: 't',
  });
  ok(inventory.kind === 'dsh-ui-testing-surface-inventory' && inventory.version === 1);
  ok(inventory.counts.apiOperations === 1 && inventory.counts.forms === 1 && inventory.counts.unverifiedPaths === 1);
  ok(inventory.unverifiedPaths[0].evidence === 'unverified');
});

test('DISC-07 checkEvidenceLevels: correct levels pass; wrong levels are violations', () => {
  const inventory = buildSurfaceInventory({
    events: [httpEvent({ url: 'http://a:1/api/x', requestId: 'r1' })],
    forms: [{ action: '/api/login', method: 'POST', fields: [] }],
    origin: 'http://a:1', unverifiedPaths: ['/guess'],
  });
  const clean = checkEvidenceLevels(inventory);
  ok(clean.ok === true && clean.violations.length === 0, 'well-formed inventory passes');
  // Tamper: an API operation must never be 'unverified'
  const tampered = { ...inventory, apiOperations: [{ ...inventory.apiOperations[0], evidence: 'unverified' }] };
  const check = checkEvidenceLevels(tampered);
  ok(check.ok === false && check.violations[0].where === 'apiOperations');
});

test('budget: operations capped at SURFACE_LIMITS.maxOperations with truncated flag', () => {
  const events = [];
  for (let i = 0; i < SURFACE_LIMITS.maxOperations + 10; i += 1) {
    events.push(httpEvent({ url: 'http://a:1/api/op' + i, requestId: 'r' + i, seq: i + 1 }));
  }
  const { operations, truncated } = extractApiOperations(events);
  ok(operations.length === SURFACE_LIMITS.maxOperations, 'capped');
  ok(truncated === true, 'truncation honestly reported');
});

/* -----------------------------------------------------------------------------------------------
 * 认证观测：请求头来自独立的 header store（不是事件对象）
 * ---------------------------------------------------------------------------------------------- */

test('DISC-04 readHeaders callback supplies observed auth state per request', () => {
  const events = [
    httpEvent({ url: 'http://a:1/api/me', requestId: 'r1', seq: 1 }),
    httpEvent({ url: 'http://a:1/api/products', requestId: 'r2', seq: 2 }),
  ];
  const headerStore = {
    r1: { headers: { Cookie: '***', 'Content-Type': 'application/json' } },
    r2: { headers: { 'Content-Type': 'application/json' } },
  };
  const { operations } = extractApiOperations(events, {
    readHeaders: (requestId) => headerStore[requestId] ?? { headers: {} },
  });
  const me = operations.find((op) => op.path === '/api/me');
  const products = operations.find((op) => op.path === '/api/products');
  ok(me.authObserved === 'cookie-header', 'cookie header observed from the header store');
  ok(products.authObserved === null, 'no auth header = null, never guessed');
});

test('DISC-04 a throwing readHeaders must not fabricate auth state', () => {
  const events = [httpEvent({ url: 'http://a:1/api/x', requestId: 'r1' })];
  const { operations } = extractApiOperations(events, {
    readHeaders: () => { throw new Error('store unavailable'); },
  });
  ok(operations[0].authObserved === null, 'header store failure = not observed');
});

/* -----------------------------------------------------------------------------------------------
 * DISC-06：WS/SSE 能力声明与实测一致性
 * ---------------------------------------------------------------------------------------------- */

import { transportObservation } from '../attack-surface.js';

test('DISC-06 transportObservation separates declared from observed', () => {
  const declared = transportObservation({ events: [], collectorDeclared: { websocket: true, sse: true } });
  ok(declared.websocket.status === 'declared-not-observed', 'declared but not observed is its own status');
  ok(declared.sse.status === 'declared-not-observed');
  const observed = transportObservation({
    events: [{ kind: 'ws', ws: { direction: 'sent' } }, { kind: 'ws', ws: { direction: 'received' } }],
    collectorDeclared: { websocket: true, sse: true },
  });
  ok(observed.websocket.status === 'observed' && observed.websocket.frames === 2);
  ok(observed.websocket.observedEvents === 2);
  const unsupported = transportObservation({ events: [], collectorDeclared: { websocket: false, sse: false } });
  ok(unsupported.websocket.status === 'unsupported', 'declared false = unsupported, not "not observed"');
});

test('DISC-06 inventory carries the transport block', () => {
  const inventory = buildSurfaceInventory({
    events: [httpEvent({ url: 'http://a:1/api/x', requestId: 'r1' })],
    collectorDeclared: { websocket: true, sse: false },
  });
  ok(inventory.transports !== undefined, 'inventory reports transports');
  ok(inventory.transports.websocket.declared === true && inventory.transports.websocket.status === 'declared-not-observed');
  ok(inventory.transports.sse.declared === false && inventory.transports.sse.status === 'unsupported');
  ok(String(inventory.transports.note).includes('未观测'), 'the note explains the difference honestly');
});

/* -----------------------------------------------------------------------------------------------
 * DISC-04：参数来源（query / body-json / body-form / header / path）
 * ---------------------------------------------------------------------------------------------- */

test('DISC-04 body parameters are modeled as NAMES only, never values', () => {
  const inventory = buildSurfaceInventory({
    events: [httpEvent({
      method: 'POST', url: 'http://a:1/api/login', requestId: 'r1',
      requestBody: JSON.stringify({ username: 'alice', password: 'super-secret-value', nested: { token: 't0k3n' } }),
    })],
  });
  const op = inventory.apiOperations.find((entry) => entry.path === '/api/login');
  ok(op.params.body.includes('username') && op.params.body.includes('password'), 'field names are modeled');
  ok(op.params.body.includes('nested.token'), 'one level of nesting is flattened');
  ok(op.params.bodySources.includes('body-json'));
  const serialized = JSON.stringify(op);
  ok(!serialized.includes('super-secret-value'), 'a body VALUE must never reach the inventory');
  ok(!serialized.includes('t0k3n'), 'a nested body value must never reach the inventory');
});

test('DISC-04 form-encoded bodies are a distinct source', () => {
  const inventory = buildSurfaceInventory({
    events: [httpEvent({ method: 'POST', url: 'http://a:1/api/form', requestId: 'r2', requestBody: 'a=1&b=two' })],
  });
  const op = inventory.apiOperations.find((entry) => entry.path === '/api/form');
  ok(op.params.body.includes('a') && op.params.body.includes('b'));
  ok(op.params.bodySources.includes('body-form'));
  ok(!JSON.stringify(op).includes('two'), 'form values are not copied either');
});

test('DISC-04 header names are modeled; auth state stays a separate observation', () => {
  const inventory = buildSurfaceInventory({
    events: [httpEvent({
      method: 'GET', url: 'http://a:1/api/me', requestId: 'r3',
      requestHeaders: { Cookie: 'sid=abc', 'X-Lab-Proof': 'sig' },
    })],
  });
  const op = inventory.apiOperations.find((entry) => entry.path === '/api/me');
  ok(op.params.header.includes('cookie') && op.params.header.includes('x-lab-proof'), 'header names lowercased');
  ok(!JSON.stringify(op).includes('sid=abc'), 'header values never copied');
  ok(op.authObserved === 'cookie-header', 'auth state is still observed separately');
});

test('DISC-04 an unparsable body yields no fabricated fields', () => {
  const inventory = buildSurfaceInventory({
    events: [httpEvent({ method: 'POST', url: 'http://a:1/api/raw', requestId: 'r4', requestBody: '<<<not json or form>>>' })],
  });
  const op = inventory.apiOperations.find((entry) => entry.path === '/api/raw');
  ok(op.params.body.length === 0, 'garbage body produces no parameter names');
  ok(op.params.bodySources.length === 0, 'and no source claim');
});
