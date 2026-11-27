import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { createBlenderCoordinator } from '../../targets/three-d/environment.js';
import { createBlenderTools } from '../../targets/three-d/tools.js';
import { createBlenderViewport } from '../../targets/three-d/runtime.js';

const workspaceA = 'workspace:isolation-a';
const workspaceB = 'workspace:isolation-b';
let spawns = 0;
const spawnProcess = () => { spawns++; throw new Error('Blender process launch forbidden in isolation tests'); };
after(() => assert.equal(spawns, 0, 'isolation tests must never launch a Blender process'));

// Extend blender-tools-surface.mjs fixture's status/probe/command stubs by workspace.
function fixture(t) {
  const states = new Map([workspaceA, workspaceB].map((workspaceKey, index) => [workspaceKey, {
    connection: { connected: true, runtimeGeneration: (index ? 'b' : 'a').repeat(32), hello: { version: '5.3.0' } },
  }]));
  const calls = [];
  const viewport = {
    status: workspaceKey => states.get(workspaceKey) ?? { connection: { connected: false, runtimeGeneration: null, hello: null } },
    probe: async () => ({ available: true, compatible: true, version: '5.3.0' }),
    command: async (request, _signal, workspaceKey) => {
      calls.push({ request, workspaceKey });
      assert.ok(states.has(workspaceKey), 'tool dispatch must identify an existing workspace');
      return request.op === 'scene.query' ? { objects: [] }
        : request.op === 'scene.apply' ? { results: request.payload.ops.map(op => ({ opId: op.opId })) }
          : { rotation: [1, 0, 0, 0], distance: 5, projection: 'PERSP' };
    },
  };
  const coordinator = createBlenderCoordinator({ getViewport: () => viewport });
  t.after(() => coordinator.dispose());
  const tools = new Map(createBlenderTools({ getViewport: () => viewport, coordinator, resolveContext: async exec => exec.context }).map(tool => [tool.name, tool]));
  const invoke = (context, name, args) => tools.get(name).execute(args, { context });
  const acquire = (context, idemKey = 'isolation_write') => {
    const record = coordinator.record(context);
    const status = coordinator.control({ action: 'status', resource: 'scene' }, context, record);
    const lease = coordinator.control({ action: 'acquire', resource: 'scene', grantId: status.challenge.grantId }, context, record);
    return { targetId: record.targetId, generation: record.generation, grantId: status.challenge.grantId,
      leaseId: lease.leaseId, expectControlRevision: lease.controlRevision, expectSceneRevision: record.sceneRevision, idemKey };
  };
  const apply = async (context, write, sceneId = 'scn_isolation') => {
    const input = { action: 'apply', targetId: write.targetId, generation: write.generation,
      ops: [{ opId: 'collection.ensure', opVersion: 1, stepId: 'ensure', args: { sceneId } }] };
    const plan = await invoke(context, 'blender_scene_apply', { ...input, mode: 'plan' });
    const args = { ...input, ...write, mode: 'apply', planId: plan.data.planId, approvalGrantId: write.grantId };
    return { args, result: await invoke(context, 'blender_scene_apply', args) };
  };
  return { viewport, states, calls, coordinator, invoke, acquire, apply };
}

const context = (workspaceKey, owner = 'agent_a') => ({ workspaceKey, owner });
const live = record => ({ targetId: record.targetId, generation: record.generation });
const controlStatus = (f, caller) => f.coordinator.control({ action: 'status', resource: 'scene' }, caller, f.coordinator.record(caller));

test('same workspace shares record, target, sceneRevision and controlRevision across agents', async t => {
  const f = fixture(t);
  const agentA = context(workspaceA), agentB = context(workspaceA, 'agent_b');
  const recordA = f.coordinator.record(agentA), recordB = f.coordinator.record(agentB);
  assert.strictEqual(recordA, recordB);
  assert.deepEqual(live(recordA), live(recordB));
  const write = f.acquire(agentA);
  assert.equal(controlStatus(f, agentB).controlRevision, write.expectControlRevision);
  const { result } = await f.apply(agentA, write);
  assert.equal(result.effectState, 'committed');
  assert.equal(result.data.sceneRevision, 1);
  assert.strictEqual(f.coordinator.record(agentB), recordA);
  const observed = await f.invoke(agentB, 'blender_scene_query', { action: 'query', live: live(recordB), kind: 'scene' });
  assert.equal(observed.data.sceneRevision, 1);
  assert.equal(recordB.dirty, true);
  assert.deepEqual(f.calls.map(call => [call.workspaceKey, call.request.op]), [[workspaceA, 'scene.apply'], [workspaceA, 'scene.query']]);
});

test('same workspace scene lease excludes another agent until the owner releases it', t => {
  const f = fixture(t);
  const agentA = context(workspaceA), agentB = context(workspaceA, 'agent_b');
  const record = f.coordinator.record(agentA);
  const writeA = f.acquire(agentA);
  const statusB = controlStatus(f, agentB);
  assert.equal(statusB.owner, agentA.owner);
  assert.equal(statusB.leaseId, writeA.leaseId);
  assert.throws(() => f.acquire(agentB), { code: 'BUSY' });
  assert.equal(record.controls.scene, writeA.expectControlRevision, 'rejected acquisition must not change the control revision');
  const released = f.coordinator.control({ action: 'release', resource: 'scene', leaseId: writeA.leaseId,
    expectControlRevision: writeA.expectControlRevision }, agentA, record);
  assert.equal(released.status, 'available');
  assert.equal(released.controlRevision, writeA.expectControlRevision + 1);
  const writeB = f.acquire(agentB);
  assert.notEqual(writeB.leaseId, writeA.leaseId);
  assert.equal(writeB.expectControlRevision, released.controlRevision + 1);
  assert.equal(controlStatus(f, agentA).owner, agentB.owner);
  assert.throws(() => f.coordinator.begin(writeA, agentA, record, 'scene'), { code: 'LEASE_LOST' });
});

test('different workspaces isolate records, revisions, leases and committed idempotency results', async t => {
  const f = fixture(t);
  // Keep the owner and idemKey equal so workspace scoping, rather than owner scoping, is tested.
  const agentA = context(workspaceA), agentB = context(workspaceB);
  const recordA = f.coordinator.record(agentA), recordB = f.coordinator.record(agentB);
  assert.notStrictEqual(recordA, recordB);
  assert.notStrictEqual(recordA.controls, recordB.controls);
  assert.notEqual(recordA.targetId, recordB.targetId);
  const writeA = f.acquire(agentA, 'same_idem_key');
  const first = await f.apply(agentA, writeA, 'scn_workspace_a');
  assert.equal(recordA.sceneRevision, 1);
  assert.equal(recordB.sceneRevision, 0);
  assert.equal(recordB.dirty, false);
  const beforeB = controlStatus(f, agentB);
  assert.equal(beforeB.status, 'available');
  assert.equal(beforeB.controlRevision, 0);
  assert.equal(beforeB.leaseId, undefined);
  const writeB = f.acquire(agentB, writeA.idemKey);
  assert.notEqual(writeB.leaseId, writeA.leaseId);
  assert.equal(writeB.expectControlRevision, 1);
  const second = await f.apply(agentB, writeB, 'scn_workspace_b');
  assert.equal(second.result.effectState, 'committed');
  assert.equal(recordB.sceneRevision, 1);
  assert.equal(recordA.sceneRevision, 1);
  assert.equal(controlStatus(f, agentA).leaseId, writeA.leaseId);
  assert.deepEqual(await f.invoke(agentA, 'blender_scene_apply', first.args), first.result);
  assert.deepEqual(await f.invoke(agentB, 'blender_scene_apply', second.args), second.result);
  assert.notEqual(first.result.data.planId, second.result.data.planId);
  assert.deepEqual(f.calls.map(call => [call.workspaceKey, call.request.payload.ops[0].args.sceneId]),
    [[workspaceA, 'scn_workspace_a'], [workspaceB, 'scn_workspace_b']]);
  assert.throws(() => f.coordinator.begin({ ...first.args, idemKey: writeA.idemKey, planId: 'changed_plan' }, agentA, recordA, 'scene'),
    { code: 'IDEMPOTENCY_CONFLICT' });
});

test('an in-flight write and its pending idempotency entry cannot block another workspace', t => {
  const f = fixture(t);
  const agentA = context(workspaceA), agentB = context(workspaceB);
  const recordA = f.coordinator.record(agentA), recordB = f.coordinator.record(agentB);
  const writeA = f.acquire(agentA, 'same_pending_key'), writeB = f.acquire(agentB, 'same_pending_key');
  const tokenA = f.coordinator.begin(writeA, agentA, recordA, 'scene');
  assert.equal(recordA.busy, true);
  assert.equal(recordB.busy, false);
  assert.throws(() => f.coordinator.begin(writeA, agentA, recordA, 'scene'), { code: 'BUSY' });
  const tokenB = f.coordinator.begin(writeB, agentB, recordB, 'scene');
  assert.equal(recordB.busy, true);
  assert.notEqual(tokenA.key, tokenB.key);
  f.coordinator.finish(tokenA, { workspace: workspaceA });
  assert.equal(recordA.busy, false);
  assert.equal(recordB.busy, true);
  f.coordinator.finish(tokenB, { workspace: workspaceB });
  assert.deepEqual(f.coordinator.begin(writeA, agentA, recordA, 'scene').replay, { workspace: workspaceA });
  assert.deepEqual(f.coordinator.begin(writeB, agentB, recordB, 'scene').replay, { workspace: workspaceB });
});

test('a grant from one workspace cannot authorize acquisition or a write in another workspace', t => {
  const f = fixture(t);
  const agentA = context(workspaceA), agentB = context(workspaceB);
  const recordA = f.coordinator.record(agentA), recordB = f.coordinator.record(agentB);
  const grantA = controlStatus(f, agentA).challenge.grantId;
  assert.throws(() => f.coordinator.control({ action: 'acquire', resource: 'scene', grantId: grantA }, agentB, recordB),
    { code: 'GRANT_SCOPE_MISMATCH' });
  const writeB = f.acquire(agentB);
  assert.throws(() => f.coordinator.begin({ ...writeB, grantId: grantA }, agentB, recordB, 'scene'),
    { code: 'GRANT_SCOPE_MISMATCH' });
  // Even presenting A's record must not remove the workspace subject check.
  assert.throws(() => f.coordinator.assertGrant(grantA, agentB, recordA, 'scene'), { code: 'GRANT_SCOPE_MISMATCH' });
  assert.equal(recordB.sceneRevision, 0);
  assert.equal(recordB.busy, false);
  assert.equal(recordB.controls.scene, writeB.expectControlRevision);
  assert.equal(f.calls.length, 0);
});

test('replacing one workspace runtime leaves another workspace revisions, lease and grant live', async t => {
  const f = fixture(t);
  const agentA = context(workspaceA), agentB = context(workspaceB);
  const recordA = f.coordinator.record(agentA), recordB = f.coordinator.record(agentB);
  const writeA = f.acquire(agentA), writeB = f.acquire(agentB);
  await f.apply(agentB, writeB);
  const beforeB = structuredClone(recordB);
  f.states.get(workspaceA).connection.runtimeGeneration = 'c'.repeat(32);
  assert.strictEqual(f.coordinator.record(agentA), recordA);
  assert.equal(recordA.generation, writeA.generation + 1);
  assert.throws(() => f.coordinator.assertGrant(writeA.grantId, agentA, recordA, 'scene'), { code: 'GENERATION_MISMATCH' });
  assert.deepEqual(f.coordinator.record(agentB), beforeB);
  assert.equal(controlStatus(f, agentB).leaseId, writeB.leaseId);
  assert.doesNotThrow(() => f.coordinator.assertGrant(writeB.grantId, agentB, recordB, 'scene'));
});

test('real viewport frame/command share workspace instances and release removes only the selected workspace without spawning', async t => {
  const viewport = createBlenderViewport({ spawnProcess });
  t.after(async () => { await viewport.dispose(); assert.equal(spawns, 0); });
  assert.equal(viewport.status(workspaceA).state, 'cold');
  assert.equal(viewport.status(workspaceB).state, 'cold');
  // Invalid commands allocate an instance but are rejected before ensure()/spawnProcess.
  await assert.rejects(viewport.command({ op: 'execute_python' }, undefined, workspaceA), { code: 'INVALID_ARGUMENT' });
  const statusA = viewport.status(workspaceA);
  assert.equal(statusA.workspaceKey, workspaceA);
  assert.equal(statusA.state, 'stopped');
  assert.ok(statusA.internalToken);
  assert.equal(viewport.status(workspaceB).state, 'cold');
  const signal = new AbortController().signal;
  // A stale interactive frame also stops before ensure(), while exercising frame's instance lookup.
  const staleFrame = { input: [], generation: 'stale_generation', size: [320, 240] };
  await assert.rejects(viewport.frame(staleFrame, signal, workspaceB), { code: 'BLENDER_STALE_FRAME' });
  const statusB = viewport.status(workspaceB);
  assert.equal(statusB.workspaceKey, workspaceB);
  assert.ok(statusB.internalToken);
  assert.notEqual(statusB.internalToken, statusA.internalToken);
  await assert.rejects(viewport.command({ op: 'execute_python' }, undefined, workspaceB), { code: 'INVALID_ARGUMENT' });
  await assert.rejects(viewport.frame(staleFrame, signal, workspaceA), { code: 'BLENDER_STALE_FRAME' });
  assert.equal(viewport.status(workspaceA).internalToken, statusA.internalToken);
  assert.deepEqual(viewport.status(workspaceB), statusB);
  await viewport.release(workspaceA);
  assert.equal(viewport.status(workspaceA).state, 'cold');
  assert.equal(viewport.status(workspaceA).internalToken, null);
  assert.deepEqual(viewport.status(workspaceB), statusB);
  await viewport.release(workspaceA);
  assert.deepEqual(viewport.status(workspaceB), statusB);
  await assert.rejects(viewport.command({ op: 'execute_python' }, undefined, workspaceA), { code: 'INVALID_ARGUMENT' });
  assert.notEqual(viewport.status(workspaceA).internalToken, statusA.internalToken);
  assert.deepEqual(viewport.status(workspaceB), statusB);
  assert.equal(spawns, 0);
});
