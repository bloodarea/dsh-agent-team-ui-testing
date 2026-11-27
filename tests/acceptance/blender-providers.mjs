import test from 'node:test';
import assert from 'node:assert/strict';
import {
  ProviderRegistry, CapabilityResolver, BudgetLedger, AgentProviderAdapter, IndependentReviewSession,
  createManifest, createCapabilityDescriptor, createProfile, registerPlannedModels, PLANNED_MODEL_MANIFESTS,
  validate, validateManifest, assertContract, sha256, intersectBudgets,
  validateObservation, verifyArtifacts, createCacheKey, validateCacheHit, observationToEvidence,
} from '../../targets/three-d/providers/index.js';

const H = sha256('input');
const zeroUsage = (extra = {}) => ({ requestCount: 0, inputTokens: 0, outputTokens: 0, actualMoney: 0, currency: 'USD', ramPeakBytes: 0, vramPeakBytes: 0, diskBytes: 0, cpuMs: 0, gpuMs: 0, wallMs: 1, outputBytes: 0, metering: 'measured', ...extra });
const inputRef = { artifactId: 'art-input', sha256: H, frameIndex: null, regionId: null };
const task = (required = ['geometry.primitive.fit'], extra = {}) => ({ taskId: 'task-test', requiredCapabilities: required, preferredCapabilities: [], optionalCapabilities: [], qualityTarget: 'standard', inputArtifactIds: [], acceptanceProfileId: 'prop.basic', ...extra });
function manifest(providerId = 'geometry.test', options = {}) {
  return createManifest(providerId, [createCapabilityDescriptor('geometry.primitive.fit', { inputSchemaRef: 'test.input.v1', outputSchemaRef: 'test.output.v1', operationTier: 'T3', estimate: zeroUsage(), ...options.capability })], { support: 'supported', providerType: 'geometry', resources: { minRamBytes: 0, estimatedPeakRamBytes: 0, minVramBytes: 0, estimatedPeakVramBytes: 0, requiredDiskBytes: 0 }, ...options.manifest });
}
function adapter(overrides = {}) {
  return { async health() { return { available: true }; }, async preflight() { return { ready: true, estimate: zeroUsage() }; }, async execute() { return { output: { fitted: true }, usage: zeroUsage() }; }, async cancel() {}, async dispose() {}, ...overrides };
}
async function setup({ m = manifest(), a = adapter() } = {}) {
  const registry = new ProviderRegistry({ outputValidators: { 'test.output.v1': output => output?.fitted === true } });
  registry.register(m, a, { installation: 'bundled', enabled: true }); await registry.health(m.providerId);
  const profile = createProfile('economy', { enabledProviderIds: [m.providerId] });
  return { registry, profile, resolver: new CapabilityResolver(registry) };
}
const errorReason = reason => error => error?.details?.reason === reason;

test('closed schema rejects unknown fields, invalid IDs, versions, negative budgets and invalid UTC dates', () => {
  const m = manifest(); assert.equal(validate('providerManifest', m).valid, true);
  for (const bad of [{ ...m, surprise: true }, { ...m, providerId: 'Unsafe/Path' }, { ...m, contractVersion: 2 }]) assert.equal(validate('providerManifest', bad).valid, false);
  assert.equal(validate('budget', { maxRemoteRequests: -1 }).valid, false);
  assert.equal(validate('budget', { maxRamBytes: Infinity }).valid, false);
  assert.equal(validate('capabilityProfile', { ...createProfile(), hiddenPolicy: true }).valid, false);
  const unknown = manifest('geometry.unknown', { capability: { capabilityId: 'future.custom.capability' } });
  assert.equal(validateManifest(unknown).diagnostics[0].reason, 'unknown-provider-capability');
});

test('remaining planned candidates stay cold and unavailable', async () => {
  const registry = new ProviderRegistry(); registerPlannedModels(registry);
  assert.deepEqual(registry.list().map(p => p.providerId).sort(), PLANNED_MODEL_MANIFESTS.map(p => p.providerId).sort());
  if (PLANNED_MODEL_MANIFESTS.length === 0) { console.log('NO_PLANNED_CANDIDATES_LEFT'); assert.ok(true); }
  for (const p of registry.list()) {
    assert.equal(p.support, 'planned'); assert.equal(p.availability, 'unavailable'); assert.equal(p.installation, 'not-installed');
    registry.enable(p.providerId); const health = await registry.health(p.providerId);
    assert.equal(health.availability, 'unavailable'); assert.equal(health.reason, 'provider-planned');
    assert.ok(p.manifest.modelAssets.every(a => a.sha256 === null && a.downloadBytes === null));
  }
  assert.equal(registry.catalog().some(c => c.capabilityId === 'vision.depth.metric'), false);
});

test('registry registration never invokes entrypoint or health and reports independent state axes', async () => {
  let calls = 0;
  const registry = new ProviderRegistry();
  const m = manifest('geometry.cold', { manifest: { runtime: { ...manifest().runtime, entrypoint: '../../malicious.js' } } });
  registry.register(m, adapter({ async health(ctx) { calls++; assert.equal(ctx.cold, true); return { available: true }; } }), { installation: 'bundled', enabled: true });
  assert.equal(calls, 0); assert.equal(registry.get(m.providerId).availability, 'not-probed');
  await registry.health(m.providerId); assert.equal(calls, 1);
  assert.equal(registry.get(m.providerId).availability, 'available'); assert.equal(registry.get(m.providerId).quality, 'unverified');
  await registry.disable(m.providerId); assert.equal(registry.get(m.providerId).enabled, false); assert.equal(registry.get(m.providerId).availability, 'unavailable');
});

test('missing smoke proof stays unverified and unprobed until health; platform failure stays unavailable', async () => {
  const base = manifest();
  const asset = { assetId: 'weights', required: true, modelVersion: 'v1', sha256: H, downloadBytes: 1, installedBytes: 1, licenseId: 'MIT' };
  const registry = new ProviderRegistry();
  const m = manifest('geometry.model', { manifest: { modelAssets: [asset], resources: { minRamBytes: 1, estimatedPeakRamBytes: 1, minVramBytes: 0, estimatedPeakVramBytes: 0, requiredDiskBytes: 1 }, runtime: { ...base.runtime, dependencyLockSha256: H } } });
  registry.register(m, adapter(), { installation: 'installed', enabled: true });
  assert.equal(registry.get(m.providerId).availability, 'not-probed');
  assert.equal(registry.get(m.providerId).quality, 'unverified');
  const checked = await registry.health(m.providerId);
  assert.equal(checked.availability, 'available'); assert.equal(checked.reason, null); assert.equal(checked.quality, 'unverified');
  const other = manifest('geometry.platform', { manifest: { runtime: { ...base.runtime, platforms: ['nonexistent'] } } });
  registry.register(other, adapter(), { installation: 'bundled', enabled: true });
  assert.equal((await registry.health(other.providerId)).reason, 'platform-unsupported');
});

test('resolver freezes all three orthogonal routes and deterministic hashes without linear tier prerequisites', async () => {
  const { resolver, profile } = await setup();
  const { plan } = resolver.resolve(profile, task([], { requiredCapabilities: ['geometry.primitive.fit'], routes: [{ capabilityId: 'geometry.primitive.fit', operationTier: 'T3' }] }));
  assert.equal(plan.status, 'ready'); assert.equal(plan.stageGraph.length, 1);
  assert.equal(plan.stageGraph[0].operationTier, 'T3'); assert.equal(plan.stageGraph[0].capabilityId, 'geometry.primitive.fit'); assert.equal(plan.stageGraph[0].providerId, 'geometry.test');
  assert.ok(Object.isFrozen(plan.stageGraph[0])); assert.throws(() => { plan.budgetSnapshot.maxRemoteRequests = 99; }, TypeError);
  const { planHash, ...body } = plan; assert.equal(planHash, sha256(body));
  const next = resolver.resolve(profile, task(), { previousPlan: plan, revisionReason: 'user-reroute' }).plan;
  assert.equal(next.revision, 1); assert.equal(next.previousPlanHash, plan.planHash); assert.notEqual(next.planHash, plan.planHash);
});

test('profile names never elevate tiers, privacy, providers or hard budgets; unknown config is retained', async () => {
  const { resolver, profile } = await setup();
  const denied = createProfile('advanced', { enabledProviderIds: ['geometry.test', 'unknown.future'], disabledProviderIds: ['geometry.test'] });
  const result = resolver.resolve(denied, task()); assert.equal(result.plan.status, 'blocked'); assert.equal(result.code, 'CAPABILITY_POLICY_CONFLICT'); assert.equal(result.diagnostics[0].reason, 'unknown-provider');
  assert.equal(denied.enabledProviderIds.includes('unknown.future'), true);
  assert.equal(resolver.resolve(createProfile('economy', { ...profile, operationTierPolicy: { allowedTiers: ['T1'], preferredTiers: [], allowSkip: true } }), task()).plan.status, 'blocked');
  assert.equal(intersectBudgets({ maxRemoteRequests: 0, maxWallMs: 10 }, { maxRemoteRequests: 100, maxWallMs: 1000 }).maxRemoteRequests, 0);
  assert.throws(() => intersectBudgets({ maxMoney: 1, currency: 'USD' }, { currency: 'EUR' }), errorReason('currency-policy-conflict'));
});

test('required missing blocks, optional degrades, ask-user pauses, relative depth never substitutes metric', async () => {
  const { resolver, profile } = await setup();
  assert.equal(resolver.resolve(profile, task(['vision.depth.metric'])).plan.status, 'blocked');
  const optional = task(undefined, { optionalCapabilities: ['vision.depth.metric'] });
  assert.equal(resolver.resolve(profile, optional).plan.status, 'ready');
  assert.equal(resolver.resolve({ ...profile, fallbackPolicy: 'ask-user' }, optional).plan.status, 'awaiting-user');
  assert.equal(resolver.resolve({ ...profile, fallbackPolicy: 'none' }, optional).plan.status, 'blocked');
});

test('resolver prefers explicit pin then priority; unavailable or unverified quality does not satisfy hard quality', async () => {
  const { registry, resolver, profile } = await setup();
  const m = manifest('geometry.second'); registry.register(m, adapter(), { installation: 'bundled', enabled: true }); await registry.health(m.providerId);
  const p = { ...profile, enabledProviderIds: ['geometry.test', 'geometry.second'], providerPriority: ['geometry.test'], providerPins: [{ capabilityId: 'geometry.primitive.fit', providerId: 'geometry.second' }] };
  assert.equal(resolver.resolve(p, task()).plan.selectedProviders[0].providerId, 'geometry.second');
  assert.equal(resolver.resolve(p, task(undefined, { qualityTarget: 'verified' })).plan.status, 'blocked');
});

test('input grants and stage DAG reject unauthorized assets and dependency cycles', async () => {
  const { resolver, profile } = await setup();
  const request = task(undefined, { inputArtifactIds: [inputRef.artifactId] });
  assert.throws(() => resolver.resolve(profile, request, { inputRefs: [inputRef] }), errorReason('input-artifact-not-authorized'));
  const plan = resolver.resolve(profile, request, { inputRefs: [inputRef], validateInput: () => true }).plan;
  assert.equal(plan.stageGraph[0].inputRefs[0].sha256, H);
  assert.throws(() => resolver.resolve(profile, task(undefined, { stages: [{ stageId: 'loop', capabilityId: 'geometry.primitive.fit', dependencies: ['loop'], inputRefs: [], configSha256: sha256({}) }] })), errorReason('stage-dependency-cycle'));
});

test('budgets account for cumulative calls, concurrent memory, unknown usage and actual overruns', () => {
  const ledger = new BudgetLedger({ maxRemoteRequests: 1, maxRamBytes: 10, maxConcurrentProviders: 2 });
  ledger.reserve('a', zeroUsage({ requestCount: 1, ramPeakBytes: 6 }));
  assert.throws(() => ledger.reserve('b', zeroUsage({ ramPeakBytes: 5 })), errorReason('resource-budget-exceeded'));
  ledger.complete('a', zeroUsage({ requestCount: 1, ramPeakBytes: 6 }));
  assert.throws(() => ledger.reserve('b', zeroUsage({ requestCount: 1 })), errorReason('resource-budget-exceeded'));
  assert.throws(() => new BudgetLedger({ maxInputTokens: 1 }).reserve('unknown', { metering: 'not-metered' }), errorReason('resource-budget-exceeded'));
  const overrun = new BudgetLedger({ maxRemoteRequests: 1 }); overrun.reserve('r', zeroUsage());
  assert.throws(() => overrun.complete('r', zeroUsage({ requestCount: 2 })), errorReason('resource-budget-exceeded')); assert.equal(overrun.actual.requestCount, 2);
});

test('host execution checks plan binding, output schema, disable and resource ledger', async () => {
  const { registry, resolver, profile } = await setup(); const { plan } = resolver.resolve(profile, task());
  const run = await registry.executeStage({ plan, stageId: plan.stageGraph[0].stageId, ledger: new BudgetLedger(plan.budgetSnapshot) });
  assert.equal(run.output.fitted, true); assert.equal(registry.get('geometry.test').lifecycle, 'idle');
  await assert.rejects(registry.executeStage({ plan, stageId: 'not-in-plan', ledger: new BudgetLedger(plan.budgetSnapshot) }), errorReason('stage-not-in-plan'));
  await assert.rejects(registry.executeStage({ plan, stageId: plan.stageGraph[0].stageId, config: { changed: true }, ledger: new BudgetLedger(plan.budgetSnapshot) }), errorReason('plan-input-or-config-mismatch'));
  await registry.disable('geometry.test');
  await assert.rejects(registry.executeStage({ plan, stageId: plan.stageGraph[0].stageId, ledger: new BudgetLedger(plan.budgetSnapshot) }), errorReason('provider-disabled'));
});

test('timeout cancels only selected adapter, while another provider stays available', async () => {
  let cancelled = false;
  const { registry, resolver, profile } = await setup({ a: adapter({ async execute() { return new Promise(() => {}); }, async cancel() { cancelled = true; } }) });
  const other = manifest('geometry.other'); registry.register(other, adapter(), { installation: 'bundled', enabled: true }); await registry.health(other.providerId);
  const p = { ...profile, budget: { maxRemoteRequests: 0, maxWallMs: 20 } }; const plan = resolver.resolve(p, task()).plan;
  await assert.rejects(registry.executeStage({ plan, stageId: plan.stageGraph[0].stageId, ledger: new BudgetLedger(plan.budgetSnapshot) }), errorReason('provider-timeout'));
  assert.equal(cancelled, true); assert.equal(registry.get(other.providerId).availability, 'available');
});

function observationFixture(kind = 'relativeDepthRaster') {
  const bytes = Buffer.from('raster'); const digest = sha256(bytes);
  const product = { artifactId: 'art-product', sha256: digest, kind, encoding: 'npy', width: 1, height: 1, channels: 1, validityMaskArtifactId: null };
  const artifact = { contractVersion: 1, ...product, mime: 'application/octet-stream', byteLength: bytes.length, coordinateFrame: 'camera', units: 'normalized-relative-depth', transformChain: [], sourceDigests: [H], providerId: 'vision.test', runId: 'run-1', access: { workspaceId: 'ws', taskId: 'task-test', principalIds: ['human'], expiresAt: null }, createdAt: new Date().toISOString() };
  const observation = { contractVersion: 1, observationId: 'obs-1', taskId: 'task-test', runId: 'run-1', provider: { providerId: 'vision.test', implementationVersion: '1.0.0', modelVersion: null, weightsSha256: null }, capabilityId: 'vision.depth.relative', status: 'complete', inputs: [inputRef], coordinateFrame: 'camera', units: 'normalized-relative-depth', products: [product], proposals: [], metrics: [], resourceUsage: zeroUsage(), costActual: zeroUsage(), limitations: [], unresolved: [], createdAt: new Date().toISOString() };
  return { bytes, artifact, observation, scope: { workspaceId: 'ws', taskId: 'task-test', principalId: 'human' } };
}
test('observation contract checks units, provenance, masks, partial results and artifact digests', async () => {
  const { bytes, artifact, observation, scope } = observationFixture();
  assert.equal(validateObservation(observation, { inputRefs: [inputRef], artifactManifests: [artifact] }).status, 'complete');
  assert.throws(() => validateObservation({ ...observation, units: 'm' }, { artifactManifests: [artifact] }), errorReason('relative-depth-units-invalid'));
  assert.throws(() => validateObservation({ ...observation, status: 'partial' }, { artifactManifests: [artifact] }), errorReason('incomplete-observation-missing-limitations'));
  assert.throws(() => validateObservation(observationFixture('mesh').observation, { artifactManifests: [artifact] }), errorReason('capability-product-kind-mismatch'));
  assert.equal((await verifyArtifacts([artifact], { readArtifact: async () => bytes, scope })).verified, true);
  await assert.rejects(verifyArtifacts([artifact], { readArtifact: async () => Buffer.from('wrong'), scope }), errorReason('artifact-digest-mismatch'));
  await assert.rejects(verifyArtifacts([artifact], { readArtifact: async () => bytes, scope: { ...scope, principalId: 'intruder' } }), errorReason('artifact-access-denied'));
  await assert.rejects(verifyArtifacts([artifact], { readArtifact: async () => bytes, scope, maxOutputBytes: 1 }), errorReason('max-output-bytes-exceeded'));
});

test('cache isolates model, weights, configuration, ROI and device; hits revalidate ACL, expiry and digest', async () => {
  const { bytes, artifact, scope } = observationFixture();
  const options = { inputRefs: [inputRef], roi: null, frameRange: null, providerId: 'vision.test', implementationVersion: '1.0.0', modelVersion: null, weightsSha256: null, dependencyLockSha256: H, configSha256: H, deviceType: 'cpu', precision: 'fp32', seedPolicy: 'deterministic' };
  const key = createCacheKey(options);
  for (const [field, value] of [['deviceType', 'cuda'], ['weightsSha256', H], ['implementationVersion', '2.0.0'], ['roi', [0, 0, 1, 1]]]) assert.notEqual(createCacheKey({ ...options, [field]: value }), key);
  const entry = { key, artifactManifests: [artifact], expiresAt: null };
  assert.equal(await validateCacheHit(entry, { expectedKey: key, readArtifact: async () => bytes, scope }), true);
  assert.equal(await validateCacheHit(entry, { expectedKey: key, readArtifact: async () => Buffer.from('wrong'), scope }), false);
  assert.equal(await validateCacheHit({ ...entry, expiresAt: '2000-01-01T00:00:00Z' }, { expectedKey: key, scope }), false);
});

test('model evidence keeps source kinds and proposals pending, without direct SpecStore write', () => {
  const { observation } = observationFixture();
  const p = { targetHint: 'body', field: 'depth', value: 1, units: 'relative', origin: 'observed', confidence: null, uncertainty: 'scale', productIds: ['art-product'], evidenceIds: ['evidence-1'] };
  const evidence = observationToEvidence({ ...observation, proposals: [p] }, { configSha256: H, adapterVersion: '1.0.0' });
  assert.equal(evidence.proposals[0].origin, 'inferred'); assert.equal(evidence.proposals[0].review, 'pending'); assert.equal(evidence.artifactRefs[0].kind, 'relativeDepthRaster');
});

const roleRequest = () => ({ contractVersion: 1, roleId: 'vision_analyst', taskId: 'task-test', goal: 'Analyze shape', constraints: [], inputArtifactRefs: [], sourceArtifactRefs: [inputRef], whiteboxObservationHashes: [H], structuredContext: [{ field: 'length', value: 1 }, { field: 'hidden', value: 'remove' }], responseSchemaRef: 'agent-role-result.v1', budget: {}, privacyGrantRef: null, round: 1, peerResults: [] });
const roleResult = roleId => ({ contractVersion: 1, roleId, taskId: 'task-test', status: 'complete', summary: 'shape observed', proposals: [], evidenceRefs: ['evidence-1'], unknowns: ['occluded-back'], limitations: [], usage: zeroUsage({ requestCount: 1 }) });
test('independent review freezes identical original evidence, hides peer first round, and rejects duplicate first-round writes', () => {
  const session = new IndependentReviewSession({ analystBinding: { memberId: 'a', modelId: 'model-a' }, reviewerBinding: { memberId: 'b', modelId: 'model-b' }, request: roleRequest() });
  const { analyst, reviewer } = session.firstRoundRequests;
  assert.deepEqual(analyst.sourceArtifactRefs, reviewer.sourceArtifactRefs); assert.deepEqual(analyst.whiteboxObservationHashes, reviewer.whiteboxObservationHashes); assert.deepEqual(reviewer.peerResults, []);
  assert.equal(session.independent, true); assert.throws(() => session.reconciliationRequests(), errorReason('independent-first-round-incomplete'));
  session.recordFirstRound('analyst', roleResult('vision_analyst')); session.recordFirstRound('reviewer', roleResult('vision_reviewer'));
  assert.throws(() => session.recordFirstRound('analyst', roleResult('vision_analyst')), errorReason('first-round-result-immutable'));
  assert.equal(session.reconciliationRequests().requests.reviewer.round, 2);
  assert.equal(new IndependentReviewSession({ analystBinding: { memberId: 'a', modelId: 'same' }, reviewerBinding: { memberId: 'b', modelId: 'same' }, request: roleRequest() }).independent, false);
});

test('Agent adapter whitelists structure, binds role, requires live UI grants for images and preserves usage', async () => {
  let dispatched = 0, last;
  const binding = { memberId: 'a', modelId: 'model-a', estimate: zeroUsage({ requestCount: 1 }) };
  const agent = new AgentProviderAdapter({ providerId: 'agent.test', discover: async () => [binding], dispatch: async ({ request }) => { dispatched++; last = request; return roleResult(request.roleId); }, validateGrant: async () => true, structuredFieldWhitelist: ['length'] });
  const profile = createProfile('custom', { privacy: { allowRemoteInference: true, allowImageUploadToAgent: true }, budget: { maxRemoteRequests: 2 }, agentRoleBindings: { vision_analyst: 'a' } });
  const scope = { principalId: 'human', workspaceId: 'ws' };
  const request = roleRequest();
  const usage = new BudgetLedger(profile.budget);
  await agent.invokeRole(request, { profile, binding, scope, ledger: usage });
  assert.equal(last.structuredContext.length, 1); assert.equal(usage.actual.requestCount, 1);
  const imageRequest = { ...request, inputArtifactRefs: [inputRef], privacyGrantRef: 'grant-1', round: 2 };
  await assert.rejects(agent.invokeRole(imageRequest, { profile, binding, scope, ledger: usage }), errorReason('remote-inference-grant-required')); assert.equal(dispatched, 1);
  const grant = { grantId: 'grant-1', scope: 'artifact:remote-inference', issuer: 'human-ui', principalId: 'human', workspaceId: 'ws', taskId: 'task-test', providerId: 'agent.test', artifactIds: [inputRef.artifactId], allowedInputTypes: ['image'], expiresAt: '2099-01-01T00:00:00Z', retention: 'none' };
  await agent.invokeRole(imageRequest, { profile, binding, scope, grant, ledger: usage }); assert.equal(dispatched, 2);
  await assert.rejects(agent.invokeRole({ ...request, peerResults: ['peer conclusion'] }, { profile, binding, scope, ledger: usage }), errorReason('independent-first-round-peer-leak'));
});

test('executed stages cannot silently repeat or bypass declared dependencies', async () => {
  const base = manifest();
  const second = createCapabilityDescriptor('verification.geometry', { operationTier: 'T1', inputSchemaRef: 'test.input.v1', outputSchemaRef: 'test.output.v1', estimate: zeroUsage(), dependsOn: ['geometry.primitive.fit'] });
  const m = { ...base, capabilities: [...base.capabilities, second] };
  const { registry, resolver, profile } = await setup({ m });
  const plan = resolver.resolve(profile, task(['verification.geometry'])).plan;
  const dependent = plan.stageGraph.find(s => s.capabilityId === 'verification.geometry');
  const dependency = plan.stageGraph.find(s => s.capabilityId === 'geometry.primitive.fit');
  const ledger = new BudgetLedger(plan.budgetSnapshot);
  await assert.rejects(registry.executeStage({ plan, stageId: dependent.stageId, ledger }), errorReason('stage-dependency-incomplete'));
  await registry.executeStage({ plan, stageId: dependency.stageId, ledger });
  await assert.rejects(registry.executeStage({ plan, stageId: dependency.stageId, ledger }), errorReason('stage-already-started'));
  await registry.executeStage({ plan, stageId: dependent.stageId, ledger });
});

test('preflight is subject to task deadline and actual output envelopes obey hard byte limits', async () => {
  const slow = await setup({ a: adapter({ async preflight() { return new Promise(() => {}); } }) });
  const p = { ...slow.profile, budget: { maxRemoteRequests: 0, maxWallMs: 10 } };
  const plan = slow.resolver.resolve(p, task()).plan;
  await assert.rejects(slow.registry.executeStage({ plan, stageId: plan.stageGraph[0].stageId, ledger: new BudgetLedger(plan.budgetSnapshot) }), errorReason('provider-timeout'));
  const small = await setup();
  const tiny = small.resolver.resolve({ ...small.profile, budget: { maxOutputBytes: 1, maxRemoteRequests: 0 } }, task()).plan;
  const ledger = new BudgetLedger(tiny.budgetSnapshot);
  await assert.rejects(small.registry.executeStage({ plan: tiny, stageId: tiny.stageGraph[0].stageId, ledger }), errorReason('resource-budget-exceeded'));
  assert.ok(ledger.actual.outputBytes > 1);
});

test('remote role cannot enlarge user or task limits and a role round cannot silently repeat', async () => {
  let dispatched = 0;
  const binding = { memberId: 'a', modelId: 'model-a', estimate: zeroUsage({ requestCount: 1 }) };
  const agent = new AgentProviderAdapter({ providerId: 'agent.test', discover: async () => [binding], dispatch: async () => { dispatched++; return roleResult('vision_analyst'); }, validateGrant: async () => false });
  const profile = createProfile('custom', { privacy: { allowRemoteInference: true }, budget: { maxRemoteRequests: 1 }, agentRoleBindings: { vision_analyst: 'a' } });
  await assert.rejects(agent.invokeRole(roleRequest(), { profile, binding, ledger: new BudgetLedger({ maxRemoteRequests: 99 }) }), errorReason('agent-budget-policy-mismatch'));
  const ledger = new BudgetLedger(profile.budget);
  await agent.invokeRole(roleRequest(), { profile, binding, ledger });
  await assert.rejects(agent.invokeRole(roleRequest(), { profile, binding, ledger }), errorReason('duplicate-run-id'));
  assert.equal(dispatched, 1);
});
