import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { contextItems, contextProbeExpression, openPageContextMenu, applyPageContextAction } from '../../context-menu.js';

const source = fs.readFileSync(new URL('../../client.js', import.meta.url), 'utf8');
test('预览阻断宿主菜单，范围只在 stage', () => {
  assert.match(source, /function onFrameContextMenu\(event\) \{\s*event.preventDefault\(\);\s*event.stopPropagation\(\);/u);
  assert.equal((source.match(/onContextMenu: onFrameContextMenu/gu) || []).length, 1);
  assert.match(source, /className: 'utb-stage', ref: stage, onContextMenu: onFrameContextMenu/u);
});
test('菜单走独立串行事务，物理抬起不会重复派发', () => {
  assert.match(source, /callHost\('context-menu'/u);
  assert.match(source, /if \(event.button === 2\) return; \/\/ Host already paired/u);
  assert.match(source, /pageContextCurrent\(context\)/u);
  assert.match(source, /onKeyDown: onPageContextKeyDown/u);
  assert.match(source, /const responseDocument = state &&/u);
  assert.match(source, /acceptRemote\(state\)/u);
  assert.match(source, /document: responseDocument/u);
});
test('观测真实 Event 最终取消状态，包括传播被中断', () => {
  let listener;
  const context = vm.createContext({ window: { addEventListener: (_type, fn) => { listener = fn; }, removeEventListener() {} }, setTimeout: () => 1, clearTimeout() {} });
  vm.runInContext(contextProbeExpression('test'), context);
  const event = { isTrusted: true, button: 2, eventPhase: 0, defaultPrevented: false, composedPath: () => [] };
  listener(event);
  event.defaultPrevented = true; // downstream handler, after capture listener returned
  assert.equal(vm.runInContext(contextProbeExpression('test', true), context).status, 'handled');
  assert.equal(context.test, undefined);
});
test('缺事件时结果未知，不把未观测冒充未取消', () => {
  const context = vm.createContext({ window: { addEventListener() {}, removeEventListener() {} }, setTimeout: () => 1, clearTimeout() {} });
  vm.runInContext(contextProbeExpression('test'), context);
  assert.equal(vm.runInContext(contextProbeExpression('test', true), context), null);
});
test('菜单只允许安全地址，文本有上限且历史禁用准确', () => {
  const items = contextItems({ text: 'x'.repeat(70000), link: 'javascript:alert(1)', image: 'https://u:p@example.com/' }, { currentIndex: 0, entries: [{}] }, 'https://example.com/');
  assert.equal(items[0].disabled, true);
  assert.equal(items[1].disabled, true);
  assert.equal(items.find(item => item.id === 'copy').text.length, 65536);
  assert.ok(!items.some(item => ['copy-link', 'copy-image'].includes(item.id)));
});
test('非法右键参数在启动前拒绝', async () => {
  let started = false;
  await assert.rejects(openPageContextMenu({ ensure() { started = true; } }, { x: NaN, y: 1 }), error => error.code === 'INVALID_ARGUMENT');
  assert.equal(started, false);
});
test('过期和跨 runtime 菜单令牌在动作前拒绝', async () => {
  await assert.rejects(applyPageContextAction({}, { token: 'foreign', action: 'reload' }), error => error.details.reason === 'stale-target');
  const runtime = { panelContextMenu: { token: 'old', at: 0 } };
  await assert.rejects(applyPageContextAction(runtime, { token: 'old', action: 'reload' }), error => error.code === 'INVALID_ARGUMENT');
});
test('文档变化时零导航；有效令牌仅可消费一次', async () => {
  let calls = 0;
  const runtime = { panelContextMenu: { token: 'x', at: Date.now(), mainLoaderId: 'a', frameId: 'f', loaderId: 'a', items: [{ id: 'reload' }] },
    send: async () => ({ frameTree: { frame: { id: 'f', loaderId: 'b' } } }), reload: async () => { calls++; } };
  await assert.rejects(applyPageContextAction(runtime, { token: 'x', action: 'reload' }));
  assert.equal(calls, 0);
  runtime.send = async () => ({ frameTree: { frame: { id: 'f', loaderId: 'a' } } });
  await applyPageContextAction(runtime, { token: 'x', action: 'reload' });
  assert.equal(calls, 1);
  await assert.rejects(applyPageContextAction(runtime, { token: 'x', action: 'reload' }));
});
