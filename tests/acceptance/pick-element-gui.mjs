#!/usr/bin/env node
/**
 * Real-GUI acceptance for the element picker ("选元素 → 加入聊天框", docs/element-picker.md).
 *
 * Builds its OWN isolated DSH web instance (fresh temporary DSH_HOME, copied web-profile config,
 * a read-only node_modules symlink, an ephemeral loopback port — NEVER 3080/3081, `--no-open`)
 * plus a separate headless Chromium that drives the real GUI over CDP. The panel is opened from
 * the right sidebar guide entry `debug-view` (so the session is bound and the chat composer is
 * visible in the main view), and the page under test is the repository fixture
 * `/pick-element.html` (same fixture as the Host suite).
 *
 * What is proven against the real shell/panel/client:
 *   G0  isolated GUI from this checkout (ephemeral port, token exchanged away, client bundle has
 *       the pick feature);
 *   G1  right-sidebar debug panel mounts; cold runtime disables the entry (`data-utb-pick-entry`
 *       = cold) with aria-pressed=false;
 *   G2  address-bar navigation to the fixture → preview decoded → entry ready/enabled;
 *   G3  mode entry + mutual exclusion both ways (pick ↔ annot ↔ sizing, data-* values);
 *   G4  hover overlay: `data-utb-pick-state=hover`, tag `button#pick-target`, `data-utb-pick-rect`
 *       equals the Host document rect, overlay screen rect vs panel/view geometry ≤2px, hover
 *       selector is the empty string (detail:false), zero page events;
 *   G5  click → detail request → composer text block (outerHTML/selector/role+name/rect/page),
 *       `data-utb-pick-status=ok` "已加入聊天框：#pick-target", mode exits, composer focused,
 *       zero page clicks from the pick gesture;
 *   G6  Esc exits and returns focus; Esc inside the composer does NOT exit; pointerleave clears
 *       the overlay; pick mode never dispatches page input;
 *   G7  wheel still scrolls the target page and, after the settle window, the same document point
 *       re-hits the same element with a correctly re-mapped overlay (C changed);
 *   G8  after exiting, a real trusted click on the preview increments the fixture page counter.
 *
 * NOT_RUN (recorded, never faked): canvas pan O≠0 hover, main-panel `recent` (no-session) prompt,
 * DPR≠1 / non-loopback hostname, iframe/closed-shadow selection (v1 main frame only).
 *
 * Run:  node tests/acceptance/pick-element-gui.mjs
 * Env:  DSH_BIN (default `dsh`), DSH_ACCEPTANCE_CHROME (default tests/acceptance/chrome-wrapper.sh),
 *       DSH_PICK_GUI_TIMEOUT_MS (default 420000).
 * Exit: 0 all checks passed (NOT_RUN does not fail), 1 assertion failure, 2 fatal/environment-blocked.
 * Evidence: tests/acceptance/runs/pick-element-gui-<stamp>-<pid>/ and
 *           tests/acceptance/evidence/pick-element-gui-<stamp>/ (PNG + report.json).
 */
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = dirname(dirname(HERE));
const STAMP = new Date().toISOString().replace(/[:.]/g, '-');
const RUN_DIR = join(HERE, 'runs', `pick-element-gui-${STAMP}-${process.pid}`);
const EVIDENCE_DIR = join(HERE, 'evidence', `pick-element-gui-${STAMP}`);
const DEFAULT_PROFILE = join(process.env.HOME || '', '.dsh', 'profiles', 'web');
const CHROME_BIN = process.env.DSH_ACCEPTANCE_CHROME || process.env.DSH_REAL_BROWSER_CHROME || join(HERE, 'chrome-wrapper.sh');
const DSH_BIN = process.env.DSH_BIN || 'dsh';
const CHROME_PROFILE_PREFIX = 'dsh-pick-gui-chrome-';
const DSH_HOME_PREFIX = 'dsh-pick-gui-home-';
const TOTAL_TIMEOUT_MS = Number(process.env.DSH_PICK_GUI_TIMEOUT_MS || 420000) || 420000;
const FIXTURE_PAGE = '/pick-element.html';

const logLines = [];
function log(line = '') {
  const text = String(line);
  logLines.push(text);
  console.log(text);
}
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const errorMessage = (error) => String((error && error.stack) || (error && error.message) || error);

const state = {
  token: '', cookie: '', chrome: undefined, fixture: undefined, dsh: undefined,
  scopeHeaders: null, requests: [], exceptions: [], consoleErrors: [], evidence: [], elementTraffic: [],
};

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
 * Checks / NOT_RUN / observations.
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
 * Isolated DSH instance (same isolation as devtools-gui.mjs; never 3080/3081).
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

async function startIsolatedDsh({ chromeBin }) {
  // Explicit opt-in for development verification against an already-running Host.
  if (process.env.DSH_SELECT_GUI_URL) {
    const base = new URL(process.env.DSH_SELECT_GUI_URL).origin;
    const text = await readFile(process.env.DSH_SELECT_GUI_LOG || join(process.env.HOME, '.dsh/logs/web-launcher.log'), 'utf8');
    const links = [...text.matchAll(/http:\/\/127\.0\.0\.1:\d+\/\?token=[^\s\u001b]+/gu)];
    const link = links.reverse().find(([url]) => new URL(url).origin === base)?.[0];
    if (!link) throw new Error('existing Host launch URL unavailable');
    state.token = new URL(link).searchParams.get('token');
    state.dsh = { base, port: Number(new URL(base).port), launchUrl: link, existing: true, copied: [] };
    return state.dsh;
  }
  const { home, profileDir, copied } = await prepareDshHome();
  const port = await pickPort();
  const proc = spawn(DSH_BIN, ['web', '--port', String(port), '--no-open'], {
    env: { ...process.env, DSH_HOME: home, DSH_PROFILE: 'web', DSH_UI_TESTING_CHROME: chromeBin },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '';
  const capture = (chunk) => { output += String(chunk); };
  proc.stdout.on('data', capture);
  proc.stderr.on('data', capture);
  proc.on('exit', (code, signal) => log(`[dsh] exited code=${code} signal=${signal}`));
  state.dsh = { proc, home, profileDir, port, copied, output: () => output, base: `http://127.0.0.1:${port}` };
  const pattern = new RegExp(`dsh web: (http://127\\.0\\.0\\.1:${port}/\\?token=([^\\s]+))`);
  const matched = await Promise.race([
    waitFor(() => {
      const match = pattern.exec(output);
      return match ? { url: match[1], token: match[2] } : undefined;
    }, { timeoutMs: 120000, intervalMs: 250, label: 'isolated dsh launch URL' }),
    new Promise((resolve, reject) => proc.once('exit', (code) => reject(new Error(`isolated DSH exited ${code}: ${sanitize(output.slice(-6000))}`)))),
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
async function clickAt(x, y) {
  await state.chrome.cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y, button: 'none', buttons: 0 });
  await state.chrome.cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', buttons: 1, clickCount: 1 });
  await state.chrome.cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', buttons: 0, clickCount: 1 });
  await sleep(120);
}
async function moveTo(x, y) {
  await state.chrome.cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y, button: 'none', buttons: 0 });
}
async function pressEscape() {
  await state.chrome.cdp.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27, nativeVirtualKeyCode: 27 });
  await state.chrome.cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27, nativeVirtualKeyCode: 27 });
  await sleep(200);
}
async function wheelAt(x, y, deltaY = 200) {
  await state.chrome.cdp.send('Input.dispatchMouseEvent', {
    type: 'mouseWheel', x, y, deltaX: 0, deltaY, button: 'none', buttons: 0, modifiers: 0,
  });
  await sleep(250);
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
async function capturePng(name) {
  const shot = await state.chrome.cdp.send('Page.captureScreenshot', { format: 'png' });
  const buffer = Buffer.from(shot.data, 'base64');
  await writeFile(join(EVIDENCE_DIR, name), buffer);
  await writeFile(join(RUN_DIR, name), buffer);
  state.evidence.push({ name, bytes: buffer.length });
  return buffer.length;
}

function headerValue(headers, name) {
  if (!headers) return '';
  for (const [key, value] of Object.entries(headers)) if (String(key).toLowerCase() === name) return String(value);
  return '';
}
function hookNetworkEvents() {
  state.chrome.cdp.on((message) => {
    if (message.method === 'Network.requestWillBeSent') {
      const request = message.params.request || {};
      const url = String(request.url || '');
      state.requests.push({ at: Date.now(), url, headers: request.headers || {} });
      if (url.includes('/plugins/ui-testing/element')) {
        state.elementTraffic.push({
          at: Date.now(), requestId: message.params.requestId, url,
          method: String(request.method || ''), postData: request.postData || null, status: null, failure: null,
        });
      }
      if (!state.scopeHeaders && url.includes('/plugins/ui-testing/state')) {
        const version = headerValue(request.headers, 'x-ui-testing-scope-version');
        const sessionId = headerValue(request.headers, 'x-ui-testing-session-id');
        const binding = headerValue(request.headers, 'x-ui-testing-scope-binding');
        const special = headerValue(request.headers, 'x-ui-testing-scope');
        const tab = headerValue(request.headers, 'x-ui-testing-scope-tab');
        const captured = {};
        if (version) captured['x-ui-testing-scope-version'] = version;
        if (sessionId) captured['x-ui-testing-session-id'] = sessionId;
        else if (binding) captured['x-ui-testing-scope-binding'] = binding;
        else if (special) captured['x-ui-testing-scope'] = special;
        if (tab) captured['x-ui-testing-scope-tab'] = tab;
        if (captured['x-ui-testing-scope-version']) {
          state.scopeHeaders = captured;
          log('[env] panel scope captured');
        }
      }
    }
    if (message.method === 'Network.responseReceived') {
      const entry = state.elementTraffic.find((item) => item.requestId === message.params.requestId);
      if (entry) entry.status = Number(message.params.response?.status) || 0;
    }
    if (message.method === 'Network.loadingFailed') {
      const entry = state.elementTraffic.find((item) => item.requestId === message.params.requestId);
      if (entry) entry.failure = String(message.params.errorText || 'loadingFailed');
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

async function pageHostFetch(path, { method = 'GET', headers = {}, body, timeoutMs } = {}) {
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
  return pageEvaluate(expression, timeoutMs ? { timeoutMs } : undefined);
}
function requireScope() {
  if (!state.scopeHeaders) throw new Error('panel scope headers not captured yet');
  return state.scopeHeaders;
}
function jsonHeaders() {
  return Object.assign({ 'content-type': 'application/json' }, requireScope());
}
async function hostState() {
  const response = await pageHostFetch('/state', { headers: requireScope() });
  if (response.status !== 200 || !response.json || response.json.ok === false) {
    throw new Error(`GET /state -> ${response.status}: ${sanitize(response.text)}`);
  }
  return response.json;
}
async function hostEvalJson(expression, { timeoutMs = 30000 } = {}) {
  const response = await pageHostFetch('/eval', { method: 'POST', headers: jsonHeaders(), body: { expression }, timeoutMs });
  if (response.status !== 200 || !response.json || response.json.ok === false) {
    throw new Error(`POST /eval -> ${response.status}: ${sanitize(response.text)}`);
  }
  return response.json.value;
}
const pageCounters = async ({ timeoutMs } = {}) => JSON.parse(await hostEvalJson('JSON.stringify(window.__pickClicks || null)', { timeoutMs }));
const pageScroll = async ({ timeoutMs } = {}) => JSON.parse(await hostEvalJson('JSON.stringify({ x: window.scrollX, y: window.scrollY })', { timeoutMs }));
const pageTargetRect = async ({ timeoutMs } = {}) => JSON.parse(await hostEvalJson(`JSON.stringify((() => {
  const el = document.getElementById('pick-target');
  if (!el) return null;
  const r = el.getBoundingClientRect();
  return { x: r.x + window.scrollX, y: r.y + window.scrollY, width: r.width, height: r.height };
})())`));

async function openDebugPanelInSidebar() {
  await dismissShellDialogs();
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
  await waitFor(async () => {
    const clicked = await pageEvaluate(`(() => {
      const el = document.querySelector('[data-sidebar-right-guide-entry="debug-view"]');
      if (!el) return false;
      el.click();
      return true;
    })()`);
    return clicked ? true : undefined;
  }, { timeoutMs: 15000, intervalMs: 150, label: 'debug-view guide entry' });
  await waitFor(async () => pageEvaluate(`!!document.querySelector('.utb')`), { timeoutMs: 15000, label: 'debug panel mounted' });
  await dismissShellDialogs();
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
    // Controlled inputs can swallow CDP text: fall back to the native setter + a real input event.
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
  }, { timeoutMs: 4000, intervalMs: 150, label: 'address-bar submit' }).catch(() => undefined);
  if (!changed) {
    await pageEvaluate(`(async () => {
      const input = document.querySelector('.utb-addr');
      const form = input && input.closest('form');
      if (form) form.requestSubmit();
      await new Promise((resolve) => setTimeout(resolve, 50));
      return true;
    })()`);
  }
  observations.addressBar = { typed: url, inputValue: value };
  await sleep(200);
}

/* ------------------------------------------------------------------------------------------------
 * Panel projection helpers (DOM reads are the evidence; nothing is inferred from client state).
 * ---------------------------------------------------------------------------------------------- */
const readEntry = () => pageEvaluate(`(() => {
  const pick = document.querySelector('[data-utb-pick-entry]');
  const annot = document.querySelector('[data-utb-annot-entry]');
  const size = document.querySelector('[data-utb-size-entry]');
  return {
    pick: pick ? { state: pick.getAttribute('data-utb-pick-entry'), disabled: pick.disabled === true, pressed: pick.getAttribute('aria-pressed'), title: pick.title || '' } : null,
    annot: annot ? { state: annot.getAttribute('data-utb-annot-entry'), disabled: annot.disabled === true, title: annot.title || '' } : null,
    size: size ? { state: size.getAttribute('data-utb-size-entry'), disabled: size.disabled === true, title: size.title || '' } : null,
  };
})()`);

const readOverlay = () => pageEvaluate(`(() => {
  const layer = document.querySelector('[data-utb-pick-layer]');
  const outline = document.querySelector('[data-utb-pick-outline]');
  const tag = document.querySelector('[data-utb-pick-tag]');
  const status = document.querySelector('[data-utb-pick-status]');
  const box = outline ? outline.getBoundingClientRect() : null;
  let parsed = null;
  if (outline) { try { parsed = JSON.parse(outline.getAttribute('data-utb-pick-rect') || 'null'); } catch { parsed = null; } }
  return {
    layer: layer ? { state: layer.getAttribute('data-utb-pick-state') } : null,
    outline: outline ? {
      selector: outline.getAttribute('data-utb-pick-selector'),
      rect: parsed,
      box: box ? { left: box.left, top: box.top, width: box.width, height: box.height } : null,
    } : null,
    tag: tag ? tag.getAttribute('data-utb-pick-tag') : null,
    status: status ? { text: (status.textContent || '').trim(), kind: status.getAttribute('data-utb-pick-status') } : null,
  };
})()`);

const readComposer = () => pageEvaluate(`(() => {
  const editor = document.querySelector('[data-composer-input]');
  const active = document.activeElement;
  const chips = editor
    ? Array.from(editor.querySelectorAll('[title]'))
      .filter((el) => String(el.getAttribute('title') || '').startsWith('元素 '))
      .map((el) => ({ title: el.getAttribute('title'), text: (el.textContent || '').trim() }))
    : [];
  return {
    exists: Boolean(editor),
    editable: editor ? editor.getAttribute('contenteditable') : null,
    text: editor ? (editor.innerText || editor.textContent || '') : '',
    chips,
    activeIsComposer: Boolean(active && typeof active.hasAttribute === 'function' && active.hasAttribute('data-composer-input')),
    activeTag: active ? active.tagName : null,
  };
})()`);

async function measurePreview() {
  const geom = await pageEvaluate(`(() => {
    const img = document.querySelector('.utb-frame');
    const box = document.querySelector('.utb-box');
    if (!img || !box) return null;
    const ir = img.getBoundingClientRect();
    const br = box.getBoundingClientRect();
    return {
      img: { left: ir.left, top: ir.top, width: ir.width, height: ir.height },
      box: { left: br.left, top: br.top, width: br.width, height: br.height },
      naturalWidth: img.naturalWidth, naturalHeight: img.naturalHeight,
    };
  })()`);
  if (!geom || !(geom.naturalWidth > 0) || !(geom.naturalHeight > 0)
    || !(geom.box.width > 0) || !(geom.box.height > 0)) return null;
  // Same mapping as the client: paintedRect(boxRect, naturalW, naturalH) then object-fit contains.
  const scale = Math.min(geom.box.width / geom.naturalWidth, geom.box.height / geom.naturalHeight);
  const painted = {
    left: geom.box.left + (geom.box.width - geom.naturalWidth * scale) / 2,
    top: geom.box.top + (geom.box.height - geom.naturalHeight * scale) / 2,
    width: geom.naturalWidth * scale,
    height: geom.naturalHeight * scale,
  };
  return { ...geom, painted };
}
function screenPointFor(preview, docPoint, view, canvas) {
  return {
    x: preview.painted.left + ((docPoint.x - canvas.x) / view.width) * preview.painted.width,
    y: preview.painted.top + ((docPoint.y - canvas.y) / view.height) * preview.painted.height,
  };
}
function screenRectFor(preview, rect, view, canvas) {
  return {
    left: preview.painted.left + ((rect.x - canvas.x) / view.width) * preview.painted.width,
    top: preview.painted.top + ((rect.y - canvas.y) / view.height) * preview.painted.height,
    width: (rect.width / view.width) * preview.painted.width,
    height: (rect.height / view.height) * preview.painted.height,
  };
}
const near = (a, b, tolerance = 2) => Number.isFinite(a) && Number.isFinite(b) && Math.abs(a - b) <= tolerance;

async function waitForHover({ timeoutMs = 6000 } = {}) {
  return waitFor(async () => {
    const overlay = await readOverlay();
    return overlay.layer?.state === 'hover' && overlay.outline ? overlay : undefined;
  }, { timeoutMs, intervalMs: 100, label: 'pick hover overlay' });
}

/**
 * Hover one *document* point and wait until the overlay settles.
 *
 * The panel maps a pointer against the CURRENT box geometry + canvas origin C, and it discards a
 * response whose C moved while the request was in flight. After a wheel/C change (or a layout
 * shift) a single mouseMoved can therefore race the readback: re-read geometry + /state, re-map,
 * and nudge the pointer by a pixel until the overlay is actually drawn (a real user keeps moving).
 * Returns the exact preview/view/canvas snapshot the accepted overlay belongs to.
 */
async function hoverAt(docPoint, { timeoutMs = 8000 } = {}) {
  const deadline = Date.now() + timeoutMs;
  let last = null;
  let nudge = 0;
  while (Date.now() < deadline) {
    const preview = await measurePreview();
    const snapshot = await hostState();
    if (!preview) throw new Error('preview not measurable');
    const point = screenPointFor(preview, docPoint, snapshot.ui.view, snapshot.ui.canvas);
    await moveTo(point.x + (nudge % 2), point.y + (nudge % 3 === 0 ? 0 : 1));
    nudge += 1;
    await sleep(240);
    last = await readOverlay();
    if (last.layer?.state === 'hover' && last.outline) {
      return { overlay: last, preview, view: snapshot.ui.view, canvas: snapshot.ui.canvas, point };
    }
    await sleep(120);
  }
  let diagnostics = null;
  try {
    const preview = await measurePreview();
    const snapshot = await hostState();
    const point = screenPointFor(preview, docPoint, snapshot.ui.view, snapshot.ui.canvas);
    const recent = state.elementTraffic.slice(-8).map((entry) => ({ ...entry }));
    await Promise.all(recent.map(async (entry) => {
      try {
        const body = await state.chrome.cdp.send('Network.getResponseBody', { requestId: entry.requestId }, 3000);
        entry.body = String(body.body || '').slice(0, 400);
      } catch { entry.body = null; }
    }));
    diagnostics = {
      point,
      docPoint,
      panel: await pageEvaluate(`(() => {
        const pick = document.querySelector('[data-utb-pick-entry]');
        const layer = document.querySelector('[data-utb-pick-layer]');
        const el = document.elementFromPoint(${point.x}, ${point.y});
        const img = document.querySelector('.utb-frame');
        return {
          pickEntry: pick ? pick.getAttribute('data-utb-pick-entry') : null,
          layerState: layer ? layer.getAttribute('data-utb-pick-state') : null,
          elementAtPoint: el ? (el.className || el.tagName || '') : null,
          inFrame: Boolean(el && el.closest && el.closest('.utb-frame')),
          frameTransform: img ? getComputedStyle(img).transform : null,
        };
      })()`),
      view: snapshot.ui?.view,
      canvas: snapshot.ui?.canvas,
      observed: snapshot.ui?.observed,
      pageScroll: await pageScroll(),
      elementTraffic: recent,
    };
    observations.lastHoverFailure = diagnostics;
  } catch { /* diagnostics are best-effort */ }
  throw new Error('hover overlay did not settle for ' + JSON.stringify(docPoint)
    + ' (last=' + JSON.stringify(last) + ' diagnostics=' + JSON.stringify(diagnostics) + ')');
}

/** Wait until the page's own scrollY stays unchanged for three consecutive samples (>=300ms). */
async function waitForScrollStable({ timeoutMs = 8000 } = {}) {
  const deadline = Date.now() + timeoutMs;
  let last = null;
  let stable = 0;
  while (Date.now() < deadline) {
    const current = await pageScroll();
    if (last && current.y === last.y && current.x === last.x) stable += 1;
    else stable = 0;
    last = current;
    if (stable >= 3) return current;
    await sleep(150);
  }
  throw new Error('page scroll did not stabilize: ' + JSON.stringify(last));
}

/**
 * Wait until the Host canvas is settled for the post-wheel scroll: C follows the page, the
 * observation (S) equals C, and the derived offset O = C - S is 0. While O != 0 the panel
 * translates the preview image (`frameShift`), so a pointer computed from the box geometry can
 * land outside the shifted <img> and never reach its pointer handlers. Hover only after O = 0.
 */
async function waitForStableCanvas(expectedY, { timeoutMs = 12000 } = {}) {
  let stable = 0;
  let last = null;
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const snapshot = await hostState();
    last = snapshot;
    const canvas = snapshot.ui?.canvas || {};
    const observed = snapshot.ui?.observed || {};
    const settled = Math.abs(Number(canvas.y) - Number(expectedY)) <= 1
      && Math.abs(Number(observed.y) - Number(canvas.y)) <= 1
      && Math.abs(Number(canvas.offsetX || 0)) <= 0.5
      && Math.abs(Number(canvas.offsetY || 0)) <= 0.5;
    stable = settled ? stable + 1 : 0;
    if (stable >= 2) return snapshot;
    await sleep(120);
  }
  throw new Error('Host canvas did not settle to O=0 after the wheel (canvas='
    + JSON.stringify(last?.ui?.canvas) + ' observed=' + JSON.stringify(last?.ui?.observed) + ')');
}
async function enterPickMode() {
  const button = await centerOf(`document.querySelector('[data-utb-pick-entry]')`);
  await clickAt(button.x, button.y);
  await waitFor(async () => (await readEntry()).pick?.state === 'on', { timeoutMs: 5000, intervalMs: 100, label: 'pick mode on' });
  // Entering the mode adds its status line and shifts the preview: always re-measure afterwards.
  await sleep(250);
}
async function exitPickMode() {
  const current = await readEntry();
  if (current.pick?.state !== 'on') return;
  const button = await centerOf(`document.querySelector('[data-utb-pick-entry]')`);
  await clickAt(button.x, button.y);
  await waitFor(async () => (await readEntry()).pick?.state !== 'on', { timeoutMs: 5000, intervalMs: 100, label: 'pick mode off' });
}

/* ------------------------------------------------------------------------------------------------
 * Main.
 * ---------------------------------------------------------------------------------------------- */
async function main() {
  if (!existsSync(DEFAULT_PROFILE) || !existsSync(join(DEFAULT_PROFILE, 'node_modules'))) {
    notRun('ENV', 'isolated DSH instance', `user DSH profile missing at ${DEFAULT_PROFILE}`);
    await writeReport(0);
    return 0;
  }
  if (!existsSync(CHROME_BIN)) {
    notRun('ENV', 'headless Chromium', `chrome binary/wrapper missing: ${CHROME_BIN}`);
    await writeReport(0);
    return 0;
  }
  await mkdir(RUN_DIR, { recursive: true });
  await mkdir(EVIDENCE_DIR, { recursive: true });

  const { startFixtureServer } = await import(pathToFileURL(join(REPO_ROOT, 'tests/ui_test_fixture/server.mjs')).href);
  const { scanPluginChromeProcesses } = await import(pathToFileURL(join(HERE, 'harness.mjs')).href);
  const baselineChromes = scanPluginChromeProcesses().map((entry) => entry.pid);

  state.fixture = await startFixtureServer();
  const fixtureUrl = new URL(FIXTURE_PAGE, state.fixture.url).href;
  observations.fixtureUrl = fixtureUrl;
  log(`[env] fixture: ${fixtureUrl}`);
  log(`[env] chrome: ${CHROME_BIN}`);

  const cleanup = async (reason) => {
    log(`\n[cleanup] ${reason}`);
    if (state.chrome) {
      try { state.chrome.cdp.close(); } catch { /* ignore */ }
      try { state.chrome.proc.kill('SIGTERM'); } catch { /* ignore */ }
      await sleep(500);
      try { state.chrome.proc.kill('SIGKILL'); } catch { /* ignore */ }
      await rm(state.chrome.profileDir, { recursive: true, force: true, maxRetries: 5 }).catch(() => {});
      state.chrome = undefined;
    }
    const reapPluginChromium = async () => {
      if (state.dsh?.existing) return 0;
      let killed = 0;
      for (const entry of scanPluginChromeProcesses()) {
        if (baselineChromes.includes(entry.pid)) continue;
        if (!String(entry.profileDir).includes('dsh-ui-testing-')) continue;
        try { process.kill(entry.pid, 'SIGKILL'); killed += 1; log(`[cleanup] killed leftover plugin Chromium pid=${entry.pid}`); } catch { /* ignore */ }
        await rm(entry.profileDir, { recursive: true, force: true }).catch(() => {});
      }
      return killed;
    };
    if (state.dsh && !state.dsh.existing) {
      try { state.dsh.proc.kill('SIGTERM'); } catch { /* ignore */ }
      await sleep(800);
      try { state.dsh.proc.kill('SIGKILL'); } catch { /* ignore */ }
      // Reap the plugin Chromium BEFORE closing the fixture: its keep-alive connections would
      // otherwise keep the fixture's server.close() callback pending (the fixture's own safety
      // timer is unref'd, which would drain the event loop and exit with an unsettled top-level
      // await instead of writing the report).
      for (let round = 0; round < 3; round += 1) {
        if (await reapPluginChromium() === 0) break;
        await sleep(500);
      }
      await rm(state.dsh.home, { recursive: true, force: true, maxRetries: 5 }).catch(() => {});
      state.dsh = undefined;
    }
    if (state.fixture) {
      const fixture = state.fixture;
      state.fixture = undefined;
      // Bounded close: a leaked keep-alive connection must never block the report.
      await Promise.race([
        new Promise((resolve) => fixture.close(resolve)),
        new Promise((resolve) => setTimeout(resolve, 3000)),
      ]);
    }
    await sleep(400);
    await reapPluginChromium();
  };

  try {
    const dsh = await startIsolatedDsh({ chromeBin: CHROME_BIN });
    log(`[env] ${dsh.existing ? 'existing' : 'isolated'} DSH: ${dsh.base} (port ${dsh.port})`);
    observations.isolatedDsh = { base: dsh.base, port: dsh.port, existing: Boolean(dsh.existing), copied: dsh.copied };
    const cookies = await authenticate(dsh.launchUrl);
    state.chrome = await launchGuiChrome(CHROME_BIN);
    const { cdp } = state.chrome;
    await cdp.send('Page.enable');
    await cdp.send('Runtime.enable');
    await cdp.send('Network.enable', { maxPostDataSize: 65536 });
    hookNetworkEvents();
    log(`[env] GUI chromium devtools port ${state.chrome.devtoolsPort}`);
    for (const cookie of cookies) {
      const eq = cookie.indexOf('=');
      await cdp.send('Network.setCookie', { name: cookie.slice(0, eq), value: cookie.slice(eq + 1), url: new URL(dsh.base).origin + '/' });
    }
    await cdp.send('Page.navigate', { url: dsh.launchUrl });
    await guiReady(45000);
    if (dsh.existing && process.env.DSH_SELECT_GUI_SESSION) {
      const title = JSON.stringify(process.env.DSH_SELECT_GUI_SESSION);
      await waitFor(async () => pageEvaluate(`Array.from(document.querySelectorAll('span')).some(n=>n.textContent===${title})`), { label: 'requested GUI session' });
      const point = await centerOf(`Array.from(document.querySelectorAll('span')).find(n=>n.textContent===${title})`);
      await clickAt(point.x, point.y);
      await sleep(800);
    }

    const location = await pageEvaluate('location.href');
    check('G0.1', 'GUI loads from the requested Host (isolated by default)',
      (dsh.existing || (dsh.port !== 3080 && dsh.port !== 3081)) && String(location).startsWith(dsh.base),
      { base: dsh.base }, { location: sanitize(location), port: dsh.port });
    check('G0.2', 'launch token is exchanged away and never appears in the run log',
      !String(location).includes('token=') && !logLines.join('\n').includes(state.token),
      { tokenInLocation: false, tokenInLog: false }, { location: sanitize(location) });
    const served = await pageEvaluate(`(async () => {
      const boot = window.__DSH_BOOT__;
      const entry = boot && Array.isArray(boot.entries) ? boot.entries.find((candidate) => candidate.id === 'dsh-agent-team-ui-testing') : undefined;
      if (!entry || !entry.url) return null;
      const response = await fetch(entry.url, { credentials: 'same-origin', cache: 'no-store' });
      return { rev: entry.rev || '', text: await response.text() };
    })()`);
    const servedHasPick = Boolean(served && served.text.includes('data-utb-pick-entry') && served.text.includes('已加入聊天框'));
    observations.servedClient = { rev: served?.rev || '', bytes: served ? Buffer.byteLength(served.text, 'utf8') : 0, hasPickCode: servedHasPick };
    check('G0.3', 'GUI serves this checkout client.js with the element-pick code', servedHasPick, true, observations.servedClient);

    const contextOnly = process.argv.includes('--context-only');
    const selectOnly = process.argv.includes('--select-only') || contextOnly;
    if (!selectOnly) {
    log('\n--- G1 panel + cold runtime ---');
    await openDebugPanelInSidebar();
    await waitFor(() => state.scopeHeaders, { timeoutMs: 15000, label: 'panel scope headers' });
    check('G1.1', 'right-sidebar guide entry opens the debug panel (.utb)', await pageEvaluate(`!!document.querySelector('.utb')`), true, true);
    check('G1.2', 'panel renders without a page exception', state.exceptions.length === 0, [], state.exceptions.slice(0, 3));
    const mounted = await readEntry();
    observations.mountedEntry = mounted;
    // The panel may auto-ensure about:blank on mount: force a genuine cold runtime via /close.
    let beforeCold = await hostState();
    observations.initialRuntime = { running: beforeCold.running, address: beforeCold.ui?.address };
    if (beforeCold.running) {
      const closed = await pageHostFetch('/close', { method: 'POST', headers: jsonHeaders(), body: {} });
      log(`[env] panel auto-ensure created a page; POST /close -> ${closed.status}`);
      await waitFor(async () => { const snapshot = await hostState(); return snapshot.running === false ? snapshot : undefined; },
        { timeoutMs: 12000, label: 'cold runtime after /close' });
    }
    const coldEntry = await waitFor(async () => {
      const entry = await readEntry();
      return entry.pick?.state === 'cold' ? entry : undefined;
    }, { timeoutMs: 8000, intervalMs: 100, label: 'pick entry cold state' });
    observations.coldEntry = coldEntry;
    check('G1.3', 'cold runtime: entry disabled with data-utb-pick-entry=cold',
      coldEntry.pick.disabled === true && coldEntry.pick.state === 'cold',
      { disabled: true, state: 'cold' }, coldEntry.pick);
    check('G1.4', 'cold runtime: aria-pressed=false and title asks to start the browser',
      coldEntry.pick.pressed === 'false' && String(coldEntry.pick.title).includes('需先启动内嵌浏览器'),
      { pressed: 'false', title: '需先启动内嵌浏览器' }, { pressed: coldEntry.pick.pressed, title: coldEntry.pick.title });
    await capturePng('panel-cold.png');

    log('\n--- G2 navigation + ready entry ---');
    await setAddressBar(fixtureUrl);
    await waitFor(async () => {
      const snapshot = await hostState();
      return snapshot.running === true && String(snapshot.ui?.address || '') === fixtureUrl ? snapshot : undefined;
    }, { timeoutMs: 25000, label: 'panel navigation to fixture' });
    await waitFor(async () => pageEvaluate(`(() => { const img = document.querySelector('.utb-frame'); return Boolean(img && img.naturalWidth > 0); })()`),
      { timeoutMs: 20000, label: 'panel preview frame decoded' }).catch(() => {});
    await sleep(500);
    const readyEntry = await waitFor(async () => {
      const entry = await readEntry();
      return entry.pick?.state === 'ready' ? entry : undefined;
    }, { timeoutMs: 12000, intervalMs: 100, label: 'pick entry ready state' });
    observations.readyEntry = readyEntry;
    check('G2.1', 'address-bar navigation reached the fixture page',
      (await hostState()).running === true && (await hostState()).ui?.address === fixtureUrl, fixtureUrl, (await hostState()).ui?.address);
    check('G2.2', 'preview frame is decoded (naturalWidth > 0)',
      await pageEvaluate(`(() => { const img = document.querySelector('.utb-frame'); return Boolean(img && img.naturalWidth > 0); })()`), true, true);
    check('G2.3', 'running page: entry ready, enabled and aria-pressed=false',
      readyEntry.pick.disabled === false && readyEntry.pick.pressed === 'false',
      { disabled: false, pressed: 'false' }, readyEntry.pick);
    const targetRect = await pageTargetRect();
    observations.pageTargetRect = targetRect;
    check('G2.4', 'fixture #pick-target document rect is (300,300) 160x44 (Host page read)',
      targetRect && targetRect.x === 300 && targetRect.y === 300 && targetRect.width === 160 && targetRect.height === 44,
      { x: 300, y: 300, width: 160, height: 44 }, targetRect);
    await capturePng('panel-page.png');

    log('\n--- G3 mode entry + mutual exclusion ---');
    await enterPickMode();
    const pickOn = await readEntry();
    observations.pickOnEntry = pickOn;
    check('G3.1', 'entry click enters pick mode: data-utb-pick-entry=on, aria-pressed=true',
      pickOn.pick.state === 'on' && pickOn.pick.pressed === 'true', { state: 'on', pressed: 'true' }, pickOn.pick);
    check('G3.2', 'pick mode renders the overlay layer (data-utb-pick-layer)',
      await pageEvaluate(`!!document.querySelector('[data-utb-pick-layer]')`), true, true);
    check('G3.3', 'pick mode disables the annotation entry (data-utb-annot-entry=pick)',
      pickOn.annot.state === 'pick' && pickOn.annot.disabled === true,
      { state: 'pick', disabled: true }, pickOn.annot);
    check('G3.4', 'pick mode disables the sizing entry (data-utb-size-entry=pick)',
      pickOn.size.state === 'pick' && pickOn.size.disabled === true,
      { state: 'pick', disabled: true }, pickOn.size);
    await exitPickMode();
    const afterExit = await readEntry();
    check('G3.5', 'exit restores both sibling entries (annot/size not disabled by pick)',
      afterExit.annot.disabled === false && afterExit.size.disabled === false && afterExit.pick.state === 'ready',
      { annotDisabled: false, sizeDisabled: false, pick: 'ready' },
      { annotDisabled: afterExit.annot.disabled, sizeDisabled: afterExit.size.disabled, pick: afterExit.pick.state });
    const annotButton = await centerOf(`document.querySelector('[data-utb-annot-entry]')`);
    await clickAt(annotButton.x, annotButton.y);
    await waitFor(async () => pageEvaluate(`!!document.querySelector('.utb-annot-bar')`), { timeoutMs: 8000, label: 'annotation bar' });
    const annotMode = await readEntry();
    observations.annotModeEntry = annotMode;
    check('G3.6', 'annotation mode makes pick unavailable (data-utb-pick-entry=annot, disabled)',
      annotMode.pick.state === 'annot' && annotMode.pick.disabled === true,
      { state: 'annot', disabled: true }, annotMode.pick);
    await clickAt(annotButton.x, annotButton.y);
    await waitFor(async () => !(await pageEvaluate(`!!document.querySelector('.utb-annot-bar')`)), { timeoutMs: 8000, label: 'annotation exit' });
    const sizeButton = await centerOf(`document.querySelector('[data-utb-size-entry]')`);
    await clickAt(sizeButton.x, sizeButton.y);
    const sizingMode = await waitFor(async () => {
      const entry = await readEntry();
      return entry.size?.state === 'on' ? entry : undefined;
    }, { timeoutMs: 8000, intervalMs: 100, label: 'sizing mode on' });
    observations.sizingModeEntry = sizingMode;
    check('G3.7', 'sizing mode makes pick unavailable (data-utb-pick-entry=sizing, disabled)',
      sizingMode.pick.state === 'sizing' && sizingMode.pick.disabled === true,
      { state: 'sizing', disabled: true }, sizingMode.pick);
    await clickAt(sizeButton.x, sizeButton.y);
    await waitFor(async () => (await readEntry()).size?.state !== 'on', { timeoutMs: 8000, intervalMs: 100, label: 'sizing mode off' });

    log('\n--- G4 hover overlay ---');
    // G5 precondition: an existing draft must survive the append (the block goes to the end).
    const DRAFT_MARKER = 'UTB-DRAFT-' + Date.now().toString(36);
    const prefillPoint = await centerOf(`document.querySelector('[data-composer-input]')`);
    await clickAt(prefillPoint.x, prefillPoint.y);
    await state.chrome.cdp.send('Input.insertText', { text: DRAFT_MARKER });
    await sleep(250);
    const prefilled = await readComposer();
    observations.prefilledComposer = { marker: DRAFT_MARKER, text: prefilled.text.slice(0, 200) };
    check('G4.0', 'an existing composer draft is present before picking (append precondition)',
      prefilled.text.includes(DRAFT_MARKER), true, prefilled.text.slice(0, 160));
    await enterPickMode();
    const center = { x: (targetRect?.x ?? 300) + (targetRect?.width ?? 160) / 2, y: (targetRect?.y ?? 300) + (targetRect?.height ?? 44) / 2 };
    const hovered = await hoverAt(center);
    const preview = hovered.preview;
    const view = hovered.view;
    const canvas = hovered.canvas;
    const screen = hovered.point;
    const firstHover = hovered.overlay;
    observations.hoverGeometry = { preview: preview.painted, view: { width: view.width, height: view.height }, canvas: { x: canvas.x, y: canvas.y }, docPoint: center, screen };
    observations.firstHover = firstHover;
    check('G4.1', 'hover renders the overlay (data-utb-pick-state=hover)',
      firstHover.layer?.state === 'hover' && Boolean(firstHover.outline) && Boolean(firstHover.tag), 'hover + outline + tag', firstHover);
    check('G4.2', 'overlay tag is button#pick-target', firstHover.tag === 'button#pick-target', 'button#pick-target', firstHover.tag);
    check('G4.3', 'data-utb-pick-rect equals the Host document rect (300,300,160,44)',
      firstHover.outline.rect && firstHover.outline.rect.x === 300 && firstHover.outline.rect.y === 300
        && firstHover.outline.rect.width === 160 && firstHover.outline.rect.height === 44,
      { x: 300, y: 300, width: 160, height: 44 }, firstHover.outline.rect);
    check('G4.4', 'hover keeps data-utb-pick-selector empty (detail:false)',
      firstHover.outline.selector === '', '', firstHover.outline.selector);
    const expectScreen = screenRectFor(preview, firstHover.outline.rect, view, canvas);
    observations.hoverScreen = { expected: expectScreen, actual: firstHover.outline.box };
    check('G4.5', 'overlay screen rect matches panel/view mapping within 2px',
      ['left', 'top', 'width', 'height'].every((key) => near(firstHover.outline.box?.[key], expectScreen[key], 2)),
      expectScreen, firstHover.outline.box);
    check('G4.6', 'hover does not dispatch page events (fixture click counter still 0)',
      (await pageCounters())?.document === 0 && (await pageCounters())?.target === 0,
      { document: 0, target: 0 }, await pageCounters());
    check('G4.7', 'overlay lives only in the panel DOM, never in the Host page DOM',
      await hostEvalJson(`JSON.stringify(document.querySelector('[data-utb-pick-outline]') === null)`) === 'true',
      true, true);
    await capturePng('hover.png');

    log('\n--- G5 click adds the element to the composer ---');
    // Test-only hook: client exposes the exact ref/label/model text it inserted (guarded by the
    // page global below) so this suite can verify "chip display != model text" without sending.
    await pageEvaluate('window.__UTB_TEST_HOOKS__ = true; true');
    await clickAt(screen.x, screen.y);
    const committed = await waitFor(async () => {
      const status = await readOverlay();
      const composer = await readComposer();
      const chip = (composer.chips || []).find((item) => item.title.includes('#pick-target'));
      return status.status?.kind === 'ok' && chip ? { status: status.status, composer, chip } : undefined;
    }, { timeoutMs: 10000, intervalMs: 150, label: 'composer @ element chip inserted' });
    observations.committed = committed;
    const composerText = committed.composer.text;
    const chip = committed.chip;
    check('G5.1', 'composer contains one @ element chip labelled 元素 #pick-target',
      Boolean(chip) && chip.title === '元素 #pick-target' && chip.text.includes('元素 #pick-target'),
      { title: '元素 #pick-target' }, chip);
    check('G5.2', 'existing draft is preserved and the chip is appended after it',
      composerText.includes(DRAFT_MARKER)
        && composerText.indexOf(DRAFT_MARKER) < composerText.indexOf('元素 #pick-target'),
      true, { markerIndex: composerText.indexOf(DRAFT_MARKER), chipIndex: composerText.indexOf('元素 #pick-target') });
    check('G5.3', 'status is ok: 已加入聊天框（引用）：#pick-target',
      committed.status.kind === 'ok' && committed.status.text.includes('已加入聊天框（引用）：#pick-target'),
      { kind: 'ok', text: '已加入聊天框（引用）：#pick-target' }, committed.status);
    const elementRef = await pageEvaluate('window.__UTB_ELEMENT_REF_LAST__ || null');
    observations.elementRef = elementRef;
    check('G5.4', 'chip clipboard projection is compact while the model text carries the full block',
      elementRef?.clipboardText === '@元素 #pick-target'
        && elementRef?.label === '元素 #pick-target'
        && String(elementRef?.modelText || '').includes('[调试视图元素] <button id="pick-target" type="button">Pick Target</button>')
        && String(elementRef?.modelText || '').includes('selector: #pick-target')
        && String(elementRef?.modelText || '').includes('rect(文档坐标): x=300, y=300, 160×44')
        && String(elementRef?.modelText || '').includes('role: button · name: Pick Target')
        && String(elementRef?.modelText || '').includes('page: ' + fixtureUrl),
      { clipboardText: '@元素 #pick-target', modelText: 'full [调试视图元素] block with selector/rect/role/page' },
      { clipboardText: elementRef?.clipboardText, label: elementRef?.label, modelText: String(elementRef?.modelText || '').slice(0, 200) });
    check('G5.5', 'the referenced payload keeps host facts (unique selector + document rect)',
      elementRef?.payload?.selector === '#pick-target'
        && elementRef?.payload?.selectorQuality === 'unique'
        && elementRef?.payload?.rect?.x === 300 && elementRef?.payload?.rect?.y === 300
        && elementRef?.payload?.rect?.width === 160 && elementRef?.payload?.rect?.height === 44
        && elementRef?.payload?.page?.url === fixtureUrl,
      { selector: '#pick-target', quality: 'unique', rect: { x: 300, y: 300, width: 160, height: 44 } },
      { selector: elementRef?.payload?.selector, quality: elementRef?.payload?.selectorQuality, rect: elementRef?.payload?.rect });
    const exited = await waitFor(async () => {
      const entry = await readEntry();
      const overlay = await readOverlay();
      return entry.pick?.state === 'ready' && entry.pick.pressed === 'false' && !overlay.outline ? entry : undefined;
    }, { timeoutMs: 6000, intervalMs: 100, label: 'pick mode exited after commit' });
    check('G5.7', 'successful commit exits pick mode and clears the overlay',
      exited.pick.state === 'ready' && exited.pick.pressed === 'false', { state: 'ready', pressed: 'false' }, exited.pick);
    check('G5.8', 'composer has focus after the append', committed.composer.activeIsComposer, true,
      { activeIsComposer: committed.composer.activeIsComposer, activeTag: committed.composer.activeTag });
    // G5.6: the plugin-owned @ source is registered and exposes exactly the picked element through
    // the same functions the menu uses (candidates / onPick insert shape / codec.serialize).
    // The menu DOM itself is not driven by programmatic input in this isolated profile, so that
    // interaction is recorded as NOT_RUN rather than claimed.
    // Functions cannot cross pageEvaluate (JSON-only); call them inside the page.
    const sourceHook = await pageEvaluate(`(() => {
      const hook = window.__UTB_ELEMENT_SOURCE_HOOK__;
      return hook ? { registered: hook.registered, name: hook.name, lastSessionId: hook.lastSessionId } : null;
    })()`);
    const sourceCandidates = await pageEvaluate(`(() => {
      const hook = window.__UTB_ELEMENT_SOURCE_HOOK__;
      return hook && typeof hook.candidates === 'function' ? hook.candidates('') : null;
    })()`);
    const sourceInsert = elementRef?.ref
      ? await pageEvaluate(`window.__UTB_ELEMENT_SOURCE_HOOK__.insertFor(${JSON.stringify(elementRef.ref)})`)
      : null;
    const sourceSerialized = elementRef?.ref
      ? await pageEvaluate(`window.__UTB_ELEMENT_SOURCE_HOOK__.serialize(${JSON.stringify(elementRef.ref)})`)
      : null;
    observations.elementSourceHook = { hook: sourceHook, candidates: sourceCandidates, insert: sourceInsert, serialized: sourceSerialized };
    check('G5.6', '@ element source is registered and advertises the picked element as a candidate',
      sourceHook?.registered === true
        && sourceHook?.name === 'ui-element'
        && Array.isArray(sourceCandidates)
        && sourceCandidates.some((candidate) => candidate.label === '元素 #pick-target'
          && candidate.name === '#pick-target' && candidate.value === elementRef.ref)
        && sourceInsert?.source === 'ui-element'
        && sourceInsert?.label === '元素 #pick-target'
        && sourceInsert?.clipboardText === '@元素 #pick-target'
        && String(sourceSerialized || '').includes('[调试视图元素]')
        && String(sourceSerialized || '').includes('selector: #pick-target'),
      { registered: true, candidateLabel: '元素 #pick-target', insertClipboard: '@元素 #pick-target', serialized: 'full block' },
      {
        registered: sourceHook?.registered,
        name: sourceHook?.name,
        candidates: sourceCandidates,
        insert: sourceInsert,
        serialized: String(sourceSerialized || '').slice(0, 160),
      });
    notRun('G5.6-menu', '@ 菜单 DOM 交互（隔离实例）',
      '程序化 insertText/keydown 未触发 DSH 输入触发管线（隔离实例没有真实用户键盘路径），因此不把“菜单可见”写成通过；'
      + '来源注册/candidates/onPick/serialize 已由 G5.6 直接调用插件同一份代码验证',
      { verifiedBy: 'G5.6 source hook', menuProbe: 'not-open' });

    // Evidence note: the chip assertion reads the REAL composer DOM (`[data-composer-input]`
    // descendants with a title attribute), not the client's status line; the model text comes from
    // the insertion hook (G5.4), which is the codec.serialize output for the same ref.
    observations.composerEvidence = {
      selector: '[data-composer-input]',
      source: 'chip DOM (title attribute) + client insertion hook (ref/label/clipboardText/modelText)',
      text: composerText,
      chip,
      elementRef: elementRef
        ? { label: elementRef.label, clipboardText: elementRef.clipboardText, modelText: elementRef.modelText }
        : null,
      lines: {
        chip: Boolean(chip),
        draftPreserved: composerText.includes(DRAFT_MARKER),
        modelBlock: String(elementRef?.modelText || '').includes('[调试视图元素]'),
      },
    };
    const clicksAfterCommit = await pageCounters();
    check('G5.9', 'the pick gesture itself dispatched zero page clicks',
      clicksAfterCommit?.document === 0 && clicksAfterCommit?.target === 0,
      { document: 0, target: 0 }, clicksAfterCommit);
    await capturePng('committed.png');

    log('\n--- G5.11 forced fallback: chip unavailable appends the full text block ---');
    await pageEvaluate('window.__UTB_TEST_FORCE_TEXT_APPEND__ = true; true');
    await enterPickMode();
    const fallbackHover = await hoverAt(center);
    const fallbackPoint = fallbackHover.point;
    await clickAt(fallbackPoint.x, fallbackPoint.y);
    const fallback = await waitFor(async () => {
      const status = await readOverlay();
      const composer = await readComposer();
      return status.status?.kind === 'ok' && composer.text.includes('[调试视图元素]') ? { status: status.status, composer } : undefined;
    }, { timeoutMs: 10000, intervalMs: 150, label: 'fallback text block appended' });
    observations.fallback = fallback;
    check('G5.11', 'forced chip failure falls back to the full text block and marks status （文本）',
      fallback.status.kind === 'ok'
        && fallback.status.text.includes('已加入聊天框（文本）：#pick-target')
        && fallback.status.text.includes('引用不可用：forced')
        && fallback.composer.text.includes('[调试视图元素] <button id="pick-target" type="button">Pick Target</button>')
        && fallback.composer.text.includes('selector: #pick-target')
        && fallback.composer.text.includes('rect(文档坐标): x=300, y=300, 160×44'),
      { status: '已加入聊天框（文本）：#pick-target（引用不可用：forced）', block: 'full [调试视图元素] lines' },
      { status: fallback.status, tail: fallback.composer.text.slice(-260) });
    await pageEvaluate('window.__UTB_TEST_FORCE_TEXT_APPEND__ = false; true');

    log('\n--- G5.12 inserting a second chip keeps the existing chip and maps the draft end ---');
    await enterPickMode();
    const secondHover = await hoverAt(center);
    await clickAt(secondHover.point.x, secondHover.point.y);
    const secondChip = await waitFor(async () => {
      const status = await readOverlay();
      const composer = await readComposer();
      const chips = composer.chips || [];
      return status.status?.kind === 'ok' && chips.length >= 2 ? { status: status.status, composer, chips } : undefined;
    }, { timeoutMs: 10000, intervalMs: 150, label: 'second @ chip inserted next to the first' });
    observations.secondChip = secondChip;
    check('G5.12', 'a second pick inserts another @ chip without losing the existing one',
      secondChip.status.text.includes('已加入聊天框（引用）：#pick-target')
        && secondChip.chips.length >= 2
        && secondChip.chips.every((item) => item.title === '元素 #pick-target'),
      { status: '已加入聊天框（引用）：#pick-target', chips: 2 },
      { status: secondChip.status, chips: secondChip.chips });

    // G5.13: the sent user message is rendered through the transcript rule (same text the model
    // gets), folded into a compact reference chip. The rule/matcher are verified directly; the
    // rendered transcript needs a real provider message stream, so that stays NOT_RUN.
    const transcriptSample = [
      '[调试视图元素] <button id="pick-target" type="button">Pick Target</button>',
      'selector: #pick-target',
      'role: button · name: Pick Target',
      'rect(文档坐标): x=300, y=300, 160×44',
      'page: ' + fixtureUrl,
    ].join('\n');
    const transcriptMatch = await pageEvaluate(`(() => {
      const hook = window.__UTB_ELEMENT_SOURCE_HOOK__;
      return hook && typeof hook.matchText === 'function' ? hook.matchText(${JSON.stringify(transcriptSample)}, 0) : null;
    })()`);
    const transcriptState = await pageEvaluate(`(() => {
      const hook = window.__UTB_ELEMENT_SOURCE_HOOK__;
      return hook ? hook.textRule : null;
    })()`);
    observations.transcriptRule = { match: transcriptMatch, state: transcriptState, sample: transcriptSample };
    check('G5.13', 'transcript rule matches the sent element block into compact chip data',
      transcriptState?.registered === true
        && transcriptState?.slotRegistered === true
        && transcriptMatch?.id === 'ui-element'
        && transcriptMatch?.start === 0
        && transcriptMatch?.end === transcriptSample.length
        && transcriptMatch?.data?.label === '元素 #pick-target'
        && transcriptMatch?.data?.selector === '#pick-target'
        && transcriptMatch?.data?.rect === 'x=300, y=300, 160×44'
        && transcriptMatch?.data?.page === fixtureUrl
        && transcriptMatch?.data?.truncation === null,
      { id: 'ui-element', start: 0, end: transcriptSample.length, label: '元素 #pick-target' },
      { state: transcriptState, match: transcriptMatch });
    // G5.13b: the exact shape produced for the live Baidu pick (long nth-of-type selector,
    // empty AX name, truncated outerHTML) still parses into chip data + truncation disclosure.
    const truncatedSample = [
      '[调试视图元素] <div class="chat-input-container"><div id="chat-input-top-band"><!--4--><div><!--5--><!--6--></div><!--4--></div><div id="chat-input-area"><textarea id="chat-textarea" class="chat-input-textarea chat-input-scroll-style" data-ai-placeholder=…',
      'selector: #chat-input-main > div:nth-of-type(4) > div:nth-of-type(1)',
      'role: generic · name: ',
      'rect(文档坐标): x=113, y=186, 798×97',
      'page: https://www.baidu.com/',
      'outerHTML: 截断 240/3316 码点（末尾 …，完整文本未取得）',
    ].join('\n');
    const truncatedMatch = await pageEvaluate(`(() => {
      const hook = window.__UTB_ELEMENT_SOURCE_HOOK__;
      return hook && typeof hook.matchText === 'function' ? hook.matchText(${JSON.stringify(truncatedSample)}, 0) : null;
    })()`);
    observations.transcriptRuleTruncated = { match: truncatedMatch, sample: truncatedSample };
    // G5.13c: user text typed right after the chip lands on the last block line; only the block
    // may be folded, the caller's own sentence must stay outside the chip.
    const withUserText = truncatedSample + ' 帮我检查这个登录按钮';
    const splitMatch = await pageEvaluate(`(() => {
      const hook = window.__UTB_ELEMENT_SOURCE_HOOK__;
      return hook && typeof hook.matchText === 'function' ? hook.matchText(${JSON.stringify(withUserText)}, 0) : null;
    })()`);
    observations.transcriptRuleTrailingText = { match: splitMatch, sample: withUserText };
    check('G5.13c', 'trailing user text after the chip stays outside the folded reference',
      splitMatch?.start === 0
        && splitMatch?.end === truncatedSample.length
        && splitMatch?.data?.truncation === '截断 240/3316 码点（末尾 …，完整文本未取得）'
        && splitMatch?.data?.page === 'https://www.baidu.com/'
        && withUserText.slice(splitMatch.end) === ' 帮我检查这个登录按钮',
      { end: truncatedSample.length, remainder: ' 帮我检查这个登录按钮' },
      { end: splitMatch?.end, remainder: withUserText.slice(splitMatch?.end ?? 0), data: splitMatch?.data });
    check('G5.13b', 'transcript rule keeps the long selector + truncation disclosure for the live block shape',
      truncatedMatch?.start === 0
        && truncatedMatch?.end === truncatedSample.length
        && truncatedMatch?.data?.selector === '#chat-input-main > div:nth-of-type(4) > div:nth-of-type(1)'
        && truncatedMatch?.data?.label === '元素 #chat-input-main > div:nth-of-type(4) > div:nth-of-type(1)'
        && truncatedMatch?.data?.rect === 'x=113, y=186, 798×97'
        && truncatedMatch?.data?.page === 'https://www.baidu.com/'
        && String(truncatedMatch?.data?.truncation || '').includes('截断 240/3316 码点'),
      { label: '元素 <long selector>', truncation: '截断 240/3316 码点（末尾 …，完整文本未取得）' },
      truncatedMatch);
    notRun('G5.13-render', '聊天记录里的元素块实际渲染（隔离实例）',
      '规则注册与匹配已由 G5.13 直接验证；真实 transcript 渲染需要 provider 消息流（隔离实例无消息发送，无法构造发送后的用户消息），不把“已折叠显示”写成通过',
      { verifiedBy: 'G5.13 matcher/registration' });

    log('\n--- G6 Esc / pointerleave / zero page input ---');
    await enterPickMode();
    await hoverAt(center);
    await moveTo(4, 4);
    const cleared = await waitFor(async () => {
      const overlay = await readOverlay();
      return overlay.layer && !overlay.outline ? overlay : undefined;
    }, { timeoutMs: 5000, intervalMs: 100, label: 'overlay cleared on pointerleave' });
    check('G6.1', 'pointerleave clears the overlay (state idle, no outline)',
      cleared.layer?.state === 'idle' && !cleared.outline, { state: 'idle', outline: null }, cleared);
    check('G6.2', 'pointerleave still left the page click counter at 0', (await pageCounters())?.document === 0, 0, (await pageCounters())?.document);
    await pressEscape();
    const escExited = await waitFor(async () => {
      const entry = await readEntry();
      return entry.pick?.state === 'ready' ? entry : undefined;
    }, { timeoutMs: 5000, intervalMs: 100, label: 'pick mode exited on Escape' });
    check('G6.3', 'Esc exits pick mode', escExited.pick.state === 'ready', 'ready', escExited.pick.state);
    check('G6.4', 'Esc returns focus to the pick entry button',
      await pageEvaluate(`(() => { const a = document.activeElement; return Boolean(a && a.getAttribute && a.hasAttribute('data-utb-pick-entry')); })()`),
      true, true);
    // Esc inside the chat composer must not be hijacked by pick mode.
    await enterPickMode();
    const composerCenter = await centerOf(`document.querySelector('[data-composer-input]')`);
    await clickAt(composerCenter.x, composerCenter.y);
    const composerFocused = await readComposer();
    check('G6.5', 'clicking the composer focuses it (precondition for the Esc guard)', composerFocused.activeIsComposer,
      true, { activeIsComposer: composerFocused.activeIsComposer, activeTag: composerFocused.activeTag });
    await pressEscape();
    await sleep(250);
    check('G6.6', 'Esc inside the composer does NOT exit pick mode',
      (await readEntry()).pick?.state === 'on', 'on', (await readEntry()).pick?.state);
    await exitPickMode();

    log('\n--- G7 wheel scroll + re-hit after C changes ---');
    await enterPickMode();
    const hoveredBeforeWheel = await hoverAt(center);
    const scrollBefore = await pageScroll();
    // The client scales a wheel delta from painted px to page CSS px (`viewport / painted`), so
    // deltaY=240 became ~410 page px here and pushed #pick-target (document y=300..344) above the
    // visible band -> Host answered out-of-viewport and the overlay stayed idle. A small delta plus
    // a real scroll-settled wait keeps the target visible; the visible-band check below fails
    // loudly (instead of "overlay did not appear") if a future panel geometry changes that.
    await wheelAt(hoveredBeforeWheel.point.x, hoveredBeforeWheel.point.y, 60);
    const scrollAfter = await waitForScrollStable({ timeoutMs: 10000 });
    check('G7.1', 'wheel over the preview still scrolls the target page',
      scrollAfter.y > scrollBefore.y, { before: scrollBefore, after: 'y>' + scrollBefore.y }, scrollAfter);
    const viewForBand = (await hostState()).ui.view;
    const pageHeight = Number(viewForBand?.height) || 768;
    const targetTop = Number(targetRect?.y) || 300;
    const targetBottom = targetTop + (Number(targetRect?.height) || 44);
    check('G7.0', 'after the wheel the target is still inside the document-visible band',
      scrollAfter.y <= targetBottom && scrollAfter.y + pageHeight >= targetTop + 8,
      { scrollY: scrollAfter.y, visibleBand: [scrollAfter.y, scrollAfter.y + pageHeight], target: [targetTop, targetBottom] },
      { scrollY: scrollAfter.y, visibleBand: [scrollAfter.y, scrollAfter.y + pageHeight], target: [targetTop, targetBottom] });
    // Wait for the Host canvas C to actually follow the scroll, then for the client's wheel
    // debounce + re-hover (lead: give it ≥500ms). hoverAt() re-reads geometry/C per attempt, so a
    // late readback can only cause another remap, never a wrong or missing box.
    const settledAfterWheel = await waitForStableCanvas(scrollAfter.y, { timeoutMs: 12000 });
    await sleep(500);
    const viewAfter = settledAfterWheel.ui.view;
    const canvasAfter = settledAfterWheel.ui.canvas;
    check('G7.2', 'Host canvas origin C follows the page scroll after the wheel',
      Math.abs(Number(canvasAfter.y) - scrollAfter.y) < 0.5, { canvasY: scrollAfter.y }, { canvasY: canvasAfter.y, observedY: settledAfterWheel.ui.observed?.y });
    const hoveredAfterWheel = await hoverAt(center, { timeoutMs: 12000 });
    const hoverAfterWheel = hoveredAfterWheel.overlay;
    observations.hoverAfterWheel = { hover: hoverAfterWheel, screenAfter: hoveredAfterWheel.point, canvasAfter: { x: hoveredAfterWheel.canvas.x, y: hoveredAfterWheel.canvas.y } };
    check('G7.3', 'after the scroll settles, the same document point re-hits button#pick-target',
      hoverAfterWheel.tag === 'button#pick-target', 'button#pick-target', hoverAfterWheel.tag);
    check('G7.4', 'the re-hit overlay still reports the document rect (300,300,160,44)',
      hoverAfterWheel.outline.rect && hoverAfterWheel.outline.rect.x === 300 && hoverAfterWheel.outline.rect.y === 300
        && hoverAfterWheel.outline.rect.width === 160 && hoverAfterWheel.outline.rect.height === 44,
      { x: 300, y: 300, width: 160, height: 44 }, hoverAfterWheel.outline.rect);
    const expectAfter = screenRectFor(hoveredAfterWheel.preview, hoverAfterWheel.outline.rect, hoveredAfterWheel.view, hoveredAfterWheel.canvas);
    check('G7.5', 're-mapped overlay screen rect still matches the panel mapping within 2px',
      ['left', 'top', 'width', 'height'].every((key) => near(hoverAfterWheel.outline.box?.[key], expectAfter[key], 2)),
      expectAfter, hoverAfterWheel.outline.box);
    await capturePng('wheel-hover.png');
    await exitPickMode();

    log('\n--- G8 exit restores real page input ---');
    const finalPreview = await measurePreview();
    const finalSnapshot = await hostState();
    const clickPoint = screenPointFor(finalPreview, center, finalSnapshot.ui.view, finalSnapshot.ui.canvas);
    // A loaded machine can make the panel's input path miss its readiness window, so allow one
    // re-click and poll the page counters through the Host (each read is bounded 30s).
    const pollCounters = async (label, timeoutMs) => {
      const deadline = Date.now() + timeoutMs;
      let last = null;
      while (Date.now() < deadline) {
        try {
          const current = await pageCounters({ timeoutMs: 30000 });
          last = current;
          if (current && current.document >= 1) return current;
        } catch (error) {
          last = { error: String((error && error.message) || error).slice(0, 200) };
        }
        await sleep(250);
      }
      log(`[warn] ${label}: page click counter still not observed (last=${JSON.stringify(last)})`);
      return last;
    };
    await sleep(300);
    await clickAt(clickPoint.x, clickPoint.y);
    let counters = await pollCounters('first click', 12000);
    if (!counters || counters.document < 1) {
      await sleep(500);
      await clickAt(clickPoint.x, clickPoint.y);
      counters = await pollCounters('retry click', 12000);
    }
    observations.pageCounters = counters;
    check('G8.1', 'after exiting pick mode a real click on the preview reaches the page (document=1)',
      counters.document === 1, { document: 1 }, counters);
    check('G8.2', 'the same real click hit #pick-target (target=1)', counters.target === 1, { target: 1 }, counters.target);
    check('G8.3', 'a real page click does not enter pick mode', (await readEntry()).pick?.state === 'ready',
      'ready', (await readEntry()).pick?.state);
    check('G8.4', 'no uncaught page exception during the whole GUI run', state.exceptions.length === 0, [], state.exceptions.slice(0, 3));
    check('G8.5', 'no console.error during the whole GUI run', state.consoleErrors.length === 0, [], state.consoleErrors.slice(0, 3));
    check('G8.6', 'PNG evidence captured for the run', state.evidence.length >= 4, '>=4', state.evidence.map((entry) => entry.name));
    await capturePng('page-click.png');

    } else {
      await openDebugPanelInSidebar();
      await waitFor(() => state.scopeHeaders, { timeoutMs: 15000, label: 'select panel scope' });
    }

    if (!contextOnly) {
    log('\n--- S native select popover ---');
    const { runPanelSelectChecks } = await import('./panel-select-checks.mjs');
    await runPanelSelectChecks({
      fixtureUrl: new URL('/panel-select.html', state.fixture.url).href,
      pageEvaluate, hostEvalJson, pageHostFetch, jsonHeaders, measurePreview, hostState,
      screenPointFor, clickAt, centerOf, pressEscape, setAddressBar, waitFor, check,
      capturePng, observations, state,
    });

    }
    log('\n--- C page context menu ---');
    const { runPanelContextChecks } = await import('./panel-context-checks.mjs');
    await runPanelContextChecks({
      fixtureUrl: process.env.DSH_CONTEXT_GUI_FIXTURE_URL || new URL('/panel-context.html', state.fixture.url).href,
      pageEvaluate, hostEvalJson, measurePreview, hostState, screenPointFor,
      clickAt, centerOf, pressEscape, setAddressBar, waitFor, check, capturePng, observations, state,
    });

    if (dsh.existing && process.env.DSH_SELECT_GUI_RETURN_URL) await setAddressBar(process.env.DSH_SELECT_GUI_RETURN_URL);

    if (!selectOnly) {
    notRun('G9.1', 'canvas pan (O≠0) hover mapping',
      '需要真实拖拽平移并在 O≠0 空白带上做像素级断言；本轮 GUI 验收只覆盖 O=0 与页面滚动（C 变化）',
      { implementedIn: 'client.js pickScreenRect / mapEventPoint' });
    notRun('G9.2', 'main-panel identity=recent → no-session prompt',
      '本验收按要求使用右侧栏 session 面板；主面板 recent 场景需另建主面板并解析不到 session 时才能真实触发',
      { documentedLimitation: 'docs/element-picker.md' });
    notRun('G9.3', 'DPR≠1 / non-loopback GUI hostname',
      '插件固定 dsf=1；非 loopback hostname 需要代理/别名，按契约不伪造',
      { dpr: 1 });
    notRun('G9.4', 'closed-shadow inner-element selection',
      'closed shadow root 只能通过保存的 root 读取，面板命中链路不暴露该 root；iframe 内元素已由 S16–S17b 与 Host H8 真实覆盖',
      { hostCoverage: 'tests/acceptance/pick-element-host.mjs H8/H8c' });
    notRun('G9.5', 'sending phase prompt (聊天框正在发送，稍后再试)',
      '需要会话处于发送中 phase；隔离实例没有 provider 消息流，无法真实触发，按契约不伪造',
      { implementedIn: 'client.js pickAppendToChat / pickChatFailureText' });
    notRun('G9.6', '@ mention chip / quote preservation',
      '元素引用 chip 的插入/标签/模型文本已由 G5.1–G5.6 覆盖；quote 节点保留与外部 @file mention 混排仍需要构造真实 quote/mention 才能断言，不做推断',
      { coveredInsteadBy: 'G5.1–G5.6（@ element chip）；菜单 DOM 见 G5.6-menu NOT_RUN' });
    notRun('G9.7', 'panel close / tab switch / scope switch lifecycle',
      '需要会触发 scope/tab 生命周期变化的 GUI 操作；本轮覆盖导航与滚轮导致的 C 变化，不做推断',
      { implementedIn: 'client.js pick lifecycle effects' });
    observations.advisorChecklist = {
      G1: ['G1.1', 'G1.3', 'G2.3', 'G3.1', 'G3.3', 'G3.4', 'G3.6', 'G3.7'],
      G2: ['G4.1', 'G4.3', 'G4.5', 'G7.3', 'G7.4', 'G7.5'],
      G3: 'NOT_RUN G9.1（画布平移 O≠0）',
      G4: ['G7.1', 'G7.2', 'G7.3', 'G7.4', 'G7.5'],
      G5: ['G5.1', 'G5.2', 'G5.3', 'G5.4', 'G5.5', 'G5.6', 'G5.7', 'G5.8', 'G5.9', 'G5.11', 'G5.12', 'G5.13', 'G5.13b', 'G5.13c'],
      G6: 'NOT_RUN G9.5（发送中）',
      G7: 'NOT_RUN G9.2（主面板 recent / 无 session）',
      G8: ['G6.3', 'G6.4', 'G6.6'],
      G9: 'NOT_RUN G9.7（关闭面板/切 tab/切 scope）',
      G10: ['G1.3', 'G1.4', 'G2.3'],
    };
    }
  } catch (error) {
    if (state.chrome) {
      try {
        await capturePng('failure.png');
        observations.failureDom = await pageEvaluate(`({text:document.body.innerText.slice(0,3000),build:document.querySelector('.utb')?.dataset.utbBuild,buttons:Array.from(document.querySelectorAll('button')).slice(0,60).map(b=>({text:b.textContent,label:b.getAttribute('aria-label'),title:b.title}))})`);
        observations.contextTrace = await pageEvaluate('window.__contextTrace || []');
        observations.selectTraffic = [];
        for (const entry of state.elementTraffic.slice(-4)) {
          let body;
          try { body = (await state.chrome.cdp.send('Network.getResponseBody', { requestId: entry.requestId })).body; } catch { body = null; }
          observations.selectTraffic.push({ ...entry, body });
        }
        observations.lastRequestPaths = state.requests.slice(-15).map(entry => new URL(entry.url).pathname);
      } catch { /* evidence best effort */ }
    }
    check('SUITE.1', 'GUI scenarios completed without an uncaught exception', false, 'no exception', errorMessage(error));
  } finally {
    await cleanup('run finished');
  }

  const failed = checks.filter((entry) => !entry.pass).length;
  await writeReport(failed === 0 ? 0 : 1);
  log(`\npick-element-gui: ${checks.length - failed}/${checks.length} PASS, ${failed} failed, ${notRuns.length} NOT_RUN`);
  log(`evidence: ${RUN_DIR}`);
  return failed === 0 ? 0 : 1;
}

function buildReport() {
  const failed = checks.filter((entry) => !entry.pass).length;
  return {
    schemaVersion: 1,
    suite: process.argv.includes('--select-only') ? 'panel-select-gui' : 'pick-element-gui',
    startedAt: STAMP,
    finishedAt: new Date().toISOString(),
    environment: {
      isolatedDsh: observations.isolatedDsh || null,
      chrome: CHROME_BIN,
      dshBin: DSH_BIN,
      servedClient: observations.servedClient || null,
    },
    fixtureUrl: observations.fixtureUrl || null,
    checks,
    notRuns,
    observations,
    evidence: state.evidence,
    summary: { checks: checks.length, passed: checks.length - failed, failed, notRun: notRuns.length },
  };
}
async function writeReport(exitCode) {
  const report = buildReport();
  await mkdir(RUN_DIR, { recursive: true });
  await mkdir(EVIDENCE_DIR, { recursive: true });
  const body = JSON.stringify(report, null, 2);
  await writeFile(join(RUN_DIR, 'report.json'), body);
  await writeFile(join(EVIDENCE_DIR, 'report.json'), body);
  await writeFile(join(RUN_DIR, 'run.log'), logLines.join('\n') + '\n');
  log(`PASS=${report.summary.passed} FAIL=${report.summary.failed} NOT_RUN=${report.summary.notRun}`);
  log(`EXIT ${exitCode}`);
  return report;
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
  log('[fatal] ' + errorMessage(error));
  try { await writeReport(2); } catch { /* ignore */ }
  process.exit(2);
}
