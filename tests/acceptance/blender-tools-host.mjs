import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHarness, createFakeConnectionService } from './harness.mjs';
import { TOOL_NAMES, validateToolOutput } from '../../tools/blender/schema.js';

const blenderNames = names => [...names].filter(name => name.startsWith('blender_')).sort();

test('real plugin register/when/dispatch uses Blender entry without a Web target and responds to configuration changes', async () => {
  const peer = { id: 'blender-surface-fixture' };
  const harness = await createHarness({ connection: createFakeConnectionService({ rejection: undefined, admit: () => ({ peer }), browserPeer: peer }) });
  const agent = { id: 'blender-host-agent', session: { header: { cwd: harness.workspaceDir } } };
  const exec = { agent, signal: AbortSignal.timeout(30000) };
  let revision = 0;
  const configure = async (enabled = true, providerEnabled = true, view = 'three-d') => {
    const result = await harness.request({ method: 'PUT', path: '/plugins/ui-testing/config', body: { expectedRevision: revision, scope: 'global', patch: { view, environment: view,
      enabledEnvironments: enabled ? ['web', 'three-d'] : ['web'], environments: { 'three-d': { enabled, providers: { blender: { enabled: providerEnabled } } } } } } });
    assert.equal(result.statusCode, 200, result.body); revision = result.json.revision;
  };
  try {
    assert.deepEqual(blenderNames(harness.toolNames()), []);
    await configure();
    assert.deepEqual(blenderNames(harness.toolNames()), [...TOOL_NAMES].sort());
    assert.deepEqual(blenderNames(await harness.evaluateAdmission(agent)), ['blender_capabilities', 'blender_tools']);
    const status = await harness.invoke('blender_tools', { action: 'status' }, exec);
    assert.equal(status.ok, true, JSON.stringify(status.error));
    assert.equal(validateToolOutput('blender_tools', status.value).valid, true);
    const activate = await harness.invoke('blender_tools', { action: 'activate', groups: ['view'] }, exec);
    assert.equal(activate.ok, true, JSON.stringify(activate.error));
    assert.deepEqual(blenderNames(await harness.evaluateAdmission(agent)), ['blender_capabilities', 'blender_capture', 'blender_control', 'blender_job', 'blender_tools', 'blender_view']);
    const control = await harness.invoke('blender_control', { action: 'status', resource: 'scene' }, exec);
    assert.equal(control.ok, true, JSON.stringify(control.error));
    assert.ok(control.value.data.challenge.grantId);
    assert.equal(validateToolOutput('blender_control', control.value).valid, true);
    const grant = control.value.data.challenge.grantId;
    const acquire = await harness.invoke('blender_control', { action: 'acquire', resource: 'scene', grantId: grant }, exec);
    assert.equal(acquire.ok, true, JSON.stringify(acquire.error));
    assert.notEqual(acquire.value.data.leaseId, grant);
    const invalid = await harness.invoke('blender_scene_query', { action: 'query', live: { targetId: 'target_invalid', generation: 1 }, kind: 'scene', python: 'forbidden' }, exec);
    assert.equal(invalid.ok, false); assert.equal(invalid.error.code, 'SCHEMA_INVALID');
    const unavailable = await harness.invoke('blender_job', { action: 'status', jobId: 'no_worker' }, exec);
    assert.equal(unavailable.error.code, 'TARGET_GONE'); // Registry is connected; this job was never registered.
    await configure(true, true, 'web');
    assert.deepEqual(blenderNames(await harness.evaluateAdmission(agent)), []);
    const denied = await harness.invoke('blender_tools', { action: 'status' }, exec);
    assert.equal(denied.ok, false); assert.equal(denied.error.code, 'ADAPTER_DISABLED');
    await configure(true, false);
    assert.deepEqual(blenderNames(harness.toolNames()), []);
    await configure(false);
    assert.deepEqual(blenderNames(harness.toolNames()), []);
  } finally { await harness.dispose(); }
});

test('independent Python executes the real tick/reply functions and keeps object.remove hash refusal', () => {
  const result = spawnSync('python', ['tests/acceptance/blender-tools-viewport.py'], { encoding: 'utf8', cwd: new URL('../..', import.meta.url), timeout: 30000 });
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.match(result.stderr, /Ran 4 tests/);
  assert.match(result.stderr, /OK/);
  console.log('PYTHON_TICK_EVIDENCE: 4 PASS / 0 FAIL; real AST functions, command/frame queue, four identity fields, hash negative; no Blender process');
});
