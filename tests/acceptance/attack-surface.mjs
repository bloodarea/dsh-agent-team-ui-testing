/**
 * attack-surface.mjs — FR-02 attack surface discovery acceptance (DISC-01/02/03/04/07).
 *
 * Ground truth: the plugin's own headless Chromium against dsh-security-lab (or the local
 * fixture as fallback). The suite explores the app the way an authorized blind test would
 * (navigate + issue the app's own non-destructive API calls), then asserts:
 *   - API operations are discoverable and every one is `observed` with a first-observation seq;
 *   - page routes are discovered from Document navigations;
 *   - forms come from the DOM as `inferred`;
 *   - parameter sources (query names) are recognised;
 *   - auth state is an observed fact from the collector's header store, never guessed;
 *   - checkEvidenceLevels reports zero violations (DISC-07).
 *
 * Run: node tests/acceptance/attack-surface.mjs
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

const { checkEvidenceLevels } = await import(pathToFileURL(join(REPO_ROOT, 'attack-surface.js')).href);
const { createHarness } = await import('./harness.mjs');

async function main() {
  let base = null;
  let fixture = null;
  try {
    const health = await fetch(LAB + '/api/health', { signal: AbortSignal.timeout(1500) });
    base = health.ok ? LAB : null;
  } catch { base = null; }
  if (base === null) {
    const { startFixtureServer } = await import(pathToFileURL(join(REPO_ROOT, 'tests/ui_test_fixture/server.mjs')).href);
    fixture = await startFixtureServer();
    base = fixture.url.replace(/\/$/, '');
    console.log('[env] lab unavailable → local fixture', base);
  } else {
    console.log('[env] dsh-security-lab', base);
  }
  const labMode = base === LAB;

  const harness = await createHarness({ name: 'attack-surface' });
  const agent = { id: 'surface-acc', session: { header: { cwd: harness.workspaceDir } } };
  const exec = { agent };
  try {
    await harness.invoke('browser_tabs', { action: 'open' }, exec);

    section('DISC-setup');
    // A discovery run needs collected traffic: start the collector BEFORE exploring.
    const started = await harness.invoke('browser_network_session', { action: 'start', config: { captureBodies: false } }, exec);
    check(started.ok === true, '网络采集会话启动（observed 的流量来源）');
    const nav = await harness.invoke('browser_navigate', { url: base }, exec);
    check(nav.ok === true, '导航到目标页面');

    // Explore: perform the app's own reads (and a login when the lab is present).
    section('DISC-01-explore');
    if (labMode) {
      await harness.invoke('browser_eval', { expression: `
        (async () => {
          await fetch('/api/login', { method: 'POST', credentials: 'include',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ username: 'alice', password: 'alice-lab-2026' }) });
          for (const p of ['/api/me', '/api/products', '/api/search?q=star', '/api/cart',
                           '/api/orders', '/api/tickets', '/api/debug/config']) {
            try { await fetch(p, { credentials: 'include' }); } catch {}
          }
          return 'explored';
        })()
      ` }, exec);
    } else {
      await harness.invoke('browser_navigate', { url: base + '/second.html' }, exec);
      await harness.invoke('browser_navigate', { url: base + '/api/data' }, exec);
    }
    await harness.invoke('browser_navigate', { url: base + '/?probe=1' }, exec);

    section('DISC-01-inventory');
    const built = await harness.invoke('browser_surface', { action: 'build' }, exec);
    check(built.ok === true, 'browser_surface build 成功');
    const inventory = built.value?.inventory ?? {};
    const apiOps = inventory.apiOperations ?? [];
    const routes = inventory.pageRoutes ?? [];
    const forms = inventory.forms ?? [];
    check(apiOps.length >= 8, `发现有意义的 API 操作（≥8，实测 ${apiOps.length}）`, apiOps.map((o) => o.method + ' ' + o.path));
    check(routes.length >= 1, `发现页面路由（实测 ${routes.length}）`, routes.map((r) => r.path));
    check(forms.length >= 1, `从 DOM 发现表单（实测 ${forms.length}）`, forms.map((f) => f.method + ' ' + (f.action ?? '(self)')));
    if (labMode) {
      const paths = apiOps.map((o) => o.path);
      for (const expected of ['/api/login', '/api/me', '/api/products', '/api/search', '/api/cart', '/api/orders', '/api/tickets']) {
        check(paths.includes(expected), `靶机端点被发现：${expected}`);
      }
    }

    section('DISC-04-params');
    const search = apiOps.find((op) => op.path === '/api/search');
    check(search !== undefined && search.params?.query?.includes('q'), '参数来源识别：/api/search 的 q 查询参数', search?.params);
    if (labMode) {
      const login = apiOps.find((op) => op.path === '/api/login');
      check(login?.method === 'POST', '/api/login 被识别为 POST');
    }

    section('DISC-01-auth');
    const authed = apiOps.filter((op) => op.authObserved === 'cookie-header');
    check(authed.length >= 1, '认证状态是观测事实：至少一个操作带 Cookie 头观测', authed.map((o) => o.method + ' ' + o.path));
    check(apiOps.every((op) => op.authObserved === null || op.authObserved === 'cookie-header' || op.authObserved === 'authorization-header'),
      '未观测到头的操作保持 null，不猜测');

    section('DISC-05-initiator');
    const withInitiator = apiOps.filter((op) => Array.isArray(op.initiatorTypes) && op.initiatorTypes.length > 0);
    check(withInitiator.length >= 1, `initiator 类型已记录（实测 ${withInitiator.length} 个操作）`);

    section('DISC-07-evidence');
    const evidence = checkEvidenceLevels(inventory);
    check(evidence.ok === true, '证据分级零违规（apiOperations/pageRoutes=observed，forms=inferred）', evidence.violations);
    check(apiOps.every((op) => Number.isInteger(op.firstSeq)), '每个操作可回链首次观测 seq');
    check(forms.every((form) => form.evidence === 'inferred'), '表单标记为 inferred（可发起但未实发）');
    check(Array.isArray(inventory.unverifiedPaths), 'unverifiedPaths 存在（可为空）');

    // ---- DISC-06: WS/SSE declaration vs observation ------------------------------------
    section('DISC-06-transports');
    const transports = inventory.transports ?? null;
    check(transports !== null && transports !== undefined, 'DISC-06 清单报告 WS/SSE 传输观测状态', transports);
    if (transports !== null && transports !== undefined) {
      check(typeof transports.websocket?.declared === 'boolean', 'WebSocket 能力声明是布尔事实', transports.websocket);
      check(['observed', 'declared-not-observed', 'unsupported', 'unknown'].includes(transports.websocket?.status),
        'WebSocket 状态是契约内的枚举值', transports.websocket?.status);
      check(['observed', 'declared-not-observed', 'unsupported', 'unknown'].includes(transports.sse?.status),
        'SSE 状态是契约内的枚举值', transports.sse?.status);
      // The declaration must match the collector actually running for this inventory.
      check(transports.websocket.declared === true,
        'DISC-06 声明与运行态一致：采集器已开启 WebSocket 采集', transports.websocket);
      check(String(transports.note ?? '').includes('未观测'),
        'DISC-06 明确区分"声明为真但未观测"与"不支持"');
    }

    // Unverified injection must be labelled, never promoted to observed.
    section('DISC-07-unverified');
    const withGuess = await harness.invoke('browser_surface', {
      action: 'build', unverifiedPaths: ['/api/secret-from-js'],
    }, exec);
    const guess = (withGuess.value?.inventory?.unverifiedPaths ?? []);
    check(guess.length === 1 && guess[0].evidence === 'unverified', '注入的静态线索标记为 unverified', guess);
    const enriched = checkEvidenceLevels(withGuess.value.inventory);
    check(enriched.ok === true, '混入 unverified 后分级仍零违规', enriched.violations);

    await harness.invoke('browser_network_session', { action: 'stop' }, exec);

    const failed = checks.filter((entry) => !entry.ok);
    console.log(`\n==== attack-surface acceptance: ${checks.length - failed.length}/${checks.length} checks passed ====`);
    if (failed.length > 0) {
      for (const entry of failed) console.log('FAILED:', entry.section, '|', entry.label, JSON.stringify(entry.details).slice(0, 400));
      process.exitCode = 1;
    }
  } finally {
    await harness.closeBrowser();
    await harness.dispose();
    fixture?.close();
  }
}

main().catch((error) => {
  console.error('attack-surface acceptance crashed:', error);
  process.exitCode = 1;
});
