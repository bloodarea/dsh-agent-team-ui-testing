#!/usr/bin/env node
/**
 * Real-GUI acceptance for "address bar / reload / back-forward follow the real browser"
 * on the user's isolated 3081 DSH host.
 *
 * What it proves (contract §6, scenarios A–K):
 *   - A real headless Chromium (started from about:blank so the GUI token never touches a
 *     command line) opens the tokenized 3081 GUI; the token and the browser-session cookie only
 *     ever live in this process's memory.
 *   - The debug panel is opened through the real shell (`更多` → `调试视图` → `.utb`).
 *   - For every scenario the SAME moment is asserted from four independent views:
 *       1. the target page's real `location.href` (via authenticated POST /eval),
 *       2. the GUI `.utb-addr` input value (real DOM),
 *       3. the authenticated HTTP `/plugins/ui-testing/state` `ui.address` / `ui.history`,
 *       4. the GUI back/forward/reload buttons' `disabled` properties.
 *   - A cold start, panel submit, in-site link click, GET form submit, fixed 302 redirect,
 *     pushState/replaceState/hash/title-only, real back/forward (same- and cross-document) with
 *     forward truncation, reload (URL kept, DOM reset, no new history entry), draft editing
 *     (poll overlay, blur, Escape, in-flight re-edit, stale response injection), WebSocket
 *     failure → poll fallback (+ bounded-delay stale /state & /frame responses, revision
 *     monotonicity), redaction isolation (authenticated UI raw vs redacted state/tool
 *     projection, unauthenticated/forged-Origin fail-closed, protected /reload & /history),
 *     and a legacy-response degradation simulation (no operating of 3080).
 *
 * NOT covered here (stated in the report/handover, never implied as verified):
 *   - `browser_state` tool JSON itself: t1 tools are not callable over this HTTP surface. The
 *     structurally equivalent redacted projection is asserted here; the real tool JSON is
 *     covered by tests/acceptance/run.mjs P6.
 *   - Pixel/visual appearance of the panel (visuals are frozen; not this task).
 *   - The 3080 instance (never touched).
 *
 * This script NEVER starts a replacement DSH and NEVER restarts 3081. It only talks to
 * GUI_BASE (default http://127.0.0.1:3081) and drives its own headless Chromium.
 *
 * Run:  node tests/acceptance/address-history-3081.mjs
 * Env:  GUI_BASE (default http://127.0.0.1:3081; a non-3081 port needs ALLOW_NON_3081=1 and is
 *              reported as NOT a 3081 result), DSH_3081_LOG (default /tmp/dsh-3081.log),
 *       DSH_ACCEPTANCE_CHROME / DSH_REAL_BROWSER_CHROME (default tests/acceptance/chrome-wrapper.sh),
 *       DSH_ADDRESS_TIMEOUT_MS (default 300000).
 *
 * Exit codes: 0 all checks pass; 1 assertion failure; 2 unexpected fatal error.
 */
import { execFileSync, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

if (process.argv[1] !== fileURLToPath(import.meta.url)) {
  throw new Error('address-history-3081.mjs 会驱动真实 3081 宿主浏览器，不能被 import 或通过 -e 触发；请直接运行 `node tests/acceptance/address-history-3081.mjs`。');
}

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = dirname(dirname(HERE));
const RUN_DIR = join(HERE, 'runs', `address-history-${new Date().toISOString().replace(/[:.]/g, '-')}-${process.pid}`);
const GUI_BASE = (process.env.GUI_BASE || 'http://127.0.0.1:3081').replace(/\/+$/, '');
const LOG_PATH = process.env.DSH_3081_LOG || '/tmp/dsh-3081.log';
const CHROME_BIN = process.env.DSH_ACCEPTANCE_CHROME || process.env.DSH_REAL_BROWSER_CHROME || join(HERE, 'chrome-wrapper.sh');
const TOTAL_TIMEOUT_MS = Number(process.env.DSH_ADDRESS_TIMEOUT_MS || 300000) || 300000;
const CHROME_PROFILE_PREFIX = 'dsh-address-history-';
const BOUNDED_WAIT_MS = 3000;
const POLL_MS = 75;

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
  value = value.replace(/dsh-auth-[A-Za-z0-9_-]+[=:]\s*[A-Za-z0-9_-]+/g, 'dsh-auth-[REDACTED]');
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
 * CDP client (same shape as tests/acceptance/real-browser-ws.mjs).
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
    return text === undefined ? String(value) : text.slice(0, 700);
  } catch { return String(value).slice(0, 700); }
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
 * Host HTTP helpers. `state.cookie` is the only credential and never leaves this process.
 * ---------------------------------------------------------------------------------------------- */
const state = {
  token: '',
  cookie: '',
  chrome: undefined,
  fixture: undefined,
  navigateRequests: [],
  wsEvents: [],
  cdpScriptIds: [],
  trace: [],
};

async function hostFetch(path, { method = 'GET', body, auth = true, headers = {}, timeoutMs = 20000 } = {}) {
  const requestHeaders = { ...headers };
  if (auth && state.cookie) requestHeaders.cookie = state.cookie;
  if (body !== undefined) requestHeaders['content-type'] = 'application/json';
  const response = await fetch(GUI_BASE + '/plugins/ui-testing' + path, {
    method,
    headers: requestHeaders,
    body: body === undefined ? undefined : JSON.stringify(body),
    cache: 'no-store',
    signal: AbortSignal.timeout(timeoutMs),
  });
  const text = await response.text();
  let json;
  try { json = JSON.parse(text); } catch { json = text; }
  return { status: response.status, json, text, headers: response.headers };
}

async function hostState() {
  const response = await hostFetch('/state');
  if (response.status !== 200) throw new Error(`GET /state -> ${response.status}: ${sanitize(response.text).slice(0, 200)}`);
  return response.json;
}

async function targetInfo() {
  const response = await hostFetch('/eval', {
    method: 'POST',
    body: { expression: '({ href: location.href, ready: document.readyState, title: document.title })' },
  });
  if (response.status !== 200 || !response.json || response.json.ok !== true) {
    throw new Error(`target /eval -> ${response.status}: ${sanitize(response.text).slice(0, 240)}`);
  }
  return response.json.value;
}

async function targetEval(expression) {
  const response = await hostFetch('/eval', { method: 'POST', body: { expression } });
  if (response.status !== 200 || !response.json || response.json.ok !== true) {
    throw new Error(`target /eval failed (${response.status}): ${sanitize(response.text).slice(0, 300)}`);
  }
  return response.json.value;
}

async function targetClick(selector) {
  const point = await targetEval(`(() => {
    const el = document.querySelector(${JSON.stringify(selector)});
    if (!el) return null;
    const rect = el.getBoundingClientRect();
    return { x: Math.round(rect.left + rect.width / 2), y: Math.round(rect.top + rect.height / 2), width: rect.width, height: rect.height };
  })()`);
  if (!point || !(point.width > 0 && point.height > 0)) throw new Error('target element not clickable: ' + selector);
  const input = await hostFetch('/input', {
    method: 'POST',
    body: {
      events: [
        { kind: 'mouse', type: 'mousePressed', x: point.x, y: point.y, button: 'left', buttons: 1, clickCount: 1 },
        { kind: 'mouse', type: 'mouseReleased', x: point.x, y: point.y, button: 'left', buttons: 0, clickCount: 1 },
      ],
    },
  });
  if (input.status !== 200 || input.json?.ok !== true) throw new Error('target /input failed: ' + sanitize(input.text).slice(0, 200));
  return point;
}

/* ------------------------------------------------------------------------------------------------
 * GUI helpers (DOM-level clicks/focus + trusted CDP key events for typing).
 * ---------------------------------------------------------------------------------------------- */
async function guiSnapshot() {
  return pageEvaluate(`(() => {
    const panel = document.querySelector('.utb');
    const addr = document.querySelector('.utb-addr');
    const back = document.querySelector('button[aria-label="后退"]');
    const forward = document.querySelector('button[aria-label="前进"]');
    const reload = document.querySelector('button[aria-label="刷新"]');
    return {
      panel: !!panel,
      addr: addr ? addr.value : null,
      disabled: {
        back: back ? !!back.disabled : null,
        forward: forward ? !!forward.disabled : null,
        reload: reload ? !!reload.disabled : null,
      },
      invalid: addr ? addr.getAttribute('data-invalid') : null,
      alert: (() => { const node = panel && panel.querySelector('[role="alert"]'); return node ? node.textContent : null; })(),
      focused: document.activeElement ? (document.activeElement.className || document.activeElement.tagName) : null,
    };
  })()`);
}

async function guiClick(selector) {
  const result = await pageEvaluate(`(() => {
    const el = document.querySelector(${JSON.stringify(selector)});
    if (!el) return { found: false };
    const before = { disabled: !!el.disabled, text: (el.textContent || '').slice(0, 60) };
    el.click();
    return { found: true, ...before };
  })()`);
  if (!result || !result.found) throw new Error('GUI selector not found: ' + selector);
  return result;
}

async function guiDiag() {
  try {
    return await pageEvaluate(`(() => ({
      url: location.href,
      ready: document.readyState,
      utb: document.querySelectorAll('.utb').length,
      addrInputs: document.querySelectorAll('.utb-addr').length,
      buttons: [...document.querySelectorAll('button[aria-label]')].map((el) => el.getAttribute('aria-label')).slice(0, 60),
      menuRows: [...document.querySelectorAll('.utb-menu-row')].map((el) => el.textContent.trim()).slice(0, 10),
      hasBoot: !!window.__DSH_BOOT__,
      bodyText: (document.body ? document.body.innerText : '').slice(0, 300),
    }))()`);
  } catch (error) {
    return { error: sanitize(errorMessage(error)) };
  }
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

async function openPanel() {
  // After a GUI reload the shell mounts asynchronously: wait (bounded) for the sidebar action
  // before clicking, instead of assuming the whole React tree is already there.
  let clicked;
  try {
    clicked = await waitFor(async () => {
      const stateNow = await sidebarMoreClick();
      return stateNow && stateNow.clicked ? stateNow : undefined;
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
    // Menu may have closed after the first click; retry once through the sidebar action.
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
  await waitFor(() => pageEvaluate(`!!document.querySelector('.utb')`), { timeoutMs: 5000, intervalMs: 50, label: '.utb panel' });
  await installSubmitProbe();
  return true;
}

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

/**
 * Reload the GUI tab and wait for the NEW document. `Page.reload` resolves before the navigation
 * commits, so waiting on `document.readyState`/`__DSH_BOOT__` alone can still observe the old
 * document (and drive a panel that is about to disappear). The marker is set in the old document
 * and must be gone before we treat the page as reloaded.
 */
async function reloadGui() {
  state.documentGeneration = (state.documentGeneration || 0) + 1;
  try {
    await pageEvaluate(`window.__utbReloadMarker = 'before-reload'; true`);
  } catch { /* old document may be mid-navigation */ }
  await state.chrome.cdp.send('Page.reload', { ignoreCache: false });
  await waitFor(async () => {
    try {
      const gone = await pageEvaluate(`window.__utbReloadMarker === undefined`);
      return gone === true ? true : undefined;
    } catch { return undefined; }
  }, { timeoutMs: 20000, intervalMs: 100, label: 'new GUI document after reload' });
  return waitGuiReady(30000);
}

/**
 * Dismiss shell-owned modal dialogs (sign-in / sign-out / onboarding) that the DSH web shell may
 * mount asynchronously. Their Modal auto-focuses the close button, which can steal focus from the
 * address input a few milliseconds after typing and make the client cancel the draft (a real blur).
 * This is test-environment setup (the same category as closing the "开始使用" overlay); it is never
 * used to weaken an assertion. Only dialogs outside the plugin panel with a close/cancel control
 * are dismissed, and every dismissal is counted in the report.
 */
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
    return { dialogs: dialogs.length, closed, classes: dialogs.map((el) => String(el.className).slice(0, 80)) };
  })()`);
  if (result && result.closed > 0) {
    state.dialogsDismissed = (state.dialogsDismissed || 0) + result.closed;
    state.lastDismissedDialogs = result.classes;
    await sleep(200);
  }
  return result;
}

/**
 * Focus the address input through a full blur→focus cycle. The client tracks "focused" with a ref
 * set by onFocus and cleared by onBlur; `focus()` on an already-focused element fires no event, so
 * a previous shell focus steal could leave the ref false while the DOM input is focused. That made
 * the subsequent blur a no-op for the draft state. A forced cycle guarantees React sees focus
 * before we type, exactly like a user clicking into the field.
 */
async function focusAddress() {
  const ok = await pageEvaluate(`(() => {
    const el = document.querySelector('.utb-addr');
    if (!el) return false;
    if (document.activeElement === el) el.blur();
    el.focus();
    el.select();
    return document.activeElement === el;
  })()`);
  if (!ok) throw new Error('cannot focus .utb-addr');
}

async function guiAddr() {
  return pageEvaluate(`(() => { const el = document.querySelector('.utb-addr'); return el ? el.value : null; })()`);
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

async function pressEscape() {
  await dispatchKey('Escape', { code: 'Escape', virtualKeyCode: 27 });
}

/** Type a draft into the address bar through trusted CDP input (native setter is only a fallback). */
/**
 * Read both the DOM value and the React controlled value of the address input. The React value is
 * only used as a *synchronisation aid* (never as a behavioral assertion): a controlled input can
 * briefly show the typed text in the DOM before React commits the new draft, and pressing Enter in
 * that window would submit the previous address.
 */
async function addressSyncState() {
  return pageEvaluate(`(() => {
    const el = document.querySelector('.utb-addr');
    if (!el) return null;
    const key = Object.keys(el).find((name) => name.startsWith('__reactProps$'));
    return {
      dom: el.value,
      react: key ? el[key].value : null,
      focused: document.activeElement === el,
      invalid: el.getAttribute('data-invalid'),
    };
  })()`);
}

async function waitAddressSynced(text, timeoutMs = 1500) {
  try {
    return await waitFor(async () => {
      const sync = await addressSyncState();
      if (!sync) return undefined;
      return sync.dom === text && (sync.react === null || sync.react === text) ? sync : undefined;
    }, { timeoutMs, intervalMs: 50, label: 'controlled address value' });
  } catch {
    state.addressSyncMiss = (state.addressSyncMiss || 0) + 1;
    return undefined;
  }
}

/** Type text character-by-character through trusted key events (headless-safe, React-friendly). */
async function typeCharacters(text) {
  for (const character of text) {
    const isLetter = /[a-zA-Z]/.test(character);
    const isDigit = /[0-9]/.test(character);
    const code = isLetter ? 'Key' + character.toUpperCase() : isDigit ? 'Digit' + character : '';
    const virtualKeyCode = isLetter ? character.toUpperCase().charCodeAt(0) : isDigit ? character.charCodeAt(0) : 0;
    await state.chrome.cdp.send('Input.dispatchKeyEvent', {
      type: 'keyDown', key: character, code, windowsVirtualKeyCode: virtualKeyCode,
      nativeVirtualKeyCode: virtualKeyCode, text: character, unmodifiedText: character,
    });
    await state.chrome.cdp.send('Input.dispatchKeyEvent', {
      type: 'keyUp', key: character, code, windowsVirtualKeyCode: virtualKeyCode, nativeVirtualKeyCode: virtualKeyCode,
    });
  }
}

async function typeAddress(text) {
  const stable = async () => {
    const sync = await addressSyncState();
    return sync && sync.dom === text && (sync.react === null || sync.react === text) && sync.focused === true ? sync : undefined;
  };
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    await dismissShellDialogs();
    await focusAddress();
    await state.chrome.cdp.send('Input.insertText', { text });
    let synced = await waitAddressSynced(text, 900);
    if (!synced) {
      // Bulk insertion did not reach/keep the controlled value: retype character by character.
      await dismissShellDialogs();
      await focusAddress();
      await dispatchKey('Backspace', { code: 'Backspace', virtualKeyCode: 8 });
      await typeCharacters(text);
      synced = await waitAddressSynced(text, 2000);
    }
    if (!synced) {
      // Last-resort React-compatible value write; recorded as an environment fact when used.
      const used = await pageEvaluate(`(() => {
        const el = document.querySelector('.utb-addr');
        if (!el) return false;
        const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
        setter.call(el, ${JSON.stringify(text)});
        el.dispatchEvent(new Event('input', { bubbles: true }));
        return el.value === ${JSON.stringify(text)};
      })()`);
      if (used) {
        state.usedNativeValueSetter = (state.usedNativeValueSetter || 0) + 1;
        await waitAddressSynced(text, 1000);
      }
    }
    // The shell may steal focus right after the input event (modal autoFocus, tab focus moves):
    // require a short stable window before declaring the draft ready.
    await sleep(150);
    const settled = await stable();
    if (settled) {
      state.lastAddressState = settled;
      await sleep(60);
      return guiAddr();
    }
    state.focusStealRetries = (state.focusStealRetries || 0) + 1;
    state.lastFocusSteal = { attempt, at: new Date().toISOString(), state: await addressSyncState() };
    await sleep(300);
  }
  throw new Error('cannot type a stable address draft into .utb-addr (focus/draft kept changing): '
    + sanitize(fmt(await addressSyncState())));
}

async function submitAddress(text) {
  const stableDraft = async () => {
    const sync = await addressSyncState();
    return sync && sync.dom === text && (sync.react === null || sync.react === text) && sync.focused === true;
  };
  await typeAddress(text);
  if (!(await stableDraft())) {
    // A modal focus move slipped in between typing and pressing Enter: type again.
    state.submitRecoveries = (state.submitRecoveries || 0) + 1;
    await typeAddress(text);
  }
  state.lastSubmitted = { text, address: await addressSyncState() };
  const before = await pageEvaluate(`window.__utbSubmitSeen || 0`);
  await pressEnter();
  try {
    await waitFor(async () => (await pageEvaluate(`window.__utbSubmitSeen || 0`)) > before, {
      timeoutMs: 1200, intervalMs: 50, label: 'form submit event',
    });
  } catch {
    // The Enter may have been swallowed by a shell modal that stole focus. Recover deterministically:
    // dismiss that modal, ensure the draft is still the requested text and focused, press Enter
    // again, and only then fall back to the form's own submit path. Every step is recorded.
    await dismissShellDialogs();
    if (!(await stableDraft())) {
      state.submitRecoveries = (state.submitRecoveries || 0) + 1;
      await typeAddress(text);
    }
    const seenBeforeRetry = await pageEvaluate(`window.__utbSubmitSeen || 0`);
    await pressEnter();
    try {
      await waitFor(async () => (await pageEvaluate(`window.__utbSubmitSeen || 0`)) > seenBeforeRetry, {
        timeoutMs: 1200, intervalMs: 50, label: 'form submit retry after focus recovery',
      });
    } catch {
      if (!(await stableDraft())) {
        state.submitRecoveries = (state.submitRecoveries || 0) + 1;
        await typeAddress(text);
      }
      const submitted = await pageEvaluate(`(() => {
        const input = document.querySelector('.utb-addr');
        if (!input || !input.form) return false;
        input.form.requestSubmit();
        return true;
      })()`);
      if (!submitted) throw new Error('cannot submit the address form');
      state.enterFallback = (state.enterFallback || 0) + 1;
      await waitFor(async () => (await pageEvaluate(`window.__utbSubmitSeen || 0`)) > before, {
        timeoutMs: 1500, intervalMs: 50, label: 'form submit fallback',
      });
    }
  }
}

/** Observe DOM submit events so an implicit Enter submission can be distinguished from a no-op. */
async function installSubmitProbe() {
  await pageEvaluate(`(() => {
    if (window.__utbSubmitListener) return true;
    window.__utbSubmitListener = true;
    window.__utbSubmitSeen = 0;
    document.addEventListener('submit', () => { window.__utbSubmitSeen += 1; }, true);
    return true;
  })()`);
}

async function clickGui(ariaLabel) {
  return guiClick(`button[aria-label="${ariaLabel}"]`);
}

async function addressBlur() {
  await pageEvaluate(`(() => { if (document.activeElement && document.activeElement.blur) document.activeElement.blur(); return true; })()`);
}

/* ------------------------------------------------------------------------------------------------
 * Unified snapshot: target page + GUI DOM + authenticated HTTP state.
 * ---------------------------------------------------------------------------------------------- */
async function snapshot() {
  const [info, gui, host] = await Promise.all([targetInfo(), guiSnapshot(), hostState()]);
  return { href: info.href, ready: info.ready, title: info.title, gui, state: host, ui: host.ui, history: host.ui ? host.ui.history : undefined };
}

function buttonsMatch(snap) {
  const running = snap.state && snap.state.running === true;
  const ui = snap.ui;
  const history = ui && ui.history;
  const available = Boolean(history && history.available && running);
  const expected = {
    back: !(available && history.canGoBack === true),
    forward: !(available && history.canGoForward === true),
    reload: !(running && Boolean(ui && ui.address)),
  };
  return {
    match: snap.gui.disabled.back === expected.back
      && snap.gui.disabled.forward === expected.forward
      && snap.gui.disabled.reload === expected.reload,
    expected,
  };
}

async function waitSync(predicate, label, timeoutMs = BOUNDED_WAIT_MS) {
  const started = Date.now();
  let last;
  while (Date.now() - started <= timeoutMs) {
    try {
      last = await snapshot();
      if (predicate(last)) return last;
    } catch (error) {
      last = { error: sanitize(errorMessage(error)) };
    }
    await sleep(POLL_MS);
  }
  throw new Error(`bounded wait ${timeoutMs}ms exhausted for ${label}; last=${sanitize(fmt(last))}`);
}

/**
 * Assert one state is simultaneously reflected by the target page, the GUI address input, the
 * authenticated HTTP ui projection and the three navigation buttons' disabled properties.
 */
async function expectAligned(name, label, expectedHref, { timeoutMs = BOUNDED_WAIT_MS, history } = {}) {
  let snap;
  try {
    snap = await waitSync((candidate) => candidate.href === expectedHref
      && candidate.ready === 'complete'
      && candidate.ui && candidate.ui.address === expectedHref
      && candidate.gui.addr === expectedHref
      && buttonsMatch(candidate).match, label, timeoutMs);
  } catch (error) {
    check(name, `${label} 四路对齐（目标页/地址栏/HTTP ui/按钮）`, false, expectedHref, sanitize(errorMessage(error)));
    return null;
  }
  state.trace.push({
    at: new Date().toISOString(), label, href: snap.href, addr: snap.gui.addr,
    uiAddress: snap.ui && snap.ui.address, history: snap.history, disabled: snap.gui.disabled,
  });
  check(name, `${label} 目标页 location.href`, snap.href === expectedHref, expectedHref, snap.href);
  check(name, `${label} 目标页 readyState`, snap.ready === 'complete', 'complete', snap.ready);
  check(name, `${label} GUI .utb-addr.value`, snap.gui.addr === expectedHref, expectedHref, snap.gui.addr);
  check(name, `${label} HTTP ui.address`, snap.ui.address === expectedHref, expectedHref, snap.ui.address);
  const buttons = buttonsMatch(snap);
  check(name, `${label} 后退/前进/刷新 disabled 与 ui.history 一致`, buttons.match, buttons.expected, snap.gui.disabled);
  if (history) {
    for (const [key, expected] of Object.entries(history)) {
      const actual = snap.history ? snap.history[key] : undefined;
      check(name, `${label} ui.history.${key}`, actual === expected, expected, actual);
    }
  }
  return snap;
}

/**
 * Wait until the authenticated ui.history (derived by the Host from CDP Page.getNavigationHistory)
 * satisfies a predicate. The URL and history are refreshed on different paths, so a snapshot can
 * briefly carry the new address with the previous history; every relative history assertion below
 * waits for the settled value instead of reading the immediately-following sample.
 */
async function awaitHistory(name, label, predicate, timeoutMs = BOUNDED_WAIT_MS) {
  try {
    const snap = await waitSync((candidate) => Boolean(candidate.history) && predicate(candidate) && buttonsMatch(candidate).match, label, timeoutMs);
    state.trace.push({
      at: new Date().toISOString(), label, href: snap.href, addr: snap.gui.addr,
      uiAddress: snap.ui && snap.ui.address, history: snap.history, disabled: snap.gui.disabled,
    });
    return snap;
  } catch (error) {
    check(name, `${label} ui.history 稳定`, false, 'history predicate', sanitize(errorMessage(error)));
    return null;
  }
}

/**
 * Wait for two identical history projections >=500ms apart. After a navigation commit the address
 * can update a few milliseconds before the Host's throttled metadata read publishes the new
 * Page.getNavigationHistory values, so a baseline must be taken only once the history stopped
 * moving. Used only to establish a baseline; every subsequent step asserts a relative delta, which
 * a stale pre-action value cannot satisfy.
 */
async function awaitHistorySettled(name, label, timeoutMs = 6000) {
  const started = Date.now();
  let previous = null;
  let stableAt = 0;
  let last;
  while (Date.now() - started <= timeoutMs) {
    try {
      last = await snapshot();
    } catch (error) {
      last = { error: sanitize(errorMessage(error)) };
    }
    const key = JSON.stringify(last && last.history ? last.history : null);
    if (key === previous) {
      if (Date.now() - stableAt >= 500) {
        state.trace.push({
          at: new Date().toISOString(), label, href: last.href, addr: last.gui && last.gui.addr,
          uiAddress: last.ui && last.ui.address, history: last.history, disabled: last.gui && last.gui.disabled,
        });
        return last;
      }
    } else {
      previous = key;
      stableAt = Date.now();
    }
    await sleep(120);
  }
  check(name, `${label} ui.history 稳定`, false, 'two identical history samples >=500ms apart', sanitize(fmt(last && last.history)));
  return null;
}

/* ------------------------------------------------------------------------------------------------
 * Network observation for the GUI page: prove that in-site navigation does not go through
 * POST /navigate (the old local-history implementation did), and that legacy mode never calls the
 * new /reload or /history endpoints.
 * ---------------------------------------------------------------------------------------------- */
function hookNetworkEvents() {
  state.chrome.cdp.on((message) => {
    if (message.method === 'Network.webSocketCreated' && message.params && message.params.url) {
      state.wsEvents.push({ url: String(message.params.url), at: Date.now(), document: state.documentGeneration || 0 });
      return;
    }
    if (message.method !== 'Network.requestWillBeSent') return;
    const request = message.params && message.params.request;
    if (!request || !request.url) return;
    if (!request.url.startsWith(GUI_BASE + '/plugins/ui-testing/')) return;
    let body;
    if (typeof request.postData === 'string') {
      try { body = JSON.parse(request.postData); } catch { body = request.postData.slice(0, 200); }
    }
    state.navigateRequests.push({
      path: request.url.slice((GUI_BASE + '/plugins/ui-testing').length),
      method: request.method,
      url: body && typeof body.url === 'string' ? body.url : undefined,
      at: Date.now(),
    });
  });
}
function navigateCalls(since = 0) {
  return state.navigateRequests.filter((entry) => entry.path.startsWith('/navigate') && entry.at >= since);
}

/* ------------------------------------------------------------------------------------------------
 * Network-response hooks installed in the GUI page (stale injection / legacy simulation).
 * These only rewrite responses inside our own headless tab; they never touch the host or 3080.
 * ---------------------------------------------------------------------------------------------- */
const NETWORK_HOOK_SOURCE = `(() => {
  if (window.__utbNet) return true;
  const nativeFetch = window.fetch.bind(window);
  window.__utbNativeFetch = nativeFetch;
  window.__utbNet = { mode: 'off', delayMs: 1200, navigateDelayMs: 1200, hits: [], navSent: false, protectedRequests: [] };
  const jsonResponse = (value, status, headers) => new Response(JSON.stringify(value), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8' },
  });
  window.fetch = async (input, init) => {
    const net = window.__utbNet;
    const rawUrl = typeof input === 'string' ? input : (input && input.url) || '';
    const url = String(rawUrl);
    const method = String((init && init.method) || (input && input.method) || 'GET').toUpperCase();
    const isState = /\\/plugins\\/ui-testing\\/state(\\?|$)/.test(url);
    const isFrame = /\\/plugins\\/ui-testing\\/frame(\\?|$)/.test(url);
    const isNavigate = method === 'POST' && /\\/plugins\\/ui-testing\\/navigate(\\?|$)/.test(url);
    const isProtected = method === 'POST' && /\\/plugins\\/ui-testing\\/(reload|history)(\\?|$)/.test(url);
    if (net.mode === 'off') return nativeFetch(input, init);
    if (isProtected) net.protectedRequests.push({ url, method, at: Date.now() });
    if (net.mode === 'legacy') {
      const response = await nativeFetch(input, init);
      if (isState) {
        const value = await response.clone().json();
        if (value && typeof value === 'object') delete value.ui;
        return jsonResponse(value, response.status);
      }
      if (isFrame) {
        const value = await response.clone().json();
        if (value && value.state && typeof value.state === 'object') delete value.state.ui;
        return jsonResponse(value, response.status);
      }
      return response;
    }
    if (net.mode === 'stale') {
      if (isNavigate) {
        net.navSent = true;
        const response = await nativeFetch(input, init);
        const body = await response.clone().text();
        net.hits.push({ kind: 'navigate', url: url.indexOf('navigate') >= 0 ? 'navigate' : 'other', at: Date.now() });
        await new Promise((resolve) => setTimeout(resolve, net.navigateDelayMs));
        return new Response(body, { status: response.status, headers: response.headers });
      }
      if (isState || isFrame) {
        const response = await nativeFetch(input, init);
        const body = await response.clone().text();
        net.hits.push({ kind: isState ? 'state' : 'frame', at: Date.now() });
        await new Promise((resolve) => setTimeout(resolve, net.delayMs));
        return new Response(body, { status: response.status, headers: response.headers });
      }
    }
    return nativeFetch(input, init);
  };
  return true;
})()`;

async function installNetworkHook() {
  const installed = await pageEvaluate(NETWORK_HOOK_SOURCE);
  if (!installed) throw new Error('network hook installation failed');
}
async function setNetworkMode(mode) {
  await pageEvaluate(`(() => { window.__utbNet.mode = ${JSON.stringify(mode)}; window.__utbNet.hits = []; window.__utbNet.navSent = false; window.__utbNet.protectedRequests = []; return true; })()`);
}
async function networkHookState() {
  return pageEvaluate(`(() => ({
    mode: window.__utbNet ? window.__utbNet.mode : null,
    navSent: window.__utbNet ? window.__utbNet.navSent : null,
    hits: window.__utbNet ? window.__utbNet.hits.slice() : [],
    protectedRequests: window.__utbNet ? window.__utbNet.protectedRequests.slice() : [],
  }))()`);
}

/* ------------------------------------------------------------------------------------------------
 * Fixture interactions.
 * ---------------------------------------------------------------------------------------------- */
const FIXTURE_FAKE_TOKEN = 'fake-not-secret-address-history';
const results = {};

function fixtureUrl(pathname = '') { return state.fixture.url + pathname; }

async function installSearchForm(q) {
  await targetEval(`(() => {
    const old = document.getElementById('utb-search-form');
    if (old) old.remove();
    const form = document.createElement('form');
    form.id = 'utb-search-form';
    form.method = 'get';
    form.action = '/index.html';
    const input = document.createElement('input');
    input.id = 'utb-search-q';
    input.name = 'q';
    input.value = ${JSON.stringify(q)};
    const button = document.createElement('button');
    button.id = 'utb-search-submit';
    button.type = 'submit';
    button.textContent = 'Search';
    form.append(input, button);
    document.body.append(form);
    return true;
  })()`);
}

async function installRedirectLink() {
  await targetEval(`(() => {
    const old = document.getElementById('utb-to-redirect');
    if (old) old.remove();
    const link = document.createElement('a');
    link.id = 'utb-to-redirect';
    link.href = '/redirect';
    link.textContent = 'redirect';
    document.body.append(link);
    return true;
  })()`);
}

function uiShape(ui) {
  if (!ui || typeof ui !== 'object') return null;
  return {
    keys: Object.keys(ui).sort(),
    history: ui.history && typeof ui.history === 'object' ? Object.keys(ui.history).sort() : null,
    version: ui.version,
    revisionType: Number.isInteger(ui.revision) ? 'integer' : typeof ui.revision,
    runtimeIdType: typeof ui.runtimeId,
    addressType: typeof ui.address,
  };
}

/* ------------------------------------------------------------------------------------------------
 * Scenarios.
 * ---------------------------------------------------------------------------------------------- */
async function scenarioA() {
  // Cold: make sure the browser is stopped, then open the panel.
  const closed = await hostFetch('/close', { method: 'POST', body: {} });
  check('A', 'A0 POST /close ok', closed.status === 200 && closed.json?.ok === true, { status: 200, ok: true }, { status: closed.status, body: closed.json });
  await waitFor(async () => (await hostState()).running === false, { timeoutMs: BOUNDED_WAIT_MS, intervalMs: 100, label: 'browser stopped' });
  await openPanel();
  let cold;
  try {
    cold = await waitFor(async () => {
      const gui = await guiSnapshot();
      const host = await hostState();
      return gui.panel && gui.addr === '' && host.ui && host.ui.address === ''
        && host.ui.history && host.ui.history.available === false
        ? { gui, ui: host.ui, history: host.ui.history } : undefined;
    }, { timeoutMs: BOUNDED_WAIT_MS, intervalMs: POLL_MS, label: 'cold GUI + HTTP ui state' });
  } catch (error) {
    check('A', 'A1 cold state (address empty / history unavailable)', false, { address: '', available: false }, sanitize(errorMessage(error)));
    return;
  }
  check('A', 'A1 .utb panel opened through 更多 → 调试视图', cold.gui.panel === true, true, cold.gui.panel);
  check('A', 'A1 .utb-addr.value empty after close', cold.gui.addr === '', '', cold.gui.addr);
  check('A', 'A1 HTTP ui.address empty', cold.ui.address === '', '', cold.ui.address);
  check('A', 'A1 HTTP ui.history unavailable/index -1/length 0', cold.history.available === false
    && cold.history.index === -1 && cold.history.length === 0 && cold.history.canGoBack === false
    && cold.history.canGoForward === false, { available: false, index: -1, length: 0, canGoBack: false, canGoForward: false }, cold.history);
  check('A', 'A1 三个导航按钮全部 disabled', cold.gui.disabled.back === true && cold.gui.disabled.forward === true
    && cold.gui.disabled.reload === true, { back: true, forward: true, reload: true }, cold.gui.disabled);

  // Agent navigates first; the panel is opened afterwards (fresh GUI view).
  const nav = await hostFetch('/navigate', { method: 'POST', body: { url: fixtureUrl() } });
  check('A', 'A2 Agent 先导航 fixture', nav.status === 200 && nav.json?.ok === true, { status: 200, ok: true }, { status: nav.status, body: nav.json });
  const navUi = nav.json && nav.json.state && nav.json.state.ui;
  state.observations = state.observations || {};
  state.observations.navigateResponseHistory = navUi && navUi.history ? navUi.history : null;
  check('A', 'A2 navigate 响应内 ui.history 已新鲜（终版修复点）', Boolean(navUi && navUi.history
    && navUi.history.available === true && Number.isInteger(navUi.history.index) && Number.isInteger(navUi.history.length)
    && navUi.history.index === navUi.history.length - 1 && navUi.history.canGoForward === false),
  { available: true, index: 'integer=length-1', length: 'integer' }, navUi && navUi.history);
  await waitFor(async () => (await hostState()).ui?.address === fixtureUrl(), { timeoutMs: BOUNDED_WAIT_MS, label: 'ui.address fixture' });

  await reloadGui();
  await openPanel();
  await expectAligned('A', 'A2 先导航后开面板自动显示地址', fixtureUrl());
}

async function scenarioB() {
  // B1: submit through the panel address bar. The navigate-request window is closed explicitly
  // before any B2 action, so B2's own submit can never leak into the B1 assertions.
  const submitStarted = Date.now();
  await submitAddress(fixtureUrl('second.html'));
  const snap = await expectAligned('B', 'B1 面板地址栏提交 second.html', fixtureUrl('second.html'));
  if (snap) check('B', 'B1 ui.history 前进到新条目', snap.history.available === true && snap.history.index >= 1, { index: '>=1' }, snap.history);
  await sleep(1200);
  const settle = await snapshot();
  check('B', 'B1 提交后不回退到旧页面（目标页/地址栏）', settle.href === fixtureUrl('second.html') && settle.gui.addr === fixtureUrl('second.html'), fixtureUrl('second.html'), { href: settle.href, addr: settle.gui.addr });
  const b1WindowEnd = Date.now();
  const b1Navigations = navigateCalls(submitStarted).filter((entry) => entry.at <= b1WindowEnd);
  const submits = b1Navigations.filter((entry) => entry.url === fixtureUrl('second.html'));
  check('B', 'B1 提交确实经 POST /navigate（B1 窗口内，真实网络请求）', submits.length >= 1, { navigate: fixtureUrl('second.html') }, submits.map((entry) => entry.url));
  const oldPageNavigations = b1Navigations.filter((entry) => entry.url === fixtureUrl());
  check('B', 'B1 窗口内没有 /navigate 回旧页面', oldPageNavigations.length === 0, { oldPageNavigations: 0 }, oldPageNavigations.map((entry) => ({ url: entry.url, at: entry.at })));

  // B2: return to the first page through the panel, then click the real in-site link.
  await submitAddress(fixtureUrl());
  await expectAligned('B', 'B2 回到首页（面板提交）', fixtureUrl());
  const beforeLink = navigateCalls().length;
  await targetClick('#to-second');
  await expectAligned('B', 'B2 站内链接真实 click → second.html', fixtureUrl('second.html'));
  await sleep(800);
  const afterLink = navigateCalls();
  check('B', 'B2 站内链接导航未走 POST /navigate（不是本地历史模拟）', afterLink.length === beforeLink, { navigateCalls: beforeLink }, afterLink.length);

  // Back to index for the next scenarios.
  await hostFetch('/navigate', { method: 'POST', body: { url: fixtureUrl() } });
  await expectAligned('B', 'B2 复位到首页', fixtureUrl());
}

async function scenarioC() {
  await installSearchForm('query');
  await targetClick('#utb-search-submit');
  const queryHref = fixtureUrl('index.html') + '?q=query';
  await expectAligned('C', 'C1 GET 搜索表单 q=query', queryHref);

  await installRedirectLink();
  await targetClick('#utb-to-redirect');
  const landed = fixtureUrl('second.html') + '?from=redirect#landed';
  await expectAligned('C', 'C2 /redirect 最终地址', landed, { timeoutMs: 5000 });
  const marker = await targetEval(`document.getElementById('second-marker') ? document.getElementById('second-marker').textContent : null`);
  check('C', 'C2 重定向最终页面内容为 second.html', marker === 'second-page', 'second-page', marker);
  const redirectRequest = state.navigateRequests.filter((entry) => entry.path.startsWith('/navigate') && entry.url === landed);
  check('C', 'C2 重定向不是通过 POST /navigate 伪造的地址', redirectRequest.length === 0, { navigate: 0 }, redirectRequest.length);
}

async function scenarioD() {
  await hostFetch('/navigate', { method: 'POST', body: { url: fixtureUrl() } });
  const base = await expectAligned('D', 'D0 复位到首页', fixtureUrl());
  if (!base) return;
  const baseHistory = await awaitHistorySettled('D', 'D0 复位后历史稳定');
  if (!baseHistory) return;

  await targetEval(`(() => { history.pushState({ step: 1 }, '', '?q=spa#one'); return location.href; })()`);
  await expectAligned('D', 'D1 pushState ?q=spa#one', fixtureUrl() + '?q=spa#one');
  const pushed = await awaitHistory('D', 'D1 pushState 历史稳定', (candidate) => candidate.history.index === baseHistory.history.index + 1
    && candidate.history.length === baseHistory.history.length + 1);
  if (pushed) {
    check('D', 'D1 pushState 增加一个真实历史条目（index+1/length+1）', pushed.history.index === baseHistory.history.index + 1
      && pushed.history.length === baseHistory.history.length + 1, { index: baseHistory.history.index + 1, length: baseHistory.history.length + 1 }, pushed.history);
  }

  await targetEval(`(() => { history.replaceState({ step: 2 }, '', '?q=replace#two'); return location.href; })()`);
  const replaced = await expectAligned('D', 'D2 replaceState ?q=replace#two', fixtureUrl() + '?q=replace#two');
  if (replaced && pushed) {
    const settled = await awaitHistorySettled('D', 'D2 replaceState 后历史稳定');
    if (settled) check('D', 'D2 replaceState 不增加历史条目', settled.history.index === pushed.history.index && settled.history.length === pushed.history.length, { index: pushed.history.index, length: pushed.history.length }, settled.history);
  }

  await targetEval(`(() => { location.hash = '#three'; return location.href; })()`);
  await expectAligned('D', 'D3 location.hash=#three', fixtureUrl() + '?q=replace#three');
  const hashed = await awaitHistory('D', 'D3 hash 历史稳定', (candidate) => pushed && candidate.history.index === pushed.history.index + 1 && candidate.history.length === pushed.history.length + 1);
  if (hashed && pushed) {
    check('D', 'D3 hash 增加一个真实历史条目（index+1/length+1）', hashed.history.index === pushed.history.index + 1
      && hashed.history.length === pushed.history.length + 1, { index: pushed.history.index + 1, length: pushed.history.length + 1 }, hashed.history);
  }

  await targetEval(`(() => { document.title = 'D title only'; return document.title; })()`);
  const titleSnap = await waitSync((candidate) => candidate.title === 'D title only' && candidate.ui && candidate.ui.address === fixtureUrl() + '?q=replace#three', 'title-only state');
  check('D', 'D4 仅标题变化：HTTP title 更新', titleSnap.title === 'D title only', 'D title only', titleSnap.title);
  check('D', 'D4 仅标题变化：地址与历史不变', titleSnap.ui.address === fixtureUrl() + '?q=replace#three'
    && hashed && titleSnap.history.index === hashed.history.index && titleSnap.history.length === hashed.history.length,
  { address: fixtureUrl() + '?q=replace#three', index: hashed ? hashed.history.index : null }, { address: titleSnap.ui.address, history: titleSnap.history });
  check('D', 'D4 地址栏保持真实地址', titleSnap.gui.addr === fixtureUrl() + '?q=replace#three', fixtureUrl() + '?q=replace#three', titleSnap.gui.addr);
}

async function scenarioE() {
  await hostFetch('/navigate', { method: 'POST', body: { url: fixtureUrl() } });
  await expectAligned('E', 'E0 复位到首页', fixtureUrl());
  const e0 = await awaitHistorySettled('E', 'E0 复位后历史稳定');
  if (!e0) return;

  // Cross-document entry through the panel (real user submit).
  await submitAddress(fixtureUrl('second.html'));
  await expectAligned('E', 'E1 面板提交 second.html', fixtureUrl('second.html'));
  const e1 = await awaitHistory('E', 'E1 提交后历史稳定（相对 E0：新条目）', (candidate) => candidate.history.index === e0.history.index + 1
    && candidate.history.length === e0.history.length + 1);
  if (!e1) return;
  check('E', 'E1 新导航后 index+1/length+1 且 canGoForward=false', e1.history.index === e0.history.index + 1
    && e1.history.length === e0.history.length + 1 && e1.history.canGoForward === false,
  { index: e0.history.index + 1, length: e0.history.length + 1, canGoForward: false }, e1.history);

  // Real back (GUI button) → cross-document previous entry.
  await clickGui('后退');
  await expectAligned('E', 'E2 后退 cross-document → 首页', fixtureUrl());
  const back1 = await awaitHistory('E', 'E2 后退后历史稳定', (candidate) => candidate.history.index === e1.history.index - 1
    && candidate.history.length === e1.history.length);
  if (back1) {
    check('E', 'E2 后退 index-1 / length 不变（以前一步 ui.history 为基线）', back1.history.index === e1.history.index - 1
      && back1.history.length === e1.history.length, { index: e1.history.index - 1, length: e1.history.length }, back1.history);
  }

  // Real forward.
  await clickGui('前进');
  await expectAligned('E', 'E3 前进 cross-document → second.html', fixtureUrl('second.html'));
  const forward1 = await awaitHistory('E', 'E3 前进后历史稳定', (candidate) => back1
    && candidate.history.index === back1.history.index + 1 && candidate.history.length === back1.history.length);
  if (forward1 && back1) {
    check('E', 'E3 前进 index+1 / length 不变', forward1.history.index === back1.history.index + 1
      && forward1.history.length === back1.history.length, { index: back1.history.index + 1, length: back1.history.length }, forward1.history);
  }

  // Same-document: back to the first page, pushState, then real back must not reload the page.
  await clickGui('后退');
  await expectAligned('E', 'E4 后退回首页', fixtureUrl());
  const e4 = await awaitHistory('E', 'E4 后退后历史稳定', (candidate) => forward1 && candidate.history.index === forward1.history.index - 1);
  if (!e4) return;
  await targetEval(`(() => { history.pushState({ sameDoc: true }, '', '?q=same#doc'); window.__utbSentinel = 'alive-' + Date.now(); return location.href; })()`);
  const sameDocHref = fixtureUrl() + '?q=same#doc';
  await expectAligned('E', 'E5 same-document pushState', sameDocHref);
  // pushState at a rewound position truncates the forward entry: new length = index+2, which may
  // equal the previous length when exactly one forward entry existed (CDP semantics, no guessing).
  const e5 = await awaitHistory('E', 'E5 pushState 历史稳定（index+1 / 截断 forward）', (candidate) => candidate.history.index === e4.history.index + 1
    && candidate.history.length === e4.history.index + 2 && candidate.history.canGoForward === false);
  if (!e5) return;
  check('E', 'E5 pushState 后 forward 被截断且 index+1', e5.history.index === e4.history.index + 1
    && e5.history.length === e4.history.index + 2 && e5.history.canGoForward === false,
  { index: e4.history.index + 1, length: e4.history.index + 2, canGoForward: false }, e5.history);

  await clickGui('后退');
  await expectAligned('E', 'E6 后退 same-document → 首页', fixtureUrl());
  const e6 = await awaitHistory('E', 'E6 same-document 后退后历史稳定', (candidate) => candidate.history.index === e5.history.index - 1
    && candidate.history.length === e5.history.length);
  const sentinel = await targetEval('window.__utbSentinel || null');
  check('E', 'E6 same-document 后退未重新加载页面（window 哨兵仍在）', Boolean(sentinel), 'sentinel present', sentinel);
  if (e6) check('E', 'E6 same-document 后退 index-1 / length 不变', e6.history.index === e5.history.index - 1 && e6.history.length === e5.history.length, { index: e5.history.index - 1, length: e5.history.length }, e6.history);

  // Forward then truncation.
  await clickGui('前进');
  await expectAligned('E', 'E7 前进回 same-document 条目', sameDocHref);
  const e7 = await awaitHistory('E', 'E7 前进后历史稳定', (candidate) => e6 && candidate.history.index === e6.history.index + 1);
  if (!e7) return;
  await clickGui('后退');
  await expectAligned('E', 'E8 再后退', fixtureUrl());
  const e8 = await awaitHistory('E', 'E8 再后退后历史稳定', (candidate) => candidate.history.index === e7.history.index - 1
    && candidate.history.length === e7.history.length);
  if (!e8) return;
  check('E', 'E8 后退后 forward 可用', e8.history.canGoForward === true, true, e8.history.canGoForward);

  await targetEval(`(() => { history.pushState({ truncate: true }, '', '?q=truncated#x'); return location.href; })()`);
  const truncatedHref = fixtureUrl() + '?q=truncated#x';
  await expectAligned('E', 'E9 后退后新导航截断 forward', truncatedHref);
  const e9 = await awaitHistory('E', 'E9 truncation 历史稳定', (candidate) => candidate.history.index === e8.history.index + 1
    && candidate.history.canGoForward === false);
  if (!e9) return;
  check('E', 'E9 forward 已被截断（canGoForward=false）', e9.history.canGoForward === false, false, e9.history.canGoForward);
  check('E', 'E9 历史长度被截断为 index+1（CDP 语义：pushed entry 在末尾）', e9.history.length === e9.history.index + 1, e9.history.index + 1, e9.history.length);
  const e9Buttons = await waitSync((candidate) => candidate.history.canGoForward === false
    && candidate.gui.disabled.forward === true, 'E9 前进按钮反映截断后的历史');
  check('E', 'E9 前进按钮 disabled', e9Buttons.gui.disabled.forward === true, true, e9Buttons.gui.disabled.forward);
  const before = await snapshot();
  await clickGui('前进');
  await sleep(600);
  const after = await snapshot();
  check('E', 'E9 禁用状态下点前进无效果', after.href === before.href && after.history.index === before.history.index,
    { href: before.href, index: before.history.index }, { href: after.href, index: after.history.index });
}

async function scenarioF() {
  await hostFetch('/navigate', { method: 'POST', body: { url: fixtureUrl() } });
  await expectAligned('F', 'F0 复位到首页', fixtureUrl());
  const f0 = await awaitHistorySettled('F', 'F0 复位后历史稳定');
  if (!f0) return;
  await targetEval(`(() => { history.pushState({ reload: true }, '', '?q=refresh#keep'); return location.href; })()`);
  const reloadHref = fixtureUrl() + '?q=refresh#keep';
  await expectAligned('F', 'F1 准备带 query/hash 的地址', reloadHref);
  const before = await awaitHistory('F', 'F1 pushState 后历史稳定（相对 F0）', (candidate) => candidate.history.index === f0.history.index + 1
    && candidate.history.length === f0.history.length + 1);
  if (!before) return;
  await targetEval(`(() => {
    window.__utbReloadSentinel = 'present';
    const counter = document.getElementById('counter');
    if (counter) counter.textContent = '99';
    const marker = document.createElement('div');
    marker.id = 'utb-dom-sentinel';
    marker.textContent = 'dom-sentinel';
    document.body.append(marker);
    return true;
  })()`);

  await clickGui('刷新');
  await expectAligned('F', 'F2 刷新保持最新 URL', reloadHref, { timeoutMs: 5000 });
  const after = await awaitHistorySettled('F', 'F2 刷新后历史稳定');
  if (after) check('F', 'F2 刷新不新增历史条目（index/length 不变）', after.history.index === before.history.index
    && after.history.length === before.history.length, { index: before.history.index, length: before.history.length }, after.history);
  const reset = await waitFor(async () => {
    const info = await targetEval(`({
      ready: document.readyState,
      sentinel: window.__utbReloadSentinel || null,
      domSentinel: document.getElementById('utb-dom-sentinel') ? true : false,
      counter: (document.getElementById('counter') || {}).textContent || null,
    })`);
    return info && info.ready === 'complete' && info.sentinel === null && info.domSentinel === false && info.counter === '0' ? info : undefined;
  }, { timeoutMs: 5000, intervalMs: 75, label: 'reloaded document state' });
  check('F', 'F2 刷新清除 window 哨兵与注入 DOM（真实重新加载）', reset.sentinel === null && reset.domSentinel === false && reset.counter === '0', { sentinel: null, domSentinel: false, counter: '0' }, reset);
  const last = await snapshot();
  check('F', 'F2 刷新不回到旧输入网址', last.gui.addr === reloadHref, reloadHref, last.gui.addr);
}

async function scenarioG1() {
  await hostFetch('/navigate', { method: 'POST', body: { url: fixtureUrl('second.html') } });
  await expectAligned('G', 'G0 复位到 second.html', fixtureUrl('second.html'));
  const draft = fixtureUrl('second.html') + '?draft=1#draft';
  await pageEvaluate(ADDRESS_PROBE_SOURCE);
  await pageEvaluate(`window.__utbAddrLog.events.length = 0; window.__utbFocusCount = 0; true`);
  await typeAddress(draft);
  const g1FocusCountAfterTyping = await pageEvaluate(`window.__utbFocusCount || 0`);
  await sleep(1800); // > 3 × 500ms /state polls
  let gui = await guiSnapshot();
  check('G', 'G1 编辑草稿跨 ≥3 次 /state 轮询不被覆盖', gui.addr === draft, draft, gui.addr);

  // Autonomous navigation (page-initiated, not via the panel) while the draft is dirty.
  await targetEval(`(() => { location.href = '/index.html'; return true; })()`);
  await waitFor(async () => (await targetInfo()).href === fixtureUrl('index.html'), { timeoutMs: 5000, intervalMs: 75, label: 'autonomous navigation' });
  await sleep(900);
  gui = await guiSnapshot();
  check('G', 'G1 自主导航时草稿不被覆盖', gui.addr === draft, draft, gui.addr);

  const acceptedBeforeBlur = (await hostState()).ui ? (await hostState()).ui.address : null;
  await dismissShellDialogs();
  const beforeBlur = await addressSyncState();
  state.g1 = {
    draft,
    acceptedBeforeBlur,
    beforeBlur,
    focusEventsDuringTyping: g1FocusCountAfterTyping,
    blurEventsBefore: await pageEvaluate(`(window.__utbAddrLog ? window.__utbAddrLog.events.filter((event) => event.type === 'focusout') : []).length`),
  };
  if (beforeBlur && beforeBlur.focused) {
    await addressBlur();
  } else {
    // Focus was already moved away (a real blur happened); the client's blur handler is expected to
    // have cancelled the draft already. Record it and still assert the outcome.
    state.blurWithoutFocus = (state.blurWithoutFocus || 0) + 1;
  }
  try {
    await waitFor(async () => (await guiAddr()) === fixtureUrl('index.html'), { timeoutMs: BOUNDED_WAIT_MS, intervalMs: 75, label: 'blur restores accepted address' });
  } catch (error) {
    const after = await guiSnapshot();
    const host = await hostState();
    state.g1.afterBlur = after;
    state.g1.uiAfterBlur = host.ui ? host.ui.address : null;
    state.g1.blurEventsAfter = await pageEvaluate(`(window.__utbAddrLog ? window.__utbAddrLog.events.filter((event) => event.type === 'focusout' || event.type === 'focusin' || event.type === 'input') : []).slice(-12)`);
    check('G', 'G1 blur 取消草稿并回到最新已接受地址', false, fixtureUrl('index.html'),
      { error: sanitize(errorMessage(error)), g1: state.g1 });
    throw error;
  }
  gui = await guiSnapshot();
  check('G', 'G1 blur 取消草稿并回到最新已接受地址', gui.addr === fixtureUrl('index.html'), fixtureUrl('index.html'), gui.addr);

  const draft2 = fixtureUrl('second.html') + '?escape=1';
  await typeAddress(draft2);
  await pressEscape();
  await waitFor(async () => (await guiAddr()) === fixtureUrl('index.html'), { timeoutMs: BOUNDED_WAIT_MS, intervalMs: 75, label: 'Escape restores address' });
  check('G', 'G1 Escape 取消草稿且不导航', (await guiAddr()) === fixtureUrl('index.html') && (await targetInfo()).href === fixtureUrl('index.html'), fixtureUrl('index.html'), await guiAddr());

  // Synchronously invalid address (unsupported scheme): draft is kept verbatim and marked invalid,
  // no navigation is dispatched.
  const badScheme = 'ftp://example.com/file';
  await submitAddress(badScheme);
  await sleep(300);
  const invalid = await guiSnapshot();
  const invalidHref = (await targetInfo()).href;
  check('G', 'G1 非法 scheme 保留草稿并标红', invalid.addr === badScheme && invalid.invalid === 'true',
    { addr: badScheme, invalid: 'true' }, { addr: invalid.addr, invalid: invalid.invalid });
  check('G', 'G1 非法 scheme 显示错误且不导航', Boolean(invalid.alert && invalid.alert.length > 0) && invalidHref === fixtureUrl('index.html'),
    { alert: 'non-empty', href: fixtureUrl('index.html') }, { alert: invalid.alert, href: invalidHref });
  await pressEscape();
  await waitFor(async () => (await guiAddr()) === fixtureUrl('index.html'), { timeoutMs: BOUNDED_WAIT_MS, intervalMs: 75, label: 'Escape clears invalid draft' });

  // Runtime failure (valid http(s) format, unreachable target): the draft stays on the normalized
  // submitted address with the error state until the next edit/Escape/blur, and the page does not
  // navigate. NAV_FAILED comes back asynchronously from the host.
  const unreachable = 'http://127.0.0.1:1/';
  await submitAddress(unreachable);
  const failed = await waitFor(async () => {
    const gui = await guiSnapshot();
    return gui.invalid === 'true' && Boolean(gui.alert && gui.alert.length > 0) && gui.addr === unreachable ? gui : undefined;
  }, { timeoutMs: 6000, intervalMs: 100, label: 'runtime failure error state' });
  check('G', 'G1 运行失败保留归一化草稿并标红', failed.addr === unreachable && failed.invalid === 'true',
    { addr: unreachable, invalid: 'true' }, { addr: failed.addr, invalid: failed.invalid });
  // A failed real navigation may legitimately leave Chromium on its error document. Per the
  // draft rules the address bar keeps the failed input until Escape/blur, and Escape then shows
  // the real browser address (which can be the error URL) — it must not silently revert to an
  // older URL of its own.
  await pressEscape();
  const afterCancel = await waitFor(async () => {
    const candidate = await snapshot();
    return candidate.gui.addr === candidate.ui.address ? candidate : undefined;
  }, { timeoutMs: BOUNDED_WAIT_MS, intervalMs: 75, label: 'Escape shows real browser address' });
  check('G', 'G1 Escape 后地址栏回到真实浏览器地址（失败草稿不残留）', afterCancel.gui.addr === afterCancel.ui.address,
    { addr: afterCancel.ui.address }, { addr: afterCancel.gui.addr, uiAddress: afterCancel.ui.address });
  const recover = await hostFetch('/navigate', { method: 'POST', body: { url: fixtureUrl('index.html') } });
  check('G', 'G1 运行失败后可恢复导航', recover.status === 200 && recover.json?.ok === true, { status: 200, ok: true }, { status: recover.status });
  await expectAligned('G', 'G1 恢复导航到首页', fixtureUrl('index.html'), { timeoutMs: 5000 });
}

async function scenarioH() {
  // Force every frame WebSocket attempt to throw, then reload the GUI so the transport falls
  // back to /frame polling.
  const script = await state.chrome.cdp.send('Page.addScriptToEvaluateOnNewDocument', {
    source: `(() => {
      const Native = window.WebSocket;
      window.__utbNativeWebSocket = Native;
      function Blocked(url, protocols) {
        if (String(url).indexOf('/plugins/ui-testing/frames') !== -1) throw new Error('acceptance: blocked frame websocket');
        return protocols === undefined ? new Native(url) : new Native(url, protocols);
      }
      Blocked.prototype = Native.prototype;
      Blocked.CONNECTING = 0; Blocked.OPEN = 1; Blocked.CLOSING = 2; Blocked.CLOSED = 3;
      window.WebSocket = Blocked;
    })()`,
  });
  state.cdpScriptIds.push(script.identifier);
  await reloadGui();
  await openPanel();

  let lastMetrics;
  let metrics;
  try {
    metrics = await waitFor(async () => {
      const response = await hostFetch('/metrics');
      lastMetrics = response.json;
      const client = lastMetrics && lastMetrics.client;
      if (client && client.transport === 'poll') return lastMetrics;
      return undefined;
    }, { timeoutMs: 15000, intervalMs: 200, label: 'poll transport metrics' });
  } catch (error) {
    const diag = await guiDiag();
    const wsProbe = await pageEvaluate(`(() => { try { new WebSocket('/plugins/ui-testing/frames'); return 'opened?'; } catch (e) { return 'threw:' + String(e.message); } })()`).catch((probeError) => 'probe failed: ' + sanitize(errorMessage(probeError)));
    check('H', 'H1 WS 抛错重载后 /metrics client.transport=poll', false,
      { transport: 'poll' },
      { error: sanitize(errorMessage(error)), lastClient: lastMetrics && lastMetrics.client, lastHost: lastMetrics && lastMetrics.host && { clients: lastMetrics.host.clients, captured: lastMetrics.host.captured }, wsProbe, panel: diag.utb, url: diag.url, ready: diag.ready, documentGeneration: state.documentGeneration, webSocketEvents: state.wsEvents.map((entry) => ({ at: entry.at, document: entry.document })) });
    return;
  }
  check('H', 'H1 WS 抛错重载后 /metrics client.transport=poll', metrics.client.transport === 'poll', { transport: 'poll' }, { transport: metrics.client.transport });
  // Contract §6-H only requires the poll fallback. The host's live client count is reported as an
  // observation: a frame WebSocket opened by the pre-reload document may still be counted after a
  // GUI reload (the socket/close bookkeeping is outside this acceptance's contract).
  state.observations = state.observations || {};
  state.observations.hostClientsAfterReload = metrics.host ? metrics.host.clients : undefined;

  // Pending frame branch must carry the same ui shape. `framePayload` returns the cached image
  // unless `since` equals the current seq, so derive the current seq first.
  const pending = await waitFor(async () => {
    const head = await hostFetch('/frame?since=0');
    const seq = head.json && head.json.seq;
    if (!Number.isFinite(seq)) return undefined;
    const candidate = await hostFetch('/frame?since=' + seq);
    return candidate.json && candidate.json.pending === true ? { status: candidate.status, json: candidate.json } : undefined;
  }, { timeoutMs: 5000, intervalMs: 150, label: 'pending frame branch' }).catch(() => ({ status: 0, json: {} }));
  const pendingPayload = pending.json;
  check('H', 'H2 /frame pending 响应携带 ui（同形）', pending.status === 200 && pendingPayload
    && pendingPayload.pending === true && pendingPayload.state && pendingPayload.state.ui, { pending: true, ui: 'present' },
  { status: pending.status, pending: pendingPayload && pendingPayload.pending, ui: Boolean(pendingPayload && pendingPayload.state && pendingPayload.state.ui) });

  // Produce a frame and read the full payload.
  for (let index = 0; index < 4; index += 1) {
    await targetEval(`(() => { document.body.style.backgroundColor = 'rgb(${10 + index * 30}, 20, 30)'; return true; })()`);
    await sleep(150);
  }
  const full = await waitFor(async () => {
    const response = await hostFetch('/frame?since=0');
    const value = response.json;
    return value && value.pending !== true && value.image ? { status: response.status, value } : undefined;
  }, { timeoutMs: 8000, intervalMs: 100, label: 'full frame with image' });
  check('H', 'H3 /frame 有图响应携带 ui（同形）', full.value.state && full.value.state.ui, { ui: 'present' }, { ui: Boolean(full.value.state && full.value.state.ui) });
  check('H', 'H3 pending 与有图 /frame 的 ui 形状一致', JSON.stringify(uiShape(pendingPayload.state && pendingPayload.state.ui)) === JSON.stringify(uiShape(full.value.state && full.value.state.ui)), uiShape(pendingPayload.state && pendingPayload.state.ui), uiShape(full.value.state && full.value.state.ui));

  // ui.revision must never go backwards across sequential snapshots.
  const revisions = [];
  for (let index = 0; index < 6; index += 1) {
    const current = await hostState();
    revisions.push(current.ui ? current.ui.revision : null);
    await sleep(40);
  }
  const monotonic = revisions.every((value, index) => Number.isInteger(value) && (index === 0 || value >= revisions[index - 1]));
  check('H', 'H4 乱序/连续 state 的 ui.revision 不回退', monotonic, 'non-decreasing integers', revisions);

  // Re-run C / D / E under poll transport.
  await hostFetch('/navigate', { method: 'POST', body: { url: fixtureUrl() } });
  await expectAligned('H', 'H5 poll 模式复位首页', fixtureUrl());
  const h5 = await awaitHistorySettled('H', 'H5 poll 模式历史稳定');
  if (!h5) return;
  await installSearchForm('poll');
  await targetClick('#utb-search-submit');
  const pollQueryHref = fixtureUrl('index.html') + '?q=poll';
  await expectAligned('H', 'H6 poll 模式 GET 表单 q=poll', pollQueryHref);
  const h6 = await awaitHistory('H', 'H6 poll 模式表单提交后历史稳定（相对 H5）', (candidate) => candidate.history.index === h5.history.index + 1
    && candidate.history.length === h5.history.length + 1);
  if (!h6) return;

  await targetEval(`(() => { history.pushState({}, '', '?q=poll-spa#x'); return location.href; })()`);
  await expectAligned('H', 'H7 poll 模式 pushState', fixtureUrl('index.html') + '?q=poll-spa#x');
  const h7 = await awaitHistory('H', 'H7 pushState 历史稳定', (candidate) => candidate.history.index === h6.history.index + 1
    && candidate.history.length === h6.history.length + 1);
  if (!h7) return;
  await targetEval(`(() => { history.replaceState({}, '', '?q=poll-replace#y'); return location.href; })()`);
  await expectAligned('H', 'H8 poll 模式 replaceState', fixtureUrl('index.html') + '?q=poll-replace#y');
  const h8 = await awaitHistorySettled('H', 'H8 replaceState 后历史稳定');
  if (h8) check('H', 'H8 poll 模式 replaceState 不新增条目', h8.history.index === h7.history.index && h8.history.length === h7.history.length, { index: h7.history.index, length: h7.history.length }, h8.history);
  await targetEval(`(() => { location.hash = '#z'; return location.href; })()`);
  await expectAligned('H', 'H9 poll 模式 hash', fixtureUrl('index.html') + '?q=poll-replace#z');
  const h9 = await awaitHistory('H', 'H9 hash 历史稳定', (candidate) => h8 && candidate.history.index === h8.history.index + 1
    && candidate.history.length === h8.history.length + 1);
  if (!h9) return;
  check('H', 'H9 poll 模式 hash 新增条目', h9.history.index === h8.history.index + 1, h8.history.index + 1, h9.history.index);

  await clickGui('后退');
  await expectAligned('H', 'H10 poll 模式后退', fixtureUrl('index.html') + '?q=poll-replace#y');
  const h10 = await awaitHistory('H', 'H10 后退后历史稳定', (candidate) => candidate.history.index === h9.history.index - 1
    && candidate.history.length === h9.history.length);
  if (!h10) return;
  await clickGui('前进');
  await expectAligned('H', 'H11 poll 模式前进', fixtureUrl('index.html') + '?q=poll-replace#z');
  const h11 = await awaitHistory('H', 'H11 前进后历史稳定', (candidate) => candidate.history.index === h10.history.index + 1);
  if (h11) check('H', 'H11 poll 模式前进 index+1', h11.history.index === h10.history.index + 1, h10.history.index + 1, h11.history.index);
  const afterRerun = await hostFetch('/metrics').catch(() => null);
  state.observations.hostClientsAfterPollRerun = afterRerun && afterRerun.json && afterRerun.json.host
    ? afterRerun.json.host.clients : undefined;
}

async function scenarioG2() {
  // Stale-response injection while polling. The wrapper captures an OLD /state and /frame body
  // and delivers it ~1.2s later (after a redirect submit committed), then we prove no flash-back.
  await installNetworkHook();
  await setNetworkMode('stale');
  const before = await snapshot();
  const oldAddr = before.gui.addr;

  await submitAddress(fixtureUrl('redirect'));
  const landed = fixtureUrl('second.html') + '?from=redirect#landed';
  const afterRedirect = await expectAligned('G', 'G2 延迟注入旧 /state + /frame 后地址不闪回', landed, { timeoutMs: 6000 });
  if (afterRedirect) {
    const samples = [];
    for (let index = 0; index < 14; index += 1) {
      samples.push(await guiAddr());
      await sleep(100);
    }
    check('G', 'G2 提交后地址稳定在 redirect 最终地址（无旧值闪回）', samples.every((value) => value === landed), landed, samples.filter((value) => value !== landed));
  }
  const hook = await networkHookState();
  const kinds = hook.hits.map((hit) => hit.kind);
  check('G', 'G2 确实延迟注入了 /state 与 /frame 旧响应', kinds.includes('state') && kinds.includes('frame'), { kinds: ['state', 'frame'] }, kinds);

  // Re-edit while the submit response is in flight: the success response must not overwrite it.
  await setNetworkMode('stale');
  await submitAddress(fixtureUrl());
  await waitFor(async () => (await networkHookState()).navSent === true, { timeoutMs: BOUNDED_WAIT_MS, intervalMs: 50, label: 'navigate request sent' });
  const inflightDraft = fixtureUrl('second.html') + '?inflight=1';
  await typeAddress(inflightDraft);
  await sleep(1800);
  const inflight = await guiSnapshot();
  check('G', 'G2 提交 inflight 中重新编辑不被成功响应覆盖', inflight.addr === inflightDraft, inflightDraft, inflight.addr);

  await pressEscape();
  await waitFor(async () => (await guiAddr()) === fixtureUrl(), { timeoutMs: BOUNDED_WAIT_MS, intervalMs: 75, label: 'Escape shows submitted address' });
  const settleSamples = [];
  for (let index = 0; index < 12; index += 1) {
    settleSamples.push(await guiAddr());
    await sleep(100);
  }
  check('G', 'G2 迟到响应不把地址拉回上一个页面', settleSamples.every((value) => value === fixtureUrl()), fixtureUrl(), settleSamples.filter((value) => value !== fixtureUrl()));
  const staleHook = await networkHookState();
  check('G', 'G2 第二个提交同样注入了旧 /state 与 /frame 响应', staleHook.hits.some((hit) => hit.kind === 'state') && staleHook.hits.some((hit) => hit.kind === 'frame'), { state: true, frame: true }, staleHook.hits);
  await setNetworkMode('off');
}

async function scenarioI() {
  // Restore the native WebSocket (blocked in scenario H) before checking WS headers.
  await installNetworkHook();
  for (const identifier of state.cdpScriptIds) {
    try { await state.chrome.cdp.send('Page.removeScriptToEvaluateOnNewDocument', { identifier }); } catch { /* ignore */ }
  }
  state.cdpScriptIds = [];
  await pageEvaluate(`(() => { if (window.__utbNativeWebSocket) window.WebSocket = window.__utbNativeWebSocket; return true; })()`);

  const fakeUrl = fixtureUrl('index.html') + '?token=' + FIXTURE_FAKE_TOKEN + '#secret-' + FIXTURE_FAKE_TOKEN;
  await hostFetch('/navigate', { method: 'POST', body: { url: fakeUrl } });
  const snap = await expectAligned('I', 'I1 authenticated UI 保留完整假 token/hash', fakeUrl, { timeoutMs: 5000 });
  const authenticated = await hostState();
  check('I', 'I1 HTTP ui.address 未脱敏（完整假值）', authenticated.ui && authenticated.ui.address === fakeUrl, fakeUrl, authenticated.ui && authenticated.ui.address);
  const topUrl = String(authenticated.url || '');
  check('I', 'I2 脱敏 state.url 不含假 token', topUrl.indexOf(FIXTURE_FAKE_TOKEN) === -1, 'no fake token', topUrl);
  const toolProjection = { ...authenticated };
  delete toolProjection.ui;
  const toolJson = JSON.stringify(toolProjection);
  check('I', 'I2 browser_state 结构投影（state()，无 ui）JSON 不含假 token', toolJson.indexOf(FIXTURE_FAKE_TOKEN) === -1, 'no fake token', toolJson.slice(0, 300));

  // Unauthenticated /state and /frame must not serve the raw ui projection.
  const unauthState = await hostFetch('/state', { auth: false });
  const unauthStateText = unauthState.text;
  check('I', 'I3 未认证 /state 无 ui/raw 字段', unauthState.status === 200 && !unauthState.json.ui
    && unauthStateText.indexOf(FIXTURE_FAKE_TOKEN) === -1, { status: 200, ui: 'absent', raw: 'absent' },
  { status: unauthState.status, ui: Boolean(unauthState.json.ui), raw: unauthStateText.indexOf(FIXTURE_FAKE_TOKEN) !== -1 });

  const unauthFrame = await hostFetch('/frame?since=0', { auth: false });
  const unauthFrameText = unauthFrame.text;
  check('I', 'I3 未认证 /frame 无 ui/raw 字段', unauthFrame.status === 200
    && !(unauthFrame.json && unauthFrame.json.state && unauthFrame.json.state.ui)
    && unauthFrameText.indexOf(FIXTURE_FAKE_TOKEN) === -1, { status: 200, ui: 'absent', raw: 'absent' },
  { status: unauthFrame.status, ui: Boolean(unauthFrame.json && unauthFrame.json.state && unauthFrame.json.state.ui), raw: unauthFrameText.indexOf(FIXTURE_FAKE_TOKEN) !== -1 });

  // Forged Origin must never receive the raw UI projection. Contract §1 keeps the legacy
  // GET /state compatible (200 with the redacted state), so 200 + no `ui` + no raw is the
  // required fail-closed outcome here; only /reload and /history hard-reject.
  const forgedNoCookie = await hostFetch('/state', { auth: false, headers: { origin: 'http://evil.example' } });
  check('I', 'I4 伪造 Origin（无 cookie）只拿到脱敏 state、无 raw', forgedNoCookie.status === 200
    && !forgedNoCookie.json.ui && forgedNoCookie.text.indexOf(FIXTURE_FAKE_TOKEN) === -1
    && forgedNoCookie.text.indexOf(fakeUrl) === -1, { status: 200, ui: 'absent', raw: 'absent' },
  { status: forgedNoCookie.status, ui: Boolean(forgedNoCookie.json.ui), raw: forgedNoCookie.text.indexOf(FIXTURE_FAKE_TOKEN) !== -1 });
  const forgedWithCookie = await hostFetch('/state', { headers: { origin: 'http://evil.example' } });
  check('I', 'I4 伪造 Origin（带 cookie）同样不返回 raw', forgedWithCookie.status === 200
    && !forgedWithCookie.json.ui && forgedWithCookie.text.indexOf(FIXTURE_FAKE_TOKEN) === -1
    && forgedWithCookie.text.indexOf(fakeUrl) === -1, { status: 200, ui: 'absent', raw: 'absent' },
  { status: forgedWithCookie.status, ui: Boolean(forgedWithCookie.json.ui), raw: forgedWithCookie.text.indexOf(FIXTURE_FAKE_TOKEN) !== -1 });

  // Protected navigation endpoints: fail closed without a cookie, no raw leak in the error body.
  for (const [path, body] of [['/reload', {}], ['/history', { direction: 'back' }]]) {
    const response = await hostFetch(path, { method: 'POST', body, auth: false });
    check('I', `I5 未认证 ${path} 返回 401/403 且无 raw`, [401, 403].includes(response.status)
      && response.text.indexOf(FIXTURE_FAKE_TOKEN) === -1, { status: '401/403', raw: 'absent' }, { status: response.status, raw: response.text.indexOf(FIXTURE_FAKE_TOKEN) !== -1 });
  }

  // /metrics and WebSocket payloads must not carry the raw address.
  const metricsResponse = await hostFetch('/metrics');
  check('I', 'I6 /metrics 响应不含假 token/raw 地址', metricsResponse.text.indexOf(FIXTURE_FAKE_TOKEN) === -1
    && metricsResponse.text.indexOf(fakeUrl) === -1, 'no raw address', sanitize(metricsResponse.text).slice(0, 300));

  await pageEvaluate(`(() => {
    const acc = { opened: false, hello: null, header: null, error: null };
    window.__utbWsEvidence = acc;
    try {
      const ws = new WebSocket('/plugins/ui-testing/frames');
      ws.binaryType = 'arraybuffer';
      ws.onopen = () => { acc.opened = true; };
      ws.onerror = () => { acc.error = 'ws error'; };
      ws.onmessage = (event) => {
        if (typeof event.data === 'string') {
          try { const parsed = JSON.parse(event.data); if (parsed.type === 'hello') acc.hello = parsed; } catch { /* ignore */ }
          return;
        }
        if (!(event.data instanceof ArrayBuffer)) return;
        const bytes = new Uint8Array(event.data);
        if (bytes.length < 8) return;
        const headerLength = (bytes[0] << 24) | (bytes[1] << 16) | (bytes[2] << 8) | bytes[3];
        try { acc.header = JSON.parse(new TextDecoder().decode(bytes.slice(4, 4 + headerLength))); } catch { /* ignore */ }
      };
      acc.ws = ws;
    } catch (error) { acc.error = String(error); }
    return true;
  })()`);
  for (let index = 0; index < 5; index += 1) {
    await targetEval(`(() => { document.body.style.outline = '${index + 2}px solid rgb(20,0,0)'; return true; })()`);
    await sleep(180);
  }
  let wsEvidence;
  try {
    wsEvidence = await waitFor(async () => {
      const value = await pageEvaluate(`window.__utbWsEvidence || null`);
      return value && value.opened && value.hello && value.header ? value : undefined;
    }, { timeoutMs: 10000, intervalMs: 100, label: 'WS evidence' });
  } catch {
    wsEvidence = await pageEvaluate(`window.__utbWsEvidence || null`);
  }
  const wsText = JSON.stringify(wsEvidence || {});
  check('I', 'I6 WS hello 与二进制帧头不含假 token/raw 地址', Boolean(wsEvidence && wsEvidence.hello)
    && wsText.indexOf(FIXTURE_FAKE_TOKEN) === -1 && wsText.indexOf(fakeUrl) === -1, { hello: 'present', raw: 'absent' },
  { opened: wsEvidence && wsEvidence.opened, hello: Boolean(wsEvidence && wsEvidence.hello), header: Boolean(wsEvidence && wsEvidence.header), raw: wsText.indexOf(FIXTURE_FAKE_TOKEN) !== -1 });
}

async function scenarioJ() {
  // Legacy degradation: replace the network responses (strip ui) inside this tab only.
  await installNetworkHook();
  await setNetworkMode('legacy');

  const legacyRaw = fixtureUrl('second.html') + '?token=' + FIXTURE_FAKE_TOKEN + '#legacy';
  await hostFetch('/navigate', { method: 'POST', body: { url: legacyRaw } });
  const expectedRedacted = (await hostState()).url;
  const legacySnap = await waitFor(async () => {
    const gui = await guiSnapshot();
    const host = await hostState();
    return gui.addr === host.url ? { gui, host } : undefined;
  }, { timeoutMs: 5000, intervalMs: 75, label: 'legacy address from redacted state.url' });
  check('J', 'J1 legacy 地址显示脱敏 remote.url', legacySnap.gui.addr === legacySnap.host.url && legacySnap.gui.addr !== legacyRaw, expectedRedacted, legacySnap.gui.addr);
  check('J', 'J1 legacy 脱敏地址含 ***（token/hash 被遮蔽）', String(legacySnap.gui.addr).indexOf('***') !== -1, '*** present', legacySnap.gui.addr);
  check('J', 'J1 legacy 三个导航按钮禁用', legacySnap.gui.disabled.back === true && legacySnap.gui.disabled.forward === true
    && legacySnap.gui.disabled.reload === true, { back: true, forward: true, reload: true }, legacySnap.gui.disabled);

  // Explicit navigation still works in legacy mode (ensure → viewport → navigate).
  await submitAddress(fixtureUrl('index.html'));
  await waitFor(async () => (await targetInfo()).href === fixtureUrl('index.html'), { timeoutMs: 5000, intervalMs: 75, label: 'legacy explicit navigation' });
  const legacyNav = await waitFor(async () => {
    const gui = await guiSnapshot();
    const host = await hostState();
    return gui.addr === host.url ? { gui, host } : undefined;
  }, { timeoutMs: 5000, intervalMs: 75, label: 'legacy address after navigation' });
  check('J', 'J2 legacy 显式新导航仍可用且地址同步脱敏 URL', legacyNav.gui.addr === legacyNav.host.url
    && legacyNav.host.url === fixtureUrl('index.html'), fixtureUrl('index.html'), { addr: legacyNav.gui.addr, stateUrl: legacyNav.host.url });
  const afterExplicit = await networkHookState();
  check('J', 'J2 legacy 模式不请求新端点 /reload 或 /history', afterExplicit.protectedRequests.length === 0, [], afterExplicit.protectedRequests);

  // Close + reopen the target: old history must not come back, no late raw address.
  const samples = [];
  await hostFetch('/close', { method: 'POST', body: {} });
  await waitFor(async () => (await hostState()).running === false, { timeoutMs: BOUNDED_WAIT_MS, intervalMs: 100, label: 'legacy close' });
  await waitFor(async () => (await guiAddr()) === '', { timeoutMs: BOUNDED_WAIT_MS, intervalMs: 75, label: 'legacy address cleared' });
  for (let index = 0; index < 8; index += 1) {
    samples.push(await guiAddr());
    await sleep(100);
  }
  check('J', 'J3 legacy 关闭后地址清空（旧 history 不复活）', samples.every((value) => value === ''), '', samples);
  const closedButtons = await guiSnapshot();
  check('J', 'J3 legacy 关闭后三按钮禁用', closedButtons.disabled.back === true && closedButtons.disabled.forward === true
    && closedButtons.disabled.reload === true, { back: true, forward: true, reload: true }, closedButtons.disabled);

  await hostFetch('/navigate', { method: 'POST', body: { url: fixtureUrl('index.html') } });
  const reopened = await waitFor(async () => {
    const gui = await guiSnapshot();
    const host = await hostState();
    return gui.addr === host.url && host.url === fixtureUrl('index.html') ? { gui, host } : undefined;
  }, { timeoutMs: 5000, intervalMs: 75, label: 'legacy reopened' });
  check('J', 'J3 legacy 重开后无迟到 raw 地址复活', reopened.gui.addr.indexOf(FIXTURE_FAKE_TOKEN) === -1 && !samples.includes(legacyRaw), 'no raw legacy address', reopened.gui.addr);

  // Restore v1 and prove automatic upgrade: raw address + enabled buttons + fresh history.
  await setNetworkMode('off');
  const upgraded = await waitFor(async () => {
    const snap = await snapshot();
    return snap.ui && snap.ui.address === fixtureUrl('index.html') && snap.gui.addr === fixtureUrl('index.html')
      && snap.history && snap.history.available === true && buttonsMatch(snap).match ? snap : undefined;
  }, { timeoutMs: 5000, intervalMs: 75, label: 'v1 upgrade after legacy' });
  check('J', 'J4 恢复 v1 响应后自动升级：地址为未脱敏真实地址', upgraded.ui.address === fixtureUrl('index.html'), fixtureUrl('index.html'), upgraded.ui.address);
  check('J', 'J4 新浏览器 history 已重置（无旧 history 复活）', upgraded.history.available === true
    && upgraded.history.index <= 1 && upgraded.history.length <= 2, { index: '<=1', length: '<=2' }, upgraded.history);
  check('J', 'J4 刷新按钮恢复可用', upgraded.gui.disabled.reload === false, false, upgraded.gui.disabled.reload);
}

async function scenarioK() {
  await hostFetch('/navigate', { method: 'POST', body: { url: fixtureUrl() } });
  await expectAligned('K', 'K0 复位到首页', fixtureUrl());
  const base = await awaitHistorySettled('K', 'K0 复位后历史稳定');
  if (!base) return;

  // Invalid direction: INVALID_ARGUMENT, zero dispatch.
  const invalid = await hostFetch('/history', { method: 'POST', body: { direction: 'sideways' } });
  const afterInvalid = await snapshot();
  check('K', 'K1 /history 非法 direction 返回 500 INVALID_ARGUMENT', invalid.status === 500
    && invalid.json?.ok === false && invalid.json?.code === 'INVALID_ARGUMENT', { status: 500, code: 'INVALID_ARGUMENT' }, { status: invalid.status, body: invalid.json });
  check('K', 'K1 非法 direction 零派发（URL/历史不变）', afterInvalid.href === fixtureUrl()
    && afterInvalid.history.index === base.history.index, { href: fixtureUrl(), index: base.history.index }, { href: afterInvalid.href, index: afterInvalid.history.index });

  // Out-of-bounds back/forward: moved:false and no dispatch.
  let backResult;
  for (let index = 0; index < 10; index += 1) {
    backResult = await hostFetch('/history', { method: 'POST', body: { direction: 'back' } });
    if (!backResult.json || backResult.json.moved !== true) break;
    await sleep(120);
  }
  const atStart = await snapshot();
  const outBack = await hostFetch('/history', { method: 'POST', body: { direction: 'back' } });
  const afterOutBack = await snapshot();
  check('K', 'K2 越界后退 moved:false 且零派发', outBack.status === 200 && outBack.json?.ok === true
    && outBack.json?.moved === false, { status: 200, moved: false }, { status: outBack.status, body: outBack.json });
  check('K', 'K2 越界后退后 URL/历史不变', afterOutBack.href === atStart.href && afterOutBack.history.index === atStart.history.index, { href: atStart.href, index: atStart.history.index }, { href: afterOutBack.href, index: afterOutBack.history.index });

  // Sub-frame same-document events must not pollute the main address.
  await hostFetch('/navigate', { method: 'POST', body: { url: fixtureUrl() } });
  await expectAligned('K', 'K3 复位到首页', fixtureUrl());
  const frameResult = await targetEval(`(async () => {
    const frame = document.createElement('iframe');
    frame.id = 'utb-child-frame';
    frame.src = '/second.html';
    document.body.append(frame);
    await new Promise((resolve) => { frame.onload = resolve; setTimeout(resolve, 2500); });
    try { frame.contentWindow.history.pushState({ child: true }, '', '?iframe=1'); } catch (error) { return { error: String(error) }; }
    return { src: frame.contentWindow.location.href };
  })()`);
  await sleep(600);
  const mainAfter = await snapshot();
  check('K', 'K3 子 frame same-document 事件不污染主地址', mainAfter.ui.address === fixtureUrl()
    && mainAfter.gui.addr === fixtureUrl() && mainAfter.href === fixtureUrl(), { main: fixtureUrl() }, { ui: mainAfter.ui.address, addr: mainAfter.gui.addr, href: mainAfter.href });
  check('K', 'K3 子 frame history 只在子 frame 内变化', Boolean(frameResult && frameResult.src && String(frameResult.src).indexOf('iframe=1') !== -1), 'child ?iframe=1', frameResult);
  await targetEval(`(() => { const frame = document.getElementById('utb-child-frame'); if (frame) frame.remove(); return true; })()`);
}

/* ------------------------------------------------------------------------------------------------
 * Development-only flake reproduction for the first panel submit after a GUI reload
 * (ADDRESS_HISTORY_REPRO_B1=<n>). It exercises exactly the A2 → B1 sequence repeatedly and dumps a
 * page-side event log (focus/input/submit ticks + the React controlled value) so the failure mode
 * can be explained instead of masked by a retry.
 * ---------------------------------------------------------------------------------------------- */
const ADDRESS_PROBE_SOURCE = `(() => {
  if (window.__utbAddrLog) return true;
  const log = window.__utbAddrLog = { events: [] };
  const controlled = (el) => {
    if (!el) return null;
    const key = Object.keys(el).find((name) => name.startsWith('__reactProps$'));
    return key ? el[key].value : null;
  };
  const rec = (type, extra) => log.events.push(Object.assign({ t: Date.now(), type }, extra || {}));
  document.addEventListener('focusin', (event) => {
    if (event.target && event.target.classList && event.target.classList.contains('utb-addr')) {
      window.__utbFocusCount = (window.__utbFocusCount || 0) + 1;
      rec('focusin', { active: document.activeElement === event.target });
    }
  }, true);
  document.addEventListener('focusout', (event) => {
    if (event.target && event.target.classList && event.target.classList.contains('utb-addr')) {
      rec('focusout', { related: event.relatedTarget ? (event.relatedTarget.className || event.relatedTarget.tagName) : null });
    }
  }, true);
  document.addEventListener('input', (event) => {
    if (event.target && event.target.classList && event.target.classList.contains('utb-addr')) {
      rec('input', { dom: event.target.value, react: controlled(event.target) });
    }
  }, true);
  document.addEventListener('submit', (event) => {
    const el = document.querySelector('.utb-addr');
    rec('submit', { dom: el ? el.value : null, react: controlled(el), formClass: event.target && event.target.className });
  }, true);
  const tick = () => {
    const el = document.querySelector('.utb-addr');
    if (!el) { rec('tick', { present: false }); return; }
    if (!window.__utbAddrNode) window.__utbAddrNode = el;
    rec('tick', {
      dom: el.value,
      react: controlled(el),
      focused: document.activeElement === el,
      active: document.activeElement ? (document.activeElement.className || document.activeElement.tagName) : null,
      sameNode: window.__utbAddrNode === el,
    });
  };
  window.__utbAddrTick = setInterval(tick, 50);
  return true;
})()`;

async function reproB1(iterations) {
  const results = [];
  state.reproResults = results;
  for (let attempt = 1; attempt <= iterations; attempt += 1) {
    await hostFetch('/close', { method: 'POST', body: {} });
    await waitFor(async () => (await hostState()).running === false, { timeoutMs: BOUNDED_WAIT_MS, intervalMs: 100, label: 'repro close' });
    await hostFetch('/navigate', { method: 'POST', body: { url: fixtureUrl() } });
    await reloadGui();
    await openPanel();
    await waitFor(async () => {
      const snap = await snapshot();
      return snap.ui && snap.ui.address === fixtureUrl() && snap.gui.addr === fixtureUrl() ? snap : undefined;
    }, { timeoutMs: 5000, intervalMs: 75, label: 'repro A2 aligned' });
    await pageEvaluate(ADDRESS_PROBE_SOURCE);
    await pageEvaluate(`window.__utbAddrLog.events.length = 0; window.__utbAddrNode = null; true`);
    const started = Date.now();
    const before = await addressSyncState();
    await typeAddress(fixtureUrl('second.html'));
    const preEnter = await addressSyncState();
    const submitSeenBefore = await pageEvaluate(`window.__utbSubmitSeen || 0`);
    await pressEnter();
    await sleep(1800);
    const postEnter = await addressSyncState();
    const info = await targetInfo();
    const submitSeenAfter = await pageEvaluate(`window.__utbSubmitSeen || 0`);
    const events = await pageEvaluate(`window.__utbAddrLog ? window.__utbAddrLog.events.slice(-120) : []`);
    const navs = state.navigateRequests.filter((entry) => entry.at >= started && entry.path.startsWith('/navigate'))
      .map((entry) => ({ url: entry.url, atMs: entry.at - started }));
    const ok = info.href === fixtureUrl('second.html');
    results.push({ attempt, ok, before, preEnter, postEnter, href: info.href, submitSeenBefore, submitSeenAfter, navs, events });
    log(`[repro ${attempt}] ${ok ? 'PASS' : 'FAIL'} href=${info.href} preEnter=${sanitize(fmt(preEnter))} submitSeen=${submitSeenBefore}->${submitSeenAfter} navs=${sanitize(fmt(navs))}`);
    if (!ok) {
      log(`[repro ${attempt}] event log:`);
      for (const event of events) log('  ' + JSON.stringify(event));
      break;
    }
  }
  const failed = results.filter((entry) => !entry.ok).length;
  check('REPRO', `B1 flake reproduction: ${results.length - failed}/${results.length} iterations navigated to second.html`, failed === 0, 'all iterations pass', results.map((entry) => ({ attempt: entry.attempt, ok: entry.ok, href: entry.href })));
  return failed === 0;
}

async function reproG1(iterations) {
  const results = [];
  state.reproResults = results;
  for (let attempt = 1; attempt <= iterations; attempt += 1) {
    await hostFetch('/close', { method: 'POST', body: {} });
    await waitFor(async () => (await hostState()).running === false, { timeoutMs: BOUNDED_WAIT_MS, intervalMs: 100, label: 'reproG1 close' });
    await hostFetch('/navigate', { method: 'POST', body: { url: fixtureUrl('second.html') } });
    await waitFor(async () => {
      const snap = await snapshot();
      return snap.ui && snap.ui.address === fixtureUrl('second.html') && snap.gui.addr === fixtureUrl('second.html') ? snap : undefined;
    }, { timeoutMs: 5000, intervalMs: 75, label: 'reproG1 aligned' });
    await pageEvaluate(ADDRESS_PROBE_SOURCE);
    await pageEvaluate(`window.__utbAddrLog.events.length = 0; true`);
    const draft = fixtureUrl('second.html') + '?draft=1#draft';
    await typeAddress(draft);
    await sleep(1800);
    const typed = await addressSyncState();
    await targetEval(`(() => { location.href = '/index.html'; return true; })()`);
    await waitFor(async () => (await targetInfo()).href === fixtureUrl('index.html'), { timeoutMs: 5000, intervalMs: 75, label: 'reproG1 autonomous navigation' });
    await sleep(900);
    const beforeBlur = await addressSyncState();
    const acceptedBeforeBlur = (await hostState()).ui ? (await hostState()).ui.address : null;
    await dismissShellDialogs();
    const focused = await addressSyncState();
    if (focused && focused.focused) await addressBlur();
    const samples = [];
    let restored = false;
    for (let index = 0; index < 30; index += 1) {
      const value = await guiAddr();
      samples.push(value);
      if (value === fixtureUrl('index.html')) { restored = true; break; }
      await sleep(100);
    }
    const hostUi = (await hostState()).ui ? (await hostState()).ui.address : null;
    const events = await pageEvaluate(`(window.__utbAddrLog ? window.__utbAddrLog.events.filter((event) => ['focusin', 'focusout', 'input'].includes(event.type)) : []).slice(-16)`);
    results.push({ attempt, restored, typed, beforeBlur, focused, acceptedBeforeBlur, hostUi, samples: samples.slice(-6), events });
    log(`[reproG1 ${attempt}] ${restored ? 'PASS' : 'FAIL'} typed=${sanitize(fmt(typed))} focusedBeforeBlur=${sanitize(fmt(beforeBlur))} accepted=${acceptedBeforeBlur} hostUi=${hostUi} samples=${sanitize(fmt(samples.slice(-4)))}`);
    if (!restored) {
      log(`[reproG1 ${attempt}] events: ${sanitize(fmt(events))}`);
      break;
    }
  }
  const failed = results.filter((entry) => !entry.restored).length;
  check('REPRO', `G1 blur flake reproduction: ${results.length - failed}/${results.length} iterations restored the accepted address`, failed === 0, 'all iterations pass', results.map((entry) => ({ attempt: entry.attempt, restored: entry.restored })));
  return failed === 0;
}

/* ------------------------------------------------------------------------------------------------
 * Main.
 * ---------------------------------------------------------------------------------------------- */
function buildProbe() {
  const info = {};
  try {
    // Listener identity (pid only; argv/env are never copied).
    const output = execFileSync('ss', ['-ltnp', 'sport = :3081'], { encoding: 'utf8', timeout: 3000 });
    const match = /pid=(\d+)/.exec(output);
    info.serverPid = match ? Number(match[1]) : null;
    if (info.serverPid) {
      try {
        const cmdline = execFileSync('tr', ['\\0', ' ', '/proc/' + info.serverPid + '/cmdline'], { encoding: 'utf8', timeout: 3000 });
        info.serverCommand = cmdline.replace(/token=\S+/g, 'token=[REDACTED]').slice(0, 200);
      } catch { /* ignore */ }
      try {
        // Approximate process start time: /proc/<pid>/stat field 22 (clock ticks) + /proc/stat btime.
        const statText = execFileSync('cat', ['/proc/' + info.serverPid + '/stat'], { encoding: 'utf8', timeout: 3000 });
        const fields = statText.slice(statText.lastIndexOf(')') + 2).split(' ');
        const startTicks = Number(fields[19]);
        const procStat = execFileSync('cat', ['/proc/stat'], { encoding: 'utf8', timeout: 3000 });
        const btimeLine = procStat.split('\n').find((line) => line.startsWith('btime '));
        const btimeSeconds = btimeLine ? Number(btimeLine.split(/\s+/)[1]) : 0;
        if (Number.isFinite(startTicks) && btimeSeconds > 0) {
          info.startedAt = new Date((btimeSeconds + startTicks / 100) * 1000).toISOString();
        }
      } catch { /* ignore */ }
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
  return {
    indexJs,
    clientJs,
    loadedBuildMatchesWorkspace: Object.keys(editedAfterStart).length === 0,
    loadedBuildNote: Object.keys(editedAfterStart).length
      ? 'WARNING: workspace source changed after the 3081 listener started; the run exercises the build loaded at restart, NOT these on-disk edits.'
      : 'On-disk source mtimes are older than the listener start: the running build matches the workspace files.',
    editedAfterStart,
  };
}

async function loadToken() {
  const text = await readFile(LOG_PATH, 'utf8');
  const matches = [...text.matchAll(/http:\/\/(?:127\.0\.0\.1|localhost):3081\/\?token=[A-Za-z0-9_-]+/g)];
  if (!matches.length) throw new Error(`no 3081 launch URL in ${LOG_PATH}`);
  const url = matches[matches.length - 1][0];
  const token = /[?&]token=([A-Za-z0-9_-]+)/.exec(url)[1];
  return { url, token };
}

async function authenticate(launchUrl) {
  const response = await fetch(launchUrl, { redirect: 'manual', signal: AbortSignal.timeout(15000) });
  const setCookies = response.headers.getSetCookie();
  const cookie = setCookies.map((value) => value.split(';')[0]).join('; ');
  if (!cookie) throw new Error(`launch URL did not issue a cookie (status ${response.status})`);
  return cookie;
}

async function main() {
  await mkdir(RUN_DIR, { recursive: true });
  if (!existsSync(CHROME_BIN)) throw new Error(`Chromium wrapper/binary not found: ${CHROME_BIN}`);
  state.hostInfo = buildProbe();
  state.buildInfo = await buildState();
  log(`[env] 3081 listener pid: ${state.hostInfo.serverPid ?? 'unknown'}`);
  log(`[env] build fingerprint index.js=${state.buildInfo.indexJs ? state.buildInfo.indexJs.sha256 : 'n/a'} client.js=${state.buildInfo.clientJs ? state.buildInfo.clientJs.sha256 : 'n/a'}`);
  const { startFixtureServer } = await import(pathToFileURL(join(REPO_ROOT, 'tests/ui_test_fixture/server.mjs')).href);
  state.fixture = await startFixtureServer();
  log(`[env] GUI base: ${GUI_BASE} (3081 evidence: ${guiUrl.port === '3081'})`);
  log(`[env] fixture: ${state.fixture.url}`);

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

  // Open the debug panel through the real shell: 更多 → 调试视图 → .utb.
  let panelOpened = false;
  try {
    await openPanel();
    panelOpened = true;
  } catch (error) {
    check('GUI', 'G3 更多 → 调试视图 opens .utb panel', false, { panel: true }, sanitize(errorMessage(error)));
  }
  if (panelOpened) {
    const panel = await guiSnapshot();
    check('GUI', 'G3 更多 → 调试视图 opens .utb panel', panel.panel === true, true, panel.panel);
    check('GUI', 'G3 .utb-addr address input present', panel.addr !== null, { addr: 'string' }, { addr: panel.addr });
  }

  // Preflight: the host must already expose the v1 UI projection. Otherwise this run would
  // silently test the old host and must not be reported as a pass.
  const preflight = await hostState();
  if (!preflight.ui || preflight.ui.version !== 1) {
    check('GUI', 'G2 host exposes ui.version=1 (restarted with new Host)', false, { uiVersion: 1 }, { ui: preflight.ui || null, note: '3081 likely still runs the old Host: restart it before running this acceptance' });
    throw new Error('3081 does not expose ui.version=1; old Host still loaded — restart 3081 first');
  }
  check('GUI', 'G2 host exposes ui.version=1', preflight.ui.version === 1, 1, preflight.ui.version);

  if (process.env.ADDRESS_HISTORY_REPRO_B1) {
    const iterations = Math.max(1, Number(process.env.ADDRESS_HISTORY_REPRO_B1) || 1);
    await reproB1(iterations);
    return;
  }
  if (process.env.ADDRESS_HISTORY_REPRO_G1) {
    const iterations = Math.max(1, Number(process.env.ADDRESS_HISTORY_REPRO_G1) || 1);
    await reproG1(iterations);
    return;
  }

  await scenario('A', scenarioA);
  await scenario('B', scenarioB);
  await scenario('C', scenarioC);
  await scenario('D', scenarioD);
  await scenario('E', scenarioE);
  await scenario('F', scenarioF);
  await scenario('G1', scenarioG1);
  await scenario('H', scenarioH);
  await scenario('G2', scenarioG2);
  await scenario('I', scenarioI);
  await scenario('J', scenarioJ);
  await scenario('K', scenarioK);
  try {
    const finalMetrics = await hostFetch('/metrics');
    state.observations = state.observations || {};
    state.observations.hostClientsAtEnd = finalMetrics.json && finalMetrics.json.host
      ? finalMetrics.json.host.clients : undefined;
  } catch { /* ignore */ }
}

const watchdog = setTimeout(async () => {
  log(`\n[watchdog] hard timeout ${TOTAL_TIMEOUT_MS}ms`);
  try { await cleanup('hard-timeout'); } catch { /* ignore */ }
  process.exit(2);
}, TOTAL_TIMEOUT_MS);
watchdog.unref?.();

async function cleanup(reason) {
  log(`\n[cleanup] ${reason}`);
  try {
    // ADDRESS_HISTORY_SKIP_CLOSE is a development-only escape hatch used to smoke-test the
    // harness while 3081 still runs the old Host; the real acceptance run always closes.
    if (state.cookie && process.env.ADDRESS_HISTORY_SKIP_CLOSE !== '1') {
      await hostFetch('/close', { method: 'POST', body: {}, timeoutMs: 5000 });
    }
  } catch { /* ignore */ }
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
  const report = {
    schemaVersion: 1,
    suite: 'dsh-agent-team-ui-testing/address-history-3081',
    generatedAt: new Date().toISOString(),
    environment: {
      guiBase: GUI_BASE,
      is3081: guiUrl.port === '3081',
      guiOrigin: guiUrl.origin,
      tokenLogPath: LOG_PATH,
      host: state.hostInfo || null,
      build: state.buildInfo || null,
      addressSyncMiss: state.addressSyncMiss || 0,
      enterFallback: state.enterFallback || 0,
      focusStealRetries: state.focusStealRetries || 0,
      submitRecoveries: state.submitRecoveries || 0,
      dialogsDismissed: state.dialogsDismissed || 0,
      lastDismissedDialogs: state.lastDismissedDialogs || null,
      lastFocusSteal: state.lastFocusSteal || null,
      blurWithoutFocus: state.blurWithoutFocus || 0,
      g1: state.g1 || null,
      lastSubmitted: state.lastSubmitted || null,
      lastAddressState: state.lastAddressState || null,
      navigateRequests: state.navigateRequests.map((entry) => ({ path: entry.path, method: entry.method, url: entry.url })),
      webSocketEvents: state.wsEvents.map((entry) => ({ path: entry.url.replace(/^ws:\/\/[^/]+/, 'ws://[host]'), at: entry.at, document: entry.document })),
      fixtureUrl: state.fixture ? state.fixture.url : undefined,
      chromeBin: CHROME_BIN,
      node: process.version,
      platform: `${process.platform}/${process.arch}`,
      usedNativeValueSetter: state.usedNativeValueSetter || 0,
      interactions: 'GUI 交互使用 DOM 级 click/focus + CDP 可信按键输入（无头环境规避遮罩落点）；目标页面点击使用真实 /eval 坐标 + /input 原生事件。',
      note: 'GUI token 与 browser-session cookie 只在本进程内存；报告/日志已脱敏。3080 未被操作。fixture 假 token 为固定测试值，不是真实凭据。',
    },
    fatal: fatal ? sanitize(errorMessage(fatal)) : undefined,
    scenarios: Object.fromEntries(Object.entries(byScenario).map(([name, value]) => [name, { ...value, passed: value.failed === 0 }])),
    observations: state.observations || {},
    repro: state.reproResults || undefined,
    trace: state.trace,
    checks,
    summary: {
      checks: checks.length,
      passed: checks.length - failed.length,
      failed: failed.length,
      failedScenarios: Object.entries(byScenario).filter(([, value]) => value.failed > 0).map(([name]) => name),
      exitCode: fatal ? 2 : failed.length ? 1 : 0,
    },
    notCovered: [
      'browser_state 工具返回 JSON 本身（HTTP 表面无法调用 Agent 工具）：本脚本断言等价的脱敏 state() 投影，真实工具 JSON 由 tests/acceptance/run.mjs P6 覆盖',
      'provider 图像可见性、面板像素/视觉（视觉已冻结，不在本任务）',
      '非 3081 实例（3080 未操作、未重启）',
    ],
  };
  return report;
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
  log(`\naddress-history-3081: ${checks.length - failed.length}/${checks.length} checks, ${failed.length} failed, exit=${report.summary.exitCode}`);
  log('Report: ' + RUN_DIR + '/report.json');
}
process.exitCode = exitCode;
