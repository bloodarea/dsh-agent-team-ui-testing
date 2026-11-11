#!/usr/bin/env node
/**
 * Real Chromium: the human-acceptance game target, driven end to end.
 *
 * `tests/manual-target/game-target.html` is meant for a human to play (WASD diagonal movement,
 * FPS look with pointer lock). It also judges itself, so this suite drives the SAME file with the
 * plugin's own `browser_input` and asserts its scoreboard goes 8/8 — which proves the judge is not
 * a rubber stamp and that the capability under test (multi-key hold, relative motion) really
 * reaches the page.
 *
 * What a human still has to do is exactly what a synthetic caller cannot: judge the *feel* (is the
 * diagonal really diagonal, does the view follow the hand). Everything measurable is asserted here.
 */
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createHarness, createFakeConnectionService } from './harness.mjs';

const runDir = join(import.meta.dirname, 'runs', `game-target-${new Date().toISOString().replace(/[:.]/g, '-')}-${process.pid}`);
await mkdir(runDir, { recursive: true });
const checks = [];
const check = (label, condition, actual = null, expected = null) => {
  assert.ok(condition, `${label}${actual === null ? '' : ' :: ' + JSON.stringify(actual)}`);
  checks.push(label);
  console.log('PASS', checks.length, label);
};

const page = await readFile(join(import.meta.dirname, '..', 'manual-target', 'game-target.html'));
const server = http.createServer((req, res) => {
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.end(page);
});
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));

const owner = () => createFakeConnectionService({
  rejection: undefined, admit: () => ({ peer: { id: 'game-peer' } }), browserPeer: { id: 'game-peer' },
});
const harness = await createHarness({ name: 'game-target', connection: owner() });
const exec = { agent: { id: 'game-target', session: { header: { cwd: harness.workspaceDir } } } };
const call = async (name, args = {}) => {
  const result = await harness.invoke(name, args, exec);
  if (result.threw) throw new Error(`${name}: ${result.error.code} ${result.error.message}`);
  return result.value;
};
const report = () => call('browser_eval', { expression: 'window.__target.report()' }).then((value) => value.value);
const passedIds = (value) => value.items.filter((item) => item.pass).map((item) => item.id).sort();
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const press = (rows) => call('browser_input', { events: rows });
const key = (type, code, name, vk) => ({ kind: 'key', type, key: name, code, virtualKeyCode: vk });

try {
  const url = `http://127.0.0.1:${server.address().port}/`;
  await call('browser_navigate', { url });
  await call('browser_viewport', { action: 'set', width: 1180, height: 900, x: 0, y: 0 });
  await wait(200);
  const initial = await report();
  check('靶机加载完成：8 项待完成、页面无 JS 错误', initial.total === 8 && initial.passed === 0 && initial.errors.length === 0,
    initial, { passed: 0, total: 8, errors: [] });

  /* ------------------------------------------------------- ① WASD diagonal (multi-key hold) */
  await press([key('keyDown', 'KeyW', 'w', 87), key('keyDown', 'KeyA', 'a', 65)]);
  await wait(320);
  const diagonal = await report();
  const hud = await call('browser_eval', {
    expression: `({ speed: document.getElementById('speed').textContent, vel: document.getElementById('vel').textContent })`,
  }).then((value) => value.value);
  check('同时按住 W+A：页面判定"斜向真的斜着走"（同帧 x/y 速度都非零）',
    passedIds(diagonal).includes('diag'), passedIds(diagonal), ['diag']);
  check('斜向不加速：|v| 读数为 1.000（不是 1.414）',
    passedIds(diagonal).includes('diag-norm') && Math.abs(Number(hud.speed) - 1) < 0.02, hud, { speed: '1.000' });

  await press([key('keyUp', 'KeyA', 'a', 65)]);
  await wait(220);
  const single = await report();
  check('松开 A 后仍沿另一轴移动（状态表正确清位，不是"全松"）',
    passedIds(single).includes('release-keep'), passedIds(single), ['release-keep']);

  await press([key('keyUp', 'KeyW', 'w', 87)]);
  await wait(220);
  const stopped = await report();
  check('全部松开后速度归零', passedIds(stopped).includes('stop'), passedIds(stopped), ['stop']);

  /* ------------------------------------------------------- ② FPS look (relative motion) */
  const geometry = await call('browser_eval', {
    expression: `(() => { const r = document.getElementById('fps').getBoundingClientRect(); return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) }; })()`,
  }).then((value) => value.value);
  await press([
    { kind: 'mouse', type: 'mousePressed', x: geometry.x, y: geometry.y, button: 'left', clickCount: 1 },
    { kind: 'mouse', type: 'mouseReleased', x: geometry.x, y: geometry.y, button: 'left', clickCount: 1 },
  ]);
  await wait(500);
  const lockState = await call('browser_eval', {
    expression: `({ locked: document.pointerLockElement === document.getElementById('fps'), label: document.getElementById('lock-ok').textContent })`,
  }).then((value) => value.value);
  check('点击画面进入指针锁定（CDP 派发的点击足够获得手势），或降级到相对模式',
    lockState.label.indexOf('锁定') >= 0 || lockState.label.indexOf('相对') >= 0, lockState, '已锁定 | 相对模式');

  // 净零的一对增量：先把 yaw 推出去再拉回原点，既产生 movement 又让中央靶子重新对准准星。
  const movement = await press([
    { kind: 'mouse', type: 'mouseMoved', deltaX: 40, deltaY: -10 },
    { kind: 'mouse', type: 'mouseMoved', deltaX: -40, deltaY: 10 },
  ]);
  check('相对移动驱动虚拟光标（Host 回报 cursor 位置）',
    movement.cursor && Number.isFinite(movement.cursor.x) && Number.isFinite(movement.cursor.y), movement.cursor, 'finite');
  await wait(160);
  const aimed = await report();
  check('页面判定收到 movement 增量', passedIds(aimed).includes('movement'), passedIds(aimed), ['movement']);
  check('yaw 与 ΣmovementX×灵敏度 一致（±0.6°）', passedIds(aimed).includes('yaw'), passedIds(aimed), ['yaw']);
  const yawNow = await call('browser_eval', { expression: `Number(document.getElementById('yaw').textContent.replace('°',''))` })
    .then((value) => value.value);
  check('净零增量后准星回到中央（|yaw| < 1°）', Math.abs(yawNow) < 1, yawNow, '< 1°');

  await press([
    { kind: 'mouse', type: 'mousePressed', x: geometry.x, y: geometry.y, button: 'left', clickCount: 1 },
    { kind: 'mouse', type: 'mouseReleased', x: geometry.x, y: geometry.y, button: 'left', clickCount: 1 },
  ]);
  await wait(200);
  const final = await report();
  check('准星对上靶子后射击命中', passedIds(final).includes('hit'), passedIds(final), ['hit']);
  check('靶机自评 8/8，全部条目变绿（判定不是橡皮图章）', final.passed === 8 && final.errors.length === 0, final,
    { passed: 8, errors: [] });

  const visual = await harness.invoke('browser_screenshot', { out: join('output', 'capture', 'game-target-acceptance.png') }, exec);
  check('留证截图：页面右上角分数与条目状态可见', visual.ok === true || visual.value?.ok === true,
    visual.error || 'saved', 'saved');

  const reportFile = {
    suite: 'game-target',
    startedAt: new Date().toISOString(),
    checks: checks.length,
    criteria: `${checks.length}/${checks.length}`,
    failedChecks: 0,
    notRunChecks: [
      '手感判定（斜向是否"看起来"斜、视角是否跟手）——只能由人在调试视图里玩',
      '面板预览里的指针形状镜像（需要私有隔离 DSH 驱动 GUI 鼠标）',
    ],
    scoreboard: final,
  };
  await writeFile(join(runDir, 'report.json'), JSON.stringify(reportFile, null, 2));
  console.log(`\ngame target: ${checks.length}/${checks.length} PASS, scoreboard ${final.passed}/${final.total}`);
} catch (error) {
  const reportFile = {
    suite: 'game-target', startedAt: new Date().toISOString(), checks: checks.length,
    passed: checks.length, failed: 1, criteria: `${checks.length}/${checks.length + 1}`,
    error: { message: String((error && error.message) || error), stack: String((error && error.stack) || '') },
  };
  await writeFile(join(runDir, 'report.json'), JSON.stringify(reportFile, null, 2));
  console.error('\nFAILED after', checks.length, 'checks:', (error && error.message) || error);
  process.exitCode = 1;
} finally {
  try { await harness.dispose?.(); } catch { /* best effort */ }
  await new Promise((resolve) => server.close(resolve));
}
