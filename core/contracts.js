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

/** Known environments. Only web/fake have implementations in this milestone. */
export const ENVIRONMENTS = Object.freeze({
  WEB: 'web',
  FAKE: 'fake',
  LINUX: 'linux-desktop',
  ANDROID: 'android',
  MINIPROGRAM: 'mini-program',
});

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
    'web.p0.capture',
    'web.p0.network',
    'web.p0.display',
    'web.p0.canvas',
    'web.p0.targets',
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
    CAPTURE: 'web.p0.capture',
    DISPLAY: 'web.p0.display',
    CANVAS: 'web.p0.canvas',
    TARGETS: 'web.p0.targets',
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
