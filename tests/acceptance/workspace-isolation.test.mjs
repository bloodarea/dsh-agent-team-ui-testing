#!/usr/bin/env node
/**
 * Workspace isolation acceptance (Host half) — real headless Chromium + fake Cordis ctx.
 *
 * Scope of this suite: one apply = ONE headless Chromium + one temporary profile, with one
 * independent page target per workspace. Isolated per page: URL/title/history, viewport, frame
 * source + screencast ACK, network observation buffer, serial queue, single-owner lease, error,
 * metrics and runtimeId. NOT isolated (explicit non-goal): cookies, localStorage, IndexedDB,
 * cache and service workers inside the shared profile.
 *
 * Run: node tests/acceptance/workspace-isolation.test.mjs
 * Report: tests/acceptance/runs/workspace-isolation-<timestamp>/report.json
 */
import { mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  createHarness,
  createFakeConnectionService,
  connectFrameWebSocket,
  closeFrameWebSocket,
  waitFor,
  waitForWebSocket,
  startPluginHttpServer,
  scanPluginChromeProcesses,
  sleep,
  isJpegBuffer,
} from './harness.mjs';
import { startFixtureServer } from '../ui_test_fixture/server.mjs';
import { WORKSPACE_ISOLATION_DEFAULTS } from '../../index.js';

// Inside the DSH file sandbox Chromium needs the wrapper flags; the wrapper launches the same
// real binary (see chrome-wrapper.sh).
process.env.DSH_UI_TESTING_CHROME ||= fileURLToPath(new URL('./chrome-wrapper.sh', import.meta.url));

const checks = [];
const observations = [];
let failed = 0;
function check(label, condition, evidence) {
  const pass = Boolean(condition);
  checks.push({ label, pass, evidence });
  if (!pass) failed += 1;
  console.log(`${pass ? 'PASS' : 'FAIL'} ${label}`);
  if (!pass) console.log('  evidence: ' + JSON.stringify(evidence).slice(0, 2500));
}
function observe(label, value) {
  observations.push({ label, value });
  console.log('OBS ' + label + ': ' + JSON.stringify(value));
}
function losslessProblems(value, path = 'value', out = []) {
  if (value === null) return out;
  const type = typeof value;
  if (type === 'string' || type === 'boolean') return out;
  if (type === 'number') {
    if (!Number.isFinite(value) || Object.is(value, -0)) out.push(`${path}: non-finite/-0`);
    return out;
  }
  if (type === 'undefined' || type === 'function' || type === 'symbol' || type === 'bigint') {
    out.push(`${path}: ${type}`);
    return out;
  }
  if (Array.isArray(value)) {
    for (let index = 0; index < value.length; index += 1) {
      if (!(index in value)) out.push(`${path}[${index}]: sparse`);
      else losslessProblems(value[index], `${path}[${index}]`, out);
    }
    return out;
  }
  if (value instanceof Error) { out.push(`${path}: Error instance`); return out; }
  for (const key of Object.keys(value)) losslessProblems(value[key], `${path}.${key}`, out);
  return out;
}
function pngSize(base64) {
  const buffer = Buffer.from(base64 || '', 'base64');
  if (buffer.length < 24 || buffer.subarray(0, 8).toString('hex') !== '89504e470d0a1a0a') return null;
  return { width: buffer.readUInt32BE(16), height: buffer.readUInt32BE(20), bytes: buffer.length };
}
async function rssKb(pid) {
  try {
    const status = await readFile(`/proc/${pid}/status`, 'utf8');
    const match = /VmRSS:\s+(\d+)\s+kB/.exec(status);
    return match ? Number(match[1]) : null;
  } catch { return null; }
}

const fixture = await startFixtureServer();
const tempDirs = [];
const harnesses = [];
const pluginHttpServers = [];
let server;

async function makeDir(tag) {
  const dir = await realpath(await mkdtemp(join(tmpdir(), `dsh-ws-${tag}-`)));
  tempDirs.push(dir);
  return dir;
}

try {
  const dirA = await makeDir('a');
  const dirB = await makeDir('b');
  const dirUnregistered = await makeDir('u');
  const extraDirs = [];
  for (let index = 1; index <= 9; index += 1) extraDirs.push(await makeDir(`w${index}`));
  const aliasDir = join(tmpdir(), `dsh-ws-alias-${Date.now()}`);
  await symlink(dirA, aliasDir);
  tempDirs.push(aliasDir);

  const sessionCwd = new Map([
    ['sid-a', dirA], ['sid-a2', dirA], ['sid-alias', aliasDir], ['sid-b', dirB],
    ['sid-unregistered', dirUnregistered], ['sid-nocwd', null],
    ...extraDirs.map((dir, index) => [`s${index + 1}`, dir]),
  ]);
  const sessions = {
    get(id) {
      if (id === 'sid-nocwd') return { id, header: {} };
      if (!sessionCwd.has(id)) return undefined;
      const cwd = sessionCwd.get(id);
      return { id, header: cwd ? { cwd } : {} };
    },
  };
  const workspaceRegistry = {
    // DSH WorkspaceRegistry.resolveByPath is async (Promise<Workspace | undefined>).
    async resolveByPath(candidate) {
      if (candidate === dirA) return { id: 'ws-a' };
      if (candidate === dirB) return { id: 'ws-b' };
      const index = extraDirs.indexOf(candidate);
      return index >= 0 ? { id: `ws-${index + 1}` } : undefined;
    },
    list() {
      return [
        { id: 'ws-a', path: dirA, sessionIds: ['sid-a', 'sid-a2', 'sid-alias'] },
        { id: 'ws-b', path: dirB, sessionIds: ['sid-b'] },
        ...extraDirs.map((dir, index) => ({ id: `ws-${index + 1}`, path: dir, sessionIds: [`s${index + 1}`] })),
      ];
    },
  };
  const sessionPersistence = {
    async stat(id) {
      if (id === 'sid-stat-error') throw new Error('injected storage failure');
      return undefined;
    },
  };
  const connection = createFakeConnectionService({
    rejection: undefined,
    admit: { peer: { id: 'gui-1' } },
    browserPeer: { id: 'gui-1' },
  });

  const harnessOptions = { connection, sessions, workspaceRegistry, sessionPersistence };
  const h = await createHarness({ name: 'isolation', ...harnessOptions });
  harnesses.push(h);
  const registry = h.ctx.__internal.plugin.registry;
  // Materialise the (lazy, no-Chromium) BrowserHost so pageCount/proc can be inspected.
  const host = registry.browserHost();
  const runtimeOf = (workspaceId) => registry.peek(`workspace:${workspaceId}`)?.runtime;

  const scopeHeaders = (identity = {}) => {
    const headers = { 'x-ui-testing-scope-version': '1' };
    if (identity.sid) headers['x-ui-testing-session-id'] = identity.sid;
    if (identity.scope) headers['x-ui-testing-scope'] = identity.scope;
    if (identity.binding) headers['x-ui-testing-scope-binding'] = identity.binding;
    return headers;
  };
  const api = (method, action, { body, identity, headers } = {}) => h.request({
    method,
    path: '/plugins/ui-testing' + action,
    body,
    headers: headers !== undefined ? headers : (identity ? scopeHeaders(identity) : {}),
  });
  const legacyApi = (method, action, body) => api(method, action, { body, headers: {} });
  const execOf = (sid) => ({ agent: { id: sid, session: { header: { cwd: sessionCwd.get(sid) } } } });
  const execA = execOf('sid-a');
  const execA2 = execOf('sid-a2');
  const execB = execOf('sid-b');
  const waitTitle = (identity, title) => waitFor(async () => {
    const state = (await api('GET', '/state', { identity })).json;
    return state && state.title === title && state.running === true;
  }, { timeoutMs: 15000, label: `title ${title}` });

  /* ------------------------------------------------------------------ identity matrix (cold) */
  {
    const unknown = await api('GET', '/state', { identity: { sid: 'sid-unknown' } });
    check('未知 sessionId → 404 SCOPE_NOT_FOUND', unknown.statusCode === 404 && unknown.json?.code === 'SCOPE_NOT_FOUND', unknown.json);

    const statError = await api('GET', '/state', { identity: { sid: 'sid-stat-error' } });
    check('会话存储异常 → 503 SCOPE_UNAVAILABLE（不当不存在）', statError.statusCode === 503 && statError.json?.code === 'SCOPE_UNAVAILABLE', statError.json);

    const conflict = await h.request({
      method: 'GET', path: '/plugins/ui-testing/state',
      headers: { ...scopeHeaders({ sid: 'sid-a' }), 'x-ui-testing-scope': 'recent' },
    });
    check('同一请求两种 identity → 400 SCOPE_INVALID', conflict.statusCode === 400 && conflict.json?.code === 'SCOPE_INVALID', conflict.json);

    const badVersion = await h.request({
      method: 'GET', path: '/plugins/ui-testing/state',
      headers: { 'x-ui-testing-scope-version': '2', 'x-ui-testing-session-id': 'sid-a' },
    });
    check('不支持的 scope 版本 → 400 SCOPE_INVALID', badVersion.statusCode === 400 && badVersion.json?.code === 'SCOPE_INVALID', badVersion.json);

    const legacyState = await legacyApi('GET', '/state');
    check('无 scope 头 → legacy:default 冷投影（running:false）', legacyState.json?.scope?.id === 'legacy:default' && legacyState.json?.scope?.kind === 'legacy' && legacyState.json?.running === false, legacyState.json);

    const unregistered = await api('GET', '/state', { identity: { sid: 'sid-unregistered' } });
    check('未注册目录 → path:<sha256> 降级且不泄漏绝对路径',
      unregistered.json?.scope?.kind === 'path' && /^path:[0-9a-f]{32}$/.test(unregistered.json?.scope?.id || '')
      && unregistered.json?.scope?.workspaceId === null && unregistered.json?.scope?.degraded === true
      && !JSON.stringify(unregistered.json).includes(dirUnregistered),
      unregistered.json);

    const noCwd = await api('GET', '/state', { identity: { sid: 'sid-nocwd' } });
    check('live session 缺 cwd → session:<sha256> 降级（不跨 session 合并）',
      noCwd.json?.scope?.kind === 'session' && /^session:[0-9a-f]{32}$/.test(noCwd.json?.scope?.id || '') && noCwd.json?.scope?.degraded === true,
      noCwd.json);

    // Async resolveByPath (the real DSH signature) must actually be awaited, not treated as a
    // truthy Promise (that would silently fall back to a path scope forever).
    const asyncHit = await api('GET', '/state', { identity: { sid: 'sid-a' } });
    check('async resolveByPath 命中注册 workspace（DSH 真实签名）', asyncHit.json?.scope?.kind === 'workspace' && asyncHit.json?.scope?.workspaceId === 'ws-a', asyncHit.json?.scope);

    // A synchronous mock (older fake/tests) must keep working: `await` handles both shapes.
    const syncRegistryHarness = await createHarness({
      name: 'sync-registry', connection, sessions, sessionPersistence,
      workspaceRegistry: {
        resolveByPath(candidate) { return candidate === dirA ? { id: 'ws-a' } : undefined; },
        list() { return [{ id: 'ws-a', path: dirA, sessionIds: ['sid-a'] }]; },
      },
    });
    harnesses.push(syncRegistryHarness);
    const syncHit = await syncRegistryHarness.request({ method: 'GET', path: '/plugins/ui-testing/state', headers: scopeHeaders({ sid: 'sid-a' }) });
    check('同步 resolveByPath mock 仍兼容（await 两种形态）', syncHit.json?.scope?.kind === 'workspace' && syncHit.json?.scope?.workspaceId === 'ws-a', syncHit.json?.scope);

    // Registry failure (non-ENOENT) is a storage fault: 503, never a path/session downgrade.
    const faultHarness = await createHarness({
      name: 'registry-fault', connection, sessions, sessionPersistence,
      workspaceRegistry: {
        async resolveByPath() { throw new Error('injected registry failure'); },
        list() { return []; },
      },
    });
    harnesses.push(faultHarness);
    const fault = await faultHarness.request({ method: 'GET', path: '/plugins/ui-testing/state', headers: scopeHeaders({ sid: 'sid-a' }) });
    check('resolveByPath 抛错（非 ENOENT）→ 503 SCOPE_UNAVAILABLE，不降级', fault.statusCode === 503 && fault.json?.code === 'SCOPE_UNAVAILABLE', fault.json);

    // ENOENT from the registry lookup means the directory vanished: degrade (path scope here).
    const enoentHarness = await createHarness({
      name: 'registry-enoent', connection, sessions, sessionPersistence,
      workspaceRegistry: {
        async resolveByPath() { const error = new Error('gone'); error.code = 'ENOENT'; throw error; },
        list() { return []; },
      },
    });
    harnesses.push(enoentHarness);
    const enoent = await enoentHarness.request({ method: 'GET', path: '/plugins/ui-testing/state', headers: scopeHeaders({ sid: 'sid-a' }) });
    check('resolveByPath ENOENT（目录消失）→ 降级 path 而不是 503', enoent.statusCode === 200 && enoent.json?.scope?.kind === 'path', enoent.json?.scope);

    const unassigned = await api('GET', '/state', { identity: { scope: 'unassigned' } });
    check('显式 unassigned → 独立冷实例 unassigned:owner', unassigned.json?.scope?.id === 'unassigned:owner' && unassigned.json?.running === false, unassigned.json);
  }

  /* ------------------------------------------------------- one apply / one Chromium, two pages */
  let runtimeIdA;
  let runtimeIdB;
  {
    const ensureA = await api('POST', '/ensure', { body: { url: fixture.url }, identity: { sid: 'sid-a' } });
    check('A ensure 成功且 scope.workspaceId=ws-a', ensureA.statusCode === 200 && ensureA.json?.state?.scope?.workspaceId === 'ws-a', ensureA.json);
    runtimeIdA = ensureA.json?.state?.ui?.runtimeId;
    const ensureB = await api('POST', '/ensure', { body: { url: `${fixture.url}second.html` }, identity: { sid: 'sid-b' } });
    check('B ensure 成功且 scope.workspaceId=ws-b', ensureB.statusCode === 200 && ensureB.json?.state?.scope?.workspaceId === 'ws-b', ensureB.json);
    runtimeIdB = ensureB.json?.state?.ui?.runtimeId;
    await waitTitle({ sid: 'sid-a' }, 'DSH UI Testing Fixture');
    await waitTitle({ sid: 'sid-b' }, 'DSH UI Testing Fixture — Second Page');

    const stateA = (await api('GET', '/state', { identity: { sid: 'sid-a' } })).json;
    const stateB = (await api('GET', '/state', { identity: { sid: 'sid-b' } })).json;
    check('A/B URL 与 title 独立', stateA.url.includes(fixture.url) && stateA.title === 'DSH UI Testing Fixture'
      && stateB.url.endsWith('second.html') && stateB.title === 'DSH UI Testing Fixture — Second Page',
      { A: { url: stateA.url, title: stateA.title }, B: { url: stateB.url, title: stateB.title } });
    check('A/B runtimeId 不同（同 apply）', runtimeIdA && runtimeIdB && runtimeIdA !== runtimeIdB, { runtimeIdA, runtimeIdB });

    const procs = scanPluginChromeProcesses().filter((proc) => proc.parentPid === process.pid);
    check('一次 apply 只启动一个 Chromium 进程', procs.length === 1, procs.map((proc) => proc.pid));
    observe('pages=1 rssKb', await rssKb(host.proc.pid));
    check('同一 Host PID/profile 下两个不同 targetId', host.pageCount === 2
      && runtimeOf('ws-a')?.page?.targetId && runtimeOf('ws-b')?.page?.targetId
      && runtimeOf('ws-a').page.targetId !== runtimeOf('ws-b').page.targetId,
      { pid: host.proc.pid, profileDir: host.profileDir, A: runtimeOf('ws-a')?.page?.targetId, B: runtimeOf('ws-b')?.page?.targetId });
    check('A/B 共享同一 profile 目录（非目标：Cookie/localStorage 共享）',
      host.profileDir && runtimeOf('ws-a').host === runtimeOf('ws-b').host, { profileDir: host.profileDir });
    observe('pages=2 rssKb', await rssKb(host.proc.pid));

    // Same workspace, two different sessions -> the SAME runtime (runtimeId + lease scope).
    const stateA2 = (await api('GET', '/state', { identity: { sid: 'sid-a2' } })).json;
    const stateAlias = (await api('GET', '/state', { identity: { sid: 'sid-alias' } })).json;
    check('同工作区两个 session（含 realpath alias）共享同一 runtimeId',
      stateA2.ui?.runtimeId === runtimeIdA && stateAlias.ui?.runtimeId === runtimeIdA
      && stateA2.scope?.workspaceId === 'ws-a' && stateAlias.scope?.workspaceId === 'ws-a',
      { A: runtimeIdA, A2: stateA2.ui?.runtimeId, alias: stateAlias.ui?.runtimeId, aliasScope: stateAlias.scope });
  }

  /* ---------------------------------------------------------- viewport / history / reload / input */
  {
    const viewportA = await api('POST', '/viewport', { body: { width: 640, height: 480 }, identity: { sid: 'sid-a' } });
    check('A 视口独立设为 640×480', viewportA.statusCode === 200 && viewportA.json?.viewport?.width === 640 && viewportA.json?.viewport?.height === 480, viewportA.json);
    const innerA = (await h.invoke('browser_eval', { expression: '({w:innerWidth,h:innerHeight})' }, execA)).value?.value;
    const innerB = (await h.invoke('browser_eval', { expression: '({w:innerWidth,h:innerHeight})' }, execB)).value?.value;
    check('A/B 各自 innerWidth/innerHeight 独立', innerA?.w === 640 && innerA?.h === 480 && innerB?.w === 1280 && innerB?.h === 800, { innerA, innerB });

    const historyBeforeB = (await api('GET', '/state', { identity: { sid: 'sid-b' } })).json?.ui?.history;
    await api('POST', '/navigate', { body: { url: `${fixture.url}?h=2` }, identity: { sid: 'sid-a' } });
    await waitTitle({ sid: 'sid-a' }, 'DSH UI Testing Fixture');
    const stateAAfterNav = (await api('GET', '/state', { identity: { sid: 'sid-a' } })).json;
    const stateBAfterNav = (await api('GET', '/state', { identity: { sid: 'sid-b' } })).json;
    check('A 导航只影响 A 的 URL/history，B 不变',
      stateAAfterNav.url.includes('h=2') && stateAAfterNav.ui?.history?.length === 3
      && stateBAfterNav.url.endsWith('second.html') && stateBAfterNav.ui?.history?.length === historyBeforeB?.length,
      { A: { url: stateAAfterNav.url, history: stateAAfterNav.ui?.history }, B: { url: stateBAfterNav.url, history: stateBAfterNav.ui?.history } });

    const backA = await api('POST', '/history', { body: { direction: 'back' }, identity: { sid: 'sid-a' } });
    check('A back 只回退 A（B 仍在 second.html）', backA.json?.moved === true
      && (await api('GET', '/state', { identity: { sid: 'sid-a' } })).json?.url === fixture.url
      && (await api('GET', '/state', { identity: { sid: 'sid-b' } })).json?.url.endsWith('second.html'), backA.json);

    const reloadA = await api('POST', '/reload', { body: {}, identity: { sid: 'sid-a' } });
    const reloadStateB = (await api('GET', '/state', { identity: { sid: 'sid-b' } })).json;
    check('A reload 只影响 A（B title/history 不变）', reloadA.statusCode === 200 && reloadA.json?.ok === true
      && reloadStateB.title === 'DSH UI Testing Fixture — Second Page', { reload: reloadA.json?.ok, B: reloadStateB.title });

    // Native input targets this page only: click #inc in A, B's counter must stay untouched.
    const pointA = (await h.invoke('browser_eval', { expression: '(() => { const r = document.getElementById("inc").getBoundingClientRect(); return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) }; })()' }, execA)).value?.value;
    const counterA0 = Number((await h.invoke('browser_eval', { expression: 'document.getElementById("counter").textContent' }, execA)).value?.value || 0);
    const counterB0 = Number((await h.invoke('browser_eval', { expression: 'document.getElementById("counter").textContent' }, execB)).value?.value || 0);
    await api('POST', '/input', { body: { events: [
      { kind: 'mouse', type: 'mousePressed', x: pointA.x, y: pointA.y, button: 'left', clickCount: 1 },
      { kind: 'mouse', type: 'mouseReleased', x: pointA.x, y: pointA.y, button: 'left', clickCount: 1 },
    ] }, identity: { sid: 'sid-a' } });
    await sleep(200);
    const counterA1 = Number((await h.invoke('browser_eval', { expression: 'document.getElementById("counter").textContent' }, execA)).value?.value || 0);
    const counterB1 = Number((await h.invoke('browser_eval', { expression: 'document.getElementById("counter").textContent' }, execB)).value?.value || 0);
    check('A 的鼠标输入只作用于 A 的 page（B 计数器不变）', counterA1 === counterA0 + 1 && counterB1 === counterB0, { counterA0, counterA1, counterB0, counterB1 });

    const shotA = (await h.invoke('browser_screenshot', {}, execA)).value;
    const shotB = (await h.invoke('browser_screenshot', {}, execB)).value;
    const pngA = pngSize(shotA?.image);
    const pngB = pngSize(shotB?.image);
    check('截图按 scope 命中各自 target（A 640×480 / B 1280×800）', pngA?.width === 640 && pngA?.height === 480 && pngB?.width === 1280 && pngB?.height === 800, { pngA, pngB });
    const styleA = (await h.invoke('browser_computed_style', { selector: 'body', properties: ['display'] }, execA)).value;
    const styleB = (await h.invoke('browser_computed_style', { selector: 'body', properties: ['display'] }, execB)).value;
    check('computedStyle 按 scope 命中各自 DOM', styleA?.ok === true && styleB?.ok === true && typeof styleA.style?.display === 'string' && typeof styleB.style?.display === 'string', { styleA, styleB });
  }

  /* --------------------------------------------------------------------------- network nonce */
  {
    const nonceA = `a-${Date.now()}-${Math.random().toString(16).slice(2)}`;
    const nonceB = `b-${Date.now()}-${Math.random().toString(16).slice(2)}`;
    await h.invoke('browser_eval', { expression: `fetch('/api/data?nonce=${nonceA}').catch(()=>false)` }, execA);
    await h.invoke('browser_eval', { expression: `fetch('/api/data?nonce=${nonceB}').catch(()=>false)` }, execB);
    await sleep(600);
    const networkA = (await h.invoke('browser_network', { limit: 300 }, execA)).value?.entries || [];
    const networkB = (await h.invoke('browser_network', { limit: 300 }, execB)).value?.entries || [];
    check('A 独有 nonce 请求只进 A 的 network 缓冲', networkA.some((entry) => String(entry.url).includes(nonceA)) && !networkA.some((entry) => String(entry.url).includes(nonceB))
      && networkB.some((entry) => String(entry.url).includes(nonceB)) && !networkB.some((entry) => String(entry.url).includes(nonceA)),
    { A: networkA.map((entry) => entry.url).filter((url) => url.includes('nonce')), B: networkB.map((entry) => entry.url).filter((url) => url.includes('nonce')) });

    const beforeA = (await api('GET', '/state', { identity: { sid: 'sid-a' } })).json;
    await api('POST', '/navigate', { body: { url: `${fixture.url}second.html?from=b` }, identity: { sid: 'sid-b' } });
    await waitTitle({ sid: 'sid-b' }, 'DSH UI Testing Fixture — Second Page');
    const afterA = (await api('GET', '/state', { identity: { sid: 'sid-a' } })).json;
    const networkAAfter = (await h.invoke('browser_network', { limit: 300 }, execA)).value?.entries || [];
    check('B 导航不写 A 的 URL/error/network', afterA.url === beforeA.url && afterA.error === '' && !networkAAfter.some((entry) => String(entry.url).includes('from=b')),
      { beforeA: beforeA.url, afterA: afterA.url, error: afterA.error });
  }

  /* ------------------------------------------------- popup interception / Document blocking */
  {
    const popupHits = [];
    const popupServer = createServer((req, res) => {
      popupHits.push(req.url);
      if (req.url === '/to-metadata') {
        res.writeHead(302, { location: 'http://169.254.169.254/latest/meta-data/' });
        res.end();
        return;
      }
      res.writeHead(200, { 'content-type': 'text/html' });
      res.end('<title>popup</title>');
    });
    await new Promise((resolve) => popupServer.listen(0, '127.0.0.1', resolve));
    const popupPort = popupServer.address().port;
    try {
      const pagesBefore = host.pageCount;
      const opened = await h.invoke('browser_eval', { expression: `window.open('http://127.0.0.1:${popupPort}/popup', '_blank'); true` }, execA);
      await sleep(800);
      const afterA = await h.invoke('browser_eval', { expression: '1 + 1' }, execA);
      const afterB = await h.invoke('browser_eval', { expression: '2 + 2' }, execB);
      check('任一 page 的 window.open 仍被拦截（零 Document 请求）且不误杀 owned page',
        opened.ok === true && popupHits.length === 0 && host.pageCount === pagesBefore
        && afterA.value?.value === 2 && afterB.value?.value === 4,
        { hits: popupHits, pagesBefore, pagesAfter: host.pageCount, A: afterA.value?.value, B: afterB.value?.value });

      const blocked = await api('POST', '/navigate', { body: { url: `http://127.0.0.1:${popupPort}/to-metadata` }, identity: { sid: 'sid-a' } });
      const bAfterBlocked = await h.invoke('browser_eval', { expression: '3 + 3' }, execB);
      check('A 的 Document 重定向阻断不挂住 B（B 无 error/network 污染）',
        blocked.statusCode === 500 && blocked.json?.code === 'NAV_FAILED'
        && bAfterBlocked.ok === true && bAfterBlocked.value?.value === 6 && runtimeOf('ws-b')?.lastError === '',
        { blocked: blocked.json, B: bAfterBlocked.value?.value, BError: runtimeOf('ws-b')?.lastError });
      await api('POST', '/navigate', { body: { url: fixture.url }, identity: { sid: 'sid-a' } });
    } finally {
      await new Promise((resolve) => popupServer.close(resolve));
    }
  }

  /* ------------------------------------------------------------------------ lease / concurrency */
  {
    const controller = new AbortController();
    const slowA = h.invoke('browser_eval', { expression: 'new Promise(resolve => setTimeout(() => resolve("a-done"), 4000))' }, { ...execA, signal: controller.signal });
    await waitFor(() => runtimeOf('ws-a')?.active > 0 && runtimeOf('ws-a')?.lease?.sessionId === 'sid-a', { timeoutMs: 5000, label: 'A lease' });
    const a2 = await h.invoke('browser_eval', { expression: '1' }, execA2);
    const b = await h.invoke('browser_eval', { expression: '2' }, execB);
    check('A 持 lease 时同工作区 A2 BUSY，B 成功', a2.threw === true && a2.error?.code === 'BUSY' && a2.error?.retryable === true && b.ok === true && b.value?.ok === true,
      { a2: a2.error, b: b.error || b.value });

    const startedA = Date.now();
    controller.abort();
    const aborted = await slowA;
    check('A 的慢 eval 取消返回 ABORTED 且只回收 A', aborted.threw === true && aborted.error?.code === 'ABORTED'
      && runtimeOf('ws-a')?.running === false && runtimeOf('ws-b')?.running === true,
    { error: aborted.error, A: runtimeOf('ws-a')?.running, B: runtimeOf('ws-b')?.running, ms: Date.now() - startedA });

    const afterAbortB = await h.invoke('browser_eval', { expression: 'document.title' }, execB);
    check('A abort 后 B 仍可操作（同 PID 仍存活）', afterAbortB.ok === true && afterAbortB.value?.value === 'DSH UI Testing Fixture — Second Page'
      && scanPluginChromeProcesses().filter((proc) => proc.parentPid === process.pid).length === 1,
    { B: afterAbortB.value?.value, processes: scanPluginChromeProcesses().filter((proc) => proc.parentPid === process.pid).map((proc) => proc.pid) });

    // Concurrent slow evals in A and B: both succeed, and they do not serialise each other.
    const [slowA2, slowB2] = await Promise.all([
      h.invoke('browser_eval', { expression: 'new Promise(resolve => setTimeout(() => resolve("slow-a"), 600))' }, execA),
      h.invoke('browser_eval', { expression: 'new Promise(resolve => setTimeout(() => resolve("slow-b"), 600))' }, execB),
    ]);
    check('A/B 并发慢 eval 均成功（各自队列，不互相串行）', slowA2.ok && slowB2.ok && slowA2.value?.value === 'slow-a' && slowB2.value?.value === 'slow-b',
      { A: slowA2.value, B: slowB2.value });

    // agent/disposed releases the lease of that session only (across entries).
    await h.invoke('browser_network', {}, execA);
    await h.ctx.emit('agent/disposed', { agent: { id: 'sid-a' } });
    const afterDispose = await h.invoke('browser_network', {}, execA2);
    check('agent/disposed 只释放对应 session 的租约（同工作区其他 session 可继续）', afterDispose.ok === true, afterDispose.error || { ok: true });
  }

  /* ------------------------------------------------------------- close / reopen / target destroy */
  {
    await api('POST', '/ensure', { body: { url: fixture.url }, identity: { sid: 'sid-a' } });
    await waitTitle({ sid: 'sid-a' }, 'DSH UI Testing Fixture');
    const oldTargetA = runtimeOf('ws-a').page.targetId;
    const oldEpochA = runtimeOf('ws-a').frames.epoch;
    const targetB = runtimeOf('ws-b').page.targetId;
    const closeA = await api('POST', '/close', { body: {}, identity: { sid: 'sid-a' } });
    check('scoped /close 只关闭 A（B 仍 running、PID 仍存活）', closeA.json?.ok === true
      && runtimeOf('ws-a').running === false && runtimeOf('ws-b').running === true
      && scanPluginChromeProcesses().filter((proc) => proc.parentPid === process.pid).length === 1,
    { A: runtimeOf('ws-a').running, B: runtimeOf('ws-b').running });
    check('A close 后帧缓存清空（seq=0），B 的帧仍在', runtimeOf('ws-a').frames.seq === 0 && runtimeOf('ws-b').frames.seq > 0,
      { ASeq: runtimeOf('ws-a').frames.seq, BSeq: runtimeOf('ws-b').frames.seq });

    const ensureAgain = await api('POST', '/ensure', { body: {}, identity: { sid: 'sid-a' } });
    check('A close 后可重新 ensure（新 targetId / 新 page CDP）', ensureAgain.statusCode === 200
      && runtimeOf('ws-a').page.targetId !== oldTargetA && runtimeOf('ws-a').page.targetId
      && runtimeOf('ws-b').page.targetId === targetB,
    { oldTargetA, newTargetA: runtimeOf('ws-a').page.targetId, targetB });
    check('A 重开后旧帧/旧 epoch 不复活', runtimeOf('ws-a').frames.epoch > oldEpochA && runtimeOf('ws-a').frames.seq < runtimeOf('ws-b').frames.seq + 100,
      { oldEpochA, newEpochA: runtimeOf('ws-a').frames.epoch, ASeq: runtimeOf('ws-a').frames.seq });

    // External target destruction (Target.closeTarget) behaves like a CDP disconnect for A only.
    const targetA = runtimeOf('ws-a').page.targetId;
    await host.browserCdp.send('Target.closeTarget', { targetId: targetA });
    await waitFor(() => runtimeOf('ws-a')?.cdp?.closed === true, { timeoutMs: 5000, label: 'A CDP disconnect' });
    const stateAfterCrash = (await api('GET', '/state', { identity: { sid: 'sid-a' } })).json;
    const bAfterCrash = await h.invoke('browser_eval', { expression: '1 + 1' }, execB);
    check('A 的 targetDestroyed/CDP 断线只回收 A（B 继续工作、B 无 error）', stateAfterCrash.running === false && bAfterCrash.ok === true && bAfterCrash.value?.value === 2
      && runtimeOf('ws-b').lastError === '', { A: stateAfterCrash.running, B: bAfterCrash.value?.value, BError: runtimeOf('ws-b').lastError });
    const reEnsureA = await api('POST', '/ensure', { body: {}, identity: { sid: 'sid-a' } });
    check('CDP 断线后 A 可重新懒启动，B 的 target 不变', reEnsureA.statusCode === 200 && runtimeOf('ws-a').running === true
      && runtimeOf('ws-b').page.targetId === targetB, { A: runtimeOf('ws-a').page.targetId, B: runtimeOf('ws-b').page.targetId });
  }

  /* ------------------------------------------------------------------ frame push / metrics scopes */
  {
    server = await startPluginHttpServer(h);
    pluginHttpServers.push(server);
    const wsUrl = `${server.wsUrl}/plugins/ui-testing/frames?scopeVersion=1&binding=`;
    const clientA = await connectFrameWebSocket(`${wsUrl}${encodeURIComponent(runtimeIdA)}`, { timeoutMs: 6000 }).catch((failure) => failure);
    const clientB = await connectFrameWebSocket(`${wsUrl}${encodeURIComponent(runtimeIdB)}`, { timeoutMs: 6000 }).catch((failure) => failure);
    check('A/B scoped WS 均握手成功', clientA.opened === true && clientB.opened === true, { A: clientA.error, B: clientB.error });
    const helloA = await waitForWebSocket(clientA, (value) => value.hellos[0], { timeoutMs: 5000, label: 'hello A' }).catch(() => undefined);
    const helloB = await waitForWebSocket(clientB, (value) => value.hellos[0], { timeoutMs: 5000, label: 'hello B' }).catch(() => undefined);
    check('hello 携带各自 scopeId/runtimeId（不串）', helloA?.runtimeId === runtimeIdA && helloB?.runtimeId === runtimeIdB
      && helloA?.scopeId === 'ws_' + createHash('sha256').update('ws-a').digest('hex').slice(0, 16)
      && helloA?.scopeId !== helloB?.scopeId,
    { helloA, helloB });

    const nudge = async (sid, tag) => {
      for (let index = 0; index < 3; index += 1) {
        await h.invoke('browser_eval', { expression: `document.body.style.background='rgb(${index * 30 + 20},${tag === 'a' ? 10 : 90},30)'` }, execOf(sid));
        await sleep(200);
      }
    };
    await nudge('sid-a', 'a');
    await nudge('sid-b', 'b');
    await waitForWebSocket(clientA, (value) => value.frames.length >= 2, { timeoutMs: 8000, label: 'frames A' }).catch(() => {});
    await waitForWebSocket(clientB, (value) => value.frames.length >= 2, { timeoutMs: 8000, label: 'frames B' }).catch(() => {});
    const headersA = clientA.frames.map((frame) => frame.header);
    const headersB = clientB.frames.map((frame) => frame.header);
    check('A/B 各自持续收到 JPEG 帧且帧头 runtimeId 不串',
      clientA.frames.length >= 2 && clientB.frames.length >= 2
      && headersA.every((header) => header.runtimeId === runtimeIdA && header.scopeId === helloA.scopeId)
      && headersB.every((header) => header.runtimeId === runtimeIdB && header.scopeId === helloB.scopeId)
      && clientA.frames.every((frame) => isJpegBuffer(frame.jpeg)),
      { A: { frames: clientA.frames.length, seqs: headersA.map((h) => h.seq) }, B: { frames: clientB.frames.length, seqs: headersB.map((h) => h.seq) } });
    const ackA = runtimeOf('ws-a')?.ackFailures;
    const ackB = runtimeOf('ws-b')?.ackFailures;
    check('A/B screencast ACK 各自成功（ackFailures=0）', ackA === 0 && ackB === 0, { ackA, ackB });

    const metricsA = (await api('GET', '/metrics', { identity: { binding: runtimeIdA } })).json;
    const metricsB = (await api('GET', '/metrics', { identity: { binding: runtimeIdB } })).json;
    check('GET /metrics 按 scope 分流（各自 clients=1）', metricsA?.host?.clients === 1 && metricsB?.host?.clients === 1
      && metricsA?.host?.push?.runtimeId === runtimeIdA && metricsB?.host?.push?.runtimeId === runtimeIdB,
    { A: metricsA?.host?.clients, B: metricsB?.host?.clients, AScope: metricsA?.host?.push?.runtimeId, BScope: metricsB?.host?.push?.runtimeId });

    await closeFrameWebSocket(clientA);
    await waitFor(() => (runtimeOf('ws-a')?.frameTransport?.metrics?.().clients ?? 0) === 0, { timeoutMs: 5000, label: 'A clients 0' }).catch(() => {});
    const metricsAAfter = (await api('GET', '/metrics', { identity: { binding: runtimeIdA } })).json;
    const metricsBAfter = (await api('GET', '/metrics', { identity: { binding: runtimeIdB } })).json;
    check('关闭 A 的 WS 不影响 B 的 viewer/metrics', metricsAAfter?.host?.clients === 0 && metricsBAfter?.host?.clients === 1,
      { A: metricsAAfter?.host?.clients, B: metricsBAfter?.host?.clients });

    const legacyMetrics = (await legacyApi('GET', '/metrics')).json;
    check('无 scope 的 /metrics 只返回 legacy 冷投影（不跨 scope 聚合）', legacyMetrics?.ok === true && !('scopes' in (legacyMetrics || {})), legacyMetrics);
    await closeFrameWebSocket(clientB);
  }

  /* ------------------------------------------------------------------ recent / binding protocol */
  {
    const recent1 = (await api('GET', '/state', { identity: { scope: 'recent' } })).json;
    const bound1 = (await api('GET', '/state', { identity: { binding: recent1?.ui?.runtimeId } })).json;
    check('recent 首次解析返回 runtimeId，binding 命中同一实例', recent1?.ui?.runtimeId && bound1?.ui?.runtimeId === recent1.ui.runtimeId, { recent: recent1?.ui?.runtimeId, bound: bound1?.ui?.runtimeId });

    // A real interaction updates recent; a fixed binding must NOT follow it.
    await h.invoke('browser_eval', { expression: '1' }, execA);
    const boundStill = (await api('GET', '/state', { identity: { binding: recent1.ui.runtimeId } })).json;
    const recent2 = (await api('GET', '/state', { identity: { scope: 'recent' } })).json;
    check('binding 固定不追 recent；真实操作后 recent 才更新', boundStill?.ui?.runtimeId === recent1.ui.runtimeId && recent2?.ui?.runtimeId === runtimeIdA,
      { bound: boundStill?.ui?.runtimeId, recent2: recent2?.ui?.runtimeId, expectedRecent: runtimeIdA });

    const before = registry.entries.size;
    const unknownBinding = await api('GET', '/state', { identity: { binding: '00000000-0000-4000-8000-000000000000' } });
    check('未知 binding → 404 SCOPE_NOT_FOUND 且不创建 entry', unknownBinding.statusCode === 404 && unknownBinding.json?.code === 'SCOPE_NOT_FOUND' && registry.entries.size === before,
      { status: unknownBinding.statusCode, entriesBefore: before, entriesAfter: registry.entries.size });

    const unassigned1 = (await api('GET', '/state', { identity: { scope: 'unassigned' } })).json;
    const unassignedBound = (await api('GET', '/state', { identity: { binding: unassigned1?.ui?.runtimeId } })).json;
    check('unassigned 冷 entry 也可固定 binding', unassigned1?.ui?.runtimeId && unassignedBound?.ui?.runtimeId === unassigned1.ui.runtimeId, { first: unassigned1?.ui?.runtimeId, bound: unassignedBound?.ui?.runtimeId });
  }

  /* ------------------------------------------------------------------- strict owner-only (admit) */
  {
    const nonOwner = createFakeConnectionService({ rejection: undefined, admit: { peer: { id: 'gui-2' } }, browserPeer: { id: 'gui-1' } });
    const entriesBefore = registry.entries.size;
    const pagesBefore = host.pageCount;
    const recentBefore = registry.recentKey;
    h.setConnection(nonOwner);
    const forbidden = await api('GET', '/state', { identity: { sid: 'sid-a' } });
    check('非 owner（peer.id≠browserPeer.id）→ 403 SCOPE_FORBIDDEN', forbidden.statusCode === 403 && forbidden.json?.code === 'SCOPE_FORBIDDEN', forbidden.json);
    const forbiddenReload = await api('POST', '/reload', { body: {}, identity: { sid: 'sid-a' } });
    check('非 owner 的 /reload → 403', forbiddenReload.statusCode === 403, forbiddenReload.json);
    check('非 owner 拒绝零副作用（entries/pages/recent 不变）', registry.entries.size === entriesBefore && host.pageCount === pagesBefore && registry.recentKey === recentBefore,
      { entriesBefore, entriesAfter: registry.entries.size, pagesBefore, pagesAfter: host.pageCount });
    h.setConnection(connection);

    // DSH admit() shape: { peer } or { rejection: 401|403 }. Both rejection shapes must map
    // to their status, not to a generic 503.
    for (const [status, label] of [[401, 'admit 返回 {rejection:401} → 401'], [403, 'admit 返回 {rejection:403} → 403']]) {
      const rejectionHarness = await createHarness({
        name: `admit-${status}`,
        connection: createFakeConnectionService({ rejection: undefined, admit: { rejection: status } }),
        sessions, workspaceRegistry, sessionPersistence,
      });
      harnesses.push(rejectionHarness);
      const result = await rejectionHarness.request({ method: 'GET', path: '/plugins/ui-testing/state', headers: scopeHeaders({ sid: 'sid-a' }) });
      check(label, result.statusCode === status, { status: result.statusCode, body: result.json });
    }

    const noAdmitHarness = await createHarness({ name: 'no-admit', connection: createFakeConnectionService({ rejection: undefined }), sessions, workspaceRegistry, sessionPersistence });
    harnesses.push(noAdmitHarness);
    const noAdmit = await noAdmitHarness.request({ method: 'GET', path: '/plugins/ui-testing/state', headers: scopeHeaders({ sid: 'sid-a' }) });
    const noAdmitLegacy = await noAdmitHarness.request({ method: 'GET', path: '/plugins/ui-testing/state' });
    check('缺 admit → scoped 401，legacy 仍 200', noAdmit.statusCode === 401 && noAdmitLegacy.statusCode === 200, { scoped: noAdmit.statusCode, legacy: noAdmitLegacy.statusCode });

    const rejectedHarness = await createHarness({ name: 'rejected', connection: createFakeConnectionService({ rejection: 401 }), sessions, workspaceRegistry, sessionPersistence });
    harnesses.push(rejectedHarness);
    const rejected = await rejectedHarness.request({ method: 'GET', path: '/plugins/ui-testing/state', headers: scopeHeaders({ sid: 'sid-a' }) });
    check('requestRejection=401 → scoped 401', rejected.statusCode === 401, rejected.statusCode);
  }

  /* --------------------------------------------------------------------------------- 9 tools */
  {
    const toolCases = [
      ['browser_navigate', { url: `${fixture.url}?tool=1` }],
      ['browser_eval', { expression: '({tool:true})' }],
      ['browser_screenshot', {}],
      ['browser_input', { events: [] }],
      ['browser_network', { limit: 10 }],
      ['browser_computed_style', { selector: 'body', properties: ['display'] }],
      ['browser_http_request', { url: fixture.url + 'api/data' }],
      ['browser_state', {}],
      ['browser_capabilities', {}],
    ];
    const problems = [];
    for (const [name, args] of toolCases) {
      const result = await h.invoke(name, args, execA);
      const value = result.value;
      if (!result.ok) { problems.push({ name, threw: result.error }); continue; }
      if (value?.scope?.workspaceId !== 'ws-a') problems.push({ name, scope: value?.scope });
      const lossless = losslessProblems(value);
      if (lossless.length) problems.push({ name, lossless });
      const text = (result.content || []).filter((block) => block.type === 'text').map((block) => block.text).join('\n');
      if (!text.includes('scope')) problems.push({ name, text: 'scope missing from render' });
    }
    check('9 工具均返回 scope（ws-a）且仍是 lossless JSON/render', problems.length === 0, problems);

    const caps = (await h.invoke('browser_capabilities', {}, execA)).value;
    const isolation = caps?.runtime?.workspaceIsolation;
    check('capabilities 报告 page 隔离能力（cookie/cache=false、8/600000 默认、viewer TTL）',
      caps?.runtime?.isolation === 'single-owner-lease' && isolation?.page === true && isolation?.cookie === false && isolation?.cache === false
      && WORKSPACE_ISOLATION_DEFAULTS.maxPages === 8 && WORKSPACE_ISOLATION_DEFAULTS.idleMs === 600000
      && isolation?.maxPages === 8 && isolation?.idleMs === 600000 && isolation?.viewerTtlMs === WORKSPACE_ISOLATION_DEFAULTS.viewerTtlMs,
      { isolation, defaults: WORKSPACE_ISOLATION_DEFAULTS });

    // browser_http_request is evidence-only: no page, no entry for a fresh workspace.
    const freshExec = execOf('s9');
    const before = registry.entries.size;
    const httpTool = await h.invoke('browser_http_request', { url: fixture.url + 'api/data' }, freshExec);
    check('browser_http_request 只带 scope 证据，不创建 page/entry', httpTool.ok === true && httpTool.value?.scope?.workspaceId === 'ws-9'
      && registry.entries.size === before && !registry.peek('workspace:ws-9'), { ok: httpTool.ok, entriesBefore: before, entriesAfter: registry.entries.size });
  }

  /* ------------------------------------------------------- non-goal observation: shared storage */
  {
    await h.invoke('browser_eval', { expression: "localStorage.setItem('dsh-iso-observation','from-a'); true" }, execA);
    const seenByB = (await h.invoke('browser_eval', { expression: "localStorage.getItem('dsh-iso-observation')" }, execB)).value?.value;
    observe('same-origin localStorage shared between workspaces (explicit non-goal)', { seenByB });
  }

  /* ------------------------------------------------------------------ 8 page budget observation */
  {
    const before = host.pageCount;
    for (let index = 1; index <= 6; index += 1) {
      await api('POST', '/ensure', { body: { url: fixture.url }, identity: { sid: `s${index}` } });
    }
    const total = host.pageCount;
    observe('8 pages', { before, total, rssKb: await rssKb(host.proc.pid), profileDir: host.profileDir, pid: host.proc.pid });
    check('8 个 page 在同一 Chromium 内（预算 8）', total === 8, { before, total });
    for (let index = 1; index <= 6; index += 1) {
      await api('POST', '/close', { body: {}, identity: { sid: `s${index}` } });
    }
  }

  /* ------------------------------------------------------ lifecycle: max pages / idle / viewer */
  {
    const saved = {
      maxPages: process.env.DSH_UI_TESTING_MAX_PAGES,
      idleMs: process.env.DSH_UI_TESTING_IDLE_MS,
      viewer: process.env.DSH_UI_TESTING_VIEWER_TTL_MS,
    };
    process.env.DSH_UI_TESTING_MAX_PAGES = '3';
    process.env.DSH_UI_TESTING_IDLE_MS = '600000';
    const hLife = await createHarness({ name: 'lifecycle', ...harnessOptions });
    harnesses.push(hLife);
    if (saved.maxPages === undefined) delete process.env.DSH_UI_TESTING_MAX_PAGES; else process.env.DSH_UI_TESTING_MAX_PAGES = saved.maxPages;
    if (saved.idleMs === undefined) delete process.env.DSH_UI_TESTING_IDLE_MS; else process.env.DSH_UI_TESTING_IDLE_MS = saved.idleMs;
    const life = hLife.ctx.__internal.plugin.registry;
    const wsBySid = { s1: 'ws-1', s2: 'ws-2', s3: 'ws-3', s4: 'ws-4', s5: 'ws-5', s6: 'ws-6', s7: 'ws-7', s8: 'ws-8', s9: 'ws-9' };
    const lifeRuntime = (sid) => life.entries.get(`workspace:${wsBySid[sid]}`)?.runtime;

    const ensureLife = (sid) => hLife.request({ method: 'POST', path: '/plugins/ui-testing/ensure', body: { url: fixture.url }, headers: scopeHeaders({ sid }) });
    for (const sid of ['s1', 's2', 's3']) await ensureLife(sid);
    check('lifecycle harness: 3 pages at maxPages=3', life.pageCount === 3, { pageCount: life.pageCount, maxPages: life.maxPages });

    // Hold leases/in-flight *agent* operations on all three pages: no victim is evictable.
    const slow = ['s1', 's2', 's3'].map((sid) => hLife.invoke('browser_eval', {
      expression: 'new Promise(resolve => setTimeout(() => resolve(1), 1500))',
    }, execOf(sid)));
    await waitFor(() => ['s1', 's2', 's3'].every((sid) => lifeRuntime(sid)?.active > 0 && lifeRuntime(sid)?.lease?.sessionId === sid),
      { timeoutMs: 5000, label: '3 in-flight agent ops' });
    const limited = await ensureLife('s4');
    check('满额且无 eligible 实例 → 503 RUNTIME_LIMIT（retryable）', limited.statusCode === 503 && limited.json?.code === 'RUNTIME_LIMIT' && limited.json?.retryable === true,
      { status: limited.statusCode, body: limited.json });
    await Promise.all(slow);
    for (const sid of ['s1', 's2', 's3']) await hLife.ctx.emit('agent/disposed', { agent: { id: sid } });
    const afterRelease = await ensureLife('s4');
    check('释放租约后第 4 个 scope 通过 LRU 回收获得 page', afterRelease.statusCode === 200 && life.pageCount === 3, { status: afterRelease.statusCode, pageCount: life.pageCount });

    // Same-key single flight: concurrent ensures create exactly one page.
    const sameKey = await Promise.all(Array.from({ length: 5 }, () => ensureLife('s6')));
    check('同 key 并发 ensure 只开一个 page', sameKey.every((result) => result.statusCode === 200) && life.pageCount === 3,
      { statuses: sameKey.map((result) => result.statusCode), pageCount: life.pageCount });

    // Concurrent cold ensures cannot exceed the reservation cap.
    const burst = await Promise.all(['s1', 's2', 's3', 's4', 's5', 's6', 's7', 's8', 's9'].map((sid) => ensureLife(sid)));
    check('并发 ensure 不穿 3 页上限（每次结果 ok 或 RUNTIME_LIMIT）',
      life.pageCount <= 3 && burst.every((result) => result.statusCode === 200 || result.json?.code === 'RUNTIME_LIMIT'),
      { pageCount: life.pageCount, hostRunning: life.host?.running, procPid: life.host?.proc?.pid, procAlive: life.host?.proc ? (() => { try { process.kill(life.host.proc.pid, 0); return true; } catch { return false; } })() : null,
        results: burst.map((result) => ({ status: result.statusCode, code: result.json?.code, message: result.json?.message, details: result.json?.details })),
        hostLogs: hLife.logs.filter((line) => /browser host closing|closing owned target|blocking popup|chromium ready|evicting idle|run[+-]/.test(line)).slice(-30) });

    // Concurrent close-last-page + ensure must not kill the host under the new page.
    const [closeOne, ensureOther] = await Promise.all([
      hLife.request({ method: 'POST', path: '/plugins/ui-testing/close', body: {}, headers: scopeHeaders({ sid: 's1' }) }),
      ensureLife('s9'),
    ]);
    check('并发 cold ensure + close 最后页不误杀 host', closeOne.json?.ok === true && ensureOther.statusCode === 200 && life.pageCount >= 1 && life.host?.running === true,
      { close: closeOne.json, ensure: ensureOther.statusCode, pages: life.pageCount, hostRunning: life.host?.running });
    await hLife.dispose();
    harnesses.splice(harnesses.indexOf(hLife), 1);

    // Idle sweep + viewer TTL (fast test values).
    process.env.DSH_UI_TESTING_MAX_PAGES = '8';
    process.env.DSH_UI_TESTING_IDLE_MS = '1500';
    process.env.DSH_UI_TESTING_VIEWER_TTL_MS = '700';
    const hIdle = await createHarness({ name: 'idle', ...harnessOptions });
    harnesses.push(hIdle);
    if (saved.maxPages === undefined) delete process.env.DSH_UI_TESTING_MAX_PAGES; else process.env.DSH_UI_TESTING_MAX_PAGES = saved.maxPages;
    if (saved.idleMs === undefined) delete process.env.DSH_UI_TESTING_IDLE_MS; else process.env.DSH_UI_TESTING_IDLE_MS = saved.idleMs;
    if (saved.viewer === undefined) delete process.env.DSH_UI_TESTING_VIEWER_TTL_MS; else process.env.DSH_UI_TESTING_VIEWER_TTL_MS = saved.viewer;
    const idle = hIdle.ctx.__internal.plugin.registry;
    const idleRuntime = () => idle.entries.get('workspace:ws-1')?.runtime;
    const idleEnsure = await hIdle.request({ method: 'POST', path: '/plugins/ui-testing/ensure', body: { url: fixture.url }, headers: scopeHeaders({ sid: 's1' }) });
    const idleRuntimeId = idleRuntime()?.runtimeId;
    observe('idle harness', { status: idleEnsure.statusCode, idleMs: idle.idleMs, viewerTtlMs: idle.viewerTtlMs, runtimeId: idleRuntimeId, page: Boolean(idleRuntime()?.page), keys: [...idle.entries.keys()] });
    // state polling must not renew idle: poll while waiting.
    for (let index = 0; index < 6; index += 1) {
      await hIdle.request({ method: 'GET', path: '/plugins/ui-testing/state', headers: scopeHeaders({ binding: idleRuntimeId }) });
      await sleep(150);
    }
    await waitFor(() => idleRuntime()?.page === undefined, { timeoutMs: 6000, label: 'idle page swept' }).catch(() => {});
    check('idle 回收 page（state 轮询不续 idle），entry 保留为冷实例', idleRuntime()?.page === undefined && idle.peek('workspace:ws-1') !== undefined,
      { page: Boolean(idleRuntime()?.page), entry: Boolean(idle.peek('workspace:ws-1')), keys: [...idle.entries.keys()], idleMs: idle.idleMs, lastUsedAt: idle.peek('workspace:ws-1')?.lastUsedAt });
    const reEnsureIdle = await hIdle.request({ method: 'POST', path: '/plugins/ui-testing/ensure', body: { url: fixture.url }, headers: scopeHeaders({ sid: 's1' }) });
    check('idle 回收后可重新 ensure（同一 runtimeId）', reEnsureIdle.statusCode === 200 && idleRuntime()?.running === true && idleRuntime()?.runtimeId === idleRuntimeId,
      { status: reEnsureIdle.statusCode, runtimeId: idleRuntime()?.runtimeId, expected: idleRuntimeId, entries: [...idle.entries.keys()] });

    // Lease/active protects from sweep; visible WS viewer protects until its TTL expires.
    const slowIdle = hIdle.request({
      method: 'POST', path: '/plugins/ui-testing/eval',
      body: { expression: 'new Promise(resolve => setTimeout(() => resolve(1), 1800))' },
      headers: scopeHeaders({ sid: 's1' }),
    });
    await sleep(1000);
    check('进行中的操作（active）阻止 idle 回收', idleRuntime()?.page !== undefined, { page: Boolean(idleRuntime()?.page), active: idleRuntime()?.active });
    await slowIdle;

    const idleServer = await startPluginHttpServer(hIdle);
    pluginHttpServers.push(idleServer);
    const wsClient = await connectFrameWebSocket(`${idleServer.wsUrl}/plugins/ui-testing/frames?scopeVersion=1&binding=${encodeURIComponent(idleRuntimeId)}`, { timeoutMs: 5000 }).catch((failure) => failure);
    check('idle harness WS 握手成功（viewer 心跳来源）', wsClient.opened === true, wsClient.error);
    await waitFor(() => (idleRuntime()?.viewers ?? 0) === 1, { timeoutMs: 3000, label: 'viewer 1' }).catch(() => {});
    // No metrics heartbeat: after the TTL the leaked WS no longer counts as a viewer.
    await waitFor(() => (idleRuntime()?.viewers ?? 0) === 0, { timeoutMs: 5000, label: 'viewer TTL expiry' }).catch(() => {});
    check('viewer TTL 生效：粗断/无心跳 WS 不再永久占额', (idleRuntime()?.viewers ?? 0) === 0, { viewers: idleRuntime()?.viewers, viewerUntil: idleRuntime()?.viewerUntil });
    await waitFor(() => idleRuntime()?.page === undefined, { timeoutMs: 6000, label: 'viewer-expired page swept' }).catch(() => {});
    check('viewer 过期后 page 可被 idle 回收', idleRuntime()?.page === undefined, { page: Boolean(idleRuntime()?.page) });
    await closeFrameWebSocket(wsClient);
    await hIdle.dispose();
    harnesses.splice(harnesses.indexOf(hIdle), 1);
  }
} finally {
  for (const item of pluginHttpServers) { try { await item.close(); } catch { /* ignore */ } }
  for (const item of harnesses) { try { await item.dispose(); } catch { /* ignore */ } }
  try { await fixture.close(); } catch { /* ignore */ }
  for (const dir of tempDirs) { try { await rm(dir, { recursive: true, force: true }); } catch { /* ignore */ } }
  const directory = new URL(`./runs/workspace-isolation-${Date.now()}/`, import.meta.url);
  await mkdir(directory, { recursive: true });
  await writeFile(new URL('report.json', directory), JSON.stringify({
    generatedAt: new Date().toISOString(),
    node: process.version,
    chrome: process.env.DSH_UI_TESTING_CHROME,
    defaults: WORKSPACE_ISOLATION_DEFAULTS,
    scope: 'Host half: one apply = one headless Chromium/profile with one page target per workspace. Isolated: URL/title/history, viewport, frame source+ACK, network observation buffer, queue, lease, error, metrics, runtimeId. NOT isolated (explicit non-goal): cookies/localStorage/IndexedDB/cache/service workers in the shared profile. Real Chromium + fake Cordis ctx; no DSH 3081/GUI evidence here.',
    checks,
    observations,
    summary: { total: checks.length, passed: checks.filter((item) => item.pass).length, failed },
  }, null, 2));
  console.log(`\nworkspace-isolation: ${checks.length - failed}/${checks.length} PASS, ${failed} failed`);
  console.log(`evidence: ${directory.pathname}report.json`);
  process.exitCode = failed === 0 ? 0 : 1;
}
