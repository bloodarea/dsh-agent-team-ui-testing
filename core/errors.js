/**
 * Normalized error type for the cross-environment foundation.
 *
 * Adapters may throw anything; callers branch on `code`/`category`/`retryable` instead of message
 * text. Unknown codes degrade to INTERNAL without losing the original message or details.
 */
import { ERROR_CODES } from './contracts.js';

/** Error categories shared by every adapter class. */
export const ERROR_CATEGORIES = Object.freeze({
  INPUT: 'input',
  STATE: 'state',
  CAPABILITY: 'capability',
  ENVIRONMENT: 'environment',
  CONFIG: 'config',
  TARGET: 'target',
  EVIDENCE: 'evidence',
  INTERNAL: 'internal',
});

/**
 * code -> [category, retryable]. Retryable means "the same call may succeed later" (busy,
 * timeout, gone target), not "the input was wrong".
 */
export const ERROR_TAXONOMY = Object.freeze({
  ADAPTER_NOT_FOUND: [ERROR_CATEGORIES.ENVIRONMENT, false],
  ADAPTER_UNSUPPORTED: [ERROR_CATEGORIES.CAPABILITY, false],
  ADAPTER_DISABLED: [ERROR_CATEGORIES.CONFIG, false],
  CONFIG_CONFLICT: [ERROR_CATEGORIES.CONFIG, true],
  CONFIG_INVALID: [ERROR_CATEGORIES.CONFIG, false],
  CONFIG_STALE: [ERROR_CATEGORIES.CONFIG, true],
  TARGET_NOT_BOUND: [ERROR_CATEGORIES.TARGET, false],
  TARGET_GONE: [ERROR_CATEGORIES.TARGET, true],
  GENERATION_MISMATCH: [ERROR_CATEGORIES.STATE, false],
  CAPABILITY_UNSUPPORTED: [ERROR_CATEGORIES.CAPABILITY, false],
  CAPABILITY_UNAVAILABLE: [ERROR_CATEGORIES.ENVIRONMENT, true],
  DEPENDENCY_MISSING: [ERROR_CATEGORIES.ENVIRONMENT, false],
  CONNECTION_UNTRUSTED: [ERROR_CATEGORIES.ENVIRONMENT, true],
  PROBE_TIMEOUT: [ERROR_CATEGORIES.ENVIRONMENT, true],
  PROVIDER_UNAVAILABLE: [ERROR_CATEGORIES.ENVIRONMENT, true],
  EVIDENCE_INCOMPLETE: [ERROR_CATEGORIES.EVIDENCE, false],
  FORBIDDEN: [ERROR_CATEGORIES.CAPABILITY, false],
  INVALID_ARGUMENT: [ERROR_CATEGORIES.INPUT, false],
  OUTPUT_WRITE_FAILED: [ERROR_CATEGORIES.INTERNAL, true],
  INTERNAL: [ERROR_CATEGORIES.INTERNAL, false],
});

const OPTION_KEYS = new Set(['category', 'retryable', 'details', 'cause']);

function isPlainObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function normalizeCode(code) {
  return typeof code === 'string' && Object.hasOwn(ERROR_TAXONOMY, code)
    ? code
    : ERROR_CODES.INTERNAL;
}

/**
 * Error thrown by core helpers and adapters.
 *
 * @param {string} code Stable machine code; unknown codes become INTERNAL.
 * @param {string} [message] Human-readable message. When omitted, a code-derived message is used.
 * @param {object} [detailsOrOptions] Either a plain details object, or
 *   `{category, retryable, details, cause}`. A bare object containing any of those keys is
 *   treated as options; anything else is treated as `details`.
 */
export class AdapterError extends Error {
  constructor(code = ERROR_CODES.INTERNAL, message, detailsOrOptions) {
    const known = typeof code === 'string' && Object.hasOwn(ERROR_TAXONOMY, code);
    const normalized = normalizeCode(code);
    const [defaultCategory, defaultRetryable] = ERROR_TAXONOMY[normalized];

    const looksLikeOptions = isPlainObject(detailsOrOptions)
      && Object.keys(detailsOrOptions).some((key) => OPTION_KEYS.has(key));
    const options = looksLikeOptions ? detailsOrOptions : {};
    const bareDetails = isPlainObject(detailsOrOptions) && !looksLikeOptions
      ? detailsOrOptions
      : undefined;

    const details = options.details !== undefined ? options.details : bareDetails;
    const resolvedMessage = typeof message === 'string' && message.length > 0
      ? message
      : `${normalized}${details === undefined ? '' : ': operation failed'}`;

    super(resolvedMessage);
    this.name = 'AdapterError';
    this.code = normalized;
    this.category = options.category ?? defaultCategory;
    this.retryable = options.retryable ?? defaultRetryable;
    this.details = details === undefined ? {} : details;
    if (!known && typeof code === 'string' && code.length > 0) {
      // Preserve what the caller asked for without pretending it is a supported code.
      this.details = { ...this.details, requestedCode: code };
    }
    if (options.cause !== undefined) this.cause = options.cause;
  }

  /** JSON-safe representation; `cause` is summarized rather than serialized. */
  payload() {
    const payload = {
      name: this.name,
      code: this.code,
      category: this.category,
      retryable: this.retryable,
      message: this.message,
      details: this.details ?? {},
    };
    if (this.cause !== undefined) {
      payload.cause = this.cause instanceof Error
        ? { name: this.cause.name, message: this.cause.message }
        : String(this.cause);
    }
    return payload;
  }
}

/**
 * Coerce any thrown value into an AdapterError.
 *
 * - AdapterError passes through unchanged (the original code is preserved).
 * - Error keeps its message and gains `details.causeName`.
 * - Any other value is stringified, never silently dropped.
 */
export function asAdapterError(error, fallbackCode = ERROR_CODES.INTERNAL) {
  if (error instanceof AdapterError) return error;
  if (error instanceof Error) {
    return new AdapterError(fallbackCode, error.message, {
      details: { causeName: error.name },
      cause: error,
    });
  }
  return new AdapterError(fallbackCode, String(error));
}
