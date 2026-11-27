import * as fs from 'node:fs/promises';
import path from 'node:path';
import { ArtifactStore, validateArtifactReferences } from './artifact-store.js';
import { applyPatch } from './patch.js';
import { assertPatch, assertScene } from './validation.js';
import { canonicalize, cloneJson, fail, hashJson, parseStrictJson } from './json.js';
import { authorizeRequest, jsonBytes, publishImmutable, readJson, safeDirectory, scopeKey } from './disk.js';

const validSceneId = id => { if (!/^scn_[a-z][a-z0-9_]{0,47}$/.test(id || '')) fail('INVALID_SCENE_ID', 'Invalid scene ID.'); return id; };
const view = transaction => ({ sceneId: transaction.scene.sceneId, revision: transaction.scene.revision, artifactId: transaction.receipt.artifactId, sha256: transaction.receipt.sha256, receiptId: transaction.receipt.receiptId });

/** Immutable transaction files contain snapshot, patch, receipt, tombstones and audit together.
 * Hard-link publication is the cross-process CAS: incomplete temporary files are never revisions.
 * Store directories must be on a local filesystem supporting atomic hard links and fsync.
 */
export class SpecStore {
  constructor({ rootDir, authorize, artifactStore, now = () => new Date(), beforePublish } = {}) {
    if (!rootDir) fail('INVALID_CONFIGURATION', 'SpecStore rootDir is required.');
    this.rootDir = path.resolve(rootDir); this.authorize = authorize; this.now = now; this.beforePublish = beforePublish;
    this.artifactStore = artifactStore || new ArtifactStore({ rootDir: path.join(this.rootDir, 'artifacts'), authorize, now });
  }
  async directory(request) { return safeDirectory(this.rootDir, 'specs', scopeKey(request.workspaceId), validSceneId(request.sceneId)); }
  async transactions(directory) {
    const names = (await fs.readdir(directory)).filter(name => /^[1-9][0-9]*\.json$/.test(name)).sort((a, b) => Number(a.slice(0, -5)) - Number(b.slice(0, -5)));
    const transactions = [];
    for (let index = 0; index < names.length; index++) {
      if (names[index] !== `${index + 1}.json`) fail('STORE_CORRUPT', 'Revision history has a gap.');
      const transaction = await readJson(path.join(directory, names[index]));
      if (transaction.formatVersion !== 1 || transaction.scene?.revision !== index + 1 || hashJson(transaction.scene) !== transaction.receipt?.sha256 || transaction.receipt.sceneId !== transaction.scene.sceneId || transaction.receipt.revision !== transaction.scene.revision || transaction.audit?.sha256 !== transaction.receipt.sha256 || transaction.audit?.baseRevision !== index || (transaction.patch ? hashJson(transaction.patch) !== transaction.receipt.patchHash : index !== 0)) fail('STORE_CORRUPT', 'Revision transaction identity/hash mismatch.');
      transactions.push(transaction);
    }
    return transactions;
  }
  async readInput(request, kind) {
    const objectKey = kind === 'scene' ? 'scene' : 'patch'; const textKey = `${objectKey}Json`;
    const supplied = [request[objectKey] !== undefined, request[textKey] !== undefined, kind === 'scene' && request.artifactId !== undefined].filter(Boolean).length;
    if (supplied !== 1) fail('INVALID_INPUT', `Provide exactly one ${objectKey} input.`);
    if (request[textKey] !== undefined) return parseStrictJson(request[textKey]);
    if (request[objectKey] !== undefined) return cloneJson(request[objectKey]);
    const artifact = await this.artifactStore.get(request); return parseStrictJson(artifact.bytes.toString('utf8'));
  }
  async prepareTransaction(scene, patch, tombstones, request, previous) {
    // Sources are verified under the actual caller's workspace permissions before publication.
    await validateArtifactReferences(scene, this.artifactStore, request);
    const artifact = await this.artifactStore.put({ ...request, sha256: hashJson(scene), bytes: canonicalize(scene), mediaType: 'application/json', metadata: undefined });
    const sha256 = artifact.sha256; const patchHash = patch ? hashJson(patch) : null;
    const receiptId = `rcp_${hashJson({ workspaceId: request.workspaceId, sceneId: scene.sceneId, revision: scene.revision, sha256, patchHash })}`;
    const timestamp = this.now().toISOString();
    const receipt = { sceneId: scene.sceneId, revision: scene.revision, artifactId: artifact.artifactId, sha256, receiptId, ...(patch ? { patchId: patch.patchId, patchHash } : {}), actor: request.actor, timestamp };
    const audit = { sceneId: scene.sceneId, revision: scene.revision, baseRevision: previous?.scene.revision || 0, baseSha256: previous?.receipt.sha256 || null, sha256, patchHash, actor: request.actor, timestamp, ...(request.runId ? { runId: request.runId } : {}), ...(patch ? { declaredAuthor: patch.author } : {}) };
    return { formatVersion: 1, scene, patch, tombstones, receipt, audit };
  }
  async create(request) {
    await authorizeRequest(this.authorize, 'spec:create', request, true);
    const scene = await this.readInput(request, 'scene'); assertScene(scene);
    if (scene.revision !== 1) fail('REVISION_CONFLICT', 'New scenes must start at revision 1.', { currentRevision: 0 });
    if (request.sceneId && request.sceneId !== scene.sceneId) fail('SCENE_ID_MISMATCH', 'Request scene ID does not match snapshot.');
    const scoped = { ...request, sceneId: scene.sceneId }; const directory = await this.directory(scoped);
    const history = await this.transactions(directory);
    if (history.length) {
      if (history[0].receipt.sha256 === hashJson(scene)) return view(history[0]);
      fail('REVISION_CONFLICT', 'Scene already exists with different content.', { currentRevision: history.at(-1).scene.revision });
    }
    const transaction = await this.prepareTransaction(scene, null, [], scoped);
    await authorizeRequest(this.authorize, 'spec:create', scoped, true);
    await validateArtifactReferences(scene, this.artifactStore, scoped);
    const result = await publishImmutable(directory, '1.json', jsonBytes(transaction), { beforePublish: this.beforePublish });
    if (!result.published) {
      const winner = await readJson(result.path);
      if (winner.receipt.sha256 === transaction.receipt.sha256) return view(winner);
      fail('REVISION_CONFLICT', 'Concurrent scene creation won.', { currentRevision: 1 });
    }
    return view(transaction);
  }
  async get(request) {
    await authorizeRequest(this.authorize, 'spec:read', request);
    const history = await this.transactions(await this.directory(request));
    const revision = request.revision ?? history.length;
    if (!Number.isSafeInteger(revision) || revision < 1 || !history[revision - 1]) fail('SCENE_NOT_FOUND', 'Scene revision does not exist.');
    const transaction = history[revision - 1];
    await this.artifactStore.get({ ...request, artifactId: transaction.receipt.artifactId, sha256: transaction.receipt.sha256 });
    return { ...view(transaction), scene: cloneJson(transaction.scene), receipt: cloneJson(transaction.receipt), tombstones: cloneJson(transaction.tombstones) };
  }
  async commit(request) {
    await authorizeRequest(this.authorize, 'spec:commit', request, true);
    const patch = await this.readInput(request, 'patch'); assertPatch(patch);
    if (request.sceneId && request.sceneId !== patch.sceneId) fail('SCENE_ID_MISMATCH', 'Request scene ID does not match patch.');
    const scoped = { ...request, sceneId: patch.sceneId }; const directory = await this.directory(scoped);
    let history = await this.transactions(directory); const patchHash = hashJson(patch);
    const replay = transactions => {
      const prior = transactions.find(transaction => transaction.patch?.patchId === patch.patchId);
      if (!prior) return null;
      if (prior.receipt.patchHash !== patchHash) fail('PATCH_ID_CONFLICT', 'Patch ID was already committed with different canonical content.', { patchId: patch.patchId });
      return view(prior);
    };
    const existing = replay(history); if (existing) return existing;
    const previous = history.at(-1); if (!previous) fail('SCENE_NOT_FOUND', 'Cannot patch an absent scene.');
    const updated = applyPatch(previous.scene, patch, { tombstones: previous.tombstones });
    const transaction = await this.prepareTransaction(updated.scene, patch, updated.tombstones, scoped, previous);
    await authorizeRequest(this.authorize, 'spec:commit', scoped, true);
    await validateArtifactReferences(updated.scene, this.artifactStore, scoped);
    const result = await publishImmutable(directory, `${patch.revision}.json`, jsonBytes(transaction), { beforePublish: this.beforePublish });
    if (!result.published) {
      history = await this.transactions(directory); const retry = replay(history); if (retry) return retry;
      fail('REVISION_CONFLICT', 'Concurrent commit changed the baseline.', { currentRevision: history.at(-1)?.scene.revision || 0 });
    }
    return view(transaction);
  }
  async getReceipt(request) {
    await authorizeRequest(this.authorize, 'spec:audit', request);
    const history = await this.transactions(await this.directory(request));
    const transaction = history.find(item => request.receiptId ? item.receipt.receiptId === request.receiptId : request.patchId ? item.patch?.patchId === request.patchId : item.scene.revision === request.revision);
    if (!transaction) fail('RECEIPT_NOT_FOUND', 'No authorized matching receipt.');
    return { ...cloneJson(transaction.receipt), audit: cloneJson(transaction.audit) };
  }
  async listRevisions(request) {
    await authorizeRequest(this.authorize, 'spec:audit', request);
    return (await this.transactions(await this.directory(request))).map(transaction => ({ ...view(transaction), timestamp: transaction.receipt.timestamp, baseRevision: transaction.audit.baseRevision }));
  }
  async replay(request) {
    await authorizeRequest(this.authorize, 'spec:audit', request);
    const history = await this.transactions(await this.directory(request));
    if (!history.length) fail('SCENE_NOT_FOUND', 'Scene does not exist.');
    let scene = history[0].scene; let tombstones = []; assertScene(scene);
    for (const transaction of history.slice(1)) {
      const updated = applyPatch(scene, transaction.patch, { tombstones });
      if (hashJson(updated.scene) !== transaction.receipt.sha256 || canonicalize(updated.tombstones) !== canonicalize(transaction.tombstones)) fail('STORE_CORRUPT', 'Audit replay differs from committed state.');
      scene = updated.scene; tombstones = updated.tombstones;
    }
    return { ...view(history.at(-1)), scene: cloneJson(scene), tombstones: cloneJson(tombstones), verifiedRevisions: history.length };
  }
}
