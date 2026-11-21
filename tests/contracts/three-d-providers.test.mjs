/**
 * 3D（`three-d`）的 provider 轴契约。
 *
 * 3D 不是 web 的翻版：它只有一个运行环境（Blender），且只接到纯视口这一步。这些测试钉住三件事：
 * 1. 词表：Blender 的工程支持度是 `preview`，既能被读画面、又不是可执行的 provider；
 * 2. 配置：`environments['three-d'].providers.blender.enabled` 能存、能读、能跨重启保留，
 *    未知 provider 与非 provider 环境仍然被拒（不能因为开了口子就什么都收）；
 * 3. 默认值：3D 总开关打开即可用（Blender 默认开启），与纯视口接入前的行为一致。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  ConfigStore,
  DEFAULT_CONFIG,
  ENVIRONMENT_PROVIDER_IDS,
  ENVIRONMENT_PROVIDER_SUPPORT,
  THREE_D_PROVIDERS,
  environmentDeclaresProviders,
  environmentProviderIds,
  environmentProviderSupport,
  isExecutingProvider,
  isViewableProvider,
  normalizeConfig,
  resolveSnapshot,
  validatePatch,
} from '../../core/index.js';

async function tempDir(t) {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-three-d-providers-'));
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

test('Blender is the only 3D provider and its support is preview, not executable', () => {
  assert.deepEqual(environmentProviderIds('three-d'), [THREE_D_PROVIDERS.BLENDER]);
  assert.equal(environmentDeclaresProviders('three-d'), true);
  assert.equal(environmentProviderSupport('three-d', 'blender'), 'preview');
  assert.equal(isExecutingProvider('three-d', 'blender'), false, '纯视口不是执行适配器');
  assert.equal(isViewableProvider('three-d', 'blender'), true, '纯视口仍可读画面');
  // 目录与支持表必须描述同一组 id：多一个/少一个都是两套词表。
  assert.deepEqual(
    Object.keys(ENVIRONMENT_PROVIDER_SUPPORT['three-d']),
    [...ENVIRONMENT_PROVIDER_IDS['three-d']],
  );
  // 没有 provider 轴的环境不因为没有驱动而被当成"有 provider 但没实现"。
  assert.equal(environmentDeclaresProviders('game'), false);
  assert.deepEqual(environmentProviderIds('game'), []);
  assert.equal(environmentProviderSupport('three-d', 'maya'), null);
});

test('default config carries the 3D provider axis with the environment still off', () => {
  assert.deepEqual(DEFAULT_CONFIG.global.environments['three-d'], {
    enabled: false,
    targetId: null,
    providers: { blender: { enabled: true } },
  });
  // 3D 默认不启用：默认执行环境仍是 web。
  assert.deepEqual(DEFAULT_CONFIG.global.enabledEnvironments, ['web']);
  assert.equal(DEFAULT_CONFIG.global.environment, 'web');
});

test('a legacy config without a 3D entry gains one on load (otherwise the switch has no value to read)', () => {
  const normalized = normalizeConfig({
    version: 1,
    revision: 7,
    global: {
      view: 'web',
      environment: 'web',
      enabledEnvironments: ['web'],
      environments: {
        web: { enabled: true, provider: 'chrome' },
        'three-d': { enabled: true },
      },
    },
  });
  assert.deepEqual(normalized.global.environments['three-d'], {
    enabled: true,
    targetId: null,
    providers: { blender: { enabled: true } },
  });
  // 完全没有 three-d 条目的旧文件也要补上（关着、Blender 开着），这样设置页能读到值。
  const bare = normalizeConfig({ version: 1, revision: 0, global: { environments: { web: { enabled: true } } } });
  assert.equal(bare.global.environments['three-d'].enabled, false);
  assert.equal(bare.global.environments['three-d'].providers.blender.enabled, true);
  // 旧文件里若已保存 providers，读回时按 provider id 合并，不整块覆盖。
  const withSwitch = normalizeConfig({
    version: 1,
    revision: 8,
    global: { environments: { 'three-d': { enabled: true, providers: { blender: { enabled: false } } } } },
  });
  assert.equal(withSwitch.global.environments['three-d'].providers.blender.enabled, false, '保存过的开关必须被读回');
  // 未知 provider 在读取路径上丢弃而非整份配置判废（写路径才严格拒绝）。
  const unknownOnLoad = normalizeConfig({
    version: 1,
    revision: 9,
    global: { environments: { 'three-d': { enabled: true, providers: { maya: { enabled: true } } } } },
  });
  assert.equal(unknownOnLoad.global.environments['three-d'].providers.maya, undefined);
  assert.equal(unknownOnLoad.revision, 9);
});

test('global patches accept the Blender switch and reject anything the 3D catalogue does not declare', () => {
  const patch = validatePatch({
    scope: 'global',
    patch: { environments: { 'three-d': { providers: { blender: { enabled: false } } } } },
  });
  assert.deepEqual(patch.environments['three-d'], { providers: { blender: { enabled: false } } });

  assert.throws(
    () => validatePatch({
      scope: 'global',
      patch: { environments: { 'three-d': { providers: { maya: { enabled: true } } } } },
    }),
    assertCode('CONFIG_INVALID'),
  );
  // 没有 provider 轴的环境仍然拒绝 providers：开口子只开到有目录的环境。
  assert.throws(
    () => validatePatch({
      scope: 'global',
      patch: { environments: { game: { providers: { unity: { enabled: true } } } } },
    }),
    assertCode('CONFIG_INVALID'),
  );
  // `provider`（单选执行端）仍旧只属于 web。
  assert.throws(
    () => validatePatch({ scope: 'global', patch: { environments: { 'three-d': { provider: 'blender' } } } }),
    assertCode('CONFIG_INVALID'),
  );
  assert.throws(
    () => validatePatch({ scope: 'global', patch: { environments: { 'three-d': { providers: { blender: { enabled: 'yes' } } } } } }),
    assertCode('CONFIG_INVALID'),
  );
});

test('the Blender switch persists across a restart and never rewrites the environment switch', async (t) => {
  const dir = await tempDir(t);
  const store = new ConfigStore({ dir });
  store.load();

  const enabledEnv = store.write({
    expectedRevision: 0,
    scope: 'global',
    patch: { environments: { 'three-d': { enabled: true } } },
  });
  assert.equal(enabledEnv.config.global.environments['three-d'].enabled, true);
  // 打开总开关不会顺手改写 provider 的已保存值。
  assert.equal(enabledEnv.config.global.environments['three-d'].providers.blender.enabled, true);

  const disabledBlender = store.write({
    expectedRevision: 1,
    scope: 'global',
    patch: { environments: { 'three-d': { providers: { blender: { enabled: false } } } } },
  });
  assert.equal(disabledBlender.revision, 2);
  assert.equal(disabledBlender.config.global.environments['three-d'].providers.blender.enabled, false);
  assert.equal(disabledBlender.config.global.environments['three-d'].enabled, true, '分开关不影响总开关');

  const onDisk = JSON.parse(await readFile(join(dir, 'config.json'), 'utf8'));
  assert.equal(onDisk.global.environments['three-d'].providers.blender.enabled, false);

  const reloaded = new ConfigStore({ dir });
  reloaded.load();
  assert.equal(reloaded.getConfig().global.environments['three-d'].providers.blender.enabled, false);
});

test('3D is selectable as a view environment, planned ones are not, and the gate reads its two switches', async () => {
  // 只有视图的环境可以被选中（面板要能停在 3D），但仍是"可选中 ≠ 可执行"：
  // 它没有 Agent 执行适配器，工具面为空。
  assert.equal(environmentProviderSupport('three-d', 'blender'), 'preview');
  assert.equal(normalizeConfig({ global: { view: 'three-d', environments: { 'three-d': { enabled: true } } } })
    .global.view, 'three-d');
  const threeDSnap = resolveSnapshot(normalizeConfig({
    global: { view: 'three-d', environments: { 'three-d': { enabled: true } } },
  }), {});
  assert.equal(threeDSnap.environment, 'three-d');
  assert.deepEqual(threeDSnap.capabilities, [], '3D 没有 Agent 执行能力');

  // planned 环境仍然只能"启用"，不能被选为当前视图。
  assert.throws(
    () => validatePatch({ scope: 'global', patch: { view: 'android' } }),
    assertCode('CONFIG_INVALID'),
  );
  assert.throws(
    () => validatePatch({ scope: 'global', patch: { enabledEnvironments: ['web', 'android'] } }),
    assertCode('CONFIG_INVALID'),
  );
  // 空态视图不能"启用"，只能被选择。
  assert.throws(
    () => validatePatch({ scope: 'global', patch: { environments: { default: { enabled: true } } } }),
    assertCode('CONFIG_INVALID'),
  );
  assert.deepEqual(validatePatch({ scope: 'global', patch: { view: 'default' } }), { view: 'default' });

  // `/blender/frame` 的门禁就是这两处开关：环境总开关 + Blender 这个 provider 的开关。
  const hostSource = await readFile(new URL('../../index.js', import.meta.url), 'utf8');
  assert.match(hostSource, /crossEnvironment\.isViewEnabled\('three-d'\)/u, '环境总开关必须在门禁里');
  assert.match(hostSource, /crossEnvironment\.isProviderEnabled\('three-d', 'blender'\)/u, 'provider 开关必须在门禁里');
  const crossSource = await readFile(new URL('../../integration/cross-environment.js', import.meta.url), 'utf8');
  assert.match(crossSource, /isProviderEnabled: \(id, provider\) =>/u);
});

test('the settings page lets a preview card be switched, and submits the provider field the Host accepts', async () => {
  const clientSource = await readFile(new URL('../../client.js', import.meta.url), 'utf8');
  // 卡片可点判定必须包含 preview：只认 supported 会让 Blender 开关永远灰着。
  assert.match(
    clientSource,
    /const providerSwitchable = providerSupported \|\| target\.state === 'preview';/u,
    'preview 卡片必须可切换',
  );
  assert.match(clientSource, /const switchDisabled = !providerSwitchable \|\|/u);
  // 提交路径仍是 `environments.<env>.providers.<id>.enabled`（Host 已按环境目录校验）。
  assert.match(clientSource, /providers: \{ \[providerId\]: \{ enabled: next \} \}/u);
});
