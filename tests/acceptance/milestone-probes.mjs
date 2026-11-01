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
  // T2 (docs/t2-structured-gui.md §5.3): seven web.t2.* projections + the aggregate id are
  // available; T3 (docs/t3-vision.md §11) adds six tool projections + the static-vision aggregate;
  // T4 stays unsupported with no tool behind it.
  const expectedT2 = [
    ['web.t2.snapshot', 'browser_snapshot'], ['web.t2.click', 'browser_click'], ['web.t2.type', 'browser_type'],
    ['web.t2.scroll', 'browser_scroll'], ['web.t2.fill_form', 'browser_fill_form'],
    ['web.t2.node_state', 'browser_node_state'], ['web.t2.wait_for', 'browser_wait_for'],
  ];
  const t2Problems = expectedT2.filter(([id, tool]) => !capabilities.some((item) => item.id === id && item.tool === tool && item.status === 'available'));
  const structured = capabilities.find((item) => item.id === 'web.t2.structured-dom');
  check('七项 web.t2.* 投影 available 且 structured-dom 单独 available', t2Problems.length === 0
    && structured?.status === 'available' && !structured?.tool, {
    expected: [...expectedT2.map((item) => `${item[0]}:available`), 'web.t2.structured-dom:available'],
    actual: { problems: t2Problems, structured },
  });
  // T3 is implemented (docs/t3-vision.md): its six tool projections and the static-vision aggregate
  // must be available; T4 must still be unsupported with no tool behind it. This replaces the
  // pre-T3 "T3/T4 unsupported" assertion and is strictly stronger, not looser.
  const expectedT3 = [
    ['web.t3.image', 'browser_vision_image'], ['web.t3.find', 'browser_vision_find'],
    ['web.t3.compare', 'browser_vision_compare'], ['web.t3.act', 'browser_vision_act'],
    ['web.t3.baseline', 'browser_vision_baseline'], ['web.t3.check', 'browser_vision_check'],
  ];
  const t3Problems = expectedT3.filter(([id, tool]) => !capabilities.some((item) => item.id === id && item.tool === tool && item.status === 'available'));
  const t3Aggregate = capabilities.find((item) => item.id === 'web.t3.static-vision');
  const t4Entries = capabilities.filter((item) => /t4/i.test(item.id));
  check('六项 web.t3.* 投影与 web.t3.static-vision 聚合 available，T4 仍 unsupported 且没有同名工具',
    t3Problems.length === 0 && t3Aggregate?.status === 'available' && !t3Aggregate?.tool
      && t4Entries.length > 0 && t4Entries.every((item) => item.status === 'unsupported' && !item.tool), {
    expected: [...expectedT3.map(([id]) => `${id}:available`), 'web.t3.static-vision:available', 'T4 unsupported + no tool'],
    actual: { problems: t3Problems, aggregate: t3Aggregate, t4: t4Entries },
  });
  const t1Tools = capabilities.filter((item) => item.id.startsWith('web.t1.') && item.tool);
  const httpEntry = capabilities.find((item) => item.id === 'web.t1.http-request');
  check('T1 恰好 9 项工具投影且 http-request 为 available', t1Tools.length === 9
    && t1Tools.every((item) => item.status === 'available')
    && httpEntry?.tool === 'browser_http_request' && httpEntry.status === 'available'
    && Array.isArray(httpEntry.constraints) && httpEntry.constraints.length === 4
    && httpEntry.constraints.some((text) => /no Chromium startup/i.test(text)),
  { expected: { count: 9, http: 'available' }, actual: t1Tools.map((item) => `${item.id}:${item.status}`) });
  check('viewport-control/browser-extras 仍 unsupported 且没有同名工具',
    capabilities.filter((item) => /viewport-control|browser-extras/.test(item.id)).every((item) => item.status === 'unsupported' && !item.tool),
    { actual: capabilities.filter((item) => /viewport-control|browser-extras/.test(item.id)) });
  const structuredGui = value?.limits?.structuredGui;
  check('limits.structuredGui 报告 T2 契约限额', structuredGui?.protocolVersion === 1
    && structuredGui?.defaultMaxNodes === 500 && structuredGui?.maxNodes === 2000
    && structuredGui?.defaultDepth === 12 && structuredGui?.maxDepth === 32 && structuredGui?.boxesDefault === false
    && structuredGui?.treeBytes === 131072 && structuredGui?.snapshotBytes === 524288 && structuredGui?.evidenceBytes === 262144
    && structuredGui?.maxRefs === 2000 && structuredGui?.formFields === 20 && structuredGui?.scrollAmount === 400, {
    expected: 'docs/t2-structured-gui.md §5.3 limits.structuredGui', actual: structuredGui,
  });
  const httpLimits = value?.limits?.httpRequest;
  check('limits.httpRequest 与契约默认/上限一致', httpLimits?.defaultTimeoutMs === 5000 && httpLimits?.maxTimeoutMs === 20000
    && httpLimits?.defaultMaxBytes === 65536 && httpLimits?.maxBytes === 1048576 && httpLimits?.maxRequestBodyBytes === 65536
    && httpLimits?.maxRequestHeaderBytes === 8192 && httpLimits?.maxResponseHeaderBytes === 16384
    && httpLimits?.defaultMaxRedirects === 0 && httpLimits?.maxRedirects === 5,
  { expected: '契约 §7 limits.httpRequest', actual: httpLimits });
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
    // Diagnostics run in the same workspace (workspace isolation: leases are per workspace),
    // from a third session that must not take the owner.
    const state = await harness.invoke('browser_state', {}, exec('lease-observer'));
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

  // --- T2 (docs/t2-structured-gui.md §2.2): same envelope + version=1 evidence -------------
  const origin = new URL(state.value.url).origin;
  const t2Page = origin + '/web-t2.html';
  const t2Nav = await harness.invoke('browser_navigate', { url: t2Page });
  await waitFor(async () => (await harness.invoke('browser_eval', { expression: 'document.readyState' })).value?.value === 'complete', { timeoutMs: 10000, label: 't2 page ready' });
  // Pre-scroll so the lossless-output probe is not coupled to auto-scroll (C17 covers that).
  await harness.invoke('browser_eval', { expression: 'document.getElementById("t2-inc").scrollIntoView({block:"center"}), 1' });
  const snapshot = await harness.invoke('browser_snapshot', {});
  const refs = Object.values(snapshot.value?.refs || {});
  const incrementRef = Object.entries(snapshot.value?.refs || {}).find(([, entry]) => entry.role === 'button' && entry.name === 'Increment')?.[0];
  const nameRef = Object.entries(snapshot.value?.refs || {}).find(([, entry]) => entry.role === 'textbox' && entry.name === 'Name')?.[0];
  check('T2 快照可用（前置：refs 非空）', t2Nav.ok && snapshot.ok && refs.length > 5 && Boolean(incrementRef), {
    expected: 'snapshot with refs', actual: { nav: t2Nav.ok, snapshot: snapshot.ok, refs: refs.length, incrementRef, error: snapshot.error?.message },
  });
  const t2Cases = [
    ['browser_snapshot', {}],
    ['browser_click', { ref: incrementRef }],
    ['browser_type', { ref: nameRef, text: 'evidence-probe' }],
    ['browser_scroll', { direction: 'down', amount: 120 }],
    ['browser_fill_form', { fields: [{ selector: '#t2-agree', type: 'checkbox', value: true }] }],
    ['browser_node_state', { selector: '#t2-inc' }],
    ['browser_wait_for', { text: 'Item 1', timeoutMs: 2000 }],
  ];
  const t2successful = [];
  for (const [name, args] of t2Cases) {
    const result = await harness.invoke(name, args);
    t2successful.push(result);
    const value = result.value;
    const text = textContent(result);
    check(`${name} 返回完整 envelope + version=1 evidence`, result.ok && evidenceKeys.every((key) => Object.hasOwn(value || {}, key))
      && typeof value.actionId === 'string' && value.sessionId === 'anonymous'
      && Number.isFinite(time(value.startedAt)) && time(value.finishedAt) >= time(value.startedAt)
      && value.evidence?.version === 1 && typeof value.evidence.operation === 'string'
      && Array.isArray(value.evidence.targets) && Array.isArray(value.evidence.incomplete)
      && typeof value.evidence.truncated === 'boolean' && Boolean(value.evidence.networkDelta)
      && Boolean(value.evidence.before) && Boolean(value.evidence.after)
      && text.includes('"evidence"') && text.includes(value.actionId), {
      expected: [...evidenceKeys, 'evidence.version=1', 'targets/incomplete/truncated/networkDelta/before/after'],
      actual: { value: value && { ...value, evidence: value.evidence && { ...value.evidence, targets: `[${value.evidence.targets?.length}]` } }, content: text.slice(0, 600) },
    });
  }
  check('七个 T2 工具生成唯一 actionId', new Set(t2successful.map((item) => item.value?.actionId)).size === t2successful.length,
    { expected: t2successful.length, actual: t2successful.map((item) => item.value?.actionId) });
  const t2Failure = await harness.invoke('browser_click', { selector: '#t2-missing-evidence' });
  check('T2 失败抛 BrowserError 且 details.evidence version=1', t2Failure.threw === true
    && t2Failure.error?.code === 'TARGET_NOT_FOUND' && t2Failure.error?.details?.evidence?.version === 1
    && String(t2Failure.error?.message || '').startsWith('[TARGET_NOT_FOUND]'), {
    expected: { code: 'TARGET_NOT_FOUND', evidenceVersion: 1 }, actual: { code: t2Failure.error?.code, evidence: t2Failure.error?.details?.evidence?.version, message: String(t2Failure.error?.message || '').slice(0, 160) },
  });
  await harness.invoke('browser_navigate', { url: state.value.url });

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
