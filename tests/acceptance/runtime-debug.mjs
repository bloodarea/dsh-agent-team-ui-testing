/**
 * runtime-debug.mjs — FR-05 JavaScript runtime analysis acceptance (RT-01..RT-07).
 *
 * Ground truth: a real paused page in the plugin's own headless Chromium against
 * dsh-security-lab. The suite drives a `debugger;` statement (which always pauses once the
 * Debugger domain is armed) and asserts the observable contract:
 *   RT-01 breakpoint bookkeeping (set/resolve/list/remove, hit counts that stay honest)
 *   RT-02 call stack captured with locations and without live handles
 *   RT-03 scope projection is available and redacted
 *   RT-06 the pause timeout forces a resume (the page must never hang)
 *   RT-07 sensitive variable values never appear in any response
 *   RT-05 static-vs-runtime signature comparison; RT-04 pause/request correlation grading
 *
 * Run: node tests/acceptance/runtime-debug.mjs
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

const { createHarness } = await import('./harness.mjs');

async function main() {
  let base = LAB;
  let fixture = null;
  try {
    const health = await fetch(LAB + '/api/health', { signal: AbortSignal.timeout(1500) });
    if (!health.ok) throw new Error('unhealthy');
  } catch {
    const { startFixtureServer } = await import(pathToFileURL(join(REPO_ROOT, 'tests/ui_test_fixture/server.mjs')).href);
    fixture = await startFixtureServer();
    base = fixture.url.replace(/\/$/, '');
    console.log('[env] lab unavailable → fixture', base);
  }

  const harness = await createHarness({ name: 'runtime-debug' });
  const agent = { id: 'rt-acc', session: { header: { cwd: harness.workspaceDir } } };
  const exec = { agent };
  try {
    await harness.invoke('browser_tabs', { action: 'open' }, exec);

    section('RT-01-breakpoints');
    const notArmed = await harness.invoke('browser_script', { action: 'breakpoint', op: 'list' }, exec);
    check(notArmed.ok === false && notArmed.error?.code === 'SCRIPT_NOT_ARMED',
      'RT-01 未 armed 时断点操作被拒（不伪装成空清单）', notArmed.error?.code);
    await harness.invoke('browser_script', { action: 'armed' }, exec);
    await harness.invoke('browser_navigate', { url: base }, exec);
    await new Promise((resolve) => setTimeout(resolve, 1000));

    const emptyList = await harness.invoke('browser_script', { action: 'breakpoint', op: 'list' }, exec);
    check(emptyList.ok === true && Array.isArray(emptyList.value?.breakpoints) && emptyList.value.breakpoints.length === 0,
      '断点清单初始为空');
    check(emptyList.value?.pause?.paused === false, '初始没有暂停');

    // A URL breakpoint must point at a script that is REALLY loaded — use the inventory's own
    // URL instead of guessing. Resolution is an observable fact, and an unresolved URL stays
    // unresolved (that is reported honestly, not hidden).
    const inventory = await harness.invoke('browser_script', { action: 'list' }, exec);
    const loadedScript = (inventory.value?.inventory?.scripts ?? []).find((script) => script.url !== '')
      ?? (inventory.value?.inventory?.scripts ?? [])[0];
    check(loadedScript !== undefined, '清单里存在可用于断点的已加载脚本', inventory.value?.inventory?.counts);
    const bpUrl = loadedScript?.url !== '' ? loadedScript.url : base + '/';
    const set = await harness.invoke('browser_script', {
      action: 'breakpoint', op: 'set', url: bpUrl, lineNumber: 0, columnNumber: 0, label: 'doc-start',
    }, exec);
    check(set.ok === true && typeof set.value?.breakpoint?.cdpBreakpointId === 'string', '断点设置返回 CDP breakpointId');
    check(set.value?.breakpoint?.resolved === true, '断点解析到脚本位置（resolved=true）', {
      url: bpUrl, locations: set.value?.breakpoint?.locations,
    });
    check(set.value?.breakpoint?.label === 'doc-start' && set.value?.breakpoint?.lineNumber === 0, '断点元数据完整');

    const listed = await harness.invoke('browser_script', { action: 'breakpoint', op: 'list' }, exec);
    const bpRow = (listed.value?.breakpoints ?? [])[0];
    check(bpRow?.hitCount === 0, 'RT-01 未命中时 hitCount 如实为 0（不推断为命中过）', bpRow);
    check(bpRow?.resolved === true, '清单保留 resolved 状态');

    const invalid = await harness.invoke('browser_script', { action: 'breakpoint', op: 'set', lineNumber: 3 }, exec);
    check(invalid.ok === false && invalid.error?.code === 'SCRIPT_INVALID_ARGUMENT', '缺 url 的断点被拒');

    // ---- RT-02/RT-03/RT-07: pause, stack, scope redaction --------------------------------
    section('RT-02-stack');
    // `debugger;` always pauses once the domain is armed; the eval stays pending while paused.
    const pausedEval = harness.invoke('browser_eval', {
      expression: '(() => { const sessionToken = "super-secret-session-value"; const label = "ok"; debugger; return label; })()',
    }, exec).catch((error) => ({ error: String(error).slice(0, 120) }));
    await new Promise((resolve) => setTimeout(resolve, 400));

    const stack = await harness.invoke('browser_script', { action: 'stack' }, exec);
    check(stack.value?.paused === true, 'RT-02 页面确实暂停（stack 报告 paused:true）');
    check((stack.value?.callFrames?.length ?? 0) >= 1, `采集到调用栈帧（${stack.value?.callFrames?.length}）`);
    const frame = (stack.value?.callFrames ?? [])[0] ?? {};
    check(typeof frame.scriptId === 'string' && Number.isInteger(frame.lineNumber), '帧带 scriptId 与行号（可回链）');
    check(frame.callFrameId === null, 'RT-07 live callFrameId 不出现在响应里');
    check(stack.value?.reason !== undefined, '暂停原因被记录', stack.value?.reason);

    section('RT-03-scope');
    const scope = await harness.invoke('browser_script', { action: 'scope' }, exec);
    check(scope.ok === true && Array.isArray(scope.value?.scopes), 'RT-03 作用域投影可用');
    check(scope.value?.scopes?.length >= 1, `返回作用域数（${scope.value?.scopes?.length}）`);
    const allVariables = (scope.value?.scopes ?? []).flatMap((entry) => entry.variables ?? []);
    check(allVariables.every((variable) => typeof variable.name === 'string'), '变量项带名称');
    check(allVariables.every((variable) => variable.objectId === undefined || variable.objectId === null),
      'RT-07 变量不带 live objectId');

    section('RT-07-redaction');
    const scopeText = JSON.stringify(scope.value);
    check(!scopeText.includes('super-secret-session-value'), 'RT-07 敏感变量值不出现在响应中（canary 零命中）');
    const sensitiveRows = allVariables.filter((variable) => variable.sensitive === true);
    check(sensitiveRows.every((row) => row.value === null && row.valueOmitted === true),
      'RT-07 敏感变量只回类型与长度', sensitiveRows.map((row) => row.name));

    // ---- RT-06: timeout forces resume -----------------------------------------------------
    section('RT-06-resume');
    // Explicit resume of the current pause.
    const resumed = await harness.invoke('browser_script', { action: 'resume' }, exec);
    check(resumed.ok === true && resumed.value?.wasPaused === true, 'RT-06 显式 resume 恢复暂停');
    const settled = await Promise.race([pausedEval, new Promise((resolve) => setTimeout(() => resolve({ hung: true }), 3000))]);
    check(settled?.hung !== true, 'RT-06 恢复后页面继续执行（挂起的 eval 结算）', settled?.hung ? 'still hung' : null);

    // Timeout path: pause again and let the guard expire, then the page must keep working.
    const secondPause = harness.invoke('browser_eval', { expression: '(() => { debugger; return "settled-after-timeout"; })()' }, exec)
      .catch(() => ({ error: true }));
    await new Promise((resolve) => setTimeout(resolve, 300));
    const whilePaused = await harness.invoke('browser_script', { action: 'stack' }, exec);
    check(whilePaused.value?.paused === true, '再次暂停成功（超时路径前置）');
    await new Promise((resolve) => setTimeout(resolve, 5400)); // beyond DEBUG_LIMITS.pauseTimeoutMs
    const afterTimeout = await harness.invoke('browser_script', { action: 'stack' }, exec);
    check(afterTimeout.value?.paused === false, 'RT-06 超时后守卫判定不再暂停');
    check((afterTimeout.value?.pause?.timeouts ?? 0) >= 1, 'RT-06 超时被记为 timeout（可审计）', afterTimeout.value?.pause);
    const settledAfterTimeout = await Promise.race([secondPause, new Promise((resolve) => setTimeout(() => resolve({ hung: true }), 3000))]);
    check(settledAfterTimeout?.hung !== true, 'RT-06 超时自动 resume 后页面不再挂起', settledAfterTimeout?.hung ? 'still hung' : null);

    // ---- RT-01: breakpoint hit rate ≥90% on a deterministic page --------------------------
    // Measured on the local fixture, whose inline script has REAL line numbers and handlers that
    // actually execute. (The lab's bundle is a single line whose handlers all throw — see DISC-03 —
    // so it cannot be used to measure hit rate honestly.)
    section('RT-01-hit-rate');
    const fixtureModule = await import(pathToFileURL(join(REPO_ROOT, 'tests/ui_test_fixture/server.mjs')).href);
    const hitFixture = await fixtureModule.startFixtureServer();
    try {
      await harness.invoke('browser_navigate', { url: hitFixture.url }, exec);
      await new Promise((resolve) => setTimeout(resolve, 900));

      // Four breakpoints placed on code paths this run ACTUALLY exercises. Two live in the same
      // handler on purpose: the metric is "specified breakpoints that hit", so both must fire.
      const CASES = [
        { label: 'inc-1', line: 106, trigger: { click: 'inc' } },
        { label: 'inc-2', line: 107, trigger: { click: 'inc' } },
        { label: 'fetch-1', line: 116, trigger: { click: 'fetch-btn' } },
        { label: 'fetch-2', line: 117, trigger: { click: 'fetch-btn' } },
      ];
      const placed = [];
      let capturedStack = null;
      for (const testCase of CASES) {
        const setResult = await harness.invoke('browser_script', {
          action: 'breakpoint', op: 'set', url: hitFixture.url,
          lineNumber: testCase.line, columnNumber: 0, label: testCase.label,
        }, exec);
        placed.push({ ...testCase, resolved: setResult.value?.breakpoint?.resolved === true });
      }
      const resolvedCount = placed.filter((entry) => entry.resolved).length;
      check(resolvedCount === placed.length,
        `RT-01 全部 ${placed.length} 个断点解析成功（${resolvedCount}/${placed.length}）`,
        placed.filter((entry) => !entry.resolved).map((entry) => entry.label));

      // Trigger each handler; the page pauses, so capture the stack then resume before the next.
      for (const testCase of placed) {
        const expression = testCase.trigger.fill === true
          ? `(() => { const n = document.getElementById('name'); if (n) n.value = 'probe'; document.getElementById('${testCase.trigger.click}').click(); return 1; })()`
          : `(() => { document.getElementById('${testCase.trigger.click}').click(); return 1; })()`;
        const trigger = harness.invoke('browser_eval', { expression }, exec).catch(() => ({ ok: false }));
        await Promise.race([trigger, new Promise((resolve) => setTimeout(() => resolve({ paused: true }), 2500))]);
        const liveStack = await harness.invoke('browser_script', { action: 'stack' }, exec).catch(() => null);
        if ((liveStack?.value?.callFrames ?? []).length > 0 && capturedStack === null) {
          capturedStack = liveStack.value;
        }
        for (let attempt = 0; attempt < 4; attempt += 1) {
          const paused = await harness.invoke('browser_script', { action: 'resume' }, exec).catch(() => null);
          if (paused?.value?.wasPaused !== true) break;
          await new Promise((resolve) => setTimeout(resolve, 150));
        }
        await new Promise((resolve) => setTimeout(resolve, 200));
      }

      const after = await harness.invoke('browser_script', { action: 'breakpoint', op: 'list' }, exec);
      const allRows = after.value?.breakpoints ?? [];
      const rows = allRows.filter((row) => placed.some((entry) => entry.label === row.label));
      const hit = rows.filter((row) => Number(row.hitCount) > 0);
      const rate = rows.length === 0 ? 0 : hit.length / rows.length;
      console.log(`   断点命中 ${hit.length}/${rows.length} = ${(rate * 100).toFixed(1)}%`);
      check(rows.length === placed.length, `RT-01 本次放置的断点都在清单中（${rows.length}/${placed.length}）`);
      check(rate >= 0.9,
        `RT-01 断点命中率 ${(rate * 100).toFixed(1)}% ≥ 90%`,
        rows.map((row) => ({ label: row.label, hitCount: row.hitCount, resolved: row.resolved })));
      check(rows.some((row) => Number(row.hitCount) > 0), 'RT-01 至少一个断点真实命中（可复现证据）');

      // The call stack captured at a hit must be reviewable (RT-02).
      check(capturedStack !== null && (capturedStack.callFrames ?? []).length > 0,
        'RT-02 命中时能取到可复核的调用栈',
        capturedStack === null ? 'no stack captured' : capturedStack.callFrames?.length);
      await harness.invoke('browser_script', { action: 'resume' }, exec).catch(() => {});

      for (const row of rows) {
        if (!placed.some((entry) => entry.label === row.label)) continue;
        await harness.invoke('browser_script', { action: 'breakpoint', op: 'remove', cdpBreakpointId: row.cdpBreakpointId }, exec);
      }
    } finally {
      // Drain any remaining pause, then restore a live work page BEFORE shutting the fixture down:
      // leaving the tab on a closed fixture retires it and every later call gets TARGET_NOT_FOUND.
      for (let attempt = 0; attempt < 4; attempt += 1) {
        const paused = await harness.invoke('browser_script', { action: 'resume' }, exec).catch(() => null);
        if (paused?.value?.wasPaused !== true) break;
      }
      await harness.invoke('browser_navigate', { url: base }, exec).catch(() => {});
      const restored = await harness.invoke('browser_state', {}, exec).catch(() => null);
      if (restored?.value?.running !== true) {
        await harness.invoke('browser_tabs', { action: 'open' }, exec).catch(() => {});
        await harness.invoke('browser_navigate', { url: base }, exec).catch(() => {});
      }
      hitFixture.close();
    }

    // ---- RT-04/RT-05: correlation + signature verification -------------------------------
    section('RT-04-correlate');
    const correlate = await harness.invoke('browser_script', { action: 'correlate', limit: 5 }, exec);
    check(correlate.ok === true && Array.isArray(correlate.value?.correlations), 'RT-04 关联动作可用',
      { code: correlate.error?.code, message: String(correlate.error?.message ?? '').slice(0, 120) });
    for (const row of correlate.value?.correlations ?? []) {
      check([null, 'confirmed', 'likely', 'possible'].includes(row.grade),
        `关联等级合法（${row.grade ?? 'null'} / ${row.basis ?? '-'}）`, row);
    }

    section('RT-05-verify');
    const verify = await harness.invoke('browser_script', {
      action: 'verify',
      expected: { salt: 'lab-client-salt-2026', order: 'salt|ts|user', signature: 'abcdef' },
      observed: { salt: 'lab-client-salt-2026', order: 'salt|ts|user', signature: 'abcdef' },
    }, exec);
    check(verify.ok === true && verify.value?.consistent === true, 'RT-05 完全一致时 consistent=true');
    check(verify.value?.rate === 1, 'RT-05 一致率 1');
    const signatureRow = (verify.value?.comparisons ?? []).find((row) => row.name === 'signature');
    check(signatureRow?.sensitive === true && signatureRow?.expected === 'string:6',
      'RT-05/RT-07 敏感字段只比形态，不回显值', signatureRow);
    const missing = await harness.invoke('browser_script', {
      action: 'verify', expected: { a: '1', b: '2' }, observed: { a: '1' },
    }, exec);
    check(missing.value?.missing === 1 && missing.value?.comparable === 1, 'RT-05 缺失项单列，不算一致');
    const badVerify = await harness.invoke('browser_script', { action: 'verify', expected: { a: 1 } }, exec);
    check(badVerify.ok === false && badVerify.error?.code === 'SCRIPT_INVALID_ARGUMENT', 'verify 缺 observed 被拒');

    // ---- cleanup: remove the breakpoint ---------------------------------------------------
    section('RT-01-remove');
    const removed = await harness.invoke('browser_script', { action: 'breakpoint', op: 'remove', label: 'doc-start' }, exec);
    check(removed.ok === true && removed.value?.removed?.cdpBreakpointId === set.value?.breakpoint?.cdpBreakpointId,
      '按 label 移除断点');
    const finalList = await harness.invoke('browser_script', { action: 'breakpoint', op: 'list' }, exec);
    check((finalList.value?.breakpoints ?? []).length === 0, '移除后清单为空');

    const failed = checks.filter((entry) => !entry.ok);
    console.log(`\n==== runtime-debug acceptance: ${checks.length - failed.length}/${checks.length} checks passed ====`);
    if (failed.length > 0) {
      for (const entry of failed) console.log('FAILED:', entry.section, '|', entry.label, JSON.stringify(entry.details).slice(0, 400));
      process.exitCode = 1;
    }
  } finally {
    // Never leave the page paused on the way out.
    try { await harness.invoke('browser_script', { action: 'resume' }, exec); } catch { /* already resumed */ }
    await harness.closeBrowser();
    await harness.dispose();
    fixture?.close();
  }
}

main().catch((error) => {
  console.error('runtime-debug acceptance crashed:', error);
  process.exitCode = 1;
});
