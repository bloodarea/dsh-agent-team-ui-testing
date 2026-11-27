#!/usr/bin/env node
/** Bundled Blender Skill visibility and resource closure; never launches Blender. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { BrowserError, asBrowserError } from '../../browser-safety.js';
import { createCrossEnvironment } from '../../integration/cross-environment.js';
import { BlenderSkillCatalogError, validateBlenderSkillCatalog } from '../../integration/blender-skill-catalog.js';
import { OP_IDS, TOOL_NAMES } from '../../tools/blender/schema.js';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const resourceBase = join(REPO_ROOT, 'skills/blender-director');
const catalog = JSON.parse(readFileSync(join(resourceBase, 'catalog.json'), 'utf8'));
const validate = (value) => validateBlenderSkillCatalog(value, { resourceBase });
const forged = { locator: { dir: 'blender-director' } };

function fixture(t, { testEnvironments = false, legacy = false } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'blender-skill-config-'));
  const root = createCrossEnvironment({
    BrowserError, asBrowserError,
    env: { DSH_UI_TESTING_CONFIG_DIR: dir, ...(testEnvironments ? { DSH_UI_TESTING_ALLOW_TEST_ENV: '1' } : {}) },
  });
  let provider;
  let invalidations = 0;
  const registrations = [];
  const disposers = [];
  const skills = legacy ? {
    register: (value) => { registrations.push(value); return () => {}; },
  } : {
    registerProvider: (factory) => {
      provider = factory({ invalidate: () => { invalidations += 1; } });
      return () => {};
    },
  };
  root.registerSkills({ skills, effect: (callback) => { const dispose = callback(); disposers.push(dispose); return dispose; } });
  t.after(async () => {
    for (const dispose of disposers.reverse()) if (typeof dispose === 'function') dispose();
    await root.dispose();
    rmSync(dir, { recursive: true, force: true });
  });
  const write = (patch, extra = {}) => root.configStore.write({
    scope: 'global', expectedRevision: root.configStore.getConfig().revision, patch, ...extra,
  });
  const select = (environment = 'three-d', enabled = true, master = true) => write({
    view: environment,
    enabledEnvironments: master ? ['web', 'three-d'] : ['web'],
    environments: { 'three-d': { enabled: master, providers: { blender: { enabled } } } },
  });
  return { root, provider, write, select, registrations, invalidations: () => invalidations };
}

const names = async (provider, options) => (await provider.list(options)).map((entry) => entry.name);
const errorAt = (code, pointer, id) => (error) => {
  assert.ok(error instanceof BlenderSkillCatalogError);
  assert.equal(error.code, 'INVALID_SKILL_CATALOG');
  assert.ok(error.errors.some((item) => item.code === code && item.pointer.includes(pointer) && (!id || item.entryId === id)), error.message);
  assert.match(error.message, /\/entries\//);
  return true;
};

test('three-d + Blender enabled: list summary and get body without an attached runtime', async (t) => {
  const f = fixture(t);
  f.select();
  const list = await f.provider.list();
  const entry = list.find((item) => item.name === 'blender-director');
  assert.ok(entry);
  assert.ok(entry.description.length > 30);
  assert.equal(Object.hasOwn(entry, 'content'), false, 'discovery stays short');
  assert.equal(entry.resourceBase.path, resourceBase);
  const loaded = await f.provider.get(entry);
  assert.ok(loaded.content.includes('briefId'));
  assert.ok(loaded.content.includes('plan → apply'));
  assert.equal(loaded.invocation.modelInvocable, true);
  assert.equal(loaded.invocation.userInvocable, true);
  assert.equal(f.root.environments.peek('three-d'), null, 'reading a Skill must not instantiate Blender');
});

test('provider-only disable hides list/get including a previously listed locator; invalidation refreshes it', async (t) => {
  const f = fixture(t);
  f.select();
  const entry = (await f.provider.list()).find((item) => item.name === 'blender-director');
  const before = f.invalidations();
  f.write({ environments: { 'three-d': { providers: { blender: { enabled: false } } } } });
  assert.ok(f.invalidations() > before);
  assert.equal(f.root.isViewEnabled('three-d'), true);
  assert.equal(f.root.isProviderEnabled('three-d', 'blender'), false);
  assert.ok(!(await names(f.provider)).includes('blender-director'));
  assert.equal(await f.provider.get(entry), undefined);
  assert.equal(await f.provider.get(forged), undefined);
  f.write({ environments: { 'three-d': { providers: { blender: { enabled: true } } } } });
  assert.ok((await names(f.provider)).includes('blender-director'));
  assert.ok((await f.provider.get(entry)).content.length > 500);
});

test('three-d master disabled or another selected environment denies Blender discovery and load', async (t) => {
  const f = fixture(t);
  for (const [environment, master] of [['web', true], ['default', true], ['three-d', false]]) {
    f.select(environment, true, master);
    assert.ok(!(await names(f.provider)).includes('blender-director'), `${environment}/${master}`);
    assert.equal(await f.provider.get(forged), undefined);
    assert.ok((await names(f.provider)).includes('ui-testing-common'));
  }
  f.select('web');
  assert.ok((await names(f.provider)).includes('ui-testing-web'));
  assert.equal(await f.provider.get({ locator: { dir: '../blender-director' } }), undefined);
});

test('scope is rechecked for each agent and preserves existing Common/Web/Fake filtering', async (t) => {
  const f = fixture(t, { testEnvironments: true });
  f.select();
  f.root.configStore.select({ scope: 'session', agentId: 'web-agent', view: 'web' });
  f.root.configStore.select({ scope: 'session', agentId: 'blender-agent', view: 'three-d' });
  assert.ok(!(await names(f.provider, { scope: { id: 'web-agent' } })).includes('blender-director'));
  assert.equal(await f.provider.get(forged, { scope: { id: 'web-agent' } }), undefined);
  assert.ok((await names(f.provider, { scope: { id: 'blender-agent' } })).includes('blender-director'));
  f.write({ view: 'fake', enabledEnvironments: ['web', 'three-d', 'fake'], environments: { fake: { enabled: true } } });
  assert.deepEqual((await names(f.provider)).sort(), ['ui-testing-common', 'ui-testing-fake']);
  assert.ok((await f.provider.get({ locator: { dir: 'ui-testing-fake' } })).content.length > 100);
  f.write({ environments: { fake: { enabled: false } }, enabledEnvironments: ['web', 'three-d'] });
  assert.equal(await f.provider.get({ locator: { dir: 'ui-testing-fake' } }), undefined);
});

test('legacy host registers only historical Web fallback, never global Blender', (t) => {
  const f = fixture(t, { legacy: true });
  f.select();
  assert.deepEqual(f.registrations.map((entry) => entry.name), ['ui-testing-web']);
});

test('bundled catalog closes all 11 resources and uses the actual registered op whitelist', () => {
  assert.deepEqual(validate(catalog), { valid: true, version: '1.0.0', entryCount: 11 });
  assert.equal(catalog.entries.filter((entry) => entry.kind === 'system').length, 7);
  assert.deepEqual(catalog.entries.filter((entry) => entry.kind === 'workflow').map((entry) => entry.id).sort(), ['character', 'environment', 'prop']);
  for (const entry of catalog.entries) for (const op of entry.requiredOps) assert.ok(OP_IDS.includes(op.opId));
});

test('dangling resource path is rejected with entry ID and pointer', () => {
  const bad = structuredClone(catalog);
  bad.entries[1].path = 'systems/missing.md';
  assert.throws(() => validate(bad), errorAt('RESOURCE_READ', '/entries/1/path', 'modeling-topology'));
});

test('duplicate ID is rejected with exact entry pointer', () => {
  const bad = structuredClone(catalog);
  bad.entries.push(structuredClone(bad.entries[1]));
  assert.throws(() => validate(bad), errorAt('DUPLICATE_ID', '/entries/11/id', 'modeling-topology'));
});

test('requires cycle is rejected and exposes the dependency chain', () => {
  const bad = structuredClone(catalog);
  bad.entries[1].requires = ['prop'];
  assert.throws(() => validate(bad), (error) => {
    errorAt('REQUIRES_CYCLE', '/requires')(error);
    assert.match(error.message, /modeling-topology -> prop -> modeling-topology/);
    return true;
  });
});

test('unknown opId is rejected instead of accepting a proposed professional operation', () => {
  const bad = structuredClone(catalog);
  bad.entries[2].requiredOps = [{ opId: 'nodes.not-registered', minOpVersion: 1 }];
  assert.throws(() => validate(bad), errorAt('UNKNOWN_OP', '/entries/2/requiredOps/0/opId', 'modifiers-geometry-nodes'));
});

test('dangling dependency and unknown pipeline ID are rejected', () => {
  for (const key of ['requires', 'optional', 'pipelineIds']) {
    const bad = structuredClone(catalog);
    bad.entries[1][key] = ['missing-id'];
    assert.throws(() => validate(bad), errorAt('DANGLING_REFERENCE', `/entries/1/${key}/0`, 'modeling-topology'));
  }
  const bad = structuredClone(catalog);
  bad.entries[1].pipelineIds = ['modeling-topology'];
  assert.throws(() => validate(bad), errorAt('DANGLING_REFERENCE', '/entries/1/pipelineIds/0'));
});

test('path traversal, absolute paths and Windows path variants cannot escape resourceBase', () => {
  for (const path of ['../SKILL.md', '/tmp/SKILL.md', 'C:/SKILL.md', 'C:\\SKILL.md', '\\\\server\\share\\SKILL.md', 'systems/../../SKILL.md', 'systems/../SKILL.md', 'systems/file.md:stream', 'systems\\modeling-topology.md']) {
    const bad = structuredClone(catalog);
    bad.entries[1].path = path;
    assert.throws(() => validate(bad), errorAt('RESOURCE_PATH', '/entries/1/path', 'modeling-topology'));
  }
});

test('linked resources are rejected even when an on-disk file exists behind the link', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'blender-skill-link-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const base = join(dir, 'base');
  const outside = join(dir, 'outside');
  mkdirSync(base);
  mkdirSync(outside);
  writeFileSync(join(outside, 'SKILL.md'), '# Outside\n');
  symlinkSync(outside, join(base, 'linked'), process.platform === 'win32' ? 'junction' : 'dir');
  const bad = { version: '1.0.0', entries: [{ id: 'linked', kind: 'director', path: 'linked/SKILL.md', requires: [], optional: [], pipelineIds: [], requiredOps: [] }] };
  assert.throws(() => validateBlenderSkillCatalog(bad, { resourceBase: base }), errorAt('RESOURCE_READ', '/entries/0/path', 'linked'));
});

test('versioned metadata is checked against catalog and validates its own requiredOps', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'blender-skill-metadata-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const bad = { version: '1.0.0', entries: [{ id: 'resource', kind: 'system', path: 'system.md', requires: [], optional: [], pipelineIds: [], requiredOps: [] }] };
  writeFileSync(join(dir, 'system.md'), '# System\n\n```json\n{"id":"resource","version":"1.0.0","requiredOps":[{"opId":"bad.op","minOpVersion":1}]}\n```\n');
  assert.throws(() => validateBlenderSkillCatalog(bad, { resourceBase: dir }), errorAt('UNKNOWN_OP', '/path#requiredOps', 'resource'));
});

test('manual resources have closed links, stage contracts and no internal/process references', () => {
  for (const entry of catalog.entries) {
    const text = readFileSync(join(resourceBase, entry.path), 'utf8');
    assert.doesNotMatch(text, /docs\/internal|tests\/acceptance\/(runs|evidence)|第[一二三四五六七八九十\d]+轮|复跑计数|F:\\|D:\\/);
    for (const match of text.matchAll(/\]\(([^)]+)\)/g)) {
      assert.ok(!match[1].includes('://'), 'manual references stay within bundled resources');
      assert.ok(readFileSync(resolve(resourceBase, dirname(entry.path), match[1]), 'utf8').length > 0);
    }
    if (entry.kind === 'director') continue;
    for (const pattern of [/输入/, /输出/, /门槛/, /指标/, /单位/, /来源/, /容差/, /证据/, /unknown/, /blockers?/i]) assert.match(text, pattern, entry.path);
  }
  const director = readFileSync(join(resourceBase, 'SKILL.md'), 'utf8');
  for (const match of director.matchAll(/\bblender_[a-z_]+\b/g)) assert.ok(TOOL_NAMES.includes(match[0]), match[0]);
  for (const field of ['briefId', 'assetType', 'goal', 'specRef', 'projectRef', 'budgets', 'deliverables', 'acceptance', 'assumptions', 'stages', 'needs', 'checks']) assert.ok(director.includes(field), field);
  assert.match(director, /不拥有 Grant\/Lease/);
  assert.match(director, /payload\.ops/);
  assert.match(director, /32/);
});
