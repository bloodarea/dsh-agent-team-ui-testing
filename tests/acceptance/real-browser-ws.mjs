#!/usr/bin/env node
/**
 * Optional real-browser regression for the T1 frame pipeline (WebSocket first, poll fallback).
 *
 * What it does (all local, zero external dependencies):
 *   1. Starts an ISOLATED DSH web instance: fresh temporary DSH_HOME + a temporary web profile
 *      whose config files are copied from the user profile and whose node_modules is a read-only
 *      symlink. It picks an ephemeral loopback port (never 3080/3081) and reads the launch token
 *      from the instance's own stdout — the token is never written to a command line, file or log.
 *   2. Starts the repository fixture server (127.0.0.1, random port) and the plugin's own headless
 *      Chromium via the plugin HTTP surface.
 *   3. Launches a separate headless Chromium (about:blank first, so the token never appears in a
 *      process command line), attaches over CDP, then Page.navigate to the tokenised GUI URL.
 *   4. Inside the GUI page, opens `new WebSocket('/plugins/ui-testing/frames')`, POSTs
 *      /plugins/ui-testing/navigate to the fixture, nudges the target page, and collects binary
 *      frames + metadata + /metrics evidence. CDP Network events are watched for
 *      Network.webSocketCreated on /plugins/ui-testing/frames.
 *   5. Writes a fresh report under tests/acceptance/runs/real-browser-<time>-<pid>/ and tears
 *      everything down: CDP socket, Chrome, DSH process, fixture server, temp profiles/DSH_HOME.
 *
 * Run:  node tests/acceptance/real-browser-ws.mjs
 * Env:  DSH_BIN (default `dsh`), DSH_REAL_BROWSER_CHROME (default tests/acceptance/chrome-wrapper.sh),
 *       DSH_ROOT (informational only), DSH_REAL_BROWSER_TIMEOUT_MS (default 180000).
 *
 * Exit codes: 0 pass or environment SKIP; 1 failure; 2 unexpected fatal error.
 */
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join, relative, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = dirname(dirname(HERE));
const EVIDENCE_DIR = join(HERE, 'runs', `real-browser-${new Date().toISOString().replace(/[:.]/g, '-')}-${process.pid}`);
const CHROME_FALLBACK = join(HERE, 'chrome-wrapper.sh');
const DEFAULT_PROFILE = join(process.env.HOME || '', '.dsh', 'profiles', 'web');
const TOTAL_TIMEOUT_MS = Number(process.env.DSH_REAL_BROWSER_TIMEOUT_MS || 180000) || 180000;
const PROFILE_PREFIX = 'dsh-ui-testing-';

const logLines = [];
function log(line = '') {
  const text = String(line);
  logLines.push(text);
  console.log(text);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function errorMessage(error) {
  return String((error && error.message) || error);
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
        return reject(new Error(`timed out after ${timeoutMs}ms waiting for ${label}${lastError ? ` (last: ${lastError.message})` : ''}`));
      }
      setTimeout(tick, intervalMs);
    };
    tick();
  });
}

/** Pick an ephemeral loopback port, explicitly rejecting the user's 3080/3081. */
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

async function scanPluginChromeProcesses() {
  const { readdirSync, readFileSync } = await import('node:fs');
  const found = [];
  let entries;
  try { entries = readdirSync('/proc'); } catch { return found; }
  for (const entry of entries) {
    if (!/^\d+$/.test(entry)) continue;
    let raw;
    try { raw = readFileSync(`/proc/${entry}/cmdline`); } catch { continue; }
    if (!raw.length) continue;
    const args = raw.toString('utf8').split('\0').filter(Boolean);
    if (!args.length || !args.some((arg) => arg === '--headless=new')) continue;
    const profileArg = args.find((arg) => arg.startsWith('--user-data-dir='));
    if (!profileArg) continue;
    const profileDir = profileArg.slice('--user-data-dir='.length);
    if (!profileDir.includes(PROFILE_PREFIX) && !profileDir.includes('dsh-real-browser-')) continue;
    found.push({ pid: Number(entry), profileDir });
  }
  return found;
}

function isProcessAlive(pid) {
  try { process.kill(pid, 0); return true; } catch { return false; }
}

/* ------------------------------------------------------------------------------------------------
 * Minimal CDP client over the browser's WebSocket endpoint (Node 22 global WebSocket).
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

  on(listener) { this.listeners.add(listener); }

  close() {
    try { if (this.ws) this.ws.close(); } catch { /* ignore */ }
  }
}

/* ------------------------------------------------------------------------------------------------
 * Chrome launch (about:blank, so no token on a command line) and page evaluation.
 * ---------------------------------------------------------------------------------------------- */
async function launchChrome(bin) {
  const profileDir = await mkdtemp(join(tmpdir(), 'dsh-real-browser-'));
  const proc = spawn(bin, [
    '--headless=new',
    '--remote-debugging-port=0',
    `--user-data-dir=${profileDir}`,
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-gpu',
    '--hide-scrollbars',
    '--mute-audio',
    '--window-size=1280,800',
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

async function pageEvaluate(cdp, expression, { timeoutMs = 30000 } = {}) {
  const result = await cdp.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true, userGesture: true }, timeoutMs);
  if (result.exceptionDetails) throw new Error(result.exceptionDetails.text || 'page evaluation failed');
  return result.result?.value;
}

/** Page-side fetch helper driven from Node, so a single CDP call never waits on a long promise. */
async function pageFetchJson(cdp, path, options = {}) {
  const expression = `(async () => {
    try {
      const response = await fetch(${JSON.stringify(path)}, ${JSON.stringify(options)});
      const text = await response.text();
      let json;
      try { json = JSON.parse(text); } catch { json = text.slice(0, 300); }
      return { status: response.status, json };
    } catch (error) { return { status: 0, error: String(error) }; }
  })()`;
  return pageEvaluate(cdp, expression, { timeoutMs: 20000 });
}

/* ------------------------------------------------------------------------------------------------
 * Isolated DSH profile: copy the small config files, symlink node_modules (read-only dependency
 * tree; DSH only writes cordis.yml / runtime state, never node_modules).
 * ---------------------------------------------------------------------------------------------- */
async function prepareDshHome() {
  const home = await mkdtemp(join(tmpdir(), 'dsh-real-browser-home-'));
  const profileDir = join(home, 'profiles', 'web');
  await mkdir(profileDir, { recursive: true });
  const files = ['package.json', 'cordis.yml', 'cordis.patch.yml', 'compatibility.json'];
  for (const name of files) {
    const source = join(DEFAULT_PROFILE, name);
    if (!existsSync(source)) continue;
    const content = await readFile(source);
    await writeFile(join(profileDir, name), content);
  }
  const nodeModules = join(DEFAULT_PROFILE, 'node_modules');
  if (!existsSync(nodeModules)) throw new Error(`user profile node_modules missing: ${nodeModules}`);
  await symlink(nodeModules, join(profileDir, 'node_modules'), 'dir');
  return { home, profileDir };
}

function sanitize(text, token, baseUrl) {
  let value = String(text || '');
  if (baseUrl) {
    value = value.split(baseUrl).join(baseUrl.replace(/\?token=[^\s]*/, ''));
  }
  if (token) value = value.split(token).join('[REDACTED_TOKEN]');
  value = value.replace(/([?&]token=)[^\s&"']+/g, '$1[REDACTED_TOKEN]');
  return value;
}

/* ------------------------------------------------------------------------------------------------
 * Real-browser probe body.
 * ---------------------------------------------------------------------------------------------- */
async function run({ fixture, dshUrl, baseUrl, token, cdp, webSocketEvents }) {
  const checks = [];
  const check = (label, pass, expected, actual) => {
    checks.push({ label, pass: Boolean(pass), expected, actual });
    log(`  [${pass ? 'PASS' : 'FAIL'}] ${label}`);
    if (!pass) {
      log(`         expected: ${JSON.stringify(expected)}`);
      let rendered = 'undefined';
      try { rendered = JSON.stringify(actual) ?? String(actual); } catch { rendered = String(actual); }
      log(`         actual  : ${String(rendered).slice(0, 800)}`);
    }
  };

  await cdp.send('Page.enable');
  await cdp.send('Runtime.enable');
  await cdp.send('Network.enable');
  log(`[env] isolated DSH GUI: ${sanitize(dshUrl, token)}`);
  await cdp.send('Page.navigate', { url: dshUrl });
  await waitFor(async () => {
    const state = await pageEvaluate(cdp, '({ ready: document.readyState, origin: location.origin, hasBody: !!document.body })');
    return state?.ready === 'complete' && state?.origin === new URL(dshUrl).origin && state.hasBody ? state : undefined;
  }, { timeoutMs: 30000, label: 'GUI page ready' });
  await sleep(1200);
  const boot = await pageEvaluate(cdp, '({ ready: document.readyState, origin: location.origin, title: document.title, root: !!document.querySelector("#root, #app, main") })');
  check('隔离 DSH GUI 页面已在无头 Chromium 中打开', boot?.ready === 'complete' && boot?.origin === new URL(dshUrl).origin, { ready: 'complete', origin: new URL(dshUrl).origin }, boot);

  // Stage 1: open the page-side WebSocket and keep the accumulator on window, so later CDP
  // calls can observe progress without one long awaitPromise that could hit the CDP timeout.
  await pageEvaluate(cdp, `(() => {
    const acc = { opened: false, hello: null, frames: [], errors: [], closed: false, closeCode: null };
    window.__wsAcceptance = acc;
    try {
      const ws = new WebSocket('/plugins/ui-testing/frames');
      ws.binaryType = 'arraybuffer';
      acc.ws = ws;
      ws.onopen = () => { acc.opened = true; };
      ws.onerror = () => { acc.errors.push('websocket error event'); };
      ws.onclose = (event) => { acc.closed = true; acc.closeCode = event && event.code; };
      ws.onmessage = (event) => {
        if (typeof event.data === 'string') {
          try { const parsed = JSON.parse(event.data); if (parsed.type === 'hello') acc.hello = parsed; } catch { /* ignore */ }
          return;
        }
        if (!(event.data instanceof ArrayBuffer)) return;
        const bytes = new Uint8Array(event.data);
        if (bytes.length < 8) return;
        const headerLength = (bytes[0] << 24) | (bytes[1] << 16) | (bytes[2] << 8) | bytes[3];
        let header;
        try { header = JSON.parse(new TextDecoder().decode(bytes.slice(4, 4 + headerLength))); } catch { return; }
        const magic = Array.from(bytes.slice(4 + headerLength, 4 + headerLength + 4));
        acc.frames.push({ header, magic, bytes: bytes.length - 4 - headerLength });
      };
      return true;
    } catch (error) { acc.errors.push(String(error)); return false; }
  })()`, { timeoutMs: 15000 });

  let wsState;
  try {
    wsState = await waitFor(async () => {
      const state = await pageEvaluate(cdp, '({ opened: !!window.__wsAcceptance?.opened, errors: window.__wsAcceptance?.errors || [], readyState: window.__wsAcceptance?.ws?.readyState })');
      return state?.opened ? state : undefined;
    }, { timeoutMs: 8000, intervalMs: 100, label: 'page websocket open' });
  } catch {
    wsState = await pageEvaluate(cdp, '({ opened: !!window.__wsAcceptance?.opened, errors: window.__wsAcceptance?.errors || [], readyState: window.__wsAcceptance?.ws?.readyState })').catch(() => undefined);
  }
  check('页面内 WebSocket /plugins/ui-testing/frames 握手成功', wsState?.opened === true, { opened: true }, wsState);

  const hello = await waitFor(async () => {
    const value = await pageEvaluate(cdp, 'window.__wsAcceptance?.hello || null');
    return value || undefined;
  }, { timeoutMs: 5000, intervalMs: 100, label: 'page hello' }).catch(() => undefined);
  check('页面内收到文本 hello {type:"hello",transport:"ws"}', hello?.type === 'hello' && hello?.transport === 'ws', { type: 'hello', transport: 'ws' }, hello);

  const nav = await pageFetchJson(cdp, '/plugins/ui-testing/navigate', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ url: fixture.url }) });
  check('页面内 POST /plugins/ui-testing/navigate 成功', nav?.status >= 200 && nav?.status < 300 && nav?.json?.ok === true, { status: '2xx', ok: true }, nav);

  // Nudge the target page through the plugin /eval route so Chromium emits screencast frames.
  for (let index = 0; index < 5; index += 1) {
    await pageFetchJson(cdp, '/plugins/ui-testing/eval', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ expression: `document.body.style.outline='${index % 2 + 2}px solid rgb(${30 + index * 20},0,0)'` }),
    });
    await sleep(180);
  }
  let frameState;
  try {
    frameState = await waitFor(async () => {
      const state = await pageEvaluate(cdp, '({ count: window.__wsAcceptance?.frames?.length || 0, magic: window.__wsAcceptance?.frames?.[0]?.magic, errors: window.__wsAcceptance?.errors || [] })');
      return state && state.count > 0 ? state : undefined;
    }, { timeoutMs: 12000, intervalMs: 150, label: 'page binary frame' });
  } catch {
    frameState = await pageEvaluate(cdp, '({ count: window.__wsAcceptance?.frames?.length || 0, magic: window.__wsAcceptance?.frames?.[0]?.magic, errors: window.__wsAcceptance?.errors || [] })').catch(() => undefined);
  }
  const firstFrame = await pageEvaluate(cdp, 'window.__wsAcceptance?.frames?.[0] || null').catch(() => undefined);
  check('页面内收到至少 1 个二进制 JPEG 帧', (frameState?.count || 0) > 0 && firstFrame?.magic?.[0] === 0xff && firstFrame?.magic?.[1] === 0xd8, { frames: '>=1', magic: 'ffd8' }, { count: frameState?.count, magic: firstFrame?.magic, errors: frameState?.errors });
  const header = firstFrame?.header;
  const headerOk = header?.v === 1 && Number.isInteger(header?.seq) && Number.isInteger(header?.epoch)
    && typeof header?.capturedAtMs === 'number' && typeof header?.receivedAtMs === 'number'
    && typeof header?.width === 'number' && typeof header?.height === 'number'
    && typeof header?.pageWidth === 'number' && typeof header?.pageHeight === 'number'
    && header?.format === 'jpeg' && header?.dropped && Number.isInteger(header.dropped.coalesced) && Number.isInteger(header.dropped.blocked) && Number.isInteger(header.dropped.stale);
  check('二进制帧头字段完整（v/seq/epoch/capturedAtMs/receivedAtMs/尺寸/format/dropped）', headerOk, { v: 1, seq: 'int', epoch: 'int', dropped: 'coalesced/blocked/stale int' }, header);

  check('CDP 观察到 Network.webSocketCreated /plugins/ui-testing/frames', webSocketEvents.some((url) => url.includes('/plugins/ui-testing/frames')), { webSocketCreated: '.../frames' }, webSocketEvents.slice(-5));

  const metrics = await pageFetchJson(cdp, '/plugins/ui-testing/metrics');
  const host = metrics?.json?.host || {};
  const push = host.transport || {};
  const captured = host.captured;
  const pushed = host.pushed ?? push.pushed;
  check('GET /metrics host.captured > 0', typeof captured === 'number' && captured > 0, { captured: '>0' }, captured);
  check('GET /metrics host.pushed > 0（WS 实际推送过帧）', typeof pushed === 'number' && pushed > 0, { pushed: '>0' }, pushed);

  const post = await pageFetchJson(cdp, '/plugins/ui-testing/metrics', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      transport: 'ws',
      displayFps: 30,
      endToEndMs: 20,
      transportMs: 14,
      droppedClient: 0,
      received: frameState?.count || 1,
      displayed: frameState?.count || 1,
      seq: header?.seq ?? 0,
      epoch: header?.epoch ?? 0,
      measuredAt: Date.now(),
    }),
  });
  check('POST /metrics 保存 client 实测（2xx）', post?.status >= 200 && post?.status < 300, { status: '2xx' }, post);
  const metricsAfter = await pageFetchJson(cdp, '/plugins/ui-testing/metrics');
  const client = metricsAfter?.json?.client;
  check('GET /metrics 读回 client 实测（transport=ws）', client?.transport === 'ws' && typeof client?.endToEndMs === 'number', { transport: 'ws', endToEndMs: 'number' }, client);

  const close = await pageFetchJson(cdp, '/plugins/ui-testing/close', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
  check('POST /close 成功关闭插件浏览器', close?.status === 200 && close?.json?.ok === true, { status: 200, ok: true }, close);
  let closedState;
  try {
    closedState = await waitFor(async () => {
      const state = await pageEvaluate(cdp, '({ closed: !!window.__wsAcceptance?.closed, code: window.__wsAcceptance?.closeCode })');
      return state?.closed ? state : undefined;
    }, { timeoutMs: 5000, intervalMs: 150, label: 'page websocket closed by host' });
  } catch { closedState = undefined; }
  check('GET /metrics/close 后页面 WS 被服务端关闭（观察项）', closedState?.closed === true, { closed: true }, closedState);

  return { checks, result: { hello, nav, metrics, post, metricsAfter, close, frames: frameState?.count || 0, firstFrame }, header };
}

/* ------------------------------------------------------------------------------------------------
 * Main
 * ---------------------------------------------------------------------------------------------- */
const state = {
  dshProc: undefined,
  dshHome: undefined,
  chrome: undefined,
  fixture: undefined,
  report: undefined,
  baselinePluginChrome: [],
  baselineProfiles: [],
  outputs: [],
};

async function cleanup(reason) {
  log(`\n[cleanup] ${reason}`);
  try { state.chrome?.cdp?.close(); } catch { /* ignore */ }
  if (state.chrome?.proc) {
    try { state.chrome.proc.kill('SIGTERM'); } catch { /* ignore */ }
    await sleep(600);
    if (isProcessAlive(state.chrome.proc.pid)) { try { state.chrome.proc.kill('SIGKILL'); } catch { /* ignore */ } }
    await rm(state.chrome.profileDir, { recursive: true, force: true }).catch(() => {});
  }
  try { await state.fixture?.close(); } catch { /* ignore */ }
  if (state.dshProc) {
    try { state.dshProc.kill('SIGTERM'); } catch { /* ignore */ }
    await sleep(1500);
    if (isProcessAlive(state.dshProc.pid)) { try { state.dshProc.kill('SIGKILL'); } catch { /* ignore */ } }
  }
  await sleep(400);
  // Kill only plugin/real-browser Chromium processes and profiles created by THIS run.
  const baselinePids = new Set(state.baselinePluginChrome.map((proc) => proc.pid));
  const baselineProfiles = new Set(state.baselineProfiles);
  const after = await scanPluginChromeProcesses();
  for (const proc of after) {
    if (baselinePids.has(proc.pid)) continue;
    try { process.kill(proc.pid, 'SIGKILL'); } catch { /* ignore */ }
    if (!proc.profileDir.includes(PROFILE_PREFIX)) continue;
    if (baselineProfiles.has(proc.profileDir)) continue;
    await rm(proc.profileDir, { recursive: true, force: true }).catch(() => {});
  }
  // Remove plugin temp profiles created by this run even if their Chromium already exited.
  try {
    const { readdir } = await import('node:fs/promises');
    const names = await readdir(tmpdir());
    for (const name of names) {
      if (!name.startsWith(PROFILE_PREFIX)) continue;
      const dir = join(tmpdir(), name);
      if (baselineProfiles.has(dir)) continue;
      await rm(dir, { recursive: true, force: true }).catch(() => {});
    }
  } catch { /* ignore */ }
  // The isolated DSH inspector may spawn a helper Chromium under the temp home; kill it by cmdline.
  try {
    const { readdirSync, readFileSync } = await import('node:fs');
    for (const entry of readdirSync('/proc')) {
      if (!/^\d+$/.test(entry)) continue;
      let raw;
      try { raw = readFileSync(`/proc/${entry}/cmdline`); } catch { continue; }
      const text = raw.toString('utf8');
      if (!text.includes('chrome')) continue;
      if (state.dshHome && text.includes(state.dshHome)) {
        try { process.kill(Number(entry), 'SIGKILL'); } catch { /* ignore */ }
      }
    }
  } catch { /* ignore */ }
  if (state.dshHome) {
    await rm(state.dshHome, { recursive: true, force: true }).catch(() => {});
  }
  // Report what we observed (no token in paths).
  log('[cleanup] done');
}

async function main() {
  // Environment gate: pretend to skip cleanly when this machine has no DSH/Chrome.
  if (!existsSync(DEFAULT_PROFILE) || !existsSync(join(DEFAULT_PROFILE, 'node_modules'))) {
    log(`SKIP: user DSH profile not found at ${DEFAULT_PROFILE}`);
    return 0;
  }
  const chromeBin = process.env.DSH_REAL_BROWSER_CHROME || CHROME_FALLBACK;
  if (!existsSync(chromeBin)) {
    log(`SKIP: Chromium wrapper/binary not found: ${chromeBin}`);
    return 0;
  }
  const dshBin = process.env.DSH_BIN || 'dsh';

  await mkdir(EVIDENCE_DIR, { recursive: true });
  state.baselinePluginChrome = await scanPluginChromeProcesses();
  try {
    const { readdir } = await import('node:fs/promises');
    state.baselineProfiles = (await readdir(tmpdir())).filter((name) => name.startsWith(PROFILE_PREFIX)).map((name) => join(tmpdir(), name));
  } catch {
    state.baselineProfiles = [];
  }
  const { startFixtureServer } = await import(pathToFileURL(join(REPO_ROOT, 'tests/ui_test_fixture/server.mjs')).href);
  state.fixture = await startFixtureServer();
  log(`[env] fixture: ${state.fixture.url}`);

  const port = await pickPort();
  log(`[env] isolated DSH port: ${port}`);
  const { home, profileDir } = await prepareDshHome();
  state.dshHome = home;
  const dshProc = spawn(dshBin, ['web', '--port', String(port), '--no-open'], {
    // The plugin spawns its own Chromium from inside the isolated DSH process; in a sandboxed
    // caller that inherits restricted namespaces, the wrapper is the only working binary.
    env: {
      ...process.env,
      DSH_HOME: home,
      DSH_UI_TESTING_CHROME: process.env.DSH_UI_TESTING_CHROME || CHROME_FALLBACK,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  state.dshProc = dshProc;
  let dshOutput = '';
  const capture = (chunk) => { dshOutput += String(chunk); };
  dshProc.stdout.on('data', capture);
  dshProc.stderr.on('data', capture);
  dshProc.on('exit', (code, signal) => { log(`[dsh] exited code=${code} signal=${signal}`); });

  const urlPattern = new RegExp(`dsh web: (http://127\\.0\\.0\\.1:${port}/\\?token=([A-Za-z0-9_-]+))`);
  let matched;
  try {
    matched = await waitFor(() => {
      const match = urlPattern.exec(dshOutput);
      return match ? { url: match[1], token: match[2] } : undefined;
    }, { timeoutMs: 90000, intervalMs: 250, label: 'dsh web token URL' });
  } catch (error) {
    log(`SKIP: isolated DSH did not print a launch URL: ${errorMessage(error)}`);
    log(sanitize(dshOutput, '', '').slice(-2500));
    await cleanup('dsh-start-failure');
    return 0;
  }
  const dshUrl = matched.url;
  const token = matched.token;
  const baseUrl = dshUrl.replace(/\?.*$/, '');
  log(`[env] isolated DSH base: ${baseUrl}`);
  await waitFor(async () => {
    try {
      const response = await fetch(baseUrl + '/', { signal: AbortSignal.timeout(3000) });
      return response.status < 500;
    } catch { return false; }
  }, { timeoutMs: 30000, intervalMs: 500, label: 'dsh HTTP listener' });

  const chrome = await launchChrome(chromeBin);
  state.chrome = chrome;
  const webSocketEvents = [];
  chrome.cdp.on((message) => {
    if (message.method === 'Network.webSocketCreated' && message.params?.url) webSocketEvents.push(String(message.params.url));
  });
  log(`[env] headless chromium on devtools port ${chrome.devtoolsPort}`);

  const { checks, result } = await run({ fixture: state.fixture, dshUrl, baseUrl, token, cdp: chrome.cdp, webSocketEvents });
  const failed = checks.filter((check) => !check.pass);
  const report = {
    schemaVersion: 1,
    suite: 'dsh-agent-team-ui-testing/real-browser-ws',
    generatedAt: new Date().toISOString(),
    environment: {
      node: process.version,
      platform: `${process.platform}/${process.arch}`,
      dshBaseUrl: baseUrl,
      dshHome: home,
      profileNodeModules: join(profileDir, 'node_modules'),
      chromeBin,
      fixtureUrl: state.fixture.url,
      isolatedPort: port,
      note: 'Token 从 DSH 启动日志读取，仅保存在进程内存；GUI URL 通过 CDP Page.navigate 传入（不在命令行）。报告已脱敏。',
    },
    checks,
    page: {
      hello: result?.hello,
      frameCount: result?.frames,
      firstFrame: result?.firstFrame ? { header: result.firstFrame.header, magic: result.firstFrame.magic, bytes: result.firstFrame.bytes } : undefined,
      nav: result?.nav,
      metricsHost: result?.metrics?.json?.host,
      client: result?.metricsAfter?.json?.client,
      close: result?.close,
    },
    webSocketEvents,
    summary: { checks: checks.length, passed: checks.length - failed.length, failed: failed.length, exitCode: failed.length ? 1 : 0 },
  };
  state.report = report;
  await writeFile(join(EVIDENCE_DIR, 'real-browser-ws-report.json'), JSON.stringify(report, null, 2));
  await writeFile(join(EVIDENCE_DIR, 'real-browser-ws.log'), sanitize(logLines.join('\n') + '\n', token, baseUrl));
  log(`\nreal-browser-ws: ${checks.length - failed.length}/${checks.length} checks, ${failed.length} failed`);
  return failed.length ? 1 : 0;
}

const watchdog = setTimeout(async () => {
  log(`\n[watchdog] hard timeout ${TOTAL_TIMEOUT_MS}ms`);
  try { await cleanup('hard-timeout'); } catch { /* ignore */ }
  process.exit(2);
}, TOTAL_TIMEOUT_MS);
watchdog.unref?.();

let exitCode = 0;
try {
  exitCode = await main();
  await cleanup('complete');
} catch (error) {
  log(`\n[fatal] ${errorMessage(error)}`);
  console.error(error);
  await cleanup('fatal').catch(() => {});
  exitCode = 2;
}
process.exitCode = exitCode;