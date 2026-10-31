#!/usr/bin/env node
/**
 * Development integration probe of the user's existing isolated host, never starts a DSH server.
 * It navigates and closes the live 3081 browser, so it must only ever be *executed*, never
 * imported: an accidental import would drive (and close) the host browser as a side effect.
 *
 * It does NOT restart 3081 either. Restarting the isolated host (so index.js/client.js changes are
 * loaded) is a deliberate manual step owned by the executor; only then does running this probe
 * prove anything about the new Host code.
 *
 * Authentication: the launch-token URL from /tmp/dsh-3081.log is exchanged once for the
 * browser-session cookie, which is kept in process memory only. Every request() then carries that
 * cookie; explicit `{ auth: false }` probes assert the unauthenticated projection stays redacted.
 */
import assert from 'node:assert/strict';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { startFixtureServer } from '../ui_test_fixture/server.mjs';
if (process.argv[1] !== fileURLToPath(import.meta.url)) {
  throw new Error('verify-3081.mjs 会操作真实 3081 宿主（导航并关闭浏览器），不能被 import 或通过 -e 触发；请直接运行 `node tests/acceptance/verify-3081.mjs`。');
}
const base = 'http://127.0.0.1:3081';
const directory = new URL(`./runs/host-3081-${Date.now()}/`, import.meta.url);
const checks = [];
let navigateResponseHistory = null;
function check(label, condition) { assert.ok(condition, label); checks.push({ label, pass: true }); console.log('PASS ' + label); }
// Browser-session cookie, memory only (never printed or written to evidence).
let cookie = '';
async function request(path, body, { auth = true } = {}) {
  const headers = {};
  if (auth && cookie) headers.cookie = cookie;
  if (body !== undefined) headers['content-type'] = 'application/json';
  const response = await fetch(base + '/plugins/ui-testing' + path, {
    method: body === undefined ? 'GET' : 'POST',
    headers,
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  return { status: response.status, value: await response.json() };
}
const fixture = await startFixtureServer();
try {
  // Read the launch token only into memory. Neither the log nor the token URL is copied to evidence.
  const log = await readFile('/tmp/dsh-3081.log', 'utf8');
  const links = [...log.matchAll(/http:\/\/(?:127\.0\.0\.1|localhost):3081\/[^\s\u001b]*/g)];
  const authenticated = links.reverse().find(([url]) => /token=/.test(url));
  assert.ok(authenticated, 'isolated host launch URL present');
  const exchange = await fetch(authenticated[0], { redirect: 'manual' });
  cookie = exchange.headers.getSetCookie().map((value) => value.split(';')[0]).join('; ');
  assert.ok(cookie, 'browser-session cookie issued by the launch URL');
  const gui = await fetch(base, { headers: { cookie } });
  const html = await gui.text();
  check('3081 authenticated GUI serves injected shell', gui.ok && html.includes('__DSH_BOOT__'));
  // Deterministic cold start for the ui projection checks: this probe already owns /close at the
  // end, so closing up front changes no original assertion and makes reruns repeatable.
  await request('/close', {});
  let cold;
  for (let i = 0; i < 40; i++) {
    cold = (await request('/state')).value;
    if (cold.running === false) break;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  check('3081 loaded single-owner-lease runtime', cold.owner?.mode === 'single-owner-lease');

  // Authenticated HTTP UI projection is separate from the redacted tool/state projection.
  check('authenticated /state exposes ui.version=1', cold.ui?.version === 1);
  check('cold authenticated ui state is empty: address + disabled directions', cold.ui?.address === ''
    && cold.ui?.history?.available === false && cold.ui?.history?.index === -1 && cold.ui?.history?.length === 0
    && cold.ui?.history?.canGoBack === false && cold.ui?.history?.canGoForward === false && cold.running === false);
  const rawLeak = JSON.stringify(cold.ui || {}).includes('http://') || JSON.stringify(cold).includes('"address":"http');
  check('cold ui snapshot carries no stale address', rawLeak === false);

  // Fail-closed checks: no cookie (or a forged Origin) must never receive the raw UI fields, and
  // the two new navigation endpoints must reject unauthenticated calls.
  const unauthenticated = await request('/state', undefined, { auth: false });
  check('unauthenticated /state omits ui projection', unauthenticated.status === 200
    && !Object.prototype.hasOwnProperty.call(unauthenticated.value, 'ui')
    && unauthenticated.value.ui === undefined);
  const forged = await fetch(base + '/plugins/ui-testing/state', { headers: { origin: 'http://evil.example' } });
  const forgedText = await forged.text();
  // Contract §1/§6-I: legacy GET /state stays compatible (200) but must never carry the raw UI
  // projection for an untrusted Origin. Only the new /reload and /history endpoints hard-reject.
  check('forged Origin /state stays on the redacted projection (no ui/raw)', forged.status === 200
    && !/"ui"\s*:/.test(forgedText) && !/"address"\s*:/.test(forgedText) && !/https?:\/\//.test(forgedText));
  const reloadUnauth = await request('/reload', {}, { auth: false });
  check('unauthenticated /reload rejected (401/403)', [401, 403].includes(reloadUnauth.status));
  const historyUnauth = await request('/history', { direction: 'back' }, { auth: false });
  check('unauthenticated /history rejected (401/403)', [401, 403].includes(historyUnauth.status));

  const nav = await request('/navigate', { url: fixture.url });
  check('real host navigates to authorized loopback fixture', nav.status === 200 && nav.value.ok);
  let state;
  for (let i = 0; i < 40; i++) {
    state = (await request('/state')).value;
    if (state.title === 'DSH UI Testing Fixture') break;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  check('real host title reflects document.title', state.title === 'DSH UI Testing Fixture');
  // The navigate write path may respond before the throttled metadata read publishes the CDP
  // history (observed: index/length briefly -1/0, valid after the next refresh). Use the same
  // bounded wait the GUI uses instead of sampling once, and record the transient as an observation.
  let tracked = state;
  for (let i = 0; i < 40; i++) {
    tracked = (await request('/state')).value;
    if (tracked.ui?.address === fixture.url && tracked.ui?.history?.available === true
      && Number.isInteger(tracked.ui?.history?.index) && Number.isInteger(tracked.ui?.history?.length)) break;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  check('authenticated ui address tracks the real target URL', tracked.ui?.version === 1
    && tracked.ui?.address === fixture.url && tracked.ui?.history?.available === true
    && Number.isInteger(tracked.ui?.history?.index) && Number.isInteger(tracked.ui?.history?.length));
  navigateResponseHistory = nav.value && nav.value.state && nav.value.state.ui ? nav.value.state.ui.history : null;
  await request('/eval', { expression: 'document.title="3081 SPA title"' });
  let spaState;
  for (let i = 0; i < 40; i++) {
    spaState = (await request('/state')).value;
    if (spaState.title === '3081 SPA title') break;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  check('real host refreshes SPA title', spaState.title === '3081 SPA title');

  // N2 through the real host HTTP routes (no fake harness): modifiers / virtualKeyCode forwarding.
  await request('/eval', { expression: 'document.getElementById("name").focus(); document.activeElement.id' });
  const shiftTab = await request('/input', { events: [
    { kind: 'key', type: 'keyDown', key: 'Tab', code: 'Tab', virtualKeyCode: 9, modifiers: ['shift'] },
    { kind: 'key', type: 'keyUp', key: 'Tab', code: 'Tab', virtualKeyCode: 9, modifiers: ['shift'] },
  ] });
  let focusFailed = null;
  for (let i = 0; i < 40; i++) {
    focusFailed = (await request('/eval', { expression: 'document.activeElement.id' })).value;
    if (focusFailed.value === 'inc') break;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  check('real host Shift+Tab moves focus #name → #inc', shiftTab.value.ok === true && shiftTab.value.applied === 2 && focusFailed.value === 'inc');

  const point = (await request('/eval', { expression: '(() => { const r = document.getElementById("inc").getBoundingClientRect(); return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) }; })()' })).value.value;
  const counterBefore = Number((await request('/eval', { expression: 'document.getElementById("counter").textContent' })).value.value || 0);
  const legacyClick = await request('/input', { events: [
    { kind: 'mouse', type: 'mousePressed', x: point.x, y: point.y, button: 'left', clickCount: 1 },
    { kind: 'mouse', type: 'mouseReleased', x: point.x, y: point.y, button: 'left', clickCount: 1 },
  ] });
  let counterAfter = counterBefore;
  for (let i = 0; i < 40; i++) {
    counterAfter = Number((await request('/eval', { expression: 'document.getElementById("counter").textContent' })).value.value || 0);
    if (counterAfter > counterBefore) break;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  check('real host legacy minimal mouse click still increments #counter', legacyClick.value.ok === true && counterAfter === counterBefore + 1);

  const badModifiers = await request('/input', { events: [{ kind: 'key', type: 'keyDown', key: 'Tab', modifiers: ['hyper'] }] });
  check('real host rejects unknown modifiers with 500 INVALID_ARGUMENT', badModifiers.status === 500 && badModifiers.value.ok === false && badModifiers.value.code === 'INVALID_ARGUMENT');

  const thrown = await request('/eval', { expression: 'throw new Error("3081-detail")' });
  check('HTTP eval error retains string plus structured code and stack', thrown.value.code === 'EVAL_ERROR' && /3081-detail/.test(thrown.value.error) && /at /.test(thrown.value.error));
  const shot = await request('/screenshot', {});
  const png = Buffer.from(shot.value.image || '', 'base64');
  check('real host screenshot captures PNG', shot.value.ok && png.subarray(0, 8).toString('hex') === '89504e470d0a1a0a');
  const failed = await request('/navigate', { url: 'http://127.0.0.1:1/' });
  check('real host unreachable navigation returns NAV_FAILED', failed.value.ok === false && failed.value.code === 'NAV_FAILED');
  const blocked = await request('/navigate', { url: 'http://169.254.169.254/' });
  check('real host blocks metadata target', blocked.value.ok === false && blocked.value.code === 'INVALID_ARGUMENT');
  const own = await request('/navigate', { url: base });
  check('real host blocks its own origin', own.value.ok === false && own.value.code === 'INVALID_ARGUMENT');
} finally {
  await request('/close', {}).catch(() => {});
  await fixture.close();
  const state = await request('/state');
  check('isolated host browser closed after verification', state.value.running === false);
  await mkdir(directory, { recursive: true });
  await writeFile(new URL('report.json', directory), JSON.stringify({ host: base, generatedAt: new Date().toISOString(), checks,
    observations: { navigateResponseHistory },
    scope: 'Real DSH HTTP integration and authenticated shell; every request after the launch-token exchange carries the in-memory browser-session cookie, plus authenticated ui.version/address/history checks and fail-closed checks for unauthenticated/forged-Origin /state and unauthenticated /reload//history. N2 modifiers/virtualKeyCode and legacy input exercised through the real /input+/eval routes; host lossless-JSON value contract and attachment projection covered by tests/acceptance/host-contract.mjs; provider image visibility NOT_RUN. This probe never restarts the host: a restart is a manual executor step.' }, null, 2));
  console.log('Evidence: ' + directory.pathname + 'report.json');
}
