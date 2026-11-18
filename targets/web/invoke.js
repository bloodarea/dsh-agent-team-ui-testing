/**
 * Web dispatch pipeline: what happens between "this call is admitted" and "the page executed it".
 *
 * The public Host decides *who* may call and *whether* the call is admitted; this module owns the
 * platform half (plan §Host 负责编排，环境实现负责执行):
 *
 *   resolve the page → authorise the page part (through the Host's verdict callback) → preflight →
 *   take the page queue and the single-owner lease → dispatch-time re-check → run the handler →
 *   record the action → return the platform facts.
 *
 * Everything it returns is a *fact*, not an envelope: `{ value, target, tab, control }`. Building
 * the caller-facing envelope (lossless JSON, scope/config/action identity, error classification)
 * stays in the Host.
 *
 * Dependency direction: `core/` and the Web runtime module only. The Host injects
 *  - `resolveScope(exec, principal)` — session/workspace resolution (Cordis services),
 *  - `authorize({ entry, effects, operation, expectedControlRevision })` — the M2a page verdict,
 *  - `dispatch(thunk, executionClass, targetInfo)` — the capability-adapter invocation (evidence).
 */
import {
  CONTROL_EVENT, EFFECT, RESOURCE,
} from '../../core/index.js';
import { BrowserError, asBrowserError, redactUrl } from '../../browser-safety.js';
import { TAB_ACQUIRE_TIMEOUT_DEFAULT_MS, dynamicActionTarget, dynamicMonoNow } from './host.js';

/** Human-readable activity labels for the page owner's projection. */
const PAGE_ACTION_LABELS = Object.freeze({
  browser_eval: '执行脚本', browser_input: '派发输入事件', browser_network: '读取网络记录',
  browser_viewport: '调整共享视口',
  browser_screenshot: '截图', browser_computed_style: '读取计算样式',
  browser_snapshot: '读取结构快照', browser_click: '点击元素', browser_type: '输入文本',
  browser_scroll: '滚动页面', browser_fill_form: '填写表单', browser_node_state: '读取节点状态',
  browser_wait_for: '等待节点条件',
  browser_vision_image: '视觉分析', browser_vision_find: '视觉识别定位',
  browser_vision_compare: '视觉差异比较', browser_vision_act: '按截图坐标输入',
  browser_vision_baseline: '管理视觉基线', browser_vision_check: '视觉回归检查',
});

/**
 * @param {object} options
 * @param {object} options.registry       page runtime registry (Web)
 * @param {object} options.httpClient     independent HTTP client (Web)
 * @param {object} [options.tabLimits]    P0-E acquire limit
 */
export function createWebInvoker({
  log = () => {},
  registry,
  httpClient = null,
  tabLimits = {},
} = {}) {
  /**
   * Execute one admitted tool call against the Web target.
   *
   * `call.definition` is the Web tool definition (name + handler + readOnly/hostOnly/networkRead
   * flags). `call.hooks` carries the three Host seams described in the module header.
   */
  async function invoke(call) {
    const {
      definition, args = {}, exec = {}, meta = {}, sessionId = 'anonymous',
      principal = null, callEffects = [], observeOnlyCall = false, hooks = {},
    } = call;
    // `handler` is the tool's own implementation. It is passed explicitly because the Host wraps
    // `definition.execute` with this very dispatch: calling the property here would recurse.
    const handlerFn = call.handler ?? definition?.execute;
    if (!definition || typeof handlerFn !== 'function') {
      throw new BrowserError('INTERNAL', 'Web dispatch requires a tool definition with execute()');
    }
    const environment = call.environment;
    const isTabsTool = definition.name === 'browser_tabs';
    const diagnostic = ['browser_state', 'browser_capabilities'].includes(definition.name);
    // Per-action read-only branch (docs/viewport-control.md): `browser_viewport get` is a cache
    // diagnostic — no ensure, no CDP, no queue, no lease, no recent/error bookkeeping. It may still
    // read another owner's cached view.
    const readOnly = typeof definition.readOnly === 'function' && definition.readOnly(args) === true;
    const isHttpRequest = definition.name === 'browser_http_request';
    // Test-only fake environment tool: no Web runtime/page is created or touched.
    const isFakeTool = definition.name === 'browser_fake_probe';
    // Environment-neutral diagnostics answer "what is here / why is it refused". Outside the Web
    // environment there is no page to report, and creating one would start a target the user did
    // not enable.
    const neutralWithoutWeb = definition.name === 'browser_state' && environment !== 'web';
    // Web P0 network read-only tools are scope-local reads: they resolve the workspace runtime but
    // never take the page queue, the lease, or lazily start Chromium (docs/network-p0.md, R1-5).
    const isNetworkRead = definition.networkRead === true;

    let entry;
    let primaryEntry;
    let selection;
    let runtime;
    let resolvedScope = null;
    try {
      // Diagnostic dispatcher (integration/diagnose.js): the caller already froze the scope and the
      // runtime it is looking at, and re-resolving here would manufacture a second runtime for the
      // same workspace. The call still goes through authorization, the adapter and run() below.
      const frozen = exec.diagnosticScope;
      if (frozen && frozen.entry && frozen.resolved) {
        resolvedScope = frozen.resolved;
        meta.scope = resolvedScope.scope;
        if (!isHttpRequest && !isFakeTool && !neutralWithoutWeb) {
          entry = frozen.entry;
          primaryEntry = entry;
          runtime = entry.runtime;
          selection = null;
        }
        throw { __diagnosticScope: true };
      }
      const resolved = await hooks.resolveScope(exec, principal);
      resolvedScope = resolved;
      meta.scope = resolved.scope;
      // The independent HTTP tool is evidence-only: resolve identity, but never create/touch a page
      // entry. FR-01/INF-08: if this workspace already has a runtime with an active scope session,
      // the independent client obeys the same boundary — `peek` never creates a runtime.
      if (isHttpRequest) {
        const existing = registry.peek(resolved);
        if (existing?.runtime) {
          runtime = existing.runtime;
          try {
            const selected = registry.resolveSessionTab(existing, sessionId, { mode: 'work' });
            if (selected?.entry?.runtime) runtime = selected.entry.runtime;
          } catch { /* no work page yet: keep the primary runtime (or none) */ }
        }
      }
      if (!isHttpRequest && !isFakeTool && !neutralWithoutWeb) {
        entry = registry.getOrCreate(resolved);
        primaryEntry = entry;
        if (isTabsTool) {
          runtime = entry.runtime;
        } else {
          const selected = registry.resolveSessionTab(entry, sessionId, {
            mode: observeOnlyCall ? 'read' : 'work',
          });
          entry = selected.entry;
          selection = selected.selection;
          runtime = entry.runtime;
        }
      }
    } catch (error) {
      if (error && error.__diagnosticScope) {
        // Scope already frozen by the diagnostic dispatcher: nothing left to resolve.
      } else if (!isHttpRequest && !isFakeTool && !neutralWithoutWeb) {
        // The Host classifies and enriches this error with the call identity.
        throw error;
      } else {
        meta.scope = { id: null, kind: 'unknown', workspaceId: null, degraded: true };
      }
    }

    // Host-memory-only dynamic actions (status/reset, pure-network session start/stop) must not
    // take the page queue, the lease or ensure a page (docs/t4-dynamic-behavior.md).
    const hostOnly = typeof definition.hostOnly === 'function' && definition.hostOnly(args, runtime) === true;
    const pageOperation = !readOnly && !hostOnly && !diagnostic && !isHttpRequest && !isNetworkRead && !isFakeTool;
    const currentUrl = (value) => (value && value.url ? redactUrl(value.url) : null);
    const actionTarget = definition.name === 'browser_navigate'
      ? redactUrl(String((args && args.url) || ''))
      : currentUrl(runtime);

    // The page part of this call is authorised before it can touch a target: after the target has
    // been resolved (so the verdict is about the page this call will really drive) and before
    // `run()` — i.e. before ensure, bringToFront, the queue and any CDP command.
    let pageEffects = null;
    let pageControlRevision = null;
    let autoAcquired = false;
    if (pageOperation && entry && !isTabsTool) {
      const effects = callEffects.filter((row) => row.resource === RESOURCE.PAGE);
      if (effects.length > 0) {
        pageEffects = effects;
        const verdict = hooks.authorize({ entry, effects, operation: definition.name });
        if (!verdict.allowed) throw verdict.error;
        if (verdict.verdict && verdict.verdict.autoAcquire === true) {
          // Atomic "take over, then dispatch" (plan §5.1): a Lead writing an idle member page
          // acquires control *inside this call* and keeps it until an explicit release.
          const acquired = await registry.acquireControl(entry, principal, {
            expectedControlRevision: registry.accessOf(entry).control.controlRevision,
            timeoutMs: tabLimits.acquireTimeoutMs ?? TAB_ACQUIRE_TIMEOUT_DEFAULT_MS,
            signal: exec.signal,
          });
          autoAcquired = acquired.changed === true;
        }
        pageControlRevision = registry.accessOf(entry).control?.controlRevision ?? null;
      }
    }

    const tabFact = selection
      ? { id: selection.tabId, runtimeId: runtime ? runtime.runtimeId : null, selectionRevision: selection.revision }
      : (runtime ? { id: 'primary', runtimeId: runtime.runtimeId, selectionRevision: 0 } : null);
    const controlFact = autoAcquired
      ? { autoAcquired: true, projection: registry.controlProjection(entry) }
      : null;
    const facts = (value, target) => ({ value, target, tab: tabFact, control: controlFact });
    const targetInfo = () => ({ resolvedScope, runtime, entry, selection });
    const handler = { ...exec, meta, sessionId, principal, runtime, httpClient };

    // 1. Target lifecycle (P0-E): adapters own discovery/select/close; the projection is public.
    if (isTabsTool) {
      const value = await hooks.dispatch(
        () => handlerFn(args, { ...handler, primaryEntry, registry }),
        'tabs', targetInfo(),
      );
      return facts(value, currentUrl(runtime) || '');
    }
    // 2. Independent dispatch branch: no ensure/run/claim/activate, no page queue, no page
    //    `lastError`. The implementation does its own argument validation.
    if (isHttpRequest || isNetworkRead || isFakeTool) {
      const value = await hooks.dispatch(
        () => handlerFn(args, handler),
        isFakeTool ? 'page' : (isHttpRequest ? 'independentHttp' : 'networkRead'),
        targetInfo(),
      );
      return facts(value, meta.target || '');
    }
    // 3. Pure pre-flight, outside the queue: an invalid argument must cost zero CDP (not even the
    //    queue's Page.bringToFront) and must not touch owner/error state.
    if (typeof definition.preflight === 'function') definition.preflight(args);
    // 4. Cache-only diagnostic / host-memory-only action: deliberately outside run() so it cannot
    //    activate the page, wait behind the queue, claim the lease or mark the entry recent.
    if (readOnly || hostOnly) {
      meta.target = currentUrl(runtime) || '';
      const value = await hooks.dispatch(
        () => handlerFn(args, handler),
        hostOnly ? 'hostOnly' : 'readOnly', targetInfo(),
      );
      return facts(value, meta.target);
    }
    // 4b. Environment-neutral diagnostics may legitimately have no page (a non-Web environment, or
    //     a Web environment the user disabled): the handler reports that truth itself, and there is
    //     no queue, no lease and no target to take. Dispatching directly is what keeps the answer
    //     available instead of failing on a missing runtime.
    if (!runtime) {
      meta.target = '';
      const value = await hooks.dispatch(
        () => handlerFn(args, handler),
        readOnly || hostOnly ? (hostOnly ? 'hostOnly' : 'readOnly') : 'diagnostic',
        targetInfo(),
      );
      return facts(value, meta.target);
    }
    // 5. The page queue: one serial queue per page plus the single-owner write lease.
    const value = await runtime.run(async () => {
      // Dispatch-time re-check (plan §5.3): between admission and this point another actor may
      // have drained the page; the answer is TAB_CONTROL_CHANGED with ZERO dispatch.
      if (pageEffects) {
        const recheck = hooks.authorize({
          entry, effects: pageEffects, operation: definition.name, expectedControlRevision: pageControlRevision,
        });
        if (!recheck.allowed) throw recheck.error;
      }
      meta.target = currentUrl(runtime) || '';
      if (pageOperation) {
        runtime.touchAgent(definition.name === 'browser_navigate'
          ? '正在打开 ' + redactUrl(String(args?.url || ''))
          : PAGE_ACTION_LABELS[definition.name]);
        // GUI↔network correlation (docs/network-p0.md / G2.5): a temporal mark before and after
        // every page tool, so event queries can associate traffic with an actionId without ever
        // claiming causality.
        runtime.netMark({ tool: definition.name, actionId: meta.actionId, kind: 'tool', text: 'begin' });
        try {
          return await hooks.dispatch(
            () => handlerFn(args, handler),
            diagnostic ? 'diagnostic' : 'page', targetInfo(),
          );
        } finally {
          runtime.netMark({ tool: definition.name, actionId: meta.actionId, kind: 'tool', text: 'end' });
        }
      }
      return hooks.dispatch(
        () => handlerFn(args, handler),
        diagnostic ? 'diagnostic' : 'page', targetInfo(),
      );
    }, {
      signal: exec.signal,
      sessionId,
      // A read-only page operation must not take the single-owner write lease: claiming it made
      // "look at a teammate's page" block that teammate's next write for 15s.
      agent: pageOperation && !observeOnlyCall,
      // An all-observe call must not bring the page to the front.
      activate: !observeOnlyCall,
      action: pageOperation ? { actionId: meta.actionId, target: actionTarget } : undefined,
    });
    if (pageOperation) {
      registry.touch(entry);
      registry.markRecent(entry);
      // T4 page-action bridge (Lead-authorized): identity and a bounded timestamp only.
      try {
        runtime.noteDynamicAction({
          actionId: meta.actionId, tool: definition.name, target: dynamicActionTarget(args, actionTarget),
          atWallMs: Date.now(), atMonoMs: dynamicMonoNow(),
        });
      } catch { /* evidence only */ }
      // Any successful page operation may have moved the page: refresh the view cache once,
      // coalesced/throttled. `browser_viewport set` already did its own bounded readback.
      if (definition.name !== 'browser_viewport') runtime.refreshViewObservationSoon();
    }
    // An operation-level failure (eval/style return {ok:false,error}) is a real failure, not a
    // success that clears the projection.
    if (pageOperation && value && value.ok === false && value.error) {
      runtime.setError(value.error.message || '操作失败', { actionId: meta.actionId, target: actionTarget });
    }
    return facts(value, currentUrl(runtime) || '');
  }

  return { invoke, PAGE_ACTION_LABELS };
}
