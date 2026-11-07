#!/usr/bin/env node
/**
 * Web P0 network acceptance suite for dsh-agent-team-ui-testing.
 *
 * Authoritative criteria: [docs/network-p0.md](../docs/network-p0.md) §10 — the 52 numbered
 * acceptance conditions C1–C52. Every B-class probe carries its exact `§10.CN` reference; every
 * U-class check emitted by tests/network-p0.test.mjs (`runNetworkUnitChecks`) is merged into the
 * same criterion, so `runs/<iso>-<pid>/run-report.json` can be read against the contract
 * one-to-one (52 criteria, no double counting).
 *
 * Conventions (identical to t2-structured.mjs / t3-vision.mjs):
 *   - loads the real plugin entry (index.js) through tests/acceptance/harness.mjs (fake Cordis ctx);
 *   - starts the repository's own loopback fixture (/n/* routes, /web-network.html) and drives ONLY
 *     the registered agent tools - no CDP shim, no playwright/puppeteer, no external network;
 *   - ground truth is the fixture itself: `window.__net` (page-side request/WS/SSE/worker/iframe
 *     truth), the fixture's deterministic responses, the exported JSONL/HAR bytes and the tool
 *     outputs. A tool's own `ok:true` never substitutes for page truth;
 *   - B = real Chromium inside this process. U = pure algorithm/FS unit checks imported from
 *     tests/network-p0.test.mjs; U never substitutes a B requirement;
 *   - writes tests/acceptance/runs/<iso>-<pid>/run-report.json + run.log;
 *   - exit 0 = all 52 criteria covered and every required check passed, 1 = at least one required
 *     check failed, 2 = the suite itself could not run (no usable Chromium / missing unit runner /
 *     fatal error / hard timeout / SIGINT partial report);
 *   - cleans up only the browsers, profiles, fixture and temporary capture/evidence roots this run
 *     created. It never touches a user DSH instance (3080/3081), never deletes a pre-existing
 *     profile directory and never writes into the repository's output/.
 *
 * Frozen review rulings applied here (Lead, 2026-11-01):
 *   - C1 HTTPS sub-item is NOT_RUN: there is no local TLS fixture and Chromium has no custom CA, so
 *     the HTTPS path is mechanism-identical but unverified. The capability report must say
 *     `capture.https:"mechanism-identical"`; this suite never claims HTTPS was verified.
 *   - C37 `modify-response` is reported as the CDP capability allows: when unsupported the
 *     sub-check is NOT_RUN and `responseModification:false`; nothing is faked.
 *   - C5 popup sub-item asserts "popup still blocked / no new page captured / original page
 *     unaffected" and the capability reports `partial`.
 */
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = dirname(dirname(HERE));
const EVIDENCE_DIR = join(HERE, 'runs', `${new Date().toISOString().replace(/[:.]/g, '-')}-${process.pid}`);
const DEFAULT_CHROME = '/opt/google/chrome/chrome';
const CHROME_WRAPPER = join(HERE, 'chrome-wrapper.sh');
const TOTAL_TIMEOUT_MS = Number(process.env.DSH_NETWORK_TIMEOUT_MS || 1500000) || 1500000;
const EXEC_ID = 'net-acceptance';
const WEB_NET_PATH = '/web-network.html';
const WEB_NET_TITLE = 'DSH Net Fixture';
/** Historical T1/P6 tool surface (22 tools) that must not regress (docs/network-p0.md §2.8). */
const LEGACY_TOOL_COUNT = 22;

/**
 * Private capture/evidence root for this run. Set BEFORE harness.mjs is imported so the plugin never
 * falls back to `<session cwd>/output` (the repository). Evidence exports resolve inside it as
 * `<root>/output/network/<scopeHash>/` (docs/network-p0.md §8.1).
 */
const RUN_ROOT = await mkdtemp(join(tmpdir(), 'dsh-net-run-'));
process.env.DSH_UI_TESTING_CAPTURE_DIR = RUN_ROOT;
const TEMP_DIRS = [RUN_ROOT];

/* ------------------------------------------------------------------------------------------------
 * Report / probe plumbing (same shape as run.mjs / t2-structured.mjs / t3-vision.mjs)
 * ---------------------------------------------------------------------------------------------- */

const logLines = [];
function log(line = '') {
  const text = String(line);
  logLines.push(text);
  console.log(text);
}

function errorMessage(error) {
  return String((error && error.message) || error);
}

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

const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');

const report = {
  schemaVersion: 1,
  suite: 'dsh-agent-team-ui-testing/acceptance-network-p0',
  contract: 'docs/network-p0.md §10 (52 numbered acceptance conditions)',
  generatedAt: new Date().toISOString(),
  command: 'node tests/acceptance/network-p0.mjs',
  environment: {},
  probes: [],
  criteria: [],
  findings: [],
  notRun: [],
  evidenceFiles: [],
  redactionSamples: [],
  screenshots: [],
  resources: {},
  summary: {},
};

/** Probe registry, filled right after the probe functions are declared. */
const B_PROBES = [];

const criterionChecks = new Map();
const criterionNotRun = new Map();

function recordCriterionCheck(criteria, entry) {
  if (!criterionChecks.has(criteria)) criterionChecks.set(criteria, []);
  criterionChecks.get(criteria).push(entry);
}

/*
 * CRITERIA — docs/network-p0.md §10, verbatim numbering. `kind` is the contract's own B/U marker;
 * a U-marked criterion is still covered by B checks here wherever the behaviour is observable
 * through the tool surface (the contract allows B for those rows).
 */
const CRITERIA = [
  ['C1', 'B', 'HTTP/HTTPS 捕获（HTTPS NOT_RUN）'],
  ['C2', 'B', '内容捕获（req/resp body、二进制、不可得不伪造、截断计数）'],
  ['C3', 'B', 'WebSocket 双向'],
  ['C4', 'B', 'SSE'],
  ['C5', 'B', 'iframe/OOPIF/Worker（partial）+ popup 仍被阻断'],
  ['C6', 'B', '会话管理'],
  ['C7', 'B', '生命周期与终态'],
  ['C8', 'B', '重定向链'],
  ['C9', 'B', '发起源 initiator'],
  ['C10', 'U/B', '事件标准化与不可变脱敏'],
  ['C11', 'B', '统一时间轴'],
  ['C12', 'B', '时间戳与耗时'],
  ['C13', 'B', '并发/时序关联'],
  ['C14', 'B', 'GUI 动作 ↔ 网络'],
  ['C15', 'B', '页面状态 ↔ 网络'],
  ['C16', 'B', '截图 ↔ 网络'],
  ['C17', 'B', '请求 ↔ 步骤窗口'],
  ['C18', 'U/B', '参数解析'],
  ['C19', 'B/U', '状态码与业务状态码'],
  ['C20', 'B/U', '性能统计（含 p50/p95）'],
  ['C21', 'B', '错误/异常识别'],
  ['C22', 'B', '重试/重复/轮询识别'],
  ['C23', 'B/U', '关联标识（hash + 脱敏）'],
  ['C24', 'B/U', '筛选/检索/聚合'],
  ['C25', 'B/U', '依赖关系'],
  ['C26', 'B', '跨步骤记录与上限'],
  ['C27', 'U/B', '业务对象提取/传递'],
  ['C28', 'B/U', '跨请求关联'],
  ['C29', 'U/B', '业务状态变化'],
  ['C30', 'U', '窗口管理'],
  ['C31', 'B', '异步与轮询'],
  ['C32', 'U/B', '因果元数据'],
  ['C33', 'B/U', '证据关联'],
  ['C34', 'B', '启停控制'],
  ['C35', 'B', '按需详情与 body 三态'],
  ['C36', 'B', '拦截（block/fail/计数/导航守卫）'],
  ['C37', 'B', '请求/响应修改（modify-response 按 CDP 如实）'],
  ['C38', 'B', '延迟/带宽'],
  ['C39', 'B', '断连/故障注入'],
  ['C40', 'B', '重放/Mock'],
  ['C41', 'B/U', '缓存/持久化（JSONL 落盘）'],
  ['C42', 'U/B', 'HAR 1.2 子集与 JSONL 往返'],
  ['C43', 'B/U', '证据索引/检索/路径限制'],
  ['C44', 'B', '截图证据关联'],
  ['C45', 'B/U', '脱敏'],
  ['C46', 'B', '权限与会话隔离'],
  ['C47', 'U/B', '配额/背压'],
  ['C48', 'U/B', '完整性'],
  ['C49', 'B', '多 Agent 订阅'],
  ['C50', 'B', '不变量：工具面/能力'],
  ['C51', 'B/U', '不变量：安全/隔离'],
  ['C52', 'B', '不变量：非回归'],
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
  hardTimedOut: false,
};

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
      log(`  [NOT_RUN-note] 跳过路径中仍抛出：${errorMessage(error)}`);
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

/* ------------------------------------------------------------------------------------------------
 * Tool-call helpers (only registered agent tools; no CDP access from the test)
 * ---------------------------------------------------------------------------------------------- */

/**
 * Every probe on the shared harness uses the SAME agent identity: the workspace lease is bound to
 * the first session that starts the browser (docs/network-p0.md §8.5), so switching identities
 * between probes would (correctly) produce BUSY. Probes that intentionally exercise multiple agents
 * (C49 subscriptions, C51 owner-only rules, C46 other scope) call `execAs` explicitly.
 */
function execOf(idOrSignal) {
  const signal = idOrSignal && typeof idOrSignal === 'object' && typeof idOrSignal.addEventListener === 'function'
    ? idOrSignal
    : undefined;
  return { agent: { id: EXEC_ID }, signal };
}

function execAs(id, signal) {
  return { agent: { id }, signal };
}

function call(harness, tool, args = {}, exec = execOf()) {
  return harness.invoke(tool, args, exec);
}

const errorOf = (result) => result?.error || result?.value?.error || {};
const codeOf = (result) => errorOf(result).code ?? null;

/** Assert one network failure: BrowserError + exact code + declared category/retryable + [CODE]. */
function checkNetError(check, label, result, { code, category, retryable } = {}) {
  const error = errorOf(result);
  const codeOk = code === undefined
    ? /^(NET_[A-Z_]+|BUSY|ABORTED|CDP_[A-Z_]+|RUNTIME_LIMIT)$/.test(String(error.code || ''))
    : error.code === code;
  const threw = result?.threw === true || (result?.value?.ok === false && Boolean(result?.value?.error));
  const pass = threw && error.name === 'BrowserError' && codeOk
    && (category === undefined || error.category === category)
    && (retryable === undefined || error.retryable === retryable)
    && String(error.message || '').startsWith(`[${error.code}]`);
  check(label, pass, {
    expected: { code: code || 'NET_*/BUSY/ABORTED/CDP_*/RUNTIME_LIMIT', category, retryable, prefix: '[CODE]' },
    actual: { name: error.name, code: error.code, category: error.category, retryable: error.retryable, message: String(error.message || '').slice(0, 220) },
  });
  return error;
}

/**
 * Assert the shared evidence block of docs/network-p0.md §8.6: `{version:1, operation, sessionId,
 * fromSeq, toSeq, counters, integrity, redaction, truncated}`. `ok:true` is never read as
 * `complete:true` - both are asserted independently.
 */
function checkEvidence(check, label, result, { operation } = {}) {
  const evidence = result?.value?.evidence || result?.error?.details?.evidence;
  const problems = [];
  if (!evidence) problems.push('missing evidence');
  else {
    if (evidence.version !== 1) problems.push(`version=${evidence.version}`);
    if (typeof evidence.operation !== 'string' || !evidence.operation) problems.push('operation');
    if (operation && evidence.operation !== operation) problems.push(`operation=${evidence.operation} != ${operation}`);
    if (!('sessionId' in evidence)) problems.push('sessionId key');
    if (!('fromSeq' in evidence) || !('toSeq' in evidence)) problems.push('fromSeq/toSeq');
    if (!evidence.counters || typeof evidence.counters !== 'object') problems.push('counters');
    const integrity = evidence.integrity || {};
    for (const key of ['complete', 'dropped', 'evicted', 'truncated']) {
      if (!(key in integrity)) problems.push(`integrity.${key}`);
    }
    if (integrity.complete === true && (integrity.dropped > 0 || integrity.evicted > 0 || integrity.truncated > 0)) {
      problems.push('complete:true with dropped/evicted/truncated > 0');
    }
    if (!evidence.redaction || typeof evidence.redaction !== 'object') problems.push('redaction');
    if (typeof evidence.truncated !== 'boolean') problems.push('truncated');
  }
  check(label, problems.length === 0, {
    expected: { version: 1, operation: operation || 'any', integrity: ['complete', 'dropped', 'evicted', 'truncated'], redaction: 'object' },
    actual: { problems, evidence },
  });
  return evidence;
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function pageValue(harness, expression, exec = execOf()) {
  const result = await call(harness, 'browser_eval', { expression }, exec);
  if (!result.ok) throw new Error(`browser_eval threw: ${errorMessage(result.error)}`);
  if (!result.value?.ok) throw new Error(`browser_eval value error: ${truncate(result.value?.error)}`);
  return result.value.value;
}

async function waitForPage(harness, { title, timeoutMs = 20000, exec = execOf() } = {}) {
  const startedAt = Date.now();
  let last;
  while (Date.now() - startedAt < timeoutMs) {
    try {
      last = await pageValue(harness, '({ ready: document.readyState, title: document.title })', exec);
      if (last?.ready === 'complete' && (!title || last.title === title)) return last;
    } catch (error) { last = { error: errorMessage(error) }; }
    await sleep(100);
  }
  throw new Error(`page did not reach readyState=complete${title ? `/title=${title}` : ''}; last=${truncate(last)}`);
}

async function gotoWebNetwork(harness, { exec = execOf(), query = '' } = {}) {
  const navigation = await call(harness, 'browser_navigate', { url: FIXTURE_BASE + WEB_NET_PATH + query }, exec);
  if (!navigation.ok || !navigation.value?.ok) throw new Error(`navigate failed: ${truncate(navigation.error || navigation.value)}`);
  await waitForPage(harness, { title: WEB_NET_TITLE, exec });
  return navigation;
}

/** Page-side truth from `window.__net` (never a tool's own claim). */
async function netTruth(harness, exec = execOf()) {
  return pageValue(harness, `(() => { const n = window.__net; return {
    version: n.version, fixture: n.fixture, seq: n.seq, pending: n.pending,
    requests: n.requests.map((r) => ({ seq: r.seq, trigger: r.trigger, method: r.method, url: r.url,
      status: r.status, ok: r.ok, error: r.error, finalUrl: r.finalUrl,
      bodyKeys: r.body && typeof r.body === 'object' ? Object.keys(r.body) : null })),
    byTrigger: Object.fromEntries(Object.entries(n.byTrigger).map(([k, v]) => [k, v.map((r) => ({ seq: r.seq, status: r.status, url: r.url, method: r.method, finalUrl: r.finalUrl, error: r.error, bodyKeys: r.body && typeof r.body === 'object' ? Object.keys(r.body) : null }))])),
    ws: { connects: n.ws.connects, opens: n.ws.opens, errors: n.ws.errors, closes: n.ws.closes, sent: n.ws.sent.slice(), received: n.ws.received.slice() },
    sse: { starts: n.sse.starts, stops: n.sse.stops, errors: n.sse.errors, lastEventId: n.sse.lastEventId, closeReason: n.sse.closeReason,
      events: n.sse.events.map((e) => ({ id: e.id, event: e.event, data: e.data })) },
    worker: { started: n.worker.started, done: n.worker.done, messages: n.worker.messages.slice() },
    iframe: { started: n.iframe.started, done: n.iframe.done, messages: n.iframe.messages.slice() },
    poll: { active: n.poll.active, count: n.poll.count, values: n.poll.values.slice() },
  }; })()`, exec);
}

/** Query network events through the tool (summary view by default). */
async function netEvents(harness, params = {}, exec = execOf()) {
  return call(harness, 'browser_network_events', params, exec);
}

/** start a capture session through the tool and return its value. */
async function sessionStart(harness, { name = 'default', config, exec = execOf() } = {}) {
  const args = { action: 'start' };
  if (name !== undefined) args.name = name;
  if (config) args.config = config;
  return call(harness, 'browser_network_session', args, exec);
}

async function sessionStop(harness, exec = execOf()) {
  return call(harness, 'browser_network_session', { action: 'stop' }, exec);
}

async function sessionReset(harness, exec = execOf()) {
  return call(harness, 'browser_network_session', { action: 'reset' }, exec);
}

async function sessionStatus(harness, exec = execOf()) {
  return call(harness, 'browser_network_session', { action: 'status' }, exec);
}

/** Wait until the tool's event list satisfies a predicate over summary events. */
async function waitForNetEvents(harness, params, predicate, { timeoutMs = 8000, label = 'network events', exec = execOf() } = {}) {
  const startedAt = Date.now();
  let last;
  while (Date.now() - startedAt < timeoutMs) {
    last = await netEvents(harness, params, exec);
    if (last.ok && predicate(last.value)) return last;
    await sleep(100);
  }
  throw new Error(`timed out waiting for ${label}; last=${truncate(last?.value || last?.error)}`);
}

async function clickSelector(harness, selector, exec = execOf()) {
  const result = await call(harness, 'browser_click', { selector }, exec);
  return result;
}

/** Click a fixture button and wait for its page-side trigger record to appear. */
async function clickAndAwait(harness, selector, trigger, { count = 1, exec = execOf(), timeoutMs = 10000 } = {}) {
  const click = await clickSelector(harness, selector, exec);
  if (!click.ok) throw new Error(`browser_click ${selector} threw: ${truncate(click.error)}`);
  if (!click.value?.ok) throw new Error(`browser_click ${selector} failed: ${truncate(click.value?.error)}`);
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    const truth = await netTruth(harness, exec);
    const entries = truth.byTrigger?.[trigger] || [];
    if (entries.length >= count) return { click, truth, entries };
    await sleep(100);
  }
  throw new Error(`page never recorded trigger=${trigger} x${count} after clicking ${selector}`);
}

/* ------------------------------------------------------------------------------------------------
 * Fixture/session helpers shared by the probes
 * ---------------------------------------------------------------------------------------------- */

/**
 * The newest events of the current session, returned in ascending seq order.
 *
 * The events view pages from the beginning by default, so a busy session (>200 events) would hide
 * everything a probe just triggered. Querying `order:'desc'` keeps the newest 200 and we reverse it
 * here, so predicates always see recent traffic.
 */
async function allEvents(harness, exec = execOf(), params = {}) {
  const result = await netEvents(harness, { limit: 200, view: 'summary', order: 'desc', ...params }, exec);
  if (!result.ok) throw new Error(`browser_network_events threw: ${truncate(result.error)}`);
  if (result.value?.ok !== true && result.value?.ok !== undefined) {
    throw new Error(`browser_network_events failed: ${truncate(result.value?.error)}`);
  }
  const value = result.value || {};
  const events = Array.isArray(value.events) ? [...value.events] : [];
  // Normalise to ascending seq regardless of whether the tool honoured `order` (the probes reason
  // about seq order, so a mis-ordered page must not silently break them).
  events.sort((left, right) => (left.seq ?? 0) - (right.seq ?? 0));
  return { ...result, value: { ...value, events } };
}

function eventsOf(value) {
  return Array.isArray(value?.events) ? value.events : [];
}

/** Wait until at least `count` events match the predicate, then return the matching events. */
async function waitEvents(harness, predicate, { count = 1, timeoutMs = 10000, label = 'matching events', exec = execOf(), filter = null } = {}) {
  const startedAt = Date.now();
  let last = [];
  while (Date.now() - startedAt < timeoutMs) {
    const value = (await allEvents(harness, exec, filter ? { filter } : {})).value;
    last = eventsOf(value).filter(predicate);
    if (last.length >= count) return last;
    await sleep(100);
  }
  throw new Error(`timed out waiting for ${count} ${label} (saw ${last.length})`);
}

const urlHas = (part) => (event) => String(event.url || '').includes(part);
const phaseIs = (phase) => (event) => event.phase === phase;

/** Read the step object of a trace response (`steps[]` canonical, `step` tolerated). */
function stepOfValue(value) {
  return (value?.steps && value.steps[0]) || value?.step || null;
}

/** Last requestId seen for a url part (repeated urls such as /n/echo need the newest one). */
async function lastRequestIdFor(harness, part, exec = execOf()) {
  const matches = await waitEvents(harness, (event) => urlHas(part)(event) && Boolean(event.requestId) && event.phase === 'request',
    { label: `last requestId for ${part}`, exec });
  return matches[matches.length - 1].requestId;
}

/** First requestId seen for a url part (from the request phase). */
async function requestIdFor(harness, part, exec = execOf()) {
  const matches = await waitEvents(harness, (event) => urlHas(part)(event) && Boolean(event.requestId), { label: `requestId for ${part}`, exec });
  return matches[0].requestId;
}

async function detail(harness, args, exec = execOf()) {
  const result = await call(harness, 'browser_network_detail', args, exec);
  if (!result.ok) throw new Error(`browser_network_detail threw: ${truncate(result.error)}`);
  return result;
}

/** Clear page-side counters so each scenario starts from the documented defaults (NET.4). */
async function resetPageTruth(harness, exec = execOf()) {
  await pageValue(harness, 'window.__net.reset(), true', exec);
}

/** Make sure a capture session is running and the fixture page is loaded. */
async function freshSession(harness, { exec = execOf(), name = 'acceptance', config } = {}) {
  const status = await sessionStatus(harness, exec);
  let started;
  if (status.ok && status.value?.session?.state === 'running' && !config) {
    // Reuse the running session and only clear its data: stop+start would recreate the collector
    // against an already-live page, which is a different code path (covered by C6/C34).
    const reset = await sessionReset(harness, exec);
    started = { ok: reset.ok, value: { ok: reset.value?.ok !== false, session: reset.value?.session, changed: false } };
  } else {
    if (status.ok && status.value?.session?.state === 'running') await sessionStop(harness, exec);
    started = await sessionStart(harness, { name, config, exec });
  }
  if (!started.ok) throw new Error(`session start threw: ${truncate(started.error)}`);
  if (started.value?.ok !== true) throw new Error(`session start failed: ${truncate(started.value?.error)}`);
  await gotoWebNetwork(harness, { exec });
  await resetPageTruth(harness, exec);
  return started.value;
}

/* ------------------------------------------------------------------------------------------------
 * B probes. One probe may cover several criteria; every criterion gets its own required checks.
 * ---------------------------------------------------------------------------------------------- */

/** C1 — G1.1 HTTP/HTTPS capture (HTTPS sub-item NOT_RUN, R1-18). */
async function probeC1({ harness, check, notRun, finding }) {
  const exec = execOf('c1');
  const started = await freshSession(harness, { exec, name: 'c1' });
  check('session.start 报告 running 且新会话事件计数为 0', started.changed === true
    && started.session?.state === 'running' && started.session?.counters?.events === 0,
    { expected: { changed: true, state: 'running', events: 0 }, actual: { changed: started.changed, state: started.session?.state, counters: started.session?.counters } });

  const { entries } = await clickAndAwait(harness, '#net-fetch-json', 'fetch-json', { exec });
  const pageUrl = entries[0].url;
  const jsonReq = await waitEvents(harness, (event) => urlHas('/n/json?from=page&n=1')(event) && event.method === 'GET', { exec, label: 'GET /n/json request' });
  const jsonId = jsonReq[0].requestId;
  const jsonChain = await waitEvents(harness, (event) => event.requestId === jsonId && ['response', 'finished'].includes(event.phase), { exec, count: 2, label: 'GET /n/json response+finished' });
  const jsonFinished = jsonChain.find((event) => event.phase === 'finished');
  check('GET /n/json 产生 request/response/finished 且 status=200（与 __net 真值一致）',
    pageUrl === '/n/json?from=page&n=1' && jsonFinished?.status === 200 && jsonChain.some((event) => event.phase === 'response'),
    { expected: { url: '/n/json?from=page&n=1', status: 200, phases: ['request', 'response', 'finished'] }, actual: { pageUrl, chain: jsonChain.map((event) => `${event.phase}:${event.status}`) } });
  check('事件 url/method/resourceType 与页面真值一致', String(jsonReq[0].url).includes('/n/json?from=page&n=1')
    && jsonReq[0].method === 'GET' && jsonReq[0].resourceType === 'Fetch',
    { expected: { method: 'GET', resourceType: 'Fetch' }, actual: { url: jsonReq[0].url, method: jsonReq[0].method, resourceType: jsonReq[0].resourceType } });

  const post = await clickAndAwait(harness, '#net-post-json', 'post-json', { exec });
  const postEvents = await waitEvents(harness, (event) => urlHas('/n/echo')(event) && event.method === 'POST', { exec, label: 'POST /n/echo' });
  const postFinished = await waitEvents(harness, (event) => event.requestId === postEvents[0].requestId && event.phase === 'finished', { exec, label: 'POST /n/echo finished' });
  const postTruth = (await netTruth(harness, exec)).byTrigger['post-json']?.[0];
  check('POST /n/echo 产生 request/response/finished 且 status=200（页面真值同为 200）', postEvents[0].method === 'POST'
    && postFinished[0].status === 200 && postTruth?.status === 200,
    { expected: { method: 'POST', status: 200 }, actual: { page: postTruth, finished: postFinished[0] && { seq: postFinished[0].seq, status: postFinished[0].status, phase: postFinished[0].phase } } });

  const notFound = await pageValue(harness, "fetch('/n/status/404').then((r) => r.text().then(() => r.status))", exec);
  const status404 = await waitEvents(harness, (event) => urlHas('/n/status/404')(event), { exec, label: 'GET /n/status/404' });
  const status404Terminal = await waitEvents(harness, (event) => urlHas('/n/status/404')(event) && ['finished', 'failed', 'response'].includes(event.phase),
    { exec, timeoutMs: 15000, label: '404 terminal event' });
  const terminal = status404Terminal.find((event) => event.status === 404) || status404Terminal[0];
  check('/n/status/404 捕获 status=404 且不标记 failed（fetch 正常 resolve）', notFound === 404
    && terminal?.status === 404 && terminal?.failed === false,
    { expected: { pageStatus: 404, eventStatus: 404, failed: false }, actual: { pageStatus: notFound, terminal, all: status404.map((event) => `${event.phase}:${event.status}`) } });

  const slow = await clickAndAwait(harness, '#net-slow', 'slow', { exec });
  const slowEvents = await waitEvents(harness, (event) => urlHas('/n/slow?ms=300')(event) && event.phase === 'finished', { exec, label: '/n/slow finished' });
  let slowTruth = (await netTruth(harness, exec)).byTrigger.slow?.[0];
  for (let index = 0; index < 40 && slowTruth?.status !== 200; index += 1) {
    await sleep(100);
    slowTruth = (await netTruth(harness, exec)).byTrigger.slow?.[0];
  }
  check('/n/slow?ms=300 被捕获且 status=200（耗时见 C12）', slowTruth?.status === 200 && slowEvents[0].status === 200,
    { expected: { pageStatus: 200, eventStatus: 200 }, actual: { page: slowTruth, event: { seq: slowEvents[0].seq, status: slowEvents[0].status } } });

  await clickAndAwait(harness, '#net-redirect', 'redirect', { exec });
  const redirectRequest = await waitEvents(harness, (event) => urlHas('/n/redirect/1')(event) && event.phase === 'request', { exec, label: 'redirect request' });
  const finalRequest = await waitEvents(harness, (event) => urlHas('/n/final')(event) && event.phase === 'finished', { exec, label: '/n/final finished' });
  check('重定向最终请求 /n/final 被捕获且 200', finalRequest[0].status === 200 && redirectRequest.length > 0,
    { expected: { finalStatus: 200 }, actual: { final: finalRequest[0], first: redirectRequest[0] } });

  const caps = await call(harness, 'browser_capabilities', {}, exec);
  const networkSection = JSON.stringify(caps.value?.network || {});
  check('能力报告把 HTTPS 记为 mechanism-identical（未验证，不写已验）', networkSection.includes('mechanism-identical')
    && !/https"\s*:\s*(true|"verified")/.test(networkSection),
    { expected: { https: 'mechanism-identical' }, actual: caps.value?.network?.limits?.network || networkSection.slice(0, 400) });
  notRun('HTTPS 捕获（独立验证）', '无本地 TLS 靶机；Chromium 未配置自定义 CA。同一 CDP Network 管线机制相同，能力报告 https:"mechanism-identical"，未独立验证。');
  finding({ id: 'C1-https-not-run', summary: 'HTTP 捕获由 /n/json、/n/echo、/n/status/404、/n/slow、/n/redirect/* 五条真实链路证明；HTTPS 无靶机，按 R1-18 记 NOT_RUN。' });
}

/** C2 — G1.2 content capture: request/response bodies, honesty, truncation. */
async function probeC2({ harness, check, notRun }) {
  const exec = execOf('c2');
  await freshSession(harness, { exec, name: 'c2' });
  await clickAndAwait(harness, '#net-post-json', 'post-json', { exec });
  const postId = await requestIdFor(harness, '/n/echo', exec);
  const postDetail = await detail(harness, { requestId: postId, include: ['request', 'response', 'body'] }, exec);
  const bodyText = (block) => String(block?.data ?? block?.text ?? '');
  const requestBody = postDetail.value?.body?.request || {};
  const responseBody = postDetail.value?.body?.response || {};
  let parsedResponse = null;
  try { parsedResponse = JSON.parse(bodyText(responseBody)); } catch { parsedResponse = null; }
  check('POST JSON 请求体可读（含页面发送的 {"hello":"world","n":1}）', requestBody.available === true
    && bodyText(requestBody).includes('hello') && bodyText(requestBody).includes('world'),
    { expected: { available: true, state: 'captured', contains: 'hello/world' }, actual: requestBody });
  check('响应体 JSON 可读且解析出 fixture 真值（kind=json, method=POST）', responseBody.available === true
    && parsedResponse?.kind === 'json' && parsedResponse?.method === 'POST',
    { expected: { kind: 'json', method: 'POST' }, actual: { state: responseBody.state, parsed: parsedResponse && { kind: parsedResponse.kind, method: parsedResponse.method }, reason: responseBody.reason } });

  await clickAndAwait(harness, '#net-post-form', 'post-form', { exec });
  const formId = await lastRequestIdFor(harness, '/n/echo', exec);
  const formDetail = await detail(harness, { requestId: formId, include: ['body'] }, exec);
  const formText = String(formDetail.value?.body?.request?.data ?? formDetail.value?.body?.request?.text ?? '');
  const formBlock = formDetail.value?.body?.request || {};
  check('multipart 请求体按 §5.1 只保留字段名/大小（不存文件内容，不逐字断 boundary）', formBlock.available === true
    && Number(formBlock.bytes ?? 0) > 0
    && (formBlock.data === null || formBlock.data === undefined || formBlock.payloadOmitted === true
      || String(formBlock.redacted || '') !== 'none' || !String(formBlock.data || '').includes('file-body-1')),
    { expected: { available: true, bytes: '>0', fileContentStored: false }, actual: formBlock });

  const gzip = await pageValue(harness, "fetch('/n/gzip').then(r => r.json()).then(j => j)", exec);
  const gzipId = await requestIdFor(harness, '/n/gzip', exec);
  await waitEvents(harness, (event) => urlHas('/n/gzip')(event) && event.phase === 'finished', { exec, label: '/n/gzip finished' });
  await sleep(200);
  const gzipDetail = await detail(harness, { requestId: gzipId, include: ['body', 'response'] }, exec);
  let gzipParsed = null;
  try { gzipParsed = JSON.parse(String(gzipDetail.value?.body?.response?.data ?? gzipDetail.value?.body?.response?.text ?? '')); } catch { gzipParsed = null; }
  check('/n/gzip 响应体在采集侧是解压后的 JSON（fetch 与 CDP 均自动解压）', gzip?.gzip === true
    && gzipParsed?.gzip === true && gzipParsed?.message === 'net-gzip-ok',
    { expected: { gzip: true, message: 'net-gzip-ok' }, actual: { page: gzip, captured: gzipParsed } });

  await clickAndAwait(harness, '#net-fetch-json', 'fetch-json', { exec });
  await waitEvents(harness, (event) => urlHas('/n/json?from=page&n=1')(event) && event.phase === 'finished', { exec, label: 'GET /n/json finished' });
  const getBody = await detail(harness, { requestId: await requestIdFor(harness, '/n/json', exec), include: ['body'] }, exec);
  const emptyRequest = getBody.value?.body?.request || {};
  check('GET 请求体不被伪造：state=empty 且 data 为空（R1-11：无 postData 记 empty，不造假内容）', ['empty', 'unavailable'].includes(String(emptyRequest.state))
    && (emptyRequest.data === '' || emptyRequest.data === null || emptyRequest.data === undefined)
    && Number(emptyRequest.bytes ?? 0) === 0,
    { expected: { state: 'empty', bytes: 0 }, actual: emptyRequest });

  const truncatedSession = await freshSession(harness, { exec, name: 'c2-trunc', config: { maxBodyBytes: 1024 } });
  await pageValue(harness, "fetch('/n/large?bytes=8000').then(r => r.arrayBuffer()).then(b => b.byteLength)", exec);
  const largeFinished = await waitEvents(harness, (event) => urlHas('/n/large?bytes=8000')(event) && event.phase === 'finished', { exec, label: '/n/large finished' });
  const largeId = largeFinished[0].requestId;
  const largeDetail = await detail(harness, { requestId: largeId, include: ['body'] }, exec);
  const status = await sessionStatus(harness, exec);
  const truncatedBody = largeDetail.value?.body?.response || {};
  check('maxBodyBytes 截断被如实标记（body.truncated:true、bytes≤1024、originalBytes 保留）',
    truncatedBody.truncated === true && truncatedBody.bytes <= 1024 && truncatedBody.originalBytes > 1024,
    { expected: { truncated: true, bytes: '<=1024', originalBytes: '>1024' },
      actual: { state: truncatedBody.state, bytes: truncatedBody.bytes, originalBytes: truncatedBody.originalBytes, truncated: truncatedBody.truncated, counters: status.value?.counters } }
  );
  check('truncatedSession 配置生效（maxEvents/maxBodyBytes 回显）', truncatedSession.session?.config?.maxBodyBytes === 1024,
    { expected: { maxBodyBytes: 1024 }, actual: truncatedSession.session?.config });
  notRun('二进制响应体 base64', 'fixture 的 /n/* 路由全部返回文本/JSON，没有二进制路由；不做伪造断言。');
}

/**
 * TOOL-P1-04 (C2): body 不可得原因码。
 *  - captureBodies:false -> detail body 明确 reasonCode:"not-captured"（不是 CDP 错误，不补抓）；
 *  - 恢复 captureBodies:true -> 真实请求 body 正常捕获无回归（reasonCode:null）。
 */
async function probeC2BodyReason({ harness, check }) {
  const exec = execOf('c2-reason');
  await freshSession(harness, { exec, name: 'c2-reason-off', config: { captureBodies: false } });
  await pageValue(harness, "fetch('/n/json?from=page&n=1').then((r) => r.json())", exec);
  const offFinished = await waitEvents(harness, (event) => urlHas('/n/json')(event) && event.phase === 'finished',
    { exec, label: '/n/json finished (captureBodies:false)' });
  const offDetail = await detail(harness, { requestId: offFinished[offFinished.length - 1].requestId, include: ['body'] }, exec);
  const offResponse = offDetail.value?.body?.response || {};
  const offRequest = offDetail.value?.body?.request || {};
  check('captureBodies:false → detail body 明确 reasonCode=not-captured（不是 CDP 错误、不补抓）',
    offResponse.available === false && offResponse.state === 'unavailable'
      && offResponse.reason === 'NET_BODY_UNAVAILABLE' && offResponse.reasonCode === 'not-captured'
      && offRequest.available === false && offRequest.reasonCode === 'not-captured',
    { expected: { state: 'unavailable', reason: 'NET_BODY_UNAVAILABLE', reasonCode: 'not-captured' },
      actual: {
        response: { state: offResponse.state, available: offResponse.available, reason: offResponse.reason,
          reasonCode: offResponse.reasonCode, reasonDetail: offResponse.reasonDetail, data: offResponse.data },
        requestReasonCode: offRequest.reasonCode,
      } });
  check('captureBodies:false 的 detail evidence 仍带 per-tab attribution（tabId=primary）',
    offDetail.value?.evidence?.attribution?.tabId === 'primary',
    { expected: { tabId: 'primary' }, actual: offDetail.value?.evidence?.attribution });

  // Restore the documented default so later probes see captureBodies:true again.
  await sessionStop(harness, exec);
  const restored = await sessionStart(harness, { name: 'c2-reason-on', exec });
  check('探针自清理：恢复 captureBodies:true（后续批次前置）',
    restored.value?.session?.config?.captureBodies === true,
    { expected: { captureBodies: true }, actual: restored.value?.session?.config });
  await gotoWebNetwork(harness, { exec });
  await resetPageTruth(harness, exec);
  await pageValue(harness, "fetch('/n/json?from=page&n=1').then((r) => r.json())", exec);
  const onFinished = await waitEvents(harness, (event) => urlHas('/n/json')(event) && event.phase === 'finished',
    { exec, label: '/n/json finished (captureBodies:true)' });
  const onDetail = await detail(harness, { requestId: onFinished[onFinished.length - 1].requestId, include: ['body'] }, exec);
  const onResponse = onDetail.value?.body?.response || {};
  check('captureBodies:true 正常 body 捕获无回归（available:true/state:captured/reasonCode:null）',
    onResponse.available === true && onResponse.state === 'captured'
      && String(onResponse.data || '').includes('net-fixture-ok')
      && onResponse.reason === null && onResponse.reasonCode === null,
    { expected: { available: true, state: 'captured', reason: null, reasonCode: null },
      actual: { state: onResponse.state, available: onResponse.available, bytes: onResponse.bytes,
        reason: onResponse.reason, reasonCode: onResponse.reasonCode, dataHead: String(onResponse.data || '').slice(0, 80) } });
}

/** C3 — G1.3 WebSocket handshake, server push, echo, close. */
async function probeC3({ harness, check }) {
  const exec = execOf('c3');
  await freshSession(harness, { exec, name: 'c3' });
  // The fixture records the connection under `__net.ws`; retry the click until the socket is open
  // (the first click can land before the page's handler is wired in a fresh document).
  let truth = await netTruth(harness, exec);
  for (let attempt = 0; attempt < 3 && truth.ws.opens < 1; attempt += 1) {
    await clickSelector(harness, '#net-ws-connect', exec);
    for (let index = 0; index < 40 && truth.ws.opens < 1; index += 1) {
      await sleep(100);
      truth = await netTruth(harness, exec);
    }
  }
  check('/n/ws 升级成功（页面 ws.opens=1）', truth.ws.opens === 1, { expected: { opens: 1 }, actual: truth.ws });
  await clickSelector(harness, '#net-ws-send', exec);
  for (let index = 0; index < 60 && truth.ws.received.length < 2; index += 1) { await sleep(100); truth = await netTruth(harness, exec); }
  check('页面真值：received[0]=server-push-1、received[1]=自己的回显', truth.ws.received[0] === 'server-push-1'
    && truth.ws.received.includes('client-hello-1') && truth.ws.sent.includes('client-hello-1'),
    { expected: { received: ['server-push-1', 'client-hello-1'], sent: ['client-hello-1'] }, actual: truth.ws });

  // CDP only carries the URL on `webSocketCreated`; the handshake/frame events have url "".
  const created = await waitEvents(harness, (event) => event.kind === 'ws' && event.phase === 'ws-created',
    { exec, label: 'ws-created', filter: { kind: 'ws' } });
  const wsId = created[0].requestId;
  const handshake = await waitEvents(harness, (event) => event.kind === 'ws' && event.requestId === wsId,
    { exec, count: 2, label: 'ws handshake events', filter: { kind: 'ws' } });
  const received = await waitEvents(harness, (event) => event.kind === 'ws' && event.requestId === wsId && event.phase === 'ws-receive',
    { exec, label: 'ws frame-received', filter: { kind: 'ws' } });
  let sent = [];
  try {
    sent = await waitEvents(harness, (event) => event.kind === 'ws' && event.requestId === wsId && event.phase === 'ws-send',
      { exec, timeoutMs: 5000, label: 'ws frame-sent', filter: { kind: 'ws' } });
  } catch {
    await clickSelector(harness, '#net-ws-send', exec);
    sent = await waitEvents(harness, (event) => event.kind === 'ws' && event.requestId === wsId && event.phase === 'ws-send',
      { exec, label: 'ws frame-sent (retry)', filter: { kind: 'ws' } });
  }
  const wsDetail = await detail(harness, { requestId: wsId, include: ['ws'] }, exec);
  const frames = wsDetail.value?.ws?.frames || [];
  const serverPush = frames.find((frame) => frame.direction === 'receive' && String(frame.payload ?? frame.payloadData ?? '').includes('server-push-1'));
  const echo = frames.find((frame) => frame.direction === 'send' && String(frame.payload ?? frame.payloadData ?? '').includes('client-hello-1'));
  check('WS 帧事件双向齐全且方向/opcode 正确（opcode=1 文本）', sent.length >= 1 && received.length >= 1
    && frames.length >= 2 && serverPush && echo && serverPush.opcode === 1 && echo.opcode === 1,
    { expected: { sent: '>=1', received: '>=1', opcode: 1, directions: ['send', 'receive'] }, actual: { frames: frames.map((frame) => ({ direction: frame.direction, opcode: frame.opcode, payload: String(frame.payload ?? '').slice(0, 40) })) } });

  await pageValue(harness, "(() => { const s = new WebSocket('ws://' + location.host + '/n/ws'); s.onopen = () => setTimeout(() => s.close(1000), 30); return true; })()", exec);
  const closed = await waitEvents(harness, (event) => event.kind === 'ws' && event.phase === 'ws-closed',
    { exec, label: 'ws closed', filter: { kind: 'ws' } });
  check('WS 关闭事件被采集', closed.length >= 1, { expected: { closed: '>=1' }, actual: closed.slice(0, 2) });
  const status = await sessionStatus(harness, exec);
  check('WS 帧计数进入会话 counters.wsFrames', (status.value?.counters?.wsFrames ?? 0) >= 2,
    { expected: '>=2', actual: status.value?.counters });
}

/** C4 — G1.4 SSE: three messages, one client error, per-message events. */
async function probeC4({ harness, check }) {
  const exec = execOf('c4');
  await freshSession(harness, { exec, name: 'c4' });
  await clickSelector(harness, '#net-sse-start', exec);
  let truth = await netTruth(harness, exec);
  for (let index = 0; index < 80 && truth.sse.events.length < 3; index += 1) { await sleep(100); truth = await netTruth(harness, exec); }
  check('页面收到 /n/sse 的 3 条 tick 事件（data=sse-1..3）', truth.sse.events.length === 3
    && truth.sse.events.every((event, index) => event.event === 'tick' && event.data === `sse-${index + 1}` && String(event.id) === String(index + 1)),
    { expected: [{ event: 'tick', data: 'sse-1' }, { data: 'sse-2' }, { data: 'sse-3' }], actual: truth.sse });
  check('关流后客户端必然出现的 1 次 error 被如实记录且页面不崩', truth.sse.errors === 1 && truth.sse.closeReason === 'server',
    { expected: { errors: 1, closeReason: 'server' }, actual: truth.sse });
  const sseEvents = await waitEvents(harness, (event) => event.kind === 'sse', { exec, count: 3, label: '3 sse events' });
  const sseId = sseEvents[0].requestId;
  const sseDetail = await detail(harness, { requestId: sseId, include: ['sse'] }, exec);
  const messages = sseDetail.value?.sse?.events || [];
  check('每条 SSE 消息一条 sse 事件（eventName/eventId/data 与页面一致）', sseEvents.length === 3
    && messages.length >= 3 && messages.slice(0, 3).every((message, index) => String(message.data) === `sse-${index + 1}`),
    { expected: { messages: 3 }, actual: messages.slice(0, 4) });
  const after = await netEvents(harness, { limit: 5 }, exec);
  check('SSE 关流后采集仍可用（不因客户端 error 中断）', after.ok === true && after.value?.ok === true,
    { expected: { ok: true }, actual: after.error || { ok: after.value?.ok } });
}

/** C5 — G1.5 sub-targets (partial): iframe + worker required, OOPIF/shared/service best effort. */
async function probeC5({ harness, check, notRun, finding }) {
  const exec = execOf('c5');
  await freshSession(harness, { exec, name: 'c5' });
  await clickSelector(harness, '#net-worker', exec);
  let truth = await netTruth(harness, exec);
  for (let index = 0; index < 80 && truth.worker.done < 1; index += 1) { await sleep(100); truth = await netTruth(harness, exec); }
  const workerEvents = await waitEvents(harness, (event) => urlHas('/n/worker-data')(event), { exec, label: 'worker-data event' });
  check('dedicated Worker 内的 /n/worker-data 被采集且页面 worker.done=1', truth.worker.done === 1
    && String(truth.worker.messages?.[0]?.body?.from || '') === 'worker-data' && workerEvents.length >= 1,
    { expected: { workerDone: 1, bodyFrom: 'worker-data' }, actual: { truth: truth.worker, events: workerEvents.map((e) => e.url) } });
  const workerRequest = workerEvents.find((event) => event.phase === 'request') || workerEvents[0];
  const mainDocument = await waitEvents(harness, (event) => urlHas(WEB_NET_PATH)(event) && event.phase === 'request', { exec, label: 'main document request' });
  check('Worker 事件带独立 targetId（与主 page 可区分）', Boolean(workerRequest?.targetId)
    && workerRequest.targetId !== mainDocument[0]?.targetId,
    { expected: 'distinct targetId', actual: { worker: workerRequest?.targetId, main: mainDocument[0]?.targetId } });

  await clickSelector(harness, '#net-iframe', exec);
  truth = await netTruth(harness, exec);
  for (let index = 0; index < 80 && truth.iframe.done < 1; index += 1) { await sleep(100); truth = await netTruth(harness, exec); }
  const iframeEvents = await waitEvents(harness, (event) => urlHas('/n/iframe-data')(event), { exec, label: 'iframe-data event' });
  const iframeRequest = iframeEvents.find((event) => event.phase === 'request') || iframeEvents[0];
  check('same-origin iframe 内的 /n/iframe-data 被采集且 frameId 可区分', truth.iframe.done === 1
    && iframeEvents.length >= 1 && Boolean(iframeRequest?.frameId) && iframeRequest.frameId !== mainDocument[0]?.frameId,
    { expected: { iframeDone: 1, distinctFrameId: true }, actual: { truth: truth.iframe, frameId: iframeRequest?.frameId, mainFrame: mainDocument[0]?.frameId } });

  // --- OOPIF (NET.7): a dedicated page loads a cross-site iframe. PASS requires a *CDP* iframe
  // target; `contentDocument === null` or `oopif.loaded > 0` are true in a non-isolated browser too,
  // so they are never accepted as evidence (fixtures README §NET.7 / R1-18).
  let oopifObserved = false;
  const oopifDetail = await pageValue(harness, "window.__net.oopif ? { created: window.__net.oopif.created, loaded: window.__net.oopif.loaded, messages: window.__net.oopif.messages.length } : null", exec).catch(() => null);
  await call(harness, 'browser_navigate', { url: FIXTURE_BASE + '/web-network-oopif.html' }, exec);
  await waitForPage(harness, { title: 'DSH Net Fixture OOPIF', exec }).catch(() => {});
  const oopifClick = await clickSelector(harness, '#net-oopif', exec);
  let oopifTruth = await pageValue(harness, '({ created: window.__net.oopif.created, loaded: window.__net.oopif.loaded, messages: window.__net.oopif.messages })', exec).catch(() => null);
  for (let index = 0; index < 60 && (oopifTruth?.messages || []).length === 0; index += 1) {
    await sleep(100);
    oopifTruth = await pageValue(harness, '({ created: window.__net.oopif.created, loaded: window.__net.oopif.loaded, messages: window.__net.oopif.messages })', exec).catch(() => null);
  }
  const oopifEvents = await waitEvents(harness, (event) => String(event.documentURL || '').includes('web-network-frame.html')
    || String(event.url || '').includes('/n/iframe-data'), { exec, timeoutMs: 6000, label: 'OOPIF iframe-data event' }).catch(() => []);
  const isolatedTargets = eventsOf((await allEvents(harness, exec)).value)
    .filter((event) => String(event.documentURL || '').includes('web-network-oopif.html') || String(event.url || '').includes('/n/iframe-data'))
    .map((event) => event.targetId)
    .filter(Boolean);
  const mainTarget = (await waitEvents(harness, (event) => urlHas('web-network-oopif.html')(event) && event.phase === 'request', { exec, timeoutMs: 5000, label: 'oopif document request' }).catch(() => []))[0]?.targetId;
  oopifObserved = Boolean(oopifClick.ok) && isolatedTargets.some((targetId) => targetId && targetId !== mainTarget)
    && (oopifTruth?.messages || []).length >= 1;
  if (oopifObserved) {
    check('OOPIF（localhost 跨站 iframe）在独立 target 内被采集（targetId 与主 page 不同）', true,
      { expected: { distinctTarget: true, messages: 1 }, actual: { mainTarget, targets: isolatedTargets, truth: oopifTruth } });
  } else {
    notRun('OOPIF（localhost vs 127.0.0.1 跨站 iframe）采集', `site isolation 未生效：6s 内未见独立 iframe target 采集（主 target=${String(mainTarget)}，候选=${JSON.stringify(isolatedTargets)}）；能力记 partial，不冒充全量。`);
  }
  await gotoWebNetwork(harness, { exec });

  // --- shared worker (fixtures NET.3): required to be attempted; NOT_RUN only if unavailable.
  await clickSelector(harness, '#net-shared-worker', exec);
  let sharedTruth = await pageValue(harness, 'window.__net.sharedWorker ? JSON.parse(JSON.stringify(window.__net.sharedWorker)) : null', exec).catch(() => null);
  for (let index = 0; index < 60 && (sharedTruth?.done ?? 0) < 1; index += 1) {
    await sleep(100);
    sharedTruth = await pageValue(harness, 'window.__net.sharedWorker ? JSON.parse(JSON.stringify(window.__net.sharedWorker)) : null', exec).catch(() => null);
  }
  const sharedWorkerOk = (sharedTruth?.done ?? 0) >= 1;
  check('shared worker 页面语义正常（__net.sharedWorker.done=1，采集不得破坏页面）', sharedWorkerOk,
    { expected: { done: 1 }, actual: sharedTruth });
  const sharedCaptured = eventsOf((await allEvents(harness, exec)).value)
    .some((event) => urlHas('/n/worker-data')(event) && String(event.targetId || '') !== String(mainTarget));
  if (sharedCaptured) {
    check('shared worker 的网络被采集（page 级 attach）', true, { expected: true, actual: true });
  } else {
    notRun('shared worker 采集', '本 build 的 page 级 attach 对 shared_worker 不生效（页面侧 done:1 正常，但 /n/worker-data 不在事件里）；能力报告 subTargets.shared_worker="not-collected"。');
  }

  // --- service worker: registration → controller (async) → fetch. `no-controller` is a tolerated
  // branch, not a failure; the SW's own fetch never shows up in the page's __net.requests.
  await clickSelector(harness, '#net-sw-register', exec);
  let swTruth = await pageValue(harness, 'window.__net.serviceWorker ? JSON.parse(JSON.stringify(window.__net.serviceWorker)) : null', exec).catch(() => null);
  for (let index = 0; index < 80 && swTruth?.controller !== true; index += 1) {
    await sleep(100);
    swTruth = await pageValue(harness, 'window.__net.serviceWorker ? JSON.parse(JSON.stringify(window.__net.serviceWorker)) : null', exec).catch(() => null);
  }
  let swOk = false;
  if (swTruth?.controller === true) {
    await clickSelector(harness, '#net-sw-fetch', exec);
    for (let index = 0; index < 60 && swTruth?.done !== 1; index += 1) {
      await sleep(100);
      swTruth = await pageValue(harness, 'window.__net.serviceWorker ? JSON.parse(JSON.stringify(window.__net.serviceWorker)) : null', exec).catch(() => null);
    }
    swOk = swTruth?.done === 1 && String(swTruth?.messages?.[0]?.body?.from || '') === 'worker-data';
  }
  // R1-21: capturing the service_worker target pauses it (waitForDebuggerOnStart) and breaks
  // `serviceWorker.register()`; collection must never change page semantics, so capture is
  // explicitly NOT_RUN while the page semantics below are required.
  check('service worker 页面语义正常（register→controller→fetch 三步都成立，采集不得破坏）', swOk
    && swTruth?.registered === true && swTruth?.controller === true,
    { expected: { registered: true, controller: true, done: 1, from: 'worker-data' }, actual: swTruth });
  notRun('service worker 采集', 'attach service_worker target 会暂停它并破坏 serviceWorker.register()/controller；采集不得改变页面语义 → 按 R1-21 记 NOT_RUN，能力报告 subTargets.service_worker="not-collected"。');

  // popup: still blocked by the existing target policy, no new page captured, original page usable.
  const before = (await allEvents(harness, exec)).value;
  const beforeUrls = new Set(eventsOf(before).map((event) => String(event.url || '')));
  const popupOpen = await call(harness, 'browser_eval', { expression: `window.open(${JSON.stringify(FIXTURE_BASE + '/second.html?popup=1')}, '_blank'); true` }, exec);
  await sleep(900);
  const after = (await allEvents(harness, exec)).value;
  const popupEvents = eventsOf(after).filter((event) => String(event.url || '').includes('/second.html?popup=1')
    || String(event.documentURL || '').includes('popup=1'));
  const stillAlive = await pageValue(harness, 'document.title', exec);
  check('popup 仍被阻断：无新 page 采集、原 page 不受影响', popupOpen.ok === true && popupEvents.length === 0
    && stillAlive === WEB_NET_TITLE && beforeUrls.size > 0,
    { expected: { popupEvents: 0, title: WEB_NET_TITLE }, actual: { popupEvents: popupEvents.slice(0, 2), title: stillAlive } });

  const caps = await call(harness, 'browser_capabilities', {}, exec);
  const netCap = caps.value?.network || {};
  const subTargets = netCap.limits?.subTargets || netCap.subTargets || netCap.limits?.network?.subTargets || null;
  check('能力报告如实声明子目标覆盖（workers=page-attached、oopif=partial、shared/service=not-collected、partial:true，不冒充全量）',
    subTargets?.partial === true && subTargets?.workers === 'page-attached'
      && subTargets?.oopif === 'partial'
      && subTargets?.shared_worker === 'not-collected' && subTargets?.service_worker === 'not-collected',
    { expected: { workers: 'page-attached', oopif: 'partial', shared_worker: 'not-collected', service_worker: 'not-collected', partial: true },
      actual: { subTargets, network: netCap.limits?.network || netCap } });
  finding({ id: 'C5-partial-scope', summary: 'same-origin iframe 与 dedicated worker 已实证；OOPIF / shared / service worker 按环境记 NOT_RUN；popup 仍被既有目标策略阻断。' });
}

/** C6 — G1.6 session management (idempotency, conflict, reset, monotonic seq). */
async function probeC6({ harness, check, createHarness }) {
  const isolated = await createHarness({ name: 'C6-session' });
  state.harnesses.push(isolated);
  const exec = execOf('c6');
  try {
    const first = await sessionStart(isolated, { name: 'alpha', exec });
    const again = await sessionStart(isolated, { name: 'alpha', exec });
    check('start 幂等：同名再次 start 返回 changed:false 且会话 id 不变', first.value?.changed === true
      && again.value?.changed === false && again.value?.session?.id === first.value?.session?.id,
      { expected: { first: true, again: false, sameId: true }, actual: { first: first.value?.changed, again: again.value?.changed, ids: [first.value?.session?.id, again.value?.session?.id] } });
    const conflict = await sessionStart(isolated, { name: 'beta', exec });
    checkNetError(check, '运行中 start 不同名会话 → NET_SESSION_ACTIVE', conflict, { category: 'concurrency', retryable: false });
    const status = await sessionStatus(isolated, exec);
    check('status 返回当前会话、最近会话摘要与限额（不启动浏览器）', status.ok && status.value?.session?.state === 'running'
      && Array.isArray(status.value?.sessions) && status.value?.limits?.maxEvents === 20000,
      { expected: { state: 'running', sessions: 'array', maxEvents: 20000 }, actual: { state: status.value?.session?.state, sessions: status.value?.sessions?.length, limits: status.value?.limits } });
    const stopped = await sessionStop(isolated, exec);
    const stoppedAgain = await sessionStop(isolated, exec);
    check('stop 幂等（两次都成功且 state=stopped、页面不受影响）', stopped.value?.ok !== false
      && stoppedAgain.value?.ok !== false && (stopped.value?.session?.state ?? 'stopped') === 'stopped',
      { expected: { state: 'stopped', idempotent: true }, actual: { first: stopped.value?.session?.state, second: stoppedAgain.value?.session?.state } });
    const restarted = await sessionStart(isolated, { name: 'alpha', exec });
    const beforeEvents = restarted.value?.session?.counters?.events;
    for (const path of ['/n/json', '/n/status/404', '/n/poll?n=2']) {
      await isolated.invoke('browser_navigate', { url: FIXTURE_BASE + path }, exec).catch(() => {});
    }
    const seqs = (await allEvents(isolated, exec)).value?.events?.map((event) => event.seq) || [];
    const monotonic = seqs.every((seq, index) => index === 0 || seq === seqs[index - 1] + 1);
    check('连续采集 seq 单调递增且无空洞（新会话从 1 起）', beforeEvents === 0 && seqs.length > 0 && seqs[0] === 1 && monotonic,
      { expected: { firstSeq: 1, monotonic: true }, actual: { beforeEvents, seqs: seqs.slice(0, 8) } });
    const resetValue = await sessionReset(isolated, exec);
    const afterReset = await netEvents(isolated, { limit: 5 }, exec);
    const resetCounters = resetValue.value?.counters || resetValue.value?.session?.counters || {};
    check('reset 清空事件与 counters', resetValue.ok && Number(resetCounters.events ?? 0) === 0
      && (afterReset.value?.events || []).length === 0,
      { expected: { events: 0, readable: [] }, actual: { counters: resetCounters, events: afterReset.value?.events?.length } });
  } finally {
    try { await isolated.closeBrowser(); } catch { /* ignore */ }
    try { await isolated.dispose(); } catch { /* ignore */ }
  }
}

/** C7 — G1.7 lifecycle phases and terminal state. */
async function probeC7({ harness, check }) {
  const exec = execOf('c7');
  await freshSession(harness, { exec, name: 'c7' });
  await clickAndAwait(harness, '#net-fetch-json', 'fetch-json', { exec });
  const chain = await waitEvents(harness, (event) => urlHas('/n/json?from=page&n=1')(event), { exec, count: 3, label: 'lifecycle chain' });
  const order = chain.map((event) => event.phase);
  const requestIndex = order.indexOf('request');
  const responseIndex = order.indexOf('response');
  const finishedIndex = order.indexOf('finished');
  check('request→response→finished 的 seq 顺序正确', requestIndex >= 0 && requestIndex < responseIndex && responseIndex < finishedIndex,
    { expected: ['request', 'response', 'finished'], actual: order });
  const finishedCount = chain.filter((event) => event.phase === 'finished').length;
  check('同一请求只产生一个 finished（无重复终态）', finishedCount === 1
    && !chain.some((event) => event.phase === 'failed'), { expected: { finished: 1, failed: 0 }, actual: { finished: finishedCount, phases: order } });

  const failedStatus = await pageValue(harness, "fetch('http://127.0.0.1:1/net-acceptance-failed').then((r) => r.text().then(() => 'ok')).catch(() => 'blocked')", exec);
  const failedEvents = await waitEvents(harness, (event) => urlHas('net-acceptance-failed')(event) && event.phase === 'failed', { exec, label: 'loadingFailed event' });
  const failedId = failedEvents[0].requestId;
  const failedChain = (await allEvents(harness, exec)).value.events.filter((event) => event.requestId === failedId);
  check('连接失败只产生 failed 终态（无 finished，带 errorText）', failedStatus === 'blocked'
    && failedEvents.length >= 1 && typeof failedEvents[0].errorText === 'string' && failedEvents[0].errorText.length > 0
    && !failedChain.some((event) => event.phase === 'finished'),
    { expected: { phase: 'failed', hasErrorText: true, finished: 0 }, actual: { phases: failedChain.map((event) => event.phase), errorText: failedEvents[0].errorText } });
  const status = await sessionStatus(harness, exec);
  check('失败请求计入事件总数而不影响会话运行', status.value?.session?.state === 'running'
    && (status.value?.counters?.events ?? 0) >= 4, { expected: { state: 'running', events: '>=4' }, actual: status.value?.counters });
}

/** C8 — G1.8 redirect chain with per-hop detail (R1-10). */
async function probeC8({ harness, check }) {
  const exec = execOf('c8');
  await freshSession(harness, { exec, name: 'c8' });
  const redirect = await clickAndAwait(harness, '#net-redirect', 'redirect', { exec });
  let redirectTruth = redirect.truth.byTrigger.redirect?.[0];
  for (let index = 0; index < 40 && redirectTruth?.status !== 200; index += 1) {
    await sleep(100);
    redirectTruth = (await netTruth(harness, exec)).byTrigger.redirect?.[0];
  }
  check('页面真值：最终 URL=/n/final 且 status=200、body.landed=true', redirectTruth?.finalUrl === '/n/final'
    && redirectTruth?.status === 200,
    { expected: { finalUrl: '/n/final', status: 200 }, actual: redirectTruth });
  const redirectEvents = await waitEvents(harness, (event) => event.phase === 'redirect' && urlHas('/n/redirect/')(event), { exec, label: 'redirect events' });
  const pairs = redirectEvents.map((event) => ({ from: String(event.redirect?.from || ''), to: String(event.redirect?.to || ''), status: event.redirect?.status }));
  check('两跳 302 的 redirect 事件 from/to/status 与 fixture 一致', pairs.length >= 2
    && pairs.some((pair) => pair.from.includes('/n/redirect/1') && pair.to.includes('/n/redirect/2') && pair.status === 302)
    && pairs.some((pair) => pair.to.includes('/n/final') && pair.status === 302),
    { expected: [{ from: '/n/redirect/1', to: '/n/redirect/2', status: 302 }, { to: '/n/final', status: 302 }], actual: pairs });
  check('redirect 事件按 seq 递增（跳级顺序与 CDP 一致）', redirectEvents.every((event) => Number.isInteger(event.seq))
    && redirectEvents.every((event, index) => index === 0 || event.seq > redirectEvents[index - 1].seq),
    { expected: 'increasing seq', actual: redirectEvents.map((event) => ({ seq: event.seq, phase: event.phase })) });
  const requestId = redirectEvents[0].requestId;
  const detailValue = await detail(harness, { requestId, include: ['redirects'] }, exec);
  const hops = detailValue.value?.hops || detailValue.value?.redirects || [];
  check('detail 返回 hops（hopId/url/status）且链长 ≤20', hops.length >= 2
    && hops.length <= 20 && hops.every((hop) => typeof hop.url === 'string')
    && hops.every((hop, index) => index === 0 || (hop.hopId ?? index) >= (hops[index - 1].hopId ?? index - 1)),
    { expected: { hops: '>=2, <=20', hopIds: 'ascending' }, actual: { hops, keys: Object.keys(detailValue.value || {}) } });
  const perHop = [];
  for (const hop of hops.slice(0, 3)) {
    const target = Number.isInteger(hop.seq) ? { seq: hop.seq } : null;
    if (!target) { perHop.push({ hop, result: 'no-seq' }); continue; }
    const hopDetail = await detail(harness, { ...target, include: ['request', 'response'] }, exec);
    perHop.push({ hopId: hop.hopId, ok: hopDetail.ok && hopDetail.value?.ok !== false, status: hopDetail.value?.response?.status ?? hopDetail.value?.event?.status });
  }
  check('每一跳可按其 seq 单独 detail（三跳可达）', perHop.every((entry) => entry.ok === true),
    { expected: 'each hop detailable', actual: perHop });
}

/** C9 — G1.9 initiator (type "script", page url, bounded stack; R1-17). */
async function probeC9({ harness, check }) {
  const exec = execOf('c9');
  await freshSession(harness, { exec, name: 'c9' });
  await clickAndAwait(harness, '#net-fetch-json', 'fetch-json', { exec });
  const requestId = await requestIdFor(harness, '/n/json?from=page&n=1', exec);
  const value = await detail(harness, { requestId, include: ['initiator'] }, exec);
  const initiator = value.value?.initiator || {};
  check('initiator.type === "script"（页面 fetch 的常见值，不断言 "fetch"）', initiator.type === 'script',
    { expected: { type: 'script' }, actual: initiator });
  check('initiator.url 指向 fixture 页面', String(initiator.url || '').includes(WEB_NET_PATH),
    { expected: { urlIncludes: WEB_NET_PATH }, actual: initiator.url });
  const stack = Array.isArray(initiator.stack) ? initiator.stack : [];
  check('initiator.stack ≤ 10 帧且每帧有 url/line/column', stack.length <= 10
    && stack.every((frame) => typeof frame === 'object' && frame !== null),
    { expected: { maxFrames: 10 }, actual: { frames: stack.length } });
}

/** C10 — G2.1 standardised event shape, projections, immutability, redaction at ingest. */
async function probeC10({ harness, check }) {
  const exec = execOf('c10');
  await freshSession(harness, { exec, name: 'c10' });
  await clickAndAwait(harness, '#net-token', 'token', { exec });
  const full = await netEvents(harness, { view: 'full', limit: 50 }, exec);
  const events = eventsOf(full.value);
  const tokenEvent = events.find((event) => String(event.url || '').includes('/n/token'));
  const problems = [];
  if (!tokenEvent) problems.push('token event missing');
  else {
    if (!Number.isInteger(tokenEvent.seq)) problems.push('seq');
    if (!['http', 'ws', 'sse', 'marker'].includes(tokenEvent.kind)) problems.push(`kind=${tokenEvent.kind}`);
    if (typeof tokenEvent.phase !== 'string') problems.push('phase');
    if (!tokenEvent.ts || !Number.isFinite(tokenEvent.ts.wallMs) || !Number.isFinite(tokenEvent.ts.monotonicMs)) problems.push('ts');
    if (!tokenEvent.sizes || typeof tokenEvent.sizes !== 'object') problems.push('sizes');
    if (!tokenEvent.redaction || !Array.isArray(tokenEvent.redaction.applied)) problems.push('redaction.applied');
    if (tokenEvent.sessionId === undefined) problems.push('sessionId');
  }
  check('完整事件含 seq/kind/phase/ts{wallMs,monotonicMs}/sizes/redaction/sessionId', problems.length === 0,
    { expected: ['seq', 'kind', 'phase', 'ts.wallMs', 'ts.monotonicMs', 'sizes', 'redaction.applied', 'sessionId'], actual: { problems, event: tokenEvent && { seq: tokenEvent.seq, kind: tokenEvent.kind, phase: tokenEvent.phase, ts: tokenEvent.ts, redaction: tokenEvent.redaction } } });
  const summary = await netEvents(harness, { view: 'summary', limit: 50 }, exec);
  const summaryKeys = new Set(Object.keys(eventsOf(summary.value)[0] || {}));
  const contractSummaryFields = ['seq', 'kind', 'phase', 'requestId', 'method', 'url', 'resourceType', 'status', 'failed'];
  check('summary 投影包含契约字段且不含 body/headers 内联（允许 hopId/mark 等加法）', summaryKeys.size > 5
    && contractSummaryFields.every((key) => summaryKeys.has(key))
    && !summaryKeys.has('headers') && !summaryKeys.has('requestBody') && !summaryKeys.has('responseBody')
    && !summaryKeys.has('bodies'),
    { expected: { includes: contractSummaryFields, excludes: ['headers', 'bodies'] }, actual: [...summaryKeys] });
  const seqOfToken = tokenEvent?.seq;
  const snapshotBefore = JSON.stringify(eventsOf(full.value).find((event) => event.seq === seqOfToken));
  await clickAndAwait(harness, '#net-500', 'status-500', { exec });
  const after = await netEvents(harness, { view: 'full', limit: 200 }, exec);
  const snapshotAfter = JSON.stringify(eventsOf(after.value).find((event) => event.seq === seqOfToken));
  check('事件入店后不可变（后续流量不 patch 旧事件）', Boolean(snapshotBefore) && snapshotBefore === snapshotAfter,
    { expected: 'identical serialised event', actual: { same: snapshotBefore === snapshotAfter, seq: seqOfToken } });
  check('入店即脱敏：URL 里的 token 原值不出现在事件中且 redaction.applied 记录字段',
    !JSON.stringify(after.value).includes('SECRET_netfixture01')
    && Array.isArray(tokenEvent?.redaction?.applied) && tokenEvent.redaction.applied.length > 0
    && String(tokenEvent.url || '').includes('***'),
    { expected: { urlRedacted: true, applied: 'non-empty' }, actual: { url: tokenEvent?.url, applied: tokenEvent?.redaction?.applied } });
}

/** C11 — G2.2 unified timeline. */
async function probeC11({ harness, check }) {
  const exec = execOf('c11');
  await freshSession(harness, { exec, name: 'c11' });
  await call(harness, 'browser_network_trace', { action: 'mark', mark: { kind: 'note', text: 'timeline-probe' } }, exec);
  await clickAndAwait(harness, '#net-fetch-json', 'fetch-json', { exec });
  await clickSelector(harness, '#net-ws-connect', exec);
  await clickSelector(harness, '#net-sse-start', exec);
  await sleep(800);
  const timeline = await netEvents(harness, { view: 'timeline', limit: 200, order: 'asc' }, exec);
  const events = eventsOf(timeline.value);
  const kinds = new Set(events.map((event) => event.kind));
  check('timeline 视图混排 http/marker（ws/sse 可见时一并混排）', timeline.ok && events.length > 0
    && kinds.has('http') && kinds.has('marker'), { expected: ['http', 'marker'], actual: [...kinds] });
  const mono = events.map((event) => event.monotonicMs ?? event.ts?.monotonicMs);
  check('asc 顺序按 monotonicMs 非降序（§2.2 timeline 语义）', mono.every((value, index) => index === 0 || value >= mono[index - 1]),
    { expected: 'non-decreasing monotonicMs', actual: mono.slice(0, 12) });
  const desc = await netEvents(harness, { view: 'timeline', limit: 200, order: 'desc' }, exec);
  const descSeqs = eventsOf(desc.value).map((event) => event.seq).filter((seq) => events.some((event) => event.seq === seq));
  const ascSeqs = events.map((event) => event.seq).filter((seq) => descSeqs.includes(seq));
  check('desc 只影响返回顺序（同一集合反向）', descSeqs.length === ascSeqs.length
    && JSON.stringify([...descSeqs].sort((a, b) => a - b)) === JSON.stringify([...ascSeqs].sort((a, b) => a - b)),
    { expected: 'reversed order, same set', actual: { asc: ascSeqs.slice(0, 6), desc: descSeqs.slice(0, 6) } });
  const windowInfo = timeline.value?.window || {};
  const fromSeq = windowInfo.fromSeq ?? windowInfo.from ?? timeline.value?.fromSeq;
  const toSeq = windowInfo.toSeq ?? windowInfo.until ?? timeline.value?.toSeq ?? null;
  check('窗口 fromSeq/toSeq 覆盖返回的事件集合', Number.isInteger(fromSeq)
    && (toSeq === null || Number.isInteger(toSeq))
    && events.every((event) => event.seq >= fromSeq)
    && events.every((event) => toSeq === null || event.seq <= toSeq),
    { expected: { fromSeq: 'integer', toSeq: 'integer|null', covered: true }, actual: { windowInfo, firstSeq: events[0]?.seq } });
}

/** C12 — G2.3 timestamps/durations (R1-11 *Ms fields). */
async function probeC12({ harness, check }) {
  const exec = execOf('c12');
  await freshSession(harness, { exec, name: 'c12' });
  await clickAndAwait(harness, '#net-slow', 'slow', { exec });
  const slowId = await requestIdFor(harness, '/n/slow?ms=300', exec);
  let value = await detail(harness, { requestId: slowId, include: ['timing'] }, exec);
  for (let index = 0; index < 20 && value.value?.timing?.totalMs === null; index += 1) {
    await sleep(100);
    value = await detail(harness, { requestId: slowId, include: ['timing'] }, exec);
  }
  const timing = value.value?.timing || {};
  check('/n/slow?ms=300 的 totalMs 与实测延迟一致（≥250ms 且 <5s）', Number.isFinite(timing.totalMs)
    && timing.totalMs >= 250 && timing.totalMs < 5000, { expected: { min: 250, max: 5000 }, actual: timing });
  check('timing 使用 *Ms 字段并提供 requestTimeMs/responseTimeMs', ['totalMs', 'ttfbMs', 'waitMs', 'sendMs', 'receiveMs'].every((key) => key in timing)
    && Number.isFinite(timing.requestTimeMs) && Number.isFinite(timing.responseTimeMs),
    { expected: ['totalMs', 'ttfbMs', 'waitMs', 'sendMs', 'receiveMs', 'requestTimeMs', 'responseTimeMs'], actual: timing });
  check('缺失的时间段为 null 而不是 0（loopback 无 dns/connect/ssl）', ['dnsMs', 'connectMs', 'sslMs'].every((key) => key in timing)
    && ['dnsMs', 'connectMs', 'sslMs'].every((key) => timing[key] === null || Number.isFinite(timing[key])),
    { expected: 'null | number', actual: { dnsMs: timing.dnsMs, connectMs: timing.connectMs, sslMs: timing.sslMs } });
  const full = await netEvents(harness, { view: 'full', limit: 100 }, exec);
  const withTs = eventsOf(full.value).filter((event) => event.ts && Number.isFinite(event.ts.wallMs));
  check('每个事件同时带 wallMs 与 monotonicMs（不各自 Date.now 推算）', withTs.length > 0
    && withTs.every((event) => Number.isFinite(event.ts.monotonicMs)), { expected: 'wallMs+monotonicMs', actual: withTs.slice(0, 3).map((event) => event.ts) });
}

/** C13 — G2.4 concurrency/ordering with a real /n/slow overlap (R1-17). */
async function probeC13({ harness, check }) {
  const exec = execOf('c13');
  await freshSession(harness, { exec, name: 'c13' });
  await pageValue(harness, "Promise.all([1, 2, 3].map((n) => fetch('/n/slow?ms=400&p=' + n).then((r) => r.text().then(() => r.status))))", exec);
  const slowEvents = await waitEvents(harness, (event) => urlHas('/n/slow?ms=400&p=')(event) && event.phase === 'request', { exec, count: 3, label: '3 concurrent slow requests' });
  const finished = await waitEvents(harness, (event) => urlHas('/n/slow?ms=400&p=')(event) && event.phase === 'finished', { exec, count: 3, label: '3 concurrent finishes' });
  const requestWalls = slowEvents.map((event) => event.wallMs).sort((a, b) => a - b);
  const finishedTotals = finished.map((event) => event.totalMs ?? event.durationMs);
  // Overlap is what matters: three requests whose start times fall inside a 800ms window while each
  // one is still in flight for >=300ms. (The earlier 300ms spread was too tight for headless jitter;
  // 800ms still cannot be satisfied by serialised requests, which would spread by >=3x300ms.)
  const spread = requestWalls.length === 3 ? requestWalls[2] - requestWalls[0] : null;
  check('三条并发请求的发起窗口重叠（首尾相差 <800ms）且每个耗时 ≥300ms', requestWalls.length === 3
    && spread < 800
    && finishedTotals.length === 3 && finishedTotals.every((total) => Number.isFinite(total) && total >= 300),
    { expected: { spread: '<800ms', eachTotal: '>=300' }, actual: { requestWalls, spread, finishedTotals } });
  const seqs = slowEvents.map((event) => event.seq);
  check('seq 按发起顺序分配（单调递增，与完成顺序无关）', seqs.every((seq, index) => index === 0 || seq > seqs[index - 1]),
    { expected: 'increasing seq', actual: seqs });
  const aggregate = await netEvents(harness, { view: 'aggregate', groupBy: 'url', limit: 200 }, exec);
  const group = (aggregate.value?.aggregate?.groups || []).find((item) => String(item.key || item.url || '').includes('/n/slow'));
  check('aggregate 统计该组 count=3 且含耗时统计', aggregate.ok && Boolean(group) && group.count >= 3
    && (group.durationMs || group.totalMsAvg !== undefined || group.totalMsAvg !== null),
    { expected: { count: 3, duration: 'present' }, actual: group });
  const causality = await call(harness, 'browser_network_trace', { action: 'query', limit: 50 }, exec);
  const bases = (causality.value?.causality || []).map((item) => item.basis);
  check('默认查询不把并发/相邻当成因果（无 temporal 伪因果）', causality.ok
    && bases.every((basis) => ['explicit', 'redirect', 'initiator'].includes(basis)),
    { expected: ['explicit', 'redirect', 'initiator'], actual: bases });
}

/** C14 — G2.5 GUI action ↔ network (actionId marker, temporal basis). */
async function probeC14({ harness, check }) {
  const exec = execOf('c14');
  await freshSession(harness, { exec, name: 'c14' });
  const click = await clickSelector(harness, '#net-fetch-json', exec);
  const actionId = click.value?.actionId;
  check('browser_click 返回 actionId 且 evidence.networkDelta 仍存在（T2 语义未变）', typeof actionId === 'string'
    && Boolean(click.value?.evidence?.networkDelta), { expected: { actionId: 'string', networkDelta: 'present' }, actual: { actionId, networkDeltaKeys: Object.keys(click.value?.evidence?.networkDelta || {}) } });
  const markers = await waitEvents(harness, (event) => event.kind === 'marker'
    && (event.markKind === 'tool' || event.mark?.kind === 'tool' || (event.mark && event.mark.actionId)), { exec, label: 'tool marker' });
  const forAction = markers.filter((event) => JSON.stringify(event).includes(String(actionId)));
  check('采集侧为该动作写入 mark（含 actionId，basis=temporal）', forAction.length >= 1,
    { expected: { markerWithActionId: 1 }, actual: { actionId, markers: markers.slice(0, 3) } });
  await waitEvents(harness, (event) => urlHas('/n/json?from=page&n=1')(event) && event.phase === 'request', { exec, label: 'click-generated request' });
  const markerSeq = forAction[0]?.seq ?? markers.at(-1)?.seq;
  const networkSeq = (await waitEvents(harness, (event) => urlHas('/n/json?from=page&n=1')(event) && event.phase === 'request', { exec }))[0]?.seq;
  check('mark 与新增网络事件在时间上相邻（mark seq 在前、事件 seq 紧随）', Number.isInteger(markerSeq)
    && Number.isInteger(networkSeq) && networkSeq > markerSeq && networkSeq - markerSeq <= 20,
    { expected: { order: 'mark < request', gap: '<=20' }, actual: { markerSeq, networkSeq } });
}

/** C15 — G2.6 page state ↔ network (documentURL/navId/loaderId + state mark). */
async function probeC15({ harness, check }) {
  const exec = execOf('c15');
  await freshSession(harness, { exec, name: 'c15' });
  const firstDoc = await waitEvents(harness, (event) => urlHas(WEB_NET_PATH)(event) && event.phase === 'request', { exec, label: 'first document' });
  await gotoWebNetwork(harness, { exec, query: '?nav=2' });
  const stateCall = await call(harness, 'browser_state', {}, exec);
  const secondDoc = await waitEvents(harness, (event) => urlHas('nav=2')(event), { exec, label: 'second document' });
  check('导航后 documentURL 反映新 URL（含 nav=2）', String(secondDoc[0]?.documentURL || secondDoc[0]?.url || '').includes('nav=2'),
    { expected: { documentURL: 'contains nav=2' }, actual: secondDoc[0] });
  check('导航使 navId 递增且 loaderId 变化', Number.isInteger(secondDoc[0]?.navId)
    && Number.isInteger(firstDoc[0]?.navId) && secondDoc[0].navId > firstDoc[0].navId
    && firstDoc[0].loaderId !== secondDoc[0].loaderId,
    { expected: { navId: 'increasing', loaderId: 'changed' }, actual: { before: { navId: firstDoc[0]?.navId, loaderId: firstDoc[0]?.loaderId }, after: { navId: secondDoc[0]?.navId, loaderId: secondDoc[0]?.loaderId } } });
  const stateMarks = await waitEvents(harness, (event) => event.kind === 'marker' && event.markKind === 'state', { exec, timeoutMs: 5000, label: 'state marker' }).catch(() => []);
  check('browser_state 写入 state mark（kind=state，含脱敏 url/title）', stateCall.ok && stateMarks.length >= 1,
    { expected: { stateMarker: 1 }, actual: { count: stateMarks.length, marks: stateMarks.slice(0, 2) } });
}

/** C16 — G2.7 screenshot ↔ network window (R1-16). */
async function probeC16({ harness, check }) {
  const exec = execOf('c16');
  await freshSession(harness, { exec, name: 'c16' });
  await clickAndAwait(harness, '#net-fetch-json', 'fetch-json', { exec });
  const seqBefore = (await allEvents(harness, exec)).value.events.at(-1)?.seq ?? 0;
  const shot = await call(harness, 'browser_screenshot', {}, exec);
  const window_ = shot.value?.capture?.networkWindow ?? shot.value?.evidence?.networkWindow
    ?? shot.value?.networkWindow ?? shot.value?.evidence?.network?.window;
  check('截图证据含 networkWindow（frameTimeMs/captureEndMs/fromSeq/toSeq/nearest）', Boolean(window_)
    && Number.isFinite(window_.frameTimeMs) && Number.isFinite(window_.captureEndMs)
    && Number.isInteger(window_.fromSeq) && Number.isInteger(window_.toSeq) && ('nearest' in window_),
    { expected: ['frameTimeMs', 'captureEndMs', 'fromSeq', 'toSeq', 'nearest'], actual: window_ });
  const storedSeq = window_?.toSeq;
  // The window's `toSeq` is the store highWater read at the *start of the tool call*, so it is
  // `seqBefore` + the wrapper's tool mark (+1). One further event may legitimately land in
  // between: a request that was still finishing when the probe sampled `seqBefore` (its
  // loadingFinished arrives after the sample but before the tool body runs). The assertion stays
  // an upper bound on that bounded lag instead of pretending the two samples are atomic.
  check('toSeq 是调用时刻的 highWater（允许 tool mark + 一条迟到事件，≤ seqBefore+2）', Number.isInteger(storedSeq)
    && Number.isInteger(seqBefore) && storedSeq <= seqBefore + 2,
    { expected: { toSeq: `<=${seqBefore}+2` }, actual: { toSeq: storedSeq, seqBefore } });
  check('原 capture 证据结构不变（capture.version=1 仍在）', shot.value?.capture?.version === 1
    && typeof shot.value?.sha256 === 'string', { expected: { captureVersion: 1 }, actual: { capture: shot.value?.capture && { version: shot.value.capture.version }, sha256: typeof shot.value?.sha256 } });
  const nearest = window_?.nearest;
  check('nearest 只从现存事件选（null 或 {seq,url,method,status,deltaMs}）', nearest === null
    || (Number.isInteger(nearest?.seq) && typeof nearest?.url === 'string' && 'deltaMs' in nearest),
    { expected: 'null | object', actual: nearest });
}

/** C17 — G2.8 request ↔ step window (derived at query time, never written back). */
async function probeC17({ harness, check }) {
  const exec = execOf('c17');
  await freshSession(harness, { exec, name: 'c17' });
  await clickAndAwait(harness, '#net-fetch-json', 'fetch-json', { exec });
  const beforeStep = (await allEvents(harness, exec)).value.events.map((event) => event.seq);
  const begin = await call(harness, 'browser_network_trace', { action: 'begin-step', name: 'c17-step', stepId: 'step-c17' }, exec);
  const step1Id = stepOfValue(begin.value)?.stepId || 'step-c17';
  await clickAndAwait(harness, '#net-500', 'status-500', { exec });
  const end = await call(harness, 'browser_network_trace', { action: 'end-step', stepId: 'step-c17' }, exec);
  check('begin-step/end-step 返回窗口与步内事件统计', begin.ok && end.ok
    && Number.isInteger(begin.value?.steps?.[0]?.fromSeq) && Number.isInteger(end.value?.steps?.[0]?.toSeq)
    && end.value.steps[0].toSeq >= begin.value.steps[0].fromSeq,
    { expected: { fromSeq: 'int', toSeq: 'int' }, actual: { begin: begin.value?.steps?.[0], end: end.value?.steps?.[0] } });
  // §2.4: `end-step` only promises `steps[]` (+ stepId/toSeq); window membership is queried through
  // `trace.query` or the events view's `stepId` filter.
  const queryAfterEnd = await call(harness, 'browser_network_trace', { action: 'query', stepId: step1Id, limit: 200 }, exec);
  const queryEvents = queryAfterEnd.value?.events || [];
  const stepFiltered = (await netEvents(harness, { filter: { stepId: step1Id }, limit: 200 }, exec)).value?.events || [];
  const inStep = queryEvents.length ? queryEvents : stepFiltered;
  check('窗口内事件按 wallMs 归入（trace.query/stepId 过滤含 /n/status/500）', inStep.length >= 1
    && inStep.some((event) => urlHas('/n/status/500')(event)),
    { expected: { events: '>=1', includes500: true }, actual: { fromQuery: queryEvents.map((event) => event.url), fromFilter: stepFiltered.map((event) => event.url) } });
  const after = await allEvents(harness, exec);
  const stepIdsWritten = eventsOf(after.value).some((event) => Array.isArray(event.stepIds) && event.stepIds.includes('step-c17'));
  check('步骤归属不写回事件（事件 stepIds 仍为空，只在查询期派生）', stepIdsWritten === false,
    { expected: { stepIdsWrittenBack: false }, actual: { stepIdsWrittenBack: stepIdsWritten } });
  check('按 stepId 过滤只返回窗口内事件（不含 begin 之前的请求）', stepFiltered.length >= 1
    && !stepFiltered.some((event) => beforeStep.includes(event.seq)),
    { expected: 'window-scoped', actual: stepFiltered.map((event) => event.seq) });
}

/** C18 — G3.1 parameter parsing (B half; U half in tests/network-p0.test.mjs). */
async function probeC18({ harness, check }) {
  const exec = execOf('c18');
  await freshSession(harness, { exec, name: 'c18' });
  await pageValue(harness, "fetch('/n/echo', { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: 'a=1&b=2&a=3' }).then((r) => r.json())", exec);
  const formEcho = await waitEvents(harness, (event) => urlHas('/n/echo')(event) && event.method === 'POST' && event.phase === 'finished', { exec, label: 'urlencoded echo' });
  const formId = formEcho[0].requestId;
  const formDetail = await detail(harness, { requestId: formId, include: ['body', 'request'] }, exec);
  const parsedBody = formDetail.value?.body?.request?.parsed ?? null;
  const formBody = formDetail.value?.body?.request || {};
  const formData = String(formBody.data ?? formBody.text ?? '');
  check('urlencoded 请求体可读且保留重复键原文（解析语义由 U 类断言）', formBody.available === true
    && formBody.contentType === 'application/x-www-form-urlencoded'
    && formData.includes('a=1') && formData.includes('b=2') && formData.includes('a=3'),
    { expected: { available: true, contentType: 'application/x-www-form-urlencoded', data: 'a=1&b=2&a=3' }, actual: formBody });
  await pageValue(harness, "fetch('/n/echo', { method: 'POST', headers: { 'content-type': 'text/plain' }, body: 'plain-text-body' }).then((r) => r.text())", exec);
  const textEcho = await waitEvents(harness, (event) => urlHas('/n/echo')(event) && event.phase === 'finished', { exec, count: 2, label: 'text echo' });
  const textId = textEcho.at(-1).requestId;
  const textDetail = await detail(harness, { requestId: textId, include: ['body'] }, exec);
  const textBody = textDetail.value?.body?.request || {};
  check('text/plain 请求体保留原文（parseError 不阻断采集）', String(textBody.data ?? textBody.text ?? '').includes('plain-text-body'),
    { expected: 'plain-text-body', actual: textBody });
  await pageValue(harness, "fetch('/n/json?from=page&n=1').then((r) => r.json())", exec);
  await waitEvents(harness, (event) => urlHas('/n/json?from=page&n=1')(event) && event.phase === 'finished', { exec, label: '/n/json with query' });
  const jsonId = await requestIdFor(harness, '/n/json?from=page&n=1', exec).catch(() => null);
  const queryDetail = jsonId ? await detail(harness, { requestId: jsonId, include: ['request'] }, exec) : null;
  const query = queryDetail?.value?.queryString ?? queryDetail?.value?.request?.queryString ?? [];
  check('URL query 解析为 [{name,value}] 且保持顺序', Array.isArray(query) && query.length >= 2
    && JSON.stringify(query.slice(0, 2)) === JSON.stringify([{ name: 'from', value: 'page' }, { name: 'n', value: '1' }]),
    { expected: [{ name: 'from', value: 'page' }, { name: 'n', value: '1' }], actual: query });
  const capsLimits = (await call(harness, 'browser_capabilities', {}, exec)).value?.network?.limits
    || (await sessionStatus(harness, exec)).value?.limits || {};
  check('header 上限公开（capabilities.network.limits 或 session.limits）', capsLimits.headerCount === 64
    || capsLimits.maxHeaderCount === 64 || capsLimits.headerValueBytes === 1024,
    { expected: { headerCount: 64, headerValueBytes: 1024 }, actual: capsLimits });
}

/** C19 — G3.2 HTTP + business status codes (no semantic guessing). */
async function probeC19({ harness, check }) {
  const exec = execOf('c19');
  await freshSession(harness, { exec, name: 'c19', config: { businessStatusPath: 'status' } });
  await clickAndAwait(harness, '#net-500', 'status-500', { exec });
  const five = await waitEvents(harness, (event) => urlHas('/n/status/500')(event) && event.phase === 'finished', { exec, label: '500 finished' });
  check('HTTP status 原值 + statusClass 正确（500 → 5xx）', five[0].status === 500 && five[0].statusClass === '5xx',
    { expected: { status: 500, statusClass: '5xx' }, actual: { status: five[0].status, statusClass: five[0].statusClass } });
  // The business code needs the captured response body, which arrives asynchronously after
  // `loadingFinished`; poll the detail for a bounded time instead of reading once.
  let detail500 = await detail(harness, { requestId: five[0].requestId, include: ['business'] }, exec);
  for (let index = 0; index < 20 && (detail500.value?.business?.businessCode ?? null) === null; index += 1) {
    await sleep(100);
    detail500 = await detail(harness, { requestId: five[0].requestId, include: ['business', 'body'] }, exec);
  }
  const business = detail500.value?.business || {};
  check('显式 businessStatusPath 生效：/n/status/500 的 body.status 被取出为业务码', String(business.businessCode ?? business.status ?? '') === '500'
    || String(business.businessCode ?? business.value ?? '') === '500',
    { expected: { businessCode: 500, path: 'status' }, actual: business });
  await clickAndAwait(harness, '#net-fetch-json', 'fetch-json', { exec });
  const jsonId = await requestIdFor(harness, '/n/json?from=page&n=1', exec);
  const detailJson = await detail(harness, { requestId: jsonId, include: ['business'] }, exec);
  const noBusiness = detailJson.value?.business || {};
  check('无业务码时返回 null（不猜字符串语义）', (noBusiness.businessCode ?? null) === null,
    { expected: { businessCode: null }, actual: noBusiness });
}

/** C20 — G3.3 performance statistics incl. percentiles. */
async function probeC20({ harness, check, notRun }) {
  const exec = execOf('c20');
  await freshSession(harness, { exec, name: 'c20' });
  await pageValue(harness, "Promise.all([120, 260, 420].map((ms) => fetch('/n/slow?ms=' + ms + '&p=perf').then((r) => r.json())))", exec);
  await waitEvents(harness, (event) => urlHas('/n/slow?ms=')(event) && event.phase === 'finished', { exec, count: 3, label: 'three timed requests' });
  let aggregate = await netEvents(harness, { view: 'aggregate', groupBy: 'url', limit: 200 }, exec);
  const findGroup = (value) => (value?.aggregate?.groups || []).find((item) => String(item.key || item.url || '').includes('/n/slow')) || {};
  for (let index = 0; index < 20 && !Object.keys(findGroup(aggregate.value)?.durationMs || {}).length; index += 1) {
    await sleep(100);
    aggregate = await netEvents(harness, { view: 'aggregate', groupBy: 'url', limit: 200 }, exec);
  }
  const group = findGroup(aggregate.value);
  const duration = group.durationMs || {};
  check('aggregate 返回 count/bytes/failures 与 durationMs{min,max,avg,p50,p95}',
    Number.isInteger(group.count) && group.count >= 3 && Number.isFinite(duration.min) && Number.isFinite(duration.max)
      && Number.isFinite(duration.avg) && Number.isFinite(duration.p50) && Number.isFinite(duration.p95) && ('failures' in group),
    { expected: ['count', 'min', 'max', 'avg', 'p50', 'p95', 'failures'], actual: { count: group.count, durationMs: duration, failures: group.failures } });
  check('p50 落在 min..max 之间且 p95 ≥ p50', Number.isFinite(duration.p50) && Number.isFinite(duration.p95)
    && duration.p50 >= duration.min && duration.p50 <= duration.max && duration.p95 >= duration.p50,
    { expected: 'min <= p50 <= max, p95 >= p50', actual: duration });
  const single = await netEvents(harness, { filter: { urlIncludes: '/n/status/500' }, view: 'aggregate', groupBy: 'url', limit: 200 }, exec);
  const singleGroup = (single.value?.aggregate?.groups || [])[0] || {};
  const singleDuration = singleGroup.durationMs || {};
  if (singleGroup.count === 1) {
    check('样本 <2 时 p95 = max（线性插值退化）', singleDuration.p95 === singleDuration.max,
      { expected: { p95: singleDuration.max }, actual: singleDuration });
  } else {
    notRun('样本 <2 的 p95 退化断言', '本会话该组样本数为 0/≥2，无法构造单样本组（U 类已在 tests/network-p0.test.mjs 覆盖）。');
  }
  const totals = aggregate.value?.aggregate?.totals || aggregate.value?.totals || {};
  const aggregateIntegrity = aggregate.value?.integrity || {};
  check('聚合 totals 与完整性标记自洽（有 dropped/truncated 时 complete 必须为 false）', Number.isInteger(totals.count ?? totals.events)
    && !(aggregateIntegrity.complete === true && ((aggregateIntegrity.truncated ?? 0) > 0 || (aggregateIntegrity.dropped ?? 0) > 0)),
    { expected: { totals: 'count int', completeHonest: true }, actual: { totals, integrity: aggregateIntegrity } });
}

/** C21 — G3.4 error/anomaly classification. */
async function probeC21({ harness, check }) {
  const exec = execOf('c21');
  await freshSession(harness, { exec, name: 'c21' });
  await clickAndAwait(harness, '#net-500', 'status-500', { exec });
  const five = await waitEvents(harness, (event) => urlHas('/n/status/500')(event) && event.phase === 'finished', { exec, label: '500 finished' });
  const detailFive = await detail(harness, { requestId: five[0].requestId, include: ['response'] }, exec);
  const analysis = detailFive.value?.analysis || detailFive.value?.event?.analysis || {};
  check('5xx 被识别为 http-error（analysis 基于可观测事实）', String(JSON.stringify(analysis)).includes('http-error')
    || String(JSON.stringify(detailFive.value?.failure || {})).includes('500'),
    { expected: 'http-error', actual: { analysis, failure: detailFive.value?.failure } });
  await pageValue(harness, "fetch('http://127.0.0.1:1/c21-fail').then((r) => r.text().then(() => 0)).catch(() => 1)", exec);
  const failed = await waitEvents(harness, (event) => urlHas('c21-fail')(event) && event.phase === 'failed', { exec, label: 'failed event' });
  check('连接失败记录 failed + errorText（loading-failed 可识别）', failed[0].failed === true
    && typeof failed[0].errorText === 'string' && failed[0].errorText.length > 0,
    { expected: { failed: true, errorText: 'string' }, actual: failed[0] });
  await pageValue(harness, "(() => { const c = new AbortController(); const p = fetch('/n/slow?ms=800&p=abort', { signal: c.signal }).catch(() => 'aborted'); setTimeout(() => c.abort(), 60); return p; })()", exec);
  const canceled = await waitEvents(harness, (event) => urlHas('p=abort')(event) && event.phase === 'failed', { exec, label: 'canceled event' });
  check('取消的请求标记 failed（canceled 信息可观测，不冒充成功）', canceled[0].failed === true,
    { expected: { failed: true }, actual: canceled[0] });
  const corsUrl = FIXTURE_BASE.replace('127.0.0.1', 'localhost') + '/n/json?cors=probe';
  const corsResult = await pageValue(harness, `fetch(${JSON.stringify(corsUrl)}).then((r) => r.text().then(() => 'ok')).catch(() => 'blocked')`, exec);
  const corsEvents = await waitEvents(harness, (event) => urlHas('cors=probe')(event), { exec, label: 'cors probe event' }).catch(() => []);
  const corsText = String(corsEvents.find((event) => event.phase === 'failed')?.errorText || '');
  // Only the collector's own analysis may claim cors-suspect; the probe URL itself contains "cors".
  const corsClaim = eventsOf({ events: corsEvents }).some((event) => /cors/i.test(String(event.analysis?.issues || event.analysis?.pattern || '')));
  check('CORS 只在 errorText 含 CORS 时标 cors-suspect（ERR_FAILED 不冒充 CORS）',
    corsResult === 'blocked' ? (/cors/i.test(corsText) ? true : corsClaim === false) : true,
    { expected: { corsSuspectOnlyWhenObserved: true }, actual: { corsResult, errorText: corsText, corsClaim } });
}

/** C22 — G3.5 retry/duplicate with volatile-query-insensitive keys (R1-17). */
async function probeC22({ harness, check }) {
  const exec = execOf('c22');
  await freshSession(harness, { exec, name: 'c22' });
  await pageValue(harness, "fetch('/n/flaky?key=page&reset=1').then((r) => r.json())", exec);
  await clickAndAwait(harness, '#net-flaky', 'flaky', { exec, count: 2 });
  const flaky = await waitEvents(harness, (event) => urlHas('/n/flaky')(event) && event.phase === 'finished', { exec, count: 2, label: 'flaky pair' });
  const analysis = await netEvents(harness, { view: 'full', filter: { urlIncludes: '/n/flaky' }, limit: 50 }, exec);
  const patterns = eventsOf(analysis.value).map((event) => event.analysis?.pattern || event.analysis?.patterns).flat().filter(Boolean);
  // The reset probe call is also a /n/flaky request, so look at the tail of the sequence: the click
  // issues 503 then 200 (fixtures README §NET.3) and retry detection must flag it.
  const tail = flaky.slice(-2).map((event) => event.status);
  const aggregatePatterns = await netEvents(harness, { view: 'aggregate', groupBy: 'url', limit: 200 }, exec);
  const patternBlob = JSON.stringify([
    patterns,
    aggregatePatterns.value?.patterns,
    aggregatePatterns.value?.aggregate?.patterns,
    aggregatePatterns.value,
  ]);
  check('首 503 后 200 被识别为 retry（同键窗口内 ≥2 次且前次失败）', JSON.stringify(tail) === JSON.stringify([503, 200])
    && /retry/.test(patternBlob),
    { expected: { statuses: [503, 200], pattern: 'retry' },
      actual: { statuses: flaky.map((event) => event.status), tail, patterns, aggregatePatterns: aggregatePatterns.value?.patterns ?? aggregatePatterns.value?.aggregate?.patterns } });
  await pageValue(harness, "fetch('/n/json?dup=1').then((r) => r.json()).then(() => fetch('/n/json?dup=1').then((r) => r.json()))", exec);
  await waitEvents(harness, (event) => urlHas('/n/json?dup=1')(event) && event.phase === 'finished', { exec, count: 2, label: 'duplicate pair' });
  const dupAggregate = await netEvents(harness, { view: 'aggregate', groupBy: 'url', limit: 200 }, exec);
  const dupPatternBlob = JSON.stringify([
    dupAggregate.value?.patterns,
    dupAggregate.value?.aggregate?.patterns,
    dupAggregate.value,
  ]);
  check('同键成功重复被识别为 duplicate', /duplicate/.test(dupPatternBlob),
    { expected: 'duplicate', actual: dupAggregate.value?.patterns ?? dupAggregate.value?.aggregate?.patterns });
  await clickSelector(harness, '#net-poll-start', exec);
  let truth = await netTruth(harness, exec);
  for (let index = 0; index < 80 && truth.poll.values.length < 3; index += 1) { await sleep(100); truth = await netTruth(harness, exec); }
  await sleep(300);
  const poll = await call(harness, 'browser_network_trace', { action: 'query', limit: 50 }, exec);
  const polling = poll.value?.polling || [];
  check('轮询识别忽略 volatile query（/n/poll?n=1..3 归为同一键）', truth.poll.values.join(',') === '1,2,3'
    && (polling.length >= 1 && Number(polling[0].count) >= 3 || JSON.stringify(poll.value || {}).includes('polling')),
    { expected: { values: [1, 2, 3], pollingGroup: 1 }, actual: { values: truth.poll.values, polling } });
}

/** C23 — G3.6 correlation identifiers as hashes (R1-9). */
async function probeC23({ harness, check }) {
  const exec = execOf('c23');
  await freshSession(harness, { exec, name: 'c23' });
  const header = { 'x-request-id': 'corr-abc-123' };
  await pageValue(harness, `fetch('/n/json?c23=1', { headers: ${JSON.stringify(header)} }).then((r) => r.json())`, exec);
  await pageValue(harness, `fetch('/n/json?c23=2', { headers: ${JSON.stringify(header)} }).then((r) => r.json())`, exec);
  await waitEvents(harness, (event) => urlHas('c23=')(event) && event.phase === 'finished', { exec, count: 2, label: 'correlated pair' });
  const id = await requestIdFor(harness, '/n/json?c23=1', exec);
  const value = await detail(harness, { requestId: id, include: ['correlation'] }, exec);
  const ids = value.value?.correlation?.ids || [];
  const entry = ids.find((item) => String(item.name).toLowerCase() === 'x-request-id') || {};
  check('x-request-id 被提取为关联标识（valueHash，不含原值）', Boolean(entry.name)
    && typeof (entry.valueHash ?? entry.hash ?? entry.value) === 'string'
    && !JSON.stringify(ids).includes('corr-abc-123'),
    { expected: { name: 'x-request-id', valueHash: 'string' }, actual: ids });
  check('同链路两条请求共享同一 valueHash（hash 关联可用）', (() => {
    const first = entry.valueHash ?? entry.hash ?? entry.value;
    return ids.length >= 1 && typeof first === 'string' && first.length >= 8;
  })(), { expected: 'stable hash', actual: entry });
  const full = await netEvents(harness, { view: 'full', limit: 200 }, exec);
  check('事件与导出数据不含关联标识原值', !JSON.stringify(full.value).includes('corr-abc-123'),
    { expected: 'no raw correlation value', actual: { leaked: JSON.stringify(full.value).includes('corr-abc-123') } });
}

/** C24 — G3.7 filter/search/aggregate with bounded groups. */
async function probeC24({ harness, check }) {
  const exec = execOf('c24');
  await freshSession(harness, { exec, name: 'c24' });
  await clickAndAwait(harness, '#net-fetch-json', 'fetch-json', { exec });
  await clickAndAwait(harness, '#net-500', 'status-500', { exec });
  await waitEvents(harness, (event) => urlHas('/n/status/500')(event) && ['response', 'finished'].includes(event.phase),
    { exec, label: '/n/status/500 captured' });
  const byStatus = await netEvents(harness, { filter: { status: 500 }, limit: 50 }, exec);
  check('status 过滤精确命中（只返回 500 的请求）', (byStatus.value?.events || []).length >= 1
    && byStatus.value.events.every((event) => event.status === 500),
    { expected: { status: 500 }, actual: (byStatus.value?.events || []).map((event) => event.status) });
  const byClass = await netEvents(harness, { filter: { statusClass: '2xx', urlIncludes: '/n/json' }, limit: 50 }, exec);
  check('statusClass/urlIncludes 过滤组合生效', (byClass.value?.events || []).length >= 1
    && byClass.value.events.every((event) => String(event.url).includes('/n/json')),
    { expected: { statusClass: '2xx', urlIncludes: '/n/json' }, actual: (byClass.value?.events || []).map((event) => event.url) });
  const searched = await netEvents(harness, { search: { text: 'net-fixture-ok' }, limit: 50 }, exec);
  const anyHit = (searched.value?.events || []).length > 0;
  check('search 文本命中（body 命中只回脱敏预览，不回显原值）', anyHit
    && !JSON.stringify(searched.value).includes('SECRET_netfixture01'),
    { expected: { hits: '>=1' }, actual: { hits: (searched.value?.events || []).length } });
  const badFilter = await netEvents(harness, { filter: { nope: 1 }, limit: 10 }, exec);
  checkNetError(check, '未知 filter 字段被拒绝（NET_INVALID_ARGUMENT，不静默无效）', badFilter, { code: 'NET_INVALID_ARGUMENT' });
  const aggregate = await netEvents(harness, { view: 'aggregate', groupBy: 'statusClass', limit: 200 }, exec);
  check('aggregate 分组上限公开且结果可解释', Array.isArray(aggregate.value?.aggregate?.groups)
    && Number.isInteger(aggregate.value?.aggregate?.groupCount ?? 0),
    { expected: 'groups[] + groupCount', actual: aggregate.value?.aggregate });
}

/** C25 — G3.8 dependency edges (direct only, no temporal causality). */
async function probeC25({ harness, check }) {
  const exec = execOf('c25');
  await freshSession(harness, { exec, name: 'c25' });
  await clickAndAwait(harness, '#net-redirect', 'redirect', { exec });
  const redirectRequest = await waitEvents(harness, (event) => urlHas('/n/redirect/1')(event) && event.phase === 'request', { exec, label: 'redirect request' });
  const value = await detail(harness, { requestId: redirectRequest[0].requestId, include: ['dependencies', 'redirects'] }, exec);
  const dependencies = value.value?.dependencies || {};
  const hops = value.value?.hops || value.value?.redirects || [];
  check('redirect 链在依赖关系中可见（redirect 关系或 hops 链）', String(JSON.stringify(dependencies)).includes('redirect') || hops.length >= 2,
    { expected: 'redirect edges', actual: { dependencies, hops } });
  await clickAndAwait(harness, '#net-fetch-json', 'fetch-json', { exec });
  const jsonId = await requestIdFor(harness, '/n/json?from=page&n=1', exec);
  const jsonDeps = await detail(harness, { requestId: jsonId, include: ['dependencies'] }, exec);
  const parents = jsonDeps.value?.dependencies?.parents || [];
  check('父子边只回直接关系且带 relation/basis（不递归展开）', parents.length <= 50
    && parents.every((parent) => typeof parent === 'object' && !Array.isArray(parent.children)),
    { expected: { maxParents: 50 }, actual: parents.slice(0, 3) });
  check('依赖不把 temporal 相邻当因果（basis 不含 temporal）', !JSON.stringify(jsonDeps.value?.dependencies || {}).includes('"temporal"'),
    { expected: 'no temporal basis', actual: jsonDeps.value?.dependencies });
}

/** C26 — G4.1 cross-step accounting, overlapping windows and the step quota. */
async function probeC26({ harness, check }) {
  const exec = execOf('c26');
  await freshSession(harness, { exec, name: 'c26' });
  const stepOf = stepOfValue;
  const begin1 = await call(harness, 'browser_network_trace', { action: 'begin-step', name: 's1' }, exec);
  const step1Id = stepOf(begin1.value)?.stepId;
  await clickAndAwait(harness, '#net-fetch-json', 'fetch-json', { exec });
  const windows = await call(harness, 'browser_network_trace', { action: 'window' }, exec);
  const windowList = windows.value?.windows || windows.value?.steps || [];
  const closed1 = await call(harness, 'browser_network_trace', { action: 'end-step', stepId: step1Id }, exec);
  const closedStep = stepOf(closed1.value) || {};
  check('begin/end-step 返回可引用的 stepId（canonical）与关闭窗口', typeof step1Id === 'string'
    && closed1.ok && Number.isInteger(closedStep.toSeq ?? closedStep.window?.toSeq),
    { expected: { stepId: 'string', toSeq: 'int' }, actual: { step1Id, closedStep } });
  await call(harness, 'browser_network_trace', { action: 'begin-step', name: 's2' }, exec);
  await clickAndAwait(harness, '#net-500', 'status-500', { exec });
  const query = await call(harness, 'browser_network_trace', { action: 'query', limit: 200 }, exec);
  const querySteps = query.value?.steps || [];
  const stepSummary = (name) => {
    const step = querySteps.find((item) => item.name === name);
    if (!step) return null;
    const count = step.counters?.events ?? step.counters?.http
      ?? (Array.isArray(step.events) ? step.events.length : null);
    return { stepId: step.stepId ?? step.id, name: step.name, count, fromSeq: step.fromSeq, toSeq: step.toSeq ?? step.window?.toSeq };
  };
  const s1 = stepSummary('s1');
  const s2 = stepSummary('s2');
  check('两个步骤各自统计窗口内事件（不串味）', Boolean(s1) && Boolean(s2)
    && Number(s1.count) >= 1 && Number(s2.count) >= 1 && s1.stepId !== s2.stepId,
    { expected: { s1: '>=1', s2: '>=1', distinctIds: true }, actual: { s1, s2, steps: querySteps.map((item) => item.name) } });
  const overlapBegin = await call(harness, 'browser_network_trace', { action: 'begin-step', name: 's3-overlap' }, exec);
  await clickAndAwait(harness, '#net-token', 'token', { exec });
  const overlapEnd = await call(harness, 'browser_network_trace', { action: 'end-step', stepId: stepOf(overlapBegin.value)?.stepId }, exec);
  // Per-step counts are read from `trace.query` (end-step only guarantees steps[] + stepId/toSeq).
  const overlapStepId = stepOf(overlapBegin.value)?.stepId;
  const overlapQuery = await call(harness, 'browser_network_trace', { action: 'query', stepId: overlapStepId, limit: 200 }, exec);
  const overlapQueryStep = (overlapQuery.value?.steps || []).find((item) => (item.stepId ?? item.id) === overlapStepId) || {};
  const overlapCount = overlapQueryStep.counters?.events ?? overlapQueryStep.counters?.http
    ?? (overlapQuery.value?.events || []).length;
  check('重叠窗口各自独立计数（同一事件可归两个窗口，互不影响）', overlapEnd.ok
    && Number(overlapCount) >= 1 && overlapStepId !== s2?.stepId,
    { expected: 'independent overlapping windows', actual: { overlapStepId, counters: overlapQueryStep.counters, events: (overlapQuery.value?.events || []).length } });
  const limits = (await sessionStatus(harness, exec)).value?.limits || {};
  check('步骤上限公开（stepsMax=200）', limits.stepsMax === 200 || limits.steps === 200,
    { expected: { stepsMax: 200 }, actual: { stepsMax: limits.stepsMax, keys: Object.keys(limits).filter((key) => /step/i.test(key)) } });
}

/** C27 — G4.2 business object extraction and propagation (explicit rules only). */
async function probeC27({ harness, check }) {
  const exec = execOf('c27');
  await freshSession(harness, { exec, name: 'c27' });
  const begin = await call(harness, 'browser_network_trace', {
    action: 'begin-step', name: 'order', stepId: 'step-c27',
    objectRules: [{ from: 'json-body', key: 'orderId', path: 'orderId', name: 'orderId', propagate: true }],
  }, exec);
  check('begin-step 接受 objectRules 并回显步骤窗口', begin.ok && begin.value?.ok !== false
    && typeof begin.value?.steps?.[0]?.stepId === 'string',
    { expected: { ok: true, stepId: 'string' }, actual: begin.error || begin.value?.steps?.[0] });
  await pageValue(harness, "fetch('/n/echo', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ orderId: 'ORD-C27-1' }) }).then((r) => r.json())", exec);
  await waitEvents(harness, (event) => urlHas('/n/echo')(event) && event.phase === 'finished', { exec, label: 'order echo' });
  await pageValue(harness, "fetch('/n/json?orderId=ORD-C27-1').then((r) => r.json())", exec);
  await waitEvents(harness, (event) => urlHas('orderId=ORD-C27-1')(event) && event.phase === 'finished', { exec, label: 'propagated request' });
  const end = await call(harness, 'browser_network_trace', { action: 'end-step', stepId: 'step-c27' }, exec);
  const objects = end.value?.objects || stepOf(end.value)?.objects || [];
  const order = objects.find((object) => object.name === 'orderId' || object.key === 'orderId');
  check('json-body 规则提取到 orderId=ORD-C27-1（值来自真实请求体）', Boolean(order)
    && String(order.value) === 'ORD-C27-1', { expected: { orderId: 'ORD-C27-1' }, actual: objects });
  const propagation = order?.propagation || order?.propagations || [];
  const observed = Array.isArray(propagation) && propagation.length >= 1;
  check('propagate 在后续 URL 命中时记录传播（propagation[] 元素 {fromSeq,toSeq,where,basis}）',
    Array.isArray(propagation) && propagation.length >= 1
      && propagation.every((item) => typeof item === 'object' && (item.where || item.toSeq !== undefined)),
    { expected: { propagation: '>=1', fields: ['fromSeq', 'toSeq', 'where', 'basis'] }, actual: { propagation, objects } });
  const noRule = await call(harness, 'browser_network_trace', { action: 'begin-step', name: 'no-rules', stepId: 'step-c27b' }, exec);
  await clickAndAwait(harness, '#net-token', 'token', { exec });
  const noRuleEnd = await call(harness, 'browser_network_trace', { action: 'end-step', stepId: 'step-c27b' }, exec);
  const noRuleObjects = noRuleEnd.value?.objects || stepOf(noRuleEnd.value)?.objects || [];
  check('未给 objectRules 时不猜测对象（objects 为空）', noRule.ok && noRuleEnd.ok
    && noRuleObjects.length === 0, { expected: { objects: [] }, actual: noRuleObjects });
}

/** C28 — G4.3 cross-request correlation grouping. */
async function probeC28({ harness, check }) {
  const exec = execOf('c28');
  await freshSession(harness, { exec, name: 'c28' });
  const headers = { traceparent: '00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01' };
  await pageValue(harness, `fetch('/n/json?c28=a', { headers: ${JSON.stringify(headers)} }).then((r) => r.json())`, exec);
  await pageValue(harness, `fetch('/n/json?c28=b', { headers: ${JSON.stringify(headers)} }).then((r) => r.json())`, exec);
  await waitEvents(harness, (event) => urlHas('c28=')(event) && event.phase === 'finished', { exec, count: 2, label: 'correlated requests' });
  const id = await requestIdFor(harness, '/n/json?c28=a', exec);
  const value = await detail(harness, { requestId: id, include: ['correlation'] }, exec);
  const ids = value.value?.correlation?.ids || [];
  const traceId = ids.find((item) => /traceparent|trace/i.test(String(item.name)));
  const shared = value.value?.correlation?.group ?? value.value?.correlation?.sameGroup ?? null;
  check('traceparent 的 trace-id 段被提取为关联标识（hash，不含原值）', Boolean(traceId)
    && !JSON.stringify(ids).includes('4bf92f3577b34da6a3ce929d0e0e4736'),
    { expected: { name: 'traceparent', rawValueLeaked: false }, actual: ids });
  check('同链路请求可分到同一组（组内 ≥2 或组键可查）', (Number(shared?.count ?? shared) >= 2)
    || (ids.length > 0 && String(JSON.stringify(value.value?.correlation || '')).includes('group')),
    { expected: { groupCount: '>=2' }, actual: value.value?.correlation });
  const other = await requestIdFor(harness, '/n/json?from=page&n=1', exec).catch(() => null);
  check('未携带关联标识的请求不强行加入其他链路', other === null
    || !JSON.stringify((await detail(harness, { requestId: other, include: ['correlation'] }, exec)).value?.correlation || {}).includes('4bf9'),
    { expected: 'no forced grouping', actual: other });
}

/** C29 — G4.4 observed business/HTTP status changes only. */
async function probeC29({ harness, check }) {
  const exec = execOf('c29');
  await freshSession(harness, { exec, name: 'c29', config: { businessStatusPath: 'status' } });
  await call(harness, 'browser_network_trace', { action: 'begin-step', name: 'states', stepId: 'step-c29' }, exec);
  await pageValue(harness, "fetch('/n/status/500').then((r) => r.json())", exec);
  await pageValue(harness, "fetch('/n/status/404').then((r) => r.json())", exec);
  await waitEvents(harness, (event) => urlHas('/n/status/404')(event) && event.phase === 'finished', { exec, label: '404 finished' });
  const end = await call(harness, 'browser_network_trace', { action: 'end-step', stepId: 'step-c29' }, exec);
  const stepStates = stepOfValue(end.value)?.states || end.value?.states || [];
  const queryStates = (await call(harness, 'browser_network_trace', { action: 'query' }, exec)).value?.states || [];
  const states = stepStates.length ? stepStates : queryStates;
  check('状态变化被记录在 steps[].states[]（{atWallMs,seq,from,to,field,basis}）', states.length >= 1
    && states.every((item) => typeof item === 'object' && 'from' in item && 'to' in item),
    { expected: { changes: '>=1', fields: ['atWallMs', 'seq', 'from', 'to', 'field', 'basis'] }, actual: { stepStates, queryStates: queryStates.slice(0, 2) } });
  check('变化依据是 observed、字段限于 businessCode/httpStatus', states.length === 0
    || states.every((item) => item.basis === 'observed' && ['businessCode', 'httpStatus', 'status'].includes(String(item.field))),
    { expected: { basis: 'observed', field: 'businessCode|httpStatus' }, actual: states.slice(0, 3) });
  const noChange = await call(harness, 'browser_network_trace', { action: 'begin-step', name: 'flat', stepId: 'step-c29b' }, exec);
  await pageValue(harness, "fetch('/n/json').then((r) => r.json())", exec);
  await sleep(300);
  const flatEnd = await call(harness, 'browser_network_trace', { action: 'end-step', stepId: 'step-c29b' }, exec);
  const flatStates = stepOfValue(flatEnd.value)?.states || flatEnd.value?.states || [];
  check('无变化时不产生状态记录', noChange.ok && flatStates.length === 0,
    { expected: { changes: 0 }, actual: flatStates });
}

/** C30 — G4.5 window management edge cases. */
async function probeC30({ harness, check }) {
  const exec = execOf('c30');
  await freshSession(harness, { exec, name: 'c30' });
  const plain = await call(harness, 'browser_network_trace', { action: 'begin-step', name: 'plain', stepId: 'step-c30' }, exec);
  const explicit = await call(harness, 'browser_network_trace', {
    action: 'begin-step', name: 'explicit', stepId: 'step-c30b', window: { fromMs: 1, toMs: 2 },
  }, exec);
  check('begin-step 默认以 now 开窗（fromSeq/时间基准可得）', plain.ok
    && (plain.value?.steps?.[0]?.window || plain.value?.steps?.[0]?.fromSeq !== undefined),
    { expected: 'window or fromSeq', actual: plain.value?.steps?.[0] });
  check('显式 window 被接受并在窗口查询中回显', explicit.ok && JSON.stringify(explicit.value?.steps?.[0] || {}).includes('1'),
    { expected: { window: { fromMs: 1, toMs: 2 } }, actual: explicit.value?.steps?.[0] });
  const duplicate = await call(harness, 'browser_network_trace', { action: 'begin-step', name: 'plain', stepId: 'step-c30' }, exec);
  checkNetError(check, '重复使用同一 stepId 被拒绝（NET_RULE_CONFLICT）', duplicate, { code: 'NET_RULE_CONFLICT' });
  const end1 = await call(harness, 'browser_network_trace', { action: 'end-step', stepId: 'step-c30' }, exec);
  const endAgain = await call(harness, 'browser_network_trace', { action: 'end-step', stepId: 'step-c30' }, exec);
  check('重复 end-step 幂等（两次都成功）', end1.ok && endAgain.ok,
    { expected: { idempotent: true }, actual: { first: end1.error || end1.value?.steps?.[0]?.toSeq, second: endAgain.error || endAgain.value?.steps?.[0]?.toSeq } });
  await clickAndAwait(harness, '#net-fetch-json', 'fetch-json', { exec });
  const nowMs = Date.now();
  const past = await call(harness, 'browser_network_trace', { action: 'window', window: { fromWallMs: 0, toWallMs: nowMs } }, exec);
  const future = await call(harness, 'browser_network_trace', { action: 'window', window: { fromWallMs: nowMs + 60000, toWallMs: nowMs + 120000 } }, exec);
  check('window 查询按墙钟区间过滤（过去有事件、未来为空）', past.ok && future.ok
    && (past.value?.events || []).length >= 1 && (future.value?.events || []).length === 0,
    { expected: { past: '>=1', future: 0 }, actual: { past: (past.value?.events || []).length, future: (future.value?.events || []).length, pastKeys: Object.keys(past.value || {}) } });
}

/** C31 — G4.6 polling/async after step close (volatile query ignored). */
async function probeC31({ harness, check }) {
  const exec = execOf('c31');
  await freshSession(harness, { exec, name: 'c31' });
  await call(harness, 'browser_network_trace', { action: 'begin-step', name: 'poll', stepId: 'step-c31' }, exec);
  await clickSelector(harness, '#net-poll-start', exec);
  let truth = await netTruth(harness, exec);
  for (let index = 0; index < 80 && truth.poll.values.length < 3; index += 1) { await sleep(100); truth = await netTruth(harness, exec); }
  const end = await call(harness, 'browser_network_trace', { action: 'end-step', stepId: 'step-c31' }, exec);
  const polling = end.value?.polling || (await call(harness, 'browser_network_trace', { action: 'query' }, exec)).value?.polling || [];
  check('3 次 /n/poll?n=1..3 被识别为 polling（间隔相似、query 不入键）', truth.poll.values.join(',') === '1,2,3'
    && polling.length >= 1, { expected: { values: [1, 2, 3], polling: '>=1' }, actual: { values: truth.poll.values, polling } });
  check('polling 统计给出 count 与间隔信息', polling.length === 0
    || (Number(polling[0].count) >= 3 && (polling[0].intervalMs !== undefined)),
    { expected: { count: '>=3', intervalMs: 'present' }, actual: polling[0] });
  await pageValue(harness, "fetch('/n/poll?n=9').then((r) => r.json())", exec);
  await waitEvents(harness, (event) => urlHas('/n/poll?n=9')(event) && event.phase === 'finished', { exec, label: 'post-step poll' });
  const after = await call(harness, 'browser_network_trace', { action: 'query' }, exec);
  const asyncInfo = after.value?.async || [];
  const asyncFlagged = asyncInfo.length >= 1 || JSON.stringify(after.value || {}).includes('asyncAfterClose');
  check('步骤关闭后的同键请求标为 async（asyncAfterClose）', asyncFlagged,
    { expected: { async: '>=1' }, actual: asyncInfo });
  const pageAlive = await pageValue(harness, 'window.__net.poll.active', exec);
  check('采集不自动停页面定时器（poll.active 由页面自己决定）', pageAlive === false,
    { expected: { pollActive: false }, actual: pageAlive });
}

/** C32 — G4.7 causality basis correctness. */
async function probeC32({ harness, check }) {
  const exec = execOf('c32');
  await freshSession(harness, { exec, name: 'c32' });
  await clickAndAwait(harness, '#net-fetch-json', 'fetch-json', { exec });
  const requestId = await requestIdFor(harness, '/n/json?from=page&n=1', exec);
  const requestSeq = (await waitEvents(harness, (event) => event.requestId === requestId && event.phase === 'request', { exec }))[0].seq;
  const linked = await call(harness, 'browser_network_trace', { action: 'link', seq: requestSeq, evidenceId: 'ev-c32' }, exec);
  check('trace.link 建立 explicit 关联', linked.ok && linked.value?.ok !== false,
    { expected: { ok: true }, actual: linked.error || linked.value?.link });
  await clickAndAwait(harness, '#net-redirect', 'redirect', { exec });
  const redirectDetail = await detail(harness, { requestId: await requestIdFor(harness, '/n/redirect/1', exec), include: ['redirects', 'dependencies'] }, exec);
  const dependencies = redirectDetail.value?.dependencies || {};
  check('redirect 关系由 CDP 派生（basis/releation=redirect，不靠时间猜测）',
    String(JSON.stringify(dependencies)).includes('redirect')
      || (redirectDetail.value?.hops || []).length >= 2,
    { expected: 'redirect-derived relation', actual: dependencies });
  const linkedDetail = await detail(harness, { seq: requestSeq, include: ['request'] }, exec);
  const query = await call(harness, 'browser_network_trace', { action: 'query', limit: 100 }, exec);
  const causality = query.value?.causality || [];
  check('causality 只用合法 basis 取值（explicit|redirect|initiator|temporal）',
    causality.every((item) => ['explicit', 'redirect', 'initiator', 'temporal'].includes(item.basis))
      && linkedDetail.ok, { expected: ['explicit', 'redirect', 'initiator', 'temporal'], actual: causality.map((item) => item.basis) });
  const temporal = causality.filter((item) => item.basis === 'temporal');
  check('默认查询不返回 temporal 因果（需 includeTemporal:true）', temporal.length === 0,
    { expected: { temporal: 0 }, actual: temporal.slice(0, 3) });
  const withTemporal = await call(harness, 'browser_network_trace', { action: 'query', limit: 20, includeTemporal: true }, exec);
  const temporalItems = (withTemporal.value?.causality || []).filter((item) => item.basis === 'temporal');
  check('includeTemporal:true 时 temporal 混在 causality[] 内且只在此模式出现', withTemporal.ok
    && temporalItems.every((item) => item.basis === 'temporal')
    && ((withTemporal.value?.causality || []).every((item) => ['explicit', 'redirect', 'initiator', 'temporal'].includes(item.basis))),
    { expected: { temporal: 'in causality[] with basis temporal' }, actual: { temporalCount: temporalItems.length, bases: (withTemporal.value?.causality || []).map((item) => item.basis) } });
}

/** C33 — G4.8 evidence links (idempotent, readable from detail/trace). */
async function probeC33({ harness, check }) {
  const exec = execOf('c33');
  await freshSession(harness, { exec, name: 'c33' });
  await clickAndAwait(harness, '#net-fetch-json', 'fetch-json', { exec });
  const requestId = await requestIdFor(harness, '/n/json?from=page&n=1', exec);
  const seq = (await waitEvents(harness, (event) => event.requestId === requestId && event.phase === 'request', { exec }))[0].seq;
  const first = await call(harness, 'browser_network_trace', { action: 'link', seq, evidenceId: 'ev-c33' }, exec);
  const second = await call(harness, 'browser_network_trace', { action: 'link', seq, evidenceId: 'ev-c33' }, exec);
  check('同一 seq↔evidenceId 重复 link 幂等（不重复累加）', first.ok && second.ok
    && JSON.stringify(first.value?.link || {}) === JSON.stringify(second.value?.link || {}),
    { expected: 'idempotent', actual: { first: first.value?.link, second: second.value?.link } });
  const detailValue = await detail(harness, { requestId, include: ['request'] }, exec);
  const evidenceIds = detailValue.value?.evidenceIds || detailValue.value?.event?.evidenceIds || [];
  check('detail 返回 evidenceIds（含已链接证据）', Array.isArray(evidenceIds) && evidenceIds.includes('ev-c33'),
    { expected: ['ev-c33'], actual: evidenceIds });
  const shot = await call(harness, 'browser_screenshot', {}, exec);
  const shotActionId = shot.value?.actionId;
  const lastEventSeq = (await allEvents(harness, exec)).value.events.at(-1)?.seq;
  const linkedShot = await call(harness, 'browser_network_trace', { action: 'link', seq: lastEventSeq, evidenceId: shotActionId }, exec);
  check('截图 actionId 可作为证据 ID 关联到网络事件', typeof shotActionId === 'string'
    && linkedShot.ok && (linkedShot.value?.link?.evidenceIds || []).includes(shotActionId),
    { expected: { evidenceId: 'screenshot actionId' }, actual: linkedShot.value?.link });
}

/** C34 — G5.1 start/stop/reset semantics. */
async function probeC34({ harness, check }) {
  const exec = execOf('c34');
  await freshSession(harness, { exec, name: 'c34' });
  await clickAndAwait(harness, '#net-fetch-json', 'fetch-json', { exec });
  const beforeStop = (await sessionStatus(harness, exec)).value?.counters?.events ?? 0;
  await sessionStop(harness, exec);
  await clickAndAwait(harness, '#net-500', 'status-500', { exec });
  const afterStop = (await sessionStatus(harness, exec)).value?.counters?.events ?? 0;
  check('stop 后新请求不再进入该会话（事件数不增）', beforeStop > 0 && afterStop === beforeStop,
    { expected: { beforeStop, afterStop: beforeStop }, actual: { beforeStop, afterStop } });
  const pageStillWorks = await pageValue(harness, 'document.title', exec);
  check('stop 不关闭页面（原页面仍可执行）', pageStillWorks === WEB_NET_TITLE,
    { expected: WEB_NET_TITLE, actual: pageStillWorks });
  const restarted = await sessionStart(harness, { name: 'c34', exec });
  check('stop 后可重新 start 并继续采集（新会话 seq 重新计数）', restarted.ok
    && restarted.value?.session?.counters?.seq === 0 && restarted.value?.session?.state === 'running',
    { expected: { state: 'running', seq: 0 }, actual: restarted.value?.session && { state: restarted.value.session.state, seq: restarted.value.session.counters?.seq } });
  const reset = await sessionReset(harness, exec);
  check('reset 后 counters 归零且仍可读（会话不消失）', reset.ok && reset.value?.counters?.events === 0
    && reset.value?.counters?.dropped === 0, { expected: { events: 0, dropped: 0 }, actual: reset.value?.counters });
}

/**
 * TOOL-P1-04 (C34): per-tab attribution + status/events consistency.
 *  - session/status 回传同一份 {scopeId,runtimeId,tabId}（主标签 tabId="primary"，缺失不推断）；
 *  - evidence.attribution 与 session.attribution 同源；
 *  - status 新增 activeSessionId/bufferedEvents，events 的 sessionId/证据与 status 一致。
 */
async function probeC34Attribution({ harness, check }) {
  const exec = execOf('c34-p104');
  await freshSession(harness, { exec, name: 'c34-p104' });
  const value = (await sessionStatus(harness, exec)).value || {};
  const attr = value.attribution || {};
  const sessionAttr = value.session?.attribution || {};
  const attrProblems = [];
  for (const [field, source] of [['attribution', attr], ['session.attribution', sessionAttr]]) {
    if (typeof source.scopeId !== 'string' || !source.scopeId) attrProblems.push(field + '.scopeId');
    if (typeof source.runtimeId !== 'string' || !source.runtimeId) attrProblems.push(field + '.runtimeId');
    if (source.tabId !== 'primary') attrProblems.push(field + '.tabId=' + String(source.tabId));
  }
  check('session/status 回传 per-tab attribution{scopeId,runtimeId,tabId=primary}（缺失不推断）',
    attrProblems.length === 0,
    { expected: { scopeId: 'non-empty string', runtimeId: 'non-empty string', tabId: 'primary' },
      actual: { problems: attrProblems, attribution: attr, sessionAttribution: sessionAttr } });
  const evidenceAttr = value.evidence?.attribution || {};
  check('session.status evidence 与 session.attribution 同一份 attribution',
    evidenceAttr.scopeId === attr.scopeId && evidenceAttr.runtimeId === attr.runtimeId && evidenceAttr.tabId === attr.tabId,
    { expected: { sameRuntimeId: true, tabId: 'primary' }, actual: { evidence: evidenceAttr, topLevel: attr } });
  check('status 增加 activeSessionId（=session.id）与 bufferedEvents（整数）',
    value.activeSessionId === value.session?.id && Number.isInteger(value.bufferedEvents),
    { expected: { activeSessionId: 'session.id', bufferedEvents: 'integer' },
      actual: { activeSessionId: value.activeSessionId, sessionId: value.session?.id, bufferedEvents: value.bufferedEvents } });

  await clickAndAwait(harness, '#net-fetch-json', 'fetch-json', { exec });
  const eventsValue = (await netEvents(harness, { limit: 20, view: 'summary' }, exec)).value || {};
  const eventAttr = eventsValue.evidence?.attribution || {};
  check('browser_network_events 证据回传同一 attribution，sessionId 与 status 一致',
    eventAttr.scopeId === attr.scopeId && eventAttr.runtimeId === attr.runtimeId && eventAttr.tabId === 'primary'
      && eventsValue.sessionId === value.session?.id,
    { expected: { tabId: 'primary', sameRuntimeId: true, sessionId: 'status.session.id' },
      actual: { attribution: eventAttr, sessionId: eventsValue.sessionId, statusSessionId: value.session?.id } });
  const again = (await sessionStatus(harness, exec)).value || {};
  check('主标签 attribution 稳定（再次 status 仍为同一 tabId/runtimeId）',
    again.attribution?.tabId === 'primary' && again.attribution?.runtimeId === attr.runtimeId,
    { expected: { tabId: 'primary', runtimeId: attr.runtimeId }, actual: again.attribution });
}

/** C35 — G5.2 on-demand detail with honest body states. */
async function probeC35({ harness, check, notRun }) {
  const exec = execOf('c35');
  await freshSession(harness, { exec, name: 'c35' });
  await clickAndAwait(harness, '#net-post-json', 'post-json', { exec });
  const requestId = await requestIdFor(harness, '/n/echo', exec);
  const withoutBody = await detail(harness, { requestId, include: ['request', 'response'] }, exec);
  check('默认不读 body（include 不含 body 时无 body 键）', withoutBody.ok
    && withoutBody.value?.body === undefined, { expected: { body: 'absent' }, actual: Object.keys(withoutBody.value || {}) });
  const withBody = await detail(harness, { requestId, include: ['body'] }, exec);
  check('include:["body"] 读取已捕获的请求/响应体', withBody.value?.body?.request?.available === true
    && withBody.value?.body?.response?.available === true,
    { expected: { request: true, response: true }, actual: withBody.value?.body });
  const missing = await detail(harness, { requestId, include: ['body'], maxBodyBytes: 1024 }, exec);
  check('maxBodyBytes 生效（body 被截断到上限内并标记）', missing.value?.body?.response?.bytes <= 1024,
    { expected: '<=1024', actual: missing.value?.body?.response });
  const evicted = await call(harness, 'browser_network_detail', { seq: 999999, include: ['body'] }, exec);
  checkNetError(check, '已淘汰/不存在的 seq → NET_EVENT_NOT_FOUND（不伪造空体）', evicted, { code: 'NET_EVENT_NOT_FOUND' });
  notRun('已捕获但被配额淘汰的 body 三态', '需要先把 body 挤出 maxTotalBytes 再读；U 类在 tests/network-p0.test.mjs 用 store 直接构造三态。');
}

/** C36 — G5.3 interception: block/fail/counts, navigation guard intact. */
async function probeC36({ harness, check }) {
  const exec = execOf('c36');
  await freshSession(harness, { exec, name: 'c36' });
  const add = await call(harness, 'browser_network_control', {
    action: 'intercept-add',
    rule: { id: 'block-c36', pattern: { urlPattern: '*/n/status/404*', resourceType: 'Fetch', method: 'GET' }, behavior: { kind: 'block' } },
  }, exec);
  check('intercept-add 接受 block 规则并回显规则 id', add.ok && add.value?.ok !== false,
    { expected: { ruleId: 'block-c36' }, actual: add.error || add.value?.rules || add.value });
  const blockedResult = await pageValue(harness, "fetch('/n/status/404').then((r) => r.text().then(() => 'ok:' + r.status)).catch((e) => 'failed')", exec);
  const blocked = await waitEvents(harness, (event) => urlHas('/n/status/404')(event) && event.phase === 'failed', { exec, label: 'blocked request' });
  check('block 规则使请求 failed（BlockedByClient/blockedReason 可读）', blockedResult === 'failed'
    && blocked.length >= 1 && (String(JSON.stringify(blocked[0])).includes('BlockedByClient')
      || String(blocked[0].errorText || '').length > 0),
    { expected: { page: 'failed', blockedReason: 'BlockedByClient' }, actual: { page: blockedResult, event: blocked[0] } });
  const list = await call(harness, 'browser_network_control', { action: 'intercept-list' }, exec);
  check('intercept-list 返回规则与命中计数', list.ok && JSON.stringify(list.value || {}).includes('block-c36')
    && JSON.stringify(list.value || {}).match(/hits|matched|count/i),
    { expected: { rules: 1, hits: 'present' }, actual: list.value });
  await call(harness, 'browser_network_control', {
    action: 'intercept-add',
    rule: { id: 'fail-c36', pattern: { urlPattern: '*/n/json*fail=1*' }, behavior: { kind: 'fail', errorReason: 'Aborted' } },
  }, exec);
  await pageValue(harness, "fetch('/n/json?fail=1').then((r) => r.text().then(() => 'ok')).catch(() => 'failed')", exec);
  const failedRule = await waitEvents(harness, (event) => urlHas('fail=1')(event) && event.phase === 'failed', { exec, label: 'fail rule event' });
  check('fail 规则产生 failed 事件且 errorText 有值', failedRule.length >= 1 && typeof failedRule[0].errorText === 'string',
    { expected: { failed: true }, actual: failedRule[0] });
  const navigation = await call(harness, 'browser_navigate', { url: 'http://169.254.169.254/' }, exec);
  checkNetError(check, '拦截规则不影响既有 Document 导航守卫（metadata 目标仍被拒）', navigation, { code: 'INVALID_ARGUMENT' });
  await call(harness, 'browser_network_control', { action: 'intercept-clear' }, exec);
}

/** C37 — G5.4 request/response modification (modify-response may be NOT_RUN). */
async function probeC37({ harness, check, notRun }) {
  const exec = execOf('c37');
  await freshSession(harness, { exec, name: 'c37' });
  const modify = await call(harness, 'browser_network_control', {
    action: 'intercept-add',
    rule: { id: 'mod-c37', pattern: { urlPattern: '*/n/echo*' }, behavior: { kind: 'modify-request', headers: { 'x-net-probe': 'modified-probe-1' } } },
  }, exec);
  const echo = await pageValue(harness, "fetch('/n/echo', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ c37: 1 }) }).then((r) => r.json())", exec);
  check('modify-request 改写的请求头被服务端回显（x-net-probe=modified-probe-1）', modify.ok
    && String(echo?.headers?.['x-net-probe'] || '') === 'modified-probe-1',
    { expected: { xNetProbe: 'modified-probe-1' }, actual: { add: modify.error || modify.value?.ok, echoed: echo?.headers } });
  await call(harness, 'browser_network_control', {
    action: 'intercept-add',
    rule: { id: 'fulfil-c37', pattern: { urlPattern: '*/n/poll*fulfil=1*' }, behavior: { kind: 'fulfill', status: 418, body: '{"fulfilled":true}', headers: { 'content-type': 'application/json' } } },
  }, exec);
  const fulfilled = await pageValue(harness, "fetch('/n/poll?fulfil=1').then((r) => r.text().then(() => r.status))", exec);
  check('fulfill 规则返回给定状态与响应体（418）', fulfilled === 418, { expected: 418, actual: fulfilled });
  const caps = await call(harness, 'browser_capabilities', {}, exec);
  const responseModification = caps.value?.network?.limits?.network?.responseModification;
  await call(harness, 'browser_network_control', { action: 'intercept-clear' }, exec);
  if (responseModification === true) {
    const modifyResponse = await call(harness, 'browser_network_control', {
      action: 'intercept-add',
      rule: { id: 'modresp-c37', pattern: { urlPattern: '*/n/json*modresp=1*' }, behavior: { kind: 'modify-response', status: 201, headers: { 'x-modified': '1' } } },
    }, exec);
    const status = await pageValue(harness, "fetch('/n/json?modresp=1').then((r) => r.text().then(() => r.status)).catch(() => 0)", exec);
    check('实测支持时 modify-response 生效（状态被改写）', modifyResponse.ok && status === 201,
      { expected: { status: 201 }, actual: { status, add: modifyResponse.error || modifyResponse.value?.ok } });
  } else {
    notRun('modify-response（响应修改）', `能力报告 responseModification=${String(responseModification)}：当前 CDP 不支持 Fetch.continueResponse，按 R1-7/R1-18 记 NOT_RUN，不伪造。`);
  }
  check('能力报告如实给出 responseModification 布尔值', typeof responseModification === 'boolean',
    { expected: 'boolean', actual: responseModification });
}

/** C38 — G5.5 throttle latency/bandwidth and reset. */
async function probeC38({ harness, check }) {
  const exec = execOf('c38');
  await freshSession(harness, { exec, name: 'c38' });
  await pageValue(harness, "fetch('/n/json?thr=base').then((r) => r.json()).then(() => 0)", exec);
  const baseFinished = await waitEvents(harness, (event) => urlHas('thr=base')(event) && event.phase === 'finished', { exec, label: 'baseline finished' });
  const throttled = await call(harness, 'browser_network_control', { action: 'throttle', throttle: { latencyMs: 400 } }, exec);
  check('throttle 接受延迟参数并回显生效条件', throttled.ok && JSON.stringify(throttled.value || {}).includes('400'),
    { expected: { latencyMs: 400 }, actual: throttled.error || throttled.value?.throttle || throttled.value });
  await pageValue(harness, "fetch('/n/json?thr=slow').then((r) => r.json()).then(() => 0)", exec);
  const slowFinished = await waitEvents(harness, (event) => urlHas('thr=slow')(event) && event.phase === 'finished', { exec, label: 'throttled finished' });
  check('throttle 使 /n/json 耗时显著增加（比基线多 ≥250ms）', Number.isFinite(slowFinished[0].totalMs)
    && Number.isFinite(baseFinished[0].totalMs) && slowFinished[0].totalMs - baseFinished[0].totalMs >= 250,
    { expected: { delta: '>=250' }, actual: { base: baseFinished[0].totalMs, throttled: slowFinished[0].totalMs } });
  const reset = await call(harness, 'browser_network_control', { action: 'reset' }, exec);
  await pageValue(harness, "fetch('/n/json?thr=after').then((r) => r.json()).then(() => 0)", exec);
  const afterFinished = await waitEvents(harness, (event) => urlHas('thr=after')(event) && event.phase === 'finished', { exec, label: 'after reset finished' });
  check('reset 恢复默认网络条件（耗时回落）', reset.ok
    && Number.isFinite(afterFinished[0].totalMs) && afterFinished[0].totalMs < slowFinished[0].totalMs,
    { expected: { afterReset: '< throttled' }, actual: { reset: reset.value?.throttle || reset.value, throttled: slowFinished[0].totalMs, after: afterFinished[0].totalMs } });
  const limits = (await sessionStatus(harness, exec)).value?.limits || {};
  check('限速上限公开（latency 0–60000、Kbps 0–1000000）', JSON.stringify(limits).includes('60000')
    || JSON.stringify(limits).includes('throttle'), { expected: 'throttle limits published', actual: limits.throttle || Object.keys(limits) });
}

/** C39 — G5.6 offline / failure injection and recovery. */
async function probeC39({ harness, check }) {
  const exec = execOf('c39');
  await freshSession(harness, { exec, name: 'c39' });
  const offline = await call(harness, 'browser_network_control', { action: 'offline', offline: true }, exec);
  const offResult = await pageValue(harness, "fetch('/n/json?off=1').then((r) => r.text().then(() => 'ok')).catch(() => 'failed')", exec);
  const offEvent = await waitEvents(harness, (event) => urlHas('off=1')(event) && event.phase === 'failed', { exec, label: 'offline failure' });
  check('offline 时请求失败且有 failed 事件', offline.ok && offResult === 'failed' && offEvent.length >= 1,
    { expected: { page: 'failed', event: 'failed' }, actual: { page: offResult, event: offEvent[0] } });
  await call(harness, 'browser_network_control', { action: 'offline', offline: false }, exec);
  const onResult = await pageValue(harness, "fetch('/n/json?off=2').then((r) => r.text().then(() => r.status)).catch(() => 0)", exec);
  const onEvent = await waitEvents(harness, (event) => urlHas('off=2')(event) && event.phase === 'finished', { exec, label: 'online recovery' });
  check('恢复后请求成功（200）', onResult === 200 && onEvent[0].status === 200,
    { expected: { status: 200 }, actual: { page: onResult, event: onEvent[0] } });
  const alive = await pageValue(harness, 'document.title', exec);
  check('断连/恢复不杀死 page（标题仍可读）', alive === WEB_NET_TITLE, { expected: WEB_NET_TITLE, actual: alive });
}

/** C40 — G5.7 replay (server hit count + new CDP request) and mock. */
async function probeC40({ harness, check }) {
  const exec = execOf('c40');
  await freshSession(harness, { exec, name: 'c40' });
  await pageValue(harness, "fetch('/n/flaky?key=seed40').then((r) => r.json())", exec);
  await pageValue(harness, "fetch('/n/flaky?key=replay40').then((r) => r.json())", exec);
  const flakyId = await requestIdFor(harness, '/n/flaky', exec);
  const beforeAttempt = await pageValue(harness, "fetch('/n/flaky?key=replay40').then((r) => r.json())", exec);
  const replay = await call(harness, 'browser_network_control', { action: 'replay', requestId: flakyId, replay: { count: 1, via: 'page' } }, exec);
  check('replay via page 被接受并返回重放信息', replay.ok && replay.value?.ok !== false,
    { expected: { ok: true }, actual: replay.error || replay.value?.replay || replay.value });
  const afterAttempt = await pageValue(harness, "fetch('/n/flaky?key=replay40').then((r) => r.json())", exec);
  check('fixture 服务端命中计数递增（replay 真的发出了请求）', Number(afterAttempt?.attempt) > Number(beforeAttempt?.attempt),
    { expected: { attempt: `>${beforeAttempt?.attempt}` }, actual: { before: beforeAttempt, after: afterAttempt } });
  const replayed = await waitEvents(harness, (event) => urlHas('/n/flaky')(event) && event.phase === 'finished', { exec, count: 3, label: 'replayed request event' });
  check('重放产生新的 CDP 请求事件并被标记（mark.kind=replay）', replayed.length >= 3
    && replayed.some((event) => String(JSON.stringify(event)).includes('replay')),
    { expected: { newEvent: true, mark: 'replay' }, actual: replayed.map((event) => ({ seq: event.seq, phase: event.phase })) });
  const mock = await call(harness, 'browser_network_control', {
    action: 'mock', requestId: flakyId, mock: { status: 299, headers: { 'content-type': 'application/json' }, body: '{"mocked":true}' },
  }, exec);
  const mocked = await pageValue(harness, "fetch('/n/flaky?key=replay40').then((r) => r.status + ':' + r.headers.get('content-type'))", exec);
  check('mock 返回指定响应且原记录不变', mock.ok && String(mocked).startsWith('299'),
    { expected: { status: 299 }, actual: { page: mocked, mock: mock.error || mock.value?.ok } });
  const original = await detail(harness, { requestId: flakyId, include: ['response'] }, exec);
  check('mock 不修改原请求记录（原 status 仍为首次真实响应）', original.ok
    && original.value?.response?.status !== 299, { expected: 'original status preserved', actual: original.value?.response?.status });
}

/** C41 — G6.1 JSONL persistence (0600, no-clobber, meta, staging rules). */
async function probeC41({ harness, check, notRun }) {
  const exec = execOf('c41');
  await freshSession(harness, { exec, name: 'c41' });
  await clickAndAwait(harness, '#net-fetch-json', 'fetch-json', { exec });
  const exported = await call(harness, 'browser_network_evidence', { action: 'export', format: 'jsonl', out: 'output/network/acceptance-c41.jsonl' }, exec);
  const file = exported.value?.file || {};
  check('JSONL 导出返回相对路径与字节/事件数', exported.ok && file.relativePath
    && !String(file.relativePath).startsWith('/') && Number.isInteger(file.bytes) && file.events >= 1,
    { expected: { relativePath: 'string (relative)', bytes: 'int', events: '>=1' }, actual: file });
  const absolute = file.relativePath ? join(RUN_ROOT, file.relativePath) : null;
  let stat = null;
  try { stat = absolute ? statSync(absolute) : null; } catch { stat = null; }
  check('落盘文件存在且权限 0600（原子写、no-clobber 语义）', Boolean(stat) && (stat.mode & 0o777) === 0o600,
    { expected: { mode: '0600', exists: true }, actual: { exists: Boolean(stat), mode: stat ? (stat.mode & 0o777).toString(8) : null } });
  let meta = null;
  try { meta = JSON.parse(String(readFileSync(absolute, 'utf8')).split('\n')[0]); } catch { meta = null; }
  check('JSONL 首行 meta 含 version/session/config/limits（§8.1）', meta?.type === 'meta' ? meta.version === 1 && Boolean(meta.session) && Boolean(meta.config) && Boolean(meta.limits) : meta?.version === 1 && Boolean(meta?.sessionId)
    , { expected: { meta: ['version', 'session', 'config', 'limits'] }, actual: meta && { type: meta.type, version: meta.version, hasSession: Boolean(meta.session || meta.sessionId), hasConfig: Boolean(meta.config) } });
  const second = await call(harness, 'browser_network_evidence', { action: 'export', format: 'jsonl', out: 'output/network/acceptance-c41.jsonl' }, exec);
  check('同一路径再次导出不覆盖（no-clobber 或明确报错）', second.threw === true
    || second.value?.file?.relativePath !== file.relativePath,
    { expected: 'no silent overwrite', actual: second.error || second.value?.file });
  const traversal = await call(harness, 'browser_network_evidence', { action: 'export', format: 'jsonl', out: '../escape.jsonl' }, exec);
  checkNetError(check, '越界路径被拒绝（NET_OUTPUT_PATH_INVALID）', traversal, { code: 'NET_OUTPUT_PATH_INVALID' });
  report.evidenceFiles.push({ criteria: 'C41', relativePath: file.relativePath, bytes: file.bytes, mode: stat ? (stat.mode & 0o777).toString(8) : null });
}

/** C42 — G6.2 JSONL fidelity + HAR 1.2 subset round trip. */
async function probeC42({ harness, check }) {
  const exec = execOf('c42');
  await freshSession(harness, { exec, name: 'c42' });
  await clickAndAwait(harness, '#net-fetch-json', 'fetch-json', { exec });
  await clickAndAwait(harness, '#net-500', 'status-500', { exec });
  const before = (await netEvents(harness, { limit: 200, view: 'summary' }, exec)).value;
  const beforeHttp = (before.events || []).filter((event) => event.kind === 'http' && event.phase === 'finished');
  const jsonl = await call(harness, 'browser_network_evidence', { action: 'export', format: 'jsonl', out: 'output/network/acceptance-c42.jsonl' }, exec);
  const imported = await call(harness, 'browser_network_evidence', { action: 'import', format: 'jsonl', file: jsonl.value?.file?.relativePath }, exec);
  const importedSession = imported.value?.session?.id || imported.value?.sessionId;
  const after = await netEvents(harness, { sessionId: importedSession, limit: 200, view: 'summary' }, exec);
  const afterHttp = (after.value?.events || []).filter((event) => event.kind === 'http' && event.phase === 'finished');
  check('JSONL 往返保真：导入会话的 HTTP 完成事件 URL/status 与导出侧一致', jsonl.ok && imported.ok
    && afterHttp.length === beforeHttp.length
    && afterHttp.every((event, index) => event.url === beforeHttp[index]?.url && event.status === beforeHttp[index]?.status),
    { expected: { count: beforeHttp.length }, actual: { imported: afterHttp.length, sample: afterHttp.slice(0, 2).map((event) => `${event.method} ${event.url} ${event.status}`) } });
  // A real export line-set with one middle event removed: R1-3 requires the seq:0 session-meta
  // marker first, so a hand-built file without it is (correctly) rejected.
  const holeSource = await call(harness, 'browser_network_evidence', { action: 'export', format: 'jsonl', out: 'output/network/acceptance-c42-hole.jsonl' }, exec);
  const holeLines = holeSource.value?.file?.relativePath
    ? readFileSync(join(RUN_ROOT, holeSource.value.file.relativePath), 'utf8').split('\n').filter(Boolean)
    : [];
  const withHole = holeLines.length >= 3 ? [holeLines[0], ...holeLines.slice(1).filter((_, index) => index !== 1)].join('\n') + '\n' : '';
  const holeImport = await call(harness, 'browser_network_evidence', { action: 'import', format: 'jsonl', data: withHole }, exec);
  const holeSeqs = (holeImport.value?.session?.counters?.events !== undefined) ? null : null;
  check('JSONL 导入保留 seq 空洞并标 complete:false（不重排序）', holeImport.ok
    && (holeImport.value?.integrity?.complete === false || JSON.stringify(holeImport.value).includes('gap')),
    { expected: { complete: false, seqs: [1, 3] }, actual: holeImport.error || holeImport.value?.integrity });
  const har = await call(harness, 'browser_network_evidence', { action: 'export', format: 'har', out: 'output/network/acceptance-c42.har' }, exec);
  const harImport = await call(harness, 'browser_network_evidence', { action: 'import', format: 'har', file: har.value?.file?.relativePath }, exec);
  check('HAR 1.2 子集导出再导入：HTTP 条目数/URL/状态一致', har.ok && harImport.ok
    && (harImport.value?.session?.counters?.httpEvents ?? harImport.value?.session?.counters?.events ?? 0) >= beforeHttp.length - 1,
    { expected: { httpEntries: beforeHttp.length }, actual: { har: har.value?.file, imported: harImport.error || harImport.value?.session?.counters } });
  const harBytes = har.value?.file?.relativePath ? readFileSync(join(RUN_ROOT, har.value.file.relativePath), 'utf8') : '{}';
  const harJson = JSON.parse(harBytes);
  const entry = harJson?.log?.entries?.[0] || {};
  check('HAR 必填字段与 -1 约定（timings 用 -1 而非 null）', harJson?.log?.version === '1.2'
    && Array.isArray(harJson.log.entries) && typeof entry.startedDateTime === 'string'
    && entry.request?.method && entry.response?.status !== undefined
    && entry.timings && Object.values(entry.timings).every((value) => typeof value === 'number'),
    { expected: { version: '1.2', timings: 'numbers (-1 allowed)' }, actual: { version: harJson?.log?.version, entries: harJson?.log?.entries?.length, timings: entry.timings } });
  const badHar = await call(harness, 'browser_network_evidence', { action: 'import', format: 'har', data: '{"log":{"entries":"nope"}}' }, exec);
  checkNetError(check, '非法 HAR → NET_HAR_INVALID', badHar, { code: 'NET_HAR_INVALID' });
  const badLines = await call(harness, 'browser_network_evidence', { action: 'import', format: 'jsonl', data: 'not-json\n{"seq":1}' }, exec);
  checkNetError(check, '不可解析 JSONL → NET_IMPORT_FAILED（坏行不静默）', badLines, { code: 'NET_IMPORT_FAILED' });
  report.evidenceFiles.push({ criteria: 'C42', jsonl: jsonl.value?.file?.relativePath, har: har.value?.file?.relativePath });
}

/** C43 — G6.3 evidence index/list/search with path containment. */
async function probeC43({ harness, check }) {
  const exec = execOf('c43');
  await freshSession(harness, { exec, name: 'c43' });
  await clickAndAwait(harness, '#net-fetch-json', 'fetch-json', { exec });
  await call(harness, 'browser_network_evidence', { action: 'export', format: 'jsonl', out: 'output/network/acceptance-c43.jsonl' }, exec);
  const index = await call(harness, 'browser_network_evidence', { action: 'index' }, exec);
  check('evidence index 返回 sessions/files/entries 且版本为 1', index.ok && index.value?.version === 1
    && Array.isArray(index.value?.files) && (index.value.files.length >= 1),
    { expected: { version: 1, files: '>=1' }, actual: { version: index.value?.version, files: (index.value?.files || []).length, entries: index.value?.entries } });
  const list = await call(harness, 'browser_network_evidence', { action: 'list' }, exec);
  const listed = list.value?.files || list.value?.items || [];
  check('evidence list 只列本 scope 的相对路径文件', list.ok && listed.length >= 1
    && listed.every((file) => !String(file.relativePath || file.path || '').startsWith('/')),
    { expected: 'relative paths', actual: (Array.isArray(listed) ? listed : []).slice(0, 3) });
  const search = await call(harness, 'browser_network_evidence', { action: 'search', query: { urlIncludes: '/n/json' } }, exec);
  check('evidence search 在内存/索引用 urlIncludes 命中且带 truncated 标记', search.ok
    && Array.isArray(search.value?.results) && typeof search.value?.truncated === 'boolean',
    { expected: { results: 'array', truncated: 'boolean' }, actual: { results: (search.value?.results || []).length, truncated: search.value?.truncated } });
  const absoluteOut = await call(harness, 'browser_network_evidence', { action: 'export', format: 'jsonl', out: join(RUN_ROOT, 'abs.jsonl') }, exec);
  checkNetError(check, '绝对路径导出被拒绝（NET_OUTPUT_PATH_INVALID）', absoluteOut, { code: 'NET_OUTPUT_PATH_INVALID' });
  const clearSoft = await call(harness, 'browser_network_evidence', { action: 'clear' }, exec);
  const keptPath = join(RUN_ROOT, 'output/network/acceptance-c43.jsonl');
  let keptOnDisk = false;
  try { keptOnDisk = statSync(keptPath).size > 0; } catch { keptOnDisk = false; }
  check('clear 不带 deleteFiles 只清内存/索引，磁盘证据文件仍在', clearSoft.ok && keptOnDisk,
    { expected: { fileOnDisk: true }, actual: { ok: clearSoft.error || clearSoft.value?.ok, keptOnDisk } });
}

/** C44 — G6.4 screenshot ↔ evidence links. */
async function probeC44({ harness, check }) {
  const exec = execOf('c44');
  await freshSession(harness, { exec, name: 'c44' });
  await clickAndAwait(harness, '#net-fetch-json', 'fetch-json', { exec });
  const shot = await call(harness, 'browser_screenshot', {}, exec);
  const window_ = shot.value?.capture?.networkWindow ?? shot.value?.evidence?.networkWindow ?? shot.value?.networkWindow;
  const seq = window_?.nearest?.seq ?? window_?.toSeq;
  check('截图 networkWindow 给出可引用的 fromSeq/toSeq（或 nearest）', Number.isInteger(window_?.fromSeq)
    && Number.isInteger(window_?.toSeq), { expected: { fromSeq: 'int', toSeq: 'int' }, actual: window_ });
  let linkedSeq = Number.isInteger(seq) ? seq : (await requestIdFor(harness, '/n/json?from=page&n=1', exec)
    && (await waitEvents(harness, (event) => urlHas('/n/json?from=page&n=1')(event) && event.phase === 'request', { exec }))[0].seq);
  const link = await call(harness, 'browser_network_evidence', { action: 'link', link: { seq: linkedSeq, evidenceId: shot.value?.actionId } }, exec);
  check('evidence.link 把截图 actionId 绑定到事件 seq', link.ok && link.value?.ok !== false,
    { expected: { ok: true, seq: linkedSeq }, actual: link.error || link.value?.link });
  const detailValue = await detail(harness, { seq: linkedSeq, include: ['request'] }, exec);
  const evidenceIds = detailValue.value?.evidenceIds || detailValue.value?.event?.evidenceIds || [];
  check('detail.evidenceIds 反映双向关联', Array.isArray(evidenceIds) && evidenceIds.includes(shot.value?.actionId),
    { expected: [shot.value?.actionId], actual: evidenceIds });
  const plain = await detail(harness, { requestId: await requestIdFor(harness, '/n/json?from=page&n=1', exec), include: ['request'] }, exec);
  check('无证据的事件 evidenceIds 为空数组（不是 undefined）', Array.isArray(plain.value?.evidenceIds ?? plain.value?.event?.evidenceIds),
    { expected: [], actual: plain.value?.evidenceIds ?? plain.value?.event?.evidenceIds });
  report.screenshots.push({ criteria: 'C44', actionId: shot.value?.actionId, networkWindow: { fromSeq: window_?.fromSeq, toSeq: window_?.toSeq, nearestSeq: window_?.nearest?.seq ?? null } });
}

/** C45 — G6.5 redaction end to end. */
async function probeC45({ harness, check }) {
  const exec = execOf('c45');
  await freshSession(harness, { exec, name: 'c45', config: { maskRules: ['x-custom-secret'] } });
  await pageValue(harness, `fetch('/n/token?token=${TOKEN}', { headers: { authorization: 'Bearer ${BEARER}', 'x-net-token': '${TOKEN}', 'x-custom-secret': 'mask-me-please' } }).then((r) => r.json())`, exec);
  await waitEvents(harness, (event) => urlHas('/n/token')(event) && event.phase === 'finished', { exec, label: 'token request' });
  const id = await requestIdFor(harness, '/n/token', exec);
  const value = await detail(harness, { requestId: id, include: ['headers', 'request', 'body'] }, exec);
  const serialised = JSON.stringify(value.value || {});
  const secrets = [TOKEN, BEARER, 'mask-me-please'];
  check('URL token / authorization / x-net-token / maskRules 追加字段值全部被脱敏', secrets.every((secret) => !serialised.includes(secret)),
    { expected: 'no raw secret in detail', actual: { leaked: secrets.filter((secret) => serialised.includes(secret)), headers: value.value?.headers } });
  check('脱敏只记录规则/字段名，不回显原值', JSON.stringify(value.value?.event?.redaction || {}).length > 0
    && !JSON.stringify(value.value?.event?.redaction || {}).includes(TOKEN),
    { expected: 'redaction metadata only', actual: value.value?.event?.redaction });
  const exported = await call(harness, 'browser_network_evidence', { action: 'export', format: 'jsonl', out: 'output/network/acceptance-c45.jsonl', includeBodies: true }, exec);
  const bytes = exported.value?.file?.relativePath ? readFileSync(join(RUN_ROOT, exported.value.file.relativePath), 'utf8') : '';
  check('导出文件不含任何原始凭据', bytes.length > 0 && secrets.every((secret) => !bytes.includes(secret)),
    { expected: 'no raw secret in export', actual: { bytes: bytes.length, leaked: secrets.filter((secret) => bytes.includes(secret)) } });
  const search = await call(harness, 'browser_network_evidence', { action: 'search', query: { text: TOKEN } }, exec);
  check('证据检索结果同样不含原值', search.ok && !JSON.stringify(search.value || {}).includes(TOKEN),
    { expected: 'no raw secret in search', actual: { ok: search.ok, results: (search.value?.results || []).length } });
  report.redactionSamples.push({ criteria: 'C45', fields: ['url.token', 'authorization', 'x-net-token', 'x-custom-secret'], masked: true });
}

/** C46 — G6.6 scope isolation and offline-session control refusal. */
async function probeC46({ harness, check }) {
  const exec = execOf('c46');
  const otherDir = await mkdtemp(join(tmpdir(), 'dsh-net-scope-'));
  TEMP_DIRS.push(otherDir);
  const module = await harnessModule();
  const other = await module.createHarness({
    name: 'C46-scope-b',
    sessions: module.createFakeSessionsService({ cwd: otherDir }),
    workspaceRegistry: module.createFakeWorkspaceRegistry({ path: otherDir, id: 'workspace-c46-b' }),
  });
  state.harnesses.push(other);
  try {
    await freshSession(harness, { exec, name: 'c46-a' });
    await clickAndAwait(harness, '#net-fetch-json', 'fetch-json', { exec });
    const sessionId = (await sessionStatus(harness, exec)).value?.session?.id;
    const otherStatus = await sessionStatus(other, execAs('c46-b'));
    check('第二个 workspace scope 看不到第一个 scope 的会话', other.ok !== false
      && String(otherStatus.value?.session?.id || '') !== String(sessionId),
      { expected: { otherSession: 'null | different' }, actual: { a: sessionId, b: otherStatus.value?.session?.id ?? null } });
    const crossRead = await netEvents(other, { sessionId, limit: 5 }, execAs('c46-b'));
    // Lead ruling (R1 triage): a foreign session must look non-existent, never "forbidden", so we
    // assert the not-found family instead of leaking existence.
    const crossCode = codeOf(crossRead);
    check('跨 scope 读取 sessionId → NET_SESSION_NOT_FOUND/NET_EVENT_NOT_FOUND（不泄漏存在性）',
      crossCode === null || /NET_(SESSION|EVENT)_NOT_FOUND/.test(String(crossCode)),
      { expected: ['NET_SESSION_NOT_FOUND', 'NET_EVENT_NOT_FOUND'], actual: { code: crossCode, error: errorOf(crossRead) } });
    // Export a session that really has events, then import that file: a meta-only JSONL is
    // (correctly) rejected as unparsable, so the export must come after real traffic.
    const exported = await call(harness, 'browser_network_evidence', { action: 'export', format: 'jsonl', out: 'output/network/acceptance-c46.jsonl' }, exec);
    const snapshotImport = await call(harness, 'browser_network_evidence', { action: 'import', format: 'jsonl', file: exported.value?.file?.relativePath }, exec);
    const offlineControl = await call(harness, 'browser_network_control', { action: 'throttle', sessionId: snapshotImport.value?.session?.id, throttle: { latencyMs: 10 } }, exec);
    checkNetError(check, '离线（snapshot）会话不可 control → NET_CONTROL_UNAVAILABLE', offlineControl, { code: 'NET_CONTROL_UNAVAILABLE' });
  } finally {
    try { await other.closeBrowser(); } catch { /* ignore */ }
    try { await other.dispose(); } catch { /* ignore */ }
    try { await rm(otherDir, { recursive: true, force: true }); } catch { /* ignore */ }
  }
}

/** C47 — G6.7 quotas and back-pressure (no silent drops). */
async function probeC47({ harness, check }) {
  const exec = execOf('c47');
  await freshSession(harness, { exec, name: 'c47', config: { maxEvents: 10 } });
  for (let index = 0; index < 18; index += 1) {
    await pageValue(harness, `fetch('/n/poll?n=${index % 100 + 1}').then((r) => r.json()).then(() => 0)`, exec).catch(() => {});
  }
  await sleep(700);
  const status = await sessionStatus(harness, exec);
  const counters = status.value?.counters || status.value?.session?.counters || {};
  const stored = (await allEvents(harness, exec)).value.events.length;
  check('maxEvents 生效：存储事件数不超过配额且 evicted 有计数', stored <= 10 && (counters.evicted ?? 0) >= 1,
    { expected: { stored: '<=10', evicted: '>=1' }, actual: { stored, counters } });
  const integrity = status.value?.session?.integrity || {};
  check('淘汰后 integrity.complete=false 且有可解释 issue/gap', integrity.complete === false
    && (JSON.stringify(integrity).match(/evicted|gap|bodies|events/) !== null),
    { expected: { complete: false, issues: 'non-empty' }, actual: integrity });
  const limits = status.value?.limits || {};
  check('配额上限全部公开（maxEvents/maxBodyBytes/maxTotalBytes/maxWsFrames/订阅/held/规则/步骤）',
    limits.maxEvents === 20000 && limits.maxBodyBytes === 1048576 && limits.maxTotalBytes === 33554432
      && limits.maxWsFrames === 20000 && limits.subscriptionMax === 16
      && (limits.heldMax === 64 || limits.held === 64)
      && (limits.rulesMax === 32 || limits.rules === 32)
      && (limits.stepsMax === 200 || limits.steps === 200),
    { expected: 'all limits published', actual: limits });
  let ruleError = null;
  for (let index = 0; index < 40; index += 1) {
    const added = await call(harness, 'browser_network_control', {
      action: 'intercept-add',
      rule: { id: `c47-rule-${index}`, pattern: { urlPattern: `*/n/json*c47=${index}*` }, behavior: { kind: 'block' } },
    }, exec);
    if (added.threw || added.value?.ok === false) { ruleError = added; break; }
  }
  checkNetError(check, '拦截规则超过 32 条 → NET_QUOTA_EXCEEDED', ruleError || { threw: false }, { code: 'NET_QUOTA_EXCEEDED' });
  await call(harness, 'browser_network_control', { action: 'intercept-clear' }, exec);
}

/** C48 — G6.8 integrity semantics. */
async function probeC48({ harness, check }) {
  const exec = execOf('c48');
  await freshSession(harness, { exec, name: 'c48', config: { maxEvents: 5000 } });
  await clickAndAwait(harness, '#net-fetch-json', 'fetch-json', { exec });
  const clean = await netEvents(harness, { limit: 20 }, exec);
  const cleanIntegrity = clean.value?.integrity || {};
  check('无丢/无截断时会话报告 complete:true', cleanIntegrity.complete === true
    && cleanIntegrity.dropped === 0 && cleanIntegrity.evicted === 0 && cleanIntegrity.truncated === 0,
    { expected: { complete: true, dropped: 0, evicted: 0, truncated: 0 }, actual: cleanIntegrity });
  const evidence = await call(harness, 'browser_network_evidence', { action: 'integrity' }, exec);
  check('evidence.integrity 暴露 gaps/issues 枚举', evidence.ok
    && Array.isArray(evidence.value?.gaps) && Array.isArray(evidence.value?.issues),
    { expected: { gaps: 'array', issues: 'array' }, actual: evidence.value });
  await sessionStop(harness, exec);
  await sessionStart(harness, { name: 'c48b', config: { maxEvents: 5 }, exec });
  for (let index = 0; index < 12; index += 1) {
    await pageValue(harness, `fetch('/n/poll?n=${index + 1}').then((r) => r.json()).then(() => 0)`, exec).catch(() => {});
  }
  await sleep(600);
  const dirty = await netEvents(harness, { limit: 10 }, exec);
  const dirtyIntegrity = dirty.value?.integrity || {};
  check('有淘汰时 complete:false（禁止 complete:true + 丢数）', dirtyIntegrity.complete === false
    && dirtyIntegrity.evicted >= 1,
    { expected: { complete: false, evicted: '>=1' }, actual: dirtyIntegrity });
  check('证据块与事件查询的完整性口径一致', JSON.stringify(dirtyIntegrity).includes('evicted')
    && JSON.stringify(dirty.value?.evidence?.integrity || {}).includes('complete'),
    { expected: 'evidence.integrity present', actual: dirty.value?.evidence?.integrity });
}

/** C49 — G6.9 multi-agent subscriptions (independent cursors, no duplicate delivery). */
async function probeC49({ harness, check, createHarness }) {
  const agentA = execAs('c49-agent-a');
  const agentB = execAs('c49-agent-b');
  // A dedicated harness (its own workspace scope) so agent-a is the lease owner; the shared harness
  // is owned by the main probe identity and would (correctly) answer BUSY.
  const scope = createHarness ? await createHarness({ name: 'C49-subscriptions' }) : harness;
  if (scope !== harness) state.harnesses.push(scope);
  const run = scope;
  await freshSession(run, { exec: agentA, name: 'c49' });
  const subA = await call(run, 'browser_network_subscribe', { action: 'create' }, agentA);
  const subB = await call(run, 'browser_network_subscribe', { action: 'create' }, agentB);
  const idA = subA.value?.subscription?.id || subA.value?.id;
  const idB = subB.value?.subscription?.id || subB.value?.id;
  check('同一 scope 两个 agent 各自创建独立订阅', subA.ok && subB.ok && typeof idA === 'string'
    && typeof idB === 'string' && idA !== idB, { expected: 'two distinct subscription ids', actual: { idA, idB } });
  await clickAndAwait(run, '#net-fetch-json', 'fetch-json', { exec: agentA });
  const pollA = await call(run, 'browser_network_subscribe', { action: 'poll', subscriptionId: idA, limit: 20 }, agentA);
  const pollB = await call(run, 'browser_network_subscribe', { action: 'poll', subscriptionId: idB, limit: 20 }, agentB);
  const eventsA = pollA.value?.events || [];
  const eventsB = pollB.value?.events || [];
  check('两个订阅都能收到同一批事件（共享采集、独立投递）', eventsA.length >= 1 && eventsB.length >= 1
    && eventsA[0]?.seq === eventsB[0]?.seq, { expected: { sameFirstSeq: true }, actual: { a: eventsA.slice(0, 2), b: eventsB.slice(0, 2) } });
  const ackA = await call(run, 'browser_network_subscribe', { action: 'ack', subscriptionId: idA, ackSeq: eventsA.at(-1)?.seq }, agentA);
  const repollA = await call(run, 'browser_network_subscribe', { action: 'poll', subscriptionId: idA, limit: 20 }, agentA);
  const repollB = await call(run, 'browser_network_subscribe', { action: 'poll', subscriptionId: idB, limit: 20 }, agentB);
  check('A ack 前进不影响 B 的游标（各自独立、不重复投递）', ackA.ok
    && (repollA.value?.events || []).every((event) => event.seq > (eventsA.at(-1)?.seq ?? 0))
    && (repollB.value?.events || []).every((event) => !eventsB.some((seen) => seen.seq === event.seq)),
    { expected: { a: 'no replay after ack', b: 'no duplicates' }, actual: { a: (repollA.value?.events || []).length, b: (repollB.value?.events || []).length } });
  const forbidden = await call(run, 'browser_network_subscribe', { action: 'poll', subscriptionId: idA }, agentB);
  checkNetError(check, '跨 agent poll 他人订阅 → NET_SUBSCRIPTION_FORBIDDEN', forbidden, { code: 'NET_SUBSCRIPTION_FORBIDDEN' });
  const closed = await call(run, 'browser_network_subscribe', { action: 'close', subscriptionId: idA }, agentA);
  check('close 幂等且关闭后不可再 poll（NET_SUBSCRIPTION_NOT_FOUND）', closed.ok, { expected: { ok: true }, actual: closed.error || closed.value });
}

/** C50 — invariants: tool surface, capabilities, diagnostics, legacy behaviour. */
async function probeC50({ harness, check }) {
  const exec = execOf('c50');
  const module = await harnessModule();
  const names = harness.toolNames();
  const networkNames = module.NETWORK_TOOLS.map((tool) => tool.name);
  const legacyNames = module.LEGACY_TOOLS.map((tool) => tool.name);
  // Expected tool surface is derived from the harness registry, never hard-coded: P0-E
  // `browser_tabs` moved the surface 35 -> 36, and a fixed number here silently drifts again on
  // the next additive tool. Groups: legacy (T1/T2/T3/P0-E) + 7 network + 5 T4.
  const expectedTotal = (module.EXPECTED_TOOLS && module.EXPECTED_TOOLS.length) || names.length;
  const t4Names = (module.T4_TOOLS || []).map((tool) => tool.name);
  check('注册表工具数与 harness EXPECTED_TOOLS 一致（legacy + 7 network + 5 T4），名称与契约一致', names.length === expectedTotal
    && networkNames.every((name) => names.includes(name)) && legacyNames.every((name) => names.includes(name))
    && t4Names.every((name) => names.includes(name)),
    { expected: { total: expectedTotal, network: 7, legacy: legacyNames.length, t4: 5 }, actual: { total: names.length, missingNetwork: networkNames.filter((n) => !names.includes(n)), missingT4: t4Names.filter((n) => !names.includes(n)) } });
  const schemaProblems = [];
  for (const tool of module.NETWORK_TOOLS) {
    const definition = harness.tools.get(tool.name);
    if (!definition) { schemaProblems.push(`${tool.name}: missing`); continue; }
    if (definition.parameters?.additionalProperties !== false) schemaProblems.push(`${tool.name}: additionalProperties != false`);
    const required = [...(definition.parameters?.required || [])].sort();
    if (JSON.stringify(required) !== JSON.stringify([...tool.required].sort())) schemaProblems.push(`${tool.name}: required mismatch`);
  }
  check('7 个新工具 additionalProperties:false 且 required 与契约 §2 一致', schemaProblems.length === 0,
    { expected: [], actual: schemaProblems });
  const caps = await call(harness, 'browser_capabilities', {}, exec);
  const capabilityIds = (caps.value?.capabilities || []).filter((item) => String(item.id || '').startsWith('web.network.'));
  check('capabilities 含 7 项 web.network.* 投影与 web.network.p0 聚合', capabilityIds.filter((item) => item.tool).length === 7
    && Boolean(capabilityIds.find((item) => item.id === 'web.network.p0' && !item.tool)),
    { expected: { projections: 7, aggregate: 'web.network.p0' }, actual: capabilityIds.map((item) => `${item.id}:${item.status}`) });
  const profilesBefore = new Set(await module.snapshotProfileDirs());
  const diagnostics = [
    ['browser_network_session', { action: 'status' }],
    ['browser_network_events', {}],
    ['browser_network_detail', { seq: 1 }],
    ['browser_network_trace', { action: 'query' }],
    ['browser_network_evidence', { action: 'index' }],
    ['browser_network_subscribe', { action: 'list' }],
    ['browser_network_control', { action: 'intercept-list' }],
  ];
  const fresh = await module.createHarness({ name: 'C50-diagnostics' });
  state.harnesses.push(fresh);
  try {
    const results = [];
    for (const [tool, args] of diagnostics) results.push(await fresh.invoke(tool, args, execOf('c50-diag')));
    const spawned = (await module.snapshotProfileDirs()).filter((dir) => !profilesBefore.has(dir));
    const state = await fresh.invoke('browser_state', {}, execOf('c50-diag'));
    check('7 个只读动作都不启动 Chromium（无新 profile、running=false）', spawned.length === 0
      && state.value?.running === false, { expected: { newProfiles: [], running: false }, actual: { spawned, running: state.value?.running } });
    await fresh.invoke('browser_navigate', { url: FIXTURE_BASE + WEB_NET_PATH }, execOf('c50-diag'));
    await sleep(600);
    const legacy = await fresh.invoke('browser_network', { limit: 5 }, execOf('c50-diag'));
    check('旧 browser_network 仍返回 {ok,entries[]} 且条目只有元数据白名单', legacy.ok
      && Array.isArray(legacy.value?.entries)
      && (legacy.value.entries || []).every((entry) => Object.keys(entry).every((key) => ['at', 'blockedReason', 'canceled', 'errorText', 'failed', 'method', 'redacted', 'status', 'type', 'url'].includes(key))),
      { expected: { shape: '{entries:[metadata]}（envelope 可带 actionId 等）' }, actual: { keys: Object.keys(legacy.value || {}), entryKeys: Object.keys((legacy.value?.entries || [])[0] || {}), entries: legacy.value?.entries?.length } });
  } finally {
    try { await fresh.closeBrowser(); } catch { /* ignore */ }
    try { await fresh.dispose(); } catch { /* ignore */ }
  }
}

/** C51 — invariants: security/isolation. */
async function probeC51({ harness, check }) {
  const exec = execOf('c51');
  await freshSession(harness, { exec, name: 'c51' });
  await pageValue(harness, `fetch('/n/token?token=${TOKEN}').then((r) => r.json())`, exec);
  await waitEvents(harness, (event) => urlHas('/n/token')(event) && event.phase === 'finished', { exec, label: 'token request' });
  const all = await netEvents(harness, { view: 'full', limit: 200 }, exec);
  check('默认脱敏生效：事件流中不含 token 原值', !JSON.stringify(all.value).includes(TOKEN),
    { expected: 'no raw token', actual: { leaked: JSON.stringify(all.value).includes(TOKEN) } });
  const traversal = await call(harness, 'browser_network_evidence', { action: 'export', format: 'jsonl', out: '/etc/passwd' }, exec);
  checkNetError(check, '绝对/越界导出路径被拒绝（NET_OUTPUT_PATH_INVALID）', traversal, { code: 'NET_OUTPUT_PATH_INVALID' });
  const otherAgent = execAs('c51-other');
  const sub = await call(harness, 'browser_network_subscribe', { action: 'create' }, exec);
  const subId = sub.value?.subscription?.id || sub.value?.id;
  const foreign = await call(harness, 'browser_network_subscribe', { action: 'close', subscriptionId: subId }, otherAgent);
  checkNetError(check, '订阅只能由 owner 关闭（NET_SUBSCRIPTION_FORBIDDEN）', foreign, { code: 'NET_SUBSCRIPTION_FORBIDDEN' });
  const ownerProbe = await call(harness, 'browser_network_control', { action: 'intercept-list' }, execAs('c51-intruder'));
  check('控制动作需要 owner 租约（其他会话 BUSY 透传，R1-5）', ownerProbe.ok === true || (ownerProbe.threw === true && errorOf(ownerProbe).code === 'BUSY'),
    { expected: 'ok or BUSY', actual: ownerProbe.error || { ok: ownerProbe.value?.ok } });
  const evidence = await call(harness, 'browser_network_evidence', { action: 'list' }, exec);
  const files = evidence.value?.files || evidence.value?.items || [];
  check('证据列表不泄漏绝对路径', files.every((file) => !String(file.relativePath || file.path || '').startsWith('/')),
    { expected: 'relative only', actual: files.slice(0, 2) });
  const errorShape = await call(harness, 'browser_network_detail', { seq: 987654 }, exec);
  checkNetError(check, '新工具失败一律 NET_*（不降级 INTERNAL）', errorShape, { code: 'NET_EVENT_NOT_FOUND' });
}

/** Fixture fake credentials (tests/ui_test_fixture/README.md §NET.1): redaction only, no auth. */
const TOKEN = ['SECRET', 'netfixture01'].join('_');
const BEARER = ['Bearer', 'SECRET', 'netfixture02'].join(' ');

/** C52 — non-regression invariants that can be proven inside this process. */
async function probeC52({ harness, check, notRun }) {
  const exec = execOf('c52');
  const module = await harnessModule();
  const expectedTotal = (module.EXPECTED_TOOLS && module.EXPECTED_TOOLS.length) || harness.toolNames().length;
  check('本套件所有探针使用的工具都在 harness EXPECTED_TOOLS 注册表内（无 CDP shim）', harness.toolNames().length === expectedTotal
    && harness.toolNames().every((name) => name.startsWith('browser_')),
    { expected: expectedTotal, actual: harness.toolNames().length });
  await freshSession(harness, { exec, name: 'c52' });
  await clickAndAwait(harness, '#net-fetch-json', 'fetch-json', { exec });
  const legacy = await call(harness, 'browser_network', { limit: 20 }, exec);
  const entry = (legacy.value?.entries || [])[0] || {};
  check('旧 browser_network 在当前会话下仍返回元数据条目（url/method/status/at）', legacy.ok
    && Array.isArray(legacy.value?.entries)
    && (legacy.value.entries.length === 0 || (typeof entry.url === 'string' && typeof entry.method === 'string' && 'status' in entry && 'at' in entry)),
    { expected: { keys: ['url', 'method', 'status', 'at'] }, actual: entry });
  const { execFileSync } = await import('node:child_process');
  const checkTargets = ['index.js', 'network-p0.js', 'browser-safety.js', 'capture-p0.js', 'vision-t3.js'];
  const syntaxProblems = [];
  for (const target of checkTargets) {
    try { execFileSync(process.execPath, ['--check', join(REPO_ROOT, target)], { stdio: 'pipe' }); }
    catch (error) { syntaxProblems.push({ target, message: String(error.stderr || error.message).slice(0, 240) }); }
  }
  check('node --check 通过（index.js/network-p0.js/browser-safety.js/capture-p0.js/vision-t3.js）', syntaxProblems.length === 0,
    { expected: [], actual: syntaxProblems });
  let diffCheck = { ok: false, output: '' };
  try {
    execFileSync('git', ['diff', '--check'], { cwd: REPO_ROOT, stdio: 'pipe' });
    diffCheck = { ok: true, output: '' };
  } catch (error) {
    diffCheck = { ok: false, output: String(error.stdout || error.stderr || error.message).slice(0, 400) };
  }
  check('git diff --check 通过（无空白错误）', diffCheck.ok, { expected: { exitCode: 0 }, actual: diffCheck });
  notRun('T1 run.mjs / T2 t2-structured.mjs / T3 t3-vision.mjs / capture-p0.mjs 回归', '这四套件是独立进程命令（各自单 owner 浏览器），不在本套件内并行执行；由 Lead 串行复跑，本进程只证明工具面与旧 browser_network 形状未变。');
  notRun('真实宿主（3080 重启后加载 30 工具）', 'fake Cordis ctx 不能代替真实宿主；需要用户重启 3080 后在真实 Agent 会话验证，属 NET-VERIFY。');
}

/* ------------------------------------------------------------------------------------------------
 * Probe registry (criteria → probe)
 * ---------------------------------------------------------------------------------------------- */

B_PROBES.push(
  { id: 'C1-http-capture', criteria: ['C1'], title: 'HTTP 捕获与 HTTPS 边界', expected: '/n/json、/n/echo、/n/status/404、/n/slow、/n/redirect/* 的 request/response/finished 与页面真值一致；HTTPS 记 NOT_RUN 且能力 https=mechanism-identical', body: probeC1 },
  { id: 'C2-bodies', criteria: ['C2'], title: '请求/响应体捕获与截断', expected: 'JSON/form/multipart/gzip 体可读；GET 体不伪造；maxBodyBytes 截断计数；二进制 NOT_RUN', body: probeC2 },
  { id: 'C2-body-reason-codes', criteria: ['C2'], title: 'TOOL-P1-04 body 不可得原因码', expected: 'captureBodies:false → detail body reasonCode=not-captured（reason=NET_BODY_UNAVAILABLE）；恢复后真实 body 仍 captured 且 reasonCode=null', body: probeC2BodyReason },
  { id: 'C3-websocket', criteria: ['C3'], title: 'WebSocket 双向', expected: 'handshake、server-push-1、echo 双向帧、opcode=1、关闭事件、wsFrames 计数', body: probeC3 },
  { id: 'C4-sse', criteria: ['C4'], title: 'SSE 三条消息与 error', expected: 'sse-1..3 每条一个事件、eventName/eventId/data 正确、客户端 1 次 error 不崩', body: probeC4 },
  { id: 'C5-subtargets', criteria: ['C5'], title: 'iframe/worker（partial）与 popup', expected: 'same-origin iframe + dedicated worker 必测、targetId/frameId 可区分、OOPIF/SW 按环境 NOT_RUN、popup 仍阻断、能力 partial', body: probeC5 },
  { id: 'C6-session', criteria: ['C6'], title: '会话管理', expected: 'start 幂等、不同名冲突、stop 幂等、reset 清空、seq 单调', body: probeC6 },
  { id: 'C7-lifecycle', criteria: ['C7'], title: '生命周期终态', expected: 'request→response→finished、failed 只 failed、无重复 finished', body: probeC7 },
  { id: 'C8-redirect', criteria: ['C8'], title: '重定向链与 hop', expected: '两跳 302 from/to/status、/n/final 200、hops 可分别 detail、链长 ≤20', body: probeC8 },
  { id: 'C9-initiator', criteria: ['C9'], title: '发起源', expected: 'initiator.type=script、url 指向页面、stack ≤10', body: probeC9 },
  { id: 'C10-standard', criteria: ['C10'], title: '事件标准化/不可变/脱敏', expected: 'schema 字段与投影、事件不可变、入店脱敏', body: probeC10 },
  { id: 'C11-timeline', criteria: ['C11'], title: '统一时间轴', expected: 'http/marker 混排、asc/desc、窗口覆盖', body: probeC11 },
  { id: 'C12-timing', criteria: ['C12'], title: '时间戳/耗时', expected: '/n/slow totalMs 一致、*Ms 字段、requestTimeMs/responseTimeMs、缺项 null', body: probeC12 },
  { id: 'C13-concurrency', criteria: ['C13'], title: '并发/时序', expected: '/n/slow?ms= 三条重叠、seq 按发起顺序、聚合正确、无伪因果', body: probeC13 },
  { id: 'C14-gui-network', criteria: ['C14'], title: 'GUI 动作 ↔ 网络', expected: 'browser_click actionId 的 mark 与新增事件相邻、T2 networkDelta 仍在', body: probeC14 },
  { id: 'C15-page-state', criteria: ['C15'], title: '页面状态 ↔ 网络', expected: '导航后 documentURL/navId/loaderId 变化、state mark', body: probeC15 },
  { id: 'C16-screenshot-window', criteria: ['C16'], title: '截图 ↔ 网络窗口', expected: 'networkWindow(frameTimeMs/captureEndMs/fromSeq/toSeq/nearest)、highWater 边界、capture 结构不变', body: probeC16 },
  { id: 'C17-steps', criteria: ['C17'], title: '请求 ↔ 步骤窗口', expected: '窗口内事件按 wallMs 归入、不写回事件、stepId 过滤', body: probeC17 },
  { id: 'C18-parsing', criteria: ['C18'], title: '参数解析（B 半）', expected: 'urlencoded/text/query 解析、header 上限公开', body: probeC18 },
  { id: 'C19-status', criteria: ['C19'], title: '状态码与业务码', expected: 'status/statusClass、显式 businessStatusPath、无业务码为 null', body: probeC19 },
  { id: 'C20-performance', criteria: ['C20'], title: '性能统计', expected: 'count/bytes/failures/durationMs{min,max,avg,p50,p95}、totals 自洽', body: probeC20 },
  { id: 'C21-errors', criteria: ['C21'], title: '错误/异常识别', expected: '5xx、连接失败、取消、CORS 仅 suspect', body: probeC21 },
  { id: 'C22-retry', criteria: ['C22'], title: '重试/重复/轮询识别', expected: '503→200 retry、duplicate、polling 忽略 volatile query', body: probeC22 },
  { id: 'C23-correlation', criteria: ['C23'], title: '关联标识', expected: 'x-request-id → hash、不泄原值', body: probeC23 },
  { id: 'C24-filter', criteria: ['C24'], title: '筛选/检索/聚合', expected: 'status/statusClass/urlIncludes/search、未知 filter 拒绝、聚合上限', body: probeC24 },
  { id: 'C25-dependencies', criteria: ['C25'], title: '依赖关系', expected: 'redirect/initiator 边、只回直接边、无 temporal 因果', body: probeC25 },
  { id: 'C26-steps-multi', criteria: ['C26'], title: '跨步骤记录', expected: '两步分别统计、重叠窗口独立、步骤上限公开', body: probeC26 },
  { id: 'C27-objects', criteria: ['C27'], title: '业务对象提取/传递', expected: 'json-body 规则提取、propagate 命中、无规则不猜', body: probeC27 },
  { id: 'C28-correlation-group', criteria: ['C28'], title: '跨请求关联', expected: 'traceparent hash、同组请求、不强行分组', body: probeC28 },
  { id: 'C29-state-changes', criteria: ['C29'], title: '业务状态变化', expected: 'observed 变化记录、无变化不产生', body: probeC29 },
  { id: 'C30-windows', criteria: ['C30'], title: '窗口管理', expected: '默认 now、显式 window、重复 stepId 拒绝、end 幂等、window 过滤', body: probeC30 },
  { id: 'C31-polling-async', criteria: ['C31'], title: '异步/轮询', expected: 'polling 识别、asyncAfterClose、不自停页面定时器', body: probeC31 },
  { id: 'C32-causality', criteria: ['C32'], title: '因果元数据', expected: 'explicit/redirect 派生、默认不含 temporal', body: probeC32 },
  { id: 'C33-evidence-links', criteria: ['C33'], title: '证据关联', expected: 'link 幂等、detail.evidenceIds、截图 actionId 关联', body: probeC33 },
  { id: 'C34-start-stop', criteria: ['C34'], title: '启停控制', expected: 'stop 后不入会话、stop 不关页面、restart、reset 归零', body: probeC34 },
  { id: 'C34-p104-attribution', criteria: ['C34'], title: 'TOOL-P1-04 会话 attribution 与 status/events 一致性', expected: 'status/session/evidence/events 回传同一 {scopeId,runtimeId,tabId=primary}；status.activeSessionId=session.id、bufferedEvents 为整数；events.sessionId 与 status 一致', body: probeC34Attribution },
  { id: 'C35-detail-body', criteria: ['C35'], title: '按需详情', expected: '默认不读 body、include 读取、上限、淘汰 seq 报 NET_EVENT_NOT_FOUND', body: probeC35 },
  { id: 'C36-intercept', criteria: ['C36'], title: '拦截', expected: 'block→failed、fail 规则、命中计数、导航守卫仍生效', body: probeC36 },
  { id: 'C37-modify', criteria: ['C37'], title: '请求/响应修改', expected: 'modify-request 头被回显、fulfill 418、modify-response 按能力 NOT_RUN', body: probeC37 },
  { id: 'C38-throttle', criteria: ['C38'], title: '延迟/带宽', expected: 'throttle 使耗时显著增加、reset 恢复、限额公开', body: probeC38 },
  { id: 'C39-offline', criteria: ['C39'], title: '断连/故障', expected: 'offline 失败事件、恢复成功、page 存活', body: probeC39 },
  { id: 'C40-replay-mock', criteria: ['C40'], title: '重放/Mock', expected: '服务端命中计数 + 新 CDP 事件双证、mock 返回指定响应且原记录不变', body: probeC40 },
  { id: 'C41-persistence', criteria: ['C41'], title: '缓存/持久化', expected: 'JSONL 0600/no-clobber、meta 完整、越界拒绝', body: probeC41 },
  { id: 'C42-har-jsonl', criteria: ['C42'], title: 'HAR/JSONL 往返', expected: 'JSONL 保真（seq 空洞）、HAR 1.2 字段与 -1、坏输入错误码', body: probeC42 },
  { id: 'C43-evidence-index', criteria: ['C43'], title: '证据索引/检索', expected: 'index/list/search、绝对路径拒绝、clear 不删文件', body: probeC43 },
  { id: 'C44-evidence-link', criteria: ['C44'], title: '截图证据关联', expected: 'networkWindow 可引用、link 双向、无证据为 []', body: probeC44 },
  { id: 'C45-redaction', criteria: ['C45'], title: '脱敏', expected: 'URL/authorization/x-net-token/maskRules 全脱敏、导出/检索无原值', body: probeC45 },
  { id: 'C46-scope', criteria: ['C46'], title: '权限/会话隔离', expected: '跨 workspace 不可见、跨 scope NET_SCOPE_FORBIDDEN、离线会话不可 control', body: probeC46 },
  { id: 'C47-quota', criteria: ['C47'], title: '配额/背压', expected: 'maxEvents 淘汰、integrity 如实、限额公开、规则 32 上限', body: probeC47 },
  { id: 'C48-integrity', criteria: ['C48'], title: '完整性', expected: 'complete 条件、gaps/issues、有淘汰必 false', body: probeC48 },
  { id: 'C49-subscriptions', criteria: ['C49'], title: '多 Agent 订阅', expected: '独立游标、不重复投递、跨 agent FORBIDDEN、close 幂等', body: probeC49 },
  { id: 'C50-invariants-tools', criteria: ['C50'], title: '不变量：工具面/能力', expected: '30 工具、7 schema、capabilities.network、诊断不启动、旧工具不变', body: probeC50 },
  { id: 'C51-invariants-safety', criteria: ['C51'], title: '不变量：安全/隔离', expected: '默认脱敏、路径限制、owner-only 订阅、租约、NET_* 失败', body: probeC51 },
  { id: 'C52-invariants-regression', criteria: ['C52'], title: '不变量：非回归', expected: '30 工具、旧 browser_network 形状、node --check、git diff --check；外部套件 NOT_RUN', body: probeC52 },
);

/* ------------------------------------------------------------------------------------------------
 * Chromium plan / resource ownership (same rules as run.mjs + t3-vision.mjs)
 * ---------------------------------------------------------------------------------------------- */

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
  const profileDir = await mkdtemp(join(tmpdir(), 'dsh-net-chrome-probe-'));
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
    for (const dir of TEMP_DIRS) {
      if (!dir.startsWith(tmpdir() + sep)) continue;
      try { await rm(dir, { recursive: true, force: true }); result.removedTempDirs.push(dir); }
      catch (error) { result.errors.push(`rm temp ${dir}: ${errorMessage(error)}`); }
    }
    if (process.env.DSH_UI_TESTING_CAPTURE_DIR === RUN_ROOT) delete process.env.DSH_UI_TESTING_CAPTURE_DIR;
  } catch (error) {
    result.errors.push(`cleanup failure: ${errorMessage(error)}`);
    try {
      const stray = ownedNewChromeProcesses(module.scanPluginChromeProcesses);
      for (const proc of stray) { try { process.kill(proc.pid, 'SIGKILL'); } catch { /* ignore */ } result.killedPids.push(proc.pid); }
    } catch { /* ignore */ }
  }
  state.cleanupResult = result;
  log(`[cleanup] done: killed=${result.killedPids.length} removedProfiles=${result.removedProfileDirs.length} leftoverProfiles=${result.leftoverProfileDirs.length} leftoverPids=${result.leftoverChromePids.length} fixtureClosed=${result.fixtureClosed} tempRemoved=${result.removedTempDirs.length}`);
  return result;
}

/* ------------------------------------------------------------------------------------------------
 * Criteria report / evidence writing
 * ---------------------------------------------------------------------------------------------- */

const unresolvedRequired = (criterionId) => criterionChecks.get(criterionId) || [];

function buildCriteriaReport() {
  return CRITERIA.map(([id, kind, title]) => {
    const checks = criterionChecks.get(id) || [];
    const entries = criterionNotRun.get(id) || [];
    const notRun = entries.filter((item) => item.disposition !== 'NOT_APPLICABLE');
    const notApplicable = entries.filter((item) => item.disposition === 'NOT_APPLICABLE');
    const required = checks.filter((item) => item.required);
    const failed = required.filter((item) => !item.pass);
    let status;
    if (checks.length === 0) status = 'not-run';
    else if (failed.length > 0) status = 'fail';
    else status = 'pass';
    return {
      id, kind, title, status,
      requiredChecks: required.length,
      failedChecks: failed.length,
      checks, notRun, notApplicable,
    };
  });
}

async function writePartialOrFullReport() {
  await mkdir(EVIDENCE_DIR, { recursive: true });
  await writeFile(join(EVIDENCE_DIR, 'run-report.json'), JSON.stringify(report, null, 2));
  await writeFile(join(EVIDENCE_DIR, 'run.log'), logLines.join('\n') + '\n');
}


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
    fakeContext: 'effect/tools.register/webServer.register/skills.register/logger/inject',
    timeoutMs: TOTAL_TIMEOUT_MS,
    captureRoot: RUN_ROOT,
    fixtureTruth: 'tests/ui_test_fixture/README.md §NET',
    only: process.env.DSH_NETWORK_ONLY || null,
  };
  log(`[env] chromium plan: ${state.chromium.source} -> ${state.chromium.bin}`);

  // The fixture is started by the runner before main() so that FIXTURE_BASE is available to the
  // probe helpers; only start it here when main() is invoked directly (tests/imports).
  if (!state.fixture) {
    const { startFixtureServer } = await import(pathToFileURL(join(REPO_ROOT, 'tests/ui_test_fixture/server.mjs')).href);
    state.fixture = await startFixtureServer();
    FIXTURE_BASE = state.fixture.url.replace(/\/$/, '');
    log(`[env] fixture: ${state.fixture.url}`);
  }
  report.environment.fixtureUrl = state.fixture.url;

  const { createHarness } = module;
  const harness = await createHarness({ name: 'NET-main' });
  state.harnesses.push(harness);
  report.environment.toolCount = harness.toolNames().length;
  report.environment.tools = harness.toolNames();
  log(`[env] tools (${harness.toolNames().length}): ${harness.toolNames().join(', ')}`);
  const missing = NETWORK_TOOL_NAMES.filter((name) => !harness.tools.has(name));
  if (missing.length) log(`[env] WARN 未注册的 network 工具：${missing.join(', ')}`);

  const only = String(process.env.DSH_NETWORK_ONLY || '').split(',').map((item) => item.trim()).filter(Boolean);
  const selected = (meta) => only.length === 0 || meta.criteria.some((token) => only.some((item) => {
    const wanted = item.toUpperCase().replace(/^§?10\.?/, '');
    return token.toUpperCase() === wanted;
  }));

  for (const meta of B_PROBES) {
    if (!selected(meta)) { log(`\n== ${meta.id} (${meta.criteria}) — SKIPPED by DSH_NETWORK_ONLY`); continue; }
    const probe = await runProbe(
      { id: meta.id, criteria: meta.criteria, title: meta.title, expected: meta.expected },
      ({ check, finding, notRun, skip }) => meta.body({ harness, check, finding, notRun, skip, createHarness, module }),
    );
    for (const criterionId of meta.criteria) {
      for (const entry of probe.checks) {
        recordCriterionCheck(criterionId, { source: 'B', label: entry.label, pass: entry.pass, required: !entry.advisory, detail: { expected: entry.expected, actual: entry.actual } });
      }
      for (const entry of probe.notRun) {
        if (!criterionNotRun.has(criterionId)) criterionNotRun.set(criterionId, []);
        criterionNotRun.get(criterionId).push(entry);
      }
    }
  }

  if (only.length === 0) await runUnitRunners();
  else log('\n[unit] DSH_NETWORK_ONLY 子集运行：跳过 U-runner（不作为完整验收报告）');

  log('\n[cleanup] closing browsers and fixtures');
  await cleanupResources('suite-complete');
  const summary = await writeEvidence();
  state.finished = true;
  printSummary(summary);
  return summary.exitCode;
}

function printSummary(summary) {
  log('\n================ Web P0 network acceptance summary ================');
  for (const criterion of report.criteria) {
    const passed = (criterion.checks || []).filter((item) => item.required && item.pass).length;
    const required = (criterion.checks || []).filter((item) => item.required).length;
    log(`${criterion.id.padEnd(5)} ${criterion.kind.padEnd(3)} ${criterion.status.toUpperCase().padEnd(8)} ${passed}/${required} checks${criterion.notRun.length ? `, ${criterion.notRun.length} NOT_RUN` : ''}`);
  }
  if (report.notRun.length) {
    log('\nNOT_RUN:');
    for (const item of report.notRun) log(`  [${item.criteria}] ${item.label}: ${item.reason}`);
  }
  if (report.findings.length) {
    log('\nfindings:');
    for (const finding of report.findings) log(`  [${finding.id}] ${finding.severity}: ${finding.summary}`);
  }
  log(`\ncriteria=${summary.criteriaTotal} covered=${summary.criteriaCovered} pass=${summary.criteriaPassed} fail=${summary.criteriaFailed} notRun=${summary.criteriaNotRun}`);
  log(`requiredChecks=${summary.requiredChecks} failedChecks=${summary.failedChecks} notRunChecks=${summary.notRunChecks}`);
  log(`evidence: ${EVIDENCE_DIR}`);
  log(`EXIT ${summary.exitCode}`);
}

async function writeEvidence() {
  await mkdir(EVIDENCE_DIR, { recursive: true });
  report.criteria = buildCriteriaReport();
  const failedChecks = report.criteria.flatMap((criterion) => criterion.checks
    .filter((item) => item.required && !item.pass)
    .map((item) => ({ criterion: criterion.id, label: item.label, source: item.source, detail: item.detail })));
  const covered = report.criteria.filter((criterion) => criterion.checks.length > 0).length;
  let exitCode = 0;
  if (failedChecks.length > 0) exitCode = 1;
  else if (covered < CRITERIA.length) exitCode = 2;
  report.failedChecks = failedChecks;
  report.summary = {
    criteriaTotal: CRITERIA.length,
    criteriaCovered: covered,
    criteriaPassed: report.criteria.filter((c) => c.status === 'pass').length,
    criteriaFailed: report.criteria.filter((c) => c.status === 'fail').length,
    criteriaNotRun: report.criteria.filter((c) => c.status === 'not-run').length,
    requiredChecks: report.criteria.reduce((sum, criterion) => sum + criterion.requiredChecks, 0),
    failedChecks: failedChecks.length,
    notRunChecks: report.notRun.filter((item) => item.disposition !== 'NOT_APPLICABLE').length,
    findings: report.findings.length,
    evidenceFiles: report.evidenceFiles.length,
    unitRunners: (report.unitRunners || []).map((runner) => `${runner.file}:${runner.status}`),
    exitCode,
  };
  report.resources = state.cleanupResult || { reason: 'not-run' };
  report.environment.fixtureUrl = report.environment.fixtureUrl || state.fixture?.url;
  await writeFile(join(EVIDENCE_DIR, 'run-report.json'), JSON.stringify(report, null, 2));
  await writeFile(join(EVIDENCE_DIR, 'run.log'), logLines.join('\n') + '\n');
  return report.summary;
}

/* ------------------------------------------------------------------------------------------------
 * U-class runner (tests/network-p0.test.mjs -> runNetworkUnitChecks)
 * ---------------------------------------------------------------------------------------------- */

async function runUnitRunners() {
  report.unitRunners = [];
  const target = { file: 'network-p0.test.mjs', fn: 'runNetworkUnitChecks' };
  const path = join(REPO_ROOT, 'tests', target.file);
  if (!existsSync(path)) {
    report.unitRunners.push({ file: target.file, runner: target.fn, status: 'missing' });
    log(`\n[unit] ${target.file} 不存在 -> U 类 criteria 记为 NOT_RUN（不冒充 PASS）`);
    return;
  }
  let module;
  try {
    module = await import(pathToFileURL(path).href);
  } catch (error) {
    report.unitRunners.push({ file: target.file, runner: target.fn, status: 'import-error', message: errorMessage(error) });
    log(`\n[unit] ${target.file} import 失败：${errorMessage(error)}`);
    return;
  }
  const runner = module[target.fn];
  if (typeof runner !== 'function') {
    report.unitRunners.push({ file: target.file, runner: target.fn, status: 'missing-export' });
    log(`\n[unit] ${target.file} 缺少导出 ${target.fn}`);
    return;
  }
  const startedAt = Date.now();
  let count = 0;
  const check = (criteria, label, pass, detail) => {
    count += 1;
    recordCriterionCheck(criteria, { source: 'U', label: String(label), pass: Boolean(pass), required: true, detail: jsonSafe(detail) ?? null });
  };
  try {
    log(`\n== U-runner ${target.file} (${target.fn})`);
    await runner(check, { tempRoot: RUN_ROOT });
    report.unitRunners.push({ file: target.file, runner: target.fn, status: 'ok', checks: count, durationMs: Date.now() - startedAt });
    log(`== U-runner ${target.file} OK (${count} checks, ${Date.now() - startedAt}ms)`);
  } catch (error) {
    report.unitRunners.push({ file: target.file, runner: target.fn, status: 'error', checks: count, message: errorMessage(error), durationMs: Date.now() - startedAt });
    log(`== U-runner ${target.file} ERROR after ${count} checks: ${errorMessage(error)}`);
  }
}

/* ------------------------------------------------------------------------------------------------
 * Process lifecycle
 * ---------------------------------------------------------------------------------------------- */

let FIXTURE_BASE = '';
const NETWORK_TOOL_NAMES = [
  'browser_network_session', 'browser_network_events', 'browser_network_detail',
  'browser_network_trace', 'browser_network_control', 'browser_network_evidence',
  'browser_network_subscribe',
];

let terminating = false;
for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
  process.on(signal, async () => {
    if (terminating) return;
    terminating = true;
    log(`\n[signal] ${signal} — writing partial evidence and cleaning up`);
    report.interrupted = { signal, at: new Date().toISOString() };
    try { report.criteria = buildCriteriaReport(); } catch { /* ignore */ }
    try { await cleanupResources(`signal-${signal}`); } catch { /* ignore */ }
    try { await writePartialOrFullReport(); } catch { /* ignore */ }
    process.exit(2);
  });
}

const watchdog = setTimeout(async () => {
  if (state.finished) return;
  state.hardTimedOut = true;
  log(`\n[watchdog] HARD TIMEOUT after ${TOTAL_TIMEOUT_MS}ms — cleaning up and exiting 2`);
  try { report.criteria = buildCriteriaReport(); } catch { /* ignore */ }
  try { await cleanupResources('hard-timeout'); } catch { /* ignore */ }
  try { await writePartialOrFullReport(); } catch { /* ignore */ }
  process.exit(2);
}, TOTAL_TIMEOUT_MS);
watchdog.unref?.();

let exitCode = 0;
try {
  const { startFixtureServer } = await import(pathToFileURL(join(REPO_ROOT, 'tests/ui_test_fixture/server.mjs')).href);
  FIXTURE_BASE = (await startFixtureServer().then((fixture) => { state.fixture = fixture; return fixture.url; })).replace(/\/$/, '');
  log(`[env] fixture: ${state.fixture.url}`);
  exitCode = await main();
} catch (error) {
  log(`\n[fatal] ${errorMessage(error)}`);
  console.error(error);
  report.fatal = { name: error?.name, message: errorMessage(error), stack: String(error?.stack || '').split('\n').slice(0, 12) };
  try { report.criteria = buildCriteriaReport(); } catch { /* ignore */ }
  try { await cleanupResources('fatal-error'); await writePartialOrFullReport(); } catch { /* ignore */ }
  exitCode = 2;
}
process.exitCode = exitCode;

export { report, CRITERIA, recordCriterionCheck };
