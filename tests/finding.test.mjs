/**
 * finding.test.mjs — FR-09/FR-10 Finding 模型与证据闭环（EVD-01..07、VULN-08/09/10/11）。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  EVIDENCE_BASES, FINDING_CATEGORIES, FINDING_REQUIRED_FIELDS, SEVERITIES, SEVERITY_WEIGHT,
  createFindingSkeleton, deriveStatus, evidenceCompleteness, fieldPresent, gradeFinding,
  precision, scanFindingsForSecrets, severityWeight, summarizeFindings, weightedRecall,
} from '../finding.js';

const ok = (condition, message) => assert.ok(condition, message);

function completeFinding(overrides = {}) {
  return {
    ...createFindingSkeleton({
      findingId: 'F-1', title: 'Object-level authorization bypass', category: 'authorization-object',
      severity: 'high', confidence: 0.95, targetUrl: 'http://a:1', endpoint: '/api/orders/42',
      identity: 'alice', preconditions: ['alice logged in'], reproductionSteps: ['1. login', '2. GET /api/orders/42'],
      evidence: { basis: 'reproduced' }, request: { method: 'GET', url: '/api/orders/42', status: 200 },
      response: { status: 200, snippet: '{"order":42}' }, impact: 'read another user order',
      remediation: 'enforce ownership check', actionId: 'act-1', evidenceBasis: 'reproduced',
      reproductions: 2, hasContrast: true, scriptLocation: { url: 'app.js', line: 10 },
    }),
    status: 'confirmed',
    ...overrides,
  };
}

/* ----------------------------------------------------------------------------------------------- */

test('EVD-01 skeleton has every required field and honest nulls', () => {
  const finding = createFindingSkeleton({ title: 'x', category: 'cors', severity: 'low' });
  ok(finding.kind === 'dsh-ui-testing-finding' && finding.version === 1);
  ok(finding.findingId === null && finding.status === null, 'no invented id or status');
  ok(finding.severity === 'low' && finding.severityWeight === 1);
  ok(finding.reproductions === 0 && finding.hasContrast === false);
  ok(FINDING_CATEGORIES.includes(finding.category));
  const unknown = createFindingSkeleton({ category: 'not-a-category', severity: 'nope' });
  ok(unknown.category === 'other' && unknown.severity === 'medium', 'unknown values fall back explicitly');
});

test('FR-09 deriveStatus: confirmed requires 2 reproductions AND contrast', () => {
  ok(deriveStatus({ basis: 'reproduced', reproductions: 2, hasContrast: true }).status === 'confirmed');
  const oneRepro = deriveStatus({ basis: 'reproduced', reproductions: 1, hasContrast: true });
  ok(oneRepro.status === 'likely' && oneRepro.downgraded === true, 'one reproduction = likely');
  const noContrast = deriveStatus({ basis: 'reproduced', reproductions: 5, hasContrast: false });
  ok(noContrast.status === 'likely' && noContrast.downgraded === true, 'no contrast = likely');
});

test('FR-09 static patterns and single observations can never be confirmed', () => {
  ok(deriveStatus({ basis: 'static-pattern' }).status === 'potential', 'static string = potential');
  ok(deriveStatus({ basis: 'static-pattern', reproductions: 9, hasContrast: true }).status === 'potential',
    'static evidence stays potential even with many reproductions');
  ok(deriveStatus({ basis: 'observed-once' }).status === 'likely', 'single response = likely');
  ok(deriveStatus({ basis: 'differential' }).status === 'likely');
  ok(deriveStatus({ basis: 'disproved', reproductions: 3 }).status === 'false_positive');
  ok(deriveStatus({ basis: 'unknown-basis' }).status === 'potential', 'unknown basis is the most conservative');
});

test('VULN-11 severity weights follow the contract (5/4/2/1)', () => {
  ok(SEVERITIES.join(',') === 'critical,high,medium,low');
  ok(SEVERITY_WEIGHT.critical === 5 && SEVERITY_WEIGHT.high === 4 && SEVERITY_WEIGHT.medium === 2 && SEVERITY_WEIGHT.low === 1);
  ok(severityWeight('HIGH') === 4 && severityWeight('nope') === 0);
});

test('EVD-01 fieldPresent treats empty values as missing', () => {
  ok(fieldPresent('x') && !fieldPresent('') && !fieldPresent('   '));
  ok(fieldPresent([1]) && !fieldPresent([]));
  ok(fieldPresent({ a: 1 }) && !fieldPresent({}));
  ok(!fieldPresent(null) && !fieldPresent(undefined));
});

test('EVD-01/EVD-03/EVD-04 gradeFinding enforces schema + evidence linkage', () => {
  const good = gradeFinding(completeFinding());
  ok(good.complete === true && good.missingFields.length === 0, 'complete finding passes');
  const noRequest = gradeFinding(completeFinding({ request: null, response: null }));
  ok(noRequest.complete === false && noRequest.violations.includes('no-request-or-response-evidence'));
  const missingTitle = gradeFinding(completeFinding({ title: null }));
  ok(missingTitle.missingFields.includes('title'));
  const domFinding = gradeFinding(completeFinding({ category: 'xss-dom', dom: null, screenshot: null, scriptLocation: null }));
  ok(domFinding.violations.includes('missing-ui-or-source-linkage'), 'DOM category needs UI/source linkage');
});

test('EVD-02 evidenceCompleteness reports overall and High/Critical rates with a hard bar', () => {
  const findings = [
    completeFinding({ findingId: 'F-1', severity: 'high' }),
    completeFinding({ findingId: 'F-2', severity: 'critical' }),
    completeFinding({ findingId: 'F-3', severity: 'low', title: null }),
  ];
  const result = evidenceCompleteness(findings);
  ok(result.total === 3 && result.complete === 2);
  ok(result.highCriticalTotal === 2 && result.highCriticalComplete === 2, 'both High/Critical complete');
  ok(result.highBarMet === true);
  ok(result.incomplete.length === 1 && result.incomplete[0].findingId === 'F-3');
  const broken = evidenceCompleteness([completeFinding({ severity: 'critical', request: null, response: null })]);
  ok(broken.highBarMet === false, 'a High/Critical gap fails the hard bar');
  ok(evidenceCompleteness([]).rate === null, 'no findings = null rate, not 1');
});

test('EVD-07/VULN-08 weightedRecall computes severity-weighted recall', () => {
  const oracle = [
    { id: 'v1', severity: 'critical' }, { id: 'v2', severity: 'high' },
    { id: 'v3', severity: 'medium' }, { id: 'v4', severity: 'low' },
  ];
  const result = weightedRecall(oracle, ['v1', 'v2', 'v3']);
  ok(result.totalWeight === 12 && result.hitWeight === 11);
  ok(Math.abs(result.recall - 11 / 12) < 1e-9);
  ok(result.missedIds.join(',') === 'v4');
  const missingHigh = weightedRecall(oracle, ['v3', 'v4']);
  ok(missingHigh.highCriticalAllFound === false, 'missing High/Critical is flagged');
  ok(missingHigh.missedHighCriticalIds.join(',') === 'v1,v2');
});

test('VULN-09 precision excludes findings explicitly marked false_positive', () => {
  const reported = [
    { findingId: 'F-1', matchedOracleId: 'v1', status: 'confirmed' },
    { findingId: 'F-2', matchedOracleId: 'v9', status: 'confirmed' },
    { findingId: 'F-3', matchedOracleId: 'v3', status: 'false_positive' },
  ];
  const result = precision(reported, ['v1', 'v2', 'v3']);
  ok(result.reported === 2 && result.truePositives === 1 && result.falsePositives === 1);
  ok(result.precision === 0.5);
  ok(precision([], ['v1']).precision === null, 'no report = null precision');
});

test('EVD-06 scanFindingsForSecrets finds canary leaks without echoing them', () => {
  const finding = completeFinding({ notes: ['cookie lab_session=v3ry-s3cret-cookie-value'] });
  const scan = scanFindingsForSecrets([finding], ['v3ry-s3cret-cookie-value']);
  ok(scan.clean === false && scan.hits.length === 1);
  ok(scan.hits[0].path.includes('notes'), 'hit location reported');
  ok(JSON.stringify(scan).includes('v3ry-s3cret') === false, 'the secret itself is never echoed');
  ok(scanFindingsForSecrets([finding], ['unrelated-value-x']).clean === true, 'unrelated value = clean');
});

test('FR-10 summarizeFindings aggregates by severity/status and flags unverified confirmations', () => {
  const findings = [
    completeFinding({ findingId: 'F-1', severity: 'critical', status: 'confirmed', hasContrast: true }),
    completeFinding({ findingId: 'F-2', severity: 'low', status: 'likely' }),
    completeFinding({ findingId: 'F-3', severity: 'medium', status: 'false_positive' }),
    completeFinding({ findingId: 'F-4', severity: 'high', status: 'confirmed', hasContrast: false }),
  ];
  const summary = summarizeFindings(findings);
  ok(summary.total === 4);
  ok(summary.bySeverity.critical === 1 && summary.bySeverity.high === 1 && summary.bySeverity.low === 1);
  ok(summary.byStatus.confirmed === 2 && summary.byStatus.false_positive === 1);
  ok(summary.severityWeightSum === 5 + 1 + 2 + 4);
  ok(summary.confirmedWithoutContrast.join(',') === 'F-4', 'a confirmed finding without contrast is flagged');
  ok(summary.highCriticalPresent === true);
});

test('EVD-01 required-field list matches the acceptance contract', () => {
  for (const field of ['findingId', 'title', 'category', 'severity', 'confidence', 'status',
    'targetUrl', 'endpoint', 'identity', 'preconditions', 'reproductionSteps',
    'evidence', 'impact', 'remediation', 'actionId', 'createdAt']) {
    ok(FINDING_REQUIRED_FIELDS.includes(field), 'required field present: ' + field);
  }
  ok(Object.keys(EVIDENCE_BASES).length === 5);
});
