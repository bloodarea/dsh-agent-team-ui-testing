import { ProviderError, assertContract, snapshot } from './contracts.js';

export const BUDGET_USAGE = Object.freeze({ maxRemoteRequests: 'requestCount', maxInputTokens: 'inputTokens', maxOutputTokens: 'outputTokens', maxMoney: 'actualMoney', maxRamBytes: 'ramPeakBytes', maxVramBytes: 'vramPeakBytes', maxDiskBytes: 'diskBytes', maxCpuMs: 'cpuMs', maxGpuMs: 'gpuMs', maxWallMs: 'wallMs', maxOutputBytes: 'outputBytes' });
const peakFields = new Set(['ramPeakBytes', 'vramPeakBytes', 'diskBytes']);
export function intersectBudgets(user = {}, task = {}) {
  assertContract('budget', user); assertContract('budget', task);
  if (user.currency && task.currency && user.currency !== task.currency) throw new ProviderError('CAPABILITY_POLICY_CONFLICT', 'currency-policy-conflict');
  const result = {};
  for (const key of [...Object.keys(BUDGET_USAGE), 'maxConcurrentProviders']) {
    const a = user[key], b = task[key]; result[key] = a == null ? b ?? null : b == null ? a : Math.min(a, b);
  }
  result.currency = user.currency ?? task.currency ?? null;
  if (result.maxMoney != null && !result.currency) throw new ProviderError('CAPABILITY_POLICY_CONFLICT', 'money-budget-currency-required');
  return snapshot(result);
}
export function aggregateUsage(values) {
  const result = {}; const currencies = new Set(values.map(v => v.currency).filter(Boolean));
  if (currencies.size > 1) throw new ProviderError('RESOURCE_BUDGET_EXCEEDED', 'currency-mismatch');
  for (const field of Object.values(BUDGET_USAGE)) {
    const all = values.map(v => v[field]);
    result[field] = all.some(v => v == null) ? null : peakFields.has(field) ? Math.max(0, ...all) : all.reduce((a, b) => a + b, 0);
  }
  result.currency = [...currencies][0] ?? null;
  result.metering = Object.values(result).some(v => v == null) ? 'partial' : 'measured';
  return result;
}
export function budgetViolations(limits, usage, { rejectUnknown = true } = {}) {
  const errors = [];
  for (const [limit, field] of Object.entries(BUDGET_USAGE)) {
    if (limits[limit] == null) continue;
    if (usage[field] == null) { if (rejectUnknown) errors.push(`${field}:unknown`); }
    else if (usage[field] > limits[limit]) errors.push(`${field}:exceeded`);
  }
  if (limits.maxMoney != null && usage.actualMoney !== 0 && usage.currency !== limits.currency) errors.push('currency:mismatch');
  return errors;
}
export class BudgetLedger {
  #limits; #runs = new Map(); #seenRuns = new Set(); #actual = []; #startedAt; #clock;
  constructor(limits, { clock = Date.now } = {}) { this.#limits = intersectBudgets(limits); this.#clock = clock; this.#startedAt = clock(); }
  get limits() { return this.#limits; }
  get actual() {
    if (!this.#actual.length) return snapshot({ metering: 'not-metered', wallMs: this.#clock() - this.#startedAt });
    return snapshot({ ...aggregateUsage(this.#actual), wallMs: this.#clock() - this.#startedAt });
  }
  #check(usage) {
    const violations = budgetViolations(this.#limits, usage);
    if (violations.length) throw new ProviderError('RESOURCE_BUDGET_EXCEEDED', 'resource-budget-exceeded', { violations });
  }
  reserve(runId, estimate) {
    assertContract('usage', estimate);
    if (this.#seenRuns.has(runId)) throw new ProviderError('CAPABILITY_POLICY_CONFLICT', 'duplicate-run-id');
    const max = this.#limits.maxConcurrentProviders;
    if (max != null && this.#runs.size >= max) throw new ProviderError('RESOURCE_BUDGET_EXCEEDED', 'max-concurrent-providers-exceeded');
    const combined = aggregateUsage([...this.#actual, ...this.#runs.values(), estimate]);
    // Concurrent memory reservations add; completed peaks do not remain reserved.
    for (const field of ['ramPeakBytes', 'vramPeakBytes']) {
      const active = [...this.#runs.values(), estimate].map(v => v[field]);
      combined[field] = active.some(v => v == null) ? null : active.reduce((a, b) => a + b, 0);
    }
    combined.wallMs = Math.max(combined.wallMs ?? 0, this.#clock() - this.#startedAt + (estimate.wallMs ?? 0));
    this.#check(combined); this.#runs.set(runId, structuredClone(estimate)); this.#seenRuns.add(runId);
    return snapshot({ runId, limits: this.#limits });
  }
  complete(runId, actual) {
    if (!this.#runs.has(runId)) throw new ProviderError('CAPABILITY_POLICY_CONFLICT', 'run-not-reserved');
    assertContract('usage', actual); this.#runs.delete(runId); this.#actual.push(structuredClone(actual));
    // Record even an overrun before reporting it; actual cost is never replaced by an estimate.
    this.#check({ ...aggregateUsage(this.#actual), wallMs: this.#clock() - this.#startedAt });
    return this.actual;
  }
  release(runId) { this.#runs.delete(runId); }
  checkTime() {
    if (this.#limits.maxWallMs != null && this.#clock() - this.#startedAt >= this.#limits.maxWallMs) throw new ProviderError('PROVIDER_TIMEOUT', 'provider-timeout');
  }
  remainingWallMs() { return this.#limits.maxWallMs == null ? null : Math.max(0, this.#limits.maxWallMs - (this.#clock() - this.#startedAt)); }
}
