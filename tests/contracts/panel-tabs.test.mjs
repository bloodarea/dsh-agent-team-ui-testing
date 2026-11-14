/** Public tabs renderer/provider boundary. Executes the actual client helpers without a service. */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const source = fs.readFileSync(new URL('../../client.js', import.meta.url), 'utf8');
function functionSource(name) {
  const start = source.indexOf('      function ' + name + '(');
  assert.ok(start >= 0, 'missing ' + name);
  const end = source.indexOf('\n      }', start);
  assert.ok(end > start, 'missing function boundary for ' + name);
  return source.slice(start, end + '\n      }'.length);
}
function load(name, dependencies = {}) {
  return new Function(...Object.keys(dependencies), 'return (' + functionSource(name) + ');')(...Object.values(dependencies));
}
const h = (type, props, ...children) => ({ type, props: props || {}, children: children.flat(Infinity).filter((item) => item !== null && item !== undefined && item !== false) });
function nodes(node, predicate) {
  if (!node || typeof node !== 'object') return [];
  return [...(predicate(node) ? [node] : []), ...node.children.flatMap((child) => nodes(child, predicate))];
}
const by = (node, attribute) => nodes(node, (item) => attribute in item.props);
function model(overrides = {}) {
  return {
    label: '目标标签', items: [{ id: 'one', label: '目标一', title: '目标详情', closeLabel: '关闭目标一', closeTitle: '关闭此目标', closeKind: 'target' }],
    activeId: 'one', canCreate: true, creating: false, createLabel: '新增目标', createTitle: '新建目标',
    onSelect() {}, onClose() {}, onCreate() {}, ...overrides,
  };
}
const render = load('shellTabsBar', { h });

test('公共标签栏只消费模型，无 Web 状态、身份或 Host 路由依赖', () => {
  const renderer = functionSource('shellTabsBar');
  for (const forbidden of ['stableViews', 'readyViewList', 'runtimeId', 'hostLabel', 'switchView', 'closeView', 'newTab', 'callHost', '浏览器', 'popup', 'primary']) {
    assert.ok(!renderer.includes(forbidden), 'shell must not depend on ' + forbidden);
  }
  assert.ok(!functionSource('webViewBody').includes("className: 'utb-tabs'"), 'Web body must not own strip rendering');
  assert.ok(source.includes('const ENV_TABS = { web: webTabsProvider };'));
  assert.ok(source.includes("const envTabs = typeof tabsProvider === 'function' ? tabsProvider() : null;"));
  assert.ok(source.includes('shellTabsBar(envTabs, tabsVisible),'));
});

test('显隐是独立偏好：单标签占行，隐藏无条目也无加号，空组仍可新建', () => {
  assert.equal(render(null, true), null);
  assert.equal(render(model(), false), null);
  const single = render(model(), true);
  assert.equal(single.props.role, 'tablist');
  assert.equal(single.props['aria-label'], '目标标签');
  assert.equal(by(single, 'data-utb-tab').length, 1);
  assert.equal(by(single, 'data-utb-tab-new').length, 1);
  const empty = render(model({ items: [], activeId: '' }), true);
  assert.equal(by(empty, 'data-utb-tab').length, 0);
  assert.equal(by(empty, 'data-utb-tab-new').length, 1);
  assert.equal(by(render(model({ canCreate: false }), true), 'data-utb-tab-new').length, 0);
});

test('选择、关闭与新建回调使用中立 id，关闭阻止选择冒泡', () => {
  const events = [];
  const tree = render(model({ onSelect: (id) => events.push(['select', id]), onClose: (id) => events.push(['close', id]), onCreate: () => events.push(['create']) }), true);
  const tab = by(tree, 'data-utb-tab')[0];
  assert.equal(tab.props['aria-selected'], true);
  assert.equal(tab.props.tabIndex, 0);
  assert.equal(tab.props.title, '目标详情');
  tab.props.onClick();
  const close = by(tree, 'data-utb-tab-close')[0];
  assert.equal(close.props['aria-label'], '关闭目标一');
  assert.equal(close.props['data-utb-tab-close-kind'], 'target');
  close.props.onClick({ stopPropagation: () => events.push(['stop']) });
  by(tree, 'data-utb-tab-new')[0].props.onClick();
  assert.deepEqual(events, [['select', 'one'], ['stop'], ['close', 'one'], ['create']]);
  assert.equal(by(render(model({ creating: true }), true), 'data-utb-tab-new')[0].props.disabled, true);
  assert.equal(by(render(model({ onCreate: undefined }), true), 'data-utb-tab-new')[0].props.disabled, true);
  assert.equal(by(render(model({ onClose: undefined }), true), 'data-utb-tab-close').length, 0);
});

function webProvider(dependencies = {}) {
  const views = [
    { id: 'primary', kind: 'primary', title: 'Home\u0000', runtimeId: 'runtime-main' },
    { id: 'child', kind: 'popup', title: '', hostLabel: 'example.test', runtimeId: 'runtime-child' },
  ];
  return load('webTabsProvider', {
    stableViews: { views }, readyViewList: views, activeView: views[1], tabOpening: false,
    switchView() {}, closeView() {}, newTab() {}, ...dependencies,
  });
}

test('Web provider 拥有标题清洗、主子标签关闭语义和新建中状态', () => {
  assert.equal(webProvider({ stableViews: null })(), null);
  const provider = webProvider({ tabOpening: true });
  const state = provider();
  assert.equal(state.label, '浏览器标签页');
  assert.equal(state.activeId, 'child');
  assert.equal(state.creating, true);
  assert.deepEqual(state.items.map((item) => item.label), ['Home', 'example.test']);
  assert.deepEqual(state.items.map((item) => item.closeKind), ['primary', 'popup']);
  assert.equal(state.items[0].closeLabel, '重置标签 Home');
  assert.equal(state.items[0].closeTitle, '关闭标签（回到空态）');
  assert.equal(state.items[1].closeLabel, '关闭标签 example.test');
  assert.equal(state.createTitle, '新建空白标签页');
  assert.ok(!JSON.stringify(state.items).includes('runtime-'), 'renderer model must not expose Web binding');
  assert.equal(webProvider({ readyViewList: [{ id: 'long', title: 'a'.repeat(100) }], activeView: null })().items[0].label.length, 80);
});

test('无 provider 的环境不继承 Web 缓存，公共标签开关禁用且无处理器', () => {
  const registryStart = source.indexOf('      const ENV_TABS =');
  const registryEnd = source.indexOf('\n\n      /** Web adapter:', registryStart);
  const resolve = new Function('env', 'tabsVisible', 'webTabsProvider', source.slice(registryStart, registryEnd) + '\nreturn {envTabs, tabsSupported, showTabs};');
  for (const env of ['linux', 'windows', 'macos', 'android', 'tui', 'harmonyos', 'miniprogram', 'game', 'three-d']) {
    const state = resolve(env, true, () => { throw new Error('non-Web must not invoke Web provider'); });
    assert.deepEqual(state, { envTabs: null, tabsSupported: false, showTabs: false });
    const toolbar = load('shellBarPublic', {
      h, button: (label, children, onClick, disabled, extra) => h('button', { 'aria-label': label, onClick, disabled, ...extra }, children),
      tabsSupported: state.tabsSupported, tabsVisible: true, setTabsVisible() { throw new Error('unsupported toggle'); },
      IconAnnot: 'annot', IconSize: 'size', IconMore: 'more', toggleAnnotMode() {}, annotReady: true, sizing: false, pickOn: false,
      annotOn: false, annotPanelId: 'annot', toggleSizing() {}, menu: false, setMenu() {},
    })();
    const toggle = by(toolbar, 'data-utb-tabs-toggle')[0];
    assert.equal(toggle.props.disabled, true);
    assert.equal(toggle.props.onClick, undefined);
    assert.equal(toggle.props['aria-pressed'], false);
    assert.equal(toggle.props['data-utb-tabs-toggle'], 'unsupported');
    assert.equal(render(state.envTabs, true), null);
  }
});

test('切离 Web 后，旧标签行所有回调在任何 Web 状态读取或请求之前退出', () => {
  const tabsEnvRef = { current: 'web' };
  // Other dependencies intentionally absent: touching Web state after the switch fails this test.
  const callbacks = {
    switchView: load('switchView', { tabsEnvRef }), newTab: load('newTab', { tabsEnvRef }), closeView: load('closeView', { tabsEnvRef }),
  };
  const state = webProvider(callbacks)();
  const staleTree = render(state, true);
  tabsEnvRef.current = 'linux';
  assert.doesNotThrow(() => by(staleTree, 'data-utb-tab')[0].props.onClick());
  assert.doesNotThrow(() => by(staleTree, 'data-utb-tab-close')[0].props.onClick({ stopPropagation() {} }));
  assert.doesNotThrow(() => by(staleTree, 'data-utb-tab-new')[0].props.onClick());
});

test('Web GUI 切页保持本地活动页与 runtime 绑定，GUI 操作不改 Agent selection', () => {
  const switcher = functionSource('switchView');
  assert.ok(switcher.includes('setActiveViewId(viewId)'));
  assert.ok(!switcher.includes('callHost('), 'GUI switch must not dispatch Agent tab selection');
  assert.ok(source.includes("const childBinding = activeView && activeView.kind === 'popup' ? String(activeView.runtimeId || '') : '';"));
  assert.ok(source.includes("const activeBinding = childBinding || binding;"));
  assert.ok(source.includes("view.createdBy === 'gui' && !seenViewIdsRef.current.has(view.id)"));
  assert.ok(functionSource('newTab').includes("callHost('tabs', { action: 'open' }, { scope: scopeRef.current })"));
  assert.ok(functionSource('closeView').includes("scopeSnapshot('recent', '', view.runtimeId, false)"));
  assert.ok(source.includes("'data-utb-active-view': envTabs ? envTabs.activeId : '',"));
  assert.ok(source.includes("'data-utb-ready-views': envTabs ? String(envTabs.items.length) : '0',"));
});
