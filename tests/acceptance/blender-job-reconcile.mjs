import test from 'node:test';
import assert from 'node:assert/strict';
import { createBlenderJobStore, createBlenderTools } from '../../targets/three-d/tools.js';
import { getSchema, validateToolInput, validateToolOutput } from '../../tools/blender/schema.js';

const context = { workspaceKey: 'workspace:reconcile', owner: 'session_reconciler' };
const applied = () => ({ kind: 'applied', evidence: { sceneRevision: 7, contentHash: 'a'.repeat(64), source: 'external-scene-readback' } });
const notApplied = () => ({ kind: 'not-applied', evidence: { absent: true, source: 'external-replay' } });
const stillUnknown = () => ({ kind: 'still-unknown', evidence: { source: 'external-probe', reachable: false } });
const rejects = (callback, code) => assert.throws(callback, error => error.code === code && error.details.effectState === 'none');

function fixture(t, { origin = 'timeout', effectState = 'unknown', receipt = 'error' } = {}) {
  const store = createBlenderJobStore(); t.after(() => store.dispose());
  const job = store.register({ ...context, idemKey: 'job_reconcile', input: { op: 'scene-write' } });
  store.start(job.jobId, context);
  if (origin === 'cancel') store.execute({ action: 'cancel', jobId: job.jobId }, context);
  else store.settle(job.jobId, context, receipt === 'error'
    ? { error: { code: 'OPERATION_TIMEOUT', message: 'No execution receipt.' }, effectState }
    : { result: { artifactId: 'art_execution_receipt' }, effectState });
  return { store, jobId: job.jobId, read: () => store.execute({ action: 'status', jobId: job.jobId }, context) };
}

for (const origin of ['timeout', 'cancel']) {
  test(`unknown from ${origin} converges to committed only from caller-supplied applied evidence`, t => {
    const f = fixture(t, { origin }); const before = f.read(); const observed = applied();
    const start = Date.now();
    const result = f.store.reconcile(f.jobId, context, { observed });
    assert.equal(result.state, 'succeeded'); assert.equal(result.effectState, 'committed'); assert.equal(result.progress, 1);
    assert.equal(result.reconciledBy, context.owner);
    assert.ok(Date.parse(result.reconciledAt) >= start && Date.parse(result.reconciledAt) <= Date.now());
    assert.deepEqual(result.observed, observed);
    assert.deepEqual(result.from, before);
    assert.deepEqual(result.to, { state: 'succeeded', effectState: 'committed' });
    assert.deepEqual(result.reconciliationHistory, [{ reconciledAt: result.reconciledAt, reconciledBy: context.owner, observed,
      from: before, to: result.to }]);
    assert.equal('error' in result, false); assert.equal('result' in result, false);
    assert.equal(f.read().state, 'succeeded'); assert.equal(f.read().effectState, 'committed');
    observed.evidence.sceneRevision = 99; result.observed.evidence.sceneRevision = 100;
    result.reconciliationHistory[0].observed.evidence.sceneRevision = 101;
    const retry = f.store.reconcile(f.jobId, context, { observed: applied() });
    assert.equal(retry.observed.evidence.sceneRevision, 7);
    assert.equal(retry.reconciliationHistory[0].observed.evidence.sceneRevision, 7);
    assert.equal(retry.reconciledAt, result.reconciledAt);
  });

  test(`unknown from ${origin} converges to none only from caller-supplied not-applied evidence`, t => {
    const f = fixture(t, { origin }); const observed = notApplied();
    const result = f.store.reconcile(f.jobId, context, { observed });
    assert.equal(result.state, 'failed'); assert.equal(result.effectState, 'none'); assert.equal(result.progress, 1);
    assert.deepEqual(result.observed, observed);
    assert.deepEqual(result.to, { state: 'failed', effectState: 'none' });
    assert.deepEqual(f.read(), { jobId: f.jobId, state: 'failed', progress: 1, effectState: 'none',
      ...(origin === 'timeout' ? { error: { code: 'OPERATION_TIMEOUT', message: 'No execution receipt.' } } : {}) });
  });

  test(`still-unknown from ${origin} preserves uncertainty and can later be reconciled`, t => {
    const f = fixture(t, { origin }); const before = f.read(); const observed = stillUnknown();
    const first = f.store.reconcile(f.jobId, context, { observed });
    assert.deepEqual(f.read(), before);
    assert.equal(first.effectState, 'unknown'); assert.equal(first.state, before.state);
    assert.deepEqual(first.observed, observed); assert.deepEqual(first.from, before);
    assert.deepEqual(first.to, { state: before.state, effectState: 'unknown' });
    const secondObserved = { ...stillUnknown(), probeId: 'external-probe-2' };
    const second = f.store.reconcile(f.jobId, context, { observed: secondObserved });
    assert.deepEqual(f.read(), before); assert.equal(second.reconciliationHistory.length, 2);
    assert.deepEqual(second.observed, secondObserved);
    const final = f.store.reconcile(f.jobId, context, { observed: applied() });
    assert.equal(final.effectState, 'committed'); assert.equal(final.reconciliationHistory.length, 3);
    assert.deepEqual(final.reconciliationHistory.map(entry => entry.observed.kind), ['still-unknown', 'still-unknown', 'applied']);
    assert.equal(final.reconciliationHistory[2].from.effectState, 'unknown');
  });
}

test('known effects and queued/running jobs cannot be rewritten by reconciliation', t => {
  const store = createBlenderJobStore(); t.after(() => store.dispose());
  for (const state of ['queued', 'running', 'succeeded', 'failed', 'cancelled']) {
    for (const effectState of ['none', 'partial', 'committed']) {
      if (['queued', 'running', 'cancelled'].includes(state) && effectState !== 'none') continue;
      const job = store.register({ ...context, idemKey: `${state}-${effectState}`, input: { state, effectState } });
      if (['running', 'succeeded', 'failed'].includes(state)) store.start(job.jobId, context);
      if (['succeeded', 'failed'].includes(state)) store.settle(job.jobId, context,
        { ...(state === 'failed' ? { error: { code: 'SEMANTIC_INVALID' } } : { result: { done: true } }), effectState });
      if (state === 'cancelled') store.execute({ action: 'cancel', jobId: job.jobId }, context);
      const before = store.execute({ action: 'status', jobId: job.jobId }, context);
      rejects(() => store.reconcile(job.jobId, context, { observed: applied() }), 'SCHEMA_INVALID');
      assert.deepEqual(store.execute({ action: 'status', jobId: job.jobId }, context), before);
    }
  }
});

for (const observe of [applied, notApplied]) {
  test(`${observe().kind} reconciliation retries preserve the terminal state and reject conflicting conclusions`, t => {
    const f = fixture(t); const observed = observe();
    const first = f.store.reconcile(f.jobId, context, { observed });
    assert.deepEqual(f.store.reconcile(f.jobId, context, { observed: structuredClone(observed) }), first);
    assert.deepEqual(f.store.reconcile(f.jobId, context, { observed: { ...observed, evidence: { externalRetry: true } } }), first);
    const opposite = observed.kind === 'applied' ? notApplied() : applied();
    for (const conflict of [opposite, stillUnknown()]) {
      rejects(() => f.store.reconcile(f.jobId, context, { observed: conflict }), 'IDEMPOTENCY_CONFLICT');
      assert.deepEqual(f.store.reconcile(f.jobId, context, { observed }), first);
    }
  });
}

test('reconciliation rejects missing identity and isolates caller/workspace even on terminal retries', t => {
  const f = fixture(t); const before = f.read();
  for (const caller of [undefined, {}, { workspaceKey: context.workspaceKey }, { ...context, owner: '' },
    { ...context, owner: ' ' }, { ...context, owner: 1 }, { owner: context.owner }]) {
    rejects(() => f.store.reconcile(f.jobId, caller, { observed: applied() }), 'AUTHORIZATION_REQUIRED');
    rejects(() => f.store.reconcile('job_missing', caller, { observed: applied() }), 'AUTHORIZATION_REQUIRED');
    assert.deepEqual(f.read(), before);
  }
  for (const caller of [{ ...context, owner: 'foreign' }, { ...context, workspaceKey: 'workspace:foreign' }]) {
    rejects(() => f.store.reconcile(f.jobId, caller, { observed: applied() }), 'TARGET_GONE');
  }
  rejects(() => f.store.reconcile('job_missing', context, { observed: applied() }), 'TARGET_GONE');
  f.store.reconcile(f.jobId, context, { observed: applied() });
  rejects(() => f.store.reconcile(f.jobId, { ...context, owner: 'foreign' }, { observed: applied() }), 'TARGET_GONE');
  rejects(() => f.store.reconcile(f.jobId, {}, { observed: notApplied() }), 'AUTHORIZATION_REQUIRED');
});

test('missing or malformed external observations cannot silently determine an unknown effect', t => {
  const f = fixture(t); const before = f.read();
  for (const observed of [undefined, null, [], true, {}, { kind: 'committed', evidence: { sceneRevision: 1 } },
    { kind: 'applied' }, { kind: 'applied', evidence: null }, { kind: 'applied', evidence: [] },
    { kind: 'applied', evidence: 'guessed' }, { kind: 'applied', evidence: {} },
    { kind: 'applied', evidence: { readback: () => true } }]) {
    rejects(() => f.store.reconcile(f.jobId, context, { observed }), 'SCHEMA_INVALID');
    assert.deepEqual(f.read(), before);
  }
  rejects(() => f.store.reconcile(f.jobId, context), 'SCHEMA_INVALID');
});

test('reconciliation preserves genuine result receipts, removes contradictory receipts, and audits the original', t => {
  const a = fixture(t, { receipt: 'result' });
  const appliedResult = a.store.reconcile(a.jobId, context, { observed: applied() });
  assert.deepEqual(appliedResult.result, { artifactId: 'art_execution_receipt' });
  const b = fixture(t, { receipt: 'result' });
  const absentResult = b.store.reconcile(b.jobId, context, { observed: notApplied() });
  assert.equal('result' in absentResult, false); assert.equal('error' in absentResult, false);
  assert.deepEqual(absentResult.from.result, { artifactId: 'art_execution_receipt' });
});

test('reconciliation remains library-only, advertises the limitation, and keeps frozen job responses valid', async t => {
  const f = fixture(t);
  const inputSchema = getSchema('urn:dsh:blender:tool:blender_job:input:v1');
  assert.deepEqual(inputSchema.oneOf.map(branch => branch.properties.action.const), ['status', 'result', 'cancel']);
  assert.equal(validateToolInput('blender_job', { action: 'reconcile', jobId: f.jobId, observed: applied() }).valid, false);
  const tools = new Map(createBlenderTools({
    getViewport: () => ({ probe: async () => ({ available: false }), status: () => null }),
    coordinator: { record: () => ({}) }, resolveContext: async () => context, jobStore: f.store,
  }).map(tool => [tool.name, tool]));
  const caps = await tools.get('blender_capabilities').execute({ action: 'status' }, {});
  const limitations = caps.data.declaration.limitations.join(' ');
  assert.match(limitations, /no automatic over-budget dispatcher/);
  assert.match(limitations, /library-level createBlenderJobStore\(\)\.reconcile/);
  assert.match(limitations, /not exposed by the frozen blender_job tool schema/);
  await assert.rejects(tools.get('blender_job').execute({ action: 'reconcile', jobId: f.jobId, observed: applied() }, {}), { code: 'SCHEMA_INVALID' });
  f.store.reconcile(f.jobId, context, { observed: applied() });
  for (const action of ['status', 'result']) {
    const response = await tools.get('blender_job').execute({ action, jobId: f.jobId }, {});
    assert.deepEqual(validateToolOutput('blender_job', response), { valid: true, errors: [] });
    assert.equal(response.data.state, 'succeeded'); assert.equal(response.data.effectState, 'committed');
    assert.equal('reconciledAt' in response.data, false);
  }
});
