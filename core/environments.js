/**
 * Environment registration: the public Host side of "environment implementation" (plan
 * `docs/internal/host-runtime-panel-decoupling-plan.md` §Host 负责编排).
 *
 * A registration entry declares *what an environment is* and *how to build its implementation
 * lazily*. The public Host (composition root, HTTP router, diagnostics, dispatch) only ever
 * resolves an entry by environment id; it never imports a platform module and never reads a
 * platform runtime's internals.
 *
 * Entry contract (every field except `id` and `create` is optional):
 *
 *   id                string, the environment id from `core/config.js` (`web`, `fake`, …)
 *   label             human readable name for diagnostics
 *   testOnly          true  -> only registered while test environments are allowed
 *   eager             true  -> adapters are registered at composition time (cheap fixtures);
 *                             false -> adapters appear on the environment's first demand
 *   operations        { toolName: { capability, executionClass } } — the environment's tool
 *                     description table, used for admission, disclosure and execution class
 *   tools             [{ name, description, parameters, output, execute, … }] — tool definitions the
 *                     environment itself owns (a fixture's probe); the Host registers them like
 *                     any other, with its own admission and per-Agent disclosure
 *   capabilities      string[] of capability ids the environment declares
 *   diagnostics       { allowedTools: string[], probes: [{ id, tool, args }] } — which read-only
 *                     probes this environment offers to the public diagnostics surface. An entry
 *                     without probes is reported as "declares no probes", which is a different
 *                     answer from "not probed yet".
 *   driver(snapshot)  -> { provider, blocked } : the provider gate for one resolved snapshot
 *   executionClassFor(name, args) -> execution class or null
 *   surfaceAvailable({ config }) -> boolean : whether the operation table may be declared at all
 *   providerSupport(id) -> 'supported' | 'pending' | 'unsupported'
 *   resolveExecutable({ provider }) -> { path, reason } | null   (never launches anything)
 *   providerReadiness({ snapshot, entryConfig, checkedAt, axes }) -> per-provider cards
 *   probeCapabilities({ entry, checkedAt }) -> readiness axis payload for one live target
 *   admitTool(name, snapshot) -> boolean | undefined  (extra admission rule, e.g. provider gate)
 *   findEntryForSnapshot(snapshot) -> target entry (implementation-internal lookup)
 *   create(api)       -> { targetAdapter, capabilityAdapter, p0Provider, dispose? }
 *   dispose()         -> release anything the entry itself created
 *
 * `api` is the host-provided service bag the entry may use (log, BrowserError, runtime registry,
 * P0 dispatch entry, limits, config snapshot provider, …). It is built by the composition root,
 * so an implementation only ever receives what the Host is willing to offer.
 */

export const ENVIRONMENT_ENTRY_VERSION = 1;

const REQUIRED_METHODS = Object.freeze(['create']);

function requiredString(value, field) {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new TypeError(`environment entry requires a non-empty string "${field}"`);
  }
  return value;
}

/**
 * Validate and freeze one registration entry.
 *
 * Validation is deliberately strict about identity (`id`, `create`) and permissive about optional
 * capabilities: an environment that cannot answer a question is simply absent from that lookup,
 * which the Host reports as "unsupported / not probed" instead of inventing an answer.
 */
export function defineEnvironmentEntry(spec, { log = () => {} } = {}) {
  if (!spec || typeof spec !== 'object' || Array.isArray(spec)) {
    throw new TypeError('environment entry must be an object');
  }
  const id = requiredString(spec.id, 'id');
  for (const method of REQUIRED_METHODS) {
    if (typeof spec[method] !== 'function') {
      throw new TypeError(`environment entry ${id} requires a ${method}() function`);
    }
  }
  const operations = spec.operations && typeof spec.operations === 'object'
    ? Object.freeze({ ...spec.operations })
    : null;
  return Object.freeze({
    version: ENVIRONMENT_ENTRY_VERSION,
    id,
    label: typeof spec.label === 'string' && spec.label ? spec.label : id,
    testOnly: spec.testOnly === true,
    eager: spec.eager === true,
    operations,
    tools: Object.freeze(Array.isArray(spec.tools) ? [...spec.tools] : []),
    diagnostics: Object.freeze({
      allowedTools: Object.freeze(Array.isArray(spec.diagnostics?.allowedTools) ? [...spec.diagnostics.allowedTools] : []),
      probes: Object.freeze(Array.isArray(spec.diagnostics?.probes)
        ? spec.diagnostics.probes.map((probe) => Object.freeze({ ...probe }))
        : []),
    }),
    capabilities: Object.freeze(Array.isArray(spec.capabilities) ? [...spec.capabilities] : []),
    create: spec.create,
    driver: typeof spec.driver === 'function' ? spec.driver : null,
    executionClassFor: typeof spec.executionClassFor === 'function' ? spec.executionClassFor : null,
    surfaceAvailable: typeof spec.surfaceAvailable === 'function' ? spec.surfaceAvailable : null,
    providerSupport: typeof spec.providerSupport === 'function' ? spec.providerSupport : null,
    resolveExecutable: typeof spec.resolveExecutable === 'function' ? spec.resolveExecutable : null,
    providerReadiness: typeof spec.providerReadiness === 'function' ? spec.providerReadiness : null,
    probeCapabilities: typeof spec.probeCapabilities === 'function' ? spec.probeCapabilities : null,
    admitTool: typeof spec.admitTool === 'function' ? spec.admitTool : null,
    findEntryForSnapshot: typeof spec.findEntryForSnapshot === 'function' ? spec.findEntryForSnapshot : null,
    dispose: typeof spec.dispose === 'function' ? spec.dispose : null,
    log,
  });
}

/**
 * The Host-side directory of environment registrations.
 *
 * Instances are created at most once and only on demand: a Host that never touches an environment
 * neither loads nor constructs it (A14). `dispose()` releases instances in reverse registration
 * order so a later environment never outlives the one it was layered on.
 */
export function createEnvironmentDirectory({ log = () => {}, api = {} } = {}) {
  const entries = new Map();
  const instances = new Map();
  let disposed = false;

  function register(spec) {
    const entry = spec && spec.version === ENVIRONMENT_ENTRY_VERSION && Object.isFrozen(spec)
      ? spec
      : defineEnvironmentEntry(spec, { log });
    if (entries.has(entry.id)) throw new TypeError(`environment ${entry.id} is already registered`);
    entries.set(entry.id, entry);
    return entry;
  }

  function entry(id) {
    return entries.get(String(id)) ?? null;
  }

  function entriesOf() {
    return [...entries.values()];
  }

  function has(id) {
    return entries.has(String(id));
  }

  function ids() {
    return [...entries.keys()];
  }

  /**
   * Resolve (creating on first use) the implementation of one environment.
   *
   * `overrides` lets the composition root add late-bound host services (for example a P0 dispatch
   * entry that itself resolves environments) without the implementation importing the Host.
   */
  function instance(id, overrides = null) {
    const key = String(id);
    const existing = instances.get(key);
    if (existing) return existing;
    const registered = entries.get(key);
    if (!registered) return null;
    if (disposed) return null;
    const built = registered.create(Object.freeze({ ...api, ...(overrides || {}), entry: registered }));
    if (!built || typeof built !== 'object') {
      throw new TypeError(`environment ${key} create() must return an implementation object`);
    }
    const record = {
      id: key,
      entry: registered,
      targetAdapter: built.targetAdapter ?? null,
      capabilityAdapter: built.capabilityAdapter ?? null,
      p0Provider: built.p0Provider ?? null,
      dispose: typeof built.dispose === 'function' ? built.dispose : null,
    };
    instances.set(key, record);
    return record;
  }

  function peek(id) {
    return instances.get(String(id)) ?? null;
  }

  function describe() {
    return entriesOf().map((item) => ({
      id: item.id,
      label: item.label,
      testOnly: item.testOnly,
      instantiated: instances.has(item.id),
      operations: item.operations ? Object.keys(item.operations).length : 0,
      capabilities: [...item.capabilities],
    }));
  }

  async function dispose() {
    if (disposed) return;
    disposed = true;
    for (const record of [...instances.values()].reverse()) {
      try {
        if (record.dispose) await record.dispose();
      } catch { /* best effort: one environment must not block the others */ }
      try {
        if (record.entry.dispose) await record.entry.dispose();
      } catch { /* best effort */ }
    }
    instances.clear();
    entries.clear();
  }

  return { register, entry, entries: entriesOf, has, ids, instance, peek, describe, dispose, api };
}
