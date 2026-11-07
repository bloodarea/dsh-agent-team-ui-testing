#!/usr/bin/env node
/**
 * Isolated-DSH acceptance runner — the only evidence channel accepted by this audit.
 *
 * Boots a *private* DSH instance (temp `DSH_HOME`, the real `web` profile copied, random loopback
 * port, never 3080/3081), drives real Agent turns through the Host's HTTP Remote RPC, and judges
 * the evidence from the session event log: which `browser_*` tools the model actually called, and
 * whether each call returned `ok:true` with an `actionId`.
 *
 * It never imports plugin internals and never uses the fake-Cordis harness: the plugin is mounted by
 * the Host, the tools are dispatched by the Host, and the results are the Host's own tool results.
 *
 * Usage:
 *   node tests/acceptance/audit-isolated-agent.mjs --group g1 \
 *     --prompt tests/acceptance/evidence/audit-prompts/g1-t1-t2.txt \
 *     --expect-tools browser_capabilities,browser_navigate,browser_snapshot \
 *     [--allow-test-env] [--config-plan <json>] [--turns 1] [--keep]
 *
 * Prompt files may use {{FIXTURE_URL}}, {{STAMP}}, {{EVIDENCE_DIR}}.
 *
 * Evidence: tests/acceptance/runs/audit-<group>-<stamp>/report.json, run.log, raw/turn-<n>.json
 * Exit codes: 0 all required checks passed, 1 a check failed, 2 BLOCKED (could not run).
 */
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { zstdDecompressSync } from 'node:zlib';

const HERE = dirname(fileURLToPath(import.meta.url));
const STAMP = new Date().toISOString().replace(/[:.]/g, '-');
const REAL_PROFILE = join(process.env.HOME || '', '.dsh', 'profiles', 'web');
const DSH_BIN = process.env.DSH_BIN || 'dsh';
const PROVIDER = process.env.AUDIT_PROVIDER || 'deepseek-official';
const MODEL = process.env.AUDIT_MODEL || 'deepseek-flash';

const argv = process.argv.slice(2);
const flag = (name) => argv.includes(name);
const opt = (name, fallback = null) => {
  const index = argv.indexOf(name);
  return index >= 0 && argv[index + 1] ? argv[index + 1] : fallback;
};

const GROUP = opt('--group', 'adhoc');
const RUN_DIR = resolve(opt('--out', join(HERE, 'runs', `audit-${GROUP}-${STAMP}-${process.pid}`)));
const ALLOW_TEST_ENV = flag('--allow-test-env');
const KEEP = flag('--keep');
const PROMPTS = argv.map((value, index) => (argv[index - 1] === '--prompt' ? value : null)).filter(Boolean);
const EXPECT_TOOLS = (opt('--expect-tools', '') || '').split(',').map((name) => name.trim()).filter(Boolean);
const CONFIG_PLAN = opt('--config-plan', null);
/** Expected failures: `--expect-error browser_click:REF_STALE` (repeatable). */
const EXPECTED_ERRORS = argv
  .map((value, index) => (argv[index - 1] === '--expect-error' ? value : null))
  .filter(Boolean)
  .map((pair) => {
    const [tool, code] = pair.split(':');
    return { tool, code };
  });
const RETRIES = Number(opt('--retries', '2')) || 0;
const SINGLE_SESSION = flag('--single-session');
let sharedSessionId = null;

const logLines = [];
const checks = [];
const notRuns = [];
const observations = {};

const redact = (text) => String(text)
  .replace(/([?&]token=)\S+/gi, '$1[redacted]')
  .replace(/\{\{[A-Za-z0-9_]+\}\}/g, '[secret]')
  .replace(/[0-9a-f]{32,}/gi, '[hex]');

function log(line = '') {
  const text = redact(line);
  logLines.push(text);
  console.log(text);
}
function check(label, pass, expected, actual) {
  checks.push({ label, pass: Boolean(pass), expected, actual });
  log(`${pass ? 'PASS' : 'FAIL'} ${label}`);
  if (!pass) log('  expected=' + JSON.stringify(expected) + ' actual=' + JSON.stringify(actual));
  return Boolean(pass);
}
function notRun(label, reason) {
  notRuns.push({ label, reason: String(reason) });
  log(`NOT_RUN ${label} — ${reason}`);
}
const sleep = (ms) => new Promise((done) => setTimeout(done, ms));
async function waitFor(fn, { timeoutMs = 30000, intervalMs = 200, label = 'condition' } = {}) {
  const started = Date.now();
  for (;;) {
    let value; try { value = await fn(); } catch { value = undefined; }
    if (value) return value;
    if (Date.now() - started > timeoutMs) throw new Error(`timeout: ${label}`);
    await sleep(intervalMs);
  }
}
async function pickPort() {
  for (let attempt = 0; attempt < 40; attempt += 1) {
    const port = await new Promise((done, fail) => {
      const server = createServer();
      server.once('error', fail);
      server.listen(0, '127.0.0.1', () => { const assigned = server.address().port; server.close(() => done(assigned)); });
    });
    if (port !== 3080 && port !== 3081) return port;
  }
  throw new Error('no non-3080/3081 loopback port available');
}

/* ----------------------------------------------------------------- isolated Host lifecycle ----- */
async function prepareHome() {
  const home = await mkdtemp(join(tmpdir(), 'audit-iso-home-'));
  const profileDir = join(home, 'profiles', 'web');
  await mkdir(profileDir, { recursive: true });
  await mkdir(join(home, 'ws'), { recursive: true });
  const copied = [];
  for (const name of ['package.json', 'cordis.patch.yml', 'cordis.yml', 'compatibility.json']) {
    const source = join(REAL_PROFILE, name);
    if (!existsSync(source)) continue;
    await writeFile(join(profileDir, name), await readFile(source));
    copied.push(name);
  }
  await symlink(join(REAL_PROFILE, 'node_modules'), join(profileDir, 'node_modules'), 'dir');
  const shared = join(process.env.HOME || '', '.dsh', 'profiles', 'node_modules');
  if (existsSync(shared)) await symlink(shared, join(home, 'profiles', 'node_modules'), 'dir');
  return { home, profileDir, copied };
}

async function boot(home, extraArgs = []) {
  const port = await pickPort();
  const proc = spawn(DSH_BIN, ['--profile', 'web', ...extraArgs, '--port', String(port), '--no-open'], {
    cwd: join(home, 'ws'),
    env: {
      ...process.env,
      DSH_HOME: home,
      ...(ALLOW_TEST_ENV ? { DSH_UI_TESTING_ALLOW_TEST_ENV: '1' } : {}),
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '';
  proc.stdout.on('data', (chunk) => { output += String(chunk); });
  proc.stderr.on('data', (chunk) => { output += String(chunk); });
  const pattern = new RegExp(`dsh web: (http://127\\.0\\.0\\.1:${port}/\\?token=(\\S+))`);
  let matched;
  try {
    matched = await waitFor(() => pattern.exec(output), { timeoutMs: 180000, intervalMs: 300, label: 'isolated dsh launch url' });
  } catch (error) {
    throw new Error(`${error.message}; last output: ${output.slice(-600)}`);
  }
  const launchUrl = matched[1];
  const auth = await fetch(launchUrl, { redirect: 'manual' });
  const cookie = auth.headers.getSetCookie().map((value) => value.split(';')[0]).join('; ');
  if (!cookie) throw new Error('launch URL did not issue a cookie');
  await waitFor(async () => {
    try { const response = await fetch(`http://127.0.0.1:${port}/`, { signal: AbortSignal.timeout(3000) }); return response.status < 500; } catch { return false; }
  }, { timeoutMs: 90000, intervalMs: 500, label: 'http listener' });
  return { proc, home, port, base: `http://127.0.0.1:${port}`, cookie, output: () => output };
}

function makeRpc(state) {
  return async function rpc(method, request) {
    const rpcId = randomUUID();
    const response = await fetch(`${state.base}/api/${method}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', Cookie: state.cookie },
      body: JSON.stringify({ type: 'client-request', rpcId, method, payload: { args: { request } } }),
    });
    const text = await response.text();
    let envelope;
    try { envelope = JSON.parse(text); } catch { return { ok: false, error: { code: 'BAD_ENVELOPE', message: text.slice(0, 200) } }; }
    if (!envelope?.result?.ok) return { ok: false, error: envelope?.result?.error ?? { code: 'UNKNOWN' } };
    return { ok: true, value: envelope.result.value };
  };
}

async function pluginHttp(state, path, { method = 'GET', body } = {}) {
  const response = await fetch(`${state.base}/plugins/ui-testing${path}`, {
    method,
    headers: { Cookie: state.cookie, ...(body ? { 'content-type': 'application/json' } : {}) },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const text = await response.text();
  let value = null;
  try { value = JSON.parse(text); } catch { value = text.slice(0, 300); }
  return { status: response.status, value };
}

/* ----------------------------------------------------------------- session events --------------- */
function sessionDirs(home) {
  const root = join(home, 'sessions');
  if (!existsSync(root)) return [];
  const out = [];
  for (const slug of readdirSync(root)) {
    const dir = join(root, slug);
    if (!existsSync(dir)) continue;
    for (const session of readdirSync(dir)) out.push({ sessionId: session, file: join(dir, session, 'session.v4.jsonl.zstd') });
  }
  return out;
}
function readEvents(file) {
  if (!existsSync(file)) return [];
  return zstdDecompressSync(readFileSync(file)).toString('utf8').trim().split('\n').filter(Boolean)
    .map((line) => { try { return JSON.parse(line); } catch { return null; } }).filter(Boolean);
}
function toolCalls(events) {
  const calls = new Map();
  for (const event of events) {
    if (event.type === 'tool/call') calls.set(event.data.callId, { callId: event.data.callId, name: event.data.name, args: event.data.arguments, step: event.data.step });
    if (event.type === 'tool/result') {
      const callId = event.data?.message?.toolCallId ?? event.data?.toolCallId ?? null;
      const entry = calls.get(callId) || { callId, name: 'unknown' };
      const parts = event.data?.message?.content ?? [];
      const text = parts.map((part) => (typeof part === 'string' ? part : (part?.text ?? ''))).join('\n');
      entry.partKinds = parts.map((part) => (typeof part === 'string' ? 'text' : (part?.type ?? 'unknown')));
      let parsed = null;
      try { parsed = JSON.parse(text); } catch { parsed = null; }
      entry.resultText = String(text);
      entry.ok = parsed ? parsed.ok !== false && !parsed.error : !/^Error:/.test(String(text).trim());
      entry.actionId = parsed?.actionId ?? (/"actionId":"([0-9a-f-]{36})"/.exec(String(text))?.[1] ?? null);
      entry.errorCode = parsed?.error?.code ?? (parsed?.code ?? null);
      entry.parsed = parsed;
      calls.set(entry.callId, entry);
    }
  }
  return [...calls.values()];
}
/** Compact, human-readable signal per tool call — avoids re-serializing megabyte payloads. */
function callSignal(call) {
  let parsed = null;
  const cleanText = String(call.resultText || '').replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, ' ');
  try { parsed = JSON.parse(cleanText); } catch { parsed = null; }
  if (!parsed || typeof parsed !== 'object') return { nonJson: cleanText.slice(0, 300), parseError: 'strict-JSON-parse-failed', length: cleanText.length };
  if (call.name === 'browser_capabilities') {
    const readiness = parsed.adapter?.readiness?.environments?.find((entry) => entry.id === (parsed.adapter?.environment || 'web'));
    return {
      environment: parsed.adapter?.environment ?? null,
      adapterId: parsed.adapter?.adapterId ?? null,
      configRevision: parsed.adapter?.configRevision ?? null,
      axes: readiness?.axes ?? null,
      p0: parsed.adapter?.p0 ?? null,
      toolCapabilities: (parsed.adapter?.capabilities || []).map((entry) => `${entry.id}:${entry.support}/${entry.availability}`),
      dynamicAdapters: parsed.dynamic?.visual?.adapters ?? null,
    };
  }
  if (call.name === 'browser_state') {
    return {
      running: parsed.runtime?.running ?? parsed.running ?? null,
      transport: parsed.runtime?.transport ?? parsed.transport ?? null,
      url: parsed.url ?? null,
      tab: parsed.tab ?? null,
      scope: parsed.runtime?.scope ?? parsed.scope ?? null,
    };
  }
  const clone = { ...parsed };
  for (const key of ['dom', 'tree', 'frames', 'capabilities', 'snapshot', 'body', 'evidence']) {
    if (clone[key] && JSON.stringify(clone[key]).length > 4000) clone[key] = '<omitted:large>';
  }
  return clone;
}

function requestToolNames(events) {
  const header = events.find((event) => event.type === 'request/header');
  return (header?.data?.header?.tools || []).map((tool) => tool.name);
}

/* ----------------------------------------------------------------- turn driving ---------------- */
const seenEvents = new Map();
async function runTurn(state, rpc, promptText, existingSessionId = null) {
  let sessionId = existingSessionId;
  let selected = { ok: true, value: { reused: true } };
  if (!sessionId) {
    const created = await rpc('session/create', { cwd: join(state.home, 'ws') });
    if (!created.ok) throw new Error('session/create failed: ' + JSON.stringify(created.error).slice(0, 200));
    sessionId = created.value.sessionId;
    selected = await rpc('session/selectModel', { sessionId, provider: PROVIDER, model: MODEL });
  }
  const prompted = await rpc('session/prompt', {
    requestId: randomUUID(), sessionId, mode: 'queue',
    content: [{ type: 'text', text: promptText }], clientTimeZone: 'Asia/Shanghai',
  });
  if (!prompted.ok) throw new Error('session/prompt failed: ' + JSON.stringify(prompted.error).slice(0, 400));
  let reason = null;
  for (let index = 0; index < 40; index += 1) {
    const waited = await rpc('session/wait', { sessionId, timeoutMs: 15000, maxMessages: 400 });
    reason = waited.value?.reason ?? null;
    if (reason === 'idle') break;
  }
  const entry = sessionDirs(state.home).find((candidate) => candidate.sessionId === sessionId);
  const allEvents = entry ? readEvents(entry.file) : [];
  const offset = seenEvents.get(sessionId) ?? 0;
  const events = allEvents.slice(offset);
  seenEvents.set(sessionId, allEvents.length);
  return {
    sessionId,
    reason,
    selected: selected.ok ? selected.value : selected.error,
    eventsFile: entry?.file ?? null,
    events,
    calls: toolCalls(events),
    requestTools: requestToolNames(events),
  };
}

/* ----------------------------------------------------------------- config plan ------------------ */
async function applyConfigPlan(state, plan) {
  let revision = (await pluginHttp(state, '/config')).value?.revision ?? null;
  const applied = [];
  for (const step of plan) {
    let result;
    if (step.op === 'put') {
      result = await pluginHttp(state, '/config', { method: 'PUT', body: { scope: step.scope || 'global', expectedRevision: revision, patch: step.patch } });
    } else if (step.op === 'select') {
      result = await pluginHttp(state, '/config/select', { method: 'POST', body: { expectedRevision: revision, scope: step.scope || 'global', environment: step.environment } });
    } else if (step.op === 'get') {
      result = await pluginHttp(state, '/config');
    } else {
      throw new Error('unknown config op: ' + step.op);
    }
    if (typeof result.value?.revision === 'number') revision = result.value.revision;
    applied.push({ step, status: result.status, revision: result.value?.revision ?? null, resolved: result.value?.resolved ?? null, error: result.value?.error ?? null });
    log(`[config] ${step.op} status=${result.status} revision=${result.value?.revision ?? 'n/a'} ${result.value?.error ? 'error=' + JSON.stringify(result.value.error).slice(0, 160) : ''}`);
  }
  return applied;
}

/* ----------------------------------------------------------------- main ------------------------- */
async function main() {
  await mkdir(RUN_DIR, { recursive: true });
  await mkdir(join(RUN_DIR, 'raw'), { recursive: true });
  if (!PROMPTS.length) throw new Error('at least one --prompt <file> is required');
  const reuseHome = opt('--reuse-home', null);
  let home;
  let copied = [];
  let ownsHome = true;
  if (reuseHome) {
    home = resolve(reuseHome);
    ownsHome = false;
    copied = ['<reused>'];
    log(`[env] reusing isolated DSH_HOME=${home} (restart-persistence probe)`);
  } else {
    ({ home, copied } = await prepareHome());
  }
  log(`[env] isolated DSH_HOME=<temp> profile=web files=${copied.join(',')} allowTestEnv=${ALLOW_TEST_ENV} never 3080/3081`);
  observations.isolation = { dshHome: home, profile: 'web', profileFiles: copied, allowTestEnv: ALLOW_TEST_ENV };

  const { startFixtureServer } = await import('../ui_test_fixture/server.mjs');
  const fixture = await startFixtureServer();
  log(`[fixture] ${fixture.url}`);

  const state = await boot(home);
  log(`[dsh] isolated instance up on ${state.base} (port ${state.port})`);
  observations.isolation.port = state.port;
  const rpc = makeRpc(state);
  const turns = [];

  try {
    const config = await pluginHttp(state, '/config');
    check('插件在隔离实例中挂载（GET /plugins/ui-testing/config 200）', config.status === 200, 200, config.status);
    observations.configInitial = { revision: config.value?.revision, environment: config.value?.config?.global?.environment };
    if (CONFIG_PLAN) {
      observations.configPlan = await applyConfigPlan(state, JSON.parse(await readFile(resolve(CONFIG_PLAN), 'utf8')));
    }

    for (const [index, promptPath] of PROMPTS.entries()) {
      const template = await readFile(resolve(promptPath), 'utf8');
      const text = template
        .replaceAll('{{FIXTURE_URL}}', fixture.url.replace(/\/$/, ''))
        .replaceAll('{{STAMP}}', STAMP)
        .replaceAll('{{EVIDENCE_DIR}}', RUN_DIR);
      let turn = null;
      for (let attempt = 0; attempt <= RETRIES; attempt += 1) {
        turn = await runTurn(state, rpc, text, SINGLE_SESSION ? sharedSessionId : null);
        if (SINGLE_SESSION && !sharedSessionId) sharedSessionId = turn.sessionId;
        const browserCalls = turn.calls.filter((call) => call.name.startsWith('browser_'));
        const allOk = browserCalls.length > 0 && browserCalls.every((call) => call.ok);
        if (allOk || attempt === RETRIES) break;
        log(`[turn ${index + 1}] attempt ${attempt + 1} incomplete (browser calls=${browserCalls.length}, ok=${browserCalls.filter((c) => c.ok).length}); retrying`);
      }
      turns.push({ prompt: promptPath, ...turn });
      for (const [callIndex, call] of turn.calls.entries()) {
        try {
          JSON.parse(String(call.resultText || ''));
        } catch {
          await writeFile(join(RUN_DIR, 'raw', `rawtext-${index + 1}-${callIndex}-${call.name}.txt`), String(call.resultText || '')).catch(() => {});
        }
      }
      await writeFile(join(RUN_DIR, 'raw', `turn-${index + 1}.json`), JSON.stringify({
        prompt: promptPath,
        sessionId: turn.sessionId,
        waitReason: turn.reason,
        requestTools: turn.requestTools,
        calls: turn.calls.map((call) => ({
          name: call.name, args: call.args, ok: call.ok, actionId: call.actionId, errorCode: call.errorCode,
          signal: callSignal(call),
          resultText: String(call.resultText || '').replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, ' ').slice(0, 20000),
        })),
      }, null, 2));
      const browserCalls = turn.calls.filter((call) => call.name.startsWith('browser_'));
      log(`[turn ${index + 1}] session=${turn.sessionId} wait=${turn.reason} calls=${turn.calls.length} browserCalls=${browserCalls.length} ok=${browserCalls.filter((c) => c.ok).length}`);
      for (const call of turn.calls) log(`   ${call.ok ? 'ok ' : 'ERR'} ${call.name} ${call.errorCode || ''} ${call.actionId || ''}`);
    }

    // Generic checks over all turns.
    const allCalls = turns.flatMap((turn) => turn.calls);
    const browserCalls = allCalls.filter((call) => call.name.startsWith('browser_'));
    check('本轮存在真实 browser_* 工具调用（隔离实例、Host 派发）', browserCalls.length > 0, '>0', browserCalls.length);
    const isExpectedError = (call) => EXPECTED_ERRORS.some((rule) =>
      rule.tool === call.name
      && (!rule.code || rule.code === call.errorCode
        || (call.resultText || '').includes(`[${rule.code}]`)
        // Free-text expectation: e.g. a tool that is no longer registered fails as `unknown tool`.
        || (call.resultText || '').toLowerCase().includes(String(rule.code).toLowerCase())));
    const failedCalls = browserCalls.filter((call) => !call.ok && !isExpectedError(call));
    check('除声明的预期失败外，全部 browser_* 调用返回 ok:true', failedCalls.length === 0, 0,
      failedCalls.map((call) => `${call.name}:${call.errorCode || 'error'}`));
    for (const rule of EXPECTED_ERRORS) {
      const hit = browserCalls.find((call) => call.name === rule.tool
        && (call.errorCode === rule.code || (call.resultText || '').includes(`[${rule.code}]`)
          || (call.resultText || '').toLowerCase().includes(String(rule.code).toLowerCase())));
      check(`预期失败被真实触发：${rule.tool} → ${rule.code}`, Boolean(hit), rule.code, hit ? 'observed' : 'not observed');
    }
    const withoutAction = browserCalls.filter((call) => !call.actionId && !isExpectedError(call));
    check('每个 browser_* 调用都带 actionId（可追溯证据）', withoutAction.length === 0, 0, withoutAction.map((call) => call.name));
    if (EXPECT_TOOLS.length) {
      const seen = new Set(browserCalls.map((call) => call.name));
      const missing = EXPECT_TOOLS.filter((name) => !seen.has(name));
      check(`预期工具全部被真实调用 (${EXPECT_TOOLS.join(',')})`, missing.length === 0, [], missing);
    }
    observations.turns = turns.map((turn) => ({
      prompt: turn.prompt,
      sessionId: turn.sessionId,
      waitReason: turn.reason,
      eventsFile: turn.eventsFile,
      eventCount: turn.events.length,
      requestToolCount: turn.requestTools.length,
      browserCallCount: turn.calls.filter((call) => call.name.startsWith('browser_')).length,
    }));
  } finally {
    try { fixture.close?.(); } catch { /* ignore */ }
    try { state.proc.kill('SIGTERM'); } catch { /* ignore */ }
    await sleep(1200);
    try { state.proc.kill('SIGKILL'); } catch { /* ignore */ }
    if (KEEP) log(`[env] kept isolated home ${home}`);
    else if (ownsHome) await rm(home, { recursive: true, force: true }).catch(() => {});
  }

  const failed = checks.filter((entry) => !entry.pass);
  const report = {
    suite: `audit-isolated-agent/${GROUP}`,
    group: GROUP,
    prompts: PROMPTS,
    checks,
    criteria: { passed: checks.filter((entry) => entry.pass).length, total: checks.length },
    requiredChecks: { passed: checks.filter((entry) => entry.pass).length, total: checks.length },
    failedChecks: failed.length,
    notRunChecks: notRuns.length,
    exitCode: failed.length ? 1 : 0,
    isolation: observations.isolation,
    observations,
    notRun: notRuns,
    ranAt: new Date().toISOString(),
  };
  await writeFile(join(RUN_DIR, 'report.json'), JSON.stringify(report, null, 2));
  await writeFile(join(RUN_DIR, 'run.log'), logLines.join('\n'));
  log(`report: ${join(RUN_DIR, 'report.json')}`);
  process.exit(report.exitCode);
}

main().catch(async (error) => {
  log('FATAL ' + ((error && error.stack) || String(error)));
  await mkdir(RUN_DIR, { recursive: true }).catch(() => {});
  await writeFile(join(RUN_DIR, 'run.log'), logLines.join('\n')).catch(() => {});
  await writeFile(join(RUN_DIR, 'report.json'), JSON.stringify({
    suite: `audit-isolated-agent/${GROUP}`, group: GROUP, checks,
    criteria: { passed: 0, total: checks.length }, failedChecks: 0, notRunChecks: notRuns.length + 1,
    exitCode: 2, blocked: String((error && error.message) || error), notRun: notRuns,
  }, null, 2)).catch(() => {});
  process.exit(2);
});
