#!/usr/bin/env node
/**
 * WEB-T4 dynamic-network fixture preparation acceptance suite (task-3).
 *
 * Contract: tests/ui_test_fixture/t4-prep-contract.md §2 (frozen by the Lead) — the 15 required
 * check groups for the single-page commerce chain target, plus the route/truth table in
 * tests/ui_test_fixture/t4-network.md.
 *
 * Numbering is N1–N15 (one criterion per contract §2 required item; deliberately NOT merged into
 * docs/network-p0.md §10 C1–C52: this suite answers "is the T4 prep target ready and can the
 * existing network tool surface observe a real business chain", not "is T4 implemented"). T4 stays
 * implemented (5 T4 tools) and the tool surface is 35: this suite still only drives the
 * existing network tools, and N15 now asserts the registered 35-tool truth instead of the
 * preparation-round "unsupported/30" snapshot.
 *
 * Ground truth is the fixture, never a tool's own `ok:true`:
 *   - `window.__t4.net` (page-side ops/requests/responses/ui/ws/sse/polls/errors ledger) via
 *     browser_eval;
 *   - the fixture's deterministic `/api/t4/*` responses and the server-side ledger
 *     (`GET /api/t4/ledger?runId=t4-run-1`) via browser_http_request;
 *   - the captured network events (browser_network_events/detail/trace) and the PNG bytes on disk.
 *
 * Conventions (identical to network-p0.mjs / network-chain.mjs):
 *   - loads the real plugin entry (index.js) through tests/acceptance/harness.mjs (fake Cordis ctx)
 *     and starts the repository's own loopback fixture;
 *   - drives ONLY the registered agent tools - no CDP shim, no playwright/puppeteer, no external
 *     network, no real DSH instance (3080/3081 are never touched);
 *   - writes tests/acceptance/runs/<iso>-<pid>/run-report.json + run.log + PNG captures; the run
 *     directory is the persistent capture root (DSH_UI_TESTING_CAPTURE_DIR) and is kept for review;
 *   - exit 0 = all 15 criteria covered and every required check passed, 1 = at least one required
 *     check failed, 2 = the suite itself could not run (no usable Chromium / fixture missing /
 *     fatal error / hard timeout / SIGINT partial report);
 *   - single driver: run it as
 *       flock /tmp/dsh-t4-browser.lock node tests/acceptance/t4-network-fixtures.mjs
 *     never in parallel with another browser suite.
 *
 * Env: DSH_T4NET_ONLY="N1,N6" (debug subset), DSH_T4NET_TIMEOUT_MS (default 900000),
 *      DSH_UI_TESTING_CHROME (Chromium override).
 */
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = dirname(dirname(HERE));
const EVIDENCE_DIR = join(HERE, 'runs', `${new Date().toISOString().replace(/[:.]/g, '-')}-${process.pid}`);
const DEFAULT_CHROME = '/opt/google/chrome/chrome';
const CHROME_WRAPPER = join(HERE, 'chrome-wrapper.sh');
const TOTAL_TIMEOUT_MS = Number(process.env.DSH_T4NET_TIMEOUT_MS || 900000) || 900000;
const EXEC_ID = 't4-network';

/**
 * Persistent capture/evidence root for this run. Set BEFORE harness.mjs is imported so the plugin
 * never falls back to `<session cwd>/output` (the repository): screenshots land in
 * `<run>/output/capture/<actionId>.png` and stay there for review.
 */
process.env.DSH_UI_TESTING_CAPTURE_DIR = EVIDENCE_DIR;

/* ---- frozen fixture truth (contract §2 + t4-network.md) --------------------------------------- */
const RUN_ID = 't4-run-1';
const TRACE_ID = 't4-trace-1';
const ORDER_ID = 'ORD-T4-1';
const PRICE = 4200;
const PAGE_PATH = '/web-t4-network.html';
const TITLE = 'DSH T4 动态网络靶机';
const SCENARIOS = ['normal', 'no-ws', 'no-sse', 'poll-off', 'dup', 'fail-cart', 'fail-order', 'slow-order'];

/* ---- report plumbing -------------------------------------------------------------------------- */
const logLines = [];
function log(line = '') {
  const text = String(line);
  logLines.push(text);
  console.log(text);
}
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const errorMessage = (error) => String((error && error.message) || error);
const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');

/** Minimal PNG IHDR reader (dimensions + sha256) for `browser_screenshot`'s base64 image. */
function pngInfo(base64) {
  const bytes = Buffer.from(String(base64 || ''), 'base64');
  const signatureOk = bytes.length > 24 && bytes.toString('latin1', 1, 4) === 'PNG';
  return {
    ok: signatureOk,
    bytes: bytes.length,
    sha256: bytes.length ? sha256(bytes) : null,
    width: signatureOk ? bytes.readUInt32BE(16) : null,
    height: signatureOk ? bytes.readUInt32BE(20) : null,
  };
}

function jsonSafe(value, depth = 0) {
  if (value === undefined) return undefined;
  if (value === null || typeof value !== 'object') return value;
  if (depth > 7) return '[depth-limit]';
  if (Array.isArray(value)) return value.slice(0, 80).map((item) => jsonSafe(item, depth + 1));
  if (Buffer.isBuffer(value)) return `[Buffer ${value.length} bytes]`;
  const out = {};
  for (const [key, item] of Object.entries(value)) {
    if (key === 'image' || key === 'base64') { out[key] = '[base64 omitted]'; continue; }
    if (key === 'stack') { out[key] = String(item).split('\n').slice(0, 8).join('\n'); continue; }
    out[key] = jsonSafe(item, depth + 1);
  }
  return out;
}

function truncate(value, max = 460) {
  const text = typeof value === 'string' ? value : JSON.stringify(jsonSafe(value));
  if (text === undefined) return '';
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

const report = {
  schemaVersion: 1,
  suite: 'acceptance-t4-network-fixtures',
  contract: 'tests/ui_test_fixture/t4-prep-contract.md §2 (15 required check groups)',
  truthTable: 'tests/ui_test_fixture/t4-network.md',
  generatedAt: new Date().toISOString(),
  command: 'flock /tmp/dsh-t4-browser.lock node tests/acceptance/t4-network-fixtures.mjs',
  environment: {},
  probes: [],
  criteria: [],
  findings: [],
  notRun: [],
  screenshots: [],
  resources: {},
  summary: {},
};

const CRITERIA = [
  ['N1', '页面加载：标题/节点/version/runId/traceId/初始 cart 0/无跨源请求'],
  ['N2', '网络采集：start 后导航，初始 GET /api/t4/cart 与 WS 握手/帧可见'],
  ['N3', '操作→网络：点击加购 → POST + GET /api/t4/cart、200、trace 关联'],
  ['N4', '网络→视觉 + 服务端真值：cart 增量、ui cause、ledger 同 requestId/traceId'],
  ['N5', '重复发送：dup double 加购 → 2×POST 同 key、第二条 deduped、cart 只 +1、UI 一次变化'],
  ['N6', '结算链路：POST orders、SSE pending/paid/fulfilled、3 次轮询、UI 最终已支付/已完成'],
  ['N7', 'WS→视觉：cart-updated 推高徽标、ui cause{kind:ws}、真值与网络帧一致'],
  ['N8', '错误传导：fail-cart 500 → #t4n-error 含 CART_REJECTED、ui.error.cause=requestId'],
  ['N9', '重试：fail-order 500 ORDER_REJECTED → 同 key 重试 retried:true 成功、错误消失'],
  ['N10', '慢请求：slow-order duration ≥700ms、最终 UI 更新'],
  ['N11', 'Trace/步骤关联：步骤 counters 含 http/ws/sse、correlation 同组 ≥3、causality 无 temporal'],
  ['N12', '服务端账本：method/path/status/traceId/idempotencyKey 与浏览器真值一致、seq 单调'],
  ['N13', '重置：server + 页面账本清空、再次加购从 revision 1 开始'],
  ['N14', '截图证据：错误态/订单完成态整页 PNG 落 run 目录、sha256/尺寸/路径'],
  ['N15', '不越界：工具面 35 与 harness 表一致、T4 五工具真实注册、无 stale unsupported 声明'],
];

const criterionChecks = new Map();
const state = {
  harnesses: [],
  fixture: undefined,
  chromium: undefined,
  cleanupResult: undefined,
  baselineProfiles: new Set(),
  baselinePids: new Set(),
  ownedProfiles: new Set(),
  finished: false,
};

function recordCriterionCheck(criteria, entry) {
  if (!criterionChecks.has(criteria)) criterionChecks.set(criteria, []);
  criterionChecks.get(criteria).push(entry);
}

function makeProbe(id, title, criteria, expected) {
  return {
    id, criteria, title, expected, status: 'pass',
    startedAt: new Date().toISOString(), durationMs: 0,
    checks: [], findings: [], notRun: [], actual: '', error: undefined,
  };
}

function addCheck(probe, label, pass, { expected, actual } = {}, { advisory = false } = {}) {
  const entry = { label, expected: jsonSafe(expected), actual: jsonSafe(actual), pass: Boolean(pass), advisory };
  probe.checks.push(entry);
  if (!pass && !advisory) probe.status = 'fail';
  log(`  [${pass ? 'PASS' : advisory ? 'INFO' : 'FAIL'}] ${label}`);
  if (!pass) {
    log(`         expected: ${truncate(expected)}`);
    log(`         actual  : ${truncate(actual)}`);
  }
  return entry;
}

function addFinding(probe, { id, severity = 'info', summary, evidence }) {
  const finding = { id, probeId: probe.id, criteria: probe.criteria, severity, advisory: true, summary: String(summary), evidence: jsonSafe(evidence) ?? {} };
  probe.findings.push(finding);
  report.findings.push(finding);
  log(`  [FINDING ${id}/${severity}] ${summary}`);
  return finding;
}

async function runProbe(meta, body) {
  const probe = makeProbe(meta.id, meta.title, meta.criteria, meta.expected);
  const startedAt = Date.now();
  let skipped = false;
  log(`\n== ${probe.id} (criteria ${probe.criteria}) — ${probe.title}`);
  const check = (label, pass, detail, options) => addCheck(probe, label, pass, detail, options);
  const finding = (definition) => addFinding(probe, definition);
  const notRun = (label, reason, { disposition = 'NOT_RUN' } = {}) => {
    probe.notRun.push({ label, reason: String(reason), disposition });
    report.notRun.push({ probeId: probe.id, criteria: probe.criteria, label, reason: String(reason), disposition });
    log(`  [${disposition}] ${label}: ${reason}`);
  };
  const skip = (reason) => {
    skipped = true;
    probe.status = 'skip';
    probe.actual = `NOT_RUN: ${String(reason)}`;
    log(`  [NOT_RUN] ${probe.actual}`);
  };
  try {
    await body({ probe, check, finding, notRun, skip });
  } catch (error) {
    if (skipped) {
      probe.error = { name: error?.name, message: errorMessage(error), note: 'thrown after NOT_RUN' };
    } else {
      probe.status = 'fail';
      probe.error = { name: error?.name, message: errorMessage(error), stack: String(error?.stack || '').split('\n').slice(0, 8) };
      addCheck(probe, '探针执行过程中未抛出异常', false, {
        expected: 'probe completes',
        actual: { name: error?.name, message: errorMessage(error) },
      });
    }
  }
  probe.durationMs = Date.now() - startedAt;
  const required = probe.checks.filter((item) => !item.advisory);
  const failed = required.filter((item) => !item.pass);
  if (!skipped) {
    probe.actual = failed.length
      ? `${failed.length}/${required.length} required checks failed: ${failed.map((item) => item.label).join('; ')}`
      : `${required.length} required checks passed${probe.findings.length ? ` (+${probe.findings.length} findings)` : ''}${probe.notRun.length ? ` (+${probe.notRun.length} NOT_RUN)` : ''}`;
  }
  report.probes.push(probe);
  log(`== ${probe.id} ${probe.status.toUpperCase()} (${probe.durationMs}ms) — ${probe.actual}`);
  return probe;
}

/* ---- tool helpers (registered tools only; no CDP access from the test) ------------------------ */
const execOf = () => ({ agent: { id: EXEC_ID } });
const call = (harness, tool, args = {}, exec = execOf()) => harness.invoke(tool, args, exec);
const errorOf = (result) => result?.error || result?.value?.error || {};

async function pageValue(harness, expression, exec = execOf()) {
  const result = await call(harness, 'browser_eval', { expression }, exec);
  if (!result.ok) throw new Error(`browser_eval threw: ${errorMessage(result.error)}`);
  if (result.value?.ok === false) throw new Error(`browser_eval value error: ${truncate(result.value?.error)}`);
  return result.value?.value;
}

/** Page-side truth snapshot (`window.__t4.net.snapshot()`); null until the page booted. */
function truthOf(harness, exec = execOf()) {
  return pageValue(harness, 'window.__t4 && window.__t4.net && window.__t4.net.snapshot ? window.__t4.net.snapshot() : null', exec);
}

async function waitTruth(harness, predicate, { label = 'page truth condition', timeoutMs = 20000, exec = execOf() } = {}) {
  const startedAt = Date.now();
  let last = null;
  let lastError = null;
  while (Date.now() - startedAt < timeoutMs) {
    try {
      last = await truthOf(harness, exec);
      if (last && predicate(last)) return last;
    } catch (error) { lastError = error; }
    await sleep(100);
  }
  throw new Error(`timed out waiting for ${label}; last=${truncate(last)}${lastError ? `; error=${errorMessage(lastError)}` : ''}`);
}

async function navigate(harness, path, exec = execOf()) {
  const result = await call(harness, 'browser_navigate', { url: FIXTURE_BASE + path }, exec);
  if (!result.ok) throw new Error(`navigate ${path} threw: ${truncate(result.error)}`);
  if (result.value?.ok === false) throw new Error(`navigate ${path} failed: ${truncate(result.value?.error)}`);
  return result;
}

async function click(harness, selector, exec = execOf()) {
  const result = await call(harness, 'browser_click', { selector }, exec);
  if (!result.ok) throw new Error(`browser_click ${selector} threw: ${truncate(result.error)}`);
  if (result.value?.ok === false) throw new Error(`browser_click ${selector} failed: ${truncate(result.value?.error)}`);
  return result;
}

async function eventsOf(harness, params = {}, exec = execOf()) {
  const result = await call(harness, 'browser_network_events', { limit: 200, view: 'summary', order: 'desc', ...params }, exec);
  if (!result.ok) throw new Error(`browser_network_events threw: ${truncate(result.error)}`);
  const value = result.value || {};
  const events = Array.isArray(value.events) ? [...value.events] : [];
  events.sort((left, right) => (left.seq ?? 0) - (right.seq ?? 0));
  return { ...result, value: { ...value, events } };
}

async function allEvents(harness, exec = execOf()) {
  return (await eventsOf(harness, { limit: 200 }, exec)).value.events || [];
}

/** Highest captured event seq right now; used to ignore earlier probes' events after an action. */
async function eventWatermark(harness, exec = execOf()) {
  const events = await allEvents(harness, exec);
  return events.reduce((max, event) => Math.max(max, Number(event.seq) || 0), 0);
}

async function waitEvents(harness, predicate, { count = 1, timeoutMs = 20000, label = 'matching events', exec = execOf(), filter = null } = {}) {
  const startedAt = Date.now();
  let last = [];
  while (Date.now() - startedAt < timeoutMs) {
    const value = (await eventsOf(harness, filter ? { filter } : {}, exec)).value;
    last = (value.events || []).filter(predicate);
    if (last.length >= count) return last;
    await sleep(100);
  }
  throw new Error(`timed out waiting for ${count} ${label} (saw ${last.length})`);
}

const urlHas = (part) => (event) => String(event.url || '').includes(part);

async function detailOf(harness, args, exec = execOf()) {
  const result = await call(harness, 'browser_network_detail', args, exec);
  if (!result.ok) throw new Error(`browser_network_detail threw: ${truncate(result.error)}`);
  if (result.value?.ok === false) throw new Error(`browser_network_detail failed: ${truncate(result.value?.error)}`);
  return result.value || {};
}

async function trace(harness, args, exec = execOf()) {
  const result = await call(harness, 'browser_network_trace', args, exec);
  if (!result.ok) throw new Error(`browser_network_trace ${args.action} threw: ${truncate(result.error)}`);
  if (result.value?.ok === false) throw new Error(`browser_network_trace ${args.action} failed: ${truncate(result.value?.error)}`);
  return result.value || {};
}

const stepOfValue = (value) => (value?.steps && value.steps[0]) || value?.step || null;

/** Server-side truth ledger via the registered HTTP tool (no page involvement, no CDP). */
async function fetchLedger(harness) {
  const result = await call(harness, 'browser_http_request', { url: `${FIXTURE_BASE}/api/t4/ledger?runId=${RUN_ID}` });
  if (!result.ok) throw new Error(`browser_http_request ledger threw: ${truncate(result.error)}`);
  const value = result.value || {};
  if (value.status !== 200) throw new Error(`ledger status ${value.status}: ${truncate(value.body)}`);
  let parsed = null;
  try { parsed = JSON.parse(value.body); } catch (error) { throw new Error(`ledger body is not JSON: ${truncate(value.body)}`); }
  return parsed;
}

async function postReset(harness) {
  const result = await call(harness, 'browser_http_request', { method: 'POST', url: `${FIXTURE_BASE}/api/t4/reset`, headers: { 'content-type': 'application/json' }, body: '{}' });
  if (!result.ok) throw new Error(`reset threw: ${truncate(result.error)}`);
  if (result.value?.status !== 200) throw new Error(`reset status ${result.value?.status}: ${truncate(result.value?.body)}`);
  return result.value;
}

async function capture(harness, label) {
  const shot = await call(harness, 'browser_screenshot', {});
  if (!shot.ok) throw new Error(`browser_screenshot threw: ${truncate(shot.error)}`);
  if (shot.value?.ok === false) throw new Error(`browser_screenshot failed: ${truncate(shot.value?.error)}`);
  const value = shot.value || {};
  const captureBlock = value.capture || {};
  const file = captureBlock.file || {};
  const diskPath = typeof file.path === 'string' ? join(EVIDENCE_DIR, file.path) : null;
  const png = pngInfo(value.image);
  const entry = {
    label,
    actionId: value.actionId || null,
    width: png.width ?? captureBlock.png?.width ?? null,
    height: png.height ?? captureBlock.png?.height ?? null,
    imageBytes: png.bytes || null,
    imageSha256: png.sha256,
    file: jsonSafe(file),
    diskPath,
  };
  report.screenshots.push(entry);
  log(`  [shot] ${label}: ${file.path || '(no file)'} ${entry.width}x${entry.height}`);
  return entry;
}

/* ---- scenario helpers ------------------------------------------------------------------------ */

/** Switch scenario through the page's own API (server + local ledger reset, channels reconnected). */
async function setScenario(harness, name) {
  const value = await pageValue(harness, `window.__t4.net.setScenario(${JSON.stringify(name)})`);
  if (!value || value.ok !== true) throw new Error(`setScenario(${name}) failed: ${truncate(value)}`);
  return value;
}

/** Wait until the (re)connected WS delivered its one-shot cart-updated push (baseline stabiliser). */
async function waitWsPush(harness, timeoutMs = 12000) {
  return waitTruth(harness, (truth) => truth.ws.frames.some((frame) => frame.direction === 'in'
    && frame.data && frame.data.type === 'cart-updated'), { label: 'WS cart-updated frame', timeoutMs });
}

/* ---- Chromium plan / ownership (same rules as run.mjs / network-p0.mjs) ----------------------- */
let spawnProcess;
async function loadSpawn() {
  if (spawnProcess) return spawnProcess;
  const childProcess = await import('node:child_process');
  spawnProcess = childProcess.spawn;
  return spawnProcess;
}

let harnessModuleRef;
async function harnessModule() {
  if (!harnessModuleRef) harnessModuleRef = await import(pathToFileURL(join(HERE, 'harness.mjs')).href);
  return harnessModuleRef;
}

async function probeChromium(bin, timeoutMs = 7000) {
  await loadSpawn();
  const profileDir = await mkdtemp(join(tmpdir(), 'dsh-t4net-chrome-probe-'));
  const startedAt = Date.now();
  let stderr = '';
  let exited = false;
  let proc;
  try {
    proc = spawnProcess(bin, ['--headless=new', '--remote-debugging-port=0', `--user-data-dir=${profileDir}`,
      '--no-first-run', '--no-default-browser-check', '--disable-gpu', 'about:blank']);
    proc.on('exit', () => { exited = true; });
    proc.stderr?.on('data', (chunk) => { stderr = (stderr + String(chunk)).slice(-2000); });
    let ok = false;
    while (Date.now() - startedAt < timeoutMs) {
      try {
        const text = await readFile(join(profileDir, 'DevToolsActivePort'), 'utf8');
        if (Number(text.split('\n')[0])) { ok = true; break; }
      } catch { /* not ready yet */ }
      if (exited) break;
      await sleep(100);
    }
    return { ok, bin, durationMs: Date.now() - startedAt, stderrTail: stderr.trim().slice(-800) };
  } finally {
    try { proc?.kill('SIGKILL'); } catch { /* ignore */ }
    await sleep(250);
    try { await rm(profileDir, { recursive: true, force: true }); } catch { /* ignore */ }
  }
}

async function chooseChromiumPlan() {
  const explicit = process.env.DSH_UI_TESTING_CHROME;
  if (explicit) return { bin: explicit, source: 'env', note: 'DSH_UI_TESTING_CHROME 由调用方显式指定，跳过默认探活' };
  if (!existsSync(DEFAULT_CHROME)) throw new Error(`默认 Chromium 不存在：${DEFAULT_CHROME}（可用 DSH_UI_TESTING_CHROME 覆盖）`);
  log(`[env] probing default chromium: ${DEFAULT_CHROME}`);
  const direct = await probeChromium(DEFAULT_CHROME);
  if (direct.ok) return { bin: DEFAULT_CHROME, source: 'default', probe: direct };
  log('[env] default chromium launch failed; probing sandbox wrapper');
  const wrapped = await probeChromium(CHROME_WRAPPER);
  if (!wrapped.ok) {
    throw new Error(`没有可用的 Chromium：默认二进制与沙箱 wrapper 都启动失败。默认 stderr=${direct.stderrTail}；wrapper stderr=${wrapped.stderrTail}`);
  }
  process.env.DSH_UI_TESTING_CHROME = CHROME_WRAPPER;
  return {
    bin: CHROME_WRAPPER, source: 'sandbox-fallback', realBin: DEFAULT_CHROME,
    note: '沙箱内 Chrome setuid sandbox / /dev/shm 不可用；wrapper 只追加 --no-sandbox --disable-dev-shm-usage --disable-crash-reporter。',
    defaultProbe: direct, wrapperProbe: wrapped,
  };
}

function ownedNewProfiles(all) {
  return all.filter((dir) => !state.baselineProfiles.has(dir) && state.ownedProfiles.has(dir));
}

function ownedNewChromeProcesses(scan) {
  const owned = scan().filter((proc) => proc.parentPid === process.pid && !state.baselinePids.has(proc.pid));
  for (const proc of owned) state.ownedProfiles.add(proc.profileDir);
  return owned;
}

const isAlive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };

async function cleanupResources(reason) {
  if (state.cleanupResult) return state.cleanupResult;
  log(`\n[cleanup] start (${reason})`);
  const result = {
    reason, closedHarnesses: [], killedPids: [], removedProfileDirs: [], leftoverProfileDirs: [],
    leftoverChromePids: [], fixtureClosed: false, evidenceDir: EVIDENCE_DIR, errors: [],
  };
  const module = await harnessModule();
  try {
    for (const harness of state.harnesses) {
      try { await harness.closeBrowser(); } catch (error) { result.errors.push(`close ${harness.name}: ${errorMessage(error)}`); }
      result.closedHarnesses.push(harness.name);
    }
    await sleep(1200);
    for (const harness of state.harnesses) {
      try { await harness.dispose(); } catch (error) { result.errors.push(`dispose ${harness.name}: ${errorMessage(error)}`); }
    }
    const stray = ownedNewChromeProcesses(module.scanPluginChromeProcesses);
    for (const proc of stray) { try { process.kill(proc.pid, 'SIGTERM'); } catch { /* ignore */ } }
    if (stray.length) await sleep(1200);
    for (const proc of stray) {
      if (isAlive(proc.pid)) { try { process.kill(proc.pid, 'SIGKILL'); } catch { /* ignore */ } }
      if (!isAlive(proc.pid)) result.killedPids.push(proc.pid);
    }
    await sleep(300);
    const leftovers = ownedNewProfiles(await module.snapshotProfileDirs());
    for (const dir of leftovers) {
      if (!dir.startsWith(tmpdir() + sep)) continue;
      try { await rm(dir, { recursive: true, force: true }); result.removedProfileDirs.push(dir); }
      catch (error) { result.errors.push(`rm ${dir}: ${errorMessage(error)}`); }
    }
    result.leftoverProfileDirs = ownedNewProfiles(await module.snapshotProfileDirs())
      .filter((dir) => !result.removedProfileDirs.includes(dir));
    result.leftoverChromePids = stray.filter((proc) => isAlive(proc.pid)).map((proc) => proc.pid);
    if (state.fixture) {
      try { await state.fixture.close(); result.fixtureClosed = true; } catch (error) { result.errors.push(`fixture close: ${errorMessage(error)}`); }
    }
    // The run directory is the deliverable evidence root: it is intentionally NOT removed.
  } catch (error) {
    result.errors.push(`cleanup failure: ${errorMessage(error)}`);
  }
  state.cleanupResult = result;
  log(`[cleanup] done: killed=${result.killedPids.length} removedProfiles=${result.removedProfileDirs.length} leftoverProfiles=${result.leftoverProfileDirs.length} leftoverPids=${result.leftoverChromePids.length} fixtureClosed=${result.fixtureClosed}`);
  return result;
}

/* ------------------------------------------------------------------------------------------------
 * Probes N1–N15
 * ---------------------------------------------------------------------------------------------- */

/** Shared run facts, filled by the probes in order. */
const facts = {
  sessionId: null,
  wsRequestId: null,
  addCart: null,
  checkout: null,
  dup: null,
  failCart: null,
  failOrder: null,
  slowOrder: null,
  screenshots: {},
};

function probeN1() {
  return async ({ harness, check }) => {
    const started = await call(harness, 'browser_network_session', {
      action: 'start', name: 't4-network',
      config: { captureBodies: true, captureWebSocket: true, captureSse: true, maxEvents: 20000, maxTotalBytes: 33554432 },
    });
    facts.sessionId = started.value?.session?.id ?? started.value?.sessionId ?? null;
    report.environment.sessionId = facts.sessionId;
    check('network session start 成功并返回 sessionId', started.ok && started.value?.ok === true && Boolean(facts.sessionId),
      { expected: 'ok:true + session.id', actual: { ok: started.value?.ok, sessionId: facts.sessionId, error: errorOf(started) } });

    await navigate(harness, PAGE_PATH);
    const truth = await waitTruth(harness, (value) => value.ready === true, { label: 'page boot (ready:true)' });

    const dom = await pageValue(harness, `(() => {
      const ids = ['t4n-title','t4n-subtitle','t4n-status','t4n-scenario','t4n-product-name','t4n-product-price',
        't4n-qty','t4n-qty-dec','t4n-qty-inc','t4n-add-cart','t4n-checkout','t4n-cancel-order','t4n-retry',
        't4n-reset','t4n-cart-count','t4n-cart-revision','t4n-cart-list','t4n-order-id','t4n-order-status',
        't4n-order-banner','t4n-error','t4n-ws-state','t4n-sse-state','t4n-poll-count'];
      const missing = ids.filter((id) => !document.getElementById(id));
      const error = document.getElementById('t4n-error');
      return {
        title: document.title,
        heading: document.getElementById('t4n-title').textContent.trim(),
        missing,
        errorHidden: error.hidden === true,
        errorText: error.textContent,
        retryHidden: document.getElementById('t4n-retry').hidden === true,
        productName: document.getElementById('t4n-product-name').textContent.trim(),
        productPrice: document.getElementById('t4n-product-price').textContent.trim(),
        cartCount: document.getElementById('t4n-cart-count').textContent.trim(),
        cartRevision: document.getElementById('t4n-cart-revision').textContent.trim(),
        orderStatus: document.getElementById('t4n-order-status').textContent.trim(),
        stage: document.body.getAttribute('data-t4n-stage'),
        scenarioAttr: document.body.getAttribute('data-t4n-scenario'),
        bodyHeight: document.documentElement.scrollHeight,
        innerHeight: window.innerHeight,
      };
    })()`);

    check('标题与标题节点为固定值', dom.title === TITLE && dom.heading === TITLE,
      { expected: { title: TITLE, heading: TITLE }, actual: { title: dom.title, heading: dom.heading } });
    check('契约要求的稳定 id 全部存在（24 个）', Array.isArray(dom.missing) && dom.missing.length === 0,
      { expected: { missing: [] }, actual: { missing: dom.missing } });
    check('商品与价格真值固定（T4 Widget / ¥ 42.00）',
      dom.productName === 'T4 Widget' && dom.productPrice === '¥ 42.00',
      { expected: { name: 'T4 Widget', price: '¥ 42.00' }, actual: { name: dom.productName, price: dom.productPrice } });
    check('真值 version===1 / fixture / runId / traceId 固定',
      truth.version === 1 && truth.fixture === 'web-t4-network' && truth.runId === RUN_ID && truth.traceId === TRACE_ID
        && truth.serverLedgerUrl === `/api/t4/ledger?runId=${RUN_ID}`,
      { expected: { version: 1, fixture: 'web-t4-network', runId: RUN_ID, traceId: TRACE_ID }, actual: { version: truth.version, fixture: truth.fixture, runId: truth.runId, traceId: truth.traceId, serverLedgerUrl: truth.serverLedgerUrl } });
    check('scenario=normal（body[data-t4n-scenario] 同步）',
      truth.scenario === 'normal' && dom.scenarioAttr === 'normal',
      { expected: { truth: 'normal', attr: 'normal' }, actual: { truth: truth.scenario, attr: dom.scenarioAttr } });
    const initialGet = (truth.responses || []).find((response) => {
      const request = (truth.requests || []).find((entry) => entry.requestId === response.requestId);
      return request && request.method === 'GET' && request.url === '/api/t4/cart';
    });
    const initialCart = initialGet && initialGet.body && initialGet.body.cart;
    check('初始 GET /api/t4/cart 的真值：cart count=0、revision=0',
      Boolean(initialCart) && initialCart.count === 0 && initialCart.revision === 0,
      { expected: { count: 0, revision: 0 }, actual: initialCart || null });
    check('错误横幅默认隐藏、重试默认隐藏、订单状态未创建',
      dom.errorHidden === true && dom.retryHidden === true && dom.orderStatus === '未创建',
      { expected: { errorHidden: true, retryHidden: true, orderStatus: '未创建' }, actual: { errorHidden: dom.errorHidden, retryHidden: dom.retryHidden, orderStatus: dom.orderStatus } });

    const events = await allEvents(harness);
    const httpEvents = events.filter((event) => event.kind === 'http');
    const foreign = httpEvents.filter((event) => !String(event.url || '').startsWith(FIXTURE_BASE));
    const wsForeign = events.filter((event) => event.kind === 'ws' && event.url && !String(event.url).startsWith('ws://127.0.0.1:') && !String(event.url).startsWith('ws://localhost:'));
    check('页面加载后所有 http 请求同源（无跨源请求）',
      httpEvents.length >= 1 && foreign.length === 0 && wsForeign.length === 0,
      { expected: { httpEvents: '>=1', foreign: 0 }, actual: { httpEvents: httpEvents.length, foreign: foreign.map((event) => event.url), wsForeign: wsForeign.map((event) => event.url) } });
  };
}

function probeN2() {
  return async ({ harness, check }) => {
    const cartEvent = await waitEvents(harness, (event) => urlHas('/api/t4/cart')(event) && event.phase === 'finished',
      { label: 'initial GET /api/t4/cart finished', filter: { urlIncludes: '/api/t4/cart' } });
    check('初始 GET /api/t4/cart 在采集会话中可见（status 200）',
      cartEvent.length >= 1 && cartEvent[0].status === 200 && cartEvent[0].method === 'GET',
      { expected: { method: 'GET', status: 200 }, actual: cartEvent.slice(0, 2).map((event) => ({ method: event.method, url: event.url, status: event.status, phase: event.phase })) });

    const created = await waitEvents(harness, (event) => event.kind === 'ws' && event.phase === 'ws-created',
      { label: 'ws-created', filter: { kind: 'ws' } });
    facts.wsRequestId = created[0].requestId;
    check('WS 握手可见（ws-created 事件带 /t4/ws 地址）',
      created.length >= 1 && String(created[0].url || '').includes('/t4/ws'),
      { expected: { urlIncludes: '/t4/ws' }, actual: created.slice(0, 2).map((event) => ({ url: event.url, phase: event.phase })) });

    const frames = await waitEvents(harness, (event) => event.kind === 'ws' && event.requestId === facts.wsRequestId && event.phase === 'ws-receive',
      { label: 'ws frame received', filter: { kind: 'ws' } });
    check('WS 帧事件可见（至少 1 条 ws-receive）', frames.length >= 1,
      { expected: { wsReceive: '>=1' }, actual: frames.slice(0, 3).map((event) => event.phase) });

    const detail = await detailOf(harness, { requestId: facts.wsRequestId, include: ['ws'] });
    const wsFrames = detail.ws?.frames || [];
    const hello = wsFrames.find((frame) => frame.direction === 'receive' && String(frame.payload ?? frame.payloadData ?? '').includes('"type":"hello"'));
    check('WS 详情可读：收到 hello 文本帧（方向 receive、文本可解析）',
      Boolean(hello) && String(hello.payload ?? hello.payloadData ?? '').length > 0,
      { expected: { direction: 'receive', type: 'hello' }, actual: wsFrames.map((frame) => ({ direction: frame.direction, opcode: frame.opcode, payload: String(frame.payload ?? frame.payloadData ?? '').slice(0, 60) })) });
  };
}

function probeN7() {
  return async ({ harness, check }) => {
    const truth = await waitWsPush(harness);
    const frame = truth.ws.frames.find((entry) => entry.direction === 'in' && entry.data && entry.data.type === 'cart-updated');
    check('WS 推送 cart-updated：frameId=ws-frame-1、cart count/revision 均 ≥1',
      frame.data.frameId === 'ws-frame-1' && frame.data.cart && frame.data.cart.count >= 1 && frame.data.cart.revision >= 1,
      { expected: { frameId: 'ws-frame-1', count: '>=1', revision: '>=1' }, actual: { frameId: frame.data.frameId, cart: frame.data.cart } });

    const wsTransition = (truth.ui || []).find((entry) => entry.key === 'cart.count' && entry.cause && entry.cause.kind === 'ws');
    check('UI 购物车徽标由 WS 更新（ui.cart.count.cause={kind:"ws",id:"ws-frame-1"}）',
      Boolean(wsTransition) && wsTransition.cause.id === 'ws-frame-1'
        && Number(wsTransition.to) === Number(frame.data.cart.count),
      { expected: { cause: { kind: 'ws', id: 'ws-frame-1' }, to: frame.data.cart.count }, actual: wsTransition || null });

    const domCount = await pageValue(harness, "document.getElementById('t4n-cart-count').textContent.trim()");
    check('DOM #t4n-cart-count 与 WS 真值一致', Number(domCount) === Number(truth.cart.count),
      { expected: truth.cart.count, actual: domCount });

    const detail = await detailOf(harness, { requestId: facts.wsRequestId, include: ['ws'] });
    const frames = detail.ws?.frames || [];
    const networkFrame = frames.find((entry) => entry.direction === 'receive' && String(entry.payload ?? entry.payloadData ?? '').includes('cart-updated'));
    check('网络事件侧的 WS 帧与页面真值一致（方向 receive、payload 含 cart-updated）',
      Boolean(networkFrame) && String(networkFrame.payload ?? networkFrame.payloadData ?? '').includes('"frameId":"ws-frame-1"'),
      { expected: { direction: 'receive', payloadIncludes: '"frameId":"ws-frame-1"' }, actual: frames.map((entry) => ({ direction: entry.direction, payload: String(entry.payload ?? entry.payloadData ?? '').slice(0, 80) })) });
  };
}

function probeN3() {
  return async ({ harness, check, finding }) => {
    // Baseline is taken AFTER the one-shot WS push AND after the page applied it: waiting only for
    // the received frame leaves a window where the click can be sequenced before the apply, which
    // made this criterion flaky (two observed runs: click-first and push-first). Requiring
    // cart.revision >= 1 plus the ws-caused ui transition closes that window deterministically.
    await waitWsPush(harness);
    const before = await waitTruth(harness, (truth) => Number(truth.cart && truth.cart.revision) >= 1
      && (truth.ui || []).some((entry) => entry.key === 'cart.count' && entry.cause && entry.cause.kind === 'ws'),
    { label: 'WS cart applied before baseline' });
    const watermark = await eventWatermark(harness);
    await click(harness, '#t4n-add-cart');
    // Waiting only for the op's requestIds is NOT enough: the op records the two requests as soon as
    // they are issued, while the cart truth (and the refresh GET's status) can still be in flight.
    // Observed failure mode: cart.revision stayed at the WS baseline and the refresh GET had status 0.
    // Wait for the observable end state instead: op requests + cart revision bump + refresh GET 200.
    const baselineRevision = Number((before.cart && before.cart.revision) || 0);
    const truth = await waitTruth(harness, (value) => {
      const opOk = (value.ops || []).some((op) => op.kind === 'click' && op.target === '#t4n-add-cart'
        && (op.requestIds || []).length >= 2);
      const cartOk = Number(value.cart && value.cart.revision) >= baselineRevision + 1;
      const getOk = (value.requests || []).some((entry) => entry.method === 'GET'
        && entry.url === '/api/t4/cart' && entry.status === 200 && entry.ok === true);
      return opOk && cartOk && getOk;
    }, { label: 'click applied: op(2 reqs) + cart revision bump + refresh GET 200' });
    const op = truth.ops.find((entry) => entry.kind === 'click' && entry.target === '#t4n-add-cart');
    const postRequest = truth.requests.find((entry) => entry.method === 'POST' && entry.url === '/api/t4/cart');
    const postIndex = truth.requests.indexOf(postRequest);
    // The refresh GET is the one AFTER the POST (the boot GET happens before it).
    const getRequest = truth.requests.slice(postIndex + 1).find((entry) => entry.method === 'GET' && entry.url === '/api/t4/cart');
    facts.addCart = { before, after: truth, op, postRequest, getRequest };

    check('点击加购产生 click op，requestIds 指向 POST + GET 两条请求',
      Boolean(op) && Boolean(postRequest) && Boolean(getRequest)
        && op.requestIds.includes(postRequest.requestId) && op.requestIds.includes(getRequest.requestId),
      { expected: { kind: 'click', target: '#t4n-add-cart', requestIds: 'POST+GET' }, actual: { kind: op?.kind, target: op?.target, requestIds: op?.requestIds } });
    check('POST /api/t4/cart 与随后的 GET /api/t4/cart 均为 200',
      Boolean(postRequest) && Boolean(getRequest)
        && postRequest.status === 200 && postRequest.ok === true && getRequest.status === 200 && getRequest.ok === true
        && postIndex < truth.requests.indexOf(getRequest),
      { expected: { post: 200, get: 200, order: 'POST before GET' }, actual: { post: postRequest && { status: postRequest.status, ok: postRequest.ok }, get: getRequest && { status: getRequest.status, ok: getRequest.ok } } });

    const postEvent = await waitEvents(harness, (event) => event.seq > watermark && urlHas('/api/t4/cart')(event) && event.method === 'POST' && event.phase === 'finished',
      { label: 'POST /api/t4/cart finished', filter: { urlIncludes: '/api/t4/cart' } });
    const getEvents = await waitEvents(harness, (event) => event.seq > watermark && urlHas('/api/t4/cart')(event) && event.method === 'GET' && event.phase === 'finished',
      { label: 'GET /api/t4/cart finished', filter: { urlIncludes: '/api/t4/cart' } });
    const getEvent = getEvents[getEvents.length - 1]; // the refresh GET, not the boot GET
    check('浏览器网络事件含 POST /api/t4/cart 与随后 GET /api/t4/cart（状态 200）',
      postEvent.length >= 1 && getEvents.length >= 1 && postEvent[0].status === 200 && getEvent.status === 200
        && getEvent.seq > postEvent[0].seq,
      { expected: { post: 200, get: 200, getAfterPost: true }, actual: { post: postEvent.slice(0, 2).map((event) => ({ seq: event.seq, status: event.status })), get: getEvents.map((event) => ({ seq: event.seq, status: event.status })) } });

    const postDetail = await detailOf(harness, { requestId: postEvent[0].requestId, include: ['correlation'] });
    const getDetail = await detailOf(harness, { requestId: getEvent.requestId, include: ['correlation'] });
    const traceIdOf = (detail) => (detail.correlation?.ids || []).find((entry) => String(entry.name || '').toLowerCase() === 'x-trace-id');
    const requestIdOf = (detail) => (detail.correlation?.ids || []).find((entry) => String(entry.name || '').toLowerCase() === 'x-request-id');
    const postTrace = traceIdOf(postDetail);
    const getTrace = traceIdOf(getDetail);
    const postRequestId = requestIdOf(postDetail);
    const getRequestId = requestIdOf(getDetail);
    check('x-trace-id / x-request-id 均被提取为 correlation id（值脱敏为 ***、有 valueHash）',
      Boolean(postTrace) && postTrace.value === '***' && typeof postTrace.valueHash === 'string' && postTrace.valueHash.length >= 8
        && Boolean(postRequestId) && postRequestId.value === '***' && typeof postRequestId.valueHash === 'string',
      { expected: { names: ['x-trace-id', 'x-request-id'], value: '***', valueHash: 'string' }, actual: postDetail.correlation?.ids || [] });
    check('POST 与 GET 的 x-trace-id valueHash 相同（同一 trace 组）',
      Boolean(postTrace?.valueHash) && postTrace.valueHash === getTrace?.valueHash,
      { expected: { sameValueHash: true }, actual: { post: postTrace?.valueHash, get: getTrace?.valueHash } });
    // P0 redacts correlation headers (CORRELATION_KEY) BEFORE hashing them, so `valueHash` is a
    // per-session constant for every correlation id — it groups but cannot distinguish ids. The raw
    // correlation values are therefore verified where they are authoritative: the page ledger and
    // the server ledger (which echoes the headers verbatim).
    const ledger = await fetchLedger(harness);
    const postLedger = (ledger.requests || []).find((entry) => entry.requestId === postRequest?.requestId);
    const getLedger = (ledger.requests || []).find((entry) => entry.requestId === getRequest?.requestId);
    check('关联值可从页面真值 + 服务端账本核对：traceId=t4-trace-1，requestId 各自唯一',
      postRequest?.traceId === TRACE_ID && getRequest?.traceId === TRACE_ID
        && postRequest?.requestId !== getRequest?.requestId
        && postLedger?.traceId === TRACE_ID && getLedger?.traceId === TRACE_ID
        && postLedger?.requestId === postRequest?.requestId && getLedger?.requestId === getRequest?.requestId,
      { expected: { traceId: TRACE_ID, uniqueRequestIds: true }, actual: {
        page: { post: { requestId: postRequest?.requestId, traceId: postRequest?.traceId }, get: { requestId: getRequest?.requestId, traceId: getRequest?.traceId } },
        ledger: { post: postLedger && { requestId: postLedger.requestId, traceId: postLedger.traceId }, get: getLedger && { requestId: getLedger.requestId, traceId: getLedger.traceId } },
      } });
    check('两条请求的 x-request-id 也各自被提取（值脱敏）',
      Boolean(getRequestId) && getRequestId.value === '***' && typeof getRequestId.valueHash === 'string',
      { expected: { name: 'x-request-id', value: '***' }, actual: getRequestId || null });
    finding({
      id: 'N3-correlation-hash-degenerate',
      severity: 'info',
      summary: 'P0 在入店前把关联头（x-request-id / x-trace-id 命中 CORRELATION_KEY）脱敏为 ***，之后才对脱敏值算 HMAC，因此 detail.correlation.ids[].valueHash 对每条关联头都是同一个会话常量：能表达“同组”，但不能区分 requestId 与 traceId。T4 六向关联所需的原值由靶机真值提供（requests[].requestId/traceId、ops[].requestIds、ui[].cause、ws/sse/polls），服务端账本原样回显请求头可交叉核对；本套件不读 P0 的脱敏原文，也不把 valueHash 当成 id。',
      evidence: { postTraceHash: postTrace?.valueHash, getTraceHash: getTrace?.valueHash, postRequestIdHash: postRequestId?.valueHash, getRequestIdHash: getRequestId?.valueHash },
    });
  };
}

function probeN4() {
  return async ({ harness, check }) => {
    const { before, after, postRequest, getRequest } = facts.addCart;
    const expectedCount = before.cart.count + 1;
    const expectedRevision = before.cart.revision + 1;
    check('购物车真值按增量变化（count=基线+1、revision=基线+1）',
      after.cart.count === expectedCount && after.cart.revision === expectedRevision,
      { expected: { count: expectedCount, revision: expectedRevision }, actual: after.cart });

    const dom = await pageValue(harness, `({
      count: document.getElementById('t4n-cart-count').textContent.trim(),
      revision: document.getElementById('t4n-cart-revision').textContent.trim(),
      list: document.getElementById('t4n-cart-list').textContent.trim()
    })`);
    check('DOM 徽标/版本/列表与真值一致',
      Number(dom.count) === after.cart.count && dom.revision === `revision ${after.cart.revision}` && dom.list.includes('sku-t4-main'),
      { expected: { count: after.cart.count, revision: `revision ${after.cart.revision}`, listIncludes: 'sku-t4-main' }, actual: dom });

    const transitions = (after.ui || []).filter((entry) => entry.key === 'cart.count');
    const last = transitions[transitions.length - 1];
    const opRequestIds = [postRequest?.requestId, getRequest?.requestId].filter(Boolean);
    check('ui.cart.count transition 的 cause 指向本次请求/响应',
      Boolean(last) && last.cause && (last.cause.kind === 'request' || last.cause.kind === 'response')
        && opRequestIds.includes(last.cause.id),
      { expected: { causeKind: 'request|response', causeId: 'one of the op requestIds' }, actual: last || null });

    const ledger = await fetchLedger(harness);
    const postEntry = (ledger.requests || []).find((entry) => entry.requestId === postRequest.requestId);
    check('服务端账本记录同一 requestId/traceId：200、deduped=false、method/path 正确',
      Boolean(postEntry) && postEntry.status === 200 && postEntry.deduped === false && postEntry.retried === false
        && postEntry.traceId === TRACE_ID && postEntry.method === 'POST' && postEntry.path === '/api/t4/cart',
      { expected: { status: 200, deduped: false, traceId: TRACE_ID, method: 'POST', path: '/api/t4/cart' }, actual: postEntry || null });

    const pageRequests = after.requests || [];
    const mismatched = pageRequests.filter((request) => {
      const entry = (ledger.requests || []).find((item) => item.requestId === request.requestId);
      return !entry || entry.status !== request.status;
    });
    check('浏览器真值与服务端账本请求数/状态一致（按 requestId 逐条核对）',
      pageRequests.length >= 2 && mismatched.length === 0,
      { expected: { pageRequests: '>=2', mismatched: 0 }, actual: { pageRequests: pageRequests.length, mismatched: mismatched.map((request) => request.requestId), ledgerRequests: (ledger.requests || []).length } });
  };
}

function probeN5() {
  return async ({ harness, check }) => {
    await setScenario(harness, 'dup');
    const before = await waitWsPush(harness);
    const result = await pageValue(harness, 'window.__t4.net.addToCart({ qty: 1, double: true })');
    check('addToCart({double:true}) 返回成功', result && result.ok === true, { expected: { ok: true }, actual: result });
    const truth = await waitTruth(harness, (value) => (value.requests || []).filter((request) => request.method === 'POST' && request.url === '/api/t4/cart').length >= 2,
      { label: 'two POST /api/t4/cart requests' });
    const posts = truth.requests.filter((request) => request.method === 'POST' && request.url === '/api/t4/cart');
    facts.dup = { before, after: truth, posts };

    check('浏览器看到 2 个 POST /api/t4/cart，且 idempotencyKey 相同',
      posts.length === 2 && posts[0].idempotencyKey === posts[1].idempotencyKey && Boolean(posts[0].idempotencyKey),
      { expected: { posts: 2, sameKey: true }, actual: posts.map((request) => ({ requestId: request.requestId, key: request.idempotencyKey, status: request.status, duplicate: request.duplicate })) });
    check('第二条请求 duplicate/deduped=true，第一条为 false',
      posts[0].duplicate === false && posts[1].duplicate === true,
      { expected: [false, true], actual: posts.map((request) => request.duplicate) });

    const ledger = await fetchLedger(harness);
    const ledgerPosts = (ledger.requests || []).filter((entry) => entry.method === 'POST' && entry.path === '/api/t4/cart');
    check('服务端账本有两条 POST /api/t4/cart（同 key，第二条 deduped=true）',
      ledgerPosts.length === 2 && ledgerPosts[0].idempotencyKey === ledgerPosts[1].idempotencyKey
        && ledgerPosts[0].deduped === false && ledgerPosts[1].deduped === true,
      { expected: { posts: 2, deduped: [false, true] }, actual: ledgerPosts });
    check('幂等：服务端购物车只 +1（count=基线+1、revision=基线+1）',
      ledger.state.cart.count === before.cart.count + 1 && ledger.state.cart.revision === before.cart.revision + 1,
      { expected: { count: before.cart.count + 1, revision: before.cart.revision + 1 }, actual: ledger.state.cart });

    const transitions = (truth.ui || []).filter((entry) => entry.key === 'cart.count');
    const beforeCount = (before.ui || []).filter((entry) => entry.key === 'cart.count').length;
    check('UI 只发生一次 cart.count 变化（重复请求不重复加购）',
      transitions.length - beforeCount === 1,
      { expected: { newTransitions: 1 }, actual: { before: beforeCount, after: transitions.length, transitions: transitions.slice(-2) } });

    const domCount = await pageValue(harness, "document.getElementById('t4n-cart-count').textContent.trim()");
    check('DOM 徽标等于服务端真值', Number(domCount) === ledger.state.cart.count,
      { expected: ledger.state.cart.count, actual: domCount });
  };
}

function probeN6() {
  return async ({ harness, check, finding }) => {
    await setScenario(harness, 'normal');
    const before = await waitWsPush(harness);
    const watermark = await eventWatermark(harness);
    await click(harness, '#t4n-checkout');
    const truth = await waitTruth(harness, (value) => value.order.orderId === ORDER_ID
      && (value.sse.events || []).filter((event) => event.type === 'order').length >= 2
      && (value.polls || []).length >= 3
      && ['paid', 'fulfilled'].includes(value.order.status),
    { label: 'checkout + SSE + 3 polls', timeoutMs: 25000 });
    facts.checkout = { before, after: truth };

    const postEvent = await waitEvents(harness, (event) => event.seq > watermark && urlHas('/api/t4/orders')(event) && event.method === 'POST' && event.phase === 'finished',
      { label: 'POST /api/t4/orders finished', filter: { urlIncludes: '/api/t4/orders' } });
    check('POST /api/t4/orders 200 且 orderId=ORD-T4-1',
      postEvent.length >= 1 && postEvent[0].status === 200 && truth.order.orderId === ORDER_ID,
      { expected: { status: 200, orderId: ORDER_ID }, actual: { status: postEvent[0]?.status, orderId: truth.order.orderId } });

    const sseEvents = (truth.sse.events || []).filter((event) => event.type === 'order');
    const statuses = sseEvents.map((event) => event.data && event.data.status);
    check('SSE 收到 pending→paid→fulfilled（至少 2 条，顺序单调）',
      sseEvents.length >= 2 && statuses[0] === 'pending' && statuses.includes('paid')
        && statuses.indexOf('paid') > 0 && (statuses.includes('fulfilled') ? statuses.indexOf('fulfilled') > statuses.indexOf('paid') : true),
      { expected: ['pending', 'paid', 'fulfilled'], actual: statuses });

    const sseClosed = await waitTruth(harness, (value) => value.sse.state === 'closed', { label: 'SSE closed after +600ms', timeoutMs: 8000 }).catch(() => null);
    check('SSE 在 +600ms 后关闭（sse.state=closed）', Boolean(sseClosed) && sseClosed.sse.state === 'closed',
      { expected: 'closed', actual: (sseClosed || truth).sse.state });

    const pollEvents = await waitEvents(harness, (event) => urlHas(`/api/t4/orders/${ORDER_ID}`)(event) && event.method === 'GET' && event.phase === 'request',
      { count: 3, label: '3 order polls', filter: { urlIncludes: `/api/t4/orders/${ORDER_ID}` } });
    check('3 次轮询 GET /api/t4/orders/ORD-T4-1 可见',
      pollEvents.length >= 3 && (truth.polls || []).length === 3,
      { expected: { events: 3, polls: 3 }, actual: { events: pollEvents.length, polls: truth.polls.map((poll) => poll.requestId) } });

    const domStatus = await pageValue(harness, "document.getElementById('t4n-order-status').textContent.trim()");
    check('UI 订单状态最终为 已支付/已完成', domStatus === '已支付' || domStatus === '已完成',
      { expected: ['已支付', '已完成'], actual: domStatus });
    const orderTransitions = (truth.ui || []).filter((entry) => entry.key === 'order.status');
    const lastTransition = orderTransitions[orderTransitions.length - 1];
    check('最终订单状态 transition 的 cause 指向 SSE/轮询',
      Boolean(lastTransition) && lastTransition.cause && ['sse', 'poll'].includes(lastTransition.cause.kind),
      { expected: { causeKind: 'sse|poll' }, actual: lastTransition || null });

    facts.screenshots.orderComplete = await capture(harness, 'order-complete');
    finding({
      id: 'N6-order-status-source',
      summary: `订单最终状态 ${truth.order.status}；SSE 状态序列 ${statuses.join('→')}，轮询 ${truth.polls.length} 次。GET 与 SSE 共享服务端定时器（+200ms paid / +400ms fulfilled），先到者更新 UI，重复值不产生 transition。`,
      evidence: { order: truth.order, statuses, polls: truth.polls.length },
    });
  };
}

function probeN8() {
  return async ({ harness, check }) => {
    await setScenario(harness, 'fail-cart');
    const before = await waitWsPush(harness);
    const watermark = await eventWatermark(harness);
    await click(harness, '#t4n-add-cart');
    const truth = await waitTruth(harness, (value) => (value.errors || []).length >= 1
      && (value.requests || []).some((request) => request.method === 'POST' && request.url === '/api/t4/cart' && request.status === 500),
    { label: 'fail-cart 500 + error banner' });
    const failedRequest = truth.requests.find((request) => request.method === 'POST' && request.url === '/api/t4/cart' && request.status === 500);
    facts.failCart = { before, after: truth, failedRequest };

    const event = await waitEvents(harness, (candidate) => candidate.seq > watermark && urlHas('/api/t4/cart')(candidate)
      && candidate.method === 'POST' && candidate.phase === 'finished' && candidate.status === 500,
    { label: 'POST /api/t4/cart 500 finished', filter: { urlIncludes: '/api/t4/cart' } });
    check('捕获 500 POST /api/t4/cart（浏览器事件与页面真值一致）',
      event.length >= 1 && event[0].status === 500 && failedRequest.status === 500,
      { expected: { status: 500 }, actual: { eventStatus: event[0]?.status, truthStatus: failedRequest.status } });

    const dom = await pageValue(harness, `(() => {
      const error = document.getElementById('t4n-error');
      const style = getComputedStyle(error);
      return { hidden: error.hidden, text: error.textContent, visibility: style.visibility, display: style.display,
               retryHidden: document.getElementById('t4n-retry').hidden };
    })()`);
    check('#t4n-error 可见且文本含业务错误码 CART_REJECTED',
      dom.hidden === false && dom.visibility === 'visible' && dom.display !== 'none' && dom.text.includes('CART_REJECTED'),
      { expected: { hidden: false, visibility: 'visible', textIncludes: 'CART_REJECTED' }, actual: dom });
    check('ui.error transition 的 cause 指向失败请求的 requestId',
      (truth.ui || []).some((entry) => entry.key === 'error' && entry.cause && entry.cause.id === failedRequest.requestId),
      { expected: { cause: { kind: 'request', id: failedRequest.requestId } }, actual: (truth.ui || []).filter((entry) => entry.key === 'error') });
    check('errors[] 记录 {code:CART_REJECTED, requestId}',
      (truth.errors || []).some((error) => error.code === 'CART_REJECTED' && error.requestId === failedRequest.requestId),
      { expected: { code: 'CART_REJECTED', requestId: failedRequest.requestId }, actual: truth.errors });
    check('购物车未被修改（count 与基线一致）', truth.cart.count === before.cart.count,
      { expected: before.cart.count, actual: truth.cart.count });
    check('#t4n-retry 保持隐藏（只有订单错误才显示重试）', dom.retryHidden === true,
      { expected: true, actual: dom.retryHidden });

    facts.screenshots.error = await capture(harness, 'error-state');
  };
}

function probeN9() {
  return async ({ harness, check }) => {
    await setScenario(harness, 'fail-order');
    await waitWsPush(harness);
    await click(harness, '#t4n-checkout');
    const failed = await waitTruth(harness, (value) => (value.errors || []).length >= 1
      && value.order.orderId === null
      && (value.requests || []).some((request) => request.method === 'POST' && request.url === '/api/t4/orders' && request.status === 500),
    { label: 'fail-order first attempt rejected' });
    const firstRequest = failed.requests.find((request) => request.method === 'POST' && request.url === '/api/t4/orders');
    const firstError = (failed.errors || [])[0];

    const domBefore = await pageValue(harness, `(() => {
      const error = document.getElementById('t4n-error');
      return { hidden: error.hidden, text: error.textContent, retryHidden: document.getElementById('t4n-retry').hidden };
    })()`);
    check('第一次结算 500 ORDER_REJECTED，错误横幅可见且含错误码',
      firstRequest.status === 500 && firstError.code === 'ORDER_REJECTED' && domBefore.hidden === false && domBefore.text.includes('ORDER_REJECTED'),
      { expected: { status: 500, code: 'ORDER_REJECTED', banner: 'visible' }, actual: { status: firstRequest.status, error: firstError, banner: domBefore } });
    check('#t4n-retry 在订单错误后可见', domBefore.retryHidden === false, { expected: false, actual: domBefore.retryHidden });

    const watermark = await eventWatermark(harness);
    await click(harness, '#t4n-retry');
    const retried = await waitTruth(harness, (value) => value.order.orderId === ORDER_ID
      && (value.requests || []).filter((request) => request.method === 'POST' && request.url === '/api/t4/orders').length >= 2,
    { label: 'retry creates the order' });
    const posts = retried.requests.filter((request) => request.method === 'POST' && request.url === '/api/t4/orders');
    const retryRequest = posts[posts.length - 1];
    check('重试使用同一 idempotencyKey（与失败请求共享 traceId/key）',
      retryRequest.idempotencyKey === firstRequest.idempotencyKey && retryRequest.traceId === firstRequest.traceId
        && retryRequest.idempotencyKey === 't4-idem-order-1',
      { expected: { sameKey: true, key: 't4-idem-order-1', sameTrace: true }, actual: { first: { key: firstRequest.idempotencyKey, trace: firstRequest.traceId }, retry: { key: retryRequest.idempotencyKey, trace: retryRequest.traceId } } });
    check('第二次 POST /api/t4/orders 成功且 retried=true',
      retryRequest.status === 200 && retryRequest.retried === true && retryRequest.ok === true,
      { expected: { status: 200, retried: true }, actual: { status: retryRequest.status, retried: retryRequest.retried, ok: retryRequest.ok } });

    const retryEvent = await waitEvents(harness, (candidate) => candidate.seq > watermark
      && urlHas('/api/t4/orders')(candidate) && candidate.method === 'POST' && candidate.phase === 'finished',
    { label: 'retry POST /api/t4/orders finished', filter: { urlIncludes: '/api/t4/orders' } });
    check('浏览器网络事件确认第二次 POST /api/t4/orders 为 200',
      retryEvent.length >= 1 && retryEvent[retryEvent.length - 1].status === 200,
      { expected: 200, actual: retryEvent.map((candidate) => ({ seq: candidate.seq, status: candidate.status })) });

    const ledger = await fetchLedger(harness);
    const ledgerOrders = (ledger.requests || []).filter((entry) => entry.method === 'POST' && entry.path === '/api/t4/orders');
    check('服务端账本：两条 orders POST 同 key，第二条 retried=true',
      ledgerOrders.length === 2 && ledgerOrders[0].status === 500 && ledgerOrders[1].status === 200
        && ledgerOrders[0].idempotencyKey === ledgerOrders[1].idempotencyKey && ledgerOrders[1].retried === true,
      { expected: { posts: 2, statuses: [500, 200], retried: true }, actual: ledgerOrders });

    const domAfter = await pageValue(harness, `(() => {
      const error = document.getElementById('t4n-error');
      return { hidden: error.hidden, text: error.textContent,
               retryHidden: document.getElementById('t4n-retry').hidden,
               status: document.getElementById('t4n-order-status').textContent.trim(),
               orderId: document.getElementById('t4n-order-id').textContent.trim() };
    })()`);
    check('重试成功后错误横幅隐藏、重试按钮隐藏、订单进入待支付/已支付',
      domAfter.hidden === true && domAfter.text === '' && domAfter.retryHidden === true
        && domAfter.orderId === ORDER_ID && ['待支付', '已支付', '已完成'].includes(domAfter.status),
      { expected: { errorHidden: true, retryHidden: true, orderId: ORDER_ID, status: ['待支付', '已支付', '已完成'] }, actual: domAfter });
  };
}

function probeN10() {
  return async ({ harness, check }) => {
    await setScenario(harness, 'slow-order');
    await waitWsPush(harness);
    const before = await truthOf(harness);
    const watermark = await eventWatermark(harness);
    await click(harness, '#t4n-checkout');
    const finished = await waitEvents(harness, (event) => event.seq > watermark && urlHas('/api/t4/orders')(event) && event.method === 'POST' && event.phase === 'finished',
      { label: 'slow POST /api/t4/orders finished', filter: { urlIncludes: '/api/t4/orders' } });
    const slow = finished[finished.length - 1];
    facts.slowOrder = { before, event: slow };
    check('slow-order 的 POST /api/t4/orders 耗时 ≥700ms（服务端固定 800ms，容差 100ms）',
      Number.isFinite(slow.durationMs) && slow.durationMs >= 700,
      { expected: { durationMs: '>=700' }, actual: { durationMs: slow.durationMs, status: slow.status } });
    check('慢请求最终成功（status 200，不是失败）', slow.status === 200,
      { expected: 200, actual: slow.status });

    const truth = await waitTruth(harness, (value) => value.order.orderId === ORDER_ID,
      { label: 'slow order created' });
    const domStatus = await pageValue(harness, "document.getElementById('t4n-order-status').textContent.trim()");
    check('慢请求结束后 UI 订单状态更新（非未创建）', truth.order.orderId === ORDER_ID && domStatus !== '未创建',
      { expected: { orderId: ORDER_ID, status: '!=未创建' }, actual: { orderId: truth.order.orderId, status: domStatus } });
  };
}

function probeN11() {
  return async ({ harness, check }) => {
    const begin = await trace(harness, {
      action: 'begin-step', name: 't4-checkout-window', stepId: 't4-checkout-window',
      businessStatusPath: 'code',
      objectRules: [{ from: 'json-body', key: 'orderId', path: 'order.orderId', name: 'orderId', propagate: true }],
    });
    const stepId = stepOfValue(begin)?.stepId || 't4-checkout-window';
    check('trace.begin-step 返回 stepId', Boolean(stepId) && stepId === 't4-checkout-window',
      { expected: { stepId: 't4-checkout-window' }, actual: stepOfValue(begin) || begin });

    // Reconnect channels INSIDE the step window so WS/SSE events are attributed to it, then drive
    // the checkout flow through the real UI.
    await setScenario(harness, 'normal');
    await waitWsPush(harness);
    const watermark = await eventWatermark(harness);
    await click(harness, '#t4n-checkout');
    await waitTruth(harness, (value) => (value.polls || []).length >= 3
      && (value.sse.events || []).filter((event) => event.type === 'order').length >= 2,
    { label: 'checkout chain inside the step window', timeoutMs: 25000 });
    const end = await trace(harness, {
      action: 'end-step', stepId,
      objectRules: [{ from: 'json-body', key: 'orderId', path: 'order.orderId', name: 'orderId', propagate: true }],
    });
    const closed = stepOfValue(end) || {};
    check('trace.end-step 关窗并返回 fromSeq/toSeq', Number.isInteger(closed.fromSeq) && Number.isInteger(closed.toSeq),
      { expected: { fromSeq: 'int', toSeq: 'int' }, actual: { fromSeq: closed.fromSeq, toSeq: closed.toSeq } });

    const query = await trace(harness, { action: 'query', limit: 200 });
    const steps = query.steps || [];
    const step = steps.find((entry) => entry.stepId === stepId || entry.id === stepId) || steps[steps.length - 1];
    const counters = step?.counters || {};
    check('步骤 counters 包含 http / ws / sse（各 ≥1，http ≥3）',
      Number(counters.http) >= 3 && Number(counters.ws) >= 1 && Number(counters.sse) >= 1,
      { expected: { http: '>=3', ws: '>=1', sse: '>=1' }, actual: counters });

    const ordersEvent = (await waitEvents(harness, (event) => event.seq > watermark && urlHas('/api/t4/orders')(event) && event.method === 'POST' && event.phase === 'finished',
      { label: 'orders POST for correlation', filter: { urlIncludes: '/api/t4/orders' } })).slice(-1)[0];
    const detail = await detailOf(harness, { requestId: ordersEvent.requestId, include: ['correlation'] });
    const sameGroup = typeof detail.correlation?.sameGroup === 'number' ? detail.correlation.sameGroup : (detail.correlation?.sameGroup?.count ?? 0);
    check('correlation 同一 trace 组计数 ≥3（x-trace-id 同组）', Number(sameGroup) >= 3,
      { expected: { sameGroup: '>=3' }, actual: { sameGroup, ids: detail.correlation?.ids } });

    const causality = (query.causality || []).concat(...steps.map((entry) => entry.causality || []));
    const bases = [...new Set(causality.map((entry) => entry.basis))];
    check('causality 只出现 explicit/redirect/initiator（temporal 默认不返回）',
      bases.every((basis) => ['explicit', 'redirect', 'initiator'].includes(basis)),
      { expected: ['explicit', 'redirect', 'initiator'], actual: bases });
    const temporal = await trace(harness, { action: 'query', limit: 200, includeTemporal: true });
    const temporalBases = [...new Set((temporal.causality || []).concat(...(temporal.steps || []).map((entry) => entry.causality || [])).map((entry) => entry.basis))];
    check('显式 includeTemporal:true 时 temporal 才可能出现（默认查询里没有）',
      !bases.includes('temporal') && temporalBases.every((basis) => ['explicit', 'redirect', 'initiator', 'temporal'].includes(basis)),
      { expected: { default: 'no temporal', explicit: 'subset of the four bases' }, actual: { default: bases, explicit: temporalBases } });

    const objects = step?.objects || [];
    const orderObject = objects.find((object) => object.name === 'orderId' || object.key === 'orderId');
    check('业务对象提取：orderId=ORD-T4-1（显式 objectRules）',
      String(orderObject?.value ?? '') === ORDER_ID,
      { expected: { orderId: ORDER_ID }, actual: objects });
  };
}

function probeN12() {
  return async ({ harness, check }) => {
    const truth = await truthOf(harness);
    const ledger = await fetchLedger(harness);
    const entries = ledger.requests || [];
    check('账本 requests 非空且逐条带 method/path/status/traceId/requestId/idempotencyKey',
      entries.length >= 2 && entries.every((entry) => typeof entry.method === 'string' && typeof entry.path === 'string'
        && Number.isInteger(entry.status) && entry.traceId === TRACE_ID
        && typeof entry.requestId === 'string' && typeof entry.idempotencyKey === 'string'),
      { expected: { requests: '>=2', traceId: TRACE_ID }, actual: entries.slice(0, 3) });
    const seqs = entries.map((entry) => entry.seq);
    check('服务端 seq 单调递增（1..n，无重复）',
      seqs.every((seq, index) => index === 0 || seq > seqs[index - 1]) && seqs[0] === 1,
      { expected: 'strictly increasing from 1', actual: seqs.slice(0, 12) });

    const ordersPost = (truth.requests || []).filter((request) => request.method === 'POST' && request.url === '/api/t4/orders').slice(-1)[0];
    const ledgerOrders = entries.filter((entry) => entry.method === 'POST' && entry.path === '/api/t4/orders');
    const lastLedgerOrder = ledgerOrders[ledgerOrders.length - 1];
    check('账本与浏览器真值一致：最近一条 orders POST 的 requestId/status/idempotencyKey 相同',
      Boolean(ordersPost) && Boolean(lastLedgerOrder)
        && lastLedgerOrder.requestId === ordersPost.requestId && lastLedgerOrder.status === ordersPost.status
        && lastLedgerOrder.idempotencyKey === ordersPost.idempotencyKey,
      { expected: { requestId: ordersPost?.requestId, status: ordersPost?.status, key: ordersPost?.idempotencyKey }, actual: lastLedgerOrder || null });

    const pollRequests = (truth.requests || []).filter((request) => request.method === 'GET' && request.url === `/api/t4/orders/${ORDER_ID}`);
    const ledgerPolls = entries.filter((entry) => entry.method === 'GET' && entry.path === `/api/t4/orders/${ORDER_ID}`);
    check('轮询请求在账本中同数（GET /api/t4/orders/ORD-T4-1）',
      pollRequests.length >= 3 && ledgerPolls.length === pollRequests.length,
      { expected: { polls: '>=3', ledgerEqualsPage: true }, actual: { page: pollRequests.length, ledger: ledgerPolls.length } });

    check('账本 state 与页面真值一致（cart count/revision、order id/status）',
      ledger.state.cart.count === truth.cart.count && ledger.state.cart.revision === truth.cart.revision
        && ledger.state.order && truth.order && ledger.state.order.orderId === truth.order.orderId
        && ledger.state.order.status === truth.order.status,
      { expected: { cart: truth.cart, order: truth.order }, actual: ledger.state });
  };
}

function probeN13() {
  return async ({ harness, check }) => {
    const httpReset = await postReset(harness);
    const resetValue = await pageValue(harness, 'window.__t4.net.reset()');
    check('POST /api/t4/reset 与 __t4.net.reset() 均成功',
      httpReset.status === 200 && resetValue && resetValue.ok === true,
      { expected: { httpStatus: 200, methodOk: true }, actual: { httpStatus: httpReset.status, methodOk: resetValue?.ok } });

    const truth = await truthOf(harness);
    check('页面账本清空（ops/requests/responses/ui/polls/errors 全空、cart 归零、订单清空）',
      truth.ops.length === 0 && truth.requests.length === 0 && truth.responses.length === 0
        && truth.ui.length === 0 && truth.polls.length === 0 && truth.errors.length === 0
        && truth.cart.count === 0 && truth.cart.revision === 0 && truth.order.orderId === null,
      { expected: { ops: 0, requests: 0, ui: 0, cart: { count: 0, revision: 0 }, orderId: null }, actual: { ops: truth.ops.length, requests: truth.requests.length, ui: truth.ui.length, cart: truth.cart, order: truth.order } });

    const ledger = await fetchLedger(harness);
    check('服务端状态清空（requests=[]、cart 0、order null）',
      (ledger.requests || []).length === 0 && ledger.state.cart.count === 0
        && ledger.state.cart.revision === 0 && ledger.state.order === null,
      { expected: { requests: 0, cart: { count: 0, revision: 0 }, order: null }, actual: { requests: (ledger.requests || []).length, state: ledger.state } });

    const added = await pageValue(harness, 'window.__t4.net.addToCart({ qty: 1 })');
    check('重置后再次加购成功', added && added.ok === true, { expected: { ok: true }, actual: added });
    const after = await truthOf(harness);
    check('重置后加购从 revision 1 开始（count=1、revision=1）',
      after.cart.count === 1 && after.cart.revision === 1,
      { expected: { count: 1, revision: 1 }, actual: after.cart });
    const ledgerAfter = await fetchLedger(harness);
    check('重置后服务端账本重新从 seq 1 记账（2 条：POST + GET）',
      (ledgerAfter.requests || []).length === 2 && ledgerAfter.requests[0].seq === 1
        && ledgerAfter.requests[0].method === 'POST' && ledgerAfter.requests[1].method === 'GET',
      { expected: { requests: 2, first: 'POST seq 1' }, actual: (ledgerAfter.requests || []).map((entry) => ({ seq: entry.seq, method: entry.method, path: entry.path })) });
  };
}

function probeN14() {
  return async ({ harness, check }) => {
    const layout = await pageValue(harness, `({
      scrollHeight: document.documentElement.scrollHeight,
      innerHeight: window.innerHeight,
      innerWidth: window.innerWidth
    })`);
    check('页面在默认视口内完整可见（截图即整页，无滚动）',
      layout.scrollHeight <= layout.innerHeight && layout.innerWidth === 1280,
      { expected: { scrollHeight: '<=innerHeight', innerWidth: 1280 }, actual: layout });

    for (const label of ['error', 'orderComplete']) {
      const shot = facts.screenshots[label];
      check(`截图 ${label} 已产生并落在 run 目录（相对路径 .png）`,
        Boolean(shot) && typeof shot.file?.path === 'string' && shot.file.path.endsWith('.png')
          && !shot.file.path.startsWith('/') && shot.diskPath.startsWith(EVIDENCE_DIR + sep),
        { expected: { path: 'output/capture/*.png', underRunDir: true }, actual: shot?.file || null });
      let bytes = null;
      try { bytes = shot?.diskPath ? readFileSync(shot.diskPath) : null; } catch { bytes = null; }
      const digest = bytes ? sha256(bytes) : null;
      let mode = null;
      try { mode = statSync(shot.diskPath).mode & 0o777; } catch { mode = null; }
      check(`截图 ${label} 文件存在、0600、sha256 与返回证据一致`,
        Boolean(bytes) && digest === shot.file?.sha256 && mode === 0o600,
        { expected: { sha256: shot?.file?.sha256, mode: 0o600 }, actual: { bytes: bytes?.length ?? null, sha256: digest, mode } });
      check(`截图 ${label} 尺寸为 1280×800 且 sha256(base64) 与 file.sha256 一致`,
        shot?.width === 1280 && shot?.height === 800 && shot?.imageSha256 === shot?.file?.sha256,
        { expected: { width: 1280, height: 800, sha256: shot?.file?.sha256 }, actual: { width: shot?.width, height: shot?.height, imageSha256: shot?.imageSha256 } });
    }
  };
}

function probeN15() {
  return async ({ harness, check }) => {
    const module = await harnessModule();
    const expected = module.EXPECTED_TOOLS || [];
    const names = harness.toolNames();
    check(`工具面与冻结的 harness 表一致（${names.length}/${expected.length}）`,
      names.length === expected.length && expected.every((tool) => names.includes(tool.name)),
      { expected: { count: expected.length }, actual: { count: names.length, missing: expected.filter((tool) => !names.includes(tool.name)).map((tool) => tool.name) } });
    const t4Tools = (module.T4_TOOLS || []).map((tool) => tool.name);
    check('T4 五工具真实注册（不是草案名）',
      t4Tools.length === 5 && t4Tools.every((name) => names.includes(name)),
      { expected: t4Tools, actual: names.filter((name) => t4Tools.includes(name)) });

    const caps = await call(harness, 'browser_capabilities', {});
    const capabilities = caps.value?.capabilities || [];
    const t4 = capabilities.filter((item) => String(item.id || '').toLowerCase().includes('t4'));
    check('capabilities 的 T4 条目状态与真实注册一致（5 工具 + 聚合 + 旧别名，均非 unsupported）',
      t4.length >= 7 && t4.every((item) => item.status === 'available')
        && t4Tools.every((tool) => t4.some((item) => item.tool === tool)),
      { expected: { entries: '5 tool + aggregate + alias, all available' }, actual: t4.map((item) => `${item.id}:${item.status}`) });
    const toolEntries = capabilities.filter((item) => item.tool);
    check(`capabilities 可追溯：${expected.length} 个工具条目`,
      toolEntries.length === expected.length,
      { expected: expected.length, actual: toolEntries.length });
    const networkTools = ['browser_network_session', 'browser_network_events', 'browser_network_detail',
      'browser_network_trace', 'browser_network_control', 'browser_network_evidence', 'browser_network_subscribe'];
    check('7 个网络 P0 工具仍 available（本套件只驱动已注册网络工具）',
      networkTools.every((tool) => capabilities.some((item) => item.tool === tool && item.status === 'available')),
      { expected: networkTools, actual: capabilities.filter((item) => networkTools.includes(item.tool)).map((item) => ({ tool: item.tool, status: item.status })) });
    const stale = capabilities.filter((item) => /T4/i.test(String(item.reason || '')) && /unsupported|not implemented/i.test(String(item.reason || '')));
    check('没有残留的 T4 stale unsupported/not-implemented 声明', stale.length === 0,
      { expected: [], actual: stale.map((item) => `${item.id}:${item.reason}`) });
  };
}

/* ------------------------------------------------------------------------------------------------
 * Report / evidence writing
 * ---------------------------------------------------------------------------------------------- */

const B_PROBES = [
  { id: 'N1-page-load', criteria: ['N1'], title: '页面加载与冻结真值', expected: '标题/24 个稳定 id/version/runId/traceId/初始 cart 0/无跨源请求', body: probeN1 },
  { id: 'N2-network-capture', criteria: ['N2'], title: '网络采集：初始 GET 与 WS 握手/帧', expected: '初始 GET /api/t4/cart 200 + ws-created/ws-receive 可见', body: probeN2 },
  { id: 'N7-ws-to-ui', criteria: ['N7'], title: 'WS → 视觉', expected: 'cart-updated 推高徽标、ui.cause{ws}、真值与网络帧一致', body: probeN7 },
  { id: 'N3-click-to-network', criteria: ['N3'], title: '点击加购 → 网络', expected: 'click op + POST/GET /api/t4/cart 200 + trace 关联', body: probeN3 },
  { id: 'N4-network-to-ui-ledger', criteria: ['N4'], title: '网络 → 视觉 + 服务端真值', expected: 'cart 增量、ui cause、ledger 同 requestId/traceId', body: probeN4 },
  { id: 'N5-duplicate', criteria: ['N5'], title: '重复发送（dup 场景）', expected: '2×POST 同 key、第二条 deduped、cart 只 +1、UI 一次变化', body: probeN5 },
  { id: 'N6-checkout-chain', criteria: ['N6'], title: '结算链路（SSE + 轮询）', expected: 'orders 200、SSE pending/paid/fulfilled、3 polls、UI 已支付/已完成', body: probeN6 },
  { id: 'N8-error-propagation', criteria: ['N8'], title: '错误传导（fail-cart）', expected: '500 CART_REJECTED、横幅可见、ui.error.cause=requestId', body: probeN8 },
  { id: 'N9-retry', criteria: ['N9'], title: '重试（fail-order）', expected: '500 ORDER_REJECTED → 同 key 重试 retried:true 成功', body: probeN9 },
  { id: 'N10-slow-request', criteria: ['N10'], title: '慢请求（slow-order）', expected: 'duration ≥700ms、最终 UI 更新', body: probeN10 },
  { id: 'N11-trace-step', criteria: ['N11'], title: 'Trace 步骤与关联', expected: '步骤 counters 含 http/ws/sse、correlation ≥3、无 temporal', body: probeN11 },
  { id: 'N12-server-ledger', criteria: ['N12'], title: '服务端账本核对', expected: 'method/path/status/traceId/key 一致、seq 单调', body: probeN12 },
  { id: 'N13-reset', criteria: ['N13'], title: '重置', expected: 'server + 页面账本清空、再次加购 revision 1', body: probeN13 },
  { id: 'N14-screenshots', criteria: ['N14'], title: '截图证据', expected: '错误态/订单完成态整页 PNG、sha256/尺寸/路径', body: probeN14 },
  { id: 'N15-boundaries', criteria: ['N15'], title: '不越界', expected: '工具面 35 与 harness 表一致、T4 五工具注册、无 stale 声明', body: probeN15 },
];

function buildCriteriaReport() {
  return CRITERIA.map(([id, title]) => {
    const checks = criterionChecks.get(id) || [];
    const required = checks.filter((item) => item.required);
    const failed = required.filter((item) => !item.pass);
    let status;
    if (checks.length === 0) status = 'not-run';
    else if (failed.length > 0) status = 'fail';
    else status = 'pass';
    return {
      id, title, status,
      requiredChecks: required.length,
      failedChecks: failed.length,
      checks,
    };
  });
}

async function writeEvidence() {
  await mkdir(EVIDENCE_DIR, { recursive: true });
  report.criteria = buildCriteriaReport();
  const failedChecks = report.criteria.flatMap((criterion) => criterion.checks
    .filter((item) => item.required && !item.pass)
    .map((item) => ({ criterion: criterion.id, label: item.label, detail: item.detail })));
  const covered = report.criteria.filter((criterion) => criterion.checks.length > 0).length;
  let exitCode = 0;
  if (failedChecks.length > 0) exitCode = 1;
  else if (covered < CRITERIA.length) exitCode = 2;
  report.failedChecks = failedChecks;
  report.summary = {
    criteriaTotal: CRITERIA.length,
    criteriaCovered: covered,
    criteriaPassed: report.criteria.filter((criterion) => criterion.status === 'pass').length,
    criteriaFailed: report.criteria.filter((criterion) => criterion.status === 'fail').length,
    criteriaNotRun: report.criteria.filter((criterion) => criterion.status === 'not-run').length,
    requiredChecks: report.criteria.reduce((sum, criterion) => sum + criterion.requiredChecks, 0),
    failedChecks: failedChecks.length,
    notRunChecks: report.notRun.filter((item) => item.disposition !== 'NOT_APPLICABLE').length,
    screenshots: report.screenshots.length,
    exitCode,
  };
  report.resources = state.cleanupResult || { reason: 'not-run' };
  await writeFile(join(EVIDENCE_DIR, 'run-report.json'), JSON.stringify(report, null, 2));
  await writeFile(join(EVIDENCE_DIR, 'run.log'), logLines.join('\n') + '\n');
  return report.summary;
}

async function writePartialReport() {
  try {
    await mkdir(EVIDENCE_DIR, { recursive: true });
    report.criteria = buildCriteriaReport();
    await writeFile(join(EVIDENCE_DIR, 'run-report.json'), JSON.stringify(report, null, 2));
    await writeFile(join(EVIDENCE_DIR, 'run.log'), logLines.join('\n') + '\n');
  } catch { /* best effort while aborting */ }
}

function printSummary(summary) {
  log('\n================ WEB-T4 network fixture acceptance summary ================');
  for (const criterion of report.criteria) {
    const required = (criterion.checks || []).filter((item) => item.required).length;
    const passed = (criterion.checks || []).filter((item) => item.required && item.pass).length;
    log(`${criterion.id.padEnd(4)} ${criterion.status.toUpperCase().padEnd(8)} ${passed}/${required} checks`);
  }
  if (report.notRun.length) {
    log('\nNOT_RUN:');
    for (const item of report.notRun) log(`  [${item.criteria}] ${item.label}: ${item.reason}`);
  }
  if (report.findings.length) {
    log('\nfindings:');
    for (const finding of report.findings) log(`  [${finding.id}] ${finding.severity}: ${finding.summary}`);
  }
  if (report.screenshots.length) {
    log('\nscreenshots:');
    for (const shot of report.screenshots) log(`  ${shot.label}: ${shot.file?.path} (${shot.width}x${shot.height}, sha256=${String(shot.file?.sha256 || '').slice(0, 12)}…)`);
  }
  log(`\ncriteria=${summary.criteriaTotal} covered=${summary.criteriaCovered} pass=${summary.criteriaPassed} fail=${summary.criteriaFailed} notRun=${summary.criteriaNotRun}`);
  log(`requiredChecks=${summary.requiredChecks} failedChecks=${summary.failedChecks} notRunChecks=${summary.notRunChecks}`);
  log(`evidence: ${EVIDENCE_DIR}`);
  log(`EXIT ${summary.exitCode}`);
}

/* ------------------------------------------------------------------------------------------------
 * Runner
 * ---------------------------------------------------------------------------------------------- */

let FIXTURE_BASE = '';

async function main() {
  await mkdir(EVIDENCE_DIR, { recursive: true });
  state.chromium = await chooseChromiumPlan();
  const module = await harnessModule();
  for (const dir of await module.snapshotProfileDirs()) state.baselineProfiles.add(dir);
  for (const proc of module.scanPluginChromeProcesses()) state.baselinePids.add(proc.pid);

  report.environment = {
    suite: report.suite,
    contract: report.contract,
    truthTable: report.truthTable,
    node: process.version,
    platform: `${process.platform}/${process.arch}`,
    repoRoot: REPO_ROOT,
    chromeBin: state.chromium.bin,
    chromePlan: state.chromium,
    fakeContext: 'effect/tools.register/webServer.register/skills.register/logger/inject',
    timeoutMs: TOTAL_TIMEOUT_MS,
    captureRoot: EVIDENCE_DIR,
    only: process.env.DSH_T4NET_ONLY || null,
  };
  log(`[env] chromium plan: ${state.chromium.source} -> ${state.chromium.bin}`);
  log(`[env] capture/evidence root: ${EVIDENCE_DIR}`);

  const { startFixtureServer } = await import(pathToFileURL(join(REPO_ROOT, 'tests/ui_test_fixture/server.mjs')).href);
  state.fixture = await startFixtureServer();
  FIXTURE_BASE = state.fixture.url.replace(/\/$/, '');
  report.environment.fixtureUrl = state.fixture.url;
  log(`[env] fixture: ${state.fixture.url}`);

  const { createHarness } = module;
  const harness = await createHarness({ name: 'T4NET-main' });
  state.harnesses.push(harness);
  report.environment.toolCount = harness.toolNames().length;
  report.environment.tools = harness.toolNames();
  log(`[env] tools (${harness.toolNames().length}): ${harness.toolNames().join(', ')}`);

  const only = String(process.env.DSH_T4NET_ONLY || '').split(',').map((item) => item.trim().toUpperCase()).filter(Boolean);
  const selected = (meta) => only.length === 0 || meta.criteria.some((token) => only.includes(token));

  for (const meta of B_PROBES) {
    if (!selected(meta)) { log(`\n== ${meta.id} (${meta.criteria}) — SKIPPED by DSH_T4NET_ONLY`); continue; }
    const probe = await runProbe(
      { id: meta.id, criteria: meta.criteria, title: meta.title, expected: meta.expected },
      ({ check, finding, notRun, skip }) => meta.body()({ harness, check, finding, notRun, skip }),
    );
    for (const criterionId of meta.criteria) {
      for (const entry of probe.checks) {
        recordCriterionCheck(criterionId, {
          source: 'B', label: entry.label, pass: entry.pass, required: !entry.advisory,
          detail: { expected: entry.expected, actual: entry.actual },
        });
      }
    }
  }

  log('\n[cleanup] closing browser and fixture');
  await cleanupResources('suite-complete');
  const summary = await writeEvidence();
  state.finished = true;
  printSummary(summary);
  return summary.exitCode;
}

/* ---- process lifecycle ----------------------------------------------------------------------- */

let terminating = false;
for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
  process.on(signal, async () => {
    if (terminating) return;
    terminating = true;
    log(`\n[signal] ${signal} — writing partial evidence and cleaning up`);
    report.interrupted = { signal, at: new Date().toISOString() };
    try { await cleanupResources(`signal-${signal}`); } catch { /* ignore */ }
    await writePartialReport();
    process.exit(2);
  });
}

const watchdog = setTimeout(async () => {
  if (state.finished) return;
  log(`\n[watchdog] HARD TIMEOUT after ${TOTAL_TIMEOUT_MS}ms — cleaning up and exiting 2`);
  report.hardTimedOut = true;
  try { await cleanupResources('hard-timeout'); } catch { /* ignore */ }
  await writePartialReport();
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
  try { await cleanupResources('fatal-error'); } catch { /* ignore */ }
  await writePartialReport();
  exitCode = 2;
}
process.exitCode = exitCode;
