/** TargetTabs public contract: in-memory, no Host, browser, registry or platform adapter. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  AdapterError, CONTRACT_VERSION, TARGET_TABS_ACTIONS, TARGET_TABS_ACTION_FIELDS, createTargetTabs,
} from '../../core/index.js';

const code = (expected) => (error) => {
  assert.ok(error instanceof AdapterError);
  assert.equal(error.code, expected);
  return true;
};

test('TargetTabs declares immutable version, environment and implemented actions', () => {
  const handlers = { wait: () => ({}), list: () => ({ targets: [] }) };
  const tabs = createTargetTabs({ environment: 'stub-scene', handlers });
  assert.equal(tabs.contractVersion, CONTRACT_VERSION);
  assert.equal(tabs.environment, 'stub-scene');
  assert.deepEqual(tabs.actions, ['list', 'wait']);
  assert.ok(Object.isFrozen(tabs));
  assert.ok(Object.isFrozen(tabs.actions));
  assert.ok(Object.isFrozen(TARGET_TABS_ACTIONS));
  for (const fields of Object.values(TARGET_TABS_ACTION_FIELDS)) assert.ok(Object.isFrozen(fields));
  handlers.open = () => ({});
  assert.deepEqual(tabs.actions, ['list', 'wait'], 'caller mutation cannot add an unadvertised handler');
});

test('browser-free stub owns kind/source vocabulary and preserves context and platform results', async () => {
  const controller = new AbortController();
  const context = { signal: controller.signal, actor: { id: 'stub-actor' } };
  const request = { action: 'wait', kind: 'scene-editor', source: 'workspace-import', pollMs: 2, timeoutMs: 90000 };
  const result = { matched: true, target: { kind: 'scene-editor', source: 'workspace-import' } };
  const tabs = createTargetTabs({ environment: 'stub-scene', handlers: {
    wait: (args, received) => {
      assert.equal(args, request);
      assert.equal(received, context);
      assert.equal(received.signal, controller.signal);
      return result;
    },
  } });
  assert.equal(await tabs.invoke(request, context), result);
});

test('known absent actions report CAPABILITY_UNSUPPORTED without inventing lifecycle', async () => {
  const tabs = createTargetTabs({ environment: 'stub-scene' });
  assert.deepEqual(tabs.actions, []);
  for (const action of TARGET_TABS_ACTIONS) {
    await assert.rejects(tabs.invoke({ action }), code('CAPABILITY_UNSUPPORTED'));
  }
});

test('invalid actions, request shapes and foreign fields are refused before handlers', async () => {
  let invoked = 0;
  const tabs = createTargetTabs({ environment: 'stub', handlers: Object.fromEntries(
    TARGET_TABS_ACTIONS.map((action) => [action, () => { invoked += 1; return {}; }]),
  ) });
  for (const args of [
    null, [], new Date(), 'list', {}, { action: 'unknown' }, { action: '__proto__' },
    { action: 'list', tabId: 'x' }, { action: 'open', url: 'https://example.test' },
    { action: 'select', tabId: 1 }, { action: 'wait', kind: [] }, { action: 'wait', source: '' },
    { action: 'wait', timeoutMs: -1 }, { action: 'wait', pollMs: 0 },
    { action: 'release', expectedControlRevision: 0 },
    { action: 'transfer', expectedOwnershipRevision: Number.MAX_SAFE_INTEGER + 1 },
  ]) await assert.rejects(tabs.invoke(args), code('INVALID_ARGUMENT'));
  assert.equal(invoked, 0);
});

test('each action rejects fields owned by other actions, including CAS fields', async () => {
  const tabs = createTargetTabs({ environment: 'stub', handlers: Object.fromEntries(
    TARGET_TABS_ACTIONS.map((action) => [action, () => ({})]),
  ) });
  const fields = [...new Set(Object.values(TARGET_TABS_ACTION_FIELDS).flat())].filter((field) => field !== 'action');
  for (const action of TARGET_TABS_ACTIONS) {
    for (const field of fields.filter((field) => !TARGET_TABS_ACTION_FIELDS[action].includes(field))) {
      await assert.rejects(tabs.invoke({ action, [field]: 'foreign' }), code('INVALID_ARGUMENT'));
    }
  }
});

test('selection defaults and nullable target filters remain implementation choices', async () => {
  const requests = [
    { action: 'close' }, { action: 'close', tabId: null }, { action: 'close', tabId: '  ' },
    { action: 'wait', tabId: null }, { action: 'select', tabId: '  target  ' },
  ];
  const tabs = createTargetTabs({ environment: 'stub', handlers: {
    close: (args) => args, wait: (args) => args, select: (args) => args,
  } });
  for (const args of requests) assert.equal(await tabs.invoke(args), args);
});

test('implementation errors retain identity, codes, details and causes', async () => {
  const failure = Object.assign(new Error('platform denied access'), {
    code: 'STUB_ACCESS_DENIED', details: { revision: 4 }, cause: new Error('policy'),
  });
  const tabs = createTargetTabs({ environment: 'stub', handlers: { open: () => { throw failure; } } });
  await assert.rejects(tabs.invoke({ action: 'open' }), (error) => error === failure);
});

test('factory rejects malformed implementations and has no platform dependency', () => {
  for (const options of [
    {}, { environment: '' }, { environment: 'stub', handlers: [] },
    { environment: 'stub', handlers: { missing: () => ({}) } },
    { environment: 'stub', handlers: { list: true } },
  ]) assert.throws(() => createTargetTabs(options), code('INVALID_ARGUMENT'));
  const source = readFileSync(new URL('../../core/target-tabs.js', import.meta.url), 'utf8');
  const imports = [...source.matchAll(/from\s+['"]([^'"]+)['"]/g)].map((match) => match[1]);
  assert.deepEqual(imports, ['./contracts.js', './errors.js']);
});
