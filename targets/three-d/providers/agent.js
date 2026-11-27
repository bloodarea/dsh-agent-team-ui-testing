import { ProviderError, assertContract, canonical, sha256, snapshot } from './contracts.js';
import { intersectBudgets } from './budget.js';

function deny(reason) { throw new ProviderError('PRIVACY_POLICY_DENIED', reason); }
const roleIds = new Set(['vision_analyst', 'vision_reviewer', 'modeling_executor']);
export class AgentProviderAdapter {
  constructor({ providerId, discover, dispatch, validateGrant, structuredFieldWhitelist = [], clock = Date.now }) {
    if (typeof discover !== 'function' || typeof dispatch !== 'function' || typeof validateGrant !== 'function') throw new TypeError('Host discover, dispatch and validateGrant functions are required');
    this.providerId = providerId; this.discover = discover; this.dispatch = dispatch; this.validateGrant = validateGrant;
    this.structuredFieldWhitelist = new Set(structuredFieldWhitelist); this.clock = clock;
  }
  async health() {
    const members = await this.discover();
    return { available: Array.isArray(members) && members.length > 0, reason: members?.length ? null : 'agent-team-not-configured' };
  }
  async invokeRole(request, { profile, binding, scope, grant = null, signal, ledger } = {}) {
    assertContract('agentRoleRequest', request); assertContract('capabilityProfile', profile);
    if (!roleIds.has(request.roleId) || !binding || profile.agentRoleBindings[request.roleId] !== binding.memberId) deny('agent-role-not-bound');
    if (request.round === 1 && request.peerResults.length) deny('independent-first-round-peer-leak');
    if (!profile.privacy.allowRemoteInference) deny('privacy-policy-denied');
    if (signal?.aborted) throw signal.reason;
    const members = await this.discover();
    if (!members.some(m => m.memberId === binding.memberId && m.modelId === binding.modelId)) deny('agent-binding-not-discovered');
    const allowedArtifacts = request.inputArtifactRefs;
    if (allowedArtifacts.some(ref => !request.sourceArtifactRefs.some(source => source.artifactId === ref.artifactId && source.sha256 === ref.sha256))) deny('agent-artifact-outside-source-set');
    if (allowedArtifacts.length) {
      if (!profile.privacy.allowImageUploadToAgent || !grant || grant.grantId !== request.privacyGrantRef || grant.scope !== 'artifact:remote-inference' || grant.issuer !== 'human-ui' || grant.principalId !== scope?.principalId || grant.workspaceId !== scope?.workspaceId || grant.taskId !== request.taskId || grant.providerId !== this.providerId || Date.parse(grant.expiresAt) <= this.clock() || !grant.retention || !grant.allowedInputTypes?.length || allowedArtifacts.some(ref => !grant.artifactIds?.includes(ref.artifactId))) deny('remote-inference-grant-required');
      if (await this.validateGrant(grant, { ...scope, taskId: request.taskId, providerId: this.providerId, artifactIds: allowedArtifacts.map(a => a.artifactId), now: this.clock() }) !== true) deny('remote-inference-grant-invalid-or-revoked');
    }
    const structuredContext = request.structuredContext.filter(item => this.structuredFieldWhitelist.has(item.field));
    // Unlisted fields, raw images, base64 and hidden attachments are never forwarded.
    if (structuredContext.some(item => typeof item.value === 'string' && /(?:data:[^;]+;base64,|\bbase64\b)/i.test(item.value))) deny('reversible-image-content-denied');
    if (!ledger) throw new ProviderError('RESOURCE_BUDGET_EXCEEDED', 'agent-budget-ledger-required');
    const effectiveBudget = intersectBudgets(profile.budget, request.budget);
    if (sha256(intersectBudgets(effectiveBudget, ledger.limits)) !== sha256(ledger.limits)) throw new ProviderError('CAPABILITY_POLICY_CONFLICT', 'agent-budget-policy-mismatch');
    const runId = `agent-${sha256({ roleId: request.roleId, taskId: request.taskId, round: request.round, binding }).slice(0, 24)}`;
    const estimate = binding.estimate;
    // One reservation per role and round; a retry must use an explicit new request round.
    ledger.reserve(runId, estimate);
    let recorded = false;
    try {
      // Grant is checked immediately before dispatch; Host validateGrant owns authenticity/revocation.
      if (allowedArtifacts.length && await this.validateGrant(grant, { ...scope, taskId: request.taskId, providerId: this.providerId, artifactIds: allowedArtifacts.map(a => a.artifactId), now: this.clock() }) !== true) deny('remote-inference-grant-invalid-or-revoked');
      if (signal?.aborted) throw signal.reason;
      const payload = snapshot({ ...request, budget: ledger.limits, structuredContext });
      const controller = new AbortController();
      const forwardAbort = () => controller.abort(signal.reason);
      signal?.addEventListener('abort', forwardAbort, { once: true });
      if (signal?.aborted) forwardAbort();
      const remaining = ledger.remainingWallMs();
      let timer;
      if (remaining != null) timer = setTimeout(() => controller.abort(new ProviderError('PROVIDER_TIMEOUT', 'provider-timeout')), remaining);
      let result;
      try {
        const aborted = new Promise((_, reject) => { if (controller.signal.aborted) reject(controller.signal.reason); else controller.signal.addEventListener('abort', () => reject(controller.signal.reason), { once: true }); });
        result = await Promise.race([Promise.resolve().then(() => this.dispatch({ binding: snapshot({ memberId: binding.memberId, modelId: binding.modelId }), request: payload, signal: controller.signal })), aborted]);
      } finally { clearTimeout(timer); signal?.removeEventListener('abort', forwardAbort); }
      // Account for even malformed responses before rejecting their structure.
      recorded = true; ledger.complete(runId, result?.usage ?? { metering: 'not-metered' });
      assertContract('agentRoleResult', result);
      if (result.roleId !== request.roleId || result.taskId !== request.taskId) throw new ProviderError('PROVIDER_OUTPUT_INVALID', 'agent-result-identity-mismatch');
      return snapshot(result);
    } finally {
      if (!recorded) { try { ledger.complete(runId, { metering: 'not-metered' }); } catch { /* Preserve the original dispatch or schema failure. */ } }
    }
  }
}
export class IndependentReviewSession {
  #requests; #results = new Map(); #bindings;
  constructor({ analystBinding, reviewerBinding, request }) {
    assertContract('agentRoleRequest', { ...request, roleId: 'vision_analyst', round: 1, peerResults: [] });
    this.#bindings = snapshot({ analyst: analystBinding, reviewer: reviewerBinding });
    const common = { ...request, round: 1, peerResults: [] };
    this.#requests = snapshot({ analyst: { ...common, roleId: 'vision_analyst' }, reviewer: { ...common, roleId: 'vision_reviewer' } });
  }
  get independent() {
    const { analyst, reviewer } = this.#bindings;
    return Boolean(analyst?.memberId && reviewer?.memberId && analyst?.modelId && reviewer?.modelId && analyst.memberId !== reviewer.memberId && analyst.modelId !== reviewer.modelId);
  }
  get firstRoundRequests() { return this.#requests; }
  recordFirstRound(role, result) {
    if (!['analyst', 'reviewer'].includes(role) || this.#results.has(role)) throw new ProviderError('CAPABILITY_POLICY_CONFLICT', 'first-round-result-immutable');
    assertContract('agentRoleResult', result);
    if (result.roleId !== this.#requests[role].roleId || result.taskId !== this.#requests[role].taskId) throw new ProviderError('PROVIDER_OUTPUT_INVALID', 'agent-result-identity-mismatch');
    this.#results.set(role, snapshot(result)); return sha256(result);
  }
  getFirstRoundResults() {
    // Do not expose a peer's result until both independent submissions are locked.
    if (this.#results.size !== 2) throw new ProviderError('CAPABILITY_POLICY_CONFLICT', 'independent-first-round-incomplete');
    return snapshot(Object.fromEntries(['analyst', 'reviewer'].map(role => [role, this.#results.get(role)])));
  }
  reconciliationRequests() {
    if (this.#results.size !== 2) throw new ProviderError('CAPABILITY_POLICY_CONFLICT', 'independent-first-round-incomplete');
    if ([...this.#results.values()].some(r => r.status === 'failed')) throw new ProviderError('CAPABILITY_POLICY_CONFLICT', 'independent-first-round-failed');
    return snapshot({ independent: this.independent, firstRoundHashes: [...this.#results.values()].map(sha256), requests: Object.fromEntries(['analyst', 'reviewer'].map(role => [role, { ...this.#requests[role], round: 2, peerResults: [JSON.stringify(this.#results.get(role === 'analyst' ? 'reviewer' : 'analyst'))] }])) });
  }
}

const reviewDimensions = Object.freeze(['objectSplit', 'partCount', 'relativePosition', 'geometryClass', 'dimensionAssumption', 'unknowns']);
const isRecord = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const nonblank = value => typeof value === 'string' && value.trim().length > 0;
const unknownValue = value => value == null || (typeof value === 'string' && (!value.trim() || value.trim().toLowerCase() === 'unknown')) || (isRecord(value) && value.status === 'unknown');
function invalidReview(reason) { throw new ProviderError('PROVIDER_OUTPUT_INVALID', reason); }

function checkFirstRound(result, roleId) {
  if (!isRecord(result)) invalidReview('first-round-observation-required');
  // Native role results retain their existing closed schema. Plain dimension maps
  // can also be compared without fabricating provider usage or evidence metadata.
  if (Object.hasOwn(result, 'proposals') || Object.hasOwn(result, 'roleId')) {
    assertContract('agentRoleResult', result);
    if (result.roleId !== roleId) invalidReview('agent-result-identity-mismatch');
    if (result.status === 'failed') throw new ProviderError('CAPABILITY_POLICY_CONFLICT', 'independent-first-round-failed');
  }
}

function dimensionObservation(result, dimension) {
  const proposals = Array.isArray(result.proposals) && dimension !== 'unknowns';
  const value = proposals ? result.proposals.filter(proposal => proposal.field === dimension) : result[dimension];
  const items = proposals ? value : [value];
  const known = item => !unknownValue(proposals ? item.value : item) && !(Array.isArray(proposals ? item.value : item) && (proposals ? item.value : item).length === 0 && dimension !== 'unknowns');
  return {
    value,
    items,
    known: items.some(known),
    hasUnknown: items.length === 0 || items.some(item => !known(item)),
    key: item => canonical(proposals ? { targetHint: item.targetHint, value: item.value, units: item.units } : item),
    rule: proposals ? 'same-target-value-and-units' : 'structural-equality',
  };
}

function compareDimension(dimension, analyst, reviewer) {
  const a = dimensionObservation(analyst, dimension), r = dimensionObservation(reviewer, dimension);
  const unmatched = r.items.map((value, index) => ({ value, index, key: r.key(value) }));
  const matches = [], analystOnly = [];
  for (const value of a.items) {
    const index = unmatched.findIndex(item => item.key === a.key(value));
    if (index === -1) analystOnly.push(value);
    else { const [peer] = unmatched.splice(index, 1); matches.push({ analyst: value, reviewer: peer.value }); }
  }
  const reviewerOnly = unmatched.map(item => item.value);
  const status = !a.known && !r.known ? 'both-unknown' : a.known !== r.known ? 'one-sided' : analystOnly.length || reviewerOnly.length ? 'differ' : 'agree';
  return {
    dimension, status, analyst: a.value, reviewer: r.value,
    agreement: { rule: a.rule, analystKnown: a.known, reviewerKnown: r.known, hasUnknown: a.hasUnknown || r.hasUnknown, matches, analystOnly, reviewerOnly },
  };
}

/**
 * Compare immutable first-round role results, or maps keyed by dimension.
 * dimensions extends (never removes) the six required dimensions. Proposal
 * order and evidence/confidence metadata do not decide value agreement; all
 * original proposals and metadata remain available on both sides and firstRound.
 */
export function buildDifferenceReport(analyst, reviewer, { dimensions = [] } = {}) {
  checkFirstRound(analyst, 'vision_analyst'); checkFirstRound(reviewer, 'vision_reviewer');
  if (analyst.taskId != null && reviewer.taskId != null && analyst.taskId !== reviewer.taskId) invalidReview('agent-result-identity-mismatch');
  if (!Array.isArray(dimensions) || dimensions.some(dimension => !nonblank(dimension))) invalidReview('difference-dimensions-invalid');
  const firstRound = snapshot({ analyst, reviewer });
  const entries = [...new Set([...reviewDimensions, ...dimensions])].map(dimension => compareDimension(dimension, firstRound.analyst, firstRound.reviewer));
  const conflicts = entries.filter(entry => entry.status === 'differ');
  const candidates = entries.filter(entry => entry.status === 'differ' || entry.status === 'one-sided' || (entry.status === 'agree' && entry.agreement.hasUnknown));
  const preservedUnknowns = entries.filter(entry => entry.agreement.hasUnknown || (entry.dimension === 'unknowns' && (entry.analyst?.length || entry.reviewer?.length)));
  return snapshot({ dimensions: entries, conflicts, candidates, preservedUnknowns, firstRound, firstRoundImmutable: true });
}

/**
 * Apply one named human adjudication, or a batch. chosen may be an explicit
 * value or the side selector 'analyst'/'reviewer'; basis must be nonblank.
 * The caller authenticates the human; this pure function requires their ID
 * (a nonblank string or { id }) and records it with every decision.
 */
export function resolveDisagreement(report, adjudication, { adjudicator } = {}) {
  const identity = typeof adjudicator === 'string' ? adjudicator : adjudicator?.id;
  if (!nonblank(identity)) throw new ProviderError('AUTHORIZATION_REQUIRED', 'adjudicator-identity-required');
  if (!isRecord(report) || report.firstRoundImmutable !== true || !isRecord(report.firstRound) || !Array.isArray(report.dimensions)) invalidReview('difference-report-required');
  if (Object.hasOwn(report, 'secondRound')) throw new ProviderError('CAPABILITY_POLICY_CONFLICT', 'second-round-already-recorded');
  // Recompute from the originals so a serialized/modified status cannot silently
  // turn an unresolved conflict into agreement during adjudication.
  const base = buildDifferenceReport(report.firstRound.analyst, report.firstRound.reviewer, { dimensions: report.dimensions.map(entry => entry.dimension) });
  const decisions = new Map();
  for (const decision of Array.isArray(adjudication) ? adjudication : [adjudication]) {
    if (!isRecord(decision) || !nonblank(decision.dimension) || !Object.hasOwn(decision, 'chosen') || !nonblank(decision.basis)) invalidReview('adjudication-dimension-chosen-and-basis-required');
    if (!base.dimensions.some(entry => entry.dimension === decision.dimension)) invalidReview('adjudication-dimension-unknown');
    if (decisions.has(decision.dimension)) invalidReview('duplicate-dimension-adjudication');
    decisions.set(decision.dimension, snapshot({ dimension: decision.dimension, chosen: decision.chosen, basis: decision.basis, adjudicator }));
  }
  const dimensions = base.dimensions.map(entry => {
    const decision = decisions.get(entry.dimension);
    if (decision) {
      const side = decision.chosen === 'analyst' || decision.chosen === 'reviewer' ? decision.chosen : null;
      const value = side ? entry[side] : decision.chosen;
      const observation = side ? dimensionObservation(base.firstRound[side], entry.dimension) : dimensionObservation({ [entry.dimension]: value }, entry.dimension);
      const status = !observation.known || observation.hasUnknown || (entry.dimension === 'unknowns' && value?.length) ? 'unknown' : 'adjudicated';
      return { dimension: entry.dimension, status, value, adjudication: decision };
    }
    const status = entry.status === 'both-unknown' || (entry.dimension === 'unknowns' && (entry.analyst?.length || entry.reviewer?.length)) ? 'unknown' : entry.status === 'agree' && !entry.agreement.hasUnknown ? 'agreed' : 'candidates';
    return { dimension: entry.dimension, status, value: status === 'agreed' ? entry.analyst : null, adjudication: null };
  });
  const determined = new Set(dimensions.filter(entry => entry.status === 'adjudicated').map(entry => entry.dimension));
  const candidates = base.candidates.filter(entry => !determined.has(entry.dimension));
  const preservedUnknowns = base.preservedUnknowns.filter(entry => !determined.has(entry.dimension));
  for (const entry of dimensions) {
    if (entry.adjudication && entry.status === 'unknown' && !preservedUnknowns.some(item => item.dimension === entry.dimension)) preservedUnknowns.push({ ...base.dimensions.find(item => item.dimension === entry.dimension), adjudication: entry.adjudication });
  }
  return snapshot({ ...base, candidates, preservedUnknowns, secondRound: { adjudicator, dimensions, candidates, preservedUnknowns } });
}
