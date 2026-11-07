#!/usr/bin/env node
/**
 * A08/A09 evidence — capture the REAL outbound model request inside an isolated DSH instance.
 *
 * Method: boot a private DSH instance (`DSH_HOME` = temp dir, real `web` profile copied, random
 * loopback port, never 3080/3081), override the `llm-deepseek` provider `baseURL` with a `--patch`
 * overlay that points at a local recording proxy, then run one Agent turn through the HTTP Remote
 * RPC. The proxy records the request body (tools / system / messages) and forwards it unchanged to
 * the real upstream, streaming the real SSE response back — nothing is faked.
 *
 * What the request body itself proves (this script only records; it does not judge beyond the
 * listed checks):
 *   A08 — the plugin `browser_*` tool declarations that the model actually receives, and whether
 *          they disappear when the session environment is switched to the second (test-hook) env.
 *   A09 — the Skill payload carried by the request (catalog descriptions / loaded bodies).
 *
 * Secrets: the launch token and any API key stay in memory. Raw request bodies are written with
 * credential-bearing headers dropped; nothing is printed to stdout unredacted.
 *
 * Evidence: tests/acceptance/runs/audit-payload-<stamp>/report.json, run.log, raw/req-*.json
 */
import { createServer } from 'node:http';
import { connect } from 'node:net';
import { request as httpsRequest } from 'node:https';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { zstdDecompressSync } from 'node:zlib';

const HERE = dirname(fileURLToPath(import.meta.url));
const STAMP = new Date().toISOString().replace(/[:.]/g, '-');
const RUN_DIR = join(HERE, 'runs', `audit-payload-${STAMP}-${process.pid}`);
const REAL_PROFILE = join(process.env.HOME || '', '.dsh', 'profiles', 'web');
const DSH_BIN = process.env.DSH_BIN || 'dsh';
const UPSTREAM_HOST = 'api.deepseek.com';

const logLines = [];
const records = [];
const checks = [];
const notRuns = [];
const observations = {};

const redact = (text) => String(text)
  .replace(/([?&]token=)[^&\s"']+/gi, '$1[redacted]')
  .replace(/\{\{[A-Za-z0-9_]+\}\}/g, '[secret]')
  .replace(/[0-9a-f]{32,}/gi, '[hex]');

function log(line = '') {
  const text = redact(line);
  logLines.push(text);
  console.log(text);
}
function check(label, pass, expected, actual) {
  checks.push({ label, pass: Boolean(pass), expected, actual });
  log(`${pass ? 'PASS' : 'FAIL'} ${label}`);
  if (!pass) log('  expected=' + JSON.stringify(expected) + ' actual=' + JSON.stringify(actual));
  return Boolean(pass);
}
function notRun(label, reason) { notRuns.push({ label, reason: String(reason) }); log(`NOT_RUN ${label} — ${reason}`); }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function waitFor(fn, { timeoutMs = 30000, intervalMs = 150, label = 'condition' } = {}) {
  const started = Date.now();
  for (;;) {
    let value; try { value = await fn(); } catch { value = undefined; }
    if (value) return value;
    if (Date.now() - started > timeoutMs) throw new Error(`timeout: ${label}`);
    await sleep(intervalMs);
  }
}
async function pickPort() {
  for (let i = 0; i < 30; i += 1) {
    const port = await new Promise((resolve, reject) => {
      const srv = createServer();
      srv.once('error', reject);
      srv.listen(0, '127.0.0.1', () => { const p = srv.address().port; srv.close(() => resolve(p)); });
    });
    if (port !== 3080 && port !== 3081) return port;
  }
  throw new Error('no non-3080/3081 loopback port available');
}

/* ------------------------------------------------------------------ recording proxy ------------- */
/** Strip credential-bearing headers before anything reaches evidence. */
function scrubHeaders(headers) {
  const out = { ...headers };
  for (const key of Object.keys(out)) {
    if (/authorization|api-key|x-api-key|cookie/i.test(key)) out[key] = '[redacted]';
  }
  return out;
}
function summarizeRequest(body) {
  const tools = Array.isArray(body?.tools) ? body.tools : [];
  const messages = Array.isArray(body?.messages) ? body.messages : [];
  const system = body?.system;
  const systemText = Array.isArray(system)
    ? system.map((part) => (typeof part === 'string' ? part : part?.text || '')).join('\n')
    : (typeof system === 'string' ? system : '');
  return {
    model: body?.model ?? null,
    max_tokens: body?.max_tokens ?? null,
    stream: body?.stream ?? null,
    toolCount: tools.length,
    toolNames: tools.map((tool) => tool.name),
    toolSchemas: tools.map((tool) => ({
      name: tool.name,
      hasInputSchema: Boolean(tool.input_schema),
      schemaKeys: tool.input_schema ? Object.keys(tool.input_schema) : [],
      properties: tool.input_schema?.properties ? Object.keys(tool.input_schema.properties) : [],
    })),
    messageCount: messages.length,
    messageRoles: messages.map((message) => message.role),
    systemBytes: Buffer.byteLength(systemText),
    systemHead: systemText.slice(0, 400),
    otherTopLevelKeys: Object.keys(body || {}).filter((key) => !['model', 'tools', 'system', 'messages', 'max_tokens', 'stream'].includes(key)),
  };
}

async function startProxy() {
  const port = await pickPort();
  const server = createServer((req, res) => {
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => {
      const raw = Buffer.concat(chunks);
      let parsed = null;
      try { parsed = JSON.parse(raw.toString('utf8')); } catch { parsed = null; }
      const record = {
        seq: records.length + 1,
        at: new Date().toISOString(),
        method: req.method,
        path: req.url,
        headers: scrubHeaders(req.headers),
        bytes: raw.length,
        summary: parsed ? summarizeRequest(parsed) : null,
        body: parsed,
      };
      records.push(record);
      log(`[proxy] captured #${record.seq} ${req.method} ${req.url} bytes=${raw.length} tools=${record.summary?.toolCount ?? 'n/a'}`);
      // Forward unchanged to the real upstream and stream the real response back.
      const upstream = httpsRequest({
        host: UPSTREAM_HOST,
        path: `/anthropic${req.url}`,
        method: req.method,
        headers: { ...req.headers, host: UPSTREAM_HOST },
      }, (upRes) => {
        res.writeHead(upRes.statusCode || 502, upRes.headers);
        upRes.pipe(res);
      });
      upstream.on('error', (error) => {
        log(`[proxy] upstream error: ${error.message}`);
        if (!res.headersSent) res.writeHead(502, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: { message: 'proxy upstream error' } }));
      });
      upstream.end(raw);
    });
  });
  await new Promise((resolve) => server.listen(port, '127.0.0.1', resolve));
  return { port, server, close: () => new Promise((resolve) => server.close(resolve)) };
}

/* ------------------------------------------------------------------ isolated DSH ---------------- */
async function prepareHome() {
  const home = await mkdtemp(join(tmpdir(), 'audit-payload-home-'));
  const profileDir = join(home, 'profiles', 'web');
  await mkdir(profileDir, { recursive: true });
  await mkdir(join(home, 'ws'), { recursive: true });
  const copied = [];
  for (const name of ['package.json', 'cordis.patch.yml', 'cordis.yml', 'compatibility.json']) {
    const source = join(REAL_PROFILE, name);
    if (!existsSync(source)) continue;
    await writeFile(join(profileDir, name), await readFile(source));
    copied.push(name);
  }
  await symlink(join(REAL_PROFILE, 'node_modules'), join(profileDir, 'node_modules'), 'dir');
  const shared = join(process.env.HOME || '', '.dsh', 'profiles', 'node_modules');
  if (existsSync(shared)) await symlink(shared, join(home, 'profiles', 'node_modules'), 'dir');
  return { home, profileDir, copied };
}

async function boot({ home, proxyPort, allowTestEnv }) {
  const port = await pickPort();
  const patchPath = join(home, 'baseurl.patch.yml');
  await writeFile(patchPath, [
    '- id: llm-deepseek',
    '  config:',
    `    baseURL: http://127.0.0.1:${proxyPort}`,
    '',
  ].join('\n'));
  const proc = spawn(DSH_BIN, ['--profile', 'web', '--patch', patchPath, '--port', String(port), '--no-open'], {
    cwd: join(home, 'ws'),
    env: {
      ...process.env,
      DSH_HOME: home,
      DSH_PROFILE: 'web',
      ...(allowTestEnv ? { DSH_UI_TESTING_ALLOW_TEST_ENV: '1' } : {}),
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '';
  proc.stdout.on('data', (chunk) => { output += String(chunk); });
  proc.stderr.on('data', (chunk) => { output += String(chunk); });
  const pattern = new RegExp(`dsh web: (http://127\\.0\\.0\\.1:${port}/\\?token=(\\S+))`);
  const matched = await waitFor(() => pattern.exec(output), { timeoutMs: 180000, intervalMs: 250, label: 'isolated dsh launch url' });
  const launchUrl = matched[1];
  const auth = await fetch(launchUrl, { redirect: 'manual' });
  const cookie = auth.headers.getSetCookie().map((value) => value.split(';')[0]).join('; ');
  await waitFor(async () => {
    try { const response = await fetch(`http://127.0.0.1:${port}/`, { signal: AbortSignal.timeout(3000) }); return response.status < 500; } catch { return false; }
  }, { timeoutMs: 90000, intervalMs: 400, label: 'http listener' });
  const state = { proc, home, port, base: `http://127.0.0.1:${port}`, cookie, output: () => output };
  return state;
}

function makeRpc(state) {
  return async function rpc(method, request) {
    const rpcId = randomUUID();
    const response = await fetch(`${state.base}/api/${method}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', Cookie: state.cookie },
      body: JSON.stringify({ type: 'client-request', rpcId, method, payload: { args: { request } } }),
    });
    const text = await response.text();
    let value;
    try { value = JSON.parse(text); } catch { return { ok: false, error: { code: 'BAD_ENVELOPE', message: text.slice(0, 200) } }; }
    if (!value?.result?.ok) return { ok: false, error: value?.result?.error ?? { code: 'UNKNOWN' } };
    return { ok: true, value: value.result.value };
  };
}

async function pluginHttp(state, path, { method = 'GET', body } = {}) {
  const response = await fetch(`${state.base}/plugins/ui-testing${path}`, {
    method,
    headers: { Cookie: state.cookie, ...(body ? { 'content-type': 'application/json' } : {}) },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const text = await response.text();
  let value = null;
  try { value = JSON.parse(text); } catch { value = text.slice(0, 200); }
  return { status: response.status, value };
}

async function runTurn(state, rpc, promptText, existingSessionId = null) {
  const requestsBefore = records.length;
  // A turn may either open a new session or continue an *existing* one (A09): the old signature
  // silently ignored a caller-supplied session id, so "the same session after the environment
  // switch" was really a brand-new session and could not prove anything about history.
  let sessionId = typeof existingSessionId === 'string' && existingSessionId ? existingSessionId : null;
  let created = null;
  if (sessionId === null) {
    created = await rpc('session/create', { cwd: join(state.home, 'ws') });
    if (!created.ok) throw new Error('session/create failed: ' + JSON.stringify(created.error).slice(0, 200));
    sessionId = created.value.sessionId;
  }
  const selected = created === null
    ? { ok: true, value: { sessionId, reused: true } }
    : await rpc('session/selectModel', { sessionId, provider: 'deepseek-official', model: 'deepseek-flash' });
  const prompted = await rpc('session/prompt', {
    requestId: randomUUID(), sessionId, mode: 'queue',
    content: [{ type: 'text', text: promptText }], clientTimeZone: 'Asia/Shanghai',
  });
  if (!prompted.ok) throw new Error('session/prompt failed: ' + JSON.stringify(prompted.error).slice(0, 300));
  let reason = null;
  for (let i = 0; i < 30; i += 1) {
    const waited = await rpc('session/wait', { sessionId, timeoutMs: 15000, maxMessages: 200 });
    reason = waited.value?.reason ?? null;
    if (reason === 'idle') break;
  }
  return { sessionId, selected: selected.ok ? selected.value : selected.error, reason, requestsBefore };
}

function readSessionEvents(home, sessionId) {
  const slugDir = join(home, 'sessions');
  let file = null;
  for (const slug of readdirSync(slugDir)) {
    const candidate = join(slugDir, slug, sessionId, 'session.v4.jsonl.zstd');
    if (existsSync(candidate)) { file = candidate; break; }
  }
  if (!file) return { file: null, events: [] };
  const events = zstdDecompressSync(readFileSync(file)).toString('utf8').trim().split('\n').filter(Boolean)
    .map((line) => { try { return JSON.parse(line); } catch { return null; } }).filter(Boolean);
  return { file, events };
}
/* ------------------------------------------------------------------ main ------------------------ */
async function main() {
  await mkdir(RUN_DIR, { recursive: true });
  await mkdir(join(RUN_DIR, 'raw'), { recursive: true });
  const allowTestEnv = process.argv.includes('--allow-test-env');
  log('[env] isolated DSH home: temp dir (real web profile copied); random loopback port; never 3080/3081');
  const { home, copied } = await prepareHome();
  const proxy = await startProxy();
  log(`[proxy] listening on 127.0.0.1:${proxy.port} -> https://${UPSTREAM_HOST}/anthropic (real upstream) upstream protocol=anthropic-messages`);
  log(`[env] profile files copied: ${copied.join(',')}; allowTestEnv=${allowTestEnv}`);
  observations.isolation = { dshHome: home, profile: 'web', profileFiles: copied, allowTestEnv, proxyPort: proxy.port };
  const state = await boot({ home, proxyPort: proxy.port, allowTestEnv });
  log(`[dsh] isolated instance up on ${state.base}`);
  const rpc = makeRpc(state);

  try {
    const config = await pluginHttp(state, '/config');
    check('插件在隔离实例中挂载（/plugins/ui-testing/config 200）', config.status === 200, 200, config.status);
    observations.configInitial = { status: config.status, revision: config.value?.revision, environment: config.value?.config?.global?.environment };

    // Turn 1 — default (web) environment.
    const turn1 = await runTurn(state, rpc, '这是自动化验收。只回复两个字：收到。不要调用任何工具。');
    const turn1Requests = records.slice(turn1.requestsBefore);
    const req1 = turn1Requests.find((entry) => (entry.summary?.toolCount || 0) > 0) || turn1Requests[0] || null;
    check('真实模型出站请求经代理捕获（A08 证据来源）', Boolean(req1) && turn1Requests.length > 0, '>=1 request with tools', {
      captured: turn1Requests.length, withTools: turn1Requests.filter((e) => (e.summary?.toolCount || 0) > 0).length,
    });
    await writeFile(join(RUN_DIR, 'raw', 'req-web.json'), JSON.stringify({ headers: req1?.headers, summary: req1?.summary, body: req1?.body }, null, 2));
    const browserToolsWeb = (req1?.summary?.toolNames || []).filter((name) => name.startsWith('browser_'));
    observations.webRequest = {
      model: req1?.summary?.model, toolCount: req1?.summary?.toolCount, browserToolCount: browserToolsWeb.length,
      browserTools: browserToolsWeb, systemBytes: req1?.summary?.systemBytes, path: req1?.path,
    };
    check('A08：Web 环境的真实请求里带插件 browser_* 工具声明', browserToolsWeb.length > 0, '>0', browserToolsWeb.length);
    check('A08：Web 环境的真实请求不含 fake 专用声明（browser_fake_probe）',
      !(req1?.summary?.toolNames || []).includes('browser_fake_probe'), false, (req1?.summary?.toolNames || []).includes('browser_fake_probe'));
    check('A08：每个 browser_* 声明都带 input_schema', (req1?.summary?.toolSchemas || []).filter((t) => t.name.startsWith('browser_')).every((t) => t.hasInputSchema), true,
      (req1?.summary?.toolSchemas || []).filter((t) => t.name.startsWith('browser_')).filter((t) => !t.hasInputSchema).map((t) => t.name));

    // A09 body layer: a loaded Skill body must survive in that session's history (it cannot be
    // un-injected) while a *new* session must never receive it. DSH injects the body as a user
    // message on later requests, and one turn may emit several requests (main + title), so every
    // judgement is "some request in this window carries the body", never a fixed index.
    const webBodyMarker = '事实来源与边界';
    const fakeBodyMarker = '假环境（test-only）';
    const bodyProbe = { webBodyMarker, fakeBodyMarker };
    const requestHasMarker = (entry, marker) => JSON.stringify(entry?.body || {}).includes(marker);
    const summarizeRequests = (entries, marker) => entries.map((entry) => ({
      tools: entry.summary?.toolCount ?? null,
      messages: (entry.body?.messages || []).length,
      bytes: JSON.stringify(entry.body || {}).length,
      hasMarker: requestHasMarker(entry, marker),
    }));
    try {
      const loaded = await runTurn(state, rpc, '只调用一个工具：skill，参数 {"name":"ui-testing-web"}。调用后回复"已加载"。禁止其它工具。');
      bodyProbe.loadTurn = { sessionId: loaded.sessionId, waitReason: loaded.reason };
      const afterLoad = await runTurn(state, rpc, '只回复两个字：继续。', loaded.sessionId);
      const loadWindow = records.slice(loaded.requestsBefore);
      const loadEvents = readSessionEvents(state.home, loaded.sessionId);
      bodyProbe.loadTurnEvents = {
        toolCalls: loadEvents.events.filter((event) => event.type === 'tool/call').map((event) => event.data?.name),
        skillResults: loadEvents.events.filter((event) => event.type === 'tool/result')
          .filter((event) => JSON.stringify(event.data || {}).includes('skill_content name="ui-testing-web"')).length,
      };
      const bodySeenAfterLoad = loadWindow.some((entry) => requestHasMarker(entry, webBodyMarker));
      bodyProbe.afterLoad = {
        windowRequests: loadWindow.length,
        perRequest: summarizeRequests(loadWindow, webBodyMarker),
        hasWebBody: bodySeenAfterLoad,
        hasFakeBody: loadWindow.some((entry) => requestHasMarker(entry, fakeBodyMarker)),
        afterLoadTurnRequests: records.slice(afterLoad.requestsBefore).length,
      };
      check('A09：同一会话加载 ui-testing 后，后续真实请求里携带该 Skill 正文',
        bodySeenAfterLoad === true && (bodyProbe.loadTurnEvents.toolCalls || []).includes('skill'), true,
        { bodySeenAfterLoad, toolCalls: bodyProbe.loadTurnEvents.toolCalls });
      await writeFile(join(RUN_DIR, 'raw', 'a09-body-load.json'), JSON.stringify(bodyProbe, null, 2));
    } catch (error) {
      notRun('A09 正文层（会话内已加载）', 'skill 加载轮失败: ' + String(error && error.message).slice(0, 160));
    }

    const switchMark = records.length;
    // Switch to the second (test-only) environment and run a NEW session.
    let fakeTurn = null;
    if (allowTestEnv) {
      const current = config.value?.config;
      if (!current) {
        notRun('A08 第二环境对比', '未能读取插件配置，无法切换环境');
      } else {
        // Step A: enable the second (test-only) environment through the documented patch contract.
        const enabled = await pluginHttp(state, '/config', {
          method: 'PUT',
          bodies: undefined,
          body: { scope: 'global', expectedRevision: config.value.revision, patch: { environments: { fake: { enabled: true } } } },
        });
        // Step B: select it as the current environment.
        const selectedEnv = await pluginHttp(state, '/config/select', {
          method: 'POST',
          body: { expectedRevision: enabled.value?.revision ?? config.value.revision, scope: 'global', environment: 'fake' },
        });
        const after = await pluginHttp(state, '/config');
        observations.configAfterSwitch = {
          enable: { status: enabled.status, revision: enabled.value?.revision, error: enabled.value?.error ?? null },
          select: { status: selectedEnv.status, resolved: selectedEnv.value?.resolved ?? null, error: selectedEnv.value?.error ?? null },
          after: { revision: after.value?.revision, environment: after.value?.config?.global?.environment, enabledEnvironments: after.value?.config?.global?.enabledEnvironments },
        };
        check('配置切到 fake 环境成功（enable + select，带 revision 冲突检测）',
          selectedEnv.status === 200 && selectedEnv.value?.resolved?.environment === 'fake',
          'resolved.environment=fake', observations.configAfterSwitch);
        fakeTurn = await runTurn(state, rpc, '这是自动化验收。只回复两个字：收到。不要调用任何工具。');
        const fakeRequests = records.slice(fakeTurn.requestsBefore);
        const req2 = fakeRequests.find((entry) => (entry.summary?.toolCount || 0) > 0) || null;
        if (req2) {
          await writeFile(join(RUN_DIR, 'raw', 'req-fake.json'), JSON.stringify({ headers: req2.headers, summary: req2.summary, body: req2.body }, null, 2));
          const names = req2.summary?.toolNames || [];
          // Environment-neutral diagnostics (browser_state/browser_capabilities) are intentionally
          // offered in every environment; every other browser_* operation is Web-only.
          const NEUTRAL = ['browser_state', 'browser_capabilities'];
          const webOnly = names.filter((name) => name.startsWith('browser_') && !NEUTRAL.includes(name) && name !== 'browser_fake_probe');
          observations.fakeRequest = {
            model: req2.summary?.model, toolCount: names.length,
            browserTools: names.filter((n) => n.startsWith('browser_')),
            webOnlyTools: webOnly, neutralDiagnostics: names.filter((n) => NEUTRAL.includes(n)),
            hasFakeProbe: names.includes('browser_fake_probe'), path: req2.path,
          };
          check('A08：fake 环境的新会话请求里不再有 Web 专用操作声明', webOnly.length === 0, 0, webOnly);
          check('A08：fake 环境请求保留环境无关诊断（browser_state/browser_capabilities）',
            observations.fakeRequest.neutralDiagnostics.length === 2, 2, observations.fakeRequest.neutralDiagnostics);
          check('A08：fake 环境请求里出现 browser_fake_probe', observations.fakeRequest.hasFakeProbe === true, true, observations.fakeRequest.hasFakeProbe);
        } else {
          notRun('A08 第二环境对比', '切换后模型请求未经过代理（可能配置未生效或会话复用了旧快照）');
        }
        // A09: the Web Skill body already injected into session A's history must survive the switch
        // (it cannot be un-injected), while a NEW session must never receive it.
        if (bodyProbe.loadTurn?.sessionId) {
          try {
            await runTurn(state, rpc, '只回复两个字：继续。', bodyProbe.loadTurn.sessionId);
            const postSwitch = records.slice(switchMark);
            bodyProbe.afterSwitchSessionA = {
              windowRequests: postSwitch.length,
              perRequest: summarizeRequests(postSwitch, webBodyMarker),
              hasWebBody: postSwitch.some((entry) => requestHasMarker(entry, webBodyMarker)),
              hasFakeBody: postSwitch.some((entry) => requestHasMarker(entry, fakeBodyMarker)),
            };
            // Measured: this host re-assembles the Skill context on every step, so the Web body is
            // not a durable history message — after the switch it is simply absent. That is *better*
            // than the plan's assumption (nothing has to be un-injected) but it must be stated as
            // measured behaviour, not as "history stayed".
            check('A09：切换环境后，旧会话的后续请求不再携带 Web Skill 正文',
              bodyProbe.afterSwitchSessionA.hasWebBody === false, false, bodyProbe.afterSwitchSessionA);
            check('A09：切换环境后，旧会话的后续请求也不携带 fake 正文（正文按当前环境重新组装）',
              bodyProbe.afterSwitchSessionA.hasFakeBody === false, false, bodyProbe.afterSwitchSessionA);
            const newSessionText = records.slice(fakeTurn.requestsBefore).map((entry) => JSON.stringify(entry.body || {})).join('\n');
            check('A09：切换后新建的会话不携带 Web Skill 正文',
              !newSessionText.includes(webBodyMarker), false, { hasWebBody: newSessionText.includes(webBodyMarker) });
          } catch (error) {
            notRun('A09 切换后旧会话正文', '恢复旧会话失败: ' + String(error && error.message).slice(0, 160));
          }
        }
      }
    } else {
      notRun('A08 第二环境对比', '未启用 --allow-test-env：当前构建里没有第二个可切换的真实环境');
    }

    // A09 — Skill payload carried by the same real requests.
    const systemWeb = req1?.summary?.systemHead || '';
    observations.skillPayload = { webSystemBytes: req1?.summary?.systemBytes ?? null, webSystemHead: systemWeb };
    observations.skillBodyIsolation = bodyProbe;
    check('A09：真实请求携带 Skill/系统负载（system 非空）', (req1?.summary?.systemBytes || 0) > 0, '>0 bytes', req1?.summary?.systemBytes ?? 0);
    const webSkillMentions = /ui-testing/i.test(systemWeb);
    observations.skillPayload.webSkillMentionedInSystemHead = webSkillMentions;
    const catalogOf = (body) => {
      const text = JSON.stringify(body || {});
      return [...text.matchAll(/- `([a-z0-9-]+)`: /g)].map((match) => match[1]).filter((name) => name.startsWith('ui-testing'));
    };
    const webCatalog = catalogOf(req1?.body);
    const fakeTurnRequests = fakeTurn ? records.slice(fakeTurn.requestsBefore).filter((entry) => (entry.summary?.toolCount || 0) > 0) : [];
    const fakeCatalog = catalogOf(fakeTurnRequests[0]?.body);
    observations.skillCatalog = { web: webCatalog, fake: fakeCatalog };
    check('A09：Web 环境请求的 Skill 目录含 ui-testing(+common)、不含 ui-testing-fake',
      webCatalog.includes('ui-testing') && !webCatalog.includes('ui-testing-fake'), 'ui-testing present, fake absent', webCatalog);
    if (allowTestEnv && fakeCatalog.length) {
      check('A09：fake 环境新会话请求的 Skill 目录切换为 ui-testing-fake、不含 ui-testing',
        fakeCatalog.includes('ui-testing-fake') && !fakeCatalog.includes('ui-testing'), 'fake present, ui-testing absent', fakeCatalog);
    } else {
      notRun('A09 第二环境 Skill 目录对比', '未取得 fake 环境的请求体');
    }
    notRun('A09 Skill 正文（已注入历史 vs 新会话）的完整隔离判定',
      'system 负载是分片/截断视图，需人工核对 raw/req-*.json 全文；本脚本只如实保留原文，不据片段下结论');

    const events = readSessionEvents(home, turn1.sessionId);
    observations.turn1 = { sessionId: turn1.sessionId, waitReason: turn1.reason, eventsFile: events.file, eventCount: events.events.length };
    check('隔离实例里的会话事件可解析（证据可追溯）', events.events.length > 0, '>0 events', events.events.length);
  } finally {
    try { state.proc.kill('SIGTERM'); } catch { /* ignore */ }
    await sleep(1500);
    try { state.proc.kill('SIGKILL'); } catch { /* ignore */ }
    await proxy.close();
    if (process.argv.includes('--keep')) log(`[env] kept isolated home: ${home}`);
    else await rm(home, { recursive: true, force: true }).catch(() => {});
  }

  const failed = checks.filter((entry) => !entry.pass);
  const report = {
    suite: 'audit-payload-capture',
    objective: 'A08/A09 — 真实模型出站请求中的插件工具声明与 Skill 负载（隔离 DSH 实例）',
    checks,
    criteria: { passed: checks.filter((entry) => entry.pass).length, total: checks.length },
    requiredChecks: { passed: checks.filter((entry) => entry.pass).length, total: checks.length },
    failedChecks: failed.length,
    notRunChecks: notRuns.length,
    exitCode: failed.length ? 1 : 0,
    isolation: observations.isolation,
    proxy: { upstream: `https://${UPSTREAM_HOST}/anthropic`, protocol: 'anthropic-messages', requestsCaptured: records.length },
    observations,
    notRun: notRuns,
    ranAt: new Date().toISOString(),
  };
  await writeFile(join(RUN_DIR, 'report.json'), JSON.stringify(report, null, 2));
  await writeFile(join(RUN_DIR, 'run.log'), logLines.join('\n'));
  log(`report: ${join(RUN_DIR, 'report.json')}`);
  process.exit(report.exitCode);
}

main().catch(async (error) => {
  log('FATAL ' + ((error && error.stack) || String(error)));
  await mkdir(RUN_DIR, { recursive: true }).catch(() => {});
  await writeFile(join(RUN_DIR, 'run.log'), logLines.join('\n')).catch(() => {});
  await writeFile(join(RUN_DIR, 'report.json'), JSON.stringify({
    suite: 'audit-payload-capture', checks, criteria: { passed: 0, total: checks.length },
    failedChecks: 0, notRunChecks: notRuns.length + 1, exitCode: 2, blocked: String(error && error.message), notRun: notRuns,
  }, null, 2)).catch(() => {});
  process.exit(2);
});
