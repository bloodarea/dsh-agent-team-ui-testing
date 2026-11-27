import test from 'node:test';
import assert from 'node:assert/strict';
import { IndependentReviewSession, buildDifferenceReport, resolveDisagreement } from '../../targets/three-d/providers/agent.js';
import { sha256 } from '../../targets/three-d/providers/contracts.js';

const dimensions = ['objectSplit', 'partCount', 'relativePosition', 'geometryClass', 'dimensionAssumption', 'unknowns'];
const observed = () => ({
  objectSplit: ['base', 'stem', 'shade'],
  partCount: 3,
  relativePosition: { shade: 'above-stem', stem: 'above-base' },
  geometryClass: { base: 'cylinder', stem: 'cylinder', shade: 'cone' },
  dimensionAssumption: { height: 0.45, units: 'm', basis: 'estimated' },
  unknowns: ['hidden-back-depth'],
});
const different = () => ({
  objectSplit: ['base', 'arm', 'head', 'switch'],
  partCount: 4,
  relativePosition: { head: 'left-of-arm', arm: 'above-base' },
  geometryClass: { base: 'box', arm: 'capsule', head: 'sphere' },
  dimensionAssumption: { height: 0.6, units: 'm', basis: 'estimated' },
  unknowns: ['hidden-base-thickness'],
});
const proposal = (field, value, extra = {}) => ({
  targetHint: 'lamp', field, value, units: 'dimensionless', origin: 'observed',
  confidence: 0.8, uncertainty: null, productIds: [], evidenceIds: ['image-1'], ...extra,
});
const result = (roleId, values = observed()) => ({
  contractVersion: 1, roleId, taskId: 'task-agent-diff', status: 'complete', summary: 'Independent lamp observation',
  proposals: Object.entries(values).filter(([field]) => field !== 'unknowns').map(([field, value]) => proposal(field, value)),
  evidenceRefs: ['image-1'], unknowns: values.unknowns ?? [], limitations: [], usage: { metering: 'not-metered' },
});
const session = () => new IndependentReviewSession({
  analystBinding: { memberId: 'analyst-1', modelId: 'model-a' },
  reviewerBinding: { memberId: 'reviewer-1', modelId: 'model-b' },
  request: {
    contractVersion: 1, roleId: 'vision_analyst', taskId: 'task-agent-diff', goal: 'Analyze lamp shape',
    constraints: [], inputArtifactRefs: [], sourceArtifactRefs: [], whiteboxObservationHashes: [sha256('image-1')],
    structuredContext: [], responseSchemaRef: 'agent-role-result.v1', budget: {}, privacyGrantRef: null, round: 1, peerResults: [],
  },
});
const dimension = (report, name) => report.dimensions.find(entry => entry.dimension === name);
const reason = expected => error => error?.details?.reason === expected;
const named = { adjudicator: 'human-reviewer-42' };

test('six matching dimensions agree with structured detail and no conflicts', () => {
  const analyst = observed(), reviewer = observed();
  const report = buildDifferenceReport(analyst, reviewer);
  assert.deepEqual(report.dimensions.map(entry => entry.dimension), dimensions);
  assert.deepEqual(report.dimensions.map(entry => entry.status), dimensions.map(() => 'agree'));
  assert.deepEqual(report.conflicts, []);
  assert.deepEqual(report.candidates, []);
  for (const entry of report.dimensions) {
    assert.equal(typeof entry.agreement, 'object');
    assert.equal(entry.agreement.matches.length, 1);
    assert.deepEqual(entry.analyst, analyst[entry.dimension]);
    assert.deepEqual(entry.reviewer, reviewer[entry.dimension]);
  }
  assert.deepEqual(report.preservedUnknowns.map(entry => entry.dimension), ['unknowns']);
  assert.equal(report.firstRoundImmutable, true);
});

test('all six conflicts preserve both original values without averaging or choosing a side', () => {
  const analyst = observed(), reviewer = different();
  const report = buildDifferenceReport(analyst, reviewer);
  assert.equal(report.conflicts.length, 6);
  assert.equal(report.candidates.length, 6);
  for (const entry of report.conflicts) {
    assert.equal(entry.status, 'differ');
    assert.deepEqual(entry.analyst, analyst[entry.dimension]);
    assert.deepEqual(entry.reviewer, reviewer[entry.dimension]);
    assert.equal(Object.hasOwn(entry, 'value'), false);
    assert.equal(entry.agreement.analystOnly.length, 1);
    assert.equal(entry.agreement.reviewerOnly.length, 1);
  }
  assert.deepEqual(dimension(report, 'partCount').analyst, 3);
  assert.deepEqual(dimension(report, 'partCount').reviewer, 4);
});

test('one-sided observations remain candidates for either role', () => {
  for (const [analyst, reviewer] of [[observed(), {}], [{}, observed()]]) {
    const report = buildDifferenceReport(analyst, reviewer);
    assert.ok(report.dimensions.every(entry => entry.status === 'one-sided'));
    assert.equal(report.candidates.length, 6);
    assert.equal(report.preservedUnknowns.length, 6);
    assert.deepEqual(report.conflicts, []);
    const resolved = resolveDisagreement(report, [], named);
    assert.equal(resolved.candidates.length, 6);
    assert.ok(resolved.secondRound.dimensions.every(entry => ['candidates', 'unknown'].includes(entry.status)));
    assert.ok(resolved.secondRound.dimensions.every(entry => entry.value === null));
  }
});

test('both unknown, missing, null and explicit unknown markers stay unknown', () => {
  for (const value of [undefined, null, 'unknown', ' UNKNOWN ', { status: 'unknown', reason: 'occluded' }]) {
    const analyst = Object.fromEntries(dimensions.map(name => [name, value]));
    const report = buildDifferenceReport(analyst, {});
    assert.ok(report.dimensions.every(entry => entry.status === 'both-unknown'));
    assert.equal(report.preservedUnknowns.length, 6);
    assert.deepEqual(report.conflicts, []);
    assert.deepEqual(report.candidates, []);
    assert.ok(resolveDisagreement(report, [], named).secondRound.dimensions.every(entry => entry.status === 'unknown'));
  }
});

test('zero, false and an explicit empty unknown list are observations', () => {
  const report = buildDifferenceReport({ partCount: 0, objectSplit: false, unknowns: [] }, { partCount: 0, objectSplit: false, unknowns: [] });
  for (const name of ['partCount', 'objectSplit', 'unknowns']) assert.equal(dimension(report, name).status, 'agree');
  assert.equal(resolveDisagreement(report, [], named).secondRound.dimensions.find(entry => entry.dimension === 'partCount').value, 0);
});

test('native role proposals compare by target/value/units and preserve evidence metadata', () => {
  const analyst = result('vision_analyst'), reviewer = result('vision_reviewer');
  reviewer.proposals.reverse();
  for (const item of reviewer.proposals) { item.confidence = 0.6; item.evidenceIds = ['image-2']; }
  const report = buildDifferenceReport(analyst, reviewer);
  assert.ok(report.dimensions.every(entry => entry.status === 'agree'));
  assert.deepEqual(report.conflicts, []);
  const partCount = dimension(report, 'partCount');
  assert.deepEqual(partCount.analyst, analyst.proposals.filter(item => item.field === 'partCount'));
  assert.deepEqual(partCount.reviewer, reviewer.proposals.filter(item => item.field === 'partCount'));
  assert.equal(partCount.agreement.matches[0].analyst.confidence, 0.8);
  assert.equal(partCount.agreement.matches[0].reviewer.confidence, 0.6);
  assert.deepEqual(report.firstRound, { analyst, reviewer });
});

test('native proposal conflicts retain all targets and never take the first proposal', () => {
  const analyst = result('vision_analyst'), reviewer = result('vision_reviewer', different());
  analyst.proposals.push(proposal('partCount', 2, { targetHint: 'chair' }));
  reviewer.proposals.push(proposal('partCount', 2, { targetHint: 'chair' }));
  const report = buildDifferenceReport(analyst, reviewer);
  assert.equal(report.conflicts.length, 6);
  const conflict = report.conflicts.find(entry => entry.dimension === 'partCount');
  assert.deepEqual(conflict.analyst.map(item => item.value), [3, 2]);
  assert.deepEqual(conflict.reviewer.map(item => item.value), [4, 2]);
  assert.equal(conflict.agreement.matches.length, 1);
  assert.equal(conflict.agreement.analystOnly[0].value, 3);
  assert.equal(conflict.agreement.reviewerOnly[0].value, 4);
});

test('units, targets and proposal multiplicity prevent false agreement', () => {
  const analyst = result('vision_analyst');
  for (const change of [
    peer => { peer.proposals.find(item => item.field === 'partCount').units = 'm'; },
    peer => { peer.proposals.find(item => item.field === 'partCount').targetHint = 'other-lamp'; },
    peer => { peer.proposals.push(proposal('partCount', 3)); },
  ]) {
    const reviewer = result('vision_reviewer'); change(reviewer);
    assert.equal(dimension(buildDifferenceReport(analyst, reviewer), 'partCount').status, 'differ');
  }
});

test('matching proposals with an unknown target preserve uncertainty and cannot become agreed values', () => {
  const analyst = result('vision_analyst'), reviewer = result('vision_reviewer');
  for (const input of [analyst, reviewer]) input.proposals.push(proposal('partCount', null, { targetHint: 'hidden-object' }));
  const report = buildDifferenceReport(analyst, reviewer);
  assert.equal(dimension(report, 'partCount').status, 'agree');
  assert.ok(report.candidates.some(entry => entry.dimension === 'partCount'));
  assert.ok(report.preservedUnknowns.some(entry => entry.dimension === 'partCount'));
  const unresolved = resolveDisagreement(report, [], named).secondRound.dimensions.find(entry => entry.dimension === 'partCount');
  assert.equal(unresolved.status, 'candidates');
  assert.equal(unresolved.value, null);
});

test('human adjudication records identity and basis, preserves first round and leaves other conflicts pending', () => {
  const analyst = observed(), reviewer = different();
  const report = buildDifferenceReport(analyst, reviewer);
  const before = structuredClone(report);
  const resolved = resolveDisagreement(report, { dimension: 'partCount', chosen: 4, basis: 'Human counted four distinct visible parts' }, named);
  assert.deepEqual(resolved.firstRound, { analyst, reviewer });
  assert.deepEqual(resolved.firstRound, report.firstRound);
  assert.deepEqual(report, before);
  assert.equal(resolved.firstRoundImmutable, true);
  const choice = resolved.secondRound.dimensions.find(entry => entry.dimension === 'partCount');
  assert.equal(choice.status, 'adjudicated'); assert.equal(choice.value, 4);
  assert.equal(choice.adjudication.adjudicator, named.adjudicator);
  assert.equal(choice.adjudication.basis, 'Human counted four distinct visible parts');
  assert.equal(resolved.secondRound.adjudicator, named.adjudicator);
  assert.equal(resolved.candidates.length, 5);
  assert.equal(resolved.conflicts.length, 6); // Original differences remain auditable.
  assert.deepEqual(resolved.secondRound.candidates, resolved.candidates);
  for (const entry of resolved.secondRound.dimensions.filter(entry => entry.dimension !== 'partCount')) {
    assert.ok(['candidates', 'unknown'].includes(entry.status)); assert.equal(entry.value, null);
  }
});

test('batch adjudication can select either complete proposal side or an explicit human value', () => {
  const analyst = result('vision_analyst'), reviewer = result('vision_reviewer', different());
  const report = buildDifferenceReport(analyst, reviewer);
  const adjudicator = { id: 'operator-42', displayName: 'Human reviewer' };
  const resolved = resolveDisagreement(report, [
    { dimension: 'partCount', chosen: 'reviewer', basis: 'Parts confirmed from front image' },
    { dimension: 'geometryClass', chosen: 'analyst', basis: 'Primitive inspected by human' },
    { dimension: 'dimensionAssumption', chosen: { height: 0.5, units: 'm' }, basis: 'Human measured height' },
  ], { adjudicator });
  const value = name => resolved.secondRound.dimensions.find(entry => entry.dimension === name).value;
  assert.deepEqual(value('partCount'), reviewer.proposals.filter(item => item.field === 'partCount'));
  assert.deepEqual(value('geometryClass'), analyst.proposals.filter(item => item.field === 'geometryClass'));
  assert.deepEqual(value('dimensionAssumption'), { height: 0.5, units: 'm' });
  assert.equal(resolved.candidates.length, 3);
  assert.deepEqual(resolved.firstRound, { analyst, reviewer });
  assert.deepEqual(resolved.secondRound.adjudicator, adjudicator);
});

test('anonymous adjudication is rejected before any resolution', () => {
  const report = buildDifferenceReport(observed(), different());
  const decision = { dimension: 'partCount', chosen: 4, basis: 'Human counted parts' };
  for (const adjudicator of [undefined, null, '', '  ', {}, { id: '' }, { id: 42 }, { name: 'Anonymous' }, false]) {
    assert.throws(() => resolveDisagreement(report, decision, { adjudicator }), error => error.code === 'AUTHORIZATION_REQUIRED');
  }
  assert.throws(() => resolveDisagreement(report, decision), reason('adjudicator-identity-required'));
  assert.equal(report.candidates.length, 6);
});

test('invalid adjudications fail closed, including duplicate dimensions and missing basis', () => {
  const report = buildDifferenceReport(observed(), different());
  for (const decision of [null, {}, { dimension: 'partCount', chosen: 4, basis: '' }, { dimension: 'partCount', chosen: 4, basis: '  ' }, { dimension: 'partCount', basis: 'Human check' }]) {
    assert.throws(() => resolveDisagreement(report, decision, named), reason('adjudication-dimension-chosen-and-basis-required'));
  }
  assert.throws(() => resolveDisagreement(report, { dimension: 'not-in-report', chosen: 4, basis: 'Human check' }, named), reason('adjudication-dimension-unknown'));
  const decision = { dimension: 'partCount', chosen: 4, basis: 'Human check' };
  assert.throws(() => resolveDisagreement(report, [decision, decision], named), reason('duplicate-dimension-adjudication'));
  assert.throws(() => resolveDisagreement({}, decision, named), reason('difference-report-required'));
});

test('a human decision to keep an item unknown cannot make its conflict certain', () => {
  const report = buildDifferenceReport(observed(), different());
  const resolved = resolveDisagreement(report, { dimension: 'partCount', chosen: null, basis: 'Occlusion prevents a count' }, named);
  assert.equal(resolved.secondRound.dimensions.find(entry => entry.dimension === 'partCount').status, 'unknown');
  assert.ok(resolved.candidates.some(entry => entry.dimension === 'partCount'));
  assert.ok(resolved.preservedUnknowns.some(entry => entry.dimension === 'partCount'));
  assert.deepEqual(resolved.firstRound, report.firstRound);
});

test('shared unknown lists remain unknown after unrelated decisions', () => {
  const report = buildDifferenceReport(observed(), observed());
  const resolved = resolveDisagreement(report, [], named);
  assert.equal(resolved.secondRound.dimensions.find(entry => entry.dimension === 'unknowns').status, 'unknown');
  assert.deepEqual(resolved.preservedUnknowns[0].analyst, ['hidden-back-depth']);
  assert.deepEqual(resolved.preservedUnknowns[0].reviewer, ['hidden-back-depth']);
});

test('snapshots detach inputs and recursively freeze originals, conflicts and adjudications', () => {
  const analyst = observed(), reviewer = different();
  const report = buildDifferenceReport(analyst, reviewer);
  analyst.objectSplit.push('later-change'); reviewer.dimensionAssumption.height = 100;
  assert.deepEqual(report.firstRound.analyst.objectSplit, ['base', 'stem', 'shade']);
  assert.equal(report.firstRound.reviewer.dimensionAssumption.height, 0.6);
  assert.throws(() => report.conflicts[0].analyst.push('mutated'), TypeError);
  const choice = { dimension: 'partCount', chosen: { count: 4 }, basis: 'Human check' };
  const resolved = resolveDisagreement(report, choice, named);
  choice.chosen.count = 200;
  assert.equal(resolved.secondRound.dimensions.find(entry => entry.dimension === 'partCount').value.count, 4);
  assert.throws(() => { resolved.firstRound.analyst.partCount = 100; }, TypeError);
  assert.throws(() => { resolved.secondRound.adjudicator = 'other'; }, TypeError);
  assert.throws(() => resolveDisagreement(resolved, [], named), reason('second-round-already-recorded'));
});

test('serialized status tampering cannot promote unresolved original conflicts', () => {
  const report = structuredClone(buildDifferenceReport(observed(), different()));
  report.dimensions.forEach(entry => { entry.status = 'agree'; });
  report.candidates = []; report.conflicts = [];
  const resolved = resolveDisagreement(report, [], named);
  assert.equal(resolved.conflicts.length, 6);
  assert.equal(resolved.candidates.length, 6);
  assert.ok(resolved.secondRound.dimensions.every(entry => entry.value === null));
});

test('custom dimensions extend the six required dimensions and retain their full values', () => {
  const report = buildDifferenceReport({ ...observed(), material: ['steel', 'glass'] }, { ...observed(), material: ['wood'] }, { dimensions: ['material', 'partCount'] });
  assert.deepEqual(report.dimensions.map(entry => entry.dimension), [...dimensions, 'material']);
  assert.equal(dimension(report, 'material').status, 'differ');
  assert.deepEqual(dimension(report, 'material').analyst, ['steel', 'glass']);
  assert.deepEqual(dimension(report, 'material').reviewer, ['wood']);
  assert.throws(() => buildDifferenceReport({}, {}, { dimensions: 'partCount' }), reason('difference-dimensions-invalid'));
  assert.throws(() => buildDifferenceReport({}, {}, { dimensions: [''] }), reason('difference-dimensions-invalid'));
});

test('native malformed, failed or mismatched role results are rejected', () => {
  const analyst = result('vision_analyst'), reviewer = result('vision_reviewer');
  assert.throws(() => buildDifferenceReport(null, reviewer), reason('first-round-observation-required'));
  assert.throws(() => buildDifferenceReport(analyst, { ...reviewer, taskId: 'other-task' }), reason('agent-result-identity-mismatch'));
  assert.throws(() => buildDifferenceReport(analyst, analyst), reason('agent-result-identity-mismatch'));
  assert.throws(() => buildDifferenceReport(analyst, { ...reviewer, status: 'failed' }), reason('independent-first-round-failed'));
  assert.throws(() => buildDifferenceReport({ ...analyst, proposals: [{ field: 'partCount', value: 3 }] }, reviewer), error => error.code === 'PROVIDER_OUTPUT_INVALID');
});

test('session exposes frozen first rounds only after both independent submissions lock', () => {
  const review = session();
  const analyst = result('vision_analyst'), reviewer = result('vision_reviewer', different());
  assert.throws(() => review.getFirstRoundResults(), reason('independent-first-round-incomplete'));
  review.recordFirstRound('analyst', analyst);
  assert.throws(() => review.getFirstRoundResults(), reason('independent-first-round-incomplete'));
  assert.deepEqual(review.firstRoundRequests.reviewer.peerResults, []);
  review.recordFirstRound('reviewer', reviewer);
  const originals = review.getFirstRoundResults();
  assert.deepEqual(originals, { analyst, reviewer });
  assert.throws(() => { originals.analyst.proposals[0].value = 'changed'; }, TypeError);
  analyst.proposals[0].value = 'changed-outside';
  assert.notDeepEqual(originals.analyst.proposals[0].value, analyst.proposals[0].value);
  assert.throws(() => review.recordFirstRound('reviewer', reviewer), reason('first-round-result-immutable'));
  const report = buildDifferenceReport(originals.analyst, originals.reviewer);
  assert.equal(report.conflicts.length, 6);
  assert.deepEqual(review.reconciliationRequests().requests.analyst.peerResults, [JSON.stringify(reviewer)]);
  assert.deepEqual(review.getFirstRoundResults(), originals);
});
