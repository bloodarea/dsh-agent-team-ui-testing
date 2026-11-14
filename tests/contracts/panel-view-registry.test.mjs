/**
 * 调试视图按目标环境分配：外壳（标题 + 组合框）与视图分离，未实现的环境走占位。
 *
 * 目的：把"组合框选谁 → 下面就渲染谁的视图"这条链路钉死，避免以后又退回"外壳与
 * Web 视图写死在一起"。纯源码断言，不启动浏览器。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const clientSource = fs.readFileSync(path.resolve(here, '../../client.js'), 'utf8');

/** 取一个 `const NAME = ` template literal 的正文。 */
function cssBlock(name) {
  const start = clientSource.indexOf('    const ' + name + ' = `');
  assert.ok(start >= 0, '缺少样式表 ' + name);
  const end = clientSource.indexOf('\n`;', start);
  return clientSource.slice(start, end);
}

const TARGET_ENVS = ['web', 'windows', 'android', 'linux', 'macos', 'tui', 'harmonyos', 'game', 'three-d', 'miniprogram'];

test('目标环境清单是 10 个，且每个都有短名（标题用）', () => {
  const block = clientSource.slice(
    clientSource.indexOf('    const ENVIRONMENTS = ['),
    clientSource.indexOf('    ];', clientSource.indexOf('    const ENVIRONMENTS = [')),
  );
  const ids = [...block.matchAll(/\{ id: '([a-z0-9-]+)'/gu)].map((m) => m[1]);
  assert.deepEqual(ids, TARGET_ENVS, '目标环境清单变了，视图注册表要同步');
  for (const id of TARGET_ENVS) {
    assert.ok(new RegExp("\\{ id: '" + id + "', label: '[^']+', short: '[^']+', ready: (true|false) \\}").test(block),
      id + ' 缺少 short 短名（标题按它派生）');
  }
});

test('视图注册表按环境查表，只有 web 有实现', () => {
  const registry = /const ENV_VIEWS = \{([^}]*)\};/u.exec(clientSource);
  assert.ok(registry, '缺少 ENV_VIEWS 注册表');
  const keys = [...registry[1].matchAll(/([a-z0-9-]+):\s*[A-Za-z]/gu)].map((m) => m[1]);
  assert.deepEqual(keys, ['web'], '当前只应实现 web 视图；新增环境时同步这条断言');
  assert.ok(clientSource.includes('function webViewBody()'),
    'Web 视图应当是一个可注册的函数，而不是写死在树里');
});

test('正文由注册表分发，缺席时渲染公共空白画布与工具栏', () => {
  // 旧断言仍要求 noEnvView，占位已在既有公共画布修改中由 shellNoViewRows 替代。
  assert.ok(clientSource.includes('const envViewRows = envViewSupported ? ENV_VIEWS[env]() : shellNoViewRows();'),
    '正文没有按注册表区分环境视图与公共空白画布');
  const fallback = /function shellNoViewRows\(\) \{([\s\S]*?)\n      \}/u.exec(clientSource);
  assert.ok(fallback, '缺少公共无视图回退');
  for (const name of ['shellBarPublic', 'shellAnnotBar', 'shellSizeBar', 'shellBlankStage']) {
    assert.ok(fallback[1].includes(name + '()'), '公共回退缺少 ' + name);
  }
  assert.ok(clientSource.includes('envViewRows[0],\n                  shellTabsBar(envTabs, tabsVisible),\n                  ...envViewRows.slice(1),'),
    '根壳没有保持工具栏、公共标签栏、环境正文的行顺序');
  assert.ok(clientSource.includes('视图层暂不支持'), '占位缺少主文案');
  assert.ok(clientSource.includes('适配器未接入'), '占位缺少原因说明');
  assert.ok(clientSource.includes("className: 'utb-noview'"), '占位缺少容器类名');
  // 占位要有图标，不只是一句话
  assert.ok(/className: 'utb-noview-icon'[\s\S]{0,200}<svg|h\('svg',[\s\S]{0,40}viewBox: '0 0 24 24'/u.test(clientSource),
    '占位缺少问号图标');
});

test('标题由环境派生，不再硬编码 Web', () => {
  assert.ok(!clientSource.includes("'Web · 调试视图'"), '标题仍是硬编码的 Web 文案');
  assert.ok(clientSource.includes("const envViewTitle = (envOption.short || envOption.label || env) + ' · 调试视图';"),
    '标题没有从环境选项派生');
});

test('根节点暴露视图身份，便于测试与后续样式分支', () => {
  assert.ok(clientSource.includes("'data-utb-view': env,"), '根节点缺少 data-utb-view');
  assert.ok(clientSource.includes("'data-utb-view-supported': envViewSupported ? 'true' : 'false',"),
    '根节点缺少 data-utb-view-supported');
});

test('占位样式必须在面板自己的样式表里（放错表就不会生效）', () => {
  assert.ok(cssBlock('CSS').includes('.utb-noview'), '占位样式不在面板 CSS 里');
  assert.ok(!cssBlock('TARGET_ENV_CSS').includes('.utb-noview'),
    '占位样式被写进了设置页样式表（面板不会加载它）');
});

test('无头/有头切换属于 Web 视图：仅在 web 且视图存在时出现', () => {
  assert.ok(clientSource.includes("env === 'web' && envViewSupported && h('div', {"),
    '运行模式切换没有跟随 Web 视图');
});

test('组合框只列开关已打开的目标环境（没开的根本不出现）', () => {
  // 选项 = 开关为 true 的环境过滤后的结果，不是全体 10 个
  assert.ok(clientSource.includes('const fromConfig = enabledFromConfig(hostConfig.state.config, option.id);'),
    '组合框没有读每个环境的总开关');
  assert.ok(clientSource.includes('.filter((option) => option.enabled), [hostConfig.state.config, allowedEnvironments]);'),
    '组合框没有把未启用的环境过滤掉');
  assert.ok(!clientSource.includes("option.label + '（未启用）'"),
    '还在用「（未启用）」占位，而不是直接不列出来');
  // 当前选中项被关掉时要有兜底，不能出现空值
  assert.ok(clientSource.includes('当前选中的环境被关掉时（用户在设置页关开关），退回宿主当前执行环境'),
    '缺少"选中项被禁用"的兜底');
  // 没有视图但已启用：切视图、显示空态，不写宿主配置
  assert.ok(/if \(typeof ENV_VIEWS\[next\] !== 'function'\) \{[\s\S]{0,160}setEnv\(next\);/.test(clientSource),
    'changeEnv 没有把“没有视图”走成纯视图切换');
  assert.ok(clientSource.includes("执行环境仍然是 ' + hostEnvLabel + '，这里只切换视图。"),
    '空态没有说明执行环境没有变化');
});

test('设置页总开关直接提交宿主（Host 允许启用 planned 环境）', () => {
  const fn = /function toggleEnvironment\(group, next\) \{[\s\S]*?\n      \}/u.exec(clientSource);
  assert.ok(fn, '找不到 toggleEnvironment');
  assert.ok(!fn[0].includes('groupSupported'), '开关仍被本地拦截，启用不了 planned 环境');
  assert.ok(fn[0].includes('putHostConfig('), '开关没有提交给宿主');
});

test('宿主英文原因走中文对照，不直接上屏', () => {
  const fn = /function configErrorText\(message\) \{[\s\S]*?\n    \}/u.exec(clientSource);
  assert.ok(fn, '缺少 configErrorText');
  const map = new Function('return (' + fn[0] + ')')();
  assert.equal(map('environment android is planned and cannot be selected in v1'),
    'v1 还不支持启用 android：该环境仍是规划中');
  assert.equal(map('environment fake is test-only'), 'fake 仅供测试使用');
  assert.equal(map('unknown environment: ios'), '没有这个目标环境：ios');
  assert.equal(map('unknown provider: safari'), '没有这个运行环境：safari');
  assert.equal(map('some unmapped reason'), 'some unmapped reason', '未识别的必须原样保留，不猜');
  // 四处调用点都要经过它
  const callSites = [...clientSource.matchAll(/configErrorText\(/gu)].length;
  assert.ok(callSites >= 5, '调用点太少，可能还有地方直接拼宿主原文');
});
