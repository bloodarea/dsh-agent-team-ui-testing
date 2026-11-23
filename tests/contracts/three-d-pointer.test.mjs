import test from 'node:test';
import assert from 'node:assert/strict';
import { encodeViewportResponse, parseViewportRequest } from '../../targets/three-d/runtime.js';

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

test('viewport shading requires the current generation and a supported Blender mode', () => {
  for (const shading of ['WIREFRAME', 'SOLID', 'MATERIAL', 'RENDERED']) {
    assert.equal(parseViewportRequest({ input: [], generation, shading }).shading, shading);
  }
  assert.throws(() => parseViewportRequest({ input: [], shading: 'SOLID' }), invalid);
  assert.throws(() => parseViewportRequest({ input: [], generation, shading: 'solid' }), invalid);
  assert.throws(() => parseViewportRequest({ camera: [0, 0, 1], shading: 'SOLID' }), invalid);
});

test('workspace switches are scoped to a generation and cannot carry old editor input', () => {
  for (const workspace of ['layout', 'modeling', 'sculpting', 'uv-editing', 'texture-paint', 'shading', 'animation', 'rendering', 'compositing']) {
    assert.equal(parseViewportRequest({ input: [], generation, workspace }).workspace, workspace);
  }
  assert.throws(() => parseViewportRequest({ input: [], workspace: 'layout' }), invalid);
  assert.throws(() => parseViewportRequest({ input: [], generation, workspace: 'Layout' }), invalid);
  assert.throws(() => parseViewportRequest({ input: [middle], generation, workspace: 'rendering' }), invalid);
  assert.throws(() => parseViewportRequest({ input: [], generation, workspace: 'layout', shading: 'SOLID' }), invalid);
  assert.throws(() => parseViewportRequest({ camera: [0, 0, 1], workspace: 'layout' }), invalid);
});

test('floating editor input targets only declared panels in the current generation', () => {
  const editors = ['outliner', 'properties'];
  const input = [{ ...middle, editor: 'outliner' }, { kind: 'cancel', editor: 'properties' }];
  assert.deepEqual(parseViewportRequest({ editors, generation, input }), { editors, generation, size: [960, 540],
    input: [{ ...input[0], ctrl: false, alt: false }, input[1]] });
  assert.deepEqual(parseViewportRequest({ editors, input: [] }).editors, editors);
  assert.throws(() => parseViewportRequest({ editors, input }), invalid);
  assert.throws(() => parseViewportRequest({ editors: ['properties'], generation, input }), invalid);
  for (const editors of [['main'], ['outliner', 'outliner'], 'outliner', null]) {
    assert.throws(() => parseViewportRequest({ editors, input: [] }), invalid);
  }
});

test('viewport responses keep the single PNG API and describe each extra PNG in byte order', () => {
  const png = Buffer.from('viewport');
  const editor = { id: 'properties', png: Buffer.from('properties') };
  const frame = { png, generation, content: [0, 0, 960, 540] };
  assert.deepEqual(encodeViewportResponse(png).body, png);
  assert.equal(encodeViewportResponse(frame).headers['Content-Type'], 'image/png');
  const bundle = encodeViewportResponse({ ...frame, editors: [editor] });
  assert.equal(bundle.headers['X-DSH-Blender-Generation'], generation);
  assert.equal(bundle.headers['Content-Type'], 'application/octet-stream');
  assert.deepEqual(JSON.parse(bundle.headers['X-DSH-Blender-Images']), [['viewport', png.length], ['properties', editor.png.length]]);
  assert.deepEqual(bundle.body, Buffer.concat([png, editor.png]));
});
