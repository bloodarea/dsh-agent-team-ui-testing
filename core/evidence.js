/**
 * Evidence envelopes and a bounded in-memory store.
 *
 * Every observation must be traceable to scope/session/target/generation/configRevision/
 * operation/source/capturedAt. The store is intentionally memory-only: writing evidence files is
 * the host's job, not a pure core concern.
 */
import { CONTRACT_VERSION, ERROR_CODES } from './contracts.js';
import { AdapterError } from './errors.js';

/** Required envelope keys (values may be null where the concept genuinely does not exist). */
export const EVIDENCE_REQUIRED_FIELDS = Object.freeze([
  'version',
  'scope',
  'session',
  'target',
  'generation',
  'configRevision',
  'operation',
  'source',
  'capturedAt',
]);

function isPlainObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * @param {{scope?:object, session?:object, target?:object|null, generation?:number|null,
 *   configRevision?:number|null, operation?:object, source?:object, capturedAt?:number|null,
 *   extra?:object}} [input]
 */
export function createEvidenceEnvelope({
  scope = null,
  session = null,
  target = null,
  generation = null,
  configRevision = null,
  operation = null,
  source = null,
  capturedAt = null,
  extra,
} = {}) {
  const extras = isPlainObject(extra) ? extra : {};
  return {
    ...extras,
    version: CONTRACT_VERSION,
    scope,
    session,
    target,
    generation,
    configRevision,
    operation,
    source,
    capturedAt,
  };
}

/** Shallow-merge a patch into an envelope; the version stays fixed at CONTRACT_VERSION. */
export function mergeEvidence(base, patch) {
  const left = isPlainObject(base) ? base : {};
  const right = isPlainObject(patch) ? patch : {};
  const merged = { ...left };
  for (const [key, value] of Object.entries(right)) {
    if (value !== undefined) merged[key] = value;
  }
  merged.version = CONTRACT_VERSION;
  return merged;
}

/**
 * @returns {{ok:boolean, missing:string[]}} `missing` lists required keys that are absent or
 *   explicitly undefined; explicit `null` is accepted (e.g. an unbound target).
 */
export function validateEvidence(envelope) {
  if (!isPlainObject(envelope)) {
    return { ok: false, missing: [...EVIDENCE_REQUIRED_FIELDS] };
  }
  const missing = EVIDENCE_REQUIRED_FIELDS.filter(
    (field) => !Object.hasOwn(envelope, field) || envelope[field] === undefined,
  );
  return { ok: missing.length === 0, missing };
}

let storeCounter = 0;

/**
 * Bounded FIFO evidence store.
 *
 * `add` assigns an `evidenceId` when absent; `get` looks it up. No file I/O and no implicit
 * timestamps.
 */
export class EvidenceStore {
  constructor({ limit = 256 } = {}) {
    if (!Number.isInteger(limit) || limit <= 0) {
      throw new AdapterError(ERROR_CODES.INVALID_ARGUMENT, 'EvidenceStore limit must be a positive integer', {
        details: { field: 'limit', value: Number.isFinite(limit) ? limit : null },
      });
    }
    this.limit = limit;
    this._entries = [];
    this._byId = new Map();
  }

  /** Store an envelope; oldest entries are evicted once the limit is exceeded. */
  add(envelope) {
    if (!isPlainObject(envelope)) {
      throw new AdapterError(ERROR_CODES.INVALID_ARGUMENT, 'evidence envelope must be an object', {
        details: { field: 'envelope' },
      });
    }
    const evidenceId = typeof envelope.evidenceId === 'string' && envelope.evidenceId.length > 0
      ? envelope.evidenceId
      : `ev-${++storeCounter}`;
    const entry = { ...envelope, evidenceId };
    this._entries.push(entry);
    this._byId.set(evidenceId, entry);
    while (this._entries.length > this.limit) {
      const evicted = this._entries.shift();
      this._byId.delete(evicted.evidenceId);
    }
    return entry;
  }

  get(evidenceId) {
    return this._byId.get(evidenceId);
  }

  list() {
    return [...this._entries];
  }

  clear() {
    this._entries = [];
    this._byId.clear();
  }

  get size() {
    return this._entries.length;
  }
}
