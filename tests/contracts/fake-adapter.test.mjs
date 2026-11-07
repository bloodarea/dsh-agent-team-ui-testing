/**
 * Contract tests for the test-only fake environment (TargetAdapter,
 * CapabilityAdapter, P0Provider).
 *
 * These tests prove the M0 §2 contracts and the P0 A–E lifecycle boundaries
 * (A02/A03/A04/A05) against deterministic non-Web fixtures. They do not claim
 * any real platform support: every manifest is `visibility: 'test-only'`.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { createFakeEnvironment } from '../../targets/fake/adapter.js';
import {
  P0_EVIDENCE_FIELDS,
  assertProvider,
  providerCapabilities,
  validateAnnotationDoc,
  validateDisplaySpace,
  validateFrame,
  validateNetworkEvent,
} from '../../core/p0.js';
import { AdapterError } from '../../core/errors.js';
import { inspectPng, sha256Hex } from '../../targets/fake/fixtures.js';

const START = 1_700_000_000_000;

function makeEnv({ seed = 'fake', start = START } = {}) {
  let clock = start;
  const env = createFakeEnvironment({ now: () => clock, seed });
  return {
    env,
    now: () => clock,
    advance: (ms) => { clock += ms; },
  };
}

async function boundSession(env, targetId = null) {
  const session = await env.targetAdapter.createSession({ scope: 'scope-1', snapshot: { revision: 3 } });
  const resolved = targetId ?? (await session.listTargets())[0].targetId;
  await session.bind(resolved);
  return session;
}

function assertEvidence(evidence, expected) {
  for (const key of P0_EVIDENCE_FIELDS) {
    assert.ok(Object.prototype.hasOwnProperty.call(evidence, key), `evidence.${key} missing`);
  }
  assert.equal(evidence.version, 1);
  for (const [key, value] of Object.entries(expected)) {
    assert.equal(evidence[key], value, `evidence.${key}`);
  }
}

// ---------------------------------------------------------------------------
// Manifests
// ---------------------------------------------------------------------------

test('all three fake adapter manifests are legal and test-only', () => {
  const { env } = makeEnv();
  const target = env.targetAdapter.manifest;
  assert.equal(target.contractVersion, 1);
  assert.equal(target.id, 'fake');
  assert.equal(target.class, 'target');
  assert.equal(target.environment, 'fake');
  assert.equal(target.displayName, 'Fake (test-only)');
  assert.equal(target.visibility, 'test-only');
  assert.deepEqual([...target.capabilities], [
    'fake.t1', 'fake.t2', 'fake.t3', 'fake.network',
    'fake.p0.capture', 'fake.p0.display', 'fake.p0.canvas', 'fake.p0.targets',
  ]);
  assert.deepEqual(target.dependencies, []);

  const capability = env.capabilityAdapter.manifest;
  assert.equal(capability.contractVersion, 1);
  assert.equal(capability.id, 'fake.capability');
  assert.equal(capability.class, 'capability');
  assert.equal(capability.environment, 'fake');
  assert.equal(capability.visibility, 'test-only');
  assert.deepEqual([...capability.capabilities], ['fake.t1', 'fake.t3']);
  assert.deepEqual([...capability.operations], ['fake.t1.echo', 'fake.t1.identity', 'fake.t3.frame-stats']);

  const provider = env.p0Provider.manifest;
  assert.equal(provider.contractVersion, 1);
  assert.equal(provider.id, 'fake.p0');
  assert.equal(provider.class, 'p0');
  assert.equal(provider.environment, 'fake');
  assert.equal(provider.family, 'A');
  assert.deepEqual([...provider.families], ['A', 'B', 'C', 'D', 'E']);
  assert.equal(provider.visibility, 'test-only');
  assert.equal(assertProvider(env.p0Provider), env.p0Provider);
});

test('fake sources import only node builtins, core modules and local fixtures', () => {
  for (const file of ['adapter.js', 'fixtures.js']) {
    const source = readFileSync(new URL(`../../targets/fake/${file}`, import.meta.url), 'utf8');
    const specifiers = [...source.matchAll(/^\s*import\s[\s\S]*?from\s*'([^']+)'/gm)].map((match) => match[1]);
    assert.ok(specifiers.length > 0, `${file}: expected imports`);
    for (const specifier of specifiers) {
      assert.ok(
        specifier.startsWith('node:') || specifier.startsWith('../../core/') || specifier.startsWith('./'),
        `${file} must not import "${specifier}"`,
      );
    }
    assert.equal(specifiers.some((specifier) => /index\.js|cdp|chrom|playwright|puppeteer/i.test(specifier)), false);
  }
});

// ---------------------------------------------------------------------------
// TargetAdapter: probe (six independent axes)
// ---------------------------------------------------------------------------

test('probe returns six independent axes and never merges them', async () => {
  const { env, now } = makeEnv();
  const report = await env.targetAdapter.probe({
    scope: 'scope-1',
    snapshot: { revision: 7, environments: { fake: { enabled: true } } },
  });
  assert.deepEqual(Object.keys(report.axes).sort(), ['capability', 'connection', 'dependency', 'enabled', 'support', 'target']);
  assert.equal(report.axes.support.state, 'supported');
  assert.equal(report.axes.enabled.state, true);
  assert.equal(report.axes.dependency.state, 'ok');
  assert.equal(report.axes.connection.state, 'not-probed');
  assert.equal(report.axes.target.state, 'unbound');
  assert.equal(report.axes.capability.state, 'not-probed');
  assert.equal(report.checkedAt, now());
  assert.equal(report.configRevision, 7);
  assert.equal(Object.prototype.hasOwnProperty.call(report, 'ready'), false);

  const disabled = await env.targetAdapter.probe({
    snapshot: { revision: 8, environments: { fake: { enabled: false } } },
  });
  assert.equal(disabled.axes.enabled.state, false);
  assert.equal(disabled.axes.enabled.reason, 'config-disabled');
  assert.equal(disabled.configRevision, 8);
});

test('probe reports bound target and available capability after bind', async () => {
  const { env } = makeEnv();
  const session = await env.targetAdapter.createSession({ scope: 'scope-1', snapshot: { revision: 4 } });
  await session.bind('fake:target:1');
  const report = await env.targetAdapter.probe({ snapshot: { revision: 4, environments: { fake: { enabled: true } } } });
  assert.equal(report.axes.target.state, 'bound');
  assert.equal(report.axes.target.targetId, 'fake:target:1');
  assert.equal(report.axes.target.generation, 2);
  assert.equal(report.axes.capability.state, 'available');
  assert.equal(report.axes.capability.items['fake.t1'], 'available');
});

// ---------------------------------------------------------------------------
// TargetAdapter: session lifecycle
// ---------------------------------------------------------------------------

test('createSession/bind/close follows the generation and target lifecycle', async () => {
  const { env } = makeEnv();
  const session = await env.targetAdapter.createSession({ scope: 'scope-1', snapshot: { revision: 3 } });
  assert.equal(session.sessionId, 'fake:session:1');
  assert.equal(session.environment, 'fake');
  assert.equal(session.generation, 1);
  assert.equal(session.configRevision, 3);
  assert.equal(session.target, null);

  const targets = await session.listTargets();
  assert.deepEqual(targets.map((target) => target.targetId), ['fake:target:1', 'fake:target:2']);
  assert.ok(targets.every((target) => target.lifecycle === 'available'));

  const bound = await session.bind('fake:target:1');
  assert.equal(bound.lifecycle, 'bound');
  assert.equal(bound.generation, 2);
  assert.equal(session.generation, 2);
  assert.equal(session.target.targetId, 'fake:target:1');

  const closed = await session.close();
  assert.equal(closed.closed, true);
  assert.equal(closed.alreadyClosed, false);
  assert.equal(session.target, null);
  await assert.rejects(() => session.bind('fake:target:2'), (error) => {
    assert.ok(error instanceof AdapterError);
    assert.equal(error.code, 'TARGET_GONE');
    return true;
  });
  assert.equal(session.sessionId, 'fake:session:1');

  const disposed = await session.dispose();
  assert.equal(disposed.disposed, true);
  assert.equal((await session.dispose()).alreadyDisposed, true);
});

test('binding an unknown target reports TARGET_NOT_BOUND with a reason', async () => {
  const { env } = makeEnv();
  const session = await env.targetAdapter.createSession({});
  await assert.rejects(() => session.bind('fake:target:nope'), (error) => {
    assert.equal(error.code, 'TARGET_NOT_BOUND');
    assert.equal(error.details.reason, 'target-not-found');
    return true;
  });
});

// ---------------------------------------------------------------------------
// CapabilityAdapter: operationStatus and invoke
// ---------------------------------------------------------------------------

test('capability discovery reports not-probed before a target is bound', async () => {
  const { env } = makeEnv();
  const session = await env.targetAdapter.createSession({ scope: 'scope-1' });
  const before = env.capabilityAdapter.operationStatus({ session });
  for (const operation of ['fake.t1.echo', 'fake.t1.identity', 'fake.t3.frame-stats']) {
    assert.equal(before[operation].support, 'supported');
    assert.equal(before[operation].availability, 'not-probed');
    assert.equal(before[operation].reason, 'target-unbound');
  }
  const noSession = env.capabilityAdapter.operationStatus({});
  assert.equal(noSession['fake.t1.echo'].availability, 'not-probed');
  assert.equal(noSession['fake.t1.echo'].reason, 'session-unbound');
});

test('invoke echo/identity returns deterministic values plus a full evidence envelope', async () => {
  const { env, now } = makeEnv();
  const session = await boundSession(env);
  assert.equal(session.generation, 2);

  const echo = await env.capabilityAdapter.invoke({ operation: 'fake.t1.echo', args: { b: 2, a: 1 }, session });
  assert.equal(echo.value.json, '{"a":1,"b":2}');
  assert.equal(echo.value.sha256, sha256Hex(Buffer.from('{"a":1,"b":2}', 'utf8')));
  assert.deepEqual(echo.value.args, { a: 1, b: 2 });
  assertEvidence(echo.evidence, {
    session: session.sessionId,
    target: 'fake:target:1',
    generation: 2,
    configRevision: 3,
    operation: 'fake.t1.echo',
    source: 'targets/fake',
    capturedAt: now(),
  });

  const identity = await env.capabilityAdapter.invoke({ operation: 'fake.t1.identity', session });
  assert.equal(identity.value.environment, 'fake');
  assert.equal(identity.value.sessionId, session.sessionId);
  assert.equal(identity.value.targetId, 'fake:target:1');
  assert.equal(identity.value.targetGeneration, 2);
  assertEvidence(identity.evidence, { operation: 'fake.t1.identity', target: 'fake:target:1' });
});

test('invoke rejects unknown operations, missing sessions and stale generations', async () => {
  const { env } = makeEnv();
  const session = await boundSession(env);

  await assert.rejects(
    () => env.capabilityAdapter.invoke({ operation: 'fake.t9.nope', session }),
    (error) => {
      assert.equal(error.code, 'CAPABILITY_UNSUPPORTED');
      return true;
    },
  );

  await assert.rejects(
    () => env.capabilityAdapter.invoke({ operation: 'fake.t1.echo' }),
    (error) => {
      assert.equal(error.code, 'TARGET_NOT_BOUND');
      assert.equal(error.details.reason, 'session-missing');
      return true;
    },
  );

  await assert.rejects(
    () => env.capabilityAdapter.invoke({ operation: 'fake.t1.echo', args: { generation: session.generation + 1 }, session }),
    (error) => {
      assert.equal(error.code, 'GENERATION_MISMATCH');
      assert.equal(error.details.expected, session.generation);
      return true;
    },
  );
});

test('invoke reports TARGET_NOT_BOUND when the session has no bound target', async () => {
  const { env } = makeEnv();
  const session = await env.targetAdapter.createSession({});
  await assert.rejects(
    () => env.capabilityAdapter.invoke({ operation: 'fake.t1.identity', session }),
    (error) => {
      assert.equal(error.code, 'TARGET_NOT_BOUND');
      assert.equal(error.details.reason, 'target-unbound');
      return true;
    },
  );
});

test('invoke rejects a stale config revision with CONFIG_STALE', async () => {
  const { env } = makeEnv();
  const session = await env.targetAdapter.createSession({ scope: 'scope-1', snapshot: { revision: 5 } });
  await session.bind('fake:target:1');
  assert.equal(session.configRevision, 5);

  await assert.rejects(
    () => env.capabilityAdapter.invoke({ operation: 'fake.t1.echo', args: { revision: 4 }, session }),
    (error) => {
      assert.equal(error.code, 'CONFIG_STALE');
      assert.equal(error.details.expected, 5);
      assert.equal(error.details.actual, 4);
      return true;
    },
  );

  await assert.rejects(
    () => env.capabilityAdapter.invoke({ operation: 'fake.t1.echo', session, snapshot: { revision: 6 } }),
    (error) => {
      assert.equal(error.code, 'CONFIG_STALE');
      return true;
    },
  );

  const ok = await env.capabilityAdapter.invoke({
    operation: 'fake.t1.echo',
    args: { revision: 5 },
    session,
    snapshot: { revision: 5 },
  });
  assert.equal(ok.evidence.configRevision, 5);
});

test('lifecycle methods and P0 methods accept an AbortSignal', async () => {
  const { env } = makeEnv();
  const controller = new AbortController();
  const session = await env.targetAdapter.createSession({ scope: 'scope-1', snapshot: { revision: 2 }, signal: controller.signal });
  assert.equal((await session.listTargets({ signal: controller.signal })).length, 2);
  await session.bind('fake:target:1', { signal: controller.signal });

  const status = env.capabilityAdapter.operationStatus({ session, signal: controller.signal });
  assert.equal(status['fake.t1.echo'].availability, 'available');
  const family = env.p0Provider.familyStatus({ session, signal: controller.signal });
  assert.equal(family.capture.availability, 'available');

  const shot = await env.p0Provider.capture.screenshot({ session, signal: controller.signal });
  assert.equal(validateFrame(shot.frame).ok, true);
  const events = await env.p0Provider.network.events({ session, signal: controller.signal });
  assert.equal(events.count, 2);
  const display = await env.p0Provider.display.read({ session, signal: controller.signal });
  assert.equal(validateDisplaySpace(display.display).ok, true);
  const targets = await env.p0Provider.targets.list({ session, signal: controller.signal });
  assert.equal(targets.targets.length, 2);

  const aborted = new AbortController();
  aborted.abort(new AdapterError('TARGET_GONE', 'caller aborted', { reason: 'test-abort' }));
  await assert.rejects(
    () => env.targetAdapter.createSession({ signal: aborted.signal }),
    (error) => {
      assert.equal(error.code, 'TARGET_GONE');
      assert.equal(error.details.reason, 'test-abort');
      return true;
    },
  );
  await assert.rejects(
    () => session.listTargets({ signal: aborted.signal }),
    (error) => {
      assert.equal(error.details.reason, 'test-abort');
      return true;
    },
  );
  assert.equal((await session.close()).closed, true);
});

// ---------------------------------------------------------------------------
// P0Provider A–E
// ---------------------------------------------------------------------------

test('P0-A capture returns a valid 2x2 PNG frame with matching sha256', async () => {
  const { env, now } = makeEnv();
  const session = await boundSession(env);

  const shot = await env.p0Provider.capture.screenshot({ session });
  const frame = shot.frame;
  assert.equal(validateFrame(frame).ok, true);
  assert.equal(frame.rgba.width, 2);
  assert.equal(frame.rgba.height, 2);
  assert.equal(frame.encoded.format, 'png');
  assert.equal(frame.encoded.sha256, sha256Hex(frame.encoded.bytes));
  assert.equal(frame.mapping.from, 'document-css-px');
  assert.equal(frame.mapping.to, 'image-px');
  assert.equal(frame.mapping.scaleX, 1);
  assert.equal(frame.sourceTimestamp, now());
  assert.equal(frame.receivedAt, now());
  assertEvidence(frame.evidence, {
    session: session.sessionId,
    target: 'fake:target:1',
    generation: 2,
    configRevision: 3,
    operation: 'p0.capture.screenshot',
    source: 'targets/fake/capture',
  });

  const info = inspectPng(frame.encoded.bytes);
  assert.equal(info.validSignature, true);
  assert.equal(info.width, 2);
  assert.equal(info.height, 2);
  assert.equal(info.crcOk, true);

  const noSourceClock = await env.p0Provider.capture.screenshot({ session, args: { sourceTimestamp: null } });
  assert.equal(noSourceClock.frame.sourceTimestamp, null);
  assert.equal(validateFrame(noSourceClock.frame).ok, true);

  const frames = await env.p0Provider.capture.frames({ session });
  assert.equal(frames.count, 2);
  assert.equal(frames.integrity.total, 2);
  assert.equal(frames.integrity.state, 'complete');

  const image = await env.p0Provider.capture.image({ session, args: { frameId: frame.frameId } });
  assert.equal(image.sha256, frame.encoded.sha256);
});

test('P0-B network returns two neutral events without cdpSessionId and with null source clocks', async () => {
  const { env, now } = makeEnv();
  const session = await boundSession(env);

  const started = await env.p0Provider.network.start({ session });
  assert.equal(started.started, true);
  assert.equal(started.captureBodies, true);

  const result = await env.p0Provider.network.events({ session });
  assert.equal(result.count, 2);
  const [captured, unavailable] = result.events;
  assert.equal(validateNetworkEvent(captured).ok, true);
  assert.equal(validateNetworkEvent(unavailable).ok, true);
  assert.equal(Object.prototype.hasOwnProperty.call(captured, 'cdpSessionId'), false);
  assert.equal(Object.prototype.hasOwnProperty.call(unavailable, 'cdpSessionId'), false);
  assert.deepEqual(captured.requestKey, { requestId: 'fake:request:1', hopId: 0 });
  assert.deepEqual(unavailable.requestKey, { requestId: 'fake:request:2', hopId: 0 });
  assert.equal(captured.sourceTimestamp, null);
  assert.equal(unavailable.sourceTimestamp, null);
  assert.equal(captured.receivedAt, now());
  assert.equal(captured.body.state, 'captured');
  assert.equal(unavailable.body.state, 'unavailable');
  assert.equal(captured.transportRef.kind, 'fake');
  assertEvidence(result.evidence, { operation: 'p0.network.events', source: 'targets/fake/network' });

  const detail = await env.p0Provider.network.detail({ session, args: { requestId: 'fake:request:1', hopId: 0 } });
  assert.equal(detail.event.eventId, captured.eventId);
  assert.equal(detail.body.state, 'captured');

  await assert.rejects(
    () => env.p0Provider.network.detail({ session, args: { requestId: 'missing' } }),
    (error) => {
      assert.equal(error.code, 'INVALID_ARGUMENT');
      assert.equal(error.details.reason, 'event-not-found');
      return true;
    },
  );

  const stopped = await env.p0Provider.network.stop({ session });
  assert.equal(stopped.stopped, true);
});

test('P0-C display read returns a valid transform and can advance geometryVersion', async () => {
  const { env, now } = makeEnv();
  const session = await boundSession(env);

  const first = await env.p0Provider.display.read({ session });
  assert.equal(validateDisplaySpace(first.display).ok, true);
  assert.equal(first.display.space, 'document-css-px');
  assert.equal(first.display.geometryVersion, 1);
  assert.equal(first.display.transform.from, 'document-css-px');
  assert.equal(first.display.transform.to, 'image-px');
  assert.equal(first.display.transform.scaleX, 1);
  assert.equal(first.display.observedAt, now());
  assertEvidence(first.evidence, { operation: 'p0.display.read' });

  const second = await env.p0Provider.display.read({ session, args: { advance: true } });
  assert.equal(second.display.geometryVersion, 2);
  assert.equal(second.display.transform.geometryVersion, 2);
});

test('P0-D annotation write/read uses revision CAS and rejects stale generations', async () => {
  const { env } = makeEnv();
  const session = await boundSession(env);
  assert.equal(session.generation, 2);

  const doc = {
    docId: 'fake:annotation:fake:target:1',
    targetId: 'fake:target:1',
    generation: session.generation,
    geometryVersion: 1,
    revision: 0,
    shapes: [{ shapeId: 'shape-1', kind: 'rect', rect: { x: 0, y: 0, width: 1, height: 1 } }],
  };

  const first = await env.p0Provider.canvas.annotationWrite({ session, args: { doc, expectedRevision: 0 } });
  assert.equal(first.doc.revision, 1);
  assert.equal(validateAnnotationDoc(first.doc).ok, true);
  assertEvidence(first.evidence, { operation: 'p0.canvas.annotationWrite', target: 'fake:target:1' });

  const read = await env.p0Provider.canvas.annotationRead({ session });
  assert.equal(read.doc.revision, 1);
  assert.deepEqual(read.doc.shapes, doc.shapes);

  await assert.rejects(
    () => env.p0Provider.canvas.annotationWrite({ session, args: { doc, expectedRevision: 0 } }),
    (error) => {
      assert.equal(error.code, 'CONFIG_CONFLICT');
      assert.equal(error.details.currentRevision, 1);
      return true;
    },
  );

  await assert.rejects(
    () => env.p0Provider.canvas.annotationWrite({ session, args: { doc: { ...doc, generation: 1 }, expectedRevision: 1 } }),
    (error) => {
      assert.equal(error.code, 'GENERATION_MISMATCH');
      return true;
    },
  );

  await assert.rejects(
    () => env.p0Provider.canvas.annotationWrite({ session, args: { doc: { ...doc, targetId: 'fake:target:2' }, expectedRevision: 1 } }),
    (error) => {
      assert.equal(error.code, 'TARGET_GONE');
      return true;
    },
  );
});

test('P0-E targets only lists and manages leases; TargetAdapter owns bind/close', async () => {
  const { env, advance } = makeEnv();
  const session = await env.targetAdapter.createSession({ scope: 'scope-1', snapshot: { revision: 3 } });
  assert.equal(session.configRevision, 3);

  // Provider ownership boundary: no bind/close on the P0 targets family.
  assert.equal(env.p0Provider.targets.bind, undefined);
  assert.equal(env.p0Provider.targets.close, undefined);
  for (const method of ['list', 'leaseAcquire', 'leaseRelease', 'leaseStatus']) {
    assert.equal(typeof env.p0Provider.targets[method], 'function', method);
  }

  const listed = await env.p0Provider.targets.list({ session });
  assert.equal(listed.targets.length, 2);
  assertEvidence(listed.evidence, { operation: 'p0.targets.list' });

  const bound = await session.bind('fake:target:2');
  assert.equal(bound.targetId, 'fake:target:2');
  assert.equal(bound.lifecycle, 'bound');
  assert.equal(session.generation, 2);

  const lease = await env.p0Provider.targets.leaseAcquire({ session, args: { ttlMs: 1000 } });
  assert.equal(lease.lease.targetId, 'fake:target:2');
  assert.equal(lease.lease.generation, session.generation);
  assert.equal(lease.lease.expiresAt, START + 1000);
  assert.equal(lease.expired, false);
  assertEvidence(lease.evidence, { operation: 'p0.targets.leaseAcquire', target: 'fake:target:2' });

  advance(1000);
  const expired = await env.p0Provider.targets.leaseStatus({ session, args: { leaseId: lease.lease.leaseId } });
  assert.equal(expired.expired, true);
  assert.equal(expired.remainingMs, 0);
  assertEvidence(expired.evidence, { operation: 'p0.targets.leaseStatus' });

  const released = await env.p0Provider.targets.leaseRelease({ session, args: { leaseId: lease.lease.leaseId } });
  assert.equal(released.released, true);
  await assert.rejects(
    () => env.p0Provider.targets.leaseStatus({ session, args: { leaseId: lease.lease.leaseId } }),
    (error) => {
      assert.equal(error.code, 'INVALID_ARGUMENT');
      assert.equal(error.details.reason, 'lease-unknown');
      return true;
    },
  );

  const closed = await session.close();
  assert.equal(closed.closed, true);
  assert.equal(session.target, null);
});

test('providerCapabilities reports the five fake families with support and availability', async () => {
  const { env } = makeEnv();
  const unbound = providerCapabilities(env.p0Provider, {});
  for (const method of ['capture', 'network', 'display', 'canvas', 'targets']) {
    assert.equal(unbound[method].support, 'supported', method);
    assert.equal(unbound[method].availability, 'not-probed', method);
  }
  assert.deepEqual([...unbound.capture.capabilities], ['capture', 'frames', 'image']);

  const session = await boundSession(env);
  const bound = providerCapabilities(env.p0Provider, { session });
  for (const method of ['capture', 'network', 'display', 'canvas', 'targets']) {
    assert.equal(bound[method].availability, 'available', method);
    assert.equal(bound[method].reason, null, method);
  }
});

test('frame-stats aggregates frames produced by the same P0Provider', async () => {
  const { env } = makeEnv();
  const session = await boundSession(env);
  await env.p0Provider.capture.screenshot({ session });
  await env.p0Provider.capture.screenshot({ session });

  const stats = await env.capabilityAdapter.invoke({ operation: 'fake.t3.frame-stats', session });
  assert.equal(stats.value.count, 2);
  assert.equal(stats.value.width, 2);
  assert.equal(stats.value.height, 2);
  assert.equal(stats.value.sha256.length, 64);
  assert.equal(stats.value.frames.length, 2);
  assert.ok(stats.value.frames.every((frame) => frame.sha256.length === 64));
});

// ---------------------------------------------------------------------------
// Cross-adapter identity boundaries
// ---------------------------------------------------------------------------

test('closing a session invalidates old target references (no cross-target reuse)', async () => {
  const { env } = makeEnv();
  const first = await env.targetAdapter.createSession({ scope: 'scope-1', snapshot: { revision: 3 } });
  await first.bind('fake:target:1');
  const oldSessionId = first.sessionId;

  await first.close();

  await assert.rejects(
    () => env.capabilityAdapter.invoke({ operation: 'fake.t1.identity', session: first }),
    (error) => {
      assert.equal(error.code, 'TARGET_GONE');
      return true;
    },
  );
  await assert.rejects(
    () => env.p0Provider.capture.screenshot({ session: first }),
    (error) => {
      assert.equal(error.code, 'TARGET_GONE');
      return true;
    },
  );

  // Rebuilding the target requires a new session with a fresh generation.
  const second = await env.targetAdapter.createSession({ scope: 'scope-1', snapshot: { revision: 3 } });
  assert.notEqual(second.sessionId, oldSessionId);
  assert.equal(second.generation, 1);
  assert.equal(second.target, null);
  await second.bind('fake:target:1');
  const identity = await env.capabilityAdapter.invoke({ operation: 'fake.t1.identity', session: second });
  assert.equal(identity.value.targetId, 'fake:target:1');
  assert.equal(identity.value.targetGeneration, 2);
});

// ---------------------------------------------------------------------------
// A05 P0-D/E: target-scoped data must bind to the live target *and* generation
// ---------------------------------------------------------------------------

/** Minimal valid annotation document for the currently bound target. */
function annotationDocFor(session, targetId, shapes = [{ shapeId: 'shape-1', kind: 'rect', rect: { x: 0, y: 0, width: 1, height: 1 } }]) {
  return {
    docId: `fake:annotation:${targetId}`,
    targetId,
    generation: session.generation,
    geometryVersion: 1,
    revision: 0,
    shapes,
  };
}

test('rebinding to another target invalidates frames, annotations and leases (A05 P0-D/E)', async () => {
  const { env } = makeEnv();
  const session = await env.targetAdapter.createSession({ scope: 'scope-1', snapshot: { revision: 3 } });
  await session.bind('fake:target:1');
  const t1Generation = session.generation;
  assert.equal(t1Generation, 2);

  // --- t1: capture a frame, write an annotation, take a lease ---------------
  const shot = await env.p0Provider.capture.screenshot({ session });
  const t1Frame = shot.frame;
  assert.equal(t1Frame.targetId, 'fake:target:1');
  assert.equal(t1Frame.generation, t1Generation);
  assertEvidence(t1Frame.evidence, { target: 'fake:target:1', generation: t1Generation });

  const written = await env.p0Provider.canvas.annotationWrite({
    session,
    args: { doc: annotationDocFor(session, 'fake:target:1'), expectedRevision: 0 },
  });
  assert.equal(written.doc.revision, 1);
  assert.equal(written.doc.targetId, 'fake:target:1');

  const lease = await env.p0Provider.targets.leaseAcquire({ session, args: { ttlMs: 60_000 } });
  assert.equal(lease.lease.targetId, 'fake:target:1');
  assert.equal(lease.lease.generation, t1Generation);
  assert.equal(lease.expired, false);

  // Normal path still works while the binding is unchanged.
  const before = await env.p0Provider.capture.frames({ session });
  assert.equal(before.count, 1);
  assert.equal(before.frames[0].frameId, t1Frame.frameId);
  assert.equal((await env.p0Provider.canvas.annotationRead({ session })).doc.revision, 1);
  assert.equal((await env.p0Provider.targets.leaseStatus({ session, args: { leaseId: lease.lease.leaseId } })).expired, false);

  // --- rebind to t2 ---------------------------------------------------------
  await session.bind('fake:target:2');
  assert.equal(session.generation, t1Generation + 1);
  assert.equal(session.target.targetId, 'fake:target:2');

  // frames(): the t1 frame is gone, and the evidence names the live binding.
  const after = await env.p0Provider.capture.frames({ session });
  assert.equal(after.count, 0);
  assert.deepEqual(after.frames, []);
  assert.equal(after.integrity.total, 0);
  assertEvidence(after.evidence, {
    session: session.sessionId,
    target: 'fake:target:2',
    generation: t1Generation + 1,
    operation: 'p0.capture.frames',
  });

  // image(): the superseded frame is refused, never served as t2 bytes.
  await assert.rejects(
    () => env.p0Provider.capture.image({ session, args: { frameId: t1Frame.frameId } }),
    (error) => {
      assert.ok(error instanceof AdapterError);
      assert.equal(error.code, 'GENERATION_MISMATCH');
      assert.equal(error.details.expected, t1Generation + 1);
      assert.equal(error.details.actual, t1Generation);
      assert.equal(error.details.expectedTargetId, 'fake:target:2');
      assert.equal(error.details.actualTargetId, 'fake:target:1');
      assert.equal(error.details.reason, 'target-rebound');
      return true;
    },
  );

  // An unknown frame id is still a plain argument error (nothing to serve).
  await assert.rejects(
    () => env.p0Provider.capture.image({ session, args: { frameId: 'fake:frame:does-not-exist' } }),
    (error) => {
      assert.equal(error.code, 'INVALID_ARGUMENT');
      assert.equal(error.details.reason, 'frame-not-found');
      return true;
    },
  );

  // annotationRead(): the t1 document is refused instead of being relabelled.
  await assert.rejects(
    () => env.p0Provider.canvas.annotationRead({ session }),
    (error) => {
      assert.equal(error.code, 'GENERATION_MISMATCH');
      assert.equal(error.details.subject, 'annotation document');
      assert.equal(error.details.expectedTargetId, 'fake:target:2');
      assert.equal(error.details.actualTargetId, 'fake:target:1');
      return true;
    },
  );

  // annotationWrite(): the stale document's revision is not reused as the
  // starting point for the new target (t1 rev 1 must not look like t2 rev 1).
  await assert.rejects(
    () => env.p0Provider.canvas.annotationWrite({
      session,
      args: { doc: annotationDocFor(session, 'fake:target:2'), expectedRevision: 1 },
    }),
    (error) => {
      assert.equal(error.code, 'CONFIG_CONFLICT');
      assert.equal(error.details.expectedRevision, 1);
      assert.equal(error.details.currentRevision, 0);
      return true;
    },
  );

  // leaseStatus()/leaseRelease(): the t1 lease is invalid, not merely expired.
  const expectedLeaseDetails = (error) => {
    assert.equal(error.code, 'GENERATION_MISMATCH');
    assert.equal(error.details.reason, 'target-rebound');
    assert.equal(error.details.expected, t1Generation + 1);
    assert.equal(error.details.actual, t1Generation);
    assert.equal(error.details.expectedTargetId, 'fake:target:2');
    assert.equal(error.details.actualTargetId, 'fake:target:1');
    return true;
  };
  await assert.rejects(
    () => env.p0Provider.targets.leaseStatus({ session, args: { leaseId: lease.lease.leaseId } }),
    expectedLeaseDetails,
  );
  await assert.rejects(
    () => env.p0Provider.targets.leaseRelease({ session, args: { leaseId: lease.lease.leaseId } }),
    expectedLeaseDetails,
  );

  // frame-stats must not aggregate the superseded frame under the new evidence.
  const stats = await env.capabilityAdapter.invoke({ operation: 'fake.t3.frame-stats', session });
  assert.equal(stats.value.count, 0);
  assertEvidence(stats.evidence, { target: 'fake:target:2', generation: t1Generation + 1 });

  // --- the new binding still works end to end -------------------------------
  const fresh = await env.p0Provider.capture.screenshot({ session });
  assert.equal(fresh.frame.targetId, 'fake:target:2');
  assert.equal(fresh.frame.generation, t1Generation + 1);
  assertEvidence(fresh.frame.evidence, { target: 'fake:target:2', generation: t1Generation + 1 });

  const freshFrames = await env.p0Provider.capture.frames({ session });
  assert.equal(freshFrames.count, 1);
  assert.equal(freshFrames.frames[0].frameId, fresh.frame.frameId);
  const freshImage = await env.p0Provider.capture.image({ session, args: { frameId: fresh.frame.frameId } });
  assert.equal(freshImage.sha256, fresh.frame.encoded.sha256);

  const rewritten = await env.p0Provider.canvas.annotationWrite({
    session,
    args: { doc: annotationDocFor(session, 'fake:target:2', []), expectedRevision: 0 },
  });
  assert.equal(rewritten.doc.revision, 1);
  assert.equal(rewritten.doc.targetId, 'fake:target:2');
  assert.deepEqual(rewritten.doc.shapes, []);
  const readBack = await env.p0Provider.canvas.annotationRead({ session });
  assert.equal(readBack.doc.targetId, 'fake:target:2');
  assert.equal(readBack.doc.revision, 1);
  assertEvidence(readBack.evidence, { target: 'fake:target:2' });

  const freshLease = await env.p0Provider.targets.leaseAcquire({ session, args: { ttlMs: 1000 } });
  assert.notEqual(freshLease.lease.leaseId, lease.lease.leaseId);
  assert.equal((await env.p0Provider.targets.leaseStatus({ session, args: { leaseId: freshLease.lease.leaseId } })).expired, false);
});

test('rebinding the same target bumps the generation and invalidates prior frames and leases', async () => {
  const { env } = makeEnv();
  const session = await boundSession(env); // fake:target:1 at generation 2
  const firstGeneration = session.generation;

  const first = await env.p0Provider.capture.screenshot({ session });
  const lease = await env.p0Provider.targets.leaseAcquire({ session, args: { ttlMs: 60_000 } });
  const doc = annotationDocFor(session, 'fake:target:1');
  await env.p0Provider.canvas.annotationWrite({ session, args: { doc, expectedRevision: 0 } });
  assert.equal((await env.p0Provider.capture.frames({ session })).count, 1);

  const rebound = await session.bind('fake:target:1');
  assert.equal(rebound.targetId, 'fake:target:1');
  assert.equal(session.generation, firstGeneration + 1);

  const frames = await env.p0Provider.capture.frames({ session });
  assert.equal(frames.count, 0);
  assert.deepEqual(frames.frames, []);
  assertEvidence(frames.evidence, { target: 'fake:target:1', generation: firstGeneration + 1 });

  await assert.rejects(
    () => env.p0Provider.capture.image({ session, args: { frameId: first.frame.frameId } }),
    (error) => {
      assert.equal(error.code, 'GENERATION_MISMATCH');
      assert.equal(error.details.expected, firstGeneration + 1);
      assert.equal(error.details.actual, firstGeneration);
      // Same target id, different generation: the generation gate is what fires.
      assert.equal(error.details.expectedTargetId, 'fake:target:1');
      assert.equal(error.details.actualTargetId, 'fake:target:1');
      return true;
    },
  );

  await assert.rejects(
    () => env.p0Provider.targets.leaseStatus({ session, args: { leaseId: lease.lease.leaseId } }),
    (error) => {
      assert.equal(error.code, 'GENERATION_MISMATCH');
      assert.equal(error.details.reason, 'target-rebound');
      assert.equal(error.details.expected, firstGeneration + 1);
      assert.equal(error.details.actual, firstGeneration);
      assert.equal(error.details.expectedTargetId, 'fake:target:1');
      assert.equal(error.details.actualTargetId, 'fake:target:1');
      return true;
    },
  );
  await assert.rejects(
    () => env.p0Provider.targets.leaseRelease({ session, args: { leaseId: lease.lease.leaseId } }),
    (error) => {
      assert.equal(error.code, 'GENERATION_MISMATCH');
      return true;
    },
  );

  // Same target id, new generation: the old document is still stale.
  await assert.rejects(
    () => env.p0Provider.canvas.annotationRead({ session }),
    (error) => {
      assert.equal(error.code, 'GENERATION_MISMATCH');
      assert.equal(error.details.expected, firstGeneration + 1);
      assert.equal(error.details.actual, firstGeneration);
      return true;
    },
  );

  // The rebind does not permanently brick the binding: new work succeeds.
  const captured = await env.p0Provider.capture.screenshot({ session });
  assert.equal((await env.p0Provider.capture.frames({ session })).count, 1);
  assert.equal(captured.frame.generation, firstGeneration + 1);
  const replacement = await env.p0Provider.targets.leaseAcquire({ session, args: { ttlMs: 1000 } });
  assert.equal(replacement.lease.generation, firstGeneration + 1);
  assert.equal((await env.p0Provider.targets.leaseStatus({ session, args: { leaseId: replacement.lease.leaseId } })).expired, false);
  const rewrite = await env.p0Provider.canvas.annotationWrite({
    session,
    args: { doc: annotationDocFor(session, 'fake:target:1'), expectedRevision: 0 },
  });
  assert.equal(rewrite.doc.revision, 1);
  assert.equal(rewrite.doc.generation, firstGeneration + 1);
});

// ---------------------------------------------------------------------------
// Determinism and disposal
// ---------------------------------------------------------------------------

test('two environments with the same seed and clock produce identical fixtures', async () => {
  const a = makeEnv({ seed: 'det' });
  const b = makeEnv({ seed: 'det' });
  const sessionA = await boundSession(a.env);
  const sessionB = await boundSession(b.env);

  const frameA = (await a.env.p0Provider.capture.screenshot({ session: sessionA })).frame;
  const frameB = (await b.env.p0Provider.capture.screenshot({ session: sessionB })).frame;
  assert.equal(frameA.frameId, frameB.frameId);
  assert.equal(frameA.encoded.sha256, frameB.encoded.sha256);
  assert.ok(Buffer.from(frameA.encoded.bytes).equals(Buffer.from(frameB.encoded.bytes)));

  const eventsA = await a.env.p0Provider.network.events({ session: sessionA });
  const eventsB = await b.env.p0Provider.network.events({ session: sessionB });
  assert.deepEqual(eventsA.events, eventsB.events);

  const echoA = await a.env.capabilityAdapter.invoke({ operation: 'fake.t1.echo', args: { x: 1 }, session: sessionA });
  const echoB = await b.env.capabilityAdapter.invoke({ operation: 'fake.t1.echo', args: { x: 1 }, session: sessionB });
  assert.equal(echoA.value.sha256, echoB.value.sha256);
});

test('environment dispose is idempotent and closes live sessions', async () => {
  const { env } = makeEnv();
  const session = await boundSession(env);

  const first = await env.dispose();
  assert.deepEqual(first, { disposed: true, alreadyDisposed: false });
  const second = await env.dispose();
  assert.deepEqual(second, { disposed: true, alreadyDisposed: true });

  await assert.rejects(
    () => env.p0Provider.capture.screenshot({ session }),
    (error) => {
      assert.equal(error.code, 'TARGET_GONE');
      return true;
    },
  );

  const providerAgain = await env.p0Provider.dispose();
  assert.equal(providerAgain.alreadyDisposed, true);
  const targetAgain = await env.targetAdapter.dispose();
  assert.equal(targetAgain.alreadyDisposed, true);
  const capabilityAgain = await env.capabilityAdapter.dispose();
  assert.equal(capabilityAgain.alreadyDisposed, true);
});
