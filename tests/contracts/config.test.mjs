/**
 * M1 config model + ConfigStore tests.
 *
 * All persistence tests use mkdtemp directories outside the repo and clean them up. No network,
 * no browser, no dependence on the host's real DSH config directory.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  CONFIG_VERSION,
  ConfigStore,
  DEFAULT_CONFIG,
  KNOWN_ENVIRONMENTS,
  capabilitiesForEnvironment,
  normalizeConfig,
  resolveSnapshot,
  validatePatch,
  workspaceKeyOf,
} from '../../core/index.js';

async function tempDir(t) {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-core-config-'));
  t.after(async () => {
    await rm(dir, { recursive: true, force: true });
  });
  return dir;
}

function assertCode(code) {
  return (error) => {
    assert.equal(error?.code, code, `expected ${code}, got ${error?.code}: ${error?.message}`);
    return true;
  };
}

test('default config is minimal, web-only, and normalize is idempotent', () => {
  assert.equal(CONFIG_VERSION, 1);
  assert.equal(DEFAULT_CONFIG.version, CONFIG_VERSION);
  assert.equal(DEFAULT_CONFIG.revision, 0);
  assert.equal(DEFAULT_CONFIG.global.environment, 'web');
  assert.deepEqual(DEFAULT_CONFIG.global.enabledEnvironments, ['web']);
  assert.deepEqual(DEFAULT_CONFIG.global.environments.web, {
    enabled: true,
    targetId: null,
    provider: 'chrome',
    providers: {
      chrome: { enabled: true },
      edge: { enabled: false },
      firefox: { enabled: false },
    },
  });
  assert.deepEqual(DEFAULT_CONFIG.workspaces, {});
  assert.deepEqual(DEFAULT_CONFIG.sessions, {});
  assert.ok(Object.isFrozen(DEFAULT_CONFIG));

  assert.equal(KNOWN_ENVIRONMENTS.web.planned, false);
  assert.equal(KNOWN_ENVIRONMENTS.fake.testOnly, true);
  assert.equal(KNOWN_ENVIRONMENTS['linux-desktop'].planned, true);
  assert.equal(KNOWN_ENVIRONMENTS.android.planned, true);
  assert.equal(KNOWN_ENVIRONMENTS['mini-program'].planned, true);

  const normalized = normalizeConfig(DEFAULT_CONFIG);
  assert.deepEqual(normalized, structuredClone(DEFAULT_CONFIG));
  assert.notEqual(normalized, DEFAULT_CONFIG);
});

test('normalizeConfig fills defaults and drops unknown keys', () => {
  const config = normalizeConfig({
    version: 1,
    revision: 2,
    extra: 'drop me',
    global: {
      view: 'web',
      environment: 'web',
      enabledEnvironments: ['web'],
      unknown: true,
      environments: {
        web: { enabled: true, targetId: null, unknown: 1 },
        chrome: { enabled: true },
      },
    },
    workspaces: { '/w': { environment: 'web', junk: 1 } },
    sessions: { s1: { environment: 'web', junk: 2 } },
  });
  assert.equal(config.extra, undefined);
  assert.equal(config.global.unknown, undefined);
  assert.equal(config.global.environments.chrome, undefined);
  assert.equal(config.global.environments.web.unknown, undefined);
  assert.equal(config.global.environments.fake.enabled, false);
  assert.equal(config.workspaces['/w'].junk, undefined);
  assert.equal(config.sessions.s1.junk, undefined);
  assert.equal(config.revision, 2);
});

test('normalizeConfig rejects structurally invalid configs', () => {
  const invalid = [
    'nope',
    42,
    [],
    { version: 2 },
    { revision: -1 },
    { revision: 1.5 },
    { global: { environment: 'unknown-env' } },
    { global: { environment: 'linux-desktop' } },
    { global: { enabledEnvironments: 'web' } },
    { global: { environments: { web: { enabled: 'yes' } } } },
    { global: { environments: { web: { targetId: 7 } } } },
    { workspaces: [] },
    { sessions: null },
  ];
  for (const value of invalid) {
    assert.throws(() => normalizeConfig(value), assertCode('CONFIG_INVALID'), JSON.stringify(value));
  }
});

test('validatePatch enforces scope keys and test-only environments', () => {
  assert.deepEqual(
    validatePatch({ scope: 'session', patch: { environment: 'web', targetId: 't1' } }),
    { environment: 'web', targetId: 't1' },
  );
  assert.throws(() => validatePatch({ scope: 'session', patch: {} }), assertCode('CONFIG_INVALID'));
  assert.throws(
    () => validatePatch({ scope: 'session', patch: { enabledEnvironments: ['web'] } }),
    assertCode('CONFIG_INVALID'),
  );
  assert.throws(
    () => validatePatch({ scope: 'bogus', patch: { environment: 'web' } }),
    assertCode('CONFIG_INVALID'),
  );
  assert.throws(
    () => validatePatch({ scope: 'global', patch: { environment: 'fake' } }),
    assertCode('CONFIG_INVALID'),
  );
  assert.equal(
    validatePatch({ scope: 'global', patch: { environment: 'fake' } }, { allowTestEnvironments: true }).environment,
    'fake',
  );
  assert.throws(
    () => validatePatch({ scope: 'global', patch: { environment: 'android' } }),
    assertCode('CONFIG_INVALID'),
  );
  assert.throws(
    () => validatePatch({ scope: 'global', patch: { enabledEnvironments: ['web', 'mini-program'] } }),
    assertCode('CONFIG_INVALID'),
  );
  assert.deepEqual(
    validatePatch(
      { scope: 'global', patch: { enabledEnvironments: ['web', 'fake', 'web'] } },
      { allowTestEnvironments: true },
    ).enabledEnvironments,
    ['web', 'fake'],
  );
  assert.throws(
    () => validatePatch({ scope: 'global', patch: { environments: { web: { enabled: 'x' } } } }),
    assertCode('CONFIG_INVALID'),
  );
  assert.throws(
    () => validatePatch({ scope: 'global', patch: { environments: { web: { bogus: 1 } } } }),
    assertCode('CONFIG_INVALID'),
  );
});

test('global -> workspace -> session precedence with source provenance', () => {
  const config = normalizeConfig({
    global: {
      // `view` 是这个 Host 的默认视图；`environment` 是旧字段，不参与视图解析。
      view: 'web',
      environment: 'web',
      enabledEnvironments: ['web', 'fake'],
      environments: { web: { targetId: 'g' } },
    },
    workspaces: {
      '/w': { environment: 'fake', environments: { fake: { targetId: 'w' } } },
    },
    sessions: {
      s1: { environment: 'web', targetId: 's' },
    },
  });

  const sessionSnap = resolveSnapshot(
    config,
    { agent: { id: 's1' }, workspaceKey: '/w' },
    { allowTestEnvironments: true },
  );
  assert.equal(sessionSnap.environment, 'web');
  assert.equal(sessionSnap.targetId, 's');
  assert.equal(sessionSnap.source.inheritedFrom, null);
  assert.equal(sessionSnap.source.sessionId, 's1');
  assert.equal(sessionSnap.source.workspaceKey, '/w');
  assert.equal(sessionSnap.source.globalRevision, 0);
  assert.equal(sessionSnap.source.rejectedEnvironment, null);
  assert.deepEqual(sessionSnap.enabledEnvironments, ['web', 'fake']);

  const workspaceSnap = resolveSnapshot(
    config,
    { agent: { id: 's2' }, workspaceKey: '/w' },
    { allowTestEnvironments: true },
  );
  assert.equal(workspaceSnap.environment, 'fake');
  assert.equal(workspaceSnap.targetId, 'w');
  assert.equal(workspaceSnap.source.inheritedFrom, 'workspace');

  const globalSnap = resolveSnapshot(
    config,
    { agent: { id: 's3' }, workspaceKey: '/other' },
    { allowTestEnvironments: true },
  );
  assert.equal(globalSnap.environment, 'web');
  assert.equal(globalSnap.targetId, 'g');
  assert.equal(globalSnap.source.inheritedFrom, 'global');
});

test('session choices inherit from parentSession with depth and cycle protection', () => {
  const inherit = normalizeConfig({
    global: { view: 'web', environment: 'web', enabledEnvironments: ['web', 'fake'] },
    sessions: { parent: { environment: 'fake', targetId: 'pt' } },
  });
  const inherited = resolveSnapshot(
    inherit,
    { agent: { id: 'child', session: { header: { parentSession: 'parent' } } } },
    { allowTestEnvironments: true },
  );
  assert.equal(inherited.environment, 'fake');
  assert.equal(inherited.targetId, 'pt');
  assert.equal(inherited.source.inheritedFrom, 'parent');

  const chained = normalizeConfig({
    global: { view: 'web', environment: 'web', enabledEnvironments: ['web', 'fake'] },
    sessions: {
      a: { parentSession: 'b' },
      b: { parentSession: 'c' },
      c: { environment: 'fake' },
    },
  });
  const chainedSnap = resolveSnapshot(chained, { agent: { id: 'a' } }, { allowTestEnvironments: true });
  assert.equal(chainedSnap.environment, 'fake');
  assert.equal(chainedSnap.source.inheritedFrom, 'c');

  // 成环且没有可用选择时落到空态：没有全局兜底，也没有"碰巧启用的 Web"。
  const cycle = normalizeConfig({ sessions: { a: { parentSession: 'b' }, b: { parentSession: 'a' } } });
  const cycleSnap = resolveSnapshot(cycle, { agent: { id: 'a' } });
  assert.equal(cycleSnap.environment, 'default');
  assert.equal(cycleSnap.source.inheritedFrom, 'default');

  const deep = { global: { view: 'web', environment: 'web', enabledEnvironments: ['web', 'fake'] }, sessions: {} };
  for (let index = 0; index < 9; index += 1) deep.sessions[`s${index}`] = { parentSession: `s${index + 1}` };
  deep.sessions.s9 = { environment: 'fake' };
  const deepSnap = resolveSnapshot(normalizeConfig(deep), { agent: { id: 's0' } }, { allowTestEnvironments: true });
  // 深度截断后不再继承到 s9，但这一层的兜底是"主机默认视图"（global.view），不是空态。
  assert.equal(deepSnap.environment, 'web', 'inheritance must stop before depth 8 and fall back to the host default view');
});

test('a rejected selection falls back to the empty view, never to another target', () => {
  const config = normalizeConfig({
    global: { view: 'web', environment: 'web', enabledEnvironments: ['web'], environments: { web: { enabled: true } } },
    sessions: { s1: { environment: 'fake' } },
  });
  const withTest = resolveSnapshot(config, { agent: { id: 's1' } }, { allowTestEnvironments: true });
  assert.equal(withTest.environment, 'default', '被拒的选择不会顶替成别的环境');
  assert.equal(withTest.view, 'fake', 'view 保留用户真正选过的值');
  assert.equal(withTest.source.rejectedEnvironment, 'fake');

  const withoutTest = resolveSnapshot(config, { agent: { id: 's1' } });
  assert.equal(withoutTest.environment, 'default');
  assert.equal(withoutTest.source.rejectedEnvironment, 'fake');

  const workspaceOverride = normalizeConfig({
    global: { view: 'web', environment: 'web', enabledEnvironments: ['web', 'fake'] },
    workspaces: { '/w': { environment: 'fake', enabledEnvironments: ['web'] } },
  });
  const workspaceSnap = resolveSnapshot(
    workspaceOverride,
    { workspaceKey: '/w' },
    { allowTestEnvironments: true },
  );
  assert.equal(workspaceSnap.environment, 'default');
  assert.equal(workspaceSnap.source.rejectedEnvironment, 'fake');

  // 默认视图本身也不可用时（被关掉的全局默认）同样只落空态。
  const noWeb = normalizeConfig({
    global: { view: 'web', environment: 'web', enabledEnvironments: ['fake'], environments: { web: { enabled: false } } },
  });
  const fallback = resolveSnapshot(noWeb, {}, { allowTestEnvironments: true });
  assert.equal(fallback.environment, 'default');
  assert.equal(fallback.source.rejectedEnvironment, 'web');
});

test('capabilities come only from the selected environment catalog', () => {
  // 空态视图没有任何能力：这是"没有选择目标环境"的诚实答案。
  const emptySnap = resolveSnapshot(DEFAULT_CONFIG, {});
  assert.equal(emptySnap.environment, 'default');
  assert.deepEqual(emptySnap.capabilities, []);

  const webSnap = resolveSnapshot(normalizeConfig({
    global: { view: 'web', environment: 'web', environments: { web: { enabled: true } } },
  }), {});
  assert.deepEqual(webSnap.capabilities, capabilitiesForEnvironment('web'));
  assert.ok(webSnap.capabilities.includes('web.p0.network'));
  assert.ok(webSnap.capabilities.every((id) => id.startsWith('web.')));

  const fakeConfig = normalizeConfig({
    global: { view: 'fake', environment: 'fake', enabledEnvironments: ['web', 'fake'] },
  });
  const fakeSnap = resolveSnapshot(fakeConfig, {}, { allowTestEnvironments: true });
  assert.ok(fakeSnap.capabilities.length > 0);
  assert.ok(fakeSnap.capabilities.every((id) => id.startsWith('fake.')));
  assert.equal(fakeSnap.capabilities.some((id) => id.startsWith('web.')), false);
  assert.equal(fakeSnap.capabilities.includes('fake.p0.network'), true);

  // Enabling both environments does not leak fake capabilities into a web snapshot.
  const bothEnabled = normalizeConfig({
    global: { view: 'web', environment: 'web', enabledEnvironments: ['web', 'fake'] },
  });
  const bothSnap = resolveSnapshot(bothEnabled, {}, { allowTestEnvironments: true });
  assert.equal(bothSnap.environment, 'web');
  assert.deepEqual(bothSnap.capabilities, capabilitiesForEnvironment('web'));
});

test('ConfigStore persists atomically with 0600/0700 and reloads', async (t) => {
  const dir = await tempDir(t);
  const store = new ConfigStore({ dir, now: () => 111 });
  assert.equal(store.path, join(dir, 'config.json'));
  store.load();
  store.load();
  assert.equal(store.getConfig().revision, 0);

  const result = store.write({ expectedRevision: 0, scope: 'global', patch: { environment: 'web' } });
  assert.equal(result.revision, 1);
  assert.equal(result.config.revision, 1);

  const file = join(dir, 'config.json');
  const onDisk = JSON.parse(await readFile(file, 'utf8'));
  assert.equal(onDisk.revision, 1);
  assert.equal((await stat(file)).mode & 0o777, 0o600);
  assert.equal((await stat(dir)).mode & 0o777, 0o700);
  assert.deepEqual(await readdir(dir), ['config.json']);

  const reloaded = new ConfigStore({ dir });
  reloaded.load();
  assert.equal(reloaded.getConfig().revision, 1);
  assert.deepEqual(reloaded.getConfig(), onDisk);

  const copy = reloaded.getConfig();
  copy.global.environment = 'fake';
  assert.equal(reloaded.getConfig().global.environment, 'web');
});

test('CAS conflicts do not modify memory or disk', async (t) => {
  const dir = await tempDir(t);
  const store = new ConfigStore({ dir });
  store.load();
  store.write({ expectedRevision: 0, scope: 'global', patch: { environment: 'web' } });
  const file = join(dir, 'config.json');
  const before = await readFile(file, 'utf8');

  assert.throws(
    () => store.write({ expectedRevision: 0, scope: 'global', patch: { environment: 'web' } }),
    (error) => {
      assert.equal(error.code, 'CONFIG_CONFLICT');
      assert.deepEqual(error.details, { expected: 0, actual: 1 });
      return true;
    },
  );
  assert.equal(await readFile(file, 'utf8'), before);
  assert.equal(store.getConfig().revision, 1);
});

test('select writes session/workspace/global targets and resolves them', async (t) => {
  const dir = await tempDir(t);
  const store = new ConfigStore({ dir });
  store.load();

  store.select({ scope: 'session', agentId: 's1', environment: 'web', targetId: 't1', expectedRevision: 0 });
  // `environment` 是旧调用方式：写入时同步成视图选择，两条路径落到同一个事实字段。
  assert.deepEqual(store.getConfig().sessions.s1, { view: 'web', environment: 'web', targetId: 't1' });
  const agentSnap = store.resolveForAgent({ id: 's1', session: { header: { cwd: dir } } });
  assert.equal(agentSnap.environment, 'web');
  assert.equal(agentSnap.targetId, 't1');
  assert.equal(agentSnap.source.workspaceKey, workspaceKeyOf({ cwd: dir }));
  const scopeSnap = store.resolveForScope({ id: 's1', cwd: dir });
  assert.equal(scopeSnap.targetId, 't1');

  const workspaceKey = workspaceKeyOf({ cwd: dir });
  store.select({
    scope: 'workspace',
    workspaceKey,
    environment: 'web',
    targetId: 'wt',
    expectedRevision: 1,
  });
  assert.equal(store.getConfig().workspaces[workspaceKey].environments.web.targetId, 'wt');

  store.select({ scope: 'global', environment: 'web', targetId: 'gt', expectedRevision: 2 });
  assert.equal(store.getConfig().global.environments.web.targetId, 'gt');

  // Workspace scope can derive the key from the agent/cwd, matching runtime entries.
  store.select({
    scope: 'workspace',
    agent: { session: { header: { cwd: dir } } },
    environment: 'web',
    targetId: 'wt2',
    expectedRevision: 3,
  });
  assert.equal(store.getConfig().workspaces[workspaceKey].environments.web.targetId, 'wt2');

  assert.throws(
    () => store.select({ scope: 'session', agentId: 's1' }),
    assertCode('CONFIG_INVALID'),
  );
  assert.throws(
    () => store.select({ scope: 'workspace', environment: 'web', targetId: 'x' }),
    assertCode('INVALID_ARGUMENT'),
  );
});

test('subscribers receive successful writes only and are removable', async (t) => {
  const dir = await tempDir(t);
  const store = new ConfigStore({ dir });
  store.load();
  const events = [];
  const unsubscribe = store.subscribe((event) => events.push(event));
  store.write({ expectedRevision: 0, scope: 'global', patch: { environment: 'web' } });
  assert.equal(events.length, 1);
  assert.equal(events[0].revision, 1);
  assert.equal(events[0].config.revision, 1);

  unsubscribe();
  store.write({ expectedRevision: 1, scope: 'global', patch: { environment: 'web' } });
  assert.equal(events.length, 1);

  const noisy = store.subscribe(() => {
    throw new Error('listener boom');
  });
  assert.doesNotThrow(
    () => store.write({ expectedRevision: 2, scope: 'global', patch: { environment: 'web' } }),
  );
  noisy();
  assert.equal(store.getConfig().revision, 3);

  store.dispose();
  store.write({ expectedRevision: 3, scope: 'global', patch: { environment: 'web' } });
  assert.equal(events.length, 1);
});

test('two store instances detect concurrent writes instead of overwriting', async (t) => {
  const dir = await tempDir(t);
  const first = new ConfigStore({ dir });
  first.load();
  const second = new ConfigStore({ dir });
  second.load();
  assert.equal(first.getConfig().revision, 0);
  assert.equal(second.getConfig().revision, 0);

  const written = first.write({ expectedRevision: 0, scope: 'global', patch: { environment: 'web' } });
  assert.equal(written.revision, 1);
  assert.throws(
    () => second.write({ expectedRevision: 0, scope: 'global', patch: { environment: 'web' } }),
    (error) => {
      assert.equal(error.code, 'CONFIG_CONFLICT');
      assert.equal(error.details.actual, 1);
      return true;
    },
  );
  const retried = second.write({ expectedRevision: 1, scope: 'global', patch: { environment: 'web' } });
  assert.equal(retried.revision, 2);
  assert.equal(JSON.parse(await readFile(join(dir, 'config.json'), 'utf8')).revision, 2);
});

test('corrupt config is backed up and replaced with defaults', async (t) => {
  const dir = await tempDir(t);
  const file = join(dir, 'config.json');
  await writeFile(file, '{not json', 'utf8');
  const logs = [];
  const store = new ConfigStore({
    dir,
    now: () => 424242,
    log: { warn: (message, details) => logs.push({ message, details }) },
  });
  assert.doesNotThrow(() => store.load());
  assert.equal(store.getConfig().revision, 0);
  assert.equal(store.loadError.reason, 'config-corrupt');
  assert.equal(store.loadError.backupPath, join(dir, 'config.json.corrupt-424242'));
  assert.equal(await readFile(store.loadError.backupPath, 'utf8'), '{not json');
  assert.equal(existsSync(file), false);
  assert.ok(logs.length >= 1);

  const written = store.write({ expectedRevision: 0, scope: 'global', patch: { environment: 'web' } });
  assert.equal(written.revision, 1);
  assert.equal(JSON.parse(await readFile(file, 'utf8')).revision, 1);
});

test('structurally invalid JSON is treated as corrupt, not fatal', async (t) => {
  const dir = await tempDir(t);
  const file = join(dir, 'config.json');
  await writeFile(file, JSON.stringify({ version: 99, revision: 5 }), 'utf8');
  const store = new ConfigStore({ dir, now: () => 7 });
  assert.doesNotThrow(() => store.load());
  assert.equal(store.getConfig().revision, 0);
  assert.equal(store.loadError.reason, 'config-corrupt');
  assert.equal(existsSync(join(dir, 'config.json.corrupt-7')), true);
});

test('unwritable directory loads in memory mode and refuses writes', async (t) => {
  const root = await tempDir(t);
  const blocker = join(root, 'blocker');
  await writeFile(blocker, 'not a directory', 'utf8');
  const store = new ConfigStore({ dir: blocker });
  assert.doesNotThrow(() => store.load());
  assert.equal(store.getConfig().revision, 0);
  assert.equal(store.loadError.reason, 'config-dir-unavailable');
  assert.throws(
    () => store.write({ scope: 'global', patch: { environment: 'web' } }),
    assertCode('OUTPUT_WRITE_FAILED'),
  );
});

test('fake environment is accepted only with allowTestEnvironments', async (t) => {
  const dir = await tempDir(t);
  const production = new ConfigStore({ dir });
  production.load();
  assert.throws(
    () => production.write({ expectedRevision: 0, scope: 'global', patch: { environment: 'fake' } }),
    assertCode('CONFIG_INVALID'),
  );
  assert.equal(production.getConfig().revision, 0);

  const testing = new ConfigStore({ dir, allowTestEnvironments: true });
  testing.load();
  const written = testing.write({
    expectedRevision: 0,
    scope: 'global',
    patch: { view: 'fake', environment: 'fake', enabledEnvironments: ['fake'] },
  });
  assert.equal(written.revision, 1);
  const snapshot = testing.resolveForAgent({ id: 'agent-1' });
  assert.equal(snapshot.environment, 'fake');
  assert.ok(snapshot.capabilities.every((id) => id.startsWith('fake.')));
});

test('inheritance uses the parent effective snapshot, not its raw entry', () => {
  const rejectedParent = normalizeConfig({
    global: {
      view: 'web',
      environment: 'web',
      enabledEnvironments: ['web'],
      environments: { web: { targetId: 'g' } },
    },
    sessions: { parent: { environment: 'fake', targetId: 'pf' } },
  });
  const inherited = resolveSnapshot(
    rejectedParent,
    { agent: { id: 'child', session: { header: { parentSession: 'parent' } } } },
    { allowTestEnvironments: true },
  );
  assert.equal(inherited.environment, 'default', 'parent fake was rejected：父会话的有效选择是空态');
  assert.equal(inherited.targetId, null, '父会话被拒后是空态，旧 targetId 不会跨环境泄漏');
  assert.equal(inherited.source.inheritedFrom, 'parent');
  assert.equal(inherited.source.rejectedEnvironment, 'fake');

  const ownWins = normalizeConfig({
    global: { view: 'web', environment: 'web', enabledEnvironments: ['web', 'fake'] },
    sessions: {
      parent: { environment: 'fake', targetId: 'pf' },
      child: { environment: 'web', targetId: 'ct' },
    },
  });
  const own = resolveSnapshot(
    ownWins,
    { agent: { id: 'child', session: { header: { parentSession: 'parent' } } } },
    { allowTestEnvironments: true },
  );
  assert.equal(own.environment, 'web');
  assert.equal(own.targetId, 'ct');
  assert.equal(own.source.inheritedFrom, null);

  const ownAfterRejectedParent = normalizeConfig({
    global: { view: 'web', environment: 'web', enabledEnvironments: ['web'] },
    sessions: { parent: { environment: 'fake' }, child: { environment: 'web' } },
  });
  const clean = resolveSnapshot(
    ownAfterRejectedParent,
    { agent: { id: 'child', session: { header: { parentSession: 'parent' } } } },
    { allowTestEnvironments: true },
  );
  assert.equal(clean.environment, 'web');
  assert.equal(clean.source.rejectedEnvironment, null, 'own valid selection must not inherit a parent rejection');
});

test('resolveSnapshot degrades malformed config instead of throwing', () => {
  const degraded = resolveSnapshot({ version: 99, global: { environment: 'bogus' } }, { agent: { id: 's1' } });
  assert.equal(degraded.environment, 'default', '坏配置退化成默认配置，也就是空态');
  assert.equal(degraded.revision, 0);
  assert.equal(degraded.source.degraded, true);
  assert.equal(typeof degraded.source.degradedReason, 'string');
  assert.deepEqual(degraded.capabilities, []);

  const normal = resolveSnapshot(DEFAULT_CONFIG, {});
  assert.equal(normal.source.degraded, false);
  assert.equal(normal.source.degradedReason, null);
});

test('config lock blocks writers, times out without modifying the file, and is released', async (t) => {
  const dir = await tempDir(t);
  const file = join(dir, 'config.json');
  const lock = join(dir, 'config.lock');
  const store = new ConfigStore({ dir, lockTimeoutMs: 60, lockPollMs: 10 });
  store.load();
  store.write({ expectedRevision: 0, scope: 'global', patch: { environment: 'web' } });
  const before = await readFile(file, 'utf8');

  await writeFile(lock, 'held by another process', 'utf8');
  assert.throws(
    () => store.write({ expectedRevision: 1, scope: 'global', patch: { environment: 'web' } }),
    (error) => {
      assert.equal(error.code, 'CONFIG_CONFLICT');
      assert.equal(error.details.timeoutMs, 60);
      return true;
    },
  );
  assert.equal(await readFile(file, 'utf8'), before, 'timed-out write must not modify the file');
  assert.equal(store.getConfig().revision, 1);

  await rm(lock);
  const written = store.write({ expectedRevision: 1, scope: 'global', patch: { environment: 'web' } });
  assert.equal(written.revision, 2);
  assert.equal(existsSync(lock), false, 'the lock must be released after a successful write');
  assert.deepEqual(await readdir(dir), ['config.json']);
});

test('workspaceKeyOf prefers workspace ids, normalizes cwd, and never invents a key', async (t) => {
  const dir = await tempDir(t);
  assert.equal(workspaceKeyOf({ workspaceId: 'w1', cwd: dir }), 'workspace:w1');
  assert.equal(workspaceKeyOf({ agent: { workspaceId: 'w2' }, cwd: dir }), 'workspace:w2');
  const fromCwd = workspaceKeyOf({ cwd: dir });
  assert.match(fromCwd, /^path:[0-9a-f]{64}$/);
  assert.equal(workspaceKeyOf({ cwd: `${dir}/.` }), fromCwd, 'cwd must be normalized before hashing');
  assert.equal(workspaceKeyOf({ agent: { session: { header: { cwd: dir } } } }), fromCwd);
  assert.equal(workspaceKeyOf({}), null);
  assert.equal(workspaceKeyOf({ cwd: '' }), null);
  assert.throws(() => new ConfigStore({}), assertCode('INVALID_ARGUMENT'));
});

test('planned 环境可以被"启用"，但不能成为当前执行环境', async () => {
  const { validatePatch } = await import('../../core/config.js');
  // 总开关（environments.<id>.enabled）允许 planned：启用 ≠ 可执行
  assert.deepEqual(
    validatePatch({ scope: 'global', patch: { environments: { android: { enabled: true } } } }).environments,
    { android: { enabled: true } },
  );
  // 但"当前执行环境"仍然拒绝 planned
  assert.throws(() => validatePatch({ scope: 'global', patch: { environment: 'android' } }), assertCode('CONFIG_INVALID'));
  // 且 enabledEnvironments 这个"可执行列表"保持严格（不让 planned 混进执行集合）
  assert.throws(
    () => validatePatch({ scope: 'global', patch: { enabledEnvironments: ['web', 'android'] } }),
    assertCode('CONFIG_INVALID'),
  );
});

test('启用 planned 环境：开关写进 environments 映射，但不进可执行集合', async (t) => {
  const { ConfigStore, DEFAULT_CONFIG } = await import('../../core/index.js');
  const { mkdtemp, rm } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const dir = await mkdtemp(join(tmpdir(), 'dsh-cfg-planned-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const store = new ConfigStore({ dir, initial: DEFAULT_CONFIG });
  const written = store.write({
    expectedRevision: 0,
    scope: 'global',
    patch: { environments: { android: { enabled: true } } },
  });
  assert.equal(written.config.global.environments.android.enabled, true, '开关没有落进配置');
  // 可执行集合（enabledEnvironments）保持严格：planned 不混进来
  assert.deepEqual(written.config.global.enabledEnvironments, DEFAULT_CONFIG.global.enabledEnvironments);
});
