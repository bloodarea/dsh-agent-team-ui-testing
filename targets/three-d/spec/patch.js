import { cloneJson, fail } from './json.js';
import { assertPatch, assertScene, tombstoneIds } from './validation.js';

/** Applies to a detached copy; forward references are checked only in the final state. */
export function applyPatch(scene, patch, { tombstones = [] } = {}) {
  assertPatch(patch); assertScene(scene, { tombstones });
  if (patch.sceneId !== scene.sceneId) fail('SCENE_ID_MISMATCH', 'Patch belongs to a different scene.');
  if (patch.baseRevision !== scene.revision || patch.revision !== patch.baseRevision + 1)
    fail('REVISION_CONFLICT', 'Patch baseline does not match current revision.', { currentRevision: scene.revision });
  const snapshot = cloneJson(scene); const dead = tombstoneIds(tombstones); const deleted = [];
  patch.ops.forEach((op, index) => {
    const instancePath = `/ops/${index}`;
    if (op.collection === 'frame') { snapshot.frame = cloneJson(op.value); return; }
    const table = snapshot[op.collection]; const exists = Object.hasOwn(table, op.id);
    if (op.op === 'add' && dead.has(op.id)) fail('TOMBSTONE_REUSE', 'Deleted IDs are permanently reserved.', { instancePath, relatedIds: [op.id] });
    if ((op.op === 'add') === exists) fail('PATCH_TARGET_CONFLICT', 'Patch record presence precondition failed.', { instancePath, relatedIds: [op.id], expected: op.op === 'add' ? 'absent' : 'present' });
    if (op.op === 'remove') {
      delete table[op.id]; dead.add(op.id); deleted.push({ collection: op.collection, id: op.id, revision: patch.revision });
    } else table[op.id] = cloneJson(op.value);
  });
  snapshot.revision = patch.revision; assertScene(snapshot, { tombstones: dead });
  const history = Array.isArray(tombstones) ? cloneJson(tombstones) : [...tombstoneIds(tombstones)];
  return { scene: snapshot, tombstones: [...history, ...deleted] };
}
