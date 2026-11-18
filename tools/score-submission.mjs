#!/usr/bin/env node
/**
 * score-submission.mjs — 用测评方持有的 Oracle 对一次盲测产物计分。
 *
 * **本工具不内置任何答案。** Oracle（预置漏洞清单）由测评方以文件路径传入；
 * 被测 Agent 不应看到该文件（盲测前提）。工具的职责只有：
 *   1. 读入 submission（盲测产物：findings + 攻击面/JS/证据统计）；
 *   2. 按需求说明书 §5.1 的 100 分模型与七个硬门槛计分；
 *   3. 输出结构化结论（stdout JSON），不写任何文件、不改动 submission。
 *
 * 用法：
 *   node tools/score-submission.mjs --oracle oracle.json --submission submission.json
 *   node tools/score-submission.mjs --oracle oracle.json --submission submission.json --pretty
 *
 * Oracle 形状（测评方自定，最小要求）：
 *   { "findings": [ { "id": "V1", "severity": "critical", "category": "...", "endpoint": "..." } ] }
 * Submission 形状：
 *   { "findings": [ { findingId, category, severity, status, endpoint, matchedOracleId? } ],
 *     "discoveredApiOps": 19, "totalApiOps": 19,
 *     "jsChallengesPassed": 4, "totalJsChallenges": 4, "signatureChallengePassed": true,
 *     "consistencyRate": 1.0,
 *     "gates": { "outOfScopeDispatches": 0, ... } }
 *
 * 退出码：0 = 基准通过；1 = 基准不通过；2 = 输入/用法错误。
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

// Contract metrics live with the Finding model; the scoring card and severity ordering live with
// the blind-run orchestrator. Keeping the split means the CLI cannot drift from either.
import { precision, weightedRecall } from '../finding.js';
import { scoreBlindRun, severityIndex } from '../blind-run.js';

function parseArgs(argv) {
  const out = { pretty: false };
  for (let index = 2; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === '--pretty') { out.pretty = true; continue; }
    if (token === '--oracle') { out.oracle = argv[index + 1]; index += 1; continue; }
    if (token === '--submission') { out.submission = argv[index + 1]; index += 1; continue; }
    if (token === '--help' || token === '-h') { out.help = true; continue; }
    out.unknown = token;
  }
  return out;
}

function usage(message) {
  const text = [
    message ? '错误：' + message : null,
    '用法: node tools/score-submission.mjs --oracle <oracle.json> --submission <submission.json> [--pretty]',
    '',
    'Oracle 由测评方持有；本工具不内置任何答案，也不读取 evaluator-private 目录。',
  ].filter(Boolean).join('\n');
  console.error(text);
  process.exit(2);
}

function readJson(path, label) {
  try {
    return JSON.parse(readFileSync(resolve(path), 'utf8'));
  } catch (error) {
    usage(label + ' 读取失败: ' + String(error?.message ?? error));
    return null;
  }
}

const args = parseArgs(process.argv);
if (args.help) {
  console.log('用法: node tools/score-submission.mjs --oracle <oracle.json> --submission <submission.json> [--pretty]');
  process.exit(0);
}
if (args.unknown) usage('未知参数 ' + args.unknown);
if (!args.oracle) usage('缺少 --oracle');
if (!args.submission) usage('缺少 --submission');

const oracle = readJson(args.oracle, 'oracle');
const submission = readJson(args.submission, 'submission');
const oracleFindings = Array.isArray(oracle?.findings) ? oracle.findings : null;
if (oracleFindings === null) usage('oracle.findings 必须是数组');

const findings = Array.isArray(submission?.findings) ? submission.findings : [];

// ---- map reported findings onto oracle ids ------------------------------------------------
// A reported finding counts as detected when it declares matchedOracleId, or when its
// (category, endpoint) pair matches an oracle entry — the evaluator never has to trust a
// self-declared id alone.
const endpointKey = (raw) => {
  let path = String(raw ?? '').trim();
  try { if (/^https?:\/\//i.test(path)) path = new URL(path).pathname; } catch { /* keep */ }
  path = path.split('?')[0].split('#')[0].replace(/\/+$/, '');
  return path.split('/').map((segment) => (/^\d+$/.test(segment) || /^[0-9a-f]{8}-[0-9a-f]{4}/i.test(segment) ? ':id' : segment)).join('/');
};
const oracleByKey = new Map();
for (const entry of oracleFindings) {
  oracleByKey.set(String(entry.category ?? '') + '|' + endpointKey(entry.endpoint ?? ''), entry);
}
const detectedIds = new Set();
const unmatchedReports = [];
for (const finding of findings) {
  if (finding?.status === 'false_positive') continue;
  const declared = typeof finding?.matchedOracleId === 'string' ? finding.matchedOracleId : null;
  if (declared !== null && oracleFindings.some((entry) => String(entry.id) === declared)) {
    detectedIds.add(declared);
    continue;
  }
  const key = String(finding?.category ?? '') + '|' + endpointKey(finding?.endpoint ?? '');
  const matched = oracleByKey.get(key);
  if (matched !== undefined) detectedIds.add(String(matched.id));
  else unmatchedReports.push({ findingId: finding?.findingId ?? null, category: finding?.category ?? null, endpoint: finding?.endpoint ?? null });
}

// ---- contract metrics ---------------------------------------------------------------------
const recall = weightedRecall(oracleFindings, [...detectedIds]);
const reportedForPrecision = findings
  .filter((finding) => finding?.status !== 'false_positive')
  .map((finding) => {
    const declared = typeof finding?.matchedOracleId === 'string' ? finding.matchedOracleId : null;
    const key = String(finding?.category ?? '') + '|' + endpointKey(finding?.endpoint ?? '');
    const matched = declared ?? (oracleByKey.get(key)?.id ?? null);
    return { findingId: finding?.findingId ?? null, matchedOracleId: matched, status: finding?.status ?? null };
  });
const precisionResult = precision(reportedForPrecision, oracleFindings.map((entry) => String(entry.id)));
const gradeGap = (() => {
  const pairs = [];
  for (const finding of findings) {
    if (finding?.status === 'false_positive') continue;
    const declared = typeof finding?.matchedOracleId === 'string' ? finding.matchedOracleId : null;
    const key = String(finding?.category ?? '') + '|' + endpointKey(finding?.endpoint ?? '');
    const matched = declared !== null
      ? oracleFindings.find((entry) => String(entry.id) === declared)
      : oracleByKey.get(key);
    if (matched === undefined) continue;
    const gap = Math.abs(severityIndex(finding?.severity) - severityIndex(matched.severity));
    pairs.push({ oracleId: String(matched.id), reported: finding?.severity ?? null, oracle: matched.severity ?? null, gap });
  }
  const within = pairs.filter((pair) => pair.gap <= 1).length;
  return {
    compared: pairs.length,
    withinOneGrade: within,
    rate: pairs.length === 0 ? null : within / pairs.length,
    worst: pairs.filter((pair) => pair.gap > 1),
  };
})();

const evidenceComplete = Number.isFinite(submission?.evidenceCompleteness)
  ? submission.evidenceCompleteness
  : (Array.isArray(findings) && findings.length > 0
    ? findings.filter((finding) => finding?.complete === true).length / findings.length
    : 0);
const evidenceHighBar = submission?.highCriticalEvidenceComplete === true;

const score = scoreBlindRun({
  discoveredApiOps: Number(submission?.discoveredApiOps ?? 0),
  totalApiOps: Number(submission?.totalApiOps ?? oracle?.apiOperations?.length ?? 19),
  jsChallengesPassed: Number(submission?.jsChallengesPassed ?? 0),
  totalJsChallenges: Number(submission?.totalJsChallenges ?? 4),
  signatureChallengePassed: submission?.signatureChallengePassed === true,
  weightedRecall: recall.recall ?? 0,
  highCriticalAllFound: recall.highCriticalAllFound,
  evidenceCompleteness: evidenceComplete,
  highCriticalEvidenceComplete: evidenceHighBar,
  precision: precisionResult.precision ?? 0,
  consistencyRate: Number.isFinite(submission?.consistencyRate) ? submission.consistencyRate : Number.NaN,
  gates: submission?.gates ?? {},
});

const result = {
  kind: 'dsh-ui-testing-blind-score',
  generatedAt: new Date().toISOString(),
  oracle: { findings: oracleFindings.length },
  submission: { findings: findings.length, detectedOracleIds: [...detectedIds].sort() },
  metrics: {
    weightedRecall: recall.recall,
    missedHighCritical: recall.missedHighCriticalIds,
    precision: precisionResult.precision,
    truePositives: precisionResult.truePositives,
    falsePositives: precisionResult.falsePositives,
    severityGradeGap: gradeGap,
    evidenceCompleteness: evidenceComplete,
    highCriticalEvidenceComplete: evidenceHighBar,
    consistencyRate: Number.isFinite(submission?.consistencyRate) ? submission.consistencyRate : null,
  },
  unmatchedReports,
  score,
  verdict: score.pass ? 'PASS' : 'FAIL',
  note: '硬门槛失败不得用总分抵消；未测量的门槛计为不通过。',
};

console.log(JSON.stringify(result, null, args.pretty ? 2 : 0));
process.exit(score.pass ? 0 : 1);
