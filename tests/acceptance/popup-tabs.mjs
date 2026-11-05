#!/usr/bin/env node
/**
 * Deterministic real-GUI acceptance for popup internal tabs (task-16; popup-new-tab-policy.md).
 *
 * Own isolated DSH (random loopback port, temporary DSH_HOME, separate headless Chromium; never
 * 3080/3081), plus a local target=_blank/rel=noopener/window.open/auto-timer fixture. It proves:
 *   - a GUI click creates one internal tab, active and address-following; the original tab and its
 *     URL/history stay intact; tabs switch both ways;
 *   - the toolbar toggle sits immediately left of 标注, hides/restores the strip without losing
 *     pages; the strip is below the address bar and above the stage; it is visible for a single
 *     tab too (the toggle is a pure preference, never conditioned on the tab count);
 *   - child navigation B->C and back B does not replace A; child binding /input reaches B;
 *   - closing a child uses the binding /close, removes its view and returns to primary;
 *   - forbidden target, no-ticket and over-cap popups add no tab and show a fixed notice;
 *   - automatic timer window.open adds no tab.
 *
 * NOT_RUN (reported honestly): cross-workspace attribution, two panels/second popup in one action,
 * refresh/restore/external window.close, Agent lease race and direct Agent-tool checks, seed/barrier,
 * BUSY injection and the original Baidu page.
 *
 * Run: node tests/acceptance/popup-tabs.mjs
 * Exit: 0 pass (NOT_RUN allowed), 1 assertion failure, 2 fatal.
 * Reports: tests/acceptance/runs/popup-tabs-<stamp>/ + evidence/popup-tabs-<stamp>/.
 */
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { createServer as createHttpServer } from 'node:http';
import { createServer as createNetServer } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHarness, createFakeConnectionService } from './harness.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = dirname(HERE);
const REPO_ROOT = dirname(REPO);
const STAMP = new Date().toISOString().replace(/[:.]/g, '-');
const RUN_DIR = join(HERE, 'runs', `popup-tabs-${STAMP}-${process.pid}`);
const EVIDENCE = join(HERE, 'evidence', `popup-tabs-${STAMP}`);
const CHROME = process.env.DSH_ACCEPTANCE_CHROME || process.env.DSH_REAL_BROWSER_CHROME || join(HERE, 'chrome-wrapper.sh');
const DSH = process.env.DSH_BIN || 'dsh';
const PROFILE = join(process.env.HOME || '', '.dsh', 'profiles', 'web');
const logLines = [];
const log = (line = '') => { logLines.push(String(line)); console.log(line); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const checks = [];
const notRuns = [];
const observations = {};
function check(label, pass, expected, actual) {
  checks.push({ label, pass: Boolean(pass), expected, actual });
  log(`${pass ? 'PASS' : 'FAIL'} ${label}`);
  if (!pass) log('  expected=' + JSON.stringify(expected) + ' actual=' + JSON.stringify(actual));
  return Boolean(pass);
}
function notRun(label, reason, detail) {
  notRuns.push({ label, reason: String(reason), detail });
  log(`NOT_RUN ${label} — ${reason}`);
}
function waitFor(fn, { timeoutMs = 20000, intervalMs = 150, label = 'condition' } = {}) {
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
  for (let i = 0; i < 20; i += 1) {
    const port = await new Promise((resolve, reject) => {
      const server = createNetServer();
      server.once('error', reject);
      server.listen(0, '127.0.0.1', () => { const p = server.address().port; server.close(() => resolve(p)); });
    });
    if (port !== 3080 && port !== 3081) return port;
  }
  throw new Error('no port');
}
class Cdp {
  constructor(url) { this.url = url; this.id = 0; this.pending = new Map(); this.listeners = new Set(); }
  connect() {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(this.url);
      this.ws = ws;
      ws.onopen = () => resolve(this);
      ws.onerror = () => reject(new Error('cdp open failed'));
      ws.onmessage = (event) => {
        const message = JSON.parse(String(event.data));
        if (message.id) {
          const entry = this.pending.get(message.id);
          if (!entry) return;
          this.pending.delete(message.id);
          if (message.error) entry.reject(new Error(message.error.message)); else entry.resolve(message.result);
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
      setTimeout(() => { if (this.pending.delete(id)) reject(new Error('cdp timeout ' + method)); }, timeoutMs);
    });
  }
  on(fn) { this.listeners.add(fn); return () => this.listeners.delete(fn); }
  close() { try { this.ws.close(); } catch { /* ignore */ } }
}
async function launchChrome() {
  const profileDir = await mkdtemp(join(tmpdir(), 'dsh-wheel-'));
  const proc = spawn(CHROME, ['--headless=new', '--remote-debugging-port=0', `--user-data-dir=${profileDir}`,
    '--no-first-run', '--no-default-browser-check', '--disable-gpu', '--hide-scrollbars', '--window-size=1600,1000', 'about:blank'],
  { stdio: ['ignore', 'ignore', 'pipe'] });
  const port = await waitFor(async () => { try { return Number((await readFile(join(profileDir, 'DevToolsActivePort'), 'utf8')).split('\n')[0]) || 0; } catch { return 0; } },
    { timeoutMs: 20000, label: 'chrome port' });
  const list = await fetch(`http://127.0.0.1:${port}/json/list`).then((r) => r.json());
  const page = list.find((t) => t.type === 'page');
  const cdp = new Cdp(page.webSocketDebuggerUrl);
  await cdp.connect();
  await cdp.send('Page.enable');
  await cdp.send('Runtime.enable');
  await cdp.send('Network.enable');
  return { proc, profileDir, port, cdp };
}
async function prepareDshHome() {
  const home = await mkdtemp(join(tmpdir(), 'dsh-wheel-home-'));
  const profileDir = join(home, 'profiles', 'web');
  await mkdir(profileDir, { recursive: true });
  for (const name of ['package.json', 'cordis.patch.yml', 'compatibility.json', 'pnpm-lock.yaml', 'cordis.yml']) {
    const source = join(PROFILE, name);
    if (existsSync(source)) await writeFile(join(profileDir, name), await readFile(source));
  }
  await symlink(join(PROFILE, 'node_modules'), join(profileDir, 'node_modules'), 'dir');
  return { home, profileDir };
}
async function startDsh() {
  const { home } = await prepareDshHome();
  const port = await pickPort();
  const proc = spawn(DSH, ['web', '--port', String(port), '--no-open'], {
    env: { ...process.env, DSH_HOME: home, DSH_PROFILE: 'web', DSH_UI_TESTING_CHROME: process.env.DSH_UI_TESTING_CHROME || CHROME },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '';
  proc.stdout.on('data', (c) => { output += String(c); });
  proc.stderr.on('data', (c) => { output += String(c); });
  const match = await waitFor(() => {
    const m = (() => { const hit = /dsh web:\s*(https?:\/\/\S+)/.exec(output); if (!hit) return null; const url = hit[1]; let token = ''; try { token = new URL(url).searchParams.get('token') || ''; } catch { return null; } return token ? [url, token] : null; })();
    return m ? { url: m[0], token: m[1] } : undefined;
  }, { timeoutMs: 120000, intervalMs: 250, label: 'dsh launch url' });
  await waitFor(async () => { try { return (await fetch(`http://127.0.0.1:${port}/`, { signal: AbortSignal.timeout(3000) })).status < 500; } catch { return false; } },
    { timeoutMs: 40000, label: 'dsh listener' });
  return { proc, home, port, base: `http://127.0.0.1:${port}`, launchUrl: match.url, token: match.token };
}
async function authenticate(launchUrl) {
  const response = await fetch(launchUrl, { redirect: 'manual', signal: AbortSignal.timeout(20000) });
  const cookies = response.headers.getSetCookie().map((v) => v.split(';')[0]);
  if (!cookies.length) throw new Error('no cookie');
  return cookies;
}
async function evaluate(expression) {
  const result = await state.chrome.cdp.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true, userGesture: true });
  if (result.exceptionDetails) throw new Error('eval: ' + JSON.stringify(result.exceptionDetails).slice(0, 500));
  return result.result ? result.result.value : undefined;
}
async function clickAt(x, y) {
  await state.chrome.cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y, button: 'none', buttons: 0 });
  await state.chrome.cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', buttons: 1, clickCount: 1 });
  await state.chrome.cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', buttons: 0, clickCount: 1 });
  await sleep(180);
}
async function wheelAt(x, y, deltaY, deltaX = 0) {
  await state.chrome.cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y, button: 'none', buttons: 0 });
  await state.chrome.cdp.send('Input.dispatchMouseEvent', { type: 'mouseWheel', x, y, deltaX, deltaY, modifiers: 0 });
  await sleep(250);
}
const state = { chrome: undefined, dsh: undefined, fixture: undefined, scope: null, requests: [], exceptions: [], consoleErrors: [], token: '' };
async function pageHostFetch(path, { method = 'GET', headers = {}, body } = {}) {
  const expression = `(async () => {
    const response = await fetch(${JSON.stringify('/plugins/ui-testing' + path + (path.includes('?') ? '&' : '?') + 'utbVerify=1')}, {
      method: ${JSON.stringify(method)},
      headers: ${JSON.stringify(headers)},
      ${body === undefined ? '' : `body: ${JSON.stringify(JSON.stringify(body))},`}
      credentials: 'same-origin', cache: 'no-store',
    });
    const text = await response.text();
    let json; try { json = JSON.parse(text); } catch { json = text; }
    return { status: response.status, json, text: String(text).slice(0, 400) };
  })()`;
  return evaluate(expression);
}
async function hostState() {
  const response = await pageHostFetch('/state', { headers: state.scope });
  if (response.status !== 200) throw new Error('state ' + response.status);
  return response.json;
}
async function targetEval(expression) {
  const response = await pageHostFetch('/eval', { method: 'POST', headers: { ...state.scope, 'content-type': 'application/json' }, body: { expression } });
  return response.json && response.json.value;
}
async function setAddressBar(url) {
  const rect = await evaluate(`(() => { const i = document.querySelector('.utb-addr'); const r = i.getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; })()`);
  await clickAt(rect.x, rect.y);
  await state.chrome.cdp.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'a', code: 'KeyA', windowsVirtualKeyCode: 65, modifiers: 2 });
  await state.chrome.cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'a', code: 'KeyA', windowsVirtualKeyCode: 65, modifiers: 2 });
  await state.chrome.cdp.send('Input.insertText', { text: url });
  await sleep(150);
  let value = await evaluate(`document.querySelector('.utb-addr') ? document.querySelector('.utb-addr').value : null`);
  if (value !== url) {
    value = await evaluate(`(() => {
      const input = document.querySelector('.utb-addr');
      if (!input) return null;
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
      setter.call(input, ${JSON.stringify(url)});
      input.dispatchEvent(new Event('input', { bubbles: true }));
      return input.value;
    })()`);
    await sleep(150);
  }
  await state.chrome.cdp.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13 });
  await state.chrome.cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13 });
  const changed = await waitFor(async () => {
    const snapshot = await hostState();
    return String(snapshot.ui?.address || '') === url ? snapshot : undefined;
  }, { timeoutMs: 2500, intervalMs: 150, label: 'address submit' }).catch(() => undefined);
  if (!changed) {
    await evaluate(`(async () => {
      const input = document.querySelector('.utb-addr');
      const form = input && input.closest('form');
      if (form) form.requestSubmit();
      await new Promise((resolve) => setTimeout(resolve, 50));
      return true;
    })()`);
  }
  log('[env] address typed=' + value + ' alert=' + await evaluate(`(() => { const el = document.querySelector('.utb-sr[role="alert"]'); return el ? el.textContent : ''; })()`));
  await waitFor(async () => { const snap = await hostState(); return String(snap.ui?.address || '') === url ? snap : undefined; }, { timeoutMs: 20000, label: 'navigate' });
}
function chain() {
  return evaluate(`(() => {
    const chain = [];
    let el = document.querySelector('.utb-stage');
    while (el) {
      chain.push({ tag: el.tagName, cls: String(el.className || ''), top: el.scrollTop, left: el.scrollLeft,
        sh: el.scrollHeight, ch: el.clientHeight, sw: el.scrollWidth, cw: el.clientWidth });
      el = el.parentElement;
    }
    return { chain, docX: document.scrollingElement.scrollLeft, docY: document.scrollingElement.scrollTop };
  })()`);
}
function chainUnchanged(a, b) {
  if (!a || !b || a.chain.length !== b.chain.length) return false;
  if (Math.abs(a.docX - b.docX) > 1 || Math.abs(a.docY - b.docY) > 1) return false;
  return a.chain.every((row, index) => Math.abs(Number(row.top) - Number(b.chain[index].top)) <= 1
    && Math.abs(Number(row.left) - Number(b.chain[index].left)) <= 1);
}
function boxGeom() {
  return evaluate(`(() => {
    const box = document.querySelector('.utb-box');
    const img = document.querySelector('.utb-frame');
    const stage = document.querySelector('.utb-stage');
    if (!box || !img || !stage || !img.naturalWidth) return null;
    const b = box.getBoundingClientRect();
    const s = stage.getBoundingClientRect();
    const nw = img.naturalWidth, nh = img.naturalHeight;
    const scale = Math.min(b.width / nw, b.height / nh);
    const left = b.left + (b.width - nw * scale) / 2;
    const top = b.top + (b.height - nh * scale) / 2;
    return { left, top, width: nw * scale, height: nh * scale, box: { left: b.left, top: b.top, width: b.width, height: b.height },
      stage: { left: s.left, top: s.top, width: s.width, height: s.height },
      ready: box.getAttribute('data-utb-canvas-ready'), barrier: box.getAttribute('data-utb-canvas-barrier'),
      detail: box.getAttribute('data-utb-canvas-detail') };
  })()`);
}
function screenOf(geom, viewW, viewH, qx, qy) {
  return { x: geom.left + (qx / viewW) * geom.width, y: geom.top + (qy / viewH) * geom.height };
}
function inputRequests(filter) {
  return state.requests.filter((r) => r.url.includes('/plugins/ui-testing/input') && r.postData.includes(filter)).length;
}
function panelViewportPosts(since) {
  return state.requests.filter((r) => r.url.includes('/plugins/ui-testing/viewport') && r.method === 'POST'
    && !r.url.includes('utbVerify=1') && r.at >= since).length;
}

function installNetworkCapture() {
  state.chrome.cdp.on((message) => {
    if (message.method === 'Network.requestWillBeSent') {
      const request = message.params.request || {};
      const headers = request.headers || {};
      const headerValue = (name) => { for (const [key, value] of Object.entries(headers)) if (String(key).toLowerCase() === name) return String(value); return ''; };
      const url = String(request.url || '');
      state.requests.push({ at: Date.now(), url, method: String(request.method || ''), postData: String(request.postData || ''),
        headerVerify: headerValue('x-utb-verify') });
      if (!state.scope && url.includes('/plugins/ui-testing/state')) {
        const scope = {};
        const version = headerValue('x-ui-testing-scope-version');
        const session = headerValue('x-ui-testing-session-id');
        const binding = headerValue('x-ui-testing-scope-binding');
        if (version) scope['X-UI-Testing-Scope-Version'] = version;
        if (session) scope['X-UI-Testing-Session-Id'] = session;
        else if (binding) scope['X-UI-Testing-Scope-Binding'] = binding;
        if (scope['X-UI-Testing-Scope-Version']) state.scope = scope;
      }
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

async function openPanel() {
  await evaluate(`(() => {
    for (const dialog of [...document.querySelectorAll('[role="dialog"]')]) {
      const button = [...dialog.querySelectorAll('button')].find((node) => /关闭|close/i.test((node.getAttribute('aria-label') || '') + (node.textContent || '')));
      if (button) button.click();
    }
    if (!document.querySelector('button[aria-label="收起侧边栏"]')) {
      const expand = document.querySelector('button[aria-label="展开侧边栏"]');
      if (expand) expand.click();
    }
    return true;
  })()`);
  await sleep(500);
  await waitFor(async () => {
    const clicked = await evaluate(`(() => { const button = document.querySelector('button[aria-label="更多"]:not(.utb-btn)'); if (!button) return 'no-more'; button.click(); return 'clicked'; })()`);
    if (clicked !== 'clicked') return undefined;
    await sleep(400);
    return evaluate(`(() => {
      const direct = [...document.querySelectorAll('.utb-menu-row')].find((el) => (el.textContent || '').includes('调试视图'));
      const fallback = direct || [...document.querySelectorAll('button, a, [role="menuitem"]')].find((el) => (el.textContent || '').trim() === '调试视图');
      if (!fallback) return false;
      fallback.click();
      return true;
    })()`);
  }, { timeoutMs: 15000, intervalMs: 250, label: '更多 → 调试视图' });
  await waitFor(() => evaluate(`!!document.querySelector('.utb')`), { timeoutMs: 15000, label: 'debug panel' });
}

async function setStageScroll(value) {
  return evaluate(`(() => { const s = document.querySelector('.utb-stage'); if (!s) return null; s.scrollTop = ${value === 'max' ? 's.scrollHeight' : Number(value) || 0}; s.scrollLeft = 0; return { top: s.scrollTop, max: s.scrollHeight - s.clientHeight }; })()`);
}

function inStage(geom, point) {
  if (!geom || !geom.stage) return false;
  const stage = geom.stage;
  return point.x >= stage.left + 1 && point.x <= stage.left + stage.width - 1
    && point.y >= stage.top + 1 && point.y <= stage.top + stage.height - 1;
}

function slugFor(name) {
  return String(name).replace(/[=<>]/g, (ch) => ({ '=': 'eq', '<': 'lt', '>': 'gt' }[ch])).replace(/[^a-z0-9]+/gi, '-');
}

async function captureGuiPng(name) {
  const shot = await state.chrome.cdp.send('Page.captureScreenshot', { format: 'png' });
  const buffer = Buffer.from(shot.data, 'base64');
  await writeFile(join(EVIDENCE, name), buffer);
  await writeFile(join(RUN_DIR, name), buffer);
  observations.screenshots = observations.screenshots || [];
  observations.screenshots.push({ name, bytes: buffer.length });
}

async function main() {
  if (!existsSync(PROFILE) || !existsSync(join(PROFILE, 'node_modules'))) {
    notRun('ENV isolated DSH', 'user DSH profile or node_modules missing at ' + PROFILE);
    return 0;
  }
  if (!existsSync(CHROME)) {
    notRun('ENV headless Chromium', 'chrome binary/wrapper missing: ' + CHROME);
    return 0;
  }
  await mkdir(RUN_DIR, { recursive: true });
  await mkdir(EVIDENCE, { recursive: true });

  const MARKER = 'POPUP_TABS_MARKER_' + Date.now().toString(36);
  state.fixture = createHttpServer((req, res) => {
    const reqUrl = new URL(req.url || '/', 'http://127.0.0.1');
    if (reqUrl.pathname === '/popup-b') {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      res.end('<!doctype html><title>Popup B</title><h1>POPUP_B</h1><a id="to-c" href="/popup-c">C</a><button id="pb" onclick="window.__pb=(window.__pb||0)+1">B</button>');
      return;
    }
    if (reqUrl.pathname === '/popup-c') {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      res.end('<!doctype html><title>Popup C</title><h1>POPUP_C</h1>');
      return;
    }
    const left = [];
    const right = [];
    for (let y = 100; y <= 2900; y += 100) {
      left.push(`<button class="btn btn-left" id="btn-${y}-l" style="top:${y}px" onclick="window.__bump('btn-${y}-l', event)">${y}L</button>`);
      right.push(`<button class="btn btn-right" id="btn-${y}-r" style="top:${y}px" onclick="window.__bump('btn-${y}-r', event)">${y}R</button>`);
    }
    const inner = [10, 450, 850].map((y) => `<button id="inner-${y}" style="position:absolute;left:10px;top:${y}px;width:200px;height:40px" onclick="window.__bump('inner-${y}', event)">inner ${y}</button>`).join('');
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
    res.end(`<!doctype html><html><head><meta charset="utf-8"><style>
      html,body{margin:0;padding:0}body{height:3000px;width:1200px;position:relative;font:14px sans-serif}
      .btn{position:absolute;width:320px;height:48px}
      .btn-left{left:20px}.btn-right{left:860px}
      #fixed{position:fixed;left:700px;top:20px;width:160px;height:40px;z-index:5}
      #sticky{position:sticky;top:0;height:30px;background:#eee;z-index:4}
      #inner{position:absolute;left:500px;top:800px;width:260px;height:180px;overflow:auto;border:1px solid #999;background:#fafafa}
      #inner-content{position:relative;height:900px;width:600px}
      #overlay{position:fixed;inset:0;background:rgba(0,0,0,.35);display:none;z-index:9}
      #overlay[data-open="1"]{display:block}
      #tick{position:absolute;left:900px;top:80px}
    </style></head><body>
      <h1 id="marker" style="position:absolute;left:900px;top:120px">${MARKER}</h1>
      <a id="popup-link" href="/popup-b" target="_blank" rel="noopener" style="position:absolute;left:500px;top:300px;padding:16px;background:#ddd">open popup</a>
      <a id="popup-link2" href="/popup-b" target="_blank" style="position:absolute;left:500px;top:360px;padding:16px;background:#ddd">open popup noopener=false</a>
      <button id="js-open" style="position:absolute;left:500px;top:420px;padding:16px" onclick="window.open('/popup-b','_blank')">JS open</button>
      <a id="forbidden" href="http://169.254.169.254/" target="_blank" rel="noopener" style="position:absolute;left:500px;top:480px;padding:16px">forbidden</a>
      <div id="sticky">sticky bar</div>
      <div id="tick">0</div>
      <button id="fixed" onclick="window.__bump('fixed', event)">fixed</button>
      <button id="overlay-toggle" style="position:absolute;left:900px;top:200px;width:180px;height:40px" onclick="window.__overlay(event)">overlay</button>
      <div id="overlay" data-open="0" onclick="window.__overlay(event)"></div>
      ${left.join('')}
      ${right.join('')}
      <div id="inner"><div id="inner-content">${inner}</div></div>
      <script>
        window.__counts = {}; window.__clicks = []; window.__wheels = []; window.__mouse = [];
        window.__bump = (id, event) => { window.__counts[id] = (window.__counts[id] || 0) + 1;
          window.__clicks.push({ id, trusted: event.isTrusted, x: event.clientX, y: event.clientY }); };
        window.__overlay = (event) => { const o = document.getElementById('overlay');
          o.setAttribute('data-open', o.getAttribute('data-open') === '1' ? '0' : '1'); };
        window.__innerScroll = () => document.getElementById('inner').scrollTop;
        for (const type of ['mousedown', 'mouseup', 'click']) {
          document.addEventListener(type, (e) => { window.__mouse.push({ type, target: e.target && e.target.id,
            x: e.clientX, y: e.clientY, trusted: e.isTrusted }); }, true);
        }
        document.addEventListener('wheel', (e) => { window.__wheels.push({ target: e.target && e.target.id,
          x: e.clientX, y: e.clientY, dx: e.deltaX, dy: e.deltaY, mode: e.deltaMode, trusted: e.isTrusted }); }, true);
        setInterval(() => { const t = document.getElementById('tick'); if (t) t.textContent = String(Number(t.textContent) + 1); }, 60);
        if (new URL(location.href).searchParams.get('auto') === '1') setTimeout(() => window.open('/popup-b'), 300);
      </script>
    </body></html>`);
  });
  await new Promise((resolve) => state.fixture.listen(0, '127.0.0.1', resolve));
  const fixtureUrl = `http://127.0.0.1:${state.fixture.address().port}/`;
  observations.fixtureUrl = fixtureUrl;
  observations.marker = MARKER;
  log('[env] fixture ' + fixtureUrl);
  log('[env] chrome ' + CHROME);

  const { scanPluginChromeProcesses } = await import(join(HERE, 'harness.mjs'));
  const baseline = scanPluginChromeProcesses().map((entry) => entry.pid);
  try {
    state.dsh = await startDsh();
    log(`[env] isolated DSH ${state.dsh.base} (port ${state.dsh.port})`);
    const cookies = await authenticate(state.dsh.launchUrl);
    state.chrome = await launchChrome();
    installNetworkCapture();
    for (const cookie of cookies) {
      const eq = cookie.indexOf('=');
      await state.chrome.cdp.send('Network.setCookie', { name: cookie.slice(0, eq), value: cookie.slice(eq + 1), url: new URL(state.dsh.base).origin + '/' });
    }
    await state.chrome.cdp.send('Page.navigate', { url: state.dsh.launchUrl });
    await waitFor(async () => {
      const info = await evaluate(`({ ready: document.readyState, boot: !!window.__DSH_BOOT__, root: !!(document.querySelector('#root') && document.querySelector('#root').children.length) })`);
      return info && info.ready === 'complete' && info.boot && info.root ? info : undefined;
    }, { timeoutMs: 45000, label: 'GUI ready' });
    await openPanel();
    await waitFor(() => state.scope, { timeoutMs: 15000, label: 'panel scope headers' });
    const served = await evaluate(`(async () => {
      const boot = window.__DSH_BOOT__;
      const entry = boot && Array.isArray(boot.entries) ? boot.entries.find((candidate) => candidate.id === 'dsh-agent-team-ui-testing') : undefined;
      if (!entry || !entry.url) return null;
      const response = await fetch(entry.url, { credentials: 'same-origin', cache: 'no-store' });
      return { text: await response.text() };
    })()`);
    observations.servedClient = { bytes: served ? Buffer.byteLength(served.text, 'utf8') : 0,
      hasTabs: Boolean(served && served.text.includes('data-utb-tabs-toggle') && served.text.includes('viewsRevision')) };
    check('PT00 served client bundle contains the internal tabs code', observations.servedClient.hasTabs, true, observations.servedClient);

    await setAddressBar(fixtureUrl);
    await waitFor(async () => (await hostState()).running === true, { timeoutMs: 20000, label: 'fixture running' });

    const viewW = 800;
    const viewH = 600;
    const tabSmoke = async () => {
      log('\n--- internal tabs smoke ---');
      await setStageScroll(0);
      await sleep(400);
      const tabs = async () => evaluate(`(() => ({ count: document.querySelectorAll('[role="tab"]').length, active: document.querySelector('[role="tab"][aria-selected="true"]')?.getAttribute('data-utb-tab') || null, addr: document.querySelector('.utb-addr')?.value || null, visible: document.querySelector('.utb')?.getAttribute('data-utb-tabs-visible') || null, views: document.querySelector('.utb')?.getAttribute('data-utb-views-count') || null }))()`);
      const plusCounts = () => evaluate(`(() => ({ toolbar: document.querySelectorAll('[data-utb-tab-new="toolbar"]').length, strip: document.querySelectorAll('[data-utb-tab-new="strip"]').length }))()`);
      const toggleStrip = async () => {
        await evaluate(`(() => { const b=document.querySelector('[data-utb-tabs-toggle]'); if (b) b.click(); return true; })()`);
        await sleep(300);
        return tabs();
      };
      // Single tab: the strip is shown by preference, and the new-tab + lives only inside it.
      let single = await waitFor(async () => { const value = await tabs(); return value.visible === 'true' && value.count === 1 ? value : undefined; },
        { timeoutMs: 10000, label: 'single-tab strip' }).catch(() => tabs());
      let plus = await plusCounts();
      check('tabs: single tab shows the strip', Number(single.views) === 1 && single.count === 1 && single.visible === 'true', { views: 1, tabs: 1, visible: 'true' }, single);
      check('tabs: new-tab + exists only in the strip', plus.strip === 1 && plus.toolbar === 0, { strip: 1, toolbar: 0 }, plus);
      single = await toggleStrip();
      plus = await plusCounts();
      check('tabs: toggle hides the strip on a single tab', single.count === 0 && single.visible === 'false' && Number(single.views) === 1, { tabs: 0, visible: 'false', views: 1 }, single);
      check('tabs: hidden strip leaves no toolbar +', plus.strip === 0 && plus.toolbar === 0, { strip: 0, toolbar: 0 }, plus);
      single = await toggleStrip();
      plus = await plusCounts();
      check('tabs: toggle restores the strip on a single tab', single.count === 1 && single.visible === 'true' && plus.strip === 1 && plus.toolbar === 0, { tabs: 1, visible: 'true', strip: 1 }, { ...single, ...plus });
      const rect = await targetEval(`(() => { const r=document.getElementById('popup-link').getBoundingClientRect(); return {x:r.left+r.width/2,y:r.top+r.height/2}; })()`);
      check('tabs: fixture popup link exists', Boolean(rect && Number.isFinite(rect.x)), true, rect);
      await pageHostFetch('/input', { method: 'POST', headers: state.scope, body: { events: [
        { kind: 'mouse', type: 'mousePressed', x: rect.x, y: rect.y, button: 'left', clickCount: 1 },
        { kind: 'mouse', type: 'mouseReleased', x: rect.x, y: rect.y, button: 'left', clickCount: 1 },
      ] } });
      await sleep(250);
      log('[debug host views] ' + JSON.stringify((await hostState()).ui?.views));
      log('[debug addr] ' + await evaluate(`document.querySelector('.utb-addr') ? document.querySelector('.utb-addr').value : 'missing'`));
      log('[debug popup requests] ' + state.requests.filter((r) => r.url.includes('/popup-b')).length);
      const frameState = await pageHostFetch('/frame?since=0', { headers: state.scope });
      log('[debug frame] ' + JSON.stringify({ runtime: frameState.json?.state?.ui?.runtimeId, views: frameState.json?.state?.ui?.views?.length, revision: frameState.json?.state?.ui?.viewsRevision }));
      const recentState = await pageHostFetch('/state', { headers: { 'X-UI-Testing-Scope-Version': '1', 'X-UI-Testing-Scope': 'recent' } });
      log('[debug recent] ' + JSON.stringify({ runtime: recentState.json?.ui?.runtimeId, views: recentState.json?.ui?.views?.length, revision: recentState.json?.ui?.viewsRevision }));
      log('[debug tabs dom] ' + JSON.stringify(await evaluate(`(() => { const u=document.querySelector('.utb'); const b=document.querySelector('[data-utb-tabs-toggle]'); return { utb: !!u, addr: !!document.querySelector('.utb-addr'), addrValue: document.querySelector('.utb-addr')?.value || '', text: (u?.innerText || '').slice(0, 200), tabs: document.querySelectorAll('[role="tab"]').length, supported: u?.getAttribute('data-utb-tabs-supported'), visible: u?.getAttribute('data-utb-tabs-visible'), viewsCount: u?.getAttribute('data-utb-views-count'), viewIds: u?.getAttribute('data-utb-views-ids'), readyViews: u?.getAttribute('data-utb-ready-views'), pref: u?.getAttribute('data-utb-tabs-pref'), runtime: u?.getAttribute('data-utb-runtime-id'), binding: u?.getAttribute('data-utb-scope-binding'), active: u?.getAttribute('data-utb-active-view'), toggle: b?.outerHTML || null }; })()`)).slice(0, 1600));
      log('[debug state requests] ' + JSON.stringify(state.requests.filter((r) => r.url.includes('/state')).slice(-4).map((r) => ({ url: r.url, headers: r.headerVerify, at: r.at }))));
      let t;
      for (let i = 0; i < 40; i += 1) {
        await sleep(250);
        t = await tabs();
        if (t.count > 1 && t.active && t.active !== 'primary' && String(t.addr || '').includes('/popup-b')) break;
      }
      check('tabs: new popup adds an internal tab', t.count > 1, 2, t);
      check('tabs: new popup is active', t.active && t.active !== 'primary', 'child', t);
      check('tabs: active address is the popup page', String(t.addr || '').includes('/popup-b'), '/popup-b', t.addr);
      await evaluate(`(() => { const tab=document.querySelector('[role="tab"][data-utb-tab="primary"]'); if (tab) tab.click(); return true; })()`);
      await waitFor(async () => { const value = await tabs(); return value.active === 'primary' && !String(value.addr || '').includes('/popup-b') ? value : undefined; }, { timeoutMs: 10000, label: 'switch primary' }).catch(() => {});
      t = await tabs();
      check('tabs: can switch back to primary', t.active === 'primary' && !String(t.addr || '').includes('/popup-b'), 'primary', t);
      await evaluate(`(() => { const tab=document.querySelector('[role="tab"][data-utb-tab]:not([data-utb-tab="primary"])'); if (tab) tab.click(); return true; })()`);
      await waitFor(async () => { const value = await tabs(); return String(value.addr || '').includes('/popup-b') ? value : undefined; }, { timeoutMs: 10000, label: 'switch child' }).catch(() => {});
      t = await tabs();
      check('tabs: can switch back to child', String(t.addr || '').includes('/popup-b'), '/popup-b', t);
      await evaluate(`(() => { const b=document.querySelector('[data-utb-tabs-toggle]'); if (b) b.click(); return true; })()`);
      await sleep(300);
      t = await tabs();
      const hiddenViews = await evaluate(`document.querySelector('.utb')?.getAttribute('data-utb-views-count')`);
      check('tabs: toggle hides the strip without losing pages', t.count === 0 && t.visible === 'false' && Number(hiddenViews) > 1, { count: 0, visible: 'false', views: '>1' }, { ...t, views: hiddenViews });
      await evaluate(`(() => { const b=document.querySelector('[data-utb-tabs-toggle]'); if (b) b.click(); return true; })()`);
      await sleep(300);
      t = await tabs();
      check('tabs: toggle restores the same pages', t.count > 1 && t.visible === 'true', { count: '>1', visible: 'true' }, t);
      const close = await evaluate(`(() => { const b=document.querySelector('[data-utb-tab-close]'); if (!b) return null; const id=b.getAttribute('data-utb-tab-close'); b.click(); return id; })()`);
      check('tabs: child has a close button', Boolean(close), true, close);
      await sleep(300);
      log('[debug after close] ' + JSON.stringify({ host: (await hostState()).ui?.views, closeRequests: state.requests.filter((r) => r.url.includes('/close')).length, tabs: await tabs() }));
      await waitFor(async () => { const value = await tabs(); return value.count === 1 && value.visible === 'true' && !String(value.addr || '').includes('/popup-b') ? value : undefined; }, { timeoutMs: 10000, label: 'close child' }).catch(() => {});
      t = await tabs();
      const afterPlus = await plusCounts();
      const afterViews = await evaluate(`document.querySelector('.utb')?.getAttribute('data-utb-views-count')`);
      check('tabs: closing the child returns to one visible tab', t.count === 1 && t.visible === 'true' && Number(afterViews) === 1 && afterPlus.strip === 1 && afterPlus.toolbar === 0 && !String(t.addr || '').includes('/popup-b'), { count: 1, visible: 'true', views: 1, strip: 1 }, { ...t, views: afterViews, ...afterPlus });
    };
    async function popupScenarios() {
      log('\n--- popup scenarios ---');
      const tabState = () => evaluate(`(() => ({ count: document.querySelectorAll('[role="tab"]').length, active: document.querySelector('[role="tab"][aria-selected="true"]')?.getAttribute('data-utb-tab') || null, addr: document.querySelector('.utb-addr')?.value || '', visible: document.querySelector('.utb')?.getAttribute('data-utb-tabs-visible') || null, views: document.querySelector('.utb')?.getAttribute('data-utb-views-count') || null }))()`);
      const clickId = async (id) => {
        const r = await targetEval(`(() => { const n=document.getElementById(${JSON.stringify(id)}); if (!n) return null; n.scrollIntoView({ block: 'center' }); const b=n.getBoundingClientRect(); return { x:b.left+b.width/2, y:b.top+b.height/2 }; })()`);
        if (!r) return null;
        await pageHostFetch('/input', { method: 'POST', headers: state.scope, body: { events: [
          { kind: 'mouse', type: 'mousePressed', x: r.x, y: r.y, button: 'left', clickCount: 1 },
          { kind: 'mouse', type: 'mouseReleased', x: r.x, y: r.y, button: 'left', clickCount: 1 },
        ] } });
        return r;
      };
      const waitTab = async (expected, child = true) => {
        for (let i = 0; i < 40; i += 1) {
          await sleep(250);
          const t = await tabState();
          if (expected === 1 ? t.count === 1 && Number(t.views) === 1 && t.visible === 'true' : t.count > 1
            && (!child || String(t.addr).includes('/popup-b'))) return t;
        }
        return tabState();
      };
      const closeChild = async () => {
        await evaluate(`(() => { const b=document.querySelector('[data-utb-tab-close]'); if (b) b.click(); return !!b; })()`);
        return waitTab(1, false);
      };
      // Explicit target=_blank without rel=noopener.
      await clickId('popup-link2');
      let t = await waitTab(2);
      check('tabs: target=_blank (no rel) opens a second tab', t.count > 1 && String(t.addr).includes('/popup-b'), { count: 2, addr: '/popup-b' }, t);
      await closeChild();
      // Real window.open from a GUI click.
      await clickId('js-open');
      t = await waitTab(2);
      check('tabs: real window.open opens a second tab', t.count > 1 && String(t.addr).includes('/popup-b'), { count: 2 }, t);
      // Child navigation C and back B; primary A unchanged.
      const parentBefore = await hostState();
      const childView = (parentBefore.ui?.views || []).find((view) => view.kind === 'popup');
      const childHeaders = { 'x-ui-testing-scope-version': '1', 'x-ui-testing-scope-binding': childView?.runtimeId || '' };
      await pageHostFetch('/navigate', { method: 'POST', headers: childHeaders, body: { url: fixtureUrl + 'popup-c' } });
      let childState = (await pageHostFetch('/state', { headers: childHeaders })).json;
      const cOk = String(childState.ui?.address || '').includes('/popup-c');
      check('tabs: child navigates B to C independently', cOk, '/popup-c', childState.ui?.address);
      await pageHostFetch('/history', { method: 'POST', headers: childHeaders, body: { direction: 'back' } });
      childState = (await pageHostFetch('/state', { headers: childHeaders })).json;
      check('tabs: child back returns to B', String(childState.ui?.address || '').includes('/popup-b'), '/popup-b', childState.ui?.address);
      const parentAfter = await hostState();
      check('tabs: primary A URL/history is unchanged by child navigation', String(parentAfter.ui?.address || '') === fixtureUrl, fixtureUrl, parentAfter.ui?.address);
      // Child click follows the active binding through the real panel.
      const childRect = await pageHostFetch('/eval', { method: 'POST', headers: childHeaders, body: { expression: "(() => { const r=document.getElementById('pb').getBoundingClientRect(); return {x:r.left+r.width/2,y:r.top+r.height/2}; })()" } });
      const geom = await boxGeom();
      if (geom && childRect.json?.value) {
        const activeChildState = (await pageHostFetch('/state', { headers: childHeaders })).json;
        const activeW = Number(activeChildState.ui?.view?.width) || viewW;
        const activeH = Number(activeChildState.ui?.view?.height) || viewH;
        const point = screenOf(geom, activeW, activeH, childRect.json.value.x, childRect.json.value.y);
        await clickAt(point.x, point.y);
        const clicks = await pageHostFetch('/eval', { method: 'POST', headers: childHeaders, body: { expression: 'window.__pb' } });
        check('tabs: child click follows the active tab', clicks.json?.value === 1, 1, clicks.json);
      } else {
        check('tabs: child click follows the active tab', false, 'geometry+rect', { geom: Boolean(geom), rect: childRect.json });
      }
      // Toggle left of annotation and stack order.
      const layout = await evaluate(`(() => {
        const toggle=document.querySelector('[data-utb-tabs-toggle]');
        const annot=document.querySelector('[data-utb-annot-entry]');
        const tabs=document.querySelector('.utb-tabs');
        const bar=document.querySelector('.utb-bar');
        const stage=document.querySelector('.utb-stage');
        const r=(n)=>{ if(!n) return null; const b=n.getBoundingClientRect(); return {left:b.left, top:b.top, right:b.right, bottom:b.bottom, width:b.width, height:b.height}; };
        return { toggle:r(toggle), annot:r(annot), tabs:r(tabs), bar:r(bar), stage:r(stage),
          before: Boolean(toggle && annot && (toggle.compareDocumentPosition(annot) & Node.DOCUMENT_POSITION_FOLLOWING)) };
      })()`);
      check('tabs: toggle is immediately left of the annotation button', layout.before && layout.toggle && layout.annot && layout.toggle.right <= layout.annot.left + 1, true, layout);
      check('tabs: strip sits below the address bar and above the stage', layout.tabs && layout.bar && layout.stage && layout.tabs.top >= layout.bar.bottom - 1 && layout.stage.top >= layout.tabs.bottom - 1, true, layout);
      await closeChild();
      // Invalid target and no-ticket window.open.
      await clickId('forbidden');
      await sleep(1400);
      t = await tabState();
      check('tabs: forbidden popup adds no tab', t.count === 1 && t.visible === 'true' && Number(t.views) === 1, { count: 1, visible: 'true', views: 1 }, t);
      const notice = await evaluate(`(() => document.querySelector('[data-utb-popup-notice]')?.getAttribute('data-utb-popup-notice') || null)()`);
      check('tabs: forbidden popup shows a local notice', notice === 'target-forbidden', 'target-forbidden', notice);
      await pageHostFetch('/eval', { method: 'POST', headers: state.scope, body: { expression: "window.open('/popup-b')" } });
      await sleep(1200);
      t = await tabState();
      check('tabs: no-ticket window.open adds no tab', t.count === 1 && t.visible === 'true' && Number(t.views) === 1, { count: 1, visible: 'true', views: 1 }, t);
      // Capacity: three children (primary + 3 = 4 views), fourth rejected. Wait for each new
      // view instead of sampling right after the click, so the count does not depend on timing.
      for (let i = 0; i < 3; i += 1) {
        await clickId('popup-link');
        await waitFor(async () => { const value = await tabState(); return Number(value.views) === i + 2 ? value : undefined; },
          { timeoutMs: 10000, label: 'child ' + (i + 1) }).catch(() => {});
      }
      t = await tabState();
      let hostPopups = [];
      for (let i = 0; i < 20; i += 1) {
        hostPopups = ((await hostState()).ui?.views || []).filter((v) => v.kind === 'popup');
        if (hostPopups.length === 3) break;
        await sleep(150);
      }
      check('tabs: capacity admits three children', hostPopups.length === 3 && Number(t.views) === 4 && t.count === 4, { host: 3, views: 4, tabs: 4 }, { host: hostPopups.length, tabs: t });
      await clickId('popup-link');
      await sleep(1400);
      t = await tabState();
      check('tabs: fourth child is not added', (await hostState()).ui?.views?.filter((v) => v.kind === 'popup').length === 3 && Number(t.views) === 4, { host: 3, views: 4 }, t);
      const limitNotice = await evaluate(`(() => document.querySelector('[data-utb-popup-notice]')?.getAttribute('data-utb-popup-notice') || null)()`);
      check('tabs: over-cap shows popup-limit', limitNotice === 'popup-limit', 'popup-limit', limitNotice);
      for (const view of ((await hostState()).ui?.views || []).filter((v) => v.kind === 'popup')) {
        await pageHostFetch('/close', { method: 'POST', headers: { 'x-ui-testing-scope-version': '1', 'x-ui-testing-scope-binding': view.runtimeId }, body: {} });
      }
      await sleep(800);
      t = await tabState();
      check('tabs: closing all children returns to primary only', t.count === 1 && t.visible === 'true' && Number(t.views) === 1, { count: 1, visible: 'true', views: 1 }, t);
      // Automatic timer popup.
      await pageHostFetch('/navigate', { method: 'POST', headers: state.scope, body: { url: fixtureUrl + '?auto=1' } });
      await sleep(2200);
      const autoViews = await hostState();
      check('tabs: automatic timer popup adds no tab', (autoViews.ui?.views || []).length === 1, 1, autoViews.ui?.views);
    }

    async function hostAgentPrimaryCheck() {
      log('\n--- Host harness: Agent stays primary ---');
      const harness = await createHarness({
        connection: createFakeConnectionService({ rejection: undefined, admit: () => ({ peer: { id: 'owner' } }), browserPeer: { id: 'owner' } }),
      });
      try {
        const headers = { 'x-ui-testing-scope-version': '1', 'x-ui-testing-session-id': 'popup-host' };
        await harness.request({ method: 'POST', path: '/plugins/ui-testing/ensure', headers, body: { url: fixtureUrl } });
        await sleep(500);
        const rect = await harness.request({ method: 'POST', path: '/plugins/ui-testing/eval', headers, body: {
          expression: "(() => { const r=document.getElementById('popup-link').getBoundingClientRect(); return {x:r.left+r.width/2,y:r.top+r.height/2}; })()",
        } });
        await harness.request({ method: 'POST', path: '/plugins/ui-testing/input', headers, body: { events: [
          { kind: 'mouse', type: 'mousePressed', x: rect.json.value.x, y: rect.json.value.y, button: 'left', clickCount: 1 },
          { kind: 'mouse', type: 'mouseReleased', x: rect.json.value.x, y: rect.json.value.y, button: 'left', clickCount: 1 },
        ] } });
        let state;
        for (let i = 0; i < 30; i += 1) {
          await sleep(250);
          state = (await harness.request({ method: 'GET', path: '/plugins/ui-testing/state', headers })).json;
          if ((state.ui?.views || []).filter((view) => view.kind === 'popup').length === 1) break;
        }
        check('host: GUI popup creates a child Runtime', (state.ui?.views || []).filter((view) => view.kind === 'popup').length === 1, 1, state.ui?.views);
        const agent = await harness.invoke('browser_state', {}, { agent: { id: 'popup-host', session: { header: { cwd: REPO_ROOT } } } });
        check('host: Agent browser_state still targets primary A', String(agent.value?.url || '') === fixtureUrl, fixtureUrl, agent.value?.url);
      } finally {
        try { await harness.closeBrowser(); } catch { /* ignore */ }
        try { await harness.dispose(); } catch { /* ignore */ }
      }
    }

    try {
      await tabSmoke();
      await popupScenarios();
      await hostAgentPrimaryCheck();
      await captureGuiPng('popup-tabs-panel.png');
    } catch (error) {
      check('popup-tabs suite completed without an uncaught exception', false, 'no exception', String(error && (error.stack || error.message) || error));
    }

    notRun('跨 workspace popup', '本次 fixture 只覆盖单 workspace；跨 workspace 归属未跑');
    notRun('多面板/第二个 popup 同动作', '未构造同动作双 target / 两个面板并发选择');
    notRun('刷新恢复与失效 child', '未做整页刷新/断线/外部 window.close；Host 侧 targetDestroyed 已有代码路径');
    notRun('Agent lease 竞态', '未构造 Agent 持 lease 时的 popup 竞态；browser_state 仍 primary 已由 host check 覆盖');
    notRun('自动 timer popup notice', 'Chrome popup blocker 未产生 target；本套件只验证不新增 tab');
    notRun('预览/标注/尺寸/DevTools 逐项跟随 active', '地址栏、binding /input、/close 已验；其余面板能力未逐项 smoke');
    notRun('标注栏/尺寸栏叠加 bbox 与窄面板', '只验 tab strip 位于地址栏下、stage 上；与标注/尺寸栏组合及窄宽未逐项测量');
    notRun('seed/barrier、BUSY 注入与 Baidu 原站', '沿用既有 NOT_RUN，不在本标签页套件重复');
    observations.exceptions = state.exceptions || [];
    observations.consoleErrors = state.consoleErrors || [];
  } finally {
    log('\n[cleanup]');
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
    if (state.fixture) await new Promise((resolve) => state.fixture.close(resolve));
    for (let round = 0; round < 3; round += 1) {
      let killed = 0;
      for (const entry of scanPluginChromeProcesses()) {
        if (baseline.includes(entry.pid)) continue;
        if (!String(entry.profileDir).includes('dsh-ui-testing-')) continue;
        try { process.kill(entry.pid, 'SIGKILL'); killed += 1; log('[cleanup] killed plugin Chromium ' + entry.pid); } catch { /* ignore */ }
        await rm(entry.profileDir, { recursive: true, force: true }).catch(() => {});
      }
      if (killed === 0) break;
      await sleep(500);
    }
  }

  const failed = checks.filter((entry) => !entry.pass).length;
  const report = {
    suite: 'popup-tabs',
    startedAt: STAMP,
    finishedAt: new Date().toISOString(),
    environment: { chrome: CHROME, dsh: state.dsh ? { base: state.dsh.base, port: state.dsh.port } : null, fixtureUrl, marker: MARKER },
    checks,
    notRuns,
    observations,
    summary: { checks: checks.length, passed: checks.length - failed, failed, notRun: notRuns.length },
  };
  await writeFile(join(RUN_DIR, 'report.json'), JSON.stringify(report, null, 2));
  await writeFile(join(RUN_DIR, 'run.log'), logLines.join('\n') + '\n');
  await writeFile(join(EVIDENCE, 'report.json'), JSON.stringify(report, null, 2));
  await writeFile(join(EVIDENCE, 'run.log'), logLines.join('\n') + '\n');
  log(`\npopup-tabs: ${checks.length - failed}/${checks.length} PASS, ${failed} failed, ${notRuns.length} NOT_RUN`);
  log('evidence: ' + RUN_DIR);
  return failed === 0 ? 0 : 1;
}

const code = await main().catch((error) => { log('FATAL ' + (error && (error.stack || error.message) || error)); return 2; });
process.exit(code);
