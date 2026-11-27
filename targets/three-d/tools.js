import { randomUUID, createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { realpath, stat } from 'node:fs/promises';
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { AdapterError, ERROR_TAXONOMY } from '../../core/errors.js';
import { blenderManifest, getSchema, toolDefinitions, validateToolInput, validateToolOutput } from '../../tools/blender/schema.js';
import { compileScene, hashJson, canonicalize, parseStrictJson, normalizeReferenceImage, createRoiMapping } from './spec/index.js';

const fail = (code, message, details = {}) => { throw new AdapterError(code, message, { details: { effectState: 'none', ...details } }); };

/** DSH enforces a small output-schema dialect at registration. Keep its declarations
 * self-contained, retaining fields and discriminators; the frozen Draft 2020-12 schemas
 * remain authoritative in assertBlenderInput/envelope, including every omitted bound.
 */
function hostSchema(schema, document = schema, references = new Set()) {
  if (schema.$ref) {
    const [id, fragment = ''] = schema.$ref.split('#');
    const source = id ? getSchema(id) : document;
    const reference = `${source.$id ?? ''}#${fragment}`;
    if (references.has(reference)) throw new TypeError(`Circular Blender schema reference: ${reference}`);
    const target = fragment.split('/').slice(1).reduce((node, key) => node[decodeURIComponent(key).replace(/~1/g, '/').replace(/~0/g, '~')], source);
    const { $ref, ...siblings } = schema;
    return hostSchema({ ...target, ...siblings }, source, new Set([...references, reference]));
  }
  const annotations = Object.fromEntries(['description', 'title', 'default', 'examples'].filter(key => Object.hasOwn(schema, key)).map(key => [key, schema[key]]));
  const alternatives = schema.oneOf ?? schema.anyOf;
  if (alternatives) {
    const { oneOf, anyOf, ...common } = schema;
    const branches = alternatives.map(branch => hostSchema({ ...common, ...branch }, document, references));
    // The frozen anyOf declarations join disjoint JSON types (object/array, etc.).
    // Fail closed if a future schema needs a union the host cannot express exactly.
    if (anyOf && (branches.some(branch => !branch.type) || new Set(branches.map(branch => branch.type === 'integer' ? 'number' : branch.type)).size !== branches.length)) throw new TypeError('Blender anyOf projection requires disjoint types.');
    return branches.length === 1 ? branches[0] : { ...annotations, oneOf: branches };
  }
  if (Array.isArray(schema.type)) return { ...annotations, oneOf: schema.type.map(type => hostSchema({ ...schema, type }, document, references)) };
  const values = Object.hasOwn(schema, 'const') ? [schema.const] : schema.enum;
  const scalarType = value => value === null ? 'null' : typeof value;
  const type = schema.type ?? (values?.length ? scalarType(values[0]) : undefined);
  const result = { ...annotations, ...(type ? { type } : {}) };
  if (type === 'object') {
    if (schema.properties) result.properties = Object.fromEntries(Object.entries(schema.properties).map(([key, value]) => [key, hostSchema(value, document, references)]));
    if (schema.required) result.required = [...schema.required];
    if (Object.hasOwn(schema, 'additionalProperties')) result.additionalProperties = schema.additionalProperties !== false;
  } else if (type === 'array') {
    if (schema.items && typeof schema.items === 'object') result.items = hostSchema(schema.items, document, references);
  } else if (type) {
    if (schema.enum) result.enum = [...schema.enum];
    if (Object.hasOwn(schema, 'const')) result.const = schema.const;
  }
  return result;
}

/** Model gateways expect an object at the root of function parameters. Action-specific
 * requirements are described here and enforced by the original schema at dispatch.
 */
function hostParameters(schema) {
  const { oneOf: branches, ...root } = hostSchema(schema);
  if (!branches) return root;

  const actions = new Set();
  const fields = new Map();
  for (const branch of branches) {
    const action = branch.properties?.action?.const;
    if (branch.type !== 'object' || typeof action !== 'string' || actions.has(action)
      || !branch.required?.includes('action') || branch.additionalProperties !== false) {
      throw new TypeError('Blender parameter alternatives require closed objects with distinct action values.');
    }
    actions.add(action);
    for (const [name, property] of Object.entries(branch.properties)) {
      if (name === 'action') continue;
      if (!fields.has(name)) fields.set(name, { property, allowed: [], required: [] });
      const field = fields.get(name);
      if (!isDeepStrictEqual(property, field.property)) {
        throw new TypeError(`Blender parameter ${name} has different schemas across actions.`);
      }
      field.allowed.push(action);
      if (branch.required.includes(name)) field.required.push(action);
    }
  }

  const required = ['action'];
  const properties = Object.fromEntries([...fields].map(([name, field]) => {
    const description = [field.property.description];
    if (field.allowed.length < actions.size) description.push(`Available only for ${field.allowed.join(', ')}.`);
    if (field.required.length === actions.size) required.push(name);
    else if (field.required.length) description.push(`Required for ${field.required.join(', ')}.`);
    const text = description.filter(Boolean).join(' ');
    return [name, text ? { ...field.property, description: text } : field.property];
  }));
  return {
    ...root,
    type: 'object',
    properties: { action: { type: 'string', enum: [...actions] }, ...properties },
    required,
    additionalProperties: false,
  };
}

export const blenderAction = (name, args = {}) => args.action ?? (name.includes('scene_apply') || name.includes('spec_apply') ? 'apply' : 'status');
export function blenderExecutionClassFor(name, args = {}) {
  if ((name === 'blender_scene_apply' || name === 'blender_spec_apply') && args.mode === 'plan') return 'blender-main-read';
  if (name === 'blender_spec_revision' && args.action === 'get') return 'cold-read';
  return blenderManifest.tools.find(row => row.toolName === name)?.actions.find(row => row.action === blenderAction(name, args))?.executionClass ?? null;
}
export function assertBlenderInput(name, args) {
  const result = validateToolInput(name, args);
  if (!result.valid) {
    const location = result.errors.find(error => error.keyword === 'unitQuaternion') ?? result.errors[0];
    fail('SCHEMA_INVALID', `Invalid ${name} input.`, { instancePath: location?.instancePath ?? '', errors: result.errors });
  }
  const finite = (value, pointer = '') => {
    if (typeof value === 'number' && !Number.isFinite(value)) fail('SCHEMA_INVALID', 'Numbers must be finite.', { instancePath: pointer });
    if (value && typeof value === 'object') for (const [key, child] of Object.entries(value)) finite(child, `${pointer}/${key}`);
  };
  finite(args);
  const unitQuaternion = (rotation, instancePath) => {
    if (rotation !== undefined && Math.abs(rotation.reduce((sum, value) => sum + value * value, 0) - 1) > 1e-4) {
      fail('SCHEMA_INVALID', 'Rotation must be a unit quaternion (wxyz).', { instancePath });
    }
  };
  if (name === 'blender_scene_apply') {
    args.ops.forEach((step, index) => {
      if (step.opId === 'object.transform') unitQuaternion(step.args.rotation, `/ops/${index}/args/rotation`);
    });
  }
  if (name === 'blender_view' && args.action === 'set') unitQuaternion(args.changes.rotation, '/changes/rotation');
}
function mappedError(error, committed = 0) {
  if (error instanceof AdapterError) return error;
  const codes = { BLENDER_BUSY: 'BUSY', BLENDER_STALE_RUNTIME: 'GENERATION_MISMATCH', BLENDER_STALE_FRAME: 'GENERATION_MISMATCH', BLENDER_VERSION_UNSUPPORTED: 'DEPENDENCY_MISSING', BLENDER_DEPENDENCY_MISSING: 'DEPENDENCY_MISSING', BLENDER_PROBE_FAILED: 'DEPENDENCY_MISSING', BLENDER_COMMAND_UNKNOWN: 'OPERATION_TIMEOUT', BLENDER_PROTOCOL_MISMATCH: 'WORKER_LOST', BLENDER_HANDSHAKE_REQUIRED: 'CAPABILITY_UNAVAILABLE', BLENDER_COMMAND_FAILED: 'SEMANTIC_INVALID', PERMISSION_DENIED: 'FORBIDDEN', SCHEMA_VALIDATION_FAILED: 'SCHEMA_INVALID', UNSAFE_PATH: 'PATH_OUTSIDE_WORKSPACE', RESOURCE_LIMIT: 'OUTPUT_LIMIT', ALGORITHM_UNAVAILABLE: 'CAPABILITY_UNSUPPORTED', ASSET_UNAVAILABLE: 'EVIDENCE_INCOMPLETE', ASSET_EXPIRED: 'EVIDENCE_INCOMPLETE', SCENE_NOT_FOUND: 'EVIDENCE_INCOMPLETE', STORE_CORRUPT: 'EVIDENCE_INCOMPLETE' };
  const code = codes[error?.code] ?? (Object.hasOwn(ERROR_TAXONOMY, error?.code ?? '') ? error.code : error?.name === 'SpecError' ? 'SEMANTIC_INVALID' : 'INTERNAL');
  return new AdapterError(code, error?.message ?? 'Blender operation failed.', { details: { ...error?.details, effectState: error?.effectState ?? (committed ? 'partial' : 'none'), committedSteps: committed, runtimeCode: error?.code ?? null } });
}

const projectLifecycleLimitations = [
  'Project save requires a running target with an authoritative bound projectPath, a workspace root, project write authorization and a matching expectedFileHash; a supplied overwriteGrantId is validated for the project resource.',
  'Atomic file saving is provided by Blender save_as_mainfile; Node performs compare-authorization-validation-post-write SHA-256 verification, not temporary-file/rename saving or an atomic compare-and-swap against external disk writers.',
  'Project saveAs validates workspace confinement and requires matching expectedFileHash plus a valid overwriteGrantId for an existing destination, but remains unavailable: the runtime only saves to the already-bound active project path.',
  'Project open/reload are unavailable because no in-process lifecycle handler is connected; tools never start or replace a Blender process for these actions.',
  'Project close rejects tracked dirty state with PROJECT_DIRTY, then remains unavailable because no safe project-close handler is connected; discardGrantId cannot bypass this boundary.',
];
const unavailableProject = action => fail('CAPABILITY_UNAVAILABLE', projectLifecycleLimitations[{ save: 0, saveAs: 2, open: 3, reload: 3, close: 4 }[action]],
  { tool: 'blender_project', action, recovery: 'Inspect blender_capabilities for the connected lifecycle subset.' });
const insideWorkspace = (root, target) => {
  const part = relative(root, target);
  return part !== '..' && !part.startsWith(`..${sep}`) && !isAbsolute(part);
};
async function workspaceProjectPath(context, requested) {
  if (!context.workspaceRoot) fail('CAPABILITY_UNAVAILABLE', 'Project file validation requires a proven workspace root.');
  const root = resolve(context.workspaceRoot); const target = resolve(root, requested);
  if (!insideWorkspace(root, target)) fail('PATH_OUTSIDE_WORKSPACE', 'Project path must stay inside the workspace root.');
  const canonicalRoot = await realpath(root);
  // Resolve the nearest existing ancestor as well, so missing targets under escaping symlinks/junctions are rejected.
  let ancestor = target; let canonical;
  while (!canonical) {
    try { canonical = resolve(await realpath(ancestor), relative(ancestor, target)); }
    catch (error) {
      if (error.code !== 'ENOENT' || dirname(ancestor) === ancestor) throw error;
      ancestor = dirname(ancestor);
    }
  }
  if (!insideWorkspace(canonicalRoot, canonical)) fail('PATH_OUTSIDE_WORKSPACE', 'Resolved project path escapes the workspace root.');
  return canonical;
}
async function projectFileHash(path) {
  try {
    if (!(await stat(path)).isFile()) fail('SEMANTIC_INVALID', 'Project path must identify a regular file.');
    const hash = createHash('sha256');
    for await (const bytes of createReadStream(path)) hash.update(bytes);
    return hash.digest('hex');
  } catch (error) { if (error.code === 'ENOENT') return null; throw error; }
}

/** Process-local registry for bounded offline jobs. No job is created merely by querying it. */
export function createBlenderJobStore() {
  const jobs = new Map(); const ledger = new Map();
  const scope = context => {
    if (!context?.workspaceKey || !context?.owner) fail('AUTHORIZATION_REQUIRED', 'Job scope requires a workspace and caller.');
    return hashJson([context.workspaceKey, context.owner]);
  };
  const find = (jobId, context) => {
    const item = jobs.get(jobId);
    // Same error for absent and foreign jobs; do not reveal another caller's work.
    if (!item || item.scope !== scope(context)) fail('TARGET_GONE', 'No accessible job with this identity.');
    return item;
  };
  const view = item => structuredClone({ jobId: item.jobId, state: item.state, progress: item.progress, effectState: item.effectState,
    ...(item.result ? { result: item.result } : {}), ...(item.error ? { error: item.error } : {}) });
  return {
    register({ idemKey, input, ...context }) {
      if (typeof idemKey !== 'string' || !idemKey || Buffer.byteLength(idemKey) > 128) fail('SCHEMA_INVALID', 'A 1–128 byte job idemKey is required.');
      const ownerScope = scope(context); const key = hashJson([ownerScope, idemKey]); const digest = hashJson(input);
      const prior = ledger.get(key);
      if (prior) { if (prior.digest !== digest) fail('IDEMPOTENCY_CONFLICT', 'Job idemKey was used with different input.'); return view(jobs.get(prior.jobId)); }
      const item = { jobId: `job_${randomUUID()}`, scope: ownerScope, state: 'queued', progress: 0, effectState: 'none' };
      jobs.set(item.jobId, item); ledger.set(key, { jobId: item.jobId, digest }); return view(item);
    },
    start(jobId, context) {
      const item = find(jobId, context);
      if (item.state !== 'queued') fail('REVISION_CONFLICT', 'Only a queued job can start.');
      item.state = 'running'; return view(item);
    },
    settle(jobId, context, { result, error, effectState = 'none' } = {}) {
      const item = find(jobId, context);
      if (item.state === 'cancelled') return view(item);
      if (item.state !== 'running') fail('REVISION_CONFLICT', 'Only a running job can settle.');
      if (!['none', 'partial', 'committed', 'unknown'].includes(effectState) || Number(Boolean(result)) + Number(Boolean(error)) !== 1) fail('SCHEMA_INVALID', 'Provide one job result or error and a valid effectState.');
      item.state = error ? 'failed' : 'succeeded'; item.progress = 1; item.effectState = effectState;
      if (error) item.error = structuredClone(error); else item.result = structuredClone(result);
      return view(item);
    },
    // Library-only: frozen blender_job schemas do not include reconciliation or its audit fields.
    reconcile(jobId, context, { observed } = {}) {
      if (typeof context?.owner !== 'string' || !context.owner.trim()) fail('AUTHORIZATION_REQUIRED', 'Reconciliation requires an identified caller.');
      scope(context);
      const item = find(jobId, context);
      if (!observed || typeof observed !== 'object' || Array.isArray(observed)
        || !['applied', 'not-applied', 'still-unknown'].includes(observed.kind)
        || !observed.evidence || typeof observed.evidence !== 'object' || Array.isArray(observed.evidence)
        || !Object.keys(observed.evidence).length) fail('SCHEMA_INVALID', 'Provide an observed conclusion and non-empty external evidence.');
      const auditedView = () => structuredClone({ ...view(item), ...item.reconciliation });
      const previous = item.reconciliation;
      // Terminal retries are the sole exception to the unknown-only admission rule.
      if (previous && previous.observed.kind !== 'still-unknown') {
        if (previous.observed.kind !== observed.kind) fail('IDEMPOTENCY_CONFLICT', 'Job reconciliation already established a different conclusion.');
        return auditedView();
      }
      if (item.effectState !== 'unknown') fail('SCHEMA_INVALID', 'Only jobs with unknown effects can be reconciled.');
      let observation;
      try { observation = structuredClone(observed); }
      catch { fail('SCHEMA_INVALID', 'Observed evidence must be independently cloneable.'); }
      const from = view(item);
      const to = observed.kind === 'applied' ? { state: 'succeeded', effectState: 'committed' }
        : observed.kind === 'not-applied' ? { state: 'failed', effectState: 'none' }
          : { state: item.state, effectState: item.effectState };
      const audit = { reconciledAt: new Date().toISOString(), reconciledBy: context.owner, observed: observation, from, to };
      if (observed.kind !== 'still-unknown') {
        Object.assign(item, to, { progress: 1 });
        // Keep genuine receipts only; an observation is not an execution result or error.
        if (observed.kind === 'applied') delete item.error;
        else delete item.result;
      }
      item.reconciliation = { ...audit, reconciliationHistory: [...(previous?.reconciliationHistory ?? []), audit] };
      return auditedView();
    },
    execute(args, context) {
      const item = find(args.jobId, context);
      if (args.action === 'cancel' && ['queued', 'running'].includes(item.state)) {
        // Running work is not claimed rolled back; late receipts cannot turn cancellation into success.
        item.effectState = item.state === 'running' ? 'unknown' : 'none'; item.state = 'cancelled';
      }
      if (args.action === 'result' && ['queued', 'running'].includes(item.state)) fail('BUSY', 'Job has no terminal result yet.');
      return view(item);
    },
    dispose() { jobs.clear(); ledger.clear(); },
  };
}

/** Publish a frame from the already-bound workspace instance as immutable evidence. */
export function createBlenderCapture({ getViewport, getArtifactStore }) {
  return async (args, context, exec) => {
    if (args.source !== 'agentView') fail('CAPABILITY_UNAVAILABLE', `Capture source ${args.source} is not connected; only the bound agentView frame is available.`);
    if (args.checkpointId) fail('CAPABILITY_UNAVAILABLE', 'Checkpoint capture requires a checkpoint reader; a live frame cannot prove persisted state.');
    if (args.sequence) fail('CAPABILITY_UNAVAILABLE', 'Sequence capture requires a frame-sequence collector; only a single agentView frame is connected.');
    if (args.editorId || args.cameraId) fail('CAPABILITY_UNAVAILABLE', 'Editor and camera selection are not connected to agentView capture.');
    const viewport = getViewport(); const connection = viewport.status(context.workspaceKey)?.connection;
    if (!connection?.connected) fail('TARGET_NOT_BOUND', 'This workspace has no running Blender target; capture never starts one.');
    const size = args.size ?? { width: 960, height: 540 };
    const { png } = await viewport.frame({ input: [], size, editors: [] }, exec?.signal, context.workspaceKey, context.projectPath);
    const byteLength = png.length;
    if (byteLength > (args.budget?.maxOutputBytes ?? Infinity)) fail('OUTPUT_LIMIT', 'Captured PNG exceeds maxOutputBytes.');
    if (size.width * size.height > (args.budget?.maxTotalPixels ?? Infinity)) fail('OUTPUT_LIMIT', 'Captured frame exceeds maxTotalPixels.');
    // Evidence tokens authorize one publication only; the reserved namespace cannot authorize scene/view writes.
    const grantId = `evidence_${randomUUID()}`; const expiresAt = Date.now() + 30000; let active = true;
    const binding = { workspaceId: context.workspaceKey, actor: context.owner, targetId: args.targetId, generation: args.generation, runtimeGeneration: connection.runtimeGeneration };
    try {
      const published = await getArtifactStore().put({ ...binding, bytes: png, mediaType: 'image/png', grantId,
        authorizeStore: async request => {
          if (!active || Date.now() >= expiresAt) fail('GRANT_EXPIRED', 'Evidence publication token expired or was already used.');
          if (request.action !== 'artifact:write' || request.grantId !== grantId || request.workspaceId !== binding.workspaceId || request.actor !== binding.actor || request.targetId !== binding.targetId) fail('GRANT_SCOPE_MISMATCH', 'Evidence token only authorizes artifact:write for its bound caller, workspace and target.');
          if (request.generation !== binding.generation || request.runtimeGeneration !== binding.runtimeGeneration) fail('GENERATION_MISMATCH', 'Evidence token target generation changed.');
          await context.assertCaptureScope();
          const current = viewport.status(context.workspaceKey)?.connection;
          if (!current?.connected || current.runtimeGeneration !== binding.runtimeGeneration) fail('GENERATION_MISMATCH', 'Evidence token runtime generation changed.');
          if (!active || Date.now() >= expiresAt) fail('GRANT_EXPIRED', 'Evidence publication token expired or was already used.');
          active = false; return true;
        } });
      return { artifactId: published.artifactId, sha256: published.sha256, mediaType: 'image/png', width: size.width, height: size.height, capturedAt: new Date().toISOString() };
    } finally { active = false; }
  };
}

/** Tool fields are supplied only by the schema SSOT; this module owns behavior, not a second schema. */
export function createBlenderTools({ getViewport, coordinator, resolveContext, getDisclosure = () => null, specStore = null, artifactStore = null, getSpecStore = () => specStore, getArtifactStore = () => artifactStore, referenceAnalyze = null, verify = null, capture = null, job = null, jobStore = createBlenderJobStore() } = {}) {
  const plans = new Map();
  const unavailable = (name, action) => {
    const missing = { blender_project: 'an in-process project lifecycle handler for the requested action', blender_scene_query: 'runtime serializer for requested kind/fields/cursor', blender_scene_apply: 'runtime object.ensure mesh implementation (use mesh.primitive)', blender_spec_apply: 'authorized immutable artifact reader', blender_spec_revision: 'authorized SpecStore service', blender_view: 'runtime handler for requested view fields', blender_capture: 'authorized capture/checkpoint artifact publisher', blender_verify: 'independent assertion observer and report publisher', blender_reference_analyze: 'reference analysis pipeline service', blender_job: 'background worker job registry' }[name] ?? 'verified runtime implementation';
    fail('CAPABILITY_UNAVAILABLE', `${name}.${action} requires ${missing}.`, { tool: name, action, missingService: missing, recovery: 'Inspect blender_capabilities; choose an implemented action.' });
  };
  async function contextFor(exec) {
    const context = await resolveContext(exec);
    if (!context?.workspaceKey || !context?.owner) fail('AUTHORIZATION_REQUIRED', 'A proven session and workspace are required.');
    return context;
  }
  function storageRequest(context, record, args, exec) {
    const generation = record.generation;
    return { workspaceId: context.workspaceKey, actor: context.owner, grantId: args.grantId,
      authorizeStore: async request => {
        const fresh = await contextFor(exec);
        if (fresh.workspaceKey !== context.workspaceKey || fresh.owner !== context.owner) fail('CONFIG_STALE', 'Storage caller or workspace changed.');
        if (request.workspaceId !== context.workspaceKey || request.actor !== context.owner) return false;
        if (['artifact:write', 'spec:create', 'spec:commit'].includes(request.action)) {
          const current = coordinator.record(fresh);
          if (current.generation !== generation) fail('GENERATION_MISMATCH', 'Storage authorization target changed.');
          coordinator.assertGrant(request.grantId, fresh, current, 'scene');
        }
        return true;
      } };
  }
  async function analyzeBasic(args, context, record, exec, artifactStore) {
    coordinator.assertGrant(args.grantId, context, record, 'scene');
    if ((args.profile ?? 'basic') !== 'basic' || args.pipelineVersion && args.pipelineVersion !== 'cpu-basic-png-1.0.0') fail('CAPABILITY_UNSUPPORTED', 'Only the cpu-basic-png-1.0.0 basic pipeline is implemented.');
    const request = storageRequest(context, record, args, exec);
    const sourceIds = new Set(args.references.map(item => item.sourceId));
    if (sourceIds.size !== args.references.length || (args.regions ?? []).some(region => !sourceIds.has(region.sourceId)) || (args.anchors ?? []).some(anchor => !sourceIds.has(anchor.sourceId))) fail('SEMANTIC_INVALID', 'Reference source IDs must be unique and every ROI/anchor must name an input source.');
    const inputs = []; const unresolved = [];
    for (const reference of args.references) {
      if (!reference.artifactId || reference.gallery) fail('EVIDENCE_INCOMPLETE', 'CPU basic analysis requires a frozen input artifact; gallery IDs are not artifact identities.');
      const frozen = await artifactStore.get({ ...request, artifactId: reference.artifactId, ...(reference.sha256 ? { sha256: reference.sha256 } : {}) });
      const normalized = normalizeReferenceImage(frozen.bytes, { frameIndex: reference.frameIndex });
      const product = await artifactStore.put({ ...request, bytes: normalized.bytes, mediaType: normalized.mediaType });
      const regions = (args.regions ?? []).filter(region => region.sourceId === reference.sourceId).map(region => ({ regionId: region.regionId, ...createRoiMapping({ widthPx: normalized.widthPx, heightPx: normalized.heightPx, rectPx: region.rectPx }) }));
      const readPixels = mapping => {
        const [left, top, width, height] = mapping.rectPx; const sums = [0, 0, 0, 0];
        for (let y = top; y < top + height; y++) for (let x = left; x < left + width; x++) for (let c = 0; c < 4; c++) sums[c] += normalized.pixels[(y * normalized.widthPx + x) * 4 + c];
        return { meanRgba: sums.map(value => value / (width * height)), sampledPixels: width * height };
      };
      const whole = createRoiMapping({ widthPx: normalized.widthPx, heightPx: normalized.heightPx });
      inputs.push({ sourceId: reference.sourceId, source: { artifactId: frozen.artifactId, sha256: frozen.sha256 }, artifactId: product.artifactId, sha256: product.sha256,
        widthPx: normalized.widthPx, heightPx: normalized.heightPx, decoder: normalized.decoder, configSha256: normalized.configSha256,
        confidence: { dimensions: 1, pixelRead: 1, geometry: null }, undecidable: ['physical scale', 'hidden geometry', 'material identity'], assumptions: normalized.assumptions,
        pixels: readPixels(whole), regions: regions.map(region => ({ ...region, pixels: readPixels(region) })) });
    }
    for (const anchor of args.anchors ?? []) unresolved.push({ stageId: 'metric-calibration', code: 'CAPABILITY_UNSUPPORTED', sourceIds: [anchor.sourceId], detail: 'CPU basic does not infer 3D scale from anchors.' });
    const report = { contractVersion: 1, profile: 'basic', pipelineVersion: 'cpu-basic-png-1.0.0', source: 'frozen-artifact', confidence: { pixelRead: 1, geometry: null },
      undecidable: ['3D geometry and physical dimensions require additional observations.'], inputs, unresolved };
    const published = await artifactStore.put({ ...request, bytes: canonicalize(report), mediaType: 'application/json' });
    return { resultArtifactId: published.artifactId, sha256: published.sha256, status: unresolved.length ? 'partial' : 'complete', completedStages: ['normalize', 'roi-mapping', 'pixel-read'], unresolved };
  }
  async function verifyBasic(args, context, record, exec, artifactStore) {
    coordinator.assertGrant(args.grantId, context, record, 'scene');
    const request = storageRequest(context, record, args, exec); let observation = null; let reason = null;
    if (args.source === 'live') {
      const queried = await execute('blender_scene_query', { action: 'query', live: { targetId: args.targetId, generation: args.generation }, kind: 'scene', ids: [...new Set(args.assertions.map(item => item.subject))], limit: 1000 }, exec);
      observation = queried.data;
    } else if (args.source === 'artifact') {
      if (!args.artifactId || !args.sha256) fail('SEMANTIC_INVALID', 'Artifact verification requires artifactId and sha256.');
      const frozen = await artifactStore.get({ ...request, artifactId: args.artifactId, sha256: args.sha256 });
      if (frozen.mediaType !== 'application/json') fail('EVIDENCE_INCOMPLETE', 'Structural verification requires a JSON scene-query artifact.');
      observation = parseStrictJson(frozen.bytes.toString('utf8'));
      if (!Array.isArray(observation.items) || typeof observation.truncated !== 'boolean') fail('EVIDENCE_INCOMPLETE', 'Artifact lacks scene-query items and explicit completeness.');
    } else reason = 'Checkpoint reader is unavailable; live memory cannot prove persistence.';
    const assertions = args.assertions.map(assertion => {
      const item = observation?.items.find(item => item.stableId === assertion.subject);
      let status = 'unknown'; let actual = null; let limitation = reason;
      if (!reason && assertion.kind === 'exists') {
        if (typeof assertion.expected !== 'boolean') fail('SEMANTIC_INVALID', 'exists.expected must be boolean.');
        actual = item ? true : observation.truncated ? null : false;
        if (actual !== null) status = actual === assertion.expected ? 'pass' : 'fail';
        else limitation = 'Truncated observation cannot prove absence.';
      } else if (!reason && assertion.kind === 'transform' && item && assertion.expected && typeof assertion.expected === 'object') {
        const expected = assertion.expected;
        if (Object.keys(expected).length === 1 && Array.isArray(expected.scale) && expected.scale.length === 3 && expected.scale.every(Number.isFinite) && Array.isArray(item.scale) && item.scale.length === 3 && item.scale.every(Number.isFinite) && (!assertion.tolerance || assertion.tolerance.unit === 'ratio')) {
          actual = { scale: item.scale }; const tolerance = assertion.tolerance?.value ?? 0;
          status = item.scale.every((value, index) => Math.abs(value - expected.scale[index]) <= tolerance) ? 'pass' : 'fail';
        } else limitation = 'Only local transform.scale with ratio tolerance is currently readable without unit assumptions.';
      } else if (!reason) limitation = 'No independent reader for this assertion kind or subject.';
      return { id: assertion.id, kind: assertion.kind, subject: assertion.subject, expected: assertion.expected, status, actual, ...(limitation ? { limitation } : {}) };
    });
    const status = assertions.some(item => item.status === 'fail') ? 'fail' : assertions.some(item => item.status === 'unknown') ? 'inconclusive' : 'pass';
    const report = { contractVersion: 1, source: args.source, ...(args.source === 'live' ? { targetId: record.targetId, generation: record.generation, runtimeGeneration: record.runtimeGeneration, sceneRevision: observation.sceneRevision } : { artifactId: args.artifactId ?? null, sha256: args.sha256 ?? null, checkpointId: args.checkpointId ?? null }), status, assertions, observation };
    const published = await artifactStore.put({ ...request, bytes: canonicalize(report), mediaType: 'application/json' });
    return { reportArtifactId: published.artifactId, status, assertions, summary: 'Structural evidence only; unsupported or incomplete observations remain unknown.' };
  }
  async function command(record, context, op, payload, exec, beforeSend = null) {
    const refreshed = await contextFor(exec);
    if (refreshed.workspaceKey !== context.workspaceKey || refreshed.owner !== context.owner) fail('CONFIG_STALE', 'Calling workspace or principal changed.');
    const viewport = getViewport();
    if (!/^[a-f0-9]{32}$/.test(record.runtimeGeneration ?? '')) fail('GENERATION_MISMATCH', 'Runtime generation has not been observed as a 32 digit hex token.');
    // Reads must never call ensure() on a cold workspace. The manager owns the sole process pool.
    if (!viewport.status(context.workspaceKey)?.connection?.connected) fail('TARGET_NOT_BOUND', 'No running Blender target in this workspace.');
    const send = (operation, body) => {
      const current = viewport.status(context.workspaceKey);
      if (!current?.connection?.connected || current.connection.runtimeGeneration !== record.runtimeGeneration) fail('GENERATION_MISMATCH', 'Running workspace target changed before dispatch.');
      return viewport.command({ id: randomUUID(), targetId: record.targetId, generation: record.generation,
        runtimeGeneration: record.runtimeGeneration, op: operation, payload: body }, exec.signal, context.workspaceKey, context.projectPath);
    };
    try {
      if (!viewport.status(context.workspaceKey).connection.hello) await send('hello', {});
      if (beforeSend) await beforeSend(refreshed);
      return await send(op, payload);
    } catch (error) {
      const mapped = mappedError(error);
      if (!['hello', 'scene.query', 'view.get'].includes(op) && ['BLENDER_COMMAND_FAILED', 'BLENDER_COMMAND_UNKNOWN', 'BLENDER_PROTOCOL_MISMATCH'].includes(error?.code)) mapped.details.effectState = 'unknown';
      throw mapped;
    }
  }
  function envelope(name, action, data, effectState = 'none') {
    const value = { tool: name, action, ok: true, data, evidenceIds: [], effectState };
    const checked = validateToolOutput(name, value);
    if (!checked.valid) fail('EVIDENCE_INCOMPLETE', 'Tool result failed the declared output contract.', { errors: checked.errors });
    return value;
  }
  async function execute(name, args, exec = {}) {
    // Validation precedes context, probing, process lookup, grants, and all I/O.
    assertBlenderInput(name, args);
    const action = blenderAction(name, args);
    const specStore = getSpecStore(); const artifactStore = getArtifactStore();
    if (name === 'blender_tools') {
      const disclosure = getDisclosure();
      if (!disclosure) fail('CAPABILITY_UNAVAILABLE', 'Tool disclosure is not connected.');
      const status = disclosure.execute({ action: args.action, ...(args.groups ? { groups: args.groups } : {}) }, exec.agent);
      return envelope(name, action, { enabledGroups: status.selected, availableTools: status.nextRequestTools.filter(tool => tool.startsWith('blender_')) });
    }
    if (name === 'blender_capabilities') {
      let dependency;
      try { dependency = await getViewport().probe(); }
      catch (error) { dependency = { available: false, code: 'DEPENDENCY_MISSING', reason: error.message }; }
      const context = await resolveContext(exec).catch(() => null);
      const status = context?.workspaceKey ? getViewport().status(context.workspaceKey) : null;
      return envelope(name, action, {
        catalogVersion: blenderManifest.catalogVersion, blenderBaseline: blenderManifest.blenderBaseline,
        operations: blenderManifest.operations.filter(op => !args.opId || op.opId === args.opId),
        declaration: { tools: blenderManifest.tools, implementedCommands: ['hello', 'scene.query', 'scene.apply', 'project.save', 'view.get', 'view.set'],
          limitations: ['Grants are process-local challenges without human approval; reload invalidates all grants and leases.', 'Evidence publication uses a process-local self-issued evidence token without human approval; it shares the A1-09 authorization limitation.', 'Revision tracking covers tool writes; independent panel edits need fresh observation.',
            ...projectLifecycleLimitations,
            capture ? 'Only agentView capture is available; humanView/checkpoint/sequence and editor/camera selection are not connected.' : 'Capture publisher is not connected; humanView/checkpoint/sequence are also unavailable.',
            'Scene query supports kind=scene without fields/cursor/meshSource; object.ensure supports empty only. View set supports rotation/distance/projection only.',
            'Verification reads exists and local transform.scale (ratio tolerance); other kinds and checkpoint persistence remain unknown.',
            'Reference basic accepts frozen PNG artifacts only; gallery, spatial/multiview inference and metric anchors require additional services.',
            'Jobs are process-local registrations with no automatic over-budget dispatcher; unknown effects can be reconciled only through the library-level createBlenderJobStore().reconcile(jobId, context, { observed }) using caller-supplied external evidence. Reconciliation is not exposed by the frozen blender_job tool schema.'],
          unavailableActions: ['project.open', 'project.reload', 'project.saveAs', 'project.close', ...(!specStore ? ['spec_revision.create', 'spec_revision.get', 'spec_revision.commit'] : []), ...(!artifactStore ? ['spec_apply.artifact'] : []), ...(!referenceAnalyze && !artifactStore ? ['reference_analyze'] : []), ...(!capture ? ['capture'] : []), 'capture.humanView', 'capture.checkpoint', 'capture.sequence', ...(!verify && !artifactStore ? ['verify'] : []), ...(!job && !jobStore ? ['job.status', 'job.result', 'job.cancel'] : [])] }, 
        readiness: { support: { status: 'supported' }, enabled: { status: 'true' }, dependency: { status: dependency.available && dependency.compatible ? 'ok' : 'failed', evidence: dependency }, connection: { status: status?.connection?.connected ? 'ok' : 'not-probed' }, target: { status: status?.connection?.connected ? 'ok' : 'unbound' }, capability: { status: status?.connection?.hello ? 'partial' : 'not-probed' } },
        limits: { sceneBatch: 32, sceneRequest: 100, syncTimeoutMs: 30000 },
        observed: status?.connection?.hello ? { ...status.connection.hello, runtimeGeneration: status.connection.runtimeGeneration } : null,
      });
    }
    const context = await contextFor(exec);
    const record = coordinator.record(context);
    const live = args.live ?? (args.targetId ? { targetId: args.targetId, generation: args.generation } : null);
    if (typeof args.grantId === 'string' && args.grantId.startsWith('evidence_') && ((['blender_scene_apply', 'blender_spec_apply'].includes(name) && args.mode === 'apply') || (name === 'blender_view' && action === 'set'))) fail('GRANT_SCOPE_MISMATCH', 'Evidence publication tokens cannot authorize scene or view writes.');
    if (name === 'blender_control') return envelope(name, action, coordinator.control(args, context, record));
    if (name === 'blender_project' && action === 'list') return envelope(name, action, { projects: record.connected ? [{ live: { targetId: record.targetId, generation: record.generation } }] : [] });
    if (name === 'blender_project' && action === 'status') {
      coordinator.assertLive(live, record);
      return envelope(name, action, { live, sceneRevision: record.sceneRevision, dirty: record.dirty, status: record.connected ? 'open' : 'closed' });
    }
    if (name === 'blender_scene_query') {
      coordinator.assertLive(live, record);
      if (args.kind !== 'scene' || args.cursor || args.fields?.length || args.meshSource) return unavailable(name, args.kind);
      const value = await command(record, context, 'scene.query', { ...(args.ids ? { ids: args.ids } : {}), limit: args.limit ?? 1000 }, exec);
      return envelope(name, action, { sceneRevision: record.sceneRevision, items: value.objects, truncated: value.objects.length >= (args.limit ?? 1000), nextCursor: null });
    }
    if (name === 'blender_view' && action === 'get') {
      coordinator.assertLive(live, record);
      const result = await command(record, context, 'view.get', {}, exec);
      return envelope(name, action, { view: { ...result, projection: result.projection === 'ORTHO' ? 'orthographic' : result.projection === 'PERSP' ? 'perspective' : result.projection }, viewRevision: record.viewRevision });
    }
    if (name === 'blender_scene_apply' || name === 'blender_spec_apply') {
      coordinator.assertLive(live, record);
      let ops = args.ops;
      let compilation;
      if (name === 'blender_spec_apply') {
        if (Number(args.scene !== undefined) + Number(args.artifactId !== undefined) !== 1) fail('SCHEMA_INVALID', 'Provide exactly one of scene or artifactId.', { instancePath: '/scene' });
        let scene = args.scene;
        if (!scene) {
          if (!artifactStore) return unavailable(name, 'artifact');
          const artifact = await artifactStore.get({ ...storageRequest(context, record, args, exec), artifactId: args.artifactId });
          scene = parseStrictJson(artifact.bytes.toString('utf8'));
        }
        compilation = compileScene(scene, { binding: { targetId: record.targetId, generation: record.generation, sceneRevision: record.sceneRevision } });
        if (compilation.unresolved.some(item => item.status === 'blocked')) fail('SEMANTIC_INVALID', 'Specification contains blocked operations.', { unresolved: compilation.unresolved });
        ops = compilation.ops.map((op, index) => ({ opId: op.opId, args: op.args, opVersion: 1, stepId: `step_${index}` }));
      }
      if (!ops?.length) fail('SEMANTIC_INVALID', 'Plan contains no executable operations.');
      if (new Set(ops.map(op => op.stepId)).size !== ops.length) fail('SEMANTIC_INVALID', 'stepId must be unique.', { instancePath: '/ops' });
      const normalized = ops.map(op => ({ ...op, args: op.opId === 'mesh.primitive' && op.args.shape.kind !== 'box'
        ? { ...op.args, shape: { ...op.args.shape, segments: op.args.shape.segments ?? 32 } } : op.args }));
      if (normalized.some(op => op.opId === 'object.ensure' && op.args.kind !== 'empty')) return unavailable(name, 'object.ensure.mesh');
      const inputHash = hashJson({ name, input: args.scene ?? args.artifactId ?? args.ops });
      if (args.mode === 'plan') {
        const planId = `plan_${randomUUID()}`;
        const plan = { planId, inputHash, owner: context.owner, workspaceKey: context.workspaceKey, targetId: record.targetId, generation: record.generation, sceneRevision: record.sceneRevision, ops: normalized };
        plan.planHash = hashJson(plan); plans.set(planId, plan);
        return envelope(name, action, { planId, planHash: plan.planHash, sceneRevision: record.sceneRevision, steps: normalized, status: 'planned', ...(compilation ? { sceneId: compilation.sceneId, specRevision: compilation.specRevision } : {}) });
      }
      const token = coordinator.begin(args, context, record, 'scene');
      if (token.replay) return structuredClone(token.replay);
      try {
        const plan = plans.get(args.planId);
        if (!plan || plan.owner !== context.owner || plan.workspaceKey !== context.workspaceKey || plan.targetId !== record.targetId || plan.generation !== record.generation || plan.sceneRevision !== record.sceneRevision || plan.inputHash !== inputHash) fail('PLAN_STALE', 'Plan is missing, changed or stale.');
        coordinator.assertGrant(args.approvalGrantId, context, record, 'scene');
        const results = [];
        for (let offset = 0; offset < plan.ops.length; offset += 32) {
          // Transport accepts exactly {opId,args}; opVersion/stepId stay in the audited plan.
          const batch = plan.ops.slice(offset, offset + 32).map(({ opId, args: opArgs }) => ({ opId, args: opArgs }));
          let result;
          try { result = await command(record, context, 'scene.apply', { ops: batch }, exec); }
          catch (error) { error.details = { ...error.details, effectState: 'unknown', committedSteps: results.length }; throw error; }
          results.push(...result.results); record.sceneRevision++; record.dirty = true;
        }
        const value = envelope(name, action, { planId: plan.planId, planHash: plan.planHash, sceneRevision: record.sceneRevision, steps: results, status: 'committed', ...(compilation ? { sceneId: compilation.sceneId, specRevision: compilation.specRevision } : {}) }, 'committed');
        coordinator.finish(token, value); return value;
      } catch (error) { coordinator.finish(token, null, error); throw error; }
    }
    if (name === 'blender_view' && action === 'set') {
      const token = coordinator.begin(args, context, record, 'view');
      if (token.replay) return structuredClone(token.replay);
      try {
        if (!Object.keys(args.changes).length || Object.keys(args.changes).some(key => !['rotation', 'distance', 'projection'].includes(key))) return unavailable(name, 'set.fields');
        const changes = { ...args.changes, ...(args.changes.projection ? { projection: args.changes.projection === 'perspective' ? 'PERSP' : 'ORTHO' } : {}) };
        const result = await command(record, context, 'view.set', { changes }, exec);
        record.viewRevision++;
        const value = envelope(name, action, { view: result, viewRevision: record.viewRevision, changed: true }, 'committed');
        coordinator.finish(token, value); return value;
      } catch (error) { coordinator.finish(token, null, error); throw error; }
    }
    if (name === 'blender_project' && ['open', 'reload'].includes(action)) return unavailableProject(action);
    if (name === 'blender_project' && ['save', 'saveAs', 'close'].includes(action)) {
      const boundPath = getViewport().status(context.workspaceKey)?.projectPath;
      if (action === 'save' && !boundPath) return unavailableProject(action);
      const token = coordinator.begin(args.write, context, record, 'project', args);
      if (token.replay) return structuredClone(token.replay);
      let dispatched = false;
      try {
        if (action === 'close') {
          if (record.dirty) fail('PROJECT_DIRTY', 'Project has tracked unsaved changes; save before closing.');
          return unavailableProject(action);
        }
        const path = await workspaceProjectPath(context, action === 'saveAs' ? args.path : boundPath);
        const compare = async () => {
          const actualFileHash = await projectFileHash(path);
          if ((action === 'save' || actualFileHash !== null) && (!args.expectedFileHash || args.expectedFileHash !== actualFileHash)) {
            fail('PROJECT_CONFLICT', 'Project file hash does not match the expected disk state.', { expectedFileHash: args.expectedFileHash ?? null, actualFileHash });
          }
          if (action === 'saveAs' && actualFileHash !== null && !args.overwriteGrantId) fail('PROJECT_CONFLICT', 'An existing saveAs destination requires an overwriteGrantId.', { expectedFileHash: args.expectedFileHash ?? null, actualFileHash });
          if (args.overwriteGrantId) {
            try { coordinator.assertGrant(args.overwriteGrantId, context, record, 'project'); }
            catch (error) {
              if (action === 'saveAs' && actualFileHash !== null) fail('PROJECT_CONFLICT', 'An existing saveAs destination requires valid project overwrite authorization.', { expectedFileHash: args.expectedFileHash ?? null, actualFileHash, authorizationCode: error.code });
              throw error;
            }
          }
          coordinator.assertGrant(args.write.grantId, context, record, 'project');
        };
        await compare();
        if (action === 'saveAs') return unavailableProject(action);
        // Blender save_as_mainfile owns atomic file saving. This is a Node preflight and post-write verification,
        // not an external-writer CAS and never a temporary-file + rename substitute for Blender saving.
        const result = await command(record, context, 'project.save', {}, exec, async fresh => {
          if (fresh.workspaceRoot !== context.workspaceRoot) fail('CONFIG_STALE', 'Workspace root changed before project save.');
          coordinator.assertLive(args.write, coordinator.record(fresh));
          coordinator.assertGrant(args.write.grantId, fresh, record, 'project');
          if (getViewport().status(context.workspaceKey)?.projectPath !== boundPath) fail('PROJECT_CONFLICT', 'Bound project path changed before save.');
          if (await workspaceProjectPath(fresh, boundPath) !== path) fail('PROJECT_CONFLICT', 'Resolved project path changed before save.');
          await compare();
          dispatched = true;
        });
        if (result?.saved !== true) fail('EVIDENCE_INCOMPLETE', 'Runtime did not confirm the project save.', { effectState: 'unknown' });
        const fileHash = await projectFileHash(path);
        if (!fileHash) fail('EVIDENCE_INCOMPLETE', 'Saved project cannot be hashed after the runtime receipt.', { effectState: 'unknown' });
        coordinator.assertLive(args.write, coordinator.record(context));
        if (getViewport().status(context.workspaceKey)?.projectPath !== boundPath || await workspaceProjectPath(context, boundPath) !== path) fail('PROJECT_CONFLICT', 'Bound project path changed after save.', { effectState: 'unknown' });
        record.dirty = false;
        const value = envelope(name, action, { project: result, live: { targetId: record.targetId, generation: record.generation }, sceneRevision: record.sceneRevision, path, fileHash, dirty: false, status: 'saved' }, 'committed');
        coordinator.finish(token, value); return value;
      } catch (error) {
        const mapped = mappedError(error);
        if (dispatched) mapped.details.effectState = 'unknown';
        coordinator.finish(token, null, mapped); throw mapped;
      }
    }
    if (name === 'blender_spec_revision' && specStore) {
      const request = { ...args, ...storageRequest(context, record, args, exec) };
      if (action !== 'get') coordinator.assertGrant(args.grantId, context, record, 'scene');
      const result = await specStore[action](request);
      const data = Object.fromEntries(Object.entries(result).filter(([key]) => ['sceneId', 'revision', 'artifactId', 'sha256', 'receiptId', 'scene', 'patch'].includes(key)));
      return envelope(name, action, data, action === 'get' ? 'none' : 'committed');
    }
    const service = { blender_reference_analyze: referenceAnalyze, blender_capture: capture, blender_verify: verify, blender_job: job }[name];
    if (typeof service === 'function') {
      let assertCaptureScope;
      if (name === 'blender_capture') {
        coordinator.assertLive(live, record);
        assertCaptureScope = async () => {
          const fresh = await contextFor(exec);
          if (fresh.workspaceKey !== context.workspaceKey || fresh.owner !== context.owner) fail('GRANT_SCOPE_MISMATCH', 'Evidence publication caller or workspace changed.');
          coordinator.assertLive(live, coordinator.record(fresh));
        };
      }
      return envelope(name, action, await service(args, { ...context, exec, ...(assertCaptureScope ? { assertCaptureScope } : {}) }, exec));
    }
    if (name === 'blender_reference_analyze' && artifactStore) return envelope(name, action, await analyzeBasic(args, context, record, exec, artifactStore));
    if (name === 'blender_verify' && artifactStore) return envelope(name, action, await verifyBasic(args, context, record, exec, artifactStore));
    if (name === 'blender_job' && jobStore) {
      if (action === 'cancel') coordinator.assertGrant(args.grantId, context, record, 'scene');
      return envelope(name, action, jobStore.execute(args, context));
    }
    return unavailable(name, action);
  }
  return toolDefinitions.map(definition => ({ ...definition, parameters: hostParameters(definition.parameters), output: { schema: hostSchema(definition.outputSchema),
    render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }] }, execute: (args, exec) => execute(definition.name, args, exec).catch(error => { throw mappedError(error); }) }));
}
