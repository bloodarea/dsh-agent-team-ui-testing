/**
 * 面板键盘转发：真人按键必须带修饰键、物理键位与文本一起送到页面。
 *
 * 旧实现的三处漏（用户下一个要报的就是"快捷键没传进去"）：
 *   ① `Ctrl/Cmd/Alt` 组合直接 return；② 只认 7 个键；③ 可打印字符走 kind:'text'（没有 keydown）。
 * 这里把纯函数 `panelKeyEvents` 抽出来逐条验，避免再退回。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const clientSource = fs.readFileSync(path.resolve(here, '../../client.js'), 'utf8');

const codesSource = /const PANEL_KEY_CODES = \{[\s\S]*?\n      \};/u.exec(clientSource);
assert.ok(codesSource, '缺少 PANEL_KEY_CODES');
const fnSource = /function panelKeyEvents\(event\) \{[\s\S]*?\n      \}/u.exec(clientSource);
assert.ok(fnSource, '缺少 panelKeyEvents');
const panelKeyEvents = new Function(codesSource[0] + '\n' + fnSource[0] + '\nreturn panelKeyEvents;')();

const key = (over) => Object.assign({
  key: 'a', code: 'KeyA', keyCode: 65, altKey: false, ctrlKey: false, metaKey: false, shiftKey: false, repeat: false,
}, over);

test('普通字符：keyDown + keyUp，带文本、物理 keyCode 与 code', () => {
  const [down, up] = panelKeyEvents(key({}));
  assert.equal(down.type, 'keyDown');
  assert.equal(down.key, 'a');
  assert.equal(down.text, 'a');
  assert.equal(down.unmodifiedText, 'a');
  assert.equal(down.virtualKeyCode, 65);
  assert.equal(down.code, 'KeyA');
  assert.equal(down.modifiers, 0);
  assert.equal(up.type, 'keyUp');
  assert.equal(up.text, undefined, 'keyUp 不该带文本');
});

test('快捷键：Ctrl/Cmd/Shift 组合不再被丢掉，modifiers 位掩码正确', () => {
  const ctrlZ = panelKeyEvents(key({ key: 'z', code: 'KeyZ', keyCode: 90, ctrlKey: true }));
  assert.equal(ctrlZ.length, 2, 'Ctrl+Z 必须转发（旧实现直接 return）');
  assert.equal(ctrlZ[0].modifiers, 2, 'Ctrl = bit 2');
  assert.equal(ctrlZ[0].key, 'z');

  const ctrlShiftS = panelKeyEvents(key({ key: 'S', code: 'KeyS', keyCode: 83, ctrlKey: true, shiftKey: true }));
  assert.equal(ctrlShiftS[0].modifiers, 2 | 8);
  assert.equal(ctrlShiftS[0].text, 'S', 'Shift 后的字符按实际输入字符发');

  const metaK = panelKeyEvents(key({ key: 'k', code: 'KeyK', keyCode: 75, metaKey: true }));
  assert.equal(metaK[0].modifiers, 4, 'Meta = bit 4');

  const altEnter = panelKeyEvents(key({ key: 'Enter', code: 'Enter', keyCode: 13, altKey: true }));
  assert.equal(altEnter[0].modifiers, 1, 'Alt = bit 1');
  assert.equal(altEnter[0].text, '\r');
});

test('非字符键：Home/End/PgUp/PgDn/Delete/Insert/F1-F12 都要转发', () => {
  const cases = [
    ['Home', 36], ['End', 35], ['PageUp', 33], ['PageDown', 34], ['Delete', 46], ['Insert', 45],
    ['F1', 112], ['F5', 116], ['F12', 123], ['Escape', 27], ['Tab', 9], ['ArrowDown', 40],
  ];
  for (const [name, code] of cases) {
    const events = panelKeyEvents(key({ key: name, code: name, keyCode: 0 }));
    assert.equal(events.length, 2, name + ' 必须被转发（旧实现丢掉了大部分）');
    assert.equal(events[0].virtualKeyCode, code, name + ' 的 virtualKeyCode 不对');
    assert.equal(events[0].text, undefined, name + ' 不该带文本');
  }
});

test('长按：autoRepeat 透传，且不吞掉重复事件', () => {
  const held = panelKeyEvents(key({ key: 'ArrowDown', code: 'ArrowDown', keyCode: 40, repeat: true }));
  assert.equal(held[0].autoRepeat, true);
  assert.equal(held.length, 2);
  const fresh = panelKeyEvents(key({ key: 'ArrowDown', code: 'ArrowDown', keyCode: 40 }));
  assert.equal(fresh[0].autoRepeat, undefined, '非重复键不要带 autoRepeat');
});

test('无效键不转发：Dead / Unidentified / 空按键', () => {
  assert.deepEqual(panelKeyEvents({ key: 'Dead', keyCode: 0 }), []);
  assert.deepEqual(panelKeyEvents({ key: 'Unidentified', keyCode: 0 }), []);
  assert.deepEqual(panelKeyEvents({ key: '', keyCode: 0 }), []);
  assert.deepEqual(panelKeyEvents(null), []);
});

test('帧上的 onKeyDown 已换成新转发器（旧的三处漏不许复活）', () => {
  const handler = /onKeyDown: \(event\) => \{[\s\S]*?sendEvents\(events\);[\s\S]*?\},/u.exec(clientSource);
  assert.ok(handler, '帧上找不到新的 onKeyDown');
  assert.ok(!clientSource.includes('if (event.metaKey || event.ctrlKey || event.altKey) return;'),
    '修饰键组合又被丢掉了');
  assert.ok(!clientSource.includes("sendEvents([{ kind: 'text', text: event.key }])"),
    '可打印字符又退回成不发 keydown 的 text 事件');
  assert.ok(handler[0].includes('event.isComposing'), '没处理 IME 组合');
});
