/**
 * 原生 `<select>` 的面板侧浮层：面板半边（定位纯函数 + 接线顺序）。
 *
 * 背景：`<select>` 的弹层由浏览器 UI 图层绘制，`select.matches(':open')` 为 true、元素是
 * `document.activeElement`，但帧（screencast/截图）里没有列表 —— 所以面板必须自己画面板侧浮层，
 * 并用 Host 的 `POST /select` 写回。这里锁住：
 *   ① `selectPopLayout` 的定位规则（下/上翻/夹边/左移/滚动）——纯函数，逐条验；
 *   ② 接线顺序：拦截点在 `onFramePointerUp` 里、且在 pick/标注/拖拽/空白判断之后；
 *      写回在 Host 侧先过门禁再 `runtime.run`（"拦截先于派发"）；
 *   ③ 不支持形态走"请用键盘 ↑↓ + Enter"这一行，文案与 Host 常量一致。
 *
 * 客户端是 `window.__ModuleLoader__` 打包，不能 import，所以按本仓库既有做法（见
 * panel-keyboard.test.mjs）从源码抽纯函数来跑。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { SELECT_UNSUPPORTED_HINT } from '../../select-control.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const clientSource = fs.readFileSync(path.resolve(here, '../../client.js'), 'utf8');
const hostSource = fs.readFileSync(path.resolve(here, '../../index.js'), 'utf8');

/* ------------------------------------------------------------------------------------------------
 * ① 定位纯函数
 * ---------------------------------------------------------------------------------------------- */

const geometrySource = /const SELECT_POP_GEOMETRY = \{[\s\S]*?\n    \};/u.exec(clientSource);
assert.ok(geometrySource, '缺少 SELECT_POP_GEOMETRY');
const layoutSource = /function selectPopLayout\(point, itemCount, bounds\) \{[\s\S]*?\n    \}/u.exec(clientSource);
assert.ok(layoutSource, '缺少 selectPopLayout');
// eslint-disable-next-line no-new-func
const selectPopLayout = new Function(`${geometrySource[0]}\n${layoutSource[0]}\nreturn selectPopLayout;`)();

const BOUNDS = { width: 800, height: 600 };

test('定位：默认在点击点下方展开，左边界对齐点击点（减内边距）', () => {
  const layout = selectPopLayout({ x: 120, y: 100 }, 4, BOUNDS);
  assert.equal(layout.side, 'below');
  assert.equal(layout.flippedUp, false);
  assert.equal(layout.top, 104, 'top = y + gap');
  assert.equal(layout.left, 116, 'left = x - pad');
  assert.ok(layout.width >= 160 && layout.width <= 280, '宽度在 [minWidth, maxWidth]');
  assert.equal(layout.maxHeight, 4 * layout.itemHeight + layout.pad * 2, '放得下时高度=自然高度');
  assert.equal(layout.shiftedLeft, false);
  assert.equal(layout.scrolls, false);
});

test('定位：下方放不下、上方放得下 → 上翻，且底边贴住点击点上方', () => {
  const layout = selectPopLayout({ x: 200, y: 580 }, 6, BOUNDS);
  assert.equal(layout.side, 'above');
  assert.equal(layout.flippedUp, true);
  assert.equal(layout.top, 580 - 4 - (6 * layout.itemHeight + layout.pad * 2));
  assert.ok(layout.top >= 8, '不许超出上边界');
});

test('定位：两侧都放不下 → 取较大一侧并截断高度（内部滚动）', () => {
  // 视口只有 200 高、点击在中间：上下各约 90px，装不下 12 行。
  const layout = selectPopLayout({ x: 100, y: 100 }, 12, { width: 400, height: 200 });
  assert.ok(layout.maxHeight <= Math.max(100 - 4 - 8, 200 - 100 - 4 - 8), '截断到可用空间');
  assert.ok(layout.maxHeight >= layout.itemHeight + layout.pad * 2, '至少放得下一行');
  assert.equal(layout.scrolls, true, '截断即滚动');
  assert.ok(layout.visibleItems >= 1 && layout.visibleItems < 12, '可见行数少于总行数');
  assert.ok(layout.top >= 8 && layout.top + layout.maxHeight <= 200 - 8, '整体仍在框内');
});

test('定位：右边界越界 → 左移（shiftedLeft），绝不画出框外', () => {
  const layout = selectPopLayout({ x: 780, y: 50 }, 3, BOUNDS);
  assert.equal(layout.shiftedLeft, true);
  assert.ok(layout.left + layout.width <= BOUNDS.width - 8, '右边缘留在框内');
  assert.equal(layout.left, BOUNDS.width - 8 - layout.width);
});

test('定位：超长列表按 maxVisibleItems 截断高度，不滚动时行数封顶', () => {
  const layout = selectPopLayout({ x: 20, y: 20 }, 500, BOUNDS);
  const geometry = new Function(`${geometrySource[0]}\nreturn SELECT_POP_GEOMETRY;`)();
  assert.equal(layout.maxHeight, geometry.maxVisibleItems * layout.itemHeight + layout.pad * 2);
  assert.equal(layout.scrolls, true);
});

test('定位：退化输入（0 行 / 负坐标 / 空 bounds）不抛错且在界内', () => {
  const empty = selectPopLayout({ x: 10, y: 10 }, 0, BOUNDS);
  assert.ok(empty.maxHeight >= empty.itemHeight + empty.pad * 2, '0 行也至少给一行的高度');
  assert.ok(Number.isFinite(empty.left) && Number.isFinite(empty.top));
  const negative = selectPopLayout({ x: -50, y: -50 }, 3, BOUNDS);
  assert.equal(negative.left, 8, '负坐标夹到左边距');
  assert.equal(negative.top, 8, '负坐标夹到上边距');
  const noBounds = selectPopLayout({ x: 5, y: 5 }, 3, null);
  assert.ok(Number.isFinite(noBounds.left) && Number.isFinite(noBounds.top) && noBounds.width >= 1);
});

/* ------------------------------------------------------------------------------------------------
 * ② 集成点（源码顺序断言）
 * ---------------------------------------------------------------------------------------------- */

const pointerUp = /function onFramePointerUp\(event\) \{[\s\S]*?\n      \}/u.exec(clientSource);
assert.ok(pointerUp, '缺少 onFramePointerUp');
const probe = /function selectPopProbe\(event, point\) \{[\s\S]*?\n      \}/u.exec(clientSource);
assert.ok(probe, '缺少 selectPopProbe');
const choose = /function selectPopChoose\(option\) \{[\s\S]*?\n      \}/u.exec(clientSource);
assert.ok(choose, '缺少 selectPopChoose');

test('接线：浮层探测挂在 onFramePointerUp，且在标注/选元素/拖拽/空白判断之后', () => {
  const body = pointerUp[0];
  const annot = body.indexOf('annotRef.current.on');
  const pick = body.indexOf('pickRef.current.on');
  const pan = body.indexOf('panDragRef.current');
  const release = body.indexOf('mouseReleased');
  const call = body.indexOf('selectPopProbe(click, point)');
  assert.ok(body.includes('released.then(') && body.includes('selectPopIsCurrent(probeContext)'), '只在 release 成功且上下文仍有效后探测');
  assert.ok(annot > -1 && pick > -1 && pan > -1, '既有三种拦截必须还在');
  assert.ok(body.includes('pan.active'), '平移分支的判断必须还在（pan = panDragRef.current）');
  assert.ok(call > -1, '点击后必须探测命中');
  assert.ok(call > release, '探测在 mouseReleased 派发之后（先让页面收到点击）');
  assert.ok(call > annot && call > pick && call > pan, '探测在 pick/标注/平移判断之后');
  assert.ok(body.includes('SELECT_CLICK_SLOP_PX'), '拖拽与点击必须用位移阈值区分');
  assert.ok(body.includes('point.blank') || body.includes('!point.blank'), '空白区不许弹浮层');
});

test('接线：探测用 picker 的坐标换算（q + 画布偏移）与 GET 的 element 路由', () => {
  const body = probe[0];
  assert.ok(/callHost\('element', \{ x: point\.q\.x \+ canvas\.x, y: point\.q\.y \+ canvas\.y, detail: false \}/u.test(body),
    '必须复用 picker 的换算与 detail:false 只读命中');
  assert.ok(body.includes('scopeEpochRef.current') && body.includes('selectPopSeqRef.current'),
    '必须作废过期响应（scope epoch + 序号）');
  assert.ok(body.includes('readyRef.current') && body.includes('writesPausedRef.current'),
    '不可写/未就绪时不许弹一个点不动的浮层');
});

test('接线：选中 = 先写回、再补一次 Escape、然后收起（顺序写死）', () => {
  const body = choose[0];
  const write = body.indexOf("callHost('select'");
  const escapeDown = body.indexOf("type: 'keyDown', key: 'Escape'");
  const escapeUp = body.indexOf("type: 'keyUp', key: 'Escape'");
  assert.ok(write > -1, '必须走 POST /select');
  assert.ok(body.includes("value: option.value"), '写回的必须是选项值');
  assert.ok(escapeDown > -1 && escapeUp > -1, '必须发一次 Escape（keyDown + keyUp）');
  assert.ok(body.indexOf('virtualKeyCode: 27') > -1, 'Escape 必须带 27');
  assert.ok(body.indexOf('onSelectPopKeyDown') === -1, '选中逻辑不该在键盘处理器里重入');
  assert.ok(body.includes('noteInputError'), '写回失败要有面板提示，不许静默');
});

test('渲染：浮层用 selectPopLayout 定位、类名与 aria 齐全', () => {
  assert.ok(clientSource.includes("className: 'utb-select-pop'"));
  assert.ok(clientSource.includes('selectPopLayout(selectPop.anchor'), '渲染必须用同一个定位函数');
  assert.ok(clientSource.includes("role: 'listbox'"));
  assert.ok(clientSource.includes("'data-utb-select-item'"));
  assert.ok(clientSource.includes("'aria-selected'"));
});

test('不支持形态：面板文案与 Host 常量一致，且 disabled 项不可点', () => {
  assert.ok(clientSource.includes(SELECT_UNSUPPORTED_HINT), '面板必须显示与 Host 常量一致的那一句');
  assert.ok(clientSource.includes("'data-utb-select-unsupported'"), '不支持分支要有可断言的标记');
  const item = /'data-utb-select-item': option\.disabled \? 'disabled'/u.exec(clientSource);
  assert.ok(item, 'disabled 选项必须渲染成 disabled');
  assert.ok(/onClick: \(\) => selectPopChoose\(option\)/u.test(clientSource));
});

/* ------------------------------------------------------------------------------------------------
 * ③ Host 路由：门禁顺序（拦截先于派发）
 * ---------------------------------------------------------------------------------------------- */

const selectRoute = (() => {
  const start = hostSource.indexOf("if (action === '/select') {");
  const end = hostSource.indexOf("if (action === '/eval') {");
  assert.ok(start > -1 && end > start, '找不到 /select 路由');
  return hostSource.slice(start, end);
})();

test('Host：/select 的门禁顺序与 /input 一致，且在 runtime.run 之前', () => {
  const allowed = selectRoute.indexOf('crossEnvironment.assertGuiAllowed(scopeRequest)');
  const selectCall = selectRoute.indexOf('await select()');
  const touch = selectRoute.indexOf('registry.touch(entry)');
  const lease = selectRoute.indexOf('assertGuiPageWrite(');
  const validate = selectRoute.indexOf('normalizeSelectWriteRequest(body)');
  const dispatch = selectRoute.indexOf('entry.runtime.run(');
  const mark = selectRoute.indexOf('registry.markRecent(entry)');
  assert.ok(allowed > -1, '必须过 A10 环境门');
  assert.ok(allowed < selectCall, '环境门在解析 scope 之前');
  assert.ok(selectCall < touch && touch < lease, '与 /input 相同的 select → touch → 租约顺序');
  assert.ok(lease < validate, '租约/权限门在参数校验之前（拒绝零派发）');
  assert.ok(validate < dispatch, '参数校验在派发之前');
  assert.ok(dispatch < mark, 'markRecent 在成功后');
});

test('Host：/select 的拒绝分支直接返回，不进队列', () => {
  const refused = selectRoute.slice(selectRoute.indexOf('if (!request.ok)'), selectRoute.indexOf('const applied ='));
  assert.ok(refused.includes('sendJson(res, scopeHttpStatus(request.code)'), '拒绝要回结构化错误');
  assert.ok(refused.includes('return;'));
  assert.ok(!refused.includes('runtime.run('), '拒绝分支里不许有派发');
});

test('Host：/element 只在命中 select 时追加字段，非 select 形状不变', () => {
  const start = hostSource.indexOf('async function pickElementAt(');
  const end = hostSource.indexOf('/** Register the runtime, its HTTP surface, and the agent tools. */');
  const pick = hostSource.slice(start, end);
  assert.ok(/if \(tag === 'select'\) \{/u.test(pick), '必须是 select 分支');
  assert.ok(/if \(select\) element\.select = \{/u.test(pick), '投影读不到时不许长出字段');
  assert.ok(pick.includes('includeUserAgentShadowDOM: false'), '命中 authored select，不能停在 UA shadow 的内部 div');
  assert.ok(pick.includes('target: { backendNodeId: node.backendNodeId, loaderId }'), '选项写回绑定同一节点与文档');
  const branch = pick.slice(pick.indexOf("if (tag === 'select') {"));
  const assignments = [...branch.matchAll(/element\.([a-zA-Z]+)\s*=/gu)].map((match) => match[1]);
  assert.deepEqual(assignments, ['select'], 'select 分支只许给 element.select 赋值');
});

test('Host：/element 与投影读取保持纯读（不 ensure / 不进队列 / 不写 lastError）', () => {
  const start = hostSource.indexOf('async function pickElementAt(');
  const end = hostSource.indexOf('/** Register the runtime, its HTTP surface, and the agent tools. */');
  const pick = hostSource.slice(start, end);
  for (const forbidden of ['runtime.ensure(', 'runtime.run(', 'setError(', 'touchAgent(', 'claim(']) {
    assert.ok(!pick.includes(forbidden), `pickElementAt/selectProjectionAt 不许出现 ${forbidden}`);
  }
  const routeStart = hostSource.indexOf("if (action === '/element') {");
  const routeEnd = hostSource.indexOf("const body = await readJson(req);", routeStart);
  const route = hostSource.slice(routeStart, routeEnd);
  assert.ok(route.includes('pickElementAt('), '/element 必须走只读 pick');
  assert.ok(!route.includes('selected = entry'), '/element 不许把 runtime 设成共享错误投影的目标');
  assert.ok(!route.includes('runtime.run(') && !route.includes('.ensure('), '/element 不许进队列/启动页面');
});
