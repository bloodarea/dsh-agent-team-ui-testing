/**
 * Computed-style read path (index.js `pickComputedStyle` / `readComputedStyleFallback`).
 *
 * `CSS.getComputedStyleForNode` reports longhands only, so a caller asking for `border-color`,
 * `margin` or `font` used to receive `undefined` (the DSH layer then dropped the key). The
 * fallback asks the page's own `getComputedStyle` for exactly the missing names; these tests pin
 * the split, the CDP call sequence and the "unknown/failed stays omitted" rule without a browser.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { pickComputedStyle, readComputedStyleFallback } from '../index.js';

test('longhands come from the CDP map, shorthands are reported missing', () => {
  const map = { color: 'rgb(1, 2, 3)', 'background-color': 'rgb(4, 5, 6)' };
  const { picked, missing } = pickComputedStyle(map, ['color', 'border-color', 'margin', 'background-color']);
  assert.deepEqual(picked, { color: 'rgb(1, 2, 3)', 'background-color': 'rgb(4, 5, 6)' });
  assert.deepEqual(missing, ['border-color', 'margin']);
});

test('a requested name the map lacks (even with an inherited key) is never taken from the prototype', () => {
  const { picked, missing } = pickComputedStyle({}, ['toString', 'border-color']);
  assert.deepEqual(picked, {});
  assert.deepEqual(missing, ['toString', 'border-color']);
});

test('fallback resolves shorthands through the page and keeps the CDP call order', async () => {
  const calls = [];
  const send = async (method, params) => {
    calls.push({ method, params });
    if (method === 'DOM.resolveNode') return { object: { objectId: 'node-object-1' } };
    if (method === 'Runtime.callFunctionOn') {
      const name = params.arguments[0].value;
      const value = { 'border-color': 'rgb(220, 38, 38)', margin: '8px', font: '' }[name];
      return { result: { value: value === undefined ? null : value } };
    }
    throw new Error('unexpected CDP method ' + method);
  };
  const out = await readComputedStyleFallback(send, 42, ['border-color', 'margin', 'font', 'not-a-property']);
  assert.deepEqual(out, { 'border-color': 'rgb(220, 38, 38)', margin: '8px' });
  assert.equal(calls[0].method, 'DOM.resolveNode');
  assert.deepEqual(calls[0].params, { nodeId: 42 });
  assert.equal(calls.length, 5);
  for (const call of calls.slice(1)) {
    assert.equal(call.method, 'Runtime.callFunctionOn');
    assert.equal(call.params.objectId, 'node-object-1');
    assert.equal(call.params.returnByValue, true);
    assert.equal(typeof call.params.functionDeclaration, 'string');
    assert.match(call.params.functionDeclaration, /getComputedStyle\(this\)\.getPropertyValue\(name\)/);
  }
});

test('an unresolvable node degrades to "nothing reported"', async () => {
  const send = async (method) => {
    if (method === 'DOM.resolveNode') throw new Error('node detached');
    throw new Error('must not be called');
  };
  assert.deepEqual(await readComputedStyleFallback(send, 7, ['margin']), {});
  const emptyObject = async (method) => {
    if (method === 'DOM.resolveNode') return { object: {} };
    throw new Error('must not be called');
  };
  assert.deepEqual(await readComputedStyleFallback(emptyObject, 7, ['margin']), {});
});

test('one failing property does not drop the others', async () => {
  const send = async (method, params) => {
    if (method === 'DOM.resolveNode') return { object: { objectId: 'obj-2' } };
    const name = params.arguments[0].value;
    if (name === 'font') throw new Error('evaluation failed');
    return { result: { value: name === 'margin' ? '8px' : 'rgb(1, 2, 3)' } };
  };
  const out = await readComputedStyleFallback(send, 9, ['font', 'margin', 'border-color']);
  assert.deepEqual(out, { margin: '8px', 'border-color': 'rgb(1, 2, 3)' });
});
