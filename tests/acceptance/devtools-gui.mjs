#!/usr/bin/env node
/**
 * Real-GUI acceptance for the DevTools popup (docs/internal/devtools-popup.md §5, G01–G07).
 *
 * Builds its OWN isolated DSH web instance: fresh temporary DSH_HOME, copied web-profile config,
 * a read-only node_modules symlink, an ephemeral loopback port (never 3080/3081) and `--no-open`.
 * The launch token is read from the instance's own stdout and never printed, logged or reported.
 *
 * What it proves against the real shell/panel (separate headless Chromium over CDP):
 *   - opening `更多 → 调试视图` renders the panel from the current checkout (served client.js has
 *     the DevTools menu code);
 *   - the "打开调试工具" item is disabled with data-utb-devtools=disabled while the runtime is cold,
 *     and enabled after the panel's address bar navigates to the local fixture page;
 *   - a real trusted click opens a new target in the *GUI* browser whose URL is the Host-provided
 *     inspector URL for the current page; in that target window.opener===null,
 *     document.referrer==='' and the recursive shadow DOM contains the fixture's unique MARKER;
 *   - the Host did not gain a page target (the popup is a user-browser page, not a Host page);
 *   - the panel preview / Host frame seq keeps advancing while DevTools is open and after closing;
 *   - overriding window.open to return null produces only the local role=status hint and the
 *     "在新标签页打开调试工具" link; Runtime lastError is unchanged; no retry storm;
 *   - annotation mode disables the whole 更多 menu and never opens a window.
 *   - a non-loopback GUI hostname is NOT_RUN (would need a proxy/host alias; never faked).
 *
 * Run:  node tests/acceptance/devtools-gui.mjs
 * Env:  DSH_BIN (default `dsh`), DSH_ACCEPTANCE_CHROME / DSH_REAL_BROWSER_CHROME
 *         (default tests/acceptance/chrome-wrapper.sh), DSH_DEVTOOLS_GUI_TIMEOUT_MS (default 360000).
 * Exit codes: 0 pass (environment NOT_RUN may still be recorded), 1 assertion failure, 2 blocked/fatal.
 * Evidence: tests/acceptance/runs/devtools-gui-<stamp>/ and tests/acceptance/evidence/devtools-gui-<stamp>/.
 */
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { createServer as createHttpServer } from 'node:http';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = dirname(dirname(HERE));
const STAMP = new Date().toISOString().replace(/[:.]/g, '-');
const RUN_DIR = join(HERE, 'runs', `devtools-gui-${STAMP}-${process.pid}`);
const EVIDENCE_DIR = join(HERE, 'evidence', `devtools-gui-${STAMP}`);
const DEFAULT_PROFILE = join(process.env.HOME || '', '.dsh', 'profiles', 'web');
const CHROME_BIN = process.env.DSH_ACCEPTANCE_CHROME || process.env.DSH_REAL_BROWSER_CHROME || join(HERE, 'chrome-wrapper.sh');
const DSH_BIN = process.env.DSH_BIN || 'dsh';
const CHROME_PROFILE_PREFIX = 'dsh-devtools-gui-';
const DSH_HOME_PREFIX = 'dsh-devtools-gui-home-';
const TOTAL_TIMEOUT_MS = Number(process.env.DSH_DEVTOOLS_GUI_TIMEOUT_MS || 360000) || 360000;

const logLines = [];
function log(line = '') {
  const text = String(line);
  logLines.push(text);
  console.log(text);
}
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const errorMessage = (error) => String((error && error.stack) || (error && error.message) || error);

const state = { token: '', cookie: '', chrome: undefined, fixture: undefined, dsh: undefined, scopeHeaders: null, requests: [], responses: [], exceptions: [], consoleErrors: [], evidence: [], popup: undefined };
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
      } catch (error) { lastError = error; }
      if (Date.now() - started >= timeoutMs) {
        return reject(new Error(`timed out after ${timeoutMs}ms waiting for ${label}${lastError ? ` (last: ${errorMessage(lastError)})` : ''}`));
      }
      setTimeout(tick, intervalMs);
    };
    tick();
  });
}
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
 * Checks / NOT_RUN.
 * ---------------------------------------------------------------------------------------------- */
const checks = [];
const notRuns = [];
const observations = {};
function safeValue(value) {
  try {
    const text = JSON.stringify(value);
    return text === undefined ? String(value) : JSON.parse(text.replace(/[\u2028\u2029]/g, ' '));
  } catch { return String(value); }
}
function check(id, label, pass, expected, actual) {
  checks.push({ id, label, pass: Boolean(pass), expected: safeValue(expected), actual: safeValue(actual) });
  log(`  [${pass ? 'PASS' : 'FAIL'}] ${id} ${label}`);
  if (!pass) log(`         expected: ${JSON.stringify(expected)}\n         actual  : ${JSON.stringify(actual)}`);
}
function notRun(id, label, reason, detail) {
  notRuns.push({ id, label, reason: String(reason), detail: safeValue(detail) });
  log(`  [NOT_RUN] ${id} ${label} — ${reason}`);
}

/* ------------------------------------------------------------------------------------------------
 * CDP client (Node 22 global WebSocket).
 * ---------------------------------------------------------------------------------------------- */
class Cdp {
  constructor(url) { this.url = url; this.nextId = 1; this.pending = new Map(); this.listeners = new Set(); this.closed = false; }
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
        if (this.pending.has(id)) { this.pending.delete(id); reject(new Error('cdp timeout: ' + method)); }
      }, timeoutMs);
      timer.unref?.();
    });
  }
  on(listener) { this.listeners.add(listener); return () => this.listeners.delete(listener); }
  close() { try { if (this.ws) this.ws.close(); } catch { /* ignore */ } }
}

async function launchChrome(bin) {
  const profileDir = await mkdtemp(join(tmpdir(), CHROME_PROFILE_PREFIX));
  const proc = spawn(bin, [
    '--headless=new', '--remote-debugging-port=0', `--user-data-dir=${profileDir}`,
    '--no-first-run', '--no-default-browser-check', '--disable-gpu', '--hide-scrollbars',
    '--mute-audio', '--window-size=1440,900', 'about:blank',
  ], { stdio: ['ignore', 'ignore', 'pipe'] });
  let stderr = '';
  proc.stderr.on('data', (chunk) => { stderr = (stderr + String(chunk)).slice(-2000); });
  try {
    const devtoolsPort = await waitFor(async () => {
      try {
        const text = await readFile(join(profileDir, 'DevToolsActivePort'), 'utf8');
        const port = Number(text.split('\n')[0]);
        return port > 0 ? port : undefined;
      } catch { return undefined; }
    }, { timeoutMs: 20000, label: 'GUI Chromium DevToolsActivePort' });
    const list = await fetch(`http://127.0.0.1:${devtoolsPort}/json/list`).then((response) => response.json());
    const page = list.find((target) => target.type === 'page');
    if (!page) throw new Error('no page target in GUI chromium');
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
      ? result.exceptionDetails.exception.description : result.exceptionDetails.text;
    throw new Error('GUI evaluation failed: ' + String(text).slice(0, 500));
  }
  return result.result ? result.result.value : undefined;
}

/* ------------------------------------------------------------------------------------------------
 * Isolated DSH (same isolation as viewport-gui.mjs; never 3080/3081).
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
  proc.on('exit', (code, signal) => log(`[dsh] exited code=${code} signal=${signal}`));
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
}
async function ensureLeftSidebar() {
  const expanded = await pageEvaluate(`(() => {
    if (document.querySelector('button[aria-label="收起侧边栏"]')) return true;
    const expand = document.querySelector('button[aria-label="展开侧边栏"]');
    if (expand) { expand.click(); return false; }
    return false;
  })()`);
  if (!expanded) await sleep(400);
}
async function openPanel() {
  await dismissShellDialogs();
  await ensureLeftSidebar();
  await waitFor(async () => {
    const clicked = await pageEvaluate(`(() => {
      const button = document.querySelector('button[aria-label="更多"]:not(.utb-btn)');
      if (!button) return 'no-more';
      button.click();
      return 'clicked';
    })()`);
    if (clicked !== 'clicked') return undefined;
    await sleep(350);
    return pageEvaluate(`(() => {
      const direct = [...document.querySelectorAll('.utb-menu-row')].find((el) => (el.textContent || '').includes('调试视图'));
      const fallback = direct || [...document.querySelectorAll('button, a, [role="menuitem"]')]
        .find((el) => (el.textContent || '').trim() === '调试视图');
      if (!fallback) return false;
      fallback.click();
      return true;
    })()`);
  }, { timeoutMs: 15000, intervalMs: 200, label: '更多 → 调试视图' });
  await waitFor(async () => pageEvaluate(`!!document.querySelector('.utb')`), { timeoutMs: 15000, label: 'debug panel mounted' });
}

function hookNetworkEvents() {
  state.chrome.cdp.on((message) => {
    if (message.method === 'Network.requestWillBeSent') {
      const request = message.params.request || {};
      const headers = request.headers || {};
      const url = String(request.url || '');
      state.requests.push({ at: Date.now(), requestId: message.params.requestId, url, method: String(request.method || ''), headers });
      if (!state.scopeHeaders && url.includes('/plugins/ui-testing/state')) {
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
          log('[env] panel scope captured');
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
  for (const [key, value] of Object.entries(headers)) if (String(key).toLowerCase() === name) return String(value);
  return '';
}

async function pageHostFetch(path, { method = 'GET', headers = {}, body } = {}) {
  const url = '/plugins/ui-testing' + path;
  const expression = `(async () => {
    const response = await fetch(${JSON.stringify(url)}, {
      method: ${JSON.stringify(method)},
      headers: ${JSON.stringify(headers)},
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

/* Real trusted mouse click at viewport coordinates. */
async function clickAt(x, y) {
  await state.chrome.cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y, button: 'none', buttons: 0 });
  await state.chrome.cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', buttons: 1, clickCount: 1 });
  await state.chrome.cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', buttons: 0, clickCount: 1 });
  await sleep(120);
}
async function centerOf(selectorExpression) {
  const rect = await pageEvaluate(`(() => {
    const el = ${selectorExpression};
    if (!el) return null;
    const r = el.getBoundingClientRect();
    if (r.width <= 0 || r.height <= 0) return null;
    return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
  })()`);
  if (!rect) throw new Error('element not visible: ' + selectorExpression);
  return rect;
}
const MORE_SELECTOR = `document.querySelector('.utb-more button[aria-label="更多"]')`;
const DEVTOOLS_ITEM_SELECTOR = `[...document.querySelectorAll('.utb-menu-item')].find((el) => (el.textContent || '').trim() === '打开调试工具')`;
async function openMoreMenu() {
  const open = await pageEvaluate(`(() => { const b = ${MORE_SELECTOR}; if (!b) return 'missing'; if (b.disabled) return 'disabled'; b.click(); return 'clicked'; })()`);
  if (open !== 'clicked') throw new Error('cannot open panel 更多 menu: ' + open);
  await waitFor(async () => pageEvaluate(`!!${DEVTOOLS_ITEM_SELECTOR}`), { timeoutMs: 5000, label: 'devtools menu item' });
}
async function menuItemState() {
  return pageEvaluate(`(() => {
    const el = ${DEVTOOLS_ITEM_SELECTOR};
    if (!el) return null;
    return { disabled: el.disabled === true, title: el.title || '', data: el.getAttribute('data-utb-devtools') };
  })()`);
}
async function closeMenuIfOpen() {
  const open = await pageEvaluate(`!!${DEVTOOLS_ITEM_SELECTOR}`);
  if (!open) return;
  await pageEvaluate(`(() => { const b = ${MORE_SELECTOR}; if (b) b.click(); })()`);
  await sleep(150);
}

async function setAddressBar(url) {
  const rect = await centerOf(`document.querySelector('.utb-addr')`);
  await clickAt(rect.x, rect.y);
  await state.chrome.cdp.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'a', code: 'KeyA', windowsVirtualKeyCode: 65, modifiers: 2 });
  await state.chrome.cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'a', code: 'KeyA', windowsVirtualKeyCode: 65, modifiers: 2 });
  await state.chrome.cdp.send('Input.insertText', { text: url });
  await sleep(150);
  let value = await pageEvaluate(`document.querySelector('.utb-addr') ? document.querySelector('.utb-addr').value : null`);
  if (value !== url) {
    // Keyboard input can be swallowed by a controlled input in some shells: fall back to the
    // native value setter + a real input event so React's onChange updates the draft.
    value = await pageEvaluate(`(() => {
      const input = document.querySelector('.utb-addr');
      if (!input) return null;
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
      setter.call(input, ${JSON.stringify(url)});
      input.dispatchEvent(new Event('input', { bubbles: true }));
      return input.value;
    })()`);
    await sleep(150);
  }
  const pressEnter = async () => {
    await state.chrome.cdp.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13 });
    await state.chrome.cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13 });
  };
  await pressEnter();
  const changed = await waitFor(async () => {
    const snapshot = await hostState();
    return String(snapshot.ui?.address || '') === url ? snapshot : undefined;
  }, { timeoutMs: 2500, intervalMs: 150, label: 'address-bar submit' }).catch(() => undefined);
  if (!changed) {
    // Last resort: submit the same form the Enter key would have submitted.
    await pageEvaluate(`(async () => {
      const input = document.querySelector('.utb-addr');
      const form = input && input.closest('form');
      if (form) form.requestSubmit();
      await new Promise((resolve) => setTimeout(resolve, 50));
      return true;
    })()`);
  }
  observations.addressBar = {
    typed: url,
    inputValue: value,
    alert: await pageEvaluate(`(() => { const el = document.querySelector('.utb-sr[role="alert"]'); return el ? el.textContent : ''; })()`),
  };
  await sleep(200);
}

async function guiPageTargets() {
  const list = await fetch(`http://127.0.0.1:${state.chrome.devtoolsPort}/json/list`).then((response) => response.json());
  return list.filter((target) => target.type === 'page');
}
async function hostDebuggerPages() {
  const snapshot = await hostState();
  const url = snapshot?.ui?.devtools?.url;
  if (!url) return { port: 0, pages: [], devtools: snapshot?.ui?.devtools };
  const port = Number(new URL(url).port);
  const list = await fetch(`http://127.0.0.1:${port}/json/list`).then((response) => response.json());
  return { port, pages: list.filter((target) => target.type === 'page'), devtools: snapshot.ui.devtools };
}
async function closeGuiTarget(targetId) {
  const version = await fetch(`http://127.0.0.1:${state.chrome.devtoolsPort}/json/version`).then((response) => response.json());
  const browser = new Cdp(version.webSocketDebuggerUrl);
  await browser.connect();
  try { await browser.send('Target.closeTarget', { targetId }); } finally { browser.close(); }
}
async function captureGuiPng(name) {
  const shot = await state.chrome.cdp.send('Page.captureScreenshot', { format: 'png' });
  const buffer = Buffer.from(shot.data, 'base64');
  await writeFile(join(EVIDENCE_DIR, name), buffer);
  await writeFile(join(RUN_DIR, name), buffer);
  state.evidence.push({ name, bytes: buffer.length });
  return buffer.length;
}

/* ------------------------------------------------------------------------------------------------
 * Main.
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

  const MARKER = 'DEVTOOLS_GUI_MARKER_' + Date.now().toString(36);
  state.fixture = createHttpServer((req, res) => {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
    res.end(`<!doctype html><html><head><meta charset="utf-8"><title>devtools gui fixture</title></head>
<body><h1 id="marker">${MARKER}</h1><div id="tick">0</div>
<script>setInterval(() => { const t = document.getElementById('tick'); t.textContent = String(Number(t.textContent) + 1); }, 50);</script>
</body></html>`);
  });
  await new Promise((resolve) => state.fixture.listen(0, '127.0.0.1', resolve));
  const fixtureUrl = `http://127.0.0.1:${state.fixture.address().port}/`;
  observations.fixtureUrl = fixtureUrl;
  observations.marker = MARKER;

  const { scanPluginChromeProcesses } = await import(join(HERE, 'harness.mjs'));
  const baselineChromes = scanPluginChromeProcesses().map((entry) => entry.pid);
  const cleanup = async (reason) => {
    log(`\n[cleanup] ${reason}`);
    if (state.popup) { try { state.popup.close(); } catch { /* ignore */ } state.popup = undefined; }
    if (state.chrome) {
      try { state.chrome.cdp.close(); } catch { /* ignore */ }
      try { state.chrome.proc.kill('SIGTERM'); } catch { /* ignore */ }
      await sleep(500);
      try { state.chrome.proc.kill('SIGKILL'); } catch { /* ignore */ }
      await rm(state.chrome.profileDir, { recursive: true, force: true, maxRetries: 5 }).catch(() => {});
      state.chrome = undefined;
    }
    // Kill the isolated Host first, then reap the plugin Chromium it spawned. The child can be
    // created while the Host is already shutting down, so scan a few times with a bounded wait
    // instead of scanning once (a single scan leaves a late Chrome behind).
    const reapPluginChromium = async () => {
      let killed = 0;
      for (const entry of scanPluginChromeProcesses()) {
        if (baselineChromes.includes(entry.pid)) continue;
        if (!String(entry.profileDir).includes('dsh-ui-testing-')) continue;
        try { process.kill(entry.pid, 'SIGKILL'); killed += 1; log(`[cleanup] killed leftover plugin Chromium pid=${entry.pid}`); } catch { /* ignore */ }
        await rm(entry.profileDir, { recursive: true, force: true }).catch(() => {});
      }
      return killed;
    };
    if (state.dsh) {
      try { state.dsh.proc.kill('SIGTERM'); } catch { /* ignore */ }
      await sleep(800);
      try { state.dsh.proc.kill('SIGKILL'); } catch { /* ignore */ }
      await rm(state.dsh.home, { recursive: true, force: true, maxRetries: 5 }).catch(() => {});
      state.dsh = undefined;
    }
    if (state.fixture) { await new Promise((resolve) => state.fixture.close(resolve)); state.fixture = undefined; }
    for (let round = 0; round < 3; round += 1) {
      if (await reapPluginChromium() === 0) break;
      await sleep(500);
    }
    await sleep(500);
    await reapPluginChromium();
  };

  try {
    log(`[env] fixture: ${fixtureUrl}`);
    log(`[env] chrome: ${CHROME_BIN}`);
    const dsh = await startIsolatedDsh();
    log(`[env] isolated DSH: ${dsh.base} (port ${dsh.port}); DSH_HOME is a temporary directory`);
    observations.isolatedDsh = { base: dsh.base, port: dsh.port, copied: dsh.copied };
    const cookies = await authenticate(dsh.launchUrl);
    state.chrome = await launchChrome(CHROME_BIN);
    const { cdp } = state.chrome;
    await cdp.send('Page.enable');
    await cdp.send('Runtime.enable');
    await cdp.send('Network.enable');
    hookNetworkEvents();
    log(`[env] GUI chromium devtools port ${state.chrome.devtoolsPort}`);
    for (const cookie of cookies) {
      const eq = cookie.indexOf('=');
      await cdp.send('Network.setCookie', { name: cookie.slice(0, eq), value: cookie.slice(eq + 1), url: new URL(dsh.base).origin + '/' });
    }
    await cdp.send('Page.navigate', { url: dsh.launchUrl });
    await guiReady(45000);
    const location = await pageEvaluate('location.href');
    check('G0.1', 'isolated DSH GUI loads from an ephemeral non-3080/3081 port',
      dsh.port !== 3080 && dsh.port !== 3081 && String(location).startsWith(dsh.base), { base: dsh.base }, { location, port: dsh.port });
    check('G0.2', 'launch token is exchanged away and never appears in the run log',
      !String(location).includes('token=') && !logLines.join('\n').includes(state.token), { tokenInLocation: false, tokenInLog: false },
      { location: sanitize(location) });
    const served = await pageEvaluate(`(async () => {
      const boot = window.__DSH_BOOT__;
      const entry = boot && Array.isArray(boot.entries) ? boot.entries.find((candidate) => candidate.id === 'dsh-agent-team-ui-testing') : undefined;
      if (!entry || !entry.url) return null;
      const response = await fetch(entry.url, { credentials: 'same-origin', cache: 'no-store' });
      return { rev: entry.rev || '', text: await response.text() };
    })()`);
    const servedDigest = served ? createHash('sha256').update(served.text).digest('hex') : '';
    const servedHasDevtools = Boolean(served && served.text.includes('data-utb-devtools') && served.text.includes('打开调试工具'));
    observations.servedClient = { rev: served?.rev || '', bytes: served ? Buffer.byteLength(served.text, 'utf8') : 0, sha256: servedDigest.slice(0, 24), hasDevtoolsCode: servedHasDevtools };
    check('G0.3', 'GUI serves this checkout client.js with the DevTools menu code', servedHasDevtools, true, observations.servedClient);

    log('\n--- G1 panel + cold menu ---');
    await openPanel();
    await waitFor(() => state.scopeHeaders, { timeoutMs: 10000, label: 'panel scope headers' });
    check('G1.1', 'debug panel is open (更多 → 调试视图)', await pageEvaluate(`!!document.querySelector('.utb')`), true, true);
    check('G1.2', 'panel renders without a page exception', state.exceptions.length === 0, [], state.exceptions.slice(0, 3));

    // The panel may materialise a cold binding with /ensure on mount. That is a real page, so the
    // item is legitimately enabled; force a genuine cold runtime via the authenticated /close and
    // then assert the disabled projection. Both facts are recorded instead of faking "cold".
    let beforeCold = await hostState().catch(() => null);
    observations.initialRuntime = { running: beforeCold?.running, devtools: beforeCold?.ui?.devtools };
    if (beforeCold?.running) {
      const closed = await pageHostFetch('/close', { method: 'POST', headers: Object.assign({ 'content-type': 'application/json' }, requireScope()), body: {} });
      log(`[env] panel auto-ensure created a page; POST /close -> ${closed.status}`);
      await waitFor(async () => { const snapshot = await hostState(); return snapshot.running === false ? snapshot : undefined; },
        { timeoutMs: 10000, label: 'cold runtime after /close' });
    }
    await openMoreMenu();
    const coldItem = await menuItemState();
    observations.coldMenuItem = coldItem;
    check('G1.3', 'cold runtime: "打开调试工具" is disabled with data-utb-devtools=disabled',
      coldItem?.disabled === true && coldItem?.data === 'disabled', { disabled: true, data: 'disabled' }, coldItem);
    check('G1.4', 'cold runtime title asks to open a page first',
      String(coldItem?.title || '').includes('请先在调试视图中打开页面'), '请先在调试视图中打开页面', coldItem?.title);
    await closeMenuIfOpen();

    log('\n--- G2 address-bar navigation -> enabled ---');
    await setAddressBar(fixtureUrl);
    await waitFor(async () => {
      const snapshot = await hostState();
      return snapshot.running === true && String(snapshot.ui?.address || '') === fixtureUrl ? snapshot : undefined;
    }, { timeoutMs: 20000, label: 'panel navigation to fixture' });
    await waitFor(async () => pageEvaluate(`(() => { const img = document.querySelector('.utb-frame'); return Boolean(img && img.naturalWidth > 0); })()`),
      { timeoutMs: 20000, label: 'panel preview frame decoded' }).catch(() => {});
    await openMoreMenu();
    const readyItem = await menuItemState();
    observations.readyMenuItem = readyItem;
    check('G2.1', 'after navigating to a page: item enabled with data-utb-devtools=ready',
      readyItem?.disabled === false && readyItem?.data === 'ready', { disabled: false, data: 'ready' }, readyItem);
    check('G2.2', 'enabled title explains the independent window and automation impact',
      String(readyItem?.title || '').includes('在独立窗口中调试当前页面'), '在独立窗口中调试当前页面', readyItem?.title);
    const hostPagesBefore = await hostDebuggerPages();
    const guiTargetsBefore = await guiPageTargets();
    check('G2.3', 'Host has exactly one owned page target before opening DevTools', hostPagesBefore.pages.length === 1,
      1, hostPagesBefore.pages.map((page) => page.url));

    log('\n--- G3 real click opens the DevTools window ---');
    const itemCenter = await centerOf(DEVTOOLS_ITEM_SELECTOR);
    await clickAt(itemCenter.x, itemCenter.y);
    const popupTarget = await waitFor(async () => {
      const targets = await guiPageTargets();
      return targets.find((target) => String(target.url || '').includes('/devtools/inspector.html')) || undefined;
    }, { timeoutMs: 15000, intervalMs: 250, label: 'DevTools popup target in the GUI browser' });
    observations.popupTarget = { url: popupTarget.url, id: popupTarget.id };
    const devtoolsUrl = new URL(hostPagesBefore.devtools.url);
    check('G3.1', 'a new target exists in the GUI browser at the exact Host inspector URL',
      popupTarget.url === hostPagesBefore.devtools.url
      && new URL(popupTarget.url).port === devtoolsUrl.port && new URL(popupTarget.url).pathname === '/devtools/inspector.html',
      { url: hostPagesBefore.devtools.url, port: devtoolsUrl.port, pathname: '/devtools/inspector.html' }, popupTarget.url);
    check('G3.2', 'popup target is a user-browser page, not a Host page',
      !hostPagesBefore.pages.some((page) => page.id === popupTarget.id),
      { inHost: false }, { popupId: popupTarget.id, hostIds: hostPagesBefore.pages.map((page) => page.id) });
    state.popup = new Cdp(popupTarget.webSocketDebuggerUrl);
    await state.popup.connect();
    await state.popup.send('Page.enable');
    await state.popup.send('Runtime.enable');
    await waitFor(async () => {
      const ready = await state.popup.send('Runtime.evaluate', { expression: 'document.readyState', returnByValue: true });
      return ready?.result?.value === 'complete';
    }, { timeoutMs: 15000, label: 'popup document ready' });
    const popupHref = await state.popup.send('Runtime.evaluate', { expression: 'location.href', returnByValue: true });
    check('G3.1b', 'popup document location is exactly the accepted inspector URL',
      popupHref?.result?.value === hostPagesBefore.devtools.url, hostPagesBefore.devtools.url, popupHref?.result?.value);
    const opener = await state.popup.send('Runtime.evaluate', { expression: 'window.opener === null', returnByValue: true });
    const referrer = await state.popup.send('Runtime.evaluate', { expression: 'document.referrer', returnByValue: true });
    check('G3.3', 'popup window.opener === null', opener?.result?.value === true, true, opener?.result?.value);
    check('G3.4', 'popup document.referrer is empty (no GUI token/referrer)', referrer?.result?.value === '', '', referrer?.result?.value);
    const SHADOW_TEXT = `(() => {
      const walk = (root, out) => {
        for (const node of root.querySelectorAll('*')) if (node.shadowRoot) walk(node.shadowRoot, out);
        out.push(root.textContent || '');
        return out;
      };
      return walk(document, []).join('\\n');
    })()`;
    let shadowText = '';
    let markerFound = false;
    const shadowStarted = Date.now();
    while (Date.now() - shadowStarted < 20000) {
      const result = await state.popup.send('Runtime.evaluate', { expression: SHADOW_TEXT, returnByValue: true });
      shadowText = String(result?.result?.value || '');
      if (shadowText.includes(MARKER)) { markerFound = true; break; }
      await sleep(500);
    }
    observations.popupShadow = { bytes: shadowText.length, markerFound, head: shadowText.slice(0, 200) };
    await writeFile(join(EVIDENCE_DIR, 'devtools-popup-shadow-text.txt'), shadowText);
    check('G3.5', 'DevTools Elements shows the target page MARKER in recursive shadow DOM', markerFound,
      { marker: MARKER }, { markerFound, bytes: shadowText.length });
    const popupShot = await state.popup.send('Page.captureScreenshot', { format: 'png' });
    const popupPng = Buffer.from(popupShot.data, 'base64');
    await writeFile(join(EVIDENCE_DIR, 'devtools-popup.png'), popupPng);
    await writeFile(join(RUN_DIR, 'devtools-popup.png'), popupPng);
    state.evidence.push({ name: 'devtools-popup.png', bytes: popupPng.length });
    check('G3.6', 'DevTools popup screenshot captured', popupPng.length > 1000, { bytes: '>1000' }, { bytes: popupPng.length });
    const hostPagesAfter = await hostDebuggerPages();
    check('G3.7', 'Host page count did not change (no Host target created by the popup)',
      hostPagesAfter.pages.length === hostPagesBefore.pages.length, hostPagesBefore.pages.length, hostPagesAfter.pages.length);
    check('G3.8', 'popup target is not present in the Host debugger page list',
      !hostPagesAfter.pages.some((page) => page.id === popupTarget.id), false,
      hostPagesAfter.pages.map((page) => page.id));

    log('\n--- G4 preview + Host frames while DevTools is open ---');
    const seqBefore = Number((await hostState()).seq || 0);
    await sleep(1500);
    const seqOpen = Number((await hostState()).seq || 0);
    observations.previewOpen = { seqBefore, seqOpen };
    check('G4.1', 'panel preview / Host frame seq advances while DevTools is open', seqOpen > seqBefore, `> ${seqBefore}`, seqOpen);
    check('G4.2', 'panel still renders a live preview while DevTools is open',
      await pageEvaluate(`(() => { const img = document.querySelector('.utb-frame'); return Boolean(img && img.naturalWidth > 0); })()`), true, true);

    log('\n--- G5 close popup -> panel keeps working ---');
    await closeGuiTarget(popupTarget.id);
    await waitFor(async () => !(await guiPageTargets()).some((target) => target.id === popupTarget.id),
      { timeoutMs: 10000, label: 'popup target closed' });
    state.popup.close();
    state.popup = undefined;
    await sleep(1200);
    const seqAfter = Number((await hostState()).seq || 0);
    observations.previewAfterClose = { seqAfter };
    check('G5.1', 'Host frame seq keeps advancing after the popup closes', seqAfter > seqOpen, `> ${seqOpen}`, seqAfter);
    check('G5.2', 'panel is still mounted and its address bar still shows the target page',
      await pageEvaluate(`(() => { const input = document.querySelector('.utb-addr'); return Boolean(input && input.value === ${JSON.stringify(fixtureUrl)}); })()`),
      fixtureUrl, await pageEvaluate(`document.querySelector('.utb-addr') ? document.querySelector('.utb-addr').value : null`));
    notRun('G5.3', 'T2 snapshot/click after closing DevTools from the GUI',
      'GUI 面板不暴露 Agent 工具通道；T2 共存已由 devtools.mjs H6 在真实 Host 上覆盖', { coveredBy: 'tests/acceptance/devtools.mjs H6.1–H6.3' });

    log('\n--- G6 blocked window.open fallback ---');
    const errorBefore = String((await hostState()).error || '');
    await pageEvaluate(`(() => { window.__dshOrigOpen = window.open; window.open = () => null; return true; })()`);
    await openMoreMenu();
    const blockedCenter = await centerOf(DEVTOOLS_ITEM_SELECTOR);
    await clickAt(blockedCenter.x, blockedCenter.y);
    const notice = await waitFor(async () => pageEvaluate(`(() => {
      const note = document.querySelector('.utb-devtools-note[role="status"]');
      if (!note) return null;
      const link = note.querySelector('a');
      return { text: note.textContent || '', href: link ? link.getAttribute('href') : '', target: link ? link.getAttribute('target') : '', rel: link ? link.getAttribute('rel') : '' };
    })()`), { timeoutMs: 5000, intervalMs: 150, label: 'popup-blocked notice' });
    observations.blockedNotice = notice;
    check('G6.1', 'blocked window.open shows the local aria-live hint', String(notice.text).includes('浏览器未返回调试窗口'), true, notice.text);
    check('G6.2', 'hint offers a real fallback link to the same inspector URL',
      notice.href === hostPagesBefore.devtools.url && notice.target === '_blank' && String(notice.rel).includes('noopener') && String(notice.rel).includes('noreferrer'),
      { href: 'inspector URL', target: '_blank', rel: 'noopener noreferrer' }, notice);
    check('G6.3', 'blocked branch did not change Runtime lastError', String((await hostState()).error || '') === errorBefore,
      errorBefore, String((await hostState()).error || ''));
    check('G6.4', 'blocked branch opened no new browser target',
      (await guiPageTargets()).filter((target) => String(target.url || '').includes('/devtools/inspector.html')).length === 0,
      0, (await guiPageTargets()).map((target) => target.url));
    await pageEvaluate(`(() => { window.open = window.__dshOrigOpen; delete window.__dshOrigOpen; return true; })()`);
    await closeMenuIfOpen();

    log('\n--- G7 annotation mode ---');
    const annotEntry = await pageEvaluate(`(() => { const b = document.querySelector('button[aria-label="标注"]'); return b ? { disabled: b.disabled === true, entry: b.getAttribute('data-utb-annot-entry') } : null; })()`);
    if (!annotEntry || annotEntry.disabled) {
      notRun('G7.1', 'annotation mode disables the whole 更多 menu',
        '面板标注入口不可用（annotReady 未满足），无法进入标注模式', { annotEntry });
    } else {
    const annotCenter = await centerOf(`document.querySelector('button[aria-label="标注"]')`);
    await clickAt(annotCenter.x, annotCenter.y);
    await waitFor(async () => pageEvaluate(`!!document.querySelector('.utb-annot-bar')`), { timeoutMs: 5000, label: 'annotation bar' });
    check('G7.1', 'annotation mode disables the whole 更多 button',
      await pageEvaluate(`(() => { const b = ${MORE_SELECTOR}; return Boolean(b && b.disabled); })()`), true, true);
    const popupCountBefore = (await guiPageTargets()).filter((target) => String(target.url || '').includes('/devtools/inspector.html')).length;
    // A disabled button cannot be clicked by a real user; dispatch a real click anyway and assert no window.
    try { const moreCenter = await centerOf(MORE_SELECTOR); await clickAt(moreCenter.x, moreCenter.y); } catch { /* disabled/offscreen */ }
    await sleep(500);
    check('G7.2', 'annotation mode never opens a DevTools window',
      (await guiPageTargets()).filter((target) => String(target.url || '').includes('/devtools/inspector.html')).length === popupCountBefore,
      popupCountBefore, (await guiPageTargets()).map((target) => target.url));
    await clickAt(annotCenter.x, annotCenter.y);
    await waitFor(async () => !(await pageEvaluate(`!!document.querySelector('.utb-annot-bar')`)), { timeoutMs: 5000, label: 'annotation exit' });
    }

    notRun('G8.1', 'non-loopback GUI hostname disables the item with the remote hint',
      '需要把 GUI 暴露到非 loopback hostname（代理/别名）才能真实触发；按契约不伪造，本项未运行', { implementedIn: 'client.js devtoolsInfo' });
    await captureGuiPng('gui-panel.png');
  } catch (error) {
    check('SUITE.1', 'GUI scenarios completed without an uncaught exception', false, 'no exception', errorMessage(error));
  } finally {
    await cleanup('run finished');
  }

  const failed = checks.filter((entry) => !entry.pass).length;
  const report = {
    suite: 'devtools-gui',
    startedAt: STAMP,
    finishedAt: new Date().toISOString(),
    environment: {
      isolatedDsh: observations.isolatedDsh || null,
      chrome: CHROME_BIN,
      servedClient: observations.servedClient || null,
    },
    fixtureUrl,
    marker: MARKER,
    checks,
    notRuns,
    observations,
    evidence: state.evidence,
    summary: { checks: checks.length, passed: checks.length - failed, failed, notRun: notRuns.length },
  };
  await writeFile(join(RUN_DIR, 'report.json'), JSON.stringify(report, null, 2));
  await writeFile(join(RUN_DIR, 'run.log'), logLines.join('\n') + '\n');
  await writeFile(join(EVIDENCE_DIR, 'report.json'), JSON.stringify(report, null, 2));
  log(`\ndevtools-gui: ${checks.length - failed}/${checks.length} PASS, ${failed} failed, ${notRuns.length} NOT_RUN`);
  log(`evidence: ${RUN_DIR}`);
  return failed === 0 ? 0 : 1;
}

let fatal = 0;
const timeout = setTimeout(() => {
  fatal = 2;
  log(`[fatal] total timeout ${TOTAL_TIMEOUT_MS}ms exceeded`);
  process.exit(2);
}, TOTAL_TIMEOUT_MS);
timeout.unref?.();
try {
  const code = await main();
  clearTimeout(timeout);
  process.exit(code);
} catch (error) {
  clearTimeout(timeout);
  log('[fatal] ' + errorMessage(error));
  try { await writeFile(join(RUN_DIR, 'run.log'), logLines.join('\n') + '\n'); } catch { /* ignore */ }
  process.exit(2);
}
