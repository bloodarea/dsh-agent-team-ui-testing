#!/usr/bin/env node
/**
 * Workspace-isolation acceptance against the real isolated DSH host on 127.0.0.1:3081.
 *
 * This script NEVER restarts or starts a DSH server and NEVER touches 3080. Restarting 3081 so
 * the workspace index.js/frame-push.js changes are loaded is a separate, Lead-coordinated step.
 *
 * Authentication:
 *  - HTTP requests exchange the launch-token URL (read from /tmp/dsh-3081.log, memory only) for a
 *    browser-session cookie.
 *  - Scoped WS is owner-only and Node's WebSocket cannot send a Cookie header, so the WS checks
 *    run inside a real headless Chrome page (chrome-wrapper + CDP): the browser navigates the
 *    token URL, gets the cookie, then the page opens `new WebSocket('/plugins/ui-testing/frames…')`
 *    same-origin (cookie is sent automatically) and records hello + binary frame headers.
 *    The token URL is never printed or written to evidence.
 *
 * DSH_HOME: the isolated home must be explicit — `--home=<dir>` or `DSH_3081_HOME`, otherwise it
 * is read from the listener process environment. The caller's DSH_HOME is NEVER used, and there is
 * no /tmp/dsh-iso fallback.
 *
 * Scopes: one real registered workspace session (scopeVersion=1 + session id) and the explicit
 * `unassigned` scope (the isolated home currently has one workspace/session; real two-GUI-workspace
 * binding is covered by the client acceptance script). The limitation is recorded in the report.
 *
 * Report: tests/acceptance/runs/host-3081-workspace-<timestamp>/report.json
 */
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { readFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { startFixtureServer } from '../ui_test_fixture/server.mjs';
import { Cdp } from '../../browser-safety.js';

if (process.argv[1] !== fileURLToPath(import.meta.url)) {
  throw new Error('workspace-isolation-3081.mjs drives the real 3081 host (navigate/close); it must be executed directly, never imported.');
}

const base = 'http://127.0.0.1:3081';
const route = base + '/plugins/ui-testing';
const logPath = process.env.DSH_3081_LOG || '/tmp/dsh-3081.log';
const chromeBin = process.env.DSH_UI_TESTING_CHROME || fileURLToPath(new URL('./chrome-wrapper.sh', import.meta.url));
const checks = [];
const observations = [];
let failed = 0;
const sleep = (ms) => new Promise((resolve) => { setTimeout(resolve, ms); });

function check(label, condition, evidence) {
  const pass = Boolean(condition);
  checks.push({ label, pass, evidence });
  if (!pass) failed += 1;
  console.log(`${pass ? 'PASS' : 'FAIL'} ${label}`);
  if (!pass) console.log('  evidence: ' + JSON.stringify(evidence).slice(0, 2500));
}
function observe(label, value) { observations.push({ label, value }); console.log('OBS ' + label + ': ' + JSON.stringify(value)); }

let cookie = '';
const scopeHeaders = (identity = {}) => {
  if (identity.headers) return { ...identity.headers };
  const headers = { 'x-ui-testing-scope-version': '1' };
  if (identity.sid) headers['x-ui-testing-session-id'] = identity.sid;
  if (identity.scope) headers['x-ui-testing-scope'] = identity.scope;
  if (identity.binding) headers['x-ui-testing-scope-binding'] = identity.binding;
  return headers;
};
async function request(path, { method = 'GET', body, identity, auth = true, headers } = {}) {
  const all = { ...(headers !== undefined ? headers : (identity ? scopeHeaders(identity) : {})) };
  if (auth && cookie) all.cookie = cookie;
  if (body !== undefined) all['content-type'] = 'application/json';
  const response = await fetch(route + path, { method, headers: all, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  let json;
  try { json = await response.json(); } catch { json = undefined; }
  return { status: response.status, json };
}
function sha256(text) { return createHash('sha256').update(text).digest('hex'); }

/** Listener identity/loaded-build evidence, without restarting anything. */
function listenerInfo() {
  const info = { pid: null, startedAt: null, startedAtEpoch: null, dshHome: null };
  try {
    const ss = execFileSync('ss', ['-ltnp', 'sport = :3081'], { encoding: 'utf8' });
    const match = /pid=(\d+)/.exec(ss);
    if (match) info.pid = Number(match[1]);
  } catch { /* ss unavailable */ }
  if (!info.pid) {
    // `ss -p` may be unavailable inside the sandbox: find the listener by its command line.
    try {
      for (const entry of readdirSync('/proc')) {
        if (!/^\d+$/.test(entry)) continue;
        let args;
        try { args = readFileSync(`/proc/${entry}/cmdline`, 'utf8').split('\0').filter(Boolean); } catch { continue; }
        if (!args.some((arg) => arg === 'web') || !args.includes('--port') || args[args.indexOf('--port') + 1] !== '3081') continue;
        info.pid = Number(entry);
        break;
      }
    } catch { /* ignore */ }
  }
  if (info.pid) {
    try {
      info.startedAt = execFileSync('ps', ['-o', 'lstart=', '-p', String(info.pid)], {
        encoding: 'utf8', env: { ...process.env, LC_ALL: 'C', LANG: 'C' },
      }).trim();
      const parsed = Date.parse(info.startedAt);
      if (Number.isFinite(parsed)) info.startedAtEpoch = parsed;
    } catch { /* ignore */ }
    try {
      const environ = readFileSync(`/proc/${info.pid}/environ`, 'utf8');
      const line = environ.split('\0').find((item) => item.startsWith('DSH_HOME='));
      if (line) info.dshHome = line.slice('DSH_HOME='.length);
    } catch { /* ignore */ }
  }
  return info;
}

/** Explicit isolated home only: --home / DSH_3081_HOME / listener env. Never the caller's DSH_HOME. */
function resolveHome(info) {
  const cli = process.argv.find((arg) => arg.startsWith('--home='));
  if (cli) return { home: cli.slice('--home='.length), source: 'cli --home' };
  if (process.env.DSH_3081_HOME) return { home: process.env.DSH_3081_HOME, source: 'env DSH_3081_HOME' };
  if (info.dshHome) return { home: info.dshHome, source: 'listener /proc/<pid>/environ' };
  throw new Error('cannot determine the 3081 isolated DSH_HOME; pass --home=<dir> or set DSH_3081_HOME (the caller DSH_HOME and /tmp/dsh-iso are intentionally not used)');
}

async function discoverScopes(dshHome) {
  const workspaces = [];
  try {
    const store = JSON.parse(await readFile(join(dshHome, 'storages', 'workspace.json'), 'utf8'));
    for (const [id, workspace] of Object.entries(store?.tables?.workspaces || {})) {
      workspaces.push({ id, path: workspace.path, title: workspace.title, sessionIds: workspace.sessionIds || [] });
    }
  } catch (error) {
    observe('workspace store unreadable', String((error && error.message) || error));
  }
  const sessions = [];
  try {
    for (const dir of await readdir(join(dshHome, 'sessions'))) {
      const sub = await readdir(join(dshHome, 'sessions', dir));
      for (const entry of sub) {
        if (/^session-[0-9a-f-]{36}$/.test(entry)) sessions.push({ id: entry, workspaceDir: dir });
      }
    }
  } catch { /* no store */ }
  const scopes = [];
  for (const workspace of workspaces) {
    const sid = workspace.sessionIds[0] || sessions.find((session) => workspace.path && session.workspaceDir.includes(workspace.path.replace(/[^a-zA-Z0-9]+/g, '-')))?.id;
    if (sid) scopes.push({ kind: 'workspace', workspaceId: workspace.id, path: workspace.path, sid });
  }
  return { scopes, sessions: sessions.length, workspaces: workspaces.length };
}

/* ------------------------------------------------------------------ real browser for scoped WS */
async function launchChrome() {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-utb-3081-chrome-'));
  const proc = spawn(chromeBin, [
    '--headless=new', '--remote-debugging-port=0', `--user-data-dir=${dir}`,
    '--no-first-run', '--no-default-browser-check', '--disable-gpu', '--hide-scrollbars', '--mute-audio',
    'about:blank',
  ], { stdio: ['ignore', 'ignore', 'pipe'] });
  let port = 0;
  for (let attempt = 0; attempt < 100 && !port; attempt += 1) {
    try { port = Number((await readFile(join(dir, 'DevToolsActivePort'), 'utf8')).split('\n')[0]) || 0; } catch { /* not ready */ }
    if (!port) await sleep(100);
  }
  if (!port) { try { proc.kill('SIGKILL'); } catch { /* ignore */ } throw new Error('headless Chrome did not start for scoped WS'); }
  const version = await fetch(`http://127.0.0.1:${port}/json/version`).then((response) => response.json());
  const browser = new Cdp(version.webSocketDebuggerUrl);
  await browser.connect();
  const list = await fetch(`http://127.0.0.1:${port}/json/list`).then((response) => response.json());
  const page = list.find((target) => target.type === 'page');
  if (!page) throw new Error('headless Chrome has no page target');
  const cdp = new Cdp(page.webSocketDebuggerUrl);
  await cdp.connect();
  return { proc, dir, cdp, browser };
}
async function closeChrome(chrome) {
  if (!chrome) return;
  try { await chrome.browser.send('Browser.close', {}, { timeoutMs: 2000 }); } catch { /* ignore */ }
  try { chrome.cdp.close(); chrome.browser.close(); } catch { /* ignore */ }
  try { chrome.proc.kill('SIGTERM'); } catch { /* ignore */ }
  await sleep(300);
  try { if (chrome.proc.exitCode === null) chrome.proc.kill('SIGKILL'); } catch { /* ignore */ }
  try { await rm(chrome.dir, { recursive: true, force: true }); } catch { /* ignore */ }
}
async function waitReady(cdp, { timeoutMs = 15000 } = {}) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    try {
      const value = (await cdp.send('Runtime.evaluate', { expression: 'document.readyState', returnByValue: true }, { timeoutMs: 2000 })).result?.value;
      if (value === 'complete') return true;
    } catch { /* navigation in flight */ }
    await sleep(100);
  }
  return false;
}
/** Install an in-page WebSocket recorder (same-origin, so the browser cookie is sent). */
async function installWsRecorder(cdp) {
  const expression = `(() => {
    window.__utb = { sockets: {} };
    window.__utb.open = (name, query) => new Promise((resolve) => {
      const record = { url: '', opened: false, error: null, hellos: [], frames: [] };
      window.__utb.sockets[name] = record;
      let ws;
      try { ws = new WebSocket('/plugins/ui-testing/frames?' + query); } catch (error) { record.error = String(error); resolve(false); return; }
      record.url = ws.url;
      record.ws = ws;
      ws.binaryType = 'arraybuffer';
      ws.onopen = () => { record.opened = true; resolve(true); };
      ws.onerror = () => { record.error = 'websocket error'; resolve(false); };
      ws.onclose = (event) => { record.closed = true; record.closeCode = event.code; };
      ws.onmessage = (event) => {
        if (typeof event.data === 'string') {
          try { const parsed = JSON.parse(event.data); if (parsed && parsed.type === 'hello') record.hellos.push(parsed); } catch (e) { /* ignore */ }
          return;
        }
        const buffer = new Uint8Array(event.data);
        if (buffer.length < 4) return;
        const view = new DataView(event.data);
        const length = view.getUint32(0);
        let header;
        try { header = JSON.parse(new TextDecoder().decode(buffer.subarray(4, 4 + length))); } catch (e) { return; }
        record.frames.push({ header, jpegBytes: buffer.length - 4 - length, magic: Array.from(buffer.subarray(4 + length, 6 + length)) });
      };
    });
    return true;
  })()`;
  await cdp.send('Runtime.evaluate', { expression, returnByValue: true }, { timeoutMs: 5000 });
}
async function readWsRecords(cdp) {
  const expression = `JSON.stringify(Object.fromEntries(Object.entries(window.__utb.sockets).map(([name, record]) => [name, {
    url: record.url, opened: record.opened, error: record.error, closed: Boolean(record.closed), closeCode: record.closeCode,
    hellos: record.hellos, frames: record.frames,
  }])))`;
  const value = (await cdp.send('Runtime.evaluate', { expression, returnByValue: true }, { timeoutMs: 5000 })).result?.value;
  try { return JSON.parse(value); } catch { return {}; }
}

const fixture = await startFixtureServer();
let chrome;
try {
  const info = listenerInfo();
  const home = resolveHome(info);
  observe('isolated home', { home: home.home, source: home.source, listener: info });
  // Launch token: memory only, never logged or written to evidence.
  const log = await readFile(logPath, 'utf8');
  const links = [...log.matchAll(/http:\/\/(?:127\.0\.0\.1|localhost):3081\/[^\s\u001b]*/g)];
  const authenticated = links.reverse().find(([url]) => /token=/.test(url));
  assert.ok(authenticated, '3081 launch URL with token present in the isolated log');
  const exchange = await fetch(authenticated[0], { redirect: 'manual' });
  cookie = exchange.headers.getSetCookie().map((value) => value.split(';')[0]).join('; ');
  assert.ok(cookie, 'browser-session cookie issued');
  check('3081 GUI authenticated', (await fetch(base, { headers: { cookie } })).ok === true);

  const discovered = await discoverScopes(home.home);
  const primary = discovered.scopes[0];
  const secondary = discovered.scopes[1];
  const scopeA = primary ? { sid: primary.sid, label: 'workspace:' + (primary.workspaceId || '?') } : { scope: 'unassigned', label: 'unassigned' };
  const scopeB = secondary
    ? { sid: secondary.sid, label: 'workspace:' + (secondary.workspaceId || '?') }
    : (primary ? { scope: 'unassigned', label: 'unassigned' } : { headers: {}, label: 'legacy' });
  const limitation = !primary || !secondary
    ? 'Only ' + discovered.workspaces + ' registered workspace(s) / ' + discovered.sessions + ' session(s) are available in the isolated home; a second GUI-bound workspace session is not created by this script (that needs real Session Controller/GUI interaction). Scope B is the explicit `unassigned` scope, so this run does NOT prove two-GUI-bound-workspace isolation.'
    : null;
  observe('scopes', { A: scopeA.label, B: scopeB.label, discovered: { workspaces: discovered.workspaces, sessions: discovered.sessions }, limitation });
  check('scoped identity resolves (real session scope or explicit unassigned)', Boolean(primary || secondary), { primary: Boolean(primary), secondary: Boolean(secondary) });

  const unauthenticated = await request('/state', { identity: scopeA, auth: false });
  check('unauthenticated scoped /state rejected (401)', unauthenticated.status === 401, unauthenticated.status);
  const legacyState = await request('/state', { headers: {} });
  check('legacy unscoped /state still 200 (old protocol)', legacyState.status === 200 && legacyState.json?.scope?.id === 'legacy:default', legacyState.status);

  const coldA = await request('/state', { identity: scopeA });
  check('scoped /state returns opaque scope + cold ui.runtimeId', coldA.status === 200 && coldA.json?.scope?.id && coldA.json?.ui?.runtimeId && coldA.json?.running === false,
    { status: coldA.status, scope: coldA.json?.scope, running: coldA.json?.running });
  if (primary) {
    check('real session scope resolves to a registered workspaceId (no absolute path)',
      typeof coldA.json?.scope?.workspaceId === 'string' && coldA.json.scope.workspaceId.length > 0 && !JSON.stringify(coldA.json?.scope).includes('/'),
      coldA.json?.scope);
  }
  const runtimeIdA = coldA.json?.ui?.runtimeId;
  const coldB = await request('/state', { identity: scopeB });
  const runtimeIdB = coldB.json?.ui?.runtimeId;
  check('A/B scopes are different runtimes', runtimeIdA && runtimeIdB && runtimeIdA !== runtimeIdB, { runtimeIdA, runtimeIdB });

  const ensureA = await request('/ensure', { method: 'POST', body: { url: fixture.url }, identity: scopeA });
  const ensureB = await request('/ensure', { method: 'POST', body: { url: fixture.url + 'second.html' }, identity: scopeB });
  check('A/B ensure succeed on separate pages', ensureA.status === 200 && ensureB.status === 200, { A: ensureA.status, B: ensureB.status });
  let stateA; let stateB;
  for (let index = 0; index < 50; index += 1) {
    stateA = (await request('/state', { identity: scopeA })).json;
    stateB = (await request('/state', { identity: scopeB })).json;
    if (stateA?.title === 'DSH UI Testing Fixture' && stateB?.title === 'DSH UI Testing Fixture — Second Page') break;
    await sleep(100);
  }
  check('A/B URL+title independent', stateA?.url === fixture.url && stateA?.title === 'DSH UI Testing Fixture'
    && stateB?.url === fixture.url + 'second.html' && stateB?.title === 'DSH UI Testing Fixture — Second Page',
  { A: { url: stateA?.url, title: stateA?.title }, B: { url: stateB?.url, title: stateB?.title } });
  const viewportA = await request('/viewport', { method: 'POST', body: { width: 640, height: 480 }, identity: scopeA });
  const afterViewportB = (await request('/state', { identity: scopeB })).json;
  check('A viewport change does not affect B', viewportA.json?.viewport?.width === 640 && afterViewportB?.viewport?.width === 1280,
    { A: viewportA.json?.viewport, B: afterViewportB?.viewport });
  check('A/B runtimeId stays stable across operations', (await request('/state', { identity: scopeA })).json?.ui?.runtimeId === runtimeIdA
    && (await request('/state', { identity: scopeB })).json?.ui?.runtimeId === runtimeIdB, { runtimeIdA, runtimeIdB });

  // Scoped frames over a real browser page (cookie is sent; Node WS cannot carry one).
  chrome = await launchChrome();
  const cdp = chrome.cdp;
  await cdp.send('Page.enable');
  await cdp.send('Runtime.enable');
  await cdp.send('Page.navigate', { url: authenticated[0] }, { timeoutMs: 15000 });
  await waitReady(cdp);
  await cdp.send('Page.navigate', { url: base }, { timeoutMs: 15000 });
  await waitReady(cdp);
  await installWsRecorder(cdp);
  const openQuery = `scopeVersion=1&binding=`;
  const opened = await cdp.send('Runtime.evaluate', {
    expression: `Promise.all([window.__utb.open('A', ${JSON.stringify(openQuery + encodeURIComponent(runtimeIdA))}), window.__utb.open('B', ${JSON.stringify(openQuery + encodeURIComponent(runtimeIdB))})]).then((values) => values)`,
    returnByValue: true, awaitPromise: true,
  }, { timeoutMs: 10000 });
  check('A/B scoped frame WS handshake in a real browser page', Array.isArray(opened.result?.value) && opened.result.value.every(Boolean),
    { result: opened.result?.value });
  await sleep(500);
  let records = await readWsRecords(cdp);
  const helloA = records.A?.hellos?.[0];
  const helloB = records.B?.hellos?.[0];
  check('frame hello carries distinct scopeId/runtimeId (browser WS)',
    helloA?.runtimeId === runtimeIdA && helloB?.runtimeId === runtimeIdB && helloA?.scopeId !== helloB?.scopeId
    && String(records.A?.url || '').includes('frames?scopeVersion=1&binding='),
    { helloA, helloB, urls: { A: records.A?.url, B: records.B?.url } });

  await request('/eval', { method: 'POST', body: { expression: "document.body.style.background='rgb(10,20,30)'" }, identity: scopeA });
  await request('/eval', { method: 'POST', body: { expression: "document.body.style.background='rgb(200,100,50)'" }, identity: scopeB });
  for (let index = 0; index < 60; index += 1) {
    records = await readWsRecords(cdp);
    if ((records.A?.frames?.length || 0) >= 1 && (records.B?.frames?.length || 0) >= 1) break;
    await sleep(100);
  }
  check('A/B each receive JPEG frames with their own runtimeId (browser WS)',
    (records.A?.frames?.length || 0) >= 1 && (records.B?.frames?.length || 0) >= 1
    && records.A.frames.every((frame) => frame.header.runtimeId === runtimeIdA && frame.magic[0] === 0xff && frame.magic[1] === 0xd8)
    && records.B.frames.every((frame) => frame.header.runtimeId === runtimeIdB),
    { A: records.A?.frames?.map((frame) => ({ seq: frame.header?.seq, runtimeId: frame.header?.runtimeId, bytes: frame.jpegBytes })), B: records.B?.frames?.map((frame) => ({ seq: frame.header?.seq, runtimeId: frame.header?.runtimeId, bytes: frame.jpegBytes })) });

  const metricsA = (await request('/metrics', { identity: { binding: runtimeIdA } })).json;
  const metricsB = (await request('/metrics', { identity: { binding: runtimeIdB } })).json;
  check('scoped /metrics separated', metricsA?.host?.push?.runtimeId === runtimeIdA && metricsB?.host?.push?.runtimeId === runtimeIdB
    && metricsA?.host?.clients >= 1 && metricsB?.host?.clients >= 1,
  { A: metricsA?.host?.clients, B: metricsB?.host?.clients });

  const closeA = await request('/close', { method: 'POST', body: {}, identity: scopeA });
  const stateAAfter = (await request('/state', { identity: scopeA })).json;
  const stateBAfter = (await request('/state', { identity: scopeB })).json;
  check('scoped /close only closes A (B still running)', closeA.json?.ok === true && stateAAfter?.running === false && stateBAfter?.running === true,
    { close: closeA.json, A: stateAAfter?.running, B: stateBAfter?.running });

  const recent = await request('/state', { identity: { scope: 'recent' } });
  const bound = recent.json?.ui?.runtimeId ? await request('/state', { identity: { binding: recent.json.ui.runtimeId } }) : undefined;
  check('recent resolves once and binding hits the same runtime', Boolean(recent.json?.ui?.runtimeId) && bound?.json?.ui?.runtimeId === recent.json.ui.runtimeId,
    { recent: recent.json?.ui?.runtimeId, bound: bound?.json?.ui?.runtimeId });

  // Close the in-page sockets before teardown.
  try {
    await cdp.send('Runtime.evaluate', { expression: `(() => { for (const record of Object.values(window.__utb.sockets)) { try { record.ws.close(); } catch (e) { /* ignore */ } } return true; })()`, returnByValue: true }, { timeoutMs: 3000 });
  } catch { /* ignore */ }
  await request('/close', { method: 'POST', body: {}, identity: scopeB }).catch(() => {});

  const sourceFiles = ['index.js', 'frame-push.js', 'browser-safety.js'];
  const build = {};
  const listenerStart = Number.isFinite(info.startedAtEpoch) ? info.startedAtEpoch : (info.startedAt ? Date.parse(info.startedAt) : NaN);
  const editedAfterStart = {};
  for (const file of sourceFiles) {
    const path = fileURLToPath(new URL('../../' + file, import.meta.url));
    const text = await readFile(path);
    const mtime = (await stat(path)).mtimeMs;
    build[file] = { sha256: sha256(text), mtime };
    if (Number.isFinite(listenerStart)) editedAfterStart[file] = mtime > listenerStart;
  }
  const loadedBuildMatchesWorkspace = Object.keys(editedAfterStart).length > 0
    ? Object.values(editedAfterStart).every((edited) => edited === false)
    : null;
  observe('loaded build', { listenerPid: info.pid, listenerStartedAt: info.startedAt, editedAfterStart, loadedBuildMatchesWorkspace });
  const directory = new URL(`./runs/host-3081-workspace-${Date.now()}/`, import.meta.url);
  await mkdir(directory, { recursive: true });
  await writeFile(new URL('report.json', directory), JSON.stringify({
    host: base,
    generatedAt: new Date().toISOString(),
    environment: {
      listener: info,
      dshHome: home.home,
      dshHomeSource: home.source,
      build,
      editedAfterStart,
      loadedBuildMatchesWorkspace,
      chrome: chromeBin,
      scopes: { A: scopeA.label, B: scopeB.label },
      limitation,
    },
    checks,
    observations,
    summary: { total: checks.length, passed: checks.filter((item) => item.pass).length, failed },
    scope: 'Real isolated 3081 host: scoped HTTP headers + scoped WS frames recorded inside a real headless Chrome page (owner-only cookie auth). Proves the Host identity chain through ctx.sessions/sessionPersistence + workspaceRegistry for the available session(s), per-scope URL/viewport/frames/metrics/close. NOT covered here: real Agent tool calls (exec.agent.session.header.cwd) and two GUI-bound workspaces when the isolated home only has one; see limitation.',
  }, null, 2));
  console.log(`\nworkspace-isolation-3081: ${checks.length - failed}/${checks.length} PASS, ${failed} failed`);
  console.log('evidence: ' + directory.pathname + 'report.json');
  process.exitCode = failed === 0 ? 0 : 1;
} finally {
  await closeChrome(chrome).catch(() => {});
  await fixture.close().catch(() => {});
}
