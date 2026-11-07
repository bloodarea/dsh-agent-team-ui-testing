/**
 * Configuration model and resolution chain (M0 §4).
 *
 * One authoritative chain: global -> workspace -> session, resolved into an immutable snapshot
 * that every adapter consumes. Pure functions only; persistence lives in config-store.js.
 */
import {
  CONTRACT_VERSION,
  ENVIRONMENTS,
  ENVIRONMENT_CAPABILITIES,
  ERROR_CODES,
  WEB_PROVIDER_SUPPORT,
} from './contracts.js';
import { AdapterError } from './errors.js';
import { workspaceKeyOf } from './identity.js';

/** Persisted config schema version. */
export const CONFIG_VERSION = 1;

/**
 * Web *runtime providers* (the browser that actually executes): one target environment (`web`),
 * one provider per selection. This is a different axis from `environment` and from the P0
 * `P0Provider` class — never conflate the names (see docs/internal/web-runtime-provider-contract.md §4.2).
 */
export const WEB_PROVIDERS = Object.freeze({
  CHROME: 'chrome',
  EDGE: 'edge',
  FIREFOX: 'firefox',
});

/** Known provider ids, in report order. Anything else is not a provider name. */
export const WEB_PROVIDER_IDS = Object.freeze([
  WEB_PROVIDERS.CHROME,
  WEB_PROVIDERS.EDGE,
  WEB_PROVIDERS.FIREFOX,
]);

/** Provider used when a legacy config has no `provider` field at all (config v1 compatibility). */
export const DEFAULT_WEB_PROVIDER = WEB_PROVIDERS.CHROME;

/** Engineering support for one provider id (`supported|pending|unsupported`, null when unknown). */
export function webProviderSupport(provider) {
  return Object.hasOwn(WEB_PROVIDER_SUPPORT, provider) ? WEB_PROVIDER_SUPPORT[provider] : null;
}

/**
 * Providers the execution layer can currently drive — **derived** from `WEB_PROVIDER_SUPPORT`, so the
 * config layer, registration, readiness and execution can never disagree. `edge` is `pending` today:
 * its switch is storable, but it does not count as implemented and never executes.
 */
export const IMPLEMENTED_WEB_PROVIDERS = Object.freeze(
  WEB_PROVIDER_IDS.filter((provider) => webProviderSupport(provider) === 'supported'),
);

/** True when a driver exists for this provider id. */
export function isImplementedWebProvider(provider) {
  return webProviderSupport(provider) === 'supported';
}

/**
 * Known environment metadata. `planned` environments are placeholders: they may be displayed but
 * never enabled or selected in v1.
 */
export const KNOWN_ENVIRONMENTS = Object.freeze({
  [ENVIRONMENTS.WEB]: Object.freeze({
    environment: ENVIRONMENTS.WEB,
    status: 'supported',
    testOnly: false,
    planned: false,
  }),
  [ENVIRONMENTS.FAKE]: Object.freeze({
    environment: ENVIRONMENTS.FAKE,
    status: 'supported',
    testOnly: true,
    planned: false,
  }),
  [ENVIRONMENTS.LINUX]: Object.freeze({
    environment: ENVIRONMENTS.LINUX,
    status: 'planned',
    testOnly: false,
    planned: true,
  }),
  [ENVIRONMENTS.ANDROID]: Object.freeze({
    environment: ENVIRONMENTS.ANDROID,
    status: 'planned',
    testOnly: false,
    planned: true,
  }),
  [ENVIRONMENTS.MINIPROGRAM]: Object.freeze({
    environment: ENVIRONMENTS.MINIPROGRAM,
    status: 'planned',
    testOnly: false,
    planned: true,
  }),
});

const PLANNED_ENVIRONMENTS = new Set(
  Object.values(KNOWN_ENVIRONMENTS).filter((meta) => meta.planned).map((meta) => meta.environment),
);

function deepFreeze(value) {
  if (value !== null && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value)) deepFreeze(child);
  }
  return value;
}

function clone(value) {
  return structuredClone(value);
}

function isPlainObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function invalid(message, details) {
  return new AdapterError(ERROR_CODES.CONFIG_INVALID, message, { details });
}

function assertPlainObject(value, field) {
  if (!isPlainObject(value)) throw invalid(`${field} must be an object`, { field });
  return value;
}

function assertRevision(value, field = 'revision') {
  if (!Number.isInteger(value) || value < 0) {
    throw invalid(`${field} must be a non-negative integer`, { field, value: String(value) });
  }
  return value;
}

/**
 * Per-provider switches for a fresh web environment entry: chrome on, the others off, and no
 * second copy of the "which providers are enabled" list (it is always derived).
 */
function defaultWebProviders() {
  return {
    [WEB_PROVIDERS.CHROME]: { enabled: true },
    [WEB_PROVIDERS.EDGE]: { enabled: false },
    [WEB_PROVIDERS.FIREFOX]: { enabled: false },
  };
}

/** Default config: web is the only enabled environment, chrome the only enabled provider. */
export const DEFAULT_CONFIG = deepFreeze({
  version: CONFIG_VERSION,
  revision: 0,
  global: {
    environment: ENVIRONMENTS.WEB,
    enabledEnvironments: [ENVIRONMENTS.WEB],
    environments: {
      [ENVIRONMENTS.WEB]: {
        enabled: true,
        targetId: null,
        provider: DEFAULT_WEB_PROVIDER,
        providers: {
          [WEB_PROVIDERS.CHROME]: { enabled: true },
          [WEB_PROVIDERS.EDGE]: { enabled: false },
          [WEB_PROVIDERS.FIREFOX]: { enabled: false },
        },
      },
      [ENVIRONMENTS.FAKE]: { enabled: false, targetId: null },
    },
  },
  workspaces: {},
  sessions: {},
});

function defaultEnvironmentEntry(environment) {
  const entry = {
    enabled: environment === ENVIRONMENTS.WEB,
    targetId: null,
  };
  if (environment === ENVIRONMENTS.WEB) {
    entry.provider = DEFAULT_WEB_PROVIDER;
    entry.providers = defaultWebProviders();
  }
  return entry;
}

/** Merge provider maps per provider id: sibling providers are never replaced wholesale. */
function mergeProviderMaps(base, over) {
  const out = {};
  for (const [provider, entry] of Object.entries(base ?? {})) out[provider] = { ...entry };
  for (const [provider, entry] of Object.entries(over ?? {})) {
    out[provider] = { ...(out[provider] ?? {}), ...entry };
  }
  return out;
}

function normalizeEnvironmentName(environment, field, { allowTestEnvironments = true } = {}) {
  if (typeof environment !== 'string' || environment.length === 0) {
    throw invalid(`${field} must be a non-empty string`, { field });
  }
  const meta = KNOWN_ENVIRONMENTS[environment];
  if (!meta) throw invalid(`unknown environment: ${environment}`, { field, environment });
  if (meta.planned) {
    throw invalid(`environment ${environment} is planned and cannot be selected in v1`, {
      field,
      environment,
    });
  }
  if (meta.testOnly && !allowTestEnvironments) {
    throw invalid(`environment ${environment} is test-only`, { field, environment });
  }
  return environment;
}

function normalizeEnabledEnvironments(list, field, options) {
  if (!Array.isArray(list)) throw invalid(`${field} must be an array`, { field });
  const out = [];
  for (const item of list) {
    const environment = normalizeEnvironmentName(item, field, options);
    if (!out.includes(environment)) out.push(environment);
  }
  return out;
}

/**
 * Validate a provider name.
 *
 * Write path (`strict`, i.e. every patch path): only chrome/edge/firefox are accepted, anything else
 * is CONFIG_INVALID with the offending field — never a silent fallback.
 *
 * Load path (`strict:false`): a *well-typed but unknown* name (e.g. `"safari"` written by a newer
 * version) is **kept verbatim**. Throwing here would make the store treat the whole file as corrupt,
 * replace it with defaults and discard every saved switch — far worse than carrying one unusable
 * selection. The snapshot then reports `source.rejectedProviderReason = 'unknown-provider'`, which
 * blocks execution instead of quietly switching browsers. A value that is not a non-empty string is
 * a structural error on both paths.
 */
function normalizeWebProviderName(value, field, { allowNull = false, strict = true } = {}) {
  if (allowNull && value === null) return null;
  if (typeof value !== 'string' || value.length === 0) {
    throw invalid(`unknown web provider: ${String(value)}`, {
      field,
      provider: value === undefined ? null : String(value),
      allowed: [...WEB_PROVIDER_IDS],
    });
  }
  if (WEB_PROVIDER_IDS.includes(value)) return value;
  if (strict) {
    throw invalid(`unknown web provider: ${value}`, {
      field,
      provider: value,
      allowed: [...WEB_PROVIDER_IDS],
    });
  }
  return value;
}

const PROVIDER_ENTRY_KEYS = new Set(['enabled', 'executable', 'connection']);

/**
 * One provider entry. `partial` keeps the patch sparse (missing key = unchanged); `strict` rejects
 * unknown keys instead of dropping them (write path).
 */
function normalizeProviderEntry(raw, field, { partial = false, strict = false } = {}) {
  const source = assertPlainObject(raw, field);
  if (strict) {
    for (const key of Object.keys(source)) {
      if (!PROVIDER_ENTRY_KEYS.has(key)) {
        throw invalid(`unknown provider patch key: ${field}.${key}`, { field: `${field}.${key}` });
      }
    }
  }
  const out = {};
  if (source.enabled !== undefined) {
    if (typeof source.enabled !== 'boolean') {
      throw invalid(`${field}.enabled must be a boolean`, { field: `${field}.enabled` });
    }
    out.enabled = source.enabled;
  }
  if (source.executable !== undefined) {
    if (source.executable !== null && (typeof source.executable !== 'string' || source.executable.length === 0)) {
      throw invalid(`${field}.executable must be a non-empty string or null`, {
        field: `${field}.executable`,
      });
    }
    out.executable = source.executable;
  }
  if (source.connection !== undefined) {
    out.connection = clone(assertPlainObject(source.connection, `${field}.connection`));
  }
  return out;
}

/** Provider sub-map: per-provider deep shape, unknown ids dropped (load) or rejected (patch). */
function normalizeProvidersMap(raw, field, { partial = false, strict = false } = {}) {
  const source = assertPlainObject(raw, field);
  const out = {};
  for (const [provider, entry] of Object.entries(source)) {
    if (!WEB_PROVIDER_IDS.includes(provider)) {
      if (strict) {
        throw invalid(`unknown web provider: ${provider}`, {
          field: `${field}.${provider}`,
          provider,
          allowed: [...WEB_PROVIDER_IDS],
        });
      }
      continue;
    }
    out[provider] = normalizeProviderEntry(entry, `${field}.${provider}`, { partial, strict });
  }
  return out;
}

function normalizeEnvironmentEntry(raw, environment, { partial = false, strict = false } = {}) {
  const field = `environments.${environment}`;
  const source = assertPlainObject(raw, field);
  const base = partial ? {} : defaultEnvironmentEntry(environment);
  const out = { ...base };
  if (source.enabled !== undefined) {
    if (typeof source.enabled !== 'boolean') {
      throw invalid(`${field}.enabled must be a boolean`, { field: `${field}.enabled` });
    }
    out.enabled = source.enabled;
  }
  if (source.targetId !== undefined) {
    if (source.targetId !== null && typeof source.targetId !== 'string') {
      throw invalid(`${field}.targetId must be a string or null`, { field: `${field}.targetId` });
    }
    out.targetId = source.targetId;
  }
  if (source.connection !== undefined) {
    out.connection = clone(assertPlainObject(source.connection, `${field}.connection`));
  }
  const webOnly = environment === ENVIRONMENTS.WEB;
  if (source.provider !== undefined) {
    if (!webOnly) {
      throw invalid(`${field}.provider is only supported for the web environment`, {
        field: `${field}.provider`,
      });
    }
    out.provider = normalizeWebProviderName(source.provider, `${field}.provider`, { strict });
  }
  if (source.providers !== undefined) {
    if (!webOnly) {
      throw invalid(`${field}.providers is only supported for the web environment`, {
        field: `${field}.providers`,
      });
    }
    const provided = normalizeProvidersMap(source.providers, `${field}.providers`, { partial, strict });
    out.providers = mergeProviderMaps(out.providers, provided);
  }
  return out;
}

function normalizeEnvironmentMap(raw, field, { partial = false, strict = false } = {}) {
  const source = assertPlainObject(raw, field);
  const out = {};
  for (const [environment, entry] of Object.entries(source)) {
    // Unknown and planned environments are dropped, not silently enabled.
    if (!Object.hasOwn(KNOWN_ENVIRONMENTS, environment)) continue;
    if (PLANNED_ENVIRONMENTS.has(environment)) continue;
    out[environment] = normalizeEnvironmentEntry(entry, environment, { partial, strict });
  }
  return out;
}

function normalizeGlobal(raw) {
  const source = assertPlainObject(raw, 'global');
  const environments = {
    [ENVIRONMENTS.WEB]: { ...defaultEnvironmentEntry(ENVIRONMENTS.WEB) },
    [ENVIRONMENTS.FAKE]: { ...defaultEnvironmentEntry(ENVIRONMENTS.FAKE) },
  };
  const provided = normalizeEnvironmentMap(source.environments ?? {}, 'global.environments');
  for (const [environment, entry] of Object.entries(provided)) {
    environments[environment] = { ...environments[environment], ...entry };
  }
  return {
    environment: source.environment === undefined
      ? ENVIRONMENTS.WEB
      : normalizeEnvironmentName(source.environment, 'global.environment'),
    enabledEnvironments: source.enabledEnvironments === undefined
      ? [ENVIRONMENTS.WEB]
      : normalizeEnabledEnvironments(source.enabledEnvironments, 'global.enabledEnvironments'),
    environments,
  };
}

function normalizeWorkspaceEntry(raw, key) {
  const source = assertPlainObject(raw, `workspaces.${key}`);
  const out = {};
  if (source.environment !== undefined) {
    out.environment = normalizeEnvironmentName(source.environment, `workspaces.${key}.environment`);
  }
  if (source.enabledEnvironments !== undefined) {
    out.enabledEnvironments = normalizeEnabledEnvironments(
      source.enabledEnvironments,
      `workspaces.${key}.enabledEnvironments`,
    );
  }
  if (source.environments !== undefined) {
    out.environments = normalizeEnvironmentMap(
      source.environments,
      `workspaces.${key}.environments`,
      { partial: true },
    );
  }
  if (source.targetId !== undefined) {
    if (source.targetId !== null && typeof source.targetId !== 'string') {
      throw invalid(`workspaces.${key}.targetId must be a string or null`, {
        field: `workspaces.${key}.targetId`,
      });
    }
    out.targetId = source.targetId;
  }
  return out;
}

function normalizeSessionEntry(raw, key) {
  const source = assertPlainObject(raw, `sessions.${key}`);
  const out = {};
  if (source.environment !== undefined) {
    out.environment = normalizeEnvironmentName(source.environment, `sessions.${key}.environment`);
  }
  if (source.targetId !== undefined) {
    if (source.targetId !== null && typeof source.targetId !== 'string') {
      throw invalid(`sessions.${key}.targetId must be a string or null`, {
        field: `sessions.${key}.targetId`,
      });
    }
    out.targetId = source.targetId;
  }
  if (source.parentSession !== undefined) {
    if (source.parentSession !== null && typeof source.parentSession !== 'string') {
      throw invalid(`sessions.${key}.parentSession must be a string or null`, {
        field: `sessions.${key}.parentSession`,
      });
    }
    out.parentSession = source.parentSession;
  }
  // Session-scoped provider selection (`null` clears it and re-inherits).
  if (source.webProvider !== undefined) {
    out.webProvider = normalizeWebProviderName(source.webProvider, `sessions.${key}.webProvider`, {
      allowNull: true,
      strict: false,
    });
  }
  return out;
}

/**
 * Fill defaults, drop unknown keys, and reject structurally invalid configs.
 *
 * @param {object|null|undefined} raw
 * @returns {object} a fresh mutable config object (never the frozen default instance)
 */
export function normalizeConfig(raw) {
  if (raw === undefined || raw === null) return clone(DEFAULT_CONFIG);
  const source = assertPlainObject(raw, 'config');
  if (source.version !== undefined && source.version !== CONFIG_VERSION) {
    throw invalid(`unsupported config version: ${String(source.version)}`, {
      field: 'version',
      version: source.version,
    });
  }
  const workspaces = {};
  const rawWorkspaces = source.workspaces === undefined
    ? {}
    : assertPlainObject(source.workspaces, 'workspaces');
  for (const [key, entry] of Object.entries(rawWorkspaces)) {
    const normalized = normalizeWorkspaceEntry(entry, key);
    if (Object.keys(normalized).length > 0) workspaces[key] = normalized;
  }

  const sessions = {};
  const rawSessions = source.sessions === undefined
    ? {}
    : assertPlainObject(source.sessions, 'sessions');
  for (const [key, entry] of Object.entries(rawSessions)) {
    const normalized = normalizeSessionEntry(entry, key);
    if (Object.keys(normalized).length > 0) sessions[key] = normalized;
  }

  return {
    version: CONFIG_VERSION,
    revision: source.revision === undefined ? 0 : assertRevision(source.revision),
    global: normalizeGlobal(source.global ?? {}),
    workspaces,
    sessions,
  };
}

const GLOBAL_PATCH_KEYS = new Set(['environment', 'enabledEnvironments', 'environments', 'targetId']);
const WORKSPACE_PATCH_KEYS = new Set(['environment', 'enabledEnvironments', 'environments', 'targetId']);
const SESSION_PATCH_KEYS = new Set(['environment', 'targetId', 'webProvider']);
const ENVIRONMENT_ENTRY_KEYS = new Set(['enabled', 'targetId', 'connection', 'provider', 'providers']);

function normalizePatchEnvironments(raw, field, options) {
  const source = assertPlainObject(raw, field);
  const out = {};
  for (const [environment, entry] of Object.entries(source)) {
    normalizeEnvironmentName(environment, field, options);
    const entrySource = assertPlainObject(entry, `${field}.${environment}`);
    for (const key of Object.keys(entrySource)) {
      if (!ENVIRONMENT_ENTRY_KEYS.has(key)) {
        throw invalid(`unknown environment patch key: ${field}.${environment}.${key}`, {
          field: `${field}.${environment}.${key}`,
        });
      }
    }
    out[environment] = normalizeEnvironmentEntry(entrySource, environment, { partial: true, strict: true });
  }
  return out;
}

/**
 * Validate and normalize a write patch.
 *
 * @param {{scope:'global'|'workspace'|'session', patch:object}} input
 * @param {{allowTestEnvironments?:boolean}} [options]
 * @returns {object} the normalized patch (unknown keys rejected, not silently dropped)
 */
export function validatePatch({ scope, patch } = {}, { allowTestEnvironments = false } = {}) {
  if (scope !== 'global' && scope !== 'workspace' && scope !== 'session') {
    throw invalid('patch scope must be global, workspace or session', { scope: String(scope) });
  }
  const source = assertPlainObject(patch, 'patch');
  const keys = Object.keys(source);
  if (keys.length === 0) throw invalid('patch must not be empty', { scope });

  const allowed = scope === 'session' ? SESSION_PATCH_KEYS : (scope === 'global' ? GLOBAL_PATCH_KEYS : WORKSPACE_PATCH_KEYS);
  for (const key of keys) {
    if (!allowed.has(key)) throw invalid(`unknown ${scope} patch key: ${key}`, { scope, key });
  }

  const options = { allowTestEnvironments };
  const out = {};
  if (source.environment !== undefined) {
    out.environment = normalizeEnvironmentName(source.environment, `${scope}.environment`, options);
  }
  if (source.enabledEnvironments !== undefined) {
    out.enabledEnvironments = normalizeEnabledEnvironments(
      source.enabledEnvironments,
      `${scope}.enabledEnvironments`,
      options,
    );
  }
  if (source.environments !== undefined) {
    out.environments = normalizePatchEnvironments(source.environments, `${scope}.environments`, options);
  }
  if (source.targetId !== undefined) {
    if (source.targetId !== null && typeof source.targetId !== 'string') {
      throw invalid(`${scope}.targetId must be a string or null`, { scope, field: 'targetId' });
    }
    out.targetId = source.targetId;
  }
  if (source.webProvider !== undefined) {
    out.webProvider = normalizeWebProviderName(source.webProvider, `${scope}.webProvider`, {
      allowNull: true,
    });
  }
  return out;
}

/**
 * Stable workspace key shared with runtime entries: `workspace:<id>` or `path:<sha256>`.
 * Legacy alias for `workspaceKeyOf({cwd})`; returns null for a missing cwd.
 */
export function workspaceKeyForCwd(cwd) {
  return workspaceKeyOf({ cwd });
}

/** Capability catalog for one environment; unknown/planned environments expose nothing. */
export function capabilitiesForEnvironment(environment) {
  const list = ENVIRONMENT_CAPABILITIES[environment];
  return Array.isArray(list) ? [...list] : [];
}

function agentSessionId(agent) {
  const candidate = agent?.id ?? agent?.sessionId;
  return typeof candidate === 'string' && candidate.length > 0 ? candidate : null;
}

/**
 * Resolve the effective config snapshot for one agent/workspace.
 *
 * Frozen total order: session own entry > parent's effective snapshot (following
 * `agent.session.header.parentSession`, depth <= 8, cycle-safe) > workspace > global. The parent
 * contributes its *effective* environment/target (already filtered by enabledEnvironments), not
 * its raw config entry.
 *
 * A selection outside `enabledEnvironments` is rejected and falls back to `global.environment`;
 * the rejected value is reported in `source.rejectedEnvironment` (never silently allowed).
 *
 * Web *provider* selection is an independent chain over the same scopes:
 * `session.webProvider > parent's effective provider > workspace.environments.web.provider >
 * global.environments.web.provider > "chrome"` (last step only for legacy configs without the
 * field). A disabled provider is **not** silently replaced: the selection is kept in
 * `snapshot.provider`, and `source.rejectedProvider` + `source.rejectedProviderReason` report that
 * it cannot execute (the execution layer turns that into ADAPTER_DISABLED). `firefox` is a legal
 * provider name that may be enabled, but has no driver: `providerConfig.implemented` is false and
 * the execution layer must refuse with ADAPTER_UNSUPPORTED. A name that is not a known provider at
 * all (`'safari'`, loaded from a newer config file) is preserved and reported as
 * `rejectedProviderReason: 'unknown-provider'` — never replaced by chrome.
 *
 * Malformed config degrades to defaults with `source.degraded=true` + `source.degradedReason`
 * instead of throwing. Only explicit invalid patches throw CONFIG_INVALID (validatePatch).
 *
 * @param {object} config
 * @param {{agent?:object, workspaceKey?:string|null}} [input]
 * @param {{allowTestEnvironments?:boolean}} [options]
 * @returns {{revision:number, environment:string, adapterId:string, provider:string|null,
 *   executionAdapterId:string, enabledProviders:string[], providerConfig:object|null,
 *   enabledEnvironments:string[], capabilities:string[], environmentConfig:object,
 *   targetId:string|null, source:{globalRevision:number, workspaceKey:string|null,
 *   sessionId:string|null, inheritedFrom:string|null, rejectedEnvironment:string|null,
 *   providerSource:string, inheritedProviderFrom:string|null, rejectedProvider:string|null,
 *   rejectedProviderReason:string|null, degraded:boolean, degradedReason:string|null}}}
 */
export function resolveSnapshot(config, { agent = null, workspaceKey = null } = {}, { allowTestEnvironments = false } = {}) {
  let normalized;
  let degraded = false;
  let degradedReason = null;
  try {
    normalized = normalizeConfig(config);
  } catch (error) {
    degraded = true;
    degradedReason = error instanceof AdapterError ? error.message : String(error?.message ?? error);
    normalized = normalizeConfig(DEFAULT_CONFIG);
  }

  const sessionId = agentSessionId(agent);
  const key = typeof workspaceKey === 'string' && workspaceKey.length > 0 ? workspaceKey : null;
  const workspace = key && Object.hasOwn(normalized.workspaces, key) ? normalized.workspaces[key] : null;

  const enabledSource = workspace?.enabledEnvironments ?? normalized.global.enabledEnvironments;
  const enabledEnvironments = enabledSource.filter((environment) => {
    const meta = KNOWN_ENVIRONMENTS[environment];
    if (!meta || meta.planned) return false;
    if (meta.testOnly && !allowTestEnvironments) return false;
    return true;
  });
  const enabledSet = new Set(enabledEnvironments);

  const selectable = (environment) => {
    const meta = KNOWN_ENVIRONMENTS[environment];
    if (!meta || meta.planned) return false;
    if (meta.testOnly && !allowTestEnvironments) return false;
    return true;
  };

  const applyEnabled = (environment) => {
    if (selectable(environment) && enabledSet.has(environment)) {
      return { environment, rejected: null };
    }
    let fallback;
    if (enabledSet.has(normalized.global.environment)) fallback = normalized.global.environment;
    else if (enabledEnvironments.length > 0) fallback = enabledEnvironments[0];
    else fallback = ENVIRONMENTS.WEB;
    return { environment: fallback, rejected: environment };
  };

  const workspaceTarget = (environment) => {
    const entryTarget = workspace?.environments?.[environment]?.targetId;
    if (entryTarget !== undefined) return entryTarget;
    if (workspace?.targetId !== undefined && workspace.environment === environment) {
      return workspace.targetId;
    }
    return undefined;
  };
  const globalTarget = (environment) => normalized.global.environments[environment]?.targetId;

  // `provider` is web-only: workspace/global entries for other environments have no such key.
  const workspaceProvider = () => workspace?.environments?.[ENVIRONMENTS.WEB]?.provider;
  const globalProvider = () => normalized.global.environments?.[ENVIRONMENTS.WEB]?.provider;

  const selectForSession = (currentId, agentParent, depth, seen) => {
    const own = Object.hasOwn(normalized.sessions, currentId) ? normalized.sessions[currentId] : null;
    const ownParent = isPlainObject(own)
      && typeof own.parentSession === 'string'
      && own.parentSession.length > 0
      ? own.parentSession
      : null;
    const parentId = depth === 0 ? (agentParent ?? ownParent) : ownParent;
    let parent = null;
    if (parentId !== null && depth < 8 && !seen.has(parentId)) {
      const nextSeen = new Set(seen);
      nextSeen.add(parentId);
      parent = selectForSession(parentId, null, depth + 1, nextSeen);
    }

    let environment;
    let environmentSource;
    if (isPlainObject(own) && own.environment !== undefined) {
      environment = own.environment;
      environmentSource = currentId;
    } else if (parent !== null) {
      environment = parent.environment;
      environmentSource = parent.environmentSource;
    } else if (workspace?.environment !== undefined) {
      environment = workspace.environment;
      environmentSource = 'workspace';
    } else {
      environment = normalized.global.environment;
      environmentSource = 'global';
    }

    // Independent provider chain: own webProvider > parent's effective provider > workspace >
    // global > "chrome". Normalization already materializes chrome for a legacy config, so the last
    // step is a defensive default rather than a normally observable source.
    let provider;
    let providerSource;
    if (isPlainObject(own) && own.webProvider !== undefined && own.webProvider !== null) {
      provider = own.webProvider;
      providerSource = currentId;
    } else if (parent !== null) {
      provider = parent.provider;
      providerSource = parent.providerSource;
    } else if (workspaceProvider() !== undefined) {
      provider = workspaceProvider();
      providerSource = 'workspace';
    } else if (globalProvider() !== undefined) {
      provider = globalProvider();
      providerSource = 'global';
    } else {
      provider = DEFAULT_WEB_PROVIDER;
      providerSource = 'default';
    }

    const effective = applyEnabled(environment);
    const rejectedEnvironment = effective.rejected !== null
      ? effective.rejected
      : (isPlainObject(own) && own.environment !== undefined ? null : (parent?.rejectedEnvironment ?? null));

    let targetId;
    const ownEnvironmentApplied = !(isPlainObject(own) && own.environment !== undefined)
      || own.environment === effective.environment;
    if (isPlainObject(own) && own.targetId !== undefined && ownEnvironmentApplied) {
      targetId = own.targetId;
    } else if (parent !== null && parent.environment === effective.environment) {
      targetId = parent.targetId;
    } else {
      const workspaceValue = workspaceTarget(effective.environment);
      if (workspaceValue !== undefined) {
        targetId = workspaceValue;
      } else {
        const globalValue = globalTarget(effective.environment);
        targetId = globalValue !== undefined ? globalValue : null;
      }
    }

    return {
      environment: effective.environment,
      environmentSource,
      rejectedEnvironment,
      provider,
      providerSource,
      targetId,
    };
  };

  let selection;
  if (sessionId !== null) {
    const agentParent = typeof agent?.session?.header?.parentSession === 'string'
      && agent.session.header.parentSession.length > 0
      ? agent.session.header.parentSession
      : null;
    selection = selectForSession(sessionId, agentParent, 0, new Set([sessionId]));
  } else {
    const environment = workspace?.environment ?? normalized.global.environment;
    const effective = applyEnabled(environment);
    const workspaceValue = workspaceTarget(effective.environment);
    const globalValue = globalTarget(effective.environment);
    let provider;
    let providerSource;
    if (workspaceProvider() !== undefined) {
      provider = workspaceProvider();
      providerSource = 'workspace';
    } else if (globalProvider() !== undefined) {
      provider = globalProvider();
      providerSource = 'global';
    } else {
      provider = DEFAULT_WEB_PROVIDER;
      providerSource = 'default';
    }
    selection = {
      environment: effective.environment,
      environmentSource: workspace?.environment !== undefined ? 'workspace' : 'global',
      rejectedEnvironment: effective.rejected,
      provider,
      providerSource,
      targetId: workspaceValue !== undefined ? workspaceValue : (globalValue !== undefined ? globalValue : null),
    };
  }

  const environment = selection.environment;
  const globalEnvironmentConfig = normalized.global.environments[environment] ?? {};
  const workspaceEnvironmentConfig = workspace?.environments?.[environment] ?? {};
  const environmentConfig = { ...globalEnvironmentConfig, ...workspaceEnvironmentConfig };
  if (globalEnvironmentConfig.connection !== undefined || workspaceEnvironmentConfig.connection !== undefined) {
    environmentConfig.connection = {
      ...(globalEnvironmentConfig.connection ?? {}),
      ...(workspaceEnvironmentConfig.connection ?? {}),
    };
  }
  if (globalEnvironmentConfig.providers !== undefined || workspaceEnvironmentConfig.providers !== undefined) {
    environmentConfig.providers = mergeProviderMaps(
      globalEnvironmentConfig.providers,
      workspaceEnvironmentConfig.providers,
    );
  }

  const inheritedFrom = sessionId !== null && selection.environmentSource === sessionId
    ? null
    : selection.environmentSource;
  const inheritedProviderFrom = sessionId !== null && selection.providerSource === sessionId
    ? null
    : selection.providerSource;

  // Web provider facts. `enabledProviders` is always derived from `providers.*.enabled` (no second
  // stored list); `provider` / `executionAdapterId` / `providerConfig` only exist for web.
  const enabledProviders = WEB_PROVIDER_IDS.filter(
    (id) => environmentConfig.providers?.[id]?.enabled === true,
  );
  const isWeb = environment === ENVIRONMENTS.WEB;
  const provider = isWeb ? selection.provider : null;
  const providerEntry = isWeb ? (environmentConfig.providers?.[provider] ?? {}) : {};
  // Precedence: total gate -> unknown provider name -> per-provider switch. Every non-null value
  // blocks execution; an unknown name is kept so nothing is silently swapped for chrome.
  const providerKnown = provider !== null && WEB_PROVIDER_IDS.includes(provider);
  let rejectedProviderReason = null;
  if (isWeb) {
    if (environmentConfig.enabled !== true) rejectedProviderReason = 'environment-disabled';
    else if (!providerKnown) rejectedProviderReason = 'unknown-provider';
    else if (providerEntry.enabled !== true) rejectedProviderReason = 'provider-disabled';
  }
  // Legacy env-level `connection` is a chrome-scoped compatibility field (§11): it is reported for
  // chrome only and never inherited by another provider.
  const legacyConnection = environmentConfig.connection ?? null;
  const providerConfig = isWeb
    ? {
      provider,
      // Canonical engineering support fact; `implemented` is its derived boolean, never a second truth.
      support: webProviderSupport(provider),
      enabled: providerEntry.enabled === true,
      executable: providerEntry.executable ?? null,
      connection: providerEntry.connection
        ?? (provider === WEB_PROVIDERS.CHROME ? legacyConnection : null),
      implemented: isImplementedWebProvider(provider),
    }
    : null;

  // A snapshot is a *step input*: it must be immutable, because admission, schema declaration,
  // Skill discovery and execution all read the same object (A11). Freezing here — not at each
  // call site — makes "one step, one version" enforceable instead of a convention.
  return deepFreeze({
    revision: normalized.revision,
    environment,
    adapterId: environment,
    provider,
    executionAdapterId: isWeb ? `${environment}-${provider}` : environment,
    enabledProviders,
    providerConfig,
    enabledEnvironments: [...enabledEnvironments],
    capabilities: capabilitiesForEnvironment(environment),
    environmentConfig,
    // Legacy `targetId` belongs to the chrome runtime: it must not leak into another provider.
    targetId: isWeb && provider !== WEB_PROVIDERS.CHROME ? null : (selection.targetId ?? null),
    source: {
      globalRevision: normalized.revision,
      workspaceKey: key,
      sessionId,
      inheritedFrom,
      rejectedEnvironment: selection.rejectedEnvironment,
      providerSource: selection.providerSource,
      inheritedProviderFrom,
      rejectedProvider: rejectedProviderReason === null ? null : provider,
      rejectedProviderReason,
      degraded,
      degradedReason,
    },
  });
}

export { CONTRACT_VERSION as CONFIG_CONTRACT_VERSION };
