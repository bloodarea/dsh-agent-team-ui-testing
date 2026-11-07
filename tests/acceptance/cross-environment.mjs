#!/usr/bin/env node
/**
 * M5 independent acceptance — cross-environment control plane over the *real* plugin HTTP handler.
 *
 * The suite mounts the real plugin entry through tests/acceptance/harness.mjs
 * (`createHarness({ allowTestEnvironments: true, configDir, connection })`) and drives only the
 * real HTTP handler + real tool implementations:
 *
 *   A07 持久化            GET/PUT /config CAS, stale write -> 409 without touching the file,
 *                         restart (dispose + new harness on the same configDir) keeps revision,
 *                         corrupt config.json -> defaults + `.corrupt-*` backup + logged reason
 *   A10 执行一致性        tool results carry configRevision/environment/adapterId equal to
 *                         GET /config; disabled web must refuse tools and the GUI bypass route
 *   A11 scope 与并发       session A -> fake, session B stays web (per-session isolation)
 *   A13 就绪真实性        six independent axes per environment, planned environments never
 *                         fabricate a version
 *   A14 按需加载          GET /config, GET /readiness, GET /config?view=session create no
 *                         Chromium profile/process and no runtime entry; cold target axis is
 *                         `unbound` (never a started page)
 *
 * Evidence: tests/acceptance/runs/cross-environment-<stamp>/run-report.json + run.log
 * Exit codes: 0 all checks passed, 1 assertion failure, 2 the suite could not run.
 *
 * Env: DSH_UI_TESTING_CHROME (inherited by the harness/plugin), no network access required.
 */
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  createFakeConnectionService,
  createHarness,
  scanPluginChromeProcesses,
  snapshotProfileDirs,
} from './harness.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const RUN_STAMP = new Date().toISOString().replace(/[:.]/g, '-');
const RUN_DIR = join(HERE, 'runs', `cross-environment-${RUN_STAMP}-${process.pid}`);

const logLines = [];
const log = (line = '') => {
  logLines.push(String(line));
  console.log(line);
};
const checks = [];
const notRuns = [];
const observations = {};
function check(label, pass, expected, actual, extra) {
  const entry = { label, pass: Boolean(pass), expected, actual };
  if (extra !== undefined) entry.extra = extra;
  checks.push(entry);
  log(`${pass ? 'PASS' : 'FAIL'} ${label}`);
  if (!pass) log('  expected=' + JSON.stringify(expected) + ' actual=' + JSON.stringify(actual));
  return Boolean(pass);
}
function notRun(label, reason) {
  notRuns.push({ label, reason: String(reason) });
  log(`NOT_RUN ${label} — ${reason}`);
}
function sha256(text) {
  return createHash('sha256').update(text).digest('hex');
}
async function readConfigFile(configDir) {
  const file = join(configDir, 'config.json');
  if (!existsSync(file)) return null;
  return readFile(file, 'utf8');
}
async function listConfigDir(configDir) {
  try {
    return (await readdir(configDir)).sort();
  } catch {
    return [];
  }
}
function agent(id, cwd) {
  return { id, session: { header: { cwd } } };
}
function scopedHeaders(sessionId) {
  return { 'x-ui-testing-scope-version': '1', 'x-ui-testing-session-id': sessionId };
}
function newConnection() {
  return createFakeConnectionService({
    rejection: undefined,
    admit: () => ({ peer: { id: 'cross-env-peer' } }),
    browserPeer: { id: 'cross-env-peer' },
  });
}

const AXES = ['support', 'enabled', 'dependency', 'connection', 'target', 'capability'];

async function main() {
  await mkdir(RUN_DIR, { recursive: true });
  const previousConfigDir = process.env.DSH_UI_TESTING_CONFIG_DIR;
  const previousAllowTestEnv = process.env.DSH_UI_TESTING_ALLOW_TEST_ENV;
  const configDir = await mkdtemp(join(tmpdir(), 'dsh-cross-env-config-'));
  const corruptDir = await mkdtemp(join(tmpdir(), 'dsh-cross-env-corrupt-'));
  process.env.DSH_UI_TESTING_CONFIG_DIR = configDir;
  const baselineProfiles = await snapshotProfileDirs();
  const baselineChrome = scanPluginChromeProcesses();

  let harness;
  let restartHarness;
  let corruptHarness;
  const startedAt = Date.now();
  try {
    harness = await createHarness({ name: 'cross-environment', configDir, allowTestEnvironments: true, connection: newConnection() });
    const request = (options) => harness.request(options);
    const workspaceDir = harness.workspaceDir;
    const agentWeb = agent('agent-web', workspaceDir);
    const agentFake = agent('agent-fake', workspaceDir);
    const execFor = (agentEntry) => ({ agent: agentEntry, signal: AbortSignal.timeout(30000) });
    const getConfig = async (view = 'global', sessionId = null) => request({
      method: 'GET',
      path: `/plugins/ui-testing/config?view=${encodeURIComponent(view)}`,
      headers: sessionId ? scopedHeaders(sessionId) : {},
    });
    const putConfig = async (patch, expectedRevision) => request({
      method: 'PUT',
      path: '/plugins/ui-testing/config',
      body: { expectedRevision, scope: 'global', patch },
    });

    /* ------------------------------------------------------------------ A07/A13: read model */
    const initial = await getConfig('global');
    check('A07 GET /config?view=global returns revision/config/resolved/readiness',
      initial.statusCode === 200
        && initial.json && initial.json.ok === true
        && typeof initial.json.revision === 'number'
        && initial.json.config && typeof initial.json.config === 'object'
        && initial.json.resolved && typeof initial.json.resolved === 'object'
        && initial.json.readiness && Array.isArray(initial.json.readiness.environments),
      '200 {ok, revision:number, config, resolved, readiness.environments[]}',
      { status: initial.statusCode, body: String(initial.body).slice(0, 300) });

    const readinessEnvs = initial.json && initial.json.readiness ? initial.json.readiness.environments : [];
    const envById = new Map((Array.isArray(readinessEnvs) ? readinessEnvs : []).map((entry) => [entry.id, entry]));
    const webEntry = envById.get('web');
    const plannedIds = [...envById.keys()].filter((id) => id !== 'web' && id !== 'fake');
    check('A13 readiness exposes web support=supported',
      Boolean(webEntry) && webEntry.support === 'supported',
      'web.support=supported',
      webEntry ? webEntry.support : [...envById.keys()]);
    check('A13 planned environments report support=planned and do not fabricate a version',
      plannedIds.length > 0 && plannedIds.every((id) => {
        const entry = envById.get(id);
        if (entry.support !== 'planned') return false;
        if (entry.version !== undefined && entry.version !== null) return false;
        const dependency = entry.axes && entry.axes.dependency;
        const evidence = dependency && dependency.evidence;
        return evidence === undefined || evidence === null || evidence.version === null;
      }),
      'planned entries: support=planned, version=null/absent',
      plannedIds.map((id) => {
        const entry = envById.get(id);
        return { id, support: entry.support, version: entry.version, dependency: entry.axes && entry.axes.dependency };
      }));

    const axisReport = [];
    for (const entry of Array.isArray(readinessEnvs) ? readinessEnvs : []) {
      const axes = entry.axes && typeof entry.axes === 'object' ? entry.axes : null;
      axisReport.push({
        id: entry.id,
        axisKeys: axes ? Object.keys(axes).sort() : null,
        statuses: axes ? Object.fromEntries(AXES.map((axis) => [axis, axes[axis] && axes[axis].status])) : null,
      });
    }
    const allSixAxes = axisReport.every((entry) => entry.axisKeys
      && AXES.every((axis) => entry.axisKeys.includes(axis)));
    check('A13 every readiness environment exposes six independent axes (support/enabled/dependency/connection/target/capability)',
      allSixAxes,
      'six distinct axis objects per environment',
      axisReport);
    const webTargetAxis = webEntry && webEntry.axes && webEntry.axes.target ? webEntry.axes.target.status : null;
    check('A14 cold web target axis is unbound (settings/readiness never starts a page)',
      webTargetAxis === 'unbound',
      'web.axes.target.status=unbound',
      { axesPresent: Boolean(webEntry && webEntry.axes), target: webTargetAxis });

    /* --------------------------------------- slice ②: runtime provider identity (read-only) */
    const resolved0 = initial.json.resolved || {};
    check('A07 /config resolved carries the provider identity while environment/adapterId stay "web"',
      resolved0.environment === 'web' && resolved0.adapterId === 'web'
        && resolved0.provider === 'chrome' && resolved0.executionAdapterId === 'web-chrome',
      { environment: 'web', adapterId: 'web', provider: 'chrome', executionAdapterId: 'web-chrome' },
      { environment: resolved0.environment, adapterId: resolved0.adapterId, provider: resolved0.provider, executionAdapterId: resolved0.executionAdapterId });
    check('A07 /config resolved exposes derived enabledProviders and providerConfig.support',
      Array.isArray(resolved0.enabledProviders) && resolved0.enabledProviders.includes('chrome')
        && resolved0.providerConfig && resolved0.providerConfig.support === 'supported',
      { enabledProviders: ['chrome'], support: 'supported' },
      { enabledProviders: resolved0.enabledProviders, providerConfig: resolved0.providerConfig });
    const providerCards = (webEntry && webEntry.providers) || null;
    check('A13 readiness exposes per-provider cards with six axes each',
      Boolean(providerCards) && ['chrome', 'edge', 'firefox'].every((id) => {
        const card = providerCards[id];
        return card && card.axes && AXES.every((axis) => card.axes[axis]);
      }),
      'readiness.environments.web.providers.<id>.axes (six axes)',
      providerCards ? Object.fromEntries(Object.entries(providerCards).map(([id, card]) => [id, { support: card.support, axes: Object.keys(card.axes || {}) }])) : null);
    check('A13 disabled provider card is not probed (provider-disabled, no fabricated driver)',
      Boolean(providerCards) && providerCards.edge && providerCards.edge.axes.dependency.status === 'not-probed'
        && providerCards.edge.axes.dependency.reason === 'provider-disabled'
        && providerCards.edge.support === 'supported',
      { support: 'supported', enabled: false, dependency: { status: 'not-probed', reason: 'provider-disabled' } },
      providerCards && providerCards.edge ? { support: providerCards.edge.support, dependency: providerCards.edge.axes.dependency } : null);

    /* ------------------------------------------------------------------------ A14: no lazy start */
    const profilesBefore = (await snapshotProfileDirs()).length;
    const chromeBefore = scanPluginChromeProcesses().length;
    const registry = harness.ctx.__internal.plugin && harness.ctx.__internal.plugin.registry;
    const entriesBefore = registry && registry.entries ? registry.entries.size : null;
    await getConfig('global');
    await request({ method: 'GET', path: '/plugins/ui-testing/readiness' });
    await getConfig('session', 'agent-web');
    const profilesAfter = (await snapshotProfileDirs()).length;
    const chromeAfter = scanPluginChromeProcesses().length;
    const entriesAfter = registry && registry.entries ? registry.entries.size : null;
    check('A14 GET /config + GET /readiness + GET /config?view=session start no Chromium and create no runtime',
      profilesBefore === profilesAfter && chromeBefore === chromeAfter && entriesBefore === entriesAfter,
      { profiles: profilesBefore, chrome: chromeBefore, runtimeEntries: entriesBefore },
      { profiles: profilesAfter, chrome: chromeAfter, runtimeEntries: entriesAfter });

    /* ---------------------------------------------------------------------------- A07: CAS write */
    const revision0 = initial.json.revision;
    const disable = await putConfig({ environments: { web: { enabled: false } } }, revision0);
    check('A07 PUT /config (web disabled) succeeds with revision+1',
      disable.statusCode === 200 && disable.json && disable.json.revision === revision0 + 1,
      { status: 200, revision: revision0 + 1 },
      { status: disable.statusCode, body: String(disable.body).slice(0, 300) });
    const afterDisableText = await readConfigFile(configDir);
    const revisionAfterDisable = disable.json && disable.json.revision;

    const stale = await putConfig({ environments: { web: { enabled: true } } }, revision0);
    const afterStaleText = await readConfigFile(configDir);
    check('A07 stale revision write is rejected with 409 CONFIG_CONFLICT',
      stale.statusCode === 409 && stale.json && stale.json.code === 'CONFIG_CONFLICT',
      { status: 409, code: 'CONFIG_CONFLICT' },
      { status: stale.statusCode, code: stale.json && stale.json.code, body: String(stale.body).slice(0, 300) });
    check('A07 rejected write leaves config.json byte-identical',
      afterDisableText !== null && afterStaleText !== null && sha256(afterDisableText) === sha256(afterStaleText),
      { sha256: afterDisableText ? sha256(afterDisableText) : null },
      { sha256: afterStaleText ? sha256(afterStaleText) : null });

    const afterConflict = await getConfig('global');
    check('A07 GET /config after the conflict still reports the successful revision',
      afterConflict.statusCode === 200 && afterConflict.json.revision === revisionAfterDisable,
      { revision: revisionAfterDisable },
      { status: afterConflict.statusCode, revision: afterConflict.json && afterConflict.json.revision });

    const restore = await putConfig({ environments: { web: { enabled: true } } }, revisionAfterDisable);
    check('A07 PUT /config restores web enabled=true (revision+1)',
      restore.statusCode === 200 && restore.json && restore.json.revision === revisionAfterDisable + 1,
      { status: 200, revision: revisionAfterDisable + 1 },
      { status: restore.statusCode, body: String(restore.body).slice(0, 300) });
    const revisionRestored = restore.json && restore.json.revision;

    /* ---------------------------------------------------------------------------- A10: metadata */
    const stateResult = await harness.invoke('browser_state', {}, execFor(agentWeb));
    const stateValue = stateResult.value || {};
    const configForMeta = await getConfig('global');
    check('A10 browser_state result carries configRevision/environment/adapterId matching GET /config',
      stateResult.ok === true
        && stateValue.configRevision === configForMeta.json.revision
        && stateValue.environment === 'web'
        && stateValue.adapterId === 'web',
      { configRevision: configForMeta.json.revision, environment: 'web', adapterId: 'web' },
      {
        ok: stateResult.ok,
        configRevision: stateValue.configRevision,
        environment: stateValue.environment,
        adapterId: stateValue.adapterId,
        error: stateResult.error,
      });

    /* ------------------------------------------------- A10: disabled web refuses tools + GUI bypass */
    const disableForGuard = await putConfig({ environments: { web: { enabled: false } } }, revisionRestored);
    const revisionDisabled = disableForGuard.json && disableForGuard.json.revision;
    // A08/A10: a disabled environment must not be *declared* to the model at all. The composition
    // root therefore unregisters its Web tools on the config write, so an old/stale call no longer
    // resolves to a registered tool; a call that still resolves (config changed mid-step) must be
    // refused with a classified code, never with INTERNAL.
    let disabledEval;
    try {
      disabledEval = await harness.invoke('browser_eval', { expression: '1+1' }, execFor(agentWeb));
    } catch (error) {
      disabledEval = { ok: false, error: { code: 'TOOL_NOT_REGISTERED', message: String(error && error.message) } };
    }
    const undeclared = /tool not registered/i.test(String(disabledEval.error && disabledEval.error.message))
      || disabledEval.error?.code === 'TOOL_NOT_REGISTERED';
    check('A10/A08 disabled web removes browser_eval from the tool surface (declaration-level, not just ADAPTER_DISABLED)',
      (disabledEval.ok === false && undeclared)
        || (disabledEval.ok === false && disabledEval.error && disabledEval.error.code === 'ADAPTER_DISABLED'),
      { undeclared: true, orCode: 'ADAPTER_DISABLED' },
      { ok: disabledEval.ok, undeclared, code: disabledEval.error && disabledEval.error.code, message: disabledEval.error && disabledEval.error.message });

    // Diagnostics stay available in the disabled state and must report support ≠ enabled.
    const disabledCaps = await harness.invoke('browser_capabilities', {}, execFor(agentWeb));
    const disabledAxes = (disabledCaps.value && disabledCaps.value.adapter && disabledCaps.value.adapter.readiness
      && (disabledCaps.value.adapter.readiness.environments || []).find((entry) => entry.id === 'web')
      && disabledCaps.value.adapter.readiness.environments.find((entry) => entry.id === 'web').axes) || null;
    check('A13 disabled web: browser_capabilities still answers, support=supported and enabled=false',
      disabledCaps.ok === true && Boolean(disabledAxes)
        && disabledAxes.support.status === 'supported'
        && disabledAxes.enabled.status === 'false',
      { ok: true, support: 'supported', enabled: 'false' },
      { ok: disabledCaps.ok, code: disabledCaps.error && disabledCaps.error.code, axes: disabledAxes && { support: disabledAxes.support, enabled: disabledAxes.enabled } });

    // GUI bypass: scoped /navigate is the panel's own write route. An empty URL keeps the probe
    // free of a real navigation (validation runs before ensure), so the only meaningful outcome
    // is the config guard's ADAPTER_DISABLED.
    const guiNavigate = await request({
      method: 'POST',
      path: '/plugins/ui-testing/navigate',
      headers: scopedHeaders('agent-web'),
      body: { url: '' },
    });
    check('A10 GUI bypass POST /navigate is refused while web is disabled (non-2xx ADAPTER_DISABLED)',
      guiNavigate.statusCode >= 400 && guiNavigate.json && guiNavigate.json.code === 'ADAPTER_DISABLED',
      { status: '>=400', code: 'ADAPTER_DISABLED' },
      { status: guiNavigate.statusCode, code: guiNavigate.json && guiNavigate.json.code, body: String(guiNavigate.body).slice(0, 200) });
    const guiState = await request({ method: 'GET', path: '/plugins/ui-testing/state', headers: scopedHeaders('agent-web') });
    check('A10 GET /state stays readable while web is disabled (diagnostics are not blocked)',
      guiState.statusCode === 200 && guiState.json && guiState.json.ok !== false,
      { status: 200 },
      { status: guiState.statusCode, body: String(guiState.body).slice(0, 200) });

    const restoreForGuard = await putConfig({ environments: { web: { enabled: true } } }, revisionDisabled);
    const revisionGuardRestored = restoreForGuard.json && restoreForGuard.json.revision;
    const restoredEval = await harness.invoke('browser_eval', { expression: '1+1' }, execFor(agentWeb));
    check('A10 re-enabled web allows browser_eval again',
      restoredEval.ok === true,
      { ok: true, value: 2 },
      { ok: restoredEval.ok, value: restoredEval.value && restoredEval.value.value, error: restoredEval.error });

    /* ------------------------------------------------------------------- A11: per-session split */
    const enableFake = await putConfig({ enabledEnvironments: ['web', 'fake'], environments: { fake: { enabled: true } } }, revisionGuardRestored);
    check('A11 enabling the test-only fake environment at global scope succeeds',
      enableFake.statusCode === 200 && enableFake.json && enableFake.json.revision === revisionGuardRestored + 1,
      { status: 200, revision: revisionGuardRestored + 1 },
      { status: enableFake.statusCode, body: String(enableFake.body).slice(0, 200) });
    const revisionFakeEnabled = enableFake.json && enableFake.json.revision;

    const selectFake = await request({
      method: 'POST',
      path: '/plugins/ui-testing/config/select',
      headers: scopedHeaders('agent-fake'),
      body: { scope: 'session', environment: 'fake', expectedRevision: revisionFakeEnabled },
    });
    check('A11 POST /config/select session=agent-fake -> fake (revision+1)',
      selectFake.statusCode === 200
        && selectFake.json && selectFake.json.revision === revisionFakeEnabled + 1
        && selectFake.json.resolved && selectFake.json.resolved.environment === 'fake',
      { status: 200, revision: revisionFakeEnabled + 1, environment: 'fake' },
      { status: selectFake.statusCode, body: String(selectFake.body).slice(0, 300) });

    const sessionFake = await getConfig('session', 'agent-fake');
    const sessionWeb = await getConfig('session', 'agent-web');
    check('A11 session view: agent-fake=fake, agent-web=web (no cross-session pollution)',
      sessionFake.statusCode === 200 && sessionFake.json.resolved.environment === 'fake'
        && sessionWeb.statusCode === 200 && sessionWeb.json.resolved.environment === 'web',
      { 'agent-fake': 'fake', 'agent-web': 'web' },
      {
        'agent-fake': { status: sessionFake.statusCode, resolved: sessionFake.json && sessionFake.json.resolved && sessionFake.json.resolved.environment },
        'agent-web': { status: sessionWeb.statusCode, resolved: sessionWeb.json && sessionWeb.json.resolved && sessionWeb.json.resolved.environment },
      });

    const fakeProbe = await harness.invoke('browser_fake_probe', {}, execFor(agentFake));
    const fakeValue = fakeProbe.value || {};
    check('A10 fake adapter receives the same config revision in its tool result',
      fakeProbe.ok === true
        && fakeValue.configRevision === selectFake.json.revision
        && fakeValue.environment === 'fake'
        && fakeValue.adapterId === 'fake',
      { configRevision: selectFake.json.revision, environment: 'fake', adapterId: 'fake' },
      {
        ok: fakeProbe.ok,
        configRevision: fakeValue.configRevision,
        environment: fakeValue.environment,
        adapterId: fakeValue.adapterId,
        error: fakeProbe.error,
      });

    /* ------------------------------------------------------------------- A07: persistence */
    const beforeRestart = await getConfig('global');
    const beforeRestartSession = await getConfig('session', 'agent-fake');
    await harness.dispose();
    harness = null;
    restartHarness = await createHarness({ name: 'cross-environment-restart', configDir, allowTestEnvironments: true, connection: newConnection() });
    const afterRestart = await restartHarness.request({ method: 'GET', path: '/plugins/ui-testing/config?view=global' });
    const afterRestartSession = await restartHarness.request({
      method: 'GET',
      path: '/plugins/ui-testing/config?view=session',
      headers: scopedHeaders('agent-fake'),
    });
    check('A07 restart on the same configDir keeps revision and config (Host restart persistence)',
      afterRestart.statusCode === 200
        && afterRestart.json.revision === beforeRestart.json.revision
        && JSON.stringify(afterRestart.json.config) === JSON.stringify(beforeRestart.json.config),
      { revision: beforeRestart.json.revision },
      { status: afterRestart.statusCode, revision: afterRestart.json && afterRestart.json.revision });
    check('A07 restart keeps the per-session selection (agent-fake still fake)',
      afterRestartSession.statusCode === 200
        && afterRestartSession.json.resolved.environment === beforeRestartSession.json.resolved.environment,
      { environment: beforeRestartSession.json.resolved.environment },
      { environment: afterRestartSession.json && afterRestartSession.json.resolved && afterRestartSession.json.resolved.environment });

    /* ------------------------------------------------------------- A07: corrupt config recovery */
    await writeFile(join(corruptDir, 'config.json'), '{"version":1,"revision":9,"global":', 'utf8');
    process.env.DSH_UI_TESTING_CONFIG_DIR = corruptDir;
    corruptHarness = await createHarness({ name: 'cross-environment-corrupt', configDir: corruptDir, allowTestEnvironments: true, connection: newConnection() });
    const corruptRead = await corruptHarness.request({ method: 'GET', path: '/plugins/ui-testing/config?view=global' });
    const corruptFiles = await listConfigDir(corruptDir);
    const backup = corruptFiles.find((name) => name.startsWith('config.json.corrupt-'));
    const corruptLog = (corruptHarness.logs || []).find((line) => /corrupt/i.test(String(line))) || '';
    check('A07 corrupt config.json falls back to defaults (revision 0)',
      corruptRead.statusCode === 200 && corruptRead.json.revision === 0
        && corruptRead.json.config && corruptRead.json.config.global.environment === 'web',
      { status: 200, revision: 0 },
      { status: corruptRead.statusCode, revision: corruptRead.json && corruptRead.json.revision });
    check('A07 corrupt config.json is backed up as .corrupt-* and the reason is logged',
      Boolean(backup) && corruptLog.length > 0,
      { backup: 'config.json.corrupt-*', log: 'non-empty' },
      { files: corruptFiles, log: corruptLog.slice(0, 200) });
    observations.corruptRecovery = { files: corruptFiles, log: corruptLog.slice(0, 400) };
  } finally {
    for (const instance of [harness, restartHarness, corruptHarness]) {
      if (!instance) continue;
      try { await instance.dispose(); } catch { /* cleanup must not mask results */ }
    }
    // Restore env and remove only this run's directories.
    if (previousConfigDir === undefined) delete process.env.DSH_UI_TESTING_CONFIG_DIR;
    else process.env.DSH_UI_TESTING_CONFIG_DIR = previousConfigDir;
    if (previousAllowTestEnv === undefined) delete process.env.DSH_UI_TESTING_ALLOW_TEST_ENV;
    else process.env.DSH_UI_TESTING_ALLOW_TEST_ENV = previousAllowTestEnv;
    // Kill only Chromium processes started by this run (new profile dirs) and remove those dirs.
    const baselinePids = new Set(baselineChrome.map((entry) => entry.pid));
    const profilesAfterRun = await snapshotProfileDirs();
    const baselineProfileSet = new Set(baselineProfiles);
    const newProfiles = profilesAfterRun.filter((dir) => !baselineProfileSet.has(dir));
    for (const proc of scanPluginChromeProcesses()) {
      if (baselinePids.has(proc.pid)) continue;
      if (!newProfiles.some((dir) => String(proc.profileDir).startsWith(dir))) continue;
      try { process.kill(proc.pid, 'SIGKILL'); } catch { /* already gone */ }
    }
    for (const dir of newProfiles) {
      await rm(dir, { recursive: true, force: true, maxRetries: 5 }).catch(() => {});
    }
    await rm(configDir, { recursive: true, force: true, maxRetries: 5 }).catch(() => {});
    await rm(corruptDir, { recursive: true, force: true, maxRetries: 5 }).catch(() => {});
  }

  const failed = checks.filter((entry) => !entry.pass);
  const report = {
    suite: 'cross-environment',
    startedAt: new Date(startedAt).toISOString(),
    finishedAt: new Date().toISOString(),
    durationMs: Date.now() - startedAt,
    environment: {
      node: process.version,
      chrome: process.env.DSH_UI_TESTING_CHROME || '(plugin default)',
      configDir: '(temp)',
    },
    checks,
    notRuns,
    observations,
    summary: { checks: checks.length, passed: checks.length - failed.length, failed: failed.length, notRun: notRuns.length },
  };
  await writeFile(join(RUN_DIR, 'run-report.json'), JSON.stringify(report, null, 2));
  await writeFile(join(RUN_DIR, 'run.log'), logLines.join('\n') + '\n');
  log(`\ncross-environment: ${checks.length - failed.length}/${checks.length} PASS, ${failed.length} failed, ${notRuns.length} NOT_RUN`);
  log('evidence: ' + RUN_DIR);
  if (failed.length > 0) {
    for (const entry of failed) log(`  FAILED: ${entry.label}`);
  }
  return failed.length === 0 ? 0 : 1;
}

let code = 2;
try {
  code = await main();
} catch (error) {
  log('FATAL ' + (error && (error.stack || error.message) || error));
  try {
    await mkdir(RUN_DIR, { recursive: true });
    await writeFile(join(RUN_DIR, 'run-report.json'), JSON.stringify({
      suite: 'cross-environment',
      fatal: String(error && (error.stack || error.message) || error),
      checks,
      notRuns,
    }, null, 2));
    await writeFile(join(RUN_DIR, 'run.log'), logLines.join('\n') + '\n');
  } catch { /* best effort */ }
  code = 2;
}
process.exit(code);
