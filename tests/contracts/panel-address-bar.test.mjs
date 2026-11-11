/**
 * 地址栏历史与「转到」按钮：栈语义、持久化与面板接线。
 *
 * 历史的纯函数直接从 client.js 抽出来执行（不是抄一份），因此这里断言的就是面板真正跑的代码；
 * 「下拉在哪、按钮在哪、点击后走哪条路径」这类 DOM 结构用源码断言钉住，真实点击行为由
 * tests/acceptance/panel-address-gui.mjs 在真实面板里验证。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const clientSource = fs.readFileSync(path.resolve(here, '../../client.js'), 'utf8');

const block = (() => {
  const start = clientSource.indexOf('    const ADDRESS_HISTORY_LIMIT');
  const end = clientSource.indexOf('    /**\n     * Human-foreground claims');
  assert.ok(start >= 0 && end > start, '缺少地址栏历史辅助函数');
  return clientSource.slice(start, end);
})();

/** 受控 localStorage：`throwOnWrite` 模拟隐私模式写入失败。 */
function memoryStorage({ throwOnWrite = false } = {}) {
  const map = new Map();
  return {
    map,
    getItem: (key) => (map.has(key) ? map.get(key) : null),
    setItem: (key, value) => {
      if (throwOnWrite) throw new Error('QuotaExceededError');
      map.set(key, String(value));
    },
  };
}

function load(storage) {
  const context = { URL, window: storage === undefined ? undefined : { localStorage: storage } };
  return new Function('window', 'URL', block + '\nreturn { addressHistoryNormalize, addressHistoryPush, addressHistoryLabel, addressHistoryRead, addressHistoryWrite, ADDRESS_HISTORY_LIMIT, ADDRESS_HISTORY_KEY };')(context.window, URL);
}

test('最近访问是栈：新地址进栈顶，最多 7 条', () => {
  const api = load(memoryStorage());
  assert.equal(api.ADDRESS_HISTORY_LIMIT, 7);
  let list = [];
  for (let index = 0; index < 9; index += 1) list = api.addressHistoryPush(list, 'http://127.0.0.1:8130/p' + index);
  assert.equal(list.length, 7);
  assert.equal(list[0], 'http://127.0.0.1:8130/p8', '最新的在栈顶');
  assert.equal(list[6], 'http://127.0.0.1:8130/p2', '最旧的两条被挤出');
});

test('重复访问移到栈顶而不是产生第二条', () => {
  const api = load(memoryStorage());
  let list = api.addressHistoryPush([], 'http://a.test/one');
  list = api.addressHistoryPush(list, 'http://a.test/two');
  list = api.addressHistoryPush(list, 'http://a.test/one');
  assert.deepEqual(list, ['http://a.test/one', 'http://a.test/two']);
});

test('非 HTTP(S) 地址不进历史：空值、about:blank、应用自身地址、脏数据', () => {
  const api = load(memoryStorage());
  const seed = ['http://a.test/one'];
  for (const value of ['', '   ', 'about:blank', 'chrome://settings', 'javascript:void(0)', null, undefined, 42]) {
    assert.deepEqual(api.addressHistoryPush(seed, value), seed, String(value) + ' 不该进历史');
  }
  assert.deepEqual(api.addressHistoryNormalize(['', 'http://a.test/one', 'http://a.test/one', 'about:blank', 7]),
    ['http://a.test/one']);
});

test('写入/读取往返一致，损坏的 JSON 与不可用存储都退化为空列表', () => {
  const storage = memoryStorage();
  const api = load(storage);
  assert.equal(api.addressHistoryWrite(storage, ['http://a.test/one', 'http://a.test/two']), true);
  assert.deepEqual(api.addressHistoryRead(storage), ['http://a.test/one', 'http://a.test/two']);

  storage.map.set(api.ADDRESS_HISTORY_KEY, '{not json');
  assert.deepEqual(api.addressHistoryRead(storage), [], '损坏内容不能让地址栏报错');

  assert.deepEqual(api.addressHistoryRead(null), [], '没有 localStorage 时为空');
  assert.equal(api.addressHistoryWrite(null, ['http://a.test/one']), false);
  const broken = load(memoryStorage({ throwOnWrite: true }));
  assert.equal(broken.addressHistoryWrite(memoryStorage({ throwOnWrite: true }), ['http://a.test/one']), false,
    '隐私模式写入失败只返回 false，不抛到 UI');
});

test('下拉里显示的是 host + 路径，根路径只显示 host', () => {
  const api = load(memoryStorage());
  assert.equal(api.addressHistoryLabel('http://127.0.0.1:8130/tests/manual-target/game-target.html'),
    '127.0.0.1:8130/tests/manual-target/game-target.html');
  assert.equal(api.addressHistoryLabel('https://example.com/'), 'example.com');
  assert.equal(api.addressHistoryLabel('https://example.com/a?b=1'), 'example.com/a?b=1');
  assert.equal(api.addressHistoryLabel('not a url'), 'not a url');
});

test('下拉挂在地址栏内部右侧，条目点击走导航，转在标签页按钮左侧', () => {
  const wrap = clientSource.indexOf("className: 'utb-addr-wrap'");
  const toggle = clientSource.indexOf("'data-utb-history-toggle'");
  const list = clientSource.indexOf("'data-utb-history-list'");
  const go = clientSource.indexOf("button('转到'");
  const tabsToggle = clientSource.indexOf("button('标签页'");
  const annot = clientSource.indexOf("button('标注'");
  assert.ok(wrap > 0 && toggle > wrap && list > toggle, '历史按钮必须位于地址栏包裹层内');
  assert.ok(go > list && go < tabsToggle, '「转到」必须在标签页按钮左侧（= 地址栏与标签页之间）');
  assert.ok(tabsToggle < annot, '标签页按钮仍在标注左侧');
  assert.ok(clientSource.includes("'aria-haspopup': 'menu'"), '历史按钮要声明是弹出菜单');
  assert.ok(clientSource.includes('onClick: () => setHistoryOpen((value) => !value)'), '点击地址栏按钮展开/收起下拉');
  assert.ok(clientSource.includes('onClick: () => chooseHistory(url)'), '条目点击选中该地址');
  assert.ok(/function chooseHistory\(url\) \{[\s\S]{0,200}submit\(undefined, url\);/u.test(clientSource),
    '选中历史必须直接导航该地址，不依赖 draft 状态回填');
});

test('「转到」走与回车完全相同的提交路径', () => {
  assert.ok(/function submit\(event, overrideAddress\) \{/u.test(clientSource), 'submit 要支持指定地址');
  assert.ok(clientSource.includes("const source = typeof overrideAddress === 'string' ? overrideAddress : draft;"),
    '没有指定地址时必须回落到地址栏草稿（= 回车语义）');
  assert.ok(clientSource.includes("button('转到', h(IconGo, null), () => submit(undefined), annotOn || busy"),
    '「转到」必须调用同一个 submit，且标注模式/导航中禁用');
  assert.ok(clientSource.includes("'data-utb-go'"), '「转到」要暴露验收钩子');
});

test('历史来自已接受的地址：失败导航不记录，重定向记录最终页', () => {
  assert.ok(/const historyAddress = acceptedAddress\(\);/u.test(clientSource), '记录源必须是已接受地址');
  assert.ok(/React\.useEffect\(\(\) => \{\n        if \(!\/\^https\?:/.test(clientSource), '记录发生在已接受地址变化的副作用里');
  assert.ok(/if \(!event\.target\.closest \|\| !event\.target\.closest\('\.utb-addr-wrap'\)\) setHistoryOpen\(false\)/u.test(clientSource),
    '点击外部要收起下拉');
  assert.ok(clientSource.indexOf("'data-utb-history-list'") > clientSource.indexOf("className: 'utb-addr-wrap'")
    && clientSource.indexOf("'data-utb-history-list'") < clientSource.indexOf("button('转到'"),
  '下拉必须挂在地址栏包裹层内部（否则点击条目会先被“点击外部”收起）');
  assert.ok(clientSource.includes('setHistoryOpen(false); }, [scopeEpoch, annotOn])'),
    '切换作用域或进入标注模式要收起下拉');
});
