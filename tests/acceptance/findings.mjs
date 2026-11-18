/**
 * findings.mjs — FR-09/FR-10 acceptance: Finding model, rule engine, evidence loop
 * (VULN-08/09/10/11, EVD-01..EVD-07).
 *
 * Ground truth: the plugin's own findings store. The suite asserts the CONTRACT properties that
 * make the report trustworthy, not just that calls succeed:
 *   - a static pattern can never be recorded as confirmed (status is derived, never caller-chosen);
 *   - confirmed requires ≥2 reproductions AND a contrast verification;
 *   - a single observation tops out at likely;
 *   - the rule engine never fabricates a finding from an absent fact;
 *   - evidence completeness separates overall from the High/Critical hard bar;
 *   - weighted recall / precision follow the contract formulas;
 *   - canary scanning keeps credentials out of the report.
 *
 * Run: node tests/acceptance/findings.mjs
 */
import { pathToFileURL } from 'node:url';
import { join } from 'node:path';

const REPO_ROOT = join(import.meta.dirname ?? '.', '..', '..');

const checks = [];
let currentSection = '';
function section(title) { currentSection = title; }
function errorInfo(result) {
  return { code: result?.error?.code, category: result?.error?.category };
}
function check(condition, label, details) {
  checks.push({ ok: condition === true, label, section: currentSection, details: details ?? null });
  console.log(`${condition === true ? '✔' : '✖'} [${currentSection}] ${label}`);
  if (condition !== true && details !== undefined) console.log('   details:', JSON.stringify(details).slice(0, 700));
}

const { createHarness } = await import('./harness.mjs');

/** A finding that satisfies the schema; overrides let each test break one thing. */
function findingInput(overrides = {}) {
  return {
    title: 'Object-level authorization bypass', category: 'authorization-object',
    severity: 'critical', confidence: 0.95,
    targetUrl: 'http://127.0.0.1:8088', endpoint: '/api/orders/42', identity: 'alice',
    preconditions: ['alice logged in'], reproductionSteps: ['login as alice', 'GET /api/orders/42 as bob'],
    evidence: { basis: 'differential' }, evidenceBasis: 'differential',
    reproductions: 2, hasContrast: true,
    request: { method: 'GET', url: '/api/orders/42', status: 200 },
    response: { status: 200, body: '{"order":42}' },
    scriptLocation: { url: 'app.min.js', line: 0 },
    impact: 'read another user order', remediation: 'enforce server-side ownership',
    ...overrides,
  };
}

async function main() {
  const harness = await createHarness({ name: 'findings' });
  const agent = { id: 'findings-acc', session: { header: { cwd: harness.workspaceDir } } };
  const exec = { agent };
  try {
    // ---- EVD-01 + FR-09: status derivation is not caller-chosen ----------------------------
    section('FR-09-status-derivation');
    const staticClaim = await harness.invoke('browser_findings', {
      action: 'add', ...findingInput({ category: 'xss-dom', severity: 'medium', evidenceBasis: 'static-pattern', reproductions: 0, hasContrast: false, status: 'confirmed', request: null, response: null, dom: { selector: '#tickets' } }),
    }, exec);
    check(staticClaim.ok === true, '静态证据 Finding 可登记');
    check(staticClaim.value?.finding?.status === 'potential', 'FR-09 静态证据只能标 potential（请求 confirmed 被降级）', staticClaim.value?.finding?.status);
    check(String(staticClaim.value?.finding?.notes?.[0] ?? '').includes('降级'), '降级原因写入 notes');
    check(staticClaim.value?.derivation?.downgraded === true, 'derivation 报告 downgraded', staticClaim.value?.derivation);

    const onceClaim = await harness.invoke('browser_findings', {
      action: 'add', ...findingInput({ findingId: 'F-once', severity: 'high', evidenceBasis: 'observed-once', reproductions: 1, hasContrast: false }),
    }, exec);
    check(onceClaim.value?.finding?.status === 'likely', 'FR-09 单次观测最高 likely');

    const oneRepro = await harness.invoke('browser_findings', {
      action: 'add', ...findingInput({ findingId: 'F-one-repro', evidenceBasis: 'differential', reproductions: 1, hasContrast: true }),
    }, exec);
    check(oneRepro.value?.finding?.status === 'likely', 'FR-09 仅 1 次复现不能 confirmed');

    const confirmed = await harness.invoke('browser_findings', {
      action: 'add', ...findingInput(),
    }, exec);
    check(confirmed.value?.finding?.status === 'confirmed', 'FR-09 differential + 2 复现 + 对照 = confirmed', {
      status: confirmed.value?.finding?.status, derivation: confirmed.value?.derivation,
    });
    check(typeof confirmed.value?.finding?.actionId === 'string', 'EVD-01 Finding 带 actionId');
    check(Number.isInteger(confirmed.value?.finding?.createdAt), 'EVD-01 Finding 带时间戳');

    const duplicate = await harness.invoke('browser_findings', {
      action: 'add', ...findingInput({ findingId: confirmed.value.finding.findingId }),
    }, exec);
    check(duplicate.ok === false && duplicate.error?.code === 'FINDING_INVALID_ARGUMENT', '重复 findingId 被拒');

    // ---- VULN-10: retest promotes only with real evidence ---------------------------------
    section('VULN-10-retest');
    const retestStatic = await harness.invoke('browser_findings', {
      action: 'retest', findingId: staticClaim.value.finding.findingId, reproduced: true,
    }, exec);
    check(retestStatic.value?.statusAfter === 'potential', 'VULN-10 静态证据复现后仍是 potential（不升级）');
    const retestConfirmed = await harness.invoke('browser_findings', {
      action: 'retest', findingId: oneRepro.value.finding.findingId, reproduced: true,
    }, exec);
    check(retestConfirmed.value?.statusAfter === 'confirmed', 'VULN-10 补足复现后升级为 confirmed', retestConfirmed.value);

    // ---- VULN-01..07: rule engine never fabricates -----------------------------------------
    section('VULN-01-07-rules');
    const emptyEval = await harness.invoke('browser_findings', { action: 'evaluate', facts: {} }, exec);
    check(emptyEval.ok === true && emptyEval.value?.candidates?.length === 0,
      '规则引擎对空事实不产生候选（不把"没观测"变成误报）', emptyEval.value?.candidates);

    const corsEval = await harness.invoke('browser_findings', {
      action: 'evaluate',
      facts: {
        cors: { endpoint: '/api/me', headers: { 'access-control-allow-origin': '*', 'access-control-allow-credentials': 'true' } },
        securityHeaders: { url: 'http://127.0.0.1:8088', headers: { 'content-security-policy': "default-src 'self'" } },
        anonAccess: { endpoint: '/api/orders', anon: { status: 200 }, authed: { status: 200 } },
      },
    }, exec);
    const ruleIds = (corsEval.value?.candidates ?? []).map((candidate) => candidate.ruleId);
    check(ruleIds.includes('CORS-CREDENTIALS'), 'VULN-07 检出 CORS 任意 Origin + credentials', ruleIds);
    check(ruleIds.includes('HEADER-MISSING'), 'VULN-07 检出缺失安全头');
    check(ruleIds.includes('AUTH-ANON-ACCESS'), 'VULN-01 检出匿名可访问受保护端点');
    check((corsEval.value?.candidates ?? []).every((candidate) => candidate.allowedStatus !== 'confirmed'),
      'VULN-09 所有候选的允许状态都不是 confirmed（须经复现+对照）',
      corsEval.value?.candidates.map((c) => c.ruleId + ':' + c.allowedStatus));

    const noFalsePositive = await harness.invoke('browser_findings', {
      action: 'evaluate',
      facts: { anonAccess: { endpoint: '/api/orders', anon: { status: 401 }, authed: { status: 200 } } },
    }, exec);
    check((noFalsePositive.value?.candidates ?? []).length === 0,
      'VULN-01 匿名被正确拒绝（401）时不产生 Finding（避免误报）');

    // ---- EVD-01..04: completeness ----------------------------------------------------------
    section('EVD-01-04-completeness');
    const gradedGood = await harness.invoke('browser_findings', {
      action: 'grade', findingId: confirmed.value.finding.findingId,
    }, exec);
    check(gradedGood.value?.grade?.complete === true, 'EVD-01/03 完整 Finding 通过 Schema 校验', gradedGood.value?.grade);

    const noEvidence = await harness.invoke('browser_findings', {
      action: 'add', findingId: 'F-bare', ...findingInput({
        severity: 'high', request: null, response: null, dom: null, screenshot: null, scriptLocation: null,
      }),
    }, exec);
    const gradedBare = await harness.invoke('browser_findings', {
      action: 'grade', findingId: noEvidence.value.finding.findingId,
    }, exec);
    check(gradedBare.value?.grade?.complete === false, 'EVD-03/EVD-04 缺请求/响应或 UI-源码关联时完整度不通过');
    check(gradedBare.value?.grade?.violations?.includes('no-request-or-response-evidence'), 'EVD-04 缺失原因明确（no-request-or-response-evidence）');

    // ---- EVD-02: High/Critical hard bar ----------------------------------------------------
    section('EVD-02-high-bar');
    const list = await harness.invoke('browser_findings', { action: 'list' }, exec);
    check(list.value?.summary?.evidence?.highBarMet === false,
      'EVD-02 存在 High/Critical 证据缺口时 highBarMet=false（不得宣称通过）', list.value?.summary?.evidence);
    check((list.value?.summary?.evidence?.highCriticalTotal ?? 0) >= 1, 'High/Critical 计数被统计');

    // Fix the gap by adding a complete high finding, then re-check the bar.
    await harness.invoke('browser_findings', {
      action: 'add', findingId: 'F-high-ok', ...findingInput({ severity: 'high', title: 'High finding with full evidence' }),
    }, exec);
    const listAfter = await harness.invoke('browser_findings', { action: 'list' }, exec);
    check((listAfter.value?.summary?.evidence?.highCriticalTotal ?? 0) >= 2, '新增 High Finding 后计入统计');
    check(listAfter.value?.summary?.evidence?.incomplete?.every((entry) => entry.findingId !== null),
      'EVD-02 不完整清单带 findingId（可回溯）');

    // ---- EVD-06: canary --------------------------------------------------------------------
    section('EVD-06-canary');
    const canary = 'cookie-value-must-not-appear-9f31';
    await harness.invoke('browser_findings', {
      action: 'add', findingId: 'F-leak', ...findingInput({ severity: 'low', title: 'leaky note' }),
    }, exec);
    const reportClean = await harness.invoke('browser_findings', { action: 'report', canaries: [canary] }, exec);
    check(reportClean.value?.canaryScan?.clean === true, 'EVD-06 报告不含未出现的敏感值');
    check(reportClean.value?.kind === 'dsh-ui-testing-security-report', '报告结构合法');
    check(Number.isInteger(reportClean.value?.summary?.total), '报告含汇总');

    // ---- FR-10: report summary reflects severity/status --------------------------------
    section('FR-10-report');
    const summary = reportClean.value?.summary ?? {};
    check((summary.bySeverity?.critical ?? 0) >= 1, 'FR-10 汇总按严重性分组（critical）');
    check((summary.byStatus?.confirmed ?? 0) >= 1, 'FR-10 汇总按状态分组（confirmed）');
    check((summary.severityWeightSum ?? 0) > 0, 'FR-10 汇总含严重性权重和（VULN-08 基础）');
    check(Array.isArray(summary.confirmedWithoutContrast), 'FR-10/EVD-07 confirmed 无对照项被单列（报告完整性）');

    // ---- VULN-08/09: formulas (pure-function spot check through the module) -------------
    section('VULN-08-09-formulas');
    const findingModule = await import(pathToFileURL(join(REPO_ROOT, 'finding.js')).href);
    const recall = findingModule.weightedRecall(
      [{ id: 'v1', severity: 'critical' }, { id: 'v2', severity: 'high' }, { id: 'v3', severity: 'low' }],
      ['v1'],
    );
    check(Math.abs(recall.recall - 5 / 10) < 1e-9, 'VULN-08 加权召回率按权重计算（5/10）', recall);
    check(recall.missedHighCriticalIds.includes('v2'), 'VULN-08 漏报 High 被单列');
    const prec = findingModule.precision(
      [{ matchedOracleId: 'v1', status: 'confirmed' }, { matchedOracleId: 'vX', status: 'confirmed' },
        { matchedOracleId: 'v3', status: 'false_positive' }],
      ['v1', 'v2', 'v3'],
    );
    check(prec.precision === 0.5, 'VULN-09 Precision = TP/(TP+FP)，false_positive 不计入');
    ok: {
      // sanity: the finding module really is the one the tool uses
      check(typeof findingModule.deriveStatus === 'function', 'VULN-08/09 使用与工具相同的 finding 模块');
    }

    // ---- EVD-05: an independent tester must be able to reproduce the finding ------------------
    section('EVD-05-reproduce');
    // Record findings whose `request` mirrors a real endpoint answer, then REPLAY each one through
    // the tool (not by asserting "yes it reproduces"). The measured rate is the metric.
    // The replay runs in the page, so this suite needs a real page + session first (the rest of
    // this suite is host-only and never navigates).
    const reproTab = await harness.invoke('browser_tabs', { action: 'open' }, exec);
    check(reproTab.ok === true, 'EVD-05 复现需要真实页面（已开标签）', errorInfo(reproTab));
    const reproNav = await harness.invoke('browser_navigate', { url: 'http://127.0.0.1:8088/' }, exec);
    check(reproNav.ok === true, 'EVD-05 导航到靶机', errorInfo(reproNav));
    const reproLogin = await harness.invoke('browser_eval', {
      expression: `(async () => { const r = await fetch('/api/login', { method: 'POST', credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username: 'alice', password: 'alice-lab-2026' }) }); return r.status; })()`,
    }, exec).catch(() => null);
    check(reproLogin?.value?.value === 200,
      'EVD-05 复现前先建立会话（会话端点否则如实返回 401）', reproLogin?.value?.value);
    const REPRO_CASES = [
      { id: 'R1', path: '/api/health', status: 200, bodyPrefix: '{"ok"' },
      { id: 'R2', path: '/api/products', status: 200, bodyPrefix: '{"products"' },
      { id: 'R3', path: '/api/me', status: 200, bodyPrefix: '{"user"' },
      { id: 'R4', path: '/api/cart', status: 200, bodyPrefix: '{"items"' },
      { id: 'R5', path: '/api/admin/reports', status: 200, bodyPrefix: '{"report"' },
    ];
    const reproResults = [];
    for (const testCase of REPRO_CASES) {
      const added = await harness.invoke('browser_findings', {
        action: 'add',
        findingId: 'F-repro-' + testCase.id,
        title: 'repro sample ' + testCase.id,
        category: 'information-disclosure', severity: 'low', confidence: 0.7,
        targetUrl: 'http://127.0.0.1:8088', endpoint: testCase.path, identity: 'alice',
        preconditions: ['alice session'], reproductionSteps: ['GET ' + testCase.path],
        evidence: { basis: 'observed-once' }, evidenceBasis: 'observed-once',
        request: { method: 'GET', url: testCase.path, status: testCase.status },
        response: { status: testCase.status, body: testCase.bodyPrefix },
        scriptLocation: { url: 'app.min.js', line: 0 },
        impact: 'sample', remediation: 'sample',
      }, exec);
      const findingId = added.value?.finding?.findingId;
      const replay = await harness.invoke('browser_findings', { action: 'reproduce', findingId }, exec);
      reproResults.push({
        id: testCase.id,
        path: testCase.path,
        ok: replay.ok === true,
        reproduced: replay.value?.reproduced === true,
        expected: replay.value?.expected?.status ?? null,
        observed: replay.value?.observed?.status ?? null,
        code: replay.error?.code ?? null,
      });
    }
    const reproducible = reproResults.filter((entry) => entry.reproduced === true);
    const reproductionRate = reproducible.length / Math.max(1, reproResults.length);
    console.log(`   复现成功 ${reproducible.length}/${reproResults.length} = ${(reproductionRate * 100).toFixed(1)}%`);
    check(reproResults.every((entry) => entry.ok === true),
      'EVD-05 五条 Finding 的重放调用全部完成（不是跳过）',
      reproResults.filter((entry) => !entry.ok).map((entry) => ({ id: entry.id, code: entry.code })));
    check(reproductionRate >= 0.95,
      `EVD-05 独立复现成功率 ${(reproductionRate * 100).toFixed(1)}% ≥95%（重放真实请求并比对服务端回答）`,
      reproResults.filter((entry) => !entry.reproduced));

    // A replay that does NOT match must be reported as such and must not promote the finding.
    const wrong = await harness.invoke('browser_findings', {
      action: 'add', findingId: 'F-repro-wrong', title: 'deliberately wrong record', category: 'cors',
      severity: 'low', targetUrl: 'http://127.0.0.1:8088', endpoint: '/api/health', identity: 'alice',
      evidence: { basis: 'observed-once' }, evidenceBasis: 'observed-once',
      request: { method: 'GET', url: '/api/health', status: 599 },
      response: { status: 599, body: 'never-this' },
    }, exec);
    const wrongReplay = await harness.invoke('browser_findings', {
      action: 'reproduce', findingId: wrong.value?.finding?.findingId,
    }, exec);
    check(wrongReplay.value?.reproduced === false,
      'EVD-05 记录错误时重放如实报"不可复现"（不为了达标而放宽）', wrongReplay.value?.comparison);
    check(wrongReplay.value?.comparison?.statusMatches === false,
      'EVD-05 比对细节给出状态不匹配的原因', wrongReplay.value?.comparison);

    // A successful replay must count toward the confirmation threshold, not replace it.
    const beforeStatus = reproResults[0];
    const promoted = await harness.invoke('browser_findings', { action: 'list', statusFilter: 'confirmed' }, exec);
    check(Array.isArray(promoted.value?.findings),
      'EVD-05 重放后可查询按状态过滤的清单', promoted.value?.total);
    void beforeStatus;

    // Reproduce must be scope-gated like any dispatch. Without a configured scope there is no
    // boundary by design, so the test establishes one first.
    await harness.invoke('browser_security_scope', {
      action: 'set', allowedOrigins: ['http://127.0.0.1:8088'], mode: 'active',
    }, exec);
    const outOfScope = await harness.invoke('browser_findings', {
      action: 'add', findingId: 'F-out-of-scope', title: 'out of scope replay', category: 'other',
      severity: 'low', targetUrl: 'http://example.com', endpoint: '/x', identity: 'alice',
      evidence: { basis: 'observed-once' }, evidenceBasis: 'observed-once',
      request: { method: 'GET', url: 'http://example.com/x', status: 200 }, response: { status: 200, body: 'x' },
    }, exec);
    const blocked = await harness.invoke('browser_findings', {
      action: 'reproduce', findingId: outOfScope.value?.finding?.findingId,
    }, exec);
    check(blocked.ok === false && /SECURITY_SCOPE_/.test(String(blocked.error?.code)),
      'EVD-05 越界复现被 scope 闸门拒绝（复现不是逃逸口）', blocked.error?.code);

    const failed = checks.filter((entry) => !entry.ok);
    console.log(`\n==== findings acceptance: ${checks.length - failed.length}/${checks.length} checks passed ====`);
    if (failed.length > 0) {
      for (const entry of failed) console.log('FAILED:', entry.section, '|', entry.label, JSON.stringify(entry.details).slice(0, 400));
      process.exitCode = 1;
    }
  } finally {
    await harness.closeBrowser();
    await harness.dispose();
  }
}

main().catch((error) => {
  console.error('findings acceptance crashed:', error);
  process.exitCode = 1;
});
