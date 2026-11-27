import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const moduleRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
export const BLENDER_SCHEMA_ROOT = path.join(moduleRoot, 'schemas/blender');
export const SCENE_SCHEMA_ID = 'urn:dsh:blender:scene-specification:1.0.0';
export const COMMON_SCHEMA_ID = 'urn:dsh:blender:common:1';
export const SCHEMA_DIALECT = 'https://json-schema.org/draft/2020-12/schema';
export const TOOL_NAMES = Object.freeze([
  'blender_tools', 'blender_capabilities', 'blender_control', 'blender_project',
  'blender_scene_query', 'blender_scene_apply', 'blender_view', 'blender_capture',
  'blender_verify', 'blender_reference_analyze', 'blender_spec_revision',
  'blender_spec_apply', 'blender_job'
]);
export const OP_IDS = Object.freeze([
  'collection.ensure', 'object.ensure', 'object.parent', 'object.transform',
  'mesh.primitive', 'object.remove', 'material.ensure', 'material.assign'
]);

const files = new Map([
  [COMMON_SCHEMA_ID, 'tools/v1/common.schema.json'],
  [SCENE_SCHEMA_ID, 'scene-specification/1.0.0.schema.json']
]);
for (const name of TOOL_NAMES) {
  files.set(`urn:dsh:blender:tool:${name}:input:v1`, `tools/v1/${name}.input.schema.json`);
  files.set(`urn:dsh:blender:tool:${name}:output:v1`, `tools/v1/${name}.output.schema.json`);
}
for (const opId of OP_IDS) files.set(`urn:dsh:blender:operation:${opId}:v1`, `operations/v1/${opId}.schema.json`);
files.set('urn:dsh:blender:reference-analysis:request:v1', 'reference-analysis/v1/request.schema.json');
files.set('urn:dsh:blender:reference-analysis:result:v1', 'reference-analysis/v1/result.schema.json');
const cache = new Map();
const readJson = (filename) => {
  if (!cache.has(filename)) cache.set(filename, JSON.parse(fs.readFileSync(path.join(BLENDER_SCHEMA_ROOT, filename), 'utf8')));
  return cache.get(filename);
};

function normalizeRef(schemaRef) {
  if (typeof schemaRef !== 'string' || schemaRef.length === 0) throw new TypeError('schemaRef must be a non-empty string');
  const hash = schemaRef.indexOf('#');
  const baseRef = hash >= 0 ? schemaRef.slice(0, hash) : schemaRef;
  if (files.has(baseRef)) return baseRef;
  if (baseRef === 'scene' || baseRef === 'scene-specification') return SCENE_SCHEMA_ID;
  if (/^blender_[a-z_]+\.(input|output)$/.test(baseRef)) {
    const [name, kind] = baseRef.split('.');
    const candidate = `urn:dsh:blender:tool:${name}:${kind}:v1`;
    if (files.has(candidate)) return candidate;
  }
  if (OP_IDS.includes(baseRef)) return `urn:dsh:blender:operation:${baseRef}:v1`;
  if (baseRef.startsWith('tools/v1/') || baseRef.startsWith('operations/v1/') || baseRef.startsWith('scene-specification/')) {
    const found = [...files.entries()].find(([, filename]) => filename === baseRef);
    if (found) return found[0];
  }
  throw new Error(`Unknown Blender schema reference: ${schemaRef}`);
}
function resolveValidatorRef(schemaRef) {
  const hash = schemaRef.indexOf('#');
  const baseRef = hash >= 0 ? schemaRef.slice(0, hash) : schemaRef;
  const fragment = hash >= 0 ? schemaRef.slice(hash) : '';
  return `${normalizeRef(baseRef)}${fragment}`;
}
export function getSchema(schemaRef) {
  return readJson(files.get(normalizeRef(schemaRef)));
}
export function schemaRefs() { return Object.freeze([...files.keys()]); }

export class DependencyError extends Error {
  constructor(message, cause) {
    super(message, { cause }); this.name = 'BlenderSchemaDependencyError';
    this.code = 'DEPENDENCY_MISSING'; this.category = 'dependency'; this.retryable = false;
  }
}
function getAjvClass() {
  try {
    const require = createRequire(import.meta.url);
    const module = require('ajv/dist/2020.js');
    return module.default || module;
  } catch (error) {
    throw new DependencyError('Ajv 8 Draft 2020-12 is required to validate Blender schemas.', error);
  }
}
let ajvInstance = null;
function buildAjv() {
  if (ajvInstance) return ajvInstance;
  const Ajv2020 = getAjvClass();
  const ajv = new Ajv2020({ strict: false, strictNumbers: true, allErrors: true, validateFormats: false, allowUnionTypes: true });
  ajv.addKeyword({
    keyword: 'unitQuaternion', type: 'array', schemaType: 'boolean', errors: false,
    validate: (enabled, values) => !enabled || values.length !== 4 || !values.every(Number.isFinite)
      || Math.abs(values.reduce((sum, value) => sum + value * value, 0) - 1) <= 1e-4
  });
  for (const schemaRef of files.keys()) {
    const schema = getSchema(schemaRef);
    if (schema.$id) ajv.addSchema(schema, schema.$id);
  }
  ajvInstance = ajv;
  return ajvInstance;
}
function dependencyResult(error) {
  return { valid: false, errors: [{ instancePath: '', schemaPath: '', keyword: 'dependency', params: { code: error.code }, message: error.message }], error: { code: error.code, category: error.category, retryable: error.retryable, message: error.message } };
}
export function validateSchema(schemaRef, value) {
  let ajv;
  try { ajv = buildAjv(); }
  catch (error) { if (error?.code === 'DEPENDENCY_MISSING') return dependencyResult(error); throw error; }
  const normalized = resolveValidatorRef(schemaRef);
  const validate = ajv.getSchema(normalized);
  if (typeof validate !== 'function') throw new Error(`Schema has no validator: ${normalized}`);
  const valid = Boolean(validate(value));
  return { valid, errors: valid ? [] : (validate.errors || []) };
}
export function assertSchema(schemaRef, value) {
  const result = validateSchema(schemaRef, value);
  if (!result.valid) {
    const error = new Error(`Blender schema validation failed for ${schemaRef}.`);
    error.code = result.error?.code || 'SCHEMA_INVALID'; error.category = result.error?.category || 'input';
    error.retryable = false; error.errors = result.errors; throw error;
  }
  return value;
}
export const toolInputSchemaRef = (toolName) => `urn:dsh:blender:tool:${toolName}:input:v1`;
export const toolOutputSchemaRef = (toolName) => `urn:dsh:blender:tool:${toolName}:output:v1`;
export const operationSchemaRef = (opId) => `urn:dsh:blender:operation:${opId}:v1`;
export const validateToolInput = (toolName, value) => validateSchema(toolInputSchemaRef(toolName), value);
export const validateToolOutput = (toolName, value) => validateSchema(toolOutputSchemaRef(toolName), value);
export const assertToolInput = (toolName, value) => assertSchema(toolInputSchemaRef(toolName), value);
export const assertToolOutput = (toolName, value) => assertSchema(toolOutputSchemaRef(toolName), value);
export const validateOperation = (opId, value) => validateSchema(operationSchemaRef(opId), value);
export const assertOperation = (opId, value) => assertSchema(operationSchemaRef(opId), value);
export const validateScene = (value) => validateSchema(`${SCENE_SCHEMA_ID}#/$defs/scene`, value);
export const validatePatch = (value) => validateSchema(`${SCENE_SCHEMA_ID}#/$defs/patch`, value);
export const assertScene = (value) => assertSchema(`${SCENE_SCHEMA_ID}#/$defs/scene`, value);
export const assertPatch = (value) => assertSchema(`${SCENE_SCHEMA_ID}#/$defs/patch`, value);
export const validateReferenceAnalysisRequest = (value) => validateSchema('urn:dsh:blender:reference-analysis:request:v1', value);
export const validateReferenceAnalysisResult = (value) => validateSchema('urn:dsh:blender:reference-analysis:result:v1', value);

export const blenderManifest = readJson('manifest.v1.json');
export const blenderErrorDefinitions = blenderManifest.errorCodes;
export const ERROR_CODES = Object.freeze(Object.fromEntries(blenderErrorDefinitions.map(item => [item.code, Object.freeze({ ...item })])));
export const operationDefinitions = Object.freeze(blenderManifest.operations.map(item => Object.freeze({ ...item, schema: getSchema(item.schemaRef) })));
const descriptions = Object.freeze({
  blender_tools: 'Discover and activate Blender tool groups.', blender_capabilities: 'Read Blender capability declarations and readiness.',
  blender_control: 'Inspect and manage Blender resource leases.', blender_project: 'List, open, inspect, save, reload, or close Blender projects.',
  blender_scene_query: 'Read Blender scene structure and bounded data.', blender_scene_apply: 'Plan or apply registered Blender scene operations.',
  blender_view: 'Read or update the Blender view.', blender_capture: 'Capture a Blender view or immutable checkpoint.',
  blender_verify: 'Evaluate bounded assertions and publish a verification report.', blender_reference_analyze: 'Analyze authorized immutable reference assets.',
  blender_spec_revision: 'Create, read, and commit Scene Specification revisions.', blender_spec_apply: 'Plan or apply a validated Scene Specification.',
  blender_job: 'Inspect, retrieve, or cancel Blender jobs.'
});
export const toolDefinitions = Object.freeze(TOOL_NAMES.map(name => Object.freeze({
  name, description: descriptions[name], parameters: getSchema(toolInputSchemaRef(name)),
  inputSchema: getSchema(toolInputSchemaRef(name)), outputSchema: getSchema(toolOutputSchemaRef(name)),
  actions: Object.freeze(blenderManifest.tools.find(tool => tool.toolName === name).actions.map(action => action.action))
})));
export const toolActionDefinitions = Object.freeze(blenderManifest.tools.flatMap(tool => tool.actions.map(action => Object.freeze({
  toolName: tool.toolName, ...action,
  inputSchema: getSchema(action.inputSchemaRef), outputSchema: getSchema(action.outputSchemaRef)
}))));
export function getToolDefinition(toolName) {
  const definition = toolDefinitions.find(item => item.name === toolName);
  if (!definition) throw new Error(`Unknown Blender tool: ${toolName}`);
  return definition;
}
export function getOperationDefinition(opId) {
  const definition = operationDefinitions.find(item => item.opId === opId);
  if (!definition) throw new Error(`Unknown Blender operation: ${opId}`);
  return definition;
}
export function createBlenderToolDefinitions(names = TOOL_NAMES) { return names.map(getToolDefinition); }
