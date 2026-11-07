/**
 * Coordinate-space transforms (P0-C, M0 §3 family C).
 *
 * Pure affine 2D transforms between explicit coordinate spaces. Spaces are never assumed to be
 * interchangeable: a mapping carries `from`, `to` and `geometryVersion`, and comparisons refuse
 * mismatched spaces or geometry versions. No platform/geometry discovery happens here.
 */
import { ERROR_CODES } from './contracts.js';
import { AdapterError } from './errors.js';

/** Every coordinate space the neutral model may talk about. */
export const COORDINATE_SPACES = Object.freeze([
  'document-css-px',
  'image-px',
  'viewport-css-px',
  'screen-logical-px',
  'screen-physical-px',
]);

const SPACE_SET = new Set(COORDINATE_SPACES);

function isFiniteNumber(value) {
  return typeof value === 'number' && Number.isFinite(value);
}

function assertSpace(space, field) {
  if (typeof space !== 'string' || !SPACE_SET.has(space)) {
    throw new AdapterError(ERROR_CODES.INVALID_ARGUMENT, `unknown coordinate space for ${field}`, {
      details: { field, value: typeof space === 'string' ? space : null },
    });
  }
  return space;
}

function assertNumber(value, field) {
  if (!isFiniteNumber(value)) {
    throw new AdapterError(ERROR_CODES.INVALID_ARGUMENT, `${field} must be a finite number`, {
      details: { field, value: Number.isNaN(value) ? 'NaN' : typeof value },
    });
  }
  return value;
}

function assertVersion(value) {
  if (!Number.isInteger(value) || value < 0) {
    throw new AdapterError(ERROR_CODES.INVALID_ARGUMENT, 'geometryVersion must be a non-negative integer', {
      details: { field: 'geometryVersion', value: Number.isFinite(value) ? value : null },
    });
  }
  return value;
}

function assertPoint(point, field = 'point') {
  if (point === null || typeof point !== 'object') {
    throw new AdapterError(ERROR_CODES.INVALID_ARGUMENT, `${field} must be an object with x/y`, {
      details: { field },
    });
  }
  return { x: assertNumber(point.x, `${field}.x`), y: assertNumber(point.y, `${field}.y`) };
}

function assertRect(rect, field = 'rect') {
  if (rect === null || typeof rect !== 'object') {
    throw new AdapterError(ERROR_CODES.INVALID_ARGUMENT, `${field} must be an object with x/y/width/height`, {
      details: { field },
    });
  }
  return {
    x: assertNumber(rect.x, `${field}.x`),
    y: assertNumber(rect.y, `${field}.y`),
    width: assertNumber(rect.width, `${field}.width`),
    height: assertNumber(rect.height, `${field}.height`),
  };
}

/**
 * @param {{from:string, to:string, scaleX?:number, scaleY?:number, offsetX?:number,
 *   offsetY?:number, geometryVersion?:number}} input
 * @returns {{from:string, to:string, scaleX:number, scaleY:number, offsetX:number,
 *   offsetY:number, geometryVersion:number}}
 */
export function createTransform({
  from,
  to,
  scaleX = 1,
  scaleY = 1,
  offsetX = 0,
  offsetY = 0,
  geometryVersion = 1,
} = {}) {
  return {
    from: assertSpace(from, 'from'),
    to: assertSpace(to, 'to'),
    scaleX: assertNumber(scaleX, 'scaleX'),
    scaleY: assertNumber(scaleY, 'scaleY'),
    offsetX: assertNumber(offsetX, 'offsetX'),
    offsetY: assertNumber(offsetY, 'offsetY'),
    geometryVersion: assertVersion(geometryVersion),
  };
}

/** Identity mapping within one space. */
export function identityTransform(space, geometryVersion = 1) {
  return createTransform({ from: space, to: space, geometryVersion });
}

function assertTransform(transform, field = 'transform') {
  if (transform === null || typeof transform !== 'object') {
    throw new AdapterError(ERROR_CODES.INVALID_ARGUMENT, `${field} must be a transform object`, {
      details: { field },
    });
  }
  return createTransform(transform);
}

/**
 * Compose two transforms: `b` is applied to the output of `a`.
 *
 * Requires a continuous space chain (`a.to === b.from`) and the same geometry version; otherwise
 * the result would silently mix incompatible observations.
 */
export function composeTransforms(a, b) {
  const first = assertTransform(a, 'a');
  const second = assertTransform(b, 'b');
  if (first.to !== second.from) {
    throw new AdapterError(ERROR_CODES.CAPABILITY_UNSUPPORTED, 'cannot compose transforms across a space gap', {
      details: { firstTo: first.to, secondFrom: second.from },
    });
  }
  if (first.geometryVersion !== second.geometryVersion) {
    throw new AdapterError(ERROR_CODES.CAPABILITY_UNSUPPORTED, 'cannot compose transforms from different geometry versions', {
      details: { first: first.geometryVersion, second: second.geometryVersion },
    });
  }
  return {
    from: first.from,
    to: second.to,
    scaleX: first.scaleX * second.scaleX,
    scaleY: first.scaleY * second.scaleY,
    offsetX: first.offsetX * second.scaleX + second.offsetX,
    offsetY: first.offsetY * second.scaleY + second.offsetY,
    geometryVersion: first.geometryVersion,
  };
}

/** Invert a transform. Zero scale is not invertible and reports CAPABILITY_UNSUPPORTED. */
export function invertTransform(transform) {
  const source = assertTransform(transform);
  if (source.scaleX === 0 || source.scaleY === 0) {
    throw new AdapterError(ERROR_CODES.CAPABILITY_UNSUPPORTED, 'transform has zero scale and cannot be inverted', {
      details: { scaleX: source.scaleX, scaleY: source.scaleY },
    });
  }
  return {
    from: source.to,
    to: source.from,
    scaleX: 1 / source.scaleX,
    scaleY: 1 / source.scaleY,
    offsetX: -source.offsetX / source.scaleX,
    offsetY: -source.offsetY / source.scaleY,
    geometryVersion: source.geometryVersion,
  };
}

/** Map one point through a transform. */
export function mapPoint(transform, point) {
  const source = assertTransform(transform);
  const { x, y } = assertPoint(point);
  return {
    x: x * source.scaleX + source.offsetX,
    y: y * source.scaleY + source.offsetY,
  };
}

/**
 * Map a rect through a transform. The result keeps non-negative width/height, so a flipped
 * (negative-scale) mapping is still a usable rect.
 */
export function mapRect(transform, rect) {
  const source = assertTransform(transform);
  const { x, y, width, height } = assertRect(rect);
  const x1 = x * source.scaleX + source.offsetX;
  const x2 = (x + width) * source.scaleX + source.offsetX;
  const y1 = y * source.scaleY + source.offsetY;
  const y2 = (y + height) * source.scaleY + source.offsetY;
  return {
    x: Math.min(x1, x2),
    y: Math.min(y1, y2),
    width: Math.abs(x2 - x1),
    height: Math.abs(y2 - y1),
  };
}

/**
 * Assert two mappings describe the same observation geometry, so results may be compared.
 *
 * - Different `from`/`to` spaces -> CAPABILITY_UNSUPPORTED (cannot compare across spaces).
 * - Different `geometryVersion` -> GENERATION_MISMATCH (geometry changed under the same spaces).
 */
export function assertCompatibleMapping(a, b) {
  const first = assertTransform(a, 'a');
  const second = assertTransform(b, 'b');
  if (first.from !== second.from || first.to !== second.to) {
    throw new AdapterError(ERROR_CODES.CAPABILITY_UNSUPPORTED, 'mappings target different coordinate spaces', {
      details: {
        first: { from: first.from, to: first.to },
        second: { from: second.from, to: second.to },
      },
    });
  }
  if (first.geometryVersion !== second.geometryVersion) {
    throw new AdapterError(ERROR_CODES.GENERATION_MISMATCH, 'mappings belong to different geometry versions', {
      details: { first: first.geometryVersion, second: second.geometryVersion },
    });
  }
  return true;
}
