#!/usr/bin/env node
/**
 * Real Chromium: the Agent half of the P0-D annotation document (`browser_annotation`,
 * docs/viewport-control.md).
 *
 * What this suite proves, and what it deliberately does not:
 *   - pure pre-flight refusals cost zero browser/CDP (invalid action, unknown field, read with
 *     payload, draw without shapes, erase without a target, 65 shapes);
 *   - draw/erase/clear are refused with ANNOTATION_NOT_FOREGROUND until the authenticated panel
 *     reports that this runtime is its selected, visible tab, and are refused again once the
 *     freshness window expires — the "a human can see it" requirement, not a permission flag;
 *   - a write is a read-modify-write of ONE document: a human-published shape survives an Agent
 *     draw, and the Agent can erase it by id;
 *   - the stored document is the shape the panel already hydrates (version/space/context/shapes),
 *     and `browser_screenshot {includeAnnotations:true}` composites the Agent's pixels;
 *   - style mapping (stroke/fill/color/width/arrow head), revision CAS, the 64-per-call and
 *     128-document limits, and the "zero page cost" claim (no ensure, no lease, no DOM/scroll/
 *     focus change, unchanged lastError);
 *   - `read` works on a cold runtime and never starts a page.
 *
 * NOT proven here: real GUI tab switching (that is `annotation-agent-gui`/`p0e-multitab-gui`
 * territory), the panel's own pixel rendering (annotation-capture.mjs owns it), and whether a human
 * *noticed* anything. The foreground claim is injected through the same scoped HTTP surface the
 * panel uses, so this proves the Host contract, not the panel's polling cadence.
 */
import assert from 'node:assert/strict';
import http from 'node:http';
import { randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createHarness, createFakeConnectionService, EXPECTED_TOOLS } from './harness.mjs';
import { decodePng } from '../../capture-p0.js';

const runDir = join(import.meta.dirname, 'runs', `annotation-agent-${new Date().toISOString().replace(/[:.]/g, '-')}-${process.pid}`);
await mkdir(runDir, { recursive: true });
const checks = [];
const check = (label, condition, actual = null, expected = null) => {
  assert.ok(condition, `${label}${actual === null ? '' : ' :: ' + JSON.stringify(actual)}`);
  checks.push(label);
  console.log('PASS', checks.length, label);
};

const server = http.createServer((req, res) => {
  res.setHeader('Content-Security-Policy', "default-src 'none'; img-src 'none'; style-src 'unsafe-inline'; script-src 'none'");
  res.end('<!doctype html><style>html,body{margin:0;background:#e8eef5;width:2400px;height:3000px}'
    + '#marker{position:fixed;left:10px;top:10px;width:20px;height:20px;background:#123456}</style>'
    + '<div id="marker"></div><input id="focus">');
});
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));

const saved = [];
const harness = await createHarness({
  name: 'annotation-agent',
  connection: createFakeConnectionService({
    rejection: undefined,
    admit: () => ({ peer: { id: 'annotation-agent-peer' } }),
    browserPeer: { id: 'annotation-agent-peer' },
  }),
  attachments: {
    async saveImage({ data }) {
      saved.push(Buffer.from(data));
      const png = decodePng(data);
      return { attachmentId: randomUUID(), mediaType: 'image/png', bytes: data.length, width: png.width, height: png.height };
    },
  },
});
const exec = { agent: { id: 'annotation-agent', session: { header: { cwd: harness.workspaceDir } } } };
const peer = () => createFakeConnectionService({
  rejection: undefined,
  admit: () => ({ peer: { id: 'annotation-agent-peer' } }),
  browserPeer: { id: 'annotation-agent-peer' },
});
/** One tool call; a thrown refusal is returned instead of failing the run (the caller decides). */
const raw = async (name, args = {}, target = exec) => harness.invoke(name, args, target);
const call = async (name, args = {}) => {
  const result = await raw(name, args);
  if (result.threw) throw new Error(`${name}: ${result.error.code} ${result.error.message}`);
  return result.value;
};
const expectRefusal = async (args, code, label) => {
  const result = await raw('browser_annotation', args);
  check(label, result.threw && result.error.code === code, result.threw ? result.error : result.value, code);
  return result.threw ? result.error : null;
};
const annotate = (args) => call('browser_annotation', args);
const readAll = () => annotate({ action: 'read' });
const scoped = (headers) => ({ 'x-ui-testing-scope-version': '1', 'x-ui-testing-session-id': exec.agent.id, ...headers });
/**
 * The panel's "this runtime is my selected tab and I am visible" heartbeat, sent exactly the way
 * client.js sends it (scope headers + `x-ui-testing-gui-foreground: 1` on an authenticated request).
 */
const reportForeground = async (on = true) => {
  harness.setConnection(on ? peer() : createFakeConnectionService({ rejection: 401 }));
  try {
    const response = await harness.request({
      method: 'GET',
      path: '/plugins/ui-testing/state',
      headers: scoped(on ? { 'x-ui-testing-gui-foreground': '1' } : {}),
    });
    return response.json;
  } finally { harness.setConnection(undefined); }
};
const zeroTruncation = () => ({ droppedShapes: 0, droppedPoints: 0, shortenedTextCodeUnits: 0 });
const panelId = '22222222-2222-4222-8222-222222222222';
let panelRevision = 0;
/** Publish a *human* document through the panel's real write route (the other writer). */
const publishPanel = async (shapes) => {
  const state = await reportForeground(true);
  const ui = state.ui || {};
  const view = ui.view || {};
  const canvas = ui.canvas || {};
  harness.setConnection(peer());
  try {
    const response = await harness.request({
      method: 'POST',
      path: '/plugins/ui-testing/annotations',
      headers: scoped({}),
      body: {
        version: 1, panelId, surface: 'main', clientRevision: ++panelRevision,
        context: { ...ui.annotationContext },
        view: {
          canvasX: view.canvasX, canvasY: view.canvasY, x: view.x, y: view.y,
          width: view.width, height: view.height, scale: view.scale,
          contentWidth: canvas.contentWidth, contentHeight: canvas.contentHeight,
          viewRevision: view.revision, frameEpoch: null,
        },
        shapes,
        truncation: zeroTruncation(),
      },
    });
    assert.equal(response.statusCode, 200, `panel publish must pass wire validation: ${JSON.stringify(response.json)}`);
    return response.json;
  } finally { harness.setConnection(undefined); }
};
const pixel = (image, x, y) => {
  const offset = (y * image.width + x) * image.channels;
  return [...image.data.subarray(offset, offset + 3)];
};
const pageCount = () => harness.ctx.__internal.plugin.registry.pageCount || 0;
/** Lease identity+expiry, so "this call did not touch the page" is checkable even while an earlier
 *  page operation still holds a 15s lease of its own. */
const leaseSignature = (rt) => (rt && rt.lease ? `${rt.lease.sessionId}:${rt.lease.expiresAt}` : 'none');
const runtimeOf = () => [...harness.ctx.__internal.plugin.registry.entries.values()].find((entry) => entry.runtime.running)?.runtime || null;
const red = '#ff0000';
const rectShape = { type: 'rect', color: red, strokeWidth: 4, style: 'stroke', x: 70, y: 60, width: 90, height: 55 };

try {
  /* ------------------------------------------------------------------ 1. pure pre-flight */
  check(harness.toolNames().length === EXPECTED_TOOLS.length && harness.toolNames().includes('browser_annotation'),
    `browser_annotation 已在工具面（${EXPECTED_TOOLS.length} 个工具）`,
    { count: harness.toolNames().length }, { count: EXPECTED_TOOLS.length });
  const definition = harness.tools.get('browser_annotation');
  check(definition?.parameters?.type === 'object'
      && JSON.stringify(definition.parameters.required) === JSON.stringify(['action'])
      && definition.parameters.additionalProperties === false
      && JSON.stringify(definition.parameters.properties.action.enum) === JSON.stringify(['read', 'draw', 'erase', 'clear']),
    'browser_annotation schema：required=[action]、additionalProperties=false、action 四枚举',
    definition?.parameters?.required, ['action']);

  await expectRefusal({ action: 'draw', shapes: [] }, 'INVALID_ARGUMENT', 'draw 传空 shapes → INVALID_ARGUMENT');
  await expectRefusal({ action: 'read', shapes: [rectShape] }, 'INVALID_ARGUMENT', 'read 携带其它字段 → INVALID_ARGUMENT');
  await expectRefusal({ action: 'erase' }, 'INVALID_ARGUMENT', 'erase 既无 ids 也无 point → INVALID_ARGUMENT');
  await expectRefusal({ action: 'paint' }, 'INVALID_ARGUMENT', '未知 action → INVALID_ARGUMENT');
  await expectRefusal({ action: 'draw', shapes: Array.from({ length: 65 }, () => ({ ...rectShape })) }, 'INVALID_ARGUMENT', '单次 65 个形状 → INVALID_ARGUMENT(too-many)');
  await expectRefusal({ action: 'draw', shapes: [{ type: 'line', style: 'fill', x1: 0, y1: 0, x2: 10, y2: 10 }] }, 'INVALID_ARGUMENT', 'line 用 fill 样式 → fill-stroke-fixed');
  await expectRefusal({ action: 'draw', shapes: [{ type: 'rect', style: 'fill', fill: true }] }, 'INVALID_ARGUMENT', 'style 与 fill 同给 → INVALID_ARGUMENT');
  await expectRefusal({ action: 'draw', shapes: [{ type: 'text', text: 'x', x: 0, y: 0, fontSize: 24 }] }, 'INVALID_ARGUMENT', 'text fontSize 非 20 → font-size-fixed');
  await expectRefusal({ action: 'draw', shapes: [{ type: 'circle', cx: 1, cy: 2 }] }, 'INVALID_ARGUMENT', 'circle 缺半径 → INVALID_ARGUMENT');
  check('以上拒绝全部零浏览器：仍未创建页面', pageCount() === 0, { pageCount: pageCount() }, 0);

  /* ------------------------------------------------------------------ 2. cold runtime */
  const coldRead = await readAll();
  check('冷态 read 成功且不启动页面：空 shapes、stale=not-running、foreground.active=false',
    coldRead.ok === true && coldRead.shapes.length === 0 && coldRead.revision === 0
      && coldRead.stale === true && coldRead.staleReason === 'not-running'
      && coldRead.foreground.active === false && coldRead.foreground.maxAgeMs === 1500,
    coldRead.foreground, { active: false });
  check('冷态 read 仍未创建页面（read 不 ensure）', pageCount() === 0, { pageCount: pageCount() }, 0);
  const coldWrite = await raw('browser_annotation', { action: 'draw', shapes: [rectShape] });
  check('冷态 draw 被拒（页面未运行）且 reason=annotation-runtime-not-running',
    coldWrite.threw && coldWrite.error.code === 'INVALID_ARGUMENT'
      && coldWrite.error.details?.reason === 'annotation-runtime-not-running',
    coldWrite.threw ? coldWrite.error.details : coldWrite.value, 'annotation-runtime-not-running');
  check('冷态 draw 零写入：revision 仍 0', (await readAll()).revision === 0, null, 0);

  /* ------------------------------------------------------------------ 3. running page */
  const url = `http://127.0.0.1:${server.address().port}/`;
  await call('browser_navigate', { url });
  await call('browser_viewport', { action: 'set', width: 500, height: 340, x: 0, y: 0 });
  const runtime = runtimeOf();
  check('页面运行后 pageCount=1（后续写入不得再开页）', pageCount() === 1 && Boolean(runtime), { pageCount: pageCount() }, 1);

  // No human foreground yet: every write is refused, with zero state change.
  const beforeForeground = await readAll();
  const leaseBefore = leaseSignature(runtime);
  await expectRefusal({ action: 'draw', shapes: [rectShape] }, 'ANNOTATION_NOT_FOREGROUND', '无前台声明时 draw → ANNOTATION_NOT_FOREGROUND');
  await expectRefusal({ action: 'clear' }, 'ANNOTATION_NOT_FOREGROUND', '无前台声明时 clear → ANNOTATION_NOT_FOREGROUND');
  await expectRefusal({ action: 'erase', ids: ['a1'] }, 'ANNOTATION_NOT_FOREGROUND', '无前台声明时 erase → ANNOTATION_NOT_FOREGROUND');
  const afterRefusal = await readAll();
  check('被拒的三次写入零副作用：revision/updatedAt/shapes 全不变、lastError 未污染、活动计数与租约均未被本次调用改动',
    afterRefusal.revision === beforeForeground.revision
      && JSON.stringify(afterRefusal.shapes) === JSON.stringify(beforeForeground.shapes)
      && afterRefusal.updatedAt === beforeForeground.updatedAt
      && runtime.lastError === '' && runtime.active === 0
      && leaseSignature(runtime) === leaseBefore,
    { revision: afterRefusal.revision, lastError: runtime.lastError, active: runtime.active, lease: leaseSignature(runtime) }, leaseBefore);

  /* ------------------------------------------------------------------ 4. foreground claim */
  await reportForeground(true);
  const claimed = await readAll();
  check('面板前台心跳后 foreground.active=true 且 ageMs 落在窗口内',
    claimed.foreground.active === true && claimed.foreground.ageMs !== null
      && claimed.foreground.ageMs <= claimed.foreground.maxAgeMs && claimed.foreground.viewId === 'primary',
    claimed.foreground, { active: true });

  const domBefore = await runtime.evaluate('({html:document.documentElement.outerHTML,scroll:[scrollX,scrollY],active:document.activeElement.tagName})');
  const drawn = await annotate({ action: 'draw', shapes: [rectShape] });
  const domAfter = await runtime.evaluate('({html:document.documentElement.outerHTML,scroll:[scrollX,scrollY],active:document.activeElement.tagName})');
  check('前台声明后 draw 成功：revision 1、一个形状、id 由 Host 分配为 a1',
    drawn.ok === true && drawn.revision === 1 && drawn.shapes.length === 1 && drawn.shapes[0].id === 'a1',
    { revision: drawn.revision, ids: drawn.shapes.map((shape) => shape.id) }, 'a1');
  check('draw 不碰页面：DOM/滚动/焦点不变、pageCount 仍 1、无 lastError、未取新租约',
    JSON.stringify(domBefore.value) === JSON.stringify(domAfter.value)
      && pageCount() === 1 && runtime.lastError === '' && runtime.active === 0
      && leaseSignature(runtime) === leaseBefore,
    { pageCount: pageCount(), lastError: runtime.lastError, lease: leaseSignature(runtime) }, leaseBefore);
  check('文档 source 标为 agent-tool 且 trusted=false（不冒充人类标注）',
    drawn.source.kind === 'agent-tool' && drawn.source.tool === 'browser_annotation'
      && drawn.source.trusted === false && drawn.source.agentSessionId === exec.agent.id,
    drawn.source, 'agent-tool/trusted:false');
  const context = runtime.annotationContext();
  check('文档 context 与 runtime.annotationContext 一致（面板 hydrate 的同一条身份）',
    drawn.context.documentKey === context.documentKey
      && drawn.context.pageGeneration === context.pageGeneration
      && drawn.context.documentEpoch === context.documentEpoch
      && drawn.context.runtimeId === context.runtimeId,
    drawn.context, context.documentKey);
  check('写入的 view 快照是画布坐标（width/height 为当前视口、viewRevision 与共享 view 同步）',
    drawn.view.width === 500 && drawn.view.height === 340 && drawn.view.scale === runtime.view.scale
      && drawn.view.viewRevision === runtime.view.revision,
    drawn.view, { width: 500, height: 340 });

  /* ------------------------------------------------------------------ 5. panel interop */
  const humanShape = { id: 'a1', type: 'circle', color: '#00aa44', strokeWidth: 3, fill: true, stroke: false, cx: 230, cy: 100, rx: 45, ry: 30 };
  await publishPanel([humanShape]);
  const afterPanel = await readAll();
  check('面板 publish 后文档回到 human-panel 且含人类的圆形', afterPanel.source.kind === 'human-panel' && afterPanel.shapes.length === 1 && afterPanel.shapes[0].id === 'a1', afterPanel.source, 'human-panel');
  const mixed = await annotate({ action: 'draw', shapes: [{ ...rectShape, color: '#2222ff' }] });
  check('Agent draw 是 read-modify-write：人类形状保留，新形状 id 续分配为 a2',
    mixed.shapes.length === 2 && mixed.shapes[0].id === 'a1' && mixed.shapes[1].id === 'a2'
      && mixed.source.kind === 'agent-tool',
    mixed.shapes.map((shape) => ({ id: shape.id, type: shape.type })), 'a1,a2');
  const erasedHuman = await annotate({ action: 'erase', ids: ['a1'] });
  check('erase 按 id 精确删除人类形状，只删命中的那个',
    erasedHuman.removed.length === 1 && erasedHuman.removed[0] === 'a1'
      && erasedHuman.shapes.length === 1 && erasedHuman.shapes[0].id === 'a2',
    erasedHuman.removed, ['a1']);

  /* ------------------------------------------------------------------ 6. style + geometry */
  const styled = await annotate({
    action: 'draw',
    shapes: [
      { type: 'circle', color: '#00AA44', cx: 230, cy: 100, rx: 45, ry: 30, style: 'fill' },
      { type: 'line', x1: 60, y1: 160, x2: 150, y2: 190, color: '#2222ff', strokeWidth: 5 },
      { type: 'arrow', x1: 210, y1: 160, x2: 290, y2: 195 },
      { type: 'brush', points: [[60, 250], [85, 225], [110, 260]] },
      { type: 'text', x: 190, y: 240, text: '这里对吗？' },
      { type: 'rect', x: 330, y: 60, width: 70, height: 55, style: 'fill' },
    ],
  });
  const byType = (type) => styled.shapes.filter((shape) => shape.type === type);
  check('style=fill 落到 fill:true/stroke:false，颜色大写被归一成小写',
    byType('circle').at(-1).fill === true && byType('circle').at(-1).stroke === false
      && byType('circle').at(-1).color === '#00aa44',
    byType('circle').at(-1), 'fill/stroke/lower-case');
  check('line/brush 固定外框、默认粗细 3；显式 strokeWidth 5 生效',
    byType('line').at(-1).fill === false && byType('line').at(-1).stroke === true
      && byType('line').at(-1).strokeWidth === 5 && byType('brush').at(-1).strokeWidth === 3,
    { line: byType('line').at(-1).strokeWidth, brush: byType('brush').at(-1).strokeWidth }, '5/3');
  check('arrow 的 head 由 Host 按端点+线宽派生（不给也能画）',
    byType('arrow').at(-1).head.length > 0 && byType('arrow').at(-1).head.width > 0,
    byType('arrow').at(-1).head, 'derived');
  check('text 形状可写中文问题、fontSize 固定 20、fill:true/stroke:false',
    byType('text').at(-1).text === '这里对吗？' && byType('text').at(-1).fontSize === 20
      && byType('text').at(-1).fill === true && byType('text').at(-1).stroke === false,
    byType('text').at(-1), 'text ok');
  check('brush 点按 [[x,y],…] 保存（3 个点）', byType('brush').at(-1).points.length === 3, byType('brush').at(-1).points, 3);

  /* ------------------------------------------------------------------ 7. eraser hits */
  const beforeErase = await readAll();
  const hitRect = beforeErase.shapes.find((shape) => shape.type === 'rect' && shape.fill === true);
  const erasedPoint = await annotate({ action: 'erase', point: { x: hitRect.x, y: hitRect.y + hitRect.height / 2 } });
  check('erase point 命中填充矩形内部（无 id 也能擦）',
    erasedPoint.removed.includes(hitRect.id) && !erasedPoint.shapes.some((shape) => shape.id === hitRect.id),
    { removed: erasedPoint.removed, target: hitRect.id }, hitRect.id);
  const missPoint = await annotate({ action: 'erase', point: { x: 480, y: 320 } });
  check('erase point 打在空白处不改文档（不误删）', missPoint.removed.length === 0 && missPoint.shapes.length === (await readAll()).shapes.length, missPoint.removed, []);

  /* ------------------------------------------------------------------ 8. revision CAS */
  const casBase = await readAll();
  const stale = await raw('browser_annotation', { action: 'draw', shapes: [rectShape], expectRevision: casBase.revision - 1 });
  check('expectRevision 不符 → ANNOTATION_REVISION_CONFLICT，零写入并回 currentRevision',
    stale.threw && stale.error.code === 'ANNOTATION_REVISION_CONFLICT'
      && stale.error.details?.currentRevision === casBase.revision,
    stale.threw ? stale.error.details : stale.value, casBase.revision);
  check('CAS 失败后 revision 未变', (await readAll()).revision === casBase.revision, null, casBase.revision);
  const casOk = await annotate({ action: 'draw', shapes: [rectShape], expectRevision: casBase.revision });
  check('expectRevision 相符 → 写入成功且 revision +1', casOk.revision === casBase.revision + 1, casOk.revision, casBase.revision + 1);

  /* ------------------------------------------------------------------ 9. limits */
  const many = Array.from({ length: 64 }, (_, index) => ({ ...rectShape, x: 40 + index, y: 20 }));
  const beforeBatch = await readAll();
  const batched = await annotate({ action: 'draw', shapes: many });
  check('单次 64 个形状全部接受（一次调用内不做裁剪）',
    batched.shapes.length === beforeBatch.shapes.length + 64 && batched.truncated === false,
    batched.shapes.length, beforeBatch.shapes.length + 64);
  let filled = batched;
  while (filled.shapes.length < 128) {
    const need = Math.min(64, 128 - filled.shapes.length);
    filled = await annotate({ action: 'draw', shapes: many.slice(0, need) });
  }
  check('可以把文档精确填到 128 个形状（128 是裁剪点，不是拒绝点）',
    filled.shapes.length === 128 && filled.truncated === false, filled.shapes.length, 128);
  const overflow = await annotate({ action: 'draw', shapes: [{ ...rectShape, x: 400, y: 300 }] });
  check('超出 128 文档上限 → truncated=true、只保留最新 128 个、droppedShapes≥1（确定性裁剪）',
    overflow.truncated === true && overflow.truncation.droppedShapes >= 1 && overflow.shapes.length === 128
      && overflow.shapes.at(-1).x === 400,
    { kept: overflow.shapes.length, dropped: overflow.truncation.droppedShapes }, 'droppedShapes≥1');
  await reportForeground(true);
  const cleared = await annotate({ action: 'clear' });
  check('clear 清空画布：shapes 空且 revision 继续递增',
    cleared.shapes.length === 0 && cleared.revision === overflow.revision + 1,
    { revision: cleared.revision, shapes: cleared.shapes.length }, 'empty');

  /* ------------------------------------------------------------------ 10. overlay + expiry */
  await annotate({ action: 'draw', shapes: [rectShape] });
  const shot = await call('browser_screenshot', { includeAnnotations: true });
  const png = decodePng(Buffer.from(shot.image, 'base64'));
  check('includeAnnotations 叠加 Agent 形状：composited=true、shapeCount=1、source=agent-tool',
    shot.capture.annotations.composited === true && shot.capture.annotations.shapeCount === 1
      && shot.capture.annotations.source.kind === 'agent-tool',
    shot.capture.annotations, { shapeCount: 1 });
  check('叠加像素里能读到 Agent 画的红色描边（人类可见的同一份文档）',
    pixel(png, 70, 80).join() === '255,0,0', pixel(png, 70, 80), '255,0,0');
  await writeFile(join(runDir, 'agent-annotation.png'), Buffer.from(shot.image, 'base64'));

  // The claim is a *window*, not a flag: let it expire without any further panel request.
  await new Promise((resolve) => setTimeout(resolve, 1700));
  const expired = await readAll();
  check('前台窗口 1.5s 过期后 foreground.active=false（切换标签/关面板的等价条件）',
    expired.foreground.active === false, expired.foreground, { active: false });
  await expectRefusal({ action: 'draw', shapes: [rectShape] }, 'ANNOTATION_NOT_FOREGROUND', '窗口过期后 draw 再次被拒');
  check('过期被拒零写入：revision 与画布内容不变',
    (await readAll()).revision === expired.revision, null, expired.revision);

  /* ------------------------------------------------------------------ 11. panel wiring (static) */
  // The Host contract above is proven end-to-end, but the *panel* half is what raises the claim.
  // These are source-level assertions on client.js: they cannot prove the GUI really sent it (that
  // needs a private isolated DSH), they only prevent the wiring from silently disappearing.
  const clientSource = await readFile(new URL('../../client.js', import.meta.url), 'utf8');
  check('client.js：前台心跳头只在 guiForegroundActive() 为真时附加（不是无条件发送）',
    /if \(guiForegroundActive\(\)\) headers\['X-UI-Testing-Gui-Foreground'\] = '1';/u.test(clientSource),
    'header guarded', 'guarded');
  check('client.js：声明集合为空或页面隐藏时不算前台（切走后自动失效）',
    /if \(guiForegroundClaims\.size === 0\) return false;/u.test(clientSource)
      && /document\.visibilityState === 'hidden'\) return false;/u.test(clientSource),
    'claim gating', 'gated');
  check('client.js：声明由挂载时的 visible 驱动，并在卸载时撤销',
    /guiForegroundClaims\.add\(claim\)/u.test(clientSource)
      && /return \(\) => guiForegroundClaims\.delete\(claim\);/u.test(clientSource),
    'claim lifecycle', 'add/remove');

  const report = {
    suite: 'annotation-agent',
    startedAt: new Date().toISOString(),
    checks: checks.length,
    passed: checks.length,
    failed: 0,
    criteria: `${checks.length}/${checks.length}`,
    requiredChecks: `${checks.length}/${checks.length}`,
    failedChecks: 0,
    notRunChecks: [
      '真实 GUI 是否真的发出了前台心跳，以及切换标签/关闭面板后是否真的在 1.5s 内过期（需要私有隔离 DSH + 真面板；本套件用面板同一条 scoped HTTP 通道注入声明，另有 3 条 client.js 源码级断言兜底）',
      '面板自身标注模式的像素渲染（annotation-capture.mjs 覆盖）',
      '多面板同时显示同一 workspace 时的声明合并',
      '宿主重启/重载后新工具才可见（index.js 与 client.js 均改动，未重启的实例不会出现 browser_annotation）',
    ],
    evidence: { overlay: join(runDir, 'agent-annotation.png') },
  };
  await writeFile(join(runDir, 'report.json'), JSON.stringify(report, null, 2));
  console.log(`\nPASSED ${checks.length}/${checks.length} checks`);
} catch (error) {
  /* ------------------------------------------------------------------ 11. panel wiring (static) */
  // The Host contract above is proven end-to-end, but the *panel* half is what raises the claim.
  // These are source-level assertions on client.js: they cannot prove the GUI really sent it (that
  // needs a private isolated DSH), they only prevent the wiring from silently disappearing.
  const clientSource = await readFile(new URL('../../client.js', import.meta.url), 'utf8');
  check('client.js：前台心跳头只在 guiForegroundActive() 为真时附加（不是无条件发送）',
    /if \(guiForegroundActive\(\)\) headers\['X-UI-Testing-Gui-Foreground'\] = '1';/u.test(clientSource),
    'header guarded', 'guarded');
  check('client.js：声明集合为空或页面隐藏时不算前台（切走后自动失效）',
    /if \(guiForegroundClaims\.size === 0\) return false;/u.test(clientSource)
      && /document\.visibilityState === 'hidden'\) return false;/u.test(clientSource),
    'claim gating', 'gated');
  check('client.js：声明由挂载时的 visible 驱动，并在卸载时撤销',
    /guiForegroundClaims\.add\(claim\)/u.test(clientSource)
      && /return \(\) => guiForegroundClaims\.delete\(claim\);/u.test(clientSource),
    'claim lifecycle', 'add/remove');

  const report = {
    suite: 'annotation-agent', startedAt: new Date().toISOString(), checks: checks.length, passed: checks.length,
    failed: 1, criteria: `${checks.length}/${checks.length + 1}`, failedChecks: 1,
    error: { message: String(error && error.message || error), stack: String(error && error.stack || '') },
  };
  await mkdir(runDir, { recursive: true });
  await writeFile(join(runDir, 'report.json'), JSON.stringify(report, null, 2));
  console.error('\nFAILED after', checks.length, 'checks:', error && error.message);
  process.exitCode = 1;
} finally {
  try { await harness.dispose?.(); } catch { /* best effort */ }
  await new Promise((resolve) => server.close(resolve));
}
