import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';
import { BrowserError, Cdp, Runtime, loadWebHostModules } from '../../index.js';
import { validateTarget } from '../../browser-safety.js';

// This suite drives the Web `Runtime` directly (outside the plugin's tool/HTTP entry points), so
// it must resolve the on-demand Web module chain itself — the plugin does that before any real
// call (A14 按需加载).
await loadWebHostModules();

const classified = (code, category, retryable) => (error) => {
  assert.ok(error instanceof BrowserError);
  assert.equal(error.code, code);
  assert.equal(error.category, category);
  assert.equal(error.retryable, retryable);
  assert.ok(error.message.includes(`[${code}]`));
  assert.equal(typeof error.details, 'object');
  return true;
};
class FakeWebSocket {
  static instances = [];
  constructor() { this.sent = []; FakeWebSocket.instances.push(this); queueMicrotask(() => this.onopen?.()); }
  send(raw) { this.sent.push(JSON.parse(raw)); }
  reply(result = {}, error) { this.onmessage?.({ data: JSON.stringify({ id: this.sent.at(-1).id, result, error }) }); }
  close() { if (this.closed) return; this.closed = true; this.onclose?.(); }
}
async function transport(t) {
  const original = globalThis.WebSocket;
  globalThis.WebSocket = FakeWebSocket;
  t.after(() => { globalThis.WebSocket = original; });
  const cdp = new Cdp('ws://fake.invalid');
  await cdp.connect({ timeoutMs: 100 });
  t.after(() => cdp.close());
  return cdp;
}

for (const mode of ['success', 'protocol-error', 'abort', 'timeout', 'disconnect', 'send-error']) {
  test(`CDP ${mode} settles pending and clears timer/listener`, async (t) => {
    const cdp = await transport(t);
    const controller = new AbortController();
    let listeners = 0;
    const add = controller.signal.addEventListener.bind(controller.signal);
    const remove = controller.signal.removeEventListener.bind(controller.signal);
    t.mock.method(controller.signal, 'addEventListener', (...args) => { listeners++; return add(...args); });
    t.mock.method(controller.signal, 'removeEventListener', (...args) => { listeners--; return remove(...args); });
    if (mode === 'send-error') cdp.ws.send = () => { throw new Error('injected send error'); };
    const promise = cdp.send('Runtime.evaluate', {}, { signal: controller.signal, timeoutMs: 20 });
    const timer = [...cdp.pending.values()][0]?.timer;
    const expected = {
      'protocol-error': ['INTERNAL', 'internal', false], abort: ['ABORTED', 'cancelled', true],
      timeout: ['CDP_TIMEOUT', 'timeout', true], disconnect: ['CDP_DISCONNECTED', 'disconnected', true],
      'send-error': ['CDP_DISCONNECTED', 'disconnected', true],
    }[mode];
    const outcome = expected ? assert.rejects(promise, classified(...expected)) : assert.doesNotReject(promise);
    if (mode === 'success') cdp.ws.reply({ value: 42 });
    if (mode === 'protocol-error') cdp.ws.reply({}, { message: 'injected protocol error' });
    if (mode === 'abort') controller.abort();
    if (mode === 'disconnect') cdp.ws.close();
    await outcome;
    assert.equal(cdp.pending.size, 0);
    if (mode === 'send-error') assert.equal(cdp.closed, true);
    assert.equal(listeners, 0);
    if (timer) assert.equal(timer._destroyed, true);
  });
}

test('browser CDP forwards flattened sessionId at protocol top level', async (t) => {
  const cdp = await transport(t);
  const pending = cdp.send('Runtime.runIfWaitingForDebugger', {}, { sessionId: 'initial-page-session', timeoutMs: 100 });
  assert.equal(cdp.ws.sent.at(-1).sessionId, 'initial-page-session');
  assert.equal(cdp.ws.sent.at(-1).params.sessionId, undefined);
  cdp.ws.reply({}); await pending;
});

test('pre-aborted and closed CDP commands never dispatch', async (t) => {
  const cdp = await transport(t);
  const controller = new AbortController(); controller.abort();
  await assert.rejects(cdp.send('Page.navigate', {}, { signal: controller.signal }), classified('ABORTED', 'cancelled', true));
  assert.equal(cdp.ws.sent.length, 0);
  cdp.close();
  await assert.rejects(cdp.send('Page.navigate'), classified('CDP_DISCONNECTED', 'disconnected', true));
  assert.equal(cdp.pending.size, 0);
});

test('lease expires after 15s idle but stays valid throughout a running operation', async (t) => {
  let clock = 1000;
  t.mock.method(Date, 'now', () => clock);
  const runtime = new Runtime(() => {});
  runtime.claim('a');
  assert.equal(runtime.lease.expiresAt, 16000);
  clock = 15999;
  assert.throws(() => runtime.claim('b'), classified('BUSY', 'concurrency', true));
  let unblock;
  const pending = runtime.run(() => new Promise((resolve) => { unblock = resolve; }), { sessionId: 'a', agent: true });
  await Promise.resolve(); await Promise.resolve();
  clock = 50000;
  assert.throws(() => runtime.claim('b'), classified('BUSY', 'concurrency', true));
  unblock('done');
  assert.equal(await pending, 'done');
  assert.equal(runtime.active, 0);
  assert.equal(runtime.lease.expiresAt, 65000);
  clock = 65001;
  runtime.claim('b');
  assert.equal(runtime.lease.sessionId, 'b');
  runtime.release('a'); assert.equal(runtime.lease.sessionId, 'b');
  runtime.release('b'); assert.equal(runtime.lease, undefined);
});

test('queued cancellation skips its action without unlocking the active operation', async () => {
  const runtime = new Runtime(() => {});
  const order = [];
  let unblock;
  const first = runtime.run(async () => { order.push('first-start'); await new Promise((resolve) => { unblock = resolve; }); order.push('first-end'); });
  await Promise.resolve(); await Promise.resolve();
  const controller = new AbortController();
  const cancelled = runtime.run(() => order.push('must-not-run'), { signal: controller.signal });
  const rejected = assert.rejects(cancelled, classified('ABORTED', 'cancelled', true));
  const third = runtime.run(() => order.push('third'));
  controller.abort(); await rejected;
  assert.deepEqual(order, ['first-start']);
  unblock(); await Promise.all([first, third]);
  assert.deepEqual(order, ['first-start', 'first-end', 'third']);
});

test('operation cancellation/timeout closes browser before next queued action', async () => {
  for (const code of ['ABORTED', 'CDP_TIMEOUT', 'CDP_DISCONNECTED']) {
    const runtime = new Runtime(() => {});
    const order = [];
    runtime.close = async () => { order.push('close-start'); await Promise.resolve(); order.push('close-end'); };
    const first = runtime.run(() => { throw new BrowserError(code, 'injected'); });
    const rejected = assert.rejects(first, (error) => error.code === code);
    const second = runtime.run(() => order.push('next'));
    await Promise.all([rejected, second]);
    assert.deepEqual(order, ['close-start', 'close-end', 'next']);
  }
});

test('cancelled owner retains queued reservation through close and reacquires before queued action', async () => {
  const runtime = new Runtime(() => {});
  const controller = new AbortController();
  let enteredFirst, cancelFirst, finishSecond;
  const started = new Promise((resolve) => { enteredFirst = resolve; });
  const originalClose = runtime.close.bind(runtime);
  let checkedGap = false;
  runtime.close = async () => {
    await originalClose();
    assert.equal(runtime.lease, undefined);
    assert.throws(() => runtime.claim('b'), classified('BUSY', 'concurrency', true));
    checkedGap = true;
  };
  const a1 = runtime.run(async () => {
    enteredFirst();
    await new Promise((resolve, reject) => { cancelFirst = () => reject(new BrowserError('ABORTED', 'injected')); });
  }, { agent: true, sessionId: 'a', signal: controller.signal });
  const rejected = assert.rejects(a1, classified('ABORTED', 'cancelled', true));
  await started;
  const a2 = runtime.run(async () => {
    assert.equal(runtime.lease.sessionId, 'a');
    assert.equal(runtime.activeOwner, 'a');
    await new Promise((resolve) => { finishSecond = resolve; });
  }, { agent: true, sessionId: 'a' });
  controller.abort(); cancelFirst();
  await rejected;
  await Promise.resolve(); await Promise.resolve();
  assert.equal(checkedGap, true);
  assert.throws(() => runtime.claim('b'), classified('BUSY', 'concurrency', true));
  finishSecond(); await a2;
  assert.equal(runtime.active, 0);
  runtime.release('a'); runtime.claim('b');
  assert.equal(runtime.lease.sessionId, 'b');
});

test('cancel cleanup bounds unresponsive stopScreencast and releases lease before next owner', async (t) => {
  const cdp = await transport(t);
  const runtime = new Runtime(() => {});
  runtime.cdp = cdp;
  runtime.claim('old-owner');
  const started = performance.now();
  const failed = runtime.run(() => { throw new BrowserError('ABORTED', 'injected'); }, { sessionId: 'old-owner', agent: true });
  await assert.rejects(failed, classified('ABORTED', 'cancelled', true));
  assert.ok(performance.now() - started < 1000);
  assert.equal(cdp.ws.sent.at(-1).method, 'Page.stopScreencast');
  assert.equal(cdp.pending.size, 0);
  assert.equal(cdp.closed, true);
  assert.equal(runtime.lease, undefined);
  assert.equal(runtime.active, 0);
  assert.equal(runtime.state().running, false);
  await runtime.run(() => 'accepted', { sessionId: 'new-owner', agent: true });
  assert.equal(runtime.lease.sessionId, 'new-owner');
});

test('navigation checks CDP errorText and validates final destination', async () => {
  const runtime = new Runtime(() => {});
  runtime.ensure = async () => runtime.cdp;
  runtime.cdp = { closed: false, async send(method, params) {
    if (method === 'Page.navigate') return { errorText: 'net::ERR_CONNECTION_REFUSED' };
    return {};
  } };
  await assert.rejects(runtime.navigate('http://127.0.0.1:1/'), classified('NAV_FAILED', 'navigation', true));
  const navigations = [];
  runtime.cdp.send = async (method, params) => {
    if (method === 'Page.navigate') { navigations.push(params.url); return {}; }
    if (method === 'Runtime.evaluate') return { result: { value: { title: 'blocked', url: 'http://169.254.169.254/latest/meta-data/' } } };
    return {};
  };
  await assert.rejects(runtime.navigate('http://127.0.0.1/'), classified('NAV_FAILED', 'navigation', true));
  assert.deepEqual(navigations, ['http://127.0.0.1/', 'about:blank']);
});

test('dead CDP runtime cleans old process/profile before ensure restart and restores owner', async () => {
  const script = `import assert from 'node:assert/strict';
import {Runtime,loadWebHostModules} from './index.js';
import {isProcessAlive,pathExists,waitFor} from './tests/acceptance/harness.mjs';
await loadWebHostModules();  // Web 专用依赖按需加载（A14），直接构造 Runtime 需自行加载
const r=new Runtime(()=>{});
try {
 await r.run(()=>r.ensure(),{agent:true,sessionId:'recovery-owner'});
 const oldPid=r.proc.pid, oldProfile=r.profileDir;
 r.cdp.close();
 await r.run(()=>r.ensure(),{agent:true,sessionId:'recovery-owner'});
 assert.notEqual(r.proc.pid,oldPid); assert.notEqual(r.profileDir,oldProfile);
 await waitFor(()=>!isProcessAlive(oldPid));
 await waitFor(async()=>!await pathExists(oldProfile),{timeoutMs:3000,intervalMs:50});
 assert.equal(r.lease.sessionId,'recovery-owner');
 console.log('recovery-ok');
} finally {await r.close();}`;
  const child = spawn(process.execPath, ['--input-type=module', '-e', script], {
    cwd: fileURLToPath(new URL('../../', import.meta.url)),
    env: { ...process.env, DSH_UI_TESTING_CHROME: process.env.DSH_UI_TESTING_CHROME || fileURLToPath(new URL('./chrome-wrapper.sh', import.meta.url)) },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stdout = '', stderr = '';
  child.stdout.on('data', (chunk) => { stdout += chunk; });
  child.stderr.on('data', (chunk) => { stderr += chunk; });
  const [code] = await once(child, 'exit');
  assert.equal(code, 0, stderr);
  assert.match(stdout, /recovery-ok/);
});

test('navigation policy allows loopback/DNS localhost and rejects forbidden targets', async () => {
  for (const url of ['http://127.0.0.1:1234/', 'http://127.2.3.4/', 'http://[::1]/', 'http://localhost/']) assert.equal(await validateTarget(url, { allowPrivate: false }), url);
  for (const url of ['file:///etc/passwd', 'http://169.254.169.254/', 'http://0.0.0.0/', 'http://10.0.0.1/', 'http://172.16.0.1/', 'http://192.168.0.1/', 'http://[fc00::1]/', 'http://user:password@127.0.0.1/', 'http://224.0.0.1/', 'http://[::ffff:192.168.1.1]/']) {
    await assert.rejects(validateTarget(url, { allowPrivate: false }), classified('INVALID_ARGUMENT', 'input', false));
  }
  await assert.rejects(validateTarget('http://127.0.0.1:3080/path', { origins: ['http://127.0.0.1:3080'] }), classified('INVALID_ARGUMENT', 'input', false));
  // Deterministic DNS failure: this host runs a fake-ip proxy that resolves *any* name
  // (including .invalid) to 198.18.0.28, so the real lookup cannot be asserted here.
  const dnsFailure = async () => { const error = new Error('getaddrinfo ENOTFOUND does-not-exist.invalid'); error.code = 'ENOTFOUND'; throw error; };
  await assert.rejects(validateTarget('http://does-not-exist.invalid/', { resolve: dnsFailure }), classified('NAV_FAILED', 'navigation', true));
  assert.equal(await validateTarget('http://192.168.0.1/', { allowPrivate: true }), 'http://192.168.0.1/');
  await assert.rejects(validateTarget('http://169.254.169.254/', { allowPrivate: true }), classified('INVALID_ARGUMENT', 'input', false));
});
