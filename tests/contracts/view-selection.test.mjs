/**
 * 视图选择：默认视图、按会话持久化、按工作区隔离。
 *
 * 契约（docs/debug-panel.md §视图选择）：
 * 1. 默认视图是一个**空态视图**，不是目标环境：它在 Host catalog 里、面板组合框里，但不可启用、
 *    没有适配器、不参加设置页分组。
 * 2. 选择链：`session.view` > 旧 `session.environment` > 父会话有效选择 > `workspace.view` >
 *    旧 `workspace.environment` > `global.view` > 默认视图。**没有"回退到 web"**：没存过选择就是空态。
 * 3. 会话选择会同时记进所属工作区，同工作区的新会话据此继承；不同工作区互不影响。
 * 4. 选择不可用（环境开关关掉 / planned）时落到默认视图，并在 `source.rejectedEnvironment` 与
 *    `snapshot.view` 里如实保留用户选过的值。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  ConfigStore,
  ENVIRONMENTS,
  KNOWN_ENVIRONMENTS,
  environmentCatalog,
  normalizeConfig,
  resolveSnapshot,
  workspaceKeyOf,
} from '../../core/index.js';

async function tempDir(t) {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-view-selection-'));
  t.after(async () => {
    await rm(dir, { recursive: true, force: true });
  });
  return dir;
}

const agent = (id, cwd) => ({ id, session: { header: { cwd } } });

test('默认视图是 catalog 第一行的空态视图，不是可启用的目标环境', () => {
  const catalog = environmentCatalog();
  assert.equal(catalog[0].id, ENVIRONMENTS.DEFAULT);
  assert.equal(catalog[0].kind, 'view');
  assert.equal(catalog[0].status, 'empty');
  assert.equal(catalog[0].label, '默认视图');
  assert.equal(KNOWN_ENVIRONMENTS[ENVIRONMENTS.DEFAULT].enableable, false);
  assert.equal(KNOWN_ENVIRONMENTS[ENVIRONMENTS.DEFAULT].selectable, true);
  assert.equal(KNOWN_ENVIRONMENTS[ENVIRONMENTS.DEFAULT].executable, false);
  // 只有它一行是视图行：设置页分组按 kind 过滤掉它。
  assert.deepEqual(catalog.filter((row) => row.kind === 'view').map((row) => row.id), [ENVIRONMENTS.DEFAULT]);
});

test('没有存过选择的会话落在默认视图：既不回退 web，也不挑别的环境', () => {
  const config = normalizeConfig({
    global: { environment: 'web', enabledEnvironments: ['web'], environments: { web: { enabled: true } } },
  });
  const snapshot = resolveSnapshot(config, { agent: agent('fresh-session', '/w/new') });
  assert.equal(snapshot.environment, ENVIRONMENTS.DEFAULT);
  assert.equal(snapshot.view, ENVIRONMENTS.DEFAULT);
  assert.deepEqual(snapshot.capabilities, [], '空态没有能力，也就没有工具面');
});

test('会话选择会写进会话与所属工作区，重启后仍然生效', async (t) => {
  const dir = await tempDir(t);
  const workspaceKey = workspaceKeyOf({ cwd: dir });
  const store = new ConfigStore({ dir });
  store.load();

  const written = store.select({ scope: 'session', view: 'three-d', agentId: 's1', cwd: dir, expectedRevision: 0 });
  assert.deepEqual(written.config.sessions.s1, { view: 'three-d' });
  // 同一次 revision 里记下"这个工作区最后一次选择"，供同工作区新会话继承。
  assert.deepEqual(written.config.workspaces[workspaceKey], { view: 'three-d' });

  const reloaded = new ConfigStore({ dir });
  reloaded.load();
  assert.equal(reloaded.resolveForAgent(agent('s1', dir)).view, 'three-d');
  assert.equal(reloaded.getConfig().revision, 1, '一次选择只涨一次 revision');
});

test('工作区隔离：A 用 3D、B 用 Web，互不影响', async (t) => {
  const root = await tempDir(t);
  const a = join(root, 'A');
  const b = join(root, 'B');
  const { mkdir } = await import('node:fs/promises');
  await mkdir(a);
  await mkdir(b);

  const store = new ConfigStore({ dir: join(root, 'cfg') });
  store.load();
  store.write({
    expectedRevision: 0,
    scope: 'global',
    patch: { environments: { 'three-d': { enabled: true } } },
  });
  store.select({ scope: 'session', view: 'three-d', agentId: 'a-1', cwd: a, expectedRevision: 1 });
  store.select({ scope: 'session', view: 'web', agentId: 'b-1', cwd: b, expectedRevision: 2 });

  assert.equal(store.resolveForAgent(agent('a-1', a)).view, 'three-d');
  assert.equal(store.resolveForAgent(agent('b-1', b)).view, 'web');

  // 同工作区的新会话继承该工作区最后一次选择。
  assert.equal(store.resolveForAgent(agent('a-2', a)).view, 'three-d');
  assert.equal(store.resolveForAgent(agent('b-2', b)).view, 'web');

  // 在 A 再选一次不会动 B。
  store.select({ scope: 'session', view: 'default', agentId: 'a-1', cwd: a, expectedRevision: 3 });
  assert.equal(store.resolveForAgent(agent('a-1', a)).view, ENVIRONMENTS.DEFAULT);
  assert.equal(store.resolveForAgent(agent('b-1', b)).view, 'web');
});

test('所有环境都没有可用目标时就是默认视图', async (t) => {
  const dir = await tempDir(t);
  const store = new ConfigStore({ dir });
  store.load();
  // 关掉 web 的开关与 allow-list：此刻没有任何可用的目标环境。
  store.write({ expectedRevision: 0, scope: 'global', patch: { environments: { web: { enabled: false } } } });
  const snapshot = store.resolveForAgent(agent('s1', dir));
  assert.equal(snapshot.environment, ENVIRONMENTS.DEFAULT);
  assert.deepEqual(snapshot.enabledEnvironments, ['web'], 'allow-list 记录的是"曾经启用过"，不是"现在可用"');
});

test('已存的选择被设置页关掉后落到默认视图，并保留用户选过的值', async (t) => {
  const dir = await tempDir(t);
  const store = new ConfigStore({ dir });
  store.load();
  store.write({ expectedRevision: 0, scope: 'global', patch: { environments: { 'three-d': { enabled: true } } } });
  store.select({ scope: 'session', view: 'three-d', agentId: 's1', cwd: dir, expectedRevision: 1 });
  assert.equal(store.resolveForAgent(agent('s1', dir)).view, 'three-d');

  store.write({ expectedRevision: 2, scope: 'global', patch: { environments: { 'three-d': { enabled: false } } } });
  const snapshot = store.resolveForAgent(agent('s1', dir));
  assert.equal(snapshot.environment, ENVIRONMENTS.DEFAULT);
  assert.equal(snapshot.view, 'three-d', '用户选过什么不能被抹掉');
  assert.equal(snapshot.source.rejectedEnvironment, 'three-d');

  // 重新打开开关，选择自己就回来了（不需要用户再选一次）。
  store.write({ expectedRevision: 3, scope: 'global', patch: { environments: { 'three-d': { enabled: true } } } });
  assert.equal(store.resolveForAgent(agent('s1', dir)).view, 'three-d');
});

test('面板按 Host 解析的选择走，组合框含默认视图，选择一律先落 Host', async () => {
  const clientSource = await readFile(new URL('../../client.js', import.meta.url), 'utf8');
  // 初始值就是空态，写死 'web' 会让"没选过"看起来像"选了 Web"。
  assert.match(clientSource, /const \[env, setEnv\] = React\.useState\('default'\);/u);
  // 组合框：视图行恒在，其余看开关。
  assert.match(clientSource, /if \(option\.kind === 'view'\) return Object\.assign\(\{\}, option, \{ enabled: true \}\);/u);
  // 宿主解析结果是唯一真值，不再把面板拽回"当前执行环境"。
  assert.match(clientSource, /const resolvedView = \(hostResolved && typeof hostResolved\.view === 'string' && hostResolved\.view\)/u);
  assert.match(clientSource, /setEnv\(\(current\) => \(current === resolvedView \? current : resolvedView\)\);/u);
  // 选择先落 Host：POST /config/select 带 view。
  assert.match(clientSource, /requestHostConfig\('POST', '\/config\/select', \{ scope: 'session', view, expectedRevision \}/u);
  // 空态有独立标记与文案。
  assert.match(clientSource, /'data-utb-default-view': 'true'/u);
});
