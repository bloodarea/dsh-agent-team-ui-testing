/**
 * Panel audio player acceptance: the preview must actually PLAY the page packets it receives.
 *
 * The player lives inside the shipped panel bundle (`client.js`), which only runs under the DSH
 * web module loader. Rather than maintain a copy of its logic here, this suite extracts the exact
 * `createPanelAudioPlayer` function text from `client.js` (brace-matched, no rewriting), runs it in
 * a real headless Chromium, feeds it packets shaped exactly like the ones the frame socket
 * delivers, and measures what the AudioContext really received:
 *
 *   - every packet becomes one scheduled `AudioBufferSourceNode`, in order, starting later than the
 *     previous one (a continuous timeline, not a pile of simultaneous sources);
 *   - the decoded buffer carries the original amplitude (the tone's peak, not silence and not
 *     clipping) for both the mono and the stereo path;
 *   - `reset` clears the timeline, a disabled player schedules nothing, and malformed payloads are
 *     counted as decode errors instead of throwing.
 *
 * Run:  node tests/acceptance/audio-panel-player.mjs
 * Exit: 0 all checks pass; 1 assertion failure.
 */
import { readFileSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const results = [];
const log = (...args) => console.log(...args);
function check(label, pass, expected, actual) {
  results.push({ label, pass: Boolean(pass) });
  log(`${pass ? 'PASS' : 'FAIL'} ${label}`);
  if (!pass) log(`  expected=${JSON.stringify(expected)} actual=${JSON.stringify(actual)}`);
}

const CLIENT_PATH = fileURLToPath(new URL('../../client.js', import.meta.url));
const CHROME_WRAPPER = fileURLToPath(new URL('./chrome-wrapper.sh', import.meta.url));

/** Extract `function createPanelAudioPlayer(...) { ... }` verbatim from the shipped bundle. */
function extractPlayerSource() {
  const source = readFileSync(CLIENT_PATH, 'utf8');
  const marker = 'function createPanelAudioPlayer(';
  const start = source.indexOf(marker);
  if (start < 0) throw new Error('createPanelAudioPlayer not found in client.js');
  let index = source.indexOf('{', start);
  if (index < 0) throw new Error('no body for createPanelAudioPlayer');
  let depth = 0;
  let inString = null;
  let inLineComment = false;
  let inBlockComment = false;
  for (let position = index; position < source.length; position += 1) {
    const char = source[position];
    const next = source[position + 1];
    if (inLineComment) { if (char === '\n') inLineComment = false; continue; }
    if (inBlockComment) { if (char === '*' && next === '/') { inBlockComment = false; position += 1; } continue; }
    if (inString) {
      if (char === '\\') { position += 1; continue; }
      if (char === inString) inString = null;
      continue;
    }
    if (char === '/' && next === '/') { inLineComment = true; position += 1; continue; }
    if (char === '/' && next === '*') { inBlockComment = true; position += 1; continue; }
    if (char === '"' || char === "'" || char === '`') { inString = char; continue; }
    if (char === '{') depth += 1;
    else if (char === '}') {
      depth -= 1;
      if (depth === 0) return source.slice(start, position + 1);
    }
  }
  throw new Error('unbalanced createPanelAudioPlayer body');
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Tone packets shaped exactly like the Host's: 2048 samples, 24 kHz, mono/stereo s16le, base64. */
function tonePacket({ seq, amplitude = 12000, channels = 1, rate = 24000, samples = 2048 }) {
  const pcm = Buffer.alloc(samples * channels * 2);
  for (let index = 0; index < samples; index += 1) {
    const value = Math.round(Math.sin((2 * Math.PI * 440 * index) / rate) * amplitude);
    for (let channel = 0; channel < channels; channel += 1) {
      pcm.writeInt16LE(value, (index * channels + channel) * 2);
    }
  }
  return {
    type: 'audio', state: 'live', seq, rate, channels, encoding: 's16le',
    atMs: Date.now(), bytes: pcm.length, samples, data: pcm.toString('base64'),
  };
}

const playerSource = extractPlayerSource();
log(`extracted createPanelAudioPlayer (${playerSource.length} chars) from client.js`);

const profile = mkdtempSync(join(tmpdir(), 'panel-audio-'));
const port = 9300 + Math.floor(Math.random() * 300);
const proc = spawn(CHROME_WRAPPER || '/usr/bin/google-chrome', [
  '--headless=new', `--remote-debugging-port=${port}`, '--remote-debugging-address=127.0.0.1',
  `--remote-allow-origins=http://127.0.0.1:${port}`, `--user-data-dir=${profile}`,
  '--no-first-run', '--no-default-browser-check', '--disable-gpu', '--hide-scrollbars',
  // The panel player needs its AudioContext to start without a gesture inside an automated page.
  '--autoplay-policy=no-user-gesture-required',
  '--no-sandbox', '--disable-dev-shm-usage', '--disable-crash-reporter',
  '--window-size=1280,800', 'about:blank',
], { stdio: ['ignore', 'ignore', 'pipe'] });
let stderr = '';
proc.stderr.setEncoding('utf8');
proc.stderr.on('data', (chunk) => { stderr += chunk; });

let ws;
let nextId = 1;
const pending = new Map();
const send = (method, params = {}, sessionId) => new Promise((resolve, reject) => {
  const id = nextId += 1;
  pending.set(id, { resolve, reject });
  ws.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
});

try {
  let wsUrl = null;
  for (let attempt = 0; attempt < 120 && !wsUrl; attempt += 1) {
    await sleep(120);
    try {
      const info = await (await fetch(`http://127.0.0.1:${port}/json/version`)).json();
      wsUrl = info.webSocketDebuggerUrl;
    } catch { /* not up yet */ }
  }
  if (!wsUrl) throw new Error('devtools never came up: ' + stderr.slice(-600));
  ws = new WebSocket(wsUrl);
  await new Promise((resolve, reject) => { ws.onopen = resolve; ws.onerror = () => reject(new Error('ws error')); });
  ws.onmessage = (event) => {
    const message = JSON.parse(event.data);
    if (message.id && pending.has(message.id)) {
      const entry = pending.get(message.id);
      pending.delete(message.id);
      if (message.error) entry.reject(new Error(JSON.stringify(message.error)));
      else entry.resolve(message.result);
    }
  };

  const { targetId } = await send('Target.createTarget', { url: 'about:blank' });
  const { sessionId } = await send('Target.attachToTarget', { targetId, flatten: true });
  await send('Page.enable', {}, sessionId);
  await send('Runtime.enable', {}, sessionId);
  await send('Page.navigate', { url: 'about:blank' }, sessionId);
  await sleep(300);

  // Install the exact shipped function plus instrumentation of what the AudioContext receives.
  const install = `(() => {
    ${playerSource}
    window.__probe = { buffers: [], starts: [], contexts: 0 };
    const createBuffer = BaseAudioContext.prototype.createBuffer;
    BaseAudioContext.prototype.createBuffer = function (channels, length, rate) {
      const buffer = createBuffer.call(this, channels, length, rate);
      window.__probe.buffers.push(buffer);
      return buffer;
    };
    const start = AudioBufferSourceNode.prototype.start;
    AudioBufferSourceNode.prototype.start = function (when) {
      window.__probe.starts.push({ when: when === undefined ? 0 : when, at: this.context.currentTime });
      return start.apply(this, arguments);
    };
    const PlayerAudioContext = window.AudioContext;
    window.__mkPlayer = () => {
      window.__probe.contexts += 1;
      const player = createPanelAudioPlayer(window);
      window.__player = player;
      return true;
    };
    window.__mkPlayer();
    return true;
  })()`;
  const installed = await send('Runtime.evaluate', { expression: install, returnByValue: true }, sessionId);
  check('P01 the shipped createPanelAudioPlayer installs in a real browser', installed.result?.value === true, true,
    installed.exceptionDetails?.text || installed.result?.value);

  const enabled = await send('Runtime.evaluate', {
    expression: 'window.__player.enable().then((on) => JSON.stringify({ on, state: window.__player.snapshot() }))',
    awaitPromise: true, returnByValue: true,
  }, sessionId);
  const enableState = JSON.parse(enabled.result?.value || '{}');
  check('P02 enabling starts the panel AudioContext', enableState.on === true, true, enableState);

  // Feed 10 mono packets the way the frame socket would (paced, not all at once).
  for (let index = 1; index <= 10; index += 1) {
    const packet = tonePacket({ seq: index });
    await send('Runtime.evaluate', {
      expression: `window.__player.push(${JSON.stringify(packet)})`,
      returnByValue: true,
    }, sessionId);
    await sleep(120);
  }
  const afterMono = await send('Runtime.evaluate', {
    expression: `JSON.stringify({
      snapshot: window.__player.snapshot(),
      buffers: window.__probe.buffers.length,
      starts: window.__probe.starts,
      peaks: window.__probe.buffers.map((buffer) => {
        const data = buffer.getChannelData(0);
        let peak = 0;
        for (let i = 0; i < data.length; i += 1) { const v = Math.abs(data[i]); if (v > peak) peak = v; }
        return Math.round(peak * 32767);
      }),
      shape: window.__probe.buffers.length
        ? { channels: window.__probe.buffers[0].numberOfChannels, length: window.__probe.buffers[0].length, rate: window.__probe.buffers[0].sampleRate }
        : null,
    })`,
    returnByValue: true,
  }, sessionId);
  const mono = JSON.parse(afterMono.result?.value || '{}');
  check('P03 every packet becomes one scheduled source', mono.starts?.length === 10 && mono.snapshot?.played === 10,
    { starts: 10, played: 10 }, { starts: mono.starts?.length, played: mono.snapshot?.played });
  check('P04 the sources form one continuous timeline', Array.isArray(mono.starts) && mono.starts.every((item, index) => index === 0 || item.when > mono.starts[index - 1].when),
    'monotonically increasing start times', mono.starts?.map((item) => Math.round(item.when * 1000)));
  check('P05 decoded buffers carry the packet geometry', mono.shape?.channels === 1 && mono.shape?.length === 2048 && mono.shape?.rate === 24000,
    { channels: 1, length: 2048, rate: 24000 }, mono.shape);
  const monoPeakWorst = Array.isArray(mono.peaks)
    ? Math.max(...mono.peaks.map((peak) => Math.abs(peak - 12000)))
    : Number.POSITIVE_INFINITY;
  check('P06 decoded samples keep the original amplitude (real sound, not silence)', monoPeakWorst <= 12000 * 0.02,
    'peak≈12000±2%', { monoPeakWorst, peaks: mono.peaks?.slice(0, 4) });
  check('P07 no decode errors on well-formed packets', mono.snapshot?.decodeErrors === 0, 0, mono.snapshot?.decodeErrors);

  // Stereo packet: same code path, both channels filled.
  await send('Runtime.evaluate', {
    expression: `window.__player.push(${JSON.stringify(tonePacket({ seq: 11, channels: 2, samples: 1024 }))})`,
    returnByValue: true,
  }, sessionId);
  const stereo = await send('Runtime.evaluate', {
    expression: `JSON.stringify({ snapshot: window.__player.snapshot(), shape: (() => { const b = window.__probe.buffers[window.__probe.buffers.length - 1]; return b ? { channels: b.numberOfChannels, length: b.length, left: Math.round((() => { const d = b.getChannelData(0); let p = 0; for (const v of d) p = Math.max(p, Math.abs(v)); return p; })() * 32767), right: Math.round((() => { const d = b.getChannelData(1); let p = 0; for (const v of d) p = Math.max(p, Math.abs(v)); return p; })() * 32767) } : null; })() })`,
    returnByValue: true,
  }, sessionId);
  const stereoState = JSON.parse(stereo.result?.value || '{}');
  check('P08 a stereo packet fills both channels', stereoState.shape?.channels === 2
    && Math.abs(stereoState.shape.left - 12000) <= 240 && Math.abs(stereoState.shape.right - 12000) <= 240,
  'channels=2, both peaks≈12000', stereoState.shape);
  check('P09 the stereo packet was scheduled too', stereoState.snapshot?.played === 11, 11, stereoState.snapshot?.played);

  // Reset (navigation) clears the timeline; the following packet restarts it.
  const reset = await send('Runtime.evaluate', {
    expression: `(() => { window.__player.push({ type: 'audio', state: 'reset', reason: 'navigation' }); window.__player.push(${JSON.stringify(tonePacket({ seq: 1 }))}); return JSON.stringify(window.__player.snapshot()); })()`,
    returnByValue: true,
  }, sessionId);
  const resetState = JSON.parse(reset.result?.value || '{}');
  check('P10 a reset message is counted and the timeline restarts', resetState.resets === 1 && resetState.played === 12,
    { resets: 1, played: 12 }, { resets: resetState.resets, played: resetState.played });

  // A disabled player counts packets but schedules (and decodes) nothing — no wasted CPU while the
  // user has sound off, while the panel can still show "this page has sound".
  const disabled = await send('Runtime.evaluate', {
    expression: `(() => {
      window.__player.disable();
      const before = window.__probe.starts.length;
      window.__player.push(${JSON.stringify(tonePacket({ seq: 2 }))});
      return JSON.stringify({ before, after: window.__probe.starts.length, snapshot: window.__player.snapshot() });
    })()`,
    returnByValue: true,
  }, sessionId);
  const disabledState = JSON.parse(disabled.result?.value || '{}');
  check('P11 a disabled player schedules nothing', disabledState.before === disabledState.after && disabledState.snapshot?.enabled === false,
    { before: disabledState.before, after: disabledState.after }, disabledState);
  // Malformed payloads are counted as decode errors instead of throwing into the socket handler.
  const malformed = await send('Runtime.evaluate', {
    expression: `window.__player.enable().then(() => {
      window.__player.push({ type: 'audio', state: 'live', seq: 3, rate: 24000, channels: 1, encoding: 's16le', data: '!!!not-base64!!!' });
      return JSON.stringify(window.__player.snapshot());
    })`,
    awaitPromise: true, returnByValue: true,
  }, sessionId);
  const malformedState = JSON.parse(malformed.result?.value || '{}');
  check('P12 a malformed payload is counted, not thrown', malformedState.decodeErrors === 1, 1, malformedState.decodeErrors);
} catch (error) {
  check('suite completed without an unexpected error', false, 'no error', String((error && error.message) || error));
} finally {
  try { ws?.close(); } catch { /* ignore */ }
  try { proc.kill('SIGKILL'); } catch { /* ignore */ }
  await sleep(300);
  try { rmSync(profile, { recursive: true, force: true }); } catch { /* ignore */ }
}

const failed = results.filter((item) => !item.pass);
log(`\n${results.length - failed.length}/${results.length} checks passed`);
process.exit(failed.length === 0 ? 0 : 1);
