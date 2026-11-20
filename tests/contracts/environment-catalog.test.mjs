/**
 * One environment vocabulary: `core/config.js` announces it, the Host serves it, the panel reads it.
 *
 * This suite is the parity gate. Before it existed the panel carried its own ten-id list while the
 * Host registered five: the panel announced `linux` (Host: `linux-desktop`) and `miniprogram`
 * (Host: `mini-program`), plus six ids the Host had never heard of. Wiring a real adapter under the
 * documented id would have left its view unreachable, and every `windows`/`macos`/`tui` card was
 * decoration. The rules pinned here:
 *
 *   1. the catalog and the `ENVIRONMENTS` vocabulary are the same set (no drift in either direction);
 *   2. `GET /config` serves the catalog without disturbing the config control plane;
 *   3. every environment id the panel hardcodes exists in the catalog — panel-side invention fails.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

import {
  ENVIRONMENTS,
  environmentCatalog,
  isPlannedEnvironment,
} from '../../core/index.js';
import { createHarness, createFakeConnectionService } from '../acceptance/harness.mjs';

const clientSource = fs.readFileSync(new URL('../../client.js', import.meta.url), 'utf8');
const catalogIds = environmentCatalog().map((row) => row.id);
const ENV_IDS = Object.values(ENVIRONMENTS);

/**
 * Keys at depth 0 of one object literal, in source order.
 *
 * A regex is not enough: `ENV_FEATURES` nests `devtools`/`displayMode` inside each environment, and
 * those are feature names, not environment ids. This walks the literal with a brace counter and
 * keeps only the segments the object itself owns.
 */
function topLevelKeys(objectBlock) {
  const segments = [];
  let depth = 0;
  let current = '';
  for (const char of objectBlock) {
    if (char === '{' || char === '[') depth += 1;
    if (char === '}' || char === ']') depth -= 1;
    if (char === ',' && depth === 0) {
      segments.push(current);
      current = '';
      continue;
    }
    current += char;
  }
  segments.push(current);
  return segments
    .map((segment) => /^\s*'?([A-Za-z][\w-]*)'?\s*:/u.exec(segment))
    .filter(Boolean)
    .map((match) => match[1]);
}

/* ------------------------------------------------------------------------------------------------
 * 1. catalog <-> vocabulary
 * ---------------------------------------------------------------------------------------------- */

test('catalog 与 ENVIRONMENTS 是同一个集合（不许多、不许少）', () => {
  assert.deepEqual([...catalogIds].sort(), [...ENV_IDS].sort(),
    'catalog 与 ENVIRONMENTS 漂移了：加环境必须同时出现在两处');
  assert.equal(new Set(catalogIds).size, catalogIds.length, 'catalog 里有重复 id');
});

test('每行都带显示名、短名与实现状态，且 planned 与 isPlannedEnvironment 一致', () => {
  for (const row of environmentCatalog()) {
    assert.ok(row.label && typeof row.label === 'string', row.id + ' 缺少 label');
    assert.ok(row.short && typeof row.short === 'string', row.id + ' 缺少 short');
    assert.ok(row.status === 'supported' || row.status === 'planned', row.id + ' 的 status 非法');
    assert.equal(row.planned, isPlannedEnvironment(row.id),
      row.id + '：catalog 的 planned 与 isPlannedEnvironment 不一致');
    assert.equal(row.planned, row.status === 'planned', row.id + '：planned 与 status 互相矛盾');
  }
  // 只有夹具环境是 testOnly；普通下拉框据此过滤。
  assert.deepEqual(environmentCatalog().filter((row) => row.testOnly).map((row) => row.id), [ENVIRONMENTS.FAKE]);
  // 已实现环境今天只有 web。
  assert.deepEqual(environmentCatalog().filter((row) => row.status === 'supported').map((row) => row.id).sort(),
    [ENVIRONMENTS.FAKE, ENVIRONMENTS.WEB].sort());
});

test('catalog 是冻结的只读数据：调用方改不动它', () => {
  const first = environmentCatalog();
  assert.ok(Object.isFrozen(first[0]), 'catalog 行必须冻结');
  assert.throws(() => { first[0].label = 'tampered'; }, TypeError);
  assert.equal(environmentCatalog()[0].label, first[0].label);
  assert.notEqual(environmentCatalog()[0], first[0], '每次调用返回新的数组，避免调用方累积修改');
});

/* ------------------------------------------------------------------------------------------------
 * 2. the Host serves it
 * ---------------------------------------------------------------------------------------------- */

test('GET /config 带 catalog，且不改动既有的配置字段', async (t) => {
  const harness = await createHarness({
    name: 'environment-catalog',
    connection: createFakeConnectionService({
      admit: () => ({ peer: { id: 'catalog-peer' } }),
      browserPeer: { id: 'catalog-peer' },
    }),
  });
  t.after(() => harness.dispose());
  const response = await harness.request({
    method: 'GET',
    path: '/plugins/ui-testing/config?view=global',
    headers: { 'x-ui-testing-scope-version': '1', 'x-ui-testing-session-id': 'catalog-agent' },
  });
  assert.equal(response.statusCode, 200, JSON.stringify(response.json).slice(0, 300));
  const body = response.json;
  assert.ok(Array.isArray(body.catalog), '响应里没有 catalog');
  assert.deepEqual(body.catalog, environmentCatalog(), 'catalog 与 core 侧不一致');
  // 只加字段：控制面必须照旧可用。
  assert.equal(typeof body.revision, 'number', 'revision 仍是权威版本号');
  assert.ok(body.config && typeof body.config === 'object', 'config 仍在');
  assert.ok(body.resolved && typeof body.resolved === 'object', 'resolved 仍在');
  assert.ok(body.readiness && typeof body.readiness === 'object', 'readiness 仍在');
});

/* ------------------------------------------------------------------------------------------------
 * 3. the panel may not invent ids
 * ---------------------------------------------------------------------------------------------- */

test('面板表（视图 / 标签 / 能力 / 默认尺寸 / 设置页分组 / 默认环境）全部落在 catalog 里', () => {
  const found = new Map();
  const record = (name, ids) => { for (const id of ids) found.set(id, name); };

  const views = /const ENV_VIEWS = \{([^}]*)\};/u.exec(clientSource);
  assert.ok(views, '缺少 ENV_VIEWS');
  record('ENV_VIEWS', topLevelKeys(views[1]));

  const tabs = /const ENV_TABS = \{([^}]*)\};/u.exec(clientSource);
  assert.ok(tabs, '缺少 ENV_TABS');
  record('ENV_TABS', topLevelKeys(tabs[1]));

  const features = /const ENV_FEATURES = \{([^\n]*)\};/u.exec(clientSource);
  assert.ok(features, '缺少 ENV_FEATURES');
  record('ENV_FEATURES', topLevelKeys(features[1]));

  const defaults = /const ENV_DEFAULTS = Object\.freeze\(\{([\s\S]*?)\n    \}\);/u.exec(clientSource);
  assert.ok(defaults, '缺少 ENV_DEFAULTS');
  record('ENV_DEFAULTS', topLevelKeys(defaults[1]));

  const groupsAt = clientSource.indexOf('const TARGET_ENV_GROUPS = [');
  assert.ok(groupsAt > 0, '缺少设置页环境分组');
  const groupsBlock = clientSource.slice(groupsAt, clientSource.indexOf('\n    ];', groupsAt));
  record('TARGET_ENV_GROUPS', [...groupsBlock.matchAll(/\n        id: '([\w-]+)', title:/gu)].map((match) => match[1]));

  const initial = /const \[env, setEnv\] = React\.useState\('([\w-]+)'\);/u.exec(clientSource);
  assert.ok(initial, '缺少默认环境状态');
  record('默认环境', [initial[1]]);

  for (const [id, where] of found) {
    assert.ok(catalogIds.includes(id), where + " 里的 '" + id + "' 不在 Host catalog 中：面板不得凭空宣告环境");
  }
  // 设置页必须覆盖所有非 testOnly 环境（少了就没有开关）。
  const groupIds = [...groupsBlock.matchAll(/\n        id: '([\w-]+)', title:/gu)].map((match) => match[1]);
  const expectedGroups = environmentCatalog().filter((row) => !row.testOnly).map((row) => row.id);
  assert.deepEqual([...groupIds].sort(), [...expectedGroups].sort(),
    '设置页环境分组必须与 catalog 的非 testOnly 集合一致');
});

test('旧词表残留为零：linux / miniprogram 不再作为环境 id 出现', () => {
  for (const [label, pattern] of [
    ['面板', clientSource],
    ['core 契约', fs.readFileSync(new URL('../../core/contracts.js', import.meta.url), 'utf8')],
  ]) {
    assert.equal(/id: 'linux'/u.test(pattern), false, label + ' 仍有旧 id linux（应为 linux-desktop）');
    assert.equal(/id: 'miniprogram'/u.test(pattern), false, label + ' 仍有旧 id miniprogram（应为 mini-program）');
  }
  assert.equal(/React\.useState\('linux'\)|React\.useState\('miniprogram'\)/u.test(clientSource), false,
    '面板默认状态仍指向旧 id');
});

test('面板确实按 catalog 派生选项：testOnly 过滤、未知状态降级为 planned、标签随行', () => {
  const memo = /const ENVIRONMENTS = React\.useMemo\(\(\) => \{([\s\S]*?)\n      \}, \[hostConfig\.state\.catalog\]\);/u.exec(clientSource);
  assert.ok(memo, '找不到按 catalog 派生的选项表');
  const derive = (hostConfig) => new Function('hostConfig', 'return (() => {' + memo[1] + '\n      });')(hostConfig)();
  const options = derive({
    state: {
      catalog: [
        { id: 'web', label: 'Web 视图', short: 'Web', status: 'supported', testOnly: false },
        { id: 'android', label: 'Android 视图', short: 'Android', status: 'planned', testOnly: false },
        // An unknown status must never be promoted to executable.
        { id: 'future', label: '未来视图', short: '未来', status: 'experimental', testOnly: false },
        // A fixture is announced but not offered to the production selector.
        { id: 'fake', label: '测试夹具环境', short: 'Fake', status: 'supported', testOnly: true },
      ],
    },
  });
  assert.deepEqual(options.map((row) => row.id), ['web', 'android', 'future'],
    'testOnly 必须被过滤，其余按目录顺序保留');
  assert.equal(options[0].ready, true, 'supported 环境可执行');
  assert.equal(options[1].ready, false, 'planned 环境不可执行');
  assert.equal(options[2].ready, false, '未知状态必须降级为不可执行，不能猜成 supported');
  assert.equal(options[1].label, 'Android 视图');
  assert.equal(options[1].short, 'Android');
  // No catalog yet (first paint / old Host): only web, never a local list.
  assert.deepEqual(derive({ state: { catalog: [] } }).map((row) => row.id), ['web']);
});

test('面板不再维护静态环境数组', () => {
  assert.equal(/const ENVIRONMENTS = \[\s*\{ id: '/u.test(clientSource), false,
    '面板又出现静态环境表：id 必须来自 GET /config 的 catalog');
});
