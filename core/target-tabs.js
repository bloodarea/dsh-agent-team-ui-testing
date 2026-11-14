/**
 * Optional TargetAdapter tabs service. This boundary owns request shape and dispatch only;
 * discovery, lifecycle, permissions and concurrency belong to the environment implementation.
 * No browser, host, P0 provider or platform module is imported here.
 */
import { CONTRACT_VERSION, ERROR_CODES } from './contracts.js';
import { AdapterError } from './errors.js';

export const TARGET_TABS_ACTION_FIELDS = Object.freeze(Object.fromEntries(Object.entries({
  list: ['action'],
  current: ['action'],
  select: ['action', 'tabId', 'mode'],
  open: ['action'],
  close: ['action', 'tabId'],
  wait: ['action', 'tabId', 'kind', 'source', 'timeoutMs', 'pollMs'],
  acquire: ['action', 'tabId', 'expectedControlRevision', 'timeoutMs'],
  release: ['action', 'tabId', 'expectedControlRevision'],
  transfer: ['action', 'tabId', 'toSessionId', 'expectedControlRevision', 'expectedOwnershipRevision'],
}).map(([action, fields]) => [action, Object.freeze(fields)])));

export const TARGET_TABS_ACTIONS = Object.freeze(Object.keys(TARGET_TABS_ACTION_FIELDS));

function isRecord(value) {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function invalid(message, details) {
  throw new AdapterError(ERROR_CODES.INVALID_ARGUMENT, message, { details });
}

function validateRequest(request) {
  if (!isRecord(request)) invalid('TargetTabs request must be an object', { field: 'request' });
  const { action } = request;
  if (typeof action !== 'string' || !Object.hasOwn(TARGET_TABS_ACTION_FIELDS, action)) {
    invalid('TargetTabs action is invalid', { field: 'action', allowed: TARGET_TABS_ACTIONS });
  }
  const allowed = TARGET_TABS_ACTION_FIELDS[action];
  const rejected = Object.keys(request).filter((key) => !allowed.includes(key));
  if (rejected.length) invalid(`${action} does not accept fields ${rejected.join(',')}`, {
    field: 'action', action, allowed, rejected,
  });
  for (const field of ['tabId', 'mode', 'kind', 'source', 'toSessionId']) {
    const value = request[field];
    // Nullable tabId means no explicit target; close may resolve the current selection.
    if (value === undefined || (field === 'tabId' && value === null && ['wait', 'close'].includes(action))) continue;
    if (field === 'tabId' && action === 'close' && typeof value === 'string') continue;
    if (typeof value !== 'string' || !value.trim()) {
      invalid(`${field} must be a non-empty string`, { field, action });
    }
  }
  for (const field of ['timeoutMs', 'pollMs', 'expectedControlRevision', 'expectedOwnershipRevision']) {
    const value = request[field];
    if (value === undefined) continue;
    const minimum = field === 'timeoutMs' ? 0 : 1;
    if (!Number.isSafeInteger(value) || value < minimum) {
      invalid(`${field} must be a safe integer >= ${minimum}`, { field, action, min: minimum });
    }
  }
}

/**
 * Create a service for any environment, including a browser-free fixture. All actions are
 * optional. `actions` advertises implemented handlers; invoking a known absent action reports
 * CAPABILITY_UNSUPPORTED. kind/source vocabulary, defaults, field requirements, limits and
 * platform result fields remain the environment's responsibility. Context and errors pass through.
 */
export function createTargetTabs({ environment, handlers = {} } = {}) {
  if (typeof environment !== 'string' || !environment.trim()) {
    invalid('TargetTabs requires an environment', { field: 'environment' });
  }
  if (!isRecord(handlers)) invalid('TargetTabs handlers must be an object', { field: 'handlers' });
  for (const [action, handler] of Object.entries(handlers)) {
    if (!TARGET_TABS_ACTIONS.includes(action) || typeof handler !== 'function') {
      invalid('TargetTabs handlers must implement known actions', { field: 'handlers', action });
    }
  }
  const implementations = Object.freeze({ ...handlers });
  const actions = Object.freeze(TARGET_TABS_ACTIONS.filter((action) => Object.hasOwn(implementations, action)));
  return Object.freeze({
    contractVersion: CONTRACT_VERSION,
    environment,
    actions,
    async invoke(request, context) {
      validateRequest(request);
      const handler = implementations[request.action];
      if (typeof handler !== 'function') {
        throw new AdapterError(ERROR_CODES.CAPABILITY_UNSUPPORTED,
          `TargetTabs ${environment}.${request.action} is not implemented`, {
            details: { environment, action: request.action, actions },
          });
      }
      return handler(request, context);
    },
  });
}
