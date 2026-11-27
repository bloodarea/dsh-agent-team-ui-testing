import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, writeFile, readFile, readdir, stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { WORLDMIRROR_MANIFEST, SPATIALLM_MANIFEST, ProviderRegistry, CapabilityResolver, createProfile, createCacheKey, sha256, validateManifest } from '../../targets/three-d/providers/index.js';
import { createWorldMirrorAdapter } from '../../targets/three-d/providers/adapters/worldmirror.js';
import { createSpatialLMAdapter, createInputValidator } from '../../targets/three-d/providers/adapters/spatiallm.js';

const root = fileURLToPath(new URL('../..', import.meta.url));
const evidence = path.join(root, 'docs/internal/blender-agent/provider-evidence/vision.hyworld/cpu-tests');
await mkdir(evidence, { recursive: true });
const directory = await mkdtemp(path.join(evidence, 'run-'));
const scope = { workspaceId: 'wm-slm-conformance', taskId: 'cpu-conformance', principalId: 'test-principal' };
const H = sha256('fixture-weights');
const errorCode = code => error => error.code === code;
const task = { taskId: scope.taskId, requiredCapabilities: ['vision.spatial.semantic'], preferredCapabilities: [], optionalCapabilities: [], qualityTarget: 'standard', inputArtifactIds: ['input'], acceptanceProfileId: 'scene.basic' };
const inputPath = path.join(directory, 'input.png');
await writeFile(inputPath, 'fixture-input');
const weightsPath = path.join(directory, 'weights.bin');
await writeFile(weightsPath, 'fixture-weights');
const inputRef = { artifactId: 'input', sha256: sha256('fixture-input'), frameIndex: null, regionId: null };
function inputManifest(overrides = {}) {
  return { contractVersion: 1, artifactId: 'input', kind: 'report', mime: 'image/png', encoding: 'png', byteLength: 13, sha256: inputRef.sha256, width: 1, height: 1, channels: 3,
    coordinateFrame: 'image', units: 'pixel', transformChain: [], validityMaskArtifactId: null, sourceDigests: [], providerId: 'test.fixture', runId: 'fixture-input',
    access: { workspaceId: scope.workspaceId, taskId: scope.taskId, principalIds: [scope.principalId], expiresAt: null }, createdAt: new Date().toISOString(), ...overrides };
}
const fixtureManifest = { ...WORLDMIRROR_MANIFEST, modelAssets: [{ ...WORLDMIRROR_MANIFEST.modelAssets[0], sha256: H, installedBytes: 15, downloadBytes: 15, modelVersion: 'fixture-v1' }], resources: { minRamBytes: 1, estimatedPeakRamBytes: 1, minVramBytes: 1, estimatedPeakVramBytes: 1, requiredDiskBytes: 1 } };
// Synthetic process fixture exercises the real Node adapter only. It is never
// used as model smoke or model quality evidence.
const fixtureWorker = path.join(directory, 'worldmirror_fixture.cjs');
await writeFile(fixtureWorker, `const fs=require('node:fs'),p=require('node:path'),c=require('node:crypto'),cp=require('node:child_process');
const r=JSON.parse(fs.readFileSync(process.argv[process.argv.indexOf('--request')+1]));
const o=process.argv[process.argv.indexOf('--output')+1];
if(r.config.failure){console.error(r.config.failure+': fixture failure');process.exit(1);}
if(r.config.hang){const child=cp.spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore'});fs.writeFileSync(p.join(r.workDir,'child.json'),JSON.stringify({pid:child.pid}));setInterval(()=>{},1000);}
else{const b=Buffer.from('fixture-depth');fs.writeFileSync(p.join(r.workDir,'depth.npy'),b);const a={kind:'relativeDepthRaster',path:'depth.npy',mediaType:'application/x-npy',sha256:c.createHash('sha256').update(b).digest('hex'),bytes:b.length,width:1,height:1,channels:1,unit:null};
if(r.config.tamper)a.sha256='0'.repeat(64);if(r.config.escape)a.path='../outside.npy';
const result={ok:true,providerId:r.providerId,capabilityId:r.capabilityId,artifacts:[a],modelVersion:'fixture-v1',metrics:{validPixelRatio:1},resources:{wallMs:1,peakRamBytes:123,peakVramBytes:null,coldStartMs:null},limitations:['synthetic-process-fixture-quality-unverified']};fs.writeFileSync(o,JSON.stringify(result));console.log(JSON.stringify({ok:true}));}
`);
function adapter(options = {}) {
  return createWorldMirrorAdapter({ manifest: fixtureManifest, pythonPath: process.execPath, workerPath: fixtureWorker, weightsPath, workspaceRoot: root,
    workRoot: directory, scope, resolveInput: async () => ({ path: inputPath, manifest: inputManifest() }), dependencyModules: [], licenseAccepted: true, ...options });
}
const executeArgs = { capabilityId: 'vision.depth.relative', inputRefs: [inputRef], limits: { maxWallMs: 5000, maxOutputBytes: 1024 * 1024 } };

test('C1 manifests are valid, fixed assets, six WM capabilities, pointcloud-only SpatialLM and optional concurrency one', () => {
  for (const manifest of [WORLDMIRROR_MANIFEST, SPATIALLM_MANIFEST]) {
    assert.equal(validateManifest(manifest).manifest.providerId, manifest.providerId);
    assert.equal(manifest.support, 'supported'); assert.equal(manifest.runtime.maxConcurrency, 1);
    const asset = manifest.modelAssets[0]; assert.match(asset.sha256, /^[a-f0-9]{64}$/); assert.ok(asset.installedBytes > 2e9); assert.ok(asset.modelVersion);
    assert.notEqual(manifest.verification.conformance.status, 'passed');
  }
  assert.equal(WORLDMIRROR_MANIFEST.capabilities.length, 6);
  assert.equal(WORLDMIRROR_MANIFEST.capabilities.some(c => c.capabilityId === 'vision.depth.metric'), false);
  assert.equal(SPATIALLM_MANIFEST.capabilities[0].inputSchemaRef, 'vision.pointcloud-input.v1');
  assert.equal(SPATIALLM_MANIFEST.modelAssets[0].licenseId, 'cc-by-nc-4.0');
  assert.equal(WORLDMIRROR_MANIFEST.modelAssets[0].licenseId, 'tencent-hy-world-2.0-community');
  assert.equal(WORLDMIRROR_MANIFEST.verification.smoke.status, 'passed');
  assert.equal(SPATIALLM_MANIFEST.verification.smoke.status, 'failed');
  assert.ok(WORLDMIRROR_MANIFEST.resources.estimatedPeakVramBytes >= WORLDMIRROR_MANIFEST.resources.minVramBytes);
  assert.ok(SPATIALLM_MANIFEST.capabilities[0].limitations.includes('domain-mismatch-residential-model-on-large-hall'));
});

test('C2 cold missing runtime/weights, disabled, license and device status are accurate', async () => {
  assert.equal((await adapter({ pythonPath: path.join(directory, 'missing-python') }).health()).code, 'DEPENDENCY_MISSING');
  assert.equal((await adapter({ weightsPath: path.join(directory, 'missing-weights') }).health()).code, 'DEPENDENCY_MISSING');
  assert.equal((await adapter({ enabled: false }).health()).code, 'PROVIDER_DISABLED');
  assert.equal((await adapter({ licenseAccepted: false }).health()).reason, 'license-not-accepted');
  await assert.rejects(adapter().preflight({ ...executeArgs, config: { device: 'tpu' } }), errorCode('CAPABILITY_UNAVAILABLE'));
  assert.equal((await createSpatialLMAdapter({ enabled: false }).health()).code, 'PROVIDER_DISABLED');
});

test('C3 SpatialLM resolver rejects images, nonmetric, wrong-up and unaligned inputs before a plan', () => {
  const registry = new ProviderRegistry(); registry.register(SPATIALLM_MANIFEST);
  const resolver = new CapabilityResolver(registry);
  const profile = createProfile('balanced', { enabledProviderIds: ['vision.spatiallm'] });
  let source = { path: inputPath, manifest: inputManifest(), axisUp: 'z', axisAligned: true };
  const validateInput = createInputValidator({ lookupInput: () => source, scope });
  for (const bad of [source, { ...source, path: 'cloud.ply', manifest: inputManifest({ kind: 'pointCloud', coordinateFrame: 'world-z-up', units: 'relative' }) },
    { ...source, path: 'cloud.ply', manifest: inputManifest({ kind: 'pointCloud', coordinateFrame: 'world-z-up', units: 'm' }), axisUp: 'y' },
    { ...source, path: 'cloud.ply', manifest: inputManifest({ kind: 'pointCloud', coordinateFrame: 'world-z-up', units: 'm' }), axisAligned: false }]) {
    source = bad; assert.throws(() => resolver.resolve(profile, task, { inputRefs: [inputRef], validateInput }), errorCode('PRIVACY_POLICY_DENIED'));
  }
  source = { path: 'cloud.ply', manifest: inputManifest({ kind: 'pointCloud', coordinateFrame: 'world-z-up', units: 'm' }), axisUp: 'z', axisAligned: true };
  assert.equal(validateInput(inputRef, { taskId: scope.taskId }), true);
  assert.equal(validateInput(inputRef, { taskId: 'other-task' }), false);
});

test('C3 adapter verifies scope and digest and accepts real multiview counts without GPU', async () => {
  await assert.rejects(adapter().preflight({ ...executeArgs, inputRefs: [{ ...inputRef, sha256: '0'.repeat(64) }] }), errorCode('ASSET_DIGEST_MISMATCH'));
  await assert.rejects(adapter({ resolveInput: async () => ({ path: inputPath, manifest: inputManifest({ access: { workspaceId: 'wrong', taskId: scope.taskId, principalIds: [scope.principalId], expiresAt: null } }) }) }).preflight(executeArgs), errorCode('PRIVACY_POLICY_DENIED'));
  assert.equal((await adapter().preflight({ ...executeArgs, inputRefs: Array(6).fill(inputRef) })).ready, true);
});

test('C4 resource budget and output byte limits are enforced', async () => {
  await assert.rejects(adapter().preflight({ ...executeArgs, limits: { maxVramBytes: 0 } }), errorCode('RESOURCE_BUDGET_EXCEEDED'));
  await assert.rejects(adapter().execute({ ...executeArgs, limits: { maxWallMs: 5000, maxOutputBytes: 50 } }), errorCode('OUTPUT_LIMIT'));
});

async function findChildPids() {
  const pids = [];
  for (const name of await readdir(directory)) {
    try { pids.push(JSON.parse(await readFile(path.join(directory, name, 'child.json'), 'utf8')).pid); } catch {}
  }
  return pids;
}
async function assertChildrenStopped(pids) {
  assert.ok(pids.length > 0, 'fixture must have created a descendant');
  for (const pid of pids) assert.throws(() => process.kill(pid, 0), e => e.code === 'ESRCH');
}
test('C4 timeout kills the entire process tree', async () => {
  await assert.rejects(adapter().execute({ ...executeArgs, config: { hang: true }, limits: { maxWallMs: 600, maxOutputBytes: 1048576 } }), errorCode('PROVIDER_TIMEOUT'));
  await assertChildrenStopped(await findChildPids());
});

test('C4 cancellation kills the entire process tree and acknowledges cleanup', async () => {
  const a = adapter(), controller = new AbortController(), runId = 'cancel-fixture';
  const pending = a.execute({ ...executeArgs, runId, signal: controller.signal, config: { hang: true } });
  const assertion = assert.rejects(pending, errorCode('CAPABILITY_POLICY_CONFLICT'));
  const before = (await findChildPids()).length;
  for (let i = 0; i < 100; i++) { if ((await findChildPids()).length > before) break; await new Promise(r => setTimeout(r, 20)); }
  controller.abort(); await assertion;
  assert.deepEqual(await a.cancel({ runId }), { stopped: true });
  await assertChildrenStopped(await findChildPids());
});

test('C5 successful fixture validates result digest, observation provenance and evidence chain', async () => {
  const result = await adapter().execute(executeArgs);
  assert.equal(result.output.units, 'normalized-relative-depth');
  assert.equal(result.output.provider.modelVersion, 'fixture-v1');
  assert.equal(result.output.products[0].kind, 'relativeDepthRaster');
  assert.equal(result.artifactManifests[0].sourceDigests[0], inputRef.sha256);
  assert.equal(result.evidence.configSha256, sha256({}));
  assert.equal(result.workerResult.resources.peakVramBytes, null);
  for (const config of [{ tamper: true }, { escape: true }]) await assert.rejects(adapter().execute({ ...executeArgs, config }), errorCode('PROVIDER_OUTPUT_INVALID'));
});

test('C2/C8 stable failure prefixes survive worker crashes, other adapters still execute', async () => {
  for (const [failure, code] of Object.entries({ DEPENDENCY_MISSING: 'DEPENDENCY_MISSING', WEIGHTS_MISSING: 'DEPENDENCY_MISSING', ASSET_DIGEST_MISMATCH: 'ASSET_DIGEST_MISMATCH', OUTPUT_LIMIT: 'OUTPUT_LIMIT', DEVICE_UNAVAILABLE: 'CAPABILITY_UNAVAILABLE', MODEL_LOAD_FAILED: 'PROVIDER_UNAVAILABLE', UNKNOWN_FAILURE: 'WORKER_LOST' })) {
    await assert.rejects(adapter().execute({ ...executeArgs, config: { failure } }), e => e.code === code && Buffer.byteLength(e.details.stderr) <= 4096);
  }
  assert.equal((await adapter().execute(executeArgs)).workerResult.ok, true);
});

test('C6 cache key isolates model, weights, dependency lock, input, config and device', () => {
  const base = { inputRefs: [inputRef], roi: null, frameRange: null, providerId: 'vision.hyworld', implementationVersion: '1.0.0', modelVersion: 'wm2', weightsSha256: H, dependencyLockSha256: H, configSha256: H, deviceType: 'cuda', precision: 'bfloat16', seedPolicy: 'fixed-42' };
  for (const [key, value] of Object.entries({ providerId: 'vision.spatiallm', implementationVersion: '1.0.1', modelVersion: 'wm3', weightsSha256: sha256('other-weights'), dependencyLockSha256: sha256('other-lock'), configSha256: sha256('other-config'), deviceType: 'cpu', precision: 'float32', inputRefs: [{ ...inputRef, sha256: sha256('other-input') }] })) assert.notEqual(createCacheKey(base), createCacheKey({ ...base, [key]: value }));
});

test('C7/C8 optional providers are unregistered by default; disabled/uninstalled models leave Economy viable', async () => {
  const registry = new ProviderRegistry();
  assert.deepEqual(registry.list(), []);
  for (const m of [WORLDMIRROR_MANIFEST, SPATIALLM_MANIFEST]) { registry.register(m); assert.equal(registry.get(m.providerId).installation, 'not-installed'); await registry.disable(m.providerId); }
  const resolver = new CapabilityResolver(registry);
  const request = { ...task, inputArtifactIds: [], requiredCapabilities: [], optionalCapabilities: ['vision.depth.relative', 'vision.spatial.semantic'] };
  assert.equal(resolver.resolve(createProfile('economy'), request).plan.status, 'ready');
  for (const m of [WORLDMIRROR_MANIFEST, SPATIALLM_MANIFEST]) await registry.unregister(m.providerId);
  assert.deepEqual(registry.list(), []);
  const imported = spawnSync(process.execPath, ['--input-type=module', '-e', `await import('./index.js'); console.log('CORE_IMPORT_OK')`], { cwd: root, encoding: 'utf8', env: { ...process.env, DSH_BLENDER_PYTHON: '', DSH_BLENDER_MODELS_ROOT: '', DSH_BLENDER_ENGINES_ROOT: '' } });
  assert.equal(imported.status, 0, imported.stderr); assert.match(imported.stdout, /CORE_IMPORT_OK/);
});

test('C9/C10 quality stays unverified, no fabricated benchmark or fine mesh claims', () => {
  for (const m of [WORLDMIRROR_MANIFEST, SPATIALLM_MANIFEST]) {
    assert.notEqual(m.verification.conformance.status, 'passed');
    assert.ok(m.capabilities.every(c => c.qualityTags.includes('quality-unverified')));
    assert.equal(m.verification.conformance.metrics.some(m => /iou|accuracy/i.test(m.name)), false);
  }
  assert.ok(SPATIALLM_MANIFEST.capabilities[0].limitations.includes('residential-training-domain-shift-large-13.5m-atrium'));
});

test('Python CLI rejects digest tampering/missing weights/missing dependency without GPU', { skip: !process.env.DSH_BLENDER_PYTHON }, async () => {
  for (const [worker, providerId, capabilityId] of [['worldmirror_worker.py', 'vision.hyworld', 'vision.depth.relative'], ['spatiallm_worker.py', 'vision.spatiallm', 'vision.spatial.semantic']]) {
    for (const [scenario, prefix] of [['digest', 'ASSET_DIGEST_MISMATCH'], ['weights', 'WEIGHTS_MISSING'], ['dependency', 'DEPENDENCY_MISSING']]) {
      const workDir = await mkdtemp(path.join(directory, 'cli-'));
      const ply = path.join(workDir, 'cloud.ply'); await writeFile(ply, 'ply\nformat ascii 1.0\nend_header\n');
      const input = providerId === 'vision.spatiallm' ? ply : inputPath;
      const request = { providerId, capabilityId, weightsPath: scenario === 'weights' ? path.join(workDir, 'missing') : weightsPath, workDir,
        inputs: [{ artifactId: 'cli-input', path: input, sha256: scenario === 'digest' ? '0'.repeat(64) : sha256(await readFile(input)) }],
        config: { axisUp: 'z', axisAligned: true, inputUnit: 'm' }, budget: { timeoutMs: 5000, maxOutputBytes: 1048576 } };
      const req = path.join(workDir, 'request.json'), out = path.join(workDir, 'result.json'); await writeFile(req, JSON.stringify(request));
      const result = spawnSync(process.env.DSH_BLENDER_PYTHON, ['-S', path.join(root, 'targets/three-d/providers/workers', worker), '--request', req, '--output', out], { encoding: 'utf8', env: { ...process.env, PYTHONDONTWRITEBYTECODE: '1' }, timeout: 10000 });
      assert.notEqual(result.status, 0); assert.match(result.stderr, new RegExp('^' + prefix + ':'));
      await assert.rejects(stat(out), e => e.code === 'ENOENT'); assert.equal(result.stdout, '');
    }
  }
});
