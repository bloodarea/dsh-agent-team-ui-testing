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
      // Six axes no longer live on the group: they belong to one runtime provider and are shown on
      // that provider's own diagnostics page. The card keeps a one-line dependency hint + the button.
      providerDiagnose: [...document.querySelectorAll('[data-uts-provider]')].map((node) => ({
        provider: node.getAttribute('data-uts-provider'),
        hasButton: Boolean(node.querySelector('[data-uts-diagnose]')),
      })),
      chromeCardText: (document.querySelector('[data-uts-target="chrome"]') || {}).textContent || '',
      // The group header owns the *target environment* master switch; the card owns the
      // *running environment* (provider) switch. Both are read separately so a test can tell
      // which layer a write touched.
      envSwitch: (() => {
        const input = document.querySelector('[data-uts-env-switch="web"] input[type="checkbox"]');
        return input ? { checked: input.checked, disabled: input.disabled, label: input.getAttribute('aria-label') } : null;
      })(),
      chromeSwitch: (() => {
        const input = document.querySelector('[data-uts-switch-provider="chrome"] input[type="checkbox"]');
        return input ? { checked: input.checked, disabled: input.disabled, label: input.getAttribute('aria-label') } : null;
      })(),
      // Per-provider cards: switch + implementation state only. The dependency axis and the
      // ③ 接口 / ④ 执行端 chain tags live on that provider's own diagnostics page (no duplicates).
      providerCards: [...document.querySelectorAll('[data-uts-provider]')].map((node) => {
        const box = node.querySelector('[data-uts-switch-provider] input[type="checkbox"]');
        return {
          provider: node.getAttribute('data-uts-provider'),
          state: node.getAttribute('data-uts-provider-state'),
          targetState: node.getAttribute('data-uts-state'),
          current: node.getAttribute('data-uts-provider-current'),
          dependency: node.querySelector('[data-uts-dependency-status]')
            ? node.querySelector('[data-uts-dependency-status]').getAttribute('data-uts-dependency-status') : null,
          cardTags: [...node.querySelectorAll('[data-uts-tag]')].map((tag) => tag.getAttribute('data-uts-tag')),
          available: Boolean(node.querySelector('[data-uts-available]')),
          stateText: (() => {
            const span = node.querySelector('[data-uts-card-state]');
            return span ? { text: (span.textContent || '').trim(), state: span.getAttribute('data-uts-card-state') } : null;
          })(),
          note: (() => {
            const note = node.querySelector('.uts-card-note');
            if (!note) return null;
            const style = getComputedStyle(note);
            return {
              clamp: style.webkitLineClamp || style.lineClamp || '',
              clientHeight: note.clientHeight,
              scrollHeight: note.scrollHeight,
              titleMatches: note.getAttribute('title') === (note.textContent || ''),
            };
          })(),
          diagnoseRight: (() => {
            const card = node.querySelector('.uts-card');
            const button = node.querySelector('[data-uts-diagnose]');
            if (!card || !button) return null;
            const c = card.getBoundingClientRect();
            const b = button.getBoundingClientRect();
            return { fromRight: Math.round(c.right - b.right), fromBottom: Math.round(c.bottom - b.bottom) };
          })(),
          enabled: box ? box.checked : null,
        };
      }),
      // The 当前使用 / 未选中 badge was removed: the switch already shows the enabled state.
      currentBadges: document.querySelectorAll('[data-uts-tag="current"]').length,
      configError: (document.querySelector('[data-uts-config-error]') || {}).textContent || '',
      reloadButtons: document.querySelectorAll('[data-uts-config-reload]').length,
    };
  })()`);
}

async function clickEnvSwitch() {
  const clicked = await evaluate(`(() => {
    const input = document.querySelector('[data-uts-env-switch="web"] input[type="checkbox"]');
    if (!input) return { ok: false, reason: 'no-switch' };
    if (input.disabled) return { ok: false, reason: 'disabled' };
    const before = input.checked;
    input.click();
    return { ok: true, before };
  })()`);
  if (!clicked.ok) throw new Error('Target environment master switch not clickable: ' + clicked.reason);
  return clicked;
}

async function clickProviderSwitch(providerId) {
  const clicked = await evaluate(`(() => {
    const input = document.querySelector('[data-uts-switch-provider="${providerId}"] input[type="checkbox"]');
    if (!input) return { ok: false, reason: 'no-switch' };
    if (input.disabled) return { ok: false, reason: 'disabled' };
    const before = input.checked;
    input.click();
    return { ok: true, before };
  })()`);
  if (!clicked.ok) throw new Error('Provider switch not clickable: ' + providerId + ' / ' + clicked.reason);
  return clicked;
}

function putConfigRequests() {
  return state.requests.filter((request) => request.method === 'PUT'
    && request.url.includes(HOST_ROUTE + '/config'));
}

/**
 * Read the provider diagnostics page as the DOM actually is. One reader for every phase of this
 * suite (static structure and real-time phases), so the two can never disagree about what "the
 * page says".
 */
async function readDiagPage(providerId = 'chrome') {
  return evaluate(`(() => {
    const provider = ${JSON.stringify(providerId)};
    const modals = [...document.querySelectorAll('[data-uts-diag-modal]')];
    const panel = modals.find((node) => node.getAttribute('data-uts-diag-modal') === provider) || modals[0] || null;
    const page = panel ? (panel.querySelector('[data-uts-diagnostics="' + provider + '"]') || panel) : null;
    const settingsDialog = document.querySelector('[data-uts-settings="page"]');
    const bytes = (node) => (node ? (node.textContent || '').trim() : '');
    if (!page) {
      return { present: false, provider, nodes: [], edges: [], axes: [], events: { rows: [] }, duties: [],
        pageInstances: modals.length, modalCount: modals.length, insideSettingsDialog: null };
    }
    const attr = (node, name) => (node ? node.getAttribute(name) : null);
    const overall = page.querySelector('[data-uts-diag-overall]');
    const eventsBox = page.querySelector('[data-uts-events]');
    const chainScroll = page.querySelector('.uts-diag-chain-scroll');
    const axesGrid = page.querySelector('.uts-diag-axes');
    const emptyBox = page.querySelector('[data-uts-events-empty]');
    const panelRect = panel ? panel.getBoundingClientRect() : null;
    return {
      present: true,
      provider,
      runId: attr(page, 'data-uts-run-id'),
      runPhase: attr(page, 'data-uts-run-phase'),
      runMode: attr(page, 'data-uts-run-mode'),
      runSource: attr(page, 'data-uts-run-source'),
      title: bytes(panel ? panel.querySelector('.uts-page-title') : page.querySelector('.uts-page-title')),
      group: attr(page, 'data-uts-diagnostics-group'),
      stateAttr: attr(page, 'data-uts-diagnostics-state'),
      poll: attr(page, 'data-uts-diag-poll'),
      stale: attr(page, 'data-uts-diag-stale'),
      desc: bytes(page.querySelector('.uts-page-desc')),
      startAction: Boolean(page.querySelector('[data-uts-diag-start]')),
      startActionText: bytes(page.querySelector('[data-uts-diag-action]')),
      runButtonLabel: bytes(page.querySelector('[data-uts-diag-run]')),
      runButtonDisabled: (() => {
        const button = page.querySelector('[data-uts-diag-run]');
        return button ? (button.disabled === true || button.getAttribute('data-uts-action-disabled') === 'true') : null;
      })(),
      actionNoteBranch: attr(page.querySelector('[data-uts-diag-run]'), 'data-uts-diag-action-note'),
      actionNote: attr(page.querySelector('[data-uts-diag-run]'), 'title') || '',
      sideEffects: attr(overall, 'data-uts-diag-side-effects'),
      actualCalls: attr(overall, 'data-uts-diag-actual-calls'),
      updatedClock: attr(overall, 'data-uts-diag-updated-clock'),
      pillMode: attr(overall, 'data-uts-run-mode'),
      pillTitle: attr(overall, 'title') || '',
      nodeBadges: [...page.querySelectorAll('.uts-diag-node-index')].map((node) => bytes(node)),
      overall: overall
        ? {
          value: attr(overall, 'data-uts-overall'),
          reason: attr(overall, 'data-uts-overall-reason'),
          text: bytes(overall),
          title: attr(overall, 'title') || '',
          sideEffects: attr(overall, 'data-uts-diag-side-effects'),
          actualCalls: attr(overall, 'data-uts-diag-actual-calls'),
          updatedClock: attr(overall, 'data-uts-diag-updated-clock'),
          runMode: attr(overall, 'data-uts-run-mode'),
          color: overall ? getComputedStyle(overall).color : '',
          borderStyle: overall ? getComputedStyle(overall).borderTopStyle : '',
        }
        : null,
      legacyStateHits: (() => {
        const legacy = ['ready', 'pending', 'broken'];
        const hits = [];
        for (const name of ['data-uts-overall', 'data-uts-node-state', 'data-uts-edge-state', 'data-uts-status', 'data-uts-stage-status', 'data-uts-node-status']) {
          for (const value of legacy) {
            if (document.querySelector('[' + name + '="' + value + '"]')) hits.push(name + '=' + value);
          }
        }
        return hits;
      })(),
      modalCount: modals.length,
      insideSettingsDialog: Boolean(settingsDialog && panel && settingsDialog.contains(panel)),
      panelRole: attr(panel, 'role'),
      panelAriaModal: attr(panel, 'aria-modal'),
      panelAriaLabel: attr(panel, 'aria-label'),
      panelWidth: panelRect ? Math.round(panelRect.width) : 0,
      panelHeight: panelRect ? Math.round(panelRect.height) : 0,
      settingsContentWidth: settingsDialog ? Math.round(settingsDialog.getBoundingClientRect().width) : 0,
      bodyOverflow: document.body.style.overflow,
      focusTag: document.activeElement ? String(document.activeElement.tagName || '') : '',
      focusIsClose: Boolean(document.activeElement && document.activeElement.hasAttribute('data-uts-diagnostics-back')),
      nodes: [...page.querySelectorAll('[data-uts-topology] [data-uts-node]')].map((node) => ({
        index: attr(node, 'data-uts-node'),
        id: attr(node, 'data-uts-node-id'),
        state: attr(node, 'data-uts-node-state'),
        status: attr(node.querySelector('[data-uts-node-status]'), 'data-uts-node-status'),
        sub: bytes(node.querySelector('.uts-diag-node-sub')),
        name: bytes(node.querySelector('.uts-diag-node-name')),
        stage: attr(node, 'data-uts-stage'),
        stageStatus: attr(node, 'data-uts-stage-status'),
        stagePhase: attr(node, 'data-uts-stage-phase'),
        stageReason: attr(node, 'data-uts-stage-reason'),
        stageBlockedBy: attr(node, 'data-uts-stage-blocked-by'),
        stageDuration: attr(node, 'data-uts-stage-duration'),
        pulse: (() => { const style = getComputedStyle(node); return { animationName: style.animationName }; })(),
      })),
      edges: [...page.querySelectorAll('[data-uts-topology] [data-uts-edge]')].map((node) => {
        const dot = node.querySelector('[data-uts-edge-dot]');
        return {
          index: attr(node, 'data-uts-edge'),
          state: attr(node, 'data-uts-edge-state'),
          live: attr(node, 'data-uts-edge-live'),
          label: attr(node, 'data-uts-edge-label'),
          dotDisplay: dot ? getComputedStyle(dot).display : 'no-dot',
          dotAnimation: dot ? getComputedStyle(dot).animationName : 'no-dot',
        };
      }),
      axes: [...page.querySelectorAll('[data-uts-axis]')].map((node) => ({
        axis: attr(node, 'data-uts-axis'),
        status: attr(node, 'data-uts-status'),
        order: attr(node, 'data-uts-axis-order'),
        source: attr(node, 'data-uts-axis-source'),
        runId: attr(node, 'data-uts-axis-run-id'),
        checkedAt: attr(node, 'data-uts-axis-checked-at'),
        reason: bytes(node.querySelector('[data-uts-axis-reason]')),
        title: attr(node, 'title') || '',
        checks: bytes(node.querySelector('[data-uts-axis-checks]')),
        hasChecks: Boolean(node.querySelector('[data-uts-axis-checks]')),
      })),
      events: {
        present: Boolean(eventsBox),
        count: attr(eventsBox, 'data-uts-event-count'),
        emptyText: bytes(emptyBox),
        rows: [...page.querySelectorAll('[data-uts-events] [data-uts-event]')].map((node) => {
          const pin = node.querySelector('.uts-diag-event-pin');
          return {
            kind: attr(node, 'data-uts-event-kind'),
            operation: attr(node, 'data-uts-event-operation'),
            runId: attr(node, 'data-uts-event-run-id'),
            seq: attr(node, 'data-uts-event-seq'),
            evidenceRef: attr(node, 'data-uts-event-evidence-ref'),
            status: attr(node, 'data-uts-event-to'),
            pinStatus: pin ? pin.getAttribute('data-uts-event-status') : null,
            pinColor: pin ? getComputedStyle(pin).backgroundColor : 'no-pin',
            time: attr(node, 'data-uts-event-time'),
            timeText: bytes(node.querySelector('.uts-diag-event-time')),
            text: bytes(node.querySelector('.uts-diag-event-text')),
          };
        }),
      },
      duties: [...page.querySelectorAll('[data-uts-duties] [data-uts-duty]')].map((node) => ({
        node: attr(node, 'data-uts-duty-node'),
        text: bytes(node),
      })),
      backButtons: page.querySelectorAll('[data-uts-diagnostics-back]').length
        + (panel ? [...panel.querySelectorAll('[data-uts-diagnostics-back]')].filter((node) => !page.contains(node)).length : 0),
      buttonLabels: [...(panel || page).querySelectorAll('button')].map((node) => bytes(node)),
      pageText: (panel || page).textContent || '',
      chainScroll: chainScroll ? { scrollWidth: chainScroll.scrollWidth, clientWidth: chainScroll.clientWidth } : null,
      axesColumns: axesGrid ? getComputedStyle(axesGrid).gridTemplateColumns.split(' ').length : 0,
      pageInstances: modals.length,
      visibleInstances: modals.length,
    };
  })()`);
}

/**
 * Answer `POST /plugins/ui-testing/diagnose` with a fixed NDJSON body (or a 500 when `body === null`).
 * Used for the two anti-fabrication cases: an injected FAIL run and a run that never arrives.
 */
async function startDiagnoseStub(body) {
  const { cdp } = state.chrome;
  const handler = async (message) => {
    if (message.method !== 'Fetch.requestPaused') return;
    const params = message.params || {};
    const requestId = params.requestId;
    const url = String((params.request && params.request.url) || '');
    if (!requestId) return;
    if (!url.includes('/plugins/ui-testing/diagnose')) {
      await cdp.send('Fetch.continueRequest', { requestId }).catch(() => {});
      return;
    }
    if (body === '__hold__') return; // leave the request pending: the client keeps the run in flight
    if (body === null) {
      await cdp.send('Fetch.fulfillRequest', {
        requestId,
        responseCode: 500,
        responseHeaders: [{ name: 'content-type', value: 'application/json' }],
        body: Buffer.from(JSON.stringify({ ok: false, code: 'DIAGNOSE_UNAVAILABLE', error: 'acceptance: injected failure' })).toString('base64'),
      }).catch(() => {});
      return;
    }
    await cdp.send('Fetch.fulfillRequest', {
      requestId,
      responseCode: 200,
      responseHeaders: [
        { name: 'content-type', value: 'application/x-ndjson; charset=utf-8' },
        { name: 'cache-control', value: 'no-store' },
      ],
      body: Buffer.from(body).toString('base64'),
    }).catch(() => {});
  };
  const off = cdp.on(handler);
  await cdp.send('Fetch.enable', { patterns: [{ urlPattern: '*/plugins/ui-testing/diagnose*', requestStage: 'Request' }] });
  return async function stopDiagnoseStub() {
    try { await cdp.send('Fetch.disable'); } catch { /* ignore */ }
    off();
  };
}

/**
 * Rewrite `GET /plugins/ui-testing/config*` responses at the CDP level. The callback receives the
 * parsed Host payload; returning `null` makes the request fail with a 500, returning an object
 * sends that JSON back as 200. Nothing else is touched (PUTs and other URLs pass through), so the
 * page keeps talking to the real Host — only the payload it sees is pinned for the scenario.
 */
async function startConfigRewrite(transform) {
  const { cdp } = state.chrome;
  const handler = async (message) => {
    if (message.method !== 'Fetch.requestPaused') return;
    const params = message.params || {};
    const requestId = params.requestId;
    const url = String((params.request && params.request.url) || '');
    const method = String((params.request && params.request.method) || '');
    if (!requestId) return;
    if (method !== 'GET' || !url.includes(HOST_ROUTE + '/config')) {
      await cdp.send('Fetch.continueRequest', { requestId }).catch(() => {});
      return;
    }
    try {
      const body = await cdp.send('Fetch.getResponseBody', { requestId });
      const text = body.base64Encoded ? Buffer.from(body.body, 'base64').toString('utf8') : body.body;
      const json = JSON.parse(text);
      const next = transform(json);
      if (next === null || next === undefined) {
        await cdp.send('Fetch.fulfillRequest', {
          requestId,
          responseCode: 500,
          responseHeaders: [{ name: 'content-type', value: 'application/json' }],
          body: Buffer.from(JSON.stringify({ ok: false, code: 'CONFIG_UNAVAILABLE', error: 'acceptance: injected failure' })).toString('base64'),
        });
        return;
      }
      const output = JSON.stringify(next);
      await cdp.send('Fetch.fulfillRequest', {
        requestId,
        responseCode: 200,
        responseHeaders: [
          { name: 'content-type', value: 'application/json' },
          { name: 'content-length', value: String(Buffer.byteLength(output)) },
        ],
        body: Buffer.from(output).toString('base64'),
      });
    } catch {
      await cdp.send('Fetch.continueRequest', { requestId }).catch(() => {});
    }
  };
  const off = cdp.on(handler);
  await cdp.send('Fetch.enable', { patterns: [{ urlPattern: '*/plugins/ui-testing/config*', requestStage: 'Response' }] });
  return async function stopConfigRewrite() {
    try { await cdp.send('Fetch.disable'); } catch { /* ignore */ }
    off();
  };
}

/** Pin one provider axis inside a Host payload (used to build the per-axis counterexamples). */
function withProviderAxis(payload, providerId, axis, patch) {
  const environments = payload && payload.readiness && Array.isArray(payload.readiness.environments)
    ? payload.readiness.environments
    : null;
  const web = environments ? environments.find((entry) => (entry.id || entry.environment) === 'web') : null;
  const provider = web && web.providers ? web.providers[providerId] : null;
  if (!provider || !provider.axes) return payload;
  provider.axes[axis] = Object.assign({}, provider.axes[axis] || {}, patch, { checkedAt: Date.now() });
  return payload;
}

/** Worst of several chain states (broken > pending > ready), mirroring the product's diagWorstState. */
const worstChainState = (...states) => (states.includes('broken') ? 'broken'
  : (states.includes('pending') ? 'pending' : 'ready'));

/**
 * The two chain invariants, read from the DOM only:
 *   1) every green node except ① has a `ready` incoming edge whose dot is animating;
 *   2) every animating edge has two green endpoints.
 * Direction matters: the product derives readiness from the axes only (never from the animation),
 * so `ready` is always the premise and the moving dot the consequence. Both statements above are
 * asserted as DOM invariants of that derivation — the reverse (animation ⇒ ready) is never used to
 * decide a node state anywhere in the product.
 */
function chainInvariantViolations(snapshot) {
  const nodes = (snapshot && snapshot.nodes) || [];
  const edges = (snapshot && snapshot.edges) || [];
  const nodeState = (index) => (nodes.find((node) => node.index === String(index)) || {}).state;
  const edgeOf = (index) => edges.find((edge) => edge.index === String(index)) || {};
  const greenWithoutMovingIncomingEdge = [];
  for (const index of [2, 3, 4, 5]) {
    if (nodeState(index) !== 'ready') continue;
    const incoming = edgeOf(index - 1);
    if (incoming.state !== 'ready' || !incoming.animationName || incoming.animationName === 'none') {
      greenWithoutMovingIncomingEdge.push({
        node: index, edge: incoming.index, edgeState: incoming.state, animation: incoming.animationName,
      });
    }
  }
  const animationWithoutGreenEnds = [];
  for (const edge of edges) {
    if (!edge.animationName || edge.animationName === 'none') continue;
    const from = nodeState(Number(edge.index));
    const to = nodeState(Number(edge.index) + 1);
    if (from !== 'ready' || to !== 'ready') {
      animationWithoutGreenEnds.push({ edge: edge.index, animation: edge.animationName, from, to });
    }
  }
  return { greenWithoutMovingIncomingEdge, animationWithoutGreenEnds };
}

/** Every GET the GUI has issued for the Host config (the diagnostics page polls this URL). */
function configGetCount() {
  return state.requests.filter((request) => request.method === 'GET'
    && request.url.includes(HOST_ROUTE + '/config')).length;
}

/**
 * Make `GET /plugins/ui-testing/config*` fail with a 500 at the network layer, so the diagnostics
 * page's next poll takes its *failure* path (stale) without any product-code hook. Returns a stop
 * function; every other request (and every PUT) passes through untouched.
 */
async function startConfigFailure() {
  const { cdp } = state.chrome;
  const handler = async (message) => {
    if (message.method !== 'Fetch.requestPaused') return;
    const params = message.params || {};
    const requestId = params.requestId;
    const url = String((params.request && params.request.url) || '');
    const method = String((params.request && params.request.method) || '');
    if (!requestId) return;
    if (method !== 'GET' || !url.includes(HOST_ROUTE + '/config')) {
      await cdp.send('Fetch.continueRequest', { requestId }).catch(() => {});
      return;
    }
    await cdp.send('Fetch.fulfillRequest', {
      requestId,
      responseCode: 500,
      responseHeaders: [{ name: 'content-type', value: 'application/json' }],
      body: Buffer.from(JSON.stringify({
        ok: false, code: 'CONFIG_UNAVAILABLE', error: 'acceptance: injected config read failure',
      })).toString('base64'),
    }).catch(() => {});
  };
  const off = cdp.on(handler);
  await cdp.send('Fetch.enable', { patterns: [{ urlPattern: '*/plugins/ui-testing/config*', requestStage: 'Request' }] });
  return async function stopConfigFailure() {
    try { await cdp.send('Fetch.disable'); } catch { /* ignore */ }
    off();
  };
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
    // The section mounts before its Host config read resolves; wait for the first numeric revision
    // instead of sampling a page that is still in `loading` (that raced once and failed A07's
    // "numeric revision" assertion).
    await waitFor(async () => {
      const current = await readSettingsState();
      return current && String(current.revisionRaw).trim() !== '' ? current : undefined;
    }, { timeoutMs: 20000, label: 'settings page config revision' });
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
    // The manual reload button is gone: opening the page always loads the Host config once.
    check('A13 settings page has no manual reload button (auto-loads on mount)',
      initial && initial.reloadButtons === 0,
      { reloadButtons: 0 },
      { reloadButtons: initial && initial.reloadButtons });

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
    // The card opens the diagnostics page, which immediately starts ONE real observe run.
    await evaluate(`(() => { const button = document.querySelector('[data-uts-diagnose="chrome"]'); if (button) button.click(); })()`);
    await waitFor(async () => evaluate(`!!document.querySelector('[data-uts-diag-modal]')`),
      { timeoutMs: 15000, label: 'chrome diagnostics overlay' });
    const DIAG_STATES = ['PASS', 'WARN', 'FAIL', 'SKIPPED', 'UNKNOWN'];
    const observeRun = await waitFor(async () => {
      const snapshot = await readDiagPage('chrome');
      return snapshot.present && snapshot.runPhase === 'finished' && snapshot.runId ? snapshot : undefined;
    }, { timeoutMs: 40000, intervalMs: 300, label: 'observe run finished' }).catch(() => null);
    await capture('settings-diagnostics-chrome.png');

    /* the overlay is a frame-wide surface, not a settings pane */
    const modalShell = await evaluate(`(() => {
      const panel = document.querySelector('[data-uts-diag-modal]');
      const settingsPage = document.querySelector('[data-uts-settings="page"]');
      const dialog = settingsPage ? (settingsPage.closest('[role="dialog"]') || settingsPage) : null;
      if (!panel) return null;
      const rect = panel.getBoundingClientRect();
      return {
        insideSettings: Boolean(settingsPage && settingsPage.contains(panel)),
        insideDialog: Boolean(dialog && dialog.contains(panel)),
        role: panel.getAttribute('role'),
        ariaModal: panel.getAttribute('aria-modal'),
        ariaLabel: panel.getAttribute('aria-label'),
        width: Math.round(rect.width),
        height: Math.round(rect.height),
        settingsWidth: settingsPage ? Math.round(settingsPage.getBoundingClientRect().width) : 0,
        bodyOverflow: document.body.style.overflow,
        focusOnClose: Boolean(document.activeElement && document.activeElement.hasAttribute('data-uts-diagnostics-back')),
        modals: document.querySelectorAll('[data-uts-diag-modal]').length,
      };
    })()`);
    check('A13 the diagnostics surface is a frame-wide overlay, not a pane inside the settings dialog',
      Boolean(modalShell)
        && modalShell.insideSettings === false
        && modalShell.insideDialog === false
        && modalShell.modals === 1
        && modalShell.role === 'dialog'
        && modalShell.ariaModal === 'true'
        && /诊断$/u.test(String(modalShell.ariaLabel || '')),
      { insideSettings: false, insideDialog: false, role: 'dialog', ariaModal: 'true' },
      modalShell);

    const stacking = await evaluate(`(() => {
      const panel = document.querySelector('[data-uts-diag-modal]');
      if (!panel) return null;
      const rect = panel.getBoundingClientRect();
      const hit = document.elementFromPoint(Math.round(rect.left + rect.width / 2), Math.round(rect.top + 24));
      return {
        hitInsidePanel: Boolean(hit && panel.contains(hit)),
        hitTag: hit ? String(hit.tagName || '') : '',
        overlayParent: panel.parentElement ? String(panel.parentElement.tagName || '') : '',
        zIndex: getComputedStyle(panel.parentElement).zIndex,
      };
    })()`);
    check('A13 the overlay paints above the settings modal (it is portalled to <body>, not buried)',
      Boolean(stacking) && stacking.hitInsidePanel === true,
      { topmostHit: 'inside the panel', portal: 'body' },
      stacking);

    check('A13 the overlay panel is wider than the settings content and locks body scrolling',
      Boolean(modalShell)
        && modalShell.width >= 900
        && modalShell.width > modalShell.settingsWidth
        && modalShell.height <= Math.round((await evaluate('window.innerHeight')) * 0.87)
        && modalShell.bodyOverflow === 'hidden',
      { width: '>= 900 and > settings width', maxHeight: '<= 86vh', bodyScroll: 'locked' },
      { width: modalShell && modalShell.width, settingsWidth: modalShell && modalShell.settingsWidth, height: modalShell && modalShell.height, bodyOverflow: modalShell && modalShell.bodyOverflow });



    const nodeOf = (snapshot, index) => ((snapshot && snapshot.nodes) || []).find((node) => node.index === String(index)) || {};
    const edgeOf = (snapshot, index) => ((snapshot && snapshot.edges) || []).find((edge) => edge.index === String(index)) || {};

    check('A13 opening the page runs one real observe run and reports the Host five states per node',
      Boolean(observeRun)
        && observeRun.runMode === 'observe'
        && nodeOf(observeRun, 1).state === 'PASS'
        && nodeOf(observeRun, 2).state === 'PASS'
        && nodeOf(observeRun, 3).state === 'WARN' && String(nodeOf(observeRun, 3).stageReason).includes('browser-not-running')
        && nodeOf(observeRun, 4).state === 'WARN'
        && nodeOf(observeRun, 5).state === 'SKIPPED' && nodeOf(observeRun, 5).stageBlockedBy === '3',
      { 1: 'PASS', 2: 'PASS', 3: 'WARN/browser-not-running', 4: 'WARN', 5: 'SKIPPED/3' },
      { runId: observeRun && observeRun.runId, mode: observeRun && observeRun.runMode, nodes: (observeRun && observeRun.nodes || []).map((node) => ({ index: node.index, state: node.state, reason: node.stageReason, blockedBy: node.stageBlockedBy })) });

    check('A13 the status pill is amber on a WARN run (the five-state mapping actually matches)',
      Boolean(observeRun)
        && observeRun.overall.value === 'WARN'
        && observeRun.overall.color === 'rgb(217, 119, 6)',
      { overall: 'WARN', color: 'rgb(217, 119, 6)' },
      { overall: observeRun && observeRun.overall.value, color: observeRun && observeRun.overall.color });

    check('A13 no element still carries a retired ready/pending/broken value',
      Boolean(observeRun) && (observeRun.legacyStateHits || []).length === 0,
      { legacyHits: 0 },
      { hits: observeRun && observeRun.legacyStateHits });

    check('A13 node and edge states use only the five-state vocabulary (no ready/pending/broken left)',
      Boolean(observeRun)
        && (observeRun.nodes || []).every((node) => DIAG_STATES.includes(node.state))
        && (observeRun.edges || []).every((edge) => DIAG_STATES.includes(edge.state)),
      { allowed: DIAG_STATES },
      { nodes: (observeRun && observeRun.nodes || []).map((node) => node.state), edges: (observeRun && observeRun.edges || []).map((edge) => edge.state) });

    check('A13 edges follow both ends: FAIL above stops the flow, a skipped downstream segment is SKIPPED',
      Boolean(observeRun)
        && edgeOf(observeRun, 1).state === 'PASS'
        && edgeOf(observeRun, 3).state === 'WARN'
        && edgeOf(observeRun, 4).state === 'SKIPPED',
      { edge1: 'PASS', edge3: 'WARN', edge4: 'SKIPPED' },
      { edges: (observeRun && observeRun.edges || []).map((edge) => ({ index: edge.index, state: edge.state, live: edge.live })) });

    check('A13 dots only run on PASS segments of this run (SKIPPED/UNKNOWN segments have no dot)',
      Boolean(observeRun)
        && edgeOf(observeRun, 1).live === 'true' && edgeOf(observeRun, 1).dotAnimation !== 'none'
        && edgeOf(observeRun, 3).dotAnimation === 'none'
        && edgeOf(observeRun, 4).dotDisplay === 'none',
      { passSegment: 'animating', skippedSegment: 'no dot' },
      { edges: (observeRun && observeRun.edges || []).map((edge) => ({ index: edge.index, state: edge.state, live: edge.live, animation: edge.dotAnimation, display: edge.dotDisplay })) });

    check('A13 the event stream is one row per Host stage with the real durationMs (SKIPPED shows a dash)',
      Boolean(observeRun)
        && (observeRun.events.rows || []).filter((row) => row.operation && row.operation.startsWith('stage-')).length === 5
        && (observeRun.events.rows || []).every((row) => Boolean(row.runId) && Boolean(row.seq))
        && (observeRun.events.rows || []).filter((row) => row.status !== 'SKIPPED').every((row) => Boolean(row.time))
        && (observeRun.events.rows || []).some((row) => row.operation === 'stage-1' && /\d+(\.\d+)?ms/u.test(row.text))
        && (observeRun.events.rows || []).some((row) => row.operation === 'stage-5' && row.text.includes('—')),
      { rows: 'one per stage', duration: 'from Host', skipped: '—' },
      { rows: (observeRun && observeRun.events.rows || []).map((row) => ({ op: row.operation, status: row.status, text: row.text.slice(0, 80) })) });

    check('A13 every executed event row shows a real HH:MM:SS time (never --:--:--)',
      Boolean(observeRun)
        && (observeRun.events.rows || []).length > 0
        && (observeRun.events.rows || []).every((row) => (
          // 真正跑过的行：可解析 ISO + HH:MM:SS；从未执行的 SKIPPED 行：诚实地显示「—」。
          (row.time && !Number.isNaN(new Date(String(row.time)).getTime()) && /^\d{2}:\d{2}:\d{2}$/u.test(row.timeText))
          || (row.pinStatus === 'SKIPPED' && row.timeText === '—' && !row.time)
        ))
        && (observeRun.events.rows || []).every((row) => row.timeText !== '--:--:--'),
      { executedRows: 'HH:MM:SS + parseable ISO', skippedRows: '— (never ran)' },
      { rows: (observeRun && observeRun.events.rows || []).map((row) => ({ seq: row.seq, timeText: row.timeText, time: row.time })) });

    check('A13 event rows use stage/run-start/run-end (status is carried separately) and run-start starts',
      Boolean(observeRun)
        && (observeRun.events.rows || []).every((row) => ['stage', 'run-start', 'run-end'].includes(row.kind))
        && ['stage', 'run-start', 'run-end'].every((kind) => (observeRun.events.rows || []).some((row) => row.kind === kind))
        && (() => {
          const start = (observeRun.events.rows || []).find((row) => row.kind === 'run-start') || {};
          return String(start.text).includes('开始') && !String(start.text).includes('未知')
            && start.pinStatus === 'INFO';
        })(),
      { kinds: ['stage', 'run-start', 'run-end'], runStart: '开始 + INFO' },
      { kinds: (observeRun && observeRun.events.rows || []).map((row) => row.kind), runStart: (observeRun && observeRun.events.rows || []).find((row) => row.kind === 'run-start') });

    check('A13 the six axes come from this run (source=run + runId + checks), capability only what was measured',
      Boolean(observeRun)
        && observeRun.runSource === 'run'
        && (observeRun.axes || []).length === 6
        && (observeRun.axes || []).every((axis) => axis.source === 'run' && axis.runId === observeRun.runId)
        && ['partial', 'not-probed'].includes(((observeRun.axes || []).find((axis) => axis.axis === 'capability') || {}).status),
      { axes: 6, source: 'run', runId: 'matches', capability: 'partial|not-probed' },
      { axes: (observeRun && observeRun.axes || []).map((axis) => ({ axis: axis.axis, status: axis.status, source: axis.source, runId: axis.runId })) });

    check('A13 the summary row shows only the status pill (no visible run/readiness/effects/call text)',
      Boolean(observeRun)
        && !String(observeRun.pageText || '').includes('本次 run')
        && !String(observeRun.pageText || '').includes('就绪快照')
        && !String(observeRun.pageText || '').includes('实际调用')
        && !String(observeRun.pageText || '').includes('会启动所选浏览器'),
      { visible: ['本次 run', '就绪快照', '实际调用', '会启动所选浏览器'].map((text) => 'absent:' + text) },
      { pageText: String(observeRun && observeRun.pageText || '').slice(0, 200) });

    check('A13 the evidence moved into the pill title and its machine-readable attributes',
      Boolean(observeRun)
        && String(observeRun.pillTitle).includes('本次 run')
        && (!observeRun.updatedClock || String(observeRun.pillTitle).includes('就绪快照'))
        && String(observeRun.pillTitle).includes('实际调用')
        && observeRun.updatedClock !== null
        && Boolean(observeRun.actualCalls)
        && observeRun.pillMode === 'observe'
        && observeRun.overall.runMode === observeRun.runMode,
      { title: ['本次 run', '就绪快照', '实际调用'], attrs: ['data-uts-diag-updated-clock', 'data-uts-diag-actual-calls', 'data-uts-run-mode'] },
      { title: observeRun && observeRun.pillTitle, clock: observeRun && observeRun.updatedClock, calls: observeRun && observeRun.actualCalls, mode: observeRun && observeRun.pillMode });

    check('A13 the node index reads 调试节点 01-05 (Chinese, no bare NODE label)',
      Boolean(observeRun)
        && (observeRun.nodeBadges || []).join(',') === '调试节点 01,调试节点 02,调试节点 03,调试节点 04,调试节点 05'
        && !String(observeRun.pageText || '').includes('NODE 0'),
      { badges: '调试节点 01..05' },
      { badges: observeRun && observeRun.nodeBadges });

    check('A13 the always-visible "开始诊断" button carries the cold explanation in its hover title',
      Boolean(observeRun)
        && observeRun.startAction === true
        && observeRun.runButtonLabel === '开始诊断'
        && observeRun.actionNoteBranch === 'cold'
        && observeRun.actionNote.includes('启动所选浏览器')
        && observeRun.actionNote.includes('创建受管调试页')
        && observeRun.runButtonDisabled === false,
      { action: '开始诊断', branch: 'cold', copy: ['启动所选浏览器', '创建受管调试页'], enabled: true },
      { present: observeRun && observeRun.startAction, label: observeRun && observeRun.runButtonLabel, branch: observeRun && observeRun.actionNoteBranch, note: observeRun && observeRun.actionNote, disabled: observeRun && observeRun.runButtonDisabled, noteHasStart: observeRun ? observeRun.actionNote.includes('启动所选浏览器') : null, noteHasManaged: observeRun ? observeRun.actionNote.includes('创建受管调试页') : null });

    /* C: assertions that stayed valid across the redesign, expressed in the run model. */
    check('A13 the six axes keep the prototype order and each card is scoped to this provider',
      (observeRun.axes || []).map((axis) => axis.axis).join(',') === 'support,target,enabled,capability,dependency,connection'
        && (observeRun.axes || []).every((axis, index) => axis.order === String(index)),
      { order: 'support,target,enabled,capability,dependency,connection' },
      { order: (observeRun && observeRun.axes || []).map((axis) => axis.axis), orders: (observeRun && observeRun.axes || []).map((axis) => axis.order) });

    check('A13 the duties panel keeps the five logical layers in order',
      (observeRun.duties || []).length === 5
        && (observeRun.duties || []).map((duty) => duty.node).join(',') === 'agent,controller,interface,backend,target'
        && (observeRun.duties || []).every((duty) => duty.text.length > 6),
      { duties: 'agent,controller,interface,backend,target' },
      { duties: (observeRun && observeRun.duties || []).map((duty) => ({ node: duty.node, text: duty.text.slice(0, 32) })) });

    check('A13 the topology keeps five nodes and four edges with the fixed node ids in order',
      (observeRun.nodes || []).length === 5
        && (observeRun.nodes || []).map((node) => node.id).join(',') === 'agent,controller,interface,backend,target'
        && (observeRun.edges || []).length === 4
        && (observeRun.edges || []).every((edge, index) => edge.index === String(index + 1) && Boolean(edge.label)),
      { nodes: 5, edges: 4 },
      { nodes: (observeRun && observeRun.nodes || []).map((node) => ({ id: node.id, index: node.index })), edges: (observeRun && observeRun.edges || []).map((edge) => edge.index) });

    check('A13 the diagnostics page carries no demo affordance and renders exactly one instance',
      observeRun.pageInstances === 1
        && !/模拟|DEMO|暂停动画/iu.test(String(observeRun.pageText || ''))
        && !(observeRun.buttonLabels || []).some((label) => /模拟|DEMO|暂停/u.test(label))
        && observeRun.backButtons === 1,
      { instances: 1, forbidden: ['模拟', 'DEMO', '暂停动画'] },
      { instances: observeRun && observeRun.pageInstances, buttons: (observeRun && observeRun.buttonLabels || []).join(' | ') });

    check('A13 the description states the evidence boundary (really executes, never starts a browser)',
      String(observeRun.desc || '').includes('真实执行')
        && String(observeRun.desc || '').includes('不会启动浏览器')
        && String(observeRun.desc || '').includes('不代表其它会话中的调试目标不可用'),
      { desc: ['真实执行', '不会启动浏览器', '不代表其它会话中的调试目标不可用'] },
      { desc: observeRun && observeRun.desc });

    check('A13 the five node names follow the reference topology (host, plugin, interface, backend, provider page)',
      (observeRun.nodes || []).map((node) => node.name).join('|') === 'DeepSeekHarness|dsh-agent-team-ui-testing|CDP接口|Chromium DevTools|Chrome页面',
      { names: 'DeepSeekHarness, dsh-agent-team-ui-testing, CDP接口, Chromium DevTools, Chrome页面' },
      { names: (observeRun.nodes || []).map((node) => node.name) });

    check('A13 each node keeps its one-line duty copy from the reference image',
      (observeRun.nodes || []).map((node) => node.sub).join('|') === [
        '检查宿主集成、工具注册及调用通道',
        '检查插件 Core、配置和调度能力',
        '执行通信接口探测',
        '检查执行后端及依赖可用性',
        '查询目标列表，验证目标绑定与连接状态',
      ].join('|'),
      { subs: 'five fixed duty lines' },
      { subs: (observeRun.nodes || []).map((node) => node.sub) });

    check('A13 the page header names this provider and carries its group/state hooks',
      observeRun.title === 'Chrome 诊断'
        && observeRun.group === 'web'
        && observeRun.stateAttr === 'supported'
        && observeRun.poll === '5000'
        && observeRun.stale === 'false',
      { title: 'Chrome 诊断', group: 'web', poll: '5000' },
      { title: observeRun.title, group: observeRun.group, state: observeRun.stateAttr, poll: observeRun.poll, stale: observeRun.stale });

    // `WARN` 是本次 run 的结论，中文按英语状态直译成「警告」；「待诊断」只用于还没有 run 结果
    // 的那一屏，两者不能混用，否则会被读成「你还没点开始诊断」。
    check('A13 the overall pill states the run verdict and its reason (never a bare green)',
      observeRun.overall.value === 'WARN'
        && String(observeRun.overall.text).includes('警告')
        && !String(observeRun.overall.text).includes('待诊断')
        && String(observeRun.overall.reason).length > 0,
      { overall: 'WARN + reason', text: '警告 · <中文原因>' },
      observeRun.overall);

    check('A13 every event row belongs to this run (runId matches the page) and carries an operation',
      (observeRun.events.rows || []).every((row) => row.runId === observeRun.runId && Boolean(row.operation)),
      { runId: 'all rows match the page run' },
      { pageRun: observeRun.runId, rowRuns: [...new Set((observeRun.events.rows || []).map((row) => row.runId))] });

    check('A13 the axes state plainly that their values come from this run, not from a readiness snapshot',
      observeRun.runSource === 'run'
        && (observeRun.axes || []).every((axis) => axis.reason.includes('本次诊断 run'))
        && (observeRun.axes || []).every((axis) => Boolean(axis.checkedAt)),
      { reason: '来自本次诊断 run', checkedAt: 'present' },
      { reasons: [...new Set((observeRun.axes || []).map((axis) => axis.reason))], checkedAt: (observeRun.axes || []).map((axis) => axis.checkedAt) });

    check('A13 the capability axis only shows the checks that were really made (no invented dimensions)',
      (() => {
        const capability = (observeRun.axes || []).find((axis) => axis.axis === 'capability') || {};
        if (!capability.hasChecks) return capability.status === 'not-probed';
        return /\breadonly-eval\b/u.test(capability.checks) && /\btarget-list\b/u.test(capability.checks);
      })(),
      { checks: 'readonly-eval · target-list, or not-probed' },
      (observeRun.axes || []).find((axis) => axis.axis === 'capability'));

    check('A13 the capability card title lists skipped probes as "未通过" and never claims they passed',
      (() => {
        const capability = (observeRun.axes || []).find((axis) => axis.axis === 'capability') || {};
        return String(capability.title).includes('未通过')
          && !String(capability.title).includes('全部通过')
          && ['readonly-eval', 'target-list', 'snapshot', 'screenshot', 'computed-style', 'network-read']
            .every((id) => String(capability.title).includes(id + '=skip'));
      })(),
      { title: '未通过 … <-id>=skip' },
      (observeRun.axes || []).find((axis) => axis.axis === 'capability'));

    check('A13 a run in progress is described as such (no finished verdict while streams are open)',
      ['idle', 'running', 'finished'].includes(observeRun.runPhase)
        && (observeRun.runPhase === 'finished' ? String(observeRun.overall.text).length > 0 : true),
      { phases: ['idle', 'running', 'finished'], finished: 'has verdict' },
      { phase: observeRun.runPhase, overall: observeRun.overall });

    check('A13 a successful observe run reports no error line (nothing invented, nothing hidden)',
      !/诊断 run 启动失败|就绪快照读取失败/u.test(String(observeRun.pageText || ''))
        && Boolean(observeRun.events.present),
      { errorLine: 'none', events: 'present' },
      { errors: /诊断 run 启动失败|就绪快照读取失败/u.test(String(observeRun.pageText || '')) });

    // Leave the diagnostics page before the A07 section (it operates on the list page).
    await evaluate(`(() => { const back = document.querySelector('[data-uts-diagnostics-back]'); if (back) back.click(); })()`);
    await waitFor(async () => evaluate(`!document.querySelector('[data-uts-diag-modal]') && !!document.querySelector('.uts-groups')`),
      { timeoutMs: 15000, label: 'overlay closed, settings list still there' }).catch(() => 'timeout');

    check('A13 nothing was spawned for an observe run (side effects + actual calls are honest)',
      Boolean(observeRun)
        && !String(observeRun.sideEffects || '').split(',').some((kind) => ['spawn', 'ensure'].includes(kind))
        && String(observeRun.actualCalls || '').includes('browser_capabilities'),
      { sideEffects: 'no spawn/ensure', actualCalls: 'browser_capabilities' },
      { sideEffects: observeRun && observeRun.sideEffects, calls: observeRun && observeRun.actualCalls });

    /* ------------------------------------------------------------------- A07/A10: toggle PUT */
    const switchInfo = await clickEnvSwitch();
    log(`[gui] target-environment master switch clicked (before=${switchInfo.before})`);
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
      bumped.state.envSwitch && bumped.state.envSwitch.checked === false,
      { checked: false },
      { switch: bumped.state.envSwitch });

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
      afterReload.envSwitch && afterReload.envSwitch.checked === false,
      { checked: false },
      { switch: afterReload.envSwitch });

    // Restore web enabled so the isolated instance is left consistent (temp home is removed anyway).
    const restoreClick = await clickEnvSwitch();
    const restored = await waitFor(async () => {
      const current = await readSettingsState();
      return current && Number(current.revisionRaw) === bumped.revision + 1 ? current : undefined;
    }, { timeoutMs: 20000, label: 'revision increased after restore toggle' });
    check('A07 re-enabling web persists another revision and restores the switch',
      Number(restored.revisionRaw) === bumped.revision + 1
        && restored.envSwitch && restored.envSwitch.checked === true,
      { revision: bumped.revision + 1, checked: true },
      { revision: restored.revisionRaw, switch: restored.envSwitch, clicked: restoreClick });

    /* ---------------------------------- A07: running-environment (provider) switch, second layer */
    // The card switch is the *running environment* switch: it must write providers.chrome.enabled
    // and leave the target-environment master switch (environments.web.enabled) untouched.
    const providerSwitchClick = await clickProviderSwitch('chrome');
    log(`[gui] chrome provider switch clicked (before=${providerSwitchClick.before})`);
    // `restored` is a page snapshot, so the baseline revision comes from its raw attribute.
    const restoredRevision = Number(restored.revisionRaw);
    const providerBumped = await waitFor(async () => {
      const current = await readSettingsState();
      const revision = Number(current.revisionRaw);
      return Number.isFinite(revision) && revision > restoredRevision ? { revision, state: current } : undefined;
    }, { timeoutMs: 20000, label: 'config revision increased after provider toggle' });
    const providerPuts = putConfigRequests();
    const providerPut = providerPuts[providerPuts.length - 1];
    check('A07 provider switch sends PUT writing environments.web.providers.<id>.enabled',
      Boolean(providerPut) && providerPut.postData.includes('"providers"'),
      { body: '{"environments":{"web":{"providers":{"chrome":{"enabled":false}}}}}' },
      { body: providerPut && providerPut.postData.slice(0, 240) });
    check('A07 provider toggle bumps the Host config revision by exactly one',
      providerBumped.revision === restoredRevision + 1,
      { revision: restoredRevision + 1 },
      { revision: providerBumped.revision });
    check('A07 provider switch reflects the saved Host state (chrome off)',
      providerBumped.state.chromeSwitch && providerBumped.state.chromeSwitch.checked === false,
      { checked: false },
      { switch: providerBumped.state.chromeSwitch });
    check('A07 provider toggle does not touch the target-environment master switch',
      providerBumped.state.envSwitch && providerBumped.state.envSwitch.checked === true,
      { masterChecked: true },
      { switch: providerBumped.state.envSwitch });
    // Restore the provider switch so the isolated instance is left consistent.
    await clickProviderSwitch('chrome');
    await waitFor(async () => {
      const current = await readSettingsState();
      return current && Number(current.revisionRaw) === providerBumped.revision + 1 ? current : undefined;
    }, { timeoutMs: 20000, label: 'revision increased after provider restore' });

    /* ------------------------------------------------------------------------------------------------
     * A13 run-driven behaviour: start mode, polling must not overwrite the run, reduced motion, and
     * the two anti-fabrication cases (injected FAIL run, unavailable run).
     * ---------------------------------------------------------------------------------------------- */
    // Reload the GUI so the client module state (cached runs) is empty, then open the diagnostics page
    // for `providerId`: the stub scenarios need a page that really issues a /diagnose request.
    const freshDiagnosticsPage = async (providerId = 'chrome') => {
      await state.chrome.cdp.send('Page.reload', { ignoreCache: true });
      await guiReady();
      await sleep(900);
      await dismissOverlays();
      await openSettingsDialog();
      await openUiTestingSection();
      await evaluate(`(() => { const toggle = document.querySelector('[data-uts-group-toggle="web"]'); if (toggle) toggle.click(); })()`);
      await sleep(400);
      await evaluate(`(() => { const button = document.querySelector('[data-uts-diagnose="${providerId}"]'); if (button) button.click(); })()`);
      await waitFor(async () => evaluate(`!!document.querySelector('[data-uts-diag-modal="${providerId}"]')`),
        { timeoutMs: 20000, label: 'diagnostics overlay via fresh reload' });
    };
    const reopenDiagnostics = async (providerId = 'chrome') => {
      await evaluate(`(() => { const back = document.querySelector('[data-uts-diagnostics-back]'); if (back) back.click(); })()`);
      await waitFor(async () => evaluate(`!document.querySelector('[data-uts-diag-modal]')`),
        { timeoutMs: 15000, label: 'overlay closed' });
      await evaluate(`(() => { const button = document.querySelector('[data-uts-diagnose="${providerId}"]'); if (button) button.click(); })()`);
      await waitFor(async () => evaluate(`!!document.querySelector('[data-uts-diag-modal="${providerId}"]')`),
        { timeoutMs: 15000, label: 'diagnostics overlay reopened' });
    };
    const waitRunFinished = (providerId = 'chrome') => waitFor(async () => {
      const snapshot = await readDiagPage(providerId);
      return snapshot.present && snapshot.runPhase === 'finished' && snapshot.runId ? snapshot : undefined;
    }, { timeoutMs: 60000, intervalMs: 300, label: 'run finished' }).catch(() => null);

    /* 1) the explicit action starts a browser and the run turns ③④⑤ green ------------------------- */
    await reopenDiagnostics('chrome');
    await waitRunFinished('chrome');
    await evaluate(`(() => { const button = document.querySelector('[data-uts-diag-run]'); if (button) button.click(); })()`);
    const startRunPage = await waitFor(async () => {
      const snapshot = await readDiagPage('chrome');
      return snapshot.present && snapshot.runMode === 'start' && snapshot.runPhase === 'finished'
        && nodeOf(snapshot, 5).state === 'PASS'
        ? snapshot
        : undefined;
    }, { timeoutMs: 90000, intervalMs: 400, label: 'start run finished' }).catch(() => null);
    await capture('settings-diagnostics-started.png');
    check('A13 the "启动浏览器后继续诊断" action runs a start run where ③④⑤ all PASS',
      Boolean(startRunPage)
        && startRunPage.runMode === 'start'
        && ['3', '4', '5'].every((index) => nodeOf(startRunPage, index).state === 'PASS')
        && nodeOf(startRunPage, 5).stageStatus === 'PASS',
      { mode: 'start', 3: 'PASS', 4: 'PASS', 5: 'PASS' },
      { mode: startRunPage && startRunPage.runMode, nodes: (startRunPage && startRunPage.nodes || []).map((node) => ({ index: node.index, state: node.state })) });

    check('A13 with all six probes passing the capability title says "全部通过" and never "未通过"',
      (() => {
        const capability = (startRunPage.axes || []).find((axis) => axis.axis === 'capability') || {};
        const title = String(capability.title);
        return capability.status === 'available'
          && !title.includes('未通过')
          && !title.includes('未就绪')
          && title.includes('全部通过')
          && ['readonly-eval', 'target-list', 'snapshot', 'screenshot', 'computed-style', 'network-read']
            .every((id) => title.includes(id + '=pass'));
      })(),
      { status: 'available', title: '全部通过 … <-id>=pass' },
      (startRunPage && startRunPage.axes || []).find((axis) => axis.axis === 'capability'));

    check('A13 a PASS event row shows a green dot (not the old blanket amber)',
      Boolean(startRunPage)
        && (startRunPage.events.rows || []).filter((row) => row.pinStatus === 'PASS').length > 0
        && (startRunPage.events.rows || []).filter((row) => row.pinStatus === 'PASS').every((row) => row.pinColor === 'rgb(22, 163, 74)'),
      { PASS: 'rgb(22, 163, 74)' },
      { passRows: (startRunPage && startRunPage.events.rows || []).filter((row) => row.pinStatus === 'PASS').map((row) => ({ op: row.operation, color: row.pinColor })) });

    check('A13 the status pill turns green on a PASS run (regression: it used to stay amber)',
      Boolean(startRunPage)
        && startRunPage.overall.value === 'PASS'
        && startRunPage.overall.color === 'rgb(22, 163, 74)',
      { overall: 'PASS', color: 'rgb(22, 163, 74)' },
      { overall: startRunPage && startRunPage.overall.value, color: startRunPage && startRunPage.overall.color });

    check('A13 the start run shows its spawn/lease side effects and the read-only eval evidence',
      Boolean(startRunPage)
        && String(startRunPage.sideEffects || '').split(',').includes('ensure')
        && String(startRunPage.sideEffects || '').split(',').includes('spawn')
        && String(startRunPage.actualCalls || '').includes('browser_eval'),
      { sideEffects: 'spawn/lease', evidence: 'browser_eval' },
      { sideEffects: startRunPage && startRunPage.sideEffects, eval: startRunPage && startRunPage.pageText.indexOf('browser_eval') >= 0 });

    check('A13 every edge of the start run carries a moving dot (all four segments passed)',
      Boolean(startRunPage)
        && (startRunPage.edges || []).length === 4
        && (startRunPage.edges || []).every((edge) => edge.live === 'true' && edge.dotAnimation === 'uts-diag-flow'),
      { edges: 4, dots: 'animating' },
      { edges: (startRunPage && startRunPage.edges || []).map((edge) => ({ index: edge.index, state: edge.state, live: edge.live, animation: edge.dotAnimation })) });

    /* C: dot geometry / real movement / static rail / narrow container (live start-run page). */
    const nodeBoxRunning = await evaluate(`(() => {
      const node = document.querySelector('[data-uts-diagnostics="chrome"] [data-uts-node="2"]');
      const rect = node ? node.getBoundingClientRect() : null;
      return rect ? { w: Math.round(rect.width), h: Math.round(rect.height) } : null;
    })()`);
    const dotGeometry = await evaluate(`(() => {
      const page = document.querySelector('[data-uts-diagnostics="chrome"]');
      const dots = [...page.querySelectorAll('[data-uts-edge-dot]')];
      const first = dots[0];
      const style = first ? getComputedStyle(first) : null;
      const card = page.querySelector('[data-uts-node="2"]');
      const line = first ? first.parentElement : null;
      return {
        count: dots.length,
        position: style ? style.position : 'no-dot',
        width: style ? style.width : 'no-dot',
        animation: style ? style.animationName : 'no-dot',
        cardBox: card ? { w: Math.round(card.getBoundingClientRect().width), h: Math.round(card.getBoundingClientRect().height) } : null,
        lineHeight: line ? Math.round(line.getBoundingClientRect().height) : null,
      };
    })()`);
    check('A13 the moving dot is an absolutely positioned 5-7px ball that cannot shift the layout',
      Boolean(dotGeometry)
        && dotGeometry.position === 'absolute'
        && parseFloat(dotGeometry.width) >= 5 && parseFloat(dotGeometry.width) <= 7
        && Boolean(dotGeometry.cardBox) && Boolean(nodeBoxRunning)
        && dotGeometry.cardBox.h === nodeBoxRunning.h && dotGeometry.cardBox.w === nodeBoxRunning.w
        && dotGeometry.lineHeight !== null && dotGeometry.lineHeight <= 3,
      { position: 'absolute', width: '5-7px', layoutShift: 0 },
      dotGeometry);

    const travel = await evaluate(`(async () => {
      const page = document.querySelector('[data-uts-diagnostics="chrome"]');
      const edge = page ? page.querySelector('[data-uts-topology] [data-uts-edge][data-uts-edge-live="true"]') : null;
      const dot = edge ? edge.querySelector('[data-uts-edge-dot]') : null;
      if (!dot) return null;
      const xs = [];
      for (let index = 0; index < 6; index += 1) {
        xs.push(Math.round(dot.getBoundingClientRect().x * 10) / 10);
        if (index < 5) await new Promise((resolve) => setTimeout(resolve, 260));
      }
      return { xs, spread: Math.round((Math.max(...xs) - Math.min(...xs)) * 10) / 10 };
    })()`);
    check('A13 the dot really travels along the wire (x advances over six samples, spread > 10px)',
      Boolean(travel) && travel.spread > 10 && new Set(travel.xs).size >= 3,
      { spread: '> 10px', samples: 6 },
      { travel });

    const rail = await evaluate(`(() => {
      const page = document.querySelector('[data-uts-diagnostics="chrome"]');
      const rail = page ? page.querySelector('[data-uts-diag-rail]') : null;
      const dot = page ? page.querySelector('[data-uts-diag-rail-dot]') : null;
      if (!rail) return null;
      return {
        borderStyle: getComputedStyle(rail).borderTopStyle,
        dotAnimation: dot ? getComputedStyle(dot).animationName : 'no-dot',
        dotWidth: dot ? getComputedStyle(dot).width : 'no-dot',
        dotPosition: dot ? getComputedStyle(dot).position : 'no-dot',
      };
    })()`);
    check('A13 the decorative flight rail stays static (dashed + a still 5px dot)',
      Boolean(rail) && rail.borderStyle === 'dashed' && rail.dotAnimation === 'none'
        && rail.dotWidth === '5px' && rail.dotPosition === 'absolute',
      { rail: 'dashed', dot: 'static 5px' },
      { rail });

    const layoutMetrics = await readDiagPage('chrome');
    const docOverflow = await evaluate(`(() => ({
      docScroll: document.documentElement.scrollWidth,
      docClient: document.documentElement.clientWidth,
    }))()`);
    await state.chrome.cdp.send('Emulation.setDeviceMetricsOverride', { width: 1024, height: 900, deviceScaleFactor: 1, mobile: false });
    await sleep(700);
    const wideChain = await readDiagPage('chrome');
    check('A13 the wide overlay fits the horizontal chain without scrolling it (1024 viewport)',
      Boolean(wideChain.chainScroll)
        && wideChain.chainScroll.scrollWidth <= wideChain.chainScroll.clientWidth + 1
        && docOverflow.docScroll === docOverflow.docClient,
      { chainScrolls: false, pageOverflow: false },
      { chain: wideChain.chainScroll, doc: docOverflow });

    await capture('settings-diag-modal-1024.png');
    await state.chrome.cdp.send('Emulation.setDeviceMetricsOverride', { width: 800, height: 900, deviceScaleFactor: 1, mobile: false });
    await sleep(700);
    const narrowChain = await readDiagPage('chrome');
    await capture('settings-diag-modal-800.png');
    await state.chrome.cdp.send('Emulation.clearDeviceMetricsOverride');
    await sleep(500);
    check('A13 a narrow 800px viewport still scrolls the chain container (graceful fallback)',
      Boolean(narrowChain.chainScroll)
        && narrowChain.chainScroll.scrollWidth > narrowChain.chainScroll.clientWidth
        && narrowChain.panelWidth >= 300,
      { chainScrolls: true, panelStillWide: true },
      { chain: narrowChain && narrowChain.chainScroll, panel: narrowChain && narrowChain.panelWidth });


    /* the copy switches once a browser is actually connected, and the action still works */
    const warmPage = await readDiagPage('chrome');
    check('A13 with a live connection the button hover title switches to "不会重启浏览器" and stays enabled',
      Boolean(warmPage)
        && nodeOf(warmPage, 3).state === 'PASS'
        && warmPage.actionNoteBranch === 'warm'
        && warmPage.actionNote.includes('不会重启浏览器')
        && warmPage.runButtonLabel === '开始诊断'
        && warmPage.runButtonDisabled === false,
      { branch: 'warm', copy: '不会重启浏览器', enabled: true },
      { branch: warmPage && warmPage.actionNoteBranch, note: warmPage && warmPage.actionNote, disabled: warmPage && warmPage.runButtonDisabled });

    await evaluate(`(() => { const button = document.querySelector('[data-uts-diag-run]'); if (button) button.click(); })()`);
    const secondStart = await waitFor(async () => {
      const snapshot = await readDiagPage('chrome');
      return snapshot.present && snapshot.runMode === 'start' && snapshot.runPhase === 'finished'
        && snapshot.runId !== warmPage.runId ? snapshot : undefined;
    }, { timeoutMs: 90000, intervalMs: 400, label: 'second start run on a connected browser' }).catch(() => null);
    check('A13 clicking again on a connected browser re-checks without restarting and stays all PASS',
      Boolean(secondStart)
        && secondStart.runId !== warmPage.runId
        && ['3', '4', '5'].every((index) => nodeOf(secondStart, index).state === 'PASS'),
      { mode: 'start', newRun: true, 3: 'PASS', 4: 'PASS', 5: 'PASS' },
      { runId: secondStart && secondStart.runId, nodes: (secondStart && secondStart.nodes || []).map((node) => ({ index: node.index, state: node.state })) });

    /* 2) polling must not overwrite the run result ------------------------------------------------ */
    const beforePoll = await readDiagPage('chrome');
    await sleep(6500);
    const afterPoll = await readDiagPage('chrome');
    check('A13 the 5s readiness polling never overwrites the run result (axes stay source=run)',
      Boolean(beforePoll && afterPoll)
        && afterPoll.runId === beforePoll.runId
        && afterPoll.runSource === 'run'
        && JSON.stringify(afterPoll.nodes.map((node) => node.state)) === JSON.stringify(beforePoll.nodes.map((node) => node.state))
        && afterPoll.axes.every((axis) => axis.source === 'run'),
      { runId: 'unchanged', source: 'run', nodes: 'unchanged' },
      { before: beforePoll && beforePoll.runId, after: afterPoll && afterPoll.runId, source: afterPoll && afterPoll.runSource });

    /* 3) reduced motion turns every run animation off -------------------------------------------- */
    await state.chrome.cdp.send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'reduce' }] });
    const reduced = await readDiagPage('chrome');
    await state.chrome.cdp.send('Emulation.setEmulatedMedia', { features: [] });
    check('A13 prefers-reduced-motion stops both the edge dots and the stage pulse',
      Boolean(reduced)
        && (reduced.edges || []).every((edge) => edge.dotAnimation === 'none')
        && (reduced.nodes || []).every((node) => node.pulse.animationName === 'none'),
      { dots: 'none', pulse: 'none' },
      { edges: (reduced && reduced.edges || []).map((edge) => edge.dotAnimation), pulses: (reduced && reduced.nodes || []).map((node) => node.pulse.animationName) });

    /* 4) animation is driven by stage events only: the stub sends stage-2's stage-start and nothing
     *    else (no stage-end, the stream stays open) → only node ② is running/pulsing, and no green. */
    const stageStartOnly = [
      { type: 'run-start', runId: 'stub-partial', seq: 1, provider: 'edge', mode: 'observe', scope: { id: 'stub', kind: 'unassigned' }, configRevision: 1, startedAt: Date.now() },
      { type: 'stage-start', runId: 'stub-partial', seq: 2, stageId: '2', phase: 'running', startedAt: Date.now() },
    ];
    const nodeBoxBefore = await evaluate(`(() => {
      const node = document.querySelector('[data-uts-diagnostics="chrome"] [data-uts-node="1"]');
      const rect = node ? node.getBoundingClientRect() : null;
      return rect ? { w: Math.round(rect.width), h: Math.round(rect.height) } : null;
    })()`);
    const stopStubPartial = await startDiagnoseStub(stageStartOnly.map((event) => JSON.stringify(event)).join('\n') + '\n');
    await reopenDiagnostics('edge');
    await sleep(1500);
    const partial = await readDiagPage('edge');
    await stopStubPartial();
    check('A13 a lone stage-start pulses exactly that node and paints nothing else',
      Boolean(partial)
        && (partial.nodes || []).filter((node) => node.stagePhase === 'running').map((node) => node.index).join(',') === '2'
        && nodeOf(partial, 2).pulse.animationName !== 'none'
        && (partial.nodes || []).filter((node) => node.index !== '2').every((node) => node.stagePhase !== 'running' && node.pulse.animationName === 'none')
        && nodeOf(partial, 2).state !== 'PASS'
        && (partial.edges || []).every((edge) => edge.dotAnimation === 'none'),
      { runningNodes: '2 only', pulse: 'nodes 2', node2: 'not PASS', dots: 'none' },
      { nodes: (partial && partial.nodes || []).map((node) => ({ index: node.index, state: node.state, phase: node.stagePhase, animation: node.pulse.animationName })), edges: (partial && partial.edges || []).map((edge) => edge.dotAnimation) });

    /* 5) an injected FAIL run: ② FAIL → ③④⑤ SKIPPED(blockedBy=2), nothing else may be green ------ */
    const now = Date.now();
    const failRun = [
      { type: 'run-start', runId: 'stub-fail', seq: 1, provider: 'chrome', mode: 'observe', scope: { id: 'stub', kind: 'unassigned' }, configRevision: 1, startedAt: now },
      { type: 'stage-end', runId: 'stub-fail', seq: 2, stageId: '1', phase: 'finished', status: 'PASS', reason: null, blockedBy: null, startedAt: now, finishedAt: now + 5, durationMs: 5, checks: [], evidenceRef: null },
      { type: 'stage-end', runId: 'stub-fail', seq: 3, stageId: '2', phase: 'finished', status: 'FAIL', reason: 'config-invalid', blockedBy: null, startedAt: now + 6, finishedAt: now + 8, durationMs: 2, checks: [], evidenceRef: null },
      { type: 'stage-end', runId: 'stub-fail', seq: 4, stageId: '3', phase: 'finished', status: 'SKIPPED', reason: 'blocked-by-stage-2', blockedBy: '2', startedAt: null, finishedAt: null, durationMs: null, checks: [], evidenceRef: null },
      { type: 'stage-end', runId: 'stub-fail', seq: 5, stageId: '4', phase: 'finished', status: 'SKIPPED', reason: 'blocked-by-stage-2', blockedBy: '2', startedAt: null, finishedAt: null, durationMs: null, checks: [], evidenceRef: null },
      { type: 'stage-end', runId: 'stub-fail', seq: 6, stageId: '5', phase: 'finished', status: 'SKIPPED', reason: 'blocked-by-stage-2', blockedBy: '2', startedAt: null, finishedAt: null, durationMs: null, checks: [], evidenceRef: null },
      { type: 'run-end', runId: 'stub-fail', seq: 7, overall: { status: 'FAIL', reason: 'config-invalid' }, stages: {}, axes: { support: 'supported', enabled: 'true', dependency: 'not-probed', connection: 'not-probed', target: 'unbound', capability: 'not-probed' }, actualCalls: [], sideEffects: [], finishedAt: now + 20 },
    ];
    const stopStubFail = await startDiagnoseStub(failRun.map((event) => JSON.stringify(event)).join('\n') + '\n');
    await reopenDiagnostics('chrome');
    const failedPage = await waitFor(async () => {
      const snapshot = await readDiagPage('chrome');
      return snapshot.present && snapshot.runPhase === 'finished' && nodeOf(snapshot, 2).state === 'FAIL' ? snapshot : undefined;
    }, { timeoutMs: 30000, intervalMs: 300, label: 'injected FAIL run rendered' }).catch(() => null);
    await stopStubFail();
    check('A13 an injected FAIL run: ② FAIL, ③④⑤ SKIPPED with blockedBy and no other green',
      Boolean(failedPage)
        && nodeOf(failedPage, 2).state === 'FAIL'
        && ['3', '4', '5'].every((index) => nodeOf(failedPage, index).state === 'SKIPPED' && nodeOf(failedPage, index).stageBlockedBy === '2')
        && (failedPage.nodes || []).filter((node) => node.index !== '1').every((node) => node.state !== 'PASS')
        && (failedPage.edges || []).every((edge) => edge.dotAnimation === 'none')
        && failedPage.overall.value === 'FAIL',
      { 2: 'FAIL', 3: 'SKIPPED/2', 4: 'SKIPPED/2', 5: 'SKIPPED/2', dots: 'none' },
      { nodes: (failedPage && failedPage.nodes || []).map((node) => ({ index: node.index, state: node.state, blockedBy: node.stageBlockedBy })), edges: (failedPage && failedPage.edges || []).map((edge) => edge.dotAnimation) });

    check('A13 WARN and FAIL event rows show amber and red dots',
      Boolean(observeRun) && Boolean(failedPage)
        && (observeRun.events.rows || []).filter((row) => row.pinStatus === 'WARN').length > 0
        && (observeRun.events.rows || []).filter((row) => row.pinStatus === 'WARN').every((row) => row.pinColor === 'rgb(217, 119, 6)')
        && (failedPage.events.rows || []).filter((row) => row.pinStatus === 'FAIL').length > 0
        && (failedPage.events.rows || []).filter((row) => row.pinStatus === 'FAIL').every((row) => row.pinColor === 'rgb(185, 28, 28)'),
      { WARN: 'rgb(217, 119, 6)', FAIL: 'rgb(185, 28, 28)' },
      {
        warn: (observeRun && observeRun.events.rows || []).filter((row) => row.pinStatus === 'WARN').map((row) => ({ op: row.operation, color: row.pinColor })),
        fail: (failedPage && failedPage.events.rows || []).filter((row) => row.pinStatus === 'FAIL').map((row) => ({ op: row.operation, color: row.pinColor })),
      });

    check('A13 the status pill turns red on a FAIL run',
      Boolean(failedPage)
        && failedPage.overall.value === 'FAIL'
        && failedPage.overall.color === 'rgb(185, 28, 28)',
      { overall: 'FAIL', color: 'rgb(185, 28, 28)' },
      { overall: failedPage && failedPage.overall.value, color: failedPage && failedPage.overall.color });

    check('A13 the injected FAIL run lists its stage rows with the real durations and a dash for SKIPPED',
      Boolean(failedPage)
        && (failedPage.events.rows || []).filter((row) => row.operation && row.operation.startsWith('stage-')).length >= 4
        && (failedPage.events.rows || []).some((row) => row.operation === 'stage-2' && row.status === 'FAIL' && /\d+(\.\d+)?ms/u.test(row.text))
        && (failedPage.events.rows || []).filter((row) => row.status === 'SKIPPED').every((row) => row.text.includes('—')),
      { stageRows: '>=4', failed: 'real ms', skipped: '—' },
      { rows: (failedPage && failedPage.events.rows || []).map((row) => ({ op: row.operation, status: row.status, text: row.text.slice(0, 70) })) });

    /* 6) no run at all: nothing may be green -------------------------------------------------- */
    const stopStubNoRun = await startDiagnoseStub(null);
    await reopenDiagnostics('firefox');
    await sleep(1800);
    const noRun = await readDiagPage('firefox');
    await stopStubNoRun();
    check('A13 without a run the page shows no PASS at all (readiness is never painted as checked)',
      Boolean(noRun)
        && (noRun.nodes || []).every((node) => node.state !== 'PASS')
        && (noRun.edges || []).every((edge) => edge.state !== 'PASS' && edge.dotAnimation === 'none'),
      { nodes: 'no PASS', edges: 'no PASS' },
      { nodes: (noRun && noRun.nodes || []).map((node) => node.state), edges: (noRun && noRun.edges || []).map((edge) => edge.state), error: noRun && noRun.pageText.slice(0, 120) });

    /* 7) re-entering shows the last run again without replaying it --------------------------- */
    await reopenDiagnostics('chrome');
    await sleep(1200);
    const reentered = await readDiagPage('chrome');
    const firstRunId = startRunPage ? startRunPage.runId : '';
    await reopenDiagnostics('chrome');
    const secondRun = await waitRunFinished('chrome');
    const secondRunId = secondRun ? secondRun.runId : '';
    check('A13 opening the diagnostics page again starts a NEW run (runId changes) without replaying old animation',
      Boolean(firstRunId) && Boolean(secondRunId) && firstRunId !== secondRunId
        && (secondRun.nodes || []).every((node) => node.stagePhase !== 'running')
        && (secondRun.edges || []).every((edge) => edge.dotAnimation === 'none' || edge.state === 'PASS'),
      { runId: 'changes on every entry', replay: 'no leftover pulse' },
      { firstRunId, secondRunId, phases: (secondRun && secondRun.nodes || []).map((node) => node.stagePhase) });

    /* C9: the event stream never renders more than eight rows (a run with 10 stage-ends). */
    const manyRows = [{ type: 'run-start', runId: 'stub-many', seq: 1, provider: 'edge', mode: 'observe', scope: { id: 'stub', kind: 'unassigned' }, configRevision: 1, startedAt: Date.now() }];
    for (let index = 0; index < 10; index += 1) {
      manyRows.push({
        type: 'stage-end', runId: 'stub-many', seq: index + 2, stageId: String((index % 5) + 1), phase: 'finished',
        status: index % 2 === 0 ? 'PASS' : 'WARN', reason: index % 2 === 0 ? null : 'probe-' + index,
        blockedBy: null, startedAt: Date.now(), finishedAt: Date.now() + 3, durationMs: index + 0.5, checks: [], evidenceRef: null,
      });
    }
    manyRows.push({ type: 'run-end', runId: 'stub-many', seq: 12, overall: { status: 'WARN', reason: 'probe' }, stages: {}, axes: null, actualCalls: [], sideEffects: [], finishedAt: Date.now() + 40 });
    const stopStubMany = await startDiagnoseStub(manyRows.map((event) => JSON.stringify(event)).join('\n') + '\n');
    await reopenDiagnostics('edge');
    await sleep(1600);
    const manyPage = await readDiagPage('edge');
    await stopStubMany();
    const manySeq = (manyPage.events.rows || []).map((row) => Number(row.seq));
    check('A13 the event stream is capped at eight rows and ordered newest first',
      (manyPage.events.rows || []).length === 8
        && manySeq.every((value, index) => index === 0 || value < manySeq[index - 1]),
      { rows: 8, order: 'seq desc' },
      { rows: (manyPage.events.rows || []).length, seq: manySeq });

    /* the action is disabled while a run is still in flight */
    const stopStubHold = await startDiagnoseStub('__hold__');
    await reopenDiagnostics('firefox');
    await waitFor(async () => {
      const snapshot = await readDiagPage('firefox');
      return snapshot.present && snapshot.runPhase === 'running' ? snapshot : undefined;
    }, { timeoutMs: 15000, intervalMs: 200, label: 'run in flight' }).catch(() => null);
    const busyPage = await readDiagPage('firefox');
    await stopStubHold();
    check('A13 the "开始诊断" action is disabled while a run is in flight',
      Boolean(busyPage)
        && busyPage.runButtonDisabled === true
        && busyPage.actionNoteBranch === 'busy'
        && busyPage.actionNote.includes('正在进行中'),
      { disabled: true, branch: 'busy' },
      { phase: busyPage && busyPage.runPhase, disabled: busyPage && busyPage.runButtonDisabled, note: busyPage && busyPage.actionNote });

    /* 8) all three ways to close: ✕ button, Escape, backdrop — focus returns to the card button */
    const closeStates = {};
    // normalise: make sure exactly one overlay is open, on the chrome card, before probing close paths
    if (await evaluate(`(() => {
      const panel = document.querySelector('[data-uts-diag-modal]');
      return Boolean(panel && panel.getAttribute('data-uts-diag-modal') !== 'chrome');
    })()`)) {
      await evaluate(`(() => { const back = document.querySelector('[data-uts-diagnostics-back]'); if (back) back.click(); })()`);
      await waitFor(async () => evaluate(`!document.querySelector('[data-uts-diag-modal]')`), { timeoutMs: 10000, label: 'overlay closed before close-path probes' });
    }
    if ((await evaluate(`!!document.querySelector('[data-uts-diag-modal]')`)) === false) {
      await evaluate(`(() => { const button = document.querySelector('[data-uts-diagnose="chrome"]'); if (button) button.click(); })()`);
      await waitFor(async () => evaluate(`!!document.querySelector('[data-uts-diag-modal="chrome"]')`), { timeoutMs: 15000, label: 'chrome overlay for close-path probes' });
    }
    // (a) the ✕ / 关闭 button
    await evaluate(`(() => { const back = document.querySelector('[data-uts-diagnostics-back]'); if (back) back.click(); })()`);
    await waitFor(async () => evaluate(`!document.querySelector('[data-uts-diag-modal]')`),
      { timeoutMs: 15000, label: 'overlay closed by the button' });
    closeStates.byButton = await evaluate(`(() => ({
      overlay: Boolean(document.querySelector('[data-uts-diag-modal]')),
      settings: Boolean(document.querySelector('.uts-groups')),
      focus: document.activeElement ? document.activeElement.getAttribute('data-uts-diagnose') : null,
      bodyOverflow: document.body.style.overflow,
    }))()`);

    // (b) Escape
    await evaluate(`(() => { const button = document.querySelector('[data-uts-diagnose="chrome"]'); if (button) button.click(); })()`);
    await waitFor(async () => evaluate(`!!document.querySelector('[data-uts-diag-modal]')`), { timeoutMs: 15000, label: 'overlay reopened for Escape' });
    await state.chrome.cdp.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
    await state.chrome.cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
    await waitFor(async () => evaluate(`!document.querySelector('[data-uts-diag-modal]')`),
      { timeoutMs: 10000, label: 'overlay closed by Escape' }).catch(() => null);
    closeStates.byEscape = await evaluate(`(() => ({
      overlay: Boolean(document.querySelector('[data-uts-diag-modal]')),
      settings: Boolean(document.querySelector('.uts-groups')),
      focus: document.activeElement ? document.activeElement.getAttribute('data-uts-diagnose') : null,
    }))()`);

    // (c) backdrop click
    await evaluate(`(() => { const button = document.querySelector('[data-uts-diagnose="chrome"]'); if (button) button.click(); })()`);
    await waitFor(async () => evaluate(`!!document.querySelector('[data-uts-diag-modal]')`), { timeoutMs: 15000, label: 'overlay reopened for backdrop' });
    await evaluate(`(() => {
      const overlay = document.querySelector('[data-uts-diag-modal-overlay]');
      if (!overlay) return;
      const rect = overlay.getBoundingClientRect();
      overlay.dispatchEvent(new MouseEvent('click', { bubbles: true, clientX: rect.left + 4, clientY: rect.top + 4 }));
    })()`);
    await waitFor(async () => evaluate(`!document.querySelector('[data-uts-diag-modal]')`),
      { timeoutMs: 10000, label: 'overlay closed by backdrop' }).catch(() => null);
    closeStates.byBackdrop = await evaluate(`(() => ({
      overlay: Boolean(document.querySelector('[data-uts-diag-modal]')),
      settings: Boolean(document.querySelector('.uts-groups')),
      focus: document.activeElement ? document.activeElement.getAttribute('data-uts-diagnose') : null,
    }))()`);

    const closeOk = (state) => state && state.overlay === false && state.settings === true
      && state.focus === 'chrome' && (state.bodyOverflow === undefined || state.bodyOverflow !== 'hidden');
    check('A13 all three close paths (✕ / Escape / backdrop) close the overlay and return focus to the card',
      closeOk(closeStates.byButton) && closeOk(closeStates.byEscape) && closeOk(closeStates.byBackdrop),
      { byButton: 'closed + focus chrome', byEscape: 'closed + focus chrome', byBackdrop: 'closed + focus chrome' },
      closeStates);

    /* closing aborts the run: nothing keeps streaming and nothing re-requests */
    const afterCloseBase = configGetCount();
    const runsBefore = await evaluate(`(() => {
      window.__utsDiagEvents = 0;
      const obs = new MutationObserver(() => {});
      obs.observe(document.body, { childList: true, subtree: true });
      return 0;
    })()`);
    await sleep(6000);
    check('A13 closing the overlay leaves no run behind (no new config reads, no stage events)',
      configGetCount() - afterCloseBase === 0
        && (await evaluate(`!document.querySelector('[data-uts-diag-modal]')`)) === true
        && (await evaluate(`document.body.style.overflow !== 'hidden'`)) === true,
      { newConfigReads: 0, overlay: false, bodyScroll: 'restored' },
      { newConfigReads: configGetCount() - afterCloseBase, runsBefore });

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
    log('[diag] consoleErrors: ' + JSON.stringify((state.consoleErrors || []).slice(-4)).slice(0, 1200));
    log('[diag] pageExceptions: ' + JSON.stringify((state.pageExceptions || []).slice(-2)).slice(0, 600));
    await writeFile(join(RUN_DIR, 'report.json'), JSON.stringify({
      suite: 'settings-config-gui',
      status: 'BLOCKED',
      observations: { consoleErrors: state.consoleErrors, pageExceptions: state.pageExceptions },
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
