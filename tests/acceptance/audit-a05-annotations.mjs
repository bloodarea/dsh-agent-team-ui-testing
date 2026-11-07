#!/usr/bin/env node
/**
 * A05 evidence in an isolated DSH instance: the human annotation document is bound to the same
 * target/runtime as the Agent's tools, and a document change rotates it.
 *
 * The annotation write surface is not a `browser_*` tool (it is the panel's only write route,
 * `POST /plugins/ui-testing/annotations`, scoped to the browserPeer + `binding=<runtimeId>`), so this
 * probe writes over that route and reads the result back through the real `browser_state` tool.
 *
 * Evidence: tests/acceptance/runs/audit-a05-<stamp>/report.json, run.log, raw/
 */
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { zstdDecompressSync } from 'node:zlib';

const HERE = dirname(fileURLToPath(import.meta.url));
const STAMP = new Date().toISOString().replace(/[:.]/g, '-');
const RUN_DIR = join(HERE, 'runs', `audit-a05-${STAMP}-${process.pid}`);
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
async function pickPort() {
  return await new Promise((done, fail) => { const server = createServer(); server.once('error', fail); server.listen(0, '127.0.0.1', () => { const port = server.address().port; server.close(() => done(port)); }); });
}
function eventsFor(home, sessionId) {
  const root = join(home, 'sessions');
  if (!existsSync(root)) return [];
  for (const slug of readdirSync(root)) {
    const file = join(root, slug, sessionId, 'session.v4.jsonl.zstd');
    if (!existsSync(file)) continue;
    return zstdDecompressSync(readFileSync(file)).toString('utf8').trim().split('\n').filter(Boolean).map((line) => { try { return JSON.parse(line); } catch { return null; } }).filter(Boolean);
  }
  return [];
}
function callsOf(events) {
  const calls = new Map();
  for (const event of events) {
    if (event.type === 'tool/call') calls.set(event.data.callId, { name: event.data.name, args: event.data.arguments });
    if (event.type === 'tool/result') {
      const id = event.data?.message?.toolCallId;
      const entry = calls.get(id) || { name: 'unknown' };
      const text = (event.data?.message?.content || []).map((part) => part?.text || '').join('\n');
      let parsed = null; try { parsed = JSON.parse(text); } catch { parsed = null; }
      entry.result = parsed; entry.raw = text.slice(0, 2000); entry.ok = parsed ? parsed.ok !== false : false;
      calls.set(id, entry);
    }
  }
  return [...calls.values()];
}

async function main() {
  await mkdir(join(RUN_DIR, 'raw'), { recursive: true });
  const home = await mkdtemp(join(tmpdir(), 'audit-a05-home-'));
  const profile = join(home, 'profiles', 'web');
  await mkdir(profile, { recursive: true });
  await mkdir(join(home, 'ws'), { recursive: true });
  for (const name of ['package.json', 'cordis.patch.yml', 'cordis.yml', 'compatibility.json']) {
    const source = join(REAL_PROFILE, name);
    if (existsSync(source)) await writeFile(join(profile, name), await readFile(source));
  }
  await symlink(join(REAL_PROFILE, 'node_modules'), join(profile, 'node_modules'), 'dir');
  const shared = join(process.env.HOME || '', '.dsh', 'profiles', 'node_modules');
  if (existsSync(shared)) await symlink(shared, join(home, 'profiles', 'node_modules'), 'dir');
  const port = await pickPort();
  const proc = spawn(DSH_BIN, ['--profile', 'web', '--port', String(port), '--no-open'], { cwd: join(home, 'ws'), env: { ...process.env, DSH_HOME: home }, stdio: ['ignore', 'pipe', 'pipe'] });
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
    const response = await fetch(`${base}/api/${method}`, { method: 'POST', headers: { 'content-type': 'application/json', Cookie: cookie }, body: JSON.stringify({ type: 'client-request', rpcId, method, payload: { args: { request } } }) });
    const text = await response.text();
    const envelope = JSON.parse(text);
    return envelope?.result?.ok ? envelope.result.value : { error: envelope?.result?.error };
  };
  const http = async (path, { method = 'GET', body, headers = {} } = {}) => {
    const response = await fetch(base + '/plugins/ui-testing' + path, { method, headers: { Cookie: cookie, ...headers, ...(body ? { 'content-type': 'application/json' } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) });
    const text = await response.text();
    let value = null; try { value = JSON.parse(text); } catch { value = text.slice(0, 200); }
    return { status: response.status, value };
  };
  const { startFixtureServer } = await import('../ui_test_fixture/server.mjs');
  const fixture = await startFixtureServer();
  const session = await rpc('session/create', { cwd: join(home, 'ws') });
  const sessionId = session.sessionId;
  await rpc('session/selectModel', { sessionId, provider: process.env.AUDIT_PROVIDER || 'deepseek-official', model: process.env.AUDIT_MODEL || 'deepseek-flash' });
  const turn = async (text) => {
    const before = eventsFor(home, sessionId).length;
    await rpc('session/prompt', { requestId: randomUUID(), sessionId, mode: 'queue', content: [{ type: 'text', text }], clientTimeZone: 'Asia/Shanghai' });
    for (let i = 0; i < 40; i += 1) { const waited = await rpc('session/wait', { sessionId, timeoutMs: 15000, maxMessages: 400 }); if (waited?.reason === 'idle') break; }
    return callsOf(eventsFor(home, sessionId).slice(before));
  };

  try {
    log(`[dsh] isolated instance ${base}, DSH_HOME=<temp>, never 3080/3081`);
    const first = await turn(`只做两件事，每次调用一个工具：1) browser_navigate {"url":"${fixture.url.replace(/\/$/, '')}/web-t2.html"}；2) browser_state（无参数）。然后报告 browser_state 里的 tab.runtimeId 与 annotations 字段。禁止其它工具。`);
    const state1 = first.filter((call) => call.name === 'browser_state').pop();
    const runtimeId = state1?.result?.tab?.runtimeId ?? null;
    const annotations1 = state1?.result?.annotations ?? null;
    observations.before = { runtimeId, annotations: annotations1 };
    check('browser_state 报告当前标签的 runtimeId（目标身份）', Boolean(runtimeId), 'runtimeId', runtimeId);

    const scopeHeaders = { 'x-ui-testing-scope-version': '1', 'x-ui-testing-scope-binding': String(runtimeId || '') };
    const scopedState = await http('/state', { headers: scopeHeaders });
    const ui = scopedState.value?.ui || {};
    const context = ui.annotationContext || null;
    observations.scopedState = {
      status: scopedState.status,
      annotationContext: context,
      view: ui.view || null,
      canvas: ui.canvas || null,
      annotationsBefore: scopedState.value?.annotations || null,
    };
    check('scoped /state 暴露 ui.annotationContext（runtimeId/documentKey/addressDigest）',
      Boolean(context && context.runtimeId && context.documentKey && /^[0-9a-f]{64}$/u.test(String(context.addressDigest || ''))),
      'annotationContext with 64-hex digest',
      context && { runtimeId: context.runtimeId, documentKey: context.documentKey, digestIsHex: /^[0-9a-f]{64}$/u.test(String(context.addressDigest || '')) });

    const view = ui.view || {};
    const publish = await http('/annotations', {
      method: 'POST',
      headers: scopeHeaders,
      body: {
        version: 1,
        panelId: randomUUID(),
        surface: 'main',
        clientRevision: 1,
        context: {
          runtimeId: context?.runtimeId ?? runtimeId,
          pageGeneration: context?.pageGeneration ?? null,
          documentEpoch: context?.documentEpoch ?? null,
          documentKey: context?.documentKey ?? '',
          addressDigest: context?.addressDigest ?? '',
        },
        view: {
          canvasX: Number.isFinite(view.canvasX) ? view.canvasX : 0,
          canvasY: Number.isFinite(view.canvasY) ? view.canvasY : 0,
          x: Number.isFinite(view.x) ? view.x : 0,
          y: Number.isFinite(view.y) ? view.y : 0,
          width: Number.isInteger(view.width) ? view.width : 1280,
          height: Number.isInteger(view.height) ? view.height : 800,
          scale: Number.isFinite(view.scale) ? view.scale : 1,
          contentWidth: Number.isInteger(view.contentWidth) ? view.contentWidth : null,
          contentHeight: Number.isInteger(view.contentHeight) ? view.contentHeight : null,
          viewRevision: Number.isInteger(view.revision) ? view.revision : 0,
          frameEpoch: null,
        },
        shapes: [{ id: 'a1', type: 'rect', color: '#ff0000', strokeWidth: 2, fill: false, stroke: true, x: 10, y: 12, width: 80, height: 24 }],
        truncation: { droppedShapes: 0, droppedPoints: 0, shortenedTextCodeUnits: 0 },
      },
    });
    observations.publish = { status: publish.status, value: publish.value };
    check('标注写面接受 scoped(binding) 的合法发布', publish.status === 200, 200, { status: publish.status, value: publish.value });

    const afterPublishState = await http('/state', { headers: scopeHeaders });
    const annotationsAfter = afterPublishState.value?.annotations || null;
    observations.afterPublishState = annotationsAfter;
    check('写面把标注文档绑定到同一 runtime/documentKey',
      Boolean(annotationsAfter)
        && annotationsAfter.context?.runtimeId === runtimeId
        && annotationsAfter.context?.documentKey === context?.documentKey
        && (annotationsAfter.shapes || []).length === 1,
      'same runtimeId+documentKey, 1 shape',
      annotationsAfter && { runtimeId: annotationsAfter.context?.runtimeId, documentKeyMatches: annotationsAfter.context?.documentKey === context?.documentKey, shapes: (annotationsAfter.shapes || []).length });

    const third = await turn(`只做两件事，每次调用一个工具：1) browser_navigate {"url":"${fixture.url.replace(/\/$/, '')}/second.html"}；2) browser_state（无参数）。然后原样报告结果。禁止其它工具。`);
    const navCall = third.filter((call) => call.name === 'browser_navigate').pop();
    check('导航切换文档成功（用于验证标注轮换）', navCall?.ok === true, true, navCall?.ok ?? null);
    const rotatedState = await http('/state', { headers: scopeHeaders });
    const rotated = rotatedState.value?.annotations || null;
    observations.afterNavigation = rotated;
    check('文档切换后标注按 documentKey 轮换（形状清空、key 变化）',
      Boolean(rotated)
        && (rotated.shapes || []).length === 0
        && rotated.context?.documentKey !== context?.documentKey,
      'shapeCount=0 且 documentKey 变化',
      rotated && { shapes: (rotated.shapes || []).length, keyChanged: rotated.context?.documentKey !== context?.documentKey });

    await writeFile(join(RUN_DIR, 'raw', 'annotation-flow.json'), JSON.stringify({
      runtimeId,
      annotationContext: context,
      annotationsBefore: observations.scopedState?.annotationsBefore,
      publish: observations.publish,
      annotationsAfterPublish: observations.afterPublishState,
      annotationsAfterNavigation: observations.afterNavigation,
    }, null, 2));
  } finally {
    try { fixture.close?.(); } catch { /* ignore */ }
    try { proc.kill('SIGTERM'); } catch { /* ignore */ }
    await sleep(1000);
    try { proc.kill('SIGKILL'); } catch { /* ignore */ }
    if (!process.argv.includes('--keep')) await rm(home, { recursive: true, force: true }).catch(() => {});
    else log(`[env] kept ${home}`);
  }

  const failed = checks.filter((entry) => !entry.pass);
  const report = {
    suite: 'audit-a05-annotations', checks,
    criteria: { passed: checks.filter((entry) => entry.pass).length, total: checks.length },
    requiredChecks: { passed: checks.filter((entry) => entry.pass).length, total: checks.length },
    failedChecks: failed.length, notRunChecks: notRuns.length, exitCode: failed.length ? 1 : 0,
    isolation: { profile: 'web', dshHome: '<temp>' }, observations, notRun: notRuns, ranAt: new Date().toISOString(),
  };
  await writeFile(join(RUN_DIR, 'report.json'), JSON.stringify(report, null, 2));
  await writeFile(join(RUN_DIR, 'run.log'), logLines.join('\n'));
  process.exit(report.exitCode);
}

main().catch(async (error) => {
  log('FATAL ' + ((error && error.stack) || String(error)));
  await mkdir(RUN_DIR, { recursive: true }).catch(() => {});
  await writeFile(join(RUN_DIR, 'run.log'), logLines.join('\n')).catch(() => {});
  process.exit(2);
});
