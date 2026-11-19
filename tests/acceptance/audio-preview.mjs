/**
 * Page audio acceptance: the preview must carry the page's own sound.
 *
 * What this suite proves end to end (all through the production paths, no mocks of the audio code):
 *   - the Host injects the tap and receives PCM packets from a real headless Chromium page;
 *   - the frame socket advertises `audio` in `hello` and delivers `{type:'audio'}` messages with
 *     the documented format (24000 Hz, mono, s16le, base64);
 *   - the samples really are the page's audio: the captured peak tracks the oscillator gain /
 *     WAV amplitude of the fixture, not noise;
 *   - a page with no audio sends nothing (silence gate) instead of a silent 48 KB/s stream;
 *   - a navigation emits `{type:'audio', state:'reset'}` so the panel starts a clean timeline;
 *   - `<audio>` elements are tapped too (not just Web Audio graphs);
 *   - the video frame stream is unchanged by audio being on.
 *
 * Run:  node tests/acceptance/audio-preview.mjs
 * Exit: 0 all checks pass; 1 assertion failure.
 */
import { createServer } from 'node:http';
import { fileURLToPath } from 'node:url';
import {
  createHarness,
  createFakeConnectionService,
  connectFrameWebSocket,
  closeFrameWebSocket,
  waitForWebSocket,
  startPluginHttpServer,
  sleep,
} from './harness.mjs';

// Inside the DSH file sandbox Chromium needs the wrapper flags (same real binary).
process.env.DSH_UI_TESTING_CHROME ||= fileURLToPath(new URL('./chrome-wrapper.sh', import.meta.url));

const results = [];
const log = (...args) => console.log(...args);
function check(label, pass, expected, actual) {
  results.push({ label, pass: Boolean(pass) });
  log(`${pass ? 'PASS' : 'FAIL'} ${label}`);
  if (!pass) log(`  expected=${JSON.stringify(expected)} actual=${JSON.stringify(actual)}`);
}

/* ------------------------------------------------------------------ fixtures */

/** 1 s of a 440 Hz tone as a 16 kHz mono s16 WAV data URI (media-element path). */
function toneWavDataUri(amplitude = 12000) {
  const rate = 16000;
  const count = rate;
  const pcm = Buffer.alloc(count * 2);
  for (let index = 0; index < count; index += 1) {
    pcm.writeInt16LE(Math.round(Math.sin((2 * Math.PI * 440 * index) / rate) * amplitude), index * 2);
  }
  const header = Buffer.alloc(44);
  header.write('RIFF', 0); header.writeUInt32LE(36 + pcm.length, 4); header.write('WAVE', 8);
  header.write('fmt ', 12); header.writeUInt32LE(16, 16); header.writeUInt16LE(1, 20); header.writeUInt16LE(1, 22);
  header.writeUInt32LE(rate, 24); header.writeUInt32LE(rate * 2, 28); header.writeUInt16LE(2, 32); header.writeUInt16LE(16, 34);
  header.write('data', 36); header.writeUInt32LE(pcm.length, 40);
  return 'data:audio/wav;base64,' + Buffer.concat([header, pcm]).toString('base64');
}

const TONE_GAIN = 0.4;
const WAV_AMPLITUDE = 12000;

function pageHtml(mode) {
  const head = '<!doctype html><meta charset="utf-8"><body style="margin:0;background:#fff">';
  if (mode === 'webaudio') {
    return `${head}<h1>tone</h1><script>
(async () => {
  const ctx = new AudioContext();
  await ctx.resume();
  const osc = ctx.createOscillator();
  osc.frequency.value = 440;
  const gain = ctx.createGain();
  gain.gain.value = ${TONE_GAIN};
  osc.connect(gain);
  gain.connect(ctx.destination);
  osc.start();
  window.__pageAudio = () => ({ state: ctx.state, peak: ${TONE_GAIN} });
})().catch((error) => { window.__pageAudioError = String(error && error.message || error); });
</script></body>`;
  }
  if (mode === 'mediaelement') {
    return `${head}<h1>media</h1><audio id="tone" loop preload="auto" src="${toneWavDataUri(WAV_AMPLITUDE)}"></audio>
<script>
const element = document.getElementById('tone');
element.play().then(() => { window.__pagePlayed = true; }).catch((error) => { window.__pagePlayError = String(error && error.message || error); });
window.__pageAudio = () => ({ state: element.paused ? 'paused' : 'playing' });
</script></body>`;
  }
  // Deliberately silent page: nothing connected to an audio destination.
  return `${head}<h1>silent</h1><p>no audio here</p></body>`;
}

const servers = [];
async function fixture() {
  const pages = { webaudio: pageHtml('webaudio'), mediaelement: pageHtml('mediaelement'), silent: pageHtml('silent') };
  const server = createServer((req, res) => {
    const name = (req.url || '/').replace(/^\//, '').split('?')[0];
    const body = pages[name];
    if (!body) { res.writeHead(404, { 'content-type': 'text/plain' }); res.end('no page'); return; }
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end(body);
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  servers.push(server);
  return `http://127.0.0.1:${server.address().port}`;
}

/* ------------------------------------------------------------------ helpers */

function audioMessages(client) {
  return client.textMessages.filter((message) => message && message.type === 'audio');
}
function liveAudio(client) {
  return audioMessages(client).filter((message) => message.state === 'live');
}
function decodePacket(message) {
  const bytes = Buffer.from(String(message.data || ''), 'base64');
  const pcm = new Int16Array(bytes.buffer, bytes.byteOffset, Math.floor(bytes.byteLength / 2));
  let peak = 0;
  for (const value of pcm) {
    const magnitude = Math.abs(value);
    if (magnitude > peak) peak = magnitude;
  }
  return { bytes: bytes.length, samples: pcm.length, peak };
}

/* ------------------------------------------------------------------ suite */

const fixtureBase = await fixture();
const repoRoot = process.env.DSH_UI_TESTING_REPO_ROOT || process.cwd();
const harness = await createHarness({
  connection: createFakeConnectionService({ admit: () => ({ peer: { id: 'audio-peer' } }), browserPeer: { id: 'audio-peer' } }),
  allowTestEnvironments: true,
});
const agent = { id: 'audio-agent', session: { header: { cwd: repoRoot } } };
const exec = { agent, signal: AbortSignal.timeout(30000) };
const call = (name, args = {}) => harness.invoke(name, args, exec);

let server;
let client;
try {
  const navigated = await call('browser_navigate', { url: `${fixtureBase}/webaudio` });
  check('A01 page with a Web Audio tone opens', navigated.ok === true, true, navigated.error?.message);

  server = await startPluginHttpServer(harness);
  // Session-scoped socket: it must land on the SAME workspace runtime that opened the page
  // (an unscoped/legacy socket resolves to its own idle runtime and would see nothing).
  const socketUrl = `${server.wsUrl}/plugins/ui-testing/frames?scopeVersion=1&sessionId=${encodeURIComponent(agent.id)}`;
  client = await connectFrameWebSocket(socketUrl, { timeoutMs: 8000 }).catch((failure) => failure);
  check('A02 frame socket connects', client.opened === true, true, client.error);

  const hello = await waitForWebSocket(client, (value) => value.hellos[0], { timeoutMs: 6000, label: 'hello' }).catch(() => undefined);
  check('A03 hello advertises the audio channel', hello && hello.audio && hello.audio.available === true, true, hello && hello.audio);

  const packets = await waitForWebSocket(client, (value) => {
    const live = liveAudio(value);
    return live.length >= 5 ? live : undefined;
  }, { timeoutMs: 8000, label: 'audio packets' }).catch(() => []);
  check('A04 the page audio reaches the panel socket', packets.length >= 5, '>=5 packets', packets.length);

  const first = packets[0] || {};
  check('A05 packet header matches the documented format',
    first.rate === 24000 && first.channels === 1 && first.encoding === 's16le'
    && first.samples === 2048 && typeof first.data === 'string',
    { rate: 24000, channels: 1, encoding: 's16le', samples: 2048 }, {
      rate: first.rate, channels: first.channels, encoding: first.encoding, samples: first.samples,
      dataType: typeof first.data,
    });

  const decoded = packets.map((packet) => decodePacket(packet));
  const expectedPeak = Math.round(TONE_GAIN * 32767);
  const worstPeak = Math.max(...decoded.map((item) => Math.abs(item.peak - expectedPeak)));
  check('A06 captured samples carry the page amplitude (not noise, not silence)',
    worstPeak <= expectedPeak * 0.15, `peak≈${expectedPeak}±15%`, { worstPeak, peaks: decoded.slice(0, 4).map((item) => item.peak) });

  const seqs = packets.map((packet) => packet.seq);
  const strictlyIncreasing = seqs.every((seq, index) => index === 0 || seq > seqs[index - 1]);
  check('A07 packets keep a strictly increasing sequence', strictlyIncreasing, true, seqs.slice(0, 6));
  check('A08 packet byte accounting matches its sample count',
    decoded.every((item, index) => item.bytes === packets[index].bytes && item.samples === packets[index].samples),
    true, { first: { bytes: decoded[0]?.bytes, samples: decoded[0]?.samples } });

  // Video is untouched by audio being on.
  const frames = await waitForWebSocket(client, (value) => (value.frames.length > 0 ? value.frames : undefined), {
    timeoutMs: 8000, label: 'frames',
  }).catch(() => []);
  check('A09 the JPEG frame stream keeps flowing alongside audio', frames.length > 0, '>0 frames', frames.length);

  // Metrics projection: counters only, never payload bytes.
  const metricsResponse = await harness.request({
    method: 'GET',
    path: '/plugins/ui-testing/metrics',
    headers: { 'x-ui-testing-scope-version': '1', 'x-ui-testing-session-id': agent.id },
  });
  const audioMetrics = metricsResponse?.json?.host?.audio || null;
  check('A10 host audio metrics report accepted packets without payload',
    Boolean(audioMetrics) && audioMetrics.accepted >= 5 && audioMetrics.live === true
    && audioMetrics.format?.rate === 24000 && !('data' in audioMetrics),
    'accepted>=5, live=true, rate=24000, no payload', audioMetrics);

  // Silence gate: a page with no audio must not stream. Packets of the previous page can still be
  // in flight right after the navigation, so the baseline is taken after they drain.
  const silentNav = await call('browser_navigate', { url: `${fixtureBase}/silent` });
  check('A11 navigating to a silent page succeeds', silentNav.ok === true, true, silentNav.error?.message);
  await sleep(700);
  const beforeSilent = liveAudio(client).length;
  await sleep(1500);
  const afterSilent = liveAudio(client).length;
  check('A12 a silent page sends no audio packets', afterSilent === beforeSilent, beforeSilent, afterSilent);
  const resets = audioMessages(client).filter((message) => message.state === 'reset');
  check('A13 navigation resets the audio timeline', resets.length >= 1, '>=1 reset', resets.length);

  // Media element path: <audio> is tapped as well.
  const mediaBefore = liveAudio(client).length;
  const mediaNav = await call('browser_navigate', { url: `${fixtureBase}/mediaelement` });
  check('A14 media-element page opens', mediaNav.ok === true, true, mediaNav.error?.message);
  const mediaPackets = await waitForWebSocket(client, (value) => {
    const live = liveAudio(value).slice(mediaBefore);
    return live.length >= 5 ? live : undefined;
  }, { timeoutMs: 9000, label: 'media audio packets' }).catch(() => []);
  check('A15 an <audio> element is tapped too', mediaPackets.length >= 5, '>=5 packets', mediaPackets.length);
  const mediaDecoded = mediaPackets.map((packet) => decodePacket(packet));
  const mediaPeak = mediaDecoded.length ? Math.max(...mediaDecoded.map((item) => item.peak)) : 0;
  const expectedMediaPeak = WAV_AMPLITUDE;
  check('A16 media-element samples carry the file amplitude',
    Math.abs(mediaPeak - expectedMediaPeak) <= expectedMediaPeak * 0.15,
    `peak≈${expectedMediaPeak}±15%`, { mediaPeak, peaks: mediaDecoded.slice(0, 4).map((item) => item.peak) });
} finally {
  if (client) await closeFrameWebSocket(client).catch(() => {});
  if (server) await server.close().catch(() => {});
  for (const open of servers) await new Promise((resolve) => open.close(resolve)).catch(() => {});
  await harness.dispose?.().catch?.(() => {});
}

const failed = results.filter((item) => !item.pass);
log(`\n${results.length - failed.length}/${results.length} checks passed`);
process.exit(failed.length === 0 ? 0 : 1);
