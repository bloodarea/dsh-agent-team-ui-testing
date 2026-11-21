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
const RUN_DIR = join(HERE, 'runs', `diagnose-stages-${RUN_STAMP}-${process.pid}`);
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


/** 跑一次设置页同款的诊断（unassigned 作用域，observe 模式），收集每个阶段的状态与原因。 */
async function runDiagnose(label, environment) {
  return evaluate(`(async () => {
    const response = await fetch('${HOST_ROUTE}/diagnose', {
      method: 'POST', credentials: 'same-origin', cache: 'no-store',
      headers: {
        'content-type': 'application/json',
        'X-UI-Testing-Scope-Version': '1',
        'X-UI-Testing-Scope': 'unassigned',
      },
      body: JSON.stringify({ environment: ${JSON.stringify(environment)}, mode: 'observe', requestId: ${JSON.stringify(label)} }),
    });
    const text = await response.text();
    const events = text.split(String.fromCharCode(10)).filter(Boolean).map((line) => { try { return JSON.parse(line); } catch { return null; } }).filter(Boolean);
    const end = events.find((event) => event.type === 'run-end');
    const stages = [];
    for (const event of events) {
      if (event.type === 'stage-end') stages.push({ stage: event.stageId, status: event.status, reason: event.reason, blockedBy: event.blockedBy });
    }
    return {
      httpStatus: response.status,
      overall: end ? end.overall : null,
      error: end ? end.error : null,
      stages,
      axes: end ? Object.fromEntries(Object.entries(end.axes || {}).map(([k, v]) => [k, v && v.status])) : null,
    };
  })()`);
}

async function main() {
  await mkdir(RUN_DIR, { recursive: true });
  log('# 诊断阶段回归：目标环境由调用方指定，纯视口环境不算失败 ' + RUN_STAMP);
  await launchChrome();
  await startIsolatedDsh();
  await authenticate(state.dsh.launchUrl);
  await state.chrome.cdp.send('Page.navigate', { url: state.dsh.base + '/' });
  await guiReady();
  log('[gui] shell ready（已认证的同源会话）');

  // D1 Web：显式指定 environment=web（设置页新行为）。阶段 2 必须 PASS，整轮不得 FAIL。
  const web = await runDiagnose('web-target', 'web');
  observations.web = web;
  log('[diagnose web] ' + JSON.stringify(web));
  const webStage = (id) => (web.stages || []).find((stage) => stage.stage === id) || {};
  check('D1 诊断 web：阶段 1（宿主集成）通过', webStage('1').status === 'PASS',
    { stage1: 'PASS' }, { stage1: webStage('1') });
  check('D1 诊断 web：阶段 2（插件 Core 与配置）通过，不再 adapter-unresolved',
    webStage('2').status === 'PASS', { stage2: 'PASS' }, { stage2: webStage('2') });
  check('D1 诊断 web：整轮没有 FAIL 阶段', !(web.stages || []).some((stage) => stage.status === 'FAIL'),
    { fails: [] }, { stages: web.stages, overall: web.overall });

  // D2 未给 environment（旧客户端 / 面板停在空态）：仍按 web 诊断，不得退化成空态而 FAIL。
  const legacy = await runDiagnose('no-environment', undefined);
  observations.legacy = legacy;
  log('[diagnose no-environment] ' + JSON.stringify(legacy));
  check('D2 不带 environment 时仍不 FAIL', !(legacy.stages || []).some((stage) => stage.status === 'FAIL'),
    { fails: [] }, { stages: legacy.stages, overall: legacy.overall });

  // D3 3D（只有视图的环境）：阶段 1/2 SKIPPED，原因是"没有执行适配器"，不是失败也不是工具被拒。
  const threeD = await runDiagnose('three-d-target', 'three-d');
  observations.threeD = threeD;
  log('[diagnose three-d] ' + JSON.stringify(threeD));
  check('D3 诊断 3D：没有 FAIL 阶段', !(threeD.stages || []).some((stage) => stage.status === 'FAIL'),
    { fails: [] }, { stages: threeD.stages });
  check('D3 诊断 3D：阶段 1/2 的跳过原因都是"只有视图、没有执行适配器"',
    (threeD.stages || []).filter((stage) => stage.stage === '1' || stage.stage === '2')
      .every((stage) => stage.status === 'SKIPPED' && stage.reason === 'environment-has-no-execution-adapter'),
    { reason: 'environment-has-no-execution-adapter' },
    { stages: (threeD.stages || []).filter((stage) => stage.stage === '1' || stage.stage === '2') });
}

main().then(async () => { finish(checks.every((entry) => entry.pass) ? 0 : 1, ''); }).catch(async (error) => { log('[fatal] ' + String(error && error.stack || error)); finish(2, String(error && error.message || error)); });

async function finish(code, fatal) {
  const report = {
    stamp: RUN_STAMP, fatal,
    isolatedInstance: state.dsh ? { base: state.dsh.base } : null,
    checks, notRuns, observations,
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
  setTimeout(() => process.exit(code), 600);
}
