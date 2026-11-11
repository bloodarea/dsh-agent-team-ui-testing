#!/usr/bin/env node
/**
 * Real Chromium: `browser_input`'s input state machine, relative motion, and the page-cursor probe.
 *
 * What this suite proves (each item is measured on a real page, not inferred from the schema):
 *   - a held modifier is synthesized into every later key/mouse event (`e.shiftKey`), so "hold
 *     Shift then press a" behaves like a real keyboard even though the caller never repeats
 *     `modifiers`; `synthesizeModifiers:false` reproduces the old "no synthesis" behaviour;
 *   - multi-key hold works (`a` + `d` + `Shift` are all down at once), `keyUp` clears one entry, and
 *     a navigation clears the whole table (a stale Shift must not keep marking events forever);
 *   - `deltaX/deltaY` move a virtual cursor and the page sees both the new absolute position and a
 *     matching `movementX/movementY`, without the caller knowing any absolute coordinate;
 *   - the virtual cursor clamps to the viewport instead of drifting outside it;
 *   - `POST /element {cursorOnly:true}` reports the hit element's computed `cursor` (pointer/text)
 *     and answers `default` on empty page background, which is what the panel mirrors onto the
 *     preview. A few source-level assertions pin the client wiring (probe call, keyword whitelist,
 *     cursor style fallback) because the DOM of the DSH GUI shell is not driven from here.
 */
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createHarness, createFakeConnectionService } from './harness.mjs';

const runDir = join(import.meta.dirname, 'runs', `input-state-${new Date().toISOString().replace(/[:.]/g, '-')}-${process.pid}`);
await mkdir(runDir, { recursive: true });
const checks = [];
const check = (label, condition, actual = null, expected = null) => {
  assert.ok(condition, `${label}${actual === null ? '' : ' :: ' + JSON.stringify(actual)}`);
  checks.push(label);
  console.log('PASS', checks.length, label);
};

const server = http.createServer((req, res) => {
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.end(`<!doctype html><meta charset="utf-8"><title>input state lab</title>
<style>
  body { margin:0; font:14px system-ui; background:#fff; }
  #pad { height:600px; }
  #btn { position:absolute; left:40px; top:40px; width:120px; height:40px; cursor:pointer; }
  #txt { position:absolute; left:40px; top:120px; width:160px; height:40px; cursor:text; border:1px solid #ccc; }
  #grab { position:absolute; left:40px; top:200px; width:120px; height:40px; cursor:grab; }
</style>
<div id="pad"></div><button id="btn">button</button><div id="txt">text</div><div id="grab">grab</div>
<script>
  window.__events = [];
  window.__held = new Set();
  const push = (row) => { window.__events.push(row); if (window.__events.length > 400) window.__events.shift(); };
  for (const type of ['keydown', 'keyup']) {
    window.addEventListener(type, (e) => {
      if (type === 'keydown') window.__held.add(e.code || e.key); else window.__held.delete(e.code || e.key);
      push({ kind: type, key: e.key, code: e.code, shift: e.shiftKey, ctrl: e.ctrlKey, alt: e.altKey, meta: e.metaKey, repeat: e.repeat });
    });
  }
  window.addEventListener('mousedown', (e) => push({ kind: 'mousedown', x: e.clientX, y: e.clientY, shift: e.shiftKey, ctrl: e.ctrlKey }));
  window.addEventListener('mousemove', (e) => push({ kind: 'mousemove', x: e.clientX, y: e.clientY, mx: e.movementX, my: e.movementY, shift: e.shiftKey }));
</script>`);
});
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));

const owner = () => createFakeConnectionService({
  rejection: undefined, admit: () => ({ peer: { id: 'input-state-peer' } }), browserPeer: { id: 'input-state-peer' },
});
const harness = await createHarness({ name: 'input-state', connection: owner() });
const exec = { agent: { id: 'input-state', session: { header: { cwd: harness.workspaceDir } } } };
const call = async (name, args = {}) => {
  const result = await harness.invoke(name, args, exec);
  if (result.threw) throw new Error(`${name}: ${result.error.code} ${result.error.message}`);
  return result.value;
};
const events = () => call('browser_eval', { expression: 'window.__events' }).then((value) => value.value);
const lastOf = (kind) => events().then((list) => [...list].reverse().find((row) => row.kind === kind) || null);
const resetLog = () => call('browser_eval', { expression: 'window.__events.length = 0; true' });
const cursorAt = (x, y) => call('browser_eval', {
  expression: `(() => { const el = document.elementFromPoint(${x}, ${y}); return el ? getComputedStyle(el).cursor : null; })()`,
}).then((value) => value.value);

try {
  const url = `http://127.0.0.1:${server.address().port}/`;
  await call('browser_navigate', { url });
  await call('browser_viewport', { action: 'set', width: 640, height: 480, x: 0, y: 0 });
  check('实验页就绪（640×480、按钮/文本/抓取三种 cursor）',
    (await cursorAt(80, 60)) === 'pointer' && (await cursorAt(80, 140)) === 'text' && (await cursorAt(80, 220)) === 'grab',
    { btn: await cursorAt(80, 60), txt: await cursorAt(80, 140), grab: await cursorAt(80, 220) }, 'pointer/text/grab');

  /* ------------------------------------------------- 1. multi-key hold + modifier synthesis */
  await resetLog();
  const press1 = await call('browser_input', {
    events: [
      { kind: 'key', type: 'keyDown', key: 'a', code: 'KeyA', virtualKeyCode: 65 },
      { kind: 'key', type: 'keyDown', key: 'd', code: 'KeyD', virtualKeyCode: 68 },
      { kind: 'key', type: 'keyDown', key: 'Shift', code: 'ShiftLeft', virtualKeyCode: 16 },
    ],
  });
  check('连发三个 keyDown 后 held 同时含 a/d/shiftleft（多键组合成立）',
    JSON.stringify(press1.held.slice().sort()) === JSON.stringify(['keya', 'keyd', 'shiftleft']) && press1.modifiers === 8,
    press1, ['keya', 'keyd', 'shiftleft']);

  const press2 = await call('browser_input', { events: [{ kind: 'key', type: 'keyDown', key: 'a', code: 'KeyA', virtualKeyCode: 65 }] });
  const aWithShift = await lastOf('keydown');
  check('按住 Shift 后发 keyDown a（调用方没写 modifiers）→ 页面 e.shiftKey=true（自动合成）',
    aWithShift && aWithShift.code === 'KeyA' && aWithShift.shift === true,
    aWithShift, { code: 'KeyA', shift: true });
  check('结果回带 held/modifiers，调用方可核对残留按键',
    Array.isArray(press2.held) && press2.held.includes('shiftleft') && press2.modifiers === 8, press2, { modifiers: 8 });

  const press3 = await call('browser_input', {
    events: [{ kind: 'key', type: 'keyDown', key: 'a', code: 'KeyA', virtualKeyCode: 65, synthesizeModifiers: false }],
  });
  const aNoShift = await lastOf('keydown');
  check('synthesizeModifiers:false 复现"按住但不带修饰位"（e.shiftKey=false）',
    aNoShift && aNoShift.shift === false, aNoShift, { shift: false });
  check('该次调用没有改动 held（关合成不影响状态表）', press3.held.includes('shiftleft'), press3.held, 'shiftleft');

  /* ------------------------------------------------- 2. mouse carries held modifiers */
  await resetLog();
  await call('browser_input', { events: [{ kind: 'mouse', type: 'mousePressed', x: 80, y: 60, button: 'left', clickCount: 1 }] });
  await call('browser_input', { events: [{ kind: 'mouse', type: 'mouseReleased', x: 80, y: 60, button: 'left', clickCount: 1 }] });
  const down = await lastOf('mousedown');
  check('Shift 按住时的鼠标按下带 shiftKey=true（修饰键对鼠标同样生效）',
    down && down.shift === true, down, { shift: true });

  /* ------------------------------------------------- 3. keyUp clears one entry */
  const upShift = await call('browser_input', { events: [{ kind: 'key', type: 'keyUp', key: 'Shift', code: 'ShiftLeft', virtualKeyCode: 16 }] });
  check('keyUp Shift 后 held 不再含 shiftleft、modifiers 归零',
    upShift.held.includes('keya') && !upShift.held.includes('shiftleft') && upShift.modifiers === 0, upShift, { modifiers: 0 });
  await call('browser_input', { events: [{ kind: 'key', type: 'keyDown', key: 'b', code: 'KeyB', virtualKeyCode: 66 }] });
  const bAfter = await lastOf('keydown');
  check('松开 Shift 后新按键不再带 shiftKey（状态确实被清掉）', bAfter && bAfter.shift === false, bAfter, { shift: false });

  const releaseAll = await call('browser_input', {
    events: [
      { kind: 'key', type: 'keyUp', key: 'a', code: 'KeyA', virtualKeyCode: 65 },
      { kind: 'key', type: 'keyUp', key: 'd', code: 'KeyD', virtualKeyCode: 68 },
      { kind: 'key', type: 'keyUp', key: 'b', code: 'KeyB', virtualKeyCode: 66 },
    ],
  });
  check('全部 keyUp 后 held 为空', Array.isArray(releaseAll.held) && releaseAll.held.length === 0, releaseAll.held, []);

  /* ------------------------------------------------- 4. relative motion */
  await resetLog();
  const absolute = await call('browser_input', { events: [{ kind: 'mouse', type: 'mouseMoved', x: 150, y: 120 }] });
  check('绝对移动把虚拟光标记到 (150,120)',
    absolute.cursor && absolute.cursor.x === 150 && absolute.cursor.y === 120, absolute.cursor, { x: 150, y: 120 });
  const relative = await call('browser_input', { events: [{ kind: 'mouse', type: 'mouseMoved', deltaX: 40, deltaY: -30 }] });
  const moved = await lastOf('mousemove');
  check('deltaX/deltaY 相对移动：光标到 (190,90)，页面 clientX/clientY 同步',
    relative.cursor && relative.cursor.x === 190 && relative.cursor.y === 90
      && moved && Math.abs(moved.x - 190) <= 1 && Math.abs(moved.y - 90) <= 1,
    { cursor: relative.cursor, page: moved && { x: moved.x, y: moved.y } }, { cursor: { x: 190, y: 90 } });
  check('页面收到的 movementX/movementY 与 delta 一致（±2px）',
    moved && Math.abs(moved.mx - 40) <= 2 && Math.abs(moved.my + 30) <= 2,
    moved && { mx: moved.mx, my: moved.my }, { mx: 40, my: -30 });
  const clamped = await call('browser_input', { events: [{ kind: 'mouse', type: 'mouseMoved', deltaX: 5000, deltaY: 5000 }] });
  check('相对移动被 clamp 在视口内（640-1 / 480-1），不会漂出画面',
    clamped.cursor && clamped.cursor.x === 639 && clamped.cursor.y === 479, clamped.cursor, { x: 639, y: 479 });

  /* ------------------------------------------------- 5. navigation clears the table */
  await call('browser_input', { events: [{ kind: 'key', type: 'keyDown', key: 'Shift', code: 'ShiftLeft', virtualKeyCode: 16 }] });
  await call('browser_navigate', { url });
  const afterNav = await call('browser_input', { events: [{ kind: 'key', type: 'keyDown', key: 'c', code: 'KeyC', virtualKeyCode: 67 }] });
  const cAfterNav = await lastOf('keydown');
  check('导航后 held 被清空，新按键不带 shiftKey（旧文档的按键不会留到新文档）',
    afterNav.held.length === 1 && afterNav.held[0] === 'keyc' && afterNav.modifiers === 0
      && cAfterNav && cAfterNav.shift === false,
    { held: afterNav.held, shift: cAfterNav && cAfterNav.shift }, { held: ['keyc'] });
  await call('browser_input', { events: [{ kind: 'key', type: 'keyUp', key: 'c', code: 'KeyC', virtualKeyCode: 67 }] });

  /* ------------------------------------------------- 6. cursor probe (POST /element) */
  harness.setConnection(owner());
  const cursorProbe = async (body) => {
    const previous = harness.getConnection();
    harness.setConnection(owner());
    try {
      return await harness.request({
        method: 'POST', path: '/plugins/ui-testing/element',
        headers: { 'x-ui-testing-scope-version': '1', 'x-ui-testing-session-id': exec.agent.id },
        body,
      });
    } finally { harness.setConnection(previous); }
  };
  const onButton = await cursorProbe({ x: 80, y: 60, cursorOnly: true });
  check('cursorOnly 命中按钮 → cursor=pointer（面板据此显示手型）',
    onButton.json.ok === true && onButton.json.element && onButton.json.element.cursor === 'pointer',
    onButton.json, { cursor: 'pointer' });
  const onText = await cursorProbe({ x: 80, y: 140, cursorOnly: true });
  check('cursorOnly 命中文本块 → cursor=text', onText.json.element && onText.json.element.cursor === 'text', onText.json, { cursor: 'text' });
  const onBlank = await cursorProbe({ x: 500, y: 400, cursorOnly: true });
  // The page decides the keyword: a plain block reports `auto`, `<html>/<body>` (the Host's
  // empty-background branch) reports `default`. Both mean "ordinary arrow" to the panel.
  check('cursorOnly 打在普通背景 → cursor=auto/default（箭头，不是 no-hit、不是手型）',
    onBlank.json.ok === true && onBlank.json.element
      && ['auto', 'default'].includes(onBlank.json.element.cursor),
    onBlank.json, { cursor: 'auto|default' });
  const detail = await cursorProbe({ x: 80, y: 60, detail: true });
  check('detail:true 的命中同时带 cursor（选择元素浮层也能显示手型）',
    detail.json.element && detail.json.element.cursor === 'pointer' && detail.json.element.tag === 'button',
    detail.json.element && { cursor: detail.json.element.cursor, tag: detail.json.element.tag }, { cursor: 'pointer', tag: 'button' });
  check('cursorOnly 是纯读：页面没有新增标签页、没有 recent 之外的副作用',
    harness.ctx.__internal.plugin.registry.pageCount === 1,
    { pageCount: harness.ctx.__internal.plugin.registry.pageCount }, 1);

  /* ------------------------------------------------- 7. client wiring (source-level) */
  const clientSource = await readFile(new URL('../../client.js', import.meta.url), 'utf8');
  check('client.js：预览指针按节流询问 cursorOnly，并把结果写回 frameCursor',
    /probeFrameCursor\(/u.test(clientSource) && /cursorOnly: true/u.test(clientSource)
      && /setFrameCursor\(pageCursorKeyword\(/u.test(clientSource),
    'probe wiring', 'cursorOnly + setFrameCursor');
  check('client.js：cursor 关键字走白名单（url(...) 之类不会落样式），指针离开预览复位',
    /PAGE_CURSOR_KEYWORDS\.has\(value\) \? value : 'auto'/u.test(clientSource)
      && /setFrameCursor\('auto'\)/u.test(clientSource),
    'whitelist + reset', 'whitelist');

  const report = {
    suite: 'input-state',
    startedAt: new Date().toISOString(),
    checks: checks.length,
    criteria: `${checks.length}/${checks.length}`,
    failedChecks: 0,
    notRunChecks: [
      'Pointer Lock：真正 requestPointerLock 后 movementX 由浏览器合成（本套件只验证未锁定时的 movementX 与虚拟光标）',
      '真实面板预览里的指针形状（需要私有隔离 DSH 才能驱动 DSH GUI 的鼠标）',
    ],
    evidence: { runDir },
  };
  await writeFile(join(runDir, 'report.json'), JSON.stringify(report, null, 2));
  console.log(`\ninput state machine: ${checks.length}/${checks.length} PASS`);
} catch (error) {
  const report = {
    suite: 'input-state', startedAt: new Date().toISOString(), checks: checks.length,
    passed: checks.length, failed: 1, criteria: `${checks.length}/${checks.length + 1}`,
    error: { message: String((error && error.message) || error), stack: String((error && error.stack) || '') },
  };
  await writeFile(join(runDir, 'report.json'), JSON.stringify(report, null, 2));
  console.error('\nFAILED after', checks.length, 'checks:', (error && error.message) || error);
  process.exitCode = 1;
} finally {
  try { await harness.dispose?.(); } catch { /* best effort */ }
  await new Promise((resolve) => server.close(resolve));
}
