/**
 * Web (Chromium) adapter boundary: TargetAdapter + CapabilityAdapter.
 *
 * This module is the *only* place where the web environment declares its target lifecycle, its
 * tool inventory and its execution classes. It deliberately owns no browser protocol: Chromium/CDP
 * live behind the injected `dispatch` (capability execution) and the shared `registry` (target
 * discovery). Nothing here starts a browser, reads user configuration, or imports the host entry.
 *
 * Contracts follow docs/internal/cross-environment-foundation-m0.md §2.1 (v1):
 * - TargetAdapter:     { manifest, probe, createSession, dispose }
 * - TargetSession:     { sessionId, environment, generation, configRevision, target,
 *                        listTargets, bind, close, dispose }
 * - CapabilityAdapter: { manifest, operationStatus, invoke, preflight, dispose }
 *
 * `probe()` is a bounded, low-interference check (M0 §5.2): it may look at the filesystem and at
 * registry state, and must never launch Chromium. Missing evidence is reported as `not-probed`,
 * never as a fabricated version or a static "valid" boolean.
 */

import { existsSync } from 'node:fs';
import { delimiter, isAbsolute, join } from 'node:path';
import process from 'node:process';

import {
  AdapterError,
  AVAILABILITY,
  CONTRACT_VERSION,
  DEFAULT_WEB_PROVIDER,
  ERROR_CODES,
  READINESS_STATUS,
  SUPPORT,
  WEB_PROVIDER_IDS,
  WEB_PROVIDER_REASONS,
  WEB_PROVIDER_VENDOR,
  axis,
  createEvidenceEnvelope,
  createReadinessReport,
  isImplementedWebProvider,
  newTargetIdentity,
  webProviderSupport,
} from '../../core/index.js';

/**
 * Capability ids declared by the web adapter (mirrors core/contracts.js ENVIRONMENT_CAPABILITIES.web).
 * Declaring support is separate from live availability: see `probe`/`operationStatus`.
 */
export const WEB_CAPABILITIES = Object.freeze([
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
]);

/**
 * Execution classes understood by the composition root (M0 §2.1).
 *
 * The adapter never changes the routing branch; it only declares which class an operation belongs
 * to and validates a caller-supplied class against that declaration.
 */
export const WEB_EXECUTION_CLASSES = Object.freeze({
  PAGE: 'page',
  READ_ONLY: 'readOnly',
  HOST_ONLY: 'hostOnly',
  NETWORK_READ: 'networkRead',
  DIAGNOSTIC: 'diagnostic',
  INDEPENDENT_HTTP: 'independentHttp',
  TABS: 'tabs',
});

const EXECUTION_CLASS_SET = new Set(Object.values(WEB_EXECUTION_CLASSES));

/**
 * Only these execution classes need a bound page target. `readOnly`, `hostOnly`, `networkRead`,
 * `diagnostic` and `independentHttp` are host/runtime-level operations that must keep working when
 * no page is bound (A06: the 36-tool surface must not regress into TARGET_NOT_BOUND).
 */
const TARGET_BOUND_CLASSES = new Set([WEB_EXECUTION_CLASSES.PAGE, WEB_EXECUTION_CLASSES.TABS]);

/**
 * The 36 `browser_*` operations: name -> capability id.
 *
 * The public contract stays environment-neutral (`operation` -> capability id); the web-specific
 * tool names are inventory data, not a second interface.
 */
export const WEB_TOOL_OPERATIONS = Object.freeze({
  // T1 — programmatic interface (+ the tab/lease surface).
  browser_navigate: 'web.t1',
  browser_eval: 'web.t1',
  browser_screenshot: 'web.t1',
  browser_input: 'web.t1',
  browser_network: 'web.t1',
  browser_computed_style: 'web.t1',
  browser_http_request: 'web.t1',
  browser_state: 'web.t1',
  browser_capabilities: 'web.t1',
  browser_viewport: 'web.t1',
  browser_tabs: 'web.tabs',

  // T2 — structured GUI.
  browser_snapshot: 'web.t2',
  browser_click: 'web.t2',
  browser_type: 'web.t2',
  browser_scroll: 'web.t2',
  browser_fill_form: 'web.t2',
  browser_node_state: 'web.t2',
  browser_wait_for: 'web.t2',

  // T3 — static vision.
  browser_vision_image: 'web.t3',
  browser_vision_find: 'web.t3',
  browser_vision_compare: 'web.t3',
  browser_vision_act: 'web.t3',
  browser_vision_baseline: 'web.t3',
  browser_vision_check: 'web.t3',

  // P0-B — network evidence and control.
  browser_network_session: 'web.network',
  browser_network_events: 'web.network',
  browser_network_detail: 'web.network',
  browser_network_trace: 'web.network',
  browser_network_control: 'web.network',
  browser_network_evidence: 'web.network',
  browser_network_subscribe: 'web.network',

  // T4 — dynamic behaviour.
  browser_dynamic_session: 'web.t4',
  browser_motion_observe: 'web.t4',
  browser_motion_analyze: 'web.t4',
  browser_motion_control: 'web.t4',
  browser_dynamic_correlate: 'web.t4',
});

/** Operation names, in declaration order. Used for lookups and manifest ordering. */
export const WEB_TOOL_OPERATION_NAMES = Object.freeze(Object.keys(WEB_TOOL_OPERATIONS));

function spec(name, capability, executionClass, executionClasses) {
  const entry = { name, capability, executionClass };
  if (Array.isArray(executionClasses) && executionClasses.length > 1) {
    entry.executionClasses = Object.freeze([...executionClasses]);
  }
  return Object.freeze(entry);
}

/**
 * Per-operation execution class declaration.
 *
 * `executionClass` is the default; `executionClasses` lists every class the operation may use when
 * the concrete action changes it (e.g. `browser_viewport` get vs set). `resolveExecutionClass()`
 * applies the action-level refinement that `preflight` exposes to the composition root.
 */
export const WEB_TOOL_OPERATION_SPECS = Object.freeze([
  // T1
  spec('browser_navigate', 'web.t1', 'page'),
  spec('browser_eval', 'web.t1', 'page'),
  spec('browser_screenshot', 'web.t1', 'page'),
  spec('browser_input', 'web.t1', 'page'),
  spec('browser_network', 'web.t1', 'page'),
  spec('browser_computed_style', 'web.t1', 'page'),
  spec('browser_http_request', 'web.t1', 'independentHttp'),
  spec('browser_state', 'web.t1', 'diagnostic', ['diagnostic', 'readOnly']),
  spec('browser_capabilities', 'web.t1', 'diagnostic', ['diagnostic', 'readOnly']),
  spec('browser_viewport', 'web.t1', 'readOnly', ['readOnly', 'page']),
  spec('browser_tabs', 'web.tabs', 'tabs'),

  // T2
  spec('browser_snapshot', 'web.t2', 'page'),
  spec('browser_click', 'web.t2', 'page'),
  spec('browser_type', 'web.t2', 'page'),
  spec('browser_scroll', 'web.t2', 'page'),
  spec('browser_fill_form', 'web.t2', 'page'),
  spec('browser_node_state', 'web.t2', 'page'),
  spec('browser_wait_for', 'web.t2', 'page'),

  // T3
  spec('browser_vision_image', 'web.t3', 'page'),
  spec('browser_vision_find', 'web.t3', 'page'),
  spec('browser_vision_compare', 'web.t3', 'page'),
  spec('browser_vision_act', 'web.t3', 'page'),
  spec('browser_vision_baseline', 'web.t3', 'page'),
  spec('browser_vision_check', 'web.t3', 'page'),

  // Network
  spec('browser_network_session', 'web.network', 'hostOnly', ['hostOnly', 'readOnly']),
  spec('browser_network_events', 'web.network', 'networkRead', ['networkRead', 'readOnly']),
  spec('browser_network_detail', 'web.network', 'networkRead', ['networkRead', 'readOnly']),
  spec('browser_network_trace', 'web.network', 'networkRead', ['networkRead', 'readOnly']),
  spec('browser_network_control', 'web.network', 'hostOnly'),
  spec('browser_network_evidence', 'web.network', 'networkRead', ['networkRead', 'readOnly']),
  spec('browser_network_subscribe', 'web.network', 'networkRead', ['networkRead', 'readOnly']),

  // T4
  spec('browser_dynamic_session', 'web.t4', 'page', ['page', 'hostOnly']),
  spec('browser_motion_observe', 'web.t4', 'page'),
  spec('browser_motion_analyze', 'web.t4', 'page'),
  spec('browser_motion_control', 'web.t4', 'page'),
  spec('browser_dynamic_correlate', 'web.t4', 'readOnly'),
]);

const SPEC_BY_NAME = new Map(WEB_TOOL_OPERATION_SPECS.map((entry) => [entry.name, entry]));

/**
 * Resolve the execution class for one concrete call.
 *
 * Only the action-level cases that M0 calls out are refined here; everything else uses the
 * declared default. Returns `null` for an unknown operation so callers can fail closed.
 */
export function resolveExecutionClass(operation, args = {}) {
  const entry = SPEC_BY_NAME.get(operation);
  if (!entry) return null;
  const action = typeof args?.action === 'string' ? args.action : null;

  if (operation === 'browser_viewport' && action === 'set') return 'page';
  if (operation === 'browser_network_session') {
    if (action === 'status') return 'readOnly';
    return 'hostOnly';
  }
  if (operation === 'browser_dynamic_session') {
    if (action === 'status' || action === 'reset') return 'hostOnly';
    return 'page';
  }
  return entry.executionClass;
}

function executionClassesOf(operation) {
  const entry = SPEC_BY_NAME.get(operation);
  if (!entry) return [];
  return entry.executionClasses ?? [entry.executionClass];
}

/**
 * Resolve which browser *driver* one snapshot addresses (contract §4.2).
 *
 * The web environment keeps exactly one facade per adapter class (`environment` / `adapterId` stay
 * `"web"`); the provider dimension lives here and only here, so "which browser executes" is answered
 * once instead of at every call site. `provider` missing from the snapshot is the legacy shape
 * (hand-built test snapshots, pre-provider hosts) and means chrome — the documented v1 default.
 *
 * `blocked` is never resolved by substituting another browser (§5): it either reports `null`
 * (executable) or the reason the *selected* provider cannot run, with the §4.4 error code.
 *
 * @param {object|null} snapshot
 * @returns {{provider:string, executionAdapterId:string, implemented:boolean,
 *   blocked:string|null, errorCode:string|null}}
 */
export function resolveWebDriver(snapshot) {
  const provider = snapshot && typeof snapshot.provider === 'string' && snapshot.provider.length > 0
    ? snapshot.provider
    : DEFAULT_WEB_PROVIDER;
  const known = WEB_PROVIDER_IDS.includes(provider);
  const support = webProviderSupport(provider);
  const implemented = isImplementedWebProvider(provider);
  const configReason = snapshot && isPlainObject(snapshot.source)
    && typeof snapshot.source.rejectedProviderReason === 'string'
    ? snapshot.source.rejectedProviderReason
    : null;
  // Config policy first (it is the actionable thing a user can change), then engineering support.
  let blocked = null;
  if (!known) blocked = WEB_PROVIDER_REASONS.UNKNOWN_PROVIDER;
  else if (configReason === WEB_PROVIDER_REASONS.ENVIRONMENT_DISABLED
    || configReason === WEB_PROVIDER_REASONS.PROVIDER_DISABLED) {
    blocked = configReason;
  } else if (support === 'pending') blocked = WEB_PROVIDER_REASONS.DRIVER_PENDING;
  else if (!implemented) blocked = WEB_PROVIDER_REASONS.PROVIDER_UNSUPPORTED;
  return {
    provider,
    executionAdapterId: `web-${provider}`,
    support,
    implemented,
    blocked,
    errorCode: blocked === null
      ? null
      : (blocked === WEB_PROVIDER_REASONS.DRIVER_PENDING || blocked === WEB_PROVIDER_REASONS.UNKNOWN_PROVIDER
        || blocked === WEB_PROVIDER_REASONS.PROVIDER_UNSUPPORTED
        ? ERROR_CODES.ADAPTER_UNSUPPORTED
        : ERROR_CODES.ADAPTER_DISABLED),
  };
}

/**
 * Refuse a call whose provider cannot execute, using the fixed §4.4 vocabulary:
 * disabled -> ADAPTER_DISABLED, unknown / not implemented -> ADAPTER_UNSUPPORTED.
 */
function assertDriverAllowed(driver, operation) {
  if (driver.blocked === null) return driver;
  const disabled = driver.blocked === WEB_PROVIDER_REASONS.ENVIRONMENT_DISABLED
    || driver.blocked === WEB_PROVIDER_REASONS.PROVIDER_DISABLED;
  throw new AdapterError(
    driver.errorCode,
    disabled
      ? `web provider '${driver.provider}' is disabled (${driver.blocked})`
      : `web provider '${driver.provider}' cannot execute (${driver.blocked})`,
    { details: { operation: operation ?? null, provider: driver.provider, reason: driver.blocked } },
  );
}

/** Error codes that a platform dispatch is allowed to raise and have preserved. */
const PRESERVED_ERROR_CODES = new Set(Object.values(ERROR_CODES));

/** Chrome candidates per platform; an explicit `chromePath` replaces this list (no fallback). */
const LINUX_CHROME_CANDIDATES = Object.freeze([
  '/opt/google/chrome/chrome',
  '/usr/bin/google-chrome',
  '/usr/bin/google-chrome-stable',
  '/usr/bin/chromium',
  '/usr/bin/chromium-browser',
  'google-chrome',
  'chromium',
  'chromium-browser',
]);

const MAC_CHROME_CANDIDATES = Object.freeze([
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/Applications/Chromium.app/Contents/MacOS/Chromium',
]);

function windowsChromeCandidates(env) {
  const programFiles = env.ProgramFiles || env.PROGRAMFILES || 'C:\\Program Files';
  const programFilesX86 = env['ProgramFiles(x86)'] || env['PROGRAMFILES(X86)'] || 'C:\\Program Files (x86)';
  const localAppData = env.LOCALAPPDATA || '';
  const candidates = [
    join(programFiles, 'Google', 'Chrome', 'Application', 'chrome.exe'),
    join(programFilesX86, 'Google', 'Chrome', 'Application', 'chrome.exe'),
  ];
  if (localAppData) {
    candidates.push(join(localAppData, 'Google', 'Chrome', 'Application', 'chrome.exe'));
  }
  return candidates;
}

/** Explicit per-provider override env var; one variable per vendor, never shared. */
export const WEB_PROVIDER_ENV = Object.freeze({
  chrome: 'DSH_UI_TESTING_CHROME',
  edge: 'DSH_UI_TESTING_EDGE',
});

/** Edge candidates per platform. Chrome's list is untouched above. */
const EDGE_LINUX_CANDIDATES = Object.freeze([
  '/opt/microsoft/msedge/msedge',
  '/usr/bin/microsoft-edge',
  '/usr/bin/microsoft-edge-stable',
  'microsoft-edge',
  'microsoft-edge-stable',
]);

const EDGE_MAC_CANDIDATES = Object.freeze([
  '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
  '/Applications/Microsoft Edge Beta.app/Contents/MacOS/Microsoft Edge Beta',
]);

function windowsEdgeCandidates(env) {
  const programFiles = env.ProgramFiles || env.PROGRAMFILES || 'C:\\Program Files';
  const programFilesX86 = env['ProgramFiles(x86)'] || env['PROGRAMFILES(X86)'] || 'C:\\Program Files (x86)';
  const localAppData = env.LOCALAPPDATA || '';
  const candidates = [
    join(programFilesX86, 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
    join(programFiles, 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
  ];
  if (localAppData) candidates.push(join(localAppData, 'Microsoft', 'Edge', 'Application', 'msedge.exe'));
  return candidates;
}

/**
 * Ordered executable candidates for one provider. Vendors never mix: an Edge search never contains
 * a Chrome path (a "successful" Edge launch that is really Chrome is the failure mode §8 forbids).
 */
export function providerExecutableCandidates({ provider, platform = process.platform, env = process.env } = {}) {
  if (provider === 'edge') {
    if (platform === 'darwin') return [...EDGE_MAC_CANDIDATES];
    if (platform === 'win32') return windowsEdgeCandidates(env);
    return [...EDGE_LINUX_CANDIDATES];
  }
  return chromeCandidates({ chromePath: undefined, platform, env });
}

/**
 * Resolve the executable for one provider **without starting anything**.
 *
 * @returns {{provider:string, path:string|null, candidates:string[], source:'override'|'search',
 *   reason:string|null, overrideValue:string|null}}
 */
export function resolveProviderExecutable({
  provider, platform = process.platform, env = process.env, overridePath = undefined,
} = {}) {
  const id = typeof provider === 'string' && provider.length > 0 ? provider : 'chrome';
  const envName = WEB_PROVIDER_ENV[id] ?? null;
  const raw = overridePath !== undefined
    ? overridePath
    : (envName !== null && envName in env ? env[envName] : undefined);
  const overrideValue = raw === undefined || raw === null ? null : String(raw).trim();
  if (overrideValue !== null) {
    // An explicit override is authoritative for *this* provider: when it is unusable we report it
    // and stop. Falling back to another vendor would run the wrong browser under this label.
    if (overrideValue === '' || overrideValue.includes('\0')) {
      return { provider: id, path: null, candidates: [overrideValue], source: 'override',
        reason: WEB_PROVIDER_REASONS.OVERRIDE_INVALID, overrideValue };
    }
    const usable = isAbsolute(overrideValue) || !/[\\/]/.test(overrideValue)
      ? candidateExists(overrideValue, { platform, env })
      : false;
    return {
      provider: id,
      path: usable ? overrideValue : null,
      candidates: [overrideValue],
      source: 'override',
      reason: usable ? null : WEB_PROVIDER_REASONS.OVERRIDE_INVALID,
      overrideValue,
    };
  }
  const candidates = providerExecutableCandidates({ provider: id, platform, env });
  const found = firstExistingCandidate(candidates, { platform, env });
  return {
    provider: id,
    path: found,
    candidates,
    source: 'search',
    reason: found === null ? WEB_PROVIDER_REASONS.EXECUTABLE_MISSING : null,
    overrideValue: null,
  };
}

/**
 * Confirm the product behind a live CDP endpoint is the vendor we think we started (§8: "CDP
 * connected" is not proof). `Browser.getVersion.product` is the reliable signal.
 *
 * @returns {{ok:boolean, product:string|null, expected:string}}
 */
export function verifyProviderProduct({ provider, version } = {}) {
  const rule = WEB_PROVIDER_VENDOR[provider] ?? null;
  const product = typeof version?.product === 'string' && version.product.length > 0 ? version.product : null;
  if (rule === null) {
    // Unknown provider: no rule means no way to prove identity — never let it through.
    return { ok: false, verified: false, product, expected: null, reason: WEB_PROVIDER_REASONS.PROVIDER_UNSUPPORTED };
  }
  const expected = rule.requires.join('+');
  if (product === null) {
    // "No evidence" is not "wrong evidence": non-chrome providers fail closed (their whole point is
    // catching a Chrome binary under an Edge label); chrome keeps its accepted startup path.
    return rule.failClosedOnMissing
      ? { ok: false, verified: false, product, expected, reason: WEB_PROVIDER_REASONS.IDENTITY_UNVERIFIED }
      : { ok: true, verified: false, product, expected, reason: null };
  }
  const missing = rule.requires.filter((token) => !product.includes(token));
  const forbidden = rule.forbids.filter((token) => product.includes(token));
  const ok = missing.length === 0 && forbidden.length === 0;
  return {
    ok,
    verified: true,
    product,
    expected,
    reason: ok ? null : WEB_PROVIDER_REASONS.IDENTITY_MISMATCH,
    missing,
    forbidden,
  };
}

function isPlainObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Build the ordered executable candidates for the platform.
 *
 * An explicitly configured path is authoritative: when it is missing the dependency axis reports
 * `failed` instead of silently probing unrelated installations. That keeps "configured but wrong"
 * distinguishable from "not configured, nothing found".
 */
function chromeCandidates({ chromePath, platform, env = process.env }) {
  const explicit = typeof chromePath === 'string' ? chromePath.trim() : '';
  if (explicit) return [explicit];
  if (platform === 'darwin') return [...MAC_CHROME_CANDIDATES];
  if (platform === 'win32') return windowsChromeCandidates(env);
  return [...LINUX_CHROME_CANDIDATES];
}

/** True when a candidate exists; bare names are resolved through PATH without spawning anything. */
function candidateExists(candidate, { platform, env = process.env }) {
  if (typeof candidate !== 'string' || candidate.length === 0) return false;
  if (candidate.includes('/') || candidate.includes('\\')) return existsSync(candidate);
  const separator = platform === 'win32' ? ';' : delimiter;
  const pathValue = env.PATH ?? env.Path ?? '';
  return pathValue
    .split(separator)
    .filter((dir) => dir.length > 0)
    .some((dir) => existsSync(join(dir, candidate)));
}

function firstExistingCandidate(candidates, options) {
  for (const candidate of candidates) {
    if (candidateExists(candidate, options)) return candidate;
  }
  return null;
}

/** Normalize the injected registry's entries without assuming one container type. */
function registryEntries(registry) {
  const entries = registry?.entries;
  if (!entries) return [];
  if (Array.isArray(entries)) return entries.filter(isPlainObject);
  if (typeof entries.values === 'function') {
    try {
      return [...entries.values()].filter(isPlainObject);
    } catch {
      return [];
    }
  }
  return [];
}

function entryScopeId(entry) {
  const scope = entry?.scope;
  if (typeof scope === 'string' && scope.length > 0) return scope;
  if (isPlainObject(scope) && typeof scope.id === 'string' && scope.id.length > 0) return scope.id;
  if (typeof entry?.scopeId === 'string' && entry.scopeId.length > 0) return entry.scopeId;
  return null;
}

function entryGroup(entry) {
  const group = entry?.group ?? entry?.workspaceGroup ?? entry?.scope?.group;
  return typeof group === 'string' && group.length > 0 ? group : null;
}

function entryUrl(entry) {
  const url = entry?.runtime?.url ?? entry?.url;
  return typeof url === 'string' && url.length > 0 ? url : null;
}

function entryTargetId(entry) {
  const candidates = [entry?.tabId, entry?.runtimeId, entry?.targetId, entry?.id];
  for (const value of candidates) {
    if (typeof value === 'string' && value.length > 0) return value;
  }
  return null;
}

function entryCreatedAt(entry) {
  const value = entry?.createdAt ?? entry?.runtime?.createdAt;
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

function entryLabel(entry) {
  const label = entry?.label ?? entry?.title ?? entryUrl(entry) ?? entryTargetId(entry);
  return typeof label === 'string' && label.length > 0 ? label : null;
}

/** True when an entry belongs to the session's scope or to the same web workspace group. */
function entryBelongsToScope(entry, scope) {
  const scopeId = typeof scope === 'string' ? scope : scope?.id;
  const entryScope = entryScopeId(entry);
  if (entryScope !== null && scopeId && entryScope === scopeId) return true;
  const group = entryGroup(entry);
  const scopeGroup = isPlainObject(scope) ? scope.group ?? scope.workspaceGroup : null;
  return Boolean(group && scopeGroup && group === scopeGroup);
}

function findScopeEntry(registry, scope) {
  return registryEntries(registry).find((entry) => entryBelongsToScope(entry, scope)) ?? null;
}

/**
 * Generation for a target identity.
 *
 * Derived from `createdAt` ordering plus the entry's ordinal, then cached per session so the same
 * target keeps the same generation even if the registry reorders its entries. A generation is an
 * observation of the target, never a fabricated "version".
 */
function assignTargetGenerations(entries, cache) {
  const ordered = [...entries].sort((left, right) => {
    const byCreatedAt = entryCreatedAt(left) - entryCreatedAt(right);
    if (byCreatedAt !== 0) return byCreatedAt;
    return String(entryTargetId(left) ?? '').localeCompare(String(entryTargetId(right) ?? ''));
  });
  for (const entry of ordered) {
    const targetId = entryTargetId(entry);
    if (targetId === null || cache.has(targetId)) continue;
    cache.set(targetId, cache.size + 1);
  }
  return cache;
}

function enabledEnvironmentsOf(snapshot) {
  const list = snapshot?.enabledEnvironments ?? snapshot?.global?.enabledEnvironments;
  return Array.isArray(list) ? list : [];
}

function configRevisionOf(snapshot) {
  const revision = snapshot?.revision ?? snapshot?.configRevision;
  return Number.isInteger(revision) ? revision : null;
}

function capabilityListOf(snapshot) {
  const list = snapshot?.capabilities;
  return Array.isArray(list) ? list.filter((id) => typeof id === 'string') : null;
}

/** Map a platform error onto the shared taxonomy, preserving a known `code`. */
function toAdapterError(error, { operation, fallback = ERROR_CODES.INTERNAL } = {}) {
  if (error instanceof AdapterError) return error;
  // A platform-typed error (BrowserError and its wider taxonomy: NAV_FAILED/BUSY/REF_STALE/...)
  // is rethrown untouched. Wrapping it in AdapterError would normalize the platform code to
  // INTERNAL, and the tool boundary must preserve the stable code it has always exposed.
  if (typeof error?.code === 'string' && error.code.length > 0) return error;
  const code = fallback;
  const message = error instanceof Error && error.message
    ? error.message
    : typeof error === 'string' && error.length > 0
      ? error
      : 'web adapter operation failed';
  const details = { operation: operation ?? null };
  if (isPlainObject(error?.details)) Object.assign(details, error.details);
  if (error instanceof Error) details.causeName = error.name;
  return new AdapterError(code, message, {
    details,
    cause: error instanceof Error ? error : undefined,
  });
}

/** CONFIG_STALE (M0 §2.1): a step must never execute against a different config revision. */
function configStaleError({ sessionRevision, snapshotRevision, sessionId }) {
  return new AdapterError(
    ERROR_CODES.CONFIG_STALE,
    `session config revision ${String(sessionRevision)} does not match snapshot revision ${String(snapshotRevision)}`,
    { details: { sessionId: sessionId ?? null, sessionRevision, snapshotRevision } },
  );
}

function assertNotAborted(signal, operation) {
  if (signal?.aborted) {
    throw new AdapterError(ERROR_CODES.INTERNAL, `${operation} aborted before completion`, {
      details: { operation, reason: 'aborted' },
    });
  }
}

function createTargetAdapterManifest() {
  return {
    contractVersion: CONTRACT_VERSION,
    id: 'web',
    class: 'target',
    environment: 'web',
    displayName: 'Web / Chromium',
    capabilities: [...WEB_CAPABILITIES],
    dependencies: [{ id: 'chromium', kind: 'executable', required: true, version: null }],
    visibility: 'user',
  };
}

function createCapabilityAdapterManifest() {
  return {
    contractVersion: CONTRACT_VERSION,
    id: 'web.capability',
    class: 'capability',
    environment: 'web',
    capabilities: [...WEB_CAPABILITIES],
    operations: WEB_TOOL_OPERATION_SPECS.map((entry) => ({ ...entry })),
  };
}

/**
 * Create the web TargetAdapter.
 *
 * @param {object} [options]
 * @param {object} [options.registry] Shared runtime registry (read-only here). Entries describe
 *   discovered targets; `registry.host` means a runtime exists but has not been handshaked.
 * @param {object} [options.log] Optional logger (`debug`/`warn`); never receives user config.
 * @param {() => number} [options.now] Clock injection for `checkedAt`.
 * @param {string} [options.chromePath] Explicit Chromium executable (defaults to
 *   `DSH_UI_TESTING_CHROME`). When set, it is authoritative and no fallback is probed.
 * @param {string} [options.platform] `process.platform` override (test seam).
 * @param {(input: object) => Promise<object>|object} [options.capabilityAvailability] Optional
 *   live capability probe; without it the capability axis stays `not-probed`.
 */
export function createWebTargetAdapter({
  registry,
  log,
  now = Date.now,
  chromePath = process.env.DSH_UI_TESTING_CHROME,
  platform = process.platform,
  capabilityAvailability,
} = {}) {
  const manifest = createTargetAdapterManifest();
  const sessions = new Map();
  let disposed = false;

  function assertNotDisposed() {
    if (disposed) {
      throw new AdapterError(ERROR_CODES.ADAPTER_DISABLED, 'web target adapter is disposed', {
        details: { adapterId: manifest.id },
      });
    }
  }

  async function createSession({ scope, snapshot, signal } = {}) {
    assertNotDisposed();
    assertNotAborted(signal, 'createSession');
    if (!isPlainObject(scope) || typeof scope.id !== 'string' || scope.id.length === 0) {
      throw new AdapterError(ERROR_CODES.INVALID_ARGUMENT, 'createSession requires a scope with an id', {
        details: { field: 'scope' },
      });
    }

    const driver = assertDriverAllowed(resolveWebDriver(snapshot), 'createSession');
    const sessionId = `web:${scope.id}`;
    const generationCache = new Map();
    const state = {
      sessionId,
      environment: 'web',
      // Runtime provider this session talks to. The facade identity stays `web`.
      provider: driver.provider,
      executionAdapterId: driver.executionAdapterId,
      generation: 1,
      configRevision: configRevisionOf(snapshot),
      target: null,
      closed: false,
      disposed: false,
      scope,
    };

    function assertOpen() {
      if (state.disposed || state.closed) {
        throw new AdapterError(ERROR_CODES.TARGET_GONE, `web session ${sessionId} is closed`, {
          details: { sessionId },
        });
      }
    }

    function collectIdentities() {
      const entries = registryEntries(registry).filter((entry) => entryBelongsToScope(entry, scope));
      assignTargetGenerations(entries, generationCache);
      const identities = [];
      for (const entry of entries) {
        const targetId = entryTargetId(entry);
        if (targetId === null) continue;
        identities.push(newTargetIdentity({
          targetId,
          environment: 'web',
          kind: 'page',
          generation: generationCache.get(targetId) ?? null,
          label: entryLabel(entry),
          lifecycle: typeof entry?.lifecycle === 'string' ? entry.lifecycle : 'live',
        }));
      }
      return identities;
    }

    const session = {
      sessionId,
      environment: state.environment,
      provider: state.provider,
      executionAdapterId: state.executionAdapterId,
      scopeId: scope.id,
      get generation() {
        return state.generation;
      },
      get configRevision() {
        return state.configRevision;
      },
      get target() {
        return state.target;
      },
      get closed() {
        return state.closed;
      },
      async listTargets({ signal: listSignal } = {}) {
        assertNotAborted(listSignal, 'listTargets');
        assertOpen();
        return collectIdentities();
      },
      async bind(targetId, { signal: bindSignal } = {}) {
        assertNotAborted(bindSignal, 'bind');
        assertOpen();
        if (typeof targetId !== 'string' || targetId.length === 0) {
          throw new AdapterError(ERROR_CODES.INVALID_ARGUMENT, 'bind requires a targetId', {
            details: { field: 'targetId' },
          });
        }
        const identity = collectIdentities().find((candidate) => candidate.targetId === targetId);
        if (!identity) {
          throw new AdapterError(ERROR_CODES.TARGET_NOT_BOUND, `web target '${targetId}' is not available`, {
            details: { targetId, sessionId },
          });
        }
        state.generation += 1;
        state.target = identity;
        return identity;
      },
      async close({ signal: closeSignal } = {}) {
        assertNotAborted(closeSignal, 'close');
        if (state.closed) return;
        state.closed = true;
      },
      async dispose() {
        if (state.disposed) return;
        state.disposed = true;
        state.closed = true;
        state.target = null;
      },
    };

    sessions.set(sessionId, session);
    return session;
  }

  async function probe({ scope, snapshot, signal } = {}) {
    assertNotDisposed();
    if (signal?.aborted) {
      throw new AdapterError(ERROR_CODES.PROBE_TIMEOUT, 'web probe aborted before completion');
    }

    const checkedAt = typeof now === 'function' ? now() : Date.now();
    const enabled = enabledEnvironmentsOf(snapshot).includes('web');

    const driver = resolveWebDriver(snapshot);
    // Only the chrome vendor resolver exists in this slice. Reporting another provider from the
    // Chrome candidate list would fabricate a dependency observation (§8: CDP connecting is not
    // proof of the product), so a non-chrome provider answers `not-probed` with a named reason.
    const resolution = resolveProviderExecutable({
      provider: driver.provider,
      platform,
      // The adapter-level `chromePath` option stays authoritative for chrome (test seam + config).
      overridePath: driver.provider === DEFAULT_WEB_PROVIDER ? chromePath : undefined,
    });
    const candidates = resolution.candidates;
    const found = resolution.path;
    // No version is ever invented: `version: null` means "not observed", not "unknown but assumed".
    const dependencyEvidence = {
      id: driver.provider === DEFAULT_WEB_PROVIDER ? 'chromium' : driver.provider,
      kind: 'executable',
      provider: driver.provider,
      // Resolved path is evidence, never a secret; version stays null unless it was observed
      // without starting a browser (probe must not launch anything).
      path: found,
      version: null,
    };
    // A provider without a driver is not probed at all: `pending` says "driver not wired yet",
    // `unsupported` says "no driver planned". Neither borrows chrome's evidence (§8).
    const providerDependency = driver.blocked === WEB_PROVIDER_REASONS.DRIVER_PENDING
      ? WEB_PROVIDER_REASONS.DRIVER_PENDING
      : (driver.blocked === WEB_PROVIDER_REASONS.PROVIDER_UNSUPPORTED
        || driver.blocked === WEB_PROVIDER_REASONS.UNKNOWN_PROVIDER
        ? WEB_PROVIDER_REASONS.PROVIDER_UNSUPPORTED
        : WEB_PROVIDER_REASONS.DRIVER_PENDING);
    // A provider with a driver is probed with *its own* resolver (edge has its own candidate list),
    // so "implemented but executable missing" is distinguishable from "not probed".
    const dependency = !driver.implemented
      ? axis(READINESS_STATUS.NOT_PROBED, {
        reason: providerDependency,
        checkedAt,
        evidence: dependencyEvidence,
      })
      : (found === null
        ? axis(READINESS_STATUS.FAILED, {
          reason: 'executable-missing',
          checkedAt,
          evidence: dependencyEvidence,
        })
        : axis(READINESS_STATUS.OK, { checkedAt, evidence: dependencyEvidence }));

    const host = registry?.host ?? null;
    const entry = findScopeEntry(registry, scope);
    const runtime = entry?.runtime ?? null;
    // A13: "connection" answers "is a transport actually attached", never "is the executable
    // installed". An idle host (process running, no page/session attached) is *not* a connection.
    const transport = runtime && runtime.cdp && runtime.cdp.closed !== true
      ? axis(READINESS_STATUS.OK, {
        reason: null,
        checkedAt,
        evidence: {
          kind: 'transport',
          transport: typeof runtime.transport === 'string' ? runtime.transport : (runtime.send ? 'ws' : null),
          runtimeId: typeof runtime.runtimeId === 'string' ? runtime.runtimeId : null,
          closed: false,
        },
      })
      : (host
        ? axis(READINESS_STATUS.NOT_PROBED, { reason: 'host-idle-no-transport', checkedAt })
        : axis(READINESS_STATUS.NOT_PROBED, { reason: 'cold', checkedAt }));
    const connection = transport;

    const targetId = entry ? entryTargetId(entry) : null;
    const expectedTargetId = typeof snapshot?.targetId === 'string' && snapshot.targetId.length > 0
      ? snapshot.targetId
      : null;
    // A13 identity: a configured target that is not the entry this scope actually resolves is a
    // *wrong identity*, not a bound target.
    const identityMismatch = expectedTargetId !== null && targetId !== null && expectedTargetId !== targetId;
    const target = entry !== null && entryUrl(entry) !== null && targetId !== null
      ? (identityMismatch
        ? axis(READINESS_STATUS.STALE, {
          reason: 'identity-mismatch',
          checkedAt,
          target: { targetId, generation: assignTargetGenerations([entry], new Map()).get(targetId) ?? null },
          evidence: { kind: 'identity', expectedTargetId, actualTargetId: targetId },
        })
        : axis(READINESS_STATUS.BOUND, {
          target: { targetId, generation: assignTargetGenerations([entry], new Map()).get(targetId) ?? null },
          checkedAt,
          evidence: { kind: 'identity', targetId },
        }))
      : axis(READINESS_STATUS.UNBOUND, { reason: 'no-target', checkedAt });

    const capability = await probeCapabilityAxis({
      scope,
      snapshot,
      signal,
      entry,
      checkedAt,
    });

    const report = createReadinessReport({
      environment: 'web',
      snapshot,
      adapter: { manifest },
      now: checkedAt,
      axes: {
        support: axis(SUPPORT.SUPPORTED, { checkedAt }),
        enabled: axis(enabled ? READINESS_STATUS.OK : READINESS_STATUS.DISABLED, {
          reason: enabled ? null : 'environment-disabled',
          checkedAt,
        }),
        dependency,
        connection,
        target,
        capability,
      },
    });

    log?.debug?.('web.probe', {
      enabled,
      dependency: dependency.status,
      connection: connection.status,
      target: target.status,
    });
    return report;
  }

  async function probeCapabilityAxis({ scope, snapshot, signal, entry, checkedAt }) {
    if (typeof capabilityAvailability !== 'function') {
      const derived = entry?.capabilityStatus ?? registry?.capabilityStatus;
      if (typeof derived === 'string' && derived.length > 0) {
        return axis(normalizeReadinessStatus(derived), { checkedAt });
      }
      if (isPlainObject(derived) && typeof derived.status === 'string') {
        return axis(normalizeReadinessStatus(derived.status), {
          reason: typeof derived.reason === 'string' ? derived.reason : null,
          checkedAt,
        });
      }
      return axis(READINESS_STATUS.NOT_PROBED, { reason: 'not-probed', checkedAt });
    }

    let raw;
    try {
      raw = await capabilityAvailability({ scope, snapshot, signal, entry, registry });
    } catch (error) {
      throw toAdapterError(error, { operation: 'probe.capability', fallback: ERROR_CODES.PROBE_TIMEOUT });
    }
    if (typeof raw === 'string') {
      return axis(normalizeReadinessStatus(raw), { checkedAt });
    }
    if (isPlainObject(raw)) {
      const status = typeof raw.status === 'string' ? raw.status : READINESS_STATUS.NOT_PROBED;
      // A13: the capability axis is the *union* of independent checks (structure / input /
      // network / frames / identity). Its detail must survive to the caller, otherwise the page
      // can only show one opaque word instead of which capability is missing.
      return axis(normalizeReadinessStatus(status), {
        reason: typeof raw.reason === 'string' ? raw.reason : null,
        checkedAt,
        target: isPlainObject(raw.target) ? raw.target : null,
        evidence: isPlainObject(raw.evidence) ? raw.evidence : null,
      });
    }
    return axis(READINESS_STATUS.NOT_PROBED, { reason: 'not-probed', checkedAt });
  }

  async function dispose() {
    if (disposed) return;
    disposed = true;
    for (const session of sessions.values()) {
      await session.dispose();
    }
    sessions.clear();
    // The shared registry/runtime is owned by the composition root; dispose never closes it.
  }

  return { manifest, probe, createSession, dispose };
}

/**
 * The capability axis speaks `available|partial|unavailable|unsupported|not-probed` (M0 §5.2),
 * which is not the same vocabulary as the other five axes. Both are accepted here; anything else
 * degrades to `not-probed` instead of inventing readiness.
 */
const CAPABILITY_AXIS_STATUSES = new Set([
  'available',
  'partial',
  'unavailable',
  'unsupported',
  'not-probed',
  'busy',
]);

function normalizeReadinessStatus(status) {
  if (status === true) return READINESS_STATUS.OK;
  if (status === false) return READINESS_STATUS.FAILED;
  if (typeof status === 'string'
    && (Object.values(READINESS_STATUS).includes(status) || CAPABILITY_AXIS_STATUSES.has(status))) {
    return status;
  }
  return READINESS_STATUS.NOT_PROBED;
}

/**
 * Create the web CapabilityAdapter.
 *
 * `dispatch` is injected by the composition root and owns the actual Chromium/CDP work:
 * `dispatch({ operation, args, session, snapshot, signal, executionClass, context })`.
 * `context` carries the composition root's execution environment (runtime/meta/httpClient); the
 * dispatch is expected to call `context.execute()` after it applied the execution class. `context`
 * is passed through untouched and never enters evidence or public identity.
 *
 * @param {object} [options]
 * @param {(input: object) => Promise<unknown>|unknown} [options.dispatch]
 * @param {object} [options.log]
 * @param {() => number} [options.now]
 */
export function createWebCapabilityAdapter({ dispatch, log, now = Date.now } = {}) {
  const manifest = createCapabilityAdapterManifest();
  let disposed = false;

  function assertNotDisposed() {
    if (disposed) {
      throw new AdapterError(ERROR_CODES.ADAPTER_DISABLED, 'web capability adapter is disposed', {
        details: { adapterId: manifest.id },
      });
    }
  }

  function assertSessionPresent(session) {
    if (!isPlainObject(session)) {
      throw new AdapterError(ERROR_CODES.TARGET_NOT_BOUND, 'web capability requires a session', {
        details: { reason: 'session-missing' },
      });
    }
    if (session.closed === true) {
      throw new AdapterError(ERROR_CODES.TARGET_GONE, `web session ${String(session.sessionId)} is closed`, {
        details: { sessionId: session.sessionId ?? null },
      });
    }
  }

  /** Page-level work needs a bound target; host-level work does not (A06 regression guard). */
  function assertTargetForClass(session, executionClass) {
    if (!TARGET_BOUND_CLASSES.has(executionClass)) return;
    if (!session.target) {
      throw new AdapterError(ERROR_CODES.TARGET_NOT_BOUND, 'web capability requires a bound target', {
        details: { sessionId: session.sessionId ?? null, executionClass },
      });
    }
  }

  function availabilityOf(operation, { session, snapshot } = {}) {
    if (isPlainObject(session) && session.closed === true) {
      return { support: SUPPORT.SUPPORTED, availability: AVAILABILITY.UNAVAILABLE, reason: 'target-gone' };
    }
    // A provider that cannot run (disabled / unknown / not implemented) makes every operation of
    // this environment unavailable — it is never answered from another browser's state.
    const driver = resolveWebDriver(snapshot);
    if (driver.blocked !== null) {
      return { support: SUPPORT.SUPPORTED, availability: AVAILABILITY.UNAVAILABLE, reason: driver.blocked };
    }
    // Only page/tabs work depends on a bound target; the rest is judged from the config snapshot so
    // a target-free tool is never reported as "not probed" just because no page is attached.
    const declaredClass = SPEC_BY_NAME.get(operation)?.executionClass;
    if (TARGET_BOUND_CLASSES.has(declaredClass)
      && (!isPlainObject(session) || !session.target)) {
      return { support: SUPPORT.SUPPORTED, availability: AVAILABILITY.NOT_PROBED, reason: 'target-unbound' };
    }
    const capabilities = capabilityListOf(snapshot);
    if (capabilities === null) {
      return { support: SUPPORT.SUPPORTED, availability: AVAILABILITY.NOT_PROBED, reason: 'capability-unknown' };
    }
    if (!capabilities.includes(WEB_TOOL_OPERATIONS[operation])) {
      return { support: SUPPORT.SUPPORTED, availability: AVAILABILITY.UNAVAILABLE, reason: 'capability-disabled' };
    }
    return { support: SUPPORT.SUPPORTED, availability: AVAILABILITY.AVAILABLE, reason: null };
  }

  return {
    manifest,

    operationStatus({ session, snapshot } = {}) {
      const out = {};
      for (const operation of WEB_TOOL_OPERATION_NAMES) {
        out[operation] = availabilityOf(operation, { session, snapshot });
      }
      return out;
    },

    /**
     * Validate argument shape and expose the execution class the composition root should route.
     *
     * @param {object|undefined} args
     * @param {string|{operation?:string}} [operation] Optional operation (needed for action-level
     *   classes such as `browser_viewport` get vs set).
     * @returns {{ok:true, executionClass:string|null}}
     */
    preflight(args, operation) {
      if (args !== undefined && args !== null && !isPlainObject(args)) {
        throw new AdapterError(ERROR_CODES.INVALID_ARGUMENT, 'operation args must be a plain object', {
          details: { field: 'args', type: Array.isArray(args) ? 'array' : typeof args },
        });
      }
      const operationName = typeof operation === 'string' ? operation : operation?.operation ?? null;
      const executionClass = operationName === null
        ? null
        : resolveExecutionClass(operationName, args ?? {});
      return { ok: true, executionClass };
    },

    async invoke({ operation, args, session, snapshot, signal, executionClass, context } = {}) {
      assertNotDisposed();
      if (typeof operation !== 'string' || !SPEC_BY_NAME.has(operation)) {
        throw new AdapterError(ERROR_CODES.CAPABILITY_UNSUPPORTED, `unknown web operation '${String(operation)}'`, {
          details: { operation: operation ?? null },
        });
      }
      assertSessionPresent(session);

      // Provider gate before any dispatch work (§4.4): disabled -> ADAPTER_DISABLED,
      // unknown / not implemented -> ADAPTER_UNSUPPORTED. No silent browser substitution.
      const driver = assertDriverAllowed(resolveWebDriver(snapshot), operation);

      const snapshotRevision = configRevisionOf(snapshot);
      const sessionRevision = Number.isInteger(session.configRevision) ? session.configRevision : null;
      if (snapshotRevision !== null && sessionRevision !== snapshotRevision) {
        throw configStaleError({
          sessionRevision,
          snapshotRevision,
          sessionId: session.sessionId ?? null,
        });
      }

      const allowedClasses = executionClassesOf(operation);
      if (executionClass !== undefined && executionClass !== null
        && !allowedClasses.includes(executionClass)) {
        throw new AdapterError(
          ERROR_CODES.INVALID_ARGUMENT,
          `operation '${operation}' does not allow executionClass '${String(executionClass)}'`,
          { details: { operation, executionClass, allowedClasses } },
        );
      }
      const effectiveClass = executionClass ?? resolveExecutionClass(operation, args ?? {});
      assertTargetForClass(session, effectiveClass);

      const capability = WEB_TOOL_OPERATIONS[operation];
      const capabilities = capabilityListOf(snapshot);
      if (capabilities === null || !capabilities.includes(capability)) {
        throw new AdapterError(
          ERROR_CODES.ADAPTER_DISABLED,
          `capability '${capability}' is not enabled for operation '${operation}'`,
          { details: { operation, capability, reason: 'capability-disabled' } },
        );
      }
      if (typeof dispatch !== 'function') {
        throw new AdapterError(ERROR_CODES.PROVIDER_UNAVAILABLE, 'web capability dispatch is not injected', {
          details: { operation },
        });
      }

      let raw;
      try {
        raw = await dispatch({
          operation,
          args: args === undefined ? {} : args,
          session,
          snapshot,
          signal,
          executionClass: effectiveClass,
          context,
          // Explicit routing facts: the composition root must execute this call on the provider's
          // own runtime, never on whichever browser happens to be running.
          provider: driver.provider,
          executionAdapterId: driver.executionAdapterId,
        });
      } catch (error) {
        throw toAdapterError(error, { operation });
      }

      const value = isPlainObject(raw) && Object.hasOwn(raw, 'value') ? raw.value : raw;
      const evidence = createEvidenceEnvelope({
        scope: session.scopeId ?? null,
        session: session.sessionId ?? null,
        target: session.target?.targetId ?? null,
        generation: Number.isInteger(session.generation) ? session.generation : null,
        configRevision: snapshotRevision ?? sessionRevision,
        operation,
        source: 'web',
        capturedAt: typeof now === 'function' ? now() : Date.now(),
      });

      log?.debug?.('web.invoke', { operation, capability, executionClass: effectiveClass });
      return { value, evidence };
    },

    async dispose() {
      if (disposed) return;
      disposed = true;
    },
  };
}

/** Guard against a spec table drift: every declared class must be a known execution class. */
for (const entry of WEB_TOOL_OPERATION_SPECS) {
  for (const executionClass of entry.executionClasses ?? [entry.executionClass]) {
    if (!EXECUTION_CLASS_SET.has(executionClass)) {
      throw new Error(`web adapter spec for ${entry.name} uses unknown executionClass '${executionClass}'`);
    }
  }
}
