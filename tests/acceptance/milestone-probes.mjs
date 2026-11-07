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
  const t4ToolNames = ['browser_dynamic_session', 'browser_motion_observe', 'browser_motion_analyze',
    'browser_motion_control', 'browser_dynamic_correlate'];
  check('六项 web.t3.* 投影与 web.t3.static-vision 聚合 available，T4 五工具 + 聚合 + 旧别名 available',
    t3Problems.length === 0 && t3Aggregate?.status === 'available' && !t3Aggregate?.tool
      && t4Entries.length >= 7 && t4Entries.every((item) => item.status === 'available')
      && t4ToolNames.every((name) => t4Entries.some((item) => item.tool === name)), {
    expected: [...expectedT3.map(([id]) => `${id}:available`), 'web.t3.static-vision:available', 'T4: 5 tool + aggregate + alias, all available'],
    actual: { problems: t3Problems, aggregate: t3Aggregate, t4: t4Entries },
  });
  const t1Tools = capabilities.filter((item) => item.id.startsWith('web.t1.') && item.tool);
  const httpEntry = capabilities.find((item) => item.id === 'web.t1.http-request');
  // 10 T1 tool projections after the shared-viewport round (docs/viewport-control.md §7.2):
  // 9 historical + browser_viewport.
  const viewportEntry = capabilities.find((item) => item.id === 'web.t1.viewport');
  check('T1 恰好 10 项工具投影（含 web.t1.viewport）且 http-request/viewport 为 available', t1Tools.length === 10
    && t1Tools.every((item) => item.status === 'available')
    && httpEntry?.tool === 'browser_http_request' && httpEntry.status === 'available'
    && Array.isArray(httpEntry.constraints) && httpEntry.constraints.length === 4
    && httpEntry.constraints.some((text) => /no Chromium startup/i.test(text))
    && viewportEntry?.tool === 'browser_viewport' && viewportEntry.status === 'available'
    && Array.isArray(viewportEntry.constraints) && viewportEntry.constraints.length >= 5
    && viewportEntry.constraints.some((text) => /cache diagnostic/i.test(text))
    && viewportEntry.constraints.some((text) => /set is a page operation/i.test(text)),
  { expected: { count: 10, http: 'available', viewport: 'available' }, actual: t1Tools.map((item) => `${item.id}:${item.status}`) });
  // network P0 (docs/network-p0.md §2/§12): seven web.network.* tool projections + the
  // web.network.p0 aggregate. Their tri-state must be one of available/unavailable/unsupported and
  // the aggregate must not sit behind a tool. Storage-only tools are readable without Chromium, so
  // in the idle state every projection is expected to be `available`.
  const expectedNetwork = [
    ['web.network.session', 'browser_network_session'], ['web.network.events', 'browser_network_events'],
    ['web.network.detail', 'browser_network_detail'], ['web.network.trace', 'browser_network_trace'],
    ['web.network.control', 'browser_network_control'], ['web.network.evidence', 'browser_network_evidence'],
    ['web.network.subscribe', 'browser_network_subscribe'],
  ];
  const networkProblems = expectedNetwork.filter(([id, tool]) => !capabilities.some((item) => item.id === id
    && item.tool === tool && ['available', 'unavailable', 'unsupported'].includes(item.status)));
  const networkAvailable = expectedNetwork.filter(([id, tool]) => capabilities.some((item) => item.id === id && item.tool === tool && item.status === 'available'));
  const networkAggregate = capabilities.find((item) => item.id === 'web.network.p0');
  check('七项 web.network.* 投影到七工具（三态合法、idle 下 available）且 web.network.p0 聚合不带 tool',
    networkProblems.length === 0 && networkAvailable.length === 7
      && networkAggregate && ['available', 'unavailable', 'unsupported'].includes(networkAggregate.status) && !networkAggregate.tool, {
    expected: [...expectedNetwork.map(([id]) => `${id}:available`), 'web.network.p0 聚合（无 tool）'],
    actual: { problems: networkProblems, available: networkAvailable.length, aggregate: networkAggregate },
  });
  const networkSection = value?.network;
  const networkLimits = networkSection?.limits || {};
  const networkCapture = networkLimits.network || {};
  // docs/network-p0.md §8.8 + C1: every limit is published, capture capabilities are booleans and
  // HTTPS is reported as `mechanism-identical` (no local TLS fixture, so it must never read
  // "verified"). `responseModification` must be an honest boolean.
  check('capabilities.network 段声明 7 工具、limits 与逐项捕获能力（https=mechanism-identical，不声称已验证）', Boolean(networkSection)
    && JSON.stringify([...(networkSection.tools || [])].sort()) === JSON.stringify(expectedNetwork.map(([, tool]) => tool).sort())
    && networkLimits.maxEvents === 20000 && networkLimits.maxBodyBytes === 1048576
    && networkLimits.maxTotalBytes === 33554432 && networkLimits.maxWsFrames === 20000
    && networkLimits.subscriptionMax === 16 && networkLimits.subscriptionPin === 1000
    && networkLimits.eventPageLimit === 200 && networkLimits.holdTimeoutMs === 30000
    && networkCapture.capture === true && networkCapture.bodies === true && networkCapture.websocket === true
    && networkCapture.sse === true && networkCapture.workers === true && networkCapture.interception === true
    && typeof networkCapture.responseModification === 'boolean'
    && networkCapture.throttle === true && networkCapture.offline === true
    && networkCapture.replay === true && networkCapture.mock === true
    && networkCapture.har === true && networkCapture.jsonl === true && networkCapture.subscriptions === true, {
    expected: { tools: expectedNetwork.map(([, tool]) => tool), limits: 'docs/network-p0.md §8.8', https: 'mechanism-identical' }, actual: networkSection,
  });
  check('capabilities.network 如实把 HTTPS 记为 mechanism-identical（未独立验证）且 observed 只来自真实调用',
    JSON.stringify(networkSection || {}).includes('mechanism-identical')
      && !/https"\s*:\s*(true|"verified")/i.test(JSON.stringify(networkSection || {}))
      && (networkSection?.observed === null || typeof networkSection?.observed === 'object'), {
    expected: { https: 'mechanism-identical', observed: 'null | object' }, actual: { https: networkCapture.https, observed: networkSection?.observed },
  });
  // The shared viewport is implemented now: the old `web.t1.viewport-control` placeholder must be
  // gone and `web.t1.viewport` must carry the new tool. `browser-extras` stays unsupported.
  const viewportControl = capabilities.filter((item) => item.id === 'web.t1.viewport-control');
  check('共享视口已实现：web.t1.viewport-control 占位已移除，web.t1.viewport 指向 browser_viewport；browser-extras 仍 unsupported',
    viewportControl.length === 0
      && capabilities.some((item) => item.id === 'web.t1.viewport' && item.tool === 'browser_viewport')
      && capabilities.filter((item) => /browser-extras/.test(item.id)).every((item) => item.status === 'unsupported' && !item.tool),
    { actual: { viewportControl, viewport: capabilities.find((item) => item.id === 'web.t1.viewport'), extras: capabilities.filter((item) => /browser-extras/.test(item.id)) } });
  const structuredGui = value?.limits?.structuredGui;
  check('limits.structuredGui 报告 T2 契约限额', structuredGui?.protocolVersion === 1
    && structuredGui?.defaultMaxNodes === 500 && structuredGui?.maxNodes === 2000
    && structuredGui?.defaultDepth === 12 && structuredGui?.maxDepth === 32 && structuredGui?.boxesDefault === false
    && structuredGui?.treeBytes === 131072 && structuredGui?.snapshotBytes === 524288 && structuredGui?.evidenceBytes === 262144
    && structuredGui?.maxRefs === 2000 && structuredGui?.formFields === 20 && structuredGui?.scrollAmount === 400, {
    expected: 'docs/t2-structured-gui.md §5.3 limits.structuredGui', actual: structuredGui,
  });
  const viewportLimits = value?.limits?.viewport;
  const viewportSection = value?.viewport;
  check('limits.viewport 与 viewport 段报告共享视口契约（比例 0.1–2、预设、stale/settle、dsf=1、get 只读）',
    Array.isArray(viewportLimits?.width) && viewportLimits.width[0] === 200 && viewportLimits.width[1] === 4096
      && Array.isArray(viewportLimits?.height) && viewportLimits.height[0] === 200 && viewportLimits.height[1] === 4096
      && Array.isArray(viewportLimits?.scroll) && viewportLimits.scroll[0] === 0 && viewportLimits.scroll[1] === 10000000
      && Array.isArray(viewportLimits?.scale) && viewportLimits.scale[0] === 0.1 && viewportLimits.scale[1] === 2
      && viewportLimits?.default?.width === 1280 && viewportLimits?.default?.height === 800
      && viewportLimits?.default?.scale === 1 && viewportLimits?.staleAfterMs === 1000
      && viewportLimits?.settleMaxMs === 1000 && viewportLimits?.scrollPollMinMs === 200
      && viewportLimits?.deviceScaleFactor === 1 && viewportLimits?.pageZoomChanged === false
      && viewportSection?.tool === 'browser_viewport' && viewportSection?.get?.readOnly === true
      && viewportSection?.get?.lazyStart === false && viewportSection?.get?.lease === false
      && viewportSection?.set?.lazyStart === true && viewportSection?.set?.lease === true
      && viewportSection?.presets?.phone?.width === 393 && viewportSection?.presets?.phone?.height === 852
      && viewportSection?.presets?.wide?.width === 1920 && viewportSection?.presets?.landscape?.height === 768
      && viewportSection?.presets?.tablet?.width === 768,
  { expected: 'docs/viewport-control.md §7.2 limits.viewport + viewport 段', actual: { viewportLimits, viewportSection } });
  const captureSection = value?.capture;
  const captureLimits = value?.limits?.capture;
  check('capture 默认比例来源是 view.scale（cold fallback 1），显式 scale 范围 0.1–4',
    captureSection?.defaultScaleSource === 'view.scale' && captureSection?.defaultScale === 1
      && Array.isArray(captureSection?.scaleRange) && captureSection.scaleRange[0] === 0.1 && captureSection.scaleRange[1] === 4
      && captureLimits?.defaultScaleSource === 'view.scale' && captureLimits?.defaultScale === 1
      && Array.isArray(captureLimits?.scaleRange) && captureLimits.scaleRange[0] === 0.1 && captureLimits.scaleRange[1] === 4
      && captureLimits?.minOutputPixels?.width === 1 && captureLimits?.minOutputPixels?.height === 1,
  { expected: { defaultScaleSource: 'view.scale', defaultScale: 1, scaleRange: [0.1, 4] }, actual: { captureSection, captureLimits } });
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
    // The single-owner lease serialises page writes, so the competition uses a page operation. The
    // read-only legacy traffic snapshot must stay readable while somebody holds the lease.
    const [a, b] = await Promise.all(['lease-a', 'lease-b'].map((id) => harness.invoke('browser_eval', { expression: '1 + 1' }, exec(id))));
    const winner = a.ok ? 'lease-a' : 'lease-b';
    const loser = a.ok ? b : a;
    check('两个不同会话竞争只有一个获得 lease，另一方 BUSY', [a, b].filter((item) => item.ok).length === 1 && errorShape(loser.error, 'BUSY') && loser.error.retryable,
      { expected: 'one success + one BUSY', actual: [a, b] });
    // Page *writes* validate the lease. The read-only legacy traffic snapshot must not: it neither
    // writes the page nor needs ownership, so it stays readable while another session holds the lease.
    for (const [name, args] of [['browser_eval', { expression: '1' }], ['browser_screenshot', {}], ['browser_computed_style', { selector: 'body' }], ['browser_input', { events: [] }], ['browser_navigate', { url: 'http://127.0.0.1:1/' }]]) {
      const result = await harness.invoke(name, args, exec('lease-other'));
      check(`${name} 页面写操作校验 lease`, result.threw && errorShape(result.error, 'BUSY'), { expected: 'BUSY', actual: result });
    }
    const readOnlyNetwork = await harness.invoke('browser_network', {}, exec('lease-observer'));
    check('browser_network 只读：owner 持租约时仍可读且不夺取租约', readOnlyNetwork.ok === true,
      { expected: 'ok', actual: readOnlyNetwork.error || { entries: readOnlyNetwork.value?.entries?.length } });
    for (const name of ['browser_state', 'browser_capabilities']) {
      const result = await harness.invoke(name, {}, exec('lease-observer'));
      check(`${name} 诊断可跨会话且不夺取 owner`, result.ok, { expected: 'success', actual: result.error || result.value });
    }
    const busyCapabilities = await harness.invoke('browser_capabilities', {}, exec('lease-observer'));
    const byTool = new Map((busyCapabilities.value?.capabilities || []).filter((item) => item.tool).map((item) => [item.tool, item]));
    // The read-only traffic snapshot stays `available` for another owner (it takes no lease); the
    // page-write tools report BUSY.
    check('capabilities 对其他 owner 页面写工具如实报 unavailable，只读读与诊断仍 available', ['browser_navigate', 'browser_eval', 'browser_screenshot', 'browser_input', 'browser_computed_style'].every((name) => byTool.get(name)?.status === 'unavailable')
      && ['browser_network', 'browser_state', 'browser_capabilities'].every((name) => byTool.get(name)?.status === 'available'), { expected: '5 unavailable + network/2 diagnostics available', actual: busyCapabilities.value?.capabilities });
    // Diagnostics run in the same workspace (workspace isolation: leases are per workspace),
    // from a third session that must not take the owner.
    const state = await harness.invoke('browser_state', {}, exec('lease-observer'));
    // Read-only diagnostics never take the lease: the owner must still be the page-operation winner.
    check('诊断保留实际 owner（只读读取不夺取租约）', state.value?.owner?.sessionId === winner,
      { expected: { owner: winner }, actual: { owner: state.value?.owner, running: state.value?.running } });
    await harness.ctx.emit('agent/disposed', { agent: { id: 'unrelated-session' } });
    const stillBusy = await harness.invoke('browser_eval', { expression: '1 + 1' }, exec('lease-after-unrelated'));
    check('无关 disposed 事件不释放 owner', errorShape(stillBusy.error, 'BUSY'), { expected: 'BUSY', actual: stillBusy });
    await harness.ctx.emit('agent/disposed', { agent: { id: winner } });
    const next = await harness.invoke('browser_eval', { expression: '1 + 1' }, exec('lease-after-dispose'));
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
