/**
 * A Web-disabled host pays nothing for the Web environment (plan §2 完成条件).
 *
 * Two different things must be true, and only the first one used to be measured:
 *   1. no browser process is started, and
 *   2. the Web-only module chain (frame source, capture pipeline, vision, network collector …) is
 *      never even resolved.
 *
 * The probe below answers the second one through the plugin's own read-only facts, so "zero Web
 * execution module load" is an observation instead of a claim.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHarness, createFakeConnectionService } from '../acceptance/harness.mjs';
import { webHostModuleFacts } from '../../index.js';

const SCOPED = { 'x-ui-testing-scope-version': '1', 'x-ui-testing-session-id': 'idle-agent' };

function connection() {
  return createFakeConnectionService({
    admit: () => ({ peer: { id: 'idle-peer' } }),
    browserPeer: { id: 'idle-peer' },
  });
}

test('a Web-disabled host answers the public surfaces without loading the Web module chain', async (t) => {
  const harness = await createHarness({
    name: 'web-module-lazy',
    allowTestEnvironments: true,
    connection: connection(),
  });
  t.after(() => harness.dispose());
  const agent = { id: 'idle-agent', session: { header: { cwd: harness.workspaceDir } } };
  const exec = () => ({ agent, signal: AbortSignal.timeout(15000) });

  // Start from "Web disabled": the fixture is enabled, Web is not.
  const configured = await harness.request({ method: 'GET', path: '/plugins/ui-testing/config', headers: SCOPED });
  const disabled = await harness.request({
    method: 'PUT',
    path: '/plugins/ui-testing/config',
    headers: SCOPED,
    body: {
      expectedRevision: configured.json.revision,
      scope: 'global',
      patch: { environments: { web: { enabled: false }, fake: { enabled: true } } },
    },
  });
  assert.equal(disabled.statusCode, 200, JSON.stringify(disabled.json).slice(0, 200));

  // Public surfaces that must keep answering on a Web-disabled host.
  for (const path of ['/plugins/ui-testing/config', '/plugins/ui-testing/readiness']) {
    const response = await harness.request({ method: 'GET', path, headers: SCOPED });
    assert.ok(response.statusCode === 200, `${path} answered ${response.statusCode}`);
  }
  // Discovery/selection is host-local state: it must answer without resolving the Web chain.
  const discovery = await harness.invoke('browser_tools', { action: 'status' }, exec());
  assert.equal(discovery.ok, true, discovery.error?.message);

  const facts = webHostModuleFacts();
  assert.equal(facts.loaded, false,
    'config, readiness and the discovery entry must answer without loading the Web-only module chain');
  assert.deepEqual(facts.namespaces, []);
  assert.equal(facts.failed, null);

  // The page-capability diagnostics describe the Web matrix, so they resolve the chain on demand —
  // and must still answer truthfully with no page when the environment is not Web.
  const state = await harness.invoke('browser_state', {}, exec());
  assert.equal(state.ok, true, state.error?.message);
  assert.equal(state.value.mode, 'idle', 'a non-Web environment reports an idle projection, not a page');
  assert.equal(state.value.running, false);

  const registry = harness.ctx?.__internal?.plugin?.registry;
  if (registry) {
    assert.equal(registry.pageCount, 0, 'no page may exist');
    assert.equal(registry.hosts.size, 0, 'no browser host may exist');
  }
});

test('the Web module chain loads on the first real Web demand', async (t) => {
  const harness = await createHarness({
    name: 'web-module-lazy-onbar',
    allowTestEnvironments: true,
    connection: connection(),
  });
  t.after(() => harness.dispose());
  const before = webHostModuleFacts();
  const agent = { id: 'web-agent', session: { header: { cwd: harness.workspaceDir } } };
  // `browser_capabilities` reports the Web capability matrix; it resolves the chain on demand.
  const result = await harness.invoke('browser_capabilities', {}, { agent, signal: AbortSignal.timeout(20000) });
  assert.equal(result.ok, true, result.error?.message);
  const after = webHostModuleFacts();
  if (!before.loaded) {
    assert.equal(after.loaded, true, 'the first Web demand resolves the module chain');
    assert.ok(after.namespaces.length > 0, 'the resolved namespaces are reported');
  }
});
