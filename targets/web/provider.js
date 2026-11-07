/**
 * Web P0Provider: platform side of the neutral P0 families A-E.
 *
 * The provider owns no protocol. It validates arguments, calls the injected `p0Dispatch`, and
 * normalizes whatever the platform returns through the neutral factories in `core/p0.js`. That
 * keeps CDP/DOM/screencast details out of `core/` while giving T1-T4 one stable data model.
 *
 * `p0Dispatch` may be:
 * - a function: `p0Dispatch(family, method, { args, session, snapshot, signal })` (canonical), or
 * - a per-family map `{ A: { screenshot }, B: { events } }` / `{ A: fn }` (test seam).
 * A family the dispatch cannot serve is reported `unsupported`; it is never faked.
 */

import {
  AdapterError,
  CONTRACT_VERSION,
  ERROR_CODES,
  createEvidenceEnvelope,
} from '../../core/index.js';
import {
  P0_AVAILABILITY,
  P0_EVIDENCE_FIELDS,
  P0_FAMILIES,
  P0_SUPPORT,
  createAnnotationDoc,
  createDisplaySpace,
  createFrame,
  createLease,
  createNetworkEvent,
  createTargetIdentity,
} from '../../core/p0.js';

/** Method inventory per P0 family; mirrors M0 §3 and the shipped provider surface. */
export const WEB_P0_METHODS = Object.freeze({
  // `capture`/`product` are the page-capture entry points the tool layer uses (scale/region and
  // the composited PNG product); they stay platform-shaped and skip neutral normalization.
  A: Object.freeze(['screenshot', 'capture', 'product', 'validateImage', 'readFrame']),
  B: Object.freeze(['start', 'stop', 'status', 'reset', 'events', 'detail', 'control', 'trace', 'evidence', 'subscribe']),
  C: Object.freeze(['read', 'transform', 'set']),
  D: Object.freeze(['annotationRead', 'annotationWrite']),
  // P0-E owns target model projection and leases only; bind/close belong to the TargetAdapter.
  E: Object.freeze(['list', 'leaseAcquire', 'leaseRelease', 'leaseStatus']),
});

/** Family -> gating capability id (web catalog). */
const FAMILY_CAPABILITY = Object.freeze({
  A: 'web.p0.capture',
  B: 'web.p0.network',
  C: 'web.p0.display',
  D: 'web.p0.canvas',
  E: 'web.p0.targets',
});

/** Capability ids owned by this provider; the adapter catalog is the authority. */
export const WEB_P0_CAPABILITIES = Object.freeze(Object.values(FAMILY_CAPABILITY));

const KNOWN_ERROR_CODES = new Set(Object.values(ERROR_CODES));

const FAMILY_KEYS = Object.freeze(Object.values(P0_FAMILIES));

function isPlainObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function nullableString(value) {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

function capabilityListOf(snapshot) {
  const list = snapshot?.capabilities;
  return Array.isArray(list) ? list.filter((id) => typeof id === 'string') : null;
}

function configRevisionOf(snapshot) {
  const revision = snapshot?.revision ?? snapshot?.configRevision;
  return Number.isInteger(revision) ? revision : null;
}

function toAdapterError(error, { operation }) {
  if (error instanceof AdapterError) return error;
  const code = typeof error?.code === 'string' && KNOWN_ERROR_CODES.has(error.code)
    ? error.code
    : ERROR_CODES.INTERNAL;
  const message = error instanceof Error && error.message
    ? error.message
    : typeof error === 'string' && error.length > 0
      ? error
      : 'web p0 provider operation failed';
  const details = { operation };
  if (isPlainObject(error?.details)) Object.assign(details, error.details);
  if (error instanceof Error) details.causeName = error.name;
  return new AdapterError(code, message, {
    details,
    cause: error instanceof Error ? error : undefined,
  });
}

function requireStringArg(args, field, operation) {
  if (typeof args[field] !== 'string' || args[field].length === 0) {
    throw new AdapterError(ERROR_CODES.INVALID_ARGUMENT, `${operation} requires '${field}'`, {
      details: { operation, field },
    });
  }
}

/**
 * Argument checks stay deliberately shallow: the provider guarantees the neutral shape, not the
 * platform payload. Anything the platform needs to reject must surface as a platform error.
 */
function validateArgs(family, method, args) {
  const operation = `${family}.${method}`;
  if (!isPlainObject(args)) {
    throw new AdapterError(ERROR_CODES.INVALID_ARGUMENT, `${operation} args must be a plain object`, {
      details: { operation, field: 'args', type: Array.isArray(args) ? 'array' : typeof args },
    });
  }
  if (operation === 'B.detail' && args.requestId === undefined && args.seq === undefined) {
    throw new AdapterError(ERROR_CODES.INVALID_ARGUMENT, 'B.detail requires requestId or seq', {
      details: { operation, fields: ['requestId', 'seq'] },
    });
  }
  if (operation === 'E.leaseAcquire') {
    requireStringArg(args, 'targetId', operation);
  }
  if (operation === 'E.leaseRelease' || operation === 'E.leaseStatus') {
    requireStringArg(args, 'leaseId', operation);
  }
}

function listFrom(raw, key) {
  if (Array.isArray(raw)) return raw;
  if (isPlainObject(raw) && Array.isArray(raw[key])) return raw[key];
  return [];
}

/** Normalize a platform result through the neutral factories; never invent missing values. */
function normalizeP0Value(family, method, raw) {
  const operation = `${family}.${method}`;
  switch (operation) {
    case 'A.screenshot':
    case 'A.readFrame':
      return createFrame(isPlainObject(raw) ? raw : {});
    case 'A.capture':
    case 'A.product':
      // Platform-shaped payloads: the tool contract owns their fields, so the provider must not
      // re-shape them into a neutral frame.
      return raw ?? null;
    case 'A.validateImage':
      if (isPlainObject(raw)) return raw;
      throw new AdapterError(ERROR_CODES.INTERNAL, 'A.validateImage returned a non-object result', {
        details: { operation },
      });
    case 'B.events': {
      const events = listFrom(raw, 'events').map((event) => createNetworkEvent(isPlainObject(event) ? event : {}));
      return isPlainObject(raw) && Array.isArray(raw.events) ? { ...raw, events } : events;
    }
    case 'B.detail':
      return createNetworkEvent(isPlainObject(raw) ? raw : {});
    case 'B.start':
    case 'B.stop':
    case 'B.status':
    case 'B.reset':
    case 'B.control':
    case 'B.trace':
    case 'B.evidence':
    case 'B.subscribe':
    case 'C.set':
      return raw ?? null;
    case 'C.read':
    case 'C.transform':
      return createDisplaySpace(isPlainObject(raw) ? raw : {});
    case 'D.annotationRead':
    case 'D.annotationWrite':
      return createAnnotationDoc(isPlainObject(raw) ? raw : {});
    case 'E.list': {
      const targets = listFrom(raw, 'targets').map((target) => createTargetIdentity(isPlainObject(target) ? target : {}));
      return isPlainObject(raw) && Array.isArray(raw.targets) ? { ...raw, targets } : targets;
    }
    case 'E.leaseAcquire':
      return createLease(isPlainObject(raw) ? raw : {});
    case 'E.leaseRelease':
      return raw ?? null;
    case 'E.leaseStatus': {
      if (!isPlainObject(raw)) return raw ?? null;
      return typeof raw.leaseId === 'string' || typeof raw.targetId === 'string'
        ? createLease(raw)
        : raw;
    }
    default:
      return raw ?? null;
  }
}

/**
 * Create the web P0Provider.
 *
 * @param {object} [options]
 * @param {Function|object} [options.p0Dispatch] Injected platform dispatch. Missing -> all five
 *   families report `support: 'unsupported'`.
 * @param {object} [options.log]
 * @param {() => number} [options.now]
 */
export function createWebP0Provider({ p0Dispatch, log, now = Date.now } = {}) {
  const manifest = {
    contractVersion: CONTRACT_VERSION,
    id: 'web.p0',
    class: 'p0',
    environment: 'web',
    families: [...FAMILY_KEYS],
    capabilities: [...WEB_P0_CAPABILITIES],
  };

  let disposed = false;

  function assertNotDisposed() {
    if (disposed) {
      throw new AdapterError(ERROR_CODES.ADAPTER_DISABLED, 'web p0 provider is disposed', {
        details: { providerId: manifest.id },
      });
    }
  }

  function familySupport(family) {
    if (typeof p0Dispatch === 'function') {
      const declared = Array.isArray(p0Dispatch.families) ? p0Dispatch.families : null;
      return declared === null || declared.includes(family)
        ? P0_SUPPORT.SUPPORTED
        : P0_SUPPORT.UNSUPPORTED;
    }
    if (isPlainObject(p0Dispatch)) {
      const handler = p0Dispatch[family];
      if (typeof handler === 'function') return P0_SUPPORT.SUPPORTED;
      if (isPlainObject(handler) && WEB_P0_METHODS[family].some((method) => typeof handler[method] === 'function')) {
        return P0_SUPPORT.SUPPORTED;
      }
    }
    return P0_SUPPORT.UNSUPPORTED;
  }

  function methodSupported(family, method) {
    if (typeof p0Dispatch === 'function') return familySupport(family) === P0_SUPPORT.SUPPORTED;
    const handler = p0Dispatch?.[family];
    if (typeof handler === 'function') return true;
    return isPlainObject(handler) && typeof handler[method] === 'function';
  }

  function callP0(family, method, payload) {
    if (typeof p0Dispatch === 'function') return p0Dispatch(family, method, payload);
    const handler = p0Dispatch[family];
    if (typeof handler === 'function') return handler(method, payload);
    return handler[method](payload);
  }

  async function invokeFamilyMethod(family, method, { args = {}, session, snapshot, signal, context = null, raw = false } = {}) {
    assertNotDisposed();
    const operation = `${family}.${method}`;
    if (familySupport(family) === P0_SUPPORT.UNSUPPORTED || !methodSupported(family, method)) {
      throw new AdapterError(
        ERROR_CODES.CAPABILITY_UNSUPPORTED,
        `web p0 family ${family} does not provide '${method}'`,
        { details: { operation, family, method } },
      );
    }
    validateArgs(family, method, args);
    if (!isPlainObject(session)) {
      throw new AdapterError(ERROR_CODES.TARGET_NOT_BOUND, `${operation} requires a target session`, {
        details: { operation },
      });
    }
    if (session.closed === true) {
      throw new AdapterError(ERROR_CODES.TARGET_GONE, `web session ${String(session.sessionId)} is closed`, {
        details: { operation, sessionId: session.sessionId ?? null },
      });
    }
    const capabilities = capabilityListOf(snapshot);
    if (capabilities !== null && !capabilities.includes(FAMILY_CAPABILITY[family])) {
      throw new AdapterError(
        ERROR_CODES.ADAPTER_DISABLED,
        `capability '${FAMILY_CAPABILITY[family]}' is not enabled for '${operation}'`,
        { details: { operation, capability: FAMILY_CAPABILITY[family] } },
      );
    }

    let platformResult;
    try {
      // `context` carries the invocation-scoped handles the platform dispatch needs (the page
      // runtime, the calling exec, the action meta). Dropping it made the production dispatch
      // unusable: it could only ever answer PROVIDER_UNAVAILABLE (A01).
      platformResult = await callP0(family, method, {
        args,
        session,
        snapshot,
        signal,
        context,
        // Routing facts for the composition root (§4.2): the P0 call must run on the selected
        // provider's runtime. `null` for a snapshot that predates the provider field.
        provider: typeof snapshot?.provider === 'string' ? snapshot.provider : null,
        executionAdapterId: typeof snapshot?.executionAdapterId === 'string'
          ? snapshot.executionAdapterId
          : null,
      });
    } catch (error) {
      throw toAdapterError(error, { operation });
    }

    // `raw: true` keeps the platform payload (used by the tool layer, whose public result shape
    // is its own contract); the neutral model is the default for the neutral surface.
    const value = raw === true ? (platformResult ?? null) : normalizeP0Value(family, method, platformResult);
    const evidence = createEvidenceEnvelope({
      scope: session.scopeId ?? null,
      session: session.sessionId ?? null,
      target: session.target?.targetId ?? null,
      generation: Number.isInteger(session.generation) ? session.generation : null,
      configRevision: configRevisionOf(snapshot) ?? (Number.isInteger(session.configRevision) ? session.configRevision : null),
      operation,
      source: 'web.p0',
      capturedAt: typeof now === 'function' ? now() : Date.now(),
    });
    if (typeof evidence === 'object' && evidence !== null) {
      for (const field of P0_EVIDENCE_FIELDS) {
        if (!Object.hasOwn(evidence, field)) {
          throw new AdapterError(ERROR_CODES.EVIDENCE_INCOMPLETE, `evidence is missing '${field}'`, {
            details: { operation, missing: field },
          });
        }
      }
    }

    log?.debug?.('web.p0.invoke', { operation });
    return { value, evidence };
  }

  function buildFamilySurface(family) {
    const surface = {};
    for (const method of WEB_P0_METHODS[family]) {
      surface[method] = (input = {}) => invokeFamilyMethod(family, method, input);
    }
    return Object.freeze(surface);
  }

  return {
    manifest,

    familyStatus({ session, snapshot } = {}) {
      const capabilities = capabilityListOf(snapshot);
      const out = {};
      for (const family of FAMILY_KEYS) {
        const support = familySupport(family);
        if (support === P0_SUPPORT.UNSUPPORTED) {
          out[family] = {
            support,
            availability: P0_AVAILABILITY.UNAVAILABLE,
            reason: 'provider-missing',
            capability: FAMILY_CAPABILITY[family],
          };
          continue;
        }
        if (!isPlainObject(session)) {
          out[family] = {
            support,
            availability: P0_AVAILABILITY.NOT_PROBED,
            reason: 'no-session',
            capability: FAMILY_CAPABILITY[family],
          };
          continue;
        }
        if (session.closed === true) {
          out[family] = {
            support,
            availability: P0_AVAILABILITY.UNAVAILABLE,
            reason: 'target-gone',
            capability: FAMILY_CAPABILITY[family],
          };
          continue;
        }
        if (capabilities === null) {
          out[family] = {
            support,
            availability: P0_AVAILABILITY.NOT_PROBED,
            reason: 'capability-unknown',
            capability: FAMILY_CAPABILITY[family],
          };
          continue;
        }
        if (!capabilities.includes(FAMILY_CAPABILITY[family])) {
          out[family] = {
            support,
            availability: P0_AVAILABILITY.UNAVAILABLE,
            reason: 'capability-disabled',
            capability: FAMILY_CAPABILITY[family],
          };
          continue;
        }
        out[family] = {
          support,
          availability: P0_AVAILABILITY.AVAILABLE,
          reason: null,
          capability: FAMILY_CAPABILITY[family],
        };
      }
      return out;
    },

    capture: buildFamilySurface('A'),
    network: buildFamilySurface('B'),
    display: buildFamilySurface('C'),
    canvas: buildFamilySurface('D'),
    targets: buildFamilySurface('E'),

    async dispose() {
      if (disposed) return;
      disposed = true;
    },
  };
}
