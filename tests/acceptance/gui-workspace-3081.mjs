#!/usr/bin/env node
/**
 * Real-GUI acceptance for workspace-scoped debug panels on the isolated 3081 DSH host.
 *
 * What this proves (when run against a Host that implements docs/architecture.md):
 *   - Two REAL registered workspaces (/tmp/dsh-utb-ws-a, /tmp/dsh-utb-ws-b) and two REAL
 *     Session Controller sessions are created through the GUI (workspace directory picker +
 *     the workspace row's "new session" action). No workspace.json editing.
 *   - The root main panel is opened through the real shell (`更多` → `调试视图`) after MoreRow
 *     captured the session that owns the main view; its HTTP and WS traffic carries that
 *     session id (never a bare `recent`/legacy identity) and the frames it receives carry the
 *     matching Host scopeId/runtimeId.
 *   - A and B pages do not cross: each session's Host state keeps its own address, switching to
 *     B leaves A untouched, and switching back to A shows A's address/frames again.
 *   - The right sidebar tab is session-scoped via its real `sessionId` prop; collapsing the
 *     right sidebar stops its WS / frame / state / metrics traffic (no viewer heartbeat while
 *     hidden) and expanding it rebuilds the transport.
 *   - Hidden viewer behaviour is recorded from the Host metrics endpoint (`host.clients`) when
 *     available; the script never assumes the absolute client count is 0 because other viewers
 *     may be attached to the isolated host.
 *
 * NOT covered here (reported, never implied as verified):
 *   - Legacy Host compatibility (a Host without scope support cannot be exercised by this
 *     script; the client keeps it displayable and logs a warning but does not claim isolation).
 *   - Cookie/localStorage/cache isolation (explicitly out of scope).
 *   - The 3080 instance (never touched). This script never starts a replacement DSH and never
 *     restarts 3081; restarting 3081 is the Lead's coordinated step.
 *
 * Run:  node tests/acceptance/gui-workspace-3081.mjs
 * Env:  GUI_BASE (default http://127.0.0.1:3081; non-3081 needs ALLOW_NON_3081=1 and is reported
 *              as NOT 3081 evidence), DSH_3081_LOG (default /tmp/dsh-3081.log),
 *       DSH_ACCEPTANCE_CHROME / DSH_REAL_BROWSER_CHROME (default tests/acceptance/chrome-wrapper.sh),
 *       DSH_GUI_WORKSPACE_TIMEOUT_MS (default 420000).
 *
 * Exit codes: 0 all checks pass; 1 assertion failure; 2 unexpected fatal error.
 */
import { execFileSync, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

if (process.argv[1] !== fileURLToPath(import.meta.url)) {
  throw new Error('gui-workspace-3081.mjs 会驱动真实 3081 宿主浏览器，不能被 import 或通过 -e 触发；请直接运行 `node tests/acceptance/gui-workspace-3081.mjs`。');
}

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = dirname(dirname(HERE));
const RUN_DIR = join(HERE, 'runs', `gui-workspace-${new Date().toISOString().replace(/[:.]/g, '-')}-${process.pid}`);
const GUI_BASE = (process.env.GUI_BASE || 'http://127.0.0.1:3081').replace(/\/+$/, '');
const LOG_PATH = process.env.DSH_3081_LOG || '/tmp/dsh-3081.log';
const DSH_3081_HOME = process.env.DSH_3081_HOME || '/tmp/dsh-utb-home';
const CHROME_BIN = process.env.DSH_ACCEPTANCE_CHROME || process.env.DSH_REAL_BROWSER_CHROME || join(HERE, 'chrome-wrapper.sh');
const TOTAL_TIMEOUT_MS = Number(process.env.DSH_GUI_WORKSPACE_TIMEOUT_MS || 420000) || 420000;
const CHROME_PROFILE_PREFIX = 'dsh-gui-workspace-';
const WORKSPACE_A = { path: '/tmp/dsh-utb-ws-a', label: 'dsh-utb-ws-a' };
const WORKSPACE_B = { path: '/tmp/dsh-utb-ws-b', label: 'dsh-utb-ws-b' };
const BOUNDED_WAIT_MS = 4000;

const guiUrl = new URL(GUI_BASE);
if (!/^127\.0\.0\.1$/.test(guiUrl.hostname) && guiUrl.hostname !== 'localhost') {
  throw new Error(`GUI_BASE must be a loopback address, got ${GUI_BASE}`);
}
if (guiUrl.port !== '3081' && process.env.ALLOW_NON_3081 !== '1') {
  throw new Error(`refusing to run against ${GUI_BASE}: pass ALLOW_NON_3081=1 only for local debugging (result will NOT be 3081 evidence)`);
}

const logLines = [];
function log(line = '') {
  const text = String(line);
  logLines.push(text);
  console.log(text);
}
function sleep(ms) { return new Promise((resolve) => setTimeout(resolve, ms)); }
function errorMessage(error) { return String((error && error.stack) || (error && error.message) || error); }

function sanitize(text) {
  let value = String(text ?? '');
  if (state.token) value = value.split(state.token).join('[REDACTED_TOKEN]');
  if (state.cookie) value = value.split(state.cookie).join('[REDACTED_COOKIE]');
  if (state.cookie) {
    for (const pair of state.cookie.split('; ')) {
      const eq = pair.indexOf('=');
      if (eq > 0) value = value.split(pair.slice(eq + 1)).join('[REDACTED_COOKIE]');
    }
  }
  value = value.replace(/([?&]token=)(?!fake-not-secret)[^\s&"'#<>]+/g, '$1[REDACTED]');
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

/* ------------------------------------------------------------------------------------------------
 * CDP client.
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
          if (message.error) entry.reject(new Error(message.error.message || 'cdp error'));
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
      this.pending.set(id, { resolve, reject });
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
    }, { timeoutMs: 15000, label: 'DevToolsActivePort' });
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
 * Check bookkeeping / reporting.
 * ---------------------------------------------------------------------------------------------- */
const checks = [];
function fmt(value) {
  try {
    const text = JSON.stringify(value);
    return text === undefined ? String(value) : text.slice(0, 900);
  } catch { return String(value).slice(0, 900); }
}
function check(scenario, label, pass, expected, actual) {
  const entry = { scenario, label, pass: Boolean(pass), expected: safeValue(expected), actual: safeValue(actual) };
  checks.push(entry);
  log(`  [${pass ? 'PASS' : 'FAIL'}] ${scenario} ${label}`);
  if (!pass) log(`         expected: ${sanitize(fmt(expected))}\n         actual  : ${sanitize(fmt(actual))}`);
}
function safeValue(value) {
  try {
    const text = JSON.stringify(value);
    if (text === undefined) return String(value);
    return JSON.parse(text.replace(/[\u2028\u2029]/g, ' '));
  } catch { return sanitize(String(value)); }
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
 * State / credentials.
 * ---------------------------------------------------------------------------------------------- */
const state = {
  token: '',
  cookie: '',
  chrome: undefined,
  fixture: undefined,
  requests: [],
  wsEvents: [],
  wsFrames: [],
  scopes: {},
  sessions: {},
  buildInfo: null,
  hostInfo: null,
  servedClient: null,
  usedNativeValueSetter: 0,
  enterFallback: 0,
  observations: {},
};

async function loadToken() {
  const text = await readFile(LOG_PATH, 'utf8');
  const urls = [...text.matchAll(/https?:\/\/[^\s"'<>]*[?&]token=[^\s"'&<>]+/g)]
    .map((match) => match[0])
    .filter((url) => url.startsWith(GUI_BASE));
  if (!urls.length) throw new Error(`no launch URL for ${GUI_BASE} in ${LOG_PATH}`);
  const url = urls[urls.length - 1];
  const token = /[?&]token=([^\s&"'<>]+)/.exec(url)[1];
  return { url, token };
}

async function authenticate(launchUrl) {
  const response = await fetch(launchUrl, { redirect: 'manual', signal: AbortSignal.timeout(15000) });
  const setCookies = response.headers.getSetCookie();
  const cookie = setCookies.map((value) => value.split(';')[0]).join('; ');
  if (!cookie) throw new Error(`launch URL did not issue a cookie (status ${response.status})`);
  return cookie;
}

/**
 * Scoped Host request issued from the GUI page itself: the browser peer is the only peer the
 * Host's owner-only admit accepts for scoped traffic. Used for evidence and cleanup, never as a
 * substitute for observing the panel's own requests.
 */
async function pageHostFetch(path, { method = 'GET', headers = {}, body } = {}) {
  const separator = path.includes('?') ? '&' : '?';
  const url = '/plugins/ui-testing' + path + separator + 'utbAcceptance=1';
  const expression = `(async () => {
    const response = await fetch(${JSON.stringify(url)}, {
      method: ${JSON.stringify(method)},
      headers: ${JSON.stringify({ 'X-UTB-Acceptance': 'script', ...headers })},
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

function scopeHeadersForSession(sessionId) {
  return {
    'X-UI-Testing-Scope-Version': '1',
    'X-UI-Testing-Session-Id': sessionId,
  };
}

async function hostStateForSession(sessionId) {
  const response = await pageHostFetch('/state', { headers: scopeHeadersForSession(sessionId) });
  if (response.status !== 200 || !response.json || response.json.ok === false) {
    throw new Error(`GET /state (session ${sessionId}) -> ${response.status}: ${sanitize(response.text)}`);
  }
  return response.json;
}

/* ------------------------------------------------------------------------------------------------
 * GUI helpers.
 * ---------------------------------------------------------------------------------------------- */
async function waitGuiReady(timeoutMs = 30000) {
  return waitFor(async () => {
    let info;
    try {
      info = await pageEvaluate(`({
        ready: document.readyState,
        boot: !!window.__DSH_BOOT__,
        origin: location.origin,
        shell: !!document.querySelector('button[aria-label="更多"]:not(.utb-btn), .utb'),
        root: !!(document.querySelector('#root') && document.querySelector('#root').children.length),
      })`);
    } catch { return undefined; }
    return info && info.ready === 'complete' && info.boot && (info.shell || info.root) ? info : undefined;
  }, { timeoutMs, intervalMs: 100, label: 'GUI ready' });
}

async function dismissShellDialogs() {
  const result = await pageEvaluate(`(() => {
    const visible = (el) => !!(el.offsetWidth || el.offsetHeight || el.getClientRects().length);
    const dialogs = [...document.querySelectorAll('[role="dialog"], [aria-modal="true"], dialog')]
      .filter((el) => visible(el) && !el.closest('.utb'));
    let closed = 0;
    for (const dialog of dialogs) {
      const close = dialog.querySelector('button[aria-label="关闭"], button[aria-label="Close"], button[aria-label="close"]');
      if (close) { close.click(); closed += 1; continue; }
      const cancel = [...dialog.querySelectorAll('button')].find((button) => /取消|关闭|Cancel|Close/.test(button.textContent || ''));
      if (cancel) { cancel.click(); closed += 1; }
    }
    return { dialogs: dialogs.length, closed };
  })()`);
  if (result && result.closed > 0) await sleep(150);
  return result;
}

async function sidebarMoreClick() {
  return pageEvaluate(`(() => {
    const more = [...document.querySelectorAll('button[aria-label="更多"]')].find((el) => !el.closest('.utb'));
    if (more && more.offsetParent !== null) { more.click(); return { clicked: 'more' }; }
    const expand = document.querySelector('button[aria-label="打开侧边栏"]');
    if (expand) { expand.click(); return { clicked: 'expand' }; }
    return { clicked: null };
  })()`);
}

/** Panel selectors are split by seat: the right sidebar tab lives under [data-sidebar-right-tab]. */
function panelExpr(kind, inner) {
  const find = kind === 'sidebar'
    ? "panels.find((panel) => panel.closest('[data-sidebar-right-tab]'))"
    : "panels.find((panel) => !panel.closest('[data-sidebar-right-tab]'))";
  return `(() => { const panels = [...document.querySelectorAll('.utb')]; const el = ${find}; if (!el) return null; ${inner} })()`;
}

async function waitPanel(kind, timeoutMs = 10000) {
  return waitFor(async () => {
    const present = await pageEvaluate(panelExpr(kind, 'return true;'));
    return present ? true : undefined;
  }, { timeoutMs, intervalMs: 100, label: `${kind} debug panel` });
}

async function openMainPanel() {
  await dismissShellDialogs();
  let clicked;
  try {
    clicked = await waitFor(async () => {
      const now = await sidebarMoreClick();
      return now && now.clicked ? now : undefined;
    }, { timeoutMs: 10000, intervalMs: 150, label: 'sidebar 更多 button' });
  } catch (error) {
    throw new Error('cannot find the sidebar 更多 button: ' + sanitize(fmt(await guiDiag())));
  }
  if (clicked.clicked === 'expand') await sleep(300);
  let row;
  try {
    row = await waitFor(async () => {
      const found = await pageEvaluate(`(() => {
        const direct = [...document.querySelectorAll('.utb-menu-row')].find((el) => el.textContent.includes('调试视图'));
        const fallback = direct || [...document.querySelectorAll('button, a, [role="menuitem"]')].find((el) => (el.textContent || '').trim() === '调试视图');
        if (!fallback) return { found: false };
        fallback.click();
        return { found: true };
      })()`);
      return found && found.found ? found : undefined;
    }, { timeoutMs: BOUNDED_WAIT_MS, intervalMs: 150, label: '调试视图 menu row' });
  } catch (error) {
    await sidebarMoreClick();
    await sleep(250);
    row = await pageEvaluate(`(() => {
      const el = [...document.querySelectorAll('.utb-menu-row')].find((node) => node.textContent.includes('调试视图'))
        || [...document.querySelectorAll('button, a, [role="menuitem"]')].find((node) => (node.textContent || '').trim() === '调试视图');
      if (!el) return { found: false };
      el.click();
      return { found: true };
    })()`);
    if (!row || !row.found) throw new Error('调试视图 menu row not found: ' + sanitize(fmt(await guiDiag())));
  }
  await waitPanel('main', 8000);
  await dismissShellDialogs();
  return true;
}

async function openRightSidebarTab() {
  await dismissShellDialogs();
  const already = await pageEvaluate(panelExpr('sidebar', 'return true;'));
  if (already) return true;
  const expanded = await pageEvaluate(`(() => {
    const toggle = document.querySelector('[data-sidebar-right-toggle]');
    if (toggle) return true;
    const expand = document.querySelector('[data-sidebar-right-expand]');
    if (expand) { expand.click(); return false; }
    return false;
  })()`);
  if (!expanded) await sleep(500);
  // A freshly opened right sidebar can be empty (no tab yet): the dock's New Tab control
  // opens the guide tab, whose entries are the doors to each tab type.
  const hasGuide = await pageEvaluate(`!!document.querySelector('[data-sidebar-right-guide]')`);
  if (!hasGuide) {
    await pageEvaluate(`(() => {
      const button = [...document.querySelectorAll('button[aria-label="新标签页"]')]
        .find((el) => el.closest('[data-sidebar-right-session]'));
      if (button) { button.click(); return true; }
      return false;
    })()`);
    await sleep(500);
  }
  let entry;
  try {
    entry = await waitFor(async () => {
      const clicked = await pageEvaluate(`(() => {
        const el = document.querySelector('[data-sidebar-right-guide-entry="debug-view"]');
        if (!el) return false;
        el.click();
        return true;
      })()`);
      return clicked ? true : undefined;
    }, { timeoutMs: 10000, intervalMs: 150, label: 'debug-view guide entry' });
  } catch (error) {
    const diagnostics = await pageEvaluate(`(() => {
      const panel = document.querySelector('[data-sidebar-right-session]');
      return {
        guide: !!document.querySelector('[data-sidebar-right-guide]'),
        entries: [...document.querySelectorAll('[data-sidebar-right-guide-entry]')].map((el) => el.getAttribute('data-sidebar-right-guide-entry')),
        tabs: [...document.querySelectorAll('[data-dockkit-tab]')].map((el) => ({ text: (el.textContent || '').trim().slice(0, 40), selected: el.getAttribute('aria-selected') })),
        buttons: [...document.querySelectorAll('button[aria-label]')].map((el) => el.getAttribute('aria-label')).slice(0, 80),
        panelText: panel ? (panel.innerText || '').slice(0, 700) : null,
      };
    })()`);
    throw new Error('cannot find the debug-view guide entry: ' + sanitize(fmt(diagnostics)));
  }
  await waitPanel('sidebar', 8000);
  await dismissShellDialogs();
  return entry;
}

async function collapseRightSidebar() {
  const clicked = await pageEvaluate(`(() => {
    const toggle = document.querySelector('[data-sidebar-right-toggle]');
    if (!toggle) return false;
    toggle.click();
    return true;
  })()`);
  if (!clicked) throw new Error('right sidebar toggle not found');
  await waitFor(async () => {
    const collapsed = await pageEvaluate(`!!document.querySelector('[data-sidebar-right-expand]')`);
    return collapsed ? true : undefined;
  }, { timeoutMs: 5000, intervalMs: 100, label: 'right sidebar collapsed' });
  return true;
}

async function expandRightSidebar() {
  const clicked = await pageEvaluate(`(() => {
    const expand = document.querySelector('[data-sidebar-right-expand]');
    if (!expand) return false;
    expand.click();
    return true;
  })()`);
  if (!clicked) throw new Error('right sidebar expand button not found');
  await sleep(400);
  return true;
}

async function guiDiag() {
  try {
    return await pageEvaluate(`(() => ({
      url: location.href,
      ready: document.readyState,
      utb: document.querySelectorAll('.utb').length,
      mainUtb: [...document.querySelectorAll('.utb')].filter((el) => !el.closest('[data-sidebar-right-tab]')).length,
      sidebarUtb: [...document.querySelectorAll('.utb')].filter((el) => el.closest('[data-sidebar-right-tab]')).length,
      workspaces: [...document.querySelectorAll('[data-row-key^="workspace:"]')].map((el) => el.getAttribute('data-row-key')),
      sessions: [...document.querySelectorAll('[data-row-key^="session:"]')].map((el) => el.getAttribute('data-row-key')).slice(0, 20),
      dialogs: document.querySelectorAll('[role="dialog"]').length,
      bodyText: (document.body ? document.body.innerText : '').slice(0, 300),
    }))()`);
  } catch (error) {
    return { error: sanitize(errorMessage(error)) };
  }
}

async function panelSnapshot(kind) {
  return pageEvaluate(panelExpr(kind, `
    const addr = el.querySelector('.utb-addr');
    return {
      addr: addr ? addr.value : null,
      focused: addr ? document.activeElement === addr : false,
      visible: !!(el.offsetWidth || el.offsetHeight || el.getClientRects().length),
      empty: !!el.querySelector('.utb-empty'),
      alert: (() => { const node = el.querySelector('[role="alert"]'); return node ? node.textContent : null; })(),
    };
  `));
}

async function focusPanelInput(kind) {
  const ok = await pageEvaluate(panelExpr(kind, `
    const input = el.querySelector('.utb-addr');
    if (!input) return false;
    if (document.activeElement === input) input.blur();
    input.focus();
    input.select();
    return document.activeElement === input;
  `));
  if (!ok) throw new Error(`cannot focus ${kind} .utb-addr`);
  return ok;
}

async function dispatchKey(key, { code, virtualKeyCode, modifiers = 0, text } = {}) {
  const base = { key, code, windowsVirtualKeyCode: virtualKeyCode, nativeVirtualKeyCode: virtualKeyCode, modifiers };
  await state.chrome.cdp.send('Input.dispatchKeyEvent', { type: 'rawKeyDown', ...base });
  if (text) await state.chrome.cdp.send('Input.dispatchKeyEvent', { type: 'char', ...base, text, unmodifiedText: text });
  await state.chrome.cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', ...base });
}

async function pressEnter() {
  await dispatchKey('Enter', { code: 'Enter', virtualKeyCode: 13, text: '\r' });
}

async function installSubmitProbe() {
  await pageEvaluate(`(() => {
    if (window.__utbSubmitListener) return true;
    window.__utbSubmitListener = true;
    window.__utbSubmitSeen = 0;
    document.addEventListener('submit', () => { window.__utbSubmitSeen += 1; }, true);
    return true;
  })()`);
}

/** Type and submit through the real address form of one panel seat. */
async function submitPanelAddress(kind, text) {
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    await dismissShellDialogs();
    await focusPanelInput(kind);
    await state.chrome.cdp.send('Input.insertText', { text });
    let synced = false;
    try {
      await waitFor(async () => {
        const snap = await panelSnapshot(kind);
        return snap && snap.addr === text && snap.focused ? true : undefined;
      }, { timeoutMs: 1200, intervalMs: 50, label: `${kind} controlled address value` });
      synced = true;
    } catch { /* fall through to the native setter */ }
    if (!synced) {
      await pageEvaluate(panelExpr(kind, `
        const input = el.querySelector('.utb-addr');
        const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
        setter.call(input, ${JSON.stringify(text)});
        input.dispatchEvent(new Event('input', { bubbles: true }));
        input.focus();
        return input.value;
      `));
      state.usedNativeValueSetter += 1;
      await sleep(100);
    }
    const stable = await panelSnapshot(kind);
    if (!stable || stable.addr !== text || !stable.focused) {
      await sleep(250);
      continue;
    }
    const before = await pageEvaluate(`window.__utbSubmitSeen || 0`);
    await pressEnter();
    try {
      await waitFor(async () => (await pageEvaluate(`window.__utbSubmitSeen || 0`)) > before, {
        timeoutMs: 1500, intervalMs: 50, label: `${kind} form submit event`,
      });
      return;
    } catch {
      // The Enter may have been swallowed by a shell focus steal; submit the same form directly.
      await dismissShellDialogs();
      const submitted = await pageEvaluate(panelExpr(kind, `
        const input = el.querySelector('.utb-addr');
        if (!input || !input.form) return false;
        input.form.requestSubmit();
        return true;
      `));
      if (submitted) {
        state.enterFallback += 1;
        return;
      }
    }
  }
  throw new Error(`cannot type/submit a stable address into the ${kind} panel: ${sanitize(fmt(await panelSnapshot(kind)))}`);
}

async function waitPanelAddress(kind, text, timeoutMs = 15000) {
  return waitFor(async () => {
    const snap = await panelSnapshot(kind);
    return snap && snap.addr === text ? snap : undefined;
  }, { timeoutMs, intervalMs: 100, label: `${kind} address ${text}` });
}

/* ------------------------------------------------------------------------------------------------
 * Workspace / session GUI driving (real Workspace Controller + Session Controller paths).
 * ---------------------------------------------------------------------------------------------- */
async function ensureSidebarExpanded() {
  const present = await pageEvaluate(`!!document.querySelector('[data-row-key^="workspace:"]')`);
  if (present) return true;
  await pageEvaluate(`(() => {
    const expand = document.querySelector('button[aria-label="打开侧边栏"]');
    if (expand) { expand.click(); return true; }
    return false;
  })()`);
  await sleep(450);
  await waitFor(() => pageEvaluate(`!!document.querySelector('[data-row-key^="workspace:"]')`), { timeoutMs: 8000, intervalMs: 150, label: 'left sidebar workspace rows' });
  return true;
}

async function workspaceRows() {
  await ensureSidebarExpanded();
  return pageEvaluate(`(() => [...document.querySelectorAll('[data-row-key^="workspace:"]')].map((el) => ({
    id: el.getAttribute('data-row-key').slice('workspace:'.length),
    label: (el.textContent || '').trim().slice(0, 100),
    expanded: el.getAttribute('aria-expanded'),
  })))()`);
}

async function findWorkspaceRow(label) {
  const rows = await workspaceRows();
  return rows.find((row) => row.label.includes(label));
}

async function activeSessionId() {
  return pageEvaluate(`(() => {
    const row = [...document.querySelectorAll('[data-row-key^="session:"]')].find((el) => el.getAttribute('aria-selected') === 'true');
    return row ? row.getAttribute('data-row-key').slice('session:'.length) : '';
  })()`);
}

async function ensureWorkspaceExpanded(workspaceId) {
  const expanded = await pageEvaluate(`(() => {
    const row = document.querySelector('[data-row-key="workspace:${workspaceId}"]');
    return row ? row.getAttribute('aria-expanded') : null;
  })()`);
  if (expanded === 'false') {
    await pageEvaluate(`(() => { const row = document.querySelector('[data-row-key="workspace:${workspaceId}"]'); if (row) row.click(); return true; })()`);
    await sleep(350);
  }
}

function pickerDialogExpr(inner) {
  return `(() => {
    const dialog = [...document.querySelectorAll('[role="dialog"]')].find((candidate) => {
      if (!candidate) return false;
      if (candidate.querySelector('input[aria-label="编辑路径"], button[aria-label="编辑路径"]')) return true;
      return (candidate.innerText || '').includes('选择工作区目录');
    });
    if (!dialog) return null;
    ${inner}
  })()`;
}

async function createWorkspaceViaPicker(path, label) {
  await mkdir(path, { recursive: true });
  let opened = false;
  for (let attempt = 1; attempt <= 3 && !opened; attempt += 1) {
    await dismissShellDialogs();
    const clicked = await pageEvaluate(`(() => {
      const button = document.querySelector('button[aria-label="添加工作区"]');
      if (!button) return false;
      button.click();
      return true;
    })()`);
    if (!clicked) throw new Error('workspace add button not found');
    try {
      await waitFor(() => pageEvaluate(pickerDialogExpr('return true;')), { timeoutMs: 2500, intervalMs: 100, label: 'directory picker dialog' });
      opened = true;
    } catch {
      // A late shell sign-in/onboarding modal can steal the first click; close it and retry.
      // A host whose directory picker resolves to the native (zenity) backend has no DOM dialog
      // at all: do not click again (that would stack native dialogs), fail with guidance below.
      const dismissed = await dismissShellDialogs();
      if (!dismissed || dismissed.closed === 0) break;
      await sleep(250);
    }
  }
  if (!opened) {
    const diagnostics = await pageEvaluate(`(() => ({
      dialogs: [...document.querySelectorAll('[role="dialog"], dialog, [aria-modal="true"]')].map((el) => ({ tag: el.tagName, cls: String(el.className).slice(0, 120), text: (el.innerText || '').slice(0, 400) })),
      modalish: [...document.querySelectorAll('[class*="dialog"], [class*="Dialog"], [class*="modal"], [class*="Modal"]')].slice(0, 20).map((el) => ({ tag: el.tagName, cls: String(el.className).slice(0, 120), text: (el.innerText || '').slice(0, 200) })),
      buttons: [...document.querySelectorAll('button[aria-label]')].map((el) => el.getAttribute('aria-label')).slice(0, 80),
      body: (document.body ? document.body.innerText : '').slice(0, 1000),
      workspaces: [...document.querySelectorAll('[data-row-key^="workspace:"]')].map((el) => el.getAttribute('data-row-key')),
    }))()`);
    let screenshotPath = '';
    try {
      const shot = await state.chrome.cdp.send('Page.captureScreenshot', { format: 'png' });
      screenshotPath = join(RUN_DIR, 'picker-failure.png');
      await writeFile(screenshotPath, Buffer.from(shot.data, 'base64'));
    } catch { /* ignore */ }
    throw new Error('directory picker did not open a DOM dialog. If this host resolves the directory picker to the native (zenity) backend, pre-register /tmp/dsh-utb-ws-a and /tmp/dsh-utb-ws-b or restart 3081 with DISPLAY unset (browse backend). diagnostics=' + sanitize(fmt(diagnostics)) + ' screenshot=' + screenshotPath);
  }
  await waitFor(async () => {
    const ready = await pageEvaluate(pickerDialogExpr(`
      const input = dialog.querySelector('input[aria-label="编辑路径"]');
      if (input) return true;
      const edit = dialog.querySelector('button[aria-label="编辑路径"]');
      if (edit) { edit.click(); return true; }
      return false;
    `));
    return ready ? true : undefined;
  }, { timeoutMs: 10000, intervalMs: 150, label: 'directory path editor' });
  await waitFor(() => pageEvaluate(pickerDialogExpr('return !!dialog.querySelector(\'input[aria-label="编辑路径"]\');')), { timeoutMs: 5000, intervalMs: 100, label: 'directory path input' });
  await pageEvaluate(pickerDialogExpr(`
    const input = dialog.querySelector('input[aria-label="编辑路径"]');
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
    setter.call(input, ${JSON.stringify(path)});
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.focus();
    return input.value;
  `));
  await waitFor(() => pageEvaluate(pickerDialogExpr(`
    const input = dialog.querySelector('input[aria-label="编辑路径"]');
    return input ? input.value === ${JSON.stringify(path)} : false;
  `)), { timeoutMs: 3000, intervalMs: 50, label: 'directory path draft value' });
  await pressEnter();
  try {
    await waitFor(async () => {
      const navigated = await pageEvaluate(pickerDialogExpr(`
        if (dialog.querySelector('input[aria-label="编辑路径"]')) return false;
        return (dialog.innerText || '').includes(${JSON.stringify(label)});
      `));
      return navigated ? true : undefined;
    }, { timeoutMs: 20000, intervalMs: 150, label: 'directory picker navigated to workspace path' });
  } catch (error) {
    const stateNow = await pageEvaluate(pickerDialogExpr(`
      const input = dialog.querySelector('input[aria-label="编辑路径"]');
      return {
        inputValue: input ? input.value : null,
        text: (dialog.innerText || '').slice(0, 700),
        buttons: [...dialog.querySelectorAll('button')].map((button) => ({ text: (button.textContent || '').trim().slice(0, 40), disabled: !!button.disabled })).slice(0, 30),
      };
    `));
    throw new Error('directory picker did not navigate to ' + path + ': ' + sanitize(fmt(stateNow)));
  }
  await waitFor(async () => {
    const enabled = await pageEvaluate(pickerDialogExpr(`
      const open = [...dialog.querySelectorAll('button')].find((button) => (button.textContent || '').trim() === '打开');
      return !!open && !open.disabled;
    `));
    return enabled ? true : undefined;
  }, { timeoutMs: 10000, intervalMs: 100, label: 'directory picker open button' });
  await pageEvaluate(pickerDialogExpr(`
    const open = [...dialog.querySelectorAll('button')].find((button) => (button.textContent || '').trim() === '打开');
    if (!open) return false;
    open.click();
    return true;
  `));
  await waitFor(async () => (await findWorkspaceRow(label)), { timeoutMs: 25000, intervalMs: 150, label: `workspace row ${label}` });
  return (await findWorkspaceRow(label)).id;
}

async function newSessionInWorkspace(workspaceId) {
  await dismissShellDialogs();
  await ensureWorkspaceExpanded(workspaceId);
  const before = await activeSessionId();
  const clicked = await pageEvaluate(`(() => {
    const row = document.querySelector('[data-row-key="workspace:${workspaceId}"]');
    if (!row) return false;
    const button = [...row.querySelectorAll('button[aria-label]')].find((node) => (node.getAttribute('aria-label') || '').includes('新建会话'));
    if (!button) return false;
    button.click();
    return true;
  })()`);
  if (!clicked) throw new Error(`new-session button not found for workspace ${workspaceId}`);
  let sessionId;
  try {
    sessionId = await waitFor(async () => {
      const current = await activeSessionId();
      if (!current) return undefined;
      if (current !== before) return current;
      // startSession reuses the current blank Session when it already belongs to this workspace;
      // verify the owning workspace through the real scoped Host state instead of requiring a new id.
      try {
        const info = await hostStateForSession(current);
        const owner = info.scope && info.scope.workspaceId ? info.scope.workspaceId : null;
        return owner === workspaceId ? current : undefined;
      } catch { return undefined; }
    }, { timeoutMs: 20000, intervalMs: 250, label: 'new active session' });
  } catch (error) {
    const diagnostics = {
      before,
      active: await activeSessionId(),
      workspaces: await workspaceRows(),
      rows: await pageEvaluate(`(() => [...document.querySelectorAll('[data-row-key]')].map((el) => ({ key: el.getAttribute('data-row-key'), expanded: el.getAttribute('aria-expanded'), selected: el.getAttribute('aria-selected'), text: (el.textContent || '').trim().slice(0, 60) })).slice(0, 100))()`),
      body: await pageEvaluate(`(document.body ? document.body.innerText : '').slice(0, 900)`),
    };
    throw new Error('new session did not become active: ' + sanitize(fmt(diagnostics)));
  }
  await sleep(500);
  return sessionId;
}

async function prepareWorkspace(path, label) {
  let row = await findWorkspaceRow(label);
  if (!row) {
    const before = await activeSessionId();
    const workspaceId = await createWorkspaceViaPicker(path, label);
    const sessionId = await waitFor(async () => {
      const current = await activeSessionId();
      return current && current !== before ? current : undefined;
    }, { timeoutMs: 25000, intervalMs: 150, label: 'session auto-started after workspace create' });
    await sleep(500);
    return { workspaceId, sessionId, created: true };
  }
  const sessionId = await newSessionInWorkspace(row.id);
  return { workspaceId: row.id, sessionId, created: false };
}


/* ------------------------------------------------------------------------------------------------
 * Network / WS evidence.
 * ---------------------------------------------------------------------------------------------- */
function header(headers, name) {
  if (!headers) return undefined;
  const lower = name.toLowerCase();
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() === lower) return Array.isArray(value) ? value[0] : String(value);
  }
  return undefined;
}

function hookNetworkEvents() {
  state.chrome.cdp.on((message) => {
    if (message.method === 'Network.requestWillBeSent') {
      const request = message.params.request || {};
      state.requests.push({
        id: message.params.requestId,
        url: request.url,
        method: request.method,
        headers: { ...(request.headers || {}) },
        at: Date.now(),
      });
      return;
    }
    if (message.method === 'Network.requestWillBeSentExtraInfo') {
      const entry = state.requests.find((candidate) => candidate.id === message.params.requestId);
      if (entry) entry.headers = { ...entry.headers, ...(message.params.headers || {}) };
      return;
    }
    if (message.method === 'Network.webSocketCreated') {
      state.wsEvents.push({ type: 'created', requestId: message.params.requestId, url: message.params.url, at: Date.now() });
      return;
    }
    if (message.method === 'Network.webSocketClosed') {
      state.wsEvents.push({ type: 'closed', requestId: message.params.requestId, at: Date.now() });
      return;
    }
    if (message.method === 'Network.webSocketFrameReceived') {
      state.wsFrames.push({
        requestId: message.params.requestId,
        opcode: message.params.response.opcode,
        payload: message.params.response.payloadData,
        at: Date.now(),
      });
    }
  });
}

function isAcceptanceRequest(entry) {
  return Boolean(header(entry.headers, 'x-utb-acceptance')) || entry.url.includes('utbAcceptance=1');
}

function panelRequestsSince(mark) {
  return state.requests.filter((entry) => entry.at >= mark
    && entry.url.includes('/plugins/ui-testing/')
    && !isAcceptanceRequest(entry));
}

async function waitForPanelHeaders(mark, timeoutMs = 4000) {
  return waitFor(() => {
    const entries = panelRequestsSince(mark);
    return entries.some((entry) => requestIdentity(entry).version) ? entries : undefined;
  }, { timeoutMs, intervalMs: 100, label: 'panel request headers' });
}

function requestIdentity(entry) {
  return {
    version: header(entry.headers, 'x-ui-testing-scope-version'),
    sessionId: header(entry.headers, 'x-ui-testing-session-id'),
    scope: header(entry.headers, 'x-ui-testing-scope'),
    binding: header(entry.headers, 'x-ui-testing-scope-binding'),
  };
}

function wsCreatedSince(mark) {
  return state.wsEvents.filter((event) => event.type === 'created'
    && event.at >= mark
    && event.url.includes('/plugins/ui-testing/frames'));
}

function wsClosedFor(requestId) {
  return state.wsEvents.find((event) => event.type === 'closed' && event.requestId === requestId);
}

function wsQuery(url) {
  try {
    const parsed = new URL(url);
    return {
      scopeVersion: parsed.searchParams.get('scopeVersion'),
      sessionId: parsed.searchParams.get('sessionId'),
      scope: parsed.searchParams.get('scope'),
      binding: parsed.searchParams.get('binding'),
    };
  } catch { return {}; }
}

function parsePushedFrame(payload) {
  try {
    const buffer = Buffer.from(payload || '', 'base64');
    if (buffer.length < 5) return null;
    const length = buffer.readUInt32BE(0);
    if (!length || length > buffer.length - 4) return null;
    return JSON.parse(buffer.subarray(4, 4 + length).toString('utf8'));
  } catch { return null; }
}

function framesOnSocket(requestId) {
  return state.wsFrames
    .filter((frame) => frame.requestId === requestId && frame.opcode === 2)
    .map((frame) => parsePushedFrame(frame.payload))
    .filter(Boolean);
}

/* ------------------------------------------------------------------------------------------------
 * Assertions.
 * ---------------------------------------------------------------------------------------------- */
function summarizeRequests(entries) {
  return entries.map((entry) => ({
    path: entry.url.replace(/^https?:\/\/[^/]+/, ''),
    method: entry.method,
    identity: requestIdentity(entry),
  }));
}

function assertPanelRequests(scenarioName, label, entries, expected, { requireAny = true } = {}) {
  const relevant = entries.filter((entry) => entry.url.includes('/plugins/ui-testing/'));
  const bad = [];
  for (const entry of relevant) {
    const identity = requestIdentity(entry);
    if (identity.version !== '1') { bad.push({ why: 'missing/incorrect scope version', ...summarizeRequests([entry])[0] }); continue; }
    if (expected.kind === 'session') {
      if (identity.sessionId !== expected.sessionId) bad.push({ why: 'wrong session id', ...summarizeRequests([entry])[0] });
      if (identity.scope || identity.binding) bad.push({ why: 'session request also sent scope/binding', ...summarizeRequests([entry])[0] });
    } else if (expected.kind === 'binding') {
      if (identity.binding !== expected.binding) bad.push({ why: 'wrong binding', ...summarizeRequests([entry])[0] });
      if (identity.sessionId || identity.scope) bad.push({ why: 'binding request also sent another identity', ...summarizeRequests([entry])[0] });
    }
  }
  check(scenarioName, `${label}: ${relevant.length} scoped request(s) carry the expected identity`, relevant.length > 0 || !requireAny ? bad.length === 0 : false,
    expected.kind === 'session'
      ? { version: '1', sessionId: expected.sessionId, scope: null, binding: null }
      : { version: '1', binding: expected.binding, sessionId: null, scope: null },
    { count: relevant.length, bad: bad.slice(0, 6), sample: summarizeRequests(relevant).slice(-6) });
  return { relevant, bad };
}

function assertPanelSocket(scenarioName, label, sockets, expected) {
  const matching = sockets.filter((socket) => {
    const query = wsQuery(socket.url);
    if (query.scopeVersion !== '1') return false;
    if (expected.kind === 'session') return query.sessionId === expected.sessionId && !query.scope && !query.binding;
    return query.binding === expected.binding && !query.sessionId && !query.scope;
  });
  const wrong = sockets.filter((socket) => {
    const query = wsQuery(socket.url);
    if (expected.kind === 'session') return query.sessionId !== expected.sessionId || query.scope || query.binding;
    return query.binding !== expected.binding || query.sessionId || query.scope;
  });
  check(scenarioName, `${label}: WS URL carries only ${expected.kind === 'session' ? 'sessionId' : 'binding'} ${expected.kind === 'session' ? expected.sessionId : expected.binding}`,
    sockets.length > 0 && matching.length > 0 && wrong.length === 0,
    expected.kind === 'session'
      ? { scopeVersion: '1', sessionId: expected.sessionId, scope: null, binding: null }
      : { scopeVersion: '1', binding: expected.binding, sessionId: null, scope: null },
    { wrong: wrong.map((socket) => ({ url: socket.url.replace(/^ws:\/\/[^/]+/, 'ws://[host]'), query: wsQuery(socket.url) })), sockets: sockets.map((socket) => wsQuery(socket.url)) });
  return matching;
}

function assertFrames(scenarioName, label, sockets, expectedScope, expectedRuntime, foreignScope) {
  const frames = sockets.flatMap((socket) => framesOnSocket(socket.requestId));
  const wrongScope = frames.filter((frame) => expectedScope && frame.scopeId !== expectedScope);
  const foreign = foreignScope ? frames.filter((frame) => frame.scopeId === foreignScope) : [];
  const wrongRuntime = expectedRuntime ? frames.filter((frame) => frame.runtimeId !== expectedRuntime) : [];
  check(scenarioName, `${label}: ${frames.length} frame(s) carry scopeId ${expectedScope || '(any)'} / runtimeId ${expectedRuntime || '(any)'}`,
    frames.length > 0 && wrongScope.length === 0 && foreign.length === 0 && wrongRuntime.length === 0,
    { scopeId: expectedScope, runtimeId: expectedRuntime, foreignScope: foreignScope || null },
    {
      frames: frames.length,
      wrongScope: wrongScope.slice(0, 3).map((frame) => frame.scopeId),
      foreign: foreign.slice(0, 3).map((frame) => frame.scopeId),
      wrongRuntime: wrongRuntime.slice(0, 3).map((frame) => frame.runtimeId),
      scopeIds: [...new Set(frames.map((frame) => frame.scopeId))].slice(0, 4),
      runtimeIds: [...new Set(frames.map((frame) => frame.runtimeId))].slice(0, 4),
    });
  return frames;
}

async function sessionScopeInfo(sessionId) {
  if (!state.scopes[sessionId]) {
    const hostState = await hostStateForSession(sessionId);
    state.scopes[sessionId] = {
      scopeId: hostState.scope && hostState.scope.id ? hostState.scope.id : (hostState.ui && hostState.ui.scope ? hostState.ui.scope.id : null),
      runtimeId: hostState.ui && hostState.ui.runtimeId ? hostState.ui.runtimeId : null,
      workspaceId: hostState.scope && hostState.scope.workspaceId ? hostState.scope.workspaceId : null,
      kind: hostState.scope && hostState.scope.kind ? hostState.scope.kind : null,
    };
  }
  return state.scopes[sessionId];
}

async function sessionAddress(sessionId) {
  const hostState = await hostStateForSession(sessionId);
  return {
    address: hostState.ui && typeof hostState.ui.address === 'string' ? hostState.ui.address : null,
    runtimeId: hostState.ui ? hostState.ui.runtimeId : null,
    scopeId: hostState.scope ? hostState.scope.id : null,
    running: hostState.running === true,
  };
}

/* ------------------------------------------------------------------------------------------------
 * Build / environment facts.
 * ---------------------------------------------------------------------------------------------- */
/** Prove the GUI loaded the workspace client bundle, not a stale pre-restart copy. */
async function servedClientEvidence() {
  const result = await pageEvaluate(`(async () => {
    const boot = window.__DSH_BOOT__;
    const entry = boot && Array.isArray(boot.entries)
      ? boot.entries.find((candidate) => candidate.id === 'dsh-agent-team-ui-testing')
      : undefined;
    if (!entry || !entry.url) return null;
    const response = await fetch(entry.url, { credentials: 'same-origin', cache: 'no-store' });
    const text = await response.text();
    return { rev: entry.rev || '', url: entry.url, text };
  })()`);
  if (!result) return null;
  const digest = createHash('sha256').update(result.text).digest('hex');
  return {
    rev: result.rev,
    url: String(result.url).replace(/^[^?]*\?\?/, 'plugins/??'),
    bytes: Buffer.byteLength(result.text, 'utf8'),
    sha256: digest.slice(0, 24),
    hasScopeBinding: result.text.includes('X-UI-Testing-Scope-Binding'),
    hasScopeEpoch: result.text.includes('scopeEpoch'),
  };
}

function buildProbe() {
  const info = {};
  const port = guiUrl.port || '80';
  try {
    // `ss -p` may be hidden in a sandbox/namespace; fall back to pgrep for the node listener.
    let pid = null;
    try {
      const output = execFileSync('ss', ['-ltnp', 'sport = :' + port], { encoding: 'utf8', timeout: 3000 });
      const match = /pid=(\d+)/.exec(output);
      if (match) pid = Number(match[1]);
    } catch { /* ignore */ }
    if (!pid) {
      try {
        const lines = execFileSync('pgrep', ['-af', 'dsh web --port ' + port], { encoding: 'utf8', timeout: 3000 })
          .split('\n')
          .filter(Boolean);
        const line = lines.find((candidate) => /\bnode\b/.test(candidate) && !/bash -c/.test(candidate))
          || lines.find((candidate) => !/bash -c/.test(candidate));
        if (line) pid = Number(line.trim().split(/\s+/)[0]) || null;
      } catch { /* ignore */ }
    }
    info.serverPid = pid;
    if (pid) {
      let ppid = null;
      try {
        const cmdline = readFileSync('/proc/' + pid + '/cmdline', 'utf8').split('\0').join(' ');
        info.serverCommand = cmdline.replace(/token=\S+/g, 'token=[REDACTED]').slice(0, 200);
      } catch { /* ignore */ }
      try {
        const statText = readFileSync('/proc/' + pid + '/stat', 'utf8');
        const fields = statText.slice(statText.lastIndexOf(')') + 2).split(' ');
        ppid = Number(fields[1]);
        const startTicks = Number(fields[19]);
        const procStat = readFileSync('/proc/stat', 'utf8');
        const btimeLine = procStat.split('\n').find((line) => line.startsWith('btime '));
        const btimeSeconds = btimeLine ? Number(btimeLine.split(/\s+/)[1]) : 0;
        if (Number.isFinite(startTicks) && btimeSeconds > 0) {
          info.startedAt = new Date((btimeSeconds + startTicks / 100) * 1000).toISOString();
        }
      } catch { /* ignore */ }
      // The process env is often unreadable; the launcher's command line carries DSH_HOME.
      try {
        const environ = readFileSync('/proc/' + pid + '/environ', 'utf8').split('\0').join('\n');
        const homeLine = environ.split('\n').find((line) => line.startsWith('DSH_HOME='));
        if (homeLine) { info.dshHome = homeLine.slice('DSH_HOME='.length); info.homeSource = 'listener environ'; }
      } catch { /* ignore */ }
      if (!info.dshHome && ppid) {
        try {
          const parentCmd = readFileSync('/proc/' + ppid + '/cmdline', 'utf8').split('\0').join(' ');
          const home = /(?:^|\s)DSH_HOME=([^\s]+)/.exec(parentCmd);
          if (home) { info.dshHome = home[1]; info.homeSource = 'launcher cmdline'; }
        } catch { /* ignore */ }
      }
      if (!info.homeSource) info.homeSource = null;
    }
  } catch { info.serverPid = null; }
  return info;
}

async function fileDigest(path) {
  try {
    const [buffer, metadata] = await Promise.all([readFile(path), stat(path)]);
    return { sha256: createHash('sha256').update(buffer).digest('hex').slice(0, 24), bytes: buffer.length, mtime: metadata.mtime.toISOString() };
  } catch { return null; }
}

async function buildState() {
  const indexJs = await fileDigest(join(REPO_ROOT, 'index.js'));
  const clientJs = await fileDigest(join(REPO_ROOT, 'client.js'));
  const startedAtMs = state.hostInfo && state.hostInfo.startedAt ? Date.parse(state.hostInfo.startedAt) : 0;
  const editedAfterStart = {};
  if (startedAtMs) {
    for (const [name, digest] of [['index.js', indexJs], ['client.js', clientJs]]) {
      if (digest && Date.parse(digest.mtime) > startedAtMs) editedAfterStart[name] = true;
    }
  }
  const clientChangedAfterStart = Boolean(editedAfterStart['client.js']);
  return {
    indexJs,
    clientJs,
    hostIndexLoadedAtStart: startedAtMs ? !editedAfterStart['index.js'] : null,
    clientChangedAfterStart: startedAtMs ? clientChangedAfterStart : null,
    loadedBuildMatchesWorkspace: startedAtMs ? Object.keys(editedAfterStart).length === 0 : null,
    loadedBuildNote: !startedAtMs
      ? 'Listener start time could not be read; loadedBuildMatchesWorkspace is NOT VERIFIED.'
      : Object.keys(editedAfterStart).length
        ? 'WARNING: workspace source changed after the 3081 listener started. Host index.js is the restart build; the client bundle is served per page load and is verified separately by servedClient (rev + scope markers).'
        : 'On-disk source mtimes are older than the listener start: the running build matches the workspace files.',
    editedAfterStart,
  };
}

/* ------------------------------------------------------------------------------------------------
 * Scenarios.
 * ---------------------------------------------------------------------------------------------- */
async function main() {
  await mkdir(RUN_DIR, { recursive: true });
  await mkdir(WORKSPACE_A.path, { recursive: true });
  await mkdir(WORKSPACE_B.path, { recursive: true });
  if (!existsSync(CHROME_BIN)) throw new Error(`Chromium wrapper/binary not found: ${CHROME_BIN}`);
  state.hostInfo = buildProbe();
  state.buildInfo = await buildState();
  log(`[env] 3081 listener pid: ${state.hostInfo.serverPid ?? 'unknown'}`);
  log(`[env] listener DSH_HOME: ${state.hostInfo.dshHome ?? 'unreadable'}; configured isolated home: ${DSH_3081_HOME}`);
  if (state.hostInfo.dshHome) {
    check('ENV', 'E1 listener DSH_HOME matches the configured isolated home', state.hostInfo.dshHome === DSH_3081_HOME,
      { dshHome: DSH_3081_HOME }, { dshHome: state.hostInfo.dshHome });
  } else {
    state.observations.dshHome = { configured: DSH_3081_HOME, listener: null, note: 'listener environ unreadable; actual home NOT VERIFIED' };
  }
  log(`[env] build fingerprint index.js=${state.buildInfo.indexJs ? state.buildInfo.indexJs.sha256 : 'n/a'} client.js=${state.buildInfo.clientJs ? state.buildInfo.clientJs.sha256 : 'n/a'}`);
  log(`[env] loadedBuildMatchesWorkspace=${state.buildInfo.loadedBuildMatchesWorkspace} editedAfterStart=${JSON.stringify(state.buildInfo.editedAfterStart)}`);

  const { startFixtureServer } = await import(pathToFileURL(join(REPO_ROOT, 'tests/ui_test_fixture/server.mjs')).href);
  state.fixture = await startFixtureServer();
  log(`[env] fixture: ${state.fixture.url}`);
  log(`[env] GUI base: ${GUI_BASE} (3081 evidence: ${guiUrl.port === '3081'})`);

  const launch = await loadToken();
  state.token = launch.token;
  state.cookie = await authenticate(launch.url);
  log('[env] launch URL exchanged for an in-memory browser-session cookie (not logged)');

  const guiResponse = await fetch(GUI_BASE + '/', { headers: { cookie: state.cookie }, signal: AbortSignal.timeout(15000) });
  const guiHtml = await guiResponse.text();
  check('GUI', 'G0 authenticated GUI serves injected shell', guiResponse.ok && guiHtml.includes('__DSH_BOOT__'), { status: 200, boot: true }, { status: guiResponse.status, boot: guiHtml.includes('__DSH_BOOT__') });

  state.chrome = await launchChrome(CHROME_BIN);
  const { cdp } = state.chrome;
  await cdp.send('Page.enable');
  await cdp.send('Runtime.enable');
  await cdp.send('Network.enable');
  hookNetworkEvents();
  log(`[env] headless chromium devtools port ${state.chrome.devtoolsPort}`);

  await cdp.send('Page.navigate', { url: launch.url });
  const boot = await waitGuiReady(30000);
  check('GUI', 'G1 GUI origin is the isolated 3081 host', boot.origin === guiUrl.origin, guiUrl.origin, boot.origin);
  const locationAfterToken = await pageEvaluate(`location.href`);
  check('GUI', 'G1 token URL exchanged away from the address (no token in location)', locationAfterToken.indexOf('token=') === -1, 'no token in location', locationAfterToken);
  await dismissShellDialogs();
  await installSubmitProbe();

  state.servedClient = await servedClientEvidence();
  const servedMatches = Boolean(state.servedClient && state.buildInfo.clientJs
    && state.servedClient.sha256 === state.buildInfo.clientJs.sha256);
  check('GUI', 'G5 GUI serves the workspace client bundle (scope binding code present)', Boolean(state.servedClient && state.servedClient.hasScopeBinding && state.servedClient.hasScopeEpoch),
    { hasScopeBinding: true, hasScopeEpoch: true }, state.servedClient && { rev: state.servedClient.rev, bytes: state.servedClient.bytes, sha256: state.servedClient.sha256, hasScopeBinding: state.servedClient.hasScopeBinding, hasScopeEpoch: state.servedClient.hasScopeEpoch });
  state.observations.servedClient = { ...state.servedClient, matchesWorkspaceClientJs: servedMatches };

  // Host preflight: a scope-aware Host must return state.scope + ui.runtimeId for a recent probe.
  const preflight = await pageHostFetch('/state', { headers: { 'X-UI-Testing-Scope-Version': '1', 'X-UI-Testing-Scope': 'recent' } });
  const preflightOk = preflight.status === 200 && preflight.json && preflight.json.scope && preflight.json.ui && preflight.json.ui.runtimeId;
  check('HOST', 'H1 scope-aware Host: GET /state (recent) returns scope + ui.runtimeId', preflightOk,
    { status: 200, scope: 'present', runtimeId: 'present' },
    { status: preflight.status, scope: preflight.json && preflight.json.scope, runtimeId: preflight.json && preflight.json.ui && preflight.json.ui.runtimeId, text: preflight.text });
  if (!preflightOk) {
    throw new Error('3081 Host does not expose workspace scope (state.scope + ui.runtimeId); restart 3081 with the new Host before running this acceptance. No isolation claim is made.');
  }
  state.observations.preflightRecent = {
    scope: preflight.json.scope,
    runtimeId: preflight.json.ui.runtimeId,
  };

  let workspaceA = null;
  let workspaceB = null;
  let sessionA = null;
  let sessionB = null;

  await scenario('A', async () => {
    workspaceA = await prepareWorkspace(WORKSPACE_A.path, WORKSPACE_A.label);
    sessionA = workspaceA.sessionId;
    state.sessions.A = sessionA;
    check('A', 'A1 workspace A is a real registered workspace (GUI row)', Boolean(workspaceA.workspaceId), { workspaceId: 'uuid' }, { workspaceId: workspaceA.workspaceId, created: workspaceA.created, sessionId: sessionA });

    await sleep(400);
    const mark = Date.now();
    await openMainPanel();
    await sleep(900);
    const snap = await panelSnapshot('main');
    check('A', 'A2 main panel opened through 更多 → 调试视图', Boolean(snap && snap.addr !== null), { addr: 'string' }, snap);

    const requests = await waitForPanelHeaders(mark);
    const identity = assertPanelRequests('A', 'A3 panel requests', requests, { kind: 'session', sessionId: sessionA });
    const sockets = wsCreatedSince(mark);
    const matching = assertPanelSocket('A', 'A4 panel WS', sockets, { kind: 'session', sessionId: sessionA });
    const scope = await sessionScopeInfo(sessionA);
    check('A', 'A5 session A resolves to a workspace scope', Boolean(scope.scopeId && scope.runtimeId), { scopeId: 'present', runtimeId: 'present' }, scope);

    const urlA = state.fixture.url + 'index.html?workspace=A';
    await submitPanelAddress('main', urlA);
    await waitPanelAddress('main', urlA, 20000);
    await waitFor(async () => {
      const info = await sessionAddress(sessionA);
      return info.address === urlA ? info : undefined;
    }, { timeoutMs: 15000, intervalMs: 150, label: 'session A address' });
    const stateA = await sessionAddress(sessionA);
    check('A', 'A6 navigating session A shows A URL in panel and Host state', stateA.address === urlA,
      { address: urlA }, { address: stateA.address, scopeId: stateA.scopeId, runtimeId: stateA.runtimeId });

    await waitFor(async () => framesOnSocket(matching[0] ? matching[0].requestId : '').length > 0, { timeoutMs: 8000, intervalMs: 150, label: 'session A frames' });
    const framesA = assertFrames('A', 'A7 session A frames', matching, scope.scopeId, scope.runtimeId, null);
    const allRequestsA = panelRequestsSince(mark);
    assertPanelRequests('A', 'A8 all panel requests incl. ensure/viewport/navigate', allRequestsA, { kind: 'session', sessionId: sessionA });
    state.observations.A = {
      workspaceId: workspaceA.workspaceId,
      workspaceCreatedThisRun: workspaceA.created,
      sessionId: sessionA,
      scope,
      url: urlA,
      requestSample: summarizeRequests(identity.relevant).slice(-8),
      ws: matching.map((socket) => ({ url: socket.url.replace(/^ws:\/\/[^/]+/, 'ws://[host]'), query: wsQuery(socket.url) })),
      frames: framesA.length,
    };
  });

  await scenario('B', async () => {
    if (!workspaceA || !sessionA) throw new Error('workspace A was not prepared; B comparison cannot run');
    workspaceB = await prepareWorkspace(WORKSPACE_B.path, WORKSPACE_B.label);
    sessionB = workspaceB.sessionId;
    state.sessions.B = sessionB;
    check('B', 'B1 workspace B is a real registered workspace (GUI row)', Boolean(workspaceB.workspaceId), { workspaceId: 'uuid' }, { workspaceId: workspaceB.workspaceId, created: workspaceB.created, sessionId: sessionB });
    check('B', 'B1b A and B are distinct workspaces/sessions', workspaceA.workspaceId !== workspaceB.workspaceId && sessionA !== sessionB,
      { workspace: 'distinct', session: 'distinct' }, { workspaceA: workspaceA.workspaceId, workspaceB: workspaceB.workspaceId, sessionA, sessionB });

    await sleep(400);
    const mark = Date.now();
    await openMainPanel();
    await sleep(900);
    const snap = await panelSnapshot('main');
    check('B', 'B2 main panel opened for workspace B', Boolean(snap && snap.addr !== null), { addr: 'string' }, snap);

    const requests = await waitForPanelHeaders(mark);
    const identity = assertPanelRequests('B', 'B3 panel requests', requests, { kind: 'session', sessionId: sessionB });
    const sockets = wsCreatedSince(mark);
    const matching = assertPanelSocket('B', 'B4 panel WS', sockets, { kind: 'session', sessionId: sessionB });
    const scope = await sessionScopeInfo(sessionB);
    const scopeAForCompare = state.observations.A && state.observations.A.scope ? state.observations.A.scope : {};
    check('B', 'B5 session B resolves to a distinct workspace scope', Boolean(scope.scopeId && scope.runtimeId && scope.scopeId !== scopeAForCompare.scopeId),
      { scopeId: 'distinct from A' }, scope);

    const urlB = state.fixture.url + 'second.html?workspace=B';
    await submitPanelAddress('main', urlB);
    await waitPanelAddress('main', urlB, 20000);
    await waitFor(async () => {
      const info = await sessionAddress(sessionB);
      return info.address === urlB ? info : undefined;
    }, { timeoutMs: 15000, intervalMs: 150, label: 'session B address' });
    const stateB = await sessionAddress(sessionB);
    const stateA = await sessionAddress(sessionA);
    check('B', 'B6 navigating B shows B URL in panel and Host state', stateB.address === urlB, { address: urlB }, stateB);
    check('B', 'B7 A page did not cross to B URL', stateA.address === state.observations.A.url, { address: state.observations.A.url }, stateA);

    await waitFor(async () => framesOnSocket(matching[0] ? matching[0].requestId : '').length > 0, { timeoutMs: 8000, intervalMs: 150, label: 'session B frames' });
    const framesB = assertFrames('B', 'B8 session B frames', matching, scope.scopeId, scope.runtimeId, scopeAForCompare.scopeId);
    const allRequestsB = panelRequestsSince(mark);
    assertPanelRequests('B', 'B9 all panel requests incl. ensure/viewport/navigate', allRequestsB, { kind: 'session', sessionId: sessionB });
    state.observations.B = {
      workspaceId: workspaceB.workspaceId,
      workspaceCreatedThisRun: workspaceB.created,
      sessionId: sessionB,
      scope,
      url: urlB,
      requestSample: summarizeRequests(identity.relevant).slice(-8),
      ws: matching.map((socket) => ({ url: socket.url.replace(/^ws:\/\/[^/]+/, 'ws://[host]'), query: wsQuery(socket.url) })),
      frames: framesB.length,
    };
  });

  await scenario('A2', async () => {
    if (!workspaceA || !workspaceB) throw new Error('A/B were not prepared; switch-back cannot run');
    // The shell hides non-current blank Sessions, so the reliable way back is the workspace's
    // own New Session action: it reuses that workspace's blank Session (same id) and switches
    // the main view back to it, which also closes the B debug panel.
    await newSessionInWorkspace(workspaceB.workspaceId);
    await waitFor(async () => {
      const main = await pageEvaluate(panelExpr('main', 'return true;'));
      return main ? undefined : true;
    }, { timeoutMs: 8000, intervalMs: 100, label: 'B main panel unmounted' });
    const reopenedA = await newSessionInWorkspace(workspaceA.workspaceId);
    check('A2', 'C0 switch back to workspace A reuses its blank Session', reopenedA === sessionA,
      { sessionId: sessionA }, { sessionId: reopenedA });
    await sleep(400);
    const mark = Date.now();
    await openMainPanel();
    await sleep(900);
    const requests = await waitForPanelHeaders(mark);
    assertPanelRequests('A2', 'C1 switch back to A: panel requests', requests, { kind: 'session', sessionId: sessionA });
    const sockets = wsCreatedSince(mark);
    const matching = assertPanelSocket('A2', 'C2 switch back to A: panel WS', sockets, { kind: 'session', sessionId: sessionA });
    const scope = await sessionScopeInfo(sessionA);
    const stateA = await sessionAddress(sessionA);
    const stateB = await sessionAddress(sessionB);
    check('A2', 'C3 switch back to A shows A address (not B)', stateA.address === state.observations.A.url,
      { address: state.observations.A.url }, stateA);
    check('A2', 'C4 B page still keeps its own address', stateB.address === state.observations.B.url,
      { address: state.observations.B.url }, stateB);
    await waitPanelAddress('main', state.observations.A.url, 15000);
    await waitFor(async () => framesOnSocket(matching[0] ? matching[0].requestId : '').length > 0, { timeoutMs: 8000, intervalMs: 150, label: 'switch-back A frames' });
    const frames = assertFrames('A2', 'C5 switch back to A frames', matching, scope.scopeId, scope.runtimeId, state.observations.B && state.observations.B.scope ? state.observations.B.scope.scopeId : null);
    const allRequestsA2 = panelRequestsSince(mark);
    assertPanelRequests('A2', 'C6 switch back to A: all panel requests', allRequestsA2, { kind: 'session', sessionId: sessionA });
    state.observations.A2 = {
      note: 'switched back through the workspace New Session action, which reuses that workspace blank Session (same id); non-current blank rows are intentionally hidden by the shell',
      sessionId: sessionA,
      address: stateA.address,
      scope,
      ws: matching.map((socket) => ({ url: socket.url.replace(/^ws:\/\/[^/]+/, 'ws://[host]'), query: wsQuery(socket.url) })),
      frames: frames.length,
    };
  });

  await scenario('S', async () => {
    if (!workspaceA || !workspaceB) throw new Error('A/B were not prepared; sidebar check cannot run');
    // Switch the main view back to workspace A through its New Session action (reuses the
    // workspace's blank Session) so only the sidebar tab remains under test.
    const reopenedSidebarA = await newSessionInWorkspace(workspaceA.workspaceId);
    check('S', 'S0 sidebar check runs in workspace A', reopenedSidebarA === sessionA,
      { sessionId: sessionA }, { sessionId: reopenedSidebarA });
    await waitFor(async () => {
      const main = await pageEvaluate(panelExpr('main', 'return true;'));
      return main ? undefined : true;
    }, { timeoutMs: 8000, intervalMs: 100, label: 'A main panel unmounted' });
    await sleep(300);
    const mark = Date.now();
    await openRightSidebarTab();
    await sleep(900);
    const sidebarSnap = await panelSnapshot('sidebar');
    check('S', 'S1 right sidebar debug tab opened in session A', Boolean(sidebarSnap && sidebarSnap.addr !== null), { addr: 'string' }, sidebarSnap);
    const requests = await waitForPanelHeaders(mark);
    assertPanelRequests('S', 'S2 sidebar requests use session A', requests, { kind: 'session', sessionId: sessionA });
    const sockets = wsCreatedSince(mark);
    const matching = assertPanelSocket('S', 'S3 sidebar WS uses session A', sockets, { kind: 'session', sessionId: sessionA });
    const scope = await sessionScopeInfo(sessionA);

    // Generate frames through the sidebar panel itself (same session runtime).
    const urlSidebarA = state.fixture.url + 'index.html?workspace=A&seat=sidebar';
    await submitPanelAddress('sidebar', urlSidebarA);
    await waitPanelAddress('sidebar', urlSidebarA, 20000);
    await waitFor(async () => framesOnSocket(matching[0] ? matching[0].requestId : '').length > 0, { timeoutMs: 8000, intervalMs: 150, label: 'sidebar frames A' });
    assertFrames('S', 'S4 sidebar frames carry scope A', matching, scope.scopeId, scope.runtimeId, state.observations.B && state.observations.B.scope ? state.observations.B.scope.scopeId : null);

    const metricsBefore = await pageHostFetch('/metrics', { headers: scopeHeadersForSession(sessionA) });
    const clientsBefore = metricsBefore.json && metricsBefore.json.host ? metricsBefore.json.host.clients : null;
    const socketId = matching[0] ? matching[0].requestId : '';
    await collapseRightSidebar();
    const collapseAt = Date.now();
    await sleep(3500);
    const closed = socketId ? wsClosedFor(socketId) : undefined;
    const afterHide = panelRequestsSince(collapseAt + 500);
    check('S', 'S5 collapsing the right sidebar closes the sidebar WS', Boolean(closed), { closed: true }, { closed: Boolean(closed), socketId });
    check('S', 'S6 hidden sidebar stops frame/state/metrics traffic', afterHide.length === 0,
      { requestsAfterHide: 0 }, { requestsAfterHide: afterHide.length, sample: summarizeRequests(afterHide).slice(0, 6) });
    const metricsAfter = await pageHostFetch('/metrics', { headers: scopeHeadersForSession(sessionA) });
    const clientsAfter = metricsAfter.json && metricsAfter.json.host ? metricsAfter.json.host.clients : null;
    check('S', 'S7 hidden sidebar stops renewing the viewer heartbeat (host.clients available and did not grow)',
      typeof clientsBefore === 'number' && typeof clientsAfter === 'number' && clientsAfter <= clientsBefore,
      { before: 'number', after: '<= before' }, { before: clientsBefore, after: clientsAfter });
    state.observations.sidebarHidden = {
      sessionId: sessionA,
      socketId,
      closed: Boolean(closed),
      requestsAfterHide: afterHide.length,
      hostClientsBefore: clientsBefore,
      hostClientsAfter: clientsAfter,
    };

    const resumeMark = Date.now();
    await expandRightSidebar();
    await sleep(400);
    const stillMounted = await pageEvaluate(panelExpr('sidebar', 'return true;'));
    if (!stillMounted) await openRightSidebarTab();
    await sleep(200);
    await waitFor(async () => {
      const resumed = wsCreatedSince(resumeMark).length > 0;
      return resumed ? true : undefined;
    }, { timeoutMs: 8000, intervalMs: 150, label: 'sidebar WS rebuilt after expand' });
    const resumedSockets = wsCreatedSince(resumeMark);
    const resumedMatching = assertPanelSocket('S', 'S8 expanding the sidebar rebuilds the session-A WS', resumedSockets, { kind: 'session', sessionId: sessionA });
    await waitFor(async () => framesOnSocket(resumedMatching[0] ? resumedMatching[0].requestId : '').length > 0, { timeoutMs: 8000, intervalMs: 150, label: 'sidebar frames after expand' });
    state.observations.sidebarResumed = {
      sockets: resumedMatching.map((socket) => ({ url: socket.url.replace(/^ws:\/\/[^/]+/, 'ws://[host]'), query: wsQuery(socket.url) })),
    };

    // Switch to B: the A sidebar tab unmounts and B's sidebar tab is session B.
    const reopenedSidebarB = await newSessionInWorkspace(workspaceB.workspaceId);
    check('S', 'S8b sidebar switch lands in workspace B', reopenedSidebarB === sessionB,
      { sessionId: sessionB }, { sessionId: reopenedSidebarB });
    await sleep(700);
    const markB = Date.now();
    await openRightSidebarTab();
    await sleep(900);
    const requestsB = await waitForPanelHeaders(markB);
    assertPanelRequests('S', 'S9 sidebar in session B uses session B', requestsB, { kind: 'session', sessionId: sessionB });
    const socketsB = wsCreatedSince(markB);
    const matchingB = assertPanelSocket('S', 'S10 sidebar WS in session B uses session B', socketsB, { kind: 'session', sessionId: sessionB });
    const scopeB = await sessionScopeInfo(sessionB);
    const urlSidebarB = state.fixture.url + 'second.html?workspace=B&seat=sidebar';
    await submitPanelAddress('sidebar', urlSidebarB);
    await waitPanelAddress('sidebar', urlSidebarB, 20000);
    await waitFor(async () => framesOnSocket(matchingB[0] ? matchingB[0].requestId : '').length > 0, { timeoutMs: 8000, intervalMs: 150, label: 'sidebar frames B' });
    assertFrames('S', 'S11 sidebar B frames carry scope B (not A)', matchingB, scopeB.scopeId, scopeB.runtimeId, scope.scopeId);
    const allRequestsSidebarB = panelRequestsSince(markB);
    assertPanelRequests('S', 'S12 sidebar B all requests incl. navigate', allRequestsSidebarB, { kind: 'session', sessionId: sessionB });
    state.observations.sidebarB = {
      sessionId: sessionB,
      scope: scopeB,
      ws: matchingB.map((socket) => ({ url: socket.url.replace(/^ws:\/\/[^/]+/, 'ws://[host]'), query: wsQuery(socket.url) })),
    };
  });
}

/* ------------------------------------------------------------------------------------------------
 * Cleanup / report.
 * ---------------------------------------------------------------------------------------------- */
const watchdog = setTimeout(async () => {
  log(`\n[watchdog] hard timeout ${TOTAL_TIMEOUT_MS}ms`);
  try { await cleanup('hard-timeout'); } catch { /* ignore */ }
  process.exit(2);
}, TOTAL_TIMEOUT_MS);
watchdog.unref?.();

async function cleanup(reason) {
  log(`\n[cleanup] ${reason}`);
  // Close only the two acceptance scopes; workspaces stay registered for repeatable runs.
  for (const sessionId of [state.sessions.A, state.sessions.B]) {
    if (!sessionId || !state.chrome) continue;
    try { await pageHostFetch('/close', { method: 'POST', body: {}, headers: scopeHeadersForSession(sessionId) }); } catch { /* ignore */ }
  }
  try { state.chrome?.cdp?.close(); } catch { /* ignore */ }
  if (state.chrome?.proc) {
    try { state.chrome.proc.kill('SIGTERM'); } catch { /* ignore */ }
    await sleep(600);
    try { if (state.chrome.proc.exitCode === null) state.chrome.proc.kill('SIGKILL'); } catch { /* ignore */ }
    await rm(state.chrome.profileDir, { recursive: true, force: true }).catch(() => {});
  }
  try { await state.fixture?.close(); } catch { /* ignore */ }
  log('[cleanup] done');
}

function buildReport(fatal) {
  const failed = checks.filter((entry) => !entry.pass);
  const byScenario = {};
  for (const entry of checks) {
    const bucket = byScenario[entry.scenario] || (byScenario[entry.scenario] = { checks: 0, failed: 0 });
    bucket.checks += 1;
    if (!entry.pass) bucket.failed += 1;
  }
  return {
    schemaVersion: 1,
    suite: 'dsh-agent-team-ui-testing/gui-workspace-3081',
    generatedAt: new Date().toISOString(),
    environment: {
      guiBase: GUI_BASE,
      is3081: guiUrl.port === '3081',
      guiOrigin: guiUrl.origin,
      tokenLogPath: LOG_PATH,
      host: state.hostInfo || null,
      dshHome: {
        configured: DSH_3081_HOME,
        listener: state.hostInfo && state.hostInfo.dshHome ? state.hostInfo.dshHome : null,
        matches: Boolean(state.hostInfo && state.hostInfo.dshHome === DSH_3081_HOME),
      },
      build: state.buildInfo || null,
      servedClient: state.servedClient || null,
      workspaces: { a: WORKSPACE_A, b: WORKSPACE_B },
      usedNativeValueSetter: state.usedNativeValueSetter,
      enterFallback: state.enterFallback,
      chromeBin: CHROME_BIN,
      node: process.version,
      platform: `${process.platform}/${process.arch}`,
      interactions: 'GUI 交互使用 DOM 级 click/focus + CDP 可信按键输入；工作区通过真实目录选择器（Workspace Controller）注册，会话通过工作区行的“新建会话”创建；scoped /state 证据由 GUI 页面自身的 fetch（browserPeer）发出。',
      note: 'GUI token 与 browser-session cookie 只在本进程内存；报告/日志已脱敏。3080 未被操作。两个 /tmp 工作区是隔离 3081 的真实注册工作区，脚本不手改 workspace.json。',
    },
    fatal: fatal ? sanitize(errorMessage(fatal)) : undefined,
    scenarios: Object.fromEntries(Object.entries(byScenario).map(([name, value]) => [name, { ...value, passed: value.failed === 0 }])),
    observations: state.observations,
    checks,
    summary: {
      checks: checks.length,
      passed: checks.length - failed.length,
      failed: failed.length,
      failedScenarios: Object.entries(byScenario).filter(([, value]) => value.failed > 0).map(([name]) => name),
      exitCode: fatal ? 2 : failed.length ? 1 : 0,
    },
    notCovered: [
      '旧 Host（无 scope 支持）路径：本脚本要求 scope-aware Host；客户端对旧 Host 仅保持可显示并 console.warn，不声称隔离',
      'Cookie/localStorage/cache 隔离（明确非目标）',
      'viewer TTL 的绝对数值：只记录 host.clients 在隐藏前后未增长 + 无 metrics 心跳；3081 可能另有外部 viewer',
      '面板像素/视觉（视觉已冻结，不在本任务）',
      '3080 实例（未操作、未重启）',
    ],
  };
}

let exitCode = 0;
try {
  await main();
  const failed = checks.filter((entry) => !entry.pass);
  exitCode = failed.length ? 1 : 0;
} catch (error) {
  log(`\n[fatal] ${sanitize(errorMessage(error))}`);
  console.error(error);
  exitCode = 2;
} finally {
  await cleanup('complete').catch(() => {});
  const report = buildReport(exitCode === 2 ? 'fatal' : undefined);
  await mkdir(RUN_DIR, { recursive: true });
  await writeFile(join(RUN_DIR, 'report.json'), JSON.stringify(report, null, 2));
  await writeFile(join(RUN_DIR, 'console.log'), sanitize(logLines.join('\n') + '\n'));
  const failed = checks.filter((entry) => !entry.pass);
  log(`\ngui-workspace-3081: ${checks.length - failed.length}/${checks.length} checks, ${failed.length} failed, exit=${report.summary.exitCode}`);
  log('Report: ' + RUN_DIR + '/report.json');
}
process.exitCode = exitCode;
