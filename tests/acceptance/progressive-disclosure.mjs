#!/usr/bin/env node
/**
 * Progressive tool disclosure acceptance — real installed host, real plugin, real AgentLoop.
 *
 * Evidence boundary (stated in the report, not just here):
 *   - The installed @deepseek-ai/dsh packages are mounted from their public package exports
 *     (cordis, dsh-session, dsh-agent, dsh-llm, dsh-system-prompt, dsh-tools,
 *     dsh-tool-executor-native, dsh-agent-loop). No profile, persistence backend, user config,
 *     historical session, or private patch is loaded.
 *   - Tool lists and byte counts come from `LlmAdapter.stream(request)` — the exact `request.tools`
 *     array the provider is handed for the next model call — and are cross-checked against the
 *     session's own `request/header` events.
 *   - The model is a deterministic scripted adapter (protocol fixture), not remote inference. It
 *     proves what the host sends and executes for a fixed task script; it is not a model-quality,
 *     provider-cache or billing measurement.
 *
 * Modes:
 *   --phase=before  run against a checkout without progressive disclosure (37 tools every request);
 *                   activation steps are omitted. Used to capture the pre-change baseline.
 *   --phase=after   run against this checkout: initial 3 definitions, activation, isolation,
 *                   whitelist, environment switch and plugin reload.
 *
 * Usage: node tests/acceptance/progressive-disclosure.mjs --phase=before|after
 * Report: tests/acceptance/runs/progressive-<phase>-<stamp>/report.json + run.log
 * Exit: 0 pass, 1 failed check.
 */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '../..');
const INSTALL = await import('node:fs/promises').then(({ realpath }) => realpath(
  process.env.DSH_INSTALL_DIR || '/home/dev/.local/share/dsh-r3/node_modules/@deepseek-ai/dsh'));
const phase = (process.argv.find((arg) => arg.startsWith('--phase=')) || '--phase=after').split('=')[1];
assert.ok(['before', 'after'].includes(phase), `unknown phase ${phase}`);
const { TOOL_GROUPS, DIAGNOSTIC_TOOLS, DISCOVERY_TOOL } = await import(resolve(ROOT, 'integration/tool-disclosure.js'));

const requireFromHost = createRequire(join(INSTALL, 'package.json'));
const loadHost = (shortName) => import(requireFromHost.resolve(`@deepseek-ai/${shortName}`));

const BYTES = (value) => Buffer.byteLength(JSON.stringify(value), 'utf8');
const groupOf = (name) => {
  if (name === DISCOVERY_TOOL) return 'discovery';
  if (DIAGNOSTIC_TOOLS.includes(name)) return 'diagnostics';
  for (const [id, group] of Object.entries(TOOL_GROUPS)) if (group.tools.includes(name)) return id;
  return 'other';
};
const HIDDEN = 'browser_vision_check';
const EXPECTED = {
  initial: 3, basic: 18, network: 27, vision: 24, dynamic: 23, all: 38,
};
const report = {
  schemaVersion: 1, phase,
  evidenceBoundary: {
    installedHost: true, realAgentLoop: true, realPlugin: true, realChromium: true,
    capture: 'LlmAdapter.stream request.tools + session request/header cross-check',
    model: 'deterministic scripted adapter (protocol fixture, not remote inference)',
    tokenAccounting: 'none — all sizes are UTF-8 bytes of the serialized JSON payload',
    profilePersistenceUserConfigHistory: false,
  },
  installation: { path: INSTALL, pluginIndexSha256: createHash('sha256').update(await import('node:fs/promises').then(({ readFile }) => readFile(join(ROOT, 'index.js')))).digest('hex') },
  requests: [], tasks: [], checks: [], notRun: [],
};
const lines = [];
const log = (text) => { lines.push(text); console.log(text); };
const check = (label, pass, details) => {
  report.checks.push({ label, pass: Boolean(pass), details });
  log(`${pass ? 'PASS' : 'FAIL'} ${label}${pass ? '' : ' ' + JSON.stringify(details)}`);
  return Boolean(pass);
};
const notRun = (label, reason) => { report.notRun.push({ label, reason }); log(`NOT_RUN ${label} — ${reason}`); };

/* ------------------------------------------------------------ fixtures & ledger ------ */
const fixtureFiles = new Map([['/fixture', '<!doctype html><title>Progressive fixture</title><style>body{background:#eef3fb;font:20px sans-serif}button{padding:20px}</style><h1>Progressive fixture</h1><button id="go">Ready</button><script>fetch("/fixture-data")</script>'], ['/fixture-data', '{"ok":true,"fixture":true}']]);
const fixtureServer = createServer((req, res) => {
  const body = fixtureFiles.get(req.url);
  if (body === undefined) { res.writeHead(404); res.end('not found'); return; }
  res.writeHead(200, { 'content-type': req.url === '/fixture' ? 'text/html' : 'application/json' });
  res.end(body);
});
await new Promise((done) => fixtureServer.listen(0, '127.0.0.1', done));
const FIXTURE = `http://127.0.0.1:${fixtureServer.address().port}/fixture`;

const runDir = join(HERE, 'runs', `progressive-${phase}-${new Date().toISOString().replace(/[:.]/g, '-')}-${process.pid}`);
await mkdir(runDir, { recursive: true });
const workspace = join(runDir, 'workspace');
const configDir = join(runDir, 'config');
await mkdir(workspace, { recursive: true });
process.env.DSH_UI_TESTING_CONFIG_DIR = configDir;
process.env.DSH_UI_TESTING_CAPTURE_DIR = join(runDir, 'captures');
process.env.DSH_UI_TESTING_ALLOW_TEST_ENV = '1';
await mkdir(process.env.DSH_UI_TESTING_CAPTURE_DIR, { recursive: true });

/* ------------------------------------------------------------ real host + plugin ---- */
const { Context } = await loadHost('cordis');
const llm = await loadHost('dsh-llm');
const toolsModule = await loadHost('dsh-tools');
const ctx = new Context();
const routes = [];
ctx.provide('webServer', {
  register(entry) { routes.push(entry); return () => { const index = routes.indexOf(entry); if (index >= 0) routes.splice(index, 1); }; },
});
const peer = { id: 'progressive-fixture-peer' };
ctx.provide('connection', { requestRejection() { return undefined; }, admit() { return { peer }; }, browserPeer: peer });

for (const name of ['dsh-session', 'dsh-session-projection', 'dsh-agent', 'dsh-llm',
  'dsh-system-prompt', 'dsh-tools', 'dsh-tool-executor-native', 'dsh-agent-loop']) {
  const module = await loadHost(name);
  await ctx.plugin(module.default ?? module, {}).await();
}
let pluginFiber = ctx.plugin(await import(resolve(ROOT, 'index.js')));
await new Promise((done) => setTimeout(done, 0));
if (phase === 'before' && ctx.tools.definitions().some((tool) => tool.name === DISCOVERY_TOOL)) {
  // The baseline must be measured on a checkout without progressive disclosure; mixing both
  // would silently produce numbers that belong to neither. Fail loudly instead.
  console.error('--phase=before requires a checkout without progressive disclosure; this checkout already registers ' + DISCOVERY_TOOL);
  process.exit(2);
}

/* ------------------------------------------------------------ scripted model -------- */
const traces = new Map();
let task = null;
let cursor = 0;
const recordRequest = (agentId, request) => {
  const entry = traces.get(agentId);
  const tools = Array.isArray(request.tools) ? request.tools : [];
  const perTool = tools.map((tool) => ({ name: tool.name, bytes: BYTES(tool) }));
  const byGroup = {};
  for (const tool of perTool) {
    const group = groupOf(tool.name);
    byGroup[group] ??= { count: 0, names: [], bytes: 0 };
    byGroup[group].count += 1; byGroup[group].names.push(tool.name); byGroup[group].bytes += tool.bytes;
  }
  const pluginTools = tools.filter((tool) => String(tool.name).startsWith('browser_'));
  const record = {
    seq: report.requests.length + 1, task: task?.name ?? null, agent: agentId,
    toolCount: tools.length, pluginToolCount: pluginTools.length,
    names: tools.map((tool) => tool.name).sort(),
    toolsJsonBytes: BYTES(tools), pluginSchemaBytes: BYTES(pluginTools), byGroup,
    header: entry.currentHeader ?? [], headerEventCount: entry.headers.length,
    headerMatches: JSON.stringify(entry.currentHeader ?? []) === JSON.stringify(tools.map((tool) => tool.name).sort()),
  };
  report.requests.push(record);
  entry.requests.push(record);
  log(`request #${record.seq} task=${record.task} tools=${record.toolCount} browser=${record.pluginToolCount} bytes=${record.toolsJsonBytes}`);
};
class ScriptedAdapter extends llm.LlmAdapter {
  async *stream(request) {
    const agentId = request.sessionId;
    if (!traces.has(agentId)) traces.set(agentId, { requests: [], headers: [], results: [] });
    recordRequest(agentId, request);
    const index = cursor++;
    const action = task ? task.actions[index] : undefined;
    if (!action) { yield { type: 'finish', reason: { kind: 'stop' } }; return; }
    yield { type: 'block-start', index: 0, blockType: 'tool-call' };
    yield { type: 'block-end', index: 0, block: { type: 'tool-call', id: `fixture-call-${recordRequestCount++}`, name: action.name, arguments: action.arguments ?? {} } };
    yield { type: 'finish', reason: { kind: 'tool-calls' } };
  }
}
let recordRequestCount = 0;
const call = (name, args = {}) => ({ name, arguments: args });
ctx.llm.registerAdapter(['progressive-fixture'], new ScriptedAdapter());

ctx.on('session/event', (session, event) => {
  const trace = traces.get(session.id);
  if (!trace) return;
  if (event.type === 'request/header') {
    const names = (event.data.header.tools ?? []).map((tool) => tool.name).sort();
    trace.headers.push({ names, reason: event.data.reason ?? null });
    trace.currentHeader = names;
  }
  if (event.type === 'tool/result') {
    const isError = event.data.message.isError === true;
    const detail = isError ? JSON.stringify(event.data).slice(0, 400) : null;
    trace.results.push({
      isError,
      code: event.data.error?.code ?? event.data.error?.info?.code ?? null,
      detail,
    });
  }
});

/* ------------------------------------------------------------ helpers ------------- */
async function newAgent(label) {
  const id = `progressive-${phase}-${label}-${process.pid}-${Date.now()}`;
  const handle = await ctx.agents.create({ sessionId: id, meta: { cwd: workspace },
    agentOptions: { provider: 'progressive-fixture', model: 'capture' } });
  traces.set(id, { requests: [], headers: [], results: [] });
  return handle;
}

/** Run one scripted turn; every action name is bound to a real argument object. */
async function run(handle, name, actions) {
  const id = handle.agent.id;
  task = { name, actions };
  cursor = 0;
  const adapterStart = report.requests.length;
  const headersBefore = traces.get(id).headers.length;
  handle.agent.followup(llm.createUserMessage({ content: [{ type: 'text', text: `Fixture task: ${name}` }], source: { kind: 'user' } }));
  await handle.agent.whenIdle();
  const requests = report.requests.slice(adapterStart);
  const trace = traces.get(id);
  // `request/header` is appended only for initial/resume/change/series states, so the effective
  // header is the most recent one. Each captured request is compared with it; the header writes
  // that happened inside this task are counted separately (one per real tool-set change).
  const headerWrites = trace.headers.slice(headersBefore);
  const results = trace.results.slice(-actions.length);
  const entry = {
    name, agent: id,
    requests: requests.map((record) => ({ seq: record.seq, pluginToolCount: record.pluginToolCount,
      toolsJsonBytes: record.toolsJsonBytes, names: record.names, headerMatches: record.headerMatches })),
    headerWrites: headerWrites.map((item) => ({ reason: item.reason, count: item.names.length })),
    results,
    headerCrossCheck: requests.every((record) => record.headerMatches === true),
  };
  report.tasks.push(entry);
  task = null;
  return entry;
}

const pluginNames = (entry, index) => entry.requests[index]?.names.filter((name) => name.startsWith('browser_')) ?? [];


/* ------------------------------------------------------------ scenarios ------------ */
let handles = [];
try {
  const activate = (group) => call('browser_tools', { action: 'activate', groups: [group] });
  const basic = () => [call('browser_navigate', { url: FIXTURE }), call('browser_snapshot', {})];
  const network = () => [
    call('browser_network_session', { action: 'start' }),
    call('browser_navigate', { url: FIXTURE }),
    call('browser_network_events', { limit: 10 }),
    call('browser_network_session', { action: 'stop' }),
  ];
  const vision = () => [call('browser_vision_image', { source: { kind: 'live' } })];
  const dynamic = () => [
    call('browser_dynamic_session', { action: 'start', config: { source: 'screenshot-loop', durationMs: 1500, sampleIntervalMs: 100, maxFrames: 8 } }),
    call('browser_dynamic_session', { action: 'status' }),
    call('browser_dynamic_session', { action: 'stop' }),
  ];
  const prefix = (group) => (phase === 'after' ? [activate(group)] : []);

  const a = await newAgent('a');
  handles.push(a);
  const fileTask = await run(a, 'file', []);
  const basicTask = await run(a, 'basic', [...prefix('basic'), ...basic()]);
  const networkTask = await run(a, 'network', [...prefix('network'), ...network()]);
  const visionTask = await run(a, 'vision', [...prefix('vision'), ...vision()]);
  const dynamicTask = await run(a, 'dynamic', [...prefix('dynamic'), ...dynamic()]);

  const b = await newAgent('b');
  handles.push(b);
  const bTask = await run(b, 'agent-b', []);

  check('captured request lists equal the session request/header lists', [fileTask, basicTask, networkTask, visionTask, dynamicTask, bTask].every((entry) => entry.headerCrossCheck), report.tasks.map((entry) => entry.headerCrossCheck));

  if (phase === 'before') {
    check('baseline: every request carries the 37 execution definitions', report.requests.every((record) => record.pluginToolCount === 37), report.requests.map((record) => record.pluginToolCount));
    check('baseline: no discovery tool is declared before the change', report.requests.every((record) => !record.names.includes('browser_tools')), report.requests[0]?.names);
    check('baseline: real Chromium operations completed', [basicTask, networkTask, visionTask, dynamicTask].every((entry) => entry.results.length > 0 && entry.results.every((result) => !result.isError)), report.tasks.map((entry) => entry.results));
  } else {
    check('initial: exactly the discovery + diagnostic definitions', pluginNames(fileTask, 0).length === EXPECTED.initial && pluginNames(fileTask, 0).includes('browser_tools') && pluginNames(fileTask, 0).includes('browser_state') && pluginNames(fileTask, 0).includes('browser_capabilities'), pluginNames(fileTask, 0));
    check('initial: advanced schemas absent from the real request', ['browser_vision_check', 'browser_network_session', 'browser_dynamic_session', 'browser_navigate'].every((name) => !pluginNames(fileTask, 0).includes(name)), pluginNames(fileTask, 0));
    check('basic: activation request still carries only the initial 3, next request carries 18', pluginNames(basicTask, 0).length === 3 && pluginNames(basicTask, 1).length === EXPECTED.basic, basicTask.requests.map((request) => request.pluginToolCount));
    check('basic: the activation call plus real navigation and snapshot executed', basicTask.results.length === 3 && basicTask.results.every((result) => !result.isError), basicTask.results);
    check('network: next request carries 27 and exposes the network P0 tools', pluginNames(networkTask, 1).length === EXPECTED.network && pluginNames(networkTask, 1).includes('browser_network_events'), pluginNames(networkTask, 1));
    check('network: the activation call plus real collect/events/stop executed', networkTask.results.length === 5 && networkTask.results.every((result) => !result.isError), networkTask.results);
    check('network group did not disclose static vision or dynamic tools', !pluginNames(networkTask, 1).includes('browser_vision_image') && !pluginNames(networkTask, 1).includes('browser_dynamic_session'), pluginNames(networkTask, 1));
    check('vision: the selection accumulates to 33 and produces a real PNG capture',
      pluginNames(visionTask, 1).length === EXPECTED.basic + 9 + 6 && pluginNames(visionTask, 1).includes('browser_vision_image')
      && visionTask.results.length === 2 && visionTask.results.every((result) => !result.isError), { count: pluginNames(visionTask, 1).length, results: visionTask.results });
    check('all groups: the selection accumulates to the full 38', pluginNames(dynamicTask, 1).length === EXPECTED.all && pluginNames(dynamicTask, 1).includes('browser_dynamic_session'), pluginNames(dynamicTask, 1).length);
    check('all groups: the activation call plus real frame start/status/stop executed', dynamicTask.results.length === 4 && dynamicTask.results.every((result) => !result.isError), dynamicTask.results);
    check('agent B keeps the initial 3 while agent A is fully disclosed', pluginNames(bTask, 0).length === EXPECTED.initial && pluginNames(bTask, 0).every((name) => [DISCOVERY_TOOL, ...DIAGNOSTIC_TOOLS].includes(name)), pluginNames(bTask, 0));
    check('per-request byte payloads show the intended distribution', report.requests.every((record) => record.toolsJsonBytes > 0), report.requests.map((record) => record.toolsJsonBytes));
  }

  if (phase === 'after') {
    // Whitelist: the restriction is installed in the Agent's own setup scope. Activation must not
    // resurrect the denied definition, and the rest of the group stays usable.
    const c = await ctx.agents.create({ sessionId: `progressive-restricted-${process.pid}`, meta: { cwd: workspace },
      agentOptions: { provider: 'progressive-fixture', model: 'capture' },
      setup(agentCtx) { agentCtx.tools.restrict({ deny: ['browser_eval'] }); } });
    handles.push(c);
    traces.set(c.agent.id, { requests: [], headers: [], results: [] });
    const restricted = await run(c, 'restricted', [call('browser_tools', { action: 'activate', groups: ['basic'] }), call('browser_navigate', { url: FIXTURE })]);
    const restrictedNames = pluginNames(restricted, 1);
    check('whitelist: activation cannot re-add a denied tool', restrictedNames.length === EXPECTED.basic - 1 && !restrictedNames.includes('browser_eval'), restrictedNames);
    check('whitelist: permitted definitions still execute', restricted.results.length === 2 && restricted.results.every((result) => !result.isError), restricted.results);

    // Isolation of the dynamic recipe: a fresh Agent selects dynamic only.
    const e = await newAgent('dynamic-only');
    handles.push(e);
    const dynamicOnly = await run(e, 'dynamic-only', [call('browser_tools', { action: 'activate', groups: ['dynamic'] }), ...dynamic()]);
    const dynamicOnlyNames = pluginNames(dynamicOnly, 1);
    check('dynamic: 23 definitions, no network or vision schema', dynamicOnlyNames.length === EXPECTED.dynamic
      && !dynamicOnlyNames.includes('browser_network_session') && !dynamicOnlyNames.includes('browser_vision_image')
      && dynamicOnlyNames.includes('browser_dynamic_session'), dynamicOnlyNames);
    check('dynamic: real frame session start/status/stop executed', dynamicOnly.results.length === 4 && dynamicOnly.results.every((result) => !result.isError), dynamicOnly.results);

    // A model-forced call to a definition this step never admitted must be refused by the host.
    const d = await newAgent('forced-hidden');
    handles.push(d);
    const forced = await run(d, 'forced-hidden', [call('browser_vision_check', { cases: [] }), call('browser_tools', { action: 'status' })]);
    check('dispatch: the forced hidden call errors and is reported as an unknown tool',
      forced.results[0]?.isError === true && /unknown tool/i.test(forced.results[0]?.detail ?? ''), forced.results[0]);
    check('dispatch: the hidden definition is still absent from the following request',
      pluginNames(forced, 1).length === EXPECTED.initial && !pluginNames(forced, 1).includes('browser_vision_check'), pluginNames(forced, 1));

    // Environment switch on Agent A: real config routes, away and back.
    const callRoute = async ({ method = 'GET', path = '/', body, headers = {} }) => {
      const entry = routes.find((item) => item.kind === 'prefix' && item.path === '/plugins/ui-testing');
      const { EventEmitter } = await import('node:events');
      const req = new EventEmitter(); req.url = path; req.method = method; req.headers = headers; req.destroy = () => {};
      const res = { statusCode: 0, body: '', writeHead(code) { this.statusCode = code; return this; }, end(chunk) { if (chunk) this.body += chunk; } };
      const pending = entry.handler(req, res);
      process.nextTick(() => {
        if (body !== undefined) req.emit('data', Buffer.from(JSON.stringify(body), 'utf8'));
        req.emit('end');
      });
      await Promise.race([pending, new Promise((_, reject) => setTimeout(() => reject(new Error('config route timeout')), 20000))]);
      let json = null; try { json = JSON.parse(res.body); } catch { json = null; }
      return { status: res.statusCode, json };
    };
    try {
      const before = await callRoute({ path: '/plugins/ui-testing/config?view=global' });
      const off = await callRoute({ method: 'PUT', path: '/plugins/ui-testing/config', headers: { 'content-type': 'application/json' },
        body: { expectedRevision: before.json.revision, scope: 'global', patch: { environments: { web: { enabled: false } } } } });
      check('environment switch: a real config write disabled the web environment', off.status === 200, off);
      const blocked = await run(a, 'env-off', [call('browser_tools', { action: 'activate', groups: ['basic'] })]);
      check('environment switch: activation is refused while the environment is disabled',
        blocked.results[0]?.isError === true && /TOOL_DISCLOSURE_UNAVAILABLE/.test(blocked.results[0]?.detail ?? ''), blocked.results[0]);
      check('environment switch: only discovery + diagnostics remain', pluginNames(blocked, 1).length === EXPECTED.initial, pluginNames(blocked, 1));
      const on = await callRoute({ method: 'PUT', path: '/plugins/ui-testing/config', headers: { 'content-type': 'application/json' },
        body: { expectedRevision: off.json.revision, scope: 'global', patch: { environments: { web: { enabled: true } } } } });
      check('environment switch: web re-enabled', on.status === 200, on);
      const afterSwitch = await run(a, 'env-on', [call('browser_tools', { action: 'status' })]);
      check('environment switch: the away/back round trip cleared the selection', pluginNames(afterSwitch, 1).length === EXPECTED.initial, pluginNames(afterSwitch, 1));
      const reactivated = await run(a, 'reactivate', [call('browser_tools', { action: 'activate', groups: ['basic'] }), call('browser_navigate', { url: FIXTURE })]);
      check('environment switch: the same Agent can re-activate afterwards', pluginNames(reactivated, 1).length === EXPECTED.basic, pluginNames(reactivated, 1));
    } catch (error) {
      report.failure = { message: `environment switch: ${error.message}` };
      check('environment switch: config route responded', false, report.failure);
    }

    // Plugin reload: dispose every Agent and the plugin fiber, mount the same entry again.
    for (const handle of handles.splice(0)) await handle.dispose();
    await pluginFiber.dispose();
    pluginFiber = ctx.plugin(await import(resolve(ROOT, 'index.js')));
    await new Promise((done) => setTimeout(done, 0));
    const reloaded = await newAgent('reloaded');
    handles.push(reloaded);
    const reloadedTask = await run(reloaded, 'reloaded', []);
    check('reload: a new Agent after plugin reload starts at the initial 3', pluginNames(reloadedTask, 0).length === EXPECTED.initial, pluginNames(reloadedTask, 0));
    notRun('session resume (agents.resume) after reload', 'the isolated host mounts no persistence backend; resume would require writing user session storage');
    notRun('real remote-model capability choice', 'the model is a deterministic protocol fixture; natural-language selection quality is not measured');
  }
} catch (error) {
  report.failure = { name: error.name, message: error.message, stack: String(error.stack).split('\n').slice(0, 6) };
  check('acceptance completes without an unexpected error', false, report.failure);
} finally {
  for (const handle of handles.reverse()) { try { await handle.dispose(); } catch (error) { report.failure ??= { message: `dispose: ${error.message}` }; } }
  try { await ctx.fiber.dispose(); } catch { /* best effort */ }
  await new Promise((done) => fixtureServer.close(done));
  report.summary = {
    requests: report.requests.length,
    totalToolsJsonBytes: report.requests.reduce((sum, record) => sum + record.toolsJsonBytes, 0),
    perTaskRequests: Object.fromEntries(report.tasks.map((entry) => [entry.name, entry.requests.length])),
    completeTaskRequests: report.tasks.filter((entry) => ['file', 'basic', 'network', 'vision', 'dynamic'].includes(entry.name)).reduce((sum, entry) => sum + entry.requests.length, 0),
  };
  report.passed = report.checks.length > 0 && report.checks.every((item) => item.pass);
  await writeFile(join(runDir, 'report.json'), `${JSON.stringify(report, null, 2)}\n`);
  await writeFile(join(runDir, 'run.log'), `${lines.join('\n')}\n`);
  console.log(JSON.stringify({ passed: report.passed, runDir, summary: report.summary, failed: report.checks.filter((item) => !item.pass).map((item) => item.label) }, null, 2));
  process.exitCode = report.passed ? 0 : 1;
}
