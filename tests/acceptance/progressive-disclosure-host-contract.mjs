#!/usr/bin/env node
/**
 * Isolated installed-host contract probe. Uses public package exports only.
 * It mounts an independent, memory-only Cordis host, captures real AgentLoop
 * requests at the public LlmAdapter boundary, and never loads a user profile,
 * persistence backend, configuration file, or historical Session.
 * Run with the installation's Node executable; stdout names the report.
 */
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdir, readFile, realpath, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const pluginRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const installation = await realpath(process.env.DSH_INSTALL_DIR
  || '/home/dev/.local/share/dsh-r3/node_modules/@deepseek-ai/dsh');
const manifest = JSON.parse(await readFile(join(installation, 'package.json'), 'utf8'));
assert.equal(manifest.name, '@deepseek-ai/dsh');
const requireFromHost = createRequire(join(installation, 'package.json'));
const importedPackages = [];
async function publicPackage(shortName) {
  const specifier = `@deepseek-ai/${shortName}`;
  const entry = requireFromHost.resolve(specifier);
  importedPackages.push({ specifier, entry });
  return import(entry);
}
const { Context } = await publicPackage('cordis');
const llm = await publicPackage('dsh-llm');
const ctx = new Context();
const captures = new Map();
const cases = {};
let sequence = 0;
const toolsModule = await publicPackage('dsh-tools');
const makeTool = (name, execute = () => true) => toolsModule.defineTool({
  name, description: 'Isolated installed-host contract fixture.', parameters: {},
  output: { schema: { type: 'boolean' }, render: (_args, value) => [{ type: 'text', text: String(value) }] },
  execute,
});
const create = async (label, setup) => {
  const id = `host-contract-${process.pid}-${++sequence}`;
  const trace = { label, requests: [], headers: [], toolResults: [], turnEnds: [] };
  captures.set(id, trace);
  const handle = await ctx.agents.create({ sessionId: id,
    agentOptions: { provider: 'host-contract-fixture', model: 'capture' }, setup });
  return { handle, trace };
};
const drive = async agent => {
  agent.followup(llm.createUserMessage({ content: [{ type: 'text', text: 'Run the isolated fixture.' }], source: { kind: 'user' } }));
  await agent.whenIdle();
};
const toolCall = (name, suffix) => ({ type: 'tool-call', id: `fixture-${suffix}`, name, arguments: {} });
function* emitCall(block) {
  yield { type: 'block-start', index: 0, blockType: 'tool-call' };
  yield { type: 'block-end', index: 0, block };
  yield { type: 'finish', reason: { kind: 'tool-calls' } };
}
let respond = function* () { yield { type: 'finish', reason: { kind: 'stop' } }; };
class CaptureAdapter extends llm.LlmAdapter {
  async *stream(request) {
    const trace = captures.get(request.sessionId);
    assert.ok(trace, 'Every captured request belongs to this independent fixture');
    trace.requests.push({ tools: (request.tools ?? []).map(tool => tool.name),
      frozen: Object.isFrozen(request), model: request.model });
    yield* respond(request, trace.requests.length);
  }
}
let failure;
try {
  for (const shortName of ['dsh-session', 'dsh-session-projection', 'dsh-agent', 'dsh-llm',
    'dsh-system-prompt', 'dsh-tools', 'dsh-tool-executor-native', 'dsh-agent-loop']) {
    const module = await publicPackage(shortName);
    await ctx.plugin(module.default ?? module, {}).await();
  }
  assert.equal(ctx.get('sessionPersistence'), undefined);
  ctx.llm.registerAdapter(['host-contract-fixture'], new CaptureAdapter());
  ctx.on('session/event', (session, event) => {
    const trace = captures.get(session.id);
    if (!trace) return;
    if (event.type === 'request/header') trace.headers.push((event.data.header.tools ?? []).map(tool => tool.name));
    if (event.type === 'tool/result') trace.toolResults.push({
      isError: event.data.message.isError, code: event.data.error?.code ?? null,
    });
    if (event.type === 'turn/end') trace.turnEnds.push(event.data.reason.kind);
  });

  // A real continuation recomputes when and rejects a model-forced hidden name.
  {
    let enabled = true, whenCalls = 0, bodyCalls = 0;
    const remove = ctx.tools.register(makeTool('fixture_progressive', () => {
      bodyCalls++; enabled = false; return true;
    }), { when: ({ agent, modelSelection, signal }) => {
      whenCalls++; signal.throwIfAborted();
      assert.equal(ctx.agents.get(agent.id), agent);
      assert.equal(modelSelection.provider, 'host-contract-fixture');
      return enabled;
    } });
    respond = function* (_request, attempt) {
      if (attempt <= 2) yield* emitCall(toolCall('fixture_progressive', attempt));
      else yield { type: 'finish', reason: { kind: 'stop' } };
    };
    const { handle, trace } = await create('step-recalculation');
    try {
      await drive(handle.agent);
      assert.deepEqual(trace.requests.map(request => request.tools), [['fixture_progressive'], [], []]);
      assert.deepEqual(trace.headers, [['fixture_progressive'], []]);
      assert.deepEqual(trace.toolResults, [{ isError: false, code: null }, { isError: true, code: 'UNKNOWN_TOOL' }]);
      assert.equal(whenCalls, 3); assert.equal(bodyCalls, 1);
      assert.deepEqual(trace.turnEnds, ['completed']);
      cases.stepRecalculation = { ...trace, whenCalls, bodyCalls, passed: true };
    } finally { await handle.dispose(); remove(); }
  }

  // Public Agent setup can hold plugin-owned role state without agent.state.
  {
    const roles = new WeakMap();
    const remove = ctx.tools.register(makeTool('fixture_web_role'), {
      when: ({ agent }) => roles.get(agent) === 'web',
    });
    respond = function* () { yield { type: 'finish', reason: { kind: 'stop' } }; };
    const actual = {};
    for (const role of ['lead', 'web']) {
      const { handle, trace } = await create(`role-${role}`, (_agentCtx, agent) => { roles.set(agent, role); });
      try { await drive(handle.agent); actual[role] = trace.requests[0].tools; }
      finally { await handle.dispose(); }
    }
    remove();
    assert.deepEqual(actual, { lead: [], web: ['fixture_web_role'] });
    cases.roleWhitelist = { requests: actual, persisted: false, passed: true };
  }

  // Request retries retain the same admitted set, even if external state changes.
  {
    let enabled = true, whenCalls = 0, retries = 0;
    const remove = ctx.tools.register(makeTool('fixture_retry'), { when: () => { whenCalls++; return enabled; } });
    const { handle, trace } = await create('retry-reuse', agentCtx => {
      agentCtx.on('agent/request-error', (_payload, next) => {
        if (retries++ === 0) return Promise.resolve({ kind: 'retry' });
        return next();
      });
    });
    respond = function* (_request, attempt) {
      if (attempt === 1) { enabled = false; throw new llm.LlmError('fixture retry', 'HTTP_503'); }
      yield { type: 'finish', reason: { kind: 'stop' } };
    };
    try {
      await drive(handle.agent);
      assert.deepEqual(trace.requests.map(request => request.tools), [['fixture_retry'], ['fixture_retry']]);
      assert.equal(whenCalls, 1); assert.equal(retries, 1);
      assert.deepEqual(trace.turnEnds, ['completed']);
      cases.retryReuse = { ...trace, whenCalls, retries, passed: true };
    } finally { await handle.dispose(); remove(); }
  }

  // Admission and dispatch are distinct: current guards handle immediate revocation.
  {
    let enabled = true, whenCalls = 0, bodyCalls = 0;
    const definition = makeTool('fixture_boundaries', () => { bodyCalls++; return true; });
    let remove = ctx.tools.register(definition, { when: () => { whenCalls++; return enabled; } });
    const { handle } = await create('dispatch-boundaries');
    const agent = handle.agent;
    const signal = new AbortController().signal;
    const resolveSet = () => ctx.tools.resolve({ agent, signal,
      modelSelection: { provider: 'host-contract-fixture', model: 'capture' } });
    const execute = async toolSet => {
      const result = await ctx.tools.execute({ calls: [toolCall(definition.name, 'boundary')], agent, signal,
        ...(toolSet === undefined ? {} : { toolSet }) });
      const outcome = result.results[0].result;
      return { isError: outcome.isError, code: outcome.error?.info?.code ?? null };
    };
    try {
      const set = await resolveSet(); enabled = false;
      const observations = { admittedThenStateChanged: await execute(set), whenCallsAfterExecute: whenCalls,
        sameIdDifferentObjectVisible: set.view({ id: agent.id }).size, withoutSet: await execute() };
      const unguard = ctx.tools.guard(() => 'Fixture capability revoked');
      observations.guarded = await execute(set); unguard();
      set.dispose(); observations.disposed = await execute(set);
      enabled = true; const set2 = await resolveSet(); remove();
      remove = ctx.tools.register(definition, { when: () => true });
      observations.sameDefinitionReRegisteredVisible = set2.view(agent).size; set2.dispose();
      const set3 = await resolveSet();
      const unrestrict = agent.ctx.tools.restrict({ deny: [definition.name] });
      observations.restrictedAfterResolveVisible = set3.view(agent).size;
      unrestrict(); set3.dispose(); remove();
      const unthrow = ctx.tools.register(makeTool('fixture_throw'), { when: () => { throw new Error('Fixture activation failure'); } });
      try { await resolveSet(); assert.fail('Throwing when must fail activation'); }
      catch (error) { observations.thrownWhen = { name: error.name, code: error.code }; }
      finally { unthrow(); }
      assert.equal(observations.admittedThenStateChanged.isError, false);
      assert.equal(observations.whenCallsAfterExecute, 1);
      assert.equal(observations.sameIdDifferentObjectVisible, 0);
      assert.equal(observations.withoutSet.code, 'UNKNOWN_TOOL');
      assert.equal(observations.guarded.isError, true);
      assert.equal(observations.disposed.code, 'UNKNOWN_TOOL');
      assert.equal(observations.sameDefinitionReRegisteredVisible, 0);
      assert.equal(observations.restrictedAfterResolveVisible, 0);
      assert.equal(observations.thrownWhen.code, 'TOOL_ACTIVATION_FAILED');
      assert.equal(bodyCalls, 1);
      cases.dispatchBoundaries = { observations, bodyCalls, whenCalls, passed: true };
    } finally { await handle.dispose(); remove(); }
  }
} catch (error) {
  failure = { name: error.name, code: error.code ?? null, message: error.message };
  process.exitCode = 1;
} finally {
  await ctx.fiber.dispose();
}
const stamp = new Date().toISOString().replace(/[:.]/g, '-');
const reportDirectory = join(pluginRoot, 'tests', 'acceptance', 'runs', `progressive-host-contract-${stamp}-${process.pid}`);
await mkdir(reportDirectory, { recursive: true });
const report = { schemaVersion: 1, status: failure ? 'FAIL' : 'PASS',
  installation: { name: manifest.name, version: manifest.version, directory: installation },
  runtime: { node: process.version, publicImports: [...new Map(importedPackages.map(item => [item.specifier, item])).values()] },
  evidenceBoundary: { actualAgentLoop: true, actualInstalledPackages: true, privatePatches: false,
    requestCapture: 'public LlmAdapter.stream', externalProviderRequest: false,
    persistenceMounted: false, profileLoaded: false, historicalSessionsLoaded: false,
    state: 'All Agent, Session, role, and event state exists only in this independent process memory.' },
  cases, ...(failure ? { failure } : {}) };
const reportPath = join(reportDirectory, 'report.json');
await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
console.log(JSON.stringify({ status: report.status, caseCount: Object.keys(cases).length, reportPath }));
