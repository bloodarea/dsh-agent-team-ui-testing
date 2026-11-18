/**
 * Fake environment registration (`fake`): the contract fixture used by the cross-environment
 * suites. Test-only, never a real platform.
 *
 * It exists as a registration entry for the same reason the Web one does: the public Host must be
 * able to run a whole dispatch round against a non-Web environment whose only contribution is this
 * entry plus its implementation.
 */
import { ENVIRONMENTS, defineEnvironmentEntry } from '../../core/index.js';
import { createFakeEnvironment } from './adapter.js';

const renderText = (value) => [{ type: 'text', text: typeof value === 'string' ? value : JSON.stringify(value) }];

export function createFakeEnvironmentEntry({ log = () => {} } = {}) {
  return defineEnvironmentEntry({
    id: ENVIRONMENTS.FAKE,
    label: 'Fake fixture',
    testOnly: true,
    // Deterministic and cheap (no process, no socket): registered at composition time so the
    // fixture is available before the first dispatch, exactly as before it became an entry.
    eager: true,
    // The fixture owns its probe: a platform-neutral tool definition with no page, no browser and
    // no Host internals. Registering it is the Host's job, defining it is the environment's.
    tools: [{
      name: 'browser_fake_probe',
      description: 'test-only：假环境契约探针（不启动浏览器，不代表任何真实平台）。',
      parameters: { type: 'object', properties: { payload: { type: 'object' } }, required: [] },
      output: { schema: { type: 'object' }, render: (_args, value) => renderText(value) },
      async execute(args) {
        return { ok: true, environment: 'fake', payload: (args && args.payload) || null };
      },
    }],
    create: () => {
      const fake = createFakeEnvironment();
      return {
        targetAdapter: fake.targetAdapter,
        capabilityAdapter: fake.capabilityAdapter,
        p0Provider: fake.p0Provider,
        dispose: () => fake.dispose(),
      };
    },
  });
}
