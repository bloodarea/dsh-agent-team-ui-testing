import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { createServer } from 'node:http';
import { fileURLToPath } from 'node:url';
import { createHarness, snapshotProfileDirs, sleep, waitFor } from './harness.mjs';

const exec = (id, signal) => ({ agent: { id }, signal });
const errorShape = (error, code) => error?.code === code && typeof error.category === 'string' && typeof error.retryable === 'boolean';
const textContent = (result) => (result.content || []).filter((block) => block.type === 'text').map((block) => block.text).join('\n');
const evidenceKeys = ['actionId', 'sessionId', 'startedAt', 'finishedAt', 'target', 'args'];
const time = (value) => typeof value === 'number' ? value : Date.parse(value);

export async function capabilityProbe({ harness, check }) {
  const result = await harness.invoke('browser_capabilities', {}, exec('capability-observer'));
  const value = result.value;
  check('capabilities 跨会话可读且声明 single-owner-lease', result.ok && value?.runtime?.isolation === 'single-owner-lease'
    && value.runtime.browser === 'chromium' && ['ws', 'unavailable'].includes(value.runtime.transport) && typeof value.runtime.attachments === 'boolean',
  { expected: 'runtime browser/transport/isolation/attachments', actual: result.error || value });
  const capabilities = value?.capabilities || [];
  check('capability id 唯一且状态是 available/unavailable/unsupported', capabilities.length >= 8 && new Set(capabilities.map((item) => item.id)).size === capabilities.length
    && capabilities.every((item) => ['available', 'unavailable', 'unsupported'].includes(item.status)), { expected: '8+ unique capabilities', actual: capabilities });
  const advertisedTools = new Set(capabilities.map((item) => item.tool).filter(Boolean));
  check('所有实际工具都有 capability 声明且没有虚构工具', harness.toolNames().every((name) => advertisedTools.has(name))
    && [...advertisedTools].every((name) => harness.tools.has(name)), { expected: harness.toolNames(), actual: [...advertisedTools] });
  check('T2/T3/T4 均明确 unsupported', ['t2', 't3', 't4'].every((tier) => capabilities.some((item) => item.id.toLowerCase().includes(tier) && item.status === 'unsupported')),
    { expected: ['T2 unsupported', 'T3 unsupported', 'T4 unsupported'], actual: capabilities });
}

export async function leaseProbe({ check }) {
  const harness = await createHarness({ name: 'lease' });
  try {
    const [a, b] = await Promise.all(['lease-a', 'lease-b'].map((id) => harness.invoke('browser_network', {}, exec(id))));
    const winner = a.ok ? 'lease-a' : 'lease-b';
    const loser = a.ok ? b : a;
    check('两个不同会话竞争只有一个获得 lease，另一方 BUSY', [a, b].filter((item) => item.ok).length === 1 && errorShape(loser.error, 'BUSY') && loser.error.retryable,
      { expected: 'one success + one BUSY', actual: [a, b] });
    for (const [name, args] of [['browser_network', {}], ['browser_eval', { expression: '1' }], ['browser_screenshot', {}], ['browser_computed_style', { selector: 'body' }], ['browser_input', { events: [] }], ['browser_navigate', { url: 'http://127.0.0.1:1/' }]]) {
      const result = await harness.invoke(name, args, exec('lease-other'));
      check(`${name} 页面/网络访问校验 lease`, result.threw && errorShape(result.error, 'BUSY'), { expected: 'BUSY', actual: result });
    }
    for (const name of ['browser_state', 'browser_capabilities']) {
      const result = await harness.invoke(name, {}, exec('lease-observer'));
      check(`${name} 诊断可跨会话且不夺取 owner`, result.ok, { expected: 'success', actual: result.error || result.value });
    }
    const busyCapabilities = await harness.invoke('browser_capabilities', {}, exec('lease-observer'));
    const byTool = new Map((busyCapabilities.value?.capabilities || []).filter((item) => item.tool).map((item) => [item.tool, item]));
    check('capabilities 对其他 owner 页面/network 如实报 unavailable，诊断仍 available', ['browser_navigate', 'browser_eval', 'browser_screenshot', 'browser_input', 'browser_network', 'browser_computed_style'].every((name) => byTool.get(name)?.status === 'unavailable')
      && ['browser_state', 'browser_capabilities'].every((name) => byTool.get(name)?.status === 'available'), { expected: '6 unavailable + 2 diagnostics available', actual: busyCapabilities.value?.capabilities });
    const state = await harness.invoke('browser_state');
    check('诊断保留实际 owner 且 network 不启动浏览器', state.value?.owner?.sessionId === winner && state.value.running === false,
      { expected: { owner: winner, running: false }, actual: state.value });
    await harness.ctx.emit('agent/disposed', { agent: { id: 'unrelated-session' } });
    const stillBusy = await harness.invoke('browser_network', {}, exec('lease-after-unrelated'));
    check('无关 disposed 事件不释放 owner', errorShape(stillBusy.error, 'BUSY'), { expected: 'BUSY', actual: stillBusy });
    await harness.ctx.emit('agent/disposed', { agent: { id: winner } });
    const next = await harness.invoke('browser_network', {}, exec('lease-after-dispose'));
    check('owner agent/disposed 释放 lease', next.ok, { expected: 'success', actual: next.error || next.value });
  } finally { await harness.dispose(); }
  const anonymous = await createHarness({ name: 'anonymous' });
  try {
    const first = await anonymous.invoke('browser_network');
    const second = await anonymous.invoke('browser_network', {}, {});
    check('未知 exec fallback 共享 anonymous 会话', first.ok && second.ok && first.value?.sessionId === 'anonymous' && second.value?.sessionId === 'anonymous',
      { expected: 'both anonymous success', actual: [first.value, second.value] });
  } finally { await anonymous.dispose(); }
}

export async function evidenceProbe({ harness, check }) {
  const state = await harness.invoke('browser_state');
  const cases = [
    ['browser_navigate', { url: state.value.url }],
    ['browser_state', {}], ['browser_capabilities', {}], ['browser_network', {}],
    ['browser_eval', { expression: '({answer:42})' }], ['browser_computed_style', { selector: 'body', properties: ['display'] }],
    ['browser_input', { events: [] }], ['browser_screenshot', {}],
  ];
  const successful = [];
  for (const [name, args] of cases) {
    const result = await harness.invoke(name, args);
    successful.push(result);
    const value = result.value;
    const text = textContent(result);
    check(`${name} 返回完整 envelope 且 durable 文本保留所有证据字段`, result.ok && evidenceKeys.every((key) => Object.hasOwn(value || {}, key))
      && typeof value.actionId === 'string' && value.actionId.length > 0 && value.sessionId === 'anonymous'
      && Number.isFinite(time(value.startedAt)) && time(value.finishedAt) >= time(value.startedAt)
      && evidenceKeys.every((key) => text.includes(`"${key}"`)) && text.includes(value.actionId),
    { expected: evidenceKeys, actual: { value: value && { ...value, image: '[omitted]' }, content: text.slice(0, 2000) } });
  }
  check('每次工具调用生成唯一 actionId', new Set(successful.map((item) => item.value?.actionId)).size === successful.length,
    { expected: successful.length, actual: successful.map((item) => item.value?.actionId) });
  const shot = successful.at(-1);
  const bytes = Buffer.from(shot.value?.image || '', 'base64');
  check('无附件服务截图明确 base64 fallback、保留图片与完整 hash/时间', shot.value?.imageDelivery === 'base64-fallback' && shot.value.attachmentId === null
    && Number.isFinite(time(shot.value.capturedAt)) && shot.value.sha256 === createHash('sha256').update(bytes).digest('hex')
    && textContent(shot).includes(shot.value.image) && textContent(shot).includes('base64-fallback'),
  { expected: 'base64-fallback + attachmentId:null + sha256 + capturedAt + rendered base64', actual: shot.value && { ...shot.value, image: `[${bytes.length} bytes]` } });

  const saves = [];
  const ref = { id: 'acceptance-image', attachmentId: 'acceptance-image', mediaType: 'image/png' };
  const attached = await createHarness({ name: 'attachment', attachments: { async saveImage(input) { saves.push(input); return ref; } } });
  try {
    const result = await attached.invoke('browser_screenshot');
    const image = result.content?.find((block) => block.type === 'image');
    check('有附件服务时 saveImage 收到 PNG 并 render image attachment', result.ok && saves.length === 1 && saves[0].mediaType === 'image/png'
      && result.value?.imageDelivery === 'attachment' && result.value.attachmentId === ref.id && image?.attachment?.id === ref.id,
    { expected: 'saveImage(PNG) + image attachment block', actual: { saves: saves.map((save) => ({ ...save, data: '[omitted]' })), result: result.value && { ...result.value, image: '[omitted]' }, image } });
    const caps = await attached.invoke('browser_capabilities');
    check('附件能力按实际服务存在性报告', caps.value?.runtime?.attachments === true, { expected: true, actual: caps.value?.runtime });
  } finally { await attached.closeBrowser(); await attached.dispose(); }
}

export async function cancellationProbe({ harness, check, fixture }) {
  const controller = new AbortController();
  const pending = harness.invoke('browser_eval', { expression: 'new Promise(resolve => setTimeout(() => resolve(42), 5000))' }, { signal: controller.signal });
  await sleep(100);
  const abortedAt = Date.now();
  controller.abort();
  const result = await pending;
  check('exec.signal 取消在 1 秒内抛 ABORTED', Date.now() - abortedAt < 1000 && result.threw && errorShape(result.error, 'ABORTED'),
    { expected: 'ABORTED within 1000ms', actual: { ...result, settledAfterAbortMs: Date.now() - abortedAt } });
  check('取消失败保留原页面 target 到 details 和消息证据', result.error?.details?.target === fixture.url && result.error?.message?.includes(fixture.url),
    { expected: { target: fixture.url, message: 'includes original target' }, actual: result.error });
  const afterAbort = await harness.invoke('browser_state');
  check('派发后取消在返回前关闭旧浏览器且释放 owner', afterAbort.value?.running === false && afterAbort.value?.owner?.sessionId === null,
    { expected: { running: false, owner: null }, actual: afterAbort.value });
  const recovery = await harness.invoke('browser_navigate', { url: fixture.url });
  check('取消后 runtime 可重新懒启动并导航', recovery.ok && recovery.value?.ok === true, { expected: 'success', actual: recovery.error || recovery.value });
  await waitFor(async () => (await harness.invoke('browser_eval', { expression: 'document.readyState' })).value?.value === 'complete');
  const setup = await harness.invoke('browser_eval', { expression: 'window.acceptanceOrder=[]; document.body.tabIndex=0; document.body.focus(); document.body.addEventListener("keydown",()=>window.acceptanceOrder.push("panel"));' });
  const first = harness.invoke('browser_eval', { expression: 'new Promise(resolve=>{window.acceptanceOrder.push("start");setTimeout(()=>{window.acceptanceOrder.push("end");resolve(true)},200)})' });
  await sleep(40);
  const panel = harness.request({ method: 'POST', path: '/plugins/ui-testing/input', body: { events: [{ kind: 'key', type: 'keyDown', key: 'A', code: 'KeyA' }] } });
  const second = harness.invoke('browser_eval', { expression: 'window.acceptanceOrder.push("second"); true' });
  const completed = await Promise.all([first, panel, second]);
  const order = await harness.invoke('browser_eval', { expression: 'window.acceptanceOrder' });
  check('Agent eval 与面板 input、后续 Agent 操作共享串行锁', setup.ok && completed[0].ok && completed[1].json?.ok && completed[2].ok
    && order.value?.value?.length === 4 && order.value.value[0] === 'start' && order.value.value[1] === 'end'
    && new Set(order.value.value.slice(2)).size === 2 && order.value.value.includes('panel') && order.value.value.includes('second'),
  { expected: 'start/end 连续且先于 panel/second（HTTP body 解析与工具 enqueue 顺序不固定）', actual: { completed, order: order.value } });
}

export async function targetPolicyProbe({ harness, check, fixture }) {
  for (const url of ['file:///etc/passwd', 'http://169.254.169.254/', 'http://10.0.0.1/', 'http://192.168.1.1/', 'http://user:fake@127.0.0.1/', process.env.DSH_WEB_URL || 'http://127.0.0.1:3080/']) {
    const tool = await harness.invoke('browser_navigate', { url });
    check(`工具拒绝目标 ${url}`, tool.threw && errorShape(tool.error, 'INVALID_ARGUMENT'), { expected: 'INVALID_ARGUMENT', actual: tool });
    const panel = await harness.request({ method: 'POST', path: '/plugins/ui-testing/navigate', body: { url } });
    check(`HTTP 导航同样拒绝目标 ${url}`, panel.json?.ok === false && typeof panel.json.error === 'string' && panel.json.code === 'INVALID_ARGUMENT', { expected: 'string error + INVALID_ARGUMENT', actual: panel.json });
  }
  let popupDocuments = 0;
  const redirect = createServer((req, res) => {
    if (req.url === '/truncated-response') {
      res.writeHead(200, { 'content-type': 'text/plain', 'content-length': '10000', 'access-control-allow-origin': '*' });
      res.write('partial');
      setTimeout(() => res.destroy(), 40);
      return;
    }
    if (req.url === '/popup-document') { popupDocuments++; res.writeHead(200, { 'content-type': 'text/html' }); res.end('<title>forbidden popup</title>'); return; }
    if (req.url === '/allowed') res.writeHead(302, { location: fixture.url });
    else res.writeHead(302, { location: 'http://169.254.169.254/latest/meta-data/' });
    res.end();
  });
  await new Promise((resolve) => redirect.listen(0, '127.0.0.1', resolve));
  try {
    const base = `http://127.0.0.1:${redirect.address().port}`;
    const allowed = await harness.invoke('browser_navigate', { url: base + '/allowed' });
    check('合法 loopback 重定向成功', allowed.ok && allowed.value?.ok, { expected: 'success', actual: allowed });
    const blocked = await harness.invoke('browser_navigate', { url: base + '/blocked' });
    check('loopback 重定向到 metadata 在 Document 请求阶段被拒绝', blocked.threw && errorShape(blocked.error, 'NAV_FAILED'), { expected: 'NAV_FAILED', actual: blocked });
    await harness.invoke('browser_navigate', { url: fixture.url });
    await harness.invoke('browser_eval', { expression: `fetch(${JSON.stringify(base + '/truncated-response')}).then(r=>r.text()).catch(()=>false)` });
    let truncated;
    await waitFor(async () => {
      const network = await harness.invoke('browser_network', { limit: 300 });
      truncated = network.value?.entries?.filter((entry) => entry.url.includes('/truncated-response'));
      return truncated?.some((entry) => entry.failed);
    }, { timeoutMs: 3000, label: 'HTTP 200 truncated loadingFailed' }).catch(() => {});
    check('HTTP200 后响应体截断保留 status200 并更新 failed/errorText，不重复条目', truncated?.length === 1 && truncated[0].status === 200 && truncated[0].failed === true && typeof truncated[0].errorText === 'string' && truncated[0].errorText.length > 0,
      { expected: 'one entry {status:200,failed:true,errorText}', actual: truncated });
    const previousOrigin = process.env.DSH_WEB_URL;
    try {
      process.env.DSH_WEB_URL = base;
      const opened = await harness.invoke('browser_eval', { expression: `window.open(${JSON.stringify(base + '/popup-document')}, '_blank'); true` });
      await sleep(400);
      check('window.open secondary target 不能向被阻断 origin 发出 Document 请求', opened.ok && opened.value?.ok && popupDocuments === 0,
        { expected: 'popup document counter = 0', actual: { opened: opened.error || opened.value, popupDocuments } });
      const originalPage = await harness.invoke('browser_navigate', { url: fixture.url + 'second.html' });
      check('阻断 popup 后原 page 仍可正常导航', originalPage.ok && originalPage.value?.ok, { expected: 'success', actual: originalPage.error || originalPage.value });
    } finally {
      if (previousOrigin === undefined) delete process.env.DSH_WEB_URL; else process.env.DSH_WEB_URL = previousOrigin;
    }
  } finally { await new Promise((resolve) => redirect.close(resolve)); }
}

export async function startupFailureProbe({ check }) {
  const before = new Set(await snapshotProfileDirs());
  const script = `import {createHarness,snapshotProfileDirs} from './tests/acceptance/harness.mjs';
const h=await createHarness();try {const result=await h.invoke('browser_screenshot');console.log(JSON.stringify(result));process.exitCode=result.threw?0:1;} finally {await h.dispose();}`;
  const child = spawn(process.execPath, ['--input-type=module', '-e', script], {
    cwd: fileURLToPath(new URL('../../', import.meta.url)), env: { ...process.env, DSH_UI_TESTING_CHROME: '/bin/false' }, stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stdout = '', stderr = '';
  child.stdout.on('data', (chunk) => { stdout += chunk; });
  child.stderr.on('data', (chunk) => { stderr += chunk; });
  const [code] = await once(child, 'exit');
  const leftovers = (await snapshotProfileDirs()).filter((path) => !before.has(path));
  check('Chromium 启动失败显式抛错且无 profile 遗留', code === 0 && /BrowserError/.test(stdout) && leftovers.length === 0,
    { expected: 'BrowserError + no new profiles', actual: { code, stdout, stderr, leftovers } });
}
