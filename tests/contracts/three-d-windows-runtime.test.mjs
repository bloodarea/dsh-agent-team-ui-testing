/**
 * Windows 上的 3D（`three-d`）Blender 视口适配契约。
 *
 * 这些测试钉住三件事，都是本机实测出来的运行时事实，不是版本断言：
 * 1. 平台准入：Linux（Xvfb）与 Windows 允许，其余平台仍返回 `BLENDER_PLATFORM_UNSUPPORTED`；
 * 2. 可执行发现：Windows 上先查注册表 `Uninstall` 项，且要找 `blender.exe`（Linux 名字没有后缀）；
 * 3. 编辑器区域：`show_region_asset_shelf` 的可写性随 Blender 编辑器和模式而变，必须容错。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const source = await readFile(new URL('../../targets/three-d/runtime.js', import.meta.url), 'utf8');
const workspaces = await readFile(new URL('../../targets/three-d/workspaces.py', import.meta.url), 'utf8');

test('平台准入：Linux 与 Windows 通过，其他平台仍是 503', () => {
  // The gate must name both supported platforms and keep rejecting everything else.
  assert.match(source, /const windows = platform === 'win32';/u);
  assert.match(source, /if \(!windows && platform !== 'linux'\) \{/u);
  assert.match(source, /BLENDER_PLATFORM_UNSUPPORTED/u);
  assert.match(source, /需要 Linux（Xvfb）或 Windows/u);
});

test('Windows 走注册表发现 Blender，不扫盘', () => {
  // The registry is the only reliable signal for an installer build; a disk walk is not allowed.
  assert.match(source, /HKLM\\\\SOFTWARE\\\\Microsoft\\\\Windows\\\\CurrentVersion\\\\Uninstall/u);
  assert.match(source, /HKCU\\\\SOFTWARE\\\\Microsoft\\\\Windows\\\\CurrentVersion\\\\Uninstall/u);
  assert.match(source, /WOW6432Node/u);
  assert.match(source, /execFile\('reg'/u);
  assert.match(source, /'query', root, '\/s', '\/f', 'Blender', '\/d'/u);
  assert.match(source, /InstallLocation/u);
  assert.match(source, /DisplayVersion/u);
  // No recursive directory scan for Blender.
  assert.doesNotMatch(source, /readdir\([^)]*[\\\\/]Blender/iu);
});

test('Windows 可执行名带 .exe，Linux 不带', () => {
  assert.match(source, /function executableNames\(name, platform\) \{/u);
  assert.match(source, /return platform === 'win32' \? \[`\$\{name\}\.exe`, name\] : \[name\];/u);
  // PATH splitting must use the Windows separator on win32.
  assert.match(source, /platform === 'win32' \? ';' : delimiter/u);
});

test('注册表命中按版本号从新到旧排序', () => {
  assert.match(source, /new Intl\.Collator\('en', \{ numeric: true \}\)\.compare/u);
  assert.match(source, /\.sort\(\(left, right\) => order\(right\.version, left\.version\)\)/u);
});

test('Windows 不启动 Xvfb，Linux 仍启动', () => {
  assert.match(source, /windows \? Promise\.resolve\(null\) : executable\(process\.env\.DSH_UI_TESTING_XVFB, 'Xvfb', platform\)/u);
  // The virtual display must only be created on the Linux branch.
  const linuxBranch = source.match(/if \(windows\) \{[\s\S]*?\} else \{[\s\S]*?\n    \}/u)?.[0] ?? '';
  assert.match(linuxBranch, /-'displayfd'|'-displayfd'/u);
  assert.match(source, /const display = await lineFrom\(runtime\.display/u);
});

test('Windows 通过独立桌面启动 Blender，隔离失败直接返回视口错误', () => {
  assert.match(source, /const launch = windows \? blenderDesktopLaunch\(blender, args, env\) : \{ executable: blender, args, env \};/u);
  assert.match(source, /startProcess\(launch\.executable, launch\.args,/u);
  assert.match(source, /result === 'isolation-error'[\s\S]*?BLENDER_DESKTOP_FAILED/u);
});

test('显式 override 不可用时报错，不回退到注册表安装', () => {
  const block = source.match(/if \(override\) \{[\s\S]*?\n  \}/u)?.[0] ?? '';
  assert.ok(block.length > 0, '找不到 override 分支');
  assert.match(block, /BLENDER_DEPENDENCY_MISSING/u);
  // The override branch must return or throw before any candidate list is built.
  assert.match(block, /throw new ViewportError/u);
});

test('工作区隐藏编辑器栏位时容忍只读或缺失的属性', () => {
  const chrome = workspaces.match(/def hide_editor_chrome\(area\):[\s\S]*?(?=\ndef )/u)?.[0] ?? '';
  assert.match(chrome, /for name in \([\s\S]*?'show_region_asset_shelf'[\s\S]*?try:\s+setattr\(space, name, False\)/u);
  assert.match(chrome, /except \(AttributeError, TypeError\):\s+pass/u);
  assert.doesNotMatch(chrome, /bpy\.app\.version/u);
});
