import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createBlenderCoordinator } from '../../targets/three-d/environment.js';
import { createBlenderTools } from '../../targets/three-d/tools.js';
import { validateToolOutput } from '../../tools/blender/schema.js';

const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
const diskHash = async path => sha256(await readFile(path));
const reject = (promise, code, effectState = 'none') => assert.rejects(promise, error => {
  assert.equal(error.code, code); assert.equal(error.details.effectState, effectState); return true;
});

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'blender-project-lifecycle-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const workspaceRoot = join(root, 'workspace'); await mkdir(workspaceRoot);
  const path = join(workspaceRoot, 'active.blend'); const initialBytes = Buffer.from('BLENDER fixture original\u0000bytes');
  await writeFile(path, initialBytes);
  const context = { workspaceRoot, workspaceKey: 'workspace:project-lifecycle', owner: 'session_project_lifecycle' };
  let projectPath = path; let connected = true; let now = Date.now(); let resolveHook = null;
  const calls = []; let save = async () => { await writeFile(path, 'BLENDER fixture saved'); return { saved: true }; };
  const viewport = {
    status: () => ({ projectPath, connection: { connected, runtimeGeneration: 'a'.repeat(32), hello: { version: '5.3.0' } } }),
    probe: async () => ({ available: true, compatible: true, version: '5.3.0' }),
    command: async request => { calls.push(request); assert.equal(request.op, 'project.save'); assert.deepEqual(request.payload, {}); return save(); },
  };
  const coordinator = createBlenderCoordinator({ getViewport: () => viewport, now: () => now });
  const record = coordinator.record(context); const live = { targetId: record.targetId, generation: record.generation };
  const tools = new Map(createBlenderTools({ getViewport: () => viewport, coordinator,
    resolveContext: async () => { if (resolveHook) await resolveHook(); return context; } }).map(tool => [tool.name, tool]));
  const invoke = async (args, name = 'blender_project') => {
    const value = await tools.get(name).execute(args, { signal: AbortSignal.timeout(30000) });
    assert.deepEqual(validateToolOutput(name, value), { valid: true, errors: [] }); return value;
  };
  let sequence = 0;
  const acquire = (resource = 'project') => {
    const status = coordinator.control({ action: 'status', resource }, context, record);
    const lease = coordinator.control({ action: 'acquire', resource, grantId: status.challenge.grantId }, context, record);
    return { ...live, grantId: status.challenge.grantId, leaseId: lease.leaseId, expectControlRevision: lease.controlRevision,
      expectSceneRevision: record.sceneRevision, idemKey: `lifecycle_${++sequence}` };
  };
  const grant = (resource = 'project') => coordinator.control({ action: 'status', resource }, context, record).challenge.grantId;
  return { invoke, acquire, grant, record, calls, path, root, workspaceRoot, initialBytes, live, context,
    save: fn => { save = fn; }, bind: value => { projectPath = value; }, cold: () => { connected = false; },
    expire: () => { now += 400000; }, onContext: fn => { resolveHook = fn; } };
}

test('save refuses mismatched expectedFileHash with both hashes and byte-identical disk contents', async t => {
  const f = await fixture(t); const expectedFileHash = 'f'.repeat(64); const before = await diskHash(f.path);
  await assert.rejects(f.invoke({ action: 'save', write: f.acquire(), expectedFileHash }), error => {
    assert.equal(error.code, 'PROJECT_CONFLICT'); assert.equal(error.details.effectState, 'none');
    assert.equal(error.details.expectedFileHash, expectedFileHash); assert.equal(error.details.actualFileHash, before); return true;
  });
  assert.equal(await diskHash(f.path), before); assert.deepEqual(await readFile(f.path), f.initialBytes);
  assert.equal(f.calls.length, 0); assert.equal(f.record.busy, false);
});

test('save requires an expected hash even though the frozen schema permits it to be omitted', async t => {
  const f = await fixture(t);
  await reject(f.invoke({ action: 'save', write: f.acquire() }), 'PROJECT_CONFLICT');
  assert.deepEqual(await readFile(f.path), f.initialBytes); assert.equal(f.calls.length, 0);
});

test('save compares, writes through the existing command, rehashes disk, returns receipt and replays once', async t => {
  const f = await fixture(t); f.record.dirty = true;
  const args = { action: 'save', write: f.acquire(), expectedFileHash: await diskHash(f.path), overwriteGrantId: f.grant() };
  const value = await f.invoke(args);
  assert.equal(value.effectState, 'committed'); assert.equal(value.data.status, 'saved'); assert.equal(value.data.dirty, false);
  assert.deepEqual(value.data.project, { saved: true }); assert.equal(value.data.fileHash, await diskHash(f.path));
  assert.notEqual(value.data.fileHash, args.expectedFileHash); assert.equal(f.record.dirty, false);
  assert.deepEqual(await f.invoke(args), value); assert.equal(f.calls.length, 1); assert.equal(f.record.busy, false);
});

test('save validates project write and optional overwrite grants before writing', async t => {
  const f = await fixture(t); const write = f.acquire(); const expectedFileHash = await diskHash(f.path);
  await reject(f.invoke({ action: 'save', write: { ...write, grantId: 'forged' }, expectedFileHash }), 'GRANT_INVALID');
  await reject(f.invoke({ action: 'save', write, expectedFileHash, overwriteGrantId: 'forged' }), 'GRANT_INVALID');
  await reject(f.invoke({ action: 'save', write, expectedFileHash, overwriteGrantId: f.grant('scene') }), 'GRANT_SCOPE_MISMATCH');
  assert.equal(f.calls.length, 0); assert.deepEqual(await readFile(f.path), f.initialBytes);
});

test('save detects a disk change during context refresh before command dispatch', async t => {
  const f = await fixture(t); const args = { action: 'save', write: f.acquire(), expectedFileHash: await diskHash(f.path) };
  let contexts = 0; f.onContext(async () => { if (++contexts === 2) await writeFile(f.path, 'independent writer'); });
  await reject(f.invoke(args), 'PROJECT_CONFLICT'); assert.equal(f.calls.length, 0);
  assert.equal((await readFile(f.path)).toString(), 'independent writer'); assert.equal(f.record.busy, false);
});

test('failed runtime save has unknown effect, retains dirty state and cannot be blindly replayed', async t => {
  const f = await fixture(t); f.record.dirty = true;
  f.save(async () => { await writeFile(f.path, 'possibly committed'); throw Object.assign(new Error('runtime receipt lost'), { code: 'BLENDER_COMMAND_FAILED' }); });
  const args = { action: 'save', write: f.acquire(), expectedFileHash: await diskHash(f.path) };
  await reject(f.invoke(args), 'SEMANTIC_INVALID', 'unknown');
  await reject(f.invoke(args), 'SEMANTIC_INVALID', 'unknown');
  assert.equal(f.record.dirty, true); assert.equal(f.calls.length, 1); assert.equal(f.record.busy, false);
});

test('save requires saved:true and a readable post-write file before reporting committed', async t => {
  const f = await fixture(t); f.record.dirty = true; const write = f.acquire(); const expectedFileHash = await diskHash(f.path);
  f.save(async () => ({ saved: false }));
  await reject(f.invoke({ action: 'save', write, expectedFileHash }), 'EVIDENCE_INCOMPLETE', 'unknown');
  f.save(async () => { await rm(f.path); return { saved: true }; });
  await reject(f.invoke({ action: 'save', write: { ...write, idemKey: 'post_hash_missing' }, expectedFileHash }), 'EVIDENCE_INCOMPLETE', 'unknown');
  assert.equal(f.record.dirty, true); assert.equal(f.record.busy, false);
});

test('save and saveAs serialize through the project coordinator while a save is running', async t => {
  const f = await fixture(t); const write = f.acquire(); const expectedFileHash = await diskHash(f.path);
  let started; let release; const ready = new Promise(resolve => { started = resolve; });
  const pending = new Promise(resolve => { release = resolve; });
  f.save(async () => { started(); await pending; await writeFile(f.path, 'saved after gate'); return { saved: true }; });
  const saving = f.invoke({ action: 'save', write, expectedFileHash }); await ready;
  try { await reject(f.invoke({ action: 'saveAs', write: { ...write, idemKey: 'parallel_save_as' }, path: 'new.blend' }), 'BUSY'); }
  finally { release(); }
  await saving; assert.equal(f.calls.length, 1); assert.equal(f.record.busy, false);
});

test('saveAs rejects absolute and relative paths outside the workspace before any runtime command', async t => {
  const f = await fixture(t); const write = f.acquire();
  for (const path of [join(f.root, 'outside.blend'), '../outside.blend', 'nested/../../outside.blend']) {
    await reject(f.invoke({ action: 'saveAs', write, path }), 'PATH_OUTSIDE_WORKSPACE');
  }
  assert.equal(f.calls.length, 0); assert.deepEqual(await readFile(f.path), f.initialBytes);
});

test('saveAs resolves junction/symlink ancestry for both existing and missing escape targets', async t => {
  const f = await fixture(t); const outside = join(f.root, 'outside'); await mkdir(outside);
  const outsideFile = join(outside, 'existing.blend'); await writeFile(outsideFile, 'external bytes');
  const alias = join(f.workspaceRoot, 'escape');
  try { await symlink(outside, alias, process.platform === 'win32' ? 'junction' : 'dir'); }
  catch (error) { if (['EPERM', 'EACCES', 'ENOSYS'].includes(error.code)) return t.skip(`link creation unavailable: ${error.code}`); throw error; }
  const write = f.acquire();
  for (const path of ['escape/existing.blend', 'escape/missing/nested.blend']) await reject(f.invoke({ action: 'saveAs', write, path }), 'PATH_OUTSIDE_WORKSPACE');
  assert.equal((await readFile(outsideFile)).toString(), 'external bytes'); assert.equal(f.calls.length, 0);
});

test('saveAs existing destination requires matching hash and validated project overwrite authorization', async t => {
  const f = await fixture(t); const path = join(f.workspaceRoot, 'existing.blend'); await writeFile(path, 'existing destination');
  const expectedFileHash = await diskHash(path); const args = { action: 'saveAs', write: f.acquire(), path, expectedFileHash };
  await reject(f.invoke(args), 'PROJECT_CONFLICT');
  await reject(f.invoke({ ...args, expectedFileHash: 'f'.repeat(64), overwriteGrantId: f.grant() }), 'PROJECT_CONFLICT');
  for (const [overwriteGrantId, authorizationCode] of [['forged', 'GRANT_INVALID'], [f.grant('scene'), 'GRANT_SCOPE_MISMATCH']]) {
    await assert.rejects(f.invoke({ ...args, overwriteGrantId }), error => {
      assert.equal(error.code, 'PROJECT_CONFLICT'); assert.equal(error.details.effectState, 'none');
      assert.equal(error.details.authorizationCode, authorizationCode); return true;
    });
  }
  await reject(f.invoke({ ...args, overwriteGrantId: f.grant() }), 'CAPABILITY_UNAVAILABLE');
  assert.equal(await diskHash(path), expectedFileHash); assert.equal(f.calls.length, 0); assert.equal(f.record.busy, false);
});

test('saveAs new destinations truthfully remain unavailable without creating or rebinding a project', async t => {
  const f = await fixture(t);
  await reject(f.invoke({ action: 'saveAs', write: f.acquire(), path: 'new/subdirectory/new.blend' }), 'CAPABILITY_UNAVAILABLE');
  await assert.rejects(readFile(join(f.workspaceRoot, 'new/subdirectory/new.blend')), { code: 'ENOENT' });
  assert.equal(f.calls.length, 0); assert.deepEqual(await readFile(f.path), f.initialBytes);
});

test('close refuses dirty records including discard requests, and clean close stays unavailable', async t => {
  const f = await fixture(t); const write = f.acquire(); f.record.dirty = true;
  await reject(f.invoke({ action: 'close', write }), 'PROJECT_DIRTY');
  await reject(f.invoke({ action: 'close', write, discardGrantId: f.grant() }), 'PROJECT_DIRTY');
  f.record.dirty = false; await reject(f.invoke({ action: 'close', write }), 'CAPABILITY_UNAVAILABLE');
  assert.equal(f.calls.length, 0); assert.equal(f.record.busy, false);
});

test('open/reload and all declared lifecycle limitations match the real connected subset', async t => {
  const f = await fixture(t); const write = f.acquire();
  const declaration = (await f.invoke({ action: 'status' }, 'blender_capabilities')).data.declaration;
  assert.deepEqual(declaration.unavailableActions, [
    'project.open', 'project.reload', 'project.saveAs', 'project.close',
    'spec_revision.create', 'spec_revision.get', 'spec_revision.commit', 'spec_apply.artifact', 'reference_analyze',
    'capture', 'capture.humanView', 'capture.checkpoint', 'capture.sequence', 'verify',
  ]);
  assert.match(declaration.limitations.join(' '), /Atomic file saving is provided by Blender save_as_mainfile/);
  assert.match(declaration.limitations.join(' '), /not.*atomic compare-and-swap against external disk writers/);
  assert.match(declaration.limitations.join(' '), /runtime only saves to the already-bound active project path/);
  await reject(f.invoke({ action: 'reload', write }), 'CAPABILITY_UNAVAILABLE');
  await reject(f.invoke({ action: 'open', path: 'new.blend', expectGeneration: null, leaseId: write.leaseId,
    expectControlRevision: write.expectControlRevision, idemKey: 'open_without_process', grantId: write.grantId }), 'CAPABILITY_UNAVAILABLE');
  assert.equal(f.calls.length, 0);
});

test('save fails closed without a bound path or proven workspace root and never starts a target', async t => {
  const f = await fixture(t); const write = f.acquire();
  f.bind(null); await reject(f.invoke({ action: 'save', write, expectedFileHash: await diskHash(f.path) }), 'CAPABILITY_UNAVAILABLE');
  f.bind(f.path); delete f.context.workspaceRoot;
  await reject(f.invoke({ action: 'save', write, expectedFileHash: await diskHash(f.path) }), 'CAPABILITY_UNAVAILABLE');
  f.context.workspaceRoot = f.workspaceRoot; f.cold();
  await reject(f.invoke({ action: 'save', write, expectedFileHash: await diskHash(f.path) }), 'TARGET_NOT_BOUND');
  assert.equal(f.calls.length, 0); assert.equal(f.record.busy, false);
});
