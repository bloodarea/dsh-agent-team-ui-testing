#!/usr/bin/env node
/**
 * Cross-environment foundation: per-item verification for the 11 items that the independent audit
 * left partially complete (docs/internal/cross-environment-foundation-status-20261107.md).
 *
 * Unlike `run.mjs` (Web UI regression) and `cross-environment.mjs` (control-plane / persistence),
 * this suite targets the *blocking findings* one by one and stays offline where possible:
 *
 *   A03  P0-A/C mapping direction (document-css-px -> image-px)
 *   A04  neutral network identity across transports; image/display flow without a network family
 *   A05  fake P0-D/E: rebind invalidates frames/annotations/leases; real lease generation
 *   A08  real ToolsService + SystemPrompt: per-agent tool declarations exclude other environments
 *   A09  Skill discovery/load after disabling an environment (catalog *and* body)
 *   A10  legacy HTTP page-write routes cannot bypass the environment switch
 *   A11  one immutable snapshot per config revision; two agents never share a snapshot
 *   A12  a config transition cancels/releases the resources of a scope that lost Web
 *   A13  disabled environments are not probed and never fabricated as supported/available
 *   A14  a Web-disabled host neither creates the Web faces nor starts Chromium
 *
 * Every check prints PASS/FAIL with expected/actual; the run report keeps the same structure as
 * the other suites. No real model request is issued and (except where noted) no Chromium starts.
 *
 * Usage: node tests/acceptance/foundation-isolation.mjs
 * Exit codes: 0 all checks passed, 1 assertion failure, 2 the suite could not run.
 */
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { createHarness, createFakeConnectionService, scanPluginChromeProcesses } from './harness.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const RUN_STAMP = new Date().toISOString().replace(/[:.]/g, '-');
const RUN_DIR = join(HERE, 'runs', `foundation-isolation-${RUN_STAMP}-${process.pid}`);
const REPO = dirname(dirname(HERE));

const logLines = [];
const log = (line = '') => {
  logLines.push(String(line));
  console.log(line);
};
const checks = [];
function check(label, pass, expected, actual) {
  const entry = { label, pass: Boolean(pass), expected, actual };
  checks.push(entry);
  log(`${pass ? 'PASS' : 'FAIL'} ${label}`);
  if (!pass) log('  expected=' + JSON.stringify(expected) + ' actual=' + JSON.stringify(actual));
  return Boolean(pass);
}

const agent = (id, cwd) => ({ id, session: { header: { cwd } } });
const scopedHeaders = (sessionId) => ({ 'x-ui-testing-scope-version': '1', 'x-ui-testing-session-id': sessionId });
const responseJson = (response) => (response && response.json) || {};
const getJson = async (harness, path, headers = {}) => responseJson(await harness.request({ method: 'GET', path, headers }));
const putJson = async (harness, path, body, headers = {}) => responseJson(await harness.request({ method: 'PUT', path, body, headers }));
const postJson = async (harness, path, body, headers = {}) => responseJson(await harness.request({ method: 'POST', path, body, headers }));

/* ------------------------------------------------------------------------------------------------
 * A03 — P0-A/C cross-space mapping
 * ---------------------------------------------------------------------------------------------- */
async function probeA03() {
  const { toNeutralFrame } = await import(pathToFileURL(join(REPO, 'core/p0.js')).href);
  const { mapPoint } = await import(pathToFileURL(join(REPO, 'core/geometry.js')).href);
  const frame = toNeutralFrame({
    frameId: 'f-a03',
    sessionId: 's',
    targetId: 't',
    generation: 1,
    data: Buffer.from([1, 2, 3]).toString('base64'),
    format: 'png',
    width: 4,
    height: 2,
    pageWidth: 8,
    pageHeight: 4,
    scrollX: 10,
    scrollY: 20,
    capturedAt: 1,
    receivedAt: 2,
  });
  const mapped = mapPoint(frame.mapping, { x: 18, y: 24 });
  check('A03 图像/页面比例方向正确（doc-css→image-px 为 image/page）',
    frame.mapping.scaleX === 0.5 && frame.mapping.scaleY === 0.5 && frame.mapping.from === 'document-css-px' && frame.mapping.to === 'image-px',
    { scaleX: 0.5, scaleY: 0.5 }, { scaleX: frame.mapping.scaleX, scaleY: frame.mapping.scaleY });
  check('A03 审计反例：文档点 (18,24) 在 4×2 图 / 8×4 页 / scroll(10,20) 下映射为 (4,2)',
    mapped.x === 4 && mapped.y === 2, { x: 4, y: 2 }, mapped);
}

/* ------------------------------------------------------------------------------------------------
 * A04 — network identity across transports + optional network family
 * ---------------------------------------------------------------------------------------------- */
async function probeA04() {
  const { toNeutralNetworkEvent, samePublicRequestKey } = await import(pathToFileURL(join(REPO, 'core/p0.js')).href);
  const base = { seq: 4, sessionId: 's1', targetId: 't1', generation: 1, kind: 'http', phase: 'response', requestId: 'r1', hopId: 2, url: 'https://x.test/' };
  const a = toNeutralNetworkEvent({ ...base, cdpSessionId: 'cdp-A' });
  const b = toNeutralNetworkEvent({ ...base, cdpSessionId: 'cdp-B' });
  check('A04 相同 requestId 在不同 transport 得到不同公共键',
    !samePublicRequestKey(a.requestKey, b.requestKey) && a.requestKey.transportId !== b.requestKey.transportId,
    { different: true }, { a: a.requestKey, b: b.requestKey });
  check('A04 公共键仍不泄漏 cdpSessionId（只留在 transportRef）',
    !Object.hasOwn(a.requestKey, 'cdpSessionId') && a.transportRef.cdpSessionId === 'cdp-A', true,
    { requestKey: a.requestKey, transportRef: a.transportRef });
  check('A04 跨 transport 的 eventId 也不同', a.eventId !== b.eventId, { different: true }, { a: a.eventId, b: b.eventId });

  // Image/display flow without a network family: the provider still answers A/C/E.
  const { createWebP0Provider } = await import(pathToFileURL(join(REPO, 'targets/web/provider.js')).href);
  const provider = createWebP0Provider({
    p0Dispatch: Object.assign(async (family, method) => {
      if (family === 'A' && method === 'screenshot') return { frameId: 'f1', width: 2, height: 2, mapping: { from: 'document-css-px', to: 'image-px', scaleX: 1, scaleY: 1, offsetX: 0, offsetY: 0, geometryVersion: 1 }, encoded: { format: 'png', base64: '' }, rgba: { width: 2, height: 2 }, integrity: { state: 'complete' }, evidence: { version: 1 } };
      if (family === 'C' && method === 'read') return { spaces: [{ id: 'image-px' }], mapping: { from: 'document-css-px', to: 'image-px', scaleX: 1, scaleY: 1, offsetX: 0, offsetY: 0, geometryVersion: 1 } };
      throw new Error('not wired: ' + family + '.' + method);
    }, { families: ['A', 'C', 'D', 'E'] }),
  });
  const snapshot = { revision: 1, environment: 'web', capabilities: ['web.p0.capture', 'web.p0.display', 'web.p0.targets'] };
  const session = { sessionId: 'web:s', scopeId: 's', generation: 2, target: { targetId: 'tab-1' }, configRevision: 1, closed: false };
  const status = provider.familyStatus({ session, snapshot });
  check('A04 无网络 family 时 B 如实 unsupported（不伪造）', status.B.support === 'unsupported', 'unsupported', status.B);
  let shot = null;
  try {
    shot = await provider.capture.screenshot({ args: {}, session, snapshot });
  } catch (error) {
    shot = { error: String(error && error.message) };
  }
  check('A04 去掉网络 family 后图像流程仍工作', Boolean(shot && shot.value && shot.value.frameId === 'f1'), { frameId: 'f1' }, shot);
}

/* ------------------------------------------------------------------------------------------------
 * A05 — fake P0-D/E target binding
 * ---------------------------------------------------------------------------------------------- */
async function probeA05() {
  const { createFakeEnvironment } = await import(pathToFileURL(join(REPO, 'targets/fake/adapter.js')).href);
  const fake = createFakeEnvironment({ now: () => 1_700_000_000_000 });
  const session = await fake.targetAdapter.createSession({ scope: { id: 'scope-a05' }, snapshot: { revision: 1, capabilities: [] } });
  const targets = await session.listTargets();
  await session.bind(targets[0].targetId);
  await fake.p0Provider.capture.screenshot({ args: {}, session, snapshot: { revision: 1 } });
  await fake.p0Provider.canvas.annotationWrite({
    args: { doc: { formatVersion: 1, kind: 'annotation-doc', docId: 'doc-1', targetId: targets[0].targetId, generation: session.generation, geometryVersion: 1, revision: 0, shapes: [] } },
    session,
    snapshot: { revision: 1 },
  });
  // The fake provider returns platform payloads (no {value,evidence} envelope); unwrap defensively.
  const unwrap = (result) => (result && typeof result === 'object' && result.value !== undefined ? result.value : result);
  const grabbed = unwrap(await fake.p0Provider.capture.screenshot({ session, snapshot: { revision: 1 } }));
  const lease = unwrap(await fake.p0Provider.targets.leaseAcquire({ args: { targetId: targets[0].targetId, ttlMs: 60000 }, session, snapshot: { revision: 1 } }));
  const leaseValue = lease.lease ?? lease;
  check('A05 租约带真实 target/generation（不再是 null）',
    Number.isInteger(leaseValue.generation) && leaseValue.targetId === targets[0].targetId,
    { generation: 'int', targetId: targets[0].targetId }, { generation: leaseValue.generation, targetId: leaseValue.targetId });

  await session.bind(targets[1].targetId);
  const framesAfter = unwrap(await fake.p0Provider.capture.frames({ session, snapshot: { revision: 1 } }));
  check('A05 重绑目标后旧帧不再返回', (framesAfter.frames || []).length === 0, 0, (framesAfter.frames || []).length);
  const failures = {};
  const staleFrame = grabbed?.frame?.frameId ?? null;
  for (const [name, run] of Object.entries({
    image: () => fake.p0Provider.capture.image({ args: staleFrame ? { frameId: staleFrame } : {}, session, snapshot: { revision: 1 } }),
    annotation: () => fake.p0Provider.canvas.annotationRead({ session, snapshot: { revision: 1 } }),
    leaseStatus: () => fake.p0Provider.targets.leaseStatus({ args: { leaseId: leaseValue.leaseId }, session, snapshot: { revision: 1 } }),
  })) {
    try {
      await run();
      failures[name] = 'returned';
    } catch (error) {
      failures[name] = error && error.code;
    }
  }
  check('A05 重绑后旧帧/旧标注/旧租约读取被拒（跨目标串用消失）',
    failures.image === 'GENERATION_MISMATCH' && failures.annotation === 'GENERATION_MISMATCH'
      && failures.leaseStatus === 'GENERATION_MISMATCH',
    { image: 'GENERATION_MISMATCH', annotation: 'GENERATION_MISMATCH', leaseStatus: 'GENERATION_MISMATCH' }, failures);
  await session.dispose();
  await fake.dispose();
}

/* ------------------------------------------------------------------------------------------------
 * A08 — real host declaration boundary (ToolsService + SystemPrompt)
 * ---------------------------------------------------------------------------------------------- */
const HOST_MODULES = join(process.env.DSH_HOST_MODULES
  || '/home/dev/.local/share/dsh24/lib/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai', '');
async function hostPackagesAvailable() {
  return existsSync(join(HOST_MODULES, 'dsh-tools/lib/index.js'));
}

async function probeA08(configDir) {
  if (!(await hostPackagesAvailable())) {
    check('A08 真实 ToolsService 可用（否则本项无法在宿主边界验证）', false, true, HOST_MODULES);
    return;
  }
  const { Context } = await import(pathToFileURL(join(HOST_MODULES, 'cordis/lib/index.js')).href);
  const toolsPlugin = (await import(pathToFileURL(join(HOST_MODULES, 'dsh-tools/lib/index.js')).href)).default;
  const promptPlugin = (await import(pathToFileURL(join(HOST_MODULES, 'dsh-system-prompt/lib/index.js')).href)).default;

  const hostCtx = new Context();
  hostCtx.plugin(promptPlugin);
  hostCtx.plugin(toolsPlugin);
  await new Promise((resolve) => setTimeout(resolve, 50));

  // A minimal tool executor lets the *real* system-prompt assembly run: it is the component that
  // turns the admitted tool set into the request's tool declarations.
  hostCtx.tools.setExecutor({
    describe: (definitions) => ({
      schemas: definitions.map((definition) => ({
        name: definition.name,
        description: definition.description,
        parameters: definition.parameters ?? { type: 'object', properties: {} },
      })),
    }),
  });

  const harness = await createHarness({
    name: 'foundation-a08',
    configDir,
    allowTestEnvironments: true,
    connection: createFakeConnectionService({ admit: () => ({ peer: { id: 'foundation-peer' } }), browserPeer: { id: 'foundation-peer' } }),
  });
  const plugin = harness.ctx.__internal.plugin;
  const registrations = plugin.toolDefinitions;
  for (const [name, entry] of registrations) {
    hostCtx.tools.register(entry.definition, entry.when ? { when: entry.when } : undefined);
  }
  const initial = await getJson(harness, '/plugins/ui-testing/config');
  const enabled = await putJson(harness, '/plugins/ui-testing/config', {
    expectedRevision: initial.revision,
    scope: 'global',
    patch: { environments: { fake: { enabled: true } } },
  });
  const selectResponse = await harness.request({
    method: 'POST',
    path: '/plugins/ui-testing/config/select',
    headers: scopedHeaders('agent-fake'),
    body: { scope: 'session', environment: 'fake', expectedRevision: enabled.revision },
  });
  const select = { statusCode: selectResponse.statusCode, json: responseJson(selectResponse) };
  const declared = async (id) => {
    // One agent identity for resolve *and* assemble: the host's admission view is keyed by that
    // exact object, so passing a fresh equivalent object would (correctly) yield nothing.
    const identity = agent(id, harness.workspaceDir);
    const toolSet = await hostCtx.tools.resolve({ agent: identity, modelSelection: {}, signal: new AbortController().signal });
    const assembly = await hostCtx.systemPrompt.assemble({ scope: identity, toolSet });
    const names = assembly.tools.map((tool) => tool.name).filter((name) => name.startsWith('browser_'));
    toolSet.dispose();
    return names;
  };
  const webNames = await declared('agent-web');
  const fakeNames = await declared('agent-fake');
  check('A08 会话级选择生效（fake 会话已写入配置）',
    select.statusCode === 200 && select.json.resolved && select.json.resolved.environment === 'fake',
    200, { status: select.statusCode, resolved: select.json.resolved && select.json.resolved.environment });
  // 内核能力：当组合层把 step 准入交给声明层时，`when` 会把另一环境的工具挡在请求之外。
  check('A08 内核：宿主按 step 准入时，when=false 的工具不进入声明（dsh-tools + dsh-system-prompt 实测）',
    webNames.includes('browser_snapshot') && !webNames.includes('browser_fake_probe'),
    { webHasSnapshot: true, webHasFake: false },
    { count: webNames.length, hasSnapshot: webNames.includes('browser_snapshot'), hasFake: webNames.includes('browser_fake_probe') });
  const FAKE_EXPECTED = ['browser_capabilities', 'browser_fake_probe', 'browser_state'];
  check('A08 内核：fake 会话的声明只有 fake 探针 + 两个环境无关诊断',
    fakeNames.length === FAKE_EXPECTED.length && FAKE_EXPECTED.every((name) => fakeNames.includes(name)),
    FAKE_EXPECTED, fakeNames);

  // 本机组合层：模型请求按“已注册”构建（实测 request/header 不随 when 变化），所以隔离必须由
  // 注册范围保证。这里直接核对声明面：Web 被禁用后，注册面不得再包含任何 Web 工具。
  const capabilitySnapshot = await getJson(harness, '/plugins/ui-testing/config');
  await putJson(harness, '/plugins/ui-testing/config', {
    expectedRevision: capabilitySnapshot.revision,
    scope: 'global',
    patch: { environments: { web: { enabled: false } } },
  });
  const capabilities = await harness.invoke('browser_capabilities', {}, { agent: agent('agent-web', harness.workspaceDir) });
  const declaration = capabilities.value?.adapter?.declaration;
  const registeredAfter = Array.isArray(declaration?.registeredTools) ? declaration.registeredTools : [];
  const ALLOWED_AFTER_DISABLE = ['browser_state', 'browser_capabilities', 'browser_fake_probe'];
  const webToolsAfter = registeredAfter.filter((name) => !ALLOWED_AFTER_DISABLE.includes(name));
  check('A08 组合层：Web 禁用后注册面只剩两个中立诊断（模型请求不可能再带 Web schema）',
    declaration?.registration === 'enabled-union' && webToolsAfter.length === 0 && declaration.isolated === true,
    { registration: 'enabled-union', webToolsRemaining: 0, isolated: true },
    { registration: declaration?.registration, webToolsRemaining: webToolsAfter.length, isolated: declaration?.isolated, registeredCount: declaration?.registeredCount });
  // 面板为权威（用户裁决 2026-11-07）：启用了哪些环境，就注册这些环境的工具，别的环境一个都不带。
  const enableBoth = await getJson(harness, '/plugins/ui-testing/config');
  await putJson(harness, '/plugins/ui-testing/config', {
    expectedRevision: enableBoth.revision,
    scope: 'global',
    patch: { environments: { web: { enabled: true }, fake: { enabled: true } } },
  });
  const bothDeclaration = (await harness.invoke('browser_capabilities', {}, { agent: agent('agent-web', harness.workspaceDir) })).value?.adapter?.declaration;
  const bothRegistered = Array.isArray(bothDeclaration?.registeredTools) ? bothDeclaration.registeredTools : [];
  // 36 个 Web 工具里已含 `browser_state`/`browser_capabilities` 两个中立诊断，再加 fake 探针 = 37。
  check('A08 面板为权威：Web + fake 同时启用 → 注册面 = 36 个 Web 工具 + fake 探针 = 37',
    bothDeclaration?.registeredCount === 37
      && bothRegistered.includes('browser_fake_probe')
      && bothRegistered.includes('browser_snapshot')
      && bothRegistered.includes('browser_network_events'),
    { registeredCount: 37, hasProbe: true, hasWeb: true },
    { registeredCount: bothDeclaration?.registeredCount, hasProbe: bothRegistered.includes('browser_fake_probe'), hasWeb: bothRegistered.includes('browser_snapshot') });
  const onlyFake = await getJson(harness, '/plugins/ui-testing/config');
  await putJson(harness, '/plugins/ui-testing/config', {
    expectedRevision: onlyFake.revision,
    scope: 'global',
    patch: { environments: { web: { enabled: false } } },
  });
  const fakeOnlyDeclaration = (await harness.invoke('browser_capabilities', {}, { agent: agent('agent-web', harness.workspaceDir) })).value?.adapter?.declaration;
  const fakeOnlyRegistered = Array.isArray(fakeOnlyDeclaration?.registeredTools) ? fakeOnlyDeclaration.registeredTools : [];
  check('A08 面板为权威：只启用 fake → 注册面只剩探针 + 2 个中立诊断（Web 工具一个都不带）',
    fakeOnlyDeclaration?.registeredCount === 3
      && fakeOnlyRegistered.includes('browser_fake_probe')
      && !fakeOnlyRegistered.includes('browser_snapshot'),
    { registeredCount: 3, hasProbe: true, hasWeb: false },
    { registeredCount: fakeOnlyDeclaration?.registeredCount, hasProbe: fakeOnlyRegistered.includes('browser_fake_probe'), hasWeb: fakeOnlyRegistered.includes('browser_snapshot') });

  await harness.dispose();
  hostCtx.scope?.dispose?.();
}

/* ------------------------------------------------------------------------------------------------
 * A09 — Skill isolation after disabling an environment
 * ---------------------------------------------------------------------------------------------- */
async function probeA09(configDir) {
  const harness = await createHarness({ name: 'foundation-a09', configDir, allowTestEnvironments: true, connection: createFakeConnectionService() });
  const scope = { id: 'agent-web', session: { header: { cwd: harness.workspaceDir } } };
  const before = await harness.listSkills({ scope });
  const beforeBody = await harness.getSkill('ui-testing-web', { scope });
  const current = await getJson(harness, '/plugins/ui-testing/config');
  const revision = current.revision;
  const disable = { statusCode: 200, json: await putJson(harness, '/plugins/ui-testing/config', {
    expectedRevision: revision, scope: 'global', patch: { environments: { web: { enabled: false } } },
  }) };
  const after = await harness.listSkills({ scope });
  const afterBody = await harness.getSkill('ui-testing-web', { scope });
  const common = await harness.getSkill('ui-testing-common', { scope });
  check('A09 禁用 Web 后 Skill 目录不再列出 ui-testing-web（不是只藏前端）',
    before.some((item) => item.name === 'ui-testing-web') && !after.some((item) => item.name === 'ui-testing-web'),
    { before: true, after: false }, { before: before.map((item) => item.name), after: after.map((item) => item.name) });
  check('A09 禁用 Web 后 Skill 正文不再可加载（get 返回 undefined）',
    Boolean(beforeBody && beforeBody.content && beforeBody.content.length > 1000) && afterBody === undefined,
    { beforeBody: 'loaded', afterBody: 'undefined' },
    { beforeBytes: beforeBody ? beforeBody.content.length : 0, afterBody: afterBody === undefined ? 'undefined' : 'loaded' });
  check('A09 公共 Skill 在禁用后仍可用（共用规则不跟着消失）', Boolean(common && common.content), true, common ? 'loaded' : 'undefined');
  check('A09 禁用写入成功（revision 递增）', disable.statusCode === 200 && disable.json.revision === revision + 1, revision + 1, disable.json.revision);
  await harness.dispose();
}

/* ------------------------------------------------------------------------------------------------
 * A10 — legacy HTTP page-write routes cannot bypass the environment switch
 * ---------------------------------------------------------------------------------------------- */
async function probeA10(configDir) {
  const harness = await createHarness({ name: 'foundation-a10', configDir, allowTestEnvironments: true, connection: createFakeConnectionService() });
  const current = await getJson(harness, '/plugins/ui-testing/config');
  await putJson(harness, '/plugins/ui-testing/config', {
    expectedRevision: current.revision, scope: 'global', patch: { environments: { web: { enabled: false } } },
  });
  const probes = {
    '/ensure': { method: 'POST', body: { url: 'https://example.test/' } },
    '/navigate': { method: 'POST', body: { url: 'https://example.test/' } },
    '/input': { method: 'POST', body: { events: [{ kind: 'mouse', type: 'mousePressed', x: 1, y: 1, button: 'left' }] } },
    '/eval': { method: 'POST', body: { expression: '1+1' } },
    '/reload': { method: 'POST', body: {} },
    '/history': { method: 'POST', body: { direction: 'back' } },
    '/viewport': { method: 'POST', body: { action: 'set', width: 800, height: 600 } },
  };
  const observed = {};
  for (const [route, request] of Object.entries(probes)) {
    const response = await harness.request({ method: request.method, path: '/plugins/ui-testing' + route, body: request.body });
    const payload = responseJson(response);
    observed[route] = { status: response.statusCode, code: payload.code ?? null, raw: String(response.body || '').slice(0, 160) };
  }
  const leaked = Object.entries(observed).filter(([, value]) => value.status >= 200 && value.status < 300);
  check('A10 Web 禁用后所有旧兼容页面写入口都被拒（无 2xx 旁路）', leaked.length === 0, 0, leaked);
  check('A10 拒绝码是 ADAPTER_DISABLED（可分类、不是 500/INTERNAL）',
    Object.values(observed).every((value) => value.code === 'ADAPTER_DISABLED'),
    'ADAPTER_DISABLED', Object.fromEntries(Object.entries(observed).map(([key, value]) => [key, value.code])));
  const state = await harness.request({ method: 'GET', path: '/plugins/ui-testing/state' });
  check('A10 诊断读取仍可用（禁用只挡写，不禁读）', state.statusCode === 200, 200, state.statusCode);
  await harness.dispose();
}

/* ------------------------------------------------------------------------------------------------
 * A11 — one immutable snapshot per revision, per agent
 * ---------------------------------------------------------------------------------------------- */
async function probeA11(configDir) {
  const { ConfigStore } = await import(pathToFileURL(join(REPO, 'core/config-store.js')).href);
  const store = new ConfigStore({ dir: configDir, allowTestEnvironments: true }).load();
  const one = store.resolveForAgent(agent('agent-web', join(configDir, 'ws')));
  const two = store.resolveForAgent(agent('agent-web', join(configDir, 'ws')));
  const frozen = Object.isFrozen(one) && Object.isFrozen(one.capabilities) && Object.isFrozen(one.environmentConfig);
  let mutated = null;
  try {
    one.capabilities.push('fake-injected');
    mutated = one.capabilities.includes('fake-injected');
  } catch {
    mutated = false;
  }
  check('A11 同一 revision 内同一 Agent 拿到同一个快照对象', one === two, true, one === two);
  check('A11 快照（含 capabilities/environmentConfig）不可变', frozen && mutated === false, { frozen: true, mutated: false }, { frozen, mutated });
  const fake = store.resolveForAgent(agent('agent-fake', join(configDir, 'ws')));
  // The test-only environment must be enabled before a session may select it (otherwise the
  // selection is rejected and falls back to the global environment — the behaviour under test).
  store.write({
    expectedRevision: one.revision,
    scope: 'global',
    patch: { environments: { fake: { enabled: true } }, enabledEnvironments: [...one.enabledEnvironments, 'fake'] },
  });
  const enabledRevision = store.getConfig().revision;
  store.select({ expectedRevision: enabledRevision, scope: 'session', environment: 'fake', agentId: 'agent-fake' });
  const afterWrite = store.resolveForAgent(agent('agent-web', join(configDir, 'ws')));
  const fakeAfter = store.resolveForAgent(agent('agent-fake', join(configDir, 'ws')));
  check('A11 写配置后 revision 前进且快照对象更换（不是原地修改）',
    afterWrite.revision > one.revision && afterWrite !== one, { revision: '>' + one.revision, same: false },
    { revision: afterWrite.revision, same: afterWrite === one });
  check('A11 两个 Agent 解析到不同环境，互不污染',
    afterWrite.environment === 'web' && fakeAfter.environment === 'fake',
    { web: 'web', fake: 'fake' }, { web: afterWrite.environment, fake: fakeAfter.environment });
  check('A11 未选择时 Agent 的快照仍是全局解析结果（不继承他人会话）', fake.revision === one.revision, one.revision, fake.revision);
  store.dispose();
}

/* ------------------------------------------------------------------------------------------------
 * A12 — a config transition cancels and releases the scope's resources
 * ---------------------------------------------------------------------------------------------- */
async function probeA12(configDir) {
  const harness = await createHarness({ name: 'foundation-a12', configDir, allowTestEnvironments: true, connection: createFakeConnectionService() });
  const plugin = harness.ctx.__internal.plugin;
  // Load the Web module chain the way a real tool call would, then create a page entry that a
  // config transition must release. No Chromium is started: the host is replaced by a stub.
  await harness.invoke('browser_state', {}, { agent: agent('agent-web', harness.workspaceDir) });
  plugin.registry.host = { pageCount: 0, closePage: async () => ({ closed: true }), on: () => {}, off: () => {} };
  const entry = plugin.registry.getOrCreate({ key: 'ws:a12', scope: { id: 'ws:a12', workspaceId: 'ws-a12' } });
  entry.runtime.claim('agent-web');
  const leaseBefore = Boolean(entry.runtime.lease);
  plugin.registry.selectedBySession.set('ws:a12:agent-web', { workspaceKey: 'ws:a12', tabId: 'primary' });
  // One operation is queued behind a busy slot; the transition must cancel it.
  let cancelled = null;
  const running = entry.runtime.run(async () => {
    await new Promise((resolve) => setTimeout(resolve, 120));
    return 'finished';
  }, { sessionId: 'agent-web' });
  const queued = entry.runtime.run(async () => 'queued-ran', { sessionId: 'agent-web' }).catch((error) => {
    cancelled = error && error.code;
    return null;
  });
  const current = await getJson(harness, '/plugins/ui-testing/config');
  const disabledResponse = await harness.request({
    method: 'PUT',
    path: '/plugins/ui-testing/config',
    body: { expectedRevision: current.revision, scope: 'global', patch: { environments: { web: { enabled: false } } } },
  });
  const disabled = { statusCode: disabledResponse.statusCode };
  await running.catch(() => null);
  await queued;
  const transitionLog = (harness.logs || []).find((line) => /config transition released/.test(String(line))) || '';
  check('A12 禁用 Web 的配置写入成功', disabled.statusCode === 200, 200, disabled.statusCode);
  check('A12 切换前该 scope 持有页面租约', leaseBefore === true, true, leaseBefore);
  check('A12 切换后租约被释放（不是只改会话状态）', entry.runtime.lease === undefined, undefined, entry.runtime.lease);
  check('A12 切换取消了排队中的旧操作（ABORTED）', cancelled === 'ABORTED', 'ABORTED', cancelled);
  check('A12 切换轮换了 per-session 选中标签（旧引用失效）',
    !plugin.registry.selectedBySession.has('ws:a12:agent-web'), false, plugin.registry.selectedBySession.has('ws:a12:agent-web'));
  check('A12 清理链路被真实执行并记录（日志可证）', Boolean(transitionLog), 'config transition released 1 web scope(s)', transitionLog.slice(0, 120));
  await harness.dispose();
}

/* ------------------------------------------------------------------------------------------------
 * A13 / A14 — readiness truthfulness and on-demand loading
 * ---------------------------------------------------------------------------------------------- */
async function probeA13A14(configDir) {
  const harness = await createHarness({ name: 'foundation-a13', configDir, allowTestEnvironments: true, connection: createFakeConnectionService() });
  const before = scanPluginChromeProcesses();
  const readiness = { body: await getJson(harness, '/plugins/ui-testing/readiness') };
  const after = scanPluginChromeProcesses();
  const web = (readiness.body.environments || []).find((item) => item.id === 'web');
  const planned = (readiness.body.environments || []).filter((item) => item.support === 'planned');
  // slice ②: per-provider cards are present and never borrow another provider's evidence.
  const providerCards = (web && web.providers) || null;
  check('A13 readiness 暴露逐 provider 卡片（chrome/edge/firefox 各六轴）',
    Boolean(providerCards) && ['chrome', 'edge', 'firefox'].every((id) => {
      const card = providerCards[id];
      return card && card.axes && ['support', 'enabled', 'dependency', 'connection', 'target', 'capability']
        .every((axis) => card.axes[axis]);
    }),
    'web.providers.<id>.axes',
    providerCards ? Object.keys(providerCards) : null);
  check('A13 未启用的 edge 卡片不被探测（依赖轴不借用 Chrome 证据）',
    Boolean(providerCards) && providerCards.edge && providerCards.edge.support === 'supported'
      && providerCards.edge.axes.dependency.status === 'not-probed'
      && providerCards.edge.axes.dependency.reason === 'provider-disabled',
    { support: 'supported', dependency: { status: 'not-probed', reason: 'provider-disabled' } },
    providerCards && providerCards.edge ? { support: providerCards.edge.support, dependency: providerCards.edge.axes.dependency } : null);
  check('A14 冷态 GET /readiness 未启动 Chromium', after.count === before.count, { count: before.count }, { count: after.count });
  check('A13 六个轴齐备且各自独立', Boolean(web) && ['support', 'enabled', 'dependency', 'connection', 'target', 'capability'].every((axis) => web.axes?.[axis]),
    'six axes', web ? Object.keys(web.axes || {}) : null);
  check('A13 未选择实例时 target 轴为 unbound，不是"环境不可支持"',
    web.axes.target.status === 'unbound' && web.axes.support.status === 'supported',
    { target: 'unbound', support: 'supported' }, { target: web.axes.target.status, support: web.axes.support.status });
  check('A13 planned 环境不伪造版本/support', planned.every((item) => item.axes.dependency.status === 'not-probed'), 'not-probed',
    planned.map((item) => ({ id: item.id, dependency: item.axes.dependency.status })));

  const current = await getJson(harness, '/plugins/ui-testing/config');
  await putJson(harness, '/plugins/ui-testing/config', {
    expectedRevision: current.revision, scope: 'global', patch: { environments: { web: { enabled: false } } },
  });
  const disabledReadiness = { body: await getJson(harness, '/plugins/ui-testing/readiness') };
  const webDisabled = (disabledReadiness.body.environments || []).find((item) => item.id === 'web');
  check('A13 禁用环境仍报"工程支持=supported、用户启用=false"，两件事分开',
    webDisabled.support === 'supported' && webDisabled.axes.enabled.status === 'false',
    { support: 'supported', enabled: 'false' }, { support: webDisabled.support, enabled: webDisabled.axes.enabled.status });
  check('A13 禁用环境不被探测（依赖/连接/能力轴 = not-probed + environment-disabled）',
    ['dependency', 'connection', 'capability'].every((axis) => webDisabled.axes?.[axis]?.status === 'not-probed'
      && webDisabled.axes?.[axis]?.reason === 'environment-disabled'),
    'not-probed/environment-disabled',
    { dependency: webDisabled.axes.dependency, connection: webDisabled.axes.connection, capability: webDisabled.axes.capability });
  const capabilities = await harness.invoke('browser_capabilities', {}, { agent: agent('agent-web', harness.workspaceDir) });
  check('A13 禁用后诊断仍回答"为什么不可用"（不抛错）', capabilities.ok === true, true, capabilities.error || 'ok');
  await harness.dispose();
}

/* ------------------------------------------------------------------------------------------------
 * Runner
 * ---------------------------------------------------------------------------------------------- */
async function main() {
  await mkdir(RUN_DIR, { recursive: true });
  const root = await mkdtemp(join(tmpdir(), 'dsh-foundation-'));
  const dirs = {
    a08: join(root, 'a08'),
    a09: join(root, 'a09'),
    a10: join(root, 'a10'),
    a11: join(root, 'a11'),
    a12: join(root, 'a12'),
    a13: join(root, 'a13'),
  };
  // Fresh config per probe: a disabled environment must not leak into the next check.
  for (const dir of Object.values(dirs)) await mkdir(dir, { recursive: true });
  try {
    log('== A03 P0-A/C cross-space mapping');
    await probeA03();
    log('== A04 P0-B optional network + identity');
    await probeA04();
    log('== A05 P0-D/E fake target binding');
    await probeA05();
    log('== A08 schema isolation at the host declaration boundary');
    await probeA08(dirs.a08);
    log('== A09 Skill isolation');
    await probeA09(dirs.a09);
    log('== A10 execution consistency (legacy routes)');
    await probeA10(dirs.a10);
    log('== A11 scope and concurrency');
    await probeA11(dirs.a11);
    log('== A12 switch and cleanup');
    await probeA12(dirs.a12);
    log('== A13 readiness truthfulness / A14 on-demand loading');
    await probeA13A14(dirs.a13);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
  const failed = checks.filter((item) => !item.pass);
  const report = {
    suite: 'foundation-isolation',
    stamp: RUN_STAMP,
    browserStarted: false,
    modelRequests: 0,
    total: checks.length,
    passed: checks.length - failed.length,
    failed: failed.length,
    checks,
  };
  await import('node:fs/promises').then((fs) => fs.writeFile(join(RUN_DIR, 'run-report.json'), JSON.stringify(report, null, 2)));
  await import('node:fs/promises').then((fs) => fs.writeFile(join(RUN_DIR, 'run.log'), logLines.join('\n')));
  log('');
  log(`foundation-isolation: ${checks.length - failed.length}/${checks.length} PASS, ${failed.length} failed`);
  log('evidence: ' + RUN_DIR);
  if (failed.length > 0) process.exitCode = 1;
}

main().catch((error) => {
  console.error('foundation-isolation could not run: ' + String((error && error.stack) || error));
  process.exitCode = 2;
});
