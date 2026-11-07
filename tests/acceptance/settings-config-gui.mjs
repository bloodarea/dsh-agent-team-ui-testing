#!/usr/bin/env node
/**
 * M5 independent acceptance — settings page, page side (A07/A13, and the UI half of A10).
 *
 * Boots a *private* isolated DSH instance (temporary DSH_HOME copied from the user's web profile,
 * random loopback port that is never 3080/3081, `--no-open`) and drives it with a separate
 * headless Chromium over CDP. The user's running instance on 3080/3081 is never touched.
 *
 * The launch token is read from the instance's stdout into memory only: it is never written to
 * the log, the report or a screenshot URL. Every log line and report field is token-redacted.
 *
 * What is asserted (docs/internal/cross-environment-foundation-plan.md §8):
 *   A07  persistence: [data-uts-config-revision] is numeric, toggling the Chrome environment
 *        sends PUT /plugins/ui-testing/config and the revision increases; a page reload keeps
 *        both the revision and the switch state (the Host revision, not component state, is the
 *        truth). The switch is restored afterwards.
 *   A13  readiness truth: ten environment groups render collapsed by default; expanding Web
 *        shows the six independent axis nodes (support/enabled/dependency/connection/target/
 *        capability) each with its own data-uts-status; the Chrome card shows no hardcoded
 *        version.
 *   NOT_RUN: the 404-degradation variant (point the route prefix at a missing path) cannot be
 *        produced from a booted instance without editing the served bundle; recorded as NOT_RUN
 *        instead of pretending it passed.
 *
 * Evidence: tests/acceptance/runs/settings-config-gui-<stamp>/
 *   report.json, run.log, settings-page.png, settings-page-expanded.png, settings-page-after-reload.png
 *
 * Exit codes: 0 every check passed (NOT_RUN allowed), 1 assertion failure, 2 fatal / BLOCKED
 *             (isolated GUI could not be started; report states the concrete reason and the
 *             Host-level substitute evidence in tests/acceptance/runs/cross-environment-*).
 */
import { spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import { createServer as createNetServer } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const RUN_STAMP = new Date().toISOString().replace(/[:.]/g, '-');
const RUN_DIR = join(HERE, 'runs', `settings-config-gui-${RUN_STAMP}-${process.pid}`);
const DEFAULT_PROFILE = join(process.env.HOME || '', '.dsh', 'profiles', 'web');
const DSH_BIN = process.env.DSH_BIN || 'dsh';
const CHROME = process.env.DSH_ACCEPTANCE_CHROME || process.env.DSH_REAL_BROWSER_CHROME || join(HERE, 'chrome-wrapper.sh');
const HOST_ROUTE = '/plugins/ui-testing';

const logLines = [];
const log = (line = '') => {
  const text = redact(String(line));
  logLines.push(text);
  console.log(text);
};
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const checks = [];
const notRuns = [];
const observations = {};
const screenshots = [];

/** Remove any launch token / query credential from text before it reaches a log or report. */
function redact(text) {
  return String(text)
    .replace(/([?&]token=)[^&\s"']+/gi, '$1[redacted]')
    .replace(/(["']?token["']?\s*[:=]\s*["'])[^"']+(["'])/gi, '$1[redacted]$2');
}
function check(label, pass, expected, actual, extra) {
  const entry = { label, pass: Boolean(pass), expected, actual };
  if (extra !== undefined) entry.extra = extra;
  checks.push(entry);
  log(`${pass ? 'PASS' : 'FAIL'} ${label}`);
  if (!pass) log('  expected=' + JSON.stringify(expected) + ' actual=' + JSON.stringify(actual));
  return Boolean(pass);
}
function notRun(label, reason) {
  notRuns.push({ label, reason: String(reason) });
  log(`NOT_RUN ${label} — ${reason}`);
}
function sha256(text) {
  return createHash('sha256').update(String(text)).digest('hex');
}
function waitFor(fn, { timeoutMs = 30000, intervalMs = 150, label = 'condition' } = {}) {
  return new Promise((resolve, reject) => {
    const started = Date.now();
    const tick = async () => {
      let value;
      try { value = await fn(); } catch { value = undefined; }
      if (value) return resolve(value);
      if (Date.now() - started > timeoutMs) return reject(new Error('timeout: ' + label));
      setTimeout(tick, intervalMs);
    };
    tick();
  });
}
async function pickPort() {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const port = await new Promise((resolve, reject) => {
      const server = createNetServer();
      server.once('error', reject);
      server.listen(0, '127.0.0.1', () => {
        const assigned = server.address().port;
        server.close(() => resolve(assigned));
      });
    });
    if (port !== 3080 && port !== 3081) return port;
  }
  throw new Error('could not allocate a non-3080/3081 loopback port');
}

/* ------------------------------------------------------------------------------------------------
 * CDP client (same minimal transport as the other GUI acceptance suites).
 * ---------------------------------------------------------------------------------------------- */
class Cdp {
  constructor(url) {
    this.url = url;
    this.id = 0;
    this.pending = new Map();
    this.listeners = new Set();
  }
  connect() {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(this.url);
      this.ws = ws;
      ws.onopen = () => resolve(this);
      ws.onerror = () => reject(new Error('CDP websocket open failed'));
      ws.onmessage = (event) => {
        const message = JSON.parse(String(event.data));
        if (message.id) {
          const entry = this.pending.get(message.id);
          if (!entry) return;
          this.pending.delete(message.id);
          if (message.error) entry.reject(new Error(message.error.message));
          else entry.resolve(message.result);
          return;
        }
        for (const listener of this.listeners) listener(message);
      };
    });
  }
  send(method, params = {}, timeoutMs = 30000) {
    const id = ++this.id;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.ws.send(JSON.stringify({ id, method, params }));
      setTimeout(() => {
        if (this.pending.delete(id)) reject(new Error('CDP timeout ' + method));
      }, timeoutMs);
    });
  }
  on(listener) {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
  close() {
    try { this.ws.close(); } catch { /* ignore */ }
  }
}

const state = {
  chrome: null,
  dsh: null,
  token: '',
  requests: [],
  consoleErrors: [],
  pageExceptions: [],
  settingsOpenedVia: '',
};

async function launchChrome() {
  const profileDir = await mkdtemp(join(tmpdir(), 'dsh-settings-gui-chrome-'));
  const proc = spawn(CHROME, [
    '--headless=new',
    '--remote-debugging-port=0',
    `--user-data-dir=${profileDir}`,
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-gpu',
    '--hide-scrollbars',
    '--window-size=1600,1000',
    'about:blank',
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
    }, { timeoutMs: 20000, label: 'Chrome DevToolsActivePort' });
    const targets = await fetch(`http://127.0.0.1:${devtoolsPort}/json/list`).then((response) => response.json());
    const page = targets.find((target) => target.type === 'page');
    if (!page) throw new Error('no page target in the GUI Chromium');
    const cdp = new Cdp(page.webSocketDebuggerUrl);
    await cdp.connect();
    await cdp.send('Page.enable');
    await cdp.send('Runtime.enable');
    await cdp.send('Network.enable');
    cdp.on((message) => {
      if (message.method === 'Network.requestWillBeSent') {
        const request = message.params.request || {};
        state.requests.push({ at: Date.now(), url: redact(String(request.url || '')), method: String(request.method || ''), postData: String(request.postData || '') });
      }
      if (message.method === 'Runtime.exceptionThrown') {
        const details = message.params.exceptionDetails || {};
        state.pageExceptions.push(String((details.exception && details.exception.description) || details.text).slice(0, 400));
      }
      if (message.method === 'Runtime.consoleAPICalled' && message.params.type === 'error') {
        state.consoleErrors.push(message.params.args.map((arg) => arg.value ?? arg.description).join(' ').slice(0, 400));
      }
    });
    state.chrome = { proc, profileDir, devtoolsPort, cdp, stderrTail: () => stderr };
    return state.chrome;
  } catch (error) {
    try { proc.kill('SIGKILL'); } catch { /* ignore */ }
    await rm(profileDir, { recursive: true, force: true }).catch(() => {});
    throw error;
  }
}

async function prepareDshHome() {
  const home = await mkdtemp(join(tmpdir(), 'dsh-settings-gui-home-'));
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
      DSH_UI_TESTING_CHROME: process.env.DSH_UI_TESTING_CHROME || CHROME,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '';
  proc.stdout.on('data', (chunk) => { output += String(chunk); });
  proc.stderr.on('data', (chunk) => { output += String(chunk); });
  proc.on('exit', (code, signal) => log(`[dsh] exited code=${code} signal=${signal}`));
  const pattern = new RegExp(`dsh web: (http://127\\.0\\.0\\.1:${port}/\\?token=([A-Za-z0-9_-]+))`);
  const matched = await waitFor(() => {
    const hit = pattern.exec(output);
    return hit ? { url: hit[1], token: hit[2] } : undefined;
  }, { timeoutMs: 150000, intervalMs: 250, label: 'isolated dsh launch URL' });
  state.token = matched.token;
  state.dsh = { proc, home, profileDir, copied, port, base: `http://127.0.0.1:${port}`, launchUrl: matched.url, output: () => output };
  await waitFor(async () => {
    try {
      const response = await fetch(state.dsh.base + '/', { signal: AbortSignal.timeout(3000) });
      return response.status < 500;
    } catch { return false; }
  }, { timeoutMs: 60000, intervalMs: 400, label: 'isolated dsh HTTP listener' });
  return state.dsh;
}

async function authenticate(launchUrl) {
  const response = await fetch(launchUrl, { redirect: 'manual', signal: AbortSignal.timeout(20000) });
  const cookies = response.headers.getSetCookie().map((value) => value.split(';')[0]);
  if (!cookies.length) throw new Error(`launch URL did not issue a cookie (status ${response.status})`);
  for (const cookie of cookies) {
    const eq = cookie.indexOf('=');
    if (eq <= 0) continue;
    await state.chrome.cdp.send('Network.setCookie', {
      name: cookie.slice(0, eq),
      value: cookie.slice(eq + 1),
      url: new URL(state.dsh.base).origin + '/',
    });
  }
  return cookies.length;
}

async function evaluate(expression, { timeoutMs = 20000 } = {}) {
  const result = await state.chrome.cdp.send('Runtime.evaluate', {
    expression,
    returnByValue: true,
    awaitPromise: true,
    userGesture: true,
  }, timeoutMs);
  if (result.exceptionDetails) {
    const text = result.exceptionDetails.exception && result.exceptionDetails.exception.description
      ? result.exceptionDetails.exception.description
      : result.exceptionDetails.text;
    throw new Error('page evaluation failed: ' + String(text).slice(0, 500));
  }
  return result.result ? result.result.value : undefined;
}

async function guiReady(timeoutMs = 60000) {
  return waitFor(async () => {
    const info = await evaluate(`({
      ready: document.readyState,
      boot: !!window.__DSH_BOOT__,
      root: !!(document.querySelector('#root') && document.querySelector('#root').children.length),
    })`);
    return info && info.ready === 'complete' && info.boot && info.root ? info : undefined;
  }, { timeoutMs, intervalMs: 200, label: 'GUI shell ready' });
}

async function capture(name) {
  const shot = await state.chrome.cdp.send('Page.captureScreenshot', { format: 'png' });
  const file = join(RUN_DIR, name);
  await writeFile(file, Buffer.from(shot.data, 'base64'));
  screenshots.push({ name, file, sha256: sha256(Buffer.from(shot.data, 'base64')) });
  return file;
}

/** True when the open dialog looks like the settings dialog (has a settings nav list). */
async function settingsDialogReady() {
  return evaluate(`(() => {
    const dialog = document.querySelector('[role="dialog"]');
    if (!dialog) return false;
    const text = dialog.textContent || '';
    // The settings shell renders the built-in section labels next to our own "UI 测试".
    return /UI 测试|通用|模型|插件|外观|账户|General|Models|Plugins|Appearance/i.test(text);
  })()`);
}

/** Close account/onboarding overlays so the shell chrome (settings launcher) is reachable. */
async function dismissOverlays({ attempts = 3 } = {}) {
  let closed = 0;
  for (let round = 0; round < attempts; round += 1) {
    const count = await evaluate(`(() => {
      let clicks = 0;
      for (const dialog of [...document.querySelectorAll('[role="dialog"]')]) {
        const button = [...dialog.querySelectorAll('button')].find((node) => /关闭|close|以后再说|later|跳过|skip/i.test((node.getAttribute('aria-label') || '') + (node.textContent || '')));
        if (button) { button.click(); clicks += 1; }
      }
      for (const button of [...document.querySelectorAll('button')]) {
        const label = (button.getAttribute('aria-label') || '') + '|' + (button.textContent || '');
        if (/关闭|close/i.test(label) && /_76YFJG_close|close/i.test(String(button.className || ''))) { button.click(); clicks += 1; }
      }
      return clicks;
    })()`);
    closed += count;
    await sleep(count > 0 ? 400 : 200);
    const stillOpen = await evaluate(`!!document.querySelector('[role="dialog"]')`);
    if (!stillOpen) break;
    // Some overlays have no visible close button; Escape is the shell's own dismiss path.
    await state.chrome.cdp.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
    await state.chrome.cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
    await sleep(300);
  }
  return closed;
}

/** Open the settings dialog through every known entry; each path records what it hit. */
async function openSettingsDialog() {
  const paths = [];
  const record = (path, ok, detail) => {
    paths.push({ path, ok: Boolean(ok), detail });
    if (ok) state.settingsOpenedVia = path + (detail ? ' (' + detail + ')' : '');
  };
  const finishIfSettings = async (path, detail) => {
    if (await settingsDialogReady()) { record(path, true, detail); return true; }
    // A non-settings dialog (account/onboarding) blocks the shell: close it and continue.
    await dismissOverlays({ attempts: 1 });
    record(path, false, detail);
    return false;
  };

  // 1) A direct settings trigger with aria-haspopup="dialog".
  const direct = await evaluate(`(() => {
    const buttons = [...document.querySelectorAll('button[aria-haspopup="dialog"]')];
    const trigger = buttons.find((button) => /设置|Settings/i.test((button.getAttribute('aria-label') || '') + (button.textContent || '')));
    if (!trigger) return null;
    trigger.click();
    return trigger.getAttribute('aria-label') || (trigger.textContent || '').trim().slice(0, 40);
  })()`);
  if (direct) {
    await sleep(600);
    if (await finishIfSettings('dialog-trigger', direct)) return state.settingsOpenedVia;
  } else {
    record('dialog-trigger', false, 'no aria-haspopup=dialog settings button');
  }

  // 2) Account menu in the sidebar foot.
  const accountLabel = await evaluate(`(() => {
    const buttons = [...document.querySelectorAll('button')];
    const account = buttons.find((button) => /账号菜单|Account menu/i.test(button.getAttribute('aria-label') || ''));
    if (!account) return null;
    account.click();
    return account.getAttribute('aria-label');
  })()`);
  if (accountLabel) {
    await sleep(500);
    const item = await evaluate(`(() => {
      const items = [...document.querySelectorAll('[role="menuitem"], [role="menu"] button, [role="menu"] [role="menuitem"]')];
      const target = items.find((node) => /设置|Settings/i.test((node.textContent || '') + (node.getAttribute('aria-label') || '')));
      if (!target) return null;
      target.click();
      return (target.textContent || target.getAttribute('aria-label') || '').trim().slice(0, 40);
    })()`);
    if (item) {
      await sleep(700);
      if (await finishIfSettings('account-menu', accountLabel + ' → ' + item)) return state.settingsOpenedVia;
    } else {
      record('account-menu', false, 'no 设置 item in the account menu');
      await evaluate(`document.body.click()`);
      await sleep(200);
    }
  } else {
    record('account-menu', false, 'no 账号菜单 button');
  }

  // 3) Any "更多"/"More" button (sidebar foot / panel list), then a 设置 entry in the popup.
  const moreButtons = await evaluate(`(() => [...document.querySelectorAll('button')].map((button, index) => ({
    index,
    label: (button.getAttribute('aria-label') || '') + '|' + (button.textContent || '').trim(),
  })).filter((entry) => /(^|\|)\s*(更多|More)\s*$/i.test(entry.label)).map((entry) => entry))()`);
  for (const more of moreButtons) {
    const clicked = await evaluate(`(() => {
      const buttons = [...document.querySelectorAll('button')];
      const button = buttons[${more.index}];
      if (!button) return false;
      button.click();
      return true;
    })()`);
    if (!clicked) continue;
    await sleep(500);
    const item = await evaluate(`(() => {
      const nodes = [...document.querySelectorAll('[role="menuitem"], [role="menu"] button, [role="menu"] [role="menuitem"], [role="dialog"] button')];
      const target = nodes.find((node) => /^(设置|Settings)\s*$/i.test((node.textContent || '').trim()));
      if (!target) return null;
      target.click();
      return (target.textContent || '').trim().slice(0, 40);
    })()`);
    if (item) {
      await sleep(700);
      if (await finishIfSettings('more-menu', more.label + ' → ' + item)) return state.settingsOpenedVia;
    } else {
      record('more-menu', false, more.label + ': no 设置 entry');
      await state.chrome.cdp.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
      await state.chrome.cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
      await sleep(200);
    }
  }
  if (moreButtons.length === 0) record('more-menu', false, 'no 更多/More button');

  // 4) The 插件 (Plugins) panel row may expose a settings entry.
  const pluginRow = await evaluate(`(() => {
    const button = [...document.querySelectorAll('button')].find((node) => /^插件$|^Plugins?$/i.test((node.getAttribute('aria-label') || (node.textContent || '').trim())));
    if (!button) return null;
    button.click();
    return button.getAttribute('aria-label') || (button.textContent || '').trim();
  })()`);
  if (pluginRow) {
    await sleep(700);
    const item = await evaluate(`(() => {
      const nodes = [...document.querySelectorAll('[role="menuitem"], [role="menu"] button, [role="menu"] [role="menuitem"], [role="dialog"] button')];
      const target = nodes.find((node) => /设置|Settings/i.test((node.textContent || '') + (node.getAttribute('aria-label') || '')));
      if (!target) return null;
      target.click();
      return (target.textContent || target.getAttribute('aria-label') || '').trim().slice(0, 40);
    })()`);
    if (item) {
      await sleep(700);
      if (await finishIfSettings('plugins-menu', pluginRow + ' → ' + item)) return state.settingsOpenedVia;
    } else {
      record('plugins-menu', false, pluginRow + ': no 设置 entry');
      await state.chrome.cdp.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
      await state.chrome.cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
      await sleep(200);
    }
  } else {
    record('plugins-menu', false, 'no 插件 button');
  }

  // 5) The shell's settings keyboard shortcut (Ctrl/Cmd + ,).
  await state.chrome.cdp.send('Input.dispatchKeyEvent', { type: 'keyDown', key: ',', code: 'Comma', windowsVirtualKeyCode: 188, modifiers: 2 });
  await state.chrome.cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', key: ',', code: 'Comma', windowsVirtualKeyCode: 188, modifiers: 2 });
  await sleep(700);
  if (await finishIfSettings('keyboard-shortcut', 'Ctrl+,')) return state.settingsOpenedVia;

  observations.settingsPaths = paths;
  const dom = await evaluate(`(() => ({
    buttons: [...document.querySelectorAll('button')].map((button) => ({
      aria: button.getAttribute('aria-label') || '',
      text: (button.textContent || '').trim().slice(0, 40),
      cls: String(button.className || '').slice(0, 80),
      popup: button.getAttribute('aria-haspopup'),
    })).filter((entry) => entry.aria || entry.text).slice(0, 120),
    settingsText: [...document.querySelectorAll('*')].filter((node) => node.children.length === 0 && /^(设置|Settings)$/.test((node.textContent || '').trim())).map((node) => ({ tag: node.tagName, cls: String(node.className || '').slice(0, 60), parentAria: node.parentElement && node.parentElement.getAttribute('aria-label') })).slice(0, 30),
  }))()`);
  observations.domProbe = dom;
  throw new Error('no settings entry reachable; paths=' + JSON.stringify(paths) + ' dom=' + JSON.stringify(dom).slice(0, 2500));
}

/** Click the "UI 测试" settings section; falls back to trying every nav cell in the dialog. */
async function openUiTestingSection() {
  const direct = await evaluate(`(() => {
    const dialog = document.querySelector('[role="dialog"]');
    if (!dialog) return { ok: false, reason: 'no-dialog' };
    const buttons = [...dialog.querySelectorAll('button')];
    const target = buttons.find((button) => (button.textContent || '').includes('UI 测试'));
    if (!target) return { ok: false, reason: 'no-section-label', labels: buttons.map((button) => (button.textContent || '').trim().slice(0, 30)).filter(Boolean) };
    target.click();
    return { ok: true, label: (target.textContent || '').trim() };
  })()`);
  observations.sectionEntry = direct;
  if (!direct.ok) {
    // Fallback: click each nav-like button until the settings page mounts.
    const tried = await evaluate(`(() => {
      const dialog = document.querySelector('[role="dialog"]');
      if (!dialog) return [];
      const buttons = [...dialog.querySelectorAll('button')].filter((button) => (button.textContent || '').trim().length > 0);
      return buttons.map((button, index) => ({ index, text: (button.textContent || '').trim().slice(0, 30) }));
    })()`);
    observations.sectionFallbackButtons = tried;
    for (const entry of tried) {
      await evaluate(`(() => {
        const dialog = document.querySelector('[role="dialog"]');
        const buttons = dialog ? [...dialog.querySelectorAll('button')].filter((button) => (button.textContent || '').trim().length > 0) : [];
        if (buttons[${entry.index}]) buttons[${entry.index}].click();
      })()`);
      await sleep(250);
      if (await evaluate(`!!document.querySelector('[data-uts-settings="page"]')`)) {
        state.settingsOpenedVia = state.settingsOpenedVia + ' + fallback nav #' + entry.index;
        return;
      }
    }
    throw new Error('settings page [data-uts-settings=page] never mounted; section entry=' + JSON.stringify(direct));
  }
  await waitFor(async () => evaluate(`!!document.querySelector('[data-uts-settings="page"]')`),
    { timeoutMs: 15000, label: 'ui-testing settings page' });
}

async function readSettingsState() {
  return evaluate(`(() => {
    const page = document.querySelector('[data-uts-settings="page"]');
    if (!page) return null;
    const groups = [...document.querySelectorAll('[data-uts-group]')];
    return {
      revisionRaw: page.getAttribute('data-uts-config-revision'),
      status: page.getAttribute('data-uts-config-status'),
      groupCount: groups.length,
      expanded: groups.map((group) => ({ id: group.getAttribute('data-uts-group'), expanded: group.getAttribute('data-uts-expanded') })),
      webAxes: [...document.querySelectorAll('[data-uts-group="web"] [data-uts-axis]')].map((node) => ({
        axis: node.getAttribute('data-uts-axis'),
        status: node.getAttribute('data-uts-status'),
      })),
      chromeCardText: (document.querySelector('[data-uts-target="chrome"]') || {}).textContent || '',
      chromeSwitch: (() => {
        const input = document.querySelector('[data-uts-target="chrome"] input[type="checkbox"]');
        return input ? { checked: input.checked, disabled: input.disabled, label: input.getAttribute('aria-label') } : null;
      })(),
      configError: (document.querySelector('[data-uts-config-error]') || {}).textContent || '',
    };
  })()`);
}

async function clickChromeSwitch() {
  const clicked = await evaluate(`(() => {
    const input = document.querySelector('[data-uts-target="chrome"] input[type="checkbox"]');
    if (!input) return { ok: false, reason: 'no-switch' };
    if (input.disabled) return { ok: false, reason: 'disabled' };
    const before = input.checked;
    input.click();
    return { ok: true, before };
  })()`);
  if (!clicked.ok) throw new Error('Chrome switch not clickable: ' + clicked.reason);
  return clicked;
}

function putConfigRequests() {
  return state.requests.filter((request) => request.method === 'PUT'
    && request.url.includes(HOST_ROUTE + '/config'));
}

async function main() {
  await mkdir(RUN_DIR, { recursive: true });
  const baseline = await import('./harness.mjs').then((mod) => ({
    profiles: mod.snapshotProfileDirs,
    chrome: mod.scanPluginChromeProcesses,
  }));
  const baselineProfiles = await baseline.profiles();
  const baselineChrome = baseline.chrome();

  try {
    log('[env] launching isolated DSH (temp DSH_HOME, random loopback port, --no-open)');
    await startIsolatedDsh();
    log(`[env] isolated dsh base=${state.dsh.base} port=${state.dsh.port} copied=${JSON.stringify(state.dsh.copied)}`);
    await launchChrome();
    log(`[env] GUI chromium devtools port=${state.chrome.devtoolsPort} (profile under tmp)`);
    const cookieCount = await authenticate(state.dsh.launchUrl);
    log(`[env] authenticated (${cookieCount} cookie(s), token never logged)`);
    // The launch URL (with token) stays in memory only; every log/report path is redacted.
    await state.chrome.cdp.send('Page.navigate', { url: state.dsh.launchUrl });
    await guiReady();
    await capture('gui-shell.png');
    await sleep(800); // onboarding/account overlays mount just after the shell
    const dismissed = await dismissOverlays();
    log(`[gui] dismissed ${dismissed} overlay dialog(s)`);

    const openedVia = await openSettingsDialog();
    log(`[gui] settings dialog opened via ${JSON.stringify(openedVia)}`);
    await openUiTestingSection();
    log('[gui] settings page mounted');

    /* ---------------------------------------------------------------- A07/A13: initial page */
    const initial = await readSettingsState();
    await capture('settings-page.png');
    const initialRevision = Number(initial.revisionRaw);
    check('A13 settings page renders [data-uts-settings="page"] with a numeric [data-uts-config-revision]',
      Boolean(initial) && Number.isFinite(initialRevision) && String(initial.revisionRaw).trim() !== '',
      'numeric data-uts-config-revision',
      { revisionRaw: initial && initial.revisionRaw, status: initial && initial.status });
    check('A13 settings page has no Host config read error',
      initial && !initial.configError,
      { configError: '' },
      { configError: initial && initial.configError, status: initial && initial.status });

    check('A13 ten environment groups render collapsed by default',
      initial && initial.groupCount === 10
        && initial.expanded.every((group) => group.expanded === 'false'),
      { groupCount: 10, allCollapsed: true },
      { groupCount: initial && initial.groupCount, expanded: initial && initial.expanded });

    // Expand the Web group (its six axis nodes must be visible afterwards).
    await evaluate(`(() => { const toggle = document.querySelector('[data-uts-group-toggle="web"]'); if (toggle) toggle.click(); })()`);
    await waitFor(async () => evaluate(`(() => { const group = document.querySelector('[data-uts-group="web"]'); return group && group.getAttribute('data-uts-expanded') === 'true'; })()`),
      { timeoutMs: 10000, label: 'web group expanded' });
    const expanded = await readSettingsState();
    await capture('settings-page-expanded.png');
    const AXES = ['support', 'enabled', 'dependency', 'connection', 'target', 'capability'];
    const axisNames = expanded.webAxes.map((axis) => axis.axis);
    check('A13 expanded Web group exposes the six independent axes with their own data-uts-status',
      AXES.every((axis) => axisNames.includes(axis))
        && expanded.webAxes.every((axis) => typeof axis.status === 'string' && axis.status.length > 0)
        && new Set(expanded.webAxes.map((axis) => axis.status)).size >= 2,
      { axes: AXES, eachWithStatus: true },
      { axes: expanded.webAxes });
    // A13 page/Host consistency: the axes rendered on the page must be the Host's own values.
    // This is the check that catches a client that silently drops the Host readiness payload.
    const hostReadiness = await evaluate(`(async () => {
      const response = await fetch('/plugins/ui-testing/config?view=global', { credentials: 'same-origin', cache: 'no-store' });
      const payload = await response.json();
      return payload.readiness || null;
    })()`);
    const hostWebEntry = hostReadiness && Array.isArray(hostReadiness.environments)
      ? hostReadiness.environments.find((entry) => (entry.id || entry.environment) === 'web')
      : null;
    const hostAxisStatus = (axis) => {
      const entry = hostWebEntry || {};
      if (entry.axes && entry.axes[axis]) return entry.axes[axis].status;
      return entry[axis] === undefined || entry[axis] === null ? null : String(entry[axis]);
    };
    const axisMismatches = expanded.webAxes
      .map((axis) => ({ axis: axis.axis, page: axis.status, host: hostAxisStatus(axis.axis) }))
      .filter((row) => row.host !== null && row.page !== row.host);
    check('A13 page axes match the Host readiness payload (no dropped/downgraded axis)',
      Boolean(hostWebEntry) && axisMismatches.length === 0,
      { pageEqualsHost: true },
      { hostEntry: hostWebEntry ? { checkedAt: hostWebEntry.checkedAt, axes: hostWebEntry.axes } : null, mismatches: axisMismatches });

    check('A13 Web support axis is supported (not a fabricated "valid" boolean)',
      expanded.webAxes.some((axis) => axis.axis === 'support' && axis.status === 'supported'),
      { support: 'supported' },
      expanded.webAxes.find((axis) => axis.axis === 'support') || null);
    const chromeCard = expanded.chromeCardText || '';
    check('A13 Chrome card shows no hardcoded version number',
      chromeCard.length > 0 && !/\d+\.\d+(\.\d+)?/u.test(chromeCard) && !/版本\s*[:：]?\s*\d/u.test(chromeCard),
      { versionPattern: 'absent' },
      { chromeCardText: chromeCard.slice(0, 200) });

    /* ------------------------------------------------------------------- A07/A10: toggle PUT */
    const switchInfo = await clickChromeSwitch();
    log(`[gui] Chrome switch clicked (before=${switchInfo.before})`);
    const bumped = await waitFor(async () => {
      const current = await readSettingsState();
      const revision = Number(current.revisionRaw);
      return Number.isFinite(revision) && revision > initialRevision ? { revision, state: current } : undefined;
    }, { timeoutMs: 20000, label: 'config revision increased after toggle' });
    await capture('settings-page-after-toggle.png');
    const puts = putConfigRequests();
    const togglePut = puts[puts.length - 1];
    check('A07 clicking the enable switch sends PUT /plugins/ui-testing/config',
      puts.length >= 1 && Boolean(togglePut) && togglePut.postData.includes('"environments"'),
      { requests: 1, body: '{"environments":{"web":{"enabled":false}}}' },
      { count: puts.length, last: togglePut && { method: togglePut.method, url: togglePut.url, body: togglePut.postData.slice(0, 200) } });
    check('A07 toggle bumps the Host config revision by exactly one',
      bumped.revision === initialRevision + 1,
      { revision: initialRevision + 1 },
      { revision: bumped.revision, state: bumped.state && bumped.state.status });
    check('A07 switch reflects the saved Host state after the PUT (web disabled)',
      bumped.state.chromeSwitch && bumped.state.chromeSwitch.checked === false,
      { checked: false },
      { switch: bumped.state.chromeSwitch });

    /* ------------------------------------------------------------------------ A07: reload */
    await state.chrome.cdp.send('Page.reload', { ignoreCache: true });
    await guiReady();
    await sleep(800);
    await dismissOverlays();
    await openSettingsDialog();
    await openUiTestingSection();
    const afterReload = await waitFor(async () => {
      const current = await readSettingsState();
      return current && Number(current.revisionRaw) === bumped.revision ? current : undefined;
    }, { timeoutMs: 20000, label: 'revision persisted after reload' });
    await capture('settings-page-after-reload.png');
    check('A07 page reload keeps the Host revision',
      Number(afterReload.revisionRaw) === bumped.revision,
      { revision: bumped.revision },
      { revision: afterReload.revisionRaw });
    check('A07 page reload keeps the switch state (web disabled)',
      afterReload.chromeSwitch && afterReload.chromeSwitch.checked === false,
      { checked: false },
      { switch: afterReload.chromeSwitch });

    // Restore web enabled so the isolated instance is left consistent (temp home is removed anyway).
    const restoreClick = await clickChromeSwitch();
    const restored = await waitFor(async () => {
      const current = await readSettingsState();
      return current && Number(current.revisionRaw) === bumped.revision + 1 ? current : undefined;
    }, { timeoutMs: 20000, label: 'revision increased after restore toggle' });
    check('A07 re-enabling web persists another revision and restores the switch',
      Number(restored.revisionRaw) === bumped.revision + 1
        && restored.chromeSwitch && restored.chromeSwitch.checked === true,
      { revision: bumped.revision + 1, checked: true },
      { revision: restored.revisionRaw, switch: restored.chromeSwitch, clicked: restoreClick });

    /* ---------------------------------------------------------------------------- NOT_RUN */
    notRun('A07 404 degradation (missing route prefix)',
      'route prefix is compiled into client.js/index.js; producing a 404 requires editing the served bundle or a second Host build, which this acceptance run must not do. Host-level error path is covered by cross-environment.mjs (GET/PUT /config error handling) and this page keeps [data-uts-config-error] rendering.');

    observations.pageExceptions = state.pageExceptions;
    observations.consoleErrors = state.consoleErrors;
    observations.requestCount = state.requests.length;
    observations.settingsOpenedVia = state.settingsOpenedVia;
  } finally {
    if (state.chrome) {
      try { state.chrome.cdp.close(); } catch { /* ignore */ }
      try { state.chrome.proc.kill('SIGTERM'); } catch { /* ignore */ }
      await sleep(600);
      try { state.chrome.proc.kill('SIGKILL'); } catch { /* ignore */ }
      await rm(state.chrome.profileDir, { recursive: true, force: true, maxRetries: 5 }).catch(() => {});
    }
    if (state.dsh) {
      try { state.dsh.proc.kill('SIGTERM'); } catch { /* ignore */ }
      await sleep(800);
      try { state.dsh.proc.kill('SIGKILL'); } catch { /* ignore */ }
      await rm(state.dsh.home, { recursive: true, force: true, maxRetries: 5 }).catch(() => {});
    }
    // Only Chromium processes started by this run (new plugin profiles) are killed.
    const baselinePids = new Set(baselineChrome.map((entry) => entry.pid));
    const baselineProfileSet = new Set(baselineProfiles);
    const currentProfiles = await baseline.profiles();
    const newProfiles = currentProfiles.filter((dir) => !baselineProfileSet.has(dir));
    for (const proc of baseline.chrome()) {
      if (baselinePids.has(proc.pid)) continue;
      if (!newProfiles.some((dir) => String(proc.profileDir).startsWith(dir))) continue;
      try { process.kill(proc.pid, 'SIGKILL'); } catch { /* already gone */ }
    }
    for (const dir of newProfiles) await rm(dir, { recursive: true, force: true, maxRetries: 5 }).catch(() => {});
  }

  const failed = checks.filter((entry) => !entry.pass);
  const report = {
    suite: 'settings-config-gui',
    startedAt: RUN_STAMP,
    finishedAt: new Date().toISOString(),
    environment: {
      dsh: state.dsh ? { base: state.dsh.base, port: state.dsh.port, home: '(temp)', copied: state.dsh.copied } : null,
      chrome: CHROME,
      route: HOST_ROUTE,
      token: '[redacted]',
    },
    coverage: {
      pageSide: ['A07 settings persistence + revision', 'A13 six axes / collapsed groups / no fake version'],
      substituteEvidence: 'tests/acceptance/runs/cross-environment-* covers the Host side of A07/A10/A13/A14',
    },
    checks,
    notRuns,
    screenshots: screenshots.map((entry) => ({ name: entry.name, file: entry.file.replace(HERE + '/', ''), sha256: entry.sha256 })),
    observations,
    summary: { checks: checks.length, passed: checks.length - failed.length, failed: failed.length, notRun: notRuns.length },
  };
  await writeFile(join(RUN_DIR, 'report.json'), JSON.stringify(report, null, 2));
  await writeFile(join(RUN_DIR, 'run.log'), logLines.join('\n') + '\n');
  log(`\nsettings-config-gui: ${checks.length - failed.length}/${checks.length} PASS, ${failed.length} failed, ${notRuns.length} NOT_RUN`);
  log('evidence: ' + RUN_DIR);
  for (const entry of failed) log(`  FAILED: ${entry.label}`);
  return failed.length === 0 ? 0 : 1;
}

let code = 2;
try {
  code = await main();
} catch (error) {
  const message = redact(error && (error.stack || error.message) || error);
  log('BLOCKED/FATAL ' + message);
  try {
    await mkdir(RUN_DIR, { recursive: true });
    await writeFile(join(RUN_DIR, 'report.json'), JSON.stringify({
      suite: 'settings-config-gui',
      status: 'BLOCKED',
      reason: message,
      environment: {
        dsh: state.dsh ? { base: state.dsh.base, port: state.dsh.port } : null,
        chrome: CHROME,
        token: '[redacted]',
      },
      coverage: {
        pageSide: 'NOT_COVERED (isolated GUI unavailable in this environment)',
        substituteEvidence: 'tests/acceptance/runs/cross-environment-* covers the Host side of A07/A10/A13/A14',
      },
      checks,
      notRuns,
      screenshots: screenshots.map((entry) => ({ name: entry.name, file: entry.file.replace(HERE + '/', ''), sha256: entry.sha256 })),
    }, null, 2));
    await writeFile(join(RUN_DIR, 'run.log'), logLines.join('\n') + '\n');
  } catch { /* best effort */ }
  code = 2;
}
process.exit(code);
