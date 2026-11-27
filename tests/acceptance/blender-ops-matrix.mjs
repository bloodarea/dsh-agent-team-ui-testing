import test from 'node:test';
import assert from 'node:assert/strict';
import { inspect } from 'node:util';
import { assertBlenderInput } from '../../targets/three-d/tools.js';
import {
  OP_IDS, blenderManifest, getOperationDefinition, getSchema, validateOperation,
} from '../../tools/blender/schema.js';

const sceneId = 'scn_matrix';
const digest = 'a'.repeat(64);
// Keep the expected roster independent of OP_IDS so a missing operation cannot go unnoticed.
const matrices = {
  'collection.ensure': {
    minimal: { sceneId },
    full: { sceneId: 'scn_full_matrix' },
    ids: { sceneId: 'obj_wrong' },
  },
  'object.ensure': {
    minimal: { sceneId, stableId: 'obj_matrix', label: 'Object', kind: 'empty' },
    full: { sceneId, stableId: 'part_matrix', label: 'Mesh part', kind: 'mesh' },
    ids: { sceneId: 'obj_wrong', stableId: 'scn_wrong' },
  },
  'object.parent': {
    minimal: { sceneId, childId: 'obj_child', parentId: null },
    full: { sceneId, childId: 'part_child', parentId: 'obj_parent' },
    ids: { sceneId: 'obj_wrong', childId: 'scn_wrong', parentId: 'mat_wrong' },
  },
  'object.transform': {
    minimal: { sceneId, stableId: 'obj_matrix', translation: [0, 0, 0], rotation: [1, 0, 0, 0], scale: [1, 1, 1] },
    full: { sceneId, stableId: 'part_matrix', translation: [-2, 3.5, 4], rotation: [0, 0, 0, 1], scale: [0.5, 2, 3] },
    ids: { sceneId: 'obj_wrong', stableId: 'mat_wrong' },
    numericPaths: ['/translation/0', '/rotation/0', '/scale/0'],
  },
  'mesh.primitive': {
    minimal: { sceneId, stableId: 'part_matrix', shape: { kind: 'cylinder', radius: 1, height: 1 } },
    full: { sceneId, stableId: 'part_matrix', shape: { kind: 'cylinder', radius: 2.5, height: 3, segments: 256 } },
    ids: { sceneId: 'obj_wrong', stableId: 'obj_wrong' },
    numericPaths: ['/shape/radius', '/shape/height', '/shape/segments'],
    legal: [
      ['cylinder segments minimum', { shape: { kind: 'cylinder', radius: 1, height: 1, segments: 3 } }],
      ['frustum minimal', { shape: { kind: 'frustum', bottomRadius: 1, topRadius: 0, height: 1 } }],
      ['frustum full minimum segments', { shape: { kind: 'frustum', bottomRadius: 0, topRadius: 1, height: 2, segments: 3 } }],
      ['frustum full maximum segments', { shape: { kind: 'frustum', bottomRadius: 2, topRadius: 1, height: 2, segments: 256 } }],
      ['box minimal and full', { shape: { kind: 'box', size: [1, 2, 3] } }],
    ],
  },
  'object.remove': {
    minimal: { sceneId, stableId: 'obj_matrix', expectedManagedHash: digest, cascadeIds: [] },
    full: { sceneId, stableId: 'part_matrix', expectedManagedHash: 'f'.repeat(64), cascadeIds: ['obj_child', 'part_child'] },
    ids: { sceneId: 'obj_wrong', stableId: 'mat_wrong' },
  },
  'material.ensure': {
    minimal: { sceneId, stableId: 'mat_matrix', label: 'Material' },
    full: { sceneId, stableId: 'mat_matrix', label: 'Paint', roughness: 0.5, metallic: 0, opacity: 1, baseColorLinear: [0, 0.5, 1] },
    ids: { sceneId: 'obj_wrong', stableId: 'part_wrong' },
    numericPaths: ['/roughness', '/metallic', '/opacity', '/baseColorLinear/0'],
    legal: [
      ['material numeric lower bounds', { roughness: 0, metallic: 0, opacity: 0, baseColorLinear: [0, 0, 0] }],
      ['material numeric upper bounds', { roughness: 1, metallic: 1, opacity: 1, baseColorLinear: [1, 1, 1] }],
    ],
  },
  'material.assign': {
    minimal: { sceneId, targetStableId: 'part_matrix', materialId: 'mat_matrix', slot: 0 },
    // The actual v1 schema caps slot at 63, not 255.
    full: { sceneId: 'scn_full_matrix', targetStableId: 'part_other', materialId: 'mat_other', slot: 63 },
    ids: { sceneId: 'obj_wrong', targetStableId: 'obj_wrong', materialId: 'part_wrong' },
    numericPaths: ['/slot'],
  },
};

const executionClasses = new Set([
  'cold-read', 'project-lifecycle', 'blender-main-read', 'blender-view-write',
  'blender-scene-write', 'offline-worker', 'job-control',
]);

function changed(value, pointer, replacement) {
  // JSON round trips would turn NaN/Infinity into null and invalidate the test.
  const copy = structuredClone(value);
  const keys = pointer.slice(1).split('/');
  let parent = copy;
  for (const key of keys.slice(0, -1)) parent = parent[key];
  parent[keys.at(-1)] = replacement;
  return copy;
}

function operationRequest(opId, args) {
  return {
    action: 'apply', mode: 'plan', targetId: 'target_matrix', generation: 1,
    ops: [{ opId, opVersion: 1, stepId: 'matrix_step', args: structuredClone(args) }],
  };
}

function rejected(opId, { name, value, instancePath, keyword, params }) {
  const result = validateOperation(opId, value);
  const detail = `${opId}: ${name}; value=${inspect(value)}; result=${inspect(result, { depth: 6 })}`;
  assert.equal(result.valid, false, detail);
  assert.ok(Array.isArray(result.errors) && result.errors.length > 0, detail);
  for (const error of result.errors) {
    assert.equal(typeof error.instancePath, 'string', detail);
    assert.equal(typeof error.schemaPath, 'string', detail);
    assert.equal(typeof error.keyword, 'string', detail);
    assert.match(error.instancePath, /^(?:\/(?:[^~]|~[01])*)*$/, detail);
  }
  // Match the specific offending location, never just a generic oneOf failure.
  assert.ok(result.errors.some(error => error.instancePath === instancePath
    && (!keyword || error.keyword === keyword)
    && Object.entries(params || {}).every(([key, expected]) => error.params?.[key] === expected)), detail);
}

function illegalCases(opId, matrix) {
  const cases = [];
  const add = (name, value, instancePath, keyword, params) => cases.push({ name, value, instancePath, keyword, params });
  const set = (name, pointer, value, keyword) => add(name, changed(matrix.full, pointer, value), pointer, keyword);
  const schema = getOperationDefinition(opId).schema;
  for (const field of schema.required) {
    const value = structuredClone(matrix.minimal);
    delete value[field];
    add(`missing required ${field}`, value, '', 'required', { missingProperty: field });
  }
  add('extra top-level property', { ...matrix.full, unexpected: true }, '', 'additionalProperties', { additionalProperty: 'unexpected' });
  for (const [field, value] of Object.entries(matrix.ids)) set(`wrong prefix ${field}`, `/${field}`, value, 'pattern');
  // Operations without numeric fields must reject non-finite numbers as ID values too.
  for (const pointer of matrix.numericPaths || ['/sceneId']) {
    for (const value of [NaN, Infinity, -Infinity]) set(`non-finite ${pointer}=${String(value)}`, pointer, value);
  }

  if (opId === 'object.ensure' || opId === 'material.ensure') {
    set('empty label', '/label', '', 'minLength');
    set('overlong label', '/label', 'x'.repeat(1025), 'maxLength');
  }
  if (opId === 'object.ensure') set('unknown object kind', '/kind', 'light', 'enum');
  if (opId === 'object.parent') set('invalid parent type', '/parentId', {}, 'type');
  if (opId === 'object.transform') {
    for (const [field, length] of [['translation', 3], ['rotation', 4], ['scale', 3]]) {
      set(`${field} too short`, `/${field}`, Array(length - 1).fill(1), 'minItems');
      set(`${field} too long`, `/${field}`, Array(length + 1).fill(1), 'maxItems');
    }
    for (const value of [0, -1]) set(`non-positive scale ${value}`, '/scale/0', value, 'exclusiveMinimum');
    // Runtime requires abs(sum(v*v) - 1) <= 1e-4; schema must reject the same inputs.
    set('non-unit quaternion', '/rotation', [1, 0, 0, 1], 'unitQuaternion');
    set('zero quaternion', '/rotation', [0, 0, 0, 0], 'unitQuaternion');
  }
  if (opId === 'mesh.primitive') {
    const shapeCase = (name, shape, pointer, keyword, params) => add(name, { ...matrix.minimal, shape }, pointer, keyword, params);
    const shapes = [
      { kind: 'cylinder', radius: 1, height: 1, segments: 32 },
      { kind: 'frustum', bottomRadius: 1, topRadius: 0.5, height: 1, segments: 32 },
      { kind: 'box', size: [1, 1, 1] },
    ];
    shapeCase('unknown shape kind', { kind: 'sphere', radius: 1 }, '/shape/kind', 'const');
    shapeCase('cylinder with frustum bottomRadius', { ...shapes[0], bottomRadius: 1 }, '/shape', 'additionalProperties', { additionalProperty: 'bottomRadius' });
    for (const shape of shapes) {
      const branch = schema.properties.shape.oneOf.find(item => item.properties.kind.const === shape.kind);
      for (const field of branch.required) {
        const incomplete = structuredClone(shape);
        delete incomplete[field];
        shapeCase(`${shape.kind} missing ${field}`, incomplete, '/shape', 'required', { missingProperty: field });
      }
      shapeCase(`${shape.kind} extra field`, { ...shape, unexpected: true }, '/shape', 'additionalProperties', { additionalProperty: 'unexpected' });
      if (shape.kind !== 'box') {
        for (const segments of [2, 257, 3.5]) {
          shapeCase(`${shape.kind} segments=${segments}`, { ...shape, segments }, '/shape/segments', segments === 2 ? 'minimum' : segments === 257 ? 'maximum' : 'type');
        }
        for (const height of [0, -1]) shapeCase(`${shape.kind} height=${height}`, { ...shape, height }, '/shape/height', 'exclusiveMinimum');
      }
      const fields = shape.kind === 'cylinder' ? ['radius'] : shape.kind === 'frustum' ? ['bottomRadius', 'topRadius'] : [];
      for (const field of fields) {
        for (const value of [NaN, Infinity, -Infinity, -1, ...(shape.kind === 'cylinder' ? [0] : [])]) {
          shapeCase(`${shape.kind} ${field}=${String(value)}`, { ...shape, [field]: value }, `/shape/${field}`);
        }
      }
      if (shape.kind === 'box') {
        for (const value of [NaN, Infinity, -Infinity, 0, -1]) shapeCase(`box size[0]=${String(value)}`, { ...shape, size: [value, 1, 1] }, '/shape/size/0');
        for (const size of [[1, 1], [1, 1, 1, 1]]) shapeCase(`box size length=${size.length}`, { ...shape, size }, '/shape/size', size.length === 2 ? 'minItems' : 'maxItems');
      }
    }
  }
  if (opId === 'object.remove') {
    set('invalid hash', '/expectedManagedHash', 'not-a-digest', 'pattern');
    set('invalid cascade ID prefix', '/cascadeIds/0', 'scn_wrong', 'pattern');
    set('cascade too long', '/cascadeIds', Array(1025).fill('obj_child'), 'maxItems');
  }
  if (opId === 'material.ensure') {
    for (const field of ['roughness', 'metallic', 'opacity']) {
      set(`${field} below zero`, `/${field}`, -0.01, 'minimum');
      set(`${field} above one`, `/${field}`, 1.01, 'maximum');
    }
    set('color below zero', '/baseColorLinear/0', -0.01, 'minimum');
    set('color above one', '/baseColorLinear/0', 1.01, 'maximum');
    set('color too short', '/baseColorLinear', [0, 1], 'minItems');
    set('color too long', '/baseColorLinear', [0, 0, 0, 1], 'maxItems');
  }
  if (opId === 'material.assign') {
    for (const slot of [-1, 64, 255, 256, 0.5]) set(`slot=${slot}`, '/slot', slot, slot < 0 ? 'minimum' : Number.isInteger(slot) ? 'maximum' : 'type');
  }
  return cases;
}

test('operation matrix covers exactly all eight registered and manifest operations', () => {
  assert.equal(Object.keys(matrices).length, 8);
  assert.deepEqual([...OP_IDS].sort(), Object.keys(matrices).sort());
  assert.deepEqual(blenderManifest.operations.map(item => item.opId).sort(), Object.keys(matrices).sort());
});

for (const [opId, matrix] of Object.entries(matrices)) {
  const legal = [
    ['minimal', matrix.minimal],
    ['full', matrix.full],
    ...(matrix.legal || []).map(([name, fields]) => [name, { ...matrix.minimal, ...fields }]),
  ];
  const illegal = illegalCases(opId, matrix);
  console.log(`OP_MATRIX: ${opId} legal=${legal.length} illegal=${illegal.length}`);

  test(`${opId}: manifest and full-field fixture match the contract`, () => {
    const entries = blenderManifest.operations.filter(item => item.opId === opId);
    assert.equal(entries.length, 1);
    const [entry] = entries;
    assert.equal(entry.opVersion, 1);
    assert.ok(executionClasses.has(entry.executionClass), entry.executionClass);
    const schema = getSchema(entry.schemaRef);
    assert.equal(schema.$id, `urn:dsh:blender:operation:${opId}:v1`);
    assert.equal(schema, getOperationDefinition(opId).schema);
    assert.deepEqual(Object.keys(matrix.full).sort(), Object.keys(schema.properties).sort());
    assert.deepEqual(Object.keys(matrix.minimal).sort(), [...schema.required].sort());
  });
  for (const [name, value] of legal) {
    test(`${opId}: legal ${name}`, () => {
      const result = validateOperation(opId, structuredClone(value));
      assert.deepEqual(result, { valid: true, errors: [] }, inspect(result, { depth: 6 }));
      assert.doesNotThrow(() => assertBlenderInput('blender_scene_apply', operationRequest(opId, value)));
    });
  }
  // Independent tests keep every operation and failure visible after an earlier defect.
  // A negative accepted by the current configuration remains a failure, never an expected pass.
  for (const sample of illegal) test(`${opId}: must reject: ${sample.name}`, () => rejected(opId, sample));

  // Independently exercise the tool-entry defense; do not infer its result from the op layer.
  const entryCases = illegal.filter(sample => sample.name.startsWith('non-finite')
    || sample.name.includes('quaternion') || sample.name.endsWith('=Infinity'));
  for (const sample of entryCases) {
    test(`${opId}: tool entry must reject: ${sample.name}`, () => {
      const expectedPath = `/ops/0/args${sample.instancePath}`;
      assert.throws(() => assertBlenderInput('blender_scene_apply', operationRequest(opId, sample.value)), error => {
        assert.equal(error.code, 'SCHEMA_INVALID');
        const paths = [error.details?.instancePath, ...(error.details?.errors || []).map(item => item.instancePath)];
        assert.ok(paths.includes(expectedPath), `${sample.name}: expected ${expectedPath}; got ${inspect(paths)}`);
        return true;
      }, `${opId}: tool entry must reject ${sample.name}; value=${inspect(sample.value)}`);
    });
  }
}
