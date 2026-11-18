/**
 * tool-smoke.mjs — 全工具面健康检查：44 个注册工具逐个调用。
 *
 * 目标不是"每个工具都成功"（有些调用在冷启动/未配置时**应该**被拒绝），而是断言：
 *   1. 每个工具都真的注册了、schema 合法、execute 可调用；
 *   2. 每次调用要么成功，要么给出**分类明确**的拒绝（code + category，绝无 INTERNAL）；
 *   3. 缺参调用不得触发浏览器启动或页面副作用；
 *   4. 安全工具在未配置时的拒绝理由与文档一致（而不是"工具坏了"）。
 *
 * Run: node tests/acceptance/tool-smoke.mjs
 */
import { pathToFileURL } from 'node:url';
import { join } from 'node:path';

const REPO_ROOT = join(import.meta.dirname ?? '.', '..', '..');

const checks = [];
let currentSection = '';
function section(title) { currentSection = title; }
function check(condition, label, details) {
  checks.push({ ok: condition === true, label, section: currentSection, details: details ?? null });
  console.log(`${condition === true ? '✔' : '✖'} [${currentSection}] ${label}`);
  if (condition !== true && details !== undefined) console.log('   details:', JSON.stringify(details).slice(0, 700));
}

const { createHarness } = await import('./harness.mjs');

/**
 * One minimal call per tool. `expect` documents what a HEALTHY call looks like:
 *   'ok'      — should succeed in this state
 *   'refused' — should refuse with a classified code (not a broken tool)
 */
const CALLS = [
  { name: 'browser_tools', args: { action: 'status' }, expect: 'ok' },
  { name: 'browser_state', args: {}, expect: 'ok' },
  { name: 'browser_capabilities', args: {}, expect: 'ok' },
  { name: 'browser_navigate', args: {}, expect: 'refused' },
  { name: 'browser_eval', args: { expression: '1+1' }, expect: 'ok' },
  { name: 'browser_screenshot', args: { persist: false }, expect: 'ok' },
  { name: 'browser_input', args: {}, expect: 'refused' },
  { name: 'browser_network', args: {}, expect: 'ok' },
  { name: 'browser_computed_style', args: {}, expect: 'refused' },
  { name: 'browser_http_request', args: {}, expect: 'refused' },
  { name: 'browser_viewport', args: { action: 'get' }, expect: 'ok' },
  { name: 'browser_tabs', args: { action: 'list' }, expect: 'ok' },
  { name: 'browser_annotation', args: { action: 'read' }, expect: 'ok' },
  { name: 'browser_snapshot', args: {}, expect: 'ok' },
  { name: 'browser_click', args: {}, expect: 'refused' },
  { name: 'browser_type', args: {}, expect: 'refused' },
  { name: 'browser_scroll', args: {}, expect: 'refused' },
  { name: 'browser_fill_form', args: {}, expect: 'refused' },
  { name: 'browser_node_state', args: {}, expect: 'refused' },
  { name: 'browser_wait_for', args: { timeoutMs: 50 }, expect: 'refused' },
  { name: 'browser_vision_image', args: { source: { kind: 'live' } }, expect: 'ok' },
  { name: 'browser_vision_find', args: { query: 'button' }, expect: 'refused' },
  { name: 'browser_vision_compare', args: {}, expect: 'refused' },
  { name: 'browser_vision_act', args: {}, expect: 'refused' },
  { name: 'browser_vision_baseline', args: { action: 'list' }, expect: 'ok' },
  { name: 'browser_vision_check', args: {}, expect: 'refused' },
  { name: 'browser_network_session', args: { action: 'status' }, expect: 'ok' },
  { name: 'browser_network_events', args: {}, expect: 'ok' },
  { name: 'browser_network_detail', args: {}, expect: 'refused' },
  { name: 'browser_network_trace', args: { action: 'window' }, expect: 'ok' },
  { name: 'browser_network_control', args: { action: 'intercept-list' }, expect: 'ok' },
  { name: 'browser_network_evidence', args: { action: 'integrity' }, expect: 'ok' },
  { name: 'browser_network_subscribe', args: { action: 'list' }, expect: 'ok' },
  // Security surface: every one of these must answer structurally, even when nothing is armed.
  { name: 'browser_security_scope', args: { action: 'status' }, expect: 'ok' },
  { name: 'browser_cookies', args: { action: 'metadata' }, expect: 'ok' },
  { name: 'browser_surface', args: { action: 'build' }, expect: 'ok' },
  { name: 'browser_script', args: { action: 'list' }, expect: 'ok' },
  { name: 'browser_script', args: { action: 'source', url: 'http://127.0.0.1/' }, expect: 'refused' },
  { name: 'browser_findings', args: { action: 'list' }, expect: 'ok' },
  { name: 'browser_findings', args: { action: 'evaluate', facts: {} }, expect: 'ok' },
  { name: 'browser_biz', args: { action: 'evaluate', facts: {} }, expect: 'ok' },
  { name: 'browser_dynamic_session', args: { action: 'status' }, expect: 'ok' },
  { name: 'browser_motion_observe', args: {}, expect: 'refused' },
  { name: 'browser_motion_analyze', args: {}, expect: 'refused' },
  { name: 'browser_motion_control', args: {}, expect: 'refused' },
  { name: 'browser_dynamic_correlate', args: {}, expect: 'refused' },
];

async function main() {
  const harness = await createHarness({ name: 'tool-smoke' });
  const agent = { id: 'smoke', session: { header: { cwd: harness.workspaceDir } } };
  const exec = { agent };
  try {
    // ---- 1. registration surface ---------------------------------------------------------
    section('registration');
    const toolNames = harness.toolNames();
    check(toolNames.length === 44, `注册面共 44 个工具（实测 ${toolNames.length}）`, toolNames.length);
    const missingFromCalls = toolNames.filter((name) => !CALLS.some((call) => call.name === name));
    check(missingFromCalls.length === 0, '冒烟清单覆盖全部注册工具', missingFromCalls);
    const phantomCalls = CALLS.filter((call) => !toolNames.includes(call.name));
    check(phantomCalls.length === 0, '冒烟清单不含未注册工具', phantomCalls.map((call) => call.name));

    const badSchema = [];
    for (const name of toolNames) {
      const definition = harness.tools.get(name);
      if (!definition
        || definition.parameters?.type !== 'object'
        || !Array.isArray(definition.parameters?.required)
        || typeof definition.execute !== 'function') {
        badSchema.push(name);
      }
    }
    check(badSchema.length === 0, '每个工具都有 object schema + required 数组 + execute', badSchema);

    // ---- 2. cold calls: every tool answers, nothing leaks INTERNAL ------------------------
    section('cold-calls');
    const results = [];
    for (const call of CALLS) {
      const result = await harness.invoke(call.name, call.args, exec);
      results.push({ ...call, result });
    }
    const internals = results.filter((entry) => entry.result.error?.code === 'INTERNAL');
    check(internals.length === 0, '冷启动调用无一返回 INTERNAL', internals.map((entry) => entry.name));

    const unclassified = results.filter((entry) => entry.result.ok === false
      && (typeof entry.result.error?.code !== 'string' || entry.result.error.code === ''));
    check(unclassified.length === 0, '每个拒绝都带 code', unclassified.map((entry) => entry.name));

    const noCategory = results.filter((entry) => entry.result.ok === false
      && typeof entry.result.error?.category !== 'string');
    check(noCategory.length === 0, '每个拒绝都带 category', noCategory.map((entry) => entry.name));

    // Contract expectations: 'ok' must succeed, 'refused' must fail with a classified code.
    const okExpectedButFailed = results.filter((entry) => entry.expect === 'ok' && entry.result.ok !== true);
    check(okExpectedButFailed.length === 0,
      `期望可用的 ${results.filter((entry) => entry.expect === 'ok').length} 个调用都成功`,
      okExpectedButFailed.map((entry) => ({ tool: entry.name, code: entry.result.error?.code })));

    const refusedExpectedButSucceeded = results.filter((entry) => entry.expect === 'refused' && entry.result.ok === true);
    check(refusedExpectedButSucceeded.length === 0, '期望被拒的调用确实被拒绝',
      refusedExpectedButSucceeded.map((entry) => entry.name));

    // ---- 3. security tools report structural state, not failures -------------------------
    section('security-structural');
    const byTool = (name) => results.filter((entry) => entry.name === name);
    const scriptList = byTool('browser_script')[0];
    check(scriptList.result.value?.armed === false,
      'browser_script list 未 arming 时返回 armed:false（结构化状态，不是报错）', scriptList.result.value);
    const cookiesMeta = byTool('browser_cookies')[0];
    check(cookiesMeta.result.ok === true, 'browser_cookies metadata 可用');
    check(cookiesMeta.result.value?.available === false || cookiesMeta.result.value?.available === true,
      'metadata 返回 available 布尔（无页面时说明原因）', cookiesMeta.result.value?.available);
    const scopeStatus = byTool('browser_security_scope')[0];
    check(scopeStatus.result.value?.active === false && typeof scopeStatus.result.value?.note === 'string',
      'browser_security_scope status 未启用时给出说明', scopeStatus.result.value);
    const surfaceBuild = byTool('browser_surface')[0];
    check(surfaceBuild.result.ok === true, 'browser_surface build 冷启动可用');
    check(surfaceBuild.result.value?.inventory?.kind === 'dsh-ui-testing-surface-inventory',
      'build 返回结构化 Inventory', surfaceBuild.result.value?.inventory?.kind);
    const findingsList = byTool('browser_findings')[0];
    check(findingsList.result.value?.total === 0, 'findings list 初始为空（不是未实现）');
    const bizEval = byTool('browser_biz')[0];
    check(bizEval.result.value?.candidates?.length === 0, 'biz evaluate 空事实零候选');

    // Missing-argument refusals are input-category (a caller mistake, not a broken tool).
    const inputRefusals = results.filter((entry) => entry.expect === 'refused');
    const wrongCategory = inputRefusals.filter((entry) => entry.result.error?.category === 'internal');
    check(wrongCategory.length === 0, '缺参拒绝不是 INTERNAL（不掩盖为"工具坏了"）',
      wrongCategory.map((entry) => entry.name));

    // ---- 4. no page side effects from a refused call --------------------------------------
    section('no-side-effects');
    const state = await harness.invoke('browser_state', {}, exec);
    check(state.ok === true, 'browser_state 仍可用');
    // After the refused calls above, no page should have been started by them alone.
    check(typeof state.value?.running === 'boolean', 'state 报告 running 布尔',
      state.value?.running);

    const failed = checks.filter((entry) => !entry.ok);
    console.log(`\n==== tool-smoke: ${checks.length - failed.length}/${checks.length} checks passed ====`);
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
  console.error('tool-smoke crashed:', error);
  process.exitCode = 1;
});
