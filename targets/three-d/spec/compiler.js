import { assertOperation } from '../../../tools/blender/schema.js';
import { assertScene, collectClaimSlots, knownValue } from './validation.js';
import { cloneJson, fail, hashJson } from './json.js';

export const FIRST_BATCH_OPS = Object.freeze(['collection.ensure', 'object.ensure', 'object.parent', 'object.transform', 'mesh.primitive', 'object.remove', 'material.ensure', 'material.assign']);
const GEOMETRY_PARAMETERS = Object.freeze({ box: ['size'], cylinder: ['radius', 'height'], frustum: ['bottomRadius', 'topRadius', 'height'] });
function ordered(table, parent) {
  const result = []; const done = new Set();
  for (const start of Object.keys(table).sort()) {
    const chain = []; let id = start;
    while (id && table[id] && !done.has(id)) { chain.push(id); done.add(id); id = parent(table[id]); }
    for (const node of chain.reverse()) result.push([node, table[node]]);
  }
  return result;
}

/** Pure compilation only. This module never executes Python or touches Blender. */
export function compileScene(scene, options = {}) {
  assertScene(scene);
  const { binding, previousScene, managedState = [], segments = 32, blenderUnitScaleLength = 1 } = options;
  if (!binding || typeof binding.targetId !== 'string' || !binding.targetId || !Number.isSafeInteger(binding.generation) || binding.generation < 1 || !Number.isSafeInteger(binding.sceneRevision) || binding.sceneRevision < 0)
    fail('INVALID_BINDING', 'Compile requires targetId, generation and independent Blender sceneRevision.');
  if (!Number.isSafeInteger(segments) || segments < 3 || segments > 256) fail('RESOURCE_LIMIT', 'Primitive segments must be an integer from 3 to 256.');
  if (!Number.isFinite(blenderUnitScaleLength) || blenderUnitScaleLength <= 0) fail('INVALID_UNITS', 'Blender unit scale must be positive.');
  if (previousScene) { assertScene(previousScene); if (previousScene.sceneId !== scene.sceneId || previousScene.revision > scene.revision) fail('SCENE_ID_MISMATCH', 'Previous scene must be an earlier snapshot of this scene.'); }
  const sceneId = scene.sceneId; const ops = []; const unresolved = []; const assumptions = []; const provenance = []; const covered = new Set();
  const states = new Map(); const conflicts = new Set();
  for (const state of managedState) {
    if (states.has(state.stableId)) conflicts.add(state.stableId);
    states.set(state.stableId, state);
    if (state.sceneId !== sceneId || state.managedBy !== 'dsh-agent' || state.inManagedCollection !== true || !/^[a-f0-9]{64}$/.test(state.contentHash || '') || state.actualContentHash !== state.contentHash || state.unmanagedChildren?.length) conflicts.add(state.stableId);
  }
  const report = (code, instancePath, detail, status = 'blocked', relatedIds = []) => unresolved.push({ code, instancePath, status, detail, relatedIds });
  for (const id of [...conflicts].sort()) report('MANAGED_OBJECT_CONFLICT', `/managedState/${id}`, 'Duplicate, edited, unowned or out-of-collection managed data block.', 'blocked', [id]);
  function emit(opId, args, instancePath, { dependsOn = [], permissions = ['scene:write'], preconditions, impact } = {}) {
    if (!FIRST_BATCH_OPS.includes(opId)) fail('UNSUPPORTED_OP', 'Compiler attempted an unregistered operation.');
    const op = { opId, args: { sceneId, ...args }, instancePath, dependsOn, permissions, ...(preconditions ? { preconditions } : {}), ...(impact ? { impact } : {}) };
    assertOperation(opId, op.args);
    op.id = `op_${hashJson(op).slice(0, 24)}`; ops.push(op); return op.id;
  }
  function consume(id) {
    const claim = scene.claims[id]; if (!claim) return undefined;
    covered.add(claim.target);
    if (claim.status !== 'known' || claim.review === 'rejected') {
      report(claim.review === 'rejected' ? 'CLAIM_REJECTED' : claim.status === 'candidates' ? 'CLAIM_CANDIDATES' : 'CLAIM_UNKNOWN', claim.target, claim.reason || 'A usable known value is required.', 'blocked', [id]); return undefined;
    }
    if (!provenance.some(item => item.claimId === id)) provenance.push({ claimId: id, instancePath: claim.target, origin: claim.origin, confidence: claim.confidence, review: claim.review, evidenceIds: [...claim.evidenceIds], ...(claim.reviewEvidenceId ? { reviewEvidenceId: claim.reviewEvidenceId } : {}), provisional: claim.review === 'pending' });
    return cloneJson(claim.value);
  }
  const scaleFactor = scene.frame.scale.mode === 'metric' ? scene.frame.scale.metersPerUnit / blenderUnitScaleLength : 1;
  if (scene.frame.scale.mode === 'relative') assumptions.push({ instancePath: '/frame/scale', detail: 'Relative scene units only; no absolute metric result is claimed.' });
  const collection = emit('collection.ensure', {}, '/objects'); const ensured = new Map(); const meshes = new Map(); const materials = new Map();
  for (const collectionName of ['objects', 'parts']) {
    for (const [stableId, record] of ordered(scene[collectionName], item => item.parentId)) {
      const path = `/${collectionName}/${stableId}`;
      const parentId = record.parentId || (collectionName === 'parts' ? record.objectId : null);
      if (conflicts.has(stableId) || (parentId && (conflicts.has(parentId) || !ensured.has(parentId)))) { report('PARENT_BLOCKED', path, 'This node or its parent has an unresolved ownership conflict.', 'blocked', [stableId, parentId].filter(Boolean)); continue; }
      const object = emit('object.ensure', { stableId, kind: collectionName === 'objects' ? 'empty' : 'mesh', label: record.label }, path, { dependsOn: [collection] }); ensured.set(stableId, object);
      const parent = emit('object.parent', { childId: stableId, parentId }, `${path}/parentId`, { dependsOn: [object, ...(parentId ? [ensured.get(parentId)] : [])] });
      const translation = consume(record.transform.translation); const rotation = consume(record.transform.rotation); const scale = consume(record.transform.scale);
      if (translation !== undefined && rotation !== undefined && scale !== undefined) emit('object.transform', { stableId, translation: translation.map(v => v * scaleFactor), rotation, scale }, `${path}/transform`, { dependsOn: [parent] });
      else assumptions.push({ instancePath: `${path}/transform`, detail: 'Node creation is a structural placeholder. No unknown TRS is written; its position cannot be accepted until resolved.' });
      if (collectionName !== 'parts') continue;
      const geometry = record.geometry; const parameters = GEOMETRY_PARAMETERS[geometry.kind];
      if (!parameters) { report('UNSUPPORTED_GEOMETRY', `${path}/geometry`, `Geometry ${geometry.kind} has no first-batch controlled mapping.`, 'planned', [stableId]); continue; }
      const shape = consume(geometry.classClaim); const values = Object.fromEntries(parameters.map(name => [name, consume(geometry[name])]));
      if (shape === undefined || Object.values(values).some(value => value === undefined)) continue;
      for (const key of Object.keys(values)) values[key] = Array.isArray(values[key]) ? values[key].map(value => value * scaleFactor) : values[key] * scaleFactor;
      const previousHash = states.get(stableId)?.contentHash;
      const mesh = emit('mesh.primitive', { stableId, shape: { kind: geometry.kind, ...values, ...(geometry.kind !== 'box' ? { segments } : {}) } }, `${path}/geometry`, { dependsOn: [object], ...(previousHash ? { preconditions: { expectedManagedHash: previousHash } } : {}) }); meshes.set(stableId, mesh);
    }
  }
  for (const [stableId, material] of Object.entries(scene.materials).sort(([a], [b]) => a.localeCompare(b))) {
    const path = `/materials/${stableId}`; const fields = ['roughness', 'metallic', 'opacity', ...(material.baseColorLinear ? ['baseColorLinear'] : [])];
    const values = Object.fromEntries(fields.map(field => [field, consume(material[field])]));
    if (Object.values(values).some(value => value === undefined) || conflicts.has(stableId)) continue;
    const users = Object.entries(scene.parts).filter(([, part]) => part.materialIds.includes(stableId)).map(([id]) => id).sort();
    const externalUsers = states.get(stableId)?.externalUsers || [];
    if (externalUsers.length) { report('EXTERNAL_MATERIAL_USERS', path, 'Shared material has external users requiring explicit review.', 'blocked', [stableId, ...externalUsers]); continue; }
    const materialOp = emit('material.ensure', { stableId, label: material.label, ...values }, path, { impact: { affectedStableIds: users } }); materials.set(stableId, materialOp);
  }
  for (const [targetStableId, part] of Object.entries(scene.parts).sort(([a], [b]) => a.localeCompare(b))) {
    if (!ensured.has(targetStableId)) continue;
    if (part.materialIds.length > 1) { report('MATERIAL_FACE_ASSIGNMENT_UNRESOLVED', `/parts/${targetStableId}/materialIds`, 'Multiple material slots have no per-face assignment policy.', 'blocked', part.materialIds); continue; }
    part.materialIds.forEach((materialId, slot) => {
      if (materials.has(materialId)) emit('material.assign', { targetStableId, materialId, slot }, `/parts/${targetStableId}/materialIds/${slot}`, { dependsOn: [ensured.get(targetStableId), materials.get(materialId), ...(meshes.has(targetStableId) ? [meshes.get(targetStableId)] : [])] });
      else report('MATERIAL_BLOCKED', `/parts/${targetStableId}/materialIds/${slot}`, 'Material parameters or ownership are unresolved.', 'blocked', [materialId]);
    });
  }
  if (previousScene) {
    // Delete deepest parts first, then assemblies, without guessing cascade ownership.
    const deleted = [...ordered(previousScene.parts, p => p.parentId).reverse().map(([id]) => ['parts', id]), ...ordered(previousScene.objects, o => o.parentId).reverse().map(([id]) => ['objects', id])];
    let previousRemove;
    for (const [collectionName, stableId] of deleted) if (!scene[collectionName][stableId]) {
      const state = states.get(stableId); const path = `/${collectionName}/${stableId}`;
      if (!state || conflicts.has(stableId) || state.externalUsers?.length || state.unmanagedChildren?.length) { report('DELETE_OWNERSHIP_UNPROVEN', path, 'Deletion requires an unchanged managed object and no unmanaged children or external references.', 'blocked', [stableId]); continue; }
      const cascadeStableIds = Object.keys(previousScene.parts).filter(id => previousScene.parts[id].objectId === stableId || previousScene.parts[id].parentId === stableId);
      previousRemove = emit('object.remove', { stableId, expectedManagedHash: state.contentHash, cascadeIds: cascadeStableIds }, path, { dependsOn: previousRemove ? [previousRemove] : [], permissions: ['scene:write', 'scene:delete-managed', 'approval:once'], impact: { relationIds: Object.entries(previousScene.relations).filter(([, r]) => r.subjectId === stableId || r.objectId === stableId).map(([id]) => id), materialIds: previousScene.parts[stableId]?.materialIds || [], externalUsers: [] } });
    }
    for (const id of Object.keys(previousScene.materials)) if (!scene.materials[id]) report('UNSUPPORTED_MATERIAL_REMOVE', `/materials/${id}`, 'material.remove is not an available first-batch operation.', 'planned', [id]);
  }
  for (const [id] of Object.entries(scene.cameras)) report('UNSUPPORTED_CAMERA', `/cameras/${id}`, 'camera.configure is planned; fixture cameras require independently verified setup.', 'planned', [id]);
  for (const collectionName of ['relations', 'surfaces', 'depths', 'constraints']) for (const id of Object.keys(scene[collectionName])) report('VALIDATION_INPUT_ONLY', `/${collectionName}/${id}`, 'Retained as evidence/acceptance input; no automatic Blender operation is mapped.', 'planned', [id]);
  for (const slot of collectClaimSlots(scene)) if (!covered.has(slot.pointer)) {
    const claim = scene.claims[slot.claimId];
    report(claim.status === 'unknown' ? 'CLAIM_UNKNOWN' : claim.status === 'candidates' ? 'CLAIM_CANDIDATES' : claim.review === 'rejected' ? 'CLAIM_REJECTED' : 'UNMAPPED_FIELD', slot.pointer, claim.reason || 'This field has no controlled first-batch operation.', claim.status === 'known' && claim.review !== 'rejected' ? 'planned' : 'blocked', [slot.claimId]);
  }
  const constraintChecks = Object.entries(scene.constraints).map(([id, constraint]) => {
    if (constraint.kind !== 'dimension') return { constraintId: id, status: 'unverified', instancePath: `/constraints/${id}`, detail: 'Requires independent relation geometry readback.' };
    const part = scene.parts[constraint.partId]; const index = 'XYZ'.indexOf(constraint.parameter.slice(-1));
    const actual = /^size[XYZ]$/.test(constraint.parameter) ? knownValue(scene, part.geometry.size)?.[index] : knownValue(scene, part.geometry[constraint.parameter]);
    const target = knownValue(scene, constraint.targetLength); const tolerance = knownValue(scene, constraint.tolerance);
    return { constraintId: id, instancePath: `/constraints/${id}`, severity: constraint.severity, status: actual === undefined || target === undefined || tolerance === undefined ? 'unresolved' : Math.abs(actual - target) <= tolerance ? 'design-satisfied' : 'design-deviation', ...(actual !== undefined && target !== undefined ? { deviation: actual - target } : {}), detail: 'Local design parameter only; Blender geometry readback remains required.' };
  });
  const provisional = provenance.some(item => item.provisional) || ops.some(op => op.opId === 'object.remove');
  const plan = { compilerVersion: '1.0.0', sceneId, specRevision: scene.revision, specHash: hashJson(scene), binding: cloneJson(binding), implementation: { segments, blenderUnitScaleLength, scaleFactor, transformSpace: 'local', rotationOrder: 'WXYZ', normalizeParentInverse: true }, ops, unresolved, assumptions, provenance, constraintChecks, provisional, requiresHumanApproval: provisional, status: unresolved.length ? 'partial' : 'ready' };
  plan.planHash = hashJson(plan); return plan;
}
export const compileSceneSpec = compileScene;
