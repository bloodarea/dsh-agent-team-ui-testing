#!/usr/bin/env node
/**
 * Host-level acceptance for the DevTools popup (docs/internal/devtools-popup.md §3/§6).
 *
 * What it proves (fake Cordis ctx + the plugin's own real headless Chromium, harness.mjs):
 *   - cold scoped /state: ui.devtools = {available:false,url:null,pageGeneration:null,reason:'not-running'};
 *   - /ensure starts the plugin Chromium on a fixed loopback port with the exact allow-origin and
 *     publishes a URL whose port/targetId are exactly the host port and this runtime's owned target;
 *   - the inspector front end is served locally (200) and a *second* headless Chromium, loading that
 *     URL, connects over the allow-listed Origin and renders the target page's unique MARKER inside
 *     its recursive shadow DOM (a real connection, not just the front-end shell);
 *   - the DevTools front end's WebSocket points at the same page target;
 *   - screencast seq keeps advancing while DevTools is open and after it closes (ackFailures stays 0,
 *     page generation unchanged), and T2 snapshot/click still works after closing it;
 *   - legacy /state, /frame, /reload never carry ui.devtools; only the authenticated scoped GUI does;
 *   - browser_state / capabilities / metrics / logs carry no inspector URL, page WS or targetId
 *     (the pre-existing "chromium ready on devtools port N" / "page target <id> ready" startup
 *     lines are recorded as observations, not silently treated as new leaks);
 *   - a bounded retry with a fresh port/profile/process for (a) an explicit bind failure and
 *     (b) a foreign /json/version identity; only one Chrome of this run remains, old profiles gone.
 *
 * Run:  node tests/acceptance/devtools.mjs
 * Env:  DSH_ACCEPTANCE_CHROME / DSH_REAL_BROWSER_CHROME (default tests/acceptance/chrome-wrapper.sh),
 *       DSH_DEVTOOLS_TIMEOUT_MS (default 240000).
 * Exit codes: 0 pass (or environment NOT_RUN), 1 assertion failure, 2 unexpected fatal error.
 * Evidence: tests/acceptance/runs/devtools-<stamp>/ and tests/acceptance/evidence/devtools-<stamp>/.
 */
import { spawn } from 'node:child_process';
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = dirname(dirname(HERE));
const STAMP = new Date().toISOString().replace(/[:.]/g, '-');
const RUN_DIR = join(HERE, 'runs', `devtools-${STAMP}-${process.pid}`);
const EVIDENCE_DIR = join(HERE, 'evidence', `devtools-${STAMP}`);
const CHROME_BIN = process.env.DSH_ACCEPTANCE_CHROME || process.env.DSH_REAL_BROWSER_CHROME || join(HERE, 'chrome-wrapper.sh');
const CHROME_PROFILE_PREFIX = 'dsh-devtools-accept-';
const TOTAL_TIMEOUT_MS = Number(process.env.DSH_DEVTOOLS_TIMEOUT_MS || 240000) || 240000;
process.env.DSH_UI_TESTING_CHROME ||= CHROME_BIN;

const logLines = [];
function log(line = '') {
  const text = String(line);
  logLines.push(text);
  console.log(text);
}
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const errorMessage = (error) => String((error && error.stack) || (error && error.message) || error);

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
 * Check bookkeeping (runs/report.json; exit 1 on any failed check, 2 on fatal).
 * ---------------------------------------------------------------------------------------------- */
const checks = [];
const notRuns = [];
const observations = {};
function safeValue(value) {
  try {
    const text = JSON.stringify(value);
    return text === undefined ? String(value) : JSON.parse(text.replace(/[\u2028\u2029]/g, ' '));
  } catch { return String(value); }
}
function check(id, label, pass, expected, actual) {
  checks.push({ id, label, pass: Boolean(pass), expected: safeValue(expected), actual: safeValue(actual) });
  log(`  [${pass ? 'PASS' : 'FAIL'}] ${id} ${label}`);
  if (!pass) log(`         expected: ${JSON.stringify(expected)}\n         actual  : ${JSON.stringify(actual)}`);
  return Boolean(pass);
}
function notRun(id, label, reason, detail) {
  notRuns.push({ id, label, reason: String(reason), detail: safeValue(detail) });
  log(`  [NOT_RUN] ${id} ${label} — ${reason}`);
}

/* ------------------------------------------------------------------------------------------------
 * CDP client (Node 22 global WebSocket) for the second/viewer Chromium.
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

async function launchChrome(bin, label) {
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
    '--window-size=1280,900',
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
    }, { timeoutMs: 20000, label: `${label} DevToolsActivePort` });
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

async function evaluate(cdp, expression, { timeoutMs = 20000 } = {}) {
  const result = await cdp.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true }, timeoutMs);
  if (result.exceptionDetails) {
    const text = result.exceptionDetails.exception && result.exceptionDetails.exception.description
      ? result.exceptionDetails.exception.description : result.exceptionDetails.text;
    throw new Error('page evaluation failed: ' + String(text).slice(0, 400));
  }
  return result.result ? result.result.value : undefined;
}

/* ------------------------------------------------------------------------------------------------
 * /proc listener evidence (the same source the Host uses; independent readback here).
 * ---------------------------------------------------------------------------------------------- */
async function inspectListener(port) {
  const result = { found: false, loopback: [], external: [] };
  for (const [file, ipv6] of [['/proc/net/tcp', false], ['/proc/net/tcp6', true]]) {
    let text;
    try { text = await readFile(file, 'utf8'); } catch { continue; }
    for (const line of text.split('\n').slice(1)) {
      const fields = line.trim().split(/\s+/);
      if (fields.length < 4 || fields[3] !== '0A') continue;
      const local = fields[1];
      const separator = local.lastIndexOf(':');
      if (separator < 0) continue;
      if (Number.parseInt(local.slice(separator + 1), 16) !== port) continue;
      const address = local.slice(0, separator);
      result.found = true;
      const loopback = ipv6
        ? address === '00000000000000000000000001000000' || /^0{16}FFFF0000[0-9A-Fa-f]{6}7F$/.test(address)
        : /^[0-9A-Fa-f]{6}7F$/.test(address);
      (loopback ? result.loopback : result.external).push(address);
    }
  }
  return result;
}

/* ------------------------------------------------------------------------------------------------
 * Fixture page: unique marker + animated tick (screencast must keep flowing) + T2 button.
 * ---------------------------------------------------------------------------------------------- */
const MARKER = 'DEVTOOLS_ACCEPT_MARKER_' + Date.now().toString(36);
const fixture = createServer((req, res) => {
  res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
  res.end(`<!doctype html><html><head><meta charset="utf-8"><title>devtools acceptance</title></head>
<body><h1 id="marker">${MARKER}</h1><div id="tick">0</div>
<button id="hit" onclick="window.__hits = (window.__hits || 0) + 1; window.__trusted = event.isTrusted">hit</button>
<script>window.__hits = 0; setInterval(() => { const t = document.getElementById('tick'); t.textContent = String(Number(t.textContent) + 1); }, 50);</script>
</body></html>`);
});

/* ------------------------------------------------------------------------------------------------
 * Shared harness helpers.
 * ---------------------------------------------------------------------------------------------- */
const harnesses = [];
const runHostProfiles = new Set();
async function makeHarness(name) {
  const { createHarness, createFakeConnectionService, createFakeSessionsService } = await import(join(HERE, 'harness.mjs'));
  const dir = await mkdtemp(join(tmpdir(), 'dsh-devtools-ws-'));
  const connection = createFakeConnectionService({
    rejection: undefined,
    admit: { peer: { id: 'owner' } },
    browserPeer: { id: 'owner' },
  });
  const h = await createHarness({ name, connection, sessions: createFakeSessionsService({ cwd: dir }) });
  const headers = { 'x-ui-testing-scope-version': '1', 'x-ui-testing-session-id': 'sid-a' };
  const api = (method, action, body, extraHeaders) => h.request({
    method, path: '/plugins/ui-testing' + action, headers: extraHeaders ?? headers, body,
  });
  const exec = { agent: { id: 'sid-a', session: { header: { cwd: dir } } } };
  harnesses.push({ h, dir });
  return { h, api, exec, headers, dir, registry: h.ctx.__internal.plugin.registry };
}

function runtimeOf(registry, ui) {
  return registry.findByRuntimeId(ui && ui.runtimeId)?.runtime;
}

/**
 * Force deterministic DOM mutations on the target page so the screencast observation does not
 * depend on a background timer's throttling. Each mutation must produce a frame while the
 * screencast is alive; a stopped stream stays at the same seq even with page activity.
 */
async function nudgeTarget(h, exec, rounds = 6, gapMs = 200) {
  for (let round = 0; round < rounds; round += 1) {
    await h.invoke('browser_eval', {
      expression: `(() => { const t = document.getElementById('tick'); if (!t) return null; t.textContent = String(Number(t.textContent) + 1) + ':' + Date.now(); return t.textContent; })()`,
    }, exec);
    await sleep(gapMs);
  }
}

async function closeHarness(entry) {
  const index = harnesses.indexOf(entry);
  if (index >= 0) harnesses.splice(index, 1);
  const { h, dir } = entry;
  try { await h.request({ method: 'POST', path: '/plugins/ui-testing/close', headers: {}, body: {} }); } catch { /* ignore */ }
  try { await h.dispose(); } catch { /* ignore */ }
  await rm(dir, { recursive: true, force: true }).catch(() => {});
}

function killChromeProcesses(profileDirs) {
  for (const { pid, profileDir } of profileDirs) {
    try { process.kill(pid, 'SIGKILL'); } catch { /* already gone */ }
    log(`[cleanup] killed leftover acceptance Chromium pid=${pid} profile=${profileDir}`);
  }
}

/* ------------------------------------------------------------------------------------------------
 * Scenarios.
 * ---------------------------------------------------------------------------------------------- */
async function main() {
  if (!existsSync(CHROME_BIN)) {
    notRun('ENV', 'headless Chromium', `chrome binary/wrapper missing: ${CHROME_BIN}`);
    return 0;
  }
  await mkdir(RUN_DIR, { recursive: true });
  await mkdir(EVIDENCE_DIR, { recursive: true });
  await new Promise((resolve) => fixture.listen(0, '127.0.0.1', resolve));
  const fixtureUrl = `http://127.0.0.1:${fixture.address().port}/`;
  observations.fixtureUrl = fixtureUrl;
  observations.marker = MARKER;
  log(`[env] fixture: ${fixtureUrl}`);
  log(`[env] chrome: ${CHROME_BIN}`);
  log(`[env] run: ${RUN_DIR}`);
  const { scanPluginChromeProcesses } = await import(join(HERE, 'harness.mjs'));
  const baselineChromes = scanPluginChromeProcesses().map((entry) => entry.pid);
  let viewer;
  let primary;

  try {
   try {
    /* ---- S1 cold ---- */
    primary = await makeHarness('devtools-host');
    const { h, api, exec, registry } = primary;
    log('\n--- S1 cold projection ---');
    const cold = await api('GET', '/state');
    check('H1.1', 'cold scoped /state is 200 with ui.version=1', cold.statusCode === 200 && cold.json?.ui?.version === 1,
      { status: 200, uiVersion: 1 }, { status: cold.statusCode, uiVersion: cold.json?.ui?.version });
    const coldDevtools = cold.json?.ui?.devtools;
    check('H1.2', 'cold ui.devtools = {available:false,url:null,pageGeneration:null,reason:not-running}',
      coldDevtools?.available === false && coldDevtools?.url === null && coldDevtools?.pageGeneration === null
      && coldDevtools?.reason === 'not-running', { available: false, url: null, pageGeneration: null, reason: 'not-running' }, coldDevtools);
    const hostCold = registry.browserHost();
    check('H1.3', 'cold /state did not start a Chromium process or profile',
      !hostCold.proc && !hostCold.profileDir, { proc: false, profileDir: false }, { proc: Boolean(hostCold.proc), profileDir: Boolean(hostCold.profileDir) });
    const coldStateTool = await h.invoke('browser_state', {}, exec);
    check('H1.4', 'cold browser_state value has no devtools field',
      coldStateTool.ok && !JSON.stringify(coldStateTool.value).includes('devtools'), { devtools: 'absent' }, { keys: Object.keys(coldStateTool.value || {}) });

    /* ---- S2 ensure + projection + listener/args ---- */
    log('\n--- S2 fixed port, URL ownership, local front end ---');
    const ensured = await api('POST', '/ensure', { url: fixtureUrl });
    check('H2.1', 'scoped /ensure is 200', ensured.statusCode === 200, { status: 200 }, { status: ensured.statusCode, body: ensured.body.slice(0, 300) });
    await waitFor(async () => (await api('GET', '/state')).json?.ui?.devtools?.available === true,
      { timeoutMs: 15000, label: 'ui.devtools.available' });
    const state = await api('GET', '/state');
    const ui = state.json?.ui || {};
    const devtools = ui.devtools;
    const runtime = runtimeOf(registry, ui);
    const host = registry.browserHost();
    runHostProfiles.add(host.profileDir);
    observations.hostPort = host.port;
    observations.targetId = runtime?.page?.targetId;
    observations.devtools = devtools;
    check('H2.2', 'running ui.devtools.available=true, url is a string, reason=null',
      devtools?.available === true && typeof devtools?.url === 'string' && devtools?.reason === null,
      { available: true, url: 'string', reason: null }, devtools);
    check('H2.3', 'ui.devtools.pageGeneration equals runtime.page.generation',
      devtools?.pageGeneration === runtime?.page?.generation, runtime?.page?.generation, devtools?.pageGeneration);
    check('H2.4', 'URL port equals the actual host.port', new URL(devtools?.url || 'http://x').port === String(host.port),
      String(host.port), new URL(devtools?.url || 'http://x').port);
    const parsed = new URL(devtools?.url || 'http://x');
    const wsValue = parsed.searchParams.get('ws');
    check('H2.5', 'URL shape: /devtools/inspector.html + one ws param pointing at this runtime target',
      parsed.pathname === '/devtools/inspector.html' && [...parsed.searchParams.keys()].length === 1
      && wsValue === `127.0.0.1:${host.port}/devtools/page/${runtime?.page?.targetId}`,
      { pathname: '/devtools/inspector.html', ws: `127.0.0.1:${host.port}/devtools/page/${runtime?.page?.targetId}` },
      { pathname: parsed.pathname, ws: wsValue });
    const owned = host.ownedTargets.get(runtime?.page?.targetId);
    check('H2.6', 'ownedTargets binds this runtime + host generation',
      owned?.runtime === runtime && owned?.generation === runtime?.page?.generation && host.generation === runtime?.page?.generation,
      { runtime: true, generation: runtime?.page?.generation },
      { runtime: Boolean(owned?.runtime), ownedGeneration: owned?.generation, hostGeneration: host.generation });
    const inspector = await fetch(devtools.url);
    const inspectorText = await inspector.text();
    observations.inspector = { status: inspector.status, contentType: inspector.headers.get('content-type'), bytes: inspectorText.length };
    check('H2.7', 'inspector.html is served locally with 200 HTML', inspector.status === 200
      && /text\/html/i.test(inspector.headers.get('content-type') || '') && inspectorText.length > 500,
      { status: 200, type: 'text/html', bytes: '>500' }, observations.inspector);
    check('H2.8', 'explicit fixed port means no DevToolsActivePort file (Chrome 152 fact)',
      !existsSync(join(host.profileDir, 'DevToolsActivePort')), false, existsSync(join(host.profileDir, 'DevToolsActivePort')));
    const cmdline = (await readFile(`/proc/${host.proc.pid}/cmdline`, 'utf8')).split('\0').filter(Boolean);
    const args = {
      address: cmdline.includes('--remote-debugging-address=127.0.0.1'),
      port: cmdline.includes(`--remote-debugging-port=${host.port}`),
      allowOrigin: cmdline.includes(`--remote-allow-origins=http://127.0.0.1:${host.port}`),
      wildcard: cmdline.some((arg) => arg === '--remote-allow-origins=*'),
      portZero: cmdline.some((arg) => arg === '--remote-debugging-port=0'),
    };
    observations.processArgs = args;
    check('H2.9', 'process args: loopback address + exact port + exact allow-origin, never * or port 0',
      args.address && args.port && args.allowOrigin && !args.wildcard && !args.portZero,
      { address: true, port: true, allowOrigin: true, wildcard: false, portZero: false }, args);
    const listener = await inspectListener(host.port);
    observations.listener = listener;
    check('H2.10', 'actual listener is loopback only (no 0.0.0.0/::)', listener.found && listener.loopback.length > 0 && listener.external.length === 0,
      { found: true, loopback: '>0', external: [] }, listener);

    /* ---- S3 scoped-only projection + no leaks ---- */
    log('\n--- S3 scoped-only projection and leak checks ---');
    const legacyState = await h.request({ method: 'GET', path: '/plugins/ui-testing/state', headers: {} });
    check('H3.1', 'legacy /state 200 and ui.devtools omitted', legacyState.statusCode === 200 && !('devtools' in (legacyState.json?.ui || {})),
      { status: 200, devtools: 'absent' }, { status: legacyState.statusCode, keys: Object.keys(legacyState.json?.ui || {}) });
    const scopedReload = await api('POST', '/reload', {});
    check('H3.2', 'scoped /reload carries ui.devtools.available=true',
      scopedReload.statusCode === 200 && scopedReload.json?.state?.ui?.devtools?.available === true,
      { status: 200, available: true }, { status: scopedReload.statusCode, devtools: scopedReload.json?.state?.ui?.devtools });
    const legacyEnsure = await h.request({ method: 'POST', path: '/plugins/ui-testing/ensure', headers: {}, body: { url: fixtureUrl } });
    const legacyReload = await h.request({ method: 'POST', path: '/plugins/ui-testing/reload', headers: {}, body: {} });
    check('H3.3', 'legacy /ensure + /reload are 200 and their ui has no devtools',
      legacyEnsure.statusCode === 200 && legacyReload.statusCode === 200 && !('devtools' in (legacyReload.json?.state?.ui || {})),
      { ensure: 200, reload: 200, devtools: 'absent' },
      { ensure: legacyEnsure.statusCode, reload: legacyReload.statusCode, keys: Object.keys(legacyReload.json?.state?.ui || {}) });
    const scopedFrame = await api('GET', '/frame?since=0');
    check('H3.4', 'scoped /frame carries ui.devtools', scopedFrame.statusCode === 200
      && scopedFrame.json?.state?.ui?.devtools?.available === true,
      { status: 200, available: true }, { status: scopedFrame.statusCode, devtools: scopedFrame.json?.state?.ui?.devtools });
    const legacyFrame = await h.request({ method: 'GET', path: '/plugins/ui-testing/frame?since=0', headers: {} });
    check('H3.5', 'legacy /frame omits ui.devtools', legacyFrame.statusCode === 200
      && !('devtools' in (legacyFrame.json?.state?.ui || {})),
      { status: 200, devtools: 'absent' }, { status: legacyFrame.statusCode, keys: Object.keys(legacyFrame.json?.state?.ui || {}) });

    const leaks = {
      inspector: /devtools\/inspector|devtools\/page|webSocketDebuggerUrl|remote-debugging|devtools\/browser/,
      targetId: runtime?.page?.targetId ? new RegExp(String(runtime.page.targetId)) : /$^/,
    };
    const stateTool = await h.invoke('browser_state', {}, exec);
    const stateText = JSON.stringify(stateTool.value);
    check('H3.6', 'browser_state value has no inspector/page WS/remote-debugging leak',
      stateTool.ok && !leaks.inspector.test(stateText), { leak: false }, { matched: stateText.match(leaks.inspector)?.[0] || null });
    const capabilities = await h.invoke('browser_capabilities', {}, exec);
    const capabilitiesText = JSON.stringify(capabilities.value);
    check('H3.7', 'capabilities value has no inspector/page WS/remote-debugging leak',
      capabilities.ok && !leaks.inspector.test(capabilitiesText), { leak: false }, { matched: capabilitiesText.match(leaks.inspector)?.[0] || null });
    const metrics = await api('GET', '/metrics');
    const metricsText = JSON.stringify(metrics.json);
    check('H3.8', 'metrics has no inspector/page WS/remote-debugging/targetId',
      metrics.statusCode === 200 && !leaks.inspector.test(metricsText) && !leaks.targetId.test(metricsText),
      { leak: false }, { inspector: metricsText.match(leaks.inspector)?.[0] || null, targetId: metricsText.match(leaks.targetId)?.[0] || null });
    const logText = h.logs.join('\n');
    const logInspector = logText.match(leaks.inspector)?.[0] || null;
    const portLines = h.logs.filter((line) => line.includes(String(host.port)));
    const targetIdLines = h.logs.filter((line) => String(line).includes(String(runtime?.page?.targetId)));
    observations.logs = { lines: h.logs.length, logInspector, portLines, targetIdLines };
    check('H3.9', 'plugin logs have no inspector/page WS/remote-debugging URL', logInspector === null, null, logInspector);
    // The two pre-existing startup lines (present before this feature) name the port / target id.
    // They are recorded instead of being silently called "no leak"; no new line was added.
    const onlyPreexisting = portLines.every((line) => /^chromium ready on devtools port \d+ \(generation \d+\)$/.test(String(line)))
      && targetIdLines.every((line) => /^page target [A-Za-z0-9]+ ready \(generation \d+\)$/.test(String(line)));
    if (onlyPreexisting) {
      check('H3.10', 'no NEW port/targetId-bearing log line (only the pre-existing startup lines remain)',
        portLines.length === 1 && targetIdLines.length === 1,
        { portLines: 1, targetIdLines: 1, newLeak: false }, { portLines, targetIdLines });
    } else {
      notRun('H3.10', 'no NEW port/targetId-bearing log line',
        '日志中出现了非既有启动行的 port/targetId；需人工复核是否新增泄漏', { portLines, targetIdLines });
    }

    /* ---- S4 real DevTools connection in a second Chromium ---- */
    log('\n--- S4 second headless Chromium connects to the real target ---');
    viewer = await launchChrome(CHROME_BIN, 'viewer');
    const webSocketEvents = [];
    viewer.cdp.on((message) => {
      if (message.method === 'Network.webSocketCreated') webSocketEvents.push(message.params);
    });
    await viewer.cdp.send('Page.enable');
    await viewer.cdp.send('Runtime.enable');
    await viewer.cdp.send('Network.enable');
    const loaded = new Promise((resolve) => {
      const off = viewer.cdp.on((message) => {
        if (message.method === 'Page.loadEventFired') { off(); resolve(true); }
      });
      setTimeout(resolve, 15000, false);
    });
    await viewer.cdp.send('Page.navigate', { url: devtools.url });
    await loaded;
    const SHADOW_TEXT = `(() => {
      const walk = (root, out) => {
        for (const node of root.querySelectorAll('*')) if (node.shadowRoot) walk(node.shadowRoot, out);
        out.push(root.textContent || '');
        return out;
      };
      return walk(document, []).join('\\n');
    })()`;
    let shadowText = '';
    let markerFound = false;
    const startedAt = Date.now();
    while (Date.now() - startedAt < 20000) {
      shadowText = String(await evaluate(viewer.cdp, SHADOW_TEXT) || '');
      if (shadowText.includes(MARKER)) { markerFound = true; break; }
      await sleep(500);
    }
    observations.shadow = { bytes: shadowText.length, markerFound, head: shadowText.slice(0, 200) };
    await writeFile(join(EVIDENCE_DIR, 'devtools-shadow-text.txt'), shadowText);
    check('H4.1', 'DevTools front end connected: target MARKER appears in recursive shadow DOM', markerFound,
      { marker: MARKER }, { markerFound, bytes: shadowText.length });
    const wsPage = webSocketEvents.find((event) => String(event.url || '').includes('/devtools/page/'));
    check('H4.2', 'front end WebSocket points at this runtime page target', Boolean(wsPage)
      && String(wsPage.url).includes(`/devtools/page/${runtime?.page?.targetId}`),
      `/devtools/page/${runtime?.page?.targetId}`, wsPage ? wsPage.url : null);
    const shot = await viewer.cdp.send('Page.captureScreenshot', { format: 'png' });
    await writeFile(join(EVIDENCE_DIR, 'devtools-frontend.png'), Buffer.from(shot.data, 'base64'));
    await writeFile(join(RUN_DIR, 'devtools-frontend.png'), Buffer.from(shot.data, 'base64'));
    check('H4.3', 'front-end screenshot captured', Boolean(shot.data) && shot.data.length > 1000, { bytes: '>1000' }, { bytes: shot.data.length });
    const pageCountOpen = host.pageCount;
    check('H4.4', 'opening DevTools did not add a Host page target', pageCountOpen === 2, 2, pageCountOpen);

    /* ---- S5 screencast coexistence ---- */
    log('\n--- S5 screencast coexistence ---');
    const seqBefore = Number((await api('GET', '/state')).json?.seq || 0);
    const generationBefore = (await api('GET', '/state')).json?.ui?.annotationContext?.pageGeneration;
    const metricsBefore = (await api('GET', '/metrics')).json;
    // The fixture also has a timer, but a hidden/background page can throttle it; explicit DOM
    // mutations make "screencast is still running" deterministic without changing the Host.
    await nudgeTarget(h, exec, 6, 200);
    const seqOpen = Number((await api('GET', '/state')).json?.seq || 0);
    const metricsOpen = (await api('GET', '/metrics')).json;
    observations.screencast = {
      seqBefore, seqOpen, generationBefore,
      ackFailuresBefore: metricsBefore?.host?.ackFailures,
      ackFailuresOpen: metricsOpen?.host?.ackFailures,
    };
    check('H5.1', 'screencast seq advances while DevTools is open', seqOpen > seqBefore, `> ${seqBefore}`, seqOpen);
    check('H5.2', 'page generation unchanged while DevTools is open',
      (await api('GET', '/state')).json?.ui?.annotationContext?.pageGeneration === generationBefore,
      generationBefore, (await api('GET', '/state')).json?.ui?.annotationContext?.pageGeneration);
    check('H5.3', 'no new screencast ACK failures', Number(metricsOpen?.host?.ackFailures || 0) === Number(metricsBefore?.host?.ackFailures || 0),
      metricsBefore?.host?.ackFailures, metricsOpen?.host?.ackFailures);
    viewer.cdp.close();
    try { viewer.proc.kill('SIGKILL'); } catch { /* ignore */ }
    await rm(viewer.profileDir, { recursive: true, force: true }).catch(() => {});
    viewer = undefined;
    await nudgeTarget(h, exec, 6, 200);
    const seqAfter = Number((await api('GET', '/state')).json?.seq || 0);
    observations.screencast.seqAfter = seqAfter;
    check('H5.4', 'screencast seq keeps advancing after DevTools closes', seqAfter > seqOpen, `> ${seqOpen}`, seqAfter);

    /* ---- S6 T2 still works after closing DevTools ---- */
    log('\n--- S6 T2 after DevTools closes ---');
    const snapshot = await h.invoke('browser_snapshot', {}, exec);
    check('H6.1', 'T2 snapshot works after DevTools closed', snapshot.ok === true,
      { ok: true }, { ok: snapshot.ok, code: snapshot.error?.code, message: snapshot.error?.message });
    const click = await h.invoke('browser_click', { selector: '#hit' }, exec);
    check('H6.2', 'T2 trusted click works after DevTools closed', click.ok === true,
      { ok: true }, { ok: click.ok, code: click.error?.code, message: click.error?.message });
    const counters = await h.invoke('browser_eval', { expression: '({ hits: window.__hits, trusted: window.__trusted })' }, exec);
    check('H6.3', 'target page counted exactly one trusted click',
      counters.ok === true && counters.value?.value?.hits === 1 && counters.value?.value?.trusted === true,
      { hits: 1, trusted: true }, counters.value?.value);

    /* ---- S7 close returns to unavailable ---- */
    log('\n--- S7 close -> unavailable ---');
    const closed = await api('POST', '/close', {});
    const afterClose = await api('GET', '/state');
    observations.coldAfterClose = afterClose.json?.ui?.devtools;
    check('H7.1', 'scoped /close is 200', closed.statusCode === 200, { status: 200 }, { status: closed.statusCode });
    check('H7.2', 'after close ui.devtools={available:false,url:null,reason:not-running}',
      afterClose.json?.ui?.devtools?.available === false && afterClose.json?.ui?.devtools?.url === null
      && afterClose.json?.ui?.devtools?.reason === 'not-running',
      { available: false, url: null, reason: 'not-running' }, afterClose.json?.ui?.devtools);
    await closeHarness(primary);
    primary = undefined;

    /* ---- S8 bounded retry: bind failure and foreign endpoint identity ---- */
    log('\n--- S8 bounded retry (bind failure / endpoint mismatch) ---');
    await runRetryScenario('bind-failure', { fake: false, fixtureUrl });
    await runRetryScenario('endpoint-mismatch', { fake: true, fixtureUrl });
   } catch (error) {
     check('SUITE.1', 'scenarios completed without an uncaught exception', false, 'no exception', errorMessage(error));
   }
  } finally {
    if (viewer) {
      viewer.cdp.close();
      try { viewer.proc.kill('SIGKILL'); } catch { /* ignore */ }
      await rm(viewer.profileDir, { recursive: true, force: true }).catch(() => {});
    }
    if (primary) await closeHarness(primary);
    for (const entry of harnesses) await closeHarness(entry);
    await new Promise((resolve) => fixture.close(resolve));
    // Only processes whose profile belongs to this run are killed; pre-existing browsers are untouched.
    const leftovers = scanPluginChromeProcesses().filter((entry) => runHostProfiles.has(entry.profileDir)
      || (String(entry.profileDir).includes(CHROME_PROFILE_PREFIX) && !baselineChromes.includes(entry.pid)));
    killChromeProcesses(leftovers);
  }

  const failed = checks.filter((entry) => !entry.pass).length;
  const report = {
    suite: 'devtools-host',
    startedAt: STAMP,
    finishedAt: new Date().toISOString(),
    chrome: CHROME_BIN,
    fixtureUrl,
    marker: MARKER,
    checks,
    notRuns,
    observations,
    failed,
  };
  await writeFile(join(RUN_DIR, 'report.json'), JSON.stringify(report, null, 2));
  await writeFile(join(RUN_DIR, 'run.log'), logLines.join('\n') + '\n');
  await writeFile(join(EVIDENCE_DIR, 'report.json'), JSON.stringify(report, null, 2));
  log(`\ndevtools-host: ${checks.length - failed}/${checks.length} PASS, ${failed} failed, ${notRuns.length} NOT_RUN`);
  log(`evidence: ${RUN_DIR}`);
  return failed === 0 ? 0 : 1;
}

/**
 * One bounded-retry scenario. A generated wrapper fails the first invocation (explicit bind error,
 * or a fake /json/version whose browser id differs from its stderr identity) and execs the real
 * Chromium on the second. The plugin must pick a new port, clean the failed profile/process, and
 * publish a working URL in under 30s.
 */
async function runRetryScenario(name, { fake, fixtureUrl }) {
  const wrapperPath = join(RUN_DIR, `retry-${name}.sh`);
  const invocationsPath = join(RUN_DIR, `retry-${name}-invocations.txt`);
  const markerPath = join(RUN_DIR, `retry-${name}.marker`);
  const fakePath = join(RUN_DIR, 'fake-devtools-endpoint.mjs');
  if (fake) {
    await writeFile(fakePath, `import http from 'node:http';
const args = process.argv.slice(2);
const portArg = args.find((arg) => arg.startsWith('--remote-debugging-port='));
const port = Number(portArg ? portArg.split('=')[1] : 0);
const httpId = 'HTTPIDENTITY' + 'A'.repeat(24);
const stderrId = 'STDERRIDENTITY' + 'B'.repeat(24);
const server = http.createServer((req, res) => {
  if (req.url === '/json/version') {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ Browser: 'Fake/1.0', webSocketDebuggerUrl: 'ws://127.0.0.1:' + port + '/devtools/browser/' + httpId }));
    return;
  }
  res.writeHead(404); res.end();
});
server.listen(port, '127.0.0.1', () => {
  console.error('DevTools listening on ws://127.0.0.1:' + port + '/devtools/browser/' + stderrId);
});
`);
  }
  const firstCommand = fake ? `exec "$DSH_ACCEPT_NODE" "$DSH_ACCEPT_FAKE" "$@"` : 'echo "ERROR:devtools_http_handler.cc(1)] Failed to bind socket" >&2; exit 1';
  await writeFile(wrapperPath, `#!/bin/sh
echo "$@" >> "$DSH_ACCEPT_INVOCATIONS"
if [ ! -e "$DSH_ACCEPT_MARKER" ]; then
  touch "$DSH_ACCEPT_MARKER"
  ${firstCommand}
fi
exec "$DSH_ACCEPT_REAL_CHROME" "$@"
`);
  await chmod(wrapperPath, 0o755);
  await rm(markerPath, { force: true }).catch(() => {});
  await rm(invocationsPath, { force: true }).catch(() => {});
  process.env.DSH_ACCEPT_INVOCATIONS = invocationsPath;
  process.env.DSH_ACCEPT_MARKER = markerPath;
  process.env.DSH_ACCEPT_REAL_CHROME = CHROME_BIN;
  process.env.DSH_ACCEPT_NODE = process.execPath;
  process.env.DSH_ACCEPT_FAKE = fakePath;
  process.env.DSH_UI_TESTING_CHROME = wrapperPath;
  const entry = await makeHarness(`retry-${name}`);
  try {
    const startedAt = Date.now();
    const ensured = await entry.api('POST', '/ensure', { url: fixtureUrl });
    const elapsedMs = Date.now() - startedAt;
    const state = await entry.api('GET', '/state');
    const host = entry.registry.browserHost();
    runHostProfiles.add(host.profileDir);
    const invocations = existsSync(invocationsPath)
      ? (await readFile(invocationsPath, 'utf8')).trim().split('\n').filter(Boolean) : [];
    const ports = invocations.map((line) => /--remote-debugging-port=(\d+)/.exec(line)?.[1]).filter(Boolean);
    const profileDirs = invocations.map((line) => /--user-data-dir=([^\s]+)/.exec(line)?.[1]).filter(Boolean);
    const failedProfilesRemain = profileDirs.slice(0, -1).filter((dir) => existsSync(dir));
    const { scanPluginChromeProcesses } = await import(join(HERE, 'harness.mjs'));
    const live = scanPluginChromeProcesses().filter((item) => item.profileDir === host.profileDir);
    const evidence = {
      ensuredStatus: ensured.statusCode, elapsedMs, invocations: invocations.length, ports,
      failedProfilesRemain, liveProcesses: live.length, hostPort: host.port, devtools: state.json?.ui?.devtools,
    };
    observations[`retry-${name}`] = evidence;
    check(`H8.${name === 'bind-failure' ? '1' : '4'}`, `${name}: /ensure succeeds after a bounded retry`,
      ensured.statusCode === 200 && state.json?.ui?.devtools?.available === true, { status: 200, available: true }, evidence);
    check(`H8.${name === 'bind-failure' ? '2' : '5'}`, `${name}: two invocations on two distinct candidate ports`,
      invocations.length === 2 && ports.length === 2 && ports[0] !== ports[1], { invocations: 2, distinctPorts: true },
      { invocations: invocations.length, ports });
    check(`H8.${name === 'bind-failure' ? '3' : '6'}`, `${name}: failed attempt profile removed, exactly one plugin Chrome left, <30s`,
      failedProfilesRemain.length === 0 && live.length === 1 && elapsedMs < 30000,
      { failedProfiles: 0, live: 1, underMs: 30000 }, { failedProfilesRemain, live: live.length, elapsedMs });
    await writeFile(join(EVIDENCE_DIR, `retry-${name}-invocations.txt`), invocations.join('\n'));
    await writeFile(join(EVIDENCE_DIR, `retry-${name}-logs.txt`), entry.h.logs.join('\n'));
    await entry.api('POST', '/close', {});
  } finally {
    await closeHarness(entry);
    process.env.DSH_UI_TESTING_CHROME = CHROME_BIN;
  }
}

let fatal = 0;
const timeout = setTimeout(() => {
  fatal = 2;
  log(`[fatal] total timeout ${TOTAL_TIMEOUT_MS}ms exceeded`);
  process.exit(2);
}, TOTAL_TIMEOUT_MS);
timeout.unref?.();
try {
  const code = await main();
  clearTimeout(timeout);
  process.exit(code);
} catch (error) {
  clearTimeout(timeout);
  log('[fatal] ' + errorMessage(error));
  try {
    await writeFile(join(RUN_DIR, 'run.log'), logLines.join('\n') + '\n');
  } catch { /* ignore */ }
  process.exit(2);
}
