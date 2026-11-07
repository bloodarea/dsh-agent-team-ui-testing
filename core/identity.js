/**
 * Neutral identity factories: scope, operation, target, session, generation.
 *
 * Rules (M0 §2.1 / §3):
 * - Missing fields are `null`; identities never invent workspace ids, target ids or generations.
 * - Operation summaries record shape only (types, lengths, counts), never argument plaintext.
 * - Generation checks are explicit; a mismatch is a state error, not a silent retry.
 */
import { createHash } from 'node:crypto';
import { realpathSync } from 'node:fs';
import { resolve as resolvePath } from 'node:path';
import { ERROR_CODES } from './contracts.js';
import { AdapterError } from './errors.js';

function str(value) {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

function finiteOrNull(value) {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function integerOrNull(value) {
  return Number.isInteger(value) ? value : null;
}

/** Summarize an argument bag without retaining any value plaintext. */
export function summarizeArgs(args) {
  if (args === undefined) return { type: 'undefined' };
  if (args === null) return { type: 'null' };
  if (typeof args === 'string') return { type: 'string', length: args.length };
  if (typeof args === 'number') return { type: 'number' };
  if (typeof args === 'boolean') return { type: 'boolean' };
  if (typeof args === 'bigint') return { type: 'bigint' };
  if (typeof args === 'function') return { type: 'function' };
  if (Array.isArray(args)) return { type: 'array', length: args.length };
  if (typeof args === 'object') {
    const keys = Object.keys(args);
    return { type: 'object', keys: keys.length };
  }
  return { type: typeof args };
}

let operationCounter = 0;

function nextOperationId() {
  operationCounter += 1;
  return `op-${Date.now().toString(36)}-${operationCounter.toString(36)}`;
}

/**
 * Stable workspace key shared by the config buckets and runtime entries.
 *
 * - Explicit workspace id wins: `workspace:<workspaceId>`.
 * - Otherwise the normalized (realpath when possible) cwd is hashed: `path:<sha256 hex>`.
 * - Missing identity returns null; nothing is invented.
 *
 * @param {{agent?:object, cwd?:string, workspaceId?:string}} [input]
 * @returns {string|null}
 */
export function workspaceKeyOf({ agent = null, cwd = null, workspaceId = null } = {}) {
  const explicitId = typeof workspaceId === 'string' && workspaceId.length > 0
    ? workspaceId
    : (typeof agent?.workspaceId === 'string' && agent.workspaceId.length > 0 ? agent.workspaceId : null);
  if (explicitId !== null) return `workspace:${explicitId}`;

  const rawCwd = typeof cwd === 'string' && cwd.length > 0
    ? cwd
    : (typeof agent?.session?.header?.cwd === 'string' && agent.session.header.cwd.length > 0
      ? agent.session.header.cwd
      : null);
  if (rawCwd === null) return null;

  let normalized;
  try {
    normalized = realpathSync(rawCwd);
  } catch {
    normalized = resolvePath(rawCwd);
  }
  const digest = createHash('sha256').update(normalized).digest('hex');
  return `path:${digest}`;
}

/**
 * @param {{id?:string, kind?:string, workspaceId?:string, cwd?:string, sessionId?:string}} [scope]
 * @returns {{id:string|null, kind:string|null, workspaceId:string|null, cwd:string|null,
 *   sessionId:string|null}}
 */
export function newScopeIdentity(scope = {}) {
  const source = scope && typeof scope === 'object' ? scope : {};
  return {
    id: str(source.id),
    kind: str(source.kind),
    workspaceId: str(source.workspaceId),
    cwd: str(source.cwd),
    sessionId: str(source.sessionId),
  };
}

/**
 * @param {{tool?:string, args?:unknown, startedAt?:number|null, operationId?:string}} [input]
 * @returns {{operationId:string, tool:string|null, argsSummary:object,
 *   startedAt:number|null, finishedAt:null}}
 */
export function newOperation({ tool, args, startedAt, operationId } = {}) {
  return {
    operationId: str(operationId) ?? nextOperationId(),
    tool: str(tool),
    argsSummary: summarizeArgs(args),
    startedAt: finiteOrNull(startedAt),
    finishedAt: null,
  };
}

/**
 * @param {{targetId?:string, environment?:string, kind?:string, generation?:number,
 *   label?:string, lifecycle?:string}} [input]
 */
export function newTargetIdentity({
  targetId,
  environment,
  kind,
  generation,
  label,
  lifecycle,
} = {}) {
  return {
    targetId: str(targetId),
    environment: str(environment),
    kind: str(kind),
    generation: integerOrNull(generation),
    label: str(label),
    lifecycle: str(lifecycle),
  };
}

/**
 * @param {{sessionId?:string, environment?:string, generation?:number,
 *   configRevision?:number, targetId?:string}} [input]
 */
export function newSessionIdentity({
  sessionId,
  environment,
  generation,
  configRevision,
  targetId,
} = {}) {
  return {
    sessionId: str(sessionId),
    environment: str(environment),
    generation: integerOrNull(generation),
    configRevision: integerOrNull(configRevision),
    targetId: str(targetId),
  };
}

/**
 * Assert that a target/session is at the generation the caller observed.
 *
 * @param {{generation?:number}|number|null|undefined} target
 * @param {number|null|undefined} expected
 * @param {{code?:string}} [options]
 * @returns {typeof target} the checked value, for chaining
 */
export function assertGeneration(target, expected, { code = ERROR_CODES.GENERATION_MISMATCH } = {}) {
  const actual = target !== null && typeof target === 'object'
    ? integerOrNull(target.generation)
    : integerOrNull(target);
  const wanted = integerOrNull(expected);
  if (actual !== wanted) {
    throw new AdapterError(code, `generation mismatch: expected ${String(wanted)}, got ${String(actual)}`, {
      details: {
        expected: wanted,
        actual,
        targetId: target !== null && typeof target === 'object' ? str(target.targetId) : null,
      },
    });
  }
  return target;
}
