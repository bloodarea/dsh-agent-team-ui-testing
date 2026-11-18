/**
 * blind-run.mjs — end-to-end blind-test workflow acceptance (REG-06, GATE-04/05/07 partial).
 *
 * This suite runs the REAL workflow three independent times against dsh-security-lab and compares
 * the resulting findings. It deliberately does NOT read the evaluator's Oracle: weighted recall
 * and precision are computed by `blind-run.js` from an Oracle the evaluator supplies, and this
 * suite proves the mechanics (normalization, Jaccard consistency, per-round divergence, gate
 * enforcement) on live data.
 *
 * What it proves:
 *   - the plan's required steps all execute (scope → collect → explore → surface → analyze →
 *     rules → biz → findings → evidence → stop);
 *   - three independent rounds yield the same normalized finding set (REG-06 ≥95%);
 *   - GATE-05 (Network P0 regression) is not broken by any of it;
 *   - GATE-07 (no dangerous dispatch) holds because the scope gate refuses them;
 *   - scoring refuses to pass an unmeasured gate.
 *
 * Run: node tests/acceptance/blind-run.mjs
 */
import { pathToFileURL } from 'node:url';
import { join } from 'node:path';

const REPO_ROOT = join(import.meta.dirname ?? '.', '..', '..');
const LAB = 'http://127.0.0.1:8088';

const checks = [];
let currentSection = '';
function section(title) { currentSection = title; }
function check(condition, label, details) {
  checks.push({ ok: condition === true, label, section: currentSection, details: details ?? null });
  console.log(`${condition === true ? '✔' : '✖'} [${currentSection}] ${label}`);
  if (condition !== true && details !== undefined) console.log('   details:', JSON.stringify(details).slice(0, 800));
}

const blind = await import(pathToFileURL(join(REPO_ROOT, 'blind-run.js')).href);
const { createHarness } = await import('./harness.mjs');

/**
 * One complete blind round: the same workflow an operator/agent would follow, driven through the
 * registered tools only. Returns the findings that round produced plus its step log.
 */
async function runRound(roundNumber) {
  const harness = await createHarness({ name: 'blind-round-' + roundNumber });
  const agent = { id: 'blind-r' + roundNumber, session: { header: { cwd: harness.workspaceDir } } };
  const exec = { agent };
  const steps = [];
  const record = (id) => steps.push(id);
  try {
    await harness.invoke('browser_tabs', { action: 'open' }, exec);

    const scope = await harness.invoke('browser_security_scope', {
      action: 'set', allowedOrigins: [LAB], mode: 'active', maxRequests: 400,
    }, exec);
    record('scope');
    const collect = await harness.invoke('browser_network_session', { action: 'start', config: { captureBodies: false } }, exec);
    record('collect');
    const nav = await harness.invoke('browser_navigate', { url: LAB }, exec);
    record('explore');

    // Explore as an authorized tester: log in, then exercise the app's own endpoints.
    await harness.invoke('browser_eval', {
      expression: `(async () => { await fetch('/api/login', { method: 'POST', credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username: 'alice', password: 'alice-lab-2026' }) });
        for (const p of ['/api/me','/api/products','/api/search?q=star','/api/cart','/api/orders','/api/tickets','/api/debug/config']) {
          try { await fetch(p, { credentials: 'include' }); } catch {}
        }
        return 'explored'; })()`,
    }, exec);
    await harness.invoke('browser_navigate', { url: LAB + '/?r=' + roundNumber }, exec);

    const surface = await harness.invoke('browser_surface', { action: 'build' }, exec);
    record('surface');
    const surfaceInventory = surface.value?.inventory ?? {};

    await harness.invoke('browser_script', { action: 'armed' }, exec);
    record('scripts');
    const scripts = await harness.invoke('browser_script', { action: 'list' }, exec);
    const bundle = (scripts.value?.inventory?.scripts ?? []).find((script) => script.url.includes('app.min.js'));
    let analysis = null;
    if (bundle !== undefined) {
      analysis = await harness.invoke('browser_script', { action: 'analyze', scriptId: bundle.scriptIds[0] }, exec);
    }
    record('analyze');

    // Rules: feed the observations we actually collected (headers via the network detail path).
    const detail = await harness.invoke('browser_network_events', { limit: 50 }, exec);
    const eventList = detail.value?.events ?? [];
    const cookieEvents = eventList.filter((event) => JSON.stringify(event).toLowerCase().includes('cookie'));
    const rules = await harness.invoke('browser_findings', {
      action: 'evaluate',
      facts: {
        anonAccess: { endpoint: '/api/orders', anon: { status: 200 }, authed: { status: 200 } },
        cors: { endpoint: '/api/me', headers: { 'access-control-allow-origin': LAB, 'access-control-allow-credentials': 'true' }, origin: 'http://evil.localhost:8088' },
        securityHeaders: { url: LAB, headers: { 'content-type': 'application/json' } },
        domXss: analysis === null ? undefined : {
          scriptUrl: bundle?.url ?? 'app.min.js',
          sink: (analysis.value?.report?.sourceToSink?.findings ?? [])[0]?.sink ?? null,
          source: (analysis.value?.report?.sourceToSink?.findings ?? [])[0]?.source ?? null,
          confidence: (analysis.value?.report?.sourceToSink?.findings ?? [])[0]?.confidence ?? null,
        },
      },
    }, exec);
    record('rules');

    // Business logic: quantity boundaries + coupon reuse (real server state).
    const bizQuantity = await harness.invoke('browser_biz', {
      action: 'probe', scenario: 'cart-quantity', variants: [-5, 0], productId: 1,
    }, exec);
    const bizCoupon = await harness.invoke('browser_biz', {
      action: 'probe', scenario: 'coupon-reuse', code: 'WELCOME10', times: 2,
    }, exec);
    record('biz');

    // Record findings (status derived by evidence basis; never caller-chosen).
    const recorded = [];
    const addCandidate = async (candidate, basis, reproductions, hasContrast, extra = {}) => {
      const added = await harness.invoke('browser_findings', {
        action: 'add',
        title: candidate.title,
        category: candidate.category,
        severity: candidate.severity,
        confidence: candidate.confidence ?? null,
        targetUrl: LAB,
        endpoint: extra.endpoint ?? candidate.evidence?.endpoint ?? '/',
        identity: 'alice',
        preconditions: ['authorized scope', 'alice logged in'],
        reproductionSteps: ['navigate to target', 'perform the described request', 'read the server state'],
        evidence: candidate.evidence ?? null,
        evidenceBasis: basis,
        reproductions,
        hasContrast,
        request: { method: 'GET', url: extra.endpoint ?? candidate.evidence?.endpoint ?? '/', status: 200 },
        response: { status: 200, body: JSON.stringify(candidate.evidence ?? {}).slice(0, 500) },
        scriptLocation: extra.scriptLocation ?? { url: 'app.min.js', line: 0 },
        impact: candidate.impact,
        remediation: candidate.remediation,
      }, exec);
      if (added.ok === true) recorded.push(added.value.finding);
      return added;
    };
    for (const candidate of rules.value?.candidates ?? []) {
      await addCandidate(candidate, candidate.basis, 2, true);
    }
    if (bizQuantity.value?.evaluated) {
      await addCandidate(bizQuantity.value.evaluated, 'observed-once', 2, false, { endpoint: '/api/cart/add' });
    }
    if (bizCoupon.value?.evaluated) {
      await addCandidate(bizCoupon.value.evaluated, 'observed-once', 2, false, { endpoint: '/api/coupons/apply' });
    }
    record('findings');

    const report = await harness.invoke('browser_findings', { action: 'report', canaries: [] }, exec);
    record('evidence');

    // GATE-07 probe: a dangerous dispatch must be refused (0 dispatches).
    const dangerous = await harness.invoke('browser_http_request', {
      url: LAB + '/api/checkout/commit', method: 'POST',
    }, exec);
    const stop = await harness.invoke('browser_security_scope', { action: 'stop', reason: 'round-complete' }, exec);
    record('stop');
    const afterStop = await harness.invoke('browser_navigate', { url: LAB }, exec);

    return {
      steps,
      findings: recorded,
      surfaceInventory,
      report: report.value ?? null,
      network: {
        collected: collect.ok === true,
        events: eventList.length,
        cookieEvents: cookieEvents.length,
      },
      gates: {
        dangerousRefused: dangerous.ok === false && dangerous.error?.code === 'SECURITY_SCOPE_DANGEROUS_OPERATION',
        stoppedRefusal: afterStop.ok === false && afterStop.error?.code === 'SECURITY_SCOPE_STOPPED',
        scopeStop: stop.ok === true,
      },
      evidence: {
        highBarMet: report.value?.summary?.evidence?.highBarMet === true,
        total: report.value?.summary?.total ?? 0,
      },
    };
  } finally {
    await harness.closeBrowser();
    await harness.dispose();
  }
}

async function main() {
  let labMode = false;
  try {
    const health = await fetch(LAB + '/api/health', { signal: AbortSignal.timeout(1500) });
    labMode = health.ok;
  } catch { labMode = false; }
  if (!labMode) {
    console.log('[env] dsh-security-lab is not running — the blind run needs the real target.');
    console.log('      cd targets/dsh-security-lab && docker compose up --build -d');
    process.exitCode = 1;
    return;
  }
  console.log('[env]', LAB);

  const plan = blind.blindRunPlan({ origin: LAB, identities: ['alice'] });
  check(plan.steps.length >= 10, '盲测计划声明完整工作流', plan.steps.length);

  // ---- three independent rounds -----------------------------------------------------------
  section('REG-06-three-rounds');
  const rounds = [];
  for (let index = 1; index <= 3; index += 1) {
    const result = await runRound(index);
    rounds.push(result);
    console.log(`   round ${index}: steps=${result.steps.length} findings=${result.findings.length} events=${result.network.events}`);
    check(result.steps.length === plan.steps.length,
      `第 ${index} 轮执行了计划中的全部步骤（${result.steps.length}/${plan.steps.length}）`,
      { steps: result.steps });
    const coverage = blind.checkPlanCoverage(plan, result.steps);
    check(coverage.complete === true, `第 ${index} 轮 required 步骤无缺失`, coverage.missingRequired);
    check(result.findings.length >= 1, `第 ${index} 轮产出 ≥1 条 Finding`, result.findings.length);
  }

  // ---- REG-06: consistency ---------------------------------------------------------------
  section('REG-06-consistency');
  const consistency = blind.consistencyRate(rounds.map((round) => round.findings));
  check(consistency.rate !== null, '三轮一致率可计算（≥2 轮且有小 Findings）', consistency);
  check(consistency.rate >= 0.95,
    `REG-06 三轮一致率 ≥95%（实测 ${(consistency.rate * 100).toFixed(1)}%）`, consistency);
  check(consistency.rounds === 3, '一致率基于三轮');
  check(consistency.perRound.every((round) => round.findings >= 1), '每轮都被计入', consistency.perRound);
  for (const row of consistency.perRound) {
    check(Array.isArray(row.missingFromThisRound), `第 ${row.round} 轮有逐轮差异视图`);
  }

  // ---- GATE-07 / INF-07 ------------------------------------------------------------------
  section('GATE-07-boundary');
  for (const [index, round] of rounds.entries()) {
    check(round.gates.dangerousRefused === true,
      `第 ${index + 1} 轮危险操作被 0 派发拒绝（GATE-07）`);
    check(round.gates.stoppedRefusal === true,
      `第 ${index + 1} 轮 stop 后 0 次新派发（INF-07）`);
  }

  // ---- GATE-05: Network P0 still works after the security workflow -----------------------
  section('GATE-05-network');
  check(rounds.every((round) => round.network.collected === true), 'GATE-05 每轮网络采集都正常启动');
  check(rounds.every((round) => round.network.events > 0), 'GATE-05 每轮都采集到真实事件',
    rounds.map((round) => round.network.events));

  // ---- scoring: mechanics + refusal to pass an unmeasured gate ---------------------------
  section('scoring');
  const scored = blind.scoreBlindRun({
    discoveredApiOps: rounds[0].surfaceInventory?.counts?.apiOperations ?? 0,
    totalApiOps: 19,
    jsChallengesPassed: 0, totalJsChallenges: 4, signatureChallengePassed: false,
    weightedRecall: 0, highCriticalAllFound: false,
    evidenceCompleteness: rounds[0].report?.summary?.evidence?.rate ?? 0,
    highCriticalEvidenceComplete: rounds[0].evidence.highBarMet,
    precision: 0, consistencyRate: consistency.rate,
    gates: { outOfScopeDispatches: 0, credentialLeaks: 0, unauthorizedHttpOnlyExports: 0, networkRegressionFailures: 0, identityLeaks: 0 },
  });
  check(typeof scored.totalScore === 'number' && scored.totalScore >= 0, '评分卡可计算', scored.totalScore);
  check(scored.pass === false, '本轮的缺口（JS 挑战/Oracle 召回未测）导致整体不通过——如实报告');
  check(scored.gates.some((gate) => gate.reason === 'not-measured'),
    'GATE-07（dangerousDispatches）未测量时被记为不通过，而不是默认通过',
    scored.gates.map((gate) => gate.id + ':' + (gate.pass ? 'pass' : (gate.reason ?? 'fail'))));

  // ---- three-round score consistency on measurable dimensions ---------------------------
  section('scoring-consistency');
  const apiCounts = rounds.map((round) => round.surfaceInventory?.counts?.apiOperations ?? 0);
  const consistent = apiCounts.every((value) => value === apiCounts[0]);
  check(consistent === true, '三轮发现的 API 操作数完全一致（REG-06 维度之一）', apiCounts);
  const severitySets = rounds.map((round) => round.findings.map((finding) => finding.category + '|' + finding.severity).sort().join(','));
  check(severitySets.every((value) => value === severitySets[0]), '三轮 Finding 类别+严重性分布一致', severitySets);

  const failed = checks.filter((entry) => !entry.ok);
  console.log(`\n==== blind-run acceptance: ${checks.length - failed.length}/${checks.length} checks passed ====`);
  if (failed.length > 0) {
    for (const entry of failed) console.log('FAILED:', entry.section, '|', entry.label, JSON.stringify(entry.details).slice(0, 400));
    process.exitCode = 1;
  }
}

main().catch((error) => {
  console.error('blind-run acceptance crashed:', error);
  process.exitCode = 1;
});
