/**
 * Web environment registration (`web`): the platform implementation behind the public Host.
 *
 * Everything Web-specific that the composition root used to hardwire lives here — the capability
 * probe, the P0 data-plane dispatch for families A-E, the page-lease family, the three adapters
 * (TargetAdapter / CapabilityAdapter / P0Provider), the TargetTabs service, per-provider readiness
 * cards and the operation table used for admission and execution class.
 *
 * Dependency direction: this module imports `core/` and its own `./adapter.js` / `./provider.js` /
 * `./tabs.js` only. It never imports `index.js` and never imports `integration/`; the Host injects
 * the page runtime registry and the P0 dispatch entry through the `create(api)` bag.
 */
import {
  AVAILABILITY,
  DEFAULT_WEB_PROVIDER,
  ENVIRONMENTS,
  ERROR_CODES,
  IMPLEMENTED_WEB_PROVIDERS,
  READINESS_STATUS,
  SUPPORT,
  WEB_PROVIDER_IDS,
  AdapterError,
  axis,
  defineEnvironmentEntry,
  isImplementedWebProvider,
  webProviderSupport,
} from '../../core/index.js';
import {
  WEB_TOOL_OPERATIONS,
  createWebCapabilityAdapter,
  createWebTargetAdapter,
  resolveExecutionClass,
  resolveProviderExecutable,
  resolveWebDriver,
} from './adapter.js';
import { createWebP0Provider } from './provider.js';
import { createWebTargetTabs } from './tabs.js';

const ENVIRONMENT_ID = ENVIRONMENTS.WEB;

function isPlainObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Providers enabled by any selectable scope (global + workspace switches), from a config tree. */
function enabledProviderUnion(config) {
  const union = new Set();
  const consider = (entry) => {
    const web = isPlainObject(entry) ? entry.environments?.[ENVIRONMENT_ID] : null;
    if (!isPlainObject(web) || !isPlainObject(web.providers)) return;
    for (const id of WEB_PROVIDER_IDS) {
      if (web.providers[id]?.enabled === true) union.add(id);
    }
  };
  consider(config?.global);
  for (const entry of Object.values(config?.workspaces || {})) consider(entry);
  return union;
}

/**
 * Declare the `web` registration entry.
 *
 * @param {object} options
 * @param {Function} options.log
 * @param {Function} options.BrowserError  the Host error class (page operations)
 * @param {object} [options.registry]      page runtime registry, injected by the Host
 * @param {object} [options.webTabsLimits] P0-E tab wait/acquire limits
 */
export function createWebEnvironmentEntry({
  log = () => {},
  BrowserError,
  registry = null,
  webTabsLimits = {},
} = {}) {
/**
 * Locate the page entry a readiness snapshot refers to (Web-runtime lookup, so it lives here).
 */
function findEntryForSnapshot(snapshot, pageRegistry) {
  const targetId = snapshot?.targetId;
  const entries = () => pageRegistry?.entries?.values?.() ?? [];
  if (typeof targetId === 'string' && targetId) {
    for (const entry of entries()) {
      if (entry?.tabId === targetId || entry?.runtimeId === targetId) return entry;
    }
  }
  for (const entry of entries()) {
    if (entry?.runtime?.url) return entry;
  }
  return null;
}

/**
 * Per-capability readiness probe (A13).
 *
 * The old probe answered "there is a bound target, so capabilities are fine". That is not a
 * measurement: structure reading, input dispatch, the network collector and the frame source are
 * independent, and a page can have some of them and lack the others. Each check below reads a
 * real signal off the live runtime, records `checkedAt`, and the union decides the status:
 * every check ok -> `available`, some ok -> `partial`, none -> `unavailable`, no target ->
 * `not-probed`. Nothing is inferred from a target merely existing.
 */
function probeWebCapabilities({ entry, checkedAt }) {
  const runtime = entry?.runtime ?? null;
  if (!runtime) {
    return {
      status: READINESS_STATUS.NOT_PROBED,
      reason: 'no-runtime',
      checkedAt,
      evidence: { kind: 'capability-matrix', checks: {}, checkedAt },
    };
  }
  const cdpAttached = Boolean(runtime.cdp && runtime.cdp.closed !== true);
  const checks = {
    // Structure (T2 snapshot / DOM reads) needs an attached page session.
    structure: cdpAttached
      ? { status: READINESS_STATUS.OK }
      : { status: READINESS_STATUS.FAILED, reason: 'cdp-not-attached' },
    // Input is dispatched through the same session; it is a separate entry because a read-only
    // transport (or a closed Input domain) must be able to report structure without input.
    input: cdpAttached && typeof runtime.input === 'function'
      ? { status: READINESS_STATUS.OK }
      : { status: READINESS_STATUS.FAILED, reason: cdpAttached ? 'input-unsupported' : 'cdp-not-attached' },
    // Network collection is an independent object; its absence is a real capability gap.
    network: runtime.net
      ? { status: READINESS_STATUS.OK }
      : { status: READINESS_STATUS.FAILED, reason: 'collector-missing' },
    // Frame source (screencast / screenshot loop) is what T3/T4 preview depends on.
    frames: runtime.frames
      ? { status: READINESS_STATUS.OK }
      : { status: READINESS_STATUS.FAILED, reason: 'frame-source-missing' },
  };
  const okChecks = Object.values(checks).filter((check) => check.status === READINESS_STATUS.OK).length;
  const total = Object.keys(checks).length;
  const status = okChecks === total
    ? READINESS_STATUS.OK
    : (okChecks === 0 ? AVAILABILITY.UNAVAILABLE : 'partial');
  const failed = Object.entries(checks).filter(([, check]) => check.status !== READINESS_STATUS.OK);
  const busy = runtime.lease && runtime.lease.expiresAt > Date.now() && runtime.active > 0;
  return {
    status: busy && status === READINESS_STATUS.OK ? AVAILABILITY.BUSY : status,
    reason: busy && status === READINESS_STATUS.OK
      ? 'page-busy'
      : (failed.length === 0 ? null : failed.map(([name]) => name).join(',')),
    checkedAt,
    target: {
      targetId: entry?.tabId ?? runtime.runtimeId ?? null,
      generation: Number.isInteger(runtime.generation) ? runtime.generation : null,
    },
    evidence: {
      kind: 'capability-matrix',
      checkedAt,
      okCount: okChecks,
      total,
      checks,
      runtime: { id: runtime.runtimeId ?? null, cdpAttached, url: typeof runtime.url === 'string' ? runtime.url : null },
    },
  };
}

/**
 * Web P0 provider: the single entry to the platform data plane for families A-E.
 *
 * The dispatch receives the invocation `context` (page runtime, exec, action meta) plus the
 * bound `session`, so the provider — not the tool layer — decides which target/generation the
 * data belongs to. Passing `session` is what makes generation/lease answers real instead of a
 * static projection (A01/A05).
 */
function createWebProvider(pageRegistry) {
  return createWebP0Provider({
    log,
    p0Dispatch: async (family, method, { args = {}, session = null, context = null, signal = null } = {}) => {
      const runtime = context?.runtime;
      if (!runtime) {
        throw new AdapterError(ERROR_CODES.PROVIDER_UNAVAILABLE, 'web P0 provider has no runtime context', {
          details: { family, method },
        });
      }
      if (family === 'A' && method === 'screenshot') return runtime.screenshot(args, signal);
      if (family === 'A' && method === 'capture') return runtime.capture(args, signal);
      if (family === 'A' && method === 'product') return runtime.browserProduct(signal);
      if (family === 'B') {
        // `context` is the invocation view (a superset of the tool's `exec`), which is what the
        // network methods expect for owner/session attribution.
        if (method === 'start' || method === 'stop' || method === 'status' || method === 'reset') {
          return runtime.netSession({ ...args, action: method }, context, signal);
        }
        if (method === 'events') return runtime.netEvents(args);
        if (method === 'detail') return runtime.netDetail(args);
        if (method === 'control') return runtime.netControl(args, context, signal);
        if (method === 'trace') return runtime.netTrace(args);
        if (method === 'evidence') return runtime.netEvidence(args, context);
        if (method === 'subscribe') return runtime.netSubscribe(args, context.meta?.sessionId);
      }
      if (family === 'C' && method === 'read') return runtime.viewProjection();
      if (family === 'C' && method === 'set') return runtime.applyView(args.patch ?? args, { signal, source: 'agent' });
      if (family === 'D' && method === 'annotationRead') return runtime.annotationsDocument();
      if (family === 'D' && method === 'annotationWrite') return runtime.acceptAnnotations(args);
      if (family === 'E' && method === 'list') {
        return pageRegistry.listTabs(context.primaryEntry ?? context.entry, context.meta?.sessionId);
      }
      if (family === 'E') {
        return leaseFamily(method, { args, session, runtime, context });
      }
      throw new AdapterError(ERROR_CODES.CAPABILITY_UNSUPPORTED, `web P0 method ${family}.${method} is not wired`, {
        details: { family, method },
      });
    },
  });
}

/**
 * P0-E lease lifecycle against the *real* page lease (A05).
 *
 * The page runtime owns the single-owner lease (`runtime.lease`). `leaseAcquire/Release/Status`
 * used to be wired to one read-only projection, with `generation: null`, so a caller could not
 * tell which target the lease covered. Each method now answers for the bound target and
 * generation the calling session actually holds, and a foreign owner is a BUSY refusal, not a
 * silent sharing of someone else's lease.
 */
function leaseFamily(method, { args = {}, session = null, runtime, context = null }) {
  const targetId = session?.target?.targetId ?? runtime?.runtimeId ?? null;
  const generation = Number.isInteger(session?.generation) ? session.generation : null;
  const sessionId = context?.meta?.sessionId ?? session?.sessionId ?? null;
  const leaseIdOf = (owner) => (targetId && generation !== null ? `web:${targetId}:${generation}:${owner ?? 'none'}` : null);
  if (method === 'leaseAcquire') {
    if (!targetId) {
      throw new AdapterError(ERROR_CODES.TARGET_NOT_BOUND, 'leaseAcquire requires a bound target', {
        details: { operation: 'E.leaseAcquire' },
      });
    }
    if (typeof runtime.claim !== 'function') {
      throw new AdapterError(ERROR_CODES.PROVIDER_UNAVAILABLE, 'leaseAcquire requires a page runtime lease', {
        details: { operation: 'E.leaseAcquire' },
      });
    }
    runtime.claim(sessionId ?? 'anonymous');
    const expiresAt = Number.isFinite(runtime.lease?.expiresAt) ? runtime.lease.expiresAt : null;
    return {
      leaseId: leaseIdOf(sessionId),
      targetId,
      generation,
      owner: { kind: 'session', id: sessionId ?? 'anonymous' },
      expiresAt,
      expired: false,
      remainingMs: expiresAt === null ? null : Math.max(0, expiresAt - Date.now()),
    };
  }
  if (method === 'leaseRelease') {
    if (typeof runtime.release !== 'function') {
      throw new AdapterError(ERROR_CODES.PROVIDER_UNAVAILABLE, 'leaseRelease requires a page runtime lease', {
        details: { operation: 'E.leaseRelease' },
      });
    }
    const owner = runtime.lease?.sessionId ?? null;
    const requested = typeof args.leaseId === 'string' ? args.leaseId : null;
    if (requested !== null && leaseIdOf(owner) !== null && requested !== leaseIdOf(owner)) {
      throw new AdapterError(ERROR_CODES.GENERATION_MISMATCH, 'leaseRelease targets a different lease', {
        details: { operation: 'E.leaseRelease', requested, current: leaseIdOf(owner) },
      });
    }
    runtime.release(owner ?? sessionId ?? 'anonymous');
    return { released: true, leaseId: requested ?? leaseIdOf(owner), targetId, generation };
  }
  // leaseStatus
  const lease = runtime.lease ?? null;
  const owner = lease?.sessionId ?? null;
  const expiresAt = Number.isFinite(lease?.expiresAt) ? lease.expiresAt : null;
  return {
    lease: lease === null ? null : {
      leaseId: leaseIdOf(owner),
      targetId,
      generation,
      owner: { kind: 'session', id: owner },
      expiresAt,
    },
    expired: expiresAt === null ? true : expiresAt <= Date.now(),
    remainingMs: expiresAt === null ? 0 : Math.max(0, expiresAt - Date.now()),
    targetId,
    generation,
  };
}

/**
 * Per-provider readiness for the web environment (§7).
 *
 * Structural rule: a provider that is disabled (or has no driver) is **never probed** and never
 * started — its axes are answered from config facts. An enabled, implemented provider **is** probed
 * for its dependency with *its own* executable candidates, so "not installed" is reported as
 * `failed / executable-missing` instead of an unverified state, and never by borrowing chrome's
 * evidence (§8: code reuse is not verification). Session-level axes (connection/target/capability)
 * belong to the selected provider only; every other provider reports `provider-not-selected`.
 *
 * @param {{snapshot:object, webEntry:object, checkedAt:number, axes:object}} input
 */
function providerReadinessBlock({ snapshot, webEntry, checkedAt, axes }) {
  const switches = isPlainObject(webEntry?.providers) ? webEntry.providers : {};
  const totalEnabled = webEntry?.enabled === true;
  const selectedProvider = typeof snapshot?.provider === 'string' ? snapshot.provider : null;
  const notProbed = (reason) => axis(READINESS_STATUS.NOT_PROBED, { reason, checkedAt });
  const out = {};
  for (const id of WEB_PROVIDER_IDS) {
    const enabled = switches[id]?.enabled === true;
    const support = webProviderSupport(id);
    const implemented = isImplementedWebProvider(id);
    const selected = selectedProvider === id;
    const blockedReason = !totalEnabled
      ? 'environment-disabled'
      : (!enabled
        ? 'provider-disabled'
        : (support === 'pending'
          ? 'provider-driver-pending'
          : (!implemented ? 'provider-not-implemented' : null)));
    if (blockedReason !== null) {
      out[id] = {
        id,
        selected,
        enabled,
        support,
        implemented,
        axes: {
          support: axis(implemented ? SUPPORT.SUPPORTED : SUPPORT.UNSUPPORTED, {
            reason: support === 'pending' ? 'provider-driver-pending' : (implemented ? null : 'provider-not-implemented'),
            checkedAt,
          }),
          enabled: axis('false', { reason: blockedReason, checkedAt }),
          dependency: notProbed(blockedReason),
          connection: notProbed(blockedReason),
          target: axis(READINESS_STATUS.UNBOUND, { reason: blockedReason, checkedAt }),
          capability: notProbed(blockedReason),
        },
      };
      continue;
    }
    // Dependency is a filesystem fact about *this* provider's own executable, so it does not
    // depend on which provider is currently selected: a machine without Edge must show that on
    // the Edge card even while Chrome is the one executing.
    let resolution = null;
    try {
      resolution = resolveProviderExecutable({ provider: id });
    } catch (error) {
      resolution = null;
    }
    const dependencyEvidence = {
      id: id === DEFAULT_WEB_PROVIDER ? 'chromium' : id,
      kind: 'executable',
      provider: id,
      path: resolution ? resolution.path : null,
      // Version is never invented: null means "not observed" (probe must not launch anything).
      version: null,
    };
    const dependencyAxis = resolution === null
      ? notProbed('provider-dependency-not-verified')
      : (resolution.path
        ? axis(READINESS_STATUS.OK, { checkedAt, evidence: dependencyEvidence })
        : axis(READINESS_STATUS.FAILED, {
          reason: resolution.reason || 'executable-missing',
          checkedAt,
          evidence: dependencyEvidence,
        }));
    out[id] = {
      id,
      selected,
      enabled,
      support,
      implemented,
      axes: {
        support: axis(SUPPORT.SUPPORTED, { checkedAt }),
        enabled: axis('true', { reason: null, checkedAt }),
        dependency: dependencyAxis,
        connection: selected && axes?.connection ? axes.connection : notProbed('provider-not-selected'),
        target: selected && axes?.target
          ? axes.target
          : axis(READINESS_STATUS.UNBOUND, { reason: 'provider-not-selected', checkedAt }),
        capability: selected && axes?.capability ? axes.capability : notProbed('provider-not-selected'),
      },
    };
  }
  return out;
}

  /**
   * Build the three adapters plus the P0-E tab service.
   *
   * `api.registry` (page runtime registry) and `api.p0Call` (the Host P0 dispatch entry) are
   * late-bound by the composition root, so this module never needs the Host's internals.
   */
  function createFaces(api) {
    const pageRegistry = api.registry ?? registry;
    const p0 = typeof api.p0Call === 'function' ? api.p0Call : null;
    if (!p0) throw new AdapterError(ERROR_CODES.PROVIDER_UNAVAILABLE, 'web environment requires the host P0 dispatch entry');
    const lookupEntry = typeof api.findEntryForSnapshot === 'function'
      ? api.findEntryForSnapshot
      : (snapshot) => findEntryForSnapshot(snapshot, pageRegistry);
    const targetAdapter = createWebTargetAdapter({
      registry: pageRegistry,
      log: api.log ?? log,
      tabs: createWebTargetTabs({
        registry: pageRegistry,
        BrowserError: api.BrowserError ?? BrowserError,
        limits: api.webTabsLimits ?? webTabsLimits,
        listTargets: async (exec, primaryEntry) => {
          const result = await p0({
            family: 'E', method: 'list', exec,
            runtime: exec.runtime ?? null, entry: primaryEntry, meta: exec.meta ?? null,
          });
          return result.value;
        },
      }),
      capabilityAvailability: ({ entry, snapshot }) => probeWebCapabilities({
        entry: entry ?? lookupEntry?.(snapshot),
        checkedAt: Date.now(),
      }),
    });
    const capabilityAdapter = createWebCapabilityAdapter({
      log: api.log ?? log,
      dispatch: async ({ context }) => {
        if (!context || typeof context.execute !== 'function') {
          throw new AdapterError(ERROR_CODES.PROVIDER_UNAVAILABLE, 'web dispatch requires context.execute');
        }
        // Keep the complete tool result. Some tools (browser_eval) legitimately have a `value`
        // field; the adapter's envelope unwrapping must not change the tool's own result shape.
        const raw = await context.execute();
        context.rawResult = raw;
        return raw;
      },
    });
    const provider = createWebProvider(pageRegistry);
    return { targetAdapter, capabilityAdapter, p0Provider: provider };
  }

  return defineEnvironmentEntry({
    id: ENVIRONMENT_ID,
    label: 'Web / Chromium',
    operations: WEB_TOOL_OPERATIONS,
    // The operation table maps a tool to its capability id (a string), so the declared capability
    // list is derived from it instead of being maintained twice.
    capabilities: Object.freeze([...new Set(Object.values(WEB_TOOL_OPERATIONS)
      .map((op) => (typeof op === 'string' ? op : op?.capability))
      .filter(Boolean))]),
    // Read-only diagnostics this environment offers: the Host's probe dispatcher is generic, the
    // probe list is the platform's own declaration (plan §HTTP、WS 与诊断).
    diagnostics: {
      allowedTools: ['browser_capabilities', 'browser_eval', 'browser_snapshot', 'browser_screenshot',
        'browser_computed_style', 'browser_network'],
      probes: [
        { id: 'snapshot', tool: 'browser_snapshot', args: { maxNodes: 50 } },
        { id: 'screenshot', tool: 'browser_screenshot', args: {} },
        { id: 'computed-style', tool: 'browser_computed_style', args: { selector: 'body', properties: ['display'] } },
        { id: 'network-read', tool: 'browser_network', args: { limit: 5 } },
      ],
    },
    driver: (snapshot) => resolveWebDriver(snapshot),
    executionClassFor: (name, args) => resolveExecutionClass(name, args),
    surfaceAvailable: ({ config } = {}) => {
      const union = enabledProviderUnion(config);
      return IMPLEMENTED_WEB_PROVIDERS.some((id) => union.has(id));
    },
    providerSupport: (id) => webProviderSupport(id),
    resolveExecutable: ({ provider: which } = {}) => resolveProviderExecutable({ provider: which }),
    providerReadiness: ({ snapshot, entryConfig, checkedAt, axes }) => providerReadinessBlock({
      snapshot, webEntry: entryConfig, checkedAt, axes,
    }),
    probeCapabilities: ({ entry, checkedAt, snapshot } = {}) => probeWebCapabilities({
      entry: entry ?? findEntryForSnapshot(snapshot, registry),
      checkedAt: checkedAt ?? Date.now(),
    }),
    admitTool: (name, snapshot) => (Object.hasOwn(WEB_TOOL_OPERATIONS, name)
      ? resolveWebDriver(snapshot).blocked === null
      : undefined),
    findEntryForSnapshot: (snapshot) => findEntryForSnapshot(snapshot, registry),
    create: (api) => createFaces(api),
  });
}
