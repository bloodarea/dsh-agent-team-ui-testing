import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, writeFile, readFile, readdir, realpath } from 'node:fs/promises';
import { ProviderRegistry, createManifest, createCapabilityDescriptor, validateManifest, assertContract, sha256, createCacheKey, validateObservation, verifyArtifacts, observationToEvidence, MOGE3_MANIFEST, SHARP_MANIFEST } from '../../targets/three-d/providers/index.js';
import { createLocalVisionAdapter } from '../../targets/three-d/providers/adapters/moge3.js';

const workspaceRoot = fileURLToPath(new URL('../../', import.meta.url));
const evidenceRoot = path.join(workspaceRoot, 'docs/internal/blender-agent/provider-evidence');
const scope = { workspaceId: 'conformance', taskId: 'task-11', principalId: 'human' };
const reason = code => error => error.code === code;
const checks = [];
const C = (id, title, operation) => test(`${id}: ${title}`, async () => { await operation(); checks.push({ id, title, status: 'PASS' }); });
let fixtureRoot;
async function fixture(options = {}) {
  fixtureRoot ??= (async () => { await mkdir(evidenceRoot, { recursive: true }); return mkdtemp(path.join(evidenceRoot, 'moge3-conformance-')); })();
  const root = await fixtureRoot;
  const directory = await mkdtemp(path.join(root, 'case-'));
  const inputPath = path.join(directory, 'input.png'), weightsPath = path.join(directory, 'weights.bin');
  await writeFile(inputPath, 'fixture-input'); await writeFile(weightsPath, 'fixture-weights');
  const ref = { artifactId: 'art-input', sha256: sha256('fixture-input'), frameIndex: null, regionId: null };
  const asset = { assetId: 'fixture', required: true, modelVersion: 'fixture@1', downloadBytes: 15, installedBytes: 15, sha256: sha256('fixture-weights'), licenseId: 'mit' };
  const manifest = createManifest('vision.fixture', [createCapabilityDescriptor('vision.depth.relative')], { support: 'supported', modelAssets: [asset], resources: { minRamBytes: 1, estimatedPeakRamBytes: 1, minVramBytes: 1, estimatedPeakVramBytes: 1, requiredDiskBytes: 1 } });
  const inputManifest = { contractVersion: 1, artifactId: ref.artifactId, kind: 'report', mime: 'image/png', encoding: 'png', byteLength: 13, sha256: ref.sha256, width: 1, height: 1, channels: 3, coordinateFrame: 'image', units: 'pixel', transformChain: [], validityMaskArtifactId: null, sourceDigests: [], providerId: 'vision.fixture', runId: 'input-import', access: { workspaceId: scope.workspaceId, taskId: scope.taskId, principalIds: [scope.principalId], expiresAt: null }, createdAt: new Date().toISOString() };
  const factory = overrides => createLocalVisionAdapter({ manifest, workerPath: fileURLToPath(new URL('../../targets/three-d/providers/workers/moge3_fixture_worker.mjs', import.meta.url)), pythonPath: process.execPath, weightsPath, workspaceRoot, workRoot: directory, scope, resolveInput: async () => ({ path: inputPath, manifest: inputManifest }), ...options, ...overrides });
  return { root: directory, inputPath, weightsPath, ref, inputManifest, manifest, factory, args: { capabilityId: 'vision.depth.relative', inputRefs: [ref], config: { device: 'cpu' }, limits: { maxWallMs: 10000, maxOutputBytes: 100000 } } };
}

C('C1', 'manifest/schema/capability/version and exact model provenance', async () => {
  for (const manifest of [MOGE3_MANIFEST, SHARP_MANIFEST]) {
    assert.equal(validateManifest(manifest).manifest.support, 'supported');
    assert.equal(manifest.runtime.maxConcurrency, 1); assert.equal(manifest.privacy.inputsLeaveMachine, false);
    assert.equal(manifest.modelAssets[0].sha256.length, 64); assert.ok(manifest.modelAssets[0].installedBytes > 1000000000);
    assert.ok(!path.isAbsolute(manifest.modelAssets[0].assetId));
    for (const verification of Object.values(manifest.verification)) for (const ref of verification.evidenceRefs) assert.ok(await realpath(path.join(workspaceRoot, ref)));
    assert.throws(() => validateManifest({ ...manifest, contractVersion: 999 }));
  }
  assert.deepEqual(MOGE3_MANIFEST.capabilities.map(c => c.capabilityId), ['vision.depth.relative', 'vision.surface.normal', 'vision.camera.intrinsics', 'vision.pointcloud']);
  assert.equal(SHARP_MANIFEST.modelAssets[0].licenseId, 'apple-ml-research-noncommercial');
});

C('C2', 'missing runtime/weights/dependency, disabled, device and license errors', async () => {
  const f = await fixture();
  for (const [options, code] of [[{ enabled: false }, 'PROVIDER_DISABLED'], [{ pythonPath: path.join(f.root, 'missing.exe') }, 'DEPENDENCY_MISSING'], [{ weightsPath: path.join(f.root, 'missing.pt') }, 'DEPENDENCY_MISSING'], [{ manifest: SHARP_MANIFEST }, 'CAPABILITY_POLICY_CONFLICT']]) await assert.rejects(f.factory(options).execute(f.args), reason(code));
  await assert.rejects(f.factory().execute({ ...f.args, config: { device: 'invalid' } }), reason('CAPABILITY_UNAVAILABLE'));
  if (process.env.DSH_BLENDER_PYTHON) {
    const missing = await f.factory({ pythonPath: process.env.DSH_BLENDER_PYTHON, dependencyModules: ['dsh_intentionally_absent_conformance_package'] }).health();
    assert.equal(missing.available, false); assert.equal(missing.code, 'DEPENDENCY_MISSING');
  }
  for (const [prefix, code] of [['DEPENDENCY_MISSING', 'DEPENDENCY_MISSING'], ['WEIGHTS_MISSING', 'DEPENDENCY_MISSING'], ['ASSET_DIGEST_MISMATCH', 'ASSET_DIGEST_MISMATCH'], ['OUTPUT_LIMIT', 'OUTPUT_LIMIT'], ['DEVICE_UNAVAILABLE', 'CAPABILITY_UNAVAILABLE'], ['MODEL_LOAD_FAILED', 'PROVIDER_UNAVAILABLE'], ['OTHER', 'WORKER_LOST']]) {
    await assert.rejects(f.factory().execute({ ...f.args, config: { fixture: `fail:${prefix}` } }), error => { assert.equal(error.code, code); assert.ok(Buffer.byteLength(error.details.stderr) <= 4096); if (prefix === 'OTHER') assert.equal(error.effectState, 'unknown'); return true; });
  }
});

C('C3', 'input ACL, scope, summary, extension and weight digest fail closed', async () => {
  const f = await fixture();
  await assert.rejects(f.factory({ scope: { ...scope, taskId: 'intruder' } }).execute(f.args), reason('PRIVACY_POLICY_DENIED'));
  await assert.rejects(f.factory({ workspaceRoot: f.root, resolveInput: async () => ({ path: process.execPath, manifest: f.inputManifest }) }).execute(f.args), reason('PRIVACY_POLICY_DENIED'));
  await writeFile(f.inputPath, 'changed');
  await assert.rejects(f.factory().execute(f.args), reason('ASSET_DIGEST_MISMATCH'));
  await writeFile(f.inputPath, 'fixture-input'); await writeFile(f.weightsPath, 'changed');
  await assert.rejects(f.factory().execute(f.args), reason('ASSET_DIGEST_MISMATCH'));
  const g = await fixture();
  await assert.rejects(g.factory({ inputExtensions: ['.ply'] }).execute(g.args), reason('PROVIDER_OUTPUT_INVALID'));
  if (process.env.DSH_BLENDER_PYTHON) for (const manifest of [MOGE3_MANIFEST, SHARP_MANIFEST]) {
    const report = JSON.parse(await readFile(path.join(evidenceRoot, manifest.providerId, 'report.json'), 'utf8'));
    const successful = report.runs.findLast(row => row.status === 'partial');
    const request = JSON.parse(await readFile(path.join(evidenceRoot, manifest.providerId, successful.runDir, 'request.json'), 'utf8'));
    for (const [changes, prefix] of [[{ inputs: request.inputs.map(input => ({ ...input, sha256: '0'.repeat(64) })) }, 'ASSET_DIGEST_MISMATCH:'], [{ weightsPath: path.join(g.root, 'missing-weight.pt') }, 'WEIGHTS_MISSING:']]) {
      const workDir = await mkdtemp(path.join(g.root, 'cli-'));
      const requestPath = path.join(workDir, 'request.json'), resultPath = path.join(workDir, 'result.json');
      await writeFile(requestPath, JSON.stringify({ ...request, ...changes, workDir }));
      assert.throws(() => execFileSync(process.env.DSH_BLENDER_PYTHON, [path.join(workspaceRoot, 'targets/three-d/providers', manifest.runtime.entrypoint), '--request', requestPath, '--output', resultPath], { encoding: 'utf8', stdio: 'pipe', env: { ...process.env, PYTHONDONTWRITEBYTECODE: '1' } }), error => { assert.equal(error.status, 1); assert.ok(error.stderr.startsWith(prefix)); assert.equal(error.stdout, ''); return true; });
      await assert.rejects(readFile(resultPath), error => error.code === 'ENOENT');
    }
  }
});

C('C4', 'budgets, timeout/cancel process trees, concurrency and output limit', async () => {
  const f = await fixture();
  await assert.rejects(f.factory().execute({ ...f.args, limits: { maxRamBytes: 0 } }), reason('RESOURCE_BUDGET_EXCEEDED'));
  await assert.rejects(f.factory().execute({ ...f.args, limits: { maxOutputBytes: 1000 }, config: { fixture: 'flood' } }), reason('OUTPUT_LIMIT'));
  const a = f.factory();
  await assert.rejects(a.execute({ ...f.args, limits: { maxWallMs: 500 }, config: { fixture: 'tree' } }), reason('PROVIDER_TIMEOUT'));
  const runs = (await readdir(f.root)).filter(name => name.startsWith('run-'));
  const childPids = [];
  for (const run of runs) { try { childPids.push(Number(await readFile(path.join(f.root, run, 'child.pid'), 'utf8'))); } catch {} }
  assert.ok(childPids.length > 0, 'timeout fixture actually spawned a child');
  for (const pid of childPids) assert.throws(() => process.kill(pid, 0), { code: 'ESRCH' });
  const controller = new AbortController(), b = f.factory();
  const pending = b.execute({ ...f.args, signal: controller.signal, config: { fixture: 'tree' } });
  const cancellationTimer = setTimeout(() => controller.abort(), 500);
  try {
    await assert.rejects(b.execute(f.args), reason('RESOURCE_BUDGET_EXCEEDED'));
    await assert.rejects(pending, reason('CAPABILITY_POLICY_CONFLICT'));
  } finally { clearTimeout(cancellationTimer); await b.dispose(); }
  for (const run of (await readdir(f.root)).filter(name => name.startsWith('run-'))) { try { const pid = Number(await readFile(path.join(f.root, run, 'child.pid'), 'utf8')); assert.throws(() => process.kill(pid, 0), { code: 'ESRCH' }); } catch (error) { if (error.code !== 'ENOENT') throw error; } }
});

C('C5', 'output integrity, evidence chain, configuration and model provenance', async () => {
  const f = await fixture(), result = await f.factory().execute(f.args);
  assertContract('visionObservation', result.output);
  assert.equal(result.output.units, 'normalized-relative-depth'); assert.equal(result.output.coordinateFrame, 'camera-opencv-x-right-y-down-z-forward');
  validateObservation(result.output, { providerManifest: f.manifest, inputRefs: [f.ref], artifactManifests: result.artifactManifests });
  assert.equal((await verifyArtifacts(result.artifactManifests, { readArtifact: artifactId => readFile(result.artifactPaths[artifactId]), scope })).verified, true);
  const evidence = observationToEvidence(result.output, { configSha256: sha256(f.args.config), adapterVersion: '1.0.0' });
  assert.equal(evidence.runId, result.output.runId); assert.ok(evidence.version.includes('fixture@1')); assert.equal(evidence.configSha256, sha256(f.args.config));
  for (const fixture of ['tamper', 'wrong-kind', 'escape']) await assert.rejects(f.factory().execute({ ...f.args, config: { fixture } }), error => {
    assert.equal(error.code, 'PROVIDER_OUTPUT_INVALID');
    if (fixture === 'escape') assert.equal(error.details.reason, 'artifact-path-escape', '../outside.npy must be rejected lexically before realpath');
    return true;
  });
});

C('C6', 'cache isolates provider/model/weights/device/config/dependency versions', async () => {
  const f = await fixture(), base = { inputRefs: [f.ref], roi: null, frameRange: null, providerId: 'vision.moge3', implementationVersion: '1.0.0', modelVersion: 'moge@1', weightsSha256: sha256('weights'), dependencyLockSha256: sha256('lock'), configSha256: sha256({}), deviceType: 'cpu', precision: 'fp32', seedPolicy: '0' };
  for (const [field, changed] of [['providerId', 'vision.sharp'], ['implementationVersion', '2.0.0'], ['modelVersion', 'moge@2'], ['weightsSha256', sha256('new')], ['dependencyLockSha256', sha256('new')], ['configSha256', sha256('new')], ['deviceType', 'cuda']]) assert.notEqual(createCacheKey(base), createCacheKey({ ...base, [field]: changed }));
});

C('C7', 'Core import remains cold with absent model runtime and no worker spawn', async () => {
  const script = `import child from 'node:child_process'; import {syncBuiltinESMExports} from 'node:module'; let calls=0; child.spawn=()=>{calls++;throw Error('unexpected worker')}; syncBuiltinESMExports(); const p=await import(${JSON.stringify(new URL('../../targets/three-d/providers/index.js', import.meta.url).href)}); const r=new p.ProviderRegistry(); if(r.list().length!==0||calls!==0) throw Error('not cold'); console.log('cold-import-no-worker');`;
  assert.match(execFileSync(process.execPath, ['--input-type=module', '-e', script], { encoding: 'utf8', env: { ...process.env, DSH_BLENDER_PYTHON: '', DSH_BLENDER_MODELS_ROOT: '' } }), /cold-import-no-worker/);
});

C('C8', 'optional absent/disabled/crashing provider leaves unrelated registry intact', async () => {
  const registry = new ProviderRegistry();
  registry.register(MOGE3_MANIFEST); assert.equal(registry.get('vision.moge3').installation, 'not-installed');
  const stable = createManifest('geometry.stable', [createCapabilityDescriptor('geometry.primitive.fit')], { support: 'supported', resources: { minRamBytes: 0, estimatedPeakRamBytes: 0, minVramBytes: 0, estimatedPeakVramBytes: 0, requiredDiskBytes: 0 } });
  registry.register(stable, { health: async () => ({ available: true }) }, { installation: 'bundled', enabled: true });
  await registry.health('geometry.stable'); await registry.disable('vision.moge3');
  const f = await fixture(); await assert.rejects(f.factory().execute({ ...f.args, config: { fixture: 'fail:OTHER' } }), reason('WORKER_LOST'));
  assert.equal(registry.get('geometry.stable').availability, 'available'); assert.equal(registry.get('vision.moge3').reason, 'provider-disabled');
});

C('C9', 'real artifacts are measured, benchmark quality remains explicitly unknown', async () => {
  // Explicit local run mode starts the genuine Python workers serially; default revalidates saved evidence.
  if (process.env.DSH_PROVIDER_RUN_REAL === '1') {
    const { runSmoke } = await import('../../docs/internal/blender-agent/provider-evidence/moge3_smoke.mjs');
    await runSmoke({ pythonPath: process.env.DSH_BLENDER_PYTHON, modelsRoot: process.env.DSH_BLENDER_MODELS_ROOT, sharpSource: process.env.DSH_SHARP_SOURCE, imagePath: process.env.DSH_PROVIDER_SMOKE_IMAGE, workspaceRoot, evidenceRoot });
  }
  for (const manifest of [MOGE3_MANIFEST, SHARP_MANIFEST]) {
    const root = path.join(evidenceRoot, manifest.providerId), report = JSON.parse(await readFile(path.join(root, 'report.json'), 'utf8'));
    assert.equal(report.quality, 'unverified'); assert.equal(report.verdict, 'partial');
    assert.ok(report.runs.some(r => r.status === 'partial' && r.metrics.inferenceMs > 0));
    const run = report.runs.find(r => r.status === 'partial'), result = JSON.parse(await readFile(path.join(root, run.runDir, 'result.json'), 'utf8'));
    assert.equal(result.modelVersion, manifest.modelAssets[0].modelVersion);
    for (const item of result.artifacts) { const bytes = await readFile(path.join(root, run.runDir, item.path)); assert.equal(bytes.length, item.bytes); assert.equal(sha256(bytes), item.sha256); }
    assert.ok(report.resources.gpuBefore.memoryMiB[0] < 3584); assert.ok(report.resources.gpuAfter.memoryMiB[0] < 3584);
    if (manifest.providerId === 'vision.moge3') { assert.ok(result.limitations.includes('refiner-disabled-flex_gemm-triton-incompatible')); assert.equal(result.artifacts.find(a => a.kind === 'relativeDepthRaster').unit, null); }
    else { assert.equal(result.artifacts[0].kind, 'gaussianSplat'); assert.ok(result.limitations.includes('gsplat-cuda-renderer-not-validated')); }
  }
});

C('C10', 'no quality verification claim without benchmark and calibrated thresholds', async () => {
  for (const m of [MOGE3_MANIFEST, SHARP_MANIFEST]) {
    assert.notEqual(m.verification.conformance.status, 'passed');
    assert.ok(m.capabilities.every(c => c.qualityTags.includes('quality-unverified')));
    const r = new ProviderRegistry(); r.register(m, { health: async () => ({ available: true }) }, { installation: 'installed', enabled: true }); assert.notEqual(r.get(m.providerId).quality, 'verified');
    // Availability is tested by the Registry suite; uncertified quality must never become verified here.
  }
});

after(async () => {
  for (const providerId of ['vision.moge3', 'vision.sharp']) {
    const filename = path.join(evidenceRoot, providerId, 'report.json');
    try {
      const report = JSON.parse(await readFile(filename, 'utf8'));
      const measuredRun = report.runs.findLast(run => run.status === 'partial');
      if (measuredRun) report.resources = { ...report.resources, ...measuredRun.resources };
      if (process.env.DSH_BLENDER_PYTHON) report.runtime = { pythonPath: process.env.DSH_BLENDER_PYTHON, modelsRoot: process.env.DSH_BLENDER_MODELS_ROOT ?? null, sharpSource: process.env.DSH_SHARP_SOURCE ?? null, node: process.version, platform: process.platform };
      report.checks = checks.map(item => item.id === 'C9' ? { ...item, status: 'UNKNOWN', reason: 'No ground-truth benchmark dataset; inference/integrity assertions pass but accuracy thresholds unmeasured.' } : item);
      report.conformance = { checkedAt: new Date().toISOString(), suite: 'blender-provider-moge-sharp@1', status: 'partial', protocolAssertionsPassed: checks.length === 10, benchmark: 'UNKNOWN', quality: 'unverified' };
      await writeFile(filename, JSON.stringify(report, null, 2));
    } catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
});
