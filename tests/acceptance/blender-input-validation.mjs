import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { assertBlenderInput, createBlenderTools } from '../../targets/three-d/tools.js';
import { validateOperation } from '../../tools/blender/schema.js';

const live = { targetId: 'target_validation', generation: 1 };
const transform = rotation => ({
  opId: 'object.transform', opVersion: 1, stepId: 'rotate',
  args: { sceneId: 'scn_validation', stableId: 'obj_validation', translation: [0, 0, 0], rotation, scale: [1, 1, 1] },
});
const entries = ['plan', 'apply'].map(mode => ({
  label: `scene ${mode}`, tool: 'blender_scene_apply', instancePath: '/ops/1/args/rotation',
  request: rotation => ({
    action: 'apply', mode, ...live,
    ops: [{ opId: 'collection.ensure', opVersion: 1, stepId: 'ensure', args: { sceneId: 'scn_validation' } }, transform(rotation)],
  }),
}));
entries.push({
  label: 'view set', tool: 'blender_view', instancePath: '/changes/rotation',
  request: rotation => ({ action: 'set', ...live, expectViewRevision: 0, changes: { rotation } }),
});
const legal = [
  ['identity wxyz', [1, 0, 0, 0]],
  ['z-axis unit', [0, 0, 0, 1]],
  ['negative identity', [-1, 0, 0, 0]],
  ['distributed components', [0.5, 0.5, 0.5, 0.5]],
  ['inside upper squared-norm tolerance', [Math.sqrt(1 + 5e-5), 0, 0, 0]],
  ['inside lower squared-norm tolerance', [Math.sqrt(1 - 5e-5), 0, 0, 0]],
];
const illegal = [
  ['non-unit', [1, 0, 0, 1]],
  ['zero', [0, 0, 0, 0]],
  ['outside upper squared-norm tolerance', [Math.sqrt(1 + 2e-4), 0, 0, 0]],
  ['outside lower squared-norm tolerance', [Math.sqrt(1 - 2e-4), 0, 0, 0]],
  ['finite components with overflowing squared norm', [Number.MAX_VALUE, 0, 0, 0]],
];
for (const entry of entries) {
  for (const [label, rotation] of legal) {
    test(`${entry.label}: accepts ${label}`, () => {
      assert.doesNotThrow(() => assertBlenderInput(entry.tool, entry.request(rotation)));
    });
  }
  for (const [label, rotation] of illegal) {
    test(`${entry.label}: rejects ${label} with exact path before context or I/O`, async () => {
      let calls = 0;
      const unexpected = () => { calls++; throw new Error('Invalid input reached context or I/O.'); };
      const tool = createBlenderTools({ resolveContext: unexpected, getViewport: unexpected }).find(item => item.name === entry.tool);
      const check = error => {
        assert.equal(error.code, 'SCHEMA_INVALID');
        assert.equal(error.details.effectState, 'none');
        assert.equal(error.details.instancePath, entry.instancePath);
        return true;
      };
      assert.throws(() => assertBlenderInput(entry.tool, entry.request(rotation)), check);
      await assert.rejects(tool.execute(entry.request(rotation)), check);
      assert.equal(calls, 0);
    });
  }
}

test('view set allows updates without rotation', () => {
  const args = { action: 'set', ...live, expectViewRevision: 0, changes: { distance: 5 } };
  assert.doesNotThrow(() => assertBlenderInput('blender_view', args));
});

test('operation keyword matches tool-entry quaternion tolerance and reports /rotation', () => {
  for (const [label, rotation] of legal) {
    assert.equal(validateOperation('object.transform', transform(rotation).args).valid, true, label);
  }
  for (const [label, rotation] of illegal) {
    const result = validateOperation('object.transform', transform(rotation).args);
    assert.equal(result.valid, false, label);
    assert.ok(result.errors.some(error => error.instancePath === '/rotation' && error.keyword === 'unitQuaternion'), label);
  }
});

test('core schema validation works while every optional provider import is forbidden', () => {
  const schemaUrl = new URL('../../tools/blender/schema.js', import.meta.url).href;
  const script = `
    import assert from 'node:assert/strict';
    import { registerHooks } from 'node:module';
    registerHooks({ resolve(specifier, context, nextResolve) {
      const result = nextResolve(specifier, context);
      if (result.url.includes('/providers/')) throw new Error('Optional provider imported: ' + result.url);
      return result;
    } });
    const { validateOperation } = await import(${JSON.stringify(schemaUrl)});
    const args = ${JSON.stringify(transform([1, 0, 0, 0]).args)};
    assert.equal(validateOperation('object.transform', args).valid, true);
    assert.equal(validateOperation('object.transform', { ...args, rotation: [1, 0, 0, 1] }).valid, false);
    assert.equal(validateOperation('object.transform', { ...args, translation: [NaN, 0, 0] }).valid, false);
    console.log('Core validation completed without optional providers.');
  `;
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', script], { encoding: 'utf8' });
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
  assert.match(result.stdout, /Core validation completed without optional providers/);
});
