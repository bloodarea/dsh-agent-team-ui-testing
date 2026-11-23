import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { runInNewContext } from 'node:vm';

const manifest = JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8'));

test('the current source builds the client artifact exported for DSH', () => {
  const build = new URL('../../scripts/build-client.mjs', import.meta.url);
  execFileSync(process.execPath, [fileURLToPath(build), '--check'], { stdio: 'pipe' });

  const entry = import.meta.resolve(`${manifest.name}/client`);
  const source = readFileSync(new URL(entry), 'utf8');
  const entries = [];
  runInNewContext(source, {
    window: { __ModuleLoader__: { load: (descriptor) => entries.push(descriptor) } },
  }, { filename: fileURLToPath(entry) });
  assert.equal(entries.length, 1);
  assert.equal(entries[0].id, manifest.name);

  const plugin = entries[0].factory((id) => {
    if (id === 'react') return { createElement() {} };
    if (id === 'react-dom') return {};
    assert.fail(`Unexpected client dependency ${id}`);
  });
  const slots = [];
  plugin.apply({
    slots: {
      inject: (_name, register) => register(),
      register: ({ name }, component) => {
        assert.equal(typeof component, 'function');
        slots.push(name);
      },
    },
  });
  assert.deepEqual(slots, [
    'main', 'settings.section', 'shell.overlay', 'sidebar.panellist.actions', 'sidebar.right.pane.tab',
  ]);
});
