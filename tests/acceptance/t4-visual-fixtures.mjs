#!/usr/bin/env node
/**
 * WEB-T4 preparation acceptance: deterministic dynamic-visual fixture.
 *
 * Contract: tests/ui_test_fixture/t4-prep-contract.md §1 (Lead-frozen) and
 *           tests/ui_test_fixture/t4-visual.md (fixture truth table).
 *
 * This suite is independent, zero-dependency and single-driver:
 *   flock /tmp/dsh-t4-browser.lock node tests/acceptance/t4-visual-fixtures.mjs
 *
 * It starts the repository's own fixture server, mounts the real plugin entry (index.js) on the
 * fake Cordis context through tests/acceptance/harness.mjs, and drives ONLY the registered
 * browser_* tools. No CDP shim, no playwright/puppeteer/selenium, no network access.
 *
 * Evidence: tests/acceptance/runs/<ISO>-<pid>/run-report.json + run.log + PNG screenshots.
 * Exit codes: 0 = every required check passed; 1 = at least one required check failed;
 *             2 = the suite could not produce complete evidence (no Chromium/fixture, fatal
 *                 error/timeout, or a required check is NOT_RUN).
 */
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = dirname(dirname(HERE));
const RUN_DIR = join(HERE, 'runs', `${new Date().toISOString().replace(/[:.]/g, '-')}-${process.pid}`);
const TOTAL_TIMEOUT_MS = Number(process.env.DSH_T4_VISUAL_TIMEOUT_MS || 240000) || 240000;
const EXEC_ID = 't4-visual-acceptance';
const FIXTURE_PAGE = '/web-t4-visual.html';

// Set the persistent capture root BEFORE importing harness.mjs: every browser_screenshot in this
// run must land inside this run directory (never in the repository's output/ or a temp root).
await mkdir(RUN_DIR, { recursive: true });
process.env.DSH_UI_TESTING_CAPTURE_DIR = RUN_DIR;

const logLines = [];
function log(line = '') {
  const text = String(line);
  logLines.push(text);
  console.log(text);
}
function errorMessage(error) {
  return String((error && error.message) || error);
}
function truncate(value, max = 500) {
  const text = typeof value === 'string' ? value : JSON.stringify(value);
  if (text === undefined) return '';
  return text.length > max ? `${text.slice(0, max)}…` : text;
}
function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}
function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
function jsonSafe(value, depth = 0) {
  if (value === undefined) return undefined;
  if (value === null || typeof value !== 'object') return value;
  if (depth > 7) return '[depth-limit]';
  if (Array.isArray(value)) return value.slice(0, 100).map((item) => jsonSafe(item, depth + 1));
  if (Buffer.isBuffer(value)) return `[Buffer ${value.length} bytes]`;
  const out = {};
  for (const [key, item] of Object.entries(value)) {
    if (key === 'image' || key === 'base64') { out[key] = '[base64 omitted]'; continue; }
    if (key === 'stack') { out[key] = String(item).split('\n').slice(0, 8).join('\n'); continue; }
    out[key] = jsonSafe(item, depth + 1);
  }
  return out;
}

const report = {
  schemaVersion: 1,
  suite: 'dsh-agent-team-ui-testing/acceptance-t4-visual-fixtures',
  contract: 'tests/ui_test_fixture/t4-prep-contract.md §1',
  generatedAt: new Date().toISOString(),
  command: 'flock /tmp/dsh-t4-browser.lock node tests/acceptance/t4-visual-fixtures.mjs',
  environment: {},
  probes: [],
  images: [],
  notRun: [],
  findings: [],
  resources: {},
  summary: {},
};

function makeProbe(id, title, expected) {
  return {
    id,
    title,
    expected,
    status: 'pass',
    startedAt: new Date().toISOString(),
    durationMs: 0,
    checks: [],
    notRun: [],
    actual: '',
    error: undefined,
  };
}

function addCheck(probe, label, pass, detail = {}, options = {}) {
  const entry = {
    label,
    expected: jsonSafe(detail.expected),
    actual: jsonSafe(detail.actual),
    pass: Boolean(pass),
    advisory: Boolean(options.advisory),
  };
  probe.checks.push(entry);
  if (!entry.pass && !entry.advisory) probe.status = 'fail';
  log(`  [${entry.pass ? 'PASS' : entry.advisory ? 'INFO' : 'FAIL'}] ${label}`);
  if (!entry.pass) {
    log(`         expected: ${truncate(entry.expected)}`);
    log(`         actual  : ${truncate(entry.actual)}`);
  }
  return entry;
}

async function runProbe(meta, body) {
  const probe = makeProbe(meta.id, meta.title, meta.expected);
  const startedAt = Date.now();
  log(`\n== ${meta.id} — ${meta.title}`);
  const check = (label, pass, detail, options) => addCheck(probe, label, pass, detail, options);
  const notRun = (label, reason) => {
    probe.notRun.push({ label, reason: String(reason) });
    report.notRun.push({ probeId: probe.id, label, reason: String(reason) });
    log(`  [NOT_RUN] ${label}: ${reason}`);
  };
  try {
    await body({ probe, check, notRun });
  } catch (error) {
    probe.status = 'fail';
    probe.error = { name: error?.name, message: errorMessage(error), stack: String(error?.stack || '').split('\n').slice(0, 8) };
    addCheck(probe, 'probe completes without throwing', false, {
      expected: 'probe completes',
      actual: { name: error?.name, message: errorMessage(error) },
    });
  }
  probe.durationMs = Date.now() - startedAt;
  const required = probe.checks.filter((entry) => !entry.advisory);
  const failed = required.filter((entry) => !entry.pass);
  if (failed.length > 0) probe.status = 'fail';
  else if (probe.notRun.length > 0) probe.status = 'partial';
  else if (probe.status !== 'fail') probe.status = 'pass';
  probe.actual = failed.length
    ? `${failed.length}/${required.length} required checks failed: ${failed.map((entry) => entry.label).join('; ')}`
    : `${required.length} required checks passed${probe.notRun.length ? ` (+${probe.notRun.length} NOT_RUN)` : ''}`;
  report.probes.push(probe);
  log(`== ${meta.id} ${probe.status.toUpperCase()} (${probe.durationMs}ms) — ${probe.actual}`);
  return probe;
}

/* ------------------------------------------------------------------------------------------------
 * Runtime plumbing
 * ---------------------------------------------------------------------------------------------- */

let fixture = null;
let harness = null;
let harnessModule = null;
const state = {
  finished: false,
  cleanupResult: null,
  ownedProfiles: new Set(),
  baselineProfiles: new Set(),
  baselinePids: new Set(),
};

function execOf() {
  return { agent: { id: EXEC_ID } };
}

async function call(tool, args = {}, exec) {
  return harness.invoke(tool, args, exec === undefined ? execOf() : exec);
}

async function evalValue(expression, exec) {
  const result = await call('browser_eval', { expression }, exec);
  if (!result.ok) throw new Error(`browser_eval threw: ${errorMessage(result.error)}`);
  if (!result.value?.ok) throw new Error(`browser_eval value error: ${truncate(result.value?.error)}`);
  return result.value.value;
}

async function waitFor(predicate, { timeoutMs = 10000, intervalMs = 100, label = 'condition' } = {}) {
  const startedAt = Date.now();
  let last;
  while (Date.now() - startedAt < timeoutMs) {
    try {
      last = await predicate();
      if (last) return last;
    } catch (error) {
      last = { error: errorMessage(error) };
    }
    await sleep(intervalMs);
  }
  throw new Error(`timed out after ${timeoutMs}ms waiting for ${label}; last=${truncate(last)}`);
}

async function waitReady() {
  await waitFor(async () => {
    const value = await evalValue(`({
      ready: document.body.dataset.t4vReady,
      hasApi: !!(window.__t4 && window.__t4.visual),
      title: document.title
    })`);
    return value.ready === 'true' && value.hasApi ? value : undefined;
  }, { timeoutMs: 20000, label: 'T4 visual page ready' });
}

async function pageState() {
  return evalValue('window.__t4.visual.state()');
}

async function seek(ms) {
  return evalValue(`window.__t4.visual.seek(${Number(ms)})`);
}

async function setScenario(name) {
  return evalValue(`window.__t4.visual.setScenario(${JSON.stringify(name)})`);
}

async function setPaused(value) {
  return evalValue(`window.__t4.visual.setPaused(${Boolean(value)})`);
}

async function samplePanel(name) {
  return evalValue(`window.__t4.visual.samplePanel(${JSON.stringify(name)})`);
}

async function waitClockAbove(ms, timeoutMs = 8000) {
  await waitFor(async () => {
    const now = await evalValue('window.__t4.visual.clock.nowMs');
    return now > ms ? now : undefined;
  }, { timeoutMs, label: `clock.nowMs > ${ms}` });
}

async function waitMediaStalled(timeoutMs = 8000) {
  await waitFor(async () => {
    const media = await samplePanel('media');
    return media.stalled && media.currentTimeMs >= 1200 ? media : undefined;
  }, { timeoutMs, label: 'media stalled at >= 1200ms' });
}

function dominantChannel(sample) {
  const entries = [
    ['r', Number(sample?.r) || 0],
    ['g', Number(sample?.g) || 0],
    ['b', Number(sample?.b) || 0],
  ].sort((left, right) => right[1] - left[1]);
  return {
    dominant: entries[0][0],
    top: entries[0][1],
    second: entries[1][1],
    margin: entries[0][1] - entries[1][1],
  };
}

function isHex8(value) {
  return typeof value === 'string' && /^[0-9a-f]{8}$/.test(value);
}

function pngInfo(base64) {
  const bytes = Buffer.from(String(base64 || ''), 'base64');
  const signatureOk = bytes.length > 24 && bytes.toString('latin1', 1, 4) === 'PNG';
  return {
    ok: signatureOk,
    bytes: bytes.length,
    sha256: bytes.length ? sha256(bytes) : null,
    width: signatureOk ? bytes.readUInt32BE(16) : null,
    height: signatureOk ? bytes.readUInt32BE(20) : null,
  };
}

function recordImage(label, value, absolutePath) {
  const info = pngInfo(value?.image);
  const file = value?.capture?.file || null;
  const entry = {
    label,
    path: file?.path || null,
    absolutePath: absolutePath || null,
    pathKind: file?.pathKind || null,
    persistence: file?.persistence || null,
    width: info.width,
    height: info.height,
    bytes: info.bytes,
    sha256: info.sha256,
    fileSha256: file?.sha256 || null,
    mode: file?.mode || null,
  };
  report.images.push(entry);
  return entry;
}

/* ------------------------------------------------------------------------------------------------
 * Probes
 * ---------------------------------------------------------------------------------------------- */

async function probePageLoad({ check }) {
  const navigation = await call('browser_navigate', { url: fixture.url + FIXTURE_PAGE.slice(1) });
  check('navigation to /web-t4-visual.html succeeds', navigation.ok && navigation.value?.ok === true, {
    expected: 'ok', actual: navigation.value ? { ok: navigation.value.ok } : navigation.error,
  });
  await waitReady();

  const facts = await evalValue(`(function () {
    var ids = ['t4v-title','t4v-subtitle','t4v-status','t4v-panel-css','t4v-panel-canvas2d','t4v-panel-webgl','t4v-panel-media',
      't4v-css-orb','t4v-canvas2d','t4v-canvas-webgl','t4v-video','t4v-pause','t4v-resume','t4v-reset',
      't4v-scenario-select','t4v-seek','t4v-seek-value','t4v-step-back','t4v-step-forward'];
    var missing = ids.filter(function (id) { return !document.getElementById(id); });
    var cards = Array.from(document.querySelectorAll('section.t4v-card[data-panel]')).map(function (element) {
      return { id: element.id, panel: element.dataset.panel };
    });
    var select = document.getElementById('t4v-scenario-select');
    var seek = document.getElementById('t4v-seek');
    var controls = window.__t4.visual.controls || {};
    return {
      title: document.getElementById('t4v-title').textContent,
      missing: missing,
      cards: cards,
      scenarioOptions: Array.from(select.options).map(function (option) { return option.value; }),
      seek: { min: seek.min, max: seek.max, step: seek.step, value: seek.value },
      bodyScenario: document.body.dataset.t4vScenario,
      bodyPaused: document.body.dataset.t4vPaused,
      version: window.__t4.visual.version,
      fixture: window.__t4.visual.fixture,
      truth: JSON.parse(JSON.stringify(window.__t4.visual.truth)),
      controlFunctions: ['pause','resume','reset','seek','setScenario','state','samplePanel']
        .filter(function (name) { return typeof controls[name] === 'function'; }),
      resourceOrigins: performance.getEntriesByType('resource').map(function (entry) {
        return new URL(entry.name).origin;
      }),
      origin: location.origin,
      externalNodes: Array.from(document.querySelectorAll('script[src], link[href], img[src], iframe[src]')).map(function (element) {
        return element.getAttribute('src') || element.getAttribute('href');
      })
    };
  })()`);

  check('title is exactly "DSH T4 动态视觉靶机"', facts.title === 'DSH T4 动态视觉靶机', {
    expected: 'DSH T4 动态视觉靶机', actual: facts.title,
  });
  check('all required stable ids exist', facts.missing.length === 0, { expected: [], actual: facts.missing });
  check('four cards expose css/canvas2d/webgl/media in order', JSON.stringify(facts.cards.map((card) => card.panel)) === JSON.stringify(['css', 'canvas2d', 'webgl', 'media']), {
    expected: ['css', 'canvas2d', 'webgl', 'media'], actual: facts.cards,
  });
  check('truth.version=1 / fixture=web-t4-visual', facts.version === 1 && facts.fixture === 'web-t4-visual', {
    expected: { version: 1, fixture: 'web-t4-visual' }, actual: { version: facts.version, fixture: facts.fixture },
  });
  check('truth.durationMs=3000 / seed=20261104 / four panels', facts.truth.durationMs === 3000
    && facts.truth.seed === 20261104
    && JSON.stringify(facts.truth.panels) === JSON.stringify(['css', 'canvas2d', 'webgl', 'media']), {
    expected: { durationMs: 3000, seed: 20261104, panels: ['css', 'canvas2d', 'webgl', 'media'] },
    actual: { durationMs: facts.truth.durationMs, seed: facts.truth.seed, panels: facts.truth.panels },
  });
  const mediaTruth = facts.truth.media || {};
  const assetOk = mediaTruth.asset === '/t4/visual/t4-visual-media.webm' && mediaTruth.fallback === null;
  const fallbackOk = mediaTruth.fallback === 'canvas-capture-stream' && typeof mediaTruth.fallbackReason === 'string';
  check('truth.media discloses either the 3s WebM asset or a fallback', assetOk || fallbackOk, {
    expected: 'asset=/t4/visual/t4-visual-media.webm & fallback=null, or fallback=canvas-capture-stream + reason',
    actual: { asset: mediaTruth.asset, fallback: mediaTruth.fallback, fallbackReason: mediaTruth.fallbackReason || null },
  });
  check('body[data-t4v-scenario=normal] and body[data-t4v-paused=false]', facts.bodyScenario === 'normal' && facts.bodyPaused === 'false', {
    expected: { scenario: 'normal', paused: 'false' }, actual: { scenario: facts.bodyScenario, paused: facts.bodyPaused },
  });
  check('scenario select has the five frozen scenarios', JSON.stringify(facts.scenarioOptions) === JSON.stringify(['normal', 'flash', 'freeze', 'jank', 'media-stall']), {
    expected: ['normal', 'flash', 'freeze', 'jank', 'media-stall'], actual: facts.scenarioOptions,
  });
  check('seek control is range 0–3000', facts.seek.min === '0' && facts.seek.max === '3000', {
    expected: { min: '0', max: '3000' }, actual: facts.seek,
  });
  check('window.__t4.visual.controls exposes all seven functions', facts.controlFunctions.length === 7, {
    expected: ['pause', 'resume', 'reset', 'seek', 'setScenario', 'state', 'samplePanel'], actual: facts.controlFunctions,
  });
  const externalOrigins = facts.resourceOrigins.filter((origin) => origin !== facts.origin);
  check('no cross-origin resource requests', externalOrigins.length === 0 && facts.externalNodes.length === 0, {
    expected: { crossOrigin: [], externalNodes: [] }, actual: { crossOrigin: externalOrigins, externalNodes: facts.externalNodes, origins: facts.resourceOrigins },
  });
  check('page fetches at least the media asset (same-origin)', facts.resourceOrigins.length >= 1, {
    expected: '>=1 same-origin resource', actual: facts.resourceOrigins,
  });
}

async function probeFourPanels({ check, notRun }) {
  await setScenario('normal');
  await seek(300);
  const at300 = await pageState();
  await seek(900);
  const at900 = await pageState();

  check('CSS animationCount >= 1 (real Web Animations API)', at300.panels.css.animationCount >= 1 && at300.panels.css.animations.length >= 1, {
    expected: '>=1', actual: { animationCount: at300.panels.css.animationCount, animations: at300.panels.css.animations },
  });
  const css300 = at300.panels.css;
  const css900 = at900.panels.css;
  check('CSS transform and opacity both change between t=300 and t=900', JSON.stringify(css300.transform) !== JSON.stringify(css900.transform)
    && css300.opacity !== css900.opacity, {
    expected: 'transform and opacity both differ', actual: { t300: { transform: css300.transform, opacity: css300.opacity }, t900: { transform: css900.transform, opacity: css900.opacity } },
  });

  const canvasContext = await evalValue("!!document.getElementById('t4v-canvas2d').getContext('2d')");
  check('Canvas2D context is 2d', canvasContext === true, { expected: true, actual: canvasContext });
  check('Canvas2D has drawn frames and an 8-hex FNV checksum', at300.panels.canvas2d.frames > 0 && isHex8(at300.panels.canvas2d.checksum), {
    expected: { frames: '>0', checksum: '8 hex' }, actual: { frames: at300.panels.canvas2d.frames, checksum: at300.panels.canvas2d.checksum },
  });

  const webgl = at300.panels.webgl;
  if (webgl.contextType === 'webgl2' || webgl.contextType === 'webgl') {
    check('WebGL context is webgl2 (or webgl fallback)', true, { expected: ['webgl2', 'webgl'], actual: webgl.contextType });
    check('WebGL renders frames and an 8-hex readPixels checksum', webgl.frames > 0 && isHex8(webgl.checksum), {
      expected: { frames: '>0', checksum: '8 hex' }, actual: { frames: webgl.frames, checksum: webgl.checksum },
    });
    check('WebGL renderer is a string or null (never fabricated)', webgl.renderer === null || typeof webgl.renderer === 'string', {
      expected: 'string|null', actual: webgl.renderer,
    });
    check('WebGPU availability is reported honestly with a reason when unavailable', typeof webgl.webgpu?.available === 'boolean'
      && (webgl.webgpu.available === true ? webgl.webgpu.reason === null : typeof webgl.webgpu.reason === 'string'), {
      expected: 'available boolean + reason null/string', actual: webgl.webgpu,
    });
  } else {
    notRun('WebGL real context + checksum', 'this Chromium/ANGLE environment reports no WebGL2/WebGL context (contextType=none)');
    notRun('WebGL renderer / WebGPU probe', 'no WebGL context to sample; WebGPU probe is still reported by the page');
  }

  const media = at300.panels.media;
  if ((at300.truth.media || {}).fallback) {
    notRun('media readyState/duration', 'fixture is running the canvas.captureStream fallback; no 3 s WebM asset to verify');
  } else {
    check('video readyState >= 2', media.readyState >= 2, { expected: '>=2', actual: media.readyState });
    check('video duration is 3000ms ±150', Math.abs(Number(media.durationMs) - 3000) <= 150, {
      expected: '3000±150', actual: media.durationMs,
    });
    const checkpoints = at300.truth.media.checkpoints || [];
    check('truth.media.checkpoints are 500/r, 1500/g, 2500/b', checkpoints.length === 3
      && checkpoints[0].ms === 500 && checkpoints[0].dominant === 'r'
      && checkpoints[1].ms === 1500 && checkpoints[1].dominant === 'g'
      && checkpoints[2].ms === 2500 && checkpoints[2].dominant === 'b', {
      expected: [{ ms: 500, dominant: 'r' }, { ms: 1500, dominant: 'g' }, { ms: 2500, dominant: 'b' }], actual: checkpoints,
    });
  }
}

async function probeSeekDeterminism({ check, notRun }) {
  await setScenario('normal');
  await seek(300);
  const first = await pageState();
  await seek(900);
  const middle = await pageState();
  await seek(300);
  const again = await pageState();

  check('seek(300) twice yields the same Canvas2D checksum', first.panels.canvas2d.checksum === again.panels.canvas2d.checksum, {
    expected: first.panels.canvas2d.checksum, actual: again.panels.canvas2d.checksum,
  });
  check('t=300 and t=900 yield different Canvas2D checksums', first.panels.canvas2d.checksum !== middle.panels.canvas2d.checksum, {
    expected: 'different', actual: { t300: first.panels.canvas2d.checksum, t900: middle.panels.canvas2d.checksum },
  });
  check('seek implicitly pauses the logical clock', again.clock.paused === true && again.clock.nowMs === 300, {
    expected: { paused: true, nowMs: 300 }, actual: { paused: again.clock.paused, nowMs: again.clock.nowMs },
  });
  check('CSS transform and opacity both change between t=300 and t=900', JSON.stringify(first.panels.css.transform) !== JSON.stringify(middle.panels.css.transform)
    && first.panels.css.opacity !== middle.panels.css.opacity, {
    expected: 'transform and opacity both differ', actual: { t300: first.panels.css, t900: middle.panels.css },
  });

  if (first.panels.webgl.contextType === 'webgl2' || first.panels.webgl.contextType === 'webgl') {
    check('seek(300) twice yields the same WebGL readPixels checksum', first.panels.webgl.checksum === again.panels.webgl.checksum, {
      expected: first.panels.webgl.checksum, actual: again.panels.webgl.checksum,
    });
    check('t=300 and t=900 yield different WebGL checksums', first.panels.webgl.checksum !== middle.panels.webgl.checksum, {
      expected: 'different', actual: { t300: first.panels.webgl.checksum, t900: middle.panels.webgl.checksum },
    });
  } else {
    notRun('WebGL same-t/different-t checksum determinism', 'no WebGL context in this environment');
  }
}

async function probeRunningAdvance({ check }) {
  await setScenario('normal');
  await seek(300);
  const before = await pageState();
  await setPaused(false);
  await sleep(350);
  const after = await pageState();
  await setPaused(true);

  check('resume advances clock.nowMs', after.clock.nowMs > before.clock.nowMs + 100, {
    expected: `> ${before.clock.nowMs + 100}`, actual: after.clock.nowMs,
  });
  check('resume advances Canvas2D frames/draws', after.panels.canvas2d.frames > before.panels.canvas2d.frames
    && after.panels.canvas2d.draws > before.panels.canvas2d.draws, {
    expected: { frames: `> ${before.panels.canvas2d.frames}`, draws: `> ${before.panels.canvas2d.draws}` },
    actual: { frames: after.panels.canvas2d.frames, draws: after.panels.canvas2d.draws },
  });
  const cssBefore = before.panels.css.animations[0]?.currentTimeMs;
  const cssAfter = after.panels.css.animations[0]?.currentTimeMs;
  check('resume advances the CSS animation currentTime', Number(cssAfter) > Number(cssBefore), {
    expected: `> ${cssBefore}`, actual: cssAfter,
  });
}

async function probeVideo({ check, notRun }) {
  const stateNow = await pageState();
  if ((stateNow.truth.media || {}).fallback) {
    notRun('video play/pause/seek checks', 'fixture is running the canvas.captureStream fallback; video seek is not verifiable');
    return;
  }
  await setScenario('normal');
  await seek(0);
  await setPaused(false);
  await waitFor(async () => {
    const media = await samplePanel('media');
    return media.currentTimeMs > 100 && media.frameCount > 0 ? media : undefined;
  }, { timeoutMs: 6000, label: 'video playing with frames' });
  const playingA = await samplePanel('media');
  await sleep(320);
  const playingB = await samplePanel('media');
  check('play advances video currentTime', playingB.currentTimeMs > playingA.currentTimeMs + 100, {
    expected: `> ${playingA.currentTimeMs + 100}`, actual: playingB.currentTimeMs,
  });
  check('play advances frameCount or changes the sampled RGB', playingB.frameCount > playingA.frameCount
    || JSON.stringify(playingB.sample) !== JSON.stringify(playingA.sample), {
    expected: 'frameCount grows or sample changes', actual: { frameA: playingA.frameCount, frameB: playingB.frameCount, sampleA: playingA.sample, sampleB: playingB.sample },
  });

  await setPaused(true);
  const pausedA = await samplePanel('media');
  await sleep(260);
  const pausedB = await samplePanel('media');
  check('pause keeps currentTime drift < 80ms', Math.abs(pausedB.currentTimeMs - pausedA.currentTimeMs) < 80, {
    expected: '<80ms', actual: { before: pausedA.currentTimeMs, after: pausedB.currentTimeMs },
  });
  check('pause keeps the sampled RGB unchanged', JSON.stringify(pausedB.sample) === JSON.stringify(pausedA.sample), {
    expected: pausedA.sample, actual: pausedB.sample,
  });

  const checkpoints = [
    { ms: 500, dominant: 'r' },
    { ms: 1500, dominant: 'g' },
    { ms: 2500, dominant: 'b' },
  ];
  for (const checkpoint of checkpoints) {
    await seek(checkpoint.ms);
    const media = await samplePanel('media');
    const dominant = dominantChannel(media.sample);
    check(`seek(${checkpoint.ms}) sample is dominated by ${checkpoint.dominant} (margin >= 12)`, dominant.dominant === checkpoint.dominant && dominant.margin >= 12, {
      expected: { dominant: checkpoint.dominant, margin: '>=12' }, actual: { sample: media.sample, ...dominant, currentTimeMs: media.currentTimeMs },
    });
  }
}

async function probeFlash({ check }) {
  await setScenario('normal');
  await seek(648);
  const normal648 = await pageState();
  await setScenario('flash');
  await seek(648);
  const flash648 = await pageState();
  await setScenario('flash');
  await seek(600);
  const flash600 = await pageState();

  check('normal t=648 does not flash', normal648.panels.canvas2d.flash === false, {
    expected: false, actual: normal648.panels.canvas2d.flash,
  });
  check('flash t=648 draws a white frame (flash=true)', flash648.panels.canvas2d.flash === true, {
    expected: true, actual: flash648.panels.canvas2d.flash,
  });
  check('flash t=648 records flashFrames', flash648.anomalies.flashFrames.length >= 1, {
    expected: '>=1', actual: flash648.anomalies.flashFrames,
  });
  check('flash t=648 checksum differs from normal t=648', flash648.panels.canvas2d.checksum !== normal648.panels.canvas2d.checksum, {
    expected: 'different', actual: { normal: normal648.panels.canvas2d.checksum, flash: flash648.panels.canvas2d.checksum },
  });
  check('flash t=600 does not flash and records no flashFrames', flash600.panels.canvas2d.flash === false && flash600.anomalies.flashFrames.length === 0, {
    expected: { flash: false, flashFrames: [] }, actual: { flash: flash600.panels.canvas2d.flash, flashFrames: flash600.anomalies.flashFrames },
  });
}

async function probeFreeze({ check }) {
  await setScenario('freeze');
  await setPaused(false);
  await waitClockAbove(1200);
  const first = await pageState();
  await sleep(300);
  const second = await pageState();
  await setPaused(true);

  check('freeze sets frozen=true after t>=800', first.panels.canvas2d.frozen === true && first.anomalies.frozenAtMs === 800, {
    expected: { frozen: true, frozenAtMs: 800 }, actual: { frozen: first.panels.canvas2d.frozen, frozenAtMs: first.anomalies.frozenAtMs },
  });
  check('freeze stops Canvas2D frames and checksum', second.panels.canvas2d.frames === first.panels.canvas2d.frames
    && second.panels.canvas2d.checksum === first.panels.canvas2d.checksum, {
    expected: { frames: first.panels.canvas2d.frames, checksum: first.panels.canvas2d.checksum },
    actual: { frames: second.panels.canvas2d.frames, checksum: second.panels.canvas2d.checksum },
  });
  check('freeze keeps CSS animating', Number(second.panels.css.animations[0]?.currentTimeMs) > Number(first.panels.css.animations[0]?.currentTimeMs), {
    expected: `> ${first.panels.css.animations[0]?.currentTimeMs}`, actual: second.panels.css.animations[0]?.currentTimeMs,
  });
}

async function probeJank({ check }) {
  await setScenario('jank');
  await setPaused(false);
  await waitClockAbove(1200);
  const stateNow = await pageState();
  await setPaused(true);

  check('jank records >=5 skipped frames after ~1200ms', stateNow.anomalies.jankFrames.length >= 5, {
    expected: '>=5', actual: { count: stateNow.anomalies.jankFrames.length, frames: stateNow.anomalies.jankFrames.slice(-8) },
  });
  check('jank Canvas2D frames < clock.frame (frames were really dropped)', stateNow.panels.canvas2d.frames < stateNow.clock.frame, {
    expected: `< ${stateNow.clock.frame}`, actual: stateNow.panels.canvas2d.frames,
  });
  check('jankFrames are frame numbers', stateNow.anomalies.jankFrames.every((frame) => Number.isInteger(frame)), {
    expected: 'integers', actual: stateNow.anomalies.jankFrames.slice(-5),
  });
}

async function probeMediaStall({ check, notRun }) {
  const stateNow = await pageState();
  if ((stateNow.truth.media || {}).fallback) {
    notRun('media-stall check', 'fixture is running the canvas.captureStream fallback; video currentTime is not verifiable');
    return;
  }
  await setScenario('media-stall');
  await setPaused(false);
  await waitMediaStalled();
  const first = await pageState();
  await sleep(400);
  const second = await pageState();
  await setPaused(true);

  check('media-stall sets stalled=true and anomalies.mediaStalled=true', first.panels.media.stalled === true && first.anomalies.mediaStalled === true, {
    expected: { stalled: true, mediaStalled: true }, actual: { stalled: first.panels.media.stalled, mediaStalled: first.anomalies.mediaStalled },
  });
  check('media-stall currentTime drift < 80ms after 400ms', Math.abs(second.panels.media.currentTimeMs - first.panels.media.currentTimeMs) < 80, {
    expected: '<80ms', actual: { before: first.panels.media.currentTimeMs, after: second.panels.media.currentTimeMs },
  });
  check('media-stall leaves the other panels running', second.clock.nowMs > first.clock.nowMs + 200
    && second.panels.canvas2d.frames > first.panels.canvas2d.frames, {
    expected: { clockDelta: '>200ms', canvasFrames: 'grows' },
    actual: { clockDelta: second.clock.nowMs - first.clock.nowMs, canvasFrames: [first.panels.canvas2d.frames, second.panels.canvas2d.frames] },
  });
}

async function probeOperationToVisual({ check }) {
  await setScenario('normal');
  await seek(0);
  await setPaused(false);
  await sleep(120);
  const click = await call('browser_click', { selector: '#t4v-pause' });
  check('browser_click on #t4v-pause succeeds', click.ok && click.value?.ok === true, {
    expected: 'ok', actual: click.value ? { ok: click.value.ok } : click.error,
  });
  await sleep(150);
  const stateNow = await pageState();
  const clickOps = stateNow.ops.filter((op) => op.kind === 'click' && op.target === 't4v-pause');
  const clickOp = clickOps[clickOps.length - 1];
  check('ops records the pause click with an opId', Boolean(clickOp && typeof clickOp.opId === 'string'), {
    expected: 'click op with opId', actual: clickOps.slice(-2),
  });
  check('clock.paused=true and body[data-t4v-paused=true] after the click', stateNow.clock.paused === true
    && stateNow.panels.media.frozen === true, {
    expected: { paused: true, mediaFrozen: true }, actual: { paused: stateNow.clock.paused, mediaFrozen: stateNow.panels.media.frozen },
  });
  const linked = clickOp
    ? stateNow.timeline.filter((item) => item.domain === 'visual' && item.causeOpId === clickOp.opId)
    : [];
  check('timeline has a visual event linked by causeOpId to the click op', linked.length >= 1, {
    expected: `visual event with causeOpId=${clickOp?.opId}`, actual: linked.slice(-3),
  });
  check('body[data-t4v-paused=true] is synchronized', await evalValue("document.body.dataset.t4vPaused") === 'true', {
    expected: 'true', actual: await evalValue("document.body.dataset.t4vPaused"),
  });
}

async function probeScreenshots({ check }) {
  await setScenario('normal');
  await seek(300);
  const layout = await evalValue(`({
    scrollHeight: document.documentElement.scrollHeight,
    innerHeight: window.innerHeight,
    scrollY: window.scrollY
  })`);
  check('page fits the 1280x800 viewport so the default screenshot is the whole page', layout.scrollHeight <= 800
    && layout.scrollY === 0, {
    expected: { scrollHeight: '<=800', scrollY: 0 }, actual: layout,
  });

  const full = await call('browser_screenshot', { out: 't4-visual-full.png', persist: true });
  const fullInfo = pngInfo(full.value?.image);
  const fullFile = full.value?.capture?.file;
  const fullPath = fullFile?.pathKind === 'relative' ? join(RUN_DIR, fullFile.path) : null;
  check('full-page screenshot returns a PNG', full.ok && full.value?.ok !== false && fullInfo.ok, {
    expected: 'PNG', actual: { invokeOk: full.ok, png: { width: fullInfo.width, height: fullInfo.height, bytes: fullInfo.bytes } },
  });
  check('full-page screenshot is 1280x800', fullInfo.width === 1280 && fullInfo.height === 800, {
    expected: { width: 1280, height: 800 }, actual: { width: fullInfo.width, height: fullInfo.height },
  });
  check('full-page screenshot persisted inside the run directory', Boolean(fullPath && existsSync(fullPath)), {
    expected: join(RUN_DIR, 't4-visual-full.png'), actual: fullFile || null,
  });
  if (fullPath && existsSync(fullPath)) {
    const disk = await readFile(fullPath);
    check('full-page screenshot sha256 matches the decoded PNG and disk bytes', fullInfo.sha256 === sha256(disk)
      && fullFile?.sha256 === fullInfo.sha256, {
      expected: fullInfo.sha256, actual: { disk: sha256(disk), file: fullFile?.sha256 },
    });
    const info = await stat(fullPath);
    check('full-page screenshot file mode is 0600', (info.mode & 0o777) === 0o600, {
      expected: '0600', actual: (info.mode & 0o777).toString(8),
    });
    recordImage('t4-visual-full', full.value, fullPath);
  } else {
    check('full-page screenshot sha256/mode checks', false, { expected: 'file on disk', actual: null });
    recordImage('t4-visual-full', full.value, fullPath);
  }

  const rect = await evalValue(`(function () {
    var a = document.getElementById('t4v-panel-canvas2d').getBoundingClientRect();
    var b = document.getElementById('t4v-panel-webgl').getBoundingClientRect();
    var x = Math.min(a.x, b.x);
    var y = Math.min(a.y, b.y);
    return { x: x, y: y, width: Math.max(a.right, b.right) - x, height: Math.max(a.bottom, b.bottom) - y };
  })()`);
  const region = {
    x: Math.round(rect.x),
    y: Math.round(rect.y),
    width: Math.round(rect.width),
    height: Math.round(rect.height),
  };
  const panels = await call('browser_screenshot', { region, out: 't4-visual-panels.png', persist: true });
  const panelsInfo = pngInfo(panels.value?.image);
  const panelsFile = panels.value?.capture?.file;
  const panelsPath = panelsFile?.pathKind === 'relative' ? join(RUN_DIR, panelsFile.path) : null;
  check('two-card region screenshot has the requested dimensions', panels.ok && panelsInfo.width === region.width
    && panelsInfo.height === region.height, {
    expected: { width: region.width, height: region.height }, actual: { width: panelsInfo.width, height: panelsInfo.height },
  });
  check('two-card screenshot persisted inside the run directory', Boolean(panelsPath && existsSync(panelsPath)), {
    expected: join(RUN_DIR, 't4-visual-panels.png'), actual: panelsFile || null,
  });
  if (panelsPath && existsSync(panelsPath)) {
    const disk = await readFile(panelsPath);
    check('two-card screenshot sha256 matches disk bytes', panelsInfo.sha256 === sha256(disk), {
      expected: panelsInfo.sha256, actual: sha256(disk),
    });
    recordImage('t4-visual-panels', panels.value, panelsPath);
  } else {
    check('two-card screenshot sha256', false, { expected: 'file on disk', actual: null });
    recordImage('t4-visual-panels', panels.value, panelsPath);
  }
}

async function probeNoOverreach({ check }) {
  const caps = await call('browser_capabilities', {});
  const value = caps.value || {};
  const entries = value.capabilities || [];
  const byId = (id) => entries.find((entry) => entry.id === id);
  const aggregate = byId('web.t4.dynamic-behavior');
  check('browser_capabilities call succeeds', caps.ok && value.ok === true, { expected: true, actual: { invokeOk: caps.ok, valueOk: value.ok } });
  check('aggregate capability web.t4.dynamic-behavior is available (T4 is registered, not a draft)', aggregate?.status === 'available', {
    expected: { id: 'web.t4.dynamic-behavior', status: 'available' }, actual: aggregate || null,
  });
  const alias = byId('web.t4.dynamic-vision');
  check('legacy web.t4.dynamic-vision survives as an explicit alias of the aggregate', alias?.status === 'available' && alias?.aliasOf === 'web.t4.dynamic-behavior', {
    expected: { id: 'web.t4.dynamic-vision', status: 'available', aliasOf: 'web.t4.dynamic-behavior' }, actual: alias || null,
  });
  const names = harness.toolNames();
  const expected = harnessModule.EXPECTED_TOOLS.map((tool) => tool.name).sort();
  const actual = [...names].sort();
  check(`registered tool surface is exactly ${expected.length} (30 legacy + 5 T4)`, names.length === expected.length, {
    expected: expected.length, actual: names.length,
  });
  check('registered tool names match the frozen harness table (no missing, no extra)', JSON.stringify(actual) === JSON.stringify(expected), {
    expected, actual,
  });
  const t4 = harnessModule.T4_TOOLS.map((tool) => tool.name);
  check('the five T4 tools are really registered (no stub, no draft name)', t4.length === 5 && t4.every((name) => names.includes(name)), {
    expected: t4, actual: names.filter((name) => t4.includes(name)),
  });
  // The prep-round claim "T4 dynamic vision: not implemented" must not survive implementation:
  // capabilities are the Agent's discovery surface, so a stale sentence there is a real defect.
  // A pointer such as "T4 lives in capabilities.dynamic" is honest and allowed.
  const notImplemented = value.limits?.vision?.notImplemented || [];
  const staleVision = notImplemented.filter((entry) => /T4/i.test(String(entry))
    && /not implemented|unsupported|未实现/i.test(String(entry)) && !/capabilities\.dynamic/i.test(String(entry)));
  check('no stale "T4 not implemented" claim survives in limits.vision.notImplemented', staleVision.length === 0, {
    expected: 'no stale T4 entry (a pointer to capabilities.dynamic is allowed)', actual: { staleVision, notImplemented },
  });
  const emptyNotImplemented = entries.filter((entry) => (entry.constraints || []).some((line) => /not implemented yet:\s*$/i.test(String(line))));
  check('no capability constraint advertises an empty "not implemented yet:" list', emptyNotImplemented.length === 0, {
    expected: [], actual: emptyNotImplemented.map((entry) => entry.id),
  });
  const staleReasons = entries.filter((entry) => /T4/i.test(String(entry.reason || '')) && /unsupported|not implemented/i.test(String(entry.reason || '')));
  check('no T4 capability entry is reported unsupported with a stale reason', staleReasons.length === 0, {
    expected: [], actual: staleReasons.map((entry) => `${entry.id}:${entry.status}:${entry.reason}`),
  });
}

/* ------------------------------------------------------------------------------------------------
 * Cleanup / evidence
 * ---------------------------------------------------------------------------------------------- */

async function cleanup(reason) {
  if (state.cleanupResult) return state.cleanupResult;
  log(`\n[cleanup] start (${reason})`);
  const result = {
    reason,
    closedHarness: false,
    disposedHarness: false,
    killedPids: [],
    removedProfiles: [],
    leftoverPids: [],
    leftoverProfiles: [],
    fixtureClosed: false,
    errors: [],
  };
  try {
    if (harness) {
      try { await harness.closeBrowser(); result.closedHarness = true; } catch (error) { result.errors.push(`closeBrowser: ${errorMessage(error)}`); }
      await sleep(1000);
      try { await harness.dispose(); result.disposedHarness = true; } catch (error) { result.errors.push(`dispose: ${errorMessage(error)}`); }
    }
    if (harnessModule) {
      const scan = harnessModule.scanPluginChromeProcesses;
      const stray = scan().filter((proc) => proc.parentPid === process.pid && !state.baselinePids.has(proc.pid));
      for (const proc of stray) {
        try { process.kill(proc.pid, 'SIGTERM'); } catch { /* ignore */ }
      }
      if (stray.length) await sleep(800);
      for (const proc of stray) {
        let alive = true;
        try { process.kill(proc.pid, 0); } catch { alive = false; }
        if (alive) { try { process.kill(proc.pid, 'SIGKILL'); } catch { /* ignore */ } }
        if (!alive) result.killedPids.push(proc.pid);
      }
      const profiles = await harnessModule.snapshotProfileDirs();
      for (const dir of profiles) {
        if (!state.baselineProfiles.has(dir)) state.ownedProfiles.add(dir);
      }
      for (const dir of profiles) {
        if (state.baselineProfiles.has(dir) || !state.ownedProfiles.has(dir)) continue;
        try { await rm(dir, { recursive: true, force: true }); result.removedProfiles.push(dir); } catch (error) { result.errors.push(`rm ${dir}: ${errorMessage(error)}`); }
      }
      result.leftoverProfiles = (await harnessModule.snapshotProfileDirs())
        .filter((dir) => !state.baselineProfiles.has(dir) && state.ownedProfiles.has(dir));
      result.leftoverPids = stray.filter((proc) => { try { process.kill(proc.pid, 0); return true; } catch { return false; } }).map((proc) => proc.pid);
    }
    if (fixture) {
      try { await fixture.close(); result.fixtureClosed = true; } catch (error) { result.errors.push(`fixture close: ${errorMessage(error)}`); }
    }
  } catch (error) {
    result.errors.push(`cleanup failure: ${errorMessage(error)}`);
  }
  state.cleanupResult = result;
  log(`[cleanup] done: killed=${result.killedPids.length} removedProfiles=${result.removedProfiles.length} leftoverProfiles=${result.leftoverProfiles.length} fixtureClosed=${result.fixtureClosed}`);
  return result;
}

async function writeEvidence() {
  const probes = report.probes;
  const requiredChecks = probes.flatMap((probe) => probe.checks.filter((entry) => !entry.advisory));
  const failedChecks = requiredChecks.filter((entry) => !entry.pass);
  const notRunChecks = report.notRun;
  const passedProbes = probes.filter((probe) => probe.status === 'pass').length;
  const failedProbes = probes.filter((probe) => probe.status === 'fail').length;
  const partialProbes = probes.filter((probe) => probe.status === 'partial').length;
  let exitCode = 0;
  if (failedChecks.length > 0) exitCode = 1;
  else if (notRunChecks.length > 0 || probes.length < 12) exitCode = 2;

  report.summary = {
    probes: probes.length,
    probesPassed: passedProbes,
    probesFailed: failedProbes,
    probesPartial: partialProbes,
    requiredChecks: requiredChecks.length,
    requiredPassed: requiredChecks.filter((entry) => entry.pass).length,
    requiredFailed: failedChecks.length,
    notRunChecks: notRunChecks.length,
    images: report.images.length,
    exitCode,
  };
  report.failedChecks = failedChecks.map((entry) => ({
    label: entry.label,
    expected: entry.expected,
    actual: entry.actual,
  }));
  report.resources = state.cleanupResult || { reason: 'not-run' };
  await mkdir(RUN_DIR, { recursive: true });
  await writeFile(join(RUN_DIR, 'run-report.json'), JSON.stringify(report, null, 2));
  await writeFile(join(RUN_DIR, 'run.log'), logLines.join('\n') + '\n');
  return report.summary;
}

function printSummary(summary) {
  log('\n================ T4 dynamic-visual fixture acceptance summary ================');
  for (const probe of report.probes) {
    const required = probe.checks.filter((entry) => !entry.advisory);
    const passed = required.filter((entry) => entry.pass).length;
    log(`${probe.id.padEnd(18)} ${probe.status.toUpperCase().padEnd(8)} ${passed}/${required.length} checks${probe.notRun.length ? `, ${probe.notRun.length} NOT_RUN` : ''}`);
  }
  if (report.notRun.length) {
    log('\nNOT_RUN:');
    for (const item of report.notRun) log(`  [${item.probeId}] ${item.label}: ${item.reason}`);
  }
  log(`\nprobes=${summary.probes} pass=${summary.probesPassed} fail=${summary.probesFailed} partial=${summary.probesPartial}`);
  log(`requiredChecks=${summary.requiredChecks} passed=${summary.requiredPassed} failed=${summary.requiredFailed} notRun=${summary.notRunChecks} images=${summary.images}`);
  log(`evidence: ${RUN_DIR}`);
  log(`EXIT ${summary.exitCode}`);
}

/* ------------------------------------------------------------------------------------------------
 * Main
 * ---------------------------------------------------------------------------------------------- */

const PROBES = [
  { id: 'T4V-01-page', title: '页面加载 / 四卡 / 真值 API / 无跨源请求', body: probePageLoad },
  { id: 'T4V-02-panels', title: '四类真实画面（CSS / Canvas2D / WebGL / 视频）', body: probeFourPanels },
  { id: 'T4V-03-determinism', title: '暂停 + seek 的 Canvas2D/WebGL 确定性', body: probeSeekDeterminism },
  { id: 'T4V-04-running', title: '恢复后逻辑时钟与画面推进', body: probeRunningAdvance },
  { id: 'T4V-05-video', title: '视频 play / pause / seek 与颜色主导通道', body: probeVideo },
  { id: 'T4V-06-flash', title: 'flash 场景：t=648 白帧，t=600 不闪', body: probeFlash },
  { id: 'T4V-07-freeze', title: 'freeze 场景：Canvas 冻结、CSS 继续', body: probeFreeze },
  { id: 'T4V-08-jank', title: 'jank 场景：每 3 帧丢 1 帧', body: probeJank },
  { id: 'T4V-09-media-stall', title: 'media-stall 场景：视频停住、其他面板继续', body: probeMediaStall },
  { id: 'T4V-10-op-visual', title: '真实点击 → ops / timeline causeOpId', body: probeOperationToVisual },
  { id: 'T4V-11-screenshots', title: '截图证据落盘（整页 + 两卡）', body: probeScreenshots },
  { id: 'T4V-12-no-overreach', title: '工具面 35 / T4 五工具真实注册 / 无 stale unsupported 声明', body: probeNoOverreach },
];

async function main() {
  report.environment = {
    node: process.version,
    platform: `${process.platform}/${process.arch}`,
    repoRoot: REPO_ROOT,
    runDir: RUN_DIR,
    captureRoot: process.env.DSH_UI_TESTING_CAPTURE_DIR,
    fixtureTruth: 'tests/ui_test_fixture/t4-visual.md',
    contract: 'tests/ui_test_fixture/t4-prep-contract.md §1',
    timeoutMs: TOTAL_TIMEOUT_MS,
    expectation: 'real headless Chromium via tests/acceptance/harness.mjs; no CDP shim',
  };

  harnessModule = await import(pathToFileURL(join(HERE, 'harness.mjs')).href);
  for (const dir of await harnessModule.snapshotProfileDirs()) state.baselineProfiles.add(dir);
  for (const proc of harnessModule.scanPluginChromeProcesses()) state.baselinePids.add(proc.pid);

  const { startFixtureServer } = await import(pathToFileURL(join(REPO_ROOT, 'tests/ui_test_fixture/server.mjs')).href);
  fixture = await startFixtureServer();
  report.environment.fixtureUrl = fixture.url;
  log(`[env] fixture: ${fixture.url}`);
  log(`[env] run dir: ${RUN_DIR}`);

  harness = await harnessModule.createHarness({ name: 'T4-visual' });
  for (const dir of await harnessModule.snapshotProfileDirs()) state.ownedProfiles.add(dir);
  for (const proc of harnessModule.scanPluginChromeProcesses()) state.ownedProfiles.add(proc.profileDir);
  log(`[env] tools (${harness.toolNames().length}): ${harness.toolNames().join(', ')}`);

  const only = String(process.env.DSH_T4_VISUAL_ONLY || '').split(',').map((item) => item.trim()).filter(Boolean);
  for (const meta of PROBES) {
    const selected = only.length === 0 || only.some((token) => meta.id === token || meta.id.startsWith(token + '-'));
    if (!selected) {
      log(`\n== ${meta.id} — SKIPPED by DSH_T4_VISUAL_ONLY`);
      continue;
    }
    await runProbe(meta, ({ check, notRun }) => meta.body({ check, notRun }));
  }

  log('\n[cleanup] closing browser and fixture');
  await cleanup('suite-complete');
  const summary = await writeEvidence();
  state.finished = true;
  printSummary(summary);
  return summary.exitCode;
}

let terminating = false;
for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
  process.on(signal, async () => {
    if (terminating) return;
    terminating = true;
    log(`\n[signal] ${signal} — writing partial evidence and cleaning up`);
    report.interrupted = { signal, at: new Date().toISOString() };
    try { await cleanup(`signal-${signal}`); } catch { /* ignore */ }
    try { await writeEvidence(); } catch { /* ignore */ }
    process.exit(2);
  });
}

const watchdog = setTimeout(async () => {
  if (state.finished) return;
  log(`\n[watchdog] HARD TIMEOUT after ${TOTAL_TIMEOUT_MS}ms — cleaning up and exiting 2`);
  try { await cleanup('hard-timeout'); } catch { /* ignore */ }
  try { await writeEvidence(); } catch { /* ignore */ }
  process.exit(2);
}, TOTAL_TIMEOUT_MS);
watchdog.unref?.();

let exitCode = 0;
try {
  exitCode = await main();
} catch (error) {
  log(`\n[fatal] ${errorMessage(error)}`);
  console.error(error);
  report.fatal = { name: error?.name, message: errorMessage(error), stack: String(error?.stack || '').split('\n').slice(0, 12) };
  try { await cleanup('fatal-error'); await writeEvidence(); } catch { /* ignore */ }
  exitCode = 2;
}
process.exitCode = exitCode;
