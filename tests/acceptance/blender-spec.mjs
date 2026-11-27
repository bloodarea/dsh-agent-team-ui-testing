import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { fork } from 'node:child_process';
import { validateOperation } from '../../tools/blender/schema.js';
import { fileURLToPath } from 'node:url';
import {
  ArtifactStore, SpecStore, SpecBuilder, emptyScene, applyPatch, buildPatch, claimIdForTarget,
  parseStrictJson, canonicalize, cloneJson, hashJson, sha256, validateScene, validatePatch,
  compileScene, FIRST_BATCH_OPS, encodeRgbaPng, normalizeReferenceImage,
  createRoiMapping, mapPointToSource, mapPointFromSource, mapRectToSource,
} from '../../targets/three-d/spec/index.js';

const context = { workspaceId: 'test-workspace', actor: 'host-test-principal', grantId: 'grant-test' };
const authorize = async request => request.actor === context.actor && (request.action.endsWith(':read') || request.action.endsWith(':audit') || request.grantId === context.grantId);
const binding = { targetId: 'test-blender-target', generation: 1, sceneRevision: 8 };
function fixture() {
  const builder = new SpecBuilder('scn_test_lamp');
  builder.addSource('src_note', { kind: 'humanNote', artifactId: 'art_note', sha256: 'a'.repeat(64) });
  builder.addEvidence('ev_measure', { kind: 'humanStatement', sourceId: 'src_note', actor: 'fixture-designer', excerpt: 'All values are synthetic fixture design dimensions in scene units.' });
  builder.addEvidence('ev_fit', { kind: 'algorithmRun', producer: 'fixture-fit', version: '1', runId: 'fit-1', configSha256: 'b'.repeat(64), inputs: ['ev_measure'] });
  const human = { origin: 'human', evidenceIds: ['ev_measure'], confidence: 1, review: 'confirmed', reviewEvidenceId: 'ev_measure' };
  const set = (pointer, value, meta = human) => builder.ensureClaim(pointer, value, meta);
  builder.scene.objects.obj_lamp = { label: 'Lamp', parentId: null, transform: {} };
  builder.scene.parts.part_base = { label: 'Base', objectId: 'obj_lamp', parentId: null, transform: {}, geometry: { kind: 'cylinder' }, materialIds: ['mat_paint'] };
  for (const [pointer, value] of [['translation', [0, 0, 0]], ['rotation', [1, 0, 0, 0]], ['scale', [1, 1, 1]]]) {
    set(`/objects/obj_lamp/transform/${pointer}`, value); set(`/parts/part_base/transform/${pointer}`, value);
  }
  set('/parts/part_base/geometry/classClaim', 'cylinder'); set('/parts/part_base/geometry/radius', 0.08); set('/parts/part_base/geometry/height', 0.03);
  builder.scene.materials.mat_paint = { label: 'Paint' };
  for (const [key, value] of [['family', 'paint'], ['roughness', 0.6], ['metallic', 0], ['opacity', 1], ['baseColorLinear', [0.2, 0.3, 0.4]]]) set(`/materials/mat_paint/${key}`, value);
  return builder.buildSnapshot();
}
function imageFixture() {
  const builder = new SpecBuilder(fixture());
  builder.addSource('src_front', { kind: 'referenceImage', artifactId: 'art_front', sha256: 'c'.repeat(64), widthPx: 800, heightPx: 600 });
  builder.addEvidence('ev_pixels', { kind: 'pixelReadout', sourceId: 'src_front', rectPx: [200, 100, 400, 400], reader: 'fixture-roi', version: '1' });
  builder.scene.objects.obj_lamp.footprint = { sourceId: 'src_front' };
  builder.ensureClaim('/objects/obj_lamp/footprint/bboxPx', [200, 100, 400, 400], { origin: 'observed', evidenceIds: ['ev_pixels'], confidence: 1 });
  builder.scene.cameras.cam_front = { sourceId: 'src_front', projection: { kind: 'perspective' }, projectionEvidenceIds: ['ev_fit'] };
  const estimated = { origin: 'estimated', evidenceIds: ['ev_fit'], confidence: 0.8 };
  for (const [name, value] of [['fxPx', 800], ['fyPx', 800], ['cxPx', 400], ['cyPx', 300]]) builder.ensureClaim(`/cameras/cam_front/projection/${name}`, value, estimated);
  for (const name of ['translation', 'rotation']) builder.ensureClaim(`/cameras/cam_front/${name}`, undefined, { status: 'unknown', reason: 'uncalibrated fixture extrinsics' });
  builder.scene.depths.dep_base = { kind: 'relative', cameraId: 'cam_front', subjectId: 'part_base', normalization: 'near0Far1' };
  builder.ensureClaim('/depths/dep_base/range', [0.2, 0.4], estimated);
  return builder.buildSnapshot();
}
const claimAt = (scene, pointer) => Object.entries(scene.claims).find(([, claim]) => claim.target === pointer)?.[0];
const renamePatch = (scene, patchId, label = 'Changed') => buildPatch(scene, scene.revision, [{ op: 'replace', collection: 'objects', id: 'obj_lamp', value: { ...scene.objects.obj_lamp, label } }], { patchId, author: 'declared-author', reason: 'test revision' });
async function temporary(t) { const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'blender-spec-')); t.after(() => fs.rm(directory, { recursive: true, force: true })); return directory; }
async function persistentFixture(t) {
  const rootDir = await temporary(t); const artifacts = new ArtifactStore({ rootDir: path.join(rootDir, 'assets'), authorize });
  const note = await artifacts.put({ ...context, bytes: 'Fixture human design record', mediaType: 'text/plain' });
  const scene = fixture(); scene.sources.src_note = { kind: 'humanNote', artifactId: note.artifactId, sha256: note.sha256 };
  const store = new SpecStore({ rootDir, authorize, artifactStore: artifacts }); return { rootDir, artifacts, store, scene };
}
const codes = result => result.errors.map(error => error.code);
const throwsCode = (fn, code) => assert.throws(fn, error => error.code === code);
const rejectsCode = (promise, code) => assert.rejects(promise, error => error.code === code);

async function worker(rootDir, patch, { crash = false } = {}) {
  return new Promise((resolve, reject) => {
    const child = fork(fileURLToPath(import.meta.url), [crash ? '--crash-worker' : '--commit-worker', rootDir, JSON.stringify(patch)], { stdio: ['ignore', 'pipe', 'pipe', 'ipc'], execArgv: [] });
    let result; let errorText = '';
    child.on('message', message => { result = message; }); child.stderr.on('data', bytes => { errorText += bytes; });
    child.on('error', reject); child.on('exit', code => crash && code === 77 ? resolve({ crashed: true }) : code === 0 && result ? resolve(result) : reject(new Error(`Commit worker exited ${code}: ${errorText}`)));
  });
}
if (['--commit-worker', '--crash-worker'].includes(process.argv[2])) {
  const rootDir = process.argv[3]; const store = new SpecStore({ rootDir, authorize, artifactStore: new ArtifactStore({ rootDir: path.join(rootDir, 'assets'), authorize }), ...(process.argv[2] === '--crash-worker' ? { beforePublish: () => process.exit(77) } : {}) });
  try { process.send({ ok: true, result: await store.commit({ ...context, patchJson: process.argv[4] }) }); }
  catch (error) { process.send({ ok: false, code: error.code, details: error.details }); }
  process.disconnect();
} else {
  test('strict parser rejects duplicate keys, escaped duplicates, overflow and trailing syntax', () => {
    for (const input of ['{"a":1,"a":2}', '{"a":1,"\\u0061":2}', '{"nested":{"id":1,"id":2}}']) throwsCode(() => parseStrictJson(input), 'DUPLICATE_KEY');
    throwsCode(() => parseStrictJson('{"n":1e999}'), 'NON_FINITE_NUMBER');
    for (const input of ['{"a":01}', '[1,]', '{"a":1,}', 'true false', 'NaN', 'undefined', '"\\uD800"']) assert.throws(() => parseStrictJson(input));
    assert.equal(parseStrictJson('{"__proto__":{"polluted":true}}').__proto__.polluted, true); assert.equal({}.polluted, undefined);
  });
  test('strict parser enforces resource bounds before recursive validation', () => {
    throwsCode(() => parseStrictJson('[[[[]]]]', { maxDepth: 2 }), 'RESOURCE_LIMIT');
    throwsCode(() => parseStrictJson('[1,2,3]', { maxNodes: 3 }), 'RESOURCE_LIMIT');
    throwsCode(() => parseStrictJson('"abcd"', { maxStringLength: 2 }), 'RESOURCE_LIMIT');
    throwsCode(() => parseStrictJson('"abcd"', { maxBytes: 3 }), 'RESOURCE_LIMIT');
  });
  test('JCS ordering, number formatting, input purity and SHA are deterministic', () => {
    assert.equal(canonicalize({ z: -0, a: [1e-7, 1e21, true, null] }), '{"a":[1e-7,1e+21,true,null],"z":0}');
    assert.equal(hashJson({ b: 2, a: 1 }), hashJson({ a: 1, b: 2 }));
    for (const value of [Infinity, undefined, [, 1], new Date(), { get secret() { throw new Error('must not invoke'); } }]) assert.throws(() => canonicalize(value));
    const cycle = {}; cycle.self = cycle; throwsCode(() => canonicalize(cycle), 'INVALID_JSON');
  });
  test('formal Scene schema validates snapshots and rejects extra fields and wrong versions', () => {
    const scene = fixture(); assert.deepEqual(validateScene(scene), { valid: true, errors: [] });
    const extra = cloneJson(scene); extra.parts.part_base.geometry.segments = 32; assert.equal(validateScene(extra).valid, false);
    const bad = cloneJson(scene); bad.schemaVersion = '1.0.1'; assert.ok(codes(validateScene(bad)).includes('UNSUPPORTED_SCHEMA_VERSION'));
    const unknown = cloneJson(scene); const id = claimAt(unknown, '/materials/mat_paint/metallic'); unknown.claims[id] = { ...unknown.claims[id], status: 'unknown', reason: 'not measured' }; assert.equal(validateScene(unknown).valid, false);
  });
  test('claim target closure, cardinality and dangling refs have exact paths', () => {
    const scene = fixture(); const id = scene.parts.part_base.geometry.radius;
    scene.claims[id].target = '/parts/part_base/geometry/height'; const result = validateScene(scene);
    assert.ok(result.errors.some(error => error.code === 'CLAIM_TARGET_MISMATCH' && error.instancePath === `/claims/${id}/target`));
    const missing = fixture(); delete missing.claims[missing.parts.part_base.geometry.radius]; assert.ok(codes(validateScene(missing)).includes('DANGLING_REF'));
    const orphan = fixture(); orphan.claims.clm_orphan = cloneJson(orphan.claims[id]); assert.ok(codes(validateScene(orphan)).includes('CLAIM_SLOT_CARDINALITY'));
    const label = fixture(); label.objects.obj_lamp.label = 'clm_editable_label'; assert.equal(validateScene(label).valid, true);
  });
  test('parent cycles, same-assembly parent checks and evidence cycles are rejected', () => {
    const scene = fixture(); scene.objects.obj_lamp.parentId = 'obj_lamp'; assert.ok(codes(validateScene(scene)).includes('PARENT_CYCLE'));
    const part = fixture(); part.parts.part_base.parentId = 'part_base'; assert.ok(codes(validateScene(part)).includes('PARENT_CYCLE'));
    const scoped = fixture(); scoped.objects.obj_other = { ...cloneJson(scoped.objects.obj_lamp), transform: {} };
    const builder = new SpecBuilder(scoped); for (const [name, value] of [['translation', [0, 0, 0]], ['rotation', [1, 0, 0, 0]], ['scale', [1, 1, 1]]]) builder.ensureClaim(`/objects/obj_other/transform/${name}`, value, { origin: 'estimated', evidenceIds: ['ev_fit'], confidence: 1 });
    builder.scene.parts.part_parent = { ...cloneJson(builder.scene.parts.part_base), objectId: 'obj_other', transform: {}, geometry: { kind: 'undetermined' }, materialIds: [] };
    for (const [name, value] of [['translation', [0, 0, 0]], ['rotation', [1, 0, 0, 0]], ['scale', [1, 1, 1]]]) builder.ensureClaim(`/parts/part_parent/transform/${name}`, value, { origin: 'estimated', evidenceIds: ['ev_fit'], confidence: 1 });
    builder.ensureClaim('/parts/part_parent/geometry/classClaim', null, { status: 'unknown', reason: 'fixture unknown' }); builder.scene.parts.part_base.parentId = 'part_parent'; assert.ok(codes(validateScene(builder.scene)).includes('PARENT_SCOPE_MISMATCH'));
    const evidence = fixture(); evidence.evidence.ev_fit.inputs = ['ev_fit']; assert.ok(codes(validateScene(evidence)).includes('EVIDENCE_CYCLE'));
  });
  test('direct evidence and human review checks do not infer provenance', () => {
    const scene = fixture(); const id = scene.parts.part_base.geometry.radius; scene.claims[id].origin = 'estimated'; assert.ok(codes(validateScene(scene)).includes('EVIDENCE_KIND_MISMATCH'));
    const review = fixture(); review.claims[id].reviewEvidenceId = 'ev_fit'; assert.ok(codes(validateScene(review)).includes('REVIEW_REQUIRED'));
    const candidates = fixture(); candidates.claims[id] = { target: candidates.claims[id].target, status: 'candidates', review: 'pending', origin: 'estimated', evidenceIds: ['ev_fit'], candidates: [{ value: 0.08, confidence: 0.5, evidenceIds: ['ev_measure'] }, { value: 0.09, confidence: 0.5, evidenceIds: ['ev_fit'] }] }; assert.ok(codes(validateScene(candidates)).includes('EVIDENCE_KIND_MISMATCH'));
  });
  test('non-unit quaternions and geometry classification mismatch are rejected', () => {
    const scene = fixture(); scene.claims[scene.parts.part_base.transform.rotation].value = [1, 1, 0, 0]; assert.ok(codes(validateScene(scene)).includes('INVALID_GEOMETRY'));
    const shape = fixture(); shape.claims[shape.parts.part_base.geometry.classClaim].value = 'box'; assert.ok(codes(validateScene(shape)).includes('INVALID_GEOMETRY'));
  });
  test('image evidence must cover the right source and remain inside half-open bounds', () => {
    const scene = imageFixture(); assert.equal(validateScene(scene).valid, true);
    const out = cloneJson(scene); out.evidence.ev_pixels.rectPx = [799, 599, 2, 2]; assert.ok(codes(validateScene(out)).includes('ASSET_MISMATCH'));
    const uncovered = cloneJson(scene); uncovered.claims[uncovered.objects.obj_lamp.footprint.bboxPx].value = [199, 100, 401, 400]; assert.ok(codes(validateScene(uncovered)).includes('EVIDENCE_KIND_MISMATCH'));
    const wrongKind = cloneJson(scene); wrongKind.evidence.ev_pixels.sourceId = 'src_note'; assert.ok(codes(validateScene(wrongKind)).includes('EVIDENCE_KIND_MISMATCH'));
    const projection = cloneJson(scene); delete projection.cameras.cam_front.projectionEvidenceIds; assert.ok(codes(validateScene(projection)).includes('CAMERA_UNCALIBRATED'));
  });
  test('depth range ordering, metric traceability and observed relation frames are semantic gates', () => {
    const scene = imageFixture(); scene.claims[scene.depths.dep_base.range].value = [0.8, 0.2]; assert.ok(codes(validateScene(scene)).includes('DEPTH_RANGE_INVALID'));
    const scale = fixture(); scale.evidence.ev_model = { kind: 'modelRun', producer: 'fixture-model', version: '1', runId: 'model-1', configSha256: 'd'.repeat(64), inputs: ['ev_measure'] }; scale.frame.scale = { mode: 'metric', metersPerUnit: 1, evidenceIds: ['ev_model'] }; assert.ok(codes(validateScene(scale)).includes('SCALE_UNRESOLVED'));
    const builder = new SpecBuilder(imageFixture()); builder.scene.relations.rel_above = { subjectId: 'obj_lamp', objectId: 'part_base', referenceFrame: 'world' }; builder.ensureClaim('/relations/rel_above/predicate', 'above', { origin: 'observed', evidenceIds: ['ev_pixels'], confidence: 1 }); assert.ok(codes(validateScene(builder.scene)).includes('UNSUPPORTED_OBSERVATION'));
    builder.scene.relations.rel_above.referenceFrame = 'camera'; builder.scene.relations.rel_above.cameraId = 'cam_front'; assert.equal(validateScene(builder.scene).valid, true);
    builder.scene.claims[builder.scene.relations.rel_above.predicate].value = 'supports'; assert.ok(codes(validateScene(builder.scene)).includes('UNSUPPORTED_OBSERVATION'));
  });
  test('hard dimension constraints require confirmed human claims and compatible intervals', () => {
    const builder = new SpecBuilder(fixture()); const human = { origin: 'human', evidenceIds: ['ev_measure'], confidence: 1, review: 'confirmed', reviewEvidenceId: 'ev_measure' };
    for (const [id, target] of [['con_one', 0.08], ['con_two', 0.2]]) {
      builder.scene.constraints[id] = { kind: 'dimension', partId: 'part_base', parameter: 'radius', severity: 'hard' };
      builder.ensureClaim(`/constraints/${id}/targetLength`, target, human); builder.ensureClaim(`/constraints/${id}/tolerance`, 0.001, human);
    }
    assert.ok(codes(validateScene(builder.scene)).includes('CONSTRAINT_CONFLICT'));
    builder.scene.claims[builder.scene.constraints.con_two.targetLength].value = 0.08; assert.equal(validateScene(builder.scene).valid, true);
    builder.scene.claims[builder.scene.constraints.con_one.targetLength].review = 'pending'; assert.ok(codes(validateScene(builder.scene)).includes('CONSTRAINT_CONFLICT'));
  });
  test('append-only records, failed patches and tombstone reuse preserve the baseline', () => {
    const scene = fixture(); const initial = hashJson(scene); const patch = renamePatch(scene, 'pch_test');
    patch.ops.push({ op: 'remove', collection: 'evidence', id: 'ev_measure' }); assert.equal(validatePatch(patch).valid, false); assert.throws(() => applyPatch(scene, patch)); assert.equal(hashJson(scene), initial);
    const remove = buildPatch(scene, 1, [{ op: 'remove', collection: 'parts', id: 'part_base' }, ...Object.entries(scene.claims).filter(([, claim]) => claim.target.startsWith('/parts/part_base/')).map(([id]) => ({ op: 'remove', collection: 'claims', id }))], { patchId: 'pch_delete', author: 'fixture', reason: 'remove part and slots' });
    const result = applyPatch(scene, remove); assert.ok(result.tombstones.some(item => item.id === 'part_base')); assert.equal(result.scene.revision, 2);
    const recreate = { kind: 'patch', schemaVersion: '1.0.0', sceneId: scene.sceneId, patchId: 'pch_reuse', baseRevision: 2, revision: 3, author: 'fixture', reason: 'must fail', ops: [{ op: 'add', collection: 'parts', id: 'part_base', value: scene.parts.part_base }] };
    throwsCode(() => applyPatch(result.scene, recreate, { tombstones: result.tombstones }), 'TOMBSTONE_REUSE'); assert.equal(hashJson(scene), initial);
  });
  test('Builder deterministically allocates IDs, reuses existing claim IDs and builds legal patches', () => {
    const scene = fixture(); const target = '/parts/part_base/geometry/radius'; const id = scene.parts.part_base.geometry.radius; const builder = new SpecBuilder(scene);
    assert.equal(builder.ensureClaim(target, 0.09, scene.claims[id]), id); const patch = builder.buildPatch(1, { author: 'designer', reason: 'new radius' }); assert.equal(applyPatch(scene, patch).scene.claims[id].value, 0.09);
    assert.equal(claimIdForTarget(target), claimIdForTarget(target));
    const conflict = claimIdForTarget(target); const replacement = claimIdForTarget(target, { tombstones: [conflict] }); assert.notEqual(conflict, replacement); assert.match(replacement, /^clm_[a-z][a-z0-9_]{0,47}$/);
    throwsCode(() => builder.setSlot('/parts/part_base/geometry/height', id), 'CLAIM_TARGET_MISMATCH');
  });
  test('SpecStore enforces grants, durable snapshots, isolated scopes and immutable create idempotence', async t => {
    const { rootDir, artifacts, store, scene } = await persistentFixture(t);
    await rejectsCode(store.create({ ...context, grantId: undefined, scene }), 'PERMISSION_DENIED');
    const receipt = await store.create({ ...context, sceneJson: JSON.stringify(scene) }); assert.equal(receipt.revision, 1); assert.match(receipt.sha256, /^[a-f0-9]{64}$/);
    assert.deepEqual(await store.create({ ...context, scene }), receipt);
    const restarted = new SpecStore({ rootDir, authorize, artifactStore: artifacts }); assert.deepEqual((await restarted.get({ ...context, sceneId: scene.sceneId })).scene, scene);
    await rejectsCode(restarted.get({ ...context, workspaceId: 'other-workspace', sceneId: scene.sceneId }), 'SCENE_NOT_FOUND');
    const changed = cloneJson(scene); changed.objects.obj_lamp.label = 'conflicting create'; await rejectsCode(store.create({ ...context, scene: changed }), 'REVISION_CONFLICT');
  });
  test('SpecStore rejects duplicates before creation and accepts authorized scene artifacts', async t => {
    const { artifacts, store, scene } = await persistentFixture(t);
    await rejectsCode(store.create({ ...context, sceneJson: JSON.stringify(scene).replace('"revision":1', '"revision":1,"revision":1') }), 'DUPLICATE_KEY');
    const artifact = await artifacts.put({ ...context, bytes: canonicalize(scene), mediaType: 'application/json', metadata: { kind: 'scene-specification', sceneId: scene.sceneId, revision: 1 } });
    assert.equal((await store.create({ ...context, artifactId: artifact.artifactId })).revision, 1);
  });
  test('SpecStore patch replay precedes stale baseline checks and detects changed patch IDs', async t => {
    const { store, scene } = await persistentFixture(t); await store.create({ ...context, scene });
    const patch = renamePatch(scene, 'pch_replay'); const receipt = await store.commit({ ...context, patch });
    assert.deepEqual(await store.commit({ ...context, patchJson: JSON.stringify(patch) }), receipt);
    const changed = cloneJson(patch); changed.reason = 'same ID different content'; await rejectsCode(store.commit({ ...context, patch: changed }), 'PATCH_ID_CONFLICT');
    const stale = renamePatch(scene, 'pch_stale'); await rejectsCode(store.commit({ ...context, patch: stale }), 'REVISION_CONFLICT');
    const audit = await store.getReceipt({ ...context, sceneId: scene.sceneId, patchId: patch.patchId }); assert.equal(audit.actor, context.actor); assert.equal(audit.audit.declaredAuthor, 'declared-author');
    assert.equal((await store.listRevisions({ ...context, sceneId: scene.sceneId })).length, 2); assert.equal((await store.replay({ ...context, sceneId: scene.sceneId })).verifiedRevisions, 2);
  });
  test('SpecStore failed final-state validation publishes no revision', async t => {
    const { store, scene } = await persistentFixture(t); await store.create({ ...context, scene });
    const patch = renamePatch(scene, 'pch_bad'); patch.ops.push({ op: 'remove', collection: 'claims', id: scene.parts.part_base.geometry.radius });
    await assert.rejects(store.commit({ ...context, patch })); assert.equal((await store.get({ ...context, sceneId: scene.sceneId })).revision, 1);
  });
  test('SpecStore crash before publication leaves no partial transaction and retry succeeds', async t => {
    const { rootDir, artifacts, store, scene } = await persistentFixture(t); await store.create({ ...context, scene });
    const patch = renamePatch(scene, 'pch_fault'); const failed = new SpecStore({ rootDir, authorize, artifactStore: artifacts, beforePublish: () => { throw new Error('injected crash before commit point'); } });
    await assert.rejects(failed.commit({ ...context, patch }), /injected crash/); assert.equal((await store.get({ ...context, sceneId: scene.sceneId })).revision, 1);
    assert.equal((await store.commit({ ...context, patch })).revision, 2);
  });
  test('abrupt process exit leaves only uncommitted temporary bytes and restart recovers', async t => {
    const { rootDir, store, scene } = await persistentFixture(t); await store.create({ ...context, scene });
    const patch = renamePatch(scene, 'pch_process_crash'); assert.equal((await worker(rootDir, patch, { crash: true })).crashed, true);
    assert.equal((await store.get({ ...context, sceneId: scene.sceneId })).revision, 1);
    assert.equal((await store.commit({ ...context, patch })).revision, 2); assert.equal((await store.replay({ ...context, sceneId: scene.sceneId })).verifiedRevisions, 2);
  });
  test('independent Node processes compete through filesystem CAS, with exactly one winner', async t => {
    const { rootDir, store, scene } = await persistentFixture(t); await store.create({ ...context, scene });
    const results = await Promise.all([worker(rootDir, renamePatch(scene, 'pch_race_a', 'A')), worker(rootDir, renamePatch(scene, 'pch_race_b', 'B'))]);
    assert.equal(results.filter(result => result.ok).length, 1); assert.equal(results.find(result => !result.ok).code, 'REVISION_CONFLICT');
    const reopened = await store.get({ ...context, sceneId: scene.sceneId }); assert.equal(reopened.revision, 2); assert.equal((await store.replay({ ...context, sceneId: scene.sceneId })).verifiedRevisions, 2);
  });
  test('ArtifactStore stable IDs, SHA verification, workspace authorization and retention are enforced', async t => {
    const rootDir = await temporary(t); const artifacts = new ArtifactStore({ rootDir, authorize });
    const a = await artifacts.put({ ...context, bytes: Buffer.from('same bytes'), mediaType: 'application/octet-stream' }); const b = await artifacts.put({ ...context, bytes: 'same bytes', mediaType: 'application/octet-stream' }); assert.equal(a.artifactId, b.artifactId);
    assert.equal((await artifacts.get({ ...context, artifactId: a.artifactId, sha256: a.sha256 })).bytes.toString(), 'same bytes');
    await rejectsCode(artifacts.get({ ...context, workspaceId: 'other', artifactId: a.artifactId }), 'ASSET_UNAVAILABLE'); await rejectsCode(artifacts.get({ ...context, artifactId: a.artifactId, sha256: '0'.repeat(64) }), 'ASSET_DIGEST_MISMATCH');
    const expired = new ArtifactStore({ rootDir, authorize, now: () => new Date('2100-01-01T00:00:00.000Z') }); await rejectsCode(expired.get({ ...context, artifactId: a.artifactId }), 'ASSET_EXPIRED');
    await fs.writeFile(path.join(rootDir, 'blobs', a.sha256.slice(0, 2), a.sha256), 'corrupt'); await rejectsCode(artifacts.get({ ...context, artifactId: a.artifactId }), 'ASSET_DIGEST_MISMATCH');
  });
  test('SpecStore verifies source artifact SHA and source workspace access', async t => {
    const { store, scene } = await persistentFixture(t); scene.sources.src_note.sha256 = 'f'.repeat(64); await rejectsCode(store.create({ ...context, scene }), 'ASSET_DIGEST_MISMATCH');
    const defaultDeny = new SpecStore({ rootDir: await temporary(t) }); await rejectsCode(defaultDeny.create({ ...context, scene }), 'PERMISSION_DENIED');
  });
  test('Compiler emits only controlled ops with independent binding and unit conversion', () => {
    const scene = fixture(); scene.frame.scale = { mode: 'metric', metersPerUnit: 0.01, evidenceIds: ['ev_measure'] };
    const plan = compileScene(scene, { binding, blenderUnitScaleLength: 0.1 }); assert.ok(plan.ops.every(op => FIRST_BATCH_OPS.includes(op.opId))); assert.equal(plan.binding.sceneRevision, 8); assert.equal(plan.specRevision, 1);
    const mesh = plan.ops.find(op => op.opId === 'mesh.primitive'); assert.ok(Math.abs(mesh.args.shape.radius - 0.008) < 1e-12); assert.equal(mesh.args.shape.segments, 32);
    for (const op of plan.ops) assert.equal(validateOperation(op.opId, op.args).valid, true, `Formal operation schema: ${op.opId}`);
    assert.equal(plan.planHash, compileScene(scene, { binding, blenderUnitScaleLength: 0.1 }).planHash); assert.notEqual(plan.planHash, compileScene(scene, { binding, segments: 48 }).planHash);
    throwsCode(() => compileScene(scene), 'INVALID_BINDING');
  });
  test('Compiler unknown/candidate/rejected values never become defaults and pending is provisional', () => {
    const builder = new SpecBuilder(fixture()); const radius = builder.scene.parts.part_base.geometry.radius;
    builder.ensureClaim('/parts/part_base/geometry/radius', undefined, { status: 'unknown', reason: 'unmeasured' });
    const plan = compileScene(builder.buildSnapshot(), { binding }); assert.equal(plan.ops.some(op => op.opId === 'mesh.primitive'), false); assert.ok(plan.unresolved.some(item => item.code === 'CLAIM_UNKNOWN' && item.instancePath === '/parts/part_base/geometry/radius')); assert.equal(plan.ops.some(op => op.opId === 'object.ensure'), true);
    const pending = fixture(); pending.claims[radius].review = 'pending'; delete pending.claims[radius].reviewEvidenceId; assert.equal(compileScene(pending, { binding }).requiresHumanApproval, true);
    const rejected = fixture(); rejected.claims[radius].review = 'rejected'; assert.equal(compileScene(rejected, { binding }).ops.some(op => op.opId === 'mesh.primitive'), false);
  });
  test('Compiler explicitly reports unsupported sphere geometry and unassigned multiple materials', () => {
    const builder = new SpecBuilder(fixture()); const part = builder.scene.parts.part_base; delete builder.scene.claims[part.geometry.height]; delete part.geometry.height; part.geometry.kind = 'sphere'; builder.scene.claims[part.geometry.classClaim].value = 'sphere';
    const plan = compileScene(builder.buildSnapshot(), { binding }); assert.ok(plan.unresolved.some(item => item.code === 'UNSUPPORTED_GEOMETRY')); assert.equal(plan.ops.some(op => op.opId === 'mesh.primitive'), false);
    const scene = fixture(); scene.parts.part_base.materialIds = []; scene.materials.mat_paint.sampleSrgb8 = undefined; delete scene.materials.mat_paint.sampleSrgb8;
    const report = compileScene(scene, { binding }); assert.ok(report.unresolved.some(item => item.instancePath === '/materials/mat_paint/family' && item.code === 'UNMAPPED_FIELD'));
  });
  test('Compiler refuses managed identity/content conflicts and requires proof and delete approval', () => {
    const scene = fixture(); const conflicted = compileScene(scene, { binding, managedState: [{ stableId: 'obj_lamp', sceneId: scene.sceneId, managedBy: 'dsh-agent', inManagedCollection: true, contentHash: 'a', actualContentHash: 'b' }] }); assert.equal(conflicted.ops.some(op => op.opId === 'object.ensure'), false);
    const removed = cloneJson(scene); delete removed.parts.part_base; for (const [id, claim] of Object.entries(removed.claims)) if (claim.target.startsWith('/parts/part_base/')) delete removed.claims[id]; removed.revision = 2;
    const unproven = compileScene(removed, { binding, previousScene: scene }); assert.ok(unproven.unresolved.some(item => item.code === 'DELETE_OWNERSHIP_UNPROVEN'));
    const plan = compileScene(removed, { binding, previousScene: scene, managedState: [{ stableId: 'part_base', sceneId: scene.sceneId, managedBy: 'dsh-agent', inManagedCollection: true, contentHash: 'a'.repeat(64), actualContentHash: 'a'.repeat(64) }] });
    assert.ok(plan.ops.find(op => op.opId === 'object.remove').permissions.includes('scene:delete-managed')); assert.equal(plan.requiresHumanApproval, true);
  });
  test('CPU PNG normalization fully decodes RGBA and preserves alpha with stable output', () => {
    const pixels = Buffer.from([255, 0, 0, 255, 0, 255, 0, 128, 0, 0, 255, 0]); const png = encodeRgbaPng(3, 1, pixels); const normalized = normalizeReferenceImage(png);
    assert.deepEqual(normalized.pixels, pixels); assert.equal(normalized.transparentPixels, 2); assert.equal(normalized.sha256, sha256(normalized.bytes)); assert.deepEqual(normalizeReferenceImage(normalized.bytes).bytes, normalized.bytes);
    const corrupt = Buffer.from(png); corrupt[30] ^= 1; throwsCode(() => normalizeReferenceImage(corrupt), 'DECODE_FAILED'); throwsCode(() => normalizeReferenceImage(Buffer.from('GIF89a')), 'ALGORITHM_UNAVAILABLE');
  });
  test('ROI mappings preserve subpixels, reject padding and round rectangles outwards', () => {
    const mapping = createRoiMapping({ widthPx: 801, heightPx: 603, rectPx: [199, 101, 401, 301], outputWidth: 1000, outputHeight: 800, contentRect: [20, 30, 960, 720] });
    for (const point of [[199.5, 101.5], [400.25, 300.75], [599.999, 401.999]]) {
      const roundTrip = mapPointToSource(mapping, mapPointFromSource(mapping, point)); assert.ok(Math.hypot(roundTrip[0] - point[0], roundTrip[1] - point[1]) < 1e-9);
    }
    throwsCode(() => mapPointToSource(mapping, [0, 0]), 'PADDING_POINT'); assert.deepEqual(mapRectToSource(mapping, [0, 0, 1000, 800]), [199, 101, 401, 301]); assert.equal(mapRectToSource(mapping, [0, 0, 10, 10]), null);
    const enlarged = createRoiMapping({ widthPx: 800, heightPx: 600, rectPx: [200, 100, 400, 400], outputWidth: 800, outputHeight: 800 }); assert.deepEqual(mapPointToSource(enlarged, [1, 1]), [200.5, 100.5]); assert.deepEqual(mapRectToSource(enlarged, [1, 1, 3, 3]), [200, 100, 2, 2]);
  });
}
