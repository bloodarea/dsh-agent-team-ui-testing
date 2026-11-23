import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createFakeConnectionService, createFakeSessionsService, createHarness, startPluginHttpServer } from '../acceptance/harness.mjs';
import { resolveBlenderProject } from '../../targets/three-d/projects.js';
import { parseViewportRequest } from '../../targets/three-d/runtime.js';

test('the Blender project route lists the bound workspace, with relative paths and owner admission', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'dsh-blender-project-contract-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const root = join(directory, 'workspace');
  const models = join(root, 'models');
  const config = join(directory, 'config');
  const other = join(directory, 'other');
  await Promise.all([mkdir(models, { recursive: true }), mkdir(config), mkdir(other), mkdir(join(root, '.hidden'), { recursive: true })]);
  await Promise.all([
    writeFile(join(root, 'Cube.blend'), ''), writeFile(join(models, '射灯.BLEND'), ''),
    writeFile(join(models, 'Cube.blend1'), ''), writeFile(join(root, '.hidden', 'Skip.blend'), ''),
    writeFile(join(other, 'Outside.blend'), ''),
    writeFile(join(config, 'config.json'), JSON.stringify({ version: 1, revision: 0, global: { view: 'three-d',
      environments: { 'three-d': { enabled: true, providers: { blender: { enabled: true } } } } } })),
  ]);
  await symlink(other, join(root, 'linked'), process.platform === 'win32' ? 'junction' : 'dir');
  assert.equal(await resolveBlenderProject(root, 'linked/Outside.blend'), null);
  const peer = { id: 'owner' };
  const connection = createFakeConnectionService({ browserPeer: peer, admit: { peer } });
  const entries = [{ id: 'workspace', path: root, sessionIds: ['project-session'] },
    { id: 'other', path: other, sessionIds: ['other-session'] }];
  const lookupStarted = Promise.withResolvers();
  const lookupResult = Promise.withResolvers();
  const harness = await createHarness({ connection, configDir: config,
    sessions: createFakeSessionsService({ cwd: root }),
    workspaceRegistry: {
      list: () => entries,
      async resolveByPath() {
        lookupStarted.resolve();
        return lookupResult.promise;
      },
    } });
  const server = await startPluginHttpServer(harness);
  try {
    const request = (identity = {}) => fetch(server.url + '/plugins/ui-testing/blender/projects', {
      headers: { 'X-UI-Testing-Scope-Version': '1', ...identity },
    });
    const response = await request({ 'X-UI-Testing-Session-Id': 'project-session' });
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { ok: true, projects: ['Cube.blend', 'models/射灯.BLEND'], truncated: false });
    const recent = await request({ 'X-UI-Testing-Scope': 'recent' });
    assert.deepEqual(await recent.json(), { ok: true, projects: [], truncated: false });
    connection.setAdmit({ peer: { id: 'non-owner' } });
    assert.equal((await request({ 'X-UI-Testing-Session-Id': 'project-session' })).status, 403);
    connection.setAdmit({ peer });
    const pendingFrame = fetch(server.url + '/plugins/ui-testing/blender/frame', {
      method: 'POST', signal: AbortSignal.timeout(5000), body: JSON.stringify({ input: [] }),
      headers: { 'Content-Type': 'application/json', 'X-UI-Testing-Scope-Version': '1', 'X-UI-Testing-Session-Id': 'lookup-session' },
    });
    await Promise.race([lookupStarted.promise, pendingFrame.then(() => assert.fail('Frame returned before workspace lookup'))]);
    const deletedWorkspace = entries.shift();
    await harness.ctx.emit('domain/changed', { domain: 'workspace', table: 'workspaces', key: 'workspace', operation: 'deleted' });
    lookupResult.resolve(deletedWorkspace);
    const removed = await pendingFrame;
    assert.equal(removed.status, 404);
    assert.equal((await removed.json()).code, 'SCOPE_NOT_FOUND');
  } finally {
    lookupResult.resolve(undefined);
    await server.close();
    await harness.dispose();
  }
});

test('Blender restart accepts workspace-relative project names and rejects incompatible changes', () => {
  const generation = 'a'.repeat(32);
  const restart = { input: [], generation, reload: true, project: 'models/Live scene.blend' };
  assert.equal(parseViewportRequest(restart).project, restart.project);
  assert.equal(parseViewportRequest({ ...restart, project: null }).reload, true);
  for (const invalid of [{ project: '../a.blend' }, { project: 'C:/a.blend' }, { project: 'foo\\a.blend' },
    { project: 'foo.blend1' }, { input: [{ kind: 'escape' }] }, { workspace: 'layout' }, { reload: false }]) {
    assert.throws(() => parseViewportRequest({ ...restart, ...invalid }), { code: 'INVALID_ARGUMENT' });
  }
});
