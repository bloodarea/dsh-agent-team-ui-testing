/**
 * Neutral page-access model: Principal, page-group keys, operation effects and the
 * ownership/control state machine (M1 of the team-tab ownership plan).
 *
 * Why this module exists
 * - A page may only be authorised against identity the plugin can actually prove, and that proof
 *   lives in the Host bridge (`integration/tab-principal.js`), not here. This file is the pure,
 *   side-effect-free half: given an *already proven* Principal plus the stored ownership/control
 *   records it answers "may this actor do this, here, at this version?" — and it never guesses.
 * - Every rule below is default-deny. An unknown operation, an unknown sub-action, an unknown
 *   effect or an unknown role is a refusal with a machine code, never a silent pass. A permission
 *   table that fails open on a typo is worse than no table at all, because the typo is invisible.
 * - Nothing in this file talks to a Host, Cordis, the filesystem, a socket or a platform API: the
 *   contract tests import it directly and a browser must not be required to prove authorisation
 *   semantics. See docs/internal/m0-rulings-20261109.md §7.1-§7.4 (the frozen contract) and
 *   docs/internal/team-tab-ownership-concurrency-plan-20261109.md §3-§5.
 *
 * Unforgeability has two layers, and they are deliberately different:
 *   - `makePrincipal` brands the object with a module-private Symbol. A Principal that travelled
 *     through JSON (HTTP body, tool argument, WS query, product metadata) loses the brand and
 *     `assertPrincipal` refuses it. Transmission layers therefore cannot mint "I am the Lead".
 *   - The brand does *not* prove the fields are true: only the resolver may call `makePrincipal`,
 *     and it must have read the fields from the native registry/membership first. This module
 *     trusts the resolver for provenance and checks everything downstream of it.
 */

import { ENVIRONMENTS, ERROR_CODES, WEB_PROVIDER_SUPPORT } from './contracts.js';
import { AdapterError } from './errors.js';

/** Principal origins. Only these three entry points exist; HTTP/tool parameters are none of them. */
export const PRINCIPAL_SOURCE = Object.freeze({
  AGENT: 'agent',
  PANEL: 'panel',
  SYSTEM: 'system',
});

/**
 * Principal roles.
 *
 * `lead` and `teammate` are native Team roles, accepted as-is. `standalone` is *not* "we could not
 * find a team": it is a host-proved independent domain whose root is the actor itself, so it can
 * only ever reach its own pages. `undefined` membership never degrades into `standalone` — that
 * degrading is exactly how a stale object would self-promote into a private team of one.
 */
export const PRINCIPAL_ROLE = Object.freeze({
  LEAD: 'lead',
  TEAMMATE: 'teammate',
  STANDALONE: 'standalone',
});

/** Long-lived page control states (plan §5). Short leases are a different concept and stay out. */
export const CONTROL_STATE = Object.freeze({
  OWNED: 'owned',
  DRAINING: 'draining',
  LEAD_CONTROLLED: 'lead-controlled',
  RETIRED: 'retired',
});

/** What a call is allowed to do. `callerLocal` is "only my own bookkeeping", never a page write. */
export const EFFECT = Object.freeze({
  OBSERVE: 'observe',
  WRITE: 'write',
  MANAGE: 'manage',
  CALLER_LOCAL: 'callerLocal',
});

/** What the effect acts on. Config scope and access domain stay separate on purpose. */
export const RESOURCE = Object.freeze({
  PAGE: 'page',
  COLLECTOR: 'collector',
  ARTIFACT: 'artifact',
  HOST: 'host',
});

/** Control-graph events (plan §5.1). Every other name is an unknown event. */
export const CONTROL_EVENT = Object.freeze({
  ACQUIRE: 'acquire',
  ACQUIRE_COMMIT: 'acquire-commit',
  ACQUIRE_CANCEL: 'acquire-cancel',
  RELEASE: 'release',
  TRANSFER: 'transfer',
  RETIRE: 'retire',
});

/**
 * Machine-readable denial reasons. Callers branch on `reason`; the human code is a detail.
 *
 * `CROSS_ROOT` deliberately carries **no** error code and no details: whether a foreign page
 * exists at all is information the caller has no right to. The caller maps it to whatever uniform
 * "not found" its surface uses (ruling §7.3), so the model never gets to leak existence by
 * choosing a code that only one of the two states would produce.
 */
export const AUTHORIZE_REASON = Object.freeze({
  ALLOWED: 'allowed',
  CROSS_ROOT: 'cross-root',
  IDENTITY_UNVERIFIED: 'identity-unverified',
  ROLE_FORBIDDEN: 'role-forbidden',
  NOT_CONTROLLER: 'not-controller',
  CONTROL_DRAINING: 'control-draining',
  TARGET_RETIRED: 'target-retired',
  CONTROL_REVISION_STALE: 'control-revision-stale',
  OWNERSHIP_REVISION_STALE: 'ownership-revision-stale',
  HOST_MANAGE_FORBIDDEN: 'host-manage-forbidden',
  TARGET_UNRESOLVED: 'target-unresolved',
});

/** Versioned key prefixes. One prefix per key space so a composed key can never be mistaken. */
export const PAGE_GROUP_KEY_PREFIX = 'page-group:v1:';
export const PAGE_TARGET_KEY_PREFIX = 'page-target:v1:';
export const ACTOR_SELECTION_KEY_PREFIX = 'actor-selection:v1:';

const COMPOSED_KEY_PREFIXES = Object.freeze([
  PAGE_GROUP_KEY_PREFIX,
  PAGE_TARGET_KEY_PREFIX,
  ACTOR_SELECTION_KEY_PREFIX,
]);

const KNOWN_ENVIRONMENTS = new Set(Object.values(ENVIRONMENTS));
// A *known* provider is a key of the one support table; a *usable* one is a separate question that
// this module must not re-answer (contracts.js: "never add a second 'is edge usable?' judgement").
const KNOWN_PROVIDERS = new Set(Object.keys(WEB_PROVIDER_SUPPORT));
const KNOWN_EFFECTS = new Set(Object.values(EFFECT));
const KNOWN_RESOURCES = new Set(Object.values(RESOURCE));
const KNOWN_SOURCES = new Set(Object.values(PRINCIPAL_SOURCE));
const KNOWN_ROLES = new Set(Object.values(PRINCIPAL_ROLE));
const KNOWN_CONTROL_STATES = new Set(Object.values(CONTROL_STATE));
const KNOWN_EVENTS = new Set(Object.values(CONTROL_EVENT));

function isPlainObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isNonEmptyString(value) {
  return typeof value === 'string' && value.trim().length > 0;
}

function isRevision(value) {
  return Number.isInteger(value) && value >= 1;
}

function invalid(message, details) {
  return new AdapterError(ERROR_CODES.INVALID_ARGUMENT, message, { details });
}

/** Reject anything that is not a plain non-blank string; ids are never coerced. */
function requireIdentifier(value, field) {
  if (!isNonEmptyString(value)) {
    throw invalid(`${field} must be a non-empty string`, { field });
  }
  if (value !== value.trim()) {
    throw invalid(`${field} must not carry surrounding whitespace`, { field });
  }
  return value;
}

/**
 * Reject an id that already *is* a composed key.
 *
 * The ruling freezes "one factory per key space, never re-compose a composed key as a base". A
 * `workspaceKey` that starts with a key prefix means a caller skipped the factory and is about to
 * build a key whose root dimension is silently wrong — that is a cross-root aliasing bug waiting
 * to happen, so it is refused here instead of being decoded later.
 */
function requireRawDimension(value, field) {
  requireIdentifier(value, field);
  for (const prefix of COMPOSED_KEY_PREFIXES) {
    if (value.startsWith(prefix)) {
      throw invalid(`${field} is a composed key, not a raw dimension`, { field, prefix });
    }
  }
  return value;
}

/* ----------------------------------------------------------------------------------------------- *
 * Principal
 * ----------------------------------------------------------------------------------------------- */

const PRINCIPAL_BRAND = Symbol('tab-access.principal');

const PRINCIPAL_FIELDS = Object.freeze([
  'actorSessionId',
  'rootSessionId',
  'role',
  'membershipRevision',
  'executionEpoch',
  'source',
  'hostEpoch',
]);

/**
 * Validate Principal field values without caring where they came from.
 *
 * Shape checks only: this is the layer below the resolver, so "is this really that Session" is
 * already answered; here we guarantee the *type* invariants every rule downstream relies on (no
 * empty ids, no non-integer versions, no invented role).
 */
function validatePrincipalFields(input) {
  if (!isPlainObject(input)) {
    throw invalid('principal must be a plain object', { field: 'principal' });
  }
  const unexpected = Object.keys(input).filter((key) => !PRINCIPAL_FIELDS.includes(key));
  if (unexpected.length > 0) {
    // Extra fields are not harmless: `role`/`rootSessionId` smuggled in from a request body would
    // sit next to the real ones, and a later `{...principal, ...args}` spread would let them win.
    throw invalid('principal carries unknown fields', { fields: unexpected.sort() });
  }
  if (!KNOWN_SOURCES.has(input.source)) {
    throw invalid(`unknown principal source: ${String(input.source)}`, { field: 'source' });
  }
  if (!KNOWN_ROLES.has(input.role)) {
    throw invalid(`unknown principal role: ${String(input.role)}`, { field: 'role' });
  }
  const actorSessionId = requireIdentifier(input.actorSessionId, 'actorSessionId');
  const rootSessionId = requireIdentifier(input.rootSessionId, 'rootSessionId');
  if (!isRevision(input.membershipRevision)) {
    throw invalid('membershipRevision must be an integer >= 1', { field: 'membershipRevision' });
  }
  if (!isRevision(input.executionEpoch)) {
    throw invalid('executionEpoch must be an integer >= 1', { field: 'executionEpoch' });
  }
  const hostEpoch = requireIdentifier(input.hostEpoch, 'hostEpoch');
  if (input.role === PRINCIPAL_ROLE.STANDALONE && rootSessionId !== actorSessionId) {
    // An independent domain cannot *represent* another root: that is the shape of a self-promoted
    // principal, so it is refused even before any page is looked at.
    throw invalid('standalone principal must be its own root', {
      field: 'rootSessionId',
      reason: 'standalone-root-mismatch',
    });
  }
  return {
    actorSessionId,
    rootSessionId,
    role: input.role,
    membershipRevision: input.membershipRevision,
    executionEpoch: input.executionEpoch,
    source: input.source,
    hostEpoch,
  };
}

/**
 * Build a Principal. **Only the trusted resolver may call this** (`integration/tab-principal.js`).
 *
 * The result is frozen and branded. Frozen because every rule compares versions from it and a
 * mid-call mutation would let two different identities share one call; branded because a JSON
 * clone has to be refused (ruling §7.1: "对象注册于私有 resolver，跨层拒绝未登记对象").
 *
 * @param {{actorSessionId:string, rootSessionId:string, role:string, membershipRevision:number,
 *   executionEpoch:number, source:string, hostEpoch:string}} input
 * @returns {Readonly<object>} branded principal
 */
export function makePrincipal(input) {
  const fields = validatePrincipalFields(input);
  const principal = { ...fields };
  Object.defineProperty(principal, PRINCIPAL_BRAND, { value: true, enumerable: false });
  return Object.freeze(principal);
}

/**
 * Assert that a value is a resolver-issued Principal and return it.
 *
 * @param {unknown} value
 * @param {{code?:string}} [options] `code` lets the caller keep a more specific surface code
 *   (e.g. TAB_IDENTITY_UNAVAILABLE on a page tool) while sharing this one check.
 * @returns {Readonly<object>} the same principal
 */
export function assertPrincipal(value, { code = ERROR_CODES.INVALID_ARGUMENT } = {}) {
  if (!isPlainObject(value) || value[PRINCIPAL_BRAND] !== true) {
    throw new AdapterError(code, 'principal was not issued by the trusted resolver', {
      details: { reason: 'unregistered-principal' },
    });
  }
  // Re-validate the fields: the brand proves *origin*, not that a hostile layer did not rebuild an
  // object around it. Cheap, and it keeps a single description of a valid principal.
  validatePrincipalFields(value);
  return value;
}

/** Non-throwing form of {@link assertPrincipal}; used by `authorize` to deny instead of throw. */
export function isPrincipal(value) {
  try {
    assertPrincipal(value);
    return true;
  } catch {
    return false;
  }
}

/* ----------------------------------------------------------------------------------------------- *
 * Page-group / target / selection keys (ruling §7.4)
 * ----------------------------------------------------------------------------------------------- */

/**
 * The four dimensions of one physical page group. The root is part of the key, which is the whole
 * point: two roots sharing a workspace/provider must never be able to address each other's primary.
 *
 * @param {{environment?:string, workspaceKey:string, provider:string, rootSessionId:string}} input
 * @returns {string} `page-group:v1:` + JSON array (no hand-built separators, no ambiguity)
 */
export function makePageGroupKey(input) {
  if (!isPlainObject(input)) {
    throw invalid('page group identity must be a plain object', { field: 'input' });
  }
  const environment = requireIdentifier(input.environment, 'environment');
  if (!KNOWN_ENVIRONMENTS.has(environment)) {
    throw invalid(`unknown environment: ${environment}`, { field: 'environment' });
  }
  const workspaceKey = requireRawDimension(input.workspaceKey, 'workspaceKey');
  const provider = requireIdentifier(input.provider, 'provider');
  if (!KNOWN_PROVIDERS.has(provider)) {
    throw invalid(`unknown provider: ${provider}`, { field: 'provider' });
  }
  const rootSessionId = requireRawDimension(input.rootSessionId, 'rootSessionId');
  return PAGE_GROUP_KEY_PREFIX + JSON.stringify([environment, workspaceKey, provider, rootSessionId]);
}

/**
 * Canonical identity of one physical target inside a group.
 *
 * @param {{groupKey:string, tabId:string}} input
 * @returns {string} `page-target:v1:` + JSON array. Never re-composed from a composed base key.
 */
export function makePageTargetKey(input) {
  if (!isPlainObject(input)) {
    throw invalid('page target identity must be a plain object', { field: 'input' });
  }
  const groupKey = requireIdentifier(input.groupKey, 'groupKey');
  if (!groupKey.startsWith(PAGE_GROUP_KEY_PREFIX)) {
    throw invalid('groupKey must come from makePageGroupKey', { field: 'groupKey' });
  }
  parsePageGroupKey(groupKey);
  const tabId = requireRawDimension(input.tabId, 'tabId');
  return PAGE_TARGET_KEY_PREFIX + JSON.stringify([groupKey, tabId]);
}

/**
 * Key of one actor's own selection inside a group.
 *
 * Selections are per actor *and* per root, so "recent" can no longer be one global value and a
 * selection can never be inherited across roots.
 *
 * @param {{groupKey:string, actorSessionId:string}} input
 * @returns {string} `actor-selection:v1:` + JSON array
 */
export function makeActorSelectionKey(input) {
  if (!isPlainObject(input)) {
    throw invalid('actor selection identity must be a plain object', { field: 'input' });
  }
  const groupKey = requireIdentifier(input.groupKey, 'groupKey');
  if (!groupKey.startsWith(PAGE_GROUP_KEY_PREFIX)) {
    throw invalid('groupKey must come from makePageGroupKey', { field: 'groupKey' });
  }
  parsePageGroupKey(groupKey);
  const actorSessionId = requireRawDimension(input.actorSessionId, 'actorSessionId');
  return ACTOR_SELECTION_KEY_PREFIX + JSON.stringify([groupKey, actorSessionId]);
}

/**
 * Decode a group key back into its dimensions.
 *
 * Needed by the exact-binding lookup (runtime id -> entry) which must re-check the Principal root
 * and provider before returning anything; a decode failure means a key was not produced by the
 * factory, which is a programming error rather than a caller error.
 *
 * @param {string} key
 * @returns {{environment:string, workspaceKey:string, provider:string, rootSessionId:string}}
 * @throws {AdapterError} INVALID_ARGUMENT when the key did not come from `makePageGroupKey`
 */
export function parsePageGroupKey(key) {
  if (typeof key !== 'string' || !key.startsWith(PAGE_GROUP_KEY_PREFIX)) {
    throw invalid('group key was not produced by makePageGroupKey', { field: 'groupKey' });
  }
  let parts;
  try {
    parts = JSON.parse(key.slice(PAGE_GROUP_KEY_PREFIX.length));
  } catch {
    throw invalid('group key payload is not JSON', { field: 'groupKey' });
  }
  if (!Array.isArray(parts) || parts.length !== 4 || parts.some((part) => !isNonEmptyString(part))) {
    throw invalid('group key payload must be four non-empty strings', { field: 'groupKey' });
  }
  const [environment, workspaceKey, provider, rootSessionId] = parts;
  return { environment, workspaceKey, provider, rootSessionId };
}

/* ----------------------------------------------------------------------------------------------- *
 * Ownership and control records
 * ----------------------------------------------------------------------------------------------- */

/**
 * Long-lived ownership of one page (plan §3.1). Creator is audit-only and survives a transfer;
 * `ownershipRevision` moves *only* when the owner actually changes.
 *
 * @param {{rootSessionId:string, creatorSessionId:string, ownerSessionId:string,
 *   ownershipRevision?:number}} input
 * @returns {Readonly<object>}
 */
export function makeOwnership(input) {
  if (!isPlainObject(input)) throw invalid('ownership must be a plain object', { field: 'input' });
  const ownershipRevision = input.ownershipRevision ?? 1;
  if (!isRevision(ownershipRevision)) {
    throw invalid('ownershipRevision must be an integer >= 1', { field: 'ownershipRevision' });
  }
  return Object.freeze({
    rootSessionId: requireIdentifier(input.rootSessionId, 'rootSessionId'),
    creatorSessionId: requireIdentifier(input.creatorSessionId, 'creatorSessionId'),
    ownerSessionId: requireIdentifier(input.ownerSessionId, 'ownerSessionId'),
    ownershipRevision,
  });
}

/**
 * Control record of one page (plan §3.1/§5.1).
 *
 * `pendingControllerSessionId` exists only while a takeover is draining: the older write path must
 * already see a blocked gate, while the controller itself has *not* changed yet (the ruling keeps
 * the controller stable until the in-flight work reaches a safe boundary, so a timeout or a cancel
 * leaves no silently-moved controller behind).
 *
 * @param {{state?:string, controllerSessionId:string|null, controlRevision?:number,
 *   pendingControllerSessionId?:string|null}} input
 * @returns {Readonly<object>}
 */
export function makeControl(input) {
  if (!isPlainObject(input)) throw invalid('control must be a plain object', { field: 'input' });
  const state = input.state ?? CONTROL_STATE.OWNED;
  if (!KNOWN_CONTROL_STATES.has(state)) {
    throw invalid(`unknown control state: ${String(state)}`, { field: 'state' });
  }
  const controlRevision = input.controlRevision ?? 1;
  if (!isRevision(controlRevision)) {
    throw invalid('controlRevision must be an integer >= 1', { field: 'controlRevision' });
  }
  // A retired record has no writer at all; every other state names exactly one.
  const controllerSessionId = state === CONTROL_STATE.RETIRED
    ? null
    : requireIdentifier(input.controllerSessionId, 'controllerSessionId');
  const pending = input.pendingControllerSessionId ?? null;
  if (pending !== null && state !== CONTROL_STATE.DRAINING) {
    throw invalid('only a draining control record may carry a pending controller', {
      field: 'pendingControllerSessionId',
      state,
    });
  }
  return Object.freeze({
    state,
    controllerSessionId,
    controlRevision,
    pendingControllerSessionId: pending === null ? null : requireIdentifier(pending, 'pendingControllerSessionId'),
  });
}

/**
 * Fresh record for a page that just received ownership: owner controls it, revisions start at 1.
 *
 * @param {{rootSessionId:string, creatorSessionId:string, ownerSessionId?:string}} input
 * @returns {{ownership:Readonly<object>, control:Readonly<object>}}
 */
export function makePageAccess(input) {
  if (!isPlainObject(input)) throw invalid('page access must be a plain object', { field: 'input' });
  const ownerSessionId = input.ownerSessionId ?? input.creatorSessionId;
  return {
    ownership: makeOwnership({
      rootSessionId: input.rootSessionId,
      creatorSessionId: input.creatorSessionId,
      ownerSessionId,
    }),
    control: makeControl({ state: CONTROL_STATE.OWNED, controllerSessionId: ownerSessionId }),
  };
}

function controlChanged(message, details) {
  return new AdapterError(ERROR_CODES.TAB_CONTROL_CHANGED, message, { details });
}

function crossRootRefusal(field) {
  // Uniform, detail-free "not found": a transition must not tell a foreign root whether the page
  // exists (ruling §7.3 keeps existence hidden; the caller maps this to its own not-found shape).
  return new AdapterError(ERROR_CODES.TAB_NOT_FOUND, 'page is not addressable from this principal', {
    details: { hidden: true, field },
  });
}

/** Throw the uniform cross-root refusal unless the principal owns this root. */
function requireSameRoot(principal, rootSessionId) {
  if (principal.rootSessionId !== rootSessionId) throw crossRootRefusal('rootSessionId');
}

function requireRevision(actual, expected, field) {
  if (expected === undefined || expected === null) return;
  if (!isRevision(expected)) {
    throw invalid(`${field} must be an integer >= 1`, { field });
  }
  if (expected !== actual) {
    const code = field === 'expectedOwnershipRevision'
      ? ERROR_CODES.TAB_OWNERSHIP_STALE
      : ERROR_CODES.TAB_CONTROL_CHANGED;
    throw new AdapterError(code, `${field} mismatch: expected ${expected}, current ${actual}`, {
      details: { expected, current: actual, field },
    });
  }
}

/**
 * Apply one control-graph event, returning new records.
 *
 * Order of checks is the contract, not an implementation detail: **root first, role second,
 * versions last** (plan §3.3). Checking a version before the root would answer "wrong revision" to
 * a stranger, which confirms the page exists. A cross-root caller gets the same answer whether or
 * not the page is there.
 *
 * Version rules (ruling §7.1 / plan §5.1) — only these bump, and never down:
 *   - acquire        : owned -> draining, revision unchanged (nothing moved yet)
 *   - acquire-commit : draining -> lead-controlled, controlRevision + 1
 *   - acquire-cancel : draining -> owned, revision unchanged (the controller never moved)
 *   - release        : lead-controlled -> owned, controlRevision + 1
 *   - transfer       : owner/controller -> to, ownershipRevision + 1 **and** controlRevision + 1
 *   - retire         : any live state -> retired, controlRevision + 1
 *
 * An already-satisfied request at the *same* current revision reports `changed: false` and writes
 * nothing (ruling §5: "相同当前版本的 acquire/release/transfer 返回 changed:false，不加版本").
 *
 * @param {{ownership:object, control:object}} record
 * @param {{type:string, principal:object, expectedControlRevision?:number,
 *   expectedOwnershipRevision?:number, toSessionId?:string}} event
 * @returns {{ownership:object, control:object, changed:boolean}}
 * @throws {AdapterError} TAB_NOT_FOUND (cross root), TAB_FORBIDDEN (role), TAB_CONTROL_CHANGED
 *   (state or control-revision), TAB_OWNERSHIP_STALE (ownership-revision), INVALID_ARGUMENT
 */
export function applyControlTransition({ ownership, control } = {}, event = {}) {
  const own = makeOwnership(ownership ?? {});
  const ctl = makeControl(control ?? {});
  if (!isPlainObject(event)) throw invalid('control event must be a plain object', { field: 'event' });
  const { type } = event;
  if (!KNOWN_EVENTS.has(type)) {
    throw invalid(`unknown control event: ${String(type)}`, { field: 'type' });
  }
  const principal = assertPrincipal(event.principal, { code: ERROR_CODES.TAB_IDENTITY_UNAVAILABLE });

  // 1. root
  requireSameRoot(principal, own.rootSessionId);

  const actor = principal.actorSessionId;
  const isLead = principal.role === PRINCIPAL_ROLE.LEAD;
  const leadOnly = () => {
    if (!isLead) {
      throw new AdapterError(ERROR_CODES.TAB_FORBIDDEN, 'only this root Lead may manage control', {
        details: { reason: AUTHORIZE_REASON.ROLE_FORBIDDEN, event: type, role: principal.role },
      });
    }
  };
  const retiredRefusal = () => {
    if (ctl.state === CONTROL_STATE.RETIRED) {
      throw new AdapterError(ERROR_CODES.TARGET_GONE, 'page is retired', {
        details: { reason: AUTHORIZE_REASON.TARGET_RETIRED, event: type },
      });
    }
  };
  const commit = (nextOwn, nextCtl, changed = true) => ({
    ownership: makeOwnership(nextOwn),
    control: makeControl(nextCtl),
    changed,
  });

  switch (type) {
    case CONTROL_EVENT.ACQUIRE: {
      // 2. role
      leadOnly();
      retiredRefusal();
      // 3. version, then state
      requireRevision(ctl.controlRevision, event.expectedControlRevision, 'expectedControlRevision');
      if (ctl.state === CONTROL_STATE.LEAD_CONTROLLED && ctl.controllerSessionId === actor) {
        return commit(own, ctl, false);
      }
      if (ctl.state !== CONTROL_STATE.OWNED) {
        throw controlChanged('page is not in a state that can be drained', {
          reason: AUTHORIZE_REASON.CONTROL_DRAINING,
          state: ctl.state,
        });
      }
      return commit(own, {
        state: CONTROL_STATE.DRAINING,
        controllerSessionId: ctl.controllerSessionId,
        controlRevision: ctl.controlRevision,
        pendingControllerSessionId: actor,
      });
    }
    case CONTROL_EVENT.ACQUIRE_COMMIT: {
      leadOnly();
      retiredRefusal();
      requireRevision(ctl.controlRevision, event.expectedControlRevision, 'expectedControlRevision');
      if (ctl.state === CONTROL_STATE.LEAD_CONTROLLED && ctl.controllerSessionId === actor) {
        return commit(own, ctl, false);
      }
      if (ctl.state !== CONTROL_STATE.DRAINING) {
        throw controlChanged('no takeover is draining on this page', {
          reason: AUTHORIZE_REASON.CONTROL_DRAINING,
          state: ctl.state,
        });
      }
      if (ctl.pendingControllerSessionId !== actor) {
        // Someone else's drain: committing it would hand this actor control it never asked for.
        throw controlChanged('this takeover belongs to another actor', {
          reason: AUTHORIZE_REASON.NOT_CONTROLLER,
          pendingControllerSessionId: ctl.pendingControllerSessionId,
        });
      }
      return commit(own, {
        state: CONTROL_STATE.LEAD_CONTROLLED,
        controllerSessionId: actor,
        controlRevision: ctl.controlRevision + 1,
      });
    }
    case CONTROL_EVENT.ACQUIRE_CANCEL: {
      leadOnly();
      if (ctl.state !== CONTROL_STATE.DRAINING) {
        return commit(own, ctl, false);
      }
      if (ctl.pendingControllerSessionId !== actor) {
        throw controlChanged('this takeover belongs to another actor', {
          reason: AUTHORIZE_REASON.NOT_CONTROLLER,
          pendingControllerSessionId: ctl.pendingControllerSessionId,
        });
      }
      // The controller never moved, so no version moves either: a cancelled takeover must leave a
      // record byte-identical to the one before it, otherwise a retry would suddenly see "stale".
      return commit(own, {
        state: CONTROL_STATE.OWNED,
        controllerSessionId: own.ownerSessionId,
        controlRevision: ctl.controlRevision,
      });
    }
    case CONTROL_EVENT.RELEASE: {
      leadOnly();
      retiredRefusal();
      requireRevision(ctl.controlRevision, event.expectedControlRevision, 'expectedControlRevision');
      if (ctl.state === CONTROL_STATE.OWNED && ctl.controllerSessionId === own.ownerSessionId) {
        return commit(own, ctl, false);
      }
      if (ctl.state !== CONTROL_STATE.LEAD_CONTROLLED) {
        throw controlChanged('only a Lead-controlled page can be released', {
          reason: AUTHORIZE_REASON.CONTROL_DRAINING,
          state: ctl.state,
        });
      }
      if (ctl.controllerSessionId !== actor) {
        throw controlChanged('this actor is not the current controller', {
          reason: AUTHORIZE_REASON.NOT_CONTROLLER,
          controllerSessionId: ctl.controllerSessionId,
        });
      }
      return commit(own, {
        state: CONTROL_STATE.OWNED,
        controllerSessionId: own.ownerSessionId,
        controlRevision: ctl.controlRevision + 1,
      });
    }
    case CONTROL_EVENT.TRANSFER: {
      leadOnly();
      retiredRefusal();
      const toSessionId = requireIdentifier(event.toSessionId, 'toSessionId');
      // Roster membership of the target must be re-read from the native service *before* this is
      // committed (ruling §2.2/§5); the model can only guarantee that the id is a real id.
      requireRevision(ctl.controlRevision, event.expectedControlRevision, 'expectedControlRevision');
      requireRevision(own.ownershipRevision, event.expectedOwnershipRevision, 'expectedOwnershipRevision');
      if (own.ownerSessionId === toSessionId && ctl.controllerSessionId === toSessionId
        && ctl.state === CONTROL_STATE.OWNED) {
        return commit(own, ctl, false);
      }
      if (toSessionId === own.ownerSessionId) {
        // Handing control back to the current owner changes control, not ownership. Bumping
        // ownershipRevision here would make "the owner did not change" look like a transfer and
        // would invalidate every ownership CAS for a page that never moved.
        return commit(own, {
          state: CONTROL_STATE.OWNED,
          controllerSessionId: toSessionId,
          controlRevision: ctl.controlRevision + 1,
        });
      }
      return commit(
        { ...own, ownerSessionId: toSessionId, ownershipRevision: own.ownershipRevision + 1 },
        {
          state: CONTROL_STATE.OWNED,
          controllerSessionId: toSessionId,
          controlRevision: ctl.controlRevision + 1,
        },
      );
    }
    case CONTROL_EVENT.RETIRE: {
      // close is a lifecycle operation: the owner or the current controller may retire their own
      // page; anyone else needs this root's Lead (plan §5.1 "关闭属于同一控制通道").
      const allowed = isLead || actor === own.ownerSessionId || actor === ctl.controllerSessionId;
      if (!allowed) {
        throw new AdapterError(ERROR_CODES.TAB_FORBIDDEN, 'this actor may not close the page', {
          details: { reason: AUTHORIZE_REASON.ROLE_FORBIDDEN, event: type, role: principal.role },
        });
      }
      if (ctl.state === CONTROL_STATE.RETIRED) return commit(own, ctl, false);
      requireRevision(ctl.controlRevision, event.expectedControlRevision, 'expectedControlRevision');
      return commit(own, {
        state: CONTROL_STATE.RETIRED,
        controllerSessionId: null,
        controlRevision: ctl.controlRevision + 1,
      });
    }
    default:
      throw invalid(`unknown control event: ${String(type)}`, { field: 'type' });
  }
}

/* ----------------------------------------------------------------------------------------------- *
 * operationEffect (ruling §7.2)
 * ----------------------------------------------------------------------------------------------- */

function requirement(effect, resource, targetRequired, sourceAccessRequired = true) {
  return Object.freeze({ effect, resource, targetRequired, sourceAccessRequired });
}

// Reused requirement rows. Freezing them once keeps "the same call always yields the same table".
const OBSERVE_HOST = requirement(EFFECT.OBSERVE, RESOURCE.HOST, false, false);
/** Caller's own cached view: it must be filtered by root, so source access is required. */
const OBSERVE_HOST_VIEW = requirement(EFFECT.OBSERVE, RESOURCE.HOST, false, true);
const OBSERVE_PAGE = requirement(EFFECT.OBSERVE, RESOURCE.PAGE, true);
const WRITE_PAGE = requirement(EFFECT.WRITE, RESOURCE.PAGE, true);
/** Page write whose target is created or resolved later (open, capture onto the work selection). */
const WRITE_PAGE_OPTIONAL = requirement(EFFECT.WRITE, RESOURCE.PAGE, false);
const MANAGE_PAGE = requirement(EFFECT.MANAGE, RESOURCE.PAGE, true);
const MANAGE_PAGE_OPTIONAL = requirement(EFFECT.MANAGE, RESOURCE.PAGE, false);
const OBSERVE_COLLECTOR = requirement(EFFECT.OBSERVE, RESOURCE.COLLECTOR, false);
const WRITE_COLLECTOR = requirement(EFFECT.WRITE, RESOURCE.COLLECTOR, false);
const CALLER_LOCAL_COLLECTOR = requirement(EFFECT.CALLER_LOCAL, RESOURCE.COLLECTOR, false);
const OBSERVE_ARTIFACT = requirement(EFFECT.OBSERVE, RESOURCE.ARTIFACT, false);
const MANAGE_ARTIFACT = requirement(EFFECT.MANAGE, RESOURCE.ARTIFACT, false);
/** New artifact in the caller's own namespace: never an overwrite of a shared record. */
const CALLER_LOCAL_ARTIFACT = requirement(EFFECT.CALLER_LOCAL, RESOURCE.ARTIFACT, false);
const CALLER_LOCAL_HOST = requirement(EFFECT.CALLER_LOCAL, RESOURCE.HOST, false, false);
/** The caller's own selection row: it is keyed by actor, so it is theirs by construction. */
const CALLER_LOCAL_SELECTION = requirement(EFFECT.CALLER_LOCAL, RESOURCE.HOST, true, true);

/**
 * Product/artifact bookkeeping is an *extra* effect on top of the read.
 *
 * `browser_screenshot` without `out`/`persist` writes no file at all, so claiming a callerLocal
 * artifact effect for it would over-restrict; with `out` it does, so the read alone is not the
 * whole story. This is the concrete reason `operationEffect` returns an array.
 */
function artifactWrite(hasProduct) {
  return hasProduct ? [CALLER_LOCAL_ARTIFACT] : [];
}

function wantsProduct(args) {
  const direct = (typeof args.out === 'string' && args.out.trim().length > 0) || args.persist === true;
  const nested = isPlainObject(args.output)
    && ((typeof args.output.out === 'string' && args.output.out.trim().length > 0) || args.output.persist === true);
  return direct || nested;
}

const UNKNOWN = Symbol('unknown');

function actionOf(args, tool, defaultValue = UNKNOWN) {
  const raw = args.action;
  if (raw === undefined) {
    if (defaultValue !== UNKNOWN) return defaultValue;
    throw invalid(`${tool} requires an explicit action`, { field: 'action', operation: tool });
  }
  if (!isNonEmptyString(raw)) {
    throw invalid(`${tool} action must be a non-empty string`, { field: 'action', operation: tool });
  }
  return raw;
}

function actionTable(tool, table, defaultAction = UNKNOWN) {
  const frozen = Object.freeze(table);
  return (args) => {
    // `defaultAction` mirrors a host-side schema default (only browser_network_session has one).
    const action = actionOf(args, tool, defaultAction);
    const row = frozen[action];
    if (row === undefined) {
      // Default-deny: an action the table has never seen is not "probably a read".
      throw invalid(`unknown ${tool} action: ${action}`, { operation: tool, action });
    }
    return typeof row === 'function' ? row(args) : row;
  };
}

/** Vision sources: `live` reads a page, `product`/`baseline` read an owned artifact. */
function visionSourceEffect(source, { field }) {
  const kind = isPlainObject(source)
    ? (source.kind === undefined ? 'live' : source.kind)
    : 'live';
  if (kind === 'live') return OBSERVE_PAGE;
  if (kind === 'product' || kind === 'baseline') return OBSERVE_ARTIFACT;
  throw invalid(`unknown vision source kind: ${String(kind)}`, { field });
}

function nestedLiveSources(sources) {
  return sources.some((source) => isPlainObject(source) && (source.kind === undefined || source.kind === 'live'));
}

const TOOL_EFFECTS = Object.freeze({
  // --- Host/page cached reads -------------------------------------------------------------------
  browser_capabilities: () => [OBSERVE_HOST],
  browser_state: () => [OBSERVE_HOST_VIEW],
  browser_tabs: actionTable('browser_tabs', {
    list: [OBSERVE_HOST_VIEW],
    current: [OBSERVE_HOST_VIEW],
    // wait only *observes* an existing slot / a popup that arrives on its own: no ensure, no claim.
    wait: [OBSERVE_HOST_VIEW],
    select: [CALLER_LOCAL_SELECTION],
    open: [WRITE_PAGE_OPTIONAL],
    close: (args) => [isNonEmptyString(args.tabId) ? MANAGE_PAGE : MANAGE_PAGE_OPTIONAL],
    acquire: [MANAGE_PAGE],
    release: [MANAGE_PAGE],
    transfer: [MANAGE_PAGE],
  }),
  browser_viewport: actionTable('browser_viewport', {
    get: [OBSERVE_HOST_VIEW],
    set: [WRITE_PAGE],
  }),

  // --- Page writes: everything that can move a page or its document ----------------------------
  browser_navigate: () => [WRITE_PAGE],
  browser_eval: () => [WRITE_PAGE],
  browser_input: () => [WRITE_PAGE],
  browser_click: () => [WRITE_PAGE],
  browser_type: () => [WRITE_PAGE],
  browser_scroll: () => [WRITE_PAGE],
  browser_fill_form: () => [WRITE_PAGE],
  browser_vision_act: () => [WRITE_PAGE],

  // --- Page observation: fixed internal read paths, never a script the caller supplies ---------
  browser_screenshot: (args) => [OBSERVE_PAGE, ...artifactWrite(wantsProduct(args))],
  browser_snapshot: () => [OBSERVE_PAGE],
  browser_node_state: () => [OBSERVE_PAGE],
  browser_computed_style: () => [OBSERVE_PAGE],
  browser_wait_for: () => [OBSERVE_PAGE],

  // --- Vision: artifact sources are root-scoped reads, live sources are page reads --------------
  browser_vision_image: (args) => [
    visionSourceEffect(args.source, { field: 'source' }),
    CALLER_LOCAL_ARTIFACT,
    ...artifactWrite(wantsProduct(args)),
  ],
  browser_vision_find: (args) => [
    visionSourceEffect(args.source, { field: 'source' }),
    CALLER_LOCAL_ARTIFACT,
    ...artifactWrite(wantsProduct(args)),
  ],
  browser_vision_compare: (args) => {
    if (!isPlainObject(args.before) || !isPlainObject(args.after)) {
      throw invalid('browser_vision_compare requires explicit before and after sources', {
        operation: 'browser_vision_compare',
      });
    }
    const effects = [OBSERVE_ARTIFACT, CALLER_LOCAL_ARTIFACT];
    if (nestedLiveSources([args.before, args.after])) effects.push(OBSERVE_PAGE);
    return effects.concat(artifactWrite(wantsProduct(args)));
  },
  browser_vision_check: (args) => {
    const cases = Array.isArray(args.cases) ? args.cases : [];
    const effects = [OBSERVE_ARTIFACT, CALLER_LOCAL_ARTIFACT];
    // Each case may embed its own source; a single live source makes the whole batch a page read.
    const caseSources = cases.map((entry) => (isPlainObject(entry) ? entry.source : undefined)).filter(Boolean);
    if (nestedLiveSources(caseSources)) effects.push(OBSERVE_PAGE);
    return effects.concat(artifactWrite(wantsProduct(args)));
  },
  browser_vision_baseline: actionTable('browser_vision_baseline', {
    list: [OBSERVE_ARTIFACT],
    get: [OBSERVE_ARTIFACT],
    // create writes a *new* managed artifact; a live source additionally needs the page.
    create: (args) => (isPlainObject(args.source) && (args.source.kind === undefined || args.source.kind === 'live')
      ? [CALLER_LOCAL_ARTIFACT, OBSERVE_PAGE]
      : [CALLER_LOCAL_ARTIFACT]),
    // update/delete mutate a shared managed record: readable-in-root is not writable-in-root.
    update: (args) => (isPlainObject(args.source) && (args.source.kind === undefined || args.source.kind === 'live')
      ? [MANAGE_ARTIFACT, OBSERVE_PAGE]
      : [MANAGE_ARTIFACT]),
    delete: [MANAGE_ARTIFACT],
  }),

  // --- Network collector -----------------------------------------------------------------------
  browser_network: () => [OBSERVE_COLLECTOR],
  browser_network_events: () => [OBSERVE_COLLECTOR],
  browser_network_detail: () => [OBSERVE_COLLECTOR],
  // The host tool defaults a missing action to `start`; keep that default here so an action-less
  // call is classified as the *strictest* of its three, never as a read.
  browser_network_session: actionTable('browser_network_session', {
    status: [OBSERVE_COLLECTOR],
    start: [WRITE_COLLECTOR, WRITE_PAGE_OPTIONAL],
    stop: [WRITE_COLLECTOR, WRITE_PAGE_OPTIONAL],
    reset: [WRITE_COLLECTOR, WRITE_PAGE_OPTIONAL],
  }, 'start'),
  browser_network_control: actionTable('browser_network_control', {
    'intercept-list': [OBSERVE_COLLECTOR],
    throttle: [WRITE_COLLECTOR],
    offline: [WRITE_COLLECTOR],
    'intercept-add': [WRITE_COLLECTOR],
    'intercept-remove': [WRITE_COLLECTOR],
    'intercept-clear': [WRITE_COLLECTOR],
    hold: [WRITE_COLLECTOR],
    resume: [WRITE_COLLECTOR],
    replay: [WRITE_COLLECTOR, WRITE_PAGE_OPTIONAL],
    mock: [WRITE_COLLECTOR, WRITE_PAGE_OPTIONAL],
    reset: [WRITE_COLLECTOR],
  }),
  browser_network_trace: actionTable('browser_network_trace', {
    window: [OBSERVE_COLLECTOR],
    query: [OBSERVE_COLLECTOR],
    'begin-step': [WRITE_COLLECTOR],
    'end-step': [WRITE_COLLECTOR],
    mark: [WRITE_COLLECTOR],
    link: [WRITE_COLLECTOR],
    reset: [WRITE_COLLECTOR],
  }),
  browser_network_evidence: actionTable('browser_network_evidence', {
    list: [OBSERVE_ARTIFACT],
    search: [OBSERVE_ARTIFACT],
    integrity: [OBSERVE_ARTIFACT],
    // New copy in the caller's own namespace (never an overwrite of a shared record).
    export: [CALLER_LOCAL_ARTIFACT],
    index: [CALLER_LOCAL_ARTIFACT],
    // Shared-store mutation: needs the store's owner/controller or this root's Lead.
    import: [MANAGE_ARTIFACT],
    link: [MANAGE_ARTIFACT],
    clear: [MANAGE_ARTIFACT],
  }),
  browser_network_subscribe: actionTable('browser_network_subscribe', {
    create: [CALLER_LOCAL_COLLECTOR],
    poll: [CALLER_LOCAL_COLLECTOR],
    ack: [CALLER_LOCAL_COLLECTOR],
    close: [CALLER_LOCAL_COLLECTOR],
    list: [CALLER_LOCAL_COLLECTOR],
  }),

  // --- Dynamic (T4) ----------------------------------------------------------------------------
  browser_dynamic_session: actionTable('browser_dynamic_session', {
    status: [OBSERVE_COLLECTOR],
    start: [WRITE_COLLECTOR, WRITE_PAGE_OPTIONAL],
    stop: [WRITE_COLLECTOR, WRITE_PAGE_OPTIONAL],
    reset: [WRITE_COLLECTOR, WRITE_PAGE_OPTIONAL],
    extend: [WRITE_COLLECTOR, WRITE_PAGE_OPTIONAL],
  }),
  // `fresh:true` is an explicit live sampling action that extends the shared capture; everything
  // else is a stored read. The default must be the read, and it must not be reachable as a way to
  // grow a capture session.
  browser_motion_observe: (args) => (args.fresh === true
    ? [WRITE_COLLECTOR, WRITE_PAGE_OPTIONAL]
    : [OBSERVE_COLLECTOR]),
  browser_motion_analyze: () => [OBSERVE_ARTIFACT],
  browser_motion_control: actionTable('browser_motion_control', {
    pause: [WRITE_PAGE],
    resume: [WRITE_PAGE],
    seek: [WRITE_PAGE],
    rate: [WRITE_PAGE],
    // restore replaying another actor's restoreToken must not become a way to borrow control.
    restore: [WRITE_PAGE],
  }),
  browser_dynamic_correlate: () => [OBSERVE_COLLECTOR],

  // --- Independent HTTP: no page, no cookie jar, no Principal for the target --------------------
  browser_http_request: () => [CALLER_LOCAL_HOST],

  // --- Test-only fake environment probe (registered only under the explicit test hook) ---------
  browser_fake_probe: () => [CALLER_LOCAL_HOST],
});

/**
 * Rows of ruling §7.2 that are *not* tools: the HTTP/WS side (GUI viewer, managed-page ops) and the
 * provider-wide host controls. They live in the same table so M3 authorises them through one
 * authority instead of re-classifying inline; unknown ids still refuse, so a mis-wired endpoint
 * fails loudly rather than falling through to a permissive default.
 */
const NON_TOOL_EFFECTS = Object.freeze({
  'gui.frame': [OBSERVE_PAGE, requirement(EFFECT.CALLER_LOCAL, RESOURCE.HOST, false, true)],
  'gui.state': [OBSERVE_HOST_VIEW],
  'gui.metrics': [requirement(EFFECT.CALLER_LOCAL, RESOURCE.HOST, false, true)],
  'gui.annotations.publish': [WRITE_PAGE],
  'gui.canvas': [WRITE_PAGE],
  'gui.view': [WRITE_PAGE],
  'gui.ensure': [WRITE_PAGE_OPTIONAL],
  'gui.navigate': [WRITE_PAGE],
  'gui.input': [WRITE_PAGE],
  'gui.eval': [WRITE_PAGE],
  'gui.close': [MANAGE_PAGE],
  // Provider-wide display/restart and global config are *not* page management: no Agent role
  // reaches them (ruling §7.2 last row), and `authorize` refuses manage/host unconditionally.
  'host.display': [requirement(EFFECT.MANAGE, RESOURCE.HOST, false, false)],
  'host.config': [requirement(EFFECT.MANAGE, RESOURCE.HOST, false, false)],
});

/** Effect strength, strongest last. Used to route a compound call by its strongest requirement. */
const EFFECT_STRENGTH = Object.freeze({
  [EFFECT.OBSERVE]: 0,
  [EFFECT.CALLER_LOCAL]: 1,
  [EFFECT.WRITE]: 2,
  [EFFECT.MANAGE]: 3,
});

function effectKey(row) {
  return `${row.effect}:${row.resource}:${row.targetRequired}`;
}

/**
 * Expand one tool call into every effect it really has (ruling §7.2).
 *
 * The array is the whole truth for the call: a screenshot that also saves a product is an observe
 * *and* a callerLocal artifact write, and a check that embeds a live source is an artifact read
 * *plus* a page read. Authorising only the outer tool name is how a "read" tool ends up writing.
 *
 * @param {string} operation Tool name (`browser_*`) or a frozen non-tool id (`gui.*`, `host.*`).
 * @param {object} [args] Validated call arguments; sub-actions are read from `args.action`.
 * @returns {ReadonlyArray<Readonly<{effect:string, resource:string, targetRequired:boolean,
 *   sourceAccessRequired:boolean}>>}
 * @throws {AdapterError} INVALID_ARGUMENT for an unknown operation **or** unknown sub-action
 *   (default-deny: nothing is dispatched).
 */
export function operationEffect(operation, args = {}) {
  if (!isNonEmptyString(operation)) {
    throw invalid('operation must be a non-empty string', { field: 'operation' });
  }
  const input = isPlainObject(args) ? args : {};
  const nonTool = NON_TOOL_EFFECTS[operation];
  let rows;
  if (nonTool !== undefined) {
    rows = nonTool;
  } else {
    const rule = TOOL_EFFECTS[operation];
    if (rule === undefined) {
      throw invalid(`unknown operation: ${operation}`, { operation });
    }
    rows = rule(input);
  }
  if (!Array.isArray(rows) || rows.length === 0) {
    throw invalid(`operation ${operation} produced no effect requirement`, { operation });
  }
  const seen = new Set();
  const out = [];
  for (const row of rows) {
    if (!KNOWN_EFFECTS.has(row?.effect) || !KNOWN_RESOURCES.has(row?.resource)) {
      throw invalid(`operation ${operation} produced an invalid effect`, { operation });
    }
    const key = effectKey(row);
    if (seen.has(key)) continue; // the array describes effects, not repetitions of one effect
    seen.add(key);
    out.push(row);
  }
  return Object.freeze(out);
}

/**
 * Strongest requirement of a compound call, by `manage > write > callerLocal > observe`.
 *
 * A compound call must be routed by its strongest effect: running the observe half against the
 * caller's own page and the manage half against a teammate's page is the classic confused-deputy.
 *
 * @param {ReadonlyArray<object>} effects
 * @returns {Readonly<object>|null}
 */
export function strongestEffect(effects) {
  if (!Array.isArray(effects) || effects.length === 0) return null;
  let best = effects[0];
  for (const row of effects) {
    if (EFFECT_STRENGTH[row.effect] > EFFECT_STRENGTH[best.effect]) best = row;
  }
  return best;
}

/**
 * True when the operation id is in the frozen effect table (tool rows or non-tool rows).
 * @param {string} operation
 */
export function isKnownOperation(operation) {
  return isNonEmptyString(operation)
    && (Object.hasOwn(TOOL_EFFECTS, operation) || Object.hasOwn(NON_TOOL_EFFECTS, operation));
}

/* ----------------------------------------------------------------------------------------------- *
 * authorise
 * ----------------------------------------------------------------------------------------------- */

/** Operations that close a page: owner/controller may run them, everyone else needs the Lead. */
const CLOSE_OPERATIONS = new Set(['tabs.close', 'browser_tabs.close', 'gui.close']);
/** Operations that move control between actors: Lead-only by construction. */
const CONTROL_OPERATIONS = new Set([
  'tabs.acquire', 'tabs.release', 'tabs.transfer',
  'browser_tabs.acquire', 'browser_tabs.release', 'browser_tabs.transfer',
]);

function verdict(allowed, reason, code, row, extra = {}) {
  return Object.freeze({
    allowed,
    reason,
    code: code ?? null,
    effect: row.effect,
    resource: row.resource,
    targetRequired: row.targetRequired,
    sourceAccessRequired: row.sourceAccessRequired,
    notFound: extra.notFound === true,
    autoAcquire: extra.autoAcquire === true,
  });
}

function deny(row, reason, code, extra) {
  return verdict(false, reason, code, row, extra);
}

/**
 * Decide one effect against one page record.
 *
 * Check order is the contract (plan §3.3): **root, then role, then controller/version**. The
 * consequence of that order is which answer a stranger receives, so it is not reorderable for
 * convenience — a "wrong revision" answer to a foreign root is an existence oracle.
 *
 * @param {{principal:object, ownership?:object|null, control?:object|null, effect:object,
 *   operation?:string|null, expectedControlRevision?:number, expectedOwnershipRevision?:number}} input
 * @returns {Readonly<object>} verdict: `{allowed, reason, code, effect, resource, notFound,
 *   autoAcquire}` — `code` is null exactly for cross-root (existence must not leak).
 */
export function authorize({
  principal,
  ownership = null,
  control = null,
  effect,
  operation = null,
  expectedControlRevision,
  expectedOwnershipRevision,
} = {}) {
  const row = isPlainObject(effect)
    ? requirement(effect.effect, effect.resource, effect.targetRequired === true, effect.sourceAccessRequired !== false)
    : null;
  if (row === null || !KNOWN_EFFECTS.has(row.effect) || !KNOWN_RESOURCES.has(row.resource)) {
    throw invalid('authorize requires a well-formed effect requirement', { field: 'effect' });
  }

  // 0. Identity: an unproved principal never reaches a page, and `system` is not a root admin.
  if (!isPrincipal(principal)) {
    return deny(row, AUTHORIZE_REASON.IDENTITY_UNVERIFIED, ERROR_CODES.TAB_IDENTITY_UNAVAILABLE);
  }
  // Provider-wide host control is not reachable from any Agent/panel/system principal (ruling §7.2).
  if (row.resource === RESOURCE.HOST && row.effect === EFFECT.MANAGE) {
    return deny(row, AUTHORIZE_REASON.HOST_MANAGE_FORBIDDEN, ERROR_CODES.TAB_FORBIDDEN);
  }

  const needsRecord = row.targetRequired === true || row.effect === EFFECT.MANAGE;
  if (!needsRecord) {
    if (row.resource === RESOURCE.PAGE && row.effect !== EFFECT.WRITE) {
      // An observe/manage of a page without a resolved target would authorise "some page".
      return deny(row, AUTHORIZE_REASON.TARGET_UNRESOLVED, ERROR_CODES.TARGET_NOT_BOUND);
    }
    // Creation (page write without a target yet) and caller-owned resources are authorised by the
    // caller's verified root; the caller still has to reserve capacity and bind ownership itself.
    return verdict(true, AUTHORIZE_REASON.ALLOWED, null, row);
  }

  if (!isPlainObject(ownership) || !isPlainObject(control)) {
    return deny(row, AUTHORIZE_REASON.TARGET_UNRESOLVED, ERROR_CODES.TARGET_NOT_BOUND);
  }
  const own = makeOwnership(ownership);
  const ctl = makeControl(control);

  // 1. root — the only step that must be silent about existence.
  if (principal.rootSessionId !== own.rootSessionId) {
    return deny(row, AUTHORIZE_REASON.CROSS_ROOT, null, { notFound: true });
  }

  const actor = principal.actorSessionId;
  const isLead = principal.role === PRINCIPAL_ROLE.LEAD;
  const ownsRecord = own.ownerSessionId === actor;
  const controls = ctl.controllerSessionId === actor;

  // 2. role / 3. state, per effect. Versions are checked **after** these (see the tail): a caller
  // who lacks the role must not learn from the answer whether the revision it guessed is current.
  if (ctl.state === CONTROL_STATE.RETIRED) {
    // A retired target is honestly gone rather than silently absent — the caller already had the
    // right to see this page (same root), so 410 is not an existence leak.
    return deny(row, AUTHORIZE_REASON.TARGET_RETIRED, ERROR_CODES.TARGET_GONE);
  }

  if (row.effect === EFFECT.OBSERVE) {
    // Same root may always look, whatever the role, and looking never claims anything.
    return verdict(true, AUTHORIZE_REASON.ALLOWED, null, row);
  }

  if (row.effect === EFFECT.CALLER_LOCAL) {
    // Only the caller's own bookkeeping. The key factories already bind these rows to the actor,
    // so a same-root check is the whole authorisation (no controller is involved).
    return verdict(true, AUTHORIZE_REASON.ALLOWED, null, row);
  }

  if (ctl.state === CONTROL_STATE.DRAINING) {
    // Old-version writes must observe a closed gate; the takeover completes in its own control
    // chain. Reporting BUSY here would invite an automatic retry against a moving controller.
    return deny(row, AUTHORIZE_REASON.CONTROL_DRAINING, ERROR_CODES.TAB_CONTROL_CHANGED);
  }

  let outcome;
  if (row.effect === EFFECT.WRITE) {
    if (isLead) {
      outcome = ctl.state === CONTROL_STATE.LEAD_CONTROLLED && !controls
        ? deny(row, AUTHORIZE_REASON.NOT_CONTROLLER, ERROR_CODES.TAB_CONTROL_CHANGED)
        // A Lead writing an idle member page is the atomic "acquire then dispatch" path: the caller
        // still has to commit the takeover, and the response says which one happened.
        : verdict(true, AUTHORIZE_REASON.ALLOWED, null, row, {
          autoAcquire: ctl.state === CONTROL_STATE.OWNED && !controls,
        });
    } else if (!ownsRecord) {
      // Teammate/standalone: knowing a target, a runtime id or a lease id never becomes write
      // permission, and a foreign teammate's page is not writable at all.
      outcome = deny(row, AUTHORIZE_REASON.ROLE_FORBIDDEN, ERROR_CODES.TAB_FORBIDDEN);
    } else if (!controls) {
      outcome = deny(row, AUTHORIZE_REASON.NOT_CONTROLLER, ERROR_CODES.TAB_CONTROL_CHANGED);
    } else {
      outcome = verdict(true, AUTHORIZE_REASON.ALLOWED, null, row);
    }
  } else {
    // MANAGE
    const isClose = row.resource === RESOURCE.PAGE && operation !== null && CLOSE_OPERATIONS.has(operation);
    const isControl = row.resource === RESOURCE.PAGE && operation !== null && CONTROL_OPERATIONS.has(operation);
    if (isClose) {
      // close is a lifecycle operation on the same control channel: owner or current controller may
      // retire their own page, everyone else needs this root's Lead.
      outcome = isLead || ownsRecord || controls
        ? verdict(true, AUTHORIZE_REASON.ALLOWED, null, row)
        : deny(row, AUTHORIZE_REASON.ROLE_FORBIDDEN, ERROR_CODES.TAB_FORBIDDEN);
    } else if (isControl) {
      outcome = isLead
        ? verdict(true, AUTHORIZE_REASON.ALLOWED, null, row)
        : deny(row, AUTHORIZE_REASON.ROLE_FORBIDDEN, ERROR_CODES.TAB_FORBIDDEN);
    } else if (isLead) {
      outcome = verdict(true, AUTHORIZE_REASON.ALLOWED, null, row);
    } else if (row.resource !== RESOURCE.PAGE && ownsRecord) {
      // A shared artifact/collector record owned by the caller (its own baseline, its own store
      // slot). An unclassified *page* manage keeps the narrowest rule: this root's Lead only.
      outcome = verdict(true, AUTHORIZE_REASON.ALLOWED, null, row);
    } else {
      outcome = deny(row, AUTHORIZE_REASON.ROLE_FORBIDDEN, ERROR_CODES.TAB_FORBIDDEN);
    }
  }
  if (!outcome.allowed) return outcome;

  // 3. versions, last: the caller has already proven it stands on this page, so telling it that its
  // expected revision is old (and which one is current) reveals nothing it could not read anyway.
  if (expectedOwnershipRevision !== undefined && expectedOwnershipRevision !== own.ownershipRevision) {
    return deny(row, AUTHORIZE_REASON.OWNERSHIP_REVISION_STALE, ERROR_CODES.TAB_OWNERSHIP_STALE);
  }
  if (expectedControlRevision !== undefined && expectedControlRevision !== ctl.controlRevision) {
    return deny(row, AUTHORIZE_REASON.CONTROL_REVISION_STALE, ERROR_CODES.TAB_CONTROL_CHANGED);
  }
  return outcome;
}

/**
 * Authorise a whole compound call by its strongest effect.
 *
 * Every requirement must pass; the answer is the strongest one's verdict so that a caller routing
 * on `autoAcquire`/`reason` sees the most demanding part of the call, not a permissive subset.
 *
 * @param {{principal:object, ownership?:object|null, control?:object|null,
 *   effects:ReadonlyArray<object>, operation?:string|null, expectedControlRevision?:number,
 *   expectedOwnershipRevision?:number}} input
 * @returns {{allowed:boolean, verdict:Readonly<object>, verdicts:ReadonlyArray<object>}}
 */
export function authorizeAll({
  principal,
  ownership = null,
  control = null,
  effects,
  operation = null,
  expectedControlRevision,
  expectedOwnershipRevision,
} = {}) {
  if (!Array.isArray(effects) || effects.length === 0) {
    throw invalid('authorizeAll requires at least one effect', { field: 'effects' });
  }
  const rows = effects.map((effect) => {
    if (!isPlainObject(effect) || !KNOWN_EFFECTS.has(effect.effect) || !KNOWN_RESOURCES.has(effect.resource)) {
      throw invalid('authorizeAll received a malformed effect requirement', { field: 'effects' });
    }
    return requirement(
      effect.effect,
      effect.resource,
      effect.targetRequired === true,
      effect.sourceAccessRequired !== false,
    );
  });
  const ordered = rows.sort((a, b) => EFFECT_STRENGTH[b.effect] - EFFECT_STRENGTH[a.effect]);
  const verdicts = [];
  for (const effect of ordered) {
    const result = authorize({
      principal,
      ownership,
      control,
      effect,
      operation,
      expectedControlRevision,
      expectedOwnershipRevision,
    });
    verdicts.push(result);
    if (!result.allowed) {
      return Object.freeze({ allowed: false, verdict: result, verdicts: Object.freeze(verdicts) });
    }
  }
  return Object.freeze({
    allowed: true,
    verdict: verdicts[0],
    verdicts: Object.freeze(verdicts),
  });
}

/**
 * Project the compatibility `permissions` object of ruling §5 (read/write/close/manage).
 *
 * A single source for the read projection keeps the API surface and any future GUI from
 * re-deriving permissions from legacy `busy`/`owner`/`manageable`, which never described ACLs.
 *
 * @param {{principal:object, ownership:object, control:object}} input
 * @returns {{read:boolean, write:boolean, close:boolean, manage:boolean, canAcquire:boolean}}
 */
export function projectPermissions({ principal, ownership, control } = {}) {
  const base = { principal, ownership, control };
  const read = authorize({ ...base, effect: OBSERVE_PAGE, operation: 'browser_node_state' }).allowed;
  const write = authorize({ ...base, effect: WRITE_PAGE, operation: 'browser_click' }).allowed;
  const close = authorize({ ...base, effect: MANAGE_PAGE, operation: 'browser_tabs.close' }).allowed;
  const manage = authorize({ ...base, effect: MANAGE_PAGE, operation: 'browser_tabs.acquire' }).allowed;
  return Object.freeze({
    read,
    write,
    close,
    manage,
    // "Lead may take this page over" — true only when a takeover is currently possible.
    canAcquire: manage && isPlainObject(control) && control.state === CONTROL_STATE.OWNED,
  });
}
