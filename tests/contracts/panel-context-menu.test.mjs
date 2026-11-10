/**
 * 预览区右键：宿主菜单阻断 + 右键作为页面输入派发。
 *
 * 背景：DSH Web 的右键菜单挂在容器上（`useContextMenu` 的 trigger props → React
 * `onContextMenu`），预览是它的子树，所以右键会弹宿主菜单。预览区必须自己吃掉 contextmenu
 * （不弹宿主菜单、不继续冒泡），同时把右键 press/release 转给页面，页面自绘菜单才会出现在帧里。
 * 原生默认菜单由浏览器 UI 图层绘制，不在帧里，也不由本仓库投影（见 docs）。
 *
 * 客户端是 `window.__ModuleLoader__` 打包，不能 import，所以按仓库既有做法从源码抽片段断言。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const clientSource = fs.readFileSync(path.resolve(here, '../../client.js'), 'utf8');

const contextMenu = /function onFrameContextMenu\(event\) \{[\s\S]*?\n      \}/u.exec(clientSource);
assert.ok(contextMenu, '缺少 onFrameContextMenu');
const pointerDown = /function onFramePointerDown\(event\) \{[\s\S]*?\n      \}/u.exec(clientSource);
assert.ok(pointerDown, '缺少 onFramePointerDown');
const pointerUp = /function onFramePointerUp\(event\) \{[\s\S]*?\n      \}/u.exec(clientSource);
assert.ok(pointerUp, '缺少 onFramePointerUp');

test('预览区吞掉宿主右键菜单：preventDefault + stopPropagation', () => {
  const body = contextMenu[0];
  assert.ok(body.includes('event.preventDefault()'), '必须阻止默认动作');
  assert.ok(body.includes('event.stopPropagation()'), '必须阻止冒泡到宿主容器');
});

test('阻断挂在预览区（.utb-stage），不是整个面板', () => {
  assert.ok(/h\('div', \{ className: 'utb-stage', ref: stage, onContextMenu: onFrameContextMenu \}/u.test(clientSource),
    'onContextMenu 必须挂在 .utb-stage 上（预览内阻断、预览外保留宿主行为）');
  const stageCount = (clientSource.match(/onContextMenu: onFrameContextMenu/gu) || []).length;
  assert.equal(stageCount, 1, '阻断点只应有一个（避免出现未覆盖的重复挂载）');
});

test('右键按下在左键分支之前处理，并派发 button=right / buttons=2', () => {
  const body = pointerDown[0];
  const right = body.indexOf('event.button === 2');
  // 选元素分支里也有一个 `button !== 0` 守卫，所以左键守卫要从右键分支之后再找。
  const leftGuard = body.indexOf('if (event.button !== 0) return;', right);
  const panBranch = body.indexOf('if (panMode) {', right);
  assert.ok(right > -1, '必须处理右键');
  assert.ok(leftGuard > right, '右键分支必须在左键守卫之前');
  assert.ok(right < panBranch, '右键分支必须在 panMode 之前（平移模式也要按页面语义给右键）');
  const branch = body.slice(right, leftGuard);
  assert.ok(branch.includes("button: 'right'"), '右键必须派发 button=right');
  assert.ok(branch.includes('buttons: 2'), '右键按下必须带 buttons=2');
  assert.ok(branch.includes("type: 'mousePressed'"), '右键按下必须派发 mousePressed');
  assert.ok(branch.includes('rightClickRef.current'), '必须记录按下位置用于补齐 release');
  assert.ok(/\n\s*return;\s*\n\s*\}\s*$/u.test(branch), '右键分支必须以 return 结束，不能落进左键拖拽/选择探测');
});

test('右键抬起补 release（buttons=0），且不进浮层探测与拖拽提交', () => {
  const body = pointerUp[0];
  const right = body.indexOf('event.button === 2');
  const dragCheck = body.indexOf('const drag = dragRef.current;');
  const probe = body.indexOf('selectPopProbe(');
  assert.ok(right > -1 && dragCheck > right, '右键分支必须在拖拽逻辑之前');
  const branch = body.slice(right, dragCheck);
  assert.ok(branch.includes("type: 'mouseReleased'") && branch.includes("button: 'right'") && branch.includes('buttons: 0'),
    '右键抬起必须派发 mouseReleased（right / buttons=0）');
  assert.ok(branch.includes('annotRef.current.on') && branch.includes('pickRef.current.on'),
    '标注/选元素模式内仍应零页面输入');
  assert.ok(!branch.includes('selectPopProbe('), '右键不许触发下拉浮层探测');
  assert.ok(probe > dragCheck, '浮层探测必须留在左键路径里');
  assert.ok(body.includes("rightClickRef.current = { x: 0, y: 0, pointerId: -1, valid: false }"),
    '抬起后必须清空右键状态');
});

test('右键状态是独立的 ref，且没有按下的右键不派发', () => {
  assert.ok(clientSource.includes('const rightClickRef = React.useRef('), '必须独立的 rightClickRef');
  assert.ok(pointerUp[0].includes('if (!right.valid || right.pointerId !== event.pointerId) return;'),
    '没有按下记录的右键抬起不派发');
});
