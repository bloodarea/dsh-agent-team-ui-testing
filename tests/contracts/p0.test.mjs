/**
 * Contract tests for core/p0.js: neutral models, validation, Web -> neutral
 * conversion, provider interface helpers, geometry mapping and the fake PNG
 * fixture (structure/CRC/determinism).
 *
 * No browser, no network, no repository writes.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { inflateSync } from 'node:zlib';
import { readFileSync } from 'node:fs';

import {
  BODY_STATES,
  DISPLAY_SPACES,
  P0_AVAILABILITY,
  P0_CAPABILITIES,
  P0_EVIDENCE_FIELDS,
  P0_FAMILIES,
  P0_FAMILY_METHODS,
  P0_SUPPORT,
  TARGET_LIFECYCLES,
  assertProvider,
  createAnnotationDoc,
  createDisplaySpace,
  createFrame,
  createLease,
  createNetworkEvent,
  createTargetIdentity,
  disposeProvider,
  frameIntegritySummary,
  fromNeutralAnnotation,
  mapFrameToDisplay,
  providerCapabilities,
  samePublicRequestKey,
  toNeutralAnnotation,
  toNeutralFrame,
  toNeutralNetworkEvent,
  transportIdFromRef,
  validateAnnotationDoc,
  validateDisplaySpace,
  validateFrame,
  validateLease,
  validateNetworkEvent,
  validateTargetIdentity,
} from '../../core/p0.js';
import { AdapterError } from '../../core/errors.js';
import { assertCompatibleMapping, invertTransform, mapPoint } from '../../core/geometry.js';
import {
  DEFAULT_PNG_PIXELS,
  createDeterministicPng,
  inspectPng,
  sha256Hex,
} from '../../targets/fake/fixtures.js';

const NOW = 1_700_000_000_000;

function evidence(overrides = {}) {
  return {
    version: 1,
    scope: 'scope-a',
    session: 's1',
    target: 't1',
    generation: 1,
    configRevision: 0,
    operation: 'test',
    source: 'test',
    capturedAt: NOW,
    ...overrides,
  };
}

function frameFixture(overrides = {}) {
  const png = createDeterministicPng({ width: 2, height: 2 });
  return createFrame({
    frameId: 'f1',
    sessionId: 's1',
    targetId: 't1',
    generation: 1,
    sourceTimestamp: NOW,
    receivedAt: NOW,
    encoded: { format: 'png', bytes: png.bytes, sha256: png.sha256, byteLength: png.bytes.length },
    rgba: { width: 2, height: 2, sha256: sha256Hex(png.rgba) },
    mapping: {
      from: 'document-css-px',
      to: 'image-px',
      scaleX: 1,
      scaleY: 1,
      offsetX: 0,
      offsetY: 0,
      geometryVersion: 1,
    },
    integrity: { state: 'complete', dropped: 0, evicted: 0, incomplete: 0, reason: null },
    evidence: evidence(),
    ...overrides,
  });
}

function eventFixture(overrides = {}) {
  return createNetworkEvent({
    eventId: 'e1',
    requestKey: { requestId: 'r1', hopId: 0 },
    sessionId: 's1',
    targetId: 't1',
    generation: 1,
    phase: 'response',
    kind: 'http',
    method: 'GET',
    url: 'https://fake.test/api/items',
    status: 200,
    sourceTimestamp: null,
    receivedAt: NOW,
    body: { state: 'captured', data: '{"ok":true}' },
    transportRef: { kind: 'fake', handle: 'h1' },
    ...overrides,
  });
}

function displayFixture(overrides = {}) {
  return createDisplaySpace({
    space: 'document-css-px',
    geometryVersion: 1,
    transform: {
      from: 'document-css-px',
      to: 'image-px',
      scaleX: 1,
      scaleY: 1,
      offsetX: 0,
      offsetY: 0,
      geometryVersion: 1,
    },
    observedAt: NOW,
    source: 'test',
    ...overrides,
  });
}

function annotationFixture(overrides = {}) {
  return createAnnotationDoc({
    docId: 'doc-1',
    targetId: 't1',
    generation: 1,
    geometryVersion: 1,
    revision: 0,
    shapes: [{ shapeId: 's1', kind: 'rect', rect: { x: 0, y: 0, width: 1, height: 1 } }],
    ...overrides,
  });
}

// ---------------------------------------------------------------------------
// Constants and factories
// ---------------------------------------------------------------------------

test('P0 family constants cover A–E with their capabilities', () => {
  assert.deepEqual(Object.keys(P0_FAMILIES), ['A', 'B', 'C', 'D', 'E']);
  assert.equal(P0_FAMILIES.A, 'A');
  assert.deepEqual([...P0_CAPABILITIES.A], ['capture', 'frames', 'image']);
  assert.deepEqual([...P0_CAPABILITIES.B], ['network', 'events', 'body', 'control']);
  assert.deepEqual([...P0_CAPABILITIES.C], ['display', 'geometry']);
  assert.deepEqual([...P0_CAPABILITIES.D], ['canvas', 'annotation', 'preview']);
  assert.deepEqual([...P0_CAPABILITIES.E], ['targets', 'lease', 'lifecycle']);
  assert.deepEqual(P0_FAMILY_METHODS, { A: 'capture', B: 'network', C: 'display', D: 'canvas', E: 'targets' });
  assert.deepEqual([...DISPLAY_SPACES], [
    'document-css-px', 'image-px', 'viewport-css-px', 'screen-logical-px', 'screen-physical-px',
  ]);
  assert.equal(P0_SUPPORT.UNSUPPORTED, 'unsupported');
  assert.equal(P0_AVAILABILITY.NOT_PROBED, 'not-probed');
  assert.deepEqual([...BODY_STATES], ['captured', 'empty', 'unavailable', 'omitted']);
  assert.deepEqual([...TARGET_LIFECYCLES], ['available', 'bound', 'closed', 'stale', 'gone']);
});

test('factories normalise undefined nullable fields to null (never undefined)', () => {
  const frame = createFrame({ frameId: 'f1' });
  assert.equal(frame.sourceTimestamp, null);
  assert.ok(Object.prototype.hasOwnProperty.call(frame, 'sourceTimestamp'));
  assert.equal(frame.encoded, null);
  assert.equal(frame.generation, null);
  assert.equal(createNetworkEvent({ eventId: 'e1' }).sourceTimestamp, null);
  assert.equal(createTargetIdentity({ targetId: 't1' }).label, null);
});

test('core/p0.js imports only node: builtins plus core/geometry.js and core/errors.js (A02 boundary)', () => {
  const source = readFileSync(new URL('../../core/p0.js', import.meta.url), 'utf8');
  const specifiers = [...source.matchAll(/^\s*import\s[\s\S]*?from\s*'([^']+)'/gm)].map((match) => match[1]);
  assert.ok(specifiers.length > 0, 'expected at least one import');
  for (const specifier of specifiers) {
    assert.ok(
      specifier.startsWith('node:') || specifier === './geometry.js' || specifier === './errors.js',
      `core/p0.js must not import "${specifier}"`,
    );
  }
  assert.equal(specifiers.some((specifier) => /index\.js|targets\/|cdp|chrom/i.test(specifier)), false);
});

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

test('validateFrame accepts a complete neutral frame', () => {
  assert.deepEqual(validateFrame(frameFixture()), { ok: true, missing: [], errors: [] });
});

test('validateFrame reports every missing required field', () => {
  const check = validateFrame({});
  assert.equal(check.ok, false);
  for (const key of ['frameId', 'sessionId', 'targetId', 'generation', 'sourceTimestamp', 'receivedAt', 'encoded', 'rgba', 'mapping', 'integrity', 'evidence']) {
    assert.ok(check.missing.includes(key), `expected missing ${key}, got ${check.missing.join(',')}`);
  }
  assert.ok(check.errors.some((error) => error.code === 'MISSING_FIELD'));
});

test('sourceTimestamp null is legal while undefined is reported', () => {
  const withNull = frameFixture({ sourceTimestamp: null });
  assert.equal(validateFrame(withNull).ok, true);

  const withoutKey = frameFixture();
  delete withoutKey.sourceTimestamp;
  const check = validateFrame(withoutKey);
  assert.equal(check.ok, false);
  assert.ok(check.missing.includes('sourceTimestamp'));

  const undefinedValue = frameFixture({ sourceTimestamp: undefined });
  assert.equal(undefinedValue.sourceTimestamp, null);
  assert.equal(validateFrame(undefinedValue).ok, true);
});

test('validateNetworkEvent rejects a cdpSessionId leak in public keys', () => {
  const direct = eventFixture();
  direct.cdpSessionId = 'cdp-1';
  const directCheck = validateNetworkEvent(direct);
  assert.equal(directCheck.ok, false);
  assert.ok(directCheck.errors.some((error) => error.code === 'PLATFORM_IDENTITY_LEAK' && error.path === 'cdpSessionId'));

  const nested = eventFixture();
  nested.requestKey.cdpSessionId = 'cdp-1';
  const nestedCheck = validateNetworkEvent(nested);
  assert.equal(nestedCheck.ok, false);
  assert.ok(nestedCheck.errors.some((error) => error.code === 'PLATFORM_IDENTITY_LEAK' && error.path === 'requestKey.cdpSessionId'));

  assert.equal(validateNetworkEvent(eventFixture()).ok, true);
});

test('validateDisplaySpace / validateAnnotationDoc / validateTargetIdentity / validateLease accept valid models', () => {
  assert.equal(validateDisplaySpace(displayFixture()).ok, true);
  assert.equal(validateAnnotationDoc(annotationFixture()).ok, true);
  const identity = createTargetIdentity({
    targetId: 't1',
    environment: 'fake',
    kind: 'fake-window',
    generation: 1,
    label: 'Fake Window 1',
    lifecycle: 'available',
  });
  assert.equal(validateTargetIdentity(identity).ok, true);
  const lease = createLease({
    leaseId: 'l1',
    targetId: 't1',
    generation: 1,
    owner: { kind: 'session', id: 's1' },
    expiresAt: NOW + 1000,
  });
  assert.equal(validateLease(lease).ok, true);
});

test('validators reject bad enums and shapes', () => {
  const badIdentity = createTargetIdentity({
    targetId: 't1', environment: 'fake', kind: 'fake-window', generation: 1, label: 'x', lifecycle: 'bogus',
  });
  assert.ok(validateTargetIdentity(badIdentity).errors.some((error) => error.code === 'INVALID_LIFECYCLE'));

  const duplicateShapes = annotationFixture({ shapes: [{ shapeId: 's1', kind: 'rect' }, { shapeId: 's1', kind: 'rect' }] });
  assert.ok(validateAnnotationDoc(duplicateShapes).errors.some((error) => error.code === 'DUPLICATE_SHAPE_ID'));

  const badDisplay = displayFixture({ space: 'not-a-space' });
  assert.ok(validateDisplaySpace(badDisplay).errors.some((error) => error.code === 'INVALID_SPACE'));

  const badLease = createLease({ leaseId: 'l1', targetId: 't1', generation: 1, owner: 42, expiresAt: NOW });
  assert.ok(validateLease(badLease).errors.some((error) => error.code === 'INVALID_OWNER'));
});

// ---------------------------------------------------------------------------
// Web -> neutral conversion
// ---------------------------------------------------------------------------

test('toNeutralNetworkEvent moves cdpSessionId into transportRef', () => {
  const webEvent = {
    seq: 3,
    sessionId: 's1',
    targetId: 't1',
    generation: 1,
    kind: 'http',
    phase: 'response',
    requestId: 'r1',
    hopId: 2,
    cdpSessionId: 'cdp-9',
    frameId: 'frame-1',
    url: 'https://fake.test/api/items',
    method: 'GET',
    status: 200,
    sourceTimestamp: null,
    receivedAt: NOW,
    body: { state: 'captured', data: '{}' },
    ts: { wallMs: NOW - 5 },
  };
  const neutral = toNeutralNetworkEvent(webEvent);
  assert.equal(Object.prototype.hasOwnProperty.call(neutral, 'cdpSessionId'), false);
  assert.equal(neutral.transportRef.kind, 'web');
  assert.equal(neutral.transportRef.cdpSessionId, 'cdp-9');
  assert.deepEqual(neutral.requestKey, {
    requestId: 'r1',
    hopId: 2,
    transportId: transportIdFromRef(neutral.transportRef),
  });
  // An explicit null source timestamp is preserved, never replaced by receivedAt/ts.
  assert.equal(neutral.sourceTimestamp, null);
  assert.equal(neutral.receivedAt, NOW);
  assert.equal(validateNetworkEvent(neutral).ok, true);
});

test('toNeutralNetworkEvent derives the source clock only when sourceTimestamp is absent', () => {
  const webEvent = {
    seq: 1, sessionId: 's1', targetId: 't1', generation: 1, kind: 'http', phase: 'request',
    requestId: 'r1', hopId: 0, url: 'https://fake.test/', ts: { wallMs: NOW - 42 },
  };
  const neutral = toNeutralNetworkEvent(webEvent);
  assert.equal(neutral.sourceTimestamp, NOW - 42);
  assert.equal(neutral.receivedAt, NOW - 42);
  assert.equal(validateNetworkEvent(neutral).ok, true);
});

test('toNeutralFrame hashes encoded bytes and keeps source/received clocks separate', () => {
  const bytes = Buffer.from([1, 2, 3, 4, 5, 6]);
  const webFrame = {
    seq: 7,
    sessionId: 's1',
    targetId: 't1',
    generation: 1,
    data: bytes.toString('base64'),
    format: 'jpeg',
    width: 4,
    height: 2,
    pageWidth: 8,
    pageHeight: 4,
    scrollX: 0,
    scrollY: 0,
    capturedAt: NOW,
    receivedAt: NOW + 5,
    configRevision: 2,
  };
  const frame = toNeutralFrame(webFrame);
  assert.equal(frame.encoded.sha256, sha256Hex(bytes));
  assert.equal(frame.encoded.byteLength, bytes.length);
  // image 4x2 / page 8x4 -> 0.5 (document-css-px -> image-px)
  assert.equal(frame.mapping.scaleX, 0.5);
  assert.equal(frame.mapping.scaleY, 0.5);
  assert.equal(frame.mapping.offsetX, 0);
  assert.equal(frame.mapping.offsetY, 0);
  assert.equal(frame.sourceTimestamp, NOW);
  assert.equal(frame.receivedAt, NOW + 5);
  assert.equal(frame.evidence.configRevision, 2);
  assert.equal(validateFrame(frame).ok, true);

  const withoutCapturedAt = { ...webFrame };
  delete withoutCapturedAt.capturedAt;
  const frame2 = toNeutralFrame(withoutCapturedAt);
  assert.equal(frame2.sourceTimestamp, null);
  assert.equal(frame2.receivedAt, NOW + 5);
});

test('converters are deterministic for identical input', () => {
  const webEvent = {
    seq: 2, sessionId: 's1', targetId: 't1', generation: 1, kind: 'http', phase: 'response',
    requestId: 'r1', hopId: 0, url: 'https://fake.test/', cdpSessionId: 'cdp-1', receivedAt: NOW,
  };
  assert.equal(JSON.stringify(toNeutralNetworkEvent(webEvent)), JSON.stringify(toNeutralNetworkEvent(webEvent)));

  const webFrame = {
    seq: 1, sessionId: 's1', targetId: 't1', generation: 1, data: Buffer.from('abc').toString('base64'),
    format: 'png', width: 2, height: 2, pageWidth: 2, pageHeight: 2, capturedAt: NOW, receivedAt: NOW,
  };
  assert.equal(JSON.stringify(toNeutralFrame(webFrame)), JSON.stringify(toNeutralFrame(webFrame)));
});

// ---------------------------------------------------------------------------
// Audit A03 — image/page scale direction (mapping is document-css-px -> image-px)
// ---------------------------------------------------------------------------

test('toNeutralFrame scales document-css-px -> image-px by image/page (audit A03 counter-example)', () => {
  // image 4x2, page 8x4, scroll (10,20).
  const frame = toNeutralFrame({
    seq: 11,
    sessionId: 's1',
    targetId: 't1',
    generation: 1,
    data: Buffer.from('abcd').toString('base64'),
    format: 'png',
    width: 4,
    height: 2,
    pageWidth: 8,
    pageHeight: 4,
    scrollX: 10,
    scrollY: 20,
    capturedAt: NOW,
    receivedAt: NOW,
  });
  assert.equal(frame.mapping.from, 'document-css-px');
  assert.equal(frame.mapping.to, 'image-px');
  assert.equal(frame.mapping.scaleX, 0.5);
  assert.equal(frame.mapping.scaleY, 0.5);
  assert.equal(frame.mapping.offsetX, -5);
  assert.equal(frame.mapping.offsetY, -10);
  // The audited counter-example: document point (18,24) lands on image pixel (4,2).
  assert.deepEqual(mapPoint(frame.mapping, { x: 18, y: 24 }), { x: 4, y: 2 });
  // And the inverse mapping is a true inverse (image-px -> document-css-px).
  assert.deepEqual(mapPoint(invertTransform(frame.mapping), { x: 4, y: 2 }), { x: 18, y: 24 });
  assert.equal(validateFrame(frame).ok, true);
});

test('toNeutralFrame keeps fractional image/page scales exact (750x300 over 1000x500)', () => {
  const frame = toNeutralFrame({
    seq: 12,
    sessionId: 's1',
    targetId: 't1',
    generation: 1,
    data: Buffer.from('efgh').toString('base64'),
    format: 'png',
    width: 750,
    height: 300,
    pageWidth: 1000,
    pageHeight: 500,
    scrollX: 100,
    scrollY: 50,
    capturedAt: NOW,
    receivedAt: NOW,
  });
  assert.equal(frame.mapping.scaleX, 0.75);
  assert.equal(frame.mapping.scaleY, 0.6);
  assert.equal(frame.mapping.offsetX, -75);
  assert.equal(frame.mapping.offsetY, -30);
  // No rounding: the transform is affine, so fractional results survive.
  assert.deepEqual(mapPoint(frame.mapping, { x: 300, y: 200 }), { x: 150, y: 90 });
  assert.deepEqual(mapPoint(frame.mapping, { x: 10, y: 10 }), { x: -67.5, y: -24 });
  // The image rectangle 750x300 maps back to exactly the 1000x500 page.
  assert.deepEqual(mapPoint(invertTransform(frame.mapping), { x: 0, y: 0 }), { x: 100, y: 50 });
  assert.deepEqual(mapPoint(invertTransform(frame.mapping), { x: 750, y: 300 }), { x: 1100, y: 550 });
  assert.equal(validateFrame(frame).ok, true);
});

test('a frame carrying the old (inverted) mapping direction is rejected, not compared', () => {
  // Pre-fix frames declared `from: image-px -> to: document-css-px` while
  // documenting `document-css-px -> image-px`: an old observation must never be
  // compared against a current display space.
  const oldFrame = frameFixture({
    mapping: {
      from: 'image-px',
      to: 'document-css-px',
      scaleX: 2,
      scaleY: 2,
      offsetX: -10,
      offsetY: -20,
      geometryVersion: 1,
    },
  });
  assert.equal(validateFrame(oldFrame).ok, true, 'the legacy mapping is still a well-formed mapping');
  assert.throws(() => mapFrameToDisplay(oldFrame, displayFixture()), (error) => {
    assert.ok(error instanceof AdapterError);
    assert.equal(error.code, 'GENERATION_MISMATCH');
    assert.equal(error.details.reason, 'space-mismatch');
    return true;
  });
  assert.throws(
    () => assertCompatibleMapping(oldFrame.mapping, displayFixture().transform),
    (error) => {
      assert.ok(error instanceof AdapterError);
      assert.equal(error.code, 'CAPABILITY_UNSUPPORTED');
      return true;
    },
  );
});

// ---------------------------------------------------------------------------
// Audit A04 — public network identity carries the transport scope
// ---------------------------------------------------------------------------

function webEventForTransport(cdpSessionId, overrides = {}) {
  return {
    seq: 4,
    sessionId: 's1',
    targetId: 't1',
    generation: 1,
    kind: 'http',
    phase: 'response',
    requestId: 'r1',
    hopId: 2,
    cdpSessionId,
    url: 'https://fake.test/api/items',
    method: 'GET',
    status: 200,
    receivedAt: NOW,
    body: { state: 'unavailable' },
    ...overrides,
  };
}

test('same requestId on different transports yields different public keys and event ids', () => {
  const a = toNeutralNetworkEvent(webEventForTransport('cdp-A'));
  const b = toNeutralNetworkEvent(webEventForTransport('cdp-B'));

  assert.notEqual(a.requestKey.transportId, b.requestKey.transportId);
  assert.notDeepEqual(a.requestKey, b.requestKey);
  assert.equal(samePublicRequestKey(a.requestKey, b.requestKey), false);
  assert.notEqual(a.eventId, b.eventId);
  // Only the irreversible digest differs; the raw session ids stay in transportRef.
  assert.equal(a.transportRef.cdpSessionId, 'cdp-A');
  assert.equal(b.transportRef.cdpSessionId, 'cdp-B');
  assert.equal(validateNetworkEvent(a).ok, true);
  assert.equal(validateNetworkEvent(b).ok, true);
});

test('the same transport produces stable, equal public keys and event ids', () => {
  const first = toNeutralNetworkEvent(webEventForTransport('cdp-A'));
  const second = toNeutralNetworkEvent(webEventForTransport('cdp-A'));
  assert.deepEqual(first.requestKey, second.requestKey);
  assert.equal(samePublicRequestKey(first.requestKey, second.requestKey), true);
  assert.equal(first.eventId, second.eventId);
  // Same request id, different phase -> different event id, same request key.
  const otherPhase = toNeutralNetworkEvent(webEventForTransport('cdp-A', { phase: 'finished' }));
  assert.equal(samePublicRequestKey(first.requestKey, otherPhase.requestKey), true);
  assert.notEqual(first.eventId, otherPhase.eventId);
  // Different hop of the same redirect chain -> different request key.
  const otherHop = toNeutralNetworkEvent(webEventForTransport('cdp-A', { hopId: 3 }));
  assert.equal(samePublicRequestKey(first.requestKey, otherHop.requestKey), false);
});

test('a neutral request key never carries cdpSessionId, only the transport digest', () => {
  const neutral = toNeutralNetworkEvent(webEventForTransport('cdp-A', {
    frameId: 'frame-1',
    loaderId: 'loader-1',
  }));
  assert.equal(Object.prototype.hasOwnProperty.call(neutral.requestKey, 'cdpSessionId'), false);
  assert.deepEqual(Object.keys(neutral.requestKey).sort(), ['hopId', 'requestId', 'transportId']);
  assert.match(neutral.requestKey.transportId, /^[0-9a-f]{16}$/);
  assert.equal(neutral.transportRef.cdpSessionId, 'cdp-A');
  assert.equal(neutral.transportRef.frameId, 'frame-1');
  assert.equal(neutral.transportRef.loaderId, 'loader-1');
  // The digest is a deterministic function of the transportRef scope fields only.
  assert.equal(neutral.requestKey.transportId, transportIdFromRef(neutral.transportRef));
  assert.equal(validateNetworkEvent(neutral).ok, true);
});

test('transportId falls back to a stable local scope when no transport identity exists', () => {
  assert.equal(transportIdFromRef({ kind: 'web' }), 'web:local');
  assert.equal(transportIdFromRef({ kind: 'web', cdpSessionId: null, targetId: null }), 'web:local');
  assert.equal(transportIdFromRef({}), 'neutral:local');
  const local = toNeutralNetworkEvent({
    seq: 5, sessionId: 's1', generation: 1, kind: 'http', phase: 'request',
    requestId: 'r1', hopId: 0, url: 'https://fake.test/', receivedAt: NOW,
  });
  assert.equal(local.requestKey.transportId, 'web:local');
  assert.equal(validateNetworkEvent(local).ok, true);
});

test('validateNetworkEvent rejects a malformed requestKey.transportId but accepts a missing one', () => {
  const legacy = eventFixture();
  assert.equal(Object.prototype.hasOwnProperty.call(legacy.requestKey, 'transportId'), false);
  assert.equal(validateNetworkEvent(legacy).ok, true, 'a legacy key without a transport scope still validates');

  for (const bad of [null, '', 7]) {
    const invalid = eventFixture({ requestKey: { requestId: 'r1', hopId: 0, transportId: bad } });
    const check = validateNetworkEvent(invalid);
    assert.equal(check.ok, false, `transportId ${JSON.stringify(bad)} must not validate`);
    assert.ok(check.errors.some((error) => error.code === 'INVALID_TYPE' && error.path === 'requestKey.transportId'));
  }
});

// ---------------------------------------------------------------------------
// Geometry mapping
// ---------------------------------------------------------------------------

test('mapFrameToDisplay maps frame image bounds into the display space', () => {
  const frame = frameFixture();
  const display = displayFixture({
    transform: {
      from: 'document-css-px',
      to: 'image-px',
      scaleX: 2,
      scaleY: 2,
      offsetX: -10,
      offsetY: -20,
      geometryVersion: 1,
    },
  });
  const mapped = mapFrameToDisplay(frame, display);
  // image (0,0) 2x2 -> doc space: x = (0 + 10) / 2 = 5, y = (0 + 20) / 2 = 10, size 1x1
  assert.deepEqual(mapped.bounds, { x: 5, y: 10, width: 1, height: 1 });
  assert.equal(mapped.space, 'document-css-px');
  assert.equal(mapped.geometryVersion, 1);
  assert.equal(mapped.transform.from, 'image-px');
  assert.equal(mapped.transform.to, 'document-css-px');
  assert.equal(mapped.evidence.operation, 'p0.map.frame-to-display');
});

test('mapFrameToDisplay rejects incompatible mappings with GENERATION_MISMATCH', () => {
  const frame = frameFixture();

  const otherVersion = displayFixture({ geometryVersion: 2 });
  assert.throws(() => mapFrameToDisplay(frame, otherVersion), (error) => {
    assert.ok(error instanceof AdapterError);
    assert.equal(error.code, 'GENERATION_MISMATCH');
    return true;
  });

  const otherSpace = displayFixture({
    space: 'viewport-css-px',
    transform: {
      from: 'viewport-css-px',
      to: 'image-px',
      scaleX: 1,
      scaleY: 1,
      offsetX: 0,
      offsetY: 0,
      geometryVersion: 1,
    },
  });
  assert.throws(() => mapFrameToDisplay(frame, otherSpace), (error) => {
    assert.equal(error.code, 'GENERATION_MISMATCH');
    return true;
  });

  const invalidFrame = frameFixture();
  delete invalidFrame.generation;
  assert.throws(() => mapFrameToDisplay(invalidFrame, displayFixture()), (error) => {
    assert.equal(error.code, 'INVALID_ARGUMENT');
    return true;
  });
});

// ---------------------------------------------------------------------------
// Provider helpers
// ---------------------------------------------------------------------------

function providerFixture(overrides = {}) {
  return {
    manifest: { contractVersion: 1, id: 'p', class: 'p0', environment: 'fake', family: 'A', families: ['A', 'B'] },
    capture: { async screenshot() { return {}; } },
    ...overrides,
  };
}

test('providerCapabilities separates support from availability', () => {
  const provider = providerFixture();
  assert.equal(assertProvider(provider), provider);

  const unbound = providerCapabilities(provider, {});
  assert.equal(unbound.capture.support, 'supported');
  assert.equal(unbound.capture.availability, 'not-probed');
  assert.equal(unbound.capture.reason, 'session-unbound');
  assert.equal(unbound.network.support, 'unsupported');
  assert.equal(unbound.network.reason, 'method-missing');
  assert.equal(unbound.display.reason, 'family-not-declared');
  assert.equal(unbound.canvas.reason, 'family-not-declared');

  const session = { sessionId: 's1', target: { targetId: 't1' } };
  const bound = providerCapabilities(provider, { session });
  assert.equal(bound.capture.availability, 'available');
  assert.equal(bound.capture.reason, null);
  assert.equal(bound.network.support, 'unsupported');
});

test('providerCapabilities reads familyStatus (not capabilities) for per-family status', () => {
  const provider = providerFixture({
    familyStatus() {
      return { capture: { support: 'supported', availability: 'busy', reason: 'capture-busy' } };
    },
  });
  const caps = providerCapabilities(provider, { session: { sessionId: 's1', target: { targetId: 't1' } } });
  assert.equal(caps.capture.availability, 'busy');
  assert.equal(caps.capture.reason, 'capture-busy');

  // The old `capabilities` name is not consulted: familyStatus is the frozen name.
  const legacy = providerFixture({
    capabilities() {
      return { capture: { support: 'supported', availability: 'busy', reason: 'ignored' } };
    },
  });
  const legacyCaps = providerCapabilities(legacy, { session: { sessionId: 's1', target: { targetId: 't1' } } });
  assert.equal(legacyCaps.capture.availability, 'available');
});

test('providerCapabilities reports not-probed when the session has no bound target', () => {
  const provider = providerFixture();
  const session = { sessionId: 's1', target: null };
  const caps = providerCapabilities(provider, { session });
  assert.equal(caps.capture.availability, 'not-probed');
  assert.equal(caps.capture.reason, 'target-unbound');
});

test('assertProvider rejects a non-p0 manifest and unknown families', () => {
  assert.throws(() => assertProvider({ manifest: { class: 'target', family: 'A' } }), (error) => {
    assert.equal(error.code, 'CAPABILITY_UNSUPPORTED');
    return true;
  });
  assert.throws(() => assertProvider({ manifest: { class: 'p0', family: 'Z' } }), (error) => {
    assert.equal(error.code, 'CAPABILITY_UNSUPPORTED');
    return true;
  });
  assert.throws(() => assertProvider({ manifest: { class: 'p0', families: [] } }), (error) => {
    assert.equal(error.code, 'CAPABILITY_UNSUPPORTED');
    return true;
  });
  // All five family methods are optional.
  assert.doesNotThrow(() => assertProvider({ manifest: { class: 'p0', family: 'E' } }));
});

test('disposeProvider is idempotent and tolerates a missing dispose', async () => {
  let calls = 0;
  const provider = { async dispose() { calls += 1; return { disposed: true }; } };
  const first = await disposeProvider(provider);
  const second = await disposeProvider(provider);
  assert.deepEqual(first, { disposed: true, alreadyDisposed: false });
  assert.deepEqual(second, { disposed: true, alreadyDisposed: true });
  assert.equal(calls, 1);
  assert.deepEqual(await disposeProvider({}), { disposed: false, reason: 'no-dispose' });
});

// ---------------------------------------------------------------------------
// Annotation legacy export/import
// ---------------------------------------------------------------------------

test('fromNeutralAnnotation always carries an explicit formatVersion', () => {
  const legacy = fromNeutralAnnotation(annotationFixture());
  assert.equal(legacy.formatVersion, 1);
  assert.equal(legacy.kind, 'annotation-doc');
  assert.equal(legacy.docId, 'doc-1');
  assert.equal(legacy.shapes.length, 1);

  const roundTrip = toNeutralAnnotation(legacy);
  assert.equal(validateAnnotationDoc(roundTrip).ok, true);
  assert.deepEqual(roundTrip.shapes, legacy.shapes);

  assert.throws(() => toNeutralAnnotation({ ...legacy, formatVersion: undefined }), (error) => {
    assert.equal(error.code, 'CONFIG_INVALID');
    return true;
  });
});

// ---------------------------------------------------------------------------
// Frame integrity
// ---------------------------------------------------------------------------

test('frameIntegritySummary counts dropped/evicted/incomplete', () => {
  const frames = [
    frameFixture(),
    frameFixture({ integrity: { state: 'incomplete', dropped: 2, evicted: 1, incomplete: 1, reason: 'gap' } }),
    frameFixture({ integrity: { state: 'incomplete', dropped: 0, evicted: 3, incomplete: 0, reason: 'evicted' } }),
    frameFixture({ integrity: null }),
  ];
  const summary = frameIntegritySummary(frames);
  assert.equal(summary.total, 4);
  assert.equal(summary.complete, 1);
  assert.equal(summary.dropped, 2);
  assert.equal(summary.evicted, 4);
  assert.equal(summary.incomplete, 2);
  assert.equal(summary.state, 'incomplete');
  assert.equal(frameIntegritySummary([]).state, 'complete');
});

// ---------------------------------------------------------------------------
// Fake PNG fixture: structure, CRC, determinism
// ---------------------------------------------------------------------------

test('the fake PNG is a structurally valid 2x2 RGBA PNG with correct CRCs', () => {
  const png = createDeterministicPng({ width: 2, height: 2 });
  const info = inspectPng(png.bytes);
  assert.equal(info.validSignature, true);
  assert.equal(info.width, 2);
  assert.equal(info.height, 2);
  assert.equal(info.bitDepth, 8);
  assert.equal(info.colorType, 6);
  assert.equal(info.crcOk, true);
  assert.deepEqual(info.chunks.map((chunk) => chunk.type), ['IHDR', 'IDAT', 'IEND']);

  const raw = inflateSync(Buffer.concat(info.idat));
  assert.equal(raw.length, 2 * (1 + 2 * 4));
  assert.equal(raw[0], 0);
  assert.equal(raw[9], 0);
  assert.deepEqual([...raw.subarray(1, 9)], DEFAULT_PNG_PIXELS.slice(0, 8));
  assert.equal(png.sha256, sha256Hex(png.bytes));
});

test('the fake PNG is byte-identical across calls', () => {
  const first = createDeterministicPng();
  const second = createDeterministicPng();
  assert.ok(Buffer.from(first.bytes).equals(Buffer.from(second.bytes)));
  assert.equal(first.sha256, second.sha256);
  assert.deepEqual([...first.rgba], [...second.rgba]);
});

test('evidence envelope field list is exactly the documented nine keys', () => {
  assert.deepEqual([...P0_EVIDENCE_FIELDS], [
    'version', 'scope', 'session', 'target', 'generation', 'configRevision', 'operation', 'source', 'capturedAt',
  ]);
});
