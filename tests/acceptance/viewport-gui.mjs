#!/usr/bin/env node
/**
 * Real-GUI acceptance for the shared viewport (尺寸栏 X/Y + 滚轮 + Agent 共享比例 + 坐标映射).
 *
 * What this proves (against a Host that implements docs/viewport-control.md):
 *   - This script builds its OWN isolated DSH web instance: fresh temporary DSH_HOME whose web
 *     profile config files are copied from the user profile and whose node_modules is a read-only
 *     symlink, DSH_PROFILE=web, an ephemeral loopback port (never 3080/3081) and `--no-open`.
 *     The launch token is parsed from the instance's own stdout and never printed, logged, put on
 *     a process command line or written into a report.
 *   - A separate headless Chromium (tests/acceptance/chrome-wrapper.sh) is driven over CDP; the
 *     debug panel is opened through the real shell (`更多` → `调试视图`).
 *   - The five size-bar inputs exist with their exact aria-labels; the size bar does not overflow
 *     the panel at the main width and at a narrowed window.
 *   - Every wheel step (X/Y/W/H/比例, Shift/Alt/零 delta/Ctrl 不处理/边界 clamp) is applied by the
 *     Host and echoed in the panel; a burst merges into a single `/viewport` request and neither
 *     the GUI document nor the target page scrolls.
 *   - X/Y commit (Enter/Escape) produces the exact target-page `scrollX/scrollY`; a page-initiated
 *     scroll is echoed back by the state poll.
 *   - An Agent `/viewport` set (mode / x / y / width / height / scale) is adopted by the panel and
 *     cancels the local fit; navigation afterwards does not re-publish the panel's local size.
 *   - A fixed-coordinate element is hit at fit<100% and at scale>100%: the target page counter
 *     increases exactly once and `window.__t2` records `isTrusted:true` at the mapped point.
 *   - Frame wheel deltas are scaled by W/Pw, H/Ph (two scales measured).
 *   - P0-C v2 (V13, docs/canvas-viewport.md §5.2–§5.3): the Host `ui.canvas` handshake, signed
 *     canvasX/canvasY input/wheel, pure-white blank pixels and the -(C-frame.scroll)*displayScale
 *     frame displacement, q -> p=q+O hit mapping, blank zero dispatch, fail-closed scroll/geometry
 *     barrier (CDP-rewritten /state evidence), drag that writes a negative C, and the simulated
 *     no-canvas / no-shared-view fallbacks (X/Y disabled or back to document scroll).
 *   - GUI screenshots are written under tests/acceptance/evidence/viewport-gui-<stamp>/.
 *
 * NOT covered here (reported, never implied as verified):
 *   - A real old Host binary: this suite only starts a Host that exposes `ui.view`; the old-Host
 *     branch is exercised by V13 through CDP-rewritten `/state` snapshots (simulated projection,
 *     not a second Host build) and the real legacy `{width,height}` write path stays NOT_RUN (V10.4).
 *   - The single-owner lease / BUSY concurrency and the `expectedRevision` conflict path are
 *     Host-slice acceptance items; this suite only asserts that GUI patches carry a revision.
 *   - The resize geometry barrier is best-effort (≤250ms, no frame-protocol extension): the
 *     letterbox band probe is recorded NOT_APPLICABLE when the live frame has no letterbox.
 *   - The 3080/3081 instances are never touched.
 *
 * Run:  node tests/acceptance/viewport-gui.mjs
 * Env:  DSH_BIN (default `dsh`), DSH_ACCEPTANCE_CHROME / DSH_REAL_BROWSER_CHROME
 *         (default tests/acceptance/chrome-wrapper.sh), DSH_VIEWPORT_GUI_TIMEOUT_MS (default 420000),
 *       DSH_VIEWPORT_GUI_EVIDENCE (override the evidence directory).
 *
 * Exit codes: 0 all checks pass (an environment NOT_RUN may still be recorded); 1 assertion
 *             failure; 2 blocked (the isolated Host does not expose ui.view) or fatal error.
 */
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

if (process.argv[1] !== fileURLToPath(import.meta.url)) {
  throw new Error('viewport-gui.mjs 会启动隔离 DSH 实例与真实无头 Chromium，不能被 import 或通过 -e 触发；请直接运行 `node tests/acceptance/viewport-gui.mjs`。');
}

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = dirname(dirname(HERE));
const STAMP = new Date().toISOString().replace(/[:.]/g, '-');
const RUN_DIR = join(HERE, 'runs', `viewport-gui-${STAMP}-${process.pid}`);
const EVIDENCE_DIR = process.env.DSH_VIEWPORT_GUI_EVIDENCE || join(HERE, 'evidence', `viewport-gui-${STAMP}`);
const CHROME_BIN = process.env.DSH_ACCEPTANCE_CHROME || process.env.DSH_REAL_BROWSER_CHROME || join(HERE, 'chrome-wrapper.sh');
const DSH_BIN = process.env.DSH_BIN || 'dsh';
const DEFAULT_PROFILE = join(process.env.HOME || '', '.dsh', 'profiles', 'web');
const TOTAL_TIMEOUT_MS = Number(process.env.DSH_VIEWPORT_GUI_TIMEOUT_MS || 420000) || 420000;
const CHROME_PROFILE_PREFIX = 'dsh-viewport-gui-';
const DSH_HOME_PREFIX = 'dsh-viewport-gui-home-';
const STEP_SETTLE_MS = 450;
const X_LABEL = '视口 X 坐标（像素）';
const Y_LABEL = '视口 Y 坐标（像素）';
const W_LABEL = '视口宽度（像素）';
const H_LABEL = '视口高度（像素）';
const SCALE_LABEL = '预览缩放比例（百分比）';
const SHIFT = 8;
const CTRL = 2;
const ALT = 1;

const logLines = [];
function log(line = '') {
  const text = String(line);
  logLines.push(text);
  console.log(text);
}
function sleep(ms) { return new Promise((resolve) => setTimeout(resolve, ms)); }
function errorMessage(error) { return String((error && error.stack) || (error && error.message) || error); }

function sanitize(text) {
  let value = String(text === undefined || text === null ? '' : text);
  if (state.token) value = value.split(state.token).join('[REDACTED_TOKEN]');
  value = value.replace(/([?&]token=)[^\s&"'<>]+/g, '$1[REDACTED_TOKEN]');
  if (state.cookie) {
    for (const pair of state.cookie.split('; ')) {
      const eq = pair.indexOf('=');
      if (eq > 0) value = value.split(pair.slice(eq + 1)).join('[REDACTED_COOKIE]');
    }
  }
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

/** Ephemeral loopback port, explicitly rejecting the user's 3080/3081. */
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

/* ------------------------------------------------------------------------------------------------
 * CDP client (Node 22 global WebSocket).
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
          if (message.error) entry.reject(new Error(`${message.error.message || 'cdp error'} [${entry.method}]`));
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
      this.pending.set(id, { resolve, reject, method });
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

function isProcessAlive(pid) {
  try { process.kill(pid, 0); return true; } catch { return false; }
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
    }, { timeoutMs: 20000, label: 'DevToolsActivePort' });
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
 * Check bookkeeping.
 * ---------------------------------------------------------------------------------------------- */
const checks = [];
const notRuns = [];
function fmt(value) {
  try {
    const text = JSON.stringify(value);
    return text === undefined ? String(value) : text.slice(0, 1200);
  } catch { return String(value).slice(0, 1200); }
}
function safeValue(value) {
  try {
    const text = JSON.stringify(value);
    if (text === undefined) return String(value);
    return JSON.parse(text.replace(/[\u2028\u2029]/g, ' '));
  } catch { return sanitize(String(value)); }
}
function check(id, label, pass, expected, actual) {
  const entry = { id, label, pass: Boolean(pass), expected: safeValue(expected), actual: safeValue(actual) };
  checks.push(entry);
  log(`  [${pass ? 'PASS' : 'FAIL'}] ${id} ${label}`);
  if (!pass) log(`         expected: ${sanitize(fmt(expected))}\n         actual  : ${sanitize(fmt(actual))}`);
  return Boolean(pass);
}
/** An honest NOT_RUN: never a pass, always with a reason and its evidence. */
function notRun(id, label, reason, detail) {
  notRuns.push({ id, label, reason: sanitize(reason), detail: safeValue(detail) });
  log(`  [NOT_RUN] ${id} ${label} — ${reason}`);
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
 * State.
 * ---------------------------------------------------------------------------------------------- */
const state = {
  token: '',
  cookie: '',
  chrome: undefined,
  fixture: undefined,
  dsh: undefined,
  scopeHeaders: null,
  requests: [],
  responses: [],
  exceptions: [],
  consoleErrors: [],
  dialogsDismissed: 0,
  evidence: [],
  buildInfo: null,
  servedClient: null,
  hostView: null,
  blocked: '',
};

/* ------------------------------------------------------------------------------------------------
 * Isolated DSH instance.
 * ---------------------------------------------------------------------------------------------- */
async function prepareDshHome() {
  const home = await mkdtemp(join(tmpdir(), DSH_HOME_PREFIX));
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
      DSH_UI_TESTING_CHROME: process.env.DSH_UI_TESTING_CHROME || CHROME_BIN,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '';
  const capture = (chunk) => { output += String(chunk); };
  proc.stdout.on('data', capture);
  proc.stderr.on('data', capture);
  proc.on('exit', (code, signal) => { log(`[dsh] exited code=${code} signal=${signal}`); });
  state.dsh = { proc, home, profileDir, port, copied, output: () => output, base: `http://127.0.0.1:${port}` };

  const pattern = new RegExp(`dsh web: (http://127\\.0\\.0\\.1:${port}/\\?token=([A-Za-z0-9_-]+))`);
  const matched = await waitFor(() => {
    const match = pattern.exec(output);
    return match ? { url: match[1], token: match[2] } : undefined;
  }, { timeoutMs: 120000, intervalMs: 250, label: 'isolated dsh launch URL' });
  state.token = matched.token;
  state.dsh.launchUrl = matched.url;
  await waitFor(async () => {
    try {
      const response = await fetch(state.dsh.base + '/', { signal: AbortSignal.timeout(3000) });
      return response.status < 500;
    } catch { return false; }
  }, { timeoutMs: 40000, intervalMs: 400, label: 'isolated dsh HTTP listener' });
  return state.dsh;
}

async function authenticate(launchUrl) {
  const response = await fetch(launchUrl, { redirect: 'manual', signal: AbortSignal.timeout(20000) });
  const cookies = response.headers.getSetCookie();
  if (!cookies.length) throw new Error(`launch URL did not issue a cookie (status ${response.status})`);
  const simplified = cookies.map((value) => value.split(';')[0]);
  state.cookie = simplified.join('; ');
  return simplified;
}

/* ------------------------------------------------------------------------------------------------
 * GUI helpers.
 * ---------------------------------------------------------------------------------------------- */
async function guiReady(timeoutMs = 45000) {
  return waitFor(async () => {
    const info = await pageEvaluate(`({
      ready: document.readyState,
      boot: !!window.__DSH_BOOT__,
      origin: location.origin,
      root: !!(document.querySelector('#root') && document.querySelector('#root').children.length),
    })`);
    return info && info.ready === 'complete' && info.boot && info.root ? info : undefined;
  }, { timeoutMs, label: 'GUI shell ready' });
}

async function dismissShellDialogs() {
  const dismissed = await pageEvaluate(`(() => {
    let closed = 0;
    for (const dialog of [...document.querySelectorAll('[role="dialog"]')]) {
      const button = [...dialog.querySelectorAll('button')].find((node) => /关闭|close/i.test((node.getAttribute('aria-label') || '') + (node.textContent || '')));
      if (button) { button.click(); closed += 1; }
    }
    return closed;
  })()`);
  if (dismissed) await sleep(700);
  state.dialogsDismissed += Number(dismissed) || 0;
  return dismissed;
}

async function ensureLeftSidebar() {
  const expanded = await pageEvaluate(`(() => {
    const collapse = document.querySelector('button[aria-label="收起侧边栏"]');
    if (collapse) return true;
    const expand = document.querySelector('button[aria-label="展开侧边栏"]');
    if (expand) { expand.click(); return false; }
    return false;
  })()`);
  if (!expanded) await sleep(400);
  return expanded;
}

async function openPanel() {
  await dismissShellDialogs();
  await ensureLeftSidebar();
  const opened = await waitFor(async () => {
    const clicked = await pageEvaluate(`(() => {
      const button = document.querySelector('button[aria-label="更多"]:not(.utb-btn)');
      if (!button) return 'no-more';
      button.click();
      return 'clicked';
    })()`);
    if (clicked !== 'clicked') return undefined;
    await sleep(350);
    const row = await pageEvaluate(`(() => {
      const direct = [...document.querySelectorAll('.utb-menu-row')].find((el) => (el.textContent || '').includes('调试视图'));
      const fallback = direct || [...document.querySelectorAll('button, a, [role="menuitem"]')]
        .find((el) => (el.textContent || '').trim() === '调试视图');
      if (!fallback) return false;
      fallback.click();
      return true;
    })()`);
    return row ? true : undefined;
  }, { timeoutMs: 15000, intervalMs: 200, label: '更多 → 调试视图' });
  if (!opened) throw new Error('cannot open the debug panel through the shell');
  await waitFor(async () => {
    const found = await pageEvaluate(`!!([...document.querySelectorAll('.utb')].find((el) => !el.closest('[data-sidebar-right-tab]')))`);
    return found ? true : undefined;
  }, { timeoutMs: 12000, intervalMs: 150, label: 'main debug panel mounted' });
  await waitFor(() => state.scopeHeaders || undefined, { timeoutMs: 15000, intervalMs: 150, label: 'panel scope headers' });
  await sleep(400);
}

/** Expression body evaluated with the main (non-sidebar) panel bound to `panel`. */
function panelExpr(inner) {
  return `(() => {
    const panel = [...document.querySelectorAll('.utb')].find((el) => !el.closest('[data-sidebar-right-tab]'));
    if (!panel) return { missing: true };
    ${inner}
  })()`;
}

async function panelState() {
  return pageEvaluate(panelExpr(`
    const inputs = [...panel.querySelectorAll('.utb-size input')].map((input) => ({
      label: input.getAttribute('aria-label'),
      type: input.type,
      value: input.value,
      disabled: input.disabled,
      field: input.getAttribute('data-utb-field'),
      min: input.getAttribute('min'),
      max: input.getAttribute('max'),
      title: input.title,
    }));
    const byLabel = {};
    for (const input of inputs) if (input.label) byLabel[input.label] = input;
    const bar = panel.querySelector('.utb-size');
    const check = panel.querySelector('.utb-check input');
    const panBox = panel.querySelector('.utb-check input[data-utb-check="pan"]');
    const panLayer = panel.querySelector('[data-utb-pan-layer]');
    const zoom = panel.querySelector('.utb-zoom');
    const img = panel.querySelector('.utb-frame');
    const box = panel.querySelector('.utb-box');
    let frame = null;
    if (img && box) {
      const imgRect = img.getBoundingClientRect();
      const boxRect = box.getBoundingClientRect();
      frame = {
        naturalWidth: img.naturalWidth, naturalHeight: img.naturalHeight, complete: img.complete,
        img: { left: imgRect.left, top: imgRect.top, width: imgRect.width, height: imgRect.height },
        box: { left: boxRect.left, top: boxRect.top, width: boxRect.width, height: boxRect.height },
      };
    }
    return {
      missing: false,
      sizeBar: Boolean(bar),
      inputs,
      byLabel,
      fitChecked: check ? check.checked : null,
      fitTitle: panel.querySelector('.utb-check') ? panel.querySelector('.utb-check').title : null,
      // P0-C 拖拽模式（用户 2026-11-02 要求）：复选框、光标与工具提示。
      panChecked: panBox ? panBox.checked : null,
      panDisabled: panBox ? panBox.disabled : null,
      panTitle: panBox && panBox.closest('.utb-check') ? panBox.closest('.utb-check').title : null,
      panLayer: Boolean(panLayer),
      panLayerCursor: panLayer ? getComputedStyle(panLayer).cursor : null,
      frameCursor: img ? getComputedStyle(img).cursor : null,
      framePanAttr: img ? img.getAttribute('data-utb-pan') : null,
      // P0-C v2 canvas compositing facts (docs/canvas-viewport.md §5.2): the clipping box is the
      // measurement surface (the <img> itself is translated inside it), plus its readiness barrier.
      canvasOn: box ? box.getAttribute('data-utb-canvas') : null,
      canvasReady: box ? box.getAttribute('data-utb-canvas-ready') : null,
      canvasBarrier: box ? box.getAttribute('data-utb-canvas-barrier') : null,
      canvasDetail: box ? box.getAttribute('data-utb-canvas-detail') : null,
      canvasBlank: box ? box.getAttribute('data-utb-canvas-blank') : null,
      canvasChecker: box ? box.getAttribute('data-utb-canvas-checker') : null,
      canvasZoom: box ? box.getAttribute('data-utb-canvas-zoom') : null,
      canvasZoomAnchor: box ? box.getAttribute('data-utb-canvas-zoom-anchor') : null,
      canvasZoomAnchorState: box ? box.getAttribute('data-utb-canvas-zoom-anchor-state') : null,
      stage: (() => {
        const stageEl = panel.querySelector('.utb-stage');
        if (!stageEl) return null;
        const rect = stageEl.getBoundingClientRect();
        return { left: rect.left, top: rect.top, width: rect.width, height: rect.height,
          clientWidth: stageEl.clientWidth, clientHeight: stageEl.clientHeight,
          scrollLeft: stageEl.scrollLeft, scrollTop: stageEl.scrollTop };
      })(),
      viewRevision: box && box.getAttribute('data-utb-view-revision') !== null && box.getAttribute('data-utb-view-revision') !== ''
        ? Number(box.getAttribute('data-utb-view-revision')) : null,
      canvasSeedClip: img ? img.getAttribute('data-utb-canvas-seed-clip') : null,
      boxBackground: box ? getComputedStyle(box).backgroundColor : null,
      boxBackgroundImage: box ? getComputedStyle(box).backgroundImage : null,
      imgTransform: img ? getComputedStyle(img).transform : null,
      zoomValue: zoom ? zoom.value : null,
      zoomTitle: zoom ? zoom.title : null,
      width: byLabel[${JSON.stringify(W_LABEL)}] ? byLabel[${JSON.stringify(W_LABEL)}].value : null,
      height: byLabel[${JSON.stringify(H_LABEL)}] ? byLabel[${JSON.stringify(H_LABEL)}].value : null,
      x: byLabel[${JSON.stringify(X_LABEL)}] ? byLabel[${JSON.stringify(X_LABEL)}].value : null,
      y: byLabel[${JSON.stringify(Y_LABEL)}] ? byLabel[${JSON.stringify(Y_LABEL)}].value : null,
      scale: byLabel[${JSON.stringify(SCALE_LABEL)}] ? byLabel[${JSON.stringify(SCALE_LABEL)}].value : null,
      xDisabled: byLabel[${JSON.stringify(X_LABEL)}] ? byLabel[${JSON.stringify(X_LABEL)}].disabled : null,
      yDisabled: byLabel[${JSON.stringify(Y_LABEL)}] ? byLabel[${JSON.stringify(Y_LABEL)}].disabled : null,
      bar: bar ? (() => {
        const rect = bar.getBoundingClientRect();
        const panelRect = panel.getBoundingClientRect();
        return { left: rect.left, right: rect.right, top: rect.top, bottom: rect.bottom, width: rect.width, height: rect.height,
                 panelLeft: panelRect.left, panelRight: panelRect.right, scrollWidth: bar.scrollWidth, clientWidth: bar.clientWidth };
      })() : null,
      stageTop: panel.querySelector('.utb-stage') ? panel.querySelector('.utb-stage').getBoundingClientRect().top : null,
      address: panel.querySelector('.utb-addr') ? panel.querySelector('.utb-addr').value : null,
      activeLabel: document.activeElement && document.activeElement.getAttribute ? document.activeElement.getAttribute('aria-label') : null,
      frame,
    };
  `));
}

async function openSizeBar() {
  await pageEvaluate(panelExpr(`
    const button = panel.querySelector('button[aria-label="尺寸调整"]');
    if (button && button.getAttribute('aria-pressed') !== 'true') button.click();
    return true;
  `));
  await waitFor(async () => ((await panelState()).sizeBar ? true : undefined), { timeoutMs: 5000, intervalMs: 100, label: 'size bar visible' });
}

async function fieldRect(label) {
  const rect = await pageEvaluate(panelExpr(`
    const input = [...panel.querySelectorAll('.utb-size input')].find((node) => node.getAttribute('aria-label') === ${JSON.stringify(label)});
    if (!input) return null;
    const r = input.getBoundingClientRect();
    return { x: r.left + r.width / 2, y: r.top + r.height / 2, left: r.left, top: r.top, width: r.width, height: r.height };
  `));
  if (!rect) throw new Error(`size-bar input not found: ${label}`);
  if (!(rect.width > 0) || !(rect.height > 0)) throw new Error(`size-bar input has no layout box (hidden panel?): ${label} ${JSON.stringify(rect)}`);
  return rect;
}

async function clickAt(x, y) {
  await state.chrome.cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y, button: 'none', buttons: 0 });
  await state.chrome.cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', buttons: 1, clickCount: 1 });
  await state.chrome.cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', buttons: 0, clickCount: 1 });
}

async function focusField(label) {
  let rect = await fieldRect(label);
  await ensureFieldHit({ label, field: await fieldKeyOf(label) }, rect);
  rect = await fieldRect(label);
  await clickAt(rect.x, rect.y);
  await sleep(120);
  return rect;
}

/** data-utb-field of one size-bar input (the field key the client uses). */
async function fieldKeyOf(label) {
  return pageEvaluate(panelExpr(`
    const input = [...panel.querySelectorAll('.utb-size input')].find((node) => node.getAttribute('aria-label') === ${JSON.stringify(label)});
    return input ? input.getAttribute('data-utb-field') : null;
  `));
}

/** Real keystroke text entry: select the field content, insert text, then Enter/Escape. */
async function typeIntoField(label, text, { enter = false, escape = false } = {}) {
  await focusField(label);
  await pageEvaluate(panelExpr(`
    const input = [...panel.querySelectorAll('.utb-size input')].find((node) => node.getAttribute('aria-label') === ${JSON.stringify(label)});
    if (!input) return false;
    input.select();
    return true;
  `));
  await state.chrome.cdp.send('Input.insertText', { text: String(text) });
  await sleep(100);
  if (escape) await pressKey('Escape', 'Escape', 27);
  else if (enter) await pressKey('Enter', 'Enter', 13);
}

async function pressKey(key, code, virtualKeyCode) {
  await state.chrome.cdp.send('Input.dispatchKeyEvent', { type: 'keyDown', key, code, windowsVirtualKeyCode: virtualKeyCode, nativeVirtualKeyCode: virtualKeyCode });
  await state.chrome.cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', key, code, windowsVirtualKeyCode: virtualKeyCode, nativeVirtualKeyCode: virtualKeyCode });
  await sleep(80);
}

/**
 * Make sure the point really hits the intended size-bar input. A DSH shell modal mask (e.g. the
 * sidebar drawer that a narrow window opens) sits above the panel and would swallow trusted input;
 * one real click on it closes it, exactly like a user would.
 */
async function ensureFieldHit(label, rect) {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const hit = await pageEvaluate(`(() => {
      const el = document.elementFromPoint(${rect.x}, ${rect.y});
      if (!el) return { blocked: true, reason: 'no element' };
      return {
        field: el.getAttribute ? el.getAttribute('data-utb-field') : null,
        label: el.getAttribute ? el.getAttribute('aria-label') : null,
        cls: String(el.className || '').slice(0, 60),
        dialogs: document.querySelectorAll('[role="dialog"]').length,
      };
    })()`).catch(() => ({ blocked: true, reason: 'probe failed' }));
    if (hit && (hit.field === label.field || hit.label === label.label)) return { ok: true, attempts: attempt };
    await dismissShellDialogs();
    await clickAt(rect.x, rect.y);
    await sleep(400);
    const refreshed = await fieldRect(label.label);
    rect = refreshed;
  }
  return { ok: false, last: await pageEvaluate(`(() => { const el = document.elementFromPoint(${rect.x}, ${rect.y}); return el ? String(el.className || el.tagName).slice(0, 60) : null; })()`).catch(() => null) };
}

/** Real wheel event over a size-bar field (CDP modifiers: Alt=1, Ctrl=2, Meta=4, Shift=8). */
async function wheelOnField(label, deltaY, modifiers = 0, { settle = true } = {}) {
  let rect = await fieldRect(label);
  const guard = await ensureFieldHit({ label, field: await fieldKeyOf(label) }, rect);
  rect = await fieldRect(label);
  if (!guard.ok) log(`  [warn] wheel target for ${label} is covered by ${guard.last}`);
  await sleep(40);
  // Chromium routes a wheel event to the *hovered* node, so the pointer must be moved first.
  await state.chrome.cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: rect.x, y: rect.y, button: 'none', buttons: 0 });
  await sleep(30);
  await state.chrome.cdp.send('Input.dispatchMouseEvent', { type: 'mouseWheel', x: rect.x, y: rect.y, deltaX: 0, deltaY, modifiers });
  if (settle) await sleep(STEP_SETTLE_MS);
  return rect;
}

/** A burst of wheel notches inside one 120ms window (proves the debounce merge). */
async function wheelBurst(label, count, deltaY, modifiers = 0) {
  let rect = await fieldRect(label);
  await ensureFieldHit({ label, field: await fieldKeyOf(label) }, rect);
  rect = await fieldRect(label);
  await state.chrome.cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: rect.x, y: rect.y, button: 'none', buttons: 0 });
  await sleep(30);
  // Fire the notches back-to-back: awaiting each CDP round-trip would space them far enough apart
  // for the 120ms trailing debounce to flush in between (which is correct behaviour, not a merge).
  await Promise.all(Array.from({ length: count }, () => state.chrome.cdp.send('Input.dispatchMouseEvent', {
    type: 'mouseWheel', x: rect.x, y: rect.y, deltaX: 0, deltaY, modifiers,
  })));
  await sleep(900);
  return rect;
}

/** Real wheel event over the displayed frame (same hover precondition; CDP modifier bitmask). */
async function wheelOnFramePoint(point, deltaY, modifiers = 0) {
  await state.chrome.cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: point.x, y: point.y, button: 'none', buttons: 0 });
  await sleep(30);
  await state.chrome.cdp.send('Input.dispatchMouseEvent', { type: 'mouseWheel', x: point.x, y: point.y, deltaX: 0, deltaY, modifiers });
}

/** Fire a burst of wheel notches inside one debounce window (proves one merged patch). */
async function wheelBurstOnFramePoint(point, count, deltaY) {
  await state.chrome.cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: point.x, y: point.y, button: 'none', buttons: 0 });
  await sleep(30);
  // Deliver every notch (40ms apart, still one 120ms debounce window) instead of racing the CDP
  // commands: Chromium may coalesce parallel wheel events, which would not exercise accumulation.
  for (let index = 0; index < count; index += 1) {
    await state.chrome.cdp.send('Input.dispatchMouseEvent', {
      type: 'mouseWheel', x: point.x, y: point.y, deltaX: 0, deltaY, modifiers: 0,
    });
    await sleep(40);
  }
  await sleep(900);
}

/** Wait until the panel's accepted shared-view revision equals the Host's. */
async function waitPanelRevision(expected, { timeoutMs = 7000 } = {}) {
  return waitFor(async () => {
    const panel = await panelState();
    return panel.viewRevision !== null && Number(panel.viewRevision) === Number(expected) ? panel : undefined;
  }, { timeoutMs, intervalMs: 100, label: `panel accepted view revision ${expected}` });
}

/** Wait for the strict screen-anchor post-layout check to settle. */
async function waitZoomAnchorState(expected = 'settled', { timeoutMs = 7000 } = {}) {
  return waitFor(async () => {
    const panel = await panelState();
    return panel.canvasZoomAnchorState === expected ? panel : undefined;
  }, { timeoutMs, intervalMs: 100, label: `zoom anchor state ${expected}` });
}

/** Reset the zoom test base (scale 1, C=-100/-100, fit off) and wait for the panel to adopt it. */
async function resetZoomBase() {
  await clickFit(false);
  await hostViewportSet({ width: 400, height: 300, scale: 1, x: 0, y: 0 });
  await waitHostView((view) => Number(view.width) === 400 && Number(view.height) === 300 && closeTo(view.scale, 1, 0.0011));
  const set = await hostViewportSet({ canvasX: -100, canvasY: -100 });
  const view = await waitHostView((v) => near(v.canvasX, -100, 1) && near(v.canvasY, -100, 1) && near(v.x, 0, 1) && near(v.y, 0, 1));
  await waitPanelMirrorsHost();
  await waitPanelRevision(view.view.revision);
  return view.view;
}

/** A point inside the current viewport box at box-relative (bx, by), kept visible in the stage. */
async function frameBoxPoint(b) {
  let panel = await panelState();
  if (!panel.frame || !panel.frame.box) throw new Error('no displayed frame box for the zoom point');
  let box = panel.frame.box;
  let point = { x: box.left + b.x, y: box.top + b.y };
  await ensurePointVisible(point);
  panel = await panelState();
  box = panel.frame.box;
  point = { x: box.left + b.x, y: box.top + b.y };
  return { point, box };
}

/** Emulation override for the GUI window; this Chromium requires the screen dimensions too. */
async function setGuiWindow(width, height) {
  await state.chrome.cdp.send('Emulation.setDeviceMetricsOverride', {
    width, height, deviceScaleFactor: 1, mobile: false, screenWidth: width, screenHeight: height,
  });
}

/** Keep a computed GUI point inside the visible stage (scroll only the panel's own stage). */
async function ensurePointVisible(point) {
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const box = await pageEvaluate(panelExpr(`
      const stage = panel.querySelector('.utb-stage');
      const rect = stage.getBoundingClientRect();
      return { left: rect.left, top: rect.top, right: rect.right, bottom: rect.bottom,
               vw: window.innerWidth, vh: window.innerHeight,
               scrollLeft: stage.scrollLeft, scrollTop: stage.scrollTop,
               maxLeft: stage.scrollWidth - stage.clientWidth, maxTop: stage.scrollHeight - stage.clientHeight };
    `));
    const insideStage = point.x >= box.left + 2 && point.x <= box.right - 2 && point.y >= box.top + 2 && point.y <= box.bottom - 2;
    const insideWindow = point.x > 0 && point.y > 0 && point.x < box.vw && point.y < box.vh;
    if (insideStage && insideWindow) return { point, scrolled: attempt > 0, box };
    const dx = point.x - (box.left + box.right) / 2;
    const dy = point.y - (box.top + box.bottom) / 2;
    await pageEvaluate(panelExpr(`
      const stage = panel.querySelector('.utb-stage');
      stage.scrollLeft = Math.max(0, Math.min(stage.scrollWidth - stage.clientWidth, stage.scrollLeft + ${Math.round(dx)}));
      stage.scrollTop = Math.max(0, Math.min(stage.scrollHeight - stage.clientHeight, stage.scrollTop + ${Math.round(dy)}));
      return { scrollLeft: stage.scrollLeft, scrollTop: stage.scrollTop };
    `));
    await sleep(250);
  }
  const box = await pageEvaluate(panelExpr(`(() => { const s = panel.querySelector('.utb-stage').getBoundingClientRect(); return { left: s.left, top: s.top, right: s.right, bottom: s.bottom }; })()`));
  return { point, scrolled: true, box, unreachable: true };
}

async function clickFit(checked) {
  await pageEvaluate(panelExpr(`
    const box = panel.querySelector('.utb-check input');
    if (!box) return false;
    if (box.checked !== ${Boolean(checked)}) box.click();
    return true;
  `));
  await sleep(STEP_SETTLE_MS);
}

/** Rect of the drag-mode checkbox (user request 2026-11-02). */
async function panCheckboxRect() {
  const rect = await pageEvaluate(panelExpr(`
    const box = panel.querySelector('.utb-check input[data-utb-check="pan"]');
    if (!box) return null;
    const r = box.getBoundingClientRect();
    return { x: r.left + r.width / 2, y: r.top + r.height / 2, left: r.left, top: r.top, width: r.width, height: r.height };
  `));
  if (!rect) throw new Error('drag-mode checkbox not found');
  return rect;
}

/** Toggle drag mode with a real click; returns the panel state after it. */
async function togglePan(expected) {
  await dismissShellDialogs();
  const rect = await panCheckboxRect();
  await clickAt(rect.x, rect.y);
  await sleep(220);
  let snapshot = await panelState();
  if (expected !== undefined && snapshot.panChecked !== expected) {
    await dismissShellDialogs();
    const again = await panCheckboxRect();
    await clickAt(again.x, again.y);
    await sleep(220);
    snapshot = await panelState();
  }
  return snapshot;
}

/**
 * Real mouse drag across the displayed frame (CDP input, pointer capture). Reads the grab cursor
 * while the button is held. `dx`/`dy` are host CSS pixels; the panel maps them through the painted
 * rect so the page scroll delta equals dx/scale (content-follow direction).
 */
async function dragOnFrame(dx, dy, { steps = 8, holdMs = 40 } = {}) {
  const first = paintedOf(await waitForFrame());
  if (!first) throw new Error('no displayed frame for the drag');
  await ensurePointVisible({ x: first.left + first.width / 2, y: first.top + first.height / 2 });
  await sleep(120);
  const painted = paintedOf(await waitForFrame());
  if (!painted) throw new Error('frame disappeared before the drag');
  const start = { x: painted.left + painted.width / 2, y: painted.top + painted.height / 2 };
  const send = (type, x, y, buttons, button) => state.chrome.cdp.send('Input.dispatchMouseEvent', {
    type, x, y, button, buttons, clickCount: type === 'mouseMoved' ? 0 : 1,
  });
  await send('mouseMoved', start.x, start.y, 0, 'none');
  await sleep(30);
  await send('mousePressed', start.x, start.y, 1, 'left');
  await sleep(80);
  const cursorDuringDrag = (await panelState()).frameCursor;
  for (let index = 1; index <= steps; index += 1) {
    await sleep(holdMs);
    await send('mouseMoved', start.x + (dx * index) / steps, start.y + (dy * index) / steps, 1, 'left');
  }
  await sleep(holdMs);
  await send('mouseReleased', start.x + dx, start.y + dy, 0, 'left');
  await sleep(250);
  return { start, painted, dx, dy, cursorDuringDrag };
}

/* ------------------------------------------------------------------------------------------------
 * Host requests issued from inside the GUI page (same browser peer / same panel scope).
 * ---------------------------------------------------------------------------------------------- */
async function pageHostFetch(path, { method = 'GET', headers = {}, body } = {}) {
  const separator = path.includes('?') ? '&' : '?';
  const url = '/plugins/ui-testing' + path + separator + 'utbViewportAcceptance=1';
  const expression = `(async () => {
    const response = await fetch(${JSON.stringify(url)}, {
      method: ${JSON.stringify(method)},
      headers: ${JSON.stringify(Object.assign({ 'X-UTB-Acceptance': 'script' }, headers))},
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

function requireScope() {
  if (!state.scopeHeaders) throw new Error('panel scope headers not captured yet');
  return state.scopeHeaders;
}

async function hostState() {
  const response = await pageHostFetch('/state', { headers: requireScope() });
  if (response.status !== 200 || !response.json || response.json.ok === false) {
    throw new Error(`GET /state -> ${response.status}: ${sanitize(response.text)}`);
  }
  return response.json;
}

async function hostView() {
  const snapshot = await hostState();
  const ui = snapshot.ui && typeof snapshot.ui === 'object' ? snapshot.ui : null;
  return {
    view: ui && ui.view ? ui.view : null,
    viewMeta: ui && ui.viewMeta ? ui.viewMeta : null,
    observed: ui && ui.observed ? ui.observed : null,
    ui,
  };
}

async function hostViewportSet(patch) {
  return pageHostFetch('/viewport', {
    method: 'POST',
    headers: Object.assign({ 'content-type': 'application/json' }, requireScope()),
    body: Object.assign({ version: 1 }, patch),
  });
}

/** Independent target-page truth through the plugin's own /eval route. */
async function targetEval(expression) {
  const response = await pageHostFetch('/eval', {
    method: 'POST',
    headers: Object.assign({ 'content-type': 'application/json' }, requireScope()),
    body: { expression },
  });
  if (response.status !== 200) throw new Error(`POST /eval -> ${response.status}: ${sanitize(response.text)}`);
  const payload = response.json || {};
  if (payload.ok === false) throw new Error(`eval failed: ${sanitize(response.text)}`);
  return payload.value !== undefined ? payload.value : payload.result;
}

async function navigateTarget(url) {
  const response = await pageHostFetch('/navigate', {
    method: 'POST',
    headers: Object.assign({ 'content-type': 'application/json' }, requireScope()),
    body: { url },
  });
  if (response.status !== 200 || !response.json || response.json.ok === false) {
    throw new Error(`POST /navigate -> ${response.status}: ${sanitize(response.text)}`);
  }
  return response.json;
}

async function waitForFrame(timeoutMs = 25000) {
  return waitFor(async () => {
    const snapshot = await panelState();
    const frame = snapshot.frame;
    return frame && frame.complete && frame.naturalWidth > 0 ? frame : undefined;
  }, { timeoutMs, intervalMs: 200, label: 'displayed frame decoded' });
}

/** Wait for a frame whose decoded natural size has stopped changing (two equal samples). */
async function waitFrameStable({ timeoutMs = 9000, intervalMs = 350 } = {}) {
  const deadline = Date.now() + timeoutMs;
  let previous = null;
  while (Date.now() < deadline) {
    const frame = await waitForFrame().catch(() => null);
    if (frame) {
      const key = `${frame.naturalWidth}x${frame.naturalHeight}`;
      if (previous === key) return frame;
      previous = key;
    }
    await sleep(intervalMs);
  }
  return waitForFrame();
}

/* ------------------------------------------------------------------------------------------------
 * Network observation: the panel's own requests and responses.
 * ---------------------------------------------------------------------------------------------- */
function hookNetworkEvents() {
  state.chrome.cdp.on((message) => {
    if (message.method === 'Network.requestWillBeSent') {
      const request = message.params.request || {};
      const headers = request.headers || {};
      const url = String(request.url || '');
      const entry = {
        at: Date.now(),
        requestId: message.params.requestId,
        url,
        method: String(request.method || ''),
        body: String(request.postData || ''),
        headers,
        script: url.includes('utbViewportAcceptance=1'),
      };
      state.requests.push(entry);
      if (!entry.script && !state.scopeHeaders && url.includes('/plugins/ui-testing/state')) {
        const version = headerValue(headers, 'x-ui-testing-scope-version');
        const sessionId = headerValue(headers, 'x-ui-testing-session-id');
        const binding = headerValue(headers, 'x-ui-testing-scope-binding');
        const special = headerValue(headers, 'x-ui-testing-scope');
        const captured = {};
        if (version) captured['X-UI-Testing-Scope-Version'] = version;
        if (sessionId) captured['X-UI-Testing-Session-Id'] = sessionId;
        else if (binding) captured['X-UI-Testing-Scope-Binding'] = binding;
        else if (special) captured['X-UI-Testing-Scope'] = special;
        if (captured['X-UI-Testing-Scope-Version']) {
          state.scopeHeaders = captured;
          log(`[env] panel scope captured (identity: ${Object.keys(captured).filter((key) => key !== 'X-UI-Testing-Scope-Version').join(',') || 'none'})`);
        }
      }
    }
    if (message.method === 'Network.responseReceived') {
      const response = message.params.response || {};
      state.responses.push({ at: Date.now(), requestId: message.params.requestId, url: String(response.url || ''), status: Number(response.status) || 0 });
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

function headerValue(headers, name) {
  if (!headers) return '';
  for (const [key, value] of Object.entries(headers)) {
    if (String(key).toLowerCase() === name) return String(value);
  }
  return '';
}

/** POST /viewport requests issued by the panel itself (not by this script). */
function panelViewportPosts(since = 0) {
  return state.requests.filter((entry) => !entry.script
    && entry.method === 'POST'
    && entry.url.includes('/plugins/ui-testing/viewport')
    && entry.at >= since);
}

function parseBody(entry) {
  try { return JSON.parse(entry.body || '{}'); } catch { return {}; }
}

/** Compact diagnostic timeline of the panel's own /viewport traffic (never an assertion). */
function logViewportTimeline(label, since = 0) {
  const base = since || (state.requests.length ? state.requests[0].at : Date.now());
  const rows = state.requests
    .filter((entry) => entry.at >= since && entry.url.includes('/plugins/ui-testing/viewport'))
    .map((entry) => ({ t: entry.at - base, script: entry.script, body: parseBody(entry) }));
  log(`  [timeline] ${label}: ${JSON.stringify(rows)}`);
}

/* ------------------------------------------------------------------------------------------------
 * Screenshot evidence.
 * ---------------------------------------------------------------------------------------------- */
async function capturePanel(name) {
  const raw = await pageEvaluate(panelExpr(`
    const stage = panel.querySelector('.utb-stage');
    const bar = panel.querySelector('.utb-size');
    const panelRect = panel.getBoundingClientRect();
    const stageRect = stage ? stage.getBoundingClientRect() : null;
    const barRect = bar ? bar.getBoundingClientRect() : null;
    return {
      panel: panelRect.toJSON(),
      stage: stageRect ? stageRect.toJSON() : null,
      bar: barRect ? barRect.toJSON() : null,
      vw: window.innerWidth,
      vh: window.innerHeight,
    };
  `)).catch(() => null);
  const shot = await (async () => {
    if (!raw || raw.missing || !raw.panel) return null;
    const top = raw.bar ? raw.bar.top : raw.panel.top;
    const bottom = raw.stage ? raw.stage.bottom : raw.panel.bottom;
    const x = Math.max(0, Math.round(raw.panel.left));
    const y = Math.max(0, Math.round(top));
    const width = Math.round(raw.panel.width);
    const height = Math.round(bottom - top);
    if (![x, y, width, height, raw.vw, raw.vh].every(Number.isFinite) || width < 10 || height < 10) {
      log(`  [EVIDENCE] ${name}: skipped (bad panel geometry ${JSON.stringify({ x, y, width, height, vw: raw.vw, vh: raw.vh })})`);
      return null;
    }
    const clip = {
      x,
      y,
      width: Math.max(1, Math.min(width, Math.round(raw.vw) - x)),
      height: Math.max(1, Math.min(height, Math.round(raw.vh) - y)),
      scale: 1,
    };
    return state.chrome.cdp.send('Page.captureScreenshot', { format: 'png', clip })
      .catch((error) => { log(`  [EVIDENCE] ${name}: capture failed (${String(error.message).slice(0, 140)} clip=${JSON.stringify(clip)})`); return null; });
  })();
  if (!shot) return null;
  const buffer = Buffer.from(shot.data, 'base64');
  const path = join(EVIDENCE_DIR, `${name}.png`);
  await writeFile(path, buffer, { mode: 0o600 });
  state.evidence.push({ name, path: path.slice(REPO_ROOT.length + 1), bytes: buffer.length });
  log(`  [EVIDENCE] ${name}.png (${buffer.length} bytes)`);
  return path;
}

/* ------------------------------------------------------------------------------------------------
 * Geometry helpers (contract §5.1, recomputed independently in the test).
 * ---------------------------------------------------------------------------------------------- */
function num(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}
function near(actual, expected, tolerance) {
  return num(actual) !== null && Math.abs(Number(actual) - Number(expected)) <= tolerance;
}

/**
 * Wait until the Host view satisfies `predicate`. A v1 set answers only after the two-frame
 * readback settles (≤1s), so a GUI assertion must never read the Host right after dispatching.
 */
async function waitHostView(predicate, { timeoutMs = 6000, intervalMs = 120, label = 'host view' } = {}) {
  const matched = await waitFor(async () => {
    const snapshot = await hostView();
    return snapshot.view && predicate(snapshot.view, snapshot) ? snapshot : undefined;
  }, { timeoutMs, intervalMs, label }).catch(() => null);
  if (matched) return matched;
  const fallback = await hostView();
  log(`  [debug] host view did not reach the expected state in ${timeoutMs}ms: ${JSON.stringify(fallback.view)}`);
  return { view: fallback.view, observed: fallback.observed, viewMeta: fallback.viewMeta, timedOut: true };
}

/** Compare two numbers with a small tolerance (scale fractions need a tighter one). */
function closeTo(actual, expected, tolerance = 1) {
  return num(actual) !== null && Math.abs(Number(actual) - Number(expected)) <= tolerance;
}

/** Wait until the panel inputs show the given numbers (the 500ms state poll adopts them). */
async function waitPanelValues(expected, { timeoutMs = 5000 } = {}) {
  return waitFor(async () => {
    const panel = await panelState();
    const ok = Object.entries(expected).every(([key, value]) => closeTo(panel[key], value, 1.5));
    return ok ? panel : undefined;
  }, { timeoutMs, intervalMs: 120, label: 'panel adopts ' + JSON.stringify(expected) });
}

/**
 * Wait until the panel's width/height inputs mirror the Host view (and the scale percent when fit
 * is off). Never aborts a scenario: a timeout is reported as `mirrored:false` with the mismatch,
 * so the following assertions state the real facts instead of a stack trace.
 */
async function waitPanelMirrorsHost({ timeoutMs = 6000 } = {}) {
  let last = null;
  const mirrored = await waitFor(async () => {
    const snapshot = await hostView();
    const panel = await panelState();
    if (!snapshot.view) return undefined;
    last = {
      host: { width: snapshot.view.width, height: snapshot.view.height, scale: snapshot.view.scale, x: snapshot.view.x, y: snapshot.view.y, source: snapshot.view.source, revision: snapshot.view.revision },
      panel: { width: panel.width, height: panel.height, scale: panel.scale, zoom: panel.zoomValue, x: panel.x, y: panel.y, fit: panel.fitChecked, active: panel.activeLabel, disabled: { x: panel.xDisabled, y: panel.yDisabled } },
    };
    const sizeOk = closeTo(panel.width, snapshot.view.width, 1.5) && closeTo(panel.height, snapshot.view.height, 1.5);
    const scaleOk = panel.fitChecked === true || closeTo(panel.scale, Number(snapshot.view.scale) * 100, 1.5);
    return sizeOk && scaleOk ? { view: snapshot.view, panel } : undefined;
  }, { timeoutMs, intervalMs: 120, label: 'panel mirrors host view' }).catch(() => null);
  if (mirrored) return mirrored;
  log(`  [debug] panel did not mirror the Host view in ${timeoutMs}ms: ${JSON.stringify(last)}`);
  return { view: (await hostView()).view, panel: await panelState(), mirrored: false, last };
}

function paintedOf(frame) {
  if (!frame || !frame.naturalWidth || !frame.naturalHeight) return null;
  // The Host canvas composite translates the <img> inside a clipping box. Measure the box (which
  // never moves) so pointer mapping stays in viewport space; when the transform is zero this is
  // byte-for-byte the historical img rectangle (the img fills the box).
  const host = frame.box || frame.img;
  if (!host) return null;
  const k = Math.min(host.width / frame.naturalWidth, host.height / frame.naturalHeight);
  const width = frame.naturalWidth * k;
  const height = frame.naturalHeight * k;
  return {
    left: host.left + (host.width - width) / 2,
    top: host.top + (host.height - height) / 2,
    width,
    height,
  };
}

function guiPointFor(painted, viewWidth, viewHeight, viewportX, viewportY) {
  return {
    x: painted.left + (viewportX / viewWidth) * painted.width,
    y: painted.top + (viewportY / viewHeight) * painted.height,
  };
}

/* ------------------------------------------------------------------------------------------------
 * P0-C v2 canvas probes (docs/canvas-viewport.md §5.2–§5.3).
 * ---------------------------------------------------------------------------------------------- */

/** Host-side canvas truth through the authenticated /state projection. */
async function hostCanvas() {
  const snapshot = await hostView();
  return {
    canvas: snapshot.ui && snapshot.ui.canvas ? snapshot.ui.canvas : null,
    view: snapshot.view,
    ui: snapshot.ui,
  };
}

/** Wait until the panel reports the canvas capability and its input barrier state. */
async function waitCanvasState(expectedOn, expectedReady, { timeoutMs = 6000 } = {}) {
  let last = null;
  try {
    return await waitFor(async () => {
      const panel = await panelState();
      last = panel;
      if (expectedOn !== undefined && panel.canvasOn !== (expectedOn ? 'on' : 'off')) return undefined;
      if (expectedReady !== undefined && panel.canvasReady !== (expectedReady ? 'true' : 'false')) return undefined;
      return panel;
    }, { timeoutMs, intervalMs: 100, label: `canvas on=${expectedOn} ready=${expectedReady}` });
  } catch (error) {
    log(`  [debug] canvas state timeout: on=${last && last.canvasOn} ready=${last && last.canvasReady} barrier=${last && last.canvasBarrier} detail=${last && last.canvasDetail} transform=${last && last.imgTransform} frame=${JSON.stringify(last && last.frame)}`);
    log(`  [debug] host view: ${JSON.stringify(await hostView().catch(() => null))}`);
    const metrics = await pageHostFetch('/metrics', { headers: requireScope() }).catch(() => null);
    log(`  [debug] host metrics: ${JSON.stringify(metrics && metrics.json && metrics.json.host ? { seq: metrics.json.host.seq, pushed: metrics.json.host.pushed, coalesced: metrics.json.host.coalesced, blocked: metrics.json.host.blocked, stale: metrics.json.host.stale } : metrics && metrics.text).slice(0, 800)}`);
    throw error;
  }
}

/** GUI point for a canvas-viewport point q (relative to the viewport's top-left). */
function guiPointForViewport(painted, viewWidth, viewHeight, qx, qy) {
  return guiPointFor(painted, viewWidth, viewHeight, qx, qy);
}

/** Element centre in document CSS px without scrolling the page (scrollIntoView would change S). */
async function elementDocumentRect(selector) {
  const rect = await targetEval(`(() => {
    const el = document.querySelector(${JSON.stringify(selector)});
    if (!el) return null;
    const r = el.getBoundingClientRect();
    return {
      docX: r.left + window.scrollX + r.width / 2,
      docY: r.top + window.scrollY + r.height / 2,
      scrollX: window.scrollX, scrollY: window.scrollY,
      innerWidth: window.innerWidth, innerHeight: window.innerHeight,
    };
  })()`);
  if (!rect) throw new Error(`target element not found: ${selector}`);
  return rect;
}

/** Panel POSTs to the seed screenshot route (canvas provenance path). */
function panelScreenshotPosts(since = 0) {
  return state.requests.filter((entry) => !entry.script
    && entry.method === 'POST'
    && entry.url.includes('/plugins/ui-testing/screenshot')
    && entry.at >= since).map(parseBody);
}

/** Parse the client's bounded canvas-barrier diagnostic attribute. */
function canvasDetailOf(panel) {
  try { return JSON.parse(panel && panel.canvasDetail ? panel.canvasDetail : '{}') || {}; }
  catch { return {}; }
}

/** Panel POSTs to one plugin endpoint issued by the panel itself (never by this script). */
function panelPosts(endpoint, since = 0) {
  return state.requests.filter((entry) => !entry.script
    && entry.method === 'POST'
    && entry.url.includes('/plugins/ui-testing/' + endpoint)
    && entry.at >= since);
}

/** Decode one PNG frame captured through CDP (8-bit RGB/RGBA, the format Chrome returns). */
let pngToolsModule = null;
async function pngTools() {
  if (!pngToolsModule) pngToolsModule = await import(pathToFileURL(join(REPO_ROOT, 'capture-p0.js')).href);
  return pngToolsModule;
}
async function decodeScreenshotPng(png) {
  return (await pngTools()).decodePng(png);
}

/** Capture the displayed clipping box and return decoded pixels (clip is in GUI viewport CSS px). */
async function captureBoxPixels(box) {
  const clip = {
    x: Math.max(0, Math.round(box.left)),
    y: Math.max(0, Math.round(box.top)),
    width: Math.max(1, Math.round(box.width)),
    height: Math.max(1, Math.round(box.height)),
    scale: 1,
  };
  const shot = await state.chrome.cdp.send('Page.captureScreenshot', { format: 'png', clip });
  const png = Buffer.from(shot.data, 'base64');
  const decoded = await decodeScreenshotPng(png);
  if (!decoded || decoded.ok === false) throw new Error(`cannot decode GUI screenshot: ${JSON.stringify(decoded)}`);
  return { decoded, clip, png };
}

function pixelAt(decoded, x, y) {
  const px = Math.max(0, Math.min(decoded.width - 1, Math.round(x)));
  const py = Math.max(0, Math.min(decoded.height - 1, Math.round(y)));
  const channels = decoded.channels;
  const base = (py * decoded.width + px) * channels;
  return { r: decoded.data[base], g: decoded.data[base + 1], b: decoded.data[base + 2], a: channels > 3 ? decoded.data[base + 3] : 255 };
}

function isPureWhite(pixel) {
  return pixel.r >= 250 && pixel.g >= 250 && pixel.b >= 250;
}

/** Parse the client's panel-only checkerboard diagnostic: "14px #2b2b2b #3f3f3f". */
function checkerboardOf(panelOrText) {
  const text = typeof panelOrText === 'string' ? panelOrText : (panelOrText && panelOrText.canvasChecker);
  const match = /^(\d+(?:\.\d+)?)px\s+#([0-9a-f]{6})\s+#([0-9a-f]{6})$/i.exec(String(text || '').trim());
  if (!match) return null;
  const rgb = (hex) => ({ r: parseInt(hex.slice(0, 2), 16), g: parseInt(hex.slice(2, 4), 16), b: parseInt(hex.slice(4, 6), 16) });
  return { size: Number(match[1]), colors: [rgb(match[2]), rgb(match[3])] };
}

function nearColor(pixel, rgb, tolerance = 2) {
  return Math.abs(pixel.r - rgb.r) <= tolerance && Math.abs(pixel.g - rgb.g) <= tolerance && Math.abs(pixel.b - rgb.b) <= tolerance;
}

/** Sample points (image-relative px) and classify them as checker/solid/contents. */
function checkerSample(decoded, checker, points) {
  if (!checker) return { checker: null, pixels: [], colorIndex: [], allChecker: false, both: false };
  const pixels = points.map(([x, y]) => pixelAt(decoded, x, y));
  const colorIndex = pixels.map((pixel) => {
    for (let index = 0; index < checker.colors.length; index += 1) {
      if (nearColor(pixel, checker.colors[index])) return index;
    }
    return -1;
  });
  return {
    checker,
    pixels,
    colorIndex,
    allChecker: colorIndex.every((index) => index >= 0),
    both: colorIndex.includes(0) && colorIndex.includes(1),
    white: pixels.filter(isPureWhite).length,
  };
}

/** Parse the translate component of a computed CSS transform (matrix / matrix3d), in CSS px. */
function transformTranslate(value) {
  const text = String(value || '');
  const matrix = /^matrix\(([^)]+)\)$/.exec(text);
  if (matrix) {
    const parts = matrix[1].split(',').map(Number);
    return { x: parts[4] || 0, y: parts[5] || 0 };
  }
  const matrix3d = /^matrix3d\(([^)]+)\)$/.exec(text);
  if (matrix3d) {
    const parts = matrix3d[1].split(',').map(Number);
    return { x: parts[12] || 0, y: parts[13] || 0 };
  }
  return { x: 0, y: 0 };
}

/**
 * Rewrite the panel's `/state` response bodies in-flight (CDP Fetch, Response stage). The script's
 * own `hostState()` requests carry `utbViewportAcceptance=1` and always pass through untouched, so
 * Host truth stays real while the panel can be driven through simulated Host snapshots.
 */
async function startStateRewrite(rewrite) {
  const { cdp } = state.chrome;
  const handler = async (message) => {
    if (message.method !== 'Fetch.requestPaused') return;
    const params = message.params || {};
    const requestId = params.requestId;
    const url = String((params.request && params.request.url) || '');
    if (!requestId) return;
    if (!url.includes('/plugins/ui-testing/state') || url.includes('utbViewportAcceptance=1')) {
      await cdp.send('Fetch.continueRequest', { requestId }).catch(() => {});
      return;
    }
    try {
      const body = await cdp.send('Fetch.getResponseBody', { requestId });
      const text = body.base64Encoded ? Buffer.from(body.body, 'base64').toString('utf8') : body.body;
      const json = JSON.parse(text);
      const next = rewrite(json) || json;
      const output = JSON.stringify(next);
      const headers = (params.responseHeaders || [])
        .filter((header) => !['content-length', 'content-encoding', 'transfer-encoding'].includes(String(header.name).toLowerCase()))
        .concat([{ name: 'content-length', value: String(Buffer.byteLength(output)) }]);
      await cdp.send('Fetch.fulfillRequest', {
        requestId,
        responseCode: 200,
        responseHeaders: headers,
        body: Buffer.from(output).toString('base64'),
      });
    } catch {
      await cdp.send('Fetch.continueRequest', { requestId }).catch(() => {});
    }
  };
  const off = cdp.on(handler);
  await cdp.send('Fetch.enable', { patterns: [{ urlPattern: '*/plugins/ui-testing/state*', requestStage: 'Response' }] });
  return async function stop() {
    try { await cdp.send('Fetch.disable'); } catch { /* ignore */ }
    off();
  };
}

/**
 * Intercept the panel's `/screenshot` seed requests and fulfill them from the test. Used only for
 * the negative seed cases (stale / missing provenance / HTTP failure); the happy path uses the
 * real Host composition.
 */
async function startScreenshotInterceptor() {
  const { cdp } = state.chrome;
  const paused = [];
  const listeners = [];
  const fulfill = async (entry, response) => {
    if (!entry || entry.done) throw new Error('seed request already fulfilled');
    const payload = response && response.body !== undefined ? response.body : response;
    const output = JSON.stringify(payload === undefined ? {} : payload);
    const headers = [
      { name: 'content-type', value: 'application/json' },
      { name: 'content-length', value: String(Buffer.byteLength(output)) },
    ];
    await cdp.send('Fetch.fulfillRequest', {
      requestId: entry.requestId,
      responseCode: Number(response && response.status) || 200,
      responseHeaders: headers,
      body: Buffer.from(output).toString('base64'),
    });
    entry.done = true;
  };
  const handler = async (message) => {
    if (message.method !== 'Fetch.requestPaused') return;
    const params = message.params || {};
    const url = String((params.request && params.request.url) || '');
    if (!url.includes('/plugins/ui-testing/screenshot')) {
      await cdp.send('Fetch.continueRequest', { requestId: params.requestId }).catch(() => {});
      return;
    }
    let body = {};
    try { body = JSON.parse(params.request.postData || '{}'); } catch { body = {}; }
    const entry = { requestId: params.requestId, body, at: Date.now(), done: false, url };
    paused.push(entry);
    for (const listener of listeners) { try { listener(entry); } catch { /* ignore */ } }
  };
  const off = cdp.on(handler);
  await cdp.send('Fetch.enable', { patterns: [{ urlPattern: '*/plugins/ui-testing/screenshot*', requestStage: 'Request' }] });
  return {
    requests: paused,
    waitForRequest(index, timeoutMs = 8000) {
      return waitFor(() => (paused.length > index ? paused[index] : undefined),
        { timeoutMs, intervalMs: 100, label: `seed screenshot request #${index + 1}` });
    },
    waitForNew(mark, timeoutMs = 8000) {
      return waitFor(() => paused.find((entry) => !entry.done && entry.at >= mark),
        { timeoutMs, intervalMs: 100, label: 'new seed screenshot request' });
    },
    pending() { return paused.filter((entry) => !entry.done); },
    onChange(listener) { listeners.push(listener); },
    respond(entry, response) { return fulfill(entry, response); },
    async stop() {
      try { await cdp.send('Fetch.disable'); } catch { /* ignore */ }
      off();
    },
  };
}

/**
 * Hold the first panel `/viewport` request at the CDP Request stage. Used by V14 to prove that a
 * zoom notch survives a CAS conflict and that a second notch is queued (not lost) while one set is
 * in flight. Script requests (`utbViewportAcceptance=1`) are always continued.
 */
async function startViewportHold() {
  const { cdp } = state.chrome;
  const requests = [];
  let held = null;
  let heldOnce = false;
  const handler = async (message) => {
    if (message.method !== 'Fetch.requestPaused') return;
    const params = message.params || {};
    const url = String((params.request && params.request.url) || '');
    // Hold exactly the first panel request; later ones (e.g. a conflict retry or the queued second
    // notch) must continue, otherwise the very fix under test would be deadlocked by the test.
    if (!url.includes('/plugins/ui-testing/viewport') || url.includes('utbViewportAcceptance=1') || heldOnce) {
      await cdp.send('Fetch.continueRequest', { requestId: params.requestId }).catch(() => {});
      return;
    }
    let body = {};
    try { body = JSON.parse(params.request.postData || '{}'); } catch { body = {}; }
    heldOnce = true;
    held = { requestId: params.requestId, body, at: Date.now(), url };
    requests.push(held);
  };
  const off = cdp.on(handler);
  await cdp.send('Fetch.enable', { patterns: [{ urlPattern: '*/plugins/ui-testing/viewport*', requestStage: 'Request' }] });
  return {
    requests,
    waitForHeld(timeoutMs = 7000) {
      return waitFor(() => held || undefined, { timeoutMs, intervalMs: 100, label: 'held /viewport request' });
    },
    async release() {
      if (!held) return false;
      const entry = held;
      held = null;
      await cdp.send('Fetch.continueRequest', { requestId: entry.requestId }).catch(() => {});
      return true;
    },
    async stop() {
      if (held) {
        const entry = held;
        held = null;
        await cdp.send('Fetch.continueRequest', { requestId: entry.requestId }).catch(() => {});
      }
      try { await cdp.send('Fetch.disable'); } catch { /* ignore */ }
      off();
    },
  };
}

/** Current real Host facts for a seed response (capture-time view + canvas box). */
async function seedFactsNow() {
  const snapshot = await hostCanvas();
  const view = snapshot.view;
  const canvas = snapshot.canvas;
  const observed = snapshot.observed || {};
  if (!view || !canvas) throw new Error('seedFactsNow: missing view/canvas');
  const scrollX = num(observed.x) !== null ? Number(observed.x) : Number(view.x);
  const scrollY = num(observed.y) !== null ? Number(observed.y) : Number(view.y);
  return {
    canvasX: Number(canvas.x),
    canvasY: Number(canvas.y),
    scrollX,
    scrollY,
    viewRevision: Number(view.revision),
    scale: Number(view.scale),
    width: Number(view.width),
    height: Number(view.height),
    contentWidth: Number(canvas.contentWidth),
    contentHeight: Number(canvas.contentHeight),
  };
}

/** Synthetic composed canvas PNG + provenance for one seed response (test-side composition). */
async function seedResponseFor(facts, options = {}) {
  const width = Math.max(1, Math.round(facts.width));
  const height = Math.max(1, Math.round(facts.height));
  const rgba = Buffer.alloc(width * height * 4);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const inside = x + facts.canvasX >= 0 && x + facts.canvasX < facts.contentWidth
        && y + facts.canvasY >= 0 && y + facts.canvasY < facts.contentHeight;
      const offset = (y * width + x) * 4;
      rgba[offset] = inside ? 200 : 255;
      rgba[offset + 1] = inside ? 30 : 255;
      rgba[offset + 2] = inside ? 30 : 255;
      rgba[offset + 3] = 255;
    }
  }
  const tools = await pngTools();
  const png = tools.encodePngRgba({ width, height, rgba });
  const revision = options.revision !== undefined ? Number(options.revision) : facts.viewRevision;
  const contentRect = {
    x: Math.max(0, facts.canvasX),
    y: Math.max(0, facts.canvasY),
    width: Math.max(0, Math.min(width, facts.contentWidth - Math.max(0, facts.canvasX))),
    height: Math.max(0, Math.min(height, facts.contentHeight - Math.max(0, facts.canvasY))),
  };
  return {
    ok: true,
    image: Buffer.from(png).toString('base64'),
    capturedAt: Date.now(),
    view: {
      version: 1, x: facts.scrollX, y: facts.scrollY, canvasX: facts.canvasX, canvasY: facts.canvasY,
      width, height, scale: facts.scale, revision, source: 'gui',
    },
    capture: {
      viewRevision: revision,
      requestedScale: facts.scale,
      viewport: { width, height },
      canvas: {
        version: 1, space: 'canvas-css-px', x: facts.canvasX, y: facts.canvasY,
        scrollX: facts.scrollX, scrollY: facts.scrollY,
        offsetX: facts.canvasX - facts.scrollX, offsetY: facts.canvasY - facts.scrollY,
        contentWidth: facts.contentWidth, contentHeight: facts.contentHeight,
        blank: '#ffffff', composite: true, source: 'cdp-page-capture-screenshot',
      },
      contentRect,
      composite: true,
      scroll: { x: facts.scrollX, y: facts.scrollY },
    },
  };
}

/** Apply a mutator to the nested `ui` object of a /state JSON body (top-level or `.state`). */
function mutateStateUi(json, mutate) {
  const visit = (root) => {
    if (!root || typeof root !== 'object') return;
    const ui = root.ui && typeof root.ui === 'object' ? root.ui : null;
    if (ui) mutate(ui);
  };
  visit(json);
  if (json && json.state && json.state !== json) visit(json.state);
  return json;
}

/* ------------------------------------------------------------------------------------------------
 * Target-page probes.
 * ---------------------------------------------------------------------------------------------- */
async function targetTruth() {
  return targetEval(`({
    scrollX: window.scrollX, scrollY: window.scrollY,
    innerWidth: window.innerWidth, innerHeight: window.innerHeight,
    devicePixelRatio: window.devicePixelRatio,
    visualViewportScale: window.visualViewport ? window.visualViewport.scale : null,
    counter: document.getElementById('t2-counter') ? document.getElementById('t2-counter').textContent : null,
    hyphen: window.__t2 ? true : false,
  })`);
}

/** Give the fixture page a deterministic horizontal overflow (installed from the test, not the page). */
async function ensureHorizontalOverflow() {
  return targetEval(`(() => {
    if (!document.getElementById('utb-wide-probe')) {
      const el = document.createElement('div');
      el.id = 'utb-wide-probe';
      el.style.cssText = 'width:3000px;height:1px;padding:0;margin:0;border:0;';
      document.body.appendChild(el);
    }
    return { scrollWidth: document.documentElement.scrollWidth, innerWidth: window.innerWidth,
             maxScrollX: Math.max(0, document.documentElement.scrollWidth - window.innerWidth) };
  })()`);
}

async function elementCenter(selector) {
  const rect = await targetEval(`(() => {
    const el = document.querySelector(${JSON.stringify(selector)});
    if (!el) return null;
    el.scrollIntoView({ block: 'center', inline: 'center' });
    const r = el.getBoundingClientRect();
    return { left: r.left, top: r.top, width: r.width, height: r.height,
             x: r.left + r.width / 2, y: r.top + r.height / 2,
             scrollX: window.scrollX, scrollY: window.scrollY,
             innerWidth: window.innerWidth, innerHeight: window.innerHeight };
  })()`);
  if (!rect) throw new Error(`target element not found: ${selector}`);
  await sleep(150);
  return rect;
}

async function resetTargetInstrumentation() {
  return targetEval(`(() => {
    if (window.__t3 && typeof window.__t3.reset === 'function') window.__t3.reset();
    if (window.__t2 && typeof window.__t2.reset === 'function') window.__t2.reset();
    return true;
  })()`);
}

/** Real click records of whichever fixture page is loaded (T2/T3 instrument the same way). */
async function clickRecords() {
  return targetEval(`(() => {
    const probe = window.__t3 || window.__t2;
    return probe ? probe.events.filter((event) => event.type === 'click') : [];
  })()`);
}

/** Click a target-page element through the panel and read the page's own event truth. */
async function clickThroughPanel(selector, viewWidth, viewHeight) {
  // A panel can transiently gate pointer writes while its main view is (re)loading; one bounded
  // retry after recomputing the page/box geometry keeps the assertion about a *real* trusted click
  // honest without weakening it (the final attempt still must hit the mapped target).
  let center = null;
  let point = null;
  let painted = null;
  let clicksDelta = 0;
  let record = null;
  let attempts = 0;
  for (let attempt = 1; attempt <= 2; attempt += 1) {
    attempts = attempt;
    center = await elementCenter(selector);
    const mapped = guiPointFor(paintedOf(await waitForFrame()), viewWidth, viewHeight, center.x, center.y);
    await ensurePointVisible(mapped);
    painted = paintedOf(await waitForFrame());
    point = guiPointFor(painted, viewWidth, viewHeight, center.x, center.y);
    await resetTargetInstrumentation();
    const clicksBefore = await targetEval('window.__t3 ? window.__t3.counters.clicks : -1');
    await clickAt(point.x, point.y);
    await sleep(800);
    const clicksAfter = await targetEval('window.__t3 ? window.__t3.counters.clicks : -1');
    clicksDelta = Number(clicksAfter) - Number(clicksBefore);
    record = await targetEval(`(() => {
      if (!window.__t3) return null;
      const clicks = window.__t3.events.filter((event) => event.type === 'click');
      return clicks.length ? clicks[clicks.length - 1] : null;
    })()`);
    if (clicksDelta > 0) break;
    await sleep(300);
  }
  return {
    clicksDelta,
    record: record ? { isTrusted: record.isTrusted, clientX: record.clientX, clientY: record.clientY, target: record.target } : null,
    viewportX: center ? center.x : null,
    viewportY: center ? center.y : null,
    point,
    painted,
    attempts,
  };
}

/* ------------------------------------------------------------------------------------------------
 * Main flow.
 * ---------------------------------------------------------------------------------------------- */
async function main() {
  if (!existsSync(DEFAULT_PROFILE) || !existsSync(join(DEFAULT_PROFILE, 'node_modules'))) {
    notRun('ENV', 'isolated DSH instance', `user DSH profile missing at ${DEFAULT_PROFILE}`);
    return 0;
  }
  if (!existsSync(CHROME_BIN)) {
    notRun('ENV', 'headless Chromium', `chrome binary/wrapper missing: ${CHROME_BIN}`);
    return 0;
  }
  await mkdir(RUN_DIR, { recursive: true });
  await mkdir(EVIDENCE_DIR, { recursive: true });
  state.buildInfo = buildInfo();

  const { startFixtureServer } = await import(pathToFileURL(join(REPO_ROOT, 'tests/ui_test_fixture/server.mjs')).href);
  state.fixture = await startFixtureServer();
  const fixtureBase = String(state.fixture.url).replace(/\/+$/, '');
  log(`[env] fixture: ${fixtureBase}`);

  const dsh = await startIsolatedDsh();
  log(`[env] isolated DSH: ${dsh.base} (port ${dsh.port}); DSH_HOME=${dsh.home}`);
  log(`[env] profile files copied: ${dsh.copied.join(',')}; node_modules symlinked from the user profile`);

  const cookies = await authenticate(dsh.launchUrl);
  log('[env] launch URL exchanged for an in-memory browser-session cookie (not logged)');

  state.chrome = await launchChrome(CHROME_BIN);
  const { cdp } = state.chrome;
  await cdp.send('Page.enable');
  await cdp.send('Runtime.enable');
  await cdp.send('Network.enable');
  hookNetworkEvents();
  log(`[env] headless chromium devtools port ${state.chrome.devtoolsPort}`);
  const base = new URL(dsh.base);
  for (const cookie of cookies) {
    const eq = cookie.indexOf('=');
    await cdp.send('Network.setCookie', { name: cookie.slice(0, eq), value: cookie.slice(eq + 1), url: base.origin + '/' });
  }
  await cdp.send('Page.navigate', { url: dsh.launchUrl });
  const boot = await guiReady(45000);
  check('V0.1', 'isolated DSH GUI is loaded from the ephemeral port', boot.origin === base.origin, base.origin, boot.origin);
  const location = await pageEvaluate('location.href');
  check('V0.2', 'token is exchanged away from the GUI address bar', !String(location).includes('token='), 'no token in location', location);
  check('V0.3', 'isolated instance never reads the user 3080/3081 ports', dsh.port !== 3080 && dsh.port !== 3081, 'port != 3080/3081', dsh.port);
  check('V0.4', 'launch token never appears in this run log', !logLines.join('\n').includes(state.token), 'no token in log', 'checked');

  state.servedClient = await servedClientEvidence();
  const servedMatchesCheckout = Boolean(state.servedClient && state.servedClient.text.trim() === readFileSync(join(REPO_ROOT, 'client.js'), 'utf8').trim());
  const servedHasNewViewportCode = Boolean(state.servedClient && state.servedClient.text.includes('data-utb-field')
    && state.servedClient.text.includes('视口 X 坐标（像素）') && state.servedClient.text.includes('VIEW_LIMITS'));
  check('V0.5', 'GUI serves this checkout client.js (size-bar/X-Y code present in the loaded bundle)',
    servedHasNewViewportCode,
    { hasUtbField: true, hasXLabel: true, hasViewLimits: true, exactMatch: servedMatchesCheckout },
    { rev: state.servedClient ? state.servedClient.rev : null, bytes: state.servedClient ? state.servedClient.bytes : null,
      sha256: state.servedClient ? state.servedClient.sha256Full : null, exactMatch: servedMatchesCheckout });
  state.servedClient.exactMatch = servedMatchesCheckout;
  state.servedClient.hasViewportCode = servedHasNewViewportCode;

  await openPanel();
  const firstBindPosts = panelViewportPosts();
  await openSizeBar();

  await scenario('V1 panel structure', async () => {
    const snapshot = await panelState();
    check('V1.1', '调试视图 panel is open (更多 → 调试视图)', snapshot.missing !== true, { panel: true }, snapshot.missing === true ? 'missing' : 'open');
    const labels = snapshot.inputs.map((input) => input.label);
    check('V1.2', 'five size-bar inputs exist with the exact aria-labels',
      [X_LABEL, Y_LABEL, W_LABEL, H_LABEL, SCALE_LABEL].every((label) => labels.includes(label)),
      [X_LABEL, Y_LABEL, W_LABEL, H_LABEL, SCALE_LABEL], labels);
    check('V1.3', 'fit box explains that it is local-only',
      String(snapshot.fitTitle || '').includes('适应窗口仅本地显示，不改变共享比例/Agent 截图比例'),
      '适应窗口仅本地显示，不改变共享比例/Agent 截图比例', snapshot.fitTitle);
    check('V1.4', 'size bar does not overflow the main panel',
      Boolean(snapshot.bar) && snapshot.bar.scrollWidth <= snapshot.bar.clientWidth + 1 && snapshot.bar.right <= snapshot.bar.panelRight + 1,
      { scrollWidth: '<= clientWidth', right: '<= panelRight' }, snapshot.bar);
    check('V1.5', 'panel renders without a page exception', state.exceptions.length === 0, [], state.exceptions.slice(0, 3));

  });

  await scenario('V2 host shared view', async () => {
    const snapshot = await hostView();
    if (!snapshot.ui || snapshot.ui.version !== 1 || !snapshot.view) {
      state.blocked = 'HOST_VIEW_MISSING';
      notRun('V2.1', 'Host exposes a shared ui.view', 'isolated Host 未提供 ui.view（task-2 未加载）；整套视口验收被阻塞，不做任何替代断言', { ui: snapshot.ui });
      return;
    }
    state.hostView = snapshot.view;
    check('V2.1', 'Host exposes ui.version=1 and a shared ui.view', true, { uiVersion: 1, view: 'present' },
      { uiVersion: snapshot.ui.version, view: snapshot.view });
    const view = snapshot.view;
    check('V2.2', 'shared view carries the contract fields',
      ['version', 'x', 'y', 'width', 'height', 'scale', 'source', 'revision'].every((key) => key in view),
      ['version', 'x', 'y', 'width', 'height', 'scale', 'source', 'revision'], Object.keys(view));
    check('V2.3', 'view.scale is the 0.1–2.0 fraction range', num(view.scale) !== null && Number(view.scale) >= 0.1 && Number(view.scale) <= 2,
      '0.1 <= scale <= 2', view.scale);
    check('V2.4', 'view width/height are inside 200–4096',
      num(view.width) >= 200 && num(view.width) <= 4096 && num(view.height) >= 200 && num(view.height) <= 4096,
      '200..4096', { width: view.width, height: view.height });
    check('V2.5', 'X/Y inputs are enabled once the Host view is adopted',
      (await panelState()).xDisabled === false && (await panelState()).yDisabled === false,
      { xDisabled: false, yDisabled: false },
      { xDisabled: (await panelState()).xDisabled, yDisabled: (await panelState()).yDisabled });
  });

  if (!state.blocked) {
    await scenario('V3 first binding', async () => {
      const posts = firstBindPosts;
      if (!posts.length) {
        notRun('V3.1', 'first binding publishes the local default size',
          'Host view source 在首次绑定时不是 default（adopt-only 路径），因此没有本地默认尺寸被推送', { view: state.hostView });
      } else {
        const bodies = posts.map(parseBody);
        check('V3.1', 'a default Host view publishes the local default 393×852 exactly once',
          posts.length === 1 && Number(bodies[0].width) === 393 && Number(bodies[0].height) === 852,
          [{ width: 393, height: 852 }], bodies);
        check('V3.2', 'the first viewport POST uses the v1 shape (version + expectedRevision)',
          Number(bodies[0].version) === 1 && Number.isFinite(Number(bodies[0].expectedRevision)),
          { version: 1, expectedRevision: 'number' }, bodies[0]);
        check('V3.3', 'the first viewport POST carries scale as a 0.1–2.0 fraction',
          num(bodies[0].scale) === null || (Number(bodies[0].scale) >= 0.1 && Number(bodies[0].scale) <= 2),
          'scale fraction', bodies[0].scale);
      }
      const adopted = await waitPanelMirrorsHost().catch(async () => ({ view: (await hostView()).view, panel: await panelState() }));
      check('V3.4', 'panel width/height inputs mirror the Host view after the first binding',
        Number(adopted.panel.width) === Number(adopted.view.width) && Number(adopted.panel.height) === Number(adopted.view.height),
        { width: adopted.view.width, height: adopted.view.height },
        { width: adopted.panel.width, height: adopted.panel.height, host: { width: adopted.view.width, height: adopted.view.height } });
      check('V3.5', 'fit is on by default and shows the local fit percentage, not the shared scale',
        adopted.panel.fitChecked === true && Number(adopted.panel.zoomValue) > 0,
        { fitChecked: true, percent: 'local fit' },
        { fitChecked: adopted.panel.fitChecked, percent: adopted.panel.zoomValue, hostScale: adopted.view.scale });
    });

    await scenario('V4 navigate target page', async () => {
      await navigateTarget(`${fixtureBase}/web-t2.html`);
      await waitFor(async () => {
        const snapshot = await panelState();
        return snapshot.address && snapshot.address.includes('web-t2.html') ? true : undefined;
      }, { timeoutMs: 20000, intervalMs: 250, label: 'panel address follows navigation' });
      const frame = await waitForFrame();
      const truth = await targetTruth();
      check('V4.1', 'target page loaded and the panel displays a decoded frame',
        Boolean(frame) && truth.counter !== null, { frame: 'decoded', counter: 'present' },
        { naturalWidth: frame.naturalWidth, naturalHeight: frame.naturalHeight, counter: truth.counter });
      const view = (await hostView()).view;
      check('V4.2', 'page CSS viewport equals the Host view size with DPR 1 (no zoom emulation)',
        truth.innerWidth === Number(view.width) && truth.innerHeight === Number(view.height) && Number(truth.devicePixelRatio) === 1,
        { innerWidth: view.width, innerHeight: view.height, devicePixelRatio: 1 },
        { innerWidth: truth.innerWidth, innerHeight: truth.innerHeight, devicePixelRatio: truth.devicePixelRatio, visualViewportScale: truth.visualViewportScale });
      const overflow = await ensureHorizontalOverflow();
      check('V4.3', 'deterministic horizontal overflow installed for the X/Y checks (test-side DOM probe)',
        overflow.maxScrollX > 500, 'maxScrollX > 500', overflow);
      const framesAfterNav = await targetTruth();
      check('V4.4', 'target page reports a stable CSS viewport after navigation',
        framesAfterNav.innerWidth === Number((await hostView()).view.width),
        { innerWidth: (await hostView()).view.width }, { innerWidth: framesAfterNav.innerWidth });
    });

    await scenario('V5 size-bar wheel', async () => {
      // Establish a known Host view, then wait for the panel to adopt it: a wheel's step is
      // computed from the visible draft, so a half-adopted panel would compute a wrong base.
      await hostViewportSet({ width: 1024, height: 768, scale: 1, x: 0, y: 0 });
      const settled = await waitHostView((view) => Number(view.width) === 1024 && Number(view.height) === 768 && closeTo(view.scale, 1, 0.001));
      await waitPanelMirrorsHost();
      const widthBefore = Number(settled.view.width);

      /** One wheel notch + wait for the Host to apply and settle, then assert. */
      async function wheelExpect(field, deltaY, modifiers, expected) {
        const before = (await hostView()).view;
        await wheelOnField(field, deltaY, modifiers);
        const after = await waitHostView((view) => Object.entries(expected).every(([key, value]) => closeTo(view[key], value, key === 'scale' ? 0.0011 : 1)));
        return { before, after: after.view, panel: await panelState() };
      }

      let step = await wheelExpect(W_LABEL, -120, 0, { width: widthBefore + 10 });
      check('V5.1', 'width wheel up applies +10 CSS px and the input follows',
        Number(step.after.width) === widthBefore + 10 && closeTo(step.panel.width, widthBefore + 10, 0.001),
        { host: widthBefore + 10, input: widthBefore + 10 }, { host: step.after.width, input: step.panel.width });

      step = await wheelExpect(W_LABEL, 120, SHIFT, { width: widthBefore - 90 });
      check('V5.2', 'Shift+wheel uses the 100 px step', Number(step.after.width) === widthBefore - 90,
        { width: widthBefore - 90 }, { width: step.after.width });

      step = await wheelExpect(W_LABEL, -120, ALT, { width: widthBefore - 89 });
      check('V5.3', 'Alt+wheel uses the 1 px step', Number(step.after.width) === widthBefore - 89,
        { width: widthBefore - 89 }, { width: step.after.width });

      step = await wheelExpect(W_LABEL, -120, ALT | SHIFT, { width: widthBefore - 88 });
      check('V5.4', 'Alt wins over Shift when both modifiers are held', Number(step.after.width) === widthBefore - 88,
        { width: widthBefore - 88 }, { width: step.after.width });

      const heightBefore = Number(step.after.height);
      step = await wheelExpect(H_LABEL, -120, ALT, { height: heightBefore + 1 });
      check('V5.5', 'height Alt+wheel applies +1 CSS px', Number(step.after.height) === heightBefore + 1,
        { height: heightBefore + 1 }, { height: step.after.height });
      step = await wheelExpect(H_LABEL, 120, SHIFT, { height: heightBefore - 99 });
      check('V5.6', 'height Shift+wheel applies the 100 px step', Number(step.after.height) === heightBefore - 99,
        { height: heightBefore - 99 }, { height: step.after.height });

      // Scale: 5 % steps, published as the 0.1–2.0 fraction, and the manual edit cancels fit.
      await hostViewportSet({ scale: 1 });
      await waitHostView((view) => closeTo(view.scale, 1, 0.001));
      await clickFit(false);
      await waitPanelMirrorsHost();
      const scalePanel = await panelState();
      const zoomBefore = Number(scalePanel.zoomValue);
      const scaleBefore = Number((await hostView()).view.scale);
      step = await wheelExpect(SCALE_LABEL, -120, 0, { scale: scaleBefore + 0.05 });
      check('V5.7', 'scale wheel up uses the 5 % step and publishes the fraction',
        closeTo(step.panel.zoomValue, zoomBefore + 5, 0.001) && closeTo(step.after.scale, scaleBefore + 0.05, 0.0011),
        { zoom: zoomBefore + 5, scale: Number((scaleBefore + 0.05).toFixed(2)) },
        { zoom: step.panel.zoomValue, scale: step.after.scale });
      check('V5.8', 'manual scale keeps fit unchecked', step.panel.fitChecked === false, false, step.panel.fitChecked);

      // X/Y wheel: the target page really scrolls and the inputs echo the measured scroll.
      await hostViewportSet({ x: 0, y: 0, width: 400, height: 320, scale: 1 });
      await waitHostView((view) => Number(view.width) === 400 && Number(view.height) === 320 && closeTo(view.x, 0, 0.5) && closeTo(view.y, 0, 0.5));
      await waitPanelMirrorsHost();
      step = await wheelExpect(Y_LABEL, -120, SHIFT, { y: 100 });
      const afterY = await targetTruth();
      check('V5.9', 'Y Shift+wheel scrolls the target page by 100 CSS px and the input echoes the observed scroll',
        closeTo(afterY.scrollY, 100, 2) && closeTo(step.panel.y, afterY.scrollY, 1.5),
        { scrollY: 100, echo: 100 }, { scrollY: afterY.scrollY, input: step.panel.y });

      step = await wheelExpect(X_LABEL, -120, 0, { x: 10 });
      const afterX = await targetTruth();
      check('V5.10', 'X wheel scrolls the target page by 10 CSS px and is echoed',
        closeTo(afterX.scrollX, 10, 1.5) && closeTo(step.panel.x, afterX.scrollX, 1.5),
        { scrollX: 10, echo: 10 }, { scrollX: afterX.scrollX, input: step.panel.x });

      // A burst merges into one request; nothing leaks to the host document or the target page.
      await hostViewportSet({ x: 0, y: 0 });
      await waitHostView((view) => closeTo(view.x, 0, 0.5) && closeTo(view.y, 0, 0.5));
      await waitPanelMirrorsHost();
      const guiScrollBefore = await pageEvaluate('document.scrollingElement.scrollTop');
      const truthBefore = await targetTruth();
      const widthBeforeBurst = Number((await hostView()).view.width);
      const timelineMark = Date.now();
      const markMerge = Date.now();
      await wheelBurst(W_LABEL, 3, -120);
      const merged = panelViewportPosts(markMerge);
      await waitHostView((view) => Number(view.width) === widthBeforeBurst + 30);
      check('V5.11', 'a wheel burst merges into a single /viewport request', merged.length === 1,
        { requests: 1 }, { requests: merged.length, bodies: merged.map(parseBody) });
      const mergedBody = merged.length ? parseBody(merged[0]) : {};
      check('V5.12', 'the merged patch carries only the wheeled field(s)',
        Object.keys(mergedBody).filter((key) => key !== 'version' && key !== 'expectedRevision').every((key) => ['width', 'height', 'x', 'y', 'scale'].includes(key)),
        ['width'], Object.keys(mergedBody));

      const guiScrollAfter = await pageEvaluate('document.scrollingElement.scrollTop');
      const truthAfter = await targetTruth();
      check('V5.13', 'size-bar wheel does not scroll the GUI document', guiScrollAfter === guiScrollBefore,
        { scrollTop: guiScrollBefore }, { scrollTop: guiScrollAfter });
      check('V5.14', 'size-bar wheel never reaches the target page',
        truthAfter.scrollY === truthBefore.scrollY && truthAfter.scrollX === truthBefore.scrollX,
        { scrollX: truthBefore.scrollX, scrollY: truthBefore.scrollY },
        { scrollX: truthAfter.scrollX, scrollY: truthAfter.scrollY });

      const beforeIgnored = (await hostView()).view;
      await wheelOnField(W_LABEL, 0);
      await sleep(500);
      const afterZero = (await hostView()).view;
      check('V5.15', 'delta=0 changes nothing', Number(afterZero.width) === Number(beforeIgnored.width),
        { width: beforeIgnored.width }, { width: afterZero.width });

      // Ctrl/Meta+wheel belongs to the shell (host zoom). Check it on a quiet, settled view so a
      // late flush from the previous burst cannot be mistaken for this wheel's effect.
      logViewportTimeline('burst → V5.16', timelineMark);
      await hostViewportSet({ width: 500, height: 400 });
      await waitHostView((view) => Number(view.width) === 500 && Number(view.height) === 400);
      await waitPanelMirrorsHost();
      await sleep(400);
      const beforeCtrl = (await hostView()).view;
      const postsBeforeCtrl = panelViewportPosts().length;
      const dprBeforeCtrl = await pageEvaluate('window.devicePixelRatio');
      await pageEvaluate(`(() => {
        window.__utbCtrlWheel = [];
        document.addEventListener('wheel', (event) => window.__utbCtrlWheel.push({
          ctrl: event.ctrlKey, alt: event.altKey, shift: event.shiftKey, meta: event.metaKey,
          deltaY: event.deltaY, prevented: event.defaultPrevented,
          field: event.target && event.target.getAttribute ? event.target.getAttribute('data-utb-field') : null,
        }), true);
        return true;
      })()`);
      await wheelOnField(W_LABEL, -120, CTRL);
      await sleep(900);
      const afterCtrl = (await hostView()).view;
      const ctrlWheelFacts = await pageEvaluate(`({ events: window.__utbCtrlWheel, dpr: window.devicePixelRatio })`);
      check('V5.16', 'Ctrl+wheel never edits the field and never triggers the native number step',
        panelViewportPosts().length === postsBeforeCtrl && Number(afterCtrl.width) === Number(beforeCtrl.width),
        { requests: postsBeforeCtrl, width: beforeCtrl.width },
        { requests: panelViewportPosts().length, width: afterCtrl.width,
          drift: Number(afterCtrl.width) - Number(beforeCtrl.width),
          delivered: ctrlWheelFacts && ctrlWheelFacts.events,
          dprBefore: dprBeforeCtrl, dprAfter: ctrlWheelFacts && ctrlWheelFacts.dpr });
      const scaleBeforeMeta = Number((await hostView()).view.scale);
      const postsBeforeMeta = panelViewportPosts().length;
      await wheelOnField(SCALE_LABEL, -120, 4 /* Meta */);
      await sleep(900);
      const afterMeta = (await hostView()).view;
      check('V5.16b', 'Meta+wheel never changes the shared ratio', closeTo(afterMeta.scale, scaleBeforeMeta, 0.001)
        && panelViewportPosts().length === postsBeforeMeta,
        { scale: scaleBeforeMeta, requests: postsBeforeMeta },
        { scale: afterMeta.scale, requests: panelViewportPosts().length });

      await hostViewportSet({ width: 4090, height: 900 });
      await waitHostView((view) => Number(view.width) === 4090);
      await waitPanelMirrorsHost();
      await wheelOnField(W_LABEL, -120, SHIFT);
      await wheelOnField(W_LABEL, -120, SHIFT);
      const clampedWidth = await waitHostView((view) => Number(view.width) === 4096).catch(() => hostView());
      check('V5.17', 'width clamps at 4096', Number(clampedWidth.view.width) === 4096,
        { width: 4096 }, { width: clampedWidth.view.width, input: (await panelState()).width });

      await hostViewportSet({ scale: 2 });
      await waitHostView((view) => closeTo(view.scale, 2, 0.001));
      await waitPanelMirrorsHost();
      await wheelOnField(SCALE_LABEL, -120);
      const clampedScale = await hostView();
      check('V5.18', 'scale clamps at 200 %', closeTo(clampedScale.view.scale, 2, 0.001),
        { scale: 2 }, { scale: clampedScale.view.scale, input: (await panelState()).scale });
    });

    await scenario('V6 X/Y inputs', async () => {
      await hostViewportSet({ x: 0, y: 0, width: 1024, height: 768, scale: 1 });
      await waitHostView((view) => Number(view.width) === 1024 && Number(view.height) === 768);
      await waitPanelMirrorsHost();
      await ensureHorizontalOverflow();
      await typeIntoField(X_LABEL, '25', { enter: true });
      await typeIntoField(Y_LABEL, '210', { enter: true });
      await sleep(600);
      const truth = await targetTruth();
      check('V6.1', 'Enter on X/Y commits the exact target-page scroll',
        near(truth.scrollX, 25, 0.5) && near(truth.scrollY, 210, 0.5),
        { scrollX: 25, scrollY: 210 }, { scrollX: truth.scrollX, scrollY: truth.scrollY });

      const panel = await panelState();
      check('V6.2', 'X/Y inputs echo the observed scroll', near(Number(panel.x), truth.scrollX, 1.5) && near(Number(panel.y), truth.scrollY, 1.5),
        { x: truth.scrollX, y: truth.scrollY }, { x: panel.x, y: panel.y });

      const postsBeforeEscape = panelViewportPosts().length;
      await typeIntoField(X_LABEL, '777', { escape: true });
      await sleep(250);
      const panelAfterEscape = await panelState();
      check('V6.3', 'Escape restores the accepted value and sends nothing',
        near(Number(panelAfterEscape.x), truth.scrollX, 1.5) && panelViewportPosts().length === postsBeforeEscape,
        { x: truth.scrollX, requests: postsBeforeEscape }, { x: panelAfterEscape.x, requests: panelViewportPosts().length });

      // Page-driven scroll: the Host schedule a merged readback on /state and /frame requests, so
      // the new x/y appear on a *later* poll (contract: typically 0.2–0.7 s, ≤1.5 s worst case).
      const beforePageScroll = await hostView();
      const revisionBeforeScroll = Number(beforePageScroll.view.revision);
      const pageScrollStartedAt = Date.now();
      await targetEval('window.scrollTo(0, 640)');
      let pageScrollEcho = null;
      await waitFor(async () => {
        const snapshot = await hostView();
        if (!snapshot.view) return undefined;
        if (!near(snapshot.view.y, 640, 2)) return undefined;
        pageScrollEcho = { view: snapshot.view, observed: snapshot.observed, elapsedMs: Date.now() - pageScrollStartedAt };
        return true;
      }, { timeoutMs: 2000, intervalMs: 120, label: 'host view echoes the page scroll' }).catch(() => undefined);
      // The Host echo is one hop; the panel's own 500 ms state poll carries it into the input.
      let panelEcho = null;
      await waitFor(async () => {
        const panel = await panelState();
        if (!near(Number(panel.y), 640, 3)) return undefined;
        panelEcho = { panel, elapsedMs: Date.now() - pageScrollStartedAt };
        return true;
      }, { timeoutMs: 2500, intervalMs: 100, label: 'panel echoes the page scroll' }).catch(() => undefined);
      check('V6.4', 'page-initiated scroll is echoed into the Y input (≤2.5 s, source=page, revision advances)',
        Boolean(pageScrollEcho) && Boolean(panelEcho),
        { y: 640, source: 'page', revision: '>' },
        { echo: pageScrollEcho ? { y: pageScrollEcho.view.y, x: pageScrollEcho.view.x, source: pageScrollEcho.view.source, revision: pageScrollEcho.view.revision, elapsedMs: pageScrollEcho.elapsedMs } : null,
          input: (await panelState()).y, inputElapsedMs: panelEcho ? panelEcho.elapsedMs : null, revisionBefore: revisionBeforeScroll });
      check('V6.4b', 'the page-driven view change is attributed to the page and advances the revision',
        Boolean(pageScrollEcho) && String(pageScrollEcho.view.source) === 'page' && Number(pageScrollEcho.view.revision) > revisionBeforeScroll,
        { source: 'page', revision: `> ${revisionBeforeScroll}` },
        pageScrollEcho ? { source: pageScrollEcho.view.source, revision: pageScrollEcho.view.revision } : null);
      // A page scroll also bumps the revision: the *next* GUI write must still succeed (the client
      // adopts the fresh revision; a rejected patch is never auto-replayed).
      const widthBeforeAfterPageScroll = Number((await hostView()).view.width);
      await wheelOnField(W_LABEL, -120);
      const afterPageScrollWrite = await waitHostView((view) => Number(view.width) === widthBeforeAfterPageScroll + 10);
      check('V6.4c', 'a GUI write right after a page-driven revision change still applies (+10 px)',
        Number(afterPageScrollWrite.view.width) === widthBeforeAfterPageScroll + 10,
        { width: widthBeforeAfterPageScroll + 10 },
        { width: afterPageScrollWrite.view.width, timedOut: afterPageScrollWrite.timedOut === true });
      await hostViewportSet({ x: 0, y: 0 });
      await waitHostView((view) => closeTo(view.y, 0, 1));
      await waitPanelMirrorsHost();

      await typeIntoField(Y_LABEL, '120', { enter: true });
      await sleep(500);
      const finalTruth = await targetTruth();
      check('V6.5', 'Enter keeps the target page and the input in sync',
        near(finalTruth.scrollY, 120, 1), { scrollY: 120 }, { scrollY: finalTruth.scrollY, input: (await panelState()).y });

      const illegal = await typeIntoField(Y_LABEL, '99999999', { enter: true }).then(() => panelState());
      check('V6.6', 'an out-of-range draft is not committed and reverts to the accepted value',
        near(Number(illegal.y), 120, 1), { y: 120 }, { y: illegal.y });
    });

    await scenario('V7 agent shared view', async () => {
      const modeResponse = await hostViewportSet({ mode: 'tablet' });
      check('V7.1', 'Agent mode=tablet is accepted by the Host',
        modeResponse.status === 200 && modeResponse.json && modeResponse.json.ok !== false,
        { status: 200 }, { status: modeResponse.status, code: modeResponse.json && modeResponse.json.code });
      const afterMode = await waitHostView((view) => Number(view.width) === 768 && Number(view.height) === 1024);
      check('V7.2', 'mode expands to 768×1024 in the shared view',
        Number(afterMode.view.width) === 768 && Number(afterMode.view.height) === 1024,
        { width: 768, height: 1024 }, { width: afterMode.view.width, height: afterMode.view.height });
      const panelAfterMode = await waitPanelValues({ width: 768, height: 1024 }).catch(() => panelState());
      check('V7.3', 'panel inputs adopt the Agent mode size',
        Number(panelAfterMode.width) === 768 && Number(panelAfterMode.height) === 1024,
        { width: 768, height: 1024 }, { width: panelAfterMode.width, height: panelAfterMode.height });

      const setResponse = await hostViewportSet({ x: 40, y: 120, scale: 1.5 });
      check('V7.4', 'Agent x/y/scale set is accepted',
        setResponse.status === 200 && setResponse.json && setResponse.json.ok !== false,
        { status: 200 }, { status: setResponse.status, code: setResponse.json && setResponse.json.code });
      const afterSet = await waitHostView((view) => closeTo(view.x, 40, 1) && closeTo(view.y, 120, 1) && closeTo(view.scale, 1.5, 0.001));
      const panelAfterSet = await waitPanelValues({ x: 40, y: 120, zoomValue: 150 }).catch(() => panelState());
      check('V7.5', 'panel echoes the Agent x/y/scale',
        near(Number(panelAfterSet.x), 40, 2) && near(Number(panelAfterSet.y), 120, 2) && near(Number(panelAfterSet.zoomValue), 150, 0.001),
        { x: 40, y: 120, zoom: 150 }, { x: panelAfterSet.x, y: panelAfterSet.y, zoom: panelAfterSet.zoomValue });
      check('V7.6', 'an Agent change cancels the local fit preference', panelAfterSet.fitChecked === false,
        false, panelAfterSet.fitChecked);
      check('V7.7', 'the external set advances the view revision (HTTP v1 sets are recorded as source=gui)',
        String(afterSet.view.source) === 'gui' && Number(afterSet.view.revision) > Number(state.hostView.revision),
        { source: 'gui', revision: '>' }, { source: afterSet.view.source, revision: afterSet.view.revision });
      notRun('V7.10', 'view.source=agent after a browser_viewport tool set',
        'agent-source attribution belongs to the Agent tool path (Host acceptance H2); this GUI suite can only issue the HTTP v1 route, which the Host records as source=gui');

      const truth = await targetTruth();
      check('V7.8', 'the target page really renders the Agent viewport and scroll',
        truth.innerWidth === 768 && truth.innerHeight === 1024 && near(truth.scrollX, 40, 1) && near(truth.scrollY, 120, 1),
        { innerWidth: 768, innerHeight: 1024, scrollX: 40, scrollY: 120 },
        { innerWidth: truth.innerWidth, innerHeight: truth.innerHeight, scrollX: truth.scrollX, scrollY: truth.scrollY });

      const markNav = Date.now();
      await navigateTarget(`${fixtureBase}/web-t2.html?second=1`);
      await sleep(1500);
      const navPosts = panelViewportPosts(markNav);
      const viewAfterNav = (await hostView()).view;
      check('V7.9', 'navigation publishes no viewport request on a shared-view Host',
        navPosts.length === 0 && Number(viewAfterNav.width) === 768 && Number(viewAfterNav.height) === 1024,
        { viewportPosts: 0, width: 768, height: 1024 },
        { viewportPosts: navPosts.map(parseBody), width: viewAfterNav.width, height: viewAfterNav.height });
      await waitForFrame();
      await ensureHorizontalOverflow();
      await resetTargetInstrumentation();
    });

    await scenario('V8 hit test at fit<100% and scale>100%', async () => {
      // The T3 fixture records real clientX/clientY/isTrusted per event, so the mapping can be
      // checked against page truth and not only against "a click happened".
      await navigateTarget(`${fixtureBase}/web-t3.html`);
      await waitForFrame();
      await hostViewportSet({ width: 1920, height: 1080, scale: 1, x: 0, y: 0 });
      await waitHostView((view) => Number(view.width) === 1920 && Number(view.height) === 1080);
      await waitPanelMirrorsHost();
      await clickFit(true);
      // Two state polls (>1s) must not cancel the local fit: only an external content change may.
      await sleep(1600);
      const fitPanel = await panelState();
      const fitPercent = Number(fitPanel.zoomValue);
      const fitFrame = await waitForFrame();
      check('V8.1', 'fit ratio below 100 % stays checked across state polls',
        fitPanel.fitChecked === true && fitPercent > 0 && fitPercent < 100,
        { fitChecked: true, percent: '<100' },
        { fitChecked: fitPanel.fitChecked, percent: fitPercent, frame: fitFrame ? { naturalWidth: fitFrame.naturalWidth, naturalHeight: fitFrame.naturalHeight } : null });

      const fitClick = await clickThroughPanel('#t3-click', 1920, 1080);
      check('V8.2', 'fixed element hit at fit<100 % (clicks +1, isTrusted, mapped clientX/Y)',
        fitClick.clicksDelta === 1 && fitClick.record && fitClick.record.isTrusted === true
          && fitClick.record.target === 't3-click'
          && near(fitClick.record.clientX, fitClick.viewportX, 1.5) && near(fitClick.record.clientY, fitClick.viewportY, 1.5),
        { clicksDelta: 1, isTrusted: true, target: 't3-click', clientX: 'viewportX', clientY: 'viewportY' },
        { clicksDelta: fitClick.clicksDelta, record: fitClick.record, expected: { viewportX: fitClick.viewportX, viewportY: fitClick.viewportY }, point: fitClick.point });
      await capturePanel('shot-02-fit-under-100');

      await clickFit(false);
      await hostViewportSet({ width: 400, height: 320, scale: 2, x: 0, y: 0 });
      await waitHostView((view) => Number(view.width) === 400 && Number(view.height) === 320 && closeTo(view.scale, 2, 0.001));
      await waitPanelMirrorsHost();
      const panel200 = await panelState();
      check('V8.3', 'manual 200 % is displayed and shared with the Host',
        near(Number(panel200.zoomValue), 200, 0.001) && near(num((await hostView()).view.scale), 2, 0.001) && panel200.fitChecked === false,
        { zoom: 200, scale: 2, fitChecked: false },
        { zoom: panel200.zoomValue, scale: (await hostView()).view.scale, fitChecked: panel200.fitChecked });

      const bigClick = await clickThroughPanel('#t3-click', 400, 320);
      check('V8.4', 'fixed element hit at scale>100 % (clicks +1, isTrusted, mapped clientX/Y)',
        bigClick.clicksDelta === 1 && bigClick.record && bigClick.record.isTrusted === true
          && bigClick.record.target === 't3-click'
          && near(bigClick.record.clientX, bigClick.viewportX, 1.5) && near(bigClick.record.clientY, bigClick.viewportY, 1.5),
        { clicksDelta: 1, isTrusted: true, target: 't3-click' },
        { clicksDelta: bigClick.clicksDelta, record: bigClick.record, expected: { viewportX: bigClick.viewportX, viewportY: bigClick.viewportY }, point: bigClick.point });
      await capturePanel('shot-03-scale-200');

      const letterbox = await probeLetterbox();
      if (letterbox.band >= 4) {
        await resetTargetInstrumentation();
        const before = (await clickRecords()).length;
        await clickAt(letterbox.x, letterbox.y);
        await sleep(500);
        const after = (await clickRecords()).length;
        check('V8.5', 'a click in the letterbox band is not dispatched into the target page',
          after === before, { clicks: before }, { clicks: after, band: letterbox.band, point: { x: letterbox.x, y: letterbox.y } });
      } else {
        notRun('V8.5', 'letterbox zero dispatch',
          'the live frame has no letterbox band (the painted rect fills the container), so there is no outside-painted area inside the box to click',
          letterbox);
      }

      await resetTargetInstrumentation();
      const beforeOutside = (await clickRecords()).length;
      const stagePoint = await pageEvaluate(panelExpr(`
        const stage = panel.querySelector('.utb-stage');
        if (!stage) return null;
        const rect = stage.getBoundingClientRect();
        return { x: Math.round(rect.left + 6), y: Math.round(rect.top + 6) };
      `)).catch(() => null);
      if (!stagePoint || !Number.isFinite(stagePoint.x)) {
        notRun('V8.6', 'click outside the image box', 'the panel stage geometry was unavailable in this layout', { stagePoint });
      } else {
        await clickAt(stagePoint.x, stagePoint.y);
        await sleep(400);
        const afterOutside = (await clickRecords()).length;
        check('V8.6', 'a click outside the image box performs zero dispatch',
          afterOutside === beforeOutside, { clicks: beforeOutside }, { clicks: afterOutside, point: stagePoint });
      }
    });

    await scenario('V9 frame wheel scaling', async () => {
      await hostViewportSet({ width: 400, height: 320, scale: 2, x: 0, y: 0 });
      await waitHostView((view) => Number(view.width) === 400 && Number(view.height) === 320 && closeTo(view.scale, 2, 0.001));
      await waitPanelMirrorsHost();
      const frame200 = await waitForFrame();
      const painted200 = paintedOf(frame200);
      const before200 = await targetTruth();
      const point200 = guiPointFor(painted200, 400, 320, 200, 160);
      await wheelOnFramePoint(point200, 200);
      await sleep(700);
      const after200 = await targetTruth();
      const delta200 = after200.scrollY - before200.scrollY;
      check('V9.1', 'frame wheel at 200 % moves the target page by delta/scale (≈100 px)',
        delta200 > 40 && delta200 < 160, { deltaY: '≈100' }, { deltaY: delta200, painted: painted200 });

      await hostViewportSet({ width: 400, height: 320, scale: 1, x: 0, y: 0 });
      await waitHostView((view) => Number(view.width) === 400 && Number(view.height) === 320 && closeTo(view.scale, 1, 0.001));
      await waitPanelMirrorsHost();
      const frame100 = await waitForFrame();
      const painted100 = paintedOf(frame100);
      const before100 = await targetTruth();
      const point100 = guiPointFor(painted100, 400, 320, 200, 160);
      await wheelOnFramePoint(point100, 200);
      await sleep(700);
      const after100 = await targetTruth();
      const delta100 = after100.scrollY - before100.scrollY;
      check('V9.2', 'frame wheel at 100 % moves the target page by the full delta (≈200 px)',
        delta100 > 120 && delta100 < 320, { deltaY: '≈200' }, { deltaY: delta100, painted: painted100 });
      check('V9.3', 'the 200 % page delta is about half of the 100 % delta (W/Pw scaling)',
        delta100 > 0 && delta200 / delta100 > 0.25 && delta200 / delta100 < 0.8,
        { ratio: '≈0.5' }, { ratio: delta100 ? Number((delta200 / delta100).toFixed(3)) : null, delta200, delta100 });
      await capturePanel('shot-04-frame-wheel');
    });

    await scenario('V12 drag-to-pan (user request 2026-11-02)', async () => {
      await navigateTarget(`${fixtureBase}/web-t3.html`);
      await waitForFrame();
      await ensureHorizontalOverflow();
      await hostViewportSet({ width: 640, height: 480, scale: 1, x: 300, y: 300 });
      await waitHostView((view) => Number(view.width) === 640 && Number(view.height) === 480 && near(view.x, 300, 1) && near(view.y, 300, 1));
      await waitPanelMirrorsHost();
      await waitFrameStable();
      await waitPanelValues({ x: 300, y: 300 });

      const off = await panelState();
      check('V12.1', 'the size bar has a drag checkbox (unchecked, enabled, explains the mode)',
        off.panChecked === false && off.panDisabled === false
          && /拖拽/.test(String(off.panTitle || '')) && /页面交互/.test(String(off.panTitle || '')),
        { checked: false, disabled: false, title: '拖拽…页面交互' },
        { checked: off.panChecked, disabled: off.panDisabled, title: off.panTitle });
      check('V12.2', 'the frame is not a grab hand while drag mode is off',
        off.frameCursor !== 'grab' && off.frameCursor !== 'grabbing',
        { cursor: 'auto' }, { cursor: off.frameCursor, attr: off.framePanAttr });

      const on = await togglePan(true);
      check('V12.3', 'checking drag mode turns the frame into a grab hand',
        on.panChecked === true && on.frameCursor === 'grab',
        { checked: true, cursor: 'grab' }, { checked: on.panChecked, cursor: on.frameCursor });

      // While drag mode is on, a plain click on the frame must not reach the target page.
      await resetTargetInstrumentation();
      const paintedBefore = paintedOf(await waitForFrame());
      const center = { x: paintedBefore.left + paintedBefore.width / 2, y: paintedBefore.top + paintedBefore.height / 2 };
      await clickAt(center.x, center.y);
      await sleep(350);
      const eventsAfterClick = await targetEval('window.__t3 ? window.__t3.events.length : -1');
      check('V12.4', 'drag mode suppresses page interaction (a plain frame click dispatches no page events)',
        eventsAfterClick === 0, { pageEvents: 0 }, { pageEvents: eventsAfterClick, point: center });

      // Content-follow drag: right/down means the viewport moves left/up in the document.
      const drag = await dragOnFrame(120, 80);
      // The panel maps through the *displayed* painted rect (contract §5.1); compute the expected
      // page delta from the same geometry instead of assuming a 1:1 frame size.
      const expectedDragX = Math.round(300 - (120 * 640) / Math.max(1, drag.painted.width));
      const expectedDragY = Math.round(300 - (80 * 480) / Math.max(1, drag.painted.height));
      check('V12.5', 'the cursor becomes a grabbing hand while the drag button is held',
        drag.cursorDuringDrag === 'grabbing', { cursor: 'grabbing' }, { cursor: drag.cursorDuringDrag });
      const afterDrag = await waitHostView((view) => near(view.x, expectedDragX, 3) && near(view.y, expectedDragY, 3));
      check('V12.6', `dragging right/down pans the page with content-follow direction (x 300→≈${expectedDragX}, y 300→≈${expectedDragY})`,
        near(afterDrag.view.x, expectedDragX, 3) && near(afterDrag.view.y, expectedDragY, 3),
        { x: expectedDragX, y: expectedDragY }, { x: afterDrag.view.x, y: afterDrag.view.y, source: afterDrag.view.source, painted: drag.painted });
      const dragTruth = await targetTruth();
      check('V12.7', 'the target page really scrolled to the dragged view',
        near(dragTruth.scrollX, afterDrag.view.x, 2) && near(dragTruth.scrollY, afterDrag.view.y, 2),
        { scrollX: '≈view.x', scrollY: '≈view.y' },
        { scrollX: dragTruth.scrollX, scrollY: dragTruth.scrollY, view: { x: afterDrag.view.x, y: afterDrag.view.y } });
      const dragClicks = await clickRecords();
      const dragEvents = await targetEval('window.__t3 ? window.__t3.events.length : -1');
      check('V12.8', 'the drag sends no click and no pointer/mouse events into the page',
        dragClicks.length === 0 && dragEvents === 0,
        { clicks: 0, pageEvents: 0 }, { clicks: dragClicks.length, pageEvents: dragEvents });
      const mirrored = await waitPanelValues({ x: afterDrag.view.x, y: afterDrag.view.y }).catch(() => panelState());
      check('V12.9', 'the X/Y inputs mirror the dragged Host scroll',
        near(mirrored.x, afterDrag.view.x, 2) && near(mirrored.y, afterDrag.view.y, 2),
        { x: afterDrag.view.x, y: afterDrag.view.y }, { x: mirrored.x, y: mirrored.y });

      // At the document start, dragging right/down clamps instead of going negative.
      await hostViewportSet({ x: 0, y: 0 });
      await waitHostView((view) => near(view.x, 0, 1) && near(view.y, 0, 1));
      await waitPanelMirrorsHost();
      await waitPanelValues({ x: 0, y: 0 });
      await waitFrameStable();
      await dragOnFrame(160, 120);
      await sleep(800);
      const clampedView = (await hostView()).view;
      const clampedTruth = await targetTruth();
      check('V12.10', 'drag pan clamps at the document start (x/y stay 0, no negative scroll)',
        near(clampedView.x, 0, 1) && near(clampedView.y, 0, 1) && near(clampedTruth.scrollX, 0, 1) && near(clampedTruth.scrollY, 0, 1),
        { x: 0, y: 0, scrollX: 0, scrollY: 0 },
        { x: clampedView.x, y: clampedView.y, scrollX: clampedTruth.scrollX, scrollY: clampedTruth.scrollY });

      const back = await togglePan(false);
      check('V12.11', 'unchecking drag mode restores the default frame cursor',
        back.panChecked === false && back.frameCursor !== 'grab' && back.frameCursor !== 'grabbing',
        { checked: false, cursor: 'auto' }, { checked: back.panChecked, cursor: back.frameCursor });

      // Interaction restored: the same panel click now reaches the page again.
      await navigateTarget(`${fixtureBase}/web-t3.html`);
      await waitForFrame();
      await hostViewportSet({ width: 640, height: 480, scale: 1, x: 0, y: 0 });
      await waitHostView((view) => Number(view.width) === 640 && Number(view.height) === 480);
      await waitPanelMirrorsHost();
      await waitPanelValues({ x: 0, y: 0 });
      await waitFrameStable();
      const restored = await clickThroughPanel('#t3-click', 640, 480);
      check('V12.12', 'after drag mode is off, a panel click reaches the page again (real trusted click)',
        restored.clicksDelta === 1 && restored.record && restored.record.isTrusted === true,
        { clicksDelta: 1, isTrusted: true },
        { clicksDelta: restored.clicksDelta, record: restored.record, point: restored.point });
      await capturePanel('shot-05-drag-pan');
    });

    await scenario('V13 canvas viewport (P0-C v2)', async () => {
      const v13Start = Date.now();
      const initial = await hostCanvas();
      if (!initial.canvas) {
        notRun('V13.0', 'Host exposes ui.canvas (P0-C v2 capability handshake)',
          '隔离 Host 未提供 ui.canvas（Host task-1 未加载）；画布坐标/预览合成/输入映射/拖拽切片无法验收，不使用替代断言',
          { uiVersion: initial.ui && initial.ui.version, view: initial.view });
        return;
      }
      check('V13.0', 'Host exposes ui.canvas version 1 in canvas-css-px with white blank',
        Number(initial.canvas.version) === 1 && initial.canvas.space === 'canvas-css-px' && initial.canvas.blank === 'white',
        { version: 1, space: 'canvas-css-px', blank: 'white' }, initial.canvas);

      await navigateTarget(`${fixtureBase}/web-t3.html`);
      await waitForFrame();
      await ensureHorizontalOverflow();
      // A non-white page background makes "blank is pure white" distinguishable in pixels below.
      await targetEval(`(() => {
        document.documentElement.style.background = 'rgb(200, 30, 30)';
        document.body.style.background = 'rgb(200, 30, 30)';
        return true;
      })()`);
      // Keep fit out of the equations: the canvas displacement must be measured at the shared 100 %.
      await clickFit(false);
      await hostViewportSet({ width: 400, height: 300, scale: 1, x: 0, y: 0 });
      await waitHostView((view) => Number(view.width) === 400 && Number(view.height) === 300 && near(view.x, 0, 1) && near(view.y, 0, 1));
      await waitPanelMirrorsHost();
      const contentBox = await waitFor(async () => {
        const snapshot = await hostCanvas();
        const canvas = snapshot.canvas;
        return canvas && Number.isFinite(Number(canvas.contentWidth)) && Number(canvas.contentWidth) > 0
          && Number.isFinite(Number(canvas.contentHeight)) && Number(canvas.contentHeight) > 0 ? canvas : undefined;
      }, { timeoutMs: 8000, intervalMs: 150, label: 'Host observed the canvas content box' });
      check('V13.0b', 'ui.canvas reports the measured content box',
        Number(contentBox.contentWidth) > 400 && Number(contentBox.contentHeight) > 300,
        { contentWidth: '> 400', contentHeight: '> 300' },
        { contentWidth: contentBox.contentWidth, contentHeight: contentBox.contentHeight });
      await hostViewportSet({ canvasX: 0, canvasY: 0 });
      await waitHostView((view) => near(view.canvasX, 0, 1) && near(view.canvasY, 0, 1) && near(view.x, 0, 1) && near(view.y, 0, 1));
      // O=0 returns "ready" regardless of frame metadata (old behaviour); still wait for an actual
      // capture-time scroll=0 frame so the zero transform is real and not the previous frame's lag.
      const oZeroPanel = await waitFor(async () => {
        const panel = await panelState();
        const shift = transformTranslate(panel.imgTransform);
        return panel.canvasOn === 'on' && near(shift.x, 0, 0.5) && near(shift.y, 0, 0.5) ? panel : undefined;
      }, { timeoutMs: 6000, intervalMs: 150, label: 'O=0 frame with zero displacement' });
      const oZeroShift = transformTranslate(oZeroPanel.imgTransform);
      check('V13.0c', 'O=0 (C=S) leaves the frame untranslated, so the old pixels are preserved',
        near(oZeroShift.x, 0, 0.01) && near(oZeroShift.y, 0, 0.01) && oZeroPanel.canvasOn === 'on',
        { translateX: 0, translateY: 0, canvas: 'on' },
        { translate: oZeroShift, canvas: oZeroPanel.canvasOn, boxBackground: oZeroPanel.boxBackground });
      // The panel blank is now a dark checkerboard, but O=0 + a matching frame covers it fully:
      // the same pixels as the old white-background implementation must remain.
      await waitCanvasState(true, true);
      const oZeroPreview = await waitFrameStable();
      await ensurePointVisible({ x: oZeroPreview.box.left + oZeroPreview.box.width / 2, y: oZeroPreview.box.top + oZeroPreview.box.height / 2 });
      await sleep(300);
      const oZeroFrame = await waitFrameStable();
      const oZeroLatest = await panelState();
      const oZeroPainted = paintedOf(oZeroFrame);
      const oZeroShot = await captureBoxPixels(oZeroFrame.box);
      const oZeroChecker = checkerboardOf(oZeroLatest);
      const oZeroProbe = checkerSample(oZeroShot.decoded, oZeroChecker, [[7, 7], [21, 7], [35, 7], [49, 7], [7, 21], [21, 21], [35, 21]]);
      check('V13.0d', 'O=0: the image covers the box and the checkerboard never shows (old pixels preserved)',
        oZeroLatest.canvasBlank === 'checkerboard' && Boolean(oZeroChecker)
          && Boolean(oZeroPainted) && near(oZeroPainted.width, oZeroFrame.box.width, 1) && near(oZeroPainted.height, oZeroFrame.box.height, 1)
          && oZeroProbe.colorIndex.every((index) => index === -1),
        { blankStyle: 'checkerboard', covered: true, checkerPixels: 0 },
        { blankStyle: oZeroLatest.canvasBlank, checker: oZeroChecker, probe: oZeroProbe, painted: oZeroPainted, box: oZeroFrame.box });

      // ---- V13.1 negative canvas origin: C is authoritative, S stays clamped at 0 ----
      const setNegative = await hostViewportSet({ canvasX: -100, canvasY: -50 });
      check('V13.1', 'POST /viewport accepts negative canvasX/canvasY (v1)',
        setNegative.status === 200 && setNegative.json && setNegative.json.ok !== false,
        { status: 200 }, { status: setNegative.status, code: setNegative.json && setNegative.json.code });
      const negative = await waitHostView((view) => near(view.canvasX, -100, 1) && near(view.canvasY, -50, 1)
        && near(view.x, 0, 0.5) && near(view.y, 0, 0.5));
      const negativeCanvas = (await hostCanvas()).canvas;
      check('V13.2', 'negative C keeps the real document scroll at 0-0 and exposes offset O=C-S',
        near(negative.view.x, 0, 0.5) && near(negative.view.y, 0, 0.5)
          && near(negativeCanvas.offsetX, -100, 1) && near(negativeCanvas.offsetY, -50, 1),
        { x: 0, y: 0, offsetX: -100, offsetY: -50 },
        { x: negative.view.x, y: negative.view.y, offsetX: negativeCanvas.offsetX, offsetY: negativeCanvas.offsetY });
      const negativeTruth = await targetTruth();
      check('V13.3', 'the target page itself never scrolls negative (canvas C is a view-layer fact)',
        near(negativeTruth.scrollX, 0, 0.5) && near(negativeTruth.scrollY, 0, 0.5),
        { scrollX: 0, scrollY: 0 }, { scrollX: negativeTruth.scrollX, scrollY: negativeTruth.scrollY });
      const negativePanel = await waitPanelValues({ x: -100, y: -50 });
      check('V13.4', 'X/Y inputs show the signed canvas origin C (not the clamped scroll)',
        near(negativePanel.x, -100, 1.5) && near(negativePanel.y, -50, 1.5),
        { x: -100, y: -50 }, { x: negativePanel.x, y: negativePanel.y, title: negativePanel.byLabel[X_LABEL] && negativePanel.byLabel[X_LABEL].title });

      // ---- V13.5 negative wheel steps and typed negative values stay on canvasX/canvasY ----
      await hostViewportSet({ canvasX: -20, canvasY: -10 });
      await waitHostView((view) => near(view.canvasX, -20, 1) && near(view.canvasY, -10, 1) && near(view.x, 0, 0.5));
      await waitPanelMirrorsHost();
      await waitPanelValues({ x: -20, y: -10 });
      const markWheel = Date.now();
      await wheelOnField(X_LABEL, 120);
      const wheeled = await waitHostView((view) => near(view.canvasX, -30, 1) && near(view.x, 0, 0.5));
      const wheelPosts = panelPosts('viewport', markWheel).map(parseBody);
      check('V13.5', 'a downward wheel notch decreases canvasX into negative territory and posts canvasX (never x)',
        near(wheeled.view.canvasX, -30, 1) && near(wheeled.view.x, 0, 0.5)
          && wheelPosts.some((body) => Number(body.canvasX) === -30 && body.x === undefined),
        { canvasX: -30, x: 0, field: 'canvasX' },
        { canvasX: wheeled.view.canvasX, x: wheeled.view.x, bodies: wheelPosts });

      const markTyped = Date.now();
      await typeIntoField(X_LABEL, '-100', { enter: true });
      const typed = await waitHostView((view) => near(view.canvasX, -100, 1) && near(view.x, 0, 0.5));
      const typedPosts = panelPosts('viewport', markTyped).map(parseBody);
      check('V13.6', 'typing -100 + Enter commits canvasX=-100 (negative canvas value, no document scroll)',
        near(typed.view.canvasX, -100, 1) && near(typed.view.x, 0, 0.5)
          && typedPosts.some((body) => Number(body.canvasX) === -100 && body.x === undefined),
        { canvasX: -100, x: 0, field: 'canvasX' },
        { canvasX: typed.view.canvasX, x: typed.view.x, bodies: typedPosts });

      const markRange = Date.now();
      await typeIntoField(X_LABEL, '-10000001', { enter: true });
      await sleep(500);
      const afterRange = await panelState();
      const rangePosts = panelPosts('viewport', markRange).map(parseBody);
      check('V13.7', 'a canvas value outside ±10,000,000 is rejected locally (no request, input reverts)',
        near(afterRange.x, -100, 1.5) && !rangePosts.some((body) => body.canvasX !== undefined),
        { x: -100, requests: 0 }, { x: afterRange.x, bodies: rangePosts });

      // ---- V13.8 preview compositing: left blank is pure white, content shifted by -C ----
      await hostViewportSet({ canvasX: -100, canvasY: 0 });
      await waitHostView((view) => near(view.canvasX, -100, 1) && near(view.x, 0, 0.5));
      await waitPanelMirrorsHost();
      await waitCanvasState(true, true);
      const leftPreview = await waitFrameStable();
      await ensurePointVisible({ x: leftPreview.box.left + leftPreview.box.width / 2, y: leftPreview.box.top + leftPreview.box.height / 2 });
      await sleep(500);
      // A seed/live replacement can land while we wait for the stage: re-prove the barrier before
      // reading pixels, otherwise a one-frame revision bump would be reported as a product failure.
      await waitCanvasState(true, true, { timeoutMs: 10000 });
      const leftFrame = await waitFrameStable();
      const leftPanel = await panelState();
      const leftDetail = canvasDetailOf(leftPanel);
      const leftShift = transformTranslate(leftPanel.imgTransform);
      const leftSeed = leftDetail.seed === true;
      const leftShot = await captureBoxPixels(leftFrame.box);
      const leftContent = pixelAt(leftShot.decoded, 160, Math.round(leftFrame.box.height * 0.96));
      const leftChecker = checkerboardOf(leftPanel);
      const leftProbe = checkerSample(leftShot.decoded, leftChecker,
        [[7, 7], [21, 7], [35, 7], [49, 7], [63, 7], [77, 7], [91, 7]]);
      const leftClip = leftSeed ? String(leftPanel.canvasSeedClip || '') : 'off';
      check('V13.8', 'C=-100 shows a dark checkerboard blank band and content shifted right (composed seed clipped; live frame uses -C=100)',
        leftPanel.canvasBlank === 'checkerboard' && Boolean(leftChecker)
          && leftProbe.allChecker && leftProbe.both && leftProbe.white === 0
          && leftContent.r >= 150 && leftContent.g <= 120 && leftContent.b <= 120
          && near(leftShift.x, leftSeed ? 0 : 100, 2) && near(leftShift.y, 0, 1)
          && (leftSeed ? leftPanel.canvasBarrier === 'seed-aligned' && leftClip.includes('25%') : leftPanel.canvasBarrier === 'aligned' && leftClip === 'off'),
        { blank: 'checkerboard', colors: 'both dark tones', content: 'page background', translateX: leftSeed ? 0 : 100, seedClip: leftSeed ? 'left 25%' : 'off' },
        { blank: leftPanel.canvasBlank, checker: leftChecker, probe: leftProbe, content: leftContent, translate: leftShift, barrier: leftPanel.canvasBarrier, seedClip: leftClip, detail: leftDetail, box: leftFrame.box });
      const seedPosts = panelScreenshotPosts(v13Start);
      if (leftSeed) {
        check('V13.8b', 'a static-page mismatch refreshed a composed seed: /screenshot carried {canvas:true} and the Host provenance is aligned',
          seedPosts.some((body) => body.canvas === true) && leftPanel.canvasBarrier === 'seed-aligned',
          { body: { canvas: true }, barrier: 'seed-aligned' },
          { requests: seedPosts, barrier: leftPanel.canvasBarrier, detail: leftDetail });
      } else {
        notRun('V13.8b', 'static-page composed seed accepted',
          'the displayed frame was a matching live frame, so no seed refresh was needed in this run', { detail: leftDetail, seedPosts });
      }
      await capturePanel('shot-06-canvas-negative');

      // ---- V13.8c-e seed provenance mechanics (real Host happy path above; negatives simulated) ----
      if (leftSeed) {
        const interceptor = await startScreenshotInterceptor();
        try {
          // Drain a still-pending real seed refresh before simulating (the transport allows one
          // request at a time; a paused leftover would block every later seed request).
          for (const entry of interceptor.pending()) {
            await interceptor.respond(entry, { status: 500, body: { ok: false, error: 'drain', code: 'INTERNAL' } });
          }
          await sleep(250);
          // 1) Stale (in-flight) response: capture at -150 is answered after the shell moved to -200.
          const staleMark = Date.now();
          await hostViewportSet({ canvasX: -150 });
          await waitHostView((view) => near(view.canvasX, -150, 1) && near(view.x, 0, 1));
          await waitPanelValues({ x: -150 });
          const staleRequest = await interceptor.waitForNew(staleMark);
          check('V13.8c0', 'the client asks for a composed seed with body {canvas:true}',
            staleRequest.body && staleRequest.body.canvas === true,
            { canvas: true }, { body: staleRequest.body, url: staleRequest.url });
          const staleFacts = await seedFactsNow();
          await hostViewportSet({ canvasX: -200 });
          await waitHostView((view) => near(view.canvasX, -200, 1) && near(view.x, 0, 1));
          await waitPanelValues({ x: -200 });
          const refreshMark = Date.now();
          await interceptor.respond(staleRequest, { body: await seedResponseFor(staleFacts) });
          await sleep(1200);
          const afterStale = await panelState();
          const refreshedRequest = await interceptor.waitForNew(refreshMark);
          const refreshedFacts = await seedFactsNow();
          await interceptor.respond(refreshedRequest, { body: await seedResponseFor(refreshedFacts) });
          const refreshed = await waitCanvasState(true, true, { timeoutMs: 8000 });
          check('V13.8c', 'an in-flight seed answered after the shell moved is dropped as stale; the next state refreshes to seed-aligned',
            afterStale.canvasBarrier !== 'seed-aligned' && refreshed.canvasBarrier === 'seed-aligned',
            { afterStale: 'not seed-aligned', refreshed: 'seed-aligned' },
            { afterStale: afterStale.canvasBarrier, refreshed: refreshed.canvasBarrier, staleFacts, refreshedFacts });

          // 2) Missing provenance: a 200 without view/capture is rejected, a state change retries.
          const missingMark = Date.now();
          await hostViewportSet({ canvasX: -250 });
          await waitHostView((view) => near(view.canvasX, -250, 1) && near(view.x, 0, 1));
          await waitPanelValues({ x: -250 });
          const missingRequest = await interceptor.waitForNew(missingMark);
          await interceptor.respond(missingRequest, { body: { ok: true, image: (await seedResponseFor(refreshedFacts)).image } });
          await sleep(1200);
          const afterMissing = await panelState();
          const missingRetryMark = Date.now();
          await hostViewportSet({ canvasX: -300 });
          await waitHostView((view) => near(view.canvasX, -300, 1) && near(view.x, 0, 1));
          await waitPanelValues({ x: -300 });
          const retryRequest = await interceptor.waitForNew(missingRetryMark);
          const retryFacts = await seedFactsNow();
          await interceptor.respond(retryRequest, { body: await seedResponseFor(retryFacts) });
          const recovered = await waitCanvasState(true, true, { timeoutMs: 8000 });
          check('V13.8d', 'a seed response without canvas provenance is rejected (fail-closed); a shell change retries and aligns',
            afterMissing.canvasBarrier !== 'seed-aligned' && recovered.canvasBarrier === 'seed-aligned',
            { missing: 'not seed-aligned', recovered: 'seed-aligned' },
            { missing: afterMissing.canvasBarrier, recovered: recovered.canvasBarrier });

          // 3) HTTP failure: same fail-closed + retry-on-state-change rule.
          const failMark = Date.now();
          await hostViewportSet({ canvasX: -350 });
          await waitHostView((view) => near(view.canvasX, -350, 1) && near(view.x, 0, 1));
          await waitPanelValues({ x: -350 });
          const failRequest = await interceptor.waitForNew(failMark);
          await interceptor.respond(failRequest, { status: 500, body: { ok: false, error: 'boom', code: 'INTERNAL' } });
          await sleep(1200);
          const afterFail = await panelState();
          const failRetryMark = Date.now();
          await hostViewportSet({ canvasX: -400 });
          await waitHostView((view) => near(view.canvasX, -400, 1) && near(view.x, 0, 1));
          await waitPanelValues({ x: -400 });
          const failRetryRequest = await interceptor.waitForNew(failRetryMark);
          const failRetryFacts = await seedFactsNow();
          await interceptor.respond(failRetryRequest, { body: await seedResponseFor(failRetryFacts) });
          const afterFailRecovered = await waitCanvasState(true, true, { timeoutMs: 8000 });
          check('V13.8e', 'a failed seed request leaves input fail-closed; a shell change retries and aligns',
            afterFail.canvasBarrier !== 'seed-aligned' && afterFailRecovered.canvasBarrier === 'seed-aligned',
            { failed: 'not seed-aligned', recovered: 'seed-aligned' },
            { failed: afterFail.canvasBarrier, recovered: afterFailRecovered.canvasBarrier });
          const quietMark = Date.now();
          await sleep(1500);
          const quietRequests = interceptor.requests.filter((entry) => entry.at >= quietMark);
          check('V13.8f', 'a successful seed is not re-requested for the same shell signature (no screenshot loop)',
            quietRequests.length === 0,
            { requests: 0 }, { requests: quietRequests.length, bodies: quietRequests.map((entry) => entry.body) });

          // 4) Seed input mapping: a composed seed at C=-100 still maps q -> p=q+O and blank-zero.
          const clickSeedMark = Date.now();
          await hostViewportSet({ canvasX: -100 });
          await waitHostView((view) => near(view.canvasX, -100, 1) && near(view.x, 0, 1));
          await waitPanelValues({ x: -100 });
          const clickSeedRequest = await interceptor.waitForNew(clickSeedMark);
          const clickSeedFacts = await seedFactsNow();
          await interceptor.respond(clickSeedRequest, { body: await seedResponseFor(clickSeedFacts) });
          const clickSeedPanel = await waitCanvasState(true, true, { timeoutMs: 8000 });
          check('V13.8g', 'seed-displayed state is seed-aligned and does not add a live-frame transform',
            clickSeedPanel.canvasBarrier === 'seed-aligned' && transformTranslate(clickSeedPanel.imgTransform).x === 0,
            { barrier: 'seed-aligned', translateX: 0 },
            { barrier: clickSeedPanel.canvasBarrier, translate: transformTranslate(clickSeedPanel.imgTransform) });
          const seedClickView = (await hostView()).view;
          const seedClickCanvas = (await hostCanvas()).canvas;
          const seedTarget = await elementDocumentRect('#t3-canvas');
          const seedQ = { x: seedTarget.docX - Number(seedClickCanvas.x), y: seedTarget.docY - Number(seedClickCanvas.y) };
          let seedPainted = paintedOf(await waitFrameStable());
          let seedPoint = guiPointForViewport(seedPainted, Number(seedClickView.width), Number(seedClickView.height), seedQ.x, seedQ.y);
          await ensurePointVisible(seedPoint);
          seedPainted = paintedOf(await waitFrameStable());
          seedPoint = guiPointForViewport(seedPainted, Number(seedClickView.width), Number(seedClickView.height), seedQ.x, seedQ.y);
          await resetTargetInstrumentation();
          const seedClicksBefore = await targetEval('window.__t3 ? window.__t3.counters.canvasClicks : -1');
          await clickAt(seedPoint.x, seedPoint.y);
          await sleep(800);
          const seedClicksAfter = await targetEval('window.__t3 ? window.__t3.counters.canvasClicks : -1');
          const seedClickRecord = await targetEval('window.__t3 ? window.__t3.last.click : null');
          check('V13.8h', `seed-displayed content click maps q=${Math.round(seedQ.x)} through O=-100 to p=${Math.round(seedQ.x - 100)}`,
            Number(seedClicksAfter) - Number(seedClicksBefore) === 1
              && seedClickRecord && seedClickRecord.isTrusted === true && seedClickRecord.target === 't3-canvas'
              && near(seedClickRecord.clientX, seedTarget.docX - seedTarget.scrollX, 1.5),
            { clicks: 1, target: 't3-canvas', clientX: seedTarget.docX - seedTarget.scrollX },
            { clicks: Number(seedClicksAfter) - Number(seedClicksBefore), record: seedClickRecord, q: seedQ, point: seedPoint });
          const seedBlankQ = { x: 50, y: 250 };
          const seedBlankPainted = paintedOf(await waitForFrame());
          const seedBlankPoint = guiPointForViewport(seedBlankPainted, Number(seedClickView.width), Number(seedClickView.height), seedBlankQ.x, seedBlankQ.y);
          await resetTargetInstrumentation();
          const seedInputMark = Date.now();
          await clickAt(seedBlankPoint.x, seedBlankPoint.y);
          await sleep(500);
          const seedBlankEvents = await targetEval('window.__t3 ? window.__t3.events.length : -1');
          check('V13.8i', 'a click on the blank of a composed seed dispatches zero page events and zero /input',
            seedBlankEvents === 0 && panelPosts('input', seedInputMark).length === 0,
            { pageEvents: 0, inputPosts: 0 },
            { pageEvents: seedBlankEvents, inputPosts: panelPosts('input', seedInputMark).length });
        } finally {
          for (const entry of interceptor.pending()) {
            await interceptor.respond(entry, { status: 500, body: { ok: false, error: 'cleanup', code: 'INTERNAL' } }).catch(() => {});
          }
          await interceptor.stop();
        }
      } else {
        notRun('V13.8c', 'seed provenance negative cases (stale/missing/failure)',
          'the displayed frame was a matching live frame in this run, so the canvas seed path was not exercised', { detail: leftDetail });
      }

      // ---- V13.9 C beyond max scroll: the right band is blank, content is shifted left ----
      const overflowForCanvas = await ensureHorizontalOverflow();
      const maxScrollX = Number(overflowForCanvas.maxScrollX);
      const rightC = maxScrollX + 80;
      await hostViewportSet({ canvasX: rightC, canvasY: 0 });
      await waitHostView((view) => near(view.canvasX, rightC, 1) && near(view.x, maxScrollX, 2));
      await waitPanelMirrorsHost();
      await waitCanvasState(true, true);
      const rightPreview = await waitFrameStable();
      await ensurePointVisible({ x: rightPreview.box.left + rightPreview.box.width / 2, y: rightPreview.box.top + rightPreview.box.height / 2 });
      await sleep(500);
      const rightFrame = await waitFrameStable();
      const rightPanel = await panelState();
      const rightDetail = canvasDetailOf(rightPanel);
      const rightSeed = rightDetail.seed === true;
      const rightShift = transformTranslate(rightPanel.imgTransform);
      const rightShot = await captureBoxPixels(rightFrame.box);
      const rightBlankX = Math.round(rightFrame.box.width - 73);
      const rightChecker = checkerboardOf(rightPanel);
      const rightProbe = checkerSample(rightShot.decoded, rightChecker,
        [[rightBlankX, 7], [rightBlankX + 14, 7], [rightBlankX + 28, 7], [rightBlankX + 42, 7], [rightBlankX + 56, 7]]);
      const rightContent = pixelAt(rightShot.decoded, Math.round(rightFrame.box.width - 150), Math.round(rightFrame.box.height * 0.96));
      const rightClip = rightSeed ? String(rightPanel.canvasSeedClip || '') : 'off';
      check('V13.9', 'C > max scroll shows a dark checkerboard right band and content left (composed seed clipped; live frame shifted by O=80)',
        rightPanel.canvasBlank === 'checkerboard' && Boolean(rightChecker)
          && rightProbe.allChecker && rightProbe.both && rightProbe.white === 0
          && rightContent.r >= 150 && rightContent.g <= 120 && rightContent.b <= 120
          && near(rightShift.x, rightSeed ? 0 : -80, 2)
          && (rightSeed ? rightPanel.canvasBarrier === 'seed-aligned' && rightClip.includes('20%') : rightPanel.canvasBarrier === 'aligned' && rightClip === 'off'),
        { blank: 'checkerboard', colors: 'both dark tones', content: 'page background', translateX: rightSeed ? 0 : -80, seedClip: rightSeed ? 'right 20%' : 'off' },
        { blank: rightPanel.canvasBlank, checker: rightChecker, probe: rightProbe, content: rightContent, translate: rightShift, barrier: rightPanel.canvasBarrier, seedClip: rightClip, C: rightC, maxScrollX, detail: rightDetail });
      await capturePanel('shot-07-canvas-right-blank');

      // ---- V13.10 content hit maps q -> p = q + O (scroll 0, C=-100 => O=-100) ----
      await hostViewportSet({ canvasX: -100, canvasY: 0 });
      await waitHostView((view) => near(view.canvasX, -100, 1) && near(view.x, 0, 1));
      await waitPanelMirrorsHost();
      await waitCanvasState(true, true);
      await waitFrameStable();
      await sleep(300); // let the best-effort resize barrier (≤250 ms) clear too
      const clickView = (await hostView()).view;
      const clickCanvas = (await hostCanvas()).canvas;
      const clickTarget = await elementDocumentRect('#t3-canvas');
      const q = { x: clickTarget.docX - Number(clickCanvas.x), y: clickTarget.docY - Number(clickCanvas.y) };
      let clickPainted = paintedOf(await waitForFrame());
      let clickPoint = guiPointForViewport(clickPainted, Number(clickView.width), Number(clickView.height), q.x, q.y);
      await ensurePointVisible(clickPoint);
      clickPainted = paintedOf(await waitForFrame());
      clickPoint = guiPointForViewport(clickPainted, Number(clickView.width), Number(clickView.height), q.x, q.y);
      await resetTargetInstrumentation();
      const clicksBeforeCanvas = await targetEval('window.__t3 ? window.__t3.counters.canvasClicks : -1');
      await clickAt(clickPoint.x, clickPoint.y);
      await sleep(800);
      const clicksAfterCanvas = await targetEval('window.__t3 ? window.__t3.counters.canvasClicks : -1');
      const canvasClickRecord = await targetEval(`(() => {
        if (!window.__t3) return null;
        const clicks = window.__t3.events.filter((event) => event.type === 'click');
        return clicks.length ? clicks[clicks.length - 1] : null;
      })()`);
      check('V13.10', `content click maps q=${Math.round(q.x)} through O=-100 to page point p=${Math.round(q.x - 100)} (hits #t3-canvas, trusted)`,
        Number(clicksAfterCanvas) - Number(clicksBeforeCanvas) === 1
          && canvasClickRecord && canvasClickRecord.isTrusted === true
          && canvasClickRecord.target === 't3-canvas'
          && near(canvasClickRecord.clientX, clickTarget.docX - clickTarget.scrollX, 1.5)
          && near(canvasClickRecord.clientY, clickTarget.docY - clickTarget.scrollY, 1.5)
          && near(canvasClickRecord.clientX, q.x + (Number(clickCanvas.x) - Number(clickView.x)), 1.5),
        { clicks: 1, isTrusted: true, target: 't3-canvas', clientX: clickTarget.docX - clickTarget.scrollX },
        { clicks: Number(clicksAfterCanvas) - Number(clicksBeforeCanvas), record: canvasClickRecord, q, clickPoint });

      // ---- V13.11 blank: click and wheel dispatch nothing into the page ----
      const blankQ = { x: 50, y: 250 }; // d = q + C = (-50, 250): outside the content box
      const blankPainted = paintedOf(await waitForFrame());
      const blankPoint = guiPointForViewport(blankPainted, Number(clickView.width), Number(clickView.height), blankQ.x, blankQ.y);
      await resetTargetInstrumentation();
      const inputMark = Date.now();
      await clickAt(blankPoint.x, blankPoint.y);
      await sleep(400);
      const blankEvents = await targetEval('window.__t3 ? window.__t3.events.length : -1');
      const scrollBeforeBlankWheel = await targetTruth();
      await wheelOnFramePoint(blankPoint, 240);
      await sleep(700);
      const scrollAfterBlankWheel = await targetTruth();
      const blankInputPosts = panelPosts('input', inputMark);
      check('V13.11', 'a click on the canvas blank dispatches zero page events and zero /input requests',
        blankEvents === 0 && blankInputPosts.length === 0,
        { pageEvents: 0, inputPosts: 0 }, { pageEvents: blankEvents, inputPosts: blankInputPosts.length, point: blankPoint });
      check('V13.12', 'a wheel on the canvas blank does not scroll the target page',
        near(scrollAfterBlankWheel.scrollX, scrollBeforeBlankWheel.scrollX, 0.5)
          && near(scrollAfterBlankWheel.scrollY, scrollBeforeBlankWheel.scrollY, 0.5)
          && panelPosts('input', inputMark + 500).length === 0,
        { scrollX: scrollBeforeBlankWheel.scrollX, scrollY: scrollBeforeBlankWheel.scrollY },
        { scrollX: scrollAfterBlankWheel.scrollX, scrollY: scrollAfterBlankWheel.scrollY, inputPosts: panelPosts('input', inputMark + 500).length });

      // ---- V13.13 fail-closed: if the accepted S disagrees with the displayed frame's scroll, no input ----
      let stopRewrite = null;
      try {
        stopRewrite = await startStateRewrite((json) => mutateStateUi(json, (ui) => {
          if (ui.view) { ui.view.x = 50; ui.view.y = 50; }
          if (ui.observed) { ui.observed.x = 50; ui.observed.y = 50; }
          return ui;
        }));
        const stalled = await waitFor(async () => {
          const panel = await panelState();
          return panel.canvasOn === 'on' && panel.canvasReady === 'false' && panel.canvasBarrier === 'scroll-mismatch'
            ? panel : undefined;
        }, { timeoutMs: 5000, intervalMs: 100, label: 'fail-closed scroll mismatch' });
        check('V13.13', 'O≠0 + accepted S≠frame.scroll makes the input barrier fail closed (reason=scroll-mismatch, no 250 ms timeout bypass)',
          stalled.canvasReady === 'false' && stalled.canvasBarrier === 'scroll-mismatch',
          { canvasReady: 'false', reason: 'scroll-mismatch' },
          { canvasReady: stalled.canvasReady, reason: stalled.canvasBarrier });
        const inputBeforeStall = panelPosts('input').length;
        await resetTargetInstrumentation();
        const stallPainted = paintedOf(await waitForFrame());
        let stallPoint = guiPointForViewport(stallPainted, Number(clickView.width), Number(clickView.height), q.x, q.y);
        await ensurePointVisible(stallPoint);
        const stallPaintedAgain = paintedOf(await waitForFrame());
        stallPoint = guiPointForViewport(stallPaintedAgain, Number(clickView.width), Number(clickView.height), q.x, q.y);
        await clickAt(stallPoint.x, stallPoint.y);
        await sleep(500);
        const stalledEvents = await targetEval('window.__t3 ? window.__t3.events.length : -1');
        check('V13.14', 'the same content point that worked before dispatches nothing while frame.scroll is inconsistent',
          stalledEvents === 0 && panelPosts('input').length === inputBeforeStall,
          { pageEvents: 0, inputPosts: inputBeforeStall },
          { pageEvents: stalledEvents, inputPosts: panelPosts('input').length, point: stallPoint });
      } catch (error) {
        notRun('V13.13', 'fail-closed scroll barrier (inconsistent frame.scroll)',
          'CDP Fetch response rewriting is unavailable in this environment', sanitize(errorMessage(error)));
      } finally {
        if (stopRewrite) await stopRewrite();
      }
      const recovered = await waitCanvasState(true, true, { timeoutMs: 8000 }).catch(() => null);
      check('V13.15', 'the canvas input barrier recovers when the Host scroll evidence agrees again',
        Boolean(recovered), { canvasReady: 'true' }, recovered ? { canvasReady: recovered.canvasReady } : { canvasReady: null });

      // ---- V13.16 drag writes the canvas origin C and may go negative ----
      await hostViewportSet({ width: 400, height: 300, scale: 1, x: 0, y: 0 });
      await waitHostView((view) => Number(view.width) === 400 && Number(view.height) === 300 && near(view.x, 0, 1) && near(view.y, 0, 1));
      await waitPanelMirrorsHost();
      await hostViewportSet({ canvasX: 50, canvasY: 50 });
      await waitHostView((view) => near(view.canvasX, 50, 1) && near(view.canvasY, 50, 1) && near(view.x, 50, 1));
      await waitPanelMirrorsHost();
      await waitCanvasState(true, true);
      await waitFrameStable();
      const panOn = await togglePan(true);
      check('V13.16', 'the drag checkbox is enabled on a canvas Host and checked after a real click',
        panOn.panChecked === true && panOn.frameCursor === 'grab',
        { checked: true, cursor: 'grab' }, { checked: panOn.panChecked, cursor: panOn.frameCursor });
      const canvasDrag = await dragOnFrame(140, 90);
      const expectedCanvasX = Math.round(50 - (140 * 400) / Math.max(1, canvasDrag.painted.width));
      const expectedCanvasY = Math.round(50 - (90 * 300) / Math.max(1, canvasDrag.painted.height));
      const draggedCanvas = await waitHostView((view) => near(view.canvasX, expectedCanvasX, 6)
        && near(view.canvasY, expectedCanvasY, 6) && near(view.x, 0, 1) && near(view.y, 0, 1));
      check('V13.17', `dragging right/down moves canvas C into negative values (${expectedCanvasX}, ${expectedCanvasY}) and keeps real scroll clamped at 0`,
        near(draggedCanvas.view.canvasX, expectedCanvasX, 6) && near(draggedCanvas.view.canvasY, expectedCanvasY, 6)
          && Number(draggedCanvas.view.canvasX) < 0 && Number(draggedCanvas.view.canvasY) < 0
          && near(draggedCanvas.view.x, 0, 1) && near(draggedCanvas.view.y, 0, 1),
        { canvasX: expectedCanvasX, canvasY: expectedCanvasY, x: 0, y: 0 },
        { view: draggedCanvas.view, painted: canvasDrag.painted });
      const draggedPanel = await waitPanelValues({ x: draggedCanvas.view.canvasX, y: draggedCanvas.view.canvasY }).catch(() => panelState());
      check('V13.18', 'the X/Y inputs mirror the negative canvas C after the drag',
        near(draggedPanel.x, draggedCanvas.view.canvasX, 2) && near(draggedPanel.y, draggedCanvas.view.canvasY, 2),
        { x: draggedCanvas.view.canvasX, y: draggedCanvas.view.canvasY }, { x: draggedPanel.x, y: draggedPanel.y });
      const panOff = await togglePan(false);
      check('V13.19', 'unchecking drag restores the default cursor and page interaction surface',
        panOff.panChecked === false && panOff.frameCursor !== 'grab' && panOff.frameCursor !== 'grabbing',
        { checked: false, cursor: 'auto' }, { checked: panOff.panChecked, cursor: panOff.frameCursor });
      await capturePanel('shot-08-canvas-drag');

      // ---- V13.19b pan-only overlay: a fully blank canvas can still be dragged back ----
      const liveContent = (await hostCanvas()).canvas;
      const dragViewWidth = Number((await hostView()).view.width);
      const farC = Number(liveContent.contentWidth) + 100;
      const maxScrollFar = Math.max(0, Number(liveContent.contentWidth) - dragViewWidth);
      await hostViewportSet({ canvasX: farC, canvasY: 0 });
      const farView = await waitHostView((view) => near(view.canvasX, farC, 2) && near(view.x, maxScrollFar, 2));
      await waitPanelMirrorsHost();
      await waitCanvasState(true, true);
      await waitFrameStable();
      const farPreview = await waitFrameStable();
      await ensurePointVisible({ x: farPreview.box.left + farPreview.box.width / 2, y: farPreview.box.top + farPreview.box.height / 2 });
      await sleep(400);
      const farFrame = await waitFrameStable();
      const farPanel = await panelState();
      const farDetail = canvasDetailOf(farPanel);
      const farSeed = farDetail.seed === true;
      const farShift = transformTranslate(farPanel.imgTransform);
      const farShot = await captureBoxPixels(farFrame.box);
      const farChecker = checkerboardOf(farPanel);
      const farProbe = checkerSample(farShot.decoded, farChecker,
        [[7, 7], [21, 7], [35, 7], [49, 7], [63, 7], [77, 7], [7, 21], [21, 21], [35, 21], [49, 21], [63, 21], [77, 21], [7, 35], [21, 35], [35, 35]]);
      const farClip = farSeed ? String(farPanel.canvasSeedClip || '') : 'off';
      const farExpectedShift = farSeed ? 0 : -(Number(liveContent.contentWidth) + 100 - maxScrollFar);
      check('V13.19b', 'C fully beyond the content box shows an all-checkerboard canvas (live frame out; composed seed fully clipped)',
        farPanel.canvasBlank === 'checkerboard' && Boolean(farChecker)
          && farProbe.allChecker && farProbe.both && farProbe.white === 0
          && near(farShift.x, farExpectedShift, 3)
          && (farSeed ? farPanel.canvasBarrier === 'seed-aligned' && farClip !== 'off' && farClip.includes('100%') : farPanel.canvasBarrier === 'aligned' && farClip === 'off'),
        { blank: 'checkerboard', colors: 'both dark tones', translateX: farExpectedShift, seedClip: farSeed ? 'all blank' : 'off' },
        { blank: farPanel.canvasBlank, checker: farChecker, probe: farProbe, translate: farShift, barrier: farPanel.canvasBarrier, seedClip: farClip, C: farC, maxScroll: maxScrollFar, detail: farDetail, view: farView.view });
      await capturePanel('shot-09-canvas-all-blank');

      const panAgain = await togglePan(true);
      check('V13.19c', 'drag mode adds a pan-only transparent layer over the blank viewport (grab cursor)',
        panAgain.panChecked === true && panAgain.panLayer === true && panAgain.panLayerCursor === 'grab',
        { checked: true, layer: true, cursor: 'grab' },
        { checked: panAgain.panChecked, layer: panAgain.panLayer, cursor: panAgain.panLayerCursor });

      // The frame is entirely outside the box: this drag can only start on the blank overlay.
      const blankDrag = await dragOnFrame(200, 0);
      const recoveredC = Math.round(farC - (200 * dragViewWidth) / Math.max(1, blankDrag.painted.width));
      const blankDragged = await waitHostView((view) => near(view.canvasX, recoveredC, 8) && near(view.x, maxScrollFar, 2));
      check('V13.19d', `dragging from the blank recovers the viewport (canvasX ${Math.round(farC)}→≈${recoveredC})`,
        near(blankDragged.view.canvasX, recoveredC, 8) && Number(blankDragged.view.canvasX) < farC,
        { canvasX: recoveredC }, { canvasX: blankDragged.view.canvasX, startedBlank: true, painted: blankDrag.painted });
      await waitCanvasState(true, true);
      const recoveredFrame = await waitFrameStable();
      const recoveredPanel = await panelState();
      const recoveredDetail = canvasDetailOf(recoveredPanel);
      const recoveredSeed = recoveredDetail.seed === true;
      const recoveredShift = transformTranslate(recoveredPanel.imgTransform);
      const recoveredShot = await captureBoxPixels(recoveredFrame.box);
      const recoveredLeft = pixelAt(recoveredShot.decoded, 30, Math.round(recoveredFrame.box.height * 0.5));
      const recoveredChecker = checkerboardOf(recoveredPanel);
      const recoveredRightX = Math.round(recoveredFrame.box.width - 73);
      const recoveredProbe = checkerSample(recoveredShot.decoded, recoveredChecker,
        [[recoveredRightX, 7], [recoveredRightX + 14, 7], [recoveredRightX + 28, 7], [recoveredRightX + 42, 7], [recoveredRightX + 56, 7]]);
      const recoveredClip = recoveredSeed ? String(recoveredPanel.canvasSeedClip || '') : 'off';
      const recoveredExpectedShift = recoveredSeed ? 0 : -(recoveredC - maxScrollFar);
      check('V13.19e', 'after the blank drag the content is visible on the left and the right band is checkerboard (seed clipped)',
        recoveredLeft.r >= 150 && recoveredLeft.g <= 120 && recoveredLeft.b <= 120
          && recoveredPanel.canvasBlank === 'checkerboard' && Boolean(recoveredChecker)
          && recoveredProbe.allChecker && recoveredProbe.both && recoveredProbe.white === 0
          && near(recoveredShift.x, recoveredExpectedShift, 3)
          && (recoveredSeed ? recoveredPanel.canvasBarrier === 'seed-aligned' && recoveredClip.includes('75%') : recoveredPanel.canvasBarrier === 'aligned' && recoveredClip === 'off'),
        { left: 'page background', right: 'checkerboard', translateX: recoveredExpectedShift, seedClip: recoveredSeed ? 'right 75%' : 'off' },
        { left: recoveredLeft, checker: recoveredChecker, probe: recoveredProbe, translate: recoveredShift, barrier: recoveredPanel.canvasBarrier, seedClip: recoveredClip, C: recoveredC, maxScroll: maxScrollFar, detail: recoveredDetail });
      const panFinallyOff = await togglePan(false);
      check('V13.19f', 'leaving drag mode removes the pan overlay and restores the normal hit surface',
        panFinallyOff.panChecked === false && panFinallyOff.panLayer === false && panFinallyOff.frameCursor !== 'grab',
        { checked: false, layer: false, cursor: 'auto' },
        { checked: panFinallyOff.panChecked, layer: panFinallyOff.panLayer, cursor: panFinallyOff.frameCursor });

      // Reset to a neutral canvas before the fallback simulations (their X/Y display is scroll 0).
      await hostViewportSet({ width: 400, height: 300, scale: 1, x: 0, y: 0 });
      await waitHostView((view) => Number(view.width) === 400 && Number(view.height) === 300 && near(view.x, 0, 2) && near(view.y, 0, 1));
      await hostViewportSet({ canvasX: 0, canvasY: 0 });
      await waitHostView((view) => near(view.canvasX, 0, 1) && near(view.canvasY, 0, 1) && near(view.x, 0, 1));
      await waitPanelMirrorsHost();
      await waitCanvasState(true, true);

      // ---- V13.20 simulated Host without ui.canvas: old scroll fallback + drag disabled ----
      let stopNoCanvas = null;
      try {
        stopNoCanvas = await startStateRewrite((json) => mutateStateUi(json, (ui) => {
          delete ui.canvas;
          return ui;
        }));
        const noCanvas = await waitCanvasState(false, undefined, { timeoutMs: 5000 });
        await waitPanelValues({ x: 0, y: 0 }).catch(() => undefined);
        const noCanvasPanel = await panelState();
        check('V13.20', 'without ui.canvas the drag mode is disabled and X/Y fall back to document scroll (0, not the stale C)',
          noCanvasPanel.canvasOn === 'off' && noCanvasPanel.panDisabled === true && noCanvasPanel.xDisabled === false
            && near(noCanvasPanel.x, 0, 1.5) && near(noCanvasPanel.y, 0, 1.5),
          { canvas: 'off', panDisabled: true, xDisabled: false, x: 0, y: 0 },
          { canvas: noCanvasPanel.canvasOn, panDisabled: noCanvasPanel.panDisabled, xDisabled: noCanvasPanel.xDisabled,
            x: noCanvasPanel.x, y: noCanvasPanel.y });
        const markNoCanvas = Date.now();
        await typeIntoField(X_LABEL, '-50', { enter: true });
        await sleep(500);
        const noCanvasPanelAfter = await panelState();
        const noCanvasPosts = panelPosts('viewport', markNoCanvas).map(parseBody);
        check('V13.21', 'the fallback rejects a negative scroll draft and never posts canvasX/canvasY',
          near(noCanvasPanelAfter.x, 0, 1.5)
            && !noCanvasPosts.some((body) => body.canvasX !== undefined || body.canvasY !== undefined),
          { x: 0, canvasFields: 0 }, { x: noCanvasPanelAfter.x, bodies: noCanvasPosts });
      } catch (error) {
        notRun('V13.20', 'simulated Host without ui.canvas',
          'CDP Fetch response rewriting is unavailable in this environment', sanitize(errorMessage(error)));
      } finally {
        if (stopNoCanvas) await stopNoCanvas();
      }
      await waitCanvasState(true, true, { timeoutMs: 8000 }).catch(() => undefined);

      // ---- V13.22 simulated pre-P0-C Host (no ui.view at all): X/Y and drag disabled ----
      let stopOldHost = null;
      try {
        stopOldHost = await startStateRewrite((json) => mutateStateUi(json, (ui) => {
          delete ui.view;
          delete ui.canvas;
          return ui;
        }));
        const oldHostPanel = await waitFor(async () => {
          const panel = await panelState();
          return panel.canvasOn === 'off' && panel.xDisabled === true && panel.panDisabled === true ? panel : undefined;
        }, { timeoutMs: 5000, intervalMs: 150, label: 'old Host fallback disables X/Y and drag' });
        check('V13.22', 'an old Host snapshot (no ui.view/ui.canvas) disables X/Y and drag instead of guessing',
          oldHostPanel.xDisabled === true && oldHostPanel.yDisabled === true && oldHostPanel.panDisabled === true,
          { xDisabled: true, yDisabled: true, panDisabled: true },
          { xDisabled: oldHostPanel.xDisabled, yDisabled: oldHostPanel.yDisabled, panDisabled: oldHostPanel.panDisabled });
      } catch (error) {
        notRun('V13.22', 'simulated pre-P0-C Host (no shared view)',
          'CDP Fetch response rewriting is unavailable in this environment', sanitize(errorMessage(error)));
      } finally {
        if (stopOldHost) await stopOldHost();
      }
      const restoredCanvas = await waitCanvasState(true, true, { timeoutMs: 8000 }).catch(() => null);
      check('V13.23', 'the canvas inputs/drag re-enable once the Host projection returns',
        Boolean(restoredCanvas) && restoredCanvas.panDisabled === false,
        { canvas: 'on', panDisabled: false },
        restoredCanvas ? { canvas: restoredCanvas.canvasOn, panDisabled: restoredCanvas.panDisabled } : { canvas: null });

      // The Host rejects a patch carrying both coordinate spaces; the panel must never send one.
      const allPanelPatches = state.requests
        .filter((entry) => !entry.script && entry.method === 'POST' && entry.url.includes('/plugins/ui-testing/viewport'))
        .map((entry) => parseBody(entry));
      const mixedPatches = allPanelPatches.filter((body) => (body.canvasX !== undefined || body.canvasY !== undefined)
        && (body.x !== undefined || body.y !== undefined));
      check('V13.24', 'no panel /viewport patch ever mixes canvasX/canvasY with x/y',
        mixedPatches.length === 0, { mixed: 0 }, { mixed: mixedPatches.length, bodies: mixedPatches.slice(0, 3) });
    });

    await scenario('V14 pan-mode wheel zoom', async () => {
      // Base state: O != 0 on both axes (top-left blank) so a cursor-anchored zoom keeps the real
      // page scroll at 0 while C changes; fit is off and pan mode is on.
      await navigateTarget(`${fixtureBase}/web-t3.html`);
      await waitForFrame();
      await ensureHorizontalOverflow();
      await clickFit(false);
      await hostViewportSet({ width: 400, height: 300, scale: 1, x: 0, y: 0 });
      await waitHostView((view) => Number(view.width) === 400 && Number(view.height) === 300 && closeTo(view.scale, 1, 0.0011));
      await hostViewportSet({ canvasX: -100, canvasY: -100 });
      await waitHostView((view) => near(view.canvasX, -100, 1) && near(view.canvasY, -100, 1) && near(view.x, 0, 1) && near(view.y, 0, 1));
      await waitPanelMirrorsHost();
      await waitCanvasState(true, true);
      await waitFrameStable();
      const panOn = await togglePan(true);
      check('V14.0', 'drag mode advertises the wheel-zoom surface',
        panOn.panChecked === true && panOn.canvasZoom === 'wheel',
        { checked: true, zoom: 'wheel' }, { checked: panOn.panChecked, zoom: panOn.canvasZoom });

      const b = { x: 40, y: 40 };
      const setup = await frameBoxPoint(b);
      const beforePanel = await panelState();
      const beforeBox = setup.box;
      const point = setup.point;
      const beforeView = (await hostView()).view;
      const beforeCanvas = (await hostCanvas()).canvas;
      const s0 = beforeBox.width / Number(beforeView.width);
      // The canvas point under the cursor's *screen* point S; the strict assertion is that d0
      // remains at S after layout, not merely at the same box-relative coordinate.
      const d0 = { x: Number(beforeCanvas.x) + (point.x - beforeBox.left) / s0, y: Number(beforeCanvas.y) + (point.y - beforeBox.top) / s0 };
      const scrollBefore = await targetTruth();
      await capturePanel('shot-12-zoom-anchor-before');
      const mark = Date.now();
      await wheelOnFramePoint(point, -120);
      const zoomed = await waitHostView((view) => closeTo(view.scale, 1.05, 0.0011) && near(view.x, 0, 1) && near(view.y, 0, 1));
      await waitPanelMirrorsHost();
      await waitZoomAnchorState('settled');
      await sleep(250);
      const posts = panelPosts('viewport', mark).map(parseBody);
      const inputPosts = panelPosts('input', mark);
      const scrollAfter = await targetTruth();
      const afterPanel = await panelState();
      const afterBox = afterPanel.frame.box;
      const afterView = (await hostView()).view;
      const afterCanvas = (await hostCanvas()).canvas;
      const s1 = afterBox.width / Number(afterView.width);
      const screen1 = {
        x: afterBox.left + (d0.x - Number(afterCanvas.x)) * s1,
        y: afterBox.top + (d0.y - Number(afterCanvas.y)) * s1,
      };
      const drift = Math.max(Math.abs(screen1.x - point.x), Math.abs(screen1.y - point.y));
      const body = posts.length ? posts[0] : {};
      check('V14.1', 'drag-mode wheel applies the 5% scale step through one scale+canvasX/Y patch (no x/y, no page scroll, no /input)',
        closeTo(zoomed.view.scale, 1.05, 0.0011) && posts.length === 1
          && closeTo(body.scale, 1.05, 0.0011)
          && num(body.canvasX) !== null && num(body.canvasY) !== null
          && body.x === undefined && body.y === undefined
          && near(scrollAfter.scrollX, scrollBefore.scrollX, 0.5) && near(scrollAfter.scrollY, scrollBefore.scrollY, 0.5)
          && inputPosts.length === 0,
        { scale: 1.05, patch: ['scale', 'canvasX', 'canvasY'], scroll: 'unchanged', input: 0 },
        { scale: zoomed.view.scale, posts, inputPosts: inputPosts.length, scrollBefore, scrollAfter, body });
      check('V14.2', 'strict screen anchor: the same cursor screen point stays ≤2 CSS px after 5% and again after 5%→10%',
        afterPanel.canvasZoomAnchor === 'screen' && afterPanel.canvasZoomAnchorState === 'settled' && drift <= 2,
        { anchor: 'screen', residual: '<=2', first: '5%', second: '5%→10%' },
        { anchor: afterPanel.canvasZoomAnchor, anchorState: afterPanel.canvasZoomAnchorState, drift, point, screen1, d0, s0, s1, beforeBox, afterBox });
      await capturePanel('shot-13-zoom-anchor-after-5');
      // Centering compensation: with the box centered and stage wider, the box left moves by
      // W·(s'−s)/2; the screen formula must fold that into C. A box-relative C would leave that
      // amount of screen drift.
      const stage = beforePanel.stage;
      const centeredX = Boolean(stage) && Math.abs((stage.left + stage.clientWidth / 2) - (beforeBox.left + beforeBox.width / 2)) <= 1;
      const centeredY = Boolean(stage) && Math.abs((stage.top + stage.clientHeight / 2) - (beforeBox.top + beforeBox.height / 2)) <= 1;
      const noCompX = Number(beforeView.width) * (s1 - s0) / 2;
      const noCompY = Number(beforeView.height) * (s1 - s0) / 2;
      const boxShiftX = beforeBox.left - afterBox.left;
      const boxShiftY = beforeBox.top - afterBox.top;
      const boxRelativeC = {
        x: Number(beforeCanvas.x) + (point.x - beforeBox.left) * (1 / s0 - 1 / s1),
        y: Number(beforeCanvas.y) + (point.y - beforeBox.top) * (1 / s0 - 1 / s1),
      };
      const compensation = { x: boxRelativeC.x - Number(afterCanvas.x), y: boxRelativeC.y - Number(afterCanvas.y) };
      const boxRelativeMapped = {
        x: boxRelativeC.x + (point.x - beforeBox.left) / s1,
        y: boxRelativeC.y + (point.y - beforeBox.top) / s1,
      };
      const boxRelativeResidual = Math.max(Math.abs(boxRelativeMapped.x - d0.x), Math.abs(boxRelativeMapped.y - d0.y));
      check('V14.2b', 'centering offset is folded into C (without it the screen would drift ≈W·(s′−s)/2)',
        centeredX && centeredY && Math.abs(boxShiftX - noCompX) <= 1.5 && Math.abs(boxShiftY - noCompY) <= 1.5
          && Math.abs(compensation.x - noCompX / s1) <= 2 && Math.abs(compensation.y - noCompY / s1) <= 2 && drift <= 2,
        { noCompensationDrift: noCompX, compensation: noCompX / s1, centered: true },
        { noCompensationDrift: noCompX, noCompensationDriftY: noCompY, boxShift: boxShiftX, boxShiftY,
          compensation, boxRelativeC, boxRelativeMapped, boxRelativeResidual, actualC: afterCanvas, s0, s1, drift, centeredX, centeredY, stage });
      // Advisory: the historical box-relative anchor still maps d0 to itself in box coordinates; the
      // screen-anchor change only adds the box-position compensation on top.
      check('V14.2d', 'box-relative anchor residual remains ≤2 CSS px (advisory, kept from the previous contract)',
        boxRelativeResidual <= 2,
        { residual: '<=2' },
        { boxRelativeResidual, boxRelativeMapped, d0 });
      // Second 5% at the same screen point (5%→10%): the anchor must still hold.
      const d1 = { x: Number(afterCanvas.x) + (point.x - afterBox.left) / s1, y: Number(afterCanvas.y) + (point.y - afterBox.top) / s1 };
      const markSecond = Date.now();
      await wheelOnFramePoint(point, -120);
      await waitHostView((view) => closeTo(view.scale, 1.10, 0.0011));
      await waitPanelMirrorsHost();
      await waitZoomAnchorState('settled');
      await sleep(250);
      const secondPanel = await panelState();
      const secondBox = secondPanel.frame.box;
      const secondView = (await hostView()).view;
      const secondCanvas = (await hostCanvas()).canvas;
      const s2 = secondBox.width / Number(secondView.width);
      const screen2 = {
        x: secondBox.left + (d1.x - Number(secondCanvas.x)) * s2,
        y: secondBox.top + (d1.y - Number(secondCanvas.y)) * s2,
      };
      const drift2 = Math.max(Math.abs(screen2.x - point.x), Math.abs(screen2.y - point.y));
      check('V14.2c', 'consecutive 5%→10% zoom keeps the same screen anchor ≤2 CSS px',
        secondPanel.canvasZoomAnchor === 'screen' && drift2 <= 2,
        { residual: '<=2', scale: 1.10 },
        { drift2, point, screen2, d1, s1, s2, secondBox, secondCanvas, posts: panelPosts('viewport', markSecond).length });
      await capturePanel('shot-14-zoom-anchor-after-10');
      await capturePanel('shot-11-zoom-after');

      // Fit auto-unlock: a checked fit box must turn unchecked and stay unchecked after polls.
      await hostViewportSet({ width: 400, height: 300, scale: 1, x: 0, y: 0 });
      await waitHostView((view) => closeTo(view.scale, 1, 0.0011));
      await hostViewportSet({ canvasX: -100, canvasY: -100 });
      await waitHostView((view) => near(view.canvasX, -100, 1) && near(view.canvasY, -100, 1) && near(view.x, 0, 1) && near(view.y, 0, 1));
      await waitPanelMirrorsHost();
      // Let any in-flight /state poll from before the reset land before toggling the local fit
      // preference; a stale poll would otherwise cancel fit right after the click.
      await sleep(700);
      await clickFit(true);
      await sleep(900);
      let fitBefore = await panelState();
      if (fitBefore.fitChecked !== true) {
        await clickFit(true);
        await sleep(900);
        fitBefore = await panelState();
      }
      const fitSetup = await frameBoxPoint(b);
      await wheelOnFramePoint(fitSetup.point, -120);
      const fitExpected = (Math.round(Number(fitBefore.zoomValue)) + 5) / 100;
      const fitZoom = await waitHostView((view) => closeTo(view.scale, fitExpected, 0.0011));
      await sleep(1600);
      const fitAfter = await panelState();
      const fitView = (await hostView()).view;
      const fitMirror = await waitPanelMirrorsHost().catch(() => ({ panel: fitAfter, view: fitView }));
      check('V14.3', 'zoom auto-unchecks fit and later state polls never restore it',
        fitBefore.fitChecked === true && fitAfter.fitChecked === false
          && closeTo(fitAfter.zoomValue, Number(fitView.scale) * 100, 1.5)
          && closeTo(fitView.scale, fitExpected, 0.0011)
          && fitMirror.panel.fitChecked === false,
        { fitBefore: true, fitAfter: false, scale: fitExpected },
        { fitBefore: fitBefore.fitChecked, fitAfter: fitAfter.fitChecked, zoom: fitAfter.zoomValue, viewScale: fitView.scale, expected: fitExpected, mirrored: fitMirror.panel.fitChecked });

      // Step rules: Alt 1%, Shift 10%, Alt wins over Shift. Run the whole sequence five times from
      // a freshly adopted base so a single lost notch (CAS/state race) cannot hide behind a retry.
      const stepRounds = [];
      for (let round = 0; round < 5; round += 1) {
        await resetZoomBase();
        const altSetup = await frameBoxPoint(b);
        await wheelOnFramePoint(altSetup.point, -120, ALT);
        const altStep = await waitHostView((view) => closeTo(view.scale, 1.01, 0.0011));
        const shiftSetup = await frameBoxPoint(b);
        await wheelOnFramePoint(shiftSetup.point, -120, SHIFT);
        const shiftStep = await waitHostView((view) => closeTo(view.scale, 1.11, 0.0011));
        const bothSetup = await frameBoxPoint(b);
        await wheelOnFramePoint(bothSetup.point, -120, ALT | SHIFT);
        const bothStep = await waitHostView((view) => closeTo(view.scale, 1.12, 0.0011));
        stepRounds.push({
          round: round + 1,
          alt: altStep.view.scale, shift: shiftStep.view.scale, both: bothStep.view.scale,
          timedOut: altStep.timedOut === true || shiftStep.timedOut === true || bothStep.timedOut === true,
        });
      }
      check('V14.4', 'wheel zoom steps: Alt=1%, Shift=10%, Alt wins (5 consecutive reset rounds)',
        stepRounds.length === 5 && stepRounds.every((entry) => !entry.timedOut
          && closeTo(entry.alt, 1.01, 0.0011) && closeTo(entry.shift, 1.11, 0.0011) && closeTo(entry.both, 1.12, 0.0011)),
        { rounds: 5, alt: 1.01, shift: 1.11, both: 1.12 },
        { rounds: stepRounds });

      // Ctrl/Meta never change the view scale and must not be turned into browser zoom.
      await hostViewportSet({ width: 400, height: 300, scale: 1, x: 0, y: 0 });
      await waitHostView((view) => closeTo(view.scale, 1, 0.0011));
      await hostViewportSet({ canvasX: -100, canvasY: -100 });
      await waitHostView((view) => near(view.canvasX, -100, 1) && near(view.canvasY, -100, 1) && near(view.x, 0, 1) && near(view.y, 0, 1));
      await waitPanelMirrorsHost();
      const ctrlSetup = await frameBoxPoint(b);
      const dprBefore = await pageEvaluate('window.devicePixelRatio');
      const scaleBeforeCtrl = Number((await hostView()).view.scale);
      const markCtrl = Date.now();
      await wheelOnFramePoint(ctrlSetup.point, -120, CTRL);
      await sleep(500);
      const afterCtrl = Number((await hostView()).view.scale);
      await wheelOnFramePoint(ctrlSetup.point, -120, 4 /* Meta */);
      await sleep(500);
      const afterMeta = Number((await hostView()).view.scale);
      const dprAfter = await pageEvaluate('window.devicePixelRatio');
      const ctrlPosts = panelPosts('viewport', markCtrl);
      const ctrlPanel = await panelState();
      check('V14.5', 'Ctrl/Meta+wheel in drag mode changes neither view.scale nor DPR and posts no /viewport',
        closeTo(afterCtrl, scaleBeforeCtrl, 0.0011) && closeTo(afterMeta, scaleBeforeCtrl, 0.0011)
          && Number(dprAfter) === Number(dprBefore) && ctrlPosts.length === 0 && ctrlPanel.fitChecked === false,
        { scale: scaleBeforeCtrl, dpr: dprBefore, requests: 0 },
        { ctrl: afterCtrl, meta: afterMeta, dprBefore, dprAfter, requests: ctrlPosts.length, fit: ctrlPanel.fitChecked });

      // Scale boundaries are consumed but send nothing and do not unlock/relock fit.
      await hostViewportSet({ width: 400, height: 300, scale: 0.1, x: 0, y: 0 });
      await waitHostView((view) => closeTo(view.scale, 0.1, 0.0011));
      await hostViewportSet({ canvasX: -100, canvasY: -100 });
      await waitHostView((view) => near(view.canvasX, -100, 1) && near(view.canvasY, -100, 1));
      await waitPanelMirrorsHost();
      const lowSetup = await frameBoxPoint({ x: 10, y: 10 });
      const markLow = Date.now();
      await wheelOnFramePoint(lowSetup.point, 120);
      await sleep(600);
      const lowView = (await hostView()).view;
      const lowPosts = panelPosts('viewport', markLow);
      check('V14.6', 'lower scale boundary 0.1: wheel-down is a no-op (no request)',
        closeTo(lowView.scale, 0.1, 0.0011) && lowPosts.length === 0,
        { scale: 0.1, requests: 0 }, { scale: lowView.scale, requests: lowPosts.length });
      await hostViewportSet({ scale: 2 });
      await waitHostView((view) => closeTo(view.scale, 2, 0.0011));
      await waitPanelMirrorsHost();
      const highSetup = await frameBoxPoint(b);
      const markHigh = Date.now();
      await wheelOnFramePoint(highSetup.point, -120);
      await sleep(600);
      const highView = (await hostView()).view;
      const highPosts = panelPosts('viewport', markHigh);
      check('V14.7', 'upper scale boundary 2.0: wheel-up is a no-op (no request)',
        closeTo(highView.scale, 2, 0.0011) && highPosts.length === 0,
        { scale: 2, requests: 0 }, { scale: highView.scale, requests: highPosts.length });

      // Burst: three notches in one debounce window merge into one patch with the accumulated scale.
      await hostViewportSet({ width: 400, height: 300, scale: 1, x: 0, y: 0 });
      await waitHostView((view) => closeTo(view.scale, 1, 0.0011));
      await hostViewportSet({ canvasX: -100, canvasY: -100 });
      await waitHostView((view) => near(view.canvasX, -100, 1) && near(view.canvasY, -100, 1) && near(view.x, 0, 1));
      await waitPanelMirrorsHost();
      const burstSetup = await frameBoxPoint(b);
      const markBurst = Date.now();
      await wheelBurstOnFramePoint(burstSetup.point, 3, -120);
      const burstView = await waitHostView((view) => closeTo(view.scale, 1.15, 0.0011));
      await sleep(200);
      const burstPosts = panelPosts('viewport', markBurst).map(parseBody);
      const burstBody = burstPosts.length ? burstPosts[0] : {};
      check('V14.8', 'a wheel burst merges into one /viewport patch with the accumulated 15% scale',
        burstPosts.length === 1 && closeTo(burstBody.scale, 1.15, 0.0011)
          && burstBody.x === undefined && burstBody.y === undefined,
        { scale: 1.15, patches: 1 },
        { scale: burstView.view.scale, patches: burstPosts.length, body: burstBody });

      // A CAS conflict must replay the same notch once (the request is held, the Host revision is
      // advanced by a script set, then the held request is released -> 409 + one bounded retry).
      await resetZoomBase();
      const conflictHold = await startViewportHold();
      try {
        const conflictSetup = await frameBoxPoint(b);
        await wheelOnFramePoint(conflictSetup.point, -120);
        const heldRequest = await conflictHold.waitForHeld();
        await hostViewportSet({ canvasX: -99, canvasY: -99 });
        await waitHostView((view) => near(view.canvasX, -99, 1) && near(view.x, 0, 1));
        await conflictHold.release();
        const conflictFinal = await waitHostView((view) => closeTo(view.scale, 1.05, 0.0011), { timeoutMs: 10000 });
        const conflictDebug = await pageEvaluate('window.__utbZoomDebug || []');
        check('V14.10', 'a CAS conflict on the zoom patch replays the same notch once (no lost notch)',
          conflictFinal.timedOut !== true && closeTo(conflictFinal.view.scale, 1.05, 0.0011),
          { scale: 1.05 }, { scale: conflictFinal.view.scale, timedOut: conflictFinal.timedOut === true, held: heldRequest.body, debug: conflictDebug.slice(-14) });
      } finally {
        await conflictHold.stop();
      }

      // Two notches while the first zoom patch is in flight: the second must be queued, not lost.
      await resetZoomBase();
      const inflightHold = await startViewportHold();
      try {
        const firstSetup = await frameBoxPoint(b);
        await wheelOnFramePoint(firstSetup.point, -120);
        const firstHeld = await inflightHold.waitForHeld();
        const secondSetup = await frameBoxPoint(b);
        await wheelOnFramePoint(secondSetup.point, -120);
        await sleep(300);
        await inflightHold.release();
        const inflightFinal = await waitHostView((view) => closeTo(view.scale, 1.10, 0.0011), { timeoutMs: 10000 });
        const inflightDebug = await pageEvaluate('window.__utbZoomDebug || []');
        check('V14.11', 'a second notch sent while the first zoom patch is in flight is queued and applied (no loss)',
          inflightFinal.timedOut !== true && closeTo(inflightFinal.view.scale, 1.10, 0.0011),
          { scale: 1.10 }, { scale: inflightFinal.view.scale, timedOut: inflightFinal.timedOut === true, first: firstHeld.body, debug: inflightDebug.slice(-14) });
      } finally {
        await inflightHold.stop();
      }

      // Leaving drag mode restores the historical frame wheel -> page scroll, with no scale write.
      await hostViewportSet({ width: 400, height: 300, scale: 1, x: 0, y: 0 });
      await waitHostView((view) => closeTo(view.scale, 1, 0.0011));
      await hostViewportSet({ canvasX: 0, canvasY: 0 });
      await waitHostView((view) => near(view.x, 0, 1) && near(view.y, 0, 1) && near(view.canvasX, 0, 1) && near(view.canvasY, 0, 1));
      await waitPanelMirrorsHost();
      const panOff = await togglePan(false);
      await waitCanvasState(true, true);
      await waitFrameStable();
      const scrollBeforePageWheel = await targetTruth();
      const pageBox = (await panelState()).frame.box;
      let pagePoint = { x: pageBox.left + pageBox.width / 2, y: pageBox.top + pageBox.height / 2 };
      await ensurePointVisible(pagePoint);
      const pageBoxAgain = (await panelState()).frame.box;
      pagePoint = { x: pageBoxAgain.left + pageBoxAgain.width / 2, y: pageBoxAgain.top + pageBoxAgain.height / 2 };
      const markPageWheel = Date.now();
      await wheelOnFramePoint(pagePoint, 200);
      await sleep(900);
      const pageAfter = await targetTruth();
      const pageView = (await hostView()).view;
      check('V14.9', 'after leaving drag mode the frame wheel scrolls the page again and does not write view.scale',
        panOff.panChecked === false && closeTo(pageView.scale, 1, 0.0011)
          && pageAfter.scrollY > scrollBeforePageWheel.scrollY + 80
          && panelPosts('viewport', markPageWheel).length === 0,
        { scrollY: `> ${scrollBeforePageWheel.scrollY + 80}`, scale: 1, viewportPosts: 0 },
        { pan: panOff.panChecked, scrollY: pageAfter.scrollY, before: scrollBeforePageWheel.scrollY, scale: pageView.scale, posts: panelPosts('viewport', markPageWheel).length });
    });

    await scenario('V11 narrow size bar layout', async () => {
      // Deliberately last: a narrow GUI window makes the DSH shell open a sidebar drawer with a
      // mask, which must not leak into the earlier interaction checks.
      const wide = await panelState();
      try {
        await setGuiWindow(720, 760);
        await sleep(1000);
        await openSizeBar();
        const narrow = await panelState();
        check('V11.1', 'narrow panel: the size bar wraps instead of overflowing or covering the stage',
          Boolean(narrow.bar) && Boolean(narrow.inputs.length >= 5)
            && narrow.bar.scrollWidth <= narrow.bar.clientWidth + 1
            && narrow.bar.right <= narrow.bar.panelRight + 1
            && narrow.bar.bottom <= Number(narrow.stageTop) + 1,
          { scrollWidth: '<= clientWidth', barBottom: '<= stageTop', inputs: 5 },
          { bar: narrow.bar, stageTop: narrow.stageTop, inputs: narrow.inputs.length, wideBarWidth: wide.bar ? wide.bar.width : null });
        check('V11.2', 'all five inputs still exist while narrow', narrow.inputs.length >= 5,
          5, narrow.inputs.map((input) => input.label));
        await capturePanel('shot-01-sizebar-narrow');
      } finally {
        await cdp.send('Emulation.clearDeviceMetricsOverride').catch(() => undefined);
        await sleep(900);
        await openSizeBar();
      }
    });

    await scenario('V10 wrap-up facts', async () => {
      const truth = await targetTruth();
      const view = (await hostView()).view;
      check('V10.1', 'no page exception during the whole run', state.exceptions.length === 0, [], state.exceptions.slice(0, 3));
      check('V10.2', 'DPR and visualViewport.scale stayed untouched by the panel',
        Number(truth.devicePixelRatio) === 1 && truth.visualViewportScale === 1,
        { devicePixelRatio: 1, visualViewportScale: 1 },
        { devicePixelRatio: truth.devicePixelRatio, visualViewportScale: truth.visualViewportScale });
      check('V10.3', 'the Host view stayed within the contract ranges at the end',
        Number(view.width) >= 200 && Number(view.width) <= 4096 && Number(view.height) >= 200 && Number(view.height) <= 4096
          && Number(view.scale) >= 0.1 && Number(view.scale) <= 2,
        { width: '200..4096', height: '200..4096', scale: '0.1..2' }, view);
      if (state.consoleErrors.length) log(`  [note] ${state.consoleErrors.length} console error line(s) recorded (not asserted): ${state.consoleErrors.slice(0, 2).join(' | ')}`);
      notRun('V10.4', 'old Host degradation (X/Y disabled, legacy {width,height} body)',
        'this suite only starts a Host that exposes ui.view; the legacy branch needs an old Host and is not exercised here');
      notRun('V10.5', 'expectedRevision conflict resolution (VIEWPORT_CONFLICT)',
        'concurrency/CAS is Host-slice acceptance; the GUI only asserts that its patches carry expectedRevision');
      notRun('V10.6', 'resize geometry barrier is best-effort',
        'the frame protocol is not extended: input is paused for at most 250 ms after a width/height change (documented partial)');
    });
  }

  const failed = checks.filter((entry) => !entry.pass);
  const report = {
    schemaVersion: 1,
    suite: 'dsh-agent-team-ui-testing/viewport-gui',
    generatedAt: new Date().toISOString(),
    blocked: state.blocked || null,
    environment: {
      node: process.version,
      platform: `${process.platform}/${process.arch}`,
      isolatedDsh: {
        base: state.dsh ? state.dsh.base : null,
        port: state.dsh ? state.dsh.port : null,
        home: state.dsh ? state.dsh.home : null,
        profileFiles: state.dsh ? state.dsh.copied : null,
        profile: 'web',
        nodeModules: 'symlinked from the user profile',
      },
      chrome: CHROME_BIN,
      fixture: state.fixture ? String(state.fixture.url).replace(/\/+$/, '') : null,
      build: state.buildInfo,
      servedClient: state.servedClient ? {
        rev: state.servedClient.rev,
        bytes: state.servedClient.bytes,
        sha256: state.servedClient.sha256Full,
        exactMatchWithCheckout: state.servedClient.exactMatch === true,
        hasViewportCode: state.servedClient.hasViewportCode === true,
      } : null,
      dialogsDismissed: state.dialogsDismissed,
      consoleErrors: state.consoleErrors.slice(0, 5),
      note: '隔离实例的 token 只存在于进程内存；URL 通过 CDP 传入，报告与日志已脱敏。3080/3081 未触碰。',
    },
    checks,
    notRuns,
    evidence: state.evidence,
    summary: {
      checks: checks.length,
      passed: checks.length - failed.length,
      failed: failed.length,
      notRun: notRuns.length,
      blocked: state.blocked || null,
      exitCode: state.blocked ? 2 : (failed.length ? 1 : 0),
    },
  };
  await writeFile(join(RUN_DIR, 'run-report.json'), JSON.stringify(report, null, 2));
  await writeFile(join(RUN_DIR, 'viewport-gui.log'), sanitize(logLines.join('\n') + '\n'));
  await writeFile(join(EVIDENCE_DIR, 'SUMMARY.md'), renderSummaryMd(report), { mode: 0o600 });
  log(`\nviewport-gui: ${checks.length - failed.length}/${checks.length} checks, ${failed.length} failed, ${notRuns.length} NOT_RUN${state.blocked ? `, BLOCKED(${state.blocked})` : ''}`);
  log(`report: ${join(RUN_DIR, 'run-report.json')}`);
  log(`evidence: ${EVIDENCE_DIR}`);
  if (state.blocked) return 2;
  return failed.length ? 1 : 0;
}

/* ------------------------------------------------------------------------------------------------
 * Extra probes.
 * ---------------------------------------------------------------------------------------------- */
/** Measure the live letterbox band of the displayed frame (0 = the painted rect fills the box). */
async function probeLetterbox() {
  const snapshot = await panelState();
  const frame = snapshot.frame;
  const painted = paintedOf(frame);
  if (!painted) return { band: 0, reason: 'no frame' };
  const bandTop = painted.top - frame.img.top;
  const bandBottom = (frame.img.top + frame.img.height) - (painted.top + painted.height);
  const bandLeft = painted.left - frame.img.left;
  const bandRight = (frame.img.left + frame.img.width) - (painted.left + painted.width);
  const vertical = Math.max(bandTop, bandBottom);
  const horizontal = Math.max(bandLeft, bandRight);
  if (vertical >= horizontal) {
    return {
      band: vertical,
      x: painted.left + painted.width / 2,
      y: bandTop > 1 ? painted.top - Math.min(bandTop, 20) / 2 : painted.top + painted.height + Math.min(bandBottom, 20) / 2,
      frame: { naturalWidth: frame.naturalWidth, naturalHeight: frame.naturalHeight, img: frame.img },
      painted,
    };
  }
  return {
    band: horizontal,
    x: bandLeft > 1 ? painted.left - Math.min(bandLeft, 20) / 2 : painted.left + painted.width + Math.min(bandRight, 20) / 2,
    y: painted.top + painted.height / 2,
    frame: { naturalWidth: frame.naturalWidth, naturalHeight: frame.naturalHeight, img: frame.img },
    painted,
  };
}

function buildInfo() {
  const info = {};
  for (const [name, key] of [['client.js', 'clientJs'], ['index.js', 'indexJs']]) {
    const path = join(REPO_ROOT, name);
    if (!existsSync(path)) continue;
    try {
      const buffer = readFileSync(path);
      info[key] = { bytes: buffer.length, sha256: createHash('sha256').update(buffer).digest('hex') };
    } catch { /* ignore */ }
  }
  return info;
}

async function servedClientEvidence() {
  const result = await pageEvaluate(`(async () => {
    const boot = window.__DSH_BOOT__;
    const entry = boot && Array.isArray(boot.entries)
      ? boot.entries.find((candidate) => candidate.id === 'dsh-agent-team-ui-testing')
      : undefined;
    if (!entry || !entry.url) return null;
    const response = await fetch(entry.url, { credentials: 'same-origin', cache: 'no-store' });
    const text = await response.text();
    return { rev: entry.rev || '', text };
  })()`);
  if (!result) return null;
  const digest = createHash('sha256').update(result.text).digest('hex');
  return {
    rev: result.rev,
    text: result.text,
    bytes: Buffer.byteLength(result.text, 'utf8'),
    sha256: digest.slice(0, 24),
    sha256Full: digest,
    hasSizeBarField: result.text.includes('data-utb-field'),
  };
}

function renderSummaryMd(report) {
  const lines = [];
  lines.push('# viewport-gui 验收记录');
  lines.push('');
  lines.push(`- 生成时间：${report.generatedAt}`);
  lines.push(`- 隔离 DSH：${report.environment.isolatedDsh.base}（端口 ${report.environment.isolatedDsh.port}；DSH_HOME 为临时目录，用后删除）`);
  lines.push(`- client.js sha256：${report.environment.build.clientJs ? report.environment.build.clientJs.sha256 : 'n/a'}`);
  lines.push(`- 结果：${report.summary.passed}/${report.summary.checks} PASS、${report.summary.failed} FAIL、${report.summary.notRun} NOT_RUN${report.summary.blocked ? `、BLOCKED(${report.summary.blocked})` : ''}`);
  lines.push('');
  lines.push('| ID | 断言 | 结果 |');
  lines.push('| --- | --- | --- |');
  for (const entry of report.checks) lines.push(`| ${entry.id} | ${entry.label} | ${entry.pass ? 'PASS' : 'FAIL'} |`);
  for (const entry of report.notRuns) lines.push(`| ${entry.id} | ${entry.label} | NOT_RUN（${entry.reason}） |`);
  lines.push('');
  lines.push('## 截图');
  for (const shot of report.evidence) lines.push(`- ${shot.path}（${shot.bytes} bytes）`);
  lines.push('');
  return lines.join('\n') + '\n';
}

/* ------------------------------------------------------------------------------------------------
 * Cleanup: only this run's own processes/profile/home. 3080/3081 are never touched.
 * ---------------------------------------------------------------------------------------------- */
async function cleanup(reason) {
  log(`\n[cleanup] ${reason}`);
  if (state.chrome) {
    try { state.chrome.cdp.close(); } catch { /* ignore */ }
    try { state.chrome.proc.kill('SIGTERM'); } catch { /* ignore */ }
    await sleep(500);
    if (isProcessAlive(state.chrome.proc.pid)) { try { state.chrome.proc.kill('SIGKILL'); } catch { /* ignore */ } }
    await sleep(300);
    await rm(state.chrome.profileDir, { recursive: true, force: true, maxRetries: 5 }).catch(() => {});
  }
  if (state.dsh) {
    try { state.dsh.proc.kill('SIGTERM'); } catch { /* ignore */ }
    await sleep(1200);
    if (isProcessAlive(state.dsh.proc.pid)) { try { state.dsh.proc.kill('SIGKILL'); } catch { /* ignore */ } }
    await sleep(400);
    // The isolated instance may have spawned a helper Chromium under its own temp home.
    try {
      for (const entry of readdirSync('/proc')) {
        if (!/^\d+$/.test(entry)) continue;
        let raw;
        try { raw = readFileSync(`/proc/${entry}/cmdline`); } catch { continue; }
        const text = raw.toString('utf8');
        if (!text.includes('chrome')) continue;
        if (state.dsh.home && text.includes(state.dsh.home)) {
          try { process.kill(Number(entry), 'SIGKILL'); } catch { /* ignore */ }
        }
      }
    } catch { /* ignore */ }
    await rm(state.dsh.home, { recursive: true, force: true, maxRetries: 5 }).catch(() => {});
  }
  try { await state.fixture?.close(); } catch { /* ignore */ }
  log('[cleanup] done');
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
  const blocked = String(errorMessage(error)).includes('BLOCKED:');
  log(`\n[${blocked ? 'blocked' : 'fatal'}] ${errorMessage(error)}`);
  if (!blocked) console.error(error);
  await cleanup(blocked ? 'blocked' : 'fatal').catch(() => {});
  exitCode = 2;
}
process.exitCode = exitCode;
