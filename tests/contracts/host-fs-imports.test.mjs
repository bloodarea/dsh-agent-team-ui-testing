/**
 * Every `node:fs` function a first-party file calls must actually be imported.
 *
 * Written after a real defect: `targets/web/host.js` called `mkdirSync` in the headed-profile
 * branch while importing only `accessSync`/`statSync`. Headed mode therefore could not start at
 * all — the browser launch threw `mkdirSync is not defined`, so every page/input call failed with
 * `INTERNAL` while the code still *looked* correct. Two more call sites (`readFileSync`,
 * `unlinkSync`) were missing too: one silently disabled the bundled Skill (the read is wrapped in
 * `try/catch`) and the other broke cookie import / artifact cleanup.
 *
 * A runtime unit test cannot catch this class of bug — only starting that branch can — so the
 * check is static: for a fixed list of `node:fs` API names, a file that calls the name must also
 * import it from `node:fs` or `node:fs/promises`.
 */
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';

const REPO_ROOT = join(import.meta.dirname, '..', '..');

/**
 * `node:fs` names checked. Deliberately only the sync, unambiguous API surface: names like `open`,
 * `stat` or `readFile` collide with ordinary local helpers, and a namespace import
 * (`import * as fs from 'node:fs'`) already cannot have this defect.
 */
const FS_API = [
  'accessSync', 'appendFileSync', 'chmodSync', 'closeSync', 'copyFileSync', 'existsSync',
  'fsyncSync', 'fstatSync', 'linkSync', 'lstatSync', 'mkdirSync', 'mkdtempSync', 'openSync',
  'readdirSync', 'readFileSync', 'readlinkSync', 'realpathSync', 'renameSync', 'rmSync',
  'statSync', 'truncateSync', 'unlinkSync', 'writeFileSync', 'writeSync',
];

/** First-party sources; vendored `reference/` and build output are out of scope. */
function firstPartyFiles() {
  const out = [];
  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.name === 'node_modules' || entry.name === '.git' || entry.name === 'reference'
        || entry.name === 'runs' || entry.name === 'evidence' || entry.name === 'output') continue;
      const path = join(dir, entry.name);
      if (entry.isDirectory()) walk(path);
      else if (entry.name.endsWith('.js') || entry.name.endsWith('.mjs')) out.push(path);
    }
  };
  for (const dir of ['targets', 'core']) walk(join(REPO_ROOT, dir));
  for (const name of readdirSync(REPO_ROOT)) {
    if (name.endsWith('.js')) out.push(join(REPO_ROOT, name));
  }
  return out;
}

/** Names imported from `node:fs` / `node:fs/promises` (aliases resolved to the local name). */
function importedFsNames(source) {
  const names = new Set();
  for (const match of source.matchAll(/import\s*\{([^}]+)\}\s*from\s*['"]node:fs(?:\/promises)?['"]/gu)) {
    for (const part of match[1].split(',')) {
      const pieces = part.trim().split(/\s+as\s+/u);
      const local = (pieces[1] || pieces[0] || '').trim();
      if (local) names.add(local);
    }
  }
  return names;
}

/** True when the file takes the module as a namespace, which cannot have a missing-name defect. */
function usesFsNamespace(source) {
  return /import\s+\*\s+as\s+\w+\s+from\s*['"]node:fs(?:\/promises)?['"]/u.test(source);
}

/** Which FS_API names this file calls as a bare function (not `obj.name(`). */
function calledFsNames(source) {
  const called = [];
  for (const name of FS_API) {
    const pattern = new RegExp(`(?<![.\\w$])${name}\\s*\\(`, 'u');
    if (pattern.test(source)) called.push(name);
  }
  return called;
}

test('first-party files import every node:fs function they call', () => {
  const problems = [];
  for (const file of firstPartyFiles()) {
    const source = readFileSync(file, 'utf8');
    const called = calledFsNames(source);
    if (called.length === 0 || usesFsNamespace(source)) continue;
    const imported = importedFsNames(source);
    const missing = called.filter((name) => !imported.has(name));
    if (missing.length > 0) problems.push(`${file.slice(REPO_ROOT.length + 1)}: ${missing.join(', ')}`);
  }
  assert.deepEqual(problems, [], `missing node:fs imports:\n${problems.join('\n')}`);
});

test('the headed-profile branch really has mkdirSync available', () => {
  const source = readFileSync(join(REPO_ROOT, 'targets', 'web', 'host.js'), 'utf8');
  assert.match(source, /mkdirSync\(profileDir/u, 'the headed profile dir is created with mkdirSync');
  assert.ok(importedFsNames(source).has('mkdirSync'), 'host.js imports mkdirSync');
});
