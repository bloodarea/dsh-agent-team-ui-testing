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
 *   - a page that swallows the probe (adversarial: clears the marker on the very events under test)
 *     makes both `browser_input` and `browser_click` fail loudly with `INPUT_NOT_DELIVERED`
 *     after exactly one retry, instead of the historical silent success;
 *   - `Runtime.activate()` coalesces concurrent callers into one `Page.bringToFront`, and re-fronts
 *     after a sibling runtime took the front (the old per-runtime 300 ms throttle skipped it).
 *
 * Run:  node tests/acceptance/input-delivery.mjs
 * Exit: 0 all checks pass; 1 assertion failure.
 */
import { createServer } from 'node:http';
import { createHarness, createFakeConnectionService } from './harness.mjs';

const log = (...args) => console.log(...args);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const results = [];
function check(label, pass, expected, actual) {
  results.push({ label, pass: Boolean(pass) });
  log(`${pass ? 'PASS' : 'FAIL'} ${label}`);
  if (!pass) log(`  expected=${JSON.stringify(expected)} actual=${JSON.stringify(actual)}`);
}

/** Independent recorder (fixture-side) + an optional adversarial trap that erases the probe. */
function pageHtml({ swallowProbe = false } = {}) {
  return `<!doctype html><title>input-delivery</title>
<body style="margin:0">
<button id="btn" style="position:absolute;left:40px;top:40px;width:220px;height:90px">click me</button>
<input id="field" style="position:absolute;left:40px;top:200px;width:220px;height:40px">
<script>
  window.__seen = [];
  for (const type of ['pointerdown','mousedown','pointerup','mouseup','click','keydown','keyup','input']) {
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
  const textOnly = await call('browser_input', { events: [{ kind: 'text', text: 'hi' }] });
  check('D07 a text-only batch never claims a delivery verdict',
    textOnly.ok && textOnly.value?.delivery?.verified === false && textOnly.value.delivery.delivered === null,
    { verified: false, delivered: null }, textOnly.value?.delivery ?? textOnly.error?.message);

  // 3. The silent-failure shape: the page really receives events but never records them for the
  //    verdict. The tool must fail loudly, once, after exactly one retry.
  const trap = await fixture({ swallowProbe: true });
  await call('browser_navigate', { url: trap });
  const silentClick = await call('browser_click', { selector: '#btn' });
  check('D08 a click the page never recorded fails with INPUT_NOT_DELIVERED',
    silentClick.ok === false && silentClick.error?.code === 'INPUT_NOT_DELIVERED',
    'INPUT_NOT_DELIVERED', { ok: silentClick.ok, code: silentClick.error?.code, message: silentClick.error?.message });
  check('D09 the failure carries the retry count and the page-side witness',
    silentClick.error?.details?.attempts === 2
      && Array.isArray(silentClick.error?.details?.seen)
      && silentClick.error.details.seen.every((type) => !['mousedown', 'pointerdown', 'mouseup', 'pointerup'].includes(type)),
    { attempts: 2, 'seen without press/release': true }, silentClick.error?.details?.attempts);
  const silentInput = await call('browser_input', {
    events: [{ kind: 'mouse', type: 'mousePressed', x: 100, y: 80, button: 'left', buttons: 1, clickCount: 1 }, { kind: 'mouse', type: 'mouseReleased', x: 100, y: 80, button: 'left', buttons: 0, clickCount: 1 }],
  });
  check('D10 a raw mouse batch the page never recorded fails the same way',
    silentInput.ok === false && silentInput.error?.code === 'INPUT_NOT_DELIVERED',
    'INPUT_NOT_DELIVERED', { ok: silentInput.ok, code: silentInput.error?.code });
  const trapSeen = await pageSeen();
  check('D11 the trap page did receive the events (so the failure is about reporting, not routing)',
    /mousedown/.test(trapSeen), 'mousedown present', trapSeen);

  // 4. activate(): coalesced, and re-fronted after a sibling took the front.
  const registry = harness.ctx.__internal.plugin.registry;
  const primary = [...registry.entries.values()].find((entry) => entry.runtime.running && entry.runtime.kind !== 'popup')?.runtime || null;
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
} finally {
  await harness.dispose();
  for (const server of servers) await new Promise((resolve) => server.close(resolve));
}

const failed = results.filter((entry) => !entry.pass);
log(`\ninput-delivery: ${results.length - failed.length}/${results.length} checks, ${failed.length} failed`);
process.exit(failed.length ? 1 : 0);
