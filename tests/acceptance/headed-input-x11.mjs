/** Real headed Chrome on the local X11 desktop. Run explicitly with a temporary profile. */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, realpath, rm } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { createHarness, createFakeConnectionService, waitFor } from './harness.mjs';

if (process.platform !== 'linux' || !process.env.DISPLAY) {
  console.log('NOT_RUN requires a Linux X11 desktop');
  process.exit(2);
}
const temp = await realpath(tmpdir());
const profile = await mkdtemp(join(temp, 'dsh-utb-headed-x11-'));
assert.equal(await realpath(profile), profile);
assert.equal(dirname(profile), temp);
assert.match(basename(profile), /^dsh-utb-headed-x11-[\w-]+$/);
process.env.DSH_UI_TESTING_PROFILE_DIR = profile;
delete process.env.DSH_UI_TESTING_HEADED_VISIBLE;

const fixture = createServer((req, res) => {
  res.writeHead(200, { 'content-type': 'text/html', 'cache-control': 'no-store' });
  res.end(`<!doctype html><title>Headed input fixture</title><body style="margin:0;height:3000px">
    <button id="button" style="position:fixed;left:20px;top:20px;width:120px;height:60px">0</button>
    <input id="field" style="position:fixed;left:160px;top:20px">
    <button id="popup" style="position:fixed;left:20px;top:100px;width:120px;height:50px">Open popup</button>
    <script>
      window.hits = {click: 0, wheel: 0};
      document.querySelector('#button').onclick = e => { if (e.isTrusted) e.target.textContent = ++hits.click; };
      document.querySelector('#popup').onclick = () => window.open('/popup', 'fixture-popup', 'popup,width=640,height=480');
      addEventListener('wheel', e => { if (e.isTrusted) ++hits.wheel; }, {passive: true});
    </script></body>`);
});
let harness;
try {
  await new Promise((resolve, reject) => { fixture.once('error', reject); fixture.listen(0, '127.0.0.1', resolve); });
  const origin = `http://127.0.0.1:${fixture.address().port}`;
  const session = 'headed-input-x11';
  const headers = { 'x-ui-testing-scope-version': '1', 'x-ui-testing-session-id': session };
  harness = await createHarness({ connection: createFakeConnectionService({ admit: () => ({ peer: { id: 'owner' } }), browserPeer: { id: 'owner' } }) });
  const exec = { agent: { id: session, session: { header: { cwd: process.cwd() } } } };
  const call = async (tool, args = {}) => {
    const result = await harness.invoke(tool, args, exec);
    assert.equal(result.ok, true, `${tool}: ${result.error?.message}`);
    return result.value;
  };
  const page = async (expression) => {
    const result = await call('browser_eval', { expression });
    assert.equal(result.ok, true, JSON.stringify(result.error));
    return result.value;
  };
  const panel = (action, body) => harness.request({ method: body ? 'POST' : 'GET', path: `/plugins/ui-testing/${action}`, headers, body });
  const registry = harness.ctx.__internal.plugin.registry;
  const host = registry.browserHost();
  const x = (bin, args) => execFileSync(bin, args, { encoding: 'utf8', timeout: 2500 });
  const desktop = () => x('xprop', ['-root', '_NET_CURRENT_DESKTOP']).trim();
  const desktopBefore = desktop();
  const activeWindow = () => x('xprop', ['-root', '_NET_ACTIVE_WINDOW']).match(/0x[\da-f]+\s*$/)?.[0].trim();
  const keyboardFocus = () => x('xdotool', ['getwindowfocus', '-f']).trim();
  const originalFocus = { active: activeWindow(), keyboard: keyboardFocus() };
  assert.ok(originalFocus.active && originalFocus.active !== '0x0', 'start with another desktop window active');
  const assertFocusUnchanged = () => assert.deepEqual({ active: activeWindow(), keyboard: keyboardFocus() }, originalFocus);
  const wheel = [{ kind: 'wheel', x: 300, y: 200, deltaY: 175 }];
  const gesture = [
    { kind: 'mouse', type: 'mousePressed', x: 80, y: 50, button: 'left', buttons: 1, clickCount: 1 },
    { kind: 'mouse', type: 'mouseReleased', x: 80, y: 50, button: 'left', buttons: 0, clickCount: 1 },
  ];
  const panelClick = async (y = 50) => {
    const result = await panel('input', { events: gesture.map((event) => ({ ...event, y })) });
    assert.equal(result.json?.applied?.delivery?.delivered, true, JSON.stringify(result.json));
    assert.equal(result.json.applied.delivery.attempts, 1);
  };
  const panelWheel = async () => {
    const result = await panel('input', { events: wheel });
    assert.equal(result.json?.applied?.delivery?.attempts, 1, JSON.stringify(result.json));
    assert.ok(result.json.applied.delivery.seen.includes('wheel'));
  };

  assert.equal((await panel('display', { mode: 'headed' })).json?.mode, 'headed');
  await call('browser_navigate', { url: `${origin}/primary` });
  const primary = [...registry.entries.values()].find((entry) => entry.tabId === 'primary' && entry.runtime.running).runtime;
  const assertWindowsHidden = (expectedCount) => {
    const clients = x('xprop', ['-root', '_NET_CLIENT_LIST']).match(/0x[0-9a-f]+/g) || [];
    const owned = clients.filter((id) => Number(x('xprop', ['-id', id, '_NET_WM_PID']).match(/=\s*(\d+)/)?.[1]) === host.proc.pid);
    assert.equal(owned.length, expectedCount);
    for (const id of owned) {
      const info = x('xwininfo', ['-id', id, '-shape']);
      assert.match(info, /Map State: IsViewable/);
      assert.match(info, /Window shape extents:\s*0x0/);
      assert.match(x('xprop', ['-id', id, '_NET_WM_WINDOW_OPACITY']), /_NET_WM_WINDOW_OPACITY\(CARDINAL\) = 0\s*$/);
      const state = x('xprop', ['-id', id, '_NET_WM_STATE']);
      assert.match(state, /_NET_WM_STATE_SKIP_TASKBAR/);
      assert.match(state, /_NET_WM_STATE_SKIP_PAGER/);
      const focus = x('xprop', ['-id', id, 'WM_HINTS', 'WM_PROTOCOLS']);
      assert.match(focus, /Client accepts input or input focus: False/i);
      assert.doesNotMatch(focus, /WM_TAKE_FOCUS/);
    }
  };
  assertWindowsHidden(1);
  assert.equal((await panel('state')).json?.ui?.display?.hidden, true);
  assertFocusUnchanged();
  for (let heartbeat = 0; heartbeat < 3; heartbeat += 1) {
    assert.equal((await panel('metrics', {})).json?.ok, true);
    await delay(120);
    assertFocusUnchanged();
  }
  console.log('PASS cold startup and three panel heartbeats preserved the active window and keyboard focus');

  const sibling = await call('browser_tabs', { action: 'open' });
  const target = primary.page.targetId;
  const framesBefore = primary.screencastFrames;
  for (let round = 0; round < 8; round += 1) {
    for (const tab of [sibling.tabId, 'primary']) {
      await call('browser_tabs', { action: 'select', tabId: tab });
      const url = `${origin}/${tab}?round=${round}`;
      await call('browser_navigate', { url });
      await waitFor(() => page(`location.href === ${JSON.stringify(url)} && window.hits?.click === 0`),
        { timeoutMs: 2000, label: 'fixture input handlers ready' });
      await panelClick();
      assert.equal(await page(`location.href === ${JSON.stringify(url)} && hits.click === 1`), true);
      assertFocusUnchanged();
    }
    await panelWheel();
    await waitFor(() => page('hits.wheel === 1 && scrollY > 0'), { timeoutMs: 2000 });
    assert.equal(primary.page.targetId, target);
  }
  assert.ok(primary.screencastFrames > framesBefore);
  assert.equal(desktop(), desktopBefore);
  console.log(`PASS same primary target survived 8 tab cycles, 16 panel clicks and 8 panel wheels, frames ${framesBefore} -> ${primary.screencastFrames}`);

  const typed = await call('browser_type', { selector: '#field', text: 'preserve' });
  assert.equal(typed.ok, true);
  assert.equal(await page('document.querySelector("#field").value'), 'preserve');
  assertFocusUnchanged();
  const state = () => page('({ origin: performance.timeOrigin, form: document.querySelector("#field").value, scrollY, url: location.href })');
  const baseline = await state();
  const cdp = primary.cdp;
  const send = cdp.send;
  let navigations = 0;
  let pressed = 0;
  let wheels = 0;
  let dropAll = true;
  cdp.send = function (method, params, options) {
    if (method === 'Page.navigate' || method === 'Page.reload') navigations += 1;
    if (method === 'Input.dispatchMouseEvent') {
      if (params.type === 'mousePressed') pressed += 1;
      if (params.type === 'mouseWheel') wheels += 1;
      if (dropAll || params.type === 'mouseReleased') return Promise.resolve({});
    }
    return send.call(this, method, params, options);
  };
  try {
    for (let round = 0; round < 2; round += 1) {
      const click = await harness.invoke('browser_click', { selector: '#button' }, exec);
      assert.equal(click.error?.code, 'INPUT_NOT_DELIVERED');
      assert.equal(click.error.details.attempts, 2);
      const scroll = await panel('input', { events: wheel });
      assert.equal(scroll.json?.code, 'INPUT_NOT_DELIVERED');
      assert.equal(scroll.json.details.attempts, 2);
    }
    assert.equal(pressed, 4);
    assert.equal(wheels, 4);
    assert.equal(navigations, 0);
    assert.deepEqual(await state(), baseline);
    dropAll = false;
    const click = await harness.invoke('browser_click', { selector: '#button' }, exec);
    assert.equal(click.error?.code, 'INPUT_NOT_DELIVERED');
    assert.equal(click.error.details.attempts, 1);
    assert.ok(click.error.details.seen.includes('mousedown'));
    assert.equal(pressed, 5);
    assert.equal(navigations, 0);
    assert.deepEqual(await state(), baseline);
  } finally {
    cdp.send = send;
  }
  console.log('PASS repeated zero delivery and partial delivery leave navigation, form and scroll intact');

  for (const mode of ['headless', 'headed']) {
    assert.equal((await panel('display', { mode })).json?.mode, mode);
    await call('browser_tabs', { action: 'select', tabId: 'primary' });
    const opened = await panel('ensure', { url: `${origin}/reopened-${mode}` });
    assert.equal(opened.json?.ok, true, JSON.stringify(opened.json));
    assert.equal((await panel('state')).json?.ui?.display?.hidden, mode === 'headed');
    await panelClick();
    if (mode === 'headed') {
      await panelClick(125);
      await waitFor(async () => (await panel('state')).json?.ui?.views?.some((view) => view.kind === 'popup' && view.status === 'ready'),
        { timeoutMs: 8000, label: 'native popup ready' });
      assertWindowsHidden(2);
      const active = activeWindow();
      if (active !== originalFocus.active) {
        if (active && active !== '0x0') {
          const pid = Number(x('xprop', ['-id', active, '_NET_WM_PID']).match(/=\s*(\d+)/)?.[1]);
          assert.equal(pid, host.proc.pid, 'only restore focus if Chrome focused its own new popup');
        }
        x('xdotool', ['windowactivate', '--sync', originalFocus.active]);
      }
      const popup = [...registry.entries.values()].find((entry) => entry.runtime.kind === 'popup' && entry.runtime.running);
      assert.ok(popup?.runtime.running);
      assert.equal(await popup.runtime.activate(), true);
      await delay(120);
      assertFocusUnchanged();
      console.log('PASS native popup is mapped and clipped, and subsequent activation preserves desktop focus');
    }
    assert.equal(await page('hits.click'), 1);
  }
  console.log('PASS switching back through headless and headed restores clicks and accurate window state');
} finally {
  if (harness) await harness.dispose();
  if (fixture.listening) await new Promise((resolve) => fixture.close(resolve));
  await rm(profile, { recursive: true, force: true, maxRetries: 6, retryDelay: 100 });
}
