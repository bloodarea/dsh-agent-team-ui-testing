#!/usr/bin/env node
/**
 * Human keep-alive lock acceptance (docs/web/multi-tab.md 「生命周期与可观察性」).
 *
 * Real plugin entry + real headless Chromium (never 3080/3081). DSH_UI_TESTING_IDLE_MS is shortened
 * to 1000ms so the idle sweep runs in seconds instead of the real ten minutes; the mechanism, not
 * the default, is what this suite proves.
 *
 * Proves:
 *   - the panel `POST /tabs {action:"lock"}` flips the Host row's `locked` and `idleRemainingMs` to
 *     null, and `/unlock` restores a finite remaining idle window;
 *   - a locked primary survives an idle sweep that closes an unlocked sibling child in the SAME
 *     window (no "nothing was swept" false pass: the child must actually be audited as `idle`);
 *   - after unlock the same primary is swept and audited as `idle` — so the survival above came
 *     from the lock, not from the sweep never applying to primary;
 *   - `lock`/`unlock` require an explicit tabId and are refused for an unknown tab;
 *   - the Agent tool surface carries no lock action (`browser_tabs` action enum is unchanged).
 *
 * NOT_RUN (reported honestly, never as PASS):
 *   - the client SVG button's click path and CSS in a real DSH GUI: this suite drives the Host
 *     route the button calls, not the rendered button (client smoke covers the strip separately);
 *   - the LRU/capacity path (`#evictable`): filling 8 pages with a lock present is not exercised;
 *   - the 600000ms default TTL is not waited out;
 *   - lock persistence across a plugin reload is out of scope by design (Host memory only).
 *
 * Run: node tests/acceptance/tab-lock.mjs
 * Exit: 0 pass (NOT_RUN allowed), 1 assertion failure, 2 fatal.
 * Reports: tests/acceptance/runs/tab-lock-<stamp>/.
 */
import { createServer } from 'node:http';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { createHarness, createFakeConnectionService } from './harness.mjs';

const log = (...a) => console.log(...a);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const results = [];
const notRuns = [];
function notRun(label, reason) { notRuns.push({ label, reason }); log('NOT_RUN ' + label + ' — ' + reason); }
function check(label, pass, expected, actual) {
  results.push({ label, pass: Boolean(pass) });
  log(`${pass ? 'PASS' : 'FAIL'} ${label}`);
  if (!pass) log('  expected=' + JSON.stringify(expected) + ' actual=' + JSON.stringify(actual));
}

const server = createServer((req, res) => {
  res.writeHead(200, { 'content-type': 'text/html' });
  res.end('<!doctype html><title>tab-lock</title><h1>lock fixture</h1>');
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const fixture = `http://127.0.0.1:${server.address().port}/`;

const REPO_ROOT = dirname(dirname(dirname(fileURLToPath(import.meta.url))));
const cwd = process.env.DSH_UI_TESTING_REPO_ROOT || REPO_ROOT;
const execA = { agent: { id: 'lock-agent', session: { header: { cwd } } } };
const call = (name, args, exec) => harnessInvoke(name, args, exec || execA);

let harness;
let harnessInvoke;
let runDir;

function panelHeaders(binding) {
  if (binding) return { 'x-ui-testing-scope-version': '1', 'x-ui-testing-scope-binding': binding };
  return { 'x-ui-testing-scope-version': '1', 'x-ui-testing-session-id': 'lock-agent' };
}

async function panelTabs(body, binding) {
  return harness.request({ method: 'POST', path: '/plugins/ui-testing/tabs', headers: panelHeaders(binding), body });
}

async function listRows() {
  const listed = await call('browser_tabs', { action: 'list' });
  return listed.value || {};
}

async function rowFor(kind) {
  const listed = await listRows();
  return (listed.tabs || []).find((tab) => tab.kind === kind);
}

notRun('client SVG lock button click + CSS in a real DSH GUI', 'covered by the Host route the button calls; the rendered strip is a separate client smoke');
notRun('LRU/capacity eviction with a locked page present', 'filling maxPages with one locked page is not exercised here');
notRun('default 600000ms TTL real wait', 'the sweep mechanism is exercised with DSH_UI_TESTING_IDLE_MS=1000');
notRun('lock persistence across a plugin reload', 'host memory only by design; reload clears every lock');

process.env.DSH_UI_TESTING_IDLE_MS = '1000';
try {
  harness = await createHarness({ connection: createFakeConnectionService({ rejection: undefined, admit: () => ({ peer: { id: 'owner' } }), browserPeer: { id: 'owner' } }) });
  harnessInvoke = (name, args, exec) => harness.invoke(name, args, exec);

  // --- surface: the lock is not an Agent capability -------------------------------------------
  const tabDef = harness.toolDefinitions().find((d) => d.name === 'browser_tabs');
  const actions = tabDef && tabDef.parameters && tabDef.parameters.properties && tabDef.parameters.properties.action
    ? tabDef.parameters.properties.action.enum || [] : [];
  check('browser_tabs action enum carries no lock/unlock (panel-only capability)',
    actions.length > 0 && !actions.includes('lock') && !actions.includes('unlock'), { noLock: true }, actions);
  check('browser_tabs schema has no locked/lock field',
    !(tabDef.parameters.properties.locked || tabDef.parameters.properties.lock), { absent: true },
    Object.keys(tabDef.parameters.properties));

  // --- open primary + one child ----------------------------------------------------------------
  await harness.request({ method: 'POST', path: '/plugins/ui-testing/ensure', headers: panelHeaders(), body: { url: fixture } });
  const primaryRow = await rowFor('primary');
  check('ensure produces a primary row with locked:false', Boolean(primaryRow) && primaryRow.locked === false, { locked: false }, primaryRow);
  const opened = await panelTabs({ action: 'open' });
  const childId = opened.json && opened.json.tabId;
  check('panel /tabs open creates a child tab', opened.statusCode === 200 && typeof childId === 'string', { status: 200, tabId: 'child' },
    { status: opened.statusCode, body: opened.json });

  // --- lock the primary: the row must say so, and the idle window must stop applying -----------
  const locked = await panelTabs({ action: 'lock', tabId: 'primary' });
  check('panel /tabs lock returns locked:true and changed:true',
    locked.statusCode === 200 && locked.json && locked.json.locked === true && locked.json.changed === true,
    { status: 200, locked: true, changed: true }, { status: locked.statusCode, body: locked.json });
  const lockedRow = await rowFor('primary');
  check('browser_tabs list reports locked:true and a null idleRemainingMs',
    lockedRow && lockedRow.locked === true && lockedRow.idleRemainingMs === null,
    { locked: true, idleRemainingMs: null },
    { locked: lockedRow && lockedRow.locked, idleRemainingMs: lockedRow && lockedRow.idleRemainingMs });
  const idempotent = await panelTabs({ action: 'lock', tabId: 'primary' });
  check('a second lock is idempotent (changed:false, still locked)',
    idempotent.statusCode === 200 && idempotent.json && idempotent.json.locked === true && idempotent.json.changed === false,
    { locked: true, changed: false }, { status: idempotent.statusCode, body: idempotent.json });

  // --- the discriminating observation: child swept, locked primary alive, SAME window ----------
  let childAuditedIdle = false;
  let primarySurvived = false;
  for (let i = 0; i < 40; i += 1) {
    await sleep(250);
    const listed = await listRows();
    const rows = listed.tabs || [];
    childAuditedIdle = (listed.recentClosed || []).some((row) => row.tabId === childId && row.reason === 'idle');
    const stillThere = rows.find((row) => row.kind === 'primary');
    primarySurvived = Boolean(stillThere && stillThere.locked === true);
    if (childAuditedIdle && primarySurvived) break;
  }
  check('idle sweep really fired: the unlocked child is audited with reason=idle',
    childAuditedIdle, { reason: 'idle' }, childAuditedIdle);
  check('the locked primary survived that same idle sweep', primarySurvived, { survived: true }, primarySurvived);
  check('the survival pair is discriminating (swept something AND kept the locked page)',
    childAuditedIdle && primarySurvived, { swept: true, survived: true }, { swept: childAuditedIdle, survived: primarySurvived });
  const afterSweep = await rowFor('primary');
  check('the surviving locked page is still a live page (status ready, not a cold row)',
    Boolean(afterSweep) && afterSweep.status === 'ready' && afterSweep.locked === true,
    { status: 'ready', locked: true }, { status: afterSweep && afterSweep.status, locked: afterSweep && afterSweep.locked });

  // --- unlock: the same page must now become collectable ---------------------------------------
  const unlocked = await panelTabs({ action: 'unlock', tabId: 'primary' });
  check('panel /tabs unlock returns locked:false and changed:true',
    unlocked.statusCode === 200 && unlocked.json && unlocked.json.locked === false && unlocked.json.changed === true,
    { status: 200, locked: false, changed: true }, { status: unlocked.statusCode, body: unlocked.json });
  const unlockedRow = await rowFor('primary');
  check('after unlock idleRemainingMs is finite again (bounded by the configured idleMs)',
    unlockedRow && unlockedRow.locked === false && Number.isFinite(unlockedRow.idleRemainingMs)
    && unlockedRow.idleRemainingMs >= 0 && unlockedRow.idleRemainingMs <= 1000,
    { locked: false, bounded: true },
    { locked: unlockedRow && unlockedRow.locked, idleRemainingMs: unlockedRow && unlockedRow.idleRemainingMs });
  let primaryAuditedIdle = false;
  for (let i = 0; i < 40 && !primaryAuditedIdle; i += 1) {
    await sleep(250);
    const listed = await listRows();
    primaryAuditedIdle = (listed.recentClosed || []).some((row) => row.tabId === 'primary' && row.reason === 'idle');
  }
  check('after unlock the same primary is swept and audited with reason=idle',
    primaryAuditedIdle, { reason: 'idle' }, primaryAuditedIdle);

  // --- argument guards ------------------------------------------------------------------------
  await harness.request({ method: 'POST', path: '/plugins/ui-testing/ensure', headers: panelHeaders(), body: { url: fixture } });
  const noTabId = await panelTabs({ action: 'lock' });
  check('lock without tabId is refused INVALID_ARGUMENT (never defaults to primary)',
    noTabId.statusCode === 400 && noTabId.json && noTabId.json.code === 'INVALID_ARGUMENT',
    { status: 400, code: 'INVALID_ARGUMENT' }, { status: noTabId.statusCode, code: noTabId.json && noTabId.json.code });
  const ghost = await panelTabs({ action: 'lock', tabId: 'no-such-tab' });
  check('lock on an unknown tab is TAB_NOT_FOUND (no silent no-op)',
    ghost.statusCode === 404 && ghost.json && ghost.json.code === 'TAB_NOT_FOUND',
    { status: 404, code: 'TAB_NOT_FOUND' }, { status: ghost.statusCode, code: ghost.json && ghost.json.code });
  const badAction = await panelTabs({ action: 'pin', tabId: 'primary' });
  check('an unknown tabs.action is still INVALID_ARGUMENT',
    badAction.statusCode === 400 && badAction.json && badAction.json.code === 'INVALID_ARGUMENT',
    { status: 400, code: 'INVALID_ARGUMENT' }, { status: badAction.statusCode, code: badAction.json && badAction.json.code });
  check('the panel route answers exactly list/open/close/lock/unlock',
    String(badAction.json && badAction.json.error || '').includes('list/open/close/lock/unlock'), true,
    badAction.json && badAction.json.error);

  /* ------------------------------------------------------------------------------------------------
   * Regression: the lock must work over the scope the button actually sends.
   *
   * The rendered lock button does not send a session id: `toggleTabLock` addresses the tab's own
   * runtime (`scopeNowForView` → binding). Every check above uses a session scope, so this suite
   * stayed green while the real button was refused ADAPTER_DISABLED on any host whose global view
   * was not `web` — the environment gate used to read the *global* snapshot for every non-session
   * request, which also broke navigate/input/reload/viewport on a healthy Web page.
   *
   * The three cases below are the ones that failed before the fix:
   *   - a legacy config (`global.environment` only, no `global.view`) — every existing user;
   *   - a host whose default view is 3D;
   *   - a host whose default view is the empty view.
   * Each runs in its own harness because the global view is read at admission time.
   * ---------------------------------------------------------------------------------------------- */
  const scopeCases = [
    { label: 'legacy config with no global.view', global: { environment: 'web' } },
    { label: 'host default view is 3d', global: { environment: 'web', view: 'three-d' } },
    { label: 'host default view is the empty view', global: { environment: 'web', view: 'default' } },
  ];
  for (const scopeCase of scopeCases) {
    const dir = await mkdtemp(join(tmpdir(), 'dsh-tab-lock-scope-'));
    await writeFile(join(dir, 'config.json'), JSON.stringify({
      version: 1, revision: 0,
      global: {
        enabledEnvironments: ['web', 'three-d'],
        environments: { web: { enabled: true }, 'three-d': { enabled: true } },
        ...scopeCase.global,
      },
      // The session itself selects web: the page is legitimately Web even when the host default
      // view is not, which is exactly the case the old gate got wrong.
      sessions: { 'lock-agent': { view: 'web' } },
    }));
    let scopeHarness;
    try {
      scopeHarness = await createHarness({
        connection: createFakeConnectionService({ rejection: undefined, admit: () => ({ peer: { id: 'owner' } }), browserPeer: { id: 'owner' } }),
        configDir: dir,
      });
      const call2 = (name, args) => scopeHarness.invoke(name, args, execA);
      await scopeHarness.request({ method: 'POST', path: '/plugins/ui-testing/ensure', headers: panelHeaders(), body: { url: fixture } });
      const listed = await call2('browser_tabs', { action: 'list' });
      const row = ((listed.value && listed.value.tabs) || []).find((tab) => tab.kind === 'primary');
      if (!row) {
        check(`binding lock regression (${scopeCase.label}): a primary row exists`, false, 'primary row', listed.value);
        continue;
      }
      const bindHeaders = { 'x-ui-testing-scope-version': '1', 'x-ui-testing-scope-binding': String(row.runtimeId) };
      const lockByBinding = await scopeHarness.request({ method: 'POST', path: '/plugins/ui-testing/tabs', headers: bindHeaders, body: { action: 'lock', tabId: 'primary' } });
      check(`binding lock regression (${scopeCase.label}): lock over a binding scope succeeds`,
        lockByBinding.statusCode === 200 && lockByBinding.json && lockByBinding.json.locked === true,
        { status: 200, locked: true },
        { status: lockByBinding.statusCode, body: lockByBinding.json });
      const unlockByBinding = await scopeHarness.request({ method: 'POST', path: '/plugins/ui-testing/tabs', headers: bindHeaders, body: { action: 'unlock', tabId: 'primary' } });
      check(`binding lock regression (${scopeCase.label}): unlock over a binding scope succeeds`,
        unlockByBinding.statusCode === 200 && unlockByBinding.json && unlockByBinding.json.locked === false,
        { status: 200, locked: false },
        { status: unlockByBinding.statusCode, body: unlockByBinding.json });
      const recentHeaders = { 'x-ui-testing-scope-version': '1', 'x-ui-testing-scope': 'recent' };
      const lockByRecent = await scopeHarness.request({ method: 'POST', path: '/plugins/ui-testing/tabs', headers: recentHeaders, body: { action: 'lock', tabId: 'primary' } });
      check(`binding lock regression (${scopeCase.label}): lock over a recent scope succeeds`,
        lockByRecent.statusCode === 200 && lockByRecent.json && lockByRecent.json.locked === true,
        { status: 200, locked: true },
        { status: lockByRecent.statusCode, body: lockByRecent.json });
    } catch (error) {
      check(`binding lock regression (${scopeCase.label}): fixture ran`, false, 'no exception', String((error && error.message) || error));
    } finally {
      try { await scopeHarness?.closeBrowser(); } catch { /* ignore */ }
      try { await scopeHarness?.dispose(); } catch { /* ignore */ }
    }
  }

  /* ------------------------------------------------------------------------------------------------
   * Negative control: the widened admission must not become a bypass.
   *
   * A session that selected 3D has no Web execution surface, so its Web page writes stay refused.
   * Without this, "the page belongs to a session" could be mistaken for "any session may write".
   * ---------------------------------------------------------------------------------------------- */
  {
    const dir = await mkdtemp(join(tmpdir(), 'dsh-tab-lock-denied-'));
    await writeFile(join(dir, 'config.json'), JSON.stringify({
      version: 1, revision: 0,
      global: { view: 'web', environment: 'web', enabledEnvironments: ['web', 'three-d'], environments: { web: { enabled: true }, 'three-d': { enabled: true } } },
      sessions: { 'lock-agent': { view: 'three-d' } },
    }));
    let deniedHarness;
    try {
      deniedHarness = await createHarness({
        connection: createFakeConnectionService({ rejection: undefined, admit: () => ({ peer: { id: 'owner' } }), browserPeer: { id: 'owner' } }),
        configDir: dir,
      });
      const denied = await deniedHarness.request({ method: 'POST', path: '/plugins/ui-testing/ensure', headers: panelHeaders(), body: { url: fixture } });
      check('negative control: a session that selected 3D still cannot drive a Web page (ADAPTER_DISABLED)',
        denied.statusCode >= 400 && denied.json && denied.json.code === 'ADAPTER_DISABLED',
        { code: 'ADAPTER_DISABLED' }, { status: denied.statusCode, body: denied.json });
    } catch (error) {
      check('negative control fixture ran', false, 'no exception', String((error && error.message) || error));
    } finally {
      try { await deniedHarness?.closeBrowser(); } catch { /* ignore */ }
      try { await deniedHarness?.dispose(); } catch { /* ignore */ }
    }
  }
} catch (error) {
  check('tab-lock fixture completed', false, 'no exception', String(error && (error.stack || error.message) || error));
} finally {
  delete process.env.DSH_UI_TESTING_IDLE_MS;
  try { await harness.closeBrowser(); } catch { /* ignore */ }
  try { await harness.dispose(); } catch { /* ignore */ }
  await new Promise((r) => server.close(r));
  const failed = results.filter((r) => !r.pass).length;
  const stamp = new Date().toISOString().replace(/[:.]/gu, '-');
  runDir = `tests/acceptance/runs/tab-lock-${stamp}-${process.pid}`;
  await mkdir(runDir, { recursive: true });
  const report = {
    generatedAt: new Date().toISOString(),
    summary: { checks: results.length, passed: results.length - failed, failed, notRun: notRuns.length },
    checks: results.map((r) => ({ label: r.label, pass: r.pass })),
    notRuns,
  };
  await writeFile(`${runDir}/report.json`, JSON.stringify(report, null, 2));
  log(`evidence: ${runDir}`);
  log(`\nRESULT ${failed ? 'FAIL' : 'PASS'} (${failed} failed, ${results.length} checks, ${notRuns.length} NOT_RUN)`);
  log(`exit ${failed ? 1 : 0}`);
  process.exit(failed ? 1 : 0);
}
