import { ProviderError, snapshot, validateManifest, sha256 } from './contracts.js';

const notRun = () => ({ suiteVersion: null, dataset: null, metrics: [], checkedAt: null, status: 'not-run', evidenceRefs: [] });
export function createCapabilityDescriptor(capabilityId, { inputSchemaRef = 'vision.image-input.v1', outputSchemaRef = 'vision.observation.v1', executionMode = 'local-worker', operationTier = 'T3', toolId = 'blender_reference_analyze', opId = capabilityId, estimate = {}, ...overrides } = {}) {
  return snapshot({ capabilityId, contractVersion: 1, inputSchemaRef, outputSchemaRef, executionMode, qualityTags: [], limitations: [], dependsOn: [], routes: [{ operationTier, toolId, opId, preconditions: [], evidenceProduced: ['provider-run', 'artifact-digests'], sideEffectClass: 'artifact-write', riskClass: 'low', fallbacks: [] }], resourceEstimate: { values: estimate, estimateSource: 'unknown', confidenceRange: null, measuredAt: null, unknowns: ['runtime-resources'] }, dataSensitivity: 'workspace', verifiableMetrics: [], ...overrides });
}
export function createManifest(providerId, capabilities, overrides = {}) {
  const manifest = {
    manifestVersion: '1.0.0', providerId, providerType: 'vision', implementationVersion: '1.0.0', contractVersion: 1, support: 'planned', capabilities,
    runtime: { mode: 'local', platforms: ['win32', 'linux'], devices: ['cpu', 'cuda'], entrypoint: 'host-injected-adapter', dependencyLockSha256: null, dependencies: [], maxConcurrency: 1 },
    modelAssets: [], resources: { minRamBytes: null, estimatedPeakRamBytes: null, minVramBytes: null, estimatedPeakVramBytes: null, requiredDiskBytes: null },
    network: { runtimeNetwork: 'disabled-by-default', downloadRequiresUserApproval: true },
    privacy: { inputsLeaveMachine: false, serviceRegion: 'local', retention: 'workspace-policy', trainingUse: 'none', logRedaction: 'no-secrets' },
    costModel: { localCompute: 'measured-at-runtime', remoteRequests: 0, meteredFields: [] },
    lifecycle: ['discover', 'check', 'enable', 'disable', 'health', 'execute', 'cancel', 'dispose'], verification: { smoke: notRun(), conformance: notRun() }, ...overrides,
  };
  validateManifest(manifest); return snapshot(manifest);
}
const candidates = [
];
export const PLANNED_MODEL_MANIFESTS = snapshot(candidates.map(([providerId, assetId, ids, limitations]) => createManifest(providerId, ids.map(id => createCapabilityDescriptor(id, { inputSchemaRef: providerId === 'vision.spatiallm' ? 'vision.pointcloud-input.v1' : 'vision.image-input.v1', limitations, qualityTags: ['candidate', 'not-smoke-tested'] })), { modelAssets: [{ assetId, required: true, modelVersion: null, downloadBytes: null, installedBytes: null, sha256: null, licenseId: 'unknown' }] })));
export function createPlannedAdapter(manifest) {
  return Object.freeze({
    manifest,
    async health() { return { available: false, reason: 'local-smoke-not-passed' }; },
    async preflight() { return { ready: false, reason: 'provider-planned' }; },
    async execute() { throw new ProviderError('PROVIDER_NOT_INSTALLED', 'provider-planned', { providerId: manifest.providerId }); },
    async cancel() {}, async dispose() {},
  });
}
export function registerPlannedModels(registry) {
  return PLANNED_MODEL_MANIFESTS.map(manifest => registry.register(manifest, createPlannedAdapter(manifest)));
}

// Optional local inference: declarations only; no engine import or auto-registration.
const wmSlmVerification = (providerId, checkedAt, dataset) => ({
  smoke: { suiteVersion: 'provider-worker-v1', dataset, metrics: [], checkedAt, status: providerId === 'vision.spatiallm' ? 'failed' : 'passed', evidenceRefs: [`docs/internal/blender-agent/provider-evidence/${providerId}/report.json`] },
  // Operational smoke is separate from benchmark quality; no labeled benchmark was run.
  conformance: { suiteVersion: 'wm-slm-conformance-v1', dataset, metrics: [], checkedAt: '2026-11-26T14:28:44.250Z', status: 'failed', evidenceRefs: [`docs/internal/blender-agent/provider-evidence/${providerId}/report.json`] },
});
export const WORLDMIRROR_MANIFEST = createManifest('vision.hyworld', ['vision.depth.relative', 'vision.surface.normal', 'vision.camera.intrinsics', 'vision.camera.pose', 'vision.pointcloud', 'vision.gaussian_splat'].map(id => createCapabilityDescriptor(id, {
  qualityTags: ['multiview', 'relative-geometry', 'quality-unverified'],
  limitations: ['relative-depth-only', 'metric-scale-unresolved', 'single-image-degenerate-use-multiview-recommended', 'camera-pose-not-calibrated', 'model-relative-coordinate-frame', 'gaussian-splat-is-not-editable-mesh', 'license-territory-excludes-eu-uk-south-korea', 'commercial-license-required-over-1m-mau', 'bfloat16-inference-not-compared-with-float32', 'resource-estimate-measured-six-views-518-only', 'quality-benchmark-not-run'],
})), {
  support: 'supported',
  runtime: { mode: 'local', platforms: ['win32', 'linux'], devices: ['cuda'], entrypoint: 'workers/worldmirror_worker.py', dependencyLockSha256: 'da619c64bc952815b7b969f49b1914a1737b68f3ad5ffbb4705c172ed47b54d5', dependencies: ['python==3.10.22', 'torch==2.4.0+cu124', 'hyworld2==2.0', 'safetensors==0.8.0', 'numpy==1.26.4'], maxConcurrency: 1 },
  modelAssets: [{ assetId: 'hy-worldmirror-2.0/model.safetensors', required: true, modelVersion: 'hy-worldmirror-2.0@9fff06539d3d', downloadBytes: 5053553272, installedBytes: 5053553272, sha256: '9fff06539d3d9e85338d7de1ffb5afffb7739fa5bf4d62b4b7c319b5ecdde54f', licenseId: 'tencent-hy-world-2.0-community' }],
  resources: { minRamBytes: 6694801408, estimatedPeakRamBytes: 8589934592, minVramBytes: 5790074368, estimatedPeakVramBytes: 7247757312, requiredDiskBytes: 5053553272 + 536870912 },
  verification: wmSlmVerification('vision.hyworld', '2026-11-26T14:26:34.556Z', 'local-six-view-synthetic-atrium-518'),
});
export const SPATIALLM_MANIFEST = createManifest('vision.spatiallm', [createCapabilityDescriptor('vision.spatial.semantic', {
  inputSchemaRef: 'vision.pointcloud-input.v1', qualityTags: ['pointcloud-input', 'semantic-layout', 'quality-unverified'],
  limitations: ['metric-z-up-axis-aligned-input-required', 'semantic-boxes-are-not-fine-mesh', 'residential-training-domain-shift-large-13.5m-atrium', 'noncommercial-cc-by-nc-4.0', 'bfloat16-inference-not-compared-with-float32', 'local-atrium-zero-semantic-entities', 'domain-mismatch-residential-model-on-large-hall', 'quality-benchmark-not-run'],
})], {
  support: 'supported',
  runtime: { mode: 'local', platforms: ['win32', 'linux'], devices: ['cuda'], entrypoint: 'workers/spatiallm_worker.py', dependencyLockSha256: '047d02cb6d1541ee3ed6d365aa447cab7698737a9e6237136e2d7ca65fa4531c', dependencies: ['python==3.10.22', 'torch==2.4.0+cu124', 'spatiallm==1.1', 'flash-attn==2.7.4', 'torch-scatter==2.1.2', 'numpy==1.26.4'], maxConcurrency: 1 },
  modelAssets: [{ assetId: 'spatiallm-1.1-qwen-0.5b/model.safetensors', required: true, modelVersion: 'spatiallm-1.1-qwen-0.5b@ed2e1ca161d9', downloadBytes: 2414130784, installedBytes: 2414130784, sha256: 'ed2e1ca161d9ca51342bdee27e801ff7aac4f6ef4b2585f530b7ba657ed8a827', licenseId: 'cc-by-nc-4.0' }],
  resources: { minRamBytes: 4304031744, estimatedPeakRamBytes: 5637144576, minVramBytes: 5109537280, estimatedPeakVramBytes: 6442450944, requiredDiskBytes: 2414130784 + 536870912 },
  verification: wmSlmVerification('vision.spatiallm', '2026-11-26T14:27:30.431Z', 'local-caller-scaled-metric-z-up-atrium-pointcloud'),
});

// Optional local adapters are host-configured; importing manifests never loads models.
const localModelVerification = (providerId, checkedAt) => ({
  // Smoke certifies execution only; conformance retains the quality limitations.
  smoke: { suiteVersion: 'provider-worker-v1', dataset: 'local-reference-image', metrics: [], checkedAt, status: 'passed', evidenceRefs: [`docs/internal/blender-agent/provider-evidence/${providerId}/report.json`] },
  conformance: { suiteVersion: 'blender-provider-moge-sharp@1', dataset: null, metrics: [], checkedAt: '2026-11-26T14:19:23.397Z', status: 'failed', evidenceRefs: [`docs/internal/blender-agent/provider-evidence/${providerId}/report.json`] },
});
export const MOGE3_MANIFEST = createManifest('vision.moge3', ['vision.depth.relative', 'vision.surface.normal', 'vision.camera.intrinsics', 'vision.pointcloud'].map(id => createCapabilityDescriptor(id, { qualityTags: ['single-image', 'relative-geometry', 'quality-unverified'], limitations: ['refiner-disabled-flex_gemm-triton-incompatible', 'metric-scale-unresolved', 'quality-benchmark-not-run'] })), {
  support: 'supported',
  runtime: { mode: 'local', platforms: ['win32', 'linux'], devices: ['cuda', 'cpu'], entrypoint: 'workers/moge3_worker.py', dependencyLockSha256: sha256(['python==3.10.22', 'torch==2.4.0+cu124', 'moge==3@74fbce05', 'numpy==1.26.4', 'Pillow==12.3.0']), dependencies: ['python==3.10.22', 'torch==2.4.0+cu124', 'moge==3@74fbce05', 'numpy==1.26.4', 'Pillow==12.3.0'], maxConcurrency: 1 },
  modelAssets: [{ assetId: 'moge-3-vitl/model.pt', required: true, modelVersion: 'moge-3-vitl@sha256-9b41b7b9f65a', downloadBytes: 1481333394, installedBytes: 1481333394, sha256: '9b41b7b9f65ad80aab7ad686f5e9cc0d1fd33f1964022618dfbcd52fc1fb7925', licenseId: 'mit' }],
  resources: { minRamBytes: 3942838272, estimatedPeakRamBytes: 4294967296, minVramBytes: 1847313408, estimatedPeakVramBytes: 2147483648, requiredDiskBytes: 1481333394 + 268435456 },
  verification: localModelVerification('vision.moge3', '2026-11-26T14:18:54.432Z'),
});
export const SHARP_MANIFEST = createManifest('vision.sharp', [createCapabilityDescriptor('vision.gaussian_splat', { qualityTags: ['single-image', 'gaussian-splat', 'quality-unverified'], limitations: ['gaussian-splat-is-not-editable-mesh', 'scale-unverified', 'gsplat-cuda-renderer-not-validated', 'quality-benchmark-not-run'] })], {
  support: 'supported',
  runtime: { mode: 'local', platforms: ['win32', 'linux'], devices: ['cuda', 'cpu'], entrypoint: 'workers/sharp_worker.py', dependencyLockSha256: sha256(['python==3.10.22', 'torch==2.4.0+cu124', 'sharp==2572gikvuh', 'numpy==1.26.4', 'Pillow==12.3.0']), dependencies: ['python==3.10.22', 'torch==2.4.0+cu124', 'sharp==2572gikvuh', 'numpy==1.26.4', 'Pillow==12.3.0'], maxConcurrency: 1 },
  modelAssets: [{ assetId: 'sharp/sharp_2572gikvuh.pt', required: true, modelVersion: 'sharp@2572gikvuh', downloadBytes: 2809738232, installedBytes: 2809738232, sha256: '94211a75198c47f61fca7d739ba08a215418d8d398d48fddf023baccc24f073d', licenseId: 'apple-ml-research-noncommercial' }],
  resources: { minRamBytes: 6265913344, estimatedPeakRamBytes: 7516192768, minVramBytes: 7408167424, estimatedPeakVramBytes: 8589934592, requiredDiskBytes: 2809738232 + 268435456 },
  verification: localModelVerification('vision.sharp', '2026-11-26T14:19:22.815Z'),
});
