/**
 * diagnose stage 5 (the `<target>页面` topology node) regression: the read-only probe must run
 * inside the page's own root.
 *
 * Real plugin + real Chromium + real HTTP (NDJSON), because the failure this guards against is a
 * cross-root identity mismatch: the dispatcher used to act as a synthetic actor derived from the
 * *workspace* id, which lands in a different page group than the page it had just frozen — so
 * `readonly-eval` answered TAB_NOT_FOUND and the 5th topology node went red.
 *
 * Three runs are asserted:
 *   1. positive — a session that owns the page: stage 5 PASS with every read-only probe passing;
 *   2. negative A — a session that owns nothing: the run may only inspect *its own* (empty) domain,
 *      and the owner's page must be byte-for-byte untouched;
 *   3. negative B — a binding that does not name an existing runtime: refused, no probe dispatched.
 * Plus: the dispatcher's widening is bounded — no call outside DISPATCHER_ALLOWED, and no
 * navigation/input side effect.
 *
 * Run: node tests/acceptance/diagnose-stage5.mjs   (exit 0 = all checks passed)
 */
import { createServer } from 'node:http';
import { mkdir, writeFile } from 'node:fs/promises';
import {
  createHarness,
  createFakeConnectionService,
  createFakeAgentRegistry,
  createFakeAgentTeamService,
  startPluginHttpServer,
} from './harness.mjs';

/** The dispatcher whitelist, restated here as the contract this test enforces. */
const DISPATCHER_ALLOWED = new Set([
  'browser_capabilities', 'browser_eval', 'browser_snapshot',
  'browser_screenshot', 'browser_computed_style', 'browser_network',
]);
const STAGE5_CHECKS = ['target-list', 'binding', 'readonly-eval', 'snapshot', 'screenshot', 'computed-style', 'network-read'];

const results = [];
const notRuns = [];
function check(label, pass, expected, actual) {
  results.push({ label, pass: Boolean(pass) });
  console.log(`${pass ? 'PASS' : 'FAIL'} ${label}`);
  if (!pass) console.log('  expected=' + JSON.stringify(expected) + ' actual=' + JSON.stringify(actual));
}
function notRun(label, reason) {
  notRuns.push({ label, reason });
  console.log(`NOT_RUN ${label} — ${reason}`);
}

const fixture = createServer((req, res) => {
  res.writeHead(200, { 'content-type': 'text/html' });
  res.end('<!doctype html><title>diag-page</title><h1 id="a">hello</h1><div id="marker">diag</div>');
});
await new Promise((resolve) => fixture.listen(0, '127.0.0.1', resolve));
const base = `http://127.0.0.1:${fixture.address().port}`;

const lead = { id: 'diag-lead', session: { header: { cwd: null } } };
const member = { id: 'diag-member', session: { header: { cwd: null } } };
const agents = createFakeAgentRegistry([lead, member]);
const agentTeams = createFakeAgentTeamService({
  membership: (agent) => (agent.id === 'diag-lead'
    ? { root: lead, id: 'team', role: 'lead', name: 'lead' }
    : agent.id === 'diag-member' ? { root: lead, id: 'team', role: 'teammate', name: 'member' } : undefined),
  rows: [
    { id: 'diag-lead', role: 'lead', status: 'running' },
    { id: 'diag-member', role: 'teammate', status: 'running' },
  ],
});

const harness = await createHarness({
  name: 'diagnose-stage5',
  connection: createFakeConnectionService({ admit: () => ({ peer: { id: 'owner' } }), browserPeer: { id: 'owner' } }),
  services: { agents, agentTeams },
});
const cwd = harness.workspaceDir;
lead.session.header.cwd = cwd;
member.session.header.cwd = cwd;
const execLead = { agent: lead };

/** POST /diagnose and collect the streamed NDJSON into {runEnd, stages}. */
async function diagnose({ sessionId, binding, mode = 'start', provider = null }) {
  const server = await startPluginHttpServer(harness);
  try {
    const headers = { 'content-type': 'application/json', 'x-ui-testing-scope-version': '1' };
    if (sessionId) headers['x-ui-testing-session-id'] = sessionId;
    if (binding) headers['x-ui-testing-scope-binding'] = binding;
    const response = await fetch(server.url + '/plugins/ui-testing/diagnose', {
      method: 'POST', headers, body: JSON.stringify(provider ? { mode, provider } : { mode }),
    });
    const text = await response.text();
    const events = text.trim().split('\n').filter(Boolean).map((line) => {
      try { return JSON.parse(line); } catch { return { type: 'unparsable', raw: line }; }
    });
    const end = events.find((event) => event.type === 'run-end') || null;
    return { status: response.status, events, end };
  } finally {
    // startPluginHttpServer returns { close: () => Promise }, not a raw node server.
    await server.close();
  }
}

/** The CDP target id the run bound to, parsed from the stage-5 `binding` check detail. */
function boundTargetId(run) {
  const detail = (run?.end?.stages?.['5']?.checks || []).find((row) => row.id === 'binding')?.detail || '';
  const match = /([0-9A-F]{16,})/u.exec(detail);
  return match ? match[1] : null;
}

const pageMarker = async () => {
  const value = await harness.invoke('browser_eval', {
    expression: '({marker: document.getElementById("marker")?.textContent ?? null, url: location.href, title: document.title})',
  }, execLead);
  return value.value?.value ?? null;
};

try {
  /* ---------------------------------------------------- 1. positive: the owner's own page */
  await harness.invoke('browser_navigate', { url: base + '/diag' }, execLead);
  const ownerBefore = await pageMarker();
  const ownerTab = (await harness.invoke('browser_tabs', { action: 'list' }, execLead)).value;
  const ownerRuntimeId = ownerTab?.tabs?.[0]?.runtimeId ?? null;

  const positive = await diagnose({ sessionId: 'diag-lead' });
  const stage5 = positive.end?.stages?.['5'] ?? null;
  check('D01 stage 5 状态为 PASS（第 5 个节点不再红）',
    stage5?.status === 'PASS', 'PASS', stage5?.status);
  const checks5 = new Map((stage5?.checks || []).map((row) => [row.id, row]));
  check('D02 readonly-eval 通过（诊断派发不再跨 root 被 TAB_NOT_FOUND 拒）',
    checks5.get('readonly-eval')?.status === 'pass', 'pass', checks5.get('readonly-eval'));
  const missing = STAGE5_CHECKS.filter((id) => !checks5.has(id));
  check('D03 五条只读探针齐全（target-list/binding/readonly-eval/snapshot/screenshot/computed-style/network-read）',
    missing.length === 0, [], missing);
  const probeFailures = [...checks5.values()].filter((row) => row.status !== 'pass');
  check('D04 没有任何只读探针因权限/失败被判非 pass',
    probeFailures.length === 0, [], probeFailures);

  const calls = positive.end?.actualCalls || [];
  const outsideWhitelist = calls.map((call) => call.tool).filter((tool) => !DISPATCHER_ALLOWED.has(tool));
  check('D05 诊断派发只在白名单内（放宽带宽被白名单封住）',
    outsideWhitelist.length === 0, [], outsideWhitelist);
  const writes = calls.filter((call) => ['browser_navigate', 'browser_input', 'browser_click', 'browser_type', 'browser_scroll'].includes(call.tool));
  check('D06 诊断期间没有导航/输入类调用（只读探针不含写动作）',
    writes.length === 0, [], writes.map((call) => call.tool));
  const ownerAfter = await pageMarker();
  check('D07 诊断不改被诊断页面（marker/url/title 前后一致）',
    JSON.stringify(ownerBefore) === JSON.stringify(ownerAfter), ownerBefore, ownerAfter);

  // The diagnose seam used to receive the 3-argument resolver unbound, so every run froze the LEGACY
  // scope and inspected some other runtime. Prove it now resolves the panel's own scope.
  const runStart = positive.events.find((event) => event.type === 'run-start') || null;
  check('D14 诊断按面板自己的 scope 解析（不再固定 legacy）',
    runStart?.scope?.kind !== 'legacy' && Boolean(runStart?.scope?.workspaceId),
    { kind: 'workspace/session', workspaceId: 'non-null' },
    { kind: runStart?.scope?.kind, workspaceId: runStart?.scope?.workspaceId });
  const ownerTarget = boundTargetId(positive);
  check('D15 stage 5 绑定的确实是被诊断那一页（binding 给出 CDP targetId）',
    Boolean(ownerTarget) && checks5.get('binding')?.status === 'pass', 'targetId', ownerTarget);

  /* ------------------------------ 2. negative A: a session that owns no page must not reach it */
  const foreign = await diagnose({ sessionId: 'diag-member' });
  const foreignStage5 = foreign.end?.stages?.['5'] ?? null;
  const foreignTarget = boundTargetId(foreign);
  check('D08 另一个会话去诊断：绑定到的是它自己的页，不是 owner 那一页',
    foreignTarget !== ownerTarget,
    { ownerTarget, mustDiffer: true }, { foreignTarget });
  const ownerAfterNegative = await pageMarker();
  check('D09 负向诊断后 owner 页面仍未被改动（零副作用）',
    JSON.stringify(ownerBefore) === JSON.stringify(ownerAfterNegative), ownerBefore, ownerAfterNegative);
  const foreignCalls = foreign.end?.actualCalls || [];
  const foreignOutside = foreignCalls.map((call) => call.tool).filter((tool) => !DISPATCHER_ALLOWED.has(tool));
  check('D10 负向诊断同样只在白名单内',
    foreignOutside.length === 0, [], foreignOutside);

  /* ------------------------------------------- 3. negative B: a binding that resolves to nothing */
  const badBinding = await diagnose({ binding: '00000000-0000-4000-8000-000000000000' });
  const refused = badBinding.status >= 400 || badBinding.end?.overall?.status === 'UNKNOWN';
  check('D11 不存在的 binding → 404 或 overall UNKNOWN（不假装诊断成功）',
    refused, { status: '>=400', overall: 'UNKNOWN' }, { status: badBinding.status, overall: badBinding.end?.overall });
  check('D12 不存在的 binding 不产生任何探针调用',
    (badBinding.end?.actualCalls || []).length === 0, 0, (badBinding.end?.actualCalls || []).length);

  /* --------------------- 4. provider subject: no object of that provider ⇒ no conclusion */
  const signature = (run) => ['3', '4', '5']
    .map((id) => `${id}:${run?.end?.stages?.[id]?.status}/${run?.end?.stages?.[id]?.reason}`)
    .join(' | ');

  const edge = await diagnose({ sessionId: 'diag-lead', provider: 'edge' });
  const edgeStage5 = edge.end?.stages?.['5'] ?? null;
  const edgeChecks = new Map((edgeStage5?.checks || []).map((row) => [row.id, row]));
  check('D16 provider=edge 而运行时属于 chrome → stage 5 不给结论（SKIPPED，非 PASS/WARN）',
    edgeStage5?.status === 'SKIPPED' && edgeStage5?.reason === 'blocked-by-provider-mismatch',
    { status: 'SKIPPED', reason: 'blocked-by-provider-mismatch' },
    { status: edgeStage5?.status, reason: edgeStage5?.reason });
  const matchDetail = String(edgeChecks.get('provider-match')?.detail || '');
  check('D17 跳过时 checks 里写明「请求 edge、运行时属于 chrome」',
    matchDetail.includes('edge') && matchDetail.includes('chrome'), 'edge + chrome', matchDetail);
  check('D18 provider 不匹配时整体结论不是 PASS',
    edge.end?.overall?.status !== 'PASS', 'not PASS', edge.end?.overall);

  const chromeExplicit = await diagnose({ sessionId: 'diag-lead', provider: 'chrome' });
  check('D19 正常路径未改坏：显式 provider=chrome 时 stage 5 仍 PASS',
    chromeExplicit.end?.stages?.['5']?.status === 'PASS', 'PASS', chromeExplicit.end?.stages?.['5']?.status);

  const edgeAgain = await diagnose({ sessionId: 'diag-lead', provider: 'edge' });
  check('D20 连续两次 provider=edge 结果一致（stage 3/4/5 状态与 reason 相同，无 flake）',
    signature(edge) === signature(edgeAgain), signature(edge), signature(edgeAgain));
  check('D21 provider 不匹配时 axes 的探针跳过理由写成「不属于本次 provider」而不是「无连接」',
    (edge.end?.axes?.checksDetail || []).every((row) => row.status !== 'skip' || String(row.detail).includes('provider')),
    'reason mentions provider',
    (edge.end?.axes?.checksDetail || []).map((row) => row.detail).slice(0, 2));

  notRun('D13 真实 Team 名额下的成员跨 root 诊断（真机语义）',
    'harness 的 roster 是注入的 fake 服务；真机上"成员拿 Lead 的 session 头去诊断"应由宿主面板绑定证明，属 M5 panel seat，本轮不伪造结论');
} catch (error) {
  check('D00 diagnose stage5 场景执行完成（无未捕获异常）', false, 'no exception', String((error && (error.stack || error.message)) || error));
} finally {
  try { await harness.closeBrowser(); } catch { /* best effort */ }
  try { await harness.dispose(); } catch { /* best effort */ }
  await new Promise((resolve) => fixture.close(resolve));
  const failed = results.filter((row) => !row.pass).length;
  const stamp = new Date().toISOString().replace(/[:.]/gu, '-');
  const dir = `tests/acceptance/runs/diagnose-stage5-${stamp}-${process.pid}`;
  await mkdir(dir, { recursive: true });
  await writeFile(`${dir}/report.json`, JSON.stringify({
    generatedAt: new Date().toISOString(),
    summary: { checks: results.length, passed: results.length - failed, failed, notRun: notRuns.length },
    checks: results, notRuns,
  }, null, 2));
  console.log(`evidence: ${dir}`);
  console.log(`\nRESULT ${failed ? 'FAIL' : 'PASS'} (${failed} failed, ${results.length} checks, ${notRuns.length} NOT_RUN)`);
  console.log(`exit ${failed ? 1 : 0}`);
  process.exit(failed ? 1 : 0);
}
