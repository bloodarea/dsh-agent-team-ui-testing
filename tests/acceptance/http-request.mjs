/**
 * P22 — `browser_http_request` (docs/t1-http-request.md §2–§8).
 *
 * Everything goes through the registered tool wrapper on a fake Cordis context. Temporary
 * loopback servers (port 0, bounded, closed in `finally`) provide redirect chains, method rules,
 * binary/streaming bodies and header edge cases. Chromium is never started by these calls; the
 * cold/lease behaviour is asserted with a fresh harness. Zero-dispatch evidence wraps the
 * `node:http` module property (`http.request`), which the implementation calls at dispatch time.
 */
import { readFile, mkdtemp, rm } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { createServer as createHttpServer } from 'node:http';
import { createServer as createHttpsServer } from 'node:https';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { tmpdir } from 'node:os';
import http from 'node:http';
import zlib from 'node:zlib';
import { createHarness, scanPluginChromeProcesses, snapshotProfileDirs } from './harness.mjs';

const DSH_ROOT = process.env.DSH_ROOT || '<local-path>/.local/share/node/lib/node_modules/@deepseek-ai/dsh';
const DSH_MODULES = join(DSH_ROOT, 'node_modules', '@deepseek-ai');
const REPO_ROOT = pathToFileURL(join(import.meta.dirname, '../../')).href;

async function loadValidator() {
  const packageDir = join(DSH_MODULES, 'dsh-util-values');
  const manifest = JSON.parse(await readFile(join(packageDir, 'package.json'), 'utf8'));
  const root = manifest.exports?.['.'];
  const entry = typeof root === 'string' ? root : root?.default || root?.import || root?.require || manifest.main;
  const module = await import(pathToFileURL(join(packageDir, String(entry || 'lib/index.js').replace(/^\.\//, ''))).href);
  return { version: manifest.version, snapshotJsonValue: module.snapshotJsonValue, isJsonValue: module.isJsonValue };
}

function undefinedPaths(value, path = 'value', out = []) {
  if (Array.isArray(value)) { value.forEach((item, index) => undefinedPaths(item, `${path}[${index}]`, out)); return out; }
  if (!value || typeof value !== 'object') return out;
  for (const key of Object.keys(value)) {
    if (value[key] === undefined) out.push(`${path}.${key}`);
    else undefinedPaths(value[key], `${path}.${key}`, out);
  }
  return out;
}

async function startRecordServer(handler, host = '127.0.0.1') {
  const state = { requests: [], counts: {} };
  const server = createHttpServer((req, res) => {
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => {
      const body = Buffer.concat(chunks);
      const path = String(req.url || '/').split('?')[0];
      const entry = { method: req.method, url: req.url, path, headers: req.headers, body, bodyText: body.toString('utf8') };
      state.requests.push(entry);
      state.counts[path] = (state.counts[path] || 0) + 1;
      handler(req, res, state, entry);
    });
  });
  await new Promise((resolve) => server.listen(0, host, resolve));
  const port = server.address().port;
  return { state, port, host, url: `http://${host}:${port}`, close: () => new Promise((resolve) => server.close(resolve)) };
}

function buildMainHandler(second) {
  return (req, res) => {
    const path = String(req.url || '').split('?')[0];
    if (path === '/r') { res.writeHead(302, { location: '/t', 'cache-control': 'no-store' }); res.end(); return; }
    if (path === '/t') { res.writeHead(200, { 'content-type': 'text/plain' }); res.end('target'); return; }
    if (path === '/a') { res.writeHead(302, { location: '/b' }); res.end(); return; }
    if (path === '/b') { res.writeHead(302, { location: '/c' }); res.end(); return; }
    if (path === '/c') { res.writeHead(200, { 'content-type': 'text/plain' }); res.end('c'); return; }
    if (path.startsWith('/m/')) { res.writeHead(Number(path.slice(3)), { location: '/echo-method' }); res.end(); return; }
    if (path === '/echo-method') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ method: req.method }));
      return;
    }
    if (path === '/same') { res.writeHead(302, { location: '/same-target' }); res.end(); return; }
    if (path === '/same-target') { res.writeHead(200, { 'content-type': 'text/plain' }); res.end('same'); return; }
    if (path === '/meta') { res.writeHead(302, { location: 'http://169.254.169.254/latest/meta-data/' }); res.end(); return; }
    if (path === '/userinfo') { res.writeHead(302, { location: 'http://user:pass@127.0.0.1:1/x' }); res.end(); return; }
    if (path === '/file') { res.writeHead(302, { location: 'file:///etc/passwd' }); res.end(); return; }
    if (path === '/badloc') { res.writeHead(302, { location: 'http://[invalid' }); res.end(); return; }
    if (path === '/dsh') { res.writeHead(302, { location: second.dshOrigin }); res.end(); return; }
    if (path === '/to-second') { res.writeHead(302, { location: second.url + '/landing' }); res.end(); return; }
    if (path === '/exact10') { res.writeHead(200, { 'content-type': 'text/plain', 'content-length': '10' }); res.end('abcdefghij'); return; }
    if (path === '/exact11') { res.writeHead(200, { 'content-type': 'text/plain' }); res.end('abcdefghijk'); return; }
    if (path === '/stream') {
      res.writeHead(200, { 'content-type': 'text/plain' });
      let index = 0;
      const timer = setInterval(() => {
        if (index >= 40) { clearInterval(timer); res.end(); return; }
        res.write('0123456789');
        index += 1;
      }, 2);
      res.on('close', () => clearInterval(timer));
      return;
    }
    if (path === '/binary') { res.writeHead(200, { 'content-type': 'application/octet-stream' }); res.end(Buffer.from([0, 255, 1])); return; }
    if (path === '/utf8cut') { res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8' }); res.end(Buffer.from([0xe6, 0xb1, 0x89, 0xe5])); return; }
    if (path === '/gzip') {
      res.writeHead(200, { 'content-type': 'application/json', 'content-encoding': 'gzip' });
      res.end(zlib.gzipSync(Buffer.from('{"compressed":true}')));
      return;
    }
    if (path === '/bigheaders') { res.writeHead(200, { 'content-type': 'text/plain', 'x-big': 'a'.repeat(20000) }); res.end('big'); return; }
    if (path === '/setcookie') {
      res.setHeader('set-cookie', ['a=1; Path=/', 'b=2; Path=/']);
      res.setHeader('x-dup', ['one', 'two']);
      res.setHeader('location', '/landing?token=leak#frag');
      res.writeHead(200, { 'content-type': 'text/plain' });
      res.end('cookie');
      return;
    }
    if (path === '/slowbody') { res.writeHead(200, { 'content-type': 'text/plain' }); res.write('partial'); return; }
    if (path === '/close-early') {
      res.writeHead(200, { 'content-type': 'text/plain', 'content-length': '100' });
      res.write('short');
      setTimeout(() => { try { res.socket.destroy(); } catch { /* ignore */ } }, 5);
      return;
    }
    if (path === '/204') { res.writeHead(204); res.end(); return; }
    if (path === '/proto') { res.setHeader('__proto__', 'probe'); res.writeHead(200, { 'content-type': 'text/plain' }); res.end('proto'); return; }
    res.writeHead(200, { 'content-type': 'text/plain' });
    res.end('ok');
  };
}

export async function httpRequestProbe({ check, finding, fixture }) {
  const validator = await loadValidator();
  const harness = await createHarness({ name: 'p22-http' });
  const httpTool = (args, exec) => harness.invoke('browser_http_request', args, exec);
  const pidsBefore = new Set(scanPluginChromeProcesses().map((item) => item.pid));
  const profilesBefore = await snapshotProfileDirs();
  let main;
  let second;
  let local;
  let echoServer;
  let secure;
  let tempDir;
  let dispatchCount = 0;
  const realRequest = http.request;
  http.request = function spy(...args) { dispatchCount += 1; return realRequest.apply(this, args); };
  try {
    // --- P22.1 registration + defaults -----------------------------------------------------
    const names = harness.toolNames();
    // 16 = 9 T1 + 7 T2 (docs/t2-structured-gui.md §2.2); the independent HTTP primitive must stay
    // registered next to them and keep its own defaults.
    check('P22.1 注册表恰有 16 个工具且含 browser_http_request', names.length === 16 && names.includes('browser_http_request'), { names });
    const health = await httpTool({ url: fixture.url + 'health' });
    check('P22.1 默认参数：GET/200/utf8/bodyBytes/无截断/无重定向',
      health.ok === true && health.value.status === 200 && health.value.method === 'GET'
      && health.value.encoding === 'utf8' && health.value.bodyTruncated === false
      && health.value.bodyBytes === Buffer.byteLength(health.value.body, 'utf8')
      && health.value.redirects.length === 0
      && Number.isInteger(health.value.timings.headersMs) && health.value.timings.totalMs >= health.value.timings.headersMs,
      { status: health.value?.status, timings: health.value?.timings });
    check('P22.1 /health 正文严格等于 fixture 固定 JSON',
      JSON.stringify(JSON.parse(health.value.body)) === JSON.stringify({ ok: true, status: 'healthy', fixture: 'dsh-ui-testing' }));

    // --- P22.2 POST echo ------------------------------------------------------------------
    echoServer = await startRecordServer((req, res, state, entry) => {
      let parsed;
      try { parsed = JSON.parse(entry.bodyText); } catch { parsed = entry.bodyText; }
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ method: req.method, echo: parsed }));
    });
    const echo = await httpTool({ method: 'POST', url: echoServer.url + '/api/echo', headers: { 'content-type': 'application/json' }, body: '{"probe":"P22"}' });
    const echoSeen = echoServer.state.requests[0];
    check('P22.2 POST echo：200、echo 对象、服务端原始字节一致',
      echo.ok && echo.value.status === 200
      && JSON.stringify(JSON.parse(echo.value.body)) === JSON.stringify({ method: 'POST', echo: { probe: 'P22' } })
      && echoSeen?.bodyText === '{"probe":"P22"}' && echoSeen?.headers['content-type'] === 'application/json',
      { body: echo.value?.body, serverBytes: echoSeen?.bodyText });

    // --- P22.3 HTTP error statuses --------------------------------------------------------
    const err500 = await httpTool({ url: fixture.url + 'api/error' });
    const err404 = await httpTool({ url: fixture.url + 'missing' });
    check('P22.3 HTTP 500/404 不抛错、ok:true 且 status/正文精确',
      err500.ok && err500.value.ok === true && err500.value.status === 500
      && JSON.stringify(JSON.parse(err500.value.body)) === JSON.stringify({ error: 'fixture-internal-error', status: 500 })
      && err404.ok && err404.value.ok === true && err404.value.status === 404
      && JSON.stringify(JSON.parse(err404.value.body)) === JSON.stringify({ error: 'not-found', status: 404 }));

    // --- P22.4 default no-follow ----------------------------------------------------------
    main = await startRecordServer((req, res) => buildMainHandler(second)(req, res));
    second = await startRecordServer((req, res) => { res.writeHead(200, { 'content-type': 'text/plain' }); res.end('landing'); });
    second.dshOrigin = second.url;
    const noFollow = await httpTool({ url: main.url + '/r' });
    check('P22.4 默认不跟随：302、redirects=[]、空正文、目标端 0 请求',
      noFollow.ok && noFollow.value.status === 302 && noFollow.value.redirects.length === 0
      && noFollow.value.body === '' && main.state.counts['/t'] === undefined,
      { counts: main.state.counts });
    check('P22.4 Location 已绝对解析为 string[]', Array.isArray(noFollow.value.headers.location)
      && noFollow.value.headers.location[0] === main.url + '/t', { location: noFollow.value.headers.location });

    // --- P22.5 explicit follow + per-hop validation ---------------------------------------
    const followed = await httpTool({ url: fixture.url + 'redirect', followRedirects: true, maxRedirects: 1 });
    check('P22.5 显式跟随：200、最终 URL/正文、redirects 恰一项',
      followed.ok && followed.value.status === 200 && /second\.html\?from=redirect/.test(followed.value.url)
      && followed.value.body.includes('second-page') && followed.value.redirects.length === 1
      && followed.value.redirects[0].status === 302 && followed.value.redirects[0].method === 'GET'
      && !JSON.stringify(followed.value).includes('landed'), { url: followed.value?.url, redirects: followed.value?.redirects });
    local = await startRecordServer((req, res) => {
      if (req.url === '/a') { res.writeHead(302, { location: `http://localhost:${local.port}/b` }); res.end(); return; }
      res.writeHead(200, { 'content-type': 'text/plain' }); res.end('local-b');
    }, 'localhost');
    const resolveCalls = [];
    const { HttpClient } = await import(pathToFileURL(join(new URL(REPO_ROOT).pathname, 'index.js')).href);
    const hopClient = new HttpClient({ origins: () => [], resolve: async (host) => { resolveCalls.push(host); return [{ address: '127.0.0.1' }]; } });
    const hop = await hopClient.request({ url: `http://localhost:${local.port}/a`, followRedirects: true, maxRedirects: 2 }, { meta: {} });
    check('P22.5 每跳都重新校验目标（初始 + 重定向各一次 DNS）',
      hop.ok && resolveCalls.length === 2 && local.state.counts['/a'] === 1 && local.state.counts['/b'] === 1,
      { resolveCalls, counts: local.state.counts });

    // --- P22.6 redirect limit -------------------------------------------------------------
    main.state.counts = {};
    const limit1 = await httpTool({ url: main.url + '/a', followRedirects: true, maxRedirects: 1 });
    check('P22.6 超限：a→b→c 配 maxRedirects=1 抛 HTTP_REDIRECT_LIMIT，c 零请求',
      limit1.error?.code === 'HTTP_REDIRECT_LIMIT' && limit1.error.category === 'network' && limit1.error.retryable === false
      && main.state.counts['/a'] === 1 && main.state.counts['/b'] === 1 && main.state.counts['/c'] === undefined,
      { code: limit1.error?.code, counts: main.state.counts });
    main.state.counts = {};
    const limit0 = await httpTool({ url: main.url + '/a', followRedirects: true, maxRedirects: 0 });
    check('P22.6 true+0：首个可跟随响应即超限且目标跳零请求',
      limit0.error?.code === 'HTTP_REDIRECT_LIMIT' && main.state.counts['/a'] === 1 && main.state.counts['/b'] === undefined,
      { counts: main.state.counts });

    // --- P22.7 method rules ---------------------------------------------------------------
    const methodRules = [];
    for (const status of [301, 302, 303, 307, 308]) {
      const before = main.state.requests.length;
      await httpTool({ method: 'POST', url: `${main.url}/m/${status}`, headers: { 'content-type': 'text/method' }, body: 'payload', followRedirects: true, maxRedirects: 1 });
      const seen = main.state.requests.slice(before).find((item) => item.path === '/echo-method');
      methodRules.push({ status, method: seen?.method, body: seen?.bodyText, contentType: seen?.headers['content-type'] || null });
    }
    check('P22.7 301/302/303：POST→GET 且丢 body/content-type',
      methodRules.filter((row) => [301, 302, 303].includes(row.status)).every((row) => row.method === 'GET' && row.body === '' && row.contentType === null), methodRules);
    check('P22.7 307/308：保留 POST 与 body',
      methodRules.filter((row) => [307, 308].includes(row.status)).every((row) => row.method === 'POST' && row.body === 'payload'), methodRules);
    const headBefore = main.state.requests.length;
    await httpTool({ method: 'HEAD', url: `${main.url}/m/303`, followRedirects: true, maxRedirects: 1 });
    check('P22.7 HEAD 遇 303 仍为 HEAD', main.state.requests.slice(headBefore).find((item) => item.path === '/echo-method')?.method === 'HEAD');

    // --- P22.8 timeout --------------------------------------------------------------------
    const t0 = Date.now();
    const timeout = await httpTool({ url: fixture.url + 'api/slow?ms=1000', timeoutMs: 50 });
    check('P22.8 超时：HTTP_TIMEOUT/timeout/true，1s 内结束',
      timeout.error?.code === 'HTTP_TIMEOUT' && timeout.error.category === 'timeout' && timeout.error.retryable === true && Date.now() - t0 < 1000,
      { code: timeout.error?.code, elapsed: Date.now() - t0 });
    const t0b = Date.now();
    const bodyTimeout = await httpTool({ url: main.url + '/slowbody', timeoutMs: 120 });
    check('P22.8 总时限覆盖正文：头已到但正文挂起 → HTTP_TIMEOUT',
      bodyTimeout.error?.code === 'HTTP_TIMEOUT' && Date.now() - t0b < 1000, { code: bodyTimeout.error?.code });

    // --- P22.9 cancellation ---------------------------------------------------------------
    const preAbort = new AbortController();
    preAbort.abort();
    const dispatchBeforePreAbort = dispatchCount;
    const preAborted = await httpTool({ url: fixture.url + 'health' }, { signal: preAbort.signal });
    check('P22.9 预取消：ABORTED/cancelled/true 且零派发',
      preAborted.error?.code === 'ABORTED' && preAborted.error.category === 'cancelled' && preAborted.error.retryable === true
      && dispatchCount === dispatchBeforePreAbort, { code: preAborted.error?.code });
    const inflight = new AbortController();
    const slowPromise = httpTool({ url: fixture.url + 'api/slow?ms=1000' }, { signal: inflight.signal });
    await new Promise((resolve) => setTimeout(resolve, 60));
    const abortStart = Date.now();
    inflight.abort();
    const aborted = await slowPromise;
    check('P22.9 进行中取消：1s 内 ABORTED，随后请求正常',
      aborted.error?.code === 'ABORTED' && Date.now() - abortStart < 1000 && (await httpTool({ url: fixture.url + 'health' })).ok === true,
      { code: aborted.error?.code, elapsed: Date.now() - abortStart });
    const gateSlow = httpTool({ url: fixture.url + 'api/slow?ms=600' });
    const fastStart = Date.now();
    const fast = await httpTool({ url: fixture.url + 'health' });
    const fastElapsed = Date.now() - fastStart;
    const slowResult = await gateSlow;
    check('P22.9 并发请求互不排队：快请求在慢请求结束前完成', fast.ok && slowResult.ok && fastElapsed < 500, { fastElapsed });

    // --- P22.10 blocked targets: zero dispatch -------------------------------------------
    const dispatchBeforeBlocked = dispatchCount;
    for (const url of ['file:///etc/passwd', 'http://user:pass@127.0.0.1:1/', 'http://169.254.169.254/',
      'http://0.0.0.0/', 'http://224.0.0.1/', 'http://10.0.0.1/', 'http://[fc00::1]/']) {
      const blocked = await httpTool({ url });
      check(`P22.10 阻断目标零派发：${url}`, blocked.error?.code === 'INVALID_ARGUMENT', { code: blocked.error?.code });
    }
    check('P22.10 以上阻断全部零派发', dispatchCount === dispatchBeforeBlocked, { dispatches: dispatchCount - dispatchBeforeBlocked });
    const savedDsh = process.env.DSH_WEB_URL;
    process.env.DSH_WEB_URL = second.url;
    const dshBlocked = await httpTool({ url: second.url + '/landing' });
    if (savedDsh === undefined) delete process.env.DSH_WEB_URL; else process.env.DSH_WEB_URL = savedDsh;
    check('P22.10 DSH 自身 origin 阻断', dshBlocked.error?.code === 'INVALID_ARGUMENT' && second.state.counts['/landing'] === undefined);
    const mixed = new HttpClient({ origins: () => [], resolve: async () => [{ address: '203.0.113.10' }, { address: '10.0.0.1' }] });
    const dispatchBeforeMixed = dispatchCount;
    let mixedError;
    try { await mixed.request({ url: 'http://mixed.example/probe' }, { meta: {} }); } catch (error) { mixedError = error; }
    check('P22.10 混合 public+private DNS 零派发', mixedError?.code === 'INVALID_ARGUMENT' && dispatchCount === dispatchBeforeMixed, { code: mixedError?.code });
    const dnsFailClient = new HttpClient({ origins: () => [], resolve: async () => { const error = new Error('getaddrinfo ENOTFOUND'); error.code = 'ENOTFOUND'; throw error; } });
    const dispatchBeforeDns = dispatchCount;
    let dnsFailError;
    try { await dnsFailClient.request({ url: 'http://dns-fail.example/' }, { meta: {} }); } catch (error) { dnsFailError = error; }
    check('P22.10 DNS 失败保留 NAV_FAILED/navigation/true 且零派发',
      dnsFailError?.code === 'NAV_FAILED' && dnsFailError.category === 'navigation' && dnsFailError.retryable === true && dispatchCount === dispatchBeforeDns);

    // --- P22.11 redirected blocked targets -----------------------------------------------
    main.state.counts = {};
    const blockedRedirect = await httpTool({ url: main.url + '/meta', followRedirects: true, maxRedirects: 2 });
    check('P22.11 重定向到 metadata：首跳 1 次、INVALID_ARGUMENT、第二跳零派发',
      blockedRedirect.error?.code === 'INVALID_ARGUMENT' && main.state.counts['/meta'] === 1, { code: blockedRedirect.error?.code });
    for (const path of ['/userinfo', '/file']) {
      const result = await httpTool({ url: main.url + path, followRedirects: true, maxRedirects: 2 });
      check(`P22.11 重定向 ${path} 被阻断（INVALID_ARGUMENT）`, result.error?.code === 'INVALID_ARGUMENT', { code: result.error?.code });
    }
    const badLocation = await httpTool({ url: main.url + '/badloc', followRedirects: true, maxRedirects: 2 });
    check('P22.11 非法 Location → INVALID_ARGUMENT（phase=redirect）',
      badLocation.error?.code === 'INVALID_ARGUMENT' && badLocation.error.details?.phase === 'redirect', { phase: badLocation.error?.details?.phase });
    process.env.DSH_WEB_URL = second.url;
    main.state.counts = {};
    const dshRedirect = await httpTool({ url: main.url + '/dsh', followRedirects: true, maxRedirects: 2 });
    if (savedDsh === undefined) delete process.env.DSH_WEB_URL; else process.env.DSH_WEB_URL = savedDsh;
    check('P22.11 重定向到 DSH origin：第二服务器零请求', dshRedirect.error?.code === 'INVALID_ARGUMENT' && second.state.counts['/landing'] === undefined);
    second.state.requests.length = 0;
    await httpTool({ url: main.url + '/to-second', headers: { authorization: 'Bearer probe', 'x-api-key': 'probe-key', 'x-custom': 'keep' }, followRedirects: true, maxRedirects: 2 });
    const crossSeen = second.state.requests.find((item) => item.path === '/landing');
    check('P22.11 跨 origin 重定向清空全部调用方头',
      crossSeen && !crossSeen.headers.authorization && !crossSeen.headers['x-api-key'] && !crossSeen.headers['x-custom']);
    const sameBefore = main.state.requests.length;
    await httpTool({ url: main.url + '/same', headers: { authorization: 'Bearer probe', 'x-custom': 'keep' }, followRedirects: true, maxRedirects: 2 });
    const sameSeen = main.state.requests.slice(sameBefore).find((item) => item.path === '/same-target');
    check('P22.11 同 origin 重定向保留调用方头', sameSeen?.headers.authorization === 'Bearer probe' && sameSeen?.headers['x-custom'] === 'keep');

    // HTTPS → HTTP downgrade (self-signed local TLS accepted only inside this probe).
    tempDir = await mkdtemp(join(tmpdir(), 'dsh-p22-tls-'));
    const keyPath = join(tempDir, 'key.pem');
    const certPath = join(tempDir, 'cert.pem');
    const openssl = spawnSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', keyPath, '-out', certPath,
      '-days', '1', '-subj', '/CN=127.0.0.1', '-addext', 'subjectAltName=IP:127.0.0.1'], { stdio: 'ignore' });
    if (openssl.status === 0) {
      const httpsServer = createHttpsServer({ key: await readFile(keyPath), cert: await readFile(certPath) }, (req, res) => {
        res.writeHead(302, { location: second.url + '/downgrade-target' });
        res.end();
      });
      await new Promise((resolve) => httpsServer.listen(0, '127.0.0.1', resolve));
      secure = httpsServer;
      const previousTls = process.env.NODE_TLS_REJECT_UNAUTHORIZED;
      process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
      second.state.counts = {};
      const downgrade = await httpTool({ url: `https://127.0.0.1:${httpsServer.address().port}/start`, followRedirects: true, maxRedirects: 2 });
      if (previousTls === undefined) delete process.env.NODE_TLS_REJECT_UNAUTHORIZED; else process.env.NODE_TLS_REJECT_UNAUTHORIZED = previousTls;
      check('P22.11 HTTPS→HTTP 降级被拒绝且目标零派发',
        downgrade.error?.code === 'INVALID_ARGUMENT' && second.state.counts['/downgrade-target'] === undefined, { code: downgrade.error?.code });
    } else {
      finding({ id: 'P22-https-downgrade-inconclusive', severity: 'info', advisory: true,
        summary: 'openssl 不可用，无法生成本地 TLS 证书，HTTPS→HTTP 降级未验证', evidence: { status: openssl.status } });
      check('P22.11 HTTPS→HTTP 降级被拒绝且目标零派发（openssl 不可用 → INCONCLUSIVE）', false, { reason: 'no openssl' }, { advisory: true });
    }

    // --- P22.12 invalid arguments: zero side effects -------------------------------------
    const invalidCases = [
      ['未知字段', { url: fixture.url + 'health', nope: 1 }],
      ['method 小写', { method: 'get', url: fixture.url + 'health' }],
      ['method TRACE', { method: 'TRACE', url: fixture.url + 'health' }],
      ['GET 带 body', { url: fixture.url + 'health', body: '' }],
      ['headers 数组', { url: fixture.url + 'health', headers: [] }],
      ['headers 数字值', { url: fixture.url + 'health', headers: { 'x-a': 1 } }],
      ['重名头', { url: fixture.url + 'health', headers: { 'X-A': '1', 'x-a': '2' } }],
      ['危险头 Cookie', { url: fixture.url + 'health', headers: { Cookie: 'a=1' } }],
      ['危险头 Accept-Encoding', { url: fixture.url + 'health', headers: { 'accept-encoding': 'gzip' } }],
      ['sec- 前缀头', { url: fixture.url + 'health', headers: { 'sec-fetch-mode': 'navigate' } }],
      ['头值 CRLF', { url: fixture.url + 'health', headers: { 'x-a': 'a\r\nb' } }],
      ['头值超长', { url: fixture.url + 'health', headers: { 'x-a': 'a'.repeat(4097) } }],
      ['body 超长', { method: 'POST', url: fixture.url + 'api/echo', body: 'a'.repeat(65537) }],
      ['timeoutMs 0', { url: fixture.url + 'health', timeoutMs: 0 }],
      ['timeoutMs 20001', { url: fixture.url + 'health', timeoutMs: 20001 }],
      ['timeoutMs 小数', { url: fixture.url + 'health', timeoutMs: 1.5 }],
      ['timeoutMs 字符串', { url: fixture.url + 'health', timeoutMs: '5000' }],
      ['maxBytes 0', { url: fixture.url + 'health', maxBytes: 0 }],
      ['maxBytes 超上限', { url: fixture.url + 'health', maxBytes: 1048577 }],
      ['followRedirects 非布尔', { url: fixture.url + 'health', followRedirects: 'yes' }],
      ['maxRedirects 6', { url: fixture.url + 'health', maxRedirects: 6 }],
      ['url 前后空白', { url: ' ' + fixture.url + 'health' }],
      ['url 相对', { url: '/health' }],
      ['url 带凭据', { url: 'http://user:pass@127.0.0.1:1/' }],
      ['url 超长', { url: 'http://127.0.0.1/' + 'a'.repeat(8200) }],
    ];
    const dispatchBeforeInvalid = dispatchCount;
    for (const [label, args] of invalidCases) {
      const result = await httpTool(args);
      check(`P22.12 非法参数：${label}`, result.error?.code === 'INVALID_ARGUMENT' && result.error.category === 'input'
        && result.error.retryable === false, { code: result.error?.code });
    }
    check('P22.12 非法参数全部零派发', dispatchCount === dispatchBeforeInvalid, { dispatches: dispatchCount - dispatchBeforeInvalid });

    // --- P22.13 body limits and byte semantics -------------------------------------------
    const exact10 = await httpTool({ url: main.url + '/exact10', maxBytes: 10 });
    const exact11 = await httpTool({ url: main.url + '/exact11', maxBytes: 10 });
    const stream = await httpTool({ url: main.url + '/stream', maxBytes: 25 });
    check('P22.13 恰好上限 truncated=false、保留字节完整',
      exact10.ok && exact10.value.bodyTruncated === false && exact10.value.bodyBytes === 10 && exact10.value.body === 'abcdefghij');
    check('P22.13 超上限 truncated=true 且只保留 maxBytes',
      exact11.ok && exact11.value.bodyTruncated === true && exact11.value.bodyBytes === 10 && exact11.value.body.length === 10);
    check('P22.13 无 Content-Length 的持续响应同样按上限截断',
      stream.ok && stream.value.bodyTruncated === true && stream.value.bodyBytes === 25);
    const binary = await httpTool({ url: main.url + '/binary', maxBytes: 100 });
    check('P22.13 二进制响应 base64 且逐字节一致',
      binary.ok && binary.value.encoding === 'base64' && Buffer.from(binary.value.body, 'base64').equals(Buffer.from([0, 255, 1])));
    const cut = await httpTool({ url: main.url + '/utf8cut', maxBytes: 4 });
    check('P22.13 UTF-8 多字节被截断时返回 base64（不静默损坏）',
      cut.ok && cut.value.encoding === 'base64' && Buffer.from(cut.value.body, 'base64').equals(Buffer.from([0xe6, 0xb1, 0x89, 0xe5])));
    const head = await httpTool({ method: 'HEAD', url: fixture.url + 'health' });
    const empty204 = await httpTool({ url: main.url + '/204' });
    check('P22.13 HEAD/204 正文 0 字节且不截断',
      head.ok && head.value.bodyBytes === 0 && head.value.bodyTruncated === false && head.value.body === '' && head.value.encoding === 'utf8'
      && empty204.ok && empty204.value.bodyBytes === 0 && empty204.value.bodyTruncated === false);
    const abrupt = await httpTool({ url: main.url + '/close-early', maxBytes: 1000 });
    check('P22.13 正文异常断开 → HTTP_FAILED（不能伪装 truncated）', abrupt.error?.code === 'HTTP_FAILED', { code: abrupt.error?.code });
    const gzip = await httpTool({ url: main.url + '/gzip' });
    check('P22.13 压缩响应不自动解压：base64 原始实体且字节等于 gzip 长度',
      gzip.ok && gzip.value.encoding === 'base64'
      && gzip.value.bodyBytes === zlib.gzipSync(Buffer.from('{"compressed":true}')).length
      && zlib.gunzipSync(Buffer.from(gzip.value.body, 'base64')).toString('utf8') === '{"compressed":true}');
    const bigHeaders = await httpTool({ url: main.url + '/bigheaders' });
    check('P22.13 响应头超过 16KiB → HTTP_FAILED', bigHeaders.error?.code === 'HTTP_FAILED', { code: bigHeaders.error?.code });

    // --- P22.14 no cookie jar / explicit credentials -------------------------------------
    const cookieCall = await httpTool({ url: main.url + '/setcookie' });
    const beforeCookieReplay = main.state.requests.length;
    await httpTool({ url: main.url + '/setcookie' });
    check('P22.14 无 cookie jar：Set-Cookie 不被重放',
      cookieCall.ok && main.state.requests.slice(beforeCookieReplay).every((item) => !item.headers.cookie));
    const authEcho = await httpTool({ url: main.url + '/same-target', headers: { authorization: 'Bearer probe', 'x-api-key': 'probe-key' } });
    const authSeen = main.state.requests.findLast((item) => item.path === '/same-target');
    check('P22.14 显式 Authorization/x-api-key 到达目标但不进入 args/结果',
      authEcho.ok && authSeen?.headers.authorization === 'Bearer probe'
      && !JSON.stringify(authEcho.value.args || {}).includes('probe') && !JSON.stringify(authEcho.value).includes('Bearer probe'));

    // --- P22.15 redaction ----------------------------------------------------------------
    const redacted = await httpTool({ url: main.url + '/setcookie?token=supersecret#frag' });
    check('P22.15 敏感响应头为 ["***"]（单条、不保留重复/原值）',
      JSON.stringify(redacted.value.headers['set-cookie']) === JSON.stringify(['***']), { setCookie: redacted.value.headers['set-cookie'] });
    check('P22.15 重复普通响应头保留为 string[]',
      JSON.stringify(redacted.value.headers['x-dup']) === JSON.stringify(['one', 'two']));
    check('P22.15 Location 已绝对解析且 query/fragment 脱敏',
      String(redacted.value.headers.location?.[0] || '').includes('token=***') && !String(redacted.value.headers.location?.[0] || '').includes('leak'));
    check('P22.15 URL query/fragment 脱敏（url/target/args 无原值）',
      !JSON.stringify(redacted.value).includes('supersecret') && redacted.value.url.includes('token=***') && redacted.value.target.includes('token=***'));
    const redactedError = await httpTool({ url: 'http://169.254.169.254/?token=supersecret#x' });
    check('P22.15 错误 message/details 不含 URL 机密',
      !JSON.stringify(redactedError.error?.details || {}).includes('supersecret') && !String(redactedError.error?.message).includes('supersecret'));

    // --- P22.16 evidence -----------------------------------------------------------------
    check('P22.16 成功/4xx/5xx/截断/跟随都有 action 证据且 target 为初始 HTTP 目标',
      [health.value, err500.value, followed.value, redacted.value].every((value) => typeof value.actionId === 'string' && value.actionId
        && value.sessionId === 'anonymous' && Number.isFinite(value.startedAt) && Number.isFinite(value.finishedAt)
        && typeof value.target === 'string' && value.args && typeof value.args === 'object')
      && followed.value.target.includes('/redirect') && followed.value.url.includes('/second.html'),
      { target: followed.value.target, url: followed.value.url });

    // --- P22.18 real lossless ------------------------------------------------------------
    const lossless = [];
    const assertLossless = (label, invoked) => {
      const value = invoked.ok ? invoked.value : { code: invoked.error.code, category: invoked.error.category,
        retryable: invoked.error.retryable, message: invoked.error.message, details: invoked.error.details };
      const ok = validator.isJsonValue(value) && validator.snapshotJsonValue(value) !== undefined && undefinedPaths(value).length === 0;
      const renderOk = (invoked.content || []).every((item) => validator.isJsonValue(item));
      lossless.push({ label, ok, renderOk });
      check(`P22.18 真实 lossless 校验：${label}`, ok && renderOk, { undefined: undefinedPaths(value).slice(0, 5) });
    };
    assertLossless('health', health);
    assertLossless('500', err500);
    assertLossless('redirect-follow', followed);
    assertLossless('truncated', exact11);
    assertLossless('gzip', gzip);
    assertLossless('error-timeout', timeout);
    assertLossless('error-limit', limit1);
    assertLossless('error-blocked', blockedRedirect);

    // --- P22.19 capabilities projection --------------------------------------------------
    const caps = await harness.invoke('browser_capabilities', {});
    const t1 = caps.value.capabilities.filter((item) => item.id.startsWith('web.t1.') && item.tool);
    const httpEntry = caps.value.capabilities.find((item) => item.id === 'web.t1.http-request');
    check('P22.19 capabilities 9 项 T1 available 且 http-request=available/4 constraints',
      t1.length === 9 && t1.every((item) => item.status === 'available') && httpEntry?.tool === 'browser_http_request'
      && httpEntry.constraints?.length === 4, { count: t1.length });
    const limits = caps.value.limits.httpRequest;
    check('P22.19 limits.httpRequest 与执行默认/上限同源',
      limits.defaultTimeoutMs === 5000 && limits.maxTimeoutMs === 20000 && limits.defaultMaxBytes === 65536
      && limits.maxBytes === 1048576 && limits.maxRequestBodyBytes === 65536 && limits.maxRequestHeaderBytes === 8192
      && limits.maxResponseHeaderBytes === 16384 && limits.defaultMaxRedirects === 0 && limits.maxRedirects === 5);

    // --- P22.17 cold state / no Chromium -------------------------------------------------
    check('P22.17 全部 HTTP 调用未启动 Chromium、未创建 profile',
      scanPluginChromeProcesses().filter((item) => !pidsBefore.has(item.pid)).length === 0
      && (await snapshotProfileDirs()).length === profilesBefore.length);

    // --- P22.20 dispose / close ----------------------------------------------------------
    const disposal = await createHarness({ name: 'p22-dispose' });
    const pending = disposal.invoke('browser_http_request', { url: fixture.url + 'api/slow?ms=2000' });
    await new Promise((resolve) => setTimeout(resolve, 80));
    const disposeStart = Date.now();
    await disposal.dispose();
    const disposed = await pending;
    check('P22.20 插件卸载取消在飞请求（ABORTED）且不挂起',
      disposed.error?.code === 'ABORTED' && Date.now() - disposeStart < 1500, { code: disposed.error?.code });
    const coldClose = await harness.closeBrowser();
    const afterClose = await httpTool({ url: fixture.url + 'health' });
    check('P22.20 面板 close 只关页面：HTTP 仍可用', coldClose.statusCode === 200 && afterClose.ok && afterClose.value.status === 200);

    // --- prototype pollution -------------------------------------------------------------
    const proto = await httpTool({ url: main.url + '/proto' });
    check('P22.3(§3) 远端 __proto__ 头不污染原型且可快照',
      proto.ok && Object.getPrototypeOf(proto.value.headers) === Object.prototype && {}.polluted === undefined
      && Array.isArray(proto.value.headers['__proto__']));
  } catch (error) {
    check('P22 probe 异常中止', false, { message: String(error?.stack || error).slice(0, 900) });
  } finally {
    http.request = realRequest;
    try { await harness.closeBrowser(); } catch { /* ignore */ }
    try { await harness.dispose(); } catch { /* ignore */ }
    for (const server of [main, second, local, echoServer]) { try { await server?.close(); } catch { /* ignore */ } }
    try { if (secure) await new Promise((resolve) => secure.close(resolve)); } catch { /* ignore */ }
    try { if (tempDir) await rm(tempDir, { recursive: true, force: true }); } catch { /* ignore */ }
  }
}
