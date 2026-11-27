// Local, explicitly invoked evidence harness. No model path is a product default.
import { spawnSync } from 'node:child_process';
import { mkdir, copyFile, readFile, writeFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { createWorldMirrorAdapter } from '../adapters/worldmirror.js';
import { createSpatialLMAdapter } from '../adapters/spatiallm.js';

const mode = process.argv[2];
if (!['worldmirror', 'spatiallm'].includes(mode)) throw new Error('Choose worldmirror or spatiallm');
const gpu = spawnSync('nvidia-smi', ['--query-gpu=memory.used,memory.total', '--format=csv,noheader,nounits'], { encoding: 'utf8' });
if (gpu.status !== 0) throw new Error('nvidia-smi failed: ' + gpu.stderr);
const [usedMiB, totalMiB] = gpu.stdout.trim().split(',').map(Number);
console.error(JSON.stringify({ stage: 'gpu-check', usedMiB, totalMiB }));
if (!Number.isFinite(usedMiB) || usedMiB > 1536) throw new Error('GPU_RESERVED_OR_RESIDUAL_USED_OVER_2_GIB');
const root = fileURLToPath(new URL('../../../..', import.meta.url));
const providerId = mode === 'worldmirror' ? 'vision.hyworld' : 'vision.spatiallm';
const providerDir = path.join(root, 'docs/internal/blender-agent/provider-evidence', providerId);
const inputRoot = process.env.DSH_BLENDER_SMOKE_INPUTS;
if (!inputRoot) throw new Error('DSH_BLENDER_SMOKE_INPUTS required');
const inputDir = path.join(providerDir, 'inputs');
await mkdir(inputDir, { recursive: true });
const filenames = mode === 'worldmirror' ? Array.from({ length: 6 }, (_, i) => `view_0${i}.png`) : [process.env.DSH_SPATIALLM_SMOKE_PLY ?? 'scene_mv_zup.ply'];
const sourceRoot = path.join(inputRoot, mode === 'worldmirror' ? 'multiview_in/views' : 'spatiallm_input');
const scope = { workspaceId: 'provider-local-smoke', taskId: `smoke-${providerId}`, principalId: 'local-smoke-harness' };
const inputs = new Map(), inputRefs = [];
for (const [i, filename] of filenames.entries()) {
  const source = path.join(sourceRoot, filename), target = path.join(inputDir, filename);
  await copyFile(source, target);
  const sha256 = createHash('sha256').update(await readFile(target)).digest('hex');
  const ref = { artifactId: `input-${i}`, sha256, frameIndex: mode === 'worldmirror' ? i : null, regionId: null };
  inputRefs.push(ref);
  const isSpatial = mode === 'spatiallm';
  inputs.set(ref.artifactId, { path: target, axisUp: isSpatial ? 'z' : undefined, axisAligned: isSpatial ? true : undefined,
    manifest: { contractVersion: 1, artifactId: ref.artifactId, kind: isSpatial ? 'pointCloud' : 'report', mime: isSpatial ? 'application/x-ply' : 'image/png', encoding: isSpatial ? 'ply' : 'png', byteLength: (await stat(target)).size, sha256,
      width: null, height: null, channels: null, coordinateFrame: isSpatial ? 'world-z-up' : 'image', units: isSpatial ? 'm' : 'pixel', transformChain: [], validityMaskArtifactId: null, sourceDigests: [sha256], providerId: 'smoke.source', runId: 'source-copy',
      access: { workspaceId: scope.workspaceId, taskId: scope.taskId, principalIds: [scope.principalId], expiresAt: null }, createdAt: new Date().toISOString() } });
}
const create = mode === 'worldmirror' ? createWorldMirrorAdapter : createSpatialLMAdapter;
const adapter = create({ workspaceRoot: root, workRoot: providerDir, scope, resolveInput: async ref => inputs.get(ref.artifactId), licenseAccepted: true });
const config = mode === 'worldmirror' ? { device: 'cuda', targetResolution: Number(process.env.DSH_WORLDMIRROR_RESOLUTION ?? 518), precision: 'bfloat16' } : { device: 'cuda', maxNewTokens: Number(process.env.DSH_SPATIALLM_MAX_TOKENS ?? 4096), seed: 42 };
const startedAt = new Date().toISOString();
async function record(summary) {
  const after = spawnSync('nvidia-smi', ['--query-gpu=memory.used,memory.total', '--format=csv,noheader,nounits'], { encoding: 'utf8' });
  const [afterUsed, afterTotal] = after.stdout.trim().split(',').map(Number);
  summary.gpuAfter = { usedMiB: after.status === 0 ? afterUsed : null, totalMiB: after.status === 0 ? afterTotal : null };
  const json = JSON.stringify(summary, null, 2);
  await writeFile(path.join(providerDir, 'latest-run.json'), json);
  await writeFile(path.join(providerDir, `attempt-${startedAt.replaceAll(/[:.]/g, '-')}.json`), json);
}
try {
  const result = await adapter.execute({ capabilityId: mode === 'worldmirror' ? 'vision.depth.relative' : 'vision.spatial.semantic', inputRefs, config,
    limits: { maxWallMs: mode === 'worldmirror' ? 600000 : 300000, maxOutputBytes: 536870912 } });
  const summary = { providerId, startedAt, checkedAt: new Date().toISOString(), status: 'passed', quality: 'unverified', gpuBefore: { usedMiB, totalMiB },
    workDir: path.relative(root, result.workDir).replaceAll('\\', '/'), sourceRoot, inputCount: inputRefs.length, metrics: result.workerResult.metrics, resources: result.workerResult.resources, limitations: result.workerResult.limitations };
  await record(summary);
  console.log(JSON.stringify(summary));
} catch (error) {
  const summary = { providerId, startedAt, checkedAt: new Date().toISOString(), status: 'failed', quality: 'unverified', gpuBefore: { usedMiB, totalMiB }, inputCount: inputRefs.length,
    code: error.code ?? null, reason: error.details?.reason ?? error.message, details: error.details ?? null, config };
  await record(summary);
  console.error(JSON.stringify(summary)); process.exitCode = 1;
} finally { await adapter.dispose(); }
