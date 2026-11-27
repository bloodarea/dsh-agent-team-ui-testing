import test from 'node:test';
import assert from 'node:assert/strict';
import { ProviderRegistry } from '../../targets/three-d/providers/registry.js';
import { CapabilityResolver, createProfile } from '../../targets/three-d/providers/resolver.js';
import { BudgetLedger } from '../../targets/three-d/providers/budget.js';
import { createManifest, createCapabilityDescriptor } from '../../targets/three-d/providers/manifests.js';
import { sha256, validate } from '../../targets/three-d/providers/contracts.js';

const NOW = '2026-11-26T00:00:00.000Z';
const H = sha256('quality-gating-fixture');
const CAPABILITY = 'geometry.primitive.fit';
const OUTPUT = 'test.quality-output.v1';
const RESOURCES = { minRamBytes: 0, estimatedPeakRamBytes: 0, minVramBytes: 0, estimatedPeakVramBytes: 0, requiredDiskBytes: 1 };
const ASSET = { assetId: 'weights', required: true, modelVersion: 'v1', sha256: H, downloadBytes: 1, installedBytes: 1, licenseId: 'MIT' };
const usage = (wallMs = 1) => ({ requestCount: 0, actualMoney: 0, wallMs, ramPeakBytes: 0, vramPeakBytes: 0, diskBytes: 1, outputBytes: 0, metering: 'measured' });
const proof = (overrides = {}) => ({ suiteVersion: '1.0.0', dataset: 'quality-fixture', metrics: [], checkedAt: NOW, status: 'passed', evidenceRefs: ['quality-evidence'], ...overrides });
const request = (overrides = {}) => ({ taskId: 'task-quality', requiredCapabilities: [CAPABILITY], preferredCapabilities: [], optionalCapabilities: [], qualityTarget: 'standard', inputArtifactIds: [], acceptanceProfileId: 'prop.basic', ...overrides });
const profileFor = (...ids) => createProfile('custom', { enabledProviderIds: ids });

function manifest(providerId = 'geometry.quality', overrides = {}, capability = {}) {
  const { runtime = {}, ...manifestOverrides } = overrides;
  const base = createManifest(providerId, [createCapabilityDescriptor(CAPABILITY, { inputSchemaRef: 'test.quality-input.v1', outputSchemaRef: OUTPUT, estimate: usage(), ...capability })], {
    support: 'supported', providerType: 'geometry', modelAssets: [ASSET], resources: RESOURCES,
    verification: { smoke: proof(), conformance: proof() }, ...manifestOverrides,
  });
  return createManifest(providerId, base.capabilities, { ...base, runtime: { ...base.runtime, dependencyLockSha256: H, ...runtime } });
}
function registry() {
  return new ProviderRegistry({ platform: 'linux', clock: () => NOW, outputValidators: { [OUTPUT]: output => output?.fitted === true } });
}
function adapter(health = async () => ({ available: true })) {
  return { health, async preflight() { return { ready: true, estimate: usage() }; }, async execute() { return { output: { fitted: true }, usage: usage() }; }, async cancel() { return { stopped: true }; } };
}
async function ready(r, m) {
  r.register(m, adapter(), { installation: 'installed', enabled: true });
  return r.health(m.providerId);
}

// The frozen schema has two quality values; capability metadata discloses degradation.
test('not-run smoke remains cold until health, then available but unverified', async () => {
  const r = registry();
  const m = manifest(undefined, { verification: { smoke: proof({ status: 'not-run', evidenceRefs: [], checkedAt: null }), conformance: proof() } });
  let calls = 0;
  const registered = r.register(m, adapter(async () => { calls++; return { available: true }; }), { installation: 'installed', enabled: true });
  assert.equal(registered.availability, 'not-probed');
  assert.equal(registered.reason, 'not-probed');
  assert.equal(registered.quality, 'unverified');
  assert.equal(calls, 0);
  const health = await r.health(m.providerId);
  assert.equal(health.availability, 'available');
  assert.equal(health.reason, null);
  assert.equal(health.quality, 'unverified');
  assert.equal(health.support, 'supported');
  assert.equal(health.installation, 'installed');
  assert.equal(health.enabled, true);
  assert.equal(calls, 1);
  assert.equal(validate('providerHealthReport', health).valid, true);
});

test('degraded conformance remains routable and executable with limitations disclosed', async () => {
  const r = registry();
  const limitations = ['refiner-disabled-flex_gemm-triton-incompatible', 'gsplat-cuda-renderer-not-validated'];
  const qualityTags = ['quality-unverified'];
  const m = manifest(undefined, { verification: { smoke: proof(), conformance: proof({ status: 'failed' }) } }, { limitations, qualityTags });
  const health = await ready(r, m);
  assert.equal(health.availability, 'available');
  assert.equal(health.quality, 'unverified');
  assert.equal(health.reason, null);
  assert.deepEqual(r.catalog()[0].limitations, limitations);
  assert.deepEqual(r.catalog()[0].qualityTags, qualityTags);
  assert.equal(r.catalog()[0].quality, 'unverified');
  assert.equal(r.catalog()[0].verification.conformance.status, 'failed');
  const resolver = new CapabilityResolver(r, { clock: () => NOW });
  const plan = resolver.resolve(profileFor(m.providerId), request()).plan;
  assert.equal(plan.status, 'ready');
  assert.equal(plan.selectedProviders[0].providerId, m.providerId);
  const run = await r.executeStage({ plan, stageId: plan.stageGraph[0].stageId, ledger: new BudgetLedger(plan.budgetSnapshot) });
  assert.equal(run.status, 'complete');
  assert.equal(run.output.fitted, true);
});

for (const modelAssets of [[ASSET], []]) {
  test(`failed smoke stays unavailable with ${modelAssets.length ? 'model weights' : 'no model weights'}`, async () => {
    const r = registry();
    const m = manifest(undefined, { modelAssets, verification: { smoke: proof({ status: 'failed' }), conformance: proof() } });
    let calls = 0;
    const a = adapter(async () => { calls++; return { available: true }; });
    const registered = r.register(m, a, { installation: 'installed', enabled: true });
    assert.equal(registered.availability, 'unavailable');
    assert.equal(registered.reason, 'local-smoke-failed');
    assert.equal(registered.quality, 'unverified');
    const health = await r.health(m.providerId);
    assert.equal(health.availability, 'unavailable');
    assert.equal(health.reason, 'local-smoke-failed');
    assert.equal(calls, 0);
  });
}

test('verified quality requires complete smoke and conformance proof', async () => {
  const r = registry();
  const m = manifest();
  const health = await ready(r, m);
  assert.equal(health.availability, 'available');
  assert.equal(health.quality, 'verified');
  const plan = new CapabilityResolver(r, { clock: () => NOW }).resolve(profileFor(m.providerId), request({ qualityTarget: 'verified' })).plan;
  assert.equal(plan.status, 'ready');
});

for (const stage of ['smoke', 'conformance']) {
  for (const [gap, overrides] of [['not-run', { status: 'not-run' }], ['missing evidence', { evidenceRefs: [] }], ['missing time', { checkedAt: null }]]) {
    test(`${stage} ${gap} reduces quality without blocking health`, async () => {
      const r = registry();
      const m = manifest(undefined, { verification: { smoke: proof(), conformance: proof(), [stage]: proof(overrides) } });
      const health = await ready(r, m);
      assert.equal(health.availability, 'available');
      assert.equal(health.quality, 'unverified');
      assert.equal(health.reason, null);
    });
  }
}

const blocked = [
  { label: 'planned support', overrides: { support: 'planned' }, reason: 'provider-planned' },
  { label: 'missing installation', registration: { installation: 'not-installed' }, reason: 'provider-not-installed' },
  { label: 'disabled provider', registration: { enabled: false }, reason: 'provider-disabled' },
  { label: 'unsupported platform', overrides: { runtime: { platforms: ['win32'] } }, reason: 'platform-unsupported' },
  { label: 'missing adapter', noAdapter: true, reason: 'runtime-not-found' },
  ...['sha256', 'downloadBytes', 'installedBytes', 'modelVersion'].map(field => ({ label: `missing weight ${field}`, overrides: { modelAssets: [{ ...ASSET, [field]: null }] }, reason: 'model-asset-missing' })),
  { label: 'unknown weight license', overrides: { modelAssets: [{ ...ASSET, licenseId: 'unknown' }] }, reason: 'model-asset-missing' },
  { label: 'unknown resource', overrides: { resources: { ...RESOURCES, minRamBytes: null } }, reason: 'resource-not-probed' },
  { label: 'missing dependency lock', overrides: { runtime: { dependencyLockSha256: null } }, reason: 'resource-not-probed' },
];
for (const scenario of blocked) {
  test(`${scenario.label} still blocks despite verified proof`, async () => {
    const r = registry();
    const m = manifest(undefined, scenario.overrides);
    let calls = 0;
    const a = adapter(async () => { calls++; return { available: true }; });
    const registered = r.register(m, scenario.noAdapter ? null : a, { installation: 'installed', enabled: true, ...scenario.registration });
    assert.equal(registered.availability, 'unavailable');
    assert.equal(registered.reason, scenario.reason);
    const health = await r.health(m.providerId);
    assert.equal(health.availability, 'unavailable');
    assert.equal(health.reason, scenario.reason);
    assert.equal(calls, 0);
  });
}

for (const reason of ['dependency-missing', 'device-unavailable', 'license-not-satisfied']) {
  test(`adapter health ${reason} still blocks independently of quality`, async () => {
    const r = registry();
    const m = manifest();
    r.register(m, adapter(async () => ({ available: false, reason })), { installation: 'installed', enabled: true });
    const health = await r.health(m.providerId);
    assert.equal(health.availability, 'unavailable');
    assert.equal(health.reason, reason);
    assert.equal(health.quality, 'verified');
    const plan = new CapabilityResolver(r, { clock: () => NOW }).resolve(profileFor(m.providerId), request()).plan;
    assert.equal(plan.status, 'blocked');
    assert.equal(plan.unresolved[0].reason, reason);
  });
}

test('soft ranking prefers verified over cheaper unverified, while explicit priority remains first', async () => {
  const r = registry();
  const unverified = manifest('geometry.a-cheap', { verification: { smoke: proof(), conformance: proof({ status: 'failed' }) } });
  const verified = manifest('geometry.z-verified', {}, { estimate: usage(10) });
  await ready(r, unverified);
  await ready(r, verified);
  const resolver = new CapabilityResolver(r, { clock: () => NOW });
  const profile = profileFor(unverified.providerId, verified.providerId);
  assert.equal(resolver.resolve(profile, request()).plan.selectedProviders[0].providerId, verified.providerId);
  const preferred = { ...profile, providerPriority: [unverified.providerId] };
  assert.equal(resolver.resolve(preferred, request()).plan.selectedProviders[0].providerId, unverified.providerId);
  assert.equal(resolver.resolve(preferred, request({ qualityTarget: 'verified' })).plan.selectedProviders[0].providerId, verified.providerId);
});

test('hard verified quality rejects available degraded providers, including explicit pins', async () => {
  const r = registry();
  const m = manifest(undefined, { verification: { smoke: proof(), conformance: proof({ status: 'failed' }) } }, { limitations: ['renderer-not-validated'] });
  await ready(r, m);
  const resolver = new CapabilityResolver(r, { clock: () => NOW });
  const profile = profileFor(m.providerId);
  for (const p of [profile, { ...profile, providerPins: [{ capabilityId: CAPABILITY, providerId: m.providerId }] }]) {
    const plan = resolver.resolve(p, request({ qualityTarget: 'verified' })).plan;
    assert.equal(plan.status, 'blocked');
    assert.deepEqual(plan.selectedProviders, []);
    assert.equal(plan.unresolved[0].reason, 'provider-quality-unverified');
  }
});
