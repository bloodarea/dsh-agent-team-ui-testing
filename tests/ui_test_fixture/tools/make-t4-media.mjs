#!/usr/bin/env node
/**
 * One-off generator for `tests/ui_test_fixture/t4-visual-media.webm` (WEB-T4 dynamic-visual fixture).
 *
 * Why this exists: the repository is zero-dependency and has no ffmpeg, so the 3 s WebM asset is
 * produced with the locally installed headless Chromium (MediaRecorder + canvas.captureStream) and
 * then has a Matroska `Duration` element inserted into `Segment/Info` (Chrome's live MediaRecorder
 * muxer omits it, which leaves `<video>.duration === Infinity` and makes seeking unreliable).
 *
 * Visual contract (matches tests/ui_test_fixture/t4-visual.md):
 *   - 320x180, 30 fps, VP8, 3.0 s (3000 ms), muted/no audio
 *   - 0–1 s solid red, 1–2 s solid green, 2–3 s solid blue
 *   - a 48x60 white block travels left→right across the whole 3 s
 *
 * Usage (must run under the shared single-driver lock):
 *   flock /tmp/dsh-t4-browser.lock node tests/ui_test_fixture/tools/make-t4-media.mjs
 *
 * Output: tests/ui_test_fixture/t4-visual-media.webm + sha256/size printed to stdout.
 * Re-running is not byte-deterministic (the VP8 encoder and MediaRecorder timestamps vary); the
 * committed asset's sha256 is recorded in t4-visual.md. Visual semantics are deterministic.
 */
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const OUT = join(HERE, '..', 't4-visual-media.webm');
const RECORD_MS = 3050;
const TARGET_DURATION_MS = 3000;

function chromeExecutable() {
  const explicit = process.env.DSH_UI_TESTING_CHROME;
  if (explicit) return explicit;
  for (const candidate of ['/opt/google/chrome/chrome', '/usr/bin/google-chrome', '/usr/bin/chromium']) {
    if (existsSync(candidate)) return candidate;
  }
  throw new Error('no Chromium found; set DSH_UI_TESTING_CHROME');
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Minimal CDP client over Node's built-in WebSocket (no npm dependency). */
async function connectCdp(wsUrl) {
  const ws = new WebSocket(wsUrl);
  await new Promise((resolve, reject) => {
    ws.addEventListener('open', resolve, { once: true });
    ws.addEventListener('error', () => reject(new Error('CDP WebSocket failed')), { once: true });
  });
  let nextId = 1;
  const pending = new Map();
  ws.addEventListener('message', (event) => {
    const message = JSON.parse(event.data);
    if (!message.id || !pending.has(message.id)) return;
    const entry = pending.get(message.id);
    pending.delete(message.id);
    if (message.error) entry.reject(new Error(JSON.stringify(message.error)));
    else entry.resolve(message.result);
  });
  return {
    send(method, params = {}, sessionId) {
      const id = nextId++;
      const payload = { id, method, params };
      if (sessionId) payload.sessionId = sessionId;
      ws.send(JSON.stringify(payload));
      return new Promise((resolve, reject) => pending.set(id, { resolve, reject }));
    },
    close() { try { ws.close(); } catch { /* ignore */ } },
  };
}

async function launchChrome() {
  const profile = await mkdtemp(join(tmpdir(), 'dsh-t4-media-gen-'));
  const bin = chromeExecutable();
  const proc = spawn(bin, [
    '--headless=new',
    '--no-sandbox',
    '--disable-dev-shm-usage',
    '--disable-crash-reporter',
    '--mute-audio',
    '--remote-debugging-port=0',
    `--user-data-dir=${profile}`,
    '--window-size=640,480',
    'about:blank',
  ], { stdio: ['ignore', 'ignore', 'pipe'] });
  let stderr = '';
  proc.stderr.on('data', (chunk) => { stderr = (stderr + String(chunk)).slice(-2000); });
  let wsUrl;
  for (let attempt = 0; attempt < 120; attempt += 1) {
    try {
      const text = await readFile(join(profile, 'DevToolsActivePort'), 'utf8');
      const [port, path] = text.trim().split('\n');
      if (Number(port) && path) { wsUrl = `ws://127.0.0.1:${port}${path}`; break; }
    } catch { /* not ready */ }
    await sleep(100);
  }
  if (!wsUrl) {
    try { proc.kill('SIGKILL'); } catch { /* ignore */ }
    await rm(profile, { recursive: true, force: true });
    throw new Error(`Chromium did not expose DevToolsActivePort: ${stderr}`);
  }
  return { proc, profile, wsUrl, bin };
}

/** Read an EBML variable-length integer at `offset`. */
function readVint(buffer, offset) {
  if (offset >= buffer.length) return null;
  const first = buffer[offset];
  let length = 1;
  let mask = 0x80;
  while (length <= 8 && (first & mask) === 0) { length += 1; mask >>= 1; }
  if (length > 8) return null;
  let value = first & (mask - 1);
  let unknown = value === mask - 1;
  for (let index = 1; index < length; index += 1) {
    value = value * 256 + buffer[offset + index];
    if (buffer[offset + index] !== 0xff) unknown = false;
  }
  return { value, length, unknown };
}

/** Read an EBML element ID (the length marker is part of the ID value). */
function readId(buffer, offset) {
  if (offset >= buffer.length) return null;
  const first = buffer[offset];
  let length = 1;
  let mask = 0x80;
  while (length <= 4 && (first & mask) === 0) { length += 1; mask >>= 1; }
  if (length > 4) return null;
  let value = 0;
  for (let index = 0; index < length; index += 1) value = value * 256 + buffer[offset + index];
  return { value, length };
}

/** Encode an EBML size as the shortest valid variable-length integer. */
function encodeVint(value) {
  for (let length = 1; length <= 8; length += 1) {
    const max = 2 ** (7 * length) - 1;
    if (value < max) {
      const out = Buffer.alloc(length);
      let remaining = value;
      for (let index = length - 1; index >= 0; index -= 1) {
        out[index] = remaining & 0xff;
        remaining = Math.floor(remaining / 256);
      }
      out[0] |= 1 << (8 - length);
      return out;
    }
  }
  throw new Error(`EBML size too large: ${value}`);
}

/**
 * Insert `Segment/Info/Duration` (float64, TimecodeScale units) into a live MediaRecorder WebM.
 * MediaRecorder writes an unknown-size Segment and no Duration; we only need to rewrite the Info
 * element, because nothing before it moves and every later element keeps its own size header.
 */
function patchDuration(buffer, durationMs) {
  // Locate the Segment after the EBML header generically (the header size can change with Chrome).
  const ebmlId = readId(buffer, 0);
  if (!ebmlId || ebmlId.value !== 0x1a45dfa3) throw new Error('EBML header not found');
  const ebmlSize = readVint(buffer, ebmlId.length);
  if (!ebmlSize || ebmlSize.unknown) throw new Error('EBML header size missing');
  const segmentOffset = ebmlId.length + ebmlSize.length + ebmlSize.value;
  const segmentId = readId(buffer, segmentOffset);
  const segment = readVint(buffer, segmentOffset + (segmentId ? segmentId.length : 0));
  if (!segmentId || segmentId.value !== 0x18538067 || !segment || !segment.unknown) {
    throw new Error(`expected an unknown-size Segment at offset ${segmentOffset}`);
  }
  let offset = segmentOffset + segmentId.length + segment.length;
  let info = null;
  while (offset < buffer.length) {
    const id = readId(buffer, offset);
    if (!id) break;
    const idBytes = id.length;
    const idValue = id.value;
    const size = readVint(buffer, offset + idBytes);
    if (!size) break;
    const headerBytes = idBytes + size.length;
    if (idValue === 0x1549a966) { // Info
      info = {
        offset,
        idBytes,
        sizeLength: size.length,
        sizeValue: size.value,
        dataStart: offset + headerBytes,
        dataEnd: offset + headerBytes + size.value,
      };
      break;
    }
    if (size.unknown) break;
    offset = offset + headerBytes + size.value;
  }
  if (!info) throw new Error('Segment/Info not found in MediaRecorder output');
  const duration = Buffer.alloc(11);
  duration.writeUInt16BE(0x4489, 0);
  duration[2] = 0x88;
  duration.writeDoubleBE(durationMs, 3);
  const newSize = info.sizeValue + duration.length;
  const newSizeBytes = encodeVint(newSize);
  const newHeader = Buffer.concat([
    buffer.subarray(info.offset, info.offset + info.idBytes),
    newSizeBytes,
  ]);
  return Buffer.concat([
    buffer.subarray(0, info.offset),
    newHeader,
    buffer.subarray(info.dataStart, info.dataEnd),
    duration,
    buffer.subarray(info.dataEnd),
  ]);
}

const chrome = await launchChrome();
let cdp;
try {
  cdp = await connectCdp(chrome.wsUrl);
  const { targetId } = await cdp.send('Target.createTarget', { url: 'about:blank' });
  const { sessionId } = await cdp.send('Target.attachToTarget', { targetId, flatten: true });
  await cdp.send('Runtime.enable', {}, sessionId);
  const expression = `(async () => {
    const WIDTH = 320, HEIGHT = 180;
    const support = {
      vp8: MediaRecorder.isTypeSupported('video/webm;codecs=vp8'),
      vp9: MediaRecorder.isTypeSupported('video/webm;codecs=vp9'),
      webm: MediaRecorder.isTypeSupported('video/webm'),
    };
    const mime = support.vp8 ? 'video/webm;codecs=vp8' : (support.vp9 ? 'video/webm;codecs=vp9' : 'video/webm');
    const canvas = document.createElement('canvas');
    canvas.width = WIDTH; canvas.height = HEIGHT;
    const ctx = canvas.getContext('2d');
    function paint(elapsedMs) {
      const t = Math.max(0, Math.min(${RECORD_MS} - 0.001, elapsedMs));
      const segment = Math.min(2, Math.floor(t / 1000));
      ctx.fillStyle = ['#ff0000', '#00ff00', '#0000ff'][segment];
      ctx.fillRect(0, 0, WIDTH, HEIGHT);
      const blockX = Math.round((t / 3000) * (WIDTH - 48));
      ctx.fillStyle = '#ffffff';
      ctx.fillRect(blockX, 60, 48, 60);
    }
    paint(0);
    const stream = canvas.captureStream(30);
    const recorder = new MediaRecorder(stream, { mimeType: mime, videoBitsPerSecond: 800000 });
    const chunks = [];
    recorder.ondataavailable = (event) => { if (event.data && event.data.size) chunks.push(event.data); };
    const stopped = new Promise((resolve) => { recorder.onstop = resolve; });
    const startedAt = performance.now();
    recorder.start(100);
    await new Promise((resolve) => {
      function tick() {
        const elapsed = performance.now() - startedAt;
        paint(elapsed);
        if (elapsed >= ${RECORD_MS}) { resolve(); return; }
        requestAnimationFrame(tick);
      }
      requestAnimationFrame(tick);
    });
    recorder.stop();
    await stopped;
    stream.getTracks().forEach((track) => track.stop());
    const blob = new Blob(chunks, { type: mime });
    const bytes = new Uint8Array(await blob.arrayBuffer());
    let binary = '';
    for (let index = 0; index < bytes.length; index += 8192) {
      binary += String.fromCharCode(...bytes.subarray(index, index + 8192));
    }
    return { support, mime, size: bytes.length, base64: btoa(binary) };
  })()`;
  const result = await cdp.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true }, sessionId);
  if (result.exceptionDetails) throw new Error(`MediaRecorder failed: ${JSON.stringify(result.exceptionDetails)}`);
  const value = result.result.value;
  const raw = Buffer.from(value.base64, 'base64');
  if (raw.length < 1000) throw new Error(`recording too small: ${raw.length} bytes`);
  const patched = patchDuration(raw, TARGET_DURATION_MS);
  await writeFile(OUT, patched);
  const sha256 = createHash('sha256').update(patched).digest('hex');
  console.log(JSON.stringify({
    output: OUT,
    chrome: chrome.bin,
    mime: value.mime,
    support: value.support,
    recordMs: RECORD_MS,
    durationMs: TARGET_DURATION_MS,
    bytes: patched.length,
    sha256,
  }, null, 2));
} finally {
  try { cdp?.close(); } catch { /* ignore */ }
  try { chrome.proc.kill('SIGKILL'); } catch { /* ignore */ }
  await sleep(500);
  await rm(chrome.profile, { recursive: true, force: true });
}
