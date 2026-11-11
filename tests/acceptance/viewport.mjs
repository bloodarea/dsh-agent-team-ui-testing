#!/usr/bin/env node
/**
 * Host shared-viewport acceptance suite (docs/viewport-control.md, H1–H10 的 Host 可落地子集).
 *
 * Drives the *real* plugin (index.js) through the fake-Cordis harness in this directory, with the
 * plugin's own headless Chromium and the repository loopback fixture. Every assertion is one of:
 *   - a real page truth read back through browser_eval (`innerWidth`, `devicePixelRatio`,
 *     `visualViewport.scale`, `scrollX/scrollY`, a fixed element's rect),
 *   - a decoded PNG fact (inspectPng + IHDR, independent of the tool's own size check),
 *   - a counted CDP command (the runtime's `send` is wrapped, so "no override was sent" is measured,
 *     not inferred),
 *   - a pure JSON/envelope shape.
 * Nothing here is "the tool said it worked".
 *
 * Run: node tests/acceptance/viewport.mjs
 * Exit: 0 = every required check passed, 1 = a check failed, 2 = the environment is unusable.
 *
 * Evidence: tests/acceptance/runs/viewport-<ISO>-<pid>/{report.json,run.log,*.png}
 *
 * Scope of this suite (vs docs/viewport-control.md §8.1): H1–H10 are *not* claimed complete.
 *   covered here : H1 (registration/cold diagnostics), H2 (presets/patch/same-value/two scopes/
 *                  pre-flight zero-CDP), H3 (scale-only layout invariance + override counting),
 *                  H4 (x/y measured + clamp + one-axis + resize clamp),
 *                  H4b (page/panel-initiated scroll is observed via the coalesced readback:
 *                       observed/view.x/y echo the page, source='page', revision+1, no idle reads),
 *                  H5 (expectedRevision CAS,
 *                  BUSY, get readable under another owner), H6 (legacy POST compat + v1 strict +
 *                  ui.view), H7 (default/explicit capture sizes + mapping + low-scale refusal +
 *                  16M budget), H8 (T3 live default scale + frozen act recapture),
 *                  H10 (lossless JSON, close resets observed/x/y),
 *                  H11/canvas (docs/viewport-control.md: C/S/O invariants, canvasX/canvasY set,
 *                       x/y keeps O, page scroll keeps O, navigation/close reset,
 *                       HTTP/state/capabilities ui.canvas projection),
 *                  H12/frame-metadata (frame scrollX/scrollY through FrameSource, the WS binary
 *                       header and /frame).
 *   NOT covered  : H9 (screencast ACK/帧递增 timing), T2/P0/T3 全套回归、真实宿主 30 工具（需重启）,
 *                  provider 视觉可见性、GUI 侧 fit/滚轮/映射（属 client.js 切片）。
 */
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(HERE, '..', '..');
const DEFAULT_CHROME = '/opt/google/chrome/chrome';
const TOTAL_TIMEOUT_MS = Number(process.env.DSH_VIEWPORT_TIMEOUT_MS) > 0
  ? Number(process.env.DSH_VIEWPORT_TIMEOUT_MS)
  : 240000;
const FIXTURE_PAGE = '/capture-p0.html';
const STARTED_AT = new Date();
const STAMP = STARTED_AT.toISOString().replace(/[:.]/g, '-');
const EVIDENCE_DIR = join(HERE, 'runs', `viewport-${STAMP}-${process.pid}`);

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
  if (Buffer.isBuffer(value)) return `[Buffer ${value.length} bytes]`;
  if (Array.isArray(value)) return value.slice(0, 60).map((item) => jsonSafe(item, depth + 1));
  const out = {};
  for (const [key, child] of Object.entries(value)) out[key] = jsonSafe(child, depth + 1);
  return out;
}

const report = {
  schemaVersion: 1,
  suite: 'viewport',
  generatedAt: STARTED_AT.toISOString(),
  command: 'node tests/acceptance/viewport.mjs',
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
}

function check(label, pass, actual, expected, { advisory = false } = {}) {
  const entry = { label, expected: jsonSafe(expected), actual: jsonSafe(actual), pass: Boolean(pass), advisory };
  currentProbe.checks.push(entry);
  const tag = entry.pass ? 'PASS' : (advisory ? 'WARN' : 'FAIL');
  log(`  [${tag}] ${label}`);
  if (!entry.pass) log(`         actual: ${JSON.stringify(entry.actual).slice(0, 700)}`);
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
    currentProbe.error = jsonSafe({ name: error?.name, message: String(error?.message || error), stack: String(error?.stack || '').split('\n').slice(0, 8) });
    log(`  [FAIL] probe threw: ${currentProbe.actual}`);
  } finally {
    currentProbe.durationMs = Date.now() - currentProbe.startedAt;
  }
}

/* ------------------------------------------------------------------------------------------------
 * Assertion helpers
 * ---------------------------------------------------------------------------------------------- */

const sha256 = (buffer) => createHash('sha256').update(buffer).digest('hex');
const sleep = (ms) => new Promise((resolve) => { setTimeout(resolve, ms); });

function errorInfo(result) {
  return result && result.threw
    ? {
      name: result.error?.name,
      code: result.error?.code,
      category: result.error?.category,
      retryable: result.error?.retryable,
      message: String(result.error?.message || ''),
      details: result.error?.details,
    }
    : { threw: false, value: result?.value };
}

const hasErrorCode = (result, code) => result?.threw === true && result.error?.code === code;

async function pageTruth(harness, exec) {
  const result = await harness.invoke('browser_eval', {
    expression: `(function () {
      const el = document.getElementById('cap-red');
      const fixed = document.getElementById('cap-fixed');
      const rect = el ? el.getBoundingClientRect() : null;
      const fixedRect = fixed ? fixed.getBoundingClientRect() : null;
      return {
        innerWidth: window.innerWidth,
        innerHeight: window.innerHeight,
        dpr: window.devicePixelRatio,
        visualViewportScale: window.visualViewport ? window.visualViewport.scale : null,
        scrollX: window.scrollX,
        scrollY: window.scrollY,
        docWidth: document.documentElement.scrollWidth,
        docHeight: document.documentElement.scrollHeight,
        red: rect ? { x: rect.x, y: rect.y, width: rect.width, height: rect.height } : null,
        fixed: fixedRect ? { x: fixedRect.x, y: fixedRect.y, width: fixedRect.width, height: fixedRect.height } : null,
        title: document.title,
      };
    })()`,
  }, exec);
  return result.value?.value ?? null;
}

async function waitFor(condition, { timeoutMs = 8000, intervalMs = 60, label = 'condition' } = {}) {
  const started = Date.now();
  let last;
  while (Date.now() - started < timeoutMs) {
    last = await condition();
    if (last) return last;
    await sleep(intervalMs);
  }
  throw new Error(`timed out waiting for ${label} (last=${JSON.stringify(jsonSafe(last))})`);
}

/** Wrap one Runtime's `send` so CDP commands are counted instead of assumed. */
function instrumentRuntime(runtime) {
  const counts = { calls: {} };
  const original = runtime.send.bind(runtime);
  runtime.send = (method, params, signal) => {
    counts.calls[method] = (counts.calls[method] ?? 0) + 1;
    return original(method, params, signal);
  };
  return {
    counts,
    reset() { for (const key of Object.keys(counts.calls)) delete counts.calls[key]; },
    count(method) { return counts.calls[method] ?? 0; },
    total() { return Object.values(counts.calls).reduce((sum, value) => sum + value, 0); },
  };
}

/** The single Runtime of one scope, straight off the fake-ctx registry handle. */
function runtimeFor(harness, scopeId) {
  const registry = harness.ctx.__internal.plugin?.registry;
  if (!registry) return undefined;
  for (const entry of registry.entries.values()) {
    if (!scopeId || entry.scope?.id === scopeId) return entry.runtime;
  }
  return undefined;
}

function losslessProblem(value, path = 'value') {
  if (value === undefined) return `${path} is undefined`;
  if (value === null) return null;
  if (typeof value === 'function') return `${path} is a function`;
  if (typeof value === 'number' && !Number.isFinite(value)) return `${path} is non-finite`;
  if (typeof value === 'bigint' || typeof value === 'symbol') return `${path} is ${typeof value}`;
  if (typeof value !== 'object') return null;
  if (Buffer.isBuffer(value)) return `${path} is a Buffer`;
  if (Array.isArray(value)) {
    for (let i = 0; i < value.length; i += 1) {
      const problem = losslessProblem(value[i], `${path}[${i}]`);
      if (problem) return problem;
    }
    return null;
  }
  for (const [key, child] of Object.entries(value)) {
    const problem = losslessProblem(child, `${path}.${key}`);
    if (problem) return problem;
  }
  return null;
}

async function listFilesRecursive(dir) {
  const out = [];
  let entries;
  try { entries = await readdir(dir, { withFileTypes: true }); } catch { return out; }
  for (const entry of entries) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...await listFilesRecursive(full));
    else out.push(full);
  }
  return out.sort();
}

/* ------------------------------------------------------------------------------------------------
 * Environment / cleanup
 * ---------------------------------------------------------------------------------------------- */

const state = {
  harnesses: [],
  harness: undefined,
  fixture: undefined,
  captureRoot: undefined,
  profilesBefore: [],
  cleanupResult: undefined,
  finished: false,
};

async function cleanupResources(reason) {
  if (state.cleanupResult) return state.cleanupResult;
  const result = {
    reason, closedHarnesses: [], killedPids: [], removedProfileDirs: [],
    leftoverProfileDirs: [], leftoverChromePids: [], fixtureClosed: false,
    captureRootRemoved: false, errors: [],
  };
  for (const harness of state.harnesses) {
    try { await harness.closeBrowser(); result.closedHarnesses.push(harness.name); }
    catch (error) { result.errors.push(`close ${harness.name}: ${error && error.message ? error.message : String(error)}`); }
  }
  await sleep(1000);
  for (const harness of state.harnesses) {
    try { await harness.dispose(); } catch (error) { result.errors.push(`dispose ${harness.name}: ${error && error.message ? error.message : String(error)}`); }
  }
  const harnessModule = await import(pathToFileURL(join(HERE, 'harness.mjs')).href);
  const stray = harnessModule.scanPluginChromeProcesses().filter((proc) => proc.parentPid === process.pid);
  for (const proc of stray) { try { process.kill(proc.pid, 'SIGTERM'); } catch { /* ignore */ } }
  if (stray.length) await sleep(1000);
  for (const proc of stray) {
    if (harnessModule.isProcessAlive(proc.pid)) { try { process.kill(proc.pid, 'SIGKILL'); } catch { /* ignore */ } }
    if (!harnessModule.isProcessAlive(proc.pid)) result.killedPids.push(proc.pid);
  }
  await sleep(300);
  const profilesAfter = await harnessModule.snapshotProfileDirs();
  for (const dir of profilesAfter.filter((item) => !state.profilesBefore.includes(item))) {
    if (!dir.startsWith(tmpdir())) continue;
    try { await rm(dir, { recursive: true, force: true }); result.removedProfileDirs.push(dir); }
    catch (error) { result.errors.push(`rm profile ${dir}: ${error && error.message ? error.message : String(error)}`); }
  }
  result.leftoverProfileDirs = (await harnessModule.snapshotProfileDirs()).filter((dir) => !state.profilesBefore.includes(dir));
  result.leftoverChromePids = stray.filter((proc) => harnessModule.isProcessAlive(proc.pid)).map((proc) => proc.pid);
  if (state.fixture) {
    try { await state.fixture.close(); result.fixtureClosed = true; }
    catch (error) { result.errors.push(`fixture close: ${error && error.message ? error.message : String(error)}`); }
  }
  if (state.captureRoot) {
    try { await rm(state.captureRoot, { recursive: true, force: true }); result.captureRootRemoved = !existsSync(state.captureRoot); }
    catch (error) { result.errors.push(`rm capture root: ${error && error.message ? error.message : String(error)}`); }
  }
  for (const dir of state.workspaceDirs || []) {
    try { await rm(dir, { recursive: true, force: true }); } catch { /* best effort */ }
  }
  log(`\n[cleanup] ${reason}: ${JSON.stringify(jsonSafe(result))}`);
  return result;
}

async function writeReport(overrideExitCode) {
  const required = report.probes
    .filter((probe) => probe.status !== 'skip')
    .flatMap((probe) => probe.checks.filter((item) => !item.advisory));
  const failed = required.filter((item) => !item.pass);
  const failedProbes = report.probes.filter((probe) => probe.status === 'fail').length;
  report.summary = {
    probes: report.probes.length,
    passed: report.probes.filter((probe) => probe.status === 'pass').length,
    failed: failedProbes,
    requiredChecks: required.length,
    failedChecks: failed.length,
    findings: report.findings.length,
    // A probe that threw is a failure even when the checks it managed to run all passed.
    exitCode: overrideExitCode !== undefined ? overrideExitCode : (failed.length > 0 || failedProbes > 0 ? 1 : 0),
  };
  report.resources = state.cleanupResult || { reason: 'not-run' };
  await mkdir(EVIDENCE_DIR, { recursive: true });
  await writeFile(join(EVIDENCE_DIR, 'report.json'), JSON.stringify(report, null, 2));
  await writeFile(join(EVIDENCE_DIR, 'run.log'), logLines.join('\n') + '\n');
  log(`\nprobes=${report.summary.probes} pass=${report.summary.passed} fail=${report.summary.failed} requiredChecks=${report.summary.requiredChecks} failedChecks=${report.summary.failedChecks} findings=${report.summary.findings}`);
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
  state.captureRoot = await mkdtemp(join(tmpdir(), 'dsh-ui-testing-viewport-'));
  process.env.DSH_UI_TESTING_CAPTURE_DIR = state.captureRoot;
  // Two independent workspaces inside ONE plugin instance (two scopes, one Chromium).
  state.workspaceDirs = [
    await mkdtemp(join(tmpdir(), 'dsh-ui-testing-ws-a-')),
    await mkdtemp(join(tmpdir(), 'dsh-ui-testing-ws-b-')),
  ];
  const [dirA, dirB] = state.workspaceDirs;

  const harnessModule = await import(pathToFileURL(join(HERE, 'harness.mjs')).href);
  const {
    createHarness, createFakeWorkspaceRegistry, scanPluginChromeProcesses, snapshotProfileDirs,
    EXPECTED_TOOLS, captureTempRoot,
  } = harnessModule;
  const { startFixtureServer } = await import(pathToFileURL(join(REPO_ROOT, 'tests/ui_test_fixture/server.mjs')).href);
  const { decodePng, inspectPng } = await import(pathToFileURL(join(REPO_ROOT, 'capture-p0.js')).href);
  // Frame metadata is unit-tested directly (docs/viewport-control.md §5.1): the WS push and the frame
  // store must both carry the capture-time top-level scroll.
  const { FrameSource } = await import(pathToFileURL(join(REPO_ROOT, 'frame-source.js')).href);
  const { createFramePusher } = await import(pathToFileURL(join(REPO_ROOT, 'frame-push.js')).href);

  state.profilesBefore = await snapshotProfileDirs();
  state.fixture = await startFixtureServer();
  const pageUrl = new URL(FIXTURE_PAGE, state.fixture.url).href;

  const sessions = {
    get(id) {
      const cwd = String(id).endsWith('-b') ? dirB : dirA;
      return { id, header: { cwd } };
    },
  };
  const workspaceRegistry = createFakeWorkspaceRegistry({
    workspaces: [{ id: 'ws-a', path: dirA }, { id: 'ws-b', path: dirB }],
  });
  const harness = await createHarness({ name: 'viewport', sessions, workspaceRegistry });
  state.harnesses.push(harness);
  state.harness = harness;

  const execA = { agent: { id: 'vp-a', session: { header: { cwd: dirA } } } };
  const execB = { agent: { id: 'vp-b', session: { header: { cwd: dirB } } } };
  const execOther = { agent: { id: 'vp-a-other', session: { header: { cwd: dirA } } } };

  report.environment = {
    suite: 'viewport',
    node: process.version,
    platform: `${process.platform}/${process.arch}`,
    chromeBin,
    fixtureUrl: state.fixture.url,
    pageUrl,
    captureRoot: state.captureRoot,
    harnessCaptureRoot: captureTempRoot() ?? null,
    workspaceA: dirA,
    workspaceB: dirB,
    evidenceDir: EVIDENCE_DIR,
    timeoutMs: TOTAL_TIMEOUT_MS,
    toolCount: EXPECTED_TOOLS.length,
  };
  log(`[env] chrome=${chromeBin}`);
  log(`[env] fixture=${state.fixture.url}`);
  log(`[env] workspaces=${dirA} | ${dirB}`);

  const view = (result) => result?.value ?? {};
  // The scoped runtime of workspace A (the suite's main scope): `runtimeFor` returns the first entry,
  // which stops being unambiguous once the legacy scope exists too.
  const runtimeByWorkspace = (workspaceId) => {
    const registry = harness.ctx.__internal.plugin?.registry;
    if (!registry) return undefined;
    for (const entry of registry.entries.values()) {
      if (entry.scope?.workspaceId === workspaceId) return entry.runtime;
    }
    return undefined;
  };
  const scopedHeadersA = { 'x-ui-testing-scope-version': '1', 'x-ui-testing-session-id': 'vp-a' };
  const ownerConnection = () => harnessModule.createFakeConnectionService({
    rejection: undefined,
    admit: () => ({ peer: { id: 'peer-owner' } }),
    browserPeer: { id: 'peer-owner' },
  });
  /** Decode one server->client WS binary frame header (see frame-push.js wire format). */
  function decodeWsFrameHeader(buffer) {
    let offset = 2;
    let length = buffer[1] & 0x7f;
    if (length === 126) { length = buffer.readUInt16BE(2); offset = 4; }
    else if (length === 127) { length = buffer.readUInt32BE(6); offset = 10; }
    const payload = buffer.subarray(offset, offset + length);
    const headerLength = payload.readUInt32BE(0);
    return JSON.parse(payload.subarray(4, 4 + headerLength).toString('utf8'));
  }
  // A /state read schedules a coalesced metrics read (≥200ms throttled). `readStateQuiet` takes the
  // snapshot and then drains that scheduled read, so the next step starts from a settled cache
  // instead of racing the readback this very request just armed.
  const sleepForObservation = () => sleep(340);
  const readStateRaw = async () => (await harness.request({ method: 'GET', path: '/plugins/ui-testing/state' })).json;
  async function readStateQuiet() { const state = await readStateRaw(); await sleepForObservation(); return state; }
  const setView = (patch, exec) => harness.invoke('browser_viewport', { action: 'set', ...patch }, exec);
  const getView = (exec) => harness.invoke('browser_viewport', { action: 'get' }, exec);

  /* ---------------------------------------------------------------------------------------------
   * P0-D annotations (docs/viewport-control.md §11) — Host helpers.
   *
   * The panel's annotation document has exactly ONE write surface: the scoped, peer-authenticated
   * `POST /plugins/ui-testing/annotations`. There is no 31st tool, so every helper below talks to
   * that HTTP route with the real scope headers and the real owner gate.
   * ------------------------------------------------------------------------------------------- */
  const ANNOT_HEADERS_A = { 'x-ui-testing-scope-version': '1', 'x-ui-testing-session-id': 'vp-a' };
  const ANNOT_HEADERS_B = { 'x-ui-testing-scope-version': '1', 'x-ui-testing-session-id': 'vp-b' };
  const ANNOT_HEADERS_UNASSIGNED = { 'x-ui-testing-scope-version': '1', 'x-ui-testing-scope': 'unassigned' };
  const annotOwner = () => harnessModule.createFakeConnectionService({
    rejection: undefined, admit: () => ({ peer: { id: 'peer-owner' } }), browserPeer: { id: 'peer-owner' },
  });
  /** A deterministic, contract-valid panel id (`^uuid$`, lower-case hex). */
  const panelIdFor = (n) => '00000000-0000-4000-8000-' + String(n).padStart(12, '0');
  const zeroTruncation = () => ({ droppedShapes: 0, droppedPoints: 0, shortenedTextCodeUnits: 0 });
  /** Scoped `/state` read: the only place `ui.annotationContext`/`ui.annotations` exist. */
  const readScopedState = async (headers = ANNOT_HEADERS_A) => {
    harness.setConnection(annotOwner());
    try {
      const response = await harness.request({ method: 'GET', path: '/plugins/ui-testing/state', headers });
      return response.json;
    } finally { harness.setConnection(undefined); }
  };
  /**
   * The publish body the panel is contracted to send, built from its own accepted snapshot.
   * `state` may be either the whole `/state` value or just its `ui` projection.
   */
  const annotationPublishBody = (state, {
    panelId = panelIdFor(1), clientRevision = 1, shapes = [], release = false, surface = 'main',
    truncation = zeroTruncation(), context, view: viewOverride,
  } = {}) => {
    const ui = state?.ui || state || {};
    const view = ui.view || state?.view || {};
    const canvas = ui.canvas || state?.canvas || {};
    return {
      version: 1,
      panelId,
      surface,
      clientRevision,
      context: context ? { ...context } : { ...(ui.annotationContext || {}) },
      view: viewOverride || {
        canvasX: view.canvasX, canvasY: view.canvasY, x: view.x, y: view.y,
        width: view.width, height: view.height, scale: view.scale,
        contentWidth: canvas.contentWidth, contentHeight: canvas.contentHeight,
        viewRevision: view.revision, frameEpoch: null,
      },
      shapes,
      truncation,
      release,
    };
  };
  const publishAnnotations = async (body, { headers = ANNOT_HEADERS_A, authenticated = true, rawBody } = {}) => {
    harness.setConnection(authenticated ? annotOwner() : harnessModule.createFakeConnectionService({ rejection: 401 }));
    try {
      return await harness.request({
        method: 'POST', path: '/plugins/ui-testing/annotations', headers, body, rawBody,
      });
    } finally { harness.setConnection(undefined); }
  };
  /** One instance of every shape type, with an evidence-grade text payload. */
  const annotationShapes = () => ([
    { id: 'a1', type: 'rect', color: '#ff3b30', strokeWidth: 3, fill: false, stroke: true, x: 10, y: 20, width: 100, height: 50 },
    { id: 'a2', type: 'circle', color: '#0a84ff', strokeWidth: 2, fill: true, stroke: false, cx: 200, cy: 120, rx: 40, ry: 25 },
    { id: 'a3', type: 'line', color: '#34c759', strokeWidth: 4, fill: false, stroke: true, x1: 0, y1: 0, x2: 100, y2: 100 },
    { id: 'a4', type: 'arrow', color: '#ff9500', strokeWidth: 5, fill: false, stroke: true, x1: 10, y1: 10, x2: 60, y2: 70, head: { length: 9999, width: 9999 } },
    { id: 'a5', type: 'brush', color: '#af52de', strokeWidth: 1, fill: false, stroke: true, points: [[0, 0], [5, 5], [10, 12]] },
    { id: 'a6', type: 'text', color: '#000000', strokeWidth: 1, fill: true, stroke: false, x: 30, y: 40, fontSize: 20, text: '问题在这里 <> & "quoted"' },
  ]);

  /* ---------------------------------------------------------------- V1: tool surface */
  await runProbe('V1-tool-surface', '工具注册与 schema（当前工具面，browser_viewport required=[action]）',
    '注册表恰好与 EXPECTED_TOOLS 一致；browser_viewport schema required=[action]、additionalProperties=false、action enum get/set、mode enum 四预设；description 非空；render 可用', async () => {
      const names = harness.toolNames();
      check(`注册表恰好 ${EXPECTED_TOOLS.length} 个工具（10 T1 + 1 P0-E + 7 T2 + 6 T3 + 7 network + 5 T4）`,
        names.length === EXPECTED_TOOLS.length, { count: names.length }, { count: EXPECTED_TOOLS.length });
      check('browser_viewport 已注册', names.includes('browser_viewport'), { names }, 'browser_viewport in names');

      const definition = harness.tools.get('browser_viewport');
      const parameters = definition?.parameters || {};
      check('schema: required=[action] 且 additionalProperties=false',
        JSON.stringify(parameters.required) === JSON.stringify(['action'])
          && parameters.additionalProperties === false && parameters.type === 'object',
      { required: parameters.required, additionalProperties: parameters.additionalProperties }, { required: ['action'], additionalProperties: false });
      check('schema: action enum=[get,set]，mode enum=四预设，width/height=integer',
        JSON.stringify(parameters.properties?.action?.enum) === JSON.stringify(['get', 'set'])
          && JSON.stringify(parameters.properties?.mode?.enum) === JSON.stringify(['wide', 'landscape', 'tablet', 'phone'])
          && parameters.properties?.width?.type === 'integer'
          && parameters.properties?.height?.type === 'integer'
          && parameters.properties?.scale?.type === 'number',
      {
        action: parameters.properties?.action?.enum,
        mode: parameters.properties?.mode?.enum,
        width: parameters.properties?.width?.type,
        height: parameters.properties?.height?.type,
        scale: parameters.properties?.scale?.type,
      }, { action: ['get', 'set'], mode: ['wide', 'landscape', 'tablet', 'phone'] });
      check('schema: canvasX/canvasY 以 number 声明（画布增量字段；范围仍在执行期校验）',
        parameters.properties?.canvasX?.type === 'number' && parameters.properties?.canvasY?.type === 'number'
          && typeof parameters.properties?.canvasX?.description === 'string'
          && /画布|canvas/i.test(parameters.properties.canvasX.description),
      { canvasX: parameters.properties?.canvasX, canvasY: parameters.properties?.canvasY }, { canvasX: 'number', canvasY: 'number' });
      check('description 非空且明确区分 get/set 语义',
        typeof definition?.description === 'string' && /get=只读缓存诊断/.test(definition.description)
          && /set=页面操作/.test(definition.description), { description: String(definition?.description).slice(0, 120) }, 'get/set 描述');
      check('browser_state 不新增设置参数（仍为空 schema）',
        JSON.stringify(harness.tools.get('browser_state')?.parameters?.properties) === '{}',
        harness.tools.get('browser_state')?.parameters, { properties: {} });
    });

  /* ---------------------------------------------------------------- V2: cold diagnostics */
  await runProbe('V2-cold-diagnostics', '冷启动只读诊断（不启动浏览器/不建 page/profile/不改 recent）',
    'get 返回 running:false、observed:null、viewMeta.stale=true；capabilities 诊断；进程/profile/页面/registry recent 均无副作用', async () => {
      const processesBefore = scanPluginChromeProcesses().filter((proc) => proc.parentPid === process.pid).length;
      const profilesBefore = await snapshotProfileDirs();
      const recentBefore = harness.ctx.__internal.plugin?.registry?.recentKey ?? null;

      const cold = await getView();
      const value = view(cold);
      check('cold get 成功且 running:false', cold.ok === true && value.running === false, { running: value.running }, { running: false });
      check('cold get observed=null（未知不等同已观测）', value.observed === null, { observed: value.observed }, null);
      check('cold get viewMeta: observedAt=null、stale=true、originId=null',
        value.viewMeta?.observedAt === null && value.viewMeta?.stale === true && value.viewMeta?.originId === null,
        value.viewMeta, { observedAt: null, stale: true, originId: null });
      check('cold view 为默认 1280×800 / x,y=0 / scale=1 / revision=0 / source=default',
        value.view?.width === 1280 && value.view?.height === 800 && value.view?.x === 0 && value.view?.y === 0
          && value.view?.scale === 1 && value.view?.revision === 0 && value.view?.source === 'default'
          && value.view?.mode === 'custom',
      value.view, { width: 1280, height: 800, scale: 1, revision: 0, source: 'default' });

      const capabilities = await harness.invoke('browser_capabilities');
      check('capabilities 冷启动可诊断且声明 web.t1.viewport available',
        capabilities.ok === true && capabilities.value?.runtime?.running === false
          && capabilities.value?.capabilities?.some((item) => item.id === 'web.t1.viewport'
            && item.tool === 'browser_viewport' && item.status === 'available'),
      { running: capabilities.value?.runtime?.running, viewport: capabilities.value?.capabilities?.find((item) => item.id === 'web.t1.viewport') }, 'web.t1.viewport available');

      const processesAfter = scanPluginChromeProcesses().filter((proc) => proc.parentPid === process.pid).length;
      const profilesAfter = await snapshotProfileDirs();
      const runtime = runtimeFor(harness);
      check('cold get/capabilities 未启动 Chromium、未建临时 profile',
        processesAfter === processesBefore && JSON.stringify(profilesAfter.sort()) === JSON.stringify(profilesBefore.sort()),
      { processesBefore, processesAfter, newProfiles: profilesAfter.filter((dir) => !profilesBefore.includes(dir)) }, 'no process / no profile');
      check('cold get 未创建页面（runtime.page 仍为空）', runtime?.page === undefined && runtime?.cdp === undefined,
        { page: runtime?.page ?? null, cdp: Boolean(runtime?.cdp) }, 'no page');
      check('cold get 不改 registry recent', (harness.ctx.__internal.plugin?.registry?.recentKey ?? null) === recentBefore,
        { recent: harness.ctx.__internal.plugin?.registry?.recentKey ?? null }, recentBefore);
    });

  /* ---------------------------------------------------------------- V3: patch semantics */
  await runProbe('V3-patch-semantics', '预设/增量 patch/同值不增 revision/两 scope 独立/非法预检零 CDP',
    '四预设与 custom 派生；partial patch 保留其他字段；same-value 不增 revision；A/B 两个 scope 互不影响；非法字段/NaN/字符串/小数宽高/越界/空 patch/mode 冲突全部 INVALID_ARGUMENT 且零 CDP', async () => {
      // A scale-only set is still a page operation: it lazily starts the page (contract §7) and
      // must not touch the not-yet-measured width/height.
      const coldSet = await setView({ scale: 0.9 }, execA);
      check('冷启动下 scale-only set 会懒启动页面（ensure+queue+lease）且不改默认宽高',
        coldSet.ok === true && coldSet.value?.view?.scale === 0.9
          && coldSet.value.view.width === 1280 && coldSet.value.view.height === 800
          && coldSet.value.appliedFields?.includes('scale')
          && coldSet.value.overrideApplied === false,
      { view: coldSet.value?.view, appliedFields: coldSet.value?.appliedFields, overrideApplied: coldSet.value?.overrideApplied },
      { width: 1280, height: 800, scale: 0.9, override: false });
      const navA = await harness.invoke('browser_navigate', { url: pageUrl }, execA);
      check('scope A 可打开 fixture', navA.ok === true, errorInfo(navA), { ok: true });
      await waitFor(async () => (await pageTruth(harness, execA))?.title === 'P0 Capture Fixture', { label: 'fixture title' });

      const runtimeA = runtimeFor(harness);
      const counterA = instrumentRuntime(runtimeA);

      const presetChecks = [];
      for (const [mode, size] of [['wide', [1920, 1080]], ['landscape', [1024, 768]], ['tablet', [768, 1024]], ['phone', [393, 852]]]) {
        const result = await setView({ mode }, execA);
        const observed = result.value?.observed || {};
        const truth = await pageTruth(harness, execA);
        presetChecks.push({
          mode,
          view: result.value?.view,
          expected: size,
          innerWidth: truth?.innerWidth,
          innerHeight: truth?.innerHeight,
        });
        check(`preset ${mode} → ${size[0]}×${size[1]}：view.mode 派生 + 页面 innerWidth/Height 一致`,
          result.ok === true && result.value?.view?.mode === mode
            && result.value.view.width === size[0] && result.value.view.height === size[1]
            && observed.width === size[0] && observed.height === size[1]
            && truth?.innerWidth === size[0] && truth?.innerHeight === size[1],
        presetChecks[presetChecks.length - 1], { mode, width: size[0], height: size[1] });
      }

      const custom = await setView({ width: 1280, height: 800 }, execA);
      check('1280×800 派生 mode=custom（不是预设）', custom.ok === true && custom.value?.view?.mode === 'custom',
        { mode: custom.value?.view?.mode }, { mode: 'custom' });

      // --- mode together with x/y/scale in ONE patch (task-7 regression) --------------------
      // The validator allows `mode` + `x`/`y`/`scale` (only `mode` + width/height conflicts), so a
      // preset must NOT drop the other fields when it expands to its width/height.
      const wide = await harness.invoke('browser_eval', {
        expression: `(function () {
          if (!document.getElementById('vp-wide')) {
            const d = document.createElement('div');
            d.id = 'vp-wide';
            d.style.cssText = 'position:absolute;left:0;top:0;width:3000px;height:20px;background:#eee';
            document.body.appendChild(d);
          }
          return { scrollWidth: document.documentElement.scrollWidth };
        })()`,
      }, execA);
      check('注入 3000px 宽元素制造横向滚动（为 x 断言提供真值）',
        wide.value?.value?.scrollWidth >= 3000, wide.value?.value, { scrollWidth: '>=3000' });

      const combined = await setView({ mode: 'tablet', x: 40, scale: 0.5 }, execA);
      const tabletTruth = await pageTruth(harness, execA);
      check('mode+x+scale 同传：mode 展开为 768×1024，且 x/scale 未被丢弃（view.x=实测 40、scale=0.5）',
        combined.ok === true && combined.value?.view?.mode === 'tablet'
          && combined.value.view.width === 768 && combined.value.view.height === 1024
          && combined.value.view.scale === 0.5
          && combined.value.view.x === 40 && combined.value.observed?.x === 40
          && tabletTruth?.scrollX === 40 && tabletTruth?.innerWidth === 768,
      { view: combined.value?.view, observed: combined.value?.observed, truth: { scrollX: tabletTruth?.scrollX, innerWidth: tabletTruth?.innerWidth } },
      { width: 768, height: 1024, scale: 0.5, x: 40 });
      check('mode+x+scale 的 appliedFields 同时含 width/height/x/scale',
        ['width', 'height', 'x', 'scale'].every((field) => combined.value?.appliedFields?.includes(field)),
      combined.value?.appliedFields, ['width', 'height', 'x', 'scale']);

      const phoneScale = await setView({ mode: 'phone', scale: 0.65 }, execA);
      const phoneTruth = await pageTruth(harness, execA);
      check('mode+scale（未给 x/y）：scale 保留 0.65，x/y 不被重置（x 仍 40 且与页面一致）',
        phoneScale.ok === true && phoneScale.value?.view?.mode === 'phone'
          && phoneScale.value.view.width === 393 && phoneScale.value.view.height === 852
          && phoneScale.value.view.scale === 0.65
          && phoneScale.value.view.x === phoneTruth?.scrollX && phoneTruth?.scrollX === 40
          && phoneScale.value.view.y === phoneTruth?.scrollY,
      { view: phoneScale.value?.view, truth: { scrollX: phoneTruth?.scrollX, scrollY: phoneTruth?.scrollY } },
      { width: 393, height: 852, scale: 0.65, x: 40 });

      const v1Mode = await harness.request({
        method: 'POST', path: '/plugins/ui-testing/viewport', body: { version: 1, mode: 'tablet', scale: 0.7 },
      });
      check('HTTP v1 mode+scale 同传同样保留 scale（走同一个 expandViewPatch）',
        v1Mode.statusCode === 200 && v1Mode.json?.view?.mode === 'tablet'
          && v1Mode.json.view.width === 768 && v1Mode.json.view.height === 1024
          && v1Mode.json.view.scale === 0.7,
      { status: v1Mode.statusCode, view: v1Mode.json?.view }, { mode: 'tablet', width: 768, height: 1024, scale: 0.7 });

      // Leave the page as the later probes expect it: no wide element, x back to 0.
      await harness.invoke('browser_eval', {
        expression: "(function () { const d = document.getElementById('vp-wide'); if (d) d.remove(); return true; })()",
      }, execA);
      const resetX = await setView({ x: 0 }, execA);
      check('清理横向滚动源并复位 x=0（供后续探针）',
        resetX.ok === true && resetX.value?.view?.x === 0, resetX.value?.view, { x: 0 });

      // State-relative: whatever the current size/position is, a scale-only patch must keep it.
      const beforePartial = (await getView(execA)).value?.view;
      const partial = await setView({ scale: 0.75 }, execA);
      check('partial patch（只给 scale）保留 width/height/x/y 与 mode',
        partial.ok === true
          && partial.value?.view?.width === beforePartial?.width && partial.value?.view?.height === beforePartial?.height
          && partial.value?.view?.x === beforePartial?.x && partial.value?.view?.y === beforePartial?.y
          && partial.value?.view?.mode === beforePartial?.mode
          && partial.value.view.scale === 0.75,
      { before: beforePartial, after: partial.value?.view }, { unchangedExceptScale: true, scale: 0.75 });

      const revisionBefore = partial.value?.view?.revision;
      const sameValue = await setView({
        width: partial.value.view.width, height: partial.value.view.height, scale: 0.75,
      }, execA);
      check('same-value set 不增 revision（同值不冒充新版本）',
        sameValue.ok === true && sameValue.value?.view?.revision === revisionBefore,
      { before: revisionBefore, after: sameValue.value?.view?.revision }, { revision: revisionBefore });

      // --- two scopes in ONE plugin instance ------------------------------------------------
      const aBeforeB = (await getView(execA)).value?.view;
      const navB = await harness.invoke('browser_navigate', { url: pageUrl }, execB);
      check('scope B（另一工作区）可独立打开 fixture', navB.ok === true, errorInfo(navB), { ok: true });
      const setB = await setView({ width: 640, height: 480, scale: 0.5 }, execB);
      const getA = await getView(execA);
      const getB = await getView(execB);
      check('两个 scope 的 view 互相独立（B 改尺寸/比例不影响 A）',
        setB.ok === true
          && getB.value?.view?.width === 640 && getB.value?.view?.height === 480 && getB.value?.view?.scale === 0.5
          && getA.value?.view?.width === aBeforeB?.width && getA.value?.view?.height === aBeforeB?.height
          && getA.value?.view?.scale === aBeforeB?.scale
          && getA.value?.viewMeta?.runtimeId !== getB.value?.viewMeta?.runtimeId,
      { A: getA.value?.view, ABefore: aBeforeB, B: getB.value?.view }, { A: 'unchanged', B: '640×480@0.5' });

      // --- invalid pre-flight: zero CDP, zero side effect ----------------------------------
      const truthBefore = await pageTruth(harness, execA);
      const revisionA = (await getView(execA)).value?.view?.revision;
      counterA.reset();
      const invalidCases = [
        ['scale=NaN', { scale: Number.NaN }],
        ['scale 字符串', { scale: '1' }],
        ['scale 超上界 2.5', { scale: 2.5 }],
        ['scale 低于 0.1', { scale: 0.05 }],
        ['width 小数', { width: 800.5 }],
        ['width 字符串', { width: '800' }],
        ['width 越界 199', { width: 199 }],
        ['height 越界 4097', { height: 4097 }],
        ['x 负数', { x: -1 }],
        ['y 非有限', { y: Number.POSITIVE_INFINITY }],
        ['空 patch', {}],
        ['mode+width 冲突', { mode: 'phone', width: 800 }],
        ['mode 非法', { mode: 'custom' }],
        ['未知字段', { width: 800, zoom: 2 }],
        ['expectedRevision 负数', { width: 800, expectedRevision: -1 }],
        ['expectedRevision 小数', { width: 800, expectedRevision: 1.5 }],
      ];
      const invalidResults = [];
      for (const [label, patch] of invalidCases) {
        const result = await setView(patch, execA);
        invalidResults.push({ label, ok: result.ok, code: result.error?.code, category: result.error?.category });
      }
      check('全部非法 patch → INVALID_ARGUMENT/input 且不可重试',
        invalidResults.every((item) => item.code === 'INVALID_ARGUMENT' && item.category === 'input'),
      invalidResults.filter((item) => item.code !== 'INVALID_ARGUMENT'), 'INVALID_ARGUMENT × 16');
      check('非法预检零 CDP（runtime.send 调用数 = 0，含 setDeviceMetricsOverride）',
        counterA.total() === 0, { sends: counterA.counts.calls }, { sends: {} });
      const truthAfter = await pageTruth(harness, execA);
      check('非法预检不改页面几何/view（innerWidth/scroll/rect 与 revision 均不变）',
        JSON.stringify(truthAfter) === JSON.stringify(truthBefore)
          && (await getView(execA)).value?.view?.revision === revisionA,
      { truthBefore, truthAfter }, 'unchanged');

      const badGet = await harness.invoke('browser_viewport', { action: 'get', width: 800 }, execA);
      check('action=get 带其他字段 → INVALID_ARGUMENT', hasErrorCode(badGet, 'INVALID_ARGUMENT'), errorInfo(badGet), 'INVALID_ARGUMENT');
      const badAction = await harness.invoke('browser_viewport', { action: 'reset' }, execA);
      check('action 非法 → INVALID_ARGUMENT', hasErrorCode(badAction, 'INVALID_ARGUMENT'), errorInfo(badAction), 'INVALID_ARGUMENT');
      const lossless = losslessProblem((await getView(execA)).value);
      check('get 返回值是 lossless JSON（无 undefined/function/Buffer）', lossless === null, { problem: lossless }, null);
    });

  /* ---------------------------------------------------------------- V4: scale-only keeps layout */
  await runProbe('V4-scale-only', '仅改显示比例不改页面几何（innerWidth/DPR/visualViewport.scale/DOMRect）',
    '800×600 下 scale 0.65→1→2：innerWidth/innerHeight/DPR/visualViewport.scale/固定元素 rect 全部不变，且不发送 setDeviceMetricsOverride', async () => {
      const counterA = instrumentRuntime(runtimeFor(harness));
      const base = await setView({ width: 800, height: 600 }, execA);
      check('基准 800×600 view/observed 一致', base.ok === true
        && base.value?.view?.width === 800 && base.value?.view?.height === 600
        && base.value?.observed?.width === 800 && base.value?.observed?.height === 600,
      { view: base.value?.view, observed: base.value?.observed }, { width: 800, height: 600 });
      const truth0 = await pageTruth(harness, execA);

      const scaleResults = [];
      for (const scale of [0.65, 1, 2]) {
        counterA.reset();
        const result = await setView({ scale }, execA);
        const truth = await pageTruth(harness, execA);
        scaleResults.push({
          scale,
          view: result.value?.view,
          overrideSent: counterA.count('Emulation.setDeviceMetricsOverride'),
          innerWidth: truth?.innerWidth,
          innerHeight: truth?.innerHeight,
          dpr: truth?.dpr,
          visualViewportScale: truth?.visualViewportScale,
          red: truth?.red,
          fixed: truth?.fixed,
        });
        check(`scale=${scale}：view.scale 生效且 overrideApplied=false`,
          result.ok === true && result.value?.view?.scale === scale && result.value?.overrideApplied === false,
        scaleResults[scaleResults.length - 1], { scale, overrideApplied: false });
        check(`scale=${scale}：0 次 Emulation.setDeviceMetricsOverride`,
          counterA.count('Emulation.setDeviceMetricsOverride') === 0,
          { sends: counterA.counts.calls }, { override: 0 });
        check(`scale=${scale}：innerWidth/innerHeight/DPR/visualViewport.scale 与基准一致`,
          truth?.innerWidth === truth0?.innerWidth && truth?.innerHeight === truth0?.innerHeight
            && truth?.dpr === truth0?.dpr && truth?.visualViewportScale === truth0?.visualViewportScale,
        { baseline: { w: truth0?.innerWidth, h: truth0?.innerHeight, dpr: truth0?.dpr, vvs: truth0?.visualViewportScale }, now: { w: truth?.innerWidth, h: truth?.innerHeight, dpr: truth?.dpr, vvs: truth?.visualViewportScale } },
        'unchanged');
        check(`scale=${scale}：固定目标 DOMRect 不变（#cap-red / #cap-fixed）`,
          JSON.stringify(truth?.red) === JSON.stringify(truth0?.red)
            && JSON.stringify(truth?.fixed) === JSON.stringify(truth0?.fixed),
        { before: { red: truth0?.red, fixed: truth0?.fixed }, after: { red: truth?.red, fixed: truth?.fixed } }, 'unchanged');
      }
      finding('V4-layout', 'info', '仅改显示比例时页面 CSS 视口、DPR、visualViewport.scale 与固定元素 rect 均未变化，且没有向 CDP 发送 metrics override。');
    });

  /* ---------------------------------------------------------------- V5: x/y measured + clamp */
  await runProbe('V5-scroll', 'x/y 实测、clamp、仅改一轴保另一轴、resize 后 clamp',
    'body 2600px 文档：set y=120 后页面 scrollY 与 observed.y 一致；超范围 clamp=true 且回实际值；只给 x 保留现场 y；resize 后实际位置被浏览器约束并如实回报', async () => {
      await setView({ width: 800, height: 600 }, execA);
      const scrolled = await setView({ x: 0, y: 120 }, execA);
      const truth1 = await pageTruth(harness, execA);
      check('set y=120：view.y/observed.y/页面 scrollY 三方一致',
        scrolled.ok === true && scrolled.value?.view?.y === 120 && scrolled.value?.observed?.y === 120
          && truth1?.scrollY === 120 && scrolled.value?.clamped?.y === false && scrolled.value?.settled === true,
      { view: scrolled.value?.view, observed: scrolled.value?.observed, clamped: scrolled.value?.clamped, scrollY: truth1?.scrollY, settled: scrolled.value?.settled },
      { y: 120, scrollY: 120, clamped: false });

      const clamped = await setView({ y: 999999 }, execA);
      const truth2 = await pageTruth(harness, execA);
      const maxScroll = (truth2?.docHeight ?? 0) - (truth2?.innerHeight ?? 0);
      check('超文档范围 y=999999：clamped.y=true 且 view.y/observed.y 回实际 clamp 值（=docHeight-innerHeight）',
        clamped.ok === true && clamped.value?.clamped?.y === true
          && clamped.value?.view?.y === truth2?.scrollY
          && Math.abs((clamped.value?.view?.y ?? -1) - maxScroll) <= 1,
      { clamped: clamped.value?.clamped, viewY: clamped.value?.view?.y, observedY: clamped.value?.observed?.y, scrollY: truth2?.scrollY, maxScroll }, { clamped: true, clampedTo: maxScroll });

      const onlyY = await setView({ y: 40 }, execA);
      const truth3 = await pageTruth(harness, execA);
      check('只给 y=40：x 保留现场值 0（不隐式重置另一轴）',
        onlyY.ok === true && onlyY.value?.view?.x === 0 && onlyY.value?.view?.y === 40 && truth3?.scrollY === 40 && truth3?.scrollX === 0,
      { view: onlyY.value?.view, scrollX: truth3?.scrollX, scrollY: truth3?.scrollY }, { x: 0, y: 40 });

      const resized = await setView({ width: 640, height: 500 }, execA);
      const truth4 = await pageTruth(harness, execA);
      const maxAfter = (truth4?.docHeight ?? 0) - (truth4?.innerHeight ?? 0);
      check('resize 到 640×500：实际 scrollY 被浏览器约束并如实回报（view.y=observed.y=scrollY≤maxScroll）',
        resized.ok === true && resized.value?.view?.y === resized.value?.observed?.y
          && resized.value.view.y === truth4?.scrollY && resized.value.view.y <= maxAfter + 0.01,
      { view: resized.value?.view, observed: resized.value?.observed, scrollY: truth4?.scrollY, maxAfter }, 'measured, not requested');
      const observation = resized.value?.observed;
      check('observed 记录 x/y/尺寸/contentSize/DPR/visualViewportScale 与来源',
        observation?.source === 'Page.getLayoutMetrics'
          && Number.isFinite(observation.width) && Number.isFinite(observation.contentHeight)
          && observation.pageDevicePixelRatio === 1 && observation.visualViewportScale === 1,
      observation, 'Page.getLayoutMetrics projection');
    });

  /* ---------------------------------------------------------------- H4b: live scroll echo */
  await runProbe('H4b-scroll-echo', '页面/面板滚动后的 X/Y 实时观测（合并节流读回，静置零读）',
    '页面脚本 scrollTo 与连续 rAF 滚动后 ≤1.5s 内 /state 的 ui.observed.x/y 等于页面 scrollX/Y、view.y 同步、source=page、revision 递增；面板 /input 滚轮后同样刷新；同值不再增 revision；无请求静置 1s 不产生 Page.getLayoutMetrics 读', async () => {
      // /state 的 ui.* 只在已认证同源 GUI 响应里出现：H4b 断言的是 Client 实际读到的投影。
      const connection = ownerConnection();
      harness.setConnection(connection);
      try {
        // Drive the legacy:default scope: an UNscoped /state reads that very runtime, so the
        // authenticated `ui.observed` asserted below belongs to the page that was scrolled.
        await harness.invoke('browser_navigate', { url: pageUrl });
        const base = await harness.invoke('browser_viewport', { action: 'set', width: 800, height: 600 });
        check('基准页面 800×600 就绪', base.ok === true && base.value?.view?.width === 800, errorInfo(base), { ok: true, width: 800 });
        const runtime = runtimeFor(harness, 'legacy:default');
        const counter = instrumentRuntime(runtime);
        const readState = readStateRaw;

        // --- idle: no request, no action → no metrics read at all ------------------------
        await sleep(350);                    // drain what the set/导航 left behind
        const baselineState = await readState();
        check('基准缓存已就绪（ui.observed 非 null 且为 800×600）',
          baselineState?.ui?.observed?.width === 800 && baselineState?.ui?.observed?.height === 600,
        { observed: baselineState?.ui?.observed, view: baselineState?.view }, { width: 800, height: 600 });
        await sleep(400);                    // let the read armed by that /state finish
        counter.reset();
        await sleep(1000);                   // absolutely no request, no action
        check('无请求静置 1s 不产生 Page.getLayoutMetrics 读（不设常驻 5Hz timer）',
          counter.count('Page.getLayoutMetrics') === 0,
        { reads: counter.counts.calls }, { 'Page.getLayoutMetrics': 0 });

        // --- page-initiated scrollTo ------------------------------------------------------
        const revisionBefore = (await readStateQuiet()).view?.revision;
        await harness.invoke('browser_eval', { expression: 'window.scrollTo(0, 300); "ok"' });
        const scrolled = await waitFor(async () => {
          const state = await readState();
          return state?.ui?.observed?.y === 300 ? state : null;
        }, { timeoutMs: 1500, intervalMs: 80, label: '/state 观察到 scrollY=300' });
        const truthScript = (await harness.invoke('browser_eval', { expression: '({x: window.scrollX, y: window.scrollY})' })).value?.value;
        check('页面脚本 scrollTo(0,300) 后 ≤1.5s：ui.observed.x/y 与页面 scrollX/Y 一致',
          scrolled?.ui?.observed?.x === truthScript?.x && scrolled?.ui?.observed?.y === truthScript?.y
            && scrolled?.ui?.observed?.y === 300,
        { observed: scrolled?.ui?.observed, truth: truthScript }, { x: 0, y: 300 });
        check('同步写回 view.x/y，source=page 且 revision 递增（页面滚动是内容变更）',
          scrolled?.view?.y === 300 && scrolled?.view?.x === 0 && scrolled?.view?.source === 'page'
            && scrolled?.view?.revision === revisionBefore + 1,
        { view: scrolled?.view, before: revisionBefore }, { y: 300, source: 'page', revision: 'before+1' });
        check('viewMeta 为新鲜观测（stale=false，observedAt 为数字）',
          scrolled?.ui?.viewMeta?.stale === false && Number.isFinite(scrolled?.ui?.viewMeta?.observedAt),
        scrolled?.ui?.viewMeta, { stale: false });

        // --- same value: polling must not bump the revision -------------------------------
        const sameRevision = scrolled?.view?.revision;
        await readState();
        await sleepForObservation();
        const same = await readState();
        check('同值观测不增 revision（轮询不伪造新版本）', same?.view?.revision === sameRevision,
          { before: sameRevision, after: same?.view?.revision }, { revision: sameRevision });

        // --- continuous rAF/interval scrolling --------------------------------------------
        await harness.invoke('browser_eval', { expression: 'window.scrollTo(0, 0); "ok"' });
        await sleep(120);
        const revisionBeforeRaf = (await readStateQuiet()).view?.revision;
        await harness.invoke('browser_eval', {
          expression: 'new Promise((resolve) => { let n = 0; const t = setInterval(() => { window.scrollBy(0, 50); if (++n >= 8) { clearInterval(t); resolve(true); } }, 16); })',
        });
        const rafTruth = (await harness.invoke('browser_eval', { expression: '({x: window.scrollX, y: window.scrollY})' })).value?.value;
        const raf = await waitFor(async () => {
          const state = await readState();
          return state?.ui?.observed?.y === rafTruth?.y ? state : null;
        }, { timeoutMs: 1500, intervalMs: 80, label: `连续滚动后 observed.y=${rafTruth?.y}` });
        check('连续滚动（8×50px over rAF/interval）后 ≤1.5s：observed.y = 页面最终 scrollY，且 revision 继续递增',
          raf?.ui?.observed?.y === rafTruth?.y && raf?.view?.y === rafTruth?.y
            && raf?.view?.revision > revisionBeforeRaf && raf?.view?.source === 'page',
        { observed: raf?.ui?.observed, view: raf?.view, truth: rafTruth, before: revisionBeforeRaf }, { observedY: rafTruth?.y, source: 'page' });

        // --- panel /input (wheel) ---------------------------------------------------------
        await harness.invoke('browser_eval', { expression: 'window.scrollTo(0, 0); "ok"' });
        await sleep(120);
        await readStateQuiet();
        const inputRuntime = (await readState())?.ui?.runtimeId;
        const inputHeaders = inputRuntime
          ? { 'x-ui-testing-scope-version': '1', 'x-ui-testing-scope-binding': inputRuntime }
          : scopedHeadersA;
        const busyInput = await harness.request({
          method: 'POST', path: '/plugins/ui-testing/input', headers: inputHeaders,
          body: { events: [{ kind: 'wheel', type: 'mouseWheel', x: 200, y: 200, deltaX: 0, deltaY: 200, button: 'none' }] },
        });
        check('P0-E: 页面工具 lease 下 GUI /input 返回 409 BUSY（不派发）',
          busyInput.statusCode === 409 && busyInput.json?.code === 'BUSY',
          { status: 409, code: 'BUSY' }, { status: busyInput.statusCode, body: busyInput.json });
        // Release the Agent lease by waiting for its bounded idle hold; the same page must then
        // accept the GUI wheel. This keeps BUSY strict instead of bypassing the guard.
        await sleep(15500);
        const inputResponse = await harness.request({
          method: 'POST', path: '/plugins/ui-testing/input', headers: inputHeaders,
          body: { events: [{ kind: 'wheel', type: 'mouseWheel', x: 200, y: 200, deltaX: 0, deltaY: 200, button: 'none' }] },
        });
        check('/input 滚轮派发成功（lease 释放后）', inputResponse.statusCode === 200 && inputResponse.json?.applied === 1,
          { status: inputResponse.statusCode, body: inputResponse.json }, { status: 200, applied: 1 });
        // The wheel is asynchronous from the caller's point of view: converge on the observed value
        // and compare it with the page's own scroll position read in the same iteration.
        const afterInput = await waitFor(async () => {
          const state = await readState();
          const truth = (await harness.invoke('browser_eval', { expression: '({x: window.scrollX, y: window.scrollY})' })).value?.value;
          if (!state || !truth || !(truth.y > 0)) return null;
          return state?.ui?.observed?.y === truth.y && state?.view?.y === truth.y ? { state, truth } : null;
        }, { timeoutMs: 2500, intervalMs: 100, label: '/input 后 ui.observed 回显页面 scrollY' });
        check('面板 /input 滚轮后（50ms/250ms 合并采样）：ui.observed.y = 页面 scrollY > 0，view.source=page',
          afterInput?.state?.ui?.observed?.y === afterInput?.truth?.y && afterInput?.truth?.y > 0
            && afterInput?.state?.view?.y === afterInput?.truth?.y
            && afterInput?.state?.view?.source === 'page',
        { observed: afterInput?.state?.ui?.observed, view: afterInput?.state?.view, truth: afterInput?.truth }, { observedY: 'page scrollY', source: 'page' });

        // --- a failed/absent page must not invent a position -------------------------------
        const lossless = losslessProblem(afterInput?.state?.ui?.observed ?? {});
        check('观测投影仍是 lossless JSON', lossless === null, { problem: lossless }, null);
      } finally {
        harness.setConnection(undefined);
      }
    });

  /* ---------------------------------------------------------------- V6: CAS + BUSY */
  await runProbe('V6-conflict-busy', 'expectedRevision CAS、BUSY、其他 owner 下 get 仍可读',
    '同一 expectedRevision 的两次并发 patch 只有一个成功、另一个 VIEWPORT_CONFLICT（state/retryable）且零应用；其他会话 set BUSY；BUSY 下 get 仍可读；冲突不覆盖 lastError', async () => {
      await setView({ width: 800, height: 600 }, execA);
      const current = (await getView(execA)).value?.view?.revision;
      const [first, second] = await Promise.all([
        harness.invoke('browser_viewport', { action: 'set', width: 900, expectedRevision: current }, execA),
        harness.invoke('browser_viewport', { action: 'set', width: 1000, expectedRevision: current }, execA),
      ]);
      const winner = first.ok ? first : second;
      const loser = first.ok ? second : first;
      const conflictDetails = loser.error?.details || {};
      check('并发同 expectedRevision：一个成功、另一个 VIEWPORT_CONFLICT',
        winner.ok === true && hasErrorCode(loser, 'VIEWPORT_CONFLICT'),
      { winner: winner.value?.view, loser: errorInfo(loser) }, { oneSuccess: true, otherConflict: 'VIEWPORT_CONFLICT' });
      check('VIEWPORT_CONFLICT 分类 state/retryable=true，details 带 expected/actual/view',
        loser.error?.category === 'state' && loser.error?.retryable === true
          && conflictDetails.expected === current && Number.isSafeInteger(conflictDetails.actual)
          && conflictDetails.view && conflictDetails.view.width === winner.value?.view?.width,
      { category: loser.error?.category, retryable: loser.error?.retryable, details: conflictDetails }, { category: 'state', retryable: true });
      const afterConflict = (await getView(execA)).value?.view;
      check('冲突 patch 零应用（最终宽度 = 成功那次的宽度）',
        afterConflict?.width === winner.value?.view?.width, { final: afterConflict?.width, winner: winner.value?.view?.width }, winner.value?.view?.width);

      // BUSY: another session in the SAME workspace while A holds the lease.
      const busySet = await setView({ width: 700 }, execOther);
      check('其他会话 set → BUSY/concurrency/retryable',
        hasErrorCode(busySet, 'BUSY') && busySet.error?.category === 'concurrency' && busySet.error?.retryable === true,
      errorInfo(busySet), { code: 'BUSY', category: 'concurrency' });
      const busyGet = await getView(execOther);
      check('其他 owner 持租约时 get 仍可只读诊断（不 BUSY）',
        busyGet.ok === true && busyGet.value?.view?.width === winner.value?.view?.width,
      { ok: busyGet.ok, view: busyGet.value?.view }, { ok: true });

      const errorState = (await harness.invoke('browser_state', {}, execA)).value;
      check('VIEWPORT_CONFLICT/BUSY 不覆盖页面 lastError（保持空）',
        typeof errorState?.error === 'string' && errorState.error === '',
      { error: errorState?.error }, '');
    });

  /* ---------------------------------------------------------------- V7: HTTP compat */
  await runProbe('V7-http', '旧 POST /viewport 兼容 + v1 严格校验 + ui.view/viewMeta/observed 投影',
    'legacy {width:"1000",height:700.6} 保持 Number/round/clamp 且返回 viewport、不改 scale；v1 严格校验并按 view 回报；/state 与 /frame pending 均带 ui.view/ui.viewMeta/ui.observed；未认证只剩脱敏 state', async () => {
      // The legacy/scoped HTTP surfaces address their own scope: the unscoped legacy POST talks to
      // `legacy:default`, so the scale that must survive is the one set on legacy:default.
      const legacySetup = await setView({ width: 800, height: 600, scale: 0.8 });
      check('legacy:default scope 可设置 scale=0.8（供旧 POST 兼容断言）',
        legacySetup.ok === true && legacySetup.value?.view?.scale === 0.8,
      { view: legacySetup.value?.view }, { scale: 0.8 });
      const legacy = await harness.request({
        method: 'POST', path: '/plugins/ui-testing/viewport', body: { width: '1000', height: 700.6 },
      });
      const legacyJson = legacy.json || {};
      check('legacy POST 字符串/小数 → 200 且 round 到 1000×701，viewport 字段保留',
        legacy.statusCode === 200 && legacyJson.ok === true && legacyJson.viewport?.width === 1000 && legacyJson.viewport?.height === 701,
      { statusCode: legacy.statusCode, viewport: legacyJson.viewport }, { statusCode: 200, viewport: { width: 1000, height: 701 } });
      check('legacy POST 保留 scale（不把缺省当重置）', legacyJson.view?.scale === 0.8,
        { scale: legacyJson.view?.scale }, { scale: 0.8 });
      check('legacy POST 保留 x/y（只改宽高）', Number.isFinite(legacyJson.view?.x) && Number.isFinite(legacyJson.view?.y),
        { x: legacyJson.view?.x, y: legacyJson.view?.y }, 'finite x/y');
      const legacyClamp = await harness.request({
        method: 'POST', path: '/plugins/ui-testing/viewport', body: { width: 10, height: 99999 },
      });
      check('legacy POST 越界仍 clamp 到 200–4096',
        legacyClamp.json?.viewport?.width === 200 && legacyClamp.json?.viewport?.height === 4096,
      legacyClamp.json?.viewport, { width: 200, height: 4096 });
      const legacyBad = await harness.request({
        method: 'POST', path: '/plugins/ui-testing/viewport', body: { width: 'abc', height: 600 },
      });
      check('legacy POST 非数字仍 INVALID_ARGUMENT（错误码不变）',
        legacyBad.json?.code === 'INVALID_ARGUMENT', { status: legacyBad.statusCode, body: legacyBad.json }, 'INVALID_ARGUMENT');

      const v1 = await harness.request({
        method: 'POST', path: '/plugins/ui-testing/viewport',
        body: { version: 1, width: 900, height: 620, scale: 0.5, originId: 'panel-a' },
      });
      check('v1 POST 严格应用 patch 并返回 view/observed/viewMeta/requested/clamped/applied/settled/state',
        v1.statusCode === 200 && v1.json?.view?.width === 900 && v1.json?.view?.height === 620
          && v1.json?.view?.scale === 0.5 && v1.json?.viewMeta?.originId === 'panel-a'
          && v1.json?.viewMeta?.stale === false && v1.json?.observed?.width === 900
          && v1.json?.applied === true && typeof v1.json?.settled === 'boolean'
          && v1.json?.clamped?.x === false && v1.json?.state?.view?.width === 900,
      { status: v1.statusCode, view: v1.json?.view, viewMeta: v1.json?.viewMeta, observed: v1.json?.observed, applied: v1.json?.applied }, 'v1 rich reply');
      const v1Bad = await harness.request({
        method: 'POST', path: '/plugins/ui-testing/viewport', body: { version: 1, width: 800.5 },
      });
      check('v1 POST 严格校验（小数宽 → INVALID_ARGUMENT）', v1Bad.json?.code === 'INVALID_ARGUMENT',
        { status: v1Bad.statusCode, body: v1Bad.json }, 'INVALID_ARGUMENT');
      const v1Unknown = await harness.request({
        method: 'POST', path: '/plugins/ui-testing/viewport', body: { version: 1, width: 800, zoom: 2 },
      });
      check('v1 POST 拒绝未知字段（additionalProperties 等价）', v1Unknown.json?.code === 'INVALID_ARGUMENT',
        { body: v1Unknown.json }, 'INVALID_ARGUMENT');
      const v1BadVersion = await harness.request({ method: 'POST', path: '/plugins/ui-testing/viewport', body: { version: 2, width: 800 } });
      check('v1 POST version≠1 → INVALID_ARGUMENT', v1BadVersion.json?.code === 'INVALID_ARGUMENT', { body: v1BadVersion.json }, 'INVALID_ARGUMENT');

      const connection = harnessModule.createFakeConnectionService({ rejection: undefined });
      harness.setConnection(connection);
      try {
        const state = await harness.request({ method: 'GET', path: '/plugins/ui-testing/state' });
        check('已认证 /state 带 ui.view/ui.viewMeta/ui.observed（与顶层 view 同源）',
          state.json?.ui?.version === 1 && state.json?.ui?.view?.width === 900
            && state.json?.ui?.view?.scale === 0.5 && state.json?.ui?.viewMeta?.originId === 'panel-a'
            && state.json?.ui?.observed?.width === 900
            && state.json?.ui?.view?.revision === state.json?.view?.revision,
        { ui: state.json?.ui, topView: state.json?.view }, 'ui.view + ui.viewMeta + ui.observed');
        // `/frame` answers either shape (pending / image); both must carry the same `state` shape.
        const frame = await harness.request({ method: 'GET', path: '/plugins/ui-testing/frame' });
        const frameState = frame.json?.state;
        check('已认证 /frame（pending 与有帧两种分支）state 同形且都带 ui.view',
          (frame.json?.pending === true || typeof frame.json?.image === 'string')
            && frameState?.ui?.view?.width === 900 && frameState?.ui?.observed?.width === 900
            && frameState?.ui?.version === 1 && frameState?.view?.width === 900,
        { pending: frame.json?.pending ?? null, hasImage: typeof frame.json?.image === 'string', ui: frameState?.ui }, 'pending|image + ui.view');
      } finally {
        harness.setConnection(connection);
        connection.setRejection(undefined);
        connection.setAdmit(undefined);
      }

      const unauthenticated = harnessModule.createFakeConnectionService({ rejection: 401 });
      harness.setConnection(unauthenticated);
      try {
        const state = await harness.request({ method: 'GET', path: '/plugins/ui-testing/state' });
        check('未认证 /state 不返回 ui/原始地址（fail closed，只剩脱敏 state + view）',
          state.json?.ui === undefined && typeof state.json?.view?.width === 'number',
        { ui: state.json?.ui, view: state.json?.view }, { ui: undefined, view: 'safe projection' });
        const scopedViewport = await harness.request({
          method: 'POST', path: '/plugins/ui-testing/viewport',
          headers: { 'x-ui-testing-scope-version': '1', 'x-ui-testing-session-id': 'vp-a' },
          body: { version: 1, width: 800 },
        });
        check('scoped 写路由未通过 owner-only 鉴权时 401 且零应用',
          scopedViewport.statusCode === 401, { status: scopedViewport.statusCode, body: scopedViewport.json }, { status: 401 });
      } finally {
        harness.setConnection(undefined);
      }
    });

  /* ---------------------------------------------------------------- V8: capture scale */
  await runProbe('V8-capture-scale', '截图默认比例/显式 scale/映射/低比例空输出/16M 预算',
    '800×600@0.65 默认 520×390；显式 1=800×600、2=1600×1200；PNG IHDR/CRC/文件字节/base64 同源；mapping 逐轴 cssPerPixel；scale=0.1 的 1px region 提前拒绝；4096²@1 超 16M 拒绝但 view 仍可设置', async () => {
      await setView({ width: 800, height: 600, scale: 0.65 }, execA);
      const defaultShot = await harness.invoke('browser_screenshot', {}, execA);
      const defaultValue = defaultShot.value || {};
      const defaultBytes = Buffer.from(String(defaultValue.image || ''), 'base64');
      const defaultPng = inspectPng(defaultBytes, { checkCrc: true });
      check('默认截图 = round(800×0.65)=520×390（view.scale 作为默认比例）',
        defaultShot.ok === true && defaultValue.capture?.request?.scale === 0.65
          && defaultValue.capture?.request?.scaleSource === 'view'
          && Number.isInteger(defaultValue.capture?.request?.viewRevision)
          && defaultPng.ok && defaultPng.width === 520 && defaultPng.height === 390,
      { request: defaultValue.capture?.request, png: defaultPng.ok ? { w: defaultPng.width, h: defaultPng.height } : defaultPng }, { scale: 0.65, scaleSource: 'view', size: [520, 390] });
      check('默认截图 mapping：imagePixels=520×390、nominal 0.65、逐轴 cssPerPixel=800/520',
        defaultValue.capture?.mapping?.imagePixels?.width === 520
          && defaultValue.capture?.mapping?.imagePixels?.height === 390
          && Math.abs((defaultValue.capture?.mapping?.pixelsPerCssPixel ?? 0) - 0.65) < 1e-9
          && Math.abs((defaultValue.capture?.mapping?.cssPerPixel?.x ?? 0) - (800 / 520)) < 1e-9
          && Math.abs((defaultValue.capture?.mapping?.cssPerPixel?.y ?? 0) - (600 / 390)) < 1e-9
          && defaultValue.capture?.mapping?.scrollAtCapture?.x === 0,
      { mapping: defaultValue.capture?.mapping }, 'per-axis mapping');
      const defaultFile = defaultValue.capture?.file;
      const defaultFileAbsolute = defaultFile?.pathKind === 'relative'
        ? join(state.captureRoot, defaultFile.path) : defaultFile?.path;
      check('默认截图 base64 与落盘文件同一份字节（sha256 三方一致）',
        typeof defaultFileAbsolute === 'string' && existsSync(defaultFileAbsolute)
          && sha256(await readFile(defaultFileAbsolute)) === sha256(defaultBytes)
          && defaultValue.sha256 === sha256(defaultBytes),
      { filePath: defaultFileAbsolute, pathKind: defaultFile?.pathKind, captureSha: defaultValue.sha256, byteSha: sha256(defaultBytes) }, 'same bytes');

      const explicit1 = await harness.invoke('browser_screenshot', { scale: 1 }, execA);
      const png1 = inspectPng(Buffer.from(String(explicit1.value?.image || ''), 'base64'), { checkCrc: true });
      check('显式 scale=1 → 800×600 原始逻辑尺寸，scaleSource=explicit',
        explicit1.ok === true && png1.ok && png1.width === 800 && png1.height === 600
          && explicit1.value?.capture?.request?.scaleSource === 'explicit',
      { png: png1.ok ? { w: png1.width, h: png1.height } : png1, request: explicit1.value?.capture?.request }, { size: [800, 600], scaleSource: 'explicit' });

      const explicit2 = await harness.invoke('browser_screenshot', { scale: 2 }, execA);
      const png2 = inspectPng(Buffer.from(String(explicit2.value?.image || ''), 'base64'), { checkCrc: true });
      check('显式 scale=2 → 1600×1200（高密度原始 PNG，不是位图放大声明）',
        explicit2.ok === true && png2.ok && png2.width === 1600 && png2.height === 1200
          && explicit2.value?.capture?.sizeCheck?.ok === true,
      { png: png2.ok ? { w: png2.width, h: png2.height } : png2 }, { size: [1600, 1200] });
      check('显式 scale 不改 view/DPR/滚动（view.scale 仍 0.65）',
        (await getView(execA)).value?.view?.scale === 0.65, (await getView(execA)).value?.view, { scale: 0.65 });

      const filesBefore = (await listFilesRecursive(state.captureRoot)).length;
      const empty = await harness.invoke('browser_screenshot', { scale: 0.1, region: { x: 0, y: 0, width: 1, height: 1 } }, execA);
      const filesAfter = (await listFilesRecursive(state.captureRoot)).length;
      check('scale=0.1 + 1px region 会舍入到 0 像素 → INVALID_ARGUMENT(empty-output-dimensions)，不写文件',
        hasErrorCode(empty, 'INVALID_ARGUMENT') && empty.error?.details?.reason === 'empty-output-dimensions'
          && filesAfter === filesBefore,
      { error: errorInfo(empty), filesBefore, filesAfter }, { code: 'INVALID_ARGUMENT', reason: 'empty-output-dimensions' });

      const tooBig = await harness.invoke('browser_screenshot', { scale: 4 }, execA);
      check('800×600@4 = 3200×2400（12.8M）仍在 16M 预算内',
        tooBig.ok === true, errorInfo(tooBig), { ok: true });
      const bigView = await setView({ width: 4096, height: 4096 }, execA);
      check('4096×4096 view 可以设置（set 不承诺之后截图必成功）',
        bigView.ok === true && bigView.value?.view?.width === 4096, { view: bigView.value?.view }, { width: 4096 });
      const overBudget = await harness.invoke('browser_screenshot', { scale: 1 }, execA);
      check('4096×4096@1 超过 16M 像素 → CAPTURE_TOO_LARGE（错误语义不变）',
        hasErrorCode(overBudget, 'CAPTURE_TOO_LARGE'), errorInfo(overBudget), 'CAPTURE_TOO_LARGE');
      await setView({ width: 800, height: 600 }, execA);
    });

  /* ---------------------------------------------------------------- V9: T3 live default + frozen act */
  await runProbe('V9-t3-live', 'T3 live 缺省跟随 view.scale、显式覆盖、act 冻结原采集比例',
    'live 省略 scale → capture.request.scaleSource=view 且 scale=view.scale；显式 1 → explicit；改 view.scale 后旧 product 的 act 仍按原比例重采样（不因比例变化 stale）', async () => {
      await harness.invoke('browser_navigate', { url: new URL('/web-t3.html', state.fixture.url).href }, execA);
      await waitFor(async () => (await pageTruth(harness, execA))?.title?.length > 0, { label: 't3 fixture title' });
      await setView({ width: 800, height: 600, scale: 0.5 }, execA);
      const region = { x: 0, y: 0, width: 200, height: 100 };

      const liveDefault = await harness.invoke('browser_vision_image', { source: { kind: 'live', region } }, execA);
      const defaultRequest = liveDefault.value?.evidence?.vision?.source?.[0]?.capture?.request;
      check('live 省略 scale → 跟随 view.scale（0.5）、scaleSource=view、记录 viewRevision',
        liveDefault.ok === true && defaultRequest?.scale === 0.5 && defaultRequest?.scaleSource === 'view'
          && Number.isInteger(defaultRequest?.viewRevision)
          && liveDefault.value?.product?.width === 100 && liveDefault.value?.product?.height === 50,
      { request: defaultRequest, product: liveDefault.value?.product }, { scale: 0.5, scaleSource: 'view', size: [100, 50] });

      const liveExplicit = await harness.invoke('browser_vision_image', { source: { kind: 'live', scale: 1, region } }, execA);
      const explicitRequest = liveExplicit.value?.evidence?.vision?.source?.[0]?.capture?.request;
      check('live 显式 scale=1 → scaleSource=explicit 且 product=200×100',
        liveExplicit.ok === true && explicitRequest?.scale === 1 && explicitRequest?.scaleSource === 'explicit'
          && liveExplicit.value?.product?.width === 200,
      { request: explicitRequest, product: liveExplicit.value?.product }, { scale: 1, scaleSource: 'explicit', width: 200 });

      // Change the shared display scale AFTER the capture: the product's frozen capture scale must
      // still be used by act's re-capture (a display-scale change does not move the page geometry).
      const scaleChange = await setView({ scale: 1.5 }, execA);
      check('采集后修改 view.scale（0.5→1.5）成功且不改页面几何',
        scaleChange.ok === true && scaleChange.value?.view?.scale === 1.5 && scaleChange.value?.overrideApplied === false,
      { view: scaleChange.value?.view, overrideApplied: scaleChange.value?.overrideApplied }, { scale: 1.5 });
      const act = await harness.invoke('browser_vision_act', {
        productId: liveExplicit.value?.product?.productId, action: 'click', point: { x: 10, y: 10 },
      }, execA);
      check('act 使用冻结的原采集比例重采样：改 view.scale 后仍可派发（不因比例变化 stale）',
        act.ok === true && act.value?.dispatched === true
          && act.value?.afterProduct?.width === 200
          && act.value?.dispatch?.eventSource === 'cdp-input',
      { dispatched: act.value?.dispatched, after: act.value?.afterProduct, error: act.error ? errorInfo(act) : null },
      { dispatched: true, afterWidth: 200 });
      const staleAct = await harness.invoke('browser_vision_act', {
        productId: liveExplicit.value?.product?.productId, action: 'click', point: { x: 10, y: 10 },
      }, execA);
      check('同一 product 30s 内可重复 act（未被 view.scale 变化误判 stale）',
        staleAct.ok === true || staleAct.error?.code === 'VISION_STALE_IMAGE',
      { ok: staleAct.ok, code: staleAct.error?.code }, 'ok（或仅按几何/时间判定 stale）');
      await setView({ width: 800, height: 600, scale: 0.65 }, execA);
    });

  /* ---------------------------------------------------------------- V10: ui projection/provenance + close */
  await runProbe('V10-ui-projection', 'viewMeta stale 语义、close 复位、lossless JSON',
    'observed 超过 1000ms 未刷新 → viewMeta.stale=true；close 后 x/y 复位 0、observed=null、revision 递增、width/height/scale 保留；set/get/state 投影全部 lossless JSON', async () => {
      await harness.invoke('browser_navigate', { url: pageUrl }, execA);
      await setView({ width: 800, height: 600, scale: 0.65, x: 0, y: 60 }, execA);
      // Drain the readback that the preceding page operations legitimately scheduled (the coalesced
      // observer is throttled to ≥200ms and this suite dispatches one per page operation). The H10
      // assertion below is "an idle second without refresh reports stale", not "an action-induced
      // sample must never land"; draining first keeps that assertion exact instead of relying on a
      // pending timer that would otherwise refresh observedAt mid-window.
      let drainedAt = null;
      for (let i = 0; i < 8; i += 1) {
        const observedAt = (await getView(execA)).value?.viewMeta?.observedAt ?? null;
        if (observedAt !== null && observedAt === drainedAt) break;
        drainedAt = observedAt;
        await sleep(150);
      }
      const fresh = (await getView(execA)).value;
      check('刚 set 后 viewMeta.stale=false 且 observedAt 为数字',
        fresh?.viewMeta?.stale === false && Number.isFinite(fresh?.viewMeta?.observedAt),
      fresh?.viewMeta, { stale: false });
      await sleep(1150);
      const stale = (await getView(execA)).value;
      check('超过 staleAfterMs(1000) 未刷新 → stale=true（缓存诊断如实过期）',
        stale?.viewMeta?.stale === true && stale?.viewMeta?.observedAt === fresh?.viewMeta?.observedAt,
      stale?.viewMeta, { stale: true });

      const beforeClose = stale?.view;
      // Scoped write routes are owner-only: admit() must return the browser's own peer.
      const ownerConnection = harnessModule.createFakeConnectionService({
        rejection: undefined,
        admit: () => ({ peer: { id: 'peer-owner' } }),
        browserPeer: { id: 'peer-owner' },
      });
      harness.setConnection(ownerConnection);
      let closeResponse;
      try {
        closeResponse = await harness.request({
          method: 'POST', path: '/plugins/ui-testing/close',
          headers: { 'x-ui-testing-scope-version': '1', 'x-ui-testing-session-id': 'vp-a' },
          body: {},
        });
      } finally {
        harness.setConnection(undefined);
      }
      check('scope A close 返回 200（owner-only 通过）', closeResponse.statusCode === 200,
        { status: closeResponse.statusCode, body: closeResponse.json }, { status: 200 });
      const afterClose = (await getView(execA)).value;
      check('close 后 x/y 复位 0、observed=null，width/height/scale 保留，revision 递增',
        afterClose?.view?.x === 0 && afterClose?.view?.y === 0 && afterClose?.observed === null
          && afterClose.view.width === beforeClose?.width && afterClose.view.height === beforeClose?.height
          && afterClose.view.scale === beforeClose?.scale
          && afterClose.view.revision === beforeClose?.revision + 1,
      { before: beforeClose, after: afterClose.view, observed: afterClose.observed }, 'reset position, keep config');

      const lossless = [
        ['get', (await getView(execA)).value],
        ['set', (await setView({ width: 700, height: 500, scale: 1 }, execA)).value],
        ['state', (await harness.invoke('browser_state', {}, execA)).value],
        ['capabilities', (await harness.invoke('browser_capabilities')).value],
      ].map(([name, value]) => ({ name, problem: losslessProblem(value) }));
      check('get/set/state/capabilities 投影均为 lossless JSON（无 undefined/function/Buffer/非有限数）',
        lossless.every((item) => item.problem === null), lossless.filter((item) => item.problem), 'no undefined');

      const contextAfterClose = await pageTruth(harness, execA);
      check('close 后再操作会懒启动新页面（running 恢复、view 配置沿用）',
        contextAfterClose !== null && (await getView(execA)).value?.running === true,
      { running: (await getView(execA)).value?.running }, { running: true });
    });

  /* ---------------------------------------------------------------- V11: canvas coordinates */
  await runProbe('V11-canvas', '画布坐标 C/S/O：canvas 增量字段、x/y 保留 O、自主滚动保留 O、导航/关闭复位、HTTP/state/capabilities 投影',
    '默认 C=0/O=0；canvasX=-100,canvasY=-50 → x=y=0、offset=-100/-50、页面 scroll=0；canvas 在内容内 → scroll 对齐 O=0；超过 max → offset>0；CAS/范围/类型/与 x/y 同传拒绝且零 CDP；页面自主滚动保留 O（C=S+O、source=page）；显式 x/y 保留 O；resize 保留 O；导航与关闭 C=S=0 且宽高/比例保留；capabilities.canvas、limits.viewport.canvas、ui.canvas 与 state.canvas 同源；旧字段不变', async () => {
      const runtimeA = runtimeByWorkspace('ws-a');
      check('scope A 的 runtime 可定位（供 CDP 计数与帧元数据断言）',
        Boolean(runtimeA && typeof runtimeA.send === 'function'), { found: Boolean(runtimeA) }, true);
      const counter = instrumentRuntime(runtimeA);
      const maxScrollY = (truth) => Math.max(0, (truth?.docHeight ?? 0) - (truth?.innerHeight ?? 0));

      const nav = await harness.invoke('browser_navigate', { url: pageUrl }, execA);
      check('V11 重新打开 fixture', nav.ok === true, errorInfo(nav), { ok: true });
      await waitFor(async () => (await pageTruth(harness, execA))?.title === 'P0 Capture Fixture', { label: 'fixture title' });

      const base = await setView({ width: 800, height: 600, scale: 1, x: 0, y: 0 }, execA);
      const baseView = (await getView(execA)).value;
      check('基准：默认 C=0/O=0，x/y=0，页面 scroll=0',
        base.ok === true
          && baseView?.view?.canvasX === 0 && baseView.view.canvasY === 0
          && baseView.view.x === 0 && baseView.view.y === 0
          && baseView.canvas?.offsetX === 0 && baseView.canvas?.offsetY === 0
          && (await pageTruth(harness, execA))?.scrollX === 0,
      { view: baseView?.view, canvas: baseView?.canvas }, { canvas: 0, offset: 0 });

      // --- negative canvas: C may leave the content box; S stays 0 ----------------------
      const revisionBeforeNegative = baseView?.view?.revision;
      const negative = await setView({ canvasX: -100, canvasY: -50 }, execA);
      const negativeView = negative.value || {};
      const truthNegative = await pageTruth(harness, execA);
      check('canvasX=-100,canvasY=-50：C 生效、x=y=0、页面真值 scrollX/Y 仍 0',
        negative.ok === true
          && negativeView.view?.canvasX === -100 && negativeView.view?.canvasY === -50
          && negativeView.view?.x === 0 && negativeView.view?.y === 0
          && truthNegative?.scrollX === 0 && truthNegative?.scrollY === 0
          && negativeView.clamped?.canvasX === false && negativeView.clamped?.canvasY === false,
      { view: negativeView.view, clamped: negativeView.clamped, truth: { x: truthNegative?.scrollX, y: truthNegative?.scrollY } },
      { canvasX: -100, canvasY: -50, x: 0, y: 0 });
      check('返回 offset={-100,-50}、content 为实测内容尺寸、revision 递增',
        negativeView.offset?.x === -100 && negativeView.offset?.y === -50
          && Number.isFinite(negativeView.content?.width) && Number.isFinite(negativeView.content?.height)
          && negativeView.content.width > 0 && negativeView.content.height > 0
          && negativeView.view?.revision === revisionBeforeNegative + 1,
      { offset: negativeView.offset, content: negativeView.content, revision: negativeView.view?.revision, before: revisionBeforeNegative },
      { offset: { x: -100, y: -50 }, revision: 'before+1' });

      const negativeSnapshot = (await getView(execA)).value;
      check('get 的 canvas/content 投影与 view 同源（x/y/offset/contentWidth/contentHeight/blank）',
        negativeSnapshot?.canvas?.version === 1 && negativeSnapshot.canvas.space === 'canvas-css-px'
          && negativeSnapshot.canvas.x === -100 && negativeSnapshot.canvas.y === -50
          && negativeSnapshot.canvas.offsetX === -100 && negativeSnapshot.canvas.offsetY === -50
          && negativeSnapshot.canvas.blank === 'white'
          && negativeSnapshot.canvas.contentWidth === negativeSnapshot.content?.width
          && negativeSnapshot.canvas.contentHeight === negativeSnapshot.content?.height,
      { canvas: negativeSnapshot?.canvas, content: negativeSnapshot?.content }, 'canvas projection');
      const stateTool = await harness.invoke('browser_state', {}, execA);
      check('browser_state：view 带 canvasX/canvasY，新增安全 canvas 投影',
        stateTool.value?.view?.canvasX === -100 && stateTool.value.view.canvasY === -50
          && stateTool.value?.canvas?.x === -100 && stateTool.value.canvas.offsetX === -100
          && stateTool.value?.viewport?.width === 800,
      { view: stateTool.value?.view, canvas: stateTool.value?.canvas, viewport: stateTool.value?.viewport }, 'state canvas');

      // --- capabilities: canvas segment + limits.viewport.canvas -----------------------
      const capabilities = await harness.invoke('browser_capabilities');
      const capsViewport = capabilities.value?.viewport || {};
      const capsLimits = capabilities.value?.limits?.viewport || {};
      const expectedCanvas = {
        version: 1, space: 'canvas-css-px', range: [-10000000, 10000000],
        blankColor: '#ffffff', compositeProvenance: true,
      };
      check('capabilities.viewport.canvas = {version,space,range,blankColor,compositeProvenance}',
        JSON.stringify(capsViewport.canvas) === JSON.stringify(expectedCanvas),
      { canvas: capsViewport.canvas }, expectedCanvas);
      check('limits.viewport.canvas 同上，且旧的 width/height/scroll/scale 范围不变',
        JSON.stringify(capsLimits.canvas) === JSON.stringify(expectedCanvas)
          && JSON.stringify(capsLimits.width) === JSON.stringify([200, 4096])
          && JSON.stringify(capsLimits.height) === JSON.stringify([200, 4096])
          && JSON.stringify(capsLimits.scroll) === JSON.stringify([0, 10000000])
          && JSON.stringify(capsLimits.scale) === JSON.stringify([0.1, 2]),
      { canvas: capsLimits.canvas, width: capsLimits.width, height: capsLimits.height, scroll: capsLimits.scroll, scale: capsLimits.scale },
      { canvas: expectedCanvas, width: [200, 4096], height: [200, 4096], scroll: [0, 10000000], scale: [0.1, 2] });

      // --- authenticated ui.canvas on /state and /frame --------------------------------
      harness.setConnection(ownerConnection());
      try {
        const stateResponse = await harness.request({ method: 'GET', path: '/plugins/ui-testing/state', headers: scopedHeadersA });
        check('已认证 /state 的 ui.canvas 与 view 同源（version/space/x/y/offset/content/blank）',
          stateResponse.statusCode === 200
            && stateResponse.json?.ui?.canvas?.x === -100 && stateResponse.json.ui.canvas.y === -50
            && stateResponse.json.ui.canvas.offsetX === -100 && stateResponse.json.ui.canvas.offsetY === -50
            && stateResponse.json.ui.canvas.space === 'canvas-css-px' && stateResponse.json.ui.canvas.blank === 'white'
            && stateResponse.json.ui.canvas.contentWidth === negativeSnapshot?.canvas?.contentWidth
            && Number.isFinite(stateResponse.json.ui.canvas.contentWidth)
            && stateResponse.json.ui.view?.canvasX === -100,
        { status: stateResponse.statusCode, ui: stateResponse.json?.ui }, 'ui.canvas');
        const frameResponse = await harness.request({ method: 'GET', path: '/plugins/ui-testing/frame', headers: scopedHeadersA });
        check('/frame 的 state 带 ui.canvas（pending 与有帧两种分支同形）',
          (frameResponse.json?.pending === true || typeof frameResponse.json?.image === 'string')
            && frameResponse.json?.state?.ui?.canvas?.x === -100
            && frameResponse.json?.state?.ui?.canvas?.offsetY === -50
            && frameResponse.json?.state?.ui?.version === 1,
        { pending: frameResponse.json?.pending ?? null, hasImage: typeof frameResponse.json?.image === 'string', ui: frameResponse.json?.state?.ui }, 'pending|image + ui.canvas');
      } finally {
        harness.setConnection(undefined);
      }

      // --- CAS: canvas patches share the same expectedRevision rejection ----------------
      const revisionNow = (await getView(execA)).value?.view?.revision;
      const conflict = await setView({ canvasX: 10, expectedRevision: revisionNow - 1 }, execA);
      const afterConflict = (await getView(execA)).value?.view;
      check('canvas + 过期 expectedRevision → VIEWPORT_CONFLICT（state/retryable）且零应用',
        hasErrorCode(conflict, 'VIEWPORT_CONFLICT') && conflict.error?.category === 'state'
          && conflict.error?.retryable === true
          && afterConflict?.canvasX === -100 && afterConflict?.canvasY === -50,
      { error: errorInfo(conflict), view: afterConflict }, { code: 'VIEWPORT_CONFLICT', canvasX: -100, canvasY: -50 });

      // --- invalid canvas patches: pre-flight only, zero CDP ---------------------------
      await sleep(350);
      counter.reset();
      const revisionBeforeInvalid = (await getView(execA)).value?.view?.revision;
      const invalidCanvasCases = [
        ['canvasX 超上界', { canvasX: 10000001 }],
        ['canvasY 超下界', { canvasY: -10000001 }],
        ['canvasX 字符串', { canvasX: '10' }],
        ['canvasY NaN', { canvasY: Number.NaN }],
        ['canvasX 与 x 同传', { canvasX: -10, x: 10 }],
        ['canvasY 与 y 同传', { canvasY: 10, y: 10 }],
      ];
      const invalidCanvasResults = [];
      for (const [label, patch] of invalidCanvasCases) {
        const result = await setView(patch, execA);
        invalidCanvasResults.push({ label, ok: result.ok, code: result.error?.code, category: result.error?.category });
      }
      check('canvas 越界/非数/与 x/y 同传 → INVALID_ARGUMENT/input ×6',
        invalidCanvasResults.every((item) => item.code === 'INVALID_ARGUMENT' && item.category === 'input'),
      invalidCanvasResults.filter((item) => item.code !== 'INVALID_ARGUMENT'), 'INVALID_ARGUMENT ×6');
      check('canvas 非法预检零 CDP（runtime.send 调用数 = 0）', counter.total() === 0, { sends: counter.counts.calls }, { sends: {} });
      const afterInvalid = (await getView(execA)).value?.view;
      check('canvas 非法预检不改 view/revision',
        afterInvalid?.canvasX === -100 && afterInvalid?.canvasY === -50
          && afterInvalid?.revision === revisionBeforeInvalid,
      { view: afterInvalid, before: revisionBeforeInvalid }, 'unchanged');

      // --- canvas inside the content box → scroll aligns, O=0 --------------------------
      const truthTall = await pageTruth(harness, execA);
      check('fixture 文档足够高（maxScrollY ≥ 400，供 canvas 内容内/越界断言）',
        maxScrollY(truthTall) >= 400, { maxScrollY: maxScrollY(truthTall) }, '>=400');
      const within = await setView({ canvasY: 200 }, execA);
      const truthWithin = await pageTruth(harness, execA);
      check('canvasY=200（内容内）：页面 scroll 到 200，O=0，canvasY=200',
        within.ok === true && within.value?.view?.y === 200 && within.value.view.canvasY === 200
          && within.value.offset?.y === 0 && Math.abs((within.value.offset?.y ?? 1)) < 0.01
          && truthWithin?.scrollY === 200,
      { view: within.value?.view, offset: within.value?.offset, scrollY: truthWithin?.scrollY }, { y: 200, canvasY: 200, offsetY: 0 });
      check('只给 canvasY：canvasX 的 O 保留（canvasX=-100，x=0）',
        within.value?.view?.canvasX === -100 && within.value.view.x === 0
          && Math.abs((within.value.offset?.x ?? 1) + 100) < 0.01,
      { view: within.value?.view, offset: within.value?.offset }, { canvasX: -100, x: 0, offsetX: -100 });

      // --- canvas beyond the content → residual offset > 0 (blank) --------------------
      const truthBeyond = await pageTruth(harness, execA);
      const maxY = maxScrollY(truthBeyond);
      const beyondRequest = { canvasX: 0, canvasY: maxY + 57 };
      const beyond = await setView(beyondRequest, execA);
      const truthAfterBeyond = await pageTruth(harness, execA);
      check('canvasY=maxY+57（越界）：scroll 停在 maxY，C=maxY+57，offset=57 → 露 blank',
        beyond.ok === true
          && Math.abs((beyond.value?.view?.y ?? -1) - truthAfterBeyond?.scrollY) <= 1
          && Math.abs((beyond.value?.view?.y ?? -1) - maxY) <= 1
          && Math.abs((beyond.value?.view?.canvasY ?? -1) - (maxY + 57)) <= 1
          && Math.abs((beyond.value?.offset?.y ?? 0) - 57) <= 0.01
          && truthAfterBeyond?.scrollY === maxY,
      { view: beyond.value?.view, offset: beyond.value?.offset, truth: truthAfterBeyond, maxY }, { y: maxY, canvasY: maxY + 57, offsetY: 57 });
      check('越界不是浏览器 clamp：clamped.canvasY=false（Host 主动把 S 停在 max，O=57）',
        beyond.value?.clamped?.canvasY === false && beyond.value?.clamped?.canvasX === false && beyond.value?.clamped?.x === false,
      beyond.value?.clamped, { canvasX: false, canvasY: false, x: false });

      // --- reset to 0 ---------------------------------------------------------------
      const reset = await setView({ canvasX: 0, canvasY: 0 }, execA);
      const truthReset = await pageTruth(harness, execA);
      check('canvas 归零：S=0、C=0、O=0、页面 scroll=0',
        reset.ok === true && reset.value?.view?.x === 0 && reset.value.view.y === 0
          && reset.value.view.canvasX === 0 && reset.value.view.canvasY === 0
          && reset.value.offset?.x === 0 && reset.value.offset?.y === 0
          && truthReset?.scrollX === 0 && truthReset?.scrollY === 0,
      { view: reset.value?.view, offset: reset.value?.offset, truth: { x: truthReset?.scrollX, y: truthReset?.scrollY } }, { C: 0, S: 0, O: 0 });

      // --- page-initiated scroll keeps O (C = S + O, source=page) ---------------------
      const framing = await setView({ canvasY: -50 }, execA);
      check('建立 O=-50（canvasY=-50、S=0）', framing.ok === true
        && framing.value?.view?.canvasY === -50 && framing.value?.view?.y === 0
        && framing.value?.offset?.y === -50,
      { view: framing.value?.view, offset: framing.value?.offset }, { canvasY: -50, y: 0 });
      const revisionBeforePageScroll = framing.value?.view?.revision;
      await harness.invoke('browser_eval', { expression: 'window.scrollTo(0, 100); "ok"' }, execA);
      // Polling page truth through browser_eval also arms the coalesced view readback (the wrapper
      // schedules it after every page operation), so the cached view converges without a GUI poll.
      const scrollDeadline = Date.now() + 3000;
      let scrolledView = null;
      let scrollDiagnostic = null;
      while (Date.now() < scrollDeadline) {
        const truth = await pageTruth(harness, execA);
        const snapshot = (await getView(execA)).value;
        const current = snapshot?.view;
        scrollDiagnostic = {
          page: { x: truth?.scrollX, y: truth?.scrollY },
          view: current,
          observed: snapshot?.observed,
        };
        if (current && Math.abs(current.y - 100) <= 1 && Math.abs(current.canvasY - 50) <= 1) {
          scrolledView = current;
          break;
        }
        await sleep(80);
      }
      check('页面真值已滚动到 scrollY=100', Math.abs((scrollDiagnostic?.page?.y ?? -1) - 100) <= 1,
        scrollDiagnostic?.page, { scrollY: 100 });
      check('页面自主滚动到 100：保留 O，C=50，source=page，revision 递增',
        Math.abs((scrolledView?.y ?? -1) - 100) <= 1
          && Math.abs((scrolledView?.canvasY ?? -1) - 50) <= 1
          && scrolledView?.source === 'page'
          && scrolledView?.revision === revisionBeforePageScroll + 1,
      { view: scrolledView, before: revisionBeforePageScroll, last: scrollDiagnostic }, { y: 100, canvasY: 50, source: 'page', revision: 'before+1' });

      // --- explicit x/y keeps O too (C = S_target + O) -------------------------------
      const xyset = await setView({ y: 200 }, execA);
      const truthXy = await pageTruth(harness, execA);
      check('只给 y=200：保留 O=-50 → C=150，offset=-50，页面 scrollY=200',
        xyset.ok === true && xyset.value?.view?.y === 200 && xyset.value.view.canvasY === 150
          && xyset.value.offset?.y === -50 && truthXy?.scrollY === 200,
      { view: xyset.value?.view, offset: xyset.value?.offset, scrollY: truthXy?.scrollY }, { y: 200, canvasY: 150, offsetY: -50 });

      // --- resize keeps O (S is clamped by the browser, C follows) -------------------
      const truthResizeBase = await pageTruth(harness, execA);
      const resizeMaxY = maxScrollY(truthResizeBase);
      const framed = await setView({ canvasY: resizeMaxY + 57 }, execA);
      check('resize 前建立越界 O=57', framed.ok === true
        && Math.abs((framed.value?.offset?.y ?? 0) - 57) <= 0.01,
      { view: framed.value?.view, offset: framed.value?.offset }, { offsetY: 57 });
      const resized = await setView({ height: 900 }, execA);
      const truthResized = await pageTruth(harness, execA);
      check('resize 到 900 高：S 由浏览器约束、O=57 保留 → C=S+57',
        resized.ok === true
          && Math.abs((resized.value?.view?.y ?? -1) - truthResized?.scrollY) <= 1
          && Math.abs((resized.value?.offset?.y ?? 0) - 57) <= 0.01
          && Math.abs((resized.value?.view?.canvasY ?? -1) - ((resized.value?.view?.y ?? 0) + 57)) <= 0.01,
      { view: resized.value?.view, offset: resized.value?.offset, scrollY: truthResized?.scrollY }, { offsetY: 57, canvasY: 'y+57' });

      // --- navigation resets C=S=0, keeps width/height/scale ------------------------
      const beforeNavigation = (await getView(execA)).value?.view;
      const nav2 = await harness.invoke('browser_navigate', { url: pageUrl }, execA);
      check('导航成功', nav2.ok === true, errorInfo(nav2), { ok: true });
      const navDeadline = Date.now() + 4000;
      let afterNavigation = null;
      let navigationDiagnostic = null;
      while (Date.now() < navDeadline) {
        const truth = await pageTruth(harness, execA);
        const snapshot = (await getView(execA)).value;
        navigationDiagnostic = {
          page: { x: truth?.scrollX, y: truth?.scrollY },
          view: snapshot?.view,
          viewMeta: snapshot?.viewMeta,
        };
        const current = snapshot?.view;
        if (current && current.x === 0 && current.y === 0 && current.canvasX === 0 && current.canvasY === 0) {
          afterNavigation = current;
          break;
        }
        await sleep(80);
      }
      check('导航：C=S=0、O=0，width/height/scale 保留',
        afterNavigation?.canvasX === 0 && afterNavigation?.canvasY === 0
          && afterNavigation?.x === 0 && afterNavigation?.y === 0
          && afterNavigation?.width === beforeNavigation?.width
          && afterNavigation?.height === beforeNavigation?.height
          && afterNavigation?.scale === beforeNavigation?.scale,
      { before: beforeNavigation, after: afterNavigation, last: navigationDiagnostic }, { C: 0, S: 0, config: 'preserved' });

      // --- close resets C/S, keeps width/height/scale -------------------------------
      const framedAgain = await setView({ canvasX: -100, canvasY: -50 }, execA);
      check('关闭前建立 C=-100/-50', framedAgain.ok === true
        && framedAgain.value?.view?.canvasX === -100 && framedAgain.value?.view?.canvasY === -50,
      { view: framedAgain.value?.view }, { canvasX: -100, canvasY: -50 });
      const beforeClose = (await getView(execA)).value?.view;
      harness.setConnection(ownerConnection());
      let closeResponse;
      try {
        closeResponse = await harness.request({
          method: 'POST', path: '/plugins/ui-testing/close', headers: scopedHeadersA, body: {},
        });
      } finally {
        harness.setConnection(undefined);
      }
      check('scope A close 返回 200', closeResponse.statusCode === 200,
        { status: closeResponse.statusCode, body: closeResponse.json }, { status: 200 });
      const afterClose = (await getView(execA)).value;
      check('关闭：C=S=0/O=0、observed=null，width/height/scale 保留，revision+1',
        afterClose?.view?.x === 0 && afterClose.view.y === 0
          && afterClose.view.canvasX === 0 && afterClose.view.canvasY === 0
          && afterClose.canvas?.offsetX === 0 && afterClose.canvas?.offsetY === 0
          && afterClose.observed === null
          && afterClose.view.width === beforeClose?.width && afterClose.view.height === beforeClose?.height
          && afterClose.view.scale === beforeClose?.scale
          && afterClose.view.revision === beforeClose?.revision + 1,
      { before: beforeClose, after: afterClose?.view, canvas: afterClose?.canvas, observed: afterClose?.observed }, 'reset C/S, keep config');

      const losslessCanvas = [
        ['get', (await getView(execA)).value],
        ['state', (await harness.invoke('browser_state', {}, execA)).value],
        ['capabilities', (await harness.invoke('browser_capabilities')).value],
      ].map(([name, value]) => ({ name, problem: losslessProblem(value) }));
      check('canvas 投影（get/state/capabilities）均为 lossless JSON',
        losslessCanvas.every((item) => item.problem === null), losslessCanvas.filter((item) => item.problem), 'no undefined');
    });

  /* ---------------------------------------------------------------- V12: frame scroll metadata */
  await runProbe('V12-frame-metadata', '帧 scrollX/scrollY：FrameSource、WS 推送头、/frame 与运行时缓存同源',
    'FrameSource.accept 保存 scrollX/scrollY（0 合法、小数保留、缺失/非法归一为 0）；WS 二进制帧头含 scrollX/scrollY；/frame 有帧时带有限非负 scrollX/scrollY，滚动后新帧 scrollY=40 且与页面真值和 runtime.frames.latest() 一致', async () => {
      // --- pure frame store ---------------------------------------------------------
      const source = new FrameSource();
      const stored = source.accept({ data: '', width: 10, height: 10, pageWidth: 10, pageHeight: 10, scrollX: 0, scrollY: 12.5 });
      check('FrameSource.accept 保存 scrollX=0（0 合法）与小数 scrollY=12.5',
        stored.scrollX === 0 && stored.scrollY === 12.5, { scrollX: stored.scrollX, scrollY: stored.scrollY }, { scrollX: 0, scrollY: 12.5 });
      const missing = source.accept({ data: '', width: 10, height: 10 });
      check('缺失 scroll 元数据归一为 0（不是 NaN/undefined）',
        missing.scrollX === 0 && missing.scrollY === 0, { scrollX: missing.scrollX, scrollY: missing.scrollY }, { scrollX: 0, scrollY: 0 });
      const invalid = source.accept({ data: '', width: 10, height: 10, scrollX: -5, scrollY: Number.NaN });
      check('负数/NaN scroll 归一为 0', invalid.scrollX === 0 && invalid.scrollY === 0,
        { scrollX: invalid.scrollX, scrollY: invalid.scrollY }, { scrollX: 0, scrollY: 0 });

      // --- WS push header -----------------------------------------------------------
      source.accept({ data: '', width: 10, height: 10, pageWidth: 10, pageHeight: 10, scrollX: 3, scrollY: 42 });
      const writes = [];
      const fakeSocket = {
        destroyed: false,
        write(chunk) { writes.push(Buffer.from(chunk)); return true; },
        setNoDelay() {}, on() {}, once() {}, end() {}, destroy() {},
      };
      const pusher = createFramePusher(source, { intervalMs: 0, scopeInfo: () => ({ scopeId: 'unit-scope', runtimeId: 'unit-runtime' }) });
      let pushHeader = null;
      try {
        pusher.handleUpgrade({
          headers: {
            upgrade: 'websocket', connection: 'Upgrade',
            'sec-websocket-key': 'dGhlIHNhbXBsZSBub25jZQ==', 'sec-websocket-version': '13',
          },
        }, fakeSocket, Buffer.alloc(0));
        const binary = writes.find((buffer) => (buffer[0] & 0x0f) === 0x2);
        if (binary) pushHeader = decodeWsFrameHeader(binary);
      } finally {
        pusher.dispose();
      }
      check('WS 二进制帧头带 scrollX=3/scrollY=42（frame-push metadata 同源）',
        pushHeader?.scrollX === 3 && pushHeader?.scrollY === 42 && pushHeader?.pageWidth === 10,
      pushHeader ? { scrollX: pushHeader.scrollX, scrollY: pushHeader.scrollY, pageWidth: pushHeader.pageWidth } : null,
      { scrollX: 3, scrollY: 42 });

      // --- real runtime /frame ------------------------------------------------------
      const runtimeA = runtimeByWorkspace('ws-a');
      const nav = await harness.invoke('browser_navigate', { url: pageUrl }, execA);
      check('V12 重新打开 fixture（close 后懒启动）', nav.ok === true, errorInfo(nav), { ok: true });
      await waitFor(async () => (await pageTruth(harness, execA))?.title === 'P0 Capture Fixture', { label: 'fixture title' });
      const base = await setView({ width: 800, height: 600, scale: 1, x: 0, y: 0 }, execA);
      check('V12 基准 800×600', base.ok === true && base.value?.view?.width === 800, errorInfo(base), { width: 800 });

      const paint = async () => harness.invoke('browser_eval', {
        expression: "(function () { const el = document.getElementById('cap-red'); if (el) el.style.outline = el.style.outline ? '' : '1px solid #fff'; return true; })()",
      }, execA);

      harness.setConnection(ownerConnection());
      try {
        await paint();
        const firstFrame = await waitFor(async () => {
          const response = await harness.request({ method: 'GET', path: '/plugins/ui-testing/frame?since=0', headers: scopedHeadersA });
          return typeof response.json?.image === 'string' ? response.json : null;
        }, { timeoutMs: 5000, intervalMs: 100, label: '首帧 image' });
        check('/frame 有帧时带有限非负 scrollX/scrollY，且 state.ui.canvas 同形',
          Number.isFinite(firstFrame?.scrollX) && firstFrame.scrollX >= 0
            && Number.isFinite(firstFrame?.scrollY) && firstFrame.scrollY >= 0
            && Number.isFinite(firstFrame?.state?.ui?.canvas?.x)
            && firstFrame.state.ui.canvas.space === 'canvas-css-px',
        { scrollX: firstFrame?.scrollX, scrollY: firstFrame?.scrollY, uiCanvas: firstFrame?.state?.ui?.canvas }, 'finite scroll + ui.canvas');

        const seqBefore = runtimeA.frames.seq;
        const scrolled = await setView({ y: 40 }, execA);
        check('滚动到 y=40 成功', scrolled.ok === true && scrolled.value?.view?.y === 40,
          { view: scrolled.value?.view, error: scrolled.ok ? null : errorInfo(scrolled) }, { y: 40 });
        await paint();
        const scrolledFrame = await waitFor(async () => {
          const response = await harness.request({
            method: 'GET', path: `/plugins/ui-testing/frame?since=${seqBefore}`, headers: scopedHeadersA,
          });
          const json = response.json;
          return typeof json?.image === 'string' && Math.abs((json.scrollY ?? -1) - 40) <= 1 ? json : null;
        }, { timeoutMs: 5000, intervalMs: 100, label: '滚动后帧 scrollY=40' });
        const truth = await pageTruth(harness, execA);
        check('滚动后新帧 scrollY=40 与页面真值 scrollY 一致',
          Math.abs((scrolledFrame?.scrollY ?? -1) - 40) <= 1
            && Math.abs((scrolledFrame?.scrollY ?? -1) - (truth?.scrollY ?? -2)) <= 1,
        { frameScrollY: scrolledFrame?.scrollY, truthScrollY: truth?.scrollY, seq: scrolledFrame?.seq }, { scrollY: 40 });
        const latest = runtimeA.frames.latest();
        check('/frame 与 runtime.frames.latest() 是同一份 scroll 元数据',
          latest?.scrollY === scrolledFrame?.scrollY && latest?.scrollX === scrolledFrame?.scrollX,
        { latest: latest ? { scrollX: latest.scrollX, scrollY: latest.scrollY } : null, frame: { scrollX: scrolledFrame?.scrollX, scrollY: scrolledFrame?.scrollY } }, 'same frame');
      } finally {
        harness.setConnection(undefined);
      }
    });

  /* ---------------------------------------------------------------- V13: /screenshot canvas seed route */
  await runProbe('V13-screenshot-route', '/screenshot 画布 provenance：raw 旧路径 + canvas:true（O=0/O≠0）+ 认证',
    'raw POST 保持旧响应形状与 live viewport PNG；canvas:true + O=0 单次原生 PNG（composite:false）；canvas:true + O≠0 返回 W×H 白底合成 PNG + view/capture.canvas（C/S/O/content/blank/composite:true）+ request/contentRect/scroll/viewRevision；证据不泄露页面文本或路径；scoped 未认证仍 401', async () => {
      const setLegacy = (patch) => harness.invoke('browser_viewport', { action: 'set', ...patch });
      const pixelAt = (decoded, x, y) => {
        const base = (y * decoded.width + x) * decoded.channels;
        if (decoded.channels === 4) return { r: decoded.data[base], g: decoded.data[base + 1], b: decoded.data[base + 2], a: decoded.data[base + 3] };
        if (decoded.channels === 3) return { r: decoded.data[base], g: decoded.data[base + 1], b: decoded.data[base + 2], a: 255 };
        if (decoded.channels === 2) return { r: decoded.data[base], g: decoded.data[base], b: decoded.data[base], a: decoded.data[base + 1] };
        return { r: decoded.data[base], g: decoded.data[base], b: decoded.data[base], a: 255 };
      };

      const nav = await harness.invoke('browser_navigate', { url: pageUrl });
      check('V13 legacy scope 打开 fixture', nav.ok === true, errorInfo(nav), { ok: true });
      await waitFor(async () => (await pageTruth(harness))?.title === 'P0 Capture Fixture', { label: 'fixture title' });
      const base = await setLegacy({ width: 800, height: 600, scale: 1, x: 0, y: 0 });
      check('V13 基准 800×600/C=0/O=0', base.ok === true && base.value?.view?.canvasX === 0
        && base.value?.view?.canvasY === 0 && base.value?.offset?.x === 0 && base.value?.offset?.y === 0,
      { view: base.value?.view, offset: base.value?.offset }, { width: 800, height: 600, offset: 0 });

      // ---- raw legacy path: exact old shape, no composition metadata ------------------------
      const raw = await harness.request({ method: 'POST', path: '/plugins/ui-testing/screenshot', body: {} });
      const rawJson = raw.json || {};
      check('V13 raw POST /screenshot 保持旧响应形状（ok/image/viewport/capturedAt，无 view/capture）',
        raw.statusCode === 200 && rawJson.ok === true && typeof rawJson.image === 'string'
          && JSON.stringify(Object.keys(rawJson).sort()) === JSON.stringify(['capturedAt', 'image', 'ok', 'viewport'])
          && rawJson.view === undefined && rawJson.capture === undefined,
        { status: raw.statusCode, keys: Object.keys(rawJson), view: rawJson.view, capture: rawJson.capture }, 'legacy shape');
      const rawPng = inspectPng(Buffer.from(String(rawJson.image || ''), 'base64'), { checkCrc: true });
      check('V13 raw 截图 = 页面 live viewport 800×600（原始 CDP PNG）',
        rawPng.ok === true && rawPng.width === 800 && rawPng.height === 600,
        rawPng.ok ? { width: rawPng.width, height: rawPng.height } : rawPng, { width: 800, height: 600 });

      // ---- canvas:true + O=0: still the raw single-CDP PNG, provenance additive -------------
      const o0 = await harness.request({ method: 'POST', path: '/plugins/ui-testing/screenshot', body: { canvas: true } });
      const o0Json = o0.json || {};
      check('V13 canvas:true + O=0：composite=false、request=canvas-css-px/document-css-px、带 view/viewRevision',
        o0.statusCode === 200 && typeof o0Json.image === 'string'
          && o0Json.view?.canvasX === 0 && o0Json.view?.x === 0
          && o0Json.capture?.composite === false
          && o0Json.capture?.request?.space === 'canvas-css-px'
          && o0Json.capture?.request?.coordinateSpace === 'document-css-px'
          && o0Json.capture?.canvas?.composite === false
          && Number.isFinite(o0Json.capture?.viewRevision),
        { status: o0.statusCode, view: o0Json.view, capture: o0Json.capture }, 'O=0 raw path');
      const o0Png = inspectPng(Buffer.from(String(o0Json.image || ''), 'base64'), { checkCrc: true });
      check('V13 canvas:true + O=0 PNG 仍 800×600（未走合成/重编码）',
        o0Png.ok === true && o0Png.width === 800 && o0Png.height === 600,
        o0Png.ok ? { width: o0Png.width, height: o0Png.height } : o0Png, { width: 800, height: 600 });

      // ---- canvas:true + O≠0: white-composited canvas viewport ------------------------------
      const moved = await setLegacy({ canvasX: -100, canvasY: -50 });
      check('V13 legacy scope 建立 C=(-100,-50)/S=0', moved.ok === true
        && moved.value?.view?.canvasX === -100 && moved.value?.view?.canvasY === -50
        && moved.value?.view?.x === 0 && moved.value?.view?.y === 0,
      { view: moved.value?.view, offset: moved.value?.offset }, { canvas: [-100, -50], scroll: [0, 0] });
      const c1 = await harness.request({ method: 'POST', path: '/plugins/ui-testing/screenshot', body: { canvas: true } });
      const c1Json = c1.json || {};
      const c1Bytes = Buffer.from(String(c1Json.image || ''), 'base64');
      const c1Png = inspectPng(c1Bytes, { checkCrc: true });
      const c1Decoded = decodePng(c1Bytes);
      check('V13 canvas:true + O≠0 返回 800×600 PNG + viewport=W×H',
        c1.statusCode === 200 && c1Png.ok === true && c1Png.width === 800 && c1Png.height === 600
          && c1Json.viewport?.width === 800 && c1Json.viewport?.height === 600,
        { status: c1.statusCode, png: c1Png.ok ? { width: c1Png.width, height: c1Png.height } : c1Png, viewport: c1Json.viewport }, { size: [800, 600] });
      check('V13 capture.canvas：C/S/O、content、blank=#ffffff、composite=true、source',
        c1Json.capture?.canvas?.x === -100 && c1Json.capture.canvas.y === -50
          && c1Json.capture.canvas.scrollX === 0 && c1Json.capture.canvas.scrollY === 0
          && c1Json.capture.canvas.offsetX === -100 && c1Json.capture.canvas.offsetY === -50
          && c1Json.capture.canvas.contentWidth === 800 && c1Json.capture.canvas.contentHeight === 2600
          && c1Json.capture.canvas.blank === '#ffffff'
          && c1Json.capture.canvas.composite === true
          && c1Json.capture.canvas.source === 'cdp-page-capture-screenshot'
          && c1Json.capture.composite === true
          && c1Json.capture.request?.coordinateSpace === 'canvas-css-px',
        { canvas: c1Json.capture?.canvas, composite: c1Json.capture?.composite, request: c1Json.capture?.request }, 'canvas provenance');
      check('V13 capture.contentRect={0,0,700,550}、scroll={0,0}、viewport={800,600}',
        JSON.stringify(c1Json.capture?.contentRect) === JSON.stringify({ x: 0, y: 0, width: 700, height: 550 })
          && JSON.stringify(c1Json.capture?.scroll) === JSON.stringify({ x: 0, y: 0 })
          && c1Json.capture?.viewport?.width === 800 && c1Json.capture?.viewport?.height === 600,
        { contentRect: c1Json.capture?.contentRect, scroll: c1Json.capture?.scroll, viewport: c1Json.capture?.viewport },
        { contentRect: { x: 0, y: 0, width: 700, height: 550 }, scroll: { x: 0, y: 0 } });
      check('V13 view 是安全投影（canvasX/Y + revision，无页面文本/路径）', c1Json.view?.canvasX === -100
        && c1Json.view?.canvasY === -50 && Number.isSafeInteger(c1Json.view?.revision),
      { view: c1Json.view }, { canvas: [-100, -50], revision: 'integer' });
      const serializedCapture = JSON.stringify({ view: c1Json.view, capture: c1Json.capture });
      check('V13 canvas 证据不泄露页面文本/URL/文件路径',
        !serializedCapture.includes('"url"') && !serializedCapture.includes('"title"')
          && !serializedCapture.includes('"file"') && !serializedCapture.includes('http://')
          && !serializedCapture.includes('/tmp/') && !serializedCapture.includes('/home/'),
        { leaked: serializedCapture.match(/"(url|title|file)"|https?:\/\/|\/tmp\/|\/home\//g) || null }, 'no page text/path');
      const whiteAt = (x, y) => {
        const p = pixelAt(c1Decoded, x, y);
        return p.r === 255 && p.g === 255 && p.b === 255;
      };
      check('V13 O≠0 合成像素：左/上 blank 纯白、#cap-red 落在 (120,70)+',
        c1Decoded.ok === true && whiteAt(10, 300) && whiteAt(400, 10)
          && pixelAt(c1Decoded, 130, 80).r === 255 && pixelAt(c1Decoded, 130, 80).g === 0
          && pixelAt(c1Decoded, 130, 80).b === 0,
        c1Decoded.ok ? { left: pixelAt(c1Decoded, 10, 300), top: pixelAt(c1Decoded, 400, 10), red: pixelAt(c1Decoded, 130, 80) } : c1Decoded,
        { left: 'white', top: 'white', red: [255, 0, 0] });

      // ---- scoped auth failure path stays 401 (no image, no page change) -------------------
      const revisionBeforeAuth = (await getView(harness)).value?.view?.revision;
      harness.setConnection(harnessModule.createFakeConnectionService({ rejection: 401 }));
      let authResponse;
      try {
        authResponse = await harness.request({
          method: 'POST', path: '/plugins/ui-testing/screenshot',
          headers: scopedHeadersA, body: { canvas: true },
        });
      } finally {
        harness.setConnection(undefined);
      }
      check('V13 scoped /screenshot 未通过认证 → 401，无 image/capture 且不改页面 view',
        authResponse.statusCode === 401 && authResponse.json?.image === undefined
          && authResponse.json?.capture === undefined
          && (await getView(harness)).value?.view?.revision === revisionBeforeAuth,
        { status: authResponse.statusCode, body: authResponse.json, revision: revisionBeforeAuth }, { status: 401 });

      // ---- restore legacy view for later probes -------------------------------------------
      await setLegacy({ canvasX: 0, canvasY: 0 });
      const restored = (await getView(harness)).value?.view;
      check('V13 复位 legacy view C=0/O=0（供后续探针）',
        restored?.canvasX === 0 && restored?.canvasY === 0 && restored?.x === 0 && restored?.y === 0,
        restored, { canvas: 0, offset: 0 });
    });

  /* ---------------------------------------------------------------- A1: annotation surface */
  await runProbe('A1-annotation-surface', '标注 Agent 可见面：工具面含 browser_annotation、capabilities/limits、冷态投影、拒绝与零副作用',
    '注册表仍与 EXPECTED_TOOLS 一致且含 browser_annotation；capabilities.annotations 声明 readTool/writeTool/writeSurface/source/trusted/screenshotOverlay/坐标/复位/前台窗口，limits.annotations 十项一致；冷态 state.annotations 为空形状且 stale=not-running；冷态发布 400 annotation-runtime-not-running 零写入；未 scoped 403；未认证 401；读 state/capabilities 不建页面、零 CDP', async () => {
      const names = harness.toolNames();
      check(`工具面仍 ${EXPECTED_TOOLS.length} 个 browser_* 工具，且含浏览器标注工具 browser_annotation`,
        names.length === EXPECTED_TOOLS.length
          && names.includes('browser_annotation')
          && names.includes('browser_state') && names.includes('browser_capabilities'),
      { count: names.length, annotTools: names.filter((name) => /annot/u.test(name)) }, { count: EXPECTED_TOOLS.length, annotTools: ['browser_annotation'] });

      // The workspace-session exec is required: an anonymous/legacy call has no page of its own and
      // answers TARGET_NOT_BOUND before it can describe any capability.
      const capabilities = await harness.invoke('browser_capabilities', {}, execA);
      const annotations = capabilities.value?.annotations || {};
      check('capabilities.annotations：读取=browser_state+browser_annotation、面板写入面=authenticated-scoped-http、Agent 写入工具=browser_annotation、source=human-panel、trusted=false、screenshotOverlay=false、带坐标/复位/前台窗口说明',
        capabilities.ok === true
          && annotations.version === 1 && annotations.space === 'canvas-css-px'
          && annotations.readTool === 'browser_state' && annotations.readPath === 'annotations'
          && JSON.stringify(annotations.readTools) === JSON.stringify(['browser_state', 'browser_annotation'])
          && annotations.writeSurface === 'authenticated-scoped-http'
          && annotations.writeTool === 'browser_annotation'
          && JSON.stringify(annotations.writeActions) === JSON.stringify(['draw', 'erase', 'clear'])
          && annotations.foregroundRequiredForWrite === true
          && annotations.source === 'human-panel' && annotations.trusted === false
          && typeof annotations.screenshotOverlay === 'boolean'
          && annotations.screenshotParameter === 'includeAnnotations'
          && typeof annotations.coordinateHint === 'string' && /p=q\+O=d-S/u.test(annotations.coordinateHint)
          && typeof annotations.reset === 'string' && /documentKey/u.test(annotations.reset),
      { annotations }, 'annotations capability segment');

      const expectedLimits = {
        maxShapes: 128, maxPointsPerShape: 512, maxPointsPerDocument: 8192, maxTextCodeUnits: 200,
        maxDocumentBytes: 65536, maxBodyBytes: 262144, maxPanels: 16, staleAfterMs: 30000,
        maxShapesPerCall: 64, foregroundTtlMs: 1500,
      };
      const limits = capabilities.value?.limits?.annotations || {};
      check('limits.annotations 与契约软限额逐项一致（128/512/8192/200/64KiB/256KiB/16/30s/64/1.5s）',
        JSON.stringify(limits) === JSON.stringify(expectedLimits), { limits }, expectedLimits);

      const coldState = await readScopedState(ANNOT_HEADERS_UNASSIGNED);
      const coldAnnotations = coldState?.annotations || {};
      const coldContext = coldState?.ui?.annotationContext || {};
      check('冷态 state.annotations 为空形状：revision 0、updatedAt/source/context/view null、shapes []、truncation 归零、stale=not-running；ui.annotationContext 仍给出 runtimeId/documentKey',
        coldAnnotations.version === 1 && coldAnnotations.space === 'canvas-css-px'
          && coldAnnotations.revision === 0 && coldAnnotations.updatedAt === null
          && coldAnnotations.source === null && coldAnnotations.context === null && coldAnnotations.view === null
          && Array.isArray(coldAnnotations.shapes) && coldAnnotations.shapes.length === 0
          && coldAnnotations.truncated === false
          && JSON.stringify(coldAnnotations.truncation) === JSON.stringify(zeroTruncation())
          && coldAnnotations.stale === true && coldAnnotations.staleReason === 'not-running'
          && typeof coldContext.runtimeId === 'string' && typeof coldContext.documentKey === 'string'
          && coldContext.pageGeneration === null && coldContext.documentEpoch === 0
          && JSON.stringify(coldState?.ui?.annotations) === JSON.stringify(coldAnnotations),
      { annotations: coldAnnotations, context: coldContext }, 'cold empty document');

        const coldPublish = await publishAnnotations(
        annotationPublishBody(coldState, { clientRevision: 1, shapes: annotationShapes() }),
        { headers: ANNOT_HEADERS_UNASSIGNED },
      );
      const coldAfter = await readScopedState(ANNOT_HEADERS_UNASSIGNED);
      check('冷态（未启动页面）发布被拒绝：400 annotation-runtime-not-running，且零写入（revision 0、shapes 空、source null）',
        coldPublish.statusCode === 400 && coldPublish.json?.code === 'INVALID_ARGUMENT'
          && coldPublish.json?.details?.reason === 'annotation-runtime-not-running'
          && coldAfter?.annotations?.revision === 0 && coldAfter.annotations.shapes.length === 0
          && coldAfter.annotations.source === null,
      { status: coldPublish.statusCode, body: coldPublish.json, after: coldAfter?.annotations },
      { status: 400, reason: 'annotation-runtime-not-running' });

      const legacyPublish = await publishAnnotations(
        annotationPublishBody(coldState, { clientRevision: 1, shapes: [] }),
        { headers: {} },
      );
      const legacyAfter = await readScopedState(ANNOT_HEADERS_UNASSIGNED);
      check('未带 scope 的 legacy 发布被拒绝（403 SCOPE_FORBIDDEN，不猜 workspace）且零写入',
        legacyPublish.statusCode === 403 && legacyPublish.json?.code === 'SCOPE_FORBIDDEN'
          && legacyAfter?.annotations?.revision === 0,
      { status: legacyPublish.statusCode, body: legacyPublish.json }, { status: 403, code: 'SCOPE_FORBIDDEN' });

      const unauthPublish = await publishAnnotations(
        annotationPublishBody(coldState, { clientRevision: 1, shapes: [] }),
        { authenticated: false },
      );
      const unauthAfter = await readScopedState(ANNOT_HEADERS_UNASSIGNED);
      check('scoped 但未通过 owner-only 鉴权的发布 → 401，且零写入',
        unauthPublish.statusCode === 401 && unauthAfter?.annotations?.revision === 0,
      { status: unauthPublish.statusCode, body: unauthPublish.json }, { status: 401 });

      // Zero side effects of *reading* the annotation surface on a cold scope: no page, no profile,
      // and not a single CDP command.
      const coldRuntime = (() => {
        const registry = harness.ctx.__internal.plugin?.registry;
        if (!registry) return undefined;
        for (const entry of registry.entries.values()) if (entry.scope?.id === 'unassigned:owner') return entry.runtime;
        return undefined;
      })();
      const coldCounter = instrumentRuntime(coldRuntime);
      coldCounter.reset();
      const coldStateAgain = await readScopedState(ANNOT_HEADERS_UNASSIGNED);
      const coldAfterRead = await readScopedState(ANNOT_HEADERS_UNASSIGNED);
      check('读取 annotations/capabilities 不启动页面、零 CDP（runtime.send 调用数 0，page 仍空）',
        coldCounter.total() === 0 && coldRuntime.page === undefined && coldRuntime.cdp === undefined
          && coldStateAgain?.annotations?.revision === 0 && coldAfterRead?.annotations?.revision === 0,
      { sends: coldCounter.counts.calls, page: coldRuntime.page ?? null }, { sends: {}, page: null });
    });

  /* ---------------------------------------------------------------- A2: six shapes + snapshot */
  await runProbe('A2-annotation-shapes', '六种图形、负 C 快照与文字读回：Host 规范化而不改页面',
    '六图形按叠放顺序与几何读回；箭头头部由端点+线宽重算（不信客户端 9999）；文字原文（中文/<>&/引号）与 fontSize=20 保持；view 存客户端接受快照（canvasX=-100、y=60、canvasY=10、contentSize、viewRevision）；context 五项与 ui.annotationContext 同源且 addressDigest 64 hex 不泄露地址；browser_state 顶层同源；p=d−S=q+O 自洽；第二次发布 revision+1；发布零 CDP、页面 DOM/滚动不变', async () => {
      const nav = await harness.invoke('browser_navigate', { url: pageUrl }, execA);
      await waitFor(async () => (await pageTruth(harness, execA))?.title === 'P0 Capture Fixture', { label: 'fixture title' });
      await setView({ width: 800, height: 600, scale: 1, x: 0, y: 0 }, execA);
      await setView({ canvasX: -100, canvasY: -50 }, execA);
      const moved = await setView({ x: 0, y: 60 }, execA);
      const stateA = await readScopedState(ANNOT_HEADERS_A);
      check('基准快照：canvasX=-100、x=0、y=60、canvasY=10（O=-100/-50 在改 S 时保留），页面 scrollY=60',
        nav.ok === true && moved.ok === true && stateA?.view?.canvasX === -100 && stateA.view.x === 0
          && stateA.view.y === 60 && stateA.view.canvasY === 10
          && (await pageTruth(harness, execA))?.scrollY === 60,
      { nav: nav.ok, view: stateA?.view, canvas: stateA?.canvas }, { canvasX: -100, x: 0, y: 60, canvasY: 10 });

      const runtimeA = runtimeByWorkspace('ws-a');
      const counter = instrumentRuntime(runtimeA);
      const domBefore = (await harness.invoke('browser_eval', {
        expression: '({ annotNodes: document.querySelectorAll("[data-utb-annot], [data-utb-annot-layer]").length, scrollX: window.scrollX, scrollY: window.scrollY, innerWidth: window.innerWidth, dpr: window.devicePixelRatio })',
      }, execA)).value?.value;
      // Let any metadata/observation read armed by the /state above land before the zero-CDP window.
      await sleep(500);
      counter.reset();

      const panelId = panelIdFor(1);
      const shapes = annotationShapes();
      const first = await publishAnnotations(annotationPublishBody(stateA, { panelId, clientRevision: 1, shapes }));
      const doc = first.json?.annotations || {};
      check('六图形发布 200 且 accepted=true/ignored=false：顺序与 id/type 保持、truncated=false、revision 1',
        first.statusCode === 200 && first.json?.ok === true && first.json?.accepted === true && first.json?.ignored === false
          && doc.revision === 1 && doc.truncated === false
          && JSON.stringify(doc.shapes.map((shape) => [shape.id, shape.type])) === JSON.stringify(shapes.map((shape) => [shape.id, shape.type]))
          && doc.source?.kind === 'human-panel' && doc.source.panelId === panelId
          && doc.source.surface === 'main' && doc.source.clientRevision === 1 && doc.source.trusted === false,
      { status: first.statusCode, revision: doc.revision, source: doc.source, ids: doc.shapes?.map((shape) => shape.id) }, 'accepted 6 shapes');

      const geometry = Object.fromEntries(doc.shapes.map((shape) => [shape.id, shape]));
      check('矩形/椭圆/线段/画笔几何逐项读回（rect x/y/w/h、ellipse cx/cy/rx/ry、line 端点、brush 点数组）',
        JSON.stringify([geometry.a1?.x, geometry.a1?.y, geometry.a1?.width, geometry.a1?.height]) === JSON.stringify([10, 20, 100, 50])
          && JSON.stringify([geometry.a2?.cx, geometry.a2?.cy, geometry.a2?.rx, geometry.a2?.ry]) === JSON.stringify([200, 120, 40, 25])
          && JSON.stringify([geometry.a3?.x1, geometry.a3?.y1, geometry.a3?.x2, geometry.a3?.y2]) === JSON.stringify([0, 0, 100, 100])
          && JSON.stringify(geometry.a5?.points) === JSON.stringify([[0, 0], [5, 5], [10, 12]])
          && geometry.a2.fill === true && geometry.a2.stroke === false
          && geometry.a5.fill === false && geometry.a5.stroke === true,
      { a1: geometry.a1, a2: geometry.a2, a3: geometry.a3, a5: geometry.a5 }, 'per-type geometry');

      check('箭头头部由 Host 重算（L=√(50²+60²)≈78.1、t=5 → length=15/width=10，客户端 9999 不被信任）；文字保持原文（中文/<>&/引号）且 fontSize=20、fill=true/stroke=false',
        geometry.a4?.head?.length === 15 && geometry.a4?.head?.width === 10
          && JSON.stringify([geometry.a4.x1, geometry.a4.y1, geometry.a4.x2, geometry.a4.y2]) === JSON.stringify([10, 10, 60, 70])
          && geometry.a6?.text === '问题在这里 <> & "quoted"' && geometry.a6?.fontSize === 20
          && geometry.a6.fill === true && geometry.a6.stroke === false
          && JSON.stringify([geometry.a6.x, geometry.a6.y]) === JSON.stringify([30, 40]),
      { head: geometry.a4?.head, text: geometry.a6?.text, fontSize: geometry.a6?.fontSize }, 'arrow head recomputed + verbatim text');

      const storedView = doc.view || {};
      const publishedContext = doc.context || {};
      check('view 存客户端已接受的快照（canvasX/canvasY/x/y/w/h/scale/contentSize/viewRevision，frameEpoch=null）且 context 五项与 ui.annotationContext 同源、addressDigest 为 64 hex 不含地址',
        storedView.canvasX === -100 && storedView.canvasY === 10 && storedView.x === 0 && storedView.y === 60
          && storedView.width === 800 && storedView.height === 600 && storedView.scale === 1
          && Number.isFinite(storedView.contentWidth) && Number.isFinite(storedView.contentHeight)
          && Number.isSafeInteger(storedView.viewRevision) && storedView.frameEpoch === null
          && publishedContext.runtimeId === stateA.ui.annotationContext.runtimeId
          && publishedContext.documentKey === stateA.ui.annotationContext.documentKey
          && publishedContext.pageGeneration === stateA.ui.annotationContext.pageGeneration
          && publishedContext.documentEpoch === stateA.ui.annotationContext.documentEpoch
          && publishedContext.addressDigest === stateA.ui.annotationContext.addressDigest
          && /^[0-9a-f]{64}$/u.test(publishedContext.addressDigest)
          && !JSON.stringify(publishedContext).includes('http') && !JSON.stringify(publishedContext).includes('127.0.0.1'),
      { view: storedView, context: publishedContext }, 'accepted snapshot + context');

      const stateTool = await harness.invoke('browser_state', {}, execA);
      check('browser_state 顶层 annotations 与发布结果同源（同一 revision/shapes/source），且不泄露 sessionId/cwd/地址',
        stateTool.ok === true && stateTool.value?.annotations?.revision === doc.revision
          && stateTool.value.annotations.shapes.length === 6
          && stateTool.value.annotations.source?.panelId === panelId
          && stateTool.value.annotations.context?.documentKey === stateA.ui.annotationContext.documentKey
          && !JSON.stringify(stateTool.value.annotations).includes('127.0.0.1')
          && !JSON.stringify(stateTool.value.annotations).includes('cwd'),
      { annotations: stateTool.value?.annotations }, 'browser_state projection');

      const offsetX = storedView.canvasX - storedView.x;
      const offsetY = storedView.canvasY - storedView.y;
      const point = { x: geometry.a1.x, y: geometry.a1.y };
      const pagePoint = { x: point.x - storedView.x, y: point.y - storedView.y };
      const q = { x: point.x - storedView.canvasX, y: point.y - storedView.canvasY };
      const p = { x: q.x + offsetX, y: q.y + offsetY };
      check('负 C 快照下坐标换算自洽：p=d−S=q+O（d=(10,20) → q=(110,10) → O=(-100,-50) → p=(10,-40)，p 在视口外即不可派发）',
        q.x === 110 && q.y === 10 && offsetX === -100 && offsetY === -50
          && p.x === pagePoint.x && p.y === pagePoint.y && p.x === 10 && p.y === -40,
      { d: point, q, offset: { x: offsetX, y: offsetY }, p, pagePoint }, { q: [110, 10], p: [10, -40] });

      counter.reset();
      const second = await publishAnnotations(annotationPublishBody(stateA, {
        panelId, clientRevision: 2, shapes: [{ ...annotationShapes()[0], id: 'a7' }],
      }));
      const publishSends = counter.total();
      const domAfter = (await harness.invoke('browser_eval', {
        expression: '({ annotNodes: document.querySelectorAll("[data-utb-annot], [data-utb-annot-layer]").length, scrollX: window.scrollX, scrollY: window.scrollY, innerWidth: window.innerWidth, dpr: window.devicePixelRatio })',
      }, execA)).value?.value;
      check('第二次发布（新 clientRevision）→ revision 2 且 updatedAt 为 epoch ms，shapes=1；发布零 CDP，页面 DOM/滚动/视口/DPR 不变',
        second.statusCode === 200 && second.json?.annotations?.revision === 2
          && Number.isSafeInteger(second.json.annotations.updatedAt)
          && second.json.annotations.shapes.length === 1
          && publishSends === 0
          && JSON.stringify(domAfter) === JSON.stringify(domBefore) && domAfter?.annotNodes === 0,
      { revision: second.json?.annotations?.revision, updatedAt: second.json?.annotations?.updatedAt, publishSends, domBefore, domAfter },
      { revision: 2, publishSends: 0, dom: 'unchanged' });
    });

  /* ---------------------------------------------------------------- A3: limits + refusals */
  await runProbe('A3-annotation-limits', '软限额裁剪、非法结构硬拒绝与 lossless 投影',
    '130 形状保留最新 128（droppedShapes=2）；画笔 600 点降采样到 512 保首末（droppedPoints=88）；16×512 点按最旧整形状裁剪到 ≤8192；整文档 ≤65536 字节且不留半个形状；客户端 truncation 与 Host 新增合并不重复累计；300 码元文字裁到 200 不拆代理对；11 条非法结构全部 400（field/reason，不回显原文）且零写入；ACK 与 browser_state 过真实 snapshotJsonValue/isJsonValue', async () => {
      const ui = await readScopedState(ANNOT_HEADERS_A);
      const panelId = panelIdFor(2);
      const baselineRevision = ui?.annotations?.revision ?? 0;
      let revision = 1;
      const publish = async (shapes, extra = {}) => {
        const result = await publishAnnotations(annotationPublishBody(ui, {
          panelId, clientRevision: revision, shapes, ...extra,
        }));
        revision += 1;
        return result;
      };

      const many = Array.from({ length: 130 }, (_, index) => ({
        id: 'a' + (index + 1), type: 'rect', color: '#ff3b30', strokeWidth: 3, fill: false, stroke: true,
        x: index, y: index, width: 10, height: 10,
      }));
      const capped = await publish(many);
      const cappedDoc = capped.json?.annotations || {};
      check('130 形状 → 保留最新 128（a3…a130）：droppedShapes=2、truncated=true、revision+1',
        capped.statusCode === 200 && cappedDoc.shapes?.length === 128
          && cappedDoc.shapes[0]?.id === 'a3' && cappedDoc.shapes[127]?.id === 'a130'
          && cappedDoc.truncation?.droppedShapes === 2 && cappedDoc.truncated === true
          && cappedDoc.revision === baselineRevision + 1,
      { length: cappedDoc.shapes?.length, first: cappedDoc.shapes?.[0]?.id, last: cappedDoc.shapes?.[127]?.id, truncation: cappedDoc.truncation, revision: cappedDoc.revision },
      { length: 128, first: 'a3', last: 'a130', droppedShapes: 2 });

      const longBrush = {
        id: 'a1', type: 'brush', color: '#af52de', strokeWidth: 2, fill: false, stroke: true,
        points: Array.from({ length: 600 }, (_, index) => [index, index * 2]),
      };
      const downsampled = await publish([longBrush]);
      const brush = downsampled.json?.annotations?.shapes?.[0];
      check('画笔 600 点 → 均匀降采样到 512 点，保留首点与末点，droppedPoints=88',
        downsampled.statusCode === 200 && brush?.points?.length === 512
          && JSON.stringify(brush.points[0]) === JSON.stringify([0, 0])
          && JSON.stringify(brush.points[511]) === JSON.stringify([599, 1198])
          && downsampled.json.annotations.truncation?.droppedPoints === 88
          && downsampled.json.annotations.truncated === true,
      { length: brush?.points?.length, first: brush?.points?.[0], last: brush?.points?.[511], truncation: downsampled.json?.annotations?.truncation },
      { length: 512, first: [0, 0], last: [599, 1198], droppedPoints: 88 });

      const heavy = Array.from({ length: 17 }, (_, index) => ({
        id: 'a' + (index + 1), type: 'brush', color: '#0a84ff', strokeWidth: 1, fill: false, stroke: true,
        points: Array.from({ length: 512 }, (_, point) => [point, point + index]),
      }));
      const budgeted = await publish(heavy);
      const budgetDoc = budgeted.json?.annotations || {};
      const totalPoints = (budgetDoc.shapes || []).reduce((sum, shape) => sum + (shape.type === 'brush' ? shape.points.length : 0), 0);
      check('点/字节预算：17×512 点文档按最旧整形状逐个移除，保留集 ≤8192 点且每笔仍是 512 点（droppedPoints 不重复计）',
        budgeted.statusCode === 200 && budgetDoc.shapes.length < 17 && budgetDoc.shapes.length >= 1
          && totalPoints <= 8192 && totalPoints === budgetDoc.shapes.length * 512
          && budgetDoc.truncation?.droppedShapes === 17 - budgetDoc.shapes.length
          && budgetDoc.truncation?.droppedPoints === 0
          && budgetDoc.truncated === true,
      { kept: budgetDoc.shapes?.length, totalPoints, truncation: budgetDoc.truncation },
      { kept: '<17', totalPoints: '<=8192', droppedPoints: 0 });

      const serialized = Buffer.byteLength(JSON.stringify(budgetDoc), 'utf8');
      const shapesAreWhole = (budgetDoc.shapes || []).every((shape) => shape.type !== 'brush'
        || (Array.isArray(shape.points) && shape.points.length >= 2
          && shape.points.every((pair) => Array.isArray(pair) && pair.length === 2 && Number.isFinite(pair[0]) && Number.isFinite(pair[1]))));
      check('整份 annotations 文档 ≤65536 字节，且每个保留下来的画笔都是完整点数组（不截半个 JSON/坐标对象）',
        serialized <= 65536 && shapesAreWhole, { bytes: serialized, kept: budgetDoc.shapes?.length, shapesAreWhole },
        { maxBytes: 65536, shapesAreWhole: true });

      const merged = await publish(many, { truncation: { droppedShapes: 5, droppedPoints: 7, shortenedTextCodeUnits: 3 } });
      const mergedTruncation = merged.json?.annotations?.truncation || {};
      check('客户端 truncation(5/7/3) 与 Host 新增(2) 合并且不重复累计 → 7/7/3',
        merged.statusCode === 200 && mergedTruncation.droppedShapes === 7
          && mergedTruncation.droppedPoints === 7 && mergedTruncation.shortenedTextCodeUnits === 3
          && merged.json.annotations.shapes.length === 128,
      { truncation: mergedTruncation }, { droppedShapes: 7, droppedPoints: 7, shortenedTextCodeUnits: 3 });

      const ascii = await publish([{
        id: 'a1', type: 'text', color: '#000000', strokeWidth: 1, fill: true, stroke: false,
        x: 0, y: 0, fontSize: 20, text: 'x'.repeat(300),
      }]);
      const emoji = await publish([{
        id: 'a1', type: 'text', color: '#000000', strokeWidth: 1, fill: true, stroke: false,
        x: 0, y: 0, fontSize: 20, text: '😀'.repeat(150),
      }]);
      const asciiText = ascii.json?.annotations?.shapes?.[0]?.text || '';
      const emojiText = emoji.json?.annotations?.shapes?.[0]?.text || '';
      const loneSurrogate = /[\uD800-\uDBFF]$|^[\uDC00-\uDFFF]/u.test(emojiText);
      check('文字 300 UTF-16 码元 → 截到 200（shortenedTextCodeUnits=100），代理对不被拆开（150 emoji → 100 emoji，无孤立代理）',
        ascii.statusCode === 200 && asciiText.length === 200
          && ascii.json.annotations.truncation?.shortenedTextCodeUnits === 100
          && emojiText.length === 200 && [...emojiText].length === 100 && loneSurrogate === false
          && emoji.json.annotations.truncation?.shortenedTextCodeUnits === 100,
      { asciiLength: asciiText.length, emojiUnits: emojiText.length, emojiCodePoints: [...emojiText].length, loneSurrogate, truncations: [ascii.json?.annotations?.truncation, emoji.json?.annotations?.truncation] },
      { asciiLength: 200, emojiUnits: 200, emojiCodePoints: 100, shortenedTextCodeUnits: 100 });

      const before = (await readScopedState(ANNOT_HEADERS_A)).annotations;
      const goodShape = annotationShapes()[0];
      const body = (mutate) => {
        const base = annotationPublishBody(ui, { panelId, clientRevision: revision, shapes: [goodShape] });
        mutate(base);
        return base;
      };
      const rawProto = JSON.stringify(annotationPublishBody(ui, {
        panelId, clientRevision: revision, shapes: [{ ...goodShape, evilMarker: 'SECRET-ECHO-MUST-NOT-APPEAR' }],
      })).replace('"evilMarker"', '"__proto__"');
      const invalidCases = [
        ['unknown-field', { body: body((input) => { input.extra = 1; }) }],
        ['invalid-enum(type)', { body: body((input) => { input.shapes[0].type = 'sticker'; }) }],
        ['duplicate-id', { body: body((input) => { input.shapes.push({ ...goodShape }); }) }],
        ['not-finite(strokeWidth)', { body: body((input) => { input.shapes[0].strokeWidth = '3'; }) }],
        ['out-of-range(strokeWidth 21)', { body: body((input) => { input.shapes[0].strokeWidth = 21; }) }],
        ['invalid-enum(surface)', { body: body((input) => { input.surface = 'popup'; }) }],
        ['release-requires-empty-shapes', { body: body((input) => { input.release = true; }) }],
        ['unsupported-version', { body: body((input) => { input.version = 2; }) }],
        ['prototype-pollution', { rawBody: rawProto }],
        ['not-json', { rawBody: '{not json' }],
        ['body-too-large', { rawBody: JSON.stringify(annotationPublishBody(ui, { panelId, clientRevision: revision, shapes: [goodShape] })) + ' '.repeat(262144) }],
      ];
      const invalidResults = [];
      for (const [label, options] of invalidCases) {
        const result = await publishAnnotations(options.body, options);
        invalidResults.push({
          label,
          status: result.statusCode,
          code: result.json?.code,
          reason: result.json?.details?.reason,
          detailKeys: Object.keys(result.json?.details || {}).sort(),
          echo: JSON.stringify(result.json).includes('SECRET-ECHO-MUST-NOT-APPEAR'),
        });
      }
      const after = (await readScopedState(ANNOT_HEADERS_A)).annotations;
      check('11 条非法结构全部 400 INVALID_ARGUMENT，details 只有 field/reason/limits 且不回显原文，Host 文档零写入',
        invalidResults.every((item) => item.status === 400 && item.code === 'INVALID_ARGUMENT'
          && typeof item.reason === 'string' && item.reason.length > 0
          && JSON.stringify(item.detailKeys) === JSON.stringify(['field', 'limits', 'reason'])
          && item.echo === false)
          && after.revision === before.revision && after.updatedAt === before.updatedAt,
      { invalidResults, revisionBefore: before.revision, revisionAfter: after.revision }, '400 × 11, zero writes');

      const { loadValidator } = await import(pathToFileURL(join(HERE, 'host-contract.mjs')).href);
      const validator = await loadValidator();
      const ackSnapshot = validator.snapshotJsonValue(capped.json);
      const stateValue = (await harness.invoke('browser_state', {}, execA)).value;
      const stateSnapshot = validator.snapshotJsonValue(stateValue);
      check('ACK 与 browser_state 的 annotations 投影通过真实 snapshotJsonValue/isJsonValue（无 undefined/非有限数/类实例）',
        validator.real === true && ackSnapshot !== undefined && stateSnapshot !== undefined
          && validator.isJsonValue(capped.json) === true && validator.isJsonValue(stateValue) === true
          && losslessProblem(stateValue?.annotations ?? {}) === null,
      { validatorReal: validator.real, version: validator.version, ackOk: ackSnapshot !== undefined, stateOk: stateSnapshot !== undefined },
      { validatorReal: true, ackOk: true, stateOk: true });
    });

  /* ---------------------------------------------------------------- A4: lifecycle / rotation */
  await runProbe('A4-annotation-lifecycle', 'documentKey 轮换与清空：导航/同文档 URL/hash/reload/关闭/跨 scope',
    '哈希变化旋转 key 并清空文档；旧 key 重放 → 409 annotation-context-stale 零写入；跨文档导航与 reload 再旋转清空；跨 scope 互不影响；close 后清空+stale=not-running+发布 400；重开后可再发布且 key 变化', async () => {
      const nav = await harness.invoke('browser_navigate', { url: pageUrl }, execA);
      await waitFor(async () => (await pageTruth(harness, execA))?.title === 'P0 Capture Fixture', { label: 'fixture title' });
      const base = await readScopedState(ANNOT_HEADERS_A);
      const baseRevision = base.annotations.revision;
      const firstPublish = await publishAnnotations(annotationPublishBody(base, {
        panelId: panelIdFor(3), clientRevision: 1, shapes: annotationShapes().slice(0, 2),
      }));
      const firstDoc = firstPublish.json?.annotations || {};
      check('基准发布：文档 context.documentKey 等于 ui.annotationContext，含 2 个形状，revision=基线+1、stale=false',
        nav.ok === true && firstPublish.statusCode === 200 && firstDoc.shapes?.length === 2
          && firstDoc.context?.documentKey === base.ui.annotationContext.documentKey
          && firstDoc.revision === baseRevision + 1 && firstDoc.stale === false,
      { documentKey: firstDoc.context?.documentKey, revision: firstDoc.revision, baseRevision, stale: firstDoc.stale }, 'published baseline');

      await harness.invoke('browser_eval', { expression: 'location.hash = "#annot-hash"; 1' }, execA);
      const hashState = await waitFor(async () => {
        const snapshot = await readScopedState(ANNOT_HEADERS_A);
        return snapshot?.ui?.annotationContext?.documentKey !== base.ui.annotationContext.documentKey ? snapshot : null;
      }, { timeoutMs: 4000, intervalMs: 100, label: 'hash change rotates documentKey' });
      check('同文档 hash 变化：documentKey 轮换、标注清空、revision 递增（内容变更可见）',
        hashState?.annotations?.shapes?.length === 0 && hashState?.annotations?.source === null
          && hashState?.annotations?.revision === firstDoc.revision + 1
          && hashState?.annotations?.stale === false,
      { annotations: hashState?.annotations, key: hashState?.ui?.annotationContext?.documentKey },
      { shapes: 0, source: null, revision: 'R+1' });

      const replay = await publishAnnotations(annotationPublishBody(base, {
        panelId: panelIdFor(3), clientRevision: 2, shapes: annotationShapes().slice(0, 2),
      }));
      const afterReplay = await readScopedState(ANNOT_HEADERS_A);
      check('用已轮换掉的旧 context 重放 → 409 annotation-context-stale，且零写入（revision 与 shapes 不变）',
        replay.statusCode === 409 && replay.json?.code === 'INVALID_ARGUMENT'
          && replay.json?.details?.reason === 'annotation-context-stale'
          && afterReplay?.annotations?.revision === hashState?.annotations?.revision
          && afterReplay?.annotations?.shapes?.length === 0,
      { status: replay.statusCode, body: replay.json, revision: afterReplay?.annotations?.revision },
      { status: 409, reason: 'annotation-context-stale' });

      const hashKey = afterReplay.ui.annotationContext.documentKey;
      const secondPublish = await publishAnnotations(annotationPublishBody(afterReplay, {
        panelId: panelIdFor(3), clientRevision: 1, shapes: annotationShapes().slice(0, 3),
      }));
      const nav2 = await harness.invoke('browser_navigate', { url: pageUrl }, execA);
      const navigatedState = await waitFor(async () => {
        const snapshot = await readScopedState(ANNOT_HEADERS_A);
        return snapshot?.ui?.annotationContext?.documentKey !== hashKey ? snapshot : null;
      }, { timeoutMs: 5000, intervalMs: 100, label: 'cross-document navigation rotates documentKey' });
      check('新 key 下可继续发布（3 个形状）；随后跨文档导航：documentKey 再轮换、标注清空、revision 继续递增',
        secondPublish.statusCode === 200 && secondPublish.json?.annotations?.shapes?.length === 3
          && secondPublish.json.annotations.context.documentKey === hashKey
          && nav2.ok === true && navigatedState?.annotations?.shapes?.length === 0
          && navigatedState?.annotations?.source === null
          && navigatedState?.annotations?.revision > secondPublish.json?.annotations?.revision,
      { publishShapes: secondPublish.json?.annotations?.shapes?.length, annotations: navigatedState?.annotations, key: navigatedState?.ui?.annotationContext?.documentKey },
      { publish: 3, shapes: 0, source: null });

      const navKey = navigatedState.ui.annotationContext.documentKey;
      await publishAnnotations(annotationPublishBody(navigatedState, {
        panelId: panelIdFor(4), clientRevision: 1, shapes: annotationShapes().slice(0, 1),
      }));
      harness.setConnection(annotOwner());
      let reloadResponse;
      try {
        reloadResponse = await harness.request({ method: 'POST', path: '/plugins/ui-testing/reload', headers: ANNOT_HEADERS_A, body: {} });
      } finally { harness.setConnection(undefined); }
      const reloadedState = await waitFor(async () => {
        const snapshot = await readScopedState(ANNOT_HEADERS_A);
        return snapshot?.ui?.annotationContext?.documentKey !== navKey ? snapshot : null;
      }, { timeoutMs: 8000, intervalMs: 120, label: 'reload rotates documentKey' });
      const staleAfterReload = await publishAnnotations(annotationPublishBody(navigatedState, {
        panelId: panelIdFor(4), clientRevision: 2, shapes: annotationShapes().slice(0, 1),
      }));
      check('同地址 reload（新文档代次）：200 且 documentKey 轮换、标注清空；旧 key/旧代次重放 → 409 annotation-context-stale 零写入',
        reloadResponse.statusCode === 200 && reloadedState?.annotations?.shapes?.length === 0
          && reloadedState?.annotations?.source === null
          && staleAfterReload.statusCode === 409
          && staleAfterReload.json?.details?.reason === 'annotation-context-stale'
          && (await readScopedState(ANNOT_HEADERS_A))?.annotations?.shapes?.length === 0,
      { reload: reloadResponse.statusCode, annotations: reloadedState?.annotations, stale: staleAfterReload.json?.details?.reason },
      { shapes: 0, source: null, stale: 409 });

      const navB = await harness.invoke('browser_navigate', { url: pageUrl }, execB);
      const stateB = await readScopedState(ANNOT_HEADERS_B);
      const publishB = await publishAnnotations(annotationPublishBody(stateB, {
        panelId: panelIdFor(5), clientRevision: 1, shapes: annotationShapes().slice(0, 4),
      }), { headers: ANNOT_HEADERS_B });
      const stateAAfterB = await readScopedState(ANNOT_HEADERS_A);
      const stateBTool = await harness.invoke('browser_state', {}, execB);
      check('跨 scope 隔离：B 的发布不影响 A（A 仍空、key 不同、runtimeId 不同），B 自己读回 4 个形状',
        navB.ok === true && publishB.statusCode === 200
          && publishB.json?.annotations?.shapes?.length === 4
          && stateBTool.value?.annotations?.shapes?.length === 4
          && stateAAfterB?.annotations?.shapes?.length === 0
          && stateB.ui.annotationContext.documentKey !== stateAAfterB.ui.annotationContext.documentKey
          && stateB.ui.annotationContext.runtimeId !== stateAAfterB.ui.annotationContext.runtimeId,
      { A: stateAAfterB?.annotations?.revision, B: publishB.json?.annotations?.revision, keys: [stateB.ui.annotationContext.documentKey, stateAAfterB.ui.annotationContext.documentKey] },
      { A: 'untouched', B: '4 shapes' });

      const beforeCloseKey = stateAAfterB.ui.annotationContext.documentKey;
      const publishedBeforeClose = await publishAnnotations(annotationPublishBody(stateAAfterB, {
        panelId: panelIdFor(6), clientRevision: 1, shapes: annotationShapes().slice(0, 2),
      }));
      // Abrupt CDP disconnect (not the graceful /close below): the very first read must already
      // report the document as gone and stale, and a publish must be refused with zero writes.
      const runtimeForClose = runtimeByWorkspace('ws-a');
      runtimeForClose.cdp.close();
      const disconnectedState = await readScopedState(ANNOT_HEADERS_A);
      const disconnectedPublish = await publishAnnotations(annotationPublishBody(stateAAfterB, {
        panelId: panelIdFor(6), clientRevision: 2, shapes: annotationShapes().slice(0, 1),
      }));
      harness.setConnection(annotOwner());
      let closeResponse;
      try {
        closeResponse = await harness.request({ method: 'POST', path: '/plugins/ui-testing/close', headers: ANNOT_HEADERS_A, body: {} });
      } finally { harness.setConnection(undefined); }
      const closedState = await readScopedState(ANNOT_HEADERS_A);
      const closedPublish = await publishAnnotations(annotationPublishBody(closedState, {
        panelId: panelIdFor(6), clientRevision: 2, shapes: annotationShapes().slice(0, 2),
      }));
      check('CDP 断连与 /close 都清空标注并拒绝发布：stale=true/not-running、400 annotation-runtime-not-running 零写入',
        publishedBeforeClose.json?.annotations?.shapes?.length === 2
          && disconnectedState?.annotations?.shapes?.length === 0
          && disconnectedState?.annotations?.source === null
          && disconnectedState?.annotations?.stale === true
          && disconnectedState.annotations.staleReason === 'not-running'
          && disconnectedState.annotations.revision === publishedBeforeClose.json?.annotations?.revision + 1
          && disconnectedPublish.statusCode === 400
          && disconnectedPublish.json?.details?.reason === 'annotation-runtime-not-running'
          && closeResponse.statusCode === 200 && closedState?.annotations?.shapes?.length === 0
          && closedState?.annotations?.stale === true && closedState.annotations.staleReason === 'not-running'
          && closedState?.annotations?.source === null
          && closedPublish.statusCode === 400
          && closedPublish.json?.details?.reason === 'annotation-runtime-not-running'
          && (await readScopedState(ANNOT_HEADERS_A))?.annotations?.revision === closedState.annotations.revision,
      { disconnected: disconnectedState?.annotations, disconnectedPublish: disconnectedPublish.json?.details?.reason,
        close: closeResponse.statusCode, closed: closedState?.annotations, publish: closedPublish.json?.details?.reason },
      { stale: true, staleReason: 'not-running', publish: 400 });

      const reopened = await harness.invoke('browser_navigate', { url: pageUrl }, execA);
      await waitFor(async () => (await pageTruth(harness, execA))?.title === 'P0 Capture Fixture', { label: 'fixture title after reopen' });
      const reopenedState = await readScopedState(ANNOT_HEADERS_A);
      const reopenedPublish = await publishAnnotations(annotationPublishBody(reopenedState, {
        panelId: panelIdFor(7), clientRevision: 1, shapes: annotationShapes().slice(0, 5),
      }));
      check('重开后 key 变化、pageGeneration 前进，且可再次发布（5 个形状，stale=false）',
        reopened.ok === true
          && reopenedState.ui.annotationContext.documentKey !== beforeCloseKey
          && reopenedState.ui.annotationContext.pageGeneration > 0
          && reopenedPublish.statusCode === 200 && reopenedPublish.json?.annotations?.shapes?.length === 5
          && reopenedPublish.json.annotations.stale === false,
      { key: reopenedState.ui.annotationContext.documentKey, beforeCloseKey, generation: reopenedState.ui.annotationContext.pageGeneration, status: reopenedPublish.statusCode },
      { shapes: 5, stale: false });
    });

  /* ---------------------------------------------------------------- A5: revisions / panels / stale */
  await runProbe('A5-annotation-revisions', 'clientRevision 幂等/迟到、多 panel 水位、release、失败不污染 lastError、心跳与 stale',
    '同号同内容幂等 ACK；同号异内容 400；低号 200 ignored 不覆盖；新号 accepted 且 revision+1；另一 panel 可成为最近版本；第 17 个 panel 400 annotation-source-limit；release 只清自己 panel 的文档；匹配心跳刷新 lastSeenAt、30s 无匹配心跳 → stale=panel-unseen；全过程 lastError 保持空', async () => {
      const ui = await readScopedState(ANNOT_HEADERS_A);
      const runtimeA = runtimeByWorkspace('ws-a');
      const p1 = panelIdFor(11);
      const p2 = panelIdFor(12);
      const shapesTwo = annotationShapes().slice(0, 2);
      const shapesOne = annotationShapes().slice(0, 1);

      const accepted1 = await publishAnnotations(annotationPublishBody(ui, { panelId: p1, clientRevision: 1, shapes: shapesTwo }));
      const idempotent = await publishAnnotations(annotationPublishBody(ui, { panelId: p1, clientRevision: 1, shapes: shapesTwo }));
      const conflict = await publishAnnotations(annotationPublishBody(ui, { panelId: p1, clientRevision: 1, shapes: shapesOne }));
      check('panel P1 rev1 首次接受；同号同内容幂等 ACK（accepted=true/ignored=true，revision 不变）；同号异内容 400 annotation-client-revision-conflict 零写入',
        accepted1.statusCode === 200 && accepted1.json?.accepted === true && accepted1.json?.ignored === false
          && idempotent.statusCode === 200 && idempotent.json?.accepted === true && idempotent.json?.ignored === true
          && idempotent.json?.annotations?.revision === accepted1.json?.annotations?.revision
          && conflict.statusCode === 400 && conflict.json?.details?.reason === 'annotation-client-revision-conflict'
          && JSON.stringify(conflict.json?.details ? Object.keys(conflict.json.details).sort() : []) === JSON.stringify(['field', 'limits', 'reason']),
      { accepted: accepted1.json?.annotations?.revision, idempotent: idempotent.json?.annotations?.revision, conflict: conflict.json?.details },
      { idempotentIgnored: true, conflict: 400 });

      const accepted3 = await publishAnnotations(annotationPublishBody(ui, { panelId: p1, clientRevision: 3, shapes: shapesOne }));
      const late = await publishAnnotations(annotationPublishBody(ui, { panelId: p1, clientRevision: 2, shapes: shapesTwo }));
      check('P1 rev3 接受后 rev2 迟到 → 200 accepted=false/ignored=true，不覆盖（revision/shapes 保持 rev3 的内容）',
        accepted3.statusCode === 200 && late.statusCode === 200
          && late.json?.accepted === false && late.json?.ignored === true
          && late.json?.clientRevision === 3
          && late.json?.annotations?.revision === accepted3.json?.annotations?.revision
          && late.json?.annotations?.shapes?.length === 1
          && late.json?.annotations?.source?.clientRevision === 3,
      { late: { accepted: late.json?.accepted, ignored: late.json?.ignored, clientRevision: late.json?.clientRevision }, revision: late.json?.annotations?.revision },
      { accepted: false, ignored: true });

      const p2Publish = await publishAnnotations(annotationPublishBody(ui, { panelId: p2, clientRevision: 1, shapes: shapesTwo }));
      check('另一 panel P2 发布成功并成为最近版本（shapes 2、source.panelId=P2、revision+1）',
        p2Publish.statusCode === 200 && p2Publish.json?.annotations?.shapes?.length === 2
          && p2Publish.json.annotations.source.panelId === p2
          && p2Publish.json.annotations.revision === accepted3.json.annotations.revision + 1,
      { source: p2Publish.json?.annotations?.source, revision: p2Publish.json?.annotations?.revision },
      { panelId: p2, revision: 'prev+1' });

      const panelResults = [];
      for (let index = 13; index <= 26; index += 1) {
        const result = await publishAnnotations(annotationPublishBody(ui, { panelId: panelIdFor(index), clientRevision: 1, shapes: shapesOne }));
        panelResults.push({ panel: index, status: result.statusCode, reason: result.json?.details?.reason ?? null });
      }
      const acceptedPanels = panelResults.filter((item) => item.status === 200).length;
      const rejectedPanels = panelResults.filter((item) => item.status === 400 && item.reason === 'annotation-source-limit').length;
      check('panel 水位 16：本轮接受的 panel 恰好把水位补满到 16，其余全部 400 annotation-source-limit（满额拒新来源）',
        // P1 + P2 were registered before this loop, hence "3 + accepted" counts the fresh panel too.
        acceptedPanels >= 1 && 3 + acceptedPanels === 16
          && rejectedPanels === panelResults.length - acceptedPanels
          && panelResults.slice(acceptedPanels).every((item) => item.reason === 'annotation-source-limit'),
      { acceptedPanels, rejectedPanels, first: panelResults[0], last: panelResults[panelResults.length - 1] },
      { watermark: 16, rejectedReason: 'annotation-source-limit' });

      const lastAcceptedPanel = panelResults[acceptedPanels - 1].panel;
      const releaseOthers = await publishAnnotations(annotationPublishBody(ui, { panelId: p2, clientRevision: 2, shapes: [], release: true }));
      check('release 只清自己 panel 的文档：当前文档属于水位内最后一个 panel 时，P2 的 release 被 ignore（shapes 不变）',
        releaseOthers.statusCode === 200 && releaseOthers.json?.accepted === false
          && releaseOthers.json?.ignored === true
          && releaseOthers.json?.annotations?.shapes?.length === 1,
      { body: { accepted: releaseOthers.json?.accepted, ignored: releaseOthers.json?.ignored }, shapes: releaseOthers.json?.annotations?.shapes?.length },
      { accepted: false, ignored: true, shapes: 1 });

      const owner = panelIdFor(lastAcceptedPanel);
      const releaseOwn = await publishAnnotations(annotationPublishBody(ui, { panelId: owner, clientRevision: 2, shapes: [], release: true }));
      check('文档所属 panel 的 release:true 立即成为最近版本（shapes=[]、release 后仍是有效文档、source 保留）',
        releaseOwn.statusCode === 200 && releaseOwn.json?.accepted === true
          && releaseOwn.json?.annotations?.shapes?.length === 0
          && releaseOwn.json?.annotations?.truncated === false
          && releaseOwn.json?.annotations?.source?.panelId === owner,
      { annotations: releaseOwn.json?.annotations }, { shapes: 0, accepted: true });

      const republish = await publishAnnotations(annotationPublishBody(ui, { panelId: p1, clientRevision: 4, shapes: shapesOne }));
      const documentKey = republish.json?.annotations?.context?.documentKey;
      harness.setConnection(annotOwner());
      let matched;
      let unmatched;
      try {
        matched = await harness.request({
          method: 'POST', path: '/plugins/ui-testing/metrics',
          headers: ANNOT_HEADERS_A,
          body: { transport: 'ws', annotationPanelId: p1, annotationClientRevision: 4, documentKey },
        });
        unmatched = await harness.request({
          method: 'POST', path: '/plugins/ui-testing/metrics',
          headers: ANNOT_HEADERS_A,
          body: { transport: 'ws', annotationPanelId: p2, annotationClientRevision: 4, documentKey },
        });
      } finally { harness.setConnection(undefined); }
      const afterMatched = (await readScopedState(ANNOT_HEADERS_A)).annotations;
      runtimeA.annot.lastSeenAt = Date.now() - 31000;
      runtimeA.annot.document.updatedAt = Date.now() - 31000;
      const staleState = (await readScopedState(ANNOT_HEADERS_A)).annotations;
      harness.setConnection(annotOwner());
      try {
        await harness.request({
          method: 'POST', path: '/plugins/ui-testing/metrics',
          headers: ANNOT_HEADERS_A,
          body: { transport: 'ws', annotationPanelId: p1, annotationClientRevision: 4, documentKey },
        });
      } finally { harness.setConnection(undefined); }
      const revived = (await readScopedState(ANNOT_HEADERS_A)).annotations;
      check('心跳：匹配 source+已 ACK revision 的 /metrics 心跳让文档保持新鲜；30s 无匹配心跳 → stale=panel-unseen；再来一次匹配心跳恢复 fresh',
        matched.statusCode === 200 && unmatched.statusCode === 200
          && afterMatched.stale === false
          && staleState.stale === true && staleState.staleReason === 'panel-unseen'
          && revived.stale === false && revived.revision === staleState.revision
          && JSON.stringify(revived.shapes) === JSON.stringify(staleState.shapes),
      { afterMatched: afterMatched.stale, stale: staleState.stale, staleReason: staleState.staleReason, revived: revived.stale },
      { stale: true, staleReason: 'panel-unseen', revived: false });

      // A plain empty publish (no `release`) is the panel's "clear the canvas" / "exit the mode"
      // flush path (§11.4): it must become the newest document, not a no-op.
      const revisionBeforeClear = (await readScopedState(ANNOT_HEADERS_A)).annotations.revision;
      const cleared = await publishAnnotations(annotationPublishBody(ui, { panelId: p1, clientRevision: 5, shapes: [] }));
      const finalState = await readScopedState(ANNOT_HEADERS_A);
      const stateTool = await harness.invoke('browser_state', {}, execA);
      check('清空（release=false 的空 shapes 发布）成为最新文档且 lastError 全程为空：browser_state.annotations 与 /state 同源',
        cleared.statusCode === 200 && cleared.json?.accepted === true
          && cleared.json?.annotations?.shapes?.length === 0 && cleared.json?.annotations?.truncated === false
          && cleared.json?.annotations?.revision === revisionBeforeClear + 1
          && stateTool.ok === true && stateTool.value?.error === ''
          && stateTool.value?.annotations?.revision === finalState?.annotations?.revision
          && stateTool.value?.annotations?.shapes?.length === finalState?.annotations?.shapes?.length
          && finalState?.annotations?.shapes?.length === 0,
      { cleared: cleared.json?.annotations, error: stateTool.value?.error, state: finalState?.annotations },
      { shapes: 0, error: '', consistent: true });
    });

  log('\n[cleanup] closing browsers and fixture');
  state.cleanupResult = await cleanupResources('suite-complete');
  await writeReport();
  state.finished = true;
  return report.summary.exitCode;
}

const watchdog = setTimeout(async () => {
  if (state.finished) return;
  log(`\n[watchdog] HARD TIMEOUT after ${TOTAL_TIMEOUT_MS}ms — cleaning up and exiting 2`);
  try { await cleanupResources('hard-timeout'); } catch { /* ignore */ }
  try { await writeReport(); } catch { /* ignore */ }
  process.exit(2);
}, TOTAL_TIMEOUT_MS);
watchdog.unref?.();

let exitCode = 0;
try {
  exitCode = await main();
} catch (error) {
  log(`\n[fatal] ${error && error.message ? error.message : String(error)}`);
  console.error(error);
  report.fatal = jsonSafe({ name: error?.name, message: String(error?.message || error), stack: String(error?.stack || '').split('\n').slice(0, 12) });
  const envUnavailable = error && (error.code === 'UNSUPPORTED' || String(error.message || '').includes('chromium-unavailable'));
  try { await cleanupResources('fatal-error'); } catch { /* ignore */ }
  try { await writeReport(envUnavailable ? 2 : 1); } catch { /* ignore */ }
  exitCode = envUnavailable ? 2 : 1;
} finally {
  state.finished = true;
  clearTimeout(watchdog);
}
process.exitCode = exitCode;
