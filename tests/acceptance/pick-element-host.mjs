#!/usr/bin/env node
/**
 * Host read-only element-pick acceptance: `POST /plugins/ui-testing/element` (v1 contract).
 *
 * Drives the *real* plugin (index.js) through the fake-Cordis harness in this directory, with the
 * plugin's own headless Chromium and the loopback fixture `/pick-element.html`. Every assertion is
 * one of:
 *   - a real DOM read through browser_eval (`getBoundingClientRect`, `scrollX/scrollY`,
 *     `document.elementFromPoint`, `outerHTML`, `classList`),
 *   - a raw CDP read on the same runtime (`DOM.getNodeForLocation`, `DOM.describeNode`,
 *     `DOM.getBoxModel`, `Page.getLayoutMetrics`) for the coordinate-space proof,
 *   - a raw HTTP response of the route (status + JSON), or
 *   - a counted side effect on the real Runtime (`run`/`ensure` call counts, `lastError`,
 *     `lease`, `active`, `clientMetrics`, page target identity).
 * Nothing here is "the route said it worked".
 *
 * Coordinate space (H0, measured — not assumed): the route takes page DOCUMENT CSS px
 * (`getBoundingClientRect + scrollX/scrollY`, canvas space when O = 0). `DOM.getNodeForLocation`
 * takes document coordinates and only hits the currently visible area; `DOM.getBoxModel` returns
 * ROOT-FRAME VIEWPORT quads, so its rect is translated by `Page.getLayoutMetrics` pageX/pageY.
 *
 * Probes: H1 route/cold, H0 coordinate space, H2 fixed hover hit, H3 scroll invariance, H4 detail
 * (id selector, nth-of-type path, truncation), H5 blank/off-screen, H6 read-only semantics,
 * H7 invalid arguments, H8 casing + cross-frame fail-closed, H8c shadow-DOM detail
 * (root-scoped selector + shadowHost/closedShadow), H8d unknown-main-frame fail-closed, H12
 * scroll/loaderId consistency + route-level visible-area boundary + navigation, H1b closed page
 * stays cold.
 * NOT_RUN (recorded, never faked): server-rendered documents (no SSR fixture in this repository).
 * Nested same-process frames (an <iframe> inside the page) ARE covered: H8 picks a button and a
 * <select> inside the frame, checks the ROOT-frame rect, that frame's loaderId, the select
 * projection/target and one write through it. `loaderId` is available on this Chromium and is
 * asserted against a raw `Page.getFrameTree` read (no NOT_RUN needed).
 *
 * Response reasons: `no-page` (cold/no page), `no-hit` (blank background / no node), `stale`
 * (CDP read failed, or a nested hit whose frame is no longer in the frame tree),
 * `out-of-viewport` (the document point is outside the currently visible viewport).
 *
 * Run: node tests/acceptance/pick-element-host.mjs
 * Exit: 0 = every required check passed (NOT_RUN is not a failure), 1 = a check failed,
 *       2 = the environment is unusable / the watchdog fired.
 *
 * Evidence: tests/acceptance/runs/pick-element-host-<ISO>-<pid>/{report.json,run-report.json,
 * run.log,samples.json}
 */
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(HERE, '..', '..');
const DEFAULT_CHROME = '/opt/google/chrome/chrome';
const FIXTURE_PAGE = '/pick-element.html';
const TOTAL_TIMEOUT_MS = Number(process.env.DSH_PICK_TIMEOUT_MS) > 0
  ? Number(process.env.DSH_PICK_TIMEOUT_MS)
  : 180000;
const STARTED_AT = new Date();
const STAMP = STARTED_AT.toISOString().replace(/[:.]/g, '-');
const EVIDENCE_DIR = join(HERE, 'runs', `pick-element-host-${STAMP}-${process.pid}`);

const logLines = [];
function log(line) {
  logLines.push(line);
  console.log(line);
}

/* ------------------------------------------------------------------------------------------------
 * Report plumbing
 * ---------------------------------------------------------------------------------------------- */

function jsonSafe(value, depth = 0) {
  if (value === undefined) return null;
  if (value === null || typeof value !== 'object') {
    if (typeof value === 'number' && !Number.isFinite(value)) return `[number ${String(value)}]`;
    if (typeof value === 'string' && value.length > 4000) return value.slice(0, 4000) + `…[${value.length} chars]`;
    return value;
  }
  if (depth > 6) return '[depth-limit]';
  if (Array.isArray(value)) return value.slice(0, 80).map((item) => jsonSafe(item, depth + 1));
  const out = {};
  for (const [key, child] of Object.entries(value)) out[key] = jsonSafe(child, depth + 1);
  return out;
}

const report = {
  schemaVersion: 1,
  suite: 'pick-element-host',
  generatedAt: STARTED_AT.toISOString(),
  command: 'node tests/acceptance/pick-element-host.mjs',
  environment: {},
  probes: [],
  findings: [],
  observations: {},
};

let currentProbe = null;

function beginProbe(id, title, expected) {
  currentProbe = { id, title, expected, status: 'running', startedAt: Date.now(), checks: [], findings: [] };
  report.probes.push(currentProbe);
  log(`\n== ${id} — ${title}`);
  return currentProbe;
}

/** A probe that this slice explicitly does not cover: recorded, never counted as PASS/FAIL. */
function notRunProbe(id, title, reason) {
  const probe = {
    id, title, expected: 'documented NOT_RUN', status: 'skip', notRun: String(reason),
    startedAt: Date.now(), durationMs: 0, checks: [], findings: [],
  };
  report.probes.push(probe);
  log(`\n== ${id} — ${title}`);
  log(`  [NOT_RUN] ${reason}`);
  return probe;
}

function check(label, pass, actual, expected, { advisory = false } = {}) {
  const entry = { label, expected: jsonSafe(expected), actual: jsonSafe(actual), pass: Boolean(pass), advisory };
  currentProbe.checks.push(entry);
  const tag = entry.pass ? 'PASS' : (advisory ? 'WARN' : 'FAIL');
  log(`  [${tag}] ${label}`);
  if (!entry.pass) log(`         actual: ${JSON.stringify(entry.actual).slice(0, 900)}`);
  return entry;
}

function finding(id, severity, summary) {
  const entry = { id, severity, summary };
  report.findings.push(entry);
  if (currentProbe) currentProbe.findings.push(entry);
  log(`  [FINDING ${id}/${severity}] ${summary}`);
}

async function runProbe(id, title, expected, fn) {
  beginProbe(id, title, expected);
  try {
    await fn();
    const required = currentProbe.checks.filter((item) => !item.advisory);
    const failed = required.filter((item) => !item.pass);
    currentProbe.status = failed.length ? 'fail' : 'pass';
    currentProbe.actual = failed.length
      ? `${failed.length}/${required.length} 项必需检查失败：${failed.map((item) => item.label).join('；')}`
      : `${required.length}/${required.length} 项必需检查通过`;
  } catch (error) {
    currentProbe.status = 'fail';
    currentProbe.actual = `probe 抛出异常：${error && error.message ? error.message : String(error)}`;
    currentProbe.error = jsonSafe({
      name: error?.name, message: String(error?.message || error),
      stack: String(error?.stack || '').split('\n').slice(0, 8),
    });
    log(`  [FAIL] probe threw: ${currentProbe.actual}`);
  } finally {
    currentProbe.durationMs = Date.now() - currentProbe.startedAt;
  }
}

/* ------------------------------------------------------------------------------------------------
 * Assertion helpers
 * ---------------------------------------------------------------------------------------------- */

const sleep = (ms) => new Promise((resolve) => { setTimeout(resolve, ms); });

function waitFor(condition, { timeoutMs = 8000, intervalMs = 60, label = 'condition' } = {}) {
  return new Promise((resolve, reject) => {
    const started = Date.now();
    let last;
    const tick = async () => {
      try {
        last = await condition();
        if (last) return resolve(last);
      } catch (error) {
        last = String((error && error.message) || error);
      }
      if (Date.now() - started >= timeoutMs) {
        return reject(new Error(`timed out waiting for ${label} (last=${JSON.stringify(jsonSafe(last))})`));
      }
      setTimeout(tick, intervalMs);
    };
    tick();
  });
}

/** Scroll the real page and wait until its own DOM readback confirms it. */
const ensureScroll = async (y) => {
  await pageEval(`window.scrollTo(0, ${Number(y)})`);
  await waitFor(async () => (await pageTruth()).scrollY === y, { timeoutMs: 8000, label: `scrollY=${y}` });
};

const near = (a, b, tolerance = 1) => Number.isFinite(a) && Number.isFinite(b) && Math.abs(a - b) <= tolerance;

function rectClose(actual, expected, tolerance = 1) {
  if (!actual || !expected) return false;
  return ['x', 'y', 'width', 'height'].every((key) => near(actual[key], expected[key], tolerance));
}

/** Collapse whitespace and cut to `max` code points — the suite's own contract check. */
function collapse(value, max) {
  const collapsed = String(value == null ? '' : value).replace(/\s+/gu, ' ').trim();
  const chars = Array.from(collapsed);
  return chars.length > max ? chars.slice(0, max).join('') : chars.join('');
}

/* ------------------------------------------------------------------------------------------------
 * Environment / state
 * ---------------------------------------------------------------------------------------------- */

const state = {
  harness: undefined,
  fixture: undefined,
  runtime: undefined,
  captureRoot: undefined,
  profilesBefore: [],
  cleanupResult: undefined,
};

const scopedHeaders = { 'x-ui-testing-scope-version': '1', 'x-ui-testing-session-id': 'pick-agent' };

let exec;
const pick = async (x, y, detail, options = {}) => {
  const { headers = scopedHeaders, body, rawBody } = options;
  const response = await state.harness.request({
    method: 'POST',
    path: '/plugins/ui-testing/element',
    headers,
    ...(rawBody !== undefined ? { rawBody } : { body: body !== undefined ? body : { x, y, ...(detail ? { detail: true } : {}) } }),
  });
  return { status: response.statusCode, json: response.json, body: response.body };
};

const pageEval = async (expression) => {
  const result = await state.harness.invoke('browser_eval', { expression }, exec);
  if (result.threw || result.value?.ok === false) {
    throw new Error(`browser_eval failed: ${result.error?.message || JSON.stringify(jsonSafe(result.value))}`);
  }
  return result.value?.value;
};

/** Real DOM truth: viewport rect, document rect (rect + scroll), page metadata. */
const pageTruth = () => pageEval(`(() => {
  const ids = ['pick-fixed-btn', 'pick-doc-target', 'pick-detail', 'pick-cased', 'pick-frame', 'pick-far'];
  const rects = {};
  for (const id of ids) {
    const el = document.getElementById(id);
    if (!el) continue;
    const r = el.getBoundingClientRect();
    rects[id] = {
      view: { x: r.x, y: r.y, width: r.width, height: r.height },
      doc: { x: r.x + window.scrollX, y: r.y + window.scrollY, width: r.width, height: r.height },
    };
  }
  return {
    scrollX: window.scrollX, scrollY: window.scrollY,
    innerWidth: window.innerWidth, innerHeight: window.innerHeight,
    dpr: window.devicePixelRatio, title: document.title, url: location.href,
    rects,
    detailHTML: document.getElementById('pick-detail').outerHTML,
    casedTagName: document.getElementById('pick-cased').tagName,
  };
})()`);

const rawSend = (method, params) => state.runtime.cdp.send(method, params, { timeoutMs: 4000 });

const rawHit = async (x, y) => {
  try {
    const hit = await rawSend('DOM.getNodeForLocation', {
      x: Math.floor(x), y: Math.floor(y),
      includeUserAgentShadowDOM: true, ignorePointerEventsNone: false,
    });
    const described = await rawSend('DOM.describeNode', { backendNodeId: hit.backendNodeId, depth: 0 });
    const attributes = described?.node?.attributes || [];
    const attrs = {};
    for (let index = 0; index + 1 < attributes.length; index += 2) attrs[attributes[index]] = attributes[index + 1];
    return { backendNodeId: hit.backendNodeId, frameId: hit.frameId, localName: described?.node?.localName, attrs };
  } catch (error) {
    return { error: String((error && error.message) || error), code: error?.code };
  }
};

const rawBox = async (backendNodeId) => {
  const model = await rawSend('DOM.getBoxModel', { backendNodeId });
  return model?.model?.border || null;
};

const readLayoutMetrics = () => rawSend('Page.getLayoutMetrics', {});

const registryEntries = () => [...(state.harness.ctx.__internal.plugin?.registry?.entries?.values() || [])];

/** Read-only facts that the pick route must never disturb. */
const readOnlySnapshot = () => {
  const runtime = state.runtime;
  const entries = registryEntries();
  return {
    lastError: runtime.lastError,
    lastErrorAt: runtime.lastErrorAt,
    lease: runtime.lease ? { sessionId: runtime.lease.sessionId, expiresAt: runtime.lease.expiresAt } : null,
    active: runtime.active,
    inflight: runtime.inflight,
    clientMetrics: runtime.clientMetrics ?? null,
    targetId: runtime.page?.targetId ?? null,
    pageCount: entries.filter((entry) => entry.runtime.page).length,
    entryCount: entries.length,
  };
};

async function cleanupResources(reason) {
  if (state.cleanupResult) return state.cleanupResult;
  const result = {
    reason, closedBrowser: false, disposed: false, fixtureClosed: false, captureRootRemoved: false,
    killedPids: [], removedProfileDirs: [], leftoverProfileDirs: [], leftoverChromePids: [], errors: [],
  };
  if (state.harness) {
    try {
      // Close the suite's SESSION scope first (the legacy scope has no page), then the legacy route.
      await state.harness.request({
        method: 'POST', path: '/plugins/ui-testing/close', headers: scopedHeaders, body: {},
      });
      result.closedBrowser = true;
    } catch (error) { result.errors.push(`close scoped: ${error && error.message ? error.message : String(error)}`); }
    try { await state.harness.closeBrowser(); }
    catch (error) { result.errors.push(`close: ${error && error.message ? error.message : String(error)}`); }
    await sleep(800);
    try { await state.harness.dispose(); result.disposed = true; }
    catch (error) { result.errors.push(`dispose: ${error && error.message ? error.message : String(error)}`); }
  }
  let harnessModule;
  try { harnessModule = await import(pathToFileURL(join(HERE, 'harness.mjs')).href); } catch { harnessModule = undefined; }
  if (harnessModule) {
    const stray = harnessModule.scanPluginChromeProcesses().filter((proc) => proc.parentPid === process.pid);
    for (const proc of stray) { try { process.kill(proc.pid, 'SIGTERM'); } catch { /* ignore */ } }
    if (stray.length) await sleep(800);
    for (const proc of stray) {
      if (harnessModule.isProcessAlive(proc.pid)) { try { process.kill(proc.pid, 'SIGKILL'); } catch { /* ignore */ } }
      if (!harnessModule.isProcessAlive(proc.pid)) result.killedPids.push(proc.pid);
    }
    const profilesAfter = await harnessModule.snapshotProfileDirs();
    for (const dir of profilesAfter.filter((item) => !state.profilesBefore.includes(item))) {
      if (!dir.startsWith(tmpdir())) continue;
      try { await rm(dir, { recursive: true, force: true }); result.removedProfileDirs.push(dir); }
      catch (error) { result.errors.push(`rm profile ${dir}: ${error && error.message ? error.message : String(error)}`); }
    }
    result.leftoverProfileDirs = (await harnessModule.snapshotProfileDirs()).filter((dir) => !state.profilesBefore.includes(dir));
    result.leftoverChromePids = stray.filter((proc) => harnessModule.isProcessAlive(proc.pid)).map((proc) => proc.pid);
  }
  if (state.fixture) {
    try { await state.fixture.close(); result.fixtureClosed = true; }
    catch (error) { result.errors.push(`fixture close: ${error && error.message ? error.message : String(error)}`); }
  }
  if (state.captureRoot) {
    try { await rm(state.captureRoot, { recursive: true, force: true }); result.captureRootRemoved = !existsSync(state.captureRoot); }
    catch (error) { result.errors.push(`rm capture root: ${error && error.message ? error.message : String(error)}`); }
  }
  log(`\n[cleanup] ${reason}: ${JSON.stringify(jsonSafe(result))}`);
  return result;
}

async function writeReport(overrideExitCode) {
  const probes = report.probes;
  const required = probes
    .filter((probe) => probe.status !== 'skip')
    .flatMap((probe) => probe.checks.filter((item) => !item.advisory));
  const failed = required.filter((item) => !item.pass);
  const failedProbes = probes.filter((probe) => probe.status === 'fail').length;
  const notRun = probes.filter((probe) => probe.status === 'skip');
  report.summary = {
    probes: probes.length,
    passed: probes.filter((probe) => probe.status === 'pass').length,
    failed: failedProbes,
    notRun: notRun.length,
    notRunIds: notRun.map((probe) => probe.id),
    requiredChecks: required.length,
    passedChecks: required.length - failed.length,
    failedChecks: failed.length,
    findings: report.findings.length,
    exitCode: overrideExitCode !== undefined
      ? overrideExitCode
      : (failed.length > 0 || failedProbes > 0 ? 1 : 0),
  };
  report.resources = state.cleanupResult || { reason: 'not-run' };
  await mkdir(EVIDENCE_DIR, { recursive: true });
  const body = JSON.stringify(report, null, 2);
  await writeFile(join(EVIDENCE_DIR, 'report.json'), body);
  await writeFile(join(EVIDENCE_DIR, 'run-report.json'), body);
  await writeFile(join(EVIDENCE_DIR, 'samples.json'), JSON.stringify(jsonSafe(report.observations), null, 2));
  await writeFile(join(EVIDENCE_DIR, 'run.log'), logLines.join('\n') + '\n');
  log(`\nprobes=${report.summary.probes} pass=${report.summary.passed} fail=${report.summary.failed} notRun=${report.summary.notRun}`
    + ` requiredChecks=${report.summary.requiredChecks} passedChecks=${report.summary.passedChecks}`
    + ` failedChecks=${report.summary.failedChecks} findings=${report.summary.findings}`);
  log(`PASS=${report.summary.passedChecks} FAIL=${report.summary.failedChecks} NOT_RUN=${report.summary.notRun}`);
  log(`evidence: ${EVIDENCE_DIR}`);
  log(`EXIT ${report.summary.exitCode}`);
}

/* ------------------------------------------------------------------------------------------------
 * Main
 * ---------------------------------------------------------------------------------------------- */

async function main() {
  await mkdir(EVIDENCE_DIR, { recursive: true });

  const chromeBin = process.env.DSH_UI_TESTING_CHROME || DEFAULT_CHROME;
  if (!existsSync(chromeBin)) {
    log(`[env] FATAL: Chromium 不存在：${chromeBin}（可用 DSH_UI_TESTING_CHROME 覆盖）`);
    report.environment.error = 'chromium-unavailable';
    await writeReport(2);
    return 2;
  }

  // The run owns its capture root: set it BEFORE importing harness.mjs so the harness keeps it.
  state.captureRoot = await mkdtemp(join(tmpdir(), 'dsh-ui-testing-pick-'));
  process.env.DSH_UI_TESTING_CAPTURE_DIR = state.captureRoot;

  const harnessModule = await import(pathToFileURL(join(HERE, 'harness.mjs')).href);
  const {
    createHarness, createFakeConnectionService, scanPluginChromeProcesses, snapshotProfileDirs,
  } = harnessModule;
  const { startFixtureServer } = await import(pathToFileURL(join(REPO_ROOT, 'tests/ui_test_fixture/server.mjs')).href);

  state.profilesBefore = await snapshotProfileDirs();
  state.fixture = await startFixtureServer();
  const pageUrl = new URL(FIXTURE_PAGE, state.fixture.url).href;

  const harness = await createHarness({ name: 'pick-element-host' });
  state.harness = harness;
  const ownerConnection = () => createFakeConnectionService({
    rejection: undefined,
    admit: () => ({ peer: { id: 'peer-owner' } }),
    browserPeer: { id: 'peer-owner' },
  });
  // Scoped requests need the strict owner-only gate; legacy probes override this explicitly.
  harness.setConnection(ownerConnection());
  exec = { agent: { id: 'pick-agent', session: { header: { cwd: harness.workspaceDir } } } };

  report.environment = {
    suite: 'pick-element-host',
    node: process.version,
    platform: `${process.platform}/${process.arch}`,
    chromeBin,
    fixtureUrl: state.fixture.url,
    pageUrl,
    captureRoot: state.captureRoot,
    evidenceDir: EVIDENCE_DIR,
    timeoutMs: TOTAL_TIMEOUT_MS,
    scopedHeaders,
  };
  log(`[env] chrome=${chromeBin}`);
  log(`[env] fixture=${state.fixture.url}`);
  log(`[env] page=${pageUrl}`);

  const chromeProcesses = () => scanPluginChromeProcesses().filter((proc) => proc.parentPid === process.pid);

  /* --- H1: route registration + cold page (no Chromium may start) ----------------------------- */

  await runProbe('H1', '路由注册与冷态：未运行 POST 返回 element:null 且不启动 Chromium', '200 no-page; zero Chromium', async () => {
    const routes = harness.httpRoutes();
    const prefix = routes.find((entry) => entry.kind === 'prefix' && entry.path === '/plugins/ui-testing');
    check('prefix 路由已注册', Boolean(prefix) && typeof prefix.handler === 'function', {
      routes: routes.map((entry) => ({ kind: entry.kind, path: entry.path })),
    }, 'kind=prefix path=/plugins/ui-testing');

    // Cold reads before/after the pick: the route must not move the runtime projection or the
    // frame/metric counters (metrics has a wall-clock `now`, so compare everything else).
    const stateBefore = (await harness.request({ method: 'GET', path: '/plugins/ui-testing/state', headers: scopedHeaders })).json;
    const metricsBefore = (await harness.request({ method: 'GET', path: '/plugins/ui-testing/metrics', headers: scopedHeaders })).json;
    const stateKey = (value) => value && {
      running: value.running, mode: value.mode, activity: value.activity, error: value.error,
      errorAt: value.errorAt, scope: value.scope, viewport: value.viewport, seq: value.seq,
    };
    const metricsKey = (value) => {
      if (!value || typeof value !== 'object') return value;
      const copy = JSON.parse(JSON.stringify(value));
      delete copy.now;
      return copy;
    };

    const cold = await pick(100, 100);
    report.observations.h1Cold = cold;
    const stateAfter = (await harness.request({ method: 'GET', path: '/plugins/ui-testing/state', headers: scopedHeaders })).json;
    const metricsAfter = (await harness.request({ method: 'GET', path: '/plugins/ui-testing/metrics', headers: scopedHeaders })).json;
    report.observations.h1State = { before: stateKey(stateBefore), after: stateKey(stateAfter) };
    report.observations.h1Metrics = { before: metricsKey(metricsBefore), after: metricsKey(metricsAfter) };
    check('冷态调用前后 /state 稳定投影不变',
      JSON.stringify(stateKey(stateBefore)) === JSON.stringify(stateKey(stateAfter)),
      { before: stateKey(stateBefore), after: stateKey(stateAfter) }, 'identical');
    check('冷态调用前后 /metrics 计数不变（now 除外）',
      JSON.stringify(metricsKey(metricsBefore)) === JSON.stringify(metricsKey(metricsAfter)),
      { before: metricsKey(metricsBefore), after: metricsKey(metricsAfter) }, 'identical');
    check('冷态 POST 返回 200', cold.status === 200, cold.status, 200);
    check('冷态 element 为 null', cold.json?.element === null, cold.json?.element, null);
    check('冷态 reason=no-page', cold.json?.reason === 'no-page', cold.json?.reason, 'no-page');
    check('冷态 ok=true', cold.json?.ok === true, cold.json?.ok, true);

    const processes = chromeProcesses();
    check('冷态没有启动 Chromium 进程', processes.length === 0,
      processes.map((proc) => ({ pid: proc.pid, profileDir: proc.profileDir })), '[]');
    const pageCount = registryEntries().filter((entry) => entry.runtime.page).length;
    check('冷态没有 page target', pageCount === 0, pageCount, 0);

    const viaGet = await harness.request({ method: 'GET', path: '/plugins/ui-testing/element', headers: scopedHeaders });
    check('GET /element 只支持 POST（405）', viaGet.statusCode === 405, viaGet.statusCode, 405);

    // Legacy callers keep the historical requestRejection gate: unauthenticated -> 401, no body
    // read, no scope creation; an authenticated old client still resolves to the legacy scope.
    harness.setConnection(createFakeConnectionService({ rejection: 401 }));
    const legacyDenied = await harness.request({
      method: 'POST', path: '/plugins/ui-testing/element', headers: {}, body: { x: 10, y: 10 },
    });
    check('未认证的 legacy 请求被拒（401，安全面未放宽）', legacyDenied.statusCode === 401, legacyDenied.statusCode, 401);
    // A scoped request whose admitted peer is not the browser's own peer is 403 (cross-browser).
    harness.setConnection(createFakeConnectionService({
      rejection: undefined,
      admit: () => ({ peer: { id: 'peer-owner' } }),
      browserPeer: { id: 'peer-other' },
    }));
    const crossPeer = await harness.request({
      method: 'POST', path: '/plugins/ui-testing/element', headers: scopedHeaders, body: { x: 10, y: 10 },
    });
    check('跨浏览器 peer 的 scoped 请求 → 403 SCOPE_FORBIDDEN',
      crossPeer.statusCode === 403 && crossPeer.json?.code === 'SCOPE_FORBIDDEN',
      { status: crossPeer.statusCode, code: crossPeer.json?.code }, { status: 403, code: 'SCOPE_FORBIDDEN' });
    harness.setConnection(ownerConnection());
    const legacyOk = await harness.request({
      method: 'POST', path: '/plugins/ui-testing/element', headers: {}, body: { x: 10, y: 10 },
    });
    check('已认证 legacy 请求映射到 legacy 冷态（200 no-page）',
      legacyOk.statusCode === 200 && legacyOk.json?.element === null && legacyOk.json?.reason === 'no-page',
      { status: legacyOk.statusCode, json: legacyOk.json }, '200 {element:null,reason:"no-page"}');
  });

  /* --- H0: coordinate space, measured with raw CDP on the real page -------------------------- */

  let truth = null;
  await runProbe('H0', '坐标空间实证：getNodeForLocation=文档坐标（仅可见区）、getBoxModel=根帧视口坐标',
    'document hit test + viewport quad + scroll correction + visible-area boundary', async () => {
      const nav = await harness.invoke('browser_navigate', { url: pageUrl }, exec);
      if (nav.threw) throw new Error(`browser_navigate failed: ${nav.error?.message}`);
      await waitFor(() => {
        const entries = registryEntries();
        return entries.length > 0 && entries[0].runtime.running && entries[0].runtime.title;
      }, { timeoutMs: 15000, intervalMs: 100, label: 'page runtime ready' });
      state.runtime = registryEntries()[0].runtime;
      const runtime = state.runtime;
      await waitFor(async () => (await pageTruth()).title === 'Pick Element Fixture', {
        timeoutMs: 8000, label: 'fixture title',
      });

      truth = await pageTruth();
      report.observations.h0TruthScroll0 = truth;
      const metrics0 = await readLayoutMetrics();
      const css0 = metrics0.cssLayoutViewport || {};
      check('页面已导航到 fixture', truth.url === pageUrl && truth.title === 'Pick Element Fixture',
        { url: truth.url, title: truth.title }, { url: pageUrl, title: 'Pick Element Fixture' });
      check('scrollY=0', truth.scrollY === 0, truth.scrollY, 0);

      // (1) raw hit at the fixed button's DOCUMENT point == its viewport point at scroll 0.
      const fixedHit = await rawHit(260, 340);
      check('原始 CDP 命中固定按钮（scroll 0，文档点 (260,340)）',
        fixedHit.localName === 'button' && fixedHit.attrs?.id === 'pick-fixed-btn',
        fixedHit, { localName: 'button', id: 'pick-fixed-btn' });
      check('命中 frameId == 主帧', fixedHit.frameId === runtime.mainFrameId,
        { frameId: fixedHit.frameId, mainFrameId: runtime.mainFrameId }, 'equal');
      const fixedQuad = await rawBox(fixedHit.backendNodeId);
      const fixedQuadRect = fixedQuad ? {
        x: fixedQuad[0], y: fixedQuad[1], width: fixedQuad[2] - fixedQuad[0], height: fixedQuad[5] - fixedQuad[1],
      } : null;
      check('getBoxModel quad 与 getBoundingClientRect（scroll 0）一致',
        rectClose(fixedQuadRect, truth.rects['pick-fixed-btn'].view, 0.01), fixedQuadRect, truth.rects['pick-fixed-btn'].view);
      check('Page.getLayoutMetrics.cssLayoutViewport.pageY == scrollY(0)',
        css0.pageY === truth.scrollY && css0.pageX === truth.scrollX,
        { pageX: css0.pageX, pageY: css0.pageY }, { pageX: 0, pageY: 0 });
      check('cssLayoutViewport.clientHeight == window.innerHeight',
        css0.clientHeight === truth.innerHeight && css0.clientWidth === truth.innerWidth,
        { clientWidth: css0.clientWidth, clientHeight: css0.clientHeight },
        { innerWidth: truth.innerWidth, innerHeight: truth.innerHeight });

      // (2) scroll to 200: the same DOCUMENT point must still hit the target, while the target's
      // VIEWPORT point must miss -> getNodeForLocation speaks document coordinates.
      await pageEval('window.scrollTo(0, 200)');
      await waitFor(async () => (await pageTruth()).scrollY === 200, { timeoutMs: 8000, label: 'scrollY=200' });
      const truth200 = await pageTruth();
      report.observations.h0TruthScroll200 = truth200;
      const metrics200 = await readLayoutMetrics();
      const css200 = metrics200.cssLayoutViewport || {};
      const viewportHeight = css200.clientHeight;
      check('滚动后 scrollY=200（真实页面读数）', truth200.scrollY === 200, truth200.scrollY, 200);
      check('scroll 200 后 pageY=200（getLayoutMetrics）', css200.pageY === 200, css200.pageY, 200);

      const docHit = await rawHit(100, 320);
      check('文档点 (100,320) 在 scroll 200 命中 #pick-doc-target（文档坐标）',
        docHit.localName === 'div' && docHit.attrs?.id === 'pick-doc-target', docHit,
        { localName: 'div', id: 'pick-doc-target' });
      const viewPoint = await rawHit(100, 100);
      check('该元素视口坐标 (100,100) 不命中（证明不是视口坐标语义）',
        typeof viewPoint.error === 'string' && /no node found/i.test(viewPoint.error), viewPoint, 'No node found');
      const docQuad = await rawBox(docHit.backendNodeId);
      const docQuadRect = {
        x: docQuad[0], y: docQuad[1], width: docQuad[2] - docQuad[0], height: docQuad[5] - docQuad[1],
      };
      check('scroll 200 时 getBoxModel quad == 该元素的视口 rect（quad 是根帧视口坐标）',
        rectClose(docQuadRect, truth200.rects['pick-doc-target'].view, 0.01), docQuadRect,
        truth200.rects['pick-doc-target'].view);
      check('quad + scroll(pageY) == 文档 rect（+scroll 修正方向正确）',
        rectClose({ ...docQuadRect, y: docQuadRect.y + css200.pageY, x: docQuadRect.x + css200.pageX },
          truth200.rects['pick-doc-target'].doc, 0.01),
        { ...docQuadRect, y: docQuadRect.y + css200.pageY }, truth200.rects['pick-doc-target'].doc);

      // (3) visible-area boundary: only the current visible region can be hit.
      const boundary = {
        firstVisible: await rawHit(100, 200),
        aboveFirst: await rawHit(100, 199),
        lastVisible: await rawHit(100, 200 + viewportHeight - 1),
        belowLast: await rawHit(100, 200 + viewportHeight),
      };
      report.observations.h0Boundary = {
        viewportHeight,
        firstVisible: boundary.firstVisible.localName ?? boundary.firstVisible.error,
        aboveFirst: boundary.aboveFirst.localName ?? boundary.aboveFirst.error,
        lastVisible: boundary.lastVisible.localName ?? boundary.lastVisible.error,
        belowLast: boundary.belowLast.localName ?? boundary.belowLast.error,
      };
      check('y=scrollY 命中（可见区首行）', typeof boundary.firstVisible.localName === 'string',
        boundary.firstVisible, 'a node');
      check('y=scrollY-1 不命中（可见区上方）',
        typeof boundary.aboveFirst.error === 'string' && /no node found/i.test(boundary.aboveFirst.error),
        boundary.aboveFirst, 'No node found');
      check(`y=scrollY+clientHeight-1(${200 + viewportHeight - 1}) 命中（可见区末行）`,
        typeof boundary.lastVisible.localName === 'string', boundary.lastVisible, 'a node');
      check(`y=scrollY+clientHeight(${200 + viewportHeight}) 不命中（可见区下方）`,
        typeof boundary.belowLast.error === 'string' && /no node found/i.test(boundary.belowLast.error),
        boundary.belowLast, 'No node found');
    });

  /* --- H2: fixed-position button hit at scroll 0 -------------------------------------------- */

  await runProbe('H2', 'hover 命中固定定位按钮：tag/id/classes/rect 与真实 DOM 误差 ≤1px',
    'button#pick-fixed-btn, document rect', async () => {
      await pageEval('window.scrollTo(0, 0)');
      await waitFor(async () => (await pageTruth()).scrollY === 0, { timeoutMs: 8000, label: 'scrollY=0' });
      truth = await pageTruth();
      report.observations.h2Truth = truth;
      const expected = truth.rects['pick-fixed-btn'].doc;
      const response = await pick(260, 340);
      report.observations.h2Response = response;
      check('HTTP 200 + ok', response.status === 200 && response.json?.ok === true,
        { status: response.status, ok: response.json?.ok }, { status: 200, ok: true });
      const element = response.json?.element || {};
      check('tag=button', element.tag === 'button', element.tag, 'button');
      check('id=pick-fixed-btn', element.id === 'pick-fixed-btn', element.id, 'pick-fixed-btn');
      check('classes=[]', Array.isArray(element.classes) && element.classes.length === 0, element.classes, []);
      check('rect 与 getBoundingClientRect+scroll 误差 ≤1px', rectClose(element.rect, expected, 1),
        element.rect, expected);
      check('frameId 与主帧一致', element.frameId === state.runtime.mainFrameId,
        { frameId: element.frameId, mainFrameId: state.runtime.mainFrameId }, 'equal');
      check('page.url 是 fixture 地址', element.page?.url === pageUrl, element.page?.url, pageUrl);
      check('page.title 是 fixture 标题', element.page?.title === 'Pick Element Fixture',
        element.page?.title, 'Pick Element Fixture');
      check('未请求 detail 时不返回 selector/outerHTML/text', !('selector' in element) && !('outerHTML' in element) && !('text' in element),
        Object.keys(element), 'base fields only');
      const onElement = truth.rects['pick-fixed-btn'].view;
      check('坐标确实落在按钮内部（真实 rect 读回）',
        onElement.x <= 260 && 260 < onElement.x + onElement.width
          && onElement.y <= 340 && 340 < onElement.y + onElement.height,
        onElement, 'contains (260,340)');

      const fractional = await pick(260.9, 340.9);
      report.observations.h2Fractional = fractional;
      check('小数输入被 floor：x=260.9/y=340.9 与 260/340 命中同一元素且 rect 相同',
        fractional.status === 200
          && fractional.json?.element?.id === element.id
          && JSON.stringify(fractional.json?.element?.rect) === JSON.stringify(element.rect),
        { id: fractional.json?.element?.id, rect: fractional.json?.element?.rect },
        { id: element.id, rect: element.rect });

      // The same fixture is reused by the GUI acceptance (task-4): keep its target + click counter
      // verified from here so a fixture regression cannot silently break the GUI suite.
      const guiFixture = await pageEval(`(() => {
        const target = document.getElementById('pick-target');
        const rect = target.getBoundingClientRect();
        return {
          tag: target.tagName,
          rect: { x: rect.x + window.scrollX, y: rect.y + window.scrollY, width: rect.width, height: rect.height },
          clicks: JSON.parse(JSON.stringify(window.__pickClicks)),
          dataDocument: document.getElementById('pick-count').getAttribute('data-document'),
        };
      })()`);
      report.observations.h2GuiFixture = guiFixture;
      check('task-4 GUI 目标 #pick-target 在文档 (300,300) 160x44 且点击计数初始为 0',
        guiFixture?.tag === 'BUTTON'
          && rectClose(guiFixture?.rect, { x: 300, y: 300, width: 160, height: 44 }, 0.01)
          && guiFixture?.clicks?.document === 0 && guiFixture?.clicks?.target === 0
          && guiFixture?.dataDocument === '0',
        guiFixture, { tag: 'BUTTON', rect: { x: 300, y: 300, width: 160, height: 44 }, clicks: { document: 0, target: 0 } });
    });

  /* --- H3: the same document point still hits the same element after scroll 200 ---------------- */

  await runProbe('H3', '滚动 200 后同文档点仍命中同一元素，rect 为文档坐标',
    'same id + unchanged document rect', async () => {
      const before = await pick(100, 320);
      const beforeElement = before.json?.element || {};
      report.observations.h3BeforeScroll = before;
      check('scroll 0：文档点 (100,320) 命中 #pick-doc-target',
        beforeElement.id === 'pick-doc-target', { id: beforeElement.id }, 'pick-doc-target');

      const truth0 = await pageTruth();
      check('scroll 0：目标 view rect 与 doc rect 相同',
        rectClose(truth0.rects['pick-doc-target'].view, truth0.rects['pick-doc-target'].doc, 0.01),
        { view: truth0.rects['pick-doc-target'].view, doc: truth0.rects['pick-doc-target'].doc }, 'equal');

      await pageEval('window.scrollTo(0, 200)');
      await waitFor(async () => (await pageTruth()).scrollY === 200, { timeoutMs: 8000, label: 'scrollY=200' });
      const truth200 = await pageTruth();
      const after = await pick(100, 320);
      const afterElement = after.json?.element || {};
      report.observations.h3AfterScroll = after;
      check('滚动 200 后同文档点命中同一元素', afterElement.id === beforeElement.id && afterElement.id === 'pick-doc-target',
        { before: beforeElement.id, after: afterElement.id }, 'same id');
      check('滚动后元素 view rect 恰好上移 200（页面真的滚了）',
        near(truth200.rects['pick-doc-target'].view.y + 200, truth0.rects['pick-doc-target'].view.y, 0.01),
        { scroll0ViewY: truth0.rects['pick-doc-target'].view.y, scroll200ViewY: truth200.rects['pick-doc-target'].view.y }, 'difference 200');
      check('滚动后 doc rect 不变（误差 ≤1px）',
        rectClose(truth200.rects['pick-doc-target'].doc, truth0.rects['pick-doc-target'].doc, 1),
        truth200.rects['pick-doc-target'].doc, truth0.rects['pick-doc-target'].doc);
      check('滚动前后 route rect 一致且为文档坐标（误差 ≤1px）',
        rectClose(afterElement.rect, beforeElement.rect, 1) && rectClose(afterElement.rect, truth200.rects['pick-doc-target'].doc, 1),
        { before: beforeElement.rect, after: afterElement.rect }, truth200.rects['pick-doc-target'].doc);

      // Fixed element follows the viewport: its DOCUMENT point moved by exactly the scroll delta.
      const fixed = await pick(260, 520);
      report.observations.h3FixedAfterScroll = fixed;
      check('scroll 200 时固定按钮的文档 rect 为 view+scroll',
        fixed.json?.element?.id === 'pick-fixed-btn'
          && rectClose(fixed.json?.element?.rect, truth200.rects['pick-fixed-btn'].doc, 1),
        fixed.json?.element, truth200.rects['pick-fixed-btn'].doc);

      // The route reports the visible-area boundary instead of pretending a hit.
      const metrics = await readLayoutMetrics();
      const css = metrics.cssLayoutViewport || {};
      const above = await pick(100, css.pageY - 1);
      report.observations.h3AboveViewport = above;
      check('视口上方文档点返回 element:null + reason=out-of-viewport',
        above.status === 200 && above.json?.element === null && above.json?.reason === 'out-of-viewport',
        { status: above.status, json: above.json }, '200 {element:null,reason:"out-of-viewport"}');
      const below = await pick(100, css.pageY + css.clientHeight);
      report.observations.h3BelowViewport = below;
      check('视口下方文档点返回 element:null + reason=out-of-viewport',
        below.status === 200 && below.json?.element === null && below.json?.reason === 'out-of-viewport',
        { status: below.status, json: below.json }, '200 {element:null,reason:"out-of-viewport"}');
    });

  /* --- H4: detail=true ---------------------------------------------------------------------- */

  await runProbe('H4', 'detail=true：selector 唯一命中、outerHTML/text/role/name 正确',
    'unique selector + collapsed outerHTML/text + AX role/name', async () => {
      const truthNow = await pageTruth();
      report.observations.h4Truth = truthNow;
      const response = await pick(150, 440, true);
      report.observations.h4Response = response;
      const element = response.json?.element || {};
      check('HTTP 200 + element 命中 #pick-detail', response.status === 200 && element.id === 'pick-detail',
        { status: response.status, id: element.id }, { status: 200, id: 'pick-detail' });
      check('基础字段与真实 DOM 一致（tag/classes/rect）',
        element.tag === 'button'
          && JSON.stringify(element.classes) === JSON.stringify(['card', 'primary'])
          && rectClose(element.rect, truthNow.rects['pick-detail'].doc, 1),
        { tag: element.tag, classes: element.classes, rect: element.rect },
        { tag: 'button', classes: ['card', 'primary'], rect: truthNow.rects['pick-detail'].doc });

      check('selector 是唯一 id（#pick-detail）', element.selector === '#pick-detail',
        element.selector, '#pick-detail');
      const selectorTruth = await pageEval(`(() => {
        const selector = ${JSON.stringify(element.selector)};
        const matches = document.querySelectorAll(selector);
        return { count: matches.length, isTarget: matches.length === 1 && matches[0] === document.getElementById('pick-detail') };
      })()`);
      check('browser_eval querySelector 唯一命中同一元素',
        selectorTruth?.count === 1 && selectorTruth?.isTarget === true, selectorTruth, { count: 1, isTarget: true });
      check('outerHTML 与真实 outerHTML（空白折叠、≤240 字符）一致',
        element.outerHTML === collapse(truthNow.detailHTML, 240),
        element.outerHTML, collapse(truthNow.detailHTML, 240));
      check('未截断时 outerHTMLTruncated=false 且 outerHTMLLength=真实码点长度',
        element.outerHTMLTruncated === false
          && element.outerHTMLLength === Array.from(collapse(truthNow.detailHTML, 1e9)).length,
        { truncated: element.outerHTMLTruncated, length: element.outerHTMLLength },
        { truncated: false, length: Array.from(collapse(truthNow.detailHTML, 1e9)).length });
      check('text 与真实 textContent（空白折叠、≤160 字符）一致',
        element.text === collapse(await pageEval('document.getElementById("pick-detail").textContent'), 160),
        element.text, 'Detail Target');
      check('selectorQuality=unique（selector 在本 root 内唯一命中该元素）',
        element.selectorQuality === 'unique', element.selectorQuality, 'unique');
      check('role=button（Accessibility.getPartialAXTree）', element.role === 'button', element.role, 'button');
      check('name=Detail Target（可访问名称）', element.name === 'Detail Target', element.name, 'Detail Target');
      check('detail 响应同样带 scroll，且与真实页面一致',
        element.scroll?.x === truthNow.scrollX && element.scroll?.y === truthNow.scrollY,
        element.scroll, { x: truthNow.scrollX, y: truthNow.scrollY });

      // H4b: no id on the hit element -> an anchored nth-of-type path that still matches exactly one.
      const listTruth = await pageEval(`(() => {
        const items = document.querySelectorAll('#pick-list > li');
        const second = items[1];
        const r = second.getBoundingClientRect();
        return {
          count: items.length, tag: second.tagName, classes: Array.from(second.classList),
          doc: { x: r.x + window.scrollX, y: r.y + window.scrollY, width: r.width, height: r.height },
        };
      })()`);
      const noId = await pick(100, 660, true);
      report.observations.h4NoId = noId;
      const noIdElement = noId.json?.element || {};
      check('无 id 元素命中第二个 li（tag/classes/rect 与真实 DOM 一致）',
        noIdElement.tag === 'li'
          && JSON.stringify(noIdElement.classes) === JSON.stringify(['pick-item'])
          && rectClose(noIdElement.rect, listTruth?.doc, 1),
        { tag: noIdElement.tag, classes: noIdElement.classes, rect: noIdElement.rect }, listTruth?.doc);
      check('selector 使用 nth-of-type 且带祖先锚点（不是偶然唯一的裸选择器）',
        typeof noIdElement.selector === 'string' && noIdElement.selector.includes('nth-of-type(')
          && noIdElement.selector.includes(' > '),
        noIdElement.selector, 'contains nth-of-type + " > "');
      const noIdSelectorTruth = await pageEval(`(() => {
        const selector = ${JSON.stringify(noIdElement.selector)};
        const matches = document.querySelectorAll(selector);
        const second = document.querySelectorAll('#pick-list > li')[1];
        return { count: matches.length, isSecond: matches.length === 1 && matches[0] === second };
      })()`);
      check('nth-of-type selector 唯一命中第二个 li',
        noIdSelectorTruth?.count === 1 && noIdSelectorTruth?.isSecond === true, noIdSelectorTruth,
        { count: 1, isSecond: true });
      check('无 id 元素的 text=Second Item', noIdElement.text === 'Second Item', noIdElement.text, 'Second Item');

      // H4c: the contract cuts — outerHTML ≤240 code points, text ≤160 code points.
      const longTruth = await pageEval(`(() => {
        const el = document.getElementById('pick-long');
        return { outerHTML: el.outerHTML, text: el.textContent };
      })()`);
      const long = await pick(350, 640, true);
      report.observations.h4Long = long;
      const longElement = long.json?.element || {};
      const fullOuter = collapse(longTruth?.outerHTML, 1e9);
      const fullText = collapse(longTruth?.text, 1e9);
      const expectOuter = collapse(fullOuter, 240) + '…';
      const expectText = collapse(fullText, 160) + '…';
      check('outerHTML 截断到 240 码点并显式加省略号（241 chars），truncated/length 如实',
        longElement.outerHTML === expectOuter
          && Array.from(String(longElement.outerHTML || '')).length === 241
          && longElement.outerHTMLTruncated === true
          && longElement.outerHTMLLength === Array.from(fullOuter).length,
        {
          length: Array.from(String(longElement.outerHTML || '')).length,
          truncated: longElement.outerHTMLTruncated,
          reported: longElement.outerHTMLLength,
        },
        { length: 241, truncated: true, reported: Array.from(fullOuter).length, value: expectOuter.slice(0, 60) + '…' });
      check('text 截断到 160 码点并显式加省略号（161 chars），truncated/length 如实',
        longElement.text === expectText
          && Array.from(String(longElement.text || '')).length === 161
          && longElement.textTruncated === true
          && longElement.textLength === Array.from(fullText).length,
        {
          length: Array.from(String(longElement.text || '')).length,
          truncated: longElement.textTruncated,
          reported: longElement.textLength,
        },
        { length: 161, truncated: true, reported: Array.from(fullText).length });
      check('selector 仍唯一时 selectorQuality=unique（截断字段不影响定位质量）',
        longElement.selectorQuality === 'unique', longElement.selectorQuality, 'unique');
    });

  /* --- H5: blank / off-screen points --------------------------------------------------------- */

  await runProbe('H5', '空白与页外坐标：element:null（no-hit / out-of-viewport）',
    '200 {element:null}', async () => {
      const metrics = await readLayoutMetrics();
      const css = metrics.cssLayoutViewport || {};
      const blankPoint = { x: 900, y: css.pageY + 300 };
      const blank = await pick(blankPoint.x, blankPoint.y);
      report.observations.h5Blank = blank;
      const blankTruth = await pageEval(`(() => {
        const el = document.elementFromPoint(900, 300);
        return el ? { tagName: el.tagName, id: el.id || null } : null;
      })()`);
      report.observations.h5BlankTruth = blankTruth;
      check('探针点确实是空白页面背景（elementFromPoint 为 body）',
        blankTruth?.tagName === 'BODY', blankTruth, { tagName: 'BODY', id: null });
      check('空白点返回 200 element:null reason=no-hit',
        blank.status === 200 && blank.json?.element === null && blank.json?.reason === 'no-hit',
        { status: blank.status, json: blank.json }, '200 {element:null,reason:"no-hit"}');

      // `ignorePointerEventsNone:false`: an element with pointer-events:none is skipped, so the
      // page body underneath is hit and the pick answers no-hit.
      const noPointer = await pick(950, 640);
      report.observations.h5NoPointer = noPointer;
      const noPointerTruth = await pageEval(`(() => {
        const el = document.elementFromPoint(950, 440);
        return el ? { tagName: el.tagName, id: el.id || null } : null;
      })()`);
      check('pointer-events:none 元素被跳过（elementFromPoint 同点也返回 body）',
        noPointerTruth?.tagName === 'BODY', noPointerTruth, { tagName: 'BODY' });
      check('pointer-events:none 元素上方 → 200 element:null reason=no-hit',
        noPointer.status === 200 && noPointer.json?.element === null && noPointer.json?.reason === 'no-hit',
        { status: noPointer.status, json: noPointer.json }, '200 {element:null,reason:"no-hit"}');

      const cases = [
        { label: '视口左侧之外 (x<scrollX)', point: { x: -10, y: css.pageY + 100 } },
        { label: '视口右侧之外 (x>scrollX+clientWidth)', point: { x: 5000, y: css.pageY + 100 } },
        { label: '视口下方之外 (y>scrollY+clientHeight)', point: { x: 100, y: css.pageY + css.clientHeight + 200 } },
        { label: '文档顶部之上 (y<scrollY)', point: { x: 100, y: css.pageY - 10 } },
      ];
      report.observations.h5Cases = [];
      for (const item of cases) {
        const response = await pick(item.point.x, item.point.y);
        report.observations.h5Cases.push({ ...item, response });
        check(`${item.label} → 200 element:null reason=out-of-viewport`,
          response.status === 200 && response.json?.element === null && response.json?.reason === 'out-of-viewport',
          { status: response.status, json: response.json }, '200 {element:null,reason:"out-of-viewport"}');
      }
    });

  /* --- H6: read-only semantics -------------------------------------------------------------- */

  await runProbe('H6', '只读性：不 ensure/不进 run 队列/不占 lease/不写 lastError/不加页/无 metrics',
    'zero run/ensure calls, unchanged runtime facts, still answers during an Agent hold', async () => {
      const runtime = state.runtime;
      const before = readOnlySnapshot();
      report.observations.h6Before = before;

      // (a) no serialization: a pick must not enter runtime.run nor ensure().
      const savedRun = runtime.run;
      const savedEnsure = runtime.ensure;
      let runCalls = 0;
      let ensureCalls = 0;
      runtime.run = function patchedRun(...args) { runCalls += 1; return savedRun.apply(this, args); };
      runtime.ensure = function patchedEnsure(...args) { ensureCalls += 1; return savedEnsure.apply(this, args); };
      let observed;
      let idlePickSnapshot;
      let injectedResult;
      const savedCdpSend = state.runtime.cdp.send;
      try {
        observed = await pick(260, 520);
        idlePickSnapshot = readOnlySnapshot();
        check('一次 /element 调用不进入 runtime.run（串行队列/租约）', runCalls === 0, { runCalls }, 0);
        check('一次 /element 调用不调用 runtime.ensure（绝不启动 Chromium）', ensureCalls === 0, { ensureCalls }, 0);
        check('spy 期间点击仍然成功返回元素', observed.status === 200 && observed.json?.element?.id === 'pick-fixed-btn',
          { status: observed.status, id: observed.json?.element?.id }, { status: 200, id: 'pick-fixed-btn' });

        // (b) injected CDP timeout -> 200 {element:null, reason:'stale'}, never 5xx, no lastError.
        state.runtime.cdp.send = (method, params, options) => {
          if (method === 'DOM.getNodeForLocation') {
            return Promise.reject(Object.assign(new Error('CDP 超时: DOM.getNodeForLocation'), { code: 'CDP_TIMEOUT' }));
          }
          return savedCdpSend.call(state.runtime.cdp, method, params, options);
        };
        injectedResult = await pick(260, 520);
      } finally {
        delete runtime.run;
        delete runtime.ensure;
        delete state.runtime.cdp.send;
      }
      report.observations.h6Injected = injectedResult;
      check('空闲态调用不改变 lease/active/inflight/clientMetrics',
        JSON.stringify({
          lease: idlePickSnapshot.lease, active: idlePickSnapshot.active,
          inflight: idlePickSnapshot.inflight, clientMetrics: idlePickSnapshot.clientMetrics,
        }) === JSON.stringify({
          lease: before.lease, active: before.active,
          inflight: before.inflight, clientMetrics: before.clientMetrics,
        }),
        {
          lease: idlePickSnapshot.lease, active: idlePickSnapshot.active,
          inflight: idlePickSnapshot.inflight, clientMetrics: idlePickSnapshot.clientMetrics,
        }, 'identical to the pre-pick snapshot');
      check('spy 恢复后 run/ensure 回到原型方法',
        runtime.run === savedRun && runtime.ensure === savedEnsure,
        { runSame: runtime.run === savedRun, ensureSame: runtime.ensure === savedEnsure }, true);
      check('CDP 失败返回 200 element:null reason=stale（不是 5xx）',
        injectedResult.status === 200 && injectedResult.json?.element === null && injectedResult.json?.reason === 'stale',
        { status: injectedResult.status, json: injectedResult.json }, '200 {element:null,reason:"stale"}');
      check('注入失败未关闭页面（CDP 仍可用）', runtime.running === true, runtime.running, true);
      const recovered = await pick(260, 520);
      report.observations.h6Recovered = recovered;
      check('注入失败后普通点击恢复命中', recovered.json?.element?.id === 'pick-fixed-btn',
        recovered.json?.element?.id, 'pick-fixed-btn');

      // (c) an Agent run holds the lease: the pick still answers (no BUSY, no wait for the queue).
      const evalPromise = harness.invoke('browser_eval', {
        expression: 'new Promise(function (resolve) { setTimeout(function () { resolve(42); }, 900); })',
      }, exec);
      await waitFor(() => runtime.active >= 1 && runtime.inflight >= 1, { timeoutMs: 5000, intervalMs: 30, label: 'Agent run holds the lease' });
      const holdSnapshot = {
        active: runtime.active, inflight: runtime.inflight,
        lease: runtime.lease ? { sessionId: runtime.lease.sessionId, expiresAt: runtime.lease.expiresAt } : null,
      };
      const duringHold = await pick(260, 520);
      const holdAfter = {
        active: runtime.active, inflight: runtime.inflight,
        lease: runtime.lease ? { sessionId: runtime.lease.sessionId, expiresAt: runtime.lease.expiresAt } : null,
      };
      report.observations.h6Hold = { holdSnapshot, duringHold, holdAfter };
      check('Agent run 持租约期间 /element 仍返回 200（无 BUSY）',
        duringHold.status === 200 && duringHold.json?.element?.id === 'pick-fixed-btn',
        { status: duringHold.status, id: duringHold.json?.element?.id }, { status: 200, id: 'pick-fixed-btn' });
      check('调用未改变 Agent 的 lease/active/inflight',
        JSON.stringify(holdAfter) === JSON.stringify(holdSnapshot), { holdSnapshot, holdAfter }, 'identical');
      const evalResult = await evalPromise;
      check('Agent run 正常完成（证明当时确实持租约）',
        evalResult.ok === true && evalResult.value?.value === 42,
        { ok: evalResult.ok, value: evalResult.value?.value }, { ok: true, value: 42 });

      // (d) nothing else moved: lastError / metrics / page target identity.
      const after = readOnlySnapshot();
      report.observations.h6After = after;
      check('runtime.lastError / lastErrorAt 未变',
        after.lastError === before.lastError && after.lastErrorAt === before.lastErrorAt,
        { before: { lastError: before.lastError, lastErrorAt: before.lastErrorAt }, after: { lastError: after.lastError, lastErrorAt: after.lastErrorAt } },
        'unchanged');
      check('未调用 recordClientMetrics（clientMetrics 未变）',
        JSON.stringify(after.clientMetrics) === JSON.stringify(before.clientMetrics),
        after.clientMetrics, before.clientMetrics);
      check('未新增页 target（targetId/pageCount 未变）',
        after.targetId === before.targetId && after.pageCount === before.pageCount,
        { targetId: after.targetId, pageCount: after.pageCount }, { targetId: before.targetId, pageCount: before.pageCount });
      check('未新增 runtime entry', after.entryCount === before.entryCount,
        { before: before.entryCount, after: after.entryCount }, before.entryCount);
      check('页面关闭前仍只有一个 Chromium 主进程',
        chromeProcesses().length === 1, chromeProcesses().length, 1);
    });

  /* --- H7: invalid arguments ---------------------------------------------------------------- */

  await runProbe('H7', '非法参数：400 INVALID_ARGUMENT，且不破坏后续命中和 lastError',
    '400 INVALID_ARGUMENT for every invalid body', async () => {
      const runtime = state.runtime;
      const lastErrorBefore = runtime.lastError;
      const invalidBodies = [
        { label: '缺 x', body: { y: 10 } },
        { label: '缺 y', body: { x: 10 } },
        { label: 'x 是字符串', body: { x: '10', y: 10 } },
        { label: 'x 是 null', body: { x: null, y: 10 } },
        { label: 'y 非有限数（字符串）', body: { x: 10, y: 'Infinity' } },
        { label: 'x 超出 ±1e7', body: { x: 10000001, y: 10 } },
        { label: 'detail 不是布尔', body: { x: 10, y: 10, detail: 'yes' } },
        { label: 'body 是数组', body: [] },
        { label: 'body 是字符串', body: 'x' },
      ];
      report.observations.h7Cases = [];
      for (const item of invalidBodies) {
        const response = await pick(undefined, undefined, undefined, { body: item.body });
        report.observations.h7Cases.push({ label: item.label, status: response.status, json: response.json });
        check(`${item.label} → 400 INVALID_ARGUMENT`,
          response.status === 400 && response.json?.ok === false && response.json?.code === 'INVALID_ARGUMENT',
          { status: response.status, code: response.json?.code }, { status: 400, code: 'INVALID_ARGUMENT' });
      }
      for (const rawBody of ['{oops', '']) {
        const response = await pick(undefined, undefined, undefined, { rawBody });
        report.observations.h7Cases.push({ label: `rawBody=${JSON.stringify(rawBody)}`, status: response.status, json: response.json });
        check(`请求体 ${JSON.stringify(rawBody)} → 400 INVALID_ARGUMENT`,
          response.status === 400 && response.json?.code === 'INVALID_ARGUMENT',
          { status: response.status, code: response.json?.code }, { status: 400, code: 'INVALID_ARGUMENT' });
      }
      const bound = await pick(10000000, 10);
      report.observations.h7Bound = bound;
      check('|x|=1e7 是合法数值（走页面路径，200 out-of-viewport）',
        bound.status === 200 && bound.json?.element === null, { status: bound.status, json: bound.json }, '200 {element:null}');
      check('非法参数未写 runtime.lastError', runtime.lastError === lastErrorBefore,
        { before: lastErrorBefore, after: runtime.lastError }, 'unchanged');
      const recovered = await pick(260, 520);
      report.observations.h7Recovered = recovered;
      check('非法参数之后正常命中仍工作', recovered.json?.element?.id === 'pick-fixed-btn',
        recovered.json?.element?.id, 'pick-fixed-btn');
    });

  /* --- H8: casing + cross-frame fail-closed; SSR/iframe-inner are NOT_RUN --------------------- */

  await runProbe('H8', '大小写归一与嵌套 same-process frame（iframe 内元素/select 可命中）',
    'div#pick-cased with classes ["Foo","Bar"]; iframe inner button + select picked with root rects', async () => {
      const cased = await pick(100, 540);
      report.observations.h8Cased = cased;
      const truthNow = await pageTruth();
      check('源码大写 <DIV ID CLASS> 被 DOM 归一：tag=div、id/classes 值保留',
        cased.json?.element?.tag === 'div'
          && cased.json?.element?.id === 'pick-cased'
          && JSON.stringify(cased.json?.element?.classes) === JSON.stringify(['Foo', 'Bar']),
        cased.json?.element, { tag: 'div', id: 'pick-cased', classes: ['Foo', 'Bar'] });
      check('真实 DOM 的 tagName 是大写 DIV（对照）', truthNow.casedTagName === 'DIV',
        truthNow.casedTagName, 'DIV');

      // The same document point over the iframe is a child-frame hit: a nested same-process frame is
      // picked with ROOT-frame quads, that frame's own loaderId and frame.main=false.
      const rawInside = await rawHit(650, 340);
      report.observations.h8FrameRaw = rawInside;
      check('原始 CDP 在 iframe 内命中的是子 frame 节点',
        typeof rawInside.frameId === 'string' && rawInside.frameId !== state.runtime.mainFrameId,
        { frameId: rawInside.frameId, mainFrameId: state.runtime.mainFrameId, localName: rawInside.localName },
        'frameId != mainFrameId');

      // Truth for the nested frame: root-frame viewport rect = iframe rect + inner rect.
      const frameTruth = await pageEval(`(() => {
        const frame = document.getElementById('pick-frame');
        const fr = frame.getBoundingClientRect();
        const sx = window.scrollX, sy = window.scrollY;
        const inner = (id) => {
          const r = frame.contentDocument.getElementById(id).getBoundingClientRect();
          return { x: fr.x + r.x + sx, y: fr.y + r.y + sy, width: r.width, height: r.height };
        };
        return { scroll: { x: sx, y: sy },
          frame: { x: fr.x + sx, y: fr.y + sy, width: fr.width, height: fr.height },
          button: inner('inner-btn'), select: inner('inner-select') };
      })()`);
      report.observations.h8FrameTruth = frameTruth;
      const rawTree = await rawSend('Page.getFrameTree', {});
      const childFrame = (rawTree?.frameTree?.childFrames || []).find((node) => node?.frame?.id === rawInside.frameId);
      report.observations.h8FrameTree = childFrame || null;

      const inside = await pick(650, 340);
      report.observations.h8Frame = inside;
      const insideElement = inside.json?.element || null;
      check('iframe 内按钮命中返回真实元素（不再 reason:frame）',
        inside.status === 200 && insideElement?.tag === 'button' && insideElement?.id === 'inner-btn',
        { status: inside.status, tag: insideElement?.tag, id: insideElement?.id }, 'button#inner-btn');
      check('嵌套 frame 命中的 rect 是顶层视口矩形 + 页面滚动（iframe 偏移已含），并带 frame.main=false',
        !!insideElement && insideElement.frame?.main === false
          && insideElement.frameId === rawInside.frameId
          && Math.abs(insideElement.rect.x - frameTruth.button.x) <= 1
          && Math.abs(insideElement.rect.y - frameTruth.button.y) <= 1
          && Math.abs(insideElement.rect.width - frameTruth.button.width) <= 1
          && Math.abs(insideElement.rect.height - frameTruth.button.height) <= 1,
        { rect: insideElement?.rect, truth: frameTruth.button, frame: insideElement?.frame },
        'root-viewport rect, frame.main=false');
      check('嵌套 frame 命中的 loaderId 取自该 frame 自己的文档',
        !!childFrame && insideElement?.loaderId === childFrame.frame.loaderId
          && insideElement.loaderId !== state.runtime.mainFrameId,
        { loaderId: insideElement?.loaderId, childLoaderId: childFrame?.frame?.loaderId },
        'child frame loaderId');

      const edge = await pick(610, 310);
      report.observations.h8FrameEdge = edge;
      check('iframe 边缘（子 frame body）不是元素：200 element:null reason=no-hit',
        edge.status === 200 && edge.json?.element === null && edge.json?.reason === 'no-hit',
        { status: edge.status, json: edge.json }, '200 {element:null,reason:"no-hit"}');

      // The nested <select> must be readable and writable through the SAME bound target.
      const selectPoint = {
        x: frameTruth.select.x + frameTruth.select.width / 2,
        y: frameTruth.select.y + frameTruth.select.height / 2,
      };
      report.observations.h8FrameSelectPoint = selectPoint;
      const innerSelect = await pick(selectPoint.x, selectPoint.y);
      report.observations.h8FrameSelect = innerSelect;
      const selectElement = innerSelect.json?.element || null;
      check('iframe 内 <select> 命中带 select 投影与该 frame 的 target',
        selectElement?.tag === 'select' && selectElement?.id === 'inner-select'
          && selectElement?.select?.options?.map((option) => option.value).join('|') === 'frame-a|frame-b'
          && selectElement?.select?.target?.loaderId === childFrame?.frame?.loaderId,
        { select: selectElement?.select, childLoaderId: childFrame?.frame?.loaderId },
        'select projection + child loaderId');
      let nestedWrite = null;
      try {
        nestedWrite = await state.runtime.selectValue({
          value: 'frame-b',
          optionIndex: 1,
          selector: null,
          target: selectElement?.select?.target,
        });
      } catch (error) {
        nestedWrite = { error: String((error && error.message) || error), code: error?.code, details: error?.details };
      }
      const nestedTruth = await pageEval(`(() => {
        const frame = document.getElementById('pick-frame');
        const select = frame.contentDocument.getElementById('inner-select');
        return { value: select.value, index: select.selectedIndex,
          events: frame.contentDocument.defaultView.frameSelectEvents.slice(),
          mainEvents: window.__pickFrameMainEvents ? window.__pickFrameMainEvents.slice() : [] };
      })()`);
      report.observations.h8FrameSelectWrite = { nestedWrite, nestedTruth };
      check('iframe 内 <select> 写回成功：值生效且 input/change 各一次',
        nestedWrite?.ok === true && nestedTruth.value === 'frame-b' && nestedTruth.index === 1
          && JSON.stringify(nestedTruth.events) === JSON.stringify([
            { type: 'input', value: 'frame-b', index: 1 }, { type: 'change', value: 'frame-b', index: 1 },
          ]),
        { write: nestedWrite, truth: nestedTruth }, 'frame-b, input/change once');
      let staleWrite = null;
      try {
        staleWrite = await state.runtime.selectValue({
          value: 'frame-a', optionIndex: 0, selector: null,
          target: { backendNodeId: selectElement?.select?.target?.backendNodeId, loaderId: 'DEADBEEF' },
        });
      } catch (error) {
        staleWrite = { error: String((error && error.message) || error), code: error?.code, details: error?.details };
      }
      report.observations.h8FrameSelectStale = staleWrite;
      check('伪造的 frame loaderId 被 stale-target 拒绝且零写入',
        staleWrite?.code === 'INVALID_ARGUMENT' && staleWrite?.details?.reason === 'stale-target'
          && (await pageEval(`document.getElementById('pick-frame').contentDocument.getElementById('inner-select').value`)) === 'frame-b',
        staleWrite, '400 stale-target, value unchanged');
    });

  /* --- H8c: shadow-DOM detail (root-scoped selector + shadowHost/closedShadow) ---------------- */

  await runProbe('H8c', 'shadow DOM detail：root-scoped selector、shadowHost、closedShadow',
    'open/closed shadow hit with host facts, document.querySelector(selector) === null', async () => {
      await ensureScroll(200);
      const shadowTruth = await pageEval(`(() => {
        const s = window.__pickShadow;
        const ro = s.openButton.getBoundingClientRect();
        const rc = s.closedButton.getBoundingClientRect();
        return {
          open: { x: ro.x + window.scrollX, y: ro.y + window.scrollY, width: ro.width, height: ro.height },
          closed: { x: rc.x + window.scrollX, y: rc.y + window.scrollY, width: rc.width, height: rc.height },
          openRootMode: s.openRoot.mode,
          closedRootMode: s.closedRoot.mode,
          openHostHasShadowRoot: document.getElementById('pick-shadow-host').shadowRoot !== null,
          closedHostShadowRootIsNull: document.getElementById('pick-closed-host').shadowRoot === null,
        };
      })()`);
      report.observations.h8cTruth = shadowTruth;

      const openPick = await pick(650, 635, true);
      report.observations.h8cOpen = openPick;
      const openElement = openPick.json?.element || {};
      check('open shadow：命中内部 button 且 rect 为文档坐标（≤1px）',
        openElement.tag === 'button' && openElement.id === 'shadow-open-btn'
          && rectClose(openElement.rect, shadowTruth?.open, 1),
        { tag: openElement.tag, id: openElement.id, rect: openElement.rect }, shadowTruth?.open);
      const openSelectorTruth = await pageEval(`(() => {
        const s = window.__pickShadow;
        const selector = ${JSON.stringify(openElement.selector)};
        let rootHit = false;
        try { rootHit = s.openRoot.querySelector(selector) === s.openButton; } catch (error) { rootHit = false; }
        let documentHasIt = true;
        try { documentHasIt = document.querySelector(selector) !== null; } catch (error) { documentHasIt = true; }
        return { rootHit, documentHasIt, selector };
      })()`);
      check('open shadow：selector 在 shadow root 内唯一命中所选元素',
        openSelectorTruth?.rootHit === true, openSelectorTruth, { rootHit: true });
      check('open shadow：document.querySelector(selector) 为 null（selector 是 root-scoped）',
        openSelectorTruth?.documentHasIt === false, openSelectorTruth, { documentHasIt: false });
      check('open shadow：shadowHost 指回宿主 div，closedShadow=false',
        openElement.shadowHost?.selector === '#pick-shadow-host'
          && openElement.shadowHost?.tag === 'div'
          && openElement.closedShadow === false,
        { shadowHost: openElement.shadowHost, closedShadow: openElement.closedShadow },
        { shadowHost: { tag: 'div', selector: '#pick-shadow-host' }, closedShadow: false });
      check('open 宿主对 document 暴露 shadowRoot（真实 DOM 对照）', shadowTruth?.openHostHasShadowRoot === true,
        shadowTruth?.openHostHasShadowRoot, true);

      const closedPick = await pick(650, 735, true);
      report.observations.h8cClosed = closedPick;
      const closedElement = closedPick.json?.element || {};
      check('closed shadow：命中内部 button 且 rect 为文档坐标（≤1px）',
        closedElement.tag === 'button' && closedElement.id === 'shadow-closed-btn'
          && rectClose(closedElement.rect, shadowTruth?.closed, 1),
        { tag: closedElement.tag, id: closedElement.id, rect: closedElement.rect }, shadowTruth?.closed);
      const closedSelectorTruth = await pageEval(`(() => {
        const s = window.__pickShadow;
        const selector = ${JSON.stringify(closedElement.selector)};
        let rootHit = false;
        try { rootHit = s.closedRoot.querySelector(selector) === s.closedButton; } catch (error) { rootHit = false; }
        let documentHasIt = true;
        try { documentHasIt = document.querySelector(selector) !== null; } catch (error) { documentHasIt = true; }
        return { rootHit, documentHasIt, selector };
      })()`);
      check('closed shadow：selector 只能在保存的 closed root 内命中所选元素',
        closedSelectorTruth?.rootHit === true, closedSelectorTruth, { rootHit: true });
      check('closed shadow：document.querySelector(selector) 为 null',
        closedSelectorTruth?.documentHasIt === false, closedSelectorTruth, { documentHasIt: false });
      check('closed shadow：shadowHost 指回宿主 div，closedShadow=true',
        closedElement.shadowHost?.selector === '#pick-closed-host'
          && closedElement.closedShadow === true,
        { shadowHost: closedElement.shadowHost, closedShadow: closedElement.closedShadow },
        { shadowHost: { selector: '#pick-closed-host' }, closedShadow: true });
      check('closed 宿主对 document 不暴露 shadowRoot（真实 DOM 对照）',
        shadowTruth?.closedHostShadowRootIsNull === true, shadowTruth?.closedHostShadowRootIsNull, true);
    });

  /* --- H8d: unknown main frame id is fail-closed --------------------------------------------- */

  await runProbe('H8d', '主帧 id 未知时跨帧 fail-closed（reason=stale）',
    '200 {element:null,reason:"stale"} while mainFrameId is unknown', async () => {
      await ensureScroll(200);
      const runtime = state.runtime;
      const savedMainFrameId = runtime.mainFrameId;
      const control = await pick(260, 520);
      check('对照：已知主帧 id 时命中固定按钮', control.json?.element?.id === 'pick-fixed-btn',
        control.json?.element?.id, 'pick-fixed-btn');
      let unknown;
      try {
        // Test-only mutation: simulate the window before the main frame id is known. The route
        // must never trust a hit whose frame cannot be verified against the main frame.
        runtime.mainFrameId = undefined;
        unknown = await pick(260, 520);
      } finally {
        runtime.mainFrameId = savedMainFrameId;
      }
      report.observations.h8dUnknownFrame = unknown;
      check('主帧 id 未知时不放行：200 element:null reason=stale',
        unknown.status === 200 && unknown.json?.element === null && unknown.json?.reason === 'stale',
        { status: unknown.status, json: unknown.json }, '200 {element:null,reason:"stale"}');
      check('恢复 mainFrameId 后命中恢复',
        runtime.mainFrameId === savedMainFrameId, runtime.mainFrameId === savedMainFrameId, true);
      const recovered = await pick(260, 520);
      check('恢复后 normal pick 返回固定按钮', recovered.json?.element?.id === 'pick-fixed-btn',
        recovered.json?.element?.id, 'pick-fixed-btn');
    });

  /* --- H12: scroll/loaderId consistency, route-level visible boundary, navigation -------------- */

  await runProbe('H12', '一致性回显与可见区边界：scroll、loaderId、导航',
    'scroll/loaderId match raw reads; boundary reasons; loaderId changes on reload', async () => {
      await ensureScroll(200);
      const truthNow = await pageTruth();
      const sample = await pick(260, 520);
      const element = sample.json?.element || {};
      const tree = await rawSend('Page.getFrameTree', {});
      const mainLoaderId = tree?.frameTree?.frame?.loaderId;
      report.observations.h12Sample = sample;
      report.observations.h12Loader = { mainLoaderId, reported: element.loaderId };
      check('hover 响应带 scroll，且与真实页面的 scrollX/scrollY 一致',
        element.scroll?.x === truthNow.scrollX && element.scroll?.y === truthNow.scrollY,
        element.scroll, { x: truthNow.scrollX, y: truthNow.scrollY });
      check('响应带非空 loaderId，且与原始 Page.getFrameTree 主帧 loaderId 相同',
        typeof element.loaderId === 'string' && element.loaderId.length > 0 && element.loaderId === mainLoaderId,
        { loaderId: element.loaderId, mainLoaderId }, 'equal, non-empty');
      check('frameId 与主帧 id 一致', element.frameId === state.runtime.mainFrameId,
        { frameId: element.frameId, mainFrameId: state.runtime.mainFrameId }, 'equal');

      // Route-level visible-area boundary: the hit test only works on the currently visible rows.
      const metrics = await readLayoutMetrics();
      const css = metrics.cssLayoutViewport || {};
      const visibleHeight = css.clientHeight;
      const boundaryCases = [
        { label: '首行 y=scrollY 命中页面背景 → no-hit', point: { x: 100, y: css.pageY }, reason: 'no-hit' },
        { label: 'y=scrollY-1 → out-of-viewport', point: { x: 100, y: css.pageY - 1 }, reason: 'out-of-viewport' },
        { label: `末行 y=scrollY+clientHeight-1(${css.pageY + visibleHeight - 1}) 命中页面背景 → no-hit`, point: { x: 100, y: css.pageY + visibleHeight - 1 }, reason: 'no-hit' },
        { label: 'y=scrollY+clientHeight → out-of-viewport', point: { x: 100, y: css.pageY + visibleHeight }, reason: 'out-of-viewport' },
      ];
      report.observations.h12Boundary = [];
      for (const item of boundaryCases) {
        const response = await pick(item.point.x, item.point.y);
        report.observations.h12Boundary.push({ ...item, response });
        check(item.label,
          response.status === 200 && response.json?.element === null && response.json?.reason === item.reason,
          { status: response.status, json: response.json }, `200 {element:null,reason:"${item.reason}"}`);
      }

      // Reload is a real navigation: the loader id (document generation) must change.
      const firstLoaderId = element.loaderId;
      const reload = await harness.request({
        method: 'POST', path: '/plugins/ui-testing/reload', headers: scopedHeaders, body: {},
      });
      check('POST /reload 成功（真实整页导航）', reload.statusCode === 200, reload.statusCode, 200);
      await waitFor(async () => {
        const current = await rawSend('Page.getFrameTree', {});
        return current?.frameTree?.frame?.loaderId
          && current.frameTree.frame.loaderId !== firstLoaderId;
      }, { timeoutMs: 15000, intervalMs: 100, label: 'loaderId changed after reload' });
      await waitFor(async () => (await pageTruth()).title === 'Pick Element Fixture',
        { timeoutMs: 15000, intervalMs: 100, label: 'reloaded page ready' });
      const truthAfter = await pageTruth();
      // Chrome may restore the scroll position across a reload, so the probe point is taken from
      // the page's own post-reload rect instead of assuming y=0.
      const fixedDoc = truthAfter.rects['pick-fixed-btn'].doc;
      const afterReload = await pick(fixedDoc.x + fixedDoc.width / 2, fixedDoc.y + fixedDoc.height / 2);
      const afterElement = afterReload.json?.element || {};
      const treeAfter = await rawSend('Page.getFrameTree', {});
      const loaderAfter = treeAfter?.frameTree?.frame?.loaderId;
      report.observations.h12AfterReload = { afterReload, truthAfter };
      check('导航后仍命中固定按钮（探针点取自 reload 后的真实 rect）',
        afterElement.id === 'pick-fixed-btn', afterElement.id, 'pick-fixed-btn');
      check('导航后 loaderId 变化，且与新主帧的 loaderId 一致',
        typeof afterElement.loaderId === 'string' && afterElement.loaderId !== firstLoaderId
          && afterElement.loaderId === loaderAfter,
        { before: firstLoaderId, after: afterElement.loaderId, raw: loaderAfter },
        'changed and equal to raw');
      check('导航后 scroll 回显与真实页面一致（滚动位置可能被浏览器恢复）',
        afterElement.scroll?.x === truthAfter.scrollX && afterElement.scroll?.y === truthAfter.scrollY,
        afterElement.scroll, { x: truthAfter.scrollX, y: truthAfter.scrollY });
      check('导航后 frameId 跟随新主帧', afterElement.frameId === state.runtime.mainFrameId,
        { frameId: afterElement.frameId, mainFrameId: state.runtime.mainFrameId }, 'equal');
    });

  notRunProbe('H8b', '服务端渲染文档（无 SSR fixture）',
    '仓库内没有服务端渲染 fixture；本切片不虚构该场景');

  /* --- H1b: a closed page stays cold (no restart) ------------------------------------------- */

  await runProbe('H1b', '关闭后保持冷态：POST 返回 no-page 且不重启 Chromium', '200 no-page; zero Chromium', async () => {
    // Close the SESSION scope this suite has been using (the legacy scope has no page).
    await harness.request({ method: 'POST', path: '/plugins/ui-testing/close', headers: scopedHeaders, body: {} });
    await waitFor(() => state.runtime.running === false, { timeoutMs: 10000, intervalMs: 100, label: 'page closed' });
    await waitFor(() => chromeProcesses().length === 0, { timeoutMs: 10000, intervalMs: 100, label: 'Chromium exited' });
    const closed = await pick(260, 340);
    report.observations.h1bClosed = closed;
    check('关闭页面后 POST 返回 200 element:null reason=no-page',
      closed.status === 200 && closed.json?.element === null && closed.json?.reason === 'no-page',
      { status: closed.status, json: closed.json }, '200 {element:null,reason:"no-page"}');
    check('关闭后没有重新启动 Chromium',
      chromeProcesses().length === 0, chromeProcesses().length, 0);
  });

  state.cleanupResult = await cleanupResources('done');
  const failures = report.probes
    .filter((probe) => probe.status !== 'skip')
    .flatMap((probe) => probe.checks.filter((item) => !item.advisory))
    .filter((item) => !item.pass);
  await writeReport(failures.length ? 1 : 0);
  return report.summary.exitCode;
}

/* ------------------------------------------------------------------------------------------------
 * Entry point with a bounded total budget
 * ---------------------------------------------------------------------------------------------- */

let watchdog;
main()
  .then((code) => {
    if (watchdog) clearTimeout(watchdog);
    process.exit(code);
  })
  .catch(async (error) => {
    if (watchdog) clearTimeout(watchdog);
    log(`[FATAL] ${error && error.stack ? error.stack : String(error)}`);
    if (!state.cleanupResult) state.cleanupResult = await cleanupResources('fatal');
    await writeReport(2);
    process.exit(2);
  });

watchdog = setTimeout(async () => {
  log(`[FATAL] watchdog: 超过 ${TOTAL_TIMEOUT_MS}ms 未完成`);
  if (!state.cleanupResult) state.cleanupResult = await cleanupResources('watchdog');
  await writeReport(2);
  process.exit(2);
}, TOTAL_TIMEOUT_MS);
watchdog.unref?.();
