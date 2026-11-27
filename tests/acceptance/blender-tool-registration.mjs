import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createHarness, createFakeConnectionService } from './harness.mjs';
import { TOOL_NAMES, toolDefinitions, validateToolInput, validateToolOutput } from '../../tools/blender/schema.js';

// Normal CI checks the documented host subset below. For installed-host evidence,
// load its public module, or an extracted source tree without mounting a user profile.
// Source mode changes only import specifiers; checker and utility bodies stay unchanged.
async function loadHostChecker() {
  if (process.env.DSH_TOOLS_SCHEMA_MODULE) return import(pathToFileURL(process.env.DSH_TOOLS_SCHEMA_MODULE).href);
  if (!process.env.DSH_TOOLS_SOURCE_DIR) return null;
  const root = process.env.DSH_TOOLS_SOURCE_DIR;
  const paths = ['lib/types/json-schema.js', 'dsh-error_lib_index.js', 'dsh-util-values_lib_index.js'];
  const sources = await Promise.all(paths.map(path => readFile(join(root, path), 'utf8')));
  const dataUrl = source => `data:text/javascript;base64,${Buffer.from(source).toString('base64')}`;
  const checker = sources[0]
    .replace("from '@deepseek-ai/dsh-llm'", `from '${dataUrl(sources[1])}'`)
    .replace("from '@deepseek-ai/dsh-util-values'", `from '${dataUrl(sources[2])}'`);
  assert.notEqual(checker, sources[0]);
  const [module, values] = await Promise.all([import(dataUrl(checker)), import(dataUrl(sources[2]))]);
  return { ...module, snapshotJsonValue: values.snapshotJsonValue, provenance: paths.map((path, index) => ({ path, sha256: createHash('sha256').update(sources[index]).digest('hex') })) };
}
const host = await loadHostChecker();
const schemaEvidence = new Map();
const violations = schema => {
  try { host.assertSupportedJsonSchema(schema); return []; }
  catch (error) { assert.equal(error.code, 'UNSUPPORTED_SCHEMA'); return error.violations; }
};
after(async () => {
  if (process.env.DSH_TOOLS_SCHEMA_REPORT) {
    assert.ok(host, 'A schema report requires the actual installed host checker.');
    const tools = [...schemaEvidence.values()];
    const summary = tools.map(tool => ({ name: tool.name, outputBeforeViolations: tool.before.output.length, parametersBeforeViolations: tool.before.parameters.length,
      parametersLosslessJson: tool.before.parametersLosslessJson, outputAfterViolations: tool.after?.output.length ?? null, parametersAfterViolations: tool.after?.parameters.length ?? null,
      getReturnsDefinition: tool.after?.getReturnsDefinition ?? false }));
    await writeFile(process.env.DSH_TOOLS_SCHEMA_REPORT, JSON.stringify({ checker: 'installed dsh-tools assertSupportedJsonSchema', provenance: host.provenance ?? null, summary, tools }, null, 2) + '\n');
  }
});
const keywords = new Set(['type', 'oneOf', 'properties', 'required', 'additionalProperties', 'items', 'enum', 'const', 'description', 'title', 'default', 'examples']);
function assertTransportSchema(schema) {
  assert.ok(schema && typeof schema === 'object' && !Array.isArray(schema));
  for (const key of Object.keys(schema)) assert.ok(keywords.has(key), `Unsupported host schema keyword: ${key}`);
  if (schema.oneOf) {
    assert.ok(schema.oneOf.length >= 2);
    for (const key of ['type', 'properties', 'required', 'additionalProperties', 'items', 'enum', 'const']) assert.equal(Object.hasOwn(schema, key), false, key);
    schema.oneOf.forEach(assertTransportSchema);
  }
  if (schema.enum || Object.hasOwn(schema, 'const')) assert.ok(['string', 'number', 'integer', 'boolean', 'null'].includes(schema.type));
  if (schema.properties) Object.values(schema.properties).forEach(assertTransportSchema);
  if (schema.items) assertTransportSchema(schema.items);
  if (schema.required) for (const key of schema.required) assert.ok(Object.hasOwn(schema.properties, key));
  host?.assertSupportedJsonSchema(schema);
}
const names = values => [...values].filter(name => name.startsWith('blender_')).sort();

async function fixture() {
  const peer = { id: 'blender-registration-fixture' };
  const h = await createHarness({ connection: createFakeConnectionService({ rejection: undefined, admit: () => ({ peer }), browserPeer: peer }) });
  const register = h.ctx.tools.register.bind(h.ctx.tools);
  // The shared harness intentionally has no get() and does not validate output.schema.
  // Add those two host boundaries here before the config enables Blender registration.
  h.ctx.tools.get = (name, _scope) => h.tools.get(name);
  h.ctx.tools.register = (definition, options) => {
    if (definition.name.startsWith('blender_')) {
      assertTransportSchema(definition.output.schema);
      assertTransportSchema(definition.parameters);
    }
    return register(definition, options);
  };
  const agent = { id: 'blender-registration-agent', session: { header: { cwd: h.workspaceDir } } };
  const configure = (revision, enabled = true, providerEnabled = true) => h.request({ method: 'PUT', path: '/plugins/ui-testing/config', body: {
    expectedRevision: revision, scope: 'global', patch: { view: 'three-d', environment: 'three-d', enabledEnvironments: enabled ? ['web', 'three-d'] : ['web'],
      environments: { 'three-d': { enabled, providers: { blender: { enabled: providerEnabled } } } } },
  } });
  return { h, agent, configure, exec: { agent, signal: AbortSignal.timeout(30000) } };
}

test('full frozen output schemas reproduce the host registration failure', () => {
  for (const definition of toolDefinitions) {
    assert.throws(() => assertTransportSchema(definition.outputSchema), /Unsupported host schema keyword/);
    if (host) {
      assert.throws(() => host.assertSupportedJsonSchema(definition.outputSchema), { code: 'UNSUPPORTED_SCHEMA' });
      schemaEvidence.set(definition.name, { name: definition.name, before: { output: violations(definition.outputSchema), parameters: violations(definition.parameters), parametersLosslessJson: host.snapshotJsonValue ? host.snapshotJsonValue(definition.parameters) !== undefined : null } });
    }
    assert.doesNotThrow(() => structuredClone(definition.parameters));
  }
});

test('real plugin registers all 13 Blender tools through host schema/get boundaries and activates scene', async () => {
  const { h, agent, configure, exec } = await fixture();
  try {
    const config = await configure(0);
    assert.equal(config.statusCode, 200, config.body);
    assert.deepEqual(names(h.toolNames()), [...TOOL_NAMES].sort());
    for (const name of TOOL_NAMES) {
      const definition = h.ctx.tools.get(name, agent);
      assert.equal(definition?.name, name);
      if (host) {
        const after = { output: violations(definition.output.schema), parameters: violations(definition.parameters), getReturnsDefinition: true };
        assert.deepEqual(after.output, [], name);
        assert.deepEqual(after.parameters, [], name);
        schemaEvidence.get(name).after = after;
      }
      assert.equal(typeof definition.output.render, 'function');
      assert.equal(typeof h.toolOptions().get(name).when, 'function');
    }
    assert.deepEqual(h.ctx.__internal.logs.filter(line => line.includes('tool registration failed')), []);
    const status = await h.invoke('browser_tools', { action: 'status' }, exec);
    assert.equal(status.ok, true, JSON.stringify(status.error));
    assert.equal(status.value.environment, 'three-d');
    assert.equal(status.value.catalog.length, 6);
    assert.ok(status.value.catalog.every(group => group.available === true), JSON.stringify(status.value.catalog));
    const activate = await h.invoke('browser_tools', { action: 'activate', groups: ['scene'] }, exec);
    assert.equal(activate.ok, true, JSON.stringify(activate.error));
    assert.ok(activate.value.nextRequestTools.includes('blender_scene_query'));
    assert.ok((await h.evaluateAdmission(agent)).has('blender_scene_query'));
    const output = await h.invoke('blender_tools', { action: 'status' }, exec);
    assert.equal(output.ok, true, JSON.stringify(output.error));
    assert.equal(validateToolOutput('blender_tools', output.value).valid, true);
    assert.deepEqual(output.content, [{ type: 'text', text: JSON.stringify(output.value) }]);
    const disabled = await configure(config.json.revision, true, false);
    assert.equal(disabled.statusCode, 200, disabled.body);
    for (const name of TOOL_NAMES) assert.equal(h.ctx.tools.get(name, agent), undefined);
    const restored = await configure(disabled.json.revision);
    assert.equal(restored.statusCode, 200, restored.body);
    for (const name of TOOL_NAMES) assert.equal(h.ctx.tools.get(name, agent)?.name, name);
  } finally { await h.dispose(); }
});

test('host schema projection preserves full frozen validation and scope rejection', async () => {
  const { h, agent, configure, exec } = await fixture();
  try {
    assert.equal((await configure(0)).statusCode, 200);
    for (const original of toolDefinitions) {
      const definition = h.ctx.tools.get(original.name, agent);
      assert.ok(definition, original.name);
      assert.notEqual(definition.output.schema, original.outputSchema);
      assert.notEqual(definition.parameters, original.parameters);
      assert.deepEqual(definition.inputSchema, original.inputSchema);
      assert.deepEqual(definition.outputSchema, original.outputSchema);
      assert.equal(definition.parameters.type, 'object', original.name);
      assert.equal(Object.hasOwn(definition.parameters, 'oneOf'), false, original.name);
      assert.equal(definition.parameters.additionalProperties, false, original.name);
      const action = definition.parameters.properties.action;
      assert.deepEqual(action.enum ?? [action.const], original.actions, original.name);
      assert.equal(validateToolInput(original.name, { action: 'invented', unexpected: true }).valid, false);
      assert.equal(validateToolOutput(original.name, { tool: original.name, ok: true }).valid, false);
    }
    const discovery = h.ctx.tools.get('blender_tools', agent).parameters;
    assert.deepEqual(discovery.required, ['action']);
    assert.deepEqual(discovery.properties.groups.items.enum, ['project', 'scene', 'view', 'reference', 'verify', 'jobs']);
    assert.match(discovery.properties.groups.description, /Required for activate\./);
    assert.deepEqual(h.ctx.tools.get('blender_job', agent).parameters.required, ['action', 'jobId']);
    for (const args of [{ action: 'activate' }, { action: 'status', groups: ['scene'] }]) {
      const rejected = await h.invoke('blender_tools', args, exec);
      assert.equal(rejected.ok, false);
      assert.equal(rejected.error.code, 'SCHEMA_INVALID');
    }
    const invalid = await h.invoke('blender_scene_query', { action: 'query', live: { targetId: 'target_fixture', generation: 1 }, kind: 'scene', unexpected: true }, exec);
    assert.equal(invalid.ok, false);
    assert.equal(invalid.error.code, 'SCHEMA_INVALID');
    // A registry visibility denial must still block disclosure: the fix cannot bypass get().
    h.ctx.tools.get = () => undefined;
    const denied = await h.invoke('browser_tools', { action: 'status' }, exec);
    assert.equal(denied.ok, true, JSON.stringify(denied.error));
    assert.ok(denied.value.catalog.every(group => group.available === false));
    const activate = await h.invoke('browser_tools', { action: 'activate', groups: ['scene'] }, exec);
    assert.equal(activate.ok, false);
    assert.equal(activate.error.code, 'TOOL_DISCLOSURE_UNAVAILABLE');
  } finally { await h.dispose(); }
});
