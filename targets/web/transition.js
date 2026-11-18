/**
 * Environment-transition cleanup for the Web runtime (A12).
 *
 * Re-admitting the tool surface is not enough: a scope whose selection no longer resolves to Web
 * must also cancel queued/running work, release its page and rotate its tab selection — otherwise
 * an old reference keeps operating a page its environment no longer owns, and a stale tabId/ref
 * would resolve through the new environment's page.
 *
 * The Host decides *when* (it owns the authoritative config notifications); this module decides
 * *what* to release, because that is page-runtime knowledge.
 *
 * Dependency direction: the Web runtime module and `core/` only.
 */
import { ENVIRONMENTS } from '../../core/index.js';

/**
 * @param {object} options
 * @param {object} options.registry          page runtime registry
 * @param {Function} options.snapshotForScope Host config snapshot lookup for a scope
 */
export function createWebTransition({ log = () => {}, registry, snapshotForScope } = {}) {
  /**
   * Release every page whose scope no longer selects the Web environment.
   *
   * @returns {Promise<{transitioned: Array<{scope:string, environment:string, reason:string, cancelled:boolean}>}>}
   */
  async function apply(notification = {}) {
    const transitioned = [];
    for (const entry of [...registry.entries.values()]) {
      const scope = entry.scope || {};
      let snapshot;
      try {
        snapshot = snapshotForScope({ id: scope.id, workspaceId: scope.workspaceId, cwd: scope.cwd });
      } catch {
        continue;
      }
      const webSelected = snapshot.environment === ENVIRONMENTS.WEB
        && Array.isArray(snapshot.enabledEnvironments)
        && snapshot.enabledEnvironments.includes(ENVIRONMENTS.WEB);
      // Only pages whose scope lost Web are touched, so an unrelated write (e.g. enabling the
      // fixture) never tears down a live Web page.
      if (webSelected) continue;
      const runtime = entry.runtime;
      const reason = snapshot.enabledEnvironments.includes(snapshot.environment)
        ? 'environment-switched'
        : 'environment-disabled';
      const cancelled = typeof runtime?.abortForEnvironmentChange === 'function'
        ? runtime.abortForEnvironmentChange(reason)
        : { aborted: false, reason };
      // Rotate the per-session tab selection: an old tabId/ref must not resolve through the new
      // environment's page (identity rotation, not just cancellation). Match the complete
      // dimensions this entry owns — its page-group key, or the group key a child belongs to.
      for (const [key, value] of [...registry.selectedBySession.entries()]) {
        if (!value) continue;
        const groupKey = entry.primaryKey || entry.key;
        if (value.groupKey === groupKey || value.groupKey === entry.key) {
          registry.selectedBySession.delete(key);
        }
      }
      registry.bumpViews(entry.key);
      if (typeof registry.touch === 'function') registry.touch(entry);
      try { await runtime?.close?.(); } catch { /* teardown is best effort */ }
      transitioned.push({ scope: entry.key, environment: snapshot.environment, reason, cancelled: cancelled.aborted });
    }
    if (transitioned.length > 0) {
      log('ui-testing: config transition released ' + transitioned.length + ' web scope(s): '
        + transitioned.map((item) => `${item.scope}:${item.reason}`).join(', '));
    }
    return { transitioned, revision: notification.revision ?? null };
  }

  return { apply };
}
