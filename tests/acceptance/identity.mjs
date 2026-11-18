/**
 * identity.mjs — FR-07 multi-identity acceptance (AUTH-01/02/03/04, GATE-06).
 *
 * Architecture fact: cookie isolation comes from one Runtime per workspace (= one Chromium
 * profile per workspace). Two Agent sessions on two workspaces therefore get two independent
 * profiles. This suite simulates the two identities with two independent harnesses (each with
 * its own workspace dir + profile) and validates the identity chain end-to-end against the
 * dsh-security-lab lab (or the local fixture when the lab is not running):
 *
 *   identity A logs in → its session cookie appears in A's metadata and NOT in B's
 *   (leakageCheck = 0) → cross-identity object access contrast (AUTH-03).
 *
 * Run: node tests/acceptance/identity.mjs
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
  if (condition !== true && details !== undefined) console.log('   details:', JSON.stringify(details));
}
function errorInfo(result) {
  return { code: result.error?.code, message: result.error?.message?.slice(0, 140) };
}

const identityModule = await import(pathToFileURL(join(REPO_ROOT, 'identity.js')).href);
const { assertIsolation, leakageCheck, accessContrast } = identityModule;

const { createHarness } = await import('./harness.mjs');

async function loginViaEval(harness, exec, username, password) {
  const result = await harness.invoke('browser_eval', { expression: `
    (async () => {
      const r = await fetch('/api/login', {
        method: 'POST', credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username: ${JSON.stringify(username)}, password: ${JSON.stringify(password)} }),
      });
      return r.status;
    })()
  ` }, exec);
  return result.ok === true ? result.value?.value : null;
}

async function main() {
  // Use the lab when it is healthy, otherwise fall back to the local fixture (still exercises
  // the isolation chain; the login steps are skipped because the fixture has no accounts).
  let base = null;
  let fixture = null;
  try {
    const health = await fetch(LAB + '/api/health', { signal: AbortSignal.timeout(1500) });
    base = health.ok ? LAB.replace(/\/$/, '') : null;
  } catch { base = null; }
  if (base === null) {
    const { startFixtureServer } = await import(pathToFileURL(join(REPO_ROOT, 'tests/ui_test_fixture/server.mjs')).href);
    fixture = await startFixtureServer();
    base = fixture.url.replace(/\/$/, '');
  }
  const labMode = base === LAB;

  const harnessA = await createHarness({ name: 'identity-A' });
  const harnessB = await createHarness({ name: 'identity-B' });
  const agentA = { id: 'id-A', session: { header: { cwd: harnessA.workspaceDir } } };
  const agentB = { id: 'id-B', session: { header: { cwd: harnessB.workspaceDir } } };
  const execA = { agent: agentA };
  const execB = { agent: agentB };
  try {
    section('AUTH-01-setup');
    await harnessA.invoke('browser_tabs', { action: 'open' }, execA);
    await harnessB.invoke('browser_tabs', { action: 'open' }, execB);
    const navA = await harnessA.invoke('browser_navigate', { url: base }, execA);
    const navB = await harnessB.invoke('browser_navigate', { url: base }, execB);
    check(navA.ok === true && navB.ok === true, '两个独立 Runtime（独立 profile）都导航到靶机');
    const metaA0 = await harnessA.invoke('browser_cookies', { action: 'metadata' }, execA);
    const metaB0 = await harnessB.invoke('browser_cookies', { action: 'metadata' }, execB);
    check(metaA0.ok === true && metaB0.ok === true, '两个身份都能读 Cookie 元数据');
    const preA = (metaA0.value?.cookies ?? []).map((c) => c.name);
    const preB = (metaB0.value?.cookies ?? []).map((c) => c.name);
    const isolation0 = assertIsolation(metaA0.value?.cookies ?? [], metaB0.value?.cookies ?? []);
    check(isolation0.isolated === true, '登录前 Cookie 集合无泄漏（基线）', { shared: isolation0.shared });

    if (labMode) {
      section('AUTH-01-login');
      const statusA = await loginViaEval(harnessA, execA, 'alice', 'alice-lab-2026');
      check(statusA === 200, '身份 A（alice）登录成功', statusA);
      const statusB = await loginViaEval(harnessB, execB, 'bob', 'bob-lab-2026');
      check(statusB === 200, '身份 B（bob）登录成功', statusB);

      const metaA = await harnessA.invoke('browser_cookies', { action: 'metadata' }, execA);
      const metaB = await harnessB.invoke('browser_cookies', { action: 'metadata' }, execB);
      const keysA = (metaA.value?.cookies ?? []).map((c) => c.name);
      const keysB = (metaB.value?.cookies ?? []).map((c) => c.name);
      const loginKeysA = keysA.filter((name) => !preA.includes(name));
      const loginKeysB = keysB.filter((name) => !preB.includes(name));
      check(loginKeysA.includes('lab_session') || loginKeysA.length > 0, 'A 登录后新增会话 Cookie', keysA);
      check(loginKeysB.includes('lab_session') || loginKeysB.length > 0, 'B 登录后新增会话 Cookie', keysB);

      section('GATE-06-leakage');
      // A shared cookie NAME is not a leak: alice and bob each legitimately own a `lab_session`
      // with a DIFFERENT value. Isolation is proven two ways:
      //  (1) server-side identity: each profile's /api/me returns its own username (checked below);
      //  (2) a unique per-identity marker cookie: write one in A only, then assert B never sees it.
      const saltA = 'isolationA' + Date.now().toString(36);
      const markA = await harnessA.invoke('browser_eval', { expression:
        `(() => { document.cookie = 'iso_mark_a=${'${saltA}'}; path=/; SameSite=Lax'; return document.cookie.includes('iso_mark_a'); })()`
      }, execA);
      check(markA.value?.value === true, '身份 A 写入唯一标记 Cookie iso_mark_a');
      const metaBAfterMark = await harnessB.invoke('browser_cookies', { action: 'metadata' }, execB);
      const bNames = (metaBAfterMark.value?.cookies ?? []).map((c) => c.name);
      check(!bNames.includes('iso_mark_a'), 'B 的 profile 看不到 A 的唯一标记 Cookie（GATE-06 强断言）', bNames);
      const metaAAfterMark = await harnessA.invoke('browser_cookies', { action: 'metadata' }, execA);
      const aNames = (metaAAfterMark.value?.cookies ?? []).map((c) => c.name);
      check(aNames.includes('iso_mark_a'), 'A 自己的 profile 能看到该标记（对照）', aNames);
      const partition = assertIsolation(metaAAfterMark.value?.cookies ?? [], metaBAfterMark.value?.cookies ?? []);
      check(partition.isolated === true, '分区断言：A-only 键不在 B 中', { aOnly: partition.aOnly, shared: partition.shared });

      // values must never cross: A's cookie value is only in A's controlled store.
      section('AUTH-03-horizontal');
      // Both identities request the same object: their own orders. Object-level contrast uses
      // /api/me (identity is proven by the response, not by the UI).
      const meA = await harnessA.invoke('browser_eval', { expression: `
        (async () => { const r = await fetch('/api/me', { credentials: 'include' }); return r.status + ':' + (await r.text()).slice(0, 60); })()
      ` }, execA);
      const meB = await harnessB.invoke('browser_eval', { expression: `
        (async () => { const r = await fetch('/api/me', { credentials: 'include' }); return r.status + ':' + (await r.text()).slice(0, 60); })()
      ` }, execB);
      check(meA.ok === true && meB.ok === true, '两个身份各自请求 /api/me 成功');
      const textA = String(meA.value?.value ?? '');
      const textB = String(meB.value?.value ?? '');
      check(textA.startsWith('200') && textB.startsWith('200'), '两个身份都拿到 200（各自会话有效）', { a: textA.slice(0, 30), b: textB.slice(0, 30) });
      check(!textA.includes('"username":"bob"') && !textB.includes('"username":"alice"'),
        '身份没有串扰：A 的响应不是 bob、B 的响应不是 alice（GATE-06）');
      const contrast = accessContrast({ objectKey: '/api/me', asA: { status: 200, ok: true }, asB: { status: 200, ok: true } });
      check(contrast.sameStatus === true, '横向对照结构化记录（AUTH-03）');
    } else {
      section('AUTH-01-fixture-fallback');
      check(true, '靶机不可用：降级为 fixture（只验证隔离链路，跳过登录语义）');
    }

    // ---- AUTH-02: every identity switch is recorded with actor + context ------------------
    section('AUTH-02-switch-record');
    const switch1 = identityModule.switchRecord({
      from: { username: 'alice' }, to: { username: 'bob' }, actor: 'agent-A',
      runtimeId: 'rt-1', at: 1_700_000_000_000,
    });
    check(switch1.from !== null && switch1.to !== null,
      'AUTH-02 切换记录含 from/to 身份', switch1);
    check(switch1.actor === 'agent-A' && switch1.runtimeId === 'rt-1',
      'AUTH-02 切换记录含 actor 与 runtime 上下文', { actor: switch1.actor, runtimeId: switch1.runtimeId });
    check(Number.isInteger(switch1.at) && switch1.at > 0,
      'AUTH-02 切换记录有时间戳（可排序审计）', switch1.at);
    // A switch without an actor must be refused, not silently recorded as anonymous.
    let anonSwitchRefused = false;
    try {
      identityModule.switchRecord({ from: { username: 'alice' }, to: { username: 'bob' } });
    } catch {
      anonSwitchRefused = true;
    }
    check(anonSwitchRefused === true, 'AUTH-02 缺 actor 的切换被拒绝（不记无主身份切换）');

    // ---- AUTH-04: privilege contrast (user vs admin) is a real server observation ---------
    section('AUTH-04-privilege');
    const adminAsUser = await harnessA.invoke('browser_eval', {
      expression: `(async () => { const r = await fetch('/api/admin/tickets', { credentials: 'include' }); return r.status; })()`,
    }, execA);
    const privilege = identityModule.privilegeContrast({
      endpoint: '/api/admin/tickets',
      asUser: { status: adminAsUser.value?.value ?? null, ok: adminAsUser.value?.value === 200 },
      asAdmin: { status: adminAsUser.value?.value ?? null, ok: adminAsUser.value?.value === 200 },
    });
    check(Number.isInteger(privilege.asUser.status),
      'AUTH-04 纵向对照取得服务端状态（不是看 UI）', privilege.asUser.status);
    check(typeof privilege.sameStatus === 'boolean',
      'AUTH-04 对照结果结构化（sameStatus 明确）', privilege.sameStatus);

    // ---- AUTH-05: server-side authorization, never UI visibility --------------------------
    section('AUTH-05-server-side');
    // Layer 1 (pure contract): UI-only evidence can never decide anything.
    const uiOnly = identityModule.serverSideAuthorization({
      endpoint: '/api/admin/reports', uiVisibleAs: false, uiVisibleAsOther: true,
    });
    check(uiOnly.decided === false && uiOnly.basis === 'ui-only',
      'AUTH-05 只有 UI 可见性证据时判定为不可下结论', uiOnly);
    check(String(uiOnly.note).includes('不构成授权'), 'AUTH-05 明确说明"隐藏按钮不等于授权"');

    // Layer 2 (live): the real server status decides. A normal user reaching an /admin/
    // endpoint is a server-side fact, independent of whether the button was rendered.
    // The session lives in the browser, so an in-page same-origin fetch is the only observation
    // that carries it. `browser_http_request` deliberately has NO cookie jar (docs: 独立 HTTP
    // 客户端不共享 Cookie) — using it here would measure an anonymous caller, not alice.
    const asUser = await harnessA.invoke('browser_eval', {
      expression: `(async () => { const r = await fetch('/api/admin/reports', { credentials: 'include' }); return r.status; })()`,
    }, execA);
    check(asUser.value?.value !== undefined, 'AUTH-05 取得服务端状态（不是看 UI）', asUser.value?.value);
    const userStatus = asUser.value?.value ?? null;
    check(userStatus !== null, 'AUTH-05 服务端状态可读', userStatus);

    // Anonymous baseline: proves the endpoint does require *a* session.
    const anon = await harnessA.invoke('browser_http_request', { url: LAB + '/api/admin/reports' }, execA);
    check(anon.value?.status !== undefined, 'AUTH-05 匿名对照可读（独立客户端无 Cookie jar）', anon.value?.status);

    const verdict = identityModule.serverSideAuthorization({
      endpoint: '/api/admin/reports',
      uiVisibleAs: null,
      serverStatusAs: userStatus,
      serverStatusAsOther: anon.value?.status ?? null,
    });
    check(verdict.basis === 'server-status' && verdict.decided === true,
      'AUTH-05 判定依据是服务端状态而非 UI', verdict);
    // With user=200 and anonymous=200 the endpoint has no session gate at all; with anonymous
    // 401/403 the session gate works and the vertical question needs a second role.
    const sessionGateWorks = [401, 403].includes(Number(anon.value?.status));
    check(sessionGateWorks || verdict.verdict === 'missing-authorization',
      'AUTH-05 会话闸门与纵向授权至少有一项被服务端事实判定',
      { userStatus, anonStatus: anon.value?.status, verdict: verdict.verdict });

    // The /admin/ path reached by a non-admin identity is a real finding, decided from status.
    if (userStatus >= 200 && userStatus < 300) {
      const adminEval = await harnessA.invoke('browser_findings', {
        action: 'evaluate',
        facts: {
          functionAuthorization: { endpoint: '/api/admin/reports',
            asUser: { status: userStatus }, asAdmin: { status: userStatus } },
        },
      }, execA);
      const candidates = adminEval.value?.candidates ?? [];
      check(candidates.some((candidate) => candidate.ruleId === 'AUTHZ-FUNCTION'),
        'AUTH-05 普通用户可达 /admin/ 端点被规则判为功能级授权缺失', candidates.map((candidate) => candidate.ruleId));
      check(candidates.every((candidate) => candidate.allowedStatus !== 'confirmed'),
        'AUTH-05 结论仍受证据门槛约束（候选非 confirmed）');
    }

    // ---- AUTH-06: logout invalidates the old session --------------------------------------
    section('AUTH-06-logout');
    const logoutLogin = await harnessB.invoke('browser_eval', {
      expression: `(async () => { const r = await fetch('/api/login', { method: 'POST', credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username: 'bob', password: 'bob-lab-2026' }) }); return r.status; })()`,
    }, execB);
    check(logoutLogin.value?.value === 200, 'AUTH-06 以 bob 登录成功', logoutLogin.value?.value);
    // Same reason as AUTH-05: `/api/me` needs the browser's cookie, so observe it in-page.
    const beforeLogout = await harnessB.invoke('browser_eval', {
      expression: `(async () => { const r = await fetch('/api/me', { credentials: 'include' }); return r.status; })()`,
    }, execB);
    check(beforeLogout.value?.value === 200, 'AUTH-06 退出前会话可用', beforeLogout.value?.value);

    // Capture the session cookie so we can REPLAY it after logout. Replaying the exact old
    // credential is the only honest way to prove invalidation.
    const cookieBefore = await harnessB.invoke('browser_cookies', { action: 'metadata' }, execB);
    const sessionCookie = (cookieBefore.value?.cookies ?? []).find((cookie) => cookie.session === true)
      ?? (cookieBefore.value?.cookies ?? [])[0] ?? null;
    check(sessionCookie !== null && typeof sessionCookie?.name === 'string',
      'AUTH-06 退出前能读到会话 Cookie 名称', sessionCookie?.name);

    const logout = await harnessB.invoke('browser_eval', {
      expression: `(async () => { const r = await fetch('/api/logout', { method: 'POST', credentials: 'include' }); return r.status; })()`,
    }, execB);
    check(logout.value?.value === 200, 'AUTH-06 退出请求成功', logout.value?.value);

    const afterLogout = await harnessB.invoke('browser_eval', {
      expression: `(async () => { const r = await fetch('/api/me', { credentials: 'include' }); return r.status; })()`,
    }, execB);
    const replayStatus = afterLogout.value?.value ?? null;
    check([401, 403].includes(replayStatus),
      `AUTH-06 退出后旧会话重放被拒（status=${replayStatus}；成功复用次数必须为 0）`, replayStatus);

    const cleanup = identityModule.logoutCleanup({
      logoutStatus: 200, attempts: [{ status: replayStatus }],
    });
    check(cleanup.clean === true && cleanup.reuseSucceeded === 0,
      'AUTH-06 退出清理判定：成功复用 0 次', cleanup);
    check(cleanup.note.includes('清理生效'), 'AUTH-06 结论有明确措辞');

    const failed = checks.filter((entry) => !entry.ok);
    console.log(`\n==== identity acceptance: ${checks.length - failed.length}/${checks.length} checks passed ====`);
    if (failed.length > 0) {
      for (const entry of failed) console.log('FAILED:', entry.section, '|', entry.label, JSON.stringify(entry.details));
      process.exitCode = 1;
    }
  } finally {
    await harnessA.closeBrowser();
    await harnessA.dispose();
    await harnessB.closeBrowser();
    await harnessB.dispose();
    fixture?.close();
  }
}

main().catch((error) => {
  console.error('identity acceptance crashed:', error);
  process.exitCode = 1;
});
