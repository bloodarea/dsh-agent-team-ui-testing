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
 *   - GUI screenshots are written under tests/acceptance/evidence/viewport-gui-<stamp>/.
 *
 * NOT covered here (reported, never implied as verified):
 *   - Old-Host degradation (X/Y disabled, legacy `{width,height}` body): this suite only runs a
 *     Host that exposes `ui.view`, so the legacy branch is recorded NOT_RUN.
 *   - The single-owner lease / BUSY concurrency and the `expectedRevision` conflict path are
 *     Host-slice acceptance items; this suite only asserts that GUI patches carry a revision.
 *   - The resize geometry barrier is best-effort (≤250ms, no frame-protocol extension): the
 *     letterbox band probe is recorded NOT_APPLICABLE when the live frame has no letterbox.
 *   - The 3080/3081 instances are never touched.
 *
 * Run:  node tests/acceptance/viewport-gui.mjs
 * Env:  DSH_BIN (default `dsh`), DSH_ACCEPTANCE_CHROME / DSH_REAL_BROWSER_CHROME
 *         (default tests/acceptance/chrome-wrapper.sh), DSH_VIEWPORT_GUI_TIMEOUT_MS (default 420000),
 *       DSH_VIEWPORT_GUI_EVIDENCE (override the evidence directory).
 *
 * Exit codes: 0 all checks pass (an environment NOT_RUN may still be recorded); 1 assertion
 *             failure; 2 blocked (the isolated Host does not expose ui.view) or fatal error.
 */
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
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
  return { home, profileDir, copied };
}

async function startIsolatedDsh() {
  const { home, profileDir, copied } = await prepareDshHome();
  const port = await pickPort();
  const proc = spawn(DSH_BIN, ['web', '--port', String(port), '--no-open'], {
    env: {
      ...process.env,
      DSH_HOME: home,
      DSH_PROFILE: 'web',
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
    }));
    const byLabel = {};
    for (const input of inputs) if (input.label) byLabel[input.label] = input;
    const bar = panel.querySelector('.utb-size');
    const check = panel.querySelector('.utb-check input');
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
      fitChecked: check ? check.checked : null,
      fitTitle: panel.querySelector('.utb-check') ? panel.querySelector('.utb-check').title : null,
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
      frame,
    };
  `));
}

async function openSizeBar() {
  await pageEvaluate(panelExpr(`
    const button = panel.querySelector('button[aria-label="尺寸调整"]');
    if (button && button.getAttribute('aria-pressed') !== 'true') button.click();
    return true;
  `));
  await waitFor(async () => ((await panelState()).sizeBar ? true : undefined), { timeoutMs: 5000, intervalMs: 100, label: 'size bar visible' });
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
  let rect = await fieldRect(label);
  await ensureFieldHit({ label, field: await fieldKeyOf(label) }, rect);
  rect = await fieldRect(label);
  await clickAt(rect.x, rect.y);
  await sleep(120);
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

/** Real wheel event over a size-bar field (CDP modifiers: Alt=1, Ctrl=2, Meta=4, Shift=8). */
async function wheelOnField(label, deltaY, modifiers = 0, { settle = true } = {}) {
  let rect = await fieldRect(label);
  const guard = await ensureFieldHit({ label, field: await fieldKeyOf(label) }, rect);
  rect = await fieldRect(label);
  if (!guard.ok) log(`  [warn] wheel target for ${label} is covered by ${guard.last}`);
  await sleep(40);
  // Chromium routes a wheel event to the *hovered* node, so the pointer must be moved first.
  await state.chrome.cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: rect.x, y: rect.y, button: 'none', buttons: 0 });
  await sleep(30);
  await state.chrome.cdp.send('Input.dispatchMouseEvent', { type: 'mouseWheel', x: rect.x, y: rect.y, deltaX: 0, deltaY, modifiers });
  if (settle) await sleep(STEP_SETTLE_MS);
  return rect;
}

/** A burst of wheel notches inside one 120ms window (proves the debounce merge). */
async function wheelBurst(label, count, deltaY, modifiers = 0) {
  let rect = await fieldRect(label);
  await ensureFieldHit({ label, field: await fieldKeyOf(label) }, rect);
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

/** Real wheel event over the displayed frame (same hover precondition). */
async function wheelOnFramePoint(point, deltaY) {
  await state.chrome.cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: point.x, y: point.y, button: 'none', buttons: 0 });
  await sleep(30);
  await state.chrome.cdp.send('Input.dispatchMouseEvent', { type: 'mouseWheel', x: point.x, y: point.y, deltaX: 0, deltaY, modifiers: 0 });
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
    const box = panel.querySelector('.utb-check input');
    if (!box) return false;
    if (box.checked !== ${Boolean(checked)}) box.click();
    return true;
  `));
  await sleep(STEP_SETTLE_MS);
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
    const panelRect = panel.getBoundingClientRect();
    const stageRect = stage ? stage.getBoundingClientRect() : null;
    const barRect = bar ? bar.getBoundingClientRect() : null;
    return {
      panel: panelRect.toJSON(),
      stage: stageRect ? stageRect.toJSON() : null,
      bar: barRect ? barRect.toJSON() : null,
      vw: window.innerWidth,
      vh: window.innerHeight,
    };
  `)).catch(() => null);
  const shot = await (async () => {
    if (!raw || raw.missing || !raw.panel) return null;
    const top = raw.bar ? raw.bar.top : raw.panel.top;
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
  const k = Math.min(frame.img.width / frame.naturalWidth, frame.img.height / frame.naturalHeight);
  const width = frame.naturalWidth * k;
  const height = frame.naturalHeight * k;
  return {
    left: frame.img.left + (frame.img.width - width) / 2,
    top: frame.img.top + (frame.img.height - height) / 2,
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
  const center = await elementCenter(selector);
  const mapped = guiPointFor(paintedOf(await waitForFrame()), viewWidth, viewHeight, center.x, center.y);
  await ensurePointVisible(mapped);
  const painted = paintedOf(await waitForFrame());
  const point = guiPointFor(painted, viewWidth, viewHeight, center.x, center.y);
  await resetTargetInstrumentation();
  const clicksBefore = await targetEval('window.__t3 ? window.__t3.counters.clicks : -1');
  await clickAt(point.x, point.y);
  await sleep(800);
  const clicksAfter = await targetEval('window.__t3 ? window.__t3.counters.clicks : -1');
  const record = await targetEval(`(() => {
    if (!window.__t3) return null;
    const clicks = window.__t3.events.filter((event) => event.type === 'click');
    return clicks.length ? clicks[clicks.length - 1] : null;
  })()`);
  return {
    clicksDelta: Number(clicksAfter) - Number(clicksBefore),
    record: record ? { isTrusted: record.isTrusted, clientX: record.clientX, clientY: record.clientY, target: record.target } : null,
    viewportX: center.x,
    viewportY: center.y,
    point,
    painted,
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
        check('V3.1', 'a default Host view publishes the local default 393×852 exactly once',
          posts.length === 1 && Number(bodies[0].width) === 393 && Number(bodies[0].height) === 852,
          [{ width: 393, height: 852 }], bodies);
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

    await scenario('V11 narrow size bar layout', async () => {
      // Deliberately last: a narrow GUI window makes the DSH shell open a sidebar drawer with a
      // mask, which must not leak into the earlier interaction checks.
      const wide = await panelState();
      try {
        await setGuiWindow(720, 760);
        await sleep(1000);
        await openSizeBar();
        const narrow = await panelState();
        check('V11.1', 'narrow panel: the size bar wraps instead of overflowing or covering the stage',
          Boolean(narrow.bar) && Boolean(narrow.inputs.length >= 5)
            && narrow.bar.scrollWidth <= narrow.bar.clientWidth + 1
            && narrow.bar.right <= narrow.bar.panelRight + 1
            && narrow.bar.bottom <= Number(narrow.stageTop) + 1,
          { scrollWidth: '<= clientWidth', barBottom: '<= stageTop', inputs: 5 },
          { bar: narrow.bar, stageTop: narrow.stageTop, inputs: narrow.inputs.length, wideBarWidth: wide.bar ? wide.bar.width : null });
        check('V11.2', 'all five inputs still exist while narrow', narrow.inputs.length >= 5,
          5, narrow.inputs.map((input) => input.label));
        await capturePanel('shot-01-sizebar-narrow');
      } finally {
        await cdp.send('Emulation.clearDeviceMetricsOverride').catch(() => undefined);
        await sleep(900);
        await openSizeBar();
      }
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
