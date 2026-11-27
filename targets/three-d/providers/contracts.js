import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';

const root = JSON.parse(readFileSync(new URL('./schemas/contracts.v1.schema.json', import.meta.url), 'utf8'));
export const schemas = deepFreeze(root.$defs);
export const CONTRACT_VERSION = 1;
export const CAPABILITY_IDS = Object.freeze(['vision.image.normalize', 'vision.mask.segment', 'vision.depth.relative', 'vision.depth.metric', 'vision.surface.normal', 'vision.camera.intrinsics', 'vision.camera.pose', 'vision.pointcloud', 'vision.gaussian_splat', 'vision.spatial.semantic', 'vision.measurement', 'agent.vision.analyze', 'agent.vision.review', 'agent.modeling.execute', 'geometry.primitive.fit', 'geometry.mesh.inspect', 'verification.scene.structure', 'verification.geometry', 'verification.visual', 'verification.project.reopen']);
export class ProviderError extends Error {
  constructor(code, reason, details = {}) {
    super(reason); this.name = 'ProviderError'; this.code = code;
    this.details = Object.freeze({ ...details, reason });
    this.retryable = code === 'PROVIDER_TIMEOUT';
    this.category = ({ PROVIDER_OUTPUT_INVALID: 'evidence', MODEL_ASSET_INVALID: 'evidence', RESOURCE_BUDGET_EXCEEDED: 'resource', PRIVACY_POLICY_DENIED: 'authorization', CAPABILITY_POLICY_CONFLICT: 'config', PROVIDER_DISABLED: 'config' })[code] ?? 'environment';
  }
}
export function deepFreeze(value) {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) { Object.values(value).forEach(deepFreeze); Object.freeze(value); }
  return value;
}
export function canonical(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`;
}
export const sha256 = value => createHash('sha256').update(typeof value === 'string' || Buffer.isBuffer(value) ? value : canonical(value)).digest('hex');
export const snapshot = value => deepFreeze(structuredClone(value));

// This evaluator consumes the JSON Schema SSOT. Unsupported keywords fail closed.
const supported = new Set(['$schema', '$id', '$defs', '$ref', 'type', 'properties', 'required', 'additionalProperties', 'items', 'minItems', 'uniqueItems', 'enum', 'const', 'anyOf', 'minLength', 'pattern', 'format', 'minimum', 'maximum']);
function inspect(schema, value, path, errors) {
  for (const key of Object.keys(schema)) if (!supported.has(key)) throw new Error(`Unsupported schema keyword: ${key}`);
  if (schema.$ref) {
    const key = schema.$ref.split('#/$defs/')[1];
    if (!schemas[key]) throw new Error(`Unknown schema reference: ${schema.$ref}`);
    inspect(schemas[key], value, path, errors); return;
  }
  if (schema.anyOf) {
    if (!schema.anyOf.some(option => { const e = []; inspect(option, value, path, e); return e.length === 0; })) errors.push(`${path}: no anyOf branch matched`);
    return;
  }
  if ('const' in schema && canonical(value) !== canonical(schema.const)) errors.push(`${path}: invalid constant`);
  if (schema.enum && !schema.enum.includes(value)) errors.push(`${path}: unsupported value`);
  if (schema.type) {
    const matches = schema.type === 'null' ? value === null : schema.type === 'array' ? Array.isArray(value) : schema.type === 'object' ? value !== null && typeof value === 'object' && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype : schema.type === 'integer' ? Number.isSafeInteger(value) : schema.type === 'number' ? typeof value === 'number' && Number.isFinite(value) : typeof value === schema.type;
    if (!matches) { errors.push(`${path}: expected ${schema.type}`); return; }
  }
  if (typeof value === 'number') {
    if (schema.minimum != null && value < schema.minimum) errors.push(`${path}: below minimum`);
    if (schema.maximum != null && value > schema.maximum) errors.push(`${path}: above maximum`);
  }
  if (typeof value === 'string') {
    if (schema.minLength != null && value.length < schema.minLength) errors.push(`${path}: too short`);
    if (schema.pattern && !new RegExp(schema.pattern).test(value)) errors.push(`${path}: invalid pattern`);
    if (schema.format === 'date-time') {
      const parsed = Date.parse(value);
      if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/.test(value) || Number.isNaN(parsed) || new Date(parsed).toISOString().slice(0, 19) !== value.slice(0, 19)) errors.push(`${path}: expected UTC timestamp`);
    }
  }
  if (Array.isArray(value)) {
    if (schema.minItems != null && value.length < schema.minItems) errors.push(`${path}: too few items`);
    if (schema.uniqueItems && new Set(value.map(canonical)).size !== value.length) errors.push(`${path}: duplicate items`);
    if (schema.items) value.forEach((item, index) => inspect(schema.items, item, `${path}[${index}]`, errors));
  }
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    for (const key of schema.required ?? []) if (!Object.hasOwn(value, key)) errors.push(`${path}.${key}: required`);
    for (const [key, item] of Object.entries(value)) {
      if (schema.properties?.[key]) inspect(schema.properties[key], item, `${path}.${key}`, errors);
      else if (schema.additionalProperties === false) errors.push(`${path}.${key}: unknown field`);
    }
  }
}
export function validate(name, value) {
  if (!schemas[name]) throw new Error(`Unknown contract: ${name}`);
  const errors = []; inspect(schemas[name], value, '$', errors);
  return Object.freeze({ valid: errors.length === 0, errors: Object.freeze(errors) });
}
export function assertContract(name, value) {
  const result = validate(name, value);
  if (!result.valid) throw new ProviderError('PROVIDER_OUTPUT_INVALID', 'provider-output-invalid', { contract: name, errors: result.errors });
  return value;
}
export function validateManifest(manifest, { extensionValidator } = {}) {
  assertContract('providerManifest', manifest);
  if (manifest.extensions && (typeof extensionValidator !== 'function' || extensionValidator(manifest.extensions.schemaRef, manifest.extensions.data) !== true)) throw new ProviderError('PROVIDER_OUTPUT_INVALID', 'extension-schema-not-validated');
  const ids = manifest.capabilities.map(capability => capability.capabilityId);
  if (new Set(ids).size !== ids.length) throw new ProviderError('PROVIDER_OUTPUT_INVALID', 'duplicate-provider-capability');
  if (manifest.runtime.mode === 'local' && manifest.privacy.inputsLeaveMachine) throw new ProviderError('PROVIDER_OUTPUT_INVALID', 'manifest-privacy-inconsistent');
  // Unknown capability identifiers remain discoverable, but the Resolver never executes them.
  return snapshot({ manifest, diagnostics: ids.filter(id => !CAPABILITY_IDS.includes(id)).map(capabilityId => ({ capabilityId, reason: 'unknown-provider-capability' })) });
}
