/**
 * Test-only fake environment: TargetAdapter + CapabilityAdapter + P0Provider.
 *
 * This is a contract fixture, not a real platform. It never starts a browser,
 * never opens a socket and never writes a repository file. Everything is
 * deterministic for a given `seed` and injected `now()`.
 *
 * Ownership boundaries (M0 §2, frozen after review):
 *  - TargetAdapter owns target discovery/bind/close, generation and sessions.
 *  - P0Provider's `targets` family exposes read-only target listing plus lease
 *    primitives (`list` / `leaseAcquire` / `leaseRelease` / `leaseStatus`); it
 *    never binds or closes a target itself.
 *  - `familyStatus` (provider) and `operationStatus` (capability adapter) are
 *    named so they cannot be confused with the six-axis `capability` readiness
 *    axis.
 */

import { AdapterError } from '../../core/errors.js';
import { createTransform } from '../../core/geometry.js';
import {
  createAnnotationDoc,
  createDisplaySpace,
  createFrame,
  createLease,
  createNetworkEvent,
  createRequestKey,
  createTargetIdentity,
  frameIntegritySummary,
  validateAnnotationDoc,
} from '../../core/p0.js';
import {
  canonicalJson,
  createDeterministicPng,
  fakeId,
  sha256Hex,
} from './fixtures.js';

const CONTRACT_VERSION = 1;
const CAPABILITY_OPERATIONS = Object.freeze(['fake.t1.echo', 'fake.t1.identity', 'fake.t3.frame-stats']);
const TARGET_CAPABILITIES = Object.freeze([
  'fake.t1', 'fake.t2', 'fake.t3', 'fake.network',
  'fake.p0.capture', 'fake.p0.display', 'fake.p0.canvas', 'fake.p0.targets',
]);
const CAPABILITY_IDS = Object.freeze(['fake.t1', 'fake.t3']);

const hasOwn = (object, key) => Object.prototype.hasOwnProperty.call(object, key);
const isObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const isText = (value) => typeof value === 'string' && value.length > 0;
const isInteger = (value) => Number.isInteger(value);
const isFiniteNumber = (value) => typeof value === 'number' && Number.isFinite(value);

/** Explicit snapshot revision, or null when the snapshot does not carry one. */
function explicitSnapshotRevision(snapshot) {
  if (!isObject(snapshot)) return null;
  if (isInteger(snapshot.revision)) return snapshot.revision;
  if (isInteger(snapshot.configRevision)) return snapshot.configRevision;
  const env = isObject(snapshot.environments) ? snapshot.environments.fake : null;
  if (isObject(env) && isInteger(env.revision)) return env.revision;
  return null;
}

function snapshotRevision(snapshot) {
  return explicitSnapshotRevision(snapshot) ?? 0;
}

function snapshotEnabled(snapshot) {
  if (!isObject(snapshot)) return false;
  const env = (isObject(snapshot.environments) ? snapshot.environments.fake : null)
    ?? (isObject(snapshot.config?.global?.environments) ? snapshot.config.global.environments.fake : null);
  if (isObject(env) && typeof env.enabled === 'boolean') return env.enabled;
  if (typeof snapshot.enabled === 'boolean') return snapshot.enabled;
  if (Array.isArray(snapshot.enabledEnvironments)) return snapshot.enabledEnvironments.includes('fake');
  return false;
}

/**
 * Honor caller cancellation. An AbortSignal reason that is an Error is
 * re-thrown as-is; otherwise the operation reports an aborted state.
 */
function assertNotAborted(signal, operation) {
  if (!signal || signal.aborted !== true) return;
  const reason = signal.reason;
  if (reason instanceof Error) throw reason;
  throw new AdapterError('TARGET_GONE', 'operation aborted by caller', { reason: 'aborted', operation });
}

/**
 * A snapshot/args revision that differs from the session's `configRevision`
 * means the caller is acting on a stale configuration (M0 §4.1: one revision
 * per step).
 */
function assertRevision(session, snapshot, args, operation) {
  const expected = session.configRevision;
  const snapshotValue = explicitSnapshotRevision(snapshot);
  if (snapshotValue !== null && snapshotValue !== expected) {
    throw new AdapterError('CONFIG_STALE', 'snapshot revision differs from the session revision', {
      operation,
      expected,
      actual: snapshotValue,
    });
  }
  if (isObject(args) && hasOwn(args, 'revision') && args.revision !== expected) {
    throw new AdapterError('CONFIG_STALE', 'operation revision differs from the session revision', {
      operation,
      expected,
      actual: args.revision,
    });
  }
}

function buildEvidence(state, {
  operation,
  session = null,
  snapshot = null,
  source = 'targets/fake',
  target = undefined,
} = {}) {
  const targetIdentity = target !== undefined ? target : (session?.target ?? null);
  return {
    version: 1,
    scope: session?.scope ?? snapshot?.scope ?? 'scope-fake',
    session: session?.sessionId ?? null,
    target: targetIdentity?.targetId ?? null,
    generation: session?.generation ?? null,
    configRevision: session?.configRevision ?? snapshotRevision(snapshot),
    operation,
    source,
    capturedAt: state.now(),
  };
}

function assertSessionLive(record) {
  if (record.disposed || record.closed) {
    throw new AdapterError('TARGET_GONE', 'fake session is closed', {
      reason: 'session-closed',
      sessionId: record.sessionId,
    });
  }
}

function resolveRecord(state, session, operation) {
  if (!session || !isText(session.sessionId)) {
    throw new AdapterError('TARGET_NOT_BOUND', 'fake provider requires a target session', {
      reason: 'session-missing',
      operation,
    });
  }
  const record = state.sessions.get(session.sessionId);
  if (!record) {
    throw new AdapterError('TARGET_NOT_BOUND', `fake session "${session.sessionId}" is unknown`, {
      reason: 'session-unknown',
      sessionId: session.sessionId,
      operation,
    });
  }
  assertSessionLive(record);
  return record;
}

function assertGeneration(session, args, operation) {
  if (isObject(args) && hasOwn(args, 'generation') && args.generation !== session.generation) {
    throw new AdapterError('GENERATION_MISMATCH', 'fake operation generation does not match the session', {
      operation,
      expected: session.generation,
      actual: args.generation,
    });
  }
}

/**
 * The binding that any target-scoped record must match to be handed out:
 * the currently bound target plus the session generation.
 *
 * `bind()` bumps `record.generation` on every call, so a frame, annotation
 * document or lease recorded before a rebind is stale by construction — even
 * when the rebind selects the same `targetId` again.
 */
function currentBinding(session) {
  return {
    targetId: isObject(session?.target) ? session.target.targetId : null,
    generation: session?.generation ?? null,
  };
}

/** True when `record` (frame / annotation doc / lease) belongs to the live binding. */
function matchesCurrentBinding(session, record) {
  if (!isObject(record)) return false;
  const current = currentBinding(session);
  const targetId = hasOwn(record, 'targetId') ? (record.targetId ?? null) : null;
  const generation = hasOwn(record, 'generation') ? (record.generation ?? null) : null;
  return targetId === current.targetId && generation === current.generation;
}

/**
 * Fail closed (A05 P0-D/E) when a stored record predates the current binding.
 *
 * One code is used for every superseded-reference case — a different target and
 * an unchanged target with a bumped generation — because both are only ever
 * reachable through a rebind: `GENERATION_MISMATCH`. Returning the record
 * instead would pair old data with `evidence.target` of the new binding.
 */
function assertCurrentBinding(session, record, { operation, subject }) {
  if (matchesCurrentBinding(session, record)) return;
  const current = currentBinding(session);
  throw new AdapterError('GENERATION_MISMATCH', `${subject} belongs to a superseded target binding`, {
    operation,
    subject,
    reason: 'target-rebound',
    expected: current.generation,
    actual: isObject(record) && hasOwn(record, 'generation') ? (record.generation ?? null) : null,
    expectedTargetId: current.targetId,
    actualTargetId: isObject(record) ? (record.targetId ?? null) : null,
  });
}

function requireBoundTarget(state, session, operation) {
  const record = resolveRecord(state, session, operation);
  if (!isObject(session.target)) {
    throw new AdapterError('TARGET_NOT_BOUND', 'fake operation requires a bound target', {
      reason: 'target-unbound',
      operation,
    });
  }
  if (record.closedTargetIds.has(session.target.targetId)) {
    throw new AdapterError('TARGET_GONE', `fake target "${session.target.targetId}" is closed`, {
      targetId: session.target.targetId,
      operation,
    });
  }
  return session.target;
}

// ---------------------------------------------------------------------------
// Session / target lifecycle (owned by TargetAdapter, shared with P0 leases)
// ---------------------------------------------------------------------------

function createTargetIdentities(state, sessionId) {
  return [1, 2].map((index) => createTargetIdentity({
    targetId: fakeId(state.seed, 'target', index),
    environment: 'fake',
    kind: 'fake-window',
    generation: 1,
    label: `Fake Window ${index}`,
    lifecycle: 'available',
  }));
}

function closeSessionRecord(record) {
  if (record.closed) return { closed: true, alreadyClosed: true, generation: record.generation };
  record.closed = true;
  record.generation += 1;
  for (const identity of record.targets) {
    record.closedTargetIds.add(identity.targetId);
    identity.lifecycle = 'closed';
    identity.generation = record.generation;
  }
  record.target = null;
  return { closed: true, alreadyClosed: false, generation: record.generation };
}

/**
 * Mark every lease this session owns as invalidated by the rebind (A05 P0-E).
 *
 * The lease records stay readable by id so `leaseStatus` / `leaseRelease` can
 * report `GENERATION_MISMATCH` (with the real cause) instead of degrading into
 * "unknown lease"; they can never be reported as live again.
 */
function invalidateSessionLeases(state, record) {
  const releasedAt = state.now();
  for (const lease of state.leases.values()) {
    if (lease.owner?.kind !== 'session' || lease.owner?.id !== record.sessionId) continue;
    if (state.invalidatedLeases.has(lease.leaseId)) continue;
    state.invalidatedLeases.set(lease.leaseId, { reason: 'target-rebound', releasedAt });
  }
}

function bindTargetRecord(state, record, targetId) {
  assertSessionLive(record);
  if (!isText(targetId)) {
    throw new AdapterError('INVALID_ARGUMENT', 'bind requires a targetId', { reason: 'target-id-missing' });
  }
  const identity = record.targets.find((item) => item.targetId === targetId);
  if (!identity) {
    throw new AdapterError('TARGET_NOT_BOUND', `fake target "${targetId}" was not found`, { reason: 'target-not-found', targetId });
  }
  if (record.closedTargetIds.has(targetId)) {
    throw new AdapterError('TARGET_GONE', `fake target "${targetId}" is closed`, { targetId });
  }
  record.generation += 1;
  invalidateSessionLeases(state, record);
  identity.generation = record.generation;
  identity.lifecycle = 'bound';
  record.target = identity;
  return { ...identity };
}

function createSessionRecord(state, { scope = null, snapshot = null } = {}) {
  state.sessionSeq += 1;
  const sessionId = fakeId(state.seed, 'session', state.sessionSeq);
  const record = {
    sessionId,
    environment: 'fake',
    scope: isText(scope) ? scope : (isText(snapshot?.scope) ? snapshot.scope : 'scope-fake'),
    generation: 1,
    configRevision: snapshotRevision(snapshot),
    snapshot,
    target: null,
    targets: createTargetIdentities(state, sessionId),
    closedTargetIds: new Set(),
    closed: false,
    disposed: false,
  };
  state.sessions.set(sessionId, record);
  state.lastSession = record;
  return record;
}

function createTargetSession(state, record) {
  return {
    get sessionId() { return record.sessionId; },
    get environment() { return record.environment; },
    get scope() { return record.scope; },
    get generation() { return record.generation; },
    get configRevision() { return record.configRevision; },
    get target() { return record.target; },
    get snapshot() { return record.snapshot; },
    async listTargets(options = {}) {
      assertNotAborted(options.signal, 'targets.list');
      assertSessionLive(record);
      return record.targets.map((identity) => ({ ...identity }));
    },
    async bind(targetId, options = {}) {
      assertNotAborted(options.signal, 'targets.bind');
      return bindTargetRecord(state, record, targetId);
    },
    async close(options = {}) {
      assertNotAborted(options.signal, 'targets.close');
      return closeSessionRecord(record);
    },
    async dispose(options = {}) {
      assertNotAborted(options.signal, 'targets.dispose');
      if (record.disposed) return { disposed: true, alreadyDisposed: true };
      record.disposed = true;
      closeSessionRecord(record);
      return { disposed: true, alreadyDisposed: false };
    },
  };
}

// ---------------------------------------------------------------------------
// Fake TargetAdapter
// ---------------------------------------------------------------------------

function createFakeTargetAdapter(state) {
  let disposed = false;
  return {
    manifest: {
      contractVersion: CONTRACT_VERSION,
      id: 'fake',
      class: 'target',
      environment: 'fake',
      displayName: 'Fake (test-only)',
      capabilities: [...TARGET_CAPABILITIES],
      dependencies: [],
      visibility: 'test-only',
    },

    /**
     * Six independent readiness axes (never merged into one boolean).
     * No target is started and nothing is scanned.
     */
    async probe({ scope = null, snapshot = null, signal = null } = {}) {
      assertNotAborted(signal, 'targets.probe');
      const checkedAt = state.now();
      const configRevision = snapshotRevision(snapshot);
      const enabled = snapshotEnabled(snapshot);
      const record = state.lastSession && !state.lastSession.closed && !state.lastSession.disposed
        ? state.lastSession
        : null;
      const bound = Boolean(record && record.target);
      return {
        contractVersion: CONTRACT_VERSION,
        adapterId: 'fake',
        environment: 'fake',
        scope: isText(scope) ? scope : null,
        checkedAt,
        configRevision,
        target: bound ? { targetId: record.target.targetId, generation: record.target.generation } : null,
        axes: {
          support: { state: 'supported', reason: null },
          enabled: { state: enabled, reason: enabled ? null : 'config-disabled' },
          dependency: { state: 'ok', reason: null },
          connection: { state: 'not-probed', reason: 'in-process-fake' },
          target: {
            state: bound ? 'bound' : 'unbound',
            targetId: bound ? record.target.targetId : null,
            generation: bound ? record.target.generation : null,
            reason: bound ? null : 'no-bound-target',
          },
          capability: {
            state: bound ? 'available' : 'not-probed',
            reason: bound ? null : 'target-unbound',
            items: {
              'fake.t1': bound ? 'available' : 'not-probed',
              'fake.t2': bound ? 'available' : 'not-probed',
              'fake.t3': bound ? 'available' : 'not-probed',
              'fake.network': bound ? 'available' : 'not-probed',
            },
          },
        },
      };
    },

    async createSession({ scope = null, snapshot = null, signal = null } = {}) {
      assertNotAborted(signal, 'targets.createSession');
      if (disposed) {
        throw new AdapterError('TARGET_GONE', 'fake target adapter is disposed', { reason: 'adapter-disposed' });
      }
      return createTargetSession(state, createSessionRecord(state, { scope, snapshot }));
    },

    async dispose() {
      if (disposed) return { disposed: true, alreadyDisposed: true };
      disposed = true;
      for (const record of state.sessions.values()) {
        if (!record.closed) closeSessionRecord(record);
        record.disposed = true;
      }
      return { disposed: true, alreadyDisposed: false };
    },
  };
}

// ---------------------------------------------------------------------------
// Fake CapabilityAdapter
// ---------------------------------------------------------------------------

function frameStats(state, session) {
  const frames = state.frames.filter((frame) => (
    frame.sessionId === session.sessionId && matchesCurrentBinding(session, frame)
  ));
  const latest = frames.length > 0 ? frames[frames.length - 1] : null;
  const combined = sha256Hex(Buffer.from(frames.map((frame) => frame.encoded.sha256).join(':'), 'utf8'));
  return {
    count: frames.length,
    width: latest ? latest.rgba.width : 0,
    height: latest ? latest.rgba.height : 0,
    sha256: combined,
    frames: frames.map((frame) => ({
      frameId: frame.frameId,
      width: frame.rgba.width,
      height: frame.rgba.height,
      sha256: frame.encoded.sha256,
    })),
  };
}

function createFakeCapabilityAdapter(state) {
  let disposed = false;
  return {
    manifest: {
      contractVersion: CONTRACT_VERSION,
      id: 'fake.capability',
      class: 'capability',
      environment: 'fake',
      displayName: 'Fake Capability (test-only)',
      capabilities: [...CAPABILITY_IDS],
      operations: [...CAPABILITY_OPERATIONS],
      dependencies: [],
      visibility: 'test-only',
    },

    operationStatus({ session = null, snapshot = null, signal = null } = {}) {
      assertNotAborted(signal, 'capability.operationStatus');
      const live = Boolean(session && isText(session.sessionId) && state.sessions.has(session.sessionId));
      const bound = Boolean(live && session.target);
      const availability = bound ? 'available' : 'not-probed';
      const reason = bound ? null : (live ? 'target-unbound' : 'session-unbound');
      const out = {};
      for (const operation of CAPABILITY_OPERATIONS) {
        out[operation] = { support: 'supported', availability, reason };
      }
      return out;
    },

    async invoke({ operation, args = {}, session = null, snapshot = null, signal = null } = {}) {
      assertNotAborted(signal, operation ?? 'capability.invoke');
      if (!CAPABILITY_OPERATIONS.includes(operation)) {
        throw new AdapterError('CAPABILITY_UNSUPPORTED', `fake capability "${operation}" is not supported`, {
          operation: operation ?? null,
          operations: [...CAPABILITY_OPERATIONS],
        });
      }
      if (disposed) {
        throw new AdapterError('TARGET_GONE', 'fake capability adapter is disposed', { reason: 'adapter-disposed' });
      }
      const record = resolveRecord(state, session, operation);
      assertRevision(session, snapshot, args, operation);
      assertGeneration(session, args, operation);
      if (!isObject(session.target)) {
        throw new AdapterError('TARGET_NOT_BOUND', 'fake capability requires a bound target', {
          reason: 'target-unbound',
          operation,
        });
      }
      if (record.closedTargetIds.has(session.target.targetId)) {
        throw new AdapterError('TARGET_GONE', `fake target "${session.target.targetId}" is closed`, {
          targetId: session.target.targetId,
          operation,
        });
      }

      const evidence = buildEvidence(state, { operation, session, snapshot });
      if (operation === 'fake.t1.echo') {
        const json = canonicalJson(isObject(args) ? args : {});
        return {
          value: {
            operation,
            args: isObject(args) ? JSON.parse(JSON.stringify(args)) : {},
            json,
            sha256: sha256Hex(Buffer.from(json, 'utf8')),
          },
          evidence,
        };
      }
      if (operation === 'fake.t1.identity') {
        return {
          value: {
            environment: 'fake',
            sessionId: session.sessionId,
            sessionGeneration: session.generation,
            targetId: session.target.targetId,
            targetGeneration: session.target.generation,
            configRevision: session.configRevision,
          },
          evidence,
        };
      }
      return { value: frameStats(state, session), evidence };
    },

    async dispose() {
      if (disposed) return { disposed: true, alreadyDisposed: true };
      disposed = true;
      return { disposed: true, alreadyDisposed: false };
    },
  };
}

// ---------------------------------------------------------------------------
// Fake P0Provider (A–E)
// ---------------------------------------------------------------------------

function buildFakeNetworkEvents(state, session) {
  const receivedAt = state.now();
  const shared = {
    sessionId: session.sessionId,
    targetId: session.target?.targetId ?? null,
    generation: session.generation,
    sourceTimestamp: null,
    receivedAt,
    transportRef: { kind: 'fake', handle: fakeId(state.seed, 'transport', 'network') },
  };
  return [
    createNetworkEvent({
      ...shared,
      eventId: fakeId(state.seed, 'event', 1),
      requestKey: createRequestKey({ requestId: fakeId(state.seed, 'request', 1), hopId: 0 }),
      phase: 'response',
      kind: 'http',
      method: 'GET',
      url: 'https://fake.test/api/items',
      status: 200,
      body: {
        state: 'captured',
        contentType: 'application/json',
        data: '{"ok":true}',
        base64Encoded: false,
        bytes: 11,
      },
    }),
    createNetworkEvent({
      ...shared,
      eventId: fakeId(state.seed, 'event', 2),
      requestKey: createRequestKey({ requestId: fakeId(state.seed, 'request', 2), hopId: 0 }),
      phase: 'response',
      kind: 'http',
      method: 'POST',
      url: 'https://fake.test/api/upload',
      status: 204,
      body: {
        state: 'unavailable',
        reasonCode: 'body-not-captured',
        reasonDetail: 'fake provider does not capture this body',
      },
    }),
  ];
}

function cloneDoc(doc) {
  if (!doc) return null;
  return { ...doc, shapes: doc.shapes.map((shape) => ({ ...shape })) };
}

/**
 * Resolve a lease for a status/release call, scoped to the live binding.
 *
 * Both the targetId and the generation must match the session's current
 * binding. `bind()` invalidates the session's leases (reason `target-rebound`)
 * and bumps the generation, so a lease acquired before any rebind — to the same
 * target or to another one — is refused here instead of being reported as a
 * live lease on the new target.
 */
function resolveScopedLease(state, session, args, { operation, label }) {
  if (!isText(args.leaseId)) {
    throw new AdapterError('INVALID_ARGUMENT', `${label} requires args.leaseId`, { reason: 'lease-id-missing' });
  }
  const lease = state.leases.get(args.leaseId);
  if (!lease) {
    throw new AdapterError('INVALID_ARGUMENT', `unknown lease "${args.leaseId}"`, {
      reason: 'lease-unknown',
      leaseId: args.leaseId,
    });
  }
  const current = currentBinding(session);
  const invalidation = state.invalidatedLeases.get(lease.leaseId) ?? null;
  if (lease.targetId !== current.targetId || lease.generation !== current.generation) {
    throw new AdapterError('GENERATION_MISMATCH', 'lease belongs to a superseded target binding', {
      operation,
      leaseId: lease.leaseId,
      reason: invalidation?.reason ?? 'binding-mismatch',
      expected: current.generation,
      actual: lease.generation ?? null,
      expectedTargetId: current.targetId,
      actualTargetId: lease.targetId ?? null,
      invalidatedAt: invalidation?.releasedAt ?? null,
    });
  }
  return lease;
}

function createFakeP0Provider(state) {
  let disposed = false;

  return {
    manifest: {
      contractVersion: CONTRACT_VERSION,
      id: 'fake.p0',
      class: 'p0',
      environment: 'fake',
      displayName: 'Fake P0 (test-only)',
      family: 'A',
      families: ['A', 'B', 'C', 'D', 'E'],
      capabilities: [
        'fake.p0.capture', 'fake.p0.network', 'fake.p0.display', 'fake.p0.canvas', 'fake.p0.targets',
      ],
      dependencies: [],
      visibility: 'test-only',
    },

    familyStatus({ session = null, snapshot = null, signal = null } = {}) {
      assertNotAborted(signal, 'p0.familyStatus');
      const live = Boolean(session && isText(session.sessionId) && state.sessions.has(session.sessionId));
      const bound = Boolean(live && session.target);
      const availability = bound ? 'available' : 'not-probed';
      const reason = bound ? null : (live ? 'target-unbound' : 'session-unbound');
      const make = () => ({ support: 'supported', availability, reason });
      return {
        capture: make(),
        network: make(),
        display: make(),
        canvas: make(),
        targets: make(),
      };
    },

    capture: {
      /** 2x2 deterministic PNG, encoded and hashed; source clock from injected now(). */
      async screenshot({ session = null, snapshot = null, args = {}, signal = null } = {}) {
        assertNotAborted(signal, 'p0.capture.screenshot');
        resolveRecord(state, session, 'p0.capture.screenshot');
        assertRevision(session, snapshot, args, 'p0.capture.screenshot');
        assertGeneration(session, args, 'p0.capture.screenshot');
        const png = createDeterministicPng({ width: 2, height: 2 });
        const receivedAt = state.now();
        const sourceTimestamp = hasOwn(args, 'sourceTimestamp') ? args.sourceTimestamp : receivedAt;
        state.frameSeq += 1;
        const frame = createFrame({
          frameId: fakeId(state.seed, 'frame', state.frameSeq),
          sessionId: session.sessionId,
          targetId: session.target?.targetId ?? null,
          generation: session.generation,
          sourceTimestamp,
          receivedAt,
          encoded: {
            format: 'png',
            bytes: png.bytes,
            sha256: png.sha256,
            byteLength: png.bytes.length,
          },
          rgba: {
            width: png.width,
            height: png.height,
            sha256: sha256Hex(png.rgba),
          },
          mapping: {
            from: 'document-css-px',
            to: 'image-px',
            scaleX: 1,
            scaleY: 1,
            offsetX: 0,
            offsetY: 0,
            geometryVersion: state.displayVersion,
          },
          integrity: { state: 'complete', dropped: 0, evicted: 0, incomplete: 0, reason: null },
          evidence: buildEvidence(state, {
            operation: 'p0.capture.screenshot',
            session,
            snapshot,
            source: 'targets/fake/capture',
          }),
        });
        state.frames.push(frame);
        return { frame, evidence: frame.evidence };
      },

      async frames({ session = null, snapshot = null, signal = null } = {}) {
        assertNotAborted(signal, 'p0.capture.frames');
        resolveRecord(state, session, 'p0.capture.frames');
        assertRevision(session, snapshot, null, 'p0.capture.frames');
        // Frames are retained per session, but only the ones recorded for the
        // live target *and* the live generation may be handed out: a rebind must
        // never surface the previous target's pixels under the new evidence.
        const frames = state.frames.filter((frame) => (
          frame.sessionId === session.sessionId && matchesCurrentBinding(session, frame)
        ));
        return {
          frames,
          count: frames.length,
          integrity: frameIntegritySummary(frames),
          evidence: buildEvidence(state, {
            operation: 'p0.capture.frames',
            session,
            snapshot,
            source: 'targets/fake/capture',
          }),
        };
      },

      async image({ session = null, snapshot = null, args = {}, signal = null } = {}) {
        assertNotAborted(signal, 'p0.capture.image');
        resolveRecord(state, session, 'p0.capture.image');
        assertRevision(session, snapshot, args, 'p0.capture.image');
        const frames = state.frames.filter((frame) => frame.sessionId === session.sessionId);
        let frame = null;
        if (isText(args.frameId)) {
          const stored = frames.find((item) => item.frameId === args.frameId) ?? null;
          if (stored) {
            // A frame recorded before the current binding is refused instead of
            // being served with the new target's evidence envelope.
            assertCurrentBinding(session, stored, {
              operation: 'p0.capture.image',
              subject: `frame "${stored.frameId}"`,
            });
            frame = stored;
          }
        } else {
          const live = frames.filter((item) => matchesCurrentBinding(session, item));
          frame = live.length > 0 ? live[live.length - 1] : null;
        }
        if (!frame) {
          throw new AdapterError('INVALID_ARGUMENT', 'no captured frame matches the request', {
            reason: 'frame-not-found',
            frameId: isText(args.frameId) ? args.frameId : null,
          });
        }
        return {
          frameId: frame.frameId,
          format: frame.encoded.format,
          bytes: frame.encoded.bytes,
          sha256: frame.encoded.sha256,
          evidence: buildEvidence(state, {
            operation: 'p0.capture.image',
            session,
            snapshot,
            source: 'targets/fake/capture',
          }),
        };
      },
    },

    network: {
      async start({ session = null, snapshot = null, args = {}, signal = null } = {}) {
        assertNotAborted(signal, 'p0.network.start');
        resolveRecord(state, session, 'p0.network.start');
        assertRevision(session, snapshot, args, 'p0.network.start');
        state.networkStarted = true;
        state.networkStarts += 1;
        return {
          started: true,
          captureBodies: args.captureBodies !== false,
          events: 2,
          evidence: buildEvidence(state, {
            operation: 'p0.network.start',
            session,
            snapshot,
            source: 'targets/fake/network',
          }),
        };
      },

      async stop({ session = null, snapshot = null, signal = null } = {}) {
        assertNotAborted(signal, 'p0.network.stop');
        resolveRecord(state, session, 'p0.network.stop');
        assertRevision(session, snapshot, null, 'p0.network.stop');
        state.networkStarted = false;
        return {
          stopped: true,
          evidence: buildEvidence(state, {
            operation: 'p0.network.stop',
            session,
            snapshot,
            source: 'targets/fake/network',
          }),
        };
      },

      async events({ session = null, snapshot = null, signal = null } = {}) {
        assertNotAborted(signal, 'p0.network.events');
        resolveRecord(state, session, 'p0.network.events');
        assertRevision(session, snapshot, null, 'p0.network.events');
        const events = buildFakeNetworkEvents(state, session);
        return {
          events,
          count: events.length,
          nextCursor: null,
          evidence: buildEvidence(state, {
            operation: 'p0.network.events',
            session,
            snapshot,
            source: 'targets/fake/network',
          }),
        };
      },

      async detail({ session = null, snapshot = null, args = {}, signal = null } = {}) {
        assertNotAborted(signal, 'p0.network.detail');
        resolveRecord(state, session, 'p0.network.detail');
        assertRevision(session, snapshot, args, 'p0.network.detail');
        const events = buildFakeNetworkEvents(state, session);
        const hopId = isInteger(args.hopId) ? args.hopId : 0;
        const event = events.find((item) => (
          (isText(args.eventId) && item.eventId === args.eventId)
          || (isText(args.requestId) && item.requestKey.requestId === args.requestId && item.requestKey.hopId === hopId)
        ));
        if (!event) {
          throw new AdapterError('INVALID_ARGUMENT', 'no fake network event matches the request', {
            reason: 'event-not-found',
            requestId: isText(args.requestId) ? args.requestId : null,
            hopId,
          });
        }
        return {
          event,
          body: event.body,
          evidence: buildEvidence(state, {
            operation: 'p0.network.detail',
            session,
            snapshot,
            source: 'targets/fake/network',
          }),
        };
      },
    },

    display: {
      async read({ session = null, snapshot = null, args = {}, signal = null } = {}) {
        assertNotAborted(signal, 'p0.display.read');
        resolveRecord(state, session, 'p0.display.read');
        assertRevision(session, snapshot, args, 'p0.display.read');
        if (args.advance === true) state.displayVersion += 1;
        const display = createDisplaySpace({
          space: 'document-css-px',
          geometryVersion: state.displayVersion,
          transform: createTransform({
            from: 'document-css-px',
            to: 'image-px',
            scaleX: 1,
            scaleY: 1,
            offsetX: 0,
            offsetY: 0,
            geometryVersion: state.displayVersion,
          }),
          observedAt: state.now(),
          source: 'targets/fake/display',
        });
        return {
          display,
          evidence: buildEvidence(state, {
            operation: 'p0.display.read',
            session,
            snapshot,
            source: 'targets/fake/display',
          }),
        };
      },
    },

    canvas: {
      async annotationWrite({ session = null, snapshot = null, args = {}, signal = null } = {}) {
        assertNotAborted(signal, 'p0.canvas.annotationWrite');
        resolveRecord(state, session, 'p0.canvas.annotationWrite');
        assertRevision(session, snapshot, args, 'p0.canvas.annotationWrite');
        const target = requireBoundTarget(state, session, 'p0.canvas.annotationWrite');
        const doc = args.doc;
        if (!isObject(doc)) {
          throw new AdapterError('INVALID_ARGUMENT', 'annotationWrite requires args.doc', { reason: 'doc-missing' });
        }
        if (doc.targetId !== target.targetId) {
          throw new AdapterError('TARGET_GONE', 'annotation document targets a different target', {
            expected: target.targetId,
            actual: doc.targetId ?? null,
          });
        }
        if (doc.generation !== session.generation) {
          throw new AdapterError('GENERATION_MISMATCH', 'annotation generation is stale', {
            expected: session.generation,
            actual: doc.generation ?? null,
          });
        }
        const current = (() => {
          // A document left behind by an earlier target/generation may stay in
          // storage, but it must never seed the next revision of the live
          // binding: that would carry the previous target's shapes over.
          const stored = isObject(state.annotation?.doc) ? state.annotation.doc : null;
          if (stored && matchesCurrentBinding(session, stored)) return stored;
          return createAnnotationDoc({
            docId: fakeId(state.seed, 'annotation', target.targetId),
            targetId: target.targetId,
            generation: session.generation,
            geometryVersion: state.displayVersion,
            revision: 0,
            shapes: [],
          });
        })();
        const expectedRevision = isInteger(args.expectedRevision) ? args.expectedRevision : current.revision;
        if (expectedRevision !== current.revision) {
          throw new AdapterError('CONFIG_CONFLICT', 'annotation revision conflict', {
            expectedRevision,
            currentRevision: current.revision,
          });
        }
        const candidate = createAnnotationDoc({
          docId: isText(doc.docId) ? doc.docId : current.docId,
          targetId: target.targetId,
          generation: session.generation,
          geometryVersion: state.displayVersion,
          revision: current.revision + 1,
          shapes: Array.isArray(doc.shapes) ? doc.shapes.map((shape) => ({ ...shape })) : [],
        });
        const check = validateAnnotationDoc(candidate);
        if (!check.ok) {
          throw new AdapterError('INVALID_ARGUMENT', 'annotation document is invalid', {
            missing: check.missing,
            errors: check.errors,
          });
        }
        state.annotation = { doc: candidate };
        return {
          doc: cloneDoc(candidate),
          evidence: buildEvidence(state, {
            operation: 'p0.canvas.annotationWrite',
            session,
            snapshot,
            source: 'targets/fake/canvas',
          }),
        };
      },

      async annotationRead({ session = null, snapshot = null, signal = null } = {}) {
        assertNotAborted(signal, 'p0.canvas.annotationRead');
        resolveRecord(state, session, 'p0.canvas.annotationRead');
        assertRevision(session, snapshot, null, 'p0.canvas.annotationRead');
        requireBoundTarget(state, session, 'p0.canvas.annotationRead');
        // The stored document is keyed by nothing but "the last doc"; its
        // targetId/generation decide whether it may be returned for *this*
        // binding. A stale document is refused rather than mislabelled.
        const stored = isObject(state.annotation?.doc) ? state.annotation.doc : null;
        if (stored) {
          assertCurrentBinding(session, stored, {
            operation: 'p0.canvas.annotationRead',
            subject: 'annotation document',
          });
        }
        return {
          doc: cloneDoc(stored),
          evidence: buildEvidence(state, {
            operation: 'p0.canvas.annotationRead',
            session,
            snapshot,
            source: 'targets/fake/canvas',
          }),
        };
      },
    },

    targets: {
      /**
       * Read-only target listing. Binding/closing is owned by TargetAdapter;
       * the provider only observes and manages leases.
       */
      async list({ session = null, snapshot = null, signal = null } = {}) {
        assertNotAborted(signal, 'p0.targets.list');
        resolveRecord(state, session, 'p0.targets.list');
        assertRevision(session, snapshot, null, 'p0.targets.list');
        const targets = (await session.listTargets({ signal })).map((target) => ({ ...target }));
        return {
          targets,
          evidence: buildEvidence(state, {
            operation: 'p0.targets.list',
            session,
            snapshot,
            source: 'targets/fake/targets',
          }),
        };
      },

      async leaseAcquire({ session = null, snapshot = null, args = {}, signal = null } = {}) {
        assertNotAborted(signal, 'p0.targets.leaseAcquire');
        resolveRecord(state, session, 'p0.targets.leaseAcquire');
        assertRevision(session, snapshot, args, 'p0.targets.leaseAcquire');
        const target = requireBoundTarget(state, session, 'p0.targets.leaseAcquire');
        const ttlMs = isFiniteNumber(args.ttlMs) && args.ttlMs > 0 ? args.ttlMs : 60000;
        state.leaseSeq += 1;
        const lease = createLease({
          leaseId: fakeId(state.seed, 'lease', state.leaseSeq),
          targetId: target.targetId,
          generation: session.generation,
          owner: { kind: 'session', id: session.sessionId },
          expiresAt: state.now() + ttlMs,
        });
        state.leases.set(lease.leaseId, lease);
        return {
          lease: { ...lease },
          expired: false,
          remainingMs: ttlMs,
          evidence: buildEvidence(state, {
            operation: 'p0.targets.leaseAcquire',
            session,
            snapshot,
            source: 'targets/fake/targets',
          }),
        };
      },

      async leaseStatus({ session = null, snapshot = null, args = {}, signal = null } = {}) {
        assertNotAborted(signal, 'p0.targets.leaseStatus');
        resolveRecord(state, session, 'p0.targets.leaseStatus');
        assertRevision(session, snapshot, args, 'p0.targets.leaseStatus');
        const lease = resolveScopedLease(state, session, args, {
          operation: 'p0.targets.leaseStatus',
          label: 'leaseStatus',
        });
        const now = state.now();
        return {
          lease: { ...lease },
          expired: lease.expiresAt <= now,
          remainingMs: Math.max(0, lease.expiresAt - now),
          evidence: buildEvidence(state, {
            operation: 'p0.targets.leaseStatus',
            session,
            snapshot,
            source: 'targets/fake/targets',
          }),
        };
      },

      async leaseRelease({ session = null, snapshot = null, args = {}, signal = null } = {}) {
        assertNotAborted(signal, 'p0.targets.leaseRelease');
        resolveRecord(state, session, 'p0.targets.leaseRelease');
        assertRevision(session, snapshot, args, 'p0.targets.leaseRelease');
        const lease = resolveScopedLease(state, session, args, {
          operation: 'p0.targets.leaseRelease',
          label: 'leaseRelease',
        });
        state.leases.delete(args.leaseId);
        state.invalidatedLeases.delete(args.leaseId);
        return {
          released: true,
          lease: { ...lease },
          evidence: buildEvidence(state, {
            operation: 'p0.targets.leaseRelease',
            session,
            snapshot,
            source: 'targets/fake/targets',
          }),
        };
      },
    },

    async dispose() {
      if (disposed) return { disposed: true, alreadyDisposed: true };
      disposed = true;
      state.frames.length = 0;
      state.leases.clear();
      state.invalidatedLeases.clear();
      state.annotation = null;
      return { disposed: true, alreadyDisposed: false };
    },
  };
}

// ---------------------------------------------------------------------------
// Environment factory
// ---------------------------------------------------------------------------

/**
 * Create the three fake adapters over one shared lifecycle state.
 *
 * @param {{now?:() => number, seed?: string}} [options]
 * @returns {{targetAdapter:object, capabilityAdapter:object, p0Provider:object, dispose:() => Promise<object>}}
 */
export function createFakeEnvironment({ now = Date.now, seed = 'fake' } = {}) {
  if (typeof now !== 'function') throw new TypeError('createFakeEnvironment: now must be a function');
  if (!isText(seed)) throw new TypeError('createFakeEnvironment: seed must be a non-empty string');

  const state = {
    now,
    seed,
    sessions: new Map(),
    sessionSeq: 0,
    lastSession: null,
    frames: [],
    frameSeq: 0,
    leases: new Map(),
    leaseSeq: 0,
    /** leaseId -> {reason, releasedAt} for leases invalidated by a rebind. */
    invalidatedLeases: new Map(),
    annotation: null,
    displayVersion: 1,
    networkStarted: false,
    networkStarts: 0,
  };

  const targetAdapter = createFakeTargetAdapter(state);
  const capabilityAdapter = createFakeCapabilityAdapter(state);
  const p0Provider = createFakeP0Provider(state);
  let disposed = false;

  return {
    targetAdapter,
    capabilityAdapter,
    p0Provider,
    async dispose() {
      if (disposed) return { disposed: true, alreadyDisposed: true };
      disposed = true;
      await p0Provider.dispose();
      await capabilityAdapter.dispose();
      await targetAdapter.dispose();
      return { disposed: true, alreadyDisposed: false };
    },
  };
}
