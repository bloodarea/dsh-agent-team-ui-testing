#!/usr/bin/env node
/**
 * Real-GUI acceptance: address-bar history (last 7 visited URLs, stack order) and the 转到 button.
 *
 * Builds its own isolated DSH web instance (fresh temporary DSH_HOME, copied web-profile config, a
 * read-only node_modules symlink, an ephemeral loopback port — never 3080/3081) plus a separate
 * headless Chromium that drives the real GUI over CDP. The pages under test come from a tiny
 * loopback fixture server started by this suite, so nothing depends on the repository fixtures.
 *
 * What is proven against the real panel:
 *   H0  the served client is this checkout and carries the history/go hooks;
 *   H1  a first navigation fills the stack (count 1, newest first);
 *   H2  a second navigation pushes on top (order B, A) and the dropdown shows exactly that order;
 *   H3  revisiting A moves it back to the top instead of duplicating it (still 2 entries);
 *   H4  clicking a dropdown entry navigates to that address and reorders the stack;
 *   H5  转到 navigates the typed address exactly like Enter (same draft, no Enter key);
 *   H6  an empty draft still uses Enter semantics: the panel reports 请输入网址 and does not navigate;
 *   H7  Esc and an outside click close the dropdown;
 *   H8  the stack is persisted in localStorage under one key (reload keeps it);
 *   H9  the stack never exceeds 7 entries (8th navigation evicts the oldest);
 *   H10 the 转到 button sits between the address bar and the tab-strip toggle.
 *
 * Run:  node tests/acceptance/panel-address-gui.mjs
 * Env:  DSH_BIN (default `dsh`), DSH_ACCEPTANCE_CHROME (default tests/acceptance/chrome-wrapper.sh),
 *       DSH_ADDRESS_GUI_TIMEOUT_MS (default 420000).
 * Exit: 0 all checks passed (NOT_RUN does not fail), 1 assertion failure, 2 fatal/environment-blocked.
 * Evidence: tests/acceptance/runs/panel-address-gui-<stamp>-<pid>/
 */
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import http from 'node:http';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = dirname(dirname(HERE));
const STAMP = new Date().toISOString().replace(/[:.]/g, '-');
const RUN_DIR = join(HERE, 'runs', `panel-address-gui-${STAMP}-${process.pid}`);
const DEFAULT_PROFILE = join(process.env.HOME || '', '.dsh', 'profiles', 'web');
const CHROME_BIN = process.env.DSH_ACCEPTANCE_CHROME || join(HERE, 'chrome-wrapper.sh');
const DSH_BIN = process.env.DSH_BIN || 'dsh';
const CHROME_PROFILE_PREFIX = 'dsh-address-gui-chrome-';
const DSH_HOME_PREFIX = 'dsh-address-gui-home-';
const TOTAL_TIMEOUT_MS = Number(process.env.DSH_ADDRESS_GUI_TIMEOUT_MS || 420000) || 420000;
const HISTORY_PREFIX = 'dsh-agent-team-ui-testing:address-history:';

const logLines = [];
function log(line = '') {
  const text = String(line);
  logLines.push(text);
  console.log(text);
}
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const errorMessage = (error) => String((error && error.stack) || (error && error.message) || error);

const state = {
  token: '', cookie: '', chrome: undefined, dsh: undefined, fixture: undefined,
  scopeHeaders: null, exceptions: [], consoleErrors: [], requests: [],
};

function sanitize(text) {
  let value = String(text === undefined || text === null ? '' : text);
  if (state.token) value = value.split(state.token).join('[REDACTED_TOKEN]');
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
 * Minimal CDP client (Node global WebSocket), same shape as the other GUI suites.
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

async function launchGuiChrome(bin) {
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
    }, { timeoutMs: 20000, label: 'devtools port' });
    const list = await waitFor(async () => {
      try {
        const response = await fetch(`http://127.0.0.1:${devtoolsPort}/json/list`, { signal: AbortSignal.timeout(2000) });
        const targets = await response.json();
        const page = targets.find((target) => target.type === 'page');
        return page && page.webSocketDebuggerUrl ? page : undefined;
      } catch { return undefined; }
    }, { timeoutMs: 20000, label: 'devtools target' });
    const cdp = await new Cdp(list.webSocketDebuggerUrl).connect();
    await cdp.send('Page.enable');
    await cdp.send('Runtime.enable');
    return { proc, profileDir, devtoolsPort, cdp };
  } catch (error) {
    try { proc.kill('SIGKILL'); } catch { /* ignore */ }
    await rm(profileDir, { recursive: true, force: true }).catch(() => {});
    throw new Error(errorMessage(error) + (stderr ? `\nchrome stderr: ${sanitize(stderr)}` : ''));
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
 * Isolated DSH + fixture pages.
 * ---------------------------------------------------------------------------------------------- */
async function prepareDshHome() {
  const home = await mkdtemp(join(tmpdir(), DSH_HOME_PREFIX));
  const profileDir = join(home, 'profiles', 'web');
  await mkdir(profileDir, { recursive: true });
  for (const name of ['package.json', 'cordis.patch.yml', 'compatibility.json', 'pnpm-lock.yaml', 'cordis.yml']) {
    const source = join(DEFAULT_PROFILE, name);
    if (!existsSync(source)) continue;
    await writeFile(join(profileDir, name), await readFile(source));
  }
  // Only the profile's own declared plugins are linked in: symlinking the whole profile
  // node_modules would drag stale @deepseek-ai/* copies next to the running DSH install and break
  // its required plugins (observed: dsh-tool-executor-native importing dsh-tools/./pipeline).
  const sourceModules = join(DEFAULT_PROFILE, 'node_modules');
  if (!existsSync(sourceModules)) throw new Error(`user profile node_modules missing: ${sourceModules}`);
  const target = join(profileDir, 'node_modules');
  await mkdir(target, { recursive: true });
  const manifestPath = join(DEFAULT_PROFILE, 'package.json');
  const names = new Set();
  if (existsSync(manifestPath)) {
    try {
      const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
      for (const name of Object.keys(manifest.dependencies || {})) names.add(name);
      for (const name of Object.keys(manifest.devDependencies || {})) names.add(name);
    } catch { /* a broken manifest is the profile's problem, not this suite's */ }
  }
  names.add('dsh-agent-team-ui-testing');
  const linked = [];
  for (const name of names) {
    const from = join(sourceModules, name.startsWith('@') ? name : name);
    if (!existsSync(from)) continue;
    const to = join(target, name);
    await mkdir(dirname(to), { recursive: true });
    try { await symlink(from, to, 'dir'); linked.push(name); } catch { /* already linked */ }
  }
  return { home, profileDir, linked };
}

async function startIsolatedDsh() {
  // Explicit opt-in for development verification against an already-running Host (same pattern as
  // pick-element-gui.mjs): the suite never restarts or closes that Host.
  if (process.env.DSH_ADDRESS_GUI_URL) {
    const base = new URL(process.env.DSH_ADDRESS_GUI_URL).origin;
    const logPath = process.env.DSH_ADDRESS_GUI_LOG || join(process.env.HOME || '', '.dsh/logs/web-launcher.log');
    const text = await readFile(logPath, 'utf8');
    const links = [...text.matchAll(/http:\/\/127\.0\.0\.1:\d+\/\?token=[^\s\u001b]+/gu)];
    const link = links.reverse().find(([url]) => new URL(url).origin === base)?.[0];
    if (!link) throw new Error('existing Host launch URL unavailable');
    state.token = new URL(link).searchParams.get('token');
    state.dsh = { base, port: Number(new URL(base).port), launchUrl: link, existing: true };
    return state.dsh;
  }
  const { home, profileDir } = await prepareDshHome();
  const port = await pickPort();
  const proc = spawn(DSH_BIN, ['web', '--port', String(port), '--no-open'], {
    env: { ...process.env, DSH_HOME: home, DSH_PROFILE: 'web', DSH_UI_TESTING_CHROME: CHROME_BIN },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '';
  const capture = (chunk) => { output += String(chunk); };
  proc.stdout.on('data', capture);
  proc.stderr.on('data', capture);
  proc.on('exit', (code, signal) => log(`[dsh] exited code=${code} signal=${signal}`));
  state.dsh = { proc, home, profileDir, port, base: `http://127.0.0.1:${port}`, output: () => output };
  const pattern = new RegExp(`dsh web: (http://127\\.0\\.0\\.1:${port}/\\?token=([^\\s]+))`);
  const matched = await Promise.race([
    waitFor(() => {
      const match = pattern.exec(output);
      return match ? { url: match[1], token: match[2] } : undefined;
    }, { timeoutMs: 120000, intervalMs: 250, label: 'isolated dsh launch URL' }),
    new Promise((resolve, reject) => proc.once('exit', (code) => reject(new Error(`isolated DSH exited ${code}: ${sanitize(output.slice(-4000))}`)))),
  ]);
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

async function startFixtureServer() {
  const page = (name) => `<!doctype html><meta charset="utf-8"><title>${name}</title><h1 id="page">${name}</h1>`;
  const server = http.createServer((req, res) => {
    const name = String(req.url || '/').replace(/[^a-z.]/giu, '') || 'a.html';
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.end(page(name));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  return { server, base, close: () => new Promise((resolve) => server.close(resolve)) };
}

async function authenticate(launchUrl) {
  const response = await fetch(launchUrl, { redirect: 'manual', signal: AbortSignal.timeout(20000) });
  const cookies = response.headers.getSetCookie();
  if (!cookies.length) throw new Error(`launch URL did not issue a cookie (status ${response.status})`);
  state.cookie = cookies.map((value) => value.split(';')[0]).join('; ');
  return cookies.map((value) => value.split(';')[0]);
}

/* ------------------------------------------------------------------------------------------------
 * Panel helpers (real pointer/keyboard input; DOM reads are the evidence).
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
async function clickAt(x, y) {
  await state.chrome.cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y, button: 'none', buttons: 0 });
  await state.chrome.cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', buttons: 1, clickCount: 1 });
  await state.chrome.cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', buttons: 0, clickCount: 1 });
  await sleep(120);
}
async function pressKey(key, code, vk, modifiers = 0) {
  await state.chrome.cdp.send('Input.dispatchKeyEvent', { type: 'keyDown', key, code, windowsVirtualKeyCode: vk, nativeVirtualKeyCode: vk, modifiers });
  await state.chrome.cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', key, code, windowsVirtualKeyCode: vk, nativeVirtualKeyCode: vk, modifiers });
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
async function clickSelector(selectorExpression) {
  const point = await centerOf(selectorExpression);
  await clickAt(point.x, point.y);
  return point;
}
async function openDebugPanelInSidebar() {
  // An existing Host may already show the panel (as a dock tab); never re-open it from scratch.
  if (await pageEvaluate(`!!document.querySelector('.utb .utb-addr')`)) return;
  await dismissShellDialogs();
  // Same right-sidebar bootstrap as pick-element-gui.mjs: open the sidebar, then make sure a
  // session is selected (the guide card only exists for a bound session).
  const already = await pageEvaluate(`!!document.querySelector('[data-sidebar-right-guide]')`);
  if (!already) {
    const handled = await pageEvaluate(`(() => {
      const toggle = document.querySelector('[data-sidebar-right-toggle]');
      if (toggle) return true;
      const expand = document.querySelector('[data-sidebar-right-expand]');
      if (expand) { expand.click(); return false; }
      return false;
    })()`);
    if (!handled) await sleep(500);
    const hasGuide = await pageEvaluate(`!!document.querySelector('[data-sidebar-right-guide]')`);
    if (!hasGuide) {
      await pageEvaluate(`(() => {
        const button = [...document.querySelectorAll('button[aria-label="新标签页"]')]
          .find((el) => el.closest('[data-sidebar-right-session]'));
        if (button) { button.click(); return true; }
        return false;
      })()`);
      await sleep(600);
    }
  }
  const viaGuide = await pageEvaluate(`(() => {
    const el = document.querySelector('[data-sidebar-right-guide-entry="debug-view"]');
    if (!el) return false;
    el.click();
    return true;
  })()`);
  if (!viaGuide) {
    // A dock tab labelled 调试视图 is the other real entry (the guide card may be collapsed).
    const clicked = await pageEvaluate(`(() => {
      const nodes = [...document.querySelectorAll('*')].filter((node) => !node.children.length && (node.textContent || '').trim() === '调试视图');
      const node = nodes.find((candidate) => candidate.closest('[role="tablist"], [role="tab"], button')) || nodes[0];
      if (!node) return false;
      const target = node.closest('button, [role="tab"]') || node;
      target.click();
      return true;
    })()`);
    if (!clicked) throw new Error('debug view entry not found (guide card and dock tab both missing)');
  }
  await waitFor(async () => pageEvaluate(`!!document.querySelector('.utb .utb-addr')`), { timeoutMs: 20000, label: 'debug panel mounted' });
  await dismissShellDialogs();
}

const readPanel = () => pageEvaluate(`(() => {
  const toggle = document.querySelector('[data-utb-history-toggle]');
  const list = document.querySelector('[data-utb-history-list]');
  const items = list ? [...list.querySelectorAll('[data-utb-history-item]')] : [];
  const go = document.querySelector('[data-utb-go]');
  const addr = document.querySelector('.utb-addr');
  const tabs = document.querySelector('[data-utb-tabs-toggle]');
  const bar = document.querySelector('.utb-bar');
  const rect = (el) => { if (!el) return null; const r = el.getBoundingClientRect(); return { x: r.x, y: r.y, width: r.width, height: r.height }; };
  return {
    address: addr ? addr.value : null,
    invalid: addr ? addr.getAttribute('data-invalid') : null,
    toggle: toggle ? { open: toggle.getAttribute('data-utb-history-toggle'), count: toggle.getAttribute('data-utb-history-count'), expanded: toggle.getAttribute('aria-expanded'), rect: rect(toggle) } : null,
    list: list ? { size: items.length, rect: rect(list), head: (list.querySelector('.utb-addr-pop-head') || {}).textContent || '' } : null,
    items: items.map((el) => el.getAttribute('data-utb-history-url')),
    go: go ? { state: go.getAttribute('data-utb-go'), disabled: go.disabled === true, rect: rect(go) } : null,
    addrRect: rect(addr), tabsRect: rect(tabs), barRect: rect(bar),
  };
})()`);

async function typeAddress(url) {
  await pageEvaluate(`(() => {
    const input = document.querySelector('.utb-addr');
    if (!input) return false;
    input.focus();
    input.select();
    return document.activeElement === input;
  })()`);
  await state.chrome.cdp.send('Input.insertText', { text: url });
  await sleep(200);
  let value = await pageEvaluate(`document.querySelector('.utb-addr') ? document.querySelector('.utb-addr').value : null`);
  if (value !== url) {
    value = await pageEvaluate(`(() => {
      const input = document.querySelector('.utb-addr');
      if (!input) return null;
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
      setter.call(input, ${JSON.stringify(url)});
      input.dispatchEvent(new Event('input', { bubbles: true }));
      return input.value;
    })()`);
    await sleep(200);
  }
  return value;
}

/**
 * Wait until the Host's accepted address for this panel's session equals `url`.
 * The Host value — not the input draft — is the truth: the address bar can show text that was
 * never committed.
 */
async function waitAddress(url, { timeoutMs = 25000 } = {}) {
  return waitFor(async () => {
    const snapshot = await hostState();
    return String(snapshot.ui?.address || '') === url ? snapshot : undefined;
  }, { timeoutMs, intervalMs: 200, label: 'host address ' + url });
}

/**
 * 回车提交：先派发真实 Enter；headless 下隐式表单提交不一定触发时，回落到 form.requestSubmit()
 * （走同一个 onSubmit → submit()，不是另一条路径），并把实际走法记进 observations。
 */
async function submitAddressViaEnter(url, { timeoutMs = 25000 } = {}) {
  await pressKey('Enter', 'Enter', 13);
  await sleep(700);
  try {
    await waitAddress(url, { timeoutMs: 4000 });
    observations.enterMode = 'cdp-enter';
    return true;
  } catch {
    const submitted = await pageEvaluate(`(() => {
      const form = document.querySelector('.utb-addr') && document.querySelector('.utb-addr').closest('form');
      if (!form) return false;
      form.requestSubmit();
      return true;
    })()`);
    observations.enterMode = submitted ? 'requestSubmit-fallback' : 'none';
    await waitAddress(url, { timeoutMs });
    return true;
  }
}

function hookNetwork() {
  state.chrome.cdp.on((message) => {
    if (message.method === 'Network.requestWillBeSent') {
      const request = message.params.request || {};
      const url = String(request.url || '');
      state.requests.push({ url, headers: request.headers || {} });
      if (!state.scopeHeaders && url.includes('/plugins/ui-testing/state')) {
        const headers = request.headers || {};
        const value = (name) => {
          for (const [key, entry] of Object.entries(headers)) if (String(key).toLowerCase() === name) return String(entry);
          return '';
        };
        const version = value('x-ui-testing-scope-version');
        const sessionId = value('x-ui-testing-session-id');
        if (version && sessionId) {
          state.scopeHeaders = {
            'x-ui-testing-scope-version': version,
            'x-ui-testing-session-id': sessionId,
            'x-ui-testing-scope-tab': value('x-ui-testing-scope-tab') || 'primary',
          };
        }
      }
    }
    if (message.method === 'Runtime.exceptionThrown') {
      const details = message.params.exceptionDetails || {};
      state.exceptions.push(String((details.exception && details.exception.description) || details.text).slice(0, 400));
    }
    if (message.method === 'Runtime.consoleAPICalled' && message.params.type === 'warning') {
      state.consoleWarnings = state.consoleWarnings || [];
      state.consoleWarnings.push(message.params.args.map((arg) => arg.value ?? arg.description).join(' ').slice(0, 300));
    }
    if (message.method === 'Runtime.consoleAPICalled' && message.params.type === 'error') {
      state.consoleErrors.push(message.params.args.map((arg) => arg.value ?? arg.description).join(' ').slice(0, 400));
    }
  });
}

async function hostState() {
  if (!state.scopeHeaders) throw new Error('panel scope headers not captured yet');
  const payload = await pageEvaluate(`(async () => {
    const response = await fetch('/plugins/ui-testing/state', {
      headers: ${JSON.stringify(state.scopeHeaders)}, credentials: 'same-origin', cache: 'no-store',
    });
    return response.json();
  })()`);
  if (!payload || payload.ok === false) throw new Error('GET /state failed: ' + sanitize(JSON.stringify(payload).slice(0, 300)));
  return payload;
}

/* ------------------------------------------------------------------------------------------------
 * Main.
 * ---------------------------------------------------------------------------------------------- */
async function main() {
  if (!existsSync(CHROME_BIN)) {
    notRun('ENV', 'headless Chromium', `chrome binary/wrapper missing: ${CHROME_BIN}`);
    await writeReport(0);
    return 0;
  }
  await mkdir(RUN_DIR, { recursive: true });
  state.fixture = await startFixtureServer();
  const A = `${state.fixture.base}/a.html`;
  const B = `${state.fixture.base}/b.html`;
  const C = `${state.fixture.base}/c.html`;
  const pages = [];
  for (let index = 0; index < 8; index += 1) pages.push(`${state.fixture.base}/p${index}.html`);
  observations.fixture = { A, B, C };
  log(`[env] fixture: ${state.fixture.base}`);
  log(`[env] chrome: ${CHROME_BIN}`);

  const cleanup = async (reason) => {
    log(`\n[cleanup] ${reason}`);
    if (state.chrome) {
      try { state.chrome.cdp.close(); } catch { /* ignore */ }
      try { state.chrome.proc.kill('SIGTERM'); } catch { /* ignore */ }
      await sleep(400);
      try { state.chrome.proc.kill('SIGKILL'); } catch { /* ignore */ }
      await rm(state.chrome.profileDir, { recursive: true, force: true, maxRetries: 5 }).catch(() => {});
      state.chrome = undefined;
    }
    if (state.dsh && !state.dsh.existing) {
      try { state.dsh.proc.kill('SIGTERM'); } catch { /* ignore */ }
      await sleep(800);
      try { state.dsh.proc.kill('SIGKILL'); } catch { /* ignore */ }
      await rm(state.dsh.home, { recursive: true, force: true, maxRetries: 5 }).catch(() => {});
      state.dsh = undefined;
    }
    if (state.fixture) {
      const fixture = state.fixture;
      state.fixture = undefined;
      await Promise.race([fixture.close(), sleep(3000)]);
    }
  };

  try {
    const dsh = await startIsolatedDsh();
    log(`[env] ${dsh.existing ? 'existing' : 'isolated'} DSH: ${dsh.base}`);
    const cookies = await authenticate(dsh.launchUrl);
    state.chrome = await launchGuiChrome(CHROME_BIN);
    const { cdp } = state.chrome;
    await cdp.send('Network.enable', { maxPostDataSize: 65536 });
    hookNetwork();
    for (const cookie of cookies) {
      const eq = cookie.indexOf('=');
      await cdp.send('Network.setCookie', { name: cookie.slice(0, eq), value: cookie.slice(eq + 1), url: new URL(dsh.base).origin + '/' });
    }
    await cdp.send('Page.navigate', { url: dsh.launchUrl });
    await guiReady(45000);
    if (dsh.existing && process.env.DSH_ADDRESS_GUI_SESSION) {
      const title = JSON.stringify(process.env.DSH_ADDRESS_GUI_SESSION);
      await waitFor(async () => pageEvaluate(
        'Array.from(document.querySelectorAll("span")).some((n) => n.textContent === ' + title + ')'),
      { timeoutMs: 15000, label: 'requested GUI session' });
      const point = await centerOf('Array.from(document.querySelectorAll("span")).find((n) => n.textContent === ' + title + ')');
      await clickAt(point.x, point.y);
      await sleep(800);
    }

    log('\n--- H0 served client carries this checkout ---');
    const served = await pageEvaluate(`(async () => {
      const boot = window.__DSH_BOOT__;
      const entry = boot && Array.isArray(boot.entries) ? boot.entries.find((candidate) => candidate.id === 'dsh-agent-team-ui-testing') : undefined;
      if (!entry || !entry.url) return null;
      const response = await fetch(entry.url, { credentials: 'same-origin', cache: 'no-store' });
      return { rev: entry.rev || '', text: await response.text() };
    })()`);
    const hasHooks = Boolean(served && served.text.includes('data-utb-history-toggle') && served.text.includes("button('转到'"));
    observations.servedClient = { rev: served?.rev || '', hooks: hasHooks, bytes: served ? Buffer.byteLength(served.text, 'utf8') : 0 };
    check('H0.1', 'GUI 提供的是本工作树的 client.js，且含历史/转到钩子', hasHooks, true, observations.servedClient);

    log('\n--- H1/H2 history stack grows newest-first ---');
    await openDebugPanelInSidebar();
    await waitFor(() => state.scopeHeaders, { timeoutMs: 15000, label: 'panel scope headers' });
    await typeAddress(A);
    await submitAddressViaEnter(A);
    await waitFor(async () => (await readPanel()).toggle?.count === '1', { timeoutMs: 10000, label: 'history count 1' });
    let panel = await readPanel();
    check('H1.1', '第一次访问后历史里正好 1 条，且就是该地址',
      panel.toggle.count === '1', { count: '1' }, panel.toggle.count);
    await clickSelector(`document.querySelector('[data-utb-history-toggle]')`);
    panel = await readPanel();
    check('H1.2', '点击地址栏右侧按钮展开下拉，条目就是刚访问的地址',
      panel.list?.size === 1 && panel.items[0] === A, { items: [A] }, panel.items);
    await pressKey('Escape', 'Escape', 27);
    check('H1.3', 'Esc 收起下拉', (await readPanel()).list === null, null, (await readPanel()).list);

    await typeAddress(B);
    await submitAddressViaEnter(B);
    await waitFor(async () => (await readPanel()).toggle?.count === '2', { timeoutMs: 10000, label: 'history count 2' });
    await clickSelector(`document.querySelector('[data-utb-history-toggle]')`);
    panel = await readPanel();
    check('H2.1', '第二次访问压栈：下拉顺序为「B, A」（最近的在上）',
      JSON.stringify(panel.items) === JSON.stringify([B, A]), [B, A], panel.items);
    check('H2.2', '下拉里给出了条数与上限',
      panel.list?.head.includes('2/7'), '2/7', panel.list?.head);

    log('\n--- H3 revisit moves to top, no duplicate ---');
    await clickSelector(`document.querySelector('[data-utb-history-item="1"]')`);
    await waitAddress(A);
    await waitFor(async () => (await readPanel()).toggle?.count === '2', { timeoutMs: 10000, label: 'history count stays 2' });
    await clickSelector(`document.querySelector('[data-utb-history-toggle]')`);
    panel = await readPanel();
    check('H3.1', '点历史条目跳到 A，且 A 回到栈顶（不重复）',
      JSON.stringify(panel.items) === JSON.stringify([A, B]) && panel.toggle.count === '2', [A, B], panel.items);

    log('\n--- H4 dropdown click navigates and reorders ---');
    await clickSelector(`document.querySelector('[data-utb-history-item="1"]')`);
    await waitAddress(B);
    await waitFor(async () => (await readPanel()).toggle?.count === '2', { timeoutMs: 10000, label: 'history count stays 2 after nav' });
    await clickSelector(`document.querySelector('[data-utb-history-toggle]')`);
    panel = await readPanel();
    check('H4.1', '从 B 的历史项点击后地址栏是 B、栈顶是 B',
      panel.address === B && panel.items[0] === B, { address: B, top: B }, { address: panel.address, top: panel.items[0] });
    await pressKey('Escape', 'Escape', 27);

    log('\n--- H5 转到 navigates the typed address (no Enter) ---');
    await typeAddress(C);
    await clickSelector(`document.querySelector('[data-utb-go]')`);
    await waitAddress(C);
    check('H5.1', '点「转到」后页面跳到输入的地址（等同回车）', (await readPanel()).address === C, C, (await readPanel()).address);
    await waitFor(async () => (await readPanel()).toggle?.count === '3', { timeoutMs: 10000, label: 'history count 3' });

    log('\n--- H6 empty draft keeps Enter semantics ---');
    const before = String((await hostState()).ui?.address || '');
    await typeAddress('');
    await clickSelector(`document.querySelector('[data-utb-go]')`);
    await sleep(600);
    panel = await readPanel();
    const afterEmpty = String((await hostState()).ui?.address || '');
    check('H6.1', '空地址点「转到」不导航，并给出与回车一致的错误',
      afterEmpty === before && panel.invalid === 'true' && panel.address === '',
      { hostAddress: before, invalid: 'true', draft: '' }, { hostAddress: afterEmpty, invalid: panel.invalid, draft: panel.address });
    await typeAddress(before);
    await pressKey('Escape', 'Escape', 27);

    log('\n--- H7 outside click closes the dropdown ---');
    await clickSelector(`document.querySelector('[data-utb-history-toggle]')`);
    const opened = await readPanel();
    await clickAt(20, 300); // outside the panel bar
    await sleep(300);
    check('H7.1', '点击下拉外部收起', opened.list !== null && (await readPanel()).list === null, { opened: true, closed: null }, (await readPanel()).list);

    log('\n--- H8 persisted per workspace ---');
    const storedRows = await pageEvaluate(`(() => {
      const prefix = ${JSON.stringify(HISTORY_PREFIX)};
      return Object.keys(window.localStorage)
        .filter((key) => key.startsWith(prefix))
        .map((key) => { let value = null; try { value = JSON.parse(window.localStorage.getItem(key) || 'null'); } catch { value = 'unparsable'; } return { key, value }; });
    })()`);
    const scopeId = String((await hostState()).ui?.scope?.id || '');
    const scopedKey = HISTORY_PREFIX + 'v2:' + scopeId;
    const scoped = storedRows.find((row) => row.key === scopedKey);
    check('H8.1', '历史按工作区作用域键持久化，内容与面板顺序一致',
      Boolean(scoped) && Array.isArray(scoped.value) && scoped.value[0] === before && scoped.value.length === 3,
      { key: scopedKey, top: before, length: 3 }, { scopeId, rows: storedRows });
    check('H8.2', '没有跨工作区共用键（v1 共用键与 unscoped 桶都未被写入）',
      !storedRows.some((row) => row.key === HISTORY_PREFIX + 'v1' || row.key.endsWith(':unscoped')),
      { sharedKeys: [] }, storedRows.map((row) => row.key));
    observations.stored = storedRows;

    log('\n--- H9 stack caps at 7 ---');
    for (const url of pages) {
      await typeAddress(url);
      await submitAddressViaEnter(url);
    }
    await waitFor(async () => (await readPanel()).toggle?.count === '7', { timeoutMs: 10000, label: 'history capped at 7' });
    await clickSelector(`document.querySelector('[data-utb-history-toggle]')`);
    panel = await readPanel();
    const expectedTop7 = pages.slice(-7).reverse();
    check('H9.1', '连开 8 个地址后只留最近 7 条，最旧的被挤出',
      JSON.stringify(panel.items) === JSON.stringify(expectedTop7), expectedTop7, panel.items);
    await pressKey('Escape', 'Escape', 27);

    log('\n--- H10 button placement ---');
    panel = await readPanel();
    const goRight = panel.go.rect.x + panel.go.rect.width;
    check('H10.1', '「转到」在标签页按钮左侧，且位于地址栏右侧',
      panel.go.rect.x >= panel.addrRect.x + panel.addrRect.width - 1 && goRight <= panel.tabsRect.x + 1,
      { after: 'address bar', before: 'tabs toggle' },
      { addressRight: panel.addrRect.x + panel.addrRect.width, go: panel.go.rect, tabs: panel.tabsRect });
    check('H10.2', '「转到」有独立的验收钩子且当前可用', panel.go.state === 'ready', 'ready', panel.go.state);

    const running = await hostState();
    check('H11.1', '面板跑到最后没有未捕获异常',
      state.exceptions.length === 0 && state.consoleErrors.length === 0,
      { exceptions: [], consoleErrors: [] }, { exceptions: state.exceptions.slice(0, 3), consoleErrors: state.consoleErrors.slice(0, 3) });
    check('H11.2', '页面确实停在最后一个地址', String(running.ui?.address || '') === pages[pages.length - 1], pages[pages.length - 1], running.ui?.address);
  } catch (error) {
    log('[fail] ' + sanitize(errorMessage(error)));
    try {
      observations.failurePanel = await readPanel();
      observations.failureHost = await hostState().then((snapshot) => ({ running: snapshot.running, mode: snapshot.mode, address: snapshot.ui?.address, scope: snapshot.scope, agent: snapshot.agent })).catch((stateError) => String(stateError).slice(0, 300));
      log('[fail] host=' + JSON.stringify(observations.failureHost));
      log('[fail] warnings=' + JSON.stringify((state.consoleWarnings || []).slice(-8)));
      log('[fail] hostCalls=' + JSON.stringify(state.requests.filter((entry) => entry.url.includes('/plugins/ui-testing/')).slice(-8).map((entry) => new URL(entry.url).pathname)));
      observations.failureDom = await pageEvaluate(`(() => ({
        title: document.title,
        url: location.href,
        panels: document.querySelectorAll('.utb').length,
        addresses: [...document.querySelectorAll('.utb-addr')].map((el) => el.value),
        notices: [...document.querySelectorAll('.utb-sync-note, .utb-sr')].map((el) => (el.textContent || '').trim()).filter(Boolean).slice(0, 6),
      }))()`);
    } catch (diagnosticError) { observations.failureDiagnosticError = errorMessage(diagnosticError).slice(0, 400); }
    log('[fail] panel=' + JSON.stringify(observations.failurePanel));
    log('[fail] dom=' + JSON.stringify(observations.failureDom));
    check('SUITE.1', 'GUI 场景无未捕获异常', false, 'no exception', sanitize(errorMessage(error)).slice(0, 800));
  } finally {
    await cleanup('run finished');
  }

  const failed = checks.filter((entry) => !entry.pass).length;
  await writeReport(failed === 0 ? 0 : 1);
  log(`\npanel-address-gui: ${checks.length - failed}/${checks.length} PASS, ${failed} failed, ${notRuns.length} NOT_RUN`);
  log(`evidence: ${RUN_DIR}`);
  return failed === 0 ? 0 : 1;
}

async function writeReport(exitCode) {
  const failed = checks.filter((entry) => !entry.pass).length;
  const report = {
    schemaVersion: 1,
    suite: 'panel-address-gui',
    startedAt: STAMP,
    finishedAt: new Date().toISOString(),
    environment: { chrome: CHROME_BIN, dshBin: DSH_BIN },
    checks, notRuns, observations,
    summary: { checks: checks.length, passed: checks.length - failed, failed, notRun: notRuns.length },
    exitCode,
  };
  await mkdir(RUN_DIR, { recursive: true });
  const body = JSON.stringify(report, null, 2);
  await writeFile(join(RUN_DIR, 'report.json'), body);
  await writeFile(join(RUN_DIR, 'run.log'), logLines.join('\n') + '\n');
  log(`PASS=${report.summary.passed} FAIL=${report.summary.failed} NOT_RUN=${report.summary.notRun}`);
  log(`EXIT ${exitCode}`);
}

let fatal = 0;
const timeout = setTimeout(() => {
  fatal = 2;
  log(`[fatal] total timeout ${TOTAL_TIMEOUT_MS}ms exceeded`);
  try { void writeFile(join(RUN_DIR, 'run.log'), logLines.join('\n') + '\n'); } catch { /* ignore */ }
  process.exit(2);
}, TOTAL_TIMEOUT_MS);
timeout.unref?.();
try {
  const code = await main();
  clearTimeout(timeout);
  process.exit(code);
} catch (error) {
  clearTimeout(timeout);
  log('[fatal] ' + sanitize(errorMessage(error)));
  try { await writeReport(2); } catch { /* ignore */ }
  process.exit(2);
}
