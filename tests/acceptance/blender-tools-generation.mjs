import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';

const root = resolve(import.meta.dirname, '../..');
async function snapshot(directory, prefix = '') {
  const result = {};
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const name = prefix + entry.name;
    if (entry.isDirectory()) Object.assign(result, await snapshot(join(directory, entry.name), name + '/'));
    else result[name] = (await readFile(join(directory, entry.name))).toString('base64');
  }
  return result;
}

test('npm pack dry-run includes Blender runtime schema and loader', () => {
  const result = spawnSync(process.platform === 'win32' ? 'npm.cmd' : 'npm', ['pack', '--dry-run', '--json'], { cwd: root, encoding: 'utf8', windowsHide: true, shell: process.platform === 'win32' });
  assert.equal(result.status, 0, result.stderr);
  const report = JSON.parse(result.stdout.trim());
  const files = new Set(report[0].files.map(entry => entry.path));
  assert.ok(files.has('schemas/blender/manifest.v1.json'));
  assert.ok(files.has('tools/blender/schema.js'));
  console.log('NPM_PACK_EVIDENCE: schemas/blender/manifest.v1.json, tools/blender/schema.js');
});

test('generator preserves every existing schema byte except authorized control challenge and manifest metadata', async () => {
  const schemaRoot = join(root, 'schemas/blender');
  const before = await snapshot(schemaRoot);
  let previous;
  for (let run = 0; run < 2; run++) {
    const result = spawnSync(process.execPath, ['tools/blender/generate-schemas.mjs'], { cwd: root, encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
    const after = await snapshot(schemaRoot);
    assert.deepEqual(Object.keys(after).sort(), Object.keys(before).sort());
    const changed = Object.keys(before).filter(name => before[name] !== after[name]);
    assert.ok(changed.every(name => ['manifest.v1.json', 'tools/v1/blender_control.output.schema.json'].includes(name)), `Unexpected schema changes: ${changed}`);
    if (previous) assert.deepEqual(after, previous, 'Repeated generation must be byte-identical.');
    previous = after;
    console.log(`GENERATOR_RUN_${run + 1}: changed=${JSON.stringify(changed)}; ${Object.keys(after).length} schema files checked`);
  }
});
