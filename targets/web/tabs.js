/**
 * Web TargetTabs implementation. RuntimeRegistry remains the sole owner of page lifecycle,
 * popup adoption, selections, access control, queues and leases. The Host injects its error
 * class, existing budgets and P0-E list callback; no Host entry or browser-safety import.
 */
import { AdapterError, TARGET_TABS_ACTIONS, createTargetTabs } from '../../core/index.js';

export function createWebTargetTabs({
  registry: runtimeRegistry,
  BrowserError = AdapterError,
  listTargets = async () => {
    throw new BrowserError('CAPABILITY_UNSUPPORTED', 'Web tabs requires a P0-E list callback');
  },
  limits = {},
} = {}) {
  const {
    TAB_WAIT_TIMEOUT_DEFAULT_MS = 5000,
    TAB_WAIT_TIMEOUT_MAX_MS = 30000,
    TAB_WAIT_POLL_DEFAULT_MS = 100,
    TAB_WAIT_POLL_MIN_MS = 50,
    TAB_WAIT_POLL_MAX_MS = 1000,
    TAB_ACQUIRE_TIMEOUT_DEFAULT_MS = 5000,
    TAB_ACQUIRE_TIMEOUT_MAX_MS = 30000,
  } = limits;

  async function execute(args, exec = {}) {
    const action = String(args && args.action || '');
    const primary = exec.primaryEntry;
    const registry = runtimeRegistry;
    const sessionId = exec.sessionId;
    if (!primary || !registry) throw new BrowserError('UNSUPPORTED', 'browser_tabs 需要 workspace 页面组');
    const allowed = TARGET_TABS_ACTIONS;
    const principal = exec.principal || null;
    if (action === 'list') {
      // A01: the target list is a P0-E read; it goes through the provider so the projection and
      // its evidence come from one place (the provider binds the calling target internally).
      const listed = await listTargets(exec, primary);
      const providerRows = Array.isArray(listed) ? listed : (Array.isArray(listed?.tabs) ? listed.tabs : []);
      // The provider projection answers "what target is this", not "may this caller act on it".
      // The long-lived ownership/control/permission fields are added here, from the registry this
      // call is authorised against, so the tool result carries one consistent ACL story (ruling
      // §5 "每页返回") without teaching the P0 adapter about principals (that is M3's wiring).
      const ownRows = new Map(registry.listTabs(primary, sessionId, principal)
        .map((row) => [String(row.tabId), row]));
      const tabs = providerRows.map((row) => {
        const own = ownRows.get(String(row.tabId));
        if (!own) return row;
        return {
          ...row,
          accessVersion: own.accessVersion,
          rootSessionId: own.rootSessionId,
          creatorSessionId: own.creatorSessionId,
          ownerSessionId: own.ownerSessionId,
          controllerSessionId: own.controllerSessionId,
          ownershipRevision: own.ownershipRevision,
          controlRevision: own.controlRevision,
          accessState: own.accessState,
          permissions: own.permissions,
        };
      });
      const selection = registry.selectionFor(primary, sessionId);
      return {
        ok: true, action, tabs,
        notices: registry.noticesView(primary), recentClosed: registry.recentClosedView(primary),
        accessVersion: 1,
        // `selection` stays the workSelection compatibility projection (ruling §5).
        selection,
        workSelection: selection,
        observationSelection: selection.observationTabId
          ? { ...selection, tabId: selection.observationTabId }
          : null,
      };
    }
    if (action === 'current') {
      // current never claims: it only confirms the caller's own (possibly retired) selection.
      const selection = registry.confirmSelection(primary, sessionId);
      return {
        ok: true, action, tabId: selection.tabId, selection, workSelection: selection,
        observationSelection: selection.observationTabId ? { ...selection, tabId: selection.observationTabId } : null,
        confirmedResetReason: selection.confirmedResetReason || null,
      };
    }
    if (action === 'select') {
      if (typeof args.tabId !== 'string' || !args.tabId.trim()) throw new BrowserError('INVALID_ARGUMENT', 'select 需要 tabId', { field: 'tabId' });
      if (args.tabId.trim().length > 128) throw new BrowserError('INVALID_ARGUMENT', 'select.tabId 必须是 1–128 字符', { field: 'tabId' });
      const mode = args.mode === undefined ? 'work' : String(args.mode);
      if (!['work', 'observe'].includes(mode)) {
        throw new BrowserError('INVALID_ARGUMENT', 'select.mode 只接受 work/observe', { field: 'mode', allowed: ['work', 'observe'] });
      }
      // A refusal throws before anything is written, so a denied select leaves the caller's
      // existing work/observation selection exactly as it was (plan §5).
      const selected = registry.selectTab(primary, sessionId, args.tabId.trim(), { mode, principal });
      return {
        ok: true, action, mode,
        tabId: selected.entry.tabId || selected.entry.viewId || 'primary',
        selection: selected.selection,
        workSelection: selected.selection.tabId ? selected.selection : null,
        observationSelection: selected.selection.observationTabId
          ? { ...selected.selection, tabId: selected.selection.observationTabId } : null,
        // select never claims a lease any more: say so instead of leaving callers to infer it.
        claimed: false,
      };
    }
    if (action === 'open') {
      const opened = await registry.openTab(primary, sessionId, 'agent', { principal });
      return { ok: true, action, tabId: opened.entry.tabId || opened.entry.viewId, selection: opened.selection };
    }
    if (action === 'close') {
      const tabId = typeof args.tabId === 'string' && args.tabId.trim() ? args.tabId.trim() : registry.selectionFor(primary, sessionId).tabId;
      const closed = await registry.closeTab(primary, sessionId, tabId, { principal });
      const closedEntry = registry.tabEntry(primary, tabId) || registry.primaryEntry(primary);
      return { ok: true, action, tabId: closed.closed, changed: true, control: registry.controlProjection(closedEntry) };
    }
    if (action === 'acquire' || action === 'release' || action === 'transfer') {
      // Management path. Order is the contract (plan §5.2): principal → same root → Lead role →
      // target → expected version. `authorizePage` inside the registry enforces the first four,
      // the transition enforces the versions, and the drain wait is the only thing that runs
      // before the commit — never an abort of somebody's in-flight page operation.
      if (typeof args.tabId !== 'string' || !args.tabId.trim()) {
        throw new BrowserError('INVALID_ARGUMENT', `${action} 需要 tabId`, { field: 'tabId' });
      }
      const target = registry.tabEntry(primary, args.tabId.trim());
      if (!target) throw new BrowserError('TAB_NOT_FOUND', '标签不存在或不属于当前 workspace', { tabId: args.tabId, fallbackTabId: 'primary' });
      const revisionOf = (value, field) => {
        if (value === undefined || value === null) {
          throw new BrowserError('INVALID_ARGUMENT', `${action} 需要 ${field}`, { field });
        }
        if (!Number.isInteger(value) || value < 1 || value > Number.MAX_SAFE_INTEGER) {
          throw new BrowserError('INVALID_ARGUMENT', `${field} 必须是 1–9007199254740991 的整数`, { field });
        }
        return value;
      };
      const expectedControlRevision = revisionOf(args.expectedControlRevision, 'expectedControlRevision');
      if (action === 'acquire') {
        const timeoutMs = args.timeoutMs === undefined ? TAB_ACQUIRE_TIMEOUT_DEFAULT_MS : args.timeoutMs;
        if (!Number.isInteger(timeoutMs) || timeoutMs < 0 || timeoutMs > TAB_ACQUIRE_TIMEOUT_MAX_MS) {
          throw new BrowserError('INVALID_ARGUMENT', `acquire.timeoutMs 必须是 0–${TAB_ACQUIRE_TIMEOUT_MAX_MS} 的整数`, {
            field: 'timeoutMs', min: 0, max: TAB_ACQUIRE_TIMEOUT_MAX_MS,
          });
        }
        const result = await registry.acquireControl(target, principal, {
          expectedControlRevision, timeoutMs, signal: exec.signal,
        });
        return {
          ok: true, action, changed: result.changed, waitedMs: result.waitedMs,
          control: registry.controlProjection(target),
        };
      }
      if (action === 'release') {
        const result = registry.releaseControl(target, principal, { expectedControlRevision });
        return { ok: true, action, changed: result.changed, control: registry.controlProjection(target) };
      }
      const expectedOwnershipRevision = revisionOf(args.expectedOwnershipRevision, 'expectedOwnershipRevision');
      const result = registry.transferControl(target, principal, {
        toSessionId: args.toSessionId, expectedControlRevision, expectedOwnershipRevision,
      });
      return {
        ok: true, action, changed: result.changed, to: result.to,
        control: registry.controlProjection(target),
      };
    }
    if (action === 'wait') {
      const timeoutMs = args.timeoutMs === undefined ? TAB_WAIT_TIMEOUT_DEFAULT_MS : args.timeoutMs;
      if (!Number.isInteger(timeoutMs) || timeoutMs < 0 || timeoutMs > TAB_WAIT_TIMEOUT_MAX_MS) {
        throw new BrowserError('INVALID_ARGUMENT', `wait.timeoutMs 必须是 0–${TAB_WAIT_TIMEOUT_MAX_MS} 的整数`, {
          field: 'timeoutMs', min: 0, max: TAB_WAIT_TIMEOUT_MAX_MS,
        });
      }
      const pollMs = args.pollMs === undefined ? TAB_WAIT_POLL_DEFAULT_MS : args.pollMs;
      if (!Number.isInteger(pollMs) || pollMs < TAB_WAIT_POLL_MIN_MS || pollMs > TAB_WAIT_POLL_MAX_MS) {
        throw new BrowserError('INVALID_ARGUMENT', `wait.pollMs 必须是 ${TAB_WAIT_POLL_MIN_MS}–${TAB_WAIT_POLL_MAX_MS} 的整数`, {
          field: 'pollMs', min: TAB_WAIT_POLL_MIN_MS, max: TAB_WAIT_POLL_MAX_MS,
        });
      }
      const tabId = args.tabId === undefined || args.tabId === null ? null : args.tabId;
      if (tabId !== null && (typeof tabId !== 'string' || !tabId.trim() || tabId.trim().length > 128)) {
        throw new BrowserError('INVALID_ARGUMENT', 'wait.tabId 必须是 1–128 字符', { field: 'tabId' });
      }
      const kind = args.kind === undefined ? null : String(args.kind);
      if (kind !== null && !['primary', 'tab'].includes(kind)) {
        throw new BrowserError('INVALID_ARGUMENT', 'wait.kind 只接受 primary/tab', { field: 'kind', allowed: ['primary', 'tab'] });
      }
      const source = args.source === undefined ? null : String(args.source);
      if (source !== null && !['primary', 'gui-popup', 'agent-open'].includes(source)) {
        throw new BrowserError('INVALID_ARGUMENT', 'wait.source 只接受 primary/gui-popup/agent-open', {
          field: 'source', allowed: ['primary', 'gui-popup', 'agent-open'],
        });
      }
      const waited = await registry.waitForTab(primary, sessionId, {
        tabId: tabId === null ? null : tabId.trim(), kind, source, timeoutMs, pollMs,
      }, exec.signal);
      return { ok: true, action, ...waited };
    }
    throw new BrowserError('INVALID_ARGUMENT', 'browser_tabs.action 不合法', { field: 'action', allowed });
  }

  return createTargetTabs({
    environment: 'web',
    handlers: Object.fromEntries(TARGET_TABS_ACTIONS.map((action) => [action, execute])),
  });
}
