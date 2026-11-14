/** Web TargetTabs dispatch and real browser_tabs registration, all without launching a browser. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BrowserError, asBrowserError } from '../../browser-safety.js';
import { TARGET_TABS_ACTIONS } from '../../core/index.js';
import { createCrossEnvironment } from '../../integration/cross-environment.js';
import { createWebTargetAdapter } from '../../targets/web/adapter.js';
import { createWebTargetTabs } from '../../targets/web/tabs.js';
import { createHarness } from '../acceptance/harness.mjs';

function fixture() {
  const calls = [];
  const primary = { tabId: 'primary', scope: { id: 'tabs-scope' }, runtime: { generation: 1 } };
  const target = { tabId: 'child', scope: primary.scope, runtime: { generation: 1 } };
  const selection = { tabId: 'child', observationTabId: 'primary' };
  const principal = { id: 'owner-principal' };
  const signal = new AbortController().signal;
  const exec = { primaryEntry: primary, sessionId: 'actor', principal, signal, runtime: primary.runtime };
  const own = {
    tabId: 'child', accessVersion: 1, rootSessionId: 'root', creatorSessionId: 'creator',
    ownerSessionId: 'owner', controllerSessionId: 'actor', ownershipRevision: 3,
    controlRevision: 7, accessState: 'owned', permissions: { write: true },
  };
  const record = (method, result) => (...args) => { calls.push([method, ...args]); return result; };
  const registry = {
    entries: new Map([['primary', primary], ['child', target]]),
    listTabs: record('listTabs', [own]),
    selectionFor: record('selectionFor', selection),
    confirmSelection: record('confirmSelection', { ...selection, confirmedResetReason: 'retired' }),
    noticesView: record('noticesView', [{ reason: 'popup-limit' }]),
    recentClosedView: record('recentClosedView', [{ tabId: 'gone', reason: 'closed' }]),
    selectTab: record('selectTab', { entry: target, selection }),
    openTab: record('openTab', { entry: target, selection }),
    closeTab: record('closeTab', { closed: 'child' }),
    tabEntry: record('tabEntry', target),
    primaryEntry: record('primaryEntry', primary),
    controlProjection: record('controlProjection', { controlRevision: 7 }),
    acquireControl: record('acquireControl', { changed: true, waitedMs: 12 }),
    releaseControl: record('releaseControl', { changed: true }),
    transferControl: record('transferControl', { changed: true, to: 'member' }),
    waitForTab: record('waitForTab', { matched: true, matchedTab: { tabId: 'child' }, elapsedMs: 1, polls: 1 }),
  };
  const providerRow = { tabId: 'child', title: 'P0 row', source: 'gui-popup', controlRevision: 0 };
  const tabs = createWebTargetTabs({
    registry, BrowserError,
    listTargets: record('p0List', { tabs: [providerRow] }),
  });
  return { tabs, calls, primary, target, selection, principal, signal, exec, registry, own, providerRow };
}

const hasCode = (expected) => (error) => { assert.equal(error.code, expected); return true; };

test('Web TargetAdapter tabs is optional and stores the supplied service', async () => {
  const plain = createWebTargetAdapter();
  assert.equal(Object.hasOwn(plain, 'tabs'), false);
  const { tabs } = fixture();
  const wired = createWebTargetAdapter({ tabs });
  assert.equal(wired.tabs, tabs);
  assert.equal(tabs.environment, 'web');
  assert.deepEqual(tabs.actions, TARGET_TABS_ACTIONS);
  await plain.dispose();
  await wired.dispose();
});

test('list uses the P0 projection and enriches ACL, selection, popup and retirement fields', async () => {
  const f = fixture();
  const result = await f.tabs.invoke({ action: 'list' }, f.exec);
  assert.equal(result.ok, true);
  assert.equal(result.tabs[0].title, f.providerRow.title);
  assert.equal(result.tabs[0].source, 'gui-popup');
  for (const [key, value] of Object.entries(f.own)) assert.deepEqual(result.tabs[0][key], value);
  assert.equal(result.selection, f.selection);
  assert.equal(result.workSelection, f.selection);
  assert.equal(result.observationSelection.tabId, 'primary');
  assert.deepEqual(result.notices, [{ reason: 'popup-limit' }]);
  assert.deepEqual(result.recentClosed, [{ tabId: 'gone', reason: 'closed' }]);
  assert.deepEqual(f.calls.find(([method]) => method === 'p0List').slice(1), [f.exec, f.primary]);
  assert.deepEqual(f.calls.find(([method]) => method === 'listTabs').slice(1), [f.primary, 'actor', f.principal]);
});

test('current confirms only its selection; select trims targets and forwards observe/work without a lease', async () => {
  const f = fixture();
  const current = await f.tabs.invoke({ action: 'current' }, f.exec);
  assert.equal(current.confirmedResetReason, 'retired');
  assert.equal(current.tabId, 'child');
  assert.deepEqual(f.calls.map(([method]) => method), ['confirmSelection']);
  for (const mode of ['observe', undefined]) {
    const selected = await f.tabs.invoke({ action: 'select', tabId: '  child  ', ...(mode ? { mode } : {}) }, f.exec);
    assert.equal(selected.claimed, false);
    assert.equal(selected.mode, mode ?? 'work');
    assert.deepEqual(f.calls.at(-1), ['selectTab', f.primary, 'actor', 'child', { mode: mode ?? 'work', principal: f.principal }]);
  }
});

test('open and close delegate to the existing registry lifecycle and preserve close fallback', async () => {
  const f = fixture();
  const opened = await f.tabs.invoke({ action: 'open' }, f.exec);
  assert.equal(opened.tabId, 'child');
  assert.deepEqual(f.calls.at(-1), ['openTab', f.primary, 'actor', 'agent', { principal: f.principal }]);
  for (const args of [{ action: 'close' }, { action: 'close', tabId: null }, { action: 'close', tabId: '  ' }, { action: 'close', tabId: ' child ' }]) {
    const closed = await f.tabs.invoke(args, f.exec);
    assert.equal(closed.tabId, 'child');
    assert.deepEqual(closed.control, { controlRevision: 7 });
    assert.deepEqual(f.calls.filter(([method]) => method === 'closeTab').at(-1),
      ['closeTab', f.primary, 'actor', 'child', { principal: f.principal }]);
  }
});

test('management delegates CAS revisions, principal, drain timeout and cancellation unchanged', async () => {
  const f = fixture();
  const acquired = await f.tabs.invoke({ action: 'acquire', tabId: ' child ', expectedControlRevision: 7, timeoutMs: 0 }, f.exec);
  assert.equal(acquired.waitedMs, 12);
  assert.deepEqual(f.calls.find(([method]) => method === 'acquireControl'), [
    'acquireControl', f.target, f.principal, { expectedControlRevision: 7, timeoutMs: 0, signal: f.signal },
  ]);
  await f.tabs.invoke({ action: 'release', tabId: 'child', expectedControlRevision: 7 }, f.exec);
  assert.deepEqual(f.calls.find(([method]) => method === 'releaseControl'), [
    'releaseControl', f.target, f.principal, { expectedControlRevision: 7 },
  ]);
  const transferred = await f.tabs.invoke({ action: 'transfer', tabId: 'child', toSessionId: 'member', expectedControlRevision: 7, expectedOwnershipRevision: 3 }, f.exec);
  assert.equal(transferred.to, 'member');
  assert.deepEqual(f.calls.find(([method]) => method === 'transferControl'), [
    'transferControl', f.target, f.principal, { toSessionId: 'member', expectedControlRevision: 7, expectedOwnershipRevision: 3 },
  ]);
});

test('wait owns Web-only filter enums, budgets and defaults, preserving null filter and signal', async () => {
  const f = fixture();
  const result = await f.tabs.invoke({ action: 'wait', tabId: null }, f.exec);
  assert.equal(result.matched, true);
  assert.deepEqual(f.calls.at(-1), ['waitForTab', f.primary, 'actor', {
    tabId: null, kind: null, source: null, timeoutMs: 5000, pollMs: 100,
  }, f.signal]);
  await f.tabs.invoke({ action: 'wait', tabId: ' child ', kind: 'tab', source: 'gui-popup', timeoutMs: 0, pollMs: 50 }, f.exec);
  assert.deepEqual(f.calls.at(-1), ['waitForTab', f.primary, 'actor', {
    tabId: 'child', kind: 'tab', source: 'gui-popup', timeoutMs: 0, pollMs: 50,
  }, f.signal]);
  f.calls.length = 0;
  for (const request of [
    { action: 'wait', kind: 'scene-editor' }, { action: 'wait', source: 'workspace-import' },
    { action: 'wait', timeoutMs: 30001 }, { action: 'wait', pollMs: 49 },
    { action: 'select', mode: 'unsupported', tabId: 'child' }, { action: 'select', tabId: 'x'.repeat(129) },
  ]) await assert.rejects(f.tabs.invoke(request, f.exec), hasCode('INVALID_ARGUMENT'));
  assert.deepEqual(f.calls, [], 'invalid Web arguments must not reach the registry');
});

test('platform permission, CAS, busy and wait failures pass through with original details', async () => {
  for (const [request, method, errorCode] of [
    [{ action: 'select', tabId: 'child' }, 'selectTab', 'TAB_FORBIDDEN'],
    [{ action: 'acquire', tabId: 'child', expectedControlRevision: 7 }, 'acquireControl', 'BUSY'],
    [{ action: 'release', tabId: 'child', expectedControlRevision: 7 }, 'releaseControl', 'TAB_CONTROL_CHANGED'],
    [{ action: 'transfer', tabId: 'child', toSessionId: 'member', expectedControlRevision: 7, expectedOwnershipRevision: 3 }, 'transferControl', 'TAB_OWNERSHIP_STALE'],
    [{ action: 'wait', timeoutMs: 0 }, 'waitForTab', 'WAIT_TIMEOUT'],
  ]) {
    const f = fixture();
    const failure = new BrowserError(errorCode, 'registry refused', { marker: method });
    f.registry[method] = () => { throw failure; };
    await assert.rejects(f.tabs.invoke(request, f.exec), (error) => error === failure);
  }
});

test('composition root sends admitted browser_tabs through TargetAdapter.tabs and keeps P0-E projection', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'target-tabs-root-'));
  const f = fixture();
  const root = createCrossEnvironment({
    registry: f.registry, BrowserError, asBrowserError,
    env: { DSH_UI_TESTING_CONFIG_DIR: dir },
  });
  t.after(async () => {
    await root.dispose();
    assert.ok(dir.startsWith(join(tmpdir(), 'target-tabs-root-')));
    await rm(dir, { recursive: true, force: true });
  });
  root.ensureWebRegistered();
  const adapter = root.webTargetAdapter;
  const service = adapter.tabs;
  let invoked = 0;
  adapter.tabs = { ...service, invoke: (args, exec) => { invoked += 1; return service.invoke(args, exec); } };
  const result = await root.invokeTool({
    name: 'browser_tabs', args: { action: 'list' }, executionClass: 'tabs',
    runtime: f.primary.runtime, entry: f.primary, resolvedScope: { id: 'tabs-scope' },
    exec: { signal: f.signal },
    thunk: () => root.invokeTabs({ action: 'list' }, f.exec),
  });
  assert.equal(invoked, 1);
  assert.equal(result.tabs[0].tabId, 'child');
  assert.equal(f.calls.filter(([method]) => method === 'listTabs').length, 2, 'P0 list plus ACL enrichment');
  assert.deepEqual(Object.keys(root.webP0Provider.targets).sort(), ['leaseAcquire', 'leaseRelease', 'leaseStatus', 'list']);
  delete adapter.tabs;
  await assert.rejects(root.invokeTabs({ action: 'current' }, f.exec), hasCode('CAPABILITY_UNSUPPORTED'));
});

test('registered browser_tabs executes public request validation and cold reads without launching a browser', async (t) => {
  const harness = await createHarness({ name: 'target-tabs-cold-contract' });
  t.after(() => harness.dispose());
  const registry = harness.ctx.__internal.plugin.registry;
  const listed = await harness.invoke('browser_tabs', { action: 'list' });
  assert.equal(listed.ok, true, listed.error?.message);
  assert.ok(Array.isArray(listed.value.tabs));
  const current = await harness.invoke('browser_tabs', { action: 'current' });
  assert.equal(current.ok, true, current.error?.message);
  const refused = await harness.invoke('browser_tabs', { action: 'list', tabId: 'foreign-field' });
  assert.equal(refused.ok, false);
  assert.equal(refused.error.code, 'INVALID_ARGUMENT');
  assert.match(refused.error.message, /list does not accept fields tabId/);
  for (const entry of registry.entries.values()) assert.equal(Boolean(entry.runtime.cdp), false);
  assert.equal(registry.pageCount, 0);
  for (const host of registry.hosts.values()) assert.equal(host.proc, undefined);
});
