import { randomUUID } from 'node:crypto';
import { CAPABILITY_IDS, ProviderError, assertContract, sha256, snapshot, validateManifest } from './contracts.js';

const installed = state => ['bundled', 'installed'].includes(state.installation);
const verified = proof => proof.status === 'passed' && proof.evidenceRefs.length > 0 && Boolean(proof.checkedAt);
export class ProviderRegistry {
  #entries = new Map(); #executions = new Map(); #outputValidators; #platform; #clock;
  constructor({ outputValidators = {}, platform = process.platform, clock = () => new Date().toISOString() } = {}) {
    this.#outputValidators = { ...outputValidators }; this.#platform = platform; this.#clock = clock;
  }
  register(manifest, adapter = null, { installation = 'not-installed', enabled = false, extensionValidator } = {}) {
    const validated = validateManifest(manifest, { extensionValidator }); const copy = validated.manifest;
    if (this.#entries.has(copy.providerId)) throw new ProviderError('CAPABILITY_POLICY_CONFLICT', 'provider-already-registered');
    if (!['bundled', 'installed', 'not-installed', 'failed'].includes(installation)) throw new ProviderError('PROVIDER_OUTPUT_INVALID', 'invalid-installation-state');
    const state = { providerId: copy.providerId, support: copy.support, installation, enabled, availability: 'not-probed', quality: verified(copy.verification.smoke) && verified(copy.verification.conformance) ? 'verified' : 'unverified', reason: 'not-probed', checkedAt: this.#clock(), retryAfter: null, runningCount: 0, lifecycle: 'validated' };
    // Adapter is a host-supplied object. Manifest entrypoint is never imported or executed.
    this.#entries.set(copy.providerId, { manifest: copy, adapter, state, diagnostics: validated.diagnostics, runs: new Map() });
    this.#baseReason(this.#entries.get(copy.providerId)); return this.get(copy.providerId);
  }
  #entry(id) { const entry = this.#entries.get(id); if (!entry) throw new ProviderError('PROVIDER_NOT_INSTALLED', 'provider-not-installed', { providerId: id }); return entry; }
  #baseReason(entry) {
    const { manifest: m, state: s, adapter } = entry;
    let reason = null;
    if (m.support !== 'supported') reason = `provider-${m.support}`;
    else if (!installed(s)) reason = 'provider-not-installed';
    else if (!s.enabled) reason = 'provider-disabled';
    else if (!m.runtime.platforms.includes(this.#platform)) reason = 'platform-unsupported';
    else if (!adapter) reason = 'runtime-not-found';
    else if (m.modelAssets.some(a => a.required && (!a.sha256 || a.downloadBytes == null || a.installedBytes == null || !a.modelVersion || a.licenseId === 'unknown'))) reason = 'model-asset-missing';
    else if (Object.values(m.resources).some(v => v == null) || (m.modelAssets.length && !m.runtime.dependencyLockSha256)) reason = 'resource-not-probed';
    else if (m.verification.smoke.status === 'failed') reason = 'local-smoke-failed';
    if (reason) { s.availability = 'unavailable'; s.reason = reason; }
    return reason;
  }
  get(id) {
    const e = this.#entry(id);
    return snapshot({ manifest: e.manifest, manifestSha256: sha256(e.manifest), ...e.state, diagnostics: e.diagnostics });
  }
  list() { return snapshot([...this.#entries.keys()].sort().map(id => this.get(id))); }
  catalog() {
    return snapshot(this.list().flatMap(p => p.manifest.capabilities.map(capability => ({ ...capability, providerId: p.providerId, support: p.support, installation: p.installation, enabled: p.enabled, availability: CAPABILITY_IDS.includes(capability.capabilityId) ? p.availability : 'unavailable', quality: p.quality, reason: CAPABILITY_IDS.includes(capability.capabilityId) ? p.reason : 'unknown-provider-capability', checkedAt: p.checkedAt, verification: p.manifest.verification }))));
  }
  async health(id, context = {}) {
    const e = this.#entry(id); e.state.checkedAt = this.#clock();
    if (!this.#baseReason(e)) {
      try {
        const report = await e.adapter.health({ ...context, cold: true });
        e.state.availability = report?.available === true ? 'available' : 'unavailable';
        e.state.reason = report?.available === true ? null : report?.reason ?? 'provider-health-failed';
        e.state.lifecycle = report?.available === true ? 'ready' : 'unavailable';
      } catch { e.state.availability = 'unavailable'; e.state.reason = 'provider-health-failed'; e.state.lifecycle = 'failed'; }
    }
    assertContract('providerHealthReport', e.state); return snapshot(e.state);
  }
  enable(id) { const e = this.#entry(id); e.state.enabled = true; e.state.availability = 'not-probed'; e.state.reason = 'not-probed'; e.state.lifecycle = 'enabled'; this.#baseReason(e); return this.get(id); }
  async disable(id) {
    const e = this.#entry(id); e.state.enabled = false; e.state.availability = 'unavailable'; e.state.reason = 'provider-disabled'; e.state.lifecycle = 'disabled';
    await Promise.allSettled([...e.runs.keys()].map(runId => this.cancel(id, runId, 'provider-disabled'))); return this.get(id);
  }
  async cancel(id, runId, reason = 'cancelled') {
    const e = this.#entry(id); const run = e.runs.get(runId);
    if (run) run.controller.abort(new ProviderError('CAPABILITY_POLICY_CONFLICT', reason));
    await e.adapter?.cancel?.({ runId, reason });
  }
  async dispose(id) {
    const e = this.#entry(id); await this.disable(id); await e.adapter?.dispose?.(); e.state.lifecycle = 'disposed'; e.state.reason = 'provider-disposed'; return this.get(id);
  }
  async unregister(id) { await this.dispose(id); this.#entries.delete(id); }
  async executeStage({ plan, stageId, ledger, inputRefs, config = {}, signal, outputGuard }) {
    assertContract('capabilityExecutionPlan', plan);
    const { planHash, ...body } = plan;
    if (planHash !== sha256(body) || plan.status !== 'ready' || Date.parse(plan.expiresAt) <= Date.parse(this.#clock())) throw new ProviderError('CAPABILITY_POLICY_CONFLICT', 'execution-plan-invalid-or-expired');
    const stage = plan.stageGraph.find(s => s.stageId === stageId);
    if (!stage) throw new ProviderError('CAPABILITY_POLICY_CONFLICT', 'stage-not-in-plan');
    const executionKey = `${plan.planHash}:${stageId}`;
    const e = this.#entry(stage.providerId); const selected = plan.selectedProviders.find(p => p.providerId === stage.providerId && p.capabilityId === stage.capabilityId);
    if (!selected || selected.manifestSha256 !== sha256(e.manifest)) throw new ProviderError('CAPABILITY_POLICY_CONFLICT', 'provider-plan-version-changed');
    if (this.#baseReason(e) || e.state.availability !== 'available') throw new ProviderError(e.state.reason === 'provider-disabled' ? 'PROVIDER_DISABLED' : 'PROVIDER_NOT_INSTALLED', e.state.reason ?? 'provider-unavailable', { providerId: stage.providerId });
    if (!CAPABILITY_IDS.includes(stage.capabilityId)) throw new ProviderError('CAPABILITY_POLICY_CONFLICT', 'unknown-provider-capability');
    if (sha256(config) !== stage.configSha256 || (inputRefs && sha256(inputRefs) !== sha256(stage.inputRefs))) throw new ProviderError('CAPABILITY_POLICY_CONFLICT', 'plan-input-or-config-mismatch');
    if (sha256(ledger.limits) !== sha256(plan.budgetSnapshot)) throw new ProviderError('CAPABILITY_POLICY_CONFLICT', 'plan-budget-mismatch');
    const validator = this.#outputValidators[stage.outputSchemaRef];
    if (typeof validator !== 'function') throw new ProviderError('PROVIDER_OUTPUT_INVALID', 'output-schema-not-registered');
    if (this.#executions.has(executionKey)) throw new ProviderError('CAPABILITY_POLICY_CONFLICT', 'stage-already-started');
    if (stage.dependencies.some(id => this.#executions.get(`${plan.planHash}:${id}`) !== 'complete')) throw new ProviderError('CAPABILITY_POLICY_CONFLICT', 'stage-dependency-incomplete');
    ledger.checkTime();
    const runId = randomUUID(), controller = new AbortController();
    const abort = () => controller.abort(signal.reason); signal?.addEventListener('abort', abort, { once: true });
    if (signal?.aborted) abort();
    let timer, reservation = false, recorded = false, pendingActual;
    const start = performance.now();
    this.#executions.set(executionKey, 'preflight');
    const timeoutMs = ledger.remainingWallMs();
    if (timeoutMs != null) timer = setTimeout(() => controller.abort(new ProviderError('PROVIDER_TIMEOUT', 'provider-timeout')), timeoutMs);
    const aborted = new Promise((_, reject) => { if (controller.signal.aborted) reject(controller.signal.reason); else controller.signal.addEventListener('abort', () => reject(controller.signal.reason), { once: true }); });
    // The same deadline covers preflight, execution, schema and ArtifactStore checks.
    const bounded = operation => Promise.race([Promise.resolve().then(operation), aborted]);
    try {
      if (controller.signal.aborted) throw controller.signal.reason;
      const preflight = await bounded(() => e.adapter.preflight({ capabilityId: stage.capabilityId, inputRefs: stage.inputRefs, limits: plan.budgetSnapshot, policy: plan.privacySnapshot, signal: controller.signal }));
      if (preflight?.ready !== true) throw new ProviderError('RESOURCE_BUDGET_EXCEEDED', preflight?.reason ?? 'provider-preflight-failed');
      ledger.reserve(runId, preflight.estimate); reservation = true;
      e.runs.set(runId, { controller }); e.state.runningCount = e.runs.size; e.state.lifecycle = 'executing';
      this.#executions.set(executionKey, 'executing');
      const result = await bounded(() => e.adapter.execute({ runId, capabilityId: stage.capabilityId, inputRefs: stage.inputRefs, config, limits: plan.budgetSnapshot, signal: controller.signal }));
      const actual = { ...(result?.usage ?? { metering: 'not-metered' }), wallMs: performance.now() - start };
      // Count the returned envelope ourselves. External artifact bytes are checked by outputGuard.
      const envelopeBytes = Buffer.byteLength(JSON.stringify(result?.output ?? null));
      actual.outputBytes = Math.max(envelopeBytes, actual.outputBytes ?? 0);
      pendingActual = actual;
      if (await bounded(() => validator(result?.output, { stage, plan, runId })) !== true) throw new ProviderError('PROVIDER_OUTPUT_INVALID', 'provider-output-invalid', { providerId: stage.providerId, capabilityId: stage.capabilityId });
      if (result?.output?.products?.length && !outputGuard) throw new ProviderError('PROVIDER_OUTPUT_INVALID', 'artifact-integrity-guard-required');
      if (outputGuard) {
        const checked = await bounded(() => outputGuard(result.output, { stage, plan, runId }));
        if (checked !== true && checked?.verified !== true) throw new ProviderError('PROVIDER_OUTPUT_INVALID', 'artifact-integrity-check-failed');
        if (checked?.outputBytes != null) {
          if (!Number.isSafeInteger(checked.outputBytes) || checked.outputBytes < 0) throw new ProviderError('PROVIDER_OUTPUT_INVALID', 'artifact-byte-count-invalid');
          actual.outputBytes = Math.max(actual.outputBytes, envelopeBytes + checked.outputBytes);
        }
      }
      recorded = true; ledger.complete(runId, actual);
      this.#executions.set(executionKey, 'complete');
      return snapshot({ runId, providerId: stage.providerId, capabilityId: stage.capabilityId, status: 'complete', output: result.output, costActual: actual });
    } catch (error) {
      this.#executions.set(executionKey, 'failed');
      if (controller.signal.aborted) {
        // Do not claim a cancelled worker has stopped without a cleanup acknowledgement.
        e.state.availability = 'unavailable'; e.state.reason = 'provider-cancellation-unverified';
        const cleanup = await e.adapter.cancel?.({ runId, reason: 'cancelled-or-timeout' });
        if (cleanup?.stopped === true && e.state.enabled) { e.state.availability = 'available'; e.state.reason = null; }
        else if (cleanup?.stopped === true && e.state.lifecycle === 'disabled') e.state.reason = 'provider-disabled';
      }
      throw error;
    } finally {
      clearTimeout(timer); signal?.removeEventListener('abort', abort);
      if (reservation && !recorded) {
        // Unknown cancellation/failure usage is kept unknown rather than reporting zero.
        try { ledger.complete(runId, pendingActual ?? { wallMs: performance.now() - start, metering: 'not-metered' }); } catch { /* original failure remains authoritative */ }
      }
      e.runs.delete(runId); e.state.runningCount = e.runs.size;
      if (e.state.enabled && e.state.lifecycle === 'executing') e.state.lifecycle = e.runs.size ? 'executing' : 'idle';
    }
  }
}
