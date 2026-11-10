/**
 * M1 core contract tests: errors, identity, geometry, clock, evidence, registry, readiness.
 *
 * Pure unit tests only — no browser, no network, no repo files. Every assertion here exercises the
 * neutral contracts that adapters are expected to consume.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import * as core from '../../core/index.js';

const CORE_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'core');

function assertClose(actual, expected, epsilon = 1e-9) {
  assert.ok(
    Math.abs(actual - expected) <= epsilon,
    `expected ${actual} to be within ${epsilon} of ${expected}`,
  );
}

function assertCode(code) {
  return (error) => {
    assert.ok(error instanceof core.AdapterError, `expected AdapterError, got ${error?.name}`);
    assert.equal(error.code, code);
    return true;
  };
}

test('contract constants are frozen and internally consistent', () => {
  assert.equal(core.CONTRACT_VERSION, 1);
  assert.deepEqual(core.READINESS_AXES, [
    'support', 'enabled', 'dependency', 'connection', 'target', 'capability',
  ]);
  assert.deepEqual(core.COORDINATE_SPACES, [
    'document-css-px', 'image-px', 'viewport-css-px', 'screen-logical-px', 'screen-physical-px',
  ]);
  assert.equal(core.CAPABILITY_IDS.WEB.T1, 'web.t1');
  assert.equal(core.CAPABILITY_IDS.FAKE.NETWORK, 'fake.network');
  assert.equal(core.SUPPORT.PLANNED, 'planned');
  assert.equal(core.AVAILABILITY.NOT_PROBED, 'not-probed');
  assert.equal(core.READINESS_STATUS.UNBOUND, 'unbound');
  assert.equal(core.ADAPTER_CLASSES.P0, 'p0');
  assert.equal(core.ENVIRONMENTS.LINUX, 'linux-desktop');
  assert.ok(Object.isFrozen(core.ERROR_CODES));
  assert.ok(Object.isFrozen(core.ENVIRONMENT_CAPABILITIES.web));
});

test('isCapabilityId accepts adapter catalog ids only', () => {
  for (const ids of Object.values(core.ENVIRONMENT_CAPABILITIES)) {
    for (const id of ids) assert.equal(core.isCapabilityId(id), true, id);
  }
  assert.equal(core.isCapabilityId('web.p0.network'), true);
  assert.equal(core.isCapabilityId('web.p0.capture'), true);
  assert.equal(core.isCapabilityId('web.unknown'), false);
  assert.equal(core.isCapabilityId('chrome.t1'), false);
  assert.equal(core.isCapabilityId(null), false);
});

test('AdapterError normalizes codes and keeps message/details', () => {
  const error = new core.AdapterError('CONFIG_CONFLICT', 'revision conflict', { expected: 1, actual: 2 });
  assert.equal(error.code, 'CONFIG_CONFLICT');
  assert.equal(error.category, 'config');
  assert.equal(error.retryable, true);
  assert.deepEqual(error.details, { expected: 1, actual: 2 });
  const payload = error.payload();
  assert.equal(payload.code, 'CONFIG_CONFLICT');
  assert.equal(payload.category, 'config');
  assert.equal(payload.message, 'revision conflict');
  assert.deepEqual(JSON.parse(JSON.stringify(payload)).details, { expected: 1, actual: 2 });

  const unknown = new core.AdapterError('NOT_A_REAL_CODE', 'keep this message');
  assert.equal(unknown.code, 'INTERNAL');
  assert.equal(unknown.category, 'internal');
  assert.equal(unknown.message, 'keep this message');
  assert.equal(unknown.details.requestedCode, 'NOT_A_REAL_CODE');
});

test('asAdapterError preserves AdapterError and wraps other values', () => {
  const original = new core.AdapterError('TARGET_GONE', 'gone');
  assert.equal(core.asAdapterError(original), original);

  const stale = new core.AdapterError('CONFIG_STALE', 'session revision is stale');
  assert.equal(stale.code, 'CONFIG_STALE');
  assert.equal(stale.category, 'config');
  assert.equal(stale.retryable, true);
  assert.equal(core.ERROR_CODES.CONFIG_STALE, 'CONFIG_STALE');

  const wrapped = core.asAdapterError(new TypeError('boom'));
  assert.equal(wrapped.code, 'INTERNAL');
  assert.equal(wrapped.message, 'boom');
  assert.equal(wrapped.details.causeName, 'TypeError');

  const fallback = core.asAdapterError(new Error('timeout'), 'PROBE_TIMEOUT');
  assert.equal(fallback.code, 'PROBE_TIMEOUT');
  assert.equal(fallback.message, 'timeout');

  const plain = core.asAdapterError('nope');
  assert.equal(plain.code, 'INTERNAL');
  assert.equal(plain.message, 'nope');
  // M1 (docs/internal/m0-rulings-20261109.md §7.3) added two categories that the old eight could
  // not express honestly: `authorization` ("you may not") is not a broken capability, and
  // `resource` (a 4/8-page or 32-entry budget) is not a target answer. Both are additive; no
  // existing code changed category, so old callers that branch on the eight keep working.
  assert.deepEqual(Object.keys(core.ERROR_CATEGORIES).sort(), [
    'AUTHORIZATION', 'CAPABILITY', 'CONFIG', 'ENVIRONMENT', 'EVIDENCE', 'INPUT', 'INTERNAL',
    'RESOURCE', 'STATE', 'TARGET',
  ]);
});

test('identity factories never fabricate missing fields', () => {
  const emptyScope = core.newScopeIdentity();
  assert.deepEqual(emptyScope, {
    id: null, kind: null, workspaceId: null, cwd: null, sessionId: null,
  });
  const scope = core.newScopeIdentity({ id: 'scope-1', cwd: '/tmp/ws' });
  assert.equal(scope.id, 'scope-1');
  assert.equal(scope.cwd, '/tmp/ws');
  assert.equal(scope.workspaceId, null);

  const target = core.newTargetIdentity({
    targetId: 't1', environment: 'web', kind: 'tab', generation: 3, label: 'Tab', lifecycle: 'bound',
  });
  assert.deepEqual(target, {
    targetId: 't1', environment: 'web', kind: 'tab', generation: 3, label: 'Tab', lifecycle: 'bound',
  });
  assert.deepEqual(core.newTargetIdentity(), {
    targetId: null, environment: null, kind: null, generation: null, label: null, lifecycle: null,
  });

  const session = core.newSessionIdentity({ sessionId: 's1', environment: 'fake' });
  assert.equal(session.sessionId, 's1');
  assert.equal(session.environment, 'fake');
  assert.equal(session.generation, null);
  assert.equal(session.configRevision, null);
  assert.equal(session.targetId, null);
});

test('workspaceKeyOf gives one stable key for config buckets and runtime entries', () => {
  assert.equal(core.workspaceKeyOf({ workspaceId: 'w1', cwd: '/tmp/ignored' }), 'workspace:w1');
  assert.equal(core.workspaceKeyOf({ agent: { workspaceId: 'w2' }, cwd: '/tmp/ignored' }), 'workspace:w2');
  const key = core.workspaceKeyOf({ cwd: '/tmp' });
  assert.match(key, /^path:[0-9a-f]{64}$/);
  assert.equal(core.workspaceKeyOf({ cwd: '/tmp/.' }), key, 'cwd is normalized before hashing');
  assert.equal(core.workspaceKeyOf({ agent: { session: { header: { cwd: '/tmp' } } } }), key);
  assert.equal(core.workspaceKeyOf({}), null);
  assert.equal(core.workspaceKeyOf({ cwd: '' }), null);
});

test('operation summaries record shape, not argument plaintext', () => {
  const operation = core.newOperation({
    tool: 'browser_navigate',
    args: {
      url: 'https://secret.example/path?token=abc',
      nested: { password: 'hunter2' },
      retries: 3,
    },
    startedAt: 1000,
    operationId: 'op-test-1',
  });
  assert.equal(operation.operationId, 'op-test-1');
  assert.equal(operation.tool, 'browser_navigate');
  assert.equal(operation.startedAt, 1000);
  assert.equal(operation.finishedAt, null);
  assert.deepEqual(operation.argsSummary, { type: 'object', keys: 3 });
  const serialized = JSON.stringify(operation);
  assert.equal(serialized.includes('secret'), false);
  assert.equal(serialized.includes('hunter2'), false);
  assert.equal(serialized.includes('token'), false);
  assert.deepEqual(core.summarizeArgs('abc'), { type: 'string', length: 3 });
  assert.deepEqual(core.summarizeArgs([1, 2]), { type: 'array', length: 2 });
  assert.deepEqual(core.summarizeArgs(null), { type: 'null' });
});

test('generation assertions are explicit', () => {
  const target = core.newTargetIdentity({ targetId: 't1', generation: 2 });
  assert.equal(core.assertGeneration(target, 2), target);
  assert.equal(core.assertGeneration(5, 5), 5);
  assert.throws(
    () => core.assertGeneration(target, 3),
    (error) => {
      assert.equal(error.code, 'GENERATION_MISMATCH');
      assert.deepEqual(error.details, { expected: 3, actual: 2, targetId: 't1' });
      return true;
    },
  );
  assert.throws(() => core.assertGeneration(null, 1), assertCode('GENERATION_MISMATCH'));
});

test('geometry maps points/rects and round-trips within 1e-9', () => {
  const transform = core.createTransform({
    from: 'image-px',
    to: 'document-css-px',
    scaleX: 1.25,
    scaleY: 0.5,
    offsetX: 10.5,
    offsetY: -3,
    geometryVersion: 7,
  });
  const point = { x: 12.5, y: 40 };
  const mapped = core.mapPoint(transform, point);
  assertClose(mapped.x, 12.5 * 1.25 + 10.5);
  assertClose(mapped.y, 40 * 0.5 - 3);
  const roundTrip = core.mapPoint(core.invertTransform(transform), mapped);
  assertClose(roundTrip.x, point.x);
  assertClose(roundTrip.y, point.y);

  const rect = { x: 10, y: 20, width: 40, height: 30 };
  const mappedRect = core.mapRect(transform, rect);
  assertClose(mappedRect.x, 10 * 1.25 + 10.5);
  assertClose(mappedRect.y, 20 * 0.5 - 3);
  assertClose(mappedRect.width, 40 * 1.25);
  assertClose(mappedRect.height, 30 * 0.5);
  const rectBack = core.mapRect(core.invertTransform(transform), mappedRect);
  assertClose(rectBack.x, rect.x);
  assertClose(rectBack.y, rect.y);
  assertClose(rectBack.width, rect.width);
  assertClose(rectBack.height, rect.height);
});

test('geometry composes in call order and supports negative scale rects', () => {
  const first = core.createTransform({ from: 'image-px', to: 'viewport-css-px', scaleX: 2, scaleY: 2, geometryVersion: 3 });
  const second = core.createTransform({ from: 'viewport-css-px', to: 'screen-logical-px', scaleX: 0.5, offsetX: 5, geometryVersion: 3 });
  const composed = core.composeTransforms(first, second);
  const point = { x: 4, y: 6 };
  assert.deepEqual(core.mapPoint(composed, point), core.mapPoint(second, core.mapPoint(first, point)));
  assert.equal(composed.from, 'image-px');
  assert.equal(composed.to, 'screen-logical-px');

  const identity = core.identityTransform('image-px', 3);
  const withIdentity = core.composeTransforms(identity, first);
  assert.deepEqual(withIdentity, first);

  const flipped = core.createTransform({ from: 'image-px', to: 'document-css-px', scaleX: -1 });
  const flippedRect = core.mapRect(flipped, { x: 10, y: 0, width: 20, height: 5 });
  assert.deepEqual(flippedRect, { x: -30, y: 0, width: 20, height: 5 });
});

test('geometry rejects incompatible mappings and invalid input', () => {
  const base = core.createTransform({ from: 'image-px', to: 'document-css-px', geometryVersion: 1 });
  assert.equal(core.assertCompatibleMapping(base, { ...base }), true);

  assert.throws(
    () => core.assertCompatibleMapping(base, core.createTransform({ from: 'image-px', to: 'viewport-css-px' })),
    assertCode('CAPABILITY_UNSUPPORTED'),
  );
  assert.throws(
    () => core.assertCompatibleMapping(base, core.createTransform({ from: 'image-px', to: 'document-css-px', geometryVersion: 2 })),
    assertCode('GENERATION_MISMATCH'),
  );
  assert.throws(
    () => core.composeTransforms(base, core.createTransform({ from: 'screen-logical-px', to: 'screen-physical-px' })),
    assertCode('CAPABILITY_UNSUPPORTED'),
  );
  assert.throws(() => core.createTransform({ from: 'bogus', to: 'image-px' }), assertCode('INVALID_ARGUMENT'));
  assert.throws(() => core.createTransform({ from: 'image-px', to: 'document-css-px', scaleX: NaN }), assertCode('INVALID_ARGUMENT'));
  assert.throws(() => core.mapPoint(base, { x: NaN, y: 0 }), assertCode('INVALID_ARGUMENT'));
  assert.throws(() => core.mapRect(base, { x: 0, y: 0, width: Infinity, height: 1 }), assertCode('INVALID_ARGUMENT'));
  assert.throws(() => core.invertTransform({ ...base, scaleX: 0 }), assertCode('CAPABILITY_UNSUPPORTED'));
  assert.throws(() => core.identityTransform('not-a-space'), assertCode('INVALID_ARGUMENT'));
});

test('clock is monotonic and never fabricates a source timestamp', () => {
  let previous = core.nowMonoMs();
  for (let index = 0; index < 200; index += 1) {
    const current = core.nowMonoMs();
    assert.ok(current >= previous, 'monotonic clock went backwards');
    previous = current;
  }
  const anchor = core.createClockAnchor({ wallMs: 1_000_000, monoMs: 500 });
  assert.equal(core.toSourceTime(anchor, 1500), 1_001_000);
  assert.throws(() => core.createClockAnchor({ wallMs: NaN, monoMs: 0 }), assertCode('INVALID_ARGUMENT'));
  assert.throws(() => core.toSourceTime(anchor, Infinity), assertCode('INVALID_ARGUMENT'));

  assert.equal(core.sourceTimestampOrNull(undefined), null);
  assert.equal(core.sourceTimestampOrNull(null), null);
  assert.equal(core.sourceTimestampOrNull(NaN), null);
  assert.equal(core.sourceTimestampOrNull(Infinity), null);
  assert.equal(core.sourceTimestampOrNull('123'), null);
  assert.equal(core.sourceTimestampOrNull(0), 0);
  assert.equal(core.sourceTimestampOrNull(123.5), 123.5);

  assert.throws(
    () => core.assertNoFabricatedSourceTime({ sourceTimestamp: null, derivedSource: { wallMs: 1 } }),
    assertCode('EVIDENCE_INCOMPLETE'),
  );
  assert.throws(
    () => core.assertNoFabricatedSourceTime({ derivedSource: { wallMs: 1 } }),
    assertCode('EVIDENCE_INCOMPLETE'),
  );
  assert.doesNotThrow(() => core.assertNoFabricatedSourceTime({ sourceTimestamp: null }));
  assert.doesNotThrow(() => core.assertNoFabricatedSourceTime({ sourceTimestamp: 1000, derivedSource: { wallMs: 1 } }));
});

test('evidence envelopes carry required identity and validate missing fields', () => {
  const envelope = core.createEvidenceEnvelope({
    scope: { id: 'scope-1' },
    session: { sessionId: 's1' },
    target: null,
    generation: 2,
    configRevision: 4,
    operation: { operationId: 'op-1' },
    source: { kind: 'synthetic' },
    capturedAt: 1234,
    extra: { custom: true, version: 99 },
  });
  assert.equal(envelope.version, 1);
  assert.equal(envelope.custom, true);
  assert.equal(envelope.target, null);
  assert.deepEqual(core.validateEvidence(envelope), { ok: true, missing: [] });

  const empty = core.validateEvidence({});
  assert.equal(empty.ok, false);
  assert.deepEqual(empty.missing, [...core.EVIDENCE_REQUIRED_FIELDS]);

  const { source, ...withoutSource } = envelope;
  assert.deepEqual(core.validateEvidence(withoutSource).missing, ['source']);
  assert.equal(source.kind, 'synthetic');

  const merged = core.mergeEvidence(envelope, { capturedAt: 9999, note: 'later', version: 42 });
  assert.equal(merged.capturedAt, 9999);
  assert.equal(merged.note, 'later');
  assert.equal(merged.version, 1);
});

test('EvidenceStore is bounded and keyed by evidenceId', () => {
  const store = new core.EvidenceStore({ limit: 2 });
  const first = store.add({ marker: 1 });
  const second = store.add({ marker: 2 });
  const third = store.add({ marker: 3 });
  assert.equal(store.size, 2);
  assert.equal(store.get(first.evidenceId), undefined);
  assert.equal(store.get(second.evidenceId).marker, 2);
  assert.equal(store.get(third.evidenceId).marker, 3);
  assert.deepEqual(store.list().map((entry) => entry.marker), [2, 3]);
  store.clear();
  assert.equal(store.size, 0);
  assert.deepEqual(store.list(), []);
  assert.throws(() => new core.EvidenceStore({ limit: 0 }), assertCode('INVALID_ARGUMENT'));
  assert.throws(() => store.add(null), assertCode('INVALID_ARGUMENT'));
});

function buildFakeAdapters() {
  const target = {
    manifest: {
      contractVersion: 1,
      id: 'fake',
      class: 'target',
      environment: 'fake',
      capabilities: [],
      visibility: 'test-only',
    },
    async probe() { return null; },
    async createSession() { return null; },
    async dispose() { target.disposed = true; },
  };
  const capability = {
    manifest: {
      contractVersion: 1,
      id: 'fake-core',
      class: 'capability',
      environment: 'fake',
      capabilities: ['fake.t1', 'fake.t2'],
      operations: ['snapshot'],
    },
    operationStatus() {
      return { snapshot: { support: 'supported', availability: 'available' } };
    },
    async invoke() { return { value: null, evidence: null }; },
    async dispose() { capability.disposed = true; },
  };
  const provider = {
    manifest: {
      contractVersion: 1,
      id: 'fake-p0',
      class: 'p0',
      environment: 'fake',
      family: 'A',
      capabilities: ['fake.p0.capture'],
    },
    async dispose() { provider.disposed = true; },
  };
  return { target, capability, provider };
}

test('registry resolves by snapshot and validates manifests', async () => {
  const { target, capability, provider } = buildFakeAdapters();
  const registry = new core.AdapterRegistry();
  registry.registerTargetAdapter(target);
  registry.registerCapabilityAdapter(capability);
  registry.registerP0Provider(provider);

  const snapshot = {
    environment: 'fake',
    enabledEnvironments: ['fake'],
    capabilities: ['fake.t1', 'fake.p0.capture'],
    revision: 1,
    targetId: null,
  };
  const resolved = registry.resolve(snapshot);
  assert.equal(resolved.targetAdapter, target);
  assert.deepEqual(resolved.capabilityAdapters, [capability]);
  assert.deepEqual(resolved.providers, [provider]);

  const capabilities = registry.capabilitiesFor(snapshot);
  assert.deepEqual(capabilities, [
    { id: 'fake.t1', support: 'supported', availability: 'available' },
    {
      id: 'fake.p0.capture',
      support: 'planned',
      availability: 'unavailable',
      reason: 'adapter-not-registered',
    },
  ]);

  assert.throws(() => registry.registerTargetAdapter(target), assertCode('CONFIG_INVALID'));
  assert.throws(
    () => registry.registerCapabilityAdapter({ ...capability, manifest: { ...capability.manifest } }),
    (error) => error.code === 'CONFIG_INVALID',
  );
  assert.throws(
    () => registry.registerTargetAdapter({ manifest: { ...target.manifest, environment: 'web', contractVersion: 2 } }),
    assertCode('ADAPTER_UNSUPPORTED'),
  );
  assert.throws(
    () => registry.registerTargetAdapter({ manifest: { ...target.manifest, environment: 'web', class: 'capability' } }),
    assertCode('CONFIG_INVALID'),
  );
  assert.throws(
    () => registry.resolve({ environment: 'web', enabledEnvironments: ['web'] }),
    assertCode('ADAPTER_NOT_FOUND'),
  );
  assert.throws(
    () => registry.resolve({ environment: 'fake', enabledEnvironments: ['web'] }),
    assertCode('ADAPTER_DISABLED'),
  );

  await registry.dispose();
  assert.equal(target.disposed, true);
  assert.equal(capability.disposed, true);
  assert.equal(provider.disposed, true);

  // Legacy adapters that only implement capabilities() still work (renamed in the frozen M0).
  const legacyRegistry = new core.AdapterRegistry();
  legacyRegistry.registerTargetAdapter({ manifest: { ...target.manifest, id: 'fake-legacy' } });
  legacyRegistry.registerCapabilityAdapter({
    manifest: { ...capability.manifest, id: 'fake-legacy-cap' },
    capabilities() {
      return { snapshot: { support: 'supported', availability: 'unavailable', reason: 'cold' } };
    },
  });
  assert.deepEqual(
    legacyRegistry.capabilitiesFor({
      environment: 'fake',
      enabledEnvironments: ['fake'],
      capabilities: ['fake.t1'],
    }),
    [{ id: 'fake.t1', support: 'supported', availability: 'unavailable', reason: 'cold' }],
  );
  await legacyRegistry.dispose();
});

test('readiness keeps six independent axes and defaults to not-probed', () => {
  const { target } = buildFakeAdapters();
  const report = core.createReadinessReport({
    environment: 'fake',
    snapshot: {
      revision: 4,
      enabledEnvironments: ['fake'],
      capabilities: ['fake.t1'],
      targetId: null,
    },
    adapter: target,
    now: 1234,
  });
  assert.equal(report.environment, 'fake');
  assert.equal(report.configRevision, 4);
  assert.equal(report.checkedAt, 1234);
  assert.deepEqual(Object.keys(report.axes), [...core.READINESS_AXES]);
  assert.equal(report.axes.support.status, 'supported');
  assert.equal(report.axes.enabled.status, 'ok');
  assert.equal(report.axes.target.status, 'unbound');
  assert.equal(report.axes.dependency.status, 'not-probed');
  assert.equal(report.axes.connection.status, 'not-probed');
  assert.equal(report.axes.capability.status, 'not-probed');

  const withProbe = core.createReadinessReport({
    environment: 'fake',
    axes: { capability: { status: 'available', checkedAt: 50, evidence: { id: 'e1' } } },
    now: 10,
  });
  assert.equal(withProbe.axes.capability.status, 'available');
  assert.equal(withProbe.axes.capability.checkedAt, 50);
  assert.equal(withProbe.axes.support.status, 'not-probed');

  assert.throws(
    () => core.createReadinessReport({ environment: 'fake', axes: { madeUp: 'ok' } }),
    assertCode('INVALID_ARGUMENT'),
  );
  assert.throws(() => core.axis(''), assertCode('INVALID_ARGUMENT'));

  const notProbed = core.buildNotProbedAxes('no-probe');
  for (const name of core.READINESS_AXES) {
    assert.equal(notProbed[name].status, 'not-probed');
    assert.equal(notProbed[name].reason, 'no-probe');
  }
  assert.equal(core.DEFAULT_TTL_MS, 30000);
});

test('mergeProbeResult updates only supplied axes without mutating the report', () => {
  const report = core.createReadinessReport({
    environment: 'web',
    snapshot: { revision: 2, enabledEnvironments: ['web'], capabilities: ['web.t1'], targetId: 't1' },
    now: 100,
  });
  const before = structuredClone(report);
  const merged = core.mergeProbeResult(report, {
    checkedAt: 200,
    axes: { dependency: { status: 'ok', checkedAt: 200 }, target: 'bound' },
  });
  assert.equal(merged.checkedAt, 200);
  assert.equal(merged.axes.dependency.status, 'ok');
  assert.equal(merged.axes.target.status, 'bound');
  assert.equal(merged.axes.support.status, report.axes.support.status);
  assert.deepEqual(report, before);
  assert.throws(() => core.mergeProbeResult({}, {}), assertCode('INVALID_ARGUMENT'));
});

test('core modules never import platform implementations', () => {
  const files = readdirSync(CORE_DIR).filter((name) => name.endsWith('.js'));
  assert.ok(files.length >= 10, 'expected the full core module set');
  const forbidden = [
    'index.js', 'targets/', 'browser-safety', 'capture-p0', 'network-p0',
    'vision-t3', 'vision-baseline', 'dynamic-t4', 'frame-source', 'frame-push', 'client.js',
  ];
  for (const file of files) {
    const source = readFileSync(join(CORE_DIR, file), 'utf8');
    const specifiers = [...source.matchAll(/(?:import|export)\s+(?:[^'"]*?\s+from\s+)?['"]([^'"]+)['"]/g)]
      .map((match) => match[1]);
    for (const specifier of specifiers) {
      assert.ok(
        specifier.startsWith('node:') || specifier.startsWith('./'),
        `${file} imports a non-core specifier: ${specifier}`,
      );
      assert.equal(specifier.includes('..'), false, `${file} escapes core/: ${specifier}`);
      for (const marker of forbidden) {
        assert.equal(specifier.includes(marker), false, `${file} imports ${marker}: ${specifier}`);
      }
    }
  }
});
