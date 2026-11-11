/**
 * M1 contract tests: the neutral page-access model and the trusted identity resolver.
 *
 * Pure unit tests only — no browser, no CDP, no Host, no network, no repo writes. Everything below
 * is in-memory: two fakes (`agentRegistry`, `teamService`) and branded principals. The point is that
 * authorisation semantics must be provable without a running Team, because "it worked when a human
 * clicked it" is not a permission model.
 *
 * The matrix is intentionally adversarial: it asks the model to *refuse*, and only then checks that
 * the legitimate case still passes. A test that only proves "the owner can write" would still pass
 * with default-allow, which is the failure mode that matters.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { ERROR_TAXONOMY as CORE_TAXONOMY } from '../../core/errors.js';
import { ERROR_CODES } from '../../core/contracts.js';
import { ERROR_TAXONOMY as BROWSER_TAXONOMY } from '../../browser-safety.js';
import {
  AUTHORIZE_REASON,
  CONTROL_EVENT,
  CONTROL_STATE,
  EFFECT,
  PAGE_GROUP_KEY_PREFIX,
  PAGE_TARGET_KEY_PREFIX,
  PRINCIPAL_ROLE,
  PRINCIPAL_SOURCE,
  RESOURCE,
  applyControlTransition,
  assertPrincipal,
  authorize,
  authorizeAll,
  isKnownOperation,
  isPrincipal,
  makeActorSelectionKey,
  makeControl,
  makeOwnership,
  makePageAccess,
  makePageGroupKey,
  makePageTargetKey,
  makePrincipal,
  operationEffect,
  parsePageGroupKey,
  projectPermissions,
  strongestEffect,
} from '../../core/index.js';
import {
  createTabPrincipalResolver,
  isValidRosterRow,
  resolvePrincipal,
  rosterFingerprint,
} from '../../integration/tab-principal.js';

/* ---------------------------------------------------------------------------------------------- *
 * Fixtures
 * ---------------------------------------------------------------------------------------------- */

const LEAD = 'lead-1';
const MEMBER_A = 'member-a';
const MEMBER_B = 'member-b';
const ROOT = 'root-1';
const OTHER_ROOT = 'root-2';

function principalFor(actorSessionId, role, rootSessionId = ROOT, source = PRINCIPAL_SOURCE.AGENT) {
  return makePrincipal({
    actorSessionId,
    rootSessionId,
    role,
    membershipRevision: 1,
    executionEpoch: 1,
    source,
    hostEpoch: 'host-boot-a',
  });
}

const lead = (rootSessionId = ROOT) => principalFor(LEAD, PRINCIPAL_ROLE.LEAD, rootSessionId);
const member = (actor, rootSessionId = ROOT) => principalFor(actor, PRINCIPAL_ROLE.TEAMMATE, rootSessionId);
const standalone = (actor) => principalFor(actor, PRINCIPAL_ROLE.STANDALONE, actor);

/** A page owned and controlled by `ownerSessionId` inside `rootSessionId`. */
function ownedBy(ownerSessionId, { rootSessionId = ROOT, controlRevision = 1, ownershipRevision = 1 } = {}) {
  return {
    ownership: makeOwnership({
      rootSessionId,
      creatorSessionId: ownerSessionId,
      ownerSessionId,
      ownershipRevision,
    }),
    control: makeControl({
      state: CONTROL_STATE.OWNED,
      controllerSessionId: ownerSessionId,
      controlRevision,
    }),
  };
}

/** Strip comments so a doc-comment quoting a forbidden pattern does not fail the scan. */
function stripComments(source) {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/[^\n]*/g, '$1');
}

function code(error) {
  return error instanceof Error ? error.code : null;
}

function assertCode(expected) {
  return (error) => {
    assert.equal(code(error), expected, `expected ${expected}, got ${code(error)}: ${error?.message}`);
    return true;
  };
}

/* ---------------------------------------------------------------------------------------------- *
 * 1. Principal
 * ---------------------------------------------------------------------------------------------- */

test('principal: valid fields are accepted and frozen', () => {
  const principal = principalFor(MEMBER_A, PRINCIPAL_ROLE.TEAMMATE);
  assert.deepEqual({ ...principal }, {
    actorSessionId: MEMBER_A,
    rootSessionId: ROOT,
    role: 'teammate',
    membershipRevision: 1,
    executionEpoch: 1,
    source: 'agent',
    hostEpoch: 'host-boot-a',
  });
  assert.equal(Object.isFrozen(principal), true);
  assert.equal(assertPrincipal(principal), principal);
  assert.equal(isPrincipal(principal), true);
});

test('principal: unknown source or role is refused, never coerced', () => {
  const base = {
    actorSessionId: MEMBER_A,
    rootSessionId: ROOT,
    role: 'teammate',
    membershipRevision: 1,
    executionEpoch: 1,
    source: PRINCIPAL_SOURCE.AGENT,
    hostEpoch: 'host-boot-a',
  };
  assert.throws(() => makePrincipal({ ...base, source: 'http' }), assertCode(ERROR_CODES.INVALID_ARGUMENT));
  assert.throws(() => makePrincipal({ ...base, source: 'tool-argument' }), assertCode(ERROR_CODES.INVALID_ARGUMENT));
  assert.throws(() => makePrincipal({ ...base, role: 'owner' }), assertCode(ERROR_CODES.INVALID_ARGUMENT));
  assert.throws(() => makePrincipal({ ...base, role: 'admin' }), assertCode(ERROR_CODES.INVALID_ARGUMENT));
  assert.throws(() => makePrincipal({ ...base, role: 'root' }), assertCode(ERROR_CODES.INVALID_ARGUMENT));
});

test('principal: empty or blank ids and non-integer versions are refused', () => {
  const base = {
    actorSessionId: MEMBER_A,
    rootSessionId: ROOT,
    role: PRINCIPAL_ROLE.TEAMMATE,
    membershipRevision: 1,
    executionEpoch: 1,
    source: PRINCIPAL_SOURCE.AGENT,
    hostEpoch: 'host-boot-a',
  };
  for (const value of ['', '   ', null, undefined, 42, {}]) {
    assert.throws(() => makePrincipal({ ...base, actorSessionId: value }), assertCode(ERROR_CODES.INVALID_ARGUMENT));
    assert.throws(() => makePrincipal({ ...base, rootSessionId: value }), assertCode(ERROR_CODES.INVALID_ARGUMENT));
  }
  assert.throws(() => makePrincipal({ ...base, actorSessionId: ' padded ' }), assertCode(ERROR_CODES.INVALID_ARGUMENT));
  assert.throws(() => makePrincipal({ ...base, membershipRevision: 0 }), assertCode(ERROR_CODES.INVALID_ARGUMENT));
  assert.throws(() => makePrincipal({ ...base, executionEpoch: 1.5 }), assertCode(ERROR_CODES.INVALID_ARGUMENT));
  assert.throws(() => makePrincipal({ ...base, hostEpoch: '' }), assertCode(ERROR_CODES.INVALID_ARGUMENT));
});

test('principal: extra fields are refused so a spread cannot smuggle a role or root', () => {
  assert.throws(
    () => makePrincipal({
      actorSessionId: MEMBER_A,
      rootSessionId: ROOT,
      role: PRINCIPAL_ROLE.TEAMMATE,
      membershipRevision: 1,
      executionEpoch: 1,
      source: PRINCIPAL_SOURCE.AGENT,
      hostEpoch: 'host-boot-a',
      controllerSessionId: MEMBER_A,
    }),
    assertCode(ERROR_CODES.INVALID_ARGUMENT),
  );
});

test('principal: a standalone domain cannot claim another root', () => {
  assert.throws(() => principalFor(MEMBER_A, PRINCIPAL_ROLE.STANDALONE, ROOT), assertCode(ERROR_CODES.INVALID_ARGUMENT));
  assert.equal(standalone(MEMBER_A).rootSessionId, MEMBER_A);
});

test('principal: a JSON copy loses the brand and is refused', () => {
  // This is the whole transport-layer defence: HTTP bodies, WS query strings, tool arguments and
  // product metadata are all JSON, and none of them may mint "I am the Lead".
  const forged = JSON.parse(JSON.stringify(lead()));
  assert.equal(isPrincipal(forged), false);
  assert.throws(() => assertPrincipal(forged), assertCode(ERROR_CODES.INVALID_ARGUMENT));
  assert.throws(
    () => assertPrincipal({ ...forged, role: PRINCIPAL_ROLE.LEAD }),
    assertCode(ERROR_CODES.INVALID_ARGUMENT),
  );
  // A caller may keep a more specific surface code while sharing the same check.
  assert.throws(
    () => assertPrincipal(forged, { code: ERROR_CODES.TAB_IDENTITY_UNAVAILABLE }),
    assertCode(ERROR_CODES.TAB_IDENTITY_UNAVAILABLE),
  );
});

test('principal: self-reported root/role inside a page record is ignored', () => {
  // The page record is data from storage; it can only ever *narrow* authority, never widen it.
  const record = ownedBy(MEMBER_A);
  const forged = { ...principalFor(MEMBER_A, PRINCIPAL_ROLE.TEAMMATE, OTHER_ROOT), ...record.ownership };
  const verdict = authorize({
    principal: forged,
    ownership: record.ownership,
    control: record.control,
    effect: { effect: EFFECT.WRITE, resource: RESOURCE.PAGE, targetRequired: true },
    operation: 'browser_click',
  });
  assert.equal(verdict.allowed, false);
  assert.equal(verdict.reason, AUTHORIZE_REASON.IDENTITY_UNVERIFIED);
});

/* ---------------------------------------------------------------------------------------------- *
 * 2. Page-group / target / selection keys
 * ---------------------------------------------------------------------------------------------- */

test('keys: the group key carries all four frozen dimensions in a JSON array', () => {
  const key = makePageGroupKey({
    environment: 'web',
    workspaceKey: 'workspace:w1',
    provider: 'chrome',
    rootSessionId: ROOT,
  });
  assert.equal(key, `${PAGE_GROUP_KEY_PREFIX}${JSON.stringify(['web', 'workspace:w1', 'chrome', ROOT])}`);
  assert.deepEqual(parsePageGroupKey(key), {
    environment: 'web',
    workspaceKey: 'workspace:w1',
    provider: 'chrome',
    rootSessionId: ROOT,
  });
});

test('keys: two roots in one workspace never share a group key', () => {
  const base = { environment: 'web', workspaceKey: 'workspace:w1', provider: 'chrome' };
  const a = makePageGroupKey({ ...base, rootSessionId: ROOT });
  const b = makePageGroupKey({ ...base, rootSessionId: OTHER_ROOT });
  assert.notEqual(a, b);
  assert.equal(parsePageGroupKey(a).rootSessionId, ROOT);
  assert.equal(parsePageGroupKey(b).rootSessionId, OTHER_ROOT);
});

test('keys: two providers in one workspace never share a group key', () => {
  const base = { environment: 'web', workspaceKey: 'workspace:w1', rootSessionId: ROOT };
  assert.notEqual(
    makePageGroupKey({ ...base, provider: 'chrome' }),
    makePageGroupKey({ ...base, provider: 'edge' }),
  );
});

test('keys: a dimension containing separators cannot alias another group', () => {
  // Hand-built `a:b:c` keys collide here; the JSON array does not.
  const one = makePageGroupKey({
    environment: 'web',
    workspaceKey: 'workspace:w1","chrome',
    provider: 'chrome',
    rootSessionId: ROOT,
  });
  const two = makePageGroupKey({
    environment: 'web',
    workspaceKey: 'workspace:w1',
    provider: 'chrome',
    rootSessionId: `chrome","${ROOT}`,
  });
  assert.notEqual(one, two);
  assert.deepEqual(parsePageGroupKey(one).workspaceKey, 'workspace:w1","chrome');
  assert.deepEqual(parsePageGroupKey(two).rootSessionId, `chrome","${ROOT}`);
});

test('keys: empty, padded and composed dimensions are refused', () => {
  const base = { environment: 'web', workspaceKey: 'workspace:w1', provider: 'chrome', rootSessionId: ROOT };
  for (const value of ['', '  ', null, undefined, 7]) {
    assert.throws(() => makePageGroupKey({ ...base, workspaceKey: value }), assertCode(ERROR_CODES.INVALID_ARGUMENT));
    assert.throws(() => makePageGroupKey({ ...base, rootSessionId: value }), assertCode(ERROR_CODES.INVALID_ARGUMENT));
    assert.throws(() => makePageGroupKey({ ...base, provider: value }), assertCode(ERROR_CODES.INVALID_ARGUMENT));
  }
  assert.throws(
    () => makePageGroupKey({ ...base, workspaceKey: 'workspace:w1 ' }),
    assertCode(ERROR_CODES.INVALID_ARGUMENT),
  );
});

test('keys: unknown provider or environment is refused instead of being encoded', () => {
  const base = { environment: 'web', workspaceKey: 'workspace:w1', provider: 'chrome', rootSessionId: ROOT };
  assert.throws(() => makePageGroupKey({ ...base, provider: 'safari' }), assertCode(ERROR_CODES.INVALID_ARGUMENT));
  assert.throws(() => makePageGroupKey({ ...base, provider: 'CHROME' }), assertCode(ERROR_CODES.INVALID_ARGUMENT));
  assert.throws(() => makePageGroupKey({ ...base, environment: 'dos' }), assertCode(ERROR_CODES.INVALID_ARGUMENT));
});

test('keys: a composed key may not masquerade as a raw workspace dimension', () => {
  const composed = makePageGroupKey({
    environment: 'web',
    workspaceKey: 'workspace:w1',
    provider: 'chrome',
    rootSessionId: ROOT,
  });
  assert.throws(
    () => makePageGroupKey({
      environment: 'web',
      workspaceKey: composed,
      provider: 'chrome',
      rootSessionId: ROOT,
    }),
    assertCode(ERROR_CODES.INVALID_ARGUMENT),
  );
  assert.throws(
    () => makePageTargetKey({ groupKey: composed, tabId: composed }),
    assertCode(ERROR_CODES.INVALID_ARGUMENT),
  );
});

test('keys: target and selection keys are versioned, scoped and require a real group key', () => {
  const groupKey = makePageGroupKey({
    environment: 'web',
    workspaceKey: 'workspace:w1',
    provider: 'chrome',
    rootSessionId: ROOT,
  });
  const targetKey = makePageTargetKey({ groupKey, tabId: 'primary' });
  assert.equal(targetKey, `${PAGE_TARGET_KEY_PREFIX}${JSON.stringify([groupKey, 'primary'])}`);
  assert.notEqual(targetKey, makePageTargetKey({ groupKey, tabId: 'child-1' }));

  const selectionA = makeActorSelectionKey({ groupKey, actorSessionId: MEMBER_A });
  const selectionB = makeActorSelectionKey({ groupKey, actorSessionId: MEMBER_B });
  assert.notEqual(selectionA, selectionB);

  assert.throws(() => makePageTargetKey({ groupKey: 'page-group:v1:["web"]', tabId: 'x' }), assertCode(ERROR_CODES.INVALID_ARGUMENT));
  assert.throws(() => makePageTargetKey({ groupKey: 'workspace:w1', tabId: 'x' }), assertCode(ERROR_CODES.INVALID_ARGUMENT));
  assert.throws(() => makeActorSelectionKey({ groupKey, actorSessionId: '' }), assertCode(ERROR_CODES.INVALID_ARGUMENT));
  assert.throws(() => parsePageGroupKey('page-group:v1:not-json'), assertCode(ERROR_CODES.INVALID_ARGUMENT));
  assert.throws(() => parsePageGroupKey(targetKey), assertCode(ERROR_CODES.INVALID_ARGUMENT));
});

/* ---------------------------------------------------------------------------------------------- *
 * 3. operationEffect
 * ---------------------------------------------------------------------------------------------- */

const ALL_TOOLS = [
  'browser_annotation',
  'browser_capabilities', 'browser_click', 'browser_computed_style', 'browser_dynamic_correlate',
  'browser_dynamic_session', 'browser_eval', 'browser_fill_form', 'browser_http_request',
  'browser_input', 'browser_motion_analyze', 'browser_motion_control', 'browser_motion_observe',
  'browser_navigate', 'browser_network', 'browser_network_control', 'browser_network_detail',
  'browser_network_events', 'browser_network_evidence', 'browser_network_session',
  'browser_network_subscribe', 'browser_network_trace', 'browser_node_state', 'browser_screenshot',
  'browser_scroll', 'browser_snapshot', 'browser_state', 'browser_tabs', 'browser_type',
  'browser_viewport', 'browser_vision_act', 'browser_vision_baseline', 'browser_vision_check',
  'browser_vision_compare', 'browser_vision_find', 'browser_vision_image', 'browser_wait_for',
];

/** Every action each action-dispatching tool declares in its real schema. */
const TOOL_ACTIONS = {
  // P0-D annotations (docs/viewport-control.md): read observes the cached document, the three
  // mutating actions are host-side writes that still route through the caller's work selection.
  browser_annotation: ['read', 'draw', 'erase', 'clear'],
  browser_tabs: ['list', 'current', 'open', 'select', 'close', 'wait', 'acquire', 'release', 'transfer'],
  browser_viewport: ['get', 'set'],
  browser_network_session: ['start', 'stop', 'status', 'reset'],
  browser_network_control: [
    'throttle', 'offline', 'intercept-add', 'intercept-remove', 'intercept-clear', 'intercept-list',
    'hold', 'resume', 'replay', 'mock', 'reset',
  ],
  browser_network_trace: ['begin-step', 'end-step', 'mark', 'link', 'window', 'query', 'reset'],
  browser_network_evidence: ['export', 'import', 'index', 'search', 'link', 'integrity', 'clear', 'list'],
  browser_network_subscribe: ['create', 'poll', 'ack', 'close', 'list'],
  browser_dynamic_session: ['start', 'stop', 'status', 'reset', 'extend'],
  browser_motion_control: ['pause', 'resume', 'seek', 'rate', 'restore'],
  browser_vision_baseline: ['list', 'get', 'create', 'update', 'delete'],
};

/** An argument bag good enough to classify one action. */
function argsFor(tool, action) {
  if (tool === 'browser_tabs' && action === 'close') return { action, tabId: 'primary' };
  return { action };
}

/** Tools whose classification reads a required argument bag beyond `action`. */
const EXTRA_ARGS = {
  browser_vision_compare: { before: { kind: 'product', productId: 'v1_a' }, after: { kind: 'baseline', name: 'b' } },
  browser_vision_check: { cases: [{ id: 'c1', source: { kind: 'baseline', name: 'b' }, assertions: [] }] },
};

function bagFor(tool, action) {
  return { ...(EXTRA_ARGS[tool] ?? {}), ...(action === null ? {} : argsFor(tool, action)) };
}

test('effect table: all 37 browser_* tools are classified, and each row is well formed', () => {
  assert.equal(ALL_TOOLS.length, 37);
  for (const tool of ALL_TOOLS) {
    assert.equal(isKnownOperation(tool), true, `${tool} is missing from the effect table`);
    const actions = TOOL_ACTIONS[tool] ?? [null];
    for (const action of actions) {
      const effects = operationEffect(tool, bagFor(tool, action));
      assert.ok(effects.length >= 1, `${tool}/${action}`);
      assert.equal(Object.isFrozen(effects), true, `${tool}/${action} must be frozen`);
      for (const row of effects) {
        assert.ok(Object.values(EFFECT).includes(row.effect), `${tool}/${action} effect`);
        assert.ok(Object.values(RESOURCE).includes(row.resource), `${tool}/${action} resource`);
        assert.equal(typeof row.targetRequired, 'boolean', `${tool}/${action} targetRequired`);
        assert.equal(typeof row.sourceAccessRequired, 'boolean', `${tool}/${action} sourceAccessRequired`);
        assert.equal(Object.isFrozen(row), true, `${tool}/${action} row must be frozen`);
      }
    }
  }
});

test('effect table: the registered tool set in index.js is fully classified', () => {
  // Guards the *other* direction: a tool added to index.js without a row here would otherwise be
  // classified by nothing at all. Reading the registration list is the cheapest honest signal.
  const source = readFileSync(new URL('../../index.js', import.meta.url), 'utf8');
  const names = new Set([...source.matchAll(/name: '(browser_[a-z_0-9]+)'/g)].map((match) => match[1]));
  assert.ok(names.size >= 37, `expected at least 37 registered tools, found ${names.size}`);
  const missing = [...names].filter((name) => !isKnownOperation(name));
  assert.deepEqual(missing, [], `tools without an effect row: ${missing.join(', ')}`);
});

test('effect table: unknown operation or unknown sub-action is refused (no dispatch)', () => {
  assert.throws(() => operationEffect('browser_teleport'), assertCode(ERROR_CODES.INVALID_ARGUMENT));
  assert.throws(() => operationEffect(''), assertCode(ERROR_CODES.INVALID_ARGUMENT));
  assert.throws(() => operationEffect(undefined), assertCode(ERROR_CODES.INVALID_ARGUMENT));
  assert.throws(() => operationEffect('browser_tabs'), assertCode(ERROR_CODES.INVALID_ARGUMENT));
  assert.throws(() => operationEffect('browser_tabs', { action: 'destroy' }), assertCode(ERROR_CODES.INVALID_ARGUMENT));
  assert.throws(() => operationEffect('browser_tabs', { action: '  ' }), assertCode(ERROR_CODES.INVALID_ARGUMENT));
  assert.throws(() => operationEffect('browser_network_control', { action: 'nuke' }), assertCode(ERROR_CODES.INVALID_ARGUMENT));
  assert.throws(() => operationEffect('browser_vision_baseline', { action: 'rm' }), assertCode(ERROR_CODES.INVALID_ARGUMENT));
  assert.throws(() => operationEffect('browser_motion_control', { action: 'freeze' }), assertCode(ERROR_CODES.INVALID_ARGUMENT));
});

test('effect table: network_control shows a read sub-action next to write sub-actions', () => {
  // The ruling's concrete example: intercept-* is a list of stored rules (observe), throttle is a
  // change to the live collector (write). Classifying the tool by its name would get one wrong.
  assert.deepEqual(operationEffect('browser_network_control', { action: 'intercept-list' }), [
    { effect: 'observe', resource: 'collector', targetRequired: false, sourceAccessRequired: true },
  ]);
  assert.deepEqual(operationEffect('browser_network_control', { action: 'throttle' }), [
    { effect: 'write', resource: 'collector', targetRequired: false, sourceAccessRequired: true },
  ]);
  assert.equal(strongestEffect(operationEffect('browser_network_control', { action: 'throttle' })).effect, EFFECT.WRITE);
});

test('effect table: an action-less network_session is classified as start (write), not as a read', () => {
  const effects = operationEffect('browser_network_session', {});
  assert.equal(strongestEffect(effects).effect, EFFECT.WRITE);
  assert.deepEqual(effects, operationEffect('browser_network_session', { action: 'start' }));
  assert.deepEqual(operationEffect('browser_network_session', { action: 'status' }), [
    { effect: 'observe', resource: 'collector', targetRequired: false, sourceAccessRequired: true },
  ]);
});

test('effect table: a compound call returns every effect it really has', () => {
  const plain = operationEffect('browser_screenshot', {});
  assert.deepEqual(plain, [{ effect: 'observe', resource: 'page', targetRequired: true, sourceAccessRequired: true }]);

  const persisted = operationEffect('browser_screenshot', { out: 'output/capture/a.png' });
  assert.deepEqual(persisted, [
    { effect: 'observe', resource: 'page', targetRequired: true, sourceAccessRequired: true },
    { effect: 'callerLocal', resource: 'artifact', targetRequired: false, sourceAccessRequired: true },
  ]);
  assert.equal(strongestEffect(persisted).effect, EFFECT.CALLER_LOCAL);

  const liveVision = operationEffect('browser_vision_image', { source: { kind: 'live' } });
  assert.deepEqual(liveVision.map((row) => `${row.effect}:${row.resource}`), ['observe:page', 'callerLocal:artifact']);
  const storedVision = operationEffect('browser_vision_image', { source: { kind: 'baseline', name: 'b' } });
  assert.deepEqual(storedVision.map((row) => `${row.effect}:${row.resource}`), ['observe:artifact', 'callerLocal:artifact']);

  const compare = operationEffect('browser_vision_compare', {
    before: { kind: 'product', productId: 'v1_x' },
    after: { kind: 'live' },
  });
  assert.deepEqual(compare.map((row) => `${row.effect}:${row.resource}`), ['observe:artifact', 'callerLocal:artifact', 'observe:page']);
});

test('effect table: vision_baseline create is mine, update/delete are shared-record writes', () => {
  assert.deepEqual(operationEffect('browser_vision_baseline', { action: 'list' }).map((row) => row.effect), ['observe']);
  assert.deepEqual(
    operationEffect('browser_vision_baseline', { action: 'create', source: { kind: 'product', productId: 'v1_x' } })
      .map((row) => row.effect),
    ['callerLocal'],
  );
  assert.deepEqual(
    operationEffect('browser_vision_baseline', { action: 'create', source: { kind: 'live' } }).map((row) => row.effect),
    ['callerLocal', 'observe'],
  );
  assert.deepEqual(operationEffect('browser_vision_baseline', { action: 'delete' }).map((row) => row.effect), ['manage']);
  assert.deepEqual(operationEffect('browser_vision_baseline', { action: 'update' }).map((row) => row.effect), ['manage']);
});

test('effect table: evidence export is a new local copy, clear/import/link are shared writes', () => {
  assert.deepEqual(operationEffect('browser_network_evidence', { action: 'search' }).map((row) => row.effect), ['observe']);
  assert.deepEqual(operationEffect('browser_network_evidence', { action: 'export' }).map((row) => row.effect), ['callerLocal']);
  for (const action of ['clear', 'import', 'link']) {
    assert.deepEqual(
      operationEffect('browser_network_evidence', { action }).map((row) => row.effect),
      ['manage'],
      action,
    );
  }
});

test('effect table: motion fresh sampling is a write, stored observation is a read', () => {
  assert.deepEqual(operationEffect('browser_motion_observe', {}).map((row) => row.effect), ['observe']);
  assert.deepEqual(operationEffect('browser_motion_observe', { fresh: false }).map((row) => row.effect), ['observe']);
  assert.equal(strongestEffect(operationEffect('browser_motion_observe', { fresh: true })).effect, EFFECT.WRITE);
  assert.deepEqual(operationEffect('browser_motion_analyze', {}).map((row) => row.effect), ['observe']);
});

test('effect table: page writes and caller-local capabilities are not interchangeable', () => {
  for (const tool of [
    'browser_click', 'browser_type', 'browser_input', 'browser_scroll', 'browser_fill_form',
    'browser_navigate', 'browser_eval', 'browser_vision_act',
  ]) {
    assert.deepEqual(
      operationEffect(tool, {}),
      [{ effect: 'write', resource: 'page', targetRequired: true, sourceAccessRequired: true }],
      tool,
    );
  }
  // Arbitrary eval is a write even when the caller claims it only reads.
  assert.equal(strongestEffect(operationEffect('browser_eval', { expression: '1' })).effect, EFFECT.WRITE);
  assert.equal(strongestEffect(operationEffect('browser_http_request', { url: 'https://x/' })).effect, EFFECT.CALLER_LOCAL);
  assert.deepEqual(operationEffect('browser_tabs', { action: 'open' }), [
    { effect: 'write', resource: 'page', targetRequired: false, sourceAccessRequired: true },
  ]);
  assert.deepEqual(operationEffect('browser_tabs', { action: 'select', mode: 'observe' }), [
    { effect: 'callerLocal', resource: 'host', targetRequired: true, sourceAccessRequired: true },
  ]);
});

test('effect table: host-wide control is classified manage/host and is refused to every Agent', () => {
  assert.deepEqual(operationEffect('host.display', {}), [
    { effect: 'manage', resource: 'host', targetRequired: false, sourceAccessRequired: false },
  ]);
  assert.deepEqual(operationEffect('host.config', {}), [
    { effect: 'manage', resource: 'host', targetRequired: false, sourceAccessRequired: false },
  ]);
  for (const principal of [lead(), member(MEMBER_A), standalone('solo'), principalFor(LEAD, PRINCIPAL_ROLE.LEAD, ROOT, PRINCIPAL_SOURCE.SYSTEM)]) {
    const verdict = authorize({ principal, effect: operationEffect('host.display', {})[0] });
    assert.equal(verdict.allowed, false);
    assert.equal(verdict.reason, AUTHORIZE_REASON.HOST_MANAGE_FORBIDDEN);
    assert.equal(verdict.code, ERROR_CODES.TAB_FORBIDDEN);
  }
});

/* ---------------------------------------------------------------------------------------------- *
 * 4. Control state machine
 * ---------------------------------------------------------------------------------------------- */

test('state machine: acquire -> draining -> lead-controlled -> release is version-exact', () => {
  const start = ownedBy(MEMBER_A, { controlRevision: 3, ownershipRevision: 2 });

  const draining = applyControlTransition(start, {
    type: CONTROL_EVENT.ACQUIRE,
    principal: lead(),
    expectedControlRevision: 3,
  });
  assert.equal(draining.changed, true);
  assert.equal(draining.control.state, CONTROL_STATE.DRAINING);
  // Draining moves the *gate*, not the controller and not the version.
  assert.equal(draining.control.controllerSessionId, MEMBER_A);
  assert.equal(draining.control.controlRevision, 3);
  assert.equal(draining.control.pendingControllerSessionId, LEAD);
  assert.equal(draining.ownership.ownershipRevision, 2);

  const taken = applyControlTransition(draining, {
    type: CONTROL_EVENT.ACQUIRE_COMMIT,
    principal: lead(),
    expectedControlRevision: 3,
  });
  assert.equal(taken.control.state, CONTROL_STATE.LEAD_CONTROLLED);
  assert.equal(taken.control.controllerSessionId, LEAD);
  assert.equal(taken.control.controlRevision, 4);
  assert.equal(taken.control.pendingControllerSessionId, null);
  // Ownership is untouched by a takeover: the member still owns the page.
  assert.equal(taken.ownership.ownerSessionId, MEMBER_A);
  assert.equal(taken.ownership.ownershipRevision, 2);

  const released = applyControlTransition(taken, {
    type: CONTROL_EVENT.RELEASE,
    principal: lead(),
    expectedControlRevision: 4,
  });
  assert.equal(released.control.state, CONTROL_STATE.OWNED);
  assert.equal(released.control.controllerSessionId, MEMBER_A);
  assert.equal(released.control.controlRevision, 5);
  assert.equal(released.ownership.ownershipRevision, 2);
});

test('state machine: a cancelled takeover leaves the record byte-identical', () => {
  const start = ownedBy(MEMBER_A, { controlRevision: 3 });
  const draining = applyControlTransition(start, { type: CONTROL_EVENT.ACQUIRE, principal: lead() });
  const cancelled = applyControlTransition(draining, { type: CONTROL_EVENT.ACQUIRE_CANCEL, principal: lead() });
  assert.equal(cancelled.control.state, CONTROL_STATE.OWNED);
  assert.equal(cancelled.control.controlRevision, 3);
  assert.equal(cancelled.control.controllerSessionId, MEMBER_A);
  assert.deepEqual({ ...cancelled.control }, { ...start.control });
  assert.deepEqual({ ...cancelled.ownership }, { ...start.ownership });
});

test('state machine: transfer bumps both revisions and keeps creator/root', () => {
  const start = ownedBy(MEMBER_A, { controlRevision: 2, ownershipRevision: 5 });
  const moved = applyControlTransition(start, {
    type: CONTROL_EVENT.TRANSFER,
    principal: lead(),
    toSessionId: MEMBER_B,
    expectedControlRevision: 2,
    expectedOwnershipRevision: 5,
  });
  assert.equal(moved.ownership.ownerSessionId, MEMBER_B);
  assert.equal(moved.ownership.creatorSessionId, MEMBER_A);
  assert.equal(moved.ownership.rootSessionId, ROOT);
  assert.equal(moved.ownership.ownershipRevision, 6);
  assert.equal(moved.control.controllerSessionId, MEMBER_B);
  assert.equal(moved.control.controlRevision, 3);
  assert.equal(moved.control.state, CONTROL_STATE.OWNED);
});

test('state machine: transferring back to the owner moves control only', () => {
  const start = ownedBy(MEMBER_A, { controlRevision: 4, ownershipRevision: 2 });
  const leadControlled = applyControlTransition(
    applyControlTransition(start, { type: CONTROL_EVENT.ACQUIRE, principal: lead() }),
    { type: CONTROL_EVENT.ACQUIRE_COMMIT, principal: lead() },
  );
  const back = applyControlTransition(leadControlled, {
    type: CONTROL_EVENT.TRANSFER,
    principal: lead(),
    toSessionId: MEMBER_A,
    expectedControlRevision: 5,
    expectedOwnershipRevision: 2,
  });
  assert.equal(back.control.state, CONTROL_STATE.OWNED);
  assert.equal(back.control.controllerSessionId, MEMBER_A);
  assert.equal(back.control.controlRevision, 6);
  assert.equal(back.ownership.ownerSessionId, MEMBER_A);
  // The owner did not change, so its revision must not move.
  assert.equal(back.ownership.ownershipRevision, 2);
});

test('state machine: an already-satisfied request reports changed:false without a version bump', () => {
  const start = ownedBy(MEMBER_A, { controlRevision: 4 });
  const sameRelease = applyControlTransition(start, { type: CONTROL_EVENT.RELEASE, principal: lead() });
  assert.equal(sameRelease.changed, false);
  assert.equal(sameRelease.control.controlRevision, 4);

  const controlled = applyControlTransition(
    applyControlTransition(start, { type: CONTROL_EVENT.ACQUIRE, principal: lead() }),
    { type: CONTROL_EVENT.ACQUIRE_COMMIT, principal: lead() },
  );
  const again = applyControlTransition(controlled, { type: CONTROL_EVENT.ACQUIRE, principal: lead() });
  assert.equal(again.changed, false);
  assert.equal(again.control.controlRevision, controlled.control.controlRevision);

  const moved = applyControlTransition(start, {
    type: CONTROL_EVENT.TRANSFER,
    principal: lead(),
    toSessionId: MEMBER_B,
  });
  const repeat = applyControlTransition(moved, {
    type: CONTROL_EVENT.TRANSFER,
    principal: lead(),
    toSessionId: MEMBER_B,
  });
  assert.equal(repeat.changed, false);
  assert.equal(repeat.ownership.ownershipRevision, moved.ownership.ownershipRevision);
});

test('state machine: illegal transitions throw a structured error, never silently allow', () => {
  const owned = ownedBy(MEMBER_A, { controlRevision: 1 });

  // A teammate cannot manage another member's page — at all.
  assert.throws(
    () => applyControlTransition(owned, { type: CONTROL_EVENT.ACQUIRE, principal: member(MEMBER_B) }),
    assertCode(ERROR_CODES.TAB_FORBIDDEN),
  );
  // The owner is not the Lead: release/transfer are Lead-only even for your own page.
  assert.throws(
    () => applyControlTransition(owned, { type: CONTROL_EVENT.RELEASE, principal: member(MEMBER_A) }),
    assertCode(ERROR_CODES.TAB_FORBIDDEN),
  );
  // Committing a takeover that was never started.
  assert.throws(
    () => applyControlTransition(owned, { type: CONTROL_EVENT.ACQUIRE_COMMIT, principal: lead() }),
    assertCode(ERROR_CODES.TAB_CONTROL_CHANGED),
  );
  // Never-draining twice: the second acquire sees `draining`, not `owned`.
  const draining = applyControlTransition(owned, { type: CONTROL_EVENT.ACQUIRE, principal: lead() });
  assert.throws(
    () => applyControlTransition(draining, { type: CONTROL_EVENT.ACQUIRE, principal: lead() }),
    assertCode(ERROR_CODES.TAB_CONTROL_CHANGED),
  );
  // Stale CAS on both axes.
  assert.throws(
    () => applyControlTransition(owned, {
      type: CONTROL_EVENT.ACQUIRE,
      principal: lead(),
      expectedControlRevision: 9,
    }),
    assertCode(ERROR_CODES.TAB_CONTROL_CHANGED),
  );
  assert.throws(
    () => applyControlTransition(owned, {
      type: CONTROL_EVENT.TRANSFER,
      principal: lead(),
      toSessionId: MEMBER_B,
      expectedOwnershipRevision: 9,
    }),
    assertCode(ERROR_CODES.TAB_OWNERSHIP_STALE),
  );
  // An unknown event is an argument error.
  assert.throws(
    () => applyControlTransition(owned, { type: 'steal', principal: lead() }),
    assertCode(ERROR_CODES.INVALID_ARGUMENT),
  );
  // An unproved principal never drives the graph.
  assert.throws(
    () => applyControlTransition(owned, { type: CONTROL_EVENT.ACQUIRE, principal: { ...lead() } }),
    assertCode(ERROR_CODES.TAB_IDENTITY_UNAVAILABLE),
  );
});

test('state machine: a cross-root Lead gets the uniform not-found answer', () => {
  const owned = ownedBy(MEMBER_A);
  const foreignLead = lead(OTHER_ROOT);
  for (const event of [
    { type: CONTROL_EVENT.ACQUIRE },
    { type: CONTROL_EVENT.RELEASE },
    { type: CONTROL_EVENT.RETIRE },
    { type: CONTROL_EVENT.TRANSFER, toSessionId: LEAD },
  ]) {
    let thrown;
    try {
      applyControlTransition(owned, { ...event, principal: foreignLead });
    } catch (error) {
      thrown = error;
    }
    assert.equal(thrown?.code, ERROR_CODES.TAB_NOT_FOUND, event.type);
    // No page id, no title, no root, no revision: nothing that would confirm existence.
    assert.equal(thrown.details?.rootSessionId, undefined, event.type);
    assert.equal(thrown.details?.ownerSessionId, undefined, event.type);
  }
});

test('state machine: retire is terminal and keeps controlRevision monotonic', () => {
  const start = ownedBy(MEMBER_A, { controlRevision: 7 });
  const retired = applyControlTransition(start, {
    type: CONTROL_EVENT.RETIRE,
    principal: member(MEMBER_A),
  });
  assert.equal(retired.control.state, CONTROL_STATE.RETIRED);
  assert.equal(retired.control.controllerSessionId, null);
  assert.equal(retired.control.controlRevision, 8);
  const again = applyControlTransition(retired, { type: CONTROL_EVENT.RETIRE, principal: lead() });
  assert.equal(again.changed, false);
  assert.equal(again.control.controlRevision, 8);
  assert.throws(
    () => applyControlTransition(retired, { type: CONTROL_EVENT.ACQUIRE, principal: lead() }),
    assertCode(ERROR_CODES.TARGET_GONE),
  );
});

test('state machine: only the Lead who started the drain may commit or cancel it', () => {
  const start = ownedBy(MEMBER_A);
  const draining = applyControlTransition(start, { type: CONTROL_EVENT.ACQUIRE, principal: lead() });
  const otherLead = principalFor('lead-2', PRINCIPAL_ROLE.LEAD);
  assert.throws(
    () => applyControlTransition(draining, { type: CONTROL_EVENT.ACQUIRE_COMMIT, principal: otherLead }),
    assertCode(ERROR_CODES.TAB_CONTROL_CHANGED),
  );
  assert.throws(
    () => applyControlTransition(draining, { type: CONTROL_EVENT.ACQUIRE_CANCEL, principal: otherLead }),
    assertCode(ERROR_CODES.TAB_CONTROL_CHANGED),
  );
});

/* ---------------------------------------------------------------------------------------------- *
 * 5. authorize
 * ---------------------------------------------------------------------------------------------- */

const WRITE_PAGE = Object.freeze({ effect: EFFECT.WRITE, resource: RESOURCE.PAGE, targetRequired: true });
const OBSERVE_PAGE = Object.freeze({ effect: EFFECT.OBSERVE, resource: RESOURCE.PAGE, targetRequired: true });

test('authorize: cross-root is denied for every effect and leaks no existence', () => {
  const record = ownedBy(MEMBER_A);
  for (const effect of [OBSERVE_PAGE, WRITE_PAGE]) {
    const verdict = authorize({
      principal: lead(OTHER_ROOT),
      ownership: record.ownership,
      control: record.control,
      effect,
      operation: 'browser_click',
    });
    assert.equal(verdict.allowed, false);
    assert.equal(verdict.reason, AUTHORIZE_REASON.CROSS_ROOT);
    // No code and notFound:true — the caller decides the uniform not-found shape (§7.3).
    assert.equal(verdict.code, null);
    assert.equal(verdict.notFound, true);
  }
  // Even another team's Lead is just a foreign root.
  const verdict = authorize({
    principal: principalFor('lead-9', PRINCIPAL_ROLE.LEAD, OTHER_ROOT),
    ownership: record.ownership,
    control: record.control,
    effect: OBSERVE_PAGE,
    operation: 'browser_snapshot',
  });
  assert.equal(verdict.reason, AUTHORIZE_REASON.CROSS_ROOT);
});

test('authorize: root is compared before role and before version', () => {
  // A foreign root that also presents a wrong revision must still get the silent answer, otherwise
  // "stale revision" would confirm the page exists.
  const record = ownedBy(MEMBER_A, { controlRevision: 5 });
  const verdict = authorize({
    principal: lead(OTHER_ROOT),
    ownership: record.ownership,
    control: record.control,
    effect: WRITE_PAGE,
    operation: 'browser_click',
    expectedControlRevision: 1,
    expectedOwnershipRevision: 9,
  });
  assert.equal(verdict.reason, AUTHORIZE_REASON.CROSS_ROOT);
  assert.equal(verdict.code, null);

  // Role before version too: a teammate with no write right gets the role answer, not a hint that
  // its guessed revision happens to be current or stale.
  const sameRootDenied = authorize({
    principal: member(MEMBER_B),
    ownership: record.ownership,
    control: record.control,
    effect: WRITE_PAGE,
    operation: 'browser_click',
    expectedControlRevision: 1,
    expectedOwnershipRevision: 1,
  });
  assert.equal(sameRootDenied.reason, AUTHORIZE_REASON.ROLE_FORBIDDEN);
  assert.equal(sameRootDenied.code, ERROR_CODES.TAB_FORBIDDEN);
});

test('authorize: the role matrix, table-driven', () => {
  const record = ownedBy(MEMBER_A);
  const leadControlled = {
    ownership: record.ownership,
    control: makeControl({ state: CONTROL_STATE.LEAD_CONTROLLED, controllerSessionId: LEAD, controlRevision: 2 }),
  };
  const cases = [
    // [label, principal, record, effect, operation, allowed, reason]
    ['lead observes a member page', lead(), record, OBSERVE_PAGE, 'browser_snapshot', true, AUTHORIZE_REASON.ALLOWED],
    ['lead writes a member page (auto-acquire)', lead(), record, WRITE_PAGE, 'browser_click', true, AUTHORIZE_REASON.ALLOWED],
    ['lead manages control', lead(), record, { effect: EFFECT.MANAGE, resource: RESOURCE.PAGE, targetRequired: true }, 'browser_tabs.acquire', true, AUTHORIZE_REASON.ALLOWED],
    ['teammate observes a teammate page', member(MEMBER_B), record, OBSERVE_PAGE, 'browser_snapshot', true, AUTHORIZE_REASON.ALLOWED],
    ['teammate writes own page', member(MEMBER_A), record, WRITE_PAGE, 'browser_click', true, AUTHORIZE_REASON.ALLOWED],
    ['teammate writes a teammate page', member(MEMBER_B), record, WRITE_PAGE, 'browser_click', false, AUTHORIZE_REASON.ROLE_FORBIDDEN],
    ['teammate closes a teammate page', member(MEMBER_B), record, { effect: EFFECT.MANAGE, resource: RESOURCE.PAGE, targetRequired: true }, 'browser_tabs.close', false, AUTHORIZE_REASON.ROLE_FORBIDDEN],
    ['teammate closes own page', member(MEMBER_A), record, { effect: EFFECT.MANAGE, resource: RESOURCE.PAGE, targetRequired: true }, 'browser_tabs.close', true, AUTHORIZE_REASON.ALLOWED],
    ['teammate acquires', member(MEMBER_B), record, { effect: EFFECT.MANAGE, resource: RESOURCE.PAGE, targetRequired: true }, 'browser_tabs.acquire', false, AUTHORIZE_REASON.ROLE_FORBIDDEN],
    ['lead writes while another Lead controls', lead(), leadControlled, WRITE_PAGE, 'browser_click', true, AUTHORIZE_REASON.ALLOWED],
    ['owner writes while the Lead controls', member(MEMBER_A), leadControlled, WRITE_PAGE, 'browser_click', false, AUTHORIZE_REASON.NOT_CONTROLLER],
    ['owner observes while the Lead controls', member(MEMBER_A), leadControlled, OBSERVE_PAGE, 'browser_snapshot', true, AUTHORIZE_REASON.ALLOWED],
  ];
  for (const [label, principal, base, effect, operation, allowed, reason] of cases) {
    const verdict = authorize({ principal, ...base, effect, operation });
    assert.equal(verdict.allowed, allowed, label);
    assert.equal(verdict.reason, reason, label);
  }
});

test('authorize: error codes follow the reason, and role denials are TAB_FORBIDDEN', () => {
  const record = ownedBy(MEMBER_A);
  const denied = authorize({
    principal: member(MEMBER_B),
    ...record,
    effect: WRITE_PAGE,
    operation: 'browser_click',
  });
  assert.equal(denied.code, ERROR_CODES.TAB_FORBIDDEN);
  const notController = authorize({
    principal: member(MEMBER_A),
    ownership: record.ownership,
    control: makeControl({ state: CONTROL_STATE.LEAD_CONTROLLED, controllerSessionId: LEAD, controlRevision: 2 }),
    effect: WRITE_PAGE,
    operation: 'browser_click',
  });
  assert.equal(notController.code, ERROR_CODES.TAB_CONTROL_CHANGED);
});

test('authorize: a standalone domain writes only its own page', () => {
  const solo = standalone('solo');
  const own = ownedBy('solo', { rootSessionId: 'solo' });
  assert.equal(authorize({ principal: solo, ...own, effect: WRITE_PAGE, operation: 'browser_click' }).allowed, true);
  assert.equal(authorize({ principal: solo, ...own, effect: OBSERVE_PAGE, operation: 'browser_snapshot' }).allowed, true);
  // No one to transfer to, and no management rights over itself either.
  assert.equal(
    authorize({ principal: solo, ...own, effect: { effect: EFFECT.MANAGE, resource: RESOURCE.PAGE, targetRequired: true }, operation: 'browser_tabs.acquire' }).allowed,
    false,
  );
  // A teammate of a real team is not a standalone domain for the same page.
  assert.equal(authorize({ principal: member(MEMBER_A, ROOT), ...own, effect: WRITE_PAGE, operation: 'browser_click' }).reason, AUTHORIZE_REASON.CROSS_ROOT);
});

test('authorize: a draining page blocks new writes without becoming a retryable BUSY', () => {
  const draining = {
    ownership: makeOwnership({ rootSessionId: ROOT, creatorSessionId: MEMBER_A, ownerSessionId: MEMBER_A }),
    control: makeControl({
      state: CONTROL_STATE.DRAINING,
      controllerSessionId: MEMBER_A,
      controlRevision: 2,
      pendingControllerSessionId: LEAD,
    }),
  };
  for (const principal of [lead(), member(MEMBER_A)]) {
    const verdict = authorize({ principal, ...draining, effect: WRITE_PAGE, operation: 'browser_click' });
    assert.equal(verdict.allowed, false);
    assert.equal(verdict.reason, AUTHORIZE_REASON.CONTROL_DRAINING);
    assert.equal(verdict.code, ERROR_CODES.TAB_CONTROL_CHANGED);
  }
  // Observation is still allowed: draining blocks writes, not eyes.
  assert.equal(authorize({ principal: member(MEMBER_A), ...draining, effect: OBSERVE_PAGE, operation: 'browser_snapshot' }).allowed, true);
});

test('authorize: a retired page is honestly gone', () => {
  const retired = {
    ownership: makeOwnership({ rootSessionId: ROOT, creatorSessionId: MEMBER_A, ownerSessionId: MEMBER_A }),
    control: makeControl({ state: CONTROL_STATE.RETIRED, controlRevision: 9 }),
  };
  for (const principal of [lead(), member(MEMBER_A)]) {
    const verdict = authorize({ principal, ...retired, effect: OBSERVE_PAGE, operation: 'browser_snapshot' });
    assert.equal(verdict.allowed, false);
    assert.equal(verdict.reason, AUTHORIZE_REASON.TARGET_RETIRED);
    assert.equal(verdict.code, ERROR_CODES.TARGET_GONE);
  }
});

test('authorize: expected versions are checked and reported per axis', () => {
  const record = ownedBy(MEMBER_A, { controlRevision: 4, ownershipRevision: 6 });
  const staleControl = authorize({
    principal: lead(),
    ...record,
    effect: WRITE_PAGE,
    operation: 'browser_click',
    expectedControlRevision: 3,
  });
  assert.equal(staleControl.reason, AUTHORIZE_REASON.CONTROL_REVISION_STALE);
  assert.equal(staleControl.code, ERROR_CODES.TAB_CONTROL_CHANGED);

  const staleOwnership = authorize({
    principal: lead(),
    ...record,
    effect: { effect: EFFECT.MANAGE, resource: RESOURCE.PAGE, targetRequired: true },
    operation: 'browser_tabs.transfer',
    expectedOwnershipRevision: 5,
  });
  assert.equal(staleOwnership.reason, AUTHORIZE_REASON.OWNERSHIP_REVISION_STALE);
  assert.equal(staleOwnership.code, ERROR_CODES.TAB_OWNERSHIP_STALE);
});

test('authorize: an unproved identity never reaches a page', () => {
  const record = ownedBy(MEMBER_A);
  for (const principal of [undefined, null, {}, { ...lead() }, 'lead-1']) {
    const verdict = authorize({ principal, ...record, effect: OBSERVE_PAGE, operation: 'browser_snapshot' });
    assert.equal(verdict.allowed, false);
    assert.equal(verdict.reason, AUTHORIZE_REASON.IDENTITY_UNVERIFIED);
    assert.equal(verdict.code, ERROR_CODES.TAB_IDENTITY_UNAVAILABLE);
  }
});

test('authorize: a page effect without a resolved target is refused, creation is not', () => {
  const denied = authorize({ principal: lead(), effect: OBSERVE_PAGE, operation: 'browser_snapshot' });
  assert.equal(denied.allowed, false);
  assert.equal(denied.reason, AUTHORIZE_REASON.TARGET_UNRESOLVED);
  assert.equal(denied.code, ERROR_CODES.TARGET_NOT_BOUND);

  const open = operationEffect('browser_tabs', { action: 'open' })[0];
  assert.equal(authorize({ principal: lead(), effect: open, operation: 'browser_tabs.open' }).allowed, true);
  assert.equal(authorize({ principal: member(MEMBER_A), effect: open, operation: 'browser_tabs.open' }).allowed, true);
});

test('authorize: a shared artifact write needs a record, a new local copy does not', () => {
  const manage = operationEffect('browser_network_evidence', { action: 'clear' })[0];
  assert.equal(authorize({ principal: lead(), effect: manage, operation: 'browser_network_evidence.clear' }).reason,
    AUTHORIZE_REASON.TARGET_UNRESOLVED);

  const store = {
    ownership: makeOwnership({ rootSessionId: ROOT, creatorSessionId: LEAD, ownerSessionId: LEAD }),
    control: makeControl({ state: CONTROL_STATE.OWNED, controllerSessionId: LEAD }),
  };
  assert.equal(authorize({ principal: lead(), ...store, effect: manage, operation: 'browser_network_evidence.clear' }).allowed, true);
  assert.equal(authorize({ principal: member(MEMBER_B), ...store, effect: manage, operation: 'browser_network_evidence.clear' }).allowed, false);

  const local = operationEffect('browser_network_evidence', { action: 'export' })[0];
  assert.equal(authorize({ principal: member(MEMBER_B), ...store, effect: local, operation: 'browser_network_evidence.export' }).allowed, true);
});

test('authorize: a malformed effect is an argument error, not a pass', () => {
  assert.throws(() => authorize({ principal: lead(), effect: null }), assertCode(ERROR_CODES.INVALID_ARGUMENT));
  assert.throws(
    () => authorize({ principal: lead(), effect: { effect: 'read', resource: RESOURCE.PAGE, targetRequired: true } }),
    assertCode(ERROR_CODES.INVALID_ARGUMENT),
  );
  assert.throws(
    () => authorize({ principal: lead(), effect: { effect: EFFECT.WRITE, resource: 'tabs', targetRequired: true } }),
    assertCode(ERROR_CODES.INVALID_ARGUMENT),
  );
});

test('authorizeAll: the compound call is routed by its strongest effect', () => {
  const record = ownedBy(MEMBER_A);
  const compound = operationEffect('browser_screenshot', { out: 'output/capture/a.png' });
  const asStranger = authorizeAll({
    principal: member(MEMBER_B),
    ...record,
    effects: compound,
    operation: 'browser_neighbour_screenshot',
  });
  assert.equal(asStranger.allowed, true, 'a callerLocal artifact write is theirs by construction');

  const pageWrite = authorizeAll({
    principal: member(MEMBER_B),
    ...record,
    effects: [OBSERVE_PAGE, WRITE_PAGE],
    operation: 'browser_click',
  });
  assert.equal(pageWrite.allowed, false);
  assert.equal(pageWrite.verdict.reason, AUTHORIZE_REASON.ROLE_FORBIDDEN);
  // The strongest requirement is evaluated first, so the verdict is about the write, not the read.
  assert.equal(pageWrite.verdict.effect, EFFECT.WRITE);

  const empty = () => authorizeAll({ principal: lead(), ...record, effects: [], operation: 'x' });
  assert.throws(empty, assertCode(ERROR_CODES.INVALID_ARGUMENT));
});

test('authorize: autoAcquire is only announced when a takeover is actually needed', () => {
  const record = ownedBy(MEMBER_A);
  const leadIdle = authorize({ principal: lead(), ...record, effect: WRITE_PAGE, operation: 'browser_click' });
  assert.equal(leadIdle.autoAcquire, true);
  const ownWrite = authorize({ principal: member(MEMBER_A), ...record, effect: WRITE_PAGE, operation: 'browser_click' });
  assert.equal(ownWrite.autoAcquire, false);
  const observing = authorize({ principal: lead(), ...record, effect: OBSERVE_PAGE, operation: 'browser_snapshot' });
  assert.equal(observing.autoAcquire, false);
});

test('permissions projection: read/write/close/manage/canAcquire per actor', () => {
  const record = ownedBy(MEMBER_A);
  assert.deepEqual({ ...projectPermissions({ principal: lead(), ...record }) }, {
    read: true, write: true, close: true, manage: true, canAcquire: true,
  });
  assert.deepEqual({ ...projectPermissions({ principal: member(MEMBER_A), ...record }) }, {
    read: true, write: true, close: true, manage: false, canAcquire: false,
  });
  assert.deepEqual({ ...projectPermissions({ principal: member(MEMBER_B), ...record }) }, {
    read: true, write: false, close: false, manage: false, canAcquire: false,
  });
  assert.deepEqual({ ...projectPermissions({ principal: lead(OTHER_ROOT), ...record }) }, {
    read: false, write: false, close: false, manage: false, canAcquire: false,
  });
});

test('makePageAccess: a fresh page starts owned at revision 1 with the owner in control', () => {
  const fresh = makePageAccess({ rootSessionId: ROOT, creatorSessionId: MEMBER_A });
  assert.deepEqual({ ...fresh.ownership }, {
    rootSessionId: ROOT, creatorSessionId: MEMBER_A, ownerSessionId: MEMBER_A, ownershipRevision: 1,
  });
  assert.deepEqual({ ...fresh.control }, {
    state: CONTROL_STATE.OWNED, controllerSessionId: MEMBER_A, controlRevision: 1, pendingControllerSessionId: null,
  });
});

/* ---------------------------------------------------------------------------------------------- *
 * 6. Trusted identity resolver
 * ---------------------------------------------------------------------------------------------- */

/** A minimal native-shaped agent registry: exact object identity, nothing else. */
function makeRegistry(agents) {
  return {
    get(id) {
      return agents.find((agent) => agent.id === id);
    },
  };
}

/** A minimal native-shaped team service; `membership`/`listMembers` mirror the host contract. */
function makeTeamService({ membership, rows, throwOnMembership = false, throwOnRoster = false } = {}) {
  return {
    tryMembership(agent) {
      if (throwOnMembership) throw new Error('stale stream');
      return typeof membership === 'function' ? membership(agent) : membership;
    },
    listMembers() {
      if (throwOnRoster) throw new Error('roster unreadable');
      return typeof rows === 'function' ? rows() : (rows ?? []);
    },
  };
}

test('resolver: an exact registered Lead resolves to its own root', () => {
  const root = { id: ROOT, status: 'running' };
  const registry = makeRegistry([root]);
  const resolver = createTabPrincipalResolver({ hostEpoch: 'boot-1', now: () => 1000 });
  const principal = resolver.resolve(root, {
    agentRegistry: registry,
    teamService: makeTeamService({
      membership: (agent) => ({ root: agent, id: 'team-1', role: 'lead', name: 'lead' }),
      rows: [{ id: ROOT, role: 'lead', status: 'running' }],
    }),
  });
  assert.equal(principal.actorSessionId, ROOT);
  assert.equal(principal.rootSessionId, ROOT);
  assert.equal(principal.role, PRINCIPAL_ROLE.LEAD);
  assert.equal(principal.source, PRINCIPAL_SOURCE.AGENT);
  assert.equal(principal.hostEpoch, 'boot-1');
  assert.equal(principal.membershipRevision, 1);
  assert.equal(principal.executionEpoch, 1);
  assert.equal(isPrincipal(principal), true);
});

test('resolver: a teammate resolves to the native root, never to a guessed one', () => {
  const root = { id: ROOT };
  const teammate = { id: MEMBER_A, session: { header: { parentSession: 'some-other-session' } } };
  const registry = makeRegistry([root, teammate]);
  const resolver = createTabPrincipalResolver({ hostEpoch: 'boot-1' });
  const principal = resolver.resolve(teammate, {
    agentRegistry: registry,
    teamService: makeTeamService({
      membership: () => ({ root, id: 'team-1', role: 'teammate', name: 'a' }),
      rows: [{ id: ROOT, role: 'lead', status: 'running' }, { id: MEMBER_A, role: 'teammate', status: 'inactive' }],
    }),
  });
  assert.equal(principal.rootSessionId, ROOT);
  assert.equal(principal.role, PRINCIPAL_ROLE.TEAMMATE);
});

test('resolver: exact object mismatch, missing registration and missing agent are refused', () => {
  const root = { id: ROOT };
  const rebuilt = { id: ROOT };
  const registry = makeRegistry([root]);
  const teamService = makeTeamService({ membership: (agent) => ({ root: agent, role: 'lead' }) });
  const resolver = createTabPrincipalResolver({ hostEpoch: 'boot-1' });

  assert.throws(() => resolver.resolve(rebuilt, { agentRegistry: registry, teamService }),
    assertCode(ERROR_CODES.TAB_IDENTITY_UNAVAILABLE));
  assert.throws(() => resolver.resolve({ id: 'ghost' }, { agentRegistry: registry, teamService }),
    assertCode(ERROR_CODES.TAB_IDENTITY_UNAVAILABLE));
  assert.throws(() => resolver.resolve(undefined, { agentRegistry: registry, teamService }),
    assertCode(ERROR_CODES.TAB_IDENTITY_UNAVAILABLE));
  assert.throws(() => resolver.resolve({ id: '' }, { agentRegistry: registry, teamService }),
    assertCode(ERROR_CODES.TAB_IDENTITY_UNAVAILABLE));
});

test('resolver: an unreadable registry or roster is unavailable, not permissive', () => {
  const root = { id: ROOT };
  const resolver = createTabPrincipalResolver({ hostEpoch: 'boot-1' });
  assert.throws(() => resolver.resolve(root, { agentRegistry: null, teamService: makeTeamService({}) }),
    assertCode(ERROR_CODES.TAB_IDENTITY_UNAVAILABLE));
  assert.throws(() => resolver.resolve(root, {
    agentRegistry: { get() { throw new Error('registry down'); } },
    teamService: makeTeamService({ membership: (agent) => ({ root: agent, role: 'lead' }) }),
  }), assertCode(ERROR_CODES.TAB_IDENTITY_UNAVAILABLE));
  assert.throws(() => resolver.resolve(root, {
    agentRegistry: makeRegistry([root]),
    teamService: makeTeamService({ membership: (agent) => ({ root: agent, role: 'lead' }), throwOnRoster: true }),
  }), assertCode(ERROR_CODES.TAB_IDENTITY_UNAVAILABLE));
});

test('resolver: membership undefined never degrades into a standalone domain', () => {
  const root = { id: ROOT };
  const resolver = createTabPrincipalResolver({ hostEpoch: 'boot-1' });
  const deps = { agentRegistry: makeRegistry([root]), teamService: makeTeamService({ membership: undefined }) };
  let thrown;
  try {
    resolver.resolve(root, deps);
  } catch (error) {
    thrown = error;
  }
  assert.equal(thrown?.code, ERROR_CODES.TAB_IDENTITY_UNAVAILABLE);
  assert.equal(thrown?.details?.reason, 'membership-undefined');

  // A throwing probe is "could not prove", not "proved false".
  assert.throws(() => resolver.resolve(root, {
    agentRegistry: makeRegistry([root]),
    teamService: makeTeamService({ throwOnMembership: true }),
  }), assertCode(ERROR_CODES.TAB_IDENTITY_UNAVAILABLE));
});

test('resolver: standalone needs an explicit host proof naming the actor itself', () => {
  const solo = { id: 'solo' };
  const registry = makeRegistry([solo]);
  const resolver = createTabPrincipalResolver({ hostEpoch: 'boot-1' });
  const noProof = { agentRegistry: registry, teamService: undefined };

  assert.throws(() => resolver.resolve(solo, noProof), assertCode(ERROR_CODES.TAB_IDENTITY_UNAVAILABLE));
  assert.throws(
    () => resolver.resolve(solo, { ...noProof, standaloneProof: () => false }),
    assertCode(ERROR_CODES.TAB_IDENTITY_UNAVAILABLE),
  );
  // A proof naming another root would let an independent session claim a team's domain.
  assert.throws(
    () => resolver.resolve(solo, { ...noProof, standaloneProof: () => ROOT }),
    assertCode(ERROR_CODES.TAB_IDENTITY_UNAVAILABLE),
  );
  // A throwing proof is no proof.
  assert.throws(
    () => resolver.resolve(solo, { ...noProof, standaloneProof: () => { throw new Error('nope'); } }),
    assertCode(ERROR_CODES.TAB_IDENTITY_UNAVAILABLE),
  );
  const principal = resolver.resolve(solo, { ...noProof, standaloneProof: () => true });
  assert.equal(principal.role, PRINCIPAL_ROLE.STANDALONE);
  assert.equal(principal.rootSessionId, 'solo');
});

test('resolver: a teammate without a fresh valid roster row is refused', () => {
  const root = { id: ROOT };
  const teammate = { id: MEMBER_A };
  const registry = makeRegistry([root, teammate]);
  const resolver = createTabPrincipalResolver({ hostEpoch: 'boot-1' });
  const membership = () => ({ root, role: 'teammate', id: 'team-1', name: 'a' });

  for (const rows of [
    [],                                                            // removed from the roster
    [{ id: MEMBER_A, role: 'teammate', status: 'failed' }],         // never ran / broke
    [{ id: MEMBER_A, role: 'teammate', status: 'provisioning' }],   // not a member yet
  ]) {
    assert.throws(
      () => resolver.resolve(teammate, { agentRegistry: registry, teamService: makeTeamService({ membership, rows }) }),
      assertCode(ERROR_CODES.TAB_IDENTITY_UNAVAILABLE),
      JSON.stringify(rows),
    );
  }
  // `inactive` is not a membership change: the Lead may still hand this page over.
  const principal = resolver.resolve(teammate, {
    agentRegistry: registry,
    teamService: makeTeamService({ membership, rows: [{ id: MEMBER_A, role: 'teammate', status: 'inactive' }] }),
  });
  assert.equal(principal.role, PRINCIPAL_ROLE.TEAMMATE);
});

test('resolver: a stale root object is refused even when the id still matches', () => {
  const root = { id: ROOT };
  const oldRoot = { id: ROOT };
  const teammate = { id: MEMBER_A };
  const resolver = createTabPrincipalResolver({ hostEpoch: 'boot-1' });
  assert.throws(() => resolver.resolve(teammate, {
    agentRegistry: makeRegistry([root, teammate]),
    teamService: makeTeamService({
      membership: () => ({ root: oldRoot, role: 'teammate', id: 'team-1', name: 'a' }),
      rows: [{ id: MEMBER_A, role: 'teammate', status: 'running' }],
    }),
  }), assertCode(ERROR_CODES.TAB_IDENTITY_UNAVAILABLE));
});

test('resolver: a revoked agent object never becomes valid again, a resume gets a new epoch', () => {
  const makeDeps = (agent) => ({
    agentRegistry: makeRegistry([agent]),
    teamService: makeTeamService({
      membership: (self) => ({ root: self, id: 'team-1', role: 'lead', name: 'lead' }),
      rows: [{ id: agent.id, role: 'lead', status: 'running' }],
    }),
  });
  const resolver = createTabPrincipalResolver({ hostEpoch: 'boot-1' });
  const first = { id: ROOT };
  const firstDeps = makeDeps(first);
  const initial = resolver.resolve(first, firstDeps);
  assert.equal(initial.executionEpoch, 1);
  assert.equal(initial.membershipRevision, 1);

  // Same object, same services: nothing changes (a new service object would be a revision bump).
  const again = resolver.resolve(first, firstDeps);
  assert.equal(again.executionEpoch, 1);
  assert.equal(again.membershipRevision, 1);

  // Disposed and resumed with a *new* object: epoch moves, root and role stay.
  assert.equal(resolver.invalidate(first), true);
  const resumed = { id: ROOT };
  const resumedDeps = makeDeps(resumed);
  const afterResume = resolver.resolve(resumed, resumedDeps);
  assert.equal(afterResume.executionEpoch, 2);
  assert.equal(afterResume.rootSessionId, ROOT);
  assert.equal(afterResume.role, PRINCIPAL_ROLE.LEAD);
  assert.equal(afterResume.membershipRevision, 2, 'an invalidated-then-restored identity is a state change');

  // The old object is dead forever, even if the host hands it back.
  assert.throws(() => resolver.resolve(first, firstDeps), assertCode(ERROR_CODES.TAB_IDENTITY_UNAVAILABLE));
});

test('resolver: membership revisions move on roster/root/service change, not on activity', () => {
  const root = { id: ROOT };
  const teammate = { id: MEMBER_A };
  const registry = makeRegistry([root, teammate]);

  let rows = [{ id: ROOT, role: 'lead', status: 'running' }, { id: MEMBER_A, role: 'teammate', status: 'running' }];
  let teamService = makeTeamService({
    membership: () => ({ root, role: 'teammate', id: 'team-1', name: 'a' }),
    rows: () => rows,
  });
  const resolver = createTabPrincipalResolver({ hostEpoch: 'boot-1' });

  const first = resolver.resolve(teammate, { agentRegistry: registry, teamService });
  assert.equal(first.membershipRevision, 1);

  // Turn activity is not a membership change.
  rows = [{ id: ROOT, role: 'lead', status: 'running' }, { id: MEMBER_A, role: 'teammate', status: 'inactive' }];
  assert.equal(resolver.resolve(teammate, { agentRegistry: registry, teamService }).membershipRevision, 1);

  // A new member is.
  rows = [...rows, { id: MEMBER_B, role: 'teammate', status: 'running' }];
  assert.equal(resolver.resolve(teammate, { agentRegistry: registry, teamService }).membershipRevision, 2);

  // A different native service instance is.
  teamService = makeTeamService({
    membership: () => ({ root, role: 'teammate', id: 'team-2', name: 'a' }),
    rows: () => rows,
  });
  assert.equal(resolver.resolve(teammate, { agentRegistry: registry, teamService }).membershipRevision, 3);
});

test('resolver: roster fingerprint ignores order and turn activity', () => {
  const a = { id: 'a', role: 'teammate', status: 'running' };
  const b = { id: 'b', role: 'teammate', status: 'inactive' };
  const leadRow = { id: ROOT, role: 'lead', status: 'running' };
  assert.equal(rosterFingerprint([a, b, leadRow]), rosterFingerprint([leadRow, b, a]));
  assert.equal(rosterFingerprint([{ ...a, status: 'inactive' }, b, leadRow]), rosterFingerprint([a, b, leadRow]));
  assert.notEqual(rosterFingerprint([a, b, leadRow]), rosterFingerprint([a, leadRow]));
  assert.equal(isValidRosterRow({ id: 'x', role: 'teammate', status: 'failed' }), false);
  assert.equal(isValidRosterRow({ id: 'x', role: 'teammate', status: 'provisioning' }), false);
  assert.equal(isValidRosterRow({ id: 'x', role: 'teammate', status: 'running' }), true);
  assert.equal(isValidRosterRow({ id: '', role: 'teammate', status: 'running' }), false);
});

test('resolvePrincipal: the seam is injected, and a bad seam is an argument error', () => {
  const root = { id: ROOT };
  const principal = resolvePrincipal(root, {
    agentRegistry: makeRegistry([root]),
    teamService: makeTeamService({
      membership: (agent) => ({ root: agent, role: 'lead' }),
      rows: [{ id: ROOT, role: 'lead', status: 'running' }],
    }),
    now: 1234,
  });
  assert.equal(principal.rootSessionId, ROOT);
  assert.throws(
    () => resolvePrincipal(root, { identityResolver: {} }),
    assertCode(ERROR_CODES.INVALID_ARGUMENT),
  );
});

/* ---------------------------------------------------------------------------------------------- *
 * 7. Module purity and two-table taxonomy agreement
 * ---------------------------------------------------------------------------------------------- */

test('purity: core/tab-access.js imports only neutral core modules', () => {
  const source = stripComments(readFileSync(new URL('../../core/tab-access.js', import.meta.url), 'utf8'));
  const specifiers = [...source.matchAll(/^import\s[^;]*?from\s+'([^']+)'/gms)].map((match) => match[1]);
  assert.deepEqual(specifiers.sort(), ['./contracts.js', './errors.js']);
  for (const forbidden of ['node:', 'cordis', 'ctx.get', 'require(', 'process.', 'fetch(', 'document.', 'window.']) {
    assert.equal(source.includes(forbidden), false, `core/tab-access.js must not reference ${forbidden}`);
  }
});

test('seam: integration/tab-principal.js never reaches into index.js or a Cordis context', () => {
  const source = stripComments(readFileSync(new URL('../../integration/tab-principal.js', import.meta.url), 'utf8'));
  const specifiers = [...source.matchAll(/^import\s[^;]*?from\s+'([^']+)'/gms)].map((match) => match[1]);
  assert.deepEqual(specifiers.sort(), ['../core/index.js', 'node:crypto']);
  for (const forbidden of ["from './index.js'", "from '../index.js'", 'ctx.get', 'ctx.agents', 'ctx.team']) {
    assert.equal(source.includes(forbidden), false, `tab-principal.js must not reference ${forbidden}`);
  }
});

test('taxonomy: both registries know the M1 codes and none of them is internal', () => {
  const shared = [
    'TAB_FORBIDDEN', 'TAB_NOT_FOUND', 'TAB_LIMIT', 'TAB_CONTROL_CHANGED', 'TAB_OWNERSHIP_STALE',
    'TAB_IDENTITY_UNAVAILABLE', 'TAB_OBSERVATION_STALE', 'OBSERVATION_UNAVAILABLE', 'RUNTIME_LIMIT',
  ];
  for (const name of shared) {
    assert.equal(ERROR_CODES[name], name, `${name} missing from core/contracts.js ERROR_CODES`);
    const core = CORE_TAXONOMY[name];
    const browser = BROWSER_TAXONOMY[name];
    assert.ok(core, `${name} missing from core/errors.js ERROR_TAXONOMY`);
    assert.ok(browser, `${name} missing from browser-safety.js ERROR_TAXONOMY`);
    assert.notEqual(core[0], 'internal', `${name} would degrade to INTERNAL in core`);
    assert.notEqual(browser[0], 'internal', `${name} would degrade to INTERNAL at the tool boundary`);
    // The retryable flag is what callers act on; it must agree across the two tables.
    assert.equal(core[1], browser[1], `${name} retryable disagrees between core and browser taxonomies`);
  }
  // Deliberate divergence, frozen by tests/error-taxonomy.test.mjs: the pre-existing surface keeps
  // TAB_NOT_FOUND as `scope` (its consumers branch on that), while the neutral core classifies it
  // as `target` per ruling §7.3. Both are non-internal, which is the part that must not drift.
  assert.equal(CORE_TAXONOMY.TAB_NOT_FOUND[0], 'target');
  assert.equal(BROWSER_TAXONOMY.TAB_NOT_FOUND[0], 'scope');
});

test('taxonomy: every code thrown by the new modules is registered in both tables', () => {
  const sources = [
    readFileSync(new URL('../../core/tab-access.js', import.meta.url), 'utf8'),
    readFileSync(new URL('../../integration/tab-principal.js', import.meta.url), 'utf8'),
  ].join('\n');
  const codes = new Set([...sources.matchAll(/ERROR_CODES\.([A-Z][A-Z0-9_]*)/g)].map((match) => match[1]));
  assert.ok(codes.size > 0);
  const missing = [...codes].filter((name) => !CORE_TAXONOMY[name] || !BROWSER_TAXONOMY[name]);
  assert.deepEqual(missing, [], `codes missing from a taxonomy: ${missing.join(', ')}`);
  for (const name of codes) {
    assert.notEqual(CORE_TAXONOMY[name][0], 'internal', `${name} in core`);
    assert.notEqual(BROWSER_TAXONOMY[name][0], 'internal', `${name} in browser-safety`);
  }
});
