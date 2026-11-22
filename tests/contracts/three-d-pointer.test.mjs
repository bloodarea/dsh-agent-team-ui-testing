import test from 'node:test';
import assert from 'node:assert/strict';
import { parseViewportRequest } from '../../targets/three-d/runtime.js';

const generation = 'a'.repeat(32);
const middle = { kind: 'down', x: 0.4, y: 0.7, button: 1, shift: true };
const parse = (input, token = generation) => parseViewportRequest({ input, generation: token, size: [800, 600] });
const invalid = { code: 'INVALID_ARGUMENT', status: 400 };

test('viewport accepts ordered pointer input and retains the camera-only protocol', () => {
  assert.deepEqual(parse([middle, { kind: 'wheel', x: 1, y: 0, delta: -2 }, { kind: 'escape' }]), {
    size: [800, 600], generation, input: [
      { ...middle, ctrl: false, alt: false },
      { kind: 'wheel', x: 1, y: 0, delta: -2, shift: false, ctrl: false, alt: false },
      { kind: 'escape' },
    ],
  });
  assert.deepEqual(parseViewportRequest({ input: [] }), { size: [960, 540], input: [], generation: undefined });
  assert.deepEqual(parseViewportRequest({ camera: [0, 20, 1] }), { size: [960, 540], camera: [0, 20, 1] });
});

test('viewport refuses input without a generation and rejects unsupported events or coordinates', () => {
  assert.throws(() => parseViewportRequest({ input: [middle] }), invalid);
  assert.throws(() => parse([middle], 'old'), invalid);
  for (const event of [null, { ...middle, x: 1.1 }, { ...middle, button: 3 }, { ...middle, shift: 1 },
    { ...middle, kind: 'key', key: 'F12' }, { kind: 'wheel', x: 0, y: 0, delta: 9 }]) {
    assert.throws(() => parse([event]), invalid);
  }
  assert.throws(() => parse(Array(33).fill(middle)), invalid);
  assert.throws(() => parseViewportRequest({ input: [], camera: [0, 0, 1] }), invalid);
});
