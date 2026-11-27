import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { createBlenderEnvironmentEntry, createBlenderCoordinator, BLENDER_TOOL_OPERATIONS } from '../../targets/three-d/environment.js';
import { createBlenderTools, blenderExecutionClassFor } from '../../targets/three-d/tools.js';
import { createEnvironmentDirectory, ENVIRONMENT_CAPABILITIES, AdapterError, ERROR_TAXONOMY } from '../../core/index.js';
import { createCrossEnvironment } from '../../integration/cross-environment.js';
import { createToolDisclosure, BLENDER_TOOL_GROUPS } from '../../integration/tool-disclosure.js';
import { TOOL_NAMES, toolDefinitions, blenderManifest, validateToolInput, validateToolOutput } from '../../tools/blender/schema.js';
import { createBlenderViewport } from '../../targets/three-d/runtime.js';

const live = { targetId: 'target_fixture', generation: 1 };
const write = { ...live, expectSceneRevision: 0, leaseId: 'lease_test', expectControlRevision: 1, idemKey: 'request_1', grantId: 'grant_test' };
const ops = [{ opId: 'collection.ensure', opVersion: 1, stepId: 'ensure', args: { sceneId: 'scn_test' } }];
const samples = {
  blender_tools: { action: 'status' }, blender_capabilities: { action: 'status' },
  blender_control: { action: 'status', resource: 'scene' }, blender_project: { action: 'list' },
  blender_scene_query: { action: 'query', live, kind: 'scene' },
  blender_scene_apply: { action: 'apply', mode: 'plan', ...live, ops },
  blender_view: { action: 'get', live }, blender_capture: { action: 'capture', ...live, source: 'agentView' },
  blender_verify: { action: 'verify', source: 'live', ...live, assertions: [{ id: 'exists', kind: 'exists', subject: 'obj_test', expected: true }] },
  blender_reference_analyze: { action: 'analyze', references: [{ sourceId: 'src_test' }], grantId: 'grant_test' },
  blender_spec_revision: { action: 'get', sceneId: 'scn_test' }, blender_spec_apply: { action: 'apply', mode: 'plan', ...live, scene: {} },
  blender_job: { action: 'status', jobId: 'job_test' },
};

test('all 13 SSOT input schemas accept legal samples and reject additionalProperties and invalid discriminators', () => {
  for (const name of TOOL_NAMES) {
    assert.equal(validateToolInput(name, samples[name]).valid, true, name);
    assert.equal(validateToolInput(name, { ...samples[name], injectedField: true }).valid, false, name);
    assert.equal(validateToolInput(name, { ...samples[name], action: 'execute_python' }).valid, false, name);
  }
  assert.equal(validateToolInput('blender_scene_query', { ...samples.blender_scene_query, live: { ...live, extra: 1 } }).valid, false);
});

test('manifest, operation table, contracts and disclosure use the same fine capability IDs', () => {
  const capabilitySet = new Set(ENVIRONMENT_CAPABILITIES['three-d']);
  for (const tool of blenderManifest.tools) {
    for (const action of tool.actions) assert.ok(capabilitySet.has(action.capabilityId), `${tool.toolName}.${action.action}: ${action.capabilityId}`);
    assert.equal(BLENDER_TOOL_OPERATIONS[tool.toolName].capability, tool.actions[0].capabilityId);
  }
  const disclosed = new Set(['blender_tools', 'blender_capabilities', ...Object.values(BLENDER_TOOL_GROUPS).flatMap(group => group.tools)]);
  assert.deepEqual([...disclosed].sort(), [...TOOL_NAMES].sort());
  console.log('CAPABILITY_ID_ALIGNMENT: manifest=contracts=operation/disclosure directory; 13 tools / 11 declared capabilities');
  assert.equal(blenderExecutionClassFor('blender_view', { action: 'get' }), 'blender-main-read');
  assert.equal(blenderExecutionClassFor('blender_view', { action: 'set' }), 'blender-view-write');
  assert.equal(blenderExecutionClassFor('blender_scene_apply', { action: 'apply', mode: 'plan' }), 'blender-main-read');
  for (const error of blenderManifest.errorCodes.slice(0, 21)) assert.deepEqual(ERROR_TAXONOMY[error.code], [error.category, error.retryable]);
});

function fixture() {
  let connected = true, runtimeGeneration = 'a'.repeat(32), time = Date.now();
  const calls = [];
  const viewport = { status: () => ({ connection: { connected, runtimeGeneration, hello: connected ? { version: '5.3.0' } : null } }),
    probe: async () => ({ available: true, compatible: true, version: '5.3.0' }),
    command: async request => { calls.push(request); return request.op === 'scene.query' ? { objects: [] } : request.op === 'scene.apply' ? { results: request.payload.ops.map(op => ({ opId: op.opId })) } : { rotation: [1, 0, 0, 0], distance: 5, projection: 'PERSP' }; } };
  const context = { owner: 'session_a', workspaceKey: 'workspace:test' };
  const coordinator = createBlenderCoordinator({ getViewport: () => viewport, now: () => time });
  const record = coordinator.record(context);
  const tools = new Map(createBlenderTools({ getViewport: () => viewport, coordinator, resolveContext: async () => context }).map(tool => [tool.name, tool]));
  const invoke = (name, args) => tools.get(name).execute(args, {});
  const acquire = (resource = 'scene', owner = context) => {
    const status = coordinator.control({ action: 'status', resource }, owner, record);
    const lease = coordinator.control({ action: 'acquire', resource, grantId: status.challenge.grantId }, owner, record);
    return { targetId: record.targetId, generation: record.generation, grantId: status.challenge.grantId, leaseId: lease.leaseId, expectControlRevision: lease.controlRevision, expectSceneRevision: record.sceneRevision, idemKey: 'write_1' };
  };
  return { viewport, coordinator, record, context, invoke, acquire, calls, tools, cold() { connected = false; runtimeGeneration = null; }, expire() { time += 400000; }, restart() { runtimeGeneration = 'b'.repeat(32); coordinator.record(context); } };
}

test('cold capabilities/tools and cold scene reads cannot launch a Blender process', async () => {
  let spawns = 0, probes = 0;
  const viewport = createBlenderViewport({ blenderExecutable: process.execPath, spawnProcess() { spawns++; throw Error('GUI launch forbidden'); }, execFile(_path, args, _options, callback) { probes++; assert.deepEqual(args, ['--version']); callback(null, 'Blender 5.3.0', ''); } });
  const context = { owner: 'cold', workspaceKey: 'workspace:cold' };
  const snapshot = { environment: 'three-d', provider: 'blender' };
  const disclosure = createToolDisclosure({ snapshotForAgent: () => snapshot, environmentAdmitted: () => true, scopeVisible: () => true, ErrorClass: AdapterError });
  const entry = createBlenderEnvironmentEntry({ viewport, resolveContext: async () => context, getDisclosure: () => disclosure });
  const tools = new Map(entry.tools.map(tool => [tool.name, tool]));
  const caps = await tools.get('blender_capabilities').execute({ action: 'status' });
  assert.equal(caps.data.observed, null); assert.equal(caps.data.readiness.dependency.status, 'ok');
  const result = await tools.get('blender_tools').execute({ action: 'status' }, { agent: { id: 'cold' } });
  assert.deepEqual(result.data.availableTools.sort(), ['blender_capabilities', 'blender_tools']);
  await assert.rejects(tools.get('blender_scene_query').execute(samples.blender_scene_query), { code: 'GENERATION_MISMATCH' });
  assert.equal(probes, 1); assert.equal(spawns, 0);
  await viewport.dispose();
});

test('write guards independently enforce grants, leases, revisions, identity, expiry and idempotency', async () => {
  const f = fixture(); const w = f.acquire();
  const attempt = changed => f.coordinator.begin({ ...w, ...changed }, f.context, f.record, 'scene');
  assert.throws(() => attempt({ grantId: undefined }), { code: 'AUTHORIZATION_REQUIRED' });
  assert.throws(() => attempt({ grantId: 'fabricated' }), { code: 'GRANT_INVALID' });
  assert.throws(() => attempt({ leaseId: undefined }), { code: 'LEASE_REQUIRED' });
  assert.throws(() => attempt({ leaseId: 'foreign' }), { code: 'LEASE_LOST' });
  assert.throws(() => attempt({ generation: 999 }), { code: 'GENERATION_MISMATCH' });
  assert.throws(() => attempt({ expectSceneRevision: 999 }), { code: 'REVISION_CONFLICT' });
  assert.throws(() => attempt({ expectControlRevision: 999 }), { code: 'LEASE_LOST' });
  assert.throws(() => f.coordinator.assertGrant(w.grantId, { ...f.context, owner: 'session_b' }, f.record, 'scene'), { code: 'GRANT_SCOPE_MISMATCH' });
  assert.throws(() => f.coordinator.assertGrant(w.grantId, { ...f.context, workspaceKey: 'workspace:other' }, f.record, 'scene'), { code: 'GRANT_SCOPE_MISMATCH' });
  assert.throws(() => f.coordinator.assertGrant(w.grantId, f.context, f.record, 'view'), { code: 'GRANT_SCOPE_MISMATCH' });
  const token = attempt({}); f.coordinator.finish(token, { ok: true }); f.record.sceneRevision++;
  assert.deepEqual(attempt({}).replay, { ok: true });
  assert.throws(() => attempt({ expectSceneRevision: 1 }), { code: 'IDEMPOTENCY_CONFLICT' });
  f.expire(); assert.throws(() => attempt({}), { code: 'GRANT_EXPIRED' });
  assert.equal(f.calls.length, 0);
});

test('control renew/release advances revisions and isolates owners; runtime replacement invalidates tokens', () => {
  const f = fixture(); const w = f.acquire();
  assert.throws(() => f.acquire('scene', { ...f.context, owner: 'other' }), { code: 'BUSY' });
  const renewed = f.coordinator.control({ action: 'renew', resource: 'scene', leaseId: w.leaseId, expectControlRevision: w.expectControlRevision }, f.context, f.record);
  assert.equal(renewed.controlRevision, w.expectControlRevision + 1);
  assert.throws(() => f.coordinator.begin(w, f.context, f.record, 'scene'), { code: 'LEASE_LOST' });
  const released = f.coordinator.control({ action: 'release', resource: 'scene', leaseId: w.leaseId, expectControlRevision: renewed.controlRevision }, f.context, f.record);
  assert.equal(released.controlRevision, renewed.controlRevision + 1);
  assert.throws(() => f.coordinator.begin({ ...w, expectControlRevision: released.controlRevision }, f.context, f.record, 'scene'), { code: 'LEASE_LOST' });
  f.restart(); assert.throws(() => f.coordinator.assertGrant(w.grantId, f.context, f.record, 'scene'), { code: 'GENERATION_MISMATCH' });
});

test('plan/apply sends only scene.apply batches of at most 32 and replays without duplicate effects', async () => {
  const f = fixture(); const w = f.acquire();
  const manyOps = Array.from({ length: 33 }, (_, index) => ({ ...ops[0], stepId: `step_${index}` }));
  const planArgs = { action: 'apply', mode: 'plan', targetId: w.targetId, generation: w.generation, ops: manyOps };
  const plan = await f.invoke('blender_scene_apply', planArgs);
  assert.equal(f.calls.length, 0);
  const args = { ...planArgs, ...w, mode: 'apply', planId: plan.data.planId, approvalGrantId: w.grantId };
  const result = await f.invoke('blender_scene_apply', args);
  assert.equal(result.effectState, 'committed'); assert.equal(result.data.steps.length, 33);
  assert.deepEqual(f.calls.map(call => [call.op, call.payload.ops.length]), [['scene.apply', 32], ['scene.apply', 1]]);
  assert.deepEqual(Object.keys(f.calls[0].payload.ops[0]).sort(), ['args', 'opId']);
  assert.deepEqual(await f.invoke('blender_scene_apply', args), result); assert.equal(f.calls.length, 2);
});

test('invalid schemas fail before any context lookup and unsupported actions emit no invented op', async () => {
  let lookups = 0;
  const tools = createBlenderTools({ resolveContext: async () => { lookups++; return null; } });
  await assert.rejects(tools.find(tool => tool.name === 'blender_scene_query').execute({ ...samples.blender_scene_query, python: 'x' }), error => error.code === 'SCHEMA_INVALID' && Array.isArray(error.details.errors));
  assert.equal(lookups, 0);
  const f = fixture();
  await assert.rejects(f.invoke('blender_job', samples.blender_job), { code: 'TARGET_GONE', retryable: true });
  assert.equal(f.calls.length, 0);
});

test('environment directory provides compatible lazy adapters and no second runtime pool', async () => {
  const f = fixture(); const directory = createEnvironmentDirectory();
  const entry = createBlenderEnvironmentEntry({ viewport: f.viewport }); directory.register(entry);
  assert.equal(directory.peek('three-d'), null);
  const implementation = directory.instance('three-d');
  assert.equal(implementation.targetAdapter.manifest.contractVersion, 1);
  assert.equal(implementation.p0Provider.manifest.class, 'p0');
  assert.equal(implementation.capabilityAdapter.manifest.operations.length, 13);
  assert.equal(f.calls.length, 0); await directory.dispose();
});

test('cross-environment declaration/admission, when predicates and groups honor both switches and current environment', async () => {
  const directoryPath = await mkdtemp(join(tmpdir(), 'blender-tools-'));
  const environments = createEnvironmentDirectory();
  const fixtureEntry = createBlenderEnvironmentEntry({ viewport: fixture().viewport });
  environments.register(fixtureEntry);
  const ce = createCrossEnvironment({ ctx: {}, registry: {}, BrowserError: AdapterError, environments, env: { DSH_UI_TESTING_CONFIG_DIR: directoryPath, DSH_UI_TESTING_TEST_HOOKS: '1' } });
  try {
    const store = ce.configStore;
    assert.ok(store, 'fixture needs configStore access');
    const setConfig = (enabled = true, providerEnabled = true, environment = 'three-d') => {
      const config = store.getConfig();
      config.global.environment = environment;
      config.global.view = environment;
      config.global.enabledEnvironments = enabled ? ['web', 'three-d'] : ['web'];
      config.global.environments['three-d'] = { enabled, targetId: null, providers: { blender: { enabled: providerEnabled } } };
      store.write({ expectedRevision: config.revision, scope: 'global', patch: config.global });
    };
    setConfig();
    assert.equal([...ce.declarableToolNames()].filter(name => name.startsWith('blender_')).length, 13);
    assert.equal([...ce.admissibleToolNames()].filter(name => name.startsWith('blender_')).length, 13);
    const agent = { id: 'surface' };
    const disclosure = createToolDisclosure({ snapshotForAgent: agent => ce.snapshotForAgent(agent), environmentAdmitted: (agent, name) => ce.toolAdmitted(agent, name), scopeVisible: () => true, ErrorClass: AdapterError });
    const when = name => ce.toolAdmitted(agent, name) && disclosure.disclosed(agent, name);
    assert.deepEqual(TOOL_NAMES.filter(when).sort(), ['blender_capabilities', 'blender_tools']);
    disclosure.execute({ action: 'activate', groups: ['scene'] }, agent);
    assert.deepEqual(TOOL_NAMES.filter(when).sort(), ['blender_capabilities', 'blender_tools', ...BLENDER_TOOL_GROUPS.scene.tools].sort());
    assert.ok(when('blender_job'));
    assert.throws(() => disclosure.execute({ action: 'activate', groups: ['basic'] }, agent));
    setConfig(true, true, 'web');
    assert.equal([...ce.admissibleToolNames()].filter(name => name.startsWith('blender_')).length, 0);
    assert.deepEqual(TOOL_NAMES.filter(when), []);
    setConfig(true, false);
    assert.equal([...ce.declarableToolNames()].filter(name => name.startsWith('blender_')).length, 0);
    setConfig(false);
    assert.equal([...ce.declarableToolNames()].filter(name => name.startsWith('blender_')).length, 0);
  } finally { await ce.dispose(); await rm(directoryPath, { recursive: true, force: true }); }
});
