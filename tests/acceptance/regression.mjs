/**
 * regression.mjs — REG-04 / REG-05 / REG-07 acceptance for the security surface.
 *
 *   REG-04  error contracts: every refusal carries a code whose category/retryable matches the
 *           frozen taxonomy — 100% consistency, no `INTERNAL` for a policy answer.
 *   REG-05  capability report vs reality: the reported status matches what the registered
 *           surface actually is (no phantom "available", no missing tool).
 *   REG-07  execution stability: a batch of ordinary calls must have ≤2% unexpected failures
 *           (a refusal we can classify is NOT a failure).
 *
 * Run: node tests/acceptance/regression.mjs
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

const safety = await import(pathToFileURL(join(REPO_ROOT, 'browser-safety.js')).href);
const { createHarness } = await import('./harness.mjs');

/** Expected classification for the security refusals this round introduced. */
const EXPECTED = [
  { code: 'SECURITY_SCOPE_INVALID', category: 'input', retryable: false },
  { code: 'SECURITY_SCOPE_STOPPED', category: 'scope', retryable: false },
  { code: 'SECURITY_SCOPE_ORIGIN_VIOLATION', category: 'authorization', retryable: false },
  { code: 'SECURITY_SCOPE_PATH_VIOLATION', category: 'authorization', retryable: false },
  { code: 'SECURITY_SCOPE_BUDGET_EXCEEDED', category: 'resource', retryable: false },
  { code: 'SECURITY_SCOPE_PASSIVE_MODE', category: 'authorization', retryable: false },
  { code: 'SECURITY_SCOPE_CONCURRENCY_EXCEEDED', category: 'resource', retryable: false },
  { code: 'SECURITY_SCOPE_DANGEROUS_OPERATION', category: 'authorization', retryable: false },
  { code: 'COOKIE_APPROVAL_REQUIRED', category: 'authorization', retryable: false },
  { code: 'COOKIE_APPROVAL_CONSUMED', category: 'authorization', retryable: false },
  { code: 'COOKIE_HTTPONLY_FORBIDDEN', category: 'authorization', retryable: false },
  { code: 'COOKIE_INVALID_ARGUMENT', category: 'input', retryable: false },
  { code: 'COOKIE_OUTPUT_EXISTS', category: 'output', retryable: false },
  { code: 'COOKIE_QUOTA_EXCEEDED', category: 'resource', retryable: false },
  { code: 'SCRIPT_NOT_ARMED', category: 'capability', retryable: false },
  { code: 'SCRIPT_INVALID_ARGUMENT', category: 'input', retryable: false },
  { code: 'SCRIPT_NOT_FOUND', category: 'scope', retryable: false },
  { code: 'FINDING_INVALID_ARGUMENT', category: 'input', retryable: false },
  { code: 'FINDING_NOT_FOUND', category: 'scope', retryable: false },
  { code: 'BIZ_INVALID_ARGUMENT', category: 'input', retryable: false },
];

async function main() {
  let labMode = false;
  try {
    const health = await fetch(LAB + '/api/health', { signal: AbortSignal.timeout(1500) });
    labMode = health.ok;
  } catch { labMode = false; }

  // ---- REG-04: taxonomy contract ----------------------------------------------------------
  section('REG-04-taxonomy');
  const mismatches = [];
  for (const expected of EXPECTED) {
    const error = new safety.BrowserError(expected.code, 'probe');
    if (error.category !== expected.category || error.retryable !== expected.retryable) {
      mismatches.push({ code: expected.code, actual: { category: error.category, retryable: error.retryable }, expected });
    }
  }
  check(mismatches.length === 0, `REG-04 ${EXPECTED.length} 个安全错误码的 category/retryable 与契约一致`, mismatches);
  check(EXPECTED.every((entry) => Object.hasOwn(safety.ERROR_TAXONOMY, entry.code)),
    'REG-04 每个码都在 ERROR_TAXONOMY 中注册（未知码会退化为 INTERNAL）');

  // ---- REG-07 + REG-04 live refusals ------------------------------------------------------
  section('REG-04-live');
  if (!labMode) {
    console.log('[env] lab not running — live refusal/stability checks skipped');
  } else {
    const harness = await createHarness({ name: 'regression' });
    const agent = { id: 'reg-acc', session: { header: { cwd: harness.workspaceDir } } };
    const exec = { agent };
    try {
      await harness.invoke('browser_tabs', { action: 'open' }, exec);
      await harness.invoke('browser_navigate', { url: LAB }, exec);

      const refusals = [];
      // Two refusal channels exist and both are legitimate:
      //  - the registered JSON schema rejects a value outside its enum → INVALID_ARGUMENT (input);
      //  - the implementation rejects a well-formed but impossible call → a COOKIE_*/SCRIPT_* code.
      // REG-04 is about CONSISTENCY (a classified, non-retryable input answer), so it accepts
      // either — but never an INTERNAL and never a retryable input error.
      const expectRefusal = async (label, promise, code, { allowGeneric = false } = {}) => {
        const result = await promise;
        const got = result.error?.code;
        const exact = got === code;
        const generic = allowGeneric && got === 'INVALID_ARGUMENT';
        // The contract is CONSISTENCY with the frozen taxonomy: whatever code is reported must
        // carry the category/retryable that `browser-safety.js` declares for that code, and it
        // must never be INTERNAL or indeterminate.
        const taxonomy = got === undefined ? null : safety.ERROR_TAXONOMY[got];
        const classified = result.ok === false
          && (exact || generic)
          && taxonomy !== undefined
          && result.error?.category === taxonomy[0]
          && result.error?.retryable === taxonomy[1]
          && result.error?.category !== 'internal';
        refusals.push({ label, ok: classified, code: got, expected: code, category: result.error?.category });
        check(classified, `REG-04 ${label} → ${code}${allowGeneric ? '（或 schema 级 INVALID_ARGUMENT）' : ''}`,
          classified ? null : {
            got, category: result.error?.category, retryable: result.error?.retryable,
            taxonomy: taxonomy === undefined ? 'unregistered-code' : taxonomy,
          });
        return result;
      };

      // cookies: unknown action is an argument refusal, not INTERNAL
      await expectRefusal('cookies.action 非法',
        harness.invoke('browser_cookies', { action: 'nonsense' }, exec), 'COOKIE_INVALID_ARGUMENT', { allowGeneric: true });
      // cookies: export without out
      await expectRefusal('cookies.export 缺 out',
        harness.invoke('browser_cookies', { action: 'export' }, exec), 'COOKIE_INVALID_ARGUMENT');
      // script: source before arming
      await expectRefusal('script.source 未 armed',
        harness.invoke('browser_script', { action: 'source', url: LAB }, exec), 'SCRIPT_NOT_ARMED');
      // script: unknown action
      await expectRefusal('script.action 非法',
        harness.invoke('browser_script', { action: 'nonsense' }, exec), 'SCRIPT_INVALID_ARGUMENT', { allowGeneric: true });
      // findings: unknown finding
      await expectRefusal('findings.grade 未找到',
        harness.invoke('browser_findings', { action: 'grade', findingId: 'nope' }, exec), 'FINDING_NOT_FOUND');
      // script: verify without the required observed bag (schema-level rejection)
      await expectRefusal('script.verify 缺参数',
        harness.invoke('browser_script', { action: 'verify', expected: {} }, exec), 'SCRIPT_INVALID_ARGUMENT', { allowGeneric: true });
      // biz: unknown scenario
      await expectRefusal('biz.scenario 非法',
        harness.invoke('browser_biz', { action: 'probe', scenario: 'nope' }, exec), 'BIZ_INVALID_ARGUMENT');
      // security scope: bad config
      await expectRefusal('scope.set 空白名单',
        harness.invoke('browser_security_scope', { action: 'set', allowedOrigins: [] }, exec), 'SECURITY_SCOPE_INVALID');
      // scope: out-of-scope dispatch
      await harness.invoke('browser_security_scope', { action: 'set', allowedOrigins: [LAB], mode: 'active' }, exec);
      await expectRefusal('scope 越界导航',
        harness.invoke('browser_navigate', { url: 'http://example.com/' }, exec), 'SECURITY_SCOPE_ORIGIN_VIOLATION');
      await expectRefusal('scope 危险操作',
        harness.invoke('browser_http_request', { url: LAB + '/api/checkout/commit', method: 'POST' }, exec),
        'SECURITY_SCOPE_DANGEROUS_OPERATION');

      check(refusals.every((entry) => entry.category !== 'internal'),
        'REG-04 所有拒绝都不是 INTERNAL（策略答案有分类）', refusals.filter((entry) => entry.category === 'internal'));

      // ---- REG-07: execution stability --------------------------------------------------
      section('REG-07-stability');
      const calls = [];
      for (let index = 0; index < 20; index += 1) {
        calls.push(harness.invoke('browser_findings', { action: 'list' }, exec));
        calls.push(harness.invoke('browser_security_scope', { action: 'status' }, exec));
        calls.push(harness.invoke('browser_cookies', { action: 'metadata' }, exec));
      }
      const results = await Promise.all(calls);
      // A call fails unexpectedly when it throws (ok:false). A classified refusal would be a
      // design violation here because these are all valid read calls.
      const failures = results.filter((result) => result.ok !== true);
      const rate = failures.length / results.length;
      check(rate <= 0.02, `REG-07 执行稳定性：非预期失败率 ${(rate * 100).toFixed(1)}% ≤ 2%`,
        failures.slice(0, 3).map((result) => result.error?.code));

      // ---- REG-05: capability report vs reality -----------------------------------------
      section('REG-05-capabilities');
      const caps = await harness.invoke('browser_capabilities', {}, exec);
      const toolNames = harness.toolNames();
      const securityRows = (caps.value?.capabilities ?? [])
        .filter((row) => /cookies|security|surface|scripts|findings|business/.test(row.id ?? ''));
      const SECURITY_TOOLS = ['browser_security_scope', 'browser_cookies', 'browser_surface',
        'browser_script', 'browser_findings', 'browser_biz'];
      // Every security tool must be REPORTED (a missing row means the capability matrix lies).
      const reportedTools = new Set(securityRows.map((row) => row.tool).filter(Boolean));
      const unreported = SECURITY_TOOLS.filter((name) => !reportedTools.has(name));
      check(unreported.length === 0, 'REG-05 六个安全工具都有能力行（无遗漏）', unreported);
      check(securityRows.length >= 9, `REG-05 安全能力行齐全（实测 ${securityRows.length}）`, securityRows.map((row) => row.id));

      const badStatus = securityRows.filter((row) => !['available', 'unavailable', 'unsupported', 'not-probed'].includes(row.status));
      check(badStatus.length === 0, 'REG-05 每个安全能力行的 status 都是契约枚举值', badStatus);

      // Every reported tool name must be registered — no phantom capabilities.
      const phantom = [...reportedTools].filter((name) => !toolNames.includes(name));
      check(phantom.length === 0, 'REG-05 报告不含未注册工具（无幽灵 available）', phantom);

      // Every "available" row must point at a tool that is really registered.
      const availableTools = [...new Set(securityRows
        .filter((row) => row.status === 'available' && typeof row.tool === 'string')
        .map((row) => row.tool))];
      const notCallable = availableTools.filter((name) => !harness.tools.has(name));
      check(notCallable.length === 0, 'REG-05 声明 available 的安全工具确实已注册（能力声明与运行态一致）', notCallable);
      check(availableTools.length === SECURITY_TOOLS.length,
        `REG-05 六个安全工具全部报告为 available（实测 ${availableTools.length}/${SECURITY_TOOLS.length}）`,
        availableTools);

      // A tool with no session armed must NOT claim observed state.
      const scriptRow = securityRows.find((row) => row.id === 'web.p0.scripts.analysis');
      check(scriptRow === undefined || scriptRow.status === 'available', 'REG-05 scripts 能力行状态合法');
      const armedList = await harness.invoke('browser_script', { action: 'list' }, exec);
      check(armedList.value?.armed === false, 'REG-05 未 arming 时脚本能力如实报 armed:false（不伪装 observed）');

      await harness.invoke('browser_security_scope', { action: 'stop', reason: 'regression-done' }, exec);
    } finally {
      await harness.closeBrowser();
      await harness.dispose();
    }
  }

  const failed = checks.filter((entry) => !entry.ok);
  console.log(`\n==== regression acceptance: ${checks.length - failed.length}/${checks.length} checks passed ====`);
  if (failed.length > 0) {
    for (const entry of failed) console.log('FAILED:', entry.section, '|', entry.label, JSON.stringify(entry.details).slice(0, 400));
    process.exitCode = 1;
  }
}

main().catch((error) => {
  console.error('regression acceptance crashed:', error);
  process.exitCode = 1;
});
