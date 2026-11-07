#!/usr/bin/env node
/**
 * A11 evidence in an isolated DSH instance: does a *session-scoped* environment selection reach
 * every layer (control plane / tool snapshot / model-facing declaration)?
 *
 * Method: boot a private DSH instance (temp `DSH_HOME`, real `web` profile, random loopback port,
 * never 3080/3081) with the documented test hook so the second (fake) environment is registered.
 * Keep the global selection on `web`, select `fake` for ONE session through
 * `POST /config/select` (`scope: session`), then run a real Agent turn in that session through the
 * HTTP Remote RPC and compare:
 *   - `/config?view=session` resolution,
 *   - `browser_capabilities.adapter.environment` (tool snapshot),
 *   - the real model request's tool declarations (captured by a local recording proxy).
 *
 * Evidence: tests/acceptance/runs/audit-a11-<stamp>/report.json, run.log
 */
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { createServer as createNetServer } from 'node:net';
import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { zstdDecompressSync } from 'node:zlib';

const HERE = dirname(fileURLToPath(import.meta.url));
const STAMP = new Date().toISOString().replace(/[:.]/g, '-');
const RUN_DIR = join(HERE, 'runs', `audit-a11-${STAMP}-${process.pid}`);
const REAL_PROFILE = join(process.env.HOME || '', '.dsh', 'profiles', 'web');
const DSH_BIN = process.env.DSH_BIN || '/home/dev/.local/share/node/bin/dsh';

const checks = [];
const notRuns = [];
const observations = {};
const logLines = [];
const redact = (text) => String(text).replace(/([?&]token=)\S+/gi, '$1[redacted]').replace(/\{\{[A-Za-z0-9_]+\}\}/g, '[secret]').replace(/[0-9a-f]{32,}/gi, '[hex]');
function log(line = '') { const text = redact(line); logLines.push(text); console.log(text); }
function check(label, pass, expected, actual) { checks.push({ label, pass: Boolean(pass), expected, actual }); log(`${pass ? 'PASS' : 'FAIL'} ${label}`); if (!pass) log('  expected=' + JSON.stringify(expected) + ' actual=' + JSON.stringify(actual)); }
function notRun(label, reason) { notRuns.push({ label, reason: String(reason) }); log(`NOT_RUN ${label} — ${reason}`); }
const sleep = (ms) => new Promise((done) => setTimeout(done, ms));
const pickPort = () => new Promise((resolve, reject) => { const server = createNetServer(); server.once('error', reject); server.listen(0, '127.0.0.1', () => { const port = server.address().port; server.close(() => resolve(port)); }); });

async function startProxy() {
  const port = await pickPort();
  const records = [];
  const server = createServer((req, res) => {
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => {
      const raw = Buffer.concat(chunks);
      let body = null;
      try { body = JSON.parse(raw.toString('utf8')); } catch { body = null; }
      records.push({ seq: records.length + 1, body });
      const upstream = httpsRequest({ host: 'api.deepseek.com', path: `/anthropic${req.url}`, method: req.method, headers: { ...req.headers, host: 'api.deepseek.com' } }, (response) => {
        res.writeHead(response.statusCode || 502, response.headers);
        response.pipe(res);
      });
      upstream.on('error', () => { if (!res.headersSent) res.writeHead(502, { 'content-type': 'application/json' }); res.end('{}'); });
      upstream.end(raw);
    });
  });
  await new Promise((resolve) => server.listen(port, '127.0.0.1', resolve));
  return { port, records, close: () => new Promise((resolve) => server.close(resolve)) };
}

async function main() {
  await mkdir(RUN_DIR, { recursive: true });
  const home = await mkdtemp(join(tmpdir(), 'audit-a11-home-'));
  const profileDir = join(home, 'profiles', 'web');
  await mkdir(profileDir, { recursive: true });
  await mkdir(join(home, 'ws'), { recursive: true });
  for (const name of ['package.json', 'cordis.patch.yml', 'cordis.yml', 'compatibility.json']) {
    const source = join(REAL_PROFILE, name);
    if (existsSync(source)) await writeFile(join(profileDir, name), await readFile(source));
  }
  await symlink(join(REAL_PROFILE, 'node_modules'), join(profileDir, 'node_modules'), 'dir');
  const shared = join(process.env.HOME || '', '.dsh', 'profiles', 'node_modules');
  if (existsSync(shared)) await symlink(shared, join(home, 'profiles', 'node_modules'), 'dir');

  const proxy = await startProxy();
  await writeFile(join(home, 'baseurl.patch.yml'), `- id: llm-deepseek\n  config:\n    baseURL: http://127.0.0.1:${proxy.port}\n`);
  const port = await pickPort();
  const proc = spawn(DSH_BIN, ['--profile', 'web', '--patch', join(home, 'baseurl.patch.yml'), '--port', String(port), '--no-open'], {
    cwd: join(home, 'ws'),
    env: { ...process.env, DSH_HOME: home, DSH_UI_TESTING_ALLOW_TEST_ENV: '1' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '';
  proc.stdout.on('data', (chunk) => { output += String(chunk); });
  proc.stderr.on('data', (chunk) => { output += String(chunk); });
  const pattern = new RegExp(`dsh web: (http://127\\.0\\.0\\.1:${port}/\\?token=(\\S+))`);
  let matched = null;
  for (let i = 0; i < 600; i += 1) { matched = pattern.exec(output); if (matched) break; await sleep(300); }
  if (!matched) throw new Error('no launch url: ' + output.slice(-400));
  const base = `http://127.0.0.1:${port}`;
  const auth = await fetch(matched[1], { redirect: 'manual' });
  const cookie = auth.headers.getSetCookie().map((value) => value.split(';')[0]).join('; ');

  const rpc = async (method, request) => {
    const rpcId = randomUUID();
    const response = await fetch(`${base}/api/${method}`, {
      method: 'POST', headers: { 'content-type': 'application/json', Cookie: cookie },
      body: JSON.stringify({ type: 'client-request', rpcId, method, payload: { args: { request } } }),
    });
    const text = await response.text();
    let envelope; try { envelope = JSON.parse(text); } catch { return { ok: false, error: { code: 'BAD_ENVELOPE' } }; }
    return envelope?.result?.ok ? { ok: true, value: envelope.result.value } : { ok: false, error: envelope?.result?.error };
  };
  const pluginHttp = async (path, { method = 'GET', body, headers = {} } = {}) => {
    const response = await fetch(base + '/plugins/ui-testing' + path, {
      method, headers: { Cookie: cookie, ...headers, ...(body ? { 'content-type': 'application/json' } : {}) },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    const text = await response.text();
    let value = null; try { value = JSON.parse(text); } catch { value = text.slice(0, 200); }
    return { status: response.status, value };
  };

  try {
    log(`[env] isolated instance ${base} (temp DSH_HOME, test hook on), proxy :${proxy.port}`);
    observations.isolation = { profile: 'web', port, allowTestEnv: true };

    // 1) Enable the second environment globally; the GLOBAL selection stays `web`.
    const config = await pluginHttp('/config');
    const enabled = await pluginHttp('/config', {
      method: 'PUT',
      body: { scope: 'global', expectedRevision: config.value.revision, patch: { environments: { fake: { enabled: true } } } },
    });
    observations.enable = { revision: enabled.value?.revision, globalEnvironment: enabled.value?.config?.global?.environment, enabled: enabled.value?.config?.global?.enabledEnvironments };
    check('全局选择保持 web、fake 仅被启用', enabled.value?.config?.global?.environment === 'web'
      && (enabled.value?.config?.global?.enabledEnvironments || []).includes('fake'),
    { globalEnvironment: 'web', enabled: ['web', 'fake'] }, observations.enable);

    // 2) Session B selects fake at session scope.
    const created = await rpc('session/create', { cwd: join(home, 'ws') });
    const sessionId = created.value.sessionId;
    const scopeHeaders = { 'x-ui-testing-scope-version': '1', 'x-ui-testing-session-id': sessionId };
    const selected = await pluginHttp('/config/select', {
      method: 'POST', headers: scopeHeaders,
      body: { expectedRevision: enabled.value.revision, scope: 'session', environment: 'fake' },
    });
    const sessionView = await pluginHttp('/config?view=session', { headers: scopeHeaders });
    observations.sessionSelect = { status: selected.status, resolved: selected.value?.resolved?.environment ?? null, viewSession: sessionView.value?.resolved?.environment ?? null };
    check('会话级选择生效（/config/select 与 /config?view=session 均为 fake）',
      observations.sessionSelect.resolved === 'fake' && observations.sessionSelect.viewSession === 'fake',
      'fake', observations.sessionSelect);

    // 3) Real turn in B: tool snapshot + real request declarations.
    await rpc('session/selectModel', { sessionId, provider: 'deepseek-official', model: process.env.AUDIT_MODEL || 'deepseek-flash' });
    const before = proxy.records.length;
    await rpc('session/prompt', {
      requestId: randomUUID(), sessionId, mode: 'queue',
      content: [{ type: 'text', text: '只做一件事：调用 browser_capabilities（参数 {}）。然后报告 adapter.environment、adapter.adapterId 与 adapter.declaration 三个字段。禁止其它工具。' }],
      clientTimeZone: 'Asia/Shanghai',
    });
    for (let i = 0; i < 30; i += 1) { const waited = await rpc('session/wait', { sessionId, timeoutMs: 15000, maxMessages: 300 }); if (waited.value?.reason === 'idle') break; }

    const requests = proxy.records.slice(before).filter((entry) => (entry.body?.tools || []).length > 0);
    const names = requests[0]?.body?.tools?.map((tool) => tool.name) || [];
    observations.request = {
      requests: requests.length,
      toolCount: names.length,
      browserTools: names.filter((name) => name.startsWith('browser_')).length,
      hasFakeProbe: names.includes('browser_fake_probe'),
    };

    const slug = readdirSync(join(home, 'sessions'))[0];
    const events = zstdDecompressSync(readFileSync(join(home, 'sessions', slug, sessionId, 'session.v4.jsonl.zstd'))).toString('utf8').trim().split('\n').map((line) => JSON.parse(line));
    let caps = null;
    for (const event of events.filter((entry) => entry.type === 'tool/result')) {
      const text = event.data?.message?.content?.[0]?.text || '';
      try { const parsed = JSON.parse(text); if (parsed?.adapter) caps = parsed; } catch { /* ignore */ }
    }
    observations.adapter = caps ? {
      environment: caps.adapter.environment, adapterId: caps.adapter.adapterId,
      configRevision: caps.adapter.configRevision, declaration: caps.adapter.declaration ?? null,
    } : null;
    check('工具快照跟随会话级选择（adapter.environment=fake）', observations.adapter?.environment === 'fake', 'fake', observations.adapter);
    check('capabilities 如实报告"声明层按全局选择"（declaration.isolated=false）',
      observations.adapter?.declaration?.isolated === false
        && observations.adapter?.declaration?.environment === 'web',
      { isolated: false, environment: 'web' }, observations.adapter?.declaration ?? null);

    // 4) Declarations: measured, not assumed.
    if (observations.request.browserTools > 3) {
      log(`[F6] 真实请求仍声明 ${observations.request.browserTools} 个 browser_* 工具（会话选择 fake，全局 web）`);
      check('F6（宿主缺口）：声明层未按会话选择隔离', true, 'measured', observations.request);
    } else {
      notRun('F6 声明层对比', '本机 Host 已按会话隔离声明，需要更新报告结论');
    }
  } finally {
    try { proc.kill('SIGTERM'); } catch { /* ignore */ }
    await sleep(1000);
    try { proc.kill('SIGKILL'); } catch { /* ignore */ }
    await proxy.close();
    if (!process.argv.includes('--keep')) await rm(home, { recursive: true, force: true }).catch(() => {});
  }

  const failed = checks.filter((entry) => !entry.pass);
  const report = {
    suite: 'audit-a11-scope', checks,
    criteria: { passed: checks.filter((entry) => entry.pass).length, total: checks.length },
    requiredChecks: { passed: checks.filter((entry) => entry.pass).length, total: checks.length },
    failedChecks: failed.length, notRunChecks: notRuns.length, exitCode: failed.length ? 1 : 0,
    isolation: observations.isolation, observations, notRun: notRuns, ranAt: new Date().toISOString(),
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
  process.exit(2);
});
