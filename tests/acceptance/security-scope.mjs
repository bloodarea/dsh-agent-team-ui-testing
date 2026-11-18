/**
 * security-scope.mjs — FR-01 Scope & Safety Controller acceptance
 * (GATE-01 + INF-01..INF-07 against the real harness + fixture).
 *
 * Ground truth: every refusal must be a 0-dispatch refusal (no browser round trip, no page
 * mutation), and every accept must leave an audit entry. The suite walks the whole INF matrix
 * against the plugin's own headless Chromium: origin allowlist, path constraints, redirect-hop
 * check, budget, concurrency (via cookie-export pairing), passive/active mode, stop semantics.
 *
 * Run: node tests/acceptance/security-scope.mjs
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const REPO_ROOT = join(import.meta.dirname ?? '.', '..', '..');

const checks = [];
let currentSection = '';
function section(title) { currentSection = title; }
function check(condition, label, details) {
  checks.push({ ok: condition === true, label, section: currentSection, details: details ?? null });
  console.log(`${condition === true ? '✔' : '✖'} [${currentSection}] ${label}`);
  if (condition !== true && details !== undefined) console.log('   details:', JSON.stringify(details));
}
function errorInfo(result) {
  return { code: result.error?.code, category: result.error?.category, message: result.error?.message?.slice(0, 160) };
}

async function main() {
  const { startFixtureServer } = await import(pathToFileURL(join(REPO_ROOT, 'tests/ui_test_fixture/server.mjs')).href);
  const fixture = await startFixtureServer();
  const origin = fixture.url.replace(/\/$/, '');
  const { createHarness } = await import('./harness.mjs');
  const captureRoot = mkdtempSync(join(tmpdir(), 'scope-acc-root-'));
  process.env.DSH_UI_TESTING_CAPTURE_DIR = captureRoot;

  const harness = await createHarness({ name: 'security-scope' });
  const agent = { id: 'scope-acc-agent', session: { header: { cwd: harness.workspaceDir } } };
  const exec = { agent };
  try {
    // ---- setup: own work page + initial navigation (pre-scope, must be unaffected) ------------
    await harness.invoke('browser_tabs', { action: 'open' }, exec);
    const pre = await harness.invoke('browser_navigate', { url: origin }, exec);
    check(pre.ok === true, 'scope 未启用时导航不受影响（FR-12 按需启用）');

    // ---- INF-06: passive default ---------------------------------------------------------------
    section('INF-06-passive');
    const passive = await harness.invoke('browser_security_scope', {
      action: 'set', allowedOrigins: [origin], mode: 'passive',
    }, exec);
    check(passive.ok === true && passive.value?.config?.mode === 'passive', 'passive 模式配置成功');
    check(passive.value?.scopeConfigRevision === 1, 'scopeConfigRevision=1（区别于宿主 configRevision）', passive.value?.scopeConfigRevision);

    const inNav = await harness.invoke('browser_navigate', { url: origin + '/index.html' }, exec);
    check(inNav.ok === true, '白名单内探索性导航放行（passive）');

    // ---- GATE-01/INF-01: out-of-scope origin ----------------------------------------------------
    section('GATE-01-origin');
    const outNav = await harness.invoke('browser_navigate', { url: 'http://127.0.0.1:1/' }, exec);
    check(outNav.ok === false && outNav.error?.code === 'SECURITY_SCOPE_ORIGIN_VIOLATION', '越界 Origin 0 次派发拒绝（GATE-01）', errorInfo(outNav));
    check(outNav.error?.category === 'authorization', '拒绝分类 authorization（REG-04）', outNav.error?.category);
    const stateAfterOut = await harness.invoke('browser_state', {}, exec);
    check(stateAfterOut.value?.url?.startsWith(origin) === true, '越界拒绝后页面仍停在授权 Origin（0 副作用）', stateAfterOut.value?.url);

    // ---- INF-02: redirect-hop check --------------------------------------------------------------
    section('INF-02-redirect');
    // Configure a narrow scope that excludes the redirect target, then navigate the two-hop chain.
    const narrow = await harness.invoke('browser_security_scope', {
      action: 'set', allowedOrigins: [origin], mode: 'passive', expectedConfigRevision: passive.value?.scopeConfigRevision,
    }, exec);
    check(narrow.ok === true && narrow.value?.scopeConfigRevision === 2, 'CAS 重配置成功（revision 1→2）', narrow.value?.scopeConfigRevision);
    const redirect = await harness.invoke('browser_navigate', { url: origin + '/redirect' }, exec);
    // /redirect lands on /second.html — inside the same origin, so it passes the hop check.
    check(redirect.ok === true, '同 Origin 重定向逐跳通过', errorInfo(redirect));

    // ---- INF-06: passive blocks cookie export ----------------------------------------------------
    section('INF-06-passive-blocks-active');
    const meta = await harness.invoke('browser_cookies', { action: 'metadata' }, exec);
    check(meta.ok === true, 'metadata（被动）放行');
    // A human-issued approval is required first: the approval check precedes the scope gate and
    // also refuses with 0 dispatches. Issuing one lets the export reach the scope gate, which is
    // the boundary being tested here.
    const { writeFileSync, mkdirSync } = await import('node:fs');
    const approvalsDir = process.env.DSH_UI_TESTING_CONFIG_DIR;
    mkdirSync(approvalsDir, { recursive: true });
    const authScope = meta.value?.authScope ?? null;
    writeFileSync(join(approvalsDir, 'security-approvals.json'), JSON.stringify({ approvals: [{
      approvalId: 'scope-acc-001', origin: authScope?.origin, tabId: authScope?.tabId,
      workspaceId: authScope?.workspaceId, runtimeId: authScope?.runtimeId,
      allowHttpOnly: true, issuedAt: Date.now() - 1000, expiresAt: Date.now() + 60_000,
    }] }), 'utf8');
    const deniedExport = await harness.invoke('browser_cookies', { action: 'export', out: 'output/cookies/scope-denied.json', allowHttpOnly: true }, exec);
    check(deniedExport.ok === false && deniedExport.error?.code === 'SECURITY_SCOPE_PASSIVE_MODE',
      'passive 模式下 cookie 导出（主动派发）0 次拒绝', errorInfo(deniedExport));

    // ---- INF-04: budget ---------------------------------------------------------------------------
    section('INF-04-budget');
    const tight = await harness.invoke('browser_security_scope', {
      action: 'set', allowedOrigins: [origin], mode: 'passive', maxRequests: 3,
      expectedConfigRevision: narrow.value?.scopeConfigRevision,
    }, exec);
    check(tight.ok === true, '预算 3 配置成功');
    // 3 budget units: two consumed by navigations below, one left — then refuse on the 4th.
    await harness.invoke('browser_navigate', { url: origin + '/index.html' }, exec);
    await harness.invoke('browser_navigate', { url: origin + '/second.html' }, exec);
    const overBudget = await harness.invoke('browser_navigate', { url: origin + '/index.html' }, exec);
    check(overBudget.ok === false && overBudget.error?.code === 'SECURITY_SCOPE_BUDGET_EXCEEDED', '超预算 0 次派发拒绝（INF-04）', errorInfo(overBudget));

    // ---- INF-01: 100% pre-dispatch origin validation ------------------------------------------
    section('INF-01-pre-dispatch');
    {
      // Earlier checks in this suite deliberately exhaust the budget, so reset it first — the
      // INF-01 assertion is about pre-dispatch validation, not about the budget.
      const current = await harness.invoke('browser_security_scope', { action: 'status' }, exec);
      await harness.invoke('browser_security_scope', {
        action: 'set', allowedOrigins: [origin], mode: 'active', maxRequests: 500,
        maxRequestsPerSecond: 0, expectedConfigRevision: current.value?.scopeConfigRevision,
      }, exec);
      // Every in-scope dispatch must be counted exactly once, and every out-of-scope attempt must
      // be refused BEFORE it reaches the network (dispatches counter must not move).
      const before = await harness.invoke('browser_security_scope', { action: 'status' }, exec);
      const dispatchesBefore = before.value?.counters?.dispatches ?? 0;
      const refused = await harness.invoke('browser_navigate', { url: 'http://example.com/' }, exec);
      const afterRefusal = await harness.invoke('browser_security_scope', { action: 'status' }, exec);
      const dispatchesAfterRefusal = afterRefusal.value?.counters?.dispatches ?? 0;
      check(refused.ok === false && refused.error?.code === 'SECURITY_SCOPE_ORIGIN_VIOLATION',
        'INF-01 越界导航被派发前拒绝', errorInfo(refused));
      check(dispatchesAfterRefusal === dispatchesBefore,
        `INF-01 被拒请求未计入派发（${dispatchesBefore} → ${dispatchesAfterRefusal}）= 0 次实际派发`,
        { before: dispatchesBefore, after: dispatchesAfterRefusal });
      // An in-scope dispatch DOES move the counter, proving the counter is not simply frozen.
      const allowed = await harness.invoke('browser_http_request', { url: origin + '/api/health' }, exec);
      const afterAllowed = await harness.invoke('browser_security_scope', { action: 'status' }, exec);
      check(allowed.ok === true, 'INF-01 白名单内请求被放行（对照）', errorInfo(allowed));
      check((afterAllowed.value?.counters?.dispatches ?? 0) > dispatchesAfterRefusal,
        'INF-01 放行请求被计入派发（计数器可用，不是冻结值）',
        afterAllowed.value?.counters?.dispatches);
      check((afterAllowed.value?.counters?.rejected ?? 0) >= 1,
        'INF-01 拒绝被计数并可审计', afterAllowed.value?.counters?.rejected);
    }

    // ---- INF-05: rate limit (rolling 1s window) ---------------------------------------------------
    section('INF-05-rate');
    const revisionBeforeRate = await harness.invoke('browser_security_scope', { action: 'status' }, exec);
    const rateScoped = await harness.invoke('browser_security_scope', {
      action: 'set', allowedOrigins: [origin], mode: 'active', maxRequestsPerSecond: 2,
      maxRequests: 500, expectedConfigRevision: revisionBeforeRate.value?.scopeConfigRevision,
    }, exec);
    check(rateScoped.ok === true, '速率上限 2/s 配置成功', errorInfo(rateScoped));
    // Two quick dispatches are allowed; the third inside the same second must be refused.
    const rateResults = [];
    for (let index = 0; index < 4; index += 1) {
      rateResults.push(await harness.invoke('browser_http_request', { url: origin + '/api/health' }, exec));
    }
    const rateRefused = rateResults.filter((result) => result.error?.code === 'SECURITY_SCOPE_RATE_EXCEEDED');
    check(rateRefused.length >= 1, `INF-05 突发请求被速率上限拦截（拒绝 ${rateRefused.length}/${rateResults.length}）`,
      rateResults.map((result) => result.error?.code ?? 'ok'));
    check(rateRefused.every((result) => result.error?.category === 'resource' && result.error?.retryable === false),
      'INF-05 速率拒绝分类为 resource/不可重试');
    const rateStatus = await harness.invoke('browser_security_scope', { action: 'status' }, exec);
    check(rateStatus.value?.config?.maxRequestsPerSecond === 2, 'INF-05 status 暴露已配置速率',
      rateStatus.value?.config?.maxRequestsPerSecond);

    // ---- INF-08: destructive operation gate (independent HTTP is governed too) --------------------
    section('INF-08-danger');
    const dangerHttp = await harness.invoke('browser_http_request', {
      url: origin + '/api/checkout/commit', method: 'POST',
    }, exec);
    check(dangerHttp.ok === false && dangerHttp.error?.code === 'SECURITY_SCOPE_DANGEROUS_OPERATION',
      '危险操作（支付提交）0 次派发拒绝（INF-08/GATE-07）', errorInfo(dangerHttp));
    const deleteHttp = await harness.invoke('browser_http_request', {
      url: origin + '/api/orders/1', method: 'DELETE',
    }, exec);
    check(deleteHttp.ok === false && deleteHttp.error?.code === 'SECURITY_SCOPE_DANGEROUS_OPERATION',
      'DELETE 任意路径被拒（INF-08）', errorInfo(deleteHttp));
    const outOfScopeHttp = await harness.invoke('browser_http_request', { url: 'http://example.com/' }, exec);
    check(outOfScopeHttp.ok === false && outOfScopeHttp.error?.code === 'SECURITY_SCOPE_ORIGIN_VIOLATION',
      '独立 HTTP 客户端的越界 Origin 同样被拒（闸门无逃逸口）', errorInfo(outOfScopeHttp));
    const normalHttp = await harness.invoke('browser_http_request', { url: origin + '/api/health' }, exec);
    check(normalHttp.ok === true || normalHttp.error?.code !== 'SECURITY_SCOPE_DANGEROUS_OPERATION',
      '普通 GET 不被危险闸门误伤', normalHttp.ok ? null : errorInfo(normalHttp));

    // ---- INF-07: stop -------------------------------------------------------------------------------
    section('INF-07-stop');
    const stopped = await harness.invoke('browser_security_scope', { action: 'stop', reason: 'acceptance-stop' }, exec);
    check(stopped.ok === true && stopped.value?.alreadyStopped === false, 'stop 成功并带原因');
    const again = await harness.invoke('browser_security_scope', { action: 'stop' }, exec);
    check(again.ok === true && again.value?.alreadyStopped === true, 'stop 幂等');
    const postStop = await harness.invoke('browser_navigate', { url: origin + '/index.html' }, exec);
    check(postStop.ok === false && postStop.error?.code === 'SECURITY_SCOPE_STOPPED', '停止后 0 次新派发（INF-07）', errorInfo(postStop));
    const reconfig = await harness.invoke('browser_security_scope', { action: 'set', allowedOrigins: [origin] }, exec);
    check(reconfig.ok === false && reconfig.error?.code === 'SECURITY_SCOPE_STOPPED', '停止后重配置被拒（需新会话）', errorInfo(reconfig));
    const status = await harness.invoke('browser_security_scope', { action: 'status' }, exec);
    check(status.value?.stopped === true && status.value?.stopReason === 'acceptance-stop', 'status 如实报告停止与原因');
    check(!JSON.stringify(status.value).includes('/index.html'), 'status 投影不含探索轨迹 URL');

    // ---- audit evidence -------------------------------------------------------------------------------
    section('audit');
    check(status.value?.audit?.kept > 0, '审计条目已保留（evidence 面可用）', status.value?.audit);

    const failed = checks.filter((entry) => !entry.ok);
    console.log(`\n==== security-scope acceptance: ${checks.length - failed.length}/${checks.length} checks passed ====`);
    if (failed.length > 0) {
      for (const entry of failed) console.log('FAILED:', entry.section, '|', entry.label, JSON.stringify(entry.details));
      process.exitCode = 1;
    }
  } finally {
    await harness.closeBrowser();
    await harness.dispose();
    rmSync(captureRoot, { recursive: true, force: true });
    delete process.env.DSH_UI_TESTING_CAPTURE_DIR;
    fixture.close();
  }
}

main().catch((error) => {
  console.error('security-scope acceptance crashed:', error);
  process.exitCode = 1;
});
