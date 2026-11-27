import path from 'node:path';
import { authorizeRequest, publishImmutable, readJson, readRegular, safeDirectory, scopeKey, jsonBytes } from './disk.js';
import { cloneJson, fail, sha256 as digest } from './json.js';

export function artifactIdForSha256(sha256) {
  if (!/^[a-f0-9]{64}$/.test(sha256)) fail('INVALID_DIGEST', 'Expected a lowercase SHA-256 digest.');
  // A letter plus 188 digest bits fit the 48-character suffix; full SHA is always rechecked.
  return `art_h${sha256.slice(0, 47)}`;
}
export class ArtifactStore {
  constructor({ rootDir, authorize, now = () => new Date(), maxBytes = 64 * 1024 * 1024, beforePublish } = {}) {
    if (!rootDir) fail('INVALID_CONFIGURATION', 'ArtifactStore rootDir is required.');
    this.rootDir = path.resolve(rootDir); this.authorize = authorize; this.now = now; this.maxBytes = maxBytes; this.beforePublish = beforePublish;
  }
  async put(request) {
    await authorizeRequest(this.authorize, 'artifact:write', request, true);
    if (!Buffer.isBuffer(request.bytes) && !(request.bytes instanceof Uint8Array) && typeof request.bytes !== 'string') fail('INVALID_ARTIFACT', 'Artifact bytes must be a buffer, typed byte array or UTF-8 text.');
    const bytes = Buffer.from(request.bytes);
    if (bytes.length > this.maxBytes) fail('RESOURCE_LIMIT', 'Artifact byte budget exceeded.');
    if (typeof request.mediaType !== 'string' || !/^[a-z0-9][a-z0-9.+-]*\/[a-z0-9][a-z0-9.+-]*(?:; ?charset=utf-8)?$/i.test(request.mediaType)) fail('INVALID_ARTIFACT', 'A bounded media type is required.');
    const sha256 = digest(bytes); const artifactId = artifactIdForSha256(sha256);
    if (request.sha256 && request.sha256 !== sha256) fail('ASSET_DIGEST_MISMATCH', 'Input artifact digest mismatch.');
    const now = this.now(); const retentionUntil = request.retentionUntil || new Date(now.getTime() + 30 * 86400000).toISOString();
    if (!Number.isFinite(Date.parse(retentionUntil)) || Date.parse(retentionUntil) <= now.getTime()) fail('INVALID_RETENTION', 'Artifact retention must be a future UTC timestamp.');
    const blobDirectory = await safeDirectory(this.rootDir, 'blobs', sha256.slice(0, 2));
    const blob = await publishImmutable(blobDirectory, sha256, bytes);
    if (!blob.published && digest(await readRegular(blob.path, { maxBytes: this.maxBytes })) !== sha256) fail('ASSET_DIGEST_MISMATCH', 'Existing content-addressed blob is corrupt.');
    const directory = await safeDirectory(this.rootDir, 'workspaces', scopeKey(request.workspaceId));
    const record = { artifactId, sha256, mediaType: request.mediaType, byteLength: bytes.length, retentionUntil, metadata: cloneJson(request.metadata || {}) };
    const published = await publishImmutable(directory, `${artifactId}.json`, jsonBytes(record), { beforePublish: this.beforePublish });
    const stored = published.published ? record : await readJson(published.path);
    if (stored.sha256 !== sha256 || stored.byteLength !== bytes.length) fail('ARTIFACT_ID_CONFLICT', 'Stable artifact ID conflicts with a different full digest.');
    if (stored.mediaType !== request.mediaType || (request.metadata !== undefined && JSON.stringify(stored.metadata) !== JSON.stringify(record.metadata))) {
      // Canonical comparison tolerates caller object member ordering.
      if (!jsonBytes({ mediaType: stored.mediaType, metadata: stored.metadata }).equals(jsonBytes({ mediaType: record.mediaType, metadata: record.metadata }))) fail('ARTIFACT_METADATA_CONFLICT', 'The same immutable bytes have conflicting metadata.');
    }
    if (Date.parse(stored.retentionUntil) <= now.getTime()) fail('ASSET_EXPIRED', 'Artifact retention expired.');
    return cloneJson(stored);
  }
  async get(request) {
    await authorizeRequest(this.authorize, 'artifact:read', request);
    if (!/^art_[a-z][a-z0-9_]{0,47}$/.test(request.artifactId || '')) fail('ASSET_UNAVAILABLE', 'Invalid or unavailable artifact ID.');
    const directory = await safeDirectory(this.rootDir, 'workspaces', scopeKey(request.workspaceId));
    let record;
    try { record = await readJson(path.join(directory, `${request.artifactId}.json`)); }
    catch (error) { if (error.code === 'ENOENT') fail('ASSET_UNAVAILABLE', 'Artifact is unavailable in this workspace.'); throw error; }
    if (record.artifactId !== request.artifactId || artifactIdForSha256(record.sha256) !== record.artifactId) fail('ASSET_DIGEST_MISMATCH', 'Artifact metadata identity mismatch.');
    if (!Number.isFinite(Date.parse(record.retentionUntil)) || Date.parse(record.retentionUntil) <= this.now().getTime()) fail('ASSET_EXPIRED', 'Artifact retention expired.');
    if (request.sha256 && request.sha256 !== record.sha256) fail('ASSET_DIGEST_MISMATCH', 'Requested artifact digest mismatch.');
    const blobDirectory = await safeDirectory(this.rootDir, 'blobs', record.sha256.slice(0, 2));
    let bytes;
    try { bytes = await readRegular(path.join(blobDirectory, record.sha256), { maxBytes: this.maxBytes }); }
    catch (error) { if (error.code === 'ENOENT') fail('ASSET_UNAVAILABLE', 'Artifact bytes are unavailable.'); throw error; }
    if (bytes.length !== record.byteLength || digest(bytes) !== record.sha256) fail('ASSET_DIGEST_MISMATCH', 'Artifact byte length or SHA-256 mismatch.');
    return { ...cloneJson(record), bytes };
  }
  async resolve(request) { return this.get(request); }
}

export async function validateArtifactReferences(scene, artifactStore, context) {
  for (const [id, source] of Object.entries(scene.sources)) {
    const artifact = await artifactStore.get({ ...context, artifactId: source.artifactId, sha256: source.sha256 });
    if (source.kind === 'referenceImage' && artifact.mediaType !== 'image/png') fail('ASSET_MISMATCH', 'Reference images must be normalized RGBA PNG artifacts.', { instancePath: `/sources/${id}/artifactId` });
    if (source.widthPx && (artifact.metadata.widthPx !== source.widthPx || artifact.metadata.heightPx !== source.heightPx)) fail('ASSET_MISMATCH', 'Source dimensions do not match verified artifact metadata.', { instancePath: `/sources/${id}`, expected: `${source.widthPx}x${source.heightPx}`, actual: `${artifact.metadata.widthPx}x${artifact.metadata.heightPx}` });
    if (source.kind === 'rasterProduct') {
      const metadata = artifact.metadata;
      if (metadata.channel !== source.channel || metadata.encoding !== source.encoding || !metadata.alignment?.derivedToSource || !metadata.alignment?.sourceSha256) fail('ASSET_MISMATCH', 'Raster needs channel, encoding and source pixel registration metadata.', { instancePath: `/sources/${id}` });
      const image = Object.values(scene.sources).find(record => record.kind === 'referenceImage' && record.sha256 === metadata.alignment.sourceSha256);
      if (!image) fail('ASSET_MISMATCH', 'Raster registration references an unknown image digest.', { instancePath: `/sources/${id}` });
    }
  }
}
