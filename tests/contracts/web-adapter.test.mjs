/**
 * Contract tests for the web adapter boundary (targets/web/*).
 *
 * Everything here runs without a browser: the target adapter receives a fake runtime registry and
 * the capability adapter / P0 provider receive fake dispatch functions. The tests therefore prove
 * the *contract* (identity, evidence, readiness axes, execution classes, error codes, boundary
 * direction), not that Chromium works.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import process from 'node:process';

import {
  WEB_CAPABILITIES,
  WEB_EXECUTION_CLASSES,
  WEB_TOOL_OPERATION_NAMES,
  WEB_TOOL_OPERATION_SPECS,
  WEB_TOOL_OPERATIONS,
  createWebCapabilityAdapter,
  createWebTargetAdapter,
  resolveExecutionClass,
} from '../../targets/web/adapter.js';
import {
  WEB_P0_CAPABILITIES,
  WEB_P0_METHODS,
  createWebP0Provider,
} from '../../targets/web/provider.js';
import { AdapterRegistry, EVIDENCE_REQUIRED_FIELDS } from '../../core/index.js';
import { P0_EVIDENCE_FIELDS } from '../../core/p0.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(HERE, '..', '..');
const WEB_DIR = join(REPO_ROOT, 'targets', 'web');
const CORE_DIR = join(REPO_ROOT, 'core');

// ---------------------------------------------------------------------------
// Fixtures (no browser, no user config)
// ---------------------------------------------------------------------------

function scope(id = 's1', extra = {}) {
  return { id, kind: 'agent', workspaceId: 'w1', cwd: '/tmp/ws', ...extra };
}

function snapshot(overrides = {}) {
  return {
    revision: 7,
    enabledEnvironments: ['web'],
    capabilities: [...WEB_CAPABILITIES],
    ...overrides,
  };
}

function entry({
  tabId = 'tab-1',
  url = 'https://example.test/',
  scopeId = 's1',
  createdAt = 1,
  group = 'g1',
  label = 'Example',
  lifecycle = 'live',
  runtime = null,
} = {}) {
  return {
    tabId,
    scope: { id: scopeId, group },
    // `runtime` lets a test describe a live transport (A13 connection axis) instead of only a
    // registered page: the probe reads the real attached session, not the tab record.
    runtime: runtime ? { url, createdAt, ...runtime } : { url, createdAt },
    createdAt,
    label,
    lifecycle,
  };
}

function fakeRegistry({ entries = [], host = null, spies = null } = {}) {
  const registry = { entries, host };
  if (spies) Object.assign(registry, spies);
  return registry;
}

function missingChromePath() {
  return join(REPO_ROOT, 'definitely-not-a-chrome-binary');
}

function assertAdapterError(error, code) {
  assert.equal(error?.name, 'AdapterError');
  assert.equal(error?.code, code);
  return true;
}

function abortSignal() {
  const controller = new AbortController();
  controller.abort();
  return controller.signal;
}

// ---------------------------------------------------------------------------
// 1. Manifests: three adapter classes, legal shapes
// ---------------------------------------------------------------------------

test('target adapter manifest is a legal v1 target manifest', () => {
  const adapter = createWebTargetAdapter({ registry: fakeRegistry() });
  const { manifest } = adapter;
  assert.equal(manifest.contractVersion, 1);
  assert.equal(manifest.id, 'web');
  assert.equal(manifest.class, 'target');
  assert.equal(manifest.environment, 'web');
  assert.equal(manifest.displayName, 'Web / Chromium');
  assert.equal(manifest.visibility, 'user');
  assert.deepEqual(manifest.capabilities, WEB_CAPABILITIES);
  assert.deepEqual(manifest.dependencies, [
    { id: 'chromium', kind: 'executable', required: true, version: null },
  ]);
  assert.equal(typeof adapter.probe, 'function');
  assert.equal(typeof adapter.createSession, 'function');
  assert.equal(typeof adapter.dispose, 'function');
});

test('capability adapter manifest declares 37 operation specs (name/capability/executionClass)', () => {
  const adapter = createWebCapabilityAdapter({ dispatch: () => ({}) });
  const { manifest } = adapter;
  assert.equal(manifest.contractVersion, 1);
  assert.equal(manifest.id, 'web.capability');
  assert.equal(manifest.class, 'capability');
  assert.equal(manifest.environment, 'web');
  assert.deepEqual(manifest.capabilities, WEB_CAPABILITIES);

  assert.ok(Array.isArray(manifest.operations));
  assert.equal(manifest.operations.length, 37);
  const knownClasses = new Set(Object.values(WEB_EXECUTION_CLASSES));
  const declaredClasses = new Set();
  for (const operation of manifest.operations) {
    assert.equal(typeof operation.name, 'string');
    assert.equal(WEB_TOOL_OPERATIONS[operation.name], operation.capability, `${operation.name} capability`);
    assert.ok(knownClasses.has(operation.executionClass), `${operation.name} executionClass`);
    assert.ok(WEB_CAPABILITIES.includes(operation.capability), `${operation.name} capability declared`);
    if (operation.executionClasses !== undefined) {
      assert.ok(Array.isArray(operation.executionClasses));
      assert.ok(operation.executionClasses.length > 1, `${operation.name} multi-class list is meaningful`);
      assert.ok(operation.executionClasses.includes(operation.executionClass));
      for (const value of operation.executionClasses) assert.ok(knownClasses.has(value));
    }
    declaredClasses.add(operation.executionClass);
  }
  assert.deepEqual(
    manifest.operations.map((operation) => operation.name),
    WEB_TOOL_OPERATION_NAMES,
  );
  assert.deepEqual(
    [...declaredClasses].sort(),
    ['diagnostic', 'hostOnly', 'independentHttp', 'networkRead', 'page', 'readOnly', 'tabs'],
    'every execution class is used by at least one operation',
  );
});

test('p0 provider manifest is a legal v1 p0 manifest', () => {
  const provider = createWebP0Provider({ p0Dispatch: () => ({}) });
  const { manifest } = provider;
  assert.equal(manifest.contractVersion, 1);
  assert.equal(manifest.id, 'web.p0');
  assert.equal(manifest.class, 'p0');
  assert.equal(manifest.environment, 'web');
  assert.deepEqual(manifest.families, ['A', 'B', 'C', 'D', 'E']);
  assert.deepEqual(manifest.capabilities, WEB_P0_CAPABILITIES);
  assert.deepEqual(WEB_P0_CAPABILITIES, [
    'web.p0.capture',
    'web.p0.network',
    'web.p0.display',
    'web.p0.canvas',
    'web.p0.targets',
  ]);
});

test('operation inventory matches the shipped capability grouping (T1/P0-D/P0-E/T2/T3/network/T4)', () => {
  const counts = {};
  for (const capability of Object.values(WEB_TOOL_OPERATIONS)) {
    counts[capability] = (counts[capability] ?? 0) + 1;
  }
  assert.deepEqual(counts, {
    'web.t1': 10,
    'web.tabs': 1,
    'web.p0.annotations': 1,
    'web.t2': 7,
    'web.t3': 6,
    'web.network': 7,
    'web.t4': 5,
  });
  assert.equal(WEB_TOOL_OPERATION_NAMES.length, 37);
  assert.equal(WEB_TOOL_OPERATION_SPECS.length, 37);
});

test('resolveExecutionClass applies the declared action-level refinements', () => {
  assert.equal(resolveExecutionClass('browser_navigate', {}), 'page');
  assert.equal(resolveExecutionClass('browser_http_request', {}), 'independentHttp');
  assert.equal(resolveExecutionClass('browser_tabs', {}), 'tabs');
  assert.equal(resolveExecutionClass('browser_viewport', { action: 'get' }), 'readOnly');
  assert.equal(resolveExecutionClass('browser_viewport', { action: 'set' }), 'page');
  // P0-D annotations: `read` is a cached host read, the three mutating actions are host-only.
  assert.equal(resolveExecutionClass('browser_annotation', { action: 'read' }), 'readOnly');
  assert.equal(resolveExecutionClass('browser_annotation', { action: 'draw' }), 'hostOnly');
  assert.equal(resolveExecutionClass('browser_annotation', { action: 'erase' }), 'hostOnly');
  assert.equal(resolveExecutionClass('browser_annotation', { action: 'clear' }), 'hostOnly');
  assert.equal(resolveExecutionClass('browser_network_session', { action: 'status' }), 'readOnly');
  assert.equal(resolveExecutionClass('browser_network_session', { action: 'start' }), 'hostOnly');
  assert.equal(resolveExecutionClass('browser_dynamic_session', { action: 'status' }), 'hostOnly');
  assert.equal(resolveExecutionClass('browser_dynamic_session', { action: 'reset' }), 'hostOnly');
  assert.equal(resolveExecutionClass('browser_dynamic_session', { action: 'start' }), 'page');
  assert.equal(resolveExecutionClass('browser_motion_observe', {}), 'page');
  assert.equal(resolveExecutionClass('browser_dynamic_correlate', {}), 'readOnly');
  assert.equal(resolveExecutionClass('browser_not_a_tool', {}), null);
});

// ---------------------------------------------------------------------------
// 2. probe(): six independent axes, never launches Chromium
// ---------------------------------------------------------------------------

test('probe reports dependency failed + version null when Chromium is missing', async () => {
  const adapter = createWebTargetAdapter({
    registry: fakeRegistry(),
    chromePath: missingChromePath(),
    now: () => 1234567890,
  });
  const report = await adapter.probe({ scope: scope(), snapshot: snapshot() });

  assert.equal(report.environment, 'web');
  assert.equal(report.checkedAt, 1234567890);
  assert.equal(report.configRevision, 7);
  assert.equal(report.axes.dependency.status, 'failed');
  assert.equal(report.axes.dependency.reason, 'executable-missing');
  assert.equal(report.axes.dependency.evidence.version, null);
  assert.equal(report.axes.dependency.evidence.id, 'chromium');
  assert.equal(JSON.stringify(report).includes('Chrome/'), false, 'no fabricated version string');
});

test('probe reports dependency ok when the configured executable exists (version still null)', async () => {
  // process.execPath is guaranteed to exist on the test machine; it stands in for a Chrome binary.
  const adapter = createWebTargetAdapter({
    registry: fakeRegistry(),
    chromePath: process.execPath,
  });
  const report = await adapter.probe({ scope: scope(), snapshot: snapshot() });
  assert.equal(report.axes.dependency.status, 'ok');
  assert.equal(report.axes.dependency.reason, null);
  assert.equal(report.axes.dependency.evidence.version, null);
});

test('probe enabled axis follows snapshot.enabledEnvironments', async () => {
  const enabled = createWebTargetAdapter({
    registry: fakeRegistry(),
    chromePath: process.execPath,
  });
  const enabledReport = await enabled.probe({
    scope: scope(),
    snapshot: snapshot({ enabledEnvironments: ['web', 'fake'] }),
  });
  assert.equal(enabledReport.axes.enabled.status, 'ok');
  assert.equal(enabledReport.axes.enabled.reason, null);

  const disabledReport = await enabled.probe({
    scope: scope(),
    snapshot: snapshot({ enabledEnvironments: ['fake'] }),
  });
  assert.equal(disabledReport.axes.enabled.status, 'disabled');
  assert.equal(disabledReport.axes.enabled.reason, 'environment-disabled');
});

test('probe connection axis distinguishes cold, idle host and an attached transport (A13)', async () => {
  const adapter = createWebTargetAdapter({ registry: fakeRegistry(), chromePath: process.execPath });
  const cold = await adapter.probe({ scope: scope(), snapshot: snapshot() });
  assert.equal(cold.axes.connection.status, 'not-probed');
  assert.equal(cold.axes.connection.reason, 'cold');

  // A host process with no attached page session is *not* a connection: the axis stays
  // not-probed, but with a reason that says why instead of claiming "running".
  const running = createWebTargetAdapter({
    registry: fakeRegistry({ host: { id: 'host-1' } }),
    chromePath: process.execPath,
  });
  const runningReport = await running.probe({ scope: scope(), snapshot: snapshot() });
  assert.equal(runningReport.axes.connection.status, 'not-probed');
  assert.equal(runningReport.axes.connection.reason, 'host-idle-no-transport');

  // An attached CDP session is a real connection: `ok` with transport evidence.
  const attached = createWebTargetAdapter({
    registry: fakeRegistry({
      host: { id: 'host-1' },
      entries: [entry({ tabId: 'tab-1', createdAt: 1, runtime: { cdp: { closed: false }, transport: 'ws', runtimeId: 'rt-1', url: 'https://a.test/' } })],
    }),
    chromePath: process.execPath,
  });
  const attachedReport = await attached.probe({ scope: scope('s1'), snapshot: snapshot() });
  assert.equal(attachedReport.axes.connection.status, 'ok');
  assert.equal(attachedReport.axes.connection.evidence.kind, 'transport');
  assert.equal(attachedReport.axes.connection.evidence.transport, 'ws');
});

test('probe target axis reports a wrong configured identity as stale, not bound (A13)', async () => {
  const adapter = createWebTargetAdapter({
    registry: fakeRegistry({
      entries: [entry({ tabId: 'tab-real', createdAt: 1, runtime: { cdp: { closed: false }, runtimeId: 'rt-1', url: 'https://a.test/' } })],
    }),
    chromePath: process.execPath,
  });
  const report = await adapter.probe({ scope: scope('s1'), snapshot: snapshot({ targetId: 'tab-configured-other' }) });
  assert.equal(report.axes.target.status, 'stale');
  assert.equal(report.axes.target.reason, 'identity-mismatch');
  assert.equal(report.axes.target.evidence.expectedTargetId, 'tab-configured-other');
  assert.equal(report.axes.target.evidence.actualTargetId, 'tab-real');
});

test('probe capability axis keeps the per-capability matrix as evidence (A13)', async () => {
  const adapter = createWebTargetAdapter({
    registry: fakeRegistry({ entries: [entry({ tabId: 'tab-1', createdAt: 1 })] }),
    chromePath: process.execPath,
    capabilityAvailability: () => ({
      status: 'partial',
      reason: 'network, frames',
      checkedAt: 1234,
      evidence: { kind: 'capability-matrix', checks: { structure: { status: 'ok' } } },
    }),
  });
  const report = await adapter.probe({ scope: scope('s1'), snapshot: snapshot() });
  assert.equal(report.axes.capability.status, 'partial');
  assert.equal(report.axes.capability.reason, 'network, frames');
  assert.equal(report.axes.capability.evidence.kind, 'capability-matrix');
});

test('probe target axis is bound only when the registry has a URL for this scope', async () => {
  const adapter = createWebTargetAdapter({
    registry: fakeRegistry({ entries: [entry({ tabId: 'tab-9', createdAt: 5 })] }),
    chromePath: process.execPath,
  });
  const bound = await adapter.probe({ scope: scope('s1'), snapshot: snapshot() });
  assert.equal(bound.axes.target.status, 'bound');
  assert.equal(bound.axes.target.target.targetId, 'tab-9');
  assert.equal(typeof bound.axes.target.target.generation, 'number');

  const unbound = await adapter.probe({ scope: scope('other'), snapshot: snapshot() });
  assert.equal(unbound.axes.target.status, 'unbound');
  assert.equal(unbound.axes.target.reason, 'no-target');

  const noUrl = createWebTargetAdapter({
    registry: fakeRegistry({ entries: [{ tabId: 'tab-1', scope: { id: 's1' } }] }),
    chromePath: process.execPath,
  });
  const noUrlReport = await noUrl.probe({ scope: scope('s1'), snapshot: snapshot() });
  assert.equal(noUrlReport.axes.target.status, 'unbound');
});

test('probe capability axis defaults to not-probed and honours an injected probe', async () => {
  const adapter = createWebTargetAdapter({ registry: fakeRegistry(), chromePath: process.execPath });
  const defaultReport = await adapter.probe({ scope: scope(), snapshot: snapshot() });
  assert.equal(defaultReport.axes.capability.status, 'not-probed');

  let seen = null;
  const probed = createWebTargetAdapter({
    registry: fakeRegistry(),
    chromePath: process.execPath,
    capabilityAvailability: (input) => {
      seen = input;
      return { status: 'available' };
    },
  });
  const probedReport = await probed.probe({ scope: scope('s2'), snapshot: snapshot() });
  assert.equal(probedReport.axes.capability.status, 'available');
  assert.equal(seen.scope.id, 's2');
  assert.equal(seen.snapshot.revision, 7);
});

test('probe never launches or connects to a browser (registry launch spies untouched)', async () => {
  const launchCalls = [];
  const spies = {
    start: (...args) => launchCalls.push(['start', args]),
    launch: (...args) => launchCalls.push(['launch', args]),
    ensure: (...args) => launchCalls.push(['ensure', args]),
    connect: (...args) => launchCalls.push(['connect', args]),
    ensurePage: (...args) => launchCalls.push(['ensurePage', args]),
  };
  const adapter = createWebTargetAdapter({
    registry: fakeRegistry({ entries: [entry()], spies }),
    chromePath: process.execPath,
  });
  await adapter.probe({ scope: scope(), snapshot: snapshot() });
  assert.deepEqual(launchCalls, []);
});

// ---------------------------------------------------------------------------
// 3. TargetSession: list / bind / close / generation / signals / dispose
// ---------------------------------------------------------------------------

test('createSession returns a stable web session identity', async () => {
  const adapter = createWebTargetAdapter({ registry: fakeRegistry(), chromePath: process.execPath });
  const session = await adapter.createSession({ scope: scope('s1'), snapshot: snapshot({ revision: 11 }) });
  assert.equal(session.sessionId, 'web:s1');
  assert.equal(session.environment, 'web');
  assert.equal(session.generation, 1);
  assert.equal(session.configRevision, 11);
  assert.equal(session.target, null);
  assert.equal(session.closed, false);
});

test('createSession rejects a scope without an id and honours an aborted signal', async () => {
  const adapter = createWebTargetAdapter({ registry: fakeRegistry() });
  await assert.rejects(
    () => adapter.createSession({ scope: {}, snapshot: snapshot() }),
    (error) => assertAdapterError(error, 'INVALID_ARGUMENT'),
  );
  await assert.rejects(
    () => adapter.createSession({ scope: scope(), snapshot: snapshot(), signal: abortSignal() }),
    (error) => assertAdapterError(error, 'INTERNAL'),
  );
});

test('listTargets exposes page identities for the session scope only, with stable generations', async () => {
  const registry = fakeRegistry({
    entries: [
      entry({ tabId: 'tab-1', createdAt: 10 }),
      entry({ tabId: 'tab-2', createdAt: 20 }),
      entry({ tabId: 'tab-other', scopeId: 'other', createdAt: 1 }),
    ],
  });
  const adapter = createWebTargetAdapter({ registry, chromePath: process.execPath });
  const session = await adapter.createSession({ scope: scope('s1'), snapshot: snapshot() });

  const first = await session.listTargets({ signal: new AbortController().signal });
  assert.deepEqual(first.map((identity) => identity.targetId), ['tab-1', 'tab-2']);
  for (const identity of first) {
    assert.equal(identity.environment, 'web');
    assert.equal(identity.kind, 'page');
    assert.equal(typeof identity.generation, 'number');
    assert.equal(identity.lifecycle, 'live');
  }

  // Insert an entry that sorts before the existing ones: cached generations must not shift.
  registry.entries.unshift(entry({ tabId: 'tab-0', createdAt: 0 }));
  const second = await session.listTargets();
  const generationOf = (list, targetId) => list.find((identity) => identity.targetId === targetId)?.generation;
  assert.equal(generationOf(second, 'tab-1'), generationOf(first, 'tab-1'));
  assert.equal(generationOf(second, 'tab-2'), generationOf(first, 'tab-2'));
  assert.notEqual(generationOf(second, 'tab-0'), undefined);
});

test('bind validates the target, bumps the session generation, and records the identity', async () => {
  const adapter = createWebTargetAdapter({
    registry: fakeRegistry({ entries: [entry({ tabId: 'tab-1' })] }),
    chromePath: process.execPath,
  });
  const session = await adapter.createSession({ scope: scope('s1'), snapshot: snapshot() });
  const identity = await session.bind('tab-1', { signal: new AbortController().signal });
  assert.equal(identity.targetId, 'tab-1');
  assert.equal(session.generation, 2);
  assert.equal(session.target.targetId, 'tab-1');

  await assert.rejects(
    () => session.bind('tab-missing'),
    (error) => assertAdapterError(error, 'TARGET_NOT_BOUND'),
  );
  assert.equal(session.generation, 2, 'a failed bind does not bump the generation');
});

test('close marks the session gone: bind and listTargets raise TARGET_GONE', async () => {
  const adapter = createWebTargetAdapter({
    registry: fakeRegistry({ entries: [entry()] }),
    chromePath: process.execPath,
  });
  const session = await adapter.createSession({ scope: scope('s1'), snapshot: snapshot() });
  await session.bind('tab-1');
  await session.close();
  await session.close(); // idempotent
  assert.equal(session.closed, true);
  await assert.rejects(
    () => session.listTargets(),
    (error) => assertAdapterError(error, 'TARGET_GONE'),
  );
  await assert.rejects(
    () => session.bind('tab-1'),
    (error) => assertAdapterError(error, 'TARGET_GONE'),
  );
});

test('session dispose is idempotent and never closes the shared registry', async () => {
  const closed = [];
  const registry = fakeRegistry({
    entries: [entry()],
    spies: {
      dispose: () => closed.push('registry.dispose'),
      close: () => closed.push('registry.close'),
    },
  });
  const adapter = createWebTargetAdapter({ registry, chromePath: process.execPath });
  const session = await adapter.createSession({ scope: scope('s1'), snapshot: snapshot() });
  await session.dispose();
  await session.dispose();
  assert.equal(session.closed, true);
  assert.deepEqual(closed, []);
});

test('adapter dispose closes its sessions, is idempotent, and leaves the registry alive', async () => {
  const closed = [];
  const registry = fakeRegistry({
    entries: [entry()],
    spies: {
      dispose: () => closed.push('registry.dispose'),
      close: () => closed.push('registry.close'),
    },
  });
  const adapter = createWebTargetAdapter({ registry, chromePath: process.execPath });
  const session = await adapter.createSession({ scope: scope('s1'), snapshot: snapshot() });
  await adapter.dispose();
  await adapter.dispose();
  assert.deepEqual(closed, []);
  await assert.rejects(
    () => session.listTargets(),
    (error) => assertAdapterError(error, 'TARGET_GONE'),
  );
  await assert.rejects(
    () => adapter.createSession({ scope: scope('s2'), snapshot: snapshot() }),
    (error) => assertAdapterError(error, 'ADAPTER_DISABLED'),
  );
});

// ---------------------------------------------------------------------------
// 4. CapabilityAdapter: operationStatus + invoke + evidence
// ---------------------------------------------------------------------------

async function capabilityFixture({
  bound = true,
  closed = false,
  capabilities = [...WEB_CAPABILITIES],
  revision = 7,
} = {}) {
  const adapter = createWebTargetAdapter({
    registry: fakeRegistry({ entries: [entry({ tabId: 'tab-1' })] }),
    chromePath: process.execPath,
  });
  const snap = snapshot({ capabilities, revision });
  const session = await adapter.createSession({ scope: scope('s1'), snapshot: snap });
  if (bound) await session.bind('tab-1');
  if (closed) await session.close();
  return { session, snapshot: snap };
}

const TARGET_BOUND_EXECUTION_CLASSES = new Set(['page', 'tabs']);

function assertTargetFreeMatrix(matrix, expectedAvailability) {
  assert.equal(Object.keys(matrix).length, 37);
  for (const spec of WEB_TOOL_OPERATION_SPECS) {
    const value = matrix[spec.name];
    assert.equal(value.support, 'supported', spec.name);
    if (TARGET_BOUND_EXECUTION_CLASSES.has(spec.executionClass)) {
      assert.equal(value.availability, 'not-probed', spec.name);
      assert.equal(value.reason, 'target-unbound', spec.name);
    } else {
      assert.equal(value.availability, expectedAvailability, spec.name);
      assert.equal(value.reason, expectedAvailability === 'available' ? null : value.reason, spec.name);
    }
  }
}

test('operationStatus: page/tabs operations are not-probed without a bound target, host-level ones are not', async () => {
  const { session, snapshot: snap } = await capabilityFixture({ bound: false });
  const adapter = createWebCapabilityAdapter({ dispatch: () => ({}) });
  const matrix = adapter.operationStatus({ session, snapshot: snap });
  assertTargetFreeMatrix(matrix, 'available');
  // Spot checks for the A06 regression surface: these must not look "blocked by a missing page".
  for (const operation of [
    'browser_http_request',
    'browser_network_events',
    'browser_network_detail',
    'browser_network_trace',
    'browser_network_evidence',
    'browser_network_subscribe',
    'browser_network_session',
    'browser_viewport',
    'browser_state',
    'browser_capabilities',
    'browser_dynamic_correlate',
  ]) {
    assert.equal(matrix[operation].availability, 'available', operation);
  }
  assert.equal(matrix.browser_navigate.availability, 'not-probed');
});

test('operationStatus reports not-probed when there is no session at all (config-level view)', () => {
  const adapter = createWebCapabilityAdapter({ dispatch: () => ({}) });
  const matrix = adapter.operationStatus({ session: null, snapshot: snapshot() });
  assertTargetFreeMatrix(matrix, 'available');
  assert.equal(matrix.browser_navigate.availability, 'not-probed');
  assert.equal(matrix.browser_navigate.reason, 'target-unbound');
});

test('operationStatus reports target-gone for a closed session', async () => {
  const { session, snapshot: snap } = await capabilityFixture({ closed: true });
  const adapter = createWebCapabilityAdapter({ dispatch: () => ({}) });
  const matrix = adapter.operationStatus({ session, snapshot: snap });
  assert.equal(matrix.browser_navigate.availability, 'unavailable');
  assert.equal(matrix.browser_navigate.reason, 'target-gone');
});

test('operationStatus reports available per operation and disabled per missing capability', async () => {
  const { session, snapshot: snap } = await capabilityFixture();
  const adapter = createWebCapabilityAdapter({ dispatch: () => ({}) });
  const full = adapter.operationStatus({ session, snapshot: snap });
  assert.equal(full.browser_navigate.availability, 'available');
  assert.equal(full.browser_vision_image.availability, 'available');

  const narrowSnapshot = snapshot({ capabilities: ['web.t1'] });
  const narrow = adapter.operationStatus({ session, snapshot: narrowSnapshot });
  assert.equal(narrow.browser_navigate.availability, 'available');
  assert.equal(narrow.browser_snapshot.availability, 'unavailable');
  assert.equal(narrow.browser_snapshot.reason, 'capability-disabled');
});

test('invoke forwards operation, args, executionClass and returns value + complete evidence', async () => {
  const { session, snapshot: snap } = await capabilityFixture();
  const calls = [];
  const adapter = createWebCapabilityAdapter({
    dispatch: async (input) => {
      calls.push(input);
      return { value: { url: 'https://example.test/' } };
    },
    now: () => 424242,
  });
  const result = await adapter.invoke({
    operation: 'browser_navigate',
    args: { url: 'https://example.test/' },
    session,
    snapshot: snap,
  });

  assert.deepEqual(result.value, { url: 'https://example.test/' });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].operation, 'browser_navigate');
  assert.deepEqual(calls[0].args, { url: 'https://example.test/' });
  assert.equal(calls[0].session, session);
  assert.equal(calls[0].snapshot, snap);
  assert.equal(calls[0].executionClass, 'page', 'the adapter forwards the resolved execution class');

  assert.deepEqual(
    Object.keys(result.evidence).sort(),
    [...EVIDENCE_REQUIRED_FIELDS].sort(),
  );
  assert.equal(result.evidence.version, 1);
  assert.equal(result.evidence.scope, 's1');
  assert.equal(result.evidence.session, 'web:s1');
  assert.equal(result.evidence.target, 'tab-1');
  assert.equal(result.evidence.generation, session.generation);
  assert.equal(result.evidence.configRevision, snap.revision);
  assert.equal(result.evidence.operation, 'browser_navigate');
  assert.equal(result.evidence.source, 'web');
  assert.equal(result.evidence.capturedAt, 424242);
});

test('invoke validates a caller-supplied executionClass against the operation', async () => {
  const { session, snapshot: snap } = await capabilityFixture();
  const seen = [];
  const adapter = createWebCapabilityAdapter({
    dispatch: (input) => {
      seen.push(input.executionClass);
      return { ok: true };
    },
  });

  await adapter.invoke({
    operation: 'browser_viewport',
    args: { action: 'set' },
    session,
    snapshot: snap,
    executionClass: 'page',
  });
  assert.equal(seen[0], 'page');

  await assert.rejects(
    () => adapter.invoke({
      operation: 'browser_navigate',
      args: {},
      session,
      snapshot: snap,
      executionClass: 'hostOnly',
    }),
    (error) => assertAdapterError(error, 'INVALID_ARGUMENT'),
  );
});

test('invoke refuses to run against a stale config snapshot (CONFIG_STALE)', async () => {
  const { session, snapshot: snap } = await capabilityFixture({ revision: 7 });
  let dispatched = false;
  const adapter = createWebCapabilityAdapter({
    dispatch: () => {
      dispatched = true;
      return { ok: true };
    },
  });
  await assert.rejects(
    () => adapter.invoke({
      operation: 'browser_navigate',
      args: {},
      session,
      snapshot: { ...snap, revision: 8 },
    }),
    (error) => {
      assertAdapterError(error, 'CONFIG_STALE');
      assert.equal(error.details.sessionRevision, 7);
      assert.equal(error.details.snapshotRevision, 8);
      return true;
    },
  );
  assert.equal(dispatched, false, 'stale config must not reach the platform');
});

test('invoke passes the optional context through to dispatch without leaking it into evidence', async () => {
  const { session, snapshot: snap } = await capabilityFixture();
  const context = { runtime: { id: 'rt-1' }, meta: { marker: 'CTX_MARKER_9f1' } };
  let received;
  const adapter = createWebCapabilityAdapter({
    dispatch: async (input) => {
      received = input;
      return { ok: true };
    },
  });
  const result = await adapter.invoke({
    operation: 'browser_state',
    args: {},
    session,
    snapshot: snap,
    context,
  });
  assert.equal(received.context, context, 'context is passed by reference, untouched');
  assert.equal(result.value.ok, true);
  assert.equal(JSON.stringify(result.evidence).includes('CTX_MARKER_9f1'), false);
  assert.equal(Object.hasOwn(result.evidence, 'context'), false);
});

test('invoke unwraps a dispatch result that already has a value field', async () => {
  const { session, snapshot: snap } = await capabilityFixture();
  const adapter = createWebCapabilityAdapter({
    dispatch: () => ({ value: 42, internal: 'drop-me' }),
  });
  const result = await adapter.invoke({ operation: 'browser_eval', args: {}, session, snapshot: snap });
  assert.equal(result.value, 42);
});

test('invoke runs target-free operations without a bound target and keeps page tools blocked', async () => {
  const { session, snapshot: snap } = await capabilityFixture({ bound: false });
  const calls = [];
  const adapter = createWebCapabilityAdapter({
    dispatch: (input) => {
      calls.push(input);
      return { status: 200 };
    },
  });

  const http = await adapter.invoke({
    operation: 'browser_http_request',
    args: { url: 'https://example.test/api' },
    session,
    snapshot: snap,
  });
  assert.equal(http.value.status, 200);
  assert.equal(http.evidence.target, null, 'target-free evidence records an unbound target');
  assert.equal(calls[0].executionClass, 'independentHttp');

  const events = await adapter.invoke({ operation: 'browser_network_events', args: {}, session, snapshot: snap });
  assert.equal(events.evidence.target, null);
  assert.equal(calls[1].executionClass, 'networkRead');

  // viewport get is readOnly (no page needed); viewport set is page work and stays blocked.
  const viewportGet = await adapter.invoke({
    operation: 'browser_viewport',
    args: { action: 'get' },
    session,
    snapshot: snap,
  });
  assert.equal(viewportGet.evidence.target, null);
  await assert.rejects(
    () => adapter.invoke({ operation: 'browser_viewport', args: { action: 'set' }, session, snapshot: snap }),
    (error) => assertAdapterError(error, 'TARGET_NOT_BOUND'),
  );

  await assert.rejects(
    () => adapter.invoke({ operation: 'browser_navigate', args: {}, session, snapshot: snap }),
    (error) => assertAdapterError(error, 'TARGET_NOT_BOUND'),
  );
  assert.equal(calls.length, 3, 'blocked calls never reach the platform');
});

test('invoke rejects unknown operations, unbound sessions, closed sessions and disabled capabilities', async () => {
  const adapter = createWebCapabilityAdapter({ dispatch: () => ({}) });

  const bound = await capabilityFixture();
  await assert.rejects(
    () => adapter.invoke({ operation: 'browser_nope', args: {}, session: bound.session, snapshot: bound.snapshot }),
    (error) => assertAdapterError(error, 'CAPABILITY_UNSUPPORTED'),
  );

  const unbound = await capabilityFixture({ bound: false });
  await assert.rejects(
    () => adapter.invoke({ operation: 'browser_navigate', args: {}, session: unbound.session, snapshot: unbound.snapshot }),
    (error) => assertAdapterError(error, 'TARGET_NOT_BOUND'),
  );

  const closed = await capabilityFixture({ closed: true });
  await assert.rejects(
    () => adapter.invoke({ operation: 'browser_navigate', args: {}, session: closed.session, snapshot: closed.snapshot }),
    (error) => assertAdapterError(error, 'TARGET_GONE'),
  );

  const disabled = await capabilityFixture({ capabilities: ['web.t1'] });
  await assert.rejects(
    () => adapter.invoke({ operation: 'browser_snapshot', args: {}, session: disabled.session, snapshot: disabled.snapshot }),
    (error) => assertAdapterError(error, 'ADAPTER_DISABLED'),
  );
});

test('invoke preserves platform-coded failures and wraps only codeless errors', async () => {
  const { session, snapshot: snap } = await capabilityFixture();

  // A platform-typed error (BrowserError and the wider Web taxonomy) is rethrown untouched:
  // wrapping it in AdapterError would normalize NAV_FAILED/BUSY/REF_STALE to INTERNAL and break
  // the stable tool error contract.
  const platform = createWebCapabilityAdapter({
    dispatch: () => {
      const error = new Error('target vanished');
      error.code = 'TARGET_GONE';
      throw error;
    },
  });
  await assert.rejects(
    () => platform.invoke({ operation: 'browser_navigate', args: {}, session, snapshot: snap }),
    (error) => {
      assert.equal(error.name, 'Error');
      assert.equal(error.code, 'TARGET_GONE');
      return true;
    },
  );

  // An error with no machine code is wrapped as AdapterError(INTERNAL) with its message kept.
  const codeless = createWebCapabilityAdapter({
    dispatch: () => {
      throw new Error('cdp exploded');
    },
  });
  await assert.rejects(
    () => codeless.invoke({ operation: 'browser_navigate', args: {}, session, snapshot: snap }),
    (error) => {
      assertAdapterError(error, 'INTERNAL');
      assert.equal(error.message, 'cdp exploded');
      return true;
    },
  );
});

test('invoke raises PROVIDER_UNAVAILABLE when no dispatch was injected', async () => {
  const { session, snapshot: snap } = await capabilityFixture();
  const adapter = createWebCapabilityAdapter({});
  await assert.rejects(
    () => adapter.invoke({ operation: 'browser_navigate', args: {}, session, snapshot: snap }),
    (error) => assertAdapterError(error, 'PROVIDER_UNAVAILABLE'),
  );
});

test('preflight validates argument shape and exposes the routed execution class', () => {
  const adapter = createWebCapabilityAdapter({ dispatch: () => ({}) });
  assert.deepEqual(adapter.preflight({ url: 'https://example.test/' }, 'browser_navigate'), {
    ok: true,
    executionClass: 'page',
  });
  assert.deepEqual(adapter.preflight({ action: 'set' }, { operation: 'browser_viewport' }), {
    ok: true,
    executionClass: 'page',
  });
  assert.deepEqual(adapter.preflight(undefined), { ok: true, executionClass: null });
  for (const bad of ['string', 42, []]) {
    assert.throws(() => adapter.preflight(bad), (error) => assertAdapterError(error, 'INVALID_ARGUMENT'));
  }
});

test('capability adapter dispose is idempotent and blocks later invokes', async () => {
  const { session, snapshot: snap } = await capabilityFixture();
  const adapter = createWebCapabilityAdapter({ dispatch: () => ({ ok: true }) });
  await adapter.dispose();
  await adapter.dispose();
  await assert.rejects(
    () => adapter.invoke({ operation: 'browser_navigate', args: {}, session, snapshot: snap }),
    (error) => assertAdapterError(error, 'ADAPTER_DISABLED'),
  );
});

test('AdapterRegistry resolves the web capability adapter through operationStatus', () => {
  const registry = new AdapterRegistry();
  registry.registerTargetAdapter(createWebTargetAdapter({ registry: fakeRegistry() }));
  registry.registerCapabilityAdapter(createWebCapabilityAdapter({ dispatch: () => ({}) }));
  const rows = registry.capabilitiesFor({
    environment: 'web',
    capabilities: ['web.t1', 'web.network'],
    enabledEnvironments: ['web'],
  });
  assert.equal(rows.length, 2);
  for (const row of rows) {
    assert.equal(row.support, 'supported', row.id);
    // Registry aggregation is per capability id: each web.t1/web.network group contains at least
    // one host-level operation, which stays available without a bound page target.
    assert.equal(row.availability, 'available', row.id);
  }
});

// ---------------------------------------------------------------------------
// 5. P0 provider: families A-E through injected dispatch
// ---------------------------------------------------------------------------

function p0Session(overrides = {}) {
  return {
    sessionId: 'web:s1',
    scopeId: 's1',
    environment: 'web',
    generation: 3,
    configRevision: 7,
    target: { targetId: 'tab-1', generation: 3 },
    closed: false,
    ...overrides,
  };
}

test('p0 familyStatus: unsupported without dispatch, not-probed without a session, disabled by snapshot', () => {
  const noDispatch = createWebP0Provider({});
  const withoutDispatch = noDispatch.familyStatus({ session: p0Session(), snapshot: snapshot() });
  for (const family of ['A', 'B', 'C', 'D', 'E']) {
    assert.equal(withoutDispatch[family].support, 'unsupported', family);
    assert.equal(withoutDispatch[family].availability, 'unavailable', family);
    assert.equal(withoutDispatch[family].reason, 'provider-missing', family);
  }

  const provider = createWebP0Provider({ p0Dispatch: () => ({}) });
  const noSession = provider.familyStatus({ session: null, snapshot: snapshot() });
  assert.equal(noSession.A.support, 'supported');
  assert.equal(noSession.A.availability, 'not-probed');
  assert.equal(noSession.A.reason, 'no-session');

  const closed = provider.familyStatus({ session: p0Session({ closed: true }), snapshot: snapshot() });
  assert.equal(closed.B.availability, 'unavailable');
  assert.equal(closed.B.reason, 'target-gone');

  const narrow = provider.familyStatus({
    session: p0Session(),
    snapshot: snapshot({ capabilities: ['web.p0.capture'] }),
  });
  assert.equal(narrow.A.availability, 'available');
  for (const family of ['B', 'C', 'D', 'E']) {
    assert.equal(narrow[family].availability, 'unavailable', family);
    assert.equal(narrow[family].reason, 'capability-disabled', family);
  }

  const full = provider.familyStatus({ session: p0Session(), snapshot: snapshot() });
  for (const family of ['A', 'B', 'C', 'D', 'E']) {
    assert.equal(full[family].support, 'supported', family);
    assert.equal(full[family].availability, 'available', family);
  }
});

test('p0 familyStatus honours the families a dispatch declares', () => {
  const dispatch = () => ({});
  dispatch.families = ['A', 'B'];
  const provider = createWebP0Provider({ p0Dispatch: dispatch });
  const matrix = provider.familyStatus({ session: p0Session(), snapshot: snapshot() });
  assert.equal(matrix.A.support, 'supported');
  assert.equal(matrix.B.support, 'supported');
  for (const family of ['C', 'D', 'E']) {
    assert.equal(matrix[family].support, 'unsupported', family);
  }
});

test('p0 targets surface exposes list/lease methods only (bind/close belong to the TargetAdapter)', () => {
  const provider = createWebP0Provider({ p0Dispatch: () => ({}) });
  assert.deepEqual(WEB_P0_METHODS.E, ['list', 'leaseAcquire', 'leaseRelease', 'leaseStatus']);
  assert.equal(typeof provider.targets.list, 'function');
  assert.equal(typeof provider.targets.leaseAcquire, 'function');
  assert.equal(typeof provider.targets.leaseRelease, 'function');
  assert.equal(typeof provider.targets.leaseStatus, 'function');
  assert.equal(provider.targets.bind, undefined);
  assert.equal(provider.targets.close, undefined);

  for (const [family, methods] of Object.entries(WEB_P0_METHODS)) {
    const surface = { A: 'capture', B: 'network', C: 'display', D: 'canvas', E: 'targets' }[family];
    for (const method of methods) {
      assert.equal(typeof provider[surface][method], 'function', `${surface}.${method}`);
    }
  }
});

test('p0 unsupported methods raise CAPABILITY_UNSUPPORTED', async () => {
  const partial = createWebP0Provider({ p0Dispatch: { A: { screenshot: () => ({ frameId: 'f1' }) } } });
  await assert.rejects(
    () => partial.capture.readFrame({ args: {}, session: p0Session(), snapshot: snapshot() }),
    (error) => assertAdapterError(error, 'CAPABILITY_UNSUPPORTED'),
  );
  const ok = await partial.capture.screenshot({ args: {}, session: p0Session(), snapshot: snapshot() });
  assert.equal(ok.value.family, 'A');
});

test('p0 provider validates arguments before dispatching', async () => {
  const calls = [];
  const provider = createWebP0Provider({ p0Dispatch: (...args) => { calls.push(args); return {}; } });
  const session = p0Session();
  const snap = snapshot();

  await assert.rejects(
    () => provider.capture.screenshot({ args: 'not-an-object', session, snapshot: snap }),
    (error) => assertAdapterError(error, 'INVALID_ARGUMENT'),
  );
  await assert.rejects(
    () => provider.targets.leaseAcquire({ args: {}, session, snapshot: snap }),
    (error) => assertAdapterError(error, 'INVALID_ARGUMENT'),
  );
  await assert.rejects(
    () => provider.targets.leaseRelease({ args: {}, session, snapshot: snap }),
    (error) => assertAdapterError(error, 'INVALID_ARGUMENT'),
  );
  await assert.rejects(
    () => provider.targets.leaseStatus({ args: {}, session, snapshot: snap }),
    (error) => assertAdapterError(error, 'INVALID_ARGUMENT'),
  );
  await assert.rejects(
    () => provider.network.detail({ args: {}, session, snapshot: snap }),
    (error) => assertAdapterError(error, 'INVALID_ARGUMENT'),
  );
  assert.deepEqual(calls, []);
});

test('p0 provider calls p0Dispatch(family, method, {args, session, snapshot, signal}) and attaches evidence', async () => {
  const calls = [];
  const provider = createWebP0Provider({
    p0Dispatch: (family, method, payload) => {
      calls.push({ family, method, payload });
      return { frameId: 'frame-1', receivedAt: 100 };
    },
    now: () => 999,
  });
  const session = p0Session();
  const snap = snapshot();
  const signal = new AbortController().signal;

  const result = await provider.capture.screenshot({ args: { fullPage: true }, session, snapshot: snap, signal });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].family, 'A');
  assert.equal(calls[0].method, 'screenshot');
  assert.deepEqual(calls[0].payload.args, { fullPage: true });
  assert.equal(calls[0].payload.session, session);
  assert.equal(calls[0].payload.snapshot, snap);
  assert.equal(calls[0].payload.signal, signal);

  assert.equal(result.value.family, 'A');
  assert.equal(result.value.frameId, 'frame-1');
  assert.equal(result.value.sourceTimestamp, null, 'missing source time is null, never invented');
  for (const field of P0_EVIDENCE_FIELDS) {
    assert.ok(Object.hasOwn(result.evidence, field), `evidence.${field}`);
  }
  assert.equal(result.evidence.source, 'web.p0');
  assert.equal(result.evidence.operation, 'A.screenshot');
  assert.equal(result.evidence.scope, 's1');
  assert.equal(result.evidence.session, 'web:s1');
  assert.equal(result.evidence.target, 'tab-1');
  assert.equal(result.evidence.generation, 3);
  assert.equal(result.evidence.configRevision, 7);
  assert.equal(result.evidence.capturedAt, 999);
});

test('p0 provider normalizes family payloads through the neutral models', async () => {
  const responses = {
    'A.readFrame': { frameId: 'f-2', receivedAt: 10 },
    'B.events': { events: [{ eventId: 'e-1', requestKey: { requestId: 'r-1', hopId: 0 } }], cursor: 'c-1' },
    'B.detail': { eventId: 'e-1' },
    'C.read': { space: 'image-px', geometryVersion: 2 },
    'D.annotationRead': { docId: 'doc-1', shapes: [] },
    'E.list': { targets: [{ targetId: 'tab-1' }] },
    'E.leaseAcquire': { leaseId: 'lease-1', targetId: 'tab-1' },
    'E.leaseRelease': { released: true },
    'E.leaseStatus': { leaseId: 'lease-1', targetId: 'tab-1' },
  };
  const provider = createWebP0Provider({
    p0Dispatch: (family, method) => responses[`${family}.${method}`],
  });
  const session = p0Session();
  const snap = snapshot();

  const frame = await provider.capture.readFrame({ args: {}, session, snapshot: snap });
  assert.equal(frame.value.family, 'A');
  assert.equal(frame.value.frameId, 'f-2');

  const events = await provider.network.events({ args: {}, session, snapshot: snap });
  assert.equal(events.value.cursor, 'c-1');
  assert.equal(events.value.events[0].family, 'B');
  assert.equal(events.value.events[0].requestKey.requestId, 'r-1');

  const detail = await provider.network.detail({ args: { requestId: 'r-1' }, session, snapshot: snap });
  assert.equal(detail.value.family, 'B');

  const display = await provider.display.read({ args: {}, session, snapshot: snap });
  assert.equal(display.value.family, 'C');
  assert.equal(display.value.space, 'image-px');

  const annotation = await provider.canvas.annotationRead({ args: {}, session, snapshot: snap });
  assert.equal(annotation.value.family, 'D');
  assert.equal(annotation.value.docId, 'doc-1');

  const targets = await provider.targets.list({ args: {}, session, snapshot: snap });
  assert.equal(targets.value.targets[0].family, 'E');
  assert.equal(targets.value.targets[0].targetId, 'tab-1');

  const lease = await provider.targets.leaseAcquire({ args: { targetId: 'tab-1' }, session, snapshot: snap });
  assert.equal(lease.value.family, 'E');
  assert.equal(lease.value.leaseId, 'lease-1');

  const released = await provider.targets.leaseRelease({ args: { leaseId: 'lease-1' }, session, snapshot: snap });
  assert.equal(released.value.released, true);

  const status = await provider.targets.leaseStatus({ args: { leaseId: 'lease-1' }, session, snapshot: snap });
  assert.equal(status.value.family, 'E');
  assert.equal(status.value.leaseId, 'lease-1');
});

test('p0 provider rejects closed sessions and disabled capabilities before dispatching', async () => {
  const calls = [];
  const provider = createWebP0Provider({ p0Dispatch: (...args) => { calls.push(args); return {}; } });

  await assert.rejects(
    () => provider.capture.screenshot({ args: {}, session: p0Session({ closed: true }), snapshot: snapshot() }),
    (error) => assertAdapterError(error, 'TARGET_GONE'),
  );
  await assert.rejects(
    () => provider.capture.screenshot({ args: {}, session: null, snapshot: snapshot() }),
    (error) => assertAdapterError(error, 'TARGET_NOT_BOUND'),
  );
  await assert.rejects(
    () => provider.network.start({ args: {}, session: p0Session(), snapshot: snapshot({ capabilities: ['web.p0.capture'] }) }),
    (error) => assertAdapterError(error, 'ADAPTER_DISABLED'),
  );
  assert.deepEqual(calls, []);
});

test('p0 provider preserves dispatch error codes and maps unknown ones to INTERNAL', async () => {
  const known = createWebP0Provider({
    p0Dispatch: () => {
      const error = new Error('frame source gone');
      error.code = 'TARGET_GONE';
      throw error;
    },
  });
  await assert.rejects(
    () => known.capture.screenshot({ args: {}, session: p0Session(), snapshot: snapshot() }),
    (error) => assertAdapterError(error, 'TARGET_GONE'),
  );

  const unknown = createWebP0Provider({
    p0Dispatch: () => {
      throw new Error('codec blew up');
    },
  });
  await assert.rejects(
    () => unknown.capture.screenshot({ args: {}, session: p0Session(), snapshot: snapshot() }),
    (error) => assertAdapterError(error, 'INTERNAL'),
  );
});

test('p0 provider dispose is idempotent and blocks later calls', async () => {
  const provider = createWebP0Provider({ p0Dispatch: () => ({}) });
  await provider.dispose();
  await provider.dispose();
  await assert.rejects(
    () => provider.capture.screenshot({ args: {}, session: p0Session(), snapshot: snapshot() }),
    (error) => assertAdapterError(error, 'ADAPTER_DISABLED'),
  );
});

// ---------------------------------------------------------------------------
// 6. Static boundary: no platform leakage in either direction
// ---------------------------------------------------------------------------

function stripComments(source) {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|\n)\s*\/\/[^\n]*/g, '$1');
}

function importSpecifiers(source) {
  const code = stripComments(source);
  const specs = [];
  for (const match of code.matchAll(/(?:^|\n)\s*(?:import|export)\s+[^;]*?from\s+['"]([^'"]+)['"]/g)) {
    specs.push(match[1]);
  }
  for (const match of code.matchAll(/(?:^|\n)\s*import\s+['"]([^'"]+)['"]/g)) specs.push(match[1]);
  return specs;
}

test('targets/web sources import only node builtins and core modules', () => {
  const files = readdirSync(WEB_DIR).filter((name) => name.endsWith('.js'));
  assert.deepEqual(files.sort(), ['adapter.js', 'provider.js']);

  const allowed = new Set(['../../core/index.js', '../../core/p0.js']);
  const forbiddenModules = [
    'capture-p0.js',
    'network-p0.js',
    'vision-t3.js',
    'vision-baseline.js',
    'dynamic-t4.js',
    'browser-safety.js',
    'frame-source.js',
    'frame-push.js',
  ];

  for (const file of files) {
    const source = readFileSync(join(WEB_DIR, file), 'utf8');
    const specs = importSpecifiers(source);
    assert.ok(specs.length > 0, `${file} has imports`);
    for (const spec of specs) {
      const isNodeBuiltin = spec.startsWith('node:');
      assert.ok(isNodeBuiltin || allowed.has(spec), `${file} imports ${spec}`);
      assert.equal(forbiddenModules.some((name) => spec.endsWith(name)), false, `${file} imports ${spec}`);
      const looksLikeHostEntry = /(^|\/)index\.js$/.test(spec) && spec !== '../../core/index.js';
      assert.equal(looksLikeHostEntry, false, `${file} must not import the host entry: ${spec}`);
      assert.equal(spec.includes('/targets/'), false, `${file} must not import another target: ${spec}`);
    }
    assert.equal(/import\s*\(/.test(source), false, `${file} must not use dynamic import`);
    assert.equal(/require\s*\(/.test(source), false, `${file} must not use require`);
    assert.equal(source.includes("from '../../index.js'"), false, `${file} must not import the host entry`);
  }
});

test('core never imports targets or the host entry (no reverse dependency)', () => {
  if (!existsSync(CORE_DIR)) return;
  const files = readdirSync(CORE_DIR).filter((name) => name.endsWith('.js'));
  assert.ok(files.length > 0);
  for (const file of files) {
    const source = readFileSync(join(CORE_DIR, file), 'utf8');
    for (const spec of importSpecifiers(source)) {
      assert.equal(spec.includes('targets/'), false, `core/${file} imports ${spec}`);
      assert.equal(spec.includes('index.js'), false, `core/${file} imports the host entry: ${spec}`);
      assert.equal(spec.includes('browser-safety'), false, `core/${file} imports ${spec}`);
    }
  }
});

test('web adapter declares no CDP or browser protocol dependency', () => {
  for (const file of ['adapter.js', 'provider.js']) {
    const source = readFileSync(join(WEB_DIR, file), 'utf8');
    assert.equal(/chrome-remote-interface|puppeteer|playwright|ws:\/\//.test(source), false, `${file} must not own CDP`);
  }
});
