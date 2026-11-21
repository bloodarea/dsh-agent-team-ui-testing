/**
 * 运行环境互斥：同一目标环境同一时刻只跑一种运行环境（调试视图只对着一个目标）。
 *
 * 契约（docs/target-environments.md §运行环境provider开关）：
 * - 打开一个运行环境，就把它同环境的兄弟全部关闭（web 的 chrome/edge/firefox，3D 的 blender…）；
 * - web 的单选执行端 `provider` 跟着开关走：打开的开关 = 要跑的那个；
 * - 一次补丁里写多个 enabled:true 时，以最后一个为准（明确、可预测，不依赖对象顺序以外的规则）；
 * - 旧配置里多个同时启用时，加载后收敛成一个，且保留 `provider` 指向的那个；
 * - 全部关闭是合法的（该环境没有可用运行环境，执行侧如实报 provider-disabled）。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  ConfigStore,
  DEFAULT_CONFIG,
  enforceSingleProvider,
  normalizeConfig,
  resolveSnapshot,
} from '../../core/index.js';

async function tempDir(t) {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-provider-exclusive-'));
  t.after(async () => {
    await rm(dir, { recursive: true, force: true });
  });
  return dir;
}

test('打开一个运行环境会关掉同环境的其它运行环境（web）', async (t) => {
  const dir = await tempDir(t);
  const store = new ConfigStore({ dir });
  store.load();

  const edge = store.write({
    expectedRevision: 0,
    scope: 'global',
    patch: { environments: { web: { providers: { edge: { enabled: true } } } } },
  });
  assert.deepEqual(edge.config.global.environments.web.providers, {
    chrome: { enabled: false },
    edge: { enabled: true },
    firefox: { enabled: false },
  });
  assert.equal(edge.config.global.environments.web.provider, 'edge', '执行端跟着开关走');

  const firefox = store.write({
    expectedRevision: 1,
    scope: 'global',
    patch: { environments: { web: { providers: { firefox: { enabled: true } } } } },
  });
  assert.deepEqual(firefox.config.global.environments.web.providers, {
    chrome: { enabled: false },
    edge: { enabled: false },
    firefox: { enabled: true },
  });
  assert.equal(firefox.config.global.environments.web.provider, 'firefox');
});

test('同一补丁里打开多个：以最后一个为准', async (t) => {
  const dir = await tempDir(t);
  const store = new ConfigStore({ dir });
  store.load();
  const written = store.write({
    expectedRevision: 0,
    scope: 'global',
    patch: {
      environments: {
        web: { providers: { chrome: { enabled: true }, edge: { enabled: true } } },
      },
    },
  });
  const providers = written.config.global.environments.web.providers;
  assert.deepEqual(Object.entries(providers).filter(([, entry]) => entry.enabled).map(([id]) => id), ['edge']);
  assert.equal(written.config.global.environments.web.provider, 'edge');
});

test('把当前运行的关掉是合法的：该环境进入"没有可用运行环境"并如实上报', async (t) => {
  const dir = await tempDir(t);
  const store = new ConfigStore({ dir });
  store.load();
  store.write({
    expectedRevision: 0,
    scope: 'global',
    patch: { view: 'web', environments: { web: { providers: { edge: { enabled: true } } } } },
  });
  store.write({
    expectedRevision: 1,
    scope: 'global',
    patch: { environments: { web: { providers: { edge: { enabled: false } } } } },
  });
  const config = store.getConfig();
  assert.equal(config.global.environments.web.providers.edge.enabled, false);
  assert.equal(config.global.environments.web.providers.chrome.enabled, false);
  const snapshot = resolveSnapshot(config, {});
  assert.equal(snapshot.source.rejectedProviderReason, 'provider-disabled');
});

test('3D 的 Blender 同样互斥（单 provider 环境不会因此变成"无 provider"）', async (t) => {
  const dir = await tempDir(t);
  const store = new ConfigStore({ dir });
  store.load();
  const on = store.write({
    expectedRevision: 0,
    scope: 'global',
    patch: { environments: { 'three-d': { enabled: true, providers: { blender: { enabled: true } } } } },
  });
  assert.deepEqual(on.config.global.environments['three-d'].providers, { blender: { enabled: true } });
  const off = store.write({
    expectedRevision: 1,
    scope: 'global',
    patch: { environments: { 'three-d': { providers: { blender: { enabled: false } } } } },
  });
  assert.deepEqual(off.config.global.environments['three-d'].providers, { blender: { enabled: false } });
});

test('旧配置里同时启用多个运行环境：加载后收敛成一个，保留已选中的那个', () => {
  const legacy = normalizeConfig({
    version: 1,
    revision: 3,
    global: {
      view: 'web',
      environments: {
        web: {
          enabled: true,
          provider: 'edge',
          providers: { chrome: { enabled: true }, edge: { enabled: true }, firefox: { enabled: true } },
        },
      },
    },
  });
  assert.deepEqual(legacy.global.environments.web.providers, {
    chrome: { enabled: false },
    edge: { enabled: true },
    firefox: { enabled: false },
  });
  assert.equal(legacy.global.environments.web.provider, 'edge', '已选中的那个不要被改掉');
  // 默认配置本身也是"恰好一个"。
  assert.deepEqual(
    Object.entries(DEFAULT_CONFIG.global.environments.web.providers).filter(([, entry]) => entry.enabled),
    [['chrome', { enabled: true }]],
  );
});

test('explicit provider 写入同样只留一个启用的运行环境', () => {
  const entry = enforceSingleProvider('web', {
    enabled: true,
    provider: 'firefox',
    providers: { chrome: { enabled: true }, edge: { enabled: false }, firefox: { enabled: true } },
  }, { preferred: 'firefox' });
  assert.deepEqual(entry.providers, {
    chrome: { enabled: false },
    edge: { enabled: false },
    firefox: { enabled: true },
  });
  // 未知名字不因为"唯一启用的那个"而被改写（不静默换浏览器）。
  const unknown = enforceSingleProvider('web', {
    provider: 'safari',
    providers: { chrome: { enabled: true } },
  });
  assert.equal(unknown.provider, 'safari');
  assert.deepEqual(unknown.providers, { chrome: { enabled: true } });
});
