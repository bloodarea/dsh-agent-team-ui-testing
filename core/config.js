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
} from './contracts.js';
import { AdapterError } from './errors.js';
import { workspaceKeyOf } from './identity.js';

/** Persisted config schema version. */
export const CONFIG_VERSION = 1;

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

/** Default config: web is the only enabled environment. */
export const DEFAULT_CONFIG = deepFreeze({
  version: CONFIG_VERSION,
  revision: 0,
  global: {
    environment: ENVIRONMENTS.WEB,
    enabledEnvironments: [ENVIRONMENTS.WEB],
    environments: {
      [ENVIRONMENTS.WEB]: { enabled: true, targetId: null },
      [ENVIRONMENTS.FAKE]: { enabled: false, targetId: null },
    },
  },
  workspaces: {},
  sessions: {},
});

function defaultEnvironmentEntry(environment) {
  return {
    enabled: environment === ENVIRONMENTS.WEB,
    targetId: null,
  };
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

function normalizeEnvironmentEntry(raw, environment, { partial = false } = {}) {
  const source = assertPlainObject(raw, `environments.${environment}`);
  const base = partial ? {} : defaultEnvironmentEntry(environment);
  const out = { ...base };
  if (source.enabled !== undefined) {
    if (typeof source.enabled !== 'boolean') {
      throw invalid(`environments.${environment}.enabled must be a boolean`, {
        field: `environments.${environment}.enabled`,
      });
    }
    out.enabled = source.enabled;
  }
  if (source.targetId !== undefined) {
    if (source.targetId !== null && typeof source.targetId !== 'string') {
      throw invalid(`environments.${environment}.targetId must be a string or null`, {
        field: `environments.${environment}.targetId`,
      });
    }
    out.targetId = source.targetId;
  }
  if (source.connection !== undefined) {
    out.connection = clone(assertPlainObject(source.connection, `environments.${environment}.connection`));
  }
  return out;
}

function normalizeEnvironmentMap(raw, field, { partial = false } = {}) {
  const source = assertPlainObject(raw, field);
  const out = {};
  for (const [environment, entry] of Object.entries(source)) {
    // Unknown and planned environments are dropped, not silently enabled.
    if (!Object.hasOwn(KNOWN_ENVIRONMENTS, environment)) continue;
    if (PLANNED_ENVIRONMENTS.has(environment)) continue;
    out[environment] = normalizeEnvironmentEntry(entry, environment, { partial });
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
const SESSION_PATCH_KEYS = new Set(['environment', 'targetId']);
const ENVIRONMENT_ENTRY_KEYS = new Set(['enabled', 'targetId', 'connection']);

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
    out[environment] = normalizeEnvironmentEntry(entrySource, environment, { partial: true });
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
 * Malformed config degrades to defaults with `source.degraded=true` + `source.degradedReason`
 * instead of throwing. Only explicit invalid patches throw CONFIG_INVALID (validatePatch).
 *
 * @param {object} config
 * @param {{agent?:object, workspaceKey?:string|null}} [input]
 * @param {{allowTestEnvironments?:boolean}} [options]
 * @returns {{revision:number, environment:string, adapterId:string,
 *   enabledEnvironments:string[], capabilities:string[], environmentConfig:object,
 *   targetId:string|null, source:{globalRevision:number, workspaceKey:string|null,
 *   sessionId:string|null, inheritedFrom:string|null, rejectedEnvironment:string|null,
 *   degraded:boolean, degradedReason:string|null}}}
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
    selection = {
      environment: effective.environment,
      environmentSource: workspace?.environment !== undefined ? 'workspace' : 'global',
      rejectedEnvironment: effective.rejected,
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

  const inheritedFrom = sessionId !== null && selection.environmentSource === sessionId
    ? null
    : selection.environmentSource;

  // A snapshot is a *step input*: it must be immutable, because admission, schema declaration,
  // Skill discovery and execution all read the same object (A11). Freezing here — not at each
  // call site — makes "one step, one version" enforceable instead of a convention.
  return deepFreeze({
    revision: normalized.revision,
    environment,
    adapterId: environment,
    enabledEnvironments: [...enabledEnvironments],
    capabilities: capabilitiesForEnvironment(environment),
    environmentConfig,
    targetId: selection.targetId ?? null,
    source: {
      globalRevision: normalized.revision,
      workspaceKey: key,
      sessionId,
      inheritedFrom,
      rejectedEnvironment: selection.rejectedEnvironment,
      degraded,
      degradedReason,
    },
  });
}

export { CONTRACT_VERSION as CONFIG_CONTRACT_VERSION };
