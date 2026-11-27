import { ProviderError, assertContract, sha256, snapshot } from './contracts.js';

const productKinds = {
  'vision.depth.relative': ['relativeDepthRaster'], 'vision.depth.metric': ['metricDepthRaster'],
  'vision.surface.normal': ['normalRaster'], 'vision.camera.intrinsics': ['cameraModel'], 'vision.camera.pose': ['cameraModel'],
  'vision.pointcloud': ['pointCloud'], 'vision.gaussian_splat': ['gaussianSplat'], 'vision.spatial.semantic': ['spatialGraph', 'bbox3d'],
  'vision.mask.segment': ['maskRaster'],
};
function invalid(reason, details = {}) { throw new ProviderError('PROVIDER_OUTPUT_INVALID', reason, details); }
export function assertArtifactAccess(manifest, { workspaceId, taskId, principalId, now = Date.now() }) {
  assertContract('visionArtifactManifest', manifest);
  if (manifest.access.workspaceId !== workspaceId || manifest.access.taskId !== taskId || !manifest.access.principalIds.includes(principalId) || (manifest.access.expiresAt && Date.parse(manifest.access.expiresAt) <= now)) throw new ProviderError('PRIVACY_POLICY_DENIED', 'artifact-access-denied', { artifactId: manifest.artifactId });
  return true;
}
export function validateObservation(observation, { providerManifest, taskId, inputRefs, artifactManifests = [], calibrationEvidenceRefs = [] } = {}) {
  assertContract('visionObservation', observation);
  if (taskId && observation.taskId !== taskId) invalid('observation-task-mismatch');
  if (providerManifest) {
    if (observation.provider.providerId !== providerManifest.providerId || observation.provider.implementationVersion !== providerManifest.implementationVersion || !providerManifest.capabilities.some(c => c.capabilityId === observation.capabilityId)) invalid('observation-provenance-mismatch');
    const required = providerManifest.modelAssets.filter(a => a.required);
    if (required.length && !required.some(a => a.sha256 === observation.provider.weightsSha256 && a.modelVersion === observation.provider.modelVersion)) invalid('observation-model-provenance-mismatch');
  }
  if (inputRefs && sha256(observation.inputs) !== sha256(inputRefs)) invalid('observation-input-digest-mismatch');
  if (observation.status !== 'complete' && (!observation.limitations.length || !observation.unresolved.length)) invalid('incomplete-observation-missing-limitations');
  if (observation.status === 'partial' && !observation.products.length) invalid('partial-observation-no-valid-product');
  if (observation.status === 'failed' && observation.proposals.length) invalid('failed-observation-has-proposals');
  if (observation.capabilityId === 'vision.depth.relative' && observation.units !== 'normalized-relative-depth') invalid('relative-depth-units-invalid');
  if (observation.capabilityId === 'vision.depth.metric' && (observation.units !== 'm' || !calibrationEvidenceRefs.length)) invalid('metric-depth-calibration-required');
  if (['vision.pointcloud', 'vision.gaussian_splat', 'vision.surface.normal', 'vision.depth.metric'].includes(observation.capabilityId) && observation.coordinateFrame === 'unknown') invalid('coordinate-frame-required');
  const seen = new Set();
  for (const product of observation.products) {
    if (seen.has(product.artifactId)) invalid('duplicate-observation-product'); seen.add(product.artifactId);
    if (productKinds[observation.capabilityId] && !productKinds[observation.capabilityId].includes(product.kind)) invalid('capability-product-kind-mismatch');
    const manifest = artifactManifests.find(a => a.artifactId === product.artifactId);
    if (!manifest) invalid('artifact-manifest-missing', { artifactId: product.artifactId });
    assertContract('visionArtifactManifest', manifest);
    for (const key of ['sha256', 'kind', 'encoding', 'width', 'height', 'channels', 'validityMaskArtifactId']) if (manifest[key] !== product[key]) invalid('artifact-product-mismatch', { key, artifactId: product.artifactId });
    if (manifest.providerId !== observation.provider.providerId || manifest.runId !== observation.runId || manifest.coordinateFrame !== observation.coordinateFrame || manifest.units !== observation.units) invalid('artifact-provenance-mismatch');
    for (const input of observation.inputs) if (!manifest.sourceDigests.includes(input.sha256)) invalid('artifact-source-chain-missing');
    if (product.validityMaskArtifactId && !artifactManifests.some(a => a.artifactId === product.validityMaskArtifactId && a.kind === 'maskRaster' && a.width === product.width && a.height === product.height)) invalid('validity-mask-invalid');
    if (product.kind.endsWith('Raster') && (!product.width || !product.height || !product.channels)) invalid('raster-dimensions-required');
  }
  for (const proposal of observation.proposals) {
    if (!proposal.productIds.every(id => seen.has(id)) || !proposal.evidenceIds.length) invalid('proposal-evidence-invalid');
  }
  return snapshot(observation);
}
export async function verifyArtifacts(manifests, { readArtifact, scope, maxOutputBytes = null } = {}) {
  if (typeof readArtifact !== 'function') invalid('artifact-reader-required');
  let outputBytes = 0;
  for (const manifest of manifests) {
    assertArtifactAccess(manifest, scope);
    const bytes = await readArtifact(manifest.artifactId, scope);
    if (!Buffer.isBuffer(bytes) && !(bytes instanceof Uint8Array)) invalid('artifact-bytes-required');
    outputBytes += bytes.byteLength;
    if (maxOutputBytes != null && outputBytes > maxOutputBytes) throw new ProviderError('RESOURCE_BUDGET_EXCEEDED', 'max-output-bytes-exceeded');
    if (bytes.byteLength !== manifest.byteLength || sha256(Buffer.from(bytes)) !== manifest.sha256) invalid('artifact-digest-mismatch', { artifactId: manifest.artifactId });
  }
  return snapshot({ verified: true, outputBytes, artifactIds: manifests.map(m => m.artifactId) });
}
export function createCacheKey({ inputRefs, roi, frameRange, providerId, implementationVersion, modelVersion, weightsSha256, dependencyLockSha256, configSha256, deviceType, precision, seedPolicy }) {
  if ([inputRefs, roi, frameRange, providerId, implementationVersion, modelVersion, weightsSha256, dependencyLockSha256, configSha256, deviceType, precision, seedPolicy].some(v => v === undefined)) invalid('cache-key-field-missing');
  inputRefs.forEach(ref => assertContract('inputRef', ref));
  return sha256({ inputRefs, roi, frameRange, providerId, implementationVersion, modelVersion, weightsSha256, dependencyLockSha256, configSha256, deviceType, precision, seedPolicy });
}
export async function validateCacheHit(entry, options) {
  if (!entry || entry.key !== options.expectedKey || (entry.expiresAt && Date.parse(entry.expiresAt) <= (options.scope?.now ?? Date.now()))) return false;
  try { await verifyArtifacts(entry.artifactManifests, options); return true; } catch { return false; }
}
export function observationToEvidence(observation, { configSha256, adapterVersion, upstreamEvidenceIds = [], kind = 'modelRun' }) {
  assertContract('visionObservation', observation);
  if (observation.status === 'failed') invalid('failed-observation-cannot-be-evidence');
  if (!['modelRun', 'algorithmRun'].includes(kind) || !/^[a-f0-9]{64}$/.test(configSha256) || !adapterVersion) invalid('evidence-provenance-required');
  // This is an evidence candidate. Host SpecStore validation and human review remain separate.
  return snapshot({ kind, producer: observation.provider.providerId, version: `${observation.provider.implementationVersion}/${observation.provider.modelVersion ?? 'algorithm'}/adapter-${adapterVersion}`, runId: observation.runId, configSha256, inputs: upstreamEvidenceIds, artifactRefs: observation.products.map(p => ({ artifactId: p.artifactId, sha256: p.sha256, kind: p.kind })), proposals: observation.proposals.map(p => ({ ...p, origin: p.origin === 'observed' ? 'inferred' : p.origin, review: 'pending' })) });
}
