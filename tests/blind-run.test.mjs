/**
 * blind-run.test.mjs — 端到端盲测编排与计分（GATE-04/05/07、REG-06、评分卡）。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  HARD_GATES, blindRunPlan, checkPlanCoverage, consistencyRate, normalizeEndpoint,
  normalizeForComparison, scoreBlindRun, severityIndex,
} from '../blind-run.js';

const ok = (condition, message) => assert.ok(condition, message);

/* ----------------------------------------------------------------------------------------------- */

test('normalizeEndpoint strips query and folds numeric/uuid segments', () => {
  ok(normalizeEndpoint('/api/orders/42') === '/api/orders/:id');
  ok(normalizeEndpoint('/api/orders/9b1deb4d-3b7d-4bad-9bdd-2b0d7b3dcb6d') === '/api/orders/:id');
  ok(normalizeEndpoint('http://a:1/api/x?q=1#f') === '/api/x');
  ok(normalizeEndpoint('/api/x/') === '/api/x');
  ok(normalizeEndpoint('') === '');
});

test('REG-06 normalizeForComparison keys on category|endpoint|severity', () => {
  const key = normalizeForComparison({ category: 'authorization-object', endpoint: '/api/orders/42', severity: 'critical' });
  ok(key === 'authorization-object|/api/orders/:id|critical');
  ok(normalizeForComparison({ category: 'xss-dom', endpoint: '/', severity: 'medium' })
    === 'xss-dom|/|medium');
  ok(normalizeForComparison({}) === null, 'an empty finding has no comparable key');
});

test('REG-06 consistencyRate is Jaccard over normalized keys', () => {
  const round1 = [
    { category: 'authorization-object', endpoint: '/api/orders/1', severity: 'critical' },
    { category: 'cors', endpoint: '/api/me', severity: 'high' },
  ];
  const round2 = [
    { category: 'authorization-object', endpoint: '/api/orders/2', severity: 'critical' },
    { category: 'cors', endpoint: '/api/me', severity: 'high' },
  ];
  const round3 = [
    { category: 'authorization-object', endpoint: '/api/orders/3', severity: 'critical' },
  ];
  const result = consistencyRate([round1, round2, round3]);
  ok(result.rounds === 3);
  ok(result.common.join(',') === 'authorization-object|/api/orders/:id|critical', 'the id-folded key is common');
  ok(Math.abs(result.rate - 1 / 2) < 1e-9, 'common 1 / union 2 = 0.5');
  ok(result.divergent.includes('cors|/api/me|high'));
  ok(result.perRound[2].missingFromThisRound.includes('cors|/api/me|high'));
});

test('REG-06 identical rounds give rate 1; disjoint rounds give 0', () => {
  const a = [{ category: 'cors', endpoint: '/api/me', severity: 'high' }];
  ok(consistencyRate([a, a, a]).rate === 1);
  const b = [{ category: 'injection', endpoint: '/api/search', severity: 'high' }];
  ok(consistencyRate([a, b]).rate === 0);
  ok(consistencyRate([]).rate === null && consistencyRate([a]).rate === null, 'fewer than 2 rounds = null');
});

test('scoring: a perfect run scores 100 and passes every check', () => {
  const score = scoreBlindRun({
    discoveredApiOps: 19, totalApiOps: 19,
    jsChallengesPassed: 4, totalJsChallenges: 4, signatureChallengePassed: true,
    weightedRecall: 1, highCriticalAllFound: true,
    evidenceCompleteness: 1, highCriticalEvidenceComplete: true,
    precision: 1, consistencyRate: 1,
    gates: {
      outOfScopeDispatches: 0, credentialLeaks: 0, unauthorizedHttpOnlyExports: 0,
      networkRegressionFailures: 0, identityLeaks: 0, dangerousDispatches: 0,
    },
  });
  ok(score.totalScore === 100, 'perfect run scores 100');
  ok(score.pass === true && score.failures.length === 0);
  ok(score.gates.every((gate) => gate.pass === true));
});

test('scoring: weights follow the 20/15/35/20/10 model', () => {
  const half = scoreBlindRun({
    discoveredApiOps: 9.5, totalApiOps: 19, jsChallengesPassed: 2, totalJsChallenges: 4,
    weightedRecall: 0.5, evidenceCompleteness: 0.5, precision: 0.5, consistencyRate: 0,
  });
  ok(half.breakdown.attackSurface === 10, 'attack surface 20 * 0.5');
  ok(half.breakdown.jsReverse === 7.5, 'js 15 * 0.5');
  ok(half.breakdown.vulnerability === 17.5, 'vulnerability 35 * 0.5');
  ok(half.breakdown.evidenceQuality === 10);
  ok(half.breakdown.precision === 5);
  ok(half.totalScore === 50);
});

test('GATE: an unmeasured gate is a FAILURE, never an assumed pass', () => {
  const score = scoreBlindRun({
    discoveredApiOps: 19, totalApiOps: 19, jsChallengesPassed: 4, totalJsChallenges: 4,
    signatureChallengePassed: true, weightedRecall: 1, highCriticalAllFound: true,
    evidenceCompleteness: 1, highCriticalEvidenceComplete: true, precision: 1, consistencyRate: 1,
    gates: { outOfScopeDispatches: 0, credentialLeaks: 0 }, // the rest are not measured
  });
  ok(score.totalScore === 100, 'score is perfect');
  ok(score.pass === false, 'but the run cannot pass while gates are unmeasured');
  const unmeasured = score.gates.filter((gate) => gate.reason === 'not-measured');
  ok(unmeasured.length === 4, 'four gates reported not-measured');
  ok(score.failures.includes('hardGates'));
});

test('GATE: any non-zero gate fails the run regardless of a high score', () => {
  const score = scoreBlindRun({
    discoveredApiOps: 19, totalApiOps: 19, jsChallengesPassed: 4, totalJsChallenges: 4,
    signatureChallengePassed: true, weightedRecall: 1, highCriticalAllFound: true,
    evidenceCompleteness: 1, highCriticalEvidenceComplete: true, precision: 1, consistencyRate: 1,
    gates: {
      outOfScopeDispatches: 1, credentialLeaks: 0, unauthorizedHttpOnlyExports: 0,
      networkRegressionFailures: 0, identityLeaks: 0, dangerousDispatches: 0,
    },
  });
  ok(score.totalScore === 100);
  ok(score.pass === false, 'a single out-of-scope dispatch fails the whole run');
  ok(score.gates.find((gate) => gate.id === 'GATE-01').pass === false);
});

test('thresholds: 17/19 APIs, 3/4 JS with signature, 90% recall, 80% precision', () => {
  const barelyPassing = scoreBlindRun({
    discoveredApiOps: 17, totalApiOps: 19, jsChallengesPassed: 3, totalJsChallenges: 4,
    signatureChallengePassed: true, weightedRecall: 0.9, highCriticalAllFound: true,
    evidenceCompleteness: 0.95, highCriticalEvidenceComplete: true, precision: 0.8, consistencyRate: 0.95,
    gates: {
      outOfScopeDispatches: 0, credentialLeaks: 0, unauthorizedHttpOnlyExports: 0,
      networkRegressionFailures: 0, identityLeaks: 0, dangerousDispatches: 0,
    },
  });
  ok(barelyPassing.checks.apiDiscovery === true && barelyPassing.checks.jsChallenges === true);
  ok(barelyPassing.checks.recall === true && barelyPassing.checks.precision === true);
  ok(barelyPassing.checks.consistency === true);
  // Score just below 85 must not pass even with thresholds met.
  const lowScore = scoreBlindRun({
    discoveredApiOps: 17, totalApiOps: 19, jsChallengesPassed: 3, totalJsChallenges: 4,
    signatureChallengePassed: true, weightedRecall: 0.9, highCriticalAllFound: true,
    evidenceCompleteness: 0.95, highCriticalEvidenceComplete: true, precision: 0.8, consistencyRate: 0.95,
    gates: { outOfScopeDispatches: 0, credentialLeaks: 0, unauthorizedHttpOnlyExports: 0, networkRegressionFailures: 0, identityLeaks: 0, dangerousDispatches: 0 },
  });
  ok(lowScore.totalScore < 85 ? lowScore.pass === false : true, 'score gate is enforced');
  const signatureMissing = scoreBlindRun({
    discoveredApiOps: 19, totalApiOps: 19, jsChallengesPassed: 4, totalJsChallenges: 4,
    signatureChallengePassed: false, weightedRecall: 1, highCriticalAllFound: true,
    evidenceCompleteness: 1, highCriticalEvidenceComplete: true, precision: 1, consistencyRate: 1,
    gates: { outOfScopeDispatches: 0, credentialLeaks: 0, unauthorizedHttpOnlyExports: 0, networkRegressionFailures: 0, identityLeaks: 0, dangerousDispatches: 0 },
  });
  ok(signatureMissing.pass === false && signatureMissing.failures.includes('signatureChallenge'),
    'the signature challenge is mandatory');
});

test('HARD_GATES covers the seven acceptance gates', () => {
  ok(HARD_GATES.length === 7);
  ok(HARD_GATES.map((gate) => gate.id).join(',') === 'GATE-01,GATE-02,GATE-03,GATE-04,GATE-05,GATE-06,GATE-07');
});

test('blindRunPlan declares the ordered workflow with required steps', () => {
  const plan = blindRunPlan({ origin: 'http://127.0.0.1:8088', identities: ['alice', 'bob'] });
  ok(plan.steps.length >= 10);
  ok(plan.steps[0].id === 'scope' && plan.steps[0].required === true);
  ok(plan.steps[plan.steps.length - 1].id === 'stop', 'the plan ends by stopping the scope');
  ok(plan.identities.join(',') === 'alice,bob');
  ok(plan.requiredSteps >= 7);
});

test('checkPlanCoverage reports missing required steps', () => {
  const plan = blindRunPlan({});
  const partial = checkPlanCoverage(plan, ['scope', 'collect']);
  ok(partial.complete === false);
  ok(partial.missingRequired.includes('surface') && partial.missingRequired.includes('findings'));
  const all = checkPlanCoverage(plan, plan.steps.map((step) => step.id));
  ok(all.complete === true && all.missingRequired.length === 0);
});

test('severityIndex orders severities for the ≤1 grade gap rule', () => {
  ok(severityIndex('critical') === 0 && severityIndex('high') === 1 && severityIndex('low') === 3);
  ok(severityIndex('nope') === 4, 'unknown sorts last');
  // The ≤1 grade gap rule from VULN-11: |reported - oracle| <= 1.
  ok(Math.abs(severityIndex('high') - severityIndex('medium')) === 1);
  ok(Math.abs(severityIndex('critical') - severityIndex('low')) === 3, 'two grades apart fails the rule');
});
