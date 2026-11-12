import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const source = readFileSync(new URL('../../client.js', import.meta.url), 'utf8');

// Component functions have a six-space closing brace. Fail loudly if extraction drifts;
// no selection, ACK reconciliation, serialization, or normalization is reimplemented here.
function actualFunction(name) {
  const marker = `      function ${name}(`;
  const start = source.indexOf(marker);
  assert.notEqual(start, -1, `missing actual client function ${name}`);
  assert.equal(source.indexOf(marker, start + marker.length), -1, `ambiguous function ${name}`);
  const end = source.indexOf('\n      }', start);
  assert.notEqual(end, -1, `missing closing brace for ${name}`);
  return source.slice(start, end + '\n      }'.length);
}

function actualConstant(name) {
  const match = source.match(new RegExp(`    const ${name} = [\\s\\S]*?;`));
  assert.ok(match, `missing actual client constant ${name}`);
  return match[0];
}

const executable = [
  ...['ANNOT_LIMITS', 'ANNOT_ID_PATTERN', 'ANNOT_PUBLISH_DEBOUNCE_MS'].map(actualConstant),
  ...[
    'annotHexColor', 'annotWireShape', 'annotWireToLocal', 'annotApplyImported', 'annotNormalize',
    'annotSetSyncState', 'annotSetStale', 'annotPublisherEvent', 'annotBuildSnapshot',
    'annotPublishSchedule', 'annotPublishNow', 'annotRetainDirty',
    'annotSelectionRefresh', 'annotSelectionScheduleRender', 'annotPruneSelection',
    'annotShapeBounds', 'annotArrowGeometry', 'annotTranslateShape', 'annotSelectionOrigin',
    'annotMapSignature', 'annotToCanvasRaw', 'annotStartMove', 'moveAnnotSelection',
    'finishAnnotMove', 'cancelAnnotMove',
  ].map(actualFunction),
].join('\n');

const plain = (value) => JSON.parse(JSON.stringify(value));
const style = { color: '#123456', strokeWidth: 3, fill: false, stroke: true };
const rect = (id, x, y, extra = {}) => ({ ...style, id, type: 'rect', x, y, width: 30, height: 40, ...extra });
const committed = () => [
  rect('a1', 10, 20),
  { ...style, id: 'a2', type: 'circle', cx: 50, cy: 60, rx: 10, ry: 12 },
  { ...style, id: 'a3', type: 'line', x1: 70, y1: 80, x2: 90, y2: 100 },
  { ...style, id: 'a4', type: 'arrow', x1: 110, y1: 120, x2: 140, y2: 150 },
  { ...style, id: 'a5', type: 'brush', points: [[160, 170], [180, 190], [200, 210]] },
  { ...style, id: 'a6', type: 'text', x: 220, y: 230, text: 'pending text', fill: true, stroke: false },
  rect('a7', 250, 260), // Selected locally, but removed from the Host's canonical document.
  rect('a8', 280, 290), // Unselected; canonical changes still need to be adopted.
];
const canonical = () => [
  rect('a1', 11, 21, { width: 31, color: '#abcdef' }),
  { ...style, id: 'a2', type: 'circle', cx: 51, cy: 61, rx: 9, ry: 11 },
  { ...style, id: 'a3', type: 'line', x1: 71, y1: 81, x2: 91, y2: 101 },
  { ...style, id: 'a4', type: 'arrow', x1: 111, y1: 121, x2: 141, y2: 151 },
  { ...style, id: 'a5', type: 'brush', points: [[161, 171], [201, 211]] },
  { ...style, id: 'a6', type: 'text', x: 221, y: 231, text: 'Host-clipped', fill: true, stroke: false },
  rect('a8', 281, 291, { height: 39 }),
];

function panel(shapes = committed()) {
  let serial = 0, allocation = 0;
  const timers = new Map(), frames = new Map();
  const queued = [], remembered = [], captured = [], released = [], identityReads = [];
  const ref = (current) => ({ current });
  const entry = { key: 'publisher', panelId: 'panel', surface: 'main' };
  const identity = { entry, dKey: 'document-A', context: { documentKey: 'A' },
    scope: { id: 'scope-A' }, view: { canvasX: 100, canvasY: 200, scale: 2 } };
  const context = vm.createContext({
    TextEncoder, ANNOT_DEFAULT: { color: '#ff3b30' },
    window: {
      setTimeout: (fn) => { const id = ++serial; timers.set(id, fn); return id; },
      clearTimeout: (id) => timers.delete(id),
      requestAnimationFrame: (fn) => { const id = ++serial; frames.set(id, fn); return id; },
      cancelAnimationFrame: (id) => frames.delete(id),
    },
    annotShapesRef: ref([]), annotSelectionRef: ref(new Set()), annotNextIdRef: ref(0),
    annotMoveRef: ref({ active: false }), annotMarqueeRef: ref({ active: false }),
    annotMapSigRef: ref(''), annotSelectionRafRef: ref(0),
    annotSvgRef: ref({ querySelector: () => null,
      setPointerCapture: (id) => captured.push(id), releasePointerCapture: (id) => released.push(id) }),
    annotDirtyRef: ref(true), annotContentSeqRef: ref(7), annotMountGenerationRef: ref(3),
    scopeEpochRef: ref(4), readyRef: ref(true), annotPublisherRef: ref(entry),
    annotGateRef: ref({ open: true, key: 'document-A', revision: 2 }),
    annotShownRevisionRef: ref(2), annotStaleRef: ref({ stale: false, staleReason: null }),
    annotSyncRef: ref({ timer: 0, state: 'pending' }),
    setAnnotVersion: () => {}, setAnnotSync: () => {}, setAnnotStaleState: () => {},
    setAnnotBusy: () => {}, annotSetHoverCursor: () => {},
    // Only rendering, lifecycle, and publisher/identity boundaries are stubbed.
    annotMaybeAdoptCandidate: () => {}, annotResumeAfterTransient: () => {},
    annotSetSelection: () => assert.fail('drag must not toggle selection'),
    annotIdentityNow: (options) => { identityReads.push(options); return identity; },
    annotViewSnapshot: () => identity.view,
    annotPublisherAllocate: () => ++allocation,
    annotPublisherQueue: (owner, snapshot) => queued.push({ owner, snapshot }),
    annotPublisherRemember: (owner, snapshot) => remembered.push({ owner, snapshot }),
  });
  vm.runInContext(executable, context, { filename: 'client.js:annotation-selection-extract' });
  context.annotApplyImported(shapes);
  context.annotSelectionRef.current = new Set(shapes.filter((shape) => shape.id !== 'a8').map((shape) => shape.id));
  return {
    context, queued, remembered, timers, frames, captured, released, identityReads,
    document: () => plain(context.annotNormalize().shapes),
    start(dx = 15, dy = -9) {
      const map = { painted: { left: 10, top: 20, width: 800, height: 600 },
        cx: 100, cy: 200, w: 400, h: 300, sx: 2, sy: 2 };
      assert.equal(context.annotStartMove(map, { pointerId: 17 }, { x: 100, y: 200 }), true);
      context.moveAnnotSelection({ pointerId: 17, clientX: 10 + dx * 2, clientY: 20 + dy * 2, shiftKey: false });
    },
    ack(snapshot, shapes = canonical(), revision = 12) {
      context.annotPublisherEvent({ type: 'ack', snapshot, annotations: {
        revision, shapes, stale: false, staleReason: null,
      } });
    },
    flushTimers() {
      for (const [id, fn] of [...timers]) { timers.delete(id); fn(); }
    },
  };
}

function pendingMove() {
  const p = panel();
  const snapshot = p.context.annotPublishNow(); // The previous edit is already in flight.
  p.start(); // Held pointer changes preview geometry, but not contentSeq.
  assert.equal(p.context.annotContentSeqRef.current, snapshot.contentSeq);
  return { p, snapshot };
}

test('same-seq ACK during a held move preserves preview and saves the canonical Host document', () => {
  const { p, snapshot } = pendingMove();
  const preview = p.context.annotShapesRef.current;
  const geometry = p.document();
  const accepted = canonical();
  p.ack(snapshot, accepted);
  assert.strictEqual(p.context.annotShapesRef.current, preview);
  assert.deepEqual(p.document(), geometry);
  assert.strictEqual(p.context.annotMoveRef.current.acceptedShapes, accepted);
  assert.equal(p.context.annotMoveRef.current.active, true);
  assert.equal(p.context.annotDirtyRef.current, false);
  assert.equal(p.context.annotShownRevisionRef.current, 12);
  assert.equal(p.context.annotGateRef.current.revision, 12);
  assert.equal(p.context.annotSyncRef.current.state, 'synced');
  assert.equal(p.queued.length, 1);
});

test('finish merges dx/dy into canonical geometry for all six types and never resurrects Host-dropped ids', () => {
  const { p, snapshot } = pendingMove();
  p.ack(snapshot);
  p.context.finishAnnotMove();
  const expected = [
    rect('a1', 26, 12, { width: 31, color: '#abcdef' }),
    { ...style, id: 'a2', type: 'circle', cx: 66, cy: 52, rx: 9, ry: 11 },
    { ...style, id: 'a3', type: 'line', x1: 86, y1: 72, x2: 106, y2: 92 },
    { ...style, id: 'a4', type: 'arrow', x1: 126, y1: 112, x2: 156, y2: 142, head: { length: 9, width: 6 } },
    { ...style, id: 'a5', type: 'brush', points: [[176, 162], [216, 202]] },
    { ...style, id: 'a6', type: 'text', x: 236, y: 222, fontSize: 20, text: 'Host-clipped', fill: true, stroke: false },
    rect('a8', 281, 291, { height: 39 }),
  ];
  assert.deepEqual(p.document(), expected);
  assert.equal(p.context.annotSelectionRef.current.has('a7'), false);
  assert.equal(p.context.annotContentSeqRef.current, snapshot.contentSeq + 1);
  assert.equal(p.context.annotDirtyRef.current, true);
  assert.equal(p.context.annotMoveRef.current.active, false);
  assert.deepEqual(p.released, [17]);
  assert.equal(p.queued.length, 1, 'finish schedules rather than immediately publishes');
  assert.equal(p.timers.size, 1);
  p.flushTimers();
  assert.equal(p.queued.length, 2);
  assert.deepEqual(plain(p.queued[1].snapshot.shapes), expected);
});

for (const action of ['finishAnnotMove', 'cancelAnnotMove']) {
  test(`${action}: an empty canonical ACK keeps every Host-truncated shape removed`, () => {
    const { p, snapshot } = pendingMove();
    p.ack(snapshot, []);
    p.context[action]();
    assert.deepEqual(p.document(), []);
    assert.equal(p.context.annotSelectionRef.current.size, 0);
  });
}

test('cancel restores the ACK canonical document, cancels the preview RAF, and never commits the delta', () => {
  const { p, snapshot } = pendingMove();
  p.ack(snapshot);
  assert.equal(p.frames.size, 1);
  p.context.cancelAnnotMove();
  const expected = panel(canonical()).document();
  assert.deepEqual(p.document(), expected);
  assert.equal(p.context.annotMoveRef.current.active, false);
  assert.equal(p.context.annotDirtyRef.current, false);
  assert.equal(p.context.annotContentSeqRef.current, snapshot.contentSeq);
  assert.equal(p.context.annotSelectionRef.current.has('a7'), false);
  assert.equal(p.frames.size, 0);
  assert.equal(p.context.annotSelectionRafRef.current, 0);
  assert.deepEqual(p.released, [17]);
  assert.equal(p.timers.size, 0);
  assert.equal(p.queued.length, 1);
});

test('finish after moving back to the press point adopts canonical ACK without a new edit', () => {
  const { p, snapshot } = pendingMove();
  p.ack(snapshot);
  p.context.moveAnnotSelection({ clientX: 10, clientY: 20, shiftKey: false });
  p.context.finishAnnotMove();
  assert.deepEqual(p.document(), panel(canonical()).document());
  assert.equal(p.context.annotContentSeqRef.current, snapshot.contentSeq);
  assert.equal(p.context.annotDirtyRef.current, false);
  assert.equal(p.queued.length, 1);
  assert.equal(p.timers.size, 0);
});

test('the latest same-seq canonical ACK wins when multiple replies arrive during one move', () => {
  const { p, snapshot } = pendingMove();
  p.ack(snapshot);
  p.ack(snapshot, [rect('a1', 100, 200, { width: 8 })], 13);
  p.context.finishAnnotMove();
  assert.deepEqual(p.document(), [rect('a1', 115, 191, { width: 8 })]);
  assert.equal(p.context.annotShownRevisionRef.current, 13);
});

test('an ACK for an older contentSeq cannot become the held move canonical document', () => {
  const { p, snapshot } = pendingMove();
  const before = p.document();
  p.ack({ ...snapshot, contentSeq: snapshot.contentSeq - 1 });
  assert.deepEqual(p.document(), before);
  assert.equal(p.context.annotMoveRef.current.acceptedShapes, undefined);
  assert.equal(p.context.annotDirtyRef.current, true);
  assert.equal(p.context.annotSyncRef.current.state, 'pending');
});

test('same-seq ACK without an active move imports the canonical document immediately', () => {
  const p = panel();
  const snapshot = p.context.annotPublishNow();
  p.ack(snapshot);
  assert.deepEqual(p.document(), panel(canonical()).document());
  assert.equal(p.context.annotDirtyRef.current, false);
});

for (const flush of [true, false]) {
  for (const identityAvailable of [true, false]) {
    test(`retainDirty(${flush}), identity ${identityAvailable ? 'available' : 'unavailable'}: retain prior dirty edit, cancel held preview`, () => {
      const p = panel();
      const committedBeforeMove = p.document();
      const seq = p.context.annotContentSeqRef.current;
      if (!identityAvailable) p.context.annotIdentityNow = () => null;
      p.start();
      assert.notDeepEqual(p.document(), committedBeforeMove);
      p.context.annotRetainDirty(flush);
      assert.deepEqual(p.document(), committedBeforeMove);
      assert.equal(p.context.annotMoveRef.current.active, false);
      assert.equal(p.context.annotContentSeqRef.current, seq);
      assert.equal(p.context.annotDirtyRef.current, false);
      assert.deepEqual(p.released, [17]);
      assert.equal(p.frames.size, 0);
      assert.equal(p.queued.length, flush && identityAvailable ? 1 : 0);
      assert.equal(p.remembered.length, flush && identityAvailable ? 0 : 1);
      const retained = [...p.queued, ...p.remembered][0].snapshot;
      assert.deepEqual(plain(retained.shapes), committedBeforeMove);
      assert.equal(retained.contentSeq, seq);
      assert.equal(retained.dKey, 'document-A');
      if (identityAvailable) assert.equal(p.identityReads[0].anyEpoch, true);
    });
  }
}

test('retainDirty after an ACK cancels the move into canonical state without republishing clean content', () => {
  const { p, snapshot } = pendingMove();
  p.ack(snapshot);
  p.context.annotRetainDirty(true);
  assert.deepEqual(p.document(), panel(canonical()).document());
  assert.equal(p.context.annotMoveRef.current.active, false);
  assert.equal(p.queued.length, 1);
  assert.equal(p.remembered.length, 0);
});

test('publishNow during active move returns null before identity lookup, allocation, or queueing', () => {
  const p = panel();
  p.start();
  const preview = p.document();
  p.context.annotIdentityNow = () => assert.fail('active preview must not read a publishing identity');
  p.context.annotPublisherAllocate = () => assert.fail('active preview must not allocate a revision');
  assert.equal(p.context.annotPublishNow(), null);
  assert.equal(p.queued.length, 0);
  assert.equal(p.remembered.length, 0);
  assert.equal(p.context.annotDirtyRef.current, true);
  assert.deepEqual(p.document(), preview);
});

test('an earlier dirty edit debounce firing during a held move queues nothing until finish', () => {
  const p = panel();
  const committedBeforeMove = p.document();
  p.context.annotPublishSchedule();
  p.start();
  p.flushTimers();
  assert.equal(p.queued.length, 0);
  assert.equal(p.context.annotSyncRef.current.timer, 0);
  p.context.finishAnnotMove();
  p.flushTimers();
  assert.equal(p.queued.length, 1);
  assert.notDeepEqual(plain(p.queued[0].snapshot.shapes), committedBeforeMove);
  assert.deepEqual(plain(p.queued[0].snapshot.shapes), p.document());
});

test('arrow selection bounds contain the arrowhead triangle vertices as well as the shaft', () => {
  const p = panel([]);
  const arrow = { ...style, id: 'a1', type: 'arrow', x1: 10, y1: 20, x2: 110, y2: 20, strokeWidth: 20 };
  const box = p.context.annotShapeBounds(arrow);
  // A horizontal arrowhead is (110,20), (50,40), (50,0); shaft-only y bounds miss it.
  assert.deepEqual(plain(box), { x: -1, y: -11, w: 122, h: 62 });
});

test('text bounds translate an old DOM getBBox to the current local text position', () => {
  const p = panel([]);
  p.context.annotSvgRef.current = { querySelector: (selector) => {
    assert.equal(selector, 'g[data-utb-annot-id="a1"] text');
    return { getBBox: () => ({ x: 12, y: 26, width: 80, height: 22 }),
      getAttribute: (name) => ({ x: '10', y: '40' })[name] };
  } };
  const box = p.context.annotShapeBounds({ ...style, id: 'a1', type: 'text', x: 110, y: 240, text: 'moved' });
  assert.deepEqual(plain(box), { x: 112, y: 226, w: 80, h: 22 });
});
