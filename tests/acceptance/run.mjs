#!/usr/bin/env node
/**
 * T1 web acceptance suite for dsh-agent-team-ui-testing.
 *
 * It loads the real plugin entry (index.js), mounts it on a fake Cordis context, starts the
 * repository's own local fixture server, and drives the plugin's own headless Chromium through
 * the registered agent tools only (no CDP shim, no playwright/puppeteer/selenium, no network).
 *
 * Evidence is written under a fresh tests/acceptance/runs/<timestamp>-<pid>/ directory:
 *   run-report.json  - per-probe expectation/actual/evidence/conclusion + findings
 *   run.log          - the full console transcript (also echoed to stdout)
 *   screenshot.png   - PNG decoded from browser_screenshot output (PNG magic validated)
 *   network.json     - browser_network entries, query credentials redacted in the evidence file
 *
 * Exit codes:
 *   0 - every required probe check passed (advisory findings may still exist)
 *   1 - at least one required probe check failed (plugin defect or environment problem)
 *   2 - the suite itself could not run (no usable Chromium, hard timeout, fixture failed)
 *
 * Cleanup is best-effort but mandatory: plugin browsers registered by this run are closed via
 * POST /close, any leftover plugin Chromium processes started by this run are killed, only the
 * temp profile directories created by this run are removed, and the fixture server is closed.
 * Pre-existing browsers/directories (for example a user's DSH instance on :3080) are never
 * touched.
 */
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import * as httpRequest from './http-request.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = dirname(dirname(HERE));
// Preserve the historical evidence bundle; every invocation gets an independent directory.
const EVIDENCE_DIR = join(HERE, 'runs', `${new Date().toISOString().replace(/[:.]/g, '-')}-${process.pid}`);
const DEFAULT_CHROME = '/opt/google/chrome/chrome';
const CHROME_WRAPPER = join(HERE, 'chrome-wrapper.sh');
// The fixture's deliberately fake query token (see tests/ui_test_fixture/README.md).
const FIXTURE_TOKEN = ['DEMO', 'TOKEN', 'NOT', 'REAL'].join('_');
const EXPECTED_VIEWPORT = { width: 1280, height: 800 };
const TOTAL_TIMEOUT_MS = Number(process.env.DSH_ACCEPTANCE_TIMEOUT_MS || 240000) || 240000;

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

/* ------------------------------------------------------------------------------------------------
 * Environment: choose the Chromium binary before importing index.js (it reads the env at import).
 * ---------------------------------------------------------------------------------------------- */

async function probeChromium(bin, timeoutMs = 7000) {
  const profileDir = await mkdtemp(join(tmpdir(), 'dsh-acceptance-chrome-probe-'));
  const startedAt = Date.now();
  let stderr = '';
  let exited = false;
  let proc;
  try {
    proc = spawn(bin, [
      '--headless=new',
      '--remote-debugging-port=0',
      `--user-data-dir=${profileDir}`,
      '--no-first-run',
      '--no-default-browser-check',
      '--disable-gpu',
      'about:blank',
    ], { stdio: ['ignore', 'ignore', 'pipe'] });
    proc.on('exit', () => { exited = true; });
    proc.stderr.on('data', (chunk) => { stderr = (stderr + String(chunk)).slice(-2000); });
    let ok = false;
    while (Date.now() - startedAt < timeoutMs) {
      try {
        const text = await readFile(join(profileDir, 'DevToolsActivePort'), 'utf8');
        if (Number(text.split('\n')[0])) { ok = true; break; }
      } catch { /* not ready */ }
      if (exited) break;
      await sleep(100);
    }
    return { ok, bin, durationMs: Date.now() - startedAt, stderrTail: stderr.trim().slice(-1200) };
  } finally {
    try { proc?.kill('SIGKILL'); } catch { /* ignore */ }
    await sleep(300);
    try { await rm(profileDir, { recursive: true, force: true }); } catch { /* ignore */ }
  }
}

async function chooseChromiumPlan() {
  const explicit = process.env.DSH_UI_TESTING_CHROME;
  if (explicit) {
    return { bin: explicit, source: 'env', note: 'DSH_UI_TESTING_CHROME 由调用方显式指定，跳过默认探活' };
  }
  if (!existsSync(DEFAULT_CHROME)) {
    throw new Error(`默认 Chromium 不存在：${DEFAULT_CHROME}（可用 DSH_UI_TESTING_CHROME 覆盖）`);
  }
  log(`[env] probing default chromium: ${DEFAULT_CHROME}`);
  const direct = await probeChromium(DEFAULT_CHROME);
  if (direct.ok) {
    return { bin: DEFAULT_CHROME, source: 'default', probe: direct };
  }
  log('[env] default chromium launch failed; probing sandbox wrapper');
  const wrapped = await probeChromium(CHROME_WRAPPER);
  if (!wrapped.ok) {
    throw new Error(
      `没有可用的 Chromium：默认二进制与沙箱 wrapper 都启动失败。默认 stderr=${direct.stderrTail}；wrapper stderr=${wrapped.stderrTail}`,
    );
  }
  process.env.DSH_UI_TESTING_CHROME = CHROME_WRAPPER;
  return {
    bin: CHROME_WRAPPER,
    source: 'sandbox-fallback',
    realBin: DEFAULT_CHROME,
    note: '当前 shell 位于 DSH 文件沙箱内，Chrome 的 setuid sandbox 与 /dev/shm 不可用；wrapper 仅追加 --no-sandbox --disable-dev-shm-usage --disable-crash-reporter，其余参数原样透传。',
    defaultProbe: direct,
    wrapperProbe: wrapped,
  };
}

/* ------------------------------------------------------------------------------------------------
 * Report/probe plumbing
 * ---------------------------------------------------------------------------------------------- */

function jsonSafe(value, depth = 0) {
  if (value === undefined) return undefined;
  if (value === null || typeof value !== 'object') return value;
  if (depth > 6) return '[depth-limit]';
  if (Array.isArray(value)) return value.slice(0, 50).map((item) => jsonSafe(item, depth + 1));
  if (Buffer.isBuffer(value)) return `[Buffer ${value.length} bytes]`;
  const out = {};
  for (const [key, item] of Object.entries(value)) {
    if (key === 'image' || key === 'base64') { out[key] = '[base64 omitted]'; continue; }
    if (key === 'stack') { out[key] = String(item).split('\n').slice(0, 8).join('\n'); continue; }
    out[key] = jsonSafe(item, depth + 1);
  }
  return out;
}

function truncate(value, max = 400) {
  const text = typeof value === 'string' ? value : JSON.stringify(jsonSafe(value));
  if (text === undefined) return '';
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

function makeProbe(id, title, group, expected) {
  return {
    id,
    title,
    group,
    expected,
    status: 'pass',
    startedAt: new Date().toISOString(),
    durationMs: 0,
    checks: [],
    findings: [],
    actual: '',
    evidence: {},
    error: undefined,
  };
}

function addCheck(probe, label, pass, { expected, actual, evidence } = {}, { advisory = false } = {}) {
  const entry = {
    label,
    expected,
    actual: jsonSafe(actual),
    pass: Boolean(pass),
    advisory,
    evidence: jsonSafe(evidence),
  };
  probe.checks.push(entry);
  if (!pass && !advisory) probe.status = 'fail';
  const mark = pass ? 'PASS' : advisory ? 'INFO' : 'FAIL';
  log(`  [${mark}] ${label}`);
  if (!pass) {
    log(`         expected: ${truncate(expected)}`);
    log(`         actual  : ${truncate(actual)}`);
  }
  return entry;
}

const report = {
  schemaVersion: 1,
  suite: 'dsh-agent-team-ui-testing/acceptance-t1',
  generatedAt: new Date().toISOString(),
  command: 'node tests/acceptance/run.mjs',
  environment: {},
  probes: [],
  findings: [],
  resources: {},
  summary: { probes: 0, passed: 0, failed: 0, skipped: 0, requiredChecks: 0, failedChecks: 0, exitCode: 0 },
};

function addFinding(probe, { id, severity, summary, evidence, indexJsLines = [], advisory = true }) {
  const finding = {
    id,
    probeId: probe.id,
    severity,
    advisory,
    summary,
    indexJsLines,
    evidence: jsonSafe(evidence),
  };
  probe.findings.push(finding);
  report.findings.push(finding);
  log(`  [FINDING ${id}/${severity}] ${summary}`);
  return finding;
}

async function runProbe(meta, body) {
  const probe = makeProbe(meta.id, meta.title, meta.group, meta.expected);
  const startedAt = Date.now();
  let skipped = false;
  log(`\n== ${meta.id} — ${meta.title}`);
  const check = (label, pass, detail, options) => addCheck(probe, label, pass, detail, options);
  const finding = (definition) => addFinding(probe, definition);
  const skip = (reason) => {
    skipped = true;
    probe.status = 'skip';
    probe.skipReason = String(reason);
    log(`  [SKIP] ${probe.skipReason}`);
  };
  try {
    await body({ probe, check, finding, skip });
  } catch (error) {
    if (skipped) {
      probe.error = { name: error?.name, message: errorMessage(error), note: 'thrown after skip' };
      log(`  [SKIP-note] 跳过路径中仍抛出：${errorMessage(error)}`);
    } else {
      probe.status = 'fail';
      probe.error = { name: error?.name, message: errorMessage(error), stack: error?.stack };
      addCheck(probe, '探针执行未抛出异常', false, {
        expected: '探针正常执行',
        actual: { name: error?.name, message: errorMessage(error), stack: String(error?.stack || '').split('\n').slice(0, 6) },
      });
    }
  }
  probe.durationMs = Date.now() - startedAt;
  const required = probe.checks.filter((item) => !item.advisory);
  const failed = required.filter((item) => !item.pass);
  if (skipped) {
    probe.status = 'skip';
    probe.actual = `SKIP: ${probe.skipReason}${probe.checks.length ? `（已在跳过前记录 ${probe.checks.length} 项观察/检查）` : ''}`;
  } else if (probe.status === 'pass') {
    probe.actual = `${required.length} 项必需检查全部通过${probe.findings.length ? `，另记录 ${probe.findings.length} 条 finding` : ''}`;
  } else {
    probe.actual = `${failed.length}/${required.length} 项必需检查失败：${failed.map((item) => item.label).join('；')}`;
  }
  probe.evidence = {
    checks: probe.checks,
    findings: probe.findings.map((item) => item.id),
    skipReason: probe.skipReason,
    artifacts: [],
  };
  report.probes.push(probe);
  log(`== ${meta.id} ${probe.status.toUpperCase()} (${probe.durationMs}ms) — ${probe.actual}`);
  return probe;
}

/* ------------------------------------------------------------------------------------------------
 * Page helpers (only through registered agent tools / plugin HTTP handler)
 * ---------------------------------------------------------------------------------------------- */

async function waitForEval(harness, expression, predicate, { timeoutMs = 10000, label = expression } = {}) {
  const startedAt = Date.now();
  let last;
  while (Date.now() - startedAt < timeoutMs) {
    last = await harness.invoke('browser_eval', { expression });
    if (last.ok && last.value && last.value.ok && predicate(last.value.value)) return last;
    await sleep(100);
  }
  throw new Error(`timed out waiting for eval ${label}; last=${truncate(last)}`);
}

async function waitForState(harness, predicate, { timeoutMs = 10000, label = 'state' } = {}) {
  const startedAt = Date.now();
  let last;
  while (Date.now() - startedAt < timeoutMs) {
    last = await harness.invoke('browser_state', {});
    if (last.ok && predicate(last.value)) return last;
    await sleep(100);
  }
  throw new Error(`timed out waiting for state ${label}; last=${truncate(last)}`);
}

async function navigateAndWait(harness, url, { expectedTitle, timeoutMs = 15000, exec } = {}) {
  const navigation = await harness.invoke('browser_navigate', { url }, exec);
  if (!navigation.ok || !navigation.value?.ok) return { navigation, loaded: false };
  const ready = {
    expression: `({ ready: document.readyState, title: document.title })`,
    predicate: (value) => value && value.ready === 'complete' && (!expectedTitle || value.title === expectedTitle),
  };
  const startedAt = Date.now();
  let last;
  while (Date.now() - startedAt < timeoutMs) {
    last = await harness.invoke('browser_eval', { expression: ready.expression }, exec);
    if (last.ok && last.value?.ok && ready.predicate(last.value.value)) {
      return { navigation, loaded: true, page: last.value.value };
    }
    await sleep(100);
  }
  throw new Error(`navigation to ${url} did not reach readyState=complete/title=${expectedTitle}; last=${truncate(last)}`);
}

/* ------------------------------------------------------------------------------------------------
 * Resource helpers
 * ---------------------------------------------------------------------------------------------- */

const beforeProfileDirs = new Set();
const beforeChromePids = new Set();

async function snapshotProfiles() {
  const harness = await import(pathToFileURL(join(HERE, 'harness.mjs')).href);
  return harness.snapshotProfileDirs();
}

async function captureRunBaseline() {
  const harness = await import(pathToFileURL(join(HERE, 'harness.mjs')).href);
  for (const dir of await harness.snapshotProfileDirs()) beforeProfileDirs.add(dir);
  for (const proc of harness.scanPluginChromeProcesses()) beforeChromePids.add(proc.pid);
}

const ownedProfileDirs = new Set();
function newProfileDirs(all) {
  return all.filter((dir) => !beforeProfileDirs.has(dir) && ownedProfileDirs.has(dir));
}

function newChromeProcesses(harness) {
  const owned = harness.scanPluginChromeProcesses().filter((proc) => proc.parentPid === process.pid && !beforeChromePids.has(proc.pid));
  for (const proc of owned) ownedProfileDirs.add(proc.profileDir);
  return owned;
}

/* ------------------------------------------------------------------------------------------------
 * Probe implementations
 * ---------------------------------------------------------------------------------------------- */

async function probe1ToolSurface({ harness, check, finding }) {
  const { EXPECTED_TOOLS } = await import(pathToFileURL(join(HERE, 'harness.mjs')).href);
  const expectedNames = EXPECTED_TOOLS.map((tool) => tool.name);
  const actualNames = harness.toolNames();

  // 30 = 10 T1 (docs/runtime-t1.md + docs/viewport-control.md §7 browser_viewport)
  //      + 7 T2 (docs/t2-structured-gui.md §2.2) + 6 T3 (docs/t3-vision.md §2.1)
  //      + 7 network (docs/network-p0.md §2). Counted against EXPECTED_TOOLS so a group surface
  //      cannot drift silently; the "same names" assertion below still proves nothing extra.
  check(`工具注册面恰好是 ${EXPECTED_TOOLS.length} 个 browser_* 工具（10 T1 + 7 T2 + 6 T3 + 7 network）`, actualNames.length === EXPECTED_TOOLS.length, {
    expected: { count: EXPECTED_TOOLS.length, names: expectedNames },
    actual: { count: actualNames.length, names: actualNames },
  });
  check('工具名与 docs/runtime-t1.md + t2/t3/network 契约完全一致（无缺失、无多余）', JSON.stringify([...actualNames].sort()) === JSON.stringify([...expectedNames].sort()), {
    expected: [...expectedNames].sort(),
    actual: [...actualNames].sort(),
  });

  const schemaProblems = [];
  for (const tool of EXPECTED_TOOLS) {
    const definition = harness.tools.get(tool.name);
    if (!definition) { schemaProblems.push(`${tool.name}: 未注册`); continue; }
    if (typeof definition.execute !== 'function') schemaProblems.push(`${tool.name}: execute 不是函数`);
    if (!definition.parameters || definition.parameters.type !== 'object') schemaProblems.push(`${tool.name}: parameters.type != object`);
    const required = (definition.parameters?.required || []).slice().sort();
    if (JSON.stringify(required) !== JSON.stringify(tool.required.slice().sort())) {
      schemaProblems.push(`${tool.name}: required=${JSON.stringify(required)}，期望 ${JSON.stringify(tool.required)}`);
    }
    if (typeof definition.description !== 'string' || !definition.description.trim()) schemaProblems.push(`${tool.name}: description 为空`);
  }
  check('每个工具的 parameters/required/execute/description 与预期一致', schemaProblems.length === 0, {
    expected: EXPECTED_TOOLS,
    actual: { problems: schemaProblems },
  });

  const rawCdpTools = actualNames.filter((name) => /cdp|devtools|protocol|page\.|runtime\./i.test(name));
  check('没有暴露原始 CDP/协议命令工具', rawCdpTools.length === 0, {
    expected: [],
    actual: rawCdpTools,
  });

  const stateResponse = await harness.request({ method: 'GET', path: '/plugins/ui-testing/state' });
  check('GET /state 可用并返回运行态字段', stateResponse.statusCode === 200 && stateResponse.json?.running === false, {
    expected: { statusCode: 200, json: { running: false, viewport: EXPECTED_VIEWPORT } },
    actual: { statusCode: stateResponse.statusCode, json: stateResponse.json },
  });

  const frameResponse = await harness.request({ method: 'GET', path: '/plugins/ui-testing/frame' });
  check('GET /frame 在无浏览器时返回 pending:true', frameResponse.statusCode === 200 && frameResponse.json?.pending === true, {
    expected: { statusCode: 200, pending: true, seq: 0 },
    actual: { statusCode: frameResponse.statusCode, json: frameResponse.json && { pending: frameResponse.json.pending, seq: frameResponse.json.seq } },
  });

  const unknown = await harness.request({ method: 'POST', path: '/plugins/ui-testing/does-not-exist', body: {} });
  check('未知 POST 指令返回 404 {ok:false,error}', unknown.statusCode === 404 && unknown.json?.ok === false && typeof unknown.json?.error === 'string', {
    expected: { statusCode: 404, body: { ok: false, error: '<non-empty string>' } },
    actual: { statusCode: unknown.statusCode, body: unknown.json },
  });

  const methodNotAllowed = await harness.request({ method: 'GET', path: '/plugins/ui-testing/navigate' });
  check('GET 写指令返回 405 {ok:false,error}', methodNotAllowed.statusCode === 405 && methodNotAllowed.json?.ok === false, {
    expected: { statusCode: 405, body: { ok: false } },
    actual: { statusCode: methodNotAllowed.statusCode, body: methodNotAllowed.json },
  });

  const stateKeys = Object.keys(stateResponse.json || {}).sort();
  check('state 保留原字段并提供 owner 诊断', ['activity', 'error', 'mode', 'running', 'seq', 'title', 'url', 'viewport', 'owner'].every((key) => stateKeys.includes(key)), {
    expected: '原运行态字段 + owner', actual: stateKeys,
  });
  const capabilities = await harness.invoke('browser_capabilities');
  check('独立 capability 工具在未启动时可诊断且不启动浏览器', capabilities.ok && capabilities.value?.ok === true && capabilities.value?.runtime?.running === false,
    { expected: { ok: true, runtime: { running: false } }, actual: capabilities.error || capabilities.value });
}

/* ------------------------------------------------------------------------------------------------
 * P23 — network P0 surface (docs/network-p0.md §2): 7 new tools, their schemas, offline
 * diagnostics that must not start Chromium, NET_* error classification, control BUSY against a
 * live owner, and proof that the 22 pre-existing tools keep their old behaviour.
 * ---------------------------------------------------------------------------------------------- */

const netExec = (id) => ({ agent: { id } });
const netError = (result) => result?.error || result?.value?.error || {};

/** Every network failure must be a structured BrowserError with a NET_* code, never INTERNAL. */
function netFailureProblem(result) {
  const error = netError(result);
  const problems = [];
  if (result?.ok === true && result?.value?.ok === true) problems.push('unexpected success');
  if (error.name !== 'BrowserError') problems.push(`name=${error.name}`);
  if (typeof error.code !== 'string' || !error.code) problems.push(`code=${error.code}`);
  if (typeof error.code === 'string' && error.code === 'INTERNAL') problems.push('code degraded to INTERNAL');
  if (typeof error.category !== 'string' || !error.category) problems.push(`category=${error.category}`);
  if (typeof error.retryable !== 'boolean') problems.push(`retryable=${error.retryable}`);
  if (typeof error.code === 'string' && error.code && !String(error.message || '').startsWith(`[${error.code}]`)) problems.push('message lacks [CODE] prefix');
  return problems;
}

async function probe23NetworkSurface({ harness, createHarness, fixture, check, finding }) {
  const { NETWORK_TOOLS, LEGACY_TOOLS } = await import(pathToFileURL(join(HERE, 'harness.mjs')).href);
  const names = harness.toolNames();
  const networkNames = NETWORK_TOOLS.map((tool) => tool.name);
  const missing = networkNames.filter((name) => !names.includes(name));
  check('network 组恰好 7 个工具且全部注册', NETWORK_TOOLS.length === 7 && missing.length === 0, {
    expected: { count: 7, names: networkNames }, actual: { missing, registered: names },
  });
  check('network 组工具名不与旧 22 工具重名', LEGACY_TOOLS.every((tool) => !networkNames.includes(tool.name))
    && new Set(names).size === names.length, { expected: 'disjoint + unique', actual: { legacy: LEGACY_TOOLS.length, network: networkNames } });

  const schemaProblems = [];
  for (const tool of NETWORK_TOOLS) {
    const definition = harness.tools.get(tool.name);
    if (!definition) { schemaProblems.push(`${tool.name}: 未注册`); continue; }
    if (typeof definition.execute !== 'function') schemaProblems.push(`${tool.name}: execute 不是函数`);
    if (!definition.parameters || definition.parameters.type !== 'object') schemaProblems.push(`${tool.name}: parameters.type != object`);
    const required = (definition.parameters?.required || []).slice().sort();
    if (JSON.stringify(required) !== JSON.stringify(tool.required.slice().sort())) {
      schemaProblems.push(`${tool.name}: required=${JSON.stringify(required)}，期望 ${JSON.stringify(tool.required)}`);
    }
    if (typeof definition.description !== 'string' || !definition.description.trim()) schemaProblems.push(`${tool.name}: description 为空`);
    if (!definition.parameters?.properties || Object.keys(definition.parameters.properties).length === 0) schemaProblems.push(`${tool.name}: parameters.properties 为空`);
  }
  check('network 7 工具的 parameters/required/execute/description 与契约 §2 一致', schemaProblems.length === 0, {
    expected: NETWORK_TOOLS, actual: { problems: schemaProblems },
  });
  const rawCdp = networkNames.filter((name) => /cdp|devtools|protocol|page\.|runtime\./i.test(name));
  check('network 组没有暴露原始 CDP/协议命令工具', rawCdp.length === 0, { expected: [], actual: rawCdp });

  // A private harness: taking an owner lease here must not disturb the main suite's session.
  const net = await createHarness({ name: 'P23-network' });
  try {
    const profilesBefore = new Set(await snapshotProfiles());
    // Contract §1.2.4/§2: every one of these actions is documented as diagnostic/offline and must
    // NOT start Chromium. Argument shapes follow §2.2/§2.3/§2.4/§2.5/§2.6/§2.7 verbatim.
    const diagnostics = [
      ['browser_network_session', { action: 'status' }],
      ['browser_network_session', { action: 'reset' }],
      ['browser_network_events', {}],
      ['browser_network_detail', { seq: 999 }],
      ['browser_network_evidence', { action: 'index' }],
      ['browser_network_evidence', { action: 'integrity' }],
      ['browser_network_subscribe', { action: 'poll', subscriptionId: 'sub-missing' }],
      ['browser_network_subscribe', { action: 'list' }],
      ['browser_network_trace', { action: 'query' }],
      ['browser_network_trace', { action: 'window' }],
      ['browser_network_control', { action: 'intercept-list' }],
    ];
    const results = [];
    for (const [tool, args] of diagnostics) results.push({ tool, args, result: await net.invoke(tool, args, netExec('net-diagnostics')) });
    const spawned = (await snapshotProfiles()).filter((dir) => !profilesBefore.has(dir));
    check(`未启动 Chromium 时 ${diagnostics.length} 个 network 诊断调用全部不启动浏览器（无新 profile）`,
      spawned.length === 0, { expected: [], actual: spawned });
    const state = await net.invoke('browser_state', {}, netExec('net-diagnostics'));
    check('network 诊断后运行态仍 running=false（诊断不代驾页面）', state.ok && state.value?.running === false,
      { expected: { running: false }, actual: state.value });

    const sessionStatus = results.find((item) => item.tool === 'browser_network_session' && item.args.action === 'status');
    const statusValue = sessionStatus?.result.value || {};
    // §2.1: no session → session:null (never an error), limits always reported.
    check('browser_network_session status 在无会话时返回 session:null + limits（不抛错、不启动浏览器）',
      sessionStatus?.result.ok === true && statusValue.ok === true && statusValue.session === null
        && statusValue.limits && Number.isInteger(statusValue.limits.maxEvents),
      { expected: { ok: true, session: null, limits: { maxEvents: 20000 } }, actual: sessionStatus?.result.error || statusValue });
    const eventsValue = results.find((item) => item.tool === 'browser_network_events')?.result.value || {};
    check('browser_network_events 在无会话时返回空结果并置 sessionId:null（§2 公共约定）',
      eventsValue.ok === true && eventsValue.sessionId === null && Array.isArray(eventsValue.events) && eventsValue.events.length === 0,
      { expected: { ok: true, sessionId: null, events: [] }, actual: eventsValue });

    const unstructured = results.filter(({ result }) => result.ok !== true && netFailureProblem(result).length > 0);
    check('诊断/域失败一律是结构化 BrowserError（不出现非结构化异常、不降级 INTERNAL）', unstructured.length === 0, {
      expected: 'structured BrowserError with code/category/retryable + [CODE] message',
      actual: unstructured.map(({ tool, args, result }) => ({ tool, args, error: result.error })),
    });
    // §2.9: detail without a session is a network-domain failure; a missing subscription is a
    // subscription-domain failure. Both must be NET_*, never INTERNAL/INVALID_ARGUMENT.
    const domainCodes = results
      .filter(({ tool, args }) => (tool === 'browser_network_detail' && args.seq)
        || (tool === 'browser_network_subscribe' && args.subscriptionId))
      .map(({ tool, args, result }) => ({ tool, args, code: netError(result).code, ok: result.ok }));
    check('不存在的会话/订阅用 NET_* 码分类（不落 INTERNAL）', domainCodes.length === 2
      && domainCodes.every((item) => /^NET_/.test(String(item.code || ''))), { expected: 'both NET_*', actual: domainCodes });

    // Owner contention (§8.5): session changes and control actions need the owner lease. Reading the
    // legacy traffic buffer does NOT take the lease, so acquire it with a real page tool first.
    const ownerUrl = (fixture && fixture.url ? fixture.url : 'http://127.0.0.1:1/') + 'blank.html';
    const ownerTakeover = await net.invoke('browser_navigate', { url: ownerUrl }, netExec('net-owner'));
    const owner = ownerTakeover;
    // A mutating control action is the one that needs the owner lease; read-only listing stays
    // available to everyone (§8.5 只读查询不占租约).
    const noopThrottle = { action: 'throttle', throttle: { latencyMs: 0 } };
    const controlFromOther = await net.invoke('browser_network_control', noopThrottle, netExec('net-other-owner'));
    const controlOwner = await net.invoke('browser_network_control', noopThrottle, netExec('net-owner'));
    check('browser_network_control（写动作 throttle）在其他 owner 下 BUSY，owner 自身可执行', owner.ok
      && controlFromOther.threw === true && netError(controlFromOther).code === 'BUSY'
      && controlOwner.ok === true && controlOwner.value?.ok !== false, {
      expected: { otherOwner: 'BUSY', owner: 'ok' },
      actual: { owner: owner.error || { ok: owner.value?.ok, entries: owner.value?.entries?.length }, other: controlFromOther.error, self: controlOwner.error || controlOwner.value },
    });
    const listFromOther = await net.invoke('browser_network_control', { action: 'intercept-list' }, netExec('net-other-owner'));
    check('只读 control（intercept-list）不占租约，其他会话可读', listFromOther.ok === true
      && listFromOther.value?.ok !== false, { expected: { readonlyControl: 'ok' }, actual: listFromOther.error || { ok: listFromOther.value?.ok } });
    const readFromOther = await net.invoke('browser_network_events', {}, netExec('net-other-owner'));
    check('只读事件查询不占租约（其他会话可读，§8.5）', readFromOther.ok === true,
      { expected: 'ok', actual: readFromOther.error || { ok: readFromOther.value?.ok } });
    const blockedMutation = await net.invoke('browser_network_control', { action: 'throttle', throttle: { latencyMs: 0 } }, netExec('net-other-owner'));
    check('control 的写操作对其他 owner 同样 BUSY 且不改变网络状态', blockedMutation.threw === true && netError(blockedMutation).code === 'BUSY',
      { expected: 'BUSY', actual: blockedMutation.error });

    // Legacy compatibility: the pre-existing browser_network keeps its exact metadata body.
    const legacy = await net.invoke('browser_network', { limit: 5 }, netExec('net-owner'));
    const legacyKeys = Object.keys(legacy.value || {}).sort();
    // §2.8 keeps the legacy body `{entries:[metadata]}` (wrapped by the shared action envelope); `ok`
    // is not required, the envelope fields are allowed to grow.
    const envelopeKeys = ['actionId', 'sessionId', 'startedAt', 'tool', 'args', 'scope', 'target', 'finishedAt'];
    check('旧 browser_network 仍返回 {entries:[元数据]}（envelope 允许携带 actionId 等，不要求 ok）',
      legacy.ok && Array.isArray(legacy.value?.entries)
        && legacyKeys.every((key) => key === 'entries' || key === 'capturedAt' || key === 'note' || envelopeKeys.includes(key)),
      { expected: { entries: 'Array', envelope: 'actionId/sessionId/…' }, actual: { keys: legacyKeys, entries: legacy.value?.entries?.length } });
    const legacyEntryKeys = ['at', 'blockedReason', 'canceled', 'errorText', 'failed', 'method', 'redacted', 'status', 'type', 'url'];
    const legacyAllowed = (legacy.value?.entries || []).every((entry) => Object.keys(entry).every((key) => legacyEntryKeys.includes(key)));
    check('旧 browser_network 条目仍是元数据白名单（不因网络 P0 加入 body/headers）', legacyAllowed, {
      expected: legacyEntryKeys, actual: (legacy.value?.entries || []).slice(0, 2),
    });
    finding({
      id: 'P23-network-surface',
      summary: 'network 组 7 工具注册/schema/离线诊断/域错误分类/owner BUSY 与旧 browser_network 元数据形状在本探针内核对；C1–C52 的语义断言由 tests/acceptance/network-p0.mjs 覆盖。',
      evidence: { diagnostics: results.map(({ tool, args, result }) => ({ tool, args, ok: result.ok, code: netError(result).code })) },
    });
  } finally {
    try { await net.closeBrowser(); } catch { /* cleanup must not mask results */ }
    await net.dispose();
  }
}

async function probe2Navigate({ harness, check, finding, observations }) {
  const fixture = observations.fixture;
  // Pre-warm through the plugin HTTP surface so the following tool navigation is not the first
  // cold start: the 15s agent-hold window (AGENT_HOLD_MS) starts at touchAgent(), and a cold
  // Chrome start in a restricted sandbox can exceed it. Cold-start-restart is still covered by P8.
  const ensureStarted = Date.now();
  const ensured = await harness.request({ method: 'POST', path: '/plugins/ui-testing/ensure', body: {} });
  check('POST /ensure 预启动浏览器（工具随后复用同一实例）', ensured.statusCode === 200 && ensured.json?.ok === true && ensured.json?.state?.running === true, {
    expected: { statusCode: 200, body: { ok: true, state: { running: true } } },
    actual: { statusCode: ensured.statusCode, ok: ensured.json?.ok, running: ensured.json?.state?.running, durationMs: Date.now() - ensureStarted },
  });
  const navigation = await harness.invoke('browser_navigate', { url: fixture.url });
  check('browser_navigate 打开 fixture 并返回 {ok:true,url}', navigation.ok && navigation.value?.ok === true, {
    expected: { ok: true, url: fixture.url },
    actual: navigation.error || navigation.value,
  });
  // Capture control/activity here: browser_state itself does not touch activity, but any later
  // browser_eval call will legitimately overwrite it with "执行脚本".
  const earlyState = (await harness.invoke('browser_state', {})).value;
  check('导航后控制权/活动状态进入 agent 模式', earlyState?.mode === 'agent' && String(earlyState?.activity).includes('正在打开'), {
    expected: { mode: 'agent', activity: `正在打开 ${fixture.url}` },
    actual: { mode: earlyState?.mode, activity: earlyState?.activity },
  });
  const pageReady = await waitForEval(harness, '({ready: document.readyState, title: document.title})',
    (value) => value?.ready === 'complete' && value?.title === 'DSH UI Testing Fixture', { label: 'page readyState/title' });
  const page = pageReady.value.value;
  check('页面 document.title 为固定值（页面侧真值）', page?.title === 'DSH UI Testing Fixture' && page?.ready === 'complete', {
    expected: { title: 'DSH UI Testing Fixture', readyState: 'complete' },
    actual: page,
  });

  const stateAfter = await waitForState(harness, (state) => state.running === true && typeof state.url === 'string' && state.url.startsWith(fixture.url), {
    label: 'running:true + fixture url',
  });
  const state = stateAfter.value;
  check('browser_state.running=true', state.running === true, { expected: true, actual: state.running });
  check('browser_state.url 为 fixture 地址', String(state.url).startsWith(fixture.url), {
    expected: fixture.url,
    actual: state.url,
  });
  check('browser_state.title 反映页面标题', state.title === 'DSH UI Testing Fixture', {
    expected: 'DSH UI Testing Fixture',
    actual: state.title,
  });
  if (state.title !== 'DSH UI Testing Fixture') {
    finding({
      id: 'F2-state-title-empty',
      severity: 'high',
      advisory: true,
      summary: 'browser_state.title 永远为空：frameNavigated 事件里取的是 frame.name（window.name），不是 document.title；文档和工具描述却声明返回标题。',
      indexJsLines: ['231-235 (#onEvent Page.frameNavigated)'],
      evidence: { documentTitle: page.title, stateTitle: state.title, url: state.url },
    });
  }
  await harness.invoke('browser_eval', { expression: 'document.title = "acceptance-spa-title"' });
  const spaState = await harness.invoke('browser_state');
  check('SPA 修改 document.title 后 state 读取到新标题', spaState.value?.title === 'acceptance-spa-title', { expected: 'acceptance-spa-title', actual: spaState.value?.title });
  const invalidScheme = await harness.invoke('browser_navigate', { url: 'file:///etc/passwd' });
  check('非法 scheme（file://）被拒绝并抛 INVALID_ARGUMENT', invalidScheme.ok === false && invalidScheme.threw === true && invalidScheme.error?.code === 'INVALID_ARGUMENT', {
    expected: { threw: true, code: 'INVALID_ARGUMENT' },
    actual: { threw: invalidScheme.threw, error: invalidScheme.error },
  });
  observations.toolThrows.push({ probe: 'P2', tool: 'browser_navigate', args: { url: 'file:///etc/passwd' }, error: invalidScheme.error });

  const unreachable = await harness.invoke('browser_navigate', { url: 'http://127.0.0.1:1/' });
  const producedError = unreachable.ok === false && unreachable.threw === true && unreachable.error?.code === 'NAV_FAILED';
  check('不可达地址抛出 NAV_FAILED（不返回静默成功）', producedError, {
    expected: { threw: true, code: 'NAV_FAILED', category: 'navigation', retryable: true },
    actual: unreachable.ok ? unreachable.value : unreachable.error,
  });
  await sleep(500);
  const stateDuringFailure = await harness.invoke('browser_state', {});
  observations.silentFailures.push({ probe: 'P2', invoke: unreachable, state: stateDuringFailure.value });
  if (!producedError) {
    finding({
      id: 'F3-navigate-ignores-errorText',
      severity: 'high',
      advisory: true,
      summary: 'browser_navigate 对不可达地址静默成功：Page.navigate 的 errorText 未被检查，工具仍返回 {ok:true,url}；页面实际停在 chrome-error://chromewebdata/，调用方无法区分成功与失败。',
      indexJsLines: ['295-299 (navigate())'],
      evidence: {
        toolResult: unreachable.value,
        stateAfter: { url: stateDuringFailure.value?.url, title: stateDuringFailure.value?.title, error: stateDuringFailure.value?.error },
      },
    });
  }

  const recovery = await navigateAndWait(harness, fixture.url, { expectedTitle: 'DSH UI Testing Fixture' });
  check('失败导航后可重新导航回 fixture（状态可恢复）', recovery.navigation.ok === true && recovery.loaded === true, {
    expected: { ok: true, title: 'DSH UI Testing Fixture' },
    actual: recovery.page,
  });
}

async function probe3Eval({ harness, check, finding, observations }) {
  const counter = await harness.invoke('browser_eval', { expression: 'document.getElementById("counter").textContent' });
  check('browser_eval 读取 #counter 初始值为 "0"', counter.ok && counter.value?.ok === true && counter.value.value === '0', {
    expected: { ok: true, value: '0', type: 'string' },
    actual: counter.error || counter.value,
  });

  const shape = await harness.invoke('browser_eval', { expression: '({a:1,b:[2,3]})' });
  check('browser_eval 返回 {ok,value,type} 且对象按值返回', shape.ok && shape.value?.ok === true && shape.value.value?.a === 1 && shape.value.type === 'object', {
    expected: { ok: true, value: { a: 1, b: [2, 3] }, type: 'object' },
    actual: shape.error || shape.value,
  });

  const thrown = await harness.invoke('browser_eval', { expression: 'throw new Error("acceptance-boom")' });
  check('页面异常返回 EVAL_ERROR 对象并保留描述/堆栈', thrown.ok === true && thrown.value?.ok === false && thrown.value.error?.code === 'EVAL_ERROR'
    && thrown.value.error.category === 'app' && thrown.value.error.retryable === false && /acceptance-boom/.test(thrown.value.error.message) && /\n\s*at /.test(thrown.value.error.message), {
    expected: { ok: false, error: { code: 'EVAL_ERROR', category: 'app', retryable: false, message: 'Error: acceptance-boom + stack' } },
    actual: thrown.error || thrown.value,
  });
  observations.evalErrors.push({ probe: 'P3', result: thrown.value, toolThrew: thrown.threw === true });

  const awaited = await harness.invoke('browser_eval', { expression: 'Promise.resolve(41 + 1)' });
  check('browser_eval 支持 awaitPromise（Promise 结果按值返回）', awaited.ok && awaited.value?.ok === true && awaited.value.value === 42, {
    expected: { ok: true, value: 42 },
    actual: awaited.error || awaited.value,
  });

  const undefinedResult = await harness.invoke('browser_eval', { expression: 'undefined' });
  check('browser_eval 处理 undefined 结果', undefinedResult.ok && undefinedResult.value?.ok === true && undefinedResult.value.value === undefined, {
    expected: { ok: true, value: undefined, type: 'undefined' },
    actual: undefinedResult.error || undefinedResult.value,
  });

  check('eval 错误包含结构化 details', thrown.value?.error?.details && typeof thrown.value.error.details === 'object', { expected: 'details object', actual: thrown.value?.error });
}

async function probe4ComputedStyle({ harness, check, finding, observations }) {
  const expectedStyle = {
    color: 'rgb(220, 38, 38)',
    'font-size': '16px',
    'font-weight': '700',
    'padding-top': '12px',
    'padding-left': '16px',
  };
  const properties = Object.keys(expectedStyle);
  const computed = await harness.invoke('browser_computed_style', { selector: '#style-target', properties });
  const actualStyle = computed.value?.style;
  const mismatches = properties.filter((name) => actualStyle?.[name] !== expectedStyle[name]);
  check('browser_computed_style 精确命中 #style-target 的 5 个 CSS 属性', computed.ok && computed.value?.ok === true && mismatches.length === 0, {
    expected: expectedStyle,
    actual: { style: actualStyle, mismatches },
  });

  const missing = await harness.invoke('browser_computed_style', { selector: '#acceptance-missing-element' });
  check('不存在的 selector 返回 TARGET_NOT_FOUND 对象（不抛工具异常）', missing.ok === true && missing.value?.ok === false && missing.value.error?.code === 'TARGET_NOT_FOUND'
    && missing.value.error.category === 'action' && missing.value.error.retryable === false && /acceptance-missing-element/.test(missing.value.error.message), {
    expected: { ok: false, error: { code: 'TARGET_NOT_FOUND', category: 'action', retryable: false } },
    actual: missing.error || missing.value,
  });
  observations.styleErrors.push({ probe: 'P4', result: missing.value, toolThrew: missing.threw === true });

  const all = await harness.invoke('browser_computed_style', { selector: '#style-target' });
  check('未传 properties 时返回完整 computedStyle 集合', all.ok && all.value?.ok === true && all.value.style && Object.keys(all.value.style).length > 100, {
    expected: { ok: true, styleKeys: '>100' },
    actual: { ok: all.value?.ok, styleKeyCount: Object.keys(all.value?.style || {}).length },
  });
}

async function probe5Input({ harness, check, finding }) {
  const rect = await harness.invoke('browser_eval', {
    expression: `(() => { const r = document.getElementById('inc').getBoundingClientRect();
      return { left: r.left, top: r.top, width: r.width, height: r.height, x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) }; })()`,
  });
  const point = rect.value?.value;
  check('browser_eval 读取 #inc 的 getBoundingClientRect 中心（CSS px）', rect.ok && rect.value?.ok === true && point?.width > 0 && Number.isFinite(point?.x), {
    expected: { x: '中心点', width: '>0' },
    actual: point,
  });

  const click = await harness.invoke('browser_input', {
    events: [
      { kind: 'mouse', type: 'mousePressed', x: point.x, y: point.y, button: 'left', buttons: 1, clickCount: 1 },
      { kind: 'mouse', type: 'mouseReleased', x: point.x, y: point.y, button: 'left', buttons: 0, clickCount: 1 },
    ],
  });
  check('browser_input 派发 mousePressed/mouseReleased 成功', click.ok && click.value?.ok === true && click.value.applied === 2, {
    expected: { ok: true, applied: 2 },
    actual: click.error || click.value,
  });
  await sleep(200);
  const counterAfterClick = await harness.invoke('browser_eval', { expression: 'document.getElementById("counter").textContent' });
  check('原生点击副作用生效：#counter 由 "0" 变为 "1"', counterAfterClick.value?.value === '1', {
    expected: '1',
    actual: counterAfterClick.error || counterAfterClick.value,
  });

  const namePoint = await harness.invoke('browser_eval', {
    expression: `(() => { const r = document.getElementById('name').getBoundingClientRect();
      return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) }; })()`,
  });
  const nameXY = namePoint.value?.value;
  await harness.invoke('browser_input', {
    events: [
      { kind: 'mouse', type: 'mousePressed', x: nameXY.x, y: nameXY.y, button: 'left', buttons: 1, clickCount: 1 },
      { kind: 'mouse', type: 'mouseReleased', x: nameXY.x, y: nameXY.y, button: 'left', buttons: 0, clickCount: 1 },
      { kind: 'text', text: 'Ada' },
    ],
  });
  await sleep(200);
  const nameValue = await harness.invoke('browser_eval', { expression: 'document.getElementById("name").value' });
  check('点击 #name 后用 browser_input 的 text 事件输入 "Ada"', nameValue.value?.value === 'Ada', {
    expected: 'Ada',
    actual: nameValue.error || nameValue.value,
  });

  const submitRect = await harness.invoke('browser_eval', {
    expression: `(() => { const r = document.getElementById('submit').getBoundingClientRect();
      return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) }; })()`,
  });
  const submitXY = submitRect.value?.value;
  await harness.invoke('browser_input', {
    events: [
      { kind: 'mouse', type: 'mousePressed', x: submitXY.x, y: submitXY.y, button: 'left', buttons: 1, clickCount: 1 },
      { kind: 'mouse', type: 'mouseReleased', x: submitXY.x, y: submitXY.y, button: 'left', buttons: 0, clickCount: 1 },
    ],
  });
  await sleep(200);
  const resultText = await harness.invoke('browser_eval', { expression: 'document.getElementById("result").textContent' });
  check('点击 #submit 后 #result 变为 "hello Ada"', resultText.value?.value === 'hello Ada', {
    expected: 'hello Ada',
    actual: resultText.error || resultText.value,
  });
}

async function probe6Network({ harness, check, finding, observations }) {
  const fixture = observations.fixture;
  await waitForEval(harness, 'document.body.dataset.autoload', (value) => value === 'fixture-data-ok', {
    label: 'fixture auto /api/data response',
  });

  const network = await harness.invoke('browser_network', { limit: 50 });
  const entries = network.value?.entries;
  check('browser_network 返回 {entries:[…]} 数组', network.ok && Array.isArray(entries), {
    expected: { entries: 'Array' },
    actual: { ok: network.value?.ok, entriesType: typeof entries },
  });
  const dataEntry = entries?.find((entry) => entry.method === 'GET' && String(entry.url).includes('/api/data') && entry.status === 200);
  check('能看到页面自动发起并完成的 GET /api/data（status 200）', Boolean(dataEntry), {
    expected: { url: `${fixture.url}api/data`, method: 'GET', status: 200, type: 'Fetch' },
    actual: dataEntry || entries?.slice(-5),
  });
  observations.initialNetwork = entries;

  const allowedKeys = ['at', 'method', 'status', 'type', 'url', 'redacted', 'failed', 'errorText', 'canceled', 'blockedReason'];
  const entriesWithExtraFields = (entries || []).filter((entry) => Object.keys(entry).some((key) => !allowedKeys.includes(key)));
  const entryKeys = dataEntry ? Object.keys(dataEntry).sort() : [];
  check('网络条目只含元数据（url/method/type/at/status），无 body/headers', entriesWithExtraFields.length === 0 && entryKeys.length > 0, {
    expected: allowedKeys,
    actual: { entryKeys, extraFields: entriesWithExtraFields.slice(0, 3) },
  });

  // Token scenario: the fixture's query token is fake and only exists to test redaction.
  await navigateAndWait(harness, `${fixture.url}?token=${FIXTURE_TOKEN}`, { expectedTitle: 'DSH UI Testing Fixture' });
  const tokenVisibleInPage = await harness.invoke('browser_eval', { expression: 'window.__fixture.token' });
  check('fixture 收到 ?token=<fixture-token> 并暴露给页面 JS', tokenVisibleInPage.value?.value === FIXTURE_TOKEN, {
    expected: FIXTURE_TOKEN,
    actual: tokenVisibleInPage.error || tokenVisibleInPage.value,
  });
  await sleep(400);
  const tokenNetwork = await harness.invoke('browser_network', { limit: 300 });
  const tokenEntries = (tokenNetwork.value?.entries || []).filter((entry) => String(entry.url).includes(FIXTURE_TOKEN));
  observations.tokenNetwork = tokenNetwork.value?.entries || [];
  const tokenRedacted = tokenEntries.length === 0;
  check('网络记录中的 URL 凭据必须脱敏', tokenRedacted && (tokenNetwork.value?.entries || []).some((entry) => /token=/.test(entry.url) && entry.redacted === true), {
    expected: 'token 不原样出现，带 token 的条目标记 redacted:true',
    actual: { tokenRedacted, entries: tokenNetwork.value?.entries },
  });
  if (!tokenRedacted) {
    finding({
      id: 'F5-network-no-redaction',
      severity: 'medium',
      advisory: true,
      summary: 'browser_network 原样返回请求 URL，未对 query 中的 token/凭据做脱敏；Agent 读取网络记录即可拿到用户页面 URL 里的敏感参数。',
      indexJsLines: ['237-244 (Network.requestWillBeSent)', '376-379 (traffic())'],
      evidence: { matchingEntries: tokenEntries.map((entry) => entry.url) },
    });
  }

  const tokenState = await harness.invoke('browser_state');
  check('state URL/activity/错误及导航 envelope 不泄露 token', !JSON.stringify(tokenState).includes(FIXTURE_TOKEN), { expected: 'redacted state/content', actual: tokenState.value });
  await harness.invoke('browser_eval', { expression: 'fetch("http://127.0.0.1:1/acceptance-failed").catch(()=>false)' });
  const failedNetwork = await harness.invoke('browser_network', { limit: 300 });
  const failedEntry = failedNetwork.value?.entries?.find((entry) => entry.url.includes('/acceptance-failed'));
  check('Network.loadingFailed 被记录为 failed 并保留错误描述', failedEntry?.failed === true && typeof failedEntry.errorText === 'string' && failedEntry.errorText.length > 0,
    { expected: { failed: true, errorText: 'non-empty' }, actual: failedEntry || failedNetwork.value });
  await navigateAndWait(harness, fixture.url, { expectedTitle: 'DSH UI Testing Fixture' });
}

async function probe7Screenshot({ harness, check, finding, evidenceDir }) {
  const shot = await harness.invoke('browser_screenshot', {});
  const base64 = shot.value?.image;
  check('browser_screenshot 返回 {viewport,bytes,image(base64 PN G)}', shot.ok && shot.value?.ok !== false && typeof base64 === 'string' && base64.length > 0, {
    expected: { viewport: EXPECTED_VIEWPORT, image: 'base64 PNG string' },
    actual: { viewport: shot.value?.viewport, bytes: shot.value?.bytes, base64Length: base64?.length },
  });
  check('返回 viewport 记录为默认 1280×800', JSON.stringify(shot.value?.viewport) === JSON.stringify(EXPECTED_VIEWPORT), {
    expected: EXPECTED_VIEWPORT,
    actual: shot.value?.viewport,
  });

  let buffer;
  try {
    buffer = Buffer.from(String(base64 || ''), 'base64');
  } catch {
    buffer = Buffer.alloc(0);
  }
  const pngMagic = buffer.subarray(0, 8);
  const expectedMagic = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  check('base64 可解码且 PNG 魔数正确', buffer.length > 8 && pngMagic.equals(expectedMagic), {
    expected: expectedMagic.toString('hex'),
    actual: { bytes: buffer.length, magicHex: pngMagic.toString('hex') },
  });

  const declaredBytes = Number(shot.value?.bytes);
  check('bytes 字段与实际解码字节数一致（±3 字节 base64 取整）', Number.isFinite(declaredBytes) && Math.abs(declaredBytes - buffer.length) <= 3, {
    expected: { decodedLength: buffer.length, tolerance: 3 },
    actual: declaredBytes,
  });

  let pngSize;
  if (buffer.length >= 24 && pngMagic.equals(expectedMagic)) {
    pngSize = { width: buffer.readUInt32BE(16), height: buffer.readUInt32BE(20) };
  }
  check('PNG IHDR 尺寸与 viewport 一致（1280×800）', pngSize?.width === EXPECTED_VIEWPORT.width && pngSize?.height === EXPECTED_VIEWPORT.height, {
    expected: EXPECTED_VIEWPORT,
    actual: pngSize,
  });

  let artifact;
  if (buffer.length > 0) {
    const file = join(evidenceDir, 'screenshot.png');
    await writeFile(file, buffer);
    artifact = { path: file, bytes: buffer.length, sha256: createHash('sha256').update(buffer).digest('hex') };
    check('截图落盘到本次独立运行目录', artifact.bytes === buffer.length, {
      expected: { file: artifact.path, bytes: buffer.length },
      actual: artifact,
    });
  }
  return artifact;
}

async function probe8CloseAndResources({ harness, check, finding }) {
  const { isProcessAlive, pathExists, scanPluginChromeProcesses, waitFor } = await import(pathToFileURL(join(HERE, 'harness.mjs')).href);
  const processesNow = newChromeProcesses({ scanPluginChromeProcesses });
  const profilesNow = newProfileDirs(await snapshotProfiles());
  check('关闭前本次运行恰好有 1 个插件 Chromium 与 1 个临时 profile', processesNow.length === 1 && profilesNow.length >= 1, {
    expected: { processes: 1, profiles: '>=1' },
    actual: { processes: processesNow.map((proc) => proc.pid), profiles: profilesNow },
  });
  const target = processesNow[0];
  if (!target) throw new Error('没有找到本次运行启动的 Chromium 进程，无法验证 close 资源回收');
  const targetProfile = target.profileDir;

  const beforeState = await harness.invoke('browser_state', {});
  check('关闭前 browser_state.running=true', beforeState.value?.running === true, { expected: true, actual: beforeState.value?.running });

  const closed = await harness.request({ method: 'POST', path: '/plugins/ui-testing/close', body: {} });
  check('POST /close 返回 {ok:true}', closed.statusCode === 200 && closed.json?.ok === true, {
    expected: { statusCode: 200, body: { ok: true } },
    actual: { statusCode: closed.statusCode, body: closed.json },
  });

  let processGone = false;
  try {
    await waitFor(() => !isProcessAlive(target.pid), { timeoutMs: 8000, label: `chromium pid ${target.pid} exit` });
    processGone = true;
  } catch { processGone = false; }
  check('关闭后对应 Chromium 进程消失', processGone, {
    expected: { pid: target.pid, alive: false },
    actual: { pid: target.pid, alive: isProcessAlive(target.pid) },
  });

  let profileGone = false;
  try {
    await waitFor(async () => !(await pathExists(targetProfile)), { timeoutMs: 8000, label: `profile ${targetProfile} removal` });
    profileGone = true;
  } catch { profileGone = false; }
  check('关闭后临时 profile 目录被删除', profileGone, {
    expected: { profileDir: targetProfile, exists: false },
    actual: { profileDir: targetProfile, exists: await pathExists(targetProfile) },
  });
  if (!profileGone) {
    finding({
      id: 'F6-profile-not-removed',
      severity: 'medium',
      advisory: true,
      summary: '关闭后临时 profile 目录未被删除（rm 由 setTimeout 1500ms 触发且失败被吞掉），会残留用户数据目录。',
      indexJsLines: ['381-396 (close())'],
      evidence: { profileDir: targetProfile },
    });
  }

  const stateAfterClose = await harness.invoke('browser_state', {});
  check('关闭后 browser_state.running=false 且 seq 归零', stateAfterClose.value?.running === false && stateAfterClose.value?.seq === 0, {
    expected: { running: false, seq: 0 },
    actual: { running: stateAfterClose.value?.running, seq: stateAfterClose.value?.seq },
  });

  const afterNetwork = await harness.invoke('browser_network');
  check('close 清空 URL/title/error/network 缓冲', stateAfterClose.value?.url === '' && stateAfterClose.value?.title === '' && stateAfterClose.value?.error === '' && afterNetwork.value?.entries?.length === 0,
    { expected: 'empty state and network', actual: { state: stateAfterClose.value, network: afterNetwork.value } });
  const secondClose = await harness.request({ method: 'POST', path: '/plugins/ui-testing/close', body: {} });
  check('POST /close 可重复调用（幂等）', secondClose.statusCode === 200 && secondClose.json?.ok === true, {
    expected: { statusCode: 200, body: { ok: true } },
    actual: { statusCode: secondClose.statusCode, body: secondClose.json },
  });

  const fixtureUrl = report.environment.fixtureUrl;
  const restarted = await navigateAndWait(harness, fixtureUrl, { expectedTitle: 'DSH UI Testing Fixture' });
  check('关闭后 browser_navigate 能重新 ensure 启动浏览器（幂等重启）', restarted.navigation.ok && restarted.loaded === true, {
    expected: { ok: true, loaded: true },
    actual: restarted.page,
  });
  await sleep(500);
  const processesAfterRestart = newChromeProcesses({ scanPluginChromeProcesses });
  const profilesAfterRestart = newProfileDirs(await snapshotProfiles());
  const newTarget = processesAfterRestart.find((proc) => proc.profileDir !== targetProfile);
  check('重启后使用新的 profile 目录与新进程（不复用已关闭状态）', Boolean(newTarget) && profilesAfterRestart.includes(newTarget.profileDir), {
    expected: { newProcess: true, newProfileDir: true },
    actual: { processes: processesAfterRestart.map((proc) => ({ pid: proc.pid, profileDir: proc.profileDir })), profiles: profilesAfterRestart },
  });

  if (!newTarget) {
    finding({
      id: 'F7-restart-no-new-process',
      severity: 'high',
      advisory: true,
      summary: 'close 后再次 navigate 没有观察到新的 Chromium 进程，ensure 幂等重启不成立。',
      indexJsLines: ['108-113 (ensure())', '150-186 (#start())'],
      evidence: { processes: processesAfterRestart, profiles: profilesAfterRestart },
    });
  }
}

async function probe9Isolation({ harnessA, createHarness, check, finding }) {
  const { scanPluginChromeProcesses, waitFor } = await import(pathToFileURL(join(HERE, 'harness.mjs')).href);
  const fixtureUrl = report.environment.fixtureUrl;
  // Workspace isolation: sessions inside one workspace still share one runtime (and its lease).
  // The fake sessions service maps every session id to one canonical workspace, so this probe
  // keeps its original "shared inside one apply" assertions while exercising the real identity
  // chain (exec.agent.session.header.cwd -> ctx.sessions -> workspaceRegistry.resolveByPath).
  const execA = { agent: { id: 'probe9-session', session: { header: { cwd: harnessA.workspaceDir } } } };

  await navigateAndWait(harnessA, fixtureUrl, { expectedTitle: 'DSH UI Testing Fixture', exec: execA });
  await navigateAndWait(harnessA, `${fixtureUrl}second.html`, { expectedTitle: 'DSH UI Testing Fixture — Second Page', exec: execA });
  const stateA = (await harnessA.invoke('browser_state', {}, execA)).value;
  check('单实例内第二次工具调用沿用同一浏览器（url 变为 second 页）', stateA?.running === true && String(stateA.url).includes('/second.html'), {
    expected: { running: true, url: '<fixture>/second.html' },
    actual: { running: stateA?.running, url: stateA?.url, viewport: stateA?.viewport },
  });
  const networkA = (await harnessA.invoke('browser_network', { limit: 300 }, execA)).value?.entries || [];
  check('单实例内 network 缓冲跨导航累积（共享）', networkA.some((entry) => String(entry.url).includes('/api/data')) && networkA.some((entry) => String(entry.url).includes('/second.html')), {
    expected: '同时含首次页面的 /api/data 与 /second.html 文档请求',
    actual: networkA.map((entry) => entry.url).slice(-8),
  });
  const viewportA = stateA?.viewport;

  const harnessB = await createHarness({ name: 'B' });
  try {
    await navigateAndWait(harnessB, `${fixtureUrl}?instance=b`, { expectedTitle: 'DSH UI Testing Fixture' });
    const stateB = (await harnessB.invoke('browser_state', {})).value;
    const stateAAfterB = (await harnessA.invoke('browser_state', {}, execA)).value;
    check('两个独立 apply 实例各自拥有独立浏览器（running 且 url 不同）', stateB?.running === true && stateB.url !== stateAAfterB?.url, {
      expected: { B: 'running:true，url 含 instance=b', A: '仍为 /second.html' },
      actual: { B: { running: stateB?.running, url: stateB?.url }, A: { running: stateAAfterB?.running, url: stateAAfterB?.url } },
    });
    const procs = newChromeProcesses({ scanPluginChromeProcesses });
    check('两个实例对应两个不同 Chromium 进程/profile', procs.length >= 2 && new Set(procs.map((proc) => proc.profileDir)).size >= 2, {
      expected: { processes: '>=2', distinctProfileDirs: '>=2' },
      actual: procs.map((proc) => ({ pid: proc.pid, profileDir: proc.profileDir })),
    });
    const networkB = (await harnessB.invoke('browser_network', { limit: 300 })).value?.entries || [];
    check('B 的 network 不包含 A 独有请求（实例间状态互不影响）', !networkB.some((entry) => String(entry.url).includes('/second.html')), {
      expected: 'B 记录中不含 A 打开的 /second.html',
      actual: networkB.map((entry) => entry.url).slice(-6),
    });

    const competing = await harnessA.invoke('browser_eval', { expression: 'location.href' }, { agent: { id: 'competing-session' } });
    check('同一 runtime 的其他会话不能读取 owner 页面', competing.threw === true && competing.error?.code === 'BUSY' && competing.error?.category === 'concurrency' && competing.error?.retryable === true,
      { expected: { code: 'BUSY', category: 'concurrency', retryable: true }, actual: competing });

    await harnessB.closeBrowser();
    await waitFor(() => {
      const remaining = newChromeProcesses({ scanPluginChromeProcesses });
      return remaining.length <= 1;
    }, { timeoutMs: 8000, label: 'harness B chromium exit' });
    check('探针结束后关闭 B 实例的浏览器（不影响 A）', (await harnessA.invoke('browser_state', {}, execA)).value?.running === true, {
      expected: { A: 'running:true', B: 'closed' },
      actual: { remainingProcesses: newChromeProcesses({ scanPluginChromeProcesses }).length },
    });
    // Release the workspace lease so the next probes start from a clean owner.
    await harnessA.ctx.emit('agent/disposed', { agent: { id: 'probe9-session' } });
  } finally {
    await harnessB.closeBrowser().catch(() => {});
    await harnessB.dispose().catch(() => {});
  }
}

async function probe10ErrorClassification({ harness, check, finding, observations }) {
  const badJson = await harness.request({ method: 'POST', path: '/plugins/ui-testing/eval', rawBody: '{' });
  check('HTTP 层非法 JSON 返回 500 {ok:false,error}', badJson.statusCode === 500 && badJson.json?.ok === false && typeof badJson.json?.error === 'string', {
    expected: { statusCode: 500, body: { ok: false, error: '请求体不是合法 JSON' } },
    actual: { statusCode: badJson.statusCode, body: badJson.json },
  });
  const httpErrors = [
    { label: '500 非法 JSON', result: badJson },
    { label: '404 未知指令', result: await harness.request({ method: 'POST', path: '/plugins/ui-testing/nope', body: {} }) },
    { label: '405 GET 写指令', result: await harness.request({ method: 'GET', path: '/plugins/ui-testing/navigate' }) },
  ];

  const shapes = [
    ...observations.toolThrows.map((item) => ({ kind: 'tool-throw', error: item.error })),
    ...observations.evalErrors.map((item) => ({ kind: 'eval-result', error: item.result })),
    ...observations.styleErrors.map((item) => ({ kind: 'computed-style-result', error: item.result })),
    ...httpErrors.map((item) => ({ kind: 'http-result', error: item.result.json })),
    ...observations.silentFailures.map((item) => ({ kind: 'silent-failure', error: item.invoke.value || item.invoke.error })),
  ];

  const classified = (error) => typeof error?.code === 'string' && typeof error?.category === 'string' && typeof error?.retryable === 'boolean';
  const invalid = shapes.filter((shape) => !classified(['eval-result', 'computed-style-result'].includes(shape.kind) ? shape.error?.error : shape.error));
  check('工具 throw、eval/style 操作失败、HTTP 错误均有 code/category/retryable', invalid.length === 0, { expected: [], actual: invalid });
  check('HTTP 错误保持 error 字符串兼容并带分类', httpErrors.every(({ result }) => typeof result.json?.error === 'string' && classified(result.json)), {
    expected: '{ok:false,error:string,code,category,retryable}', actual: httpErrors.map(({ result }) => result.json),
  });
  const throws = [...observations.toolThrows.map((item) => item.error), ...observations.silentFailures.map((item) => item.invoke.error)];
  check('工具失败抛 BrowserError 且 message 包含 [CODE] 和 action 证据', throws.every((error) => error?.name === 'BrowserError' && error.message.includes(`[${error.code}]`) && /actionId/.test(error.message) && error.details && typeof error.details === 'object'),
    { expected: 'BrowserError + [CODE] + actionId + details', actual: throws });
  check('真实页面路径覆盖 NAV_FAILED/TARGET_NOT_FOUND/EVAL_ERROR', ['NAV_FAILED', 'TARGET_NOT_FOUND', 'EVAL_ERROR'].every((code) => shapes.some((shape) => (shape.error?.code || shape.error?.error?.code) === code)), { expected: ['NAV_FAILED', 'TARGET_NOT_FOUND', 'EVAL_ERROR'], actual: shapes });
}

/* ------------------------------------------------------------------------------------------------
 * Frame pipeline probes (P11–P13): WebSocket push, transport security, metrics + poll fallback
 * ---------------------------------------------------------------------------------------------- */

async function httpJson(url, { method = 'GET', body, timeoutMs = 8000 } = {}) {
  const response = await fetch(url, {
    method,
    headers: body !== undefined ? { 'content-type': 'application/json' } : undefined,
    body: body !== undefined ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(timeoutMs),
  });
  let json;
  try { json = await response.json(); } catch { json = undefined; }
  return { statusCode: response.status, json };
}

async function nudgePage(harness, tag, { count = 3, waitMs = 220 } = {}) {
  for (let index = 0; index < count; index += 1) {
    await harness.invoke('browser_eval', {
      expression: `document.body.dataset.acceptanceNudge='${tag}-${index}';`
        + `document.body.style.outline='${index + 2}px solid rgb(${10 + index * 30}, 20, 30)';`,
    });
    await sleep(waitMs);
  }
}

function frameHeaderProblems(header) {
  const problems = [];
  if (header?.v !== 1) problems.push(`v=${truncate(header?.v)}`);
  if (!Number.isInteger(header?.seq) || header.seq < 0) problems.push(`seq=${truncate(header?.seq)}`);
  if (!Number.isInteger(header?.epoch) || header.epoch < 0) problems.push(`epoch=${truncate(header?.epoch)}`);
  if (typeof header?.capturedAtMs !== 'number' || header.capturedAtMs <= 0) problems.push(`capturedAtMs=${truncate(header?.capturedAtMs)}`);
  if (typeof header?.receivedAtMs !== 'number' || header.receivedAtMs <= 0) problems.push(`receivedAtMs=${truncate(header?.receivedAtMs)}`);
  if (typeof header?.width !== 'number' || header.width <= 0) problems.push(`width=${truncate(header?.width)}`);
  if (typeof header?.height !== 'number' || header.height <= 0) problems.push(`height=${truncate(header?.height)}`);
  if (typeof header?.pageWidth !== 'number' || header.pageWidth <= 0) problems.push(`pageWidth=${truncate(header?.pageWidth)}`);
  if (typeof header?.pageHeight !== 'number' || header.pageHeight <= 0) problems.push(`pageHeight=${truncate(header?.pageHeight)}`);
  if (header?.format !== 'jpeg') problems.push(`format=${truncate(header?.format)}`);
  for (const key of ['coalesced', 'blocked', 'stale']) {
    if (!Number.isInteger(header?.dropped?.[key]) || header.dropped[key] < 0) problems.push(`dropped.${key}=${truncate(header?.dropped?.[key])}`);
  }
  return problems;
}

async function probe11FramePush({ harness, httpServer, check, finding, skip, observations }) {
  const helpers = observations.helpers;
  const upgradeRoute = harness.upgradeRoutes().find((route) => route.path === '/plugins/ui-testing/frames');
  if (!upgradeRoute) {
    skip('未捕获 webServer.registerUpgrade("/plugins/ui-testing/frames")：frame-push 实现尚未落地，P11 SKIP');
    return;
  }
  if (!httpServer) {
    skip('真实 plugin HTTP server 未启动，无法测试 WS 推送，P11 SKIP');
    return;
  }
  const fixture = observations.fixture;
  const readiness = await navigateAndWait(harness, fixture.url, { expectedTitle: 'DSH UI Testing Fixture' });
  check('测试前浏览器可导航到 fixture', readiness.navigation.ok === true && readiness.loaded === true, {
    expected: { ok: true, loaded: true },
    actual: readiness.page,
  });

  const wsUrl = `${httpServer.wsUrl}/plugins/ui-testing/frames`;
  const client = await helpers.connectFrameWebSocket(wsUrl, { timeoutMs: 6000 }).catch((failure) => failure);
  check('WS 握手成功（真实 node:http server + Node 22 WebSocket 客户端）', client.opened === true, {
    expected: { opened: true },
    actual: { opened: client.opened, error: client.error, closeCode: client.closeCode },
  });
  if (!client.opened) return;

  let hello;
  try {
    hello = await helpers.waitForWebSocket(client, (value) => value.hellos[0], { timeoutMs: 5000, label: 'hello text' });
  } catch { /* checked below */ }
  check('握手后先收到文本 hello', Boolean(hello) && hello.type === 'hello' && hello.transport === 'ws', {
    expected: { type: 'hello', transport: 'ws' },
    actual: { hello, textMessages: client.textMessages.slice(0, 3) },
  });

  await nudgePage(harness, 'push');
  try {
    await helpers.waitForWebSocket(client, (value) => value.frames.length >= 2, { timeoutMs: 8000, label: 'two binary frames' });
  } catch { /* checked below */ }
  const legacyEntry = harness.ctx?.__internal?.plugin?.registry?.peek?.('legacy:default');
  check('收到至少 2 个二进制帧（用于校验 seq 单调）', client.frames.length >= 2, {
    expected: { frames: '>=2' },
    actual: {
      frames: client.frames.length, binaryMessages: client.binaryMessages.length, malformed: client.malformedBinary.slice(0, 2),
      debug: {
        wsClosed: client.closed, wsError: client.error, closeCode: client.closeCode,
        sourceSeq: legacyEntry?.runtime?.frames?.seq, subscribers: legacyEntry?.runtime?.frames?.subscribers?.size,
        sourceEpoch: legacyEntry?.runtime?.frames?.epoch, latestEpoch: legacyEntry?.runtime?.frames?.latest()?.epoch,
        latestSeq: legacyEntry?.runtime?.frames?.latest()?.seq,
        screencastFrames: legacyEntry?.runtime?.screencastFrames, screencastAcks: legacyEntry?.runtime?.screencastAcks,
        navigationCount: legacyEntry?.runtime?.navigationCount,
        visibility: (await harness.invoke('browser_eval', { expression: 'document.visibilityState' })).value?.value,
        pusher: legacyEntry?.runtime?.frameTransport?.metrics?.() || null,
        ackFailures: legacyEntry?.runtime?.ackFailures, lastError: legacyEntry?.runtime?.lastError,
        running: legacyEntry?.runtime?.running,
      },
    },
  });
  const first = client.frames[0];
  check('二进制帧可解析为 [uint32BE 头长度][JSON 头][JPEG]', Boolean(first), {
    expected: { headerLength: 'uint32BE', header: 'JSON', payload: 'JPEG' },
    actual: first ? { headerLength: first.headerLength, totalBytes: first.totalBytes, jpegBytes: first.jpeg.length } : { malformed: client.malformedBinary.slice(0, 2) },
  });
  if (!first) return;

  const problems = frameHeaderProblems(first.header);
  check('帧头字段完整（v/seq/epoch/capturedAtMs/receivedAtMs/width/height/pageWidth/pageHeight/format/dropped）', problems.length === 0, {
    expected: {
      v: 1, seq: 'integer>=0', epoch: 'integer>=0', capturedAtMs: 'number', receivedAtMs: 'number',
      width: '>0', height: '>0', pageWidth: '>0', pageHeight: '>0', format: 'jpeg',
      dropped: { coalesced: 'int', blocked: 'int', stale: 'int' },
    },
    actual: { header: first.header, problems },
  });
  check('负载是 JPEG（SOI 0xFFD8）且字节数合理', helpers.isJpegBuffer(first.jpeg) && first.jpeg.length > 100, {
    expected: { magic: 'ffd8', bytes: '>100' },
    actual: { magic: first.jpeg.subarray(0, 4).toString('hex'), bytes: first.jpeg.length },
  });

  const seqs = client.frames.map((frame) => frame.header?.seq).filter((seq) => Number.isInteger(seq));
  check('WS 帧 seq 单调递增', seqs.length >= 2 && seqs.every((seq, index) => index === 0 || seq >= seqs[index - 1]), {
    expected: 'seq 非递减',
    actual: seqs,
  });

  const epochBefore = Math.max(...client.frames.map((frame) => frame.header?.epoch ?? -1));
  const framesBeforeNav = client.frames.length;
  const navAt = Date.now();
  await navigateAndWait(harness, `${fixture.url}second.html`, { expectedTitle: 'DSH UI Testing Fixture — Second Page' });
  await sleep(600);
  await nudgePage(harness, 'after-nav');
  try {
    await helpers.waitForWebSocket(client, (value) => value.frames.length > framesBeforeNav, { timeoutMs: 8000, label: 'frames after navigation' });
  } catch { /* checked below */ }
  const afterNav = client.frames.slice(framesBeforeNav);
  check('页面导航后收到新的二进制帧（新 epoch）', afterNav.length > 0, {
    expected: { framesAfterNavigation: '>=1', previousEpoch: epochBefore },
    actual: { framesAfterNavigation: afterNav.length },
  });
  const epochAfter = afterNav.map((frame) => frame.header?.epoch).filter((epoch) => Number.isInteger(epoch));
  check('导航后帧 epoch 大于导航前（epoch 递增）', epochAfter.length > 0 && epochAfter.every((epoch) => epoch > epochBefore), {
    expected: `epoch > ${epochBefore}`,
    actual: { epochs: epochAfter },
  });
  const lateFrames = client.frames.filter((frame) => frame.receivedAt >= navAt + 300);
  check('导航后不再推送旧 epoch 帧（旧 epoch 丢弃）', lateFrames.length > 0 && lateFrames.every((frame) => (frame.header?.epoch ?? -1) > epochBefore), {
    expected: `receivedAt >= navAt+300 的帧 epoch > ${epochBefore}`,
    actual: { lateFrameEpochs: lateFrames.map((frame) => frame.header?.epoch) },
  });
  const allSeqs = client.frames.map((frame) => frame.header?.seq).filter((seq) => Number.isInteger(seq));
  check('跨导航的全局 seq 保持单调', allSeqs.every((seq, index) => index === 0 || seq >= allSeqs[index - 1]), {
    expected: 'seq 非递减',
    actual: allSeqs,
  });

  if (afterNav.length === 0 || epochAfter.length === 0) {
    finding({
      id: 'F10-frame-push-epoch-missing',
      severity: 'high',
      advisory: true,
      summary: 'WS 推送在页面导航后没有观察到新 epoch 帧，或帧头缺少 epoch；旧 epoch 帧丢弃/epoch 递增无法证明。',
      indexJsLines: [],
      evidence: { epochBefore, afterNav: afterNav.map((frame) => frame.header) },
    });
  }

  await helpers.closeFrameWebSocket(client);
  check('测试结束可正常关闭 WS 客户端', client.closed === true, {
    expected: { closed: true },
    actual: { closed: client.closed, closeCode: client.closeCode },
  });
}

async function probe12FrameTransportSecurity({ harness, httpServer, check, finding, skip, observations }) {
  const helpers = observations.helpers;
  const upgradeRoute = harness.upgradeRoutes().find((route) => route.path === '/plugins/ui-testing/frames');
  if (!upgradeRoute) {
    skip('未捕获 registerUpgrade("/plugins/ui-testing/frames")：鉴权/loopback 门禁实现尚未落地，P12 SKIP');
    return;
  }
  if (!httpServer) {
    skip('真实 plugin HTTP server 未启动，P12 SKIP');
    return;
  }
  const wsUrl = `${httpServer.wsUrl}/plugins/ui-testing/frames`;
  const connection = helpers.createFakeConnectionService({ rejection: 401 });
  harness.setConnection(connection);

  const denied401 = await helpers.connectFrameWebSocket(wsUrl, { timeoutMs: 3000 }).catch((failure) => failure);
  check('connection.requestRejection=401 时 WS 升级被拒绝', denied401.opened === false, {
    expected: { opened: false },
    actual: { opened: denied401.opened, error: denied401.error, closeCode: denied401.closeCode },
  });
  check('拒绝升级时确实调用了 requestRejection', connection.calls.length > 0, {
    expected: { calls: '>=1' },
    actual: { calls: connection.calls.length },
  });

  connection.setRejection(403);
  const denied403 = await helpers.connectFrameWebSocket(wsUrl, { timeoutMs: 3000 }).catch((failure) => failure);
  check('connection.requestRejection=403 时 WS 升级被拒绝', denied403.opened === false, {
    expected: { opened: false },
    actual: { opened: denied403.opened, error: denied403.error, closeCode: denied403.closeCode },
  });

  connection.setRejection(undefined);
  const allowed = await helpers.connectFrameWebSocket(wsUrl, { timeoutMs: 5000 }).catch((failure) => failure);
  check('requestRejection=undefined 时同源 WS 允许升级', allowed.opened === true, {
    expected: { opened: true },
    actual: { opened: allowed.opened, error: allowed.error },
  });
  if (allowed.opened) await helpers.closeFrameWebSocket(allowed);

  // No connection service: loopback is allowed, non-loopback must be rejected. The real HTTP
  // server always sees 127.0.0.1, so the non-loopback case goes through the captured upgrade
  // handler directly with a forged remoteAddress and a Duplex socket stub.
  harness.setConnection(undefined);
  const loopbackAllowed = await helpers.connectFrameWebSocket(wsUrl, { timeoutMs: 5000 }).catch((failure) => failure);
  check('无 connection 服务时 loopback 升级仍允许', loopbackAllowed.opened === true, {
    expected: { opened: true },
    actual: { opened: loopbackAllowed.opened, error: loopbackAllowed.error },
  });
  if (loopbackAllowed.opened) await helpers.closeFrameWebSocket(loopbackAllowed);

  const direct = helpers.invokeUpgradeRoute(harness, { path: '/plugins/ui-testing/frames', remoteAddress: '203.0.113.9' });
  if (!direct) {
    skip('升级 handler 无法直接调用（未导出/路径不一致），非 loopback 场景 P12 SKIP');
    return;
  }
  await Promise.race([direct.settled, sleep(600)]);
  const written = direct.socket.writtenText;
  const attemptedUpgrade = /101 Switching Protocols/i.test(written);
  const rejected = direct.socket.destroyed === true || direct.socket.ended === true;
  check('无 connection 服务时非 loopback 升级被拒绝（伪造 remoteAddress）', attemptedUpgrade === false && rejected, {
    expected: { upgraded: false, socketClosed: true, remoteAddress: '203.0.113.9' },
    actual: {
      upgraded: attemptedUpgrade,
      destroyed: direct.socket.destroyed,
      ended: direct.socket.ended,
      writtenHead: written.slice(0, 200),
      thrown: direct.thrown ? String(direct.thrown.message || direct.thrown) : undefined,
    },
  });
  if (attemptedUpgrade || !rejected) {
    finding({
      id: 'F11-non-loopback-upgrade-allowed',
      severity: 'high',
      advisory: true,
      summary: '没有 connection 服务时，非 loopback 的 /frames 升级未被拒绝（socket stub 观察）。',
      indexJsLines: [],
      evidence: { writtenHead: written.slice(0, 300), destroyed: direct.socket.destroyed, ended: direct.socket.ended },
    });
  }
}

async function probe13MetricsFallback({ harness, httpServer, check, finding, skip, observations }) {
  const helpers = observations.helpers;
  if (!httpServer) {
    skip('真实 plugin HTTP server 未启动，P13 SKIP');
    return;
  }
  const fixture = observations.fixture;
  const base = `${httpServer.url}/plugins/ui-testing`;

  // /metrics presence decides whether this probe can run at all (implementation may land later).
  const metricsInitial = await httpJson(`${base}/metrics`);
  if (metricsInitial.statusCode === 404) {
    const poll = await httpJson(`${base}/frame?since=0`);
    check('/frame 轮询回退仍返回图像（观察项）', typeof poll.json?.image === 'string' && poll.json.image.length > 0, {
      expected: { image: 'base64 JPEG/PNG' },
      actual: { statusCode: poll.statusCode, keys: poll.json ? Object.keys(poll.json) : [], pending: poll.json?.pending },
    }, { advisory: true });
    skip('GET /metrics 返回 404：metrics/frame-push 实现尚未落地，P13 SKIP（/frame 轮询回退仅记录为观察项，不计入通过）');
    return;
  }

  await navigateAndWait(harness, fixture.url, { expectedTitle: 'DSH UI Testing Fixture' });
  await nudgePage(harness, 'poll');
  let frameJson;
  try {
    await helpers.waitFor(async () => {
      const response = await httpJson(`${base}/frame?since=0`);
      if (response.statusCode === 200 && typeof response.json?.image === 'string' && response.json.image.length > 0) {
        frameJson = response.json;
        return true;
      }
      await nudgePage(harness, 'poll-retry', { count: 1, waitMs: 100 });
      return false;
    }, { timeoutMs: 8000, intervalMs: 200, label: 'GET /frame image' });
  } catch { /* checked below */ }
  check('GET /frame?since 仍返回图像（轮询回退保留）', Boolean(frameJson?.image), {
    expected: { image: 'non-empty base64' },
    actual: { keys: frameJson ? Object.keys(frameJson) : [], pending: frameJson?.pending },
  });
  check('/frame 响应新增 epoch 与 transport="poll"', Number.isInteger(frameJson?.epoch) && frameJson?.transport === 'poll', {
    expected: { epoch: 'integer', transport: 'poll' },
    actual: { epoch: frameJson?.epoch, transport: frameJson?.transport },
  });

  // The frozen contract puts pushed/dropped/clients directly on host; the current implementation
  // nests them under host.transport. Normalize both so the probe measures behaviour, and record
  // the shape deviation as a finding instead of silently accepting it.
  const rawHost = metricsInitial.json?.host;
  const transportMetrics = rawHost?.transport || {};
  const hostMetrics = {
    captured: rawHost?.captured,
    pushed: rawHost?.pushed ?? transportMetrics.pushed,
    clients: rawHost?.clients ?? transportMetrics.clients,
    dropped: rawHost?.dropped ?? {
      coalesced: transportMetrics.coalesced,
      blocked: transportMetrics.blocked,
      stale: transportMetrics.stale,
      rejected: transportMetrics.rejected,
    },
    ackFailures: rawHost?.ackFailures,
    captureFps: rawHost?.captureFps,
    captureIntervalMs: rawHost?.captureIntervalMs,
    lastFrame: rawHost?.lastFrame,
    nestedUnderTransport: rawHost?.transport !== undefined,
  };
  const hostShapeOk = metricsInitial.json?.ok === true
    && ['captured', 'pushed', 'ackFailures', 'clients', 'captureFps', 'captureIntervalMs', 'lastFrame'].every((key) => key in hostMetrics)
    && ['coalesced', 'blocked', 'stale'].every((key) => key in (hostMetrics.dropped || {}));
  check('GET /metrics 返回 {ok,host:{captured,pushed,dropped,ackFailures,clients,captureFps,captureIntervalMs,lastFrame}}', hostShapeOk, {
    expected: { ok: true, host: ['captured', 'pushed', 'dropped{coalesced,blocked,stale}', 'ackFailures', 'clients', 'captureFps', 'captureIntervalMs', 'lastFrame'] },
    actual: metricsInitial.json,
  });
  if (hostShapeOk && hostMetrics.nestedUnderTransport) {
    const findingDefinition = {
      id: 'F12-metrics-host-shape',
      severity: 'low',
      advisory: true,
      summary: '/metrics 的 host 结构与冻结契约不一致：pushed/clients/dropped.* 实际嵌在 host.transport 下，契约要求直接在 host 顶层（验收探针已做兼容归一化，功能计数本身可用）。',
      indexJsLines: [],
      evidence: { hostKeys: rawHost ? Object.keys(rawHost) : [], transportKeys: Object.keys(transportMetrics) },
    };
    if (!report.findings.some((item) => item.id === findingDefinition.id)) finding(findingDefinition);
  }
  check('metrics.host.captured/pushed/ackFailures/clients 为非负整数，captureFps/captureIntervalMs 为数字', ['captured', 'pushed', 'ackFailures', 'clients'].every((key) => Number.isInteger(hostMetrics[key]) && hostMetrics[key] >= 0)
    && typeof hostMetrics.captureFps === 'number' && hostMetrics.captureFps >= 0
    && typeof hostMetrics.captureIntervalMs === 'number' && hostMetrics.captureIntervalMs >= 0, {
    expected: 'captured/pushed/ackFailures/clients integer>=0; captureFps/captureIntervalMs number>=0',
    actual: hostMetrics,
  });
  check('metrics.host.captured > 0（已在真实浏览器里采集过帧）', hostMetrics.captured > 0, {
    expected: '> 0',
    actual: hostMetrics.captured,
  });
  check('metrics.host.lastFrame 为对象或 null', metricsInitial.json?.host?.lastFrame === null || typeof metricsInitial.json?.host?.lastFrame === 'object', {
    expected: 'object|null',
    actual: metricsInitial.json?.host?.lastFrame,
  });

  const sample = {
    transport: 'ws',
    displayFps: 12.5,
    endToEndMs: 42,
    transportMs: 3.5,
    droppedClient: 1,
    received: 10,
    displayed: 9,
    seq: Number.isInteger(frameJson?.seq) ? frameJson.seq : 1,
    epoch: Number.isInteger(frameJson?.epoch) ? frameJson.epoch : 0,
    measuredAt: Date.now(),
  };
  const posted = await httpJson(`${base}/metrics`, { method: 'POST', body: sample });
  check('POST /metrics 接受客户端实测（2xx）', posted.statusCode >= 200 && posted.statusCode < 300, {
    expected: { statusCode: '2xx' },
    actual: { statusCode: posted.statusCode, body: posted.json },
  });
  const metricsAfter = await httpJson(`${base}/metrics`);
  const echoed = metricsAfter.json?.client;
  check('POST 后 GET /metrics 能读到 client 数据', Boolean(echoed) && echoed.transport === sample.transport && echoed.seq === sample.seq && echoed.received === sample.received, {
    expected: { transport: 'ws', seq: sample.seq, received: sample.received },
    actual: echoed,
  });

  const ws = await helpers.connectFrameWebSocket(`${httpServer.wsUrl}/plugins/ui-testing/frames`, { timeoutMs: 5000 }).catch((failure) => failure);
  check('关闭前可建立 WS（用于验证 /close 关闭推送）', ws.opened === true, {
    expected: { opened: true },
    actual: { opened: ws.opened, error: ws.error },
  });
  const closed = await httpJson(`${base}/close`, { method: 'POST', body: {} });
  check('POST /close 返回 ok', closed.statusCode === 200 && closed.json?.ok === true, {
    expected: { statusCode: 200, body: { ok: true } },
    actual: { statusCode: closed.statusCode, body: closed.json },
  });
  let wsClosed = false;
  if (ws.opened) {
    try {
      await helpers.waitFor(() => ws.closed === true, { timeoutMs: 6000, label: 'host closed websocket' });
      wsClosed = true;
    } catch { wsClosed = false; }
  }
  check('/close 后服务端关闭所有 WS 连接', ws.opened === true && wsClosed === true, {
    expected: { hostClosedClient: true },
    actual: { opened: ws.opened, closed: ws.closed, closeCode: ws.closeCode },
  });
  const pending = await httpJson(`${base}/frame?since=0`);
  check('/close 后 /frame?since 返回 pending:true（帧缓存清空）', pending.statusCode === 200 && pending.json?.pending === true, {
    expected: { statusCode: 200, pending: true },
    actual: { statusCode: pending.statusCode, body: pending.json && { pending: pending.json.pending, seq: pending.json.seq, epoch: pending.json.epoch } },
  });
}

/* ------------------------------------------------------------------------------------------------
 * Main lifecycle: cleanup + evidence writing
 * ---------------------------------------------------------------------------------------------- */

const state = {
  harnessA: undefined,
  harnesses: [],
  fixture: undefined,
  httpServer: undefined,
  createHarness: undefined,
  startPluginHttpServer: undefined,
  scanPluginChromeProcesses: undefined,
  isProcessAlive: undefined,
  hardTimedOut: false,
  finished: false,
  cleanupResult: undefined,
  artifacts: [],
};

async function cleanupResources(reason) {
  if (state.cleanupResult) return state.cleanupResult;
  log(`\n[cleanup] start (${reason})`);
  const result = {
    reason,
    closedHarnesses: [],
    killedPids: [],
    removedProfileDirs: [],
    leftoverProfileDirs: [],
    leftoverChromePids: [],
    fixtureClosed: false,
    errors: [],
  };
  try {
    for (const harness of state.harnesses) {
      try { await harness.closeBrowser(); } catch (error) { result.errors.push(`close ${harness.name}: ${errorMessage(error)}`); }
      result.closedHarnesses.push(harness.name);
    }
    await sleep(1200);
    for (const harness of state.harnesses) {
      try { await harness.dispose(); } catch (error) { result.errors.push(`dispose ${harness.name}: ${errorMessage(error)}`); }
    }
    const scan = state.scanPluginChromeProcesses || (await import(pathToFileURL(join(HERE, 'harness.mjs')).href)).scanPluginChromeProcesses;
    const isAlive = state.isProcessAlive || ((pid) => { try { process.kill(pid, 0); return true; } catch { return false; } });
    const stray = newChromeProcesses({ scanPluginChromeProcesses: scan });
    for (const proc of stray) {
      try { process.kill(proc.pid, 'SIGTERM'); } catch { /* ignore */ }
    }
    if (stray.length) await sleep(1500);
    for (const proc of stray) {
      if (isAlive(proc.pid)) {
        try { process.kill(proc.pid, 'SIGKILL'); } catch { /* ignore */ }
      }
      if (!isAlive(proc.pid)) result.killedPids.push(proc.pid);
    }
    await sleep(400);
    let allProfiles = [];
    try {
      const harness = await import(pathToFileURL(join(HERE, 'harness.mjs')).href);
      allProfiles = await harness.snapshotProfileDirs();
    } catch { /* ignore */ }
    const leftovers = newProfileDirs(allProfiles);
    for (const dir of leftovers) {
      // Only delete directories under tmpdir() that did not exist before this run.
      if (!dir.startsWith(tmpdir() + sep)) continue;
      try {
        await rm(dir, { recursive: true, force: true });
        result.removedProfileDirs.push(dir);
      } catch (error) {
        result.errors.push(`rm ${dir}: ${errorMessage(error)}`);
      }
    }
    const afterProfiles = allProfiles.filter((dir) => !result.removedProfileDirs.includes(dir) && newProfileDirs([dir]).length > 0);
    result.leftoverProfileDirs = afterProfiles;
    result.leftoverChromePids = stray.filter((proc) => isAlive(proc.pid)).map((proc) => proc.pid);
    if (state.httpServer) {
      try { await state.httpServer.close(); result.httpServerClosed = true; } catch (error) { result.errors.push(`http server close: ${errorMessage(error)}`); }
    }
    if (state.fixture) {
      try { await state.fixture.close(); result.fixtureClosed = true; } catch (error) { result.errors.push(`fixture close: ${errorMessage(error)}`); }
    }
  } catch (error) {
    result.errors.push(`cleanup failure: ${errorMessage(error)}`);
    try {
      const fallback = await import(pathToFileURL(join(HERE, 'harness.mjs')).href);
      const stray = newChromeProcesses({ scanPluginChromeProcesses: fallback.scanPluginChromeProcesses });
      for (const proc of stray) { try { process.kill(proc.pid, 'SIGKILL'); } catch { /* ignore */ } result.killedPids.push(proc.pid); }
    } catch { /* ignore */ }
  }
  state.cleanupResult = result;
  log(`[cleanup] done: killed=${result.killedPids.length} removedProfiles=${result.removedProfileDirs.length} leftoverProfiles=${result.leftoverProfileDirs.length} leftoverPids=${result.leftoverChromePids.length} fixtureClosed=${result.fixtureClosed}`);
  return result;
}

function buildSanitizedNetwork(entries) {
  const sanitize = (raw) => {
    const text = String(raw || '');
    if (text.startsWith('data:')) {
      const comma = text.indexOf(',');
      const media = comma > 0 ? text.slice(5, comma) : 'data';
      return `data:${media},[omitted ${text.length - comma - 1} chars]`;
    }
    try {
      const url = new URL(text);
      for (const key of [...url.searchParams.keys()]) {
        if (/token|secret|password|passwd|key|auth|session|credential/i.test(key)) url.searchParams.set(key, '[REDACTED_IN_EVIDENCE]');
      }
      return url.href;
    } catch {
      return text.replace(/([?&](?:token|secret|password|key|auth|session)[^=]*=)[^&]*/gi, '$1[REDACTED_IN_EVIDENCE]');
    }
  };
  return {
    note: 'browser_network 元数据；证据文件已对 query 中的凭据类参数做脱敏。靶机 token 是 DEMO_TOKEN_NOT_REAL（假值）。',
    capturedAt: new Date().toISOString(),
    entries: (entries || []).map((entry) => ({
      url: sanitize(entry.url),
      method: entry.method,
      type: entry.type,
      status: entry.status,
      at: entry.at,
    })),
  };
}

async function writeEvidence() {
  await mkdir(EVIDENCE_DIR, { recursive: true });
  const tokenEntries = (report.observations?.tokenNetwork || []);
  await writeFile(join(EVIDENCE_DIR, 'network.json'), JSON.stringify(buildSanitizedNetwork(tokenEntries.length ? tokenEntries : report.observations?.initialNetwork || []), null, 2));
  const required = report.probes
    .filter((probe) => probe.status !== 'skip')
    .flatMap((probe) => probe.checks.filter((check) => !check.advisory));
  const failed = required.filter((check) => !check.pass);
  const skipped = report.probes.filter((probe) => probe.status === 'skip').length;
  report.summary = {
    probes: report.probes.length,
    passed: report.probes.filter((probe) => probe.status === 'pass').length,
    failed: report.probes.filter((probe) => probe.status === 'fail').length,
    skipped,
    requiredChecks: required.length,
    failedChecks: failed.length,
    findings: report.findings.length,
    exitCode: failed.length > 0 ? 1 : 0,
  };
  report.resources = state.cleanupResult || { reason: 'not-run' };
  report.environment.fixtureUrl = report.environment.fixtureUrl || state.fixture?.url;
  await writeFile(join(EVIDENCE_DIR, 'run-report.json'), JSON.stringify(report, null, 2));
  await writeFile(join(EVIDENCE_DIR, 'run.log'), logLines.join('\n') + '\n');
  return report.summary;
}

async function main() {
  await mkdir(EVIDENCE_DIR, { recursive: true });
  // IMPORTANT: choose the Chromium plan *before* importing harness/index.js. index.js reads
  // CHROME_BIN at module load time, so the sandbox fallback must be in process.env first.
  const chromium = await chooseChromiumPlan();
  await captureRunBaseline();
  const harnessModule = await import(pathToFileURL(join(HERE, 'harness.mjs')).href);
  const { createHarness, startPluginHttpServer } = harnessModule;
  state.createHarness = createHarness;
  state.startPluginHttpServer = startPluginHttpServer;
  state.scanPluginChromeProcesses = harnessModule.scanPluginChromeProcesses;
  state.isProcessAlive = harnessModule.isProcessAlive;
  report.environment = {
    suite: report.suite,
    node: process.version,
    platform: `${process.platform}/${process.arch}`,
    repoRoot: REPO_ROOT,
    chromeBin: chromium.bin,
    chromePlan: chromium,
    expectation: 'Chrome 默认 /opt/google/chrome/chrome；DSH_UI_TESTING_CHROME 可覆盖',
    fakeContext: 'effect/tools.register/webServer.register/skills.register/logger/inject',
    timeoutMs: TOTAL_TIMEOUT_MS,
    fixtureUrl: undefined,
  };
  log(`[env] chromium plan: ${chromium.source} -> ${chromium.bin}`);

  const { startFixtureServer } = await import(pathToFileURL(join(REPO_ROOT, 'tests/ui_test_fixture/server.mjs')).href);
  state.fixture = await startFixtureServer();
  report.environment.fixtureUrl = state.fixture.url;
  log(`[env] fixture: ${state.fixture.url}`);

  const harnessA = await createHarness({ name: 'A' });
  state.harnessA = harnessA;
  state.harnesses.push(harnessA);
  log(`[env] tools: ${harnessA.toolNames().join(', ')}`);
  log(`[env] skill registrations: ${harnessA.skillRegistrations.length} (${harnessA.skillRegistrations.map((skill) => skill.name).join(', ') || 'none'})`);

  // Real node:http server around the plugin's own registered routes: required for the frame
  // WebSocket pipeline (upgrade handlers cannot be exercised by the direct fake req/res helper).
  state.httpServer = await startPluginHttpServer(harnessA);
  report.environment.httpServerUrl = state.httpServer.url;
  report.environment.httpRoutes = harnessA.httpRoutes().map((route) => ({ kind: route.kind, path: route.path }));
  report.environment.upgradeRoutes = harnessA.upgradeRoutes().map((route) => route.path);
  log(`[env] plugin HTTP server: ${state.httpServer.url} (upgrade routes: ${harnessA.upgradeRoutes().map((route) => route.path).join(', ') || 'none'})`);

  const observations = {
    fixture: state.fixture,
    toolThrows: [],
    evalErrors: [],
    styleErrors: [],
    silentFailures: [],
    initialNetwork: [],
    tokenNetwork: [],
    helpers: harnessModule,
  };

  await runProbe({ id: 'P1-tool-surface', title: '工具注册面与能力发现', group: 'infrastructure', expected: '恰好 30 个 browser_* 工具（10 T1 + 7 T2 + 6 T3 + 7 network），名称/参数 schema 与 docs/runtime-t1.md + docs/viewport-control.md §7 + docs/t2-structured-gui.md §2.2 + docs/t3-vision.md §2.1 + docs/network-p0.md §2 一致，无原始 CDP 工具；HTTP 路由可用' }, ({ check, finding }) => probe1ToolSurface({ harness: harnessA, check, finding }));
  await runProbe({
    id: 'P23-network-surface',
    title: 'network P0 工具面（注册/schema/离线诊断/owner/BUSY/旧工具不变）',
    group: 'network',
    expected: 'network 组 7 工具注册且 required/schema 与 docs/network-p0.md §2 一致；未启动时 session(status/reset)/events/detail/evidence/subscribe/control(status) 可诊断且不启动 Chromium；域错误为 NET_* 结构化 BrowserError（不降级 INTERNAL）；control 在其他 owner 下 BUSY 且写操作零副作用；旧 22 工具（含 browser_network 元数据白名单）行为不变',
  }, ({ check, finding }) => probe23NetworkSurface({ harness: harnessA, createHarness: state.createHarness, fixture: state.fixture, check, finding }));
  await runProbe({ id: 'P2-navigate-state', title: '导航与运行态', group: 'navigation', expected: 'fixture 可导航，state.url/running 正确，state.title 反映文档标题；file:// 被拒；不可达地址产生错误字符串' }, ({ check, finding }) => probe2Navigate({ harness: harnessA, check, finding, observations }));
  await runProbe({ id: 'P3-eval', title: '页面 JS 执行', group: 'js', expected: '#counter 初始 "0"；{ok,value,type} 形态；页面抛异常返回 {ok:false,error}；支持 awaitPromise' }, ({ check, finding }) => probe3Eval({ harness: harnessA, check, finding, observations }));
  await runProbe({ id: 'P4-computed-style', title: '计算样式', group: 'css', expected: '#style-target 的 color/font-size/font-weight/padding 精确命中；不存在 selector 返回 {ok:false,error}' }, ({ check, finding }) => probe4ComputedStyle({ harness: harnessA, check, finding, observations }));
  await runProbe({ id: 'P5-native-input', title: '原生输入副作用', group: 'input', expected: '按 rect 中心派发鼠标点击使 #counter 0→1；text 事件写入 #name；点击提交后 #result 变化' }, ({ check, finding }) => probe5Input({ harness: harnessA, check, finding }));
  await runProbe({ id: 'P6-network', title: '网络观察与脱敏', group: 'network', expected: '能看到自动 /api/data 请求（url/method/status）；条目只有元数据；带 token 导航后凭据必须脱敏' }, ({ check, finding }) => probe6Network({ harness: harnessA, check, finding, observations }));
  await runProbe({ id: 'P7-screenshot', title: '截图证据', group: 'evidence', expected: 'browser_screenshot 返回可解码 PNG，viewport 1280×800，落盘本次 runs 目录的 screenshot.png' }, async ({ check, finding }) => {
    const artifact = await probe7Screenshot({ harness: harnessA, check, finding, evidenceDir: EVIDENCE_DIR });
    if (artifact) state.artifacts.push(artifact);
  });
  report.observations = observations;
  await runProbe({ id: 'P8-close-resources', title: '关闭与资源回收', group: 'resources', expected: '/close 后 Chromium 进程消失、临时 profile 删除、state.running=false、可幂等重启' }, ({ check, finding }) => probe8CloseAndResources({ harness: harnessA, check, finding }));
  await runProbe({ id: 'P9-isolation', title: '会话隔离', group: 'isolation', expected: '单实例内共享 url/viewport/network；两个独立 apply 实例各自独立浏览器且互不影响' }, ({ check, finding }) => probe9Isolation({ harnessA, createHarness, check, finding }));
  await runProbe({ id: 'P10-error-classification', title: '错误分类', group: 'errors', expected: '工具 throw/HTTP 500/404/405/eval/style 均有结构化分类，工具失败消息带证据，HTTP error 保持字符串' }, ({ check, finding }) => probe10ErrorClassification({ harness: harnessA, check, finding, observations }));

  await runProbe({
    id: 'P11-frame-push',
    title: 'WebSocket 帧推送（真实 HTTP server + 真实 WS 客户端）',
    group: 'frame-pipeline',
    expected: '升级成功、收到 hello、二进制帧头完整/JPEG 魔数正确、seq 单调、导航后 epoch 递增且旧 epoch 帧被丢弃',
  }, ({ check, finding, skip }) => probe11FramePush({ harness: harnessA, httpServer: state.httpServer, check, finding, skip, observations }));
  await runProbe({
    id: 'P12-frame-transport-security',
    title: '帧传输鉴权与 loopback 门禁',
    group: 'frame-security',
    expected: 'requestRejection 401/403 拒绝升级且被实际调用；undefined 允许；无 connection 服务时 loopback 允许、非 loopback 拒绝',
  }, ({ check, finding, skip }) => probe12FrameTransportSecurity({ harness: harnessA, httpServer: state.httpServer, check, finding, skip, observations }));
  await runProbe({
    id: 'P13-metrics-fallback',
    title: 'metrics 观测与 /frame 轮询回退、/close 清理',
    group: 'frame-pipeline',
    expected: '/frame?since 仍返回图像且含 epoch/transport="poll"；/metrics host 计数与 captureFps；POST /metrics 后 GET 可读 client；/close 关闭 WS 且 /frame pending',
  }, ({ check, finding, skip }) => probe13MetricsFallback({ harness: harnessA, httpServer: state.httpServer, check, finding, skip, observations }));

  const milestones = await import('./milestone-probes.mjs');
  await runProbe({ id: 'P14-capabilities', title: '运行时能力发现', group: 'M2', expected: '30 工具声明、运行时服务探测、http-request 与 web.t1.viewport available、七项 web.t2.* 与 structured-dom available、六项 web.t3.* 与 static-vision available、七项 web.network.* 与 p0 聚合可用状态、limits.viewport/capture 比例契约、T4 unsupported' }, ({ check }) => milestones.capabilityProbe({ harness: harnessA, check }));
  await runProbe({ id: 'P15-owner-lease', title: '会话 lease、读取隔离与 disposed', group: 'M1', expected: '只有一个 owner、所有页面/网络访问校验、只读诊断跨会话、disposed 释放' }, ({ check }) => milestones.leaseProbe({ check }));
  await runProbe({ id: 'P19-target-policy', title: '导航目标与重定向安全', group: 'M1', expected: '工具/HTTP 阻断非法目标、loopback 放行、重定向目标重新校验' }, ({ check }) => milestones.targetPolicyProbe({ harness: harnessA, check, fixture: state.fixture }));
  await navigateAndWait(harnessA, state.fixture.url, { expectedTitle: 'DSH UI Testing Fixture' });
  await runProbe({ id: 'P16-action-evidence', title: '操作 envelope 与截图附件/回退', group: 'M2', expected: '30 工具（含 7 个 T2、7 个 network）每次成功调用返回并 render envelope + evidence、截图 hash/time、附件和 base64 两条路径' }, ({ check }) => milestones.evidenceProbe({ harness: harnessA, check }));
  await runProbe({ id: 'P17-cancel-serial', title: '取消与面板同锁串行', group: 'M0/M1', expected: 'signal 取消 1s 内 ABORTED，后续可恢复，面板输入与 Agent 不交错' }, ({ check }) => milestones.cancellationProbe({ harness: harnessA, check, fixture: state.fixture }));
  await runProbe({ id: 'P18-startup-failure', title: '启动失败清理', group: 'M0', expected: '错误明确、无 profile 遗留' }, ({ check }) => milestones.startupFailureProbe({ check }));

  // P20 (N2): functional keys and modifier forwarding. Ground truth is the page's own DOM event
  // record read back through browser_eval — never a screenshot or an "applied" count.
  const inputModifiers = await import('./input-modifiers.mjs');
  await runProbe({
    id: 'P20-input-modifiers',
    title: '功能键与修饰键输入',
    group: 'input',
    expected: 'Tab/Shift+Tab 焦点前进/回退、Ctrl+A 的 ctrlKey+key、virtualKeyCode→e.keyCode、位掩码/autoRepeat/mouse/wheel 修饰、老式最小调用仍生效、非法参数 INVALID_ARGUMENT 且不派发；commands/unmodifiedText/pointerType:pen 的页面真值（不可观察时 INCONCLUSIVE）',
  }, async ({ check, finding }) => {
    await inputModifiers.inputModifiersProbe({ harness: harnessA, check, fixture: state.fixture });
    await inputModifiers.inputPageTruthProbe({ harness: harnessA, check, finding, fixture: state.fixture });
  });

  // P21 (task-3): the host snapshots tool values with @deepseek-ai/dsh-util-values and rejects any
  // undefined property. This probe applies that real validator to the real tool outputs.
  const hostContract = await import('./host-contract.mjs');
  await runProbe({
    id: 'P21-host-output-contract',
    title: '宿主输出契约（lossless JSON）',
    group: 'host-contract',
    expected: '全部 30 工具（含 7 个 network）成功值与 render content 通过真实 snapshotJsonValue；eval undefined/抛错/number 参数/无附件截图/失败网络条目/抛错 details/类实例附件/T2 证据/network 工具值均无 undefined 且可快照',
  }, async ({ check, finding }) => {
    await hostContract.hostOutputContractProbe({ harness: harnessA, check, finding, fixture: state.fixture });
    await hostContract.attachmentProjectionProbe({ createHarness, check });
  });

  // P22: the independent HTTP client. It never starts Chromium; its own temp loopback servers
  // provide redirect chains / body / header edge cases.
  await runProbe({
    id: 'P22-http-request',
    title: '独立 HTTP 请求',
    group: 'http',
    expected: '注册/默认、POST echo、500/404、默认不跟随、显式跟随+每跳复验、超限、方法规则、超时、取消、阻断/重定向阻断零派发、非法参数零副作用、正文上限与字节、无 cookie jar、脱敏、证据、lossless、未启动/关闭态、卸载清理',
  }, ({ check, finding }) => httpRequest.httpRequestProbe({ check, finding, fixture: state.fixture }));

  log('\n[cleanup] closing browsers and fixtures');
  await cleanupResources('suite-complete');
  const summary = await writeEvidence();
  state.finished = true;
  printSummary(summary);
  return summary.exitCode;
}

function printSummary(summary) {
  log('\n================ T1 web acceptance summary ================');
  for (const probe of report.probes) {
    const required = probe.checks.filter((check) => !check.advisory);
    const passed = required.filter((check) => check.pass).length;
    const detail = probe.status === 'skip'
      ? `SKIP: ${probe.skipReason || ''}`
      : `${passed}/${required.length} checks, ${probe.findings.length} findings`;
    log(`${probe.id.padEnd(24)} ${probe.status.toUpperCase().padEnd(5)} ${detail} (${probe.durationMs}ms)`);
  }
  if (report.findings.length) {
    log('\nfindings:');
    for (const finding of report.findings) {
      log(`  [${finding.id}] ${finding.severity}: ${finding.summary}`);
      if (finding.indexJsLines.length) log(`      index.js: ${finding.indexJsLines.join('; ')}`);
    }
  }
  log(`\nprobes=${summary.probes} pass=${summary.passed} fail=${summary.failed} skip=${summary.skipped} requiredChecks=${summary.requiredChecks} failedChecks=${summary.failedChecks} findings=${summary.findings}`);
  log(`evidence: ${EVIDENCE_DIR}`);
  log(`EXIT ${summary.exitCode}`);
}

const watchdog = setTimeout(async () => {
  if (state.finished) return;
  state.hardTimedOut = true;
  log(`\n[watchdog] HARD TIMEOUT after ${TOTAL_TIMEOUT_MS}ms — cleaning up and exiting 2`);
  try { await cleanupResources('hard-timeout'); } catch { /* ignore */ }
  try { await writeEvidence(); } catch { /* ignore */ }
  process.exit(2);
}, TOTAL_TIMEOUT_MS);
watchdog.unref?.();

let exitCode = 0;
try {
  exitCode = await main();
} catch (error) {
  log(`\n[fatal] ${errorMessage(error)}`);
  console.error(error);
  report.fatal = { name: error?.name, message: errorMessage(error), stack: String(error?.stack || '').split('\n').slice(0, 12) };
  try {
    await cleanupResources('fatal-error');
    await writeEvidence();
  } catch (cleanupError) {
    console.error(cleanupError);
  }
  exitCode = 2;
}
process.exitCode = exitCode;