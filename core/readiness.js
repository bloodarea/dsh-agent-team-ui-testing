/**
 * Readiness reports with six independent axes (M0 §5.2).
 *
 * Support / enabled / dependency / connection / target / capability answer different questions
 * and are never collapsed into one boolean. A missing observation is `not-probed`, never `ok`.
 */
import {
  CONTRACT_VERSION,
  ERROR_CODES,
  READINESS_AXES,
  READINESS_STATUS,
  SUPPORT,
} from './contracts.js';
import { AdapterError } from './errors.js';

/** Default probe freshness window. */
export const DEFAULT_TTL_MS = 30000;

const AXIS_SET = new Set(READINESS_AXES);

function isPlainObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Build one axis entry.
 *
 * @param {string} status
 * @param {{reason?:string|null, checkedAt?:number|null, expiresAt?:number|null,
 *   target?:object|null, evidence?:object|null}} [options]
 */
export function axis(status, {
  reason = null,
  checkedAt = null,
  expiresAt = null,
  target = null,
  evidence = null,
} = {}) {
  if (typeof status !== 'string' || status.length === 0) {
    throw new AdapterError(ERROR_CODES.INVALID_ARGUMENT, 'axis status must be a non-empty string', {
      details: { field: 'status' },
    });
  }
  return { status, reason, checkedAt, expiresAt, target, evidence };
}

/** All six axes as `not-probed` with the same reason. */
export function buildNotProbedAxes(reason = 'not-probed') {
  const axes = {};
  for (const name of READINESS_AXES) axes[name] = axis(READINESS_STATUS.NOT_PROBED, { reason });
  return axes;
}

function resolveNow(now) {
  if (typeof now === 'function') {
    const value = now();
    return typeof value === 'number' && Number.isFinite(value) ? value : null;
  }
  if (typeof now === 'number' && Number.isFinite(now)) return now;
  return null;
}

function normalizeAxisValue(value, name, fallbackCheckedAt) {
  if (typeof value === 'string') return axis(value, { checkedAt: fallbackCheckedAt });
  if (!isPlainObject(value)) {
    throw new AdapterError(ERROR_CODES.INVALID_ARGUMENT, `readiness axis ${name} must be an object or status string`, {
      details: { axis: name },
    });
  }
  return axis(value.status, {
    reason: value.reason ?? null,
    checkedAt: value.checkedAt ?? fallbackCheckedAt,
    expiresAt: value.expiresAt ?? null,
    target: value.target ?? null,
    evidence: value.evidence ?? null,
  });
}

/**
 * Create a six-axis readiness report. Missing axes are filled with `not-probed`; configuration
 * facts (enabled/target) and adapter registration (support) are used only when explicitly
 * derivable, never guessed.
 *
 * @param {{environment:string, snapshot?:object, adapter?:object, axes?:object,
 *   now?:number|Function}} input
 */
export function createReadinessReport({ environment, snapshot = null, adapter = null, axes = null, now = null } = {}) {
  if (typeof environment !== 'string' || environment.length === 0) {
    throw new AdapterError(ERROR_CODES.INVALID_ARGUMENT, 'readiness report requires an environment', {
      details: { field: 'environment' },
    });
  }
  const checkedAt = resolveNow(now);
  const merged = buildNotProbedAxes('not-probed');

  if (adapter && isPlainObject(adapter.manifest)) {
    merged.support = axis(
      adapter.manifest.contractVersion === CONTRACT_VERSION ? SUPPORT.SUPPORTED : SUPPORT.UNSUPPORTED,
      { checkedAt },
    );
  }
  if (isPlainObject(snapshot)) {
    const enabled = Array.isArray(snapshot.enabledEnvironments)
      && snapshot.enabledEnvironments.includes(environment);
    merged.enabled = axis(enabled ? READINESS_STATUS.OK : READINESS_STATUS.DISABLED, {
      reason: enabled ? null : 'environment-disabled',
      checkedAt,
    });
    const bound = typeof snapshot.targetId === 'string' && snapshot.targetId.length > 0;
    merged.target = axis(bound ? READINESS_STATUS.BOUND : READINESS_STATUS.UNBOUND, {
      reason: bound ? null : 'target-not-bound',
      checkedAt,
      target: bound ? { targetId: snapshot.targetId, generation: snapshot.targetGeneration ?? null } : null,
    });
    if (Array.isArray(snapshot.capabilities) && snapshot.capabilities.length === 0) {
      merged.capability = axis(READINESS_STATUS.UNSUPPORTED, {
        reason: 'no-capabilities',
        checkedAt,
      });
    }
  }

  if (axes !== null && axes !== undefined) {
    if (!isPlainObject(axes)) {
      throw new AdapterError(ERROR_CODES.INVALID_ARGUMENT, 'axes must be an object', {
        details: { field: 'axes' },
      });
    }
    for (const [name, value] of Object.entries(axes)) {
      if (!AXIS_SET.has(name)) {
        throw new AdapterError(ERROR_CODES.INVALID_ARGUMENT, `unknown readiness axis: ${name}`, {
          details: { axis: name },
        });
      }
      merged[name] = normalizeAxisValue(value, name, checkedAt);
    }
  }

  return {
    environment,
    configRevision: isPlainObject(snapshot)
      ? (snapshot.revision ?? snapshot.configRevision ?? null)
      : null,
    checkedAt,
    axes: merged,
  };
}

/**
 * Merge a probe result into a report without mutating either input.
 *
 * @param {object} report
 * @param {{axes?:object, checkedAt?:number, configRevision?:number, environment?:string}|object} probeResult
 *   A bare axes map is also accepted.
 */
export function mergeProbeResult(report, probeResult) {
  if (!isPlainObject(report) || !isPlainObject(report.axes)) {
    throw new AdapterError(ERROR_CODES.INVALID_ARGUMENT, 'report must contain axes', {
      details: { field: 'report' },
    });
  }
  const probe = isPlainObject(probeResult) ? probeResult : {};
  const patch = isPlainObject(probe.axes) ? probe.axes : probe;
  const axes = { ...report.axes };
  for (const [name, value] of Object.entries(patch)) {
    if (!AXIS_SET.has(name)) continue;
    axes[name] = normalizeAxisValue(value, name, report.checkedAt ?? null);
  }
  return {
    environment: probe.environment ?? report.environment,
    configRevision: probe.configRevision ?? report.configRevision ?? null,
    checkedAt: probe.checkedAt ?? report.checkedAt ?? null,
    axes,
  };
}
