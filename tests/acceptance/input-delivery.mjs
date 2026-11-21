/**
 * Input delivery acceptance: "dispatched" must never be reported as "delivered".
 *
 * A CDP `Input.*` dispatch returning only means the browser accepted the message. The page is the
 *   only witness that a DOM event actually happened, so every input path now installs a one-shot
 *   capture probe in the page, reads what the page observed afterwards, retries once, and raises
 *   `INPUT_NOT_DELIVERED` instead of reporting success (docs/web/input-delivery.md).
 *
 * What this suite proves end to end:
 *   - a normal click/input batch reports `delivery.verified && delivery.delivered`, and an
 *     independent page-side recorder (installed by the fixture, not by the probe) agrees;
 *   - a text-only `browser_input` batch says `verified:false, delivered:null` — no claim either way;
 *   - a page that suppresses part of the probe evidence makes both input paths report
 *     `INPUT_NOT_DELIVERED` without replaying a partially observed gesture;
 *   - `Runtime.activate()` coalesces concurrent callers into one `Page.bringToFront`, and re-fronts
 *     after a sibling runtime took the front (the old per-runtime 300 ms throttle skipped it).
 *
 * Run:  node tests/acceptance/input-delivery.mjs
 * Exit: 0 all checks pass; 1 assertion failure.
 */
import { createServer } from 'node:http';
import { INPUT_PROBE_READ_FN } from '../../targets/web/host.js';
import { createHarness, createFakeConnectionService } from './harness.mjs';

const log = (...args) => console.log(...args);
const results = [];
function check(label, pass, expected, actual) {
  results.push({ label, pass: Boolean(pass) });
  log(`${pass ? 'PASS' : 'FAIL'} ${label}`);
  if (!pass) log(`  expected=${JSON.stringify(expected)} actual=${JSON.stringify(actual)}`);
}

/** Independent recorder (fixture-side) + an optional adversarial trap that erases the probe. */
function pageHtml({ swallowProbe = false } = {}) {
  return `<!doctype html><title>input-delivery</title>
<body style="margin:0;min-height:3000px">
<button id="btn" style="position:absolute;left:40px;top:40px;width:220px;height:90px">click me</button>
<input id="field" style="position:absolute;left:40px;top:200px;width:220px;height:40px">
<button id="open-dialog" style="position:fixed;top:20px;right:20px" onclick="document.querySelector('dialog').showModal()">Open dialog</button>
<dialog><div id="dialog-scroll" style="width:250px;height:130px;overflow:auto;overscroll-behavior:contain">
  <div style="height:1600px">Scrollable dialog content</div>
</div></dialog>
<script>
  window.__seen = [];
  for (const type of ['pointerdown','mousedown','pointerup','mouseup','click','keydown','keyup','input','mousemove']) {
    window.addEventListener(type, (event) => { window.__seen.push(type); }, true);
  }
  ${swallowProbe ? `
  // Adversarial page: real events arrive, but the probe's own record is wiped on every one of
  // them — exactly the "dispatch accepted, page unaware" shape the verdict has to catch.
  const wipe = () => {
    const probe = window.__utb_input_probe__;
    if (probe && Array.isArray(probe.seen)) probe.seen.length = 0;
  };
  for (const type of ['pointerdown','mousedown','pointerup','mouseup','click','keydown','keyup']) {
    window.addEventListener(type, wipe, true);
  }` : ''}
</script></body>`;
}

const servers = [];
async function fixture(options) {
  const html = pageHtml(options);
  const server = createServer((req, res) => { res.writeHead(200, { 'content-type': 'text/html' }); res.end(html); });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  servers.push(server);
  return `http://127.0.0.1:${server.address().port}/`;
}

const cwd = process.env.DSH_UI_TESTING_REPO_ROOT || process.cwd();
const harness = await createHarness({
  connection: createFakeConnectionService({ admit: () => ({ peer: { id: 'owner' } }), browserPeer: { id: 'owner' } }),
});
const exec = { agent: { id: 'input-agent', session: { header: { cwd } } } };
const call = (name, args = {}) => harness.invoke(name, args, exec);
const pageSeen = async () => (await call('browser_eval', { expression: 'window.__seen.join(",")' }))?.value?.value || '';

try {
  // 1. Delivered click: the evidence carries a verified verdict, and the fixture's own recorder agrees.
  const plain = await fixture();
  const navigated = await call('browser_navigate', { url: plain });
  check('D01 primary navigates to the fixture', navigated.ok, true, navigated.error?.message);
  const click = await call('browser_click', { selector: '#btn' });
  const clickDelivery = click.value?.evidence?.dispatch?.delivery || null;
  check('D02 a normal click reports verified delivery from the page side',
    click.ok && clickDelivery?.verified === true && clickDelivery?.delivered === true,
    { verified: true, delivered: true }, { ok: click.ok, delivery: clickDelivery, error: click.error?.message });
  check('D03 the click evidence keeps its attempt count', clickDelivery?.attempts === 1, 1, clickDelivery?.attempts);
  const seenAfterClick = await pageSeen();
  check('D04 an independent page recorder saw the same press/release/click',
    /mousedown/.test(seenAfterClick) && /mouseup/.test(seenAfterClick) && /click/.test(seenAfterClick),
    'mousedown, mouseup, click', seenAfterClick);

  // 2. Raw input: mouse and key batches are verified; a text-only batch claims nothing.
  await call('browser_eval', { expression: 'window.__seen.length = 0' });
  const mouse = await call('browser_input', {
    events: [
      { kind: 'mouse', type: 'mousePressed', x: 100, y: 80, button: 'left', buttons: 1, clickCount: 1 },
      { kind: 'mouse', type: 'mouseReleased', x: 100, y: 80, button: 'left', buttons: 0, clickCount: 1 },
    ],
  });
  check('D05 a mouse batch reports verified delivery',
    mouse.ok && mouse.value?.delivery?.verified === true && mouse.value.delivery.delivered === true,
    { verified: true, delivered: true }, mouse.value?.delivery ?? mouse.error?.message);
  const keys = await call('browser_input', { events: [{ kind: 'key', type: 'keyDown', key: 'a', code: 'KeyA' }, { kind: 'key', type: 'keyUp', key: 'a', code: 'KeyA' }] });
  check('D06 a key batch reports verified delivery',
    keys.ok && keys.value?.delivery?.verified === true && keys.value.delivery.delivered === true,
    { verified: true, delivered: true }, keys.value?.delivery ?? keys.error?.message);
  await call('browser_eval', { expression: 'document.querySelector("#field").focus()' });
  const textOnly = await call('browser_input', { events: [{ kind: 'text', text: 'hi' }] });
  check('D07 a text-only batch never claims a delivery verdict',
    textOnly.ok && textOnly.value?.delivery?.verified === false && textOnly.value.delivery.delivered === null,
    { verified: false, delivered: null }, textOnly.value?.delivery ?? textOnly.error?.message);
  const fieldValue = (await call('browser_eval', { expression: 'document.querySelector("#field").value' })).value?.value;
  check('D17 a text-only batch actually inserts text into the focused field',
    textOnly.value?.applied === 1 && fieldValue === 'hi', 'hi', fieldValue);

  await call('browser_eval', { expression: 'window.__seen.length = 0' });
  const moveOnly = await call('browser_input', { events: [{ kind: 'mouse', type: 'mouseMoved', x: 160, y: 100 }] });
  const seenAfterMove = await pageSeen();
  check('D18 a move-only batch reaches the page and updates the virtual cursor',
    moveOnly.value?.cursor?.x === 160 && moveOnly.value?.cursor?.y === 100 && seenAfterMove.includes('mousemove'),
    { cursor: { x: 160, y: 100 }, event: 'mousemove' }, { cursor: moveOnly.value?.cursor, seen: seenAfterMove });

  // Defer the first release until after the first probe read. Chromium still dispatches a real
  // release, just after the page has already reported the press. No timing guess in the fixture.
  const registry = harness.ctx.__internal.plugin.registry;
  const primary = [...registry.entries.values()].find((entry) => entry.runtime.running && entry.runtime.kind !== 'popup')?.runtime || null;
  if (primary) {
    const cdp = primary.cdp;
    const realSend = cdp.send;
    for (const [label, invoke] of [
      ['D19 a structured click observes a late release without replaying the press', () => call('browser_click', { selector: '#btn' })],
      ['D20 a raw input batch observes a late release without replaying the press', () => call('browser_input', {
        events: [{ kind: 'mouse', type: 'mousePressed', x: 100, y: 80, button: 'left', buttons: 1, clickCount: 1 }, { kind: 'mouse', type: 'mouseReleased', x: 100, y: 80, button: 'left', buttons: 0, clickCount: 1 }],
      })],
    ]) {
      await call('browser_eval', { expression: 'window.__seen.length = 0' });
      let release;
      let presses = 0;
      let firstRead;
      cdp.send = async function (method, params, options) {
        if (method === 'Input.dispatchMouseEvent' && params.type === 'mousePressed') presses += 1;
        if (method === 'Input.dispatchMouseEvent' && params.type === 'mouseReleased' && !firstRead) {
          release = [method, params, options];
          return {};
        }
        const response = await realSend.call(this, method, params, options);
        if (method === 'Runtime.evaluate' && params.expression?.startsWith(INPUT_PROBE_READ_FN) && release && !firstRead) {
          firstRead = response.result?.value?.seen || [];
          await realSend.call(this, ...release);
        }
        return response;
      };
      try {
        const result = await invoke();
        const delivery = result.value?.evidence?.dispatch?.delivery ?? result.value?.delivery;
        const seen = await pageSeen();
        check(label, firstRead?.includes('mousedown') && !firstRead.includes('mouseup') && seen.includes('mouseup')
          && result.ok && delivery?.delivered === true && delivery?.attempts === 1 && presses === 1,
        { attempts: 1, presses: 1 }, { firstRead, seen, delivery, presses });
      } finally {
        cdp.send = realSend;
      }
    }
    const probeRemoved = (await call('browser_eval', { expression: '!("__utb_input_probe__" in window)' })).value?.value;
    check('D21 the settled read cleans up the page probe', probeRemoved === true, true, probeRemoved);
  }

  const readPage = async (expression) => (await call('browser_eval', { expression })).value?.value;
  const wheelReadback = `({ pageY: window.scrollY, dialogY: document.querySelector('#dialog-scroll').scrollTop })`;
  const waitForScroll = (key, before) => readPage(`(async () => {
    const end = performance.now() + 1000;
    let state = ${wheelReadback};
    while (state[${JSON.stringify(key)}] === ${before} && performance.now() < end) {
      await new Promise((resolve) => setTimeout(resolve, 20));
      state = ${wheelReadback};
    }
    return state;
  })()`);
  const pageBefore = await readPage(wheelReadback);
  const documentWheel = await call('browser_input', { events: [{ kind: 'wheel', x: 100, y: 300, deltaY: 180 }] });
  const pageAfter = await waitForScroll('pageY', pageBefore.pageY);
  check('D29 wheel scrolls the long document', documentWheel.value?.delivery?.delivered === true && pageAfter?.pageY > pageBefore.pageY,
    { pageY: '> before' }, { before: pageBefore, after: pageAfter, delivery: documentWheel.value?.delivery });

  const dialogOpened = await call('browser_click', { selector: '#open-dialog' });
  const dialogPoint = await readPage(`(() => {
    const el = document.querySelector('#dialog-scroll');
    const { left, top, width, height } = el.getBoundingClientRect();
    return { x: left + width / 2, y: top + height / 2, open: el.closest('dialog').open };
  })()`);
  const dialogBefore = await readPage(wheelReadback);
  const dialogWheel = await call('browser_input', { events: [{ kind: 'wheel', x: dialogPoint.x, y: dialogPoint.y, deltaY: 180 }] });
  const dialogAfter = await waitForScroll('dialogY', dialogBefore.dialogY);
  check('D30 wheel scrolls the modal overflow without scrolling the document',
    dialogOpened.ok && dialogPoint.open && dialogWheel.value?.delivery?.delivered === true
      && dialogAfter?.dialogY > dialogBefore.dialogY && dialogAfter.pageY === dialogBefore.pageY,
    { dialogY: '> before', pageY: 'unchanged' }, { before: dialogBefore, after: dialogAfter, delivery: dialogWheel.value?.delivery });

  // 3. The page really receives events but suppresses part of the probe evidence.
  const trap = await fixture({ swallowProbe: true });
  await call('browser_navigate', { url: trap });
  const silentClick = await call('browser_click', { selector: '#btn' });
  check('D08 a click the page never recorded fails with INPUT_NOT_DELIVERED',
    silentClick.ok === false && silentClick.error?.code === 'INPUT_NOT_DELIVERED',
    'INPUT_NOT_DELIVERED', { ok: silentClick.ok, code: silentClick.error?.code, message: silentClick.error?.message });
  check('D09 a partially observed click reports its witness without replaying',
    silentClick.error?.details?.attempts === 1 && silentClick.error?.details?.seen?.includes('click')
      && silentClick.error?.details?.missing?.length > 0,
    { attempts: 1, seen: ['click'], missing: 'one or more required events' }, silentClick.error?.details);
  const silentInput = await call('browser_input', {
    events: [{ kind: 'mouse', type: 'mousePressed', x: 100, y: 80, button: 'left', buttons: 1, clickCount: 1 }, { kind: 'mouse', type: 'mouseReleased', x: 100, y: 80, button: 'left', buttons: 0, clickCount: 1 }],
  });
  check('D10 a raw mouse batch the page never recorded fails the same way',
    silentInput.ok === false && silentInput.error?.code === 'INPUT_NOT_DELIVERED',
    'INPUT_NOT_DELIVERED', { ok: silentInput.ok, code: silentInput.error?.code });
  const trapSeen = await pageSeen();
  check('D11 the trap page did receive the events (so the failure is about reporting, not routing)',
    /mousedown/.test(trapSeen), 'mousedown present', trapSeen);

  // 3b. Self-heal: a document that drops synthetic input entirely. The Host must rebuild the
  //     document (about:blank → back), replay the gesture once — safe because the page observed
  //     nothing, so nothing can happen twice — and report that it did.
  if (primary) {
    await call('browser_navigate', { url: plain });
    await call('browser_eval', { expression: 'window.__count = 0; document.getElementById("btn").textContent = "click me"' });
    const cdp = primary.cdp;
    const realSend = cdp.send.bind(cdp);
    let swallow = true;
    let navigations = [];
    cdp.send = async function (method, params, options) {
      // Exactly the measured failure shape: the CDP command succeeds, the page sees nothing.
      if (swallow && method === 'Input.dispatchMouseEvent') return {};
      if (method === 'Page.navigate') {
        navigations.push(String(params?.url || ''));
        const response = await realSend(method, params, options);
        if (navigations.length === 2) swallow = false; // document rebuilt: stop swallowing
        return response;
      }
      return realSend(method, params, options);
    };
    try {
      const healed = await call('browser_click', { selector: '#btn' });
      const healedDelivery = healed.value?.evidence?.dispatch?.delivery || null;
      check('D24 a zero-witness click is healed by rebuilding the document',
        healed.ok === true && healedDelivery?.delivered === true && healedDelivery?.recovery === 'document-recycled',
        { delivered: true, recovery: 'document-recycled' },
        { ok: healed.ok, delivery: healedDelivery, error: healed.error?.message });
      check('D25 the recovery is a real round trip: detectably-non-working document, then back',
        navigations.length === 2 && navigations[0] === 'about:blank' && navigations[1] === plain,
        { roundTrip: ['about:blank', plain] }, navigations);
      // The rebuilt document's own recorder must have seen the replay: this is what proves the
      // gesture landed in the *new* document instead of the one that was about to be replaced.
      const healedSeen = await pageSeen();
      const healedHref = (await call('browser_eval', { expression: 'location.href' })).value?.value;
      check('D26 the healed click landed in the rebuilt document, not the replaced one',
        /mousedown/.test(healedSeen) && /mouseup/.test(healedSeen) && /click/.test(healedSeen) && healedHref === plain,
        { events: 'mousedown, mouseup, click', href: plain }, { events: healedSeen, href: healedHref });

      // Same ladder for a raw mouse batch (`browser_input`), which shares the helper.
      await call('browser_eval', { expression: 'window.__seen.length = 0' });
      swallow = true;
      navigations = [];
      const healedInput = await call('browser_input', {
        events: [
          { kind: 'mouse', type: 'mousePressed', x: 100, y: 80, button: 'left', buttons: 1, clickCount: 1 },
          { kind: 'mouse', type: 'mouseReleased', x: 100, y: 80, button: 'left', buttons: 0, clickCount: 1 },
        ],
      });
      const healedInputDelivery = healedInput.value?.delivery || null;
      check('D27 a zero-witness raw batch is healed the same way',
        healedInput.ok === true && healedInputDelivery?.delivered === true
        && healedInputDelivery?.recovery === 'document-recycled' && navigations.length === 2,
        { delivered: true, recovery: 'document-recycled', navigations: 2 },
        { ok: healedInput.ok, delivery: healedInputDelivery, navigations });
      swallow = true;
      navigations = [];
      const beforeWheel = (await call('browser_eval', { expression: 'performance.timeOrigin' })).value?.value;
      const droppedWheel = await call('browser_input', { events: [{ kind: 'wheel', x: 100, y: 100, deltaY: 180 }] });
      const afterWheel = (await call('browser_eval', { expression: 'performance.timeOrigin' })).value?.value;
      check('D28 even a headless wheel failure preserves the document',
        droppedWheel.error?.code === 'INPUT_NOT_DELIVERED' && droppedWheel.error.details?.attempts === 2
        && typeof beforeWheel === 'number' && beforeWheel === afterWheel && navigations.length === 0,
        { attempts: 2, navigations: 0, documentPreserved: true }, { error: droppedWheel.error, navigations, beforeWheel, afterWheel });
    } finally {
      cdp.send = realSend;
    }
  }

  // 4. activate(): coalesced, and re-fronted after a sibling took the front.
  check('D12 the primary runtime is reachable for the activation checks', Boolean(primary), 'runtime', Boolean(primary));
  if (primary) {
    const host = primary.host;
    const sent = [];
    const realSend = primary.cdp.send.bind(primary.cdp);
    primary.cdp.send = (method, params, options) => {
      if (method === 'Page.bringToFront') sent.push(Date.now());
      return realSend(method, params, options);
    };
    try {
      host.frontRuntimeId = undefined;
      const [first, second, third] = await Promise.all([primary.activate(), primary.activate(), primary.activate()]);
      check('D13 concurrent activate() calls coalesce into one Page.bringToFront',
        sent.length === 1 && first === true && second === true && third === true,
        { sends: 1, resolved: [true, true, true] }, { sends: sent.length, resolved: [first, second, third] });
      // No "already front" cache: front-ness also changes outside this runtime (Chromium fronts a
      // newly created tab, the user clicks another tab), so a later call must really front again.
      // Only *concurrent* callers are coalesced (D13) — that is what bounds the cost.
      const again = await primary.activate();
      check('D14 a later activate() really fronts again instead of trusting a cache',
        again === true && sent.length === 2, { sends: 2 }, { sends: sent.length, resolved: again });
      // A sibling taking the front is exactly what the old per-runtime throttle could not see.
      host.frontRuntimeId = 'some-other-runtime';
      const refront = await primary.activate();
      check('D15 a sibling taking the front forces a real bringToFront again',
        refront === true && sent.length === 3, { sends: 3 }, { sends: sent.length, resolved: refront });
      check('D16 the host records this runtime as the front one', host.frontRuntimeId === primary.runtimeId,
        primary.runtimeId, host.frontRuntimeId);
    } finally {
      primary.cdp.send = realSend;
    }
  }

  // Exercise the primary again after Chromium has created a sibling tab. A queued write must
  // front its own page when it gets its turn, even if the sibling was activated while it waited.
  if (primary) {
    await call('browser_navigate', { url: plain });
    const opened = await call('browser_tabs', { action: 'open' });
    const selected = await call('browser_tabs', { action: 'select', tabId: 'primary' });
    const listed = await call('browser_tabs', { action: 'list' });
    const selectedRow = listed.value?.tabs?.find((tab) => tab.selected);
    const evaluated = await call('browser_eval', { expression: 'location.href' });
    const sibling = [...registry.entries.values()].find((entry) => entry.tabId === opened.value?.tabId)?.runtime;
    check('D22 select returns to the original primary after opening a sibling',
      opened.ok && sibling?.cdp && sibling !== primary && selected.value?.tabId === 'primary'
      && selectedRow?.runtimeId === primary.runtimeId && selectedRow.url === plain && evaluated.value?.value === plain,
      plain, { selected: selected.value?.tabId, listedUrl: selectedRow?.url, location: evaluated.value?.value });
    if (sibling?.cdp && sibling !== primary) {
      let enter;
      let unblock;
      const entered = new Promise((resolve) => { enter = resolve; });
      const hold = new Promise((resolve) => { unblock = resolve; });
      const blocking = primary.run(() => { enter(); return hold; }, { activate: false });
      await entered;
      const cdp = primary.cdp;
      const realSend = cdp.send;
      const order = [];
      cdp.send = function (method, params, options) {
        if (method === 'Page.bringToFront') order.push('primary activation');
        if (method === 'Input.dispatchMouseEvent' && params.type === 'mousePressed') order.push('primary press');
        return realSend.call(this, method, params, options);
      };
      const queued = primary.run(() => primary.input([
        { kind: 'mouse', type: 'mousePressed', x: 100, y: 80, button: 'left', buttons: 1, clickCount: 1 },
        { kind: 'mouse', type: 'mouseReleased', x: 100, y: 80, button: 'left', buttons: 0, clickCount: 1 },
      ]));
      queued.catch(() => {});
      try {
        await sibling.activate();
        order.push('sibling activated');
      } finally {
        unblock();
        await blocking;
        try {
          const result = await queued;
          const orderBeforeReadback = order.slice();
          const seen = await pageSeen();
          const expected = ['sibling activated', 'primary activation', 'primary press'];
          check('D23 a queued input activates primary after the sibling, then reaches primary',
            JSON.stringify(orderBeforeReadback) === JSON.stringify(expected) && result.delivery.delivered && seen.includes('click'),
            expected, { order: orderBeforeReadback, seen, delivery: result.delivery });
        } finally {
          cdp.send = realSend;
        }
      }
    }
  }
} finally {
  await harness.dispose();
  for (const server of servers) await new Promise((resolve) => server.close(resolve));
}

const failed = results.filter((entry) => !entry.pass);
log(`\ninput-delivery: ${results.length - failed.length}/${results.length} checks, ${failed.length} failed`);
process.exit(failed.length ? 1 : 0);
