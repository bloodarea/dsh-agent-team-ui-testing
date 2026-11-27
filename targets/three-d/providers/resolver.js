import { randomUUID } from 'node:crypto';
import { CAPABILITY_IDS, ProviderError, assertContract, sha256, snapshot } from './contracts.js';
import { aggregateUsage, budgetViolations, intersectBudgets } from './budget.js';

export function createProfile(profileId = 'economy', overrides = {}) {
  if (!['economy', 'balanced', 'advanced', 'custom'].includes(profileId)) throw new ProviderError('CAPABILITY_POLICY_CONFLICT', 'unknown-profile');
  const base = {
    profileId, profileRevision: 0, enabledProviderIds: [], disabledProviderIds: [], providerPriority: [], providerPins: [],
    agentRoleBindings: { modeling_executor: 'current-agent', vision_analyst: null, vision_reviewer: null },
    operationTierPolicy: { allowedTiers: ['P0', 'T1', 'T2', 'T3', 'T4'], preferredTiers: [], allowSkip: true },
    expertEscalation: { mode: 'on-demand', triggers: ['low-confidence', 'conflicting-evidence', 'high-complexity', 'high-risk'] },
    privacy: { allowLocalInference: true, allowRemoteInference: false, allowImageUploadToAgent: false },
    budget: { maxRemoteRequests: 0, maxWallMs: 120000, maxConcurrentProviders: 1 }, fallbackPolicy: 'degrade-optional',
  };
  const result = { ...base, ...overrides, privacy: { ...base.privacy, ...overrides.privacy }, budget: { ...base.budget, ...overrides.budget }, operationTierPolicy: { ...base.operationTierPolicy, ...overrides.operationTierPolicy }, agentRoleBindings: { ...base.agentRoleBindings, ...overrides.agentRoleBindings }, expertEscalation: { ...base.expertEscalation, ...overrides.expertEscalation } };
  assertContract('capabilityProfile', result); return snapshot(result);
}
function rank(profile, candidate) {
  const priority = profile.providerPriority.indexOf(candidate.providerId);
  const tierPriority = profile.operationTierPolicy.preferredTiers.indexOf(candidate.route.operationTier);
  const estimate = candidate.descriptor.resourceEstimate.values;
  return [priority < 0 ? Number.MAX_SAFE_INTEGER : priority, candidate.quality === 'verified' ? 0 : 1, tierPriority < 0 ? 99 : tierPriority, ...['actualMoney', 'requestCount', 'wallMs', 'ramPeakBytes', 'vramPeakBytes'].map(k => estimate[k] ?? Number.MAX_SAFE_INTEGER), candidate.providerId, candidate.route.operationTier, candidate.route.toolId, candidate.route.opId];
}
function compare(a, b) { for (let i = 0; i < a.length; i++) { if (a[i] < b[i]) return -1; if (a[i] > b[i]) return 1; } return 0; }
export class CapabilityResolver {
  constructor(registry, { clock = () => new Date().toISOString(), planTtlMs = 300000 } = {}) { this.registry = registry; this.clock = clock; this.planTtlMs = planTtlMs; }
  resolve(profile, request, { inputRefs = [], validateInput = () => false, resourceSnapshot = {}, previousPlan = null, revisionReason = null } = {}) {
    assertContract('capabilityProfile', profile); assertContract('taskCapabilityRequest', request);
    if (previousPlan) {
      assertContract('capabilityExecutionPlan', previousPlan);
      const { planHash, ...oldBody } = previousPlan;
      if (planHash !== sha256(oldBody) || previousPlan.taskId !== request.taskId) throw new ProviderError('CAPABILITY_POLICY_CONFLICT', 'previous-plan-invalid');
      if (Date.parse(previousPlan.expiresAt) <= Date.parse(this.clock())) throw new ProviderError('CAPABILITY_POLICY_CONFLICT', 'previous-plan-expired');
    }
    inputRefs.forEach(ref => assertContract('inputRef', ref));
    for (const artifactId of request.inputArtifactIds) {
      const ref = inputRefs.find(r => r.artifactId === artifactId);
      if (!ref || validateInput(ref, { taskId: request.taskId }) !== true) throw new ProviderError('PRIVACY_POLICY_DENIED', 'input-artifact-not-authorized', { artifactId });
    }
    const budgetSnapshot = intersectBudgets(profile.budget, request.budget);
    const providers = this.registry.list(); const selectedProviders = [], stageGraph = [], unresolved = [], estimates = [];
    const requirements = new Map();
    for (const [kind, ids] of [['optional', request.optionalCapabilities], ['preferred', request.preferredCapabilities], ['required', request.requiredCapabilities]]) for (const id of ids) requirements.set(id, kind);
    const resolving = new Set(), resolved = new Map();
    const reject = (capabilityId, requirement, reason) => { unresolved.push({ capabilityId, requirement, reason }); resolved.set(capabilityId, null); return null; };
    const policyReasons = new Set(['provider-disabled', 'operation-tier-denied', 'privacy-policy-denied', 'resource-budget-exceeded', 'expert-escalation-disabled', 'independent-review-not-configured']);
    const resolveCapability = (capabilityId, requirement) => {
      if (resolved.has(capabilityId)) return resolved.get(capabilityId);
      if (resolving.has(capabilityId)) throw new ProviderError('CAPABILITY_POLICY_CONFLICT', 'capability-dependency-cycle');
      resolving.add(capabilityId);
      try {
        if (!CAPABILITY_IDS.includes(capabilityId)) return reject(capabilityId, requirement, 'unknown-provider-capability');
        if (capabilityId.startsWith('agent.vision.') && profile.expertEscalation.mode === 'never') return reject(capabilityId, requirement, 'expert-escalation-disabled');
        if (capabilityId === 'agent.vision.review' && request.requiresIndependentReview) {
          const a = profile.agentRoleBindings.vision_analyst, b = profile.agentRoleBindings.vision_reviewer;
          if (!a || !b || a === b) return reject(capabilityId, requirement, 'independent-review-not-configured');
        }
        const pin = profile.providerPins.find(p => p.capabilityId === capabilityId)?.providerId;
        const tier = request.routes?.find(r => r.capabilityId === capabilityId)?.operationTier;
        const explicit = request.stages?.find(s => s.capabilityId === capabilityId);
        const candidates = []; const reasons = [];
        for (const p of providers) {
          const descriptor = p.manifest.capabilities.find(c => c.capabilityId === capabilityId); if (!descriptor || (pin && p.providerId !== pin)) continue;
          let reason = null;
          if (!profile.enabledProviderIds.includes(p.providerId) || profile.disabledProviderIds.includes(p.providerId) || !p.enabled) reason = 'provider-disabled';
          else if (p.support !== 'supported' || p.availability !== 'available') reason = p.reason ?? 'provider-unavailable';
          else if (request.qualityTarget === 'verified' && p.quality !== 'verified') reason = 'provider-quality-unverified';
          else if ((p.manifest.runtime.mode !== 'remote' && !profile.privacy.allowLocalInference) || (p.manifest.privacy.inputsLeaveMachine && !profile.privacy.allowRemoteInference)) reason = 'privacy-policy-denied';
          const estimate = descriptor.resourceEstimate.values;
          if (!reason && budgetViolations(budgetSnapshot, estimate).length) reason = 'resource-budget-exceeded';
          for (const [resource, field] of [['ramAvailableBytes', 'ramPeakBytes'], ['vramAvailableBytes', 'vramPeakBytes'], ['diskAvailableBytes', 'diskBytes']]) if (!reason && resourceSnapshot[resource] != null && (estimate[field] == null || estimate[field] > resourceSnapshot[resource])) reason = 'resource-budget-exceeded';
          if (reason) { reasons.push(reason); continue; }
          for (const route of descriptor.routes) {
            if ((tier && route.operationTier !== tier) || !profile.operationTierPolicy.allowedTiers.includes(route.operationTier)) { reasons.push('operation-tier-denied'); continue; }
            // Tier is a direct choice. No T1 -> T2 -> T3 -> T4 prerequisite is inferred.
            candidates.push({ providerId: p.providerId, provider: p, descriptor, route, quality: p.quality });
          }
        }
        candidates.sort((a, b) => compare(rank(profile, a), rank(profile, b)));
        if (!candidates.length) return reject(capabilityId, requirement, reasons.find(r => policyReasons.has(r)) ?? reasons[0] ?? 'provider-not-installed');
        let chosen = null;
        for (const candidate of candidates) {
          const estimate = aggregateUsage([...estimates, candidate.descriptor.resourceEstimate.values]);
          if (!budgetViolations(budgetSnapshot, estimate).length) { chosen = candidate; break; }
        }
        if (!chosen) return reject(capabilityId, requirement, 'resource-budget-exceeded');
        const dependencies = [];
        for (const dependency of chosen.descriptor.dependsOn) {
          const stageId = resolveCapability(dependency, requirement);
          if (!stageId) return reject(capabilityId, requirement, 'capability-dependency-unresolved');
          dependencies.push(stageId);
        }
        // Dependencies may consume budget after the candidate was first considered.
        if (budgetViolations(budgetSnapshot, aggregateUsage([...estimates, chosen.descriptor.resourceEstimate.values])).length) return reject(capabilityId, requirement, 'resource-budget-exceeded');
        const m = chosen.provider.manifest;
        const stageId = explicit?.stageId ?? `stage-${stageGraph.length + 1}`;
        selectedProviders.push({ providerId: m.providerId, capabilityId, implementationVersion: m.implementationVersion, modelVersions: m.modelAssets.map(a => a.modelVersion).filter(Boolean), weightsSha256: m.modelAssets.map(a => a.sha256).filter(Boolean), manifestSha256: chosen.provider.manifestSha256, selectionReason: pin ? 'user-pin' : 'user-priority-quality-cost' });
        stageGraph.push({ stageId, capabilityId, providerId: m.providerId, ...chosen.route, dependencies: [...new Set([...dependencies, ...explicit?.dependencies ?? []])], inputRefs: explicit?.inputRefs ?? inputRefs, inputSchemaRef: chosen.descriptor.inputSchemaRef, outputSchemaRef: chosen.descriptor.outputSchemaRef, configSha256: explicit?.configSha256 ?? sha256({}), budget: budgetSnapshot, requirement });
        estimates.push(chosen.descriptor.resourceEstimate.values); resolved.set(capabilityId, stageId); return stageId;
      } finally { resolving.delete(capabilityId); }
    };
    // Reserve required capability budgets first, so optional paths never starve required work.
    for (const kind of ['required', 'preferred', 'optional']) for (const [id, req] of requirements) if (req === kind) resolveCapability(id, req);
    const stageIds = new Set(stageGraph.map(s => s.stageId));
    if (stageIds.size !== stageGraph.length) throw new ProviderError('CAPABILITY_POLICY_CONFLICT', 'duplicate-stage-id');
    const visiting = new Set(), visited = new Set();
    const visit = id => { if (!stageIds.has(id)) throw new ProviderError('CAPABILITY_POLICY_CONFLICT', 'stage-dependency-missing'); if (visiting.has(id)) throw new ProviderError('CAPABILITY_POLICY_CONFLICT', 'stage-dependency-cycle'); if (visited.has(id)) return; visiting.add(id); for (const dep of stageGraph.find(s => s.stageId === id).dependencies) visit(dep); visiting.delete(id); visited.add(id); };
    stageGraph.forEach(s => { s.inputRefs.forEach(ref => { if (!inputRefs.some(input => sha256(input) === sha256(ref)) || validateInput(ref, { taskId: request.taskId }) !== true) throw new ProviderError('PRIVACY_POLICY_DENIED', 'stage-input-not-authorized'); }); visit(s.stageId); });
    const requiredMissing = unresolved.some(u => u.requirement === 'required');
    const status = requiredMissing || (unresolved.length && profile.fallbackPolicy === 'none') ? 'blocked' : unresolved.length && profile.fallbackPolicy === 'ask-user' ? 'awaiting-user' : 'ready';
    const createdAt = this.clock();
    const body = { contractVersion: 1, planId: randomUUID(), revision: previousPlan ? previousPlan.revision + 1 : 0, previousPlanHash: previousPlan?.planHash ?? null, revisionReason: previousPlan ? revisionReason ?? 'explicit-reroute' : null, taskId: request.taskId, profileId: profile.profileId, profileRevision: profile.profileRevision, requestHash: sha256(request), selectedProviders, stageGraph, budgetSnapshot, privacySnapshot: profile.privacy, estimatedCost: { values: aggregateUsage(estimates), estimateSource: 'manifest-resource-estimates', confidenceRange: null, measuredAt: null, unknowns: Object.entries(aggregateUsage(estimates)).filter(([, v]) => v == null).map(([k]) => k) }, unresolved, status, createdAt, expiresAt: new Date(Date.parse(createdAt) + this.planTtlMs).toISOString() };
    const plan = { ...body, planHash: sha256(body) }; assertContract('capabilityExecutionPlan', plan);
    const diagnostics = [...profile.enabledProviderIds, ...profile.disabledProviderIds].filter(id => !providers.some(p => p.providerId === id)).map(providerId => ({ providerId, reason: 'unknown-provider' }));
    return snapshot({ plan, diagnostics, code: requiredMissing && unresolved.some(u => policyReasons.has(u.reason)) ? 'CAPABILITY_POLICY_CONFLICT' : null });
  }
}
