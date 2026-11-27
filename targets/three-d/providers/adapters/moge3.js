import { spawn } from 'node:child_process';
import { createReadStream } from 'node:fs';
import { mkdir, mkdtemp, realpath, readFile, writeFile, stat } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ProviderError, assertContract, sha256 } from '../contracts.js';
import { assertArtifactAccess, validateObservation, observationToEvidence } from '../artifacts.js';
import { MOGE3_MANIFEST } from '../manifests.js';

const kinds = { 'vision.depth.relative': ['relativeDepthRaster'], 'vision.surface.normal': ['normalRaster'], 'vision.camera.intrinsics': ['cameraModel'], 'vision.camera.pose': ['cameraModel'], 'vision.pointcloud': ['pointCloud'], 'vision.gaussian_splat': ['gaussianSplat'], 'vision.spatial.semantic': ['spatialGraph', 'bbox3d'] };
const inside = (root, file) => { const relative = path.relative(root, file); return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative)); };
const fail = (code, reason, details) => new ProviderError(code, reason, details);
async function digest(file) { const hash = createHash('sha256'); for await (const chunk of createReadStream(file)) hash.update(chunk); return hash.digest('hex'); }
function workerError(stderr, details) {
  const prefix = stderr.split(':', 1)[0];
  const codes = { DEPENDENCY_MISSING: 'DEPENDENCY_MISSING', WEIGHTS_MISSING: 'DEPENDENCY_MISSING', ASSET_DIGEST_MISMATCH: 'ASSET_DIGEST_MISMATCH', OUTPUT_LIMIT: 'OUTPUT_LIMIT', DEVICE_UNAVAILABLE: 'CAPABILITY_UNAVAILABLE', MODEL_LOAD_FAILED: 'PROVIDER_UNAVAILABLE' };
  const code = codes[prefix] ?? 'WORKER_LOST';
  const error = fail(code, prefix.toLowerCase().replaceAll('_', '-'), { ...details, stderr: Buffer.from(stderr).subarray(-4096).toString('utf8'), ...(code === 'WORKER_LOST' ? { effectState: 'unknown' } : {}) });
  if (code === 'WORKER_LOST') error.effectState = 'unknown';
  return error;
}

// This factory is explicitly constructed by the host. It never discovers or installs models.
export function createLocalVisionAdapter({ manifest, workerPath, pythonPath = process.env.DSH_BLENDER_PYTHON, weightsPath, workspaceRoot, workRoot, scope, resolveInput, enabled = true, licenseAccepted = false, pythonPaths = [], dependencyModules = [], inputExtensions = ['.png', '.jpg', '.jpeg', '.webp'], maxInputs = 1, weightsFilePath, cameraUnits = 'normalized-image', coordinateFrame = 'camera-opencv-x-right-y-down-z-forward', units = 'relative', env = {} }) {
  if (!manifest || !workerPath) throw new TypeError('manifest and workerPath required');
  const running = new Map(); let busy = false, disposed = false;
  const environment = () => ({ ...process.env, ...env, PYTHONDONTWRITEBYTECODE: '1', PYTHONPATH: [...pythonPaths, process.env.PYTHONPATH].filter(Boolean).join(path.delimiter) });
  async function terminate(child, graceful = false) {
    if (child.exitCode != null || child.signalCode != null) return true;
    const closed = new Promise(resolve => child.once('close', () => resolve(true)));
    if (process.platform === 'win32') {
      // taskkill /T reaches descendants even if the Python process spawned compilers.
      await new Promise(resolve => { const killer = spawn('taskkill', ['/PID', String(child.pid), '/T', ...(graceful ? [] : ['/F'])], { windowsHide: true }); killer.once('error', resolve); killer.once('close', resolve); });
    } else { try { process.kill(-child.pid, graceful ? 'SIGTERM' : 'SIGKILL'); } catch (error) { if (error.code !== 'ESRCH') throw error; } }
    const stopped = await Promise.race([closed, new Promise(resolve => { const timer = setTimeout(() => resolve(false), 3000); timer.unref(); })]);
    if (!stopped && graceful) return terminate(child, false);
    return stopped;
  }
  async function basicCheck(config = {}) {
    if (!enabled || disposed) throw fail('PROVIDER_DISABLED', 'provider-disabled');
    if (!pythonPath) throw fail('DEPENDENCY_MISSING', 'runtime-not-found');
    try { await stat(pythonPath); } catch { throw fail('DEPENDENCY_MISSING', 'runtime-not-found', { pythonPath }); }
    if (!weightsPath) throw fail('DEPENDENCY_MISSING', 'model-asset-missing', { weightsPath });
    try { await stat(weightsPath); } catch { throw fail('DEPENDENCY_MISSING', 'model-asset-missing', { weightsPath }); }
    if (manifest.modelAssets.some(a => a.licenseId !== 'mit') && !licenseAccepted) throw fail('CAPABILITY_POLICY_CONFLICT', 'license-not-accepted');
    if (!manifest.runtime.devices.includes(config.device ?? 'cuda')) throw fail('CAPABILITY_UNAVAILABLE', 'device-unavailable');
  }
  async function inputsFor(inputRefs) {
    if (!workspaceRoot || !scope || typeof resolveInput !== 'function') throw fail('PRIVACY_POLICY_DENIED', 'artifact-scope-required');
    if (!Array.isArray(inputRefs) || inputRefs.length < 1 || inputRefs.length > maxInputs) throw fail('PROVIDER_OUTPUT_INVALID', 'input-count-invalid');
    const root = await realpath(workspaceRoot), inputs = [];
    for (const ref of inputRefs) {
      assertContract('inputRef', ref);
      const source = await resolveInput(ref, scope);
      assertArtifactAccess(source.manifest, scope);
      if (source.manifest.artifactId !== ref.artifactId || source.manifest.sha256 !== ref.sha256) throw fail('ASSET_DIGEST_MISMATCH', 'input-manifest-mismatch');
      if (!path.isAbsolute(source.path)) throw fail('PRIVACY_POLICY_DENIED', 'absolute-input-required');
      const actual = await realpath(source.path);
      if (!inside(root, actual)) throw fail('PRIVACY_POLICY_DENIED', 'input-outside-workspace');
      if (!inputExtensions.includes(path.extname(actual).toLowerCase())) throw fail('PROVIDER_OUTPUT_INVALID', 'input-format-unsupported');
      if (await digest(actual) !== ref.sha256) throw fail('ASSET_DIGEST_MISMATCH', 'input-digest-mismatch');
      inputs.push({ artifactId: ref.artifactId, path: actual, sha256: ref.sha256 });
    }
    return inputs;
  }
  async function invoke(args, { signal, timeoutMs = 120000, maxOutputBytes = 67108864, cwd, runId } = {}) {
    if (signal?.aborted) throw fail('CAPABILITY_POLICY_CONFLICT', 'provider-cancelled');
    let stderr = Buffer.alloc(0), stderrPrefix = '', stdout = Buffer.alloc(0), bytes = 0, abortError, cleanup;
    const child = spawn(pythonPath, args, { cwd, env: { ...environment(), ...(cwd ? { TMP: cwd, TEMP: cwd, TMPDIR: cwd, TORCH_EXTENSIONS_DIR: path.join(cwd, 'torch-extensions'), MPLCONFIGDIR: path.join(cwd, 'matplotlib') } : {}) }, windowsHide: true, detached: process.platform !== 'win32', stdio: ['ignore', 'pipe', 'pipe'] });
    running.set(runId, { child });
    const stop = error => { if (!abortError) { abortError = error; cleanup = terminate(child, error.details?.reason === 'provider-cancelled'); } };
    child.stdout.on('data', chunk => { bytes += chunk.length; stdout = Buffer.concat([stdout, chunk]).subarray(-65536); if (bytes > maxOutputBytes) stop(fail('OUTPUT_LIMIT', 'worker-stdio-limit')); });
    child.stderr.on('data', chunk => { bytes += chunk.length; if (!stderrPrefix.includes('\n') && stderrPrefix.length < 4096) stderrPrefix += chunk.toString('utf8'); stderr = Buffer.concat([stderr, chunk]).subarray(-4096); if (bytes > maxOutputBytes) stop(fail('OUTPUT_LIMIT', 'worker-stdio-limit')); });
    const abort = () => stop(fail('CAPABILITY_POLICY_CONFLICT', 'provider-cancelled'));
    signal?.addEventListener('abort', abort, { once: true });
    const timer = setTimeout(() => stop(fail('PROVIDER_TIMEOUT', 'provider-timeout')), timeoutMs);
    try {
      const code = await new Promise((resolve, reject) => { child.once('error', reject); child.once('close', resolve); });
      await cleanup;
      if (cwd) await writeFile(path.join(cwd, 'stderr.log'), stderr);
      if (abortError) throw abortError;
      if (code !== 0) throw workerError(`${stderrPrefix.split('\n')[0]}\n${stderr}`, { providerId: manifest.providerId, weightsPath });
      return { stdout: stdout.toString('utf8'), stderr: stderr.toString('utf8') };
    } catch (error) { if (error.code === 'ENOENT') throw fail('DEPENDENCY_MISSING', 'runtime-not-found'); throw error; }
    finally { clearTimeout(timer); signal?.removeEventListener('abort', abort); running.delete(runId); }
  }
  const adapter = {
    manifest,
    async health() {
      try {
        await basicCheck();
        // Imports only, never load checkpoints during a cold health probe.
        if (dependencyModules.length) await invoke(['-c', `import importlib,sys\ntry:\n [importlib.import_module(x) for x in ${JSON.stringify(dependencyModules)}]\nexcept ImportError as e:\n print('DEPENDENCY_MISSING: '+str(e),file=sys.stderr);sys.exit(1)`], { runId: `health-${randomUUID()}`, timeoutMs: 30000 });
        return { available: true, quality: 'unverified' };
      } catch (error) { return { available: false, reason: error.details?.reason ?? 'provider-health-failed', code: error.code }; }
    },
    async preflight({ capabilityId, inputRefs, config = {}, limits = {} }) {
      await basicCheck(config);
      if (!manifest.capabilities.some(c => c.capabilityId === capabilityId)) throw fail('CAPABILITY_POLICY_CONFLICT', 'unknown-provider-capability');
      await inputsFor(inputRefs);
      for (const [budget, resource] of [['maxRamBytes', 'estimatedPeakRamBytes'], ['maxVramBytes', 'estimatedPeakVramBytes'], ['maxDiskBytes', 'requiredDiskBytes']]) {
        if (limits[budget] != null && (manifest.resources[resource] == null || limits[budget] < manifest.resources[resource])) throw fail('RESOURCE_BUDGET_EXCEEDED', 'resource-budget-exceeded');
      }
      return { ready: true, estimate: { ramPeakBytes: manifest.resources.estimatedPeakRamBytes, vramPeakBytes: manifest.resources.estimatedPeakVramBytes, diskBytes: manifest.resources.requiredDiskBytes, metering: 'not-metered' } };
    },
    async execute({ runId = randomUUID(), capabilityId, inputRefs, config = {}, limits = {}, signal }) {
      if (busy) throw fail('RESOURCE_BUDGET_EXCEEDED', 'max-concurrency-exceeded');
      busy = true;
      try {
        await adapter.preflight({ capabilityId, inputRefs, config, limits });
        if (signal?.aborted) throw fail('CAPABILITY_POLICY_CONFLICT', 'provider-cancelled');
        const inputs = await inputsFor(inputRefs), root = await realpath(workspaceRoot);
        const destination = path.resolve(workRoot ?? path.join(root, '.provider-runs'));
        await mkdir(destination, { recursive: true });
        if (!inside(root, await realpath(destination))) throw fail('PRIVACY_POLICY_DENIED', 'output-outside-workspace');
        const workDir = await mkdtemp(path.join(destination, 'run-'));
        const weights = manifest.modelAssets.find(a => a.required);
        if (await digest(weightsFilePath ?? ((await stat(weightsPath)).isDirectory() ? path.join(weightsPath, 'model.safetensors') : weightsPath)) !== weights.sha256) throw fail('ASSET_DIGEST_MISMATCH', 'model-asset-digest-mismatch');
        const budget = { timeoutMs: limits.maxWallMs ?? 120000, maxOutputBytes: limits.maxOutputBytes ?? 67108864, maxVramBytes: limits.maxVramBytes ?? null };
        const request = { providerId: manifest.providerId, capabilityId, weightsPath, weightsSha256: weights.sha256, inputs, config, budget, workDir };
        await writeFile(path.join(workDir, 'request.json'), JSON.stringify(request, null, 2));
        const diagnostics = await invoke([workerPath, '--request', path.join(workDir, 'request.json'), '--output', path.join(workDir, 'result.json')], { signal, timeoutMs: budget.timeoutMs, maxOutputBytes: budget.maxOutputBytes, cwd: workDir, runId });
        const lines = diagnostics.stdout.trim().split(/\r?\n/);
        if (lines.length !== 1 || JSON.parse(lines[0]).ok !== true) throw fail('PROVIDER_OUTPUT_INVALID', 'worker-summary-invalid');
        const resultPath = path.join(workDir, 'result.json');
        if ((await stat(resultPath)).size > Math.min(budget.maxOutputBytes, 1048576)) throw fail('OUTPUT_LIMIT', 'result-envelope-limit');
        const workerResult = JSON.parse(await readFile(resultPath, 'utf8'));
        if (workerResult.ok !== true || workerResult.providerId !== manifest.providerId || workerResult.capabilityId !== capabilityId || workerResult.modelVersion !== weights.modelVersion || !Array.isArray(workerResult.artifacts) || !Array.isArray(workerResult.limitations) || !workerResult.metrics || !workerResult.resources) throw fail('PROVIDER_OUTPUT_INVALID', 'worker-envelope-invalid');
        let total = (await stat(resultPath)).size;
        const productRows = [];
        for (const item of workerResult.artifacts) {
          if (typeof item.path !== 'string' || item.path.includes('\\') || item.path.includes(':') || path.isAbsolute(item.path) || !Number.isSafeInteger(item.bytes) || item.bytes < 0 || !/^[a-f0-9]{64}$/.test(item.sha256)) throw fail('PROVIDER_OUTPUT_INVALID', 'worker-artifact-invalid');
          const candidate = path.resolve(workDir, item.path);
          if (!inside(workDir, candidate)) throw fail('PROVIDER_OUTPUT_INVALID', 'artifact-path-escape');
          let filename;
          try {
            filename = await realpath(candidate);
            if (!inside(workDir, filename) || (await stat(filename)).size !== item.bytes || await digest(filename) !== item.sha256) throw fail('PROVIDER_OUTPUT_INVALID', 'artifact-integrity-check-failed');
          } catch (error) { if (error instanceof ProviderError) throw error; throw fail('PROVIDER_OUTPUT_INVALID', 'artifact-integrity-check-failed'); }
          total += item.bytes;
          if (total > budget.maxOutputBytes) throw fail('OUTPUT_LIMIT', 'artifact-output-limit');
          if (item.kind === 'metricDepthRaster') throw fail('PROVIDER_OUTPUT_INVALID', 'metric-calibration-unavailable');
          if (item.kind === 'relativeDepthRaster' && item.unit !== null) throw fail('PROVIDER_OUTPUT_INVALID', 'relative-depth-units-invalid');
          productRows.push({ item, filename });
        }
        const selected = productRows.filter(({ item }) => kinds[capabilityId]?.includes(item.kind));
        if (!selected.length) throw fail('PROVIDER_OUTPUT_INVALID', 'capability-product-missing');
        const createdAt = new Date().toISOString(), frame = coordinateFrame;
        const outputUnits = capabilityId === 'vision.depth.relative' ? 'normalized-relative-depth' : capabilityId === 'vision.surface.normal' ? 'unit-vector' : capabilityId === 'vision.camera.intrinsics' ? cameraUnits : units;
        const artifacts = selected.map(({ item }) => ({ contractVersion: 1, artifactId: `art-${randomUUID()}`, kind: item.kind, mime: item.mediaType, encoding: path.extname(item.path).slice(1), byteLength: item.bytes, sha256: item.sha256, width: item.width ?? null, height: item.height ?? null, channels: item.channels ?? null, coordinateFrame: frame, units: outputUnits, transformChain: [], validityMaskArtifactId: null, sourceDigests: inputRefs.map(r => r.sha256), providerId: manifest.providerId, runId, access: { workspaceId: scope.workspaceId, taskId: scope.taskId, principalIds: [scope.principalId], expiresAt: null }, createdAt }));
        const usage = { wallMs: workerResult.resources.wallMs ?? null, ramPeakBytes: workerResult.resources.peakRamBytes ?? null, vramPeakBytes: workerResult.resources.peakVramBytes ?? null, outputBytes: total, metering: 'not-metered' };
        const output = { contractVersion: 1, observationId: `obs-${randomUUID()}`, taskId: scope.taskId, runId, provider: { providerId: manifest.providerId, implementationVersion: manifest.implementationVersion, modelVersion: weights.modelVersion, weightsSha256: weights.sha256 }, capabilityId, status: workerResult.limitations.length ? 'partial' : 'complete', inputs: inputRefs, coordinateFrame: frame, units: outputUnits, products: artifacts.map(({ artifactId, sha256, kind, encoding, width, height, channels, validityMaskArtifactId }) => ({ artifactId, sha256, kind, encoding, width, height, channels, validityMaskArtifactId })), proposals: [], metrics: Object.entries(workerResult.metrics).filter(([, value]) => Number.isFinite(value) && value >= 0).map(([name, value]) => ({ name, value })), resourceUsage: usage, costActual: usage, limitations: workerResult.limitations, unresolved: workerResult.limitations.length ? ['provider-quality-unverified'] : [], createdAt };
        validateObservation(output, { providerManifest: manifest, taskId: scope.taskId, inputRefs, artifactManifests: artifacts });
        const evidence = observationToEvidence(output, { configSha256: sha256(config), adapterVersion: manifest.implementationVersion });
        await writeFile(path.join(workDir, 'observation.json'), JSON.stringify({ output, artifactManifests: artifacts, evidence }, null, 2));
        return { output, usage, artifactManifests: artifacts, artifactPaths: Object.fromEntries(artifacts.map((a, i) => [a.artifactId, selected[i].filename])), evidence, workerResult, workDir };
      } finally { busy = false; }
    },
    async cancel({ runId }) { const entry = running.get(runId); return { stopped: entry ? await terminate(entry.child, true) : true }; },
    async dispose() { disposed = true; await Promise.all([...running.values()].map(entry => terminate(entry.child, true))); },
  };
  return Object.freeze(adapter);
}

export function createMoGe3Adapter(options = {}) {
  const weightsPath = options.weightsPath ?? (process.env.DSH_BLENDER_MODELS_ROOT ? path.join(process.env.DSH_BLENDER_MODELS_ROOT, 'moge-3-vitl/model.pt') : undefined);
  return createLocalVisionAdapter({ manifest: MOGE3_MANIFEST, workerPath: fileURLToPath(new URL('../workers/moge3_worker.py', import.meta.url)), dependencyModules: ['moge', 'torch', 'numpy', 'PIL'], ...options, weightsPath });
}
