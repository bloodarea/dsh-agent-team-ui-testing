/**
 * Composition root for the cross-environment foundation (M2/M3).
 *
 * `index.js` remains the Web implementation and composition entry; this module owns the
 * environment-neutral control plane: authoritative config, adapter registry, tool admission,
 * per-execution adapter invocation, readiness, Skill discovery and the `/config` HTTP surface.
 *
 * Dependency direction: this module imports `core/` and `targets/` only. It never imports
 * `index.js`, and the platform implementations never import this module. `index.js` injects the
 * Web runtime/registry through explicit callbacks, so `core/` stays free of CDP/page assumptions.
 */
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  AdapterError,
  AdapterRegistry,
  AVAILABILITY,
  CONTRACT_VERSION,
  ConfigStore,
  DEFAULT_CONFIG,
  DEFAULT_WEB_PROVIDER,
  ENVIRONMENTS,
  ERROR_CODES,
  IMPLEMENTED_WEB_PROVIDERS,
  KNOWN_ENVIRONMENTS,
  READINESS_STATUS,
  SUPPORT,
  WEB_PROVIDER_IDS,
  axis,
  createReadinessReport,
  isImplementedWebProvider,
  isPlannedEnvironment,
  resolveSnapshot,
  webProviderSupport,
} from '../core/index.js';
import { createFakeEnvironment } from '../targets/fake/adapter.js';
import {
  WEB_TOOL_OPERATIONS,
  createWebCapabilityAdapter,
  createWebTargetAdapter,
  resolveExecutionClass,
  resolveProviderExecutable,
  resolveWebDriver,
} from '../targets/web/adapter.js';
import { createWebP0Provider } from '../targets/web/provider.js';

const REPO_ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const DEFAULT_ENVIRONMENT = ENVIRONMENTS.WEB;
const FAKE_TOOL = 'browser_fake_probe';
const FAKE_OPERATION = 'fake.t1.echo';

/** Bounded freshness for readiness facts derived from a live target (plan §6.2 过期语义). */
const READINESS_TTL_MS = 30_000;

const SKILL_DEFINITIONS = Object.freeze([
  Object.freeze({ dir: 'ui-testing-common', name: 'ui-testing-common', environment: null, testOnly: false }),
  Object.freeze({ dir: 'ui-testing-web', name: 'ui-testing-web', environment: ENVIRONMENTS.WEB, testOnly: false }),
  Object.freeze({ dir: 'ui-testing-fake', name: 'ui-testing-fake', environment: ENVIRONMENTS.FAKE, testOnly: true }),
]);

function isPlainObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function readSkillDefinition(entry) {
  const file = join(REPO_ROOT, 'skills', entry.dir, 'SKILL.md');
  let text;
  try {
    text = readFileSync(file, 'utf8');
  } catch {
    return null;
  }
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/.exec(text);
  const fields = {};
  if (match) {
    for (const line of match[1].split(/\r?\n/)) {
      const index = line.indexOf(':');
      if (index <= 0) continue;
      const key = line.slice(0, index).trim();
      if (key) fields[key] = line.slice(index + 1).trim();
    }
  }
  return {
    name: fields.name || entry.name,
    description: fields.description || '',
    content: match ? match[2] : text,
    dir: entry.dir,
  };
}

function skillDirPath(entry) {
  return join(REPO_ROOT, 'skills', entry.dir);
}

function configDirectory(env = process.env) {
  const explicit = typeof env.DSH_UI_TESTING_CONFIG_DIR === 'string' ? env.DSH_UI_TESTING_CONFIG_DIR.trim() : '';
  if (explicit) return explicit;
  const home = typeof env.DSH_HOME === 'string' && env.DSH_HOME.trim() ? env.DSH_HOME.trim() : join(homedir(), '.dsh');
  return join(home, 'ui-testing');
}

/**
 * Environment-neutral diagnostics (plan §5.2.4 / §6.2): "what exists here" and "why is it refused"
 * must be answerable in *every* environment — including one the user disabled. They never touch a
 * page, so they are not bound to a single capability id.
 */
const ENV_NEUTRAL_TOOLS = Object.freeze(['browser_state', 'browser_capabilities']);

function isNeutralTool(name) {
  return ENV_NEUTRAL_TOOLS.includes(name);
}

function capabilityForTool(name) {
  if (isNeutralTool(name)) return null;
  if (name === FAKE_TOOL) return 'fake.t1';
  return WEB_TOOL_OPERATIONS[name] ?? null;
}

function operationForTool(name) {
  if (name === FAKE_TOOL) return FAKE_OPERATION;
  return name;
}

/**
 * Build the composition root.
 *
 * @param {{ctx:object, registry:object, log:Function,
 *   BrowserError:Function, asBrowserError:Function, env?:object}} input
 */
export function createCrossEnvironment({
  ctx,
  registry,
  log = () => {},
  BrowserError,
  asBrowserError,
  env = process.env,
} = {}) {
  if (typeof BrowserError !== 'function') throw new TypeError('createCrossEnvironment requires BrowserError');
  const classify = typeof asBrowserError === 'function' ? asBrowserError : (error) => error;

  const allowTestEnvironments = env.DSH_UI_TESTING_TEST_HOOKS === '1'
    || env.DSH_UI_TESTING_ALLOW_TEST_ENV === '1';
  const configStore = new ConfigStore({
    dir: configDirectory(env),
    log: ctx?.logger ?? null,
    allowTestEnvironments,
  }).load();
  const adapterRegistry = new AdapterRegistry();
  let disposed = false;
  let lastKnownGood = null;
  let invalidateSkills = () => {};

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
  function createWebProvider() {
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
          return registry.listTabs(context.primaryEntry ?? context.entry, context.meta?.sessionId);
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

  /*
   * Lazy Web faces (A14 按需加载 / 生命周期接线).
   *
   * The three Web adapters used to be created and registered unconditionally at composition-root
   * construction, so a Host that only ever runs the fake environment still instantiated the whole
   * Web surface. They are now created on first demand — the first Web-scoped admission, readiness
   * probe or tool call — and `dispose()` handles the never-created case.
   */
  let webFaces = null;
  let webFaceError = null;

  function createWebFaces() {
    const targetAdapter = createWebTargetAdapter({
      registry,
      log,
      capabilityAvailability: ({ entry, snapshot }) => probeWebCapabilities({
        entry: entry ?? findEntryForSnapshot(snapshot),
        checkedAt: Date.now(),
      }),
    });
    const capabilityAdapter = createWebCapabilityAdapter({
      log,
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
    const provider = createWebProvider();
    adapterRegistry.registerTargetAdapter(targetAdapter);
    adapterRegistry.registerCapabilityAdapter(capabilityAdapter);
    adapterRegistry.registerP0Provider(provider);
    return { targetAdapter, capabilityAdapter, provider };
  }

  /** Ensure the Web faces exist. Returns null when the Web environment is not in play. */
  function ensureWebRegistered() {
    if (webFaces) return webFaces;
    if (webFaceError) return null;
    try {
      webFaces = createWebFaces();
      return webFaces;
    } catch (error) {
      webFaceError = String((error && error.message) || error);
      log('ui-testing: web faces unavailable: ' + webFaceError);
      return null;
    }
  }

  /**
   * A snapshot needs the Web faces when it resolves to (or can select) the Web environment.
   * Anything else — a fake-only host, the planned environments — stays away from them.
   */
  function snapshotNeedsWeb(snapshot) {
    // Only an enabled Web allow-list justifies instantiating the Web faces: the resolver reports a
    // fallback environment even when nothing is enabled, and that is not a demand for Web (A14).
    return Boolean(snapshot) && Array.isArray(snapshot.enabledEnvironments)
      && snapshot.enabledEnvironments.includes(ENVIRONMENTS.WEB);
  }

  /** Load the Web faces for one resolved snapshot (no-op when Web is not involved). */
  function prepareWeb(snapshot) {
    if (!snapshotNeedsWeb(snapshot)) return null;
    return ensureWebRegistered();
  }

  let fakeEnvironment = null;
  if (allowTestEnvironments) {
    fakeEnvironment = createFakeEnvironment();
    adapterRegistry.registerTargetAdapter(fakeEnvironment.targetAdapter);
    adapterRegistry.registerCapabilityAdapter(fakeEnvironment.capabilityAdapter);
    adapterRegistry.registerP0Provider(fakeEnvironment.p0Provider);
  }

  const configListeners = new Set();

  configStore.subscribe(() => {
    try {
      invalidateSkills();
    } catch (error) {
      log('ui-testing: skill invalidation failed: ' + String((error && error.message) || error));
    }
    for (const listener of [...configListeners]) {
      try {
        listener();
      } catch (error) {
        log('ui-testing: config listener failed: ' + String((error && error.message) || error));
      }
    }
  });

  /** Subscribe to successful config writes (used to re-admit the tool surface). */
  function onConfigChange(fn) {
    if (typeof fn !== 'function') return () => {};
    configListeners.add(fn);
    return () => { configListeners.delete(fn); };
  }

  function leaseProjection(runtime) {
    const lease = runtime?.lease ?? null;
    return {
      leaseId: lease?.sessionId ? `web:${lease.sessionId}` : null,
      targetId: runtime?.runtimeId ?? null,
      generation: null,
      owner: lease?.sessionId ?? null,
      expiresAt: Number.isFinite(lease?.expiresAt) ? lease.expiresAt : null,
    };
  }

  function findEntryForSnapshot(snapshot) {
    const targetId = snapshot?.targetId;
    if (typeof targetId === 'string' && targetId) {
      for (const entry of registry?.entries?.values?.() ?? []) {
        if (entry?.tabId === targetId || entry?.runtimeId === targetId) return entry;
      }
    }
    for (const entry of registry?.entries?.values?.() ?? []) {
      if (entry?.runtime?.url) return entry;
    }
    return null;
  }

  function fallbackSnapshot(agent, error) {
    if (lastKnownGood) return lastKnownGood;
    try {
      return resolveSnapshot(DEFAULT_CONFIG, { agent }, { allowTestEnvironments });
    } catch {
      return {
        revision: 0,
        environment: DEFAULT_ENVIRONMENT,
        adapterId: DEFAULT_ENVIRONMENT,
        provider: DEFAULT_WEB_PROVIDER,
        executionAdapterId: `${DEFAULT_ENVIRONMENT}-${DEFAULT_WEB_PROVIDER}`,
        enabledProviders: [DEFAULT_WEB_PROVIDER],
        providerConfig: {
          provider: DEFAULT_WEB_PROVIDER,
          enabled: true,
          executable: null,
          connection: null,
          implemented: true,
        },
        enabledEnvironments: [DEFAULT_ENVIRONMENT],
        capabilities: [],
        environmentConfig: {},
        targetId: null,
        source: { degraded: true, reason: String((error && error.message) || error) },
      };
    }
  }

  /** Resolve a snapshot without ever throwing: `when` must not break step preparation. */
  function snapshotForAgent(agent) {
    try {
      const snapshot = configStore.resolveForAgent(agent);
      lastKnownGood = snapshot;
      return snapshot;
    } catch (error) {
      log('ui-testing: config resolve failed; using last-known-good/default: ' + String((error && error.message) || error));
      const snapshot = fallbackSnapshot(agent, error);
      return { ...snapshot, source: { ...(snapshot.source || {}), degraded: true } };
    }
  }

  function snapshotForScope(scope) {
    try {
      const snapshot = configStore.resolveForScope(scope);
      lastKnownGood = snapshot;
      return snapshot;
    } catch (error) {
      log('ui-testing: config resolve failed for scope; using fallback: ' + String((error && error.message) || error));
      return fallbackSnapshot(null, error);
    }
  }

  function toolAdmitted(agent, name) {
    // Environment-neutral diagnostics answer "what is here / why was it refused"; they must stay
    // available in every environment, including a disabled one (they never start a target).
    if (isNeutralTool(name)) return true;
    const capability = capabilityForTool(name);
    if (capability === null) return false;
    const snapshot = snapshotForAgent(agent);
    const environmentEnabled = Array.isArray(snapshot.enabledEnvironments)
      && snapshot.enabledEnvironments.includes(snapshot.environment);
    if (!environmentEnabled) return false;
    if (!Array.isArray(snapshot.capabilities) || !snapshot.capabilities.includes(capability)) return false;
    if (name === FAKE_TOOL) return snapshot.environment === ENVIRONMENTS.FAKE;
    // §4.3: admission also answers the provider question. A disabled selection, an unknown name or
    // a provider without a driver refuses the Web operations (never a silent browser swap).
    if (snapshot.environment === ENVIRONMENTS.WEB && WEB_TOOL_OPERATIONS[name] !== undefined) {
      if (resolveWebDriver(snapshot).blocked !== null) return false;
    }
    return true;
  }

  /**
   * Web provider switches for one resolved snapshot (derived, never a second stored list).
   * `implementedProviders` is the subset a driver actually exists for.
   */
  function webProvidersFor(snapshot) {
    const entry = isPlainObject(snapshot?.environmentConfig) ? snapshot.environmentConfig : {};
    const providers = isPlainObject(entry.providers) ? entry.providers : {};
    const enabledProviders = WEB_PROVIDER_IDS.filter((id) => providers[id]?.enabled === true);
    return {
      providers,
      enabledProviders,
      implementedProviders: enabledProviders.filter((id) => isImplementedWebProvider(id)),
      totalEnabled: entry.enabled === true,
    };
  }

  /**
   * Providers enabled by *any* selectable scope (global + workspace switches). A session may only
   * choose between these, so this union is the registration ceiling (§4.3).
   */
  function enabledProviderUnion() {
    const config = configStore.getConfig();
    const consider = (entry) => {
      const web = isPlainObject(entry) ? entry.environments?.[ENVIRONMENTS.WEB] : null;
      if (!isPlainObject(web) || !isPlainObject(web.providers)) return;
      for (const id of WEB_PROVIDER_IDS) {
        if (web.providers[id]?.enabled === true) union.add(id);
      }
    };
    const union = new Set();
    consider(config.global);
    for (const entry of Object.values(config.workspaces || {})) consider(entry);
    return union;
  }

  /** True when the Web tools may exist at all: some implemented provider is enabled somewhere. */
  function webProviderSurfaceAvailable() {
    const union = enabledProviderUnion();
    return IMPLEMENTED_WEB_PROVIDERS.some((id) => union.has(id));
  }

  /** The provider/execution identity block exposed by /config, /config/select and capabilities. */
  function resolvedBlock(snapshot) {
    return {
      environment: snapshot.environment,
      adapterId: snapshot.adapterId,
      provider: snapshot.provider ?? null,
      executionAdapterId: snapshot.executionAdapterId ?? snapshot.adapterId,
      enabledProviders: Array.isArray(snapshot.enabledProviders) ? [...snapshot.enabledProviders] : [],
      providerConfig: snapshot.providerConfig ?? null,
      enabledEnvironments: snapshot.enabledEnvironments,
      capabilities: snapshot.capabilities,
      targetId: snapshot.targetId,
      source: snapshot.source,
    };
  }

  /** Every environment some scope is allowed to select (global + workspace allow-lists). */
  function enabledEnvironmentUnion() {
    const config = configStore.getConfig();
    const set = new Set(Array.isArray(config.global?.enabledEnvironments) ? config.global.enabledEnvironments : []);
    for (const entry of Object.values(config.workspaces || {})) {
      if (!isPlainObject(entry) || !Array.isArray(entry.enabledEnvironments)) continue;
      for (const environment of entry.enabledEnvironments) set.add(environment);
    }
    return set;
  }

  /**
   * Tool names to *register* — the declaration set (A08).
   *
   * Measured on the running host (2026-11-07, `request/header` events of a live session): a
   * per-step `when` that returned false did **not** remove the tool from the model-facing list,
   * and the call still reached the plugin body. This composition therefore builds the request from
   * what is *registered*, exactly like the pre-migration behaviour: registration scope is the
   * effective isolation, and `when` is only a second gate for compositions that do apply step
   * admission to declarations.
   *
   * So the union is limited to the environments a scope may actually select (plus the neutral
   * diagnostics): a disabled environment's tools are unregistered and cannot appear in any
   * request, while an enabled one stays available to the agents that select it.
   */
  function declarableToolNames() {
    const names = new Set(ENV_NEUTRAL_TOOLS);
    const enabled = enabledEnvironmentUnion();
    // §4.3: the Web tools exist while the total switch is valid AND at least one *implemented*
    // provider is enabled. The 36 names are registered once; provider routing happens per call, so
    // enabling one or two providers never changes the registered set.
    if (enabled.has(ENVIRONMENTS.WEB) && webProviderSurfaceAvailable()) {
      for (const name of Object.keys(WEB_TOOL_OPERATIONS)) names.add(name);
    }
    // The test-only probe follows the same rule: registered only while the fake environment is
    // selectable, so it can never leak into a Web-only request.
    if (allowTestEnvironments && enabled.has(ENVIRONMENTS.FAKE)) names.add(FAKE_TOOL);
    return names;
  }

  /**
   * Per-agent double-check of the declarable set (diagnostics, tests and the HTTP surface use it).
   * Omitted `agent` resolves the global selection, exactly like the settings page.
   */
  function admissibleToolNames(agent = null) {
    const names = new Set();
    for (const name of declarableToolNames()) {
      if (toolAdmitted(agent, name)) names.add(name);
    }
    return names;
  }

  function assertToolAllowed(agent, name) {
    if (toolAdmitted(agent, name)) return true;
    const snapshot = snapshotForAgent(agent);
    throw new BrowserError(ERROR_CODES.ADAPTER_DISABLED, `工具 ${name} 不属于当前环境 ${snapshot.environment}`, {
      environment: snapshot.environment,
      capability: capabilityForTool(name),
      configRevision: snapshot.revision,
    });
  }

  function adapterSessionFor({ snapshot, resolvedScope, exec }) {
    const { targetAdapter } = adapterRegistry.resolve(snapshot);
    const scopeId = resolvedScope?.scope?.id || resolvedScope?.id || exec?.meta?.scope?.id || 'legacy:default';
    const workspaceId = resolvedScope?.scope?.workspaceId || resolvedScope?.workspaceId || null;
    return targetAdapter.createSession({
      scope: { id: scopeId, workspaceId },
      snapshot,
      signal: exec?.signal,
    });
  }

  const P0_FAMILY_SURFACE = Object.freeze({ A: 'capture', B: 'network', C: 'display', D: 'canvas', E: 'targets' });

  /**
   * Dispatch one P0 data operation through the environment's P0 provider (A01).
   *
   * Tool implementations used to call `runtime.*` directly, which left the provider as a parallel,
   * unused surface. Every采集/网络/显示/标注/目标读 now goes through this one entry: the provider
   * validates admission, binds the operations to the calling session's target/generation and
   * attaches the evidence envelope, while the tool keeps its public result shape (`raw: true`
   * skips neutral normalization for platform-shaped payloads).
   *
   * @returns {Promise<{value: any, evidence: object|null}>}
   */
  async function p0Call({
    family,
    method,
    args = {},
    exec = {},
    resolvedScope = null,
    runtime = null,
    entry = null,
    meta = null,
    selection = null,
    raw = true,
  }) {
    const surfaceName = P0_FAMILY_SURFACE[family];
    if (!surfaceName) {
      throw new BrowserError(ERROR_CODES.INVALID_ARGUMENT, `unknown P0 family ${String(family)}`, { family });
    }
    const snapshot = snapshotForAgent(exec?.agent);
    prepareWeb(snapshot);
    // §4.4 provider gate for the P0 surface: a disabled / unknown / unimplemented provider refuses
    // the call instead of being answered by whichever browser happens to be running.
    const driver = resolveWebDriver(snapshot);
    if (driver.blocked !== null) {
      const disabled = driver.blocked === 'environment-disabled' || driver.blocked === 'provider-disabled';
      throw new BrowserError(
        disabled ? ERROR_CODES.ADAPTER_DISABLED : ERROR_CODES.ADAPTER_UNSUPPORTED,
        disabled
          ? `当前 Web 运行环境（${driver.provider}）已禁用：${driver.blocked}`
          : `当前 Web 运行环境（${driver.provider}）不可执行：${driver.blocked}`,
        { provider: driver.provider, reason: driver.blocked, family, method, configRevision: snapshot.revision },
      );
    }
    const { providers } = adapterRegistry.resolve(snapshot);
    const provider = providers?.[0];
    if (!provider || typeof provider[surfaceName]?.[method] !== 'function') {
      throw new BrowserError(ERROR_CODES.PROVIDER_UNAVAILABLE, `环境 ${snapshot.environment} 没有 P0 提供者方法 ${family}.${method}`, {
        environment: snapshot.environment,
        family,
        method,
      });
    }
    const session = await adapterSessionFor({ snapshot, resolvedScope, exec });
    try {
      const targetId = selection?.tabId || entry?.tabId || snapshot.targetId || null;
      if (targetId) {
        try {
          await session.bind(targetId, { signal: exec?.signal });
        } catch (error) {
          if (error?.code !== ERROR_CODES.TARGET_NOT_BOUND) throw error;
        }
      }
      const result = await provider[surfaceName][method]({
        args: isPlainObject(args) ? args : {},
        session,
        snapshot,
        signal: exec?.signal,
        context: { ...exec, runtime, meta, entry, primaryEntry: entry, selection },
        raw,
      });
      return { value: result?.value ?? null, evidence: result?.evidence ?? null, targetId, generation: session.generation ?? null };
    } catch (error) {
      // The platform's own error vocabulary must survive the provider boundary: a NET_*/VISION_*/
      // OUTPUT_* failure is exactly what the tool contract documents, and collapsing it to INTERNAL
      // would erase the classification the caller branches on. Prefer the original cause, then the
      // adapter code, then a classified BrowserError.
      const cause = error?.cause;
      if (cause instanceof BrowserError) throw cause;
      if (cause && typeof cause.code === 'string' && cause.code !== 'INTERNAL') throw cause;
      if (error instanceof AdapterError && error.code !== ERROR_CODES.INTERNAL) {
        const prefix = `[${error.code}] `;
        const rawMessage = String(error.message || '');
        throw new BrowserError(error.code, rawMessage.startsWith(prefix) ? rawMessage.slice(prefix.length) : rawMessage, error.details || {});
      }
      throw classify(error);
    } finally {
      try { await session.dispose(); } catch { /* session cleanup never masks the result */ }
    }
  }

  /**
   * Run one tool implementation through the capability adapter.
   *
   * The caller has already chosen the execution class branch (page/readOnly/hostOnly/...), so the
   * adapter only validates admission/identity and forwards `context.execute`. That keeps the
   * existing Web branching (queue/ensure/lease) intact while making the adapter the only dispatch
   * path for the 36 tools.
   */
  async function invokeTool({
    name,
    args,
    exec = {},
    thunk,
    executionClass,
    resolvedScope = null,
    runtime = null,
    entry = null,
    selection = null,
    meta = null,
  }) {
    // Cancellation before any adapter work is a first-class ABORTED, not an adapter-internal
    // failure: the existing tool contract reports ABORTED/cancelled/retryable for a pre-aborted
    // signal, and a session must not be created for a call that already knows it is cancelled.
    if (exec?.signal?.aborted) throw new BrowserError('ABORTED', '操作已取消');
    const snapshot = snapshotForAgent(exec.agent);
    assertToolAllowed(exec.agent, name);
    // Lazily bring the Web faces up for a Web-resolved call (A14); other environments never
    // instantiate them.
    prepareWeb(snapshot);
    if (isNeutralTool(name)) {
      // Environment-neutral diagnostics do not belong to a capability adapter and must answer even
      // when the environment is disabled (no target is started): run the implementation directly.
      const neutral = await thunk();
      if (meta && typeof meta === 'object') {
        meta.configRevision = snapshot.revision;
        meta.environment = snapshot.environment;
        meta.adapterId = snapshot.adapterId;
      }
      return neutral;
    }
    const { capabilityAdapters } = adapterRegistry.resolve(snapshot);
    const capabilityAdapter = capabilityAdapters[0];
    if (!capabilityAdapter) {
      throw new BrowserError(ERROR_CODES.ADAPTER_NOT_FOUND, '当前环境没有可用的能力适配器', {
        environment: snapshot.environment,
      });
    }
    const session = await adapterSessionFor({ snapshot, resolvedScope, exec });
    try {
      const classForCall = executionClass || resolveExecutionClass(name, args) || 'page';
      if (name === FAKE_TOOL) {
        const targets = await session.listTargets({ signal: exec.signal });
        if (targets[0]) await session.bind(targets[0].targetId, { signal: exec.signal });
      } else if (runtime && (classForCall === 'page' || classForCall === 'tabs')) {
        const targetId = selection?.tabId || entry?.tabId || 'primary';
        try {
          await session.bind(targetId, { signal: exec.signal });
        } catch (error) {
          if (error?.code !== ERROR_CODES.TARGET_NOT_BOUND) throw error;
        }
      }
      const context = {
        ...exec,
        runtime,
        meta,
        entry,
        primaryEntry: entry,
        selection,
        execute: thunk,
      };
      let result;
      try {
        result = await capabilityAdapter.invoke({
          operation: operationForTool(name),
          args: name === FAKE_TOOL ? (isPlainObject(args) ? args : {}) : args,
          session,
          snapshot,
          signal: exec.signal,
          executionClass: classForCall,
          context,
        });
      } catch (error) {
        // Preserve the stable machine code across the adapter boundary. `asBrowserError` only
        // recognizes BrowserError, so an AdapterError must be translated explicitly instead of
        // collapsing every typed failure into INTERNAL.
        if (error instanceof AdapterError) {
          const prefix = `[${error.code}] `;
          const raw = String(error.message || '');
          throw new BrowserError(error.code, raw.startsWith(prefix) ? raw.slice(prefix.length) : raw, error.details || {});
        }
        throw error;
      }
      if (meta && typeof meta === 'object') {
        meta.configRevision = snapshot.revision;
        meta.environment = snapshot.environment;
        meta.adapterId = snapshot.adapterId;
      }
      // `context.rawResult` is the tool's complete result; `result.value` is the adapter's
      // normalized view (used when the platform dispatch did not go through the thunk).
      return Object.hasOwn(context, 'rawResult') ? context.rawResult : result.value;
    } finally {
      try {
        await session.dispose();
      } catch {
        // Session cleanup must never mask the operation result.
      }
    }
  }

  function executionClassFor(name, args) {
    if (name === FAKE_TOOL) return 'page';
    return resolveExecutionClass(name, args);
  }

  function resolveRequestScope(scopeRequest) {
    if (!scopeRequest || scopeRequest.mode === 'legacy') return { id: 'legacy:default', kind: 'legacy', workspaceId: null };
    if (scopeRequest.mode === 'unassigned') return { id: 'unassigned:owner', kind: 'unassigned', workspaceId: null };
    if (scopeRequest.mode === 'session') {
      return { id: String(scopeRequest.sessionId || 'session'), kind: 'session', workspaceId: null, cwd: scopeRequest.cwd };
    }
    return { id: 'recent', kind: scopeRequest.mode || 'scope', workspaceId: null, cwd: scopeRequest.cwd };
  }

  /**
   * Rebuild the agent shape `resolveSnapshot` expects from an HTTP/Skill scope request, so a
   * scope-scoped caller gets the same admission answer a model step would get (A08 / A11).
   */
  function agentForScope(scopeRequest, resolvedScope = null) {
    const scope = resolvedScope || resolveRequestScope(scopeRequest);
    if (!scope || (scope.kind !== 'session' && scope.kind !== 'unassigned')) return null;
    return { id: scope.id, session: { header: { cwd: scope.cwd ?? null } } };
  }

  /**
   * Six-axis readiness for one resolved snapshot.
   *
   * @param {object} snapshot resolved configuration snapshot
   * @param {object|null} [liveTarget] the *current session's* bound target, when the caller has one:
   *   `{ sessionId, runtimeId, url, transport, pageGeneration, documentEpoch }`. With it the
   *   connection/target/capability axes report what is actually bound plus a bounded freshness
   *   window, instead of a static `not-probed`/`unbound` projection (plan §6.2, A13).
   */
  async function readinessFor(snapshot, liveTarget = null) {
    // Readiness for an enabled/selected Web environment needs its adapter; a disabled one is
    // answered from static metadata without loading it (A13 + A14).
    prepareWeb(snapshot);
    const checkedAt = Date.now();
    const expiresAt = checkedAt + READINESS_TTL_MS;
    const live = liveTarget && typeof liveTarget === 'object' && liveTarget.runtimeId
      ? {
        sessionId: liveTarget.sessionId ?? null,
        runtimeId: String(liveTarget.runtimeId),
        url: liveTarget.url ?? null,
        transport: liveTarget.transport ?? null,
        pageGeneration: Number.isInteger(liveTarget.pageGeneration) ? liveTarget.pageGeneration : null,
        documentEpoch: Number.isInteger(liveTarget.documentEpoch) ? liveTarget.documentEpoch : null,
      }
      : null;
    const liveAxes = live
      ? {
        connection: axis(READINESS_STATUS.OK, {
          checkedAt,
          expiresAt,
          evidence: { id: live.runtimeId, kind: 'runtime', transport: live.transport, url: live.url },
        }),
        target: axis(READINESS_STATUS.BOUND, {
          checkedAt,
          expiresAt,
          target: { id: live.runtimeId, generation: live.pageGeneration, documentEpoch: live.documentEpoch, url: live.url },
          evidence: { id: live.runtimeId, kind: 'runtime' },
        }),
        capability: axis(READINESS_STATUS.OK, {
          checkedAt,
          expiresAt,
          target: { id: live.runtimeId, generation: live.pageGeneration, documentEpoch: live.documentEpoch, url: live.url },
          evidence: { id: live.runtimeId, kind: 'page-bound', sessionId: live.sessionId },
        }),
      }
      : null;
    const config = configStore.getConfig();
    const environments = [];
    const known = Object.keys(KNOWN_ENVIRONMENTS);
    for (const id of known) {
      const meta = KNOWN_ENVIRONMENTS[id] || {};
      const enabled = config.global.environments?.[id]?.enabled === true;
      const selected = snapshot.environment === id;
      // A14: a disabled environment is *not* probed and its adapter is not instantiated, so the
      // settings page cannot pull in a platform's dependency chain by being opened. Its axes are
      // answered from static engineering metadata plus the user-policy switch, which keeps
      // "supported but disabled" distinguishable from "planned" and from "unavailable".
      // Probe only an environment the user actually enabled: a disabled one must not be probed
      // (that is what "打开设置页不扫描未启用环境" means). `selected` alone is not enough — when
      // every environment is disabled the resolver still reports a fallback, which is not a
      // request to probe anything.
      const adapter = meta.planned ? null : (enabled ? safeResolveAdapter(id, snapshot) : null);
      if (!adapter) {
        if (!meta.planned && !enabled) {
          const support = meta.status === 'supported' ? SUPPORT.SUPPORTED : SUPPORT.UNSUPPORTED;
          environments.push({
            id,
            displayName: meta.displayName || id,
            support,
            enabled,
            selected,
            checkedAt,
            configRevision: snapshot.revision,
            axes: {
              support: axis(support, { checkedAt }),
              enabled: axis('false', { reason: 'environment-disabled', checkedAt }),
              dependency: axis(READINESS_STATUS.NOT_PROBED, { reason: 'environment-disabled', checkedAt }),
              connection: axis(READINESS_STATUS.NOT_PROBED, { reason: 'environment-disabled', checkedAt }),
              target: axis(READINESS_STATUS.UNBOUND, { reason: 'environment-disabled', checkedAt }),
              capability: axis(READINESS_STATUS.NOT_PROBED, { reason: 'environment-disabled', checkedAt }),
            },
          });
          continue;
        }
        environments.push({
          id,
          displayName: meta.displayName || id,
          support: meta.planned ? SUPPORT.PLANNED : SUPPORT.UNSUPPORTED,
          enabled,
          selected,
          checkedAt,
          configRevision: snapshot.revision,
          axes: {
            support: axis(meta.planned ? SUPPORT.PLANNED : SUPPORT.UNSUPPORTED, { reason: 'adapter-not-registered', checkedAt }),
            enabled: axis(enabled ? 'true' : 'false', { reason: enabled ? null : 'environment-disabled', checkedAt }),
            dependency: axis(READINESS_STATUS.NOT_PROBED, { reason: 'not-probed', checkedAt }),
            connection: axis(READINESS_STATUS.NOT_PROBED, { reason: 'not-probed', checkedAt }),
            target: axis(READINESS_STATUS.UNBOUND, { reason: 'no-target', checkedAt }),
            capability: axis(SUPPORT.UNSUPPORTED, { reason: 'adapter-not-registered', checkedAt }),
          },
        });
        continue;
      }
      let report;
      try {
        report = await adapter.probe({ scope: resolveRequestScope({ mode: 'legacy' }), snapshot, signal: AbortSignal.timeout(2000) });
      } catch (error) {
        report = createReadinessReport({
          environment: id,
          snapshot,
          adapter,
          axes: {
            support: axis(SUPPORT.SUPPORTED, { checkedAt }),
            dependency: axis(READINESS_STATUS.NOT_PROBED, { reason: 'probe-failed', checkedAt }),
          },
          now: checkedAt,
        });
      }
      environments.push({
        id,
        displayName: adapter.manifest.displayName || id,
        support: adapter.manifest.contractVersion === CONTRACT_VERSION ? SUPPORT.SUPPORTED : SUPPORT.UNSUPPORTED,
        enabled,
        selected,
        checkedAt,
        configRevision: snapshot.revision,
        axes: {
          ...report.axes,
          ...(selected && liveAxes ? liveAxes : {}),
          // "enabled" answers the user-policy question with true/false, not a readiness status.
          enabled: axis(enabled ? 'true' : 'false', {
            reason: enabled ? null : 'environment-disabled',
            checkedAt,
          }),
        },
      });
    }
    // Per-provider cards (§7): each provider answers with its own axes; the environment-level
    // axes stay as the summary the earlier pages already rely on.
    const webEntry = config.global.environments?.[ENVIRONMENTS.WEB] ?? null;
    for (const environment of environments) {
      if (environment.id !== ENVIRONMENTS.WEB) continue;
      environment.providers = providerReadinessBlock({
        snapshot,
        webEntry,
        checkedAt,
        axes: environment.axes,
      });
    }
    return { checkedAt, configRevision: snapshot.revision, environments };
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

  function safeResolveAdapter(id, snapshot) {
    try {
      const resolved = adapterRegistry.resolve({ ...snapshot, environment: id, adapterId: id }, { ignoreEnabled: true });
      return resolved.targetAdapter;
    } catch {
      return null;
    }
  }

  async function configPayload(view, scopeRequest) {
    const config = configStore.getConfig();
    const scope = resolveRequestScope(scopeRequest);
    const snapshot = view === 'global' || !scopeRequest || scopeRequest.mode === 'legacy'
      ? resolveSnapshot(config, {}, { allowTestEnvironments })
      : configStore.resolveForScope(scope);
    return {
      ok: true,
      revision: config.revision,
      config,
      resolved: resolvedBlock(snapshot),
      readiness: await readinessFor(snapshot),
    };
  }

  function statusForAdapterError(error) {
    if (error?.code === ERROR_CODES.CONFIG_CONFLICT) return 409;
    if (error?.code === ERROR_CODES.CONFIG_INVALID || error?.code === ERROR_CODES.INVALID_ARGUMENT) return 400;
    if (error?.code === ERROR_CODES.ADAPTER_DISABLED) return 409;
    return 500;
  }

  /**
   * Handle `/config`, `/config/select` and `/readiness`. Returns true when the request was
   * consumed. The caller has already applied the scoped authentication gate.
   */
  async function handleHttp(req, res, options = {}) {
    const { action, url, scopeRequest, scoped, requestRejection, rejectUi, readJson, sendJson, resolveScopeRequest } = options;
    if (!['/config', '/config/select', '/readiness'].includes(action)) return false;
    if (!scoped) {
      const rejection = typeof requestRejection === 'function' ? requestRejection(req) : 0;
      if (rejection) {
        if (typeof rejectUi === 'function') rejectUi(res, rejection);
        else sendJson(res, 401, { ok: false, code: 'SCOPE_FORBIDDEN' });
        return true;
      }
    }
    try {
      if (action === '/config' && req.method === 'GET') {
        const view = url.searchParams.get('view') || 'global';
        sendJson(res, 200, await configPayload(view, scopeRequest));
        return true;
      }
      if (action === '/readiness' && req.method === 'GET') {
        const config = configStore.getConfig();
        const scope = resolveRequestScope(scopeRequest);
        const snapshot = scopeRequest?.mode === 'session'
          ? configStore.resolveForScope(scope)
          : resolveSnapshot(config, {}, { allowTestEnvironments });
        sendJson(res, 200, { ok: true, revision: config.revision, ...(await readinessFor(snapshot)) });
        return true;
      }
      if (action === '/config' && req.method === 'PUT') {
        const body = await readJson(req);
        if (!isPlainObject(body)) throw new AdapterError(ERROR_CODES.CONFIG_INVALID, 'body must be an object');
        const { expectedRevision, scope } = body;
        let { patch } = body;
        if (!['global', 'workspace', 'session'].includes(scope)) {
          throw new AdapterError(ERROR_CODES.CONFIG_INVALID, 'scope must be global|workspace|session', { scope });
        }
        if (!isPlainObject(patch)) {
          throw new AdapterError(ERROR_CODES.CONFIG_INVALID, 'patch must be an object', { field: 'patch' });
        }
        // Keep the allow-list and the per-environment switch consistent: the settings page toggles
        // `environments.<env>.enabled`, while execution/schema admission reads enabledEnvironments.
        if (isPlainObject(patch.environments)) {
          const current = configStore.getConfig();
          const nextEnabled = new Set(current.global.enabledEnvironments || []);
          for (const [environment, entry] of Object.entries(patch.environments)) {
            if (!isPlainObject(entry)) continue;
            // `enabledEnvironments` 是**可执行环境集合**（保持严格：只收已实现的环境）；
            // 规划中的环境允许被"启用"（开关写进 environments 映射），但不混进执行集合——
            // 「启用 ≠ 可执行」，否则这里会用一个注定被执行侧拒绝的值污染 allow-list。
            const planned = isPlannedEnvironment(environment);
            if (entry.enabled === false) nextEnabled.delete(environment);
            else if (entry.enabled === true && !planned) nextEnabled.add(environment);
          }
          patch = { ...patch, enabledEnvironments: [...nextEnabled] };
        }
        const requestScope = resolveRequestScope(scopeRequest);
        const written = configStore.write({
          expectedRevision,
          scope,
          patch,
          workspaceKey: requestScope.workspaceId ? `workspace:${requestScope.workspaceId}` : undefined,
          agentId: scope === 'session' ? requestScope.id : undefined,
        });
        const snapshot = resolveSnapshot(written.config, {}, { allowTestEnvironments });
        sendJson(res, 200, {
          ok: true,
          revision: written.revision,
          config: written.config,
          resolved: resolvedBlock(snapshot),
        });
        return true;
      }
      if (action === '/config/select' && req.method === 'POST') {
        const body = await readJson(req);
        if (!isPlainObject(body)) throw new AdapterError(ERROR_CODES.CONFIG_INVALID, 'body must be an object');
        const scope = body.scope === 'workspace' || body.scope === 'global' ? body.scope : 'session';
        if (scope === 'session' && (!scopeRequest || scopeRequest.mode !== 'session')) {
          throw new AdapterError(ERROR_CODES.SCOPE_INVALID, 'session selection requires a session-scoped request');
        }
        const requestScope = resolveRequestScope(scopeRequest);
        const written = configStore.select({
          expectedRevision: body.expectedRevision,
          scope,
          environment: body.environment,
          targetId: body.targetId,
          agentId: scope === 'session' ? requestScope.id : undefined,
          workspaceKey: requestScope.workspaceId ? `workspace:${requestScope.workspaceId}` : undefined,
          cwd: requestScope.cwd,
        });
        const snapshot = scope === 'session'
          ? configStore.resolveForScope(requestScope)
          : resolveSnapshot(written.config, {}, { allowTestEnvironments });
        sendJson(res, 200, {
          ok: true,
          revision: written.revision,
          resolved: resolvedBlock(snapshot),
        });
        return true;
      }
      return false;
    } catch (error) {
      // AdapterError already carries the stable code; `asBrowserError` would collapse it to
      // INTERNAL and turn a CAS conflict into a 500.
      const classified = error instanceof AdapterError ? error : classify(error);
      const status = statusForAdapterError(classified);
      const payload = { ok: false, ...classified.payload?.(), code: classified.code, error: classified.message };
      if (classified.code === ERROR_CODES.CONFIG_CONFLICT) {
        const config = configStore.getConfig();
        payload.revision = config.revision;
        payload.config = config;
      }
      sendJson(res, status, payload);
      return true;
    }
  }

  /** GUI/legacy page-write guard: diagnostics stay readable, writes follow the same config. */
  function assertGuiAllowed(scopeRequest) {
    const snapshot = scopeRequest?.mode === 'session'
      ? configStore.resolveForScope(resolveRequestScope(scopeRequest))
      : resolveSnapshot(configStore.getConfig(), {}, { allowTestEnvironments });
    if (snapshot.environment !== ENVIRONMENTS.WEB || !snapshot.enabledEnvironments.includes(ENVIRONMENTS.WEB)) {
      throw new BrowserError(ERROR_CODES.ADAPTER_DISABLED, '当前环境未启用 Web 页面操作', {
        environment: snapshot.environment,
        configRevision: snapshot.revision,
      });
    }
    return snapshot;
  }

  async function capabilitiesBlock(scopeRequest = null, liveTarget = null, snapshotOverride = null) {
    // The tool path already resolved the calling agent's snapshot; passing it in keeps the adapter
    // block on the SAME snapshot as execution (a session-scoped selection must not be reported as
    // the global environment).
    const snapshot = snapshotOverride && typeof snapshotOverride === 'object' && typeof snapshotOverride.environment === 'string'
      ? snapshotOverride
      : (scopeRequest?.mode === 'session'
        ? configStore.resolveForScope(resolveRequestScope(scopeRequest))
        : resolveSnapshot(configStore.getConfig(), {}, { allowTestEnvironments }));
    prepareWeb(snapshot);
    let capabilities = [];
    let p0 = {};
    try {
      capabilities = adapterRegistry.capabilitiesFor(snapshot);
      const resolved = adapterRegistry.resolve(snapshot);
      const provider = resolved.providers?.[0];
      if (provider && typeof provider.familyStatus === 'function') {
        p0 = provider.familyStatus({ session: null, snapshot });
      }
    } catch {
      // Capability discovery is advisory; the tool surface stays usable.
    }
    // Declared-vs-executed surface (A08 / F6): the plugin registers the union of tool definitions
    // and lets the host resolve `when` per step, so the model-facing declaration is computed from
    // the *same* snapshot that admits the call. The block below states the admitted names for this
    // scope so a caller can compare declaration and execution without inferring it.
    let declaration;
    try {
      const scopeInfo = resolveRequestScope(scopeRequest);
      const agent = agentForScope(scopeRequest, scopeInfo);
      const registered = [...declarableToolNames()].sort();
      const admitted = [...admissibleToolNames(agent)].sort();
      const isolated = registered.length === admitted.length
        && registered.every((name, index) => name === admitted[index]);
      declaration = {
        surface: 'host-tool-registration',
        registration: 'enabled-union',
        environment: snapshot.environment,
        sessionEnvironment: snapshot.environment,
        registeredTools: registered,
        registeredCount: registered.length,
        admittedTools: admitted,
        admittedCount: admitted.length,
        isolated,
        note: isolated
          ? '注册面 = 当前环境和公共诊断，模型请求里的插件 schema 与执行准入一致'
          : '本机组合的模型请求按“已注册”构建（实测：when 返回 false 的工具仍在 request/header 里），'
            + '因此隔离由注册范围保证；admittedTools 只反映逐 Agent 的第二道闸门',
      };
    } catch {
      declaration = null;
    }
    return {
      contractVersion: CONTRACT_VERSION,
      environment: snapshot.environment,
      adapterId: snapshot.adapterId,
      configRevision: snapshot.revision,
      capabilities,
      p0,
      declaration,
      readiness: await readinessFor(snapshot, liveTarget),
    };
  }

  /**
   * Register the environment-aware Skill provider. Falls back to the historical single-skill
   * registration when the DSH build has no provider API.
   */
  function registerSkills(sub) {
    if (!sub || !sub.skills) return;
    if (typeof sub.skills.registerProvider === 'function') {
      sub.effect(() => sub.skills.registerProvider((control) => {
        invalidateSkills = () => control.invalidate();
        const list = async (options = {}) => {
          const snapshot = skillSnapshot(options);
          const out = [];
          for (const entry of SKILL_DEFINITIONS) {
            if (!skillVisible(entry, snapshot)) continue;
            const parsed = readSkillDefinition(entry);
            if (!parsed) continue;
            out.push({
              name: parsed.name,
              description: parsed.description,
              invocation: { modelInvocable: true, userInvocable: true },
              source: 'bundled',
              provider: 'ui-testing',
              rank: 500,
              locator: { dir: entry.dir },
              resourceBase: { kind: 'directory', path: skillDirPath(entry) },
            });
          }
          return out;
        };
        const get = async (candidate, options = {}) => {
          const dir = candidate?.locator?.dir;
          const entry = SKILL_DEFINITIONS.find((item) => item.dir === dir);
          if (!entry) return undefined;
          const snapshot = skillSnapshot(options);
          if (!skillVisible(entry, snapshot)) return undefined;
          const parsed = readSkillDefinition(entry);
          if (!parsed) return undefined;
          return {
            name: parsed.name,
            description: parsed.description,
            content: parsed.content,
            invocation: { modelInvocable: true, userInvocable: true },
            source: 'bundled',
            provider: 'ui-testing',
            resourceBase: { kind: 'directory', path: skillDirPath(entry) },
          };
        };
        return { name: 'ui-testing', list, get };
      }), 'ui-testing: skill provider');
      return;
    }
    // Legacy fallback: keep the Web skill registered when no provider API exists.
    const parsed = readSkillDefinition(SKILL_DEFINITIONS[1]);
    if (parsed) {
      sub.effect(() => sub.skills.register({
        name: parsed.name,
        description: parsed.description,
        content: parsed.content,
        resourceBase: { kind: 'directory', path: skillDirPath(SKILL_DEFINITIONS[1]) },
      }), 'ui-testing: bundled skill');
    }
  }

  function skillSnapshot(options = {}) {
    const scope = options.scope;
    const agent = scope && typeof scope === 'object' && typeof scope.id === 'string'
      ? { id: scope.id, session: scope.session }
      : null;
    if (agent) {
      try {
        return configStore.resolveForAgent(agent);
      } catch {
        // Fall through to cwd/global.
      }
    }
    if (typeof options.cwd === 'string' && options.cwd) {
      try {
        return configStore.resolveForScope({ cwd: options.cwd });
      } catch {
        // Fall through to global.
      }
    }
    try {
      return resolveSnapshot(configStore.getConfig(), {}, { allowTestEnvironments });
    } catch {
      return fallbackSnapshot(null, null);
    }
  }

  /**
   * Skill discovery/load admission (A09).
   *
   * Environment-specific material is visible only when the entry belongs to the resolved *and
   * enabled* environment. Checking `snapshot.environment` alone was not enough: a disabled
   * environment still resolves a fallback environment, and an entry for a non-enabled environment
   * stayed discoverable and loadable (`list`/`get` both returned the Web body after the Web
   * environment was disabled). Both checks live here so the two provider methods cannot drift.
   */
  function skillVisible(entry, snapshot) {
    if (entry.testOnly && !allowTestEnvironments) return false;
    if (entry.environment === null) return true;
    if (!snapshot || snapshot.environment !== entry.environment) return false;
    const enabled = Array.isArray(snapshot.enabledEnvironments)
      && snapshot.enabledEnvironments.includes(entry.environment);
    return enabled;
  }

  async function dispose() {
    if (disposed) return;
    disposed = true;
    if (webFaces) {
      try { await webFaces.targetAdapter.dispose(); } catch { /* best effort */ }
      try { await webFaces.capabilityAdapter.dispose(); } catch { /* best effort */ }
      try { await webFaces.provider.dispose(); } catch { /* best effort */ }
      webFaces = null;
    }
    if (fakeEnvironment) {
      try { await fakeEnvironment.dispose(); } catch { /* best effort */ }
    }
    try { await adapterRegistry.dispose(); } catch { /* best effort */ }
    try { configStore.dispose(); } catch { /* best effort */ }
  }

  return {
    configStore,
    adapterRegistry,
    // Lazy Web faces: null until the Web environment is actually used (A14).
    get webTargetAdapter() { return webFaces?.targetAdapter ?? null; },
    get webCapabilityAdapter() { return webFaces?.capabilityAdapter ?? null; },
    get webP0Provider() { return webFaces?.provider ?? null; },
    ensureWebRegistered,
    prepareWeb,
    allowTestEnvironments,
    snapshotForAgent,
    snapshotForScope,
    toolAdmitted,
    assertToolAllowed,
    executionClassFor,
    invokeTool,
    p0Call,
    handleHttp,
    assertGuiAllowed,
    capabilitiesBlock,
    onConfigChange,
    admissibleToolNames,
    declarableToolNames,
    agentForScope,
    isNeutralTool,
    registerSkills,
    readinessFor,
    dispose,
    // Exposed for tests/diagnostics only.
    _internals: { configDirectory, SKILL_DEFINITIONS, FAKE_TOOL },
  };
}
