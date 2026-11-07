/**
 * P0 neutral models (A–E), provider contract helpers and pure algorithms.
 *
 * This module is deliberately platform-free: it imports `node:` builtins plus
 * `core/geometry.js` / `core/errors.js` only. It must never import `index.js`,
 * a browser/CDP module, `targets/*` or any other platform implementation.
 *
 * Neutral model rules (docs/internal/cross-environment-foundation-m0.md §3):
 *  - A frame keeps `sourceTimestamp` (null is legal) and `receivedAt`; a missing
 *    source clock is never fabricated from `receivedAt`.
 *  - Network events never carry `cdpSessionId` in their public keys; platform
 *    references live in `transportRef`, and a public request key carries only
 *    the irreversible `transportId` scope derived from it.
 *  - Different generation / target / incompatible mapping are not comparable.
 *  - The evidence envelope carries scope/session/target/generation/
 *    configRevision/operation/source/capturedAt.
 *
 * Factories normalise (optional fields become `null`, never `undefined`) and do
 * not throw on missing required fields; `validate*` reports what is missing.
 */

import { createHash } from 'node:crypto';

import {
  COORDINATE_SPACES,
  assertCompatibleMapping,
  invertTransform,
  mapRect,
} from './geometry.js';
import { AdapterError } from './errors.js';

/** P0 families. Values are the family letters so `P0_FAMILIES.A === 'A'`. */
export const P0_FAMILIES = Object.freeze({ A: 'A', B: 'B', C: 'C', D: 'D', E: 'E' });

/** Provider method name that owns each family. */
export const P0_FAMILY_METHODS = Object.freeze({
  A: 'capture',
  B: 'network',
  C: 'display',
  D: 'canvas',
  E: 'targets',
});

/** Capability ids grouped by family (public capability discovery). */
export const P0_CAPABILITIES = Object.freeze({
  A: Object.freeze(['capture', 'frames', 'image']),
  B: Object.freeze(['network', 'events', 'body', 'control']),
  C: Object.freeze(['display', 'geometry']),
  D: Object.freeze(['canvas', 'annotation', 'preview']),
  E: Object.freeze(['targets', 'lease', 'lifecycle']),
});

/** Coordinate spaces. Same list as core/geometry.js COORDINATE_SPACES. */
export const DISPLAY_SPACES = COORDINATE_SPACES;

/** Support answers "does the engineering support this?" — never现场 availability. */
export const P0_SUPPORT = Object.freeze({
  SUPPORTED: 'supported',
  UNSUPPORTED: 'unsupported',
  PLANNED: 'planned',
});

/** Availability answers "is it usable right now?" — never support. */
export const P0_AVAILABILITY = Object.freeze({
  AVAILABLE: 'available',
  UNAVAILABLE: 'unavailable',
  NOT_PROBED: 'not-probed',
  BUSY: 'busy',
});

export const NETWORK_PHASES = Object.freeze([
  'request', 'response', 'redirect', 'failed', 'finished', 'open', 'message', 'close', 'error',
]);

export const NETWORK_KINDS = Object.freeze(['http', 'ws', 'sse', 'fetch']);

export const BODY_STATES = Object.freeze(['captured', 'empty', 'unavailable', 'omitted']);

export const TARGET_LIFECYCLES = Object.freeze(['available', 'bound', 'closed', 'stale', 'gone']);

/** Evidence envelope keys required on every P0 result (m0 §3 rule 4). */
export const P0_EVIDENCE_FIELDS = Object.freeze([
  'version', 'scope', 'session', 'target', 'generation', 'configRevision', 'operation', 'source', 'capturedAt',
]);

/** Legacy annotation export version (explicit on every old-format export). */
export const LEGACY_ANNOTATION_FORMAT_VERSION = 1;

const hasOwn = (object, key) => Object.prototype.hasOwnProperty.call(object, key);
const isObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const isFiniteNumber = (value) => typeof value === 'number' && Number.isFinite(value);
const isInteger = (value) => Number.isInteger(value);
const isText = (value) => typeof value === 'string' && value.length > 0;
const isHex64 = (value) => typeof value === 'string' && /^[0-9a-f]{64}$/.test(value);
const nullable = (value) => (value === undefined ? null : value);

function sha256Hex(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

function positiveCount(value) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? Math.round(number) : 0;
}

// ---------------------------------------------------------------------------
// Neutral model factories
// ---------------------------------------------------------------------------

/**
 * P0-A frame.
 * @param {object} input
 * @returns {object} neutral frame
 */
export function createFrame({
  frameId = null,
  sessionId = null,
  targetId = null,
  generation = null,
  sourceTimestamp = null,
  receivedAt = null,
  encoded = null,
  rgba = null,
  mapping = null,
  integrity = null,
  evidence = null,
} = {}) {
  return {
    family: P0_FAMILIES.A,
    frameId: nullable(frameId),
    sessionId: nullable(sessionId),
    targetId: nullable(targetId),
    generation: nullable(generation),
    sourceTimestamp: nullable(sourceTimestamp),
    receivedAt: nullable(receivedAt),
    encoded: nullable(encoded),
    rgba: nullable(rgba),
    mapping: nullable(mapping),
    integrity: nullable(integrity),
    evidence: nullable(evidence),
  };
}

/**
 * P0-B request key. `requestId` + `hopId` + (optional) `transportId`.
 *
 * `requestId` is only unique inside one transport (a CDP session), so a public
 * key that omits the transport scope collides across transports. `transportId`
 * is the irreversible, platform-neutral scope derived by
 * `transportIdFromRef()`; a raw platform id (`cdpSessionId`) must never appear
 * here. It is only emitted when supplied, so keys built without a transport
 * scope keep their historical shape.
 */
export function createRequestKey({ requestId = null, hopId = 0, transportId = null } = {}) {
  const key = { requestId: nullable(requestId), hopId: isInteger(hopId) ? hopId : 0 };
  if (isText(transportId)) key.transportId = transportId;
  return key;
}

/**
 * Compare two public request keys. Semantics: `transportId`, `requestId` and
 * `hopId` must all be equal (a missing transport scope compares as `null`, so
 * two legacy keys without one still match each other).
 *
 * @param {object} a
 * @param {object} b
 * @returns {boolean}
 */
export function samePublicRequestKey(a, b) {
  if (!isObject(a) || !isObject(b)) return false;
  const transportId = (key) => (isText(key.transportId) ? key.transportId : null);
  const requestId = (key) => nullable(key.requestId);
  const hopId = (key) => (isInteger(key.hopId) ? key.hopId : 0);
  return transportId(a) === transportId(b)
    && requestId(a) === requestId(b)
    && hopId(a) === hopId(b);
}

/**
 * P0-B neutral network event.
 */
export function createNetworkEvent({
  eventId = null,
  requestKey = null,
  sessionId = null,
  targetId = null,
  generation = null,
  phase = null,
  kind = null,
  method = null,
  url = null,
  status = null,
  sourceTimestamp = null,
  receivedAt = null,
  body = null,
  transportRef = null,
} = {}) {
  return {
    family: P0_FAMILIES.B,
    eventId: nullable(eventId),
    requestKey: nullable(requestKey),
    sessionId: nullable(sessionId),
    targetId: nullable(targetId),
    generation: nullable(generation),
    phase: nullable(phase),
    kind: nullable(kind),
    method: nullable(method),
    url: nullable(url),
    status: nullable(status),
    sourceTimestamp: nullable(sourceTimestamp),
    receivedAt: nullable(receivedAt),
    body: nullable(body),
    transportRef: nullable(transportRef),
  };
}

/**
 * P0-C display space.
 */
export function createDisplaySpace({
  space = null,
  geometryVersion = null,
  transform = null,
  observedAt = null,
  source = null,
} = {}) {
  return {
    family: P0_FAMILIES.C,
    space: nullable(space),
    geometryVersion: nullable(geometryVersion),
    transform: nullable(transform),
    observedAt: nullable(observedAt),
    source: nullable(source),
  };
}

/**
 * P0-D annotation document.
 */
export function createAnnotationDoc({
  docId = null,
  targetId = null,
  generation = null,
  geometryVersion = null,
  revision = null,
  shapes = null,
} = {}) {
  return {
    family: P0_FAMILIES.D,
    docId: nullable(docId),
    targetId: nullable(targetId),
    generation: nullable(generation),
    geometryVersion: nullable(geometryVersion),
    revision: nullable(revision),
    shapes: nullable(shapes),
  };
}

/**
 * P0-E target identity.
 */
export function createTargetIdentity({
  targetId = null,
  environment = null,
  kind = null,
  generation = null,
  label = null,
  lifecycle = null,
} = {}) {
  return {
    family: P0_FAMILIES.E,
    targetId: nullable(targetId),
    environment: nullable(environment),
    kind: nullable(kind),
    generation: nullable(generation),
    label: nullable(label),
    lifecycle: nullable(lifecycle),
  };
}

/**
 * P0-E lease.
 */
export function createLease({
  leaseId = null,
  targetId = null,
  generation = null,
  owner = null,
  expiresAt = null,
} = {}) {
  return {
    family: P0_FAMILIES.E,
    leaseId: nullable(leaseId),
    targetId: nullable(targetId),
    generation: nullable(generation),
    owner: nullable(owner),
    expiresAt: nullable(expiresAt),
  };
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

function result() {
  return { ok: true, missing: [], errors: [] };
}

function addError(acc, code, path, message) {
  acc.errors.push({ code, path, message });
}

function requireKeys(acc, object, keys, prefix = '') {
  for (const key of keys) {
    if (!hasOwn(object, key) || object[key] === undefined) {
      const path = prefix ? `${prefix}.${key}` : key;
      acc.missing.push(path);
      addError(acc, 'MISSING_FIELD', path, `${path} is required and must not be undefined`);
    }
  }
}

function checkText(acc, object, key, path) {
  if (hasOwn(object, key) && object[key] !== null && !isText(object[key])) {
    addError(acc, 'INVALID_VALUE', path, `${path} must be a non-empty string or null`);
  }
}

function validateMappingObject(acc, mapping, path) {
  if (!isObject(mapping)) {
    addError(acc, 'INVALID_TYPE', path, `${path} must be an object`);
    return;
  }
  for (const key of ['from', 'to']) {
    if (!hasOwn(mapping, key) || !DISPLAY_SPACES.includes(mapping[key])) {
      addError(acc, 'INVALID_SPACE', `${path}.${key}`, `${path}.${key} must be one of ${DISPLAY_SPACES.join('|')}`);
    }
  }
  for (const key of ['scaleX', 'scaleY']) {
    if (!isFiniteNumber(mapping[key]) || mapping[key] <= 0) {
      addError(acc, 'INVALID_SCALE', `${path}.${key}`, `${path}.${key} must be a positive finite number`);
    }
  }
  for (const key of ['offsetX', 'offsetY']) {
    if (!isFiniteNumber(mapping[key])) {
      addError(acc, 'INVALID_OFFSET', `${path}.${key}`, `${path}.${key} must be a finite number`);
    }
  }
  if (hasOwn(mapping, 'geometryVersion') && mapping.geometryVersion !== null && !isInteger(mapping.geometryVersion)) {
    addError(acc, 'INVALID_GEOMETRY_VERSION', `${path}.geometryVersion`, `${path}.geometryVersion must be an integer or null`);
  }
}

function validateIntegrity(acc, integrity, path) {
  if (!isObject(integrity)) {
    addError(acc, 'INVALID_TYPE', path, `${path} must be an object`);
    return;
  }
  if (!['complete', 'incomplete'].includes(integrity.state)) {
    addError(acc, 'INVALID_INTEGRITY_STATE', `${path}.state`, `${path}.state must be "complete" or "incomplete"`);
  }
  for (const key of ['dropped', 'evicted', 'incomplete']) {
    if (!hasOwn(integrity, key)) {
      addError(acc, 'MISSING_INTEGRITY_COUNTER', `${path}.${key}`, `${path}.${key} is required`);
    } else if (!isInteger(integrity[key]) || integrity[key] < 0) {
      addError(acc, 'INVALID_INTEGRITY_COUNTER', `${path}.${key}`, `${path}.${key} must be a non-negative integer`);
    }
  }
}

function validateEvidence(acc, evidence, path) {
  if (!isObject(evidence)) {
    addError(acc, 'INVALID_EVIDENCE', path, `${path} must be an object`);
    return;
  }
  for (const key of P0_EVIDENCE_FIELDS) {
    if (!hasOwn(evidence, key) || evidence[key] === undefined) {
      addError(acc, 'MISSING_EVIDENCE_FIELD', `${path}.${key}`, `${path}.${key} is required on the evidence envelope`);
    }
  }
  if (hasOwn(evidence, 'version') && evidence.version !== 1) {
    addError(acc, 'INVALID_EVIDENCE_VERSION', `${path}.version`, `${path}.version must be 1`);
  }
  if (hasOwn(evidence, 'capturedAt') && !isFiniteNumber(evidence.capturedAt)) {
    addError(acc, 'INVALID_EVIDENCE_TIME', `${path}.capturedAt`, `${path}.capturedAt must be a finite epoch-millisecond number`);
  }
  if (hasOwn(evidence, 'generation') && !isInteger(evidence.generation)) {
    addError(acc, 'INVALID_EVIDENCE_GENERATION', `${path}.generation`, `${path}.generation must be an integer`);
  }
  if (hasOwn(evidence, 'configRevision') && !isInteger(evidence.configRevision)) {
    addError(acc, 'INVALID_EVIDENCE_CONFIG_REVISION', `${path}.configRevision`, `${path}.configRevision must be an integer`);
  }
  for (const key of ['scope', 'session', 'target']) {
    if (hasOwn(evidence, key) && evidence[key] !== null && typeof evidence[key] !== 'string') {
      addError(acc, 'INVALID_EVIDENCE_IDENTITY', `${path}.${key}`, `${path}.${key} must be a string or null`);
    }
  }
}

function finish(acc) {
  acc.ok = acc.missing.length === 0 && acc.errors.length === 0;
  return acc;
}

/**
 * @returns {{ok:boolean, missing:string[], errors:{code:string,path:string,message:string}[]}}
 */
export function validateFrame(frame) {
  const acc = result();
  if (!isObject(frame)) {
    addError(acc, 'INVALID_TYPE', 'frame', 'frame must be an object');
    acc.missing.push('frame');
    return finish(acc);
  }
  requireKeys(acc, frame, ['frameId', 'sessionId', 'targetId', 'generation', 'sourceTimestamp', 'receivedAt', 'encoded', 'rgba', 'mapping', 'integrity', 'evidence']);
  for (const key of ['frameId', 'sessionId', 'targetId']) checkText(acc, frame, key, key);
  if (hasOwn(frame, 'generation') && (!isInteger(frame.generation) || frame.generation < 1)) {
    addError(acc, 'INVALID_GENERATION', 'generation', 'generation must be an integer >= 1');
  }
  if (hasOwn(frame, 'sourceTimestamp') && frame.sourceTimestamp !== null && !isFiniteNumber(frame.sourceTimestamp)) {
    addError(acc, 'INVALID_SOURCE_TIMESTAMP', 'sourceTimestamp', 'sourceTimestamp must be null or a finite epoch-millisecond number');
  }
  if (hasOwn(frame, 'receivedAt') && !isFiniteNumber(frame.receivedAt)) {
    addError(acc, 'INVALID_RECEIVED_AT', 'receivedAt', 'receivedAt must be a finite epoch-millisecond number');
  }
  if (hasOwn(frame, 'encoded')) {
    const encoded = frame.encoded;
    if (!isObject(encoded)) {
      addError(acc, 'INVALID_TYPE', 'encoded', 'encoded must be an object');
    } else {
      requireKeys(acc, encoded, ['format', 'bytes', 'sha256'], 'encoded');
      if (hasOwn(encoded, 'format') && !isText(encoded.format)) addError(acc, 'INVALID_ENCODING_FORMAT', 'encoded.format', 'encoded.format must be a non-empty string');
      if (hasOwn(encoded, 'bytes') && !(encoded.bytes instanceof Uint8Array)) addError(acc, 'INVALID_ENCODING_BYTES', 'encoded.bytes', 'encoded.bytes must be a Uint8Array/Buffer');
      if (hasOwn(encoded, 'sha256') && !isHex64(encoded.sha256)) addError(acc, 'INVALID_ENCODING_SHA256', 'encoded.sha256', 'encoded.sha256 must be a lowercase 64-char hex digest');
      if (isObject(encoded) && hasOwn(encoded, 'byteLength') && encoded.bytes instanceof Uint8Array && encoded.byteLength !== encoded.bytes.length) {
        addError(acc, 'INCONSISTENT_ENCODING_LENGTH', 'encoded.byteLength', 'encoded.byteLength must equal encoded.bytes.length');
      }
    }
  }
  if (hasOwn(frame, 'rgba')) {
    const rgba = frame.rgba;
    if (!isObject(rgba)) {
      addError(acc, 'INVALID_TYPE', 'rgba', 'rgba must be an object');
    } else {
      requireKeys(acc, rgba, ['width', 'height', 'sha256'], 'rgba');
      for (const key of ['width', 'height']) {
        if (!isInteger(rgba[key]) || rgba[key] < 1) addError(acc, 'INVALID_RGBA_DIMENSION', `rgba.${key}`, `rgba.${key} must be an integer >= 1`);
      }
      if (rgba.sha256 !== null && rgba.sha256 !== undefined && !isHex64(rgba.sha256)) addError(acc, 'INVALID_RGBA_SHA256', 'rgba.sha256', 'rgba.sha256 must be null or a lowercase 64-char hex digest');
    }
  }
  if (hasOwn(frame, 'mapping')) validateMappingObject(acc, frame.mapping, 'mapping');
  if (hasOwn(frame, 'integrity')) validateIntegrity(acc, frame.integrity, 'integrity');
  if (hasOwn(frame, 'evidence')) validateEvidence(acc, frame.evidence, 'evidence');
  return finish(acc);
}

/**
 * @returns {{ok:boolean, missing:string[], errors:{code:string,path:string,message:string}[]}}
 */
export function validateNetworkEvent(event) {
  const acc = result();
  if (!isObject(event)) {
    addError(acc, 'INVALID_TYPE', 'event', 'event must be an object');
    acc.missing.push('event');
    return finish(acc);
  }
  requireKeys(acc, event, ['eventId', 'requestKey', 'sessionId', 'targetId', 'generation', 'phase', 'kind', 'method', 'url', 'status', 'sourceTimestamp', 'receivedAt', 'body', 'transportRef']);

  // Platform identity must never leak into public keys (m0 §3 rule 2).
  if (hasOwn(event, 'cdpSessionId')) {
    addError(acc, 'PLATFORM_IDENTITY_LEAK', 'cdpSessionId', 'cdpSessionId must not appear on a neutral network event; move it into transportRef');
  }
  if (isObject(event.requestKey) && hasOwn(event.requestKey, 'cdpSessionId')) {
    addError(acc, 'PLATFORM_IDENTITY_LEAK', 'requestKey.cdpSessionId', 'cdpSessionId must not appear on a neutral request key; move it into transportRef');
  }

  for (const key of ['eventId', 'sessionId', 'targetId', 'url']) checkText(acc, event, key, key);
  if (hasOwn(event, 'generation') && (!isInteger(event.generation) || event.generation < 1)) {
    addError(acc, 'INVALID_GENERATION', 'generation', 'generation must be an integer >= 1');
  }
  if (hasOwn(event, 'sourceTimestamp') && event.sourceTimestamp !== null && !isFiniteNumber(event.sourceTimestamp)) {
    addError(acc, 'INVALID_SOURCE_TIMESTAMP', 'sourceTimestamp', 'sourceTimestamp must be null or a finite epoch-millisecond number');
  }
  if (hasOwn(event, 'receivedAt') && !isFiniteNumber(event.receivedAt)) {
    addError(acc, 'INVALID_RECEIVED_AT', 'receivedAt', 'receivedAt must be a finite epoch-millisecond number');
  }
  if (hasOwn(event, 'phase') && !NETWORK_PHASES.includes(event.phase)) {
    addError(acc, 'INVALID_PHASE', 'phase', `phase must be one of ${NETWORK_PHASES.join('|')}`);
  }
  if (hasOwn(event, 'kind') && !NETWORK_KINDS.includes(event.kind)) {
    addError(acc, 'INVALID_KIND', 'kind', `kind must be one of ${NETWORK_KINDS.join('|')}`);
  }
  if (hasOwn(event, 'method') && event.method !== null && !isText(event.method)) {
    addError(acc, 'INVALID_METHOD', 'method', 'method must be a non-empty string or null');
  }
  if (hasOwn(event, 'status') && event.status !== null && (!isInteger(event.status) || event.status < 0 || event.status > 999)) {
    addError(acc, 'INVALID_STATUS', 'status', 'status must be null or an integer between 0 and 999');
  }
  if (hasOwn(event, 'requestKey')) {
    const requestKey = event.requestKey;
    if (!isObject(requestKey)) {
      addError(acc, 'INVALID_TYPE', 'requestKey', 'requestKey must be an object');
    } else {
      requireKeys(acc, requestKey, ['requestId', 'hopId'], 'requestKey');
      if (hasOwn(requestKey, 'requestId') && !isText(requestKey.requestId)) addError(acc, 'INVALID_REQUEST_ID', 'requestKey.requestId', 'requestKey.requestId must be a non-empty string');
      if (hasOwn(requestKey, 'hopId') && (!isInteger(requestKey.hopId) || requestKey.hopId < 0)) addError(acc, 'INVALID_HOP_ID', 'requestKey.hopId', 'requestKey.hopId must be an integer >= 0');
      // `transportId` is optional so keys built before the transport scope
      // existed still validate, but a present-and-malformed value (null, '',
      // non-string) is an error rather than silently accepted.
      if (hasOwn(requestKey, 'transportId') && !isText(requestKey.transportId)) {
        addError(acc, 'INVALID_TYPE', 'requestKey.transportId', 'requestKey.transportId must be a non-empty string when present');
      }
    }
  }
  if (hasOwn(event, 'body')) {
    const body = event.body;
    if (!isObject(body)) {
      addError(acc, 'INVALID_TYPE', 'body', 'body must be an object');
    } else {
      if (!BODY_STATES.includes(body.state)) addError(acc, 'INVALID_BODY_STATE', 'body.state', `body.state must be one of ${BODY_STATES.join('|')}`);
      if (body.state === 'captured' && hasOwn(body, 'data') && typeof body.data !== 'string') addError(acc, 'INVALID_BODY_DATA', 'body.data', 'body.data must be a string when present');
    }
  }
  if (hasOwn(event, 'transportRef')) {
    const transportRef = event.transportRef;
    if (!isObject(transportRef)) {
      addError(acc, 'INVALID_TYPE', 'transportRef', 'transportRef must be an object');
    } else if (!isText(transportRef.kind)) {
      addError(acc, 'INVALID_TRANSPORT_KIND', 'transportRef.kind', 'transportRef.kind must be a non-empty string');
    }
  }
  return finish(acc);
}

/**
 * @returns {{ok:boolean, missing:string[], errors:{code:string,path:string,message:string}[]}}
 */
export function validateDisplaySpace(display) {
  const acc = result();
  if (!isObject(display)) {
    addError(acc, 'INVALID_TYPE', 'display', 'display must be an object');
    acc.missing.push('display');
    return finish(acc);
  }
  requireKeys(acc, display, ['space', 'geometryVersion', 'transform', 'observedAt', 'source']);
  if (hasOwn(display, 'space') && !DISPLAY_SPACES.includes(display.space)) {
    addError(acc, 'INVALID_SPACE', 'space', `space must be one of ${DISPLAY_SPACES.join('|')}`);
  }
  if (hasOwn(display, 'geometryVersion') && (!isInteger(display.geometryVersion) || display.geometryVersion < 0)) {
    addError(acc, 'INVALID_GEOMETRY_VERSION', 'geometryVersion', 'geometryVersion must be an integer >= 0');
  }
  if (hasOwn(display, 'observedAt') && !isFiniteNumber(display.observedAt)) {
    addError(acc, 'INVALID_OBSERVED_AT', 'observedAt', 'observedAt must be a finite epoch-millisecond number');
  }
  if (hasOwn(display, 'source') && !isText(display.source)) {
    addError(acc, 'INVALID_SOURCE', 'source', 'source must be a non-empty string');
  }
  if (hasOwn(display, 'transform')) {
    validateMappingObject(acc, display.transform, 'transform');
    if (isObject(display.transform) && hasOwn(display.transform, 'from') && hasOwn(display, 'space') && display.transform.from !== display.space) {
      addError(acc, 'INVALID_TRANSFORM_ORIGIN', 'transform.from', 'transform.from must equal display.space');
    }
  }
  return finish(acc);
}

/**
 * @returns {{ok:boolean, missing:string[], errors:{code:string,path:string,message:string}[]}}
 */
export function validateAnnotationDoc(doc) {
  const acc = result();
  if (!isObject(doc)) {
    addError(acc, 'INVALID_TYPE', 'doc', 'annotation doc must be an object');
    acc.missing.push('doc');
    return finish(acc);
  }
  requireKeys(acc, doc, ['docId', 'targetId', 'generation', 'geometryVersion', 'revision', 'shapes']);
  for (const key of ['docId', 'targetId']) checkText(acc, doc, key, key);
  if (hasOwn(doc, 'generation') && (!isInteger(doc.generation) || doc.generation < 1)) {
    addError(acc, 'INVALID_GENERATION', 'generation', 'generation must be an integer >= 1');
  }
  if (hasOwn(doc, 'geometryVersion') && (!isInteger(doc.geometryVersion) || doc.geometryVersion < 0)) {
    addError(acc, 'INVALID_GEOMETRY_VERSION', 'geometryVersion', 'geometryVersion must be an integer >= 0');
  }
  if (hasOwn(doc, 'revision') && (!isInteger(doc.revision) || doc.revision < 0)) {
    addError(acc, 'INVALID_REVISION', 'revision', 'revision must be an integer >= 0');
  }
  if (hasOwn(doc, 'shapes')) {
    if (!Array.isArray(doc.shapes)) {
      addError(acc, 'INVALID_TYPE', 'shapes', 'shapes must be an array');
    } else {
      const seen = new Set();
      doc.shapes.forEach((shape, index) => {
        const path = `shapes[${index}]`;
        if (!isObject(shape)) {
          addError(acc, 'INVALID_SHAPE', path, 'each shape must be an object');
          return;
        }
        if (!isText(shape.shapeId)) addError(acc, 'INVALID_SHAPE_ID', `${path}.shapeId`, 'shape.shapeId must be a non-empty string');
        if (!isText(shape.kind)) addError(acc, 'INVALID_SHAPE_KIND', `${path}.kind`, 'shape.kind must be a non-empty string');
        if (isText(shape.shapeId)) {
          if (seen.has(shape.shapeId)) addError(acc, 'DUPLICATE_SHAPE_ID', `${path}.shapeId`, `duplicate shape id "${shape.shapeId}"`);
          seen.add(shape.shapeId);
        }
      });
    }
  }
  return finish(acc);
}

/**
 * @returns {{ok:boolean, missing:string[], errors:{code:string,path:string,message:string}[]}}
 */
export function validateTargetIdentity(identity) {
  const acc = result();
  if (!isObject(identity)) {
    addError(acc, 'INVALID_TYPE', 'target', 'target identity must be an object');
    acc.missing.push('target');
    return finish(acc);
  }
  requireKeys(acc, identity, ['targetId', 'environment', 'kind', 'generation', 'label', 'lifecycle']);
  for (const key of ['targetId', 'environment', 'kind', 'label']) checkText(acc, identity, key, key);
  if (hasOwn(identity, 'generation') && (!isInteger(identity.generation) || identity.generation < 1)) {
    addError(acc, 'INVALID_GENERATION', 'generation', 'generation must be an integer >= 1');
  }
  if (hasOwn(identity, 'lifecycle') && !TARGET_LIFECYCLES.includes(identity.lifecycle)) {
    addError(acc, 'INVALID_LIFECYCLE', 'lifecycle', `lifecycle must be one of ${TARGET_LIFECYCLES.join('|')}`);
  }
  return finish(acc);
}

/**
 * @returns {{ok:boolean, missing:string[], errors:{code:string,path:string,message:string}[]}}
 */
export function validateLease(lease) {
  const acc = result();
  if (!isObject(lease)) {
    addError(acc, 'INVALID_TYPE', 'lease', 'lease must be an object');
    acc.missing.push('lease');
    return finish(acc);
  }
  requireKeys(acc, lease, ['leaseId', 'targetId', 'generation', 'owner', 'expiresAt']);
  for (const key of ['leaseId', 'targetId']) checkText(acc, lease, key, key);
  if (hasOwn(lease, 'generation') && (!isInteger(lease.generation) || lease.generation < 1)) {
    addError(acc, 'INVALID_GENERATION', 'generation', 'generation must be an integer >= 1');
  }
  if (hasOwn(lease, 'expiresAt') && !isFiniteNumber(lease.expiresAt)) {
    addError(acc, 'INVALID_EXPIRES_AT', 'expiresAt', 'expiresAt must be a finite epoch-millisecond number');
  }
  if (hasOwn(lease, 'owner')) {
    const owner = lease.owner;
    const valid = isText(owner) || (isObject(owner) && isText(owner.id));
    if (!valid) addError(acc, 'INVALID_OWNER', 'owner', 'owner must be a non-empty string or an object with a non-empty id');
  }
  return finish(acc);
}

// ---------------------------------------------------------------------------
// Web -> neutral converters
// ---------------------------------------------------------------------------

function pickSourceTimestamp(event) {
  // An explicit sourceTimestamp (including null) is authoritative: a missing
  // source clock is never replaced by receivedAt.
  if (hasOwn(event, 'sourceTimestamp')) return nullable(event.sourceTimestamp);
  const ts = event.ts;
  if (isObject(ts)) {
    if (isFiniteNumber(ts.wallMs)) return ts.wallMs;
    if (isFiniteNumber(ts.cdpSeconds)) return Math.round(ts.cdpSeconds * 1000);
  }
  return null;
}

/**
 * Derive an irreversible, platform-neutral transport scope id from a
 * transportRef (`kind|cdpSessionId|targetId|frameId|loaderId`, sha256, first 16
 * hex chars). The raw ids never enter a public key, so `PLATFORM_IDENTITY_LEAK`
 * keeps holding; the digest only makes identical request ids comparable per
 * transport. A reference without any transport identity field (e.g. a purely
 * local source) falls back to a stable `<kind>:local` value.
 *
 * @param {object} transportRef
 * @returns {string}
 */
export function transportIdFromRef(transportRef = {}) {
  const ref = isObject(transportRef) ? transportRef : {};
  const kind = isText(ref.kind) ? ref.kind : null;
  const parts = ['cdpSessionId', 'targetId', 'frameId', 'loaderId']
    .map((key) => (isText(ref[key]) ? ref[key] : ''));
  if (parts.every((part) => part === '')) return `${kind ?? 'neutral'}:local`;
  return createHash('sha256')
    .update([kind ?? 'unknown', ...parts].join('|'))
    .digest('hex')
    .slice(0, 16);
}

/**
 * Convert a Web/CDP-shaped network event (network-p0.js) to the neutral model.
 * `cdpSessionId` moves to `transportRef`; it never survives as a public key.
 * `requestKey.transportId` carries the irreversible transport scope, so equal
 * `requestId`s from different transports get different public keys.
 *
 * @param {object} webEvent
 * @returns {object} neutral network event
 */
export function toNeutralNetworkEvent(webEvent = {}) {
  if (!isObject(webEvent)) {
    throw new AdapterError('INVALID_ARGUMENT', 'toNeutralNetworkEvent requires a web event object', { reason: 'event-not-object' });
  }
  const requestKeyInput = isObject(webEvent.requestKey) ? webEvent.requestKey : null;
  const requestId = requestKeyInput ? nullable(requestKeyInput.requestId) : nullable(webEvent.requestId);
  const hopId = requestKeyInput && isInteger(requestKeyInput.hopId)
    ? requestKeyInput.hopId
    : (isInteger(webEvent.hopId) ? webEvent.hopId : 0);
  const transportRef = {
    kind: 'web',
    cdpSessionId: nullable(webEvent.cdpSessionId),
    targetId: nullable(webEvent.targetId),
    frameId: nullable(webEvent.frameId),
    loaderId: nullable(webEvent.loaderId),
    seq: nullable(webEvent.seq),
  };
  const transportId = transportIdFromRef(transportRef);
  const eventId = isText(webEvent.eventId)
    ? webEvent.eventId
    : `web:${transportId}:${nullable(webEvent.sessionId) ?? 'session'}:${nullable(webEvent.seq) ?? requestId ?? 0}:${nullable(webEvent.phase) ?? 'request'}:${hopId}`;
  const receivedAt = isFiniteNumber(webEvent.receivedAt)
    ? webEvent.receivedAt
    : (isObject(webEvent.ts) && isFiniteNumber(webEvent.ts.wallMs) ? webEvent.ts.wallMs : null);

  return createNetworkEvent({
    eventId,
    requestKey: createRequestKey({ requestId, hopId, transportId }),
    sessionId: nullable(webEvent.sessionId),
    targetId: nullable(webEvent.targetId),
    generation: nullable(webEvent.generation),
    phase: nullable(webEvent.phase) ?? 'request',
    kind: nullable(webEvent.kind) ?? 'http',
    method: nullable(webEvent.method),
    url: nullable(webEvent.url) ?? '',
    status: nullable(webEvent.status),
    sourceTimestamp: pickSourceTimestamp(webEvent),
    receivedAt,
    body: nullable(webEvent.body) ?? { state: 'unavailable', reasonCode: 'not-captured' },
    transportRef,
  });
}

/**
 * Convert a Web FrameSource frame (base64 encoded JPEG/PNG + page geometry) to
 * the neutral model. `capturedAt` is the source clock; `receivedAt` is kept
 * separate and never substituted for it.
 *
 * `mapping` declares `from: 'document-css-px' -> to: 'image-px'`, so it scales
 * by `imageSize / pageSize` and shifts by `-scroll * scale`.
 *
 * @param {object} webFrame
 * @returns {object} neutral frame
 */
export function toNeutralFrame(webFrame = {}) {
  if (!isObject(webFrame)) {
    throw new AdapterError('INVALID_ARGUMENT', 'toNeutralFrame requires a web frame object', { reason: 'frame-not-object' });
  }
  const raw = hasOwn(webFrame, 'data') ? webFrame.data : (isObject(webFrame.encoded) ? webFrame.encoded.base64 : null);
  let bytes;
  if (typeof raw === 'string') {
    bytes = Buffer.from(raw, 'base64');
  } else if (raw instanceof Uint8Array) {
    bytes = raw;
  } else if (isObject(webFrame.encoded) && webFrame.encoded.bytes instanceof Uint8Array) {
    bytes = webFrame.encoded.bytes;
  } else {
    bytes = new Uint8Array(0);
  }
  const format = isText(webFrame.format)
    ? webFrame.format
    : (isObject(webFrame.encoded) && isText(webFrame.encoded.format) ? webFrame.encoded.format : 'jpeg');
  const width = positiveCount(webFrame.width);
  const height = positiveCount(webFrame.height);
  const pageWidth = positiveCount(webFrame.pageWidth) || width;
  const pageHeight = positiveCount(webFrame.pageHeight) || height;
  // The mapping is declared `document-css-px -> image-px`, so the scale is
  // imageSize / pageSize: image_px = (document_css_px - scroll) * scale.
  // A missing page size falls back to the image size above, which yields 1.
  const scaleX = pageWidth > 0 ? width / pageWidth : 1;
  const scaleY = pageHeight > 0 ? height / pageHeight : 1;
  const scrollX = isFiniteNumber(webFrame.scrollX) ? webFrame.scrollX : 0;
  const scrollY = isFiniteNumber(webFrame.scrollY) ? webFrame.scrollY : 0;
  const geometryVersion = isInteger(webFrame.geometryVersion) ? webFrame.geometryVersion : 1;
  const sessionId = nullable(webFrame.sessionId);
  const targetId = nullable(webFrame.targetId);
  const generation = nullable(webFrame.generation);
  const receivedAt = isFiniteNumber(webFrame.receivedAt) ? webFrame.receivedAt : null;
  const sourceTimestamp = hasOwn(webFrame, 'capturedAt') ? nullable(webFrame.capturedAt) : null;

  return createFrame({
    frameId: isText(webFrame.frameId)
      ? webFrame.frameId
      : `${sessionId ?? 'session'}:${targetId ?? 'target'}:${nullable(webFrame.seq) ?? 0}`,
    sessionId,
    targetId,
    generation,
    sourceTimestamp,
    receivedAt,
    encoded: { format, bytes, sha256: sha256Hex(bytes), byteLength: bytes.length },
    rgba: { width: width || 0, height: height || 0, sha256: null },
    mapping: {
      from: 'document-css-px',
      to: 'image-px',
      scaleX,
      scaleY,
      // `-0` is normalised to `0`: it is the same point on the page, and a
      // signed zero would make otherwise identical mappings compare unequal.
      offsetX: scrollX === 0 ? 0 : -scrollX * scaleX,
      offsetY: scrollY === 0 ? 0 : -scrollY * scaleY,
      geometryVersion,
    },
    integrity: { state: 'complete', dropped: 0, evicted: 0, incomplete: 0, reason: null },
    evidence: {
      version: 1,
      scope: nullable(webFrame.scope),
      session: sessionId,
      target: targetId,
      generation,
      configRevision: isInteger(webFrame.configRevision) ? webFrame.configRevision : 0,
      operation: 'p0.frame.capture',
      source: isText(webFrame.source) ? webFrame.source : 'web.frame-source',
      capturedAt: receivedAt ?? 0,
    },
  });
}

/**
 * Export a neutral annotation document in the legacy format. The legacy export
 * always carries an explicit `formatVersion`.
 */
export function fromNeutralAnnotation(doc = {}) {
  const check = validateAnnotationDoc(doc);
  if (!check.ok) {
    throw new AdapterError('INVALID_ARGUMENT', 'annotation doc is not a valid neutral document', {
      missing: check.missing,
      errors: check.errors,
    });
  }
  return {
    formatVersion: LEGACY_ANNOTATION_FORMAT_VERSION,
    kind: 'annotation-doc',
    docId: doc.docId,
    targetId: doc.targetId,
    generation: doc.generation,
    geometryVersion: doc.geometryVersion,
    revision: doc.revision,
    shapes: doc.shapes.map((shape) => ({ ...shape })),
  };
}

/**
 * Import a legacy annotation document. A legacy document without an explicit
 * `formatVersion` is rejected rather than silently guessed.
 */
export function toNeutralAnnotation(legacy = {}) {
  if (!isObject(legacy) || legacy.formatVersion !== LEGACY_ANNOTATION_FORMAT_VERSION) {
    throw new AdapterError('CONFIG_INVALID', 'legacy annotation document must carry formatVersion 1', {
      reason: 'format-version-missing',
      formatVersion: isObject(legacy) ? nullable(legacy.formatVersion) : null,
    });
  }
  return createAnnotationDoc({
    docId: legacy.docId,
    targetId: legacy.targetId,
    generation: legacy.generation,
    geometryVersion: legacy.geometryVersion,
    revision: legacy.revision,
    shapes: Array.isArray(legacy.shapes) ? legacy.shapes.map((shape) => ({ ...shape })) : null,
  });
}

// ---------------------------------------------------------------------------
// P0 provider interface helpers
// ---------------------------------------------------------------------------

/**
 * Assert the minimum P0 provider contract: `manifest.class === 'p0'`, at least
 * one valid family, and — if present — each of the five family methods is an
 * object. All five family methods are optional; a missing method is reported as
 * `unsupported` by providerCapabilities, never faked.
 */
export function assertProvider(provider) {
  if (!isObject(provider)) {
    throw new AdapterError('INVALID_ARGUMENT', 'p0 provider must be an object', { reason: 'provider-not-object' });
  }
  const manifest = provider.manifest;
  if (!isObject(manifest)) {
    throw new AdapterError('CAPABILITY_UNSUPPORTED', 'p0 provider must expose a manifest', { reason: 'manifest-missing' });
  }
  if (manifest.class !== 'p0') {
    throw new AdapterError('CAPABILITY_UNSUPPORTED', 'p0 provider manifest.class must be "p0"', {
      reason: 'manifest-class',
      actual: nullable(manifest.class),
    });
  }
  const declared = Array.isArray(manifest.families) ? manifest.families : [manifest.family];
  const families = declared.filter((family) => family !== undefined && family !== null);
  if (families.length === 0) {
    throw new AdapterError('CAPABILITY_UNSUPPORTED', 'p0 provider must declare at least one family', { reason: 'family-missing' });
  }
  for (const family of families) {
    if (!hasOwn(P0_FAMILIES, family)) {
      throw new AdapterError('CAPABILITY_UNSUPPORTED', `unknown p0 family "${family}"`, { reason: 'family-invalid', family });
    }
  }
  for (const method of Object.values(P0_FAMILY_METHODS)) {
    const value = provider[method];
    if (value !== undefined && value !== null && !isObject(value)) {
      throw new AdapterError('CAPABILITY_UNSUPPORTED', `p0 provider method "${method}" must be an object when present`, {
        reason: 'method-invalid',
        method,
      });
    }
  }
  return provider;
}

/**
 * Per-family capability discovery.
 *
 * `support` answers engineering support (missing method -> unsupported);
 * `availability` answers the current session (no session or unbound target ->
 * not-probed). The two are never merged into one boolean.
 *
 * @returns {Record<string, {family:string, capabilities:string[], support:string, availability:string, reason:string|null}>}
 */
export function providerCapabilities(provider, { session = null, snapshot = null } = {}) {
  assertProvider(provider);
  const manifest = provider.manifest;
  const declared = new Set(Array.isArray(manifest.families) ? manifest.families : [manifest.family]);
  let reported = {};
  // `familyStatus` is the P0 provider's family-level status method. It is
  // deliberately not called `capabilities` so it cannot be confused with the
  // six-axis `capability` readiness axis.
  if (typeof provider.familyStatus === 'function') {
    const value = provider.familyStatus({ session, snapshot });
    if (isObject(value)) reported = value;
  }
  const hasSession = Boolean(session && isText(session.sessionId));
  const hasTarget = Boolean(hasSession && isObject(session.target));
  const out = {};
  for (const family of Object.keys(P0_FAMILIES)) {
    const method = P0_FAMILY_METHODS[family];
    const capabilities = [...P0_CAPABILITIES[family]];
    const base = { family, capabilities };
    if (!declared.has(family)) {
      out[method] = { ...base, support: P0_SUPPORT.UNSUPPORTED, availability: P0_AVAILABILITY.UNAVAILABLE, reason: 'family-not-declared' };
      continue;
    }
    const handler = provider[method];
    if (handler === undefined || handler === null) {
      out[method] = { ...base, support: P0_SUPPORT.UNSUPPORTED, availability: P0_AVAILABILITY.UNAVAILABLE, reason: 'method-missing' };
      continue;
    }
    if (!isObject(handler)) {
      out[method] = { ...base, support: P0_SUPPORT.UNSUPPORTED, availability: P0_AVAILABILITY.UNAVAILABLE, reason: 'method-invalid' };
      continue;
    }
    const entry = isObject(reported[method]) ? reported[method] : (isObject(reported[family]) ? reported[family] : null);
    const support = entry && entry.support === P0_SUPPORT.PLANNED ? P0_SUPPORT.PLANNED : P0_SUPPORT.SUPPORTED;
    if (!hasSession) {
      out[method] = { ...base, support, availability: P0_AVAILABILITY.NOT_PROBED, reason: 'session-unbound' };
    } else if (!hasTarget) {
      out[method] = { ...base, support, availability: P0_AVAILABILITY.NOT_PROBED, reason: 'target-unbound' };
    } else if (entry && typeof entry.availability === 'string') {
      out[method] = { ...base, support, availability: entry.availability, reason: nullable(entry.reason) };
    } else {
      out[method] = { ...base, support, availability: P0_AVAILABILITY.AVAILABLE, reason: null };
    }
  }
  return out;
}

const DISPOSED_PROVIDERS = new WeakSet();

/**
 * Dispose a P0 provider once. Safe to call repeatedly; a provider without a
 * `dispose` method is reported rather than treated as an error.
 */
export async function disposeProvider(provider) {
  if (!isObject(provider) || typeof provider.dispose !== 'function') {
    return { disposed: false, reason: 'no-dispose' };
  }
  if (DISPOSED_PROVIDERS.has(provider)) return { disposed: true, alreadyDisposed: true };
  await provider.dispose();
  DISPOSED_PROVIDERS.add(provider);
  return { disposed: true, alreadyDisposed: false };
}

// ---------------------------------------------------------------------------
// Pure algorithms
// ---------------------------------------------------------------------------

/**
 * Place a frame's image pixels into a display space.
 *
 * `display.space` is the space the display is expressed in and
 * `display.transform` maps `display.space -> image-px`; the frame's `mapping`
 * must agree with it. An incompatible mapping (space, generation/geometry
 * version, target) is rejected instead of silently compared.
 *
 * @param {object} frame neutral frame (validated)
 * @param {object} display neutral DisplaySpace (validated)
 */
export function mapFrameToDisplay(frame, display) {
  const frameCheck = validateFrame(frame);
  if (!frameCheck.ok) {
    throw new AdapterError('INVALID_ARGUMENT', 'frame is not a valid neutral frame', {
      missing: frameCheck.missing,
      errors: frameCheck.errors,
    });
  }
  const displayCheck = validateDisplaySpace(display);
  if (!displayCheck.ok) {
    throw new AdapterError('INVALID_ARGUMENT', 'display is not a valid neutral display space', {
      missing: displayCheck.missing,
      errors: displayCheck.errors,
    });
  }
  if (frame.mapping.from !== display.space) {
    throw new AdapterError('GENERATION_MISMATCH', 'frame mapping origin does not match the display space', {
      reason: 'space-mismatch',
      frameSpace: frame.mapping.from,
      displaySpace: display.space,
    });
  }
  try {
    assertCompatibleMapping(frame.mapping, display.transform);
  } catch (error) {
    throw new AdapterError('GENERATION_MISMATCH', 'frame mapping is not compatible with the display transform', {
      reason: 'mapping-incompatible',
      frameMapping: frame.mapping,
      displayTransform: display.transform,
      cause: error,
    });
  }
  if (hasOwn(frame.mapping, 'geometryVersion') && frame.mapping.geometryVersion !== null
    && frame.mapping.geometryVersion !== display.geometryVersion) {
    throw new AdapterError('GENERATION_MISMATCH', 'frame mapping geometryVersion does not match the display', {
      reason: 'geometry-version-mismatch',
      frameGeometryVersion: frame.mapping.geometryVersion,
      displayGeometryVersion: display.geometryVersion,
    });
  }
  const toDisplay = invertTransform(display.transform);
  const bounds = mapRect(toDisplay, { x: 0, y: 0, width: frame.rgba.width, height: frame.rgba.height });
  return {
    frameId: frame.frameId,
    targetId: frame.targetId,
    generation: frame.generation,
    space: display.space,
    geometryVersion: display.geometryVersion,
    transform: toDisplay,
    image: { width: frame.rgba.width, height: frame.rgba.height },
    bounds,
    evidence: {
      ...frame.evidence,
      operation: 'p0.map.frame-to-display',
      source: 'core/p0.mapFrameToDisplay',
    },
  };
}

/**
 * Count dropped / evicted / incomplete frames across a frame list.
 * @param {object[]} frames
 */
export function frameIntegritySummary(frames = []) {
  const list = Array.isArray(frames) ? frames : [];
  const summary = {
    total: list.length,
    complete: 0,
    dropped: 0,
    evicted: 0,
    incomplete: 0,
    state: 'complete',
  };
  for (const frame of list) {
    const integrity = isObject(frame) && isObject(frame.integrity) ? frame.integrity : null;
    if (!integrity) {
      summary.incomplete += 1;
      continue;
    }
    const dropped = isInteger(integrity.dropped) ? integrity.dropped : 0;
    const evicted = isInteger(integrity.evicted) ? integrity.evicted : 0;
    const incomplete = isInteger(integrity.incomplete) ? integrity.incomplete : 0;
    summary.dropped += dropped;
    summary.evicted += evicted;
    summary.incomplete += incomplete;
    if (integrity.state === 'complete' && dropped === 0 && evicted === 0 && incomplete === 0) summary.complete += 1;
  }
  summary.state = summary.dropped === 0 && summary.evicted === 0 && summary.incomplete === 0 ? 'complete' : 'incomplete';
  return summary;
}
