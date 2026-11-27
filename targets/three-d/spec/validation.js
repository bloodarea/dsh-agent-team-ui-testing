import { validateSchema } from '../../../tools/blender/schema.js';
import { assertJsonData, escapePointer, fail, getPointer, pointerTokens } from './json.js';

export const SCENE_SCHEMA_ID = 'urn:dsh:blender:scene-specification:1.0.0';
export const COLLECTIONS = Object.freeze(['sources', 'evidence', 'objects', 'parts', 'relations', 'surfaces', 'depths', 'cameras', 'materials', 'constraints', 'claims']);
const DIRECT_EVIDENCE = Object.freeze({ observed: 'pixelReadout', estimated: 'algorithmRun', inferred: 'modelRun', human: 'humanStatement' });
export const claimValues = claim => claim?.status === 'known' ? [claim.value] : claim?.status === 'candidates' ? claim.candidates.map(c => c.value) : [];
export const knownValue = (scene, id) => scene.claims[id]?.status === 'known' ? scene.claims[id].value : undefined;
export function tombstoneIds(tombstones = []) {
  if (tombstones instanceof Set) return tombstones;
  if (Array.isArray(tombstones)) return new Set(tombstones.map(x => typeof x === 'string' ? x : x.id));
  return new Set(Object.values(tombstones).flat().map(x => typeof x === 'string' ? x : x.id));
}
export function collectClaimSlots(scene) {
  const slots = [];
  const add = (record, path, names) => { for (const name of names) if (Object.hasOwn(record || {}, name)) slots.push({ pointer: `${path}/${name}`, claimId: record[name] }); };
  const footprint = (record, path) => { if (record) add(record, path, ['bboxPx', 'mask']); };
  for (const collection of ['objects', 'parts']) for (const [id, record] of Object.entries(scene[collection] || {})) {
    const path = `/${collection}/${id}`; add(record.transform, `${path}/transform`, ['translation', 'rotation', 'scale']);
    footprint(record.footprint, `${path}/footprint`);
    if (collection === 'parts') add(record.geometry, `${path}/geometry`, ['classClaim', 'size', 'radius', 'height', 'bottomRadius', 'topRadius', 'width', 'length', 'mesh']);
  }
  for (const [collection, names] of Object.entries({ relations: ['predicate'], surfaces: ['type', 'normal', 'radius', 'normalMap'], depths: ['range', 'rangeM', 'map'], cameras: ['translation', 'rotation'], materials: ['family', 'roughness', 'metallic', 'opacity', 'baseColorLinear', 'sampleSrgb8'], constraints: ['targetLength', 'tolerance'] })) {
    for (const [id, record] of Object.entries(scene[collection] || {})) {
      const path = `/${collection}/${id}`; add(record, path, names);
      if (collection === 'surfaces') footprint(record.sample, `${path}/sample`);
      if (collection === 'cameras') add(record.projection, `${path}/projection`, ['fxPx', 'fyPx', 'cxPx', 'cyPx', 'width']);
    }
  }
  return slots;
}
function structural(value, kind) {
  assertJsonData(value);
  if (value?.schemaVersion !== '1.0.0') return [{ code: 'UNSUPPORTED_SCHEMA_VERSION', instancePath: '/schemaVersion', relatedIds: [], expected: '1.0.0', actual: String(value?.schemaVersion) }];
  const result = validateSchema(`${SCENE_SCHEMA_ID}#/$defs/${kind}`, value);
  return result.valid ? [] : result.errors.map(error => ({ code: result.error?.code || 'SCHEMA_VALIDATION_FAILED', instancePath: error.instancePath || '', relatedIds: [], expected: error.message || error.keyword, actual: JSON.stringify(error.params || {}) }));
}
export function validatePatch(patch) { const errors = structural(patch, 'patch'); return { valid: errors.length === 0, errors }; }
export function assertPatch(patch) { const result = validatePatch(patch); if (!result.valid) fail(result.errors[0].code, 'Invalid scene patch.', { errors: result.errors }); return patch; }

export function validateScene(scene, { tombstones = [] } = {}) {
  const errors = structural(scene, 'scene');
  if (errors.length) return { valid: false, errors };
  const add = (code, instancePath, relatedIds, expected, actual) => errors.push({ code, instancePath, relatedIds: relatedIds.filter(Boolean), expected, actual: String(actual) });
  const ref = (id, collections, path) => {
    if (id == null) return null;
    for (const collection of collections) if (Object.hasOwn(scene[collection], id)) return scene[collection][id];
    add('DANGLING_REF', path, [id], `Existing ID in ${collections.join('|')}`, id); return null;
  };
  const evidence = (ids, path) => (ids || []).map((id, index) => ref(id, ['evidence'], `${path}/${index}`)).filter(Boolean);
  const requiredKind = (ids, kind, path) => {
    const records = evidence(ids, path);
    if (!records.some(record => record.kind === kind)) add('EVIDENCE_KIND_MISMATCH', path, ids || [], `Direct ${kind} evidence`, records.map(r => r.kind).join(','));
  };
  const traceableCalibration = (ids, path) => {
    const visited = new Set(); const pending = [...(ids || [])]; let calibrated = false;
    while (pending.length) {
      const id = pending.pop(); if (visited.has(id)) continue; visited.add(id);
      const record = scene.evidence[id];
      if (record?.kind === 'humanStatement') { calibrated = true; break; }
      if (record?.kind === 'algorithmRun') pending.push(...record.inputs);
    }
    evidence(ids, path);
    if (!calibrated) add('SCALE_UNRESOLVED', path, ids || [], 'Human measurement or algorithm calibration traceable to a human record', 'No traceable calibration');
  };
  const rectInside = (rect, source, path, ids = []) => {
    if (!source) return;
    if (!source.widthPx || !source.heightPx || rect[0] < 0 || rect[1] < 0 || rect[2] <= 0 || rect[3] <= 0 || rect[0] + rect[2] > source.widthPx || rect[1] + rect[3] > source.heightPx)
      add('ASSET_MISMATCH', path, ids, `Half-open rectangle inside ${source.widthPx}x${source.heightPx}`, JSON.stringify(rect));
  };
  const dead = tombstoneIds(tombstones);
  for (const collection of COLLECTIONS) for (const id of Object.keys(scene[collection])) if (dead.has(id)) add('TOMBSTONE_REUSE', `/${collection}/${id}`, [id], 'An ID never previously deleted', id);
  const useCount = new Map();
  for (const { pointer, claimId } of collectClaimSlots(scene)) {
    useCount.set(claimId, (useCount.get(claimId) || 0) + 1);
    const claim = ref(claimId, ['claims'], pointer);
    if (claim && claim.target !== pointer) add('CLAIM_TARGET_MISMATCH', `/claims/${claimId}/target`, [claimId], pointer, claim.target);
  }
  for (const [id, claim] of Object.entries(scene.claims)) {
    const path = `/claims/${id}`;
    if (useCount.get(id) !== 1) add('CLAIM_SLOT_CARDINALITY', `${path}/target`, [id], 'Exactly one active slot', useCount.get(id) || 0);
    try { pointerTokens(claim.target); if (getPointer(scene, claim.target) !== id) add('CLAIM_TARGET_MISMATCH', `${path}/target`, [id], 'Target points back to claim ID', claim.target); }
    catch { add('INVALID_POINTER', `${path}/target`, [id], 'RFC 6901 pointer', claim.target); }
    if (claim.status !== 'unknown') {
      requiredKind(claim.evidenceIds, DIRECT_EVIDENCE[claim.origin], `${path}/evidenceIds`);
      for (const [index, candidate] of (claim.candidates || []).entries()) {
        requiredKind(candidate.evidenceIds, DIRECT_EVIDENCE[claim.origin], `${path}/candidates/${index}/evidenceIds`);
        if (candidate.evidenceIds.some(e => !claim.evidenceIds.includes(e))) add('EVIDENCE_KIND_MISMATCH', `${path}/candidates/${index}/evidenceIds`, candidate.evidenceIds, 'Subset of claim evidence union', 'Evidence outside union');
      }
    }
    if (claim.review !== 'pending' || claim.reviewEvidenceId) {
      const review = ref(claim.reviewEvidenceId, ['evidence'], `${path}/reviewEvidenceId`);
      if (review?.kind !== 'humanStatement') add('REVIEW_REQUIRED', `${path}/reviewEvidenceId`, [id, claim.reviewEvidenceId], 'Human review evidence', review?.kind);
    }
    for (const [index, value] of claimValues(claim).entries()) {
      const vp = claim.status === 'known' ? `${path}/value` : `${path}/candidates/${index}/value`;
      if (/(?:\/rotation|\/normal)$/.test(claim.target) && Math.abs(Math.hypot(...value) - 1) > 1e-5) add('INVALID_GEOMETRY', vp, [id], 'Unit vector/quaternion within 1e-5', Math.hypot(...value));
      if (/\/rangeM?$/.test(claim.target) && value[0] > value[1]) add('DEPTH_RANGE_INVALID', vp, [id], 'near <= far', JSON.stringify(value));
      let expectedKind; let channel;
      if (/\/geometry\/mesh$/.test(claim.target)) expectedKind = 'meshAsset';
      if (/\/(?:mask|normalMap|map)$/.test(claim.target)) { expectedKind = 'rasterProduct'; channel = claim.target.endsWith('/mask') ? 'mask' : claim.target.endsWith('/normalMap') ? 'cameraNormal' : scene.depths[pointerTokens(claim.target)[1]]?.kind === 'metric' ? 'metricDepth' : 'relativeDepth'; }
      if (expectedKind) {
        const source = ref(value, ['sources'], vp);
        if (source && (source.kind !== expectedKind || (channel && source.channel !== channel))) add('ASSET_MISMATCH', vp, [value], `${expectedKind}${channel ? `/${channel}` : ''}`, `${source.kind}/${source.channel || ''}`);
      }
    }
  }
  for (const [id, record] of Object.entries(scene.evidence)) {
    const path = `/evidence/${id}`;
    if (record.kind === 'pixelReadout' || record.kind === 'humanStatement') {
      const source = ref(record.sourceId, ['sources'], `${path}/sourceId`);
      const kind = record.kind === 'pixelReadout' ? 'referenceImage' : 'humanNote';
      if (source && source.kind !== kind) add('EVIDENCE_KIND_MISMATCH', `${path}/sourceId`, [record.sourceId], kind, source.kind);
      if (record.rectPx) rectInside(record.rectPx, source, `${path}/rectPx`, [id]);
    } else {
      evidence(record.inputs, `${path}/inputs`);
      if (record.productId) ref(record.productId, ['sources'], `${path}/productId`);
    }
  }
  function cycles(collection, edge, code) {
    const color = new Map();
    for (const start of Object.keys(scene[collection])) {
      if (color.has(start)) continue;
      const stack = [{ id: start, exiting: false }];
      while (stack.length) {
        const { id, exiting } = stack.pop();
        if (exiting) { color.set(id, 2); continue; }
        if (color.get(id) === 2 || !scene[collection][id]) continue;
        if (color.get(id) === 1) { add(code, `/${collection}/${id}`, [id], 'Acyclic graph', `Cycle through ${id}`); continue; }
        color.set(id, 1); stack.push({ id, exiting: true });
        for (const next of [...edge(scene[collection][id])].reverse()) stack.push({ id: next, exiting: false });
      }
    }
  }
  cycles('objects', r => r.parentId ? [r.parentId] : [], 'PARENT_CYCLE');
  cycles('parts', r => r.parentId ? [r.parentId] : [], 'PARENT_CYCLE');
  cycles('evidence', r => r.inputs || [], 'EVIDENCE_CYCLE');
  function footprint(record, path) {
    if (!record) return;
    const source = ref(record.sourceId, ['sources'], `${path}/sourceId`);
    if (source && source.kind !== 'referenceImage') add('ASSET_MISMATCH', `${path}/sourceId`, [record.sourceId], 'referenceImage', source.kind);
    const bbox = scene.claims[record.bboxPx];
    for (const [index, rect] of claimValues(bbox).entries()) {
      rectInside(rect, source, `${path}/bboxPx`, [record.bboxPx]);
      if (bbox.origin === 'observed') {
        const ids = bbox.status === 'candidates' ? bbox.candidates[index].evidenceIds : bbox.evidenceIds;
        const covers = (ids || []).some(id => {
          const ev = scene.evidence[id]; const r = ev?.rectPx;
          return ev?.kind === 'pixelReadout' && ev.sourceId === record.sourceId && r[0] <= rect[0] && r[1] <= rect[1] && r[0] + r[2] >= rect[0] + rect[2] && r[1] + r[3] >= rect[1] + rect[3];
        });
        if (!covers) add('EVIDENCE_KIND_MISMATCH', `${path}/bboxPx`, [record.bboxPx, record.sourceId], 'Direct pixel evidence covering the same source ROI', 'No covering direct evidence');
      }
    }
    for (const maskId of claimValues(scene.claims[record.mask])) {
      const mask = scene.sources[maskId];
      if (source && mask && (mask.widthPx !== source.widthPx || mask.heightPx !== source.heightPx)) add('ASSET_MISMATCH', `${path}/mask`, [maskId, record.sourceId], 'Raster registered to source dimensions', `${mask.widthPx}x${mask.heightPx}`);
    }
  }
  for (const [id, obj] of Object.entries(scene.objects)) { ref(obj.parentId, ['objects'], `/objects/${id}/parentId`); footprint(obj.footprint, `/objects/${id}/footprint`); }
  for (const [id, part] of Object.entries(scene.parts)) {
    const path = `/parts/${id}`;
    ref(part.objectId, ['objects'], `${path}/objectId`); const parent = ref(part.parentId, ['parts'], `${path}/parentId`);
    if (parent && parent.objectId !== part.objectId) add('PARENT_SCOPE_MISMATCH', `${path}/parentId`, [id, part.parentId], 'Parent part in the same assembly', parent.objectId);
    part.materialIds.forEach((mat, i) => ref(mat, ['materials'], `${path}/materialIds/${i}`)); footprint(part.footprint, `${path}/footprint`);
    const classification = scene.claims[part.geometry.classClaim];
    if (part.geometry.kind === 'undetermined') {
      if (classification?.status === 'known') add('INVALID_GEOMETRY', `${path}/geometry/classClaim`, [part.geometry.classClaim], 'unknown or candidates for undetermined geometry', 'known');
    } else if (classification?.status !== 'known' || classification.value !== part.geometry.kind || classification.review === 'rejected') add('INVALID_GEOMETRY', `${path}/geometry/classClaim`, [part.geometry.classClaim], `Usable known ${part.geometry.kind}`, classification?.status);
    if (part.geometry.kind === 'frustum' && knownValue(scene, part.geometry.topRadius) === 0 && knownValue(scene, part.geometry.bottomRadius) === 0) add('INVALID_GEOMETRY', `${path}/geometry`, [id], 'At least one positive radius', 'Both radii are zero');
  }
  for (const [id, relation] of Object.entries(scene.relations)) {
    const path = `/relations/${id}`; ref(relation.subjectId, ['objects', 'parts'], `${path}/subjectId`); ref(relation.objectId, ['objects', 'parts'], `${path}/objectId`);
    if (relation.subjectId === relation.objectId) add('INVALID_RELATION', path, [id], 'Distinct subject/object', relation.subjectId);
    if (relation.cameraId) ref(relation.cameraId, ['cameras'], `${path}/cameraId`);
    if ((relation.referenceFrame === 'camera') !== Boolean(relation.cameraId)) add('FRAME_MISMATCH', path, [id], 'camera frame iff cameraId present', relation.referenceFrame);
    const claim = scene.claims[relation.predicate];
    for (const [candidateIndex, predicate] of claimValues(claim).entries()) {
      if (['inFrontOf', 'behind', 'occludes'].includes(predicate) && relation.referenceFrame !== 'camera') add('FRAME_MISMATCH', `${path}/predicate`, [id], 'Camera frame with cameraId', relation.referenceFrame);
      if (claim.origin === 'observed' && (relation.referenceFrame !== 'camera' || !['above', 'below', 'leftOf', 'rightOf'].includes(predicate))) add('UNSUPPORTED_OBSERVATION', `${path}/predicate`, [relation.predicate], 'Observed image-plane directional relation', predicate);
      if (claim.origin === 'observed' && relation.cameraId) {
        const sourceId = scene.cameras[relation.cameraId]?.sourceId;
        const ids = claim.status === 'candidates' ? claim.candidates[candidateIndex].evidenceIds : claim.evidenceIds;
        if (!ids.some(id => scene.evidence[id]?.kind === 'pixelReadout' && scene.evidence[id].sourceId === sourceId)) add('EVIDENCE_KIND_MISMATCH', `${path}/predicate`, [relation.predicate, sourceId], 'Pixel evidence from the specified camera source', 'No matching direct evidence');
      }
    }
  }
  for (const [id, surface] of Object.entries(scene.surfaces)) {
    const path = `/surfaces/${id}`; ref(surface.partId, ['parts'], `${path}/partId`); if (surface.cameraId) ref(surface.cameraId, ['cameras'], `${path}/cameraId`);
    if ((surface.frame === 'camera') !== Boolean(surface.cameraId)) add('FRAME_MISMATCH', path, [id], 'camera frame iff cameraId present', surface.frame);
    if (surface.radius && claimValues(scene.claims[surface.type]).some(type => !['cylindrical', 'spherical', 'conical'].includes(type))) add('INVALID_GEOMETRY', `${path}/radius`, [id], 'A surface with a defined curvature radius', knownValue(scene, surface.type));
    if (surface.normalMap && surface.frame !== 'camera') add('FRAME_MISMATCH', `${path}/normalMap`, [id], 'cameraNormal decoded in camera frame', surface.frame);
    footprint(surface.sample, `${path}/sample`);
  }
  for (const [id, camera] of Object.entries(scene.cameras)) {
    const path = `/cameras/${id}`; const source = ref(camera.sourceId, ['sources'], `${path}/sourceId`);
    if (source && source.kind !== 'referenceImage') add('ASSET_MISMATCH', `${path}/sourceId`, [camera.sourceId], 'referenceImage', source.kind);
    if (camera.projection.kind !== 'undetermined' && !camera.projectionEvidenceIds?.length) add('CAMERA_UNCALIBRATED', `${path}/projectionEvidenceIds`, [id], 'Projection selection evidence', 'missing');
    evidence(camera.projectionEvidenceIds, `${path}/projectionEvidenceIds`);
  }
  for (const [id, depth] of Object.entries(scene.depths)) {
    const path = `/depths/${id}`; const camera = ref(depth.cameraId, ['cameras'], `${path}/cameraId`); ref(depth.subjectId, ['objects', 'parts'], `${path}/subjectId`);
    if (depth.kind === 'metric') traceableCalibration(depth.calibrationEvidenceIds, `${path}/calibrationEvidenceIds`);
    for (const sourceId of claimValues(scene.claims[depth.map])) {
      const source = scene.sources[sourceId]; const image = camera && scene.sources[camera.sourceId];
      if (source && image && (source.widthPx !== image.widthPx || source.heightPx !== image.heightPx)) add('ASSET_MISMATCH', `${path}/map`, [sourceId, camera.sourceId], 'Raster registered to camera source dimensions', `${source.widthPx}x${source.heightPx}`);
    }
  }
  if (scene.frame.scale.mode === 'metric') traceableCalibration(scene.frame.scale.evidenceIds, '/frame/scale/evidenceIds');
  const intervals = new Map();
  for (const [id, constraint] of Object.entries(scene.constraints)) {
    const path = `/constraints/${id}`;
    if (constraint.kind === 'preserveRelation') { ref(constraint.relationId, ['relations'], `${path}/relationId`); evidence(constraint.evidenceIds, `${path}/evidenceIds`); continue; }
    const part = ref(constraint.partId, ['parts'], `${path}/partId`); const isSize = /^size[XYZ]$/.test(constraint.parameter); const parameter = isSize ? 'size' : constraint.parameter;
    if (part && (!Object.hasOwn(part.geometry, parameter) || (isSize && part.geometry.kind !== 'box'))) add('CONSTRAINT_CONFLICT', `${path}/parameter`, [id, constraint.partId], 'Parameter available on target geometry', constraint.parameter);
    const target = scene.claims[constraint.targetLength]; const tolerance = scene.claims[constraint.tolerance];
    if (constraint.severity === 'hard') {
      for (const [key, claim] of [['targetLength', target], ['tolerance', tolerance]]) if (claim && (claim.status !== 'known' || claim.review !== 'confirmed' || claim.origin !== 'human')) add('CONSTRAINT_CONFLICT', `${path}/${key}`, [constraint[key]], 'known + confirmed human dimension constraint', `${claim.status}/${claim.review}/${claim.origin}`);
      if (target?.status === 'known' && tolerance?.status === 'known') {
        const key = `${constraint.partId}/${constraint.parameter}`; const range = [target.value - tolerance.value, target.value + tolerance.value]; const previous = intervals.get(key);
        if (previous) { range[0] = Math.max(range[0], previous[0]); range[1] = Math.min(range[1], previous[1]); }
        intervals.set(key, range);
        if (range[0] > range[1]) add('CONSTRAINT_CONFLICT', path, [id, constraint.partId], 'Intersecting hard dimension intervals', JSON.stringify(range));
      }
    }
  }
  return { valid: errors.length === 0, errors };
}
export function assertScene(scene, options) { const result = validateScene(scene, options); if (!result.valid) fail(result.errors[0].code, 'Invalid scene specification.', { errors: result.errors }); return scene; }
