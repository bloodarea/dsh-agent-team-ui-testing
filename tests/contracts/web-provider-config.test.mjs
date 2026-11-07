/**
 * Web runtime provider (chrome/edge/firefox) — config and selection layer.
 *
 * Slice ① of docs/internal/web-runtime-provider-contract.md: `environments.web.provider` +
 * `environments.web.providers.<id>.enabled` storage, legacy normalization, deep provider patches,
 * the provider selection chain and the "no silent browser swap" rule. Everything here is pure
 * config resolution plus temp-dir ConfigStore I/O; no browser, no network, no host config dir.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  ConfigStore,
  DEFAULT_CONFIG,
  IMPLEMENTED_WEB_PROVIDERS,
  WEB_PROVIDERS,
  WEB_PROVIDER_SUPPORT,
  capabilitiesForEnvironment,
  isImplementedWebProvider,
  normalizeConfig,
  resolveSnapshot,
  validatePatch,
  webProviderSupport,
  workspaceKeyOf,
} from '../../core/index.js';

async function tempDir(t) {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-provider-config-'));
  t.after(async () => {
    await rm(dir, { recursive: true, force: true });
  });
  return dir;
}

function assertCode(code) {
  return (error) => {
    assert.equal(error?.code, code, `expected ${code}, got ${error?.code}: ${error?.message}`);
    return true;
  };
}

const DEFAULT_PROVIDERS = {
  chrome: { enabled: true },
  edge: { enabled: false },
  firefox: { enabled: false },
};

test('provider support is a single truth: chrome/edge supported, firefox unsupported', () => {
  assert.deepEqual({ ...WEB_PROVIDERS }, { CHROME: 'chrome', EDGE: 'edge', FIREFOX: 'firefox' });
  assert.deepEqual({ ...WEB_PROVIDER_SUPPORT }, { chrome: 'supported', edge: 'supported', firefox: 'unsupported' });
  assert.equal(webProviderSupport('edge'), 'supported');
  assert.equal(webProviderSupport('safari'), null);
  assert.equal(isImplementedWebProvider('chrome'), true);
  assert.equal(isImplementedWebProvider('edge'), true, 'slice ③ wired the Edge launcher');
  assert.equal(isImplementedWebProvider('firefox'), false);
  assert.equal(isImplementedWebProvider('safari'), false);
  // The derived set is the only place registration/readiness/execution may consult.
  assert.deepEqual([...IMPLEMENTED_WEB_PROVIDERS], ['chrome', 'edge']);
});

test('legacy web config without provider fields normalizes to chrome and keeps version 1', () => {
  const legacy = normalizeConfig({
    version: 1,
    revision: 4,
    global: {
      environment: 'web',
      enabledEnvironments: ['web'],
      environments: { web: { enabled: true, targetId: null } },
    },
    workspaces: { '/w': { environments: { web: { enabled: true } } } },
    sessions: { s1: { environment: 'web' } },
  });

  assert.equal(legacy.version, 1, 'adding provider fields must not bump the schema version');
  assert.equal(legacy.revision, 4);
  assert.equal(legacy.global.environments.web.provider, 'chrome');
  assert.deepEqual(legacy.global.environments.web.providers, DEFAULT_PROVIDERS);
  // Normalization is idempotent: a second pass must not drift the shape.
  assert.deepEqual(normalizeConfig(legacy), legacy);
  // Partial (workspace) entries stay sparse so they keep inheriting from global.
  assert.deepEqual(legacy.workspaces['/w'].environments.web, { enabled: true });

  const snapshot = resolveSnapshot(legacy, {});
  assert.equal(snapshot.provider, 'chrome');
  assert.equal(snapshot.executionAdapterId, 'web-chrome');
  assert.deepEqual(snapshot.enabledProviders, ['chrome']);
  assert.equal(snapshot.source.rejectedProvider, null);
  assert.equal(snapshot.source.degraded, false);
});

test('normalizeConfig rejects malformed provider fields and provider fields outside web', () => {
  for (const value of [
    { global: { environments: { web: { provider: 1 } } } },
    { global: { environments: { web: { provider: '' } } } },
    { global: { environments: { web: { providers: { edge: { enabled: 'yes' } } } } } },
    { global: { environments: { web: { providers: { edge: { executable: '' } } } } } },
    { global: { environments: { fake: { provider: 'chrome' } } } },
    { global: { environments: { fake: { providers: { chrome: { enabled: true } } } } } },
    { sessions: { s1: { webProvider: 1 } } },
  ]) {
    assert.throws(() => normalizeConfig(value), assertCode('CONFIG_INVALID'), JSON.stringify(value));
  }

  // Unknown provider ids are dropped on load (forward-compatible), never invented.
  const dropped = normalizeConfig({ global: { environments: { web: { providers: { safari: { enabled: true } } } } } });
  assert.deepEqual(dropped.global.environments.web.providers, DEFAULT_PROVIDERS);
  assert.equal(Object.hasOwn(dropped.global.environments.web.providers, 'safari'), false);
});

test('an unknown provider name is preserved on load and blocks instead of swapping browsers', async (t) => {
  // Structurally valid but unknown name: keeping it must never be turned into "corrupt config".
  const kept = normalizeConfig({
    version: 1,
    revision: 2,
    global: { environment: 'web', enabledEnvironments: ['web'], environments: { web: { provider: 'safari' } } },
    sessions: { s1: { webProvider: 'safari' } },
  });
  assert.equal(kept.global.environments.web.provider, 'safari', 'unknown name is kept verbatim');
  assert.deepEqual(kept.global.environments.web.providers, DEFAULT_PROVIDERS, 'saved switches survive');
  assert.equal(kept.sessions.s1.webProvider, 'safari');
  assert.deepEqual(normalizeConfig(kept), kept, 'normalization stays idempotent');

  const snapshot = resolveSnapshot(kept, {});
  assert.equal(snapshot.provider, 'safari', 'no silent fallback to chrome');
  assert.equal(snapshot.executionAdapterId, 'web-safari');
  assert.equal(snapshot.providerConfig.enabled, false);
  assert.equal(snapshot.providerConfig.implemented, false);
  assert.deepEqual(snapshot.enabledProviders, ['chrome'], 'derived switches are unaffected');
  assert.equal(snapshot.source.rejectedProvider, 'safari');
  assert.equal(snapshot.source.rejectedProviderReason, 'unknown-provider');

  const sessionSnapshot = resolveSnapshot(
    normalizeConfig({ sessions: { s1: { webProvider: 'safari' } } }),
    { agent: { id: 's1' } },
  );
  assert.equal(sessionSnapshot.provider, 'safari');
  assert.equal(sessionSnapshot.source.rejectedProviderReason, 'unknown-provider');

  // The whole point: a config file carrying an unknown name still loads, and a later write keeps it.
  const dir = await tempDir(t);
  await writeFile(join(dir, 'config.json'), JSON.stringify({
    version: 1,
    revision: 5,
    global: {
      environment: 'web',
      enabledEnvironments: ['web'],
      environments: { web: { enabled: true, targetId: null, provider: 'safari', providers: { chrome: { enabled: true } } } },
    },
    workspaces: { '/w': { environment: 'web' } },
    sessions: { s1: { environment: 'web' } },
  }, null, 2), 'utf8');

  const store = new ConfigStore({ dir });
  store.load();
  assert.equal(store.loadError, null, 'an unknown provider name is not a corrupt config');
  assert.equal(store.getConfig().revision, 5, 'loading never bumps the revision');
  assert.equal(store.getConfig().version, 1);
  assert.equal(store.getConfig().global.environments.web.provider, 'safari');
  assert.equal(store.resolveForAgent({ id: 's1' }).source.rejectedProviderReason, 'unknown-provider');

  const written = store.write({
    expectedRevision: 5,
    scope: 'global',
    patch: { environments: { web: { providers: { edge: { enabled: true } } } } },
  });
  assert.equal(written.revision, 6);
  const onDisk = JSON.parse(await readFile(join(dir, 'config.json'), 'utf8'));
  assert.equal(onDisk.global.environments.web.provider, 'safari', 'the unusable selection is not rewritten');
  assert.equal(onDisk.global.environments.web.providers.edge.enabled, true);
  assert.equal(onDisk.version, 1);

  // Write path stays strict: a client cannot introduce an unknown name.
  assert.throws(
    () => store.write({ expectedRevision: 6, scope: 'global', patch: { environments: { web: { provider: 'safari' } } } }),
    (error) => {
      assert.equal(error.code, 'CONFIG_INVALID');
      assert.equal(error.details.field, 'environments.web.provider');
      assert.deepEqual(error.details.allowed, ['chrome', 'edge', 'firefox']);
      return true;
    },
  );
  assert.throws(
    () => store.select({ scope: 'session', agentId: 's1', webProvider: 'safari', expectedRevision: 6 }),
    assertCode('CONFIG_INVALID'),
  );
  assert.equal(store.getConfig().revision, 6, 'rejected writes never bump the revision');
});

test('a workspace-scoped unknown provider is preserved and blocks', () => {
  const config = normalizeConfig({
    global: { environment: 'web', enabledEnvironments: ['web'], environments: { web: { provider: 'chrome' } } },
    workspaces: { '/w': { environments: { web: { provider: 'safari' } } } },
  });
  assert.equal(config.workspaces['/w'].environments.web.provider, 'safari', 'workspace value is kept verbatim');

  const snapshot = resolveSnapshot(config, { agent: { id: 'a1' }, workspaceKey: '/w' });
  assert.equal(snapshot.provider, 'safari', 'the workspace selection is never swapped for the global one');
  assert.equal(snapshot.providerConfig.implemented, false);
  assert.equal(snapshot.source.providerSource, 'workspace');
  assert.equal(snapshot.source.inheritedProviderFrom, 'workspace');
  assert.equal(snapshot.source.rejectedProvider, 'safari');
  assert.equal(snapshot.source.rejectedProviderReason, 'unknown-provider');

  // A session can still choose a valid provider over the broken workspace value.
  const overridden = normalizeConfig({
    ...config,
    sessions: { s9: { webProvider: 'chrome' } },
  });
  const fixed = resolveSnapshot(overridden, { agent: { id: 's9' }, workspaceKey: '/w' });
  assert.equal(fixed.provider, 'chrome');
  assert.equal(fixed.source.rejectedProvider, null);
});

test('blocking precedence: the web total gate outranks an unknown provider name', () => {
  const off = normalizeConfig({
    global: {
      environment: 'web',
      enabledEnvironments: ['web'],
      environments: { web: { enabled: false, provider: 'safari' } },
    },
  });
  const snapshot = resolveSnapshot(off, {});
  assert.equal(snapshot.provider, 'safari', 'the unusable name is still kept');
  assert.equal(snapshot.source.rejectedProvider, 'safari');
  assert.equal(
    snapshot.source.rejectedProviderReason,
    'environment-disabled',
    'total gate first: nothing can execute until web.enabled is true',
  );

  // Gate on -> the unknown name becomes the reported cause.
  const on = normalizeConfig({
    global: {
      environment: 'web',
      enabledEnvironments: ['web'],
      environments: { web: { enabled: true, provider: 'safari' } },
    },
  });
  assert.equal(resolveSnapshot(on, {}).source.rejectedProviderReason, 'unknown-provider');

  // Known-but-disabled stays distinct from unknown.
  const disabled = normalizeConfig({
    global: {
      environment: 'web',
      enabledEnvironments: ['web'],
      environments: { web: { enabled: true, provider: 'edge' } },
    },
  });
  assert.equal(resolveSnapshot(disabled, {}).source.rejectedProviderReason, 'provider-disabled');
});

test('web snapshot exposes provider, executionAdapterId, enabledProviders and providerConfig', () => {
  const snapshot = resolveSnapshot(DEFAULT_CONFIG, {});
  assert.equal(snapshot.environment, 'web', 'environment must stay "web"');
  assert.equal(snapshot.adapterId, 'web', 'adapterId must stay "web" for the facade identity');
  assert.equal(snapshot.provider, 'chrome');
  assert.equal(snapshot.executionAdapterId, 'web-chrome');
  assert.deepEqual(snapshot.enabledProviders, ['chrome']);
  assert.deepEqual(snapshot.providerConfig, {
    provider: 'chrome',
    support: 'supported',
    enabled: true,
    executable: null,
    connection: null,
    implemented: true,
  });
  assert.deepEqual(snapshot.capabilities, capabilitiesForEnvironment('web'));
  assert.ok(Object.isFrozen(snapshot.providerConfig), 'providerConfig must be frozen with the snapshot');
  assert.ok(Object.isFrozen(snapshot.enabledProviders));
});

test('non-web snapshots carry no provider facts', () => {
  const config = normalizeConfig({
    global: { environment: 'fake', enabledEnvironments: ['web', 'fake'] },
  });
  const snapshot = resolveSnapshot(config, {}, { allowTestEnvironments: true });
  assert.equal(snapshot.environment, 'fake');
  assert.equal(snapshot.adapterId, 'fake');
  assert.equal(snapshot.executionAdapterId, 'fake', 'no provider suffix outside web');
  assert.equal(snapshot.provider, null);
  assert.equal(snapshot.providerConfig, null);
  assert.deepEqual(snapshot.enabledProviders, []);
});

test('provider selection chain: session > parent > workspace > global', () => {
  const config = normalizeConfig({
    global: {
      environment: 'web',
      enabledEnvironments: ['web'],
      environments: { web: { provider: 'edge', providers: { edge: { enabled: true } } } },
    },
    workspaces: { '/w': { environments: { web: { provider: 'firefox' } } } },
    sessions: {
      own: { webProvider: 'chrome' },
      parent: { webProvider: 'edge' },
      child: { parentSession: 'parent' },
      cycleA: { parentSession: 'cycleB' },
      cycleB: { parentSession: 'cycleA' },
    },
  });

  const own = resolveSnapshot(config, { agent: { id: 'own' }, workspaceKey: '/w' });
  assert.equal(own.provider, 'chrome');
  assert.equal(own.source.providerSource, 'own');
  assert.equal(own.source.inheritedProviderFrom, null);
  assert.deepEqual(own.enabledProviders, ['chrome', 'edge'], 'workspace only overrides the provider');

  const inherited = resolveSnapshot(config, { agent: { id: 'child' }, workspaceKey: '/w' });
  assert.equal(inherited.provider, 'edge', "parent's effective provider wins over workspace");
  assert.equal(inherited.source.providerSource, 'parent');
  assert.equal(inherited.source.inheritedProviderFrom, 'parent');

  const fromWorkspace = resolveSnapshot(config, { agent: { id: 'other' }, workspaceKey: '/w' });
  assert.equal(fromWorkspace.provider, 'firefox');
  assert.equal(fromWorkspace.source.providerSource, 'workspace');
  assert.equal(fromWorkspace.source.inheritedProviderFrom, 'workspace');
  assert.equal(fromWorkspace.providerConfig.implemented, false);
  assert.equal(fromWorkspace.source.rejectedProvider, 'firefox');
  assert.equal(fromWorkspace.source.rejectedProviderReason, 'provider-disabled');

  const fromGlobal = resolveSnapshot(config, { agent: { id: 'other' }, workspaceKey: '/g' });
  assert.equal(fromGlobal.provider, 'edge');
  assert.equal(fromGlobal.source.providerSource, 'global');

  const cycle = resolveSnapshot(config, { agent: { id: 'cycleA' } });
  assert.equal(cycle.provider, 'edge', 'a parent cycle must fall back to global, not hang');
  assert.equal(cycle.source.providerSource, 'global');

  assert.throws(
    () => resolveSnapshot(config, { agent: { id: 'own' } }).source.providerSource = 'x',
    TypeError,
    'snapshots stay frozen',
  );
});

test('a disabled provider is kept in the snapshot and reported, never swapped', () => {
  const config = normalizeConfig({
    global: {
      environment: 'web',
      enabledEnvironments: ['web'],
      environments: { web: { provider: 'edge', targetId: 'g' } },
    },
  });
  const snapshot = resolveSnapshot(config, {});
  assert.equal(snapshot.provider, 'edge', 'selection is preserved');
  assert.equal(snapshot.executionAdapterId, 'web-edge');
  assert.equal(snapshot.providerConfig.enabled, false);
  assert.deepEqual(snapshot.enabledProviders, ['chrome'], 'derived switches, not the selection');
  assert.equal(snapshot.source.rejectedProvider, 'edge');
  assert.equal(snapshot.source.rejectedProviderReason, 'provider-disabled');
  assert.equal(snapshot.targetId, null, 'a chrome runtime targetId must not follow edge');

  // Enabling the provider resumes the same selection: no rewrite happened in between.
  const enabled = normalizeConfig({
    global: {
      environment: 'web',
      enabledEnvironments: ['web'],
      environments: {
        web: { provider: 'edge', providers: { edge: { enabled: true } }, targetId: 'g' },
      },
    },
  });
  const resumed = resolveSnapshot(enabled, {});
  assert.equal(resumed.provider, 'edge');
  assert.equal(resumed.providerConfig.enabled, true);
  assert.equal(resumed.source.rejectedProvider, null);
  assert.equal(resumed.source.rejectedProviderReason, null);
  assert.deepEqual(resumed.enabledProviders, ['chrome', 'edge']);
  assert.equal(resumed.targetId, null, 'legacy targetId stays a chrome-only field');
});

test('the web total switch off blocks every provider but keeps stored switches', () => {
  const off = normalizeConfig({
    global: {
      environment: 'web',
      enabledEnvironments: ['web'],
      environments: { web: { enabled: false, provider: 'chrome' } },
    },
  });
  const snapshot = resolveSnapshot(off, {});
  assert.equal(snapshot.provider, 'chrome');
  assert.equal(snapshot.providerConfig.enabled, true, 'the per-provider switch value is not erased');
  assert.deepEqual(snapshot.enabledProviders, ['chrome']);
  assert.equal(snapshot.source.rejectedProvider, 'chrome');
  assert.equal(snapshot.source.rejectedProviderReason, 'environment-disabled');

  const back = normalizeConfig({
    global: {
      environment: 'web',
      enabledEnvironments: ['web'],
      environments: { web: { enabled: true, provider: 'chrome' } },
    },
  });
  assert.equal(resolveSnapshot(back, {}).source.rejectedProvider, null);
});

test('firefox may be enabled in config; the missing driver is reported, not faked', () => {
  const config = normalizeConfig({
    global: {
      environment: 'web',
      enabledEnvironments: ['web'],
      environments: { web: { provider: 'firefox', providers: { firefox: { enabled: true } } } },
    },
  });
  const snapshot = resolveSnapshot(config, {});
  assert.deepEqual(snapshot.enabledProviders, ['chrome', 'firefox']);
  assert.equal(snapshot.provider, 'firefox');
  assert.equal(snapshot.providerConfig.enabled, true);
  assert.equal(snapshot.providerConfig.implemented, false, 'execution layer must answer ADAPTER_UNSUPPORTED');
  assert.equal(snapshot.source.rejectedProvider, null, 'a config-layer rejection is not an implementation gap');
});

test('per-provider executable/connection never leak to another provider', () => {
  const configFor = (provider) => normalizeConfig({
    global: {
      environment: 'web',
      enabledEnvironments: ['web'],
      environments: {
        web: {
          provider,
          connection: { endpoint: 'cdp://legacy-chrome' },
          providers: {
            chrome: { enabled: true, executable: '/opt/google/chrome/chrome' },
            edge: { enabled: true },
          },
        },
      },
    },
  });

  const chrome = resolveSnapshot(configFor('chrome'), {});
  assert.equal(chrome.providerConfig.executable, '/opt/google/chrome/chrome');
  assert.deepEqual(chrome.providerConfig.connection, { endpoint: 'cdp://legacy-chrome' }, 'legacy connection is chrome-scoped');
  assert.deepEqual(chrome.environmentConfig.connection, { endpoint: 'cdp://legacy-chrome' });

  const edge = resolveSnapshot(configFor('edge'), {});
  assert.equal(edge.providerConfig.executable, null, "chrome's executable override must not be inherited");
  assert.equal(edge.providerConfig.connection, null, "chrome's legacy connection must not be inherited");
});

test('global provider patches deep-merge sibling provider switches', async (t) => {
  const dir = await tempDir(t);
  const store = new ConfigStore({ dir });
  store.load();

  store.write({
    expectedRevision: 0,
    scope: 'global',
    patch: { environments: { web: { provider: 'edge', providers: { edge: { enabled: true } } } } },
  });
  assert.deepEqual(store.getConfig().global.environments.web, {
    enabled: true,
    targetId: null,
    provider: 'edge',
    providers: { chrome: { enabled: true }, edge: { enabled: true }, firefox: { enabled: false } },
  });

  store.write({
    expectedRevision: 1,
    scope: 'global',
    patch: { environments: { web: { providers: { firefox: { enabled: true } } } } },
  });
  const web = store.getConfig().global.environments.web;
  assert.deepEqual(web.providers, {
    chrome: { enabled: true },
    edge: { enabled: true },
    firefox: { enabled: true },
  });
  assert.equal(web.provider, 'edge', 'a switches-only patch must not touch the selection');
  assert.equal(web.enabled, true);

  const snapshot = store.resolveForAgent({ id: 'a1' });
  assert.deepEqual(snapshot.enabledProviders, ['chrome', 'edge', 'firefox']);
  assert.equal(snapshot.provider, 'edge');
});

test('workspace provider patches are sparse and merge over global per provider', async (t) => {
  const dir = await tempDir(t);
  const store = new ConfigStore({ dir });
  const workspaceKey = workspaceKeyOf({ cwd: dir });
  store.load();

  store.write({
    expectedRevision: 0,
    scope: 'workspace',
    workspaceKey,
    patch: { environments: { web: { provider: 'edge' } } },
  });
  assert.deepEqual(store.getConfig().workspaces[workspaceKey].environments.web, { provider: 'edge' });
  assert.equal(store.getConfig().global.environments.web.provider, 'chrome', 'global is untouched');

  store.write({
    expectedRevision: 1,
    scope: 'workspace',
    workspaceKey,
    patch: { environments: { web: { providers: { edge: { enabled: true } } } } },
  });
  const workspaceProviders = store.getConfig().workspaces[workspaceKey].environments.web.providers;
  assert.deepEqual(workspaceProviders, { edge: { enabled: true } }, 'workspace switch stays sparse');

  // A second workspace switch must not drop the first one (the pre-fix shallow merge did).
  store.write({
    expectedRevision: 2,
    scope: 'workspace',
    workspaceKey,
    patch: { environments: { web: { providers: { chrome: { enabled: true } } } } },
  });
  assert.deepEqual(
    store.getConfig().workspaces[workspaceKey].environments.web.providers,
    { edge: { enabled: true }, chrome: { enabled: true } },
  );

  const agent = { id: 'a1', session: { header: { cwd: dir } } };
  const snapshot = store.resolveForAgent(agent);
  assert.equal(snapshot.provider, 'edge');
  assert.deepEqual(snapshot.enabledProviders, ['chrome', 'edge']);
  assert.equal(snapshot.providerConfig.enabled, true);
  assert.equal(snapshot.source.providerSource, 'workspace');
  assert.deepEqual(snapshot.environmentConfig.providers.chrome, { enabled: true });
});

test('a partial patch without provider keys never materializes defaults over the selection', async (t) => {
  const dir = await tempDir(t);
  const store = new ConfigStore({ dir });
  store.load();
  store.write({
    expectedRevision: 0,
    scope: 'global',
    patch: { environments: { web: { provider: 'edge' } } },
  });
  assert.deepEqual(store.getConfig().global.environments.web.providers, DEFAULT_PROVIDERS);
  assert.equal(store.getConfig().global.environments.web.provider, 'edge');
  assert.equal(store.getConfig().global.environments.web.enabled, true);

  // A patch that only touches `enabled` must leave the provider and its switches alone.
  store.write({
    expectedRevision: 1,
    scope: 'global',
    patch: { environments: { web: { enabled: false } } },
  });
  assert.equal(store.getConfig().global.environments.web.provider, 'edge');
  assert.deepEqual(store.getConfig().global.environments.web.providers, DEFAULT_PROVIDERS);

  // Unknown provider patch keys are rejected instead of silently dropped.
  assert.throws(
    () => store.write({
      scope: 'global',
      patch: { environments: { web: { providers: { edge: { enable: true } } } } },
    }),
    (error) => {
      assert.equal(error.code, 'CONFIG_INVALID');
      assert.equal(error.details.field, 'environments.web.providers.edge.enable');
      return true;
    },
  );
  assert.throws(
    () => store.write({ scope: 'global', patch: { environments: { web: { provider: 'safari' } } } }),
    (error) => {
      assert.equal(error.code, 'CONFIG_INVALID');
      assert.equal(error.details.field, 'environments.web.provider');
      assert.equal(error.details.provider, 'safari');
      return true;
    },
  );
  assert.equal(store.getConfig().revision, 2, 'rejected patches must not bump the revision');
});

test('a legacy config file on disk loads without CONFIG_INVALID and keeps revision/version', async (t) => {
  const dir = await tempDir(t);
  const legacy = {
    version: 1,
    revision: 7,
    global: {
      environment: 'web',
      enabledEnvironments: ['web'],
      environments: { web: { enabled: true, targetId: null }, fake: { enabled: false, targetId: null } },
    },
    workspaces: { '/w': { environment: 'web' } },
    sessions: { s1: { environment: 'web', targetId: 't1' } },
  };
  await writeFile(join(dir, 'config.json'), JSON.stringify(legacy, null, 2), 'utf8');

  const store = new ConfigStore({ dir });
  store.load();
  assert.equal(store.loadError, null, 'a legacy config is not corrupt');
  const loaded = store.getConfig();
  assert.equal(loaded.version, 1);
  assert.equal(loaded.revision, 7, 'loading never bumps the revision');
  assert.equal(loaded.global.environments.web.provider, 'chrome');
  assert.deepEqual(loaded.global.environments.web.providers, DEFAULT_PROVIDERS);
  assert.deepEqual(loaded.sessions.s1, { environment: 'web', targetId: 't1' }, 'unrelated session fields survive');

  const snapshot = store.resolveForAgent({ id: 's1' });
  assert.equal(snapshot.environment, 'web');
  assert.equal(snapshot.provider, 'chrome');
  assert.equal(snapshot.source.rejectedProvider, null);

  // The first write persists the normalized shape, still at schema version 1.
  store.write({
    expectedRevision: 7,
    scope: 'global',
    patch: { environments: { web: { providers: { edge: { enabled: true } } } } },
  });
  const onDisk = JSON.parse(await readFile(join(dir, 'config.json'), 'utf8'));
  assert.equal(onDisk.version, 1);
  assert.equal(onDisk.revision, 8);
  assert.deepEqual(onDisk.global.environments.web.providers, {
    chrome: { enabled: true },
    edge: { enabled: true },
    firefox: { enabled: false },
  });
});

test('provider writes bump the revision exactly once; reads and loads never bump it', async (t) => {
  const dir = await tempDir(t);
  const store = new ConfigStore({ dir });
  store.load();
  store.load();
  store.getConfig();
  store.resolveForAgent({ id: 'a1' });
  store.resolveForScope({ id: 'a1', cwd: dir });
  assert.equal(store.getConfig().revision, 0);

  const first = store.write({
    expectedRevision: 0,
    scope: 'global',
    patch: { environments: { web: { provider: 'edge' } } },
  });
  assert.equal(first.revision, 1);
  assert.equal(first.config.revision, 1);

  store.getConfig();
  store.resolveForAgent({ id: 'a1' });
  store.load();
  assert.equal(store.getConfig().revision, 1, 'reads are not writes');

  assert.throws(
    () => store.write({
      expectedRevision: 0,
      scope: 'global',
      patch: { environments: { web: { provider: 'chrome' } } },
    }),
    assertCode('CONFIG_CONFLICT'),
  );
  assert.equal(store.getConfig().revision, 1);
  assert.equal(store.getConfig().global.environments.web.provider, 'edge');

  const second = store.write({
    expectedRevision: 1,
    scope: 'global',
    patch: { environments: { web: { providers: { edge: { enabled: true } } } } },
  });
  assert.equal(second.revision, 2);
  assert.equal(JSON.parse(await readFile(join(dir, 'config.json'), 'utf8')).revision, 2);
});

test('provider selection and switches survive a restart; no derived list is persisted', async (t) => {
  const dir = await tempDir(t);
  const store = new ConfigStore({ dir });
  store.load();
  store.write({
    expectedRevision: 0,
    scope: 'global',
    patch: { environments: { web: { provider: 'edge', providers: { edge: { enabled: true } } } } },
  });

  const text = await readFile(join(dir, 'config.json'), 'utf8');
  const onDisk = JSON.parse(text);
  assert.equal(onDisk.version, 1);
  assert.equal(onDisk.global.environments.web.provider, 'edge');
  assert.equal(onDisk.global.environments.web.providers.edge.enabled, true);
  assert.equal(text.includes('enabledProviders'), false, 'enabledProviders is derived, never stored');
  assert.equal(Object.hasOwn(onDisk.global, 'enabledProviders'), false);

  const reloaded = new ConfigStore({ dir });
  reloaded.load();
  assert.equal(reloaded.getConfig().revision, 1);
  const snapshot = reloaded.resolveForAgent({ id: 'a1' });
  assert.equal(snapshot.provider, 'edge');
  assert.deepEqual(snapshot.enabledProviders, ['chrome', 'edge']);
  assert.equal(snapshot.source.rejectedProvider, null);
});

test('select() writes session webProvider and global/workspace provider selection', async (t) => {
  const dir = await tempDir(t);
  const store = new ConfigStore({ dir });
  const workspaceKey = workspaceKeyOf({ cwd: dir });
  store.load();

  store.select({ scope: 'session', agentId: 's1', webProvider: 'edge', expectedRevision: 0 });
  assert.deepEqual(store.getConfig().sessions.s1, { webProvider: 'edge' });
  const sessionSnap = store.resolveForAgent({ id: 's1', session: { header: { cwd: dir } } });
  assert.equal(sessionSnap.provider, 'edge');
  assert.equal(sessionSnap.source.providerSource, 's1');
  assert.equal(sessionSnap.source.rejectedProviderReason, 'provider-disabled');

  store.select({ scope: 'workspace', workspaceKey, webProvider: 'chrome', expectedRevision: 1 });
  assert.equal(store.getConfig().workspaces[workspaceKey].environments.web.provider, 'chrome');

  store.select({ scope: 'global', webProvider: 'edge', expectedRevision: 2 });
  assert.equal(store.getConfig().global.environments.web.provider, 'edge');
  assert.equal(store.getConfig().revision, 3);

  // A session may choose, never change enablement policy.
  assert.throws(
    () => store.write({
      expectedRevision: 3,
      scope: 'session',
      agentId: 's1',
      patch: { webProvider: 'chrome', providers: { edge: { enabled: false } } },
    }),
    assertCode('CONFIG_INVALID'),
  );
  assert.equal(store.getConfig().revision, 3, 'the rejected session patch changed nothing');
  assert.deepEqual(store.getConfig().sessions.s1, { webProvider: 'edge' });
  assert.throws(() => store.select({ scope: 'session', agentId: 's1' }), assertCode('CONFIG_INVALID'));
  assert.throws(
    () => validatePatch({ scope: 'session', patch: { webProvider: 'safari' } }),
    (error) => {
      assert.equal(error.code, 'CONFIG_INVALID');
      assert.equal(error.details.field, 'session.webProvider');
      return true;
    },
  );
  assert.deepEqual(validatePatch({ scope: 'session', patch: { webProvider: null } }), { webProvider: null });

  // Clearing a session selection re-inherits the lower scopes instead of pinning "no provider".
  store.select({ scope: 'session', agentId: 's1', webProvider: null, expectedRevision: 3 });
  assert.deepEqual(store.getConfig().sessions.s1, { webProvider: null });
  const cleared = store.resolveForAgent({ id: 's1', session: { header: { cwd: dir } } });
  assert.equal(cleared.provider, 'chrome', 'the workspace selection applies again');
  assert.equal(cleared.source.providerSource, 'workspace');

  // A provider is never "unset" at environment scope.
  assert.throws(
    () => store.select({ scope: 'global', webProvider: null, expectedRevision: 4 }),
    (error) => {
      assert.equal(error.code, 'CONFIG_INVALID');
      assert.equal(error.details.field, 'environments.web.provider');
      return true;
    },
  );
  assert.equal(store.getConfig().revision, 4);
});
