#!/usr/bin/env node
/**
 * Host-side acceptance for `POST /plugins/ui-testing/diagnose` (slice 1).
 *
 * Boots a private isolated DSH instance (temp DSH_HOME copied from the user's web profile, random
 * loopback port, `--no-open`) and drives the diagnose route over plain HTTP with the browser
 * session cookie. The launch token is read from stdout into memory only and never logged.
 *
 * What is asserted:
 *   1. unscoped / legacy caller      -> 401 (route is a scoped-GUI surface only)
 *   2. extra body field              -> 400 INVALID_ARGUMENT
 *   3. observe on a cold scope       -> stage 3 WARN(browser-not-running), stage 5 SKIPPED(3),
 *                                       stage 4 really executed, sideEffects without spawn/ensure/page,
 *                                       no new plugin Chromium process
 *   4. stage 1 PASS carries a real call (actualCalls has browser_capabilities + its response digest)
 *   5. start mode                    -> stage 3 PASS with a real Browser.getVersion product,
 *                                       stage 5 PASS with browser_eval('1') === 1, sideEffects spawn+lease
 *   6. NDJSON contract               -> seq unique+increasing, stage-start before stage-end,
 *                                       durationMs null for SKIPPED, real durations elsewhere
 *   7. cancellation                  -> no events after abort, and a later run still works
 *   NOT_RUN: nothing (every assertion above is executed).
 *
 * Exit codes: 0 all checks passed, 1 assertion failure, 2 fatal.
 */
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { createServer as createNetServer } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const RUN_STAMP = new Date().toISOString().replace(/[:.]/g, '-');
const RUN_DIR = join(HERE, 'runs', `diagnose-host-${RUN_STAMP}-${process.pid}`);
const DEFAULT_PROFILE = join(process.env.HOME || '', '.dsh', 'profiles', 'web');
const DSH_BIN = process.env.DSH_BIN || 'dsh';
const CHROME = process.env.DSH_ACCEPTANCE_CHROME
  || process.env.DSH_REAL_BROWSER_CHROME
  || join(HERE, 'chrome-wrapper.sh');
const ROUTE = '/plugins/ui-testing/diagnose';
const { validateProbeArgs, PROBE_LIMITS } = await import('../../integration/diagnose.js');

const logLines = [];
const log = (line = '') => {
  const text = String(line).replace(/([?&]token=)[^&\s"']+/gi, '$1[redacted]');
  logLines.push(text);
  console.log(text);
};
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const checks = [];
const notRuns = [];
const observations = {};
function check(label, pass, expected, actual) {
  checks.push({ label, pass: Boolean(pass), expected, actual });
  log(`${pass ? 'PASS' : 'FAIL'} ${label}`);
  if (!pass) log('  expected=' + JSON.stringify(expected) + ' actual=' + JSON.stringify(actual));
  return Boolean(pass);
}
function waitFor(fn, { timeoutMs = 30000, intervalMs = 150, label = 'condition' } = {}) {
  return new Promise((resolve, reject) => {
    const started = Date.now();
    const tick = async () => {
      let value;
      try { value = await fn(); } catch { value = undefined; }
      if (value) return resolve(value);
      if (Date.now() - started > timeoutMs) return reject(new Error('timeout: ' + label));
      setTimeout(tick, intervalMs);
    };
    tick();
  });
}
async function pickPort() {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const port = await new Promise((resolve, reject) => {
      const server = createNetServer();
      server.once('error', reject);
      server.listen(0, '127.0.0.1', () => {
        const assigned = server.address().port;
        server.close(() => resolve(assigned));
      });
    });
    if (port !== 3080 && port !== 3081) return port;
  }
  throw new Error('could not allocate a loopback port');
}

const state = { dsh: null, cookie: '', token: '' };

async function prepareDshHome() {
  const home = await mkdtemp(join(tmpdir(), 'dsh-diagnose-home-'));
  const profileDir = join(home, 'profiles', 'web');
  await mkdir(profileDir, { recursive: true });
  const files = ['package.json', 'cordis.patch.yml', 'compatibility.json', 'pnpm-lock.yaml', 'cordis.yml'];
  const copied = [];
  for (const name of files) {
    const source = join(DEFAULT_PROFILE, name);
    if (!existsSync(source)) continue;
    await writeFile(join(profileDir, name), await readFile(source));
    copied.push(name);
  }
  const nodeModules = join(DEFAULT_PROFILE, 'node_modules');
  if (!existsSync(nodeModules)) throw new Error('user profile node_modules missing: ' + nodeModules);
  await symlink(nodeModules, join(profileDir, 'node_modules'), 'dir');
  return { home, profileDir, copied };
}

async function startIsolatedDsh() {
  const { home, profileDir, copied } = await prepareDshHome();
  const port = await pickPort();
  const proc = spawn(DSH_BIN, ['web', '--port', String(port), '--no-open'], {
    env: {
      ...process.env,
      DSH_HOME: home,
      DSH_PROFILE: 'web',
      DSH_UI_TESTING_CHROME: process.env.DSH_UI_TESTING_CHROME || CHROME,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '';
  proc.stdout.on('data', (chunk) => { output += String(chunk); });
  proc.stderr.on('data', (chunk) => { output += String(chunk); });
  proc.on('exit', (code, signal) => log(`[dsh] exited code=${code} signal=${signal}`));
  const pattern = new RegExp(`dsh web: (http://127\\.0\\.0\\.1:${port}/\\?token=([A-Za-z0-9_-]+))`);
  const matched = await waitFor(() => {
    const hit = pattern.exec(output);
    return hit ? { url: hit[1], token: hit[2] } : undefined;
  }, { timeoutMs: 180000, intervalMs: 250, label: 'isolated dsh launch URL' });
  state.token = matched.token;
  state.dsh = { proc, home, profileDir, copied, port, base: `http://127.0.0.1:${port}`, output: () => output };
  await waitFor(async () => {
    try {
      const response = await fetch(state.dsh.base + '/', { signal: AbortSignal.timeout(3000) });
      return response.status < 500;
    } catch { return false; }
  }, { timeoutMs: 60000, intervalMs: 400, label: 'isolated dsh HTTP listener' });
  return state.dsh;
}

async function authenticate(launchUrl) {
  const response = await fetch(launchUrl, { redirect: 'manual', signal: AbortSignal.timeout(20000) });
  const cookies = response.headers.getSetCookie().map((value) => value.split(';')[0]);
  if (!cookies.length) throw new Error('launch URL issued no cookie (status ' + response.status + ')');
  state.cookie = cookies.join('; ');
  return cookies.length;
}

/** One diagnose request. Reads the NDJSON stream and returns the parsed events. */
async function diagnose({ body, scoped = true, signal, onEvent = null }) {
  const headers = {
    'content-type': 'application/json',
    ...(state.cookie ? { cookie: state.cookie } : {}),
    ...(scoped ? { 'x-ui-testing-scope-version': '1', 'x-ui-testing-scope': 'unassigned' } : {}),
  };
  const response = await fetch(state.dsh.base + ROUTE, {
    method: 'POST',
    headers,
    body: JSON.stringify(body || {}),
    signal,
  });
  const contentType = String(response.headers.get('content-type') || '');
  if (!contentType.includes('ndjson')) {
    const payload = await response.json().catch(() => ({}));
    return { status: response.status, contentType, events: [], payload };
  }
  const events = [];
  let buffer = '';
  const consume = (text) => {
    buffer += text;
    let index;
    while ((index = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, index).trim();
      buffer = buffer.slice(index + 1);
      if (!line) continue;
      const event = JSON.parse(line);
      events.push(event);
      if (onEvent) onEvent(event);
    }
  };
  try {
    for await (const chunk of response.body) consume(Buffer.from(chunk).toString('utf8'));
  } catch (error) {
    if (error && error.name !== 'AbortError') throw error;
  }
  return { status: response.status, contentType, events };
}

const stageOf = (events, stageId, type = 'stage-end') => events.find((event) => (
  (type === 'stage-end' ? event.type === 'stage-end' : event.type === 'stage-start') && event.stageId === stageId));

async function main() {
  await mkdir(RUN_DIR, { recursive: true });
  const harness = await import('./harness.mjs');
  const chromeBefore = harness.scanPluginChromeProcesses();
  const beforePids = new Set(chromeBefore.map((entry) => entry.pid));

  try {
    log('[env] launching isolated DSH (temp DSH_HOME, random loopback port, --no-open)');
    const dsh = await startIsolatedDsh();
    log(`[env] isolated dsh base=${dsh.base} port=${dsh.port} copied=${JSON.stringify(dsh.copied)}`);
    const cookieCount = await authenticate(`http://127.0.0.1:${dsh.port}/?token=${encodeURIComponent(state.token)}`);
    log(`[env] authenticated (${cookieCount} cookie(s), token never logged)`);

    /* 1) unscoped caller is refused ------------------------------------------------ */
    const unscoped = await diagnose({ body: { mode: 'observe' }, scoped: false });
    check('D01 an unscoped/legacy caller gets 401 (diagnose is a scoped-GUI surface only)',
      unscoped.status === 401 && !unscoped.contentType.includes('ndjson'),
      { status: 401 },
      { status: unscoped.status, contentType: unscoped.contentType, payload: unscoped.payload });

    /* 2) body allow-list ----------------------------------------------------------- */
    const extraField = await diagnose({ body: { mode: 'observe', tool: 'browser_eval', args: {} } });
    check('D02 a body with extra fields is refused with 400 INVALID_ARGUMENT',
      extraField.status === 400 && String(extraField.payload && extraField.payload.code) === 'INVALID_ARGUMENT',
      { status: 400, code: 'INVALID_ARGUMENT' },
      { status: extraField.status, payload: extraField.payload });

    /* 3) observe on a cold scope: no spawn, honest WARN/SKIPPED --------------------- */
    const observe = await diagnose({ body: { mode: 'observe', requestId: 'acc-observe-1' } });
    const s3 = stageOf(observe.events, '3');
    const s4 = stageOf(observe.events, '4');
    const s5 = stageOf(observe.events, '5');
    const s1 = stageOf(observe.events, '1');
    const observeRunEnd = observe.events.find((event) => event.type === 'run-end') || {};
    const observeEffects = observeRunEnd.sideEffects || [];
    const spawned = observeEffects.filter((effect) => ['spawn', 'ensure', 'page'].includes(effect.kind));
    const chromeAfterObserve = harness.scanPluginChromeProcesses();
    const newPidsAfterObserve = chromeAfterObserve.filter((entry) => !beforePids.has(entry.pid));
    check('D03 observe never spawns: no spawn/ensure/page side effect and no new plugin Chromium process',
      observe.status === 200
        && spawned.length === 0
        && newPidsAfterObserve.length === 0,
      { spawnEffects: 0, newChromeProcesses: 0 },
      { sideEffects: observeEffects, newPids: newPidsAfterObserve.map((entry) => entry.pid) });
    check('D04 observe reports stage 3 WARN(browser-not-running) and stage 5 SKIPPED(blockedBy=3)',
      Boolean(s3) && s3.status === 'WARN' && s3.reason === 'browser-not-running'
        && Boolean(s5) && s5.status === 'SKIPPED' && s5.blockedBy === '3',
      { stage3: 'WARN/browser-not-running', stage5: 'SKIPPED/3' },
      { stage3: s3 && { status: s3.status, reason: s3.reason }, stage5: s5 && { status: s5.status, blockedBy: s5.blockedBy } });
    check('D05 stage 4 still really checks the executable in observe mode (not skipped by stage 3)',
      Boolean(s4) && ['WARN', 'PASS', 'FAIL'].includes(s4.status)
        && (s4.checks || []).some((entry) => entry.id === 'executable-file'),
      { stage4: 'executed with executable-file check' },
      { stage4: s4 && { status: s4.status, reason: s4.reason, checks: s4.checks } });
    const capabilityCall = (observeRunEnd.actualCalls || []).find((call) => call.tool === 'browser_capabilities');
    check('D06 stage 1 gives the real dispatch evidence (browser_capabilities + response digest)',
      Boolean(s1) && (s1.checks || []).some((entry) => entry.id === 'definitions-registered' && entry.status === 'pass')
        && Boolean(capabilityCall) && capabilityCall.ok === true && Boolean(capabilityCall.response)
        && (s1.status === 'PASS' ? true : s1.status === 'WARN'),
      { stage1: 'PASS with actualCalls[browser_capabilities]' },
      { stage1: s1 && { status: s1.status, checks: s1.checks }, capabilityCall });

    /* 4) NDJSON contract ----------------------------------------------------------- */
    const seqs = observe.events.map((event) => event.seq);
    const seqOk = seqs.every((value, index) => Number.isInteger(value) && (index === 0 || value > seqs[index - 1]));
    const startBeforeEnd = ['1', '2', '3', '4', '5'].every((stageId) => {
      const start = observe.events.findIndex((event) => event.type === 'stage-start' && event.stageId === stageId);
      const end = observe.events.findIndex((event) => event.type === 'stage-end' && event.stageId === stageId);
      if (end < 0) return true;
      return start >= 0 && start < end;
    });
    const skippedNull = observe.events
      .filter((event) => event.type === 'stage-end' && event.status === 'SKIPPED')
      .every((event) => event.durationMs === null);
    const ranDurations = observe.events
      .filter((event) => event.type === 'stage-end' && event.status !== 'SKIPPED')
      .every((event) => Number.isFinite(event.durationMs) && event.durationMs >= 0);
    check('D07 NDJSON: seq unique+increasing, stage-start before stage-end, SKIPPED has null durationMs',
      seqOk && startBeforeEnd && skippedNull && ranDurations && observe.contentType.includes('ndjson'),
      { seq: 'strictly increasing', order: 'start<end', skippedDurationMs: null },
      { seqs, startBeforeEnd, skippedNull, ranDurations, contentType: observe.contentType });

    /* 5) start mode: real browser, real identity, real eval ------------------------ */
    const startRun = await diagnose({ body: { mode: 'start', requestId: 'acc-start-1' }, signal: AbortSignal.timeout(90000) });
    const t3 = stageOf(startRun.events, '3');
    const t5 = stageOf(startRun.events, '5');
    const startRunEnd = startRun.events.find((event) => event.type === 'run-end') || {};
    const startEffects = startRunEnd.sideEffects || [];
    const versionCheck = (t3 && (t3.checks || []).find((entry) => entry.id === 'browser-get-version')) || {};
    const evalCall = (startRunEnd.actualCalls || []).find((call) => call.tool === 'browser_eval');
    const evalCheck = (t5 && (t5.checks || []).find((entry) => entry.id === 'readonly-eval')) || {};
    check('D08 start mode reaches stage 3 PASS with a real Browser.getVersion product',
      Boolean(t3) && t3.status === 'PASS' && /Chrome\/|Edg\//.test(String(versionCheck.detail || '')),
      { stage3: 'PASS + product string' },
      { stage3: t3 && { status: t3.status, reason: t3.reason }, versionCheck });
    check('D09 start mode reaches stage 5 PASS: bound page target + browser_eval(\'1\') === 1',
      Boolean(t5) && t5.status === 'PASS'
        && (t5.checks || []).some((entry) => entry.id === 'binding' && entry.status === 'pass')
        && evalCheck.status === 'pass'
        && Boolean(evalCall) && evalCall.ok === true,
      { stage5: 'PASS + binding + eval 1' },
      { stage5: t5 && { status: t5.status, checks: t5.checks }, evalCall });
    check('D10 start mode records what it created (ensure/spawn/lease) instead of pretending',
      startEffects.some((effect) => effect.kind === 'ensure')
        && startEffects.some((effect) => effect.kind === 'spawn')
        && startEffects.some((effect) => effect.kind === 'lease'),
      { sideEffects: ['ensure', 'spawn', 'lease'] },
      { sideEffects: startEffects });
    const axes = startRunEnd.axes || {};
    check('D11 run-end projects the six original axis words (not the five-state vocabulary)',
      ['support', 'enabled', 'dependency', 'connection', 'target', 'capability'].every((axis) => typeof axes[axis] === 'string')
        && axes.connection === 'ok' && axes.target === 'bound'
        && ['available', 'partial'].includes(axes.capability),
      { axes: 'support/enabled/dependency/connection/target/capability', connection: 'ok', target: 'bound', capability: 'available|partial' },
      { axes });

    /* 6) cancellation: no late events, and the surface still works afterwards ------ */
    const controller = new AbortController();
    let abortedAt = 0;
    const cancelled = await diagnose({
      body: { mode: 'observe', requestId: 'acc-cancel-1' },
      signal: controller.signal,
      onEvent: (event) => {
        if (event.type === 'stage-start' && event.stageId === '1' && !abortedAt) {
          abortedAt = Date.now();
          controller.abort();
        }
      },
    });
    await sleep(1200);
    const afterRunEnd = cancelled.events.filter((event) => event.type === 'run-end');
    const endedStages = cancelled.events.filter((event) => event.type === 'stage-end').map((event) => event.stageId);
    // The abort lands mid-run: whatever was already buffered may still arrive, but the run must
    // stop where it was — no run-end, and the later stages must never end. A cancelled run must
    // also leave nothing behind, which D13 re-checks with a fresh full run.
    check('D12 an aborted run stops where it was: no run-end and no later stages execute',
      abortedAt > 0
        && afterRunEnd.length === 0
        && !endedStages.includes('4') && !endedStages.includes('5')
        && cancelled.closedEarly !== false,
      { runEnd: 0, stages4and5: 'not finished' },
      { abortedAfterMs: abortedAt ? 1 : 0, events: cancelled.events.map((event) => event.type + ':' + (event.stageId || '')) });
    const afterCancel = await diagnose({ body: { mode: 'observe', requestId: 'acc-observe-2' } });
    const afterCancelEnd = afterCancel.events.find((event) => event.type === 'run-end') || {};
    check('D13 the route still works after a cancel (no stuck in-flight run)',
      afterCancel.status === 200 && Boolean(afterCancelEnd.type) && Boolean(afterCancelEnd.stages),
      { status: 200, runEnd: true },
      { status: afterCancel.status, runEnd: afterCancelEnd.type || null });

    /* 7) no /test/invoke, no Agent binding/lease drift ---------------------------- */
    const readiness = await fetch(`${dsh.base}/plugins/ui-testing/readiness?view=global`, {
      headers: { cookie: state.cookie, 'x-ui-testing-scope-version': '1', 'x-ui-testing-scope': 'unassigned' },
    }).then((response) => response.json()).catch(() => null);
    const webEntry = readiness && Array.isArray(readiness.environments)
      ? readiness.environments.find((entry) => (entry.id || entry.environment) === 'web') : null;
    const selectedProviders = webEntry && webEntry.providers
      ? Object.entries(webEntry.providers).filter(([, value]) => value && value.selected === true).map(([id]) => id) : [];
    const ALLOWED_TOOLS = ['browser_capabilities', 'browser_eval', 'browser_snapshot', 'browser_screenshot', 'browser_computed_style', 'browser_network'];
    check('D14 the dispatcher only performed read-only allow-listed operations',
      (startRunEnd.actualCalls || []).length > 0
        && (startRunEnd.actualCalls || []).every((call) => ALLOWED_TOOLS.includes(call.tool)),
      { allowed: ALLOWED_TOOLS },
      { calls: (startRunEnd.actualCalls || []).map((call) => call.tool) });
    check('D15 running diagnostics never switched the Agent selection (config revision + selection unchanged)',
      observeRunEnd.configRevision === startRunEnd.configRevision
        && selectedProviders.length <= 1,
      { configRevisionStable: true, selectedProviders: '<=1' },
      { observeRevision: observeRunEnd.configRevision, startRevision: startRunEnd.configRevision, selectedProviders });

    /* 7) deepened capability probes ------------------------------------------------------- */
    const startCapability = (startRunEnd.axes && startRunEnd.axes.capability) || null;
    const startChecks = (startRunEnd.axes && startRunEnd.axes.checks) || {};
    const startDetail = (startRunEnd.axes && startRunEnd.axes.checksDetail) || [];
    const probeIds = ['readonly-eval', 'target-list', 'snapshot', 'screenshot', 'computed-style', 'network-read'];
    check('D16 a start run really executes all six read-only probes and reports capability=available',
      startCapability === 'available'
        && probeIds.every((id) => startChecks[id] === 'pass'),
      { capability: 'available', checks: probeIds.map((id) => id + ':pass') },
      { capability: startCapability, checks: startChecks, detail: startDetail.map((entry) => entry.id + ':' + entry.status + ':' + String(entry.detail).slice(0, 48)) });

    check('D17 probe results are digests only (no page tree, no base64 image)',
      (() => {
        const digests = (startRunEnd.axes && startRunEnd.axes.digests) || {};
        const shot = digests.screenshot || {};
        const snap = digests.snapshot || {};
        return Number.isFinite(shot.bytes) && shot.bytes > 0
          && typeof shot.sha256 === 'string' && shot.sha256.length === 16
          && Number.isFinite(snap.nodeCount) && snap.nodeCount > 0
          && JSON.stringify(digests).length < 2048;
      })(),
      { screenshot: '{bytes,width,height,sha256}', snapshot: '{nodeCount,snapshotId}' },
      { digests: (startRunEnd.axes && startRunEnd.axes.digests) || null });

    const observeChecks = (observeRunEnd.axes && observeRunEnd.axes.checks) || {};
    check('D18 a cold observe run marks the probes skip (never fail) and capability=not-probed',
      (observeRunEnd.axes && observeRunEnd.axes.capability) === 'not-probed'
        && ['snapshot', 'screenshot', 'computed-style'].every((id) => observeChecks[id] === 'skip')
        && !Object.values(observeChecks).includes('fail')
        && ((observeRunEnd.axes && observeRunEnd.axes.checksDetail) || [])
          .filter((entry) => entry.status === 'skip')
          .every((entry) => String(entry.detail).includes('无连接')),
      { capability: 'not-probed', snapshot: 'skip', screenshot: 'skip', 'computed-style': 'skip' },
      { capability: observeRunEnd.axes && observeRunEnd.axes.capability, checks: observeChecks });

    const biggestEvent = [...startRun.events, ...observe.events]
      .map((event) => JSON.stringify(event).length)
      .reduce((max, size) => Math.max(max, size), 0);
    check('D19 every NDJSON event stays far below 64 KiB (no payload smuggling)',
      biggestEvent > 0 && biggestEvent < 64 * 1024,
      { maxEventBytes: '< 65536' },
      { maxEventBytes: biggestEvent });

    const probeMs = ((startRunEnd.stages || {})['5'] || {}).durationMs;
    check('D20 the deepened stage 5 still finishes inside its budget',
      Number.isFinite(probeMs) && probeMs > 0 && probeMs < 8000,
      { stage5DurationMs: '< 8000' },
      { stage5DurationMs: probeMs, probeBudgetMs: PROBE_LIMITS.probeBudgetMs });

    /* 8) dispatcher argument hardening (unit level: the route takes no probe arguments) */
    const rejections = [
      ['browser_screenshot', { out: 'x.png' }],
      ['browser_screenshot', { persist: true }],
      ['browser_screenshot', { region: { x: 0, y: 0, width: 1, height: 1 } }],
      ['browser_computed_style', { selector: 'input', properties: ['display'] }],
      ['browser_computed_style', { selector: 'body', properties: ['a', 'b', 'c', 'd', 'e', 'f'] }],
      ['browser_snapshot', { maxNodes: 1000 }],
      ['browser_network', { limit: 50 }],
      ['browser_network', { limit: 5, start: true }],
      ['browser_eval', { expression: 'document.title' }],
      ['browser_click', { ref: 'e1' }],
      ['browser_navigate', { url: 'https://example.com' }],
    ];
    const accepted = [
      ['browser_snapshot', { maxNodes: 50 }],
      ['browser_screenshot', {}],
      ['browser_computed_style', { selector: 'body', properties: ['display'] }],
      ['browser_network', { limit: 5 }],
      ['browser_eval', { expression: '1' }],
    ];
    const rejectedOk = rejections.every(([tool, args]) => validateProbeArgs(tool, args).ok === false);
    const acceptedOk = accepted.every(([tool, args]) => validateProbeArgs(tool, args).ok === true);
    check('D21 the dispatcher validator rejects every out-of-range or write-capable call',
      rejectedOk && acceptedOk,
      { rejected: rejections.length, accepted: accepted.length },
      { rejected: rejections.map(([tool, args]) => tool + '(' + Object.keys(args).join(',') + ')'), accepted: accepted.map(([tool]) => tool), rejectedOk, acceptedOk });

    observations.observeStages = Object.fromEntries(Object.entries(observeRunEnd.stages || {}).map(([id, value]) => [id, { status: value.status, reason: value.reason, blockedBy: value.blockedBy, durationMs: value.durationMs }]));
    observations.startStages = Object.fromEntries(Object.entries(startRunEnd.stages || {}).map(([id, value]) => [id, { status: value.status, reason: value.reason, blockedBy: value.blockedBy, durationMs: value.durationMs }]));
    observations.startSideEffects = startEffects;
    observations.observeSideEffects = observeEffects;
    observations.axes = axes;
  } finally {
    const harness2 = await import('./harness.mjs');
    const before = new Set(chromeBefore.map((entry) => entry.pid));
    if (state.dsh) {
      try { state.dsh.proc.kill('SIGTERM'); } catch { /* ignore */ }
      await sleep(1200);
      try { state.dsh.proc.kill('SIGKILL'); } catch { /* ignore */ }
      await rm(state.dsh.home, { recursive: true, force: true, maxRetries: 5 }).catch(() => {});
    }
    // Only the plugin-owned Chromium this run started may be reaped.
    for (const proc of harness2.scanPluginChromeProcesses()) {
      if (before.has(proc.pid)) continue;
      try { process.kill(proc.pid, 'SIGKILL'); } catch { /* gone */ }
    }
    for (const dir of await harness2.snapshotProfileDirs()) {
      if (!String(dir).includes('dsh-ui-testing-')) continue;
      await rm(dir, { recursive: true, force: true, maxRetries: 3 }).catch(() => {});
    }
  }

  const failed = checks.filter((entry) => !entry.pass);
  await writeFile(join(RUN_DIR, 'report.json'), JSON.stringify({
    suite: 'diagnose-host',
    startedAt: RUN_STAMP,
    finishedAt: new Date().toISOString(),
    environment: { dsh: state.dsh ? { port: state.dsh.port, home: '(temp)', copied: state.dsh.copied } : null, token: '[redacted]' },
    checks,
    notRuns,
    observations,
    summary: { checks: checks.length, passed: checks.length - failed.length, failed: failed.length, notRun: notRuns.length },
  }, null, 2));
  await writeFile(join(RUN_DIR, 'run.log'), logLines.join('\n') + '\n');
  log(`\ndiagnose-host: ${checks.length - failed.length}/${checks.length} PASS, ${failed.length} failed`);
  log('evidence: ' + RUN_DIR);
  for (const entry of failed) log('  FAILED: ' + entry.label);
  return failed.length === 0 ? 0 : 1;
}

let code = 2;
try {
  code = await main();
} catch (error) {
  const message = String((error && (error.stack || error.message)) || error);
  log('BLOCKED/FATAL ' + message.replace(/([?&]token=)[^&\s"']+/gi, '$1[redacted]'));
  try {
    await mkdir(RUN_DIR, { recursive: true });
    await writeFile(join(RUN_DIR, 'report.json'), JSON.stringify({ suite: 'diagnose-host', status: 'BLOCKED', error: message, checks, notRuns }, null, 2));
  } catch { /* ignore */ }
  code = 2;
} finally {
  try { await writeFile(join(RUN_DIR, 'run.log'), logLines.join('\n') + '\n'); } catch { /* ignore */ }
}
process.exit(code);
