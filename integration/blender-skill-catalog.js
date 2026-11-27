import { lstatSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { isAbsolute, relative, resolve, sep, win32 } from 'node:path';
import { OP_IDS } from '../tools/blender/schema.js';

/** A catalog error identifies the entry and JSON Pointer that needs repair. */
export class BlenderSkillCatalogError extends Error {
  constructor(errors) {
    super(errors.map(({ pointer, entryId, message }) => `${pointer}${entryId ? ` (${entryId})` : ''}: ${message}`).join('\n'));
    this.name = 'BlenderSkillCatalogError';
    this.code = 'INVALID_SKILL_CATALOG';
    this.errors = errors;
  }
}

/**
 * Validate a bundled catalog and its resources without running Blender or starting a provider.
 * requiredOps are versioned {opId,minOpVersion} records; catalog pipelineIds name workflow entries.
 * The operation whitelist defaults to the same schema registry used by Blender Tools.
 * Throws BlenderSkillCatalogError with machine-readable, localized errors on invalid input.
 */
export function validateBlenderSkillCatalog(catalog, { resourceBase, registeredOps = OP_IDS } = {}) {
  const errors = [];
  const fail = (code, pointer, entryId, message) => errors.push({ code, pointer, entryId, message });
  const knownOps = new Set(registeredOps);
  let base;
  try {
    if (typeof resourceBase !== 'string' || !resourceBase) throw new Error('resourceBase is required');
    base = realpathSync(resourceBase);
    if (!statSync(base).isDirectory()) throw new Error('resourceBase must be a directory');
  } catch (error) {
    fail('RESOURCE_BASE', '/resourceBase', null, error.message);
  }
  if (!catalog || typeof catalog !== 'object' || Array.isArray(catalog)
      || typeof catalog.version !== 'string' || !/^\d+\.\d+\.\d+$/.test(catalog.version)
      || !Array.isArray(catalog.entries) || !catalog.entries.length) {
    fail('CATALOG_SHAPE', '/', null, 'expected version (semver) and non-empty entries[]');
    throw new BlenderSkillCatalogError(errors);
  }
  const entries = new Map();
  const stringList = (value, pointer, id) => {
    if (!Array.isArray(value) || value.some((item) => typeof item !== 'string' || !item)) {
      fail('LIST_SHAPE', pointer, id, 'expected an array of non-empty IDs');
      return [];
    }
    return value;
  };
  const checkOps = (value, pointer, id) => {
    if (!Array.isArray(value)) {
      fail('OPS_SHAPE', pointer, id, 'expected requiredOps[]');
      return;
    }
    const seen = new Set();
    value.forEach((op, i) => {
      if (!op || !knownOps.has(op.opId)) fail('UNKNOWN_OP', `${pointer}/${i}/opId`, id, `unregistered opId: ${String(op?.opId)}`);
      if (!Number.isInteger(op?.minOpVersion) || op.minOpVersion < 1) fail('OP_VERSION', `${pointer}/${i}/minOpVersion`, id, 'expected a positive integer version');
      if (seen.has(op?.opId)) fail('DUPLICATE_OP', `${pointer}/${i}/opId`, id, `duplicate opId: ${op.opId}`);
      seen.add(op?.opId);
    });
  };
  catalog.entries.forEach((entry, index) => {
    const pointer = `/entries/${index}`;
    const id = entry?.id;
    if (typeof id !== 'string' || !/^[a-z][a-z0-9-]*$/.test(id)) {
      fail('ENTRY_ID', `${pointer}/id`, null, 'expected a kebab-case id');
      return;
    }
    if (entries.has(id)) fail('DUPLICATE_ID', `${pointer}/id`, id, 'duplicate id');
    else entries.set(id, { entry, pointer });
    if (!['director', 'system', 'workflow'].includes(entry.kind)) fail('ENTRY_KIND', `${pointer}/kind`, id, 'expected director, system or workflow');
    for (const key of ['requires', 'optional', 'pipelineIds']) stringList(entry[key], `${pointer}/${key}`, id);
    checkOps(entry.requiredOps, `${pointer}/requiredOps`, id);
    const path = entry.path;
    if (typeof path !== 'string' || !path || isAbsolute(path) || win32.isAbsolute(path)
        || path.includes('\\') || path.includes(':') || path.includes('\0')
        || path.split('/').some((part) => !part || part === '.' || part === '..') || !path.endsWith('.md')) {
      fail('RESOURCE_PATH', `${pointer}/path`, id, 'expected a relative Markdown path inside resourceBase');
      return;
    }
    if (!base) return;
    try {
      let component = base;
      for (const part of path.split('/')) {
        component = resolve(component, part);
        if (lstatSync(component).isSymbolicLink()) throw new Error('linked resources are not allowed');
      }
      const file = realpathSync(component);
      const rel = relative(base, file);
      if (rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel) || !statSync(file).isFile()) throw new Error('resource is outside resourceBase or not a regular file');
      const text = readFileSync(file, 'utf8');
      if (entry.kind !== 'director') {
        const match = /^```json\r?\n([\s\S]*?)\r?\n```/m.exec(text);
        if (!match) throw new Error('resource must include a JSON metadata block');
        const metadata = JSON.parse(match[1]);
        if (metadata.id !== id || metadata.version !== catalog.version) throw new Error('resource metadata id/version differs from catalog');
        checkOps(metadata.requiredOps, `${pointer}/path#requiredOps`, id);
        if (JSON.stringify(metadata.requiredOps) !== JSON.stringify(entry.requiredOps)) throw new Error('resource requiredOps differs from catalog');
      }
    } catch (error) {
      fail('RESOURCE_READ', `${pointer}/path`, id, `${path}: ${error.message}`);
    }
  });
  for (const [id, { entry, pointer }] of entries) {
    for (const key of ['requires', 'optional', 'pipelineIds']) {
      if (!Array.isArray(entry[key])) continue;
      entry[key].forEach((ref, index) => {
        const target = entries.get(ref)?.entry;
        if (!target || (key === 'pipelineIds' && target.kind !== 'workflow')) {
          fail('DANGLING_REFERENCE', `${pointer}/${key}/${index}`, id, `${ref}: expected ${key === 'pipelineIds' ? 'workflow' : 'catalog entry'}`);
        }
      });
    }
  }
  const visited = new Set();
  const active = new Set();
  const visit = (id, chain) => {
    if (active.has(id)) {
      fail('REQUIRES_CYCLE', `${entries.get(id).pointer}/requires`, id, `requires cycle: ${[...chain, id].join(' -> ')}`);
      return;
    }
    if (visited.has(id) || !entries.has(id)) return;
    active.add(id);
    const requires = entries.get(id).entry.requires;
    if (Array.isArray(requires)) for (const dependency of requires) visit(dependency, [...chain, id]);
    active.delete(id);
    visited.add(id);
  };
  for (const id of entries.keys()) visit(id, []);
  if (errors.length) throw new BlenderSkillCatalogError(errors);
  return { valid: true, version: catalog.version, entryCount: entries.size };
}
