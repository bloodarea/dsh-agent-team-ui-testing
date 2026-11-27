import { applyPatch } from './patch.js';
import { assertScene, collectClaimSlots, COLLECTIONS, tombstoneIds } from './validation.js';
import { canonicalize, cloneJson, fail, getPointer, hashJson, pointerTokens, setPointer } from './json.js';

export function emptyScene(sceneId) {
  return { kind: 'scene', schemaVersion: '1.0.0', sceneId, revision: 1, frame: { handedness: 'right', up: '+Z', cameraForward: '-Z', cameraUp: '+Y', angle: 'rad', rotation: 'quaternionWXYZ', scale: { mode: 'relative' } }, ...Object.fromEntries(COLLECTIONS.map(name => [name, {}])) };
}
export function claimIdForTarget(target, { occupied = {}, tombstones = [] } = {}) {
  const canonical = `/${pointerTokens(target).map(token => token.replace(/~/g, '~0').replace(/\//g, '~1')).join('/')}`;
  const digest = hashJson(canonical); const dead = tombstoneIds(tombstones);
  let slug = pointerTokens(canonical).join('_').toLowerCase().replace(/[^a-z0-9_]/g, '_').replace(/_+/g, '_');
  if (!/^[a-z]/.test(slug)) slug = `slot_${slug}`;
  for (let length = 8; length <= 46; length += 2) {
    const id = `clm_${slug.slice(0, 47 - length)}_${digest.slice(0, length)}`;
    if (!dead.has(id) && (!Object.hasOwn(occupied, id) || occupied[id].target === canonical)) return id;
  }
  fail('ID_ALLOCATION_CONFLICT', 'Cannot allocate a collision-free claim ID.', { instancePath: target });
}
export function buildPatch(scene, baseRevision, changes, { patchId, author, reason, tombstones = [] } = {}) {
  if (baseRevision !== scene.revision) fail('REVISION_CONFLICT', 'Patch helper requires the actual baseline revision.', { currentRevision: scene.revision });
  if (!Array.isArray(changes) || !changes.length) fail('INVALID_PATCH', 'At least one whole-record operation is required.');
  const patch = { kind: 'patch', schemaVersion: '1.0.0', sceneId: scene.sceneId, patchId: patchId || `pch_h${hashJson({ sceneId: scene.sceneId, baseRevision, changes, author, reason }).slice(0, 47)}`, baseRevision, revision: baseRevision + 1, author, reason, ops: cloneJson(changes) };
  applyPatch(scene, patch, { tombstones }); return patch;
}
export class SpecBuilder {
  constructor(input, { tombstones = [] } = {}) {
    this.scene = typeof input === 'string' ? emptyScene(input) : cloneJson(input);
    this.base = cloneJson(this.scene); this.tombstones = [...tombstoneIds(tombstones)];
  }
  addRecord(collection, id, record) {
    if (typeof id !== 'string') { record = id; id = `${collection === 'sources' ? 'src' : 'ev'}_h${hashJson(record).slice(0, 47)}`; }
    if (tombstoneIds(this.tombstones).has(id)) fail('TOMBSTONE_REUSE', 'Cannot reuse a deleted record ID.', { relatedIds: [id] });
    const previous = this.scene[collection][id];
    if (previous && canonicalize(previous) !== canonicalize(record)) fail('IMMUTABLE_RECORD', 'Sources/evidence are append-only.', { relatedIds: [id] });
    this.scene[collection][id] = cloneJson(record); return id;
  }
  addSource(id, record) { return this.addRecord('sources', id, record); }
  addEvidence(id, record) { return this.addRecord('evidence', id, record); }
  ensureClaim(target, value, meta = {}) {
    pointerTokens(target);
    const existing = getPointer(this.scene, target);
    const byTarget = Object.entries(this.scene.claims).find(([, claim]) => claim.target === target)?.[0];
    const id = (typeof existing === 'string' && this.scene.claims[existing]?.target === target ? existing : byTarget) || claimIdForTarget(target, { occupied: this.scene.claims, tombstones: this.tombstones });
    if (tombstoneIds(this.tombstones).has(id)) fail('TOMBSTONE_REUSE', 'Cannot reuse a deleted claim ID.');
    const status = meta.status || 'known';
    const claim = { ...cloneJson(meta), target, status, review: meta.review || 'pending' };
    if (status === 'known') claim.value = cloneJson(value);
    if (status === 'candidates') claim.candidates = cloneJson(value);
    if (status === 'unknown') { if (!claim.reason) fail('INVALID_CLAIM', 'Unknown claim needs a reason.'); }
    this.scene.claims[id] = claim; this.setSlot(target, id); return id;
  }
  setSlot(pointer, claimId) {
    const claim = this.scene.claims[claimId];
    if (!claim || claim.target !== pointer) fail('CLAIM_TARGET_MISMATCH', 'Claim must point exactly to this slot.', { instancePath: pointer, relatedIds: [claimId] });
    const others = collectClaimSlots(this.scene).filter(slot => slot.claimId === claimId && slot.pointer !== pointer);
    if (others.length) fail('CLAIM_SLOT_CARDINALITY', 'Claim is already used by another slot.', { instancePath: pointer });
    setPointer(this.scene, pointer, claimId); return this;
  }
  buildSnapshot() { assertScene(this.scene, { tombstones: this.tombstones }); return cloneJson(this.scene); }
  buildPatch(baseRevision, changes, meta = {}) {
    if (changes && !Array.isArray(changes)) { meta = changes; changes = null; }
    if (!changes) {
      changes = [];
      if (canonicalize(this.base.frame) !== canonicalize(this.scene.frame)) changes.push({ op: 'replace', collection: 'frame', value: this.scene.frame });
      for (const collection of COLLECTIONS) {
        for (const id of Object.keys(this.base[collection]).sort()) {
          if (!Object.hasOwn(this.scene[collection], id)) changes.push({ op: 'remove', collection, id });
          else if (canonicalize(this.base[collection][id]) !== canonicalize(this.scene[collection][id])) changes.push({ op: 'replace', collection, id, value: this.scene[collection][id] });
        }
        for (const id of Object.keys(this.scene[collection]).sort()) if (!Object.hasOwn(this.base[collection], id)) changes.push({ op: 'add', collection, id, value: this.scene[collection][id] });
      }
    }
    return buildPatch(this.base, baseRevision, changes, { ...meta, tombstones: this.tombstones });
  }
}
export const SceneBuilder = SpecBuilder;
