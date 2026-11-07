/**
 * Web runtime provider slice ② — driver gating and runtime ownership.
 *
 * Everything here runs headless: `resolveWebDriver` is pure, and `RuntimeRegistry` is exercised with
 * its own (never-spawned) `BrowserHost` objects. No Chromium, no CDP, no user config directory.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { RuntimeRegistry } from '../../index.js';
import {
  DEFAULT_WEB_PROVIDER,
  ERROR_CODES,
  IMPLEMENTED_WEB_PROVIDERS,
  WEB_PROVIDER_SUPPORT,
} from '../../core/index.js';
import { createWebTargetAdapter, resolveWebDriver } from '../../targets/web/adapter.js';

const log = { debug() {}, info() {}, warn() {}, error() {} };

function snapshotWith(overrides = {}) {
  return {
    revision: 3,
    environment: 'web',
    adapterId: 'web',
    enabledEnvironments: ['web'],
    capabilities: ['web.t1'],
    enabledProviders: ['chrome'],
    ...overrides,
  };
}

function registry() {
  return new RuntimeRegistry({ log, ctx: {}, origins: new Set() });
}

test('resolveWebDriver maps support + config policy onto the §4.4 vocabulary', () => {
  // supported + enabled -> executable, chrome is the default for a snapshot without the field
  const legacy = resolveWebDriver(snapshotWith());
  assert.equal(legacy.provider, DEFAULT_WEB_PROVIDER);
  assert.equal(legacy.executionAdapterId, 'web-chrome');
  assert.equal(legacy.support, 'supported');
  assert.equal(legacy.implemented, true);
  assert.equal(legacy.blocked, null);
  assert.equal(legacy.errorCode, null);

  // slice ③: edge is implemented now, so it is no longer blocked as driver-pending
  const edge = resolveWebDriver(snapshotWith({ provider: 'edge' }));
  assert.equal(edge.provider, 'edge');
  assert.equal(edge.executionAdapterId, 'web-edge');
  assert.equal(edge.support, 'supported');
  assert.equal(edge.implemented, true);
  assert.equal(edge.blocked, null);
  assert.equal(edge.errorCode, null);

  // unsupported (firefox) and unknown names are both ADAPTER_UNSUPPORTED, distinct reasons
  assert.equal(resolveWebDriver(snapshotWith({ provider: 'firefox' })).blocked, 'provider-unsupported');
  const unknown = resolveWebDriver(snapshotWith({ provider: 'safari' }));
  assert.equal(unknown.blocked, 'unknown-provider');
  assert.equal(unknown.errorCode, ERROR_CODES.ADAPTER_UNSUPPORTED);
  assert.equal(unknown.support, null);

  // config policy outranks engineering support: a disabled provider is ADAPTER_DISABLED
  for (const reason of ['provider-disabled', 'environment-disabled']) {
    const disabled = resolveWebDriver(snapshotWith({ provider: 'edge', source: { rejectedProviderReason: reason } }));
    assert.equal(disabled.blocked, reason, reason);
    assert.equal(disabled.errorCode, ERROR_CODES.ADAPTER_DISABLED, reason);
  }
  const disabledChrome = resolveWebDriver(snapshotWith({ source: { rejectedProviderReason: 'environment-disabled' } }));
  assert.equal(disabledChrome.errorCode, ERROR_CODES.ADAPTER_DISABLED);
});

test('the implemented set is derived from the support table', () => {
  assert.deepEqual([...IMPLEMENTED_WEB_PROVIDERS], ['chrome', 'edge']);
  assert.equal(WEB_PROVIDER_SUPPORT.edge, 'supported');
  assert.equal(WEB_PROVIDER_SUPPORT.firefox, 'unsupported');
});

test('runtime entries are keyed by (provider, workspace) and one composer makes the key', () => {
  const reg = registry();
  const scope = { id: 'ws:1', workspaceId: 'ws1' };
  const chromeEntry = reg.getOrCreate({ key: 'ws:1', scope, provider: 'chrome' });
  assert.equal(chromeEntry.provider, 'chrome');
  assert.equal(chromeEntry.baseKey, 'ws:1');
  assert.equal(chromeEntry.providerResolved, 'binding');
  assert.equal(chromeEntry.key, 'chrome\u0000ws:1');
  assert.equal(chromeEntry.primaryKey, chromeEntry.key);

  // Same workspace, different provider -> a different runtime, never shared.
  const edgeEntry = reg.getOrCreate({ key: 'ws:1', scope, provider: 'edge' });
  assert.notEqual(edgeEntry.key, chromeEntry.key);
  assert.notEqual(edgeEntry.runtime, chromeEntry.runtime);
  assert.equal(edgeEntry.baseKey, chromeEntry.baseKey);

  // Both addressing styles must compute a byte-identical key.
  assert.equal(reg.peek(chromeEntry.key), chromeEntry);
  assert.equal(reg.peek({ key: 'ws:1', provider: 'chrome' }), chromeEntry);
  assert.equal(reg.peek({ key: 'ws:1', provider: 'edge' }), edgeEntry);
  assert.equal(reg.peek('chrome\u0000ws:1').key, reg.peek({ key: 'ws:1', provider: 'chrome' }).key);
  assert.equal(reg.peek({ key: 'ws:9', provider: 'chrome' }), undefined);
  void reg.dispose();
});

test('providerResolved marks every fallback as recent, even with a single provider', () => {
  const reg = registry();
  const scope = { id: 'ws:f', workspaceId: 'wsf' };
  const explicit = reg.getOrCreate({ key: 'ws:f', scope, provider: 'chrome' });
  assert.equal(reg.providerFacts(explicit, { key: 'ws:f', provider: 'chrome' }).providerResolved, 'binding');
  assert.equal(reg.providerFacts(explicit, { key: 'ws:f' }).providerResolved, 'recent');

  // Unknown provider on the lookup: fall back to what last touched this workspace, and say so.
  const fallbackLookup = { key: 'ws:f' };
  assert.equal(reg.providerFor(fallbackLookup).provider, 'chrome');
  assert.equal(reg.providerFor(fallbackLookup).providerResolved, 'recent');
  assert.equal(reg.getOrCreate(fallbackLookup), explicit, 'the fallback resolves to the same entry');
  assert.equal(reg.providerFacts(explicit, fallbackLookup).provider, 'chrome');

  // A workspace nobody touched yet falls back to the default provider, still reported as recent.
  const cold = reg.providerFor({ key: 'ws:never' });
  assert.equal(cold.provider, DEFAULT_WEB_PROVIDER);
  assert.equal(cold.providerResolved, 'recent');
  void reg.dispose();
});

test('hosts are per provider, page budget is the sum against one ceiling', () => {
  const reg = registry();
  assert.equal(reg.host, undefined, 'no host exists before anything is created');
  assert.equal(reg.hostFor('edge'), undefined, 'hostFor never invents or substitutes a host');

  reg.getOrCreate({ key: 'ws:c', scope: { id: 'ws:c' }, provider: 'chrome' });
  reg.getOrCreate({ key: 'ws:e', scope: { id: 'ws:e' }, provider: 'edge' });
  assert.deepEqual([...reg.hosts.keys()].sort(), ['chrome', 'edge']);
  assert.notEqual(reg.hostFor('chrome'), reg.hostFor('edge'), 'each provider owns its own host');
  assert.equal(reg.host, reg.hostFor('chrome'), 'the compat accessor only ever exposes the default slot');
  assert.equal(reg.hostFor('firefox'), undefined);

  // pageCount sums both hosts; a budget check compares that sum with the *same* maxPages.
  // `BrowserHost.pageCount` is a read-only getter, so the page counts are stubbed on the container.
  assert.equal(reg.maxPages, reg.capabilities().maxPages);
  let chromePages = 5;
  let edgePages = 5;
  reg.hosts.set('chrome', { pageCount: chromePages, close: async () => {} });
  reg.hosts.set('edge', { pageCount: edgePages, close: async () => {} });
  assert.equal(reg.pageCount, chromePages + edgePages, 'splitting hosts must not halve the count');
  assert.ok(reg.pageCount > reg.maxPages, 'two hosts together can exceed the single ceiling (that is the point)');
  assert.throws(
    () => reg.reservePopupSlot(reg.peek({ key: 'ws:c', provider: 'chrome' })),
    (error) => {
      assert.equal(error.code, 'TAB_LIMIT');
      assert.equal(error.details.maxPages, reg.maxPages, 'one shared ceiling, not one per provider');
      return true;
    },
  );

  // Dropping a page on one host drops the total by the same amount (no per-host ceiling).
  reg.hosts.set('edge', { pageCount: 0, close: async () => {} });
  chromePages = 1;
  reg.hosts.set('chrome', { pageCount: chromePages, close: async () => {} });
  assert.equal(reg.pageCount, chromePages);
  void reg.dispose();
});

test('closing one provider leaves the other provider running', async () => {
  const reg = registry();
  const chromeEntry = reg.getOrCreate({ key: 'ws:x', scope: { id: 'ws:x' }, provider: 'chrome' });
  const edgeEntry = reg.getOrCreate({ key: 'ws:x', scope: { id: 'ws:x' }, provider: 'edge' });
  const edgeHost = reg.hostFor('edge');
  let closed = 0;
  reg.hostFor('chrome').close = async () => { closed += 1; };

  const result = await reg.closeProvider('chrome');
  assert.equal(result.provider, 'chrome');
  assert.equal(closed, 1, 'only the chrome host is closed');
  assert.equal(reg.hostFor('chrome'), undefined);
  assert.equal(reg.hostFor('edge'), edgeHost, 'the edge host survives untouched');
  assert.equal(reg.peek({ key: 'ws:x', provider: 'chrome' }), undefined);
  assert.equal(reg.peek({ key: 'ws:x', provider: 'edge' }), edgeEntry, 'the other provider entry survives');
  assert.notEqual(reg.entries.size, 0);
  assert.equal(reg.providerFor({ key: 'ws:x' }).provider, 'edge', 'the fallback now points at the survivor');
  void chromeEntry;
  await reg.dispose();
});

test('probe resolves the provider vendor without launching (edge: executable-missing here)', async () => {
  const adapter = createWebTargetAdapter({});
  const chromeReport = await adapter.probe({ scope: { id: 'p' }, snapshot: snapshotWith({ provider: 'chrome' }) });
  assert.equal(chromeReport.axes.dependency.evidence.provider, 'chrome');
  assert.notEqual(chromeReport.axes.dependency.reason, 'provider-driver-pending');

  const edgeReport = await adapter.probe({ scope: { id: 'p' }, snapshot: snapshotWith({ provider: 'edge' }) });
  // This machine has no Edge binary: "implemented but dependency missing", and the evidence never
  // borrows chrome's executable path.
  assert.equal(edgeReport.axes.dependency.evidence.provider, 'edge');
  assert.equal(edgeReport.axes.dependency.evidence.version, null, 'no version is ever invented');
  assert.equal(edgeReport.axes.dependency.evidence.path, null);
  assert.equal(edgeReport.axes.dependency.status, 'failed');
  assert.equal(edgeReport.axes.dependency.reason, 'executable-missing');
  await adapter.dispose();
});
