/**
 * runtime-debug.test.mjs — FR-05 运行时分析纯核心（RT-01..RT-07）。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  BreakpointBook, DEBUG_LIMITS, PauseGuard, SENSITIVE_VARIABLE,
  correlatePauseWithRequest, normalizeBreakpoint, projectCallFrame,
  projectRemoteObject, projectScopes, verifySignatureAtRuntime,
} from '../runtime-debug.js';

const ok = (condition, message) => assert.ok(condition, message);

/* ----------------------------------------------------------------------------------------------- */

test('RT-01 normalizeBreakpoint: URL breakpoints only, line required', () => {
  const bp = normalizeBreakpoint({ url: 'https://a/x.js', lineNumber: 10 });
  ok(bp.url === 'https://a/x.js' && bp.lineNumber === 10 && bp.columnNumber === 0);
  ok(normalizeBreakpoint({ lineNumber: 10 }) === null, 'url required');
  ok(normalizeBreakpoint({ url: 'x', lineNumber: -1 }) === null, 'negative line refused');
  ok(normalizeBreakpoint(null) === null);
});

test('RT-01 BreakpointBook counts hits truthfully (0 stays 0)', () => {
  const book = new BreakpointBook();
  const reg = book.register('bp-1', { url: 'https://a/x.js', lineNumber: 5, columnNumber: 0, condition: null, label: 'sign' }, { locations: [{ scriptId: 's1', lineNumber: 5, columnNumber: 0 }] });
  ok(reg.ok === true && reg.record.resolved === true);
  let projection = book.projection();
  ok(projection[0].hitCount === 0, 'never hit = 0, not "probably hit"');
  book.recordHit(['bp-1']);
  projection = book.projection();
  ok(projection[0].hitCount === 1 && projection[0].lastHitAt !== null);
  ok(book.findByLabel('sign')?.cdpBreakpointId === 'bp-1');
  ok(book.remove('bp-1').ok === true && book.projection().length === 0);
  ok(book.remove('bp-1').ok === false, 'double remove refused');
});

test('RT-01 BreakpointBook enforces the breakpoint ceiling', () => {
  const book = new BreakpointBook();
  for (let i = 0; i < DEBUG_LIMITS.maxBreakpoints; i += 1) {
    book.register('bp-' + i, { url: 'u', lineNumber: i, columnNumber: 0, condition: null, label: null });
  }
  const over = book.register('bp-over', { url: 'u', lineNumber: 0, columnNumber: 0, condition: null, label: null });
  ok(over.ok === false && over.code === 'DEBUG_LIMIT_REACHED');
});

test('RT-07 projectRemoteObject redacts sensitive names to shape only', () => {
  const token = projectRemoteObject({ type: 'string', value: 'super-secret-token-value' }, { name: 'authToken' });
  ok(token.sensitive === true && token.value === null && token.valueOmitted === true);
  ok(token.valueLength === 24, 'length retained, value never');
  ok(JSON.stringify(token).includes('super-secret') === false, 'no value anywhere in the projection');
  const cookie = projectRemoteObject({ type: 'string', value: 'lab_session=abc' }, { name: 'Cookie' });
  ok(cookie.value === null, 'cookie name case-insensitive');
  const plain = projectRemoteObject({ type: 'string', value: 'hello' }, { name: 'label' });
  ok(plain.value === 'hello' && plain.sensitive === false);
  ok(SENSITIVE_VARIABLE.test('X-Lab-Proof'), 'signature-ish names are sensitive');
});

test('RT-07 projectRemoteObject truncates long non-sensitive strings and drops objectIds', () => {
  const long = projectRemoteObject({ type: 'string', value: 'a'.repeat(DEBUG_LIMITS.maxStringBytes + 10) }, { name: 'body' });
  ok(long.truncated === true && long.value.length === DEBUG_LIMITS.maxStringBytes && long.originalLength > DEBUG_LIMITS.maxStringBytes);
  const obj = projectRemoteObject({ type: 'object', objectId: 'live-handle', description: 'Object' }, { name: 'data' });
  ok(obj.objectId === null, 'live objectIds never leave the Host');
  ok(projectRemoteObject(null, { name: 'x' }).type === 'unknown', 'junk input tolerated');
});

test('RT-07 projectScopes projects variables and reports availability honestly', () => {
  const scopeChain = [{ type: 'local', object: { description: 'Local' } }, { type: 'closure' }];
  const without = projectScopes(scopeChain);
  ok(without.length === 2 && without[0].variablesAvailable === false, 'no vars without a provider');
  const withVars = projectScopes(scopeChain, {
    variablesOf: (index) => (index === 0
      ? [{ name: 'proof', value: { type: 'string', value: 'abc' } }, { name: 'sessionToken', value: { type: 'string', value: 'sekret' } }]
      : []),
  });
  ok(withVars[0].variables.length === 2);
  ok(withVars[0].variables[1].value === null && withVars[0].variables[1].sensitive === true, 'token value redacted inside scopes');
});

test('RT-02 projectCallFrame keeps locations and drops live handles', () => {
  const frame = projectCallFrame({
    callFrameId: 'live', functionName: 'sign', url: 'https://a/app.js',
    location: { scriptId: 's1', lineNumber: 42, columnNumber: 7 },
    functionLocation: { lineNumber: 40 },
    scopeChain: [{}, {}],
  }, { index: 0 });
  ok(frame.callFrameId === null, 'live handle never exposed');
  ok(frame.lineNumber === 42 && frame.scriptId === 's1' && frame.functionName === 'sign');
  ok(frame.scopeCount === 2 && frame.index === 0);
  ok(projectCallFrame({}).functionName === '(anonymous)');
});

test('RT-04 correlatePauseWithRequest grades confirmed/likely/possible/null', () => {
  const pause = {
    pausedAtMs: 1000,
    callFrames: [
      { url: 'https://a/app.js', location: { scriptId: 's1', lineNumber: 42 } },
      { url: 'https://a/other.js', location: { scriptId: 's2', lineNumber: 9 } },
    ],
  };
  const confirmed = correlatePauseWithRequest(pause, {
    url: 'https://a/api/login', atMs: 1010,
    initiator: { stack: { callFrames: [{ scriptId: 's1', lineNumber: 42 }] } },
  });
  ok(confirmed.grade === 'confirmed' && confirmed.basis === 'initiator');

  const likely = correlatePauseWithRequest(pause, { url: 'https://a/app.js', atMs: 1010 });
  ok(likely.grade === 'likely' && likely.basis === 'stack-url');

  const possible = correlatePauseWithRequest(pause, { url: 'https://a/api/x', atMs: 1100 });
  ok(possible.grade === 'possible' && possible.basis === 'temporal');
  ok(String(possible.evidence.note).includes('不等于因果'), 'temporal is explicitly not causal');

  const none = correlatePauseWithRequest(pause, { url: 'https://a/api/x', atMs: 99_999 });
  ok(none.grade === null, 'no basis = null, never forced');
});

test('RT-06 PauseGuard: timeout forces a resume decision', () => {
  let clock = 1000;
  const guard = new PauseGuard({ now: () => clock, timeoutMs: 5000 });
  guard.enter({ reason: 'breakpoint', callFrames: [{}], hitBreakpoints: ['bp-1'], atMs: clock });
  ok(guard.checkTimeout(clock + 100).paused === true, 'still paused inside the window');
  const timeout = guard.checkTimeout(clock + 5001);
  ok(timeout.mustResume === true && timeout.timedOutReason === 'pause-timeout', 'over timeout must resume');
  ok(timeout.record.mustResume === true, 'the timed-out record is marked for the audit trail');
  ok(guard.projection().timeouts === 1 && guard.projection().paused === false);
  ok(guard.checkTimeout(clock + 9000).mustResume === false, 'no second resume demand');
});

test('RT-06 PauseGuard records a conflicting second pause without losing the first', () => {
  const guard = new PauseGuard({ now: () => 1000, timeoutMs: 5000 });
  guard.enter({ reason: 'one', callFrames: [], hitBreakpoints: [] });
  const second = guard.enter({ reason: 'two', callFrames: [], hitBreakpoints: [] });
  ok(second.conflict === true, 'overlapping pause is flagged, not silently merged');
  ok(guard.resume().wasPaused === true);
  ok(guard.resume().wasPaused === false, 'double resume is a no-op');
});

test('RT-05 verifySignatureAtRuntime compares only comparable items', () => {
  const result = verifySignatureAtRuntime({
    expected: { salt: 'lab-client-salt-2026', order: 'salt|ts|user', ts: '123' },
    observed: { salt: 'lab-client-salt-2026', order: 'salt|ts|user', ts: '123' },
  });
  ok(result.consistent === true && result.rate === 1, 'full match');
  const partial = verifySignatureAtRuntime({ expected: { a: '1', b: '2' }, observed: { a: '1' } });
  ok(partial.matched === 1 && partial.comparable === 1 && partial.missing === 1, 'missing not counted as match');
  ok(partial.rate === 1 && partial.consistent === true, 'rate is over comparable only (missing reported separately)');
});

test('RT-05/RT-07 sensitive signature fields compare by shape, never by value', () => {
  const result = verifySignatureAtRuntime({
    expected: { signature: 'abc123', salt: 'lab-client-salt-2026' },
    observed: { signature: 'zzz999', salt: 'lab-client-salt-2026' },
  });
  const sig = result.comparisons.find((entry) => entry.name === 'signature');
  ok(sig.sensitive === true && sig.verdict === 'match-shape', 'same length = match-shape');
  ok(sig.expected === 'string:6' && sig.observed === 'string:6', 'shape only, no values echoed');
  const saltShape = result.comparisons.find((entry) => entry.name === 'salt');
  ok(saltShape.sensitive === true && saltShape.verdict === 'match-shape');
  const mismatch = verifySignatureAtRuntime({ expected: { token: 'abc' }, observed: { token: 'abcdef' } });
  ok(mismatch.comparisons[0].verdict === 'mismatch', 'different length = mismatch');
});

/* -----------------------------------------------------------------------------------------------
 * RT-01 补充：断点定义可重放（导航后保住"加载时断点"）
 * ---------------------------------------------------------------------------------------------- */

test('RT-01 definitions() exposes every stored breakpoint for replay', () => {
  const book = new BreakpointBook();
  book.register('b1', { url: 'http://a:1/x.js', lineNumber: 10, columnNumber: 0, condition: null, label: 'one' },
    { locations: [{ scriptId: 's1', lineNumber: 10, columnNumber: 4 }] });
  book.register('b2', { url: 'http://a:1/y.js', lineNumber: 3, columnNumber: 2, condition: 'x>1', label: 'two' },
    { locations: [] });
  const definitions = book.definitions();
  ok(definitions.length === 2, 'both definitions are exposed');
  const first = definitions.find((entry) => entry.label === 'one');
  ok(first.url === 'http://a:1/x.js' && first.lineNumber === 10 && first.condition === null);
  const second = definitions.find((entry) => entry.label === 'two');
  ok(second.condition === 'x>1', 'a conditional breakpoint keeps its condition');
  ok(second.lineNumber === 3 && second.columnNumber === 2, 'position is preserved exactly');
});

test('RT-01 replaceId rebinds a breakpoint after navigation and resets resolution honestly', () => {
  const book = new BreakpointBook();
  book.register('old', { url: 'http://a:1/x.js', lineNumber: 7, columnNumber: 0, condition: null, label: 'load' },
    { locations: [{ scriptId: 's9', lineNumber: 7, columnNumber: 0 }] });
  ok(book.projection()[0].resolved === true, 'resolved before navigation');
  const rebound = book.replaceId('old', 'new', { locations: [] });
  ok(rebound !== null && rebound.cdpBreakpointId === 'new', 'the id is replaced');
  ok(rebound.resolved === false, 'unresolved after replay without locations (honest, not assumed)');
  const list = book.projection();
  ok(list.length === 1 && list[0].cdpBreakpointId === 'new', 'no duplicate row is left behind');
  ok(list[0].label === 'load', 'the label survives the rebind');
  // A hit on the new id must be recorded against the same logical breakpoint.
  book.recordHit(['new']);
  ok(book.projection()[0].hitCount === 1, 'hits on the rebound id are counted');
});

test('RT-01 replaceId on an unknown id returns null instead of inventing a row', () => {
  const book = new BreakpointBook();
  ok(book.replaceId('nope', 'newer', { locations: [] }) === null);
  ok(book.projection().length === 0);
});
