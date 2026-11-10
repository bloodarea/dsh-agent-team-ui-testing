/**
 * M4 team page-access acceptance: T01–T06 (native Team roster, Lead takeover, single writer).
 *
 * Why this file exists as a long-lived test (not a one-off script): the team surface is the part of
 * the model that is easiest to fake and hardest to prove. Every refusal below is checked against a
 * *counter* — a fixture HTTP hit count or a page marker written by the owner — never against
 * "it returned an error", because an error can be produced after the page was already touched.
 *
 * Identity is injected through the harness seam (`services:{agents, agentTeams}`), so the roster is
 * a fake but the resolution path is the production one: exact agent object → native membership →
 * fresh roster row. A second harness without those services proves the "host has no registry"
 * degradation separately (a standalone agent keeps working) instead of letting that case be
 * conflated with "cannot prove membership" (which must fail closed).
 *
 * Run: node tests/acceptance/team-tab-access.mjs
 * Exit: 0 when every check passes; 1 otherwise. NOT_RUN / KNOWN_GAP lines never count as passes.
 */
import { createServer } from 'node:http';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { mkdir, writeFile } from 'node:fs/promises';
import {
  createHarness,
  createFakeConnectionService,
  createFakeAgentRegistry,
  createFakeAgentTeamService,
  waitFor,
} from './harness.mjs';

const REPO_ROOT = dirname(dirname(dirname(fileURLToPath(import.meta.url))));
const cwd = process.env.DSH_UI_TESTING_REPO_ROOT || REPO_ROOT;
const log = (...args) => console.log(...args);

const results = [];
const notRuns = [];
const gaps = [];

/**
 * JSON-safe snapshot of one evidence value.
 *
 * A failed check without `expected`/`observed` cannot be diagnosed after the fact (the first T02
 * race regression in this suite was reported as `{label,pass:false}` and nothing else), so every
 * result row now carries both. Values are bounded so a large page tree cannot bloat the report.
 */
function evidence(value) {
  if (value === undefined) return null;
  try {
    const text = JSON.stringify(value);
    if (text === undefined) return null;
    return text.length > 2000 ? { truncated: text.slice(0, 2000), fullLength: text.length } : JSON.parse(text);
  } catch {
    return { unserializable: String(value).slice(0, 200) };
  }
}

function check(label, pass, expected, actual) {
  results.push({ label, pass: Boolean(pass), expected: evidence(expected), observed: evidence(actual) });
  log(`${pass ? 'PASS' : 'FAIL'} ${label}`);
  if (!pass) log('  expected=' + JSON.stringify(expected) + ' actual=' + JSON.stringify(actual));
}
/** A capability that this milestone does not implement, recorded honestly (never a pass). */
function notRun(label, reason) {
  notRuns.push({ label, reason });
  log(`NOT_RUN ${label} — ${reason}`);
}
/** Measured behaviour that is a known, accepted gap: reported, not scored. */
function knownGap(label, detail) {
  gaps.push({ label, detail });
  log(`KNOWN_GAP ${label} — ${JSON.stringify(detail)}`);
}

/* -------------------------------------------------------------------------------------------- *
 * Fixture: every hit is counted server-side, so "zero dispatch" has a real number behind it.
 * -------------------------------------------------------------------------------------------- */
const hits = new Map();
const server = createServer((req, res) => {
  const path = (req.url || '/').split('?')[0];
  hits.set(path, (hits.get(path) || 0) + 1);
  res.writeHead(200, { 'content-type': 'text/html' });
  if (path === '/other') {
    res.end('<!doctype html><title>other page</title><h1 id="h">other</h1>');
    return;
  }
  res.end('<!doctype html><title>team fixture</title><div id="marker">0</div><input id="field" value="">');
});
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const fixture = `http://127.0.0.1:${server.address().port}/`;
const hitsOf = (path = '/') => hits.get(path) || 0;

/* -------------------------------------------------------------------------------------------- *
 * Host with a native Team roster: Lead + two teammates + one outsider that is *not* rostered.
 * -------------------------------------------------------------------------------------------- */
const lead = { id: 'team-lead', session: { header: { cwd } } };
const member1 = { id: 'member-1', session: { header: { cwd } } };
const member2 = { id: 'member-2', session: { header: { cwd } } };
const member3 = { id: 'member-3', session: { header: { cwd } } };
const outsider = { id: 'outsider', session: { header: { cwd } } };
const agents = createFakeAgentRegistry([lead, member1, member2, member3, outsider]);
const teamService = createFakeAgentTeamService({
  membership: (agent) => {
    if (agent.id === 'team-lead') return { root: lead, id: 'team', role: 'lead', name: 'lead' };
    if (agent.id === 'member-1' || agent.id === 'member-2' || agent.id === 'member-3') {
      return { root: lead, id: 'team', role: 'teammate', name: agent.id };
    }
    // A registered agent that is not part of the team: undefined must never degrade to standalone.
    return undefined;
  },
  rows: [
    { id: 'team-lead', role: 'lead', status: 'running' },
    { id: 'member-1', role: 'teammate', status: 'running' },
    { id: 'member-2', role: 'teammate', status: 'running' },
    { id: 'member-3', role: 'teammate', status: 'running' },
  ],
});

const teamHarness = await createHarness({
  name: 'team-tab-access',
  connection: createFakeConnectionService({ admit: () => ({ peer: { id: 'owner' } }), browserPeer: { id: 'owner' } }),
  services: { agents, agentTeams: teamService },
});
const registry = teamHarness.ctx.__internal.plugin.registry;
const execL = { agent: lead };
const execM1 = { agent: member1 };
const execM2 = { agent: member2 };
const execM3 = { agent: member3 };
const execO = { agent: outsider };
const call = (name, args, exec) => teamHarness.invoke(name, args, exec);

/** Registry-side facts of one tab (host memory only: reading them costs no CDP and no lease). */
function entryOf(tabId) {
  return [...registry.entries.values()].find(
    (entry) => (entry.tabId || entry.viewId) === tabId,
  );
}
function recordOf(tabId) {
  const entry = entryOf(tabId);
  if (!entry) return null;
  return {
    kind: entry.kind,
    rootSessionId: entry.rootSessionId,
    creatorSessionId: entry.ownership?.creatorSessionId ?? null,
    ownerSessionId: entry.ownership?.ownerSessionId ?? null,
    ownershipRevision: entry.ownership?.ownershipRevision ?? null,
    controllerSessionId: entry.control?.controllerSessionId ?? null,
    controlRevision: entry.control?.controlRevision ?? null,
    state: entry.control?.state ?? null,
    leaseSessionId: entry.runtime.lease?.sessionId ?? null,
    active: entry.runtime.active,
    inflight: entry.runtime.inflight,
    url: entry.runtime.url,
    runtimeId: entry.runtime.runtimeId,
  };
}
/**
 * Page-side facts read through **CDP directly**, never through a tool.
 *
 * Reading `visibilityState` via `browser_eval` would itself run a page operation and activate that
 * page, i.e. the measurement would create (and hide) exactly the effect T02 is trying to detect.
 * This is a read-only probe on the target's own page connection: no queue, no lease, no activate.
 */
async function pageFactsDirect(tabId) {
  const entry = entryOf(tabId);
  const cdp = entry?.runtime?.cdp;
  if (!cdp || cdp.closed) return null;
  try {
    const out = await cdp.send('Runtime.evaluate', {
      expression: '({marker: document.getElementById("marker")?.textContent ?? null, url: location.href,'
        + ' scrollY, visibility: document.visibilityState, title: document.title})',
      returnByValue: true,
    }, { timeoutMs: 2000 });
    return out.result?.value ?? null;
  } catch {
    return null;
  }
}

/** Page-side facts read *through the owner*, i.e. what a user would actually see. */
async function ownerFacts(exec) {
  const result = await call('browser_eval', {
    expression: '({marker: document.getElementById("marker")?.textContent ?? null,'
      + ' url: location.href, scrollY, visibility: document.visibilityState, title: document.title})',
  }, exec);
  return result.value?.value ?? null;
}
/** Count activate()/Page.bringToFront on one page (the observation-side truth of T02). */
function spyForeground(tabId) {
  const entry = entryOf(tabId);
  const runtime = entry?.runtime;
  const counts = { activate: 0, bringToFront: 0 };
  if (!runtime) return counts;
  const originalActivate = runtime.activate.bind(runtime);
  runtime.activate = () => { counts.activate += 1; return originalActivate(); };
  const cdp = runtime.cdp;
  if (cdp && typeof cdp.send === 'function') {
    const originalSend = cdp.send.bind(cdp);
    cdp.send = (method, params, options) => {
      if (method === 'Page.bringToFront') counts.bringToFront += 1;
      return originalSend(method, params, options);
    };
  }
  return counts;
}
async function mark(exec, text) {
  const result = await call('browser_eval', {
    expression: `document.getElementById('marker').textContent = ${JSON.stringify(text)}; `
      + `document.getElementById('marker').textContent`,
  }, exec);
  return result.value?.value ?? null;
}
const markerOf = async (exec) => (await call('browser_eval', {
  expression: 'document.getElementById("marker")?.textContent ?? null',
}, exec)).value?.value ?? null;

const tabIds = {};

try {
  /* ============================================================ T01: one page per actor */
  {
    check('T01 前置：L navigate 自己的 primary',
      (await call('browser_navigate', { url: fixture }, execL)).ok === true, true, 'navigate failed');
    const openM1 = await call('browser_tabs', { action: 'open' }, execM1);
    const openM2 = await call('browser_tabs', { action: 'open' }, execM2);
    tabIds.m1 = openM1.value?.tabId;
    tabIds.m2 = openM2.value?.tabId;
    check('T01 M1/M2 各自 open 成功', Boolean(tabIds.m1) && Boolean(tabIds.m2), true,
      { m1: openM1.error?.code, m2: openM2.error?.code });
    await call('browser_navigate', { url: fixture }, execM1);
    await call('browser_navigate', { url: fixture }, execM2);
    await mark(execM1, 'm1');
    await mark(execM2, 'm2');

    const primary = recordOf('primary');
    const r1 = recordOf(tabIds.m1);
    const r2 = recordOf(tabIds.m2);
    check('T01 L/M1/M2 在同一 root，但 owner 各不相同',
      primary?.rootSessionId === 'team-lead' && r1?.rootSessionId === 'team-lead' && r2?.rootSessionId === 'team-lead'
      && primary?.ownerSessionId === 'team-lead' && r1?.ownerSessionId === 'member-1' && r2?.ownerSessionId === 'member-2',
      { root: 'team-lead', owners: ['team-lead', 'member-1', 'member-2'] },
      { root: [primary?.rootSessionId, r1?.rootSessionId, r2?.rootSessionId],
        owners: [primary?.ownerSessionId, r1?.ownerSessionId, r2?.ownerSessionId] });

    const listL = await call('browser_tabs', { action: 'list' }, execL);
    check('T01 Lead 的 list 能看到三个页（同 root 同组）',
      (listL.value?.tabs || []).length === 3, 3, (listL.value?.tabs || []).map((tab) => tab.tabId));

    // A member must not get the Lead's primary by "just selecting it".
    const selectionBefore = (await call('browser_tabs', { action: 'list' }, execM1)).value?.selection;
    const memberSelectLead = await call('browser_tabs', { action: 'select', tabId: 'primary' }, execM1);
    check('T01 成员不能 select(work) Lead 的 primary → TAB_FORBIDDEN',
      memberSelectLead.error?.code === 'TAB_FORBIDDEN', 'TAB_FORBIDDEN', memberSelectLead.error?.code);
    const selectionAfter = (await call('browser_tabs', { action: 'list' }, execM1)).value?.selection;
    check('T01 被拒 select 不改变成员选择',
      JSON.stringify(selectionBefore) === JSON.stringify(selectionAfter), true, { before: selectionBefore, after: selectionAfter });
    check('T01 成员写自己页正常，Lead 页 marker 不受影响',
      (await mark(execM1, 'm1-again')) === 'm1-again' && (await markerOf(execL)) === '0',
      { m1: 'm1-again', lead: '0' }, { m1: await markerOf(execM1), lead: await markerOf(execL) });
  }

  /* ====================================================== T02: observation is non-destructive */
  {
    await mark(execM2, 'm2-observed');
    const before = await pageFactsDirect(tabIds.m2);
    const recordBefore = recordOf(tabIds.m2);
    const hitsBefore = hitsOf('/');
    const foreground = spyForeground(tabIds.m2);
    const counterBefore = { ...foreground };

    const observe = await call('browser_tabs', { action: 'select', tabId: tabIds.m2, mode: 'observe' }, execM1);
    const counterAfterSelect = { ...foreground };
    check('T02 M1 observe-select M2 的页 → 允许且不 claim',
      observe.ok === true && observe.value?.claimed === false, { ok: true, claimed: false },
      observe.error?.code || observe.value?.claimed);

    const shot = await call('browser_screenshot', {}, execM1);
    const snap = await call('browser_snapshot', {}, execM1);
    const counterAfterObserve = { ...foreground };
    check('T02 M1 能读 M2 的页（screenshot+snapshot 成功且目标正确）',
      shot.ok === true && snap.ok === true && snap.value?.tab?.runtimeId === recordBefore?.runtimeId,
      { shot: true, snap: true, runtimeId: recordBefore?.runtimeId },
      { shot: shot.error?.code, snap: snap.error?.code, runtimeId: snap.value?.tab?.runtimeId });

    // Direct foreground evidence: the observation must not call activate() and must not send
    // Page.bringToFront. This is the check that removes the 300ms-throttle luck from the verdict.
    const duringSelect = {
      activate: counterAfterSelect.activate - counterBefore.activate,
      bringToFront: counterAfterSelect.bringToFront - counterBefore.bringToFront,
    };
    const duringObserve = {
      activate: counterAfterObserve.activate - counterAfterSelect.activate,
      bringToFront: counterAfterObserve.bringToFront - counterAfterSelect.bringToFront,
    };
    check('T02 观察期间不切前台：select(observe) 与读工具都不 activate、不发 Page.bringToFront',
      duringSelect.activate === 0 && duringSelect.bringToFront === 0
      && duringObserve.activate === 0 && duringObserve.bringToFront === 0,
      { select: { activate: 0, bringToFront: 0 }, observe: { activate: 0, bringToFront: 0 } },
      { select: duringSelect, observe: duringObserve });

    const after = await pageFactsDirect(tabIds.m2);
    const recordAfter = recordOf(tabIds.m2);
    check('T02 观察不改 M2 的文档（marker/url/scroll/visibility 前后一致）',
      before !== null && after !== null
      && JSON.stringify({ marker: before.marker, url: before.url, y: before.scrollY, vis: before.visibility })
      === JSON.stringify({ marker: after.marker, url: after.url, y: after.scrollY, vis: after.visibility }),
      before, after);
    check('T02 观察不改 M2 的 owner/controller/版本/state',
      JSON.stringify({
        owner: recordBefore?.ownerSessionId, controller: recordBefore?.controllerSessionId,
        ownershipRevision: recordBefore?.ownershipRevision, controlRevision: recordBefore?.controlRevision,
        state: recordBefore?.state,
      }) === JSON.stringify({
        owner: recordAfter?.ownerSessionId, controller: recordAfter?.controllerSessionId,
        ownershipRevision: recordAfter?.ownershipRevision, controlRevision: recordAfter?.controlRevision,
        state: recordAfter?.state,
      }), recordBefore, recordAfter);
    check('T02 观察不抢 M2 的写租约（lease 仍是 M2，active=0）',
      recordAfter?.leaseSessionId === 'member-2' && recordAfter?.active === 0,
      { leaseSessionId: 'member-2', active: 0 },
      { leaseSessionId: recordAfter?.leaseSessionId, active: recordAfter?.active });
    check('T02 观察期间没有额外导航（fixture 对 / 的命中数不变）',
      hitsOf('/') === hitsBefore, hitsBefore, hitsOf('/'));
    notRun('T02 通过已有网络数据观察队友页（browser_network/events）作为独立 T02 断言',
      '网络采集器仍按 workspace/session 归属（targets/、network-p0 属 M3），本轮不接线；已用 screenshot+snapshot 覆盖「可读且无副作用」');
  }

  /* ================================================== T03: foreign-actor writes are refused */
  {
    const m2FactsBefore = await ownerFacts(execM2);
    const m1MarkerBefore = await markerOf(execM1);
    // Snapshot taken *before* the refused calls: together with the snapshot right after them this is
    // the zero-dispatch window (the member's own allowed navigation happens later and is not in it).
    const hitsBeforeRefusals = hitsOf('/');
    const attempts = [];
    attempts.push(['tabs.close', await call('browser_tabs', { action: 'close', tabId: tabIds.m2 }, execM1)]);
    attempts.push(['tabs.select(work)', await call('browser_tabs', { action: 'select', tabId: tabIds.m2 }, execM1)]);
    attempts.push(['tabs.acquire', await call('browser_tabs', { action: 'acquire', tabId: tabIds.m2, expectedControlRevision: 1 }, execM1)]);
    attempts.push(['tabs.transfer', await call('browser_tabs', { action: 'transfer', tabId: tabIds.m2, toSessionId: 'member-1', expectedControlRevision: 1, expectedOwnershipRevision: 1 }, execM1)]);
    const codes = attempts.map(([name, result]) => [name, result.error?.code]);
    const allowedCodes = new Set(['TAB_FORBIDDEN', 'TAB_NOT_FOUND', 'TAB_CONTROL_CHANGED']);
    check('T03 队友页的 close/select/acquire/transfer 全部被拒且码是权限/控制原因',
      codes.every(([, code]) => allowedCodes.has(code)), 'TAB_FORBIDDEN|TAB_NOT_FOUND|TAB_CONTROL_CHANGED', codes);
    check('T03 被拒调用零派发（拒绝窗口内 fixture 对 / 的命中数不变）',
      hitsOf('/') === hitsBeforeRefusals, hitsBeforeRefusals, hitsOf('/'));

    // A member navigate/eval cannot address a teammate's page at all: it lands on its own.
    await call('browser_navigate', { url: fixture + 'other' }, execM1);
    const otherHitByM1 = hitsOf('/other');
    await call('browser_navigate', { url: fixture }, execM1);
    await call('browser_eval', { expression: 'document.getElementById("marker").textContent = "m1-write"; 1' }, execM1);
    const m2FactsAfter = await ownerFacts(execM2);
    check('T03 队友的 navigate 只作用于自己页（M2 的 marker/url 不变）',
      otherHitByM1 > 0 && m2FactsAfter?.marker === m2FactsBefore?.marker && m2FactsAfter?.url === m2FactsBefore?.url,
      { otherHits: otherHitByM1, marker: m2FactsBefore?.marker, url: m2FactsBefore?.url },
      { otherHits: otherHitByM1, marker: m2FactsAfter?.marker, url: m2FactsAfter?.url });
    check('T03 M1 自己的写仍落到自己页',
      (await markerOf(execM1)) === 'm1-write' && m1MarkerBefore !== null,
      { m1: 'm1-write' }, { m1: await markerOf(execM1), before: m1MarkerBefore });
    notRun('T03 network_session reset / trace 对队友页的越权拒绝',
      '网络采集器与 trace 仍是 workspace/session 级归属（M3 接线），本轮没有按 root/actor 的 ACL 可测；不伪造为通过');
  }

  /* ============================ T04: Lead acquire → write → release → transfer semantics */
  {
    const current = recordOf(tabIds.m2);
    const selectL = await call('browser_tabs', { action: 'select', tabId: tabIds.m2 }, execL);
    check('T04 Lead 可以 work-select 成员页（管理资格）', selectL.ok === true, true, selectL.error?.code);
    const acquire = await call('browser_tabs', {
      action: 'acquire', tabId: tabIds.m2, expectedControlRevision: current.controlRevision,
    }, execL);
    check('T04 acquire 成功且 controller=Lead、owner 不变、controlRevision+1',
      acquire.ok === true && acquire.value?.changed === true
      && acquire.value?.control?.controllerSessionId === 'team-lead'
      && acquire.value?.control?.ownerSessionId === 'member-2'
      && acquire.value?.control?.controlRevision === current.controlRevision + 1,
      { controller: 'team-lead', owner: 'member-2', revision: current.controlRevision + 1 },
      acquire.error?.code || acquire.value?.control);

    check('T04 acquire 后 Lead 写入成功', (await mark(execL, 'lead-wrote')) === 'lead-wrote', 'lead-wrote',
      await markerOf(execL));
    const m2Blocked = await call('browser_eval', { expression: 'document.getElementById("marker").textContent = "m2-should-fail"; 1' }, execM2);
    check('T04 此时成员写被挡（TAB_CONTROL_CHANGED，零派发）',
      m2Blocked.error?.code === 'TAB_CONTROL_CHANGED' && (await markerOf(execL)) === 'lead-wrote',
      { code: 'TAB_CONTROL_CHANGED', marker: 'lead-wrote' },
      { code: m2Blocked.error?.code, marker: await markerOf(execL) });

    const release = await call('browser_tabs', {
      action: 'release', tabId: tabIds.m2, expectedControlRevision: acquire.value?.control?.controlRevision,
    }, execL);
    check('T04 release 归还 owner（controller=member-2，revision+1）',
      release.ok === true && release.value?.control?.controllerSessionId === 'member-2'
      && release.value?.control?.controlRevision === (acquire.value?.control?.controlRevision ?? 0) + 1,
      { controller: 'member-2' }, release.error?.code || release.value?.control);
    check('T04 release 后成员恢复可写', (await mark(execM2, 'm2-back')) === 'm2-back', 'm2-back', await markerOf(execM2));

    // ---- transfer: owner and controller both move, creator stays the original member
    const beforeTransfer = recordOf(tabIds.m2);
    const acquire2 = await call('browser_tabs', {
      action: 'acquire', tabId: tabIds.m2, expectedControlRevision: beforeTransfer.controlRevision,
    }, execL);
    const transfer = await call('browser_tabs', {
      action: 'transfer', tabId: tabIds.m2, toSessionId: 'member-1',
      expectedControlRevision: acquire2.value?.control?.controlRevision,
      expectedOwnershipRevision: beforeTransfer.ownershipRevision,
    }, execL);
    check('T04 transfer 给 M1：owner/controller=M1，creator 仍是 M2，两个版本各 +1',
      transfer.ok === true
      && transfer.value?.control?.ownerSessionId === 'member-1'
      && transfer.value?.control?.controllerSessionId === 'member-1'
      && transfer.value?.control?.creatorSessionId === 'member-2'
      && transfer.value?.control?.ownershipRevision === beforeTransfer.ownershipRevision + 1
      && transfer.value?.control?.controlRevision === acquire2.value?.control?.controlRevision + 1,
      { owner: 'member-1', controller: 'member-1', creator: 'member-2' },
      transfer.error?.code || transfer.value?.control);

    const m2AfterTransfer = await call('browser_eval', { expression: '"m2"' }, execM2);
    check('T04 转交后原 owner（M2）失去写权 → TAB_FORBIDDEN',
      m2AfterTransfer.error?.code === 'TAB_FORBIDDEN', 'TAB_FORBIDDEN', m2AfterTransfer.error?.code);
    const m1Select = await call('browser_tabs', { action: 'select', tabId: tabIds.m2 }, execM1);
    const m1Write = await call('browser_eval', { expression: 'document.getElementById("marker").textContent = "m1-owner"; 1' }, execM1);
    check('T04 新 owner（M1）可写',
      m1Select.ok === true && m1Write.ok === true && (await markerOf(execM1)) === 'm1-owner',
      { select: true, write: true, marker: 'm1-owner' },
      { select: m1Select.error?.code, write: m1Write.error?.code, marker: await markerOf(execM1) });
  }

  /* ======================================= T05: drain gate, timeout/cancel, stale versions */
  {
    // After T04's transfer this page belongs to M1, so M1 is the writer whose work must survive a
    // drain attempt and whose stale control version must be refused.
    // (a) A draining takeover must never interrupt an in-flight operation.
    const slow = call('browser_eval', {
      expression: 'new Promise((resolve) => setTimeout(() => resolve("slow-done"), 2500))',
    }, execM1);
    await waitFor(() => recordOf(tabIds.m2)?.active > 0, { timeoutMs: 5000, label: 'M1 in-flight write' });
    const revisionWhileBusy = recordOf(tabIds.m2)?.controlRevision;
    const timeoutAcquire = await call('browser_tabs', {
      action: 'acquire', tabId: tabIds.m2, expectedControlRevision: revisionWhileBusy, timeoutMs: 300,
    }, execL);
    const afterTimeout = recordOf(tabIds.m2);
    check('T05a 接管超时 → BUSY，controller/controlRevision 原样不变',
      timeoutAcquire.error?.code === 'BUSY'
      && timeoutAcquire.error?.retryable === true
      && afterTimeout?.controllerSessionId === 'member-1'
      && afterTimeout?.controlRevision === revisionWhileBusy
      && afterTimeout?.state === 'owned',
      { code: 'BUSY', controller: 'member-1', revision: revisionWhileBusy, state: 'owned' },
      { code: timeoutAcquire.error?.code, controller: afterTimeout?.controllerSessionId,
        revision: afterTimeout?.controlRevision, state: afterTimeout?.state, details: timeoutAcquire.error?.details });
    const slowResult = await slow;
    check('T05a 超时请求没有打断成员的在途操作（不是 abort）',
      slowResult.ok === true && slowResult.value?.value === 'slow-done', 'slow-done',
      slowResult.error?.code || slowResult.value?.value);

    // (b) Old controlRevision is always stale, never an automatic replay.
    const staleAcquire = await call('browser_tabs', {
      action: 'acquire', tabId: tabIds.m2, expectedControlRevision: (revisionWhileBusy ?? 1) - 1,
    }, execL);
    check('T05b 旧 expectedControlRevision → TAB_CONTROL_CHANGED（不自动重放）',
      staleAcquire.error?.code === 'TAB_CONTROL_CHANGED', 'TAB_CONTROL_CHANGED', staleAcquire.error?.code);

    const acquire = await call('browser_tabs', {
      action: 'acquire', tabId: tabIds.m2, expectedControlRevision: recordOf(tabIds.m2)?.controlRevision,
    }, execL);
    check('T05 接管成功（controller=Lead，owner 仍是 M1）',
      acquire.ok === true && acquire.value?.control?.controllerSessionId === 'team-lead'
      && acquire.value?.control?.ownerSessionId === 'member-1',
      { controller: 'team-lead', owner: 'member-1' }, acquire.error?.code || acquire.value?.control);

    // The marker is read *through the current controller* (the Lead): a member read here would be a
    // refused write and could not prove anything about the page.
    const markerBeforeStaleWrite = await markerOf(execL);
    const staleWrite = await call('browser_eval', {
      expression: 'document.getElementById("marker").textContent = "stale-write"; 1',
    }, execM1);
    const markerAfterStaleWrite = await markerOf(execL);
    check('T05 当前 owner 在 Lead 接管期间的写 → TAB_CONTROL_CHANGED 且零派发',
      staleWrite.error?.code === 'TAB_CONTROL_CHANGED' && markerAfterStaleWrite === markerBeforeStaleWrite,
      { code: 'TAB_CONTROL_CHANGED', marker: markerBeforeStaleWrite },
      { code: staleWrite.error?.code, marker: markerAfterStaleWrite });
    const nonOwnerWrite = await call('browser_eval', { expression: '1' }, execM2);
    check('T05 非 owner 队友写该页 → TAB_FORBIDDEN（角色原因，不是控制原因）',
      nonOwnerWrite.error?.code === 'TAB_FORBIDDEN', 'TAB_FORBIDDEN', nonOwnerWrite.error?.code);

    const releaseAgain = await call('browser_tabs', {
      action: 'release', tabId: tabIds.m2, expectedControlRevision: acquire.value?.control?.controlRevision,
    }, execL);
    check('T05 release 归还 owner（controller=M1）',
      releaseAgain.ok === true && releaseAgain.value?.control?.controllerSessionId === 'member-1',
      { controller: 'member-1' }, releaseAgain.error?.code || releaseAgain.value?.control);
    check('T05 release 后 owner 可继续写',
      (await call('browser_eval', { expression: 'document.getElementById("marker").textContent = "after-release"; 1' }, execM1)).ok === true
      && (await markerOf(execM1)) === 'after-release',
      'after-release', await markerOf(execM1));

    const idempotent = await call('browser_tabs', {
      action: 'release', tabId: tabIds.m2, expectedControlRevision: releaseAgain.value?.control?.controlRevision,
    }, execL);
    check('T05 相同当前版本重复 release → changed:false 且不加版本',
      idempotent.ok === true && idempotent.value?.changed === false
      && idempotent.value?.control?.controlRevision === releaseAgain.value?.control?.controlRevision,
      { changed: false }, idempotent.error?.code || idempotent.value?.control);
  }

  /* ================================= T06: self-reported identity buys nothing; standalone still works */
  {
    const identity = await call('browser_eval', { expression: '1' }, execO);
    check('T06 非 roster 成员 → TAB_IDENTITY_UNAVAILABLE（不降级为 standalone）',
      identity.error?.code === 'TAB_IDENTITY_UNAVAILABLE', 'TAB_IDENTITY_UNAVAILABLE', identity.error?.code);
    // Argument-level forgery is checked with a *proven* actor: an unproven one never reaches argument
    // parsing at all (identity is resolved first), which is itself the stronger statement.
    const forgedRootField = await call('browser_tabs', { action: 'list', rootSessionId: 'team-lead', role: 'lead' }, execL);
    check('T06 自报 root/role 字段被拒绝（工具参数不接受任何身份字段）',
      forgedRootField.error?.code === 'INVALID_ARGUMENT', 'INVALID_ARGUMENT', forgedRootField.error?.code);
    const forgedIdentity = await call('browser_tabs', {
      action: 'select', tabId: tabIds.m2, mode: 'work', principal: { rootSessionId: 'team-lead', role: 'lead' },
    }, execL);
    check('T06 自报 principal 对象也被拒绝', forgedIdentity.error?.code === 'INVALID_ARGUMENT',
      'INVALID_ARGUMENT', forgedIdentity.error?.code);
    const outsiderList = await call('browser_tabs', { action: 'list' }, execO);
    check('T06 未证实身份的 agent 连 list 都拿不到（先拒身份，再谈参数）',
      outsiderList.error?.code === 'TAB_IDENTITY_UNAVAILABLE', 'TAB_IDENTITY_UNAVAILABLE', outsiderList.error?.code);

    const transferToOutsider = await call('browser_tabs', {
      action: 'transfer', tabId: tabIds.m2, toSessionId: 'outsider',
      expectedControlRevision: recordOf(tabIds.m2)?.controlRevision,
      expectedOwnershipRevision: recordOf(tabIds.m2)?.ownershipRevision,
    }, execL);
    check('T06 transfer 给非成员 → TAB_FORBIDDEN（not-a-member）',
      transferToOutsider.error?.code === 'TAB_FORBIDDEN'
      && transferToOutsider.error?.details?.reason === 'not-a-member',
      { code: 'TAB_FORBIDDEN', reason: 'not-a-member' },
      { code: transferToOutsider.error?.code, reason: transferToOutsider.error?.details?.reason });

    // Contrast: a host with no identity services must still let an Agent drive its own page.
    const standaloneHarness = await createHarness({
      name: 'team-tab-access-standalone',
      connection: createFakeConnectionService({ admit: () => ({ peer: { id: 'owner' } }), browserPeer: { id: 'owner' } }),
    });
    try {
      const solo = { agent: { id: 'solo-agent', session: { header: { cwd } } } };
      const nav = await standaloneHarness.invoke('browser_navigate', { url: fixture }, solo);
      const write = await standaloneHarness.invoke('browser_eval', {
        expression: 'document.getElementById("marker").textContent = "solo"; document.getElementById("marker").textContent',
      }, solo);
      const list = await standaloneHarness.invoke('browser_tabs', { action: 'list' }, solo);
      check('T06 对照：服务缺失 → standalone 自己的页可正常读写，且只看到自己的域',
        nav.ok === true && write.ok === true && write.value?.value === 'solo'
        && (list.value?.tabs || []).length === 1
        && list.value.tabs.every((tab) => tab.rootSessionId === 'solo-agent'),
        { nav: true, write: 'solo', tabs: 1 },
        { nav: nav.error?.code, write: write.error?.code, tabs: list.value?.tabs });
      check('T06 对照：standalone 默认工作页仍是自己的 primary（未被新规则影响）',
        list.value?.selection?.tabId === 'primary', 'primary', list.value?.selection?.tabId);
    } finally {
      try { await standaloneHarness.closeBrowser(); } catch { /* best effort */ }
      try { await standaloneHarness.dispose(); } catch { /* best effort */ }
    }
  }

  /* ============ T07: a member without a work page, and a pendingReset that survives a turn end */
  {
    // --- T07a: no page of its own must read as "not bound", never as "not allowed"
    // The Lead already work-selected a member page in T04, so its *default* is no longer observable
    // here; what matters is that its own primary is still owned by it and writable. The real
    // "default = primary" case is asserted on the fresh standalone harness in T06.
    const leadPrimaryRow = (await call('browser_tabs', { action: 'list' }, execL)).value?.tabs
      ?.find((tab) => tab.tabId === 'primary');
    const leadSelect = await call('browser_tabs', { action: 'select', tabId: 'primary' }, execL);
    const leadWrite = await call('browser_eval', { expression: '1 + 1' }, execL);
    check('T07 Lead 对自己的 primary 仍有写权（默认行为未变）',
      leadPrimaryRow?.ownerSessionId === 'team-lead' && leadPrimaryRow?.permissions?.write === true
      && leadSelect.ok === true && leadWrite.ok === true,
      { owner: 'team-lead', write: true, select: true },
      { owner: leadPrimaryRow?.ownerSessionId, write: leadPrimaryRow?.permissions?.write,
        select: leadSelect.error?.code, writeError: leadWrite.error?.code });
    const m3Before = (await call('browser_tabs', { action: 'list' }, execM3)).value?.selection;
    check('T07 成员没有自有页时 workSelection 不指向别人的 primary（未绑定）',
      m3Before?.tabId === null, null, m3Before?.tabId);
    const leadMarkerBefore = await markerOf(execL);
    const hitsBefore = hitsOf('/');
    const m3Eval = await call('browser_eval', { expression: 'location.href' }, execM3);
    const m3Nav = await call('browser_navigate', { url: fixture + 'other' }, execM3);
    check('T07 成员无页时写动作返回 TARGET_NOT_BOUND（不是 TAB_FORBIDDEN）',
      m3Eval.error?.code === 'TARGET_NOT_BOUND' && m3Eval.error?.details?.reason === 'no-work-page'
      && m3Nav.error?.code === 'TARGET_NOT_BOUND' && m3Nav.error?.details?.reason === 'no-work-page',
      { code: 'TARGET_NOT_BOUND', reason: 'no-work-page' },
      { eval: { code: m3Eval.error?.code, reason: m3Eval.error?.details?.reason },
        navigate: { code: m3Nav.error?.code, reason: m3Nav.error?.details?.reason } });
    check('T07 被拒的成员写零派发（Lead 页 marker 与 fixture 命中数不变）',
      (await markerOf(execL)) === leadMarkerBefore && hitsOf('/') === hitsBefore,
      { marker: leadMarkerBefore, hits: hitsBefore },
      { marker: await markerOf(execL), hits: hitsOf('/') });

    // --- T07b: open → close → explicit confirm, with a real turn boundary in the middle
    const open3 = await call('browser_tabs', { action: 'open' }, execM3);
    const afterOpen = (await call('browser_tabs', { action: 'list' }, execM3)).value?.selection;
    check('T07 成员 open 后工作页指向自己的 child',
      open3.ok === true && afterOpen?.tabId === open3.value?.tabId, open3.value?.tabId, afterOpen?.tabId);
    await call('browser_tabs', { action: 'close', tabId: open3.value.tabId }, execM3);
    const afterClose = (await call('browser_tabs', { action: 'list' }, execM3)).value?.selection;
    check('T07 close 后进入 pendingReset 且不回落成别人的 primary',
      afterClose?.tabId === null && afterClose?.pendingReset === true
      && afterClose?.resetReason === 'tab-closed', { tabId: null, pendingReset: true, resetReason: 'tab-closed' },
      { tabId: afterClose?.tabId, pendingReset: afterClose?.pendingReset, resetReason: afterClose?.resetReason });

    // The real host disposes the agent at almost every turn boundary: the record must survive it.
    await teamHarness.ctx.emit('agent/disposed', { agent: member3 });
    const afterDispose = (await call('browser_tabs', { action: 'list' }, execM3)).value?.selection;
    check('T07 agent/disposed 之后 selection 记录不被重建（revision 不回退、pendingReset 不丢）',
      afterDispose?.revision === afterClose?.revision && afterDispose?.pendingReset === true
      && afterDispose?.tabId === null,
      { revision: afterClose?.revision, pendingReset: true, tabId: null },
      { revision: afterDispose?.revision, pendingReset: afterDispose?.pendingReset, tabId: afterDispose?.tabId });

    const pendingEval = await call('browser_eval', { expression: '1' }, execM3);
    check('T07 pendingReset 期间页面工具零派发 TARGET_NOT_FOUND（必须显式确认）',
      pendingEval.error?.code === 'TARGET_NOT_FOUND'
      && pendingEval.error?.details?.reason === 'tab-closed',
      { code: 'TARGET_NOT_FOUND', reason: 'tab-closed' },
      { code: pendingEval.error?.code, reason: pendingEval.error?.details?.reason });

    const current = await call('browser_tabs', { action: 'current' }, execM3);
    const afterConfirm = (await call('browser_tabs', { action: 'list' }, execM3)).value?.selection;
    check('T07 current 显式确认：confirmedResetReason 回报、revision 单调递增、pendingReset 清除',
      current.ok === true && current.value?.confirmedResetReason === 'tab-closed'
      && afterConfirm?.pendingReset === false && afterConfirm?.resetReason === null
      && afterConfirm?.revision === (afterDispose?.revision ?? 0) + 1,
      { confirmedResetReason: 'tab-closed', revision: (afterDispose?.revision ?? 0) + 1 },
      { confirmedResetReason: current.value?.confirmedResetReason, revision: afterConfirm?.revision });

    const revisions = [afterOpen, afterClose, afterDispose, afterConfirm].map((row) => row?.revision ?? null);
    check('T07 同一 (group, actor) 内 revision 单调不回退',
      revisions.every((value, index) => index === 0 || value === null || value >= revisions[index - 1]),
      'monotonic', revisions);
    const afterConfirmEval = await call('browser_eval', { expression: '1' }, execM3);
    check('T07 确认后仍无自有页 → 仍是 TARGET_NOT_BOUND（回到"先 open"的语义）',
      afterConfirmEval.error?.code === 'TARGET_NOT_BOUND'
      && afterConfirmEval.error?.details?.reason === 'no-work-page',
      { code: 'TARGET_NOT_BOUND', reason: 'no-work-page' },
      { code: afterConfirmEval.error?.code, reason: afterConfirmEval.error?.details?.reason });
  }

} catch (error) {
  check('T01–T06 场景执行完成（无未捕获异常）', false, 'no exception', String((error && (error.stack || error.message)) || error));
} finally {
  try { await teamHarness.closeBrowser(); } catch { /* best effort */ }
  try { await teamHarness.dispose(); } catch { /* best effort */ }
  await new Promise((resolve) => server.close(resolve));

  const failed = results.filter((result) => !result.pass).length;
  const stamp = new Date().toISOString().replace(/[:.]/gu, '-');
  const dir = `tests/acceptance/runs/team-tab-access-${stamp}-${process.pid}`;
  await mkdir(dir, { recursive: true });
  await writeFile(`${dir}/report.json`, JSON.stringify({
    generatedAt: new Date().toISOString(),
    summary: { checks: results.length, passed: results.length - failed, failed, notRun: notRuns.length, knownGaps: gaps.length },
    checks: results,
    notRuns,
    knownGaps: gaps,
  }, null, 2));
  log(`evidence: ${dir}`);
  log(`\nRESULT ${failed ? 'FAIL' : 'PASS'} (${failed} failed, ${results.length} checks, `
    + `${notRuns.length} NOT_RUN, ${gaps.length} KNOWN_GAP)`);
  log(`exit ${failed ? 1 : 0}`);
  process.exit(failed ? 1 : 0);
}
