import test from 'node:test';
import assert from 'node:assert/strict';
import { ProviderRegistry } from '../../targets/three-d/providers/registry.js';
import { CapabilityResolver, createProfile } from '../../targets/three-d/providers/resolver.js';
import { BudgetLedger } from '../../targets/three-d/providers/budget.js';
import { createManifest, createCapabilityDescriptor } from '../../targets/three-d/providers/manifests.js';
import { sha256 } from '../../targets/three-d/providers/contracts.js';

const NOW = '2026-11-26T00:00:00.000Z';
const CAPABILITY = 'geometry.primitive.fit';
const OUTPUT = 'test.lifecycle-output.v1';
const H = sha256('lifecycle-fixture');
const resources = { minRamBytes: 0, estimatedPeakRamBytes: 0, minVramBytes: 0, estimatedPeakVramBytes: 0, requiredDiskBytes: 0 };
const usage = () => ({ requestCount: 0, wallMs: 0, ramPeakBytes: 0, vramPeakBytes: 0, diskBytes: 0, outputBytes: 0, metering: 'measured' });
const proof = () => ({ suiteVersion: '1.0.0', dataset: 'lifecycle-fixture', metrics: [], checkedAt: NOW, status: 'passed', evidenceRefs: ['evidence-lifecycle'] });
const asset = () => ({ assetId: 'weights', required: true, modelVersion: 'v1', downloadBytes: 1, installedBytes: 1, sha256: H, licenseId: 'MIT' });
const request = (overrides = {}) => ({ taskId: 'task-lifecycle', requiredCapabilities: [CAPABILITY], preferredCapabilities: [], optionalCapabilities: [], qualityTarget: 'standard', inputArtifactIds: [], acceptanceProfileId: 'prop.basic', ...overrides });
const errorReason = reason => error => error?.code === 'CAPABILITY_POLICY_CONFLICT' && error?.details?.reason === reason;

function manifest(providerId = 'geometry.lifecycle', overrides = {}, capability = {}) {
  return createManifest(providerId, [createCapabilityDescriptor(CAPABILITY, { inputSchemaRef: 'test.lifecycle-input.v1', outputSchemaRef: OUTPUT, operationTier: 'T3', estimate: usage(), ...capability })], {
    providerType: 'geometry', support: 'supported', resources, ...overrides,
  });
}
function adapter(overrides = {}) {
  return {
    async health() { return { available: true }; },
    async preflight() { return { ready: true, estimate: usage() }; },
    async execute() { return { output: { fitted: true }, usage: usage() }; },
    async cancel() { return { stopped: true }; },
    async dispose() {},
    ...overrides,
  };
}
function registry() {
  return new ProviderRegistry({ platform: 'linux', clock: () => NOW, outputValidators: { [OUTPUT]: value => value?.fitted === true } });
}
async function ready(r, m = manifest(), a = adapter()) {
  r.register(m, a, { installation: 'installed', enabled: true });
  await r.health(m.providerId);
  return m.providerId;
}
const profileFor = (...ids) => createProfile('custom', { enabledProviderIds: ids });
const reseal = plan => { const { planHash, ...body } = plan; return { ...body, planHash: sha256(body) }; };

// Each base condition reaches #baseReason through public registration and health.
// Quality-only gaps stay cold until health; no internal state or method is replaced.
const model = manifest('geometry.model-fixture', {
  modelAssets: [asset()],
  runtime: { ...manifest().runtime, dependencyLockSha256: H },
  verification: { smoke: proof(), conformance: proof() },
});
const baseReasons = [
  ...['planned', 'unsupported', 'deprecated'].map(support => ({ label: support, overrides: { support }, reason: `provider-${support}` })),
  { label: 'not-installed', registration: { installation: 'not-installed' }, reason: 'provider-not-installed' },
  { label: 'failed installation', registration: { installation: 'failed' }, reason: 'provider-not-installed' },
  { label: 'disabled', registration: { enabled: false }, reason: 'provider-disabled' },
  { label: 'platform', overrides: { runtime: { ...model.runtime, platforms: ['win32'] } }, reason: 'platform-unsupported' },
  { label: 'runtime', withoutAdapter: true, reason: 'runtime-not-found' },
  { label: 'model asset', overrides: { modelAssets: [{ ...asset(), sha256: null }] }, reason: 'model-asset-missing' },
  { label: 'resources', overrides: { resources: { ...resources, minRamBytes: null } }, reason: 'resource-not-probed' },
  { label: 'dependency lock', overrides: { runtime: { ...model.runtime, dependencyLockSha256: null } }, reason: 'resource-not-probed' },
  { label: 'smoke status', overrides: { verification: { ...model.verification, smoke: { ...proof(), status: 'not-run' } } }, reason: 'not-probed', qualityOnly: true },
  { label: 'smoke evidence', overrides: { verification: { ...model.verification, smoke: { ...proof(), evidenceRefs: [] } } }, reason: 'not-probed', qualityOnly: true },
  { label: 'smoke time', overrides: { verification: { ...model.verification, smoke: { ...proof(), checkedAt: null } } }, reason: 'not-probed', qualityOnly: true },
  { label: 'conformance status', overrides: { verification: { ...model.verification, conformance: { ...proof(), status: 'not-run' } } }, reason: 'not-probed', qualityOnly: true },
  { label: 'conformance evidence', overrides: { verification: { ...model.verification, conformance: { ...proof(), evidenceRefs: [] } } }, reason: 'not-probed', qualityOnly: true },
  { label: 'conformance time', overrides: { verification: { ...model.verification, conformance: { ...proof(), checkedAt: null } } }, reason: 'not-probed', qualityOnly: true },
];
for (const scenario of baseReasons) {
  test(`base reason matrix: ${scenario.label} -> ${scenario.reason}`, async () => {
    const r = registry();
    let healthCalls = 0;
    const a = adapter({ async health() { healthCalls++; return { available: true }; } });
    const m = createManifest('geometry.reason-fixture', model.capabilities, { ...model, providerId: 'geometry.reason-fixture', ...scenario.overrides });
    const registration = { installation: 'installed', enabled: true, ...scenario.registration };
    const registered = r.register(m, scenario.withoutAdapter ? null : a, registration);
    assert.equal(registered.lifecycle, 'validated');
    assert.equal(registered.installation, registration.installation);
    assert.equal(registered.reason, scenario.reason);
    assert.equal(registered.availability, scenario.qualityOnly ? 'not-probed' : 'unavailable');
    if (scenario.qualityOnly) assert.equal(registered.quality, 'unverified');
    const checked = await r.health(m.providerId);
    assert.equal(checked.reason, scenario.qualityOnly ? null : scenario.reason);
    assert.equal(checked.availability, scenario.qualityOnly ? 'available' : 'unavailable');
    if (scenario.qualityOnly) assert.equal(checked.quality, 'unverified');
    assert.equal(checked.support, m.support);
    assert.equal(healthCalls, scenario.qualityOnly ? 1 : 0, 'only quality gaps may proceed to adapter health');
  });
}

test('lifecycle matrix: validated -> enabled -> ready -> busy/executing -> disabled -> unavailable -> disposed', { timeout: 3000 }, async () => {
  const r = registry();
  const m = manifest();
  const started = Promise.withResolvers();
  const calls = { executions: [], cancellations: [], disposed: 0 };
  let available = true;
  const a = adapter({
    async health() { return { available, reason: available ? null : 'device-offline' }; },
    async execute({ runId, signal }) {
      calls.executions.push({ runId, signal });
      if (calls.executions.length === 2) started.resolve();
      return new Promise(() => {});
    },
    async cancel(call) { calls.cancellations.push(call); return { stopped: true }; },
    async dispose() { calls.disposed++; },
  });
  const validated = r.register(m, a, { installation: 'installed' });
  assert.equal(validated.lifecycle, 'validated');
  assert.equal(validated.enabled, false);
  assert.equal(validated.reason, 'provider-disabled');
  const enabled = r.enable(m.providerId);
  assert.equal(enabled.lifecycle, 'enabled');
  assert.equal(enabled.enabled, true);
  assert.equal(enabled.availability, 'not-probed');
  const healthy = await r.health(m.providerId);
  assert.equal(healthy.lifecycle, 'ready');
  assert.equal(healthy.availability, 'available');
  assert.equal(healthy.reason, null);

  const resolver = new CapabilityResolver(r, { clock: () => NOW });
  const profile = createProfile('custom', { enabledProviderIds: [m.providerId], budget: { maxConcurrentProviders: 2 } });
  const first = resolver.resolve(profile, request()).plan;
  const second = resolver.resolve(profile, request(), { previousPlan: first, revisionReason: 'parallel-run-fixture' }).plan;
  const ledger = new BudgetLedger(first.budgetSnapshot);
  const executions = [first, second].map(plan => r.executeStage({ plan, stageId: plan.stageGraph[0].stageId, ledger }));
  // Attach rejection handlers before disable aborts both runs.
  const outcomes = Promise.allSettled(executions);
  try {
    await started.promise;
    const busy = r.get(m.providerId);
    assert.equal(busy.lifecycle, 'executing');
    assert.equal(busy.runningCount, 2);
    assert.equal(busy.availability, 'available');
    assert.equal(busy.support, 'supported');
    const disabled = await r.disable(m.providerId);
    const results = await outcomes;
    assert.equal(disabled.enabled, false);
    assert.equal(disabled.lifecycle, 'disabled');
    assert.equal(disabled.availability, 'unavailable');
    assert.equal(disabled.reason, 'provider-disabled');
    assert.equal(r.get(m.providerId).runningCount, 0);
    assert.ok(calls.executions.every(({ signal }) => signal.aborted));
    for (const { runId } of calls.executions) {
      assert.ok(calls.cancellations.some(call => call.runId === runId && call.reason === 'provider-disabled'), `disable must cancel run ${runId}`);
    }
    for (const result of results) {
      assert.equal(result.status, 'rejected');
      assert.equal(result.reason.details.reason, 'provider-disabled');
    }
  } finally {
    await r.disable(m.providerId);
    await outcomes;
  }

  r.enable(m.providerId);
  available = false;
  const unavailable = await r.health(m.providerId);
  assert.equal(unavailable.lifecycle, 'unavailable');
  assert.equal(unavailable.availability, 'unavailable');
  assert.equal(unavailable.reason, 'device-offline');
  const disposed = await r.dispose(m.providerId);
  assert.equal(disposed.lifecycle, 'disposed');
  assert.equal(disposed.reason, 'provider-disposed');
  assert.equal(disposed.availability, 'unavailable');
  assert.equal(disposed.enabled, false);
  assert.equal(calls.disposed, 1);
});

for (const cancellation of ['not-acknowledged', 'missing-acknowledgement', 'throws']) {
  test(`disable preserves cancellation uncertainty when cancel ${cancellation}`, { timeout: 3000 }, async () => {
    const r = registry();
    const started = Promise.withResolvers();
    let cancelCalls = 0;
    const id = await ready(r, manifest(), adapter({
      async execute() { started.resolve(); return new Promise(() => {}); },
      async cancel() {
        cancelCalls++;
        if (cancellation === 'throws') throw new Error('worker-cleanup-failed');
        return cancellation === 'not-acknowledged' ? { stopped: false } : undefined;
      },
    }));
    const plan = new CapabilityResolver(r, { clock: () => NOW }).resolve(profileFor(id), request()).plan;
    const result = Promise.allSettled([r.executeStage({ plan, stageId: plan.stageGraph[0].stageId, ledger: new BudgetLedger(plan.budgetSnapshot) })]);
    try {
      await started.promise;
      await r.disable(id);
      assert.equal((await result)[0].status, 'rejected');
      const state = r.get(id);
      assert.ok(cancelCalls > 0);
      assert.equal(state.lifecycle, 'disabled');
      assert.equal(state.enabled, false);
      assert.equal(state.availability, 'unavailable');
      assert.equal(state.reason, 'provider-cancellation-unverified');
      assert.equal(state.runningCount, 0);
    } finally {
      await r.disable(id);
      await result;
    }
  });
}

test('enable clears both stale success and stale failure to not-probed until a fresh health call', async () => {
  const r = registry();
  let available = true, healthCalls = 0;
  const id = await ready(r, manifest(), adapter({ async health() { healthCalls++; return { available, reason: 'device-offline' }; } }));
  assert.equal(r.get(id).availability, 'available');
  for (const stale of ['available', 'unavailable']) {
    assert.equal(r.get(id).availability, stale);
    const count = healthCalls;
    const enabled = r.enable(id);
    assert.equal(enabled.availability, 'not-probed');
    assert.equal(enabled.reason, 'not-probed');
    assert.equal(enabled.lifecycle, 'enabled');
    assert.equal(healthCalls, count);
    available = false;
    await r.health(id);
  }
});

test('support and availability remain separate axes through health, enable, disable, dispose and catalog', async () => {
  const r = registry();
  for (const support of ['supported', 'planned', 'unsupported', 'deprecated']) {
    const m = manifest(`geometry.axis-${support}`, { support });
    r.register(m, adapter({ async health() { return { available: false, reason: 'device-offline' }; } }), { installation: 'installed', enabled: true });
    const states = [r.get(m.providerId)];
    await r.health(m.providerId);
    states.push(r.get(m.providerId), r.enable(m.providerId), await r.disable(m.providerId), await r.dispose(m.providerId));
    for (const state of states) {
      assert.equal(state.support, support, 'runtime state must not overwrite the support declaration');
      assert.equal(state.manifest.support, support);
      assert.ok(['available', 'unavailable', 'not-probed'].includes(state.availability));
      assert.ok(!['supported', 'planned', 'unsupported', 'deprecated'].includes(state.availability), 'support labels must not enter availability');
      assert.ok(!['available', 'unavailable', 'not-probed'].includes(state.support), 'availability labels must not enter support');
    }
    const catalog = r.catalog().find(item => item.providerId === m.providerId);
    assert.equal(catalog.support, support);
    assert.equal(catalog.availability, 'unavailable');
  }
});

test('unregister disposes the adapter before removing registry and catalog entries', async () => {
  const r = registry();
  let disposed = 0;
  const id = await ready(r, manifest(), adapter({ async dispose() { disposed++; } }));
  await r.unregister(id);
  assert.equal(disposed, 1);
  assert.deepEqual(r.list(), []);
  assert.deepEqual(r.catalog(), []);
  assert.throws(() => r.get(id), error => error?.code === 'PROVIDER_NOT_INSTALLED' && error?.details?.reason === 'provider-not-installed');
});

function assertRevision(previous, next, reason) {
  assert.notEqual(next.planId, previous.planId);
  assert.notEqual(next.planHash, previous.planHash);
  assert.equal(next.revision, previous.revision + 1);
  assert.equal(next.previousPlanHash, previous.planHash);
  assert.equal(next.revisionReason, reason);
  for (const plan of [previous, next]) {
    const { planHash, ...body } = plan;
    assert.equal(planHash, sha256(body));
    assert.ok(Object.isFrozen(plan));
  }
}
const routeRecord = plan => plan.stageGraph.map(({ capabilityId, providerId, operationTier }) => ({ capabilityId, providerId, operationTier }));

test('provider fallback creates a linked plan revision whose snapshots audit the old and new provider/tier', async () => {
  const r = registry();
  const primary = await ready(r, manifest('geometry.primary'));
  const secondary = await ready(r, manifest('geometry.secondary', {}, { operationTier: 'T1' }));
  const profile = createProfile('custom', { enabledProviderIds: [primary, secondary], providerPriority: [primary, secondary] });
  const resolver = new CapabilityResolver(r, { clock: () => NOW });
  const oldPlan = resolver.resolve(profile, request()).plan;
  await r.disable(primary);
  const nextPlan = resolver.resolve(profile, request(), { previousPlan: oldPlan, revisionReason: 'primary-disabled-use-local-fallback' }).plan;
  assertRevision(oldPlan, nextPlan, 'primary-disabled-use-local-fallback');
  assert.deepEqual(routeRecord(oldPlan), [{ capabilityId: CAPABILITY, providerId: primary, operationTier: 'T3' }]);
  assert.deepEqual(routeRecord(nextPlan), [{ capabilityId: CAPABILITY, providerId: secondary, operationTier: 'T1' }]);
  assert.equal(nextPlan.selectedProviders[0].providerId, secondary);
  assert.equal(nextPlan.status, 'ready');
});

test('tier reroute on the same provider increments revision and retains an explicit audit reason', async () => {
  const r = registry();
  const descriptor = manifest().capabilities[0];
  const routes = [descriptor.routes[0], { ...descriptor.routes[0], operationTier: 'T1', toolId: 'blender_scene_query' }];
  const id = await ready(r, manifest('geometry.multitier', {}, { routes }));
  const resolver = new CapabilityResolver(r, { clock: () => NOW });
  const profile = profileFor(id);
  const oldPlan = resolver.resolve(profile, request({ routes: [{ capabilityId: CAPABILITY, operationTier: 'T3' }] })).plan;
  const nextPlan = resolver.resolve(profile, request({ routes: [{ capabilityId: CAPABILITY, operationTier: 'T1' }] }), { previousPlan: oldPlan, revisionReason: 'user-selected-whitebox-tier' }).plan;
  assertRevision(oldPlan, nextPlan, 'user-selected-whitebox-tier');
  assert.equal(oldPlan.stageGraph[0].providerId, nextPlan.stageGraph[0].providerId);
  assert.equal(oldPlan.stageGraph[0].operationTier, 'T3');
  assert.equal(nextPlan.stageGraph[0].operationTier, 'T1');
  const defaultReason = resolver.resolve(profile, request(), { previousPlan: nextPlan }).plan;
  assertRevision(nextPlan, defaultReason, 'explicit-reroute');
});

for (const invalidity of ['hash mismatch', 'task mismatch', 'expired', 'expiry boundary']) {
  test(`previousPlan rejects ${invalidity} before producing a new revision`, async () => {
    const r = registry();
    const id = await ready(r);
    let now = NOW;
    const resolver = new CapabilityResolver(r, { clock: () => now, planTtlMs: 1000 });
    const profile = profileFor(id);
    const original = resolver.resolve(profile, request()).plan;
    let previousPlan = original;
    if (invalidity === 'hash mismatch') previousPlan = { ...original, planHash: sha256('tampered-plan') };
    if (invalidity === 'task mismatch') previousPlan = reseal({ ...original, taskId: 'task-other' });
    if (invalidity === 'expired') now = new Date(Date.parse(original.expiresAt) + 1).toISOString();
    if (invalidity === 'expiry boundary') now = original.expiresAt;
    const reason = ['expired', 'expiry boundary'].includes(invalidity) ? 'previous-plan-expired' : 'previous-plan-invalid';
    assert.throws(() => resolver.resolve(profile, request(), { previousPlan, revisionReason: 'must-not-revive-invalid-plan' }), errorReason(reason));
    assert.equal(original.revision, 0);
    assert.equal(original.previousPlanHash, null);
  });
}

for (const fallbackPolicy of ['none', 'degrade-optional', 'ask-user']) {
  test(`fallback ${fallbackPolicy} never fabricates a missing required capability`, async () => {
    const r = registry();
    const id = await ready(r);
    const resolver = new CapabilityResolver(r, { clock: () => NOW });
    const profile = createProfile('custom', { enabledProviderIds: [id], fallbackPolicy });
    const blocked = resolver.resolve(profile, request({ requiredCapabilities: [CAPABILITY, 'vision.depth.metric'] })).plan;
    assert.equal(blocked.status, 'blocked');
    assert.deepEqual(blocked.unresolved, [{ capabilityId: 'vision.depth.metric', requirement: 'required', reason: 'provider-not-installed' }]);
    assert.ok(blocked.stageGraph.every(stage => stage.capabilityId !== 'vision.depth.metric'));
    assert.ok(blocked.selectedProviders.every(provider => provider.capabilityId !== 'vision.depth.metric'));
    const revision = resolver.resolve(profile, request({ requiredCapabilities: [CAPABILITY, 'vision.depth.metric'] }), { previousPlan: blocked, revisionReason: 'retry-missing-required' }).plan;
    assert.equal(revision.status, 'blocked');
    assertRevision(blocked, revision, 'retry-missing-required');
    const optional = resolver.resolve(profile, request({ optionalCapabilities: ['vision.depth.metric'] })).plan;
    assert.equal(optional.status, { none: 'blocked', 'degrade-optional': 'ready', 'ask-user': 'awaiting-user' }[fallbackPolicy]);
    assert.equal(optional.unresolved[0].requirement, 'optional');
  });
}
