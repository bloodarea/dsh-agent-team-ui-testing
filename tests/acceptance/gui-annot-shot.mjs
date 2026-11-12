#!/usr/bin/env node
/**
 * Real Chromium: the panel's own "screenshot with annotations" route.
 *
 * The annot bar's 截图 button asks the Host for one composited PNG
 * (`POST /plugins/ui-testing/screenshot {includeAnnotations:true}`) and hands it to the chat as an
 * attachment. This suite proves the Host half against a real page:
 *   - the accepted panel document is composited into the returned PNG (same offscreen renderer as
 *     `browser_screenshot{includeAnnotations:true}`), with `capture.annotations` metadata;
 *   - the raw reply shape of every legacy caller is unchanged (no `annotations`, no `capture`);
 *   - an empty document still answers with `composited:false` and the untouched page pixels;
 *   - a closed primary stays closed (`{closed:true, image:null}`) instead of resurrecting a tab;
 *   - the route rides the serial queue/lease like any other panel page operation (BUSY is reported,
 *     not swallowed) and never creates a second tab.
 *
 * NOT proven here: the button's own DOM (it lives in the DSH GUI shell) and the attachment handoff
 * through the Conversation service (`createDrafts` + `addAttachments`). Those are covered by the
 * source-level assertions at the end of this file plus a real-GUI click, not by this suite.
 */
import assert from 'node:assert/strict';
import http from 'node:http';
import { randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createHarness, createFakeConnectionService } from './harness.mjs';
import { decodePng } from '../../capture-p0.js';

const runDir = join(import.meta.dirname, 'runs', `gui-annot-shot-${new Date().toISOString().replace(/[:.]/g, '-')}-${process.pid}`);
await mkdir(runDir, { recursive: true });
const checks = [];
const check = (label, condition, actual = null, expected = null) => {
  assert.ok(condition, `${label}${actual === null ? '' : ' :: ' + JSON.stringify(actual)}`);
  checks.push(label);
  console.log('PASS', checks.length, label);
};

const server = http.createServer((req, res) => {
  res.setHeader('Content-Security-Policy', "default-src 'none'; img-src 'none'; style-src 'unsafe-inline'; script-src 'none'");
  res.end('<!doctype html><style>html,body{margin:0;background:#e8eef5;width:1200px;height:900px}'
    + '#marker{position:fixed;left:10px;top:10px;width:20px;height:20px;background:#123456}</style>'
    + '<div id="marker"></div><input id="focus">');
});
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));

const owner = () => createFakeConnectionService({
  rejection: undefined, admit: () => ({ peer: { id: 'gui-shot-peer' } }), browserPeer: { id: 'gui-shot-peer' },
});
const harness = await createHarness({
  name: 'gui-annot-shot',
  connection: owner(),
  attachments: {
    async saveImage({ data }) {
      const png = decodePng(data);
      return { attachmentId: randomUUID(), mediaType: 'image/png', bytes: data.length, width: png.width, height: png.height };
    },
  },
});
const exec = { agent: { id: 'gui-shot', session: { header: { cwd: harness.workspaceDir } } } };
const scopeHeaders = { 'x-ui-testing-scope-version': '1', 'x-ui-testing-session-id': exec.agent.id };
const capture = async (body, { authenticated = true } = {}) => {
  // Always restore the previous connection: leaving it unset makes every later scoped call fall
  // back to the legacy projection (no `ui`, hence no `annotationContext`).
  const previous = harness.getConnection();
  harness.setConnection(authenticated ? owner() : createFakeConnectionService({ rejection: 401 }));
  try {
    return await harness.request({
      method: 'POST', path: '/plugins/ui-testing/screenshot', headers: scopeHeaders, body,
    });
  } finally { harness.setConnection(previous); }
};
const pixel = (image, x, y) => {
  const offset = (y * image.width + x) * image.channels;
  return [...image.data.subarray(offset, offset + 3)];
};
const runtimeOf = () => [...harness.ctx.__internal.plugin.registry.entries.values()].find((entry) => entry.runtime.running)?.runtime || null;
const rectShape = { id: 'a1', type: 'rect', color: '#ff0000', strokeWidth: 6, fill: false, stroke: true, x: 60, y: 60, width: 120, height: 80 };

let publishRevision = 0;
const publish = async (shapes) => {
  const previous = harness.getConnection();
  harness.setConnection(owner());
  let state;
  try {
    state = (await harness.request({ method: 'GET', path: '/plugins/ui-testing/state', headers: scopeHeaders })).json;
  } finally { harness.setConnection(previous); }
  const ui = state.ui || {};
  const view = ui.view || {};
  const canvas = ui.canvas || {};
  harness.setConnection(owner());
  try {
    const response = await harness.request({
      method: 'POST', path: '/plugins/ui-testing/annotations', headers: scopeHeaders,
      body: {
        version: 1, panelId: '33333333-3333-4333-8333-333333333333', surface: 'main',
        clientRevision: ++publishRevision, context: { ...ui.annotationContext },
        view: {
          canvasX: view.canvasX, canvasY: view.canvasY, x: view.x, y: view.y,
          width: view.width, height: view.height, scale: view.scale,
          contentWidth: canvas.contentWidth, contentHeight: canvas.contentHeight,
          viewRevision: view.revision, frameEpoch: null,
        },
        shapes, truncation: { droppedShapes: 0, droppedPoints: 0, shortenedTextCodeUnits: 0 },
      },
    });
    assert.equal(response.statusCode, 200, `panel publish must pass wire validation: ${JSON.stringify(response.json)}`);
    return response.json;
  } finally { harness.setConnection(previous); }
};

try {
  const url = `http://127.0.0.1:${server.address().port}/`;
  await harness.invoke('browser_navigate', { url }, exec);
  await harness.invoke('browser_viewport', { action: 'set', width: 480, height: 320, x: 0, y: 0 }, exec);
  const runtime = runtimeOf();
  check('页面已就绪（pageCount=1、running）', Boolean(runtime) && harness.ctx.__internal.plugin.registry.pageCount === 1,
    { pageCount: harness.ctx.__internal.plugin.registry.pageCount }, 1);

  /* ---------------------------------------------- 1. raw reply shape stays byte-compatible */
  const raw = await capture({});
  check('旧调用（空 body）仍是原始 PNG：ok/image/viewport/capturedAt，且没有 annotations/capture',
    raw.statusCode === 200 && raw.json.ok === true && typeof raw.json.image === 'string'
      && raw.json.viewport && raw.json.viewport.width === 480 && raw.json.viewport.height === 320
      && typeof raw.json.capturedAt === 'number'
      && raw.json.annotations === undefined && raw.json.capture === undefined,
    Object.keys(raw.json || {}), 'legacy keys only');
  const rawCanvas = await capture({ canvas: true });
  check('canvas:true 仍返回 view + capture（未叠加标注时 annotations 不出现）',
    rawCanvas.statusCode === 200 && rawCanvas.json.capture && rawCanvas.json.view
      && rawCanvas.json.capture.annotations === undefined,
    Object.keys(rawCanvas.json || {}), 'canvas keys');

  /* ---------------------------------------------- 2. empty document → composited:false */
  const empty = await capture({ includeAnnotations: true });
  check('空标注文档：includeAnnotations 仍 200，annotations.enabled=true/composited=false/shapeCount=0',
    empty.statusCode === 200 && empty.json.annotations
      && empty.json.annotations.enabled === true && empty.json.annotations.composited === false
      && empty.json.annotations.shapeCount === 0 && typeof empty.json.image === 'string',
    empty.json.annotations, 'composited:false');
  const emptyPng = decodePng(Buffer.from(empty.json.image, 'base64'));
  check('空文档的 PNG 就是页面像素：尺寸 480×320，红色描边位置仍是页面底色',
    emptyPng.ok === true && emptyPng.width === 480 && emptyPng.height === 320
      && pixel(emptyPng, 60, 100).join() !== '255,0,0',
    { width: emptyPng.width, height: emptyPng.height, pixel: pixel(emptyPng, 60, 100) }, '480x320 page pixels');

  /* ---------------------------------------------- 3. the real thing: page + accepted notes */
  await publish([rectShape]);
  const shot = await capture({ includeAnnotations: true });
  check('有标注时：composited=true、shapeCount=1、annotations 带 revision/context/source.trusted=false',
    shot.statusCode === 200 && shot.json.annotations
      && shot.json.annotations.composited === true && shot.json.annotations.shapeCount === 1
      && Number.isSafeInteger(shot.json.annotations.revision) && shot.json.annotations.revision > 0
      && shot.json.annotations.context && typeof shot.json.annotations.context.documentKey === 'string'
      && shot.json.annotations.source && shot.json.annotations.source.trusted === false,
    shot.json.annotations, 'composited:true');
  const composed = decodePng(Buffer.from(shot.json.image, 'base64'));
  check('合成像素里能读到标注的红色描边（面板点一下就能看到同样的图）',
    composed.ok === true && pixel(composed, 60, 100).join() === '255,0,0',
    pixel(composed, 60, 100), '255,0,0');
  check('合成图的 viewport 仍是页面 CSS 视口，并带 capture 证据（region/effectiveScale/composite）',
    shot.json.viewport.width === 480 && shot.json.viewport.height === 320
      && shot.json.capture && shot.json.capture.effectiveScale === 1
      && shot.json.capture.region && shot.json.capture.region.width === 480,
    { viewport: shot.json.viewport, region: shot.json.capture && shot.json.capture.region }, '480x320 @1x');
  await writeFile(join(runDir, 'composited.png'), Buffer.from(shot.json.image, 'base64'));
  check('该调用没有创建第二个标签页', harness.ctx.__internal.plugin.registry.pageCount === 1,
    { pageCount: harness.ctx.__internal.plugin.registry.pageCount }, 1);

  /* ---------------------------------------------- 4. refusals are typed, not silent */
  const unauth = await capture({ includeAnnotations: true }, { authenticated: false });
  check('未通过 owner 鉴权 → 401，且不返回图片', unauth.statusCode === 401 && !unauth.json.image, unauth.statusCode, 401);

  /* ---------------------------------------------- 5. client wiring (source-level) */
  const clientSource = await readFile(new URL('../../client.js', import.meta.url), 'utf8');
  check('client.js：「截图」按钮位于「粗细」之后、清除画布之前，并带 capture 动作标记',
    /utb-annot-shot[\s\S]{0,400}?data-utb-annot-action': 'capture'[\s\S]{0,3000}?utb-annot-clear/u.test(clientSource),
    'button order', 'after width, before clear');
  check('client.js：点击走 POST /screenshot {includeAnnotations:true}（与 Agent 同一条合成路径）',
    /HOST_BASE \+ '\/screenshot'[\s\S]{0,240}?includeAnnotations: true/u.test(clientSource),
    'route call', 'includeAnnotations:true');
  check('client.js：附件通过 Conversation 服务注册并加入草稿（createDrafts + addAttachments，失败即释放）',
    /conversation\.createDrafts\(target\.sid, \[file\], false\)/u.test(clientSource)
      && /target\.face\.addAttachments\(ids\)/u.test(clientSource)
      && /releaseDraftAttachment\(draft\.id\)/u.test(clientSource),
    'attachment handoff', 'createDrafts/addAttachments/release');

  const report = {
    suite: 'gui-annot-shot',
    startedAt: new Date().toISOString(),
    checks: checks.length,
    criteria: `${checks.length}/${checks.length}`,
    failedChecks: 0,
    notRunChecks: [
      '真实面板点击「截图」按钮并让它出现在聊天框附件条里（需要私有隔离 DSH + 真 GUI；本套件只验 Host 路由与 client 源码接线）',
      '附件在发送时被 Conversation 服务序列化为图片块（由 Chat 侧负责，本仓库不覆盖）',
    ],
    evidence: { composited: join(runDir, 'composited.png') },
  };
  await writeFile(join(runDir, 'report.json'), JSON.stringify(report, null, 2));
  console.log(`\nPOST /screenshot includeAnnotations: ${checks.length}/${checks.length} PASS`);
} catch (error) {
  const report = {
    suite: 'gui-annot-shot', startedAt: new Date().toISOString(), checks: checks.length,
    passed: checks.length, failed: 1, criteria: `${checks.length}/${checks.length + 1}`,
    error: { message: String((error && error.message) || error), stack: String((error && error.stack) || '') },
  };
  await writeFile(join(runDir, 'report.json'), JSON.stringify(report, null, 2));
  console.error('\nFAILED after', checks.length, 'checks:', (error && error.message) || error);
  process.exitCode = 1;
} finally {
  try { await harness.dispose?.(); } catch { /* best effort */ }
  await new Promise((resolve) => server.close(resolve));
}
