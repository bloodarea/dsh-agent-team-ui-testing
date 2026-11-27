import { randomUUID, createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { delimiter, join } from 'node:path';
import { ENVIRONMENTS, ENVIRONMENT_CAPABILITIES, CAPABILITY_IDS, defineEnvironmentEntry, AdapterError } from '../../core/index.js';
import { blenderManifest } from '../../tools/blender/schema.js';
import { createBlenderViewport } from './runtime.js';
import { createBlenderTools, createBlenderJobStore, blenderExecutionClassFor, assertBlenderInput } from './tools.js';
import { hashJson } from './spec/json.js';

const fail = (code, message, details = {}) => { throw new AdapterError(code, message, { details: { effectState: 'none', ...details } }); };
const capabilities = ENVIRONMENT_CAPABILITIES[ENVIRONMENTS.THREE_D];
const allowedCapabilities = new Set(Object.values(CAPABILITY_IDS.THREE_D));
export const BLENDER_TOOL_OPERATIONS = Object.freeze(Object.fromEntries(blenderManifest.tools.map(tool => {
  const first = tool.actions[0];
  if (!allowedCapabilities.has(first.capabilityId)) throw new TypeError(`Unknown Blender capability ${first.capabilityId}`);
  return [tool.toolName, Object.freeze({ capability: first.capabilityId, executionClass: first.executionClass })];
})));

export function resolveBlenderDriver(snapshot) {
  const provider = snapshot?.provider ?? null;
  const enabled = snapshot?.environment === ENVIRONMENTS.THREE_D
    && snapshot.enabledEnvironments?.includes(ENVIRONMENTS.THREE_D)
    && snapshot.environmentConfig?.enabled !== false;
  const providerEnabled = snapshot?.enabledProviders?.includes('blender') === true && snapshot?.providerConfig?.enabled !== false;
  return { provider, blocked: !enabled ? 'environment-disabled' : provider !== 'blender' ? 'provider-unsupported' : !providerEnabled ? 'provider-disabled' : null };
}

/** Process-local control; tokens are independent, scoped and revoked on generation/ownership change.
 * This is not human approval and is deliberately not persisted across plugin reloads.
 */
export function createBlenderCoordinator({ getViewport, now = Date.now } = {}) {
  const records = new Map(); const grants = new Map(); const leases = new Map(); const ledger = new Map();
  const identity = context => `${context.workspaceKey}\0${context.owner}`;
  function record(context) {
    if (!context?.workspaceKey || !context?.owner) fail('AUTHORIZATION_REQUIRED', 'Proven workspace and session identity required.');
    const status = getViewport().status(context.workspaceKey);
    const runtimeGeneration = status?.connection?.runtimeGeneration ?? null;
    let item = records.get(context.workspaceKey);
    if (!item) {
      item = { targetId: `target_w${createHash('sha256').update(context.workspaceKey).digest('hex').slice(0, 24)}`, generation: 1, sceneRevision: 0, viewRevision: 0, controls: { project: 0, scene: 0, view: 0 }, runtimeGeneration, connected: false, busy: false, dirty: false };
      records.set(context.workspaceKey, item);
    } else if (item.runtimeGeneration !== runtimeGeneration) {
      item.generation++; item.runtimeGeneration = runtimeGeneration; item.sceneRevision = 0; item.viewRevision = 0; item.dirty = false;
      for (const resource of Object.keys(item.controls)) item.controls[resource]++;
    }
    item.connected = status?.connection?.connected === true;
    return item;
  }
  function assertLive(live, item) {
    if (!live || live.targetId !== item.targetId || live.generation !== item.generation) fail('GENERATION_MISMATCH', 'Target identity or generation changed.', { targetId: item.targetId, generation: item.generation });
    if (!item.connected) fail('TARGET_NOT_BOUND', 'This workspace has no running Blender target.');
  }
  const keyFor = (context, item, resource) => `${context.workspaceKey}\0${item.targetId}\0${resource}`;
  function assertGrant(grantId, context, item, resource) {
    if (!grantId) fail('AUTHORIZATION_REQUIRED', 'A grantId is required.');
    const grant = grants.get(grantId);
    if (!grant) fail('GRANT_INVALID', 'Grant was not issued by this plugin instance.');
    if (grant.expiresAt <= now()) fail('GRANT_EXPIRED', 'Grant expired.');
    if (grant.subject !== identity(context) || grant.targetId !== item.targetId || grant.resource !== resource) fail('GRANT_SCOPE_MISMATCH', 'Grant does not cover this caller, workspace, target and resource.');
    if (grant.generation !== item.generation) fail('GENERATION_MISMATCH', 'Grant belongs to an old target generation.');
    return grant;
  }
  function challenge(context, item, resource) {
    const grantId = `grant_${randomUUID()}`; const expiresAt = now() + 300000;
    grants.set(grantId, { subject: identity(context), targetId: item.targetId, generation: item.generation, resource, expiresAt });
    return { grantId, resource, expiresAt: new Date(expiresAt).toISOString() };
  }
  function leaseFor(args, context, item, resource) {
    if (!args.leaseId) fail('LEASE_REQUIRED', 'A leaseId is required.');
    const lease = leases.get(keyFor(context, item, resource));
    if (!lease || lease.leaseId !== args.leaseId || lease.expiresAt <= now() || lease.owner !== context.owner) fail('LEASE_LOST', 'Lease expired, changed owner or was released.');
    if (lease.generation !== item.generation) fail('GENERATION_MISMATCH', 'Lease belongs to an old target generation.');
    if (args.expectControlRevision !== item.controls[resource]) fail('LEASE_LOST', 'Control revision changed.', { controlRevision: item.controls[resource] });
    return lease;
  }
  function control(args, context, item) {
    const resource = args.resource;
    if (args.live) assertLive(args.live, item);
    const key = keyFor(context, item, resource); let lease = leases.get(key);
    const data = () => ({ resource, status: lease && lease.expiresAt > now() ? 'acquired' : 'available', controlRevision: item.controls[resource],
      ...(lease && lease.expiresAt > now() ? { leaseId: lease.leaseId, expiresAt: new Date(lease.expiresAt).toISOString(), owner: lease.owner } : {}) });
    if (args.action === 'status') return { ...data(), challenge: challenge(context, item, resource) };
    if (args.action === 'acquire') {
      assertGrant(args.grantId, context, item, resource);
      if (lease && lease.expiresAt > now() && lease.generation === item.generation && lease.owner !== context.owner) fail('BUSY', 'Resource has another lease owner.');
      item.controls[resource]++;
      lease = { leaseId: `lease_${randomUUID()}`, targetId: item.targetId, generation: item.generation, resource: resource === 'view' ? 'sharedView' : resource, owner: context.owner, expiresAt: now() + (args.ttlMs ?? 30000), controlRevision: item.controls[resource] };
      leases.set(key, lease);
      return { ...data(), challenge: { grantId: args.grantId, resource, expiresAt: new Date(grants.get(args.grantId).expiresAt).toISOString() } };
    }
    lease = leaseFor(args, context, item, resource);
    item.controls[resource]++;
    if (args.action === 'release') { leases.delete(key); lease = null; return data(); }
    lease.expiresAt = now() + (args.ttlMs ?? 30000); lease.controlRevision = item.controls[resource];
    return data();
  }
  function begin(write, context, item, resource, request = write) {
    if (!write || typeof write !== 'object') fail('SCHEMA_INVALID', 'Write preconditions are required.', { instancePath: '/write' });
    assertGrant(write.grantId, context, item, resource);
    leaseFor(write, context, item, resource);
    assertLive(write, item);
    if (typeof write.idemKey !== 'string' || !write.idemKey || Buffer.byteLength(write.idemKey) > 128) fail('SCHEMA_INVALID', 'A 1–128 byte idemKey is required.', { instancePath: '/idemKey' });
    const key = `${context.workspaceKey}\0${item.targetId}\0${write.idemKey}`;
    const digest = hashJson({ owner: context.owner, resource, request }); const previous = ledger.get(key);
    // Replay precedes baseline revision comparison, after current authorization and binding checks.
    if (previous) {
      if (previous.digest !== digest) fail('IDEMPOTENCY_CONFLICT', 'Idempotency key was already used with different input.');
      if (previous.error) throw previous.error;
      if (previous.value) return { replay: structuredClone(previous.value) };
      fail('BUSY', 'Identical operation is still running.');
    }
    const revisionName = resource === 'view' ? 'expectViewRevision' : 'expectSceneRevision';
    const revision = resource === 'view' ? item.viewRevision : item.sceneRevision;
    if (!Number.isSafeInteger(write[revisionName])) fail('SCHEMA_INVALID', `${revisionName} is required.`, { instancePath: `/${revisionName}` });
    if (write[revisionName] !== revision) fail('REVISION_CONFLICT', 'Live revision changed.', { currentRevision: revision });
    if (item.busy) fail('BUSY', 'Workspace already has an active write.');
    const token = { key, digest, record: item }; item.busy = true; ledger.set(key, { digest }); return token;
  }
  function finish(token, value, error) {
    token.record.busy = false;
    if (error && error.details?.effectState === 'none') ledger.delete(token.key);
    else ledger.set(token.key, { digest: token.digest, ...(error ? { error } : { value: structuredClone(value) }) });
  }
  return { record, assertLive, assertGrant, control, begin, finish, dispose() { records.clear(); grants.clear(); leases.clear(); ledger.clear(); } };
}

/** Inspect only proven same-workspace instances; inventory is never an authorization source. */
export async function inspectBlenderBinding(context, viewport, resolveInstanceWorkspace = async () => null) {
  const toolWorkspaceKey = context?.workspaceKey ?? null;
  const status = toolWorkspaceKey ? viewport.status(toolWorkspaceKey) : null;
  const project = (current, key = toolWorkspaceKey) => current ? {
    workspaceKey: key, state: current.state, pid: current.pid ?? null,
    connection: { connected: current.connection?.connected === true, runtimeGeneration: current.connection?.runtimeGeneration ?? null },
  } : null;
  const direct = status?.connection?.connected === true;
  const candidates = direct ? [project(status)] : [];
  if (toolWorkspaceKey && !direct) {
    for (const instance of viewport.listRunning?.() ?? []) {
      if (!instance?.connected || typeof instance.workspaceKey !== 'string' || candidates.some(item => item.workspaceKey === instance.workspaceKey)) continue;
      let sameWorkspace = instance.workspaceKey === toolWorkspaceKey;
      if (!sameWorkspace && context.workspaceId) {
        const workspace = await resolveInstanceWorkspace(instance.workspaceKey);
        sameWorkspace = workspace?.workspaceId === context.workspaceId;
      }
      if (sameWorkspace) {
        const current = viewport.status(instance.workspaceKey);
        if (current?.connection?.connected) candidates.push(project(current, instance.workspaceKey));
      }
    }
  }
  const selectedWorkspaceKey = direct ? toolWorkspaceKey : candidates.length === 1 ? candidates[0].workspaceKey : null;
  return {
    toolWorkspaceKey, workspaceRootAvailable: Boolean(context?.workspaceRoot), requested: project(status), candidates,
    selectedWorkspaceKey, workspaceKeySource: direct ? 'session-workspace' : selectedWorkspaceKey ? 'panel-instance-reuse' : null,
    reason: !toolWorkspaceKey ? 'workspace-unresolved' : direct ? 'direct-instance' : candidates.length > 1 ? 'ambiguous-instances' : selectedWorkspaceKey ? 'same-workspace-instance' : 'no-running-instance',
  };
}

export function createBlenderEnvironmentEntry({ log = () => {}, viewport = null, getViewport: injectedViewport = null, viewportOptions = {}, resolveContext: resolveBaseContext = async () => null, resolveInstanceWorkspace = async () => null, getDisclosure, ...services } = {}) {
  let ownedViewport;
  const getViewport = () => injectedViewport?.() ?? viewport ?? (ownedViewport ??= createBlenderViewport(viewportOptions));
  const diagnostics = new WeakMap();
  const resolveContext = async (exec = {}) => {
    const context = await resolveBaseContext(exec);
    const binding = await inspectBlenderBinding(context, getViewport(), resolveInstanceWorkspace);
    diagnostics.set(exec, binding);
    if (binding.reason === 'ambiguous-instances') fail('TARGET_NOT_BOUND', 'Multiple running Blender instances belong to this workspace; select an unambiguous binding.', { candidates: binding.candidates, workspaceBinding: binding });
    return context ? { ...context, workspaceKey: binding.selectedWorkspaceKey ?? context.workspaceKey, workspaceBinding: binding } : null;
  };
  const coordinator = createBlenderCoordinator({ getViewport, ...(services.now ? { now: services.now } : {}) });
  const jobStore = services.jobStore ?? createBlenderJobStore();
  const tools = createBlenderTools({ getViewport, coordinator, resolveContext, getDisclosure, ...services, jobStore }).map(tool => tool.name !== 'blender_capabilities' ? tool : {
    ...tool, async execute(args, exec = {}) {
      try {
        const value = await tool.execute(args, exec);
        const workspaceBinding = diagnostics.get(exec);
        if (workspaceBinding) {
          value.data.readiness.connection.evidence = { workspaceBinding };
          if (value.data.observed) value.data.observed = { ...value.data.observed, workspaceBinding };
        }
        return value;
      } finally { diagnostics.delete(exec); }
    },
  });
  const manifest = (id, kind) => ({ contractVersion: 1, id, class: kind, environment: ENVIRONMENTS.THREE_D, capabilities: [...capabilities] });
  function probeCapabilities({ checkedAt = Date.now(), context } = {}) {
    const current = context?.workspaceKey ? getViewport().status(context.workspaceKey) : null;
    return { status: current?.busy ? 'busy' : current?.connection?.hello ? 'partial' : 'not-probed', reason: current?.connection?.hello ? 'runtime-subset' : 'no-runtime-handshake', checkedAt, evidence: { observed: current?.connection?.hello ?? null } };
  }
  function resolveExecutable({ provider } = {}) {
    if (provider !== 'blender') return null;
    const override = viewportOptions.blenderExecutable ?? process.env.DSH_UI_TESTING_BLENDER;
    const candidates = override ? [override] : (process.env.PATH ?? '').split(delimiter).map(directory => join(directory, process.platform === 'win32' ? 'blender.exe' : 'blender'));
    const path = candidates.find(candidate => existsSync(candidate));
    return { path: path ?? null, reason: path ? null : 'executable-not-resolved; use cold version probe' };
  }
  function create() {
    const targetAdapter = {
      manifest: manifest('three-d', 'target'),
      async probe({ snapshot }) {
        const checkedAt = Date.now(); const blocked = resolveBlenderDriver(snapshot).blocked;
        let dependency = { status: 'not-probed' };
        if (!blocked) {
          try { const result = await getViewport().probe(); dependency = { status: result.compatible ? 'ok' : 'failed', checkedAt, evidence: result }; }
          catch (error) { dependency = { status: 'failed', reason: 'dependency-missing', checkedAt }; }
        }
        return { environment: 'three-d', configRevision: snapshot.revision, checkedAt, axes: { support: { status: 'supported' }, enabled: { status: blocked ? 'false' : 'true' }, dependency, connection: { status: 'not-probed' }, target: { status: 'unbound' }, capability: probeCapabilities({ checkedAt }) } };
      },
      async createSession({ scope, snapshot }) {
        const session = { sessionId: randomUUID(), environment: 'three-d', scopeId: scope?.id ?? null, scope, configRevision: snapshot.revision, generation: 0, target: null, closed: false,
          async listTargets() { return []; },
          async bind() { fail('TARGET_NOT_BOUND', 'Use the authorized workspace project status to identify a running target.'); },
          async close() { session.closed = true; }, async dispose() { session.closed = true; } };
        return session;
      },
      async dispose() {},
    };
    const capabilityAdapter = {
      manifest: { ...manifest('three-d.blender.tools', 'capability'), operations: Object.keys(BLENDER_TOOL_OPERATIONS) },
      operationStatus() { return Object.fromEntries(Object.keys(BLENDER_TOOL_OPERATIONS).map(name => [name, { support: 'supported', availability: name === 'blender_tools' || name === 'blender_capabilities' || name === 'blender_control' ? 'available' : 'not-probed' }])); },
      preflight(args, operation) { assertBlenderInput(operation, args); return { ok: true }; },
      async invoke({ operation, args, context, snapshot }) {
        if (resolveBlenderDriver(snapshot).blocked) fail('ADAPTER_DISABLED', 'Blender provider is no longer admitted.');
        assertBlenderInput(operation, args);
        if (typeof context?.execute !== 'function') fail('PROVIDER_UNAVAILABLE', 'Host execution context is missing.');
        const value = await context.execute();
        context.rawResult = value;
        return { value, evidence: { version: 1, scope: context.meta?.scope ?? null, session: context.meta?.sessionId ?? null, target: args.targetId ?? args.live?.targetId ?? null, generation: args.generation ?? args.live?.generation ?? null, configRevision: snapshot.revision, operation, source: 'targets/three-d', capturedAt: Date.now() } };
      }, async dispose() {},
    };
    const p0Provider = { manifest: { ...manifest('three-d.blender.p0', 'p0'), families: [] }, familyStatus: () => ({}), async invoke() { fail('CAPABILITY_UNAVAILABLE', 'Blender P0 data services have not been verified.'); }, async dispose() {} };
    return { targetAdapter, capabilityAdapter, p0Provider, dispose: async () => { coordinator.dispose(); jobStore.dispose(); } };
  }
  return defineEnvironmentEntry({ id: ENVIRONMENTS.THREE_D, label: 'Blender', operations: BLENDER_TOOL_OPERATIONS, capabilities, tools,
    driver: resolveBlenderDriver, executionClassFor: blenderExecutionClassFor,
    surfaceAvailable: ({ config } = {}) => [config?.global, ...Object.values(config?.workspaces ?? {})].some(scope => scope?.enabledEnvironments?.includes('three-d') && scope?.environments?.['three-d']?.enabled !== false && scope?.environments?.['three-d']?.providers?.blender?.enabled === true),
    providerSupport: provider => provider === 'blender' ? 'supported' : 'unsupported', resolveExecutable,
    providerReadiness({ snapshot, entryConfig, checkedAt, axes }) { const enabled = entryConfig?.enabled === true && entryConfig?.providers?.blender?.enabled === true; return { blender: { id: 'blender', selected: snapshot.provider === 'blender', enabled, support: 'supported', implemented: true, axes: { support: { status: 'supported', checkedAt }, enabled: { status: enabled ? 'true' : 'false', checkedAt }, dependency: axes?.dependency ?? { status: 'not-probed', checkedAt }, connection: axes?.connection ?? { status: 'not-probed', checkedAt }, target: axes?.target ?? { status: 'unbound', checkedAt }, capability: axes?.capability ?? probeCapabilities({ checkedAt }) } } }; },
    probeCapabilities, admitTool: (name, snapshot) => Object.hasOwn(BLENDER_TOOL_OPERATIONS, name) ? resolveBlenderDriver(snapshot).blocked === null : undefined,
    create, dispose: async () => { coordinator.dispose(); jobStore.dispose(); await ownedViewport?.dispose(); },
  }, { log });
}
