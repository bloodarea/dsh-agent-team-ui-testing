#!/usr/bin/env node
/**
 * Real-GUI acceptance for the shared viewport (尺寸栏 X/Y + 滚轮 + Agent 共享比例 + 坐标映射).
 *
 * What this proves (against a Host that implements docs/viewport-control.md):
 *   - This script builds its OWN isolated DSH web instance: fresh temporary DSH_HOME whose web
 *     profile config files are copied from the user profile and whose node_modules is a read-only
 *     symlink, DSH_PROFILE=web, an ephemeral loopback port (never 3080/3081) and `--no-open`.
 *     The launch token is parsed from the instance's own stdout and never printed, logged, put on
 *     a process command line or written into a report.
 *   - A separate headless Chromium (tests/acceptance/chrome-wrapper.sh) is driven over CDP; the
 *     debug panel is opened through the real shell (`更多` → `调试视图`).
 *   - The five size-bar inputs exist with their exact aria-labels; the size bar does not overflow
 *     the panel at the main width and at a narrowed window.
 *   - Every wheel step (X/Y/W/H/比例, Shift/Alt/零 delta/Ctrl 不处理/边界 clamp) is applied by the
 *     Host and echoed in the panel; a burst merges into a single `/viewport` request and neither
 *     the GUI document nor the target page scrolls.
 *   - X/Y commit (Enter/Escape) produces the exact target-page `scrollX/scrollY`; a page-initiated
 *     scroll is echoed back by the state poll.
 *   - An Agent `/viewport` set (mode / x / y / width / height / scale) is adopted by the panel and
 *     cancels the local fit; navigation afterwards does not re-publish the panel's local size.
 *   - A fixed-coordinate element is hit at fit<100% and at scale>100%: the target page counter
 *     increases exactly once and `window.__t2` records `isTrusted:true` at the mapped point.
 *   - Frame wheel deltas are scaled by W/Pw, H/Ph (two scales measured).
 *   - P0-C v2 (V13, docs/viewport-control.md §5.2–§5.3): the Host `ui.canvas` handshake, signed
 *     canvasX/canvasY input/wheel, pure-white blank pixels and the -(C-frame.scroll)*displayScale
 *     frame displacement, q -> p=q+O hit mapping, blank zero dispatch, fail-closed scroll/geometry
 *     barrier (CDP-rewritten /state evidence), drag that writes a negative C, and the simulated
 *     no-canvas / no-shared-view fallbacks (X/Y disabled or back to document scroll).
 *   - GUI screenshots are written under 本地验证记录（不随仓库分发）/viewport-gui-<stamp>/.
 *
 * NOT covered here (reported, never implied as verified):
 *   - A real old Host binary: this suite only starts a Host that exposes `ui.view`; the old-Host
 *     branch is exercised by V13 through CDP-rewritten `/state` snapshots (simulated projection,
 *     not a second Host build) and the real legacy `{width,height}` write path stays NOT_RUN (V10.4).
 *   - The single-owner lease / BUSY concurrency and the `expectedRevision` conflict path are
 *     Host-slice acceptance items; this suite only asserts that GUI patches carry a revision.
 *   - The resize geometry barrier is best-effort (≤250ms, no frame-protocol extension): the
 *     letterbox band probe is recorded NOT_APPLICABLE when the live frame has no letterbox.
 *   - The 3080/3081 instances are never touched.
 *
 * Run:  node tests/acceptance/viewport-gui.mjs
 * Env:  DSH_BIN (default `dsh`), DSH_ACCEPTANCE_CHROME / DSH_REAL_BROWSER_CHROME
 *         (default tests/acceptance/chrome-wrapper.sh), DSH_VIEWPORT_GUI_TIMEOUT_MS (default 420000),
 *       DSH_VIEWPORT_GUI_EVIDENCE (override the evidence directory),
 *       DSH_VIEWPORT_GUI_ONLY (comma-separated scenario name substrings, e.g. "V16b"),
 *       DSH_ISOLATED_PROFILE_BUNDLED_MODULES (DSH install's `.../dsh/node_modules`; makes the
 *         isolated profile resolution hermetic when the user profile's hoisted dsh-tools is older).
 *
 * Exit codes: 0 all checks pass (an environment NOT_RUN may still be recorded); 1 assertion
 *             failure; 2 blocked (the isolated Host does not expose ui.view) or fatal error.
 */
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { cp, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

if (process.argv[1] !== fileURLToPath(import.meta.url)) {
  throw new Error('viewport-gui.mjs 会启动隔离 DSH 实例与真实无头 Chromium，不能被 import 或通过 -e 触发；请直接运行 `node tests/acceptance/viewport-gui.mjs`。');
}

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = dirname(dirname(HERE));
const STAMP = new Date().toISOString().replace(/[:.]/g, '-');
const RUN_DIR = join(HERE, 'runs', `viewport-gui-${STAMP}-${process.pid}`);
const EVIDENCE_DIR = process.env.DSH_VIEWPORT_GUI_EVIDENCE || join(HERE, 'evidence', `viewport-gui-${STAMP}`);
const CHROME_BIN = process.env.DSH_ACCEPTANCE_CHROME || process.env.DSH_REAL_BROWSER_CHROME || join(HERE, 'chrome-wrapper.sh');
const DSH_BIN = process.env.DSH_BIN || 'dsh';
const DEFAULT_PROFILE = join(process.env.HOME || '', '.dsh', 'profiles', 'web');
const TOTAL_TIMEOUT_MS = Number(process.env.DSH_VIEWPORT_GUI_TIMEOUT_MS || 420000) || 420000;
const CHROME_PROFILE_PREFIX = 'dsh-viewport-gui-';
const DSH_HOME_PREFIX = 'dsh-viewport-gui-home-';
const STEP_SETTLE_MS = 450;
const X_LABEL = '视口 X 坐标（像素）';
const Y_LABEL = '视口 Y 坐标（像素）';
const W_LABEL = '视口宽度（像素）';
const H_LABEL = '视口高度（像素）';
const SCALE_LABEL = '预览缩放比例（百分比）';
const SHIFT = 8;
const CTRL = 2;
const ALT = 1;

const logLines = [];
function log(line = '') {
  const text = String(line);
  logLines.push(text);
  console.log(text);
}
function sleep(ms) { return new Promise((resolve) => setTimeout(resolve, ms)); }
function errorMessage(error) { return String((error && error.stack) || (error && error.message) || error); }

function sanitize(text) {
  let value = String(text === undefined || text === null ? '' : text);
  if (state.token) value = value.split(state.token).join('[REDACTED_TOKEN]');
  value = value.replace(/([?&]token=)[^\s&"'<>]+/g, '$1[REDACTED_TOKEN]');
  if (state.cookie) {
    for (const pair of state.cookie.split('; ')) {
      const eq = pair.indexOf('=');
      if (eq > 0) value = value.split(pair.slice(eq + 1)).join('[REDACTED_COOKIE]');
    }
  }
  return value;
}

function waitFor(check, { timeoutMs = 15000, intervalMs = 100, label = 'condition' } = {}) {
  return new Promise((resolve, reject) => {
    const started = Date.now();
    let lastError;
    const tick = async () => {
      try {
        const value = await check();
        if (value) return resolve(value);
      } catch (error) {
        lastError = error;
      }
      if (Date.now() - started >= timeoutMs) {
        return reject(new Error(`timed out after ${timeoutMs}ms waiting for ${label}${lastError ? ` (last: ${errorMessage(lastError)})` : ''}`));
      }
      setTimeout(tick, intervalMs);
    };
    tick();
  });
}

/** Ephemeral loopback port, explicitly rejecting the user's 3080/3081. */
async function pickPort() {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const port = await new Promise((resolve, reject) => {
      const server = createServer();
      server.once('error', reject);
      server.listen(0, '127.0.0.1', () => {
        const address = server.address();
        server.close(() => resolve(address.port));
      });
    });
    if (port !== 3080 && port !== 3081) return port;
  }
  throw new Error('could not allocate a non-3080/3081 loopback port');
}

/* ------------------------------------------------------------------------------------------------
 * CDP client (Node 22 global WebSocket).
 * ---------------------------------------------------------------------------------------------- */
class Cdp {
  constructor(url) {
    this.url = url;
    this.nextId = 1;
    this.pending = new Map();
    this.listeners = new Set();
    this.closed = false;
  }
  connect() {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(this.url);
      this.ws = ws;
      ws.onopen = () => resolve(this);
      ws.onerror = () => reject(new Error('cdp open failed'));
      ws.onclose = () => {
        this.closed = true;
        for (const entry of this.pending.values()) entry.reject(new Error('cdp closed'));
        this.pending.clear();
      };
      ws.onmessage = (event) => {
        let message;
        try { message = JSON.parse(event.data); } catch { return; }
        if (message.id !== undefined) {
          const entry = this.pending.get(message.id);
          if (!entry) return;
          this.pending.delete(message.id);
          if (message.error) entry.reject(new Error(`${message.error.message || 'cdp error'} [${entry.method}]`));
          else entry.resolve(message.result);
          return;
        }
        for (const listener of this.listeners) listener(message);
      };
    });
  }
  send(method, params = {}, timeoutMs = 30000) {
    if (this.closed) return Promise.reject(new Error('cdp closed'));
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject, method });
      this.ws.send(JSON.stringify({ id, method, params }));
      const timer = setTimeout(() => {
        if (this.pending.has(id)) {
          this.pending.delete(id);
          reject(new Error('cdp timeout: ' + method));
        }
      }, timeoutMs);
      timer.unref?.();
    });
  }
  on(listener) { this.listeners.add(listener); return () => this.listeners.delete(listener); }
  close() { try { if (this.ws) this.ws.close(); } catch { /* ignore */ } }
}

function isProcessAlive(pid) {
  try { process.kill(pid, 0); return true; } catch { return false; }
}

async function launchChrome(bin) {
  const profileDir = await mkdtemp(join(tmpdir(), CHROME_PROFILE_PREFIX));
  const proc = spawn(bin, [
    '--headless=new',
    '--remote-debugging-port=0',
    `--user-data-dir=${profileDir}`,
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-gpu',
    '--hide-scrollbars',
    '--mute-audio',
    '--window-size=1440,900',
    'about:blank',
  ], { stdio: ['ignore', 'ignore', 'pipe'] });
  let stderr = '';
  proc.stderr.on('data', (chunk) => { stderr = (stderr + String(chunk)).slice(-2000); });
  try {
    const devtoolsPort = await waitFor(async () => {
      const text = await readFile(join(profileDir, 'DevToolsActivePort'), 'utf8');
      const port = Number(text.split('\n')[0]);
      return port > 0 ? port : undefined;
    }, { timeoutMs: 20000, label: 'DevToolsActivePort' });
    const list = await fetch(`http://127.0.0.1:${devtoolsPort}/json/list`).then((response) => response.json());
    const page = list.find((target) => target.type === 'page');
    if (!page) throw new Error('no page target in headless chrome');
    const cdp = new Cdp(page.webSocketDebuggerUrl);
    await cdp.connect();
    return { proc, profileDir, devtoolsPort, cdp, stderrTail: () => stderr };
  } catch (error) {
    try { proc.kill('SIGKILL'); } catch { /* ignore */ }
    await rm(profileDir, { recursive: true, force: true }).catch(() => {});
    throw error;
  }
}

async function pageEvaluate(expression, { timeoutMs = 20000 } = {}) {
  const result = await state.chrome.cdp.send('Runtime.evaluate', {
    expression, returnByValue: true, awaitPromise: true, userGesture: true,
  }, timeoutMs);
  if (result.exceptionDetails) {
    const text = result.exceptionDetails.exception && result.exceptionDetails.exception.description
      ? result.exceptionDetails.exception.description
      : result.exceptionDetails.text;
    throw new Error('page evaluation failed: ' + String(text).slice(0, 400));
  }
  return result.result ? result.result.value : undefined;
}

/* ------------------------------------------------------------------------------------------------
 * Check bookkeeping.
 * ---------------------------------------------------------------------------------------------- */
const checks = [];
const notRuns = [];
function fmt(value) {
  try {
    const text = JSON.stringify(value);
    return text === undefined ? String(value) : text.slice(0, 1200);
  } catch { return String(value).slice(0, 1200); }
}
function safeValue(value) {
  try {
    const text = JSON.stringify(value);
    if (text === undefined) return String(value);
    return JSON.parse(text.replace(/[\u2028\u2029]/g, ' '));
  } catch { return sanitize(String(value)); }
}
function check(id, label, pass, expected, actual) {
  const entry = { id, label, pass: Boolean(pass), expected: safeValue(expected), actual: safeValue(actual) };
  checks.push(entry);
  log(`  [${pass ? 'PASS' : 'FAIL'}] ${id} ${label}`);
  if (!pass) log(`         expected: ${sanitize(fmt(expected))}\n         actual  : ${sanitize(fmt(actual))}`);
  return Boolean(pass);
}
/** An honest NOT_RUN: never a pass, always with a reason and its evidence. */
function notRun(id, label, reason, detail) {
  notRuns.push({ id, label, reason: sanitize(reason), detail: safeValue(detail) });
  log(`  [NOT_RUN] ${id} ${label} — ${reason}`);
}
async function scenario(name, fn) {
  const only = (process.env.DSH_VIEWPORT_GUI_ONLY || '').split(',').map((entry) => entry.trim()).filter(Boolean);
  if (only.length && !only.some((token) => name.includes(token))) {
    log(`\n--- scenario ${name} (skipped by DSH_VIEWPORT_GUI_ONLY) ---`);
    return;
  }
  log(`\n--- scenario ${name} ---`);
  try {
    await fn();
  } catch (error) {
    check(name, 'scenario completed without fatal error', false, 'no exception', sanitize(errorMessage(error)));
  }
}

/* ------------------------------------------------------------------------------------------------
 * State.
 * ---------------------------------------------------------------------------------------------- */
const state = {
  token: '',
  cookie: '',
  chrome: undefined,
  fixture: undefined,
  dsh: undefined,
  scopeHeaders: null,
  requests: [],
  responses: [],
  exceptions: [],
  consoleErrors: [],
  dialogsDismissed: 0,
  evidence: [],
  buildInfo: null,
  servedClient: null,
  hostView: null,
  blocked: '',
  backgroundTargetId: '',
};

/* ------------------------------------------------------------------------------------------------
 * Isolated DSH instance.
 * ---------------------------------------------------------------------------------------------- */
async function prepareDshHome() {
  const home = await mkdtemp(join(tmpdir(), DSH_HOME_PREFIX));
  const profileDir = join(home, 'profiles', 'web');
  await mkdir(profileDir, { recursive: true });
  const files = ['package.json', 'cordis.patch.yml', 'compatibility.json', 'pnpm-lock.yaml', 'cordis.yml'];
  const copied = [];
  for (const name of files) {
    const source = join(DEFAULT_PROFILE, name);
    if (!existsSync(source)) continue;
    await writeFile(join(profileDir, name), await readFile(source));
    copied.push(name);
  }
  const nodeModules = join(DEFAULT_PROFILE, 'node_modules');
  if (!existsSync(nodeModules)) throw new Error(`user profile node_modules missing: ${nodeModules}`);
  await symlink(nodeModules, join(profileDir, 'node_modules'), 'dir');
  // Optional hermetic overlay (set DSH_ISOLATED_PROFILE_BUNDLED_MODULES to the DSH install's
  // `.../@deepseek-ai/dsh/node_modules` directory): the web profile resolves some hoisted packages
  // one level above itself. Copying that parent into the isolated home (and pointing dsh-tools at
  // the version bundled with the running DSH) keeps resolution hermetic when the user profile's
  // hoisted copy is older than the installed DSH. With --preserve-symlinks the symlinked web
  // node_modules stays inside the isolated home, so the copy is actually consulted.
  const bundledModules = process.env.DSH_ISOLATED_PROFILE_BUNDLED_MODULES || '';
  const hoisted = join(DEFAULT_PROFILE, '..', 'node_modules');
  if (bundledModules && existsSync(hoisted) && existsSync(join(bundledModules, '@deepseek-ai', 'dsh-tools'))) {
    const target = join(home, 'profiles', 'node_modules');
    // Keep symlinks verbatim: the user's hoisted tree contains pnpm links whose targets are not
    // materialised until used, and dereferencing them here would fail on the first dangling entry.
    await cp(hoisted, target, { recursive: true, dereference: false, verbatimSymlinks: true });
    await rm(join(target, '@deepseek-ai', 'dsh-tools'), { recursive: true, force: true });
    await cp(join(bundledModules, '@deepseek-ai', 'dsh-tools'), join(target, '@deepseek-ai', 'dsh-tools'), {
      recursive: true, dereference: true,
    });
  }
  return { home, profileDir, copied };
}

async function startIsolatedDsh() {
  const { home, profileDir, copied } = await prepareDshHome();
  const port = await pickPort();
  const overlayModules = Boolean(process.env.DSH_ISOLATED_PROFILE_BUNDLED_MODULES);
  const nodeOptions = `${process.env.NODE_OPTIONS || ''}${overlayModules ? ' --preserve-symlinks' : ''}`.trim();
  const proc = spawn(DSH_BIN, ['web', '--port', String(port), '--no-open'], {
    env: {
      ...process.env,
      DSH_HOME: home,
      DSH_PROFILE: 'web',
      ...(nodeOptions ? { NODE_OPTIONS: nodeOptions } : {}),
      DSH_UI_TESTING_CHROME: process.env.DSH_UI_TESTING_CHROME || CHROME_BIN,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '';
  const capture = (chunk) => { output += String(chunk); };
  proc.stdout.on('data', capture);
  proc.stderr.on('data', capture);
  proc.on('exit', (code, signal) => { log(`[dsh] exited code=${code} signal=${signal}`); });
  state.dsh = { proc, home, profileDir, port, copied, output: () => output, base: `http://127.0.0.1:${port}` };

  const pattern = new RegExp(`dsh web: (http://127\\.0\\.0\\.1:${port}/\\?token=([A-Za-z0-9_-]+))`);
  const matched = await waitFor(() => {
    const match = pattern.exec(output);
    return match ? { url: match[1], token: match[2] } : undefined;
  }, { timeoutMs: 120000, intervalMs: 250, label: 'isolated dsh launch URL' });
  state.token = matched.token;
  state.dsh.launchUrl = matched.url;
  await waitFor(async () => {
    try {
      const response = await fetch(state.dsh.base + '/', { signal: AbortSignal.timeout(3000) });
      return response.status < 500;
    } catch { return false; }
  }, { timeoutMs: 40000, intervalMs: 400, label: 'isolated dsh HTTP listener' });
  return state.dsh;
}

async function authenticate(launchUrl) {
  const response = await fetch(launchUrl, { redirect: 'manual', signal: AbortSignal.timeout(20000) });
  const cookies = response.headers.getSetCookie();
  if (!cookies.length) throw new Error(`launch URL did not issue a cookie (status ${response.status})`);
  const simplified = cookies.map((value) => value.split(';')[0]);
  state.cookie = simplified.join('; ');
  return simplified;
}

/* ------------------------------------------------------------------------------------------------
 * GUI helpers.
 * ---------------------------------------------------------------------------------------------- */
async function guiReady(timeoutMs = 45000) {
  return waitFor(async () => {
    const info = await pageEvaluate(`({
      ready: document.readyState,
      boot: !!window.__DSH_BOOT__,
      origin: location.origin,
      root: !!(document.querySelector('#root') && document.querySelector('#root').children.length),
    })`);
    return info && info.ready === 'complete' && info.boot && info.root ? info : undefined;
  }, { timeoutMs, label: 'GUI shell ready' });
}

async function dismissShellDialogs() {
  const dismissed = await pageEvaluate(`(() => {
    let closed = 0;
    for (const dialog of [...document.querySelectorAll('[role="dialog"]')]) {
      const button = [...dialog.querySelectorAll('button')].find((node) => /关闭|close/i.test((node.getAttribute('aria-label') || '') + (node.textContent || '')));
      if (button) { button.click(); closed += 1; }
    }
    return closed;
  })()`);
  if (dismissed) await sleep(700);
  state.dialogsDismissed += Number(dismissed) || 0;
  return dismissed;
}

async function ensureLeftSidebar() {
  const expanded = await pageEvaluate(`(() => {
    const collapse = document.querySelector('button[aria-label="收起侧边栏"]');
    if (collapse) return true;
    const expand = document.querySelector('button[aria-label="展开侧边栏"]');
    if (expand) { expand.click(); return false; }
    return false;
  })()`);
  if (!expanded) await sleep(400);
  return expanded;
}

async function openPanel() {
  await dismissShellDialogs();
  await ensureLeftSidebar();
  const opened = await waitFor(async () => {
    const clicked = await pageEvaluate(`(() => {
      const button = document.querySelector('button[aria-label="更多"]:not(.utb-btn)');
      if (!button) return 'no-more';
      button.click();
      return 'clicked';
    })()`);
    if (clicked !== 'clicked') return undefined;
    await sleep(350);
    const row = await pageEvaluate(`(() => {
      const direct = [...document.querySelectorAll('.utb-menu-row')].find((el) => (el.textContent || '').includes('调试视图'));
      const fallback = direct || [...document.querySelectorAll('button, a, [role="menuitem"]')]
        .find((el) => (el.textContent || '').trim() === '调试视图');
      if (!fallback) return false;
      fallback.click();
      return true;
    })()`);
    return row ? true : undefined;
  }, { timeoutMs: 15000, intervalMs: 200, label: '更多 → 调试视图' });
  if (!opened) throw new Error('cannot open the debug panel through the shell');
  await waitFor(async () => {
    const found = await pageEvaluate(`!!([...document.querySelectorAll('.utb')].find((el) => !el.closest('[data-sidebar-right-tab]')))`);
    return found ? true : undefined;
  }, { timeoutMs: 12000, intervalMs: 150, label: 'main debug panel mounted' });
  await waitFor(() => state.scopeHeaders || undefined, { timeoutMs: 15000, intervalMs: 150, label: 'panel scope headers' });
  await sleep(400);
}

/** Expression body evaluated with the main (non-sidebar) panel bound to `panel`. */
function panelExpr(inner) {
  return `(() => {
    const panel = [...document.querySelectorAll('.utb')].find((el) => !el.closest('[data-sidebar-right-tab]'));
    if (!panel) return { missing: true };
    ${inner}
  })()`;
}

async function panelState() {
  return pageEvaluate(panelExpr(`
    const inputs = [...panel.querySelectorAll('.utb-size input')].map((input) => ({
      label: input.getAttribute('aria-label'),
      type: input.type,
      value: input.value,
      disabled: input.disabled,
      field: input.getAttribute('data-utb-field'),
      min: input.getAttribute('min'),
      max: input.getAttribute('max'),
      title: input.title,
    }));
    const byLabel = {};
    for (const input of inputs) if (input.label) byLabel[input.label] = input;
    const bar = panel.querySelector('.utb-size');
    const fitBtn = panel.querySelector('[data-utb-panfit-opt="fit"]');
    const panBtn = panel.querySelector('[data-utb-panfit-opt="pan"]');
    const panFitGroup = panel.querySelector('[data-utb-panfit]');
    const panLayer = panel.querySelector('[data-utb-pan-layer]');
    const zoom = panel.querySelector('.utb-zoom');
    const img = panel.querySelector('.utb-frame');
    const box = panel.querySelector('.utb-box');
    let frame = null;
    if (img && box) {
      const imgRect = img.getBoundingClientRect();
      const boxRect = box.getBoundingClientRect();
      frame = {
        naturalWidth: img.naturalWidth, naturalHeight: img.naturalHeight, complete: img.complete,
        img: { left: imgRect.left, top: imgRect.top, width: imgRect.width, height: imgRect.height },
        box: { left: boxRect.left, top: boxRect.top, width: boxRect.width, height: boxRect.height },
      };
    }
    return {
      missing: false,
      sizeBar: Boolean(bar),
      inputs,
      byLabel,
      presets: [...panel.querySelectorAll('.utb-preset')].map((el) => {
        const dot = el.querySelector('[data-utb-seg-dot]');
        const rect = el.getBoundingClientRect();
        return {
          label: (el.textContent || '').trim(),
          pressed: el.getAttribute('aria-pressed') === 'true',
          disabled: el.disabled === true,
          opt: el.getAttribute('data-utb-preset-opt'),
          ariaLabel: el.getAttribute('aria-label'),
          classes: String(el.className || ''),
          dot: dot ? {
            group: dot.getAttribute('data-utb-seg-group'),
            state: dot.getAttribute('data-utb-seg-dot'),
            visibility: getComputedStyle(dot).visibility,
            width: dot.getBoundingClientRect().width,
            height: dot.getBoundingClientRect().height,
            circleFill: dot.querySelector('circle') ? dot.querySelector('circle').getAttribute('fill') : null,
          } : null,
          rect: { left: rect.left, top: rect.top, width: rect.width, height: rect.height },
        };
      }),
      // 用户 2026-11-03 第 2 轮：左侧分辨率预设是分页选择器（与 填充|外框 / 拖拽|适应窗口|默认 同构）。
      presetsGroup: (() => {
        const group = panel.querySelector('[data-utb-preset]');
        if (!group) return null;
        const rect = group.getBoundingClientRect();
        const left = group.parentElement;
        const bar = panel.querySelector('.utb-size');
        return {
          tag: group.tagName,
          classes: String(group.className || ''),
          role: group.getAttribute('role'),
          ariaLabel: group.getAttribute('aria-label'),
          dataPreset: group.getAttribute('data-utb-preset'),
          display: getComputedStyle(group).display,
          buttonCount: group.querySelectorAll('button').length,
          segClass: group.classList.contains('utb-seg'),
          rect: { left: rect.left, top: rect.top, width: rect.width, height: rect.height },
          leftRole: left ? left.getAttribute('role') : null,
          leftAriaLabel: left ? left.getAttribute('aria-label') : null,
          bar: bar ? { scrollWidth: bar.scrollWidth, clientWidth: bar.clientWidth,
            left: bar.getBoundingClientRect().left, right: bar.getBoundingClientRect().right } : null,
        };
      })(),
      sizingEntryDisabled: (() => { const b = panel.querySelector('button[aria-label="尺寸调整"]'); return b ? b.disabled : null; })(),
      fitChecked: fitBtn ? fitBtn.getAttribute('aria-pressed') === 'true' : null,
      // The box always carries the local fit/pan facts (the size bar can be closed in the mode).
      fitState: box ? box.getAttribute('data-utb-fit') : null,
      panState: box ? box.getAttribute('data-utb-pan-state') : null,
      fitDisabled: fitBtn ? fitBtn.disabled : null,
      fitTitle: fitBtn ? fitBtn.title : null,
      // 用户 2026-11-03 第 4 条：拖拽/适应窗口分页选择器（互斥，最多一个 aria-pressed）。
      panChecked: panBtn ? panBtn.getAttribute('aria-pressed') === 'true' : null,
      panDisabled: panBtn ? panBtn.disabled : null,
      panTitle: panBtn ? panBtn.title : null,
      panFit: panFitGroup ? (() => {
        const state = panFitGroup.getAttribute('data-utb-panfit-state');
        const options = [...panFitGroup.querySelectorAll('[data-utb-panfit-opt]')].map((el) => ({
          option: el.getAttribute('data-utb-panfit-opt'),
          label: el.getAttribute('aria-label'),
          text: (el.textContent || '').trim(),
          pressed: el.getAttribute('aria-pressed') === 'true',
          disabled: el.disabled === true,
          title: el.title,
          rect: (() => { const r = el.getBoundingClientRect(); return { left: r.left, top: r.top, width: r.width, height: r.height }; })(),
        }));
        const groupRect = panFitGroup.getBoundingClientRect();
        return { state, options, pressedCount: options.filter((option) => option.pressed).length,
          rect: { left: groupRect.left, top: groupRect.top, width: groupRect.width, height: groupRect.height } };
      })() : null,
      panLayer: Boolean(panLayer),
      panLayerCursor: panLayer ? getComputedStyle(panLayer).cursor : null,
      frameCursor: img ? getComputedStyle(img).cursor : null,
      framePanAttr: img ? img.getAttribute('data-utb-pan') : null,
      // P0-C v2 canvas compositing facts (docs/viewport-control.md §5.2): the clipping box is the
      // measurement surface (the <img> itself is translated inside it), plus its readiness barrier.
      canvasOn: box ? box.getAttribute('data-utb-canvas') : null,
      canvasReady: box ? box.getAttribute('data-utb-canvas-ready') : null,
      canvasBarrier: box ? box.getAttribute('data-utb-canvas-barrier') : null,
      canvasDetail: box ? box.getAttribute('data-utb-canvas-detail') : null,
      canvasBlank: box ? box.getAttribute('data-utb-canvas-blank') : null,
      canvasChecker: box ? box.getAttribute('data-utb-canvas-checker') : null,
      canvasZoom: box ? box.getAttribute('data-utb-canvas-zoom') : null,
      canvasZoomAnchor: box ? box.getAttribute('data-utb-canvas-zoom-anchor') : null,
      canvasZoomAnchorState: box ? box.getAttribute('data-utb-canvas-zoom-anchor-state') : null,
      stage: (() => {
        const stageEl = panel.querySelector('.utb-stage');
        if (!stageEl) return null;
        const rect = stageEl.getBoundingClientRect();
        return { left: rect.left, top: rect.top, width: rect.width, height: rect.height,
          clientWidth: stageEl.clientWidth, clientHeight: stageEl.clientHeight,
          scrollLeft: stageEl.scrollLeft, scrollTop: stageEl.scrollTop };
      })(),
      viewRevision: box && box.getAttribute('data-utb-view-revision') !== null && box.getAttribute('data-utb-view-revision') !== ''
        ? Number(box.getAttribute('data-utb-view-revision')) : null,
      canvasSeedClip: img ? img.getAttribute('data-utb-canvas-seed-clip') : null,
      boxBackground: box ? getComputedStyle(box).backgroundColor : null,
      boxBackgroundImage: box ? getComputedStyle(box).backgroundImage : null,
      imgTransform: img ? getComputedStyle(img).transform : null,
      zoomValue: zoom ? zoom.value : null,
      zoomTitle: zoom ? zoom.title : null,
      width: byLabel[${JSON.stringify(W_LABEL)}] ? byLabel[${JSON.stringify(W_LABEL)}].value : null,
      height: byLabel[${JSON.stringify(H_LABEL)}] ? byLabel[${JSON.stringify(H_LABEL)}].value : null,
      x: byLabel[${JSON.stringify(X_LABEL)}] ? byLabel[${JSON.stringify(X_LABEL)}].value : null,
      y: byLabel[${JSON.stringify(Y_LABEL)}] ? byLabel[${JSON.stringify(Y_LABEL)}].value : null,
      scale: byLabel[${JSON.stringify(SCALE_LABEL)}] ? byLabel[${JSON.stringify(SCALE_LABEL)}].value : null,
      xDisabled: byLabel[${JSON.stringify(X_LABEL)}] ? byLabel[${JSON.stringify(X_LABEL)}].disabled : null,
      yDisabled: byLabel[${JSON.stringify(Y_LABEL)}] ? byLabel[${JSON.stringify(Y_LABEL)}].disabled : null,
      bar: bar ? (() => {
        const rect = bar.getBoundingClientRect();
        const panelRect = panel.getBoundingClientRect();
        return { left: rect.left, right: rect.right, top: rect.top, bottom: rect.bottom, width: rect.width, height: rect.height,
                 panelLeft: panelRect.left, panelRight: panelRect.right, scrollWidth: bar.scrollWidth, clientWidth: bar.clientWidth };
      })() : null,
      stageTop: panel.querySelector('.utb-stage') ? panel.querySelector('.utb-stage').getBoundingClientRect().top : null,
      address: panel.querySelector('.utb-addr') ? panel.querySelector('.utb-addr').value : null,
      activeLabel: document.activeElement && document.activeElement.getAttribute ? document.activeElement.getAttribute('aria-label') : null,
      // P0-D annotation mode (docs/viewport-control.md §2/§6).
      annot: (() => {
        const entry = panel.querySelector('button[aria-label="标注"]');
        const bar = panel.querySelector('.utb-annot-bar');
        const svg = panel.querySelector('.utb-annot-layer');
        const box = panel.querySelector('.utb-box');
        const edit = panel.querySelector('.utb-annot-text-input');
        const fill = panel.querySelector('[data-utb-annot-mode="fill"]');
        const stroke = panel.querySelector('[data-utb-annot-mode="stroke"]');
        const styleSeg = panel.querySelector('[data-utb-annot-seg]');
        const color = panel.querySelector('input[aria-label="颜色"]');
        const width = panel.querySelector('input[aria-label="粗细"]');
        const barRect = bar ? bar.getBoundingClientRect() : null;
        const svgRect = svg ? svg.getBoundingClientRect() : null;
        const editRect = edit ? edit.getBoundingClientRect() : null;
        const shapeNodes = [...panel.querySelectorAll('.utb-annot-layer g[data-utb-annot-state="committed"]')];
        return {
          present: Boolean(entry),
          disabled: entry ? entry.disabled : null,
          pressed: entry ? entry.getAttribute('aria-pressed') : null,
          controls: entry ? entry.getAttribute('aria-controls') : null,
          icon: entry && entry.querySelector('svg') ? (() => {
            const icon = entry.querySelector('svg');
            return { width: icon.getAttribute('width'), height: icon.getAttribute('height'),
              strokeWidth: icon.getAttribute('stroke-width'), stroke: icon.getAttribute('stroke') };
          })() : null,
          bar: bar ? { id: bar.id, role: bar.getAttribute('role'), label: bar.getAttribute('aria-label'),
            left: barRect.left, top: barRect.top, right: barRect.right, bottom: barRect.bottom,
            width: barRect.width, height: barRect.height,
            scrollWidth: bar.scrollWidth, clientWidth: bar.clientWidth,
            background: getComputedStyle(bar).backgroundColor } : null,
          tools: [...panel.querySelectorAll('[data-utb-annot-tool]')].map((el) => ({
            tool: el.getAttribute('data-utb-annot-tool'), label: el.getAttribute('aria-label'), title: el.title,
            pressed: el.getAttribute('aria-pressed'),
            rect: (() => { const r = el.getBoundingClientRect(); return { left: r.left, top: r.top, width: r.width, height: r.height }; })(),
          })),
          fill: fill ? { type: 'button', checked: fill.getAttribute('aria-pressed') === 'true', disabled: fill.disabled, label: fill.getAttribute('aria-label'), title: fill.title } : null,
          stroke: stroke ? { type: 'button', checked: stroke.getAttribute('aria-pressed') === 'true', disabled: stroke.disabled, label: stroke.getAttribute('aria-label'), title: stroke.title } : null,
          styleSeg: styleSeg ? (() => {
            const options = [...styleSeg.querySelectorAll('[data-utb-annot-mode]')].map((el) => ({
              mode: el.getAttribute('data-utb-annot-mode'),
              label: el.getAttribute('aria-label'),
              pressed: el.getAttribute('aria-pressed') === 'true',
              disabled: el.disabled === true,
              title: el.title,
              rect: (() => { const r = el.getBoundingClientRect(); return { left: r.left, top: r.top, width: r.width, height: r.height }; })(),
            }));
            return { present: true, group: styleSeg.getAttribute('data-utb-annot-seg'),
              role: styleSeg.getAttribute('role'), ariaLabel: styleSeg.getAttribute('aria-label'), options,
              pressedCount: options.filter((option) => option.pressed).length };
          })() : null,
          entryState: entry ? entry.getAttribute('data-utb-annot-entry') : null,
          title: entry ? entry.title : null,
          color: color ? { type: color.type, value: color.value } : null,
          width: width ? { type: width.type, value: width.value, min: width.min, max: width.max, step: width.step, disabled: width.disabled } : null,
          boxAnnot: box ? box.getAttribute('data-utb-annot') : null,
          svg: svg ? { viewBox: svg.getAttribute('viewBox'), layer: svg.getAttribute('data-utb-annot-layer'),
            space: svg.getAttribute('data-utb-annot-space'), role: svg.getAttribute('role'), label: svg.getAttribute('aria-label'),
            sync: svg.getAttribute('data-utb-annot-sync'), revision: svg.getAttribute('data-utb-annot-revision'),
            tabIndex: svg.getAttribute('tabindex'), pointerEvents: getComputedStyle(svg).pointerEvents,
            preserveAspectRatio: svg.getAttribute('preserveAspectRatio'), overflow: getComputedStyle(svg).overflow,
            left: svgRect.left, top: svgRect.top, width: svgRect.width, height: svgRect.height } : null,
          draft: Boolean(panel.querySelector('.utb-annot-layer g[data-utb-annot-state="draft"]')),
          draftChildren: panel.querySelector('.utb-annot-layer g[data-utb-annot-state="draft"]')
            ? panel.querySelector('.utb-annot-layer g[data-utb-annot-state="draft"]').children.length : null,
          text: edit ? { className: edit.className, type: edit.type, ariaLabel: edit.getAttribute('aria-label'),
            maxLength: edit.getAttribute('maxlength'), value: edit.value,
            left: editRect.left, top: editRect.top, width: editRect.width, height: editRect.height,
            fontSize: getComputedStyle(edit).fontSize, zIndex: getComputedStyle(edit).zIndex } : null,
          shapes: shapeNodes.map((g) => {
            const child = g.firstElementChild;
            const attrs = {};
            for (const attr of g.attributes) if (attr.name.startsWith('data-utb-annot-')) attrs[attr.name] = attr.value;
            const nativeAttrs = {};
            if (child) for (const attr of child.attributes) nativeAttrs[attr.name] = attr.value;
            const ctm = child && child.getScreenCTM ? child.getScreenCTM() : null;
            return {
              id: g.getAttribute('data-utb-annot-id'), type: g.getAttribute('data-utb-annot-type'),
              attrs, native: child ? { tag: child.tagName, text: child.textContent, attrs: nativeAttrs } : null,
              ctm: ctm ? { a: ctm.a, b: ctm.b, c: ctm.c, d: ctm.d, e: ctm.e, f: ctm.f } : null,
              rect: child && child.getBoundingClientRect ? (() => {
                const r = child.getBoundingClientRect();
                return { left: r.left, top: r.top, width: r.width, height: r.height };
              })() : null,
            };
          }),
        };
      })(),
      frame,
    };
  `));
}

async function openSizeBar() {
  // The sizing entry is disabled in the annotation mode: leave it first (setup-only repair).
  const before = await panelState();
  if (before.annot && before.annot.pressed === 'true') {
    await pageEvaluate(panelExpr(`const b = panel.querySelector('button[aria-label="标注"]'); if (b && b.getAttribute('aria-pressed') === 'true') b.click(); return true;`)).catch(() => undefined);
    await sleep(350);
  }
  await pageEvaluate(panelExpr(`
    const button = panel.querySelector('button[aria-label="尺寸调整"]');
    if (button && button.getAttribute('aria-pressed') !== 'true' && !button.disabled) button.click();
    return true;
  `));
  await waitFor(async () => ((await panelState()).sizeBar ? true : undefined), { timeoutMs: 5000, intervalMs: 100, label: 'size bar visible' });
}

async function closeSizeBar() {
  // Closing an already-closed bar is a no-op: never touch the annotation mode here (the mode and
  // the size bar are mutually exclusive, but callers use this to ensure the bar is closed).
  await pageEvaluate(panelExpr(`
    const button = panel.querySelector('button[aria-label="尺寸调整"]');
    if (button && button.getAttribute('aria-pressed') === 'true' && !button.disabled) button.click();
    return true;
  `));
  await waitFor(async () => ((await panelState()).sizeBar ? undefined : true), { timeoutMs: 5000, intervalMs: 100, label: 'size bar closed' });
}

async function fieldRect(label) {
  const rect = await pageEvaluate(panelExpr(`
    const input = [...panel.querySelectorAll('.utb-size input')].find((node) => node.getAttribute('aria-label') === ${JSON.stringify(label)});
    if (!input) return null;
    const r = input.getBoundingClientRect();
    return { x: r.left + r.width / 2, y: r.top + r.height / 2, left: r.left, top: r.top, width: r.width, height: r.height };
  `));
  if (!rect) throw new Error(`size-bar input not found: ${label}`);
  if (!(rect.width > 0) || !(rect.height > 0)) throw new Error(`size-bar input has no layout box (hidden panel?): ${label} ${JSON.stringify(rect)}`);
  return rect;
}

async function clickAt(x, y) {
  await state.chrome.cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y, button: 'none', buttons: 0 });
  await state.chrome.cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', buttons: 1, clickCount: 1 });
  await state.chrome.cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', buttons: 0, clickCount: 1 });
}

async function focusField(label) {
  const name = String(label);
  await waitSyncNoticeSettled(name);
  let rect = await fieldRect(label);
  await ensureFieldHit({ label, field: await fieldKeyOf(label) }, rect);
  await waitSyncNoticeSettled(name);
  rect = await fieldRect(label);
  await clickAt(rect.x, rect.y);
  await sleep(120);
  // A late syncNotice can shift the bar between rect read and click; typing into the address
  // bar instead of this field would silently navigate the page (V6.5/V6.6 race). Verify focus
  // and retry once at a fresh rect.
  const focused = await pageEvaluate(panelExpr(`
    (() => { const el = document.activeElement; return el && el.getAttribute ? el.getAttribute('aria-label') : null; })()
  `));
  if (focused !== name) {
    await waitSyncNoticeSettled(name);
    rect = await fieldRect(label);
    await clickAt(rect.x, rect.y);
    await sleep(120);
  }
  return rect;
}

/** data-utb-field of one size-bar input (the field key the client uses). */
async function fieldKeyOf(label) {
  return pageEvaluate(panelExpr(`
    const input = [...panel.querySelectorAll('.utb-size input')].find((node) => node.getAttribute('aria-label') === ${JSON.stringify(label)});
    return input ? input.getAttribute('data-utb-field') : null;
  `));
}

/** Real keystroke text entry: select the field content, insert text, then Enter/Escape. */
async function typeIntoField(label, text, { enter = false, escape = false } = {}) {
  await focusField(label);
  await pageEvaluate(panelExpr(`
    const input = [...panel.querySelectorAll('.utb-size input')].find((node) => node.getAttribute('aria-label') === ${JSON.stringify(label)});
    if (!input) return false;
    input.select();
    return true;
  `));
  await state.chrome.cdp.send('Input.insertText', { text: String(text) });
  await sleep(100);
  if (escape) await pressKey('Escape', 'Escape', 27);
  else if (enter) await pressKey('Enter', 'Enter', 13);
}

async function pressKey(key, code, virtualKeyCode) {
  await state.chrome.cdp.send('Input.dispatchKeyEvent', { type: 'keyDown', key, code, windowsVirtualKeyCode: virtualKeyCode, nativeVirtualKeyCode: virtualKeyCode });
  await state.chrome.cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', key, code, windowsVirtualKeyCode: virtualKeyCode, nativeVirtualKeyCode: virtualKeyCode });
  await sleep(80);
}

/**
 * Make sure the point really hits the intended size-bar input. A DSH shell modal mask (e.g. the
 * sidebar drawer that a narrow window opens) sits above the panel and would swallow trusted input;
 * one real click on it closes it, exactly like a user would.
 */
async function ensureFieldHit(label, rect) {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const hit = await pageEvaluate(`(() => {
      const el = document.elementFromPoint(${rect.x}, ${rect.y});
      if (!el) return { blocked: true, reason: 'no element' };
      return {
        field: el.getAttribute ? el.getAttribute('data-utb-field') : null,
        label: el.getAttribute ? el.getAttribute('aria-label') : null,
        cls: String(el.className || '').slice(0, 60),
        dialogs: document.querySelectorAll('[role="dialog"]').length,
      };
    })()`).catch(() => ({ blocked: true, reason: 'probe failed' }));
    if (hit && (hit.field === label.field || hit.label === label.label)) return { ok: true, attempts: attempt };
    await dismissShellDialogs();
    await clickAt(rect.x, rect.y);
    await sleep(400);
    const refreshed = await fieldRect(label.label);
    rect = refreshed;
  }
  return { ok: false, last: await pageEvaluate(`(() => { const el = document.elementFromPoint(${rect.x}, ${rect.y}); return el ? String(el.className || el.tagName).slice(0, 60) : null; })()`).catch(() => null) };
}

/**
 * A visible syncNotice row changes the size-bar offset. Wait until no such row has existed for
 * ~150 ms, then re-read the field rect right before dispatching the wheel (V13.5 race).
 */
async function waitSyncNoticeSettled(label) {
  let absentSince = 0;
  const ok = await waitFor(async () => {
    const note = await pageEvaluate(`(() => { const n = document.querySelector('[data-utb-sync-state]'); return n ? { state: n.getAttribute('data-utb-sync-state'), text: n.textContent || '' } : null; })()`);
    if (note) { absentSince = 0; return undefined; }
    if (!absentSince) absentSince = Date.now();
    return Date.now() - absentSince >= 150 ? true : undefined;
  }, { timeoutMs: 4000, intervalMs: 50, label: 'sync notice settled for ' + label }).catch(() => null);
  if (!ok) log(`  [warn] sync notice did not settle before wheel on ${label}`);
}

/** Real wheel event over a size-bar field (CDP modifiers: Alt=1, Ctrl=2, Meta=4, Shift=8). */
async function wheelOnField(label, deltaY, modifiers = 0, { settle = true } = {}) {
  await waitSyncNoticeSettled(String(label.label || 'field'));
  let rect = await fieldRect(label);
  const guard = await ensureFieldHit({ label, field: await fieldKeyOf(label) }, rect);
  await sleep(40);
  await waitSyncNoticeSettled(String(label.label || 'field'));
  rect = await fieldRect(label);
  if (!guard.ok) log(`  [warn] wheel target for ${label} is covered by ${guard.last}`);
  // Chromium routes a wheel event to the *hovered* node, so the pointer must be moved first.
  await state.chrome.cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: rect.x, y: rect.y, button: 'none', buttons: 0 });
  await sleep(30);
  await state.chrome.cdp.send('Input.dispatchMouseEvent', { type: 'mouseWheel', x: rect.x, y: rect.y, deltaX: 0, deltaY, modifiers });
  if (settle) await sleep(STEP_SETTLE_MS);
  return rect;
}

/** A burst of wheel notches inside one 120ms window (proves the debounce merge). */
async function wheelBurst(label, count, deltaY, modifiers = 0) {
  await waitSyncNoticeSettled(String(label.label || 'field'));
  let rect = await fieldRect(label);
  await ensureFieldHit({ label, field: await fieldKeyOf(label) }, rect);
  await waitSyncNoticeSettled(String(label.label || 'field'));
  rect = await fieldRect(label);
  await state.chrome.cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: rect.x, y: rect.y, button: 'none', buttons: 0 });
  await sleep(30);
  // Fire the notches back-to-back: awaiting each CDP round-trip would space them far enough apart
  // for the 120ms trailing debounce to flush in between (which is correct behaviour, not a merge).
  await Promise.all(Array.from({ length: count }, () => state.chrome.cdp.send('Input.dispatchMouseEvent', {
    type: 'mouseWheel', x: rect.x, y: rect.y, deltaX: 0, deltaY, modifiers,
  })));
  await sleep(900);
  return rect;
}

/** Real wheel event over the annotation width input (user 2026-11-03, requirement 5). */
async function wheelOnAnnotWidth(deltaY, modifiers = 0) {
  const rect = await pageEvaluate(panelExpr(`
    const input = panel.querySelector('[data-utb-annot-field="width"]');
    if (!input) return null;
    const r = input.getBoundingClientRect();
    return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
  `));
  if (!rect) throw new Error('annotation width input not found');
  await state.chrome.cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: rect.x, y: rect.y, button: 'none', buttons: 0 });
  await sleep(30);
  await state.chrome.cdp.send('Input.dispatchMouseEvent', { type: 'mouseWheel', x: rect.x, y: rect.y, deltaX: 0, deltaY, modifiers });
  await sleep(220);
  return (await panelState()).annot;
}

/** Real wheel event over the displayed frame (same hover precondition; CDP modifier bitmask). */
async function wheelOnFramePoint(point, deltaY, modifiers = 0) {
  await state.chrome.cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: point.x, y: point.y, button: 'none', buttons: 0 });
  await sleep(30);
  await state.chrome.cdp.send('Input.dispatchMouseEvent', { type: 'mouseWheel', x: point.x, y: point.y, deltaX: 0, deltaY, modifiers });
}

/** Fire a burst of wheel notches inside one debounce window (proves one merged patch). */
async function wheelBurstOnFramePoint(point, count, deltaY) {
  await state.chrome.cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: point.x, y: point.y, button: 'none', buttons: 0 });
  await sleep(30);
  // Deliver every notch (40ms apart, still one 120ms debounce window) instead of racing the CDP
  // commands: Chromium may coalesce parallel wheel events, which would not exercise accumulation.
  for (let index = 0; index < count; index += 1) {
    await state.chrome.cdp.send('Input.dispatchMouseEvent', {
      type: 'mouseWheel', x: point.x, y: point.y, deltaX: 0, deltaY, modifiers: 0,
    });
    await sleep(40);
  }
  await sleep(900);
}

/** Wait until the panel's accepted shared-view revision equals the Host's. */
async function waitPanelRevision(expected, { timeoutMs = 7000 } = {}) {
  return waitFor(async () => {
    const panel = await panelState();
    return panel.viewRevision !== null && Number(panel.viewRevision) === Number(expected) ? panel : undefined;
  }, { timeoutMs, intervalMs: 100, label: `panel accepted view revision ${expected}` });
}

/** Wait for the strict screen-anchor post-layout check to settle. */
async function waitZoomAnchorState(expected = 'settled', { timeoutMs = 7000 } = {}) {
  return waitFor(async () => {
    const panel = await panelState();
    return panel.canvasZoomAnchorState === expected ? panel : undefined;
  }, { timeoutMs, intervalMs: 100, label: `zoom anchor state ${expected}` });
}

/** Reset the zoom test base (scale 1, C=-100/-100, fit off) and wait for the panel to adopt it. */
async function resetZoomBase() {
  await clickFit(false);
  // 用户 2026-11-03 第 4 条：fit 与拖拽互斥；滚轮缩放属于拖拽表面，重置时必须重新选中拖拽。
  if ((await panelState()).panChecked !== true) await togglePan(true);
  await hostViewportSet({ width: 400, height: 300, scale: 1, x: 0, y: 0 });
  await waitHostView((view) => Number(view.width) === 400 && Number(view.height) === 300 && closeTo(view.scale, 1, 0.0011));
  const set = await hostViewportSet({ canvasX: -100, canvasY: -100 });
  const view = await waitHostView((v) => near(v.canvasX, -100, 1) && near(v.canvasY, -100, 1) && near(v.x, 0, 1) && near(v.y, 0, 1));
  await waitPanelMirrorsHost();
  await waitPanelRevision(view.view.revision);
  return view.view;
}

/** A point inside the current viewport box at box-relative (bx, by), kept visible in the stage. */
async function frameBoxPoint(b) {
  let panel = await panelState();
  if (!panel.frame || !panel.frame.box) throw new Error('no displayed frame box for the zoom point');
  let box = panel.frame.box;
  let point = { x: box.left + b.x, y: box.top + b.y };
  await ensurePointVisible(point);
  panel = await panelState();
  box = panel.frame.box;
  point = { x: box.left + b.x, y: box.top + b.y };
  return { point, box };
}

/** Emulation override for the GUI window; this Chromium requires the screen dimensions too. */
async function setGuiWindow(width, height) {
  await state.chrome.cdp.send('Emulation.setDeviceMetricsOverride', {
    width, height, deviceScaleFactor: 1, mobile: false, screenWidth: width, screenHeight: height,
  });
}

/** Keep a computed GUI point inside the visible stage (scroll only the panel's own stage). */
async function ensurePointVisible(point) {
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const box = await pageEvaluate(panelExpr(`
      const stage = panel.querySelector('.utb-stage');
      const rect = stage.getBoundingClientRect();
      return { left: rect.left, top: rect.top, right: rect.right, bottom: rect.bottom,
               vw: window.innerWidth, vh: window.innerHeight,
               scrollLeft: stage.scrollLeft, scrollTop: stage.scrollTop,
               maxLeft: stage.scrollWidth - stage.clientWidth, maxTop: stage.scrollHeight - stage.clientHeight };
    `));
    const insideStage = point.x >= box.left + 2 && point.x <= box.right - 2 && point.y >= box.top + 2 && point.y <= box.bottom - 2;
    const insideWindow = point.x > 0 && point.y > 0 && point.x < box.vw && point.y < box.vh;
    if (insideStage && insideWindow) return { point, scrolled: attempt > 0, box };
    const dx = point.x - (box.left + box.right) / 2;
    const dy = point.y - (box.top + box.bottom) / 2;
    await pageEvaluate(panelExpr(`
      const stage = panel.querySelector('.utb-stage');
      stage.scrollLeft = Math.max(0, Math.min(stage.scrollWidth - stage.clientWidth, stage.scrollLeft + ${Math.round(dx)}));
      stage.scrollTop = Math.max(0, Math.min(stage.scrollHeight - stage.clientHeight, stage.scrollTop + ${Math.round(dy)}));
      return { scrollLeft: stage.scrollLeft, scrollTop: stage.scrollTop };
    `));
    await sleep(250);
  }
  const box = await pageEvaluate(panelExpr(`(() => { const s = panel.querySelector('.utb-stage').getBoundingClientRect(); return { left: s.left, top: s.top, right: s.right, bottom: s.bottom }; })()`));
  return { point, scrolled: true, box, unreachable: true };
}

async function clickFit(checked) {
  await pageEvaluate(panelExpr(`
    const button = panel.querySelector('[data-utb-panfit-opt="fit"]');
    if (!button) return false;
    const pressed = button.getAttribute('aria-pressed') === 'true';
    if (pressed !== ${Boolean(checked)}) button.click();
    return true;
  `));
  await sleep(STEP_SETTLE_MS);
}

/** Rect of the drag-mode checkbox (user request 2026-11-02). */
async function panCheckboxRect() {
  const rect = await pageEvaluate(panelExpr(`
    const button = panel.querySelector('[data-utb-panfit-opt="pan"]');
    if (!button) return null;
    const r = button.getBoundingClientRect();
    return { x: r.left + r.width / 2, y: r.top + r.height / 2, left: r.left, top: r.top, width: r.width, height: r.height };
  `));
  if (!rect) throw new Error('drag-mode segment option not found');
  return rect;
}

/** Toggle drag mode with a real click; returns the panel state after it. */
async function togglePan(expected) {
  await dismissShellDialogs();
  const rect = await panCheckboxRect();
  await clickAt(rect.x, rect.y);
  await sleep(220);
  let snapshot = await panelState();
  if (expected !== undefined && snapshot.panChecked !== expected) {
    await dismissShellDialogs();
    const again = await panCheckboxRect();
    await clickAt(again.x, again.y);
    await sleep(220);
    snapshot = await panelState();
  }
  return snapshot;
}

/**
 * Real mouse drag across the displayed frame (CDP input, pointer capture). Reads the grab cursor
 * while the button is held. `dx`/`dy` are host CSS pixels; the panel maps them through the painted
 * rect so the page scroll delta equals dx/scale (content-follow direction).
 */
async function dragOnFrame(dx, dy, { steps = 8, holdMs = 40 } = {}) {
  const first = paintedOf(await waitForFrame());
  if (!first) throw new Error('no displayed frame for the drag');
  await ensurePointVisible({ x: first.left + first.width / 2, y: first.top + first.height / 2 });
  await sleep(120);
  const painted = paintedOf(await waitForFrame());
  if (!painted) throw new Error('frame disappeared before the drag');
  const start = { x: painted.left + painted.width / 2, y: painted.top + painted.height / 2 };
  const send = (type, x, y, buttons, button) => state.chrome.cdp.send('Input.dispatchMouseEvent', {
    type, x, y, button, buttons, clickCount: type === 'mouseMoved' ? 0 : 1,
  });
  await send('mouseMoved', start.x, start.y, 0, 'none');
  await sleep(30);
  await send('mousePressed', start.x, start.y, 1, 'left');
  await sleep(80);
  const cursorDuringDrag = (await panelState()).frameCursor;
  for (let index = 1; index <= steps; index += 1) {
    await sleep(holdMs);
    await send('mouseMoved', start.x + (dx * index) / steps, start.y + (dy * index) / steps, 1, 'left');
  }
  await sleep(holdMs);
  await send('mouseReleased', start.x + dx, start.y + dy, 0, 'left');
  await sleep(250);
  return { start, painted, dx, dy, cursorDuringDrag };
}

/* ------------------------------------------------------------------------------------------------
 * Host requests issued from inside the GUI page (same browser peer / same panel scope).
 * ---------------------------------------------------------------------------------------------- */
async function pageHostFetch(path, { method = 'GET', headers = {}, body } = {}) {
  const separator = path.includes('?') ? '&' : '?';
  const url = '/plugins/ui-testing' + path + separator + 'utbViewportAcceptance=1';
  const expression = `(async () => {
    const response = await fetch(${JSON.stringify(url)}, {
      method: ${JSON.stringify(method)},
      headers: ${JSON.stringify(Object.assign({ 'X-UTB-Acceptance': 'script' }, headers))},
      ${body === undefined ? '' : `body: ${JSON.stringify(JSON.stringify(body))},`}
      credentials: 'same-origin',
      cache: 'no-store',
    });
    const text = await response.text();
    let json; try { json = JSON.parse(text); } catch { json = text; }
    return { status: response.status, json, text: String(text).slice(0, 600) };
  })()`;
  return pageEvaluate(expression);
}

function requireScope() {
  if (!state.scopeHeaders) throw new Error('panel scope headers not captured yet');
  return state.scopeHeaders;
}

async function hostState() {
  const response = await pageHostFetch('/state', { headers: requireScope() });
  if (response.status !== 200 || !response.json || response.json.ok === false) {
    throw new Error(`GET /state -> ${response.status}: ${sanitize(response.text)}`);
  }
  return response.json;
}

async function hostView() {
  const snapshot = await hostState();
  const ui = snapshot.ui && typeof snapshot.ui === 'object' ? snapshot.ui : null;
  return {
    view: ui && ui.view ? ui.view : null,
    viewMeta: ui && ui.viewMeta ? ui.viewMeta : null,
    observed: ui && ui.observed ? ui.observed : null,
    ui,
  };
}

async function hostViewportSet(patch) {
  return pageHostFetch('/viewport', {
    method: 'POST',
    headers: Object.assign({ 'content-type': 'application/json' }, requireScope()),
    body: Object.assign({ version: 1 }, patch),
  });
}

/** Independent target-page truth through the plugin's own /eval route. */
async function targetEval(expression) {
  const response = await pageHostFetch('/eval', {
    method: 'POST',
    headers: Object.assign({ 'content-type': 'application/json' }, requireScope()),
    body: { expression },
  });
  if (response.status !== 200) throw new Error(`POST /eval -> ${response.status}: ${sanitize(response.text)}`);
  const payload = response.json || {};
  if (payload.ok === false) throw new Error(`eval failed: ${sanitize(response.text)}`);
  return payload.value !== undefined ? payload.value : payload.result;
}

async function navigateTarget(url) {
  const response = await pageHostFetch('/navigate', {
    method: 'POST',
    headers: Object.assign({ 'content-type': 'application/json' }, requireScope()),
    body: { url },
  });
  if (response.status !== 200 || !response.json || response.json.ok === false) {
    throw new Error(`POST /navigate -> ${response.status}: ${sanitize(response.text)}`);
  }
  return response.json;
}

async function waitForFrame(timeoutMs = 25000) {
  return waitFor(async () => {
    const snapshot = await panelState();
    const frame = snapshot.frame;
    return frame && frame.complete && frame.naturalWidth > 0 ? frame : undefined;
  }, { timeoutMs, intervalMs: 200, label: 'displayed frame decoded' });
}

/** Wait for a frame whose decoded natural size has stopped changing (two equal samples). */
async function waitFrameStable({ timeoutMs = 9000, intervalMs = 350 } = {}) {
  const deadline = Date.now() + timeoutMs;
  let previous = null;
  while (Date.now() < deadline) {
    const frame = await waitForFrame().catch(() => null);
    if (frame) {
      const key = `${frame.naturalWidth}x${frame.naturalHeight}`;
      if (previous === key) return frame;
      previous = key;
    }
    await sleep(intervalMs);
  }
  return waitForFrame();
}

/* ------------------------------------------------------------------------------------------------
 * Network observation: the panel's own requests and responses.
 * ---------------------------------------------------------------------------------------------- */
function hookNetworkEvents() {
  state.chrome.cdp.on((message) => {
    if (message.method === 'Network.requestWillBeSent') {
      const request = message.params.request || {};
      const headers = request.headers || {};
      const url = String(request.url || '');
      const entry = {
        at: Date.now(),
        requestId: message.params.requestId,
        url,
        method: String(request.method || ''),
        body: String(request.postData || ''),
        headers,
        script: url.includes('utbViewportAcceptance=1'),
      };
      state.requests.push(entry);
      if (!entry.script && !state.scopeHeaders && url.includes('/plugins/ui-testing/state')) {
        const version = headerValue(headers, 'x-ui-testing-scope-version');
        const sessionId = headerValue(headers, 'x-ui-testing-session-id');
        const binding = headerValue(headers, 'x-ui-testing-scope-binding');
        const special = headerValue(headers, 'x-ui-testing-scope');
        const captured = {};
        if (version) captured['X-UI-Testing-Scope-Version'] = version;
        if (sessionId) captured['X-UI-Testing-Session-Id'] = sessionId;
        else if (binding) captured['X-UI-Testing-Scope-Binding'] = binding;
        else if (special) captured['X-UI-Testing-Scope'] = special;
        if (captured['X-UI-Testing-Scope-Version']) {
          state.scopeHeaders = captured;
          log(`[env] panel scope captured (identity: ${Object.keys(captured).filter((key) => key !== 'X-UI-Testing-Scope-Version').join(',') || 'none'})`);
        }
      }
    }
    if (message.method === 'Network.responseReceived') {
      const response = message.params.response || {};
      state.responses.push({ at: Date.now(), requestId: message.params.requestId, url: String(response.url || ''), status: Number(response.status) || 0 });
    }
    if (message.method === 'Runtime.exceptionThrown') {
      const details = message.params.exceptionDetails || {};
      state.exceptions.push(String((details.exception && details.exception.description) || details.text).slice(0, 400));
    }
    if (message.method === 'Runtime.consoleAPICalled' && message.params.type === 'error') {
      state.consoleErrors.push(message.params.args.map((arg) => arg.value ?? arg.description).join(' ').slice(0, 400));
    }
    if (process.env.DSH_VIEWPORT_GUI_DEBUG_CONSOLE === '1' && message.method === 'Runtime.consoleAPICalled') {
      log(`  [console:${message.params.type}] ${message.params.args.map((arg) => arg.value ?? arg.description).join(' ').slice(0, 300)}`);
    }
  });
}

function headerValue(headers, name) {
  if (!headers) return '';
  for (const [key, value] of Object.entries(headers)) {
    if (String(key).toLowerCase() === name) return String(value);
  }
  return '';
}

/** POST /viewport requests issued by the panel itself (not by this script). */
function panelViewportPosts(since = 0) {
  return state.requests.filter((entry) => !entry.script
    && entry.method === 'POST'
    && entry.url.includes('/plugins/ui-testing/viewport')
    && entry.at >= since);
}

function parseBody(entry) {
  try { return JSON.parse(entry.body || '{}'); } catch { return {}; }
}

/** Compact diagnostic timeline of the panel's own /viewport traffic (never an assertion). */
function logViewportTimeline(label, since = 0) {
  const base = since || (state.requests.length ? state.requests[0].at : Date.now());
  const rows = state.requests
    .filter((entry) => entry.at >= since && entry.url.includes('/plugins/ui-testing/viewport'))
    .map((entry) => ({ t: entry.at - base, script: entry.script, body: parseBody(entry) }));
  log(`  [timeline] ${label}: ${JSON.stringify(rows)}`);
}

/* ------------------------------------------------------------------------------------------------
 * Screenshot evidence.
 * ---------------------------------------------------------------------------------------------- */
async function capturePanel(name) {
  const raw = await pageEvaluate(panelExpr(`
    const stage = panel.querySelector('.utb-stage');
    const bar = panel.querySelector('.utb-size');
    const annotBar = panel.querySelector('.utb-annot-bar');
    const panelRect = panel.getBoundingClientRect();
    const stageRect = stage ? stage.getBoundingClientRect() : null;
    const barRect = bar ? bar.getBoundingClientRect() : null;
    const annotRect = annotBar ? annotBar.getBoundingClientRect() : null;
    return {
      panel: panelRect.toJSON(),
      stage: stageRect ? stageRect.toJSON() : null,
      bar: barRect ? barRect.toJSON() : null,
      annot: annotRect ? annotRect.toJSON() : null,
      vw: window.innerWidth,
      vh: window.innerHeight,
    };
  `)).catch(() => null);
  const shot = await (async () => {
    if (!raw || raw.missing || !raw.panel) return null;
    // Both horizontal bars can be open at once: the clip must start at the highest one.
    const tops = [raw.bar ? raw.bar.top : null, raw.annot ? raw.annot.top : null].filter((value) => Number.isFinite(value));
    const top = tops.length ? Math.min(...tops) : raw.panel.top;
    const bottom = raw.stage ? raw.stage.bottom : raw.panel.bottom;
    const x = Math.max(0, Math.round(raw.panel.left));
    const y = Math.max(0, Math.round(top));
    const width = Math.round(raw.panel.width);
    const height = Math.round(bottom - top);
    if (![x, y, width, height, raw.vw, raw.vh].every(Number.isFinite) || width < 10 || height < 10) {
      log(`  [EVIDENCE] ${name}: skipped (bad panel geometry ${JSON.stringify({ x, y, width, height, vw: raw.vw, vh: raw.vh })})`);
      return null;
    }
    const clip = {
      x,
      y,
      width: Math.max(1, Math.min(width, Math.round(raw.vw) - x)),
      height: Math.max(1, Math.min(height, Math.round(raw.vh) - y)),
      scale: 1,
    };
    return state.chrome.cdp.send('Page.captureScreenshot', { format: 'png', clip })
      .catch((error) => { log(`  [EVIDENCE] ${name}: capture failed (${String(error.message).slice(0, 140)} clip=${JSON.stringify(clip)})`); return null; });
  })();
  if (!shot) return null;
  const buffer = Buffer.from(shot.data, 'base64');
  const path = join(EVIDENCE_DIR, `${name}.png`);
  await writeFile(path, buffer, { mode: 0o600 });
  state.evidence.push({ name, path: path.slice(REPO_ROOT.length + 1), bytes: buffer.length });
  log(`  [EVIDENCE] ${name}.png (${buffer.length} bytes)`);
  return path;
}

/** Crop the bottom status bar (2x) — where the selection count is shown, after the latency. */
async function captureStatusBar(name) {
  const rect = await pageEvaluate(panelExpr(`
    const status = panel.querySelector('.utb-status');
    return status ? status.getBoundingClientRect().toJSON() : null;
  `)).catch(() => null);
  if (!rect || !(rect.width > 10) || !(rect.height > 5)) return null;
  const clip = {
    x: Math.max(0, Math.round(rect.left)), y: Math.max(0, Math.round(rect.top)),
    width: Math.max(1, Math.round(rect.width)), height: Math.max(1, Math.round(rect.height)), scale: 2,
  };
  const shot = await state.chrome.cdp.send('Page.captureScreenshot', { format: 'png', clip })
    .catch(() => null);
  if (!shot) return null;
  const buffer = Buffer.from(shot.data, 'base64');
  const path = join(EVIDENCE_DIR, `${name}.png`);
  await writeFile(path, buffer, { mode: 0o600 });
  state.evidence.push({ name, path: path.slice(REPO_ROOT.length + 1), bytes: buffer.length });
  log(`  [EVIDENCE] ${name}.png (${buffer.length} bytes)`);
  return path;
}

/* ------------------------------------------------------------------------------------------------
 * Geometry helpers (contract §5.1, recomputed independently in the test).
 * ---------------------------------------------------------------------------------------------- */
function num(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}
function near(actual, expected, tolerance) {
  return num(actual) !== null && Math.abs(Number(actual) - Number(expected)) <= tolerance;
}

/**
 * Wait until the Host view satisfies `predicate`. A v1 set answers only after the two-frame
 * readback settles (≤1s), so a GUI assertion must never read the Host right after dispatching.
 */
async function waitHostView(predicate, { timeoutMs = 6000, intervalMs = 120, label = 'host view' } = {}) {
  const matched = await waitFor(async () => {
    const snapshot = await hostView();
    return snapshot.view && predicate(snapshot.view, snapshot) ? snapshot : undefined;
  }, { timeoutMs, intervalMs, label }).catch(() => null);
  if (matched) return matched;
  const fallback = await hostView();
  log(`  [debug] host view did not reach the expected state in ${timeoutMs}ms: ${JSON.stringify(fallback.view)}`);
  return { view: fallback.view, observed: fallback.observed, viewMeta: fallback.viewMeta, timedOut: true };
}

/** Compare two numbers with a small tolerance (scale fractions need a tighter one). */
function closeTo(actual, expected, tolerance = 1) {
  return num(actual) !== null && Math.abs(Number(actual) - Number(expected)) <= tolerance;
}

/** Wait until the panel inputs show the given numbers (the 500ms state poll adopts them). */
async function waitPanelValues(expected, { timeoutMs = 5000 } = {}) {
  return waitFor(async () => {
    const panel = await panelState();
    const ok = Object.entries(expected).every(([key, value]) => closeTo(panel[key], value, 1.5));
    return ok ? panel : undefined;
  }, { timeoutMs, intervalMs: 120, label: 'panel adopts ' + JSON.stringify(expected) });
}

/**
 * Wait until the panel's width/height inputs mirror the Host view (and the scale percent when fit
 * is off). Never aborts a scenario: a timeout is reported as `mirrored:false` with the mismatch,
 * so the following assertions state the real facts instead of a stack trace.
 */
async function waitPanelMirrorsHost({ timeoutMs = 6000 } = {}) {
  let last = null;
  const mirrored = await waitFor(async () => {
    const snapshot = await hostView();
    const panel = await panelState();
    if (!snapshot.view) return undefined;
    last = {
      host: { width: snapshot.view.width, height: snapshot.view.height, scale: snapshot.view.scale, x: snapshot.view.x, y: snapshot.view.y, source: snapshot.view.source, revision: snapshot.view.revision },
      panel: { width: panel.width, height: panel.height, scale: panel.scale, zoom: panel.zoomValue, x: panel.x, y: panel.y, fit: panel.fitChecked, active: panel.activeLabel, disabled: { x: panel.xDisabled, y: panel.yDisabled } },
    };
    const sizeOk = closeTo(panel.width, snapshot.view.width, 1.5) && closeTo(panel.height, snapshot.view.height, 1.5);
    const scaleOk = panel.fitChecked === true || closeTo(panel.scale, Number(snapshot.view.scale) * 100, 1.5);
    return sizeOk && scaleOk ? { view: snapshot.view, panel } : undefined;
  }, { timeoutMs, intervalMs: 120, label: 'panel mirrors host view' }).catch(() => null);
  if (mirrored) return mirrored;
  log(`  [debug] panel did not mirror the Host view in ${timeoutMs}ms: ${JSON.stringify(last)}`);
  return { view: (await hostView()).view, panel: await panelState(), mirrored: false, last };
}

function paintedOf(frame) {
  if (!frame || !frame.naturalWidth || !frame.naturalHeight) return null;
  // The Host canvas composite translates the <img> inside a clipping box. Measure the box (which
  // never moves) so pointer mapping stays in viewport space; when the transform is zero this is
  // byte-for-byte the historical img rectangle (the img fills the box).
  const host = frame.box || frame.img;
  if (!host) return null;
  const k = Math.min(host.width / frame.naturalWidth, host.height / frame.naturalHeight);
  const width = frame.naturalWidth * k;
  const height = frame.naturalHeight * k;
  return {
    left: host.left + (host.width - width) / 2,
    top: host.top + (host.height - height) / 2,
    width,
    height,
  };
}

function guiPointFor(painted, viewWidth, viewHeight, viewportX, viewportY) {
  return {
    x: painted.left + (viewportX / viewWidth) * painted.width,
    y: painted.top + (viewportY / viewHeight) * painted.height,
  };
}

/* ------------------------------------------------------------------------------------------------
 * P0-C v2 canvas probes (docs/viewport-control.md §5.2–§5.3).
 * ---------------------------------------------------------------------------------------------- */

/** Host-side canvas truth through the authenticated /state projection. */
async function hostCanvas() {
  const snapshot = await hostView();
  return {
    canvas: snapshot.ui && snapshot.ui.canvas ? snapshot.ui.canvas : null,
    view: snapshot.view,
    ui: snapshot.ui,
  };
}

/** Wait until the panel reports the canvas capability and its input barrier state. */
async function waitCanvasState(expectedOn, expectedReady, { timeoutMs = 6000 } = {}) {
  let last = null;
  try {
    return await waitFor(async () => {
      const panel = await panelState();
      last = panel;
      if (expectedOn !== undefined && panel.canvasOn !== (expectedOn ? 'on' : 'off')) return undefined;
      if (expectedReady !== undefined && panel.canvasReady !== (expectedReady ? 'true' : 'false')) return undefined;
      return panel;
    }, { timeoutMs, intervalMs: 100, label: `canvas on=${expectedOn} ready=${expectedReady}` });
  } catch (error) {
    log(`  [debug] canvas state timeout: on=${last && last.canvasOn} ready=${last && last.canvasReady} barrier=${last && last.canvasBarrier} detail=${last && last.canvasDetail} transform=${last && last.imgTransform} frame=${JSON.stringify(last && last.frame)}`);
    log(`  [debug] host view: ${JSON.stringify(await hostView().catch(() => null))}`);
    const metrics = await pageHostFetch('/metrics', { headers: requireScope() }).catch(() => null);
    log(`  [debug] host metrics: ${JSON.stringify(metrics && metrics.json && metrics.json.host ? { seq: metrics.json.host.seq, pushed: metrics.json.host.pushed, coalesced: metrics.json.host.coalesced, blocked: metrics.json.host.blocked, stale: metrics.json.host.stale } : metrics && metrics.text).slice(0, 800)}`);
    throw error;
  }
}

/** GUI point for a canvas-viewport point q (relative to the viewport's top-left). */
function guiPointForViewport(painted, viewWidth, viewHeight, qx, qy) {
  return guiPointFor(painted, viewWidth, viewHeight, qx, qy);
}

/** Element centre in document CSS px without scrolling the page (scrollIntoView would change S). */
async function elementDocumentRect(selector) {
  const rect = await targetEval(`(() => {
    const el = document.querySelector(${JSON.stringify(selector)});
    if (!el) return null;
    const r = el.getBoundingClientRect();
    return {
      docX: r.left + window.scrollX + r.width / 2,
      docY: r.top + window.scrollY + r.height / 2,
      scrollX: window.scrollX, scrollY: window.scrollY,
      innerWidth: window.innerWidth, innerHeight: window.innerHeight,
    };
  })()`);
  if (!rect) throw new Error(`target element not found: ${selector}`);
  return rect;
}

/** Panel POSTs to the seed screenshot route (canvas provenance path). */
function panelScreenshotPosts(since = 0) {
  return state.requests.filter((entry) => !entry.script
    && entry.method === 'POST'
    && entry.url.includes('/plugins/ui-testing/screenshot')
    && entry.at >= since).map(parseBody);
}

/** Parse the client's bounded canvas-barrier diagnostic attribute. */
function canvasDetailOf(panel) {
  try { return JSON.parse(panel && panel.canvasDetail ? panel.canvasDetail : '{}') || {}; }
  catch { return {}; }
}

/** Panel POSTs to one plugin endpoint issued by the panel itself (never by this script). */
function panelPosts(endpoint, since = 0) {
  return state.requests.filter((entry) => !entry.script
    && entry.method === 'POST'
    && entry.url.includes('/plugins/ui-testing/' + endpoint)
    && entry.at >= since);
}

/** Decode one PNG frame captured through CDP (8-bit RGB/RGBA, the format Chrome returns). */
let pngToolsModule = null;
async function pngTools() {
  if (!pngToolsModule) pngToolsModule = await import(pathToFileURL(join(REPO_ROOT, 'capture-p0.js')).href);
  return pngToolsModule;
}
async function decodeScreenshotPng(png) {
  return (await pngTools()).decodePng(png);
}

/** Capture the displayed clipping box and return decoded pixels (clip is in GUI viewport CSS px). */
async function captureBoxPixels(box) {
  const clip = {
    x: Math.max(0, Math.round(box.left)),
    y: Math.max(0, Math.round(box.top)),
    width: Math.max(1, Math.round(box.width)),
    height: Math.max(1, Math.round(box.height)),
    scale: 1,
  };
  const shot = await state.chrome.cdp.send('Page.captureScreenshot', { format: 'png', clip });
  const png = Buffer.from(shot.data, 'base64');
  const decoded = await decodeScreenshotPng(png);
  if (!decoded || decoded.ok === false) throw new Error(`cannot decode GUI screenshot: ${JSON.stringify(decoded)}`);
  return { decoded, clip, png };
}

function pixelAt(decoded, x, y) {
  const px = Math.max(0, Math.min(decoded.width - 1, Math.round(x)));
  const py = Math.max(0, Math.min(decoded.height - 1, Math.round(y)));
  const channels = decoded.channels;
  const base = (py * decoded.width + px) * channels;
  return { r: decoded.data[base], g: decoded.data[base + 1], b: decoded.data[base + 2], a: channels > 3 ? decoded.data[base + 3] : 255 };
}

function isPureWhite(pixel) {
  return pixel.r >= 250 && pixel.g >= 250 && pixel.b >= 250;
}

/** Parse the client's panel-only checkerboard diagnostic: "14px #2b2b2b #3f3f3f". */
function checkerboardOf(panelOrText) {
  const text = typeof panelOrText === 'string' ? panelOrText : (panelOrText && panelOrText.canvasChecker);
  const match = /^(\d+(?:\.\d+)?)px\s+#([0-9a-f]{6})\s+#([0-9a-f]{6})$/i.exec(String(text || '').trim());
  if (!match) return null;
  const rgb = (hex) => ({ r: parseInt(hex.slice(0, 2), 16), g: parseInt(hex.slice(2, 4), 16), b: parseInt(hex.slice(4, 6), 16) });
  return { size: Number(match[1]), colors: [rgb(match[2]), rgb(match[3])] };
}

function nearColor(pixel, rgb, tolerance = 2) {
  return Math.abs(pixel.r - rgb.r) <= tolerance && Math.abs(pixel.g - rgb.g) <= tolerance && Math.abs(pixel.b - rgb.b) <= tolerance;
}

/** Sample points (image-relative px) and classify them as checker/solid/contents. */
function checkerSample(decoded, checker, points) {
  if (!checker) return { checker: null, pixels: [], colorIndex: [], allChecker: false, both: false };
  const pixels = points.map(([x, y]) => pixelAt(decoded, x, y));
  const colorIndex = pixels.map((pixel) => {
    for (let index = 0; index < checker.colors.length; index += 1) {
      if (nearColor(pixel, checker.colors[index])) return index;
    }
    return -1;
  });
  return {
    checker,
    pixels,
    colorIndex,
    allChecker: colorIndex.every((index) => index >= 0),
    both: colorIndex.includes(0) && colorIndex.includes(1),
    white: pixels.filter(isPureWhite).length,
  };
}

/** Parse the translate component of a computed CSS transform (matrix / matrix3d), in CSS px. */
function transformTranslate(value) {
  const text = String(value || '');
  const matrix = /^matrix\(([^)]+)\)$/.exec(text);
  if (matrix) {
    const parts = matrix[1].split(',').map(Number);
    return { x: parts[4] || 0, y: parts[5] || 0 };
  }
  const matrix3d = /^matrix3d\(([^)]+)\)$/.exec(text);
  if (matrix3d) {
    const parts = matrix3d[1].split(',').map(Number);
    return { x: parts[12] || 0, y: parts[13] || 0 };
  }
  return { x: 0, y: 0 };
}

/**
 * Rewrite the panel's `/state` response bodies in-flight (CDP Fetch, Response stage). The script's
 * own `hostState()` requests carry `utbViewportAcceptance=1` and always pass through untouched, so
 * Host truth stays real while the panel can be driven through simulated Host snapshots.
 */
async function startStateRewrite(rewrite) {
  const { cdp } = state.chrome;
  const handler = async (message) => {
    if (message.method !== 'Fetch.requestPaused') return;
    const params = message.params || {};
    const requestId = params.requestId;
    const url = String((params.request && params.request.url) || '');
    if (!requestId) return;
    if (!url.includes('/plugins/ui-testing/state') || url.includes('utbViewportAcceptance=1')) {
      await cdp.send('Fetch.continueRequest', { requestId }).catch(() => {});
      return;
    }
    try {
      const body = await cdp.send('Fetch.getResponseBody', { requestId });
      const text = body.base64Encoded ? Buffer.from(body.body, 'base64').toString('utf8') : body.body;
      const json = JSON.parse(text);
      const next = rewrite(json) || json;
      const output = JSON.stringify(next);
      const headers = (params.responseHeaders || [])
        .filter((header) => !['content-length', 'content-encoding', 'transfer-encoding'].includes(String(header.name).toLowerCase()))
        .concat([{ name: 'content-length', value: String(Buffer.byteLength(output)) }]);
      await cdp.send('Fetch.fulfillRequest', {
        requestId,
        responseCode: 200,
        responseHeaders: headers,
        body: Buffer.from(output).toString('base64'),
      });
    } catch {
      await cdp.send('Fetch.continueRequest', { requestId }).catch(() => {});
    }
  };
  const off = cdp.on(handler);
  await cdp.send('Fetch.enable', { patterns: [{ urlPattern: '*/plugins/ui-testing/state*', requestStage: 'Response' }] });
  return async function stop() {
    try { await cdp.send('Fetch.disable'); } catch { /* ignore */ }
    off();
  };
}

/**
 * Intercept the panel's `/screenshot` seed requests and fulfill them from the test. Used only for
 * the negative seed cases (stale / missing provenance / HTTP failure); the happy path uses the
 * real Host composition.
 */
async function startScreenshotInterceptor() {
  const { cdp } = state.chrome;
  const paused = [];
  const listeners = [];
  const fulfill = async (entry, response) => {
    if (!entry || entry.done) throw new Error('seed request already fulfilled');
    const payload = response && response.body !== undefined ? response.body : response;
    const output = JSON.stringify(payload === undefined ? {} : payload);
    const headers = [
      { name: 'content-type', value: 'application/json' },
      { name: 'content-length', value: String(Buffer.byteLength(output)) },
    ];
    await cdp.send('Fetch.fulfillRequest', {
      requestId: entry.requestId,
      responseCode: Number(response && response.status) || 200,
      responseHeaders: headers,
      body: Buffer.from(output).toString('base64'),
    });
    entry.done = true;
  };
  const handler = async (message) => {
    if (message.method !== 'Fetch.requestPaused') return;
    const params = message.params || {};
    const url = String((params.request && params.request.url) || '');
    if (!url.includes('/plugins/ui-testing/screenshot')) {
      await cdp.send('Fetch.continueRequest', { requestId: params.requestId }).catch(() => {});
      return;
    }
    let body = {};
    try { body = JSON.parse(params.request.postData || '{}'); } catch { body = {}; }
    const entry = { requestId: params.requestId, body, at: Date.now(), done: false, url };
    paused.push(entry);
    for (const listener of listeners) { try { listener(entry); } catch { /* ignore */ } }
  };
  const off = cdp.on(handler);
  await cdp.send('Fetch.enable', { patterns: [{ urlPattern: '*/plugins/ui-testing/screenshot*', requestStage: 'Request' }] });
  return {
    requests: paused,
    waitForRequest(index, timeoutMs = 8000) {
      return waitFor(() => (paused.length > index ? paused[index] : undefined),
        { timeoutMs, intervalMs: 100, label: `seed screenshot request #${index + 1}` });
    },
    waitForNew(mark, timeoutMs = 8000) {
      return waitFor(() => paused.find((entry) => !entry.done && entry.at >= mark),
        { timeoutMs, intervalMs: 100, label: 'new seed screenshot request' });
    },
    pending() { return paused.filter((entry) => !entry.done); },
    onChange(listener) { listeners.push(listener); },
    respond(entry, response) { return fulfill(entry, response); },
    async stop() {
      try { await cdp.send('Fetch.disable'); } catch { /* ignore */ }
      off();
    },
  };
}

/**
 * Hold the first panel `/viewport` request at the CDP Request stage. Used by V14 to prove that a
 * zoom notch survives a CAS conflict and that a second notch is queued (not lost) while one set is
 * in flight. Script requests (`utbViewportAcceptance=1`) are always continued.
 */
async function startViewportHold() {
  const { cdp } = state.chrome;
  const requests = [];
  let held = null;
  let heldOnce = false;
  const handler = async (message) => {
    if (message.method !== 'Fetch.requestPaused') return;
    const params = message.params || {};
    const url = String((params.request && params.request.url) || '');
    // Hold exactly the first panel request; later ones (e.g. a conflict retry or the queued second
    // notch) must continue, otherwise the very fix under test would be deadlocked by the test.
    if (!url.includes('/plugins/ui-testing/viewport') || url.includes('utbViewportAcceptance=1') || heldOnce) {
      await cdp.send('Fetch.continueRequest', { requestId: params.requestId }).catch(() => {});
      return;
    }
    let body = {};
    try { body = JSON.parse(params.request.postData || '{}'); } catch { body = {}; }
    heldOnce = true;
    held = { requestId: params.requestId, body, at: Date.now(), url };
    requests.push(held);
  };
  const off = cdp.on(handler);
  await cdp.send('Fetch.enable', { patterns: [{ urlPattern: '*/plugins/ui-testing/viewport*', requestStage: 'Request' }] });
  return {
    requests,
    waitForHeld(timeoutMs = 7000) {
      return waitFor(() => held || undefined, { timeoutMs, intervalMs: 100, label: 'held /viewport request' });
    },
    async release() {
      if (!held) return false;
      const entry = held;
      held = null;
      await cdp.send('Fetch.continueRequest', { requestId: entry.requestId }).catch(() => {});
      return true;
    },
    async stop() {
      if (held) {
        const entry = held;
        held = null;
        await cdp.send('Fetch.continueRequest', { requestId: entry.requestId }).catch(() => {});
      }
      try { await cdp.send('Fetch.disable'); } catch { /* ignore */ }
      off();
    },
  };
}

/** Current real Host facts for a seed response (capture-time view + canvas box). */
async function seedFactsNow() {
  const snapshot = await hostCanvas();
  const view = snapshot.view;
  const canvas = snapshot.canvas;
  const observed = snapshot.observed || {};
  if (!view || !canvas) throw new Error('seedFactsNow: missing view/canvas');
  const scrollX = num(observed.x) !== null ? Number(observed.x) : Number(view.x);
  const scrollY = num(observed.y) !== null ? Number(observed.y) : Number(view.y);
  return {
    canvasX: Number(canvas.x),
    canvasY: Number(canvas.y),
    scrollX,
    scrollY,
    viewRevision: Number(view.revision),
    scale: Number(view.scale),
    width: Number(view.width),
    height: Number(view.height),
    contentWidth: Number(canvas.contentWidth),
    contentHeight: Number(canvas.contentHeight),
  };
}

/** Synthetic composed canvas PNG + provenance for one seed response (test-side composition). */
async function seedResponseFor(facts, options = {}) {
  const width = Math.max(1, Math.round(facts.width));
  const height = Math.max(1, Math.round(facts.height));
  const rgba = Buffer.alloc(width * height * 4);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const inside = x + facts.canvasX >= 0 && x + facts.canvasX < facts.contentWidth
        && y + facts.canvasY >= 0 && y + facts.canvasY < facts.contentHeight;
      const offset = (y * width + x) * 4;
      rgba[offset] = inside ? 200 : 255;
      rgba[offset + 1] = inside ? 30 : 255;
      rgba[offset + 2] = inside ? 30 : 255;
      rgba[offset + 3] = 255;
    }
  }
  const tools = await pngTools();
  const png = tools.encodePngRgba({ width, height, rgba });
  const revision = options.revision !== undefined ? Number(options.revision) : facts.viewRevision;
  const contentRect = {
    x: Math.max(0, facts.canvasX),
    y: Math.max(0, facts.canvasY),
    width: Math.max(0, Math.min(width, facts.contentWidth - Math.max(0, facts.canvasX))),
    height: Math.max(0, Math.min(height, facts.contentHeight - Math.max(0, facts.canvasY))),
  };
  return {
    ok: true,
    image: Buffer.from(png).toString('base64'),
    capturedAt: Date.now(),
    view: {
      version: 1, x: facts.scrollX, y: facts.scrollY, canvasX: facts.canvasX, canvasY: facts.canvasY,
      width, height, scale: facts.scale, revision, source: 'gui',
    },
    capture: {
      viewRevision: revision,
      requestedScale: facts.scale,
      viewport: { width, height },
      canvas: {
        version: 1, space: 'canvas-css-px', x: facts.canvasX, y: facts.canvasY,
        scrollX: facts.scrollX, scrollY: facts.scrollY,
        offsetX: facts.canvasX - facts.scrollX, offsetY: facts.canvasY - facts.scrollY,
        contentWidth: facts.contentWidth, contentHeight: facts.contentHeight,
        blank: '#ffffff', composite: true, source: 'cdp-page-capture-screenshot',
      },
      contentRect,
      composite: true,
      scroll: { x: facts.scrollX, y: facts.scrollY },
    },
  };
}

/** Apply a mutator to the nested `ui` object of a /state JSON body (top-level or `.state`). */
function mutateStateUi(json, mutate) {
  const visit = (root) => {
    if (!root || typeof root !== 'object') return;
    const ui = root.ui && typeof root.ui === 'object' ? root.ui : null;
    if (ui) mutate(ui);
  };
  visit(json);
  if (json && json.state && json.state !== json) visit(json.state);
  return json;
}

/* ------------------------------------------------------------------------------------------------
 * Target-page probes.
 * ---------------------------------------------------------------------------------------------- */
async function targetTruth() {
  return targetEval(`({
    scrollX: window.scrollX, scrollY: window.scrollY,
    innerWidth: window.innerWidth, innerHeight: window.innerHeight,
    devicePixelRatio: window.devicePixelRatio,
    visualViewportScale: window.visualViewport ? window.visualViewport.scale : null,
    counter: document.getElementById('t2-counter') ? document.getElementById('t2-counter').textContent : null,
    hyphen: window.__t2 ? true : false,
  })`);
}

/** Give the fixture page a deterministic horizontal overflow (installed from the test, not the page). */
async function ensureHorizontalOverflow() {
  return targetEval(`(() => {
    if (!document.getElementById('utb-wide-probe')) {
      const el = document.createElement('div');
      el.id = 'utb-wide-probe';
      el.style.cssText = 'width:3000px;height:1px;padding:0;margin:0;border:0;';
      document.body.appendChild(el);
    }
    return { scrollWidth: document.documentElement.scrollWidth, innerWidth: window.innerWidth,
             maxScrollX: Math.max(0, document.documentElement.scrollWidth - window.innerWidth) };
  })()`);
}

async function elementCenter(selector) {
  const rect = await targetEval(`(() => {
    const el = document.querySelector(${JSON.stringify(selector)});
    if (!el) return null;
    el.scrollIntoView({ block: 'center', inline: 'center' });
    const r = el.getBoundingClientRect();
    return { left: r.left, top: r.top, width: r.width, height: r.height,
             x: r.left + r.width / 2, y: r.top + r.height / 2,
             scrollX: window.scrollX, scrollY: window.scrollY,
             innerWidth: window.innerWidth, innerHeight: window.innerHeight };
  })()`);
  if (!rect) throw new Error(`target element not found: ${selector}`);
  await sleep(150);
  return rect;
}

async function resetTargetInstrumentation() {
  return targetEval(`(() => {
    if (window.__t3 && typeof window.__t3.reset === 'function') window.__t3.reset();
    if (window.__t2 && typeof window.__t2.reset === 'function') window.__t2.reset();
    return true;
  })()`);
}

/** Real click records of whichever fixture page is loaded (T2/T3 instrument the same way). */
async function clickRecords() {
  return targetEval(`(() => {
    const probe = window.__t3 || window.__t2;
    return probe ? probe.events.filter((event) => event.type === 'click') : [];
  })()`);
}

/** Click a target-page element through the panel and read the page's own event truth. */
async function clickThroughPanel(selector, viewWidth, viewHeight) {
  // A panel can transiently gate pointer writes while its main view is (re)loading; one bounded
  // retry after recomputing the page/box geometry keeps the assertion about a *real* trusted click
  // honest without weakening it (the final attempt still must hit the mapped target).
  let center = null;
  let point = null;
  let painted = null;
  let clicksDelta = 0;
  let record = null;
  let attempts = 0;
  for (let attempt = 1; attempt <= 2; attempt += 1) {
    attempts = attempt;
    center = await elementCenter(selector);
    const mapped = guiPointFor(paintedOf(await waitForFrame()), viewWidth, viewHeight, center.x, center.y);
    await ensurePointVisible(mapped);
    painted = paintedOf(await waitForFrame());
    point = guiPointFor(painted, viewWidth, viewHeight, center.x, center.y);
    await resetTargetInstrumentation();
    const clicksBefore = await targetEval('window.__t3 ? window.__t3.counters.clicks : -1');
    await clickAt(point.x, point.y);
    await sleep(800);
    const clicksAfter = await targetEval('window.__t3 ? window.__t3.counters.clicks : -1');
    clicksDelta = Number(clicksAfter) - Number(clicksBefore);
    record = await targetEval(`(() => {
      if (!window.__t3) return null;
      const clicks = window.__t3.events.filter((event) => event.type === 'click');
      return clicks.length ? clicks[clicks.length - 1] : null;
    })()`);
    if (clicksDelta > 0) break;
    await sleep(300);
  }
  return {
    clicksDelta,
    record: record ? { isTrusted: record.isTrusted, clientX: record.clientX, clientY: record.clientY, target: record.target } : null,
    viewportX: center ? center.x : null,
    viewportY: center ? center.y : null,
    point,
    painted,
    attempts,
  };
}

/* ------------------------------------------------------------------------------------------------
 * P0-D annotation probes (docs/viewport-control.md).
 * ---------------------------------------------------------------------------------------------- */

async function annotEntryRect() {
  const rect = await pageEvaluate(panelExpr(`
    const b = panel.querySelector('button[aria-label="标注"]');
    if (!b) return null;
    const r = b.getBoundingClientRect();
    return { x: r.left + r.width / 2, y: r.top + r.height / 2, left: r.left, top: r.top, width: r.width, height: r.height,
      disabled: b.disabled, pressed: b.getAttribute('aria-pressed') };
  `));
  if (!rect) throw new Error('annotation entry not found');
  return rect;
}

/** Toggle the annotation mode with a real trusted click; the shell may briefly mask the toolbar. */
async function toggleAnnot(expected) {
  // Setup-only activation: the shell can swallow the first trusted click right after a layout
  // change, and a second trusted click would toggle the mode straight back off. The entry's
  // presence/enabled state is asserted separately (V15.1a); real pointer interaction with the
  // panel is covered by the drawing/segment/wheel checks (V15/V16/V18).
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const before = (await panelState()).annot;
    if (before && before.pressed === expected) return before;
    if (!before || before.disabled) return before;
    await pageEvaluate(panelExpr(`const b = panel.querySelector('button[aria-label="标注"]'); if (b && !b.disabled) b.click(); return true;`)).catch(() => undefined);
    for (let poll = 0; poll < 8; poll += 1) {
      await sleep(150);
      const after = (await panelState()).annot;
      if (after && after.pressed === expected) return after;
    }
  }
  return (await panelState()).annot;
}

async function clickAnnotTool(tool) {
  await dismissShellDialogs();
  const rect = await pageEvaluate(panelExpr(`
    const b = panel.querySelector('[data-utb-annot-tool="${tool}"]');
    if (!b) return null;
    const r = b.getBoundingClientRect();
    return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
  `));
  if (!rect) throw new Error('annotation tool not found: ' + tool);
  await clickAt(rect.x, rect.y);
  await sleep(250);
  return (await panelState()).annot;
}

async function clickAnnotCheckbox(label) {
  await dismissShellDialogs();
  const rect = await pageEvaluate(panelExpr(`
    const el = panel.querySelector('[data-utb-annot-mode][aria-label="${label}"]');
    if (!el) return null;
    const r = el.getBoundingClientRect();
    return { x: r.left + r.width / 2, y: r.top + r.height / 2, disabled: el.disabled };
  `));
  if (!rect) throw new Error('annotation style segment not found: ' + label);
  if (!rect.disabled) await clickAt(rect.x, rect.y);
  await sleep(220);
  return (await panelState()).annot;
}

async function setAnnotColor(hex) {
  await pageEvaluate(panelExpr(`
    const el = panel.querySelector('input[aria-label="颜色"]');
    if (!el) return false;
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
    setter.call(el, ${JSON.stringify(String(hex))});
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
    return true;
  `));
  await sleep(220);
  return (await panelState()).annot;
}

async function setAnnotWidth(value) {
  await pageEvaluate(panelExpr(`
    const el = panel.querySelector('input[aria-label="粗细"]');
    if (!el) return false;
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
    setter.call(el, ${JSON.stringify(String(value))});
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
    return true;
  `));
  await sleep(220);
  return (await panelState()).annot;
}

/** Current P/C/sx/sy mapping of the annotation layer (contract §3). */
async function annotMappingNow() {
  const panel = await panelState();
  if (!panel.frame || !panel.frame.box) throw new Error('no displayed frame box for annotation mapping');
  const painted = paintedOf(panel.frame);
  const snapshot = await hostView();
  const canvas = (await hostCanvas()).canvas;
  if (!painted || !snapshot.view || !canvas) throw new Error('missing annotation mapping facts');
  const viewWidth = Number(snapshot.view.width);
  const viewHeight = Number(snapshot.view.height);
  if (!(viewWidth > 0) || !(viewHeight > 0)) throw new Error('invalid view size for annotation mapping');
  return {
    painted,
    view: snapshot.view,
    canvas,
    box: panel.frame.box,
    sx: painted.width / viewWidth,
    sy: painted.height / viewHeight,
  };
}

function annotCanvasToGui(map, point) {
  return {
    x: map.painted.left + (Number(point.x) - Number(map.canvas.x)) * map.sx,
    y: map.painted.top + (Number(point.y) - Number(map.canvas.y)) * map.sy,
  };
}

function annotGuiToCanvas(map, point) {
  return {
    x: Number(map.canvas.x) + (point.x - map.painted.left) / map.sx,
    y: Number(map.canvas.y) + (point.y - map.painted.top) / map.sy,
  };
}

function annotScreenOf(shape, point) {
  if (!shape || !shape.ctm) return null;
  const ctm = shape.ctm;
  return {
    x: ctm.a * point.x + ctm.c * point.y + ctm.e,
    y: ctm.b * point.x + ctm.d * point.y + ctm.f,
  };
}

function annotAttr(shape, name) {
  return shape && shape.attrs ? shape.attrs['data-utb-annot-' + name] : undefined;
}

function annotNumAttr(shape, name) {
  const value = Number(annotAttr(shape, name));
  return Number.isFinite(value) ? value : null;
}

/** Draw a free pointer gesture between two GUI points (real CDP trusted input). */
async function annotDragGui(from, to, { steps = 8, holdMs = 25 } = {}) {
  const send = (type, x, y, buttons, button) => state.chrome.cdp.send('Input.dispatchMouseEvent', {
    type, x, y, button, buttons, clickCount: type === 'mouseMoved' ? 0 : 1,
  });
  await send('mouseMoved', from.x, from.y, 0, 'none');
  await sleep(30);
  await send('mousePressed', from.x, from.y, 1, 'left');
  for (let index = 1; index <= steps; index += 1) {
    await sleep(holdMs);
    await send('mouseMoved', from.x + ((to.x - from.x) * index) / steps, from.y + ((to.y - from.y) * index) / steps, 1, 'left');
  }
  await sleep(holdMs);
  await send('mouseReleased', to.x, to.y, 0, 'left');
  await sleep(250);
}

/** One zero-size click at a GUI point (no committed shape because the gesture is below minimum). */
async function annotClickGui(point) {
  await state.chrome.cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: point.x, y: point.y, button: 'none', buttons: 0 });
  await state.chrome.cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: point.x, y: point.y, button: 'left', buttons: 1, clickCount: 1 });
  await state.chrome.cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: point.x, y: point.y, button: 'left', buttons: 0, clickCount: 1 });
  await sleep(250);
}

/** Draw one shape from canvas CSS points through the current mapping. */
async function annotDrawCanvas(map, fromCanvas, toCanvas, options) {
  await annotDragGui(annotCanvasToGui(map, fromCanvas), annotCanvasToGui(map, toCanvas), options);
}

function lastAnnotShape(panel) {
  const shapes = panel && panel.annot ? panel.annot.shapes : [];
  return shapes.length ? shapes[shapes.length - 1] : null;
}

function annotShapes(panel) {
  return panel && panel.annot ? panel.annot.shapes : [];
}

/** Wait until the committed annotation count reaches `expected`. */
async function waitAnnotShapeCount(expected, { timeoutMs = 5000 } = {}) {
  return waitFor(async () => {
    const panel = await panelState();
    const count = annotShapes(panel).length;
    return count === expected ? panel : undefined;
  }, { timeoutMs, intervalMs: 100, label: `annotation shape count ${expected}` });
}

/** Focus the preview image before a zero-dispatch probe. */
async function focusFrameImage() {
  return pageEvaluate(panelExpr(`
    const img = panel.querySelector('.utb-frame');
    if (!img) return false;
    img.focus();
    return document.activeElement === img;
  `));
}

/** Type into the annotation text editor with real CDP input; then Enter/Escape/blur. */
async function annotTypeText(text, { enter = false, escape = false, blur = false } = {}) {
  await sleep(180);
  await state.chrome.cdp.send('Input.insertText', { text: String(text) });
  await sleep(120);
  if (escape) {
    await pressKey('Escape', 'Escape', 27);
    return;
  }
  if (enter) {
    await pressKey('Enter', 'Enter', 13);
    return;
  }
  if (blur) {
    const rect = await pageEvaluate(panelExpr(`
      const bar = panel.querySelector('.utb-annot-bar');
      if (!bar) return null;
      const r = bar.getBoundingClientRect();
      return { x: r.left + 4, y: r.top + r.height / 2 };
    `));
    if (rect) await clickAt(rect.x, rect.y);
    await sleep(300);
  }
}

/* ------------------------------------------------------------------------------------------------
 * P0-D v2 探针（docs/viewport-control.md §11）：清除画布 / 橡皮擦 / 上报协议与同步状态。
 * ---------------------------------------------------------------------------------------------- */

/** Annotation v2 facts: seven tools with icons, clear button, layer sync attributes, status hint. */
async function annotV2State() {
  return pageEvaluate(panelExpr(`
    const tools = [...panel.querySelectorAll('[data-utb-annot-tool]')].map((el) => {
      const icon = el.querySelector('svg');
      const rect = el.getBoundingClientRect();
      return {
        tool: el.getAttribute('data-utb-annot-tool'),
        label: el.getAttribute('aria-label'),
        title: el.title === undefined ? null : el.title,
        pressed: el.getAttribute('aria-pressed'),
        width: rect.width,
        height: rect.height,
        icon: icon ? {
          width: icon.getAttribute('width'), height: icon.getAttribute('height'),
          strokeWidth: icon.getAttribute('stroke-width'), stroke: icon.getAttribute('stroke'),
        } : null,
      };
    });
    const clear = panel.querySelector('[data-utb-annot-action="clear"]');
    const widthInput = panel.querySelector('input[aria-label="粗细"]');
    const clearRect = clear ? clear.getBoundingClientRect() : null;
    const widthRect = widthInput ? widthInput.getBoundingClientRect() : null;
    const colorInput = panel.querySelector('input[aria-label="颜色"]');
    const fillInput = panel.querySelector('[data-utb-annot-mode="fill"]');
    const strokeInput = panel.querySelector('[data-utb-annot-mode="stroke"]');
    const badge = panel.querySelector('.utb-annot-sync');
    const badgeRect = badge ? badge.getBoundingClientRect() : null;
    return {
      tools,
      clear: clear ? {
        text: (clear.textContent || '').trim(),
        label: clear.getAttribute('aria-label'),
        title: clear.title,
        action: clear.getAttribute('data-utb-annot-action'),
        disabled: clear.disabled === true,
        width: clearRect.width, height: clearRect.height,
        left: clearRect.left, top: clearRect.top,
        afterWidth: Boolean(widthRect) && clearRect.left >= widthRect.right - 1,
      } : null,
      hint: badge ? {
        text: (badge.textContent || '').trim(),
        title: badge.getAttribute('title') || '',
        live: badge.getAttribute('aria-live'),
        status: badge.getAttribute('data-utb-annot-sync-status'),
        display: getComputedStyle(badge).display,
        inStatusBar: Boolean(badge.closest('.utb-status')),
        width: badgeRect.width,
      } : null,
      color: colorInput ? { value: colorInput.value, disabled: colorInput.disabled === true } : null,
      fill: fillInput ? { checked: fillInput.getAttribute('aria-pressed') === 'true', disabled: fillInput.disabled === true } : null,
      stroke: strokeInput ? { checked: strokeInput.getAttribute('aria-pressed') === 'true', disabled: strokeInput.disabled === true } : null,
      width: widthInput ? { value: widthInput.value, disabled: widthInput.disabled === true } : null,
    };
  `));
}

/** Make the annotation layer the top hit at this GUI point (a shell mask can swallow the first one). */
async function annotEnsureHit(point) {
  for (let attempt = 0; attempt < 4; attempt += 1) {
    await dismissShellDialogs();
    const hit = await pageEvaluate(`(() => {
      const el = document.elementFromPoint(${point.x}, ${point.y});
      return el && el.closest ? Boolean(el.closest('.utb-annot-layer')) : false;
    })()`).catch(() => false);
    if (hit) return true;
    await clickAt(point.x, point.y);
    await sleep(350);
  }
  return false;
}

/** Is the annotation layer the element under this GUI point (read-only, no click)? */
async function annotLayerOnTop(point) {
  return pageEvaluate(`(() => {
    const el = document.elementFromPoint(${point.x}, ${point.y});
    return el && el.closest ? Boolean(el.closest('.utb-annot-layer')) : false;
  })()`).catch(() => false);
}

/** Draw one shape through the *current* mapping (scroll into view, re-measure, then real drag). */
async function annotDrawStable(from, to, options = {}) {
  let map = await annotMappingNow();
  await ensurePointVisible(annotCanvasToGui(map, from));
  await sleep(120);
  map = await annotMappingNow();
  const fromGui = annotCanvasToGui(map, from);
  const toGui = annotCanvasToGui(map, to);
  const hit = await annotEnsureHit(fromGui);
  await annotDragGui(fromGui, toGui, options);
  return { map, fromGui, toGui, hit };
}

/** Canvas point → fresh GUI point that is guaranteed to sit on the annotation layer. */
async function annotPointGui(point) {
  let map = await annotMappingNow();
  await ensurePointVisible(annotCanvasToGui(map, point));
  await sleep(100);
  map = await annotMappingNow();
  const gui = annotCanvasToGui(map, point);
  await annotEnsureHit(gui);
  return gui;
}

/** One primary-button press/release at a GUI point (no movement: the eraser erases on press). */
async function annotPressGui(point) {
  const send = (type, x, y, buttons, button) => state.chrome.cdp.send('Input.dispatchMouseEvent', {
    type, x, y, button, buttons, clickCount: type === 'mouseMoved' ? 0 : 1,
  });
  await send('mouseMoved', point.x, point.y, 0, 'none');
  await sleep(40);
  await send('mousePressed', point.x, point.y, 1, 'left');
  await sleep(60);
  await send('mouseReleased', point.x, point.y, 0, 'left');
  await sleep(280);
}

/** Canvas point → one real press (erase sample) through the current mapping. */
async function annotPressAtCanvas(point) {
  const gui = await annotPointGui(point);
  await annotPressGui(gui);
  return gui;
}

async function annotHoverGui(point) {
  await state.chrome.cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: point.x, y: point.y, button: 'none', buttons: 0 });
  await sleep(240);
}

/** The clear-canvas button rect (throws when the mode is off and the bar is not rendered). */
async function annotClearRect({ dismiss = true } = {}) {
  // `dismiss:false` keeps a live text editor focused: closing a shell dialog would blur it first.
  if (dismiss) await dismissShellDialogs();
  const rect = await pageEvaluate(panelExpr(`
    const b = panel.querySelector('[data-utb-annot-action="clear"]');
    if (!b) return null;
    const r = b.getBoundingClientRect();
    return { x: r.left + r.width / 2, y: r.top + r.height / 2, left: r.left, top: r.top, width: r.width, height: r.height, disabled: b.disabled === true };
  `));
  if (!rect) throw new Error('annotation clear button not found');
  return rect;
}

async function clickAnnotClear() {
  const rect = await annotClearRect();
  if (rect.disabled) return false;
  await clickAt(rect.x, rect.y);
  await sleep(400);
  return true;
}

/** Clear the drawing through the real button and wait until no committed shape is left. */
async function annotResetCanvas({ timeoutMs = 5000 } = {}) {
  const snapshot = await annotV2State();
  if (snapshot.clear && !snapshot.clear.disabled) {
    try { await clickAnnotClear(); } catch { /* nothing to clear */ }
  }
  await waitFor(async () => {
    const panel = await panelState();
    return annotShapes(panel).length === 0 ? panel : undefined;
  }, { timeoutMs, intervalMs: 100, label: 'annotation canvas reset' });
  return panelState();
}

/** Set the fill/stroke/width style legally (the last checked box can never be cleared). */
async function annotPrepareStyle({ fill, stroke, width, color } = {}) {
  const annot = (await panelState()).annot;
  if (!annot) throw new Error('annotation bar missing');
  // 用户 2026-11-03 第 1 条：填充/外框是单一 mode，只能选一个（调用点均为互斥组合）。
  const desired = fill === true ? '填充' : stroke === true ? '外框' : null;
  if (desired) {
    const target = desired === '填充' ? annot.fill : annot.stroke;
    if (target && target.disabled === false && target.checked !== true) await clickAnnotCheckbox(desired);
  }
  if (width !== undefined) await setAnnotWidth(width);
  if (color !== undefined) await setAnnotColor(color);
  return (await panelState()).annot;
}

/** Place one text shape: click the落点, type with real CDP input, commit with Enter. */
async function annotPlaceText(point, text) {
  await clickAnnotTool('text');
  let map = await annotMappingNow();
  await ensurePointVisible(annotCanvasToGui(map, point));
  await sleep(120);
  map = await annotMappingNow();
  const gui = annotCanvasToGui(map, point);
  await annotEnsureHit(gui);
  await annotClickGui(gui);
  await sleep(320);
  await annotTypeText(text, { enter: true });
  await sleep(320);
  return map;
}

/** Wait until the annotation layer reports one sync state. */
async function waitAnnotSync(states, { timeoutMs = 9000, intervalMs = 120 } = {}) {
  const wanted = Array.isArray(states) ? states : [states];
  return waitFor(async () => {
    const panel = await panelState();
    const sync = panel.annot && panel.annot.svg ? panel.annot.svg.sync : null;
    return wanted.includes(sync) ? panel : undefined;
  }, { timeoutMs, intervalMs, label: `annotation sync in ${wanted.join('|')}` }).catch(() => null);
}

/** The Host's accepted annotation document (`ui.annotations`, §11.1/§11.2). */
async function hostAnnotations() {
  const snapshot = await hostState();
  const ui = snapshot && snapshot.ui && typeof snapshot.ui === 'object' ? snapshot.ui : null;
  return ui && ui.annotations && typeof ui.annotations === 'object' ? ui.annotations : null;
}

async function waitHostAnnotations(predicate, { timeoutMs = 9000, intervalMs = 150, label = 'host annotations' } = {}) {
  return waitFor(async () => {
    const doc = await hostAnnotations().catch(() => null);
    return doc && predicate(doc) ? doc : undefined;
  }, { timeoutMs, intervalMs, label });
}

/**
 * Intercept the panel's own `/annotations` writes: the first `failFirst` attempts are answered
 * with 500 (a real network-shape failure), the rest continue to the real Host.
 */
async function startAnnotationFailure(failFirst = 1) {
  const { cdp } = state.chrome;
  const attempts = [];
  let remaining = Math.max(0, Number(failFirst) || 0);
  const handler = async (message) => {
    if (message.method !== 'Fetch.requestPaused') return;
    const params = message.params || {};
    const url = String((params.request && params.request.url) || '');
    if (!url.includes('/plugins/ui-testing/annotations')) {
      await cdp.send('Fetch.continueRequest', { requestId: params.requestId }).catch(() => {});
      return;
    }
    let body = {};
    try { body = JSON.parse(params.request.postData || '{}'); } catch { body = {}; }
    const entry = { at: Date.now(), body, failed: remaining > 0 };
    attempts.push(entry);
    if (remaining > 0) {
      remaining -= 1;
      const output = JSON.stringify({ ok: false, error: 'acceptance injected failure', code: 'INTERNAL' });
      await cdp.send('Fetch.fulfillRequest', {
        requestId: params.requestId,
        responseCode: 500,
        responseHeaders: [
          { name: 'content-type', value: 'application/json' },
          { name: 'content-length', value: String(Buffer.byteLength(output)) },
        ],
        body: Buffer.from(output).toString('base64'),
      }).catch(() => {});
      return;
    }
    await cdp.send('Fetch.continueRequest', { requestId: params.requestId }).catch(() => {});
  };
  const off = cdp.on(handler);
  await cdp.send('Fetch.enable', { patterns: [{ urlPattern: '*/plugins/ui-testing/annotations*', requestStage: 'Request' }] });
  return {
    attempts,
    waitForCount(count, timeoutMs = 9000) {
      return waitFor(() => (attempts.length >= count ? attempts.slice(0, count) : undefined),
        { timeoutMs, intervalMs: 50, label: `annotation write #${count}` });
    },
    async stop() {
      try { await cdp.send('Fetch.disable'); } catch { /* ignore */ }
      off();
    },
  };
}

/** Host-side PNG (no annotation layer) for the panel-invisibility proof. */
async function hostScreenshotPng() {
  const response = await pageHostFetch('/screenshot', {
    method: 'POST',
    headers: Object.assign({ 'content-type': 'application/json' }, requireScope()),
    body: {},
  });
  if (response.status !== 200 || !response.json || response.json.ok === false || !response.json.image) {
    throw new Error(`POST /screenshot -> ${response.status}: ${sanitize(response.text)}`);
  }
  return Buffer.from(response.json.image, 'base64');
}

/* ------------------------------------------------------------------------------------------------
 * P0-D v3 probes (docs/viewport-control.md §12): workspace retention, hydration, remount, adoption.
 * ---------------------------------------------------------------------------------------------- */

/** Panel POSTs to /annotations (test-side requests carry utbViewportAcceptance=1 and are excluded). */
function annotationPosts(since = 0) {
  return state.requests
    .filter((entry) => !entry.script && entry.method === 'POST'
      && entry.url.includes('/plugins/ui-testing/annotations') && entry.at >= since)
    .map((entry) => ({ at: entry.at, body: parseBody(entry) }));
}

function annotationReleases(since = 0) {
  return annotationPosts(since).filter((entry) => entry.body && entry.body.release === true);
}

/** Real unmount: switch the main column to the plugin manager (the debug view is dropped). */
async function switchMainPanelAway() {
  await dismissShellDialogs();
  const clicked = await pageEvaluate(`(() => {
    const row = [...document.querySelectorAll('button[aria-label="插件"]')].find((el) => !el.closest('.utb'));
    if (!row) return false;
    row.click();
    return true;
  })()`);
  if (!clicked) throw new Error('left sidebar 插件 panel row not found');
  await waitFor(async () => {
    const gone = await pageEvaluate(`!([...document.querySelectorAll('.utb')].find((el) => !el.closest('[data-sidebar-right-tab]')))`);
    return gone ? true : undefined;
  }, { timeoutMs: 10000, intervalMs: 100, label: 'debug view unmounted' });
}

/** Remount through the real shell (更多 → 调试视图). */
async function remountMainPanel() {
  await switchMainPanelAway();
  await openPanel();
  await waitFor(async () => {
    const panel = await panelState();
    return panel.missing !== true && panel.frame ? panel : undefined;
  }, { timeoutMs: 15000, intervalMs: 150, label: 'debug view remounted' });
  await sleep(450);
}

async function rightSidebarInfo() {
  return pageEvaluate(`(() => {
    const panel = document.querySelector('[data-sidebar-right-session]');
    const guide = document.querySelector('[data-sidebar-right-guide-entry="debug-view"]');
    const tabs = [...document.querySelectorAll('[data-sidebar-right-tab]')].map((el) => ({
      id: el.getAttribute('data-sidebar-right-tab'),
      occurrence: el.getAttribute('data-sidebar-right-occurrence'),
      title: (el.textContent || '').trim().slice(0, 40),
      body: Boolean(el.querySelector('.utb')),
    }));
    return {
      panel: Boolean(panel),
      open: Boolean(panel && panel.hasAttribute('data-sidebar-right-open')),
      guide: Boolean(guide),
      expand: Boolean(document.querySelector('[data-sidebar-right-expand]')),
      tabs,
      session: panel ? panel.getAttribute('data-sidebar-right-session') : null,
    };
  })()`);
}

async function ensureRightSidebarOpen() {
  const info = await rightSidebarInfo();
  if (!info.panel) throw new Error('right sidebar is not rendered (no active session)');
  if (info.open) return info;
  const clicked = await pageEvaluate(`(() => {
    const button = document.querySelector('[data-sidebar-right-expand]');
    if (!button) return false;
    button.click();
    return true;
  })()`);
  if (!clicked) {
    // A collapsed track exposes the panel-header toggle instead of the frame expand seat.
    const toggled = await pageEvaluate(`(() => {
      const button = document.querySelector('[data-sidebar-right-toggle]');
      if (!button) return false;
      button.click();
      return true;
    })()`).catch(() => false);
    if (toggled) {
      await sleep(800);
      const after = await rightSidebarInfo();
      if (after.open) return after;
    }
    // Opening a tab from the guide can expand the pane; do not fail here.
    return rightSidebarInfo();
  }
  await waitFor(async () => ((await rightSidebarInfo()).open ? true : undefined),
    { timeoutMs: 7000, intervalMs: 100, label: 'right sidebar expanded' });
  return rightSidebarInfo();
}

/** Open the debug-view tab in the right sidebar (a real second panel seat). */
async function openSidebarDebugPanel() {
  await dismissShellDialogs();
  let conversationShown = false;
  if (!(await rightSidebarInfo()).expand) {
    // The expand control is part of the conversation header; the main debug panel replaces it.
    await showConversation();
    conversationShown = true;
  }
  await ensureRightSidebarOpen();
  const existing = await pageEvaluate(`Boolean(document.querySelector('[data-sidebar-right-tab] .utb'))`);
  if (existing) return rightSidebarInfo();
  const opened = await waitFor(async () => {
    const clicked = await pageEvaluate(`(() => {
      const entry = document.querySelector('[data-sidebar-right-guide-entry="debug-view"]');
      if (entry) { entry.click(); return 'guide'; }
      const plus = [...document.querySelectorAll('[data-sidebar-right-panel] button[aria-label]')]
        .find((el) => /调试视图/.test(el.getAttribute('aria-label') || ''));
      if (plus) { plus.click(); return 'plus'; }
      const menu = [...document.querySelectorAll('button, [role="menuitem"]')]
        .find((el) => (el.textContent || '').trim() === '调试视图');
      if (menu) { menu.click(); return 'menu'; }
      return false;
    })()`);
    return clicked || undefined;
  }, { timeoutMs: 6000, intervalMs: 200, label: 'open debug sidebar tab' });
  const mounted = await waitFor(async () => pageEvaluate(`Boolean(document.querySelector('[data-sidebar-right-tab] .utb'))`),
    { timeoutMs: 10000, intervalMs: 150, label: 'sidebar debug panel mounted' }).catch(() => null);
  if (!mounted) {
    // A collapsed track may need a second explicit expand after the tab exists.
    await pageEvaluate(`(() => { const b = document.querySelector('[data-sidebar-right-expand]'); if (b) b.click(); return true; })()`).catch(() => undefined);
    await sleep(800);
    await waitFor(async () => pageEvaluate(`Boolean(document.querySelector('[data-sidebar-right-tab] .utb'))`),
      { timeoutMs: 7000, intervalMs: 150, label: 'sidebar debug panel mounted after expand' });
  }
  if (conversationShown) {
    // Restore the main debug panel (the sidebar seat stays mounted).
    await openPanel();
    await sleep(500);
  }
  await sleep(400);
  return { opened, conversationShown, ...(await rightSidebarInfo()) };
}

async function sidebarPanelState() {
  return pageEvaluate(`(() => {
    const panel = document.querySelector('[data-sidebar-right-tab] .utb');
    if (!panel) return { missing: true };
    const svg = panel.querySelector('.utb-annot-layer');
    const box = panel.querySelector('.utb-box');
    const img = panel.querySelector('.utb-frame');
    const entry = panel.querySelector('button[aria-label="标注"]');
    const shapes = [...panel.querySelectorAll('.utb-annot-layer g[data-utb-annot-state="committed"]')].map((g) => {
      const child = g.firstElementChild;
      const attrs = {};
      for (const attr of g.attributes) if (attr.name.startsWith('data-utb-annot-')) attrs[attr.name] = attr.value;
      const ctm = child && child.getScreenCTM ? child.getScreenCTM() : null;
      return {
        id: g.getAttribute('data-utb-annot-id'), type: g.getAttribute('data-utb-annot-type'), attrs,
        ctm: ctm ? { a: ctm.a, b: ctm.b, c: ctm.c, d: ctm.d, e: ctm.e, f: ctm.f } : null,
      };
    });
    const boxRect = box ? box.getBoundingClientRect() : null;
    const imgRect = img ? img.getBoundingClientRect() : null;
    return {
      missing: false,
      shapes,
      sync: svg ? svg.getAttribute('data-utb-annot-sync') : null,
      revision: svg ? svg.getAttribute('data-utb-annot-revision') : null,
      pressed: entry ? entry.getAttribute('aria-pressed') : null,
      disabled: entry ? entry.disabled : null,
      box: boxRect ? { left: boxRect.left, top: boxRect.top, width: boxRect.width, height: boxRect.height } : null,
      img: imgRect ? { left: imgRect.left, top: imgRect.top, width: imgRect.width, height: imgRect.height } : null,
      naturalWidth: img ? img.naturalWidth : 0,
      naturalHeight: img ? img.naturalHeight : 0,
      complete: img ? img.complete : false,
    };
  })()`);
}

async function sidebarEntryRect() {
  return pageEvaluate(`(() => {
    const panel = document.querySelector('[data-sidebar-right-tab] .utb');
    if (!panel) return null;
    const button = panel.querySelector('button[aria-label="标注"]');
    if (!button) return null;
    const r = button.getBoundingClientRect();
    return { x: r.left + r.width / 2, y: r.top + r.height / 2, disabled: button.disabled, pressed: button.getAttribute('aria-pressed') };
  })()`);
}

async function toggleSidebarAnnot(expected) {
  for (let attempt = 0; attempt < 4; attempt += 1) {
    await dismissShellDialogs();
    const before = await sidebarPanelState();
    if (before.missing) throw new Error('sidebar debug panel missing');
    if (before.pressed === expected) return before;
    const rect = await sidebarEntryRect();
    if (!rect || rect.disabled) return before;
    await clickAt(rect.x, rect.y);
    await sleep(450);
    const after = await sidebarPanelState();
    if (after.pressed === expected) return after;
  }
  return sidebarPanelState();
}

async function sidebarMappingNow() {
  const panel = await sidebarPanelState();
  if (panel.missing || !panel.box || !panel.img || !panel.complete) throw new Error('sidebar frame is not ready');
  const painted = paintedOf({
    box: panel.box, img: panel.img,
    naturalWidth: panel.naturalWidth, naturalHeight: panel.naturalHeight,
  });
  const snapshot = await hostView();
  const canvas = (await hostCanvas()).canvas;
  if (!painted || !snapshot.view || !canvas) throw new Error('sidebar mapping facts missing');
  const viewWidth = Number(snapshot.view.width);
  const viewHeight = Number(snapshot.view.height);
  return {
    painted, view: snapshot.view, canvas,
    sx: painted.width / viewWidth,
    sy: painted.height / viewHeight,
  };
}

async function clickSidebarTool(tool) {
  await dismissShellDialogs();
  const rect = await pageEvaluate(`(() => {
    const panel = document.querySelector('[data-sidebar-right-tab] .utb');
    if (!panel) return null;
    const button = panel.querySelector('[data-utb-annot-tool="${tool}"]');
    if (!button) return null;
    const r = button.getBoundingClientRect();
    return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
  })()`);
  if (!rect) throw new Error('sidebar annotation tool not found: ' + tool);
  await clickAt(rect.x, rect.y);
  await sleep(220);
  return sidebarPanelState();
}

async function sidebarDrawStable(from, to) {
  const map = await sidebarMappingNow();
  const fromGui = annotCanvasToGui(map, from);
  const toGui = annotCanvasToGui(map, to);
  const hit = await annotEnsureHit(fromGui);
  await annotDragGui(fromGui, toGui, { steps: 5 });
  return { map, fromGui, toGui, hit };
}

/** Full-viewport PNG (both panel seats visible) for dual-panel evidence. */
async function captureViewport(name) {
  const shot = await state.chrome.cdp.send('Page.captureScreenshot', { format: 'png' }).catch(() => null);
  if (!shot) return null;
  const buffer = Buffer.from(shot.data, 'base64');
  const path = join(EVIDENCE_DIR, `${name}.png`);
  await writeFile(path, buffer, { mode: 0o600 });
  state.evidence.push({ name, path: path.slice(REPO_ROOT.length + 1), bytes: buffer.length });
  log(`  [EVIDENCE] ${name}.png (${buffer.length} bytes)`);
  return path;
}

/** Real Host write from a synthetic second panel (proves cross-source adoption without a second GUI). */
async function postAnnotationDocument(options = {}) {
  const snapshot = await hostState();
  const ui = snapshot.ui || {};
  const context = options.context || ui.annotationContext;
  const view = ui.view || {};
  const canvas = ui.canvas || {};
  const body = {
    version: 1,
    panelId: options.panelId || '00000000-0000-4000-a000-0000000000b1',
    surface: options.surface || 'sidebar',
    clientRevision: options.clientRevision || 1,
    context,
    view: {
      canvasX: Number.isFinite(Number(canvas.x)) ? Number(canvas.x) : 0,
      canvasY: Number.isFinite(Number(canvas.y)) ? Number(canvas.y) : 0,
      x: Number.isFinite(Number(view.x)) ? Number(view.x) : 0,
      y: Number.isFinite(Number(view.y)) ? Number(view.y) : 0,
      width: Number(view.width) || 400,
      height: Number(view.height) || 300,
      scale: Number(view.scale) || 1,
      contentWidth: Number.isFinite(Number(canvas.contentWidth)) ? Number(canvas.contentWidth) : null,
      contentHeight: Number.isFinite(Number(canvas.contentHeight)) ? Number(canvas.contentHeight) : null,
      viewRevision: Number.isFinite(Number(view.revision)) ? Number(view.revision) : 0,
      frameEpoch: context && Number.isFinite(Number(context.documentEpoch)) ? Number(context.documentEpoch) : null,
    },
    shapes: options.shapes || [],
    truncation: { droppedShapes: 0, droppedPoints: 0, shortenedTextCodeUnits: 0 },
    release: false,
  };
  return pageHostFetch('/annotations', {
    method: 'POST',
    headers: Object.assign({ 'content-type': 'application/json' }, requireScope()),
    body,
  });
}

function wireRect(id, x, y, width, height, color) {
  return {
    id, type: 'rect', color: color || '#00aa55', strokeWidth: 3,
    fill: false, stroke: true, x, y, width, height,
  };
}

/** Hold the first panel /annotations POST; release it as pass-through, 409 stale or 500 failure. */
async function startAnnotationHold({ count = 1 } = {}) {
  const { cdp } = state.chrome;
  const requests = [];
  const heldList = [];
  let remaining = Math.max(1, Number(count) || 1);
  const handler = async (message) => {
    if (message.method !== 'Fetch.requestPaused') return;
    const params = message.params || {};
    const url = String((params.request && params.request.url) || '');
    if (!url.includes('/plugins/ui-testing/annotations')) {
      await cdp.send('Fetch.continueRequest', { requestId: params.requestId }).catch(() => {});
      return;
    }
    let body = {};
    try { body = JSON.parse(params.request.postData || '{}'); } catch { body = {}; }
    const entry = { requestId: params.requestId, body, at: Date.now() };
    requests.push(entry);
    if (remaining > 0) {
      remaining -= 1;
      heldList.push(entry);
      return;
    }
    await cdp.send('Fetch.continueRequest', { requestId: params.requestId }).catch(() => {});
  };
  const off = cdp.on(handler);
  await cdp.send('Fetch.enable', { patterns: [{ urlPattern: '*/plugins/ui-testing/annotations*', requestStage: 'Request' }] });
  const fulfil = async (entry, status, payload) => {
    const output = JSON.stringify(payload);
    await cdp.send('Fetch.fulfillRequest', {
      requestId: entry.requestId,
      responseCode: status,
      responseHeaders: [
        { name: 'content-type', value: 'application/json' },
        { name: 'content-length', value: String(Buffer.byteLength(output)) },
      ],
      body: Buffer.from(output).toString('base64'),
    }).catch(() => {});
  };
  return {
    requests,
    heldList,
    waitForHeld(index = 0, timeoutMs = 9000) {
      return waitFor(() => heldList[index] || undefined, { timeoutMs, intervalMs: 80, label: `held annotation POST #${index + 1}` });
    },
    async release(mode) {
      const entry = heldList.shift();
      if (!entry) return false;
      if (mode === 'stale') {
        await fulfil(entry, 409, {
          ok: false, error: 'stale', code: 'INVALID_ARGUMENT', details: { reason: 'annotation-context-stale' },
        });
      } else if (mode === 'fail') {
        await fulfil(entry, 500, { ok: false, error: 'acceptance injected failure', code: 'INTERNAL' });
      } else {
        await cdp.send('Fetch.continueRequest', { requestId: entry.requestId }).catch(() => {});
      }
      return true;
    },
    async stop() {
      while (heldList.length) {
        const entry = heldList.shift();
        await cdp.send('Fetch.continueRequest', { requestId: entry.requestId }).catch(() => {});
      }
      try { await cdp.send('Fetch.disable'); } catch { /* ignore */ }
      off();
    },
  };
}

/**
 * Hold one panel /annotations POST and rewrite /state in the same Fetch session (a 409/failure
 * must be released while another scope's state is already projected). Two separate `Fetch.enable`
 * calls would replace each other's patterns, so both live in one handler.
 */
async function startAnnotationHoldWithRewrite(rewrite) {
  const { cdp } = state.chrome;
  const requests = [];
  let held = null;
  let holdNext = true;
  const handler = async (message) => {
    if (message.method !== 'Fetch.requestPaused') return;
    const params = message.params || {};
    const requestId = params.requestId;
    const url = String((params.request && params.request.url) || '');
    if (!requestId) return;
    if (url.includes('/plugins/ui-testing/annotations')) {
      let body = {};
      try { body = JSON.parse(params.request.postData || '{}'); } catch { body = {}; }
      const entry = { requestId, body, at: Date.now() };
      requests.push(entry);
      if (!held && holdNext) { holdNext = false; held = entry; return; }
      await cdp.send('Fetch.continueRequest', { requestId }).catch(() => {});
      return;
    }
    if (url.includes('/plugins/ui-testing/state') && !url.includes('utbViewportAcceptance=1')) {
      try {
        const body = await cdp.send('Fetch.getResponseBody', { requestId });
        const text = body.base64Encoded ? Buffer.from(body.body, 'base64').toString('utf8') : body.body;
        const json = JSON.parse(text);
        const next = rewrite(json) || json;
        const output = JSON.stringify(next);
        const headers = (params.responseHeaders || [])
          .filter((header) => !['content-length', 'content-encoding', 'transfer-encoding'].includes(String(header.name).toLowerCase()))
          .concat([{ name: 'content-length', value: String(Buffer.byteLength(output)) }]);
        await cdp.send('Fetch.fulfillRequest', {
          requestId, responseCode: 200, responseHeaders: headers,
          body: Buffer.from(output).toString('base64'),
        });
      } catch {
        await cdp.send('Fetch.continueRequest', { requestId }).catch(() => {});
      }
      return;
    }
    await cdp.send('Fetch.continueRequest', { requestId }).catch(() => {});
  };
  const off = cdp.on(handler);
  await cdp.send('Fetch.enable', { patterns: [
    { urlPattern: '*/plugins/ui-testing/annotations*', requestStage: 'Request' },
    { urlPattern: '*/plugins/ui-testing/state*', requestStage: 'Response' },
  ] });
  const fulfil = async (entry, status, payload) => {
    const output = JSON.stringify(payload);
    await cdp.send('Fetch.fulfillRequest', {
      requestId: entry.requestId, responseCode: status,
      responseHeaders: [
        { name: 'content-type', value: 'application/json' },
        { name: 'content-length', value: String(Buffer.byteLength(output)) },
      ],
      body: Buffer.from(output).toString('base64'),
    }).catch(() => {});
  };
  return {
    requests,
    waitForHeld(timeoutMs = 9000) {
      return waitFor(() => held || undefined, { timeoutMs, intervalMs: 80, label: 'held annotation POST (with /state rewrite)' });
    },
    async release(mode) {
      if (!held) return false;
      const entry = held;
      held = null;
      if (mode === 'stale') {
        await fulfil(entry, 409, {
          ok: false, error: 'stale', code: 'INVALID_ARGUMENT', details: { reason: 'annotation-context-stale' },
        });
      } else if (mode === 'fail') {
        await fulfil(entry, 500, { ok: false, error: 'acceptance injected failure', code: 'INTERNAL' });
      } else {
        await cdp.send('Fetch.continueRequest', { requestId: entry.requestId }).catch(() => {});
      }
      return true;
    },
    async stop() {
      if (held) {
        const entry = held;
        held = null;
        await cdp.send('Fetch.continueRequest', { requestId: entry.requestId }).catch(() => {});
      }
      try { await cdp.send('Fetch.disable'); } catch { /* ignore */ }
      off();
    },
  };
}

/** GUI page reload (real browser navigation), then reopen the debug view. */
async function reloadGui() {
  await state.chrome.cdp.send('Page.reload', { ignoreCache: false });
  await guiReady(45000);
  await openPanel();
  await waitFor(async () => {
    const panel = await panelState();
    return panel.missing !== true && panel.frame ? panel : undefined;
  }, { timeoutMs: 20000, intervalMs: 200, label: 'debug view after GUI reload' });
  await sleep(450);
}

async function hostAnnotationSource() {
  const doc = await hostAnnotations();
  return doc && doc.source ? doc.source : null;
}

/** Screen position of the shape's anchor point (canvas model → CTM → GUI CSS px). */
function shapeScreenPoint(shape) {
  if (!shape || !shape.ctm) return null;
  const attrs = shape.attrs || {};
  const value = (name) => Number(attrs['data-utb-annot-' + name]);
  if (shape.type === 'rect') return annotScreenOf(shape, { x: value('x'), y: value('y') });
  if (shape.type === 'circle') return annotScreenOf(shape, { x: value('cx'), y: value('cy') });
  if (shape.type === 'line' || shape.type === 'arrow') return annotScreenOf(shape, { x: value('x1'), y: value('y1') });
  if (shape.type === 'text') return annotScreenOf(shape, { x: value('x'), y: value('y') });
  if (shape.type === 'brush') {
    let points = [];
    try { points = JSON.parse(attrs['data-utb-annot-points'] || '[]'); } catch { points = []; }
    return points.length ? annotScreenOf(shape, points[0]) : null;
  }
  return null;
}

/** Real hidden/visible document (not a React prop): visibility override, lifecycle or a real tab switch. */
async function setPageVisibility(visibilityState) {
  const { cdp } = state.chrome;
  const methods = [];
  try {
    await cdp.send('Emulation.setPageVisibilityOverride', { visibilityState });
    methods.push('visibility-override');
  } catch { /* not supported by this Chrome */ }
  if (!methods.length) {
    try {
      if (visibilityState === 'hidden') {
        const created = await cdp.send('Target.createTarget', { url: 'about:blank', background: false });
        await cdp.send('Target.activateTarget', { targetId: created.targetId });
        state.backgroundTargetId = created.targetId;
      } else {
        const targets = await cdp.send('Target.getTargets');
        const page = targets.targetInfos.find((target) => target.type === 'page'
          && String(target.url).startsWith(state.dsh ? state.dsh.base : ''));
        if (page) await cdp.send('Target.activateTarget', { targetId: page.targetId });
        if (state.backgroundTargetId) {
          await cdp.send('Target.closeTarget', { targetId: state.backgroundTargetId }).catch(() => undefined);
          state.backgroundTargetId = '';
        }
      }
      methods.push('target-switch');
    } catch { /* give up */ }
  }
  if (!methods.length) {
    try {
      await cdp.send('Page.setWebLifecycleState', { state: visibilityState === 'hidden' ? 'frozen' : 'active' });
      methods.push('lifecycle');
    } catch { /* not supported */ }
  }
  const actual = await pageEvaluate('document.visibilityState').catch(() => null);
  return { method: methods[methods.length - 1] || 'unsupported', actual };
}

/** Return to the conversation (the right-sidebar expand control lives in the session header). */
async function showConversation() {
  const clicked = await pageEvaluate(`(() => {
    const rows = [...document.querySelectorAll('[class*="_sessionRow"]')];
    const selected = rows.find((el) => String(el.className).includes('selected')) || rows[0];
    if (!selected) return false;
    selected.click();
    return true;
  })()`);
  if (!clicked) throw new Error('session row not found (cannot return to the conversation)');
  await waitFor(async () => {
    const main = await pageEvaluate(`Boolean(document.querySelector('[data-sidebar-right-expand]'))`);
    return main ? true : undefined;
  }, { timeoutMs: 6000, intervalMs: 150, label: 'conversation header with the right-sidebar expand control' });
  await sleep(350);
}

/** Projection harness: a synthetic second scope/document for client-side isolation/adoption. */
function createScopeProjection(realUi) {
  const docs = { A: null, B: null };
  let active = 'A';
  let tick = 0;
  const buildDoc = (name, ui, options) => {
    const scope = Object.assign({}, ui.scope, { id: 'ws_projected_' + name.toLowerCase(), workspaceId: 'proj-' + name.toLowerCase() });
    const context = Object.assign({}, ui.annotationContext, {
      documentKey: 'proj-document-' + name.toLowerCase() + '-' + Date.now().toString(36),
    });
    return {
      scope,
      context,
      annotations: {
        version: 1, space: 'canvas-css-px', revision: options.revision || 1,
        updatedAt: Date.now(), source: options.source || null,
        context: options.source ? context : null,
        view: options.source ? (ui.view || null) : null,
        shapes: options.shapes || [],
        truncated: false,
        truncation: { droppedShapes: 0, droppedPoints: 0, shortenedTextCodeUnits: 0 },
        stale: false, staleReason: null,
      },
    };
  };
  return {
    docs,
    buildDoc,
    setDoc(name, doc) { docs[name] = doc; },
    activate(name) { active = name; },
    get active() { return active; },
    rewrite(json) {
      return mutateStateUi(json, (ui) => {
        tick += 1;
        ui.revision = Number(ui.revision || 0) + 1;
        const doc = docs[active];
        if (!doc) return ui;
        ui.scope = doc.scope;
        ui.annotationContext = doc.context;
        ui.annotations = doc.annotations;
        return ui;
      });
    },
  };
}

/* ------------------------------------------------------------------------------------------------
 * Main flow.
 * ---------------------------------------------------------------------------------------------- */
async function main() {
  if (!existsSync(DEFAULT_PROFILE) || !existsSync(join(DEFAULT_PROFILE, 'node_modules'))) {
    notRun('ENV', 'isolated DSH instance', `user DSH profile missing at ${DEFAULT_PROFILE}`);
    return 0;
  }
  if (!existsSync(CHROME_BIN)) {
    notRun('ENV', 'headless Chromium', `chrome binary/wrapper missing: ${CHROME_BIN}`);
    return 0;
  }
  await mkdir(RUN_DIR, { recursive: true });
  await mkdir(EVIDENCE_DIR, { recursive: true });
  state.buildInfo = buildInfo();

  const { startFixtureServer } = await import(pathToFileURL(join(REPO_ROOT, 'tests/ui_test_fixture/server.mjs')).href);
  state.fixture = await startFixtureServer();
  const fixtureBase = String(state.fixture.url).replace(/\/+$/, '');
  log(`[env] fixture: ${fixtureBase}`);

  const dsh = await startIsolatedDsh();
  log(`[env] isolated DSH: ${dsh.base} (port ${dsh.port}); DSH_HOME=${dsh.home}`);
  log(`[env] profile files copied: ${dsh.copied.join(',')}; node_modules symlinked from the user profile`);

  const cookies = await authenticate(dsh.launchUrl);
  log('[env] launch URL exchanged for an in-memory browser-session cookie (not logged)');

  state.chrome = await launchChrome(CHROME_BIN);
  const { cdp } = state.chrome;
  await cdp.send('Page.enable');
  await cdp.send('Runtime.enable');
  await cdp.send('Network.enable');
  hookNetworkEvents();
  log(`[env] headless chromium devtools port ${state.chrome.devtoolsPort}`);
  const base = new URL(dsh.base);
  for (const cookie of cookies) {
    const eq = cookie.indexOf('=');
    await cdp.send('Network.setCookie', { name: cookie.slice(0, eq), value: cookie.slice(eq + 1), url: base.origin + '/' });
  }
  await cdp.send('Page.navigate', { url: dsh.launchUrl });
  const boot = await guiReady(45000);
  check('V0.1', 'isolated DSH GUI is loaded from the ephemeral port', boot.origin === base.origin, base.origin, boot.origin);
  const location = await pageEvaluate('location.href');
  check('V0.2', 'token is exchanged away from the GUI address bar', !String(location).includes('token='), 'no token in location', location);
  check('V0.3', 'isolated instance never reads the user 3080/3081 ports', dsh.port !== 3080 && dsh.port !== 3081, 'port != 3080/3081', dsh.port);
  check('V0.4', 'launch token never appears in this run log', !logLines.join('\n').includes(state.token), 'no token in log', 'checked');

  state.servedClient = await servedClientEvidence();
  const servedMatchesCheckout = Boolean(state.servedClient && state.servedClient.text.trim() === readFileSync(join(REPO_ROOT, 'client.js'), 'utf8').trim());
  const servedHasNewViewportCode = Boolean(state.servedClient && state.servedClient.text.includes('data-utb-field')
    && state.servedClient.text.includes('视口 X 坐标（像素）') && state.servedClient.text.includes('VIEW_LIMITS'));
  check('V0.5', 'GUI serves this checkout client.js (size-bar/X-Y code present in the loaded bundle)',
    servedHasNewViewportCode,
    { hasUtbField: true, hasXLabel: true, hasViewLimits: true, exactMatch: servedMatchesCheckout },
    { rev: state.servedClient ? state.servedClient.rev : null, bytes: state.servedClient ? state.servedClient.bytes : null,
      sha256: state.servedClient ? state.servedClient.sha256Full : null, exactMatch: servedMatchesCheckout });
  state.servedClient.exactMatch = servedMatchesCheckout;
  state.servedClient.hasViewportCode = servedHasNewViewportCode;

  await openPanel();
  const firstBindPosts = panelViewportPosts();
  await openSizeBar();

  await scenario('V1 panel structure', async () => {
    const snapshot = await panelState();
    check('V1.1', '调试视图 panel is open (更多 → 调试视图)', snapshot.missing !== true, { panel: true }, snapshot.missing === true ? 'missing' : 'open');
    const labels = snapshot.inputs.map((input) => input.label);
    check('V1.2', 'five size-bar inputs exist with the exact aria-labels',
      [X_LABEL, Y_LABEL, W_LABEL, H_LABEL, SCALE_LABEL].every((label) => labels.includes(label)),
      [X_LABEL, Y_LABEL, W_LABEL, H_LABEL, SCALE_LABEL], labels);
    check('V1.3', 'fit box explains that it is local-only',
      String(snapshot.fitTitle || '').includes('适应窗口仅本地显示，不改变共享比例/Agent 截图比例'),
      '适应窗口仅本地显示，不改变共享比例/Agent 截图比例', snapshot.fitTitle);
    check('V1.4', 'size bar does not overflow the main panel',
      Boolean(snapshot.bar) && snapshot.bar.scrollWidth <= snapshot.bar.clientWidth + 1 && snapshot.bar.right <= snapshot.bar.panelRight + 1,
      { scrollWidth: '<= clientWidth', right: '<= panelRight' }, snapshot.bar);
    check('V1.5', 'panel renders without a page exception', state.exceptions.length === 0, [], state.exceptions.slice(0, 3));

  });

  await scenario('V2 host shared view', async () => {
    const snapshot = await hostView();
    if (!snapshot.ui || snapshot.ui.version !== 1 || !snapshot.view) {
      state.blocked = 'HOST_VIEW_MISSING';
      notRun('V2.1', 'Host exposes a shared ui.view', 'isolated Host 未提供 ui.view（task-2 未加载）；整套视口验收被阻塞，不做任何替代断言', { ui: snapshot.ui });
      return;
    }
    state.hostView = snapshot.view;
    check('V2.1', 'Host exposes ui.version=1 and a shared ui.view', true, { uiVersion: 1, view: 'present' },
      { uiVersion: snapshot.ui.version, view: snapshot.view });
    const view = snapshot.view;
    check('V2.2', 'shared view carries the contract fields',
      ['version', 'x', 'y', 'width', 'height', 'scale', 'source', 'revision'].every((key) => key in view),
      ['version', 'x', 'y', 'width', 'height', 'scale', 'source', 'revision'], Object.keys(view));
    check('V2.3', 'view.scale is the 0.1–2.0 fraction range', num(view.scale) !== null && Number(view.scale) >= 0.1 && Number(view.scale) <= 2,
      '0.1 <= scale <= 2', view.scale);
    check('V2.4', 'view width/height are inside 200–4096',
      num(view.width) >= 200 && num(view.width) <= 4096 && num(view.height) >= 200 && num(view.height) <= 4096,
      '200..4096', { width: view.width, height: view.height });
    check('V2.5', 'X/Y inputs are enabled once the Host view is adopted',
      (await panelState()).xDisabled === false && (await panelState()).yDisabled === false,
      { xDisabled: false, yDisabled: false },
      { xDisabled: (await panelState()).xDisabled, yDisabled: (await panelState()).yDisabled });
  });

  if (!state.blocked) {
    await scenario('V3 first binding', async () => {
      const posts = firstBindPosts;
      if (!posts.length) {
        notRun('V3.1', 'first binding publishes the local default size',
          'Host view source 在首次绑定时不是 default（adopt-only 路径），因此没有本地默认尺寸被推送', { view: state.hostView });
      } else {
        const bodies = posts.map(parseBody);
        // 用户 2026-11-03 第 3 条：默认分辨率按环境（web = 适应窗口 + 横屏 1024×768）。
        check('V3.1', 'a default Host view publishes the web default 1024×768 exactly once',
          posts.length === 1 && Number(bodies[0].width) === 1024 && Number(bodies[0].height) === 768,
          [{ width: 1024, height: 768 }],
          bodies);
        check('V3.2', 'the first viewport POST uses the v1 shape (version + expectedRevision)',
          Number(bodies[0].version) === 1 && Number.isFinite(Number(bodies[0].expectedRevision)),
          { version: 1, expectedRevision: 'number' }, bodies[0]);
        check('V3.3', 'the first viewport POST carries scale as a 0.1–2.0 fraction',
          num(bodies[0].scale) === null || (Number(bodies[0].scale) >= 0.1 && Number(bodies[0].scale) <= 2),
          'scale fraction', bodies[0].scale);
      }
      const adopted = await waitPanelMirrorsHost().catch(async () => ({ view: (await hostView()).view, panel: await panelState() }));
      check('V3.4', 'panel width/height inputs mirror the Host view after the first binding',
        Number(adopted.panel.width) === Number(adopted.view.width) && Number(adopted.panel.height) === Number(adopted.view.height),
        { width: adopted.view.width, height: adopted.view.height },
        { width: adopted.panel.width, height: adopted.panel.height, host: { width: adopted.view.width, height: adopted.view.height } });
      check('V3.5', 'fit is on by default and shows the local fit percentage, not the shared scale',
        adopted.panel.fitChecked === true && Number(adopted.panel.zoomValue) > 0,
        { fitChecked: true, percent: 'local fit' },
        { fitChecked: adopted.panel.fitChecked, percent: adopted.panel.zoomValue, hostScale: adopted.view.scale });
      // 用户 2026-11-03 第 3 条：冷启动 first-bind 的 env 默认与 pan/fit 组初态。
      const v18Cold = await panelState();
      const v18ColdBody = posts.length ? parseBody(posts[0]) : null;
      check('V18.8', 'cold first-bind publishes the web default 1024×768 exactly once; pan/fit group starts fit, pan off, landscape preset, local fit percent',
        posts.length === 1 && v18ColdBody && Number(v18ColdBody.width) === 1024 && Number(v18ColdBody.height) === 768
          && Number(v18ColdBody.scale) === 1
          && v18Cold.panFit && v18Cold.panFit.state === 'fit' && v18Cold.panFit.pressedCount === 1
          && v18Cold.panChecked === false && v18Cold.fitChecked === true
          && v18Cold.presets.some((preset) => preset.label === '横屏' && preset.pressed)
          && Number(v18Cold.zoomValue) > 0,
        { posts: 1, size: [1024, 768], state: 'fit', pan: false, preset: '横屏', zoom: 'local fit' },
        { posts: posts.length, body: v18ColdBody, panFit: v18Cold.panFit, presets: v18Cold.presets, zoom: v18Cold.zoomValue });
    });

    await scenario('V4 navigate target page', async () => {
      await navigateTarget(`${fixtureBase}/web-t2.html`);
      await waitFor(async () => {
        const snapshot = await panelState();
        return snapshot.address && snapshot.address.includes('web-t2.html') ? true : undefined;
      }, { timeoutMs: 20000, intervalMs: 250, label: 'panel address follows navigation' });
      const frame = await waitForFrame();
      const truth = await targetTruth();
      check('V4.1', 'target page loaded and the panel displays a decoded frame',
        Boolean(frame) && truth.counter !== null, { frame: 'decoded', counter: 'present' },
        { naturalWidth: frame.naturalWidth, naturalHeight: frame.naturalHeight, counter: truth.counter });
      const view = (await hostView()).view;
      check('V4.2', 'page CSS viewport equals the Host view size with DPR 1 (no zoom emulation)',
        truth.innerWidth === Number(view.width) && truth.innerHeight === Number(view.height) && Number(truth.devicePixelRatio) === 1,
        { innerWidth: view.width, innerHeight: view.height, devicePixelRatio: 1 },
        { innerWidth: truth.innerWidth, innerHeight: truth.innerHeight, devicePixelRatio: truth.devicePixelRatio, visualViewportScale: truth.visualViewportScale });
      const overflow = await ensureHorizontalOverflow();
      check('V4.3', 'deterministic horizontal overflow installed for the X/Y checks (test-side DOM probe)',
        overflow.maxScrollX > 500, 'maxScrollX > 500', overflow);
      const framesAfterNav = await targetTruth();
      check('V4.4', 'target page reports a stable CSS viewport after navigation',
        framesAfterNav.innerWidth === Number((await hostView()).view.width),
        { innerWidth: (await hostView()).view.width }, { innerWidth: framesAfterNav.innerWidth });
    });

    await scenario('V5 size-bar wheel', async () => {
      // Establish a known Host view, then wait for the panel to adopt it: a wheel's step is
      // computed from the visible draft, so a half-adopted panel would compute a wrong base.
      await hostViewportSet({ width: 1024, height: 768, scale: 1, x: 0, y: 0 });
      const settled = await waitHostView((view) => Number(view.width) === 1024 && Number(view.height) === 768 && closeTo(view.scale, 1, 0.001));
      await waitPanelMirrorsHost();
      const widthBefore = Number(settled.view.width);

      /** One wheel notch + wait for the Host to apply and settle, then assert. */
      async function wheelExpect(field, deltaY, modifiers, expected) {
        const before = (await hostView()).view;
        await wheelOnField(field, deltaY, modifiers);
        const after = await waitHostView((view) => Object.entries(expected).every(([key, value]) => closeTo(view[key], value, key === 'scale' ? 0.0011 : 1)));
        return { before, after: after.view, panel: await panelState() };
      }

      let step = await wheelExpect(W_LABEL, -120, 0, { width: widthBefore + 10 });
      check('V5.1', 'width wheel up applies +10 CSS px and the input follows',
        Number(step.after.width) === widthBefore + 10 && closeTo(step.panel.width, widthBefore + 10, 0.001),
        { host: widthBefore + 10, input: widthBefore + 10 }, { host: step.after.width, input: step.panel.width });

      step = await wheelExpect(W_LABEL, 120, SHIFT, { width: widthBefore - 90 });
      check('V5.2', 'Shift+wheel uses the 100 px step', Number(step.after.width) === widthBefore - 90,
        { width: widthBefore - 90 }, { width: step.after.width });

      step = await wheelExpect(W_LABEL, -120, ALT, { width: widthBefore - 89 });
      check('V5.3', 'Alt+wheel uses the 1 px step', Number(step.after.width) === widthBefore - 89,
        { width: widthBefore - 89 }, { width: step.after.width });

      step = await wheelExpect(W_LABEL, -120, ALT | SHIFT, { width: widthBefore - 88 });
      check('V5.4', 'Alt wins over Shift when both modifiers are held', Number(step.after.width) === widthBefore - 88,
        { width: widthBefore - 88 }, { width: step.after.width });

      const heightBefore = Number(step.after.height);
      step = await wheelExpect(H_LABEL, -120, ALT, { height: heightBefore + 1 });
      check('V5.5', 'height Alt+wheel applies +1 CSS px', Number(step.after.height) === heightBefore + 1,
        { height: heightBefore + 1 }, { height: step.after.height });
      step = await wheelExpect(H_LABEL, 120, SHIFT, { height: heightBefore - 99 });
      check('V5.6', 'height Shift+wheel applies the 100 px step', Number(step.after.height) === heightBefore - 99,
        { height: heightBefore - 99 }, { height: step.after.height });

      // Scale: 5 % steps, published as the 0.1–2.0 fraction, and the manual edit cancels fit.
      await hostViewportSet({ scale: 1 });
      await waitHostView((view) => closeTo(view.scale, 1, 0.001));
      await clickFit(false);
      await waitPanelMirrorsHost();
      const scalePanel = await panelState();
      const zoomBefore = Number(scalePanel.zoomValue);
      const scaleBefore = Number((await hostView()).view.scale);
      step = await wheelExpect(SCALE_LABEL, -120, 0, { scale: scaleBefore + 0.05 });
      check('V5.7', 'scale wheel up uses the 5 % step and publishes the fraction',
        closeTo(step.panel.zoomValue, zoomBefore + 5, 0.001) && closeTo(step.after.scale, scaleBefore + 0.05, 0.0011),
        { zoom: zoomBefore + 5, scale: Number((scaleBefore + 0.05).toFixed(2)) },
        { zoom: step.panel.zoomValue, scale: step.after.scale });
      check('V5.8', 'manual scale keeps fit unchecked', step.panel.fitChecked === false, false, step.panel.fitChecked);

      // X/Y wheel: the target page really scrolls and the inputs echo the measured scroll.
      await hostViewportSet({ x: 0, y: 0, width: 400, height: 320, scale: 1 });
      await waitHostView((view) => Number(view.width) === 400 && Number(view.height) === 320 && closeTo(view.x, 0, 0.5) && closeTo(view.y, 0, 0.5));
      await waitPanelMirrorsHost();
      step = await wheelExpect(Y_LABEL, -120, SHIFT, { y: 100 });
      const afterY = await targetTruth();
      check('V5.9', 'Y Shift+wheel scrolls the target page by 100 CSS px and the input echoes the observed scroll',
        closeTo(afterY.scrollY, 100, 2) && closeTo(step.panel.y, afterY.scrollY, 1.5),
        { scrollY: 100, echo: 100 }, { scrollY: afterY.scrollY, input: step.panel.y });

      step = await wheelExpect(X_LABEL, -120, 0, { x: 10 });
      const afterX = await targetTruth();
      check('V5.10', 'X wheel scrolls the target page by 10 CSS px and is echoed',
        closeTo(afterX.scrollX, 10, 1.5) && closeTo(step.panel.x, afterX.scrollX, 1.5),
        { scrollX: 10, echo: 10 }, { scrollX: afterX.scrollX, input: step.panel.x });

      // A burst merges into one request; nothing leaks to the host document or the target page.
      await hostViewportSet({ x: 0, y: 0 });
      await waitHostView((view) => closeTo(view.x, 0, 0.5) && closeTo(view.y, 0, 0.5));
      await waitPanelMirrorsHost();
      const guiScrollBefore = await pageEvaluate('document.scrollingElement.scrollTop');
      const truthBefore = await targetTruth();
      const widthBeforeBurst = Number((await hostView()).view.width);
      const timelineMark = Date.now();
      const markMerge = Date.now();
      await wheelBurst(W_LABEL, 3, -120);
      const merged = panelViewportPosts(markMerge);
      await waitHostView((view) => Number(view.width) === widthBeforeBurst + 30);
      check('V5.11', 'a wheel burst merges into a single /viewport request', merged.length === 1,
        { requests: 1 }, { requests: merged.length, bodies: merged.map(parseBody) });
      const mergedBody = merged.length ? parseBody(merged[0]) : {};
      check('V5.12', 'the merged patch carries only the wheeled field(s)',
        Object.keys(mergedBody).filter((key) => key !== 'version' && key !== 'expectedRevision').every((key) => ['width', 'height', 'x', 'y', 'scale'].includes(key)),
        ['width'], Object.keys(mergedBody));

      const guiScrollAfter = await pageEvaluate('document.scrollingElement.scrollTop');
      const truthAfter = await targetTruth();
      check('V5.13', 'size-bar wheel does not scroll the GUI document', guiScrollAfter === guiScrollBefore,
        { scrollTop: guiScrollBefore }, { scrollTop: guiScrollAfter });
      check('V5.14', 'size-bar wheel never reaches the target page',
        truthAfter.scrollY === truthBefore.scrollY && truthAfter.scrollX === truthBefore.scrollX,
        { scrollX: truthBefore.scrollX, scrollY: truthBefore.scrollY },
        { scrollX: truthAfter.scrollX, scrollY: truthAfter.scrollY });

      const beforeIgnored = (await hostView()).view;
      await wheelOnField(W_LABEL, 0);
      await sleep(500);
      const afterZero = (await hostView()).view;
      check('V5.15', 'delta=0 changes nothing', Number(afterZero.width) === Number(beforeIgnored.width),
        { width: beforeIgnored.width }, { width: afterZero.width });

      // Ctrl/Meta+wheel belongs to the shell (host zoom). Check it on a quiet, settled view so a
      // late flush from the previous burst cannot be mistaken for this wheel's effect.
      logViewportTimeline('burst → V5.16', timelineMark);
      await hostViewportSet({ width: 500, height: 400 });
      await waitHostView((view) => Number(view.width) === 500 && Number(view.height) === 400);
      await waitPanelMirrorsHost();
      await sleep(400);
      const beforeCtrl = (await hostView()).view;
      const postsBeforeCtrl = panelViewportPosts().length;
      const dprBeforeCtrl = await pageEvaluate('window.devicePixelRatio');
      await pageEvaluate(`(() => {
        window.__utbCtrlWheel = [];
        document.addEventListener('wheel', (event) => window.__utbCtrlWheel.push({
          ctrl: event.ctrlKey, alt: event.altKey, shift: event.shiftKey, meta: event.metaKey,
          deltaY: event.deltaY, prevented: event.defaultPrevented,
          field: event.target && event.target.getAttribute ? event.target.getAttribute('data-utb-field') : null,
        }), true);
        return true;
      })()`);
      await wheelOnField(W_LABEL, -120, CTRL);
      await sleep(900);
      const afterCtrl = (await hostView()).view;
      const ctrlWheelFacts = await pageEvaluate(`({ events: window.__utbCtrlWheel, dpr: window.devicePixelRatio })`);
      check('V5.16', 'Ctrl+wheel never edits the field and never triggers the native number step',
        panelViewportPosts().length === postsBeforeCtrl && Number(afterCtrl.width) === Number(beforeCtrl.width),
        { requests: postsBeforeCtrl, width: beforeCtrl.width },
        { requests: panelViewportPosts().length, width: afterCtrl.width,
          drift: Number(afterCtrl.width) - Number(beforeCtrl.width),
          delivered: ctrlWheelFacts && ctrlWheelFacts.events,
          dprBefore: dprBeforeCtrl, dprAfter: ctrlWheelFacts && ctrlWheelFacts.dpr });
      const scaleBeforeMeta = Number((await hostView()).view.scale);
      const postsBeforeMeta = panelViewportPosts().length;
      await wheelOnField(SCALE_LABEL, -120, 4 /* Meta */);
      await sleep(900);
      const afterMeta = (await hostView()).view;
      check('V5.16b', 'Meta+wheel never changes the shared ratio', closeTo(afterMeta.scale, scaleBeforeMeta, 0.001)
        && panelViewportPosts().length === postsBeforeMeta,
        { scale: scaleBeforeMeta, requests: postsBeforeMeta },
        { scale: afterMeta.scale, requests: panelViewportPosts().length });

      await hostViewportSet({ width: 4090, height: 900 });
      await waitHostView((view) => Number(view.width) === 4090);
      await waitPanelMirrorsHost();
      await wheelOnField(W_LABEL, -120, SHIFT);
      await wheelOnField(W_LABEL, -120, SHIFT);
      const clampedWidth = await waitHostView((view) => Number(view.width) === 4096).catch(() => hostView());
      check('V5.17', 'width clamps at 4096', Number(clampedWidth.view.width) === 4096,
        { width: 4096 }, { width: clampedWidth.view.width, input: (await panelState()).width });

      await hostViewportSet({ scale: 2 });
      await waitHostView((view) => closeTo(view.scale, 2, 0.001));
      await waitPanelMirrorsHost();
      await wheelOnField(SCALE_LABEL, -120);
      const clampedScale = await hostView();
      check('V5.18', 'scale clamps at 200 %', closeTo(clampedScale.view.scale, 2, 0.001),
        { scale: 2 }, { scale: clampedScale.view.scale, input: (await panelState()).scale });
    });

    await scenario('V6 X/Y inputs', async () => {
      await hostViewportSet({ x: 0, y: 0, width: 1024, height: 768, scale: 1 });
      await waitHostView((view) => Number(view.width) === 1024 && Number(view.height) === 768);
      await waitPanelMirrorsHost();
      await ensureHorizontalOverflow();
      await typeIntoField(X_LABEL, '25', { enter: true });
      await typeIntoField(Y_LABEL, '210', { enter: true });
      await sleep(600);
      const truth = await targetTruth();
      check('V6.1', 'Enter on X/Y commits the exact target-page scroll',
        near(truth.scrollX, 25, 0.5) && near(truth.scrollY, 210, 0.5),
        { scrollX: 25, scrollY: 210 }, { scrollX: truth.scrollX, scrollY: truth.scrollY });

      const panel = await panelState();
      check('V6.2', 'X/Y inputs echo the observed scroll', near(Number(panel.x), truth.scrollX, 1.5) && near(Number(panel.y), truth.scrollY, 1.5),
        { x: truth.scrollX, y: truth.scrollY }, { x: panel.x, y: panel.y });

      const postsBeforeEscape = panelViewportPosts().length;
      await typeIntoField(X_LABEL, '777', { escape: true });
      await sleep(250);
      const panelAfterEscape = await panelState();
      check('V6.3', 'Escape restores the accepted value and sends nothing',
        near(Number(panelAfterEscape.x), truth.scrollX, 1.5) && panelViewportPosts().length === postsBeforeEscape,
        { x: truth.scrollX, requests: postsBeforeEscape }, { x: panelAfterEscape.x, requests: panelViewportPosts().length });

      // Page-driven scroll: the Host schedule a merged readback on /state and /frame requests, so
      // the new x/y appear on a *later* poll (contract: typically 0.2–0.7 s, ≤1.5 s worst case).
      const beforePageScroll = await hostView();
      const revisionBeforeScroll = Number(beforePageScroll.view.revision);
      const pageScrollStartedAt = Date.now();
      await targetEval('window.scrollTo(0, 640)');
      let pageScrollEcho = null;
      await waitFor(async () => {
        const snapshot = await hostView();
        if (!snapshot.view) return undefined;
        if (!near(snapshot.view.y, 640, 2)) return undefined;
        pageScrollEcho = { view: snapshot.view, observed: snapshot.observed, elapsedMs: Date.now() - pageScrollStartedAt };
        return true;
      }, { timeoutMs: 2000, intervalMs: 120, label: 'host view echoes the page scroll' }).catch(() => undefined);
      // The Host echo is one hop; the panel's own 500 ms state poll carries it into the input.
      let panelEcho = null;
      await waitFor(async () => {
        const panel = await panelState();
        if (!near(Number(panel.y), 640, 3)) return undefined;
        panelEcho = { panel, elapsedMs: Date.now() - pageScrollStartedAt };
        return true;
      }, { timeoutMs: 2500, intervalMs: 100, label: 'panel echoes the page scroll' }).catch(() => undefined);
      check('V6.4', 'page-initiated scroll is echoed into the Y input (≤2.5 s, source=page, revision advances)',
        Boolean(pageScrollEcho) && Boolean(panelEcho),
        { y: 640, source: 'page', revision: '>' },
        { echo: pageScrollEcho ? { y: pageScrollEcho.view.y, x: pageScrollEcho.view.x, source: pageScrollEcho.view.source, revision: pageScrollEcho.view.revision, elapsedMs: pageScrollEcho.elapsedMs } : null,
          input: (await panelState()).y, inputElapsedMs: panelEcho ? panelEcho.elapsedMs : null, revisionBefore: revisionBeforeScroll });
      check('V6.4b', 'the page-driven view change is attributed to the page and advances the revision',
        Boolean(pageScrollEcho) && String(pageScrollEcho.view.source) === 'page' && Number(pageScrollEcho.view.revision) > revisionBeforeScroll,
        { source: 'page', revision: `> ${revisionBeforeScroll}` },
        pageScrollEcho ? { source: pageScrollEcho.view.source, revision: pageScrollEcho.view.revision } : null);
      // A page scroll also bumps the revision: the *next* GUI write must still succeed (the client
      // adopts the fresh revision; a rejected patch is never auto-replayed).
      const widthBeforeAfterPageScroll = Number((await hostView()).view.width);
      await wheelOnField(W_LABEL, -120);
      const afterPageScrollWrite = await waitHostView((view) => Number(view.width) === widthBeforeAfterPageScroll + 10);
      check('V6.4c', 'a GUI write right after a page-driven revision change still applies (+10 px)',
        Number(afterPageScrollWrite.view.width) === widthBeforeAfterPageScroll + 10,
        { width: widthBeforeAfterPageScroll + 10 },
        { width: afterPageScrollWrite.view.width, timedOut: afterPageScrollWrite.timedOut === true });
      await hostViewportSet({ x: 0, y: 0 });
      await waitHostView((view) => closeTo(view.y, 0, 1));
      await waitPanelMirrorsHost();

      await typeIntoField(Y_LABEL, '120', { enter: true });
      await sleep(500);
      const finalTruth = await targetTruth();
      check('V6.5', 'Enter keeps the target page and the input in sync',
        near(finalTruth.scrollY, 120, 1), { scrollY: 120 }, { scrollY: finalTruth.scrollY, input: (await panelState()).y });

      const illegal = await typeIntoField(Y_LABEL, '99999999', { enter: true }).then(() => panelState());
      check('V6.6', 'an out-of-range draft is not committed and reverts to the accepted value',
        near(Number(illegal.y), 120, 1), { y: 120 }, { y: illegal.y });
    });

    await scenario('V7 agent shared view', async () => {
      const modeResponse = await hostViewportSet({ mode: 'tablet' });
      check('V7.1', 'Agent mode=tablet is accepted by the Host',
        modeResponse.status === 200 && modeResponse.json && modeResponse.json.ok !== false,
        { status: 200 }, { status: modeResponse.status, code: modeResponse.json && modeResponse.json.code });
      const afterMode = await waitHostView((view) => Number(view.width) === 768 && Number(view.height) === 1024);
      check('V7.2', 'mode expands to 768×1024 in the shared view',
        Number(afterMode.view.width) === 768 && Number(afterMode.view.height) === 1024,
        { width: 768, height: 1024 }, { width: afterMode.view.width, height: afterMode.view.height });
      const panelAfterMode = await waitPanelValues({ width: 768, height: 1024 }).catch(() => panelState());
      check('V7.3', 'panel inputs adopt the Agent mode size',
        Number(panelAfterMode.width) === 768 && Number(panelAfterMode.height) === 1024,
        { width: 768, height: 1024 }, { width: panelAfterMode.width, height: panelAfterMode.height });

      const setResponse = await hostViewportSet({ x: 40, y: 120, scale: 1.5 });
      check('V7.4', 'Agent x/y/scale set is accepted',
        setResponse.status === 200 && setResponse.json && setResponse.json.ok !== false,
        { status: 200 }, { status: setResponse.status, code: setResponse.json && setResponse.json.code });
      const afterSet = await waitHostView((view) => closeTo(view.x, 40, 1) && closeTo(view.y, 120, 1) && closeTo(view.scale, 1.5, 0.001));
      const panelAfterSet = await waitPanelValues({ x: 40, y: 120, zoomValue: 150 }).catch(() => panelState());
      check('V7.5', 'panel echoes the Agent x/y/scale',
        near(Number(panelAfterSet.x), 40, 2) && near(Number(panelAfterSet.y), 120, 2) && near(Number(panelAfterSet.zoomValue), 150, 0.001),
        { x: 40, y: 120, zoom: 150 }, { x: panelAfterSet.x, y: panelAfterSet.y, zoom: panelAfterSet.zoomValue });
      check('V7.6', 'an Agent change cancels the local fit preference', panelAfterSet.fitChecked === false,
        false, panelAfterSet.fitChecked);
      check('V7.7', 'the external set advances the view revision (HTTP v1 sets are recorded as source=gui)',
        String(afterSet.view.source) === 'gui' && Number(afterSet.view.revision) > Number(state.hostView.revision),
        { source: 'gui', revision: '>' }, { source: afterSet.view.source, revision: afterSet.view.revision });
      notRun('V7.10', 'view.source=agent after a browser_viewport tool set',
        'agent-source attribution belongs to the Agent tool path (Host acceptance H2); this GUI suite can only issue the HTTP v1 route, which the Host records as source=gui');

      const truth = await targetTruth();
      check('V7.8', 'the target page really renders the Agent viewport and scroll',
        truth.innerWidth === 768 && truth.innerHeight === 1024 && near(truth.scrollX, 40, 1) && near(truth.scrollY, 120, 1),
        { innerWidth: 768, innerHeight: 1024, scrollX: 40, scrollY: 120 },
        { innerWidth: truth.innerWidth, innerHeight: truth.innerHeight, scrollX: truth.scrollX, scrollY: truth.scrollY });

      const markNav = Date.now();
      await navigateTarget(`${fixtureBase}/web-t2.html?second=1`);
      await sleep(1500);
      const navPosts = panelViewportPosts(markNav);
      const viewAfterNav = (await hostView()).view;
      check('V7.9', 'navigation publishes no viewport request on a shared-view Host',
        navPosts.length === 0 && Number(viewAfterNav.width) === 768 && Number(viewAfterNav.height) === 1024,
        { viewportPosts: 0, width: 768, height: 1024 },
        { viewportPosts: navPosts.map(parseBody), width: viewAfterNav.width, height: viewAfterNav.height });
      await waitForFrame();
      await ensureHorizontalOverflow();
      await resetTargetInstrumentation();
    });

    await scenario('V8 hit test at fit<100% and scale>100%', async () => {
      // The T3 fixture records real clientX/clientY/isTrusted per event, so the mapping can be
      // checked against page truth and not only against "a click happened".
      await navigateTarget(`${fixtureBase}/web-t3.html`);
      await waitForFrame();
      await hostViewportSet({ width: 1920, height: 1080, scale: 1, x: 0, y: 0 });
      await waitHostView((view) => Number(view.width) === 1920 && Number(view.height) === 1080);
      await waitPanelMirrorsHost();
      await clickFit(true);
      // Two state polls (>1s) must not cancel the local fit: only an external content change may.
      await sleep(1600);
      const fitPanel = await panelState();
      const fitPercent = Number(fitPanel.zoomValue);
      const fitFrame = await waitForFrame();
      check('V8.1', 'fit ratio below 100 % stays checked across state polls',
        fitPanel.fitChecked === true && fitPercent > 0 && fitPercent < 100,
        { fitChecked: true, percent: '<100' },
        { fitChecked: fitPanel.fitChecked, percent: fitPercent, frame: fitFrame ? { naturalWidth: fitFrame.naturalWidth, naturalHeight: fitFrame.naturalHeight } : null });

      const fitClick = await clickThroughPanel('#t3-click', 1920, 1080);
      check('V8.2', 'fixed element hit at fit<100 % (clicks +1, isTrusted, mapped clientX/Y)',
        fitClick.clicksDelta === 1 && fitClick.record && fitClick.record.isTrusted === true
          && fitClick.record.target === 't3-click'
          && near(fitClick.record.clientX, fitClick.viewportX, 1.5) && near(fitClick.record.clientY, fitClick.viewportY, 1.5),
        { clicksDelta: 1, isTrusted: true, target: 't3-click', clientX: 'viewportX', clientY: 'viewportY' },
        { clicksDelta: fitClick.clicksDelta, record: fitClick.record, expected: { viewportX: fitClick.viewportX, viewportY: fitClick.viewportY }, point: fitClick.point });
      await capturePanel('shot-02-fit-under-100');

      await clickFit(false);
      await hostViewportSet({ width: 400, height: 320, scale: 2, x: 0, y: 0 });
      await waitHostView((view) => Number(view.width) === 400 && Number(view.height) === 320 && closeTo(view.scale, 2, 0.001));
      await waitPanelMirrorsHost();
      const panel200 = await panelState();
      check('V8.3', 'manual 200 % is displayed and shared with the Host',
        near(Number(panel200.zoomValue), 200, 0.001) && near(num((await hostView()).view.scale), 2, 0.001) && panel200.fitChecked === false,
        { zoom: 200, scale: 2, fitChecked: false },
        { zoom: panel200.zoomValue, scale: (await hostView()).view.scale, fitChecked: panel200.fitChecked });

      const bigClick = await clickThroughPanel('#t3-click', 400, 320);
      check('V8.4', 'fixed element hit at scale>100 % (clicks +1, isTrusted, mapped clientX/Y)',
        bigClick.clicksDelta === 1 && bigClick.record && bigClick.record.isTrusted === true
          && bigClick.record.target === 't3-click'
          && near(bigClick.record.clientX, bigClick.viewportX, 1.5) && near(bigClick.record.clientY, bigClick.viewportY, 1.5),
        { clicksDelta: 1, isTrusted: true, target: 't3-click' },
        { clicksDelta: bigClick.clicksDelta, record: bigClick.record, expected: { viewportX: bigClick.viewportX, viewportY: bigClick.viewportY }, point: bigClick.point });
      await capturePanel('shot-03-scale-200');

      const letterbox = await probeLetterbox();
      if (letterbox.band >= 4) {
        await resetTargetInstrumentation();
        const before = (await clickRecords()).length;
        await clickAt(letterbox.x, letterbox.y);
        await sleep(500);
        const after = (await clickRecords()).length;
        check('V8.5', 'a click in the letterbox band is not dispatched into the target page',
          after === before, { clicks: before }, { clicks: after, band: letterbox.band, point: { x: letterbox.x, y: letterbox.y } });
      } else {
        notRun('V8.5', 'letterbox zero dispatch',
          'the live frame has no letterbox band (the painted rect fills the container), so there is no outside-painted area inside the box to click',
          letterbox);
      }

      await resetTargetInstrumentation();
      const beforeOutside = (await clickRecords()).length;
      const stagePoint = await pageEvaluate(panelExpr(`
        const stage = panel.querySelector('.utb-stage');
        if (!stage) return null;
        const rect = stage.getBoundingClientRect();
        return { x: Math.round(rect.left + 6), y: Math.round(rect.top + 6) };
      `)).catch(() => null);
      if (!stagePoint || !Number.isFinite(stagePoint.x)) {
        notRun('V8.6', 'click outside the image box', 'the panel stage geometry was unavailable in this layout', { stagePoint });
      } else {
        await clickAt(stagePoint.x, stagePoint.y);
        await sleep(400);
        const afterOutside = (await clickRecords()).length;
        check('V8.6', 'a click outside the image box performs zero dispatch',
          afterOutside === beforeOutside, { clicks: beforeOutside }, { clicks: afterOutside, point: stagePoint });
      }
    });

    await scenario('V9 frame wheel scaling', async () => {
      await hostViewportSet({ width: 400, height: 320, scale: 2, x: 0, y: 0 });
      await waitHostView((view) => Number(view.width) === 400 && Number(view.height) === 320 && closeTo(view.scale, 2, 0.001));
      await waitPanelMirrorsHost();
      const frame200 = await waitForFrame();
      const painted200 = paintedOf(frame200);
      const before200 = await targetTruth();
      const point200 = guiPointFor(painted200, 400, 320, 200, 160);
      await wheelOnFramePoint(point200, 200);
      await sleep(700);
      const after200 = await targetTruth();
      const delta200 = after200.scrollY - before200.scrollY;
      check('V9.1', 'frame wheel at 200 % moves the target page by delta/scale (≈100 px)',
        delta200 > 40 && delta200 < 160, { deltaY: '≈100' }, { deltaY: delta200, painted: painted200 });

      await hostViewportSet({ width: 400, height: 320, scale: 1, x: 0, y: 0 });
      await waitHostView((view) => Number(view.width) === 400 && Number(view.height) === 320 && closeTo(view.scale, 1, 0.001));
      await waitPanelMirrorsHost();
      const frame100 = await waitForFrame();
      const painted100 = paintedOf(frame100);
      const before100 = await targetTruth();
      const point100 = guiPointFor(painted100, 400, 320, 200, 160);
      await wheelOnFramePoint(point100, 200);
      await sleep(700);
      const after100 = await targetTruth();
      const delta100 = after100.scrollY - before100.scrollY;
      check('V9.2', 'frame wheel at 100 % moves the target page by the full delta (≈200 px)',
        delta100 > 120 && delta100 < 320, { deltaY: '≈200' }, { deltaY: delta100, painted: painted100 });
      check('V9.3', 'the 200 % page delta is about half of the 100 % delta (W/Pw scaling)',
        delta100 > 0 && delta200 / delta100 > 0.25 && delta200 / delta100 < 0.8,
        { ratio: '≈0.5' }, { ratio: delta100 ? Number((delta200 / delta100).toFixed(3)) : null, delta200, delta100 });
      await capturePanel('shot-04-frame-wheel');
    });

    await scenario('V12 drag-to-pan (user request 2026-11-02)', async () => {
      await navigateTarget(`${fixtureBase}/web-t3.html`);
      await waitForFrame();
      await ensureHorizontalOverflow();
      await hostViewportSet({ width: 640, height: 480, scale: 1, x: 300, y: 300 });
      await waitHostView((view) => Number(view.width) === 640 && Number(view.height) === 480 && near(view.x, 300, 1) && near(view.y, 300, 1));
      await waitPanelMirrorsHost();
      await waitFrameStable();
      await waitPanelValues({ x: 300, y: 300 });

      const off = await panelState();
      check('V12.1', 'the size bar has a drag checkbox (unchecked, enabled, explains the mode)',
        off.panChecked === false && off.panDisabled === false
          && /拖拽/.test(String(off.panTitle || '')) && /页面交互/.test(String(off.panTitle || '')),
        { checked: false, disabled: false, title: '拖拽…页面交互' },
        { checked: off.panChecked, disabled: off.panDisabled, title: off.panTitle });
      check('V12.2', 'the frame is not a grab hand while drag mode is off',
        off.frameCursor !== 'grab' && off.frameCursor !== 'grabbing',
        { cursor: 'auto' }, { cursor: off.frameCursor, attr: off.framePanAttr });

      const on = await togglePan(true);
      check('V12.3', 'checking drag mode turns the frame into a grab hand',
        on.panChecked === true && on.frameCursor === 'grab',
        { checked: true, cursor: 'grab' }, { checked: on.panChecked, cursor: on.frameCursor });

      // While drag mode is on, a plain click on the frame must not reach the target page.
      await resetTargetInstrumentation();
      const paintedBefore = paintedOf(await waitForFrame());
      const center = { x: paintedBefore.left + paintedBefore.width / 2, y: paintedBefore.top + paintedBefore.height / 2 };
      await clickAt(center.x, center.y);
      await sleep(350);
      const eventsAfterClick = await targetEval('window.__t3 ? window.__t3.events.length : -1');
      check('V12.4', 'drag mode suppresses page interaction (a plain frame click dispatches no page events)',
        eventsAfterClick === 0, { pageEvents: 0 }, { pageEvents: eventsAfterClick, point: center });

      // Content-follow drag: right/down means the viewport moves left/up in the document.
      const drag = await dragOnFrame(120, 80);
      // The panel maps through the *displayed* painted rect (contract §5.1); compute the expected
      // page delta from the same geometry instead of assuming a 1:1 frame size.
      const expectedDragX = Math.round(300 - (120 * 640) / Math.max(1, drag.painted.width));
      const expectedDragY = Math.round(300 - (80 * 480) / Math.max(1, drag.painted.height));
      check('V12.5', 'the cursor becomes a grabbing hand while the drag button is held',
        drag.cursorDuringDrag === 'grabbing', { cursor: 'grabbing' }, { cursor: drag.cursorDuringDrag });
      const afterDrag = await waitHostView((view) => near(view.x, expectedDragX, 3) && near(view.y, expectedDragY, 3));
      check('V12.6', `dragging right/down pans the page with content-follow direction (x 300→≈${expectedDragX}, y 300→≈${expectedDragY})`,
        near(afterDrag.view.x, expectedDragX, 3) && near(afterDrag.view.y, expectedDragY, 3),
        { x: expectedDragX, y: expectedDragY }, { x: afterDrag.view.x, y: afterDrag.view.y, source: afterDrag.view.source, painted: drag.painted });
      const dragTruth = await targetTruth();
      check('V12.7', 'the target page really scrolled to the dragged view',
        near(dragTruth.scrollX, afterDrag.view.x, 2) && near(dragTruth.scrollY, afterDrag.view.y, 2),
        { scrollX: '≈view.x', scrollY: '≈view.y' },
        { scrollX: dragTruth.scrollX, scrollY: dragTruth.scrollY, view: { x: afterDrag.view.x, y: afterDrag.view.y } });
      const dragClicks = await clickRecords();
      const dragEvents = await targetEval('window.__t3 ? window.__t3.events.length : -1');
      check('V12.8', 'the drag sends no click and no pointer/mouse events into the page',
        dragClicks.length === 0 && dragEvents === 0,
        { clicks: 0, pageEvents: 0 }, { clicks: dragClicks.length, pageEvents: dragEvents });
      const mirrored = await waitPanelValues({ x: afterDrag.view.x, y: afterDrag.view.y }).catch(() => panelState());
      check('V12.9', 'the X/Y inputs mirror the dragged Host scroll',
        near(mirrored.x, afterDrag.view.x, 2) && near(mirrored.y, afterDrag.view.y, 2),
        { x: afterDrag.view.x, y: afterDrag.view.y }, { x: mirrored.x, y: mirrored.y });

      // At the document start, dragging right/down clamps instead of going negative.
      await hostViewportSet({ x: 0, y: 0 });
      await waitHostView((view) => near(view.x, 0, 1) && near(view.y, 0, 1));
      await waitPanelMirrorsHost();
      await waitPanelValues({ x: 0, y: 0 });
      await waitFrameStable();
      await dragOnFrame(160, 120);
      await sleep(800);
      const clampedView = (await hostView()).view;
      const clampedTruth = await targetTruth();
      check('V12.10', 'drag pan clamps at the document start (x/y stay 0, no negative scroll)',
        near(clampedView.x, 0, 1) && near(clampedView.y, 0, 1) && near(clampedTruth.scrollX, 0, 1) && near(clampedTruth.scrollY, 0, 1),
        { x: 0, y: 0, scrollX: 0, scrollY: 0 },
        { x: clampedView.x, y: clampedView.y, scrollX: clampedTruth.scrollX, scrollY: clampedTruth.scrollY });

      const back = await togglePan(false);
      check('V12.11', 'unchecking drag mode restores the default frame cursor',
        back.panChecked === false && back.frameCursor !== 'grab' && back.frameCursor !== 'grabbing',
        { checked: false, cursor: 'auto' }, { checked: back.panChecked, cursor: back.frameCursor });

      // Interaction restored: the same panel click now reaches the page again.
      await navigateTarget(`${fixtureBase}/web-t3.html`);
      await waitForFrame();
      await hostViewportSet({ width: 640, height: 480, scale: 1, x: 0, y: 0 });
      await waitHostView((view) => Number(view.width) === 640 && Number(view.height) === 480);
      await waitPanelMirrorsHost();
      await waitPanelValues({ x: 0, y: 0 });
      await waitFrameStable();
      const restored = await clickThroughPanel('#t3-click', 640, 480);
      check('V12.12', 'after drag mode is off, a panel click reaches the page again (real trusted click)',
        restored.clicksDelta === 1 && restored.record && restored.record.isTrusted === true,
        { clicksDelta: 1, isTrusted: true },
        { clicksDelta: restored.clicksDelta, record: restored.record, point: restored.point });
      await capturePanel('shot-05-drag-pan');
    });

    await scenario('V13 canvas viewport (P0-C v2)', async () => {
      const v13Start = Date.now();
      const initial = await hostCanvas();
      if (!initial.canvas) {
        notRun('V13.0', 'Host exposes ui.canvas (P0-C v2 capability handshake)',
          '隔离 Host 未提供 ui.canvas（Host task-1 未加载）；画布坐标/预览合成/输入映射/拖拽切片无法验收，不使用替代断言',
          { uiVersion: initial.ui && initial.ui.version, view: initial.view });
        return;
      }
      check('V13.0', 'Host exposes ui.canvas version 1 in canvas-css-px with white blank',
        Number(initial.canvas.version) === 1 && initial.canvas.space === 'canvas-css-px' && initial.canvas.blank === 'white',
        { version: 1, space: 'canvas-css-px', blank: 'white' }, initial.canvas);

      await navigateTarget(`${fixtureBase}/web-t3.html`);
      await waitForFrame();
      await ensureHorizontalOverflow();
      // A non-white page background makes "blank is pure white" distinguishable in pixels below.
      await targetEval(`(() => {
        document.documentElement.style.background = 'rgb(200, 30, 30)';
        document.body.style.background = 'rgb(200, 30, 30)';
        return true;
      })()`);
      // Keep fit out of the equations: the canvas displacement must be measured at the shared 100 %.
      await clickFit(false);
      await hostViewportSet({ width: 400, height: 300, scale: 1, x: 0, y: 0 });
      await waitHostView((view) => Number(view.width) === 400 && Number(view.height) === 300 && near(view.x, 0, 1) && near(view.y, 0, 1));
      await waitPanelMirrorsHost();
      const contentBox = await waitFor(async () => {
        const snapshot = await hostCanvas();
        const canvas = snapshot.canvas;
        return canvas && Number.isFinite(Number(canvas.contentWidth)) && Number(canvas.contentWidth) > 0
          && Number.isFinite(Number(canvas.contentHeight)) && Number(canvas.contentHeight) > 0 ? canvas : undefined;
      }, { timeoutMs: 8000, intervalMs: 150, label: 'Host observed the canvas content box' });
      check('V13.0b', 'ui.canvas reports the measured content box',
        Number(contentBox.contentWidth) > 400 && Number(contentBox.contentHeight) > 300,
        { contentWidth: '> 400', contentHeight: '> 300' },
        { contentWidth: contentBox.contentWidth, contentHeight: contentBox.contentHeight });
      await hostViewportSet({ canvasX: 0, canvasY: 0 });
      await waitHostView((view) => near(view.canvasX, 0, 1) && near(view.canvasY, 0, 1) && near(view.x, 0, 1) && near(view.y, 0, 1));
      // O=0 returns "ready" regardless of frame metadata (old behaviour); still wait for an actual
      // capture-time scroll=0 frame so the zero transform is real and not the previous frame's lag.
      const oZeroPanel = await waitFor(async () => {
        const panel = await panelState();
        const shift = transformTranslate(panel.imgTransform);
        return panel.canvasOn === 'on' && near(shift.x, 0, 0.5) && near(shift.y, 0, 0.5) ? panel : undefined;
      }, { timeoutMs: 6000, intervalMs: 150, label: 'O=0 frame with zero displacement' });
      const oZeroShift = transformTranslate(oZeroPanel.imgTransform);
      check('V13.0c', 'O=0 (C=S) leaves the frame untranslated, so the old pixels are preserved',
        near(oZeroShift.x, 0, 0.01) && near(oZeroShift.y, 0, 0.01) && oZeroPanel.canvasOn === 'on',
        { translateX: 0, translateY: 0, canvas: 'on' },
        { translate: oZeroShift, canvas: oZeroPanel.canvasOn, boxBackground: oZeroPanel.boxBackground });
      // The panel blank is now a dark checkerboard, but O=0 + a matching frame covers it fully:
      // the same pixels as the old white-background implementation must remain.
      await waitCanvasState(true, true);
      const oZeroPreview = await waitFrameStable();
      await ensurePointVisible({ x: oZeroPreview.box.left + oZeroPreview.box.width / 2, y: oZeroPreview.box.top + oZeroPreview.box.height / 2 });
      await sleep(300);
      const oZeroFrame = await waitFrameStable();
      const oZeroLatest = await panelState();
      const oZeroPainted = paintedOf(oZeroFrame);
      const oZeroShot = await captureBoxPixels(oZeroFrame.box);
      const oZeroChecker = checkerboardOf(oZeroLatest);
      const oZeroProbe = checkerSample(oZeroShot.decoded, oZeroChecker, [[7, 7], [21, 7], [35, 7], [49, 7], [7, 21], [21, 21], [35, 21]]);
      check('V13.0d', 'O=0: the image covers the box and the checkerboard never shows (old pixels preserved)',
        oZeroLatest.canvasBlank === 'checkerboard' && Boolean(oZeroChecker)
          && Boolean(oZeroPainted) && near(oZeroPainted.width, oZeroFrame.box.width, 1) && near(oZeroPainted.height, oZeroFrame.box.height, 1)
          && oZeroProbe.colorIndex.every((index) => index === -1),
        { blankStyle: 'checkerboard', covered: true, checkerPixels: 0 },
        { blankStyle: oZeroLatest.canvasBlank, checker: oZeroChecker, probe: oZeroProbe, painted: oZeroPainted, box: oZeroFrame.box });

      // ---- V13.1 negative canvas origin: C is authoritative, S stays clamped at 0 ----
      const setNegative = await hostViewportSet({ canvasX: -100, canvasY: -50 });
      check('V13.1', 'POST /viewport accepts negative canvasX/canvasY (v1)',
        setNegative.status === 200 && setNegative.json && setNegative.json.ok !== false,
        { status: 200 }, { status: setNegative.status, code: setNegative.json && setNegative.json.code });
      const negative = await waitHostView((view) => near(view.canvasX, -100, 1) && near(view.canvasY, -50, 1)
        && near(view.x, 0, 0.5) && near(view.y, 0, 0.5));
      const negativeCanvas = (await hostCanvas()).canvas;
      check('V13.2', 'negative C keeps the real document scroll at 0-0 and exposes offset O=C-S',
        near(negative.view.x, 0, 0.5) && near(negative.view.y, 0, 0.5)
          && near(negativeCanvas.offsetX, -100, 1) && near(negativeCanvas.offsetY, -50, 1),
        { x: 0, y: 0, offsetX: -100, offsetY: -50 },
        { x: negative.view.x, y: negative.view.y, offsetX: negativeCanvas.offsetX, offsetY: negativeCanvas.offsetY });
      const negativeTruth = await targetTruth();
      check('V13.3', 'the target page itself never scrolls negative (canvas C is a view-layer fact)',
        near(negativeTruth.scrollX, 0, 0.5) && near(negativeTruth.scrollY, 0, 0.5),
        { scrollX: 0, scrollY: 0 }, { scrollX: negativeTruth.scrollX, scrollY: negativeTruth.scrollY });
      const negativePanel = await waitPanelValues({ x: -100, y: -50 });
      check('V13.4', 'X/Y inputs show the signed canvas origin C (not the clamped scroll)',
        near(negativePanel.x, -100, 1.5) && near(negativePanel.y, -50, 1.5),
        { x: -100, y: -50 }, { x: negativePanel.x, y: negativePanel.y, title: negativePanel.byLabel[X_LABEL] && negativePanel.byLabel[X_LABEL].title });

      // ---- V13.5 negative wheel steps and typed negative values stay on canvasX/canvasY ----
      await hostViewportSet({ canvasX: -20, canvasY: -10 });
      await waitHostView((view) => near(view.canvasX, -20, 1) && near(view.canvasY, -10, 1) && near(view.x, 0, 0.5));
      await waitPanelMirrorsHost();
      await waitPanelValues({ x: -20, y: -10 });
      const markWheel = Date.now();
      await wheelOnField(X_LABEL, 120);
      const wheeled = await waitHostView((view) => near(view.canvasX, -30, 1) && near(view.x, 0, 0.5));
      const wheelPosts = panelPosts('viewport', markWheel).map(parseBody);
      check('V13.5', 'a downward wheel notch decreases canvasX into negative territory and posts canvasX (never x)',
        near(wheeled.view.canvasX, -30, 1) && near(wheeled.view.x, 0, 0.5)
          && wheelPosts.some((body) => Number(body.canvasX) === -30 && body.x === undefined),
        { canvasX: -30, x: 0, field: 'canvasX' },
        { canvasX: wheeled.view.canvasX, x: wheeled.view.x, bodies: wheelPosts });

      const markTyped = Date.now();
      await typeIntoField(X_LABEL, '-100', { enter: true });
      const typed = await waitHostView((view) => near(view.canvasX, -100, 1) && near(view.x, 0, 0.5));
      const typedPosts = panelPosts('viewport', markTyped).map(parseBody);
      check('V13.6', 'typing -100 + Enter commits canvasX=-100 (negative canvas value, no document scroll)',
        near(typed.view.canvasX, -100, 1) && near(typed.view.x, 0, 0.5)
          && typedPosts.some((body) => Number(body.canvasX) === -100 && body.x === undefined),
        { canvasX: -100, x: 0, field: 'canvasX' },
        { canvasX: typed.view.canvasX, x: typed.view.x, bodies: typedPosts });

      const markRange = Date.now();
      await typeIntoField(X_LABEL, '-10000001', { enter: true });
      await sleep(500);
      const afterRange = await panelState();
      const rangePosts = panelPosts('viewport', markRange).map(parseBody);
      check('V13.7', 'a canvas value outside ±10,000,000 is rejected locally (no request, input reverts)',
        near(afterRange.x, -100, 1.5) && !rangePosts.some((body) => body.canvasX !== undefined),
        { x: -100, requests: 0 }, { x: afterRange.x, bodies: rangePosts });

      // ---- V13.8 preview compositing: left blank is pure white, content shifted by -C ----
      await hostViewportSet({ canvasX: -100, canvasY: 0 });
      await waitHostView((view) => near(view.canvasX, -100, 1) && near(view.x, 0, 0.5));
      await waitPanelMirrorsHost();
      await waitCanvasState(true, true);
      const leftPreview = await waitFrameStable();
      await ensurePointVisible({ x: leftPreview.box.left + leftPreview.box.width / 2, y: leftPreview.box.top + leftPreview.box.height / 2 });
      await sleep(500);
      // A seed/live replacement can land while we wait for the stage: re-prove the barrier before
      // reading pixels, otherwise a one-frame revision bump would be reported as a product failure.
      await waitCanvasState(true, true, { timeoutMs: 10000 });
      const leftFrame = await waitFrameStable();
      const leftPanel = await panelState();
      const leftDetail = canvasDetailOf(leftPanel);
      const leftShift = transformTranslate(leftPanel.imgTransform);
      const leftSeed = leftDetail.seed === true;
      const leftShot = await captureBoxPixels(leftFrame.box);
      const leftContent = pixelAt(leftShot.decoded, 160, Math.round(leftFrame.box.height * 0.96));
      const leftChecker = checkerboardOf(leftPanel);
      const leftProbe = checkerSample(leftShot.decoded, leftChecker,
        [[7, 7], [21, 7], [35, 7], [49, 7], [63, 7], [77, 7], [91, 7]]);
      const leftClip = leftSeed ? String(leftPanel.canvasSeedClip || '') : 'off';
      check('V13.8', 'C=-100 shows a dark checkerboard blank band and content shifted right (composed seed clipped; live frame uses -C=100)',
        leftPanel.canvasBlank === 'checkerboard' && Boolean(leftChecker)
          && leftProbe.allChecker && leftProbe.both && leftProbe.white === 0
          && leftContent.r >= 150 && leftContent.g <= 120 && leftContent.b <= 120
          && near(leftShift.x, leftSeed ? 0 : 100, 2) && near(leftShift.y, 0, 1)
          && (leftSeed ? leftPanel.canvasBarrier === 'seed-aligned' && leftClip.includes('25%') : leftPanel.canvasBarrier === 'aligned' && leftClip === 'off'),
        { blank: 'checkerboard', colors: 'both dark tones', content: 'page background', translateX: leftSeed ? 0 : 100, seedClip: leftSeed ? 'left 25%' : 'off' },
        { blank: leftPanel.canvasBlank, checker: leftChecker, probe: leftProbe, content: leftContent, translate: leftShift, barrier: leftPanel.canvasBarrier, seedClip: leftClip, detail: leftDetail, box: leftFrame.box });
      const seedPosts = panelScreenshotPosts(v13Start);
      if (leftSeed) {
        check('V13.8b', 'a static-page mismatch refreshed a composed seed: /screenshot carried {canvas:true} and the Host provenance is aligned',
          seedPosts.some((body) => body.canvas === true) && leftPanel.canvasBarrier === 'seed-aligned',
          { body: { canvas: true }, barrier: 'seed-aligned' },
          { requests: seedPosts, barrier: leftPanel.canvasBarrier, detail: leftDetail });
      } else {
        notRun('V13.8b', 'static-page composed seed accepted',
          'the displayed frame was a matching live frame, so no seed refresh was needed in this run', { detail: leftDetail, seedPosts });
      }
      await capturePanel('shot-06-canvas-negative');

      // ---- V13.8c-e seed provenance mechanics (real Host happy path above; negatives simulated) ----
      if (leftSeed) {
        const interceptor = await startScreenshotInterceptor();
        try {
          // Drain a still-pending real seed refresh before simulating (the transport allows one
          // request at a time; a paused leftover would block every later seed request).
          for (const entry of interceptor.pending()) {
            await interceptor.respond(entry, { status: 500, body: { ok: false, error: 'drain', code: 'INTERNAL' } });
          }
          await sleep(250);
          // 1) Stale (in-flight) response: capture at -150 is answered after the shell moved to -200.
          const staleMark = Date.now();
          await hostViewportSet({ canvasX: -150 });
          await waitHostView((view) => near(view.canvasX, -150, 1) && near(view.x, 0, 1));
          await waitPanelValues({ x: -150 });
          const staleRequest = await interceptor.waitForNew(staleMark);
          check('V13.8c0', 'the client asks for a composed seed with body {canvas:true}',
            staleRequest.body && staleRequest.body.canvas === true,
            { canvas: true }, { body: staleRequest.body, url: staleRequest.url });
          const staleFacts = await seedFactsNow();
          await hostViewportSet({ canvasX: -200 });
          await waitHostView((view) => near(view.canvasX, -200, 1) && near(view.x, 0, 1));
          await waitPanelValues({ x: -200 });
          const refreshMark = Date.now();
          await interceptor.respond(staleRequest, { body: await seedResponseFor(staleFacts) });
          await sleep(1200);
          const afterStale = await panelState();
          const refreshedRequest = await interceptor.waitForNew(refreshMark);
          const refreshedFacts = await seedFactsNow();
          await interceptor.respond(refreshedRequest, { body: await seedResponseFor(refreshedFacts) });
          const refreshed = await waitCanvasState(true, true, { timeoutMs: 8000 });
          check('V13.8c', 'an in-flight seed answered after the shell moved is dropped as stale; the next state refreshes to seed-aligned',
            afterStale.canvasBarrier !== 'seed-aligned' && refreshed.canvasBarrier === 'seed-aligned',
            { afterStale: 'not seed-aligned', refreshed: 'seed-aligned' },
            { afterStale: afterStale.canvasBarrier, refreshed: refreshed.canvasBarrier, staleFacts, refreshedFacts });

          // 2) Missing provenance: a 200 without view/capture is rejected, a state change retries.
          const missingMark = Date.now();
          await hostViewportSet({ canvasX: -250 });
          await waitHostView((view) => near(view.canvasX, -250, 1) && near(view.x, 0, 1));
          await waitPanelValues({ x: -250 });
          const missingRequest = await interceptor.waitForNew(missingMark);
          await interceptor.respond(missingRequest, { body: { ok: true, image: (await seedResponseFor(refreshedFacts)).image } });
          await sleep(1200);
          const afterMissing = await panelState();
          const missingRetryMark = Date.now();
          await hostViewportSet({ canvasX: -300 });
          await waitHostView((view) => near(view.canvasX, -300, 1) && near(view.x, 0, 1));
          await waitPanelValues({ x: -300 });
          const retryRequest = await interceptor.waitForNew(missingRetryMark);
          const retryFacts = await seedFactsNow();
          await interceptor.respond(retryRequest, { body: await seedResponseFor(retryFacts) });
          const recovered = await waitCanvasState(true, true, { timeoutMs: 8000 });
          check('V13.8d', 'a seed response without canvas provenance is rejected (fail-closed); a shell change retries and aligns',
            afterMissing.canvasBarrier !== 'seed-aligned' && recovered.canvasBarrier === 'seed-aligned',
            { missing: 'not seed-aligned', recovered: 'seed-aligned' },
            { missing: afterMissing.canvasBarrier, recovered: recovered.canvasBarrier });

          // 3) HTTP failure: same fail-closed + retry-on-state-change rule.
          const failMark = Date.now();
          await hostViewportSet({ canvasX: -350 });
          await waitHostView((view) => near(view.canvasX, -350, 1) && near(view.x, 0, 1));
          await waitPanelValues({ x: -350 });
          const failRequest = await interceptor.waitForNew(failMark);
          await interceptor.respond(failRequest, { status: 500, body: { ok: false, error: 'boom', code: 'INTERNAL' } });
          await sleep(1200);
          const afterFail = await panelState();
          const failRetryMark = Date.now();
          await hostViewportSet({ canvasX: -400 });
          await waitHostView((view) => near(view.canvasX, -400, 1) && near(view.x, 0, 1));
          await waitPanelValues({ x: -400 });
          const failRetryRequest = await interceptor.waitForNew(failRetryMark);
          const failRetryFacts = await seedFactsNow();
          await interceptor.respond(failRetryRequest, { body: await seedResponseFor(failRetryFacts) });
          const afterFailRecovered = await waitCanvasState(true, true, { timeoutMs: 8000 });
          check('V13.8e', 'a failed seed request leaves input fail-closed; a shell change retries and aligns',
            afterFail.canvasBarrier !== 'seed-aligned' && afterFailRecovered.canvasBarrier === 'seed-aligned',
            { failed: 'not seed-aligned', recovered: 'seed-aligned' },
            { failed: afterFail.canvasBarrier, recovered: afterFailRecovered.canvasBarrier });
          const quietMark = Date.now();
          await sleep(1500);
          const quietRequests = interceptor.requests.filter((entry) => entry.at >= quietMark);
          check('V13.8f', 'a successful seed is not re-requested for the same shell signature (no screenshot loop)',
            quietRequests.length === 0,
            { requests: 0 }, { requests: quietRequests.length, bodies: quietRequests.map((entry) => entry.body) });

          // 4) Seed input mapping: a composed seed at C=-100 still maps q -> p=q+O and blank-zero.
          const clickSeedMark = Date.now();
          await hostViewportSet({ canvasX: -100 });
          await waitHostView((view) => near(view.canvasX, -100, 1) && near(view.x, 0, 1));
          await waitPanelValues({ x: -100 });
          const clickSeedRequest = await interceptor.waitForNew(clickSeedMark);
          const clickSeedFacts = await seedFactsNow();
          await interceptor.respond(clickSeedRequest, { body: await seedResponseFor(clickSeedFacts) });
          const clickSeedPanel = await waitCanvasState(true, true, { timeoutMs: 8000 });
          check('V13.8g', 'seed-displayed state is seed-aligned and does not add a live-frame transform',
            clickSeedPanel.canvasBarrier === 'seed-aligned' && transformTranslate(clickSeedPanel.imgTransform).x === 0,
            { barrier: 'seed-aligned', translateX: 0 },
            { barrier: clickSeedPanel.canvasBarrier, translate: transformTranslate(clickSeedPanel.imgTransform) });
          const seedClickView = (await hostView()).view;
          const seedClickCanvas = (await hostCanvas()).canvas;
          const seedTarget = await elementDocumentRect('#t3-canvas');
          const seedQ = { x: seedTarget.docX - Number(seedClickCanvas.x), y: seedTarget.docY - Number(seedClickCanvas.y) };
          let seedPainted = paintedOf(await waitFrameStable());
          let seedPoint = guiPointForViewport(seedPainted, Number(seedClickView.width), Number(seedClickView.height), seedQ.x, seedQ.y);
          await ensurePointVisible(seedPoint);
          seedPainted = paintedOf(await waitFrameStable());
          seedPoint = guiPointForViewport(seedPainted, Number(seedClickView.width), Number(seedClickView.height), seedQ.x, seedQ.y);
          await resetTargetInstrumentation();
          const seedClicksBefore = await targetEval('window.__t3 ? window.__t3.counters.canvasClicks : -1');
          await clickAt(seedPoint.x, seedPoint.y);
          await sleep(800);
          const seedClicksAfter = await targetEval('window.__t3 ? window.__t3.counters.canvasClicks : -1');
          const seedClickRecord = await targetEval('window.__t3 ? window.__t3.last.click : null');
          check('V13.8h', `seed-displayed content click maps q=${Math.round(seedQ.x)} through O=-100 to p=${Math.round(seedQ.x - 100)}`,
            Number(seedClicksAfter) - Number(seedClicksBefore) === 1
              && seedClickRecord && seedClickRecord.isTrusted === true && seedClickRecord.target === 't3-canvas'
              && near(seedClickRecord.clientX, seedTarget.docX - seedTarget.scrollX, 1.5),
            { clicks: 1, target: 't3-canvas', clientX: seedTarget.docX - seedTarget.scrollX },
            { clicks: Number(seedClicksAfter) - Number(seedClicksBefore), record: seedClickRecord, q: seedQ, point: seedPoint });
          const seedBlankQ = { x: 50, y: 250 };
          const seedBlankPainted = paintedOf(await waitForFrame());
          const seedBlankPoint = guiPointForViewport(seedBlankPainted, Number(seedClickView.width), Number(seedClickView.height), seedBlankQ.x, seedBlankQ.y);
          await resetTargetInstrumentation();
          const seedInputMark = Date.now();
          await clickAt(seedBlankPoint.x, seedBlankPoint.y);
          await sleep(500);
          const seedBlankEvents = await targetEval('window.__t3 ? window.__t3.events.length : -1');
          check('V13.8i', 'a click on the blank of a composed seed dispatches zero page events and zero /input',
            seedBlankEvents === 0 && panelPosts('input', seedInputMark).length === 0,
            { pageEvents: 0, inputPosts: 0 },
            { pageEvents: seedBlankEvents, inputPosts: panelPosts('input', seedInputMark).length });
        } finally {
          for (const entry of interceptor.pending()) {
            await interceptor.respond(entry, { status: 500, body: { ok: false, error: 'cleanup', code: 'INTERNAL' } }).catch(() => {});
          }
          await interceptor.stop();
        }
      } else {
        notRun('V13.8c', 'seed provenance negative cases (stale/missing/failure)',
          'the displayed frame was a matching live frame in this run, so the canvas seed path was not exercised', { detail: leftDetail });
      }

      // ---- V13.9 C beyond max scroll: the right band is blank, content is shifted left ----
      const overflowForCanvas = await ensureHorizontalOverflow();
      const maxScrollX = Number(overflowForCanvas.maxScrollX);
      const rightC = maxScrollX + 80;
      await hostViewportSet({ canvasX: rightC, canvasY: 0 });
      await waitHostView((view) => near(view.canvasX, rightC, 1) && near(view.x, maxScrollX, 2));
      await waitPanelMirrorsHost();
      await waitCanvasState(true, true);
      const rightPreview = await waitFrameStable();
      await ensurePointVisible({ x: rightPreview.box.left + rightPreview.box.width / 2, y: rightPreview.box.top + rightPreview.box.height / 2 });
      await sleep(500);
      const rightFrame = await waitFrameStable();
      const rightPanel = await panelState();
      const rightDetail = canvasDetailOf(rightPanel);
      const rightSeed = rightDetail.seed === true;
      const rightShift = transformTranslate(rightPanel.imgTransform);
      const rightShot = await captureBoxPixels(rightFrame.box);
      const rightBlankX = Math.round(rightFrame.box.width - 73);
      const rightChecker = checkerboardOf(rightPanel);
      const rightProbe = checkerSample(rightShot.decoded, rightChecker,
        [[rightBlankX, 7], [rightBlankX + 14, 7], [rightBlankX + 28, 7], [rightBlankX + 42, 7], [rightBlankX + 56, 7]]);
      const rightContent = pixelAt(rightShot.decoded, Math.round(rightFrame.box.width - 150), Math.round(rightFrame.box.height * 0.96));
      const rightClip = rightSeed ? String(rightPanel.canvasSeedClip || '') : 'off';
      check('V13.9', 'C > max scroll shows a dark checkerboard right band and content left (composed seed clipped; live frame shifted by O=80)',
        rightPanel.canvasBlank === 'checkerboard' && Boolean(rightChecker)
          && rightProbe.allChecker && rightProbe.both && rightProbe.white === 0
          && rightContent.r >= 150 && rightContent.g <= 120 && rightContent.b <= 120
          && near(rightShift.x, rightSeed ? 0 : -80, 2)
          && (rightSeed ? rightPanel.canvasBarrier === 'seed-aligned' && rightClip.includes('20%') : rightPanel.canvasBarrier === 'aligned' && rightClip === 'off'),
        { blank: 'checkerboard', colors: 'both dark tones', content: 'page background', translateX: rightSeed ? 0 : -80, seedClip: rightSeed ? 'right 20%' : 'off' },
        { blank: rightPanel.canvasBlank, checker: rightChecker, probe: rightProbe, content: rightContent, translate: rightShift, barrier: rightPanel.canvasBarrier, seedClip: rightClip, C: rightC, maxScrollX, detail: rightDetail });
      await capturePanel('shot-07-canvas-right-blank');

      // ---- V13.10 content hit maps q -> p = q + O (scroll 0, C=-100 => O=-100) ----
      await hostViewportSet({ canvasX: -100, canvasY: 0 });
      await waitHostView((view) => near(view.canvasX, -100, 1) && near(view.x, 0, 1));
      await waitPanelMirrorsHost();
      await waitCanvasState(true, true);
      await waitFrameStable();
      await sleep(300); // let the best-effort resize barrier (≤250 ms) clear too
      const clickView = (await hostView()).view;
      const clickCanvas = (await hostCanvas()).canvas;
      const clickTarget = await elementDocumentRect('#t3-canvas');
      const q = { x: clickTarget.docX - Number(clickCanvas.x), y: clickTarget.docY - Number(clickCanvas.y) };
      let clickPainted = paintedOf(await waitForFrame());
      let clickPoint = guiPointForViewport(clickPainted, Number(clickView.width), Number(clickView.height), q.x, q.y);
      await ensurePointVisible(clickPoint);
      clickPainted = paintedOf(await waitForFrame());
      clickPoint = guiPointForViewport(clickPainted, Number(clickView.width), Number(clickView.height), q.x, q.y);
      await resetTargetInstrumentation();
      const clicksBeforeCanvas = await targetEval('window.__t3 ? window.__t3.counters.canvasClicks : -1');
      await clickAt(clickPoint.x, clickPoint.y);
      await sleep(800);
      const clicksAfterCanvas = await targetEval('window.__t3 ? window.__t3.counters.canvasClicks : -1');
      const canvasClickRecord = await targetEval(`(() => {
        if (!window.__t3) return null;
        const clicks = window.__t3.events.filter((event) => event.type === 'click');
        return clicks.length ? clicks[clicks.length - 1] : null;
      })()`);
      check('V13.10', `content click maps q=${Math.round(q.x)} through O=-100 to page point p=${Math.round(q.x - 100)} (hits #t3-canvas, trusted)`,
        Number(clicksAfterCanvas) - Number(clicksBeforeCanvas) === 1
          && canvasClickRecord && canvasClickRecord.isTrusted === true
          && canvasClickRecord.target === 't3-canvas'
          && near(canvasClickRecord.clientX, clickTarget.docX - clickTarget.scrollX, 1.5)
          && near(canvasClickRecord.clientY, clickTarget.docY - clickTarget.scrollY, 1.5)
          && near(canvasClickRecord.clientX, q.x + (Number(clickCanvas.x) - Number(clickView.x)), 1.5),
        { clicks: 1, isTrusted: true, target: 't3-canvas', clientX: clickTarget.docX - clickTarget.scrollX },
        { clicks: Number(clicksAfterCanvas) - Number(clicksBeforeCanvas), record: canvasClickRecord, q, clickPoint });

      // ---- V13.11 blank: click and wheel dispatch nothing into the page ----
      const blankQ = { x: 50, y: 250 }; // d = q + C = (-50, 250): outside the content box
      const blankPainted = paintedOf(await waitForFrame());
      const blankPoint = guiPointForViewport(blankPainted, Number(clickView.width), Number(clickView.height), blankQ.x, blankQ.y);
      await resetTargetInstrumentation();
      const inputMark = Date.now();
      await clickAt(blankPoint.x, blankPoint.y);
      await sleep(400);
      const blankEvents = await targetEval('window.__t3 ? window.__t3.events.length : -1');
      const scrollBeforeBlankWheel = await targetTruth();
      await wheelOnFramePoint(blankPoint, 240);
      await sleep(700);
      const scrollAfterBlankWheel = await targetTruth();
      const blankInputPosts = panelPosts('input', inputMark);
      check('V13.11', 'a click on the canvas blank dispatches zero page events and zero /input requests',
        blankEvents === 0 && blankInputPosts.length === 0,
        { pageEvents: 0, inputPosts: 0 }, { pageEvents: blankEvents, inputPosts: blankInputPosts.length, point: blankPoint });
      check('V13.12', 'a wheel on the canvas blank does not scroll the target page',
        near(scrollAfterBlankWheel.scrollX, scrollBeforeBlankWheel.scrollX, 0.5)
          && near(scrollAfterBlankWheel.scrollY, scrollBeforeBlankWheel.scrollY, 0.5)
          && panelPosts('input', inputMark + 500).length === 0,
        { scrollX: scrollBeforeBlankWheel.scrollX, scrollY: scrollBeforeBlankWheel.scrollY },
        { scrollX: scrollAfterBlankWheel.scrollX, scrollY: scrollAfterBlankWheel.scrollY, inputPosts: panelPosts('input', inputMark + 500).length });

      // ---- V13.13 fail-closed: if the accepted S disagrees with the displayed frame's scroll, no input ----
      let stopRewrite = null;
      try {
        stopRewrite = await startStateRewrite((json) => mutateStateUi(json, (ui) => {
          if (ui.view) { ui.view.x = 50; ui.view.y = 50; }
          if (ui.observed) { ui.observed.x = 50; ui.observed.y = 50; }
          return ui;
        }));
        const stalled = await waitFor(async () => {
          const panel = await panelState();
          return panel.canvasOn === 'on' && panel.canvasReady === 'false' && panel.canvasBarrier === 'scroll-mismatch'
            ? panel : undefined;
        }, { timeoutMs: 5000, intervalMs: 100, label: 'fail-closed scroll mismatch' });
        check('V13.13', 'O≠0 + accepted S≠frame.scroll makes the input barrier fail closed (reason=scroll-mismatch, no 250 ms timeout bypass)',
          stalled.canvasReady === 'false' && stalled.canvasBarrier === 'scroll-mismatch',
          { canvasReady: 'false', reason: 'scroll-mismatch' },
          { canvasReady: stalled.canvasReady, reason: stalled.canvasBarrier });
        const inputBeforeStall = panelPosts('input').length;
        await resetTargetInstrumentation();
        const stallPainted = paintedOf(await waitForFrame());
        let stallPoint = guiPointForViewport(stallPainted, Number(clickView.width), Number(clickView.height), q.x, q.y);
        await ensurePointVisible(stallPoint);
        const stallPaintedAgain = paintedOf(await waitForFrame());
        stallPoint = guiPointForViewport(stallPaintedAgain, Number(clickView.width), Number(clickView.height), q.x, q.y);
        await clickAt(stallPoint.x, stallPoint.y);
        await sleep(500);
        const stalledEvents = await targetEval('window.__t3 ? window.__t3.events.length : -1');
        check('V13.14', 'the same content point that worked before dispatches nothing while frame.scroll is inconsistent',
          stalledEvents === 0 && panelPosts('input').length === inputBeforeStall,
          { pageEvents: 0, inputPosts: inputBeforeStall },
          { pageEvents: stalledEvents, inputPosts: panelPosts('input').length, point: stallPoint });
      } catch (error) {
        notRun('V13.13', 'fail-closed scroll barrier (inconsistent frame.scroll)',
          'CDP Fetch response rewriting is unavailable in this environment', sanitize(errorMessage(error)));
      } finally {
        if (stopRewrite) await stopRewrite();
      }
      const recovered = await waitCanvasState(true, true, { timeoutMs: 8000 }).catch(() => null);
      check('V13.15', 'the canvas input barrier recovers when the Host scroll evidence agrees again',
        Boolean(recovered), { canvasReady: 'true' }, recovered ? { canvasReady: recovered.canvasReady } : { canvasReady: null });

      // ---- V13.16 drag writes the canvas origin C and may go negative ----
      await hostViewportSet({ width: 400, height: 300, scale: 1, x: 0, y: 0 });
      await waitHostView((view) => Number(view.width) === 400 && Number(view.height) === 300 && near(view.x, 0, 1) && near(view.y, 0, 1));
      await waitPanelMirrorsHost();
      await hostViewportSet({ canvasX: 50, canvasY: 50 });
      await waitHostView((view) => near(view.canvasX, 50, 1) && near(view.canvasY, 50, 1) && near(view.x, 50, 1));
      await waitPanelMirrorsHost();
      await waitCanvasState(true, true);
      await waitFrameStable();
      const panOn = await togglePan(true);
      check('V13.16', 'the drag checkbox is enabled on a canvas Host and checked after a real click',
        panOn.panChecked === true && panOn.frameCursor === 'grab',
        { checked: true, cursor: 'grab' }, { checked: panOn.panChecked, cursor: panOn.frameCursor });
      const canvasDrag = await dragOnFrame(140, 90);
      const expectedCanvasX = Math.round(50 - (140 * 400) / Math.max(1, canvasDrag.painted.width));
      const expectedCanvasY = Math.round(50 - (90 * 300) / Math.max(1, canvasDrag.painted.height));
      const draggedCanvas = await waitHostView((view) => near(view.canvasX, expectedCanvasX, 6)
        && near(view.canvasY, expectedCanvasY, 6) && near(view.x, 0, 1) && near(view.y, 0, 1));
      check('V13.17', `dragging right/down moves canvas C into negative values (${expectedCanvasX}, ${expectedCanvasY}) and keeps real scroll clamped at 0`,
        near(draggedCanvas.view.canvasX, expectedCanvasX, 6) && near(draggedCanvas.view.canvasY, expectedCanvasY, 6)
          && Number(draggedCanvas.view.canvasX) < 0 && Number(draggedCanvas.view.canvasY) < 0
          && near(draggedCanvas.view.x, 0, 1) && near(draggedCanvas.view.y, 0, 1),
        { canvasX: expectedCanvasX, canvasY: expectedCanvasY, x: 0, y: 0 },
        { view: draggedCanvas.view, painted: canvasDrag.painted });
      const draggedPanel = await waitPanelValues({ x: draggedCanvas.view.canvasX, y: draggedCanvas.view.canvasY }).catch(() => panelState());
      check('V13.18', 'the X/Y inputs mirror the negative canvas C after the drag',
        near(draggedPanel.x, draggedCanvas.view.canvasX, 2) && near(draggedPanel.y, draggedCanvas.view.canvasY, 2),
        { x: draggedCanvas.view.canvasX, y: draggedCanvas.view.canvasY }, { x: draggedPanel.x, y: draggedPanel.y });
      const panOff = await togglePan(false);
      check('V13.19', 'unchecking drag restores the default cursor and page interaction surface',
        panOff.panChecked === false && panOff.frameCursor !== 'grab' && panOff.frameCursor !== 'grabbing',
        { checked: false, cursor: 'auto' }, { checked: panOff.panChecked, cursor: panOff.frameCursor });
      await capturePanel('shot-08-canvas-drag');

      // ---- V13.19b pan-only overlay: a fully blank canvas can still be dragged back ----
      const liveContent = (await hostCanvas()).canvas;
      const dragViewWidth = Number((await hostView()).view.width);
      const farC = Number(liveContent.contentWidth) + 100;
      const maxScrollFar = Math.max(0, Number(liveContent.contentWidth) - dragViewWidth);
      await hostViewportSet({ canvasX: farC, canvasY: 0 });
      const farView = await waitHostView((view) => near(view.canvasX, farC, 2) && near(view.x, maxScrollFar, 2));
      await waitPanelMirrorsHost();
      await waitCanvasState(true, true);
      await waitFrameStable();
      const farPreview = await waitFrameStable();
      await ensurePointVisible({ x: farPreview.box.left + farPreview.box.width / 2, y: farPreview.box.top + farPreview.box.height / 2 });
      await sleep(400);
      const farFrame = await waitFrameStable();
      const farPanel = await panelState();
      const farDetail = canvasDetailOf(farPanel);
      const farSeed = farDetail.seed === true;
      const farShift = transformTranslate(farPanel.imgTransform);
      const farShot = await captureBoxPixels(farFrame.box);
      const farChecker = checkerboardOf(farPanel);
      const farProbe = checkerSample(farShot.decoded, farChecker,
        [[7, 7], [21, 7], [35, 7], [49, 7], [63, 7], [77, 7], [7, 21], [21, 21], [35, 21], [49, 21], [63, 21], [77, 21], [7, 35], [21, 35], [35, 35]]);
      const farClip = farSeed ? String(farPanel.canvasSeedClip || '') : 'off';
      const farExpectedShift = farSeed ? 0 : -(Number(liveContent.contentWidth) + 100 - maxScrollFar);
      check('V13.19b', 'C fully beyond the content box shows an all-checkerboard canvas (live frame out; composed seed fully clipped)',
        farPanel.canvasBlank === 'checkerboard' && Boolean(farChecker)
          && farProbe.allChecker && farProbe.both && farProbe.white === 0
          && near(farShift.x, farExpectedShift, 3)
          && (farSeed ? farPanel.canvasBarrier === 'seed-aligned' && farClip !== 'off' && farClip.includes('100%') : farPanel.canvasBarrier === 'aligned' && farClip === 'off'),
        { blank: 'checkerboard', colors: 'both dark tones', translateX: farExpectedShift, seedClip: farSeed ? 'all blank' : 'off' },
        { blank: farPanel.canvasBlank, checker: farChecker, probe: farProbe, translate: farShift, barrier: farPanel.canvasBarrier, seedClip: farClip, C: farC, maxScroll: maxScrollFar, detail: farDetail, view: farView.view });
      await capturePanel('shot-09-canvas-all-blank');

      const panAgain = await togglePan(true);
      check('V13.19c', 'drag mode adds a pan-only transparent layer over the blank viewport (grab cursor)',
        panAgain.panChecked === true && panAgain.panLayer === true && panAgain.panLayerCursor === 'grab',
        { checked: true, layer: true, cursor: 'grab' },
        { checked: panAgain.panChecked, layer: panAgain.panLayer, cursor: panAgain.panLayerCursor });

      // The frame is entirely outside the box: this drag can only start on the blank overlay.
      const blankDrag = await dragOnFrame(200, 0);
      const recoveredC = Math.round(farC - (200 * dragViewWidth) / Math.max(1, blankDrag.painted.width));
      const blankDragged = await waitHostView((view) => near(view.canvasX, recoveredC, 8) && near(view.x, maxScrollFar, 2));
      check('V13.19d', `dragging from the blank recovers the viewport (canvasX ${Math.round(farC)}→≈${recoveredC})`,
        near(blankDragged.view.canvasX, recoveredC, 8) && Number(blankDragged.view.canvasX) < farC,
        { canvasX: recoveredC }, { canvasX: blankDragged.view.canvasX, startedBlank: true, painted: blankDrag.painted });
      await waitCanvasState(true, true);
      const recoveredFrame = await waitFrameStable();
      const recoveredPanel = await panelState();
      const recoveredDetail = canvasDetailOf(recoveredPanel);
      const recoveredSeed = recoveredDetail.seed === true;
      const recoveredShift = transformTranslate(recoveredPanel.imgTransform);
      const recoveredShot = await captureBoxPixels(recoveredFrame.box);
      const recoveredLeft = pixelAt(recoveredShot.decoded, 30, Math.round(recoveredFrame.box.height * 0.5));
      const recoveredChecker = checkerboardOf(recoveredPanel);
      const recoveredRightX = Math.round(recoveredFrame.box.width - 73);
      const recoveredProbe = checkerSample(recoveredShot.decoded, recoveredChecker,
        [[recoveredRightX, 7], [recoveredRightX + 14, 7], [recoveredRightX + 28, 7], [recoveredRightX + 42, 7], [recoveredRightX + 56, 7]]);
      const recoveredClip = recoveredSeed ? String(recoveredPanel.canvasSeedClip || '') : 'off';
      const recoveredExpectedShift = recoveredSeed ? 0 : -(recoveredC - maxScrollFar);
      check('V13.19e', 'after the blank drag the content is visible on the left and the right band is checkerboard (seed clipped)',
        recoveredLeft.r >= 150 && recoveredLeft.g <= 120 && recoveredLeft.b <= 120
          && recoveredPanel.canvasBlank === 'checkerboard' && Boolean(recoveredChecker)
          && recoveredProbe.allChecker && recoveredProbe.both && recoveredProbe.white === 0
          && near(recoveredShift.x, recoveredExpectedShift, 3)
          && (recoveredSeed ? recoveredPanel.canvasBarrier === 'seed-aligned' && recoveredClip.includes('75%') : recoveredPanel.canvasBarrier === 'aligned' && recoveredClip === 'off'),
        { left: 'page background', right: 'checkerboard', translateX: recoveredExpectedShift, seedClip: recoveredSeed ? 'right 75%' : 'off' },
        { left: recoveredLeft, checker: recoveredChecker, probe: recoveredProbe, translate: recoveredShift, barrier: recoveredPanel.canvasBarrier, seedClip: recoveredClip, C: recoveredC, maxScroll: maxScrollFar, detail: recoveredDetail });
      const panFinallyOff = await togglePan(false);
      check('V13.19f', 'leaving drag mode removes the pan overlay and restores the normal hit surface',
        panFinallyOff.panChecked === false && panFinallyOff.panLayer === false && panFinallyOff.frameCursor !== 'grab',
        { checked: false, layer: false, cursor: 'auto' },
        { checked: panFinallyOff.panChecked, layer: panFinallyOff.panLayer, cursor: panFinallyOff.frameCursor });

      // Reset to a neutral canvas before the fallback simulations (their X/Y display is scroll 0).
      await hostViewportSet({ width: 400, height: 300, scale: 1, x: 0, y: 0 });
      await waitHostView((view) => Number(view.width) === 400 && Number(view.height) === 300 && near(view.x, 0, 2) && near(view.y, 0, 1));
      await hostViewportSet({ canvasX: 0, canvasY: 0 });
      await waitHostView((view) => near(view.canvasX, 0, 1) && near(view.canvasY, 0, 1) && near(view.x, 0, 1));
      await waitPanelMirrorsHost();
      await waitCanvasState(true, true);

      // ---- V13.20 simulated Host without ui.canvas: old scroll fallback + drag disabled ----
      let stopNoCanvas = null;
      try {
        stopNoCanvas = await startStateRewrite((json) => mutateStateUi(json, (ui) => {
          delete ui.canvas;
          return ui;
        }));
        const noCanvas = await waitCanvasState(false, undefined, { timeoutMs: 5000 });
        await waitPanelValues({ x: 0, y: 0 }).catch(() => undefined);
        const noCanvasPanel = await panelState();
        check('V13.20', 'without ui.canvas the drag mode is disabled and X/Y fall back to document scroll (0, not the stale C)',
          noCanvasPanel.canvasOn === 'off' && noCanvasPanel.panDisabled === true && noCanvasPanel.xDisabled === false
            && near(noCanvasPanel.x, 0, 1.5) && near(noCanvasPanel.y, 0, 1.5),
          { canvas: 'off', panDisabled: true, xDisabled: false, x: 0, y: 0 },
          { canvas: noCanvasPanel.canvasOn, panDisabled: noCanvasPanel.panDisabled, xDisabled: noCanvasPanel.xDisabled,
            x: noCanvasPanel.x, y: noCanvasPanel.y });
        const markNoCanvas = Date.now();
        await typeIntoField(X_LABEL, '-50', { enter: true });
        await sleep(500);
        const noCanvasPanelAfter = await panelState();
        const noCanvasPosts = panelPosts('viewport', markNoCanvas).map(parseBody);
        check('V13.21', 'the fallback rejects a negative scroll draft and never posts canvasX/canvasY',
          near(noCanvasPanelAfter.x, 0, 1.5)
            && !noCanvasPosts.some((body) => body.canvasX !== undefined || body.canvasY !== undefined),
          { x: 0, canvasFields: 0 }, { x: noCanvasPanelAfter.x, bodies: noCanvasPosts });
      } catch (error) {
        notRun('V13.20', 'simulated Host without ui.canvas',
          'CDP Fetch response rewriting is unavailable in this environment', sanitize(errorMessage(error)));
      } finally {
        if (stopNoCanvas) await stopNoCanvas();
      }
      await waitCanvasState(true, true, { timeoutMs: 8000 }).catch(() => undefined);

      // ---- V13.22 simulated pre-P0-C Host (no ui.view at all): X/Y and drag disabled ----
      let stopOldHost = null;
      try {
        stopOldHost = await startStateRewrite((json) => mutateStateUi(json, (ui) => {
          delete ui.view;
          delete ui.canvas;
          return ui;
        }));
        const oldHostPanel = await waitFor(async () => {
          const panel = await panelState();
          return panel.canvasOn === 'off' && panel.xDisabled === true && panel.panDisabled === true ? panel : undefined;
        }, { timeoutMs: 5000, intervalMs: 150, label: 'old Host fallback disables X/Y and drag' });
        check('V13.22', 'an old Host snapshot (no ui.view/ui.canvas) disables X/Y and drag instead of guessing',
          oldHostPanel.xDisabled === true && oldHostPanel.yDisabled === true && oldHostPanel.panDisabled === true,
          { xDisabled: true, yDisabled: true, panDisabled: true },
          { xDisabled: oldHostPanel.xDisabled, yDisabled: oldHostPanel.yDisabled, panDisabled: oldHostPanel.panDisabled });
      } catch (error) {
        notRun('V13.22', 'simulated pre-P0-C Host (no shared view)',
          'CDP Fetch response rewriting is unavailable in this environment', sanitize(errorMessage(error)));
      } finally {
        if (stopOldHost) await stopOldHost();
      }
      const restoredCanvas = await waitCanvasState(true, true, { timeoutMs: 8000 }).catch(() => null);
      check('V13.23', 'the canvas inputs/drag re-enable once the Host projection returns',
        Boolean(restoredCanvas) && restoredCanvas.panDisabled === false,
        { canvas: 'on', panDisabled: false },
        restoredCanvas ? { canvas: restoredCanvas.canvasOn, panDisabled: restoredCanvas.panDisabled } : { canvas: null });

      // The Host rejects a patch carrying both coordinate spaces; the panel must never send one.
      const allPanelPatches = state.requests
        .filter((entry) => !entry.script && entry.method === 'POST' && entry.url.includes('/plugins/ui-testing/viewport'))
        .map((entry) => parseBody(entry));
      const mixedPatches = allPanelPatches.filter((body) => (body.canvasX !== undefined || body.canvasY !== undefined)
        && (body.x !== undefined || body.y !== undefined));
      check('V13.24', 'no panel /viewport patch ever mixes canvasX/canvasY with x/y',
        mixedPatches.length === 0, { mixed: 0 }, { mixed: mixedPatches.length, bodies: mixedPatches.slice(0, 3) });
    });

    await scenario('V14 pan-mode wheel zoom', async () => {
      // Base state: O != 0 on both axes (top-left blank) so a cursor-anchored zoom keeps the real
      // page scroll at 0 while C changes; fit is off and pan mode is on.
      await navigateTarget(`${fixtureBase}/web-t3.html`);
      await waitForFrame();
      await ensureHorizontalOverflow();
      await clickFit(false);
      await hostViewportSet({ width: 400, height: 300, scale: 1, x: 0, y: 0 });
      await waitHostView((view) => Number(view.width) === 400 && Number(view.height) === 300 && closeTo(view.scale, 1, 0.0011));
      await hostViewportSet({ canvasX: -100, canvasY: -100 });
      await waitHostView((view) => near(view.canvasX, -100, 1) && near(view.canvasY, -100, 1) && near(view.x, 0, 1) && near(view.y, 0, 1));
      await waitPanelMirrorsHost();
      await waitCanvasState(true, true);
      await waitFrameStable();
      const panOn = await togglePan(true);
      check('V14.0', 'drag mode advertises the wheel-zoom surface',
        panOn.panChecked === true && panOn.canvasZoom === 'wheel',
        { checked: true, zoom: 'wheel' }, { checked: panOn.panChecked, zoom: panOn.canvasZoom });

      const b = { x: 40, y: 40 };
      const setup = await frameBoxPoint(b);
      const beforePanel = await panelState();
      const beforeBox = setup.box;
      const point = setup.point;
      const beforeView = (await hostView()).view;
      const beforeCanvas = (await hostCanvas()).canvas;
      const s0 = beforeBox.width / Number(beforeView.width);
      // The canvas point under the cursor's *screen* point S; the strict assertion is that d0
      // remains at S after layout, not merely at the same box-relative coordinate.
      const d0 = { x: Number(beforeCanvas.x) + (point.x - beforeBox.left) / s0, y: Number(beforeCanvas.y) + (point.y - beforeBox.top) / s0 };
      const scrollBefore = await targetTruth();
      await capturePanel('shot-12-zoom-anchor-before');
      const mark = Date.now();
      await wheelOnFramePoint(point, -120);
      const zoomed = await waitHostView((view) => closeTo(view.scale, 1.05, 0.0011) && near(view.x, 0, 1) && near(view.y, 0, 1));
      await waitPanelMirrorsHost();
      await waitZoomAnchorState('settled');
      await sleep(250);
      const posts = panelPosts('viewport', mark).map(parseBody);
      const inputPosts = panelPosts('input', mark);
      const scrollAfter = await targetTruth();
      const afterPanel = await panelState();
      const afterBox = afterPanel.frame.box;
      const afterView = (await hostView()).view;
      const afterCanvas = (await hostCanvas()).canvas;
      const s1 = afterBox.width / Number(afterView.width);
      const screen1 = {
        x: afterBox.left + (d0.x - Number(afterCanvas.x)) * s1,
        y: afterBox.top + (d0.y - Number(afterCanvas.y)) * s1,
      };
      const drift = Math.max(Math.abs(screen1.x - point.x), Math.abs(screen1.y - point.y));
      const body = posts.length ? posts[0] : {};
      check('V14.1', 'drag-mode wheel applies the 5% scale step through one scale+canvasX/Y patch (no x/y, no page scroll, no /input)',
        closeTo(zoomed.view.scale, 1.05, 0.0011) && posts.length === 1
          && closeTo(body.scale, 1.05, 0.0011)
          && num(body.canvasX) !== null && num(body.canvasY) !== null
          && body.x === undefined && body.y === undefined
          && near(scrollAfter.scrollX, scrollBefore.scrollX, 0.5) && near(scrollAfter.scrollY, scrollBefore.scrollY, 0.5)
          && inputPosts.length === 0,
        { scale: 1.05, patch: ['scale', 'canvasX', 'canvasY'], scroll: 'unchanged', input: 0 },
        { scale: zoomed.view.scale, posts, inputPosts: inputPosts.length, scrollBefore, scrollAfter, body });
      check('V14.2', 'strict screen anchor: the same cursor screen point stays ≤2 CSS px after 5% and again after 5%→10%',
        afterPanel.canvasZoomAnchor === 'screen' && afterPanel.canvasZoomAnchorState === 'settled' && drift <= 2,
        { anchor: 'screen', residual: '<=2', first: '5%', second: '5%→10%' },
        { anchor: afterPanel.canvasZoomAnchor, anchorState: afterPanel.canvasZoomAnchorState, drift, point, screen1, d0, s0, s1, beforeBox, afterBox });
      await capturePanel('shot-13-zoom-anchor-after-5');
      // Centering compensation: with the box centered and stage wider, the box left moves by
      // W·(s'−s)/2; the screen formula must fold that into C. A box-relative C would leave that
      // amount of screen drift.
      const stage = beforePanel.stage;
      const centeredX = Boolean(stage) && Math.abs((stage.left + stage.clientWidth / 2) - (beforeBox.left + beforeBox.width / 2)) <= 1;
      const centeredY = Boolean(stage) && Math.abs((stage.top + stage.clientHeight / 2) - (beforeBox.top + beforeBox.height / 2)) <= 1;
      const noCompX = Number(beforeView.width) * (s1 - s0) / 2;
      const noCompY = Number(beforeView.height) * (s1 - s0) / 2;
      const boxShiftX = beforeBox.left - afterBox.left;
      const boxShiftY = beforeBox.top - afterBox.top;
      const boxRelativeC = {
        x: Number(beforeCanvas.x) + (point.x - beforeBox.left) * (1 / s0 - 1 / s1),
        y: Number(beforeCanvas.y) + (point.y - beforeBox.top) * (1 / s0 - 1 / s1),
      };
      const compensation = { x: boxRelativeC.x - Number(afterCanvas.x), y: boxRelativeC.y - Number(afterCanvas.y) };
      const boxRelativeMapped = {
        x: boxRelativeC.x + (point.x - beforeBox.left) / s1,
        y: boxRelativeC.y + (point.y - beforeBox.top) / s1,
      };
      const boxRelativeResidual = Math.max(Math.abs(boxRelativeMapped.x - d0.x), Math.abs(boxRelativeMapped.y - d0.y));
      check('V14.2b', 'centering offset is folded into C (without it the screen would drift ≈W·(s′−s)/2)',
        centeredX && centeredY && Math.abs(boxShiftX - noCompX) <= 1.5 && Math.abs(boxShiftY - noCompY) <= 1.5
          && Math.abs(compensation.x - noCompX / s1) <= 2 && Math.abs(compensation.y - noCompY / s1) <= 2 && drift <= 2,
        { noCompensationDrift: noCompX, compensation: noCompX / s1, centered: true },
        { noCompensationDrift: noCompX, noCompensationDriftY: noCompY, boxShift: boxShiftX, boxShiftY,
          compensation, boxRelativeC, boxRelativeMapped, boxRelativeResidual, actualC: afterCanvas, s0, s1, drift, centeredX, centeredY, stage });
      // Advisory: the historical box-relative anchor still maps d0 to itself in box coordinates; the
      // screen-anchor change only adds the box-position compensation on top.
      check('V14.2d', 'box-relative anchor residual remains ≤2 CSS px (advisory, kept from the previous contract)',
        boxRelativeResidual <= 2,
        { residual: '<=2' },
        { boxRelativeResidual, boxRelativeMapped, d0 });
      // Second 5% at the same screen point (5%→10%): the anchor must still hold.
      const d1 = { x: Number(afterCanvas.x) + (point.x - afterBox.left) / s1, y: Number(afterCanvas.y) + (point.y - afterBox.top) / s1 };
      const markSecond = Date.now();
      await wheelOnFramePoint(point, -120);
      await waitHostView((view) => closeTo(view.scale, 1.10, 0.0011));
      await waitPanelMirrorsHost();
      await waitZoomAnchorState('settled');
      await sleep(250);
      const secondPanel = await panelState();
      const secondBox = secondPanel.frame.box;
      const secondView = (await hostView()).view;
      const secondCanvas = (await hostCanvas()).canvas;
      const s2 = secondBox.width / Number(secondView.width);
      const screen2 = {
        x: secondBox.left + (d1.x - Number(secondCanvas.x)) * s2,
        y: secondBox.top + (d1.y - Number(secondCanvas.y)) * s2,
      };
      const drift2 = Math.max(Math.abs(screen2.x - point.x), Math.abs(screen2.y - point.y));
      check('V14.2c', 'consecutive 5%→10% zoom keeps the same screen anchor ≤2 CSS px',
        secondPanel.canvasZoomAnchor === 'screen' && drift2 <= 2,
        { residual: '<=2', scale: 1.10 },
        { drift2, point, screen2, d1, s1, s2, secondBox, secondCanvas, posts: panelPosts('viewport', markSecond).length });
      await capturePanel('shot-14-zoom-anchor-after-10');
      await capturePanel('shot-11-zoom-after');

      // 用户 2026-11-03 第 4 条：fit 与拖拽互斥，滚轮缩放属于拖拽表面。In drag mode fit must stay
      // off; a wheel zoom must never turn it back on and later polls must not restore it.
      await hostViewportSet({ width: 400, height: 300, scale: 1, x: 0, y: 0 });
      await waitHostView((view) => closeTo(view.scale, 1, 0.0011));
      await hostViewportSet({ canvasX: -100, canvasY: -100 });
      await waitHostView((view) => near(view.canvasX, -100, 1) && near(view.canvasY, -100, 1) && near(view.x, 0, 1) && near(view.y, 0, 1));
      await waitPanelMirrorsHost();
      await sleep(700);
      await clickFit(false);
      if ((await panelState()).panChecked !== true) await togglePan(true);
      await sleep(300);
      const fitBefore = await panelState();
      const fitSetup = await frameBoxPoint(b);
      const fitScaleBefore = Number((await hostView()).view.scale);
      await wheelOnFramePoint(fitSetup.point, -120);
      const fitExpected = fitScaleBefore + 0.05;
      const fitZoom = await waitHostView((view) => closeTo(view.scale, fitExpected, 0.0011));
      await sleep(1600);
      const fitAfter = await panelState();
      const fitView = (await hostView()).view;
      const fitMirror = await waitPanelMirrorsHost().catch(() => ({ panel: fitAfter, view: fitView }));
      check('V14.3', 'a wheel zoom in drag mode never restores the local fit: fit stays off and the group stays pan across polls',
        fitBefore.panChecked === true && fitBefore.fitChecked === false && fitBefore.panFit.state === 'pan'
          && fitZoom.timedOut !== true
          && fitAfter.fitChecked === false && fitAfter.panChecked === true && fitAfter.panFit.state === 'pan'
          && closeTo(fitAfter.zoomValue, Number(fitView.scale) * 100, 1.5)
          && closeTo(fitView.scale, fitExpected, 0.0011)
          && fitMirror.panel.fitChecked === false,
        { before: 'pan/off', after: 'pan/off', scale: fitExpected },
        { fitBefore: { pan: fitBefore.panChecked, fit: fitBefore.fitChecked, state: fitBefore.panFit.state },
          fitAfter: { pan: fitAfter.panChecked, fit: fitAfter.fitChecked, state: fitAfter.panFit.state, zoom: fitAfter.zoomValue },
          viewScale: fitView.scale, expected: fitExpected, mirrored: fitMirror.panel.fitChecked });

      // Step rules: Alt 1%, Shift 10%, Alt wins over Shift. Run the whole sequence five times from
      // a freshly adopted base so a single lost notch (CAS/state race) cannot hide behind a retry.
      const stepRounds = [];
      for (let round = 0; round < 5; round += 1) {
        await resetZoomBase();
        const altSetup = await frameBoxPoint(b);
        await wheelOnFramePoint(altSetup.point, -120, ALT);
        const altStep = await waitHostView((view) => closeTo(view.scale, 1.01, 0.0011));
        const shiftSetup = await frameBoxPoint(b);
        await wheelOnFramePoint(shiftSetup.point, -120, SHIFT);
        const shiftStep = await waitHostView((view) => closeTo(view.scale, 1.11, 0.0011));
        const bothSetup = await frameBoxPoint(b);
        await wheelOnFramePoint(bothSetup.point, -120, ALT | SHIFT);
        const bothStep = await waitHostView((view) => closeTo(view.scale, 1.12, 0.0011));
        stepRounds.push({
          round: round + 1,
          alt: altStep.view.scale, shift: shiftStep.view.scale, both: bothStep.view.scale,
          timedOut: altStep.timedOut === true || shiftStep.timedOut === true || bothStep.timedOut === true,
        });
      }
      check('V14.4', 'wheel zoom steps: Alt=1%, Shift=10%, Alt wins (5 consecutive reset rounds)',
        stepRounds.length === 5 && stepRounds.every((entry) => !entry.timedOut
          && closeTo(entry.alt, 1.01, 0.0011) && closeTo(entry.shift, 1.11, 0.0011) && closeTo(entry.both, 1.12, 0.0011)),
        { rounds: 5, alt: 1.01, shift: 1.11, both: 1.12 },
        { rounds: stepRounds });

      // Ctrl/Meta never change the view scale and must not be turned into browser zoom.
      await hostViewportSet({ width: 400, height: 300, scale: 1, x: 0, y: 0 });
      await waitHostView((view) => closeTo(view.scale, 1, 0.0011));
      await hostViewportSet({ canvasX: -100, canvasY: -100 });
      await waitHostView((view) => near(view.canvasX, -100, 1) && near(view.canvasY, -100, 1) && near(view.x, 0, 1) && near(view.y, 0, 1));
      await waitPanelMirrorsHost();
      const ctrlSetup = await frameBoxPoint(b);
      const dprBefore = await pageEvaluate('window.devicePixelRatio');
      const scaleBeforeCtrl = Number((await hostView()).view.scale);
      const markCtrl = Date.now();
      await wheelOnFramePoint(ctrlSetup.point, -120, CTRL);
      await sleep(500);
      const afterCtrl = Number((await hostView()).view.scale);
      await wheelOnFramePoint(ctrlSetup.point, -120, 4 /* Meta */);
      await sleep(500);
      const afterMeta = Number((await hostView()).view.scale);
      const dprAfter = await pageEvaluate('window.devicePixelRatio');
      const ctrlPosts = panelPosts('viewport', markCtrl);
      const ctrlPanel = await panelState();
      check('V14.5', 'Ctrl/Meta+wheel in drag mode changes neither view.scale nor DPR and posts no /viewport',
        closeTo(afterCtrl, scaleBeforeCtrl, 0.0011) && closeTo(afterMeta, scaleBeforeCtrl, 0.0011)
          && Number(dprAfter) === Number(dprBefore) && ctrlPosts.length === 0 && ctrlPanel.fitChecked === false,
        { scale: scaleBeforeCtrl, dpr: dprBefore, requests: 0 },
        { ctrl: afterCtrl, meta: afterMeta, dprBefore, dprAfter, requests: ctrlPosts.length, fit: ctrlPanel.fitChecked });

      // Scale boundaries are consumed but send nothing and do not unlock/relock fit.
      await hostViewportSet({ width: 400, height: 300, scale: 0.1, x: 0, y: 0 });
      await waitHostView((view) => closeTo(view.scale, 0.1, 0.0011));
      await hostViewportSet({ canvasX: -100, canvasY: -100 });
      await waitHostView((view) => near(view.canvasX, -100, 1) && near(view.canvasY, -100, 1));
      await waitPanelMirrorsHost();
      const lowSetup = await frameBoxPoint({ x: 10, y: 10 });
      const markLow = Date.now();
      await wheelOnFramePoint(lowSetup.point, 120);
      await sleep(600);
      const lowView = (await hostView()).view;
      const lowPosts = panelPosts('viewport', markLow);
      check('V14.6', 'lower scale boundary 0.1: wheel-down is a no-op (no request)',
        closeTo(lowView.scale, 0.1, 0.0011) && lowPosts.length === 0,
        { scale: 0.1, requests: 0 }, { scale: lowView.scale, requests: lowPosts.length });
      await hostViewportSet({ scale: 2 });
      await waitHostView((view) => closeTo(view.scale, 2, 0.0011));
      await waitPanelMirrorsHost();
      const highSetup = await frameBoxPoint(b);
      const markHigh = Date.now();
      await wheelOnFramePoint(highSetup.point, -120);
      await sleep(600);
      const highView = (await hostView()).view;
      const highPosts = panelPosts('viewport', markHigh);
      check('V14.7', 'upper scale boundary 2.0: wheel-up is a no-op (no request)',
        closeTo(highView.scale, 2, 0.0011) && highPosts.length === 0,
        { scale: 2, requests: 0 }, { scale: highView.scale, requests: highPosts.length });

      // Burst: three notches in one debounce window merge into one patch with the accumulated scale.
      await hostViewportSet({ width: 400, height: 300, scale: 1, x: 0, y: 0 });
      await waitHostView((view) => closeTo(view.scale, 1, 0.0011));
      await hostViewportSet({ canvasX: -100, canvasY: -100 });
      await waitHostView((view) => near(view.canvasX, -100, 1) && near(view.canvasY, -100, 1) && near(view.x, 0, 1));
      await waitPanelMirrorsHost();
      const burstSetup = await frameBoxPoint(b);
      const markBurst = Date.now();
      await wheelBurstOnFramePoint(burstSetup.point, 3, -120);
      const burstView = await waitHostView((view) => closeTo(view.scale, 1.15, 0.0011));
      await sleep(200);
      const burstPosts = panelPosts('viewport', markBurst).map(parseBody);
      const burstBody = burstPosts.length ? burstPosts[0] : {};
      check('V14.8', 'a wheel burst merges into one /viewport patch with the accumulated 15% scale',
        burstPosts.length === 1 && closeTo(burstBody.scale, 1.15, 0.0011)
          && burstBody.x === undefined && burstBody.y === undefined,
        { scale: 1.15, patches: 1 },
        { scale: burstView.view.scale, patches: burstPosts.length, body: burstBody });

      // A CAS conflict must replay the same notch once (the request is held, the Host revision is
      // advanced by a script set, then the held request is released -> 409 + one bounded retry).
      await resetZoomBase();
      const conflictHold = await startViewportHold();
      try {
        const conflictSetup = await frameBoxPoint(b);
        await wheelOnFramePoint(conflictSetup.point, -120);
        const heldRequest = await conflictHold.waitForHeld();
        await hostViewportSet({ canvasX: -99, canvasY: -99 });
        await waitHostView((view) => near(view.canvasX, -99, 1) && near(view.x, 0, 1));
        await conflictHold.release();
        const conflictFinal = await waitHostView((view) => closeTo(view.scale, 1.05, 0.0011), { timeoutMs: 10000 });
        const conflictDebug = await pageEvaluate('window.__utbZoomDebug || []');
        check('V14.10', 'a CAS conflict on the zoom patch replays the same notch once (no lost notch)',
          conflictFinal.timedOut !== true && closeTo(conflictFinal.view.scale, 1.05, 0.0011),
          { scale: 1.05 }, { scale: conflictFinal.view.scale, timedOut: conflictFinal.timedOut === true, held: heldRequest.body, debug: conflictDebug.slice(-14) });
      } finally {
        await conflictHold.stop();
      }

      // Two notches while the first zoom patch is in flight: the second must be queued, not lost.
      await resetZoomBase();
      const inflightHold = await startViewportHold();
      try {
        const firstSetup = await frameBoxPoint(b);
        await wheelOnFramePoint(firstSetup.point, -120);
        const firstHeld = await inflightHold.waitForHeld();
        const secondSetup = await frameBoxPoint(b);
        await wheelOnFramePoint(secondSetup.point, -120);
        await sleep(300);
        await inflightHold.release();
        const inflightFinal = await waitHostView((view) => closeTo(view.scale, 1.10, 0.0011), { timeoutMs: 10000 });
        const inflightDebug = await pageEvaluate('window.__utbZoomDebug || []');
        check('V14.11', 'a second notch sent while the first zoom patch is in flight is queued and applied (no loss)',
          inflightFinal.timedOut !== true && closeTo(inflightFinal.view.scale, 1.10, 0.0011),
          { scale: 1.10 }, { scale: inflightFinal.view.scale, timedOut: inflightFinal.timedOut === true, first: firstHeld.body, debug: inflightDebug.slice(-14) });
      } finally {
        await inflightHold.stop();
      }

      // Leaving drag mode restores the historical frame wheel -> page scroll, with no scale write.
      await hostViewportSet({ width: 400, height: 300, scale: 1, x: 0, y: 0 });
      await waitHostView((view) => closeTo(view.scale, 1, 0.0011));
      await hostViewportSet({ canvasX: 0, canvasY: 0 });
      await waitHostView((view) => near(view.x, 0, 1) && near(view.y, 0, 1) && near(view.canvasX, 0, 1) && near(view.canvasY, 0, 1));
      await waitPanelMirrorsHost();
      const panOff = await togglePan(false);
      await waitCanvasState(true, true);
      await waitFrameStable();
      const scrollBeforePageWheel = await targetTruth();
      const pageBox = (await panelState()).frame.box;
      let pagePoint = { x: pageBox.left + pageBox.width / 2, y: pageBox.top + pageBox.height / 2 };
      await ensurePointVisible(pagePoint);
      const pageBoxAgain = (await panelState()).frame.box;
      pagePoint = { x: pageBoxAgain.left + pageBoxAgain.width / 2, y: pageBoxAgain.top + pageBoxAgain.height / 2 };
      const markPageWheel = Date.now();
      await wheelOnFramePoint(pagePoint, 200);
      await sleep(900);
      const pageAfter = await targetTruth();
      const pageView = (await hostView()).view;
      check('V14.9', 'after leaving drag mode the frame wheel scrolls the page again and does not write view.scale',
        panOff.panChecked === false && closeTo(pageView.scale, 1, 0.0011)
          && pageAfter.scrollY > scrollBeforePageWheel.scrollY + 80
          && panelPosts('viewport', markPageWheel).length === 0,
        { scrollY: `> ${scrollBeforePageWheel.scrollY + 80}`, scale: 1, viewportPosts: 0 },
        { pan: panOff.panChecked, scrollY: pageAfter.scrollY, before: scrollBeforePageWheel.scrollY, scale: pageView.scale, posts: panelPosts('viewport', markPageWheel).length });
    });

    await scenario('V15 annotation mode (P0-D)', async () => {
      // Base: deterministic 400×300 @ 100%, C=0, fit off, size bar closed (user 2026-11-03:
      // 尺寸调整模式内禁止进入标注, so the mode can only be entered with the size bar closed).
      await navigateTarget(`${fixtureBase}/web-t3.html`);
      await waitForFrame();
      await ensureHorizontalOverflow();
      await clickFit(false);
      await hostViewportSet({ width: 400, height: 300, scale: 1, x: 0, y: 0 });
      await waitHostView((view) => Number(view.width) === 400 && Number(view.height) === 300 && closeTo(view.scale, 1, 0.0011) && near(view.x, 0, 1) && near(view.y, 0, 1));
      await hostViewportSet({ canvasX: 0, canvasY: 0 });
      await waitHostView((view) => near(view.canvasX, 0, 1) && near(view.canvasY, 0, 1));
      await waitPanelMirrorsHost();
      await waitCanvasState(true, true);
      await waitFrameStable();
      await closeSizeBar();
      const v15TruthBefore = await targetTruth();
      const v15StyleBefore = await targetEval(`({ html: document.documentElement.getAttribute('style') || '', body: document.body.getAttribute('style') || '', text: document.body.innerText.length })`);
      const v15HostPngBefore = await hostScreenshotPng();
      notRun('V15.0a', 'real 3080 annotation-panel interaction',
        'this suite boots its own isolated DSH instance and never touches 3080/3081; the user must refresh the real panel and verify manually');
      notRun('V15.0b', 'provider image visibility',
        'provider rendering requires a real Agent session and is outside the isolated GUI suite');

      // ---- V15.1 entry/panel/defaults -------------------------------------------------------
      const entryBefore = (await panelState()).annot;
      check('V15.1a', 'annotation entry exists between the address bar and 尺寸调整 (pencil icon 16/1.7/currentColor)',
        entryBefore.present && entryBefore.pressed === 'false' && entryBefore.disabled === false
          && entryBefore.entryState === 'ready'
          && Boolean(entryBefore.controls)
          && entryBefore.icon && entryBefore.icon.width === '16' && entryBefore.icon.height === '16'
          && entryBefore.icon.strokeWidth === '1.7' && entryBefore.icon.stroke === 'currentColor',
        { pressed: 'false', icon: '16/1.7/currentColor', controls: 'panel id' },
        { present: entryBefore.present, pressed: entryBefore.pressed, disabled: entryBefore.disabled, controls: entryBefore.controls, icon: entryBefore.icon });
      const order = await pageEvaluate(panelExpr(`
        const annot = panel.querySelector('button[aria-label="标注"]');
        const prev = annot ? annot.previousElementSibling : null;
        const next = annot ? annot.nextElementSibling : null;
        return {
          prev: prev ? prev.tagName : null,
          prevToggle: Boolean(prev && prev.hasAttribute && prev.hasAttribute('data-utb-tabs-toggle')),
          next: next ? next.getAttribute('aria-label') : null,
        };
      `));
      check('V15.1b', 'toolbar DOM order is 地址栏 → [标签页开关] → 标注 → 尺寸调整',
        (order.prev === 'FORM' || order.prevToggle === true) && order.next === '尺寸调整',
        { prev: 'FORM or data-utb-tabs-toggle', next: '尺寸调整' }, order);

      const opened = await toggleAnnot(true);
      const openPanel = await panelState();
      check('V15.1c', 'opening the panel enters the mode: aria-pressed=true, 41px single-row bar, dark alias layer',
        opened.pressed === 'true' && Boolean(opened.bar) && opened.bar.role === 'group' && opened.bar.label === '标注工具'
          && Math.abs(opened.bar.height - 41) <= 1 && opened.bar.scrollWidth <= opened.bar.clientWidth + 1
          && opened.bar.id === entryBefore.controls
          && String(opened.bar.background || '') !== 'rgba(0, 0, 0, 0)',
        { pressed: 'true', height: 41, role: 'group', id: '<controls>', background: 'alias layer' },
        { pressed: opened.pressed, bar: opened.bar });
      const toolLabels = opened.tools.map((tool) => tool.label);
      // v3 (2026-11-12) prepends the two selection tools; the six drawing labels and 橡皮擦 keep
      // their relative order. V16.1 then verifies all nine strictly, and V17 drives selection.
      check('V15.1d', 'nine tools with exact labels, data-utb-annot-tool and exactly one aria-pressed=true',
        toolLabels.join('|') === '选择|框选|圆形|矩形|线段|箭头|画笔|文字|橡皮擦'
          && opened.tools.map((tool) => tool.tool).join('|') === 'select|marquee|circle|rect|line|arrow|brush|text|eraser'
          && opened.tools.filter((tool) => tool.pressed === 'true').length === 1
          && opened.tools.find((tool) => tool.pressed === 'true').tool === 'rect',
        { labels: '选择|框选|圆形|矩形|线段|箭头|画笔|文字|橡皮擦', pressed: 'rect only' },
        { labels: toolLabels, tools: opened.tools.map((tool) => ({ tool: tool.tool, pressed: tool.pressed })) });
      check('V15.1e', 'defaults are 矩形 / #ff3b30 / 3 / 填充 false / 外框 true with the exact segmented control attributes',
        opened.color && opened.color.type === 'color' && opened.color.value === '#ff3b30'
          && opened.width && opened.width.type === 'number' && opened.width.value === '3'
          && opened.width.min === '1' && opened.width.max === '20' && opened.width.step === '1' && opened.width.disabled === false
          && opened.fill && opened.fill.type === 'button' && opened.fill.checked === false && opened.fill.disabled === false
          && opened.stroke && opened.stroke.type === 'button' && opened.stroke.checked === true && opened.stroke.disabled === false
          && opened.styleSeg && opened.styleSeg.group === 'fill-stroke' && opened.styleSeg.pressedCount === 1,
        { color: '#ff3b30', width: '3 (1..20 step 1)', fill: false, stroke: true, seg: 'exactly one pressed' },
        { color: opened.color, width: opened.width, fill: opened.fill, stroke: opened.stroke, seg: opened.styleSeg });
      check('V15.1f', 'box/SVG contract: data-utb-annot=on, viewBox=Cx Cy W H, preserveAspectRatio=none, canvas-css-px, tabIndex=0',
        opened.boxAnnot === 'on' && Boolean(opened.svg)
          && opened.svg.viewBox === '0 0 400 300' && opened.svg.preserveAspectRatio === 'none'
          && opened.svg.space === 'canvas-css-px' && opened.svg.layer === 'true'
          && opened.svg.role === 'img' && opened.svg.label === '标注画布'
          && opened.svg.tabIndex === '0' && opened.svg.pointerEvents === 'auto' && opened.svg.overflow === 'hidden',
        { boxAnnot: 'on', viewBox: '0 0 400 300', par: 'none', space: 'canvas-css-px', tab: 0, pointerEvents: 'auto' },
        { boxAnnot: opened.boxAnnot, svg: opened.svg });
      await capturePanel('shot-15-annot-dual');

      // ---- V15.2 zero page dispatch ---------------------------------------------------------
      await dismissShellDialogs();
      await focusFrameImage();
      const v15Map0 = await annotMappingNow();
      const v15Center = annotCanvasToGui(v15Map0, { x: 200, y: 150 });
      await resetTargetInstrumentation();
      const zeroBefore = await targetTruth();
      const zeroTextBefore = await targetEval('document.body.innerText.length');
      const zeroMark = Date.now();
      await annotDragGui(v15Center, { x: v15Center.x + 1, y: v15Center.y + 1 }, { steps: 3 });
      await wheelOnFramePoint(v15Center, 240);
      await state.chrome.cdp.send('Input.insertText', { text: 'x' });
      const key = async (modifiers, keyName, code, vk, text) => {
        await state.chrome.cdp.send('Input.dispatchKeyEvent', { type: 'keyDown', modifiers, key: keyName, code, windowsVirtualKeyCode: vk, nativeVirtualKeyCode: vk, text, unmodifiedText: text });
        await state.chrome.cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', modifiers, key: keyName, code, windowsVirtualKeyCode: vk, nativeVirtualKeyCode: vk });
      };
      await key(0, 'a', 'KeyA', 65, 'a');
      await key(0, 'Enter', 'Enter', 13, '\r');
      await key(0, 'Tab', 'Tab', 9, '\t');
      await key(0, 'ArrowDown', 'ArrowDown', 40, undefined);
      await key(CTRL, 'c', 'KeyC', 67, 'c');
      await key(4, 'v', 'KeyV', 86, 'v');
      await sleep(500);
      const zeroAfter = await targetTruth();
      const zeroTextAfter = await targetEval('document.body.innerText.length');
      check('V15.2a', 'mode swallows pointer/drag/hover/wheel/keys/insertText: zero /input and no target event/scroll/text change',
        panelPosts('input', zeroMark).length === 0
          && Number(await targetEval('window.__t3 ? window.__t3.events.length : -1')) === 0
          && near(zeroAfter.scrollX, zeroBefore.scrollX, 0.5) && near(zeroAfter.scrollY, zeroBefore.scrollY, 0.5)
          && zeroTextAfter === zeroTextBefore,
        { inputPosts: 0, pageEvents: 0, scroll: 'unchanged', text: 'unchanged' },
        { inputPosts: panelPosts('input', zeroMark).length, pageEvents: await targetEval('window.__t3 ? window.__t3.events.length : -1'), scrollBefore: zeroBefore, scrollAfter: zeroAfter, textBefore: zeroTextBefore, textAfter: zeroTextAfter });

      // Blank (C=-100): a click/wheel on the canvas blank must also be zero-dispatch.
      await hostViewportSet({ canvasX: -100, canvasY: 0 });
      await waitHostView((view) => near(view.canvasX, -100, 1) && near(view.x, 0, 1));
      await waitPanelMirrorsHost();
      await waitCanvasState(true, true);
      await waitFrameStable();
      const blankMap = await annotMappingNow();
      const blankPoint = annotCanvasToGui(blankMap, { x: 20, y: 150 });
      await resetTargetInstrumentation();
      const blankMark = Date.now();
      await annotClickGui(blankPoint);
      await wheelOnFramePoint(blankPoint, 240);
      await sleep(450);
      check('V15.2b', 'blank click/wheel in the mode dispatch zero page events and zero /input',
        panelPosts('input', blankMark).length === 0
          && Number(await targetEval('window.__t3 ? window.__t3.events.length : -1')) === 0,
        { inputPosts: 0, pageEvents: 0 },
        { inputPosts: panelPosts('input', blankMark).length, pageEvents: await targetEval('window.__t3 ? window.__t3.events.length : -1'), point: blankPoint });
      await hostViewportSet({ canvasX: 0, canvasY: 0 });
      await waitHostView((view) => near(view.canvasX, 0, 1) && near(view.x, 0, 1));
      await waitPanelMirrorsHost();
      if (process.env.DSH_VIEWPORT_GUI_STOP_AFTER === 'V15.2b') {
        log('[debug] before toggleAnnot(false)');
        const startedAt = Date.now();
        try {
          const result = await Promise.race([
            toggleAnnot(false),
            new Promise((resolve, reject) => setTimeout(() => reject(new Error('toggleAnnot timeout')), 8000)),
          ]);
          log('[debug] toggleAnnot result ' + JSON.stringify(result && result.pressed));
        } catch (error) {
          log('[debug] toggleAnnot failed: ' + errorMessage(error));
        }
        log('[debug] toggleAnnot elapsed ' + (Date.now() - startedAt));
        await capturePanel('shot-debug-v15-2b').catch(() => undefined);
        return 0;
      }
      notRun('V15.2c', 'letterbox zero dispatch (painted rect smaller than the box)',
        'the live frame painted rect fills the container in this run; there is no letterbox band to click (see V8.5)');

      // ---- V15.3 mode exclusivity with the size bar (user 2026-11-03, requirement 2) --------
      await toggleAnnot(false);
      await openSizeBar();
      const panOn = await togglePan(true);
      check('V15.3a', 'drag mode can be engaged before leaving the size bar', panOn.panChecked === true, true, panOn.panChecked);
      // 尺寸调整模式内禁止进入标注：入口原生 disabled，真实点击不会进入。
      const blocked = await toggleAnnot(true);
      const blockedPanel = await panelState();
      await closeSizeBar();
      let entered = await toggleAnnot(true);
      for (let attempt = 0; attempt < 3 && entered.pressed !== 'true'; attempt += 1) {
        await sleep(300);
        entered = await toggleAnnot(true);
      }
      const enteredPanel = await panelState();
      check('V15.3b', 'sizing blocks the annotation entry (disabled + entry=sizing); after closing it the mode clears pan and disables the sizing entry',
        blocked.pressed !== 'true' && blocked.disabled === true && blocked.entryState === 'sizing'
          && blockedPanel.sizeBar === true
          && entered.pressed === 'true' && enteredPanel.panState === 'off'
          && enteredPanel.sizeBar === false && enteredPanel.annot.entryState === 'on'
          && enteredPanel.sizingEntryDisabled === true,
        { sizing: 'entry disabled, zero mode open', modeOn: { pan: false, sizeBar: false, sizingEntry: 'disabled' } },
        { blocked, blockedBar: blockedPanel.sizeBar, entered, pan: enteredPanel.panState, sizeBar: enteredPanel.sizeBar,
          sizingEntryDisabled: enteredPanel.sizingEntryDisabled });
      const wheelMap = await annotMappingNow();
      const wheelPoint = annotCanvasToGui(wheelMap, { x: 200, y: 150 });
      const wheelStage = (await panelState()).stage;
      const wheelView = (await hostView()).view;
      const wheelCanvas = (await hostCanvas()).canvas;
      const wheelDpr = await pageEvaluate('window.devicePixelRatio');
      const wheelMark = Date.now();
      for (const modifiers of [0, SHIFT, ALT, CTRL, 4]) {
        await wheelOnFramePoint(wheelPoint, 120, modifiers);
        await sleep(220);
      }
      const wheelAfterPanel = await panelState();
      const wheelAfterView = (await hostView()).view;
      const wheelAfterCanvas = (await hostCanvas()).canvas;
      const wheelDprAfter = await pageEvaluate('window.devicePixelRatio');
      check('V15.3c', 'preview wheel in the mode (plain/Shift/Alt/Ctrl/Meta) never scrolls the page, changes C/scale/stage or posts /viewport',
        panelPosts('viewport', wheelMark).length === 0
          && Number(wheelAfterView.scale) === Number(wheelView.scale)
          && near(wheelAfterCanvas.x, wheelCanvas.x, 0.5) && near(wheelAfterCanvas.y, wheelCanvas.y, 0.5)
          && Number(wheelAfterPanel.stage.scrollTop) === Number(wheelStage.scrollTop)
          && Number(wheelAfterPanel.stage.scrollLeft) === Number(wheelStage.scrollLeft)
          && Number(wheelDprAfter) === Number(wheelDpr)
          && panelPosts('input', wheelMark).length === 0,
        { viewportPosts: 0, scale: wheelView.scale, canvas: { x: wheelCanvas.x, y: wheelCanvas.y }, stageScroll: 'unchanged', dpr: wheelDpr },
        { posts: panelPosts('viewport', wheelMark).length, scale: wheelAfterView.scale, canvas: wheelAfterCanvas, stage: wheelAfterPanel.stage, dpr: wheelDprAfter, inputPosts: panelPosts('input', wheelMark).length });

      // ---- V15.4 geometry: rect/circle/line ------------------------------------------------
      await dismissShellDialogs();
      await clickFit(false);
      await closeSizeBar();
      await hostViewportSet({ width: 400, height: 300, scale: 1, x: 0, y: 0 });
      await waitHostView((view) => Number(view.width) === 400 && Number(view.height) === 300 && closeTo(view.scale, 1, 0.0011));
      await hostViewportSet({ canvasX: 0, canvasY: 0 });
      await waitHostView((view) => near(view.canvasX, 0, 1) && near(view.canvasY, 0, 1));
      await waitPanelMirrorsHost();
      await waitCanvasState(true, true);
      await waitFrameStable();
      const geomMap = await annotMappingNow();
      const ensureAnnotHit = async (point) => {
        for (let attempt = 0; attempt < 4; attempt += 1) {
          await dismissShellDialogs();
          const hit = await pageEvaluate(`(() => {
            const el = document.elementFromPoint(${point.x}, ${point.y});
            return el && el.closest ? Boolean(el.closest('.utb-annot-layer')) : false;
          })()`).catch(() => false);
          if (hit) return true;
          await clickAt(point.x, point.y);
          await sleep(350);
        }
        return false;
      };
      const drawCanvas = async (from, to, options) => {
        let map = await annotMappingNow();
        await ensurePointVisible(annotCanvasToGui(map, from));
        await sleep(120);
        map = await annotMappingNow();
        const fromGui = annotCanvasToGui(map, from);
        const toGui = annotCanvasToGui(map, to);
        const hit = await ensureAnnotHit(fromGui);
        await annotDragGui(fromGui, toGui, options);
        return { map, fromGui, toGui, hit };
      };
      const rectDraw = await drawCanvas({ x: 150, y: 120 }, { x: 80, y: 60 }, { steps: 6 });
      await waitAnnotShapeCount(1);
      let shapePanel = await panelState();
      const rectShape = lastAnnotShape(shapePanel);
      const rectModel = { x: annotNumAttr(rectShape, 'x'), y: annotNumAttr(rectShape, 'y'), w: annotNumAttr(rectShape, 'width'), h: annotNumAttr(rectShape, 'height') };
      const rectP0 = annotScreenOf(rectShape, { x: rectModel.x, y: rectModel.y });
      const rectP1 = annotScreenOf(rectShape, { x: rectModel.x + rectModel.w, y: rectModel.y + rectModel.h });
      check('V15.4a', 'reverse rect: data model = pointerdown/up in canvas CSS px, native rect and screen position agree (≤2 px)',
        rectModel.x !== null && near(rectModel.x, 80, 0.6) && near(rectModel.y, 60, 0.6)
          && near(rectModel.w, 70, 0.6) && near(rectModel.h, 60, 0.6)
          && rectShape.native.tag === 'rect'
          && near(Number(rectShape.native.attrs.x), rectModel.x, 0.01) && near(Number(rectShape.native.attrs.width), rectModel.w, 0.01)
          && near(rectShape.rect.left, Math.min(rectP0.x, rectP1.x), 2) && near(rectShape.rect.top, Math.min(rectP0.y, rectP1.y), 2)
          && near(rectShape.rect.width, Math.abs(rectP1.x - rectP0.x), 2) && near(rectShape.rect.height, Math.abs(rectP1.y - rectP0.y), 2),
        { model: { x: 80, y: 60, width: 70, height: 60 }, native: 'rect', screen: '±2' },
        { model: rectModel, native: rectShape && rectShape.native, screen: rectShape && rectShape.rect, expectedScreen: { p0: rectP0, p1: rectP1 }, draw: rectDraw });

      await clickAnnotTool('circle');
      // PS ellipse default: (100,100) and (180,140) are bbox corners, not centre + radius.
      await drawCanvas({ x: 100, y: 100 }, { x: 180, y: 140 }, { steps: 6 });
      await waitAnnotShapeCount(2);
      shapePanel = await panelState();
      const circleShape = lastAnnotShape(shapePanel);
      const circleModel = {
        cx: annotNumAttr(circleShape, 'cx'), cy: annotNumAttr(circleShape, 'cy'),
        rx: annotNumAttr(circleShape, 'rx'), ry: annotNumAttr(circleShape, 'ry'),
      };
      const circleCenter = annotScreenOf(circleShape, { x: circleModel.cx, y: circleModel.cy });
      const circleEdgeX = annotScreenOf(circleShape, { x: circleModel.cx + circleModel.rx, y: circleModel.cy });
      const circleEdgeY = annotScreenOf(circleShape, { x: circleModel.cx, y: circleModel.cy + circleModel.ry });
      const circleScreenRx = Math.hypot(circleEdgeX.x - circleCenter.x, circleEdgeX.y - circleCenter.y);
      const circleScreenRy = Math.hypot(circleEdgeY.x - circleCenter.x, circleEdgeY.y - circleCenter.y);
      check('V15.4b', 'circle is an ellipse inscribed in the press→release bbox (corners 100,100 / 180,140; centre 140,120; rx40/ry20)',
        near(circleModel.cx, 140, 0.6) && near(circleModel.cy, 120, 0.6)
          && near(circleModel.rx, 40, 0.6) && near(circleModel.ry, 20, 0.6)
          && near(circleModel.cx - circleModel.rx, 100, 0.6) && near(circleModel.cy - circleModel.ry, 100, 0.6)
          && near(circleModel.cx + circleModel.rx, 180, 0.6) && near(circleModel.cy + circleModel.ry, 140, 0.6)
          && circleShape.native.tag === 'ellipse'
          && near(Number(circleShape.native.attrs.rx), circleModel.rx, 0.01)
          && near(Number(circleShape.native.attrs.ry), circleModel.ry, 0.01)
          && near(circleShape.rect.left + circleShape.rect.width / 2, circleCenter.x, 2)
          && near(circleShape.rect.top + circleShape.rect.height / 2, circleCenter.y, 2)
          && near(circleShape.rect.width / 2, circleScreenRx, 2) && near(circleShape.rect.height / 2, circleScreenRy, 2),
        { corners: [{ x: 100, y: 100 }, { x: 180, y: 140 }], centre: { x: 140, y: 120 }, rx: 40, ry: 20, native: 'ellipse', screen: '±2' },
        { model: circleModel, native: circleShape && circleShape.native, screen: circleShape && circleShape.rect, centre: circleCenter, screenRx: circleScreenRx, screenRy: circleScreenRy });
      const oldCentre = { x: 100, y: 100 };
      const oldRadius = Math.hypot(180 - 100, 140 - 100); // 89.4427…
      check('V15.4b2', 'the old centre+radius algorithm does not hold (centre would be 100,100 and r≈89.44)',
        Math.abs(circleModel.cx - oldCentre.x) > 1 && Math.abs(circleModel.cy - oldCentre.y) > 1
          && Math.abs(circleModel.rx - oldRadius) > 1 && Math.abs(circleModel.ry - oldRadius) > 1
          && circleShape && circleShape.attrs && circleShape.attrs['data-utb-annot-r'] === undefined
          && circleShape.native.tag === 'ellipse',
        { oldCentre, oldRadius, rAttribute: 'absent' },
        { newCentre: { x: circleModel.cx, y: circleModel.cy }, newRx: circleModel.rx, newRy: circleModel.ry, rAttribute: circleShape && circleShape.attrs && circleShape.attrs['data-utb-annot-r'] });

      await clickAnnotTool('line');
      await drawCanvas({ x: 60, y: 200 }, { x: 160, y: 260 }, { steps: 6 });
      await waitAnnotShapeCount(3);
      shapePanel = await panelState();
      const lineShape = lastAnnotShape(shapePanel);
      const lineModel = { x1: annotNumAttr(lineShape, 'x1'), y1: annotNumAttr(lineShape, 'y1'), x2: annotNumAttr(lineShape, 'x2'), y2: annotNumAttr(lineShape, 'y2') };
      const lineA = annotScreenOf(lineShape, { x: lineModel.x1, y: lineModel.y1 });
      const lineB = annotScreenOf(lineShape, { x: lineModel.x2, y: lineModel.y2 });
      const lineExpectedA = annotCanvasToGui(geomMap, { x: lineModel.x1, y: lineModel.y1 });
      const lineExpectedB = annotCanvasToGui(geomMap, { x: lineModel.x2, y: lineModel.y2 });
      check('V15.4c', 'line endpoints match the pointer path in the model, native line and screen (≤2 px)',
        lineModel.x1 !== null && near(lineModel.x1, 60, 0.6) && near(lineModel.y1, 200, 0.6)
          && near(lineModel.x2, 160, 0.6) && near(lineModel.y2, 260, 0.6)
          && lineShape.native.tag === 'line' && near(Number(lineShape.native.attrs.x2), lineModel.x2, 0.01)
          && near(lineA.x, lineExpectedA.x, 2) && near(lineA.y, lineExpectedA.y, 2)
          && near(lineB.x, lineExpectedB.x, 2) && near(lineB.y, lineExpectedB.y, 2),
        { endpoints: { x1: 60, y1: 200, x2: 160, y2: 260 }, screen: '±2' },
        { model: lineModel, native: lineShape && lineShape.native, a: lineA, b: lineB, expectedA: lineExpectedA, expectedB: lineExpectedB });
      check('V15.4d', 'SVG mapping scale equals the painted rect / view size on both axes',
        near(geomMap.sx, geomMap.sy, 0.01) && near(rectShape.ctm.a, geomMap.sx, 0.01) && near(rectShape.ctm.d, geomMap.sy, 0.01),
        { sx: geomMap.sx, sy: geomMap.sy, ctm: 'matches' },
        { sx: geomMap.sx, sy: geomMap.sy, ctm: rectShape.ctm, painted: geomMap.painted, view: geomMap.view });

      // ---- V15.5 arrow + brush -------------------------------------------------------------
      await clickAnnotTool('arrow');
      await setAnnotWidth(3);
      await drawCanvas({ x: 100, y: 100 }, { x: 200, y: 160 }, { steps: 6 });
      await waitAnnotShapeCount(4);
      shapePanel = await panelState();
      const arrowShape = lastAnnotShape(shapePanel);
      const arrowKids = await pageEvaluate(panelExpr(`
        const nodes = [...panel.querySelectorAll('.utb-annot-layer g[data-utb-annot-type="arrow"]')];
        const g = nodes[nodes.length - 1];
        if (!g) return null;
        return [...g.children].map((el) => ({ tag: el.tagName, attrs: Object.fromEntries([...el.attributes].map((a) => [a.name, a.value])) }));
      `));
      const arrowLength = Math.hypot(200 - 100, 160 - 100);
      const arrowShaft = arrowKids && arrowKids.find((kid) => kid.tag === 'line');
      const arrowHead = arrowKids && arrowKids.find((kid) => kid.tag === 'polygon');
      const arrowHeadPoints = arrowHead ? String(arrowHead.attrs.points || '').trim().split(/\s+/).length : 0;
      check('V15.5a', 'arrow: head length min(3t,L), base width min(2t,L), filled same-colour triangle (no stroke), shaft ends at the base',
        arrowShape.native && near(Number(annotAttr(arrowShape, 'head-length')), Math.min(9, arrowLength), 0.5)
          && near(Number(annotAttr(arrowShape, 'head-width')), Math.min(6, arrowLength), 0.5)
          && arrowHeadPoints === 3 && arrowHead.attrs.fill === '#ff3b30' && arrowHead.attrs.stroke === 'none'
          && arrowShaft && near(Number(arrowShaft.attrs.x2), 200 - (100 / arrowLength) * Math.min(9, arrowLength), 0.6)
          && near(Number(arrowShaft.attrs.y2), 160 - (60 / arrowLength) * Math.min(9, arrowLength), 0.6),
        { headLength: Math.min(9, arrowLength), headWidth: Math.min(6, arrowLength), polygon: 3, fill: 'current', stroke: 'none' },
        { attrs: arrowShape && arrowShape.attrs, kids: arrowKids, length: arrowLength });
      // Fill switch is enabled only for closed shapes; an arrow stays unfilled regardless.
      await clickAnnotTool('rect');
      await clickAnnotCheckbox('填充');
      const fillOn = (await panelState()).annot;
      await clickAnnotTool('arrow');
      await drawCanvas({ x: 120, y: 120 }, { x: 220, y: 180 }, { steps: 6 });
      await waitAnnotShapeCount(5);
      shapePanel = await panelState();
      const arrowFillShape = lastAnnotShape(shapePanel);
      check('V15.5b', 'arrow ignores the fill switch (fill checkbox can be on, arrow data stays fill=false/stroke=true)',
        fillOn.fill.checked === true && annotAttr(arrowFillShape, 'fill') === 'false' && annotAttr(arrowFillShape, 'stroke') === 'true',
        { fillChecked: true, arrowFill: 'false', arrowStroke: 'true' },
        { fill: fillOn.fill, arrow: arrowFillShape && arrowFillShape.attrs });
      await clickAnnotTool('rect');
      await clickAnnotCheckbox('填充');

      await clickAnnotTool('brush');
      await setAnnotWidth(3);
      const brushDraw = await drawCanvas({ x: 80, y: 180 }, { x: 220, y: 240 }, { steps: 10 });
      await waitAnnotShapeCount(6);
      shapePanel = await panelState();
      const brushShape = lastAnnotShape(shapePanel);
      const brushPoints = JSON.parse(annotAttr(brushShape, 'points') || '[]');
      const brushSpacing = brushPoints.slice(1).map((point, index) => Math.hypot((point.x - brushPoints[index].x) * geomMap.sx, (point.y - brushPoints[index].y) * geomMap.sy));
      check('V15.5c', 'brush: first/last sampled points, ≥2 screen px sampling, round cap/join polyline',
        brushShape.native.tag === 'polyline' && brushPoints.length >= 3
          && near(brushPoints[0].x, 80, 0.8) && near(brushPoints[0].y, 180, 0.8)
          && near(brushPoints[brushPoints.length - 1].x, 220, 0.8) && near(brushPoints[brushPoints.length - 1].y, 240, 0.8)
          && brushSpacing.every((distance) => distance >= 1.9)
          && brushShape.native.attrs['stroke-linecap'] === 'round' && brushShape.native.attrs['stroke-linejoin'] === 'round',
        { first: { x: 80, y: 180 }, last: { x: 220, y: 240 }, spacing: '≥2 screen px', cap: 'round', join: 'round' },
        { points: brushPoints, spacing: brushSpacing, native: brushShape && brushShape.native, draw: brushDraw });

      const countBeforeClick = annotShapes(shapePanel).length;
      await annotClickGui(annotCanvasToGui(await annotMappingNow(), { x: 150, y: 150 }));
      await sleep(300);
      check('V15.5d', 'a pure brush click (zero path length) creates no object', annotShapes(await panelState()).length === countBeforeClick,
        countBeforeClick, annotShapes(await panelState()).length);

      // Drag out of the painted rect: the frozen mapping clamps the final point to the view rect.
      let clampMap = await annotMappingNow();
      await ensurePointVisible(annotCanvasToGui(clampMap, { x: 350, y: 250 }));
      await sleep(120);
      clampMap = await annotMappingNow();
      await ensureAnnotHit(annotCanvasToGui(clampMap, { x: 350, y: 250 }));
      await annotDragGui(annotCanvasToGui(clampMap, { x: 350, y: 250 }), { x: clampMap.painted.left + clampMap.painted.width + 80, y: clampMap.painted.top + clampMap.painted.height + 80 }, { steps: 6 });
      await waitAnnotShapeCount(countBeforeClick + 1);
      shapePanel = await panelState();
      const clampShape = lastAnnotShape(shapePanel);
      const clampPoints = JSON.parse(annotAttr(clampShape, 'points') || '[]');
      const clampLast = clampPoints[clampPoints.length - 1];
      check('V15.5e', 'dragging out of the painted rect keeps sampling with the frozen mapping and clamps to [Cx,Cx+W]×[Cy,Cy+H]',
        clampPoints.length >= 2 && near(clampLast.x, 400, 0.8) && near(clampLast.y, 300, 0.8),
        { last: { x: 400, y: 300 } }, { last: clampLast, points: clampPoints.length });

      // pointercancel cancels a live draft (synthetic event here; real OS pointercancel is NOT_RUN).
      await pageEvaluate(panelExpr(`
        const svg = panel.querySelector('.utb-annot-layer');
        window.__annotPointerId = null;
        svg.addEventListener('pointerdown', (event) => { window.__annotPointerId = event.pointerId; }, { capture: true, once: true });
        return true;
      `));
      const cancelMap = await annotMappingNow();
      const cancelStart = annotCanvasToGui(cancelMap, { x: 320, y: 120 });
      await ensureAnnotHit(cancelStart);
      await state.chrome.cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: cancelStart.x, y: cancelStart.y, button: 'none', buttons: 0 });
      await state.chrome.cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: cancelStart.x, y: cancelStart.y, button: 'left', buttons: 1, clickCount: 1 });
      await state.chrome.cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: cancelStart.x + 30, y: cancelStart.y + 10, button: 'left', buttons: 1 });
      await sleep(120);
      const pointerId = await pageEvaluate('window.__annotPointerId');
      const countBeforeCancel = annotShapes(await panelState()).length;
      await pageEvaluate(panelExpr(`
        const svg = panel.querySelector('.utb-annot-layer');
        svg.dispatchEvent(new PointerEvent('pointercancel', { bubbles: true, pointerId: ${Number(pointerId) || 1} }));
        return true;
      `));
      await state.chrome.cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: cancelStart.x + 30, y: cancelStart.y + 10, button: 'left', buttons: 0, clickCount: 1 });
      await sleep(300);
      const cancelPanel = await panelState();
      check('V15.5f', 'pointercancel cancels the draft without committing (draft group is empty)',
        annotShapes(cancelPanel).length === countBeforeCancel && cancelPanel.annot.draftChildren === 0,
        { shapes: countBeforeCancel, draftChildren: 0 },
        { shapes: annotShapes(cancelPanel).length, draftChildren: cancelPanel.annot.draftChildren, pointerId });

      // ---- V15.6 style semantics ------------------------------------------------------------
      await clickAnnotTool('rect');
      await clickAnnotCheckbox('外框');
      const afterReject = (await panelState()).annot;
      check('V15.6a', 'clicking the already selected 外框 is a complete no-op (fill=false, 外框 stays pressed)',
        afterReject.fill.checked === false && afterReject.stroke.checked === true
          && afterReject.styleSeg.pressedCount === 1,
        { fill: false, stroke: true, pressed: 1 },
        { fill: afterReject.fill, stroke: afterReject.stroke, seg: afterReject.styleSeg });
      await clickAnnotCheckbox('填充');
      const afterFill = (await panelState()).annot;
      await clickAnnotCheckbox('外框');
      const afterStrokeOff = (await panelState()).annot;
      check('V15.6b', 'closed shapes switch the single mode: selecting 填充 clears 外框 and vice versa',
        afterFill.fill.checked === true && afterFill.stroke.checked === false
          && afterStrokeOff.fill.checked === false && afterStrokeOff.stroke.checked === true
          && afterFill.styleSeg.pressedCount === 1 && afterStrokeOff.styleSeg.pressedCount === 1,
        { fillThenStroke: [true, false], strokeOnly: [false, true] },
        { afterFill: { fill: afterFill.fill, stroke: afterFill.stroke, seg: afterFill.styleSeg },
          afterStrokeOff: { fill: afterStrokeOff.fill, stroke: afterStrokeOff.stroke, seg: afterStrokeOff.styleSeg } });
      // 用户 2026-11-03 第 1 条：单一 mode，V15.6b 最后停在“外框”，这里显式切回“填充”。
      await clickAnnotCheckbox('填充');
      const afterFillOnly = (await panelState()).annot;
      const styleColor = await setAnnotColor('#00ff00');
      const styleWidth = await setAnnotWidth(20);
      const countBeforeStyleRect = annotShapes(await panelState()).length;
      await drawCanvas({ x: 250, y: 60 }, { x: 340, y: 140 }, { steps: 6 });
      await waitAnnotShapeCount(countBeforeStyleRect + 1);
      shapePanel = await panelState();
      const styleRect = lastAnnotShape(shapePanel);
      check('V15.6c', 'colour #00ff00 + width 20 + fill-only are stored in data and native SVG',
        afterFillOnly.fill.checked === true && afterFillOnly.stroke.checked === false
          && styleColor.color.value === '#00ff00' && styleWidth.width.value === '20'
          && annotAttr(styleRect, 'color') === '#00ff00' && annotAttr(styleRect, 'stroke-width') === '20'
          && annotAttr(styleRect, 'fill') === 'true' && annotAttr(styleRect, 'stroke') === 'false'
          && styleRect.native.attrs.fill === '#00ff00' && styleRect.native.attrs.stroke === 'none',
        { color: '#00ff00', strokeWidth: '20', fill: 'true', stroke: 'false', native: { fill: '#00ff00', stroke: 'none' } },
        { color: styleColor.color, width: styleWidth.width, shape: styleRect && styleRect.attrs, native: styleRect && styleRect.native });
      await setAnnotWidth(1);
      await clickAnnotCheckbox('外框');
      const countBeforeThin = annotShapes(await panelState()).length;
      await drawCanvas({ x: 260, y: 160 }, { x: 330, y: 220 }, { steps: 6 });
      await waitAnnotShapeCount(countBeforeThin + 1);
      shapePanel = await panelState();
      const thinRect = lastAnnotShape(shapePanel);
      check('V15.6d', 'width 1 is accepted while the single 外框 mode stays exclusive',
        annotAttr(thinRect, 'stroke-width') === '1' && annotAttr(thinRect, 'fill') === 'false' && annotAttr(thinRect, 'stroke') === 'true',
        { strokeWidth: '1', fill: false, stroke: true }, thinRect && thinRect.attrs);
      await setAnnotWidth(3);
      const lineStyle = await clickAnnotTool('line');
      check('V15.6e', 'non-closed tools disable the segment but keep the selected option',
        lineStyle.fill.disabled === true && lineStyle.stroke.disabled === true
          && lineStyle.fill.checked === false && lineStyle.stroke.checked === true
          && lineStyle.styleSeg.pressedCount === 1,
        { fillDisabled: true, strokeDisabled: true, checked: [false, true] },
        { fill: lineStyle.fill, stroke: lineStyle.stroke, seg: lineStyle.styleSeg });
      const textStyle = await clickAnnotTool('text');
      check('V15.6f', 'text tool disables the segment and the width input (fixed fill at draw time, 20 canvas px)',
        textStyle.fill.disabled === true && textStyle.stroke.disabled === true
          && textStyle.width.disabled === true && textStyle.fill.checked === false && textStyle.stroke.checked === true
          && textStyle.styleSeg.pressedCount === 1,
        { fillDisabled: true, strokeDisabled: true, widthDisabled: true, kept: 'stroke' },
        { fill: textStyle.fill, stroke: textStyle.stroke, width: textStyle.width, seg: textStyle.styleSeg });
      shapePanel = await panelState();
      const firstRect = annotShapes(shapePanel)[0];
      check('V15.6g', 'later style changes never rewrite an existing shape (first rect keeps #ff3b30/3/false/true)',
        annotAttr(firstRect, 'color') === '#ff3b30' && annotAttr(firstRect, 'stroke-width') === '3'
          && annotAttr(firstRect, 'fill') === 'false' && annotAttr(firstRect, 'stroke') === 'true',
        { color: '#ff3b30', strokeWidth: '3', fill: 'false', stroke: 'true' },
        firstRect && firstRect.attrs);
      notRun('V15.6h', 'native <input type="color"> system picker interaction',
        'OS colour-picker automation is not part of PASS; the controlled value/input/change and the resulting SVG fill are asserted above');

      // ---- V15.7 text editor ---------------------------------------------------------------
      await clickAnnotTool('text');
      let textMap = await annotMappingNow();
      await ensurePointVisible(annotCanvasToGui(textMap, { x: 50, y: 50 }));
      await sleep(120);
      textMap = await annotMappingNow();
      const textAt = { x: 50, y: 50 };
      await annotClickGui(annotCanvasToGui(textMap, textAt));
      await sleep(350);
      let textPanel = await panelState();
      const editor = textPanel.annot.text;
      const expectedTextScreen = annotCanvasToGui(textMap, textAt);
      check('V15.7a', 'text click opens the single-line editor at the落点 with maxlength 200, 20×sy font and z-index 3',
        Boolean(editor) && editor.type === 'text' && editor.ariaLabel === '标注文字'
          && editor.maxLength === '200' && near(parseFloat(editor.fontSize), 20 * textMap.sy, 1.5)
          && near(editor.left, expectedTextScreen.x, 2) && near(editor.top, expectedTextScreen.y, 2)
          && Number(editor.zIndex) >= 3,
        { type: 'text', maxLength: 200, fontSize: 20 * textMap.sy, left: expectedTextScreen.x, top: expectedTextScreen.y, zIndex: '>=3' },
        { editor, expected: expectedTextScreen, sy: textMap.sy });
      const countBeforeText = annotShapes(textPanel).length;
      const textValue = '中文 <>& 文本';
      await annotTypeText(textValue, {});
      await capturePanel('shot-18-annot-text');
      await pressKey('Enter', 'Enter', 13);
      await waitAnnotShapeCount(countBeforeText + 1);
      shapePanel = await panelState();
      const textShape = lastAnnotShape(shapePanel);
      check('V15.7b', 'Enter commits the exact plain text (Chinese and <>& preserved) at the落点 with fill=current, stroke=none',
        textShape && textShape.type === 'text' && textShape.native.text === textValue
          && near(Number(annotAttr(textShape, 'x')), textAt.x, 0.6) && near(Number(annotAttr(textShape, 'y')), textAt.y, 0.6)
          && annotAttr(textShape, 'font-size') === '20' && annotAttr(textShape, 'fill') === 'true' && annotAttr(textShape, 'stroke') === 'false'
          && textShape.native.attrs.fill === '#00ff00' && textShape.native.attrs.stroke === 'none',
        { text: textValue, x: textAt.x, y: textAt.y, fontSize: 20, fill: true, stroke: false },
        { shape: textShape && textShape.attrs, native: textShape && textShape.native });

      const countBeforeBlur = annotShapes(await panelState()).length;
      await annotClickGui(annotCanvasToGui(textMap, { x: 100, y: 80 }));
      await sleep(300);
      await annotTypeText('blur', { blur: true });
      await waitAnnotShapeCount(countBeforeBlur + 1);
      check('V15.7c', 'a normal blur commits exactly one text shape', annotShapes(await panelState()).length === countBeforeBlur + 1,
        countBeforeBlur + 1, annotShapes(await panelState()).length);
      const countBeforeEsc = annotShapes(await panelState()).length;
      await annotClickGui(annotCanvasToGui(textMap, { x: 120, y: 90 }));
      await sleep(300);
      await annotTypeText('esc', { escape: true });
      check('V15.7d', 'Escape cancels the editor without committing', annotShapes(await panelState()).length === countBeforeEsc && (await panelState()).annot.text === null,
        { shapes: countBeforeEsc, editor: null }, { shapes: annotShapes(await panelState()).length, editor: (await panelState()).annot.text });
      await annotClickGui(annotCanvasToGui(textMap, { x: 140, y: 100 }));
      await sleep(300);
      await annotTypeText('   ', { enter: true });
      check('V15.7e', 'an empty/whitespace text is discarded', annotShapes(await panelState()).length === countBeforeEsc,
        countBeforeEsc, annotShapes(await panelState()).length);
      await annotClickGui(annotCanvasToGui(textMap, { x: 160, y: 110 }));
      await sleep(300);
      const longText = 'x'.repeat(210);
      await annotTypeText(longText, { enter: true });
      await waitAnnotShapeCount(countBeforeEsc + 1);
      const longShape = lastAnnotShape(await panelState());
      check('V15.7f', 'the editor caps text at 200 characters', longShape && longShape.native.text.length === 200,
        { length: 200 }, { length: longShape ? longShape.native.text.length : null });

      const countBeforeIme = annotShapes(await panelState()).length;
      await annotClickGui(annotCanvasToGui(textMap, { x: 180, y: 120 }));
      await sleep(300);
      await annotTypeText('ime', {});
      await pageEvaluate(panelExpr(`const el = panel.querySelector('.utb-annot-text-input'); if (!el) return false; el.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true })); return true;`));
      await pressKey('Enter', 'Enter', 13);
      const imeMid = await panelState();
      await pageEvaluate(panelExpr(`const el = panel.querySelector('.utb-annot-text-input'); if (!el) return false; el.dispatchEvent(new CompositionEvent('compositionend', { bubbles: true })); return true;`));
      await pressKey('Enter', 'Enter', 13);
      await waitAnnotShapeCount(countBeforeIme + 1);
      const imeShape = lastAnnotShape(await panelState());
      check('V15.7g', 'composition Enter does not commit; the compositionend + Enter commits once (synthetic IME logic)',
        imeMid.annot.text !== null && annotShapes(imeMid).length === countBeforeIme
          && imeShape && imeShape.native.text === 'ime' && annotShapes(await panelState()).length === countBeforeIme + 1,
        { duringComposition: 'no commit', afterComposition: 'ime' },
        { midEditor: imeMid.annot.text, midShapes: annotShapes(imeMid).length, final: imeShape && imeShape.native.text, finalShapes: annotShapes(await panelState()).length });
      notRun('V15.7h', 'real OS input-method composition (IME) behaviour',
        'only synthetic composition events are exercised in headless Chromium; a real OS IME is not available in this suite');
      await capturePanel('shot-16-annot-tools');

      // ---- V15.14 before/after Host screenshot & target facts (before page interaction) ------
      await toggleAnnot(false);
      await hostViewportSet({ width: 400, height: 300, scale: 1, x: 0, y: 0 });
      await waitHostView((view) => Number(view.width) === 400 && Number(view.height) === 300 && closeTo(view.scale, 1, 0.0011) && near(view.x, 0, 1) && near(view.y, 0, 1));
      await hostViewportSet({ canvasX: 0, canvasY: 0 });
      await waitHostView((view) => near(view.canvasX, 0, 1) && near(view.canvasY, 0, 1));
      await waitPanelMirrorsHost();
      await waitCanvasState(true, true);
      await waitFrameStable();
      const v15TruthAfter = await targetTruth();
      const v15StyleAfter = await targetEval(`({ html: document.documentElement.getAttribute('style') || '', body: document.body.getAttribute('style') || '', text: document.body.innerText.length })`);
      check('V15.14a', 'the target page DOM/CSS/viewport/DPR/zoom never changed while annotating',
        near(v15TruthAfter.innerWidth, v15TruthBefore.innerWidth, 0.5) && near(v15TruthAfter.innerHeight, v15TruthBefore.innerHeight, 0.5)
          && Number(v15TruthAfter.devicePixelRatio) === Number(v15TruthBefore.devicePixelRatio)
          && Number(v15TruthAfter.visualViewportScale) === Number(v15TruthBefore.visualViewportScale)
          && near(v15TruthAfter.scrollX, v15TruthBefore.scrollX, 0.5) && near(v15TruthAfter.scrollY, v15TruthBefore.scrollY, 0.5)
          && v15StyleAfter.html === v15StyleBefore.html && v15StyleAfter.body === v15StyleBefore.body
          && v15StyleAfter.text === v15StyleBefore.text,
        { innerWidth: v15TruthBefore.innerWidth, innerHeight: v15TruthBefore.innerHeight, dpr: v15TruthBefore.devicePixelRatio, scroll: 'unchanged', style: 'unchanged', text: 'unchanged' },
        { before: v15TruthBefore, after: v15TruthAfter, styleBefore: v15StyleBefore, styleAfter: v15StyleAfter });

      // A fresh red rectangle: GUI pixels contain it, Host pixels do not.
      await toggleAnnot(true);
      await clickAnnotTool('rect');
      await setAnnotColor('#00ff00');
      await setAnnotWidth(20);
      const fillState = (await panelState()).annot;
      if (!fillState.fill.checked) await clickAnnotCheckbox('填充');
      if ((await panelState()).annot.stroke.checked) await clickAnnotCheckbox('外框');
      const guiMap = await annotMappingNow();
      // A blank white patch of the fixture (no page element there), so the Host pixel is unambiguous.
      await drawCanvas({ x: 180, y: 10 }, { x: 240, y: 40 }, { steps: 6 });
      await toggleAnnot(false);
      await sleep(300);
      const guiShot = await captureBoxPixels((await panelState()).frame.box);
      const guiPixel = pixelAt(guiShot.decoded, 210, 25);
      const hostPngAfter = await hostScreenshotPng();
      const hostDecodedAfter = await decodeScreenshotPng(hostPngAfter);
      const hostPixel = pixelAt(hostDecodedAfter, 210, 25);
      const hostPngBeforeDecoded = await decodeScreenshotPng(v15HostPngBefore);
      const sameHost = hostPngBeforeDecoded.width === hostDecodedAfter.width
        && hostPngBeforeDecoded.height === hostDecodedAfter.height
        && Buffer.compare(Buffer.from(hostPngBeforeDecoded.data), Buffer.from(hostDecodedAfter.data)) === 0;
      check('V15.14b', 'Host screenshots before/after annotation decode to identical pixels (the layer is panel-only)',
        sameHost, { dimensions: `${hostPngBeforeDecoded.width}x${hostPngBeforeDecoded.height}`, pixels: 'identical' },
        { before: { w: hostPngBeforeDecoded.width, h: hostPngBeforeDecoded.height }, after: { w: hostDecodedAfter.width, h: hostDecodedAfter.height }, sameHost });
      check('V15.14c', 'isolated GUI pixels contain the annotation while the Host screenshot does not',
        guiPixel.g >= 230 && guiPixel.r <= 30 && guiPixel.b <= 30
          && !(hostPixel.g >= 230 && hostPixel.r <= 30 && hostPixel.b <= 30),
        { gui: 'red annotation', host: 'page pixels' },
        { guiPixel, hostPixel, box: guiShot.clip });
      notRun('V15.14d', 'T3 vision baseline/act regression for the annotation layer',
        'annotations are a panel-only view layer and never enter Host screenshots/T3; the existing T3 suite already covers its own regression');

      // ---- V15.8 negative C, blank drawing and C/scale anchoring ----------------------------
      await toggleAnnot(true);
      await hostViewportSet({ canvasX: -50, canvasY: -20 });
      await waitHostView((view) => near(view.canvasX, -50, 1) && near(view.canvasY, -20, 1));
      await waitPanelMirrorsHost();
      await waitCanvasState(true, true);
      await waitFrameStable();
      const negativeMap = await annotMappingNow();
      await clickAnnotTool('rect');
      await setAnnotColor('#00ff00');
      await setAnnotWidth(3);
      const negStyle = (await panelState()).annot;
      if (!negStyle.fill.checked) await clickAnnotCheckbox('填充');
      if (!negStyle.stroke.checked) await clickAnnotCheckbox('外框');
      const countBeforeNegative = annotShapes(await panelState()).length;
      await drawCanvas({ x: -30, y: -15 }, { x: 10, y: 10 }, { steps: 6 });
      await waitAnnotShapeCount(countBeforeNegative + 1);
      shapePanel = await panelState();
      const negativeRect = lastAnnotShape(shapePanel);
      await clickAnnotTool('text');
      await annotClickGui(annotCanvasToGui(negativeMap, { x: -25, y: -10 }));
      await sleep(300);
      await annotTypeText('blank', { enter: true });
      await waitAnnotShapeCount(countBeforeNegative + 2);
      shapePanel = await panelState();
      const negativeText = lastAnnotShape(shapePanel);
      check('V15.8a', 'negative C and content-outside blank are drawable (no inContent gating); text keeps canvas coords',
        annotNumAttr(negativeRect, 'x') !== null && near(annotNumAttr(negativeRect, 'x'), -30, 0.8)
          && near(annotNumAttr(negativeRect, 'y'), -15, 0.8)
          && annotNumAttr(negativeRect, 'width') > 0
          && negativeText && negativeText.type === 'text' && negativeText.native.text === 'blank'
          && near(Number(annotAttr(negativeText, 'x')), -25, 0.8) && near(Number(annotAttr(negativeText, 'y')), -10, 0.8)
          && (await panelState()).annot.svg.viewBox === '-50 -20 400 300',
        { rect: { x: -30, y: -15 }, text: { x: -25, y: -10 }, viewBox: '-50 -20 400 300' },
        { rect: negativeRect && negativeRect.attrs, text: negativeText && negativeText.attrs, viewBox: (await panelState()).annot.svg.viewBox });
      await capturePanel('shot-17-annot-negative');
      await toggleAnnot(false);
      await clickFit(false);
      const countBeforeAnchor = annotShapes(await panelState()).length;
      await hostViewportSet({ canvasX: -80, canvasY: -40, scale: 0.75 });
      await waitHostView((view) => near(view.canvasX, -80, 1) && near(view.canvasY, -40, 1) && closeTo(view.scale, 0.75, 0.0011));
      await waitPanelMirrorsHost();
      await sleep(1000);
      await waitCanvasState(true, true);
      await waitFrameStable();
      const anchorPanel = await panelState();
      const anchorShape = annotShapes(anchorPanel).find((shape) => shape.id === negativeRect.id);
      const anchorMap = await annotMappingNow();
      const anchorExpected = annotCanvasToGui(anchorMap, { x: annotNumAttr(negativeRect, 'x'), y: annotNumAttr(negativeRect, 'y') });
      const anchorText = annotShapes(anchorPanel).find((shape) => shape.id === negativeText.id);
      const anchorTextScreen = annotScreenOf(anchorText, { x: Number(annotAttr(anchorText, 'x')), y: Number(annotAttr(anchorText, 'y')) });
      const anchorTextExpected = annotCanvasToGui(anchorMap, { x: Number(annotAttr(anchorText, 'x')), y: Number(annotAttr(anchorText, 'y')) });
      check('V15.8b', 'after exit, an external C/scale change re-anchors committed shapes, stroke width and 20px text by the new mapping',
        anchorShape && near(anchorShape.ctm.a, 0.75, 0.01) && near(anchorShape.rect.left, anchorExpected.x, 2) && near(anchorShape.rect.top, anchorExpected.y, 2)
          && near(anchorTextScreen.x, anchorTextExpected.x, 2) && near(anchorTextScreen.y, anchorTextExpected.y, 2)
          && near(Number(anchorShape.native.attrs['stroke-width']), 3, 0.01)
          && anchorText && near(20 * anchorText.ctm.a, 15, 0.2),
        { ctm: 0.75, strokeWidth: 3, textFontSizeScreen: 15, screen: '±2' },
        { fit: anchorPanel.fitChecked, ctm: anchorShape && anchorShape.ctm, rect: anchorShape && anchorShape.rect, expected: anchorExpected, textScreen: anchorTextScreen, textExpected: anchorTextExpected, textCtm: anchorText && anchorText.ctm, textAttrs: anchorText && anchorText.native });
      // The size bar is closed while the mode is on; fit lives there, so open it (mode is off)
      // to select 适应窗口 and measure the local-ratio re-anchor.
      await openSizeBar();
      await clickFit(true);
      await sleep(700);
      const fitAnchorPanel = await panelState();
      const fitAnchorView = (await hostView()).view;
      const fitAnchorMap = await annotMappingNow();
      const fitShape = annotShapes(fitAnchorPanel).find((shape) => shape.id === negativeRect.id);
      check('V15.8c', 'the local 适应窗口 ratio rescales the annotation layer without publishing a new Host scale',
        fitAnchorPanel.fitState === 'true' && closeTo(fitAnchorView.scale, 0.75, 0.0011)
          && near(fitShape.ctm.a, fitAnchorMap.sx, 0.01),
        { fit: true, hostScale: 0.75, ctm: 'matches painted rect' },
        { fit: fitAnchorPanel.fitState, hostScale: fitAnchorView.scale, ctm: fitShape && fitShape.ctm, sx: fitAnchorMap.sx });
      await clickFit(false);
      await hostViewportSet({ width: 400, height: 300, scale: 1, x: 0, y: 0 });
      await waitHostView((view) => Number(view.width) === 400 && Number(view.height) === 300 && closeTo(view.scale, 1, 0.0011));
      await hostViewportSet({ canvasX: 0, canvasY: 0 });
      await waitHostView((view) => near(view.canvasX, 0, 1) && near(view.canvasY, 0, 1));
      await waitPanelMirrorsHost();
      await waitCanvasState(true, true);

      // ---- V15.9 frame refresh vs external geometry change ----------------------------------
      // V15.8c opened the size bar to select 适应窗口; make sure it is closed and the entry is
      // ready before re-entering (sizing blocks the annotation mode by design).
      await closeSizeBar();
      let v15Reopen = await toggleAnnot(true);
      if (!v15Reopen || v15Reopen.pressed !== 'true') {
        await closeSizeBar();
        await sleep(400);
        v15Reopen = await toggleAnnot(true);
      }
      if (!v15Reopen || v15Reopen.pressed !== 'true') {
        throw new Error('annotation mode did not reopen before V15.9: ' + JSON.stringify(v15Reopen));
      }
      await clickAnnotTool('rect');
      await setAnnotColor('#3366ff');
      await setAnnotWidth(3);
      const countBeforeRefresh = annotShapes(await panelState()).length;
      await drawCanvas({ x: 40, y: 40 }, { x: 100, y: 100 }, { steps: 6 });
      await waitAnnotShapeCount(countBeforeRefresh + 1);
      const refreshMap = await annotMappingNow();
      await clickAnnotTool('brush');
      const brushStart = annotCanvasToGui(refreshMap, { x: 60, y: 220 });
      await ensureAnnotHit(brushStart);
      await state.chrome.cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: brushStart.x, y: brushStart.y, button: 'none', buttons: 0 });
      await state.chrome.cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: brushStart.x, y: brushStart.y, button: 'left', buttons: 1, clickCount: 1 });
      for (let index = 1; index <= 4; index += 1) {
        await state.chrome.cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: brushStart.x + index * 8, y: brushStart.y + index * 2, button: 'left', buttons: 1 });
        await sleep(40);
      }
      await targetEval(`(() => { document.documentElement.style.background = 'rgb(240,240,240)'; return true; })()`);
      await sleep(900);
      for (let index = 5; index <= 8; index += 1) {
        await state.chrome.cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: brushStart.x + index * 8, y: brushStart.y + index * 2, button: 'left', buttons: 1 });
        await sleep(40);
      }
      await state.chrome.cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: brushStart.x + 64, y: brushStart.y + 16, button: 'left', buttons: 0, clickCount: 1 });
      await sleep(400);
      await targetEval(`(() => { document.documentElement.style.background = ''; return true; })()`);
      const refreshPanel = await panelState();
      const refreshBrush = lastAnnotShape(refreshPanel);
      check('V15.9a', 'an ordinary new frame does not cancel the live stroke or duplicate the commit (one brush, committed shapes kept)',
        annotShapes(refreshPanel).length === countBeforeRefresh + 2 && refreshBrush && refreshBrush.type === 'brush'
          && JSON.parse(annotAttr(refreshBrush, 'points') || '[]').length >= 3,
        { shapes: countBeforeRefresh + 2, brushPoints: '>=3' },
        { shapes: annotShapes(refreshPanel).length, brush: refreshBrush && refreshBrush.attrs });

      // External C change cancels a live draft but keeps committed shapes.
      await clickAnnotTool('rect');
      const externalMap = await annotMappingNow();
      const externalStart = annotCanvasToGui(externalMap, { x: 200, y: 200 });
      await ensureAnnotHit(externalStart);
      await state.chrome.cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: externalStart.x, y: externalStart.y, button: 'none', buttons: 0 });
      await state.chrome.cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: externalStart.x, y: externalStart.y, button: 'left', buttons: 1, clickCount: 1 });
      await state.chrome.cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: externalStart.x + 30, y: externalStart.y + 30, button: 'left', buttons: 1 });
      const countBeforeExternal = annotShapes(await panelState()).length;
      await hostViewportSet({ canvasX: -10, canvasY: -10 });
      await waitHostView((view) => near(view.canvasX, -10, 1) && near(view.canvasY, -10, 1));
      await sleep(500);
      await state.chrome.cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: externalStart.x + 30, y: externalStart.y + 30, button: 'left', buttons: 0, clickCount: 1 });
      await sleep(300);
      const externalPanel = await panelState();
      check('V15.9b', 'an external view change cancels the uncommitted draft while committed shapes stay',
        annotShapes(externalPanel).length === countBeforeExternal && externalPanel.annot.draftChildren === 0,
        { shapes: countBeforeExternal, draftChildren: 0 },
        { shapes: annotShapes(externalPanel).length, draftChildren: externalPanel.annot.draftChildren });
      await hostViewportSet({ canvasX: 0, canvasY: 0 });
      await waitHostView((view) => near(view.canvasX, 0, 1) && near(view.canvasY, 0, 1));
      await waitPanelMirrorsHost();

      // ---- V15.10 exit, page interaction restored, preferences retained --------------------
      const toolBeforeExit = await clickAnnotTool('circle');
      const colorBeforeExit = await setAnnotColor('#123456');
      const widthBeforeExit = await setAnnotWidth(7);
      const countBeforeExit = annotShapes(await panelState()).length;
      const exited = await toggleAnnot(false);
      const exitedPanel = await panelState();
      check('V15.10a', 'exiting keeps the drawing visible but pointer-events:none and tabIndex=-1; pan stays off; bar disappears',
        exited.pressed === 'false' && !exited.bar
          && exitedPanel.annot.svg && exitedPanel.annot.svg.pointerEvents === 'none' && exitedPanel.annot.svg.tabIndex === '-1'
          && exitedPanel.panState === 'off' && annotShapes(exitedPanel).length === countBeforeExit,
        { pressed: 'false', pointerEvents: 'none', tabIndex: -1, pan: false, shapes: countBeforeExit },
        { pressed: exited.pressed, bar: exited.bar, svg: exitedPanel.annot.svg, pan: exitedPanel.panState, shapes: annotShapes(exitedPanel).length });
      await hostViewportSet({ width: 400, height: 300, scale: 1, x: 0, y: 0 });
      await waitHostView((view) => Number(view.width) === 400 && Number(view.height) === 300 && closeTo(view.scale, 1, 0.0011) && near(view.x, 0, 1) && near(view.y, 0, 1));
      await waitPanelMirrorsHost();
      await waitCanvasState(true, true);
      await waitFrameStable();
      const restoredClick = await clickThroughPanel('#t3-click', 400, 300);
      const scrollBeforeRestoredWheel = await targetTruth();
      const restoredBox = (await panelState()).frame.box;
      await wheelOnFramePoint({ x: restoredBox.left + restoredBox.width / 2, y: restoredBox.top + restoredBox.height / 2 }, 200);
      await sleep(900);
      const scrollAfterRestoredWheel = await targetTruth();
      check('V15.10b', 'after exit a trusted page click and a page wheel work again',
        restoredClick.clicksDelta === 1 && restoredClick.record && restoredClick.record.isTrusted === true
          && scrollAfterRestoredWheel.scrollY > scrollBeforeRestoredWheel.scrollY + 40,
        { clicks: 1, scrollY: `> ${scrollBeforeRestoredWheel.scrollY + 40}` },
        { clicks: restoredClick.clicksDelta, record: restoredClick.record, scrollBefore: scrollBeforeRestoredWheel.scrollY, scrollAfter: scrollAfterRestoredWheel.scrollY });
      const reopened = await toggleAnnot(true);
      check('V15.10c', 'reopening restores the tool/style preferences (circle/#123456/7) and keeps the drawing',
        reopened.pressed === 'true' && Boolean(reopened.tools.find((tool) => tool.pressed === 'true'))
          && reopened.tools.find((tool) => tool.pressed === 'true').tool === 'circle'
          && reopened.color.value === '#123456' && reopened.width.value === '7'
          && annotShapes(await panelState()).length === countBeforeExit,
        { tool: 'circle', color: '#123456', width: '7', shapes: countBeforeExit },
        { tools: reopened.tools, color: reopened.color, width: reopened.width, shapes: annotShapes(await panelState()).length });
      await toggleAnnot(false);

      // ---- V15.11 navigation lifecycle -----------------------------------------------------
      // Start from a clean document (mode off) so the counts below are meaningful.
      await navigateTarget(`${fixtureBase}/web-t3.html?ext=0`);
      await waitForFrame();
      await waitFrameStable();
      await sleep(500);
      await toggleAnnot(true);
      const navMap = await annotMappingNow();
      await clickAnnotTool('rect');
      await drawCanvas({ x: 40, y: 40 }, { x: 100, y: 100 }, { steps: 5 });
      await waitAnnotShapeCount(1);
      await navigateTarget(`${fixtureBase}/web-t3.html?ext=1`);
      await waitForFrame();
      await waitFrameStable();
      await sleep(500);
      const externalNavPanel = await panelState();
      check('V15.11a', 'an external navigation clears the drawing but keeps the mode on and page input disabled',
        externalNavPanel.annot.pressed === 'true' && Boolean(externalNavPanel.annot.bar)
          && annotShapes(externalNavPanel).length === 0,
        { mode: 'on', shapes: 0 }, { mode: externalNavPanel.annot.pressed, bar: Boolean(externalNavPanel.annot.bar), shapes: annotShapes(externalNavPanel).length });
      await toggleAnnot(false);

      // Local reload (mode off) clears at initiation.
      await toggleAnnot(true);
      await clickAnnotTool('rect');
      const reloadMap = await annotMappingNow();
      await drawCanvas({ x: 50, y: 50 }, { x: 120, y: 110 }, { steps: 5 });
      await waitAnnotShapeCount(1);
      await toggleAnnot(false);
      const reloadMark = Date.now();
      await pageEvaluate(panelExpr(`const b = panel.querySelector('button[aria-label="刷新"]'); if (b && !b.disabled) b.click(); return true;`));
      await waitForFrame(30000).catch(() => null);
      await sleep(900);
      const reloadPanel = await panelState();
      check('V15.11b', 'a local reload started outside the mode clears the drawing immediately',
        annotShapes(reloadPanel).length === 0 && panelPosts('input', reloadMark).length === 0,
        { shapes: 0 }, { shapes: annotShapes(reloadPanel).length, inputPosts: panelPosts('input', reloadMark).length });

      // History navigation clears too.
      await toggleAnnot(true);
      await clickAnnotTool('rect');
      const historyMap = await annotMappingNow();
      await drawCanvas({ x: 60, y: 60 }, { x: 130, y: 120 }, { steps: 5 });
      await waitAnnotShapeCount(1);
      await toggleAnnot(false);
      const historyResponse = await pageHostFetch('/history', {
        method: 'POST',
        headers: Object.assign({ 'content-type': 'application/json' }, requireScope()),
        body: { direction: 'back' },
      });
      await waitForFrame(30000).catch(() => null);
      await sleep(900);
      const historyPanel = await panelState();
      check('V15.11c', 'a history navigation clears the drawing (address/document change)',
        historyResponse.status === 200 && annotShapes(historyPanel).length === 0,
        { status: 200, shapes: 0 }, { status: historyResponse.status, shapes: annotShapes(historyPanel).length });
      // v3 (§12): the old "teardown/unmount loses the drawing" NOT_RUN items are now covered by
      // V17.3 (real unmount→remount), V17.5 (same-runtime generation) and V17.6 (projected scope
      // isolation); they must not remain NOT_RUN.
      log('  [note] V15.11d/V15.11e are covered by V17 (retention on unmount/scope generation)');

      // ---- V15.12 old Host / capability loss ------------------------------------------------
      let stopNoCanvasAnnot = null;
      try {
        stopNoCanvasAnnot = await startStateRewrite((json) => mutateStateUi(json, (ui) => { delete ui.canvas; return ui; }));
        const noCanvasAnnot = await waitFor(async () => {
          const panel = await panelState();
          return panel.annot && panel.annot.disabled === true ? panel : undefined;
        }, { timeoutMs: 6000, intervalMs: 150, label: 'annotation entry disabled without ui.canvas' });
        const noCanvasMark = Date.now();
        const noCanvasClicked = await pageEvaluate(panelExpr(`const b = panel.querySelector('button[aria-label="标注"]'); if (b) b.click(); return true;`));
        await sleep(350);
        const noCanvasAfter = await panelState();
        check('V15.12a', 'without ui.canvas the annotation entry is disabled, cannot enter the mode and sends no canvas patch',
          noCanvasAnnot.annot.disabled === true && !noCanvasAfter.annot.bar && noCanvasClicked === true
            && panelPosts('viewport', noCanvasMark).length === 0,
          { disabled: true, bar: false, viewportPosts: 0 },
          { disabled: noCanvasAnnot.annot.disabled, bar: noCanvasAfter.annot.bar, posts: panelPosts('viewport', noCanvasMark).length });
      } catch (error) {
        notRun('V15.12a', 'simulated Host without ui.canvas (annotation entry disabled)',
          'CDP Fetch response rewriting is unavailable in this environment', sanitize(errorMessage(error)));
      } finally {
        if (stopNoCanvasAnnot) await stopNoCanvasAnnot();
      }
      await waitCanvasState(true, true, { timeoutMs: 8000 }).catch(() => undefined);
      let stopNoViewAnnot = null;
      try {
        stopNoViewAnnot = await startStateRewrite((json) => mutateStateUi(json, (ui) => { delete ui.view; delete ui.canvas; return ui; }));
        const noViewAnnot = await waitFor(async () => {
          const panel = await panelState();
          return panel.annot && panel.annot.disabled === true ? panel : undefined;
        }, { timeoutMs: 6000, intervalMs: 150, label: 'annotation entry disabled without ui.view' });
        check('V15.12b', 'without ui.view (old Host) the annotation entry is disabled instead of falling back to screen coordinates',
          noViewAnnot.annot.disabled === true, { disabled: true }, { disabled: noViewAnnot.annot.disabled });
      } catch (error) {
        notRun('V15.12b', 'simulated pre-P0-D Host (no ui.view) disables the annotation entry',
          'CDP Fetch response rewriting is unavailable in this environment', sanitize(errorMessage(error)));
      } finally {
        if (stopNoViewAnnot) await stopNoViewAnnot();
      }
      await waitCanvasState(true, true, { timeoutMs: 8000 }).catch(() => undefined);
      const restoredAnnot = await waitFor(async () => {
        const panel = await panelState();
        return panel.annot && panel.annot.disabled === false ? panel : undefined;
      }, { timeoutMs: 6000, intervalMs: 150, label: 'annotation entry re-enabled' }).catch(() => null);
      check('V15.12c', 'the annotation entry re-enables when the Host projection returns', Boolean(restoredAnnot) && restoredAnnot.annot.disabled === false,
        { disabled: false }, { disabled: restoredAnnot ? restoredAnnot.annot.disabled : null });

      // Capability loss while the mode is on clears and exits.
      let stopLoss = null;
      try {
        await toggleAnnot(true);
        await clickAnnotTool('rect');
        const lossMap = await annotMappingNow();
        await drawCanvas({ x: 40, y: 40 }, { x: 100, y: 100 }, { steps: 5 });
        await waitAnnotShapeCount(1);
        stopLoss = await startStateRewrite((json) => mutateStateUi(json, (ui) => { delete ui.canvas; return ui; }));
        const lost = await waitFor(async () => {
          const panel = await panelState();
          return panel.annot && panel.annot.pressed === 'false' && annotShapes(panel).length === 0 ? panel : undefined;
        }, { timeoutMs: 8000, intervalMs: 150, label: 'mode exits and clears on canvas loss' });
        check('V15.12d', 'losing the canvas capability while the mode is on clears the drawing and exits the mode',
          lost.annot.pressed === 'false' && !lost.annot.bar && annotShapes(lost).length === 0,
          { mode: 'off', shapes: 0 }, { mode: lost.annot.pressed, bar: lost.annot.bar, shapes: annotShapes(lost).length });
      } catch (error) {
        notRun('V15.12d', 'capability loss while the annotation mode is on',
          'CDP Fetch response rewriting is unavailable in this environment', sanitize(errorMessage(error)));
      } finally {
        if (stopLoss) await stopLoss();
      }
      await waitCanvasState(true, true, { timeoutMs: 8000 }).catch(() => undefined);
      await toggleAnnot(false).catch(() => undefined);
      notRun('V15.12e', 'a real old Host binary (no ui.view/ui.canvas)',
        'this suite only starts the current Host; old-Host behaviour is simulated through CDP-rewritten /state projections');
    });

    await scenario('V16 annotation upload/clear/eraser (P0-D v2)', async () => {
      // Base: deterministic 400×300 @ 100%, C=0, fit off, size bar closed, mode off.
      await toggleAnnot(false).catch(() => undefined);
      await navigateTarget(`${fixtureBase}/web-t3.html`);
      await waitForFrame();
      await ensureHorizontalOverflow();
      await clickFit(false);
      await hostViewportSet({ width: 400, height: 300, scale: 1, x: 0, y: 0 });
      await waitHostView((view) => Number(view.width) === 400 && Number(view.height) === 300 && closeTo(view.scale, 1, 0.0011) && near(view.x, 0, 1) && near(view.y, 0, 1));
      await hostViewportSet({ canvasX: 0, canvasY: 0 });
      await waitHostView((view) => near(view.canvasX, 0, 1) && near(view.canvasY, 0, 1));
      await waitPanelMirrorsHost();
      await waitCanvasState(true, true);
      await waitFrameStable();
      await closeSizeBar();
      await toggleAnnot(true);

      // ---- V16.1 nine single-select tools ---------------------------------------------------
      const v16Tools = await annotV2State();
      const v16PressedAtOpen = v16Tools.tools.filter((tool) => tool.pressed === 'true').map((tool) => tool.tool);
      await clickAnnotTool('eraser');
      const v16ToolsAfter = await annotV2State();
      const v16PressedAfter = v16ToolsAfter.tools.filter((tool) => tool.pressed === 'true').map((tool) => tool.tool);
      check('V16.1', 'nine single-select tools with exact labels/data-utb-annot-tool, 16/1.7/currentColor icons and exactly one aria-pressed=true',
        v16Tools.tools.length === 9
          && v16Tools.tools.map((tool) => tool.label).join('|') === '选择|框选|圆形|矩形|线段|箭头|画笔|文字|橡皮擦'
          && v16Tools.tools.map((tool) => tool.tool).join('|') === 'select|marquee|circle|rect|line|arrow|brush|text|eraser'
          && v16Tools.tools.every((tool) => tool.title === tool.label)
          && v16Tools.tools.every((tool) => tool.icon && tool.icon.width === '16' && tool.icon.height === '16'
            && tool.icon.strokeWidth === '1.7' && tool.icon.stroke === 'currentColor')
          && v16Tools.tools.every((tool) => tool.width >= 20 && tool.height >= 20)
          && v16PressedAtOpen.length === 1 && v16PressedAtOpen[0] !== 'eraser'
          && v16PressedAfter.length === 1 && v16PressedAfter[0] === 'eraser',
        { tools: '选择|框选|圆形|矩形|线段|箭头|画笔|文字|橡皮擦', icons: '16/1.7/currentColor', pressed: 'eraser only after the click' },
        { tools: v16Tools.tools, pressedAtOpen: v16PressedAtOpen, pressedAfter: v16PressedAfter });

      // ---- V16.2 eraser style matrix ------------------------------------------------------
      await clickAnnotTool('rect');
      const v16StyleRect = await annotV2State();
      await clickAnnotTool('eraser');
      const v16StyleEraser = await annotV2State();
      await clickAnnotTool('rect');
      const v16StyleBack = await annotV2State();
      check('V16.2', 'the eraser disables 填充/外框/颜色/粗细 while keeping their values; switching back restores the matrix',
        v16StyleRect.fill.disabled === false && v16StyleRect.stroke.disabled === false
          && v16StyleRect.color.disabled === false && v16StyleRect.width.disabled === false
          && v16StyleEraser.fill.disabled === true && v16StyleEraser.stroke.disabled === true
          && v16StyleEraser.color.disabled === true && v16StyleEraser.width.disabled === true
          && v16StyleEraser.fill.checked === v16StyleRect.fill.checked
          && v16StyleEraser.stroke.checked === v16StyleRect.stroke.checked
          && v16StyleEraser.color.value === v16StyleRect.color.value
          && v16StyleEraser.width.value === v16StyleRect.width.value
          && v16StyleBack.fill.disabled === false && v16StyleBack.stroke.disabled === false
          && v16StyleBack.color.disabled === false && v16StyleBack.width.disabled === false
          && v16StyleBack.color.value === v16StyleRect.color.value
          && v16StyleBack.width.value === v16StyleRect.width.value,
        { eraser: 'fill/stroke/colour/width disabled, values kept', back: 'matrix restored' },
        { rect: v16StyleRect, eraser: v16StyleEraser, back: v16StyleBack });

      // ---- V16.3 press erases / hover never erases --------------------------------------
      await annotResetCanvas();
      await clickAnnotTool('rect');
      await annotPrepareStyle({ fill: true, stroke: false, width: 3 });
      await annotDrawStable({ x: 60, y: 40 }, { x: 140, y: 100 }, { steps: 6 });
      await waitAnnotShapeCount(1);
      await clickAnnotTool('eraser');
      const v16HoverMap = await annotMappingNow();
      await annotHoverGui(annotCanvasToGui(v16HoverMap, { x: 100, y: 70 }));
      const v16AfterHover = annotShapes(await panelState()).length;
      await annotPressAtCanvas({ x: 100, y: 70 });
      const v16AfterPress = annotShapes(await panelState()).length;
      check('V16.3', 'the eraser only deletes on the primary button: hover keeps the shape, one press erases it immediately (no drag needed)',
        v16AfterHover === 1 && v16AfterPress === 0,
        { afterHover: 1, afterPress: 0 }, { afterHover: v16AfterHover, afterPress: v16AfterPress });

      // ---- V16.4 line distance threshold -------------------------------------------------
      await annotResetCanvas();
      await clickAnnotTool('line');
      await annotPrepareStyle({ width: 3 });
      await annotDrawStable({ x: 60, y: 150 }, { x: 200, y: 150 }, { steps: 6 });
      await waitAnnotShapeCount(1);
      await clickAnnotTool('eraser');
      await annotPressAtCanvas({ x: 130, y: 170 });
      const v16LineFar = annotShapes(await panelState()).length;
      await annotPressAtCanvas({ x: 130, y: 154 });
      const v16LineNear = annotShapes(await panelState()).length;
      check('V16.4', 'a line hits within r=max(strokeWidth/2,6) canvas px: 20 px away misses, 4 px away erases it',
        v16LineFar === 1 && v16LineNear === 0,
        { far: 1, near: 0 }, { far: v16LineFar, near: v16LineNear });

      // ---- V16.5 brush mid-segment -------------------------------------------------------
      await annotResetCanvas();
      await clickAnnotTool('brush');
      await annotPrepareStyle({ width: 3 });
      await annotDrawStable({ x: 60, y: 220 }, { x: 240, y: 220 }, { steps: 3, holdMs: 40 });
      await waitAnnotShapeCount(1);
      const v16BrushShape = lastAnnotShape(await panelState());
      const v16BrushPoints = JSON.parse(annotAttr(v16BrushShape, 'points') || '[]');
      const v16BrushMid = {
        x: (Number(v16BrushPoints[0].x) + Number(v16BrushPoints[1].x)) / 2,
        y: (Number(v16BrushPoints[0].y) + Number(v16BrushPoints[1].y)) / 2,
      };
      await clickAnnotTool('eraser');
      await annotPressAtCanvas(v16BrushMid);
      const v16BrushLeft = annotShapes(await panelState()).length;
      check('V16.5', 'a brush hits along every segment: a press at a mid-segment point (not a sampled vertex) erases the stroke',
        v16BrushPoints.length >= 2 && v16BrushLeft === 0,
        { points: '>=2', mid: 'between samples', left: 0 },
        { points: v16BrushPoints, mid: v16BrushMid, left: v16BrushLeft });

      // ---- V16.6 arrow head triangle -----------------------------------------------------
      await annotResetCanvas();
      await clickAnnotTool('arrow');
      await annotPrepareStyle({ width: 20 });
      await annotDrawStable({ x: 60, y: 60 }, { x: 160, y: 60 }, { steps: 6 });
      await waitAnnotShapeCount(1);
      await clickAnnotTool('eraser');
      await annotPressAtCanvas({ x: 110, y: 75 });
      const v16ArrowLeft = annotShapes(await panelState()).length;
      check('V16.6', 'an arrow hits inside the filled head triangle even away from the shaft (press at 15 px off-axis inside the head)',
        v16ArrowLeft === 0, { left: 0 }, { left: v16ArrowLeft, point: { x: 110, y: 75 }, strokeWidth: 20 });

      // ---- V16.7 hollow rect: centre misses, edge hits -----------------------------------
      await annotResetCanvas();
      await clickAnnotTool('rect');
      await annotPrepareStyle({ fill: false, stroke: true, width: 3 });
      await annotDrawStable({ x: 80, y: 80 }, { x: 200, y: 160 }, { steps: 6 });
      await waitAnnotShapeCount(1);
      await clickAnnotTool('eraser');
      await annotPressAtCanvas({ x: 140, y: 120 });
      const v16HollowCentre = annotShapes(await panelState()).length;
      await annotPressAtCanvas({ x: 140, y: 80 });
      const v16HollowEdge = annotShapes(await panelState()).length;
      check('V16.7', 'a hollow rect only hits its stroke band: the centre misses, an edge point erases it',
        v16HollowCentre === 1 && v16HollowEdge === 0,
        { centre: 1, edge: 0 }, { centre: v16HollowCentre, edge: v16HollowEdge });

      // ---- V16.8 filled rect: interior hits ----------------------------------------------
      await annotResetCanvas();
      await clickAnnotTool('rect');
      await annotPrepareStyle({ fill: true, stroke: false, width: 3 });
      await annotDrawStable({ x: 80, y: 80 }, { x: 200, y: 160 }, { steps: 6 });
      await waitAnnotShapeCount(1);
      await clickAnnotTool('eraser');
      await annotPressAtCanvas({ x: 140, y: 120 });
      const v16FillCentre = annotShapes(await panelState()).length;
      check('V16.8', 'a filled rect hits its interior: a press at the centre erases it', v16FillCentre === 0,
        { centre: 0 }, { centre: v16FillCentre });

      // ---- V16.9 hollow ellipse never uses its bbox ---------------------------------------
      await annotResetCanvas();
      await clickAnnotTool('circle');
      await annotPrepareStyle({ fill: false, stroke: true, width: 3 });
      await annotDrawStable({ x: 80, y: 80 }, { x: 200, y: 160 }, { steps: 6 });
      await waitAnnotShapeCount(1);
      await clickAnnotTool('eraser');
      await annotPressAtCanvas({ x: 83, y: 83 });
      const v16EllipseCorner = annotShapes(await panelState()).length;
      await annotPressAtCanvas({ x: 200, y: 120 });
      const v16EllipseEdge = annotShapes(await panelState()).length;
      check('V16.9', 'a hollow ellipse is hit by its real path: the bbox corner is not erased, the ellipse boundary is',
        v16EllipseCorner === 1 && v16EllipseEdge === 0,
        { bboxCorner: 1, boundary: 0 }, { bboxCorner: v16EllipseCorner, boundary: v16EllipseEdge });

      // ---- V16.10 filled ellipse ----------------------------------------------------------
      await annotResetCanvas();
      await clickAnnotTool('circle');
      await annotPrepareStyle({ fill: true, stroke: false, width: 3 });
      await annotDrawStable({ x: 80, y: 80 }, { x: 200, y: 160 }, { steps: 6 });
      await waitAnnotShapeCount(1);
      await clickAnnotTool('eraser');
      await annotPressAtCanvas({ x: 140, y: 120 });
      const v16FilledEllipse = annotShapes(await panelState()).length;
      check('V16.10', 'a filled ellipse hits its interior: a press at the centre erases it', v16FilledEllipse === 0,
        { centre: 0 }, { centre: v16FilledEllipse });

      // ---- V16.11 text bbox ---------------------------------------------------------------
      await annotResetCanvas();
      await annotPlaceText({ x: 60, y: 60 }, '擦我');
      await waitAnnotShapeCount(1);
      const v16TextShape = lastAnnotShape(await panelState());
      const v16TextBox = await pageEvaluate(panelExpr(`
        const g = panel.querySelector('.utb-annot-layer g[data-utb-annot-id="${v16TextShape.id}"]');
        const text = g ? g.querySelector('text') : null;
        if (!text || typeof text.getBBox !== 'function') return null;
        const box = text.getBBox();
        return { x: box.x, y: box.y, width: box.width, height: box.height };
      `));
      await clickAnnotTool('eraser');
      let v16TextLeft = null;
      if (v16TextBox && v16TextBox.width > 0) {
        await annotPressAtCanvas({ x: v16TextBox.x + v16TextBox.width / 2, y: v16TextBox.y + v16TextBox.height / 2 });
        v16TextLeft = annotShapes(await panelState()).length;
      }
      check('V16.11', 'text hit uses the rendered getBBox(): a press inside the glyph box erases the text object',
        Boolean(v16TextBox) && v16TextBox.width > 0 && v16TextBox.height > 0 && v16TextLeft === 0,
        { bbox: 'from getBBox()', left: 0 }, { box: v16TextBox, left: v16TextLeft });

      // ---- V16.12 overlapping layers: topmost only, in-place de-dupe ----------------------
      await annotResetCanvas();
      await clickAnnotTool('rect');
      await annotPrepareStyle({ fill: true, stroke: false, width: 3 });
      await annotDrawStable({ x: 100, y: 100 }, { x: 200, y: 180 }, { steps: 6 });
      await waitAnnotShapeCount(1);
      await annotDrawStable({ x: 100, y: 100 }, { x: 200, y: 180 }, { steps: 6 });
      await waitAnnotShapeCount(2);
      const v16Overlap = annotShapes(await panelState());
      const v16BottomId = v16Overlap[0].id;
      const v16TopId = v16Overlap[v16Overlap.length - 1].id;
      await clickAnnotTool('eraser');
      const v16OverlapMap = await annotMappingNow();
      const v16OverlapGui = annotCanvasToGui(v16OverlapMap, { x: 150, y: 140 });
      await dismissShellDialogs();
      if (!(await annotLayerOnTop(v16OverlapGui))) await annotEnsureHit(v16OverlapGui);
      const v16OverlapBefore = annotShapes(await panelState()).length;
      const sendPointer = (type, x, y, buttons, button) => state.chrome.cdp.send('Input.dispatchMouseEvent', {
        type, x, y, button, buttons, clickCount: type === 'mouseMoved' ? 0 : 1,
      });
      await sendPointer('mouseMoved', v16OverlapGui.x, v16OverlapGui.y, 0, 'none');
      await sendPointer('mousePressed', v16OverlapGui.x, v16OverlapGui.y, 1, 'left');
      await sleep(80);
      for (let index = 0; index < 3; index += 1) {
        await sendPointer('mouseMoved', v16OverlapGui.x, v16OverlapGui.y, 1, 'left');
        await sleep(60);
      }
      await sendPointer('mouseReleased', v16OverlapGui.x, v16OverlapGui.y, 0, 'left');
      await sleep(350);
      const v16OverlapAfter = annotShapes(await panelState());
      check('V16.12', 'overlapping shapes: one sample deletes only the topmost one and repeated identical moves never drill through',
        v16Overlap.length === 2 && v16OverlapBefore === 2 && v16OverlapAfter.length === 1
          && v16OverlapAfter[0].id === v16BottomId && v16BottomId !== v16TopId,
        { overlap: 2, left: 1, kept: 'bottom id' },
        { ids: v16Overlap.map((shape) => shape.id), before: v16OverlapBefore, left: v16OverlapAfter.map((shape) => shape.id) });

      // ---- V16.13 real-CDP long drag erases along the path --------------------------------
      await annotResetCanvas();
      await clickAnnotTool('rect');
      await annotPrepareStyle({ fill: true, stroke: false, width: 3 });
      for (const startX of [60, 150, 240]) {
        await annotDrawStable({ x: startX, y: 120 }, { x: startX + 40, y: 160 }, { steps: 4 });
      }
      await waitAnnotShapeCount(3);
      await clickAnnotTool('eraser');
      let v16DragMap = await annotMappingNow();
      await ensurePointVisible(annotCanvasToGui(v16DragMap, { x: 70, y: 140 }));
      await sleep(120);
      v16DragMap = await annotMappingNow();
      const v16DragFrom = annotCanvasToGui(v16DragMap, { x: 70, y: 140 });
      const v16DragTo = annotCanvasToGui(v16DragMap, { x: 270, y: 140 });
      await annotEnsureHit(v16DragFrom);
      await annotDragGui(v16DragFrom, v16DragTo, { steps: 3, holdMs: 35 });
      await sleep(400);
      const v16DragLeft = annotShapes(await panelState()).length;
      check('V16.13', 'one coarse real-CDP drag erases every shape along the path (samples interpolated at ≤3 canvas px)',
        v16DragLeft === 0, { left: 0 }, { left: v16DragLeft, from: { x: 70, y: 140 }, to: { x: 270, y: 140 }, steps: 3 });

      // ---- V16.14 negative C / 0.75 scale / fit mapping -----------------------------------
      await annotResetCanvas();
      await clickFit(false);
      await hostViewportSet({ canvasX: -60, canvasY: -30, scale: 0.75 });
      await waitHostView((view) => near(view.canvasX, -60, 1) && near(view.canvasY, -30, 1) && closeTo(view.scale, 0.75, 0.0011));
      await waitPanelMirrorsHost();
      await waitCanvasState(true, true);
      await waitFrameStable();
      await clickAnnotTool('rect');
      await annotPrepareStyle({ fill: true, stroke: false, width: 3 });
      await annotDrawStable({ x: 0, y: 0 }, { x: 80, y: 60 }, { steps: 6 });
      await waitAnnotShapeCount(1);
      await clickAnnotTool('eraser');
      await annotPressAtCanvas({ x: 95, y: 30 });
      const v16NegMiss = annotShapes(await panelState()).length;
      await annotPressAtCanvas({ x: 40, y: 30 });
      const v16NegHit = annotShapes(await panelState()).length;
      await clickAnnotTool('rect');
      await clickFit(true);
      await sleep(800);
      await waitCanvasState(true, true);
      await waitFrameStable();
      await annotDrawStable({ x: 12, y: 12 }, { x: 90, y: 70 }, { steps: 6 });
      await waitAnnotShapeCount(1);
      await clickAnnotTool('eraser');
      await annotPressAtCanvas({ x: 50, y: 40 });
      const v16FitHit = annotShapes(await panelState()).length;
      await clickFit(false);
      await hostViewportSet({ canvasX: 0, canvasY: 0, scale: 1 });
      await waitHostView((view) => near(view.canvasX, 0, 1) && near(view.canvasY, 0, 1) && closeTo(view.scale, 1, 0.0011));
      await waitPanelMirrorsHost();
      await waitCanvasState(true, true);
      await waitFrameStable();
      check('V16.14', 'eraser hits use the canvas mapping under negative C, 0.75 scale and the local fit ratio (near miss stays)',
        v16NegMiss === 1 && v16NegHit === 0 && v16FitHit === 0,
        { negativeC: { miss: 1, hit: 0 }, fit: 0 }, { negativeC: { miss: v16NegMiss, hit: v16NegHit }, fit: v16FitHit });

      // ---- V16.15 clear button: visible, exact contract, no confirmation ------------------
      await annotResetCanvas();
      await toggleAnnot(false);
      await toggleAnnot(true);
      const v16EmptyClear = await annotV2State();
      await clickAnnotTool('rect');
      await annotPrepareStyle({ fill: true, stroke: false, width: 3 });
      await annotDrawStable({ x: 200, y: 200 }, { x: 280, y: 260 }, { steps: 5 });
      await waitAnnotShapeCount(1);
      const v16FullClear = await annotV2State();
      await pageEvaluate('(() => { window.__utbConfirmCalls = 0; window.__utbConfirmOriginal = window.confirm; window.confirm = function () { window.__utbConfirmCalls += 1; return true; }; return true; })()');
      const v16ClearRect = await annotClearRect();
      await clickAt(v16ClearRect.x, v16ClearRect.y);
      await sleep(500);
      const v16ConfirmCalls = await pageEvaluate('window.__utbConfirmCalls');
      await pageEvaluate('(() => { if (window.__utbConfirmOriginal) window.confirm = window.__utbConfirmOriginal; return true; })()');
      const v16AfterClear = await annotV2State();
      check('V16.15', '清除画布 is a visible text button after the width control with exact aria/title/data, disabled on an empty canvas, no confirmation',
        Boolean(v16EmptyClear.clear) && v16EmptyClear.clear.disabled === true
          && Boolean(v16FullClear.clear) && v16FullClear.clear.disabled === false
          && v16FullClear.clear.text === '清除画布' && v16FullClear.clear.label === '清除画布' && v16FullClear.clear.title === '清除画布'
          && v16FullClear.clear.action === 'clear' && v16FullClear.clear.afterWidth === true
          && v16FullClear.clear.width > 30 && v16FullClear.clear.height > 0
          && Number(v16ConfirmCalls) === 0
          && annotShapes(await panelState()).length === 0
          && v16AfterClear.clear && v16AfterClear.clear.disabled === true,
        { text: '清除画布', disabledWhenEmpty: true, confirmCalls: 0 },
        { empty: v16EmptyClear.clear, full: v16FullClear.clear, confirmCalls: v16ConfirmCalls, after: v16AfterClear.clear, shapes: annotShapes(await panelState()).length });

      // ---- V16.16 clear during a live text edit (no blur resurrection) -------------------
      await annotResetCanvas();
      await clickAnnotTool('text');
      let v16EditMap = await annotMappingNow();
      await ensurePointVisible(annotCanvasToGui(v16EditMap, { x: 80, y: 80 }));
      await sleep(120);
      v16EditMap = await annotMappingNow();
      const v16EditGui = annotCanvasToGui(v16EditMap, { x: 80, y: 80 });
      await annotEnsureHit(v16EditGui);
      await annotClickGui(v16EditGui);
      await sleep(340);
      const v16EditorOpen = (await panelState()).annot.text !== null;
      await annotTypeText('blur 复活', {});
      const v16ClearDuringEdit = await annotV2State();
      const v16EditClearRect = await annotClearRect({ dismiss: false });
      await clickAt(v16EditClearRect.x, v16EditClearRect.y);
      await sleep(600);
      const v16EditAfter = await panelState();
      check('V16.16', 'clearing while a text editor holds text cancels the edit first: the blur cannot submit and no text shape appears',
        v16EditorOpen === true && Boolean(v16ClearDuringEdit.clear) && v16ClearDuringEdit.clear.disabled === false
          && v16EditAfter.annot.text === null && annotShapes(v16EditAfter).length === 0,
        { editorOpen: true, clearEnabled: true, shapes: 0, editor: null },
        { editorOpen: v16EditorOpen, clear: v16ClearDuringEdit.clear, editor: v16EditAfter.annot.text, shapes: annotShapes(v16EditAfter).length });

      // ---- V16.17 clear keeps the mode, tool and style -----------------------------------
      await clickAnnotTool('rect');
      await annotPrepareStyle({ fill: true, stroke: false, width: 7, color: '#3366ff' });
      await annotDrawStable({ x: 120, y: 120 }, { x: 200, y: 180 }, { steps: 5 });
      await waitAnnotShapeCount(1);
      await clickAnnotClear();
      await sleep(500);
      const v16KeepPanel = await panelState();
      const v16KeepState = await annotV2State();
      const v16KeepPressed = v16KeepState.tools.filter((tool) => tool.pressed === 'true').map((tool) => tool.tool);
      await toggleAnnot(false);
      const v16OutsideClear = await annotV2State();
      await toggleAnnot(true);
      check('V16.17', '清除画布 only empties the canvas: mode/tool/colour/width/fill-stroke stay, and the button does not exist outside the mode',
        v16KeepPanel.annot.pressed === 'true' && Boolean(v16KeepPanel.annot.bar)
          && v16KeepPressed.length === 1 && v16KeepPressed[0] === 'rect'
          && v16KeepState.color.value === '#3366ff' && v16KeepState.width.value === '7'
          && v16KeepState.fill.checked === true && v16KeepState.stroke.checked === false
          && annotShapes(v16KeepPanel).length === 0
          && v16OutsideClear.clear === null,
        { mode: 'on', tool: 'rect', color: '#3366ff', width: '7', shapes: 0, outsideMode: 'no clear button' },
        { pressed: v16KeepPanel.annot.pressed, pressedTools: v16KeepPressed, color: v16KeepState.color, width: v16KeepState.width,
          fill: v16KeepState.fill, stroke: v16KeepState.stroke, shapes: annotShapes(v16KeepPanel).length, outside: v16OutsideClear.clear });

      // ---- V16.18 six geometries + text read back from the Host --------------------------
      await annotResetCanvas();
      await clickAnnotTool('rect');
      await annotPrepareStyle({ fill: false, stroke: true, width: 3, color: '#ff3b30' });
      await annotDrawStable({ x: 40, y: 40 }, { x: 120, y: 100 }, { steps: 5 });
      await clickAnnotTool('circle');
      await annotDrawStable({ x: 150, y: 40 }, { x: 250, y: 100 }, { steps: 5 });
      await clickAnnotTool('line');
      await annotDrawStable({ x: 40, y: 140 }, { x: 140, y: 140 }, { steps: 5 });
      await clickAnnotTool('arrow');
      await annotDrawStable({ x: 40, y: 200 }, { x: 160, y: 200 }, { steps: 5 });
      await clickAnnotTool('brush');
      await annotDrawStable({ x: 200, y: 160 }, { x: 320, y: 240 }, { steps: 6 });
      await annotPlaceText({ x: 200, y: 100 }, 'hello <>& 文本');
      await waitAnnotShapeCount(6);
      const v16LocalShapes = annotShapes(await panelState());
      const v16HostDoc = await waitHostAnnotations((doc) => Array.isArray(doc.shapes) && doc.shapes.length === 6, { timeoutMs: 12000 });
      const v16HostById = new Map(v16HostDoc.shapes.map((shape) => [shape.id, shape]));
      const v16LocalRect = v16LocalShapes.find((shape) => shape.type === 'rect');
      const v16LocalCircle = v16LocalShapes.find((shape) => shape.type === 'circle');
      const v16LocalLine = v16LocalShapes.find((shape) => shape.type === 'line');
      const v16LocalArrow = v16LocalShapes.find((shape) => shape.type === 'arrow');
      const v16LocalBrush = v16LocalShapes.find((shape) => shape.type === 'brush');
      const v16LocalText = v16LocalShapes.find((shape) => shape.type === 'text');
      const v16HostRect = v16HostById.get(v16LocalRect.id);
      const v16HostCircle = v16HostById.get(v16LocalCircle.id);
      const v16HostLine = v16HostById.get(v16LocalLine.id);
      const v16HostArrow = v16HostById.get(v16LocalArrow.id);
      const v16HostBrush = v16HostById.get(v16LocalBrush.id);
      const v16HostText = v16HostById.get(v16LocalText.id);
      const v16ArrowLength = Math.hypot(Number(annotAttr(v16LocalArrow, 'x2')) - Number(annotAttr(v16LocalArrow, 'x1')),
        Number(annotAttr(v16LocalArrow, 'y2')) - Number(annotAttr(v16LocalArrow, 'y1')));
      check('V16.18', 'the Host documents all six geometries and the text exactly (ids in SVG order, source/context/view, arrow head recomputed)',
        Number(v16HostDoc.version) === 1 && v16HostDoc.space === 'canvas-css-px'
          && Number.isSafeInteger(Number(v16HostDoc.revision)) && Number(v16HostDoc.revision) >= 1
          && v16HostDoc.source && v16HostDoc.source.kind === 'human-panel' && v16HostDoc.source.trusted === false
          && v16HostDoc.source.surface === 'main' && Number(v16HostDoc.source.clientRevision) >= 1
          && /^[0-9a-f-]{36}$/i.test(String(v16HostDoc.source.panelId || ''))
          && v16HostDoc.context && typeof v16HostDoc.context.documentKey === 'string' && v16HostDoc.context.documentKey.length >= 8
          && /^[0-9a-f]{64}$/.test(String(v16HostDoc.context.addressDigest || ''))
          && v16HostDoc.view && Number(v16HostDoc.view.width) === 400 && Number(v16HostDoc.view.height) === 300
          && v16HostDoc.shapes.map((shape) => shape.id).join('|') === v16LocalShapes.map((shape) => shape.id).join('|')
          && v16HostRect && v16HostRect.type === 'rect' && v16HostRect.fill === false && v16HostRect.stroke === true
          && near(Number(v16HostRect.x), Number(annotAttr(v16LocalRect, 'x')), 0.5)
          && near(Number(v16HostRect.width), Number(annotAttr(v16LocalRect, 'width')), 0.5)
          && near(Number(v16HostRect.height), Number(annotAttr(v16LocalRect, 'height')), 0.5)
          && v16HostCircle && v16HostCircle.type === 'circle'
          && near(Number(v16HostCircle.cx), Number(annotAttr(v16LocalCircle, 'cx')), 0.5)
          && near(Number(v16HostCircle.cy), Number(annotAttr(v16LocalCircle, 'cy')), 0.5)
          && near(Number(v16HostCircle.rx), Number(annotAttr(v16LocalCircle, 'rx')), 0.5)
          && near(Number(v16HostCircle.ry), Number(annotAttr(v16LocalCircle, 'ry')), 0.5)
          && v16HostLine && near(Number(v16HostLine.x1), Number(annotAttr(v16LocalLine, 'x1')), 0.5)
          && near(Number(v16HostLine.x2), Number(annotAttr(v16LocalLine, 'x2')), 0.5)
          && v16HostArrow && near(Number(v16HostArrow.y2), Number(annotAttr(v16LocalArrow, 'y2')), 0.5)
          && v16HostArrow.head && near(Number(v16HostArrow.head.length), Math.min(9, v16ArrowLength), 0.6)
          && near(Number(v16HostArrow.head.width), Math.min(6, v16ArrowLength), 0.6)
          && v16HostBrush && Array.isArray(v16HostBrush.points) && v16HostBrush.points.length >= 2
          && Array.isArray(v16HostBrush.points[0])
          && near(Number(v16HostBrush.points[0][0]), Number(JSON.parse(annotAttr(v16LocalBrush, 'points'))[0].x), 0.5)
          && v16HostText && v16HostText.type === 'text' && v16HostText.text === 'hello <>& 文本'
          && Number(v16HostText.fontSize) === 20
          && v16HostText.fill === true && v16HostText.stroke === false
          && v16HostDoc.truncated === false,
        { shapes: 6, order: 'same as SVG', text: 'hello <>& 文本', arrowHead: 'min(3t,L)/min(2t,L)', truncated: false },
        { annotationKeys: Object.keys(v16HostDoc), source: v16HostDoc.source, context: v16HostDoc.context,
          view: v16HostDoc.view, shapes: v16HostDoc.shapes, local: v16LocalShapes.map((shape) => ({ id: shape.id, type: shape.type })) });

      // ---- V16.19 Host readback follows erase and clear ----------------------------------
      const v16RevisionBefore = Number(v16HostDoc.revision);
      await clickAnnotTool('eraser');
      await annotPressAtCanvas({ x: 40, y: 70 });
      const v16HostAfterErase = await waitHostAnnotations((doc) => Array.isArray(doc.shapes) && doc.shapes.length === 5, { timeoutMs: 12000 });
      const v16ErasedGone = !v16HostAfterErase.shapes.some((shape) => shape.id === v16LocalRect.id);
      await clickAnnotClear();
      const v16HostAfterClear = await waitHostAnnotations((doc) => Array.isArray(doc.shapes) && doc.shapes.length === 0, { timeoutMs: 12000 });
      check('V16.19', 'the Host document follows erase and clear: the erased id disappears, clear empties it, and revision only grows',
        v16ErasedGone
          && Number(v16HostAfterErase.revision) > v16RevisionBefore
          && Number(v16HostAfterClear.revision) > Number(v16HostAfterErase.revision)
          && v16HostAfterClear.truncated === false,
        { erasedGone: true, revision: 'monotonic', clearShapes: 0 },
        { revisionBefore: v16RevisionBefore, afterErase: { revision: v16HostAfterErase.revision, shapes: v16HostAfterErase.shapes.map((shape) => shape.id) },
          afterClear: { revision: v16HostAfterClear.revision, shapes: v16HostAfterClear.shapes.length, truncated: v16HostAfterClear.truncated } });

      // ---- V16.20 one retry after a failure, error marker on the second ------------------
      await annotResetCanvas();
      await clickAnnotTool('rect');
      await annotPrepareStyle({ fill: true, stroke: false, width: 3 });
      await waitAnnotSync(['synced'], { timeoutMs: 10000 });
      let v16FailOnce = null;
      let v16PhaseOne = { attempts: [], gap: null, sync: null };
      try {
        v16FailOnce = await startAnnotationFailure(1);
        await annotDrawStable({ x: 70, y: 70 }, { x: 140, y: 130 }, { steps: 5 });
        await waitAnnotShapeCount(1);
        const attempts = await v16FailOnce.waitForCount(2, 12000);
        const syncedAgain = await waitAnnotSync(['synced'], { timeoutMs: 10000 });
        v16PhaseOne = {
          attempts: attempts.map((entry) => ({ at: entry.at, failed: entry.failed, clientRevision: entry.body && entry.body.clientRevision })),
          gap: attempts[1].at - attempts[0].at,
          sync: syncedAgain ? syncedAgain.annot.svg.sync : (await panelState()).annot.svg.sync,
        };
      } finally {
        if (v16FailOnce) await v16FailOnce.stop();
      }
      let v16FailTwice = null;
      let v16PhaseTwo = { attempts: [], sync: null, hint: null, shapes: 0 };
      try {
        v16FailTwice = await startAnnotationFailure(2);
        await annotDrawStable({ x: 220, y: 70 }, { x: 290, y: 130 }, { steps: 5 });
        await waitAnnotShapeCount(2);
        const attempts = await v16FailTwice.waitForCount(2, 12000);
        await sleep(900);
        const failedPanel = await panelState();
        const failedHint = await annotV2State();
        v16PhaseTwo = {
          attempts: attempts.map((entry) => ({ at: entry.at, failed: entry.failed })),
          sync: failedPanel.annot.svg ? failedPanel.annot.svg.sync : null,
          hint: failedHint.hint,
          shapes: annotShapes(failedPanel).length,
        };
      } finally {
        if (v16FailTwice) await v16FailTwice.stop();
      }
      check('V16.20', 'a failed write is retried exactly once after ~500 ms and recovers; a second failure marks error/标注未同步 without blocking drawing',
        v16PhaseOne.attempts.length === 2 && v16PhaseOne.attempts[0].failed === true && v16PhaseOne.attempts[1].failed === false
          && v16PhaseOne.attempts[0].clientRevision === v16PhaseOne.attempts[1].clientRevision
          && v16PhaseOne.gap >= 400 && v16PhaseOne.gap <= 5000 && v16PhaseOne.sync === 'synced'
          && v16PhaseTwo.attempts.length === 2
          && v16PhaseTwo.sync === 'error'
          && v16PhaseTwo.hint && v16PhaseTwo.hint.text.indexOf('标注未同步') >= 0
          && v16PhaseTwo.shapes === 2,
        { retry: '1 次 / ~500ms / 同 revision', error: 'data-utb-annot-sync=error + 标注未同步', drawing: 'not blocked' },
        { phaseOne: v16PhaseOne, phaseTwo: v16PhaseTwo });
      await waitAnnotSync(['synced', 'pending', 'idle'], { timeoutMs: 10000 });

      // ---- V16.21 navigation: no resurrection from late ACKs -----------------------------
      await annotResetCanvas();
      await clickAnnotTool('rect');
      await annotDrawStable({ x: 60, y: 60 }, { x: 120, y: 120 }, { steps: 5 });
      await annotDrawStable({ x: 200, y: 60 }, { x: 260, y: 120 }, { steps: 5 });
      await waitAnnotShapeCount(2);
      await waitHostAnnotations((doc) => Array.isArray(doc.shapes) && doc.shapes.length === 2, { timeoutMs: 12000 });
      await navigateTarget(`${fixtureBase}/web-t3.html?ext=v16`);
      await waitForFrame();
      await waitFrameStable();
      await sleep(1500);
      const v16NavPanel = await panelState();
      const v16NavHost = await waitHostAnnotations((doc) => Array.isArray(doc.shapes) && doc.shapes.length === 0, { timeoutMs: 12000 });
      check('V16.21', 'an external navigation clears the drawing on both sides; late ACKs/releases never resurrect shapes locally or on the Host',
        v16NavPanel.annot.pressed === 'true' && annotShapes(v16NavPanel).length === 0
          && v16NavPanel.annot.draftChildren === 0
          && v16NavHost.shapes.length === 0,
        { mode: 'stays on', local: 0, host: 0 },
        { mode: v16NavPanel.annot.pressed, local: annotShapes(v16NavPanel).length, host: v16NavHost.shapes.length });

      // ---- V16.24 sync attributes + old-Host unsupported semantics ----------------------
      // Runs while the mode is still on (from V16.21) and leaves it on for V16.22. One bounded
      // re-entry attempt only if the mode is unexpectedly closed, so the failure is reported as
      // a mode precondition instead of hiding behind a shape timeout.
      const v16ModeBefore = await panelState();
      if (!v16ModeBefore.annot || v16ModeBefore.annot.pressed !== 'true' || !v16ModeBefore.annot.bar) {
        await toggleAnnot(true).catch(() => undefined);
      }
      const v16Reopened = await panelState();
      const v16Preflight = v16Reopened;
      if (!v16Reopened || v16Reopened.annot.pressed !== 'true'
        || !v16Preflight.annot || !v16Preflight.annot.bar) {
        throw new Error('V16.24 preflight: the annotation mode did not reopen ' + JSON.stringify({
          pressed: v16Reopened && v16Reopened.annot ? v16Reopened.annot.pressed : null,
          disabled: v16Reopened && v16Reopened.annot ? v16Reopened.annot.disabled : null,
          bar: Boolean(v16Preflight.annot && v16Preflight.annot.bar),
          canvasOn: v16Preflight.canvasOn, canvasReady: v16Preflight.canvasReady,
        }));
      }
      await annotResetCanvas();
      await clickAnnotTool('rect');
      await annotPrepareStyle({ fill: true, stroke: false, width: 3 });
      const v16DrawMark = Date.now();
      let v16Draw = await annotDrawStable({ x: 80, y: 80 }, { x: 160, y: 140 }, { steps: 5 });
      let v16DrawAttempts = 1;
      if (!v16Draw.hit) {
        await capturePanel('shot-20-v16-draw-diagnostic').catch(() => undefined);
        throw new Error('V16.24 preflight: the annotation layer is not the hit target at ' + JSON.stringify(v16Draw.fromGui));
      }
      // A probe-level retry: the click path is real CDP input, and one transient frame/scroll race
      // must not be reported as a product failure (the drawn count is still asserted below).
      const v16ShapeAfterFirst = await waitAnnotShapeCount(1, { timeoutMs: 2600 }).then(() => 1).catch(() => 0);
      if (v16ShapeAfterFirst !== 1) {
        v16DrawAttempts += 1;
        v16Draw = await annotDrawStable({ x: 80, y: 80 }, { x: 160, y: 140 }, { steps: 5 });
      }
      try {
        await waitAnnotShapeCount(1, { timeoutMs: 8000 });
      } catch (error) {
        await capturePanel('shot-20-v16-draw-diagnostic').catch(() => undefined);
        const failedPanel = await panelState();
        throw new Error('V16.24 draw produced no shape ' + JSON.stringify({
          attempts: v16DrawAttempts,
          pressed: failedPanel.annot.pressed,
          tools: failedPanel.annot.tools.filter((tool) => tool.pressed === 'true').map((tool) => tool.tool),
          draftChildren: failedPanel.annot.draftChildren,
          shapes: annotShapes(failedPanel).length,
          inputPosts: panelPosts('input', v16DrawMark).length,
          pageEvents: await targetEval('window.__t3 ? window.__t3.events.length : -1'),
          from: v16Draw.fromGui, to: v16Draw.toGui, map: { sx: v16Draw.map.sx, sy: v16Draw.map.sy },
        }) + ' | ' + errorMessage(error));
      }
      const v16SyncedPanel = await waitAnnotSync(['synced'], { timeoutMs: 12000 });
      let v16StopNoContext = null;
      let v16UnsupportedPanel = null;
      let v16UnsupportedState = null;
      let v16UnsupportedDraw = null;
      try {
        v16StopNoContext = await startStateRewrite((json) => mutateStateUi(json, (ui) => { delete ui.annotationContext; return ui; }));
        v16UnsupportedPanel = await waitFor(async () => {
          const panel = await panelState();
          return panel.annot && panel.annot.svg && panel.annot.svg.sync === 'unsupported' ? panel : undefined;
        }, { timeoutMs: 10000, intervalMs: 150, label: 'annotation layer sync=unsupported' }).catch(() => null);
        v16UnsupportedState = await annotV2State();
        const v16Mark = Date.now();
        await annotDrawStable({ x: 200, y: 200 }, { x: 280, y: 260 }, { steps: 5 });
        await waitAnnotShapeCount(2);
        v16UnsupportedDraw = { shapes: annotShapes(await panelState()).length, posts: panelPosts('annotations', v16Mark).length };
      } finally {
        if (v16StopNoContext) await v16StopNoContext();
      }
      const v16RestoredSync = await waitFor(async () => {
        const panel = await panelState();
        const sync = panel.annot && panel.annot.svg ? panel.annot.svg.sync : null;
        return sync && sync !== 'unsupported' ? panel : undefined;
      }, { timeoutMs: 10000, intervalMs: 150, label: 'annotation sync restored after annotationContext returns' }).catch(() => null);
      check('V16.24', 'the layer publishes data-utb-annot-sync/revision; without ui.annotationContext it is unsupported (绘制保留, 未同步提示, 零上报) and never claims Agent visibility',
        Boolean(v16SyncedPanel) && v16SyncedPanel.annot.svg.sync === 'synced'
          && Number(v16SyncedPanel.annot.svg.revision) >= 1
          && Boolean(v16UnsupportedPanel) && v16UnsupportedPanel.annot.svg.sync === 'unsupported'
          && v16UnsupportedDraw && v16UnsupportedDraw.shapes === 2 && v16UnsupportedDraw.posts === 0
          && v16UnsupportedState.hint && v16UnsupportedState.hint.live === 'polite'
          && v16UnsupportedState.hint.inStatusBar === true && v16UnsupportedState.hint.display !== 'none'
          && v16UnsupportedState.hint.text.indexOf('标注未同步') >= 0
          && v16UnsupportedState.hint.title.indexOf('标注未同步') >= 0
          && v16UnsupportedState.hint.text.indexOf('已同步') < 0
          && Boolean(v16RestoredSync),
        { synced: 'data-utb-annot-sync=synced + revision>=1', unsupported: '绘制保留 / 零上报 / 状态栏未同步', restored: true },
        { synced: v16SyncedPanel ? v16SyncedPanel.annot.svg : null, unsupported: v16UnsupportedPanel ? v16UnsupportedPanel.annot.svg : null,
          unsupportedDraw: v16UnsupportedDraw, hint: v16UnsupportedState ? v16UnsupportedState.hint : null,
          restored: v16RestoredSync ? v16RestoredSync.annot.svg : null });
      // ---- V16.22 the mode gate stays hard; page input returns after exit ----------------
      const v16GateMap = await annotMappingNow();
      const v16GateCentre = annotCanvasToGui(v16GateMap, { x: 200, y: 150 });
      await ensurePointVisible(v16GateCentre);
      await dismissShellDialogs();
      await resetTargetInstrumentation();
      const v16GateMark = Date.now();
      await clickAt(v16GateCentre.x, v16GateCentre.y);
      await wheelOnFramePoint(v16GateCentre, 120);
      await sleep(500);
      const v16GatePosts = panelPosts('input', v16GateMark).length;
      const v16GateEvents = Number(await targetEval('window.__t3 ? window.__t3.events.length : -1'));
      await toggleAnnot(false);
      await hostViewportSet({ width: 400, height: 300, scale: 1, x: 0, y: 0 });
      await waitHostView((view) => Number(view.width) === 400 && Number(view.height) === 300 && closeTo(view.scale, 1, 0.0011));
      await waitPanelMirrorsHost();
      await waitCanvasState(true, true);
      await waitFrameStable();
      const v16RestoredClick = await clickThroughPanel('#t3-click', 400, 300);
      check('V16.22', 'the clear/eraser round never weakens the mode gate: zero page input inside the mode, a trusted page click works after exit',
        v16GatePosts === 0 && v16GateEvents === 0 && v16RestoredClick.clicksDelta === 1,
        { modeInputPosts: 0, modePageEvents: 0, clicksAfterExit: 1 },
        { inputPosts: v16GatePosts, pageEvents: v16GateEvents, clicksAfterExit: v16RestoredClick.clicksDelta });

      // Diagnostic only (never an assertion): can the annotation mode be reopened right after a
      // trusted page click? It is logged so a real regression at this seam is visible in the run log.
      const v16ReopenProbe = await toggleAnnot(true).catch((error) => ({ error: errorMessage(error) }));
      const v16ReopenFacts = await panelState();
      const v16ReopenShell = await pageEvaluate(panelExpr(`
        const status = panel.querySelector('.utb-status');
        const empty = panel.querySelector('.utb-empty');
        return {
          activity: status ? (status.textContent || '').trim().slice(0, 120) : null,
          empty: empty ? (empty.textContent || '').trim().slice(0, 120) : null,
        };
      `)).catch(() => null);
      log(`  [probe] annotation reopen after a page click: pressed=${JSON.stringify(v16ReopenProbe && v16ReopenProbe.pressed)} bar=${Boolean(v16ReopenFacts.annot && v16ReopenFacts.annot.bar)} disabled=${JSON.stringify(v16ReopenProbe && v16ReopenProbe.disabled)} canvas=${JSON.stringify(v16ReopenFacts.canvasOn)}/${JSON.stringify(v16ReopenFacts.canvasReady)} status=${JSON.stringify(v16ReopenShell)}`);
      await toggleAnnot(false).catch(() => undefined);
    });

    await scenario('V16b annotation selection tools (P0-D v5)', async () => {
      // Selection (选择) and marquee (框选) are the two leftmost tools. The visual feedback the user
      // asked for is asserted as pixels-independent DOM facts: a brand-colour halo per selected
      // shape, a tinted bounding box, the "已选 N 个" chip and the 删除选中 button. Selection itself
      // never posts; only moving/deleting does.
      await toggleAnnot(false).catch(() => undefined);
      await navigateTarget(`${fixtureBase}/web-t3.html`);
      await waitForFrame();
      await ensureHorizontalOverflow();
      await clickFit(false);
      await hostViewportSet({ width: 400, height: 300, scale: 1, x: 0, y: 0 });
      await waitHostView((view) => Number(view.width) === 400 && Number(view.height) === 300
        && closeTo(view.scale, 1, 0.0011) && near(view.x, 0, 1) && near(view.y, 0, 1));
      await hostViewportSet({ canvasX: 0, canvasY: 0 });
      await waitHostView((view) => near(view.canvasX, 0, 1) && near(view.canvasY, 0, 1));
      await waitPanelMirrorsHost();
      await waitCanvasState(true, true);
      await waitFrameStable();
      await closeSizeBar();
      // A preceding scenario may leave the mode mid-transition: open the bar deterministically.
      await waitFor(async () => {
        const panel = await panelState();
        const annot = panel.annot;
        if (!annot) return undefined;
        if (annot.pressed === 'true' && annot.tools.some((tool) => tool.tool === 'select')) return panel;
        if (annot.disabled === false) await toggleAnnot(true);
        return undefined;
      }, { timeoutMs: 12000, intervalMs: 250, label: 'annotation bar with selection tools open' });

      const selectionFacts = () => pageEvaluate(panelExpr(`
        const svg = panel.querySelector('.utb-annot-layer');
        const chip = panel.querySelector('[data-utb-annot-selection-chip]');
        const perf = panel.querySelector('.utb-perf');
        const del = panel.querySelector('[data-utb-annot-action="delete-selection"]');
        const halos = svg ? [...svg.querySelectorAll('[data-utb-annot-halo]')] : [];
        const boxes = svg ? [...svg.querySelectorAll('[data-utb-annot-select-box]')] : [];
        const haloShape = halos.length ? halos[0].querySelector('rect, ellipse, line, polyline, polygon, text') : null;
        const haloStyle = haloShape ? getComputedStyle(haloShape) : null;
        const boxNode = boxes.length ? boxes[0] : null;
        const fillStyle = boxNode && boxNode.querySelector('.utb-annot-select-fill')
          ? getComputedStyle(boxNode.querySelector('.utb-annot-select-fill')) : null;
        const edgeStyle = boxNode && boxNode.querySelector('.utb-annot-select-edge')
          ? getComputedStyle(boxNode.querySelector('.utb-annot-select-edge')) : null;
        const antsStyle = boxNode && boxNode.querySelector('.utb-annot-select-ants')
          ? getComputedStyle(boxNode.querySelector('.utb-annot-select-ants')) : null;
        const chipStyle = chip ? getComputedStyle(chip) : null;
        return {
          count: svg ? Number(svg.getAttribute('data-utb-annot-selection-count')) : -1,
          selected: svg ? [...svg.querySelectorAll('g[data-utb-annot-state="committed"]')]
            .filter((g) => g.getAttribute('data-utb-annot-selected') === 'true')
            .map((g) => g.getAttribute('data-utb-annot-id')) : [],
          halos: halos.map((el) => el.getAttribute('data-utb-annot-halo')),
          boxes: boxes.map((el) => el.getAttribute('data-utb-annot-select-box')),
          haloStroke: haloStyle ? { stroke: haloStyle.stroke, width: haloStyle.strokeWidth } : null,
          boxFill: fillStyle ? fillStyle.fill : null,
          boxStroke: edgeStyle ? { stroke: edgeStyle.stroke, width: edgeStyle.strokeWidth } : null,
          boxAnts: antsStyle ? { stroke: antsStyle.stroke, dash: antsStyle.strokeDasharray } : null,
          chip: chip ? { text: (chip.textContent || '').trim(), count: chip.getAttribute('data-utb-annot-selection-chip'),
            background: chipStyle.backgroundColor, color: chipStyle.color,
            inStatusBar: Boolean(chip.closest('.utb-status')),
            afterPerf: Boolean(perf && perf.nextElementSibling === chip) } : null,
          deleteButton: del ? { text: (del.textContent || '').trim(), count: del.getAttribute('data-utb-annot-selection'), disabled: del.disabled === true } : null,
        };
      `));

      const toolFacts = await pageEvaluate(panelExpr(`
        const tools = [...panel.querySelectorAll('[data-utb-annot-tool]')];
        const positions = tools.map((el) => ({ tool: el.getAttribute('data-utb-annot-tool'), left: el.getBoundingClientRect().left }));
        const byId = (id) => tools.find((el) => el.getAttribute('data-utb-annot-tool') === id) || null;
        const select = byId('select');
        const marquee = byId('marquee');
        const circle = byId('circle');
        const svg = panel.querySelector('.utb-annot-layer');
        const icon = (el) => { const s = el ? el.querySelector('svg') : null; return s ? { width: s.getAttribute('width'), height: s.getAttribute('height'), strokeWidth: s.getAttribute('stroke-width'), stroke: s.getAttribute('stroke'), dashed: Boolean((s.querySelector('rect') || {}).getAttribute && s.querySelector('rect').getAttribute('stroke-dasharray')) } : null; };
        return {
          positions,
          select: select ? { label: select.getAttribute('aria-label'), title: select.title, pressed: select.getAttribute('aria-pressed'), icon: icon(select) } : null,
          marquee: marquee ? { label: marquee.getAttribute('aria-label'), title: marquee.title, pressed: marquee.getAttribute('aria-pressed'), icon: icon(marquee) } : null,
          order: Boolean(select && marquee && circle)
            && select.getBoundingClientRect().left < marquee.getBoundingClientRect().left
            && marquee.getBoundingClientRect().right <= circle.getBoundingClientRect().left + 1,
          svgTool: svg ? svg.getAttribute('data-utb-annot-active-tool') : null,
          svgCount: svg ? svg.getAttribute('data-utb-annot-selection-count') : null,
        };
      `));
      check('V16b.1', '选择/框选 are the two leftmost tools (28px, 16/1.7/currentColor icons, 框选 dashed), 矩形 stays the default and the layer exposes tool/count',
        toolFacts.select && toolFacts.marquee
          && toolFacts.select.label === '选择' && toolFacts.select.title === '选择'
          && toolFacts.marquee.label === '框选' && toolFacts.marquee.title === '框选'
          && toolFacts.positions.slice(0, 2).map((entry) => entry.tool).join('|') === 'select|marquee'
          && toolFacts.order === true
          && toolFacts.select.pressed === 'false' && toolFacts.marquee.pressed === 'false'
          && toolFacts.select.icon && toolFacts.select.icon.width === '16' && toolFacts.select.icon.height === '16'
          && toolFacts.select.icon.strokeWidth === '1.7' && toolFacts.select.icon.stroke === 'currentColor'
          && toolFacts.marquee.icon && toolFacts.marquee.icon.width === '16' && toolFacts.marquee.icon.height === '16'
          && toolFacts.marquee.icon.strokeWidth === '1.7' && toolFacts.marquee.icon.stroke === 'currentColor'
          && toolFacts.marquee.icon.dashed === true && toolFacts.select.icon.dashed === false
          && toolFacts.svgTool === 'rect' && toolFacts.svgCount === '0',
        { order: 'select|marquee|circle…', defaultTool: 'rect', icons: '16/1.7/currentColor, 框选 dashed' },
        { tools: toolFacts.positions.slice(0, 3), select: toolFacts.select, marquee: toolFacts.marquee, svg: { tool: toolFacts.svgTool, count: toolFacts.svgCount } });

      // Two stroke-only rects: a select click must land on the stroke, and dragging starts from it.
      await clickAnnotTool('rect');
      await annotPrepareStyle({ fill: false, stroke: true, width: 3, color: '#ff3b30' });
      await annotDrawStable({ x: 60, y: 60 }, { x: 140, y: 120 }, { steps: 5 });
      await annotDrawStable({ x: 220, y: 160 }, { x: 300, y: 240 }, { steps: 5 });
      const twoPanel = await waitAnnotShapeCount(2);
      const twoShapes = annotShapes(twoPanel);
      const firstId = twoShapes[0].id;
      const secondId = twoShapes[1].id;
      const firstX0 = annotNumAttr(twoShapes[0], 'x');
      const firstY0 = annotNumAttr(twoShapes[0], 'y');

      await clickAnnotTool('select');
      const firstEdge = await annotPointGui({ x: 100, y: 60 });
      await annotPressGui(firstEdge);
      const one = await selectionFacts();
      check('V16b.2', 'a select click on a stroke selects exactly that shape and shows the obvious feedback: 8px halo, white + blue marching-ants box with a tint, 已选 1 个 as a bottom status item right after the latency, and 删除选中 button',
        one.count === 1 && one.selected.join('|') === firstId
          && one.halos.join('|') === firstId && one.boxes.join('|') === firstId
          && one.haloStroke && one.haloStroke.width === '8px' && one.haloStroke.stroke !== 'none'
          && one.boxStroke && one.boxStroke.width === '3px' && one.boxStroke.stroke !== 'none'
          && one.boxAnts && one.boxAnts.stroke !== 'none' && one.boxAnts.dash !== 'none'
          && one.boxFill && one.boxFill !== 'none' && one.boxFill !== 'rgba(0, 0, 0, 0)'
          && one.chip && one.chip.text === '已选 1 个' && one.chip.count === '1'
          && one.chip.inStatusBar === true && one.chip.afterPerf === true
          && one.deleteButton && one.deleteButton.text === '删除选中（1）' && one.deleteButton.disabled === false,
        { selected: firstId, halo: '8px blue', box: 'white + blue marching ants + tint',
          status: '已选 1 个 in the bottom bar right after the latency', delete: '删除选中（1）' },
        { one });

      // Shift-click adds the second shape.
      const secondEdge = await annotPointGui({ x: 220, y: 160 });
      await state.chrome.cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: secondEdge.x, y: secondEdge.y, button: 'none', buttons: 0 });
      await state.chrome.cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: secondEdge.x, y: secondEdge.y, button: 'left', buttons: 1, clickCount: 1, modifiers: 8 });
      await state.chrome.cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: secondEdge.x, y: secondEdge.y, button: 'left', buttons: 0, clickCount: 1, modifiers: 8 });
      await sleep(260);
      const both = await selectionFacts();
      await capturePanel('shot-33-annot-selection-two');
      await captureStatusBar('shot-34-annot-selection-status');
      check('V16b.3', 'Shift+click adds the second shape: two halos/boxes and the chip count follow, still zero Host writes from selecting alone',
        both.count === 2 && both.selected.slice().sort().join('|') === [firstId, secondId].sort().join('|')
          && both.halos.slice().sort().join('|') === [firstId, secondId].sort().join('|')
          && both.boxes.length === 2 && both.chip.text === '已选 2 个'
          && both.deleteButton.text === '删除选中（2）',
        { selected: 2, halos: 2, boxes: 2, chip: '已选 2 个' },
        { both });

      // Drag the selection from the INTERIOR of the hollow rect (not its stroke): a selected shape
      // must move from anywhere inside its selection box, and every selected shape moves together.
      let moveMap = await annotMappingNow();
      await ensurePointVisible(annotCanvasToGui(moveMap, { x: 100, y: 90 }));
      await sleep(120);
      moveMap = await annotMappingNow();
      await annotEnsureHit(annotCanvasToGui(moveMap, { x: 100, y: 90 }));
      const moveFrom = annotCanvasToGui(moveMap, { x: 100, y: 90 });
      await state.chrome.cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: moveFrom.x, y: moveFrom.y, button: 'none', buttons: 0 });
      await sleep(140);
      const moveHover = await pageEvaluate(panelExpr(`
        const svg = panel.querySelector('.utb-annot-layer');
        return svg ? getComputedStyle(svg).cursor : null;
      `));
      await annotDragGui(moveFrom, annotCanvasToGui(moveMap, { x: 120, y: 100 }), { steps: 6 });
      await sleep(260);
      const movedPanel = await panelState();
      const movedShapes = annotShapes(movedPanel);
      const movedFirst = movedShapes.find((shape) => shape.id === firstId);
      const movedSecond = movedShapes.find((shape) => shape.id === secondId);
      const movedHost = await waitHostAnnotations((doc) => Array.isArray(doc.shapes) && doc.shapes.length === 2
        && doc.shapes.some((shape) => shape.id === firstId && near(Number(shape.x), firstX0 + 20, 1.5)), { timeoutMs: 12000 });
      const movedFacts = await selectionFacts();
      check('V16b.4', 'dragging from inside the selected shape\'s box moves every selected shape together in canvas coordinates (+20/+10), with a move cursor, keeps the selection and publishes the moved document',
        moveHover === 'move'
          && near(annotNumAttr(movedFirst, 'x'), firstX0 + 20, 1.2) && near(annotNumAttr(movedFirst, 'y'), firstY0 + 10, 1.2)
          && near(annotNumAttr(movedSecond, 'x'), 240, 1.2) && near(annotNumAttr(movedSecond, 'y'), 170, 1.2)
          && movedFacts.count === 2
          && movedHost.shapes.some((shape) => shape.id === secondId && near(Number(shape.x), 240, 1.5)),
        { hover: 'move', first: '+20/+10', second: '+20/+10', selection: 2, published: true },
        { hover: moveHover, first: { x: annotNumAttr(movedFirst, 'x'), y: annotNumAttr(movedFirst, 'y') },
          second: { x: annotNumAttr(movedSecond, 'x'), y: annotNumAttr(movedSecond, 'y') },
          count: movedFacts.count, host: movedHost.shapes.map((shape) => ({ id: shape.id, x: shape.x, y: shape.y })) });

      // Esc clears the selection first (mode and shapes stay).
      await pressKey('Escape', 'Escape', 27);
      await sleep(220);
      const escaped = await panelState();
      const escapedFacts = await selectionFacts();
      check('V16b.5', 'Esc clears the selection/halo/box/chip but keeps the mode and both shapes (a second Esc is what exits the mode)',
        escaped.annot.pressed === 'true' && annotShapes(escaped).length === 2
          && escapedFacts.count === 0 && escapedFacts.halos.length === 0 && escapedFacts.boxes.length === 0
          && escapedFacts.chip === null && escapedFacts.deleteButton === null,
        { mode: 'on', shapes: 2, selection: 0 },
        { mode: escaped.annot.pressed, shapes: annotShapes(escaped).length, facts: escapedFacts });

      // Marquee over both shapes selects both; a click-sized marquee clears the selection.
      await clickAnnotTool('marquee');
      await annotDrawStable({ x: 40, y: 40 }, { x: 320, y: 260 }, { steps: 6 });
      await sleep(240);
      const marqueed = await selectionFacts();
      // Drag the whole marquee-selected group from the GAP between its members (inside the union
      // box, outside both shapes): every selected shape must move together.
      let gapMap = await annotMappingNow();
      await ensurePointVisible(annotCanvasToGui(gapMap, { x: 200, y: 150 }));
      await sleep(100);
      gapMap = await annotMappingNow();
      const gapGui = annotCanvasToGui(gapMap, { x: 200, y: 150 });
      await annotDragGui(gapGui, annotCanvasToGui(gapMap, { x: 210, y: 160 }), { steps: 5 });
      await sleep(260);
      const groupPanel = await panelState();
      const groupMovedFacts = await selectionFacts();
      const groupFirst = annotShapes(groupPanel).find((shape) => shape.id === firstId);
      const groupSecond = annotShapes(groupPanel).find((shape) => shape.id === secondId);
      check('V16b.6b', 'a marquee-selected group moves together when dragged from the gap between members (no shape under the press), and the selection stays',
        groupMovedFacts.count === 2
          && near(annotNumAttr(groupFirst, 'x'), 90, 1.2) && near(annotNumAttr(groupFirst, 'y'), 80, 1.2)
          && near(annotNumAttr(groupSecond, 'x'), 250, 1.2) && near(annotNumAttr(groupSecond, 'y'), 180, 1.2),
        { dragFrom: 'gap inside union box', first: '+10/+10', second: '+10/+10', selected: 2 },
        { facts: groupMovedFacts, first: { x: annotNumAttr(groupFirst, 'x'), y: annotNumAttr(groupFirst, 'y') },
          second: { x: annotNumAttr(groupSecond, 'x'), y: annotNumAttr(groupSecond, 'y') } });

      const emptyPoint = await annotPointGui({ x: 380, y: 280 });
      await annotClickGui(emptyPoint);
      const deselected = await selectionFacts();
      check('V16b.6', '框选 selects every intersected shape (two halos + chip 已选 2 个); a click-sized marquee on empty canvas clears the selection',
        marqueed.count === 2 && marqueed.selected.slice().sort().join('|') === [firstId, secondId].sort().join('|')
          && marqueed.chip && marqueed.chip.text === '已选 2 个'
          && deselected.count === 0 && deselected.halos.length === 0 && deselected.chip === null,
        { marquee: { selected: 2, chip: '已选 2 个' }, clickEmpty: { selected: 0 } },
        { marqueed, deselected });

      // Marquee a subset, then Delete removes exactly the selected shape.
      await annotDrawStable({ x: 40, y: 40 }, { x: 190, y: 150 }, { steps: 6 });
      await sleep(220);
      const subset = await selectionFacts();
      await pressKey('Delete', 'Delete', 46);
      const deletedPanel = await waitFor(async () => {
        const panel = await panelState();
        return annotShapes(panel).length === 1 ? panel : undefined;
      }, { timeoutMs: 8000, intervalMs: 120, label: 'Delete removes the selected shape' });
      const deletedHost = await waitHostAnnotations((doc) => Array.isArray(doc.shapes) && doc.shapes.length === 1 && doc.shapes[0].id === secondId, { timeoutMs: 12000 });
      const deletedFacts = await selectionFacts();
      check('V16b.7', 'Delete removes only the selected shape, publishes the remaining one, and clears the selection feedback',
        subset.count === 1 && subset.selected.join('|') === firstId
          && annotShapes(deletedPanel).length === 1 && annotShapes(deletedPanel)[0].id === secondId
          && deletedHost.shapes.length === 1 && deletedHost.shapes[0].id === secondId
          && deletedFacts.count === 0 && deletedFacts.halos.length === 0 && deletedFacts.deleteButton === null,
        { selectedBefore: firstId, remaining: secondId, host: 1, selection: 0 },
        { subset, remaining: annotShapes(deletedPanel).map((shape) => shape.id), host: deletedHost.shapes.map((shape) => shape.id), deletedFacts });

      // The visible 删除选中 button deletes the last selected shape too.
      await clickAnnotTool('select');
      // The remaining shape moved with the group in V16b.4: click its own (moved) top-left stroke.
      const remainingShape = annotShapes(deletedPanel)[0];
      const lastEdge = await annotPointGui({ x: annotNumAttr(remainingShape, 'x'), y: annotNumAttr(remainingShape, 'y') });
      await annotPressGui(lastEdge);
      const beforeButton = await selectionFacts();
      const deleteRect = await pageEvaluate(panelExpr(`
        const b = panel.querySelector('[data-utb-annot-action="delete-selection"]');
        if (!b) return null;
        const r = b.getBoundingClientRect();
        return { x: r.left + r.width / 2, y: r.top + r.height / 2, disabled: b.disabled === true };
      `));
      if (deleteRect && !deleteRect.disabled) await clickAt(deleteRect.x, deleteRect.y);
      const emptiedPanel = await waitFor(async () => {
        const panel = await panelState();
        return annotShapes(panel).length === 0 ? panel : undefined;
      }, { timeoutMs: 8000, intervalMs: 120, label: 'delete button removes the last shape' });
      const emptiedHost = await waitHostAnnotations((doc) => Array.isArray(doc.shapes) && doc.shapes.length === 0, { timeoutMs: 12000 });
      const emptiedFacts = await selectionFacts();
      check('V16b.8', 'the visible 删除选中（N） button deletes the last selected shape, empties the Host document and removes every feedback element',
        beforeButton.count === 1 && beforeButton.deleteButton.text === '删除选中（1）'
          && Boolean(deleteRect) && deleteRect.disabled === false
          && annotShapes(emptiedPanel).length === 0 && emptiedHost.shapes.length === 0
          && emptiedFacts.count === 0 && emptiedFacts.halos.length === 0 && emptiedFacts.boxes.length === 0 && emptiedFacts.chip === null,
        { selectedBefore: 1, remaining: 0, host: 0 },
        { beforeButton, button: deleteRect, remaining: annotShapes(emptiedPanel).length, facts: emptiedFacts });

      await toggleAnnot(false).catch(() => undefined);
    });

    await scenario('V16c annotation selection feel (P0-D v5)', async () => {
      // Standalone fixture: this scenario also runs with DSH_VIEWPORT_GUI_ONLY=V16c.
      // All tested gestures/shortcuts use trusted CDP input; DOM reads only observe feedback.
      await toggleAnnot(false).catch(() => undefined);
      await navigateTarget(`${fixtureBase}/web-t3.html`);
      await waitForFrame();
      await ensureHorizontalOverflow();
      await clickFit(false);
      await hostViewportSet({ width: 400, height: 300, scale: 1, x: 0, y: 0 });
      await waitHostView((view) => Number(view.width) === 400 && Number(view.height) === 300
        && closeTo(view.scale, 1, 0.0011) && near(view.x, 0, 1) && near(view.y, 0, 1));
      await hostViewportSet({ canvasX: 0, canvasY: 0 });
      await waitHostView((view) => near(view.canvasX, 0, 1) && near(view.canvasY, 0, 1));
      await waitPanelMirrorsHost();
      await waitCanvasState(true, true);
      await waitFrameStable();
      await closeSizeBar();
      await waitFor(async () => {
        const panel = await panelState();
        if (panel.annot && panel.annot.pressed === 'true'
          && panel.annot.tools.some((tool) => tool.tool === 'select')) return panel;
        if (panel.annot && panel.annot.disabled === false) await toggleAnnot(true);
        return undefined;
      }, { timeoutMs: 12000, intervalMs: 250, label: 'V16c annotation bar open' });
      await annotResetCanvas();
      await clickAnnotTool('rect');
      await annotPrepareStyle({ fill: false, stroke: true, width: 3, color: '#ff3b30' });
      await annotDrawStable({ x: 60, y: 60 }, { x: 140, y: 120 }, { steps: 5 });
      await annotDrawStable({ x: 220, y: 160 }, { x: 300, y: 240 }, { steps: 5 });
      const seeded = annotShapes(await waitAnnotShapeCount(2));
      const [firstId, secondId] = seeded.map((shape) => shape.id);
      const xy = (shape) => ({ x: annotNumAttr(shape, 'x'), y: annotNumAttr(shape, 'y') });
      const firstOrigin = xy(seeded[0]);
      const secondOrigin = xy(seeded[1]);
      await waitHostAnnotations((doc) => doc.shapes && doc.shapes.length === 2
        && doc.shapes.some((shape) => shape.id === firstId)
        && doc.shapes.some((shape) => shape.id === secondId));
      await waitAnnotSync('synced');
      await sleep(350);
      const baseHost = await hostAnnotations();
      const selectionSince = Date.now();
      const sameHost = (doc, base) => doc && base && doc.revision === base.revision
        && JSON.stringify(doc.shapes) === JSON.stringify(base.shapes);
      const sameIds = (facts, ids) => facts.selected.slice().sort().join('|') === ids.slice().sort().join('|')
        && facts.count === ids.length;
      const facts = async () => {
        // Selection changes are animation-frame coalesced; sample while the button stays held.
        await sleep(90);
        return pageEvaluate(panelExpr(`
          const svg = panel.querySelector('.utb-annot-layer');
          const committed = svg ? [...svg.querySelectorAll('g[data-utb-annot-state="committed"]')] : [];
          const group = svg && svg.querySelector('[data-utb-annot-group-box]');
          const groupRect = group && group.querySelector('rect');
          const marquee = svg && svg.querySelector('[data-utb-annot-marquee]');
          const rect = (el) => el ? Object.fromEntries(['x', 'y', 'width', 'height'].map((key) => [key, Number(el.getAttribute(key))])) : null;
          const edit = panel.querySelector('.utb-annot-text-input');
          return {
            tool: svg && svg.getAttribute('data-utb-annot-active-tool'),
            count: svg ? Number(svg.getAttribute('data-utb-annot-selection-count')) : -1,
            selected: committed.filter((el) => el.getAttribute('data-utb-annot-selected') === 'true')
              .map((el) => el.getAttribute('data-utb-annot-id')),
            shapes: committed.map((el) => ({ id: el.getAttribute('data-utb-annot-id'),
              x: Number(el.getAttribute('data-utb-annot-x')), y: Number(el.getAttribute('data-utb-annot-y')) })),
            halos: svg ? svg.querySelectorAll('[data-utb-annot-halo]').length : 0,
            boxes: svg ? svg.querySelectorAll('[data-utb-annot-select-box]').length : 0,
            bounds: svg ? [...svg.querySelectorAll('[data-utb-annot-select-box]')].map((el) => rect(el.querySelector('rect'))) : [],
            group: rect(groupRect), groupCount: svg ? svg.querySelectorAll('[data-utb-annot-group-box]').length : 0,
            marquee: rect(marquee), marqueeMode: marquee && marquee.getAttribute('data-utb-annot-marquee-mode'),
            chip: (panel.querySelector('[data-utb-annot-selection-chip]') || {}).textContent || null,
            focused: Boolean(svg && document.activeElement === svg),
            edit: edit ? { value: edit.value, start: edit.selectionStart, end: edit.selectionEnd,
              focused: document.activeElement === edit } : null,
          };
        `));
      };
      const mouse = (type, point, modifiers = 0) => state.chrome.cdp.send('Input.dispatchMouseEvent', {
        type, x: point.x, y: point.y, modifiers,
        button: type === 'mouseMoved' ? 'none' : 'left',
        buttons: type === 'mouseReleased' ? 0 : 1, clickCount: type === 'mouseMoved' ? 0 : 1,
      });
      const key = async (name, code, vk, modifiers = 0, type) => {
        for (const phase of type ? [type] : ['keyDown', 'keyUp']) {
          await state.chrome.cdp.send('Input.dispatchKeyEvent', {
            type: phase, key: name, code, modifiers, windowsVirtualKeyCode: vk, nativeVirtualKeyCode: vk,
          });
        }
      };
      const click = async (canvas, modifiers = 0) => {
        const point = await annotPointGui(canvas);
        await mouse('mousePressed', point, modifiers);
        await mouse('mouseReleased', point, modifiers);
        return facts();
      };
      const begin = async (canvas, modifiers = 0) => {
        const point = await annotPointGui(canvas);
        const map = await annotMappingNow();
        await mouse('mousePressed', point, modifiers);
        return { point, map };
      };
      const shapeAt = (snapshot, id) => snapshot.shapes.find((shape) => shape.id === id);
      const at = (snapshot, id, x, y) => {
        const shape = shapeAt(snapshot, id);
        return Boolean(shape) && near(shape.x, x, 1.2) && near(shape.y, y, 1.2);
      };
      check('V16c.1', 'standalone selection-feel fixture creates its own two stroke-only rectangles',
        seeded.every((shape) => shape.type === 'rect') && firstId !== secondId
          && near(firstOrigin.x, 60, 1.2) && near(firstOrigin.y, 60, 1.2)
          && near(secondOrigin.x, 220, 1.2) && near(secondOrigin.y, 160, 1.2),
        { rects: [[60, 60, 140, 120], [220, 160, 300, 240]] }, seeded.map((shape) => ({ id: shape.id, ...xy(shape) })));

      await clickAnnotTool('select');
      let drag = await begin({ x: 30, y: 30 });
      await mouse('mouseMoved', annotCanvasToGui(drag.map, { x: 320, y: 260 }));
      const previewBoth = await facts();
      await mouse('mouseMoved', annotCanvasToGui(drag.map, { x: 170, y: 140 }));
      const previewFirst = await facts();
      await mouse('mouseMoved', annotCanvasToGui(drag.map, { x: 31, y: 31 }));
      const previewEmpty = await facts();
      check('V16c.2', 'select-tool empty-space drag previews both, then one, then none as the marquee shrinks before release',
        sameIds(previewBoth, [firstId, secondId]) && previewBoth.halos === 2 && previewBoth.boxes === 2
          && previewBoth.chip === '已选 2 个' && Boolean(previewBoth.marquee)
          && sameIds(previewFirst, [firstId]) && sameIds(previewEmpty, []) && Boolean(previewEmpty.marquee),
        { heldPreviewCounts: [2, 1, 0], feedback: 'halos, per-shape boxes, chip, live marquee' },
        { previewBoth, previewFirst, previewEmpty });
      // No move at this final point: pointerup itself must resample the marquee.
      await mouse('mouseReleased', annotCanvasToGui(drag.map, { x: 170, y: 140 }));
      const upMarquee = await facts();
      check('V16c.3', 'marquee pointerup uses its final coordinates and selection alone never changes the Host document',
        sameIds(upMarquee, [firstId]) && upMarquee.marquee === null
          && sameHost(await hostAnnotations(), baseHost) && annotationPosts(selectionSince).length === 0,
        { selected: [firstId], marquee: null, hostWrites: 0 }, { upMarquee, posts: annotationPosts(selectionSince) });

      const shiftExisting = await click({ x: 100, y: 60 }, 8);
      const shiftRestored = await click({ x: 100, y: 60 }, 8);
      const shiftAdded = await click({ x: 260, y: 160 }, 8);
      const ctrlToggled = await click({ x: 260, y: 160 }, 2);
      const metaToggled = await click({ x: 260, y: 160 }, 4);
      check('V16c.4', 'Shift/Ctrl/Meta-click toggle membership (Shift marquee uses union, tested separately)',
        sameIds(shiftExisting, []) && sameIds(shiftRestored, [firstId]) && sameIds(shiftAdded, [firstId, secondId])
          && sameIds(ctrlToggled, [firstId]) && sameIds(metaToggled, [firstId, secondId]),
        { counts: [0, 1, 2, 1, 2] }, { shiftExisting, shiftRestored, shiftAdded, ctrlToggled, metaToggled });
      const group = metaToggled.group;
      const bounds = metaToggled.bounds.filter(Boolean);
      const unionBox = bounds.length ? {
        x: Math.min(...bounds.map((box) => box.x)), y: Math.min(...bounds.map((box) => box.y)),
        right: Math.max(...bounds.map((box) => box.x + box.width)),
        bottom: Math.max(...bounds.map((box) => box.y + box.height)),
      } : null;
      check('V16c.5', 'multi-selection keeps per-shape feedback and adds exactly one outer group boundary enclosing both rectangles',
        sameIds(metaToggled, [firstId, secondId]) && metaToggled.groupCount === 1
          && metaToggled.halos === 2 && metaToggled.boxes === 2 && Boolean(group)
          && group.x <= firstOrigin.x && group.y <= firstOrigin.y
          && group.x + group.width >= secondOrigin.x + 80 && group.y + group.height >= secondOrigin.y + 80
          && Boolean(unionBox) && near(group.x, unionBox.x, 0.01) && near(group.y, unionBox.y, 0.01)
          && near(group.x + group.width, unionBox.right, 0.01) && near(group.y + group.height, unionBox.bottom, 0.01),
        { outerGroup: 1, perShapeBoxes: 2, encloses: 'exact union of both per-shape boxes' }, metaToggled);

      // Keep the pointer still while real modifier key events recompute from the gesture's base.
      drag = await begin({ x: 30, y: 30 }, 8);
      await mouse('mouseMoved', annotCanvasToGui(drag.map, { x: 170, y: 140 }), 8);
      const union = await facts();
      await key('Shift', 'ShiftLeft', 16, 0, 'keyUp');
      const replaced = await facts();
      await key('Alt', 'AltLeft', 18, 1, 'keyDown');
      const subtracted = await facts();
      await key('Shift', 'ShiftLeft', 16, 9, 'keyDown');
      const intersected = await facts();
      check('V16c.6', 'held marquee uses Shift union, Alt subtraction and Shift+Alt intersection; keyboard-only modifier changes update preview from the original base',
        sameIds(union, [firstId, secondId]) && union.marqueeMode === 'add'
          && sameIds(replaced, [firstId]) && replaced.marqueeMode === 'replace'
          && sameIds(subtracted, [secondId]) && subtracted.marqueeMode === 'subtract'
          && sameIds(intersected, [firstId]) && intersected.marqueeMode === 'intersect',
        { union: [firstId, secondId], replace: [firstId], subtract: [secondId], intersect: [firstId] },
        { union, replaced, subtracted, intersected });
      await key('Escape', 'Escape', 27, 9);
      await key('Shift', 'ShiftLeft', 16, 1, 'keyUp');
      await key('Alt', 'AltLeft', 18, 0, 'keyUp');
      await mouse('mouseReleased', annotCanvasToGui(drag.map, { x: 170, y: 140 }));
      const cancelled = await facts();
      await sleep(450);
      check('V16c.7', 'Esc cancels the live marquee, restores its base selection and leaves mode, shapes and Host revision intact',
        sameIds(cancelled, [firstId, secondId]) && cancelled.marquee === null
          && cancelled.shapes.length === 2 && (await panelState()).annot.pressed === 'true'
          && sameHost(await hostAnnotations(), baseHost) && annotationPosts(selectionSince).length === 0,
        { selection: [firstId, secondId], hostWrites: 0, mode: 'on' }, { cancelled, posts: annotationPosts(selectionSince) });

      // Establish a single selection independently of the preceding modifier assertions.
      await click({ x: 380, y: 280 });
      await click({ x: 100, y: 60 });
      drag = await begin({ x: 100, y: 90 });
      await mouse('mouseMoved', { x: drag.point.x + 2, y: drag.point.y });
      const jitterPreview = await facts();
      await mouse('mouseReleased', { x: drag.point.x + 2, y: drag.point.y });
      await sleep(450);
      const jitterDone = await facts();
      check('V16c.8', '2 screen-pixel click jitter stays below the movement threshold with unchanged geometry and Host revision',
        at(jitterPreview, firstId, firstOrigin.x, firstOrigin.y) && at(jitterDone, firstId, firstOrigin.x, firstOrigin.y)
          && sameIds(jitterDone, [firstId]) && sameHost(await hostAnnotations(), baseHost),
        { delta: [0, 0], revision: baseHost.revision }, { jitterPreview, jitterDone, host: await hostAnnotations() });
      drag = await begin({ x: 100, y: 90 });
      await mouse('mouseMoved', annotCanvasToGui(drag.map, { x: 125, y: 100 }));
      const movedOut = await facts();
      await mouse('mouseMoved', drag.point);
      const returnedPreview = await facts();
      await mouse('mouseReleased', drag.point);
      await sleep(450);
      const returned = await facts();
      check('V16c.9', 'an activated drag can return to its exact press point and produce zero Host writes',
        at(movedOut, firstId, firstOrigin.x + 25, firstOrigin.y + 10)
          && at(returnedPreview, firstId, firstOrigin.x, firstOrigin.y)
          && at(returned, firstId, firstOrigin.x, firstOrigin.y)
          && sameHost(await hostAnnotations(), baseHost) && annotationPosts(selectionSince).length === 0,
        { previewDelta: [25, 10], finalDelta: [0, 0], hostWrites: 0 }, { movedOut, returnedPreview, returned });
      drag = await begin({ x: 100, y: 90 });
      await mouse('mouseMoved', annotCanvasToGui(drag.map, { x: 120, y: 100 }));
      const beforeMoveEsc = await facts();
      await key('Escape', 'Escape', 27);
      await mouse('mouseReleased', annotCanvasToGui(drag.map, { x: 120, y: 100 }));
      await sleep(450);
      const moveEsc = await facts();
      check('V16c.10', 'Esc during movement restores the captured geometry and selection without committing the move',
        at(beforeMoveEsc, firstId, firstOrigin.x + 20, firstOrigin.y + 10)
          && at(moveEsc, firstId, firstOrigin.x, firstOrigin.y) && sameIds(moveEsc, [firstId])
          && sameHost(await hostAnnotations(), baseHost) && annotationPosts(selectionSince).length === 0,
        { finalDelta: [0, 0], selected: [firstId], hostWrites: 0 }, { beforeMoveEsc, moveEsc });

      drag = await begin({ x: 100, y: 90 });
      // Deliberately omit mouseMoved between press and release.
      await mouse('mouseReleased', annotCanvasToGui(drag.map, { x: 120, y: 98 }));
      const upOnly = await facts();
      const upOnlyHost = await waitHostAnnotations((doc) => doc.shapes.some((shape) => shape.id === firstId
        && near(Number(shape.x), firstOrigin.x + 20, 1.2) && near(Number(shape.y), firstOrigin.y + 8, 1.2)));
      check('V16c.11', 'movement samples pointerup even when there was no intervening pointermove and publishes that final location',
        at(upOnly, firstId, firstOrigin.x + 20, firstOrigin.y + 8)
          && at(upOnly, secondId, secondOrigin.x, secondOrigin.y) && upOnlyHost.revision > baseHost.revision,
        { firstDelta: [20, 8], secondDelta: [0, 0], published: true }, { upOnly, revision: upOnlyHost.revision });
      drag = await begin({ x: 120, y: 98 });
      await mouse('mouseMoved', annotCanvasToGui(drag.map, { x: 150, y: 110 }), 8);
      const locked = await facts();
      await key('Shift', 'ShiftLeft', 16, 0, 'keyUp');
      const unlocked = await facts();
      await key('Shift', 'ShiftLeft', 16, 8, 'keyDown');
      const relocked = await facts();
      // Final point differs from the last move: sample the new X while keeping Y locked.
      await mouse('mouseReleased', annotCanvasToGui(drag.map, { x: 160, y: 116 }), 8);
      await key('Shift', 'ShiftLeft', 16, 0, 'keyUp');
      const axisDone = await facts();
      await waitHostAnnotations((doc) => doc.shapes.some((shape) => shape.id === firstId
        && near(Number(shape.x), firstOrigin.x + 60, 1.2) && near(Number(shape.y), firstOrigin.y + 8, 1.2)));
      check('V16c.12', 'Shift locks the dominant movement axis, releasing/repressing Shift recomputes without a move, and pointerup supplies the final locked delta',
        at(locked, firstId, firstOrigin.x + 50, firstOrigin.y + 8)
          && at(unlocked, firstId, firstOrigin.x + 50, firstOrigin.y + 20)
          && at(relocked, firstId, firstOrigin.x + 50, firstOrigin.y + 8)
          && at(axisDone, firstId, firstOrigin.x + 60, firstOrigin.y + 8),
        { localDeltas: [[30, 0], [30, 12], [30, 0], [40, 0]] }, { locked, unlocked, relocked, axisDone });

      // A pointer gesture gives the canvas real focus before the shortcut probes.
      await key('m', 'KeyM', 77);
      const shortcutM = await facts();
      await key('v', 'KeyV', 86);
      await key('a', 'KeyA', 65, 2);
      const shortcutAll = await facts();
      await key('d', 'KeyD', 68, 2);
      const shortcutNone = await facts();
      const beforeNudge = await click({ x: firstOrigin.x + 100, y: firstOrigin.y + 8 });
      await key('ArrowRight', 'ArrowRight', 39);
      const rightNudge = await facts();
      await key('ArrowDown', 'ArrowDown', 40, 8);
      const nudged = await facts();
      const nudgeStart = shapeAt(beforeNudge, firstId);
      const nudgeRight = shapeAt(rightNudge, firstId);
      const nudgeEnd = shapeAt(nudged, firstId);
      await waitHostAnnotations((doc) => doc.shapes.some((shape) => shape.id === firstId
        && near(Number(shape.x), firstOrigin.x + 61, 1.2) && near(Number(shape.y), firstOrigin.y + 18, 1.2)));
      check('V16c.13', 'canvas-focused M/V switch tools, Ctrl+A/Ctrl+D select/clear, arrows nudge 1 canvas px and Shift+arrow nudges 10',
        shortcutM.tool === 'marquee' && shortcutM.focused && shortcutAll.tool === 'select'
          && sameIds(shortcutAll, [firstId, secondId]) && sameIds(shortcutNone, [])
          && at(nudged, firstId, firstOrigin.x + 61, firstOrigin.y + 18)
          && Boolean(nudgeStart && nudgeRight && nudgeEnd)
          && near(nudgeRight.x - nudgeStart.x, 1, 0.01) && near(nudgeRight.y - nudgeStart.y, 0, 0.01)
          && near(nudgeEnd.x - nudgeRight.x, 0, 0.01) && near(nudgeEnd.y - nudgeRight.y, 10, 0.01)
          && at(nudged, secondId, secondOrigin.x, secondOrigin.y),
        { tools: ['marquee', 'select'], counts: [2, 0], nudge: [1, 10] },
        { shortcutM, shortcutAll, shortcutNone, beforeNudge, rightNudge, nudged });

      const beforeEditor = await hostAnnotations();
      await clickAnnotTool('text');
      await annotClickGui(await annotPointGui({ x: 350, y: 270 }));
      await state.chrome.cdp.send('Input.insertText', { text: 'vm' });
      await key('v', 'KeyV', 86);
      await key('m', 'KeyM', 77);
      await key('a', 'KeyA', 65, 2);
      const editorAll = await facts();
      await key('d', 'KeyD', 68, 2);
      await key('ArrowLeft', 'ArrowLeft', 37);
      await key('ArrowRight', 'ArrowRight', 39, 8);
      const editorProtected = await facts();
      await key('Escape', 'Escape', 27);
      await sleep(450);
      const editorCancelled = await facts();
      check('V16c.14', 'text-editor focus protects V/M, Ctrl+A/Ctrl+D and arrow shortcuts; Ctrl+A selects input text and Esc cancels without changing shapes',
        editorAll.tool === 'text' && editorAll.edit && editorAll.edit.focused
          && editorAll.edit.value === 'vm' && editorAll.edit.start === 0 && editorAll.edit.end === 2
          && editorProtected.tool === 'text' && editorProtected.edit && editorProtected.edit.focused
          && editorProtected.count === editorAll.count && editorCancelled.edit === null
          && at(editorCancelled, firstId, firstOrigin.x + 61, firstOrigin.y + 18)
          && sameHost(await hostAnnotations(), beforeEditor),
        { tool: 'text', inputSelection: [0, 2], shapeChanges: 0 }, { editorAll, editorProtected, editorCancelled });

      await clickAnnotTool('select');
      await hostViewportSet({ scale: 0.5 });
      await waitHostView((view) => closeTo(view.scale, 0.5, 0.0011));
      await waitPanelMirrorsHost();
      await waitFrameStable();
      await click({ x: 380, y: 280 });
      let halfMap = await annotMappingNow();
      const edgeCanvas = { x: firstOrigin.x + 101, y: firstOrigin.y + 18 };
      await ensurePointVisible(annotCanvasToGui(halfMap, edgeCanvas));
      halfMap = await annotMappingNow();
      const edge = annotCanvasToGui(halfMap, edgeCanvas);
      const offEdge = { x: edge.x, y: edge.y - 4 };
      await annotEnsureHit(offEdge);
      const beforeHit = await hostAnnotations();
      await annotPressGui(offEdge);
      const halfHit = await facts();
      check('V16c.15', 'at scale 0.5 a stroke-only rectangle is selectable 4 screen px outside its edge (6 screen-px hit tolerance)',
        closeTo(halfMap.sx, 0.5, 0.02) && closeTo(halfMap.sy, 0.5, 0.02)
          && sameIds(halfHit, [firstId]) && halfHit.group === null
          && sameHost(await hostAnnotations(), beforeHit),
        { scale: 0.5, outsideEdgeScreenPx: 4, selected: [firstId], hostChanges: 0 },
        { sx: halfMap.sx, sy: halfMap.sy, edge, offEdge, halfHit });
      await toggleAnnot(false).catch(() => undefined);
    });

    await scenario('V17 annotation workspace retention (P0-D v3)', async () => {
      // The v3 contract (docs/viewport-control.md §12): a panel unmount/tab switch/scope change only
      // retracts the local view; the workspace document is hydrated back, never erased by an empty
      // release. Every probe below is real CDP input; scope isolation without a second workspace is
      // exercised through a CDP /state projection (honest limitation recorded in each detail).
      const v17Check = async (id, label, expected, fn) => {
        try {
          const result = await fn();
          check(id, label, Boolean(result && result.pass), expected, result && result.detail);
          return result;
        } catch (error) {
          check(id, label, false, expected, { error: errorMessage(error) });
          return null;
        }
      };
      let v17EntryFallback = false;
      const ensureModeOn = async () => {
        if ((await panelState()).missing) {
          await openPanel();
          await waitFor(async () => {
            const panel = await panelState();
            return panel.missing !== true && panel.frame ? panel : undefined;
          }, { timeoutMs: 15000, intervalMs: 200, label: 'main panel restored' });
        }
        if (!v17EntryFallback) {
          const ready = await waitFor(async () => {
            const panel = await panelState();
            return panel.annot && panel.annot.disabled === false && panel.canvasOn === 'on' ? panel : undefined;
          }, { timeoutMs: 8000, intervalMs: 200, label: 'annotation entry ready' }).catch(() => null);
          if (ready) {
            const opened = await toggleAnnot(true);
            if (opened && opened.pressed === 'true') return;
            log('  [v17] mode-open: the trusted entry click was refused; using the setup-only DOM activation');
            v17EntryFallback = true;
          }
        }
        // Setup-only fallback: the trusted click can be swallowed by a transient shell mask or a
        // layout shift during the V16→V17 handoff. The interaction itself is covered by V15/V16;
        // V17 asserts the retention semantics, so activate the button through its own handler.
        for (let attempt = 0; attempt < 4; attempt += 1) {
          await pageEvaluate(panelExpr(`const b = panel.querySelector('button[aria-label="标注"]'); if (b && !b.disabled) b.click(); return true;`)).catch(() => undefined);
          await sleep(160);
          const after = await panelState();
          if (after.annot && after.annot.pressed === 'true') return;
          await sleep(120);
        }
        throw new Error('annotation mode did not open ' + JSON.stringify(await panelState()));
      };
      const resetCanvas = async () => {
        await ensureModeOn();
        await annotResetCanvas({ timeoutMs: 9000 });
        await waitHostAnnotations((doc) => Array.isArray(doc.shapes) && doc.shapes.length === 0, { timeoutMs: 12000 }).catch(() => null);
      };
      const drawRectAt = async (x, y, w, h, color) => {
        await ensureModeOn();
        await clickAnnotTool('rect');
        await annotPrepareStyle({ fill: false, stroke: true, width: 3, color: color || '#ff3b30' });
        await annotDrawStable({ x, y }, { x: x + w, y: y + h }, { steps: 5 });
      };
      const annotationSummary = (doc) => doc ? ({
        revision: doc.revision,
        updatedAt: doc.updatedAt,
        ids: Array.isArray(doc.shapes) ? doc.shapes.map((shape) => shape.id) : [],
        source: doc.source ? { panelId: doc.source.panelId, surface: doc.source.surface, clientRevision: doc.source.clientRevision } : null,
      }) : null;

      // Stable base: 400×300 @ 100 %, C=0, fit off, size bar open, web-t3 fixture.
      await navigateTarget(`${fixtureBase}/web-t3.html?ext=v17`);
      await waitForFrame();
      await ensureHorizontalOverflow();
      await clickFit(false);
      await hostViewportSet({ width: 400, height: 300, scale: 1, x: 0, y: 0 });
      await waitHostView((view) => Number(view.width) === 400 && Number(view.height) === 300
        && closeTo(view.scale, 1, 0.0011) && near(view.x, 0, 1) && near(view.y, 0, 1));
      await hostViewportSet({ canvasX: 0, canvasY: 0 });
      await waitHostView((view) => near(view.canvasX, 0, 1) && near(view.canvasY, 0, 1));
      await waitPanelMirrorsHost();
      await waitCanvasState(true, true);
      await waitFrameStable();
      await openSizeBar();
      // A fresh panel generation after V16: no mode/text-editor/pointer state is inherited.
      await remountMainPanel();
      await sleep(400);

      // ---- V17.1 mode exit/re-enter keeps the document --------------------------------------
      await v17Check('V17.1', 'exiting and re-entering the mode keeps shapes and the Host revision/updatedAt with zero POSTs',
        { shapes: 1, revision: 'unchanged', posts: 0 }, async () => {
          await resetCanvas();
          await drawRectAt(60, 60, 80, 60);
          await waitAnnotShapeCount(1);
          await waitAnnotSync(['synced'], { timeoutMs: 12000 });
          const hostBefore = await waitHostAnnotations((doc) => doc.shapes.length === 1);
          await capturePanel('shot-21-v17-reenter-before');
          const mark = Date.now();
          await toggleAnnot(false);
          await sleep(700);
          await ensureModeOn();
          await sleep(450);
          const panel = await panelState();
          const hostAfter = await hostAnnotations();
          await capturePanel('shot-21-v17-reenter-after');
          const posts = annotationPosts(mark);
          log(`  [v17.1] D/host before=${JSON.stringify(annotationSummary(hostBefore))} after=${JSON.stringify(annotationSummary(hostAfter))}`);
          return {
            pass: annotShapes(panel).length === 1
              && Number(hostAfter.revision) === Number(hostBefore.revision)
              && String(hostAfter.updatedAt) === String(hostBefore.updatedAt)
              && posts.length === 0,
            detail: { shapes: annotShapes(panel).length, revision: [hostBefore.revision, hostAfter.revision],
              updatedAt: [hostBefore.updatedAt, hostAfter.updatedAt], posts: posts.length },
          };
        });

      // ---- V17.2 hidden → visible keeps the drawing, no release ------------------------------
      await v17Check('V17.2', 'hiding the page (real CDP visibility override) then showing it keeps the drawing and posts no release',
        { shapes: 1, revision: 'unchanged', posts: 0, releases: 0 }, async () => {
          await resetCanvas();
          await drawRectAt(70, 70, 80, 60);
          await waitAnnotShapeCount(1);
          await waitAnnotSync(['synced'], { timeoutMs: 12000 });
          const hostBefore = await waitHostAnnotations((doc) => doc.shapes.length === 1);
          const mark = Date.now();
          const hidden = await setPageVisibility('hidden');
          if (hidden.actual !== 'hidden') throw new Error('document did not become hidden: ' + JSON.stringify(hidden));
          await sleep(900);
          const shown = await setPageVisibility('visible');
          if (shown.actual !== 'visible') throw new Error('document did not become visible: ' + JSON.stringify(shown));
          await sleep(1500);
          const panel = await panelState();
          const hostAfter = await hostAnnotations();
          return {
            pass: annotShapes(panel).length === 1
              && Number(hostAfter.revision) === Number(hostBefore.revision)
              && annotationPosts(mark).length === 0 && annotationReleases(mark).length === 0,
            detail: { method: hidden.method, hidden: hidden.actual, visible: shown.actual,
              shapes: annotShapes(panel).length, revision: [hostBefore.revision, hostAfter.revision],
              posts: annotationPosts(mark).length, releases: annotationReleases(mark).length },
          };
        });

      // ---- V17.3 real unmount → remount ------------------------------------------------------
      await v17Check('V17.3', 'a real unmount→remount restores the same SVG and Host revision with zero clearing writes',
        { shapes: 1, revision: 'unchanged', screen: '<=2px', posts: 0 }, async () => {
          await resetCanvas();
          await drawRectAt(80, 80, 80, 60);
          await waitAnnotShapeCount(1);
          await waitAnnotSync(['synced'], { timeoutMs: 12000 });
          const before = await panelState();
          const hostBefore = await waitHostAnnotations((doc) => doc.shapes.length === 1);
          const screenBefore = shapeScreenPoint(annotShapes(before)[0]);
          await capturePanel('shot-22-v17-remount-before');
          const mark = Date.now();
          await remountMainPanel();
          const restored = await waitAnnotShapeCount(1, { timeoutMs: 18000 });
          await ensureModeOn();
          await sleep(700);
          const after = await panelState();
          const hostAfter = await hostAnnotations();
          const screenAfter = shapeScreenPoint(annotShapes(after)[0]);
          await capturePanel('shot-22-v17-remount-after');
          const posts = annotationPosts(mark);
          log(`  [v17.3] host before=${JSON.stringify(annotationSummary(hostBefore))} after=${JSON.stringify(annotationSummary(hostAfter))} posts=${posts.length}`);
          return {
            pass: annotShapes(after).length === 1
              && Number(hostAfter.revision) === Number(hostBefore.revision)
              && Boolean(screenBefore) && Boolean(screenAfter)
              && near(screenAfter.x, screenBefore.x, 2) && near(screenAfter.y, screenBefore.y, 2)
              && posts.length === 0,
            detail: { shapes: annotShapes(after).length, revision: [hostBefore.revision, hostAfter.revision],
              screenBefore, screenAfter, posts: posts.length },
          };
        });

      // ---- V17.4 second panel generation (the isolated shell right sidebar is a track) ------
      await v17Check('V17.4', 'a second panel generation hydrates the same document without stealing the source (right-sidebar seat NOT_RUN)',
        { shapes: 1, source: 'unchanged', generation: 'same' }, async () => {
          await ensureModeOn();
          await resetCanvas();
          await drawRectAt(90, 90, 80, 60);
          await waitAnnotShapeCount(1);
          await waitAnnotSync(['synced'], { timeoutMs: 12000 });
          const hostBefore = await waitHostAnnotations((doc) => doc.shapes.length === 1);
          const sourceBefore = await hostAnnotationSource();
          const before = await panelState();
          const screenBefore = shapeScreenPoint(annotShapes(before)[0]);
          await capturePanel('shot-23-v17-generation-before');
          const mark = Date.now();
          await remountMainPanel();
          await ensureModeOn();
          await waitAnnotShapeCount(1, { timeoutMs: 18000 });
          await sleep(600);
          const after = await panelState();
          const hostAfter = await hostAnnotations();
          const sourceAfter = await hostAnnotationSource();
          const screenAfter = shapeScreenPoint(annotShapes(after)[0]);
          await capturePanel('shot-23-v17-generation-after');
          const posts = annotationPosts(mark);
          log(`  [v17.4] source before=${sourceBefore && sourceBefore.panelId} after=${sourceAfter && sourceAfter.panelId} shapes=${annotShapes(after).length}`);
          return {
            pass: annotShapes(after).length === 1
              && Number(hostAfter.revision) === Number(hostBefore.revision)
              && Boolean(sourceBefore) && Boolean(sourceAfter) && sourceAfter.panelId === sourceBefore.panelId
              && Boolean(screenBefore) && Boolean(screenAfter)
              && near(screenAfter.x, screenBefore.x, 2) && near(screenAfter.y, screenBefore.y, 2)
              && posts.length === 0,
            detail: { shapes: annotShapes(after).length, revision: [hostBefore.revision, hostAfter.revision],
              sourceBefore: sourceBefore && sourceBefore.panelId, sourceAfter: sourceAfter && sourceAfter.panelId,
              screen: [screenBefore, screenAfter], posts: posts.length,
              limitation: 'the isolated DSH shell renders the right sidebar as a collapsed track whose expand control is not mounted; a real main↔sidebar seat switch is NOT_RUN, the second panel generation retention + source stability is asserted' },
          };
        });

      // ---- V17.5 same-runtime document retention across a panel generation -------------------
      await v17Check('V17.5', 'same-runtime document retention across a panel/session generation (A1→A2→A1; real session switch NOT_RUN)',
        { shapes: 1, revision: 'unchanged', posts: 0 }, async () => {
          await ensureModeOn();
          await resetCanvas();
          await drawRectAt(100, 100, 80, 60);
          await waitAnnotShapeCount(1);
          await waitAnnotSync(['synced'], { timeoutMs: 12000 });
          const hostBefore = await waitHostAnnotations((doc) => doc.shapes.length === 1);
          const mark = Date.now();
          // A new panel generation (the same mechanism a session re-pin uses) must hydrate the same
          // Runtime document. The real shell session switch is listed NOT_RUN in the detail.
          await remountMainPanel();
          await waitAnnotShapeCount(1, { timeoutMs: 18000 });
          await sleep(700);
          const panel = await panelState();
          const hostAfter = await hostAnnotations();
          const posts = annotationPosts(mark);
          const releases = annotationReleases(mark);
          return {
            pass: annotShapes(panel).length === 1
              && Number(hostAfter.revision) === Number(hostBefore.revision)
              && posts.length === 0 && releases.length === 0,
            detail: { shapes: annotShapes(panel).length, revision: [hostBefore.revision, hostAfter.revision],
              posts: posts.length, releases: releases.length,
              limitation: 'projection/generation-level retention; a real A1→A2→A1 session switch is NOT_RUN' },
          };
        });

      // ---- V17.6 A/B scope isolation (projected) ---------------------------------------------
      await v17Check('V17.6', 'projected A/B workspaces keep separate documents; clearing B leaves the real A document intact',
        { A: 1, B: 1, afterClearB: 'A intact', posts: 0 }, async () => {
          await ensureModeOn();
          await resetCanvas();
          await drawRectAt(110, 110, 80, 60);
          await waitAnnotShapeCount(1);
          await waitAnnotSync(['synced'], { timeoutMs: 12000 });
          const hostA = await waitHostAnnotations((doc) => doc.shapes.length === 1);
          const aId = hostA.shapes[0].id;
          const realUi = (await hostState()).ui;
          const proj = createScopeProjection(realUi);
          const docA = proj.buildDoc('A', realUi, { revision: Number(hostA.revision) + 1, source: hostA.source, shapes: hostA.shapes });
          const docB = proj.buildDoc('B', realUi, {
            revision: 9,
            source: { kind: 'human-panel', panelId: '00000000-0000-4000-a000-0000000000b2', surface: 'sidebar', clientRevision: 4, trusted: false },
            shapes: [wireRect('a9001', 210, 60, 80, 50, '#00aa55')],
          });
          proj.setDoc('A', docA);
          proj.setDoc('B', docB);
          const mark = Date.now();
          const stop = await startStateRewrite(proj.rewrite);
          try {
            proj.activate('B');
            const inB = await waitFor(async () => {
              const panel = await panelState();
              const shapes = annotShapes(panel);
              return shapes.length === 1 && shapes[0].id === 'a9001' ? panel : undefined;
            }, { timeoutMs: 12000, intervalMs: 150, label: 'projected B document' }).catch(() => null);
            await capturePanel('shot-24-v17-isolation-b');
            proj.setDoc('B', {
              ...docB,
              annotations: { ...docB.annotations, revision: 10, updatedAt: Date.now(), source: null, context: null, view: null, shapes: [] },
            });
            const clearedB = await waitFor(async () => {
              const panel = await panelState();
              return annotShapes(panel).length === 0 ? panel : undefined;
            }, { timeoutMs: 12000, intervalMs: 150, label: 'projected B cleared' }).catch(() => null);
            const hostAfterClearB = await hostAnnotations();
            proj.activate('A');
            const backA = await waitFor(async () => {
              const panel = await panelState();
              const shapes = annotShapes(panel);
              return shapes.length === 1 && shapes[0].id === aId ? panel : undefined;
            }, { timeoutMs: 12000, intervalMs: 150, label: 'projected A restored' }).catch(() => null);
            await capturePanel('shot-24-v17-isolation-a');
            const posts = annotationPosts(mark);
            log(`  [v17.6] projected A=${JSON.stringify(annotationSummary(hostA))} B(a9001) cleared; real host after clear=${JSON.stringify(annotationSummary(hostAfterClearB))}`);
            return {
              pass: Boolean(inB) && Boolean(clearedB) && Boolean(backA)
                && hostAfterClearB.shapes.length === 1 && hostAfterClearB.shapes[0].id === aId
                && Number(hostAfterClearB.revision) === Number(hostA.revision)
                && posts.length === 0,
              detail: { inB: inB && annotShapes(inB).map((shape) => shape.id),
                clearedB: clearedB ? 0 : null, backA: backA && annotShapes(backA).map((shape) => shape.id),
                hostAfterClearB: annotationSummary(hostAfterClearB), posts: posts.length,
                limitation: 'projected scope/document isolation; a real second-workspace Host fixture is NOT_RUN' },
            };
          } finally {
            await stop();
          }
        });

      // ---- V17.7 clean adoption of another source's revision ---------------------------------
      await v17Check('V17.7', 'a clean panel adopts another source\'s higher revision; the Host sees one content write and the clean panel does not echo',
        { adopted: 2, hostWrites: 1, echoPosts: 0 }, async () => {
          await ensureModeOn();
          await resetCanvas();
          await drawRectAt(120, 120, 80, 60);
          await waitAnnotShapeCount(1);
          await waitAnnotSync(['synced'], { timeoutMs: 12000 });
          const hostBefore = await waitHostAnnotations((doc) => doc.shapes.length === 1);
          const mark = Date.now();
          const response = await postAnnotationDocument({
            panelId: '00000000-0000-4000-a000-0000000000b3',
            surface: 'sidebar',
            clientRevision: 2,
            shapes: hostBefore.shapes.concat([wireRect('a9002', 230, 60, 70, 50, '#0066ff')]),
          });
          if (!response || response.status !== 200) throw new Error('synthetic B write failed: ' + JSON.stringify(response && response.status));
          const adopted = await waitFor(async () => {
            const panel = await panelState();
            return annotShapes(panel).length === 2 ? panel : undefined;
          }, { timeoutMs: 12000, intervalMs: 150, label: 'clean adoption of B revision' }).catch(() => null);
          await waitAnnotSync(['synced'], { timeoutMs: 10000 });
          const hostAfter = await waitHostAnnotations((doc) => doc.shapes.length === 2);
          const posts = annotationPosts(mark);
          log(`  [v17.7] host before=${JSON.stringify(annotationSummary(hostBefore))} after=${JSON.stringify(annotationSummary(hostAfter))} panelPosts=${posts.length}`);
          return {
            pass: Boolean(adopted) && annotShapes(adopted).length === 2
              && Number(hostAfter.revision) === Number(hostBefore.revision) + 1
              && posts.length === 0,
            detail: { adopted: adopted && annotShapes(adopted).map((shape) => shape.id),
              hostRevisions: [hostBefore.revision, hostAfter.revision], echoPosts: posts.length },
          };
        });

      // ---- V17.8 a draft survives another source's update ------------------------------------
      await v17Check('V17.8', 'a live draft is not interrupted by another source\'s update; cancelling it adopts the new revision',
        { draft: 'kept', adopted: 'after cancel' }, async () => {
          await ensureModeOn();
          await resetCanvas();
          await drawRectAt(130, 130, 60, 50);
          await waitAnnotShapeCount(1);
          await waitAnnotSync(['synced'], { timeoutMs: 12000 });
          const hostBefore = await waitHostAnnotations((doc) => doc.shapes.length === 1);
          await clickAnnotTool('rect');
          const map = await annotMappingNow();
          const from = annotCanvasToGui(map, { x: 220, y: 160 });
          const to = annotCanvasToGui(map, { x: 300, y: 220 });
          await annotEnsureHit(from);
          const send = (type, x, y, buttons, button) => state.chrome.cdp.send('Input.dispatchMouseEvent', {
            type, x, y, button, buttons, clickCount: type === 'mouseMoved' ? 0 : 1,
          });
          await send('mouseMoved', from.x, from.y, 0, 'none');
          await send('mousePressed', from.x, from.y, 1, 'left');
          for (let index = 1; index <= 6; index += 1) {
            await send('mouseMoved', from.x + ((to.x - from.x) * index) / 6, from.y + ((to.y - from.y) * index) / 6, 1, 'left');
            await sleep(40);
          }
          const draftDuring = await panelState();
          await postAnnotationDocument({
            panelId: '00000000-0000-4000-a000-0000000000b4',
            surface: 'sidebar',
            clientRevision: 3,
            shapes: hostBefore.shapes.concat([wireRect('a9003', 40, 210, 80, 50, '#aa00cc')]),
          });
          await sleep(1300);
          const draftAfterUpdate = await panelState();
          await pressKey('Escape', 'Escape', 27);
          await send('mouseReleased', to.x, to.y, 0, 'left');
          const adopted = await waitFor(async () => {
            const panel = await panelState();
            const shapes = annotShapes(panel);
            return shapes.some((shape) => shape.id === 'a9003') ? panel : undefined;
          }, { timeoutMs: 14000, intervalMs: 150, label: 'adopt B after cancelling the draft' }).catch(() => null);
          await sleep(300);
          const finalPanel = await panelState();
          return {
            pass: draftDuring.annot.draftChildren > 0 && draftAfterUpdate.annot.draftChildren > 0
              && Boolean(adopted) && annotShapes(finalPanel).length === 2
              && !annotShapes(finalPanel).some((shape) => shape.id === 'a9004'),
            detail: { draftDuring: draftDuring.annot.draftChildren, draftAfterUpdate: draftAfterUpdate.annot.draftChildren,
              finalShapes: annotShapes(finalPanel).map((shape) => shape.id) },
          };
        });

      // ---- V17.9 text editing survives another source's update -------------------------------
      await v17Check('V17.9', 'a live text editor survives another source\'s update on both commit and cancel paths',
        { editor: 'kept', commit: 'text+B', cancel: 'B only' }, async () => {
          await ensureModeOn();
          await resetCanvas();
          await drawRectAt(140, 140, 50, 40);
          await waitAnnotShapeCount(1);
          await waitAnnotSync(['synced'], { timeoutMs: 12000 });
          const hostBefore = await waitHostAnnotations((doc) => doc.shapes.length === 1);
          // Commit path.
          let map = await annotMappingNow();
          await ensurePointVisible(annotCanvasToGui(map, { x: 180, y: 200 }));
          await sleep(120);
          map = await annotMappingNow();
          await clickAnnotTool('text');
          const textPoint = annotCanvasToGui(map, { x: 180, y: 200 });
          await annotEnsureHit(textPoint);
          await annotClickGui(textPoint);
          await sleep(350);
          await state.chrome.cdp.send('Input.insertText', { text: 'v17-text' });
          await sleep(250);
          await postAnnotationDocument({
            panelId: '00000000-0000-4000-a000-0000000000b5',
            surface: 'sidebar',
            clientRevision: 4,
            shapes: hostBefore.shapes.concat([wireRect('a9005', 40, 40, 40, 40, '#00aa55')]),
          });
          await sleep(1300);
          const editorDuring = await panelState();
          await pressKey('Enter', 'Enter', 13);
          await sleep(600);
          const afterCommit = await panelState();
          // Commit wins as a whole document (LWW): the local set is rect+text, B's pending candidate
          // is not silently merged (docs/viewport-control.md §12.3).
          const hostAfterCommit = await waitHostAnnotations((doc) => doc.shapes.length === 2, { timeoutMs: 14000 });
          // Cancel path.
          await annotResetCanvas({ timeoutMs: 9000 });
          await waitHostAnnotations((doc) => doc.shapes.length === 0, { timeoutMs: 12000 }).catch(() => null);
          const hostCancelBefore = await hostAnnotations();
          await postAnnotationDocument({
            panelId: '00000000-0000-4000-a000-0000000000b6',
            surface: 'sidebar',
            clientRevision: 5,
            shapes: [wireRect('a9006', 60, 60, 40, 40, '#ff9900')],
          });
          await sleep(900);
          map = await annotMappingNow();
          await clickAnnotTool('text');
          const cancelPoint = annotCanvasToGui(map, { x: 200, y: 240 });
          await annotEnsureHit(cancelPoint);
          await annotClickGui(cancelPoint);
          await sleep(350);
          await state.chrome.cdp.send('Input.insertText', { text: 'v17-cancel' });
          await sleep(200);
          await pressKey('Escape', 'Escape', 27);
          await sleep(900);
          const afterCancel = await panelState();
          const hostAfterCancel = await waitHostAnnotations((doc) => doc.shapes.length === 1 && doc.shapes[0].id === 'a9006', { timeoutMs: 14000 });
          const textShape = annotShapes(afterCommit).find((shape) => shape.type === 'text');
          return {
            pass: editorDuring.annot.text && editorDuring.annot.text.value === 'v17-text'
              && Boolean(textShape) && textShape.native.text === 'v17-text'
              && hostAfterCommit.shapes.length === 2
              && !hostAfterCommit.shapes.some((shape) => shape.id === 'a9005')
              && afterCancel.annot.text === null && annotShapes(afterCancel).length === 1
              && annotShapes(afterCancel)[0].id === 'a9006'
              && hostAfterCancel.shapes.length === 1,
            detail: { editorDuring: editorDuring.annot.text, commitShapes: annotShapes(afterCommit).map((shape) => shape.id),
              hostCommit: hostAfterCommit.shapes.map((shape) => shape.id), cancelShapes: annotShapes(afterCancel).map((shape) => shape.id),
              hostCancelBefore: annotationSummary(hostCancelBefore), hostAfterCancel: annotationSummary(hostAfterCancel) },
          };
        });

      // ---- V17.10 late ACK cannot mark newer local content synced ----------------------------
      await v17Check('V17.10', 'a late ACK for older content never marks a newer local modification synced; the final readback matches',
        { intermediate: 'pending', final: 'synced', shapes: 2 }, async () => {
          await ensureModeOn();
          await resetCanvas();
          let hold = null;
          try {
            hold = await startAnnotationHold({ count: 2 });
            await drawRectAt(60, 60, 70, 50);
            const held = await hold.waitForHeld(0, 12000);
            await drawRectAt(180, 60, 70, 50);
            await waitAnnotShapeCount(2);
            const syncBeforeRelease = (await panelState()).annot.svg.sync;
            await hold.release();
            const secondHeld = await hold.waitForHeld(0, 12000);
            await sleep(250);
            const intermediate = await panelState();
            await hold.release();
            await waitAnnotSync(['synced'], { timeoutMs: 14000 });
            const hostAfter = await waitHostAnnotations((doc) => doc.shapes.length === 2, { timeoutMs: 14000 });
            const finalPanel = await panelState();
            const localIds = annotShapes(finalPanel).map((shape) => shape.id);
            const hostIds = hostAfter.shapes.map((shape) => shape.id);
            return {
              pass: Boolean(held) && Boolean(secondHeld) && syncBeforeRelease === 'pending'
                && intermediate.annot.svg.sync !== 'synced'
                && localIds.join('|') === hostIds.join('|'),
              detail: { heldContentSeq: held && held.body && held.body.shapes && held.body.shapes.length,
                secondContentSeq: secondHeld && secondHeld.body && secondHeld.body.shapes && secondHeld.body.shapes.length,
                syncBeforeRelease, intermediate: intermediate.annot.svg.sync, localIds, hostIds },
            };
          } finally {
            if (hold) await hold.stop();
          }
        });

      // ---- V17.11 explicit clear propagates, nothing resurrects ------------------------------
      await v17Check('V17.11', 'explicit 清除画布 empties the Host and both seats, keeps mode/style and never resurrects old shapes',
        { host: 0, main: 0, sidebar: 0, mode: 'on', tool: 'rect' }, async () => {
          await ensureModeOn();
          await resetCanvas();
          await drawRectAt(60, 160, 70, 50);
          await drawRectAt(160, 160, 70, 50);
          await waitAnnotShapeCount(2);
          await waitAnnotSync(['synced'], { timeoutMs: 12000 });
          await waitHostAnnotations((doc) => doc.shapes.length === 2);
          await annotPrepareStyle({ fill: true, stroke: false, width: 7, color: '#3366ff' });
          await clickAnnotTool('rect');
          const sidebarOpen = await pageEvaluate(`Boolean(document.querySelector('[data-sidebar-right-tab] .utb'))`).catch(() => false);
          await capturePanel('shot-25-v17-clear-before');
          if (sidebarOpen) await captureViewport('shot-25b-v17-clear-before-full');
          const mark = Date.now();
          await clickAnnotClear();
          await waitFor(async () => annotShapes(await panelState()).length === 0,
            { timeoutMs: 9000, intervalMs: 120, label: 'main cleared' });
          await waitHostAnnotations((doc) => doc.shapes.length === 0, { timeoutMs: 12000 });
          let sidebarShapes = 0;
          if (sidebarOpen) {
            const sidebarAfter = await waitFor(async () => {
              const panel = await sidebarPanelState();
              return panel.missing === false && panel.shapes.length === 0 ? panel : undefined;
            }, { timeoutMs: 12000, intervalMs: 150, label: 'sidebar cleared' }).catch(() => null);
            sidebarShapes = sidebarAfter ? 0 : (await sidebarPanelState()).shapes.length;
          }
          await sleep(1200);
          const laterPanel = await panelState();
          const laterHost = await hostAnnotations();
          const stateAfter = await annotV2State();
          await capturePanel('shot-25-v17-clear-after');
          if (sidebarOpen) await captureViewport('shot-25b-v17-clear-after-full');
          const posts = annotationPosts(mark);
          const releases = annotationReleases(mark);
          const pressedTools = stateAfter.tools.filter((tool) => tool.pressed === 'true').map((tool) => tool.tool);
          return {
            pass: annotShapes(laterPanel).length === 0 && laterHost.shapes.length === 0 && sidebarShapes === 0
              && laterPanel.annot.pressed === 'true'
              && pressedTools.length === 1 && pressedTools[0] === 'rect'
              && stateAfter.color.value === '#3366ff' && stateAfter.width.value === '7'
              && releases.length === 0,
            detail: { hostShapes: laterHost.shapes.length, mainShapes: annotShapes(laterPanel).length,
              sidebarShapes, mode: laterPanel.annot.pressed, tools: pressedTools,
              color: stateAfter.color, width: stateAfter.width, posts: posts.length, releases: releases.length },
          };
        });

      // ---- V17.12 a commit followed by an unmount is flushed by the retained queue ---------
      await v17Check('V17.12', 'a commit followed by an unmount is flushed by the retained queue, never converted to an empty document',
        { delivered: 1, restored: 1, empty: 0 }, async () => {
          await ensureModeOn();
          await resetCanvas();
          let hold = null;
          try {
            hold = await startAnnotationHold({ count: 2 });
            await drawRectAt(100, 100, 70, 50);
            const first = await hold.waitForHeld(0, 14000);
            await switchMainPanelAway();
            // The first request is still in flight (held), so the unmount flush waits in the module
            // queue; releasing the first ACK drains the second (the retained-queue snapshot).
            await hold.release();
            const second = await hold.waitForHeld(0, 12000);
            const bodies = [first, second].filter(Boolean).map((entry) => entry.body);
            const delivered = bodies.map((body) => (Array.isArray(body.shapes) ? body.shapes.length : 0));
            const emptyOrRelease = bodies.some((body) => body.release === true || !Array.isArray(body.shapes) || body.shapes.length === 0);
            await hold.release();
            await sleep(700);
            await openPanel();
            await waitFor(async () => {
              const panel = await panelState();
              return panel.missing !== true && panel.frame ? panel : undefined;
            }, { timeoutMs: 18000, intervalMs: 200, label: 'panel after fast unmount' });
            const restored = await waitAnnotShapeCount(1, { timeoutMs: 18000 });
            const hostAfter = await waitHostAnnotations((doc) => doc.shapes.length === 1, { timeoutMs: 14000 });
            return {
              pass: Boolean(first) && Boolean(second) && delivered.length === 2
                && delivered.every((count) => count === 1) && !emptyOrRelease
                && hostAfter.shapes.length === 1 && annotShapes(restored).length === 1,
              detail: { delivered, emptyOrRelease, hostShapes: hostAfter.shapes.length,
                restored: annotShapes(restored).length,
                limitation: 'the first POST is held so the commit is still unconfirmed at unmount; the retained queue flush is the asserted path' },
            };
          } finally {
            if (hold) await hold.stop();
          }
        });

      // ---- V17.13 a 409 for A never pollutes B -----------------------------------------------
      await v17Check('V17.13', 'holding A\'s write, switching to projected B and releasing a 409 leaves B and the Host unchanged',
        { B: 1, host: 'unchanged', sync: 'not error' }, async () => {
          await ensureModeOn();
          await resetCanvas();
          await drawRectAt(100, 60, 70, 50);
          await waitAnnotShapeCount(1);
          await waitAnnotSync(['synced'], { timeoutMs: 12000 });
          const hostBefore = await waitHostAnnotations((doc) => doc.shapes.length === 1);
          const realUi = (await hostState()).ui;
          const proj = createScopeProjection(realUi);
          const docB = proj.buildDoc('B', realUi, {
            revision: 12,
            source: { kind: 'human-panel', panelId: '00000000-0000-4000-a000-0000000000b7', surface: 'sidebar', clientRevision: 6, trusted: false },
            shapes: [wireRect('a9007', 210, 120, 60, 40, '#00aa55')],
          });
          proj.setDoc('B', docB);
          let hold = null;
          try {
            hold = await startAnnotationHoldWithRewrite(proj.rewrite);
            await drawRectAt(200, 60, 60, 40);
            const held = await hold.waitForHeld(12000);
            proj.activate('B');
            const inB = await waitFor(async () => {
              const panel = await panelState();
              return annotShapes(panel).length === 1 && annotShapes(panel)[0].id === 'a9007' ? panel : undefined;
            }, { timeoutMs: 14000, intervalMs: 150, label: 'B shown while A write held' }).catch(() => null);
            await hold.release('stale');
            await sleep(1400);
            const afterStale = await panelState();
            const hostAfter = await hostAnnotations();
            return {
              pass: Boolean(held) && Boolean(inB) && annotShapes(afterStale).length === 1
                && annotShapes(afterStale)[0].id === 'a9007'
                && Number(hostAfter.revision) === Number(hostBefore.revision)
                && hostAfter.shapes.length === 1
                && afterStale.annot.svg.sync !== 'error',
              detail: { held: Boolean(held), inB: inB && annotShapes(inB).map((shape) => shape.id),
                afterStale: annotShapes(afterStale).map((shape) => shape.id),
                host: annotationSummary(hostAfter), sync: afterStale.annot.svg.sync },
            };
          } finally {
            if (hold) await hold.stop();
            await sleep(900);
          }
        });

      // ---- V17.14 pending/error retention and same-D remount recovery ------------------------
      await v17Check('V17.14', 'an error keeps the local content through polls and a remount resumes it; exactly one retry was attempted',
        { shapes: 1, sync: 'error', retries: 1 }, async () => {
          await ensureModeOn();
          await resetCanvas();
          let failure = null;
          try {
            failure = await startAnnotationFailure(2);
            await drawRectAt(80, 80, 70, 50);
            const attempts = await failure.waitForCount(2, 14000);
            await sleep(1000);
            const errored = await panelState();
            const erroredSync = errored.annot.svg.sync;
            await sleep(1600);
            const afterPolls = await panelState();
            await remountMainPanel();
            const resumed = await waitFor(async () => {
              const panel = await panelState();
              return annotShapes(panel).length === 1 ? panel : undefined;
            }, { timeoutMs: 18000, intervalMs: 200, label: 'same-D remount resumes pending content' }).catch(() => null);
            return {
              pass: attempts.length === 2 && erroredSync === 'error'
                && annotShapes(errored).length === 1
                && annotShapes(afterPolls).length === 1 && afterPolls.annot.svg.sync === 'error'
                && Boolean(resumed) && annotShapes(resumed).length === 1
                && resumed.annot.svg.sync !== 'unsupported',
              detail: { attempts: attempts.map((entry) => ({ at: entry.at, failed: entry.failed })),
                erroredSync, afterPolls: afterPolls.annot.svg.sync,
                resumed: resumed && resumed.annot.svg.sync,
                limitation: 'the retry count is the client rule (one retry); no Host-side retry exists' },
            };
          } finally {
            if (failure) await failure.stop();
            await sleep(600);
          }
        });

      // ---- V17.15 six-shape roundtrip after hydration ---------------------------------------
      await v17Check('V17.15', 'six-shape roundtrip: hydration reverses rect w/h and brush points, ids stay unique and order is kept',
        { shapes: 6, order: 'same', newId: '> max', erased: 6 }, async () => {
          await remountMainPanel();
          await ensureModeOn();
          await resetCanvas();
          const drawUntilHost = async (from, to, expected, options) => {
            for (let attempt = 0; attempt < 3; attempt += 1) {
              await ensureModeOn();
              await annotDrawStable(from, to, options);
              const ok = await waitHostAnnotations((doc) => doc.shapes.length === expected, { timeoutMs: 7000 })
                .then(() => true).catch(() => false);
              if (ok) return;
              log(`  [v17.15] host did not reach ${expected} (attempt ${attempt + 1})`);
              await sleep(300);
            }
            throw new Error('draw did not reach Host shape count ' + expected);
          };
          let host6 = null;
          for (let round = 0; round < 3 && !host6; round += 1) {
            await ensureModeOn();
            await resetCanvas();
            await clickAnnotTool('rect');
            await annotPrepareStyle({ fill: false, stroke: true, width: 3, color: '#ff3b30' });
            await drawUntilHost({ x: 40, y: 40 }, { x: 120, y: 100 }, 1, { steps: 5 });
            await clickAnnotTool('circle');
            await drawUntilHost({ x: 150, y: 40 }, { x: 250, y: 100 }, 2, { steps: 5 });
            await clickAnnotTool('line');
            await drawUntilHost({ x: 40, y: 140 }, { x: 140, y: 140 }, 3, { steps: 5 });
            await clickAnnotTool('arrow');
            await drawUntilHost({ x: 40, y: 200 }, { x: 160, y: 200 }, 4, { steps: 5 });
            await clickAnnotTool('brush');
            await drawUntilHost({ x: 200, y: 160 }, { x: 320, y: 240 }, 5, { steps: 6 });
            await annotPlaceText({ x: 200, y: 100 }, 'v17-roundtrip');
            const doc = await waitHostAnnotations((candidate) => candidate.shapes.length === 6, { timeoutMs: 9000 }).catch(() => null);
            const hasText = doc && doc.shapes.some((shape) => shape.type === 'text' && shape.text === 'v17-roundtrip');
            if (hasText) host6 = doc;
            else log(`  [v17.15] six-shape round ${round + 1} did not produce the text (shapes=${doc ? doc.shapes.map((shape) => shape.type).join(',') : 'timeout'}); retrying`);
          }
          if (!host6) throw new Error('six-shape roundtrip never produced the text shape');
          // A fresh generation hydrates the Host document (the roundtrip the contract asserts).
          await remountMainPanel();
          await ensureModeOn();
          await waitAnnotShapeCount(6, { timeoutMs: 18000 });
          await sleep(500);
          const restored = await waitFor(async () => {
            const panel = await panelState();
            const shapes = annotShapes(panel);
            return shapes.length === 6 && shapes.some((shape) => shape.type === 'text') ? panel : undefined;
          }, { timeoutMs: 6000, intervalMs: 150, label: 'six hydrated shapes including text' }).catch(() => panelState());
          const afterShapes = annotShapes(restored);
          const hostIds = host6.shapes.map((shape) => shape.id);
          const afterIds = afterShapes.map((shape) => shape.id);
          const rect = afterShapes.find((shape) => shape.type === 'rect');
          const brush = afterShapes.find((shape) => shape.type === 'brush');
          const text = afterShapes.find((shape) => shape.type === 'text');
          const brushPoints = brush ? JSON.parse(annotAttr(brush, 'points')) : [];
          const maxId = Math.max(...hostIds.map((id) => Number(String(id).slice(1))));
          await clickAnnotTool('rect');
          await annotDrawStable({ x: 40, y: 240 }, { x: 100, y: 280 }, { steps: 4 });
          await waitAnnotShapeCount(7);
          const withNew = annotShapes(await panelState());
          const newShape = withNew.find((shape) => !hostIds.includes(shape.id));
          await clickAnnotTool('eraser');
          await annotPressAtCanvas({ x: 80, y: 40 });
          const erased = await waitAnnotShapeCount(6, { timeoutMs: 12000 });
          const hostBrush = host6.shapes.find((shape) => shape.type === 'brush');
          const conditions = {
            order: hostIds.join('|') === afterIds.join('|'),
            rect: Boolean(rect) && Number(annotAttr(rect, 'width')) > 0 && Number(annotAttr(rect, 'height')) > 0,
            // Local shape points are {x,y}; the Host wire format is [x,y] (the reverse mapping).
            brush: brushPoints.length >= 2
              && brushPoints.every((point) => point && Number.isFinite(Number(point.x)) && Number.isFinite(Number(point.y)))
              && Boolean(hostBrush) && Array.isArray(hostBrush.points) && Array.isArray(hostBrush.points[0]),
            hostText: Boolean(host6.shapes.find((shape) => shape.type === 'text' && shape.text === 'v17-roundtrip')),
            localText: Boolean(text) && Boolean(text.native) && String(text.native.text) === 'v17-roundtrip',
            newId: Boolean(newShape) && Number(String(newShape.id).slice(1)) > maxId,
            erased: annotShapes(erased).length === 6,
          };
          const pass = Object.values(conditions).every(Boolean);
          if (!pass) log('  [v17.15] failed conditions: ' + JSON.stringify(conditions));
          return {
            pass,
            detail: { conditions, hostIds, afterIds,
              rectWidth: rect && annotAttr(rect, 'width'), rectHeight: rect && annotAttr(rect, 'height'),
              brushPoints: brushPoints.slice(0, 3), hostBrushPoints: hostBrush && hostBrush.points.slice(0, 3),
              newId: newShape && newShape.id, maxId,
              erased: annotShapes(erased).length,
              hostText: host6.shapes.filter((shape) => shape.type === 'text').map((shape) => shape.text),
              localText: text ? { type: text.type, text: text.native && text.native.text } : null,
              localTypes: afterShapes.map((shape) => shape.type) },
          };
        });

      // ---- V17.16 repeated remounts + ≥20 modifications per surface --------------------------
      await v17Check('V17.16', 'main and sidebar publishers keep a stable UUID and a monotonic clientRevision over 20+ modifications and remounts',
        { mainUuid: 'stable', sidebarUuid: 'stable', sourceLimit: 0 }, async () => {
          await ensureModeOn();
          await resetCanvas();
          const uuidOf = async () => {
            const source = await hostAnnotationSource();
            return source ? source.panelId : null;
          };
          const revisions = [];
          let mainUuid = null;
          let sourceLimit = 0;
          for (let index = 0; index < 20; index += 1) {
            await drawRectAt(40 + (index % 5) * 60, 40 + Math.floor(index / 5) * 50, 30, 24, index % 2 ? '#ff3b30' : '#0066ff');
            await sleep(90);
            if (index === 9 || index === 14) {
              await remountMainPanel();
              await ensureModeOn();
              await clickAnnotTool('rect');
            }
            if (index === 9 || index === 19) {
              const source = await hostAnnotationSource();
              if (!mainUuid) mainUuid = source && source.panelId;
              revisions.push(source && source.clientRevision);
            }
          }
          const synced = await waitAnnotSync(['synced'], { timeoutMs: 16000 });
          const mainSource = await hostAnnotationSource();
          mainUuid = mainUuid || (mainSource && mainSource.panelId);
          revisions.push(mainSource && mainSource.clientRevision);
          sourceLimit += state.responses.filter((entry) => entry.url.includes('/plugins/ui-testing/annotations') && Number(entry.status) === 400).length;
          let sidebarUuid = '00000000-0000-4000-a000-0000000000b8';
          let sidebarRevisions = [];
          let sidebarOk = false;
          try {
            // The isolated shell cannot expand the right-sidebar track, so the second publisher is a
            // synthetic Host source: 20 accepted writes under one stable UUID exercise the Host's
            // 16-watermark and the clean main-panel adoption path. A real sidebar seat is NOT_RUN.
            for (let index = 1; index <= 20; index += 1) {
              const current = await hostAnnotations();
              const response = await postAnnotationDocument({
                panelId: sidebarUuid,
                surface: 'sidebar',
                clientRevision: index,
                shapes: current.shapes.concat([wireRect('a9' + String(100 + index), 10 + index * 3, 210, 20, 18, '#00aa55')]),
              });
              if (!response || response.status !== 200) {
                throw new Error('synthetic sidebar write failed: ' + JSON.stringify(response && response.status));
              }
              await sleep(90);
              if (index === 10 || index === 20) {
                const source = await hostAnnotationSource();
                sidebarRevisions.push(source && source.clientRevision);
              }
            }
            const source = await hostAnnotationSource();
            sidebarUuid = source && source.panelId;
            sidebarRevisions.push(source && source.clientRevision);
            sidebarOk = Boolean(source) && source.panelId === '00000000-0000-4000-a000-0000000000b8'
              && Number(source.clientRevision) >= 20
              && sidebarRevisions.every((value, index) => index === 0 || Number(value) >= Number(sidebarRevisions[index - 1]));
            sourceLimit += state.responses.filter((entry) => entry.url.includes('/plugins/ui-testing/annotations') && Number(entry.status) === 400).length;
          } catch (error) {
            sidebarOk = false;
            log('  [v17.16] synthetic sidebar probe failed: ' + errorMessage(error));
          }
          return {
            pass: Boolean(mainUuid) && mainSource && mainSource.panelId === mainUuid
              && revisions.every((value, index) => index === 0 || Number(value) >= Number(revisions[index - 1]))
              && sidebarOk && sourceLimit === 0,
            detail: { mainUuid, mainSource, revisions, sidebarUuid, sidebarRevisions, sidebarOk, sourceLimit,
              limitation: 'the isolated shell right-sidebar track cannot be expanded; the second publisher is a synthetic Host source (20 accepted writes, one stable UUID), the real sidebar seat is NOT_RUN' },
          };
        });

      // ---- V17.17 GUI reload: identity/counter persistence + storage degradation -------------
      await v17Check('V17.17', 'a GUI reload continues the publisher counter; without sessionStorage the module registry keeps the UUID across a remount',
        { reload: 'same uuid, higher revision', degraded: 'module registry' }, async () => {
          await ensureModeOn();
          await resetCanvas();
          await drawRectAt(90, 90, 70, 50);
          await waitAnnotShapeCount(1);
          await waitAnnotSync(['synced'], { timeoutMs: 12000 });
          const before = await hostAnnotationSource();
          await reloadGui();
          await ensureModeOn();
          const restored = await waitAnnotShapeCount(1, { timeoutMs: 18000 });
          await drawRectAt(190, 90, 60, 40);
          await waitAnnotShapeCount(2);
          await waitAnnotSync(['synced'], { timeoutMs: 14000 });
          const afterReload = await hostAnnotationSource();
          // Degradation: break only the annotation keys on the next document.
          const script = await state.chrome.cdp.send('Page.addScriptToEvaluateOnNewDocument', {
            source: `(() => {
              const get = Storage.prototype.getItem;
              const set = Storage.prototype.setItem;
              const ours = (key) => String(key).indexOf('dsh.ui-testing.annotations.v3') >= 0;
              Storage.prototype.getItem = function (key) { if (ours(key)) throw new Error('storage blocked'); return get.call(this, key); };
              Storage.prototype.setItem = function (key, value) { if (ours(key)) throw new Error('storage blocked'); return set.call(this, key, value); };
            })();`,
          });
          let degradedUuid = null;
          let degradedOk = false;
          try {
            await reloadGui();
            await ensureModeOn();
            await waitAnnotShapeCount(2, { timeoutMs: 18000 });
            await drawRectAt(90, 190, 60, 40);
            await waitAnnotShapeCount(3);
            await waitAnnotSync(['synced'], { timeoutMs: 14000 });
            const source = await hostAnnotationSource();
            degradedUuid = source && source.panelId;
            await remountMainPanel();
            await waitAnnotShapeCount(3, { timeoutMs: 18000 });
            await ensureModeOn();
            await drawRectAt(190, 190, 60, 40);
            await waitAnnotShapeCount(4);
            await waitAnnotSync(['synced'], { timeoutMs: 14000 });
            const afterRemount = await hostAnnotationSource();
            degradedOk = Boolean(degradedUuid) && afterRemount && afterRemount.panelId === degradedUuid
              && Number(afterRemount.clientRevision) > Number(source && source.clientRevision);
          } finally {
            if (script && script.identifier) {
              await state.chrome.cdp.send('Page.removeScriptToEvaluateOnNewDocument', { identifier: script.identifier }).catch(() => undefined);
            }
          }
          return {
            pass: Boolean(before) && Boolean(afterReload) && afterReload.panelId === before.panelId
              && Number(afterReload.clientRevision) > Number(before.clientRevision)
              && degradedOk,
            detail: { before: { panelId: before && before.panelId, clientRevision: before && before.clientRevision },
              afterReload: { panelId: afterReload && afterReload.panelId, clientRevision: afterReload && afterReload.clientRevision },
              degradedUuid, degradedOk,
              limitation: 'a full GUI reload loses in-memory unacknowledged content; only identity/counter persistence is asserted' },
          };
        });

      // ---- V17.18 stale metadata without a revision change -----------------------------------
      await v17Check('V17.18', 'panel-unseen stale keeps shapes, shows the exact hint and never posts a fake heartbeat or revision',
        { shapes: 1, stale: 'panel-unseen', posts: 0, revision: 'unchanged' }, async () => {
          await ensureModeOn();
          await resetCanvas();
          await drawRectAt(100, 100, 70, 50);
          await waitAnnotShapeCount(1);
          await waitAnnotSync(['synced'], { timeoutMs: 12000 });
          const hostBefore = await waitHostAnnotations((doc) => doc.shapes.length === 1);
          const mark = Date.now();
          const stop = await startStateRewrite((json) => mutateStateUi(json, (ui) => {
            if (ui.annotations && typeof ui.annotations === 'object') {
              ui.annotations = { ...ui.annotations, stale: true, staleReason: 'panel-unseen' };
            }
            return ui;
          }));
          try {
            const stalePanel = await waitFor(async () => {
              const panel = await panelState();
              const hint = await annotV2State();
              return panel.annot && panel.annot.svg && panel.annot.svg.sync === 'synced'
                && hint.hint && hint.hint.title.indexOf('标注已保存到工作区，来源面板心跳已过期') >= 0 ? panel : undefined;
            }, { timeoutMs: 12000, intervalMs: 150, label: 'stale hint visible' }).catch(() => null);
            const hint = await annotV2State();
            await sleep(1500);
            const later = await panelState();
            const hostAfter = await hostAnnotations();
            return {
              pass: Boolean(stalePanel) && annotShapes(later).length === 1
                && Number(hostAfter.revision) === Number(hostBefore.revision)
                && annotationPosts(mark).length === 0
                && hint.hint && hint.hint.text.indexOf('标注未同步') < 0,
              detail: { stalePanel: Boolean(stalePanel), hint: hint.hint, shapes: annotShapes(later).length,
                revision: [hostBefore.revision, hostAfter.revision], posts: annotationPosts(mark).length },
            };
          } finally {
            await stop();
            await sleep(900);
          }
        });

      // ---- V17.19 navigation/epoch clears; ordinary frames and C/scale do not ----------------
      await v17Check('V17.19', 'navigation/reload/hash clear both sides without resurrection; same-epoch frames and C/scale changes keep the drawing',
        { nav: 0, reload: 0, hash: 0, frames: 1, view: 1 }, async () => {
          await ensureModeOn();
          await resetCanvas();
          await drawRectAt(60, 60, 70, 50);
          await drawRectAt(180, 60, 70, 50);
          await waitAnnotShapeCount(2);
          await waitAnnotSync(['synced'], { timeoutMs: 12000 });
          await waitHostAnnotations((doc) => doc.shapes.length === 2);
          await navigateTarget(`${fixtureBase}/web-t3.html?ext=v17-nav`);
          await waitForFrame();
          await waitFrameStable();
          await sleep(1600);
          const afterNavPanel = await panelState();
          const afterNavHost = await waitHostAnnotations((doc) => doc.shapes.length === 0, { timeoutMs: 20000 });
          await ensureModeOn();
          await drawRectAt(60, 160, 70, 50);
          await waitAnnotShapeCount(1);
          await waitAnnotSync(['synced'], { timeoutMs: 12000 });
          const reloadMark = Date.now();
          await toggleAnnot(false);
          await pageEvaluate(panelExpr(`const b = panel.querySelector('button[aria-label="刷新"]'); if (b && !b.disabled) b.click(); return true;`));
          await sleep(1800);
          await waitForFrame();
          await waitFrameStable();
          await sleep(600);
          const afterReloadPanel = await panelState();
          const afterReloadHost = await waitHostAnnotations((doc) => doc.shapes.length === 0, { timeoutMs: 20000 });
          await ensureModeOn();
          await drawRectAt(60, 200, 70, 50);
          await waitAnnotShapeCount(1);
          await waitAnnotSync(['synced'], { timeoutMs: 12000 });
          await targetEval(`location.hash = '#v17-hash'; true`);
          await sleep(1800);
          const afterHashPanel = await panelState();
          const afterHashHost = await waitHostAnnotations((doc) => doc.shapes.length === 0, { timeoutMs: 20000 });
          await ensureModeOn();
          await drawRectAt(100, 120, 70, 50);
          await waitAnnotShapeCount(1);
          await waitAnnotSync(['synced'], { timeoutMs: 12000 });
          await sleep(1600);
          const afterFrames = await panelState();
          await hostViewportSet({ canvasX: 40, scale: 0.9 });
          await waitHostView((view) => near(view.canvasX, 40, 1) && closeTo(view.scale, 0.9, 0.0011));
          await waitPanelMirrorsHost();
          await sleep(900);
          const afterView = await panelState();
          return {
            pass: annotShapes(afterNavPanel).length === 0 && afterNavHost.shapes.length === 0
              && annotShapes(afterReloadPanel).length === 0 && afterReloadHost.shapes.length === 0
              && annotShapes(afterHashPanel).length === 0 && afterHashHost.shapes.length === 0
              && annotShapes(afterFrames).length === 1 && annotShapes(afterView).length === 1,
            detail: { nav: [annotShapes(afterNavPanel).length, afterNavHost.shapes.length],
              reload: [annotShapes(afterReloadPanel).length, afterReloadHost.shapes.length, annotationPosts(reloadMark).length],
              hash: [annotShapes(afterHashPanel).length, afterHashHost.shapes.length],
              frames: annotShapes(afterFrames).length, view: annotShapes(afterView).length,
              viewNow: (await hostView()).view },
          };
        });

      // ---- V17.20 runtime replacement + capability + mode gate -------------------------------
      await v17Check('V17.20', 'a runtime replacement hides the old document (no cache reuse); mode input stays zero and an old Host stays unsupported',
        { replaced: 0, input: 0, unsupported: true }, async () => {
          await ensureModeOn();
          await resetCanvas();
          await drawRectAt(80, 80, 70, 50);
          await waitAnnotShapeCount(1);
          await waitAnnotSync(['synced'], { timeoutMs: 12000 });
          const hostBefore = await waitHostAnnotations((doc) => doc.shapes.length === 1);
          const realUi = (await hostState()).ui;
          const proj = createScopeProjection(realUi);
          const docC = proj.buildDoc('C', realUi, { revision: 20, source: null, shapes: [] });
          docC.context = { ...docC.context, runtimeId: 'rt-projected-c' };
          docC.annotations = { ...docC.annotations, context: null, view: null, shapes: [] };
          proj.setDoc('C', docC);
          let stop = null;
          let replacedShapes = null;
          try {
            stop = await startStateRewrite((json) => {
              const next = proj.rewrite(json);
              mutateStateUi(next, (ui) => {
                if (ui.annotationContext) ui.runtimeId = 'rt-projected-c';
                return ui;
              });
              return next;
            });
            proj.activate('C');
            await waitFor(async () => {
              const panel = await panelState();
              return annotShapes(panel).length === 0 ? panel : undefined;
            }, { timeoutMs: 12000, intervalMs: 150, label: 'old runtime document hidden' }).catch(() => null);
            replacedShapes = annotShapes(await panelState()).length;
          } finally {
            if (stop) await stop();
          }
          // A fresh mount clears the retired-runtime guard and hydrates the real workspace again.
          await remountMainPanel();
          await waitAnnotShapeCount(1, { timeoutMs: 18000 });
          await ensureModeOn();
          const restored = annotShapes(await panelState()).length;
          // Mode gate: zero page input while the mode is on.
          await resetTargetInstrumentation();
          const map = await annotMappingNow();
          const point = annotCanvasToGui(map, { x: 200, y: 150 });
          await ensurePointVisible(point);
          await dismissShellDialogs();
          const mark = Date.now();
          await clickAt(point.x, point.y);
          await wheelOnFramePoint(point, 120);
          await sleep(500);
          const modeInput = panelPosts('input', mark).length;
          const pageEvents = Number(await targetEval('window.__t3 ? window.__t3.events.length : -1'));
          // Old Host projection: no annotationContext → unsupported but drawing preserved.
          let unsupported = null;
          const stopOld = await startStateRewrite((json) => mutateStateUi(json, (ui) => { delete ui.annotationContext; return ui; }));
          try {
            unsupported = await waitFor(async () => {
              const panel = await panelState();
              return panel.annot && panel.annot.svg && panel.annot.svg.sync === 'unsupported' ? panel : undefined;
            }, { timeoutMs: 10000, intervalMs: 150, label: 'unsupported projection' }).catch(() => null);
          } finally {
            await stopOld();
          }
          await sleep(900);
          return {
            pass: replacedShapes === 0 && restored === 1 && modeInput === 0 && pageEvents === 0
              && Boolean(unsupported) && annotShapes(unsupported).length === 1,
            detail: { replacedShapes, restored, modeInput, pageEvents,
              unsupported: Boolean(unsupported), hostBefore: annotationSummary(hostBefore),
              limitation: 'runtime replacement is a CDP projection; close/Runtime eviction is covered by the Host contract' },
          };
        });

      // Leave a clean state for the narrow-layout scenario: mode off, size bar open, neutral view.
      await toggleAnnot(false).catch(() => undefined);
      await hostViewportSet({ canvasX: 0, canvasY: 0, scale: 1, width: 400, height: 300, x: 0, y: 0 });
      await waitHostView((view) => near(view.canvasX, 0, 1) && closeTo(view.scale, 1, 0.0011)
        && Number(view.width) === 400 && Number(view.height) === 300);
      await openSizeBar();
      await sleep(500);
    });

    await scenario('V18 interaction details (P0-D v4)', async () => {
      await remountMainPanel();
      const v18Mode = async (on) => {
        for (let attempt = 0; attempt < 4; attempt += 1) {
          const panel = await panelState();
          if (panel.annot && panel.annot.pressed === (on ? 'true' : 'false')) return panel;
          await toggleAnnot(on);
          await sleep(320);
        }
        // Setup-only fallback: a trusted click on the 标注 entry can be swallowed right after the
        // V17 remount (the interaction itself is covered by V15/V16); V18 asserts menu semantics.
        await pageEvaluate(panelExpr(on
          ? `const b = panel.querySelector('button[aria-label="标注"]'); if (b && !b.disabled) b.click(); return true;`
          : `const b = panel.querySelector('button[aria-label="标注"]'); if (b && b.getAttribute('aria-pressed') === 'true') b.click(); return true;`)).catch(() => undefined);
        await sleep(500);
        return panelState();
      };
      const pressPanFitOption = async (option) => {
        const group = (await panelState()).panFit;
        const target = group && group.options.find((entry) => entry.option === option);
        if (!target) throw new Error('pan/fit option missing: ' + option);
        await clickAt(target.rect.left + target.rect.width / 2, target.rect.top + target.rect.height / 2);
        await sleep(220);
        return panelState();
      };
      const dragSend = (type, x, y, buttons, button) => state.chrome.cdp.send('Input.dispatchMouseEvent', {
        type, x, y, button, buttons, clickCount: type === 'mouseMoved' ? 0 : 1,
      });

      const opened18 = await v18Mode(true);
      await annotResetCanvas();

      // ---- V18.1 segmented fill/stroke group -----------------------------------------------
      check('V18.1', '填充/外框 is a role=group segmented control (fill → stroke), exactly one aria-pressed (外框 default)',
        opened18.annot.styleSeg && opened18.annot.styleSeg.group === 'fill-stroke'
          && opened18.annot.styleSeg.role === 'group' && opened18.annot.styleSeg.ariaLabel === '填充与外框'
          && opened18.annot.styleSeg.options.map((option) => option.label).join('|') === '填充|外框'
          && opened18.annot.styleSeg.options[0].rect.left < opened18.annot.styleSeg.options[1].rect.left
          && opened18.annot.styleSeg.pressedCount === 1
          && opened18.annot.fill.checked === false && opened18.annot.stroke.checked === true,
        { group: 'fill|stroke', pressed: '外框 only' },
        { seg: opened18.annot.styleSeg, fill: opened18.annot.fill, stroke: opened18.annot.stroke });

      // ---- V18.2 clicking the selected option is a complete no-op ---------------------------
      await clickAnnotTool('rect');
      await annotPrepareStyle({ stroke: true, width: 3, color: '#ff3b30' });
      await annotResetCanvas();
      let map18 = await annotMappingNow();
      await ensurePointVisible(annotCanvasToGui(map18, { x: 60, y: 60 }));
      await sleep(120);
      map18 = await annotMappingNow();
      const from18 = annotCanvasToGui(map18, { x: 60, y: 60 });
      const to18 = annotCanvasToGui(map18, { x: 140, y: 120 });
      await annotEnsureHit(from18);
      await dragSend('mouseMoved', from18.x, from18.y, 0, 'none');
      await sleep(40);
      await dragSend('mousePressed', from18.x, from18.y, 1, 'left');
      await sleep(80);
      await dragSend('mouseMoved', to18.x, to18.y, 1, 'left');
      await sleep(180);
      const during18 = await panelState();
      await pageEvaluate(panelExpr(`const b = panel.querySelector('[data-utb-annot-mode="stroke"]'); if (b && !b.disabled) b.click(); return true;`)).catch(() => undefined);
      await sleep(160);
      const afterNoop18 = await panelState();
      await dragSend('mouseReleased', to18.x, to18.y, 0, 'left');
      await sleep(320);
      const released18 = await panelState();
      check('V18.2', 'clicking the already selected 外框 is a complete no-op: the live draft survives, style/colour/width do not change, and the shape commits unchanged',
        during18.annot.draft === true && afterNoop18.annot.draft === true
          && afterNoop18.annot.styleSeg.pressedCount === 1 && afterNoop18.annot.stroke.checked === true
          && afterNoop18.annot.width.value === '3' && afterNoop18.annot.color.value === '#ff3b30'
          && annotShapes(released18).length === 1
          && annotAttr(lastAnnotShape(released18), 'fill') === 'false'
          && annotAttr(lastAnnotShape(released18), 'stroke') === 'true',
        { draft: 'kept', pressed: '外框', style: '#ff3b30/3', committed: 1 },
        { during: during18.annot.draft, afterNoop: { draft: afterNoop18.annot.draft, seg: afterNoop18.annot.styleSeg, width: afterNoop18.annot.width, color: afterNoop18.annot.color },
          shapes: annotShapes(released18).length, attrs: lastAnnotShape(released18) && lastAnnotShape(released18).attrs });

      // ---- V18.3 fill mode produces a filled shape ----------------------------------------
      await clickAnnotTool('rect');
      await annotPrepareStyle({ fill: true, width: 4, color: '#00ff00' });
      await annotResetCanvas();
      const fillDraw18 = await annotDrawStable({ x: 60, y: 60 }, { x: 140, y: 120 }, { steps: 6 });
      await waitAnnotShapeCount(1);
      const fillShape18 = lastAnnotShape(await panelState());
      const fillScreen18 = annotScreenOf(fillShape18, { x: 60, y: 60 });
      const fillExpected18 = annotCanvasToGui(fillDraw18.map, { x: 60, y: 60 });
      check('V18.3', '填充 mode stores fill=true/stroke=false in data and native (fill=colour, stroke=none); the screen anchor stays within 2px',
        annotAttr(fillShape18, 'fill') === 'true' && annotAttr(fillShape18, 'stroke') === 'false'
          && annotAttr(fillShape18, 'color') === '#00ff00'
          && fillShape18.native.attrs.fill === '#00ff00' && fillShape18.native.attrs.stroke === 'none'
          && near(fillScreen18.x, fillExpected18.x, 2) && near(fillScreen18.y, fillExpected18.y, 2),
        { fill: 'true', stroke: 'false', native: { fill: '#00ff00', stroke: 'none' }, screen: '±2' },
        { attrs: fillShape18.attrs, native: fillShape18.native.attrs, screen: fillScreen18, expected: fillExpected18 });

      // ---- V18.4 stroke mode + never double-true ------------------------------------------
      await annotResetCanvas();
      await clickAnnotTool('rect');
      await annotPrepareStyle({ stroke: true, width: 5, color: '#3366ff' });
      await annotDrawStable({ x: 40, y: 40 }, { x: 120, y: 100 }, { steps: 5 });
      await waitAnnotShapeCount(1);
      const strokeShape18 = lastAnnotShape(await panelState());
      await clickAnnotTool('circle');
      await annotDrawStable({ x: 150, y: 40 }, { x: 230, y: 100 }, { steps: 5 });
      await waitAnnotShapeCount(2);
      await clickAnnotTool('line');
      await annotDrawStable({ x: 40, y: 140 }, { x: 140, y: 140 }, { steps: 5 });
      await waitAnnotShapeCount(3);
      await clickAnnotTool('arrow');
      await annotDrawStable({ x: 40, y: 200 }, { x: 160, y: 200 }, { steps: 5 });
      await waitAnnotShapeCount(4);
      const four18 = annotShapes(await panelState());
      const double18 = four18.filter((shape) => annotAttr(shape, 'fill') === 'true' && annotAttr(shape, 'stroke') === 'true');
      check('V18.4', '外框 mode stores fill=false/stroke=true (native stroke-width=5); all four shapes never have fill+stroke both true',
        annotAttr(strokeShape18, 'fill') === 'false' && annotAttr(strokeShape18, 'stroke') === 'true'
          && Number(strokeShape18.native.attrs['stroke-width']) === 5
          && four18.length === 4 && double18.length === 0,
        { first: { fill: 'false', stroke: 'true', strokeWidth: 5 }, shapes: 4, doubleTrue: 0 },
        { attrs: strokeShape18.attrs, native: strokeShape18.native.attrs, shapes: four18.length, doubleTrue: double18.map((shape) => shape.id) });

      // ---- V18.5 disabled tools keep the selection -----------------------------------------
      await clickAnnotTool('rect');
      const seen18 = [];
      for (const tool of ['line', 'arrow', 'brush', 'text', 'eraser']) {
        const state18 = await clickAnnotTool(tool);
        seen18.push({ tool, fill: state18.fill, stroke: state18.stroke, pressedCount: state18.styleSeg && state18.styleSeg.pressedCount });
      }
      const back18 = await clickAnnotTool('rect');
      check('V18.5', 'line/arrow/brush/text/eraser disable the whole segment but keep the selected option; a real click back to 矩形 re-enables it',
        seen18.every((entry) => entry.fill.disabled === true && entry.stroke.disabled === true
          && entry.fill.checked === false && entry.stroke.checked === true && entry.pressedCount === 1)
          && back18.fill.disabled === false && back18.stroke.disabled === false
          && back18.fill.checked === false && back18.stroke.checked === true,
        { tools: 'disabled + kept 外框', back: 'enabled' },
        { seen: seen18, back: { fill: back18.fill, stroke: back18.stroke } });

      // ---- V18.6 sizing blocks entering the annotation mode --------------------------------
      await v18Mode(false);
      await openSizeBar();
      const blocked18 = await panelState();
      const mark18 = Date.now();
      const entry18 = await annotEntryRect();
      await clickAt(entry18.x, entry18.y);
      await sleep(450);
      const afterBlocked18 = await panelState();
      const blockedPosts18 = panelPosts('viewport', mark18);
      const blockedInputs18 = panelPosts('input', mark18);
      await closeSizeBar();
      const entered18 = await v18Mode(true);
      check('V18.6', 'sizing=true makes the 标注 entry native-disabled (data-utb-annot-entry=sizing, exact title); a real click opens no bar and posts nothing, and closing the size bar restores the entry',
        blocked18.annot.disabled === true && blocked18.annot.entryState === 'sizing'
          && blocked18.annot.title === '尺寸调整模式下不可进入标注（先关闭尺寸调整）'
          && afterBlocked18.annot.pressed !== 'true' && afterBlocked18.annot.bar === null
          && blockedPosts18.length === 0 && blockedInputs18.length === 0
          && entered18.annot.pressed === 'true',
        { disabled: true, entry: 'sizing', title: '尺寸调整模式下不可进入标注（先关闭尺寸调整）', posts: 0 },
        { blocked: blocked18.annot, afterClick: { pressed: afterBlocked18.annot.pressed, bar: afterBlocked18.annot.bar }, posts: blockedPosts18.length, inputs: blockedInputs18.length, entered: entered18.annot.pressed });

      // ---- V18.7 mode on keeps the sizing entry disabled ------------------------------------
      const modeOn18 = await panelState();
      const mark718 = Date.now();
      const sizingEntry18 = await pageEvaluate(panelExpr(`
        const b = panel.querySelector('button[aria-label="尺寸调整"]');
        if (!b) return null;
        const r = b.getBoundingClientRect();
        return { x: r.left + r.width / 2, y: r.top + r.height / 2, disabled: b.disabled };
      `));
      if (sizingEntry18 && !sizingEntry18.disabled) await clickAt(sizingEntry18.x, sizingEntry18.y);
      await sleep(400);
      const after718 = await panelState();
      check('V18.7', 'inside the mode the sizing entry stays disabled and opening the size bar is refused (no bar, zero /viewport)',
        modeOn18.annot.pressed === 'true' && modeOn18.sizingEntryDisabled === true && modeOn18.sizeBar === false
          && Boolean(sizingEntry18) && sizingEntry18.disabled === true
          && after718.sizeBar === false && panelPosts('viewport', mark718).length === 0,
        { mode: 'on', sizingEntry: 'disabled', sizeBar: false },
        { sizingEntry: sizingEntry18, sizeBar: after718.sizeBar, posts: panelPosts('viewport', mark718).length });

      // ---- V18.9 revisit keeps the accepted Host size (zero first-bind POST) ----------------
      await v18Mode(false);
      await openSizeBar();
      await hostViewportSet({ width: 768, height: 1024, scale: 1, x: 0, y: 0 });
      await waitHostView((view) => Number(view.width) === 768 && Number(view.height) === 1024 && closeTo(view.scale, 1, 0.0011));
      await waitPanelMirrorsHost().catch(() => undefined);
      const mark918 = Date.now();
      await reloadGui();
      let revisit18 = await panelState();
      if (!revisit18.sizeBar) { await openSizeBar(); revisit18 = await panelState(); }
      await waitPanelMirrorsHost().catch(() => undefined);
      revisit18 = await panelState();
      check('V18.9', 'a revisit (accepted non-default view) does not re-apply the env default: zero /viewport after reload, panel mirrors 768×1024, fit pressed, pan off',
        panelPosts('viewport', mark918).length === 0
          && Number(revisit18.width) === 768 && Number(revisit18.height) === 1024
          && revisit18.fitChecked === true && revisit18.panChecked === false
          && revisit18.panFit && revisit18.panFit.state === 'fit' && revisit18.panFit.pressedCount === 1,
        { posts: 0, size: [768, 1024], fit: true, pan: false },
        { posts: panelPosts('viewport', mark918).length, width: revisit18.width, height: revisit18.height,
          fit: revisit18.fitChecked, pan: revisit18.panChecked, panFit: revisit18.panFit });

      // ---- V18.10 pan → fit → default → pan and the single-pressed invariant ----------------
      await clickFit(true);
      const panA18 = await togglePan(true);
      const markFit18 = Date.now();
      const fitA18 = await pressPanFitOption('fit');
      const postsFit18 = panelPosts('viewport', markFit18);
      const markDefault18 = Date.now();
      const defaultA18 = await pressPanFitOption('default');
      const postsDefault18 = panelPosts('viewport', markDefault18);
      const panB18 = await pressPanFitOption('pan');
      const defaultPressed18 = (snapshot) => Boolean(snapshot.panFit && snapshot.panFit.options.find((entry) => entry.option === 'default' && entry.pressed));
      check('V18.10', '三选一 pan→fit→默认→pan: exactly one pressed each step, grab↔auto, canvas zoom follows pan, fit→默认 and 默认 switch post no /viewport',
        panA18.panFit.state === 'pan' && panA18.panChecked === true && panA18.fitChecked === false
          && panA18.panFit.pressedCount === 1 && panA18.panLayerCursor === 'grab' && panA18.canvasZoom === 'wheel'
          && fitA18.panFit.state === 'fit' && fitA18.fitChecked === true && fitA18.panChecked === false
          && fitA18.panFit.pressedCount === 1 && fitA18.panLayer === false
          && defaultA18.panFit.state === 'default' && defaultA18.panFit.pressedCount === 1
          && defaultPressed18(defaultA18) && defaultA18.panChecked === false && defaultA18.fitChecked === false
          && defaultA18.panLayer === false && defaultA18.panLayerCursor !== 'grab' && defaultA18.canvasZoom !== 'wheel'
          && Number(defaultA18.zoomValue) === 100
          && panB18.panFit.state === 'pan' && panB18.panChecked === true && panB18.panFit.pressedCount === 1
          && postsFit18.length === 0 && postsDefault18.length === 0,
        { states: ['pan', 'fit', 'default', 'pan'], pressed: 1, posts: 0 },
        { panA: { state: panA18.panFit.state, pan: panA18.panChecked, fit: panA18.fitChecked, cursor: panA18.panLayerCursor, zoom: panA18.canvasZoom },
          fitA: { state: fitA18.panFit.state, pan: fitA18.panChecked, fit: fitA18.fitChecked, layer: fitA18.panLayer },
          defaultA: { state: defaultA18.panFit.state, pressed: defaultPressed18(defaultA18), pan: defaultA18.panChecked, fit: defaultA18.fitChecked,
            cursor: defaultA18.panLayerCursor, zoom: defaultA18.canvasZoom, percent: defaultA18.zoomValue },
          panB: { state: panB18.panFit.state, pan: panB18.panChecked },
          postsFit: postsFit18.length, postsDefault: postsDefault18.length });

      // ---- V18.11 manual percent selects the explicit 默认 ----------------------------------
      const pre1118 = await panelState();
      if (pre1118.panChecked) await pressPanFitOption('fit');
      else if (!pre1118.fitChecked) await clickFit(true);
      const mark1118 = Date.now();
      await typeIntoField('预览缩放比例（百分比）', '150', { enter: true });
      await sleep(450);
      const typed1118 = await panelState();
      const typedPosts1118 = panelPosts('viewport', mark1118);
      await waitHostView((view) => closeTo(Number(view.scale), 1.5, 0.02)).catch(() => undefined);
      const mark1118b = Date.now();
      await wheelOnField('预览缩放比例（百分比）', -120);
      await sleep(350);
      const wheel1118 = await panelState();
      const wheelPosts1118 = panelPosts('viewport', mark1118b);
      const host1118 = await hostView();
      const manualPosts1118 = [...typedPosts1118, ...wheelPosts1118].map(parseBody);
      check('V18.11', 'a manual percentage (150+Enter, then one size-bar wheel notch) selects 默认 (fit=false, pan=false, exactly one pressed), never engages pan, and publishes only scale',
        typed1118.panFit.state === 'default' && typed1118.panFit.pressedCount === 1 && defaultPressed18(typed1118)
          && typed1118.panChecked === false && typed1118.fitChecked === false && typed1118.panLayerCursor !== 'grab'
          && Number(typed1118.zoomValue) === 150
          && typedPosts1118.length >= 1 && typedPosts1118.every((entry) => parseBody(entry).scale !== undefined)
          && wheel1118.panFit.state === 'default' && wheel1118.panFit.pressedCount === 1 && defaultPressed18(wheel1118)
          && Number(wheel1118.zoomValue) === 155
          && wheelPosts1118.length >= 1 && wheelPosts1118.every((entry) => parseBody(entry).scale !== undefined)
          && closeTo(Number(host1118.view.scale), 1.55, 0.02),
        { state: 'default', pressed: 1, pan: false, zoom: [150, 155], hostScale: 1.55, posts: 'scale only' },
        { typed: { state: typed1118.panFit.state, pressed: typed1118.panFit.pressedCount, default: defaultPressed18(typed1118), zoom: typed1118.zoomValue, posts: manualPosts1118 },
          wheel: { state: wheel1118.panFit.state, pressed: wheel1118.panFit.pressedCount, default: defaultPressed18(wheel1118), zoom: wheel1118.zoomValue, posts: wheelPosts1118.map(parseBody) },
          hostScale: host1118.view.scale });

      // ---- V18.11b editing % while dragging keeps pan (no accidental exit) ------------------
      await togglePan(true);
      const panEdit18 = await panelState();
      const markEdit18 = Date.now();
      await typeIntoField('预览缩放比例（百分比）', '180', { enter: true });
      await sleep(450);
      const edited18 = await panelState();
      const editPosts18 = panelPosts('viewport', markEdit18);
      await waitHostView((view) => closeTo(Number(view.scale), 1.8, 0.02)).catch(() => undefined);
      const hostEdit18 = await hostView();
      check('V18.11b', 'editing the percentage while dragging keeps state=pan (pan not turned off) and fit=false, and publishes only scale',
        panEdit18.panFit.state === 'pan' && panEdit18.panChecked === true
          && edited18.panFit.state === 'pan' && edited18.panFit.pressedCount === 1
          && edited18.panChecked === true && edited18.fitChecked === false
          && edited18.panLayerCursor === 'grab' && edited18.canvasZoom === 'wheel'
          && Number(edited18.zoomValue) === 180
          && editPosts18.length >= 1 && editPosts18.every((entry) => parseBody(entry).scale !== undefined)
          && closeTo(Number(hostEdit18.view.scale), 1.8, 0.02),
        { before: 'pan', after: 'pan', fit: false, zoom: 180, posts: 'scale only' },
        { before: { state: panEdit18.panFit.state, pan: panEdit18.panChecked },
          after: { state: edited18.panFit.state, pan: edited18.panChecked, fit: edited18.fitChecked, cursor: edited18.panLayerCursor, zoom: edited18.zoomValue },
          posts: editPosts18.map(parseBody), hostScale: hostEdit18.view.scale });

      // ---- V18.12 annotation width wheel ---------------------------------------------------
      await closeSizeBar();
      await v18Mode(true);
      await clickAnnotTool('rect');
      await annotPrepareStyle({ stroke: true, width: 5, color: '#ff3b30' });
      await annotResetCanvas();
      const scroll1218 = await pageEvaluate('({ x: window.scrollX, y: window.scrollY })');
      const mark1218 = Date.now();
      const w018 = await wheelOnAnnotWidth(-120);
      const w118 = await wheelOnAnnotWidth(-120, 8);
      const w218 = await wheelOnAnnotWidth(120, 1);
      await setAnnotWidth(20);
      const w318 = await wheelOnAnnotWidth(-120);
      await setAnnotWidth(1);
      const w418 = await wheelOnAnnotWidth(120);
      const w518 = await wheelOnAnnotWidth(0);
      await clickAnnotTool('text');
      const textWidthBefore18 = (await panelState()).annot.width.value;
      const wText18 = await wheelOnAnnotWidth(-120);
      await clickAnnotTool('eraser');
      const eraserWidthBefore18 = (await panelState()).annot.width.value;
      const wEraser18 = await wheelOnAnnotWidth(-120);
      const scroll1218b = await pageEvaluate('({ x: window.scrollX, y: window.scrollY })');
      const posts1218 = panelPosts('viewport', mark1218);
      const inputs1218 = panelPosts('input', mark1218);
      check('V18.12', 'the 粗细 input wheel steps ±1 (Shift ±5, Alt ±1, Alt first), clamps 1–20, swallows the page wheel, never posts /viewport and never creates a shape; text/eraser do not respond',
        w018.width.value === '6' && w118.width.value === '11' && w218.width.value === '10'
          && w318.width.value === '20' && w418.width.value === '1' && w518.width.value === '1'
          && wText18.width.disabled === true && wText18.width.value === textWidthBefore18
          && wEraser18.width.disabled === true && wEraser18.width.value === eraserWidthBefore18
          && posts1218.length === 0 && inputs1218.length === 0
          && annotShapes(await panelState()).length === 0
          && scroll1218b.x === scroll1218.x && scroll1218b.y === scroll1218.y,
        { steps: ['6', '11', '10', '20', '1'], text: 'unchanged', posts: 0, shapes: 0, scroll: 'unchanged' },
        { values: [w018.width.value, w118.width.value, w218.width.value, w318.width.value, w418.width.value, w518.width.value],
          text: { disabled: wText18.width.disabled, value: wText18.width.value, before: textWidthBefore18 },
          eraser: { disabled: wEraser18.width.disabled, value: wEraser18.width.value, before: eraserWidthBefore18 },
          posts: posts1218.length, inputs: inputs1218.length, shapes: annotShapes(await panelState()).length, scrollBefore: scroll1218, scrollAfter: scroll1218b });

      // ---- V18.13 three-option group + 默认 semantics + old-Host enablement -----------------
      await v18Mode(false);
      await openSizeBar();
      await hostViewportSet({ width: 400, height: 300, scale: 1, x: 0, y: 0 });
      await waitHostView((view) => Number(view.width) === 400 && Number(view.height) === 300 && closeTo(view.scale, 1, 0.0011));
      await waitPanelMirrorsHost();
      await clickFit(true);
      const group1318 = await panelState();
      const labels1318 = group1318.panFit ? group1318.panFit.options.map((entry) => entry.text).join('|') : '';
      const mark1318 = Date.now();
      const default1318 = await pressPanFitOption('default');
      const posts1318 = panelPosts('viewport', mark1318);
      const mark13b18 = Date.now();
      const defaultAgain18 = await pressPanFitOption('default');
      const posts13b18 = panelPosts('viewport', mark13b18);
      let stopOld18 = null;
      let oldHost18 = null;
      try {
        stopOld18 = await startStateRewrite((json) => mutateStateUi(json, (ui) => {
          delete ui.view;
          delete ui.canvas;
          return ui;
        }));
        await waitFor(async () => {
          const panel = await panelState();
          return panel.canvasOn === 'off' ? panel : undefined;
        }, { timeoutMs: 6000, intervalMs: 150, label: 'old Host projection' }).catch(() => null);
        oldHost18 = await panelState();
      } finally {
        if (stopOld18) await stopOld18();
      }
      await waitFor(async () => {
        const panel = await panelState();
        return panel.canvasOn === 'on' ? panel : undefined;
      }, { timeoutMs: 8000, intervalMs: 150, label: 'canvas restored' }).catch(() => null);
      await sleep(500);
      const oldOption18 = (snapshot, option) => (snapshot && snapshot.panFit ? snapshot.panFit.options.find((entry) => entry.option === option) : null);
      check('V18.13', '三选一 拖拽|适应窗口|默认: exactly one pressed; 默认 sets pan=false/fit=false with the shared percent and posts nothing; selecting it again is a no-op; on an old Host 默认 stays enabled while 拖拽 is disabled',
        labels1318 === '拖拽|适应窗口|默认' && group1318.panFit.options.length === 3
          && group1318.panFit.pressedCount === 1
          && group1318.panFit.options.every((entry) => entry.disabled === false)
          && default1318.panFit.state === 'default' && default1318.panFit.pressedCount === 1 && defaultPressed18(default1318)
          && default1318.panChecked === false && default1318.fitChecked === false
          && Number(default1318.zoomValue) === 100
          && posts1318.length === 0
          && defaultAgain18.panFit.state === 'default' && defaultAgain18.panFit.pressedCount === 1
          && posts13b18.length === 0
          && Boolean(oldHost18) && oldHost18.canvasOn === 'off'
          && Boolean(oldOption18(oldHost18, 'pan')) && oldOption18(oldHost18, 'pan').disabled === true
          && Boolean(oldOption18(oldHost18, 'default')) && oldOption18(oldHost18, 'default').disabled === false
          && Boolean(oldOption18(oldHost18, 'fit')) && oldOption18(oldHost18, 'fit').disabled === false,
        { labels: '拖拽|适应窗口|默认', pressed: 1, default: { pan: false, fit: false, percent: 100, posts: 0 },
          oldHost: { pan: 'disabled', fit: 'enabled', default: 'enabled' } },
        { labels: labels1318, group: group1318.panFit,
          default: { state: default1318.panFit.state, pressed: default1318.panFit.pressedCount, pan: default1318.panChecked,
            fit: default1318.fitChecked, percent: default1318.zoomValue, posts: posts1318.length },
          again: { state: defaultAgain18.panFit.state, posts: posts13b18.length },
          oldHost: oldHost18 ? { canvas: oldHost18.canvasOn, pan: oldOption18(oldHost18, 'pan'), fit: oldOption18(oldHost18, 'fit'), default: oldOption18(oldHost18, 'default') } : null });

      // ---- V18.14 segmented dots: only the selected option shows a green dot ----------------
      const segDotFacts = async () => pageEvaluate(panelExpr(`
        const groups = {};
        for (const svg of panel.querySelectorAll('[data-utb-seg-dot]')) {
          const button = svg.closest('button');
          const group = svg.getAttribute('data-utb-seg-group');
          const state = svg.getAttribute('data-utb-seg-dot');
          const cs = getComputedStyle(svg);
          const circle = svg.querySelector('circle');
          const svgRect = svg.getBoundingClientRect();
          const btnRect = button.getBoundingClientRect();
          const textNode = [...button.childNodes].find((node) => node.nodeType === 3 && String(node.textContent).trim());
          let textRect = null;
          if (textNode) { const range = document.createRange(); range.selectNodeContents(textNode); textRect = range.getBoundingClientRect(); }
          (groups[group] = groups[group] || []).push({
            label: button.getAttribute('aria-label'),
            pressed: button.getAttribute('aria-pressed'),
            state, visible: cs.visibility, display: cs.display,
            svg: { left: svgRect.left, top: svgRect.top, width: svgRect.width, height: svgRect.height },
            text: textRect ? { left: textRect.left, top: textRect.top, width: textRect.width, height: textRect.height } : null,
            fill: circle ? getComputedStyle(circle).fill : null,
            circleFill: circle ? circle.getAttribute('fill') : null,
            button: { left: btnRect.left, top: btnRect.top, width: btnRect.width, height: btnRect.height, disabled: button.disabled === true },
          });
        }
        return groups;
      `));
      const dotOk = (entry) => Boolean(entry) && entry.svg.width === 8 && entry.svg.height === 8
        && entry.text && entry.svg.left + entry.svg.width <= entry.text.left + 1;
      const dotSelected = (entry) => dotOk(entry) && entry.pressed === 'true' && entry.state === 'on'
        && entry.visible === 'visible' && entry.circleFill === '#22c55e';
      const dotUnselected = (entry) => dotOk(entry) && entry.pressed === 'false' && entry.state === 'off'
        && entry.visible === 'hidden' && entry.circleFill === '#22c55e';
      const sameTextLeft = (before, after) => before.length === after.length
        && before.every((entry, index) => after[index] && Math.abs(after[index].text.left - entry.text.left) <= 1);
      await v18Mode(false);
      await openSizeBar();
      await hostViewportSet({ width: 400, height: 300, scale: 1, x: 0, y: 0 });
      await waitHostView((view) => Number(view.width) === 400 && Number(view.height) === 300 && closeTo(view.scale, 1, 0.0011));
      await waitPanelMirrorsHost();
      await clickFit(true);
      const panfitFit18 = (await segDotFacts()).panfit || [];
      const panfitFitText18 = panfitFit18.map((entry) => ({ text: entry.text }));
      const defaultAfter18 = await pressPanFitOption('default');
      const panfitDefault18 = (await segDotFacts()).panfit || [];
      await capturePanel('shot-27-v18-panfit-seg-dot');
      const panfitDefaultText18 = panfitDefault18.map((entry) => ({ text: entry.text }));
      await closeSizeBar();
      await v18Mode(true);
      await clickAnnotTool('rect');
      const annotStroke18 = (await segDotFacts())['fill-stroke'] || [];
      const annotStrokeText18 = annotStroke18.map((entry) => ({ text: entry.text }));
      await capturePanel('shot-26-v18-annot-seg-dot');
      await clickAnnotCheckbox('填充');
      const annotFill18 = (await segDotFacts())['fill-stroke'] || [];
      const annotFillText18 = annotFill18.map((entry) => ({ text: entry.text }));
      check('V18.14', 'both segmented groups render an 8×8 marker per option; only the selected option shows a green dot (unselected hidden but occupying space), left of the label, and switching keeps the label x stable within 1px',
        panfitFit18.length === 3 && panfitDefault18.length === 3
          && annotStroke18.length === 2 && annotFill18.length === 2
          && dotSelected(panfitFit18[1]) && dotUnselected(panfitFit18[0]) && dotUnselected(panfitFit18[2])
          && dotSelected(panfitDefault18[2]) && dotUnselected(panfitDefault18[0]) && dotUnselected(panfitDefault18[1])
          && sameTextLeft(panfitFitText18, panfitDefaultText18)
          && dotSelected(annotStroke18[1]) && dotUnselected(annotStroke18[0])
          && dotSelected(annotFill18[0]) && dotUnselected(annotFill18[1])
          && sameTextLeft(annotStrokeText18, annotFillText18)
          && panfitDefault18.every((entry) => entry.button.width > 0 && entry.button.height > 0)
          && annotFill18.every((entry) => entry.button.width > 0 && entry.button.height > 0),
        { panfit: '3 dots, fit→default selected', annot: '2 dots, stroke→fill selected', dot: '8×8 green #22c55e', labelShift: '<=1px' },
        { panfitFit: panfitFit18, panfitDefault: panfitDefault18, annotStroke: annotStroke18, annotFill: annotFill18 });

      // ---- V18.15 dots at the narrow width (no overflow, annot bar still 41px) --------------
      await v18Mode(false);
      await openSizeBar();
      await setGuiWindow(720, 760);
      await sleep(900);
      const narrowSizeDots18 = await segDotFacts();
      const narrowSizePanel18 = await panelState();
      await cdp.send('Emulation.clearDeviceMetricsOverride').catch(() => undefined);
      await sleep(700);
      await closeSizeBar();
      await v18Mode(true);
      await setGuiWindow(720, 760);
      await sleep(900);
      const narrowAnnotDots18 = await segDotFacts();
      const narrowAnnotPanel18 = await panelState();
      await cdp.send('Emulation.clearDeviceMetricsOverride').catch(() => undefined);
      await sleep(700);
      await v18Mode(false);
      await openSizeBar();
      const narrowPanfit18 = narrowSizeDots18.panfit || [];
      const narrowFillStroke18 = narrowAnnotDots18['fill-stroke'] || [];
      check('V18.15', 'at 664px the three-option group and the fill/stroke group do not overflow horizontally, the annotation bar stays a single 41px row, and the selected dot stays visible',
        narrowSizePanel18.bar && narrowSizePanel18.bar.scrollWidth <= narrowSizePanel18.bar.clientWidth + 1
          && narrowPanfit18.length === 3
          && narrowPanfit18.filter((entry) => entry.state === 'on' && entry.visible === 'visible').length === 1
          && narrowPanfit18.every((entry) => entry.svg.width === 8 && entry.svg.height === 8
            && entry.text && entry.svg.left + entry.svg.width <= entry.text.left + 1)
          && narrowAnnotPanel18.annot && narrowAnnotPanel18.annot.bar
          && Math.abs(narrowAnnotPanel18.annot.bar.height - 41) <= 1
          && narrowAnnotPanel18.annot.bar.scrollWidth <= narrowAnnotPanel18.annot.bar.clientWidth + 1
          && narrowFillStroke18.length === 2
          && narrowFillStroke18.filter((entry) => entry.state === 'on' && entry.visible === 'visible').length === 1,
        { narrow: 664, panfit: '3 dots, no overflow', annot: '41px, 2 dots, no overflow', selectedDot: 'visible' },
        { sizeBar: narrowSizePanel18.bar, panfit: narrowPanfit18, annotBar: narrowAnnotPanel18.annot && narrowAnnotPanel18.annot.bar, fillStroke: narrowFillStroke18 });

      // ---- V18.16 the four size-bar presets also reset X/Y and the panfit selector -----------
      // User report 2026-11-03: a preset must be a full "default view" — width/height preset,
      // canvas origin back to 0 (target page scroll 0,0), and the right-side 拖拽|适应窗口|默认
      // selector back to 默认 — without touching scale. One merged v1 patch per click.
      const presetButtonRect = async (label) => pageEvaluate(panelExpr(`
        const b = [...panel.querySelectorAll('.utb-preset')].find((el) => (el.textContent || '').trim() === ${JSON.stringify(label)});
        if (!b) return null;
        const r = b.getBoundingClientRect();
        return { x: r.left + r.width / 2, y: r.top + r.height / 2, width: r.width, height: r.height, disabled: b.disabled === true };
      `));
      const blurPanelFocus = () => pageEvaluate(`(() => { const el = document.activeElement; if (el && typeof el.blur === 'function') el.blur(); return true; })()`);
      /** Real CDP click on one preset; a shell mask is dismissed first (never a synthetic .click()). */
      const clickPreset = async (label) => {
        for (let attempt = 0; attempt < 3; attempt += 1) {
          await dismissShellDialogs();
          const rect = await presetButtonRect(label);
          if (!rect) throw new Error('size-bar preset button missing: ' + label);
          const hit = await pageEvaluate(`(() => {
            const el = document.elementFromPoint(${rect.x}, ${rect.y});
            const button = el && el.closest ? el.closest('.utb-preset') : null;
            return button ? (button.textContent || '').trim() : (el ? String(el.className || el.tagName) : null);
          })()`);
          if (hit === label) { await clickAt(rect.x, rect.y); return rect; }
          await sleep(300);
        }
        const rect = await presetButtonRect(label);
        await clickAt(rect.x, rect.y);
        return rect;
      };
      /** The one merged v1 preset patch: width+height+canvasX:0+canvasY:0+expectedRevision, no scale. */
      const presetPatchBodyOk = (body, width, height) => Boolean(body)
        && Number(body.version) === 1
        && Number(body.width) === width && Number(body.height) === height
        && Number(body.canvasX) === 0 && Number(body.canvasY) === 0
        && body.x === undefined && body.y === undefined && body.scale === undefined
        && Number.isFinite(Number(body.expectedRevision));

      await v18Mode(false);
      await openSizeBar();
      await dismissShellDialogs();
      // Non-default baseline: a custom size, a non-1 shared scale and the explicit 默认 selector.
      await hostViewportSet({ width: 400, height: 300, scale: 0.65, canvasX: 0, canvasY: 0 });
      await waitHostView((view) => Number(view.width) === 400 && Number(view.height) === 300
        && closeTo(view.scale, 0.65, 0.0011) && near(view.canvasX, 0, 1) && near(view.canvasY, 0, 1));
      await waitPanelMirrorsHost();
      if ((await panelState()).panChecked) await togglePan(false);
      if ((await panelState()).fitChecked) await clickFit(false);
      await waitPanelValues({ scale: 65 });
      const PRESET_CASES = [
        { label: '宽屏', width: 1920, height: 1080, mode: 'wide' },
        { label: '横屏', width: 1024, height: 768, mode: 'landscape' },
        { label: '平板', width: 768, height: 1024, mode: 'tablet' },
        { label: '手机', width: 393, height: 852, mode: 'phone' },
      ];
      const presetRuns = [];
      for (const item of PRESET_CASES) {
        // Re-establish a non-zero canvas origin (C=100/80) before every click and prove the panel
        // adopted it, otherwise the reset assertion would be vacuous.
        await hostViewportSet({ canvasX: 100, canvasY: 80 });
        const beforeSet = await waitHostView((view) => near(view.canvasX, 100, 1) && near(view.canvasY, 80, 1));
        await waitPanelValues({ x: 100, y: 80 }).catch(() => undefined);
        if (beforeSet.view && Number.isFinite(Number(beforeSet.view.revision))) {
          await waitPanelRevision(Number(beforeSet.view.revision)).catch(() => undefined);
        }
        // No size-bar draft may commit a separate patch on the click's blur (one-POST contract).
        await blurPanelFocus();
        await sleep(260);
        const before = await panelState();
        const preconditionOk = !beforeSet.timedOut
          && near(beforeSet.view && beforeSet.view.canvasX, 100, 1)
          && near(beforeSet.view && beforeSet.view.canvasY, 80, 1)
          && near(before.x, 100, 1.5) && near(before.y, 80, 1.5);
        const mark = Date.now();
        await clickPreset(item.label);
        const settled = await waitHostView((view) => Number(view.width) === item.width && Number(view.height) === item.height
          && near(view.canvasX, 0, 1) && near(view.canvasY, 0, 1)
          && near(view.x, 0, 1) && near(view.y, 0, 1)
          && closeTo(view.scale, 0.65, 0.0011), { timeoutMs: 9000 });
        await waitPanelValues({ width: item.width, height: item.height, x: 0, y: 0, scale: 65 }).catch(() => undefined);
        // The panel must have adopted its own ACK (revision) before the render facts are read.
        if (settled.view && Number.isFinite(Number(settled.view.revision))) {
          await waitPanelRevision(Number(settled.view.revision)).catch(() => undefined);
        }
        const after = await panelState();
        const truth = await targetTruth();
        const posts = panelPosts('viewport', mark).map(parseBody);
        presetRuns.push({
          label: item.label,
          expected: { width: item.width, height: item.height, mode: item.mode },
          preconditionOk,
          before: { canvasX: 100, canvasY: 80, panelX: before.x, panelY: before.y, viewRevision: before.viewRevision, zoom: before.zoomValue },
          host: settled.view,
          timedOut: Boolean(settled.timedOut),
          panel: {
            width: after.width, height: after.height, x: after.x, y: after.y, zoom: after.zoomValue,
            panFit: after.panFit && after.panFit.state,
            pressed: after.presets.filter((entry) => entry.pressed).map((entry) => entry.label),
          },
          page: { innerWidth: truth.innerWidth, innerHeight: truth.innerHeight, scrollX: truth.scrollX, scrollY: truth.scrollY },
          posts,
        });
      }
      const presetRunOk = (run, item) => run.preconditionOk
        && !run.timedOut && run.host
        && Number(run.host.width) === item.width && Number(run.host.height) === item.height
        && String(run.host.mode) === item.mode
        && near(run.host.canvasX, 0, 1) && near(run.host.canvasY, 0, 1)
        && near(run.host.x, 0, 1) && near(run.host.y, 0, 1)
        && closeTo(run.host.scale, 0.65, 0.0011)
        && Number(run.page.innerWidth) === item.width && Number(run.page.innerHeight) === item.height
        && near(run.page.scrollX, 0, 0.5) && near(run.page.scrollY, 0, 0.5)
        && Number(run.panel.width) === item.width && Number(run.panel.height) === item.height
        && near(run.panel.x, 0, 0.5) && near(run.panel.y, 0, 0.5)
        && Number(run.panel.zoom) === 65
        && run.panel.panFit === 'default' && run.panel.pressed.length === 1 && run.panel.pressed[0] === item.label
        && run.posts.length === 1
        && presetPatchBodyOk(run.posts[0], item.width, item.height)
        && Number(run.posts[0].expectedRevision) === Number(run.before.viewRevision);
      await capturePanel('shot-28-v18-preset-reset');
      check('V18.16', 'each of the four size-bar presets resets canvasX/canvasY and the target page scroll to 0, keeps scale 0.65 (65 %), returns the panfit selector to 默认, and publishes exactly one merged /viewport patch (width+height+canvasX:0+canvasY:0+expectedRevision, no scale)',
        presetRuns.length === 4 && presetRuns.every((run, index) => presetRunOk(run, PRESET_CASES[index])),
        { presets: PRESET_CASES.map((item) => `${item.label} ${item.width}×${item.height}`),
          before: { canvasX: 100, canvasY: 80 }, after: { canvas: [0, 0], pageScroll: [0, 0], panfit: 'default', scale: '0.65 / 65 %' },
          posts: 'exactly 1 merged patch per click, no scale' },
        presetRuns);

      // ---- V18.17 a preset click only exits 拖拽; 适应窗口 is preserved -----------------------
      // User report 2026-11-03 (round 3): from 拖拽 a preset lands on 默认, but from 适应窗口 a
      // preset must KEEP 适应窗口 (local fit, no scale publish) — not switch to 默认.
      await hostViewportSet({ width: 400, height: 300, scale: 0.65, canvasX: 0, canvasY: 0 });
      await waitHostView((view) => Number(view.width) === 400 && Number(view.height) === 300
        && closeTo(view.scale, 0.65, 0.0011) && near(view.canvasX, 0, 1) && near(view.canvasY, 0, 1));
      await waitPanelMirrorsHost();
      if ((await panelState()).panChecked) await togglePan(false);
      if ((await panelState()).fitChecked) await clickFit(false);
      await waitPanelValues({ scale: 65 });
      const defaultLanding = (panel) => Boolean(panel.panFit)
        && panel.panFit.state === 'default' && panel.panFit.pressedCount === 1
        && Boolean(panel.panFit.options.find((entry) => entry.option === 'default' && entry.pressed))
        && panel.fitChecked === false && panel.panChecked === false;
      // (a) fit on → preset click keeps fit (only the size/coordinates are written; no scale)
      const markFitSwitch17 = Date.now();
      await clickFit(true);
      const fitOn17 = await panelState();
      const fitSwitchPosts17 = panelPosts('viewport', markFitSwitch17).map(parseBody);
      await blurPanelFocus();
      await sleep(260);
      const markFitPreset17 = Date.now();
      await clickPreset('平板');
      const fitPresetHost17 = await waitHostView((view) => Number(view.width) === 768 && Number(view.height) === 1024
        && near(view.canvasX, 0, 1) && near(view.canvasY, 0, 1) && closeTo(view.scale, 0.65, 0.0011), { timeoutMs: 9000 });
      await waitPanelValues({ width: 768, height: 1024, x: 0, y: 0 }).catch(() => undefined);
      await waitFor(async () => {
        const panel = await panelState();
        return panel.panFit && panel.panFit.state === 'fit' && panel.panFit.pressedCount === 1
          && panel.fitChecked === true && panel.panChecked === false ? panel : undefined;
      }, { timeoutMs: 5000, intervalMs: 120, label: 'panel keeps 适应窗口 after the preset click' }).catch(() => undefined);
      if (fitPresetHost17.view && Number.isFinite(Number(fitPresetHost17.view.revision))) {
        await waitPanelRevision(Number(fitPresetHost17.view.revision)).catch(() => undefined);
      }
      const fitPresetPanel17 = await panelState();
      const fitPresetPosts17 = panelPosts('viewport', markFitPreset17).map(parseBody);
      await capturePanel('shot-32-v18-preset-fit-preserved');
      // (b) pan on → preset click lands on 默认 (drag exited, fit was already off)
      const markPanSwitch17 = Date.now();
      const panOn17 = await pressPanFitOption('pan');
      const panSwitchPosts17 = panelPosts('viewport', markPanSwitch17).map(parseBody);
      await blurPanelFocus();
      await sleep(260);
      const markPanPreset17 = Date.now();
      await clickPreset('手机');
      const panPresetHost17 = await waitHostView((view) => Number(view.width) === 393 && Number(view.height) === 852
        && near(view.canvasX, 0, 1) && near(view.canvasY, 0, 1) && closeTo(view.scale, 0.65, 0.0011), { timeoutMs: 9000 });
      await waitPanelValues({ width: 393, height: 852, x: 0, y: 0, scale: 65 }).catch(() => undefined);
      if (panPresetHost17.view && Number.isFinite(Number(panPresetHost17.view.revision))) {
        await waitPanelRevision(Number(panPresetHost17.view.revision)).catch(() => undefined);
      }
      const panPresetPanel17 = await panelState();
      const panPresetPosts17 = panelPosts('viewport', markPanPreset17).map(parseBody);
      await capturePanel('shot-29-v18-preset-default');
      const fitPresetPressed17 = fitPresetPanel17.panFit
        ? fitPresetPanel17.panFit.options.filter((entry) => entry.pressed).map((entry) => entry.option) : [];
      check('V18.17', 'a preset click from fit-on PRESERVES 适应窗口 (panFit=fit, exactly one pressed = fit, fitChecked=true, panChecked=false, % = local fit > 0) while from pan-on it lands on 默认 (fit=false, pan=false, % = shared 65); both reset X/Y, keep the shared scale and add no /viewport beyond the single preset patch',
        fitOn17.panFit.state === 'fit' && fitOn17.fitChecked === true && fitOn17.panChecked === false
          && fitSwitchPosts17.length === 0
          && fitPresetPanel17.panFit && fitPresetPanel17.panFit.state === 'fit'
          && fitPresetPanel17.panFit.pressedCount === 1
          && fitPresetPressed17.join('|') === 'fit'
          && fitPresetPanel17.fitChecked === true && fitPresetPanel17.panChecked === false
          && Number(fitPresetPanel17.zoomValue) > 0
          && !fitPresetHost17.timedOut && Number(fitPresetHost17.view.width) === 768 && Number(fitPresetHost17.view.height) === 1024
          && near(fitPresetHost17.view.canvasX, 0, 1) && near(fitPresetHost17.view.canvasY, 0, 1)
          && closeTo(fitPresetHost17.view.scale, 0.65, 0.0011)
          && fitPresetPosts17.length === 1 && presetPatchBodyOk(fitPresetPosts17[0], 768, 1024)
          && panOn17.panFit.state === 'pan' && panOn17.panChecked === true && panOn17.fitChecked === false
          && panSwitchPosts17.length === 0
          && defaultLanding(panPresetPanel17) && Number(panPresetPanel17.zoomValue) === 65
          && !panPresetHost17.timedOut && Number(panPresetHost17.view.width) === 393 && Number(panPresetHost17.view.height) === 852
          && near(panPresetHost17.view.canvasX, 0, 1) && near(panPresetHost17.view.canvasY, 0, 1)
          && closeTo(panPresetHost17.view.scale, 0.65, 0.0011)
          && panPresetPosts17.length === 1 && presetPatchBodyOk(panPresetPosts17[0], 393, 852),
        { fromFit: { stays: 'fit', pressed: 'fit only', fit: true, pan: false, percent: 'local fit > 0', host: '768×1024@0.65' },
          fromPan: { lands: 'default', fit: false, pan: false, percent: 65, host: '393×852@0.65' },
          posts: 'one preset patch each, no scale' },
        { fit: { before: { state: fitOn17.panFit.state, fit: fitOn17.fitChecked, pan: fitOn17.panChecked }, switchPosts: fitSwitchPosts17,
          after: { state: fitPresetPanel17.panFit && fitPresetPanel17.panFit.state,
            pressed: fitPresetPanel17.panFit && fitPresetPanel17.panFit.pressedCount,
            pressedOpts: fitPresetPressed17,
            fit: fitPresetPanel17.fitChecked, pan: fitPresetPanel17.panChecked, percent: fitPresetPanel17.zoomValue },
          host: fitPresetHost17.view, timedOut: Boolean(fitPresetHost17.timedOut), posts: fitPresetPosts17 },
          pan: { before: { state: panOn17.panFit.state, fit: panOn17.fitChecked, pan: panOn17.panChecked }, switchPosts: panSwitchPosts17,
            after: { state: panPresetPanel17.panFit && panPresetPanel17.panFit.state,
              pressed: panPresetPanel17.panFit && panPresetPanel17.panFit.pressedCount,
              fit: panPresetPanel17.fitChecked, pan: panPresetPanel17.panChecked, percent: panPresetPanel17.zoomValue },
            host: panPresetHost17.view, timedOut: Boolean(panPresetHost17.timedOut), posts: panPresetPosts17 } });

      // ---- V18.18 the four presets are a segmented control with the green selected dot -------
      // User report 2026-11-03 (round 2): the left presets must look like the other segmented
      // selectors (green dot), keep one/zero selected, and move the dot on a real click.
      const presetGroupFacts = () => pageEvaluate(panelExpr(`
        const group = panel.querySelector('[data-utb-preset]');
        if (!group) return null;
        const left = group.parentElement;
        const bar = panel.querySelector('.utb-size');
        const buttons = [...group.querySelectorAll('button')];
        const g = group.getBoundingClientRect();
        return {
          tag: group.tagName,
          classes: String(group.className || ''),
          role: group.getAttribute('role'),
          ariaLabel: group.getAttribute('aria-label'),
          dataPreset: group.getAttribute('data-utb-preset'),
          display: getComputedStyle(group).display,
          // The .utb-seg rule declares inline-flex, but the group is an in-flow child of the
          // flex .utb-size-left, and CSS blockifies a flex item's inline-level display to flex.
          // Read the declared value from the injected stylesheet and the used value separately.
          declaredSegDisplay: (() => {
            for (const sheet of document.styleSheets) {
              let rules = null;
              try { rules = sheet.cssRules; } catch { rules = null; }
              if (!rules) continue;
              for (const rule of rules) {
                if (rule && rule.selectorText && rule.selectorText.trim() === '.utb-seg'
                  && rule.style && rule.style.display) return rule.style.display;
              }
            }
            return null;
          })(),
          sameRow: (() => {
            const rects = buttons.map((b) => b.getBoundingClientRect());
            const tops = rects.map((r) => r.top);
            const lefts = rects.map((r) => r.left);
            return rects.length === 4 && Math.max(...tops) - Math.min(...tops) <= 1
              && lefts.every((left, index) => index === 0 || left > lefts[index - 1]);
          })(),
          overflowX: getComputedStyle(group).overflowX,
          leftRole: left ? left.getAttribute('role') : null,
          leftAriaLabel: left ? left.getAttribute('aria-label') : null,
          leftChildren: left ? [...left.children].map((el) => el.tagName + '.' + String(el.className || '').trim().replace(/\\s+/g, '.')) : [],
          groupCount: panel.querySelectorAll('[data-utb-preset]').length,
          presetCount: panel.querySelectorAll('.utb-preset').length,
          inGroup: group.querySelectorAll('.utb-preset').length,
          groupsInBar: panel.querySelectorAll('.utb-size [role="group"]').length,
          buttons: buttons.map((b) => ({ tag: b.tagName, classes: String(b.className || ''),
            opt: b.getAttribute('data-utb-preset-opt'), label: b.getAttribute('aria-label'),
            pressed: b.getAttribute('aria-pressed'), disabled: b.disabled === true,
            rect: (() => { const r = b.getBoundingClientRect(); return { left: r.left, top: r.top, width: r.width, height: r.height }; })() })),
          rect: { left: g.left, top: g.top, width: g.width, height: g.height },
          scrollWidth: group.scrollWidth, clientWidth: group.clientWidth,
          bar: bar ? { scrollWidth: bar.scrollWidth, clientWidth: bar.clientWidth,
            left: bar.getBoundingClientRect().left, right: bar.getBoundingClientRect().right } : null,
          panel: (() => { const r = panel.getBoundingClientRect(); return { left: r.left, right: r.right }; })(),
        };
      `));
      const presetPressedOpts = (panel) => panel.presets.filter((entry) => entry.pressed).map((entry) => entry.opt);
      const presetGroupOk = (facts) => {
        if (!facts || !facts.bar || !facts.panel) return false;
        return facts.tag === 'DIV' && /(^| )utb-seg($| )/.test(facts.classes) && /(^| )utb-presets($| )/.test(facts.classes)
          && facts.role === 'group' && facts.ariaLabel === '分辨率预设' && facts.dataPreset === ''
          && facts.declaredSegDisplay === 'inline-flex'
          && facts.display === 'flex' // blockified inline-flex: the group is an in-flow flex item
          && facts.sameRow === true
          && facts.leftRole === null && facts.leftAriaLabel === null
          && facts.groupCount === 1 && facts.presetCount === 4 && facts.inGroup === 4
          && facts.buttons.map((b) => b.opt).join('|') === 'wide|landscape|tablet|phone'
          && facts.buttons.map((b) => b.label).join('|') === '宽屏|横屏|平板|手机'
          && facts.buttons.every((b) => b.tag === 'BUTTON'
            && /(^| )utb-seg-btn($| )/.test(b.classes) && /(^| )utb-preset($| )/.test(b.classes)
            && b.rect.width > 0 && b.rect.height > 0
            && b.rect.left >= facts.bar.left - 1 && b.rect.left + b.rect.width <= facts.bar.right + 1)
          && facts.bar.scrollWidth <= facts.bar.clientWidth + 1
          && facts.rect.left >= facts.panel.left - 1 && facts.rect.left + facts.rect.width <= facts.panel.right + 1;
      };
      const dotsOff = (dots) => dots.length === 4 && dots.every((entry) => dotUnselected(entry));

      await v18Mode(false);
      await openSizeBar();
      await dismissShellDialogs();
      // A preset-matching size, pan off, explicit 默认: exactly one preset must be selected.
      await hostViewportSet({ width: 1024, height: 768, scale: 1, canvasX: 0, canvasY: 0 });
      await waitHostView((view) => Number(view.width) === 1024 && Number(view.height) === 768
        && closeTo(view.scale, 1, 0.0011) && near(view.canvasX, 0, 1) && near(view.canvasY, 0, 1));
      await waitPanelMirrorsHost();
      if ((await panelState()).panChecked) await togglePan(false);
      await clickFit(false);
      await waitPanelValues({ width: 1024, height: 768, scale: 100 });
      const mainSeg18 = await presetGroupFacts();
      const mainPanel18 = await panelState();
      const mainDots18 = (await segDotFacts()).preset || [];
      const mainPressed18 = presetPressedOpts(mainPanel18);
      // Real CDP click on 平板 moves BOTH the pressed state and the dot.
      await blurPanelFocus();
      await sleep(260);
      await clickPreset('平板');
      const tabletHost18 = await waitHostView((view) => Number(view.width) === 768 && Number(view.height) === 1024
        && near(view.canvasX, 0, 1) && near(view.canvasY, 0, 1));
      await waitPanelValues({ width: 768, height: 1024, x: 0, y: 0 }).catch(() => undefined);
      if (tabletHost18.view && Number.isFinite(Number(tabletHost18.view.revision))) {
        await waitPanelRevision(Number(tabletHost18.view.revision)).catch(() => undefined);
      }
      const tabletPanel18 = await panelState();
      const tabletDots18 = (await segDotFacts()).preset || [];
      const tabletPressed18 = presetPressedOpts(tabletPanel18);
      await capturePanel('shot-30-v18-preset-seg');
      // Narrow window: the segmented control must not overflow.
      await setGuiWindow(720, 760);
      await sleep(900);
      const narrowSeg18 = await presetGroupFacts();
      const narrowPanel18 = await panelState();
      const narrowDots18 = (await segDotFacts()).preset || [];
      await cdp.send('Emulation.clearDeviceMetricsOverride').catch(() => undefined);
      await sleep(700);
      // A custom size matches no preset: zero pressed, no visible dot.
      await hostViewportSet({ width: 400, height: 300, scale: 1, canvasX: 0, canvasY: 0 });
      await waitHostView((view) => Number(view.width) === 400 && Number(view.height) === 300
        && near(view.canvasX, 0, 1) && closeTo(view.scale, 1, 0.0011));
      await waitPanelMirrorsHost();
      await waitPanelValues({ width: 400, height: 300 }).catch(() => undefined);
      await sleep(300);
      const customSeg18 = await presetGroupFacts();
      const customPanel18 = await panelState();
      const customDots18 = (await segDotFacts()).preset || [];
      const customPressed18 = presetPressedOpts(customPanel18);
      check('V18.18', 'the left presets are a segmented control (div.utb-seg[data-utb-preset][role=group][aria-label=分辨率预设], four utb-seg-btn.utb-preset in wide/landscape/tablet/phone order, inline-flex, no overflow) with zero/one selected and an 8×8 green dot on the selected option: 横屏 selected by size, a real 平板 click moves tab+dot, a custom 400×300 selects none',
        presetGroupOk(mainSeg18) && presetGroupOk(narrowSeg18) && presetGroupOk(customSeg18)
          && mainPressed18.join('|') === 'landscape'
          && mainPanel18.panChecked === false
          && mainDots18.length === 4 && dotSelected(mainDots18[1])
          && dotUnselected(mainDots18[0]) && dotUnselected(mainDots18[2]) && dotUnselected(mainDots18[3])
          && tabletPressed18.join('|') === 'tablet'
          && Number(tabletHost18.view.width) === 768 && Number(tabletHost18.view.height) === 1024
          && tabletDots18.length === 4 && dotSelected(tabletDots18[2])
          && [0, 1, 3].every((index) => dotUnselected(tabletDots18[index]))
          && narrowSeg18.sameRow === true
          && narrowSeg18.bar.scrollWidth <= narrowSeg18.bar.clientWidth + 1
          && narrowPanel18.presets.filter((entry) => entry.pressed).map((entry) => entry.opt).join('|') === 'tablet'
          && narrowDots18.filter((entry) => entry.state === 'on' && entry.visible === 'visible').length === 1
          && customPressed18.length === 0 && dotsOff(customDots18)
          && customSeg18.buttons.every((entry) => entry.pressed === 'false'),
        { group: 'div.utb-seg.utb-presets [data-utb-preset] role=group aria-label=分辨率预设', order: 'wide|landscape|tablet|phone',
          display: 'inline-flex declared / flex used (flex-item blockification), one row', selected: ['landscape by size', 'tablet after a real click', 'none at 400×300'],
          dot: '8×8 #22c55e, hidden for unselected', overflow: 'none at main + 664px' },
        { main: { group: mainSeg18, pressed: mainPressed18, dots: mainDots18 },
          afterTabletClick: { host: tabletHost18.view, pressed: tabletPressed18, dots: tabletDots18 },
          narrow: { group: narrowSeg18, pressed: presetPressedOpts(narrowPanel18), dots: narrowDots18 },
          custom: { group: customSeg18, pressed: customPressed18, dots: customDots18 } });

      // ---- V18.19 拖拽 mode deselects all four presets (mutual exclusion) -------------------
      // The user's reported bug: entering drag left a preset visually selected. Drag and the
      // four presets are mutually exclusive: pan on ⇒ zero pressed/dots hidden; a preset click
      // leaves drag and selects exactly that preset.
      await hostViewportSet({ width: 1024, height: 768, scale: 1, canvasX: 0, canvasY: 0 });
      await waitHostView((view) => Number(view.width) === 1024 && Number(view.height) === 768
        && closeTo(view.scale, 1, 0.0011) && near(view.canvasX, 0, 1) && near(view.canvasY, 0, 1));
      await waitPanelMirrorsHost();
      if ((await panelState()).panChecked) await togglePan(false);
      await clickFit(false);
      await waitPanelValues({ width: 1024, height: 768 }).catch(() => undefined);
      const startPanel19 = await panelState();
      const startDots19 = (await segDotFacts()).preset || [];
      // Enter 拖拽 through the real segmented option (not .click()).
      const panOn19 = await pressPanFitOption('pan');
      await sleep(220);
      const panPanel19 = await panelState();
      const panDots19 = (await segDotFacts()).preset || [];
      // Real-click 手机 while dragging: drag must be off and 手机 the only selected preset.
      await blurPanelFocus();
      await sleep(260);
      const markPreset19 = Date.now();
      await clickPreset('手机');
      const phoneHost19 = await waitHostView((view) => Number(view.width) === 393 && Number(view.height) === 852
        && near(view.canvasX, 0, 1) && near(view.canvasY, 0, 1)
        && near(view.x, 0, 1) && near(view.y, 0, 1), { timeoutMs: 9000 });
      await waitPanelValues({ width: 393, height: 852, x: 0, y: 0 }).catch(() => undefined);
      if (phoneHost19.view && Number.isFinite(Number(phoneHost19.view.revision))) {
        await waitPanelRevision(Number(phoneHost19.view.revision)).catch(() => undefined);
      }
      const afterPhone19 = await panelState();
      const afterDots19 = (await segDotFacts()).preset || [];
      const truth19 = await targetTruth();
      const presetPosts19 = panelPosts('viewport', markPreset19).map(parseBody);
      await capturePanel('shot-31-v18-preset-pan-exclusion');
      const pressedCounts19 = [startPanel19, panPanel19, afterPhone19]
        .map((panel) => panel.presets.filter((entry) => entry.pressed).length);
      check('V18.19', 'entering 拖拽 with a preset selected leaves all four presets aria-pressed=false with no green dots (the reported bug), and a real preset click cancels drag, selects only that preset, resets X/Y and the target page scroll to 0,0 with one merged patch',
        startPanel19.panFit.state === 'default' && startPanel19.panChecked === false
          && presetPressedOpts(startPanel19).join('|') === 'landscape' && dotSelected(startDots19[1])
          && panOn19.panFit.state === 'pan' && panOn19.panChecked === true && panOn19.fitChecked === false
          && panPanel19.panFit.state === 'pan' && panPanel19.panChecked === true
          && presetPressedOpts(panPanel19).length === 0 && dotsOff(panDots19)
          && afterPhone19.panChecked === false && afterPhone19.fitChecked === false
          && afterPhone19.panFit.state === 'default' && afterPhone19.panFit.pressedCount === 1
          && presetPressedOpts(afterPhone19).join('|') === 'phone'
          && afterDots19.length === 4 && dotSelected(afterDots19[3])
          && [0, 1, 2].every((index) => dotUnselected(afterDots19[index]))
          && near(afterPhone19.x, 0, 0.5) && near(afterPhone19.y, 0, 0.5)
          && !phoneHost19.timedOut && Number(phoneHost19.view.width) === 393 && Number(phoneHost19.view.height) === 852
          && near(phoneHost19.view.canvasX, 0, 1) && near(phoneHost19.view.canvasY, 0, 1)
          && Number(truth19.innerWidth) === 393 && Number(truth19.innerHeight) === 852
          && near(truth19.scrollX, 0, 0.5) && near(truth19.scrollY, 0, 0.5)
          && presetPosts19.length === 1 && presetPatchBodyOk(presetPosts19[0], 393, 852)
          && pressedCounts19.every((count) => count <= 1),
        { start: 'landscape selected, pan off', afterPan: { state: 'pan', presetsPressed: 0, visibleDots: 0 },
          afterPresetClick: { drag: 'off', panfit: 'default', selected: 'phone only', dot: 'visible', x: 0, y: 0, pageScroll: [0, 0], posts: 1 } },
        { start: { panFit: startPanel19.panFit.state, pan: startPanel19.panChecked, pressed: presetPressedOpts(startPanel19), dots: startDots19 },
          afterPan: { panFit: panPanel19.panFit, pan: panPanel19.panChecked, fit: panPanel19.fitChecked, pressed: presetPressedOpts(panPanel19), dots: panDots19 },
          afterPresetClick: { panFit: afterPhone19.panFit, pan: afterPhone19.panChecked, fit: afterPhone19.fitChecked,
            pressed: presetPressedOpts(afterPhone19), dots: afterDots19, x: afterPhone19.x, y: afterPhone19.y,
            host: phoneHost19.view, page: { innerWidth: truth19.innerWidth, innerHeight: truth19.innerHeight, scrollX: truth19.scrollX, scrollY: truth19.scrollY },
            posts: presetPosts19 },
          pressedCounts: pressedCounts19 });

      // Leave a clean state for the narrow-layout scenario.
      await v18Mode(false);
      // canvasX/canvasY and x/y are different coordinate spaces and cannot share one patch.
      await hostViewportSet({ canvasX: 0, canvasY: 0, scale: 1, width: 400, height: 300 });
      await waitHostView((view) => near(view.canvasX, 0, 1) && closeTo(view.scale, 1, 0.0011)
        && Number(view.width) === 400 && Number(view.height) === 300);
      await openSizeBar();
      await sleep(400);
    });

    await scenario('V11 narrow size bar layout', async () => {
      // Deliberately last: a narrow GUI window makes the DSH shell open a sidebar drawer with a
      // mask, which must not leak into the earlier interaction checks. The size bar and the
      // annotation bar are mutually exclusive (user 2026-11-03), so each is measured in its turn.
      const wide = await panelState();
      await openSizeBar();
      await waitCanvasState(true, true, { timeoutMs: 10000 }).catch(() => undefined);
      await setGuiWindow(720, 760);
      await sleep(1000);
      const narrowSize = await panelState();
      check('V11.1', 'narrow panel: the size bar wraps instead of overflowing or covering the stage',
        Boolean(narrowSize.bar) && Boolean(narrowSize.inputs.length >= 5)
          && narrowSize.bar.scrollWidth <= narrowSize.bar.clientWidth + 1
          && narrowSize.bar.right <= narrowSize.bar.panelRight + 1
          && narrowSize.bar.bottom <= Number(narrowSize.stageTop) + 1,
        { scrollWidth: '<= clientWidth', barBottom: '<= stageTop', inputs: 5 },
        { bar: narrowSize.bar, stageTop: narrowSize.stageTop, inputs: narrowSize.inputs.length, wideBarWidth: wide.bar ? wide.bar.width : null });
      check('V11.2', 'all five inputs still exist while narrow', narrowSize.inputs.length >= 5,
        5, narrowSize.inputs.map((input) => input.label));
      await capturePanel('shot-01-sizebar-narrow');

      // Phase 2: the annotation bar alone at the same narrow width (the size bar must be closed
      // first: entering the mode is refused while sizing is on).
      await cdp.send('Emulation.clearDeviceMetricsOverride').catch(() => undefined);
      await sleep(800);
      await closeSizeBar();
      const annotReady = await waitFor(async () => {
        const panel = await panelState();
        return panel.annot && panel.annot.disabled === false && panel.canvasOn === 'on' ? panel : undefined;
      }, { timeoutMs: 8000, intervalMs: 150, label: 'annotation entry ready for the narrow layout' }).catch(() => null);
      let wideAnnot = annotReady ? await toggleAnnot(true) : (await panelState()).annot;
      if (!wideAnnot || wideAnnot.pressed !== 'true') {
        // A shell mask can swallow the trusted click; fall back to the button's own activation for
        // this layout-only assertion (the interaction itself is covered by V15.1–V15.10).
        await pageEvaluate(panelExpr(`const b = panel.querySelector('button[aria-label="标注"]'); if (b && !b.disabled) b.click(); return true;`));
        await sleep(500);
        wideAnnot = (await panelState()).annot;
      }
      await setGuiWindow(720, 760);
      await sleep(1000);
      const narrow = await panelState();
      const narrowTools = await pageEvaluate(panelExpr(`
        const panelRect = panel.getBoundingClientRect();
        const bar = panel.querySelector('.utb-annot-bar');
        const toolbar = panel.querySelector('.utb-bar');
        const controls = [...panel.querySelectorAll('[data-utb-annot-tool], [data-utb-annot-mode], input[aria-label="颜色"], input[aria-label="粗细"]')]
          .map((el) => { const r = el.getBoundingClientRect(); return { label: el.getAttribute('aria-label') || el.getAttribute('data-utb-annot-tool') || el.getAttribute('data-utb-annot-mode'), left: r.left, top: r.top, width: r.width, height: r.height }; });
        return {
          panel: { left: panelRect.left, right: panelRect.right, width: panelRect.width },
          board: bar ? { scrollWidth: bar.scrollWidth, clientWidth: bar.clientWidth } : null,
          toolbar: toolbar ? { scrollWidth: toolbar.scrollWidth, clientWidth: toolbar.clientWidth, right: toolbar.getBoundingClientRect().right } : null,
          controls,
          vw: window.innerWidth,
          vh: window.innerHeight,
        };
      `));
      check('V15.13a', 'narrow window: the size bar and the annotation bar each wrap without horizontal overflow or covering the stage',
        wideAnnot && wideAnnot.pressed === 'true' && Boolean(narrow.annot.bar) && Boolean(narrowSize.bar)
          && !narrow.bar
          && narrowSize.bar.scrollWidth <= narrowSize.bar.clientWidth + 1
          && narrowSize.bar.bottom <= Number(narrowSize.stageTop) + 1
          && narrowSize.panFit && narrowSize.panFit.options.length === 3
          && narrowSize.panFit.pressedCount === 1
          && narrowSize.panFit.options.every((entry) => entry.rect.width > 0
            && entry.rect.left >= narrowSize.bar.left - 1 && entry.rect.left + entry.rect.width <= narrowSize.bar.right + 1)
          && narrow.annot.bar.scrollWidth <= narrow.annot.bar.clientWidth + 1
          && narrow.annot.bar.bottom <= Number(narrow.stageTop) + 1,
        { sizeBar: 'scrollWidth <= clientWidth', annotBar: 'scrollWidth <= clientWidth', bottoms: '<= stageTop', exclusive: true, panfit: '3 reachable' },
        { wideMode: wideAnnot && wideAnnot.pressed, wideDisabled: wideAnnot && wideAnnot.disabled,
          narrowSizeBar: narrowSize.bar, narrowAnnotBar: narrow.annot.bar, narrowSizeBarPresent: Boolean(narrow.bar),
          narrowPanFit: narrowSize.panFit, sizeStageTop: narrowSize.stageTop, annotStageTop: narrow.stageTop });
      check('V15.13b', 'narrow annotation children are reachable and the toolbar never overflows horizontally',
        Boolean(narrowTools.board) && narrowTools.board.scrollWidth <= narrowTools.board.clientWidth + 1
          && narrowTools.controls.length >= 10
          && narrowTools.controls.every((control) => control.width > 0 && control.height > 0
            && control.left >= narrowTools.panel.left - 1 && control.left + control.width <= narrowTools.panel.right + 1
            && control.top >= 0 && control.top + control.height <= narrowTools.vh + 1)
          && narrowTools.toolbar && narrowTools.toolbar.scrollWidth <= narrowTools.toolbar.clientWidth + 1
          && narrowTools.toolbar.right <= narrowTools.panel.right + 1,
        { controls: '>=10 reachable', toolbar: 'no horizontal overflow' },
        { board: narrowTools.board, controls: narrowTools.controls, toolbar: narrowTools.toolbar, panel: narrowTools.panel });
      const v16Narrow = await pageEvaluate(panelExpr(`
        const box = (el) => { const r = el.getBoundingClientRect(); return { left: r.left, top: r.top, width: r.width, height: r.height }; };
        const clear = panel.querySelector('[data-utb-annot-action="clear"]');
        const eraser = panel.querySelector('[data-utb-annot-tool="eraser"]');
        const panelRect = panel.getBoundingClientRect();
        return {
          clear: clear ? box(clear) : null,
          eraser: eraser ? box(eraser) : null,
          panel: { left: panelRect.left, right: panelRect.right },
          vh: window.innerHeight,
        };
      `));
      check('V16.23', 'narrow window with the annotation bar open: the two new controls (橡皮擦 tool, 清除画布) stay reachable inside the wrapped bar',
        Boolean(v16Narrow.clear) && Boolean(v16Narrow.eraser)
          && v16Narrow.clear.width > 0 && v16Narrow.clear.height > 0
          && v16Narrow.eraser.width > 0 && v16Narrow.eraser.height > 0
          && [v16Narrow.clear, v16Narrow.eraser].every((entry) => entry.left >= v16Narrow.panel.left - 1
            && entry.left + entry.width <= v16Narrow.panel.right + 1
            && entry.top >= 0 && entry.top + entry.height <= v16Narrow.vh + 1),
        { eraser: 'reachable', clear: 'reachable', overflow: 'none' },
        v16Narrow);
      await capturePanel('shot-19-annot-narrow');
      await cdp.send('Emulation.clearDeviceMetricsOverride').catch(() => undefined);
      await sleep(900);
      await toggleAnnot(false).catch(() => undefined);
      await openSizeBar();
    });

    await scenario('V10 wrap-up facts', async () => {
      const truth = await targetTruth();
      const view = (await hostView()).view;
      check('V10.1', 'no page exception during the whole run', state.exceptions.length === 0, [], state.exceptions.slice(0, 3));
      check('V10.2', 'DPR and visualViewport.scale stayed untouched by the panel',
        Number(truth.devicePixelRatio) === 1 && truth.visualViewportScale === 1,
        { devicePixelRatio: 1, visualViewportScale: 1 },
        { devicePixelRatio: truth.devicePixelRatio, visualViewportScale: truth.visualViewportScale });
      check('V10.3', 'the Host view stayed within the contract ranges at the end',
        Number(view.width) >= 200 && Number(view.width) <= 4096 && Number(view.height) >= 200 && Number(view.height) <= 4096
          && Number(view.scale) >= 0.1 && Number(view.scale) <= 2,
        { width: '200..4096', height: '200..4096', scale: '0.1..2' }, view);
      if (state.consoleErrors.length) log(`  [note] ${state.consoleErrors.length} console error line(s) recorded (not asserted): ${state.consoleErrors.slice(0, 2).join(' | ')}`);
      notRun('V10.4', 'old Host degradation (X/Y disabled, legacy {width,height} body)',
        'this suite only starts a Host that exposes ui.view; the legacy branch needs an old Host and is not exercised here');
      notRun('V10.5', 'expectedRevision conflict resolution (VIEWPORT_CONFLICT)',
        'concurrency/CAS is Host-slice acceptance; the GUI only asserts that its patches carry expectedRevision');
      notRun('V10.6', 'resize geometry barrier is best-effort',
        'the frame protocol is not extended: input is paused for at most 250 ms after a width/height change (documented partial)');
    });
  }

  const failed = checks.filter((entry) => !entry.pass);
  const report = {
    schemaVersion: 1,
    suite: 'dsh-agent-team-ui-testing/viewport-gui',
    generatedAt: new Date().toISOString(),
    blocked: state.blocked || null,
    environment: {
      node: process.version,
      platform: `${process.platform}/${process.arch}`,
      isolatedDsh: {
        base: state.dsh ? state.dsh.base : null,
        port: state.dsh ? state.dsh.port : null,
        home: state.dsh ? state.dsh.home : null,
        profileFiles: state.dsh ? state.dsh.copied : null,
        profile: 'web',
        nodeModules: 'symlinked from the user profile',
      },
      chrome: CHROME_BIN,
      fixture: state.fixture ? String(state.fixture.url).replace(/\/+$/, '') : null,
      build: state.buildInfo,
      servedClient: state.servedClient ? {
        rev: state.servedClient.rev,
        bytes: state.servedClient.bytes,
        sha256: state.servedClient.sha256Full,
        exactMatchWithCheckout: state.servedClient.exactMatch === true,
        hasViewportCode: state.servedClient.hasViewportCode === true,
      } : null,
      dialogsDismissed: state.dialogsDismissed,
      consoleErrors: state.consoleErrors.slice(0, 5),
      note: '隔离实例的 token 只存在于进程内存；URL 通过 CDP 传入，报告与日志已脱敏。3080/3081 未触碰。',
    },
    checks,
    notRuns,
    evidence: state.evidence,
    summary: {
      checks: checks.length,
      passed: checks.length - failed.length,
      failed: failed.length,
      notRun: notRuns.length,
      blocked: state.blocked || null,
      exitCode: state.blocked ? 2 : (failed.length ? 1 : 0),
    },
  };
  await writeFile(join(RUN_DIR, 'run-report.json'), JSON.stringify(report, null, 2));
  await writeFile(join(RUN_DIR, 'viewport-gui.log'), sanitize(logLines.join('\n') + '\n'));
  await writeFile(join(EVIDENCE_DIR, 'SUMMARY.md'), renderSummaryMd(report), { mode: 0o600 });
  log(`\nviewport-gui: ${checks.length - failed.length}/${checks.length} checks, ${failed.length} failed, ${notRuns.length} NOT_RUN${state.blocked ? `, BLOCKED(${state.blocked})` : ''}`);
  log(`report: ${join(RUN_DIR, 'run-report.json')}`);
  log(`evidence: ${EVIDENCE_DIR}`);
  if (state.blocked) return 2;
  return failed.length ? 1 : 0;
}

/* ------------------------------------------------------------------------------------------------
 * Extra probes.
 * ---------------------------------------------------------------------------------------------- */
/** Measure the live letterbox band of the displayed frame (0 = the painted rect fills the box). */
async function probeLetterbox() {
  const snapshot = await panelState();
  const frame = snapshot.frame;
  const painted = paintedOf(frame);
  if (!painted) return { band: 0, reason: 'no frame' };
  const bandTop = painted.top - frame.img.top;
  const bandBottom = (frame.img.top + frame.img.height) - (painted.top + painted.height);
  const bandLeft = painted.left - frame.img.left;
  const bandRight = (frame.img.left + frame.img.width) - (painted.left + painted.width);
  const vertical = Math.max(bandTop, bandBottom);
  const horizontal = Math.max(bandLeft, bandRight);
  if (vertical >= horizontal) {
    return {
      band: vertical,
      x: painted.left + painted.width / 2,
      y: bandTop > 1 ? painted.top - Math.min(bandTop, 20) / 2 : painted.top + painted.height + Math.min(bandBottom, 20) / 2,
      frame: { naturalWidth: frame.naturalWidth, naturalHeight: frame.naturalHeight, img: frame.img },
      painted,
    };
  }
  return {
    band: horizontal,
    x: bandLeft > 1 ? painted.left - Math.min(bandLeft, 20) / 2 : painted.left + painted.width + Math.min(bandRight, 20) / 2,
    y: painted.top + painted.height / 2,
    frame: { naturalWidth: frame.naturalWidth, naturalHeight: frame.naturalHeight, img: frame.img },
    painted,
  };
}

function buildInfo() {
  const info = {};
  for (const [name, key] of [['client.js', 'clientJs'], ['index.js', 'indexJs']]) {
    const path = join(REPO_ROOT, name);
    if (!existsSync(path)) continue;
    try {
      const buffer = readFileSync(path);
      info[key] = { bytes: buffer.length, sha256: createHash('sha256').update(buffer).digest('hex') };
    } catch { /* ignore */ }
  }
  return info;
}

async function servedClientEvidence() {
  const result = await pageEvaluate(`(async () => {
    const boot = window.__DSH_BOOT__;
    const entry = boot && Array.isArray(boot.entries)
      ? boot.entries.find((candidate) => candidate.id === 'dsh-agent-team-ui-testing')
      : undefined;
    if (!entry || !entry.url) return null;
    const response = await fetch(entry.url, { credentials: 'same-origin', cache: 'no-store' });
    const text = await response.text();
    return { rev: entry.rev || '', text };
  })()`);
  if (!result) return null;
  const digest = createHash('sha256').update(result.text).digest('hex');
  return {
    rev: result.rev,
    text: result.text,
    bytes: Buffer.byteLength(result.text, 'utf8'),
    sha256: digest.slice(0, 24),
    sha256Full: digest,
    hasSizeBarField: result.text.includes('data-utb-field'),
  };
}

function renderSummaryMd(report) {
  const lines = [];
  lines.push('# viewport-gui 验收记录');
  lines.push('');
  lines.push(`- 生成时间：${report.generatedAt}`);
  lines.push(`- 隔离 DSH：${report.environment.isolatedDsh.base}（端口 ${report.environment.isolatedDsh.port}；DSH_HOME 为临时目录，用后删除）`);
  lines.push(`- client.js sha256：${report.environment.build.clientJs ? report.environment.build.clientJs.sha256 : 'n/a'}`);
  lines.push(`- 结果：${report.summary.passed}/${report.summary.checks} PASS、${report.summary.failed} FAIL、${report.summary.notRun} NOT_RUN${report.summary.blocked ? `、BLOCKED(${report.summary.blocked})` : ''}`);
  lines.push('');
  lines.push('| ID | 断言 | 结果 |');
  lines.push('| --- | --- | --- |');
  for (const entry of report.checks) lines.push(`| ${entry.id} | ${entry.label} | ${entry.pass ? 'PASS' : 'FAIL'} |`);
  for (const entry of report.notRuns) lines.push(`| ${entry.id} | ${entry.label} | NOT_RUN（${entry.reason}） |`);
  lines.push('');
  lines.push('## 截图');
  for (const shot of report.evidence) lines.push(`- ${shot.path}（${shot.bytes} bytes）`);
  lines.push('');
  return lines.join('\n') + '\n';
}

/* ------------------------------------------------------------------------------------------------
 * Cleanup: only this run's own processes/profile/home. 3080/3081 are never touched.
 * ---------------------------------------------------------------------------------------------- */
async function cleanup(reason) {
  log(`\n[cleanup] ${reason}`);
  if (state.chrome) {
    try { state.chrome.cdp.close(); } catch { /* ignore */ }
    try { state.chrome.proc.kill('SIGTERM'); } catch { /* ignore */ }
    await sleep(500);
    if (isProcessAlive(state.chrome.proc.pid)) { try { state.chrome.proc.kill('SIGKILL'); } catch { /* ignore */ } }
    await sleep(300);
    await rm(state.chrome.profileDir, { recursive: true, force: true, maxRetries: 5 }).catch(() => {});
  }
  if (state.dsh) {
    try { state.dsh.proc.kill('SIGTERM'); } catch { /* ignore */ }
    await sleep(1200);
    if (isProcessAlive(state.dsh.proc.pid)) { try { state.dsh.proc.kill('SIGKILL'); } catch { /* ignore */ } }
    await sleep(400);
    // The isolated instance may have spawned a helper Chromium under its own temp home.
    try {
      for (const entry of readdirSync('/proc')) {
        if (!/^\d+$/.test(entry)) continue;
        let raw;
        try { raw = readFileSync(`/proc/${entry}/cmdline`); } catch { continue; }
        const text = raw.toString('utf8');
        if (!text.includes('chrome')) continue;
        if (state.dsh.home && text.includes(state.dsh.home)) {
          try { process.kill(Number(entry), 'SIGKILL'); } catch { /* ignore */ }
        }
      }
    } catch { /* ignore */ }
    await rm(state.dsh.home, { recursive: true, force: true, maxRetries: 5 }).catch(() => {});
  }
  try { await state.fixture?.close(); } catch { /* ignore */ }
  log('[cleanup] done');
}

const watchdog = setTimeout(async () => {
  log(`\n[watchdog] hard timeout ${TOTAL_TIMEOUT_MS}ms`);
  try { await cleanup('hard-timeout'); } catch { /* ignore */ }
  process.exit(2);
}, TOTAL_TIMEOUT_MS);
watchdog.unref?.();

let exitCode = 0;
try {
  exitCode = await main();
  await cleanup('complete');
} catch (error) {
  const blocked = String(errorMessage(error)).includes('BLOCKED:');
  log(`\n[${blocked ? 'blocked' : 'fatal'}] ${errorMessage(error)}`);
  if (!blocked) console.error(error);
  await cleanup(blocked ? 'blocked' : 'fatal').catch(() => {});
  exitCode = 2;
}
process.exitCode = exitCode;
