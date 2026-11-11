/**
 * M5 independent acceptance — A08 schema isolation, A09 Skill isolation, A11 scope/cache and
 * A15 context-size facts, observed at the *real request assembly boundary*.
 *
 * This suite does not use the fake Cordis context. It builds a real `@deepseek-ai/cordis`
 * Context, mounts the real `@deepseek-ai/dsh-tools` ToolsService and the real
 * `@deepseek-ai/dsh-skill` SkillRegistry, provides only the two host services the plugin
 * declares (`tools`, `webServer`) plus an authenticated `connection` stub (needed to exercise the
 * scoped `/config` HTTP routes), and mounts the real plugin with
 * `ctx.plugin(await import('../../index.js'))`.
 *
 * Model-request evidence therefore comes from the same APIs the host uses:
 *   ctx.tools.resolve({agent, modelSelection, signal}) -> per-step toolSet
 *   ctx.tools.schemas(agent, toolSet)                   -> the schema list a real request assembles
 *   ctx.skills.list({scope}) / ctx.skills.get(name, {scope})
 *
 * A08/A09 are never asserted from "the tool count" or "the page hides it": both agents share one
 * process and one config store, and only the per-agent snapshot differs.
 *
 * A15 reports serialized byte lengths and catalog/body sizes only. No tokenizer is available in
 * this checkout, so no token count and no "saved N%" claim is made.
 *
 * SKIP (node --test skip, exit 0) only when the installed DSH packages are absent. A partial or
 * failing assertion is a real failure (exit 1) with the concrete missing items in the message.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { existsSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = dirname(dirname(HERE));

/** Installed DSH roots, most specific first. Override with DSH_ROOT. */
const DSH_ROOTS = [
  process.env.DSH_ROOT,
  join(homedir(), '.local/share/dsh24/lib/node_modules/@deepseek-ai/dsh'),
  join(homedir(), '.local/share/node/lib/node_modules/@deepseek-ai/dsh'),
].filter((value) => typeof value === 'string' && value.length > 0);

function firstDshRoot() {
  for (const root of DSH_ROOTS) {
    const modules = join(root, 'node_modules', '@deepseek-ai');
    if (existsSync(join(modules, 'cordis', 'lib', 'index.js'))
      && existsSync(join(modules, 'dsh-tools', 'lib', 'index.js'))
      && existsSync(join(modules, 'dsh-skill', 'lib', 'index.js'))) {
      return { root, modules };
    }
  }
  return null;
}

const DSH = firstDshRoot();
const SKIP_REASON = DSH === null
  ? `DSH 安装缺失：在 ${DSH_ROOTS.join(', ')} 下未找到 cordis + dsh-tools + dsh-skill；用 DSH_ROOT 覆盖`
  : false;

async function loadDshModule(relativePath) {
  return import(pathToFileURL(join(DSH.modules, relativePath)).href);
}

/** 37 Web operations, imported from the adapter's own inventory (single source of truth). */
async function webOperationNames() {
  const { WEB_TOOL_OPERATION_NAMES } = await import('../../targets/web/adapter.js');
  return [...WEB_TOOL_OPERATION_NAMES].sort();
}

/**
 * Minimal HTTP driver over the handler the plugin registered on `webServer`.
 * Mirrors node:http's observable surface (lower-case headers, data/end events, writeHead/end).
 */
function callRoute(handlers, { method = 'GET', path = '/', body, headers = {} } = {}) {
  const pathname = path.split('?')[0];
  const entry = handlers.find((item) => item.kind === 'prefix'
    && (pathname === item.path || pathname.startsWith(item.path + '/')));
  if (!entry) throw new Error(`no HTTP handler registered for ${path}`);
  const req = new EventEmitter();
  req.url = path;
  req.method = method;
  req.headers = Object.fromEntries(Object.entries(headers).map(([key, value]) => [String(key).toLowerCase(), value]));
  req.destroy = () => {};
  const res = {
    statusCode: 0,
    headers: {},
    body: '',
    writeHead(status, responseHeaders) {
      this.statusCode = status;
      this.headers = { ...responseHeaders };
      return this;
    },
    end(chunk) {
      if (chunk !== undefined && chunk !== null) {
        this.body += Buffer.isBuffer(chunk) ? chunk.toString('utf8') : String(chunk);
      }
    },
  };
  const pending = entry.handler(req, res);
  process.nextTick(() => {
    if (body !== undefined) req.emit('data', Buffer.from(JSON.stringify(body), 'utf8'));
    req.emit('end');
  });
  return Promise.resolve(pending).then(() => {
    let json;
    try { json = JSON.parse(res.body); } catch { json = undefined; }
    return { status: res.statusCode, headers: res.headers, body: res.body, json };
  });
}

function agentFor(id, cwd) {
  return { id, session: { header: { cwd } } };
}

async function waitFor(check, { timeoutMs = 15000, intervalMs = 100, label = 'condition' } = {}) {
  const started = Date.now();
  for (;;) {
    const value = await check();
    if (value) return value;
    if (Date.now() - started > timeoutMs) throw new Error(`timeout waiting for ${label}`);
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
}

function namesOf(list) {
  return list.map((entry) => entry.name).sort();
}

function describeMissing(label, actual, expected, extra = '') {
  const actualSet = new Set(actual);
  const expectedSet = new Set(expected);
  const missing = expected.filter((name) => !actualSet.has(name));
  const unexpected = actual.filter((name) => !expectedSet.has(name));
  return `${label}: missing=[${missing.join(', ')}] unexpected=[${unexpected.join(', ')}] actual=${JSON.stringify(actual)}${extra ? ' ' + extra : ''}`;
}

test('M5 A08/A09/A11/A15: real ToolsService + SkillRegistry environment isolation', {
  skip: SKIP_REASON,
  timeout: 180000,
}, async (t) => {
  const { Context } = await loadDshModule('cordis/lib/index.js');
  const { ToolsService } = await loadDshModule('dsh-tools/lib/index.js');
  const { SkillRegistry } = await loadDshModule('dsh-skill/lib/index.js');
  const WEB_TOOLS = await webOperationNames();

  const configDir = await mkdtemp(join(tmpdir(), 'dsh-isolation-config-'));
  const workspaceDir = await mkdtemp(join(tmpdir(), 'dsh-isolation-workspace-'));
  const previousConfigDir = process.env.DSH_UI_TESTING_CONFIG_DIR;
  const previousAllowTestEnv = process.env.DSH_UI_TESTING_ALLOW_TEST_ENV;
  // The plugin reads these when apply() runs; the temp dir keeps the user's DSH_HOME untouched.
  process.env.DSH_UI_TESTING_CONFIG_DIR = configDir;
  process.env.DSH_UI_TESTING_ALLOW_TEST_ENV = '1';

  const ctx = new Context();
  // ToolsService only needs the prompt service to register its schema provider.
  ctx.provide('systemPrompt', { tools() { return () => {}; } });
  const tools = new ToolsService(ctx);
  const skills = new SkillRegistry(ctx);
  const httpHandlers = [];
  ctx.provide('webServer', {
    register(entry) {
      httpHandlers.push(entry);
      return () => {
        const index = httpHandlers.indexOf(entry);
        if (index >= 0) httpHandlers.splice(index, 1);
      };
    },
  });
  // Authenticated GUI peer: the legacy request gate expects `undefined` for "admitted" (0 is a
  // rejection status in the historical contract) and scoped requests need an owner peer.
  const browserPeer = { id: 'isolation-browser-peer' };
  ctx.provide('connection', {
    requestRejection() { return undefined; },
    admit() { return { peer: browserPeer }; },
    browserPeer,
  });

  let fiber;
  try {
    fiber = ctx.plugin(await import(pathToFileURL(join(REPO_ROOT, 'index.js')).href));
    await waitFor(async () => (await skills.list({})).some((entry) => entry.name === 'ui-testing-web'),
      { label: 'plugin skill provider registration' });

    const agentWeb = agentFor('agent-web', workspaceDir);
    const agentFake = agentFor('agent-fake', workspaceDir);
    const signal = new AbortController().signal;

    /** Exactly what a model request would assemble for one agent at one step. */
    const schemasFor = async (agent) => {
      const toolSet = await tools.resolve({ agent, modelSelection: {}, signal });
      const schemas = tools.schemas(agent, toolSet);
      toolSet.dispose();
      return schemas;
    };
    const toolNamesFor = async (agent) => (await schemasFor(agent)).map((schema) => schema.name).sort();

    await t.test('A08: default global web — 37 web schemas, no fake schema (both agents)', async () => {
      for (const [label, agent] of [['agent-web', agentWeb], ['agent-fake', agentFake]]) {
        const names = await toolNamesFor(agent);
        assert.equal(names.length, 37, `${label}: expected the 37 Web schemas, got ${names.length}: ${JSON.stringify(names)}`);
        assert.deepEqual(names, WEB_TOOLS, describeMissing(`${label} default web schema set`, names, WEB_TOOLS));
        assert.ok(!names.includes('browser_fake_probe'), `${label}: browser_fake_probe leaked into the default web schema list`);
      }
      const read = await callRoute(httpHandlers, { path: '/plugins/ui-testing/config?view=global' });
      assert.equal(read.status, 200, `GET /config failed: ${read.body}`);
      assert.equal(read.json.revision, 0, `fresh config dir should start at revision 0, got ${read.json.revision}`);
      assert.equal(read.json.resolved.environment, 'web', 'global default environment must be web');
    });

    await t.test('A11: per-session selection — B resolves fake, A stays web, revisions visible', async () => {
      // 1) allow + enable the test-only environment at global scope.
      const enable = await callRoute(httpHandlers, {
        method: 'PUT',
        path: '/plugins/ui-testing/config',
        body: {
          expectedRevision: 0,
          scope: 'global',
          patch: { enabledEnvironments: ['web', 'fake'], environments: { fake: { enabled: true } } },
        },
      });
      assert.equal(enable.status, 200, `PUT /config (enable fake) failed: ${enable.body}`);
      assert.equal(enable.json.revision, 1, `enable write must bump revision to 1, got ${enable.json.revision}`);

      // 2) select fake for session B only.
      const scopeHeaders = {
        'x-ui-testing-scope-version': '1',
        'x-ui-testing-session-id': 'agent-fake',
      };
      const select = await callRoute(httpHandlers, {
        method: 'POST',
        path: '/plugins/ui-testing/config/select',
        headers: scopeHeaders,
        body: { scope: 'session', environment: 'fake', expectedRevision: 1 },
      });
      assert.equal(select.status, 200, `POST /config/select failed: ${select.body}`);
      assert.equal(select.json.revision, 2, `session select must bump revision to 2, got ${select.json.revision}`);
      assert.equal(select.json.resolved.environment, 'fake', `select response resolved environment=${select.json.resolved.environment}`);

      // 3) A08 at the real assembly boundary: B sees only the fake schema; A keeps all 37.
      const fakeNames = await toolNamesFor(agentFake);
      // The fake environment offers its own operation plus the environment-neutral diagnostics
      // (browser_state / browser_capabilities): "why is it refused / what is supported here" must
      // stay answerable in every environment (plan §5.2.4, §6.2). No Web operation may leak.
      assert.deepEqual(fakeNames, ['browser_capabilities', 'browser_fake_probe', 'browser_state'],
        `agent-fake schemas after selecting fake: expected the fake probe + neutral diagnostics, got ${JSON.stringify(fakeNames)}`);
      const webNames = await toolNamesFor(agentWeb);
      assert.equal(webNames.length, 37, `agent-web must keep the 37 Web schemas after B selected fake, got ${webNames.length}`);
      assert.deepEqual(webNames, WEB_TOOLS, describeMissing('agent-web schema set after B selected fake', webNames, WEB_TOOLS));
      assert.ok(!webNames.includes('browser_fake_probe'), 'agent-web must not see the fake schema (A11 cross-agent leak)');

      // 4) The same split is visible through the HTTP config views.
      const sessionB = await callRoute(httpHandlers, { path: '/plugins/ui-testing/config?view=session', headers: scopeHeaders });
      assert.equal(sessionB.status, 200, `GET /config?view=session (B) failed: ${sessionB.body}`);
      assert.equal(sessionB.json.resolved.environment, 'fake', `session B resolved=${sessionB.json.resolved.environment}`);
      assert.equal(sessionB.json.revision, 2, `session B revision=${sessionB.json.revision}`);
      const sessionA = await callRoute(httpHandlers, {
        path: '/plugins/ui-testing/config?view=session',
        headers: { 'x-ui-testing-scope-version': '1', 'x-ui-testing-session-id': 'agent-web' },
      });
      assert.equal(sessionA.status, 200, `GET /config?view=session (A) failed: ${sessionA.body}`);
      assert.equal(sessionA.json.resolved.environment, 'web', `session A resolved=${sessionA.json.resolved.environment} (B's choice leaked)`);

      // 5) No revision drift inside one step: resolving twice yields the same revision.
      const first = tools.schemas(agentWeb, await tools.resolve({ agent: agentWeb, modelSelection: {}, signal }));
      const second = tools.schemas(agentWeb, await tools.resolve({ agent: agentWeb, modelSelection: {}, signal }));
      assert.equal(JSON.stringify(first), JSON.stringify(second), 'two consecutive steps assembled different schemas at the same revision');
      const configNow = await callRoute(httpHandlers, { path: '/plugins/ui-testing/config?view=global' });
      assert.equal(configNow.json.revision, 2, `config revision drifted to ${configNow.json.revision}`);

      // 6) A stale CAS write must be rejected and must not move the revision.
      const stale = await callRoute(httpHandlers, {
        method: 'PUT',
        path: '/plugins/ui-testing/config',
        body: { expectedRevision: 0, scope: 'global', patch: { environments: { web: { enabled: false } } } },
      });
      assert.equal(stale.status, 409, `stale PUT expected 409 CONFIG_CONFLICT, got ${stale.status}: ${stale.body}`);
      assert.equal(stale.json.code, 'CONFIG_CONFLICT', `stale PUT code=${stale.json.code}`);
      const afterConflict = await callRoute(httpHandlers, { path: '/plugins/ui-testing/config?view=global' });
      assert.equal(afterConflict.json.revision, 2, `conflict must not bump revision, got ${afterConflict.json.revision}`);
    });

    await t.test('A09: Skill catalog + body isolation (list and get both filtered)', async () => {
      const listA = await skills.list({ scope: agentWeb });
      const listB = await skills.list({ scope: agentFake });
      const namesA = namesOf(listA);
      const namesB = namesOf(listB);

      assert.ok(namesA.includes('ui-testing-web'), `agent-web catalog missing ui-testing-web: ${JSON.stringify(namesA)}`);
      assert.ok(namesA.includes('ui-testing-common'), `agent-web catalog missing ui-testing-common: ${JSON.stringify(namesA)}`);
      assert.ok(!namesA.includes('ui-testing-fake'), `agent-web catalog leaked ui-testing-fake: ${JSON.stringify(namesA)}`);
      assert.ok(namesB.includes('ui-testing-fake'), `agent-fake catalog missing ui-testing-fake: ${JSON.stringify(namesB)}`);
      assert.ok(namesB.includes('ui-testing-common'), `agent-fake catalog missing ui-testing-common: ${JSON.stringify(namesB)}`);
      assert.ok(!namesB.includes('ui-testing-web'), `agent-fake catalog leaked the Web-only ui-testing-web skill: ${JSON.stringify(namesB)}`);

      const webBody = await skills.get('ui-testing-web', { scope: agentWeb });
      assert.ok(webBody && typeof webBody.content === 'string' && webBody.content.length > 500,
        `agent-web ui-testing body missing/short: ${webBody && webBody.content ? webBody.content.length : 'undefined'}`);
      assert.ok(webBody.resourceBase && webBody.resourceBase.kind === 'directory'
        && existsSync(webBody.resourceBase.path),
        `agent-web ui-testing resourceBase not readable: ${JSON.stringify(webBody.resourceBase)}`);
      assert.equal(await skills.get('ui-testing-fake', { scope: agentWeb }), undefined,
        'explicit get("ui-testing-fake") must return undefined for the web agent (get is filtered too)');

      const fakeBody = await skills.get('ui-testing-fake', { scope: agentFake });
      assert.ok(fakeBody && typeof fakeBody.content === 'string' && fakeBody.content.length > 0,
        `agent-fake ui-testing-fake body missing: ${fakeBody ? typeof fakeBody.content : 'undefined'}`);
      assert.ok(fakeBody.resourceBase && fakeBody.resourceBase.kind === 'directory'
        && existsSync(fakeBody.resourceBase.path),
        `agent-fake ui-testing-fake resourceBase not readable: ${JSON.stringify(fakeBody.resourceBase)}`);
      assert.notEqual(fakeBody.content, webBody.content, 'fake and web bodies must not be the same document');
      assert.equal(await skills.get('ui-testing-web', { scope: agentFake }), undefined,
        'explicit get("ui-testing") must return undefined for the fake agent');

      // check-skill-registry compatibility: empty options fall back to the global config (web).
      const emptyList = namesOf(await skills.list({}));
      assert.ok(emptyList.includes('ui-testing-web'), `list({}) compatibility broke: ${JSON.stringify(emptyList)}`);
      assert.ok(!emptyList.includes('ui-testing-fake'), `list({}) must not expose the test-only skill: ${JSON.stringify(emptyList)}`);
      const emptyGet = await skills.get('ui-testing-web', {});
      assert.ok(emptyGet && emptyGet.content && emptyGet.content.length > 500,
        'get("ui-testing", {}) compatibility broke (empty options must still load the web skill)');

      // Cache invalidation: the catalog changed after the config write, in the same process.
      assert.notDeepEqual(namesB, namesA, 'agent-fake and agent-web catalogs are identical after selecting different environments');
    });

    await t.test('A15: serialized schema bytes and skill catalog/body sizes (facts only)', async () => {
      const webSchemas = await schemasFor(agentWeb);
      const fakeSchemas = await schemasFor(agentFake);
      const webSchemaBytes = Buffer.byteLength(JSON.stringify(webSchemas), 'utf8');
      const fakeSchemaBytes = Buffer.byteLength(JSON.stringify(fakeSchemas), 'utf8');
      const webList = await skills.list({ scope: agentWeb });
      const fakeList = await skills.list({ scope: agentFake });
      const descriptionBytes = (list) => Buffer.byteLength(list.map((entry) => String(entry.description || '')).join('\n'), 'utf8');
      const bodyBytes = async (list, agent) => {
        let total = 0;
        const perSkill = {};
        for (const entry of list) {
          const loaded = await skills.get(entry.name, { scope: agent });
          const bytes = Buffer.byteLength(String(loaded && loaded.content || ''), 'utf8');
          perSkill[entry.name] = bytes;
          total += bytes;
        }
        return { total, perSkill };
      };
      const webBodies = await bodyBytes(webList, agentWeb);
      const fakeBodies = await bodyBytes(fakeList, agentFake);

      t.diagnostic(`A15 web   : schemas=${webSchemas.length} schemaBytes=${webSchemaBytes} catalogEntries=${webList.length} catalogDescriptionBytes=${descriptionBytes(webList)} bodyBytes=${webBodies.total} perSkill=${JSON.stringify(webBodies.perSkill)}`);
      t.diagnostic(`A15 fake  : schemas=${fakeSchemas.length} schemaBytes=${fakeSchemaBytes} catalogEntries=${fakeList.length} catalogDescriptionBytes=${descriptionBytes(fakeList)} bodyBytes=${fakeBodies.total} perSkill=${JSON.stringify(fakeBodies.perSkill)}`);

      assert.ok(webSchemaBytes > 0 && fakeSchemaBytes > 0, 'schema serialization must be non-empty');
      assert.ok(fakeSchemaBytes < webSchemaBytes,
        `fake schema payload (${fakeSchemaBytes}B) should be smaller than the 37-tool web payload (${webSchemaBytes}B)`);
      const fakeNameSet = new Set(fakeSchemas.map((schema) => schema.name));
      // Environment-neutral diagnostics are intentionally present in every environment; every other
      // Web operation must be absent from the fake *schema set* (name identity, not a substring of
      // some description).
      const NEUTRAL_DIAGNOSTICS = ['browser_state', 'browser_capabilities'];
      for (const name of WEB_TOOLS) {
        if (NEUTRAL_DIAGNOSTICS.includes(name)) continue;
        assert.ok(!fakeNameSet.has(name), `fake schema set still declares the web tool ${name}`);
      }
      assert.ok(webList.length >= 1 && fakeList.length >= 1, 'both catalogs must expose at least one skill');
      assert.ok(webBodies.total > 0 && fakeBodies.total > 0, 'loaded skill bodies must be non-empty');
      // Only byte/count facts are asserted; no token count and no "saved N%" claim is made.
    });
  } finally {
    try {
      if (fiber && typeof fiber.dispose === 'function') await fiber.dispose();
    } finally {
      if (previousConfigDir === undefined) delete process.env.DSH_UI_TESTING_CONFIG_DIR;
      else process.env.DSH_UI_TESTING_CONFIG_DIR = previousConfigDir;
      if (previousAllowTestEnv === undefined) delete process.env.DSH_UI_TESTING_ALLOW_TEST_ENV;
      else process.env.DSH_UI_TESTING_ALLOW_TEST_ENV = previousAllowTestEnv;
      await rm(configDir, { recursive: true, force: true, maxRetries: 3 }).catch(() => {});
      await rm(workspaceDir, { recursive: true, force: true, maxRetries: 3 }).catch(() => {});
    }
  }
});
