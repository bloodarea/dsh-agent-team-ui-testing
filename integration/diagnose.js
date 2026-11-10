/**
 * Provider diagnostics run (Host side, slice 1).
 *
 * `POST /plugins/ui-testing/diagnose` walks five real checks and streams them as NDJSON. It exists
 * because the settings page used to *project* readiness onto a picture: the picture could show a
 * green node above a dead edge. Here every stage performs an actual operation (registration
 * comparison, a real tool dispatch through the registered handler, a real `Browser.getVersion`, a
 * real executable check, a real `Target.getTargets` + read-only `browser_eval`) and reports what
 * really happened — including "not run", which is never painted as success.
 *
 * Contract points that must not be relaxed:
 *   - body is exactly `{provider?, mode:'observe'|'start', requestId}`; anything else is 400.
 *   - `observe` never spawns a browser, never ensures, never creates a page. `start` goes through
 *     the existing `Runtime.ensure` (15s spawn budget, 30s run budget) and records what it created.
 *   - `durationMs` comes from the Host monotonic clock; a stage that did not run reports `null`.
 *   - `seq` is unique and strictly increasing for the whole run.
 *   - five-state (`PASS|WARN|FAIL|SKIPPED|UNKNOWN`) is kept separate from `phase`.
 */

import { createHash } from 'node:crypto';

const NDJSON = 'application/x-ndjson; charset=utf-8';
const STAGE_BUDGET_MS = { 1: 3000, 2: 2000, 3: 3000, 4: 2000, 5: 5000 };
const RUN_BUDGET_MS = 30000;
const START_BUDGET_MS = 15000;
const BODY_KEYS = new Set(['provider', 'mode', 'requestId']);
/**
 * Hard ceilings for the read-only capability probes. They are exported so the acceptance suite can
 * assert the rejection paths directly: `POST /diagnose` takes no probe arguments, so an out-of-range
 * parameter can only be exercised against this validator.
 */
export const PROBE_LIMITS = Object.freeze({
  snapshotMaxNodes: 100,
  computedStyleMaxProperties: 5,
  networkMaxLimit: 10,
  computedStyleSelectors: Object.freeze(['body', 'html']),
  probeBudgetMs: 8000,
  probeTimeoutMs: 3000,
});

/**
 * Validate one dispatcher call. Returns `{ ok: true, value }` with the *narrowed* arguments, or
 * `{ ok: false, reason }`. Anything outside the read-only allow-list is rejected, never silently
 * widened: these probes must not click, type, navigate or start a capture session.
 */
export function validateProbeArgs(tool, args) {
  const input = args && typeof args === 'object' && !Array.isArray(args) ? args : null;
  const keys = input ? Object.keys(input) : [];
  const onlyKeys = (allowed) => keys.filter((key) => !allowed.includes(key));
  if (tool === 'browser_capabilities') {
    if (keys.length) return { ok: false, reason: 'browser_capabilities 不接受参数：' + keys.join(',') };
    return { ok: true, value: {} };
  }
  if (tool === 'browser_eval') {
    if (!input || input.expression !== '1') return { ok: false, reason: 'browser_eval 只允许只读表达式 \'1\'' };
    if (onlyKeys(['expression']).length) return { ok: false, reason: 'browser_eval 不接受额外参数' };
    return { ok: true, value: { expression: '1' } };
  }
  if (tool === 'browser_snapshot') {
    if (!input) return { ok: true, value: { maxNodes: 50 } };
    const extra = onlyKeys(['maxNodes']);
    if (extra.length) return { ok: false, reason: 'browser_snapshot 不接受参数：' + extra.join(',') };
    const maxNodes = input.maxNodes === undefined ? 50 : input.maxNodes;
    if (!Number.isInteger(maxNodes) || maxNodes < 1 || maxNodes > PROBE_LIMITS.snapshotMaxNodes) {
      return { ok: false, reason: 'maxNodes 必须是 1..' + PROBE_LIMITS.snapshotMaxNodes + ' 的整数' };
    }
    return { ok: true, value: { maxNodes } };
  }
  if (tool === 'browser_screenshot') {
    if (!input) return { ok: true, value: {} };
    if (keys.length) return { ok: false, reason: 'browser_screenshot 只允许空参数（拒绝 ' + keys.join(',') + '：不落盘、不裁剪、不改比例）' };
    return { ok: true, value: {} };
  }
  if (tool === 'browser_computed_style') {
    if (!input) return { ok: false, reason: 'browser_computed_style 需要 selector 与 properties' };
    const extra = onlyKeys(['selector', 'properties']);
    if (extra.length) return { ok: false, reason: 'browser_computed_style 不接受参数：' + extra.join(',') };
    if (!PROBE_LIMITS.computedStyleSelectors.includes(input.selector)) {
      return { ok: false, reason: 'selector 只允许 ' + PROBE_LIMITS.computedStyleSelectors.join('/') + '，收到 ' + String(input.selector) };
    }
    const properties = input.properties;
    if (!Array.isArray(properties) || properties.length < 1 || properties.length > PROBE_LIMITS.computedStyleMaxProperties) {
      return { ok: false, reason: 'properties 必须是长度 1..' + PROBE_LIMITS.computedStyleMaxProperties + ' 的数组' };
    }
    if (!properties.every((name) => typeof name === 'string' && /^[a-zA-Z-]{1,40}$/.test(name))) {
      return { ok: false, reason: 'properties 只能是 CSS 属性名' };
    }
    return { ok: true, value: { selector: input.selector, properties: properties.slice(0, PROBE_LIMITS.computedStyleMaxProperties) } };
  }
  if (tool === 'browser_network') {
    if (!input) return { ok: true, value: { limit: 5 } };
    const extra = onlyKeys(['limit']);
    if (extra.length) return { ok: false, reason: 'browser_network 只接受 limit（不启动采集）：' + extra.join(',') };
    const limit = input.limit === undefined ? 5 : input.limit;
    if (!Number.isInteger(limit) || limit < 1 || limit > PROBE_LIMITS.networkMaxLimit) {
      return { ok: false, reason: 'limit 必须是 1..' + PROBE_LIMITS.networkMaxLimit + ' 的整数' };
    }
    return { ok: true, value: { limit } };
  }
  return { ok: false, reason: '诊断调度器不支持该操作：' + String(tool) };
}

/** The only operations this dispatcher may run. Everything else is refused above. */
const DISPATCHER_ALLOWED = new Map([
  ['browser_capabilities', true],
  ['browser_eval', true],
  ['browser_snapshot', true],
  ['browser_screenshot', true],
  ['browser_computed_style', true],
  ['browser_network', true],
]);

export function createDiagnose(deps) {
  const {
    log, crossEnvironment, registry, readJson, sendJson, nowMonoMs,
    resolveProviderExecutable, toolDefinitions, randomUUID, webProviderSupport,
  } = deps;
  const mono = typeof nowMonoMs === 'function' ? nowMonoMs : () => Number(process.hrtime.bigint()) / 1e6;
  const wall = () => Date.now();

  const fail = (res, status, code, message) => {
    sendJson(res, status, { ok: false, code, error: message });
    return true;
  };

  /** Five-state helpers ---------------------------------------------------------------- */
  const STAGE_IDS = ['1', '2', '3', '4', '5'];
  const REQUIRED_STAGES = new Set(['1', '2', '3', '4', '5']);
  const worstStatus = (statuses) => {
    if (statuses.includes('FAIL')) return 'FAIL';
    if (statuses.includes('UNKNOWN')) return 'UNKNOWN';
    if (statuses.includes('WARN') || statuses.includes('SKIPPED')) return 'WARN';
    return 'PASS';
  };

  function handleHttp(req, res, options = {}) {
    const { action, scopeRequest, scoped, requestRejection, rejectUi, resolveScopeRequest } = options;
    if (action !== '/diagnose') return false;
    if (req.method !== 'POST') return fail(res, 405, 'UNSUPPORTED', '只支持 POST /diagnose');
    // Scoped GUI only. `index.js` already ran the strict owner-only gate for scoped requests, so
    // reaching here with `scoped === false` means a legacy/unscoped caller.
    if (!scoped) {
      if (typeof rejectUi === 'function') { rejectUi(res, 401); return true; }
      return fail(res, 401, 'UNSUPPORTED', '需要已认证且已绑定的 GUI 会话');
    }
    run(req, res, { scopeRequest, resolveScopeRequest }).catch((error) => {
      log('ui-testing diagnose failed: ' + String((error && error.stack) || error));
      try { if (!res.headersSent) fail(res, 500, 'INTERNAL', '诊断执行失败'); else res.end(); } catch { /* ignore */ }
    }).catch(() => {});
    return true;
  }

  /**
   * The identity a probe runs as.
   *
   * Page groups are keyed by (workspace, provider, team root), so a synthetic actor derived from the
   * *workspace* id lands in a different group than the page this run froze and every probe answers
   * `TAB_NOT_FOUND`. A probe therefore runs as the **owner of the page it inspects**: the frozen
   * entry records exactly that (`ownerSessionId`, falling back to `rootSessionId`). The cwd is kept
   * from the resolved scope so admission and the config snapshot still resolve the same workspace.
   *
   * This is not "the diagnostician borrows somebody's identity": see `diagnosticPrincipalFor()` in
   * index.js — the probe set is fixed, read-only, and the scope came from this panel's own
   * authenticated resolution.
   */
  function dispatchAgentFor(ctx) {
    const owner = ctx.entry?.ownership?.ownerSessionId || ctx.entry?.rootSessionId || null;
    if (!owner) return ctx.agent;
    return { ...(ctx.agent || {}), id: String(owner) };
  }

  /** A tool dispatch restricted to this contract's fixed operations, through the real handler. */
  async function dispatch(ctx, tool, args, signal) {
    if (!DISPATCHER_ALLOWED.has(tool)) {
      throw Object.assign(new Error('诊断调度器不支持该操作：' + tool), { code: 'UNSUPPORTED' });
    }
    const validated = validateProbeArgs(tool, args);
    if (!validated.ok) {
      throw Object.assign(new Error(validated.reason), { code: 'INVALID_ARGUMENT' });
    }
    const guarded = validated.value;
    const entry = toolDefinitions.get(tool);
    if (!entry || !entry.definition || typeof entry.definition.execute !== 'function') {
      throw Object.assign(new Error('工具未注册：' + tool), { code: 'TOOL_NOT_FOUND' });
    }
    const startedAt = mono();
    const value = await entry.definition.execute(guarded, {
      agent: dispatchAgentFor(ctx),
      runtime: ctx.runtime,
      signal,
      // The diagnose run already froze the scope and the runtime it inspected; re-resolving would
      // create a second runtime for the same workspace (or fail for an unassigned scope).
      diagnosticScope: { resolved: ctx.resolved, entry: ctx.entry },
    });
    const call = {
      tool,
      ok: true,
      startedAt: wall(),
      durationMs: Math.round((mono() - startedAt) * 1000) / 1000,
      provider: ctx.provider,
      response: summarise(value),
    };
    ctx.actualCalls.push(call);
    return { value, call };
  }

  /** Bounded structural summary of a tool value (never the whole payload). */
  function summarise(value) {
    if (!value || typeof value !== 'object') return { type: typeof value };
    const out = { keys: Object.keys(value).slice(0, 12) };
    if (typeof value.ok === 'boolean') out.ok = value.ok;
    if (typeof value.value === 'number' || typeof value.value === 'string') out.value = value.value;
    if (value.result && typeof value.result === 'object') {
      out.result = {};
      if (typeof value.result.type === 'string') out.result.type = value.result.type;
      if (typeof value.result.value === 'number' || typeof value.result.value === 'string') out.result.value = value.result.value;
      if (typeof value.result.description === 'string') out.result.description = value.result.description.slice(0, 120);
    }
    if (typeof value.tool === 'string') out.tool = value.tool;
    if (Array.isArray(value.capabilities)) out.capabilities = value.capabilities.length;
    return out;
  }

  async function run(req, res, { scopeRequest, resolveScopeRequest }) {
    const startedMono = mono();
    const startedAt = wall();
    const runId = randomUUID();
    let seq = 0;
    const nextSeq = () => { seq += 1; return seq; };

    // --- body validation (before any side effect) -------------------------------------
    let body = {};
    try { body = await readJson(req); } catch { body = null; }
    if (!body || typeof body !== 'object' || Array.isArray(body)) {
      return fail(res, 400, 'INVALID_ARGUMENT', 'body 必须是对象');
    }
    const keys = Object.keys(body);
    const extra = keys.filter((key) => !BODY_KEYS.has(key));
    if (extra.length) {
      return fail(res, 400, 'INVALID_ARGUMENT', 'body 只允许 {provider?, mode, requestId}，不接受 ' + extra.join(','));
    }
    const mode = body.mode === 'start' ? 'start' : 'observe';
    if (body.mode !== undefined && body.mode !== 'observe' && body.mode !== 'start') {
      return fail(res, 400, 'INVALID_ARGUMENT', 'mode 必须是 observe|start');
    }
    if (body.provider !== undefined && (typeof body.provider !== 'string' || !body.provider)) {
      return fail(res, 400, 'INVALID_ARGUMENT', 'provider 必须是非空字符串');
    }
    const requestId = typeof body.requestId === 'string' ? body.requestId.slice(0, 128) : null;

    // --- scope freeze -----------------------------------------------------------------
    let resolved = null;
    let scopeFail = null;
    try {
      resolved = await resolveScopeRequest(scopeRequest);
    } catch (error) {
      scopeFail = String((error && error.message) || error);
    }
    const scope = resolved ? resolved.scope : null;

    res.writeHead(200, {
      'content-type': NDJSON,
      'cache-control': 'no-store',
      'x-accel-buffering': 'no',
      connection: 'keep-alive',
    });
    let closed = false;
    let cancelled = false;
    // Only a close *before* we finished writing means the client went away: `req.on('close')`
    // fires as soon as the request body is consumed, which would cancel every run immediately.
    const onClose = () => { if (!res.writableEnded) { closed = true; cancelled = true; } };
    res.on('close', onClose);
    res.on('error', onClose);
    const emit = (event) => {
      if (closed || res.writableEnded || res.destroyed) { closed = true; return null; }
      const payload = JSON.stringify({ ...event, seq: nextSeq() });
      try { res.write(payload + '\n'); } catch { closed = true; }
      return payload;
    };

    // Scope could not be resolved: the whole run is UNKNOWN. We never guess with `recent`.
    if (!resolved) {
      emit({ type: 'run-start', runId, provider: body.provider || null, mode, scope: null, configRevision: null, startedAt });
      emit({
        type: 'run-end', runId, finishedAt: wall(),
        overall: { status: 'UNKNOWN', reason: 'scope-unresolved' },
        stages: { ...STAGE_IDS.reduce((acc, id) => ({ ...acc, [id]: { stageId: id, status: 'UNKNOWN', reason: 'scope-unresolved', blockedBy: null, durationMs: null } }), {}) },
        axes: {},
        actualCalls: [],
        sideEffects: [],
        error: scopeFail,
        requestId,
      });
      try { res.end(); } catch { /* ignore */ }
      return;
    }

    const config = crossEnvironment.configStore.getConfig();
    const configRevision = typeof config.revision === 'number' ? config.revision : null;
    const snapshot = crossEnvironment.snapshotForScope(scope);
    const provider = body.provider || snapshot.provider || 'chrome';
    const agent = crossEnvironment.agentForScope(scopeRequest, resolved)
      || { id: scope?.id ?? null, session: { header: { cwd: scope?.cwd ?? null } } };

    emit({
      type: 'run-start', runId, provider, mode,
      scope: { id: scope?.id ?? null, kind: scope?.kind ?? null, workspaceId: scope?.workspaceId ?? null },
      configRevision, startedAt, requestId,
    });

    const ctx = {
      provider, mode, agent, configRevision, snapshot, scope, resolved,
      runtime: null, entry: null, actualCalls: [], sideEffects: [],
      stage3: null, stage4: null, cancelled: () => cancelled,
    };

    // Resolve the runtime *identity* first. observe must not spawn; a cold entry is allowed and
    // recorded. start goes further (ensure) inside stage 3's budget.
    try {
      const before = registry.entries.size;
      ctx.entry = registry.getOrCreate(resolved);
      ctx.runtime = ctx.entry.runtime;
      if (registry.entries.size > before) {
        ctx.sideEffects.push({ kind: 'cold-entry', at: wall(), provider: ctx.entry.provider, note: 'created a cold runtime entry (no browser started)' });
      }
    } catch (error) {
      ctx.sideEffects.push({ kind: 'cold-entry', error: String((error && error.message) || error), at: wall() });
    }

    const stages = {};
    const stageEvents = [];
    const runAbort = new AbortController();
    const runTimer = setTimeout(() => runAbort.abort(), RUN_BUDGET_MS);
    let statuses = [];

    const stageStart = (stageId) => {
      const startedAtMs = wall();
      const startedMonoMs = mono();
      emit({ type: 'stage-start', runId, stageId, phase: 'running', startedAt: startedAtMs });
      stageEvents.push({ stageId, startedAt: startedAtMs });
      return {
        finish: (status, reason, extra = {}) => {
          const durationMs = Math.round((mono() - startedMonoMs) * 1000) / 1000;
          const event = {
            type: 'stage-end', runId, stageId, phase: 'finished',
            status, reason: reason || null,
            blockedBy: extra.blockedBy ?? null,
            startedAt: startedAtMs, finishedAt: wall(), durationMs,
            checks: extra.checks || [], evidenceRef: extra.evidenceRef || null,
          };
          stages[stageId] = {
            stageId, phase: 'finished', status, reason: reason || null,
            blockedBy: extra.blockedBy ?? null, durationMs,
            startedAt: startedAtMs, finishedAt: event.finishedAt,
            checks: extra.checks || [], evidenceRef: extra.evidenceRef || null,
          };
          statuses.push(status);
          emit(event);
          return stages[stageId];
        },
        // A stage that never ran: no start/end pair, no duration. Only a deterministic reason.
        skip: (reason, blockedBy, checks = []) => {
          stages[stageId] = {
            stageId, phase: 'finished', status: 'SKIPPED', reason, blockedBy,
            durationMs: null, startedAt: null, finishedAt: null, checks, evidenceRef: null,
          };
          statuses.push('SKIPPED');
          emit({
            type: 'stage-end', runId, stageId, phase: 'finished', status: 'SKIPPED',
            reason, blockedBy: blockedBy ?? null, startedAt: null, finishedAt: null,
            durationMs: null, checks, evidenceRef: null, skipped: true,
          });
          return stages[stageId];
        },
      };
    };

    const budget = (stageId, promiseFactory) => withBudget(stageId, STAGE_BUDGET_MS[stageId], promiseFactory, runAbort.signal);

    try {
      /* ---- stage 1: registration + one real dispatch ---------------------------------- */
      {
        const stage = stageStart('1');
        if (cancelled) { stage.finish('UNKNOWN', 'cancelled'); }
        else {
          const result = await budget('1', () => stageOne(ctx, dispatch, crossEnvironment, toolDefinitions, runAbort.signal));
          if (result.timeout) stage.finish('UNKNOWN', 'stage-timeout');
          else stage.finish(result.status, result.reason, { checks: result.checks });
        }
      }
      /* ---- stage 2: config + adapter + queue/lease facts ------------------------------- */
      {
        const stage = stageStart('2');
        if (stages['1'] && stages['1'].status === 'FAIL') stage.skip('blocked-by-stage-1', '1');
        else if (cancelled) stage.finish('UNKNOWN', 'cancelled');
        else {
          const result = await budget('2', () => stageTwo(ctx, crossEnvironment, registry, runAbort.signal));
          if (result.timeout) stage.finish('UNKNOWN', 'stage-timeout');
          else stage.finish(result.status, result.reason, { checks: result.checks });
        }
      }
      /* ---- stage 3: existing transport + real Browser.getVersion ----------------------- */
      {
        const stage = stageStart('3');
        if (stages['1'] && stages['1'].status === 'FAIL') stage.skip('blocked-by-stage-1', '1');
        else if (cancelled) stage.finish('UNKNOWN', 'cancelled');
        else {
          const result = await budget('3', () => stageThree(ctx, runAbort.signal));
          if (result.timeout) stage.finish('UNKNOWN', 'stage-timeout');
          else stage.finish(result.status, result.reason, { checks: result.checks });
        }
      }
      /* ---- stage 4: executable + product identity ------------------------------------- */
      {
        const stage = stageStart('4');
        if (stages['1'] && stages['1'].status === 'FAIL') stage.skip('blocked-by-stage-1', '1');
        else if (cancelled) stage.finish('UNKNOWN', 'cancelled');
        else {
          const result = await budget('4', () => stageFour(ctx, resolveProviderExecutable, webProviderSupport, runAbort.signal));
          if (result.timeout) stage.finish('UNKNOWN', 'stage-timeout');
          else stage.finish(result.status, result.reason, { checks: result.checks });
        }
      }
      /* ---- stage 5: target list + binding + read-only eval ---------------------------- */
      {
        const stage = stageStart('5');
        if (stages['1'] && stages['1'].status === 'FAIL') stage.skip('blocked-by-stage-1', '1');
        else if (stages['3'] && stages['3'].status === 'SKIPPED') stage.skip('blocked-by-stage-3', '3');
        // A provider mismatch leaves `ctx.runtime` present (the *other* provider's runtime), so the
        // "no cdp" guard below does not catch it: the run would happily list that runtime's targets
        // and answer "the page works" for a provider that has no page at all. No object to inspect
        // means no conclusion — SKIPPED, with the two providers named in the evidence.
        else if (providerSubjectMismatch(ctx)) {
          ctx.stage5SkipReason = 'blocked-by-provider-mismatch';
          stage.skip('blocked-by-provider-mismatch', '3', [providerMismatchCheck(ctx)]);
        } else if (stages['3'] && (stages['3'].status === 'WARN' || stages['3'].status === 'FAIL') && !ctx.runtime?.cdp) {
          ctx.stage5SkipReason = 'blocked-by-stage-3';
          stage.skip('blocked-by-stage-3', '3');
        } else if (cancelled) stage.finish('UNKNOWN', 'cancelled');
        else {
          const result = await budget('5', () => stageFive(ctx, dispatch, runAbort.signal));
          if (result.timeout) stage.finish('UNKNOWN', 'stage-timeout');
          else stage.finish(result.status, result.reason, { checks: result.checks });
        }
      }
    } finally {
      clearTimeout(runTimer);
      try { res.removeListener('close', onClose); } catch { /* ignore */ }
    }

    const axes = projectAxes(ctx, crossEnvironment, snapshot, provider);
    const overallStatus = overallOf(stages);
    const overall = {
      status: overallStatus,
      reason: overallStatus === 'PASS' ? '本次诊断检查通过' : firstReason(stages),
    };
    emit({
      type: 'run-end', runId,
      overall,
      stages,
      axes,
      actualCalls: ctx.actualCalls,
      sideEffects: ctx.sideEffects,
      finishedAt: wall(),
      durationMs: Math.round((mono() - startedMono) * 1000) / 1000,
      cancelled: cancelled || undefined,
      requestId,
    });
    try { res.end(); } catch { /* ignore */ }
  }

  /* ------------------------------------------------------------------------------------
   * Stages
   * ---------------------------------------------------------------------------------- */

  async function stageOne(ctx, dispatchTool, crossEnvironment, toolDefinitions, signal) {
    const checks = [];
    let declarable = [];
    let registered = [];
    try {
      declarable = [...crossEnvironment.declarableToolNames()].sort();
      registered = [...toolDefinitions.keys()].sort();
    } catch (error) {
      return { status: 'FAIL', reason: 'registration-unreadable', checks: [{ id: 'definitions', status: 'fail', detail: String((error && error.message) || error) }] };
    }
    const missing = declarable.filter((name) => !registered.includes(name));
    checks.push({
      id: 'definitions-registered',
      status: missing.length ? 'fail' : 'pass',
      detail: missing.length ? '未注册的定义：' + missing.slice(0, 6).join(',') : '声明集合与已注册定义一致（' + declarable.length + ' 个）',
    });
    let admissible = [];
    try { admissible = [...crossEnvironment.admissibleToolNames(ctx.agent)].sort(); } catch { admissible = []; }
    const notAdmitted = declarable.filter((name) => !admissible.includes(name));
    checks.push({
      id: 'tool-admission',
      status: notAdmitted.length ? 'warn' : 'pass',
      detail: notAdmitted.length ? '未准入：' + notAdmitted.slice(0, 6).join(',') : '当前作用域准入通过（' + admissible.length + ' 个）',
    });

    let callStatus = 'warn';
    let callReason = 'tool-call-not-attempted';
    try {
      await dispatchTool(ctx, 'browser_capabilities', {}, signal);
      callStatus = 'pass';
      callReason = null;
      checks.push({ id: 'tool-call', status: 'pass', detail: 'browser_capabilities 经真实 handler 返回' });
    } catch (error) {
      const code = String((error && error.code) || '');
      callStatus = 'warn';
      callReason = code ? 'tool-call-' + code.toLowerCase() : 'tool-call-failed';
      checks.push({ id: 'tool-call', status: 'warn', detail: String((error && error.message) || error).slice(0, 200), code: code || null });
    }
    if (missing.length) return { status: 'FAIL', reason: 'registration-broken', checks };
    if (callStatus !== 'pass') return { status: 'WARN', reason: callReason, checks };
    if (notAdmitted.length) return { status: 'WARN', reason: 'tool-not-admitted', checks };
    return { status: 'PASS', reason: null, checks };
  }

  async function stageTwo(ctx, crossEnvironment, registry, signal) {
    const checks = [];
    const revision = ctx.configRevision;
    const configValid = typeof revision === 'number';
    checks.push({ id: 'config-revision', status: configValid ? 'pass' : 'fail', detail: configValid ? 'revision ' + revision : '缺少合法 revision' });
    let adapterOk = false;
    let adapterError = null;
    try {
      const resolvedAdapter = crossEnvironment.adapterRegistry.resolve({
        ...ctx.snapshot, environment: 'web', adapterId: ctx.provider,
      });
      adapterOk = Boolean(resolvedAdapter && resolvedAdapter.targetAdapter);
      checks.push({ id: 'adapter-resolve', status: adapterOk ? 'pass' : 'fail', detail: adapterOk ? 'adapter ' + ctx.provider + ' 可解析' : '未解析出适配器' });
    } catch (error) {
      adapterError = String((error && error.message) || error);
      checks.push({ id: 'adapter-resolve', status: 'fail', detail: adapterError.slice(0, 200) });
    }
    // Real queue/lease facts. An empty queue is NOT evidence that anything executed.
    const runtime = ctx.runtime;
    const queue = runtime
      ? {
        sessionId: typeof runtime.activeOwner === 'string' ? runtime.activeOwner : null,
        inflight: Number(runtime.inflight) || 0,
        active: Number(runtime.active) || 0,
        lease: runtime.lease ? { sessionId: runtime.lease.sessionId, expiresAt: runtime.lease.expiresAt } : null,
      }
      : null;
    checks.push({
      id: 'queue-lease',
      status: queue ? 'pass' : 'warn',
      detail: queue
        ? 'inflight=' + queue.inflight + ' active=' + queue.active + ' lease=' + (queue.lease ? queue.lease.sessionId : 'none')
          // The queue is a fact about the *existing* runtime; when that runtime belongs to another
          // provider the numbers are still true but they are not about the requested provider.
          + (providerSubjectMismatch(ctx)
            ? '（现存运行时属于 ' + String(ctx.entry?.provider || 'unknown') + '，不是本次请求的 ' + String(ctx.provider) + '）'
            : '')
        : '没有运行时条目（冷态）：队列与租约事实不可读，不能据此声称已执行',
    });
    if (!configValid || !adapterOk) return { status: 'FAIL', reason: configValid ? 'adapter-unresolved' : 'config-invalid', checks };
    if (!queue) return { status: 'WARN', reason: 'no-runtime-entry', checks };
    return { status: 'PASS', reason: null, checks };
  }

  async function stageThree(ctx, signal) {
    const checks = [];
    const runtime = ctx.runtime;
    // `start` is the only mode allowed to create a browser, and it must go through the existing
    // product path (Runtime.ensure → BrowserHost identity validation → page + CDP).
    if (ctx.mode === 'start' && (!runtime || !runtime.cdp || runtime.cdp.closed)) {
      if (!runtime) {
        checks.push({ id: 'ensure', status: 'warn', detail: '没有可 ensure 的运行时条目' });
        return { status: 'WARN', reason: 'no-runtime-entry', checks };
      }
      const ensureStarted = mono();
      ctx.sideEffects.push({ kind: 'ensure', at: wall(), provider: ctx.provider, budgetMs: START_BUDGET_MS });
      try {
        await withBudget('ensure', START_BUDGET_MS, () => runtime.ensure(signal), signal);
        checks.push({ id: 'ensure', status: 'pass', detail: 'Runtime.ensure 完成（' + Math.round(mono() - ensureStarted) + 'ms）' });
        ctx.sideEffects.push({ kind: 'spawn', at: wall(), provider: ctx.provider, note: 'browser started by Runtime.ensure' });
        const lease = runtime.lease;
        ctx.sideEffects.push({ kind: 'lease', at: wall(), sessionId: lease ? lease.sessionId : null, expiresAt: lease ? lease.expiresAt : null });
      } catch (error) {
        const code = String((error && error.code) || '');
        const busy = code === 'BUSY' || /BUSY/.test(String((error && error.message) || ''));
        checks.push({ id: 'ensure', status: busy ? 'warn' : 'warn', detail: (code || 'ENSURE_FAILED') + ': ' + String((error && error.message) || error).slice(0, 160), code: code || null });
        // BUSY never steals the lease; any other ensure failure is a preamble gap, not a protocol error.
        return { status: 'WARN', reason: busy ? 'busy' : 'browser-not-running', checks };
      }
    }
    if (!runtime || !runtime.cdp || runtime.cdp.closed) {
      checks.push({ id: 'transport', status: 'warn', detail: '没有现存 CDP transport（observe 不启动浏览器）' });
      return { status: 'WARN', reason: 'browser-not-running', checks };
    }
    if (ctx.entry && ctx.entry.provider && ctx.entry.provider !== ctx.provider) {
      checks.push({ id: 'provider-match', status: 'warn', detail: '现存运行时属于 ' + ctx.entry.provider + '，本次请求是 ' + ctx.provider });
      return { status: 'WARN', reason: 'provider-mismatch', checks };
    }
    try {
      const info = await runtime.send('Browser.getVersion', {}, signal);
      const product = typeof info?.product === 'string' ? info.product : '';
      ctx.stage3 = { product, protocolVersion: typeof info?.protocolVersion === 'string' ? info.protocolVersion : null };
      checks.push({ id: 'browser-get-version', status: 'pass', detail: product || '(empty product)' });
      return { status: 'PASS', reason: null, checks };
    } catch (error) {
      const code = String((error && error.code) || '');
      checks.push({ id: 'browser-get-version', status: 'fail', detail: (code || 'CDP_ERROR') + ': ' + String((error && error.message) || error).slice(0, 160) });
      return { status: 'FAIL', reason: 'cdp-protocol-error', checks };
    }
  }

  async function stageFour(ctx, resolveExecutable, supportOf, signal) {
    const checks = [];
    if (signal?.aborted) return { status: 'UNKNOWN', reason: 'cancelled', checks };
    let resolution = null;
    try { resolution = resolveExecutable({ provider: ctx.provider }); } catch (error) { resolution = { path: null, reason: String((error && error.message) || error) }; }
    const path = resolution && typeof resolution.path === 'string' ? resolution.path : null;
    checks.push({
      id: 'executable-file',
      status: path ? 'pass' : 'warn',
      detail: path ? path : '未找到可执行文件（' + String((resolution && resolution.reason) || 'executable-missing') + '）',
    });
    // Product identity comes from stage 3's real `Browser.getVersion`, never from the protocol name.
    const product = ctx.stage3 && ctx.stage3.product ? ctx.stage3.product : '';
    const isEdge = /Edg\//.test(product);
    const isChrome = /Chrome\//.test(product) && !isEdge;
    const expectedEdge = ctx.provider === 'edge';
    let identity = 'unverified';
    if (product) {
      if (expectedEdge ? isEdge : isChrome) identity = 'match';
      else identity = 'mismatch';
    }
    checks.push({
      id: 'product-identity',
      status: identity === 'match' ? 'pass' : identity === 'mismatch' ? 'fail' : 'warn',
      detail: product
        ? (identity === 'match' ? '产品身份匹配：' + product : '产品身份不符：' + product)
        // Distinguish "nothing is running" from "what is running is not the provider you asked
        // for": the second must not read as "this provider's identity is unknown".
        : (providerSubjectMismatch(ctx)
          ? '未取得产品身份：现存运行时属于 ' + String(ctx.entry?.provider || 'unknown')
            + '，不属于本次请求的 ' + String(ctx.provider) + '（该 provider 没有现存连接）'
          : '未取得产品身份（没有现存连接）'),
    });
    let support = 'unsupported';
    try { support = String(supportOf(ctx.provider) || 'unsupported'); } catch { support = 'unsupported'; }
    checks.push({ id: 'provider-support', status: support === 'supported' ? 'pass' : 'warn', detail: support });
    ctx.stage4 = { status: null, path, identity, product, support };
    if (identity === 'mismatch') { ctx.stage4.status = 'FAIL'; return { status: 'FAIL', reason: 'identity-mismatch', checks }; }
    if (!path) { ctx.stage4.status = 'WARN'; return { status: 'WARN', reason: 'executable-missing', checks }; }
    if (identity !== 'match') { ctx.stage4.status = 'WARN'; return { status: 'WARN', reason: 'identity-unverified', checks }; }
    ctx.stage4.status = 'PASS';
    return { status: 'PASS', reason: null, checks };
  }

  /**
   * True when the page group this run froze belongs to a *different* provider than the one requested.
   *
   * The two subjects of a run are not the same thing: stage 4 resolves an executable for
   * `ctx.provider` (what was asked for), while stage 3/5 inspect `ctx.entry.runtime` (what already
   * exists). When they disagree there is no object of the requested provider to inspect, so every
   * downstream verdict about it — including "the target list works" — would describe the *other*
   * provider. Callers must say so instead of answering.
   */
  function providerSubjectMismatch(ctx) {
    return Boolean(ctx && ctx.entry && ctx.entry.provider && ctx.entry.provider !== ctx.provider);
  }

  /** One check row describing the mismatch, so the reason travels with the evidence. */
  function providerMismatchCheck(ctx) {
    return {
      id: 'provider-match',
      status: 'warn',
      detail: '本次请求 provider=' + String(ctx.provider)
        + '，被诊断的运行时属于 ' + String(ctx.entry?.provider || 'unknown')
        + '：该 provider 下没有可诊断对象，本阶段不给结论',
    };
  }

  async function stageFive(ctx, dispatchTool, signal) {
    const checks = [];
    const runtime = ctx.runtime;
    // Defence in depth: the orchestrator already refuses to call this stage for a mismatched
    // provider. Answering here anyway would grade the *other* provider's page.
    if (providerSubjectMismatch(ctx)) {
      checks.push(providerMismatchCheck(ctx));
      return { status: 'SKIPPED', reason: 'blocked-by-provider-mismatch', checks };
    }
    let targets = [];
    try {
      const listed = await runtime.send('Target.getTargets', {}, signal);
      targets = Array.isArray(listed?.targetInfos) ? listed.targetInfos : [];
      ctx.stage5ListOk = true;
      checks.push({ id: 'target-list', status: 'pass', detail: targets.length + ' 个 target' });
    } catch (error) {
      checks.push({ id: 'target-list', status: 'fail', detail: String((error && error.message) || error).slice(0, 160) });
      return { status: 'FAIL', reason: 'target-list-failed', checks };
    }
    const boundTargetId = runtime.page && runtime.page.targetId ? runtime.page.targetId : null;
    if (!boundTargetId) {
      checks.push({ id: 'binding', status: 'warn', detail: '没有已绑定的 page target（不自动挑页/建页/改绑定）' });
      return { status: 'WARN', reason: 'no-bound-target', checks };
    }
    const pageTarget = targets.find((target) => target && target.targetId === boundTargetId);
    checks.push({
      id: 'binding',
      status: pageTarget && pageTarget.type === 'page' ? 'pass' : 'warn',
      detail: pageTarget ? 'targetId ' + boundTargetId + '（' + String(pageTarget.type || 'unknown') + '）' : 'targetId ' + boundTargetId + ' 不在当前列表',
    });
    let evalValue;
    try {
      const result = await dispatchTool(ctx, 'browser_eval', { expression: '1' }, signal);
      const payload = result.value && typeof result.value === 'object' ? result.value : {};
      // `browser_eval` answers `{ok, value, type, ...}`; tolerate the nested CDP shape as a fallback.
      evalValue = 'value' in payload
        ? payload.value
        : (payload.result && typeof payload.result === 'object' && 'value' in payload.result ? payload.result.value : undefined);
      checks.push({ id: 'readonly-eval', status: evalValue === 1 ? 'pass' : 'warn', detail: 'browser_eval(\'1\') → ' + String(evalValue) });
    } catch (error) {
      const code = String((error && error.code) || '');
      checks.push({ id: 'readonly-eval', status: 'fail', detail: (code || 'EVAL_FAILED') + ': ' + String((error && error.message) || error).slice(0, 160) });
      return { status: 'FAIL', reason: 'readonly-eval-failed', checks };
    }
    ctx.stage5 = { targetId: boundTargetId, evalValue };
    if (!pageTarget || pageTarget.type !== 'page') return { status: 'WARN', reason: 'target-not-in-list', checks };
    if (evalValue !== 1) return { status: 'WARN', reason: 'readonly-eval-unexpected', checks };

    // 加深诊断：真的跑几条**只读**能力探测（快照 / 截图 / 计算样式 / 网络元数据读取）。
    // 只看摘要，绝不把页面树或图片塞进 NDJSON；预算 8s 总、单条 3s，BUSY 记 skip 不夺权。
    const probes = await runProbes(ctx, dispatchTool, signal);
    ctx.probes = probes;
    for (const probe of probes) checks.push(probe);
    const probeFailures = probes.filter((probe) => probe.status !== 'pass');
    if (probeFailures.length) {
      return { status: 'WARN', reason: 'capability-partial', checks };
    }
    return { status: 'PASS', reason: null, checks };
  }

  /**
   * Read-only capability probes. Every call still goes through the real handler (admission,
   * adapter, Runtime.run); we only keep a *digest* of the answer, so `run-end` stays small.
   */
  async function runProbes(ctx, dispatchTool, signal) {
    const deadline = mono() + PROBE_LIMITS.probeBudgetMs;
    const out = [];
    const push = (id, status, detail) => { out.push({ id, status, detail }); };
    const summariseScreenshot = (payload) => {
      let image = '';
      for (const candidate of [payload && payload.image, payload && payload.data, payload && payload.base64]) {
        if (typeof candidate === 'string' && candidate.length > 64) { image = candidate; break; }
      }
      const stats = { bytes: 0, width: null, height: null, sha256: null };
      const findNumber = (key) => {
        for (const source of [payload, payload && payload.capture, payload && payload.capture && payload.capture.image, payload && payload.stats]) {
          if (source && typeof source === 'object' && Number.isFinite(source[key])) return source[key];
        }
        return null;
      };
      stats.width = findNumber('width');
      stats.height = findNumber('height');
      if (image) {
        let buffer = null;
        try { buffer = Buffer.from(image, 'base64'); } catch { buffer = null; }
        if (buffer) {
          stats.bytes = buffer.length;
          stats.sha256 = createHash('sha256').update(buffer).digest('hex').slice(0, 16);
        }
      }
      if (!stats.bytes && Number.isFinite(findNumber('bytes'))) stats.bytes = findNumber('bytes');
      return stats;
    };

    const run = async (id, tool, args) => {
      if (mono() > deadline) { push(id, 'skip', 'probe-budget-exhausted'); return; }
      if (ctx.cancelled && ctx.cancelled()) { push(id, 'skip', 'cancelled'); return; }
      try {
        const result = await withBudget('probe-' + id, PROBE_LIMITS.probeTimeoutMs, () => dispatchTool(ctx, tool, args, signal), signal);
        if (result && result.timeout) { push(id, 'fail', 'probe-timeout'); return; }
        const payload = result && result.value && typeof result.value === 'object' ? result.value : {};
        if (id === 'snapshot') {
          const snapshot = payload.snapshot && typeof payload.snapshot === 'object' ? payload.snapshot : payload;
          const nodes = Array.isArray(snapshot.nodes) ? snapshot.nodes.length
            : (Number.isFinite(snapshot.nodeCount) ? snapshot.nodeCount : null);
          const snapshotId = typeof snapshot.snapshotId === 'string' ? snapshot.snapshotId
            : (typeof payload.snapshotId === 'string' ? payload.snapshotId : null);
          ctx.probeDigests = Object.assign({}, ctx.probeDigests, { snapshot: { nodeCount: nodes, snapshotId } });
          push(id, nodes === null ? 'fail' : 'pass', nodes === null ? '快照未返回节点数' : 'nodeCount=' + nodes + (snapshotId ? ' · id=' + snapshotId : ''));
          return;
        }
        if (id === 'screenshot') {
          const stats = summariseScreenshot(payload);
          ctx.probeDigests = Object.assign({}, ctx.probeDigests, { screenshot: stats });
          push(id, stats.bytes > 0 ? 'pass' : 'fail',
            stats.bytes > 0
              ? 'png ' + stats.bytes + 'B · ' + String(stats.width || '?') + 'x' + String(stats.height || '?') + ' · ' + String(stats.sha256)
              : '截图未返回图像数据');
          return;
        }
        if (id === 'computed-style') {
          const style = payload.style && typeof payload.style === 'object' ? payload.style : payload;
          const display = style && (style.display || (style.properties && style.properties.display));
          push(id, display ? 'pass' : 'fail', display ? 'body.display=' + String(display).slice(0, 24) : '未取到计算样式值');
          return;
        }
        if (id === 'network-read') {
          const requests = Array.isArray(payload.requests) ? payload.requests
            : (Array.isArray(payload.entries) ? payload.entries : (Array.isArray(payload) ? payload : null));
          push(id, requests ? 'pass' : 'fail', requests ? 'read only · ' + requests.length + ' 条（未启动采集）' : '返回结构不合法');
          return;
        }
        push(id, 'fail', '未知探测');
      } catch (error) {
        const code = String((error && error.code) || '');
        if (code === 'BUSY' || /BUSY/.test(String((error && error.message) || ''))) { push(id, 'skip', 'busy（不夺权）'); return; }
        if (code === 'ABORTED' || (error && error.name === 'AbortError')) { push(id, 'skip', 'cancelled'); return; }
        push(id, 'fail', (code || 'PROBE_FAILED') + ': ' + String((error && error.message) || error).slice(0, 120));
      }
    };

    await run('snapshot', 'browser_snapshot', { maxNodes: 50 });
    await run('screenshot', 'browser_screenshot', {});
    await run('computed-style', 'browser_computed_style', { selector: 'body', properties: ['display'] });
    await run('network-read', 'browser_network', { limit: 5 });
    return out;
  }

  /* ------------------------------------------------------------------------------------
   * Projection
   * ---------------------------------------------------------------------------------- */

  function projectAxes(ctx, crossEnvironment, snapshot, provider) {
    const saved = (() => {
      try {
        const config = crossEnvironment.configStore.getConfig();
        const web = config?.global?.environments?.web;
        const value = web?.providers?.[provider]?.enabled;
        return value === true ? 'true' : value === false ? 'false' : 'not-probed';
      } catch { return 'not-probed'; }
    })();
    let support = 'not-probed';
    try {
      const raw = String((deps.webProviderSupport && deps.webProviderSupport(provider)) || '');
      if (raw) support = raw === 'planned' ? 'planned' : raw;
    } catch { support = 'not-probed'; }
    const stage3 = ctx.stage3;
    const stage4 = ctx.stage4;
    const stage5 = ctx.stage5;
    const dependency = stage4?.status === 'PASS' ? 'ok' : stage4?.status === 'FAIL' ? 'failed' : 'not-probed';
    const connection = stage3?.product ? 'ok' : 'not-probed';
    const target = stage5?.targetId ? 'bound' : 'unbound';
    // capability only claims what was actually measured: a successful read-only eval proves the
    // read-only JS path, nothing else.
    // capability 现在由**真跑过的六条只读探测**决定：全过 → available，部分过 → partial，
    // 一条没跑（冷态/无连接）→ not-probed。没有连接时明确记 skip（不是 fail），避免污染结论。
    const probes = Array.isArray(ctx.probes) ? ctx.probes : [];
    const checks = {};
    const checksDetail = [];
    const addCheck = (id, status, detail) => {
      checks[id] = status;
      checksDetail.push({ id, status, detail });
    };
    if (stage5) {
      addCheck('readonly-eval', stage5.evalValue === 1 ? 'pass' : 'fail', stage5.evalValue === 1 ? '返回 1' : '返回值不是 1');
      addCheck('target-list', ctx.stage5ListOk ? 'pass' : 'fail', ctx.stage5ListOk ? '已列出目标' : '未列出目标');
      for (const probe of probes) addCheck(probe.id, probe.status, probe.detail);
    } else {
      const why = ctx.stage5SkipReason === 'blocked-by-provider-mismatch'
        ? '运行时不属于本次请求的 provider：没有该 provider 的可诊断对象，未执行探测'
        : '无连接：本次诊断没有可用的调试连接，未执行探测';
      for (const id of ['readonly-eval', 'target-list', 'snapshot', 'screenshot', 'computed-style', 'network-read']) {
        addCheck(id, 'skip', why);
      }
    }
    const ran = checksDetail.filter((check) => check.status !== 'skip');
    const passed = checksDetail.filter((check) => check.status === 'pass');
    let capability = 'not-probed';
    if (passed.length && passed.length === checksDetail.length) capability = 'available';
    else if (passed.length) capability = 'partial';
    else capability = 'not-probed';
    return {
      support,
      enabled: saved,
      dependency,
      connection,
      target,
      capability,
      checks,
      checksDetail,
      digests: ctx.probeDigests || {},
      probeCount: { total: checksDetail.length, ran: ran.length, passed: passed.length },
    };
  }

  function overallOf(stages) {
    const list = STAGE_IDS.map((id) => stages[id]).filter(Boolean);
    const statuses = list.map((stage) => stage.status);
    if (statuses.includes('FAIL')) return 'FAIL';
    if (statuses.includes('UNKNOWN')) return 'UNKNOWN';
    if (statuses.includes('WARN')) return 'WARN';
    const requiredSkipped = list.filter((stage) => REQUIRED_STAGES.has(stage.stageId) && stage.status === 'SKIPPED');
    if (requiredSkipped.length) return 'WARN';
    return 'PASS';
  }

  function firstReason(stages) {
    for (const id of STAGE_IDS) {
      const stage = stages[id];
      if (!stage) continue;
      if (stage.status === 'FAIL' || stage.status === 'UNKNOWN' || stage.status === 'WARN' || stage.status === 'SKIPPED') {
        return (stage.reason || 'stage-' + id) + (stage.blockedBy ? ' (blockedBy:' + stage.blockedBy + ')' : '');
      }
    }
    return null;
  }

  return { handleHttp };
}

/** Bound one stage; a timeout is UNKNOWN, never a silent PASS. */
async function withBudget(stageId, budgetMs, factory, outerSignal) {
  const controller = new AbortController();
  const onAbort = () => controller.abort();
  if (outerSignal) {
    if (outerSignal.aborted) controller.abort();
    else outerSignal.addEventListener('abort', onAbort, { once: true });
  }
  let timer = null;
  const timeout = new Promise((resolve) => {
    timer = setTimeout(() => {
      controller.abort();
      resolve({ timeout: true });
    }, budgetMs);
  });
  try {
    const result = await Promise.race([
      Promise.resolve().then(() => factory(controller.signal)).then((value) => ({ value })),
      timeout,
    ]);
    if (result.timeout) return { timeout: true, stageId };
    return result.value;
  } finally {
    if (timer !== null) clearTimeout(timer);
    if (outerSignal) outerSignal.removeEventListener('abort', onAbort);
  }
}
