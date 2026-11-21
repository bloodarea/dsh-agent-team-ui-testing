/**
 * Composition root for the cross-environment foundation (M2/M3).
 *
 * This module owns the environment-neutral control plane: authoritative config, adapter registry,
 * tool admission, per-execution adapter invocation, readiness aggregation, Skill discovery and the
 * `/config` HTTP surface.
 *
 * Dependency direction: this module imports `core/` only. Environment implementations (Web today,
 * another platform later) are not imported here — the composition root receives a registration
 * directory (`core/environments.js`) and resolves every platform question through it: adapters,
 * the P0 provider, the operation table, the provider gate, per-provider readiness and the
 * capability probe. A Host built this way cannot read a platform runtime's internals, and adding
 * an environment never requires editing this file.
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
  KNOWN_ENVIRONMENTS,
  READINESS_STATUS,
  SUPPORT,
  axis,
  createReadinessReport,
  environmentCatalog,
  isPlannedEnvironment,
  resolveSnapshot,
  workspaceKeyOf,
} from '../core/index.js';
import { createEnvironmentDirectory } from '../core/environments.js';

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
const ENV_NEUTRAL_TOOLS = Object.freeze([
  // One discovery/selection entry plus the two diagnostics. All three stay registered in every
  // environment (including a disabled one) so "which capability groups exist, why is this refused,
  // how do I get the rest of the tools" is always answerable without a page or a model round trip.
  'browser_tools', 'browser_state', 'browser_capabilities',
]);

function isNeutralTool(name) {
  return ENV_NEUTRAL_TOOLS.includes(name);
}

/**
 * Which environment declares this tool, and under which capability?
 *
 * The operation table belongs to the environment's own registration entry ("each entry provides
 * capabilities and tool descriptions"), so the Host asks the directory instead of importing a
 * platform module or keeping a second copy of the Web table.
 */
function capabilityFromEnvironments(name, environments) {
  for (const entry of environments.entries()) {
    const operation = entry.operations ? entry.operations[name] : undefined;
    if (operation === undefined) continue;
    if (typeof operation === 'string') return operation;
    return operation?.capability ?? null;
  }
  return null;
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
  webTabsLimits = {},
  env = process.env,
  // Environment registration directory. The composition root assembles it by environment id; the
  // public control plane only resolves entries from it. An empty directory means "no environment
  // implementation is wired", which every lookup below reports as unsupported instead of guessing.
  environments = null,
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
   * Environment implementations are resolved by id from the injected registration directory
   * (plan §Host 负责编排，环境实现负责执行): the public Host knows *what* an environment is and
   * *when* to build it, never *how* it is built.
   *
   * An `eager` entry (deterministic fixtures: no process, no socket) registers its adapters at
   * construction; every other environment appears on its first real demand (A14), and `dispose()`
   * handles the never-instantiated case.
   */
  const environmentDirectory = environments ?? createEnvironmentDirectory({ log });

  function registerEnvironmentAdapters(environmentId) {
    const id = String(environmentId);
    const known = environmentDirectory.peek(id);
    if (known) return known;
    const entry = environmentDirectory.entry(id);
    if (!entry) return null;
    // Test-only environments follow the same allowance that gates the test tools.
    if (entry.testOnly && !allowTestEnvironments) return null;
    let record;
    try {
      record = environmentDirectory.instance(id, {
        // Late-bound host services: the P0 dispatch entry resolves environments itself, and the
        // page-entry lookup belongs to the Host's runtime registry.
        p0Call: (request) => p0Call(request),
        findEntryForSnapshot: (snapshot) => findEntryForSnapshot(snapshot),
      });
    } catch (error) {
      log(`ui-testing: environment ${id} unavailable: ` + String((error && error.message) || error));
      return null;
    }
    if (!record) return null;
    if (record.targetAdapter) adapterRegistry.registerTargetAdapter(record.targetAdapter);
    if (record.capabilityAdapter) adapterRegistry.registerCapabilityAdapter(record.capabilityAdapter);
    if (record.p0Provider) adapterRegistry.registerP0Provider(record.p0Provider);
    return record;
  }

  for (const eagerEntry of environmentDirectory.entries()) {
    if (eagerEntry.eager === true) registerEnvironmentAdapters(eagerEntry.id);
  }

  /** The Web implementation record, or null while the Web environment has not been demanded. */
  function webRecord() {
    return environmentDirectory.peek(ENVIRONMENTS.WEB);
  }

  /** The capability a tool is declared under, from whichever environment declares it. */
  const capabilityForTool = (name) => {
    if (isNeutralTool(name)) return null;
    if (name === FAKE_TOOL) return 'fake.t1';
    return capabilityFromEnvironments(name, environmentDirectory);
  };

  /** The registration entry of the environment a snapshot resolved to (null when not wired). */
  function environmentEntryFor(snapshot) {
    const id = snapshot && typeof snapshot.environment === 'string' ? snapshot.environment : null;
    return id ? environmentDirectory.entry(id) : null;
  }

  /**
   * Provider/target gate of the resolved environment.
   *
   * Only the environment knows which of its providers may execute right now, so the Host asks the
   * entry. An environment that declares no gate is never blocked by one.
   */
  function driverFor(snapshot) {
    const entry = environmentEntryFor(snapshot);
    if (!entry || typeof entry.driver !== 'function') {
      return { provider: snapshot?.provider ?? null, blocked: null };
    }
    try {
      return entry.driver(snapshot) ?? { provider: snapshot?.provider ?? null, blocked: null };
    } catch (error) {
      return { provider: snapshot?.provider ?? null, blocked: 'driver-unavailable', error: String((error && error.message) || error) };
    }
  }

  /** Ensure the Web faces exist. Returns null when the Web environment is not in play. */
  function ensureWebRegistered() {
    return registerEnvironmentAdapters(ENVIRONMENTS.WEB);
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

  /** Bring up the implementation of whatever environment a snapshot resolved to (A14). */
  function prepareEnvironment(snapshot) {
    const id = snapshot && typeof snapshot.environment === 'string' ? snapshot.environment : null;
    return id ? registerEnvironmentAdapters(id) : null;
  }

  /** Compatibility alias: the Web environment is the one this bundle ships first. */
  function prepareWeb(snapshot) {
    if (!snapshotNeedsWeb(snapshot)) return null;
    return registerEnvironmentAdapters(ENVIRONMENTS.WEB);
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

  function toolAdmitted(agent, name, snapshotOverride = null) {
    // Environment-neutral diagnostics answer "what is here / why was it refused"; they must stay
    // available in every environment, including a disabled one (they never start a target).
    if (isNeutralTool(name)) return true;
    const capability = capabilityForTool(name);
    if (capability === null) return false;
    // `snapshotOverride` 是诊断的用法：那次运行已经为"要诊断的环境"冻结了一份快照，
    // 再按 agent 重新解析会得到面板的视图选择（可能是空态），把工具面判成不可用。
    const snapshot = snapshotOverride ?? snapshotForAgent(agent);
    const environmentEnabled = Array.isArray(snapshot.enabledEnvironments)
      && snapshot.enabledEnvironments.includes(snapshot.environment);
    if (!environmentEnabled) return false;
    if (!Array.isArray(snapshot.capabilities) || !snapshot.capabilities.includes(capability)) return false;
    if (name === FAKE_TOOL) return snapshot.environment === ENVIRONMENTS.FAKE;
    // §4.3: admission also answers the provider question. A disabled selection, an unknown name or
    // a provider without a driver refuses the environment's operations (never a silent swap).
    const entry = environmentEntryFor(snapshot);
    if (entry && typeof entry.admitTool === 'function') {
      const verdict = entry.admitTool(name, snapshot);
      if (verdict === false) return false;
    }
    return true;
  }

  /** The provider/execution identity block exposed by /config, /config/select and capabilities. */
  function resolvedBlock(snapshot) {
    return {
      environment: snapshot.environment,
      // 面板组合框显示的选择（环境 id 或默认视图）。environment 是它被接受后的结果。
      view: snapshot.view ?? snapshot.environment,
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
   * Tool names to *register* — the declaration ceiling (A08).
   *
   * Current installed hosts (verified on 0.2.2-rc.3, `LlmAdapter.stream` request capture plus
   * `request/header` events) recompute `when` for every model step, send only the admitted
   * definitions, and dispatch with that same step set. A `when` that returns false therefore does
   * remove the tool from the request and makes a forced call fail with `UNKNOWN_TOOL`; the older
   * note here (measured on 2026-11-07) described a build that ignored step admission and must not
   * be used to justify registration churn.
   *
   * Registration still keeps the environment ceiling: a disabled environment's tools are not
   * registered at all, so no agent of any environment can ever receive them. Which *registered*
   * tools a particular agent's step actually receives is decided per step by the plugin's own
   * disclosure selection (`integration/tool-disclosure.js`) inside the same `when`.
   */
  function declarableToolNames() {
    const names = new Set(ENV_NEUTRAL_TOOLS);
    const enabled = enabledEnvironmentUnion();
    // Each enabled environment contributes its own operation table. A platform whose surface is
    // currently unavailable (e.g. Web with no implemented provider enabled) declares nothing, so a
    // disabled surface never leaks tool names into a request.
    const config = configStore.getConfig();
    for (const environmentId of enabled) {
      const entry = environmentDirectory.entry(environmentId);
      if (!entry) continue;
      if (entry.testOnly && !allowTestEnvironments) continue;
      if (typeof entry.surfaceAvailable === 'function') {
        let available = false;
        try {
          available = entry.surfaceAvailable({ config, snapshot: null }) === true;
        } catch {
          available = false;
        }
        if (!available) continue;
      }
      for (const name of Object.keys(entry.operations ?? {})) names.add(name);
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
  function admissibleToolNames(agent = null, snapshotOverride = null) {
    const names = new Set();
    for (const name of declarableToolNames()) {
      if (toolAdmitted(agent, name, snapshotOverride)) names.add(name);
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
    registerEnvironmentAdapters(snapshot.environment);
    // §4.4 provider gate for the P0 surface: a disabled / unknown / unimplemented provider refuses
    // the call instead of being answered by whichever browser happens to be running.
    const driver = driverFor(snapshot);
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
      const classForCall = executionClass || executionClassFor(name, args) || 'page';
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

  /** Target lifecycle dispatch; P0-E remains projection/lease only. Called inside invokeTool. */
  async function invokeTabs(args, exec = {}) {
    const snapshot = snapshotForAgent(exec.agent);
    assertToolAllowed(exec.agent, 'browser_tabs');
    prepareWeb(snapshot);
    const { targetAdapter } = adapterRegistry.resolve(snapshot);
    if (typeof targetAdapter.tabs?.invoke !== 'function') {
      throw new BrowserError(ERROR_CODES.CAPABILITY_UNSUPPORTED,
        `环境 ${snapshot.environment} 没有 TargetTabs 服务`, { environment: snapshot.environment });
    }
    return targetAdapter.tabs.invoke(args, exec);
  }

  function executionClassFor(name, args) {
    if (name === FAKE_TOOL) return 'page';
    // The execution class is part of the environment's tool description (queue/lease/ensure
    // decisions differ per platform), so it is asked of the entry that declares the tool.
    const snapshot = snapshotForAgent(null);
    const entry = environmentEntryFor(snapshot);
    if (entry && typeof entry.executionClassFor === 'function') {
      const declared = entry.executionClassFor(name, args);
      if (declared) return declared;
      return null;
    }
    return null;
  }

  /**
   * 会话所属工作区的键（用于视图选择的继承与隔离）。
   *
   * GUI 的 scope 只有 sessionId，没有工作区身份；这里按宿主自己的服务问一次：工作区注册表里
   * `sessionIds` 包含这个会话的那个工作区最直接，其次用会话头里的 cwd 归一到同一个键。
   * 拿不到就返回 null——那就只按会话持久化，不猜一个工作区出来。
   */
  function sessionWorkspaceKey(sessionId) {
    if (typeof sessionId !== 'string' || !sessionId) return null;
    try {
      const registryService = typeof ctx?.get === 'function' ? ctx.get('workspaceRegistry') : null;
      if (registryService && typeof registryService.list === 'function') {
        const list = registryService.list();
        if (Array.isArray(list)) {
          const match = list.find((workspace) => workspace && typeof workspace.id === 'string'
            && Array.isArray(workspace.sessionIds) && workspace.sessionIds.includes(sessionId));
          if (match) return `workspace:${match.id}`;
        }
      }
    } catch { /* fall through to the cwd form */ }
    try {
      const sessions = typeof ctx?.get === 'function' ? ctx.get('sessions') : null;
      const session = sessions && typeof sessions.get === 'function' ? sessions.get(sessionId) : null;
      const cwd = session && session.header && typeof session.header.cwd === 'string' ? session.header.cwd : null;
      if (cwd) {
        const key = workspaceKeyOf({ cwd });
        return typeof key === 'string' && key ? key : null;
      }
    } catch { /* no workspace identity available */ }
    return null;
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
   * 一个**已绑定到具体页面**的请求（binding / recent）属于哪个会话。
   *
   * 面板的多数写请求都不带会话身份：锁/关闭/导航按标签自己的 runtimeId 发 binding，新建与切换
   * 按 recent 发。这类请求指向的是**一个已经存在的页面**，所以它的环境归属应当看"这个页面属于谁"
   * ——entry 的 `rootSessionId`——而不是"整机当前的默认视图"。
   *
   * 读不到就直接返回 null：调用方退回全局快照，绝不猜一个会话来放行。
   */
  function sessionIdForBoundEntry(scopeRequest) {
    if (!scopeRequest) return null;
    try {
      if (scopeRequest.mode === 'binding') {
        const entry = typeof registry?.findByRuntimeId === 'function'
          ? registry.findByRuntimeId(scopeRequest.runtimeId)
          : null;
        return entry && typeof entry.rootSessionId === 'string' && entry.rootSessionId ? entry.rootSessionId : null;
      }
      if (scopeRequest.mode === 'recent') {
        const entry = typeof registry?.recentEntry === 'function'
          ? registry.recentEntry(scopeRequest.rootSessionId)
          : null;
        return entry && typeof entry.rootSessionId === 'string' && entry.rootSessionId ? entry.rootSessionId : null;
      }
    } catch {
      // A registry lookup fault is not evidence of permission: fall back to the global snapshot.
    }
    return null;
  }

  /**
   * The scope a GUI write is admitted against.
   *
   *   session                 → that session's view chain (unchanged);
   *   binding / recent        → the owning session of the bound page, so a Web page stays writable
   *                             even when the *host* default view is 3D or the empty view;
   *   legacy / unresolved      → the global snapshot (historical behaviour, fail-closed on doubt).
   */
  function admissionScopeFor(scopeRequest) {
    if (!scopeRequest) return null;
    if (scopeRequest.mode === 'session') return resolveRequestScope(scopeRequest);
    const owner = sessionIdForBoundEntry(scopeRequest);
    if (owner) return { id: owner, kind: 'session', workspaceId: null, cwd: scopeRequest.cwd };
    return null;
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
    // 视图行（默认视图）不是目标环境：就绪/诊断面不为它造一栏。
    const known = Object.keys(KNOWN_ENVIRONMENTS).filter((id) => KNOWN_ENVIRONMENTS[id].kind !== 'view');
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
    // axes stay as the summary the earlier pages already rely on. Which providers exist, and how
    // to probe them, is the environment's own knowledge (`entry.providerReadiness`).
    for (const environment of environments) {
      const registration = environmentDirectory.entry(environment.id);
      if (!registration || typeof registration.providerReadiness !== 'function') continue;
      const entryConfig = isPlainObject(config.global?.environments)
        ? config.global.environments[environment.id] ?? null
        : null;
      try {
        environment.providers = registration.providerReadiness({
          snapshot,
          entryConfig,
          checkedAt,
          axes: environment.axes,
        });
      } catch (error) {
        log(`ui-testing: provider readiness for ${environment.id} unavailable: ` + String((error && error.message) || error));
      }
    }
    return { checkedAt, configRevision: snapshot.revision, environments };
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
      // Read-only metadata, never a write target: ids, display names and implementation status for
      // every environment this Host knows. Clients derive their selector/settings groups from it
      // instead of keeping a list of their own (that is how a panel ends up announcing ids the Host
      // rejects). Filtered by nothing: `testOnly` is flagged so each surface can decide.
      catalog: environmentCatalog(),
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
          ? configStore.resolveForScope({ ...scope, workspaceKey: sessionWorkspaceKey(scope.id) })
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
            const meta = KNOWN_ENVIRONMENTS[environment] || {};
            if (entry.enabled === false) nextEnabled.delete(environment);
            else if (entry.enabled === true && !meta.planned && meta.enableable !== false) nextEnabled.add(environment);
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
        if (body.view !== undefined && (typeof body.view !== 'string' || body.view.length === 0)) {
          throw new AdapterError(ERROR_CODES.CONFIG_INVALID, 'view must be a non-empty string', { field: 'view' });
        }
        if (body.view !== undefined && scope === 'global') {
          throw new AdapterError(ERROR_CODES.CONFIG_INVALID, 'global selection cannot set a session/workspace view', {
            field: 'view',
          });
        }
        const written = configStore.select({
          expectedRevision: body.expectedRevision,
          scope,
          view: body.view,
          environment: body.environment,
          targetId: body.targetId,
          agentId: scope === 'session' ? requestScope.id : undefined,
          workspaceKey: requestScope.workspaceId
            ? `workspace:${requestScope.workspaceId}`
            : (scope === 'session' ? sessionWorkspaceKey(requestScope.id) : undefined) ?? undefined,
          cwd: requestScope.cwd,
        });
        const snapshot = scope === 'session'
          ? configStore.resolveForScope({ ...requestScope, workspaceKey: sessionWorkspaceKey(requestScope.id) })
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

  /**
   * GUI/legacy page-write guard: diagnostics stay readable, writes follow the same config.
   *
   * The scope matters. A binding/recent request names an *existing page*, so it is admitted against
   * the view chain of the session that owns that page (`admissionScopeFor`). Reading the global
   * snapshot instead made every panel write that does not carry a session id -- the 保活锁 lock,
   * navigate, input, reload, viewport -- depend on the host's default view, so a host whose default
   * view was 3D or the empty view refused writes on a perfectly healthy Web page.
   */
  function assertGuiAllowed(scopeRequest) {
    const admissionScope = admissionScopeFor(scopeRequest);
    const snapshot = admissionScope
      ? configStore.resolveForScope(admissionScope)
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
        registration: 'environment-ceiling',
        environment: snapshot.environment,
        sessionEnvironment: snapshot.environment,
        registeredTools: registered,
        registeredCount: registered.length,
        admittedTools: admitted,
        admittedCount: admitted.length,
        isolated,
        // Neither list is the model-request payload: `registeredTools` is the registration
        // ceiling, `admittedTools` is environment admission for the resolved scope, and the
        // per-Agent progressive-disclosure selection is applied per step in the `when` condition.
        // Read `browser_tools status`/`browser_capabilities.disclosure` for that selection, and the
        // provider request itself for what was actually sent.
        note: '注册面 = 当前环境允许注册的工具（含发现与诊断）；admittedTools = 该作用域的环境准入集合。'
          + '两者都不是模型请求的实际发送列表：逐 Agent 的披露选择在本步 when 中应用，'
          + '实际发送内容以 provider 请求为准。',
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
    // Implementation instances are released through the directory so the Host never has to know
    // which objects an environment created.
    try { await environmentDirectory.dispose(); } catch { /* best effort */ }
    try { await adapterRegistry.dispose(); } catch { /* best effort */ }
    try { configStore.dispose(); } catch { /* best effort */ }
  }

  return {
    configStore,
    adapterRegistry,
    // Environment registration directory (diagnostics read it; tests assert laziness on it).
    environments: environmentDirectory,
    // Lazy Web faces: null until the Web environment is actually used (A14).
    get webTargetAdapter() { return webRecord()?.targetAdapter ?? null; },
    get webCapabilityAdapter() { return webRecord()?.capabilityAdapter ?? null; },
    get webP0Provider() { return webRecord()?.p0Provider ?? null; },
    ensureWebRegistered,
    prepareEnvironment,
    prepareWeb,
    driverFor,
    allowTestEnvironments,
    snapshotForAgent,
    snapshotForScope,
    isViewEnabled: (id) => configStore.getConfig().global.environments[id]?.enabled === true,
    /**
     * Per-provider gate for a view-only surface (3D/Blender). The environment switch alone is not
     * enough once an environment has a provider axis: the user can keep the master switch on and
     * turn a single runtime off, so the frame route asks both questions.
     */
    isProviderEnabled: (id, provider) => {
      const entry = configStore.getConfig().global.environments[id];
      const providers = entry && typeof entry.providers === 'object' && entry.providers ? entry.providers : null;
      const providerEntry = providers ? providers[provider] : null;
      return Boolean(providerEntry && providerEntry.enabled === true);
    },
    toolAdmitted,
    assertToolAllowed,
    executionClassFor,
    invokeTool,
    invokeTabs,
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
