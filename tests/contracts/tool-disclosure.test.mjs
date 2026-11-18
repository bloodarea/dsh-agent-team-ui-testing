import test from 'node:test';
import assert from 'node:assert/strict';
import { createToolDisclosure, TOOL_GROUPS, DIAGNOSTIC_TOOLS, DISCOVERY_TOOL } from '../../integration/tool-disclosure.js';
import { WEB_TOOL_OPERATION_NAMES } from '../../targets/web/adapter.js';

class Failure extends Error {
  constructor(code, message, details) { super(message); this.code = code; this.details = details; }
}
function fixture() {
  const settings = new WeakMap();
  const blocked = new WeakMap();
  const agent = (id) => ({ id, session: { header: { cwd: '/fixture' } } });
  const a = agent('a'), b = agent('b');
  const snapshot = (who) => ({ environment: 'web', provider: 'chrome', executionAdapterId: 'web-chrome',
    enabledEnvironments: ['web'], capabilities: ['web.t1'], environmentConfig: { enabled: true },
    providerConfig: { enabled: true }, ...settings.get(who) });
  const disclosure = createToolDisclosure({
    snapshotForAgent: snapshot,
    environmentAdmitted: (who, name) => [DISCOVERY_TOOL, ...DIAGNOSTIC_TOOLS].includes(name)
      || snapshot(who).environment === 'web' && snapshot(who).providerConfig.enabled,
    scopeVisible: (who, name) => !blocked.get(who)?.includes(name),
    ErrorClass: Failure,
  });
  return { a, b, agent, settings, blocked, disclosure };
}

test('groups partition the real operation inventory, dependencies terminate and no schema is in the catalog', () => {
  const grouped = Object.values(TOOL_GROUPS).flatMap((group) => group.tools);
  assert.equal(new Set(grouped).size, grouped.length);
  assert.deepEqual([...grouped, ...DIAGNOSTIC_TOOLS].sort(), [...WEB_TOOL_OPERATION_NAMES].sort());
  assert.deepEqual(Object.fromEntries(Object.entries(TOOL_GROUPS).map(([id, group]) => [id, group.tools.length])),
    { basic: 15, network: 9, security: 6, vision: 6, dynamic: 5 });
  const { a, disclosure } = fixture();
  const initial = disclosure.status(a);
  assert.deepEqual(initial.nextRequestTools, [DISCOVERY_TOOL, ...DIAGNOSTIC_TOOLS]);
  assert.ok(Buffer.byteLength(JSON.stringify(initial)) < 2500);
  assert.ok(!JSON.stringify(initial).includes('properties'));
});

test('selection is additive and Agent object local; reused ids and children start empty', () => {
  const { a, b, agent, disclosure } = fixture();
  const activate = (who, groups) => disclosure.execute({ action: 'activate', groups }, who);
  assert.deepEqual(activate(a, ['network']).selected, ['basic', 'network']);
  assert.equal(disclosure.disclosed(a, 'browser_network_events'), true);
  assert.equal(disclosure.disclosed(a, 'browser_vision_image'), false);
  assert.equal(disclosure.disclosed(b, 'browser_network_events'), false);
  assert.deepEqual(activate(a, ['vision', 'dynamic']).selected, ['basic', 'network', 'vision', 'dynamic']);
  assert.deepEqual(disclosure.status(agent('a')).selected, []);
  const child = agent('child'); child.session.header.parentSession = 'a';
  assert.deepEqual(disclosure.status(child).selected, []);
  assert.equal(disclosure.execute({ action: 'reset' }, a).nextRequestTools.length, 3);
});

test('unknown/unavailable activation is atomic and permissions are never expanded', () => {
  const { a, settings, blocked, disclosure } = fixture();
  for (const args of [ {}, { action: 'activate', groups: ['basic', 'bogus'] },
    { action: 'activate', groups: [] }, { action: 'status', groups: [] }, { action: 'reset', extra: 1 } ]) {
    assert.throws(() => disclosure.execute(args, a), Failure);
    assert.deepEqual(disclosure.status(a).selected, []);
  }
  assert.throws(() => disclosure.execute({ action: 'activate', groups: ['basic'] }, null),
    { code: 'TOOL_DISCLOSURE_AGENT_REQUIRED' });
  blocked.set(a, ['browser_eval']);
  const selected = disclosure.execute({ action: 'activate', groups: ['basic'] }, a);
  assert.ok(!selected.nextRequestTools.includes('browser_eval'));
  assert.deepEqual(blocked.get(a), ['browser_eval']);
  settings.set(a, { environment: 'fake' });
  assert.throws(() => disclosure.execute({ action: 'activate', groups: ['network'] }, a),
    { code: 'TOOL_DISCLOSURE_UNAVAILABLE' });
  assert.deepEqual(disclosure.status(a).selected, []);
  assert.equal(disclosure.disclosed(a, DISCOVERY_TOOL), true);
});

test('effective environment/provider/admission changes reset only affected Agent, including away/back without steps', () => {
  const { a, b, settings, disclosure } = fixture();
  for (const who of [a, b]) disclosure.execute({ action: 'activate', groups: ['network'] }, who);
  settings.set(b, { environment: 'fake' }); disclosure.refresh();
  settings.set(b, { environment: 'web' }); disclosure.refresh();
  assert.deepEqual(disclosure.status(b).selected, []);
  assert.deepEqual(disclosure.status(a).selected, ['basic', 'network']);
  settings.set(a, { revision: 9 }); disclosure.refresh();
  assert.deepEqual(disclosure.status(a).selected, ['basic', 'network']);
  settings.set(a, { provider: 'edge' }); disclosure.refresh();
  assert.deepEqual(disclosure.status(a).selected, []);
  disclosure.execute({ action: 'activate', groups: ['vision'] }, a);
  settings.set(a, { provider: 'edge', providerConfig: { enabled: false } }); disclosure.refresh();
  assert.deepEqual(disclosure.status(a).selected, []);
  assert.equal(disclosure.status(a).catalog.every((group) => !group.available), true);
});

test('reset and plugin disposal retire only presentation state, dynamic has no needless network dependency', () => {
  const { a, disclosure } = fixture();
  const result = disclosure.execute({ action: 'activate', groups: ['dynamic'] }, a);
  assert.equal(result.nextRequestTools.length, 23);
  assert.equal(disclosure.disclosed(a, 'browser_network_session'), false);
  assert.equal(disclosure.disclosed(a, 'browser_dynamic_session'), true);
  disclosure.dispose();
  assert.equal(disclosure.disclosed(a, 'browser_dynamic_session'), false);
  assert.equal(disclosure.disclosed(null, 'browser_navigate'), false);
});
