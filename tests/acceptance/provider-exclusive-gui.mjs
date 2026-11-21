#!/usr/bin/env node
/**
 * 3D（three-d）Blender 运行环境开关的独立验收。
 *
 * 复现用户报告的现象并给出判定：设置页「3D 视图 → Blender」卡片右上角的开关此前恒为灰态、点不动。
 *
 * 做法与 settings-config-gui.mjs 一致：起一个**私有隔离 DSH 实例**（临时 DSH_HOME 复制用户 web
 * profile、随机 loopback 端口、--no-open），用独立 headless Chromium 走真实 GUI 登录令牌驱动；
 * 用户正在用的 3080/3081 一个字节都不动。启动 token 只在内存里用，日志与报告全部脱敏。
 *
 * 断言（Host 配置是唯一真值）：
 *   S1 3D 分组默认收起；展开后 Blender 卡片开关在总开关关闭时是 disabled（这一层语义不变）。
 *   S2 打开 3D 总开关后，Blender 卡片开关**变为可点**（本次修复的核心）。
 *   S3 点 Blender 开关发出 PUT /plugins/ui-testing/config，body 写
 *      `environments.three-d.providers.blender.enabled=false`，revision +1，卡片开关变 off。
 *   S4 关掉 Blender 后 POST /blender/frame 返回 409，错误文案是新的「请先在设置中启用 Blender 运行环境。」
 *   S5 重新打开 Blender 后同一请求返回 200 image/png（真实出图；Blender/Xvfb 缺失时记 NOT_RUN）。
 *   S6 收尾把 3D 总开关关回去，配置回到初始形状（revision 继续递增，不伪装成未改动）。
 *
 * 证据：tests/acceptance/runs/three-d-provider-switch-<stamp>/{report.json,run.log,*.png}
 * 退出码：0 全部通过（允许 NOT_RUN），1 断言失败，2 致命 / BLOCKED。
 */
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { createServer as createNetServer } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const RUN_STAMP = new Date().toISOString().replace(/[:.]/g, '-');
const RUN_DIR = join(HERE, 'runs', `provider-exclusive-gui-${RUN_STAMP}-${process.pid}`);
const DEFAULT_PROFILE = join(process.env.HOME || '', '.dsh', 'profiles', 'web');
const DSH_BIN = process.env.DSH_BIN || 'dsh';
const CHROME = process.env.DSH_ACCEPTANCE_CHROME || process.env.DSH_REAL_BROWSER_CHROME || join(HERE, 'chrome-wrapper.sh');
const HOST_ROUTE = '/plugins/ui-testing';

const logLines = [];
const checks = [];
const notRuns = [];
const screenshots = [];
const observations = {};
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function redact(text) {
  return String(text)
    .replace(/([?&]token=)[^&\s"']+/gi, '$1[redacted]')
    .replace(/(["']?token["']?\s*[:=]\s*["'])[^"']+(["'])/gi, '$1[redacted]$2');
}
const log = (line = '') => {
  const text = redact(String(line));
  logLines.push(text);
  console.log(text);
};
function check(label, pass, expected, actual) {
  checks.push({ label, pass: Boolean(pass), expected, actual });
  log(`${pass ? 'PASS' : 'FAIL'} ${label}`);
  if (!pass) log('  expected=' + JSON.stringify(expected) + ' actual=' + JSON.stringify(actual));
  return Boolean(pass);
}
function notRun(label, reason) {
  notRuns.push({ label, reason: String(reason) });
  log(`NOT_RUN ${label} — ${reason}`);
}
const sha256 = (buffer) => createHash('sha256').update(buffer).digest('hex');

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

const state = { chrome: null, dsh: null, requests: [], consoleErrors: [], pageExceptions: [] };

async function launchChrome() {
  const profileDir = await mkdtemp(join(tmpdir(), 'dsh-three-d-gui-chrome-'));
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
        const url = redact(String(request.url || ''));
        if (!url.includes('ui-testing')) return;
        state.requests.push({ at: Date.now(), url, method: String(request.method || ''), postData: String(request.postData || '') });
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
  const home = await mkdtemp(join(tmpdir(), 'dsh-three-d-gui-home-'));
  const profileDir = join(home, 'profiles', 'web');
  await mkdir(profileDir, { recursive: true });
  for (const name of ['package.json', 'cordis.patch.yml', 'compatibility.json', 'pnpm-lock.yaml', 'cordis.yml']) {
    const source = join(DEFAULT_PROFILE, name);
    if (!existsSync(source)) continue;
    await writeFile(join(profileDir, name), await readFile(source));
  }
  const nodeModules = join(DEFAULT_PROFILE, 'node_modules');
  if (!existsSync(nodeModules)) throw new Error(`user profile node_modules missing: ${nodeModules}`);
  await symlink(nodeModules, join(profileDir, 'node_modules'), 'dir');
  return { home, profileDir };
}

async function startIsolatedDsh() {
  const { home } = await prepareDshHome();
  const port = await pickPort();
  const proc = spawn(DSH_BIN, ['web', '--port', String(port), '--no-open'], {
    env: { ...process.env, DSH_HOME: home, DSH_PROFILE: 'web' },
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
  }, { timeoutMs: 180000, intervalMs: 250, label: 'isolated dsh launch URL' });
  state.dsh = { proc, home, port, base: `http://127.0.0.1:${port}`, launchUrl: matched.url, token: matched.token, output: () => output };
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

async function evaluate(expression, { timeoutMs = 30000 } = {}) {
  const result = await state.chrome.cdp.send('Runtime.evaluate', {
    expression, returnByValue: true, awaitPromise: true, userGesture: true,
  }, timeoutMs);
  if (result.exceptionDetails) {
    const text = result.exceptionDetails.exception && result.exceptionDetails.exception.description
      ? result.exceptionDetails.exception.description
      : result.exceptionDetails.text;
    throw new Error('page evaluation failed: ' + String(text).slice(0, 500));
  }
  return result.result ? result.result.value : undefined;
}

async function guiReady(timeoutMs = 90000) {
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
  screenshots.push({ name, sha256: sha256(Buffer.from(shot.data, 'base64')) });
  return file;
}

async function settingsDialogReady() {
  return evaluate(`(() => {
    const dialog = document.querySelector('[role="dialog"]');
    if (!dialog) return false;
    return /UI 测试|通用|模型|插件|外观|账户|General|Models|Plugins/i.test(dialog.textContent || '');
  })()`);
}

async function dismissOverlays({ attempts = 3 } = {}) {
  let closed = 0;
  for (let round = 0; round < attempts; round += 1) {
    const count = await evaluate(`(() => {
      let clicks = 0;
      for (const dialog of [...document.querySelectorAll('[role="dialog"]')]) {
        const button = [...dialog.querySelectorAll('button')].find((node) => /关闭|close|以后再说|later|跳过|skip/i.test((node.getAttribute('aria-label') || '') + (node.textContent || '')));
        if (button) { button.click(); clicks += 1; }
      }
      return clicks;
    })()`);
    closed += count;
    await sleep(count > 0 ? 500 : 200);
    if (!(await evaluate('!!document.querySelector(\'[role="dialog"]\')'))) break;
    await state.chrome.cdp.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
    await state.chrome.cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
    await sleep(300);
  }
  return closed;
}

async function openSettingsDialog() {
  const paths = [];
  const record = (path, ok, detail) => { paths.push({ path, ok: Boolean(ok), detail }); };
  const pressEscape = async () => {
    await state.chrome.cdp.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
    await state.chrome.cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
    await sleep(250);
  };
  const finishIfSettings = async (path, detail) => {
    if (await settingsDialogReady()) { record(path, true, detail); return true; }
    await dismissOverlays({ attempts: 1 });
    record(path, false, detail);
    return false;
  };

  await dismissOverlays({ attempts: 2 });

  // 1) 直接设置按钮（aria-haspopup="dialog"）
  const direct = await evaluate(`(() => {
    const trigger = [...document.querySelectorAll('button[aria-haspopup="dialog"]')]
      .find((button) => /设置|Settings/i.test((button.getAttribute('aria-label') || '') + (button.textContent || '')));
    if (!trigger) return null;
    trigger.click();
    return trigger.getAttribute('aria-label') || (trigger.textContent || '').trim().slice(0, 40);
  })()`);
  if (direct) {
    await sleep(700);
    if (await finishIfSettings('dialog-trigger', direct)) return 'dialog-trigger: ' + direct;
  } else {
    record('dialog-trigger', false, 'no aria-haspopup=dialog settings button');
  }

  // 2) 账号菜单 → 设置
  const accountLabel = await evaluate(`(() => {
    const account = [...document.querySelectorAll('button')].find((button) => /账号菜单|Account menu/i.test(button.getAttribute('aria-label') || ''));
    if (!account) return null;
    account.click();
    return account.getAttribute('aria-label');
  })()`);
  if (accountLabel) {
    await sleep(500);
    const item = await evaluate(`(() => {
      const nodes = [...document.querySelectorAll('[role="menuitem"], [role="menu"] button, [role="menu"] [role="menuitem"]')];
      const target = nodes.find((node) => /设置|Settings/i.test((node.textContent || '') + (node.getAttribute('aria-label') || '')));
      if (!target) return null;
      target.click();
      return (target.textContent || target.getAttribute('aria-label') || '').trim().slice(0, 40);
    })()`);
    if (item) {
      await sleep(800);
      if (await finishIfSettings('account-menu', accountLabel + ' → ' + item)) return 'account-menu: ' + item;
    } else {
      record('account-menu', false, 'no 设置 item');
      await evaluate('document.body.click()');
      await sleep(200);
    }
  } else {
    record('account-menu', false, 'no 账号菜单 button');
  }

  // 3) 「更多」菜单 → 设置
  const moreCount = await evaluate(`(() => [...document.querySelectorAll('button')].filter((button) => /^(更多|More)$/i.test(((button.getAttribute('aria-label') || '') + '|' + (button.textContent || '').trim()).split('|').pop())).length)()`);
  for (let index = 0; index < moreCount; index += 1) {
    const clicked = await evaluate(`(() => {
      const buttons = [...document.querySelectorAll('button')].filter((button) => /^(更多|More)$/i.test(((button.getAttribute('aria-label') || '') + '|' + (button.textContent || '').trim()).split('|').pop()));
      if (!buttons[${index}]) return false;
      buttons[${index}].click();
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
      await sleep(800);
      if (await finishIfSettings('more-menu', item)) return 'more-menu: ' + item;
    } else {
      record('more-menu', false, 'no 设置 entry');
      await pressEscape();
    }
  }
  if (moreCount === 0) record('more-menu', false, 'no 更多/More button');

  // 4) 键盘快捷键
  await state.chrome.cdp.send('Input.dispatchKeyEvent', { type: 'keyDown', key: ',', code: 'Comma', windowsVirtualKeyCode: 188, modifiers: 2 });
  await state.chrome.cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', key: ',', code: 'Comma', windowsVirtualKeyCode: 188, modifiers: 2 });
  await sleep(800);
  if (await finishIfSettings('keyboard-shortcut', 'Ctrl+,')) return 'keyboard-shortcut: Ctrl+,';

  observations.settingsPaths = paths;
  observations.domProbe = await evaluate(`(() => ({
    buttons: [...document.querySelectorAll('button')].map((button) => ({
      aria: button.getAttribute('aria-label') || '',
      text: (button.textContent || '').trim().slice(0, 30),
      popup: button.getAttribute('aria-haspopup'),
    })).filter((entry) => entry.aria || entry.text).slice(0, 80),
    dialogs: [...document.querySelectorAll('[role="dialog"]')].map((node) => (node.textContent || '').trim().slice(0, 80)),
  }))()`);
  throw new Error('no settings entry reachable; paths=' + JSON.stringify(paths) + ' dom=' + JSON.stringify(observations.domProbe).slice(0, 2000));
}

async function openUiTestingSection() {
  const clicked = await evaluate(`(() => {
    const dialog = document.querySelector('[role="dialog"]');
    if (!dialog) return { ok: false, reason: 'no-dialog' };
    const target = [...dialog.querySelectorAll('button')].find((button) => (button.textContent || '').includes('UI 测试'));
    if (!target) return { ok: false, reason: 'no-section-label' };
    target.click();
    return { ok: true, label: (target.textContent || '').trim() };
  })()`);
  if (!clicked.ok) throw new Error('UI 测试 section entry missing: ' + JSON.stringify(clicked));
  await waitFor(async () => evaluate(`!!document.querySelector('[data-uts-settings="page"]')`),
    { timeoutMs: 20000, label: 'ui-testing settings page' });
  await waitFor(async () => {
    const raw = await evaluate(`(() => {
      const page = document.querySelector('[data-uts-settings="page"]');
      return page ? page.getAttribute('data-uts-config-revision') : '';
    })()`);
    return raw && String(raw).trim() !== '' ? raw : undefined;
  }, { timeoutMs: 20000, label: 'settings config revision' });
  return clicked;
}

/** 读取 3D 分组、总开关与 Blender 卡片开关的当前 DOM 真值。 */
async function readThreeD() {
  return evaluate(`(() => {
    const page = document.querySelector('[data-uts-settings="page"]');
    if (!page) return null;
    const group = document.querySelector('[data-uts-group="three-d"]');
    const envInput = document.querySelector('[data-uts-env-switch="three-d"] input[type="checkbox"]');
    const card = document.querySelector('[data-uts-provider="blender"]');
    const cardInput = document.querySelector('[data-uts-switch-provider="blender"] input[type="checkbox"]');
    return {
      revisionRaw: page.getAttribute('data-uts-config-revision'),
      status: page.getAttribute('data-uts-config-status'),
      notice: (document.querySelector('[data-uts-config-notice]') || {}).textContent || '',
      error: (document.querySelector('[data-uts-config-error]') || {}).textContent || '',
      groupExpanded: group ? group.getAttribute('data-uts-expanded') : null,
      env: envInput ? { checked: envInput.checked, disabled: envInput.disabled, title: envInput.closest('label')?.getAttribute('title') || '' } : null,
      card: cardInput ? {
        checked: cardInput.checked,
        disabled: cardInput.disabled,
        label: cardInput.getAttribute('aria-label'),
        title: cardInput.closest('label')?.getAttribute('title') || '',
        providerState: card.getAttribute('data-uts-provider-state'),
        targetState: card.getAttribute('data-uts-state'),
        cardState: (() => { const span = card.querySelector('[data-uts-card-state]'); return span ? { text: (span.textContent || '').trim(), state: span.getAttribute('data-uts-card-state') } : null; })(),
      } : null,
    };
  })()`);
}

async function clickGroupToggle() {
  return evaluate(`(() => {
    const button = document.querySelector('[data-uts-group-toggle="three-d"]');
    if (!button) return false;
    button.click();
    return true;
  })()`);
}

async function clickEnvSwitch() {
  return evaluate(`(() => {
    const input = document.querySelector('[data-uts-env-switch="three-d"] input[type="checkbox"]');
    if (!input) return { ok: false, reason: 'missing' };
    input.click();
    return { ok: true, disabled: input.disabled, checked: input.checked };
  })()`);
}

async function clickBlenderSwitch() {
  return evaluate(`(() => {
    const input = document.querySelector('[data-uts-switch-provider="blender"] input[type="checkbox"]');
    if (!input) return { ok: false, reason: 'missing' };
    input.click();
    return { ok: true, disabled: input.disabled, checkedAfterClick: input.checked };
  })()`);
}

/** 从已认证的 GUI 页面读 Host 配置真值（面板用的同一接口）。 */
async function readHostConfig() {
  return evaluate(`(async () => {
    const response = await fetch('${HOST_ROUTE}/config?view=global', { credentials: 'same-origin', cache: 'no-store' });
    const payload = await response.json().catch(() => ({}));
    const entry = payload.config && payload.config.global && payload.config.global.environments
      ? payload.config.global.environments['three-d'] : null;
    return { status: response.status, revision: payload.revision ?? null, threeD: entry };
  })()`);
}

/** 用面板同样的 scope 头请求 Blender 视口，只判定门禁与 HTTP 形状。 */
async function requestBlenderFrame({ width = 640, height = 360 } = {}) {
  return evaluate(`(async () => {
    const response = await fetch('${HOST_ROUTE}/blender/frame', {
      method: 'POST',
      credentials: 'same-origin',
      headers: {
        'content-type': 'application/json',
        'X-UI-Testing-Scope-Version': '1',
        'X-UI-Testing-Scope': 'recent',
      },
      body: JSON.stringify({ camera: [0, 0, 1], size: [${width}, ${height}] }),
    });
    const type = response.headers.get('content-type') || '';
    if (type.includes('image/png')) {
      const bytes = new Uint8Array(await response.arrayBuffer());
      return { status: response.status, contentType: type, bytes: bytes.length, signature: [...bytes.slice(0, 8)] };
    }
    const payload = await response.json().catch(() => ({}));
    return { status: response.status, contentType: type, code: payload.code || '', error: payload.error || '' };
  })()`, { timeoutMs: 90000 });
}

/** 读 Web 分组里 chrome / edge / firefox 三个开关的 DOM 真值。 */
async function readWebProviders() {
  return evaluate(`(() => {
    const page = document.querySelector('[data-uts-settings="page"]');
    if (!page) return null;
    const read = (id) => {
      const input = document.querySelector('[data-uts-switch-provider="' + id + '"] input[type="checkbox"]');
      return input ? { id, checked: input.checked, disabled: input.disabled } : null;
    };
    const group = document.querySelector('[data-uts-group="web"]');
    return {
      revisionRaw: page.getAttribute('data-uts-config-revision'),
      notice: (document.querySelector('[data-uts-config-notice]') || {}).textContent || '',
      expanded: group ? group.getAttribute('data-uts-expanded') : null,
      providers: ['chrome', 'edge', 'firefox'].map(read),
    };
  })()`);
}

async function clickProvider(id) {
  return evaluate(`(() => {
    const input = document.querySelector('[data-uts-switch-provider="' + ${JSON.stringify(id)} + '"] input[type="checkbox"]');
    if (!input) return { ok: false, reason: 'missing' };
    input.click();
    return { ok: true, before: input.checked, disabled: input.disabled };
  })()`);
}

async function main() {
  await mkdir(RUN_DIR, { recursive: true });
  log('# 运行环境互斥（真实设置页）验收 ' + RUN_STAMP);
  await launchChrome();
  await startIsolatedDsh();
  await authenticate(state.dsh.launchUrl);
  await state.chrome.cdp.send('Page.navigate', { url: state.dsh.base + '/' });
  await guiReady();
  const openedVia = await openSettingsDialog();
  await openUiTestingSection();
  log('[gui] settings → UI 测试 opened via ' + openedVia);

  await evaluate(`(() => {
    const group = document.querySelector('[data-uts-group="web"]');
    if (group && group.getAttribute('data-uts-expanded') !== 'true') {
      document.querySelector('[data-uts-group-toggle="web"]').click();
    }
  })()`);
  await waitFor(async () => {
    const current = await readWebProviders();
    return current && current.expanded === 'true' ? current : undefined;
  }, { timeoutMs: 10000, label: 'web group expanded' });

  const initial = await readWebProviders();
  observations.initial = initial;
  log('[state] initial = ' + JSON.stringify(initial.providers));
  check('E1 初始状态恰好只有一个运行环境打开（chrome）',
    initial.providers.filter((entry) => entry && entry.checked).map((entry) => entry.id).join(',') === 'chrome',
    { enabled: 'chrome' }, { providers: initial.providers });

  const startRevision = Number(initial.revisionRaw);
  await clickProvider('edge');
  const afterEdge = await waitFor(async () => {
    const current = await readWebProviders();
    const revision = Number(current && current.revisionRaw);
    return Number.isFinite(revision) && revision > startRevision ? current : undefined;
  }, { timeoutMs: 20000, label: 'revision increased after enabling edge' });
  observations.afterEdge = afterEdge;
  log('[state] after enabling edge = ' + JSON.stringify(afterEdge.providers));
  check('E2 打开 Edge 后 Chrome 自动关闭（互斥，Host 已落库）',
    afterEdge.providers.find((entry) => entry.id === 'edge').checked === true
      && afterEdge.providers.find((entry) => entry.id === 'chrome').checked === false
      && afterEdge.providers.find((entry) => entry.id === 'firefox').checked === false,
    { edge: true, chrome: false, firefox: false }, { providers: afterEdge.providers });
  check('E2 只涨一次 revision（互斥由同一条补丁完成）',
    Number(afterEdge.revisionRaw) === startRevision + 1,
    { revision: startRevision + 1 }, { revision: afterEdge.revisionRaw, notice: afterEdge.notice });

  const startRevision2 = Number(afterEdge.revisionRaw);
  await clickProvider('chrome');
  const restored = await waitFor(async () => {
    const current = await readWebProviders();
    const revision = Number(current && current.revisionRaw);
    return Number.isFinite(revision) && revision > startRevision2 ? current : undefined;
  }, { timeoutMs: 20000, label: 'revision increased after restoring chrome' });
  observations.restored = restored;
  log('[state] restored = ' + JSON.stringify(restored.providers));
  check('E3 切回 Chrome 后 Edge 关闭（双向互斥）并恢复初始状态',
    restored.providers.find((entry) => entry.id === 'chrome').checked === true
      && restored.providers.find((entry) => entry.id === 'edge').checked === false,
    { chrome: true, edge: false }, { providers: restored.providers });
  await capture('provider-exclusive-restored.png');
}

main()
  .then(async () => { finish(checks.every((entry) => entry.pass) ? 0 : 1, ''); })
  .catch(async (error) => { log('[fatal] ' + String((error && error.stack) || error)); finish(2, String((error && error.message) || error)); });

async function finish(code, fatal) {
  const report = {
    stamp: RUN_STAMP, fatal,
    isolatedInstance: state.dsh ? { base: state.dsh.base } : null,
    checks, notRuns, observations, screenshots,
    credentials: 'launch token and cookies redacted; nothing written to disk',
  };
  try {
    await writeFile(join(RUN_DIR, 'report.json'), JSON.stringify(report, null, 2));
    await writeFile(join(RUN_DIR, 'run.log'), logLines.join('\n') + '\n');
  } catch (error) { console.error('evidence write failed: ' + String(error && error.message)); }
  log(`[result] ${code === 0 ? 'PASS' : code === 1 ? 'FAIL' : 'BLOCKED'} — evidence ${RUN_DIR}`);
  try { state.chrome && state.chrome.cdp.close(); } catch {}
  try { state.chrome && state.chrome.proc.kill('SIGKILL'); } catch {}
  try { state.dsh && state.dsh.proc.kill('SIGTERM'); } catch {}
  setTimeout(() => process.exit(code), 700);
}
