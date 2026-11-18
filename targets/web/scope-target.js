/**
 * Scope → page entry resolution for the Web environment.
 *
 * One rule, used by both the panel routes and the frame-push upgrade: a scope resolves to the
 * primary entry of its workspace runtime, a `binding` never creates a new runtime, and a
 * session-scoped request follows that Agent session's selected tab unless the caller explicitly
 * asks for `scope-tab: primary` (a GUI panel renders its own selected tab, so the Agent's
 * selection must never redirect it — docs/multi-tab.md).
 */

export const SCOPE_TAB_PRIMARY_DEFAULT = 'primary';

/**
 * @param {object} registry        page runtime registry
 * @param {object} resolved        resolved scope (`{ scope, ... }`)
 * @param {object} scopeRequest    parsed scope request (`{ mode, sessionId, tab }`)
 * @returns {object|null} the entry, or null when `create:false` and nothing is live
 */
export function resolveScopedEntry(registry, resolved, scopeRequest, {
  create = true,
  scopeTabPrimary = SCOPE_TAB_PRIMARY_DEFAULT,
} = {}) {
  if (!registry || !resolved) return null;
  // A binding already names an existing primary/child; never create a new runtime for it.
  let entry = create && scopeRequest?.mode !== 'binding'
    ? registry.getOrCreate(resolved)
    : registry.peek(resolved);
  if (!entry) return null;
  if (scopeRequest?.mode === 'session' && scopeRequest.tab !== scopeTabPrimary) {
    entry = registry.resolveSessionTab(entry, scopeRequest.sessionId).entry;
  }
  return entry ?? null;
}
