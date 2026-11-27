import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import { symlinkSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { publishImmutable, readRegular, safeDirectory } from '../../targets/three-d/spec/disk.js';

async function temporary(t) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'blender-storage-symlink-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  return directory;
}
const linkDirectory = (target, link) => symlinkSync(target, link, process.platform === 'win32' ? 'junction' : 'dir');
const rejectsUnsafe = promise => assert.rejects(promise, error => error.code === 'UNSAFE_PATH');

test('safeDirectory accepts linked roots and ancestors and returns real paths for storage IO', async t => {
  const temporaryRoot = await temporary(t);
  const actual = path.join(temporaryRoot, 'actual');
  const linked = path.join(temporaryRoot, 'linked');
  await fs.mkdir(actual);
  linkDirectory(actual, linked);
  assert.equal((await fs.lstat(linked)).isSymbolicLink(), true);

  const realRoot = await fs.realpath(actual);
  assert.equal(await safeDirectory(linked), realRoot);
  const directory = await safeDirectory(linked, 'blobs', 'ab');
  assert.equal(directory, path.join(realRoot, 'blobs', 'ab'));
  assert.equal(directory, await fs.realpath(directory));
  const publication = await publishImmutable(directory, 'fixture', Buffer.from('stored through real path'));
  assert.equal(publication.published, true);
  assert.equal((await readRegular(publication.path)).toString(), 'stored through real path');

  const nestedRoot = path.join(linked, 'new-config', 'storage');
  assert.equal(await safeDirectory(nestedRoot, 'specs'), path.join(realRoot, 'new-config', 'storage', 'specs'));
});

test('safeDirectory still rejects linked or non-directory components below the root', async t => {
  const temporaryRoot = await temporary(t);
  const root = path.join(temporaryRoot, 'root');
  const outside = path.join(temporaryRoot, 'outside');
  await fs.mkdir(root);
  await fs.mkdir(outside);
  linkDirectory(outside, path.join(root, 'blobs'));
  await rejectsUnsafe(safeDirectory(root, 'blobs', 'ab'));
  await fs.mkdir(path.join(root, 'specs'));
  linkDirectory(outside, path.join(root, 'specs', 'workspace'));
  await rejectsUnsafe(safeDirectory(root, 'specs', 'workspace', 'scene'));
  await fs.writeFile(path.join(root, 'file'), 'not a directory');
  await rejectsUnsafe(safeDirectory(root, 'file'));
  assert.deepEqual(await fs.readdir(outside), []);
});

test('safeDirectory rejects every invalid path component', async t => {
  const root = await temporary(t);
  for (const component of ['', '.', '..', '/', '\\', '../escape', '..\\escape', 'one/two', 'one\\two', null, 0]) {
    await rejectsUnsafe(safeDirectory(root, component));
  }
  await rejectsUnsafe(safeDirectory(root, 'specs', '..'));
});

test('safeDirectory creates a missing root before resolving its real path', async t => {
  const temporaryRoot = await temporary(t);
  const root = path.join(temporaryRoot, 'missing', 'config');
  await assert.rejects(fs.lstat(root), error => error.code === 'ENOENT');
  const directory = await safeDirectory(root, 'workspaces', 'fixture');
  assert.equal(directory, path.join(await fs.realpath(root), 'workspaces', 'fixture'));
  assert.equal((await fs.lstat(directory)).isDirectory(), true);
  assert.equal((await fs.lstat(directory)).isSymbolicLink(), false);
});
