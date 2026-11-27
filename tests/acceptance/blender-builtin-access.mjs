import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createBlenderViewport } from '../../targets/three-d/runtime.js';
import { createBlenderEnvironmentEntry, inspectBlenderBinding } from '../../targets/three-d/environment.js';
import { validateToolOutput } from '../../tools/blender/schema.js';
import { createHarness, createFakeConnectionService } from './harness.mjs';

const runtimeGeneration = 'a'.repeat(32);
const canonicalKey = 'workspace:fixture-a';
const panelKey = 'path:/fixture/workspace-a';
const secondKey = 'session:fixture-panel';
const foreignKey = 'workspace:fixture-b';

function fixture(keys = [panelKey], initialKey = canonicalKey) {
  let workspaceKey = initialKey;
  let spawnProcess = 0;
  const calls = [];
  const instances = new Map(keys.map((key, index) => [key, { pid: 10000 + index, connected: true }]));
  const viewport = {
    status(key) {
      const instance = instances.get(key);
      return { workspaceKey: key, state: instance?.connected ? 'running' : 'cold', pid: instance?.pid ?? null,
        internalToken: 'must-not-be-disclosed', projectPath: '/fixture/workspace-a/fixture.blend',
        connection: { connected: instance?.connected === true, runtimeGeneration: instance?.connected ? runtimeGeneration : null,
          hello: instance?.connected ? { version: '5.3.0' } : null } };
    },
    listRunning() { return [...instances].map(([key, value]) => ({ workspaceKey: key, ...value })).filter(item => item.connected); },
    probe: async () => ({ available: true, compatible: true, version: '5.3.0' }),
    async command(request, _signal, key) {
      if (!instances.get(key)?.connected) viewport.spawnProcess();
      assert.equal(instances.get(key)?.connected, true);
      calls.push({ key, request });
      if (request.op === 'scene.query') return { objects: [{ id: 'obj_fixture' }] };
      if (request.op === 'scene.apply') return { results: request.payload.ops.map(op => ({ opId: op.opId, status: 'applied' })) };
      if (request.op === 'view.get') return { rotation: [1, 0, 0, 0], distance: 5, projection: 'PERSP' };
      throw Error(`Unexpected command ${request.op}`);
    },
    frame() { throw Error('Frame dispatch forbidden in binding tests'); },
    spawnProcess() { spawnProcess++; throw Error('Blender launch forbidden'); },
  };
  const context = exec => ({ workspaceKey, workspaceId: 'fixture-a', workspaceRoot: null, owner: exec?.owner ?? 'fixture-agent-a' });
  const resolveInstanceWorkspace = async key => ({ workspaceId: [canonicalKey, panelKey, secondKey].includes(key) ? 'fixture-a' : 'fixture-b' });
  const entry = createBlenderEnvironmentEntry({ viewport, resolveContext: async exec => context(exec), resolveInstanceWorkspace });
  const tools = new Map(entry.tools.map(tool => [tool.name, tool]));
  const invoke = (name, args, exec = {}) => tools.get(name).execute(args, exec);
  const binding = async () => (await invoke('blender_capabilities', { action: 'status' })).data.readiness.connection.evidence.workspaceBinding;
  const live = async () => (await invoke('blender_project', { action: 'list' })).data.projects[0].live;
  const acquire = async resource => {
    const status = await invoke('blender_control', { action: 'status', resource });
    const grantId = status.data.challenge.grantId;
    const lease = await invoke('blender_control', { action: 'acquire', resource, grantId });
    return { grantId, leaseId: lease.data.leaseId, expectControlRevision: lease.data.controlRevision };
  };
  return { viewport, context, invoke, binding, live, acquire, calls, instances, entry,
    setKey(key) { workspaceKey = key; }, get spawns() { return spawnProcess; } };
}

const sceneQuery = live => ({ action: 'query', live, kind: 'scene' });
const placeholderLive = { targetId: `target_w${createHash('sha256').update(canonicalKey).digest('hex').slice(0, 24)}`, generation: 1 };

test('read-only real viewport inventory and status stay cold with spawnProcess=0', async () => {
  let spawns = 0;
  const viewport = createBlenderViewport({ spawnProcess() { spawns++; throw Error('Blender launch forbidden'); } });
  assert.deepEqual(viewport.listRunning(), []);
  assert.equal(viewport.status(canonicalKey).state, 'cold');
  assert.deepEqual(viewport.listRunning(), []);
  assert.equal(spawns, 0);
  await viewport.dispose();
  assert.equal(spawns, 0);
});

test('one proven same-workspace panel instance is reused for reads, and diagnostics print both keys', async () => {
  const f = fixture([panelKey, foreignKey]);
  const binding = await f.binding();
  assert.equal(binding.toolWorkspaceKey, canonicalKey);
  assert.equal(binding.requested.state, 'cold');
  assert.equal(binding.requested.connection.connected, false);
  assert.equal(binding.selectedWorkspaceKey, panelKey);
  assert.equal(binding.workspaceKeySource, 'panel-instance-reuse');
  assert.equal(binding.workspaceRootAvailable, false);
  assert.deepEqual(binding.candidates.map(item => item.workspaceKey), [panelKey]);
  assert.equal(JSON.stringify(binding).includes(foreignKey), false);
  assert.equal(JSON.stringify(binding).includes('must-not-be-disclosed'), false);
  const live = await f.live();
  const result = await f.invoke('blender_scene_query', sceneQuery(live));
  assert.equal(result.data.items[0].id, 'obj_fixture');
  const view = await f.invoke('blender_view', { action: 'get', live });
  assert.equal(view.data.view.distance, 5);
  assert.ok(f.calls.every(call => call.key === panelKey));
  assert.equal(f.spawns, 0);
  console.log('BINDING_DIAGNOSTIC_FIXTURE:', JSON.stringify(binding));
});

test('two same-workspace panel aliases refuse ambiguity and list only authorized candidates', async () => {
  const f = fixture([panelKey, secondKey, foreignKey]);
  await assert.rejects(f.invoke('blender_project', { action: 'list' }), error => {
    assert.equal(error.code, 'TARGET_NOT_BOUND');
    assert.deepEqual(error.details.candidates.map(item => item.workspaceKey), [panelKey, secondKey]);
    assert.equal(JSON.stringify(error.details).includes(foreignKey), false);
    return true;
  });
  const binding = await f.binding();
  assert.equal(binding.reason, 'ambiguous-instances');
  assert.equal(binding.selectedWorkspaceKey, null);
  assert.equal(f.calls.length, 0);
  assert.equal(f.spawns, 0);
});

test('zero running instances keeps TARGET_NOT_BOUND and never dispatches or starts Blender', async () => {
  const f = fixture([]);
  const live = await f.invoke('blender_control', { action: 'status', resource: 'scene' });
  assert.ok(live.data.challenge.grantId); // Cold control discovery remains supported.
  await assert.rejects(f.invoke('blender_scene_query', sceneQuery(placeholderLive)), { code: 'TARGET_NOT_BOUND' });
  assert.equal((await f.binding()).reason, 'no-running-instance');
  assert.equal(f.calls.length, 0);
  assert.equal(f.spawns, 0);
});

test('a globally unique foreign-workspace instance is never reused or disclosed', async () => {
  const f = fixture([foreignKey]);
  const binding = await f.binding();
  assert.deepEqual(binding.candidates, []);
  assert.equal(binding.selectedWorkspaceKey, null);
  const projects = await f.invoke('blender_project', { action: 'list' });
  assert.deepEqual(projects.data.projects, []);
  await assert.rejects(f.invoke('blender_scene_query', sceneQuery(placeholderLive)), { code: 'TARGET_NOT_BOUND' });
  assert.equal(JSON.stringify(binding).includes(foreignKey), false);
  assert.equal(f.calls.length, 0);
  assert.equal(f.spawns, 0);
});

test('an alias without authoritative workspace proof is never reused', async () => {
  const f = fixture();
  const binding = await inspectBlenderBinding(f.context({}), f.viewport);
  assert.deepEqual(binding.candidates, []);
  assert.equal(binding.selectedWorkspaceKey, null);
  assert.equal(f.spawns, 0);
});

test('direct key with no disk root preserves the same target across Agent sessions', async () => {
  const f = fixture([canonicalKey]);
  const before = await f.live();
  const other = await f.invoke('blender_project', { action: 'list' }, { owner: 'fixture-agent-b' });
  assert.deepEqual(other.data.projects[0].live, before);
  const caps = await f.invoke('blender_capabilities', { action: 'status' });
  assert.equal(validateToolOutput('blender_capabilities', caps).valid, true);
  assert.equal(caps.data.observed.workspaceBinding.toolWorkspaceKey, canonicalKey);
  assert.equal(caps.data.observed.workspaceBinding.selectedWorkspaceKey, canonicalKey);
  assert.equal(caps.data.observed.workspaceBinding.workspaceKeySource, 'session-workspace');
  assert.equal(caps.data.observed.workspaceBinding.workspaceRootAvailable, false);
  assert.equal(f.spawns, 0);
});

test('alias reuse retains target identity, scene/control revisions, plan and idempotency ledger', async () => {
  const f = fixture([panelKey], panelKey);
  const live = await f.live();
  const control = await f.acquire('scene');
  const ops = [{ opId: 'collection.ensure', opVersion: 1, stepId: 'ensure', args: { sceneId: 'scn_fixture' } }];
  const plan = await f.invoke('blender_scene_apply', { action: 'apply', mode: 'plan', ...live, ops });
  const request = { action: 'apply', mode: 'apply', ...live, ...control, expectSceneRevision: 0, idemKey: 'same-instance-write', approvalGrantId: control.grantId, planId: plan.data.planId, ops };
  const applied = await f.invoke('blender_scene_apply', request);
  assert.equal(applied.data.sceneRevision, 1);
  f.setKey(canonicalKey); // New session resolution, still the original panel instance.
  assert.deepEqual(await f.live(), live);
  const project = await f.invoke('blender_project', { action: 'status', live });
  assert.equal(project.data.sceneRevision, 1);
  const status = await f.invoke('blender_control', { action: 'status', resource: 'scene' });
  assert.equal(status.data.controlRevision, control.expectControlRevision);
  assert.equal(status.data.leaseId, control.leaseId);
  assert.deepEqual(await f.invoke('blender_scene_apply', request), applied);
  assert.equal(f.calls.filter(call => call.request.op === 'scene.apply').length, 1);
  assert.ok(f.calls.every(call => call.key === panelKey));
  assert.equal(f.spawns, 0);
});

test('counterexample: the old root gate discards even an exactly matching running key', async () => {
  const f = fixture([canonicalKey]);
  const entry = createBlenderEnvironmentEntry({ viewport: f.viewport, resolveContext: async exec => {
    const context = f.context(exec);
    return context.workspaceRoot ? context : null; // The original Host root gate.
  } });
  const control = entry.tools.find(tool => tool.name === 'blender_control');
  await assert.rejects(control.execute({ action: 'status', resource: 'scene' }, {}), { code: 'AUTHORIZATION_REQUIRED' });
  assert.equal((await f.binding()).selectedWorkspaceKey, canonicalKey);
  assert.ok((await f.invoke('blender_control', { action: 'status', resource: 'scene' })).data.challenge.grantId);
  assert.equal(f.spawns, 0);
});

test('counterexample: without inventory, a cold tool key cannot address the existing panel alias', async () => {
  const f = fixture();
  const { listRunning: _listRunning, ...withoutInventory } = f.viewport;
  const entry = createBlenderEnvironmentEntry({ viewport: withoutInventory, resolveContext: async exec => f.context(exec) });
  const query = entry.tools.find(tool => tool.name === 'blender_scene_query');
  await assert.rejects(query.execute(sceneQuery(placeholderLive), {}), { code: 'TARGET_NOT_BOUND' });
  assert.equal((await f.binding()).selectedWorkspaceKey, panelKey);
  assert.equal((await f.invoke('blender_scene_query', sceneQuery(await f.live()))).data.items.length, 1);
  assert.equal(f.spawns, 0);
});

test('rootless scene access does not authorize a project save without workspaceRoot', async () => {
  const f = fixture();
  const live = await f.live();
  const control = await f.acquire('project');
  await assert.rejects(f.invoke('blender_project', { action: 'save', write: { ...live, ...control, expectSceneRevision: 0, idemKey: 'rootless-save' }, expectedFileHash: '0'.repeat(64) }), { code: 'CAPABILITY_UNAVAILABLE' });
  assert.equal(f.calls.length, 0);
  assert.equal(f.spawns, 0);
});

test('real host keeps registry workspace context when session membership has no path/root fields', async () => {
  const peer = { id: 'builtin-access-fixture' };
  const memberIds = ['builtin-agent-a', 'builtin-agent-b'];
  const workspace = { id: 'builtin-rootless', sessionIds: memberIds };
  const workspaceRegistry = { list: () => [workspace], get: id => id === workspace.id ? workspace : null, resolveByPath: () => null };
  const harness = await createHarness({ workspaceRegistry, connection: createFakeConnectionService({ rejection: undefined, admit: () => ({ peer }), browserPeer: peer }) });
  try {
    const configured = await harness.request({ method: 'PUT', path: '/plugins/ui-testing/config', body: { expectedRevision: 0, scope: 'global', patch: {
      view: 'three-d', environment: 'three-d', enabledEnvironments: ['web', 'three-d'], environments: { 'three-d': { enabled: true, providers: { blender: { enabled: true } } } },
    } } });
    assert.equal(configured.statusCode, 200, configured.body);
    for (const id of memberIds) {
      const exec = { agent: { id, session: { header: { cwd: harness.workspaceDir } } }, signal: AbortSignal.timeout(30000) };
      const result = await harness.invoke('blender_control', { action: 'status', resource: 'scene' }, exec);
      assert.equal(result.ok, true, JSON.stringify(result.error));
      assert.ok(result.value.data.challenge.grantId);
      assert.equal(validateToolOutput('blender_control', result.value).valid, true);
    }
  } finally { await harness.dispose(); }
});
