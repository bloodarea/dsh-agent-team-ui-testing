/**
 * Windows 上的 3D 视口"无感"契约：有头运行，但不占桌面。
 *
 * Web 目标已经踩过这个坑：把窗口推到屏幕外只是让它不可见，任务栏按钮和 Alt-Tab 条目仍在。
 * 3D 的约束更强一步——窗口必须保持 mapped，否则 Blender 不再派发 `POST_PIXEL` 绘制回调，
 * 帧就没了。这些测试钉住三件事：
 * 1. 用 `WS_EX_TOOLWINDOW` / `WS_EX_APPWINDOW` 换样式移除任务栏与 Alt-Tab，而不是 `SW_HIDE`；
 * 2. 换样式是带重试的尽力而为，失败不致命（只退化成一个任务栏按钮）；
 * 3. `runtime.js` 在 Windows 上确实调用了它，且不阻塞出帧。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const hidden = await readFile(new URL('../../targets/three-d/hidden-window.js', import.meta.url), 'utf8');
const runtime = await readFile(new URL('../../targets/three-d/runtime.js', import.meta.url), 'utf8');

test('用扩展窗口样式移除任务栏与 Alt-Tab，而不是隐藏窗口', () => {
  // WS_EX_TOOLWINDOW on, WS_EX_APPWINDOW off.
  assert.match(hidden, /\$new = \(\$ex -bor 0x80\) -band \(-bnot 0x40000\)/u);
  assert.match(hidden, /SetWindowLongPtr\(\$hWnd, -20, \[IntPtr\]\$new\)/u);
  // HIDE + SHOWNOACTIVATE makes the shell re-evaluate; the window ends up mapped again.
  assert.match(hidden, /ShowWindow\(\$hWnd, 0\)/u);
  assert.match(hidden, /ShowWindow\(\$hWnd, 4\)/u);
});

test('只处理本进程的可见、无主顶层窗口', () => {
  assert.match(hidden, /\$owner -eq \$target -and \[DshBlenderWin\]::IsWindowVisible\(\$hWnd\)/u);
  // GW_OWNER (4) == null: skip dialog/child windows that belong to another top-level window.
  assert.match(hidden, /GetWindow\(\$hWnd, 4\) -eq \[IntPtr\]::Zero/u);
});

test('换样式是尽力而为：超时短、失败返回 false、不抛出', () => {
  assert.match(hidden, /timeout: 4000/u);
  assert.match(hidden, /return \/\^HIDDEN:\\d\+\$\/m\.test/u);
  assert.match(hidden, /catch \{\s*\n\s*return false;/u);
  assert.match(hidden, /if \(!Number\.isInteger\(pid\) \|\| pid <= 0\) return false;/u);
});

test('窗口晚于进程创建，因此按次数重试', () => {
  assert.match(hidden, /export async function hideBlenderWindowWhenReadyWin32/u);
  assert.match(hidden, /attempts = 12, delayMs = 250/u);
  assert.match(hidden, /if \(hideBlenderWindowWin32\(pid\)\) return true;/u);
});

test('runtime 在 Windows 启动 Blender 后触发换样式，且不阻塞出帧', () => {
  assert.match(runtime, /import \{ hideBlenderWindowWhenReadyWin32 \} from '\.\/hidden-window\.js';/u);
  // Anchor on the call itself: an earlier `if (windows)` block handles display env, so matching
  // on that phrase alone would grade the wrong branch.
  const block = runtime.match(/if \(windows\) \{\n\s*\/\/ Offscreen placement alone[\s\S]*?\n    \}/u)?.[0] ?? '';
  assert.ok(block.length > 0, '找不到 Windows 下的换样式调用');
  // Fire and forget: the frame path must not await a cosmetic window restyle.
  assert.match(block, /void hideBlenderWindowWhenReadyWin32\(runtime\.blender\.child\.pid\)/u);
  assert.match(block, /\.then\(\(hidden\) => \{ runtime\.windowHidden = hidden; \}\)/u);
  assert.match(block, /\.catch\(\(\) => \{\}\);/u);
});

test('屏幕外定位仍然保留，作为换样式失败时的退路', () => {
  assert.match(runtime, /const WINDOW_OFFSET = -10000;/u);
  assert.match(runtime, /'-p', String\(offset\), String\(offset\)/u);
});
