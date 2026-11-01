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
 *                  H10 (lossless JSON, close resets observed/x/y).
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
  // A /state read schedules a coalesced metrics read (≥200ms throttled). `readStateQuiet` takes the
  // snapshot and then drains that scheduled read, so the next step starts from a settled cache
  // instead of racing the readback this very request just armed.
  const sleepForObservation = () => sleep(340);
  const readStateRaw = async () => (await harness.request({ method: 'GET', path: '/plugins/ui-testing/state' })).json;
  async function readStateQuiet() { const state = await readStateRaw(); await sleepForObservation(); return state; }
  const setView = (patch, exec) => harness.invoke('browser_viewport', { action: 'set', ...patch }, exec);
  const getView = (exec) => harness.invoke('browser_viewport', { action: 'get' }, exec);

  /* ---------------------------------------------------------------- V1: tool surface */
  await runProbe('V1-tool-surface', '工具注册与 schema（30 工具，browser_viewport required=[action]）',
    '注册表恰好 30 个 browser_* 工具；browser_viewport schema required=[action]、additionalProperties=false、action enum get/set、mode enum 四预设；description 非空；render 可用', async () => {
      const names = harness.toolNames();
      check(`注册表恰好 ${EXPECTED_TOOLS.length} 个工具（10 T1 + 7 T2 + 6 T3 + 7 network）`,
        names.length === EXPECTED_TOOLS.length, { count: names.length }, { count: EXPECTED_TOOLS.length });
      check('browser_viewport 已注册（工具面 29→30）', names.includes('browser_viewport'), { names }, 'browser_viewport in names');

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
      const connection = harnessModule.createFakeConnectionService({ rejection: undefined });
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
        const inputResponse = await harness.request({
          method: 'POST', path: '/plugins/ui-testing/input',
          body: { events: [{ kind: 'wheel', type: 'mouseWheel', x: 200, y: 200, deltaX: 0, deltaY: 200, button: 'none' }] },
        });
        check('/input 滚轮派发成功', inputResponse.statusCode === 200 && inputResponse.json?.applied === 1,
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
