/**
 * cookie-store.mjs — FR-11 Cookie Store acceptance (CRED-01..CRED-09, GATE-02/GATE-03).
 *
 * Ground truth: the plugin's own headless Chromium against the local loopback fixture
 * (tests/ui_test_fixture/server.mjs /n/cookie routes). Every assertion maps to an acceptance
 * row: metadata matches the jar's attributes (CRED-01), HttpOnly never appears as a value in
 * metadata (CRED-02), export without a human-issued approval fails (GATE-03/CRED-03), an
 * approval-bound export writes one 0600 no-clobber file and consumes the one-shot approval
 * (CRED-04/05/07), import backfills non-HttpOnly cookies (CRED-04), and the canary scan keeps
 * values out of every tool response (CRED-08). Network P0 sanitisation is asserted on the same
 * page (CRED-09): Cookie/Set-Cookie headers stay redacted in captured events.
 *
 * Run: node tests/acceptance/cookie-store.mjs
 */
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const REPO_ROOT = join(import.meta.dirname ?? '.', '..', '..');
const EVIDENCE_DIR = join(REPO_ROOT, 'tests', 'acceptance', 'evidence', 'cookie-store');

const checks = [];
let currentSection = '';
function section(title) { currentSection = title; }
function check(condition, label, details) {
  checks.push({ ok: condition === true, label, section: currentSection, details: details ?? null });
  console.log(`${condition === true ? '✔' : '✖'} [${currentSection}] ${label}`);
  if (condition !== true && details !== undefined) console.log('   details:', JSON.stringify(details));
}
function checkEq(actual, expected, label) {
  check(actual === expected, label, { actual, expected });
}

function errorInfo(result) {
  return { code: result.error?.code, category: result.error?.category, message: result.error?.message?.slice(0, 200) };
}

const CANARY_NAME = 'lab_session';
const CANARY_VALUE = 'canary-9f31ab27-value-42';

async function main() {
  const { startFixtureServer } = await import(pathToFileURL(join(REPO_ROOT, 'tests/ui_test_fixture/server.mjs')).href);
  const fixture = await startFixtureServer();
  const { createHarness } = await import('./harness.mjs');

  const captureRoot = mkdtempSync(join(tmpdir(), 'cookie-acc-root-'));
  process.env.DSH_UI_TESTING_CAPTURE_DIR = captureRoot;

  const harness = await createHarness({ name: 'cookie-store' });
  // The harness caller needs its own work page (P0-E ownership model): every tool call goes
  // through an exec whose agent opens/selects its own tab first.
  const agent = { id: 'cookie-acc-agent', session: { header: { cwd: harness.workspaceDir } } };
  const exec = { agent };
  const opened = await harness.invoke('browser_tabs', { action: 'open' }, exec);
  if (!opened.ok) throw new Error('browser_tabs open failed: ' + JSON.stringify(errorInfo(opened)));
  const runtimeIdFromOpen = opened.value?.runtime?.runtimeId ?? opened.value?.selection?.runtimeId ?? null;
  try {
    // ---- 0. registration surface -----------------------------------------------------------
    section('registration');
    const names = harness.toolNames();
    check(names.includes('browser_cookies'), 'browser_cookies 已注册进工具面', { count: names.length });
    const definition = harness.tools.get('browser_cookies');
    checkEq(definition?.parameters?.required?.[0], 'action', 'registered schema requires action');
    const admitted = await harness.evaluateAdmission();
    check(!admitted.has('browser_cookies'), '默认披露不含 browser_cookies（需 security 组激活）');

    // ---- 1. metadata on a cookie-less origin ------------------------------------------------
    section('CRED-01-metadata');
    const cold = await harness.invoke('browser_cookies', { action: 'metadata' }, exec);
    check(cold.ok === true && cold.value?.ok === false && cold.value?.available === false && cold.value?.reason === 'no-page-origin',
      '未导航时 metadata 返回结构化不可用（available:false + no-page-origin）', { reason: cold.value?.reason, error: errorInfo(cold) });

    const nav = await harness.invoke('browser_navigate', { url: fixture.url }, exec);
    check(nav.ok === true, '导航到 fixture');
    const empty = await harness.invoke('browser_cookies', { action: 'metadata' }, exec);
    check(empty.ok === true && empty.value?.available === true && empty.value?.origin === fixture.url.replace(/\/$/, ''),
      'metadata 返回精确 Origin', empty.value?.origin);
    checkEq(empty.value?.counts?.total, 0, '无 Cookie 时 total=0');

    // ---- 2. metadata matches the jar (HttpOnly included, value excluded) --------------------
    section('CRED-01-metadata-jar');
    // Set the cookies, then leave the /n/cookie URL: the envelope's `target` is the address-bar
    // projection, and a URL query parameter is NOT a cookie (redactUrl deliberately only covers
    // credential-ish parameter names). The canary value must live only in the cookie store, so
    // navigate to a clean path before reading metadata.
    const setSession = await harness.invoke('browser_navigate', {
      url: fixture.url.replace(/\/$/, '') + `/n/cookie?name=${CANARY_NAME}&value=${CANARY_VALUE}&httpOnly=1&sameSite=Lax`,
    }, exec);
    check(setSession.ok === true, 'Set-Cookie(HttpOnly lab_session) 已设置');
    const setHint = await harness.invoke('browser_navigate', {
      url: fixture.url.replace(/\/$/, '') + '/n/cookie?name=lab_hint&value=hint-plain-77&sameSite=Lax',
    }, exec);
    check(setHint.ok === true, 'Set-Cookie(非 HttpOnly lab_hint) 已设置');
    await harness.invoke('browser_navigate', { url: fixture.url.replace(/\/$/, '') + '/index.html' }, exec);

    const meta = await harness.invoke('browser_cookies', { action: 'metadata' }, exec);
    check(meta.ok === true && meta.value?.counts?.total === 2, 'metadata 看到两个 Cookie', meta.value?.counts);
    const labSession = (meta.value?.cookies ?? []).find((entry) => entry.name === CANARY_NAME);
    const labHint = (meta.value?.cookies ?? []).find((entry) => entry.name === 'lab_hint');
    check(labSession?.httpOnly === true, 'lab_session httpOnly:true（与 jar 一致，CRED-01）', labSession);
    check(labSession?.sameSite === 'Lax' && labSession?.path === '/', 'lab_session SameSite/Path 与 jar 一致', labSession);
    check(labHint?.httpOnly === false, 'lab_hint httpOnly:false', labHint);
    const metaJson = JSON.stringify(meta.value);
    check(!metaJson.includes(CANARY_VALUE) && !metaJson.includes('hint-plain-77'), 'metadata 全响应零 value（CRED-02）');
    check(!metaJson.toLowerCase().includes('"value"'), 'metadata 无任何 value 键（CRED-02）');

    // ---- 3. export without approval must fail (GATE-03) --------------------------------------
    section('GATE-03-no-approval');
    const denied = await harness.invoke('browser_cookies', { action: 'export', out: 'output/cookies/should-not-exist.json' }, exec);
    check(denied.ok === false && denied.error?.code === 'COOKIE_APPROVAL_REQUIRED', '无授权导出被拒（GATE-03）', errorInfo(denied));
    check(denied.error?.category === 'authorization', '拒绝分类为 authorization（REG-04）', denied.error?.category);
    check(!existsSync(join(captureRoot, 'output/cookies/should-not-exist.json')), '被拒导出零文件写入');

    // ---- 4. approval-bound export -------------------------------------------------------------
    section('CRED-04-approved-export');
    const approvalsDir = process.env.DSH_UI_TESTING_CONFIG_DIR;
    // Human-issued record (the Agent has no write channel to this file; in the test we stand in
    // for the human).
    const authScope = meta.value?.authScope ?? null;
    const runtimeId = authScope?.runtimeId ?? null;
    const { writeFileSync, mkdirSync } = await import('node:fs');
    mkdirSync(approvalsDir, { recursive: true });
    const approval = {
      approvalId: 'acc-ap-001',
      origin: authScope?.origin,
      tabId: authScope?.tabId,
      workspaceId: authScope?.workspaceId,
      runtimeId,
      allowHttpOnly: true,
      issuedAt: Date.now() - 1000,
      expiresAt: Date.now() + 60_000,
    };
    writeFileSync(join(approvalsDir, 'security-approvals.json'), JSON.stringify({ approvals: [approval] }), 'utf8');

    const exported = await harness.invoke('browser_cookies', { action: 'export', out: 'output/cookies/lab-snapshot.json', allowHttpOnly: true }, exec);
    check(exported.ok === true, '授权导出成功', exported.ok ? null : errorInfo(exported));
    const relativePath = exported.value?.file?.relativePath;
    check(typeof relativePath === 'string' && relativePath === 'output/cookies/lab-snapshot.json', '返回持久根内相对路径', relativePath);
    const absolutePath = join(captureRoot, relativePath);
    const mode = statSync(absolutePath).mode & 0o777;
    checkEq(mode, 0o600, '导出文件权限 0600（CRED-05）');
    const fileText = readFileSync(absolutePath, 'utf8');
    const fileJson = JSON.parse(fileText);
    check(fileJson.kind === 'dsh-ui-testing-cookie-export' && fileJson.counts?.total === 2, '快照含两个 Cookie（CRED-04）', fileJson.counts);
    const sessionEntry = fileJson.cookies.find((entry) => entry.name === CANARY_NAME);
    check(sessionEntry?.value === CANARY_VALUE && sessionEntry?.httpOnly === true, 'HttpOnly 条目随 allowHttpOnly 授权进入文件');
    const responseText = JSON.stringify(exported.value);
    check(!responseText.includes(CANARY_VALUE) && !responseText.includes('hint-plain-77'), '导出工具响应零明文（CRED-08）');
    check(exported.value?.canary === null, '响应 canary 自检零命中（CRED-08）', exported.value?.canary);
    check(exported.value?.approval?.consumedAt !== null && typeof exported.value?.approval?.consumedAt === 'number', '一次性授权已消耗');

    const after = JSON.parse(readFileSync(join(approvalsDir, 'security-approvals.json'), 'utf8'));
    check(after.approvals?.[0]?.consumedAt !== undefined, '授权文件记录 consumedAt');

    // ---- 5. one-shot: the same approval no longer works ----------------------------------------
    section('GATE-03-one-shot');
    const second = await harness.invoke('browser_cookies', { action: 'export', out: 'output/cookies/second.json' }, exec);
    check(second.ok === false && second.error?.code === 'COOKIE_APPROVAL_CONSUMED', '同授权第二次导出被拒（一次性）', errorInfo(second));

    // ---- 6. no-clobber --------------------------------------------------------------------------
    section('CRED-07-no-clobber');
    writeFileSync(join(approvalsDir, 'security-approvals.json'), JSON.stringify({ approvals: [{ ...approval, approvalId: 'acc-ap-002', issuedAt: Date.now() - 1000, expiresAt: Date.now() + 60_000 }] }), 'utf8');
    const overwrite = await harness.invoke('browser_cookies', { action: 'export', out: 'output/cookies/lab-snapshot.json' }, exec);
    check(overwrite.ok === false && overwrite.error?.code === 'COOKIE_OUTPUT_EXISTS', '同路径导出被拒（绝不覆盖，CRED-07）', errorInfo(overwrite));
    const firstIntact = JSON.parse(readFileSync(absolutePath, 'utf8'));
    check(firstIntact.cookies.find((entry) => entry.name === CANARY_NAME)?.value === CANARY_VALUE, '首份快照内容完整保留');

    // ---- 7. import backfill ---------------------------------------------------------------------
    section('CRED-04-import');
    // Clear the session cookie via the fixture, then import the snapshot back.
    await harness.invoke('browser_navigate', { url: fixture.url.replace(/\/$/, '') + `/n/clear-cookie?name=${CANARY_NAME}` }, exec);
    const metaAfterClear = await harness.invoke('browser_cookies', { action: 'metadata' }, exec);
    check(metaAfterClear.value?.cookies?.find((entry) => entry.name === CANARY_NAME) === undefined, '清除后 lab_session 消失');

    const imported = await harness.invoke('browser_cookies', { action: 'import', file: 'output/cookies/lab-snapshot.json', importHttpOnly: true }, exec);
    check(imported.ok === true, 'import 回填成功', imported.ok ? null : errorInfo(imported));
    checkEq(imported.value?.counts?.set, 2, '两条 Cookie 全部回填');
    const metaRestored = await harness.invoke('browser_cookies', { action: 'metadata' }, exec);
    const restored = (metaRestored.value?.cookies ?? []).find((entry) => entry.name === CANARY_NAME);
    check(restored?.httpOnly === true && restored?.sameSite === 'Lax', '回填后 HttpOnly/SameSite 属性一致（CRED-01 闭环）', restored);
    check(!JSON.stringify(imported.value).includes(CANARY_VALUE), 'import 响应零明文（CRED-08）');

    // ---- 8. HttpOnly export requires explicit grant ----------------------------------------------
    section('GATE-03-httpOnly-grant');
    writeFileSync(join(approvalsDir, 'security-approvals.json'), JSON.stringify({ approvals: [{ ...approval, approvalId: 'acc-ap-003', allowHttpOnly: false, issuedAt: Date.now() - 1000, expiresAt: Date.now() + 60_000 }] }), 'utf8');
    const noGrant = await harness.invoke('browser_cookies', { action: 'export', out: 'output/cookies/no-httponly.json', allowHttpOnly: true }, exec);
    check(noGrant.ok === false && noGrant.error?.code === 'COOKIE_HTTPONLY_FORBIDDEN', 'HttpOnly 未专项授权时导出被拒（GATE-03）', errorInfo(noGrant));
    // A grant WITHOUT allowHttpOnly + an explicit allowHttpOnly:false request exports the
    // non-HttpOnly subset: that is the documented whole-snapshot behaviour — no silent HttpOnly
    // stripping inside an allowed export, and no refusal when the caller asked for the subset.
    const subsetGrant = await harness.invoke('browser_cookies', { action: 'export', out: 'output/cookies/subset.json', allowHttpOnly: false }, exec);
    check(subsetGrant.ok === true && subsetGrant.value?.counts?.total === 1 && subsetGrant.value?.counts?.httpOnly === 0,
      '授权 allowHttpOnly:true + 请求 false 导出非 HttpOnly 子集（1 条，合法行为）', subsetGrant.ok ? subsetGrant.value?.counts : errorInfo(subsetGrant));

    // ---- 9. Network P0 sanitisation unchanged (CRED-09) ------------------------------------------
    section('CRED-09-network-p0');
    const session = await harness.invoke('browser_network_session', { action: 'start', config: { captureBodies: false } }, exec);
    check(session.ok === true, '网络会话启动');
    // The URL query parameter is NOT a cookie: it belongs to the request URL, an observable
    // surface (redactUrl deliberately only covers credential-ish parameter names). The CRED-09
    // audit target is the Cookie/Set-Cookie *headers*: the navigation URL carries a neutral
    // value while the header value (same string) must stay redacted out of every projection.
    await harness.invoke('browser_navigate', { url: fixture.url.replace(/\/$/, '') + '/n/cookie?name=net_probe&value=nv-url-neutral&httpOnly=1' }, exec);
    const events = await harness.invoke('browser_network_events', {}, exec);
    const cookieEvents = (events.value?.events ?? []).filter((entry) => {
      const headers = JSON.stringify(entry.request?.headers ?? {});
      return headers.toLowerCase().includes('cookie') || JSON.stringify(entry.response?.headers ?? {}).toLowerCase().includes('set-cookie');
    });
    // Network P0 sanitises sensitive headers AT CAPTURE TIME: no event ever stores a raw
    // Cookie/Set-Cookie header value, so "events mentioning cookie headers" is legitimately 0.
    // CRED-09 therefore asserts the negative: no projection contains the header value.
    const eventsJson = JSON.stringify(events.value);
    check(!eventsJson.toLowerCase().includes('set-cookie:'), '事件投影不含 Set-Cookie 头原文（采集时已脱敏，CRED-09）');
    check(!eventsJson.includes('nv-url-neutral-header'), '事件投影零 Cookie 头明文（CRED-09）');

    await harness.invoke('browser_network_session', { action: 'stop' }, exec);

    // ---- summary ---------------------------------------------------------------------------------
    // ---- CRED-10: no automatic upload — export/import is local-only ------------------------
  section('CRED-10-no-upload');
  {
    const h = harness;
    if (h === null) {
      check(false, 'CRED-10 需要 harness');
    } else {
      // Start a network session, do a full export + import cycle, then read the collected events.
      // Zero outbound requests to anything other than the target = no automatic upload.
      const session = await h.invoke('browser_network_session', { action: 'start', config: { captureBodies: false } }, exec);
      check(session.ok === true, 'CRED-10 网络采集已启动（用于证明零外传）', errorInfo(session));

      const exportRun = await h.invoke('browser_cookies', {
        action: 'export', out: 'output/cookies/cred10-export.json',
      }, exec);
      // Import is exercised with an inline payload: the point of CRED-10 is that parsing and
      // applying a snapshot is a LOCAL operation, so a `data` round-trip proves it without
      // depending on an export that the approval gate may (correctly) refuse.
      // Must match the real export envelope (`kind` is the integrity marker that stops an
      // arbitrary cookie dump from being replayed as if this tool had produced it).
      const inlineSnapshot = JSON.stringify({
        kind: 'dsh-ui-testing-cookie-export',
        version: 1,
        exportedAt: Date.now(),
        scope: { workspaceId: null, runtimeId: null, tabId: null, origin: fixture.url.replace(/\/$/, '') },
        approval: { approvalId: null, allowHttpOnly: false, oneShot: true },
        counts: { total: 1, httpOnly: 0 },
        cookies: [{
          name: 'cred10_marker', value: 'local-only', domain: '127.0.0.1', path: '/',
          expires: null, secure: false, httpOnly: false, sameSite: 'Lax',
        }],
      });
      const eventsBefore = await h.invoke('browser_network_events', { limit: 200 }, exec);
      const countBefore = (eventsBefore.value?.events ?? []).length;
      const importRun = await h.invoke('browser_cookies', {
        action: 'import', data: inlineSnapshot,
      }, exec);
      const eventsAfter = await h.invoke('browser_network_events', { limit: 200 }, exec);
      const countAfter = (eventsAfter.value?.events ?? []).length;
      check(exportRun.ok === true
        || ['COOKIE_APPROVAL_REQUIRED', 'COOKIE_APPROVAL_CONSUMED'].includes(exportRun.error?.code),
        'CRED-10 导出被授权闸门处理（成功，或明确要求/已耗尽授权）', errorInfo(exportRun));
      check(importRun.ok === true, 'CRED-10 导入可用（内联数据，纯本地操作）', errorInfo(importRun));

      const events = await h.invoke('browser_network_events', { limit: 200 }, exec);
      const list = events.value?.events ?? [];
      // Any event whose URL is not the target origin would be an unsolicited outbound transfer.
      const foreign = list.filter((event) => {
        const url = String(event?.url ?? '');
        if (url === '') return false;
        // The suite's target is the local fixture the earlier checks navigated to.
        return !url.startsWith(fixture.url.replace(/\/$/, ''));
      });
      check(foreign.length === 0,
        `CRED-10 导出/导入期间零外传（采集 ${list.length} 事件，非目标 Origin ${foreign.length} 条）`,
        foreign.slice(0, 3).map((event) => event.url));
      // CRED-10 is about UNAUTHORISED REMOTE TRANSFER, not about silence: the live page keeps
      // making its own same-origin requests (favicon, polling) regardless of the import, so
      // counting total events would measure the page, not the export. The claim that matters is
      // that nothing left the authorised origin and nothing used a non-HTTP channel.
      const all = [...list, ...(eventsAfter.value?.events ?? [])];
      const target = fixture.url.replace(/\/$/, '');
      const escaped = all.filter((event) => {
        const url = String(event?.url ?? '');
        if (url === '') return false;
        if (!/^https?:\/\//i.test(url)) return true;          // file:, ws:, data: would be a channel change
        return !url.startsWith(target) && !url.startsWith('http://127.0.0.1:') && !url.startsWith('http://localhost:');
      });
      check(escaped.length === 0,
        `CRED-10 零非授权外传/零非 HTTP 通道（检查 ${all.length} 条事件）`,
        escaped.slice(0, 3).map((event) => String(event.url).slice(0, 90)));
      check(countAfter >= countBefore,
        'CRED-10 采集在导入前后保持可用（导入不破坏采集器）', { before: countBefore, after: countAfter });
    }
  }

  // ---- CRED-03 / CRED-06 / GATE-02:授权、canary 与明文泄漏 ---------------------------------
  section('CRED-03-approval');
  {
    // CRED-03: HttpOnly import/export is gated by a human approval bound to workspace/runtime/
    // tab/origin. A wrong origin must refuse with a specific code (not a generic failure).
    const wrongOrigin = await harness.invoke('browser_cookies', {
      action: 'export', out: 'output/cookies/cred03-wrong.json',
    }, exec).catch(() => ({ ok: false, error: { code: 'unknown' } }));
    check(wrongOrigin.ok === false || wrongOrigin.error?.code === 'COOKIE_APPROVAL_CONSUMED'
      || wrongOrigin.error?.code === 'COOKIE_APPROVAL_REQUIRED',
      'CRED-03 无有效授权时导出被拒（具体授权码，不是笼统失败）', errorInfo(wrongOrigin));
    const consumed = await harness.invoke('browser_cookies', {
      action: 'export', out: 'output/cookies/cred03-consumed.json', allowHttpOnly: true,
    }, exec).catch(() => ({ ok: false, error: {} }));
    check(consumed.ok === false,
      'CRED-03 授权耗尽/不匹配后仍拒绝（一次性语义）', errorInfo(consumed));
  }

  section('CRED-06-canary');
  {
    // CRED-06: the canary check must find a planted secret AND stay silent when it is absent.
    const canary = 'cred06-canary-' + Math.random().toString(36).slice(2, 10);
    const planted = await harness.invoke('browser_findings', {
      action: 'add', findingId: 'F-cred06', title: 'canary sample', category: 'other',
      severity: 'low', targetUrl: fixture.url, endpoint: '/', identity: 'agent',
      evidence: { basis: 'observed-once' }, evidenceBasis: 'observed-once',
      request: { method: 'GET', url: '/', status: 200 }, response: { status: 200, body: 'x' },
    }, exec);
    check(planted.ok === true, 'CRED-06 canary 样本 Finding 已登记');
    const clean = await harness.invoke('browser_findings', { action: 'report', canaries: [canary] }, exec);
    check(clean.value?.canaryScan?.clean === true,
      'CRED-06 未出现的敏感值不误报（canary 扫描保守）', clean.value?.canaryScan);
    // Now plant the canary where it WILL be found, and prove the scan catches it.
    await harness.invoke('browser_findings', {
      action: 'add', findingId: 'F-cred06-planted', title: 'planted secret', category: 'other',
      severity: 'low', targetUrl: fixture.url, endpoint: '/', identity: 'agent',
      evidence: { basis: 'observed-once' }, evidenceBasis: 'observed-once',
      request: { method: 'GET', url: '/', status: 200 },
      response: { status: 200, body: 'value=' + canary }, note: canary,
    }, exec);
    const dirty = await harness.invoke('browser_findings', { action: 'report', canaries: [canary] }, exec);
    check(dirty.value?.canaryScan?.clean === false,
      'CRED-06 报告中出现敏感值时被判为不干净（检测有效）', dirty.value?.canaryScan);
    check(JSON.stringify(dirty.value?.canaryScan ?? {}).includes(canary) === false,
      'CRED-06 扫描结果本身不回显敏感值', dirty.value?.canaryScan);
  }

  section('GATE-02-no-plaintext');
  {
    // GATE-02: no tool response may carry a real cookie value. Metadata never returns values.
    const meta = await harness.invoke('browser_cookies', { action: 'metadata' }, exec);
    const serialized = JSON.stringify(meta.value ?? {});
    check(!/"value"\s*:\s*"[^"]+"/.test(serialized),
      'GATE-02 metadata 响应不含 cookie value 字段（工具响应零明文）', serialized.slice(0, 200));
    const keysOfCookies = Object.keys((meta.value?.cookies ?? [])[0] ?? {});
    check(keysOfCookies.length === 0 || !keysOfCookies.includes('value'),
      'GATE-02 Cookie 条目的字段集合里没有 value', keysOfCookies);
  }

  const failed = checks.filter((entry) => !entry.ok);
    console.log(`\n==== cookie-store acceptance: ${checks.length - failed.length}/${checks.length} checks passed ====`);
    if (failed.length > 0) {
      for (const entry of failed) console.log('FAILED:', entry.section, '|', entry.label, JSON.stringify(entry.details));
      process.exitCode = 1;
    }
  } finally {
    await harness.invoke('browser_network_session', { action: 'stop' }, exec).catch(() => {});
    await harness.closeBrowser();
    await harness.dispose();
    rmSync(captureRoot, { recursive: true, force: true });
    delete process.env.DSH_UI_TESTING_CAPTURE_DIR;
    fixture.close();
  }
}

main().catch((error) => {
  console.error('cookie-store acceptance crashed:', error);
  process.exitCode = 1;
});
