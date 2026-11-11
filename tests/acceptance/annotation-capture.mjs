#!/usr/bin/env node
/** Real Chromium: optional screenshot overlays, using the actual panel SVG renderer as oracle. */
import assert from 'node:assert/strict';
import http from 'node:http';
import { randomUUID, createHash } from 'node:crypto';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createHarness, createFakeConnectionService } from './harness.mjs';
import { decodePng } from '../../capture-p0.js';

const runDir = join(import.meta.dirname, 'runs', `annotation-capture-${new Date().toISOString().replace(/[:.]/g, '-')}-${process.pid}`);
await mkdir(runDir, { recursive: true });
const checks = [];
const check = (condition, label) => { assert.ok(condition, label); checks.push(label); console.log('PASS', checks.length, label); };
const server = http.createServer((req, res) => {
  res.setHeader('Content-Security-Policy', "default-src 'none'; img-src 'none'; style-src 'unsafe-inline'; script-src 'none'");
  res.end('<!doctype html><style>html,body{margin:0;background:#e8eef5;width:2400px;height:3000px}#marker{position:fixed;left:10px;top:10px;width:20px;height:20px;background:#123456}</style><div id="marker"></div><input id="focus">');
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const saved = [];
const harness = await createHarness({ name: 'annotation-capture', connection: createFakeConnectionService({
  rejection: undefined, admit: () => ({ peer: { id: 'annotation-test-peer' } }), browserPeer: { id: 'annotation-test-peer' },
}), attachments: {
  async saveImage({ data }) {
    saved.push(Buffer.from(data));
    const png = decodePng(data);
    return { attachmentId: randomUUID(), mediaType: 'image/png', bytes: data.length, width: png.width, height: png.height };
  },
} });
const exec = { agent: { id: 'annotation-capture-agent', session: { header: { cwd: harness.workspaceDir } } } };
const call = async (name, args = {}) => {
  const result = await harness.invoke(name, args, exec);
  if (result.threw) throw new Error(result.error.message);
  return result.value;
};
const capture = args => call('browser_screenshot', args);
const pixel = (image, x, y) => {
  const n = (y * image.width + x) * image.channels;
  return [...image.data.subarray(n, n + 3)];
};
const pngOf = result => decodePng(Buffer.from(result.image, 'base64'));
const common = { color: '#ff0000', strokeWidth: 4, fill: false, stroke: true };
const shapes = [
  { ...common, id: 'a1', type: 'rect', x: 70, y: 60, width: 90, height: 55 },
  { ...common, id: 'a2', type: 'circle', cx: 230, cy: 100, rx: 45, ry: 30, fill: true, stroke: false, color: '#00aa44' },
  { ...common, id: 'a3', type: 'line', x1: 60, y1: 160, x2: 150, y2: 190, color: '#2222ff' },
  { ...common, id: 'a4', type: 'arrow', x1: 210, y1: 160, x2: 290, y2: 195, head: { length: 12, width: 8 } },
  { ...common, id: 'a5', type: 'brush', points: [[60, 250], [85, 225], [110, 260], [135, 230]], color: '#aa00aa' },
  { ...common, id: 'a6', type: 'text', fill: true, stroke: false, x: 190, y: 240, fontSize: 20, text: '标注 ABC <&> 你好', color: '#222222' },
  { ...common, id: 'a7', type: 'rect', x: 330, y: 60, width: 70, height: 55, fill: true, color: '#ff8800' },
  { ...common, id: 'a8', type: 'rect', x: 350, y: 75, width: 70, height: 55, fill: true, color: '#3366ff' },
];
let runtime;
let revision = 0;
const publish = async (items = shapes) => {
  const v = runtime.view;
  const response = await harness.request({
    method: 'POST', path: '/plugins/ui-testing/annotations',
    headers: { 'x-ui-testing-scope-version': '1', 'x-ui-testing-session-id': exec.agent.id },
    body: {
      version: 1, panelId: '11111111-1111-4111-8111-111111111111', surface: 'main', clientRevision: ++revision,
      context: runtime.annotationContext(), view: {
        canvasX: v.canvasX, canvasY: v.canvasY, x: v.x, y: v.y, width: v.width, height: v.height,
        scale: v.scale, contentWidth: null, contentHeight: null, viewRevision: v.revision, frameEpoch: null,
      }, shapes: items,
      truncation: { droppedShapes: 0, droppedPoints: 0, shortenedTextCodeUnits: 0 },
    },
  });
  assert.equal(response.statusCode, 200, `panel publish must pass wire validation: ${JSON.stringify(response.json)}`);
  return response.json;
};
try {
  // Invalid arguments must fail before a browser starts.
  for (const invalid of [null, 'true', 1, {}]) {
    const result = await harness.invoke('browser_screenshot', { includeAnnotations: invalid }, exec);
    check(result.threw && result.error.code === 'INVALID_ARGUMENT', `invalid includeAnnotations ${JSON.stringify(invalid)} refused`);
  }
  check(!harness.ctx.__internal.plugin.registry.pageCount, 'invalid input starts no browser');
  const url = `http://127.0.0.1:${server.address().port}/`;
  await call('browser_navigate', { url });
  runtime = [...harness.ctx.__internal.plugin.registry.entries.values()].find(entry => entry.runtime.running).runtime;
  await call('browser_viewport', { action: 'set', width: 500, height: 340, x: 0, y: 0 });
  const empty = await capture({ includeAnnotations: true });
  check(empty.capture.annotations.shapeCount === 0 && !empty.capture.annotations.composited, 'empty overlay reports zero shapes');
  const raw = await capture({});
  await publish();
  const before = await runtime.evaluate('({html:document.documentElement.outerHTML,scroll:[scrollX,scrollY],active:document.activeElement.tagName})');
  const annotated = await capture({ includeAnnotations: true, out: 'annotation.png' });
  const after = await runtime.evaluate('({html:document.documentElement.outerHTML,scroll:[scrollX,scrollY],active:document.activeElement.tagName})');
  check(JSON.stringify(before.value) === JSON.stringify(after.value), 'overlay leaves target DOM, focus and scroll unchanged under strict CSP');
  check(runtime.host.pageCount === 1, 'overlay creates no extra browser tab');
  check(annotated.capture.annotations.composited && annotated.capture.annotations.shapeCount === shapes.length, 'accepted six shape types composited');
  check(annotated.capture.annotations.source.trusted === false && annotated.capture.annotations.revision === runtime.annot.revision, 'revision and untrusted source recorded');
  check(annotated.capture.annotations.context.documentKey === runtime.annotationContext().documentKey, 'overlay identity matches captured document');
  const composed = pngOf(annotated);
  check(pixel(composed, 70, 80).join() === '255,0,0', 'red rectangle stroke visible');
  check(pixel(composed, 230, 100).join() === '0,170,68', 'filled ellipse visible');
  check(pixel(composed, 85, 225).join() === '170,0,170', 'wire-format brush point renders a visible purple stroke');
  check(pixel(composed, 360, 90).join() === '51,102,255', 'shape order preserved');
  check(saved.at(-1).equals(Buffer.from(annotated.image, 'base64')), 'attachment is composited PNG');
  const written = await readFile(join(process.env.DSH_UI_TESTING_CAPTURE_DIR, 'annotation.png'));
  check(written.equals(Buffer.from(annotated.image, 'base64')) && createHash('sha256').update(written).digest('hex') === annotated.sha256, 'file, image and hash all identify composited PNG');
  await writeFile(join(runDir, 'annotated.png'), written);
  const disabled = await capture({ includeAnnotations: false });
  check(disabled.image === raw.image && disabled.capture.annotations === null, 'explicit false preserves raw screenshot pixels and bytes');
  check((await capture({})).image === raw.image, 'omitted flag preserves default screenshot bytes');
  const rawT3 = await call('browser_vision_image', {});
  check(rawT3.sha256 === raw.sha256, 'T3 live source remains raw');

  // Render the actual client SVG in the fixture solely as an independent pixel oracle.
  const client = await readFile(new URL('../../client.js', import.meta.url), 'utf8');
  const fn = name => {
    const start = client.indexOf(`function ${name}(`);
    const end = client.indexOf('\n      }', start) + '\n      }'.length;
    assert.ok(start >= 0 && end > start, `panel renderer ${name} located`);
    return client.slice(start, end);
  };
  const oracle = `(()=>{const h=(tag,props,...children)=>{const n=document.createElementNS('http://www.w3.org/2000/svg',tag);for(const [k,v] of Object.entries(props||{})){if(k==='key'||k==='style')continue;n.setAttribute(k.replace(/[A-Z]/g,c=>'-'+c.toLowerCase()),v)}for(const c of children.flat(Infinity)){if(c==null)continue;n.append(typeof c==='object'?c:document.createTextNode(c))}return n};${fn('annotArrowGeometry')};${fn('annotPointsText')};${fn('renderAnnotShape')};const svg=h('svg',{width:500,height:340,viewBox:'0 0 500 340'});svg.id='oracle';Object.assign(svg.style,{position:'absolute',left:0,top:0});for(const s of ${JSON.stringify(shapes)})svg.append(renderAnnotShape({...s,w:s.width,h:s.height,points:s.type==='brush'?s.points.map(([x,y])=>({x,y})):s.points}));document.body.append(svg);return true})()`;
  await runtime.evaluate(oracle);
  const reference = await capture({});
  await writeFile(join(runDir, 'panel-svg.png'), Buffer.from(reference.image, 'base64'));
  const expected = pngOf(reference);
  let differs = 0, maxDelta = 0;
  const regions = { geometry: { y1: 0, y2: 220 }, textAndBrush: { y1: 220, y2: 300 } };
  for (let y = 0; y < expected.height; y++) for (let x = 0; x < expected.width; x++) {
    const a = pixel(composed, x, y), b = pixel(expected, x, y);
    const delta = Math.max(...a.map((value, i) => Math.abs(value - b[i])));
    if (delta > 12) differs++;
    maxDelta = Math.max(maxDelta, delta);
  }
  const diffRatio = differs / (expected.width * expected.height);
  console.log('Panel SVG comparison:', { differs, diffRatio, maxDelta });
  check(diffRatio < 0.002, 'overlay agrees with actual panel SVG raster (<0.2% pixels delta >12)');
  for (const [name, region] of Object.entries(regions)) {
    let changed = 0;
    for (let y = region.y1; y < region.y2; y++) for (let x = 40; x < 450; x++) {
      const a = pixel(composed, x, y), b = pixel(expected, x, y);
      if (Math.max(...a.map((value, i) => Math.abs(value - b[i]))) > 12) changed++;
    }
    check(changed < 150, `panel SVG ${name} raster aligned`);
  }
  await runtime.evaluate("document.getElementById('oracle').remove();true");
  const cropped = await capture({ includeAnnotations: true, region: { x: 50, y: 50, width: 400, height: 250 }, scale: 1.5 });
  check(cropped.capture.png.width === 600 && cropped.capture.png.height === 375, 'region and fractional scale dimensions preserved');
  check(pixel(pngOf(cropped), 30, 45).join() === '255,0,0', 'annotation crop origin and fractional scale align');
  await call('browser_viewport', { action: 'set', x: 40, y: 40 });
  check(pixel(pngOf(await capture({ includeAnnotations: true })), 30, 40).join() === '255,0,0', 'annotation uses current scroll, not published view');
  await publish([{ ...common, id: 'a9', type: 'rect', x: -50, y: -30, width: 30, height: 20, fill: true }]);
  await call('browser_viewport', { action: 'set', canvasX: -80, canvasY: -50 });
  check(pixel(pngOf(await capture({ includeAnnotations: true })), 35, 25).join() === '255,0,0', 'annotation visible on negative canvas blank');
  runtime.annot.lastSeenAt = 1;
  runtime.annot.document.updatedAt = 1;
  const stale = await capture({ includeAnnotations: true });
  check(stale.capture.annotations.stale && stale.capture.annotations.staleReason === 'panel-unseen' && stale.capture.annotations.composited, 'stale heartbeat disclosed without discarding accepted shapes');
  await runtime.navigate(url + '?new');
  const cleared = await capture({ includeAnnotations: true });
  check(cleared.capture.annotations.shapeCount === 0 && !cleared.capture.annotations.composited, 'navigation clears old overlay');
  const caps = await call('browser_capabilities');
  check(caps.annotations.screenshotOverlay && caps.annotations.screenshotParameter === 'includeAnnotations', 'capabilities advertise screenshot overlay');
  const def = harness.tools.get('browser_screenshot');
  check(def.parameters.properties.includeAnnotations.type === 'boolean', 'tool schema exposes optional boolean');
  await publish(shapes);
  const frozenRevision = runtime.annot.revision;
  const originalSend = runtime.send;
  try {
    let replaced = false;
    runtime.send = async function(method, args, signal) {
      if (!replaced && method === 'Runtime.evaluate' && args.expression?.includes('renderAnnotationOverlay')) {
        replaced = true;
        await publish([]);
      }
      return originalSend.call(this, method, args, signal);
    };
    const frozen = await capture({ includeAnnotations: true });
    check(frozen.capture.annotations.revision === frozenRevision
      && frozen.capture.annotations.shapeCount === shapes.length && runtime.annotationsDocument().shapes.length === 0,
    'concurrent panel edit cannot mix annotation revisions during capture');
  } finally { runtime.send = originalSend; }
  await publish(shapes);
  const originalKey = runtime.annot.documentKey;
  const attachmentCount = saved.length;
  try {
    runtime.send = async function(method, args, signal) {
      const result = await originalSend.call(this, method, args, signal);
      if (method === 'Page.captureScreenshot') runtime.annot.documentKey = randomUUID();
      return result;
    };
    const changed = await harness.invoke('browser_screenshot', { includeAnnotations: true }, exec);
    check(changed.threw && changed.error.code === 'CAPTURE_FAILED'
      && changed.error.details.reason === 'annotation-context-changed' && saved.length === attachmentCount,
    'document switch during capture refuses mismatched image without delivery');
  } finally { runtime.send = originalSend; runtime.annot.documentKey = originalKey; }
  const oldEpoch = runtime.annot.document.context.documentEpoch;
  runtime.annot.document.context.documentEpoch = oldEpoch - 1;
  const oldDocument = await harness.invoke('browser_screenshot', { includeAnnotations: true }, exec);
  runtime.annot.document.context.documentEpoch = oldEpoch;
  check(oldDocument.threw && oldDocument.error.code === 'CAPTURE_FAILED', 'annotation from another document epoch fails closed');
  await writeFile(join(runDir, 'report.json'), JSON.stringify({ status: 'PASS', checks, panelComparison: { differs, diffRatio, maxDelta } }, null, 2));
  console.log(`annotation-capture: ${checks.length}/${checks.length} PASS; evidence ${runDir}`);
} catch (error) {
  await writeFile(join(runDir, 'report.json'), JSON.stringify({ status: 'FAIL', checks, error: String(error.stack || error) }, null, 2));
  throw error;
} finally {
  await harness.dispose();
  await new Promise(resolve => server.close(resolve));
}
