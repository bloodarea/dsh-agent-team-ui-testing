import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createBlenderCoordinator, createBlenderEnvironmentEntry } from '../../targets/three-d/environment.js';
import { createBlenderTools, createBlenderJobStore } from '../../targets/three-d/tools.js';
import { ArtifactStore, SpecStore, emptyScene, buildPatch, canonicalize, encodeRgbaPng } from '../../targets/three-d/spec/index.js';
import { validateToolOutput } from '../../tools/blender/schema.js';
import { createHarness, createFakeConnectionService } from './harness.mjs';

async function fixture(t, { stores = true } = {}) {
  const rootDir = await mkdtemp(join(tmpdir(), 'blender-services-'));
  t.after(() => rm(rootDir, { recursive: true, force: true }));
  let connected = true; let generation = 'a'.repeat(32); let time = Date.now();
  const calls = []; const context = { workspaceKey: 'workspace:services', owner: 'session_services' };
  let objects = [{ stableId: 'obj_present', scale: [1, 2, 3], location: [0, 0, 0] }];
  const viewport = { status: () => ({ connection: { connected, runtimeGeneration: generation, hello: { version: '5.3.0' } } }),
    probe: async () => ({ available: true, compatible: true, version: '5.3.0' }),
    command: async request => { calls.push(request); if (request.op === 'scene.query') return { objects }; if (request.op === 'scene.apply') return { results: request.payload.ops.map(op => ({ opId: op.opId })) }; return { rotation: [1, 0, 0, 0], distance: 5, projection: 'PERSP' }; } };
  const coordinator = createBlenderCoordinator({ getViewport: () => viewport, now: () => time });
  const record = coordinator.record(context); const live = { targetId: record.targetId, generation: record.generation };
  const authorize = request => request.authorizeStore?.(request) ?? false;
  const artifactStore = new ArtifactStore({ rootDir: join(rootDir, 'artifacts'), authorize });
  const specStore = new SpecStore({ rootDir, artifactStore, authorize }); const jobStore = createBlenderJobStore();
  const resolveContext = async exec => exec?.context ?? context;
  const tools = new Map(createBlenderTools({ getViewport: () => viewport, coordinator, resolveContext, jobStore,
    ...(stores ? { artifactStore, specStore } : {}) }).map(tool => [tool.name, tool]));
  const invoke = async (name, args, exec = {}) => {
    const value = await tools.get(name).execute(args, exec);
    assert.deepEqual(validateToolOutput(name, value), { valid: true, errors: [] }); return value;
  };
  const acquire = () => {
    const status = coordinator.control({ action: 'status', resource: 'scene' }, context, record);
    const lease = coordinator.control({ action: 'acquire', resource: 'scene', grantId: status.challenge.grantId }, context, record);
    return { ...live, grantId: status.challenge.grantId, leaseId: lease.leaseId, expectControlRevision: lease.controlRevision, expectSceneRevision: record.sceneRevision, idemKey: 'services_apply' };
  };
  const seed = bytes => artifactStore.put({ workspaceId: context.workspaceKey, actor: context.owner, grantId: 'fixture_seed', authorizeStore: () => true, bytes, mediaType: Buffer.isBuffer(bytes) ? 'image/png' : 'application/json' });
  const read = artifactId => artifactStore.get({ workspaceId: context.workspaceKey, actor: context.owner, authorizeStore: () => true, artifactId });
  return { invoke, context, coordinator, record, live, acquire, calls, seed, read, artifactStore, specStore, jobStore, viewport, rootDir,
    expire() { time += 400000; }, cold() { connected = false; }, restart() { generation = 'b'.repeat(32); }, objects(value) { objects = value; } };
}

const reject = (promise, code) => assert.rejects(promise, error => error.code === code && error.details.effectState === 'none');

test('SpecStore create/get/commit and artifact-backed spec plan/apply use real authorized immutable storage', async t => {
  const f = await fixture(t); const write = f.acquire(); const scene = emptyScene('scn_services');
  await reject(f.invoke('blender_spec_revision', { action: 'create', scene, grantId: 'forged' }), 'GRANT_INVALID');
  const created = await f.invoke('blender_spec_revision', { action: 'create', scene, grantId: write.grantId });
  assert.equal(created.data.revision, 1); assert.equal(created.effectState, 'committed');
  const fetched = await f.invoke('blender_spec_revision', { action: 'get', sceneId: scene.sceneId }); assert.deepEqual(fetched.data.scene, scene);
  const note = await f.seed('"fixture note"');
  const patch = buildPatch(scene, 1, [{ op: 'add', collection: 'sources', id: 'src_note', value: { kind: 'humanNote', artifactId: note.artifactId, sha256: note.sha256 } }], { patchId: 'pch_services', author: 'fixture', reason: 'add note' });
  const committed = await f.invoke('blender_spec_revision', { action: 'commit', patch, grantId: write.grantId }); assert.equal(committed.data.revision, 2);
  assert.deepEqual((await f.invoke('blender_spec_revision', { action: 'commit', patch, grantId: write.grantId })).data, committed.data);
  await reject(f.invoke('blender_spec_revision', { action: 'commit', patch: { ...patch, reason: 'different' }, grantId: write.grantId }), 'PATCH_ID_CONFLICT');
  await reject(f.invoke('blender_spec_revision', { action: 'get', sceneId: 'scn_missing' }), 'EVIDENCE_INCOMPLETE');
  await reject(f.invoke('blender_spec_revision', { action: 'get', sceneId: scene.sceneId }, { context: { ...f.context, workspaceKey: 'workspace:other' } }), 'EVIDENCE_INCOMPLETE');
  const args = { action: 'apply', mode: 'plan', ...f.live, artifactId: committed.data.artifactId };
  const planned = await f.invoke('blender_spec_apply', args); assert.ok(planned.data.steps.length > 0); assert.equal(f.calls.length, 0);
  const applied = await f.invoke('blender_spec_apply', { ...args, ...write, mode: 'apply', planId: planned.data.planId, approvalGrantId: write.grantId });
  assert.equal(applied.data.status, 'committed'); assert.deepEqual(f.calls.map(call => call.op), ['scene.apply']);
  await reject(f.invoke('blender_spec_apply', { ...args, artifactId: 'art_missing' }), 'EVIDENCE_INCOMPLETE');
});

test('storage authorizes again at publication and maps store validation/digest failures to semantic errors', async t => {
  const f = await fixture(t); const write = f.acquire();
  await reject(f.invoke('blender_spec_revision', { action: 'create', scene: {}, grantId: write.grantId }), 'UNSUPPORTED_SCHEMA_VERSION');
  await reject(f.invoke('blender_spec_revision', { action: 'create', scene: { schemaVersion: '1.0.0' }, grantId: write.grantId }), 'SCHEMA_INVALID');
  const png = await f.seed(encodeRgbaPng(1, 1, Uint8Array.from([10, 20, 30, 255])));
  const request = { action: 'analyze', grantId: write.grantId, references: [{ sourceId: 'src_image', artifactId: png.artifactId, sha256: 'f'.repeat(64) }] };
  await reject(f.invoke('blender_reference_analyze', request), 'ASSET_DIGEST_MISMATCH');
  f.expire(); await reject(f.invoke('blender_reference_analyze', { ...request, references: [{ sourceId: 'src_image', artifactId: png.artifactId }] }), 'GRANT_EXPIRED');
  assert.equal(f.calls.length, 0);
});

test('JobStore status/result/cancel, scoped idem ledger, terminal stability and error state are reachable through the tool', async t => {
  const f = await fixture(t); const write = f.acquire(); const request = { ...f.context, idemKey: 'job_once', input: { op: 'offline-read' } };
  const registered = f.jobStore.register(request); assert.equal(registered.state, 'queued'); assert.deepEqual(f.jobStore.register(request), registered);
  assert.throws(() => f.jobStore.register({ ...request, input: { op: 'other' } }), { code: 'IDEMPOTENCY_CONFLICT' });
  assert.equal((await f.invoke('blender_job', { action: 'status', jobId: registered.jobId })).data.state, 'queued');
  await reject(f.invoke('blender_job', { action: 'result', jobId: registered.jobId }), 'BUSY');
  await reject(f.invoke('blender_job', { action: 'status', jobId: registered.jobId }, { context: { ...f.context, owner: 'foreign' } }), 'TARGET_GONE');
  await reject(f.invoke('blender_job', { action: 'status', jobId: 'missing' }), 'TARGET_GONE');
  await reject(f.invoke('blender_job', { action: 'cancel', jobId: registered.jobId, grantId: 'forged' }), 'GRANT_INVALID');
  const cancelled = await f.invoke('blender_job', { action: 'cancel', jobId: registered.jobId, grantId: write.grantId }); assert.equal(cancelled.data.state, 'cancelled');
  assert.deepEqual(await f.invoke('blender_job', { action: 'cancel', jobId: registered.jobId, grantId: write.grantId }), cancelled);
  assert.deepEqual((await f.invoke('blender_job', { action: 'result', jobId: registered.jobId })).data, cancelled.data);
  const success = f.jobStore.register({ ...request, idemKey: 'job_success' }); f.jobStore.start(success.jobId, f.context); f.jobStore.settle(success.jobId, f.context, { result: { artifactId: 'art_result' } });
  assert.equal((await f.invoke('blender_job', { action: 'result', jobId: success.jobId })).data.result.artifactId, 'art_result');
  assert.equal((await f.invoke('blender_job', { action: 'cancel', jobId: success.jobId, grantId: write.grantId })).data.state, 'succeeded');
  const failed = f.jobStore.register({ ...request, idemKey: 'job_failed' }); f.jobStore.start(failed.jobId, f.context); f.jobStore.settle(failed.jobId, f.context, { error: { code: 'OUTPUT_LIMIT' } });
  assert.equal((await f.invoke('blender_job', { action: 'result', jobId: failed.jobId })).data.error.code, 'OUTPUT_LIMIT');
  const running = f.jobStore.register({ ...request, idemKey: 'job_running' }); f.jobStore.start(running.jobId, f.context);
  assert.equal((await f.invoke('blender_job', { action: 'cancel', jobId: running.jobId, grantId: write.grantId })).data.effectState, 'unknown');
  assert.equal(f.jobStore.settle(running.jobId, f.context, { result: { late: true } }).state, 'cancelled');
  assert.equal(f.calls.length, 0);
});

test('live verify independently queries scene; assertions use pass/fail/unknown and aggregate inconclusive in a report artifact', async t => {
  const f = await fixture(t); const write = f.acquire(); const args = { action: 'verify', source: 'live', ...f.live, grantId: write.grantId,
    assertions: [{ id: 'present', kind: 'exists', subject: 'obj_present', expected: true }, { id: 'absent', kind: 'exists', subject: 'obj_absent', expected: false }, { id: 'scale', kind: 'transform', subject: 'obj_present', expected: { scale: [1, 2.01, 3] }, tolerance: { value: 0.02, unit: 'ratio' } }] };
  const passed = await f.invoke('blender_verify', args); assert.equal(passed.data.status, 'pass'); assert.equal(f.calls.at(-1).op, 'scene.query');
  const report = JSON.parse((await f.read(passed.data.reportArtifactId)).bytes); assert.equal(report.source, 'live'); assert.equal(report.runtimeGeneration, 'a'.repeat(32)); assert.deepEqual(report.assertions.map(item => item.status), ['pass', 'pass', 'pass']);
  const failed = await f.invoke('blender_verify', { ...args, assertions: [{ ...args.assertions[0], expected: false }] }); assert.equal(failed.data.status, 'fail');
  const unknown = await f.invoke('blender_verify', { ...args, assertions: [{ id: 'material', kind: 'material', subject: 'obj_present', expected: 'mat_paint' }] });
  assert.equal(unknown.data.status, 'inconclusive'); assert.equal(unknown.data.assertions[0].status, 'unknown');
  await reject(f.invoke('blender_verify', { ...args, grantId: undefined }), 'AUTHORIZATION_REQUIRED');
  await reject(f.invoke('blender_verify', { ...args, assertions: [{ ...args.assertions[0], expected: 'yes' }] }), 'SEMANTIC_INVALID');
  await reject(f.invoke('blender_verify', { ...args, generation: 999 }), 'GENERATION_MISMATCH');
});

test('artifact and checkpoint verification never convert incomplete evidence into a pass', async t => {
  const f = await fixture(t); const write = f.acquire(); const artifact = await f.seed(canonicalize({ items: [], truncated: true }));
  const args = { action: 'verify', source: 'artifact', artifactId: artifact.artifactId, sha256: artifact.sha256, grantId: write.grantId, assertions: [{ id: 'absent', kind: 'exists', subject: 'obj_absent', expected: false }] };
  const result = await f.invoke('blender_verify', args); assert.equal(result.data.assertions[0].status, 'unknown'); assert.equal(result.data.status, 'inconclusive');
  const checkpoint = await f.invoke('blender_verify', { action: 'verify', source: 'checkpoint', checkpointId: 'unread', grantId: write.grantId, assertions: args.assertions }); assert.equal(checkpoint.data.status, 'inconclusive');
  await reject(f.invoke('blender_verify', { ...args, sha256: 'f'.repeat(64) }), 'ASSET_DIGEST_MISMATCH');
  assert.equal(f.calls.length, 0);
});

test('reference basic normalizes frozen PNG, reads ROI pixels and puts source/confidence/undecidable in the report artifact', async t => {
  const f = await fixture(t); const write = f.acquire(); const png = await f.seed(encodeRgbaPng(2, 1, Uint8Array.from([10, 20, 30, 255, 110, 120, 130, 128])));
  const args = { action: 'analyze', profile: 'basic', grantId: write.grantId, references: [{ sourceId: 'src_image', artifactId: png.artifactId, sha256: png.sha256 }], regions: [{ sourceId: 'src_image', regionId: 'right', rectPx: [1, 0, 1, 1] }] };
  const result = await f.invoke('blender_reference_analyze', args); assert.equal(result.data.status, 'complete');
  assert.equal('source' in result.data, false); assert.equal('confidence' in result.data, false); assert.equal('undecidable' in result.data, false);
  const report = JSON.parse((await f.read(result.data.resultArtifactId)).bytes); assert.equal(report.source, 'frozen-artifact'); assert.equal(report.confidence.pixelRead, 1); assert.ok(report.undecidable.length);
  assert.equal(report.inputs[0].source.artifactId, png.artifactId); assert.deepEqual(report.inputs[0].pixels.meanRgba, [60, 70, 80, 191.5]);
  assert.deepEqual(report.inputs[0].regions[0].pixels.meanRgba, [110, 120, 130, 128]); assert.equal(report.inputs[0].regions[0].coordinateConvention, 'top-left-pixel-boundary-half-open');
  assert.equal((await f.invoke('blender_reference_analyze', args)).data.resultArtifactId, result.data.resultArtifactId);
  await reject(f.invoke('blender_reference_analyze', { ...args, profile: 'spatial' }), 'CAPABILITY_UNSUPPORTED');
  await reject(f.invoke('blender_reference_analyze', { ...args, regions: [{ ...args.regions[0], rectPx: [2, 0, 1, 1] }] }), 'SEMANTIC_INVALID');
  await reject(f.invoke('blender_reference_analyze', { ...args, references: [{ sourceId: 'src_image' }] }), 'EVIDENCE_INCOMPLETE');
  assert.equal(f.calls.length, 0);
});

test('capability unavailableActions agrees with callable save/agentView and unavailable lifecycle/capture branches', async t => {
  const f = await fixture(t); const write = f.acquire();
  const { createBlenderCapture } = await import('../../targets/three-d/tools.js');
  const { readFile, writeFile } = await import('node:fs/promises'); const { createHash } = await import('node:crypto');
  const projectPath = join(f.rootDir, 'active.blend'); await writeFile(projectPath, 'fixture before save');
  const fileHash = async () => createHash('sha256').update(await readFile(projectPath)).digest('hex');
  f.context.workspaceRoot = f.rootDir;
  const status = f.viewport.status; f.viewport.status = () => ({ ...status(), projectPath });
  const command = f.viewport.command;
  f.viewport.command = async request => {
    if (request.op !== 'project.save') return command(request);
    f.calls.push(request); assert.deepEqual(request.payload, {}); await writeFile(projectPath, 'fixture after save'); return { saved: true };
  };
  const projectControl = f.coordinator.control({ action: 'status', resource: 'project' }, f.context, f.record);
  const projectLease = f.coordinator.control({ action: 'acquire', resource: 'project', grantId: projectControl.challenge.grantId }, f.context, f.record);
  const projectWrite = { ...f.live, grantId: projectControl.challenge.grantId, leaseId: projectLease.leaseId, expectControlRevision: projectLease.controlRevision, expectSceneRevision: f.record.sceneRevision, idemKey: 'services_project_save' };
  let frames = 0;
  f.viewport.frame = async () => { frames++; return { png: encodeRgbaPng(1, 1, Uint8Array.from([10, 20, 30, 255])) }; };
  const tools = new Map(createBlenderTools({ getViewport: () => f.viewport, coordinator: f.coordinator, resolveContext: async () => f.context,
    artifactStore: f.artifactStore, specStore: f.specStore, jobStore: f.jobStore,
    capture: createBlenderCapture({ getViewport: () => f.viewport, getArtifactStore: () => f.artifactStore }) }).map(tool => [tool.name, tool]));
  const invoke = async (name, args) => {
    const value = await tools.get(name).execute(args, { signal: AbortSignal.timeout(30000) });
    assert.deepEqual(validateToolOutput(name, value), { valid: true, errors: [] }); return value;
  };
  const caps = await invoke('blender_capabilities', { action: 'status' });
  assert.deepEqual(caps.data.declaration.unavailableActions, ['project.open', 'project.reload', 'project.saveAs', 'project.close', 'capture.humanView', 'capture.checkpoint', 'capture.sequence']);
  assert.match(caps.data.declaration.limitations.join(' '), /Atomic file saving is provided by Blender save_as_mainfile/);
  assert.match(caps.data.declaration.limitations.join(' '), /runtime only saves to the already-bound active project path/);
  assert.match(caps.data.declaration.limitations.join(' '), /Only agentView capture is available/);
  const samples = {
    'project.open': { action: 'open', path: 'fixture.blend', expectGeneration: null, leaseId: 'lease_any', expectControlRevision: 0, idemKey: 'open', grantId: write.grantId },
    'project.reload': { action: 'reload', write: projectWrite },
    'project.saveAs': { action: 'saveAs', write: projectWrite, path: 'fixture.blend' },
    'project.close': { action: 'close', write: projectWrite },
    'capture.humanView': { action: 'capture', ...f.live, source: 'humanView' },
    'capture.checkpoint': { action: 'capture', ...f.live, source: 'checkpoint', checkpointId: 'checkpoint_fixture' },
    'capture.sequence': { action: 'capture', ...f.live, source: 'agentView', sequence: { start: 1, end: 2, step: 1 } },
  };
  for (const action of caps.data.declaration.unavailableActions) await reject(invoke(action.startsWith('capture.') ? 'blender_capture' : 'blender_project', samples[action]), 'CAPABILITY_UNAVAILABLE');
  assert.equal(caps.data.declaration.unavailableActions.includes('project.save'), false);
  const beforeHash = await fileHash();
  const saved = await invoke('blender_project', { action: 'save', write: projectWrite, expectedFileHash: beforeHash, overwriteGrantId: projectWrite.grantId });
  assert.equal(saved.effectState, 'committed'); assert.equal(saved.data.status, 'saved'); assert.deepEqual(saved.data.project, { saved: true });
  assert.equal(saved.data.fileHash, await fileHash()); assert.notEqual(saved.data.fileHash, beforeHash);
  const captured = await invoke('blender_capture', { action: 'capture', ...f.live, source: 'agentView' });
  assert.equal(captured.ok, true); assert.equal(frames, 1); assert.ok((await f.read(captured.data.artifactId)).bytes.length > 0);
  assert.equal(f.record.busy, false); assert.deepEqual(f.calls.map(call => call.op), ['project.save']);
  const cold = await fixture(t, { stores: false }); const missing = (await cold.invoke('blender_capabilities', { action: 'status' })).data.declaration.unavailableActions;
  assert.deepEqual(missing, [...caps.data.declaration.unavailableActions.slice(0, 4), 'spec_revision.create', 'spec_revision.get', 'spec_revision.commit', 'spec_apply.artifact', 'reference_analyze', 'capture', 'capture.humanView', 'capture.checkpoint', 'capture.sequence', 'verify']);
  for (const action of ['job.status', 'job.result', 'job.cancel', 'spec_revision.create', 'spec_revision.get', 'spec_revision.commit', 'reference_analyze', 'verify', 'spec_apply.artifact', 'capture']) assert.equal(caps.data.declaration.unavailableActions.includes(action), false, action);
});

test('real Host composition root supplies SpecStore and ArtifactStore in config/blender/spec without a Blender launch', async t => {
  const configDir = await mkdtemp(join(tmpdir(), 'blender-host-services-')); t.after(() => rm(configDir, { recursive: true, force: true }));
  const peer = { id: 'blender-services-fixture' };
  const harness = await createHarness({ configDir, connection: createFakeConnectionService({ rejection: undefined, admit: () => ({ peer }), browserPeer: peer }) });
  try {
    const response = await harness.request({ method: 'PUT', path: '/plugins/ui-testing/config', body: { expectedRevision: 0, scope: 'global', patch: { view: 'three-d', environment: 'three-d', enabledEnvironments: ['web', 'three-d'], environments: { 'three-d': { enabled: true, providers: { blender: { enabled: true } } } } } } }); assert.equal(response.statusCode, 200);
    const exec = { agent: { id: 'blender-store-agent', session: { header: { cwd: harness.workspaceDir } } }, signal: AbortSignal.timeout(30000) };
    const activated = await harness.invoke('blender_tools', { action: 'activate', groups: ['reference', 'jobs'] }, exec); assert.equal(activated.ok, true, JSON.stringify(activated.error));
    const status = await harness.invoke('blender_control', { action: 'status', resource: 'scene' }, exec); assert.equal(status.ok, true, JSON.stringify(status.error));
    const created = await harness.invoke('blender_spec_revision', { action: 'create', scene: emptyScene('scn_host_injection'), grantId: status.value.data.challenge.grantId }, exec); assert.equal(created.ok, true, JSON.stringify(created.error)); assert.equal(created.value.data.revision, 1);
    const read = await harness.invoke('blender_spec_revision', { action: 'get', sceneId: 'scn_host_injection' }, exec); assert.equal(read.ok, true, JSON.stringify(read.error)); assert.equal(read.value.data.artifactId, created.value.data.artifactId);
    const directory = await stat(join(configDir, 'blender', 'spec')); assert.equal(directory.isDirectory(), true); if (process.platform !== 'win32') assert.equal(directory.mode & 0o777, 0o700);
    const rejected = await harness.invoke('blender_spec_revision', { action: 'create', scene: emptyScene('scn_host_denied'), grantId: 'forged' }, exec); assert.equal(rejected.error.code, 'GRANT_INVALID');
  } finally { await harness.dispose(); }
});
