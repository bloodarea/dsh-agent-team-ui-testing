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

test('目标环境清单来自 Host catalog，面板不再维护静态表', () => {
  // 面板自带的静态环境表曾与 Host 的注册表漂移（面板宣告 linux，Host 注册 linux-desktop；
  // 面板还宣告了六个 Host 压根没登记的环境）。id 与显示名只能来自 GET /config 的 catalog。
  assert.equal(/const ENVIRONMENTS = \[\s*\{ id: '/u.test(clientSource), false,
    '面板又出现静态环境数组：id 必须来自 Host catalog');
  const block = /const ENVIRONMENTS = React\.useMemo\(\(\) => \{([\s\S]*?)\}, \[hostConfig\.state\.catalog\]\);/u.exec(clientSource);
  assert.ok(block, '缺少按 catalog 派生的 ENVIRONMENTS');
  assert.ok(block[1].includes('hostConfig.state.catalog'), '没有读主机目录');
  assert.ok(block[1].includes('item.testOnly !== true'), 'testOnly 环境不能进普通下拉框');
  assert.ok(block[1].includes("ready: item.status === 'supported'"),
    'ready 必须由 Host 的实现状态决定，面板不得自行判断');
  assert.ok(block[1].includes('item.label') && block[1].includes('item.short'),
    '标签与短名也要来自目录，否则又是一份本地词表');
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
  // 正文分发走视图接点（`viewRegistry.renderOr`）：有视图用视图，缺席落到 shellNoViewRows。
  assert.ok(clientSource.includes('const envViewRows = viewRegistry.renderOr(env, shellNoViewRows);'),
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

test('无头/有头切换与 DevTools 由环境能力表决定，外壳不写环境 id', () => {
  assert.ok(clientSource.includes('const ENV_FEATURES = { web: { devtools: true, displayMode: true } };'),
    '缺少环境能力表');
  assert.ok(clientSource.includes("envHasFeature(env, 'displayMode') && envViewSupported && h('div', {"),
    '运行模式切换没有跟随环境能力');
  assert.ok(clientSource.includes("if (!envHasFeature(env, 'devtools') || !running || devtools.available !== true) {"),
    'DevTools 门禁没有跟随环境能力');
  // 外壳里不得再有环境 id 比较：新增环境时不应改外壳。
  assert.equal(/env === 'web'|env !== 'web'|tabsEnvRef\.current !== 'web'/u.test(clientSource), false,
    '外壳里还残留环境 id 比较');
});

test('组合框只列开关已打开的目标环境（没开的根本不出现）', () => {
  // 选项 = 开关为 true 的环境过滤后的结果，不是全体 10 个
  assert.ok(clientSource.includes('const fromConfig = enabledFromConfig(hostConfig.state.config, option.id);'),
    '组合框没有读每个环境的总开关');
  assert.ok(clientSource.includes('.filter((option) => option.enabled), [ENVIRONMENTS, hostConfig.state.config, allowedEnvironments]);'),
    '组合框没有把未启用的环境过滤掉');
  assert.ok(!clientSource.includes("option.label + '（未启用）'"),
    '还在用「（未启用）」占位，而不是直接不列出来');
  // 当前选中项被关掉时要有兜底，不能出现空值
  assert.ok(clientSource.includes('当前选中的环境被关掉时（用户在设置页关开关），退回宿主当前执行环境'),
    '缺少"选中项被禁用"的兜底');
  // 没有视图但已启用：切视图、显示空态，不写宿主配置
  // The branch is a pure view switch (no Host config write); it also rotates the panel instance
  // generation so in-flight writes of the previous view are dropped.
  assert.ok(/if \(typeof ENV_VIEWS\[next\] !== 'function'\) \{[\s\S]{0,400}setEnv\(next\);/.test(clientSource),
    'changeEnv 没有把“没有视图”走成纯视图切换');
  assert.equal(/selectHostEnvironment\(next[\s\S]{0,120}\}\s*\n/.test(clientSource.slice(
    clientSource.indexOf("if (typeof ENV_VIEWS[next] !== 'function') {"),
    clientSource.indexOf("if (!option.ready) return;"))), false,
  '无视图分支不得提交宿主配置');
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

/* ------------------------------------------------------------------------------------------------
 * 空白画布的宿主隔离：切入无视图环境后，面板不再对仍在运行的目标做任何宿主写入
 * （plan §3 拆开前端生命周期 的完成条件：零视口写入、零截图请求、零标注同步）
 * ---------------------------------------------------------------------------------------------- */

test('视图表提前声明，外壳用单一判断回答"这个环境有没有视图"', () => {
  const tableAt = clientSource.indexOf('const ENV_VIEWS = { web: webViewBody };');
  const helperAt = clientSource.indexOf('const hasEnvironmentView = (id) =>');
  // 通道的挂载点在使用视图表判断之后（工厂本身可以在别处定义，它不读视图表）。
  const transportAt = clientSource.indexOf('viewChannelRef.current.mount()');
  assert.ok(tableAt > 0 && helperAt > tableAt, '缺少视图表或其判断函数');
  assert.ok(helperAt < transportAt, '视图表必须先于使用它的传输/轮询接线声明');
  assert.ok(/const envHasView = hasEnvironmentView\(env\);/u.test(clientSource));
  assert.ok(/envHasViewRef\.current = envHasView;/u.test(clientSource), '回调里读的是当前渲染的环境');
});

test('视口写入只有一个闸口，且无视图环境直接丢弃补丁', () => {
  const flush = /async function flushViewPatch\(\) \{[\s\S]*?\n      \}/u.exec(clientSource);
  assert.ok(flush, '缺少 flushViewPatch');
  const guard = flush[0].indexOf('if (!envHasViewRef.current) return;');
  const publish = flush[0].indexOf("callHost('viewport'");
  assert.ok(guard > 0, 'flushViewPatch 没有无视图环境的闸');
  assert.ok(publish === -1 || guard < publish, '闸必须在真正发请求之前');
  // 两条写入路径都必须属于 Web 视图本身：合并补丁（flushViewPatch，已加闸）与旧宿主导航的
  // 兼容写入（只在 `sharedView` 缺失时、且只由 Web 视图的地址栏提交触发）。
  const direct = [...clientSource.matchAll(/callHost\('viewport'/gu)];
  assert.ok(direct.length <= 2, '出现了新的 /viewport 写入路径');
  const legacyNav = clientSource.indexOf("if (sharedView) return null;");
  assert.ok(legacyNav > 0 && clientSource.slice(legacyNav, legacyNav + 200).includes("callHost('viewport'"),
    '第二条写入只应是旧宿主导航兼容路径');
});

test('切换环境的默认尺寸：无视图环境只改本地布局', () => {
  const fn = /function applyEnvDefaultSize\(next\) \{[\s\S]*?\n      \}/u.exec(clientSource);
  assert.ok(fn, '缺少 applyEnvDefaultSize');
  assert.ok(/if \(hasEnvironmentView\(next\)\) queueViewPatch\(/u.test(fn[0]),
    '默认尺寸必须按"该环境有没有视图"决定是否发布');
});

test('帧传输与状态轮询由视图通道统一持有，并按视图是否实现来挂载', () => {
  // 通道工厂：帧传输 + 状态轮询 + 种子截图都在里面，`mount()/unmount()` 是唯一生命周期入口。
  const factory = /function createWebViewChannel\(deps = \{\}\) \{[\s\S]*?\n    \}/u.exec(clientSource);
  assert.ok(factory, '缺少 createWebViewChannel');
  assert.ok(factory[0].includes('createFrameTransport('), '通道没有创建帧传输');
  assert.ok(factory[0].includes("getHost('/state'"), '通道没有状态轮询');
  assert.ok(factory[0].includes('function unmount()'), '通道缺少卸载');
  assert.ok(factory[0].includes('transport.close()'), '卸载必须关闭传输');
  assert.ok(factory[0].includes('controller.abort()'), '卸载必须中断在途轮询');
  // 外壳只做一件事：有视图就 mount，没有就不 mount，且视图变化会卸载旧通道。
  assert.ok(clientSource.includes('return viewChannelRef.current.mount();'), '外壳没有通过通道挂载');
  assert.ok(clientSource.includes('if (!visible || !ready || !envHasView) return undefined;'),
    '外壳没有按视图挂载通道');
  assert.ok(clientSource.includes('[scopeEpoch, ready, visible, envHasView]'),
    '视图变化必须能卸载旧通道（依赖里要有 envHasView）');
});

test('空白画布只画本地内容：不取页面截图、不发布视口', () => {
  const stage = /function shellBlankStage\(\) \{[\s\S]*?\n      \}/u.exec(clientSource);
  assert.ok(stage, '缺少 shellBlankStage');
  assert.equal(/callHost\('screenshot'/u.test(stage[0]), false, '空白画布不得请求页面截图');
  assert.equal(/queueViewPatch\(/u.test(stage[0]), false, '空白画布不得发布视口');
  assert.equal(/callHost\('annotations'/u.test(stage[0]), false, '空白画布不得同步标注');
});

/* ------------------------------------------------------------------------------------------------
 * 面板实例代次：迟到的帧/状态/写入回包不得覆盖新视图（plan §3 完成条件后半段）
 * ---------------------------------------------------------------------------------------------- */

test('面板实例代次在换视图时递增：换环境（有/无视图）与换作用域都算新实例', () => {
  assert.ok(clientSource.includes('const panelGenerationRef = React.useRef(0);'), '缺少面板实例代次');
  assert.ok(clientSource.includes('const bumpPanelGeneration = () => { panelGenerationRef.current += 1; };'));
  const changeEnv = /function changeEnv\(next\) \{[\s\S]*?\n      \}/u.exec(clientSource);
  assert.ok(changeEnv, '缺少 changeEnv');
  const bumps = [...changeEnv[0].matchAll(/bumpPanelGeneration\(\)/gu)].length;
  assert.ok(bumps >= 2, '两条切换分支（无视图 / 宿主确认）都必须递增代次');
  const scopeBlock = clientSource.slice(clientSource.indexOf('if (scopeTokenRef.current !== scopeKey) {'),
    clientSource.indexOf('const scopeEpoch = scopeEpochRef.current;'));
  assert.ok(scopeBlock.includes('bumpPanelGeneration()'), '作用域/绑定切换也要递增代次');
  assert.ok(clientSource.indexOf('const bumpPanelGeneration') < clientSource.indexOf('if (scopeTokenRef.current !== scopeKey) {'),
    '代次递增函数必须先于作用域切换块声明');
});

test('迟到的视口写入回包被丢弃', () => {
  const flush = /async function flushViewPatch\(\) \{[\s\S]*?\n      \}/u.exec(clientSource);
  assert.ok(flush, '缺少 flushViewPatch');
  const capture = flush[0].indexOf('const panelGeneration = panelGenerationRef.current;');
  const request = flush[0].indexOf("callHost('viewport'");
  const guard = flush[0].indexOf('if (panelGeneration !== panelGenerationRef.current) return;');
  const adopt = flush[0].indexOf('adoptView(payload.view');
  assert.ok(capture > 0 && request > capture, '请求前必须捕获实例代次');
  assert.ok(guard > request, '回包回来后必须先核对代次');
  assert.ok(adopt === -1 || guard < adopt, '核对必须在采纳视图之前');
});

/* ------------------------------------------------------------------------------------------------
 * 视图接点（plan §4 验证扩展边界）：测试夹具只需添加自身注册项和实现
 * ---------------------------------------------------------------------------------------------- */

const viewRegistryFactory = (() => {
  const fn = /function createViewRegistry\(views\) \{[\s\S]*?\n    \}/u.exec(clientSource);
  assert.ok(fn, '缺少 createViewRegistry');
  return new Function(fn[0] + '\nreturn createViewRegistry;')();
})();

test('视图注册表：按环境 id 选择，缺席即空白，外壳不改', () => {
  const calls = [];
  const registry = viewRegistryFactory({
    web: () => { calls.push('web'); return 'web-rows'; },
    // 一个不含任何浏览器语义的最小视图：只证明"夹具只需加自己的一项"。
    fixture: () => { calls.push('fixture'); return 'fixture-rows'; },
  });
  assert.deepEqual(registry.ids().sort(), ['fixture', 'web']);
  assert.equal(registry.has('web'), true);
  assert.equal(registry.has('android'), false);
  assert.equal(registry.render('web'), 'web-rows');
  assert.equal(registry.render('android'), null, '没有实现的视图不得借用别人的正文');
  assert.equal(registry.renderOr('android', () => 'blank-canvas'), 'blank-canvas');
  assert.equal(registry.renderOr('fixture', () => 'blank-canvas'), 'fixture-rows');
  assert.deepEqual(calls, ['web', 'fixture']);
  // 空表/非法输入不得崩：外壳只看到"没有视图"。
  assert.equal(viewRegistryFactory().has('web'), false);
  assert.equal(viewRegistryFactory(null).render('web'), null);
  assert.equal(viewRegistryFactory({ web: 'not-a-function' }).has('web'), false);
});

test('外壳渲染走注册表，不再直接调视图函数', () => {
  assert.ok(clientSource.includes('const envViewRows = viewRegistry.renderOr(env, shellNoViewRows);'),
    '根渲染没有经过视图接点');
  assert.equal(/ENV_VIEWS\[env\]\(\)/u.test(clientSource), false, '仍存在绕过接点直接调用视图的地方');
  assert.ok(clientSource.includes('const envViewSupported = hasEnvironmentView(env);'),
    '视图能力判断也要走同一个接点');
});

test('切页也是新面板实例：标签切换改的是作用域绑定，因而会轮换代次', () => {
  // A tab switch selects another view: child views bind by runtimeId, so the scope key (and with it
  // the scope epoch + panel generation) rotates and the old transport is torn down.
  const switchFn = /function switchView\(viewId\) \{[\s\S]*?\n      \}/u.exec(clientSource);
  assert.ok(switchFn, '缺少 switchView');
  assert.ok(switchFn[0].includes('setActiveViewId(viewId)'), '切页只改 activeViewId 是不够的');
  assert.ok(/const childBinding = activeView && activeView\.kind === 'popup' \? String\(activeView\.runtimeId \|\| ''\) : '';/u.test(clientSource),
    '子视图必须按 runtimeId 绑定');
  assert.ok(clientSource.includes("const scopeKey = scope.kind + ':' + scope.sessionId + '|' + scope.binding + (scope.legacy ? '|legacy' : '');"),
    '作用域键必须包含绑定（换页即换绑定）');
  const scopeBlock = clientSource.slice(clientSource.indexOf('if (scopeTokenRef.current !== scopeKey) {'),
    clientSource.indexOf('const scopeEpoch = scopeEpochRef.current;'));
  assert.ok(scopeBlock.includes('scopeEpochRef.current += 1;'), '作用域键变化必须轮换目标代次');
  assert.ok(scopeBlock.includes('bumpPanelGeneration()'), '作用域键变化必须轮换面板实例代次');
});

test('按视图挂载的 effect 把 envHasView 放进依赖（否则闭包不会随视图退出）', () => {
  // 真实 GUI 复跑（tests/acceptance/viewport-gui.mjs 的 V1b）曾抓到：状态轮询的闸写对了，但
  // 依赖数组里没有 envHasView，切到空白画布后闭包仍是上一环境的那份，轮询继续打旧目标。
  // 现在帧流与轮询都由同一个通道对象持有，因此只有一处挂载点，它必须带 envHasView 依赖。
  const guards = [...clientSource.matchAll(/if \(!visible \|\| !ready \|\| !envHasView\) return undefined;/gu)];
  assert.ok(guards.length >= 1, '通道挂载点缺少视图闸');
  const deps = [...clientSource.matchAll(/\}, \[scopeEpoch, ready, visible, envHasView\]\);/gu)];
  assert.ok(deps.length >= 1, '通道挂载点的依赖里必须有 envHasView');
  assert.equal(/React\.useEffect\(\(\) => \{\n        const scopeNow = scopeRef\.current;\n        const controller = new AbortController\(\);\n        let cancelled = false;\n        let timer = 0;\n        async function tick\(\)/u.test(clientSource), false,
    '外壳里不应再有自己的 /state 轮询循环（应走通道）');
  // 绑定发现轮询的闸也要一致（它同样只属于有页面的视图）。
  assert.ok(clientSource.includes('if (!visible || !envHasView || identity.kind !== \'recent\' || binding || legacyHost) return undefined;'),
    '最近绑定轮询也要按视图挂载');
});

test('离开视图要松开按住的键：通道卸载时先发 keyUp 再断开传输', () => {
  const factory = /function createWebViewChannel\(deps = \{\}\) \{[\s\S]*?\n    \}/u.exec(clientSource);
  assert.ok(factory, '缺少 createWebViewChannel');
  const release = factory[0].indexOf('onBeforeUnmount()');
  const close = factory[0].indexOf('transport.close()');
  assert.ok(release > 0, '通道卸载没有释放按住键');
  assert.ok(close > release, 'keyUp 必须在传输关闭之前发出（否则页面永远认为键还按着）');
  assert.ok(clientSource.includes('onBeforeUnmount: () => { try { releasePanelKeys(); } catch { /* ignore */ } }'),
    '外壳必须把 releasePanelKeys 交给通道');
});
