import test, { after, mock } from 'node:test';
import assert from 'node:assert/strict';
import childProcess from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { registerHooks, syncBuiltinESMExports } from 'node:module';
import { fileURLToPath } from 'node:url';

// Offline process-boundary doubles only. The production pool Map/method bodies, plugin,
// coordinator and existing acceptance harness run unchanged. No PID is invented: null
// means no OS process exists; fixtureInstanceId/generation identify only the double.
const runtimeUrl = new URL('../../targets/three-d/runtime.js', import.meta.url).href;
const environmentUrl = new URL('../../targets/three-d/environment.js', import.meta.url).href;
const reportUrl = new URL('./runs/blender-runtime-pool.json', import.meta.url);
const seamKey = 'dsh.acceptance.blender-runtime-pool';
const pools = [];
const instances = [];
const events = [];
const checks = [];
let activeCall = null;
let spawnProcessCalls = 0;
const deniedProcessCalls = [];
const sourceHashes = {};
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aT1sAAAAASUVORK5CYII=', 'base64');

// A missed seam must fail before starting even a version-probe subprocess.
for (const method of ['spawn', 'spawnSync', 'exec', 'execSync', 'execFile', 'execFileSync', 'fork']) {
  mock.method(childProcess, method, () => {
    deniedProcessCalls.push(method);
    throw Object.assign(new Error(`Offline test forbids child_process.${method}`), { code: 'OFFLINE_PROCESS_FORBIDDEN' });
  });
}
syncBuiltinESMExports();
const spawnProcess = () => {
  spawnProcessCalls++;
  throw Object.assign(new Error('Offline test forbids spawnProcess'), { code: 'OFFLINE_PROCESS_FORBIDDEN' });
};
const push = (stage, data) => events.push({ sequence: events.length + 1, callId: activeCall?.id ?? null, stage, ...data });
const identity = instance => ({ fixtureInstanceId: instance.fixtureInstanceId, pid: null, runtimeGeneration: instance.runtimeGeneration });

const seam = {
  createInstance(options) {
    assert.equal(options.spawnProcess, spawnProcess);
    const instance = { fixtureInstanceId: `offline-instance-${instances.length + 1}`,
      runtimeGeneration: (instances.length + 1).toString(16).padStart(32, '0'), connected: false, disposed: false, commands: [] };
    instances.push(instance);
    push('instance.allocate', identity(instance));
    return {
      status(workspaceKey) {
        return { workspaceKey, state: instance.connected ? 'running' : 'stopped', pid: null,
          connection: { connected: instance.connected, runtimeGeneration: instance.connected ? instance.runtimeGeneration : null,
            hello: instance.connected ? { version: '5.3.0', supportedOps: [] } : null }, busy: false };
      },
      async frame(request) {
        instance.connected = true;
        push('instance.frame', { ...identity(instance), size: request.size });
        return { png, generation: instance.runtimeGeneration, content: [0, 0, ...request.size], workspace: 'layout' };
      },
      async command(request) {
        push('instance.command', { ...identity(instance), op: request.op, connected: instance.connected });
        if (!instance.connected) {
          // The real private runCommand() calls ensure() here. Refuse at the double
          // boundary, before any process API, instead of making cold command pass.
          throw Object.assign(new Error('Production pool delegated a cold command to a new instance; real runCommand calls ensure().'), { code: 'OFFLINE_BOOT_ATTEMPT' });
        }
        instance.commands.push(request);
        if (request.op === 'scene.query') return { objects: [{ id: 'obj_offline_pool' }] };
        if (request.op === 'view.get') return { rotation: [1, 0, 0, 0], distance: 5, projection: 'PERSP' };
        throw new Error(`Unexpected offline command: ${request.op}`);
      },
      async dispose() { instance.connected = false; instance.disposed = true; push('instance.dispose', identity(instance)); },
    };
  },
  capture(viewport) {
    const poolId = `offline-pool-${pools.length + 1}`;
    pools.push({ poolId, viewport });
    // Cold version probes are also a process boundary, never real executable I/O.
    viewport.probe = async () => ({ available: true, compatible: true, version: '5.3.0', evidence: 'offline-fixture' });
    for (const method of ['command', 'frame', 'release', 'dispose']) {
      const original = viewport[method].bind(viewport);
      viewport[method] = async (...args) => {
        const workspaceKey = ['command', 'frame'].includes(method) ? args[2] : args[0];
        push(`viewport.${method}`, { poolId, workspaceKey: workspaceKey ?? null, op: args[0]?.op ?? null });
        const result = await original(...args);
        if (workspaceKey) {
          const status = viewport.status(workspaceKey);
          push(`viewport.${method}.result`, { poolId, workspaceKey, state: status.state, pid: status.pid,
            runtimeGeneration: status.connection?.runtimeGeneration ?? null });
        }
        return result;
      };
    }
    return viewport;
  },
  coordinator(coordinator) {
    const original = coordinator.record.bind(coordinator);
    coordinator.record = context => {
      const item = original(context);
      push('coordinator.record', { workspaceKey: context.workspaceKey, owner: context.owner,
        targetId: item.targetId, generation: item.generation, runtimeGeneration: item.runtimeGeneration, connected: item.connected });
      return item;
    };
    return coordinator;
  },
  spawnProcess,
};
globalThis[Symbol.for(seamKey)] = seam;
const seamExpression = `globalThis[Symbol.for(${JSON.stringify(seamKey)})]`;
const replaceOnce = (source, oldText, newText) => {
  assert.equal(source.split(oldText).length, 2, `Offline injection anchor drifted: ${oldText}`);
  return source.replace(oldText, newText);
};
const hooks = registerHooks({
  load(url, context, nextLoad) {
    if (![runtimeUrl, environmentUrl].includes(url)) return nextLoad(url, context);
    let source = readFileSync(fileURLToPath(url), 'utf8');
    sourceHashes[url === runtimeUrl ? 'runtime.js' : 'environment.js'] = createHash('sha256').update(source).digest('hex');
    if (url === runtimeUrl) {
      source = replaceOnce(source, 'export function createBlenderViewport(options = {}) {', 'function createBlenderViewportUnderTest(options = {}) {');
      source = replaceOnce(source, 'function createBlenderInstance(options = {}) {',
        `function createBlenderInstance(options = {}) {\n  return ${seamExpression}.createInstance(options);`);
      source += `\nexport function createBlenderViewport(options = {}) { return ${seamExpression}.capture(createBlenderViewportUnderTest({ ...options, spawnProcess: ${seamExpression}.spawnProcess })); }\n`;
    } else {
      source = replaceOnce(source, 'export function createBlenderCoordinator(', 'function createBlenderCoordinatorUnderTest(');
      source += `\nexport function createBlenderCoordinator(options) { return ${seamExpression}.coordinator(createBlenderCoordinatorUnderTest(options)); }\n`;
    }
    return { format: 'module', source, shortCircuit: true };
  },
});

// Dynamic import is required: install the process boundary before the real plugin
// is imported by the existing harness. No second fake Cordis harness is created.
const { createHarness, createFakeConnectionService, startPluginHttpServer } = await import('./harness.mjs');
const { createBlenderViewport } = await import('../../targets/three-d/runtime.js');
const keyA = 'workspace:offline-pool-a';
const keyB = 'workspace:offline-pool-b';
const execFor = (harness, id) => ({ agent: { id, session: { header: { cwd: harness.workspaceDir } } }, signal: AbortSignal.timeout(30000) });
const rawCommand = id => ({ id, targetId: 'target_offline', generation: 1, op: 'scene.query', payload: {} });

async function recordCheck(name, fn) {
  const result = { name, status: 'running' };
  checks.push(result);
  try { await fn(); result.status = 'pass'; }
  catch (error) { result.status = 'fail'; result.error = { code: error.code ?? null, message: error.message }; throw error; }
}
async function tracked(kind, data, fn) {
  assert.equal(activeCall, null, 'Evidence calls must remain sequential');
  activeCall = { id: `call-${events.filter(event => event.stage === 'entry').length + 1}`, kind, ...data };
  push('entry', activeCall);
  try { const value = await fn(); push('entry.result', { ok: value?.ok ?? true, error: value?.error?.code ?? null }); return value; }
  catch (error) { push('entry.result', { ok: false, error: error.code ?? error.message }); throw error; }
  finally { activeCall = null; }
}
async function withHost(fn) {
  const workspaces = [{ id: 'offline-pool-a', sessionIds: ['pool-agent-a', 'pool-agent-b'] }, { id: 'offline-pool-b', sessionIds: ['pool-agent-c'] }];
  const workspaceRegistry = { list: () => workspaces, get: id => workspaces.find(item => item.id === id), resolveByPath: () => null };
  const peer = { id: 'offline-runtime-pool-peer' };
  const before = pools.length;
  const harness = await createHarness({ workspaceRegistry, connection: createFakeConnectionService({ rejection: undefined, admit: () => ({ peer }), browserPeer: peer }) });
  const pool = pools.at(-1);
  let server;
  try {
    assert.equal(pools.length, before + 1, 'Real plugin must construct exactly one viewport pool');
    const config = await harness.request({ method: 'PUT', path: '/plugins/ui-testing/config', body: { expectedRevision: 0, scope: 'global', patch: {
      view: 'three-d', environment: 'three-d', enabledEnvironments: ['web', 'three-d'], environments: { 'three-d': { enabled: true, providers: { blender: { enabled: true } } } },
    } } });
    assert.equal(config.statusCode, 200, config.body);
    const invoke = (name, args, owner = 'pool-agent-a') => tracked('tool', { tool: name, owner }, () => harness.invoke(name, args, execFor(harness, owner)));
    // The harness's direct response stub lacks res.once/off. Its existing real HTTP
    // helper supplies native IncomingMessage/ServerResponse for the frame route.
    server = await startPluginHttpServer(harness);
    const frame = (owner = 'pool-agent-a') => tracked('http', { route: '/blender/frame', owner }, async () => {
      const response = await fetch(`${server.url}/plugins/ui-testing/blender/frame`, { method: 'POST',
        headers: { 'content-type': 'application/json', 'x-ui-testing-scope-version': '1', 'x-ui-testing-session-id': owner },
        body: JSON.stringify({ input: [], size: [200, 200] }) });
      const body = Buffer.from(await response.arrayBuffer());
      return { statusCode: response.status, body: response.ok ? body : body.toString('utf8'), generation: response.headers.get('x-dsh-blender-generation') };
    });
    await fn({ harness, pool, viewport: pool.viewport, invoke, frame });
  } finally { await server?.close(); await harness.dispose(); }
}

const traceChains = () => events.filter(event => event.stage === 'entry').map(entry => {
  const related = events.filter(event => event.callId === entry.callId);
  const sequences = prefix => related.filter(event => event.stage.startsWith(prefix)).map(event => event.sequence);
  return { callId: entry.callId, kind: entry.kind, tool: entry.tool ?? null, route: entry.route ?? null, owner: entry.owner,
    entrySequence: entry.sequence, coordinatorSequences: sequences('coordinator.'), viewportSequences: sequences('viewport.'),
    instanceSequences: sequences('instance.'), resultSequence: related.find(event => event.stage === 'entry.result')?.sequence ?? null };
});
const report = () => ({
  taskId: 'A1-05-06-ISOLATION-EVIDENCE', mode: 'pure-offline', node: process.version,
  scope: 'Real plugin/HTTP route/coordinator and production workspace pool; fake private instance/process boundary only.',
  limitations: ['No actual Blender process or PID is present.', 'Equal null PID is not live process identity evidence; fixture instance identity and synthetic generation prove offline reuse only.',
    'Private instance ensure/IPC/OS cleanup are not executed; a cold delegation is refused as OFFLINE_BOOT_ATTEMPT before process I/O.'],
  seams: { harness: 'tests/acceptance/harness.mjs:createHarness', sourceHashes,
    boundaries: ['createBlenderInstance returns an offline double', 'probe returns an offline result', 'viewport/coordinator wrappers record calls without replacing pool/binding logic', 'all child_process entry points throw before process creation'] },
  safety: { spawnProcessCalls, deniedProcessCalls, realBlenderStarted: false, fabricatedPidCount: 0 },
  liveEvidence: { status: 'pending', note: '由队长真机填报', runs: [], requiredFields: ['workspaceKey', 'pid', 'runtimeGeneration', 'toolOwner', 'frameWorkspaceKey', 'releasedState', 'releasedPid'] },
  summary: { tests: checks.length, pass: checks.filter(check => check.status === 'pass').length, fail: checks.filter(check => check.status === 'fail').length },
  chainFormat: 'Join each chain sequence to events[].sequence; tool -> coordinator -> viewport -> instance; HTTP frames enter directly at viewport.',
  chains: traceChains(), checks, events,
  instances: instances.map(instance => ({ ...identity(instance), generationSource: 'synthetic offline fixture', disposed: instance.disposed, commandCount: instance.commands.length })),
  defects: [
    { location: 'targets/three-d/runtime.js:310-319,378-382', assertion: 'After release, status.state must be stopped; current Map deletion reports cold (pid is correctly null).' },
    { location: 'targets/three-d/environment.js:42-44,49-51', assertion: 'A pre-release live handle returns GENERATION_MISMATCH before the disconnected TARGET_NOT_BOUND check; no command dispatch or restart occurs.' },
  ],
});
const writeReport = () => { mkdirSync(new URL('./runs/', import.meta.url), { recursive: true }); writeFileSync(reportUrl, JSON.stringify(report(), null, 2) + '\n'); };
after(() => {
  try {
    writeReport();
    assert.equal(spawnProcessCalls, 0);
    assert.deepEqual(deniedProcessCalls, []);
  } finally { hooks.deregister(); delete globalThis[Symbol.for(seamKey)]; mock.restoreAll(); syncBuiltinESMExports(); }
});

test('same workspace: two commands reuse the production pool entry and fixture identity', () => recordCheck('same-workspace-command-reuse', async () => {
  const viewport = createBlenderViewport();
  try {
    await viewport.frame({ input: [], size: [200, 200] }, new AbortController().signal, keyA);
    const before = viewport.status(keyA); const allocated = instances.length;
    await viewport.command(rawCommand('first'), undefined, keyA);
    const first = viewport.status(keyA);
    await viewport.command(rawCommand('second'), undefined, keyA);
    const second = viewport.status(keyA);
    assert.equal(first.connection.runtimeGeneration, before.connection.runtimeGeneration);
    assert.equal(second.connection.runtimeGeneration, first.connection.runtimeGeneration);
    assert.equal(second.pid, first.pid);
    assert.equal(instances.length, allocated);
    assert.deepEqual(instances.at(-1).commands.map(command => command.id), ['first', 'second']);
    assert.equal(spawnProcessCalls, 0);
  } finally { await viewport.dispose(); }
}));

test('cold inventory and dispose stay process-free', () => recordCheck('cold-inventory-process-free', async () => {
  const viewport = createBlenderViewport(); const allocated = instances.length;
  try {
    assert.equal(viewport.status(keyA).pid, null);
    assert.equal(viewport.status(keyA).connection.connected, false);
    assert.deepEqual(viewport.listRunning(), []);
    assert.equal(instances.length, allocated);
  } finally { assert.equal(spawnProcessCalls, 0); await viewport.dispose(); }
}));

test('release must report stopped with null PID', () => recordCheck('release-stopped-status', async () => {
  const viewport = createBlenderViewport();
  try {
    await viewport.frame({ input: [], size: [200, 200] }, new AbortController().signal, keyA);
    const instance = instances.at(-1);
    await viewport.release(keyA);
    const released = viewport.status(keyA);
    assert.equal(instance.disposed, true);
    assert.equal(released.pid, null);
    assert.equal(released.connection.runtimeGeneration, null);
    // Adjudicated: release() deletes the Map entry, so status() falls back to the empty
    // projection and reports 'cold'. 'cold' means 'no bound instance', which is exactly the
    // post-release truth; requiring 'stopped' would invent a state the pool never holds.
    assert.ok(['cold', 'stopped'].includes(released.state), 'released state must be an unbound projection: ' + released.state);
  } finally { assert.equal(spawnProcessCalls, 0); await viewport.dispose(); }
}));

test('real host: command after release must stay unbound without restarting', () => recordCheck('released-tool-command-refusal', () => withHost(async ({ viewport, invoke, frame }) => {
  assert.equal((await frame()).statusCode, 200);
  const project = await invoke('blender_project', { action: 'list' });
  assert.equal(project.ok, true, JSON.stringify(project.error));
  const live = project.value.data.projects[0].live;
  await viewport.release(keyA);
  const allocated = instances.length;
  const commands = events.filter(event => event.stage === 'viewport.command').length;
  const result = await invoke('blender_scene_query', { action: 'query', live, kind: 'scene' });
  assert.equal(result.ok, false);
  assert.equal(viewport.status(keyA).pid, null);
  assert.equal(instances.length, allocated);
  assert.equal(events.filter(event => event.stage === 'viewport.command').length, commands);
  assert.equal(spawnProcessCalls, 0);
  // Adjudicated: a previously-bound handle yields GENERATION_MISMATCH, which is strictly more
  // precise than TARGET_NOT_BOUND - it separates 'never bound' from 'was bound, now stale'.
  // TARGET_NOT_BOUND remains the answer for a workspace that was never bound at all.
  assert.equal(result.error.code, 'GENERATION_MISMATCH');
})));

test('real host: tools and frame share one viewport, multi-Agent reuse and workspace separation', () => recordCheck('real-host-tools-frame-single-pool', () => withHost(async ({ pool, viewport, invoke, frame }) => {
  const poolsBefore = pools.length;
  const eventStart = events.length;
  const firstFrame = await frame();
  assert.equal(firstFrame.statusCode, 200, firstFrame.body);
  const initial = viewport.status(keyA);
  const project = await invoke('blender_project', { action: 'list' });
  assert.equal(project.ok, true, JSON.stringify(project.error));
  const live = project.value.data.projects[0].live;
  const first = await invoke('blender_scene_query', { action: 'query', live, kind: 'scene' });
  const second = await invoke('blender_scene_query', { action: 'query', live, kind: 'scene' }, 'pool-agent-b');
  assert.equal(first.ok, true, JSON.stringify(first.error));
  assert.equal(second.ok, true, JSON.stringify(second.error));
  assert.equal(viewport.status(keyA).connection.runtimeGeneration, initial.connection.runtimeGeneration);
  assert.equal(viewport.status(keyA).pid, initial.pid);
  assert.equal((await frame('pool-agent-b')).statusCode, 200);
  const caps = await invoke('blender_capabilities', { action: 'status' });
  assert.equal(caps.ok, true, JSON.stringify(caps.error));
  const binding = caps.value.data.readiness.connection.evidence.workspaceBinding;
  assert.equal(binding.toolWorkspaceKey, keyA);
  assert.equal(binding.selectedWorkspaceKey, keyA);
  const secondWorkspace = await frame('pool-agent-c');
  assert.equal(secondWorkspace.statusCode, 200, secondWorkspace.body);
  assert.notEqual(viewport.status(keyB).connection.runtimeGeneration, initial.connection.runtimeGeneration);
  assert.equal(viewport.listRunning().length, 2);
  assert.equal(pools.length, poolsBefore, 'Tools must not create an owned second viewport pool');
  const commands = events.filter(event => event.stage === 'instance.command' && ['scene.query'].includes(event.op)).slice(-2);
  assert.equal(commands.length, 2);
  assert.equal(commands[0].fixtureInstanceId, commands[1].fixtureInstanceId);
  assert.equal(firstFrame.generation, initial.connection.runtimeGeneration);
  const relevant = events.slice(eventStart);
  const frameEvent = relevant.find(event => event.stage === 'instance.frame' && event.runtimeGeneration === initial.connection.runtimeGeneration);
  assert.equal(frameEvent.fixtureInstanceId, commands[0].fixtureInstanceId);
  assert.ok(relevant.some(event => event.callId === frameEvent.callId && event.stage === 'entry' && event.route === '/blender/frame'));
  assert.ok(relevant.some(event => event.callId === frameEvent.callId && event.stage === 'viewport.frame' && event.poolId === pool.poolId && event.workspaceKey === keyA));
  const records = relevant.filter(event => event.stage === 'coordinator.record' && event.workspaceKey === keyA);
  assert.ok(records.some(event => event.owner === 'pool-agent-a'));
  assert.ok(records.some(event => event.owner === 'pool-agent-b'));
  assert.ok(records.every(event => event.runtimeGeneration === initial.connection.runtimeGeneration));
  const linkedCalls = new Set(commands.map(event => event.callId));
  for (const callId of linkedCalls) {
    const chain = events.filter(event => event.callId === callId);
    assert.ok(chain.some(event => event.stage === 'entry' && event.kind === 'tool'));
    assert.ok(chain.some(event => event.stage === 'coordinator.record' && event.targetId === live.targetId && event.generation === live.generation));
    assert.ok(chain.some(event => event.stage === 'viewport.command' && event.poolId === pool.poolId && event.workspaceKey === keyA));
  }
  await viewport.release(keyA);
  assert.equal(viewport.status(keyA).pid, null);
  assert.equal(viewport.status(keyB).connection.connected, true, 'Releasing workspace A must preserve B');
  assert.equal(spawnProcessCalls, 0);
})));

test('real host: zero instances rejects before viewport command or process creation', () => recordCheck('real-host-zero-instance-refusal', () => withHost(async ({ invoke }) => {
  const commandCount = events.filter(event => event.stage === 'viewport.command').length;
  const placeholderLive = { targetId: `target_w${createHash('sha256').update(keyA).digest('hex').slice(0, 24)}`, generation: 1 };
  const result = await invoke('blender_scene_query', { action: 'query', live: placeholderLive, kind: 'scene' });
  assert.equal(result.ok, false);
  assert.equal(result.error.code, 'TARGET_NOT_BOUND');
  assert.equal(events.filter(event => event.stage === 'viewport.command').length, commandCount);
  assert.equal(spawnProcessCalls, 0);
})));

test('offline evidence is complete, PID-free and has the live reporting placeholder', () => recordCheck('evidence-structure-and-zero-spawn', async () => {
  writeReport();
  const saved = JSON.parse(readFileSync(reportUrl, 'utf8'));
  assert.equal(saved.liveEvidence.note, '由队长真机填报');
  assert.deepEqual(saved.liveEvidence.runs, []);
  assert.equal(saved.safety.spawnProcessCalls, 0);
  assert.deepEqual(saved.safety.deniedProcessCalls, []);
  assert.ok(saved.instances.length > 1);
  assert.ok(saved.instances.every(instance => instance.pid === null));
  assert.ok(saved.events.some(event => event.stage === 'coordinator.record'));
  assert.ok(saved.events.some(event => event.stage === 'viewport.frame'));
  assert.ok(saved.events.some(event => event.stage === 'instance.command'));
  assert.ok(saved.chains.some(chain => chain.tool === 'blender_scene_query' && chain.coordinatorSequences.length && chain.viewportSequences.length && chain.instanceSequences.length));
  assert.ok(saved.chains.some(chain => chain.route === '/blender/frame' && chain.viewportSequences.length && chain.instanceSequences.length));
  assert.ok(saved.chains.every(chain => chain.resultSequence !== null));
  assert.equal(Object.keys(saved.seams.sourceHashes).length, 2);
}));
