import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const schemaRoot = path.join(root, 'schemas/blender');
const toolRoot = path.join(schemaRoot, 'tools/v1');
const opsRoot = path.join(schemaRoot, 'operations/v1');
const commonId = 'urn:dsh:blender:common:1';
const ref = (name) => ({ $ref: `${commonId}#/$defs/${name}` });
const obj = (properties, required = Object.keys(properties)) => ({
  type: 'object', properties, required, additionalProperties: false
});
const str = (maxLength = 1024) => ({ type: 'string', minLength: 1, maxLength });
const arr = (items, minItems = 0, maxItems = 128) => ({ type: 'array', items, minItems, maxItems });
const enumS = (...values) => ({ enum: values });
const nullable = (schema) => ({ anyOf: [schema, { type: 'null' }] });
const common = {
  $schema: 'https://json-schema.org/draft/2020-12/schema', $id: commonId,
  title: 'Blender shared closed schema primitives',
  $defs: {
    id: { type: 'string', pattern: '^[a-z][a-z0-9_]{1,95}$' },
    targetId: { type: 'string', pattern: '^target_[a-z][a-z0-9_]{0,47}$' },
    sceneId: { type: 'string', pattern: '^scn_[a-z][a-z0-9_]{0,47}$' },
    objectId: { type: 'string', pattern: '^obj_[a-z][a-z0-9_]{0,47}$' },
    partId: { type: 'string', pattern: '^part_[a-z][a-z0-9_]{0,47}$' },
    materialId: { type: 'string', pattern: '^mat_[a-z][a-z0-9_]{0,47}$' },
    artifactId: { type: 'string', pattern: '^art_[a-z][a-z0-9_]{0,47}$' },
    evidenceId: { type: 'string', pattern: '^ev_[a-z][a-z0-9_]{0,47}$' },
    digest: { type: 'string', pattern: '^[a-f0-9]{64}$' },
    generation: { type: 'integer', minimum: 1, maximum: Number.MAX_SAFE_INTEGER },
    revision: { type: 'integer', minimum: 0, maximum: Number.MAX_SAFE_INTEGER },
    positiveInteger: { type: 'integer', minimum: 1, maximum: Number.MAX_SAFE_INTEGER },
    finiteNumber: { type: 'number' },
    vec3: { type: 'array', items: { type: 'number' }, minItems: 3, maxItems: 3 },
    positiveVec3: { type: 'array', items: { type: 'number', exclusiveMinimum: 0 }, minItems: 3, maxItems: 3 },
    quatWxyz: { type: 'array', items: { type: 'number' }, minItems: 4, maxItems: 4, unitQuaternion: true },
    live: obj({ targetId: ref('targetId'), generation: ref('generation') }),
    write: obj({
      targetId: ref('targetId'), generation: ref('generation'), expectSceneRevision: ref('revision'),
      leaseId: str(128), expectControlRevision: ref('revision'), idemKey: { type: 'string', minLength: 1, maxLength: 128 }, grantId: str(256)
    }),
    viewWrite: obj({
      targetId: ref('targetId'), generation: ref('generation'), expectViewRevision: ref('revision'),
      leaseId: str(128), expectControlRevision: ref('revision'), idemKey: { type: 'string', minLength: 1, maxLength: 128 }, grantId: str(256)
    }),
    sceneOp: { oneOf: ['collection.ensure','object.ensure','object.parent','object.transform','mesh.primitive','object.remove','material.ensure','material.assign'].map(opId => obj({ opId: { const: opId }, opVersion: { const: 1 }, args: { $ref: `urn:dsh:blender:operation:${opId}:v1` }, stepId: { type: 'string', pattern: '^[a-z][a-z0-9_-]{0,63}$' } })) },
    envelope: obj({
      ok: { const: true }, data: { type: 'object' },
      evidenceIds: arr(ref('evidenceId'), 0, 128),
      effectState: enumS('none','partial','committed','unknown')
    }, ['ok','data','evidenceIds','effectState']),
    unitBudget: obj({ maxTotalPixels: { type: 'integer', minimum: 1, maximum: 100000000 }, maxOutputBytes: { type: 'integer', minimum: 1, maximum: 536870912 } }),
    timeoutMs: { type: 'integer', minimum: 100, maximum: 30000 }
  }
};
await fs.mkdir(toolRoot, { recursive: true });
await fs.mkdir(opsRoot, { recursive: true });
await fs.writeFile(path.join(toolRoot, 'common.schema.json'), `${JSON.stringify(common, null, 2)}\n`);

const actionSchema = (action, props = {}, required = []) => obj({ action: { const: action }, timeoutMs: ref('timeoutMs'), ...props }, ['action', ...required]);
const actionOneOf = (variants) => ({ $schema: 'https://json-schema.org/draft/2020-12/schema', oneOf: variants });
const tools = {};
const defineTool = async (name, group, actions, inputVariants, outputData) => {
  tools[name] = { name, group, actions };
  const inSchema = actionOneOf(inputVariants);
  inSchema.$id = `urn:dsh:blender:tool:${name}:input:v1`;
  inSchema.title = `${name} v1 input`;
  inSchema.$defs = { opStep: ref('sceneOp') };
  const outProps = { tool: { const: name }, action: { enum: actions }, ok: { const: true }, data: outputData, evidenceIds: arr(ref('evidenceId'), 0, 128), effectState: enumS('none','partial','committed','unknown') };
  const outSchema = obj(outProps, ['tool','action','ok','data','evidenceIds','effectState']);
  outSchema.$schema = 'https://json-schema.org/draft/2020-12/schema';
  outSchema.$id = `urn:dsh:blender:tool:${name}:output:v1`;
  outSchema.title = `${name} v1 output`;
  await fs.writeFile(path.join(toolRoot, `${name}.input.schema.json`), `${JSON.stringify(inSchema, null, 2)}\n`);
  await fs.writeFile(path.join(toolRoot, `${name}.output.schema.json`), `${JSON.stringify(outSchema, null, 2)}\n`);
};
const anyData = obj({ result: {} }, []);
const d = (props, req = []) => obj(props, req);
const actionData = (props, required = []) => ({ type: 'object', properties: props, required, additionalProperties: false });

await defineTool('blender_tools','discovery',['status','activate'],[
  actionSchema('status'), actionSchema('activate',{ groups: arr(enumS('project','scene','view','reference','verify','jobs'),1,6)},['groups'])
], actionData({ enabledGroups: arr(enumS('project','scene','view','reference','verify','jobs'),0,6), availableTools: arr(str(80),0,32) }));
await defineTool('blender_capabilities','discovery',['status'],[
  actionSchema('status',{ opId: str(80) },[])
], actionData({ catalogVersion: str(64), blenderBaseline: { const: '5.3.0' }, operations: arr({type:'object'},0,64), declaration: {type:'object'}, readiness: {type:'object'}, limits: {type:'object'}, observed: nullable({type:'object'}) },['catalogVersion','blenderBaseline','operations','declaration','readiness','limits','observed']));
await defineTool('blender_control','project',['status','acquire','renew','release'],[
  actionSchema('status',{ resource: enumS('project','view','scene'), ...{} },['resource']),
  actionSchema('acquire',{ resource: enumS('project','view','scene'), grantId: str(256), live: nullable(ref('live')), ttlMs: {type:'integer',minimum:1000,maximum:3600000} },['resource','grantId']),
  actionSchema('renew',{ resource: enumS('project','view','scene'), leaseId: str(128), expectControlRevision: ref('revision'), ttlMs: {type:'integer',minimum:1000,maximum:3600000} },['resource','leaseId','expectControlRevision']),
  actionSchema('release',{ resource: enumS('project','view','scene'), leaseId: str(128), expectControlRevision: ref('revision') },['resource','leaseId','expectControlRevision'])
], actionData({ resource: enumS('project','view','scene'), leaseId: str(128), controlRevision: ref('revision'), expiresAt: str(64), owner: str(256), status: str(64) ,challenge:obj({grantId:str(256),resource:enumS('project','view','scene'),expiresAt:str(64)})},['resource','status']));
await defineTool('blender_project','project',['list','status','open','reload','save','saveAs','close'],[
  actionSchema('list'), actionSchema('status',{live:ref('live')},['live']),
  actionSchema('open',{path:str(4096),expectGeneration:nullable(ref('generation')),leaseId:str(128),expectControlRevision:ref('revision'),idemKey:{type:'string',minLength:1,maxLength:128},grantId:str(256),targetId:ref('targetId'),generation:ref('generation'),expectSceneRevision:ref('revision')},['path','expectGeneration','leaseId','expectControlRevision','idemKey','grantId']),
  actionSchema('reload',{write:ref('write'),discardGrantId:str(256)},['write']),
  actionSchema('save',{write:ref('write'),expectedFileHash:ref('digest'),overwriteGrantId:str(256)},['write']),
  actionSchema('saveAs',{write:ref('write'),path:str(4096),expectedFileHash:ref('digest'),overwriteGrantId:str(256)},['write','path']),
  actionSchema('close',{write:ref('write'),discardGrantId:str(256)},['write'])
], actionData({ projects:arr({type:'object'},0,1000),project:{type:'object'},live:ref('live'),sceneRevision:ref('revision'),fileHash:ref('digest'),dirty:{type:'boolean'},path:str(4096),checkpointId:str(128),status:enumS('open','closed','saved','reloaded')},[]));
await defineTool('blender_scene_query','scene',['query'],[
  actionSchema('query',{live:ref('live'),kind:enumS('scene','hierarchy','object','mesh','material'),ids:arr(ref('id'),0,256),fields:arr(str(128),0,128),limit:{type:'integer',minimum:1,maximum:1000},cursor:str(512),meshSource:enumS('original','evaluated')},['live','kind'])
], actionData({sceneRevision:ref('revision'),items:arr({type:'object'},0,1000),nextCursor:nullable(str(512)),truncated:{type:'boolean'}},['sceneRevision','items','truncated']));
await defineTool('blender_scene_apply','scene',['apply'],[
  actionSchema('apply',{mode:enumS('plan','apply'),targetId:ref('targetId'),generation:ref('generation'),expectSceneRevision:ref('revision'),leaseId:str(128),expectControlRevision:ref('revision'),idemKey:{type:'string',minLength:1,maxLength:128},grantId:str(256),planId:str(128),approvalGrantId:str(256),ops:arr(ref('sceneOp'),1,100)},['mode','targetId','generation', 'ops'])
], actionData({planId:str(128),planHash:ref('digest'),sceneRevision:ref('revision'),steps:arr({type:'object'},0,100),jobId:str(128),status:enumS('planned','committed','running')},[]));
await defineTool('blender_view','view',['get','set'],[
  actionSchema('get',{live:ref('live')},['live']),
  actionSchema('set',{targetId:ref('targetId'),generation:ref('generation'),expectViewRevision:ref('revision'),leaseId:str(128),expectControlRevision:ref('revision'),idemKey:{type:'string',minLength:1,maxLength:128},grantId:str(256),changes:obj({projection:enumS('perspective','orthographic'),location:ref('vec3'),rotation:ref('quatWxyz'),distance:{type:'number',exclusiveMinimum:0},lens:{type:'number',exclusiveMinimum:0},cameraId:str(128)},[])},['targetId','generation','expectViewRevision','changes'])
], actionData({view:{type:'object'},viewRevision:ref('revision'),changed:{type:'boolean'}},[]));
await defineTool('blender_capture','verify',['capture'],[
  actionSchema('capture',{targetId:ref('targetId'),generation:ref('generation'),source:enumS('agentView','humanView','checkpoint'),editorId:str(128),checkpointId:str(128),cameraId:str(128),size:obj({width:{type:'integer',minimum:1,maximum:8192},height:{type:'integer',minimum:1,maximum:8192}},['width','height']),expectViewRevision:ref('revision'),sequence:obj({start:{type:'integer'},end:{type:'integer'},step:{type:'integer',minimum:1}},['start','end','step']),budget:ref('unitBudget'),grantId:str(256)},['targetId','generation','source'])
], actionData({artifactId:ref('artifactId'),sha256:ref('digest'),mediaType:str(128),width:{type:'integer',minimum:1},height:{type:'integer',minimum:1},checkpointId:str(128),frame:{type:'integer'},capturedAt:str(64)},['artifactId','sha256']));
await defineTool('blender_verify','verify',['verify'],[
  actionSchema('verify',{targetId:ref('targetId'),generation:ref('generation'),source:enumS('live','checkpoint','artifact'),checkpointId:str(128),artifactId:ref('artifactId'),sha256:ref('digest'),assertions:arr(obj({id:{type:'string',pattern:'^[a-z][a-z0-9_-]{0,63}$'},kind:enumS('exists','transform','dimension','material','relation','pixel'),subject:ref('id'),expected:{},tolerance:obj({value:{type:'number',minimum:0},unit:enumS('m','cm','mm','rad','deg','px','ratio')},['value','unit'])},['id','kind','subject','expected']),1,64),grantId:str(256)},['source','assertions'])
], actionData({reportArtifactId:ref('artifactId'),status:enumS('pass','fail','inconclusive'),assertions:arr({type:'object'},1,64),summary:str(2048)},['status','assertions']));
await defineTool('blender_reference_analyze','reference',['analyze'],[
  actionSchema('analyze',{references:arr(obj({sourceId:{type:'string',pattern:'^src_[a-z][a-z0-9_]{0,47}$'},artifactId:ref('artifactId'),sha256:ref('digest'),frameIndex:{type:'integer',minimum:0},gallery:obj({runtimeGeneration:ref('generation'),itemId:ref('positiveInteger')},['runtimeGeneration','itemId'])},['sourceId']),1,8),profile:enumS('basic','spatial','multiview'),pipelineVersion:str(128),regions:arr(obj({sourceId:{type:'string',pattern:'^src_[a-z][a-z0-9_]{0,47}$'},regionId:{type:'string',pattern:'^[a-z][a-z0-9_-]{0,63}$'},rectPx:{type:'array',prefixItems:[{type:'integer',minimum:0},{type:'integer',minimum:0},{type:'integer',minimum:1},{type:'integer',minimum:1}],items:false,minItems:4,maxItems:4}},['sourceId','regionId','rectPx']),0,64),anchors:arr({type:'object',properties:{sourceId:{type:'string',pattern:'^src_[a-z][a-z0-9_]{0,47}$'},pointsPx:{type:'array',items:ref('vec3'),minItems:2,maxItems:2},distanceM:{type:'number',exclusiveMinimum:0},toleranceM:{type:'number',exclusiveMinimum:0},sourceNoteArtifactId:ref('artifactId')},required:['sourceId','pointsPx','distanceM','toleranceM','sourceNoteArtifactId'],additionalProperties:false},0,32),budget:obj({wallMs:{type:'integer',minimum:1000,maximum:300000},maxOutputBytes:{type:'integer',minimum:1048576,maximum:134217728}},[]),grantId:str(256)},['references','grantId'])
], actionData({runId:str(128),resultArtifactId:ref('artifactId'),sha256:ref('digest'),status:enumS('complete','partial'),completedStages:arr(str(128),0,128),unresolved:arr({type:'object'},0,256),jobId:str(128)},[]));
await defineTool('blender_spec_revision','reference',['create','get','commit'],[
  actionSchema('create',{scene:{type:'object'},sceneJson:{type:'string',minLength:2,maxLength:16777216},artifactId:ref('artifactId'),grantId:str(256)},['grantId']),
  actionSchema('get',{sceneId:ref('sceneId'),revision:ref('positiveInteger')},['sceneId']),
  actionSchema('commit',{patch:{type:'object'},patchJson:{type:'string',minLength:2,maxLength:16777216},grantId:str(256)},['grantId'])
], actionData({sceneId:ref('sceneId'),revision:ref('positiveInteger'),artifactId:ref('artifactId'),sha256:ref('digest'),receiptId:str(128),scene:{type:'object'},patch:{type:'object'}},[]));
await defineTool('blender_spec_apply','scene',['apply'],[
  actionSchema('apply',{mode:enumS('plan','apply'),targetId:ref('targetId'),generation:ref('generation'),expectSceneRevision:ref('revision'),leaseId:str(128),expectControlRevision:ref('revision'),idemKey:{type:'string',minLength:1,maxLength:128},grantId:str(256),scene:{type:'object'},artifactId:ref('artifactId'),planId:str(128),approvalGrantId:str(256)},['mode','targetId','generation'])
], actionData({planId:str(128),planHash:ref('digest'),sceneId:ref('sceneId'),specRevision:ref('positiveInteger'),sceneRevision:ref('revision'),steps:arr({type:'object'},0,1000),jobId:str(128),status:enumS('planned','committed','running')},[]));
await defineTool('blender_job','jobs',['status','result','cancel'],[
  actionSchema('status',{jobId:str(128)},['jobId']), actionSchema('result',{jobId:str(128)},['jobId']), actionSchema('cancel',{jobId:str(128),grantId:str(256)},['jobId','grantId'])
], actionData({jobId:str(128),state:enumS('queued','running','succeeded','failed','cancelled'),progress:{type:'number',minimum:0,maximum:1},result:{type:'object'},error:{type:'object'},effectState:enumS('none','partial','committed','unknown')},['jobId','state']));

const opArgs = {
  'collection.ensure': obj({sceneId:ref('sceneId')}),
  'object.ensure': obj({sceneId:ref('sceneId'),stableId:{type:'string',pattern:'^(obj|part)_[a-z][a-z0-9_]{0,47}$'},label:str(1024),kind:enumS('empty','mesh')}),
  'object.parent': obj({sceneId:ref('sceneId'),childId:{type:'string',pattern:'^(obj|part)_[a-z][a-z0-9_]{0,47}$'},parentId:nullable({type:'string',pattern:'^(obj|part)_[a-z][a-z0-9_]{0,47}$'})}),
  'object.transform': obj({sceneId:ref('sceneId'),stableId:{type:'string',pattern:'^(obj|part)_[a-z][a-z0-9_]{0,47}$'},translation:ref('vec3'),rotation:ref('quatWxyz'),scale:ref('positiveVec3')}),
  'mesh.primitive': obj({sceneId:ref('sceneId'),stableId:{type:'string',pattern:'^part_[a-z][a-z0-9_]{0,47}$'},shape:{oneOf:[obj({kind:{const:'cylinder'},radius:{type:'number',exclusiveMinimum:0},height:{type:'number',exclusiveMinimum:0},segments:{type:'integer',minimum:3,maximum:256}},['kind','radius','height']),obj({kind:{const:'frustum'},bottomRadius:{type:'number',minimum:0},topRadius:{type:'number',minimum:0},height:{type:'number',exclusiveMinimum:0},segments:{type:'integer',minimum:3,maximum:256}},['kind','bottomRadius','topRadius','height']),obj({kind:{const:'box'},size:ref('positiveVec3')},['kind','size'])]}}),
  'object.remove': obj({sceneId:ref('sceneId'),stableId:{type:'string',pattern:'^(obj|part)_[a-z][a-z0-9_]{0,47}$'},expectedManagedHash:ref('digest'),cascadeIds:arr({type:'string',pattern:'^(obj|part)_[a-z][a-z0-9_]{0,47}$'},0,1024)}),
  'material.ensure': obj({sceneId:ref('sceneId'),stableId:{type:'string',pattern:'^mat_[a-z][a-z0-9_]{0,47}$'},label:str(1024),roughness:{type:'number',minimum:0,maximum:1},metallic:{type:'number',minimum:0,maximum:1},opacity:{type:'number',minimum:0,maximum:1},baseColorLinear:{type:'array',items:{type:'number',minimum:0,maximum:1},minItems:3,maxItems:3}},['sceneId','stableId','label']),
  'material.assign': obj({sceneId:ref('sceneId'),targetStableId:{type:'string',pattern:'^part_[a-z][a-z0-9_]{0,47}$'},materialId:{type:'string',pattern:'^mat_[a-z][a-z0-9_]{0,47}$'},slot:{type:'integer',minimum:0,maximum:63}})
};
const opWrites = [];
const opsManifest = Object.entries(opArgs).map(([opId, schema]) => {
  const file = `${opId}.schema.json`;
  schema.$schema = 'https://json-schema.org/draft/2020-12/schema';
  schema.$id = `urn:dsh:blender:operation:${opId}:v1`;
  schema.title = `${opId} v1 args`;
  schema.description = 'Closed operation arguments; contract unit is the Blender scene unit unless otherwise specified.';
  opWrites.push(fs.writeFile(path.join(opsRoot, file), `${JSON.stringify(schema, null, 2)}\n`));
  return { opId, opVersion: 1, schemaRef: `operations/v1/${file}`, support: 'supported', executionClass: 'blender-scene-write', sideEffectClass: 'scene-write', timeoutMs: 10000 };
});
await Promise.all(opWrites);

const errorRows = [
 ['AUTHORIZATION_REQUIRED','authorization',false,'Request a human grant for the required scope.'],['GRANT_INVALID','authorization',false,'Obtain a grant bound to the current principal, workspace, target, and plan.'],['GRANT_EXPIRED','authorization',false,'Obtain a fresh grant.'],['GRANT_SCOPE_MISMATCH','authorization',false,'Obtain a grant with the required scope.'],['LEASE_REQUIRED','authorization',false,'Acquire the required resource lease.'],['LEASE_LOST','state',false,'Stop writes, read current state, and create a new plan.'],['BUSY','state',true,'Inspect current job or lease, wait, then retry.'],['REVISION_CONFLICT','state',false,'Read the current revision and rebuild the patch.'],['PLAN_STALE','state',false,'Read current scene/spec state and re-plan.'],['IDEMPOTENCY_CONFLICT','state',false,'Check the prior result and use a new idempotency key for a different request.'],['PROJECT_DIRTY','state',false,'Save, or explicitly authorize discarding the dirty project.'],['PROJECT_CONFLICT','state',false,'Resolve the on-disk hash conflict.'],['SCHEMA_INVALID','input',false,'Correct input using the reported instancePath.'],['SEMANTIC_INVALID','input',false,'Correct related references and semantic violations.'],['UNSUPPORTED_SCHEMA_VERSION','capability',false,'Preserve the payload and use a supported decoder or explicit migration.'],['PATCH_ID_CONFLICT','state',false,'Query the receipt using the original patchId; use a new ID for different content.'],['PATH_OUTSIDE_WORKSPACE','authorization',false,'Choose a path inside the authorized workspace.'],['OUTPUT_LIMIT','resource',false,'Reduce output size, frames, or declared budget.'],['OPERATION_TIMEOUT','state',false,'Reconcile using effectState; do not replay if the effect is unknown.'],['WORKER_LOST','state',false,'Reconcile the operation and effectState before recovery.'],['ASSET_DIGEST_MISMATCH','evidence',false,'Freeze and verify the original asset again.'],['GENERATION_MISMATCH','state',false,'Rebind to the current target generation.'],['DEPENDENCY_MISSING','dependency',false,'Install or configure the declared dependency.'],['CAPABILITY_UNAVAILABLE','capability',false,'Use an available operation or wait for capability support.'],['EVIDENCE_INCOMPLETE','evidence',false,'Capture the missing evidence and verify again.'],['CONFIG_STALE','state',false,'Refresh the config snapshot and retry discovery.']
];
const capabilityByTool = {
  blender_tools: 'three-d.targets', blender_capabilities: 'three-d.targets', blender_control: 'three-d.targets',
  blender_project: 'three-d.project', blender_scene_query: 'three-d.scene.query', blender_scene_apply: 'three-d.scene.apply',
  blender_view: 'three-d.view', blender_capture: 'three-d.capture', blender_verify: 'three-d.verify',
  blender_reference_analyze: 'three-d.reference.basic', blender_spec_revision: 'three-d.spec.write',
  blender_spec_apply: 'three-d.scene.apply', blender_job: 'three-d.jobs'
};
const executionClassFor = (toolName, action) => {
  if (toolName === 'blender_project' && !['list','status'].includes(action)) return 'project-lifecycle';
  if (toolName === 'blender_scene_apply' || toolName === 'blender_spec_apply') return 'blender-scene-write';
  if (toolName === 'blender_view' && action === 'set') return 'blender-view-write';
  if (toolName === 'blender_scene_query' || toolName === 'blender_view' || toolName === 'blender_capture') return 'blender-main-read';
  if (['blender_reference_analyze','blender_spec_revision','blender_verify'].includes(toolName)) return 'offline-worker';
  if (toolName === 'blender_job') return 'job-control';
  return 'cold-read';
};
const scopesFor = (toolName, action) => {
  if (toolName === 'blender_scene_apply' && action === 'apply') return ['scene:write'];
  if (toolName === 'blender_spec_apply' && action === 'plan') return ['spec:read','scene:read'];
  if (toolName === 'blender_spec_apply' && action === 'apply') return ['spec:read','scene:write'];
  if (toolName === 'blender_spec_revision') return [action === 'get' ? 'spec:read' : 'spec:write'];
  if (toolName === 'blender_reference_analyze' || toolName === 'blender_verify' || toolName === 'blender_capture') return ['artifact:write'];
  if (toolName === 'blender_project' && !['list','status'].includes(action)) return ['project:write'];
  if (toolName === 'blender_job' && action === 'cancel') return ['job:control'];
  return [];
};
const leaseFor = (toolName, action) => {
  if (toolName === 'blender_scene_apply' || toolName === 'blender_spec_apply') return action === 'plan' ? 'scene:read' : 'scene:write';
  if (toolName === 'blender_view' && action === 'set') return 'view:write';
  if (toolName === 'blender_project' && !['list','status'].includes(action)) return 'project:write';
  return null;
};
const manifest = {
  $schema: 'https://json-schema.org/draft/2020-12/schema', catalogVersion: '1.0.0', contractVersion: '1', blenderBaseline: '5.3.0',
  schemaDialect: 'https://json-schema.org/draft/2020-12/schema',
  tools: Object.entries(tools).map(([toolName, meta]) => ({ toolName, group: meta.group, actions: meta.actions.map(action => ({ action, capabilityId: toolName === 'blender_spec_revision' && action === 'get' ? 'three-d.spec.read' : capabilityByTool[toolName], executionClass: executionClassFor(toolName, action), sideEffectClass: action === 'apply' || action === 'open' || action === 'close' || action === 'save' || action === 'saveAs' || action === 'commit' || action === 'acquire' || action === 'renew' || action === 'release' ? 'write' : 'read', inputSchemaRef: `tools/v1/${toolName}.input.schema.json`, outputSchemaRef: `tools/v1/${toolName}.output.schema.json`, grantScopes: scopesFor(toolName, action), leaseResource: leaseFor(toolName, action), timeoutPolicy: { defaultMs: 10000, minMs: 100, maxMs: 30000, asyncOverBudget: true } })) })),
  operations: opsManifest,
  errorCodes: errorRows.map(([code, category, retryable, recovery]) => ({ code, category, retryable, recovery }))
};
await fs.writeFile(path.join(schemaRoot, 'manifest.v1.json'), `${JSON.stringify(manifest, null, 2)}\n`);
await fs.writeFile(path.join(schemaRoot, 'errors.v1.json'), `${JSON.stringify({ $schema:'https://json-schema.org/draft/2020-12/schema', errorCodes: manifest.errorCodes }, null, 2)}\n`);

const refRoot = path.join(schemaRoot, 'reference-analysis/v1');
await fs.mkdir(refRoot, { recursive: true });
const writeRef = async (filename, schema) => fs.writeFile(path.join(refRoot, filename), `${JSON.stringify({$schema:'https://json-schema.org/draft/2020-12/schema', ...schema},null,2)}\n`);
await writeRef('request.schema.json', { $id:'urn:dsh:blender:reference-analysis:request:v1', title:'Reference analysis request v1', ...tools.blender_reference_analyze && { allOf:[{ $ref:'urn:dsh:blender:tool:blender_reference_analyze:input:v1#/oneOf/0' }] } });
// Provide self-contained request/result refs under the same SSOT: the public tool input remains authoritative for request validation.
await writeRef('result.schema.json', { $id:'urn:dsh:blender:reference-analysis:result:v1', title:'Reference analysis result v1', type:'object', properties:{runId:str(128),contractVersion:{const:1},profile:enumS('basic','spatial','multiview'),pipelineVersion:str(128),configSha256:ref('digest'),inputs:arr({type:'object'},1,8),products:arr({type:'object'},0,256),stages:arr({type:'object'},0,256),proposals:arr({type:'object'},0,1024),unresolved:arr({type:'object'},0,1024)},required:['runId','contractVersion','profile','pipelineVersion','configSha256','inputs','products','stages','proposals','unresolved'],additionalProperties:false });

// Copy the contract's canonical Scene Specification schema verbatim; no parallel hand-authored scene definition.
const sourceSceneSchema = path.join(root, 'docs/internal/blender-agent/blender-agent-technical-contract-v4-scene-schema.json');
const sceneSchema = JSON.parse(await fs.readFile(sourceSceneSchema, 'utf8'));
if (sceneSchema.$id !== 'urn:dsh:blender:scene-specification:1.0.0') throw new Error('Unexpected canonical Scene Specification $id');
const sceneDir = path.join(schemaRoot, 'scene-specification');
await fs.mkdir(sceneDir, { recursive: true });
await fs.writeFile(path.join(sceneDir, '1.0.0.schema.json'), `${JSON.stringify(sceneSchema, null, 2)}\n`);
console.log(`Generated ${Object.keys(tools).length} tool contracts, ${opsManifest.length} ops, manifest, errors, reference-analysis, and canonical scene schema.`);
