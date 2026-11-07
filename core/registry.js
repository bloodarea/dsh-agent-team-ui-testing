/**
 * Adapter registry for the three adapter classes (M0 §2).
 *
 * Registration validates manifest class/contractVersion and rejects duplicate ids. Resolution is
 * driven solely by the config snapshot: the same snapshot selects the target adapter, capability
 * adapters and P0 providers for one environment.
 */
import {
  ADAPTER_CLASSES,
  AVAILABILITY,
  CONTRACT_VERSION,
  ENVIRONMENTS,
  ERROR_CODES,
  SUPPORT,
} from './contracts.js';
import { AdapterError } from './errors.js';

const KNOWN_ENVIRONMENTS = new Set(Object.values(ENVIRONMENTS));

function isPlainObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function assertManifest(adapter, expectedClass) {
  if (!isPlainObject(adapter)) {
    throw new AdapterError(ERROR_CODES.CONFIG_INVALID, 'adapter must be an object', {
      details: { field: 'adapter' },
    });
  }
  const manifest = adapter.manifest;
  if (!isPlainObject(manifest)) {
    throw new AdapterError(ERROR_CODES.CONFIG_INVALID, 'adapter.manifest must be an object', {
      details: { field: 'manifest' },
    });
  }
  if (manifest.contractVersion !== CONTRACT_VERSION) {
    throw new AdapterError(ERROR_CODES.ADAPTER_UNSUPPORTED, 'unsupported adapter contract version', {
      details: { expected: CONTRACT_VERSION, actual: manifest.contractVersion ?? null, id: manifest.id ?? null },
    });
  }
  if (manifest.class !== expectedClass) {
    throw new AdapterError(ERROR_CODES.CONFIG_INVALID, `adapter manifest.class must be ${expectedClass}`, {
      details: { expected: expectedClass, actual: manifest.class ?? null, id: manifest.id ?? null },
    });
  }
  if (typeof manifest.id !== 'string' || manifest.id.length === 0) {
    throw new AdapterError(ERROR_CODES.CONFIG_INVALID, 'adapter manifest.id must be a non-empty string', {
      details: { field: 'manifest.id' },
    });
  }
  if (typeof manifest.environment !== 'string' || !KNOWN_ENVIRONMENTS.has(manifest.environment)) {
    throw new AdapterError(ERROR_CODES.CONFIG_INVALID, 'adapter manifest.environment is not a known environment', {
      details: { field: 'manifest.environment', value: manifest.environment ?? null },
    });
  }
  if (manifest.capabilities !== undefined) {
    if (!Array.isArray(manifest.capabilities)
      || manifest.capabilities.some((id) => typeof id !== 'string' || id.length === 0)) {
      throw new AdapterError(ERROR_CODES.CONFIG_INVALID, 'adapter manifest.capabilities must be an array of strings', {
        details: { id: manifest.id },
      });
    }
  }
  return manifest;
}

function aggregateAvailability(entries) {
  if (!Array.isArray(entries) || entries.length === 0) {
    return { availability: AVAILABILITY.NOT_PROBED, reason: null };
  }
  const values = entries.map((entry) => entry?.availability).filter(Boolean);
  if (values.includes(AVAILABILITY.AVAILABLE)) return { availability: AVAILABILITY.AVAILABLE, reason: null };
  if (values.includes(AVAILABILITY.BUSY)) return { availability: AVAILABILITY.BUSY, reason: null };
  if (values.length > 0 && values.every((value) => value === AVAILABILITY.UNAVAILABLE)) {
    const reason = entries.find((entry) => entry?.reason)?.reason ?? null;
    return { availability: AVAILABILITY.UNAVAILABLE, reason };
  }
  return { availability: AVAILABILITY.NOT_PROBED, reason: null };
}

/**
 * Registry for TargetAdapter / CapabilityAdapter / P0Provider instances.
 */
export class AdapterRegistry {
  constructor() {
    this._targets = new Map();
    this._capabilities = new Map();
    this._providers = new Map();
  }

  /** Register one TargetAdapter per environment. */
  registerTargetAdapter(adapter) {
    const manifest = assertManifest(adapter, ADAPTER_CLASSES.TARGET);
    if (this._targets.has(manifest.environment)) {
      throw new AdapterError(ERROR_CODES.CONFIG_INVALID, 'duplicate target adapter for environment', {
        details: { environment: manifest.environment, id: manifest.id },
      });
    }
    this._targets.set(manifest.environment, adapter);
    return adapter;
  }

  /** Register a CapabilityAdapter; ids are unique within one environment. */
  registerCapabilityAdapter(adapter) {
    const manifest = assertManifest(adapter, ADAPTER_CLASSES.CAPABILITY);
    const forEnvironment = this._capabilities.get(manifest.environment) ?? new Map();
    if (forEnvironment.has(manifest.id)) {
      throw new AdapterError(ERROR_CODES.CONFIG_INVALID, 'duplicate capability adapter id', {
        details: { environment: manifest.environment, id: manifest.id },
      });
    }
    forEnvironment.set(manifest.id, adapter);
    this._capabilities.set(manifest.environment, forEnvironment);
    return adapter;
  }

  /** Register a P0Provider; ids are unique within one environment. */
  registerP0Provider(provider) {
    const manifest = assertManifest(provider, ADAPTER_CLASSES.P0);
    const forEnvironment = this._providers.get(manifest.environment) ?? new Map();
    if (forEnvironment.has(manifest.id)) {
      throw new AdapterError(ERROR_CODES.CONFIG_INVALID, 'duplicate P0 provider id', {
        details: { environment: manifest.environment, id: manifest.id },
      });
    }
    forEnvironment.set(manifest.id, provider);
    this._providers.set(manifest.environment, forEnvironment);
    return provider;
  }

  /**
   * Resolve adapters for one snapshot.
   *
   * @param {{environment:string, enabledEnvironments?:string[]}} snapshot
   * @returns {{targetAdapter:object, capabilityAdapters:object[], providers:object[]}}
   */
  resolve(snapshot, { ignoreEnabled = false } = {}) {
    if (!isPlainObject(snapshot) || typeof snapshot.environment !== 'string') {
      throw new AdapterError(ERROR_CODES.INVALID_ARGUMENT, 'resolve requires a snapshot with environment', {
        details: { field: 'snapshot' },
      });
    }
    const environment = snapshot.environment;
    // `ignoreEnabled` separates two different questions: "is this scheme implemented and
    // registered?" (support / readiness probing) and "may it run right now?" (admission). A user
    // returning `false` from the enabled switch must not turn engineering support into
    // "not registered" (plan §6.2, A13).
    if (!ignoreEnabled
      && Array.isArray(snapshot.enabledEnvironments)
      && !snapshot.enabledEnvironments.includes(environment)) {
      throw new AdapterError(ERROR_CODES.ADAPTER_DISABLED, 'environment is not enabled in this snapshot', {
        details: { environment, enabledEnvironments: [...snapshot.enabledEnvironments] },
      });
    }
    const targetAdapter = this._targets.get(environment);
    if (!targetAdapter) {
      throw new AdapterError(ERROR_CODES.ADAPTER_NOT_FOUND, 'no target adapter registered for environment', {
        details: { environment },
      });
    }
    if (targetAdapter.manifest.contractVersion !== CONTRACT_VERSION) {
      throw new AdapterError(ERROR_CODES.ADAPTER_UNSUPPORTED, 'target adapter contract version mismatch', {
        details: { environment, id: targetAdapter.manifest.id ?? null },
      });
    }
    return {
      targetAdapter,
      capabilityAdapters: [...(this._capabilities.get(environment)?.values() ?? [])],
      providers: [...(this._providers.get(environment)?.values() ?? [])],
    };
  }

  /**
   * Per-capability support/availability for a snapshot. Support and live availability stay
   * separate; a capability with no registered adapter is `planned`/`unavailable`, never `ok`.
   *
   * @param {{environment:string, capabilities?:string[], enabledEnvironments?:string[]}} snapshot
   * @returns {Array<{id:string, support:string, availability:string, reason?:string}>}
   */
  capabilitiesFor(snapshot) {
    if (!isPlainObject(snapshot) || typeof snapshot.environment !== 'string') {
      throw new AdapterError(ERROR_CODES.INVALID_ARGUMENT, 'capabilitiesFor requires a snapshot with environment', {
        details: { field: 'snapshot' },
      });
    }
    const environment = snapshot.environment;
    const ids = Array.isArray(snapshot.capabilities) ? snapshot.capabilities : [];
    const adapters = [...(this._capabilities.get(environment)?.values() ?? [])];
    const enabled = !Array.isArray(snapshot.enabledEnvironments)
      || snapshot.enabledEnvironments.includes(environment);
    const hasTarget = this._targets.has(environment);
    return ids.map((id) => {
      if (!enabled) {
        return { id, support: SUPPORT.PLANNED, availability: AVAILABILITY.UNAVAILABLE, reason: 'environment-disabled' };
      }
      if (!hasTarget) {
        return { id, support: SUPPORT.PLANNED, availability: AVAILABILITY.UNAVAILABLE, reason: 'adapter-not-registered' };
      }
      const owner = adapters.find(
        (adapter) => Array.isArray(adapter.manifest.capabilities)
          && adapter.manifest.capabilities.includes(id),
      );
      if (!owner) {
        return { id, support: SUPPORT.PLANNED, availability: AVAILABILITY.UNAVAILABLE, reason: 'adapter-not-registered' };
      }
      let entries = [];
      const statusFn = typeof owner.operationStatus === 'function'
        ? owner.operationStatus
        : (typeof owner.capabilities === 'function' ? owner.capabilities : null);
      if (statusFn !== null) {
        try {
          const result = statusFn.call(owner, { snapshot });
          entries = isPlainObject(result) ? Object.values(result) : [];
        } catch {
          entries = [];
        }
      }
      const { availability, reason } = aggregateAvailability(entries);
      const item = { id, support: SUPPORT.SUPPORTED, availability };
      if (reason !== null) item.reason = reason;
      return item;
    });
  }

  /** Dispose every registered adapter/provider; individual failures do not block the rest. */
  async dispose() {
    const all = [
      ...this._targets.values(),
      ...[...this._capabilities.values()].flatMap((map) => [...map.values()]),
      ...[...this._providers.values()].flatMap((map) => [...map.values()]),
    ];
    this._targets.clear();
    this._capabilities.clear();
    this._providers.clear();
    await Promise.allSettled(all.map(async (adapter) => {
      if (typeof adapter?.dispose === 'function') await adapter.dispose();
    }));
  }
}
