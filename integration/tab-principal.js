/**
 * Trusted identity resolver: turns one `exec.agent` into a Principal, or refuses (M1).
 *
 * Why this file is separate from `core/tab-access.js`
 * - `core/` answers "given a proven Principal, may this happen?". This file answers "may we believe
 *   this is who it claims to be?" — and that question can only be answered with native Host
 *   services (the Agent registry and the Team roster). Keeping the two apart means the permission
 *   rules are testable with zero Host, and the Host-dependent part has exactly one entry point.
 *
 * The three things this module must never do
 *   1. **Never invent a root.** The root comes from `membership.root.id`. Not from cwd, not from the
 *      workspace, not from `session.header.parentSession`, not from "the deepest ancestor I can
 *      find". A guessed root is a guessed permission domain.
 *   2. **Never degrade `undefined` into `standalone`.** `tryMembership === undefined` means "this
 *      probe could not prove a team" (stale object, non-Team worker, root briefly absent, caught
 *      malformed stream) — it does *not* prove "not in a team". Downgrading it would let a stale
 *      object found a private team of one and keep its pages; the rule is TAB_IDENTITY_UNAVAILABLE.
 *      A standalone domain is only ever granted when the host hands over an explicit proof.
 *   3. **Never call `ctx.get` itself.** Every native service arrives through the injected seam
 *      (`{agentRegistry, teamService, standaloneProof}`), so the host composition root decides what
 *      identity means and tests can drive the matrix in-process without a Cordis context.
 *
 * Epoch bookkeeping (ruling §2.2/§7.1) — all versions here are *plugin* versions, never claimed to
 * be native host revisions:
 *   - `executionEpoch` is per exact agent *object*. Registering a new object (including a
 *     same-Session resume) bumps it; the previous object is revoked forever. A re-used epoch would
 *     let a tail request from the dead instance run against the resumed one.
 *   - `membershipRevision` moves only when the trusted identity state actually changes: a different
 *     root, a different role, a different roster fingerprint, a different service instance, or an
 *     identity that was invalidated and came back. `running`/`inactive` never move it: a teammate
 *     thinking, or a turn ending, is not a membership change (plan §3.4 invariant 1).
 *   - `hostEpoch` is one random id per plugin boot, so nothing minted before a restart can be
 *     compared as current afterwards.
 */

import { randomUUID } from 'node:crypto';

import {
  AdapterError,
  ERROR_CODES,
  PRINCIPAL_ROLE,
  PRINCIPAL_SOURCE,
  makePrincipal,
} from '../core/index.js';

/** Roster row statuses that mean "this Session is not (yet) an acting member". */
const NON_MEMBER_STATUSES = new Set(['failed', 'provisioning']);

function isPlainObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isNonEmptyString(value) {
  return typeof value === 'string' && value.trim().length > 0;
}

/**
 * One refusal code for every unprovable identity.
 *
 * They all collapse into TAB_IDENTITY_UNAVAILABLE on purpose: distinguishing "the object was stale"
 * from "the roster does not list you" from "the root is not loaded" in the *public* code would tell
 * a caller things about another Session's lifecycle. The reason stays in `details` for logs.
 */
function identityUnavailable(reason, details = {}) {
  return new AdapterError(ERROR_CODES.TAB_IDENTITY_UNAVAILABLE, `identity unavailable: ${reason}`, {
    details: Object.freeze({ reason, ...details }),
  });
}

function readNow(now) {
  if (typeof now === 'function') return now();
  if (typeof now === 'number' && Number.isFinite(now)) return now;
  return Date.now();
}

/**
 * Normalize one roster row to "is this a currently valid member?".
 *
 * `running` and `inactive` both mean member: turn availability is orthogonal to membership, and
 * treating "inactive" as "left the team" is the exact bug the plan forbids (an inactive teammate
 * can still be handed responsibility by the Lead). `failed`/`provisioning` are excluded — one never
 * ran, the other broke — and any future status is treated as a member so a host that adds a new
 * runtime state does not silently evict everyone.
 *
 * @param {{id?:string, role?:string, status?:string}} row
 * @returns {boolean}
 */
export function isValidRosterRow(row) {
  if (!isPlainObject(row) || !isNonEmptyString(row.id)) return false;
  if (typeof row.status === 'string' && NON_MEMBER_STATUSES.has(row.status)) return false;
  return true;
}

/**
 * Fingerprint of a roster: the sorted `(SessionId, role)` set of valid rows.
 *
 * This is what makes "did the membership actually change?" answerable without a native revision
 * (the host exposes none). Sorted, so row order is not a change; turn activity is excluded, so a
 * busy team is not a changed team.
 *
 * @param {Array<object>} rows
 * @returns {string}
 */
export function rosterFingerprint(rows) {
  if (!Array.isArray(rows)) return 'none';
  const parts = rows
    .filter(isValidRosterRow)
    .map((row) => `${row.id}|${typeof row.role === 'string' ? row.role : 'unknown'}`)
    .sort();
  return parts.length === 0 ? 'empty' : parts.join(',');
}

/**
 * Identity registry: the stateful half of the resolver.
 *
 * One instance per plugin boot (the default instance below is that one). `hostEpoch` is random, so
 * two boots never produce comparable versions.
 */
export class TabPrincipalResolver {
  /**
   * @param {{hostEpoch?:string, now?:number|Function}} [options]
   */
  constructor({ hostEpoch = randomUUID(), now } = {}) {
    if (!isNonEmptyString(hostEpoch)) {
      throw new AdapterError(ERROR_CODES.INVALID_ARGUMENT, 'hostEpoch must be a non-empty string');
    }
    this.hostEpoch = hostEpoch;
    this.now = typeof now === 'function' ? now : () => readNow(now);
    /** @type {WeakMap<object, object>} exact agent object -> frozen record snapshot */
    this.records = new WeakMap();
    /** @type {WeakSet<object>} agent objects that must never resolve again */
    this.revoked = new WeakSet();
    /** @type {Map<string, object>} actorId -> per-Session bookkeeping (survives object replacement) */
    this.actors = new Map();
  }

  /**
   * Per-actor bookkeeping, created on first sight.
   * @param {string} actorId
   */
  actorState(actorId) {
    let state = this.actors.get(actorId);
    if (state === undefined) {
      state = {
        actorId,
        executionEpoch: 0,
        membershipRevision: 0,
        rootId: null,
        role: null,
        fingerprint: null,
        agentRegistry: null,
        teamService: null,
        activeAgent: null,
        invalidated: false,
      };
      this.actors.set(actorId, state);
    }
    return state;
  }

  /**
   * Permanent invalidation hook for `agent/disposed` (or any teardown the host knows about).
   *
   * The host does not provide a "session permanently deleted" event (ruling §3), so this only ever
   * invalidates the *instance*: the root and the page ownership stay where they are, waiting for a
   * legitimate recovery or an explicit close.
   *
   * @param {object} agent exact agent object
   * @returns {boolean} true when the object was known to this resolver
   */
  invalidate(agent) {
    if (!isPlainObject(agent) || !isNonEmptyString(agent.id)) return false;
    const state = this.actors.get(agent.id);
    this.revoked.add(agent);
    if (state === undefined) return false;
    if (state.activeAgent === agent) {
      state.activeAgent = null;
      // Coming back (a resume with a fresh object) is a trusted-identity state change, so the next
      // resolution bumps membershipRevision and every observation made before is honestly stale.
      state.invalidated = true;
    }
    return true;
  }

  /**
   * Resolve one exact agent into a Principal.
   *
   * @param {object} agent `exec.agent` — the only credential. It is never read from arguments,
   *   headers, query strings or `sessionId` parameters.
   * @param {{agentRegistry?:object, teamService?:object, now?:number|Function,
   *   standaloneProof?:Function}} deps injected native services
   * @returns {Readonly<object>} branded Principal
   * @throws {AdapterError} TAB_IDENTITY_UNAVAILABLE when any step cannot be proven
   */
  resolve(agent, deps = {}) {
    const { agentRegistry, teamService, standaloneProof } = deps;
    const now = readNow(deps.now ?? this.now);

    if (!isPlainObject(agent) || !isNonEmptyString(agent.id)) {
      throw identityUnavailable('agent-identity-missing');
    }
    const actorId = agent.id;
    if (this.revoked.has(agent)) {
      // The object was disposed, replaced, or superseded. It never becomes valid again.
      throw identityUnavailable('actor-instance-revoked', { actorSessionId: actorId });
    }

    // 1. Exact object check. `get(id)` returning a *different* object is the normal shape of a
    //    stale reference; `get(id)` returning undefined means disposed. Both are refusals, never a
    //    "close enough" match on the id string.
    if (!isPlainObject(agentRegistry) || typeof agentRegistry.get !== 'function') {
      throw identityUnavailable('agent-registry-unavailable', { actorSessionId: actorId });
    }
    let registered;
    try {
      registered = agentRegistry.get(actorId);
    } catch (cause) {
      throw new AdapterError(ERROR_CODES.TAB_IDENTITY_UNAVAILABLE, 'identity unavailable: agent-registry-failed', {
        details: { reason: 'agent-registry-failed', actorSessionId: actorId },
        cause,
      });
    }
    if (registered === undefined) {
      throw identityUnavailable('agent-not-registered', { actorSessionId: actorId });
    }
    if (registered !== agent) {
      throw identityUnavailable('agent-object-mismatch', { actorSessionId: actorId });
    }

    // 2. Native membership. `tryMembership` is the non-throwing probe the host documents for
    //    lifecycle observers; `membership` throws TeamError and is the fallback.
    const membership = this.readMembership(teamService, agent);
    let rootId;
    let role;
    let fingerprint;
    let rows = null;

    if (membership === undefined) {
      // No native membership proof. The only acceptable alternative is an explicit host-provided
      // standalone proof; otherwise this is TAB_IDENTITY_UNAVAILABLE, not a new domain.
      const proof = this.readStandaloneProof(standaloneProof, agent, { agentRegistry, teamService });
      if (proof === null) {
        throw identityUnavailable('membership-undefined', { actorSessionId: actorId });
      }
      rootId = actorId;
      role = PRINCIPAL_ROLE.STANDALONE;
      fingerprint = 'standalone';
    } else {
      if (!isPlainObject(membership) || !isPlainObject(membership.root)) {
        throw identityUnavailable('membership-malformed', { actorSessionId: actorId });
      }
      if (membership.role !== PRINCIPAL_ROLE.LEAD && membership.role !== PRINCIPAL_ROLE.TEAMMATE) {
        throw identityUnavailable('membership-role-unknown', {
          actorSessionId: actorId,
          role: typeof membership.role === 'string' ? membership.role : null,
        });
      }
      // 3. The returned root must itself still be the exact registry object. A root that is only
      //    equal by id is a stale or rebuilt object, and permissions derived from it would outlive
      //    the instance that granted them.
      if (!isNonEmptyString(membership.root.id)) {
        throw identityUnavailable('membership-root-missing', { actorSessionId: actorId });
      }
      if (agentRegistry.get(membership.root.id) !== membership.root) {
        throw identityUnavailable('root-object-mismatch', {
          actorSessionId: actorId,
          rootSessionId: membership.root.id,
        });
      }
      rootId = membership.root.id;
      role = membership.role;

      // 4. A teammate additionally needs a *fresh* roster row. Being named in a stale membership is
      //    not enough: a failed/provisioning/removed row must not keep page rights.
      if (role === PRINCIPAL_ROLE.TEAMMATE) {
        rows = this.readRoster(teamService, membership.root, { actorSessionId: actorId, rootSessionId: rootId });
        const row = rows.find((candidate) => isPlainObject(candidate) && candidate.id === actorId);
        if (row === undefined) {
          throw identityUnavailable('teammate-not-in-roster', {
            actorSessionId: actorId,
            rootSessionId: rootId,
          });
        }
        if (!isValidRosterRow(row)) {
          throw identityUnavailable('teammate-row-invalid', {
            actorSessionId: actorId,
            rootSessionId: rootId,
            status: typeof row.status === 'string' ? row.status : null,
          });
        }
      } else {
        // The Lead's own domain: read the roster too, so a membership change moves the revision
        // even when only teammates changed (a transferred page must see that change as stale).
        rows = this.readRoster(teamService, membership.root, { actorSessionId: actorId, rootSessionId: rootId });
      }
      fingerprint = rosterFingerprint(rows);
    }

    // 5. Version bookkeeping.
    const state = this.actorState(actorId);
    const previous = this.records.get(agent);
    let executionEpoch;
    if (previous !== undefined && state.activeAgent === agent) {
      executionEpoch = previous.executionEpoch;
    } else {
      if (state.activeAgent !== null && state.activeAgent !== agent) {
        // A newer instance of the same Session exists: the older object is dead from now on, even
        // if the host later hands it back to us (resume of a resume).
        this.revoked.add(state.activeAgent);
      }
      state.executionEpoch += 1;
      state.activeAgent = agent;
      executionEpoch = state.executionEpoch;
    }

    const identityStateChanged = state.rootId !== rootId
      || state.role !== role
      || state.fingerprint !== fingerprint
      || state.agentRegistry !== (agentRegistry ?? null)
      || state.teamService !== (teamService ?? null)
      || state.invalidated === true;
    if (state.membershipRevision === 0 || identityStateChanged) state.membershipRevision += 1;
    state.rootId = rootId;
    state.role = role;
    state.fingerprint = fingerprint;
    state.agentRegistry = agentRegistry ?? null;
    state.teamService = teamService ?? null;
    state.invalidated = false;

    const record = Object.freeze({
      actorId,
      exactAgent: agent,
      rootId,
      role,
      rosterFingerprint: fingerprint,
      membershipRevision: state.membershipRevision,
      executionEpoch,
      source: PRINCIPAL_SOURCE.AGENT,
      hostEpoch: this.hostEpoch,
      status: 'active',
      resolvedAt: now,
    });
    this.records.set(agent, record);

    return makePrincipal({
      actorSessionId: actorId,
      rootSessionId: rootId,
      role,
      membershipRevision: record.membershipRevision,
      executionEpoch: record.executionEpoch,
      source: PRINCIPAL_SOURCE.AGENT,
      hostEpoch: record.hostEpoch,
    });
  }

  /**
   * Last resolved record for one agent object (diagnostics only; never an authorisation input).
   * @param {object} agent
   * @returns {Readonly<object>|null}
   */
  recordFor(agent) {
    if (!isPlainObject(agent)) return null;
    return this.records.get(agent) ?? null;
  }

  /**
   * Content-free summary for readiness/diagnostics: no ids, no roster, just counters and the boot.
   * @returns {{hostEpoch:string, actors:number}}
   */
  summary() {
    return { hostEpoch: this.hostEpoch, actors: this.actors.size };
  }

  /**
   * Call the native membership probe.
   *
   * @returns {object|undefined} the membership, or undefined when the host could not prove one
   */
  readMembership(teamService, agent) {
    if (!isPlainObject(teamService)) return undefined;
    const { tryMembership, membership } = teamService;
    if (typeof tryMembership === 'function') {
      try {
        return tryMembership.call(teamService, agent);
      } catch {
        // A throwing probe is "could not prove", not "proved false".
        return undefined;
      }
    }
    if (typeof membership === 'function') {
      try {
        return membership.call(teamService, agent);
      } catch {
        return undefined;
      }
    }
    return undefined;
  }

  /**
   * Refresh the roster from the native service. Missing or throwing service ⇒ refusal, because an
   * unreadable roster cannot establish that a teammate is still one.
   *
   * @returns {Array<object>}
   */
  readRoster(teamService, rootAgent, context) {
    if (!isPlainObject(teamService) || typeof teamService.listMembers !== 'function') {
      throw identityUnavailable('roster-unavailable', context);
    }
    let rows;
    try {
      rows = teamService.listMembers.call(teamService, rootAgent);
    } catch (cause) {
      throw new AdapterError(ERROR_CODES.TAB_IDENTITY_UNAVAILABLE, 'identity unavailable: roster-failed', {
        details: { reason: 'roster-failed', ...context },
        cause,
      });
    }
    if (!Array.isArray(rows)) throw identityUnavailable('roster-malformed', context);
    return rows;
  }

  /**
   * Explicit standalone proof.
   *
   * The ruling allows a standalone domain only when the *host* says so (there is no native Team
   * service to ask). The proof is a callback, never a parameter a model can fill in: it must return
   * a truthy value, and if it names a root that root must be the actor itself.
   *
   * @returns {string|null} the proved root id, or null when there is no proof
   */
  readStandaloneProof(standaloneProof, agent, context) {
    if (typeof standaloneProof !== 'function') return null;
    let proof;
    try {
      proof = standaloneProof(agent, context);
    } catch {
      return null;
    }
    if (proof === false || proof === null || proof === undefined) return null;
    if (proof === true) return agent.id;
    if (typeof proof === 'string') return proof === agent.id ? proof : null;
    if (isPlainObject(proof)) {
      const root = proof.rootSessionId;
      if (root === undefined) return agent.id;
      return root === agent.id ? root : null;
    }
    return null;
  }
}

/**
 * Process-wide resolver used by `resolvePrincipal` when no instance is injected.
 *
 * One instance per boot is the point: `hostEpoch` must not change between two calls of the same
 * process, otherwise every observation would be "stale" the moment it is compared.
 */
const DEFAULT_RESOLVER = new TabPrincipalResolver();

/**
 * Resolve one `exec.agent` into a Principal through the injected seam.
 *
 * Deliberately a plain function with explicit dependencies: the Host composition root passes
 * `{agentRegistry, teamService, now}` (and, only if the host really has no Team service, an
 * explicit `standaloneProof`), and tests pass fakes. Nothing here reaches for a Cordis context.
 *
 * @param {object} agent
 * @param {{agentRegistry?:object, teamService?:object, now?:number|Function,
 *   standaloneProof?:Function, identityResolver?:TabPrincipalResolver}} [deps]
 * @returns {Readonly<object>} branded Principal
 * @throws {AdapterError} TAB_IDENTITY_UNAVAILABLE (or INVALID_ARGUMENT for a malformed seam)
 */
export function resolvePrincipal(agent, deps = {}) {
  const resolver = deps.identityResolver ?? DEFAULT_RESOLVER;
  if (typeof resolver?.resolve !== 'function') {
    throw new AdapterError(ERROR_CODES.INVALID_ARGUMENT, 'identityResolver must expose resolve()');
  }
  return resolver.resolve(agent, deps);
}

/**
 * Create an independent resolver (one per plugin boot).
 * @param {{hostEpoch?:string, now?:number|Function}} [options]
 * @returns {TabPrincipalResolver}
 */
export function createTabPrincipalResolver(options = {}) {
  return new TabPrincipalResolver(options);
}

/** The process-wide instance, for Host wiring that needs `invalidate()` on agent/disposed. */
export function defaultTabPrincipalResolver() {
  return DEFAULT_RESOLVER;
}
