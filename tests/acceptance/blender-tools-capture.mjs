import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createBlenderCoordinator } from '../../targets/three-d/environment.js';
import { createBlenderCapture, createBlenderTools } from '../../targets/three-d/tools.js';
import { createBlenderViewport } from '../../targets/three-d/runtime.js';
import { ArtifactStore, encodeRgbaPng } from '../../targets/three-d/spec/index.js';
import { validateToolOutput } from '../../tools/blender/schema.js';

const width = 960; const height = 540;
const png = encodeRgbaPng(width, height, new Uint8Array(width * height * 4).fill(255));
const reject = (promise, code) => assert.rejects(promise, error => error.code === code && error.details.effectState === 'none');

async function fixture(t, { viewport: injectedViewport } = {}) {
  const rootDir = await mkdtemp(join(tmpdir(), 'blender-capture-'));
  t.after(() => rm(rootDir, { recursive: true, force: true }));
  const context = { workspaceKey: 'workspace:capture', owner: 'session_capture', projectPath: 'fixture.blend' };
  let currentContext = context; let runtimeGeneration = 'a'.repeat(32); let beforePut = async () => {};
  const frames = []; const publications = [];
  const viewport = injectedViewport ?? {
    status: () => ({ connection: { connected: true, runtimeGeneration, hello: { version: '5.3.0' } } }),
    probe: async () => ({ available: true, compatible: true, version: '5.3.0' }),
    frame: async (...args) => { frames.push(args); return { png, generation: runtimeGeneration }; },
  };
  const coordinator = createBlenderCoordinator({ getViewport: () => viewport });
  const record = coordinator.record(context); const live = { targetId: record.targetId, generation: record.generation };
  const store = new ArtifactStore({ rootDir: join(rootDir, 'artifacts'), authorize: request => request.authorizeStore?.(request) ?? false });
  const artifactStore = { put: async request => { publications.push(request); await beforePut(request); return store.put(request); } };
  const tools = new Map(createBlenderTools({ getViewport: () => viewport, coordinator, resolveContext: async () => currentContext,
    artifactStore, capture: createBlenderCapture({ getViewport: () => viewport, getArtifactStore: () => artifactStore }) }).map(tool => [tool.name, tool]));
  const signal = AbortSignal.timeout(30000);
  const invoke = (name, args) => tools.get(name).execute(args, { signal });
  const capture = args => invoke('blender_capture', { action: 'capture', ...live, source: 'agentView', ...args });
  const read = artifactId => store.get({ workspaceId: context.workspaceKey, actor: context.owner, artifactId, authorizeStore: () => true });
  return { rootDir, context, live, frames, publications, signal, invoke, capture, read,
    beforePut(fn) { beforePut = fn; }, restart() { runtimeGeneration = 'b'.repeat(32); }, changeContext(value) { currentContext = value; } };
}

const authorize = (request, changes = {}) => request.authorizeStore({ ...request, action: 'artifact:write', ...changes });

test('agentView capture validates output schema, publishes exact PNG bytes and forwards the bound frame request', async t => {
  const f = await fixture(t); const result = await f.capture({ size: { width, height } });
  assert.equal(result.ok, true);
  assert.deepEqual(validateToolOutput('blender_capture', result), { valid: true, errors: [] });
  assert.deepEqual(Object.keys(result.data).sort(), ['artifactId', 'capturedAt', 'height', 'mediaType', 'sha256', 'width']);
  assert.equal(result.data.width, width); assert.equal(result.data.height, height); assert.equal(result.data.mediaType, 'image/png');
  assert.ok(Number.isFinite(Date.parse(result.data.capturedAt)));
  const artifact = await f.read(result.data.artifactId);
  assert.deepEqual(artifact.bytes, png);
  assert.equal(result.data.sha256, createHash('sha256').update(png).digest('hex'));
  assert.equal(artifact.sha256, result.data.sha256);
  assert.deepEqual(f.frames, [[{ input: [], size: { width, height }, editors: [] }, f.signal, f.context.workspaceKey, f.context.projectPath]]);
});

test('default capture size is 960x540 and unsupported branches never frame or publish', async t => {
  const f = await fixture(t);
  for (const args of [{ source: 'humanView' }, { source: 'checkpoint', checkpointId: 'checkpoint_fixture' }, { checkpointId: 'checkpoint_fixture' }, { sequence: { start: 1, end: 2, step: 1 } }, { editorId: 'editor_fixture' }, { cameraId: 'camera_fixture' }]) await reject(f.capture(args), 'CAPABILITY_UNAVAILABLE');
  assert.equal(f.frames.length, 0); assert.equal(f.publications.length, 0);
  await f.capture(); assert.deepEqual(f.frames[0][0].size, { width, height });
  const caps = await f.invoke('blender_capabilities', { action: 'status' });
  assert.equal(caps.data.declaration.unavailableActions.includes('capture'), false);
  for (const branch of ['capture.humanView', 'capture.checkpoint', 'capture.sequence']) assert.ok(caps.data.declaration.unavailableActions.includes(branch));
  assert.match(caps.data.declaration.limitations.join(' '), /self-issued evidence token without human approval/);
});

test('byte and pixel budgets reject before ArtifactStore access, leaving no artifacts', async t => {
  const f = await fixture(t);
  await reject(f.capture({ size: { width, height }, budget: { maxOutputBytes: png.length - 1, maxTotalPixels: width * height } }), 'OUTPUT_LIMIT');
  await reject(f.capture({ budget: { maxTotalPixels: width * height - 1, maxOutputBytes: png.length } }), 'OUTPUT_LIMIT');
  assert.equal(f.publications.length, 0); assert.deepEqual(await readdir(f.rootDir), []);
  assert.equal((await f.capture({ budget: { maxOutputBytes: png.length, maxTotalPixels: width * height } })).ok, true);
});

test('cold capture rejects TARGET_NOT_BOUND without spawning or probing Blender', async t => {
  let spawned = 0;
  const viewport = createBlenderViewport({ spawnProcess: () => { spawned++; throw new Error('No process may start.'); } });
  t.after(() => viewport.dispose());
  const f = await fixture(t, { viewport });
  await reject(f.capture(), 'TARGET_NOT_BOUND');
  assert.equal(spawned, 0); assert.equal(f.publications.length, 0); assert.deepEqual(await readdir(f.rootDir), []);
});

test('evidence tokens reject foreign scope, target generations, non-artifact actions and replay', async t => {
  const f = await fixture(t);
  f.beforePut(async request => {
    for (const changes of [{ workspaceId: 'workspace:foreign' }, { actor: 'session_foreign' }, { targetId: 'target_foreign' }, { action: 'scene:write' }, { action: 'view:write' }]) await reject(authorize(request, changes), 'GRANT_SCOPE_MISMATCH');
    for (const changes of [{ generation: request.generation + 1 }, { runtimeGeneration: 'b'.repeat(32) }]) await reject(authorize(request, changes), 'GENERATION_MISMATCH');
  });
  await f.capture();
  await reject(authorize(f.publications[0]), 'GRANT_EXPIRED');
});

test('caller changes and runtime restart revoke an outstanding evidence token before publication', async t => {
  for (const change of ['workspace', 'owner', 'runtime']) {
    const f = await fixture(t);
    f.beforePut(async () => {
      if (change === 'runtime') f.restart();
      else f.changeContext({ ...f.context, ...(change === 'owner' ? { owner: 'session_foreign' } : { workspaceKey: 'workspace:foreign' }) });
    });
    await reject(f.capture(), change === 'runtime' ? 'GENERATION_MISMATCH' : 'GRANT_SCOPE_MISMATCH');
    assert.deepEqual(await readdir(f.rootDir), []);
    await reject(authorize(f.publications[0]), 'GRANT_EXPIRED');
  }
});

test('evidence tokens have a short TTL and cannot authorize scene or view writes', async t => {
  const f = await fixture(t);
  const realNow = Date.now;
  f.beforePut(async () => { Date.now = () => realNow() + 31000; });
  try { await reject(f.capture(), 'GRANT_EXPIRED'); } finally { Date.now = realNow; }
  assert.deepEqual(await readdir(f.rootDir), []);
  f.beforePut(async () => {});
  await f.capture(); const grantId = f.publications.at(-1).grantId;
  const write = { ...f.live, grantId, leaseId: 'lease_fixture', expectControlRevision: 1, expectSceneRevision: 0, idemKey: 'evidence_scene' };
  const args = { action: 'apply', mode: 'apply', ...write, planId: 'plan_fixture', approvalGrantId: grantId,
    ops: [{ opId: 'collection.ensure', opVersion: 1, stepId: 'ensure', args: { sceneId: 'scn_capture' } }] };
  await reject(f.invoke('blender_scene_apply', args), 'GRANT_SCOPE_MISMATCH');
  await reject(f.invoke('blender_view', { action: 'set', ...f.live, grantId, leaseId: 'lease_fixture', expectControlRevision: 1, idemKey: 'evidence_view', expectViewRevision: 0, changes: { distance: 5 } }), 'GRANT_SCOPE_MISMATCH');
});
