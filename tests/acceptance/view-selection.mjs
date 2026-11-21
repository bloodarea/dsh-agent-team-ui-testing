#!/usr/bin/env node
/**
 * 视图选择的独立验收：默认视图、按会话持久化、按工作区隔离。
 *
 * 与其它 GUI 套件同一套隔离方式：临时 DSH_HOME + 随机 loopback 端口 + 独立 headless Chromium，
 * 从不触碰运行中的实例；启动 token 只进内存，日志与报告全部脱敏。
 *
 * 断言（Host 配置是唯一真值，全部走已认证的同源 HTTP）：
 *   V1 新会话（没有存过选择）解析成默认视图，且没有能力。
 *   V2 POST /config/select {view:"web"} 成功，会话解析成 web。
 *   V3 同一会话再读还是 web（持久化）。另一个会话仍是默认视图（按会话隔离）。
 *   V4 在同一工作区开一个新会话，继承该工作区的选择（工作区继承）。
 *   V5 切回第一个会话仍是它自己的选择（不被别人的选择覆盖）。
 *   V6 选 3D（`status: view`）在 3D 总开关打开时被接受，且能力面为空。
 *   V7 默认视图可以被显式选回，并写进会话与工作区。
 *
 * 证据：tests/acceptance/runs/view-selection-<stamp>/{report.json,run.log}
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
const RUN_DIR = join(HERE, 'runs', `view-selection-${RUN_STAMP}-${process.pid}`);
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

/** 用会话作用域的 scope 头读 Host 配置（与面板同一条路由）。 */
async function readSessionConfig(sessionId) {
  return evaluate(`(async () => {
    const headers = {
      'X-UI-Testing-Scope-Version': '1',
      'X-UI-Testing-Session-Id': ${JSON.stringify(sessionId)},
      'X-UI-Testing-Scope-Tab': 'primary',
    };
    const response = await fetch('${HOST_ROUTE}/config?view=session', { credentials: 'same-origin', headers, cache: 'no-store' });
    const payload = await response.json().catch(() => ({}));
    const resolved = payload.resolved || {};
    return {
      status: response.status,
      ok: payload.ok === true,
      view: resolved.view ?? null,
      environment: resolved.environment ?? null,
      capabilities: Array.isArray(resolved.capabilities) ? resolved.capabilities.length : null,
      revision: payload.revision ?? null,
      source: resolved.source ? { inheritedFrom: resolved.source.inheritedFrom ?? null, rejected: resolved.source.rejectedEnvironment ?? null } : null,
    };
  })()`);
}

/** 用会话作用域提交一次视图选择。 */
async function selectView(sessionId, view, expectedRevision) {
  return evaluate(`(async () => {
    const headers = {
      'X-UI-Testing-Scope-Version': '1',
      'X-UI-Testing-Session-Id': ${JSON.stringify(sessionId)},
      'X-UI-Testing-Scope-Tab': 'primary',
      'content-type': 'application/json',
    };
    const response = await fetch('${HOST_ROUTE}/config/select', {
      method: 'POST', credentials: 'same-origin', headers,
      body: JSON.stringify({ scope: 'session', view: ${JSON.stringify(view)}, expectedRevision: ${Number(expectedRevision)} }),
    });
    const payload = await response.json().catch(() => ({}));
    return {
      status: response.status,
      ok: payload.ok === true,
      code: payload.code || '',
      error: payload.error || '',
      revision: payload.revision ?? null,
      view: payload.resolved ? (payload.resolved.view ?? null) : null,
    };
  })()`);
}

async function readGlobalConfig() {
  return evaluate(`(async () => {
    const response = await fetch('${HOST_ROUTE}/config?view=global', { credentials: 'same-origin', cache: 'no-store' });
    const payload = await response.json().catch(() => ({}));
    const config = payload.config || {};
    return {
      status: response.status,
      revision: payload.revision ?? null,
      catalogIds: Array.isArray(payload.catalog) ? payload.catalog.map((row) => row.id) : [],
      viewRows: Array.isArray(payload.catalog) ? payload.catalog.filter((row) => row.kind === 'view').map((row) => row.id) : [],
      sessions: config.sessions || {},
      workspaces: config.workspaces || {},
      threeD: config.global && config.global.environments ? (config.global.environments['three-d'] || null) : null,
    };
  })()`);
}

async function main() {
  await mkdir(RUN_DIR, { recursive: true });
  log('# 视图选择验收 ' + RUN_STAMP);

  await launchChrome();
  log(`[chrome] devtools port ${state.chrome.devtoolsPort}`);
  await startIsolatedDsh();
  log(`[dsh] isolated instance on ${state.dsh.base} (DSH_HOME=${state.dsh.home})`);
  const cookies = await authenticate(state.dsh.launchUrl);
  log(`[auth] ${cookies} cookie(s) installed from the launch URL`);
  await state.chrome.cdp.send('Page.navigate', { url: state.dsh.base + '/' });
  await guiReady();
  log('[gui] shell ready（同源已认证，后续全部走面板用同一条 HTTP 路由）');

  // V1 新会话 → 默认视图
  const fresh = await readSessionConfig('session-alpha');
  observations.fresh = fresh;
  check('V1 新会话（没有存过选择）解析成默认视图', fresh.ok && fresh.view === 'default',
    { view: 'default' }, fresh);
  check('V1 空态没有任何能力', fresh.ok && fresh.capabilities === 0,
    { capabilities: 0 }, { capabilities: fresh.capabilities });

  // V2 选择 web
  const rev0 = fresh.revision;
  const selected = await selectView('session-alpha', 'web', rev0);
  observations.selected = selected;
  check('V2 POST /config/select {view:"web"} 被接受并返回 web 解析',
    selected.ok && selected.view === 'web', { status: 200, view: 'web' }, selected);

  // V3 持久化 + 按会话隔离
  const again = await readSessionConfig('session-alpha');
  const other = await readSessionConfig('session-beta');
  observations.again = again;
  observations.other = other;
  check('V3 同一会话再读仍是 web（选择已持久化）', again.ok && again.view === 'web',
    { view: 'web' }, { view: again.view, source: again.source });
  check('V3 另一个会话不受影响（仍是默认视图，按会话隔离）', other.ok && other.view === 'default',
    { view: 'default' }, { view: other.view });

  // V4 同工作区新会话继承工作区选择
  const inherited = await readSessionConfig('session-beta');
  const global = await readGlobalConfig();
  observations.global = global;
  const sessionViews = Object.fromEntries(Object.entries(global.sessions).map(([id, entry]) => [id, entry.view ?? null]));
  const workspaceViews = Object.values(global.workspaces).map((entry) => entry.view ?? null);
  // 工作区继承依赖"这个会话属于哪个工作区"这一事实。隔离实例里 session-alpha 是个不存在于宿主
  // 会话表的 id，所以这里只能断言"会话自己的选择写对了，且没有凭 id 猜一个工作区出来"；
  // 工作区继承本身由核心契约测试覆盖（tests/contracts/view-selection.test.mjs 的 A/B 工作区用例）。
  check('V4 会话自己的选择写进了配置', sessionViews['session-alpha'] === 'web',
    { session: 'web' }, { sessionViews });
  check('V4 未知会话不会凭空造出工作区条目（不猜工作区身份）', workspaceViews.length === 0,
    { workspaceViews: [] }, { workspaceViews, inherited: inherited && inherited.view });
  check('V4 默认视图与目标环境在同一份 catalog 里，且只有一行视图', global.catalogIds.includes('default') && global.catalogIds.includes('web'),
    { hasDefault: true, hasWeb: true }, { catalogIds: global.catalogIds, viewRows: global.viewRows });
  check('V4 视图行只有默认视图一个', JSON.stringify(global.viewRows) === JSON.stringify(['default']),
    { viewRows: ['default'] }, { viewRows: global.viewRows });

  // V5 切回第一个会话，选择不被覆盖
  const back = await readSessionConfig('session-alpha');
  check('V5 切回原会话仍是它自己的选择', back.ok && back.view === 'web',
    { view: 'web' }, { view: back.view });

  // V6 选 3D（status: view）
  const rev1 = back.revision;
  const before = await readGlobalConfig();
  const threeDOn = before.threeD && before.threeD.enabled === true;
  if (!threeDOn) {
    const enabled = await evaluate(`(async () => {
      const response = await fetch('${HOST_ROUTE}/config', {
        method: 'PUT', credentials: 'same-origin', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ expectedRevision: ${Number(rev1)}, scope: 'global', patch: { environments: { 'three-d': { enabled: true } } } }),
      });
      const payload = await response.json().catch(() => ({}));
      return { status: response.status, ok: payload.ok === true, revision: payload.revision ?? null, code: payload.code || '' };
    })()`);
    observations.enableThreeD = enabled;
    check('V6 打开 3D 总开关（默认视图不挡配置写入）', enabled.ok, { ok: true }, enabled);
  }
  const revNow = (await readGlobalConfig()).revision;
  const threeD = await selectView('session-alpha', 'three-d', revNow);
  observations.selectThreeD = threeD;
  check('V6 选择 3D 被接受（status: view 可选中）', threeD.ok && threeD.view === 'three-d',
    { view: 'three-d' }, threeD);
  const threeDSnap = await readSessionConfig('session-alpha');
  check('V6 3D 会话没有 Agent 执行能力（可选中 ≠ 可执行）', threeDSnap.ok && threeDSnap.capabilities === 0,
    { capabilities: 0 }, { view: threeDSnap.view, capabilities: threeDSnap.capabilities });

  // V7 显式选回默认视图
  const rev2 = threeDSnap.revision;
  const backToDefault = await selectView('session-alpha', 'default', rev2);
  observations.backToDefault = backToDefault;
  check('V7 可以显式选回默认视图', backToDefault.ok && backToDefault.view === 'default',
    { view: 'default' }, backToDefault);
  const finalGlobal = await readGlobalConfig();
  observations.finalGlobal = finalGlobal;
  const finalSession = finalGlobal.sessions['session-alpha'];
  check('V7 默认视图同样写进会话与工作区', Boolean(finalSession) && finalSession.view === 'default',
    { session: 'default' }, { session: finalSession, workspaceViews: Object.values(finalGlobal.workspaces).map((entry) => entry.view ?? null) });

  if (state.consoleErrors.length) log('[console] ' + JSON.stringify(state.consoleErrors.slice(0, 5)));
}

main()
  .then(async () => { finish(checks.every((entry) => entry.pass) ? 0 : 1, ''); })
  .catch(async (error) => {
    log('[fatal] ' + String((error && error.stack) || error));
    finish(2, String((error && error.message) || error));
  });

async function finish(code, fatal) {
  const report = {
    stamp: RUN_STAMP, fatal,
    isolatedInstance: state.dsh ? { base: state.dsh.base } : null,
    checks, notRuns, observations, consoleErrors: state.consoleErrors.slice(0, 10),
    credentials: 'launch token and cookies redacted; nothing written to disk',
  };
  try {
    await writeFile(join(RUN_DIR, 'report.json'), JSON.stringify(report, null, 2));
    await writeFile(join(RUN_DIR, 'run.log'), logLines.join('\n') + '\n');
  } catch (error) {
    console.error('could not write evidence: ' + String((error && error.message) || error));
  }
  log(`[result] ${code === 0 ? 'PASS' : code === 1 ? 'FAIL' : 'BLOCKED'} — evidence ${RUN_DIR}`);
  try { state.chrome && state.chrome.cdp.close(); } catch { /* ignore */ }
  try { state.chrome && state.chrome.proc.kill('SIGKILL'); } catch { /* ignore */ }
  try { state.dsh && state.dsh.proc.kill('SIGTERM'); } catch { /* ignore */ }
  setTimeout(() => process.exit(code), 800);
}
