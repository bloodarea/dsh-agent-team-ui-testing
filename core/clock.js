/**
 * Clock helpers (P0-A metadata, M0 §3).
 *
 * Two clocks are kept separate: wall time for human-facing timestamps, monotonic time for
 * durations. A source timestamp is never invented: missing/non-finite values become `null`, and a
 * frame without a source timestamp must not claim a derived source time.
 */
import { ERROR_CODES } from './contracts.js';
import { AdapterError } from './errors.js';

const NS_PER_MS = 1_000_000n;

/** Current wall-clock milliseconds (epoch). */
export function nowWallMs() {
  return Date.now();
}

/**
 * Current monotonic milliseconds from `process.hrtime.bigint()`.
 *
 * Monotonic values are only meaningful relative to each other; do not persist them as dates.
 */
export function nowMonoMs() {
  return Number(process.hrtime.bigint()) / Number(NS_PER_MS);
}

function assertFinite(value, field) {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new AdapterError(ERROR_CODES.INVALID_ARGUMENT, `${field} must be a finite number`, {
      details: { field, value: Number.isNaN(value) ? 'NaN' : typeof value },
    });
  }
  return value;
}

/**
 * Anchor a monotonic reading to wall time once; later conversions reuse the anchor.
 *
 * @param {{wallMs:number, monoMs:number}} input
 * @returns {{wallMs:number, monoMs:number}}
 */
export function createClockAnchor({ wallMs, monoMs } = {}) {
  return {
    wallMs: assertFinite(wallMs, 'wallMs'),
    monoMs: assertFinite(monoMs, 'monoMs'),
  };
}

/** Convert a monotonic reading into wall milliseconds using a fixed anchor. */
export function toSourceTime(anchor, monoMs) {
  if (anchor === null || typeof anchor !== 'object') {
    throw new AdapterError(ERROR_CODES.INVALID_ARGUMENT, 'anchor must be a clock anchor object', {
      details: { field: 'anchor' },
    });
  }
  const wall = assertFinite(anchor.wallMs, 'anchor.wallMs');
  const base = assertFinite(anchor.monoMs, 'anchor.monoMs');
  return wall + (assertFinite(monoMs, 'monoMs') - base);
}

/**
 * Normalize a source timestamp: undefined/null/non-finite/non-number -> null.
 *
 * `0` is a valid timestamp and is preserved.
 */
export function sourceTimestampOrNull(value) {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

/**
 * Refuse to fabricate a source time: a frame with `sourceTimestamp: null` must not carry a
 * `derivedSource` value. Returns the frame when the invariant holds.
 */
export function assertNoFabricatedSourceTime(frame) {
  if (frame === null || typeof frame !== 'object') {
    throw new AdapterError(ERROR_CODES.INVALID_ARGUMENT, 'frame must be an object', {
      details: { field: 'frame' },
    });
  }
  const hasTimestamp = typeof frame.sourceTimestamp === 'number' && Number.isFinite(frame.sourceTimestamp);
  if (!hasTimestamp && Object.hasOwn(frame, 'derivedSource') && frame.derivedSource !== null
    && frame.derivedSource !== undefined) {
    throw new AdapterError(ERROR_CODES.EVIDENCE_INCOMPLETE, 'frame has no source timestamp but claims a derived source time', {
      details: { frameId: typeof frame.frameId === 'string' ? frame.frameId : null },
    });
  }
  return frame;
}
