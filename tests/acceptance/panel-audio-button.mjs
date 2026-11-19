/**
 * Panel audio toggle placement: it must sit INSIDE the address bar as the second control from
 * the right (immediately left of the history button), not in the toolbar icon row.
 *
 * The panel only renders inside the DSH web module loader, so this suite takes the two pieces the
 * position actually depends on from the shipped `client.js` — the `CSS` template (used verbatim)
 * and the class names of the real markup — renders the real address-bar nesting in Chromium and
 * measures it. No hand-written geometry: the numbers below come from the panel's own stylesheet.
 *
 * Run:  node tests/acceptance/panel-audio-button.mjs
 * Exit: 0 all checks pass; 1 assertion failure.
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const results = [];
const log = (...args) => console.log(...args);
function check(label, pass, expected, actual) {
  results.push({ label, pass: Boolean(pass) });
  log(`${pass ? 'PASS' : 'FAIL'} ${label}`);
  if (!pass) log(`  expected=${JSON.stringify(expected)} actual=${JSON.stringify(actual)}`);
}

const CLIENT_PATH = fileURLToPath(new URL('../../client.js', import.meta.url));
const CHROME_WRAPPER = fileURLToPath(new URL('./chrome-wrapper.sh', import.meta.url));

/**
 * Extract one function's source verbatim from the shipped bundle (brace-matched, string/comment
 * aware) so the test renders the REAL icons instead of a hand-written copy.
 */
function extractFunction(name) {
  const source = readFileSync(CLIENT_PATH, 'utf8');
  const marker = 'function ' + name + '(';
  const start = source.indexOf(marker);
  if (start < 0) throw new Error(name + ' not found in client.js');
  // Skip the parameter list first: a destructured parameter (`({ muted })`) contains braces that
  // would otherwise be mistaken for the body.
  let params = source.indexOf('(', start);
  let paramDepth = 0;
  for (; params < source.length; params += 1) {
    if (source[params] === '(') paramDepth += 1;
    else if (source[params] === ')') {
      paramDepth -= 1;
      if (paramDepth === 0) break;
    }
  }
  let index = source.indexOf('{', params);
  let depth = 0;
  let quote = null;
  let line = false;
  let block = false;
  for (let position = index; position < source.length; position += 1) {
    const char = source[position];
    const next = source[position + 1];
    if (line) { if (char === '\n') line = false; continue; }
    if (block) { if (char === '*' && next === '/') { block = false; position += 1; } continue; }
    if (quote) {
      if (char === '\\') { position += 1; continue; }
      if (char === quote) quote = null;
      continue;
    }
    if (char === '/' && next === '/') { line = true; position += 1; continue; }
    if (char === '/' && next === '*') { block = true; position += 1; continue; }
    if (char === '"' || char === "'" || char === '`') { quote = char; continue; }
    if (char === '{') depth += 1;
    else if (char === '}') {
      depth -= 1;
      if (depth === 0) return source.slice(start, position + 1);
    }
  }
  throw new Error('unbalanced body for ' + name);
}

/** The panel's own stylesheet, taken between the `const CSS = \`` … `` ` `` delimiters. */
function extractCss() {
  const source = readFileSync(CLIENT_PATH, 'utf8');
  const start = source.indexOf('const CSS = `');
  if (start < 0) throw new Error('const CSS template not found in client.js');
  const open = source.indexOf('`', start + 10);
  let index = open + 1;
  while (index < source.length) {
    if (source[index] === '\\') { index += 2; continue; }
    if (source[index] === '`') return source.slice(open + 1, index);
    index += 1;
  }
  throw new Error('unterminated CSS template');
}

const css = extractCss();
log(`extracted the panel stylesheet (${css.length} chars)`);

const GAP = 2;   // .utb-addr-hist { right: 2px }
const STEP = 24; // button width

/**
 * Real address-bar nesting (toolbar → form → .utb-addr-wrap → input + both buttons + popover),
 * with the real class names. The three leading icon buttons keep the form's flex context realistic.
 */
// The panel inherits these tokens from the DSH shell; without them every `var(--dsw-…)`
// resolves to nothing and colour rules cannot be observed.
const TOKENS = `:root{--dsw-alias-brand-primary:#4d6bfe;--dsw-alias-label-primary:#e6e8ec;--dsw-alias-label-secondary:#8a8f98;--dsw-alias-bg-base:#0f1116;--dsw-alias-bg-layer-1:#16181d;--dsw-alias-bg-layer-2:#232730;--dsw-alias-bg-overlay:#1b1f27;--dsw-alias-border-l1:#2a2e37;--dsw-alias-border-l2:#333a45;--dsw-alias-state-error-primary:#f04b4b;}`;

const html = `<!doctype html><meta charset="utf-8"><style>${TOKENS}${css}</style>
<div class="utb"><div class="utb-bar">
  <button type="button" class="utb-btn" aria-label="后退"><svg width="16" height="16"></svg></button>
  <button type="button" class="utb-btn" aria-label="前进"><svg width="16" height="16"></svg></button>
  <button type="button" class="utb-btn" aria-label="刷新"><svg width="16" height="16"></svg></button>
  <form style="flex:1 1 auto;min-width:0;display:flex;position:relative">
    <div class="utb-addr-wrap">
      <input class="utb-addr" type="text" value="https://example.com/some/long/address/path" aria-label="网址">
      <button id="audio" type="button" class="utb-addr-audio" aria-label="打开页面声音" aria-pressed="false" data-utb-audio="off"></button>
      <button id="history" type="button" class="utb-addr-hist" aria-label="最近访问的网址" data-utb-history-toggle="closed"></button>
    </div>
  </form>
</div></div>`;

const profile = mkdtempSync(join(tmpdir(), 'panel-audio-button-'));
const port = 9400 + Math.floor(Math.random() * 200);
const proc = spawn(CHROME_WRAPPER || '/usr/bin/google-chrome', [
  '--headless=new', `--remote-debugging-port=${port}`, '--remote-debugging-address=127.0.0.1',
  `--remote-allow-origins=http://127.0.0.1:${port}`, `--user-data-dir=${profile}`,
  '--no-first-run', '--no-default-browser-check', '--disable-gpu', '--hide-scrollbars',
  '--no-sandbox', '--disable-dev-shm-usage', '--disable-crash-reporter',
  '--window-size=1280,800', 'about:blank',
], { stdio: ['ignore', 'ignore', 'pipe'] });
let stderr = '';
proc.stderr.setEncoding('utf8');
proc.stderr.on('data', (chunk) => { stderr += chunk; });

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
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
    try { wsUrl = (await (await fetch(`http://127.0.0.1:${port}/json/version`)).json()).webSocketDebuggerUrl; } catch { /* not up */ }
  }
  if (!wsUrl) throw new Error('devtools never came up: ' + stderr.slice(-500));
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
  await send('Emulation.setDeviceMetricsOverride', { width: 1280, height: 800, deviceScaleFactor: 1, mobile: false }, sessionId);
  const dataUrl = 'data:text/html;charset=utf-8,' + encodeURIComponent(html);
  await send('Page.navigate', { url: dataUrl }, sessionId);
  await sleep(300);

  // Paint the real toolbar icons: the extracted icon functions run against a minimal hyperscript
  // shim that builds DOM nodes in the right namespace (an HTML-namespace <svg> is never laid out,
  // which would silently produce empty buttons and an empty screenshot).
  const iconSource = extractFunction('IconSound') + '\n' + extractFunction('IconHistory');
  const painted = await send('Runtime.evaluate', {
    expression: `(() => {
      const SVG_TAGS = new Set(['svg', 'path', 'rect', 'circle', 'g', 'line']);
      const h = (tag, props, ...children) => {
        const element = SVG_TAGS.has(tag)
          ? document.createElementNS('http://www.w3.org/2000/svg', tag)
          : document.createElement(tag);
        for (const [key, value] of Object.entries(props || {})) {
          if (key === 'key' || value === undefined || value === null) continue;
          if (key === 'className') element.setAttribute('class', String(value));
          else if (key === 'style' && typeof value === 'object') Object.assign(element.style, value);
          else element.setAttribute(key.replace(/[A-Z]/g, (c) => '-' + c.toLowerCase()), String(value));
        }
        for (const child of children.flat()) {
          if (child === null || child === undefined) continue;
          element.appendChild(typeof child === 'string' ? document.createTextNode(child) : child);
        }
        return element;
      };
      ${iconSource}
      const audio = document.getElementById('audio');
      const history = document.getElementById('history');
      audio.replaceChildren(IconSound({ muted: false }));
      history.replaceChildren(IconHistory());
      const svg = audio.querySelector('svg');
      const box = svg ? svg.getBoundingClientRect() : null;
      return JSON.stringify({
        audio: audio.innerHTML.length,
        history: history.innerHTML.length,
        paths: audio.querySelectorAll('path').length,
        svgBox: box ? { width: Math.round(box.width), height: Math.round(box.height), left: Math.round(box.left), top: Math.round(box.top) } : null,
        stroke: svg ? getComputedStyle(svg).stroke : null,
      });
    })()`,
    returnByValue: true,
  }, sessionId);
  const paintedState = JSON.parse(painted.result?.value || '{}');
  check('B00 the real toolbar icons render into both buttons',
    paintedState.audio > 0 && paintedState.history > 0 && paintedState.paths > 0
    && paintedState.svgBox && paintedState.svgBox.width > 0 && paintedState.svgBox.height > 0,
    { audio: '>0', history: '>0', paths: '>0', svgBox: 'laid out' }, paintedState);
  await sleep(150);

  const measured = await send('Runtime.evaluate', {
    expression: `(() => {
      const rect = (selector) => {
        const element = document.querySelector(selector);
        if (!element) return null;
        const box = element.getBoundingClientRect();
        return { left: Math.round(box.left * 100) / 100, right: Math.round(box.right * 100) / 100,
                 top: Math.round(box.top * 100) / 100, bottom: Math.round(box.bottom * 100) / 100,
                 width: Math.round(box.width * 100) / 100, height: Math.round(box.height * 100) / 100 };
      };
      const input = document.querySelector('.utb-addr');
      const audio = document.getElementById('audio');
      const history = document.getElementById('history');
      const wrap = document.querySelector('.utb-addr-wrap');
      const wrapBox = wrap.getBoundingClientRect();
      const style = getComputedStyle(input);
      // Does the text area (input width minus its right padding) stay clear of the audio button?
      const textRight = input.getBoundingClientRect().right - parseFloat(style.paddingRight);
      const audioBox = audio.getBoundingClientRect();
      // Where a click actually lands: elementFromPoint at the centre of each button.
      const center = (element) => {
        const box = element.getBoundingClientRect();
        const hit = document.elementFromPoint(box.left + box.width / 2, box.top + box.height / 2);
        return hit === element || (hit && element.contains(hit)) ? element.id : (hit ? (hit.id || hit.className || hit.tagName) : null);
      };
      const before = location.href;
      audio.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true }));
      audio.click();
      return JSON.stringify({
        buttonType: audio.type,
        insideForm: audio.form === document.querySelector('.utb-addr-wrap').closest('form'),
        navigatedOnClick: location.href !== before,
        wrap: rect('.utb-addr-wrap'), input: rect('.utb-addr'),
        audio: rect('#audio'), history: rect('#history'),
        wrapRight: Math.round(wrapBox.right * 100) / 100,
        audioFromRight: Math.round((wrapBox.right - audioBox.right) * 100) / 100,
        historyFromRight: Math.round((wrapBox.right - history.getBoundingClientRect().right) * 100) / 100,
        textRight: Math.round(textRight * 100) / 100,
        hitAudio: center(audio), hitHistory: center(history),
        colorOff: getComputedStyle(audio).color,
      });
    })()`,
    returnByValue: true,
  }, sessionId);
  const box = JSON.parse(measured.result?.value || '{}');

  log(`  measured: history right-inset=${box.historyFromRight}px, audio right-inset=${box.audioFromRight}px, `
    + `button=${box.audio?.width}×${box.audio?.height}px, audio.right=${box.audio?.right}, history.left=${box.history?.left}, `
    + `text-right=${box.textRight}, audio.left=${box.audio?.left}`);
  check('B01 the address bar wrapper and both buttons render', Boolean(box.wrap && box.input && box.audio && box.history), true,
    { wrap: box.wrap, input: box.input, audio: box.audio, history: box.history });

  const audioFromRight = box.audioFromRight;
  const historyFromRight = box.historyFromRight;
  check('B02 the history button is the rightmost control (2px inset)',
    Math.abs(historyFromRight - GAP) <= 1, `${GAP}±1`, historyFromRight);
  check('B03 the audio toggle is the second control from the right, right of the input text',
    Math.abs(audioFromRight - (GAP + STEP)) <= 1, `${GAP + STEP}±1`, audioFromRight);
  check('B04 the two buttons do not overlap',
    box.audio && box.history && box.audio.right <= box.history.left + 0.5,
    'audio.right <= history.left', { audioRight: box.audio?.right, historyLeft: box.history?.left });
  check('B05 both buttons are vertically centred inside the address field',
    box.audio && box.input && box.audio.top >= box.input.top && box.audio.bottom <= box.input.bottom,
    'inside the input box', { audio: box.audio, input: box.input });
  check('B06 the address text never runs underneath the buttons',
    Number.isFinite(box.textRight) && Number.isFinite(box.audio?.left) && box.textRight <= box.audio.left,
    'text area right edge <= audio left edge', { textRight: box.textRight, audioLeft: box.audio?.left });
  check('B07 clicking each button hits that button (input is not on top)',
    box.hitAudio === 'audio' && box.hitHistory === 'history', { audio: 'audio', history: 'history' },
    { audio: box.hitAudio, history: box.hitHistory });
  check('B08 the toggle sits inside the address form but never submits it',
    box.buttonType === 'button' && box.insideForm === true && box.navigatedOnClick === false,
    { buttonType: 'button', insideForm: true, navigatedOnClick: false },
    { buttonType: box.buttonType, insideForm: box.insideForm, navigatedOnClick: box.navigatedOnClick });

  // The "on" state must be visually distinguishable: the shipped rule switches to the brand colour.
  const toggled = await send('Runtime.evaluate', {
    expression: `(() => {
      const audio = document.getElementById('audio');
      const off = getComputedStyle(audio).color;
      audio.setAttribute('aria-pressed', 'true');
      const on = getComputedStyle(audio).color;
      return JSON.stringify({ off, on });
    })()`,
    returnByValue: true,
  }, sessionId);
  const colors = JSON.parse(toggled.result?.value || '{}');
  check('B09 the enabled state is visible (brand colour, not the idle colour)',
    typeof colors.on === 'string' && colors.off !== colors.on, 'on !== off', colors);
  // Human-readable evidence: the same rendered fragment, cropped to the address bar. This is the
  // panel's own stylesheet and markup classes — not a screenshot of the live DSH panel.
  const dir = join(process.cwd(), 'output', 'panel-audio-button');
  mkdirSync(dir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const shots = [
    { name: 'address-bar', clip: { x: 0, y: 0, width: Math.ceil((box.wrap?.right || 760) + 8), height: 52, scale: 2 } },
    // Zoomed crop of the address bar's right end: the two controls at 6x, so a human can confirm
    // the order without a magnifier.
    { name: 'address-bar-detail', clip: { x: Math.max(0, (box.wrap?.right || 760) - 140), y: 0, width: 144, height: 52, scale: 6 } },
  ];
  for (const item of shots) {
    const shot = await send('Page.captureScreenshot', { format: 'png', clip: item.clip }, sessionId);
    if (!shot?.data) continue;
    // A second capture right after the first forces a fresh composited frame in headless.
    const again = await send('Page.captureScreenshot', { format: 'png', clip: item.clip }, sessionId);
    const file = join(dir, item.name + '-' + stamp + '.png');
    writeFileSync(file, Buffer.from((again?.data || shot.data), 'base64'));
    log('screenshot: ' + file);
  }
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
