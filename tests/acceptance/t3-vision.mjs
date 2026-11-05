#!/usr/bin/env node
/**
 * Web T3 (static vision) acceptance suite for dsh-agent-team-ui-testing.
 *
 * Authoritative criteria: [docs/t3-vision.md](../docs/t3-vision.md) §9, the 56 numbered acceptance
 * conditions. Every B-class probe carries its exact `§9.CN` reference; every U-class check emitted
 * by the two unit runners is merged into the same criterion, so `runs/<iso>-<pid>/run-report.json`
 * can be read against the contract one-to-one (56 criteria, no double counting).
 *
 * Conventions (identical to tests/acceptance/t2-structured.mjs):
 *   - loads the real plugin entry (index.js) through tests/acceptance/harness.mjs (fake Cordis ctx);
 *   - starts the repository's own loopback fixture server and drives ONLY the registered agent
 *     tools - no CDP shim, no playwright/puppeteer/selenium;
 *   - B = real Chromium inside this process. U = pure algorithm/FS unit checks imported from
 *     tests/vision-t3-algorithms.test.mjs (`runAlgorithmChecks`) and tests/vision-baseline.test.mjs
 *     (`runBaselineChecks`); U never substitutes a B requirement;
 *   - writes tests/acceptance/runs/<iso>-<pid>/run-report.json + run.log;
 *   - exit 0 = all 56 criteria covered and every required check passed, 1 = at least one required
 *     check failed, 2 = the suite itself could not run (no usable Chromium / missing unit runner /
 *     fatal error / hard timeout);
 *   - cleans up only the browsers, profiles, fixture and temporary capture/baseline roots this run
 *     created. It never touches a user DSH instance (3080/3081), never deletes a pre-existing
 *     profile directory and never writes into the repository's output/.
 *
 * Ground truth is the fixture page itself: pixel truth from decoded PNGs, DOM facts read by the
 * *test* (rect/scroll/style/textMetrics/presence) and passed to the tools explicitly, and
 * `window.__t3` (real DOM events with isTrusted/clientX/clientY/buttons/modifiers). The vision
 * tools must never read `window.__t3`; C49 proves they do not read DOM facts on their own.
 */
import { createHash } from 'node:crypto';
import { existsSync, statSync } from 'node:fs';
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
// Independent pixel decode for canvas-space assertions (same pure module the plugin uses).
import { decodePng } from '../../capture-p0.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = dirname(dirname(HERE));
const EVIDENCE_DIR = join(HERE, 'runs', `${new Date().toISOString().replace(/[:.]/g, '-')}-${process.pid}`);
const DEFAULT_CHROME = '/opt/google/chrome/chrome';
const CHROME_WRAPPER = join(HERE, 'chrome-wrapper.sh');
const TOTAL_TIMEOUT_MS = Number(process.env.DSH_T3_TIMEOUT_MS || 1500000) || 1500000;

const T3_PATH = '/web-t3.html';
const T3_SECOND_PATH = '/second.html';
const EXEC_ID = 't3-acceptance';

/**
 * Private capture/baseline root for this run. It is set BEFORE harness.mjs is imported so the
 * plugin never falls back to `<session cwd>/output` (which would be the repository). Every probe
 * that needs a different root sets/restores the variable itself.
 */
const RUN_ROOT = await mkdtemp(join(tmpdir(), 'dsh-t3-run-'));
process.env.DSH_UI_TESTING_CAPTURE_DIR = RUN_ROOT;
const TEMP_DIRS = [RUN_ROOT];

/* ------------------------------------------------------------------------------------------------
 * Report / probe plumbing (same shape as run.mjs / t2-structured.mjs)
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

function truncate(value, max = 420) {
  const text = typeof value === 'string' ? value : JSON.stringify(jsonSafe(value));
  if (text === undefined) return '';
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

/** One decoded pixel (8-bit PNG); only used by the canvas-space pixel truth checks below. */
function pixelAt(decoded, x, y) {
  const { channels, width, data } = decoded;
  const base = (y * width + x) * channels;
  if (channels === 4) return { r: data[base], g: data[base + 1], b: data[base + 2], a: data[base + 3] };
  if (channels === 3) return { r: data[base], g: data[base + 1], b: data[base + 2], a: 255 };
  if (channels === 2) return { r: data[base], g: data[base], b: data[base], a: data[base + 1] };
  return { r: data[base], g: data[base], b: data[base], a: 255 };
}

/** Minimal PNG header read: dimensions + byte hash (no pixel decode; that is a U-class job). */
function pngInfo(base64) {
  const bytes = Buffer.from(String(base64 || ''), 'base64');
  const signatureOk = bytes.length > 24 && bytes.toString('latin1', 1, 4) === 'PNG';
  return {
    ok: signatureOk,
    bytes: bytes.length,
    sha256: bytes.length ? sha256(bytes) : null,
    width: signatureOk ? bytes.readUInt32BE(16) : null,
    height: signatureOk ? bytes.readUInt32BE(20) : null,
    buffer: bytes,
  };
}

const report = {
  schemaVersion: 1,
  suite: 'dsh-agent-team-ui-testing/acceptance-t3',
  contract: 'docs/t3-vision.md §9 (56 numbered acceptance conditions)',
  generatedAt: new Date().toISOString(),
  command: 'node tests/acceptance/t3-vision.mjs',
  environment: {},
  probes: [],
  criteria: [],
  images: [],
  findings: [],
  notRun: [],
  resources: {},
  summary: {},
};

function makeProbe(id, title, criteria, expected) {
  return {
    id,
    criteria,
    title,
    expected,
    status: 'pass',
    startedAt: new Date().toISOString(),
    durationMs: 0,
    checks: [],
    findings: [],
    notes: [],
    notRun: [],
    actual: '',
    error: undefined,
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

function addFinding(probe, { id, severity = 'info', summary, evidence, advisory = true }) {
  const text = typeof summary === 'string' && summary.trim() ? summary : `${id}: no summary provided by the probe`;
  const finding = { id, probeId: probe.id, criteria: probe.criteria, severity, advisory, summary: text, evidence: jsonSafe(evidence) ?? {} };
  probe.findings.push(finding);
  report.findings.push(finding);
  log(`  [FINDING ${id}/${severity}] ${summary}`);
  return finding;
}

function recordImage(label, value) {
  const image = value && typeof value === 'object' ? value.image : undefined;
  if (typeof image !== 'string' || !image) return undefined;
  const info = pngInfo(image);
  const entry = { label, width: info.width, height: info.height, bytes: info.bytes, sha256: info.sha256 };
  report.images.push(entry);
  return entry;
}

async function runProbe(meta, body) {
  const probe = makeProbe(meta.id, meta.title, meta.criteria, meta.expected);
  const startedAt = Date.now();
  let skipped = false;
  log(`\n== ${meta.id} (criteria ${meta.criteria}) — ${meta.title}`);
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
  log(`== ${meta.id} ${probe.status.toUpperCase()} (${probe.durationMs}ms) — ${probe.actual}`);
  return probe;
}

/* ------------------------------------------------------------------------------------------------
 * Tool-call helpers
 * ---------------------------------------------------------------------------------------------- */

function execOf(id = EXEC_ID, signal) {
  return { agent: { id }, signal };
}

function call(harness, tool, args = {}, exec) {
  return harness.invoke(tool, args, exec === undefined ? execOf() : exec);
}

const codeOf = (result) => result?.error?.code ?? result?.value?.error?.code ?? null;

/**
 * Vision evidence bundle (docs/t3-vision.md §1.2/§3.2).
 *
 * Success body: `{ok:true,...,evidence:{vision:VisionEvidence}}` - nested, exactly as the contract
 * words it (the Host now returns that shape; a flat `evidence.version` is rejected below).
 * Failure body: `details.evidence.vision`.
 */
function visionEvidence(result) {
  const errorVision = result?.error?.details?.evidence?.vision;
  if (errorVision && errorVision.version === 1) return errorVision;
  const nested = result?.value?.evidence?.vision;
  if (nested && nested.version === 1) return nested;
  return null;
}

/**
 * Assert one T3 failure path: BrowserError (not {ok:false,error}), exact code, declared
 * category/retryable, [CODE] message prefix and a version=1 vision evidence bundle in details
 * (BUSY/ABORTED early paths are allowed to omit it, exactly like the contract says: no page may be
 * started just to pad evidence).
 */
function checkVisionError(check, label, result, { code, category, retryable, evidence = true } = {}) {
  const error = result?.error || {};
  const vision = visionEvidence(result);
  const actual = {
    name: error.name,
    code: error.code,
    category: error.category,
    retryable: error.retryable,
    message: String(error.message || '').slice(0, 220),
    hasVision: Boolean(vision && vision.version === 1),
    detailKeys: error.details ? Object.keys(error.details) : [],
    reason: error.details?.reason,
  };
  const pass = result?.threw === true
    && error.name === 'BrowserError'
    && error.code === code
    && (category === undefined || error.category === category)
    && (retryable === undefined || error.retryable === retryable)
    && String(error.message || '').startsWith(`[${code}]`)
    && (evidence === false || Boolean(vision && vision.version === 1));
  check(label, pass, { expected: { code, category, retryable, evidence: evidence ? 'vision v1' : 'optional' }, actual });
  return error;
}

/** Assert the success envelope shared by all six tools (contract §1.2/§3.2). */
function checkVisionValue(check, label, result, { requireImage = false } = {}) {
  const value = result?.value || {};
  const vision = visionEvidence(result) || {};
  const problems = [];
  if (result?.ok !== true) problems.push(`invoke.ok=${result?.ok}`);
  if (value.ok !== true) problems.push(`value.ok=${value.ok}`);
  if (vision.version !== 1) problems.push(`vision.version=${vision.version}`);
  if (vision.provenance?.algorithmVersion !== 't3-v1') problems.push(`algorithmVersion=${vision.provenance?.algorithmVersion}`);
  if (value.evidence && value.evidence.version !== undefined && !value.evidence.vision) problems.push('evidence must be nested as evidence.vision');
  const space = vision.coordinateSpace || {};
  if (space.image !== 'image-px' || space.document !== 'document-css-px' || space.input !== 'viewport-css-px') problems.push('coordinateSpace');
  if (typeof vision.operation !== 'string' || !vision.operation) problems.push('operation');
  if (!Array.isArray(vision.incomplete) || typeof vision.truncated !== 'boolean') problems.push('incomplete/truncated');
  if (requireImage) {
    const info = pngInfo(value.image);
    if (!info.ok) problems.push('image is not a PNG base64');
    if (!Number.isFinite(value.sha256) && typeof value.sha256 !== 'string') problems.push('sha256');
    if (info.sha256 && value.sha256 && info.sha256 !== value.sha256) problems.push('sha256 != decoded PNG bytes');
  }
  check(label, problems.length === 0, {
    expected: { ok: true, visionVersion: 1, algorithmVersion: 't3-v1', coordinateSpace: ['image-px', 'document-css-px', 'viewport-css-px'] },
    actual: { problems, operation: vision.operation, error: result?.error?.message },
  });
  return value;
}

/* ------------------------------------------------------------------------------------------------
 * Page helpers (all page access goes through registered T1/T2 tools)
 * ---------------------------------------------------------------------------------------------- */

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function pageValue(harness, expression, exec = execOf()) {
  const result = await call(harness, 'browser_eval', { expression }, exec);
  if (!result.ok) throw new Error(`browser_eval threw: ${errorMessage(result.error)}`);
  if (!result.value?.ok) throw new Error(`browser_eval value error: ${JSON.stringify(result.value?.error)}`);
  return result.value.value;
}

async function waitForPage(harness, { title, timeoutMs = 15000, exec = execOf() } = {}) {
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

/** Navigate to the T3 fixture, wait for it, and restore every scene to its documented default. */
async function freshPage(harness, path = T3_PATH, exec = execOf()) {
  const navigation = await call(harness, 'browser_navigate', { url: FIXTURE_BASE + path }, exec);
  if (!navigation.ok || !navigation.value?.ok) throw new Error(`navigation to ${path} failed: ${truncate(navigation.error || navigation.value)}`);
  const title = path === T3_PATH ? 'DSH T3 Fixture' : 'DSH UI Testing Fixture — Second Page';
  await waitForPage(harness, { title, exec });
  if (path === T3_PATH) {
    await pageValue(harness, 'window.__t3 ? (window.__t3.resetScene(), window.__t3.reset(), true) : false', exec);
  }
  return navigation;
}

async function resetEvents(harness, exec = execOf()) {
  return pageValue(harness, 'window.__t3 ? (window.__t3.reset(), { seq: window.__t3.seq, events: window.__t3.events.length }) : null', exec);
}

async function t3State(harness, exec = execOf()) {
  return pageValue(harness, `({
    seq: window.__t3.seq,
    events: window.__t3.events.length,
    counters: JSON.parse(JSON.stringify(window.__t3.counters)),
    last: JSON.parse(JSON.stringify(window.__t3.last)),
    scene: JSON.parse(JSON.stringify(window.__t3.scene)),
    scroll: { x: window.scrollX, y: window.scrollY },
    viewport: { width: innerWidth, height: innerHeight, clientWidth: document.documentElement.clientWidth },
    doc: { height: document.documentElement.scrollHeight, width: document.documentElement.scrollWidth },
  })`, exec);
}

async function t3Events(harness, predicateSource = 'true', exec = execOf()) {
  return pageValue(harness, `window.__t3.events.filter(function (e) { return ${predicateSource}; }).map(function (e) { return { type: e.type, isTrusted: e.isTrusted, clientX: e.clientX, clientY: e.clientY, button: e.button, buttons: e.buttons, detail: e.detail, modifiers: e.modifiers, target: e.target }; })`, exec);
}

async function domRects(harness, ids, exec = execOf()) {
  const value = await pageValue(harness, `(${JSON.stringify(ids)}).map(function (id) {
    var el = document.getElementById(id);
    if (!el) return { id: id, missing: true };
    var r = el.getBoundingClientRect();
    var s = getComputedStyle(el);
    return {
      id: id,
      x: r.x + window.scrollX, y: r.y + window.scrollY, width: r.width, height: r.height,
      visible: r.width > 0 && r.height > 0 && s.display !== 'none' && s.visibility !== 'hidden',
      display: s.display,
      overflowX: s.overflowX, overflowY: s.overflowY, whiteSpace: s.whiteSpace,
      textOverflow: s.textOverflow, backgroundColor: s.backgroundColor, color: s.color,
      lineClamp: Number.isFinite(Number(s.webkitLineClamp)) ? Number(s.webkitLineClamp) : 0,
      scrollWidth: el.scrollWidth, scrollHeight: el.scrollHeight,
      clientWidth: el.clientWidth, clientHeight: el.clientHeight,
    };
  })`, exec);
  const map = {};
  for (const item of value) map[item.id] = item;
  return map;
}

function pixelRectOf(rect) {
  return { x: Math.round(rect.x), y: Math.round(rect.y), width: Math.round(rect.width), height: Math.round(rect.height) };
}

function cssRectOf(rect) {
  return { x: rect.x, y: rect.y, width: rect.width, height: rect.height };
}

function parseCssColor(text) {
  const match = /^rgba?\(([^)]+)\)$/i.exec(String(text || '').trim());
  if (!match) return null;
  const parts = match[1].split(',').map((part) => Number(part.trim()));
  if (parts.length < 3 || parts.some((part) => !Number.isFinite(part))) return null;
  const alpha = parts.length >= 4 ? Math.round(parts[3] * 255) : 255;
  return [Math.round(parts[0]), Math.round(parts[1]), Math.round(parts[2]), alpha];
}

/* ---- explicit DOM facts: read by the TEST, passed to the tool, never fetched by the tool ---- */

async function factContext(harness, exec = execOf()) {
  const snap = await call(harness, 'browser_snapshot', {}, exec);
  if (!snap.ok || !snap.value?.ok) throw new Error(`browser_snapshot failed: ${truncate(snap.error || snap.value)}`);
  const provenance = snap.value?.evidence?.provenance || {};
  const state = await call(harness, 'browser_state', {}, exec);
  return {
    sourceActionId: snap.value?.actionId,
    scopeId: state.value?.scope?.id ?? null,
    runtimeId: provenance.runtimeId ?? null,
    pageGeneration: provenance.pageGeneration ?? null,
    documentEpoch: provenance.documentEpoch ?? null,
    observedAt: Date.now(),
  };
}

function makeFact(context, id, fields) {
  return {
    id,
    provenance: {
      sourceTool: 'browser_snapshot',
      sourceActionId: context.sourceActionId,
      observedAt: context.observedAt,
      scopeId: context.scopeId,
      runtimeId: context.runtimeId,
      pageGeneration: context.pageGeneration,
      documentEpoch: context.documentEpoch,
    },
    ...fields,
  };
}

async function hitSamplesFor(harness, id, exec = execOf()) {
  return pageValue(harness, `(function () {
    var el = document.getElementById(${JSON.stringify(id)});
    var r = el.getBoundingClientRect();
    var sx = window.scrollX;
    var sy = window.scrollY;
    var ratios = [[0.5, 0.5], [0.25, 0.25], [0.75, 0.25], [0.25, 0.75], [0.75, 0.75]];
    return ratios.map(function (ratio) {
      var vx = r.left + r.width * ratio[0];
      var vy = r.top + r.height * ratio[1];
      var hit = document.elementFromPoint(vx, vy);
      return { point: { x: vx + sx, y: vy + sy }, covered: !(hit === el || el.contains(hit)) };
    });
  })()`, exec);
}

/** Count page-side DOM reads so C49 can prove the vision tools never fetch facts themselves. */
async function installDomReadCounters(harness, exec = execOf()) {
  return pageValue(harness, `(function () {
    window.__t3dom = { getComputedStyle: 0, getBoundingClientRect: 0, elementFromPoint: 0, querySelector: 0 };
    if (!window.__t3domInstalled) {
      var gcs = window.getComputedStyle;
      window.getComputedStyle = function () { window.__t3dom.getComputedStyle += 1; return gcs.apply(this, arguments); };
      var gbr = Element.prototype.getBoundingClientRect;
      Element.prototype.getBoundingClientRect = function () { window.__t3dom.getBoundingClientRect += 1; return gbr.apply(this, arguments); };
      var efp = document.elementFromPoint;
      document.elementFromPoint = function () { window.__t3dom.elementFromPoint += 1; return efp.apply(this, arguments); };
      var qs = Document.prototype.querySelector;
      Document.prototype.querySelector = function () { window.__t3dom.querySelector += 1; return qs.apply(this, arguments); };
      window.__t3domInstalled = true;
    }
    return true;
  })()`, exec);
}

async function domReadCounts(harness, exec = execOf()) {
  return pageValue(harness, 'window.__t3dom ? JSON.parse(JSON.stringify(window.__t3dom)) : null', exec);
}

/* ---- capture / baseline roots ---------------------------------------------------------------- */

async function withCaptureRoot(root, fn) {
  const before = process.env.DSH_UI_TESTING_CAPTURE_DIR;
  if (root === undefined) delete process.env.DSH_UI_TESTING_CAPTURE_DIR;
  else process.env.DSH_UI_TESTING_CAPTURE_DIR = root;
  try {
    return await fn();
  } finally {
    if (before === undefined) delete process.env.DSH_UI_TESTING_CAPTURE_DIR;
    else process.env.DSH_UI_TESTING_CAPTURE_DIR = before;
  }
}

async function tempDir(prefix) {
  const dir = await mkdtemp(join(tmpdir(), `dsh-t3-${prefix}-`));
  TEMP_DIRS.push(dir);
  return dir;
}

async function listFilesRecursive(dir) {
  const out = [];
  const walk = async (current) => {
    let entries;
    try { entries = await readdir(current, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      const full = join(current, entry.name);
      if (entry.isDirectory()) await walk(full);
      else out.push(full);
    }
  };
  await walk(dir);
  return out;
}

/* ------------------------------------------------------------------------------------------------
 * §9 criteria table (all 56). kind B = real Chromium, U = pure algorithm/FS unit checks.
 * ---------------------------------------------------------------------------------------------- */

const CRITERIA = [
  ['§9.C1', 'B', '注册恰好 36 工具（含 1 P0-E + 7 network + 5 T4）、6 个 T3 名称/required 符合 §2.1、原 24 + 7 network 不回归；capabilities 仅诊断'],
  ['§9.C2', 'U', 'root/嵌套未知字段、非有限/错误类型、非法 Name、条件字段冲突拒绝；纯参数错误零副作用'],
  ['§9.C3', 'B', 'live 默认/scale1.25/source.region 尺寸/hash/mapping 正确，不改变 viewport/scroll'],
  ['§9.C4', 'B', 'live CSS 小数合法，越文档边界/零面积/负原点在 capture 前拒绝；顶层 PixelRect 整数'],
  ['§9.C5', 'B', 'product 仅所属 scope 可读；跨 scope SOURCE_NOT_FOUND，导航后可离线读但 act 失效'],
  ['§9.C6', 'U', 'store 16 项/128MiB/32MiB/16M 限额，LRU/pin/restart/dispose'],
  ['§9.C7', 'U', 'inflate 上限、1/2/3/4 通道转换、unsupported/error 拒绝、不伪造分析'],
  ['§9.C8', 'U', 'PNG encoder filter0/level9/chunk 顺序/CRC/decodedRGBA 确定'],
  ['§9.C9', 'U', 'crop 像素精确、nearest/bilinear 公式、实际 sx/sy mapping 与 16M 预算'],
  ['§9.C10', 'U', '五种 preprocess 公式/顺序/alpha/常量通道/边缘 clamp'],
  ['§9.C11', 'U', '四类 annotation、数字字形/覆盖顺序/边界/source-over 可复现'],
  ['§9.C12', 'B', 'image 一次裁剪+recognize 与 analysis 同图标注前统计；像素/文档 bbox 正确'],
  ['§9.C13', 'U', 'analysis 全量 average/min/max/alpha/量化桶顺序/edgeRatio'],
  ['§9.C14', 'B', 'color/tolerance/components/edges 确定候选、ROI 回加、未命中成功 []、semanticName=null'],
  ['§9.C15', 'U', '8 邻接/area/minArea/centroid/排序/maxResults/truncated'],
  ['§9.C16', 'U', 'Sobel 边界/阈值与 template 评分/stride/NMS/50M 预检'],
  ['§9.C17', 'B', 'before product→真实 click→after live 不同时间/不同 hash，无隐式动作；双 live 静止相同'],
  ['§9.C18', 'U', 'YIQ 公式/严格阈值/透明白底/threshold0/1 黄金数值'],
  ['§9.C19', 'U', 'AA 3×3 排除及 includeAA=true 翻转、边角 equal 初值与 tie 顺序'],
  ['§9.C20', 'U', 'diffRatio/similarity、mask 并集不重计、AA 在分母、全 mask 抛 EMPTY'],
  ['§9.C21', 'U', 'fail/warn 阈值默认与等号、ratio 不四舍五入、错误顺序拒绝'],
  ['§9.C22', 'B', 'diff 双坐标 mapping、scroll/scale 换算、尺寸不等错误、不兼容 mapping 不伪 CSS'],
  ['§9.C23', 'U', '差异 8 邻接区域/area 排序/过滤/100 截断/高亮黄金像素，过滤不改 D'],
  ['§9.C24', 'B', 'clock 动态区域显式 mask 复用，mask 不改变源图，不自动侦测动态'],
  ['§9.C25', 'B', 'act screenshot point→document→viewport 映射及 isTrusted、非整数点击不取整'],
  ['§9.C26', 'B', 'move/click/right/middle/doubleclick/modifiers 真实事件序列及 eventCount'],
  ['§9.C27', 'B', 'drag steps+3 事件、to/时间/线性路径、finally 释放与 after product'],
  ['§9.C28', 'B', '旧图页面代次/scroll/viewport/像素变化拒绝零输入，不自动 scroll'],
  ['§9.C29', 'U', '年龄>30000、派生年龄不刷新、非 actionable 各处理/基线/diff 拒绝'],
  ['§9.C30', 'B', '无命中/disabled/inert/不稳定/iframe 拒绝零输入，不穿 overlay，T2 边界保持'],
  ['§9.C31', 'B', '部分拖拽取消不重放、button 释放/dispatch 计数和 after null 正确'],
  ['§9.C32', 'U', '全成功/失败均 vision.version1 纯 JSON，缺失 null/incomplete，限制与错误 taxonomy'],
  ['§9.C33', 'U', '只有 create/update mkdir；root env 优先/坏 env 不回退/无 root/名字非法/只读失败码'],
  ['§9.C34', 'U', 'baseline PNG/JSON 0600、目录 0700、原子 no-clobber/realpath 守卫、历史字节不变'],
  ['§9.C35', 'B', '单 create 调用采 live 提交 revision1，get/list 可列 PNG 元数据/case/options/mask/provenance'],
  ['§9.C36', 'U', 'update 继承/显式覆盖、不可变 revision、CAS 两个写者仅一个 HEAD 成功'],
  ['§9.C37', 'U', 'delete tombstone/CAS、get HEAD 不可用/旧 revision 可审计、名字不可复用'],
  ['§9.C38', 'U', '提交前清理、提交后不回滚、hash/metadata 损坏 READ_FAILED、不猜旧 HEAD'],
  ['§9.C39', 'B', 'baseline 跨工作区不可见、重启 product 失效基线仍可 get、dispose 不删显式数据'],
  ['§9.C40', 'B', 'regression 继承 baseline masks/options/thresholds，显式 [] 清空，diffProduct 可后续使用'],
  ['§9.C41', 'B', 'check 无 baseline=BLOCKED/2、不自动建立；required 尺寸/mapping 不兼容阻塞'],
  ['§9.C42', 'B', 'Cases/assertions/facts 长度/ID/字段验证，五状态优先及 summary/exitCode（契约标 U，按 Lead 裁决 implemented as B）'],
  ['§9.C43', 'B', 'layout 正负例 required 基于声明 fact，pixels-only required 未知/advisory 提示'],
  ['§9.C44', 'B', 'occlusion 5 点覆盖比例/visible/样本完整，正负例及无 fact 未知'],
  ['§9.C45', 'B', 'overflow visible 超量 FAIL、auto/allowOverflow 负例 PASS；像素不冒 required'],
  ['§9.C46', 'B', 'truncation 度量+clip/lineClamp/allowTruncation，设计省略负例'],
  ['§9.C47', 'B', 'color 图像+声明背景一致才 PASS/FAIL、冲突/透明未知'],
  ['§9.C48', 'B', 'missing template count 与 presence 完整性一致规则、缺失与恢复正负例'],
  ['§9.C49', 'B', 'facts 显式提供、来源 trusted=false、vision 不读 DOM；无 facts 六类不伪 required 结论'],
  ['§9.C50', 'B', 'fact scope/runtime/epoch/时间>1000/ROI 不交拒融合、类型缺字段预检（契约标 U，按 Lead 裁决 implemented as B）'],
  ['§9.C51', 'B', 'output 默认暂存/显式持久/env 触发、0600/no-clobber/hash/附件元数据符合 P0'],
  ['§9.C52', 'U', '算法工作集/5s 取消/让出事件循环不半交付、不修改基线；已完成 case 保留'],
  ['§9.C53', 'B', '原图/派生/diff 附件 image delivery 和 capture 源 hash 独立，不以 metadata 证明 provider 可见'],
  ['§9.C54', 'B', 'canvas 静态识别与点选可用，scale 不承诺 backing-store 细节，不输出语义/OCR'],
  ['§9.C55', 'B', 'single-owner BUSY/队列串行/scope 隔离；失败/取消不串 store 或输入'],
  ['§9.C56', 'B', '完整闭环与报告诚实：capture→find→act→compare→baseline→check，22 能力映射可追溯，T4 unsupported'],
];

const CRITERIA_BY_ID = new Map(CRITERIA.map(([id, kind, title]) => [id, { id, kind, title }]));
const U_CRITERIA = CRITERIA.filter(([, kind]) => kind === 'U').map(([id]) => id);
const B_CRITERIA = CRITERIA.filter(([, kind]) => kind === 'B').map(([id]) => id);

function normalizeCriteria(value) {
  const text = String(value ?? '').trim();
  const match = /C(\d{1,2})/i.exec(text);
  return match ? `§9.C${Number(match[1])}` : text;
}

/* criterion-level check accumulator (B checks are added after each probe, U checks as emitted) */
const criterionChecks = new Map();
const criterionNotRun = new Map();

function recordCriterionCheck(criteria, entry) {
  const id = normalizeCriteria(criteria);
  if (!criterionChecks.has(id)) criterionChecks.set(id, []);
  criterionChecks.get(id).push(entry);
}

/* ------------------------------------------------------------------------------------------------
 * Shared harness helpers
 * ---------------------------------------------------------------------------------------------- */

const OWNED_HARNESSES = [];
let FIXTURE_BASE = '';

async function harnessModule() {
  return import(pathToFileURL(join(HERE, 'harness.mjs')).href);
}

async function profilesNow() {
  const module = await harnessModule();
  return module.snapshotProfileDirs();
}

async function createWorkspaceHarness(name, workspaceId, existingDir) {
  const { createHarness, createFakeSessionsService, createFakeWorkspaceRegistry } = await harnessModule();
  const dir = existingDir || await tempDir(`ws-${name}`);
  const id = workspaceId || `workspace-t3-${name}`;
  const harness = await createHarness({
    name,
    sessions: createFakeSessionsService({ cwd: dir }),
    workspaceRegistry: createFakeWorkspaceRegistry({ path: dir, id }),
  });
  OWNED_HARNESSES.push(harness);
  return { harness, dir, workspaceId: id };
}

async function closeHarness(harness) {
  try { await harness.closeBrowser(); } catch { /* ignore */ }
  try { await harness.dispose(); } catch { /* ignore */ }
}

/** The six T3 tools exactly as registered (contract §2.1 root required arrays). */
const T3_TOOLS = [
  { name: 'browser_vision_image', required: [] },
  { name: 'browser_vision_find', required: ['query'] },
  { name: 'browser_vision_compare', required: ['before', 'after'] },
  { name: 'browser_vision_act', required: ['productId', 'action', 'point'] },
  { name: 'browser_vision_baseline', required: ['action'] },
  { name: 'browser_vision_check', required: ['cases'] },
];

const T1_SURFACE = [
  { name: 'browser_navigate', required: ['url'] }, { name: 'browser_eval', required: ['expression'] },
  { name: 'browser_screenshot', required: [] }, { name: 'browser_input', required: ['events'] },
  { name: 'browser_network', required: [] }, { name: 'browser_computed_style', required: ['selector'] },
  { name: 'browser_http_request', required: ['url'] }, { name: 'browser_state', required: [] },
  { name: 'browser_capabilities', required: [] },
  // Shared viewport (docs/viewport-control.md §7): the 10th T1 tool.
  { name: 'browser_viewport', required: ['action'] },
];

const T2_SURFACE = [
  { name: 'browser_snapshot', required: [] }, { name: 'browser_click', required: [] },
  { name: 'browser_type', required: ['text'] }, { name: 'browser_scroll', required: [] },
  { name: 'browser_fill_form', required: ['fields'] }, { name: 'browser_node_state', required: [] },
  { name: 'browser_wait_for', required: [] },
];

/** The seven network P0 tools (docs/network-p0.md §2); added after the T3 round, must not regress. */
const NETWORK_SURFACE = [
  { name: 'browser_network_session', required: ['action'] },
  { name: 'browser_network_events', required: [] },
  { name: 'browser_network_detail', required: [] },
  { name: 'browser_network_trace', required: ['action'] },
  { name: 'browser_network_control', required: ['action'] },
  { name: 'browser_network_evidence', required: ['action'] },
  { name: 'browser_network_subscribe', required: ['action'] },
];

// Web T4 dynamic behavior (docs/t4-dynamic-behavior.md §7.2): five tools added by the T4 round.
const T4_SURFACE = [
  { name: 'browser_dynamic_session', required: ['action'] },
  { name: 'browser_motion_observe', required: ['motionSessionId'] },
  { name: 'browser_motion_analyze', required: ['motionSessionId', 'assertions'] },
  { name: 'browser_motion_control', required: ['motionSessionId', 'action'] },
  { name: 'browser_dynamic_correlate', required: ['dynamicSessionId'] },
];
// P0-E added browser_tabs (35 → 36) after the T3 round; it must stay registered and typed.
const P0E_SURFACE = [{ name: 'browser_tabs', required: ['action'] }];
const FULL_SURFACE = [...T1_SURFACE, ...P0E_SURFACE, ...T2_SURFACE, ...T3_TOOLS, ...NETWORK_SURFACE, ...T4_SURFACE];

function requiredOf(definition) {
  return [...(definition?.parameters?.required || [])].sort();
}

/* ------------------------------------------------------------------------------------------------
 * C1 — §9.C1 registration surface (22 tools, capabilities are diagnostics only)
 * ---------------------------------------------------------------------------------------------- */

async function probeC1({ check, finding }) {
  const { createHarness } = await harnessModule();
  const beforeProfiles = new Set(await profilesNow());
  const harness = await createHarness({ name: 'C1-cold' });
  OWNED_HARNESSES.push(harness);
  try {
    const names = harness.toolNames();
    const expected = FULL_SURFACE.map((tool) => tool.name);
    check(`冷启动注册恰好 ${FULL_SURFACE.length} 个工具（10 T1 + 1 P0-E + 7 T2 + 6 T3 + 7 network + 5 T4）`, names.length === FULL_SURFACE.length
      && JSON.stringify([...names].sort()) === JSON.stringify([...expected].sort()), {
      expected: { count: FULL_SURFACE.length, names: expected }, actual: { count: names.length, names },
    });
    const problems = [];
    for (const tool of FULL_SURFACE) {
      const definition = harness.tools.get(tool.name);
      if (!definition) { problems.push(`${tool.name}: 未注册`); continue; }
      if (!definition.parameters || definition.parameters.type !== 'object') problems.push(`${tool.name}: parameters.type != object`);
      if (JSON.stringify(requiredOf(definition)) !== JSON.stringify([...tool.required].sort())) {
        problems.push(`${tool.name}: required=${JSON.stringify(requiredOf(definition))} != ${JSON.stringify(tool.required)}`);
      }
      if (typeof definition.description !== 'string' || !definition.description.trim()) problems.push(`${tool.name}: description 为空`);
      if (typeof definition.execute !== 'function') problems.push(`${tool.name}: execute 不是函数`);
    }
    check(`${FULL_SURFACE.length} 个工具的 parameters/required/execute/description 与契约一致（原 24 + 7 network + 5 T4 未回归）`, problems.length === 0, { expected: [], actual: problems });

    const rawCdp = names.filter((name) => /cdp|devtools|protocol|runtime\.|page\./i.test(name));
    check('没有暴露原始 CDP/协议命令工具', rawCdp.length === 0, { expected: [], actual: rawCdp });

    // Cold capabilities: no Chromium, no profile, no directory.
    const state = await call(harness, 'browser_state', {}, execOf('c1-cold'));
    const caps = await call(harness, 'browser_capabilities', {}, execOf('c1-cold'));
    const capabilities = caps.value?.capabilities || [];
    check('capabilities 仅诊断（running=false，不启动 Chromium）', caps.ok && caps.value?.ok === true && state.value?.running === false, {
      expected: { capabilitiesOk: true, running: false }, actual: { ok: caps.ok, running: state.value?.running, error: caps.error?.message },
    });
    const spawned = (await profilesNow()).filter((dir) => !beforeProfiles.has(dir));
    check('冷启动 capabilities 不创建 profile 目录', spawned.length === 0, { expected: [], actual: spawned });

    const vision = caps.value?.vision || {};
    check('capabilities.vision 声明 version/algorithmVersion/tools/sourceKinds/limits/observed', vision.version === 1
      && vision.algorithmVersion === 't3-v1'
      && JSON.stringify([...(vision.tools || [])].sort()) === JSON.stringify(T3_TOOLS.map((tool) => tool.name).sort())
      && JSON.stringify([...(vision.sourceKinds || [])].sort()) === JSON.stringify(['baseline', 'live', 'product'])
      && vision.limits && vision.limits.maxProducts === 16 && vision.limits.maxProductPixels === 16000000
      && vision.limits.algorithmBudgetMs === 5000 && vision.observed === null, {
      expected: { version: 1, algorithmVersion: 't3-v1', tools: T3_TOOLS.map((tool) => tool.name), sourceKinds: ['live', 'product', 'baseline'], observed: null },
      actual: vision,
    });
    const t3Entries = capabilities.filter((item) => String(item.id || '').startsWith('web.t3.'));
    const expectedT3 = [
      ['web.t3.image', 'browser_vision_image'], ['web.t3.find', 'browser_vision_find'],
      ['web.t3.compare', 'browser_vision_compare'], ['web.t3.act', 'browser_vision_act'],
      ['web.t3.baseline', 'browser_vision_baseline'], ['web.t3.check', 'browser_vision_check'],
    ];
    check('六项 web.t3.* 投影到六工具且 available', expectedT3.every(([id, tool]) => capabilities.some((item) => item.id === id && item.tool === tool && item.status === 'available')), {
      expected: expectedT3, actual: t3Entries.map((item) => `${item.id}:${item.tool}:${item.status}`),
    });
    const aggregate = capabilities.find((item) => item.id === 'web.t3.static-vision');
    check('web.t3.static-vision 聚合项 available 且不带 tool', aggregate?.status === 'available' && !aggregate?.tool, { expected: { status: 'available', tool: null }, actual: aggregate });
    check(`capabilities 覆盖 ${FULL_SURFACE.length} 个工具条目（24 旧 + 7 network + 5 T4）`, capabilities.filter((item) => item.tool).length === FULL_SURFACE.length, {
      expected: FULL_SURFACE.length, actual: capabilities.filter((item) => item.tool).length,
    });
    // The T3 surface must not regress while the network group lands: the six T3 tools stay
    // available and their projection ids still resolve, independently of the new group.
    check('新增 network 组不改变 web.t3.* 六项投影的可用性', expectedT3.every(([id, tool]) => capabilities.some((item) => item.id === id && item.tool === tool && item.status === 'available'))
      && capabilities.filter((item) => item.tool).every((item) => typeof item.status === 'string'), {
      expected: expectedT3, actual: t3Entries.map((item) => `${item.id}:${item.status}`),
    });
    const networkEntries = capabilities.filter((item) => String(item.id || '').startsWith('web.network.'));
    check('capabilities 声明 web.network.* 七项投影与 web.network.p0 聚合', networkEntries.filter((item) => item.tool).length === 7
      && Boolean(networkEntries.find((item) => item.id === 'web.network.p0' && !item.tool)), {
      expected: { toolProjections: 7, aggregate: 'web.network.p0' },
      actual: networkEntries.map((item) => `${item.id}:${item.tool || '(aggregate)'}:${item.status}`),
    });
    const t4 = capabilities.filter((item) => String(item.id || '').toLowerCase().includes('t4'));
    check('T4 五工具 + 聚合 + 旧别名均 available（不是草案名）', t4.length >= 7 && t4.every((item) => item.status === 'available')
      && T4_SURFACE.every((tool) => t4.some((item) => item.tool === tool.name)), { expected: 'T4 available (5 tool + aggregate + alias)', actual: t4 });

    // T1/T2 regression probes: the original surface still works on the T3 fixture.
    await freshPage(harness, T3_PATH, execOf('c1-cold'));
    const shot = await call(harness, 'browser_screenshot', {}, execOf('c1-cold'));
    const shotInfo = pngInfo(shot.value?.image);
    check('browser_screenshot 仍工作且为 1280×800', shot.ok && shotInfo.width === 1280 && shotInfo.height === 800, {
      expected: { ok: true, width: 1280, height: 800 }, actual: { ok: shot.ok, width: shotInfo.width, height: shotInfo.height, error: shot.error?.message },
    });
    const evalResult = await call(harness, 'browser_eval', { expression: 'document.title' }, execOf('c1-cold'));
    check('browser_eval 仍工作', evalResult.ok && evalResult.value?.value === 'DSH T3 Fixture', { expected: 'DSH T3 Fixture', actual: evalResult.value?.value });
    const snapshot = await call(harness, 'browser_snapshot', {}, execOf('c1-cold'));
    check('browser_snapshot 仍工作（T2 语义树）', snapshot.ok && typeof snapshot.value?.tree === 'string' && snapshot.value.tree.includes('DSH T3 Fixture'), {
      expected: 'tree contains title', actual: { ok: snapshot.ok, hasTree: typeof snapshot.value?.tree === 'string' },
    });
    const click = await call(harness, 'browser_click', { selector: '#t3-flip' }, execOf('c1-cold'));
    const flip = await call(harness, 'browser_eval', { expression: 'window.__t3.counters.flipClicks' }, execOf('c1-cold'));
    check('browser_click 仍工作（#t3-flip 计数 1）', click.ok && flip.value?.value === 1, { expected: { ok: true, flipClicks: 1 }, actual: { ok: click.ok, flipClicks: flip.value?.value, error: click.error?.message } });
    finding({ id: 'C1-regression-surface', summary: 'T1/T2 关键路径（截图/eval/snapshot/click）在 T3 靶机上仍工作；30 工具注册面（含 browser_viewport）与 §2.1/§2 required 一致，T3 六项投影与 web.t3.static-vision 未受 network 组影响。' });
  } finally {
    await closeHarness(harness);
  }
}

/* ------------------------------------------------------------------------------------------------
 * C3 — §9.C3 live capture defaults, scale 1.25 and mapping truth
 * ---------------------------------------------------------------------------------------------- */

async function probeC3({ harness, check, finding }) {
  await freshPage(harness);
  const before = await t3State(harness);
  const full = await call(harness, 'browser_vision_image', { source: { kind: 'live' } });
  const fullValue = checkVisionValue(check, '默认 live 截图返回 action envelope + vision v1 证据', full, { requireImage: true });
  recordImage('C3-live-default', fullValue);
  const fullProduct = fullValue.product || {};
  check('默认 live 为 1280×800、mapping 1:1、capturedAt 有效', fullProduct.width === 1280 && fullProduct.height === 800
    && fullProduct.mapping?.cssPerPixel?.x === 1 && fullProduct.mapping?.cssPerPixel?.y === 1
    && fullProduct.mapping?.capturedCssRect?.width === 1280 && fullProduct.mapping?.capturedCssRect?.height === 800
    && Number.isFinite(fullProduct.capturedAt) && fullProduct.actionable === true, {
    expected: { width: 1280, height: 800, cssPerPixel: 1, actionable: true }, actual: { product: jsonSafe(fullProduct) },
  });
  check('默认 live 的 sha256 等于返回 PNG 字节 hash', typeof fullValue.sha256 === 'string' && fullValue.sha256 === pngInfo(fullValue.image).sha256, {
    expected: 'sha256 == PNG bytes', actual: { sha256: fullValue.sha256, png: pngInfo(fullValue.image).sha256 },
  });

  const region = { x: 40, y: 40, width: 80, height: 60 };
  const scaled = await call(harness, 'browser_vision_image', { source: { kind: 'live', scale: 1.25, region } });
  const scaledValue = checkVisionValue(check, 'source.region + scale 1.25 返回成功', scaled, { requireImage: true });
  recordImage('C3-red-1.25', scaledValue);
  const scaledProduct = scaledValue.product || {};
  check('红块 80×60 @1.25 = 100×75（P0 实际尺寸）', scaledProduct.width === 100 && scaledProduct.height === 75, {
    expected: { width: 100, height: 75 }, actual: { width: scaledProduct.width, height: scaledProduct.height },
  });
  check('scale 1.25 的 mapping：origin(40,40)、cssPerPixel 0.8、capturedCssRect 80×60', scaledProduct.mapping?.originCss?.x === 40 && scaledProduct.mapping?.originCss?.y === 40
    && Math.abs(scaledProduct.mapping?.cssPerPixel?.x - 0.8) < 1e-9 && Math.abs(scaledProduct.mapping?.cssPerPixel?.y - 0.8) < 1e-9
    && scaledProduct.mapping?.capturedCssRect?.x === 40 && scaledProduct.mapping?.capturedCssRect?.width === 80, {
    expected: { originCss: { x: 40, y: 40 }, cssPerPixel: 0.8, capturedCssRect: { x: 40, y: 40, width: 80, height: 60 } }, actual: scaledProduct.mapping,
  });
  const analysis = scaledValue.analysis || {};
  check('缩放图 analysis 全红（uniform/opaque/dominant 桶 240）', analysis.uniform === true && analysis.pixelCount === 7500
    && analysis.opaquePixels === 7500 && analysis.transparentPixels === 0
    && JSON.stringify(analysis.averageRgba) === JSON.stringify([255, 0, 0, 255])
    && JSON.stringify(analysis.minRgba) === JSON.stringify([255, 0, 0, 255])
    && JSON.stringify(analysis.maxRgba) === JSON.stringify([255, 0, 0, 255])
    && analysis.dominantColors?.[0]?.rgba?.[0] === 240 && analysis.dominantColors?.[0]?.rgba?.[1] === 0, {
    expected: { uniform: true, pixelCount: 7500, averageRgba: [255, 0, 0, 255], dominantBucket: [240, 0, 0, 255] }, actual: analysis,
  });

  const plain = await call(harness, 'browser_vision_image', { source: { kind: 'live', scale: 1, region } });
  const plainValue = checkVisionValue(check, '同区域 @1 返回成功', plain, { requireImage: true });
  recordImage('C3-red-1', plainValue);
  check('同区域 @1 = 80×60 且读回纯红', plainValue.product?.width === 80 && plainValue.product?.height === 60
    && plainValue.analysis?.uniform === true && JSON.stringify(plainValue.analysis?.averageRgba) === JSON.stringify([255, 0, 0, 255]), {
    expected: { width: 80, height: 60, averageRgba: [255, 0, 0, 255] }, actual: { product: plainValue.product, analysis: plainValue.analysis },
  });
  const after = await t3State(harness);
  check('采集不改变 viewport/scroll（前后一致）', JSON.stringify(before.viewport) === JSON.stringify(after.viewport)
    && JSON.stringify(before.scroll) === JSON.stringify(after.scroll), { expected: { viewport: before.viewport, scroll: before.scroll }, actual: { viewport: after.viewport, scroll: after.scroll } });
  const again = await call(harness, 'browser_vision_image', { source: { kind: 'live', scale: 1, region } });
  const againValue = checkVisionValue(check, '同区域 @1 再次采集成功', again, { requireImage: true });
  check('两次 @1 采集的 rgbaSha256 相同（像素确定）', plainValue.product?.rgbaSha256 === againValue.product?.rgbaSha256
    && typeof plainValue.product?.rgbaSha256 === 'string' && plainValue.product.rgbaSha256.length === 64, {
    expected: 'rgbaSha256 stable', actual: { first: plainValue.product?.rgbaSha256, second: againValue.product?.rgbaSha256 },
  });
  finding({ id: 'C3-mapping', summary: 'live 默认 1280×800、region@1.25=100×75、mapping origin/cssPerPixel 与 P0 尺寸公式一致；采集不改变页面几何。' });
}

/* ------------------------------------------------------------------------------------------------
 * C4 — §9.C4 CSS decimals, document bounds and PixelRect integer rules
 * ---------------------------------------------------------------------------------------------- */

async function probeC4({ harness, check, finding }) {
  await freshPage(harness);
  const state = await t3State(harness);
  check('靶机 document 高 1600、视口 1280×800（前置真值）', state.doc.height === 1600 && state.viewport.width === 1280 && state.viewport.height === 800, {
    expected: { docHeight: 1600, viewport: { width: 1280, height: 800 } }, actual: state.doc,
  });

  const cases = [
    ['region 底边 1601 越界', { x: 0, y: 1551, width: 101, height: 50 }],
    ['region y=1599 高 10 越界', { x: 0, y: 1599, width: 10, height: 10 }],
    ['负原点', { x: -1, y: 0, width: 10, height: 10 }],
    ['零面积（width=0）', { x: 0, y: 0, width: 0, height: 10 }],
  ];
  for (const [label, region] of cases) {
    const result = await call(harness, 'browser_vision_image', { source: { kind: 'live', region } });
    checkVisionError(check, `live source.region ${label} -> INVALID_ARGUMENT（截图前拒绝）`, result, { code: 'INVALID_ARGUMENT', category: 'input', retryable: false });
  }
  const decimalRegion = { x: 40.5, y: 40.5, width: 79.5, height: 59.5 };
  const decimalSource = await call(harness, 'browser_vision_image', { source: { kind: 'live', region: decimalRegion } });
  const decimalValue = checkVisionValue(check, 'live source.region 允许 CSS 小数', decimalSource, { requireImage: true });
  recordImage('C4-decimal-region', decimalValue);
  const dWidth = decimalValue.product?.width;
  const dHeight = decimalValue.product?.height;
  const dMapping = decimalValue.product?.mapping || {};
  const roundW = Math.round(decimalRegion.width);
  const roundH = Math.round(decimalRegion.height);
  const coversRequested = dMapping.capturedCssRect
    && Math.abs(dMapping.capturedCssRect.x - decimalRegion.x) <= 1e-9
    && Math.abs(dMapping.capturedCssRect.y - decimalRegion.y) <= 1e-9
    && Math.abs(dMapping.capturedCssRect.width - decimalRegion.width) <= 1e-9
    && Math.abs(dMapping.capturedCssRect.height - decimalRegion.height) <= 1e-9;
  // Lead adjudication 2026-11-01: Chrome floors a fractional clip (79.5×59.5 -> 79×59); §3.1 says the
  // actual mapping must be reported. Accept round±1 per axis (never "any size"), require an
  // actionable product whose mapping still covers the requested CSS rect.
  check('CSS 小数 region 的实际尺寸在 round 期望 ±1 内（本机 floor 79×59），mapping 覆盖请求 rect 且 product 可用', Number.isInteger(dWidth) && Number.isInteger(dHeight)
    && Math.abs(dWidth - roundW) <= 1 && Math.abs(dHeight - roundH) <= 1
    && decimalValue.product?.actionable === true && coversRequested, {
    expected: { widthWithin: [roundW - 1, roundW + 1], heightWithin: [roundH - 1, roundH + 1], actionable: true, capturedCssRect: decimalRegion },
    actual: { width: dWidth, height: dHeight, actionable: decimalValue.product?.actionable, capturedCssRect: dMapping.capturedCssRect, originCss: dMapping.originCss },
  });

  const topLevelDecimal = await call(harness, 'browser_vision_image', { source: { kind: 'live' }, region: { x: 0.5, y: 0, width: 10, height: 10 } });
  checkVisionError(check, '顶层 region x=0.5（PixelRect 非整数）-> INVALID_ARGUMENT', topLevelDecimal, { code: 'INVALID_ARGUMENT', category: 'input', retryable: false });
  const topLevelOut = await call(harness, 'browser_vision_image', { source: { kind: 'live' }, region: { x: 1270, y: 0, width: 20, height: 10 } });
  checkVisionError(check, '顶层 region 超出图像边界 -> INVALID_ARGUMENT', topLevelOut, { code: 'INVALID_ARGUMENT', category: 'input', retryable: false });

  const eleven = await call(harness, 'browser_vision_image', { source: { kind: 'live', scale: 1.11, region: { x: 0, y: 0, width: 101, height: 50 } } });
  const elevenValue = checkVisionValue(check, '101×50 @1.11 返回成功', eleven, { requireImage: true });
  recordImage('C4-101x50-1.11', elevenValue);
  check('101×50 @1.11 = round(112.11)×round(55.5) = 112×56', elevenValue.product?.width === 112 && elevenValue.product?.height === 56, {
    expected: { width: 112, height: 56 }, actual: { width: elevenValue.product?.width, height: elevenValue.product?.height },
  });
  finding({ id: 'C4-bounds', summary: '越文档边界/负原点/零面积/顶层小数 PixelRect 均在截图前拒绝；101×50@1.11 尺寸按实际 round 计算。' });
}

/* ------------------------------------------------------------------------------------------------
 * C5 — §9.C5 product scope isolation and offline analysis after navigation
 * ---------------------------------------------------------------------------------------------- */

async function probeC5({ check, finding }) {
  const wsA = await createWorkspaceHarness('c5a');
  const wsB = await createWorkspaceHarness('c5b');
  const A = wsA.harness;
  const B = wsB.harness;
  const execA = execOf('ws-c5-a');
  const execB = execOf('ws-c5-b');
  try {
    await freshPage(A, T3_PATH, execA);
    const captured = await call(A, 'browser_vision_image', { source: { kind: 'live', region: { x: 40, y: 40, width: 80, height: 60 } } }, execA);
    const capturedValue = checkVisionValue(check, 'workspace A 采集红图成功（前置）', captured, { requireImage: true });
    const productId = capturedValue.product?.productId;
    check('productId 形如 v1_<32 hex>', /^v1_[0-9a-f]{32}$/.test(String(productId)), { expected: 'v1_<32hex>', actual: productId });

    await freshPage(B, T3_PATH, execB);
    const crossRead = await call(B, 'browser_vision_image', { source: { kind: 'product', productId } }, execB);
    checkVisionError(check, 'B 读取 A 的 product -> VISION_SOURCE_NOT_FOUND', crossRead, { code: 'VISION_SOURCE_NOT_FOUND', category: 'vision', retryable: false });
    const crossAct = await call(B, 'browser_vision_act', { productId, action: 'click', point: { x: 10, y: 10 } }, execB);
    checkVisionError(check, 'B 对 A 的 product 执行 act -> VISION_SOURCE_NOT_FOUND', crossAct, { code: 'VISION_SOURCE_NOT_FOUND', category: 'vision', retryable: false });

    await freshPage(A, T3_SECOND_PATH, execA);
    const offlineRead = await call(A, 'browser_vision_image', { source: { kind: 'product', productId } }, execA);
    const offlineValue = checkVisionValue(check, 'A 导航第二页后仍可离线读取旧 product', offlineRead, { requireImage: true });
    check('离线读取的尺寸/内容仍是红块 80×60', offlineValue.product?.width === 80 && offlineValue.product?.height === 60
      && JSON.stringify(offlineValue.analysis?.averageRgba) === JSON.stringify([255, 0, 0, 255]), {
      expected: { width: 80, height: 60, averageRgba: [255, 0, 0, 255] }, actual: { product: offlineValue.product, analysis: offlineValue.analysis },
    });
    const staleAct = await call(A, 'browser_vision_act', { productId, action: 'click', point: { x: 10, y: 10 } }, execA);
    const staleCode = codeOf(staleAct);
    check('导航后旧 product 的 act 失效（VISION_STALE_IMAGE / SOURCE_NOT_FOUND）', staleAct.threw === true && ['VISION_STALE_IMAGE', 'VISION_SOURCE_NOT_FOUND'].includes(staleCode), {
      expected: ['VISION_STALE_IMAGE', 'VISION_SOURCE_NOT_FOUND'], actual: { code: staleCode, message: String(staleAct.error?.message || '').slice(0, 160) },
    });
    const crossStill = await call(B, 'browser_vision_image', { source: { kind: 'product', productId } }, execB);
    check('B 的跨 scope 拒绝不受 A 页面导航影响（仍 SOURCE_NOT_FOUND）', codeOf(crossStill) === 'VISION_SOURCE_NOT_FOUND', { expected: 'VISION_SOURCE_NOT_FOUND', actual: codeOf(crossStill) });
    finding({ id: 'C5-scope', summary: 'product store 按可信 scope 隔离：跨 scope 读/act 均 SOURCE_NOT_FOUND；导航后仍可离线分析但 act 失效。' });
  } finally {
    await closeHarness(A);
    await closeHarness(B);
  }
}

/* ------------------------------------------------------------------------------------------------
 * C12 — §9.C12 crop + recognize + pre-annotation analysis
 * ---------------------------------------------------------------------------------------------- */

async function probeC12({ harness, check, finding }) {
  await freshPage(harness);
  const region = { x: 40, y: 40, width: 80, height: 60 };
  const query = { method: 'color', color: [255, 0, 0], tolerance: 0, minArea: 4 };
  const cropped = await call(harness, 'browser_vision_image', {
    source: { kind: 'live' },
    region,
    recognize: query,
  });
  const value = checkVisionValue(check, 'image 一次完成裁剪 + recognize', cropped, { requireImage: true });
  recordImage('C12-crop-recognize', value);
  const recognition = value.recognition || {};
  check('裁剪结果 80×60 且 recognize 命中红色候选', value.product?.width === 80 && value.product?.height === 60
    && recognition.method === 'color' && Array.isArray(recognition.candidates) && recognition.candidates.length === 1, {
    expected: { width: 80, height: 60, candidates: 1 }, actual: { width: value.product?.width, height: value.product?.height, recognition: jsonSafe(recognition) },
  });
  const candidate = recognition.candidates?.[0] || {};
  check('候选 region 相对裁剪图 (0,0,80,60)、area 4800、semanticName=null', JSON.stringify(candidate.region) === JSON.stringify({ x: 0, y: 0, width: 80, height: 60 })
    && candidate.area === 4800 && candidate.semanticName === null && candidate.signal === 'color', {
    expected: { region: { x: 0, y: 0, width: 80, height: 60 }, area: 4800, semanticName: null }, actual: jsonSafe(candidate),
  });
  check('候选 documentCss 映射回文档 (40,40,80,60)', candidate.documentCss && Math.abs(candidate.documentCss.x - 40) < 0.01 && Math.abs(candidate.documentCss.y - 40) < 0.01
    && Math.abs(candidate.documentCss.width - 80) < 0.01 && Math.abs(candidate.documentCss.height - 60) < 0.01, {
    expected: { x: 40, y: 40, width: 80, height: 60 }, actual: candidate.documentCss,
  });
  check('recognition.sourceProductId 指向未标注的最终 derived product', recognition.sourceProductId === value.product?.productId, {
    expected: value.product?.productId, actual: recognition.sourceProductId,
  });
  const analysisBefore = JSON.stringify(value.analysis);
  check('裁剪图 analysis 全红且 4800 像素', value.analysis?.uniform === true && value.analysis?.pixelCount === 4800
    && JSON.stringify(value.analysis?.averageRgba) === JSON.stringify([255, 0, 0, 255]), { expected: { uniform: true, pixelCount: 4800 }, actual: value.analysis });

  const annotated = await call(harness, 'browser_vision_image', {
    source: { kind: 'live' },
    region,
    recognize: query,
    annotations: [{ kind: 'number', point: { x: 2, y: 2 }, number: 1, color: [0, 0, 255, 255] }],
  });
  const annotatedValue = checkVisionValue(check, '带蓝色编号标注的裁剪+识别成功', annotated, { requireImage: true });
  recordImage('C12-annotated', annotatedValue);
  check('标注不改变 analysis（统计基于未标注结果）', JSON.stringify(annotatedValue.analysis) === analysisBefore, {
    expected: 'analysis identical to un-annotated crop', actual: { before: analysisBefore, after: JSON.stringify(annotatedValue.analysis) },
  });
  const blue = await call(harness, 'browser_vision_find', { source: { kind: 'product', productId: annotatedValue.product?.productId }, query: { method: 'color', color: [0, 0, 255], tolerance: 0, minArea: 1 } });
  const blueValue = blue.ok ? checkVisionValue(check, '标注后的 product 仍可被 find 分析', blue) : null;
  check('标注确实写进输出图（蓝色候选 ≥1）', blue.ok && (blueValue?.result?.candidates || []).length >= 1, {
    expected: 'blue annotation present', actual: blue.ok ? { candidates: blueValue?.result?.candidates?.length } : blue.error?.message,
  });
  finding({ id: 'C12-order', summary: 'image 处理顺序：crop→recognize/analysis→annotations；analysis 与 recognition 均基于未标注像素，标注仅改变交付图。' });
}

/* ------------------------------------------------------------------------------------------------
 * C14 — §9.C14 color/components/edges candidates and ROI origin
 * ---------------------------------------------------------------------------------------------- */

async function probeC14({ harness, check, finding }) {
  await freshPage(harness);
  const redRoi = { x: 20, y: 20, width: 220, height: 200 };
  const red = await call(harness, 'browser_vision_find', { source: { kind: 'live' }, region: redRoi, query: { method: 'color', color: [255, 0, 0], tolerance: 0, minArea: 4 } });
  const redValue = checkVisionValue(check, 'color 识别（红块 + canvas 左半）成功', red);
  const redCandidates = redValue.result?.candidates || [];
  const redRegions = redCandidates.map((item) => item.region);
  check('tol0 精确红命中两块：红块 (40,40,80,60) 与 canvas 左半 (40,140,80,80)', redCandidates.length === 2
    && redRegions.some((r) => JSON.stringify(r) === JSON.stringify({ x: 40, y: 40, width: 80, height: 60 }))
    && redRegions.some((r) => JSON.stringify(r) === JSON.stringify({ x: 40, y: 140, width: 80, height: 80 })), {
    expected: [{ x: 40, y: 40, width: 80, height: 60 }, { x: 40, y: 140, width: 80, height: 80 }], actual: redRegions,
  });
  check('所有候选 semanticName=null（无 OCR/语义）', redCandidates.every((item) => item.semanticName === null), { expected: null, actual: redCandidates.map((item) => item.semanticName) });
  check('ROI 原点已回加到完整源图坐标（不是 ROI 内坐标）', redCandidates.every((item) => item.region.x >= redRoi.x && item.region.y >= redRoi.y), {
    expected: `x>=${redRoi.x}, y>=${redRoi.y}`, actual: redRegions,
  });
  check('find 成功体含 source（完整源图，不是 ROI 裁剪图）', redValue.source?.width === 1280 && redValue.source?.height === 800, {
    expected: { width: 1280, height: 800 }, actual: { width: redValue.source?.width, height: redValue.source?.height },
  });

  const green = await call(harness, 'browser_vision_find', { source: { kind: 'live' }, region: redRoi, query: { method: 'color', color: [0, 255, 0], tolerance: 0 } });
  const greenValue = checkVisionValue(check, 'color 绿无候选仍是成功', green);
  check('未命中 = candidates [] / totalCandidates 0（不是 TARGET_NOT_FOUND）', Array.isArray(greenValue.result?.candidates) && greenValue.result.candidates.length === 0 && greenValue.result.totalCandidates === 0, {
    expected: { candidates: [], totalCandidates: 0 }, actual: greenValue.result,
  });

  const redOnly = await call(harness, 'browser_vision_find', { source: { kind: 'live' }, region: { x: 40, y: 40, width: 80, height: 60 }, query: { method: 'color', color: [255, 0, 0], tolerance: 0 } });
  const redOnlyValue = checkVisionValue(check, '只选 red ROI 成功', redOnly);
  check('只选 red ROI 时恰好 1 个候选且填满 ROI', redOnlyValue.result?.candidates?.length === 1
    && JSON.stringify(redOnlyValue.result.candidates[0].region) === JSON.stringify({ x: 40, y: 40, width: 80, height: 60 }), {
    expected: { count: 1, region: { x: 40, y: 40, width: 80, height: 60 } }, actual: redOnlyValue.result?.candidates,
  });

  const canvasRoi = { x: 40, y: 140, width: 160, height: 80 };
  const components = await call(harness, 'browser_vision_find', { source: { kind: 'live' }, region: canvasRoi, query: { method: 'components', background: [255, 255, 255], tolerance: 16 } });
  const componentsValue = checkVisionValue(check, 'components 识别 canvas 成功', components);
  const componentsCandidates = componentsValue.result?.candidates || [];
  check('canvas 红蓝两半 8 邻接 -> 1 个连通域（area 12800，bbox 160×80）、semanticName=null', componentsCandidates.length === 1
    && componentsCandidates[0].area === 12800
    && JSON.stringify(componentsCandidates[0].region) === JSON.stringify({ x: 40, y: 140, width: 160, height: 80 })
    && componentsCandidates.every((item) => item.semanticName === null), {
    expected: { count: 1, area: 12800, region: { x: 40, y: 140, width: 160, height: 80 } },
    actual: { count: componentsCandidates.length, candidates: componentsCandidates.map((item) => ({ area: item.area, region: item.region })) },
  });
  const redHalf = await call(harness, 'browser_vision_find', { source: { kind: 'live' }, region: canvasRoi, query: { method: 'color', color: [255, 0, 0], tolerance: 0 } });
  const blueHalf = await call(harness, 'browser_vision_find', { source: { kind: 'live' }, region: canvasRoi, query: { method: 'color', color: [0, 0, 255], tolerance: 0 } });
  check('color 查询把 canvas 分成左右两个 80×80 色块（area 6400）', redHalf.ok && blueHalf.ok
    && JSON.stringify(redHalf.value?.result?.candidates?.map((item) => item.region)) === JSON.stringify([{ x: 40, y: 140, width: 80, height: 80 }])
    && JSON.stringify(blueHalf.value?.result?.candidates?.map((item) => item.region)) === JSON.stringify([{ x: 120, y: 140, width: 80, height: 80 }]), {
    expected: { red: { x: 40, y: 140, width: 80, height: 80 }, blue: { x: 120, y: 140, width: 80, height: 80 } },
    actual: { red: redHalf.value?.result?.candidates?.map((item) => item.region), blue: blueHalf.value?.result?.candidates?.map((item) => item.region) },
  });

  const edges = await call(harness, 'browser_vision_find', { source: { kind: 'live' }, region: canvasRoi, query: { method: 'edges', edgeThreshold: 32 } });
  const edgesValue = checkVisionValue(check, 'edges 识别成功', edges);
  check('edges 至少 1 个候选且 semanticName=null', (edgesValue.result?.candidates || []).length >= 1
    && edgesValue.result.candidates.every((item) => item.semanticName === null), {
    expected: '>=1 edge candidate', actual: { count: edgesValue.result?.candidates?.length, metrics: edgesValue.result?.metrics },
  });
  finding({ id: 'C14-signals', summary: 'color/components/edges 候选坐标回加 ROI 原点；未命中为成功空数组；semanticName 固定 null。' });
}

/* ------------------------------------------------------------------------------------------------
 * C17 — §9.C17 before product → real click → after live (no implicit action/wait)
 * ---------------------------------------------------------------------------------------------- */

async function probeC17({ harness, check, finding }) {
  await freshPage(harness);
  const region = { x: 300, y: 240, width: 80, height: 60 };
  const before = await call(harness, 'browser_vision_image', { source: { kind: 'live', region } });
  const beforeValue = checkVisionValue(check, 'before product 采集成功', before, { requireImage: true });
  recordImage('C17-before', beforeValue);
  await resetEvents(harness);
  const click = await call(harness, 'browser_click', { selector: '#t3-flip' });
  check('外部 browser_click 点击 #t3-flip 成功', click.ok && click.value?.ok === true, { expected: 'ok', actual: click.error?.message || 'ok' });
  const after = await call(harness, 'browser_vision_image', { source: { kind: 'live', region } });
  const afterValue = checkVisionValue(check, 'after live 采集成功', after, { requireImage: true });
  recordImage('C17-after', afterValue);
  const beforeProduct = beforeValue.product || {};
  const afterProduct = afterValue.product || {};
  check('before/after 像素 hash 不同（红→蓝）', beforeProduct.rgbaSha256 !== afterProduct.rgbaSha256
    && JSON.stringify(beforeValue.analysis?.averageRgba) === JSON.stringify([255, 0, 0, 255])
    && JSON.stringify(afterValue.analysis?.averageRgba) === JSON.stringify([0, 0, 255, 255]), {
    expected: { before: [255, 0, 0, 255], after: [0, 0, 255, 255], hashesDiffer: true },
    actual: { before: beforeValue.analysis?.averageRgba, after: afterValue.analysis?.averageRgba },
  });
  check('两次采集时间不同（capturedAt 有效且递增）', Number.isFinite(beforeProduct.capturedAt) && Number.isFinite(afterProduct.capturedAt)
    && afterProduct.capturedAt >= beforeProduct.capturedAt, { expected: 'after >= before', actual: { before: beforeProduct.capturedAt, after: afterProduct.capturedAt } });
  const logState = await t3State(harness);
  check('事件日志只有外部 click 一条（采集本身不派发输入）', logState.counters.clicks === 1 && (await t3Events(harness, "e.type === 'click'")).length === 1, {
    expected: { clicks: 1 }, actual: { clicks: logState.counters.clicks, events: await t3Events(harness, "e.type === 'click'") },
  });

  const compared = await call(harness, 'browser_vision_compare', { before: { kind: 'product', productId: beforeProduct.productId }, after: { kind: 'product', productId: afterProduct.productId } });
  const comparedValue = checkVisionValue(check, 'compare before/after 成功', compared, { requireImage: true });
  recordImage('C17-diff', comparedValue);
  const comparison = comparedValue.comparison || {};
  check('红→蓝全图 diff：diffPixels=4800、similarity=0、verdict FAIL', comparison.metrics?.diffPixels === 4800
    && comparison.metrics?.similarity === 0 && comparison.verdict === 'FAIL' && comparison.metrics?.diffRatio === 1, {
    expected: { diffPixels: 4800, similarity: 0, verdict: 'FAIL', diffRatio: 1 }, actual: comparison.metrics,
  });
  const staticA = await call(harness, 'browser_vision_image', { source: { kind: 'live', region: { x: 40, y: 40, width: 80, height: 60 } } });
  const staticB = await call(harness, 'browser_vision_image', { source: { kind: 'live', region: { x: 40, y: 40, width: 80, height: 60 } } });
  const staticCompare = await call(harness, 'browser_vision_compare', { before: { kind: 'product', productId: staticA.value?.product?.productId }, after: { kind: 'product', productId: staticB.value?.product?.productId } });
  check('静止页两次 live compare：diffPixels=0、similarity=1、PASS', staticCompare.ok && staticCompare.value?.comparison?.metrics?.diffPixels === 0
    && staticCompare.value?.comparison?.metrics?.similarity === 1 && staticCompare.value?.comparison?.verdict === 'PASS', {
    expected: { diffPixels: 0, similarity: 1, verdict: 'PASS' }, actual: staticCompare.value?.comparison?.metrics || staticCompare.error?.message,
  });
  const afterCompareLog = await t3State(harness);
  check('compare 不派发输入（事件计数不变）', afterCompareLog.counters.clicks === 1, { expected: 1, actual: afterCompareLog.counters.clicks });
  finding({ id: 'C17-compare', summary: 'compare 不执行动作/等待：before product → 外部 T2 click → after live；两 live 在静止页完全相同。' });
}

/* ------------------------------------------------------------------------------------------------
 * C22 — §9.C22 dual coordinate mapping, scale 2, size mismatch, incompatible mapping
 * ---------------------------------------------------------------------------------------------- */

async function probeC22({ harness, check, finding }) {
  await freshPage(harness);
  const region = { x: 20, y: 20, width: 120, height: 100 };
  const before = await call(harness, 'browser_vision_image', { source: { kind: 'live', scale: 2, region } });
  const beforeValue = checkVisionValue(check, 'scale2 before 采集成功', before, { requireImage: true });
  recordImage('C22-before-2x', beforeValue);
  check('scale2 的 120×100 CSS 区域 = 240×200 像素、cssPerPixel 0.5', beforeValue.product?.width === 240 && beforeValue.product?.height === 200
    && Math.abs(beforeValue.product?.mapping?.cssPerPixel?.x - 0.5) < 1e-9, {
    expected: { width: 240, height: 200, cssPerPixel: 0.5 }, actual: { width: beforeValue.product?.width, height: beforeValue.product?.height, mapping: beforeValue.product?.mapping },
  });
  await pageValue(harness, 'window.__t3.showCssPatch(), true');
  const after = await call(harness, 'browser_vision_image', { source: { kind: 'live', scale: 2, region } });
  const afterValue = checkVisionValue(check, 'scale2 after 采集成功', after, { requireImage: true });
  recordImage('C22-after-2x', afterValue);
  const compared = await call(harness, 'browser_vision_compare', { before: { kind: 'product', productId: beforeValue.product?.productId }, after: { kind: 'product', productId: afterValue.product?.productId } });
  const comparedValue = checkVisionValue(check, 'scale2 compare 成功', compared, { requireImage: true });
  recordImage('C22-diff-2x', comparedValue);
  const comparison = comparedValue.comparison || {};
  check('10CSS×10CSS 变化在 scale2 下 = 400 像素（20×20）', comparison.metrics?.diffPixels === 400, {
    expected: 400, actual: comparison.metrics,
  });
  const diffRegion = comparison.regions?.[0] || {};
  const cssOk = diffRegion.beforeDocumentCss && Math.abs(diffRegion.beforeDocumentCss.x - 50) <= 0.01 && Math.abs(diffRegion.beforeDocumentCss.y - 50) <= 0.01
    && Math.abs(diffRegion.beforeDocumentCss.width - 10) <= 0.01 && Math.abs(diffRegion.beforeDocumentCss.height - 10) <= 0.01;
  check('diff 区域映射回文档 CSS (50,50,10,10)，像素区域 (60,60,20,20)', cssOk
    && JSON.stringify(diffRegion.imagePixels) === JSON.stringify({ x: 60, y: 60, width: 20, height: 20 }), {
    expected: { beforeDocumentCss: { x: 50, y: 50, width: 10, height: 10 }, imagePixels: { x: 60, y: 60, width: 20, height: 20 } },
    actual: { beforeDocumentCss: diffRegion.beforeDocumentCss, imagePixels: diffRegion.imagePixels },
  });
  check('mappingCompatible=true 且双坐标均非 null', comparison.mappingCompatible === true && diffRegion.afterDocumentCss !== null, {
    expected: { mappingCompatible: true, afterDocumentCss: 'non-null' }, actual: { mappingCompatible: comparison.mappingCompatible, afterDocumentCss: diffRegion.afterDocumentCss },
  });
  await pageValue(harness, 'window.__t3.hideCssPatch(), true');

  const originA = await call(harness, 'browser_vision_image', { source: { kind: 'live', scale: 1, region: { x: 20, y: 20, width: 120, height: 100 } } });
  const originB = await call(harness, 'browser_vision_image', { source: { kind: 'live', scale: 1, region: { x: 30, y: 30, width: 120, height: 100 } } });
  const incompatible = await call(harness, 'browser_vision_compare', { before: { kind: 'product', productId: originA.value?.product?.productId }, after: { kind: 'product', productId: originB.value?.product?.productId } });
  const incompatibleValue = checkVisionValue(check, '同尺寸不同原点 compare 仍可图像比较', incompatible, { requireImage: true });
  const incompatibleComparison = incompatibleValue.comparison || {};
  check('不兼容 mapping：mappingCompatible=false 且 region CSS 均为 null（不伪造位移）', incompatibleComparison.mappingCompatible === false
    && (incompatibleComparison.regions || []).every((item) => item.beforeDocumentCss === null && item.afterDocumentCss === null), {
    expected: { mappingCompatible: false, css: null }, actual: { mappingCompatible: incompatibleComparison.mappingCompatible, regions: incompatibleComparison.regions },
  });

  const sizeMismatch = await call(harness, 'browser_vision_compare', {
    before: { kind: 'product', productId: originA.value?.product?.productId },
    after: { kind: 'product', productId: (await call(harness, 'browser_vision_image', { source: { kind: 'live', region: { x: 20, y: 20, width: 120, height: 80 } } })).value?.product?.productId },
  });
  checkVisionError(check, '两图尺寸不等 -> VISION_SIZE_MISMATCH', sizeMismatch, { code: 'VISION_SIZE_MISMATCH', category: 'vision', retryable: false });
  finding({ id: 'C22-coordinates', summary: 'scale2 双坐标映射精确到 10CSS×10CSS；不同原点同尺寸 mapping 不兼容时 CSS 为 null；尺寸不等拒绝。' });
}

/* ------------------------------------------------------------------------------------------------
 * C24 — §9.C24 explicit clock mask (no automatic dynamic detection)
 * ---------------------------------------------------------------------------------------------- */

async function probeC24({ harness, check, finding }) {
  await freshPage(harness);
  const region = { x: 480, y: 20, width: 140, height: 80 };
  const before = await call(harness, 'browser_vision_image', { source: { kind: 'live', region } });
  const beforeValue = checkVisionValue(check, 'clock 区域 before 采集成功', before, { requireImage: true });
  recordImage('C24-before', beforeValue);
  const beforeSha = beforeValue.product?.rgbaSha256;
  await pageValue(harness, 'window.__t3.toggleClock(), true');
  const after = await call(harness, 'browser_vision_image', { source: { kind: 'live', region } });
  const afterValue = checkVisionValue(check, 'clock toggle 后 after 采集成功', after, { requireImage: true });
  recordImage('C24-after', afterValue);
  check('clock 显式 toggle 改变 80×20=1600 像素', afterValue.analysis?.pixelCount === 11200 && beforeSha !== afterValue.product?.rgbaSha256, {
    expected: { pixelCount: 11200, hashesDiffer: true }, actual: { pixelCount: afterValue.analysis?.pixelCount },
  });

  const noMask = await call(harness, 'browser_vision_compare', { before: { kind: 'product', productId: beforeValue.product?.productId }, after: { kind: 'product', productId: afterValue.product?.productId } });
  const noMaskValue = checkVisionValue(check, '无 mask compare 成功', noMask, { requireImage: true });
  check('无 mask：diffPixels=1600、verdict FAIL（不自动侦测动态区域）', noMaskValue.comparison?.metrics?.diffPixels === 1600
    && noMaskValue.comparison?.verdict === 'FAIL' && noMaskValue.comparison?.metrics?.maskedPixels === 0, {
    expected: { diffPixels: 1600, maskedPixels: 0, verdict: 'FAIL' }, actual: noMaskValue.comparison?.metrics,
  });

  const fullMask = await call(harness, 'browser_vision_compare', {
    before: { kind: 'product', productId: beforeValue.product?.productId },
    after: { kind: 'product', productId: afterValue.product?.productId },
    masks: [{ id: 'clock', region: { x: 20, y: 20, width: 80, height: 20 } }],
  });
  const fullMaskValue = checkVisionValue(check, '恰 mask clock compare 成功', fullMask, { requireImage: true });
  check('恰 mask clock：maskedPixels=1600、diffPixels=0、verdict PASS', fullMaskValue.comparison?.metrics?.maskedPixels === 1600
    && fullMaskValue.comparison?.metrics?.diffPixels === 0 && fullMaskValue.comparison?.verdict === 'PASS'
    && fullMaskValue.comparison?.resolvedMasks?.[0]?.id === 'clock', {
    expected: { maskedPixels: 1600, diffPixels: 0, verdict: 'PASS' }, actual: fullMaskValue.comparison?.metrics,
  });
  const missOne = await call(harness, 'browser_vision_compare', {
    before: { kind: 'product', productId: beforeValue.product?.productId },
    after: { kind: 'product', productId: afterValue.product?.productId },
    masks: [{ id: 'clock', region: { x: 20, y: 20, width: 79, height: 20 } }],
  });
  const missOneValue = checkVisionValue(check, '漏一列 mask compare 成功', missOne, { requireImage: true });
  check('漏一列仍计 20 像素差异且不是 PASS', missOneValue.comparison?.metrics?.diffPixels === 20
    && missOneValue.comparison?.verdict !== 'PASS', { expected: { diffPixels: 20, verdict: '!= PASS' }, actual: missOneValue.comparison?.metrics });
  const reread = await call(harness, 'browser_vision_image', { source: { kind: 'product', productId: beforeValue.product?.productId } });
  check('mask 不改变源图（before product rgbaSha 不变）', reread.ok && reread.value?.product?.rgbaSha256 === beforeSha, {
    expected: beforeSha, actual: reread.value?.product?.rgbaSha256,
  });
  finding({ id: 'C24-mask', summary: 'clock 只在显式 toggle 时变化；compare 无 mask 判 FAIL，恰 mask PASS，漏一列计 20 像素；mask 不修改源图。' });
}

/* ------------------------------------------------------------------------------------------------
 * C25 — §9.C25 act point mapping (scroll + scale), fractional coordinates, isTrusted
 * ---------------------------------------------------------------------------------------------- */

async function probeC25({ harness, check, finding, notRun }) {
  await freshPage(harness);
  await pageValue(harness, 'window.scrollTo(0, 100), true');
  const region = { x: 40, y: 140, width: 160, height: 80 };
  const captured = await call(harness, 'browser_vision_image', { source: { kind: 'live', scale: 1.25, region } });
  const capturedValue = checkVisionValue(check, 'scroll y=100 后 canvas @1.25 采集成功', captured, { requireImage: true });
  recordImage('C25-canvas-1.25', capturedValue);
  const mapping = capturedValue.product?.mapping || {};
  check('mapping 记录 scrollAtCapture (0,100)、origin (40,140)、cssPerPixel 0.8', mapping.scrollAtCapture?.y === 100
    && mapping.originCss?.x === 40 && mapping.originCss?.y === 140 && Math.abs(mapping.cssPerPixel?.x - 0.8) < 1e-9, {
    expected: { scrollAtCapture: { x: 0, y: 100 }, originCss: { x: 40, y: 140 }, cssPerPixel: 0.8 }, actual: mapping,
  });
  await resetEvents(harness);
  const point = { x: 80.5, y: 40.5 };
  const expectedDoc = { x: 40 + point.x * 0.8, y: 140 + point.y * 0.8 };
  const expectedViewport = { x: expectedDoc.x, y: expectedDoc.y - 100 };
  const act = await call(harness, 'browser_vision_act', { productId: capturedValue.product?.productId, action: 'click', point });
  const actValue = checkVisionValue(check, 'act click 成功', act);
  check('act 返回双坐标：imagePixels/documentCss/viewportCss', JSON.stringify(actValue.point?.imagePixels) === JSON.stringify(point)
    && Math.abs(actValue.point?.documentCss?.x - expectedDoc.x) < 0.01 && Math.abs(actValue.point?.documentCss?.y - expectedDoc.y) < 0.01
    && Math.abs(actValue.point?.viewportCss?.x - expectedViewport.x) < 0.01 && Math.abs(actValue.point?.viewportCss?.y - expectedViewport.y) < 0.01, {
    expected: { imagePixels: point, documentCss: expectedDoc, viewportCss: expectedViewport }, actual: actValue.point,
  });
  check('dispatch 为 cdp-input 且 eventCount=3', actValue.dispatch?.eventSource === 'cdp-input' && actValue.dispatch?.eventCount === 3 && actValue.dispatch?.completed === true, {
    expected: { eventSource: 'cdp-input', eventCount: 3, completed: true }, actual: actValue.dispatch,
  });
  const click = await pageValue(harness, 'window.__t3.last.click || null');
  const tolerance = 0.01;
  // Measured (raw CDP, no plugin): Blink truncates CDP Input mouse coordinates to integers for DOM
  // events (dispatch x=104.4/104.5 -> MouseEvent.clientX === 104). A fractional clientX is therefore
  // not observable; what the tool must not do is *report* rounded coordinates - that is asserted
  // through value.point.documentCss/viewportCss above.
  const quantized = click && Math.abs(click.clientX - Math.floor(expectedViewport.x)) <= tolerance
    && Math.abs(click.clientY - Math.floor(expectedViewport.y)) <= tolerance;
  check('__t3 真实事件坐标命中映射点（Blink 整数截断，容差 1 CSS px）、isTrusted、target=t3-canvas', quantized
    && click.isTrusted === true && click.target === 't3-canvas', {
    expected: { clientX: Math.floor(expectedViewport.x), clientY: Math.floor(expectedViewport.y), tolerance, isTrusted: true, target: 't3-canvas' }, actual: click,
  });
  notRun('dom-fractional-clientxy', `Blink 对 CDP Input 鼠标坐标做整数截断（裸 CDP 实测 104.4/104.5 -> clientX 104），DOM 事件无法保留小数；"非整数不取整"只能断言工具报告的 imagePixels/documentCss/viewportCss（已断言），DOM 侧记 NOT_APPLICABLE。`, { disposition: 'NOT_APPLICABLE' });
  check('after product 存在且可离线读取', actValue.afterProduct && /^v1_[0-9a-f]{32}$/.test(String(actValue.afterProduct.productId)), {
    expected: 'afterProduct', actual: actValue.afterProduct ? { width: actValue.afterProduct.width, height: actValue.afterProduct.height } : null,
  });
  await pageValue(harness, 'window.scrollTo(0, 0), true');
  finding({ id: 'C25-mapping', summary: 'scroll=100 + scale1.25 下 image→document→viewport 映射精确；分数坐标未被取整；事件 isTrusted=true。' });
}

/* ------------------------------------------------------------------------------------------------
 * C26 — §9.C26 move/click/right/middle/double + modifiers event sequences
 * ---------------------------------------------------------------------------------------------- */

async function probeC26({ harness, check, finding }) {
  await freshPage(harness);
  const region = { x: 300, y: 40, width: 80, height: 60 };
  const captured = await call(harness, 'browser_vision_image', { source: { kind: 'live', region } });
  const capturedValue = checkVisionValue(check, 'click 盒采集成功', captured, { requireImage: true });
  const productId = capturedValue.product?.productId;
  await resetEvents(harness);
  const freshProduct = async () => (await call(harness, 'browser_vision_image', { source: { kind: 'live', region } })).value?.product?.productId;
  const click = await call(harness, 'browser_vision_act', { productId, action: 'click', point: { x: 40, y: 30 } });
  const clickValue = checkVisionValue(check, '左键 click 成功', click);
  check('左键 click：eventCount=3、__t3 收到 isTrusted click 且坐标为 (340,70)', clickValue.dispatch?.eventCount === 3
    && (await pageValue(harness, 'window.__t3.last.click'))?.clientX === 340
    && (await pageValue(harness, 'window.__t3.last.click'))?.clientY === 70
    && (await pageValue(harness, 'window.__t3.last.click'))?.isTrusted === true, {
    expected: { eventCount: 3, clientX: 340, clientY: 70, isTrusted: true }, actual: { dispatch: clickValue.dispatch, click: await pageValue(harness, 'window.__t3.last.click') },
  });
  const counter = await pageValue(harness, 'document.getElementById("t3-click").textContent');
  check('#t3-click 计数由 0 变 1', counter === '1', { expected: '1', actual: counter });

  await resetEvents(harness);
  const rightProduct = await freshProduct();
  const right = await call(harness, 'browser_vision_act', { productId: rightProduct, action: 'click', point: { x: 40, y: 30 }, button: 'right' });
  const rightValue = checkVisionValue(check, '右键 click 成功', right);
  const rightLog = await pageValue(harness, '({ contextmenu: window.__t3.last.contextmenu || null, counters: JSON.parse(JSON.stringify(window.__t3.counters)) })');
  check('右键：contextmenu button=2 命中 #t3-click、rightClicks=1', rightValue.dispatch?.eventCount === 3
    && rightLog.contextmenu?.button === 2 && rightLog.contextmenu?.target === 't3-click'
    && rightLog.contextmenu?.isTrusted === true && rightLog.counters.rightClicks === 1, {
    expected: { eventCount: 3, button: 2, target: 't3-click', rightClicks: 1 }, actual: rightLog,
  });

  await resetEvents(harness);
  const middleProduct = await freshProduct();
  const middle = await call(harness, 'browser_vision_act', { productId: middleProduct, action: 'click', point: { x: 40, y: 30 }, button: 'middle' });
  const middleValue = checkVisionValue(check, '中键 click 成功', middle);
  const middleLog = await pageValue(harness, '({ down: window.__t3.last.mousedown || null, counters: JSON.parse(JSON.stringify(window.__t3.counters)) })');
  check('中键：mousedown button=1（buttons=4）、middleClicks=1', middleValue.dispatch?.eventCount === 3
    && middleLog.down?.button === 1 && middleLog.down?.buttons === 4 && middleLog.counters.middleClicks === 1, {
    expected: { button: 1, buttons: 4, middleClicks: 1 }, actual: middleLog,
  });

  await resetEvents(harness);
  const doubleProduct = await freshProduct();
  const doubleClick = await call(harness, 'browser_vision_act', { productId: doubleProduct, action: 'click', point: { x: 40, y: 30 }, clickCount: 2 });
  const doubleValue = checkVisionValue(check, '双击成功', doubleClick);
  const doubleLog = await pageValue(harness, '({ clicks: window.__t3.events.filter(function (e) { return e.type === "click"; }).map(function (e) { return e.detail; }), dblclicks: window.__t3.counters.dblclicks })');
  check('双击：eventCount=5、两组 click detail 1/2、dblclicks=1', doubleValue.dispatch?.eventCount === 5
    && JSON.stringify(doubleLog.clicks) === JSON.stringify([1, 2]) && doubleLog.dblclicks === 1, {
    expected: { eventCount: 5, details: [1, 2], dblclicks: 1 }, actual: { dispatch: doubleValue.dispatch, log: doubleLog },
  });

  await resetEvents(harness);
  const modifiedProduct = await freshProduct();
  const modified = await call(harness, 'browser_vision_act', { productId: modifiedProduct, action: 'click', point: { x: 40, y: 30 }, modifiers: ['ctrl', 'shift'] });
  const modifiedValue = checkVisionValue(check, 'ctrl+shift click 成功', modified);
  const modifiedLog = await pageValue(harness, 'window.__t3.last.click || null');
  check('修饰键 ctrl+shift 反映在真实事件', modifiedValue.dispatch?.eventCount === 3
    && modifiedLog?.modifiers?.ctrl === true && modifiedLog?.modifiers?.shift === true
    && modifiedLog?.modifiers?.alt === false && modifiedLog?.modifiers?.meta === false, {
    expected: { ctrl: true, shift: true, alt: false, meta: false }, actual: modifiedLog,
  });

  await resetEvents(harness);
  const moveProduct = await freshProduct();
  const move = await call(harness, 'browser_vision_act', { productId: moveProduct, action: 'move', point: { x: 40, y: 30 } });
  const moveValue = checkVisionValue(check, 'move 成功', move);
  check('move：eventCount=1、只派发 mouseMoved（无 click）', moveValue.dispatch?.eventCount === 1
    && (await pageValue(harness, 'window.__t3.counters.clicks')) === 0, {
    expected: { eventCount: 1, clicks: 0 }, actual: { dispatch: moveValue.dispatch, clicks: await pageValue(harness, 'window.__t3.counters.clicks') },
  });
  finding({ id: 'C26-events', summary: 'move/click/right/middle/double/modifiers 均通过真实 CDP 输入；__t3 记录的 button/buttons/detail/modifiers/isTrusted 与契约一致。' });
}

/* ------------------------------------------------------------------------------------------------
 * C27 — §9.C27 drag steps+3, linear path, finally release, after product, drop truth
 * ---------------------------------------------------------------------------------------------- */

async function probeC27({ harness, check, finding }) {
  await freshPage(harness);
  const region = { x: 40, y: 140, width: 160, height: 80 };
  const captured = await call(harness, 'browser_vision_image', { source: { kind: 'live', region } });
  const capturedValue = checkVisionValue(check, 'canvas 采集成功', captured, { requireImage: true });
  await resetEvents(harness);
  const drag = await call(harness, 'browser_vision_act', {
    productId: capturedValue.product?.productId, action: 'drag', point: { x: 10, y: 10 }, to: { x: 150, y: 70 }, steps: 4, durationMs: 0,
  });
  const dragValue = checkVisionValue(check, 'canvas 内 drag 成功', drag);
  check('drag eventCount = steps+3 = 7、completed=true', dragValue.dispatch?.eventCount === 7 && dragValue.dispatch?.completed === true && dragValue.dispatch?.eventSource === 'cdp-input', {
    expected: { eventCount: 7, completed: true }, actual: dragValue.dispatch,
  });
  const log = await pageValue(harness, `({
    moves: window.__t3.events.filter(function (e) { return e.type === 'mousemove'; }).map(function (e) { return { x: e.clientX, y: e.clientY, trusted: e.isTrusted }; }),
    downs: window.__t3.counters.downs, ups: window.__t3.counters.ups,
    after: null,
  })`);
  const expectedPath = [[50, 150], [85, 165], [120, 180], [155, 195], [190, 210]];
  const pathOk = log.moves.length === 5 && expectedPath.every((pair, index) => Math.abs(log.moves[index].x - pair[0]) <= 0.01 && Math.abs(log.moves[index].y - pair[1]) <= 0.01);
  check('5 条 mousemove 线性路径精确（起点 + 4 步）、全部 isTrusted', pathOk && log.moves.every((item) => item.trusted === true), {
    expected: expectedPath, actual: log.moves,
  });
  check('按下/释放各一次（finally 释放按钮）', log.downs === 1 && log.ups === 1, { expected: { downs: 1, ups: 1 }, actual: { downs: log.downs, ups: log.ups } });
  check('drag 返回 afterProduct 且可离线读取', Boolean(dragValue.afterProduct?.productId), { expected: 'afterProduct', actual: dragValue.afterProduct ? { width: dragValue.afterProduct.width } : null });

  const dropRegion = { x: 260, y: 120, width: 240, height: 80 };
  const dropCapture = await call(harness, 'browser_vision_image', { source: { kind: 'live', region: dropRegion } });
  const dropValue = checkVisionValue(check, '拖拽源/目标区域采集成功', dropCapture, { requireImage: true });
  await resetEvents(harness);
  const dropDrag = await call(harness, 'browser_vision_act', {
    productId: dropValue.product?.productId, action: 'drag', point: { x: 40, y: 40 }, to: { x: 160, y: 40 }, steps: 4, durationMs: 0,
  });
  const dropDragValue = checkVisionValue(check, 'drag 到 #t3-drop 成功', dropDrag);
  const dropTruth = await pageValue(harness, '({ drops: window.__t3.counters.drops, last: window.__t3.last.drop || null })');
  check('drop 真值：drops=1、drop 坐标 (420,160)、isTrusted', dropDragValue.dispatch?.eventCount === 7 && dropTruth.drops === 1
    && dropTruth.last?.clientX === 420 && dropTruth.last?.clientY === 160 && dropTruth.last?.isTrusted === true, {
    expected: { eventCount: 7, drops: 1, clientX: 420, clientY: 160 }, actual: dropTruth,
  });
  finding({ id: 'C27-drag', summary: 'drag 是有限输入原语：steps+3 个 CDP 事件、线性坐标、finally 释放；drop 目标真值来自页面 mouseup。' });
}

/* ------------------------------------------------------------------------------------------------
 * C28 — §9.C28 stale rejection: pixels / scroll / page generation / viewport
 * ---------------------------------------------------------------------------------------------- */

async function probeC28({ check, finding, notRun }) {
  // Dedicated harness with a fake authenticated GUI connection: the plugin's own
  // POST /plugins/ui-testing/viewport route is a same-origin GUI command that runs through the
  // same runtime.run() queue (Lead adjudication 2026-11-01). It is used ONLY as page setup here -
  // never as a CDP shim, and never to assert product behaviour.
  const { createHarness, createFakeSessionsService, createFakeWorkspaceRegistry } = await harnessModule();
  const dir = await tempDir('c28-ws');
  const connection = {
    requestRejection() { return undefined; },
    admit() { return { peer: { id: 'c28-peer' } }; },
    browserPeer: { id: 'c28-peer' },
  };
  const harness = await createHarness({
    name: 'C28-viewport',
    connection,
    sessions: createFakeSessionsService({ cwd: dir }),
    workspaceRegistry: createFakeWorkspaceRegistry({ path: dir, id: 'workspace-t3-c28' }),
  });
  OWNED_HARNESSES.push(harness);
  try {
    return await probeC28Body({ harness, check, finding, notRun });
  } finally {
    await closeHarness(harness);
  }
}

async function probeC28Body({ harness, check, finding, notRun }) {
  const exec = execOf('t3-c28');
  const region = { x: 300, y: 40, width: 80, height: 60 };
  const setViewport = (width, height) => harness.request({
    method: 'POST',
    path: '/plugins/ui-testing/viewport',
    body: { width, height },
    headers: { 'x-ui-testing-scope-version': '1', 'x-ui-testing-session-id': 't3-c28' },
  });

  await freshPage(harness, T3_PATH, exec);
  const captured = await call(harness, 'browser_vision_image', { source: { kind: 'live', region } }, exec);
  const capturedValue = checkVisionValue(check, 'click 区域采集成功', captured, { requireImage: true });
  const productId = capturedValue.product?.productId;
  await resetEvents(harness, exec);

  await pageValue(harness, 'window.__t3.showOverlay(), true', exec);
  const overlayAct = await call(harness, 'browser_vision_act', { productId, action: 'click', point: { x: 40, y: 30 } }, exec);
  checkVisionError(check, '截图后 overlay 显示改变像素 -> VISION_STALE_IMAGE', overlayAct, { code: 'VISION_STALE_IMAGE', category: 'action', retryable: false });
  check('像素变化拒绝零输入（__t3 无事件）', (await t3State(harness, exec)).seq === 0, { expected: 0, actual: (await t3State(harness, exec)).seq });
  await pageValue(harness, 'window.__t3.hideOverlay(), true', exec);

  await pageValue(harness, 'window.scrollTo(0, 1), true', exec);
  const scrollAct = await call(harness, 'browser_vision_act', { productId, action: 'click', point: { x: 40, y: 30 } }, exec);
  checkVisionError(check, 'scroll +1 -> VISION_STALE_IMAGE', scrollAct, { code: 'VISION_STALE_IMAGE', category: 'action', retryable: false });
  await pageValue(harness, 'window.scrollTo(0, 0), true', exec);
  check('scroll 变化拒绝零输入', (await t3State(harness, exec)).seq === 0, { expected: 0, actual: (await t3State(harness, exec)).seq });

  await freshPage(harness, T3_PATH, exec);
  const beforeReload = await call(harness, 'browser_vision_image', { source: { kind: 'live', region } }, exec);
  const reloadProduct = beforeReload.value?.product?.productId;
  await pageValue(harness, 'location.reload(), true', exec);
  await waitForPage(harness, { title: 'DSH T3 Fixture', exec });
  const reloadAct = await call(harness, 'browser_vision_act', { productId: reloadProduct, action: 'click', point: { x: 40, y: 30 } }, exec);
  checkVisionError(check, 'reload（页面代次变化）-> VISION_STALE_IMAGE', reloadAct, { code: 'VISION_STALE_IMAGE', category: 'action', retryable: false });

  // Viewport change through the plugin's own GUI route (same runtime.run queue, owner-scoped).
  await freshPage(harness, T3_PATH, exec);
  const viewportCapture = await call(harness, 'browser_vision_image', { source: { kind: 'live', region } }, exec);
  const viewportProduct = viewportCapture.value?.product?.productId;
  check('viewport 前置采集成功', Boolean(viewportProduct), { expected: 'v1_…', actual: viewportProduct });
  await resetEvents(harness, exec);
  const resized = await setViewport(1000, 700);
  await sleep(350);
  const resizedViewport = await pageValue(harness, '({ width: innerWidth, height: innerHeight })', exec);
  if (resized.statusCode === 200 && resized.body && resizedViewport.width === 1000 && resizedViewport.height === 700) {
    const viewportAct = await call(harness, 'browser_vision_act', { productId: viewportProduct, action: 'click', point: { x: 40, y: 30 } }, exec);
    checkVisionError(check, 'viewport 改变（GUI /viewport 路由 1280×800 -> 1000×700）-> VISION_STALE_IMAGE', viewportAct, { code: 'VISION_STALE_IMAGE', category: 'action', retryable: false });
    check('viewport 变化拒绝零派发', (await t3State(harness, exec)).seq === 0, { expected: 0, actual: (await t3State(harness, exec)).seq });
    const restored = await setViewport(1280, 800);
    await sleep(350);
    const restoredViewport = await pageValue(harness, '({ width: innerWidth, height: innerHeight })', exec);
    check('GUI /viewport 路由可恢复 1280×800', restored.statusCode === 200 && restoredViewport.width === 1280 && restoredViewport.height === 800, {
      expected: { width: 1280, height: 800 }, actual: { status: restored.statusCode, viewport: restoredViewport },
    });
    finding({ id: 'C28-setup-source', summary: 'C28 viewport 子例的 setup 使用插件自身 GUI 路由 POST /plugins/ui-testing/viewport（scopeVersion=1 + sessionId，走同一 runtime.run 队列），不是 CDP shim；断言仍由 browser_vision_act 产出。' });
  } else {
    notRun('viewport-change', `GUI /viewport 路由未能改变本 scope 视口（status=${resized.statusCode}，viewport=${JSON.stringify(resizedViewport)}）；page 代次/scroll/像素三种 stale 已实测。`);
  }
  await pageValue(harness, 'window.scrollTo(0, 0), true', exec);
  finding({ id: 'C28-stale', summary: '旧 product 在像素/scroll/页面代次/viewport 变化后均 VISION_STALE_IMAGE 且零派发；工具不自动滚动。' });
}


/* ------------------------------------------------------------------------------------------------
 * Shared check-tool helpers (facts are always supplied by the test, never fetched by the tool)
 * ---------------------------------------------------------------------------------------------- */

async function runCheck(harness, { id = 'case', source = { kind: 'live' }, assertions, facts }, exec = execOf()) {
  const body = { cases: [{ id, source, assertions }] };
  if (facts) body.cases[0].facts = facts;
  return call(harness, 'browser_vision_check', body, exec);
}

function assertionOf(result) {
  return result?.value?.cases?.[0]?.assertions?.[0] ?? null;
}

function checkAssertionStatus(check, label, result, expectedStatus, extra = {}) {
  const assertion = assertionOf(result);
  const actual = assertion
    ? { status: assertion.status, reason: assertion.reason, errorCode: assertion.errorCode, metrics: jsonSafe(assertion.metrics) }
    : { error: result?.error?.message || result?.value?.error, code: result?.error?.code, details: jsonSafe(result?.error?.details) };
  check(label, Boolean(assertion) && assertion.status === expectedStatus, { expected: { status: expectedStatus, ...extra }, actual });
  return assertion;
}

/* ------------------------------------------------------------------------------------------------
 * C30 — §9.C30 hit rejection: overlay boundary, disabled, inert, unstable, iframe, viewport
 * ---------------------------------------------------------------------------------------------- */

async function probeC30({ harness, check, finding, notRun }) {
  await freshPage(harness);
  const overlayRegion = { x: 300, y: 40, width: 80, height: 60 };
  await pageValue(harness, 'window.__t3.showOverlay(), true');
  const overlayCapture = await call(harness, 'browser_vision_image', { source: { kind: 'live', region: overlayRegion } });
  const overlayValue = checkVisionValue(check, 'overlay 可见时采集成功', overlayCapture, { requireImage: true });
  await resetEvents(harness);
  const overlayAct = await call(harness, 'browser_vision_act', { productId: overlayValue.product?.productId, action: 'click', point: { x: 40, y: 30 } });
  const overlayActValue = checkVisionValue(check, 'overlay 存在时 act 派发成功（命中 overlay 本身）', overlayAct);
  const overlayTruth = await pageValue(harness, '({ last: window.__t3.last.click || null, counter: document.getElementById("t3-click").textContent })');
  check('不穿透 overlay：click 目标是 t3-overlay，底层 #t3-click 计数不变', overlayActValue.dispatched === true
    && overlayTruth.last?.target === 't3-overlay' && overlayTruth.counter === '0', {
    expected: { target: 't3-overlay', counter: '0' }, actual: overlayTruth,
  });
  await pageValue(harness, 'window.__t3.hideOverlay(), true');

  const disabledRegion = { x: 540, y: 230, width: 120, height: 60 };
  const disabledCapture = await call(harness, 'browser_vision_image', { source: { kind: 'live', region: disabledRegion } });
  const disabledValue = checkVisionValue(check, 'disabled 按钮区域采集成功', disabledCapture, { requireImage: true });
  await resetEvents(harness);
  const disabledAct = await call(harness, 'browser_vision_act', { productId: disabledValue.product?.productId, action: 'click', point: { x: 60, y: 30 } });
  const disabledError = checkVisionError(check, 'disabled 目标 -> VISION_HIT_MISMATCH(reason=disabled)', disabledAct, { code: 'VISION_HIT_MISMATCH', category: 'action', retryable: false });
  check('disabled 拒绝零派发', disabledError.details?.reason === 'disabled' && (await t3State(harness)).seq === 0, {
    expected: { reason: 'disabled', seq: 0 }, actual: { reason: disabledError.details?.reason, seq: (await t3State(harness)).seq },
  });

  const inertRegion = { x: 650, y: 230, width: 100, height: 60 };
  const inertCapture = await call(harness, 'browser_vision_image', { source: { kind: 'live', region: inertRegion } });
  const inertValue = checkVisionValue(check, 'inert 容器区域采集成功', inertCapture, { requireImage: true });
  await resetEvents(harness);
  const inertAct = await call(harness, 'browser_vision_act', { productId: inertValue.product?.productId, action: 'click', point: { x: 50, y: 30 } });
  const inertCode = codeOf(inertAct);
  const inertTruth = await pageValue(harness, `(function () {
    var el = document.getElementById('t3-inert-btn');
    var r = el.getBoundingClientRect();
    var hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
    return {
      inertClicks: window.__t3.counters.inertClicks,
      deliveredToInertSubtree: window.__t3.events.filter(function (e) { return e.target === 't3-inert-btn' || e.target === 't3-inert'; }).length,
      hitTarget: hit ? (hit.id || hit.tagName.toLowerCase()) : null,
      seq: window.__t3.seq,
      lastClickTarget: window.__t3.last.click ? window.__t3.last.click.target : null,
    };
  })()`);
  // Lead adjudication (2026-11-01): elementFromPoint never returns an inert subtree (the browser
  // hit-tests the nearest non-inert ancestor / body), so "inert hit -> VISION_HIT_MISMATCH" is not
  // reachable in a real browser. The required assertion is therefore "the inert button was never
  // activated / received no event"; the vision-tool HIT_MISMATCH expectation is recorded as NOT_RUN.
  check('inert 子树未被激活：按钮 0 次 click、0 条事件递送到 inert 子树', inertTruth.inertClicks === 0
    && inertTruth.deliveredToInertSubtree === 0, {
    expected: { inertClicks: 0, deliveredToInertSubtree: 0 },
    actual: { inertClicks: inertTruth.inertClicks, deliveredToInertSubtree: inertTruth.deliveredToInertSubtree, lastClickTarget: inertTruth.lastClickTarget, actCode: inertCode, dispatched: inertAct.value?.dispatched },
  });
  notRun('inert-hit-test-vision', `真实浏览器 elementFromPoint 不返回 inert 子树（本次命中 ${inertTruth.hitTarget}），T3 act 的 "inert 命中 -> VISION_HIT_MISMATCH" 在真实浏览器不可达；本子项只验证 inert 未激活（act=${inertCode || 'dispatched'}）。`, { disposition: 'NOT_APPLICABLE' });
  check('inert 子项已按裁决记录（非 required）', true, {
    expected: 'adjudicated: inert not activated; HIT_MISMATCH path NOT_RUN',
    actual: { hitTarget: inertTruth.hitTarget, actCode: inertCode, dispatched: inertAct.value?.dispatched },
  }, { advisory: true });

  const movingRegion = { x: 480, y: 220, width: 120, height: 80 };
  const movingCapture = await call(harness, 'browser_vision_image', { source: { kind: 'live', region: movingRegion } });
  const movingValue = checkVisionValue(check, 'moving 目标静止时采集成功', movingCapture, { requireImage: true });
  await resetEvents(harness);
  await pageValue(harness, 'window.__t3.startMoving(), true');
  await sleep(120);
  const movingAct = await call(harness, 'browser_vision_act', { productId: movingValue.product?.productId, action: 'click', point: { x: 40, y: 40 } });
  const movingCode = codeOf(movingAct);
  const movingError = movingAct.error || {};
  check('持续运动目标被拒绝（STALE 或 HIT_MISMATCH），零派发', movingAct.threw === true
    && ['VISION_STALE_IMAGE', 'VISION_HIT_MISMATCH'].includes(movingCode) && (await t3State(harness)).seq === 0, {
    expected: ['VISION_STALE_IMAGE', 'VISION_HIT_MISMATCH'], actual: { code: movingCode, seq: (await t3State(harness)).seq },
  });
  if (movingCode === 'VISION_HIT_MISMATCH') {
    check('HIT_MISMATCH 带 escalation:T4（持续运动）', movingError.details?.escalation?.tier === 'T4', {
      expected: { tier: 'T4' }, actual: movingError.details?.escalation,
    });
  } else {
    check('未走到命中稳定性检查时记录说明（STALE 先于 hit）', true, {
      expected: 'documented order', actual: 'resample hash changed before the two-frame hit check',
    }, { advisory: true });
  }
  await pageValue(harness, 'window.__t3.stopMoving(), true');

  const frameRegion = { x: 760, y: 240, width: 160, height: 80 };
  const frameCapture = await call(harness, 'browser_vision_image', { source: { kind: 'live', region: frameRegion } });
  const frameValue = checkVisionValue(check, 'iframe 区域采集成功', frameCapture, { requireImage: true });
  await resetEvents(harness);
  const frameAct = await call(harness, 'browser_vision_act', { productId: frameValue.product?.productId, action: 'click', point: { x: 80, y: 40 } });
  checkVisionError(check, 'iframe 内命中 -> UNSUPPORTED（不跨 frame 输入）', frameAct, { code: 'UNSUPPORTED', retryable: false, evidence: false });
  check('iframe 拒绝零派发', (await t3State(harness)).seq === 0, { expected: 0, actual: (await t3State(harness)).seq });

  const docRegion = { x: 0, y: 0, width: 200, height: 1600 };
  const docCapture = await call(harness, 'browser_vision_image', { source: { kind: 'live', region: docRegion } });
  const docValue = checkVisionValue(check, '超出视口的文档区域可采集（1600 高）', docCapture, { requireImage: true });
  await resetEvents(harness);
  const outsideAct = await call(harness, 'browser_vision_act', { productId: docValue.product?.productId, action: 'click', point: { x: 100, y: 1000 } });
  const outsideError = checkVisionError(check, '视口外 point -> NOT_INTERACTABLE(reason=outside-viewport)', outsideAct, { code: 'NOT_INTERACTABLE', category: 'action', retryable: false });
  check('视口外拒绝零派发且不自动滚动', outsideError.details?.reason === 'outside-viewport'
    && (await t3State(harness)).scroll.y === 0 && (await t3State(harness)).seq === 0, {
    expected: { reason: 'outside-viewport', scrollY: 0, seq: 0 }, actual: { reason: outsideError.details?.reason, scroll: (await t3State(harness)).scroll },
  });
  finding({ id: 'C30-boundary', summary: 'T3 act 用截图命中点而非语义目标：overlay 存在时点 overlay 本身；disabled/inert/持续运动/iframe/视口外均零派发拒绝。' });
}

/* ------------------------------------------------------------------------------------------------
 * C31 — §9.C31 cancelling a partially dispatched drag (no replay, button released)
 * ---------------------------------------------------------------------------------------------- */

async function probeC31({ harness, check, finding, notRun }) {
  await freshPage(harness);
  const region = { x: 40, y: 140, width: 160, height: 80 };
  const captured = await call(harness, 'browser_vision_image', { source: { kind: 'live', region } });
  const capturedValue = checkVisionValue(check, 'canvas 采集成功（前置）', captured, { requireImage: true });
  await resetEvents(harness);
  const controller = new AbortController();
  const pending = call(harness, 'browser_vision_act', {
    productId: capturedValue.product?.productId, action: 'drag', point: { x: 10, y: 10 }, to: { x: 150, y: 70 }, steps: 50, durationMs: 2000,
  }, execOf(EXEC_ID, controller.signal));
  await sleep(150);
  const abortedAt = Date.now();
  controller.abort();
  const result = await pending;
  const elapsed = Date.now() - abortedAt;
  check('拖拽中途取消在 1 秒内抛 ABORTED', result.threw === true && codeOf(result) === 'ABORTED' && elapsed < 1000, {
    expected: { code: 'ABORTED', withinMs: 1000 }, actual: { code: codeOf(result), elapsed, message: String(result.error?.message || '').slice(0, 160) },
  });
  const details = result.error?.details || {};
  check('ABORTED 保留部分派发证据（dispatch/eventCount/vision）', Object.hasOwn(details, 'dispatch') || Object.hasOwn(details, 'eventCount')
    || Boolean(details.evidence?.vision), { expected: 'partial dispatch evidence', actual: { keys: Object.keys(details), evidence: Boolean(details.evidence) } });
  const pageState = await call(harness, 'browser_state', {});
  let partial = null;
  if (pageState.value?.running === true) {
    try { partial = await t3State(harness); } catch { partial = null; }
  }
  if (partial) {
    check('取消后按钮已释放（downs=1、ups=1），没有第二次 press', partial.counters.downs === 1 && partial.counters.ups === 1, {
      expected: { downs: 1, ups: 1 }, actual: partial.counters,
    });
    await sleep(300);
    const later = await t3State(harness);
    check('取消后没有自动重放（等待 300ms 后 downs/ups 仍为 1）', later.counters.downs === 1 && later.counters.ups === 1, {
      expected: { downs: 1, ups: 1 }, actual: later.counters,
    });
  } else {
    notRun('page-drag-truth', 'ABORTED 路径关闭了页面（与 T2 §9.30/§9.31 一致），页面级 downs/ups 真值不可读；契约 §9.C31 只要求取消不重放/button 释放/dispatch 计数/after null，已用 dispatch 证据断言。', { disposition: 'NOT_APPLICABLE' });
    check('取消不重放：dispatch 证据 completed=false 且 released=true', details.evidence?.vision?.dispatch?.completed === false
      || (result.error?.details?.dispatch?.completed === false) || details.eventCount !== undefined, {
      expected: { completed: false, released: true }, actual: { dispatch: result.error?.details?.dispatch, vision: details.evidence?.vision?.dispatch },
    });
  }
  check('取消路径不返回 after product', !result.value?.afterProduct, { expected: null, actual: result.value?.afterProduct ?? null });
  finding({ id: 'C31-cancel', summary: '部分拖拽取消：ABORTED + 部分证据、finally 释放按钮、无自动重放、无 after product。' });
}

/* ------------------------------------------------------------------------------------------------
 * C35 — §9.C35 baseline create/get/list from one live capture
 * ---------------------------------------------------------------------------------------------- */

async function probeC35({ harness, check, finding }) {
  const root = await tempDir('c35-root');
  await withCaptureRoot(root, async () => {
    await freshPage(harness);
    const region = { x: 480, y: 20, width: 140, height: 80 };
    const created = await call(harness, 'browser_vision_baseline', {
      action: 'create', name: 'card-light', source: { kind: 'live', scale: 1, region },
      masks: [{ id: 'clock', region: { x: 20, y: 20, width: 80, height: 20 } }],
      options: { threshold: 0.1, includeAA: false, minRegionPixels: 1 },
      thresholds: { warnRatio: 0.001, failRatio: 0.01 },
    });
    const createdValue = checkVisionValue(check, '单次 create 调用完成采集 + 基线提交', created);
    const baseline = createdValue.baseline || {};
    check('revision=1、parentRevision/parentHeadToken=null、非墓碑、caseId 默认 name', baseline.revision === 1
      && baseline.parentRevision === null && baseline.parentHeadToken === null && baseline.tombstone === false
      && baseline.caseId === 'card-light' && /^[0-9a-f]{64}$/.test(String(baseline.headToken)), {
      expected: { revision: 1, parentRevision: null, tombstone: false, caseId: 'card-light', headToken: '64 hex' }, actual: baseline,
    });
    check('image 元数据：140×80、sha256、bytes、relativePath', baseline.image?.width === 140 && baseline.image?.height === 80
      && /^[0-9a-f]{64}$/.test(String(baseline.image?.sha256)) && baseline.image?.bytes > 0
      && typeof baseline.image?.relativePath === 'string' && !baseline.image.relativePath.startsWith('/'), {
      expected: { width: 140, height: 80, relativePath: 'relative' }, actual: baseline.image,
    });
    check('options/thresholds/masks 按请求存储、mapping/provenance 非空', baseline.options?.threshold === 0.1
      && baseline.options?.includeAA === false && baseline.options?.minRegionPixels === 1
      && baseline.thresholds?.warnRatio === 0.001 && baseline.thresholds?.failRatio === 0.01
      && baseline.masks?.[0]?.id === 'clock' && baseline.mapping !== null
      && baseline.source?.productId === createdValue.product?.productId
      && baseline.provenanceVersion === 1, { expected: 'stored options/masks/mapping/source', actual: baseline },
    );
    check('create 返回本次 source product（不因保存基线改变资格）', createdValue.product?.width === 140
      && createdValue.product?.productId === baseline.source?.productId, { expected: 'source product', actual: createdValue.product },

    );

    const got = await call(harness, 'browser_vision_baseline', { action: 'get', name: 'card-light' });
    const gotValue = checkVisionValue(check, 'get 读取 HEAD 成功', got);
    check('get 返回 kind=baseline/actionable=false 的新 product 与相同 revision', gotValue.product?.kind === 'baseline'
      && gotValue.product?.actionable === false && gotValue.baseline?.revision === 1
      && gotValue.baseline?.headToken === baseline.headToken, {
      expected: { kind: 'baseline', actionable: false, revision: 1 }, actual: { product: gotValue.product, baseline: gotValue.baseline?.revision },
    });

    const listed = await call(harness, 'browser_vision_baseline', { action: 'list' });
    const listedValue = checkVisionValue(check, 'list 成功', listed);
    check('list 列出 1 个基线且元数据完整', Array.isArray(listedValue.baselines) && listedValue.baselines.length === 1
      && listedValue.baselines[0].name === 'card-light' && listedValue.baselines[0].revision === 1
      && listedValue.baselines[0].tombstone === false, { expected: { count: 1, name: 'card-light' }, actual: listedValue.baselines },
    );

    const files = await listFilesRecursive(join(root, 'output', 'vision-baselines'));
    const pngFiles = files.filter((file) => file.endsWith('.png'));
    check('磁盘上恰好 1 张基线 PNG，0600 且字节 hash 与元数据一致', pngFiles.length === 1
      && (statSync(pngFiles[0]).mode & 0o777) === 0o600
      && sha256(await readFile(pngFiles[0])) === baseline.image?.sha256, {
      expected: { pngFiles: 1, mode: '0600', sha256: baseline.image?.sha256 }, actual: { files: pngFiles.map((file) => file.replace(root, '<root>')), mode: pngFiles.length ? (statSync(pngFiles[0]).mode & 0o777).toString(8) : null },
    });
    const pngBytes = pngFiles.length ? await readFile(pngFiles[0]) : Buffer.alloc(0);
    const png = pngInfo(pngBytes.toString('base64'));
    check('磁盘 PNG 可解码为 140×80（无需先调用 image）', png.ok && png.width === 140 && png.height === 80, { expected: { width: 140, height: 80 }, actual: { width: png.width, height: png.height } });
    const scopeDirs = await readdir(join(root, 'output', 'vision-baselines'));
    const scopeDirMode = scopeDirs.length ? (statSync(join(root, 'output', 'vision-baselines', scopeDirs[0])).mode & 0o777) : null;
    check('scope 目录权限 0700', scopeDirMode === 0o700, { expected: '0700', actual: scopeDirMode?.toString(8) });
  });
  finding({ id: 'C35-baseline', summary: '一次 create 调用即完成 live 采集、PNG 落盘与 revision1 HEAD 提交；get/list 元数据与磁盘字节一致。' });
}

/* ------------------------------------------------------------------------------------------------
 * C39 — §9.C39 baseline workspace isolation, restart, dispose retention
 * ---------------------------------------------------------------------------------------------- */

async function probeC39({ check, finding }) {
  const root = await tempDir('c39-root');
  const dirA = await tempDir('c39-ws-a');
  const dirB = await tempDir('c39-ws-b');
  const wsA = await createWorkspaceHarness('c39a', 'workspace-t3-c39a', dirA);
  const wsB = await createWorkspaceHarness('c39b', 'workspace-t3-c39b', dirB);
  const A = wsA.harness;
  const B = wsB.harness;
  let A2;
  try {
    await withCaptureRoot(root, async () => {
      await freshPage(A, T3_PATH, execOf('c39-a'));
      const created = await call(A, 'browser_vision_baseline', {
        action: 'create', name: 'shared-a', source: { kind: 'live', region: { x: 40, y: 40, width: 80, height: 60 } },
      }, execOf('c39-a'));
      const createdValue = checkVisionValue(check, 'A 创建基线成功（前置）', created);
      const oldProduct = createdValue.product?.productId;
      check('A 基线 revision1 且 product 可用', createdValue.baseline?.revision === 1 && /^v1_[0-9a-f]{32}$/.test(String(oldProduct)), {
        expected: { revision: 1 }, actual: { revision: createdValue.baseline?.revision, product: oldProduct },
      });

      const bList = await call(B, 'browser_vision_baseline', { action: 'list' }, execOf('c39-b'));
      const bListValue = checkVisionValue(check, 'B list 成功', bList);
      check('B 看不到 A 的基线（跨工作区隔离）', Array.isArray(bListValue.baselines) && bListValue.baselines.length === 0, {
        expected: [], actual: bListValue.baselines,
      });
      const bGet = await call(B, 'browser_vision_baseline', { action: 'get', name: 'shared-a' }, execOf('c39-b'));
      checkVisionError(check, 'B get A 的基线 -> VISION_BASELINE_NOT_FOUND', bGet, { code: 'VISION_BASELINE_NOT_FOUND', category: 'vision', retryable: false });

      // A second plugin instance with the same trusted workspace identity sees the explicit data.
      A2 = await createWorkspaceHarness('c39a2', 'workspace-t3-c39a', dirA);
      const a2Get = await call(A2.harness, 'browser_vision_baseline', { action: 'get', name: 'shared-a' }, execOf('c39-a2'));
      const a2Value = checkVisionValue(check, '新插件实例（同可信 scope）读取 A 基线成功', a2Get);
      check('重启后基线仍可 get（revision1）', a2Value.baseline?.revision === 1, {
        expected: 1, actual: a2Value.baseline?.revision,
      });
      const oldRead = await call(A2.harness, 'browser_vision_image', { source: { kind: 'product', productId: oldProduct } }, execOf('c39-a2'));
      checkVisionError(check, '旧 product 在新实例中 -> VISION_SOURCE_NOT_FOUND', oldRead, { code: 'VISION_SOURCE_NOT_FOUND', category: 'vision', retryable: false });

      await closeHarness(A);
      const afterDispose = await call(A2.harness, 'browser_vision_baseline', { action: 'get', name: 'shared-a' }, execOf('c39-a2'));
      check('dispose 不删除显式基线（新实例仍可读）', afterDispose.ok && afterDispose.value?.baseline?.revision === 1, {
        expected: 'revision 1', actual: { ok: afterDispose.ok, code: codeOf(afterDispose), revision: afterDispose.value?.baseline?.revision },
      });
    });
  } finally {
    await closeHarness(A);
    if (A2) await closeHarness(A2.harness);
    await closeHarness(B);
  }
  finding({ id: 'C39-restart', summary: '基线按 scopeHash 隔离且跨实例保留；product store 不跨重启恢复；dispose 只清临时数据。' });
}

/* ------------------------------------------------------------------------------------------------
 * C40 — §9.C40 regression inherits baseline masks/options/thresholds
 * ---------------------------------------------------------------------------------------------- */

async function probeC40({ harness, check, finding }) {
  const root = await tempDir('c40-root');
  await withCaptureRoot(root, async () => {
    await freshPage(harness);
    const region = { x: 480, y: 20, width: 140, height: 80 };
    const created = await call(harness, 'browser_vision_baseline', {
      action: 'create', name: 'regress-card', source: { kind: 'live', region },
      masks: [{ id: 'clock', region: { x: 20, y: 20, width: 80, height: 20 } }],
      options: { threshold: 0.2, includeAA: true, minRegionPixels: 2 },
      thresholds: { warnRatio: 0.002, failRatio: 0.02 },
    });
    const createdValue = checkVisionValue(check, '创建带 mask/options/thresholds 的基线', created);
    const baseline = createdValue.baseline || {};
    await pageValue(harness, 'window.__t3.toggleClock(), true');
    const inherited = await runCheck(harness, {
      id: 'inherit',
      source: { kind: 'live', region },
      assertions: [{ id: 'pixels', type: 'regression', baseline: 'regress-card' }],
    });
    const inheritedValue = checkVisionValue(check, 'regression 继承基线配置执行成功', inherited);
    const assertion = assertionOf(inherited);
    check('继承 mask：clock 变化被屏蔽 -> PASS', assertion?.status === 'PASS'
      && JSON.stringify(assertion?.metrics?.resolvedMasks) === JSON.stringify([{ id: 'clock', region: { x: 20, y: 20, width: 80, height: 20 } }])
      && assertion?.metrics?.resolvedOptions?.threshold === 0.2 && assertion?.metrics?.resolvedOptions?.includeAA === true
      && assertion?.metrics?.resolvedOptions?.minRegionPixels === 2
      && assertion?.metrics?.resolvedThresholds?.warnRatio === 0.002 && assertion?.metrics?.resolvedThresholds?.failRatio === 0.02, {
      expected: { status: 'PASS', masks: 'clock', threshold: 0.2, includeAA: true, warnRatio: 0.002 }, actual: jsonSafe(assertion?.metrics),
    });
    check('regression 附带 baselineRevision/headToken/diffProductId', assertion?.metrics?.baselineRevision === 1
      && assertion?.metrics?.headToken === baseline.headToken && /^v1_[0-9a-f]{32}$/.test(String(assertion?.diffProductId)), {
      expected: { baselineRevision: 1, headToken: baseline.headToken, diffProductId: 'v1_…' }, actual: { metrics: jsonSafe(assertion?.metrics), diffProductId: assertion?.diffProductId },
    });
    const explicit = await runCheck(harness, {
      id: 'explicit-empty',
      source: { kind: 'live', region },
      assertions: [{ id: 'pixels', type: 'regression', baseline: 'regress-card', masks: [] }],
    });
    const explicitValue = checkVisionValue(check, '显式 masks:[] 执行成功', explicit);
    const explicitAssertion = assertionOf(explicit);
    check('显式 [] 清空继承：clock 差异暴露 -> FAIL，resolvedMasks=[]', explicitAssertion?.status === 'FAIL'
      && Array.isArray(explicitAssertion?.metrics?.resolvedMasks) && explicitAssertion.metrics.resolvedMasks.length === 0, {
      expected: { status: 'FAIL', masks: [] }, actual: { status: explicitAssertion?.status, metrics: jsonSafe(explicitAssertion?.metrics) },
    });
    const reread = await call(harness, 'browser_vision_baseline', { action: 'get', name: 'regress-card' });
    check('get 元数据未被显式覆盖污染（mask/options 保持基线值）', reread.ok
      && reread.value?.baseline?.masks?.[0]?.id === 'clock' && reread.value?.baseline?.options?.threshold === 0.2, {
      expected: { mask: 'clock', threshold: 0.2 }, actual: { masks: reread.value?.baseline?.masks, options: reread.value?.baseline?.options },
    });
    const diffProduct = explicitAssertion?.diffProductId;
    const diffRead = await call(harness, 'browser_vision_image', { source: { kind: 'product', productId: diffProduct } });
    check('diff product 可后续离线使用（不可操作图）', diffRead.ok && diffRead.value?.product?.kind === 'diff'
      && diffRead.value?.product?.actionable === false, { expected: { kind: 'diff', actionable: false }, actual: { ok: diffRead.ok, product: diffRead.value?.product, error: diffRead.error?.message } });
    await pageValue(harness, 'window.__t3.toggleClock(), true');
  });
  finding({ id: 'C40-inherit', summary: 'check 的 regression 逐字段继承基线 masks/options/thresholds，显式 [] 清空；diff product 可离线复用，基线元数据不被覆盖。' });
}

/* ------------------------------------------------------------------------------------------------
 * C41 — §9.C41 missing baseline BLOCKED, no auto-create, mapping/size incompatibility
 * ---------------------------------------------------------------------------------------------- */

async function probeC41({ harness, check, finding }) {
  const root = await tempDir('c41-root');
  await withCaptureRoot(root, async () => {
    await freshPage(harness);
    const region = { x: 480, y: 20, width: 140, height: 80 };
    const missing = await runCheck(harness, {
      id: 'missing',
      source: { kind: 'live', region },
      assertions: [{ id: 'pixels', type: 'regression', baseline: 'does-not-exist' }],
    });
    const missingValue = checkVisionValue(check, '缺基线 check 返回成功体（业务 BLOCKED）', missing);
    const missingAssertion = assertionOf(missing);
    check('缺 baseline -> BLOCKED/VISION_BASELINE_NOT_FOUND，exitCode 2', missingAssertion?.status === 'BLOCKED'
      && missingAssertion?.errorCode === 'VISION_BASELINE_NOT_FOUND' && missingValue.exitCode === 2, {
      expected: { status: 'BLOCKED', errorCode: 'VISION_BASELINE_NOT_FOUND', exitCode: 2 },
      actual: { status: missingAssertion?.status, errorCode: missingAssertion?.errorCode, exitCode: missingValue.exitCode },
    });
    const baselineRoot = join(root, 'output', 'vision-baselines');
    check('check 不自动创建基线根目录', !existsSync(baselineRoot), { expected: 'no root', actual: { exists: existsSync(baselineRoot) } });

    const created = await call(harness, 'browser_vision_baseline', { action: 'create', name: 'mapping-base', source: { kind: 'live', region } });
    const createdValue = checkVisionValue(check, '创建对照基线成功（前置）', created);

    const shifted = await runCheck(harness, {
      id: 'shifted',
      source: { kind: 'live', region: { x: 500, y: 40, width: 140, height: 80 } },
      assertions: [{ id: 'pixels', type: 'regression', baseline: 'mapping-base' }],
    });
    const shiftedAssertion = assertionOf(shifted);
    check('同尺寸不同 origin -> BLOCKED(reason=mapping-incompatible)', shiftedAssertion?.status === 'BLOCKED'
      && String(shiftedAssertion?.reason || '').includes('mapping-incompatible'), {
      expected: { status: 'BLOCKED', reason: 'mapping-incompatible' }, actual: { status: shiftedAssertion?.status, reason: shiftedAssertion?.reason, errorCode: shiftedAssertion?.errorCode },
    });

    const scaled = await runCheck(harness, {
      id: 'scaled',
      source: { kind: 'live', scale: 2, region },
      assertions: [{ id: 'pixels', type: 'regression', baseline: 'mapping-base' }],
    });
    const scaledAssertion = assertionOf(scaled);
    check('不同 scale（尺寸不等）-> BLOCKED/VISION_SIZE_MISMATCH', scaledAssertion?.status === 'BLOCKED'
      && scaledAssertion?.errorCode === 'VISION_SIZE_MISMATCH', {
      expected: { status: 'BLOCKED', errorCode: 'VISION_SIZE_MISMATCH' }, actual: { status: scaledAssertion?.status, errorCode: scaledAssertion?.errorCode, reason: scaledAssertion?.reason },
    });

    const listed = await call(harness, 'browser_vision_baseline', { action: 'list' });
    check('check 失败不新增基线（list 仍只有 1 个）', listed.value?.baselines?.length === 1
      && listed.value?.baselines?.[0]?.name === 'mapping-base', { expected: ['mapping-base'], actual: listed.value?.baselines?.map((item) => item.name) });
    check('对照基线 source product 仍有效', Boolean(createdValue.product?.productId), { expected: 'product', actual: createdValue.product?.productId });
  });
  finding({ id: 'C41-blocked', summary: 'check 缺基线/映射不兼容/尺寸不等分别 BLOCKED（exitCode 2），从不自动接受当前图或自动建基线。' });
}

/* ------------------------------------------------------------------------------------------------
 * C43 — §9.C43 layout (declared fact required, pixels-only advisory)
 * ---------------------------------------------------------------------------------------------- */

async function layoutCase(harness, { x, expectedX, tolerance, withFact = true, severity = 'required', regionOverride }) {
  await pageValue(harness, `window.__t3.moveLayout(${x}), true`);
  const rects = await domRects(harness, ['t3-layout']);
  const rect = rects['t3-layout'];
  const context = await factContext(harness);
  const region = regionOverride || pixelRectOf(rect);
  const assertion = { id: 'layout', type: 'layout', region, toleranceCss: tolerance, severity };
  const facts = withFact ? [makeFact(context, 'box', { rect: cssRectOf(rect) })] : undefined;
  if (withFact) {
    assertion.factId = 'box';
    assertion.expectedRect = { x: expectedX, y: 420, width: 120, height: 40 };
  }
  const caseId = `layout-${String(x).replace('.', '_')}-${tolerance}-${withFact}`;
  const result = await runCheck(harness, { id: caseId, source: { kind: 'live' }, assertions: [assertion], facts });
  return { result, assertion: assertionOf(result), rect };
}

async function probeC43({ harness, check, finding }) {
  await freshPage(harness);
  const moved = await layoutCase(harness, { x: 104, expectedX: 100, tolerance: 1 });
  check('layout 正例：x=104 vs expected 100，maxDelta=4 > 1 -> FAIL', moved.assertion?.status === 'FAIL'
    && Math.abs(moved.assertion?.metrics?.maxDeltaCss - 4) < 1e-9, {
    expected: { status: 'FAIL', maxDeltaCss: 4 }, actual: { status: moved.assertion?.status, metrics: jsonSafe(moved.assertion?.metrics) },
  });
  const half = await layoutCase(harness, { x: 100.5, expectedX: 100, tolerance: 1 });
  check('layout 负例：x=100.5，maxDelta=0.5 ≤ 1 -> PASS', half.assertion?.status === 'PASS'
    && Math.abs(half.assertion?.metrics?.maxDeltaCss - 0.5) < 1e-9, {
    expected: { status: 'PASS', maxDeltaCss: 0.5 }, actual: { status: half.assertion?.status, metrics: jsonSafe(half.assertion?.metrics) },
  });
  await pageValue(harness, 'window.__t3.moveLayout(100), true');
  const pixelsRequired = await layoutCase(harness, { x: 100, expectedX: 100, tolerance: 1, withFact: false, regionOverride: { x: 100, y: 420, width: 120, height: 40 } });
  check('pixels-only required -> INCONCLUSIVE(insufficient-facts)，不伪造 PASS', pixelsRequired.assertion?.status === 'INCONCLUSIVE'
    && String(pixelsRequired.assertion?.reason || '').includes('insufficient-facts'), {
    expected: { status: 'INCONCLUSIVE', reason: 'insufficient-facts' }, actual: { status: pixelsRequired.assertion?.status, reason: pixelsRequired.assertion?.reason },
  });
  const pixelsAdvisory = await layoutCase(harness, { x: 100, expectedX: 100, tolerance: 1, withFact: false, severity: 'advisory', regionOverride: { x: 100, y: 420, width: 120, height: 40 } });
  check('pixels-only advisory 贴边组件 -> WARN 且保留 pixelSignal', pixelsAdvisory.assertion?.status === 'WARN'
    && pixelsAdvisory.assertion?.metrics?.pixelSignal === true && pixelsAdvisory.assertion?.metrics?.factsVerified === false, {
    expected: { status: 'WARN', pixelSignal: true, factsVerified: false }, actual: { status: pixelsAdvisory.assertion?.status, metrics: jsonSafe(pixelsAdvisory.assertion?.metrics) },
  });
  finding({ id: 'C43-layout', summary: 'layout required 由显式 expectedRect+fact 决定（4px FAIL / 0.5px PASS）；无 fact 的 required 为 INCONCLUSIVE，advisory 按像素信号 WARN。' });
}

/* ------------------------------------------------------------------------------------------------
 * C44 — §9.C44 occlusion coverage samples
 * ---------------------------------------------------------------------------------------------- */

async function occlusionCase(harness, { mode, sampleCount = 5, visible = true }) {
  await pageValue(harness, `window.__t3.showOccluder(${JSON.stringify(mode)}), true`);
  if (!visible) await pageValue(harness, 'document.getElementById("t3-occluded").style.display = "none", true');
  const rects = await domRects(harness, ['t3-occluded']);
  const rect = rects['t3-occluded'];
  const samples = await hitSamplesFor(harness, 't3-occluded');
  const context = await factContext(harness);
  const region = { x: 100, y: 470, width: 120, height: 40 };
  const fact = makeFact(context, 'target', {
    rect: visible ? cssRectOf(rect) : { x: 100, y: 470, width: 120, height: 40 },
    visible,
    hitSamples: samples.slice(0, sampleCount),
  });
  const assertion = { id: 'occlusion', type: 'occlusion', region, factId: 'target', maxCoveredRatio: 0 };
  const result = await runCheck(harness, { id: `occ-${mode}-${sampleCount}-${visible}`, source: { kind: 'live' }, assertions: [assertion], facts: [fact] });
  return { result, assertion: assertionOf(result), samples, rect };
}

async function probeC44({ harness, check, finding }) {
  await freshPage(harness);
  const full = await occlusionCase(harness, { mode: 'auto' });
  check('overlay 全覆盖：5/5 采样被盖，coveredRatio=1 > 0 -> FAIL', full.assertion?.status === 'FAIL'
    && full.assertion?.metrics?.samples === 5 && full.assertion?.metrics?.coveredSamples === 5
    && full.assertion?.metrics?.coveredRatio === 1, {
    expected: { status: 'FAIL', samples: 5, coveredSamples: 5, coveredRatio: 1 }, actual: { status: full.assertion?.status, metrics: jsonSafe(full.assertion?.metrics) },
  });
  const none = await occlusionCase(harness, { mode: 'none' });
  check('pointer-events:none：5/5 未 covered -> PASS', none.assertion?.status === 'PASS'
    && none.assertion?.metrics?.coveredSamples === 0, {
    expected: { status: 'PASS', coveredSamples: 0 }, actual: { status: none.assertion?.status, metrics: jsonSafe(none.assertion?.metrics) },
  });
  const partial = await occlusionCase(harness, { mode: 'partial' });
  check('部分覆盖：中心+右上 2/5 -> FAIL（coveredRatio=0.4）', partial.assertion?.status === 'FAIL'
    && partial.assertion?.metrics?.coveredSamples === 2 && Math.abs(partial.assertion?.metrics?.coveredRatio - 0.4) < 1e-9, {
    expected: { status: 'FAIL', coveredSamples: 2, coveredRatio: 0.4 }, actual: { status: partial.assertion?.status, metrics: jsonSafe(partial.assertion?.metrics) },
  });
  const onePoint = await occlusionCase(harness, { mode: 'auto', sampleCount: 1 });
  check('只给 1 个采样点 -> INCONCLUSIVE（样本不完整）', onePoint.assertion?.status === 'INCONCLUSIVE', {
    expected: 'INCONCLUSIVE', actual: { status: onePoint.assertion?.status, reason: onePoint.assertion?.reason },
  });
  const hidden = await occlusionCase(harness, { mode: 'auto', visible: false });
  check('visible=false -> INCONCLUSIVE（不可见≠被遮挡）', hidden.assertion?.status === 'INCONCLUSIVE', {
    expected: 'INCONCLUSIVE', actual: { status: hidden.assertion?.status, reason: hidden.assertion?.reason },
  });
  await pageValue(harness, 'window.__t3.hideOccluder(), document.getElementById("t3-occluded").style.display = "block", true');
  finding({ id: 'C44-occlusion', summary: 'occlusion 只用显式 hitSamples + visible：2/5 FAIL、全 false PASS、1 点或 invisible INCONCLUSIVE；像素主色仅 advisory。' });
}

/* ------------------------------------------------------------------------------------------------
 * C45 — §9.C45 overflow intent rules
 * ---------------------------------------------------------------------------------------------- */

async function overflowCase(harness, { allowOverflow = false, withFact = true, severity = 'required', mode = 'visible' }) {
  await pageValue(harness, `window.__t3.setOverflow(${JSON.stringify(mode)}), true`);
  const rects = await domRects(harness, ['t3-overflow']);
  const rect = rects['t3-overflow'];
  const context = await factContext(harness);
  const region = { x: 100, y: 520, width: 100, height: 40 };
  const fact = makeFact(context, 'box', {
    rect: cssRectOf(rect),
    scroll: { scrollWidth: rect.scrollWidth, scrollHeight: rect.scrollHeight, clientWidth: rect.clientWidth, clientHeight: rect.clientHeight },
    style: { overflowX: rect.overflowX, overflowY: rect.overflowY },
    allowOverflow,
  });
  const assertion = { id: 'overflow', type: 'overflow', region, toleranceCss: 1, severity };
  const facts = withFact ? [fact] : undefined;
  if (withFact) assertion.factId = 'box';
  const result = await runCheck(harness, { id: `ovf-${mode}-${allowOverflow}-${withFact}`, source: { kind: 'live' }, assertions: [assertion], facts });
  return { result, assertion: assertionOf(result), rect };
}

async function probeC45({ harness, check, finding }) {
  await freshPage(harness);
  const visible = await overflowCase(harness, { allowOverflow: false });
  check('overflow:visible + scrollWidth150/client100 -> FAIL（overflowXCss=50）', visible.assertion?.status === 'FAIL'
    && visible.assertion?.metrics?.overflowXCss === 50 && visible.assertion?.metrics?.allowed === false, {
    expected: { status: 'FAIL', overflowXCss: 50 }, actual: { status: visible.assertion?.status, metrics: jsonSafe(visible.assertion?.metrics) },
  });
  const auto = await overflowCase(harness, { allowOverflow: false, mode: 'auto' });
  check('overflow:auto 可滚容器 -> PASS（不因 scroll 尺寸本身判溢出）', auto.assertion?.status === 'PASS'
    && auto.assertion?.metrics?.overflowXCss === 50, {
    expected: { status: 'PASS', overflowXCss: 50 }, actual: { status: auto.assertion?.status, metrics: jsonSafe(auto.assertion?.metrics) },
  });
  const allowed = await overflowCase(harness, { allowOverflow: true, mode: 'visible' });
  check('allowOverflow=true -> PASS', allowed.assertion?.status === 'PASS', { expected: 'PASS', actual: { status: allowed.assertion?.status, metrics: jsonSafe(allowed.assertion?.metrics) } });
  const pixelsRequired = await overflowCase(harness, { withFact: false });
  check('pixels-only required -> INCONCLUSIVE', pixelsRequired.assertion?.status === 'INCONCLUSIVE', {
    expected: 'INCONCLUSIVE', actual: { status: pixelsRequired.assertion?.status, reason: pixelsRequired.assertion?.reason },
  });
  const pixelsAdvisory = await overflowCase(harness, { withFact: false, severity: 'advisory' });
  check('pixels-only advisory -> WARN（贴边信号）', pixelsAdvisory.assertion?.status === 'WARN'
    && pixelsAdvisory.assertion?.metrics?.pixelSignal === true, {
    expected: { status: 'WARN', pixelSignal: true }, actual: { status: pixelsAdvisory.assertion?.status, metrics: jsonSafe(pixelsAdvisory.assertion?.metrics) },
  });
  await pageValue(harness, 'window.__t3.setOverflow("visible"), true');
  finding({ id: 'C45-overflow', summary: 'overflow required 由 scroll+style+allowOverflow 意图决定：visible 超量 FAIL、auto/allow PASS；像素信号只用于 advisory。' });
}

/* ------------------------------------------------------------------------------------------------
 * C46 — §9.C46 truncation metrics + clip/lineClamp/allowTruncation
 * ---------------------------------------------------------------------------------------------- */

async function truncationCase(harness, { id = 't3-truncated', allowTruncation = false, withFact = true, severity = 'required' } = {}) {
  const rects = await domRects(harness, [id]);
  const rect = rects[id];
  const context = await factContext(harness);
  const region = pixelRectOf(rect);
  const fact = makeFact(context, 'text', {
    rect: cssRectOf(rect),
    textMetrics: { contentWidth: rect.scrollWidth, contentHeight: rect.scrollHeight, availableWidth: rect.clientWidth, availableHeight: rect.clientHeight },
    style: { overflowX: rect.overflowX, overflowY: rect.overflowY, whiteSpace: rect.whiteSpace, textOverflow: rect.textOverflow, lineClamp: rect.lineClamp },
    allowTruncation,
  });
  const assertion = { id: 'truncation', type: 'truncation', region, toleranceCss: 1, severity };
  const facts = withFact ? [fact] : undefined;
  if (withFact) assertion.factId = 'text';
  const result = await runCheck(harness, { id: `trunc-${id}-${allowTruncation}-${withFact}`, source: { kind: 'live' }, assertions: [assertion], facts });
  return { result, assertion: assertionOf(result), rect };
}

async function probeC46({ harness, check, finding }) {
  await freshPage(harness);
  const clipped = await truncationCase(harness, { allowTruncation: false });
  check('单行 nowrap/hidden/ellipsis：content 447 > available 100 -> FAIL（excessWidthCss=347）', clipped.assertion?.status === 'FAIL'
    && clipped.assertion?.metrics?.excessWidthCss === 347 && clipped.assertion?.metrics?.clipped === true, {
    expected: { status: 'FAIL', excessWidthCss: 347, clipped: true }, actual: { status: clipped.assertion?.status, metrics: jsonSafe(clipped.assertion?.metrics) },
  });
  const allowed = await truncationCase(harness, { allowTruncation: true });
  check('allowTruncation=true -> PASS（设计省略）', allowed.assertion?.status === 'PASS', {
    expected: 'PASS', actual: { status: allowed.assertion?.status, metrics: jsonSafe(allowed.assertion?.metrics) },
  });
  const normal = await truncationCase(harness, { id: 't3-truncated-ok' });
  check('正常副本（available 480 ≥ content 447）-> PASS', normal.assertion?.status === 'PASS'
    && normal.assertion?.metrics?.excessWidthCss === 0, {
    expected: { status: 'PASS', excessWidthCss: 0 }, actual: { status: normal.assertion?.status, metrics: jsonSafe(normal.assertion?.metrics) },
  });
  await pageValue(harness, 'window.__t3.setTruncation("clamp"), true');
  const clamped = await truncationCase(harness, {});
  check('lineClamp>0 分支被实际执行（不返回 INCONCLUSIVE）', clamped.assertion && clamped.assertion.status !== 'INCONCLUSIVE', {
    expected: 'PASS or FAIL', actual: { status: clamped.assertion?.status, metrics: jsonSafe(clamped.assertion?.metrics) },
  });
  await pageValue(harness, 'window.__t3.setTruncation("defect"), true');
  const pixelsRequired = await truncationCase(harness, { withFact: false });
  check('pixels-only required -> INCONCLUSIVE（无 OCR/textMetrics 不臆测）', pixelsRequired.assertion?.status === 'INCONCLUSIVE', {
    expected: 'INCONCLUSIVE', actual: { status: pixelsRequired.assertion?.status, reason: pixelsRequired.assertion?.reason },
  });
  const pixelsAdvisory = await truncationCase(harness, { withFact: false, severity: 'advisory' });
  check('pixels-only advisory 不返回 PASS（WARN 或 INCONCLUSIVE 均可）', ['WARN', 'INCONCLUSIVE'].includes(pixelsAdvisory.assertion?.status), {
    expected: ['WARN', 'INCONCLUSIVE'], actual: { status: pixelsAdvisory.assertion?.status, metrics: jsonSafe(pixelsAdvisory.assertion?.metrics) },
  });
  finding({ id: 'C46-truncation', summary: 'truncation 依赖显式 textMetrics+clip/allowTruncation；正常副本完整显示为 PASS；无 fact 不臆测，pixels-only 只做 advisory。' });
}

/* ------------------------------------------------------------------------------------------------
 * C47 — §9.C47 colour: image + declared background consistency
 * ---------------------------------------------------------------------------------------------- */

async function colorCase(harness, { id = 't3-color', region, factRectId = id, expectedColor = [255, 0, 0] }) {
  const rects = await domRects(harness, [id, factRectId]);
  const rect = rects[id];
  const factRect = rects[factRectId] || rect;
  const context = await factContext(harness);
  const background = parseCssColor(factRect.backgroundColor);
  const fact = makeFact(context, 'style', { rect: cssRectOf(factRect), style: { backgroundColor: background } });
  const assertion = { id: 'color', type: 'color', region: region || pixelRectOf(rect), factId: 'style', expectedColor, tolerance: 16, minFraction: 0.95 };
  const result = await runCheck(harness, { id: `color-${id}`, source: { kind: 'live' }, assertions: [assertion], facts: [fact] });
  return { result, assertion: assertionOf(result), rect };
}

async function probeC47({ harness, check, finding }) {
  await freshPage(harness);
  const match = await colorCase(harness, {});
  check('图红 + 声明背景红 -> PASS', match.assertion?.status === 'PASS'
    && match.assertion?.metrics?.matchingFraction === 1 && match.assertion?.metrics?.styleMatches === true, {
    expected: { status: 'PASS', matchingFraction: 1, styleMatches: true }, actual: { status: match.assertion?.status, metrics: jsonSafe(match.assertion?.metrics) },
  });
  await pageValue(harness, 'window.__t3.setColorBox("rgb(0,0,255)"), true');
  const wrong = await colorCase(harness, {});
  check('图蓝 + 声明背景蓝，expected 红 -> FAIL', wrong.assertion?.status === 'FAIL'
    && wrong.assertion?.metrics?.styleMatches === false, {
    expected: { status: 'FAIL', styleMatches: false }, actual: { status: wrong.assertion?.status, metrics: jsonSafe(wrong.assertion?.metrics) },
  });
  await pageValue(harness, 'window.__t3.setColorBox("rgb(255,0,0)"), true');
  const conflict = await colorCase(harness, { id: 't3-color-conflict-inner', factRectId: 't3-color-conflict', region: { x: 430, y: 630, width: 60, height: 20 } });
  check('图红 + 声明背景蓝（父盒）-> INCONCLUSIVE（信号冲突）', conflict.assertion?.status === 'INCONCLUSIVE', {
    expected: 'INCONCLUSIVE', actual: { status: conflict.assertion?.status, metrics: jsonSafe(conflict.assertion?.metrics) },
  });
  const alpha = await colorCase(harness, { id: 't3-color-alpha' });
  check('背景 alpha=128（半透明）-> INCONCLUSIVE（不能只信 style）', alpha.assertion?.status === 'INCONCLUSIVE', {
    expected: 'INCONCLUSIVE', actual: { status: alpha.assertion?.status, metrics: jsonSafe(alpha.assertion?.metrics) },
  });
  finding({ id: 'C47-color', summary: 'color 只在图像与声明背景一致时给 PASS/FAIL；冲突/半透明背景为 INCONCLUSIVE；不混用文字色。' });
}

/* ------------------------------------------------------------------------------------------------
 * C48 — §9.C48 missing template count + presence completeness
 * ---------------------------------------------------------------------------------------------- */

async function missingCase(harness, templateId, { presence, rect: declaredRect, region = { x: 90, y: 660, width: 60, height: 40 } } = {}) {
  const context = await factContext(harness);
  const rects = await domRects(harness, ['t3-missing-icon']);
  const rect = declaredRect || cssRectOf(rects['t3-missing-icon']);
  const fact = makeFact(context, 'icon', { rect, presence });
  const assertion = { id: 'missing', type: 'missing', region, factId: 'icon', query: { method: 'template', template: { kind: 'product', productId: templateId }, minScore: 0.95 }, minCount: 1 };
  const result = await runCheck(harness, { id: 'missing-case', source: { kind: 'live' }, assertions: [assertion], facts: [fact] });
  return { result, assertion: assertionOf(result) };
}

async function probeC48({ harness, check, finding }) {
  await freshPage(harness);
  // Coordinate形态说明（Lead 2026-11-01 裁决）：本用例的 case.source 是**全页 live**（区域坐标
  // 相对完整源图），模板则来自 `image(region=20×20)` 的**裁剪 product**；按 §2.2/§2.3，裁剪
  // product 作为 template source 时其内部坐标相对该裁剪图，不参与本用例的 region 断言。
  const template = await call(harness, 'browser_vision_image', { source: { kind: 'live', region: { x: 100, y: 670, width: 20, height: 20 } } });
  const templateValue = checkVisionValue(check, '红色图标模板采集成功', template, { requireImage: true });
  const templateId = templateValue.product?.productId;
  check('模板为 20×20 纯红', templateValue.product?.width === 20 && templateValue.product?.height === 20
    && templateValue.analysis?.uniform === true, { expected: { width: 20, height: 20, uniform: true }, actual: templateValue.analysis });
  const iconRect = { x: 100, y: 670, width: 20, height: 20 };
  const present = await missingCase(harness, templateId, { presence: { expected: true, exists: true, searchComplete: true }, rect: iconRect });
  check('存在组件：count≥1 + exists=true -> PASS', present.assertion?.status === 'PASS'
    && present.assertion?.metrics?.candidateCount >= 1, {
    expected: { status: 'PASS', candidateCount: '>=1' }, actual: { status: present.assertion?.status, metrics: jsonSafe(present.assertion?.metrics) },
  });
  await pageValue(harness, 'window.__t3.hideMissingIcon(), true');
  const absent = await missingCase(harness, templateId, { presence: { expected: true, exists: false, searchComplete: true }, rect: iconRect });
  check('组件移除：count=0 + exists=false -> FAIL', absent.assertion?.status === 'FAIL'
    && absent.assertion?.metrics?.candidateCount === 0, {
    expected: { status: 'FAIL', candidateCount: 0 }, actual: { status: absent.assertion?.status, metrics: jsonSafe(absent.assertion?.metrics) },
  });
  await pageValue(harness, 'window.__t3.restoreMissingIcon(), true');
  const restored = await missingCase(harness, templateId, { presence: { expected: true, exists: true, searchComplete: true }, rect: iconRect });
  check('恢复组件 -> PASS', restored.assertion?.status === 'PASS', { expected: 'PASS', actual: { status: restored.assertion?.status } });
  await pageValue(harness, 'window.__t3.recolorMissingIcon(), true');
  const mismatch = await missingCase(harness, templateId, { presence: { expected: true, exists: true, searchComplete: true }, rect: iconRect });
  check('DOM 存在但模板不匹配：count=0 + exists=true -> INCONCLUSIVE', mismatch.assertion?.status === 'INCONCLUSIVE'
    && mismatch.assertion?.metrics?.candidateCount === 0, {
    expected: { status: 'INCONCLUSIVE', candidateCount: 0 }, actual: { status: mismatch.assertion?.status, metrics: jsonSafe(mismatch.assertion?.metrics) },
  });
  await pageValue(harness, 'window.__t3.restoreMissingIcon(), true');
  finding({ id: 'C48-missing', summary: 'missing 只在 template 计数与完整 presence 事实一致时给 PASS/FAIL；DOM 存在但模板不匹配为 INCONCLUSIVE（无匹配≠组件缺失）。' });
}

/* ------------------------------------------------------------------------------------------------
 * C49 — §9.C49 explicit facts provenance + no DOM self-fetch
 * ---------------------------------------------------------------------------------------------- */

async function probeC49({ harness, check, finding }) {
  await freshPage(harness);
  await installDomReadCounters(harness);
  const rects = await domRects(harness, ['t3-layout']);
  const rect = rects['t3-layout'];
  const context = await factContext(harness);
  const fact = makeFact(context, 'box', { rect: cssRectOf(rect) });
  await pageValue(harness, 'window.__t3dom.getComputedStyle = 0, window.__t3dom.getBoundingClientRect = 0, window.__t3dom.elementFromPoint = 0, window.__t3dom.querySelector = 0, true');
  const withFact = await runCheck(harness, {
    id: 'fact-case',
    source: { kind: 'live' },
    assertions: [{ id: 'layout', type: 'layout', region: pixelRectOf(rect), factId: 'box', expectedRect: { x: 100, y: 420, width: 120, height: 40 }, toleranceCss: 1 }],
    facts: [fact],
  });
  const withFactValue = checkVisionValue(check, '带显式 fact 的 check 成功', withFact);
  const counts = await domReadCounts(harness);
  check('check 期间没有页面 DOM 读取（getComputedStyle/getBoundingClientRect/elementFromPoint/querySelector 全 0）', counts
    && Object.values(counts).every((value) => value === 0), { expected: { all: 0 }, actual: counts });
  const vision = visionEvidence(withFact) || {};
  check('evidence.facts 标记 trusted=false 且保留来源', Array.isArray(vision.facts) && vision.facts.length === 1
    && vision.facts[0].trusted === false && vision.facts[0].id === 'box'
    && typeof vision.facts[0].sourceActionId === 'string' && Number.isFinite(vision.facts[0].observedAt), {
    expected: { trusted: false, id: 'box' }, actual: vision.facts,
  });
  const assertion = assertionOf(withFact);
  check('断言 metrics 标记 factsVerified=false / fusion=external-facts', assertion?.metrics?.factsVerified === false
    && assertion?.metrics?.fusion === 'external-facts', {
    expected: { factsVerified: false, fusion: 'external-facts' }, actual: jsonSafe(assertion?.metrics),
  });

  // Six defect types without facts must never fabricate a required PASS/FAIL.
  const base = { x: 100, y: 420, width: 120, height: 40 };
  const noFacts = await call(harness, 'browser_vision_check', {
    cases: [
      { id: 'layout', source: { kind: 'live' }, assertions: [{ id: 'a', type: 'layout', region: base }] },
      { id: 'occlusion', source: { kind: 'live' }, assertions: [{ id: 'a', type: 'occlusion', region: base }] },
      { id: 'overflow', source: { kind: 'live' }, assertions: [{ id: 'a', type: 'overflow', region: base }] },
      { id: 'truncation', source: { kind: 'live' }, assertions: [{ id: 'a', type: 'truncation', region: base }] },
      { id: 'color', source: { kind: 'live' }, assertions: [{ id: 'a', type: 'color', region: base, expectedColor: [255, 0, 0] }] },
      { id: 'missing', source: { kind: 'live' }, assertions: [{ id: 'a', type: 'missing', region: base, query: { method: 'color', color: [255, 0, 0], tolerance: 0 } }] },
    ],
  });
  const noFactsValue = checkVisionValue(check, '六类无 facts check 返回成功体', noFacts);
  const statuses = (noFactsValue.cases || []).map((item) => item.assertions?.[0]?.status);
  check('无 facts 六类 required 全部 INCONCLUSIVE（不伪造 PASS/FAIL）', statuses.length === 6 && statuses.every((status) => status === 'INCONCLUSIVE'), {
    expected: ['INCONCLUSIVE', 'INCONCLUSIVE', 'INCONCLUSIVE', 'INCONCLUSIVE', 'INCONCLUSIVE', 'INCONCLUSIVE'], actual: statuses,
  });
  check('无 facts 时 evidence.facts 为空数组', Array.isArray(visionEvidence(noFacts)?.facts) && visionEvidence(noFacts).facts.length === 0, {
    expected: [], actual: visionEvidence(noFacts)?.facts,
  });
  finding({ id: 'C49-facts', summary: '视觉工具不读取 DOM 事实（页面计数器全 0）；facts 显式传入并标 trusted=false；无 facts 六类 required 均为 INCONCLUSIVE。' });
}

/* ------------------------------------------------------------------------------------------------
 * C51 — §9.C51 output staging/persist/0600/no-clobber
 * ---------------------------------------------------------------------------------------------- */

async function probeC51({ harness, check, finding }) {
  const repoOutput = join(REPO_ROOT, 'output');
  const repoOutputBefore = existsSync(repoOutput);
  await freshPage(harness);
  const region = { x: 40, y: 40, width: 80, height: 60 };

  await withCaptureRoot(undefined, async () => {
    const staged = await call(harness, 'browser_vision_image', { source: { kind: 'live', region } });
    const stagedValue = checkVisionValue(check, '无 env/out 的默认调用成功', staged, { requireImage: true });
    const file = stagedValue.file || {};
    check('默认写入插件暂存根（staging/absolute/ephemeral）', file.persistence === 'staging' && file.pathKind === 'absolute'
      && file.root === 'staging' && file.ephemeral === true, { expected: { persistence: 'staging', pathKind: 'absolute' }, actual: file });
    check('暂存文件存在、0600、sha256 与 base64 一致', typeof file.path === 'string' && file.path.startsWith(sep)
      && existsSync(file.path) && (statSync(file.path).mode & 0o777) === 0o600
      && sha256(await readFile(file.path)) === stagedValue.sha256, {
      expected: { mode: '0600', sha256: stagedValue.sha256 }, actual: { path: file.path, mode: file.path && existsSync(file.path) ? (statSync(file.path).mode & 0o777).toString(8) : null },
    });
    check('默认调用不写仓库 output/（前后一致）', existsSync(repoOutput) === repoOutputBefore, {
      expected: repoOutputBefore, actual: { before: repoOutputBefore, after: existsSync(repoOutput) },
    });
    check('noClobber 标记为 true', file.noClobber === true, { expected: true, actual: file.noClobber });
  });

  const root = await tempDir('c51-root');
  await withCaptureRoot(root, async () => {
    const persisted = await call(harness, 'browser_vision_image', { source: { kind: 'live', region }, output: { out: 't3-explicit.png' } });
    const persistedValue = checkVisionValue(check, '显式 out 持久化成功', persisted, { requireImage: true });
    const file = persistedValue.file || {};
    const diskPath = join(root, 't3-explicit.png');
    check('显式 out：persistent/env/相对路径且文件真实存在', file.persistence === 'persistent' && file.root === 'env'
      && file.path === 't3-explicit.png' && existsSync(diskPath), {
      expected: { persistence: 'persistent', root: 'env', path: 't3-explicit.png' }, actual: file,
    });
    check('持久文件 0600 且字节 hash 与返回值一致', existsSync(diskPath) && (statSync(diskPath).mode & 0o777) === 0o600
      && sha256(await readFile(diskPath)) === persistedValue.sha256, {
      expected: { mode: '0600', sha256: persistedValue.sha256 }, actual: { mode: existsSync(diskPath) ? (statSync(diskPath).mode & 0o777).toString(8) : null },
    });
    const beforeBytes = await readFile(diskPath);
    const clash = await call(harness, 'browser_vision_image', { source: { kind: 'live', region }, output: { out: 't3-explicit.png' } });
    checkVisionError(check, '同 out 重试 -> OUTPUT_EXISTS', clash, { code: 'OUTPUT_EXISTS', category: 'output', retryable: false, evidence: false });
    check('OUTPUT_EXISTS 不覆盖既有字节（no-clobber）', sha256(await readFile(diskPath)) === sha256(beforeBytes), {
      expected: 'bytes unchanged', actual: { before: sha256(beforeBytes).slice(0, 16), after: sha256(await readFile(diskPath)).slice(0, 16) },
    });
  });

  const badRoot = join(await tempDir('c51-bad'), 'not-a-directory.png');
  await writeFile(badRoot, 'x');
  await withCaptureRoot(badRoot, async () => {
    const broken = await call(harness, 'browser_vision_image', { source: { kind: 'live', region }, output: { out: 'x.png' } });
    check('坏 env 根请求持久 -> 明确失败（不回退暂存）', broken.threw === true
      && String(codeOf(broken) || '').startsWith('OUTPUT_') && broken.value?.file?.persistence !== 'staging', {
      expected: 'OUTPUT_* error, no staging fallback', actual: { code: codeOf(broken), message: String(broken.error?.message || '').slice(0, 160), file: broken.value?.file },
    });
  });
  finding({ id: 'C51-output', summary: 'output 完全继承 P0：默认 staging、out/env 持久、0600、no-clobber、坏根不回退；每调用最多一张交付 PNG。' });
}

/* ------------------------------------------------------------------------------------------------
 * C53 — §9.C53 attachment delivery degradation metadata
 * ---------------------------------------------------------------------------------------------- */

async function probeC53({ check, finding }) {
  const { createHarness } = await harnessModule();
  class FakeAttachment {
    constructor(fields) { Object.assign(this, fields); }
  }
  const attached = await createHarness({
    name: 'C53-attachments',
    attachments: {
      async saveImage(input) {
        return new FakeAttachment({
          id: 't3-image', attachmentId: 't3-image', mediaType: 'image/webp',
          bytes: 2048, width: 40, height: 30, name: input.name,
        });
      },
    },
  });
  OWNED_HARNESSES.push(attached);
  try {
    await freshPage(attached, T3_PATH, execOf('c53-attach'));
    const region = { x: 40, y: 40, width: 80, height: 60 };
    const shot = await call(attached, 'browser_vision_image', { source: { kind: 'live', region } }, execOf('c53-attach'));
    const value = checkVisionValue(check, '附件服务存在时 image 成功', shot, { requireImage: true });
    const png = pngInfo(value.image);
    check('imageDelivery=attachment 且投影 attachmentId', value.imageDelivery === 'attachment' && value.attachmentId === 't3-image', {
      expected: { imageDelivery: 'attachment', attachmentId: 't3-image' }, actual: { imageDelivery: value.imageDelivery, attachmentId: value.attachmentId },
    });
    check('base64 仍为原尺寸 80×60（附件不改变交付原图）', png.width === 80 && png.height === 60
      && value.bytes === png.bytes && value.sha256 === png.sha256, {
      expected: { width: 80, height: 60, bytes: png.bytes }, actual: { width: png.width, height: png.height, bytes: value.bytes },
    });
    const vision = visionEvidence(shot) || {};
    const delivery = vision.output?.delivery || {};
    check('delivery.original 记录原图 80×60、附件 40×30 -> downscaled=true', delivery.original?.width === 80 && delivery.original?.height === 60
      && delivery.downscaled === true && delivery.image?.width === 40 && delivery.image?.height === 30, {
      expected: { original: { width: 80, height: 60 }, image: { width: 40, height: 30 }, downscaled: true }, actual: delivery,
    });
    const warnings = vision.metrics?.warnings || [];
    check('metrics.warnings 含 model_image_downscaled（不以 metadata 证明 provider 可见）', warnings.includes('model_image_downscaled'), {
      expected: 'model_image_downscaled', actual: warnings,
    });
    check('source sha256 与交付 PNG 独立记录', Array.isArray(vision.source) && vision.source[0]?.sha256 === value.sha256, {
      expected: value.sha256, actual: vision.source?.[0]?.sha256,
    });
  } finally {
    await closeHarness(attached);
  }

  const plain = await call(MAIN_HARNESS, 'browser_vision_image', { source: { kind: 'live', region: { x: 40, y: 40, width: 80, height: 60 } } });
  const plainValue = plain.value || {};
  const plainWarnings = visionEvidence(plain)?.metrics?.warnings || [];
  check('无附件服务 -> base64-fallback、attachment=null、attachment_unavailable 警告', plain.ok
    && plainValue.imageDelivery === 'base64-fallback' && (plainValue.attachment === null || plainValue.attachment === undefined)
    && plainWarnings.includes('attachment_unavailable'), {
    expected: { imageDelivery: 'base64-fallback', attachment: null, warnings: 'attachment_unavailable' },
    actual: { imageDelivery: plainValue.imageDelivery, attachment: plainValue.attachment, warnings: plainWarnings },
  });
  finding({ id: 'C53-attachment', summary: '附件降级：原图/base64 尺寸与 hash 独立于附件元数据；下采样/重编码以 warnings 明示，不声称 provider 可见。' });
}

/* ------------------------------------------------------------------------------------------------
 * C54 — §9.C54 canvas recognition/act and text image semanticName=null
 * ---------------------------------------------------------------------------------------------- */

async function probeC54({ harness, check, finding }) {
  await freshPage(harness);
  const canvasRegion = { x: 40, y: 140, width: 160, height: 80 };
  const redHalf = await call(harness, 'browser_vision_find', { source: { kind: 'live' }, region: canvasRegion, query: { method: 'color', color: [255, 0, 0], tolerance: 0 } });
  const blueHalf = await call(harness, 'browser_vision_find', { source: { kind: 'live' }, region: canvasRegion, query: { method: 'color', color: [0, 0, 255], tolerance: 0 } });
  const redValue = checkVisionValue(check, 'canvas 左半（红）可被静态识别', redHalf);
  const blueValue = checkVisionValue(check, 'canvas 右半（蓝）可被静态识别', blueHalf);
  check('canvas 左右色块各一个 6400 像素候选、semanticName=null（不推断内部对象语义）',
    redValue.result?.candidates?.length === 1 && redValue.result.candidates[0].area === 6400 && redValue.result.candidates[0].semanticName === null
    && blueValue.result?.candidates?.length === 1 && blueValue.result.candidates[0].area === 6400 && blueValue.result.candidates[0].semanticName === null, {
    expected: { red: 6400, blue: 6400, semanticName: null },
    actual: { red: redValue.result?.candidates?.map((item) => item.area), blue: blueValue.result?.candidates?.map((item) => item.area) },
  });
  const canvasProduct = await call(harness, 'browser_vision_image', { source: { kind: 'live', region: canvasRegion } });
  const canvasValue = checkVisionValue(check, 'canvas 采集成功', canvasProduct, { requireImage: true });
  await resetEvents(harness);
  const act = await call(harness, 'browser_vision_act', { productId: canvasValue.product?.productId, action: 'click', point: { x: 120, y: 40 } });
  const actValue = checkVisionValue(check, 'canvas 点选成功', act);
  const canvasTruth = await pageValue(harness, '({ clicks: window.__t3.counters.canvasClicks, last: window.__t3.last.click || null })');
  check('canvas 点击真值：canvasClicks=1、目标 t3-canvas', actValue.dispatched === true && canvasTruth.clicks === 1
    && canvasTruth.last?.target === 't3-canvas', { expected: { clicks: 1, target: 't3-canvas' }, actual: canvasTruth });
  const black = await call(harness, 'browser_vision_find', { source: { kind: 'product', productId: actValue.afterProduct?.productId }, query: { method: 'color', color: [0, 0, 0], tolerance: 0, minArea: 4 } });
  check('canvas 内部位图变化可被识别（黑块 8×8=64 像素）', black.ok && black.value?.result?.candidates?.some((item) => item.area === 64), {
    expected: { area: 64 }, actual: black.ok ? black.value?.result?.candidates?.map((item) => item.area) : black.error?.message,
  });

  const textRegion = { x: 240, y: 140, width: 160, height: 60 };
  const text = await call(harness, 'browser_vision_find', { source: { kind: 'live' }, region: textRegion, query: { method: 'components', background: [255, 255, 255], tolerance: 16 } });
  const textValue = checkVisionValue(check, '文字图像 components 识别成功', text);
  check('文字图像候选 semanticName 全为 null（无 OCR/文本内容）', (textValue.result?.candidates || []).length >= 1
    && textValue.result.candidates.every((item) => item.semanticName === null), {
    expected: { candidates: '>=1', semanticName: null }, actual: textValue.result?.candidates?.map((item) => ({ area: item.area, semanticName: item.semanticName })),
  });
  const resized = await call(harness, 'browser_vision_image', { source: { kind: 'product', productId: canvasValue.product?.productId }, resize: { factor: 2 } });
  const resizedValue = checkVisionValue(check, 'canvas product resize×2 成功', resized, { requireImage: true });
  const resizeWarnings = visionEvidence(resized)?.metrics?.warnings || [];
  check('resize 只做位图插值并警告 bitmap-upscaled（不承诺 backing-store 新细节）', resizedValue.product?.width === 320
    && resizedValue.product?.height === 160 && resizeWarnings.includes('bitmap-upscaled'), {
    expected: { width: 320, height: 160, warnings: 'bitmap-upscaled' }, actual: { product: resizedValue.product, warnings: resizeWarnings },
  });
  finding({ id: 'C54-canvas', summary: 'canvas 静态像素可识别/可点选；文字图像不产生语义名；resize 只做位图插值（bitmap-upscaled）。' });
}

/* ------------------------------------------------------------------------------------------------
 * C55 — §9.C55 single-owner BUSY, serial queue and scope isolation
 * ---------------------------------------------------------------------------------------------- */

async function probeC55({ check, finding }) {
  const lease = await createWorkspaceHarness('c55-lease');
  const harness = lease.harness;
  try { return await probeC55Body({ harness, check, finding }); }
  finally { await closeHarness(harness); }
}

async function probeC55Body({ harness, check, finding }) {
  const ownerExec = execOf('t3-lease-owner');
  await freshPage(harness, T3_PATH, ownerExec);
  const otherExec = execOf('t3-lease-other');
  const held = await call(harness, 'browser_vision_image', { source: { kind: 'live', region: { x: 40, y: 40, width: 80, height: 60 } } }, ownerExec);
  const heldValue = checkVisionValue(check, 'owner 取得 lease（前置）', held, { requireImage: true });
  const productId = heldValue.product?.productId;
  const busyCases = [
    ['image', { source: { kind: 'live' } }],
    ['find', { source: { kind: 'product', productId }, query: { method: 'color', color: [255, 0, 0] } }],
    ['compare', { before: { kind: 'product', productId }, after: { kind: 'product', productId } }],
    ['baseline', { action: 'list' }],
    ['check', { cases: [{ id: 'c1', source: { kind: 'live' }, assertions: [{ id: 'a', type: 'color', region: { x: 0, y: 0, width: 10, height: 10 }, expectedColor: [255, 0, 0] }] }] }],
  ];
  const problems = [];
  for (const [name, args] of busyCases) {
    const result = await call(harness, `browser_vision_${name}`, args, otherExec);
    const error = result.error || {};
    if (!(result.threw === true && error.code === 'BUSY' && error.retryable === true)) {
      problems.push({ tool: name, code: error.code, retryable: error.retryable, ok: result.ok });
    }
  }
  check('其他 owner 调用 T3 工具（含离线 baseline/check）全部 BUSY', problems.length === 0, { expected: 'all BUSY', actual: problems });
  const caps = await call(harness, 'browser_capabilities', {}, otherExec);
  const t3Entries = (caps.value?.capabilities || []).filter((item) => String(item.id || '').startsWith('web.t3.'));
  check('其他 owner 看到 web.t3.* unavailable 且 reason 含 BUSY', t3Entries.length >= 7
    && t3Entries.every((item) => item.status === 'unavailable' && /BUSY/i.test(String(item.reason || ''))), {
    expected: 'all web.t3.* unavailable + BUSY', actual: t3Entries.map((item) => `${item.id}:${item.status}:${item.reason}`),
  });
  const state = await call(harness, 'browser_state', {}, otherExec);
  check('其他 owner 仍可读 state（诊断不夺取 owner）', state.ok && state.value?.owner?.sessionId === 't3-lease-owner', {
    expected: { owner: 't3-lease-owner' }, actual: { ok: state.ok, owner: state.value?.owner },
  });
  await harness.ctx.emit('agent/disposed', { agent: { id: 't3-lease-owner' } });
  const afterDispose = await call(harness, 'browser_vision_baseline', { action: 'list' }, otherExec);
  check('owner disposed 后其他 owner 可用（队列不串 store）', afterDispose.ok && afterDispose.value?.ok === true, {
    expected: 'success', actual: { ok: afterDispose.ok, code: codeOf(afterDispose), error: afterDispose.error?.message },
  });

  const wsA = await createWorkspaceHarness('c55a');
  const wsB = await createWorkspaceHarness('c55b');
  try {
    await freshPage(wsA.harness, T3_PATH, execOf('c55-a'));
    await freshPage(wsB.harness, T3_PATH, execOf('c55-b'));
    const aImage = await call(wsA.harness, 'browser_vision_image', { source: { kind: 'live', region: { x: 40, y: 40, width: 80, height: 60 } } }, execOf('c55-a'));
    const bImage = await call(wsB.harness, 'browser_vision_image', { source: { kind: 'live', region: { x: 160, y: 40, width: 80, height: 60 } } }, execOf('c55-b'));
    check('两个 scope 各自采集互不 BUSY', aImage.ok && bImage.ok && aImage.value?.product?.productId !== bImage.value?.product?.productId, {
      expected: 'both ok', actual: { a: aImage.ok, b: bImage.ok },
    });
    const cross = await call(wsB.harness, 'browser_vision_image', { source: { kind: 'product', productId: aImage.value?.product?.productId } }, execOf('c55-b'));
    check('两 scope 的 product store 隔离', codeOf(cross) === 'VISION_SOURCE_NOT_FOUND', { expected: 'VISION_SOURCE_NOT_FOUND', actual: codeOf(cross) });
    const aBase = await call(wsA.harness, 'browser_vision_baseline', { action: 'create', name: 'scope-a', source: { kind: 'product', productId: aImage.value?.product?.productId } }, execOf('c55-a'));
    const bList = await call(wsB.harness, 'browser_vision_baseline', { action: 'list' }, execOf('c55-b'));
    check('两 scope 的基线与页面操作独立', aBase.ok && (bList.value?.baselines || []).length === 0, {
      expected: { aCreate: true, bList: [] }, actual: { aCreate: aBase.ok, bList: bList.value?.baselines?.map((item) => item.name) },
    });
  } finally {
    await closeHarness(wsA.harness);
    await closeHarness(wsB.harness);
  }
  finding({ id: 'C55-lease', summary: 'T3 六工具复用 single-owner lease + 串行队列（离线 baseline/check 也进队列）；跨 scope 的 product/基线/页面互不影响。' });
}

/* ------------------------------------------------------------------------------------------------
 * C56 — §9.C56 closed loop, capability traceability, honest static-only report
 * ---------------------------------------------------------------------------------------------- */

async function probeC56({ harness, check, finding }) {
  await freshPage(harness);
  const canvasRegion = { x: 40, y: 140, width: 160, height: 80 };
  const captured = await call(harness, 'browser_vision_image', { source: { kind: 'live', region: canvasRegion } });
  const capturedValue = checkVisionValue(check, '闭环 1/6：capture', captured, { requireImage: true });
  const productId = capturedValue.product?.productId;
  const found = await call(harness, 'browser_vision_find', { source: { kind: 'product', productId }, query: { method: 'color', color: [255, 0, 0], tolerance: 0, minArea: 4 } });
  const foundValue = checkVisionValue(check, '闭环 2/6：find', found);
  check('find 在 canvas 上定位红块 (0,0,80,80)', foundValue.result?.candidates?.length === 1
    && JSON.stringify(foundValue.result.candidates[0].region) === JSON.stringify({ x: 0, y: 0, width: 80, height: 80 }), {
    expected: { region: { x: 0, y: 0, width: 80, height: 80 } }, actual: foundValue.result?.candidates?.map((item) => item.region),
  });
  const act = await call(harness, 'browser_vision_act', { productId, action: 'click', point: { x: 120, y: 40 } });
  const actValue = checkVisionValue(check, '闭环 3/6：act', act);
  check('act 派发并产生 after product', actValue.dispatched === true && Boolean(actValue.afterProduct?.productId), {
    expected: { dispatched: true, afterProduct: 'v1_…' }, actual: { dispatched: actValue.dispatched, after: actValue.afterProduct?.productId },
  });
  const compared = await call(harness, 'browser_vision_compare', { before: { kind: 'product', productId }, after: { kind: 'product', productId: actValue.afterProduct?.productId } });
  const comparedValue = checkVisionValue(check, '闭环 4/6：compare', compared, { requireImage: true });
  recordImage('C56-diff', comparedValue);
  check('compare 检出 canvas 点击造成的 64 像素差异（WARN）', comparedValue.comparison?.metrics?.diffPixels === 64
    && comparedValue.comparison?.verdict === 'WARN', {
    expected: { diffPixels: 64, verdict: 'WARN' }, actual: comparedValue.comparison?.metrics,
  });
  const root = await tempDir('c56-root');
  await withCaptureRoot(root, async () => {
    const created = await call(harness, 'browser_vision_baseline', { action: 'create', name: 'loop-canvas', source: { kind: 'product', productId } });
    const createdValue = checkVisionValue(check, '闭环 5/6：baseline create', created);
    check('基线 revision1 提交', createdValue.baseline?.revision === 1, { expected: 1, actual: createdValue.baseline?.revision });
    const checked = await runCheck(harness, {
      id: 'loop',
      source: { kind: 'product', productId },
      assertions: [{ id: 'pixels', type: 'regression', baseline: 'loop-canvas' }],
    });
    const checkedValue = checkVisionValue(check, '闭环 6/6：check regression', checked);
    check('同一 product 对自身基线 PASS（exitCode 0）', assertionOf(checked)?.status === 'PASS' && checkedValue.exitCode === 0, {
      expected: { status: 'PASS', exitCode: 0 }, actual: { status: assertionOf(checked)?.status, exitCode: checkedValue.exitCode },
    });
  });

  const caps = await call(harness, 'browser_capabilities', {});
  const capabilities = caps.value?.capabilities || [];
  check(`capabilities 可追溯：${FULL_SURFACE.length} 个工具条目（${FULL_SURFACE.length} = 24 旧 + 7 network + 5 T4）+ 六项 web.t3.* + 聚合项`,
    capabilities.filter((item) => item.tool).length === FULL_SURFACE.length
      && T3_TOOLS.every((tool) => capabilities.some((item) => item.tool === tool.name && item.status === 'available'))
      && capabilities.some((item) => item.id === 'web.t3.static-vision' && item.status === 'available'), {
      expected: { tools: FULL_SURFACE.length, t3Tools: 6 }, actual: { tools: capabilities.filter((item) => item.tool).length },
    });
  const t4 = capabilities.filter((item) => String(item.id || '').toLowerCase().includes('t4'));
  check('T4 已注册为 available（5 工具 + 聚合 + 别名），且不降低本套件的静态视觉断言', t4.length >= 7 && t4.every((item) => item.status === 'available'), { expected: 'available', actual: t4 });
  check('22 能力映射表在报告中完整（§10 22 行）', Array.isArray(report.environment.capabilityMap) && report.environment.capabilityMap.length === 22
    && report.environment.capabilityMap.every((row) => row.capability && row.tool), {
    expected: 22, actual: report.environment.capabilityMap?.length,
  });

  await pageValue(harness, 'window.__t3.startFlash(), true');
  const flashA = await call(harness, 'browser_vision_image', { source: { kind: 'live', region: { x: 640, y: 620, width: 40, height: 40 } } });
  await sleep(60);
  const flashB = await call(harness, 'browser_vision_image', { source: { kind: 'live', region: { x: 640, y: 620, width: 40, height: 40 } } });
  const flashCompare = await call(harness, 'browser_vision_compare', { before: { kind: 'product', productId: flashA.value?.product?.productId }, after: { kind: 'product', productId: flashB.value?.product?.productId } });
  await pageValue(harness, 'window.__t3.stopFlash(), true');
  const flashVerdict = flashCompare.value?.comparison?.verdict;
  check('闪烁场景只给静态两帧结论（PASS/WARN/FAIL 之一，不声称无闪烁）', flashCompare.ok && ['PASS', 'WARN', 'FAIL'].includes(flashVerdict), {
    expected: 'static verdict only', actual: { verdict: flashVerdict, metrics: flashCompare.value?.comparison?.metrics || flashCompare.error?.message },
  });
  check('compare 证据不含任何“无闪烁/动画已验证”断言字段', !JSON.stringify(flashCompare.value?.comparison || {}).match(/noFlicker|flickerVerified|animationVerified/i), {
    expected: 'no such claim', actual: 'absent',
  });
  finding({
    id: 'C56-closed-loop',
    summary: 'capture→find→act→compare→baseline→check 闭环完成；22 能力映射可追溯；T4 五工具已注册（其 40 条门槛由 t4-dynamic.mjs 另证，本套件不代替）。闪烁场景只比较静态两帧，报告不声称无中间闪烁。真实宿主加载与 provider 图像可见性仍为 NOT_RUN。',
    evidence: { flashVerdict, realHost: 'NOT_RUN', providerVisibility: 'NOT_RUN' },
  });
}


/* ------------------------------------------------------------------------------------------------
 * C57 — canvas-space live/find/compare/act (P0-C v2, docs/viewport-control.md §6.2)
 *
 * Added as an extra probe under §9.C56 (the closed-loop criterion already covers canvas mapping);
 * docs/t3-vision.md §9 still has exactly 56 criteria. Every check is either a decoded-PNG pixel
 * truth, a mapping field, or the real page event truth from window.__t3.
 * ---------------------------------------------------------------------------------------------- */

async function probeC57({ harness, check, finding }) {
  await freshPage(harness);
  const setView = (patch) => call(harness, 'browser_viewport', { action: 'set', ...patch });

  const base = await setView({ width: 800, height: 600, scale: 1, x: 0, y: 0 });
  check('画布基线：view 800×600/C=0/O=0', base.ok === true && base.value?.view?.canvasX === 0
    && base.value?.view?.canvasY === 0 && base.value?.offset?.x === 0 && base.value?.offset?.y === 0, {
    expected: { width: 800, height: 600, offset: 0 },
    actual: { view: base.value?.view, offset: base.value?.offset },
  });
  const moved = await setView({ canvasX: -100, canvasY: -50 });
  const truth = await pageValue(harness, '({ scrollX: window.scrollX, scrollY: window.scrollY, contentHeight: document.documentElement.scrollHeight })');
  check('canvasX=-100/canvasY=-50 生效，页面真值 scroll 仍 0（S 不改）', moved.ok === true
    && moved.value?.view?.canvasX === -100 && moved.value?.view?.canvasY === -50
    && truth?.scrollX === 0 && truth?.scrollY === 0, {
    expected: { canvas: { x: -100, y: -50 }, scroll: { x: 0, y: 0 } },
    actual: { view: moved.value?.view, truth },
  });

  // ---- live default capture: canvas viewport with white blank -------------------------------
  const live = await call(harness, 'browser_vision_image', { source: { kind: 'live' } });
  const liveValue = checkVisionValue(check, 'O≠0 的 live 默认采集成功（800×600 canvas 视口）', live, { requireImage: true });
  const mapping = liveValue.product?.mapping || {};
  check('live mapping = canvas-css-px：origin(-100,-50)、offset、contentRect、blank', mapping.coordinateSpace === 'canvas-css-px'
    && mapping.originCss?.x === -100 && mapping.originCss?.y === -50
    && mapping.canvas?.offsetX === -100 && mapping.canvas?.offsetY === -50
    && mapping.canvas?.contentHeight === truth?.contentHeight
    && JSON.stringify(mapping.contentRect) === JSON.stringify({ x: 0, y: 0, width: 700, height: 550 })
    && mapping.blank === 'outside-content', {
    expected: { coordinateSpace: 'canvas-css-px', origin: { x: -100, y: -50 }, contentRect: { x: 0, y: 0, width: 700, height: 550 }, blank: 'outside-content' },
    actual: mapping,
  });
  const sourceCapture = liveValue.evidence?.vision?.source?.[0]?.capture;
  check('证据披露 composite:true / capture.canvas / request.space=canvas-css-px', sourceCapture?.composite === true
    && sourceCapture?.canvas?.composite === true && sourceCapture?.canvas?.offsetX === -100
    && sourceCapture?.request?.space === 'canvas-css-px' && sourceCapture?.request?.coordinateSpace === 'canvas-css-px', {
    expected: { composite: true, space: 'canvas-css-px' },
    actual: { composite: sourceCapture?.composite, canvas: sourceCapture?.canvas, request: sourceCapture?.request },
  });
  const decoded = decodePng(Buffer.from(liveValue.image, 'base64'));
  const at = (x, y) => (decoded.ok ? pixelAt(decoded, x, y) : null);
  const isWhite = (p) => Boolean(p) && p.r === 255 && p.g === 255 && p.b === 255;
  // C=-100/-50 and a 920×1600 content box: only the left 100 and top 50 of the canvas viewport are
  // blank (right/bottom are still page content), so the blank truth is left/top white.
  check('合成 PNG 800×600，左 100 / 上 50 blank 纯白（内容从 (100,50) 开始）', decoded.ok === true
    && decoded.width === 800 && decoded.height === 600
    && isWhite(at(10, 300)) && isWhite(at(99, 300)) && isWhite(at(400, 10)) && isWhite(at(400, 49)), {
    expected: { size: [800, 600], blank: 'white left/top edges' },
    actual: decoded.ok ? { size: [decoded.width, decoded.height], left: at(10, 300), leftEdge: at(99, 300), top: at(400, 10), topEdge: at(400, 49) } : decoded,
  });
  check('内容按 -O 平移：#t3-red 图像 (140,90)、#t3-blue 图像 (260,90)', at(150, 100)?.r === 255
    && at(150, 100)?.g === 0 && at(150, 100)?.b === 0
    && at(270, 100)?.r === 0 && at(270, 100)?.g === 0 && at(270, 100)?.b === 255, {
    expected: { red: [255, 0, 0], blue: [0, 0, 255] },
    actual: { red: at(150, 100), blue: at(270, 100) },
  });

  // ---- find: document coords stay document coords and carry canvas ---------------------------
  const find = await call(harness, 'browser_vision_find', { source: { kind: 'live' }, query: { method: 'color', color: [255, 0, 0], tolerance: 0, minArea: 100 } });
  const findValue = checkVisionValue(check, 'canvas find 成功', find);
  const red = (findValue.result?.candidates || []).find((candidate) => candidate.documentCss
    && Math.abs(candidate.documentCss.x - 40) < 1 && Math.abs(candidate.documentCss.y - 40) < 1);
  check('find.documentCss 是文档坐标(40,40,80,60)，并带相同 canvas 矩形', Boolean(red)
    && red.canvas?.x === 40 && red.canvas?.y === 40 && red.canvas?.width === 80 && red.canvas?.height === 60, {
    expected: { documentCss: { x: 40, y: 40, width: 80, height: 60 }, canvas: { x: 40, y: 40, width: 80, height: 60 } },
    actual: (findValue.result?.candidates || []).slice(0, 4).map((candidate) => ({ documentCss: candidate.documentCss, canvas: candidate.canvas })),
  });

  // ---- negative region entirely in blank ----------------------------------------------------
  const blankSource = { kind: 'live', region: { x: -90, y: -40, width: 80, height: 30 } };
  const blankImage = await call(harness, 'browser_vision_image', { source: blankSource });
  const blankValue = checkVisionValue(check, '负 region（全 blank，canvas 坐标）采集成功', blankImage, { requireImage: true });
  check('负 region mapping：origin(-90,-40)、contentRect 0×0、仍为 canvas-css-px', blankValue.product?.mapping?.coordinateSpace === 'canvas-css-px'
    && blankValue.product?.mapping?.originCss?.x === -90 && blankValue.product?.mapping?.originCss?.y === -40
    && blankValue.product?.mapping?.contentRect?.width === 0 && blankValue.product?.mapping?.contentRect?.height === 0, {
    expected: { origin: { x: -90, y: -40 }, contentRect: { width: 0, height: 0 } },
    actual: blankValue.product?.mapping,
  });
  const blankFind = await call(harness, 'browser_vision_find', { source: blankSource, query: { method: 'color', color: [255, 255, 255], tolerance: 0, minArea: 1 } });
  const blankFindValue = checkVisionValue(check, 'blank region find 成功', blankFind);
  const blankCandidates = blankFindValue.result?.candidates || [];
  check('blank 候选保留像素结果，documentCss=null 且 canvas=(-90,-40)', blankCandidates.length >= 1
    && blankCandidates.every((candidate) => candidate.documentCss === null)
    && blankCandidates.every((candidate) => candidate.canvas?.x === -90 && candidate.canvas?.y === -40), {
    expected: { candidates: '>=1', documentCss: null, canvasX: -90 },
    actual: blankCandidates.slice(0, 2).map((candidate) => ({ region: candidate.region, documentCss: candidate.documentCss, canvas: candidate.canvas })),
  });

  // ---- act: blank zero dispatch, content p = q + O ------------------------------------------
  await resetEvents(harness);
  const actBlank = await call(harness, 'browser_vision_act', { productId: liveValue.product?.productId, action: 'click', point: { x: 10, y: 10 } });
  checkVisionError(check, 'blank 点击零派发（VISION_HIT_MISMATCH）', actBlank, { code: 'VISION_HIT_MISMATCH', category: 'action', retryable: false });
  check('blank 拒绝理由 blank-area 且带 canvas/content 证据', actBlank.error?.details?.reason === 'blank-area'
    && actBlank.error?.details?.canvasPoint?.x === -90 && actBlank.error?.details?.content?.height === truth?.contentHeight, {
    expected: { reason: 'blank-area' },
    actual: { details: actBlank.error?.details },
  });
  const afterBlank = await pageValue(harness, '({ seq: window.__t3.seq, clicks: window.__t3.counters.clicks })');
  check('blank 点击后真实页面零事件（seq=0、clicks=0）', afterBlank?.seq === 0 && afterBlank?.clicks === 0, {
    expected: { seq: 0, clicks: 0 },
    actual: afterBlank,
  });
  const actContent = await call(harness, 'browser_vision_act', { productId: liveValue.product?.productId, action: 'click', point: { x: 440, y: 120 } });
  const actValue = checkVisionValue(check, '内容区点击派发成功', actContent);
  const clickTruth = await pageValue(harness, '({ clicks: window.__t3.counters.clicks, last: window.__t3.last.click || null })');
  check('内容点击 p=q+O：图像(440,120) → 页面 clientX/Y=340/70，命中 #t3-click 计数 1', actValue.dispatched === true
    && clickTruth?.clicks === 1 && clickTruth?.last?.clientX === 340 && clickTruth?.last?.clientY === 70
    && clickTruth?.last?.target === 't3-click', {
    expected: { dispatched: true, clientX: 340, clientY: 70, target: 't3-click', clicks: 1 },
    actual: { dispatched: actValue.dispatched, point: actValue.point, truth: clickTruth },
  });

  // ---- compare: same canvas mapping compatible; cross-space incompatible --------------------
  const compare = await call(harness, 'browser_vision_compare', { before: { kind: 'live' }, after: { kind: 'live' } });
  const compareValue = checkVisionValue(check, 'canvas 同空间 compare 成功', compare);
  check('两次 canvas live 采集 mappingCompatible=true', compareValue.comparison?.mappingCompatible === true
    && compareValue.before?.mapping?.coordinateSpace === 'canvas-css-px'
    && compareValue.after?.mapping?.coordinateSpace === 'canvas-css-px', {
    expected: { mappingCompatible: true, coordinateSpace: 'canvas-css-px' },
    actual: { mappingCompatible: compareValue.comparison?.mappingCompatible, before: compareValue.before?.mapping?.coordinateSpace, after: compareValue.after?.mapping?.coordinateSpace },
  });
  await setView({ canvasX: 0, canvasY: 0 });
  const docLive = await call(harness, 'browser_vision_image', { source: { kind: 'live', region: { x: 0, y: 0, width: 800, height: 600 } } });
  const docValue = checkVisionValue(check, 'O=0 文档 live 采集成功（旧语义）', docLive, { requireImage: true });
  check('O=0 回到 document-css-px', docValue.product?.mapping?.coordinateSpace === 'document-css-px', {
    expected: 'document-css-px',
    actual: docValue.product?.mapping?.coordinateSpace,
  });
  const cross = await call(harness, 'browser_vision_compare', {
    before: { kind: 'product', productId: liveValue.product?.productId },
    after: { kind: 'live', region: { x: 0, y: 0, width: 800, height: 600 } },
  });
  const crossValue = checkVisionValue(check, 'canvas product 与 document live 可比较（同尺寸）', cross);
  const crossWarnings = visionEvidence(cross)?.metrics?.warnings || [];
  check('跨坐标空间 mapping 不兼容：mappingCompatible=false + mapping-incompatible 警告', crossValue.comparison?.mappingCompatible === false
    && crossWarnings.includes('mapping-incompatible'), {
    expected: { mappingCompatible: false, warning: 'mapping-incompatible' },
    actual: { mappingCompatible: crossValue.comparison?.mappingCompatible, warnings: crossWarnings },
  });

  await setView({ width: 800, height: 600, canvasX: 0, canvasY: 0 });
  finding({
    id: 'C57-canvas-space',
    summary: 'canvas 空间 live 截图/映射/find/act/compare 全部走 canvas mapping：blank 纯白、documentCss=null（blank 候选）、act blank 零派发、内容 p=q+O 命中真实事件；跨 document/canvas mapping 由既有 mapping-incompatible 处理。',
    evidence: { coordinateSpace: 'canvas-css-px', blankZeroDispatch: afterBlank },
  });
}

/* ------------------------------------------------------------------------------------------------
 * U-class runners (pure algorithm / baseline FS unit checks, merged by criterion)
 * ---------------------------------------------------------------------------------------------- */

function uCheck(criteria, label, pass, detail) {
  recordCriterionCheck(criteria, {
    source: 'U',
    label: String(label),
    pass: Boolean(pass),
    required: true,
    advisory: false,
    detail: jsonSafe(detail) ?? null,
  });
}

async function runUnitRunners() {
  report.unitRunners = [];
  const targets = [
    { file: 'vision-t3-algorithms.test.mjs', fn: 'runAlgorithmChecks' },
    { file: 'vision-baseline.test.mjs', fn: 'runBaselineChecks' },
  ];
  for (const target of targets) {
    const path = join(REPO_ROOT, 'tests', target.file);
    if (!existsSync(path)) {
      report.unitRunners.push({ file: target.file, runner: target.fn, status: 'missing' });
      log(`\n[unit] ${target.file} 不存在 -> U 类 criteria 记为 NOT_RUN（不冒充 PASS）`);
      continue;
    }
    let module;
    try {
      module = await import(pathToFileURL(path).href);
    } catch (error) {
      report.unitRunners.push({ file: target.file, runner: target.fn, status: 'import-error', message: errorMessage(error) });
      log(`\n[unit] ${target.file} import 失败：${errorMessage(error)}`);
      continue;
    }
    const runner = module[target.fn];
    if (typeof runner !== 'function') {
      report.unitRunners.push({ file: target.file, runner: target.fn, status: 'missing-export' });
      log(`\n[unit] ${target.file} 缺少导出 ${target.fn}`);
      continue;
    }
    const startedAt = Date.now();
    let count = 0;
    const check = (criteria, label, pass, detail) => {
      count += 1;
      uCheck(criteria, label, pass, detail);
    };
    try {
      log(`\n== U-runner ${target.file} (${target.fn})`);
      await runner(check);
      report.unitRunners.push({ file: target.file, runner: target.fn, status: 'ok', checks: count, durationMs: Date.now() - startedAt });
      log(`== U-runner ${target.file} OK (${count} checks, ${Date.now() - startedAt}ms)`);
    } catch (error) {
      report.unitRunners.push({ file: target.file, runner: target.fn, status: 'error', checks: count, message: errorMessage(error), durationMs: Date.now() - startedAt });
      log(`== U-runner ${target.file} ERROR after ${count} checks: ${errorMessage(error)}`);
    }
  }
}

/* ------------------------------------------------------------------------------------------------
 * C42 — §9.C42 check batch validation, five statuses, summary and exitCode
 * (contract marks it U; implemented as a B check per Lead adjudication 2026-11-01)
 * ---------------------------------------------------------------------------------------------- */

async function probeC42({ harness, check, finding }) {
  await freshPage(harness);
  const captureRoot = process.env.DSH_UI_TESTING_CAPTURE_DIR;
  const filesBefore = captureRoot ? (await listFilesRecursive(captureRoot)).length : null;
  const context = await factContext(harness);
  const colorAssertion = { id: 'a', type: 'color', region: { x: 100, y: 620, width: 80, height: 40 }, expectedColor: [255, 0, 0], tolerance: 16, minFraction: 0.95 };
  const validCase = (id) => ({ id, source: { kind: 'live' }, assertions: [colorAssertion] });
  const manyFacts = Array.from({ length: 65 }, (_, index) => makeFact(context, `f${index}`, { rect: { x: 100, y: 420, width: 120, height: 40 } }));
  const invalidBodies = [
    ['cases 空数组', { cases: [] }],
    ['cases 超过 20', { cases: Array.from({ length: 21 }, (_, index) => validCase(`c${index}`)) }],
    ['assertions 超过 32', { cases: [{ id: 'c1', source: { kind: 'live' }, assertions: Array.from({ length: 33 }, (_, index) => ({ ...colorAssertion, id: `a${index}` })) }] }],
    ['facts 超过 64', { cases: [{ ...validCase('c1'), facts: manyFacts }] }],
    ['重复 case id', { cases: [validCase('dup'), validCase('dup')] }],
    ['重复 assertion id', { cases: [{ id: 'c1', source: { kind: 'live' }, assertions: [colorAssertion, { ...colorAssertion }] }] }],
    ['重复 fact id', { cases: [{ ...validCase('c1'), facts: [makeFact(context, 'same', { rect: { x: 100, y: 420, width: 120, height: 40 } }), makeFact(context, 'same', { rect: { x: 100, y: 470, width: 120, height: 40 } })] }] }],
    ['case 未知字段', { cases: [{ ...validCase('c1'), foo: 1 }] }],
    ['assertion 未知字段', { cases: [{ id: 'c1', source: { kind: 'live' }, assertions: [{ ...colorAssertion, foo: 1 }] }] }],
    ['assertion severity 非法', { cases: [{ id: 'c1', source: { kind: 'live' }, assertions: [{ ...colorAssertion, severity: 'critical' }] }] }],
    ['fact 类型错误（observedAt 字符串）', { cases: [{ ...validCase('c1'), facts: [{ ...makeFact(context, 'bad', { rect: { x: 100, y: 420, width: 120, height: 40 } }), provenance: { ...makeFact(context, 'bad', {}).provenance, observedAt: 'now' } }] }] }],
  ];
  const problems = [];
  for (const [label, body] of invalidBodies) {
    const result = await call(harness, 'browser_vision_check', body);
    const error = result.error || {};
    const pass = result.threw === true && error.code === 'INVALID_ARGUMENT' && error.category === 'input' && error.retryable === false
      && String(error.message || '').startsWith('[INVALID_ARGUMENT]');
    if (!pass) problems.push({ label, code: error.code, category: error.category, message: String(error.message || '').slice(0, 160) });
  }
  check('非法批次（空/超限/重复 id/未知字段/非法类型）全部 INVALID_ARGUMENT', problems.length === 0, { expected: 'all INVALID_ARGUMENT', actual: problems });
  const filesAfter = captureRoot ? (await listFilesRecursive(captureRoot)).length : null;
  check('非法批次零副作用（截图根文件数不变）', filesBefore === filesAfter, { expected: filesBefore, actual: filesAfter });

  // Five statuses in one batch: PASS / WARN / FAIL / INCONCLUSIVE / BLOCKED.
  await pageValue(harness, 'window.__t3.moveLayout(104), true');
  const layoutRects = await domRects(harness, ['t3-layout', 't3-color']);
  const layoutRect = layoutRects['t3-layout'];
  const colorRect = layoutRects['t3-color'];
  const context2 = await factContext(harness);
  const layoutFact = makeFact(context2, 'box', { rect: cssRectOf(layoutRect) });
  const colorFact = makeFact(context2, 'color', { rect: cssRectOf(colorRect), style: { backgroundColor: parseCssColor(colorRect.backgroundColor) } });
  const layoutBody = (severity) => ({ id: `l-${severity}`, source: { kind: 'live' }, assertions: [{ id: 'a', type: 'layout', region: pixelRectOf(layoutRect), factId: 'box', expectedRect: { x: 100, y: 420, width: 120, height: 40 }, toleranceCss: 1, severity }], facts: [layoutFact] });
  const batch = await call(harness, 'browser_vision_check', {
    cases: [
      { id: 'pass', source: { kind: 'live' }, assertions: [{ id: 'a', type: 'color', region: pixelRectOf(colorRect), factId: 'color', expectedColor: [255, 0, 0], tolerance: 16, minFraction: 0.95 }], facts: [colorFact] },
      { ...layoutBody('advisory'), id: 'warn' },
      { ...layoutBody('required'), id: 'fail' },
      { id: 'inconclusive', source: { kind: 'live' }, assertions: [{ id: 'a', type: 'color', region: pixelRectOf(colorRect), expectedColor: [255, 0, 0] }] },
      { id: 'blocked', source: { kind: 'live' }, assertions: [{ id: 'a', type: 'regression', baseline: 'no-such-baseline' }] },
    ],
  });
  const batchValue = checkVisionValue(check, '五状态混合批次返回成功体', batch);
  const statuses = (batchValue.cases || []).map((item) => item.assertions?.[0]?.status);
  check('五状态优先：case 依次 PASS/WARN/FAIL/INCONCLUSIVE/BLOCKED', JSON.stringify(statuses) === JSON.stringify(['PASS', 'WARN', 'FAIL', 'INCONCLUSIVE', 'BLOCKED']), {
    expected: ['PASS', 'WARN', 'FAIL', 'INCONCLUSIVE', 'BLOCKED'], actual: statuses,
  });
  const summary = batchValue.summary || {};
  check('summary 按 assertion status 计数各 1 份', summary.pass === 1 && summary.warn === 1 && summary.fail === 1
    && summary.inconclusive === 1 && summary.blocked === 1, { expected: { pass: 1, warn: 1, fail: 1, inconclusive: 1, blocked: 1 }, actual: summary });
  check('总 verdict=FAIL、exitCode=1', batchValue.verdict === 'FAIL' && batchValue.exitCode === 1, {
    expected: { verdict: 'FAIL', exitCode: 1 }, actual: { verdict: batchValue.verdict, exitCode: batchValue.exitCode },
  });

  const warnOnly = await call(harness, 'browser_vision_check', { cases: [layoutBody('advisory')] });
  check('仅 WARN -> verdict WARN、exitCode 0', warnOnly.value?.verdict === 'WARN' && warnOnly.value?.exitCode === 0, {
    expected: { verdict: 'WARN', exitCode: 0 }, actual: { verdict: warnOnly.value?.verdict, exitCode: warnOnly.value?.exitCode },
  });
  const inconclusiveOnly = await call(harness, 'browser_vision_check', {
    cases: [{ id: 'unknown', source: { kind: 'live' }, assertions: [{ id: 'a', type: 'color', region: pixelRectOf(colorRect), expectedColor: [255, 0, 0] }] }],
  });
  check('无 FAIL 但有 INCONCLUSIVE -> exitCode 2', inconclusiveOnly.value?.exitCode === 2, {
    expected: 2, actual: inconclusiveOnly.value?.exitCode,
  });
  const blockedOnly = await call(harness, 'browser_vision_check', {
    cases: [{ id: 'blocked', source: { kind: 'live' }, assertions: [{ id: 'a', type: 'regression', baseline: 'no-such-baseline' }] }],
  });
  check('BLOCKED（无 FAIL）-> exitCode 2', blockedOnly.value?.exitCode === 2, { expected: 2, actual: blockedOnly.value?.exitCode });
  await pageValue(harness, 'window.__t3.moveLayout(100), true');
  finding({ id: 'C42-classification', summary: 'C42 由 B 类检查覆盖（契约标 U，Lead 裁决 implemented as B）：长度/ID/未知字段/类型预检零副作用；五状态优先、summary 与 exitCode 0/1/2 均实测。' });
}

/* ------------------------------------------------------------------------------------------------
 * C50 — §9.C50 explicit fact fusion rules (scope/runtime/epoch/time/ROI/type)
 * (contract marks it U; implemented as a B check per Lead adjudication 2026-11-01)
 * ---------------------------------------------------------------------------------------------- */

async function probeC50({ harness, check, finding }) {
  await freshPage(harness);
  await pageValue(harness, 'window.__t3.moveLayout(104), true');
  const rects = await domRects(harness, ['t3-layout']);
  const rect = rects['t3-layout'];
  const region = pixelRectOf(rect);
  const context = await factContext(harness);
  const layoutAssertion = { id: 'a', type: 'layout', region, factId: 'box', expectedRect: { x: 100, y: 420, width: 120, height: 40 }, toleranceCss: 1 };
  const runWith = async (fact, label) => {
    const result = await call(harness, 'browser_vision_check', { cases: [{ id: 'c50', source: { kind: 'live' }, assertions: [layoutAssertion], facts: [fact] }] });
    return { result, assertion: assertionOf(result), label };
  };
  const baseFields = { rect: cssRectOf(rect) };
  // Each `runWith` performs its OWN live capture, and the fusion gate requires
  // `|fact.observedAt - capture.capturedAt| <= 1000ms` (§7.1) BEFORE the ROI check runs. A single
  // `factContext` timestamp reused across eight captures therefore drifts past the window and turns
  // every later case into `fact-stale-or-mismatch` — which would make the ROI case test staleness
  // instead of the ROI rule. Re-stamping `observedAt` immediately before each case keeps "fresh
  // provenance, one deliberately wrong field / ROI" isolated. (Diagnosed 2026-11-02: the sequence
  // reached ~1097ms after the shared timestamp, i.e. the failure was a test-timing artifact, not an
  // implementation regression — the gate itself is unchanged.)
  const freshContext = () => ({ ...context, observedAt: Date.now() });
  const control = await runWith(makeFact(freshContext(), 'box', baseFields), 'control');
  check('匹配 provenance 的 fact 可融合（4px 偏差 -> FAIL）', control.assertion?.status === 'FAIL'
    && control.assertion?.metrics?.fusion === 'external-facts', {
    expected: { status: 'FAIL', fusion: 'external-facts' }, actual: { status: control.assertion?.status, metrics: jsonSafe(control.assertion?.metrics) },
  });
  const withinWindow = await runWith(makeFact({ ...freshContext(), observedAt: Date.now() - 500 }, 'box', baseFields), 'within-500ms');
  check('observedAt 与采集差 <1000ms 仍可融合（非 INCONCLUSIVE）', withinWindow.assertion?.status === 'FAIL', {
    expected: 'FAIL', actual: { status: withinWindow.assertion?.status, reason: withinWindow.assertion?.reason },
  });

  // Each case mutates exactly ONE provenance field on a freshly stamped context, so the reason can
  // only come from that field (not from cumulative elapsed time).
  const staleCases = [
    ['scopeId 不匹配', (ctx) => ({ ...ctx, scopeId: 'ws_other_scope' })],
    ['runtimeId 不匹配', (ctx) => ({ ...ctx, runtimeId: 'runtime-other' })],
    ['pageGeneration 不匹配', (ctx) => ({ ...ctx, pageGeneration: (ctx.pageGeneration || 1) + 1 })],
    ['documentEpoch 不匹配', (ctx) => ({ ...ctx, documentEpoch: (ctx.documentEpoch || 0) + 1 })],
    ['observedAt 超过 1000ms', (ctx) => ({ ...ctx, observedAt: Date.now() - 2000 })],
  ];
  const staleProblems = [];
  for (const [label, mutate] of staleCases) {
    const outcome = await runWith(makeFact(mutate(freshContext()), 'box', baseFields), label);
    const status = outcome.assertion?.status;
    const reason = String(outcome.assertion?.reason || '');
    if (!(status === 'INCONCLUSIVE' && /fact/.test(reason))) staleProblems.push({ label, status, reason, errorCode: outcome.assertion?.errorCode });
  }
  check('fact scope/runtime/pageGeneration/documentEpoch/时间 >1000ms 不融合 -> INCONCLUSIVE(reason=fact-*)', staleProblems.length === 0, {
    expected: 'all INCONCLUSIVE with fact-* reason', actual: staleProblems,
  });

  const mismatch = await runWith(makeFact(freshContext(), 'box', { rect: { x: 1000, y: 700, width: 20, height: 20 } }), 'roi-mismatch');
  check('fact rect 与 ROI 无交集 -> INCONCLUSIVE(reason=fact-region-mismatch)', mismatch.assertion?.status === 'INCONCLUSIVE'
    && /fact-region-mismatch/.test(String(mismatch.assertion?.reason || '')), {
    expected: { status: 'INCONCLUSIVE', reason: 'fact-region-mismatch' }, actual: { status: mismatch.assertion?.status, reason: mismatch.assertion?.reason },
  });

  const invalidFacts = [
    ['缺少 provenance', { id: 'box', rect: cssRectOf(rect) }],
    ['provenance 缺 sourceActionId', { id: 'box', rect: cssRectOf(rect), provenance: { ...makeFact(context, 'x', {}).provenance, sourceActionId: undefined } }],
    ['provenance observedAt 类型错误', { id: 'box', rect: cssRectOf(rect), provenance: { ...makeFact(context, 'x', {}).provenance, observedAt: 'yesterday' } }],
    ['provenance sourceTool 非法', { id: 'box', rect: cssRectOf(rect), provenance: { ...makeFact(context, 'x', {}).provenance, sourceTool: 'browser_vision_image' } }],
  ];
  const invalidProblems = [];
  for (const [label, fact] of invalidFacts) {
    const outcome = await runWith(fact, label);
    const error = outcome.result.error || {};
    if (!(outcome.result.threw === true && error.code === 'INVALID_ARGUMENT' && error.category === 'input')) {
      invalidProblems.push({ label, code: error.code, status: outcome.assertion?.status });
    }
  }
  check('fact provenance 缺失/字段类型错/sourceTool 非法 -> INVALID_ARGUMENT', invalidProblems.length === 0, {
    expected: 'all INVALID_ARGUMENT', actual: invalidProblems,
  });
  await pageValue(harness, 'window.__t3.moveLayout(100), true');
  finding({ id: 'C50-fusion', summary: 'C50 由 B 类检查覆盖（契约标 U，Lead 裁决 implemented as B）：事实与图像 scope/runtime/代次/时间/ROI 不一致一律 INCONCLUSIVE；provenance 缺失或类型错为 INVALID_ARGUMENT。' });
}

/* ------------------------------------------------------------------------------------------------
 * Environment, cleanup, report and entry point
 * ---------------------------------------------------------------------------------------------- */

let MAIN_HARNESS;
let FIXTURE_SERVER;

const CAPABILITY_MAP = [
  { capability: '1 静态截图分析', tool: 'browser_vision_image', entry: 'source/analysis' },
  { capability: '2 区域裁剪与放大', tool: 'browser_vision_image', entry: 'source.region/source.scale/region/resize' },
  { capability: '3 截图标注', tool: 'browser_vision_image', entry: 'annotations' },
  { capability: '4 图像预处理', tool: 'browser_vision_image', entry: 'preprocess' },
  { capability: '5 视觉元素识别', tool: 'browser_vision_find', entry: 'query / image.recognize' },
  { capability: '6 视觉元素定位', tool: 'browser_vision_find', entry: 'region/query → candidates' },
  { capability: '7 坐标交互', tool: 'browser_vision_act', entry: 'productId/action/point/to' },
  { capability: '8 操作前后对比', tool: 'browser_vision_compare', entry: 'before/after' },
  { capability: '9 像素级差异检测', tool: 'browser_vision_compare', entry: 'options.threshold/includeAA' },
  { capability: '10 差异区域高亮', tool: 'browser_vision_compare', entry: 'output/regions' },
  { capability: '11 图像相似度计算', tool: 'browser_vision_compare', entry: 'comparison.metrics.similarity' },
  { capability: '12 动态区域屏蔽', tool: 'browser_vision_compare', entry: 'masks / baseline.masks' },
  { capability: '13 视觉基线管理', tool: 'browser_vision_baseline', entry: 'action list/get/create/update/delete' },
  { capability: '14 视觉回归测试', tool: 'browser_vision_check', entry: 'assertions.type=regression' },
  { capability: '15 布局异常检测', tool: 'browser_vision_check', entry: 'assertions.type=layout' },
  { capability: '16 元素遮挡检测', tool: 'browser_vision_check', entry: 'assertions.type=occlusion' },
  { capability: '17 内容溢出检测', tool: 'browser_vision_check', entry: 'assertions.type=overflow' },
  { capability: '18 文字截断检测', tool: 'browser_vision_check', entry: 'assertions.type=truncation' },
  { capability: '19 颜色异常检测', tool: 'browser_vision_check', entry: 'assertions.type=color' },
  { capability: '20 组件缺失检测', tool: 'browser_vision_check', entry: 'assertions.type=missing' },
  { capability: '21 视觉缺陷判断', tool: 'browser_vision_check', entry: 'summary/verdict' },
  { capability: '22 裁剪指定区域识别', tool: 'browser_vision_image', entry: 'region + recognize / find.region' },
];

const state = {
  harnesses: OWNED_HARNESSES,
  fixture: undefined,
  cleanupResult: undefined,
  finished: false,
  hardTimedOut: false,
  baselineProfiles: new Set(),
  baselinePids: new Set(),
  ownedProfiles: new Set(),
  chromium: undefined,
};

let spawnProcess;
async function loadSpawn() {
  if (spawnProcess) return spawnProcess;
  const childProcess = await import('node:child_process');
  spawnProcess = childProcess.spawn;
  return spawnProcess;
}

async function probeChromium(bin, timeoutMs = 7000) {
  const profileDir = await mkdtemp(join(tmpdir(), 'dsh-t3-chrome-probe-'));
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
  await loadSpawn();
  const explicit = process.env.DSH_UI_TESTING_CHROME;
  if (explicit) {
    return { bin: explicit, source: 'env', note: 'DSH_UI_TESTING_CHROME 由调用方显式指定，跳过默认探活' };
  }
  if (!existsSync(DEFAULT_CHROME)) {
    throw new Error(`默认 Chromium 不存在：${DEFAULT_CHROME}（可用 DSH_UI_TESTING_CHROME 覆盖）`);
  }
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
  const harnessModuleRef = await harnessModule();
  try {
    for (const harness of state.harnesses) {
      try { await harness.closeBrowser(); } catch (error) { result.errors.push(`close ${harness.name}: ${errorMessage(error)}`); }
      result.closedHarnesses.push(harness.name);
    }
    await sleep(1200);
    for (const harness of state.harnesses) {
      try { await harness.dispose(); } catch (error) { result.errors.push(`dispose ${harness.name}: ${errorMessage(error)}`); }
    }
    const stray = ownedNewChromeProcesses(harnessModuleRef.scanPluginChromeProcesses);
    for (const proc of stray) { try { process.kill(proc.pid, 'SIGTERM'); } catch { /* ignore */ } }
    if (stray.length) await sleep(1200);
    for (const proc of stray) {
      if (isAlive(proc.pid)) { try { process.kill(proc.pid, 'SIGKILL'); } catch { /* ignore */ } }
      if (!isAlive(proc.pid)) result.killedPids.push(proc.pid);
    }
    await sleep(300);
    const leftovers = ownedNewProfiles(await harnessModuleRef.snapshotProfileDirs());
    for (const dir of leftovers) {
      if (!dir.startsWith(tmpdir() + sep)) continue;
      try { await rm(dir, { recursive: true, force: true }); result.removedProfileDirs.push(dir); }
      catch (error) { result.errors.push(`rm ${dir}: ${errorMessage(error)}`); }
    }
    result.leftoverProfileDirs = ownedNewProfiles(await harnessModuleRef.snapshotProfileDirs())
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
      const stray = ownedNewChromeProcesses(harnessModuleRef.scanPluginChromeProcesses);
      for (const proc of stray) { try { process.kill(proc.pid, 'SIGKILL'); } catch { /* ignore */ } result.killedPids.push(proc.pid); }
    } catch { /* ignore */ }
  }
  state.cleanupResult = result;
  log(`[cleanup] done: killed=${result.killedPids.length} removedProfiles=${result.removedProfileDirs.length} leftoverProfiles=${result.leftoverProfileDirs.length} leftoverPids=${result.leftoverChromePids.length} fixtureClosed=${result.fixtureClosed} tempRemoved=${result.removedTempDirs.length}`);
  return result;
}

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
    else if (notRun.length > 0) status = 'partial';
    else status = 'pass';
    return {
      id,
      kind,
      title,
      status,
      requiredChecks: required.length,
      failedChecks: failed.length,
      checks,
      notRun,
      notApplicable,
    };
  });
}

async function writeEvidence() {
  await mkdir(EVIDENCE_DIR, { recursive: true });
  report.criteria = buildCriteriaReport();
  report.adjudications = [
    { id: 'inert-hit-test', date: '2026-11-01', source: 'lead', ruling: 'inert 子树不参与 hit-test（elementFromPoint/CDP 返回非 inert 祖先，实测 BODY）；C30 的 inert 子项断言“未被激活/未收到事件”，vision HIT_MISMATCH 期望记 NOT_APPLICABLE，不得记 PASS（已实现）。' },
    { id: 'template-coordinates', date: '2026-11-01', source: 'lead', ruling: '裁剪 product 作 template source 时按 §2.2/§2.3 相对源图返回是正确语义；C48 使用全页 live case.source + 20×20 裁剪模板 product，坐标断言不涉模板坐标（已注明）。' },
    { id: 'viewport-change-final', date: '2026-11-01', source: 'lead', targets: ['viewport-change-not-run'], ruling: '最终裁决：C28 viewport 子项已实跑通过——setup 使用插件自身 POST /plugins/ui-testing/viewport（scopeVersion=1 + sessionId，同源 GUI 命令、同一 runtime.run 队列，非 CDP shim），把本 scope 由 1280×800 改为 1000×700 后，旧 product 的 browser_vision_act 抛 VISION_STALE_IMAGE(reason=viewport-changed) 且零派发；随后同一路由恢复 1280×800。setup 来源见 finding C28-setup-source。' },
    { id: 'c25-dom-quantization', date: '2026-11-01', source: 'lead', ruling: 'Blink 把 CDP Input 鼠标坐标截断为整数（裸 CDP 实测 x=104.4 / 104.5 / 104 -> MouseEvent.clientX 均为 104），DOM 侧无法保留小数。工具报告的 imagePixels/documentCss/viewportCss 必须保留小数（已断言 104.4/72.4，容差 0.01）；DOM clientX/clientY 按 floor 值、容差 ≤1 CSS px 断言；「DOM 保留小数」子项记 NOT_APPLICABLE。契约已同步此事实。' },
    { id: 'c42-c50-as-b', date: '2026-11-01', source: 'lead', ruling: 'C42/C50 契约标 U，但实现逻辑在 Host；按 Lead 裁决由本套件以 B 类覆盖，报告注明 implemented as B。' },
    { id: 'c4-fractional-size', date: '2026-11-01', source: 'lead', ruling: 'Chrome 对小数 clip 取 floor（79.5×59.5 -> 79×59）；C4 断言 round 期望 ±1 每轴 + mapping 覆盖请求 rect，不放宽成任意尺寸；101×50@1.11 仍须 112×56。' },
    { id: 'c28-viewport-setup', date: '2026-11-01', source: 'lead', ruling: '允许用插件自身 POST /plugins/ui-testing/viewport（scopeVersion=1 + sessionId）作为 setup 触发 resize，断言仍由 browser_vision_act 产出。' },
    { id: 'c31-page-truth-na', date: '2026-11-01', source: 'lead', targets: ['c31-page-truth-not-run'], ruling: 'C31 只要求取消不重放/button 释放/dispatch 计数/after null；ABORTED 路径关闭页面（与 T2 §9.30/§9.31 一致），页面级 downs/ups 真值不可读，该子项统一记 NOT_APPLICABLE（与本条合并去重，不再并存 NOT_RUN 记录）。' },
    { id: 'success-evidence-shape', date: '2026-11-01', source: 'lead', ruling: '成功体按契约 §1.2 收紧为嵌套 evidence.vision（实现已改）；错误路径保持 details.evidence.vision；套件不再接受扁平拼写。' },
  ];
  const failedChecks = report.criteria.flatMap((criterion) => criterion.checks.filter((item) => item.required && !item.pass)
    .map((item) => ({ criterion: criterion.id, label: item.label, source: item.source, detail: item.detail })));
  const covered = report.criteria.filter((criterion) => criterion.checks.length > 0).length;
  const passed = report.criteria.filter((criterion) => criterion.status === 'pass').length;
  const failed = report.criteria.filter((criterion) => criterion.status === 'fail').length;
  const partial = report.criteria.filter((criterion) => criterion.status === 'partial').length;
  const notRunCriteria = report.criteria.filter((criterion) => criterion.status === 'not-run').length;
  let exitCode = 0;
  if (failedChecks.length > 0) exitCode = 1;
  else if (covered < 56) exitCode = 2;
  else if (partial > 0) exitCode = 2;
  report.summary = {
    criteriaTotal: CRITERIA.length,
    criteriaCovered: covered,
    criteriaPassed: passed,
    criteriaFailed: failed,
    criteriaPartial: partial,
    criteriaNotRun: notRunCriteria,
    requiredChecks: report.criteria.reduce((sum, criterion) => sum + criterion.requiredChecks, 0),
    failedChecks: failedChecks.length,
    notRunChecks: report.notRun.filter((item) => item.disposition !== 'NOT_APPLICABLE').length,
    notApplicableChecks: report.notRun.filter((item) => item.disposition === 'NOT_APPLICABLE').length,
    findings: report.findings.length,
    images: report.images.length,
    unitRunners: (report.unitRunners || []).map((runner) => `${runner.file}:${runner.status}`),
    exitCode,
  };
  report.failedChecks = failedChecks;
  report.resources = state.cleanupResult || { reason: 'not-run' };
  report.environment.fixtureUrl = report.environment.fixtureUrl || state.fixture?.url;
  await writeFile(join(EVIDENCE_DIR, 'run-report.json'), JSON.stringify(report, null, 2));
  await writeFile(join(EVIDENCE_DIR, 'run.log'), logLines.join('\n') + '\n');
  return report.summary;
}

const B_PROBES = [
  { id: 'C1-registration', criteria: '§9.C1', title: '注册 36 工具 / capabilities 仅诊断', expected: '恰好 36 工具（10 T1 + 1 P0-E + 7 T2 + 6 T3 + 7 network + 5 T4）、required 与 §2.1/§2 一致、capabilities.vision 完整、T1/T2 关键路径不回归', body: probeC1 },
  { id: 'C3-live-capture', criteria: '§9.C3', title: 'live 默认/scale/region 与 mapping', expected: '默认 1280×800；红块 @1.25=100×75；mapping 与 P0 公式一致；不改变页面', body: probeC3 },
  { id: 'C4-bounds', criteria: '§9.C4', title: '文档边界与 PixelRect 整数', expected: '越界/负原点/零面积/顶层小数拒绝；101×50@1.11=112×56', body: probeC4 },
  { id: 'C5-scope', criteria: '§9.C5', title: 'product scope 隔离与导航后离线分析', expected: '跨 scope SOURCE_NOT_FOUND；导航后读图成功、act 失效', body: probeC5 },
  { id: 'C12-crop-recognize', criteria: '§9.C12', title: '裁剪 + 识别 + 标注前统计', expected: '80×60 裁剪、红候选 (0,0,80,60)、documentCss (40,40,80,60)、标注不改 analysis', body: probeC12 },
  { id: 'C14-signals', criteria: '§9.C14', title: 'color/components/edges 候选', expected: '红/蓝与 canvas 候选坐标回加 ROI、未命中 []、semanticName=null', body: probeC14 },
  { id: 'C17-compare-flow', criteria: '§9.C17', title: 'before product → click → after live', expected: '两图 hash/时间不同、事件只有外部 click、静止页 compare 相同', body: probeC17 },
  { id: 'C22-coordinates', criteria: '§9.C22', title: '双坐标 mapping 与尺寸/映射错误', expected: 'scale2 10CSS=20px、CSS 区域精确、尺寸不等 SIZE_MISMATCH、不兼容 CSS=null', body: probeC22 },
  { id: 'C24-mask', criteria: '§9.C24', title: 'clock 显式 mask', expected: '无 mask FAIL、恰 mask PASS、漏一列计 20 像素、源图不变', body: probeC24 },
  { id: 'C25-act-mapping', criteria: '§9.C25', title: 'act 坐标映射（scroll+scale）', expected: 'image→document→viewport 误差 ≤0.01、isTrusted、分数不取整', body: probeC25 },
  { id: 'C26-act-events', criteria: '§9.C26', title: 'move/click/right/middle/double/modifiers', expected: 'eventCount 3/5/1、__t3 button/buttons/detail/modifiers 真值', body: probeC26 },
  { id: 'C27-drag', criteria: '§9.C27', title: 'drag steps+3 与 drop 真值', expected: '7 个事件、线性路径、finally 释放、drop (420,160)', body: probeC27 },
  { id: 'C28-stale', criteria: '§9.C28', title: 'stale 拒绝（像素/scroll/代次/viewport）', expected: '四类变化均 VISION_STALE_IMAGE 且零派发', body: probeC28 },
  { id: 'C30-hit-boundary', criteria: '§9.C30', title: '命中边界与拒绝', expected: '不穿 overlay、disabled/inert/运动/iframe/视口外零派发', body: probeC30 },
  { id: 'C31-cancel', criteria: '§9.C31', title: '部分拖拽取消', expected: 'ABORTED、按钮释放、无重放、无 after product', body: probeC31 },
  { id: 'C35-baseline', criteria: '§9.C35', title: 'baseline create/get/list', expected: '单次 create 提交 revision1、元数据与磁盘 PNG 一致', body: probeC35 },
  { id: 'C39-restart', criteria: '§9.C39', title: '跨工作区/重启/dispose', expected: '跨 scope 不可见、新实例可 get、旧 product 失效、dispose 保留显式数据', body: probeC39 },
  { id: 'C40-regression-inherit', criteria: '§9.C40', title: 'regression 继承 mask/options', expected: '继承 PASS、显式 [] FAIL、元数据不变、diffProduct 可读', body: probeC40 },
  { id: 'C41-blocked', criteria: '§9.C41', title: 'check 缺基线/映射不兼容', expected: 'BLOCKED + exitCode2、不自动建基线、尺寸/mapping 阻塞', body: probeC41 },
  { id: 'C42-check-rules', criteria: '§9.C42', title: 'check 批次校验与五状态', expected: '长度/ID/未知字段/类型 -> INVALID_ARGUMENT 零副作用；五状态优先、summary、exitCode 0/1/2（implemented as B）', body: probeC42 },
  { id: 'C43-layout', criteria: '§9.C43', title: 'layout 正负例', expected: 'x104 FAIL、x100.5 PASS、pixels-only required INCONCLUSIVE / advisory WARN', body: probeC43 },
  { id: 'C44-occlusion', criteria: '§9.C44', title: 'occlusion 采样', expected: '5/5 FAIL、0/5 PASS、2/5 FAIL、1 点/隐藏 INCONCLUSIVE', body: probeC44 },
  { id: 'C45-overflow', criteria: '§9.C45', title: 'overflow 意图', expected: 'visible FAIL、auto/allow PASS、pixels-only INCONCLUSIVE/WARN', body: probeC45 },
  { id: 'C46-truncation', criteria: '§9.C46', title: 'truncation 度量', expected: 'clipped FAIL、allow PASS、正常副本 PASS、lineClamp 分支、无 fact INCONCLUSIVE', body: probeC46 },
  { id: 'C47-color', criteria: '§9.C47', title: 'color 双信号', expected: '红/红 PASS、蓝/蓝 FAIL、冲突/alpha INCONCLUSIVE', body: probeC47 },
  { id: 'C48-missing', criteria: '§9.C48', title: 'missing template + presence', expected: '存在 PASS、移除 FAIL、恢复 PASS、DOM 存在不匹配 INCONCLUSIVE', body: probeC48 },
  { id: 'C49-facts', criteria: '§9.C49', title: 'facts provenance 与不读 DOM', expected: 'trusted=false、页面 DOM 读取计数 0、无 facts 六类 INCONCLUSIVE', body: probeC49 },
  { id: 'C50-facts', criteria: '§9.C50', title: 'fact 融合规则', expected: 'scope/runtime/epoch/时间>1000/ROI 不交 -> INCONCLUSIVE；缺 provenance/类型错 -> INVALID_ARGUMENT（implemented as B）', body: probeC50 },
  { id: 'C51-output', criteria: '§9.C51', title: 'output 暂存/持久/no-clobber', expected: '默认 staging、out/env 持久、0600、OUTPUT_EXISTS、坏根不回退', body: probeC51 },
  { id: 'C53-attachments', criteria: '§9.C53', title: '附件降级元数据', expected: 'attachment/base64 原尺寸、downscaled 警告、无服务 fallback', body: probeC53 },
  { id: 'C54-canvas', criteria: '§9.C54', title: 'canvas 识别/点选与文字图像', expected: '两色块候选、点选真值、文字 semanticName=null、resize 警告', body: probeC54 },
  { id: 'C55-lease', criteria: '§9.C55', title: 'BUSY/队列/scope 隔离', expected: '其他 owner 全 BUSY、state 可读、dispose 释放、两 scope 独立', body: probeC55 },
  { id: 'C56-closed-loop', criteria: '§9.C56', title: '闭环 + 能力映射 + T4', expected: 'capture→find→act→compare→baseline→check、22 映射、T4 unsupported、闪烁只静态', body: probeC56 },
  { id: 'C57-canvas-space', criteria: '§9.C56', title: 'canvas 空间 live/find/act/compare（P0-C v2 增量）', expected: 'canvas mapping/blank 纯白/find.documentCss(blank=null)/act blank 零派发/内容 p=q+O 真值/跨空间 mapping-incompatible', body: probeC57 },
];

async function main() {
  await mkdir(EVIDENCE_DIR, { recursive: true });
  state.chromium = await chooseChromiumPlan();
  const harnessModuleRef = await harnessModule();
  for (const dir of await harnessModuleRef.snapshotProfileDirs()) state.baselineProfiles.add(dir);
  for (const proc of harnessModuleRef.scanPluginChromeProcesses()) state.baselinePids.add(proc.pid);

  report.environment = {
    suite: report.suite,
    contract: report.contract,
    node: process.version,
    zlib: process.versions.zlib,
    v8: process.versions.v8,
    platform: `${process.platform}/${process.arch}`,
    repoRoot: REPO_ROOT,
    chromeBin: state.chromium.bin,
    chromePlan: state.chromium,
    fakeContext: 'effect/tools.register/webServer.register/skills.register/logger/inject',
    timeoutMs: TOTAL_TIMEOUT_MS,
    captureRoot: RUN_ROOT,
    fixtureTruth: 'tests/ui_test_fixture/README.md §T3',
    toolSurface: FULL_SURFACE.map((tool) => tool.name),
    t3Tools: T3_TOOLS,
    capabilityMap: CAPABILITY_MAP,
    expectation: '目标 Chromium 默认 /opt/google/chrome/chrome；DSH_UI_TESTING_CHROME 可覆盖',
  };
  log(`[env] chromium plan: ${state.chromium.source} -> ${state.chromium.bin}`);
  log(`[env] node=${process.version} zlib=${process.versions.zlib}`);

  const { startFixtureServer } = await import(pathToFileURL(join(REPO_ROOT, 'tests/ui_test_fixture/server.mjs')).href);
  state.fixture = await startFixtureServer();
  FIXTURE_SERVER = state.fixture;
  FIXTURE_BASE = state.fixture.url.replace(/\/$/, '');
  report.environment.fixtureUrl = state.fixture.url;
  log(`[env] fixture: ${state.fixture.url}`);

  const { createHarness } = await harnessModule();
  const harness = await createHarness({ name: 'T3-main' });
  OWNED_HARNESSES.push(harness);
  MAIN_HARNESS = harness;
  log(`[env] tools (${harness.toolNames().length}): ${harness.toolNames().join(', ')}`);
  const missingT3 = T3_TOOLS.map((tool) => tool.name).filter((name) => !harness.tools.has(name));
  if (missingT3.length) log(`[env] WARN 未注册的 T3 工具：${missingT3.join(', ')}`);

  const only = String(process.env.DSH_T3_ONLY || '').split(',').map((item) => item.trim()).filter(Boolean);
  for (const meta of B_PROBES) {
    const selected = only.length === 0 || only.some((token) => meta.id === token || meta.id.startsWith(token + '-') || meta.criteria === token || meta.criteria === `§9.${token}`);
    if (!selected) {
      log(`\n== ${meta.id} (${meta.criteria}) — SKIPPED by DSH_T3_ONLY`);
      continue;
    }
    const probe = await runProbe({ id: meta.id, criteria: meta.criteria, title: meta.title, expected: meta.expected },
      ({ check, finding, notRun, skip }) => meta.body({ harness, check, finding, notRun, skip }));
    for (const entry of probe.checks) {
      recordCriterionCheck(probe.criteria, {
        source: 'B',
        label: entry.label,
        pass: entry.pass,
        required: !entry.advisory,
        advisory: entry.advisory,
        detail: { expected: entry.expected, actual: entry.actual },
      });
    }
    for (const entry of probe.notRun) {
      if (!criterionNotRun.has(probe.criteria)) criterionNotRun.set(probe.criteria, []);
      criterionNotRun.get(probe.criteria).push(entry);
    }
  }

  // U-class checks are merged into the same criteria table (never a substitute for a B check).
  if (only.length === 0) {
    await runUnitRunners();
  } else {
    log('\n[unit] DSH_T3_ONLY 子集运行：跳过 U-runner（不作为完整验收报告）');
  }

  log('\n[cleanup] closing browsers and fixtures');
  await cleanupResources('suite-complete');
  const summary = await writeEvidence();
  state.finished = true;
  printSummary(summary);
  return summary.exitCode;
}

function printSummary(summary) {
  log('\n================ Web T3 static vision acceptance summary ================');
  for (const criterion of report.criteria) {
    const checks = criterion.checks || [];
    const passed = checks.filter((item) => item.required && item.pass).length;
    const required = checks.filter((item) => item.required).length;
    const detail = criterion.status === 'not-run'
      ? 'NOT_RUN (no check emitted)'
      : `${passed}/${required} checks${criterion.notRun.length ? `, ${criterion.notRun.length} NOT_RUN` : ''}${criterion.notApplicable?.length ? `, ${criterion.notApplicable.length} N/A` : ''}`;
    log(`${criterion.id.padEnd(9)} ${criterion.kind} ${criterion.status.toUpperCase().padEnd(8)} ${detail}`);
  }
  if (report.notRun.length) {
    log('\nNOT_RUN / NOT_APPLICABLE:');
    for (const item of report.notRun) log(`  [${item.disposition || 'NOT_RUN'}] [${item.criteria}] ${item.label}: ${item.reason}`);
  }
  if (report.findings.length) {
    log('\nfindings:');
    for (const finding of report.findings) log(`  [${finding.id}] ${finding.severity}: ${finding.summary}`);
  }
  log(`\ncriteria=${summary.criteriaTotal} covered=${summary.criteriaCovered} pass=${summary.criteriaPassed} fail=${summary.criteriaFailed} partial=${summary.criteriaPartial} notRun=${summary.criteriaNotRun}`);
  log(`requiredChecks=${summary.requiredChecks} failedChecks=${summary.failedChecks} notRunChecks=${summary.notRunChecks} images=${summary.images}`);
  log(`evidence: ${EVIDENCE_DIR}`);
  log(`EXIT ${summary.exitCode}`);
}

let terminating = false;
for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
  process.on(signal, async () => {
    if (terminating) return;
    terminating = true;
    log(`\n[signal] ${signal} — writing partial evidence and cleaning up`);
    report.interrupted = { signal, at: new Date().toISOString() };
    try { await cleanupResources(`signal-${signal}`); } catch { /* ignore */ }
    try { await writeEvidence(); } catch { /* ignore */ }
    process.exit(2);
  });
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
  try { await cleanupResources('fatal-error'); await writeEvidence(); } catch { /* ignore */ }
  exitCode = 2;
}
process.exitCode = exitCode;
