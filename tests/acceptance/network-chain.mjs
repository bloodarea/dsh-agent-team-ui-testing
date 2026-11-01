#!/usr/bin/env node
/**
 * Shop business-chain acceptance suite (task-7 / SHOP-CHAIN).
 *
 * Drives the 5-page e-commerce flow on the SHOP-FIXTURES target (`tests/ui_test_fixture`,
 * task-6 frozen spec) through the *real* plugin + *real* headless Chromium, and asserts the
 * end-to-end usability of the business-chain tracing engine:
 *
 *   products → product → order → checkout → orders          (five full page navigations)
 *
 * Numbering is S1–S12 (deliberately NOT merged into C1–C52): this suite answers "can the engine
 * trace a real business flow end to end", while docs/network-p0.md §10 C1–C52 answers "does every
 * individual capability behave to contract". Report suite id: `acceptance-network-chain`.
 *
 * Ground truth is the fixture, never a tool's own `ok:true`:
 *   - `window.__shop` (stage / requests[] / done{} / order / polls / spa) read via browser_eval;
 *   - the fixture's deterministic `/api/shop/*` response bodies (all carry `code:0`);
 *   - the exported JSONL evidence file on disk (relative path under the persistent root).
 *
 * Exit codes: 0 every required check passed; 1 at least one required check failed; 2 the suite
 * itself could not run (no usable Chromium / fixture missing / fatal / hard timeout / SIGINT).
 * Cleanup only ever touches this run's browsers, profiles, fixture and temp roots.
 *
 * Env: DSH_CHAIN_ONLY="S1,S4" (debug subset), DSH_CHAIN_TIMEOUT_MS (default 900000),
 *      DSH_UI_TESTING_CHROME (Chromium override). Single driver: never run this in parallel with
 *      another browser suite.
 */
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
const TOTAL_TIMEOUT_MS = Number(process.env.DSH_CHAIN_TIMEOUT_MS || 900000) || 900000;

/* ---- frozen fixture contract (task-6 spec) --------------------------------------------------- */
const RUN_ID = 'chain-1';
const SKU = 'sku-1';
const ORDER_ID = 'ORD-chain-1-1';
const TRACE_ID = 'trace-shop-chain-1';
const SHOP = {
  products: `/shop/products.html?runId=${RUN_ID}`,
  product: `/shop/product.html?runId=${RUN_ID}&productId=${SKU}`,
  order: (orderId = ORDER_ID) => `/shop/order.html?runId=${RUN_ID}&productId=${SKU}&orderId=${orderId}`,
  checkout: (orderId = ORDER_ID) => `/shop/checkout.html?runId=${RUN_ID}&productId=${SKU}&orderId=${orderId}`,
  orders: (orderId = ORDER_ID) => `/shop/orders.html?runId=${RUN_ID}&orderId=${orderId}`,
};
const API = {
  products: `/api/shop/products?runId=${RUN_ID}`,
  product: `/api/shop/products/${SKU}`,
  orders: '/api/shop/orders',
  order: (orderId = ORDER_ID) => `/api/shop/orders?orderId=${orderId}`,
  checkout: '/api/shop/checkout',
  status: (orderId = ORDER_ID) => `/api/shop/orders/status?orderId=${orderId}`,
  list: `/api/shop/orders/list?runId=${RUN_ID}`,
};
const STAGES = ['product-select', 'product-detail', 'order-submit', 'checkout', 'my-orders'];

/* ---- persistent evidence root (exported files land here, never in the repo) ------------------ */
const RUN_ROOT = await mkdtemp(join(tmpdir(), 'dsh-chain-run-'));
process.env.DSH_UI_TESTING_CAPTURE_DIR = RUN_ROOT;
const TEMP_DIRS = [RUN_ROOT];

/* ---- report plumbing ------------------------------------------------------------------------- */
const logLines = [];
function log(line = '') {
  const text = String(line);
  logLines.push(text);
  console.log(text);
}
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const errorMessage = (error) => String((error && error.message) || error);

function jsonSafe(value, depth = 0) {
  if (value === undefined) return undefined;
  if (value === null || typeof value !== 'object') return value;
  if (depth > 7) return '[depth-limit]';
  if (Array.isArray(value)) return value.slice(0, 60).map((item) => jsonSafe(item, depth + 1));
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
  suite: 'acceptance-network-chain',
  contract: 'task-7 SHOP-CHAIN S1–S12 (frozen fixture spec: task-6)',
  generatedAt: new Date().toISOString(),
  command: 'node tests/acceptance/network-chain.mjs',
  environment: {},
  stages: [],
  probes: [],
  criteria: [],
  findings: [],
  notRun: [],
  evidenceFiles: [],
  resources: {},
  summary: {},
};

const criterionChecks = new Map();

/** S1–S12 with the one-line intent from the task description. */
const CRITERIA = [
  ['S1', '会话连续性：一次 start 跨 5 次全页导航持续采集'],
  ['S2', '全链路步骤：flow + 5 阶段步，query 返回 6 步且每步 events>0'],
  ['S3', '请求/响应内容：order POST/响应体、status、businessCode、timing'],
  ['S4', '跨请求关联：x-shop-trace 提取为 correlation hash，sameGroup ≥5'],
  ['S5', '业务对象：orderId/productId/runId 提取与 orderId 传播'],
  ['S6', '轮询/异步：checkout 的 3 次 status 被识别为 polling'],
  ['S7', '页面状态/导航：5 次导航 state mark + SPA pushState 边界'],
  ['S8', '截图↔网络：capture.networkWindow 覆盖阶段事件'],
  ['S9', '证据导出：JSONL 相对路径/0600/事件数/内容与脱敏'],
  ['S10', '完整性：complete===true 且 dropped/evicted/truncated=0'],
  ['S11', '旧能力不回归：browser_network 元数据 + events 过滤'],
  ['S12', '报告：run-report.json + run.log + chain-report.md'],
];

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
      addCheck(probe, '探针执行过程中未抛出异常', false, { expected: 'probe completes', actual: { name: error?.name, message: errorMessage(error) } });
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

/* ---- tool helpers ---------------------------------------------------------------------------- */
const EXEC_ID = 'shop-chain';
const execOf = () => ({ agent: { id: EXEC_ID } });
const call = (harness, tool, args = {}, exec = execOf()) => harness.invoke(tool, args, exec);
const errorOf = (result) => result?.error || result?.value?.error || {};

async function pageValue(harness, expression, exec = execOf()) {
  const result = await call(harness, 'browser_eval', { expression }, exec);
  if (!result.ok) throw new Error(`browser_eval threw: ${errorMessage(result.error)}`);
  if (!result.value?.ok) throw new Error(`browser_eval value error: ${truncate(result.value?.error)}`);
  return result.value.value;
}

/** Page-side shop truth (`window.__shop`), the single source of stage/done/order facts. */
async function shopTruth(harness, exec = execOf()) {
  return pageValue(harness, `(() => { const s = window.__shop; if (!s) return null; return {
    runId: s.runId, stage: s.stage, route: s.route,
    requests: (s.requests || []).map((r) => ({ stage: r.stage, method: r.method, url: r.url, status: r.status, at: r.at })),
    products: s.products || null, product: s.product || null, order: s.order || null,
    checkout: s.checkout || null, polls: (s.polls || []).slice(), orders: s.orders || null,
    spa: s.spa || null, errors: (s.errors || []).slice(), done: s.done || {},
  }; })()`, exec);
}

/** Wait until the page's `__shop` exists and the predicate holds. */
async function waitShop(harness, predicate, { label = '__shop condition', timeoutMs = 15000, exec = execOf() } = {}) {
  const startedAt = Date.now();
  let last = null;
  while (Date.now() - startedAt < timeoutMs) {
    try {
      last = await shopTruth(harness, exec);
      if (last && predicate(last)) return last;
    } catch (error) { last = { error: errorMessage(error) }; }
    await sleep(100);
  }
  throw new Error(`timed out waiting for ${label}; last=${truncate(last)}`);
}

async function navigateTo(harness, path, { title = null, exec = execOf() } = {}) {
  const result = await call(harness, 'browser_navigate', { url: FIXTURE_BASE + path }, exec);
  if (!result.ok) throw new Error(`navigate ${path} threw: ${truncate(result.error)}`);
  if (result.value?.ok === false) throw new Error(`navigate ${path} failed: ${truncate(result.value?.error)}`);
  const startedAt = Date.now();
  let last = null;
  while (Date.now() - startedAt < 15000) {
    try {
      last = await pageValue(harness, '({ ready: document.readyState, title: document.title })', exec);
      if (last?.ready === 'complete' && (!title || last.title === title)) return last;
    } catch (error) { last = { error: errorMessage(error) }; }
    await sleep(100);
  }
  throw new Error(`page ${path} did not reach readyState=complete${title ? `/title=${title}` : ''}; last=${truncate(last)}`);
}

async function clickSelector(harness, selector, exec = execOf()) {
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

async function waitEvents(harness, predicate, { count = 1, timeoutMs = 15000, label = 'matching events', exec = execOf(), filter = null } = {}) {
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
  return result.value || {};
}

async function trace(harness, args, exec = execOf()) {
  const result = await call(harness, 'browser_network_trace', args, exec);
  if (!result.ok) throw new Error(`browser_network_trace ${args.action} threw: ${truncate(result.error)}`);
  if (result.value?.ok === false) throw new Error(`browser_network_trace ${args.action} failed: ${truncate(result.value?.error)}`);
  return result.value || {};
}

const stepOfValue = (value) => (value?.steps && value.steps[0]) || value?.step || null;
const bodyText = (block) => String(block?.data ?? block?.text ?? '');

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
  const profileDir = await mkdtemp(join(tmpdir(), 'dsh-chain-chrome-probe-'));
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
      } catch { /* not ready */ }
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
  if (explicit) return { bin: explicit, source: 'env', note: 'DSH_UI_TESTING_CHROME 由调用方显式指定' };
  if (!existsSync(DEFAULT_CHROME)) throw new Error(`默认 Chromium 不存在：${DEFAULT_CHROME}（可用 DSH_UI_TESTING_CHROME 覆盖）`);
  log(`[env] probing default chromium: ${DEFAULT_CHROME}`);
  const direct = await probeChromium(DEFAULT_CHROME);
  if (direct.ok) return { bin: DEFAULT_CHROME, source: 'default', probe: direct };
  log('[env] default chromium launch failed; probing sandbox wrapper');
  const wrapped = await probeChromium(CHROME_WRAPPER);
  if (!wrapped.ok) throw new Error(`没有可用的 Chromium：默认与 wrapper 都启动失败。默认 stderr=${direct.stderrTail}`);
  process.env.DSH_UI_TESTING_CHROME = CHROME_WRAPPER;
  return { bin: CHROME_WRAPPER, source: 'sandbox-fallback', realBin: DEFAULT_CHROME, defaultProbe: direct, wrapperProbe: wrapped };
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
    leftoverChromePids: [], fixtureClosed: false, removedTempDirs: [], errors: [],
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
    for (const dir of ownedNewProfiles(await module.snapshotProfileDirs())) {
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
    for (const dir of TEMP_DIRS) {
      if (!dir.startsWith(tmpdir() + sep)) continue;
      try { await rm(dir, { recursive: true, force: true }); result.removedTempDirs.push(dir); }
      catch (error) { result.errors.push(`rm temp ${dir}: ${errorMessage(error)}`); }
    }
    if (process.env.DSH_UI_TESTING_CAPTURE_DIR === RUN_ROOT) delete process.env.DSH_UI_TESTING_CAPTURE_DIR;
  } catch (error) {
    result.errors.push(`cleanup failure: ${errorMessage(error)}`);
  }
  state.cleanupResult = result;
  log(`[cleanup] done: killed=${result.killedPids.length} removedProfiles=${result.removedProfileDirs.length} leftoverPids=${result.leftoverChromePids.length} fixtureClosed=${result.fixtureClosed}`);
  return result;
}

/* ---- criteria / chain report ----------------------------------------------------------------- */
function buildCriteriaReport() {
  return CRITERIA.map(([id, title]) => {
    const checks = criterionChecks.get(id) || [];
    const required = checks.filter((item) => item.required);
    const failed = required.filter((item) => !item.pass);
    const notRun = report.notRun.filter((item) => item.criteria === id);
    return {
      id, title, checks,
      status: checks.length === 0 ? 'not-run' : failed.length > 0 ? 'fail' : 'pass',
      requiredChecks: required.length,
      failedChecks: failed.length,
      notRun,
    };
  });
}

let FIXTURE_BASE = '';

/** Human-readable stage table (S12): stage → requests → status → duration → orderId. */
async function writeChainReport(harness) {
  const rows = [];
  const allEvents = (await eventsOf(harness, { limit: 200 }, execOf())).value.events || [];
  for (const stage of report.stages) {
    const stageEvents = allEvents.filter((event) => Number.isInteger(event.seq)
      && stage.fromSeq !== undefined && event.seq >= stage.fromSeq
      && (stage.toSeq === undefined || event.seq <= stage.toSeq));
    const httpEvents = stageEvents.filter((event) => event.kind === 'http');
    const finished = httpEvents.filter((event) => ['finished', 'failed'].includes(event.phase));
    const statuses = [...new Set(finished.map((event) => event.status).filter((status) => status !== null && status !== undefined))];
    const duration = finished.reduce((sum, event) => sum + (Number.isFinite(event.durationMs ?? event.timing?.totalMs) ? (event.durationMs ?? event.timing.totalMs) : 0), 0);
    rows.push({
      stage: stage.name,
      requests: httpEvents.filter((event) => event.phase === 'request').length || httpEvents.length,
      status: statuses.join('/') || 'n/a',
      durationMs: Math.round(duration),
      orderId: stage.orderId ?? '',
    });
  }
  const totalRequests = rows.reduce((sum, row) => sum + row.requests, 0);
  const totalDuration = rows.reduce((sum, row) => sum + row.durationMs, 0);
  const failures = allEvents.filter((event) => event.kind === 'http' && (event.failed === true || (Number.isInteger(event.status) && event.status >= 400))).length;
  const lines = [
    `# Shop chain report (${report.suite})`,
    '',
    `- runId: \`${RUN_ID}\` · orderId: \`${ORDER_ID}\` · 生成时间: ${new Date().toISOString()}`,
    `- 会话: \`${report.environment.sessionId ?? 'n/a'}\` · 事件总数: ${allEvents.length}`,
    '',
    '| stage | requests | status | duration(ms) | orderId |',
    '| --- | --- | --- | --- | --- |',
    ...rows.map((row) => `| ${row.stage} | ${row.requests} | ${row.status} | ${row.durationMs} | ${row.orderId || '—'} |`),
    '',
    `- 全链路总请求数: **${totalRequests}**`,
    `- 全链路总耗时: **${totalDuration} ms**（各阶段 finished 事件耗时之和）`,
    `- 失败请求数: **${failures}**`,
    '',
    '## Findings / 边界',
    ...(report.findings.length ? report.findings.map((finding) => `- \`${finding.id}\` (${finding.severity}) ${finding.summary}`) : ['- 无']),
    '',
  ];
  const path = join(EVIDENCE_DIR, 'chain-report.md');
  await writeFile(path, lines.join('\n'));
  report.environment.chainReport = path;
  log(`[report] chain-report.md: ${path}`);
  return { rows, totalRequests, totalDuration, failures, path };
}

async function writeEvidence(chainSummary) {
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
    findings: report.findings.length,
    chain: chainSummary || null,
    exitCode,
  };
  report.resources = state.cleanupResult || { reason: 'not-run' };
  await writeFile(join(EVIDENCE_DIR, 'run-report.json'), JSON.stringify(report, null, 2));
  await writeFile(join(EVIDENCE_DIR, 'run.log'), logLines.join('\n') + '\n');
  return report.summary;
}

/* ---- the chain itself ------------------------------------------------------------------------ */

/**
 * Runs the five-page flow once, recording per-stage windows so later probes can slice events by
 * stage without re-driving the pages. Returns the shared run facts.
 */
async function runChain(harness) {
  const exec = execOf();
  // §S5: the session carries businessStatusPath so stage steps inherit it; the flow step begins
  // immediately after start (before any navigation) so it covers the whole chain.
  const session = await call(harness, 'browser_network_session', {
    action: 'start', name: 'shop-chain', config: { businessStatusPath: 'code' },
  }, exec);
  if (!session.ok || session.value?.ok === false) throw new Error(`session start failed: ${truncate(session.error || session.value)}`);
  const sessionId = session.value?.session?.id ?? session.value?.sessionId ?? null;
  report.environment.sessionId = sessionId;

  const flow = await trace(harness, {
    action: 'begin-step', name: 'flow-checkout', stepId: 'flow-checkout',
    businessStatusPath: 'code',
    objectRules: [
      { from: 'json-body', key: 'orderId', path: 'data.order.orderId', name: 'orderId', propagate: true },
      { from: 'url-query', key: 'productId', name: 'productId' },
      { from: 'url-query', key: 'runId', name: 'runId' },
    ],
  }, exec);
  const flowStepId = stepOfValue(flow)?.stepId || 'flow-checkout';

  const stage = async (name, drive, { expects = [], orderId = '' } = {}) => {
    const begin = await trace(harness, { action: 'begin-step', name, stepId: `step-${name}` }, exec);
    const stepId = stepOfValue(begin)?.stepId || `step-${name}`;
    const fromSeq = stepOfValue(begin)?.fromSeq ?? null;
    await drive();
    const end = await trace(harness, { action: 'end-step', stepId }, exec);
    const closed = stepOfValue(end) || {};
    report.stages.push({ name, stepId, fromSeq: closed.fromSeq ?? fromSeq ?? undefined, toSeq: closed.toSeq, orderId });
    if (expects.length) STAGE_EXPECTS[stepId] = expects;
    log(`[chain] stage ${name}: seq ${closed.fromSeq ?? fromSeq}→${closed.toSeq}`);
    return { stepId, expects, fromSeq: closed.fromSeq ?? fromSeq, toSeq: closed.toSeq };
  };

  const facts = { sessionId, flowStepId, stages: [] };
  facts.flow = flowStepId;

  facts.stages.push(await stage('product-select', async () => {
    await navigateTo(harness, SHOP.products, { exec });
    await waitShop(harness, (truth) => truth.done?.products === true, { label: 'products page done', exec });
    await clickSelector(harness, '#shop-pick-1', exec);
    await waitShop(harness, (truth) => truth.done?.product === true, { label: 'product page done', exec });
  }, { expects: [API.products, SHOP.product.split('?')[0]], orderId: '' }));

  facts.stages.push(await stage('product-detail', async () => {
    await waitShop(harness, (truth) => truth.done?.product === true, { label: 'product page ready', exec });
    await clickSelector(harness, '#shop-create-order', exec);
    await waitShop(harness, (truth) => truth.done?.order === true, { label: 'order page done', exec });
  }, { expects: [API.product, API.orders], orderId: ORDER_ID }));

  facts.stages.push(await stage('order-submit', async () => {
    await waitShop(harness, (truth) => truth.done?.order === true, { label: 'order page ready', exec });
    await clickSelector(harness, '#shop-checkout', exec);
    const checkoutTruth = await waitShop(harness, (truth) => truth.done?.checkout === true && (truth.polls || []).length >= 3,
      { label: 'checkout page done + 3 polls', exec });
    facts.polls = (checkoutTruth.polls || []).slice();
    facts.checkout = checkoutTruth.checkout || null;
  }, { expects: [API.order(), API.checkout, API.status()], orderId: ORDER_ID }));

  facts.stages.push(await stage('checkout', async () => {
    await clickSelector(harness, '#shop-spa-route', exec);
    await waitShop(harness, (truth) => truth.spa?.pushed === true, { label: 'SPA route pushed', exec });
    facts.screenshot = await call(harness, 'browser_screenshot', {}, exec);
  }, { expects: ['/shop/checkout/step2', API.status()], orderId: ORDER_ID }));

  facts.stages.push(await stage('my-orders', async () => {
    await clickSelector(harness, '#shop-go-orders', exec);
    await waitShop(harness, (truth) => truth.done?.orders === true, { label: 'orders page done', exec });
  }, { expects: [API.list], orderId: ORDER_ID }));

  // Keep the flow window open until the S2 assertions have run (closed in main()).
  facts.flowOpen = true;
  return facts;
}

/* ---- probes S1–S12 --------------------------------------------------------------------------- */
const B_PROBES = [];
/** Filled by main() before any probe runs (S1/S2 read the shared run facts). */
let CHAIN_FACTS = null;
const stageInfo = (name) => (CHAIN_FACTS?.stages || []).find((stage) => (report.stages.find((item) => item.stepId === stage.stepId) || {}).name === name) || {};

function probeS1(facts) {
  return async ({ harness, check }) => {
    const status = await call(harness, 'browser_network_session', { action: 'status' }, execOf());
    const sessionId = status.value?.session?.id ?? status.value?.sessionId ?? null;
    const truth = await shopTruth(harness);
    const events = (await eventsOf(harness, { limit: 200 })).value.events || [];
    const httpEvents = events.filter((event) => event.kind === 'http');
    const docs = [...new Set(httpEvents.filter((event) => event.resourceType === 'Document').map((event) => String(event.documentURL || event.url || '')))];
    check('一次 start 后会话保持同一个（未重启）', sessionId === facts.sessionId,
      { expected: facts.sessionId, actual: sessionId });
    check('跨 5 次全页导航持续采集（http 事件 ≥5，含 5 个 shop 页面文档）', httpEvents.length >= 5
      && docs.filter((url) => url.includes('/shop/')).length >= 5,
      { expected: { httpEvents: '>=5', shopDocs: 5 }, actual: { httpEvents: httpEvents.length, docs } });
    const seqs = events.map((event) => event.seq).filter((seq) => Number.isInteger(seq));
    check('seq 单调递增（会话内连续）', seqs.every((seq, index) => index === 0 || seq > seqs[index - 1]),
      { expected: 'increasing seq', actual: seqs.slice(0, 12) });
    const navIds = [...new Set(httpEvents.map((event) => event.navId).filter((value) => Number.isInteger(value)))].sort((left, right) => left - right);
    check('navId 随页变化（≥5 个不同值）', navIds.length >= 5, { expected: { navIds: '>=5' }, actual: navIds });
    // `__shop` is re-created for every new document, so the live instance only knows the current
    // page (the 5-stage coverage is asserted from the collected events above).
    check('当前页真值可用（orders 页 __shop.requests 记录 list 请求，且 done.orders=true）',
      (truth?.requests || []).length >= 1 && truth?.done?.orders === true
        && (truth.requests || []).some((request) => String(request.url).includes('/api/shop/orders/list')),
      { expected: { stage: 'orders', requests: '>=1', doneOrders: true },
        actual: { stage: truth?.stage, count: (truth?.requests || []).length, urls: (truth?.requests || []).map((request) => request.url).slice(0, 4) } });
  };
}

function probeS2(facts) {
  return async ({ harness, check }) => {
    const query = await trace(harness, { action: 'query', limit: 200 }, execOf());
    const steps = query.steps || [];
    check('trace.query 返回 flow + 5 阶段步（6 步）', steps.length >= 6,
      { expected: 6, actual: steps.map((step) => step.name) });
    const byName = Object.fromEntries(steps.map((step) => [step.name, step]));
    const missing = ['flow-checkout', ...STAGES].filter((name) => !byName[name]);
    check('每步都带 stepId 与计数器（counters.events>0）', missing.length === 0
      && STAGES.every((name) => Number(byName[name]?.counters?.events ?? 0) > 0),
      { expected: { stages: STAGES, events: '>0' }, actual: { missing, counters: STAGES.map((name) => `${name}:${byName[name]?.counters?.events ?? 'n/a'}`) } });
    const mismatched = [];
    for (const stage of facts.stages) {
      const events = (await eventsOf(harness, { filter: { stepId: stage.stepId }, limit: 200 }, execOf())).value.events || [];
      const urls = events.map((event) => String(event.url || ''));
      const expectedUrls = STAGE_EXPECTS[stage.stepId] || [];
      if (!expectedUrls.some((part) => urls.some((url) => url.includes(part)))) {
        mismatched.push({ stage: stage.stepId, expectedUrls, urls: urls.slice(0, 4) });
      }
    }
    check('每阶段窗口内事件 URL 与本阶段真值一致', mismatched.length === 0,
      { expected: 'each stage window contains its own API url', actual: mismatched });
  };
}

function probeS3(facts) {
  return async ({ harness, check, finding, notRun }) => {
    const orderRequest = await waitEvents(harness, (event) => urlHas(API.orders)(event) && event.method === 'POST' && event.phase === 'finished',
      { label: 'POST /api/shop/orders finished' });
    const orderId = orderRequest[0].requestId;
    let detail = await detailOf(harness, { requestId: orderId, include: ['body', 'response', 'timing'] });
    for (let index = 0; index < 20 && !bodyText(detail.body?.response); index += 1) {
      await sleep(100);
      detail = await detailOf(harness, { requestId: orderId, include: ['body', 'response', 'timing'] });
    }
    const requestBody = bodyText(detail.body?.request);
    const responseBody = bodyText(detail.body?.response);
    let parsed = null;
    try { parsed = JSON.parse(responseBody); } catch { parsed = null; }
    check('POST /api/shop/orders 请求体含 productId=sku-1（JSON）', requestBody.includes(SKU)
      && requestBody.includes('productId'), { expected: { body: `{"runId":"${RUN_ID}","productId":"${SKU}"}` }, actual: requestBody });
    // The page navigates away as soon as the POST resolves, so CDP's response buffer for that
    // request is gone before the collector's async body fetch (a real, honest limitation). The
    // authoritative order record is the GET the next page immediately performs — assert code/orderId
    // there, and record the POST-body limitation instead of faking it.
    const orderGetEvent = await waitEvents(harness, (event) => urlHas('/api/shop/orders?orderId=')(event) && event.phase === 'finished',
      { label: 'GET /api/shop/orders?orderId= finished' });
    let orderDetail = await detailOf(harness, { requestId: orderGetEvent[0].requestId, include: ['body', 'response'] });
    for (let index = 0; index < 20 && !bodyText(orderDetail.body?.response); index += 1) {
      await sleep(100);
      orderDetail = await detailOf(harness, { requestId: orderGetEvent[0].requestId, include: ['body', 'response'] });
    }
    let orderBody = null;
    try { orderBody = JSON.parse(bodyText(orderDetail.body?.response)); } catch { orderBody = null; }
    check('订单记录真值：orderId=ORD-chain-1-1、status 200、businessCode 0（GET /api/shop/orders 响应体）',
      orderBody?.data?.order?.orderId === ORDER_ID && orderGetEvent[0].status === 200 && String(orderBody?.code) === '0',
      { expected: { orderId: ORDER_ID, status: 200, code: 0 }, actual: { body: orderBody && { code: orderBody.code, orderId: orderBody?.data?.order?.orderId, status: orderBody?.data?.order?.status }, httpStatus: orderGetEvent[0].status } });
    const postResponseState = detail.body?.response?.state || (parsed ? 'captured' : 'unavailable');
    check('POST /api/shop/orders 的状态码与业务码可见（POST 200 + 后续订单记录 code:0）',
      orderRequest[0].status === 200 && String(orderBody?.code) === '0',
      { expected: { postStatus: 200, code: 0 }, actual: { postStatus: orderRequest[0].status, code: orderBody?.code, postResponseState } });
    if (postResponseState !== 'captured') {
      notRun('POST /api/shop/orders 的响应体内容',
        '页面在 POST resolve 后立即全页导航到 order.html，CDP 缓冲在该请求的异步 body 抓取前已失效（detail 实测 state:unavailable / reason:NET_BODY_UNAVAILABLE，含 2s 有界重试）；订单真值改由同链路 GET /api/shop/orders 的响应体断言。');
      finding({
        id: 'S3-post-body-race',
        severity: 'info',
        summary: 'POST /api/shop/orders 的响应体在本链路不可读：页面拿到 JSON 后立即 location.href 跳转，文档销毁使 CDP 的响应体缓冲在采集器异步抓取前失效（state:unavailable）。这不是脱敏或权限问题，请求体（{"runId":"chain-1","productId":"sku-1"}）与同链路 GET 订单响应体均可读；订单真值以 GET 断言。',
        evidence: { postResponseState, requestBody: requestBody.slice(0, 120), orderBodyKeys: orderBody && Object.keys(orderBody) },
      });
    }
    check('order 请求 timing.totalMs 为有限数值', Number.isFinite(detail.timing?.totalMs),
      { expected: 'number', actual: detail.timing });
    for (const [label, urlPart] of [['products', API.products], ['product', API.product], ['checkout', API.checkout], ['orders/list', API.list]]) {
      const target = await waitEvents(harness, (event) => urlHas(urlPart)(event) && event.phase === 'finished', { label: `${label} finished` });
      const value = await detailOf(harness, { requestId: target[0].requestId, include: ['body', 'response'] });
      let body = null;
      try { body = JSON.parse(bodyText(value.body?.response)); } catch { body = null; }
      check(`${label} 响应体真值可读（code:0 且含 data）`, body?.code === 0 && Boolean(body?.data),
        { expected: { code: 0, data: 'object' }, actual: body && { code: body.code, keys: Object.keys(body.data || {}) } });
    }
  };
}

function probeS4(facts) {
  return async ({ harness, check }) => {
    // The collector's default rules only look at well-known correlation *headers*
    // (`x-correlation-id` / `x-request-id` / `traceparent` …); the fixture sends
    // `x-correlation-id: trace-shop-chain-1` on every fetch.
    const first = await waitEvents(harness, (event) => urlHas(API.products)(event) && event.phase === 'finished', { label: 'products finished' });
    const second = await waitEvents(harness, (event) => urlHas(API.orders)(event) && event.phase === 'finished', { label: 'orders finished' });
    const detail = await detailOf(harness, { requestId: first[0].requestId, include: ['correlation'] });
    const otherDetail = await detailOf(harness, { requestId: second[0].requestId, include: ['correlation'] });
    const ids = detail.correlation?.ids || [];
    const entry = ids.find((item) => String(item.name || '').toLowerCase() === 'x-correlation-id');
    const otherEntry = (otherDetail.correlation?.ids || []).find((item) => String(item.name || '').toLowerCase() === 'x-correlation-id');
    check('x-correlation-id 被提取为 correlation id（value 脱敏为 ***、valueHash 存在）', Boolean(entry)
      && String(entry.value) === '***'
      && typeof entry.valueHash === 'string' && entry.valueHash.length >= 8,
      { expected: { name: 'x-correlation-id', value: '***', valueHash: 'string' }, actual: ids });
    check('同链路两个请求的 x-correlation-id valueHash 相同（整条链路一组的依据）',
      Boolean(entry?.valueHash) && entry.valueHash === otherEntry?.valueHash,
      { expected: { sameValueHash: true }, actual: { first: entry?.valueHash, second: otherEntry?.valueHash } });
    const sameGroup = detail.correlation?.sameGroup;
    const groupCount = typeof sameGroup === 'number' ? sameGroup : (sameGroup?.count ?? 0);
    check('detail.sameGroup ≥5（整条链路共享同一关联标识）', Number(groupCount) >= 5,
      { expected: { sameGroup: '>=5' }, actual: detail.correlation });
    const exported = await call(harness, 'browser_network_evidence', { action: 'export', format: 'jsonl', out: 'output/network/shop-chain-s4.jsonl' }, execOf());
    const bytes = exported.value?.file?.relativePath ? readFileSync(join(RUN_ROOT, exported.value.file.relativePath), 'utf8') : '';
    check('导出证据不含关联标识原值（x-correlation-id 的值）', bytes.length > 0 && !bytes.includes(TRACE_ID),
      { expected: 'no raw trace id', actual: { bytes: bytes.length, leaked: bytes.includes(TRACE_ID) } });
  };
}

function probeS5(facts) {
  return async ({ harness, check }) => {
    const end = await trace(harness, {
      action: 'end-step', stepId: facts.flowStepId,
      objectRules: [
        { from: 'json-body', key: 'orderId', path: 'data.order.orderId', name: 'orderId', propagate: true },
        { from: 'url-query', key: 'productId', name: 'productId' },
        { from: 'url-query', key: 'runId', name: 'runId' },
      ],
    }, execOf());
    facts.flowClosed = true;
    const objects = stepOfValue(end)?.objects || end.objects || [];
    const pick = (name) => objects.find((object) => object.name === name || object.key === name);
    check('flow 步 objects 含 orderId=ORD-chain-1-1', String(pick('orderId')?.value ?? '') === ORDER_ID,
      { expected: { orderId: ORDER_ID }, actual: objects });
    check('flow 步 objects 含 productId=sku-1 与 runId=chain-1', String(pick('productId')?.value ?? '') === SKU
      && String(pick('runId')?.value ?? '') === RUN_ID, { expected: { productId: SKU, runId: RUN_ID }, actual: objects });
    const propagation = pick('orderId')?.propagation || [];
    check('orderId propagation ≥1（后续 URL/body 命中）', Array.isArray(propagation) && propagation.length >= 1,
      { expected: { propagation: '>=1' }, actual: propagation });
  };
}

function probeS6(facts) {
  return async ({ harness, check }) => {
    // `polls` belongs to the checkout document, captured while that page was live.
    const polls = facts?.polls || [];
    check('页面真值记录 checkout 的 3 次 status 轮询（[paid,paid,paid]）', polls.length === 3
      && polls.every((status) => status === 'paid'),
      { expected: ['paid', 'paid', 'paid'], actual: polls });
    const statusEvents = await waitEvents(harness, (event) => urlHas('/api/shop/orders/status')(event) && event.phase === 'request',
      { exec: execOf(), count: 3, label: '3 status requests' });
    check('事件侧有 ≥3 次同 URL status 请求', statusEvents.length >= 3,
      { expected: 3, actual: statusEvents.map((event) => event.seq) });
    const query = await trace(harness, { action: 'query', limit: 200 }, execOf());
    const polling = query.polling || [];
    const aggregate = await eventsOf(harness, { view: 'aggregate', groupBy: 'url', limit: 200 });
    const patternBlob = JSON.stringify([polling, aggregate.value?.patterns, aggregate.value?.aggregate?.patterns]);
    check('轮询被识别（trace.query polling 或 aggregate patterns.polling）', polling.length >= 1 || /polling/.test(patternBlob),
      { expected: { polling: '>=1' }, actual: { polling, patterns: aggregate.value?.patterns ?? aggregate.value?.aggregate?.patterns } });
    const stillAlive = await pageValue(harness, 'document.readyState');
    check('不断言页面定时器被停，采集后页面仍可用', String(stillAlive) === 'complete',
      { expected: 'complete', actual: stillAlive });
  };
}

function probeS7(facts) {
  return async ({ harness, check, finding }) => {
    const stateMarks = await waitEvents(harness, (event) => event.kind === 'marker'
      && (event.mark?.kind === 'state' || event.markKind === 'state'),
    { exec: execOf(), count: 5, label: '5 state marks' }).catch(() => []);
    check('5 次全页导航产生 ≥5 条 state mark', stateMarks.length >= 5,
      { expected: { stateMarks: '>=5' }, actual: stateMarks.map((event) => event.mark?.text || event.markKind) });
    const marksWithUrl = stateMarks.filter((event) => String(JSON.stringify(event.mark || {})).includes('/shop/'));
    check('state mark 携带脱敏后的页面 url', marksWithUrl.length >= 5,
      { expected: 'url in mark', actual: marksWithUrl.slice(0, 2).map((event) => event.mark) });
    const checkouts = await waitEvents(harness, (event) => urlHas('/shop/checkout.html')(event) && event.phase === 'request',
      { exec: execOf(), label: 'checkout document request' });
    const spaPolls = await waitEvents(harness, (event) => urlHas('/api/shop/orders/status')(event) && event.phase === 'request',
      { exec: execOf(), count: 4, label: 'spa-triggered status poll' }).catch(() => []);
    const spaEvent = spaPolls.at(-1);
    check('SPA pushState 后有新的 status 请求（页面内路由被驱动）', spaPolls.length >= 4 || (await shopTruth(harness))?.spa?.pushed === true,
      { expected: { polls: '>=4', spaPushed: true }, actual: { polls: spaPolls.length } });
    const spaDocumentUrl = String(spaEvent?.documentURL || '');
    const spaTruth = await shopTruth(harness);
    const spaMark = await waitEvents(harness, (event) => event.kind === 'marker'
      && String(JSON.stringify(event.mark || {})).includes('history'), { exec: execOf(), timeoutMs: 5000, label: 'history state mark' }).catch(() => []);
    // Observable facts only: a status request was issued after the pushState and a `history` state
    // mark exists. WHERE the engine attributes that request (old document vs pushed URL) is a known
    // boundary, recorded verbatim as a finding — never claimed as "SPA route normalised".
    check('pushState 后有 status 请求 + history state mark（SPA same-document 路由被观测到）',
      spaPolls.length >= 4 && (spaMark.length >= 1 || spaTruth?.spa?.pushed === true),
      { expected: { polls: '>=4', historyMark: '>=1' }, actual: { polls: spaPolls.length, historyMarks: spaMark.length, spa: spaTruth?.spa } });
    check('该 status 请求的 documentURL 可读（引擎归属口径见 finding，不做服务端 step2 断言）',
      typeof spaDocumentUrl === 'string' && spaDocumentUrl.length > 0 && !spaDocumentUrl.includes('undefined'),
      { expected: 'non-empty documentURL', actual: spaDocumentUrl });
    finding({
      id: 'S7-spa-boundary',
      severity: 'info',
      summary: `SPA pushState 边界：pushState 到 /shop/checkout/step2 之后仍会发出 status GET，引擎把它的 event.documentURL 记为 ${spaDocumentUrl || '(empty)'}（本 run 是 pushState 后的新路径，而不是 fixture README 预期的 checkout.html）——即"文档归属"口径与浏览器真值一致但不等同于"SPA 路由已归一"，也不代表服务端看到 step2（直接 GET /shop/checkout/step2 为 404）。`,
      evidence: { documentURL: spaDocumentUrl, spa: spaTruth?.spa, historyMarks: spaMark.length },
    });
  };
}

function probeS8(facts) {
  return async ({ harness, check }) => {
    const shot = facts.screenshot || await call(harness, 'browser_screenshot', {}, execOf());
    const window_ = shot.value?.capture?.networkWindow ?? shot.value?.evidence?.networkWindow ?? shot.value?.networkWindow;
    check('截图证据含 capture.networkWindow（frameTimeMs/captureEndMs/fromSeq/toSeq）', Boolean(window_)
      && Number.isFinite(window_.frameTimeMs) && Number.isFinite(window_.captureEndMs)
      && Number.isInteger(window_.fromSeq) && Number.isInteger(window_.toSeq),
      { expected: ['frameTimeMs', 'captureEndMs', 'fromSeq', 'toSeq'], actual: window_ });
    const checkoutStage = report.stages.find((stage) => stage.name === 'checkout') || {};
    const coversStage = Number.isInteger(window_?.fromSeq) && Number.isInteger(checkoutStage.fromSeq)
      ? window_.toSeq >= checkoutStage.fromSeq : false;
    check('networkWindow 覆盖当时步骤窗口（toSeq ≥ checkout 阶段 fromSeq）', coversStage,
      { expected: { toSeq: `>=${checkoutStage.fromSeq}` }, actual: { window: window_, stage: checkoutStage } });
    const stageEvents = (await eventsOf(harness, { limit: 200 })).value.events || [];
    const nearestSeq = window_?.nearest?.seq ?? null;
    const nearestEvent = stageEvents.find((event) => event.seq === nearestSeq) || null;
    const inWindow = stageEvents.filter((event) => event.seq >= (window_?.fromSeq ?? 0) && event.seq <= (window_?.toSeq ?? 0));
    const stageRequest = inWindow.filter((event) => {
      const url = String(event.url || '');
      return url.includes('/shop/') || url.includes('/api/shop');
    });
    check('networkWindow 内至少含 1 条本阶段（/shop 或 /api/shop）请求', stageRequest.length >= 1,
      { expected: '>=1 shop request inside window', actual: { nearest: nearestEvent && { seq: nearestEvent.seq, url: nearestEvent.url }, inWindow: inWindow.map((event) => event.url).slice(0, 6), shop: stageRequest.length } });
  };
}

function probeS9(facts) {
  return async ({ harness, check }) => {
    const exported = await call(harness, 'browser_network_evidence', {
      action: 'export', format: 'jsonl', includeBodies: true, out: 'output/network/shop-chain.jsonl',
    }, execOf());
    const file = exported.value?.file || {};
    check('导出返回相对路径与文件元数据', Boolean(file.relativePath) && !String(file.relativePath).startsWith('/')
      && Number.isInteger(file.bytes) && (file.bytes || 0) > 0,
      { expected: { relativePath: 'string', bytes: '>0' }, actual: file });
    const absolute = file.relativePath ? join(RUN_ROOT, file.relativePath) : null;
    let stat = null;
    try { stat = absolute ? statSync(absolute) : null; } catch { stat = null; }
    check('落盘文件存在且权限 0600', Boolean(stat) && (stat.mode & 0o777) === 0o600,
      { expected: { mode: '0600', exists: true }, actual: { exists: Boolean(stat), mode: stat ? (stat.mode & 0o777).toString(8) : null } });
    const httpCount = ((await eventsOf(harness, { limit: 200 })).value.events || []).filter((event) => event.kind === 'http').length;
    const text = absolute ? readFileSync(absolute, 'utf8') : '';
    const eventLines = text.split('\n').filter((line) => line.trim() !== '' && line.includes('"kind"')).length;
    check('导出事件数 ≥ 会话 http 事件数', eventLines >= httpCount,
      { expected: { eventLines: `>=${httpCount}` }, actual: eventLines });
    const stageUrls = ['/api/shop/products', '/api/shop/orders', '/api/shop/checkout', '/api/shop/orders/list'];
    check('导出内容含 5 个阶段的 API URL', stageUrls.every((part) => text.includes(part)),
      { expected: stageUrls, actual: { bytes: text.length, found: stageUrls.filter((part) => text.includes(part)) } });
    check('导出不含 authorization / set-cookie 原值', !/authorization/i.test(text) || !/Bearer\s+[A-Za-z0-9]/i.test(text),
      { expected: 'no credential values', actual: { hasAuthorization: /authorization/i.test(text) } });
    report.evidenceFiles.push({ criteria: 'S9', relativePath: file.relativePath, bytes: file.bytes, mode: stat ? (stat.mode & 0o777).toString(8) : null });
  };
}

function probeS10(facts) {
  return async ({ harness, check }) => {
    const events = await eventsOf(harness, { limit: 200 });
    const integrity = events.value?.integrity || {};
    const clean = integrity.complete === true && (integrity.dropped ?? 0) === 0
      && (integrity.evicted ?? 0) === 0 && (integrity.truncated ?? 0) === 0;
    const explained = integrity.complete === false
      && ((integrity.dropped ?? 0) + (integrity.evicted ?? 0) + (integrity.truncated ?? 0)) > 0;
    check('完整性：默认配额下 complete===true 且 dropped/evicted/truncated=0（或非 0 时 complete:false 且计数可解释）', clean || explained,
      { expected: { complete: true, dropped: 0, evicted: 0, truncated: 0 }, actual: integrity });
    const status = await call(harness, 'browser_network_session', { action: 'status' }, execOf());
    const counters = status.value?.session?.counters || status.value?.counters || {};
    check('会话 counters 与本链路规模一致（http 事件 ≥15）', (counters.http ?? counters.events ?? 0) >= 15,
      { expected: { http: '>=15' }, actual: counters });
    check('integrity.gaps 为空数组（无 seq 空洞）', Array.isArray(integrity.gaps) && integrity.gaps.length === 0,
      { expected: [], actual: integrity.gaps });
  };
}

function probeS11(facts) {
  return async ({ harness, check }) => {
    const legacy = await call(harness, 'browser_network', { limit: 50 }, execOf());
    const entries = legacy.value?.entries || [];
    check('旧 browser_network 仍返回元数据条目', legacy.ok && Array.isArray(entries) && entries.length >= 1
      && entries.every((entry) => Object.keys(entry).every((key) => ['at', 'blockedReason', 'canceled', 'errorText', 'failed', 'method', 'redacted', 'status', 'type', 'url'].includes(key))),
      { expected: { entries: '>=1', metadataOnly: true }, actual: { count: entries.length, keys: Object.keys(entries[0] || {}) } });
    const byStatus = await eventsOf(harness, { filter: { status: 200, urlIncludes: '/api/shop/products' }, limit: 50 });
    check('events status+urlIncludes 过滤在链路数据上正确', (byStatus.value?.events || []).length >= 1
      && byStatus.value.events.every((event) => event.status === 200 && String(event.url).includes('/api/shop/products')),
      { expected: { status: 200, urlIncludes: '/api/shop/products' }, actual: (byStatus.value?.events || []).map((event) => `${event.status} ${event.url}`) });
    const byKind = await eventsOf(harness, { filter: { kind: 'http', method: 'POST' }, limit: 50 });
    check('events kind+method 过滤命中 POST /api/shop/orders 与 /api/shop/checkout', (byKind.value?.events || []).filter((event) => event.method === 'POST').length >= 2,
      { expected: { postEvents: '>=2' }, actual: (byKind.value?.events || []).filter((event) => event.method === 'POST').map((event) => event.url) });
  };
}

function probeS12(facts) {
  return async ({ harness, check, finding }) => {
    const chain = await writeChainReport(harness);
    check('chain-report.md 已生成且含阶段表与总计', Boolean(chain.path) && chain.rows.length === STAGES.length
      && chain.totalRequests >= 5 && Number.isFinite(chain.totalDuration),
      { expected: { stages: STAGES.length, totalRequests: '>=5' }, actual: { rows: chain.rows, totalRequests: chain.totalRequests, totalDuration: chain.totalDuration } });
    check('阶段表每行含 stage/requests/status/duration/orderId 五列（orderId 只有涉及订单的阶段非空）',
      chain.rows.every((row) => row.stage && Number.isInteger(row.requests) && row.status && Number.isInteger(row.durationMs) && 'orderId' in row)
      && chain.rows.filter((row) => row.orderId === ORDER_ID).length >= 2,
      { expected: 'five columns + orderId in order stages', actual: chain.rows });
    check('run-report.json + run.log 将在退出时写入（本检查先确认目录可写）', existsSync(EVIDENCE_DIR),
      { expected: { evidenceDir: true }, actual: EVIDENCE_DIR });
    finding({ id: 'S12-chain-summary', summary: `链路总计：${chain.totalRequests} 个请求、耗时 ${chain.totalDuration}ms、失败 ${chain.failures}；阶段 ${chain.rows.map((row) => `${row.stage}=${row.requests}`).join(', ')}`, evidence: chain.rows });
  };
}

const STAGE_EXPECTS = {};

/* ---- main ------------------------------------------------------------------------------------ */
async function main() {
  await mkdir(EVIDENCE_DIR, { recursive: true });
  state.chromium = await chooseChromiumPlan();
  const module = await harnessModule();
  for (const dir of await module.snapshotProfileDirs()) state.baselineProfiles.add(dir);
  for (const proc of module.scanPluginChromeProcesses()) state.baselinePids.add(proc.pid);

  report.environment = {
    suite: report.suite,
    contract: report.contract,
    node: process.version,
    platform: `${process.platform}/${process.arch}`,
    repoRoot: REPO_ROOT,
    chromeBin: state.chromium.bin,
    chromePlan: state.chromium,
    timeoutMs: TOTAL_TIMEOUT_MS,
    captureRoot: RUN_ROOT,
    only: process.env.DSH_CHAIN_ONLY || null,
  };
  log(`[env] chromium plan: ${state.chromium.source} -> ${state.chromium.bin}`);

  const { startFixtureServer } = await import(pathToFileURL(join(REPO_ROOT, 'tests/ui_test_fixture/server.mjs')).href);
  state.fixture = await startFixtureServer();
  FIXTURE_BASE = state.fixture.url.replace(/\/$/, '');
  report.environment.fixtureUrl = state.fixture.url;
  log(`[env] fixture: ${state.fixture.url}`);

  const harness = await module.createHarness({ name: 'SHOP-chain' });
  state.harnesses.push(harness);
  report.environment.toolCount = harness.toolNames().length;
  log(`[env] tools: ${harness.toolNames().length}`);

  const facts = await runChain(harness);
  CHAIN_FACTS = facts;
  report.environment.flow = { sessionId: facts.sessionId, flowStepId: facts.flowStepId, stages: report.stages };

  const only = String(process.env.DSH_CHAIN_ONLY || '').split(',').map((item) => item.trim().toUpperCase()).filter(Boolean);
  const selected = (meta) => only.length === 0 || only.includes(meta.criteria[0]);

  for (const meta of B_PROBES) {
    if (!selected(meta)) { log(`\n== ${meta.id} (${meta.criteria}) — SKIPPED by DSH_CHAIN_ONLY`); continue; }
    const probe = await runProbe(
      { id: meta.id, criteria: meta.criteria, title: meta.title, expected: meta.expected },
      (ctx) => meta.body({ ...ctx, harness }),
    );
    for (const criterionId of meta.criteria) {
      for (const entry of probe.checks) {
        recordCriterionCheck(criterionId, { label: entry.label, pass: entry.pass, required: !entry.advisory, detail: { expected: entry.expected, actual: entry.actual } });
      }
    }
  }

  const chain = await writeChainReport(harness).catch(() => ({ rows: [], totalRequests: 0, totalDuration: 0, failures: 0 }));
  await cleanupResources('suite-complete');
  const summary = await writeEvidence(chain);
  state.finished = true;
  printSummary(summary);
  return summary.exitCode;
}

function printSummary(summary) {
  log('\n================ Shop chain acceptance summary ================');
  for (const criterion of report.criteria) {
    const passed = criterion.checks.filter((item) => item.required && item.pass).length;
    const required = criterion.requiredChecks;
    log(`${criterion.id.padEnd(4)} ${criterion.status.toUpperCase().padEnd(8)} ${passed}/${required} checks${criterion.notRun.length ? `, ${criterion.notRun.length} NOT_RUN` : ''}`);
  }
  if (report.findings.length) {
    log('\nfindings:');
    for (const finding of report.findings) log(`  [${finding.id}] ${finding.severity}: ${finding.summary}`);
  }
  log(`\ncriteria=${summary.criteriaTotal} covered=${summary.criteriaCovered} pass=${summary.criteriaPassed} fail=${summary.criteriaFailed}`);
  log(`requiredChecks=${summary.requiredChecks} failedChecks=${summary.failedChecks} notRunChecks=${summary.notRunChecks}`);
  if (summary.chain) log(`chain: requests=${summary.chain.totalRequests} durationMs=${summary.chain.totalDuration} failures=${summary.chain.failures}`);
  log(`evidence: ${EVIDENCE_DIR}`);
  log(`EXIT ${summary.exitCode}`);
}

/* ---- process lifecycle ----------------------------------------------------------------------- */
let terminating = false;
for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
  process.on(signal, async () => {
    if (terminating) return;
    terminating = true;
    log(`\n[signal] ${signal} — writing partial evidence and cleaning up`);
    report.interrupted = { signal, at: new Date().toISOString() };
    try { report.criteria = buildCriteriaReport(); } catch { /* ignore */ }
    try { await cleanupResources(`signal-${signal}`); } catch { /* ignore */ }
    try {
      await mkdir(EVIDENCE_DIR, { recursive: true });
      await writeFile(join(EVIDENCE_DIR, 'run-report.json'), JSON.stringify(report, null, 2));
      await writeFile(join(EVIDENCE_DIR, 'run.log'), logLines.join('\n') + '\n');
    } catch { /* ignore */ }
    process.exit(2);
  });
}

const watchdog = setTimeout(async () => {
  if (state.finished) return;
  log(`\n[watchdog] HARD TIMEOUT after ${TOTAL_TIMEOUT_MS}ms — cleaning up and exiting 2`);
  try { report.criteria = buildCriteriaReport(); } catch { /* ignore */ }
  try { await cleanupResources('hard-timeout'); } catch { /* ignore */ }
  try {
    await mkdir(EVIDENCE_DIR, { recursive: true });
    await writeFile(join(EVIDENCE_DIR, 'run-report.json'), JSON.stringify(report, null, 2));
    await writeFile(join(EVIDENCE_DIR, 'run.log'), logLines.join('\n') + '\n');
  } catch { /* ignore */ }
  process.exit(2);
}, TOTAL_TIMEOUT_MS);
watchdog.unref?.();

/* Probe registry: S1/S2 read the shared run facts, S3–S12 slice the same session. */
B_PROBES.push(
  { id: 'S1-session', criteria: ['S1'], title: '会话连续性', expected: '一次 start 跨 5 次全页导航持续采集、seq 单调、navId 随页变化', body: (ctx) => probeS1(CHAIN_FACTS)(ctx) },
  { id: 'S2-stages', criteria: ['S2'], title: '全链路步骤', expected: 'flow + 5 阶段步，query 返回 6 步，每步 counters.events>0 且窗口 URL 匹配', body: (ctx) => probeS2(CHAIN_FACTS)(ctx) },
  { id: 'S3-bodies', criteria: ['S3'], title: '请求/响应内容', expected: 'order POST/响应体、status 200、businessCode 0、timing.totalMs；products/detail/checkout/list 体可读', body: (ctx) => probeS3(CHAIN_FACTS)(ctx) },
  { id: 'S4-correlation', criteria: ['S4'], title: '跨请求关联', expected: 'x-shop-trace→hash、sameGroup ≥5、导出无原值', body: (ctx) => probeS4(CHAIN_FACTS)(ctx) },
  { id: 'S5-objects', criteria: ['S5'], title: '业务对象', expected: 'orderId/productId/runId 提取 + orderId propagation ≥1', body: (ctx) => probeS5(CHAIN_FACTS)(ctx) },
  { id: 'S6-polling', criteria: ['S6'], title: '轮询/异步', expected: '3 次 status 被识别为 polling，页面仍可用', body: (ctx) => probeS6(CHAIN_FACTS)(ctx) },
  { id: 'S7-navigation', criteria: ['S7'], title: '页面状态/导航', expected: '5 条 state mark + SPA pushState 边界如实记录', body: (ctx) => probeS7(CHAIN_FACTS)(ctx) },
  { id: 'S8-screenshot', criteria: ['S8'], title: '截图↔网络', expected: 'capture.networkWindow 覆盖阶段事件', body: (ctx) => probeS8(CHAIN_FACTS)(ctx) },
  { id: 'S9-evidence', criteria: ['S9'], title: '证据导出', expected: '相对路径/0600/事件数/5 阶段 URL/无凭据原值', body: (ctx) => probeS9(CHAIN_FACTS)(ctx) },
  { id: 'S10-integrity', criteria: ['S10'], title: '完整性', expected: 'complete:true 且 dropped/evicted/truncated=0', body: (ctx) => probeS10(CHAIN_FACTS)(ctx) },
  { id: 'S11-legacy', criteria: ['S11'], title: '旧能力不回归', expected: 'browser_network 元数据 + events 过滤正确', body: (ctx) => probeS11(CHAIN_FACTS)(ctx) },
  { id: 'S12-report', criteria: ['S12'], title: '报告', expected: 'run-report.json + run.log + chain-report.md（阶段表 + 总计）', body: (ctx) => probeS12(CHAIN_FACTS)(ctx) },
);

export { report, CRITERIA };

let exitCode = 0;
try {
  exitCode = await main();
} catch (error) {
  log(`\n[fatal] ${errorMessage(error)}`);
  console.error(error);
  report.fatal = { name: error?.name, message: errorMessage(error), stack: String(error?.stack || '').split('\n').slice(0, 12) };
  try { report.criteria = buildCriteriaReport(); } catch { /* ignore */ }
  try { await cleanupResources('fatal-error'); } catch { /* ignore */ }
  try {
    await mkdir(EVIDENCE_DIR, { recursive: true });
    await writeFile(join(EVIDENCE_DIR, 'run-report.json'), JSON.stringify(report, null, 2));
    await writeFile(join(EVIDENCE_DIR, 'run.log'), logLines.join('\n') + '\n');
  } catch { /* ignore */ }
  exitCode = 2;
}
process.exitCode = exitCode;
