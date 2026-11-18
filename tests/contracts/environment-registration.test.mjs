/**
 * Environment registration boundary (plan docs/internal/host-runtime-panel-decoupling-plan.md).
 *
 * These assertions pin the direction of the dependency, not an implementation detail:
 *  - the public composition root imports `core/` only, so adding an environment never edits it;
 *  - every platform question (adapters, P0 provider, operation table, provider gate, readiness)
 *    is answered through a registration entry;
 *  - an entry is validated, and a Host with no registration reports "not wired" instead of
 *    guessing;
 *  - a non-Web environment can carry a whole dispatch round with nothing but its own entry.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  ENVIRONMENTS,
  ENVIRONMENT_ENTRY_VERSION,
  createEnvironmentDirectory,
  defineEnvironmentEntry,
} from '../../core/index.js';
import { createFakeEnvironmentEntry } from '../../targets/fake/environment.js';
import { createWebEnvironmentEntry } from '../../targets/web/environment.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = dirname(dirname(HERE));

function importSpecifiers(source) {
  const specs = [];
  const staticRe = /import\s+(?:[^'"]*?\s+from\s+)?['"]([^'"]+)['"]/g;
  const dynamicRe = /import\s*\(\s*['"]([^'"]+)['"]\s*\)/g;
  for (const re of [staticRe, dynamicRe]) {
    let match;
    while ((match = re.exec(source)) !== null) specs.push(match[1]);
  }
  return specs;
}

test('the public composition root imports no platform implementation', () => {
  const source = readFileSync(join(REPO_ROOT, 'integration', 'cross-environment.js'), 'utf8');
  const specs = importSpecifiers(source);
  assert.ok(specs.length > 0);
  for (const spec of specs) {
    assert.equal(spec.includes('targets/'), false, `cross-environment imports a platform: ${spec}`);
    assert.equal(/(^|\/)index\.js$/.test(spec) && spec !== '../core/index.js', false,
      `cross-environment imports the host entry: ${spec}`);
    assert.equal(spec.includes('browser-safety'), false, `cross-environment imports a Web module: ${spec}`);
  }
});

test('the Web registration entry imports core and its own platform modules only', () => {
  const source = readFileSync(join(REPO_ROOT, 'targets', 'web', 'environment.js'), 'utf8');
  for (const spec of importSpecifiers(source)) {
    const allowed = spec.startsWith('node:')
      || spec === '../../core/index.js'
      || spec === './adapter.js'
      || spec === './provider.js'
      || spec === './tabs.js';
    assert.ok(allowed, `web environment imports outside its layer: ${spec}`);
    assert.equal(spec.includes('integration/'), false, `web environment imports the host layer: ${spec}`);
  }
});

test('an entry is validated: identity and create() are mandatory', () => {
  assert.throws(() => defineEnvironmentEntry({}), /id/);
  assert.throws(() => defineEnvironmentEntry({ id: 'x' }), /create/);
  assert.throws(() => defineEnvironmentEntry({ id: '', create: () => ({}) }), /id/);
  const entry = defineEnvironmentEntry({ id: 'demo', create: () => ({}) });
  assert.equal(entry.version, ENVIRONMENT_ENTRY_VERSION);
  assert.equal(entry.label, 'demo');
  assert.equal(entry.testOnly, false);
  assert.equal(entry.operations, null);
  assert.equal(Object.isFrozen(entry), true);
});

test('a directory resolves an entry lazily, once, and disposes it exactly once', async () => {
  let created = 0;
  let disposed = 0;
  const directory = createEnvironmentDirectory({});
  directory.register({
    id: 'demo',
    create: () => {
      created += 1;
      return { targetAdapter: { id: 't' }, dispose: () => { disposed += 1; } };
    },
  });
  assert.equal(directory.has('demo'), true);
  assert.equal(created, 0, 'registration alone must not construct the implementation');
  const first = directory.instance('demo');
  const second = directory.instance('demo');
  assert.equal(first, second);
  assert.equal(created, 1);
  assert.deepEqual(directory.describe(), [{
    id: 'demo', label: 'demo', testOnly: false, instantiated: true, operations: 0, capabilities: [],
  }]);
  await directory.dispose();
  await directory.dispose();
  assert.equal(disposed, 1);
  assert.equal(directory.instance('demo'), null);
});

test('a directory without a registration answers "not wired" instead of guessing', () => {
  const directory = createEnvironmentDirectory({});
  assert.equal(directory.entry(ENVIRONMENTS.WEB), null);
  assert.equal(directory.instance(ENVIRONMENTS.WEB), null);
  assert.deepEqual(directory.describe(), []);
});

test('the Web and fake entries declare an id, an operation table and a capability list', () => {
  const web = createWebEnvironmentEntry({ BrowserError: Error });
  assert.equal(web.id, ENVIRONMENTS.WEB);
  assert.ok(Object.keys(web.operations).length >= 30, 'the Web entry owns the tool description table');
  assert.ok(web.capabilities.length > 0);
  assert.equal(web.testOnly, false);
  assert.equal(web.eager, false, 'the Web implementation must stay lazy (A14)');

  const fake = createFakeEnvironmentEntry({});
  assert.equal(fake.id, ENVIRONMENTS.FAKE);
  assert.equal(fake.testOnly, true);
  assert.equal(fake.eager, true);
});

test('diagnostics are declared by the environment, not by the Host', () => {
  // Plan §HTTP、WS 与诊断: "Web 的探测项归 Web 环境描述"; a fixture declares none, which the Host
  // must report as its own answer rather than as an empty success.
  const web = createWebEnvironmentEntry({ BrowserError: Error });
  assert.ok(web.diagnostics.allowedTools.includes('browser_snapshot'));
  assert.ok(web.diagnostics.probes.length >= 4, 'the Web environment offers its read-only probes');
  for (const probe of web.diagnostics.probes) {
    assert.equal(typeof probe.id, 'string');
    assert.equal(typeof probe.tool, 'string');
    assert.equal(typeof probe.args, 'object');
  }
  assert.deepEqual(web.diagnostics.probes.map((probe) => probe.id).sort(),
    ['computed-style', 'network-read', 'screenshot', 'snapshot']);

  const fake = createFakeEnvironmentEntry({});
  assert.deepEqual(fake.diagnostics.probes, [], 'a fixture that offers no probes says so by declaring none');
  assert.deepEqual(fake.diagnostics.allowedTools, []);
});

test('the Web entry answers the Host questions it declares', () => {
  const web = createWebEnvironmentEntry({ BrowserError: Error });
  const snapshot = {
    environment: ENVIRONMENTS.WEB,
    provider: 'chrome',
    enabledProviders: ['chrome'],
    environmentConfig: { enabled: true, providers: { chrome: { enabled: true } } },
  };
  // Provider gate: a snapshot naming an enabled implemented provider is not blocked.
  assert.equal(web.driver(snapshot).blocked, null);
  // Execution class: the table is the entry's own knowledge, not the Host's.
  assert.equal(typeof web.executionClassFor('browser_navigate', {}), 'string');
  assert.equal(web.executionClassFor('definitely_not_a_tool', {}), null);
  // Surface availability follows the configuration it is given, not a global.
  assert.equal(web.surfaceAvailable({ config: { global: { environments: { web: { enabled: true, providers: { chrome: { enabled: true } } } } }, workspaces: {} } }), true);
  assert.equal(web.surfaceAvailable({ config: { global: { environments: { web: { enabled: true, providers: { chrome: { enabled: false } } } } }, workspaces: {} } }), false);
  // Admission refuses a Web tool while the provider gate is blocked, and says nothing about others.
  // An unknown provider is the block the entry can answer from the snapshot alone.
  const blocked = { ...snapshot, provider: 'safari' };
  assert.notEqual(web.driver(blocked).blocked, null);
  assert.equal(web.admitTool('browser_navigate', blocked), false);
  assert.equal(web.admitTool('browser_fake_probe', blocked), undefined);
  // Probe with no target is a truthful not-probed, never an invented failure.
  assert.equal(web.probeCapabilities({ entry: null, checkedAt: 1 }).status, 'not-probed');
});
