/**
 * Public dispatch works with a non-Web contract fixture (plan §1 完成条件).
 *
 * The point is not that the fixture works — it is *what it costs*: a fixture session must be able
 * to complete a whole tool round through the public Host seams (registration, admission,
 * disclosure, adapter dispatch and the evidence envelope) while the Web runtime stays untouched:
 * no page entry, no browser host, no Chromium process.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHarness, createFakeConnectionService } from '../acceptance/harness.mjs';
import { createFakeEnvironmentEntry } from '../../targets/fake/environment.js';
import { createWebEnvironmentEntry } from '../../targets/web/environment.js';

const PROBE = 'browser_fake_probe';
const SCOPED = { 'x-ui-testing-scope-version': '1', 'x-ui-testing-session-id': 'fixture-agent' };

function connection() {
  return createFakeConnectionService({
    admit: () => ({ peer: { id: 'fixture-peer' } }),
    browserPeer: { id: 'fixture-peer' },
  });
}

test('the fixture owns its probe; the Web surface does not define it', () => {
  const fake = createFakeEnvironmentEntry({});
  assert.deepEqual(fake.tools.map((tool) => tool.name), [PROBE]);
  assert.equal(typeof fake.tools[0].execute, 'function');
  const web = createWebEnvironmentEntry({ BrowserError: Error });
  assert.equal((web.tools ?? []).some((tool) => tool.name === PROBE), false,
    'a platform-neutral fixture tool must not live in the Web tool surface');
});

test('a fixture round completes with zero Web runtime resources', async (t) => {
  const harness = await createHarness({
    name: 'dispatch-without-web',
    allowTestEnvironments: true,
    connection: connection(),
  });
  t.after(() => harness.dispose());
  const agent = { id: 'fixture-agent', session: { header: { cwd: harness.workspaceDir } } };
  const exec = () => ({ agent, signal: AbortSignal.timeout(15000) });

  const configured = await harness.request({ method: 'GET', path: '/plugins/ui-testing/config', headers: SCOPED });
  const enabled = await harness.request({
    method: 'PUT',
    path: '/plugins/ui-testing/config',
    headers: SCOPED,
    body: { expectedRevision: configured.json.revision, scope: 'global', patch: { environments: { fake: { enabled: true } } } },
  });
  assert.equal(enabled.statusCode, 200, JSON.stringify(enabled.json).slice(0, 200));
  const selected = await harness.request({
    method: 'POST',
    path: '/plugins/ui-testing/config/select',
    headers: SCOPED,
    body: { scope: 'session', environment: 'fake', expectedRevision: enabled.json.revision },
  });
  assert.equal(selected.statusCode, 200, JSON.stringify(selected.json).slice(0, 200));

  const result = await harness.invoke(PROBE, { payload: { hello: 'fixture' } }, exec());
  assert.equal(result.ok, true, result.error?.message);
  // The value is the fixture adapter's own envelope: the Host adds identity, not interpretation.
  assert.equal(result.value.operation, 'fake.t1.echo');
  assert.equal(result.value.environment ?? 'fake', 'fake');
  assert.ok(result.value.actionId, 'the public envelope is still applied');

  // Nothing on the Web side was constructed: no page entry, no browser host, no page count.
  const registry = harness.ctx?.__internal?.plugin?.registry;
  if (registry) {
    assert.equal(registry.pageCount, 0, 'no page may be created for a fixture call');
    assert.equal(registry.entries.size, 0, 'no runtime entry may be created for a fixture call');
    assert.equal(registry.hosts.size, 0, 'no browser host may be started for a fixture call');
  }
});
