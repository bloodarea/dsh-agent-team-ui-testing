import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import test from 'node:test';
import { createBlenderReferences, readBlenderReference } from '../../targets/three-d/references.js';

const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aK/oAAAAASUVORK5CYII=', 'base64');
const name = '立面.png';
const path = 'D:\\参考图 原始\\立面.png';
const generation = 'a'.repeat(32);

function upload(bytes = png, headers = {}) {
  const stream = Readable.from([bytes]);
  stream.headers = {
    'content-type': 'application/octet-stream',
    'x-dsh-blender-reference-name': encodeURIComponent(name),
    'x-dsh-blender-reference-path': encodeURIComponent(path),
    ...headers,
  };
  return readBlenderReference(stream, AbortSignal.timeout(5000));
}

test('references preserve selected image bytes and an optional physical path, scoped to one instance', async () => {
  const selected = await upload();
  const browser = await upload(png, { 'x-dsh-blender-reference-path': undefined });
  assert.deepEqual(selected, { name, path, contentType: 'image/png', bytes: png });
  assert.equal(browser.path, null);
  const instance = createBlenderReferences(generation);
  const nextInstance = createBlenderReferences('b'.repeat(32));
  assert.deepEqual(instance.add(selected), { id: 1, name, path });
  assert.deepEqual(instance.add(browser), { id: 2, name, path: null });
  assert.deepEqual(instance.list(), { generation, items: [{ id: 1, name, path }, { id: 2, name, path: null }] });
  assert.deepEqual(instance.get(1)?.bytes, png);
  assert.equal(nextInstance.get(1), undefined);
  assert.equal(nextInstance.add(selected).id, 1);
});

test('references reject active content, invalid metadata and oversized uploads without storing them', async () => {
  await assert.rejects(upload(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>')), { status: 415 });
  await assert.rejects(upload(png, { 'x-dsh-blender-reference-path': encodeURIComponent('../image.png') }), { status: 400 });
  await assert.rejects(upload(png, { 'content-length': String(32 * 1024 * 1024 + 1) }), { status: 413 });
  const ref = await upload();
  const instance = createBlenderReferences(generation);
  for (let i = 0; i < 64; i++) instance.add(ref);
  assert.throws(() => instance.add(ref), { code: 'BLENDER_REFERENCE_LIMIT' });
  assert.equal(instance.list().items.length, 64);
});

test('removing a reference keeps surviving IDs, frees the slot and is safe to retry', async () => {
  const ref = await upload();
  const instance = createBlenderReferences(generation);
  const original = Array.from({ length: 64 }, () => instance.add(ref));
  const removed = original[1];
  const remaining = original.filter(({ id }) => id !== removed.id);
  assert.deepEqual(instance.remove(removed.id), { generation, items: remaining });
  assert.equal(instance.get(removed.id), undefined);
  assert.deepEqual(instance.get(original[2].id).bytes, png);
  const added = instance.add(ref);
  assert.equal(added.id, 65);
  assert.deepEqual(instance.remove(removed.id).items, [...remaining, added]);
});
