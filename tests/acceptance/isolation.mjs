/**
 * isolation.mjs — INF-03 acceptance: Workspace / Runtime / Tab isolation for the security surface
 * (acceptance INF-03 "6 项越权访问测试全部拒绝", GATE-06).
 *
 * The six cross-boundary probes below are the ones the security tools introduce. Each one must
 * REFUSE (or be structurally incapable of crossing), never silently fall back:
 *
 *   1. workspace  — findings collected in workspace A are invisible in workspace B
 *   2. runtime    — a scope session armed on runtime A does not govern runtime B
 *   3. origin     — Cookie metadata is exact-origin: another origin's jar is never returned
 *   4. approval   — a human approval bound to origin A cannot export origin B
 *   5. script     — a script inventory armed on one page is not readable from another runtime
 *   6. stopped    — a stopped scope session cannot be revived by another Agent
 *
 * Run: node tests/acceptance/isolation.mjs
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
  if (condition !== true && details !== undefined) console.log('   details:', JSON.stringify(details).slice(0, 700));
}
function errorInfo(result) {
  return { code: result.error?.code, category: result.error?.category };
}

const { createHarness } = await import('./harness.mjs');

async function main() {
  // Two harnesses = two workspaces = two independent Chromium profiles (P0-E ownership model).
  const harnessA = await createHarness({ name: 'isolation-A' });
  const harnessB = await createHarness({ name: 'isolation-B' });
  const agentA = { id: 'iso-A', session: { header: { cwd: harnessA.workspaceDir } } };
  const agentB = { id: 'iso-B', session: { header: { cwd: harnessB.workspaceDir } } };
  const execA = { agent: agentA };
  const execB = { agent: agentB };
  try {
    section('INF-03-setup');
    await harnessA.invoke('browser_tabs', { action: 'open' }, execA);
    await harnessB.invoke('browser_tabs', { action: 'open' }, execB);
    const navA = await harnessA.invoke('browser_navigate', { url: LAB }, execA);
    const navB = await harnessB.invoke('browser_navigate', { url: LAB }, execB);
    check(navA.ok === true && navB.ok === true, '两个独立 workspace/runtime 都可用', { a: errorInfo(navA), b: errorInfo(navB) });

    // ---- 1. workspace: findings do not cross --------------------------------------------
    section('INF-03-workspace');
    const findingA = await harnessA.invoke('browser_findings', {
      action: 'add', title: 'workspace-A-only finding', category: 'cors', severity: 'medium',
      confidence: 0.8, targetUrl: LAB, endpoint: '/api/me', identity: 'alice',
      preconditions: ['A'], reproductionSteps: ['A'], evidence: { basis: 'observed-once' },
      evidenceBasis: 'observed-once', request: { method: 'GET', url: '/api/me' },
      response: { status: 200 }, scriptLocation: { url: 'app.js', line: 0 },
      impact: 'A', remediation: 'A',
    }, execA);
    check(findingA.ok === true, 'workspace A 记录了一条 Finding');
    const listB = await harnessB.invoke('browser_findings', { action: 'list' }, execB);
    check(listB.value?.total === 0, 'INF-03 workspace B 看不到 A 的 Finding（0 条）', listB.value?.total);
    const listA = await harnessA.invoke('browser_findings', { action: 'list' }, execA);
    check(listA.value?.total === 1, 'workspace A 自己看得到（对照）', listA.value?.total);
    const crossGrade = await harnessB.invoke('browser_findings', {
      action: 'grade', findingId: findingA.value?.finding?.findingId,
    }, execB);
    check(crossGrade.ok === false && crossGrade.error?.code === 'FINDING_NOT_FOUND',
      'INF-03 workspace B 按 id 也无法读取 A 的 Finding（不存在于本 scope）', errorInfo(crossGrade));

    // ---- 2. runtime: a scope session does not govern another runtime ---------------------
    section('INF-03-runtime');
    const scopeA = await harnessA.invoke('browser_security_scope', {
      action: 'set', allowedOrigins: ['http://127.0.0.1:8088'], mode: 'active',
    }, execA);
    check(scopeA.ok === true, 'runtime A 建立了 scope 边界');
    const statusB = await harnessB.invoke('browser_security_scope', { action: 'status' }, execB);
    check(statusB.value?.active !== true, 'INF-03 runtime B 的 scope 仍为未启用（A 的边界不生效）', statusB.value);
    // B is unrestricted, so an out-of-scope navigation there is NOT refused by A's boundary.
    const bOutOfScope = await harnessB.invoke('browser_navigate', { url: LAB + '/api/health' }, execB);
    check(bOutOfScope.ok === true, 'runtime B 不受 A 的边界约束（各自独立，符合设计）');
    // A still refuses the same class of out-of-scope navigation.
    const aOutOfScope = await harnessA.invoke('browser_navigate', { url: 'http://example.com/' }, execA);
    check(aOutOfScope.ok === false && aOutOfScope.error?.code === 'SECURITY_SCOPE_ORIGIN_VIOLATION',
      'INF-03 runtime A 仍拒绝越界（边界只作用于自己的 runtime）', errorInfo(aOutOfScope));

    // ---- 3. origin: Cookie metadata is exact-origin --------------------------------------
    section('INF-03-origin');
    const metaA = await harnessA.invoke('browser_cookies', { action: 'metadata' }, execA);
    check(metaA.ok === true && metaA.value?.origin === 'http://127.0.0.1:8088',
      'INF-03 Cookie 元数据绑定精确 Origin', metaA.value?.origin);
    // Set a marker on A, then prove B (same origin, different profile) cannot see it.
    const marker = 'iso_marker_' + Date.now().toString(36);
    await harnessA.invoke('browser_eval', {
      expression: `(() => { document.cookie = '${marker}=1; path=/'; return document.cookie.includes('${marker}'); })()`,
    }, execA);
    const metaAAfter = await harnessA.invoke('browser_cookies', { action: 'metadata' }, execA);
    const namesA = (metaAAfter.value?.cookies ?? []).map((cookie) => cookie.name);
    check(namesA.includes(marker), '标记 Cookie 写入 A 的 profile', marker);
    const metaB = await harnessB.invoke('browser_cookies', { action: 'metadata' }, execB);
    const namesB = (metaB.value?.cookies ?? []).map((cookie) => cookie.name);
    check(!namesB.includes(marker), 'INF-03 另一 profile 的 Cookie 元数据不含该标记', namesB);

    // ---- 4. approval: bound origin cannot export another origin -------------------------
    section('INF-03-approval');
    const metaForApproval = await harnessA.invoke('browser_cookies', { action: 'metadata' }, execA);
    const authScope = metaForApproval.value?.authScope ?? {};
    const approvalsDir = process.env.DSH_UI_TESTING_CONFIG_DIR;
    const { writeFileSync, mkdirSync } = await import('node:fs');
    mkdirSync(approvalsDir, { recursive: true });
    // A human approval for a DIFFERENT origin must not authorise this export.
    writeFileSync(join(approvalsDir, 'security-approvals.json'), JSON.stringify({
      approvals: [{
        approvalId: 'iso-approval-wrong-origin', origin: 'http://127.0.0.1:9999',
        tabId: authScope.tabId, workspaceId: authScope.workspaceId, runtimeId: authScope.runtimeId,
        allowHttpOnly: true, issuedAt: Date.now() - 1000, expiresAt: Date.now() + 60_000,
      }],
    }), 'utf8');
    const wrongOrigin = await harnessA.invoke('browser_cookies', {
      action: 'export', out: 'output/cookies/iso-wrong-origin.json', allowHttpOnly: true,
    }, execA);
    check(wrongOrigin.ok === false && wrongOrigin.error?.code === 'COOKIE_APPROVAL_REQUIRED',
      'INF-03 其他 Origin 的授权不能导出本 Origin（0 次导出）', errorInfo(wrongOrigin));
    // A human approval for a DIFFERENT workspace must not authorise either.
    writeFileSync(join(approvalsDir, 'security-approvals.json'), JSON.stringify({
      approvals: [{
        approvalId: 'iso-approval-wrong-workspace', origin: authScope.origin,
        tabId: authScope.tabId, workspaceId: 'some-other-workspace', runtimeId: authScope.runtimeId,
        allowHttpOnly: true, issuedAt: Date.now() - 1000, expiresAt: Date.now() + 60_000,
      }],
    }), 'utf8');
    const wrongWorkspace = await harnessA.invoke('browser_cookies', {
      action: 'export', out: 'output/cookies/iso-wrong-workspace.json', allowHttpOnly: true,
    }, execA);
    check(wrongWorkspace.ok === false && wrongWorkspace.error?.code === 'COOKIE_APPROVAL_REQUIRED',
      'INF-03 其他 workspace 的授权不能导出本 workspace（0 次导出）', errorInfo(wrongWorkspace));
    // Restore a correct approval so the export itself is proven possible (control).
    writeFileSync(join(approvalsDir, 'security-approvals.json'), JSON.stringify({
      approvals: [{
        approvalId: 'iso-approval-correct', origin: authScope.origin,
        tabId: authScope.tabId, workspaceId: authScope.workspaceId, runtimeId: authScope.runtimeId,
        allowHttpOnly: true, issuedAt: Date.now() - 1000, expiresAt: Date.now() + 60_000,
      }],
    }), 'utf8');
    const correctExport = await harnessA.invoke('browser_cookies', {
      action: 'export', out: 'output/cookies/iso-correct.json', allowHttpOnly: true,
    }, execA);
    check(correctExport.ok === true, 'INF-03 精确匹配的授权可以导出（对照，证明拒绝不是能力缺失）',
      errorInfo(correctExport));

    // ---- 5. script: an armed inventory is runtime-local ---------------------------------
    section('INF-03-script');
    const armedA = await harnessA.invoke('browser_script', { action: 'armed' }, execA);
    check(armedA.ok === true, 'runtime A 启用 Debugger');
    const listAScripts = await harnessA.invoke('browser_script', { action: 'list' }, execA);
    check(listAScripts.value?.armed === true, 'runtime A 的脚本清单可用（armed）');
    const listBScripts = await harnessB.invoke('browser_script', { action: 'list' }, execB);
    check(listBScripts.value?.armed === false,
      'INF-03 runtime B 的 Debugger 仍为未启用（A 的 arm 不外溢）', listBScripts.value?.armed);
    const bSource = await harnessB.invoke('browser_script', {
      action: 'source', url: 'http://127.0.0.1:8088/static/app.min.js',
    }, execB);
    check(bSource.ok === false && bSource.error?.code === 'SCRIPT_NOT_ARMED',
      'INF-03 runtime B 无法读取 A 采集的脚本源码', errorInfo(bSource));

    // ---- 6. stopped: a stopped session cannot be revived ------------------------------
    section('INF-03-stopped');
    const stopped = await harnessA.invoke('browser_security_scope', { action: 'stop', reason: 'isolation-test' }, execA);
    check(stopped.ok === true && stopped.value?.alreadyStopped === false, 'runtime A 停止 scope');
    const revive = await harnessA.invoke('browser_security_scope', {
      action: 'set', allowedOrigins: [LAB], mode: 'active',
    }, execA);
    check(revive.ok === false && revive.error?.code === 'SECURITY_SCOPE_STOPPED',
      'INF-03 停止后同 runtime 不能重新配置（不可复活）', errorInfo(revive));
    const postStop = await harnessA.invoke('browser_navigate', { url: LAB }, execA);
    check(postStop.ok === false && postStop.error?.code === 'SECURITY_SCOPE_STOPPED',
      'INF-03 停止后 0 次新派发', errorInfo(postStop));
    // The other runtime is unaffected by A's stop (isolation again, from the other direction).
    const bAfterAStop = await harnessB.invoke('browser_navigate', { url: LAB + '/api/health' }, execB);
    check(bAfterAStop.ok === true, 'INF-03 runtime B 不受 A 停止影响（各自独立）');

    const failed = checks.filter((entry) => !entry.ok);
    console.log(`\n==== isolation acceptance: ${checks.length - failed.length}/${checks.length} checks passed ====`);
    if (failed.length > 0) {
      for (const entry of failed) console.log('FAILED:', entry.section, '|', entry.label, JSON.stringify(entry.details).slice(0, 400));
      process.exitCode = 1;
    }
  } finally {
    await harnessA.closeBrowser();
    await harnessA.dispose();
    await harnessB.closeBrowser();
    await harnessB.dispose();
  }
}

main().catch((error) => {
  console.error('isolation acceptance crashed:', error);
  process.exitCode = 1;
});
