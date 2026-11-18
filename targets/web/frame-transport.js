/**
 * Web frame-push transport: the same-origin WebSocket upgrade that streams page frames to the
 * panel.
 *
 * The transport itself (`frame-push.js`) is a neutral socket utility; *this* module is the Web
 * environment's wiring — which runtime a scope upgrade resolves to, which page entry gets touched
 * and how a retired runtime is released. It is mounted through the Host's `webServer` and never
 * reads a Cordis context.
 *
 * Dependency direction: `frame-push.js`, the Web runtime module and `core/` only.
 */
import { attachFramePush } from '../../frame-push.js';
import { SCOPE_TAB_PRIMARY_DEFAULT, resolveScopedEntry } from './scope-target.js';

/**
 * @param {object} options
 * @param {object} options.registry   page runtime registry (Web)
 * @param {Function} options.resolveScopeRequest  Host scope resolution (Cordis services)
 * @param {Function} options.authenticate         Host owner-only admission for scoped upgrades
 * @param {Function} options.parseScope           Host scope-query parser
 * @param {Function} options.statusFor            Host error→status mapping
 */
export function createWebFramePush({
  log = () => {},
  registry,
  BrowserError,
  resolveScopeRequest,
  authenticate,
  parseScope,
  statusFor,
  scopeTabPrimary = SCOPE_TAB_PRIMARY_DEFAULT,
} = {}) {
  let hub = null;
  let disposed = false;

  /**
   * Mount the upgrade handler for one plugin lifetime.
   *
   * A failure to mount (an exotic HTTP setup) must leave the `/frame` polling transport working,
   * so this never throws: it logs and returns a no-op disposer.
   */
  function mount(ctx) {
    try {
      hub = attachFramePush(ctx, {
        log,
        parseScope,
        statusFor,
        // Only scoped upgrades need the strict owner-only admission; the hub keeps the legacy
        // requestRejection/loopback gate for unscoped old clients.
        authenticate,
        resolve: async (scopeRequest) => {
          const resolved = await resolveScopeRequest(scopeRequest);
          let entry = resolveScopedEntry(registry, resolved, scopeRequest, { scopeTabPrimary });
          if (!entry) {
            throw new BrowserError('SCOPE_NOT_FOUND', 'scope binding 指向的运行时不存在', { scope: 'binding' });
          }
          return { runtime: entry.runtime, scope: resolved.scope, entry };
        },
        onConnect: (runtime, entry) => {
          runtime.touchViewer();
          registry.touch(entry);
          registry.markRecent(entry);
        },
      });
    } catch (error) {
      log('ui-testing frame push unavailable: ' + String((error && error.message) || error));
      hub = null;
      return () => {};
    }
    // A retired runtime must drop its subscribers immediately.
    registry.onRetire = (runtime) => hub.release(runtime);
    return () => dispose();
  }

  function dispose() {
    if (disposed) return;
    disposed = true;
    registry.onRetire = undefined;
    try { hub?.dispose(); } catch { /* best effort */ }
    hub = null;
  }

  return { mount, dispose, get mounted() { return hub !== null; } };
}
