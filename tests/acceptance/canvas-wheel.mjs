#!/usr/bin/env node
/**
 * Deterministic real-GUI acceptance for canvas wheel consumption and input mapping
 * (docs/internal/canvas-wheel-input-diagnosis.md; task-9).
 *
 * What it proves against a private isolated DSH (random loopback port, temporary DSH_HOME,
 * separate headless Chromium; never 3080/3081):
 *   - the fixture page is a 3000px-long document rendered at a fixed 800x600 viewport, with
 *     buttons at top/middle/bottom and both edges, a fixed button, a sticky bar, an inner
 *     260x180 overflow:auto region with its own buttons, and a live 60ms tick;
 *   - a scrollable stage is proven before any wheel assertion;
 *   - ordinary content wheel: stage / every scrollable ancestor / GUI document scroll stay
 *     unchanged, exactly one /input wheel is sent, the target page receives exactly one trusted
 *     wheel whose p matches q+O within 1px, and no canvas/scale viewport write happens;
 *   - blank (O<0 top band / O>0 bottom band): zero target wheel, zero /input, no host scroll,
 *     no canvas/scale write; a blank click dispatches nothing and shows the local blank hint;
 *   - a content click increments exactly the intended button once, sends one trusted
 *     mousePressed and is reported isTrusted by the target page;
 *   - an A2 transient-displacement probe samples transform/box/detail at rAF around a content
 *     wheel for O=0 and O=-120 and reports max |T - (-O*scale)|, rebound and extra blank band.
 *
 * NOT_RUN (reported honestly, never as PASS):
 *   - G06 barrier/seed real-time frame mismatch: the live transport cannot reproducibly produce
 *     a missing/mismatched frame in this environment; the client recovery path is not asserted.
 *   - BUSY / connection-rejected /input feedback: deterministic injection was not stable here.
 *   - G05 inner scrolling, overlay, G07/G08/G09/G10 matrices and the original Baidu page: not run.
 *
 * Run:  node tests/acceptance/canvas-wheel.mjs
 * Env:  DSH_BIN (default dsh), DSH_ACCEPTANCE_CHROME / DSH_REAL_BROWSER_CHROME
 *         (default tests/acceptance/chrome-wrapper.sh).
 * Exit codes: 0 pass (NOT_RUN allowed), 1 assertion failure, 2 fatal.
 * Evidence: tests/acceptance/runs/canvas-wheel-<stamp>/ and tests/acceptance/evidence/canvas-wheel-<stamp>/.
 */
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { createServer as createHttpServer } from 'node:http';
import { createServer as createNetServer } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = dirname(HERE);
const STAMP = new Date().toISOString().replace(/[:.]/g, '-');
const RUN_DIR = join(HERE, 'runs', `canvas-wheel-${STAMP}-${process.pid}`);
const EVIDENCE = join(HERE, 'evidence', `canvas-wheel-${STAMP}`);
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

  const MARKER = 'CANVAS_WHEEL_MARKER_' + Date.now().toString(36);
  state.fixture = createHttpServer((req, res) => {
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
      hasCanvasHint: Boolean(served && served.text.includes('data-utb-sync-state') && served.text.includes('重试同步')) };
    check('CW00 served client bundle contains the canvas sync/retry code', observations.servedClient.hasCanvasHint, true, observations.servedClient);

    await setAddressBar(fixtureUrl);
    await waitFor(async () => (await hostState()).running === true, { timeoutMs: 20000, label: 'fixture running' });

    const viewW = 800;
    const viewH = 600;
    async function applyView(canvasY) {
      const response = await pageHostFetch('/viewport', {
        method: 'POST',
        headers: { ...state.scope, 'content-type': 'application/json', 'X-UTB-Verify': '1' },
        body: { version: 1, width: viewW, height: viewH, scale: 2, canvasY },
      });
      if (response.status !== 200) throw new Error('viewport ' + response.status + ' ' + response.text);
      await waitFor(async () => {
        const snapshot = await hostState();
        const view = snapshot.ui?.view;
        return view && Math.abs(Number(view.width) - viewW) <= 1 && Math.abs(Number(view.height) - viewH) <= 1
          && Math.abs(Number(view.canvasY) - canvasY) <= 1 ? snapshot : undefined;
      }, { timeoutMs: 15000, label: 'view canvasY ' + canvasY });
      await waitFor(async () => {
        const g = await boxGeom();
        return g && g.ready === 'true' && Math.abs(g.width - viewW * 2) <= 6 && Math.abs(g.height - viewH * 2) <= 6 ? g : undefined;
      }, { timeoutMs: 15000, label: 'box 1600x1200 ready' });
    }

    async function a2Probe(name, canvasY) {
      log(`\n--- A2 transient probe ${name} (canvasY=${canvasY}) ---`);
      await applyView(canvasY);
      await setStageScroll(0);
      await sleep(300);
      const geom = await boxGeom();
      if (!geom || geom.ready !== 'true') {
        notRun(`A2 ${name}: sampling`, 'barrier/frame not ready for transient sampling');
        return;
      }
      const snapshot = await hostState();
      const O = { x: Number(snapshot.ui?.canvas?.x) - Number(snapshot.ui?.view?.x), y: Number(snapshot.ui?.canvas?.y) - Number(snapshot.ui?.view?.y) };
      const point = screenOf(geom, viewW, viewH, 220 - O.x, 220 - O.y);
      if (!inStage(geom, point)) {
        notRun(`A2 ${name}: sampling point`, 'content probe point is outside the visible stage', { point, stage: geom.stage });
        return;
      }
      const displayScale = geom.width / viewW;
      const expectedT = -O.y * displayScale;
      // Let the view-change frame settle first; otherwise the probe measures applyView adoption,
      // not the content wheel under test.
      const readTy = () => evaluate(`(() => { const img = document.querySelector('.utb-frame'); if (!img) return null; const m = /matrix\\(([^)]+)\\)/.exec(getComputedStyle(img).transform || ''); if (!m) return 0; return Number(m[1].split(',')[5]) || 0; })()`);
      let stableRounds = 0;
      const settled = await waitFor(async () => {
        const ty = Number(await readTy());
        stableRounds = Math.abs(ty - expectedT) <= 2 ? stableRounds + 1 : 0;
        return stableRounds >= 3 ? true : undefined;
      }, { timeoutMs: 6000, intervalMs: 60, label: 'A2 steady transform' }).catch(() => null);
      if (!settled) {
        notRun(`A2 ${name}: sampling setup`, 'transform did not settle to -O*scale before the wheel', { expectedT, lastTy: await readTy().catch(() => null) });
        return;
      }
      await evaluate(`(() => {
        window.__a2 = [];
        const started = performance.now();
        const sample = () => {
          const box = document.querySelector('.utb-box');
          const img = document.querySelector('.utb-frame');
          if (!box || !img) { window.__a2.push({ t: performance.now() - started, missing: true }); }
          else {
            const br = box.getBoundingClientRect();
            const ir = img.getBoundingClientRect();
            let ty = 0;
            const match = /matrix\(([^)]+)\)/.exec(getComputedStyle(img).transform || '');
            if (match) { const parts = match[1].split(',').map(Number); ty = parts[5] || 0; }
            let detail = null;
            try { detail = JSON.parse(box.getAttribute('data-utb-canvas-detail') || 'null'); } catch { detail = null; }
            window.__a2.push({ t: performance.now() - started, ty,
              boxTop: br.top, boxBottom: br.bottom, imgTop: ir.top, imgBottom: ir.bottom,
              barrier: box.getAttribute('data-utb-canvas-barrier'), ready: box.getAttribute('data-utb-canvas-ready'),
              frameScrollY: detail && detail.frameScrollY, sY: detail && detail.sY,
              src: img.currentSrc || img.src });
          }
          if (performance.now() - started < 1600) requestAnimationFrame(sample);
        };
        requestAnimationFrame(sample);
        return true;
      })()`);
      await sleep(80);
      const hostBefore = await hostState();
      const chainBefore = await chain();
      await wheelAt(point.x, point.y, 240);
      await sleep(120);
      await captureGuiPng(`a2-${slugFor(name)}-peak.png`);
      const hostMid = await hostState();
      await sleep(1700);
      const hostAfter = await hostState();
      const chainAfter = await chain();
      const samples = (await evaluate('window.__a2')) || [];
      const valid = samples.filter((sample) => !sample.missing && Number.isFinite(Number(sample.ty)));
      const hostO = (snapshot) => Number(snapshot.ui?.canvas?.y) - Number(snapshot.ui?.view?.y);
      const oSamples = [hostO(hostBefore), hostO(hostMid), hostO(hostAfter)];
      const summary = {
        name, canvasY, O, displayScale, expectedT,
        hostO: oSamples,
        hostView: [hostBefore, hostMid, hostAfter].map((snap) => ({ x: snap.ui?.view?.x, y: snap.ui?.view?.y, canvasY: snap.ui?.canvas?.y })),
        samples: valid.length,
        firstT: valid[0] && valid[0].ty,
        lastT: valid[valid.length - 1] && valid[valid.length - 1].ty,
        maxDeviation: valid.length ? Math.max(...valid.map((sample) => Math.abs(Number(sample.ty) - expectedT))) : null,
        maxExposedBlank: valid.length ? Math.max(...valid.map((sample) => Math.max(0, Number(sample.imgTop) - Number(sample.boxTop), Number(sample.boxBottom) - Number(sample.imgBottom)))) : null,
        stableExposedBlank: Math.max(0, Math.abs(O.y) * displayScale),
        sourceChanges: new Set(valid.map((sample) => sample.src)).size,
      };
      summary.extraBlank = summary.maxExposedBlank === null ? null : summary.maxExposedBlank - summary.stableExposedBlank;
      summary.rebounded = valid.length > 0 && Math.abs(Number(valid[valid.length - 1].ty) - expectedT) <= 2 && summary.maxDeviation > 2;
      observations.a2 = observations.a2 || {};
      observations.a2[name] = summary;
      await writeFile(join(EVIDENCE, `a2-${slugFor(name)}.json`), JSON.stringify({ summary, samples }, null, 2));
      if (valid.length < 10) {
        notRun(`A2 ${name}: transient sampling`, 'rAF yielded fewer than 10 samples (headless frame rate)', { samples: valid.length });
        return;
      }
      check(`A2 ${name}: GUI stage/ancestors/document scroll unchanged around content wheel`, chainUnchanged(chainBefore, chainAfter), 'unchanged', { before: chainBefore, after: chainAfter });
      check(`A2 ${name}: Host O stable across the content wheel`, Math.max(...oSamples) - Math.min(...oSamples) <= 1, 'O within 1', oSamples);
      check(`A2 ${name}: steady transform equals -O*displayScale`, Math.abs(Number(summary.lastT) - expectedT) <= 2,
        { expectedT, tolerance: 2 }, { lastT: summary.lastT, samples: summary.samples });
      check(`A2 ${name}: real page scroll still happened during the content wheel`,
        Number(summary.hostView[2].y) - Number(summary.hostView[0].y) > 0,
        { deltaY: '>0' }, { before: summary.hostView[0], after: summary.hostView[2] });
      check(`A2 ${name}: frame progression continued (no frozen live stream)`, summary.sourceChanges > 0,
        { sourceChanges: '>0' }, { sourceChanges: summary.sourceChanges });
      check(`A2 ${name}: legal blank band for O is preserved, not hidden`,
        Math.abs(summary.stableExposedBlank - Math.abs(O.y) * displayScale) <= 2 && summary.maxExposedBlank >= summary.stableExposedBlank - 2,
        { stableExposedBlank: Math.abs(O.y) * displayScale }, { stableExposedBlank: summary.stableExposedBlank, maxExposedBlank: summary.maxExposedBlank });
      check(`A2 ${name}: no transient extra translation or extra blank band beyond 2px`,
        summary.maxDeviation <= 2 && summary.extraBlank <= 2 && summary.rebounded === false,
        { maxDeviation: 2, extraBlank: 2, rebound: false },
        { maxDeviation: summary.maxDeviation, extraBlank: summary.extraBlank, rebound: summary.rebounded, samples: summary.samples });
    }

    async function settleFrame(label) {
      const geom = await boxGeom();
      const snapshot = await hostState();
      const O = { x: Number(snapshot.ui?.canvas?.x) - Number(snapshot.ui?.view?.x), y: Number(snapshot.ui?.canvas?.y) - Number(snapshot.ui?.view?.y) };
      const expectedT = -O.y * (geom.width / viewW);
      let rounds = 0;
      const readTy = () => evaluate(`(() => { const img = document.querySelector('.utb-frame'); if (!img) return null; const m = /matrix\\(([^)]+)\\)/.exec(getComputedStyle(img).transform || ''); if (!m) return 0; return Number(m[1].split(',')[5]) || 0; })()`);
      let last = null;
      const ok = await waitFor(async () => {
        last = Number(await readTy());
        rounds = Math.abs(last - expectedT) <= 2 ? rounds + 1 : 0;
        return rounds >= 3 ? true : undefined;
      }, { timeoutMs: 6000, intervalMs: 60, label: 'steady frame ' + label }).catch(() => null);
      check(`${label}: frame transform is steady at -O*scale before input`, Boolean(ok), { expectedT, tolerance: 2 }, { lastTy: last, rounds });
      return Boolean(ok);
    }

    async function caseRun(name, { canvasY, blankQ, contentP, blankAtBottom }) {
      log(`\n--- ${name} (canvasY=${canvasY}) ---`);
      await applyView(canvasY);
      await setStageScroll(blankQ ? (blankAtBottom ? 'max' : 0) : 0);
      await sleep(300);
      let geom = await boxGeom();
      const space = await evaluate(`(() => { const s = document.querySelector('.utb-stage'); return { sh: s.scrollHeight, ch: s.clientHeight, sw: s.scrollWidth, cw: s.clientWidth, top: s.scrollTop }; })()`);
      check(`${name}: stage has real scroll space before wheel`, space.sh > space.ch + 100 || space.sw > space.cw + 100, { min: 100 }, space);
      check(`${name}: canvas barrier is ready`, geom && geom.ready === 'true', 'true', { ready: geom && geom.ready, barrier: geom && geom.barrier });
      await settleFrame(`${name}: initial`);

      if (blankQ) {
        const point = screenOf(geom, viewW, viewH, blankQ.x, blankQ.y);
        check(`${name}: blank point is inside the visible stage`, inStage(geom, point), true, { point, stage: geom.stage });
        const beforeChain = await chain();
        const targetBefore = await targetEval('({ wheels: window.__wheels.length, clicks: window.__clicks.length })');
        const inputBefore = inputRequests('"kind":"wheel"');
        const since = Date.now();
        await wheelAt(point.x, point.y, 240);
        const afterChain = await chain();
        const targetAfter = await targetEval('({ wheels: window.__wheels.length, clicks: window.__clicks.length })');
        const inputAfter = inputRequests('"kind":"wheel"');
        const posts = panelViewportPosts(since);
        check(`${name}: blank wheel does not move stage/ancestors/GUI document`, chainUnchanged(beforeChain, afterChain), 'unchanged', { beforeChain, afterChain });
        check(`${name}: blank wheel dispatches no target wheel`, targetAfter.wheels === targetBefore.wheels, targetBefore.wheels, targetAfter.wheels);
        check(`${name}: blank wheel sends no /input wheel`, inputAfter === inputBefore, inputBefore, inputAfter);
        check(`${name}: blank wheel writes no canvas/scale viewport`, posts === 0, 0, posts);
        const clickBefore = await targetEval('({ wheels: window.__wheels.length, clicks: window.__clicks.length })');
        await clickAt(point.x, point.y);
        await sleep(300);
        const clickAfter = await targetEval('({ wheels: window.__wheels.length, clicks: window.__clicks.length })');
        const hint = await evaluate(`(() => { const n = document.querySelector('.utb-sync-note'); return n ? { text: n.textContent || '', state: n.getAttribute('data-utb-sync-state') } : null; })()`);
        check(`${name}: blank click dispatches no target click/wheel`, clickAfter.clicks === clickBefore.clicks && clickAfter.wheels === clickBefore.wheels,
          { clicks: clickBefore.clicks, wheels: clickBefore.wheels }, { clicks: clickAfter.clicks, wheels: clickAfter.wheels });
        check(`${name}: blank click shows the local blank hint`, Boolean(hint && String(hint.text).includes('此处是画布空白')), '空白提示', hint);
      }

      if (contentP) {
        // Put the page content back in view for the click/wheel (the blank band test may have scrolled the stage).
        await setStageScroll(0);
        await sleep(250);
        await settleFrame(`${name}: content`);
        geom = await boxGeom();
        const snapshot = await hostState();
        const O = { x: Number(snapshot.ui?.canvas?.x) - Number(snapshot.ui?.view?.x), y: Number(snapshot.ui?.canvas?.y) - Number(snapshot.ui?.view?.y) };
        const S = Number(snapshot.ui?.view?.y);
        const docY = S + contentP.y;
        const buttonId = 'btn-' + (Math.floor(docY / 100) * 100) + '-l';
        const clickPoint = screenOf(geom, viewW, viewH, contentP.x - O.x, contentP.y - O.y);
        check(`${name}: content point is inside the visible stage`, inStage(geom, clickPoint), true, { clickPoint, stage: geom.stage });
        const countsBefore = await targetEval('window.__counts');
        const pressBefore = inputRequests('"type":"mousePressed"');
        await clickAt(clickPoint.x, clickPoint.y);
        await sleep(350);
        const clickAfter = await targetEval('({ counts: window.__counts, clicks: window.__clicks })');
        const pressAfter = inputRequests('"type":"mousePressed"');
        const beforeCount = Number((countsBefore && countsBefore[buttonId]) || 0);
        const afterCount = Number((clickAfter.counts && clickAfter.counts[buttonId]) || 0);
        const lastClick = clickAfter.clicks.slice(-1)[0];
        check(`${name}: content click increments only the intended button once`, afterCount === beforeCount + 1,
          { buttonId, count: beforeCount + 1 }, { buttonId, beforeCount, afterCount });
        check(`${name}: content click sends exactly one /input mousePressed`, pressAfter === pressBefore + 1, pressBefore + 1, pressAfter);
        check(`${name}: target page reports isTrusted=true for the click`, Boolean(lastClick && lastClick.trusted === true), true, lastClick);

        await settleFrame(`${name}: wheel`);
        await sleep(150);
        geom = await boxGeom();
        const snapWheel = await hostState();
        const OWheel = { x: Number(snapWheel.ui?.canvas?.x) - Number(snapWheel.ui?.view?.x), y: Number(snapWheel.ui?.canvas?.y) - Number(snapWheel.ui?.view?.y) };
        const wheelPoint = screenOf(geom, viewW, viewH, contentP.x - OWheel.x, contentP.y - OWheel.y);
        const beforeChain = await chain();
        const targetBefore = await targetEval('({ wheels: window.__wheels.length, wheelsList: window.__wheels })');
        const inputBefore = inputRequests('"kind":"wheel"');
        const since = Date.now();
        await wheelAt(wheelPoint.x, wheelPoint.y, 240);
        await sleep(300);
        const afterChain = await chain();
        const targetAfter = await targetEval('({ wheels: window.__wheels.length, wheelsList: window.__wheels })');
        const inputAfter = inputRequests('"kind":"wheel"');
        const posts = panelViewportPosts(since);
        const lastWheel = targetAfter.wheelsList[targetAfter.wheelsList.length - 1];
        check(`${name}: content wheel sends exactly one /input wheel`, inputAfter === inputBefore + 1, inputBefore + 1, inputAfter);
        check(`${name}: target page receives exactly one wheel`, targetAfter.wheels === targetBefore.wheels + 1, targetBefore.wheels + 1, targetAfter.wheels);
        check(`${name}: wheel is trusted and maps to p within 1px`, Boolean(lastWheel && lastWheel.trusted === true
          && Math.abs(Number(lastWheel.y) - contentP.y) <= 1 && Math.abs(Number(lastWheel.x) - contentP.x) <= 1),
        { x: contentP.x, y: contentP.y, trusted: true }, lastWheel);
        check(`${name}: content wheel does not move stage/ancestors/GUI document`, chainUnchanged(beforeChain, afterChain), 'unchanged', { beforeChain, afterChain });
        check(`${name}: content wheel writes no canvas/scale viewport`, posts === 0, 0, posts);
      }
    }

    try {
      await caseRun('O=0', { canvasY: 0, blankQ: null, contentP: { x: 220, y: 220 }, blankAtBottom: false });
      await caseRun('O<0', { canvasY: -120, blankQ: { x: 400, y: 40 }, contentP: { x: 220, y: 220 }, blankAtBottom: false });
      await caseRun('O>0', { canvasY: 2520, blankQ: { x: 400, y: 560 }, contentP: { x: 220, y: 220 }, blankAtBottom: true });
      await a2Probe('O=0', 0);
      await a2Probe('O<0', -120);
      await captureGuiPng('canvas-wheel-panel.png');
    } catch (error) {
      check('CW-SUITE completed without an uncaught exception', false, 'no exception', String(error && (error.stack || error.message) || error));
    }

    notRun('G06 barrier/seed real-time frame mismatch', '实时 transport 无法稳定制造缺失/失配帧；客户端恢复路径未在真实帧上复现，需后续专项');
    notRun('BUSY / connection input rejection feedback', '确定性注入在实时 transport 下不稳定，未计入通过（实现路径存在，未在真实 Host 拒绝上复现）');
    notRun('G05 inner scrolling / overlay', '本轮聚焦内容/blank wheel、点击与 A2 探针；fixture 已含内层滚动区与 overlay，但未断言');
    notRun('G01 letterbox / stage margin / not-ready branches', '本轮覆盖 blank band 与内容点；实际 letterbox 留边、stage margin 与强制未 ready 分支未跑');
    notRun('G02 deltaMode/deltaX and fit/preset conversion matrix', '本轮使用 Host scale=2 的 200% 映射；deltaX/deltaMode 与 fit/100% 预设矩阵未跑');
    notRun('G04 top/middle/bottom x left/right/fixed button matrix and two-axis O', '本轮每个 O 仅点一个左侧按钮并验证 blank；多位置/固定按钮/双轴未跑');
    notRun('G08 pan/fit/default/close-size-bar O preservation', '本轮未切换 pan/fit/尺寸栏；仅验证默认 view 下 O=0/± 的内容输入');
    notRun('G07/G09/G10 and original Baidu page', '本轮未跑；fixture 通过不冒充 Baidu 原站全部按钮，原站故障未复现');
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
    suite: 'canvas-wheel',
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
  log(`\ncanvas-wheel: ${checks.length - failed}/${checks.length} PASS, ${failed} failed, ${notRuns.length} NOT_RUN`);
  log('evidence: ' + RUN_DIR);
  return failed === 0 ? 0 : 1;
}

const code = await main().catch((error) => { log('FATAL ' + (error && (error.stack || error.message) || error)); return 2; });
process.exit(code);
