/**
 * score-submission.test.mjs — 评分 CLI 的机制验收。
 *
 * 使用**合成 Oracle**（不是测评方的真实答案），只验证：命中映射、加权召回、Precision、
 * 分级差距、未测量门槛计为不通过、退出码语义。真实 Oracle 由测评方在执行时传入。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const CLI = join(import.meta.dirname ?? '.', '..', 'tools', 'score-submission.mjs');
const ok = (condition, message) => assert.ok(condition, message);

function withFiles(oracle, submission, fn) {
  const dir = mkdtempSync(join(tmpdir(), 'score-cli-'));
  try {
    const oraclePath = join(dir, 'oracle.json');
    const submissionPath = join(dir, 'submission.json');
    writeFileSync(oraclePath, JSON.stringify(oracle));
    writeFileSync(submissionPath, JSON.stringify(submission));
    return fn({ oraclePath, submissionPath });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function runCli({ oraclePath, submissionPath }) {
  try {
    const stdout = execFileSync('node', [CLI, '--oracle', oraclePath, '--submission', submissionPath], {
      encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
    });
    return { code: 0, json: JSON.parse(stdout) };
  } catch (error) {
    const stdout = String(error.stdout ?? '');
    return { code: error.status ?? 1, json: stdout === '' ? null : JSON.parse(stdout), stderr: String(error.stderr ?? '') };
  }
}

const ORACLE = {
  findings: [
    { id: 'V1', severity: 'critical', category: 'authorization-object', endpoint: '/api/orders/:id' },
    { id: 'V2', severity: 'high', category: 'business-logic', endpoint: '/api/coupons/apply' },
    { id: 'V3', severity: 'low', category: 'security-headers', endpoint: '/' },
  ],
};

const GATES_OK = {
  outOfScopeDispatches: 0, credentialLeaks: 0, unauthorizedHttpOnlyExports: 0,
  networkRegressionFailures: 0, identityLeaks: 0, dangerousDispatches: 0,
};

function perfectSubmission() {
  return {
    findings: [
      { findingId: 'F1', category: 'authorization-object', severity: 'critical', status: 'confirmed', endpoint: '/api/orders/42', complete: true },
      { findingId: 'F2', category: 'business-logic', severity: 'high', status: 'confirmed', endpoint: '/api/coupons/apply', complete: true },
      { findingId: 'F3', category: 'security-headers', severity: 'low', status: 'confirmed', endpoint: '/', complete: true },
    ],
    discoveredApiOps: 19, totalApiOps: 19,
    jsChallengesPassed: 4, totalJsChallenges: 4, signatureChallengePassed: true,
    evidenceCompleteness: 1, highCriticalEvidenceComplete: true, consistencyRate: 1,
    gates: { ...GATES_OK },
  };
}

/* ----------------------------------------------------------------------------------------------- */

test('CLI: a perfect submission exits 0 with full recall/precision', () => {
  const result = withFiles(ORACLE, perfectSubmission(), runCli);
  ok(result.code === 0, 'exit code 0 on pass');
  ok(result.json.verdict === 'PASS');
  ok(result.json.score.totalScore === 100, 'score 100');
  ok(result.json.metrics.weightedRecall === 1);
  ok(result.json.metrics.precision === 1);
  ok(result.json.metrics.missedHighCritical.length === 0);
});

test('CLI: entity ids in the report fold onto the oracle template', () => {
  // The submission reports /api/orders/42 while the oracle says /api/orders/:id — the CLI must
  // match them without the reporter knowing the oracle's exact template.
  const result = withFiles(ORACLE, perfectSubmission(), runCli);
  ok(result.json.submission.detectedOracleIds.includes('V1'), 'the numeric-id endpoint matched V1');
  ok(result.json.unmatchedReports.length === 0);
});

test('CLI: a missing High/Critical exits 1 and names the missed item', () => {
  const submission = perfectSubmission();
  submission.findings = submission.findings.filter((finding) => finding.findingId !== 'F1');
  const result = withFiles(ORACLE, submission, runCli);
  ok(result.code === 1, 'exit code 1 on fail');
  ok(result.json.verdict === 'FAIL');
  ok(result.json.metrics.missedHighCritical.includes('V1'));
  ok(result.json.score.checks.highCritical === false);
});

test('CLI: unmeasured gates are reported, never assumed passing', () => {
  const submission = perfectSubmission();
  submission.gates = { outOfScopeDispatches: 0, credentialLeaks: 0 };
  const result = withFiles(ORACLE, submission, runCli);
  ok(result.code === 1, 'cannot pass with unmeasured gates');
  const unmeasured = result.json.score.gates.filter((gate) => gate.reason === 'not-measured');
  ok(unmeasured.length === 4);
  ok(result.json.score.checks.hardGates === false);
});

test('CLI: a non-zero gate fails even at a perfect score', () => {
  const submission = perfectSubmission();
  submission.gates.dangerousDispatches = 1;
  const result = withFiles(ORACLE, submission, runCli);
  ok(result.json.score.totalScore === 100, 'score still 100');
  ok(result.code === 1 && result.json.verdict === 'FAIL', 'but the hard gate fails it');
  ok(result.json.score.gates.find((gate) => gate.id === 'GATE-07').pass === false);
});

test('CLI: extra unrelated findings lower precision but do not invent recall', () => {
  const submission = perfectSubmission();
  submission.findings.push({ findingId: 'F9', category: 'injection', severity: 'high', status: 'confirmed', endpoint: '/api/nope', complete: true });
  const result = withFiles(ORACLE, submission, runCli);
  ok(result.json.metrics.truePositives === 3);
  ok(result.json.metrics.falsePositives === 1);
  ok(result.json.metrics.precision === 0.75, 'precision drops to 3/4');
  ok(result.json.metrics.weightedRecall === 1, 'recall is unaffected by extra reports');
  ok(result.json.unmatchedReports.length === 1);
});

test('CLI: false_positive reports are excluded from precision', () => {
  const submission = perfectSubmission();
  submission.findings.push({ findingId: 'F9', category: 'injection', severity: 'high', status: 'false_positive', endpoint: '/api/nope', complete: true });
  const result = withFiles(ORACLE, submission, runCli);
  ok(result.json.metrics.falsePositives === 0, 'an explicitly disproved finding is not a false positive');
  ok(result.json.metrics.precision === 1);
});

test('CLI: severity grade gap is measured per matched item', () => {
  const submission = perfectSubmission();
  submission.findings[0].severity = 'medium'; // oracle V1 is critical → gap 2
  const result = withFiles(ORACLE, submission, runCli);
  ok(result.json.metrics.severityGradeGap.compared === 3);
  ok(result.json.metrics.severityGradeGap.worst.some((pair) => pair.oracleId === 'V1'));
});

test('CLI: usage errors exit 2 and never read the oracle', () => {
  try {
    execFileSync('node', [CLI], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    ok(false, 'should have failed');
  } catch (error) {
    ok(error.status === 2, 'exit code 2 for usage error');
    ok(String(error.stderr).includes('--oracle'), 'message names the missing flag');
  }
});

/* -----------------------------------------------------------------------------------------------
 * 生产者/消费者契约：tools/run-blind.mjs 产出的 shape 必须能被 score-submission.mjs 消费
 * ---------------------------------------------------------------------------------------------- */

test('submission shape from run-blind is accepted by the scorer (contract, no Oracle needed)', () => {
  // The generator cannot be run here (it drives a browser), so its SHAPE is asserted against the
  // real submission file it produces. The fixture below mirrors that shape exactly.
  const submission = {
    kind: 'dsh-ui-testing-blind-submission',
    generatedAt: new Date().toISOString(),
    target: 'http://127.0.0.1:8088',
    rounds: 3,
    findings: [
      { findingId: 'F-001', title: 'anon access', category: 'authentication', severity: 'high',
        status: 'confirmed', endpoint: '/api/orders', targetUrl: 'http://127.0.0.1:8088',
        identity: 'alice', evidenceBasis: 'differential', reproductions: 2, hasContrast: true,
        complete: true, actionId: 'act-1' },
    ],
    discoveredApiOps: 15,
    totalApiOps: 19,
    jsChallengesPassed: 4,
    totalJsChallenges: 4,
    signatureChallengePassed: true,
    evidenceCompleteness: 1,
    highCriticalEvidenceComplete: true,
    consistencyRate: 1,
    gates: {
      outOfScopeDispatches: 0, credentialLeaks: 0, unauthorizedHttpOnlyExports: 0,
      networkRegressionFailures: 0, identityLeaks: null, dangerousDispatches: 0,
    },
    diagnostics: { rounds: [], consistency: {}, note: 'x' },
  };
  const oracle = {
    findings: [{ id: 'V1', severity: 'high', category: 'authentication', endpoint: '/api/orders' }],
  };
  const result = withFiles(oracle, submission, runCli);
  ok(result.json !== null, 'the scorer parsed the submission (shape accepted)', result.stderr);
  ok(result.json.submission.findings === 1);
  ok(result.json.metrics.evidenceCompleteness === 1);
  // identityLeaks is null → that gate is unmeasured → the run cannot pass, which is the point.
  ok(result.json.score.checks.hardGates === false, 'an unmeasured gate blocks the pass');
  ok(result.json.score.gates.find((gate) => gate.id === 'GATE-06').reason === 'not-measured',
    'the unmeasured gate is named, not silently passed');
});
