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
  THREE_D_PROVIDERS,
  WEB_PROVIDER_SUPPORT,
  WEB_RUNTIME_PROVIDERS,
  WEB_RUNTIME_PROVIDER_IDS,
  environmentDeclaresProviders,
  environmentProviderIds,
} from './contracts.js';
import { AdapterError } from './errors.js';
import { workspaceKeyOf } from './identity.js';

/** Persisted config schema version. */
export const CONFIG_VERSION = 1;

/**
 * Web *runtime providers* (the browser that actually executes): one target environment (`web`),
 * one provider per selection. This is a different axis from `environment` and from the P0
 * `P0Provider` class — never conflate the names (see docs/internal/web-runtime-provider-contract.md §4.2).
 *
 * The ids live in `contracts.js` (`WEB_RUNTIME_PROVIDERS`) because the per-environment provider
 * catalogue there is the single vocabulary; these aliases keep every existing importer working.
 */
export const WEB_PROVIDERS = WEB_RUNTIME_PROVIDERS;

/** Known provider ids, in report order. Anything else is not a provider name. */
export const WEB_PROVIDER_IDS = WEB_RUNTIME_PROVIDER_IDS;

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
 * Known environments metadata — the single vocabulary for the settings page, the panel selector and
 * the diagnostics surface (see `environmentCatalog()`).
 *
 * `status` answers "how far is this environment implemented", and it is the *only* place that
 * answer lives:
 *
 * - `supported` —— 有执行适配器，Agent 能驱动；可启用、可选中。
 * - `view`      —— 只有视图（纯视口或空态画布），没有执行适配器；可启用、可选中，选中后
 *                  Agent 工具面为空。3D 的 Blender 纯视口属于这一类。
 * - `planned`   —— 未实现：可启用（表达意图），**不可选中**。
 * - `empty`     —— 默认视图（空态）：不可启用，可选中，任何 Host 都提供。
 *
 * `kind` 区分"目标环境"和"视图"：`environment` 会出现在设置页分组里，`view` 只出现在面板的
 * 环境组合框里（默认视图就是这样一行）。
 *
 * `label` / `short` 是设置页与面板组合框的显示名，跟 id 放在一起：客户端的显示目录一旦自己
 * 维护就会漂移（曾经宣告过 Host 根本没登记的环境）。顺序也是两个界面共用的目录顺序。
 */
const ENVIRONMENT_META = [
  { id: ENVIRONMENTS.DEFAULT, label: '默认视图', short: '默认', status: 'empty', kind: 'view' },
  { id: ENVIRONMENTS.WEB, label: 'Web 视图', short: 'Web', status: 'supported' },
  { id: ENVIRONMENTS.LINUX, label: 'Linux 视图', short: 'Linux', status: 'planned' },
  { id: ENVIRONMENTS.WINDOWS, label: 'Windows 视图', short: 'Windows', status: 'planned' },
  { id: ENVIRONMENTS.MACOS, label: 'macOS 视图', short: 'macOS', status: 'planned' },
  { id: ENVIRONMENTS.ANDROID, label: 'Android 视图', short: 'Android', status: 'planned' },
  { id: ENVIRONMENTS.TUI, label: 'TUI 视图', short: 'TUI', status: 'planned' },
  { id: ENVIRONMENTS.HARMONYOS, label: 'HarmonyOS 视图', short: 'HarmonyOS', status: 'planned' },
  { id: ENVIRONMENTS.GAME, label: '游戏视图', short: '游戏', status: 'planned' },
  { id: ENVIRONMENTS.THREE_D, label: '3D 视图', short: '3D', status: 'supported' },
  { id: ENVIRONMENTS.MINIPROGRAM, label: '小程序视图', short: '小程序', status: 'planned' },
  { id: ENVIRONMENTS.FAKE, label: '测试夹具环境', short: 'Fake', status: 'supported', testOnly: true },
];

const ENVIRONMENT_STATUSES = new Set(['supported', 'view', 'planned', 'empty']);

export const KNOWN_ENVIRONMENTS = Object.freeze(Object.fromEntries(ENVIRONMENT_META.map((meta) => {
  if (!ENVIRONMENT_STATUSES.has(meta.status)) throw new TypeError(`unknown environment status: ${meta.status}`);
  const kind = meta.kind === 'view' ? 'view' : 'environment';
  return [meta.id, Object.freeze({
    environment: meta.id,
    label: meta.label,
    short: meta.short,
    status: meta.status,
    kind,
    testOnly: meta.testOnly === true,
    planned: meta.status === 'planned',
    // 可选中 = 有东西可看（执行适配器或视图）。planned 只能说"启用过"，不能被选中。
    selectable: meta.status !== 'planned',
    // 可执行 = 有 Agent 执行适配器。
    executable: meta.status === 'supported',
    // 可启用 = 设置页有开关。默认视图是空态，不是一个开关能打开的"环境"。
    enableable: meta.status !== 'empty',
  })];
})));

/**
 * Read-only catalog of the environments this Host knows, in display order.
 *
 * Consumers (panel selector, settings page, diagnostics) take ids *and* labels from here rather
 * than keeping a list of their own. `testOnly` entries are included but flagged: test surfaces
 * decide whether to show them, production surfaces filter them out; `kind: 'view'` rows are offered
 * by the panel selector but never get a settings group.
 */
export function environmentCatalog() {
  return ENVIRONMENT_META.map((meta) => Object.freeze({
    id: meta.id,
    label: meta.label,
    short: meta.short,
    status: meta.status,
    kind: meta.kind === 'view' ? 'view' : 'environment',
    planned: meta.status === 'planned',
    testOnly: meta.testOnly === true,
  }));
}

const PLANNED_ENVIRONMENTS = new Set(
  Object.values(KNOWN_ENVIRONMENTS).filter((meta) => meta.planned).map((meta) => meta.environment),
);

/** 该目标环境是否仍是"规划中"（v1 没有适配器，可启用但不可执行）。 */
export function isPlannedEnvironment(environment) {
  return PLANNED_ENVIRONMENTS.has(environment);
}

/** 该 id 是不是空态视图（默认视图）。 */
export function isDefaultView(environment) {
  return environment === ENVIRONMENTS.DEFAULT;
}

/** 该 id 能否被设为"当前选择"（执行环境或面板视图）。 */
export function isSelectableEnvironment(environment) {
  const meta = KNOWN_ENVIRONMENTS[environment];
  return Boolean(meta && meta.selectable);
}

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

/**
 * Per-provider switches for a fresh environment entry. Web 沿用 chrome 单开；3D 的 Blender 纯视口
 * 默认开启，这样"打开 3D 视图总开关即可读画面"与接入纯视口之前的行为一致（那时门禁只看环境开关）。
 * 只有宣告了 provider 轴的环境才有这一层。
 */
function defaultProviders(environment) {
  if (environment === ENVIRONMENTS.WEB) return defaultWebProviders();
  if (environment === ENVIRONMENTS.THREE_D) return { [THREE_D_PROVIDERS.BLENDER]: { enabled: true } };
  return null;
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
      // 3D 视图带上它的 provider 轴：关闭状态 + Blender 纯视口默认开启。缺这一条会让设置页
      // 读不到 provider 清单，卡片开关只能显示"未知"。
      [ENVIRONMENTS.THREE_D]: {
        enabled: false,
        targetId: null,
        providers: { [THREE_D_PROVIDERS.BLENDER]: { enabled: true } },
      },
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
  }
  const providers = defaultProviders(environment);
  if (providers !== null) entry.providers = providers;
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

/**
 * `allowPlanned: true` 只用于**启用**类写入（`environments.<id>.enabled`）：
 * v1 里 android / linux 等环境没有适配器，但允许用户先把开关打开——启用 ≠ 可执行，
 * 可执行性由就绪六轴（adapter-not-registered / support=planned）如实表达。
 * 选择"当前执行环境"仍然拒绝 planned（见 `environment` 的写入路径）。
 */
function normalizeEnvironmentName(environment, field, { allowTestEnvironments = true, allowPlanned = false } = {}) {
  if (typeof environment !== 'string' || environment.length === 0) {
    throw invalid(`${field} must be a non-empty string`, { field });
  }
  const meta = KNOWN_ENVIRONMENTS[environment];
  if (!meta) throw invalid(`unknown environment: ${environment}`, { field, environment });
  if (meta.planned && !allowPlanned) {
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
    // 默认视图是空态，不是能"启用"的环境：把它写进可启用集合是配置错误，不是可忽略的噪声。
    if (KNOWN_ENVIRONMENTS[environment]?.enableable === false) {
      throw invalid(`environment ${environment} is a view, not an enableable environment`, {
        field, environment,
      });
    }
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

/**
 * Provider sub-map: per-provider deep shape. `environment` decides the legal ids — an id the
 * environment does not declare is dropped (load) or rejected (patch), never silently accepted.
 */
function normalizeProvidersMap(raw, field, { partial = false, strict = false, environment } = {}) {
  const source = assertPlainObject(raw, field);
  const allowed = environmentProviderIds(environment);
  const out = {};
  for (const [provider, entry] of Object.entries(source)) {
    if (!allowed.includes(provider)) {
      if (strict) {
        throw invalid(`unknown provider for environment ${environment}: ${provider}`, {
          field: `${field}.${provider}`,
          provider,
          environment,
          allowed: [...allowed],
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
    // 默认视图是空态，不是一个能启停的环境：给它写开关是配置错误，不是可忽略的噪声。
    if (KNOWN_ENVIRONMENTS[environment]?.enableable === false) {
      throw invalid(`environment ${environment} is a view, not an enableable environment`, {
        field: `${field}.enabled`,
        environment,
      });
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
    // 每个环境只在它自己的 provider 目录里存开关；没有 provider 轴的环境（如 game）拒绝这一层，
    // 不猜一个 provider 出来。
    if (!environmentDeclaresProviders(environment)) {
      throw invalid(`${field}.providers is not supported for the ${environment} environment`, {
        field: `${field}.providers`,
        environment,
      });
    }
    const provided = normalizeProvidersMap(source.providers, `${field}.providers`, { partial, strict, environment });
    out.providers = mergeProviderMaps(out.providers, provided);
    // 互斥：**写补丁**时"本次打开的那个"就是唯一启用的那个；**加载整份配置**时按已选中的
    // `provider` 收敛（旧文件里可能同时开着好几个）。
    const justEnabled = Object.entries(provided)
      .filter(([, value]) => value && value.enabled === true)
      .map(([id]) => id);
    const preferred = partial
      ? (justEnabled[justEnabled.length - 1] ?? null)
      : (typeof source.provider === 'string' ? source.provider : null);
    return enforceSingleProvider(environment, out, { preferred });
  }
  // 选择型写入（`provider`）同样要保持"开关只有一个启用"。
  return enforceSingleProvider(environment, out, { preferred: source.provider ?? null });
}

/**
 * 同一目标环境同一时刻只跑**一种**运行环境（调试视图只对着一个目标）。
 *
 * 规则（`preferred` 是本次被打开的那个）：
 *  1. 本次被启用且有开 → 保留它；
 *  2. 否则保留已选中的 `provider`；
 *  3. 否则保留目录里第一个处于启用状态的；
 *  4. 都没有 → 全部关闭（该环境没有可用运行环境，执行侧会如实报 provider-disabled）。
 *
 * 返回新对象，不改入参。`web` 的 `provider`（单选执行端）跟着开关一起走，避免"开关说 edge、
 * 选择说 chrome"两套事实。
 */
export function enforceSingleProvider(environment, entry, { preferred = null } = {}) {
  const ids = environmentProviderIds(environment);
  if (!entry || typeof entry !== 'object' || !ids.length) return entry;
  const providers = entry.providers;
  if (!providers || typeof providers !== 'object') return entry;
  const enabledIds = ids.filter((id) => providers[id] && providers[id].enabled === true);
  const keep = (typeof preferred === 'string' && preferred && providers[preferred]?.enabled === true)
    ? preferred
    : (typeof entry.provider === 'string' && enabledIds.includes(entry.provider)
      ? entry.provider
      : (enabledIds[0] ?? null));
  const next = { ...entry, providers: {} };
  for (const id of Object.keys(providers)) {
    const providerEntry = providers[id];
    next.providers[id] = providerEntry && typeof providerEntry === 'object'
      ? { ...providerEntry, enabled: id === keep }
      : providerEntry;
  }
  // 只有"还没有选择"时才用唯一启用的那个补上选择；已有选择（哪怕是未知名字）绝不改写——
  // "不静默换浏览器"是既有契约，`rejectedProviderReason` 负责把它报出来。
  if (environment === ENVIRONMENTS.WEB && keep && (next.provider === undefined || next.provider === null)) {
    next.provider = keep;
  }
  return next;
}

function normalizeEnvironmentMap(raw, field, { partial = false, strict = false } = {}) {
  const source = assertPlainObject(raw, field);
  const out = {};
  for (const [environment, entry] of Object.entries(source)) {
    // 未知环境丢弃（不猜）；**planned 环境保留**——这一层是"每个环境的总开关"，
    // 「启用」不等于「可执行」：v1 里 android 等环境没有适配器，但用户可以先把它打开，
    // 是否真的能跑由就绪六轴与"当前执行环境"的校验表达。
    if (!Object.hasOwn(KNOWN_ENVIRONMENTS, environment)) continue;
    out[environment] = normalizeEnvironmentEntry(entry, environment, { partial, strict });
  }
  return out;
}

function normalizeGlobal(raw) {
  const source = assertPlainObject(raw, 'global');
  // 有 provider 轴的环境必须有条目：设置页从 `environments.<id>.providers` 读各运行环境的开关，
  // 缺条目只能显示"未知"，不开关也存不下。其余环境按需出现（它们是 planned，只有总开关）。
  const environments = {
    [ENVIRONMENTS.WEB]: { ...defaultEnvironmentEntry(ENVIRONMENTS.WEB) },
    [ENVIRONMENTS.FAKE]: { ...defaultEnvironmentEntry(ENVIRONMENTS.FAKE) },
    [ENVIRONMENTS.THREE_D]: { ...defaultEnvironmentEntry(ENVIRONMENTS.THREE_D) },
  };
  const provided = normalizeEnvironmentMap(source.environments ?? {}, 'global.environments');
  for (const [environment, entry] of Object.entries(provided)) {
    environments[environment] = { ...environments[environment], ...entry };
  }
  const globalView = source.view === undefined
    ? undefined
    : normalizeEnvironmentName(source.view, 'global.view');
  return {
    ...(globalView === undefined ? {} : { view: globalView }),
    // 旧字段：只保留读兼容，不再参与视图解析（见 `resolveSnapshot` 的选择链）。
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
  // `view` 是该工作区最后选中的**视图**（环境 id 或默认视图），会话从它继承；`environment` 是
  // 旧字段，仍然接受并作为兜底，读路径见 `resolveSnapshot`。
  if (source.view !== undefined) {
    out.view = normalizeEnvironmentName(source.view, `workspaces.${key}.view`);
  }
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
  // 当前会话选中的视图。优先级高于旧的 `environment`（见 `resolveSnapshot` 的解析链）。
  if (source.view !== undefined) {
    out.view = normalizeEnvironmentName(source.view, `sessions.${key}.view`);
  }
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

const GLOBAL_PATCH_KEYS = new Set(['environment', 'view', 'enabledEnvironments', 'environments', 'targetId']);
const WORKSPACE_PATCH_KEYS = new Set(['environment', 'view', 'enabledEnvironments', 'environments', 'targetId']);
const SESSION_PATCH_KEYS = new Set(['environment', 'view', 'targetId', 'webProvider']);
const ENVIRONMENT_ENTRY_KEYS = new Set(['enabled', 'targetId', 'connection', 'provider', 'providers']);

function normalizePatchEnvironments(raw, field, options) {
  const source = assertPlainObject(raw, field);
  const out = {};
  for (const [environment, entry] of Object.entries(source)) {
    // 这里是"每个环境的总开关"，不是"当前执行环境"：planned 环境允许被启用。
    normalizeEnvironmentName(environment, field, { ...(options || {}), allowPlanned: true });
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
  if (source.view !== undefined) {
    out.view = normalizeEnvironmentName(source.view, `${scope}.view`, options);
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
 * 视图选择链（见 `docs/debug-panel.md`）：`session.view` > 旧字段 `session.environment` > 父会话的
 * 有效选择 > `workspace.view` > 旧字段 `workspace.environment` > 默认视图。没有选择不是"回退到
 * web"：空态就是 `ENVIRONMENTS.DEFAULT`，所以第一次打开会话/新会话落在默认视图。
 * 选择不可用（planned 或环境开关关着）时落到默认视图，并把被拒的值写进
 * `source.rejectedEnvironment`（绝不静默顶替）。
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
 *   view:string, targetId:string|null, source:{globalRevision:number, workspaceKey:string|null,
 *   sessionId:string|null, inheritedFrom:string|null, rejectedEnvironment:string|null,
 *   providerSource:string, inheritedProviderFrom:string|null, rejectedProvider:string|null,
 *   rejectedProviderReason:string|null, degraded:boolean, degradedReason:string|null}}}
 */
export function resolveSnapshot(config, { agent = null, workspaceKey = null, environmentOverride = null } = {}, { allowTestEnvironments = false } = {}) {
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

  /**
   * 显式环境覆盖（只给诊断这类"我要看这个环境"的调用方用）：给出一个可选中的环境 id 时，
   * 直接把它当作本次选择，不再走会话/工作区的视图链——诊断问的是"这个环境本身好不好"，
   * 不是"面板现在显示什么"。空态视图不接受覆盖。
   */
  const overrideEnvironment = (() => {
    if (typeof environmentOverride !== 'string' || !environmentOverride) return null;
    const meta = KNOWN_ENVIRONMENTS[environmentOverride];
    if (!meta || !meta.selectable || meta.testOnly && !allowTestEnvironments) return null;
    return environmentOverride;
  })();

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

  const selectable = (environment) => {
    const meta = KNOWN_ENVIRONMENTS[environment];
    if (!meta || meta.planned) return false;
    if (meta.testOnly && !allowTestEnvironments) return false;
    return true;
  };

  /** 该环境在当前作用域的开关是否打开（工作区级覆盖全局级）。 */
  const enabledSet = new Set(enabledEnvironments);
  const environmentSwitchEnabled = (environment) => {
    const entry = workspace?.environments?.[environment] ?? normalized.global.environments?.[environment];
    return Boolean(entry && entry.enabled === true);
  };

  /**
   * 把一个**视图选择**落到真正可用的目标上。
   *
   * - 默认视图本身就是空态：没有目标也是合法状态，永远可用；
   * - 其他 id 必须可选中（不是 planned）且环境开关是打开的；
   * - 否则退回默认视图，并把被拒的值如实写进 `source.rejectedEnvironment`——绝不静默顶替成 web，
   *   也不去挑"另一个碰巧启用的环境"，因为那会把用户明确选的东西换成他没选的东西。
   */
  const applyView = (view) => {
    if (view === undefined || view === null || view === ENVIRONMENTS.DEFAULT) {
      return { environment: ENVIRONMENTS.DEFAULT, rejected: null };
    }
    // 开关和 allow-list 都表达"这个环境可用"：设置页写开关（并由 Host 同步 allow-list），
    // 手工维护的配置可能只写其中一个，所以两者其一成立即可，任一都不成立才算被拒。
    const ok = selectable(view) && (environmentSwitchEnabled(view) || enabledSet.has(view));
    return ok ? { environment: view, rejected: null } : { environment: ENVIRONMENTS.DEFAULT, rejected: view };
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

    // 视图选择链：本会话的 view > 旧字段 environment > 父会话的有效选择 > 工作区 view >
    // 工作区旧字段 > 默认视图。**没有全局兜底**：新会话/没有选择时就是空态，而不是"碰巧启用
    // 的 Web"——这正是用户要的"第一次打开会话落在默认视图"。
    let view;
    let environmentSource;
    if (overrideEnvironment !== null) {
      view = overrideEnvironment;
      environmentSource = 'override';
    } else if (isPlainObject(own) && own.view !== undefined) {
      view = own.view;
      environmentSource = currentId;
    } else if (isPlainObject(own) && own.environment !== undefined) {
      view = own.environment;
      environmentSource = currentId;
    } else if (parent !== null) {
      view = parent.environment;
      environmentSource = parent.environmentSource;
    } else if (workspace?.view !== undefined) {
      view = workspace.view;
      environmentSource = 'workspace';
    } else if (workspace?.environment !== undefined) {
      view = workspace.environment;
      environmentSource = 'workspace';
    } else if (normalized.global.view !== undefined) {
      view = normalized.global.view;
      environmentSource = 'global';
    } else {
      view = ENVIRONMENTS.DEFAULT;
      environmentSource = 'default';
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

    const effective = applyView(view);
    const rejectedEnvironment = effective.rejected !== null
      ? effective.rejected
      : (isPlainObject(own) && (own.view !== undefined || own.environment !== undefined)
        ? null
        : (parent?.rejectedEnvironment ?? null));

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
      view,
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
    const requestedView = overrideEnvironment
      ?? workspace?.view ?? workspace?.environment
      ?? normalized.global.view ?? ENVIRONMENTS.DEFAULT;
    const effective = applyView(requestedView);
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
      view: requestedView,
      environmentSource: overrideEnvironment !== null
        ? 'override'
        : (workspace?.view !== undefined || workspace?.environment !== undefined ? 'workspace' : 'default'),
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

  // Provider switches are read from the selected environment's own catalogue. Web keeps its
  // explicit provider selection; Blender is the sole declared three-d provider.
  const enabledProviders = environmentProviderIds(environment).filter(
    (id) => environmentConfig.providers?.[id]?.enabled === true,
  );
  const isWeb = environment === ENVIRONMENTS.WEB;
  const isBlender = environment === ENVIRONMENTS.THREE_D;
  const provider = isWeb ? selection.provider : isBlender ? THREE_D_PROVIDERS.BLENDER : null;
  const providerEntry = isWeb || isBlender ? (environmentConfig.providers?.[provider] ?? {}) : {};
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
    : isBlender ? { provider, support: 'supported', enabled: providerEntry.enabled === true,
      executable: providerEntry.executable ?? null, connection: null, implemented: true } : null;
  if (isBlender) {
    if (environmentConfig.enabled !== true) rejectedProviderReason = 'environment-disabled';
    else if (providerEntry.enabled !== true) rejectedProviderReason = 'provider-disabled';
  }

  // A snapshot is a *step input*: it must be immutable, because admission, schema declaration,
  // Skill discovery and execution all read the same object (A11). Freezing here — not at each
  // call site — makes "one step, one version" enforceable instead of a convention.
  return deepFreeze({
    revision: normalized.revision,
    environment,
    // 面板组合框要显示的**视图**（环境 id 或默认视图）。它通常等于 environment，区别只在
    // environment 被拒后回落到默认视图时：view 记下用户真正选过的值，便于提示与回填。
    view: selection.view ?? environment,
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
