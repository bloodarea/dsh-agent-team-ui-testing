/**
 * Public contract constants for the cross-environment foundation (v1).
 *
 * This module is pure data: no I/O, no clocks, no browser/platform imports. Every constant is
 * frozen so adapters and the host share one authoritative vocabulary instead of re-declaring
 * string literals. See docs/internal/cross-environment-foundation-m0.md §2-§5.
 */

/** Contract version shared by all three adapter classes. A mismatch is ADAPTER_UNSUPPORTED. */
export const CONTRACT_VERSION = 1;

/** The three adapter classes; each has a different call direction (M0 §2). */
export const ADAPTER_CLASSES = Object.freeze({
  TARGET: 'target',
  CAPABILITY: 'capability',
  P0: 'p0',
});

/** Engineering support: does an implementation exist for this environment/capability? */
export const SUPPORT = Object.freeze({
  SUPPORTED: 'supported',
  UNSUPPORTED: 'unsupported',
  PLANNED: 'planned',
});

/** Live availability: can the operation run right now? Never conflate with support. */
export const AVAILABILITY = Object.freeze({
  AVAILABLE: 'available',
  UNAVAILABLE: 'unavailable',
  NOT_PROBED: 'not-probed',
  BUSY: 'busy',
});

/** Per-axis readiness statuses. Axes are reported independently, never as one boolean. */
export const READINESS_STATUS = Object.freeze({
  OK: 'ok',
  DEGRADED: 'degraded',
  FAILED: 'failed',
  NOT_PROBED: 'not-probed',
  UNSUPPORTED: 'unsupported',
  DISABLED: 'disabled',
  BOUND: 'bound',
  UNBOUND: 'unbound',
  STALE: 'stale',
});

/** The six readiness axes, in report order (M0 §5.2). */
export const READINESS_AXES = Object.freeze([
  'support',
  'enabled',
  'dependency',
  'connection',
  'target',
  'capability',
]);

/**
 * Web runtime providers and their engineering support — the **single truth** for "can this browser
 * actually execute?".
 *
 * - `supported`: a driver exists (chrome).
 * - `pending`: the user may express intent (`providers.<id>.enabled=true`) but no driver exists yet,
 *   so it is *not* an implemented provider: registration does not count it, readiness reports
 *   `not-probed / provider-driver-pending`, execution refuses with ADAPTER_UNSUPPORTED + `driver-pending`.
 * - `unsupported`: no driver and none planned in this milestone.
 *
 * Flipping `edge` to `supported` is the one and only switch point (slice ③, once the vendor launcher,
 * candidate paths and product-identity check exist). Never add a second "is edge usable?" judgement.
 */
export const WEB_PROVIDER_SUPPORT = Object.freeze({
  chrome: 'supported',
  // Slice ③: the Edge vendor launcher exists, so `edge` is implemented. **This is the one switch
  // point** — driver, readiness, registration and execution all derive from this table.
  edge: 'supported',
  firefox: 'unsupported',
});

/**
 * Machine-readable provider `reason` values. One concept, one spelling: driver refusal, readiness
 * and tool errors must all use these constants (a `reason` is a detail, never a public error code).
 */
export const WEB_PROVIDER_REASONS = Object.freeze({
  /** A provider whose driver is not wired yet (firefox today). */
  DRIVER_PENDING: 'driver-pending',
  /** No such provider id at all. */
  UNKNOWN_PROVIDER: 'unknown-provider',
  /** The user (or workspace) switch is off. */
  PROVIDER_DISABLED: 'provider-disabled',
  /** The whole target environment is off. */
  ENVIRONMENT_DISABLED: 'environment-disabled',
  /** Provider has no driver and none is planned. */
  PROVIDER_UNSUPPORTED: 'provider-unsupported',
  /** This provider's executable is missing on this machine. */
  EXECUTABLE_MISSING: 'executable-missing',
  /** An explicit override exists but is not usable (never a reason to run another vendor). */
  OVERRIDE_INVALID: 'override-invalid',
  /** The launched product gave no identity evidence and the provider needs it (non-chrome). */
  IDENTITY_UNVERIFIED: 'identity-unverified',
  /** The launched product identified as a different vendor. */
  IDENTITY_MISMATCH: 'identity-mismatch',
});

/**
 * Product-identity rule per vendor, used after the transport is up ("CDP connected" is not proof).
 *
 * `requires`: substrings the `Browser.getVersion.product` string must contain.
 * `forbids`: substrings that must not appear (chrome must not be an Edge endpoint).
 * `failClosedOnMissing`: no evidence is a rejection (multi-vendor providers) or tolerated
 * (chrome, whose already-accepted startup path must not gain a new failure mode).
 * A new vendor is one line here — never another if/else in the driver.
 */
export const WEB_PROVIDER_VENDOR = Object.freeze({
  chrome: Object.freeze({ requires: Object.freeze(['Chrome/']), forbids: Object.freeze(['Edg/']), failClosedOnMissing: false }),
  edge: Object.freeze({ requires: Object.freeze(['Edg/']), forbids: Object.freeze([]), failClosedOnMissing: true }),
});

/**
 * Profile directory suffix per provider: Chrome and Edge must never share a headed profile.
 */
export const WEB_PROVIDER_PROFILE_SUFFIX = Object.freeze({ chrome: 'chrome', edge: 'edge', firefox: 'firefox' });

/**
 * Web 运行环境的 id 词表（谁在真正执行页面）。这里只放 id；工程支持度在 `WEB_PROVIDER_SUPPORT`，
 * 而 `core/config.js` 从这个词表派生出 `WEB_PROVIDERS` / `WEB_PROVIDER_IDS`，因此两者永不各写一份。
 */
export const WEB_RUNTIME_PROVIDERS = Object.freeze({ CHROME: 'chrome', EDGE: 'edge', FIREFOX: 'firefox' });

/** Known web runtime provider ids, in report order. Anything else is not a provider name. */
export const WEB_RUNTIME_PROVIDER_IDS = Object.freeze([
  WEB_RUNTIME_PROVIDERS.CHROME,
  WEB_RUNTIME_PROVIDERS.EDGE,
  WEB_RUNTIME_PROVIDERS.FIREFOX,
]);

/** 3D 视图的运行环境（纯视口执行端）。第一个也是当前唯一一个：Blender。 */
export const THREE_D_PROVIDERS = Object.freeze({ BLENDER: 'blender' });

/** Known 3D provider ids, in report order. Anything else is not a provider name. */
export const THREE_D_PROVIDER_IDS = Object.freeze([THREE_D_PROVIDERS.BLENDER]);

/**
 * Known environments. Only web/fake have implementations in this milestone; the rest are
 * registered as planned so that a planned environment is *announced* by the Host instead of
 * being invented by a client. This object is the single vocabulary: the config catalog, the
 * settings page and the panel selector all derive their ids from it (a panel-local list is a
 * defect — see tests/contracts/environment-catalog.test.mjs).
 */
export const ENVIRONMENTS = Object.freeze({
  WEB: 'web',
  /**
   * 空态视图：没有目标环境时的面板落点（docs/debug-panel.md §默认视图）。
   *
   * 它是一个**视图**，不是一个能启用/执行的目标环境：设置页不为它渲染分组，它不进
   * `enabledEnvironments`，也没有适配器。会话/工作区可以把它存成自己的选择，这样"没有目标"
   * 本身也是可持久化的事实，而不是各处各写一个 `null` 判断。
   */
  DEFAULT: 'default',
  FAKE: 'fake',
  LINUX: 'linux-desktop',
  ANDROID: 'android',
  MINIPROGRAM: 'mini-program',
  WINDOWS: 'windows',
  MACOS: 'macos',
  TUI: 'tui',
  HARMONYOS: 'harmonyos',
  GAME: 'game',
  THREE_D: 'three-d',
});

/**
 * Per-environment **provider catalogue**: which runtime providers an environment declares, and how
 * far each one is implemented. This is the single vocabulary the config layer, the settings page
 * and the Host gates share — a provider id is valid for an environment only when it appears here.
 *
 * `web` declares its browser runtime providers (see `WEB_PROVIDER_SUPPORT`); `three-d` declares the
 * Blender viewport. An environment that appears in neither table simply has no provider axis: its
 * entry carries only `enabled` / `targetId` / `connection`.
 */
export const ENVIRONMENT_PROVIDER_IDS = Object.freeze({
  [ENVIRONMENTS.WEB]: WEB_RUNTIME_PROVIDER_IDS,
  [ENVIRONMENTS.THREE_D]: THREE_D_PROVIDER_IDS,
});

/**
 * Engineering support per environment + provider id.
 *
 * - `supported`: 有执行适配器，能驱动目标。
 * - `pending`: 用户可保存启用意图，但还没有驱动（web 的边早期状态）。
 * - `preview`: **只接了纯视口**——能看画面、能标注、能截图，但没有 Agent 执行适配器。
 *   Blender 今天就是这一类：3D 视图的 `/blender/frame` 放行它，工具面不声明它。
 * - `unsupported`: 没有驱动，本阶段也没有计划。
 *
 * 这张表是"这个 provider 到哪一步了"的唯一真值：面板卡片的可点判定、Host 的配置校验与
 * 纯视口门禁都从它派生，不得各自再写一份判断。
 */
export const ENVIRONMENT_PROVIDER_SUPPORT = Object.freeze({
  [ENVIRONMENTS.WEB]: WEB_PROVIDER_SUPPORT,
  [ENVIRONMENTS.THREE_D]: Object.freeze({
    [THREE_D_PROVIDERS.BLENDER]: 'supported',
  }),
});

/** Provider ids declared by one environment, in report order. Unknown / provider-less → `[]`. */
export function environmentProviderIds(environment) {
  const list = ENVIRONMENT_PROVIDER_IDS[environment];
  return Array.isArray(list) ? [...list] : [];
}

/** True when `environment` declares a provider axis at all (and may therefore store `providers`). */
export function environmentDeclaresProviders(environment) {
  return environmentProviderIds(environment).length > 0;
}

/** Engineering support for one provider id (`supported|pending|preview|unsupported`), or null. */
export function environmentProviderSupport(environment, provider) {
  const table = ENVIRONMENT_PROVIDER_SUPPORT[environment];
  return table && Object.hasOwn(table, provider) ? table[provider] : null;
}

/** True when the provider can actually be driven by the Agent (a real execution adapter exists). */
export function isExecutingProvider(environment, provider) {
  return environmentProviderSupport(environment, provider) === 'supported';
}

/** True when the provider has at least a read-only viewport surface (`preview` or `supported`). */
export function isViewableProvider(environment, provider) {
  const support = environmentProviderSupport(environment, provider);
  return support === 'supported' || support === 'preview';
}

/**
 * Canonical capability ids per environment. This is the adapter catalog: it is intentionally
 * independent from `enabledEnvironments`, which only decides whether an environment may be used.
 */
export const ENVIRONMENT_CAPABILITIES = Object.freeze({
  web: Object.freeze([
    'web.t1',
    'web.t2',
    'web.t3',
    'web.t4',
    'web.network',
    'web.tabs',
    // P0-D annotations (docs/viewport-control.md): the Agent annotation write surface.
    'web.p0.annotations',
    'web.p0.capture',
    'web.p0.network',
    'web.p0.display',
    'web.p0.canvas',
    'web.p0.targets',
    // FR-11 Cookie Store: metadata read + human-approved controlled export/import.
    'web.p0.cookies',
    // FR-01 Scope & Safety Controller: session-scoped origin allowlist, budget, stop.
    'web.p0.security',
    // FR-02 Attack Surface Discovery: structured inventory (DISC-01..07).
    'web.p0.surface',
    // FR-03/FR-04 JavaScript static analysis (script inventory / strings / sinks).
    'web.p0.scripts',
    // FR-09/FR-10 security findings + rule engine.
    'web.p0.findings',
    // FR-08 business logic testing (server-state invariants).
    'web.p0.business',
  ]),
  fake: Object.freeze([
    'fake.t1',
    'fake.t2',
    'fake.t3',
    'fake.network',
    'fake.p0.capture',
    'fake.p0.network',
    'fake.p0.display',
    'fake.p0.canvas',
    'fake.p0.targets',
  ]),
  [ENVIRONMENTS.THREE_D]: Object.freeze([
    'three-d.project', 'three-d.scene.query', 'three-d.scene.apply', 'three-d.view',
    'three-d.capture', 'three-d.verify', 'three-d.reference.basic', 'three-d.spec.read',
    'three-d.spec.write', 'three-d.jobs', 'three-d.targets',
  ]),
});

/** Named capability ids used by tools/readiness. `p0.network` is part of the adapter catalog. */
export const CAPABILITY_IDS = Object.freeze({
  WEB: Object.freeze({
    T1: 'web.t1',
    T2: 'web.t2',
    T3: 'web.t3',
    T4: 'web.t4',
    NETWORK: 'web.network',
    TABS: 'web.tabs',
    ANNOTATIONS: 'web.p0.annotations',
    CAPTURE: 'web.p0.capture',
    DISPLAY: 'web.p0.display',
    CANVAS: 'web.p0.canvas',
    TARGETS: 'web.p0.targets',
    COOKIES: 'web.p0.cookies',
    SECURITY: 'web.p0.security',
    SURFACE: 'web.p0.surface',
    SCRIPTS: 'web.p0.scripts',
    FINDINGS: 'web.p0.findings',
    BUSINESS: 'web.p0.business',
  }),
  FAKE: Object.freeze({
    T1: 'fake.t1',
    T2: 'fake.t2',
    T3: 'fake.t3',
    NETWORK: 'fake.network',
    CAPTURE: 'fake.p0.capture',
    DISPLAY: 'fake.p0.display',
    CANVAS: 'fake.p0.canvas',
    TARGETS: 'fake.p0.targets',
  }),
  THREE_D: Object.freeze({
    PROJECT: 'three-d.project', SCENE_QUERY: 'three-d.scene.query', SCENE_APPLY: 'three-d.scene.apply',
    VIEW: 'three-d.view', CAPTURE: 'three-d.capture', VERIFY: 'three-d.verify',
    REFERENCE_BASIC: 'three-d.reference.basic', SPEC_READ: 'three-d.spec.read',
    SPEC_WRITE: 'three-d.spec.write', JOBS: 'three-d.jobs', TARGETS: 'three-d.targets',
  }),
});

/** Stable machine error codes. Unknown codes normalize to INTERNAL in core/errors.js. */
export const ERROR_CODES = Object.freeze({
  ADAPTER_NOT_FOUND: 'ADAPTER_NOT_FOUND',
  ADAPTER_UNSUPPORTED: 'ADAPTER_UNSUPPORTED',
  ADAPTER_DISABLED: 'ADAPTER_DISABLED',
  CONFIG_CONFLICT: 'CONFIG_CONFLICT',
  CONFIG_INVALID: 'CONFIG_INVALID',
  CONFIG_STALE: 'CONFIG_STALE',
  TARGET_NOT_BOUND: 'TARGET_NOT_BOUND',
  TARGET_GONE: 'TARGET_GONE',
  GENERATION_MISMATCH: 'GENERATION_MISMATCH',
  CAPABILITY_UNSUPPORTED: 'CAPABILITY_UNSUPPORTED',
  CAPABILITY_UNAVAILABLE: 'CAPABILITY_UNAVAILABLE',
  DEPENDENCY_MISSING: 'DEPENDENCY_MISSING',
  CONNECTION_UNTRUSTED: 'CONNECTION_UNTRUSTED',
  PROBE_TIMEOUT: 'PROBE_TIMEOUT',
  PROVIDER_UNAVAILABLE: 'PROVIDER_UNAVAILABLE',
  EVIDENCE_INCOMPLETE: 'EVIDENCE_INCOMPLETE',
  FORBIDDEN: 'FORBIDDEN',
  // Team/page access model (M1, ruling §7.3). Registered here as well as in ERROR_TAXONOMY so
  // the constant table and the classification table cannot drift apart: a code that exists in one
  // and not the other is exactly how a permission refusal ends up reported as INTERNAL.
  TAB_FORBIDDEN: 'TAB_FORBIDDEN',
  TAB_NOT_FOUND: 'TAB_NOT_FOUND',
  TAB_LIMIT: 'TAB_LIMIT',
  TAB_CONTROL_CHANGED: 'TAB_CONTROL_CHANGED',
  TAB_OWNERSHIP_STALE: 'TAB_OWNERSHIP_STALE',
  TAB_IDENTITY_UNAVAILABLE: 'TAB_IDENTITY_UNAVAILABLE',
  TAB_OBSERVATION_STALE: 'TAB_OBSERVATION_STALE',
  OBSERVATION_UNAVAILABLE: 'OBSERVATION_UNAVAILABLE',
  RUNTIME_LIMIT: 'RUNTIME_LIMIT',
  INVALID_ARGUMENT: 'INVALID_ARGUMENT',
  OUTPUT_WRITE_FAILED: 'OUTPUT_WRITE_FAILED',
  INTERNAL: 'INTERNAL',
});

/** All known capability ids as a lookup set (web + fake adapter catalogs). */
const CAPABILITY_ID_SET = new Set(
  Object.values(ENVIRONMENT_CAPABILITIES).flatMap((ids) => ids),
);

/**
 * True when `id` is a capability id declared by a shipped adapter catalog.
 *
 * Deliberately membership-based: an arbitrary dotted string is not a capability. New
 * environments must add their catalog above before their ids become valid.
 */
export function isCapabilityId(id) {
  return typeof id === 'string' && CAPABILITY_ID_SET.has(id);
}
