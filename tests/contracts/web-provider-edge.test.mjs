/**
 * Slice ③ — Edge driver parameterization (vendor launcher, override, identity, profile).
 *
 * No browser is started: every case injects `platform`/`env` and inspects the resolution result, the
 * product-identity branch, or the registry's provider-aware host. Edge's real launch is **unverified**
 * on this machine (no Edge binary) — these tests prove the parameterization, not that Edge works.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { RuntimeRegistry } from '../../index.js';
import {
  IMPLEMENTED_WEB_PROVIDERS,
  WEB_PROVIDER_REASONS,
  WEB_PROVIDER_SUPPORT,
} from '../../core/index.js';
import {
  WEB_PROVIDER_ENV,
  providerExecutableCandidates,
  resolveProviderExecutable,
  resolveWebDriver,
  verifyProviderProduct,
} from '../../targets/web/adapter.js';

const log = { debug() {}, info() {}, warn() {}, error() {} };

test('edge is implemented (single switch point) and no longer driver-pending', () => {
  assert.equal(WEB_PROVIDER_SUPPORT.edge, 'supported');
  assert.deepEqual([...IMPLEMENTED_WEB_PROVIDERS], ['chrome', 'edge']);
  const driver = resolveWebDriver({ environment: 'web', provider: 'edge', enabledEnvironments: ['web'] });
  assert.equal(driver.support, 'supported');
  assert.equal(driver.implemented, true);
  assert.equal(driver.blocked, null);
  assert.notEqual(driver.blocked, WEB_PROVIDER_REASONS.DRIVER_PENDING);
  // firefox stays a configurable-but-unimplemented provider
  assert.equal(resolveWebDriver({ environment: 'web', provider: 'firefox' }).blocked,
    WEB_PROVIDER_REASONS.PROVIDER_UNSUPPORTED);
});

test('candidate lists are per vendor and never mix', () => {
  const linuxChrome = providerExecutableCandidates({ provider: 'chrome', platform: 'linux', env: {} });
  const linuxEdge = providerExecutableCandidates({ provider: 'edge', platform: 'linux', env: {} });
  assert.ok(linuxChrome.includes('/opt/google/chrome/chrome'), 'chrome candidates unchanged');
  assert.ok(linuxEdge.includes('/usr/bin/microsoft-edge'));
  assert.ok(linuxEdge.includes('/usr/bin/microsoft-edge-stable'));
  assert.ok(linuxEdge.includes('/opt/microsoft/msedge/msedge'));
  assert.equal(linuxEdge.some((path) => /chrome|chromium/i.test(path)), false, 'edge list has no chrome');
  assert.equal(linuxChrome.some((path) => /edge|msedge/i.test(path)), false, 'chrome list has no edge');

  const winEdge = providerExecutableCandidates({ provider: 'edge', platform: 'win32', env: { PROGRAMFILES: 'C:\\PF', 'PROGRAMFILES(X86)': 'C:\\PF86', LOCALAPPDATA: 'C:\\LA' } });
  assert.ok(winEdge.every((path) => /msedge\.exe$/i.test(path)));
  assert.ok(winEdge.some((path) => /Microsoft[\\/]Edge[\\/]Application/i.test(path)));

  const macEdge = providerExecutableCandidates({ provider: 'edge', platform: 'darwin', env: {} });
  assert.ok(macEdge.every((path) => path.includes('Microsoft Edge') && path.includes('/Contents/MacOS/')));
});

test('one override variable per provider; an unusable override never falls back to the other vendor', () => {
  assert.deepEqual({ ...WEB_PROVIDER_ENV }, { chrome: 'DSH_UI_TESTING_CHROME', edge: 'DSH_UI_TESTING_EDGE' });

  // Edge override points at a path that does not exist -> reported, not "let's try Chrome".
  const bad = resolveProviderExecutable({
    provider: 'edge',
    platform: 'linux',
    env: { DSH_UI_TESTING_EDGE: '/nonexistent/msedge', DSH_UI_TESTING_CHROME: '/bin/sh' },
  });
  assert.equal(bad.path, null);
  assert.equal(bad.source, 'override');
  assert.equal(bad.reason, WEB_PROVIDER_REASONS.OVERRIDE_INVALID);
  assert.deepEqual(bad.candidates, ['/nonexistent/msedge'], 'only the operator value is tried');
  assert.equal(bad.candidates.some((path) => /chrome/i.test(path)), false);

  // An empty override is an operator error, not a silent search.
  const empty = resolveProviderExecutable({ provider: 'edge', platform: 'linux', env: { DSH_UI_TESTING_EDGE: '   ' } });
  assert.equal(empty.path, null);
  assert.equal(empty.reason, WEB_PROVIDER_REASONS.OVERRIDE_INVALID);

  // A usable override is authoritative even when the other vendor is installed.
  const good = resolveProviderExecutable({ provider: 'edge', platform: 'linux', env: { DSH_UI_TESTING_EDGE: '/bin/sh' } });
  assert.equal(good.path, '/bin/sh');
  assert.equal(good.reason, null);
  assert.equal(good.source, 'override');

  // The chrome variable is not consulted for edge: no cross-vendor inheritance.
  const isolated = resolveProviderExecutable({ provider: 'edge', platform: 'linux', env: { DSH_UI_TESTING_CHROME: '/bin/sh' } });
  assert.equal(isolated.source, 'search');
  assert.equal(isolated.path, null, 'this machine has no Edge binary; chrome is never substituted');

  // And the chrome variable still means chrome only.
  const chrome = resolveProviderExecutable({ provider: 'chrome', platform: 'linux', env: { DSH_UI_TESTING_CHROME: '/bin/sh' } });
  assert.equal(chrome.path, '/bin/sh');
  assert.equal(chrome.source, 'override');
});

test('product identity is table-driven: edge fails closed, chrome is opportunistic', () => {
  // edge: must carry the Edge vendor token
  const edgeOk = verifyProviderProduct({ provider: 'edge', version: { product: 'Edg/121.0.2277.83' } });
  assert.equal(edgeOk.ok, true);
  assert.equal(edgeOk.verified, true);
  assert.equal(edgeOk.reason, null);

  // A Chrome endpoint under an edge label is refused, with the mismatch reason.
  const chromeUnderEdge = verifyProviderProduct({ provider: 'edge', version: { product: 'Chrome/121.0.6167.85' } });
  assert.equal(chromeUnderEdge.ok, false);
  assert.equal(chromeUnderEdge.verified, true);
  assert.equal(chromeUnderEdge.reason, WEB_PROVIDER_REASONS.IDENTITY_MISMATCH);
  assert.equal(chromeUnderEdge.product, 'Chrome/121.0.6167.85');

  // No evidence: fatal for edge (fail closed), tolerated for chrome (its startup path is unchanged).
  for (const version of [null, {}, { product: '' }]) {
    const edgeMissing = verifyProviderProduct({ provider: 'edge', version });
    assert.equal(edgeMissing.ok, false, JSON.stringify(version));
    assert.equal(edgeMissing.verified, false);
    assert.equal(edgeMissing.reason, WEB_PROVIDER_REASONS.IDENTITY_UNVERIFIED);
    const chromeMissing = verifyProviderProduct({ provider: 'chrome', version });
    assert.equal(chromeMissing.ok, true, 'chrome must not gain a new failure mode');
    assert.equal(chromeMissing.verified, false);
    assert.equal(chromeMissing.reason, null);
  }

  // chrome: must be Chrome and must not be an Edge endpoint (reverse mismatch is caught too).
  const chromeOk = verifyProviderProduct({ provider: 'chrome', version: { product: 'Chrome/121.0.6167.85' } });
  assert.equal(chromeOk.ok, true);
  assert.equal(chromeOk.verified, true);
  const edgeUnderChrome = verifyProviderProduct({ provider: 'chrome', version: { product: 'Edg/121.0.0.0' } });
  assert.equal(edgeUnderChrome.ok, false);
  assert.equal(edgeUnderChrome.reason, WEB_PROVIDER_REASONS.IDENTITY_MISMATCH);
  assert.deepEqual(edgeUnderChrome.forbidden, ['Edg/']);

  // An unknown provider has no rule: it can never be proven, so it is never let through.
  const unknown = verifyProviderProduct({ provider: 'firefox', version: { product: 'Chrome/121.0.6167.85' } });
  assert.equal(unknown.ok, false);
  assert.equal(unknown.expected, null);
  assert.equal(verifyProviderProduct({ provider: 'safari', version: null }).ok, false);
});

test('the vendor rules live in one table so a new vendor is one line', async () => {
  const { WEB_PROVIDER_VENDOR } = await import('../../core/contracts.js');
  assert.deepEqual({ ...WEB_PROVIDER_VENDOR.chrome }, {
    requires: ['Chrome/'], forbids: ['Edg/'], failClosedOnMissing: false,
  });
  assert.deepEqual({ ...WEB_PROVIDER_VENDOR.edge }, {
    requires: ['Edg/'], forbids: [], failClosedOnMissing: true,
  });
  assert.equal(WEB_PROVIDER_VENDOR.firefox, undefined, 'firefox has no driver, so no identity rule');
});

test('each provider host carries its own provider identity and headed profile', async () => {
  const registry = new RuntimeRegistry({ log, ctx: {}, origins: new Set() });
  const chromeHost = registry.browserHost('chrome');
  const edgeHost = registry.browserHost('edge');
  assert.equal(chromeHost.provider, 'chrome');
  assert.equal(edgeHost.provider, 'edge');
  assert.notEqual(chromeHost, edgeHost, 'the registry never reuses one host across providers');

  const chromeProfile = chromeHost.headedProfileDir();
  const edgeProfile = edgeHost.headedProfileDir();
  assert.notEqual(chromeProfile, edgeProfile, 'headed profiles must not be shared across vendors');
  assert.match(chromeProfile, /headed-profile$/, 'chrome keeps its historical directory');
  assert.match(edgeProfile, /headed-profile-edge$/);
  await registry.dispose();
});
