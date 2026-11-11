import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const source = readFileSync(new URL('../../client.js', import.meta.url), 'utf8');
const block = source.slice(source.indexOf('      const PAGE_CURSOR_KEYWORDS ='),
  source.indexOf('      /** 不支持浮层的形态'));

// Execute the actual preview handler with a controlled clock and delayed Host replies.
function panel() {
  let now = 1000, serial = 0, cursor = 'auto';
  const timers = new Map(), calls = [], effects = [];
  const ref = (current) => ({ current });
  const context = vm.createContext({
    React: { useRef: ref, useEffect: (fn) => effects.push(fn) },
    Date: { now: () => now },
    window: {
      setTimeout: (fn, ms) => { const id = ++serial; timers.set(id, { fn, at: now + ms }); return id; },
      clearTimeout: (id) => timers.delete(id),
    },
    setFrameCursor: (value) => { cursor = value; },
    visibleRef: ref(true), readyRef: ref(true), writesPausedRef: ref(false),
    annotRef: ref({ on: false }), pickRef: ref({ on: false }), panModeRef: ref(false),
    panDragRef: ref({ active: false }), dragRef: ref({ active: false }),
    scopeEpochRef: ref(1), scopeRef: ref({ id: 'A' }), abortRef: ref(null),
    hoverAtRef: ref(0), panMode: false,
    inputGeomReady: () => true, canvasBarrier: () => ({ ready: true }),
    frameGeometry: () => ({}),
    mapEventPoint: (event) => ({ inside: true, blank: event.clientX < 0,
      q: { x: event.clientX, y: event.clientY }, x: event.clientX, y: event.clientY }),
    canvasPosition: () => ({ x: 0, y: 951 }),
    docKey: 'doc1', canvasKey: '0|951|1',
    selectPopDocument: () => context.docKey, selectPopCanvas: () => context.canvasKey,
    visible: true, ready: true, identity: { paused: false }, scopeEpoch: 1, annotOn: false, pickOn: false,
    sendEvents: () => {},
    callHost: (op, body, options) => new Promise((resolve, reject) => calls.push({ op, body, options, resolve, reject })),
  });
  vm.runInContext(block, context);
  return {
    context, calls, effects, timers,
    cursor: () => cursor,
    move: (x, y = 600) => context.onFramePointerMove({ clientX: x, clientY: y, pointerId: 1 }),
    leave: () => context.resetFrameCursor(),
    tick(ms) {
      const end = now + ms;
      while (true) {
        const entry = [...timers.entries()].filter(([, t]) => t.at <= end).sort((a, b) => a[1].at - b[1].at)[0];
        if (!entry) break;
        const [id, timer] = entry; timers.delete(id); now = timer.at; timer.fn();
      }
      now = end;
    },
    async reply(index, value) { calls[index].resolve({ element: { cursor: value } }); await Promise.resolve(); await Promise.resolve(); },
  };
}

test('five fixture cursor values map to allowed CSS; custom URL never reaches the style', () => {
  const p = panel();
  for (const value of ['default', 'pointer', 'text', 'grab']) assert.equal(p.context.pageCursorKeyword(value), value);
  assert.equal(p.context.pageCursorKeyword('url(data:image/svg+xml,red-cross) 12 12, auto'), 'auto');
});

test('fast pointer → text then stop: trailing query targets the last position', async () => {
  const p = panel();
  p.move(203);
  await p.reply(0, 'pointer');
  p.tick(50); p.move(329);
  assert.equal(p.calls.length, 1);
  p.tick(70);
  assert.equal(p.calls.length, 2);
  assert.equal(p.calls[1].body.x, 329);
  assert.equal(p.calls[1].body.y, 1551, 'cursor probe uses document coordinates after scrolling');
  await p.reply(1, 'text');
  assert.equal(p.cursor(), 'text');
});

test('moves inside one throttle window coalesce to one trailing query', () => {
  const p = panel();
  p.move(203); p.tick(20); p.move(329); p.tick(20); p.move(455); p.tick(80);
  assert.equal(p.calls.length, 2);
  assert.equal(p.calls[1].body.x, 455);
  assert.equal(p.timers.size, 0);
});

test('a response for the previous position cannot override the pending latest position', async () => {
  const p = panel();
  p.move(203); p.tick(50); p.move(329);
  await p.reply(0, 'pointer');
  assert.equal(p.cursor(), 'auto');
  p.tick(70); await p.reply(1, 'text');
  assert.equal(p.cursor(), 'text');
});

for (const exit of ['leave', 'blank']) {
  test(`${exit}: cancel trailing timer and ignore a late response`, async () => {
    const p = panel();
    p.move(203); p.tick(50); p.move(329);
    if (exit === 'leave') p.leave(); else p.move(-1);
    await p.reply(0, 'pointer'); p.tick(1000);
    assert.equal(p.cursor(), 'auto');
    assert.equal(p.calls.length, 1);
    assert.equal(p.timers.size, 0);
  });
}

test('trailing query re-reads geometry instead of retaining the earlier document coordinates', () => {
  const p = panel();
  p.move(203); p.tick(50); p.move(329);
  p.context.mapEventPoint = () => ({ inside: true, blank: false, q: { x: 42, y: 100 } });
  p.context.canvasPosition = () => ({ x: 10, y: 200 });
  p.tick(70);
  assert.equal(p.calls[1].body.x, 52);
  assert.equal(p.calls[1].body.y, 300);
});

for (const change of ['scope', 'document', 'canvas', 'annotation', 'picker', 'pan', 'hidden']) {
  test(`${change}: response from an obsolete context is ignored`, async () => {
    const p = panel(); p.move(203);
    if (change === 'scope') p.context.scopeEpochRef.current++;
    if (change === 'document') p.context.docKey = 'doc2';
    if (change === 'canvas') p.context.canvasKey = '0|500|1';
    if (change === 'annotation') p.context.annotRef.current.on = true;
    if (change === 'picker') p.context.pickRef.current.on = true;
    if (change === 'pan') p.context.panModeRef.current = true;
    if (change === 'hidden') p.context.visibleRef.current = false;
    await p.reply(0, 'pointer');
    assert.equal(p.cursor(), 'auto');
  });
}

test('lifecycle cleanup cancels pending work and invalidates an in-flight query', async () => {
  const p = panel();
  const cleanup = p.effects[0]();
  p.move(203); p.tick(50); p.move(329); cleanup();
  await p.reply(0, 'grab'); p.tick(1000);
  assert.equal(p.cursor(), 'auto'); assert.equal(p.calls.length, 1); assert.equal(p.timers.size, 0);
});

test('a brief frame barrier retains the final hover and retries after sync', async () => {
  const p = panel();
  p.move(203); await p.reply(0, 'pointer'); p.tick(50);
  p.context.inputGeomReady = () => false;
  p.move(329); p.tick(70);
  assert.equal(p.calls.length, 1);
  p.context.inputGeomReady = () => true;
  p.tick(120);
  assert.equal(p.calls.length, 2); assert.equal(p.calls[1].body.x, 329);
  await p.reply(1, 'text'); assert.equal(p.cursor(), 'text');
});

test('a replacement image without decoded dimensions does not lose the final hover', async () => {
  const p = panel();
  p.move(203); p.tick(50); p.move(329);
  p.context.frameGeometry = () => null;
  p.tick(70); assert.equal(p.calls.length, 1);
  p.context.frameGeometry = () => ({});
  p.tick(120); assert.equal(p.calls.length, 2);
  await p.reply(1, 'text'); assert.equal(p.cursor(), 'text');
});

test('a permanently closed frame barrier stops retrying after the bounded window', () => {
  const p = panel();
  p.context.inputGeomReady = () => false;
  p.move(329); p.tick(1200);
  assert.equal(p.calls.length, 0); assert.equal(p.timers.size, 0); assert.equal(p.cursor(), 'auto');
});

test('failed current query restores the fallback cursor', async () => {
  const p = panel(); p.move(203); await p.reply(0, 'pointer');
  p.tick(120); p.move(329); p.calls[1].reject(new Error('unavailable'));
  await Promise.resolve(); await Promise.resolve();
  assert.equal(p.cursor(), 'auto');
});
