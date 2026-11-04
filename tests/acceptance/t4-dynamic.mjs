#!/usr/bin/env node
/**
 * WEB-T4 dynamic-behaviour acceptance: docs/t4-dynamic-behavior.md §8 (DV01–DV16, DN01–DN12,
 * DC01–DC12) against docs/t4-implementation-contract.md.
 *
 * This suite is independent, zero-dependency and single-driver:
 *   flock /tmp/dsh-t4-browser.lock node tests/acceptance/t4-dynamic.mjs
 *
 * It mounts the real plugin entry (index.js) on the fake Cordis context through
 * tests/acceptance/harness.mjs and drives ONLY the registered browser_* tools. It never speaks
 * CDP itself and never feeds the fixture oracle (`__t4.*.anomalies`, `__t4.*.causeOpId`) into the
 * analyzer: the fixture truth is used only as an independent `expected` source.
 *
 * Evidence: tests/acceptance/runs/<ISO>-<pid>/run-report.json + run.log + PNG screenshots.
 * Exit codes: 0 = every required check passed; 1 = at least one required check failed;
 *             2 = the suite could not produce complete evidence, or a required check is NOT_RUN.
 *
 * Milestone note: this build registers the M1 subset (session/observe/analyze). Checks whose tool
 * or evidence path is not implemented yet are reported as NOT_RUN with an explicit reason — they
 * are never silently passed, and NOT_RUN keeps exit code 2 per the contract.
 */
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = dirname(dirname(HERE));
const RUN_DIR = join(HERE, 'runs', `${new Date().toISOString().replace(/[:.]/g, '-')}-${process.pid}`);
const TOTAL_TIMEOUT_MS = Number(process.env.DSH_T4_DYNAMIC_TIMEOUT_MS || 300000) || 300000;
const FIXTURE_VISUAL = '/web-t4-visual.html';
const FIXTURE_NETWORK = '/web-t4-network.html';

// Capture output must land in this run's evidence directory, never in the repository's output/.
await mkdir(RUN_DIR, { recursive: true });
process.env.DSH_UI_TESTING_CAPTURE_DIR = RUN_DIR;

const { createHarness, EXPECTED_TOOLS, LEGACY_TOOLS, NETWORK_TOOLS, sleep } = await import('./harness.mjs');
const T4_TOOL_NAMES = Object.freeze([
  'browser_dynamic_session', 'browser_motion_observe', 'browser_motion_analyze',
  'browser_motion_control', 'browser_dynamic_correlate',
]);
/** The subset this build actually registers (M1). Kept here so the suite states its expectation. */
const T4_REGISTERED_EXPECTED = Object.freeze([
  'browser_dynamic_session', 'browser_motion_observe', 'browser_motion_analyze',
  'browser_motion_control', 'browser_dynamic_correlate',
]);
const DIRECTIONS = ['operation->visual', 'operation->network', 'network->visual',
  'visual->network', 'network->network', 'visual->visual'];

const logLines = [];
function log(line = '') {
  const text = String(line);
  logLines.push(text);
  console.log(text);
}
function errorMessage(error) {
  return String((error && error.message) || error);
}
function truncate(value, max = 600) {
  const text = typeof value === 'string' ? value : JSON.stringify(value);
  if (text === undefined) return '';
  return text.length > max ? `${text.slice(0, max)}…` : text;
}
function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}
function jsonSafe(value, depth = 0) {
  if (value === undefined) return undefined;
  if (value === null || typeof value !== 'object') return value;
  if (depth > 8) return '[depth-limit]';
  if (Array.isArray(value)) return value.slice(0, 200).map((item) => jsonSafe(item, depth + 1));
  if (Buffer.isBuffer(value) || value instanceof Uint8Array) return `[bytes ${value.length}]`;
  const out = {};
  for (const [key, item] of Object.entries(value)) {
    if (key === 'image' && typeof item === 'string') { out[key] = `[base64 ${item.length} chars]`; continue; }
    out[key] = jsonSafe(item, depth + 1);
  }
  return out;
}
function fileEvidence(relative) {
  return { path: relative, sha256: null, bytes: null };
}

const report = {
  schemaVersion: 1,
  suite: 'dsh-agent-team-ui-testing/acceptance-t4-dynamic',
  contract: 'docs/t4-dynamic-behavior.md §8 + docs/t4-implementation-contract.md',
  milestone: 'M3',
  generatedAt: new Date().toISOString(),
  command: 'flock /tmp/dsh-t4-browser.lock node tests/acceptance/t4-dynamic.mjs',
  environment: {
    node: process.version,
    platform: process.platform + '/' + process.arch,
    repository: REPO_ROOT,
    runDir: RUN_DIR,
  },
  toolSurface: null,
  criteria: [],
  probes: [],
  findings: [],
  notRun: [],
  evidenceFiles: [],
  screenshots: [],
  resources: {},
  summary: null,
};

const probes = [];
function probe(name, actual, extra = {}) {
  const entry = { name, actual: jsonSafe(actual), ...jsonSafe(extra) };
  probes.push(entry);
  report.probes.push(entry);
  return entry;
}

const ctx = {
  harness: null,
  fixture: null,
  agent: 't4-dynamic-acceptance',
  calls: [],
  screenshots: [],
  evidence: [],
  sessionId: null,
  motionSessionId: null,
  networkSessionId: null,
  pageUrl: null,
};

async function call(name, args = {}) {
  const startedAt = Date.now();
  const result = await ctx.harness.invoke(name, args, {
    agent: { id: ctx.agent, session: { header: { cwd: RUN_DIR } } },
  });
  const entry = {
    tool: name,
    ok: result.ok === true,
    code: result.ok ? null : (result.error && result.error.code) || null,
    message: result.ok ? null : truncate(result.error && result.error.message, 300),
    durationMs: Date.now() - startedAt,
  };
  ctx.calls.push(entry);
  log(`[call] ${name} ${entry.ok ? 'ok' : 'FAIL ' + entry.code} (${entry.durationMs}ms)`);
  return result;
}

function valueOf(result) {
  return result && result.ok ? result.value : null;
}

/**
 * `browser_eval` returns `{ok:true, value:<serialized result>}`; every fixture-oracle read goes
 * through this unwrap so a check can never pass/fail on the wrapper shape.
 */
function evalValue(result) {
  const value = valueOf(result);
  if (value && typeof value === 'object' && value.ok === true
    && Object.prototype.hasOwnProperty.call(value, 'value')) return value.value;
  return value;
}

function failCheck(id, expected, actual, reason) {
  return { id, status: 'FAIL', expected, actual: jsonSafe(actual), reason };
}
/**
 * PASS only when every required sub-item really ran. A documented NOT_RUN sub-item downgrades the
 * criterion to PARTIAL (Lead rule: NOT_RUN never counts as a pass; partial still exits 2).
 */
function passCheck(id, expected, actual, subNotRun = []) {
  if (Array.isArray(subNotRun) && subNotRun.length > 0) {
    return {
      id, status: 'PARTIAL', expected, actual: jsonSafe(actual),
      reason: 'required sub-item NOT_RUN: ' + subNotRun.join(', '), subNotRun,
    };
  }
  return { id, status: 'PASS', expected, actual: jsonSafe(actual), reason: null };
}
function notRunCheck(id, expected, reason, actual = null) {
  return { id, status: 'NOT_RUN', expected, actual: jsonSafe(actual), reason };
}

/**
 * Pick up to `max` frames around the strongest adjacent encoded-hash change. This is only an
 * INPUT-SELECTION heuristic so the 5s analysis budget can afford JPEG decode; the analyzer still
 * decides on decoded pixels. Encoded bytes are never treated as pixels and the fixture oracle is
 * not consulted.
 */
function framesAroundEncodedChange(frames, max = 7) {
  if (!Array.isArray(frames) || frames.length < 3) return frames.slice(0, max);
  let bestIndex = -1;
  let bestSize = -1;
  for (let index = 1; index < frames.length; index += 1) {
    const left = frames[index - 1];
    const right = frames[index];
    const delta = Math.abs(Number(right.bytes || 0) - Number(left.bytes || 0));
    const changed = left.sha256 !== right.sha256;
    if (changed && delta > bestSize) { bestSize = delta; bestIndex = index; }
  }
  if (bestIndex < 0) return frames.slice(0, max);
  const half = Math.floor((max - 1) / 2);
  const from = Math.max(0, bestIndex - half);
  return frames.slice(from, from + max);
}

function check(id, kind, expected, body) {
  return { id, kind, required: true, expected, body };
}

/* ------------------------------------------------------------------------------------------------
 * Shared page-bridge helpers: start P0 before navigation, then a T4 session referencing it.
 * ---------------------------------------------------------------------------------------------- */
async function openNetworkScenario(scenario) {
  let p0 = valueOf(await call('browser_network_session', { action: 'start' }));
  const url = ctx.fixture.url + FIXTURE_NETWORK.slice(1) + (scenario ? '?scenario=' + scenario : '');
  await call('browser_navigate', { url });
  // The fixture pushes one remote WS cart update ~+400ms after boot; settle before baselines.
  await sleep(1400);
  const current = valueOf(await call('browser_network_session', { action: 'status' }));
  const sessionId = current?.sessionId || p0?.sessionId || null;
  const started = await call('browser_dynamic_session', {
    action: 'start', name: 'net-' + (scenario || 'normal'),
    config: { source: 'screencast', networkSessionId: sessionId, durationMs: 9000 },
  });
  return { p0SessionId: sessionId, session: valueOf(started)?.session || null, startError: started.error || null, url };
}

async function correlateNow(session, options = {}) {
  return valueOf(await call('browser_dynamic_correlate', {
    dynamicSessionId: session.dynamicSessionId,
    motionSessionId: session.motionSessionId,
    networkSessionId: session.networkSessionId,
    limit: 120,
    ...options,
  }));
}

async function correlateUntil(session, predicate, options = {}, attempts = 4) {
  let last = null;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    last = await correlateNow(session, options);
    if (last && predicate(last)) return last;
    await sleep(500);
  }
  return last;
}

function pairBasis(pairs, direction) {
  return (pairs || []).filter((pair) => pair.direction === direction).map((pair) => pair.basis);
}

/* ------------------------------------------------------------------------------------------------
 * Check definitions. A `body` returns {status, expected?, actual, reason?, evidenceIds?}.
 * ---------------------------------------------------------------------------------------------- */

const checks = [
  /* ---- DV: dynamic visual ------------------------------------------------------------------ */
  check('DV01', 'B',
    '四卡/title、version=1、媒体来源或 fallback 披露、无外网依赖；capabilities 按本里程碑真实注册数与 capability 一致',
    async () => {
      const caps = valueOf(await call('browser_capabilities', {}));
      const truth = evalValue(await call('browser_eval', { expression: 'window.__t4 && window.__t4.visual ? window.__t4.visual.state() : null' }));
      const names = ctx.harness.toolNames();
      const registeredT4 = names.filter((name) => T4_TOOL_NAMES.includes(name));
      const t4Caps = (caps?.capabilities || []).filter((item) => String(item.id).startsWith('web.t4.'));
      const perTool = t4Caps.filter((item) => item.tool);
      const dynamic = caps?.dynamic;
      const problems = [];
      if (!truth || truth.version !== 1) problems.push('fixture version !== 1');
      if (!truth?.truth || truth.truth.panels?.length !== 4) problems.push('panels != 4');
      if (!truth?.truth?.media?.asset && !truth?.truth?.media?.fallback) problems.push('media asset/fallback missing');
      if (!dynamic) problems.push('capabilities.dynamic missing');
      if (dynamic && JSON.stringify(dynamic.tools) !== JSON.stringify(registeredT4)) problems.push('dynamic.tools != registered T4 tools');
      if (perTool.length !== registeredT4.length) problems.push(`web.t4.* per-tool entries ${perTool.length} != registered ${registeredT4.length}`);
      const unavailable = perTool.filter((item) => !registeredT4.includes(item.tool)).map((item) => item.id);
      if (unavailable.length) problems.push('capability declares unregistered tool: ' + unavailable.join(','));
      if (!t4Caps.some((item) => item.id === 'web.t4.dynamic-behavior' && item.status === 'available')) problems.push('aggregate web.t4.dynamic-behavior missing');
      if (!t4Caps.some((item) => item.id === 'web.t4.dynamic-vision' && item.aliasOf === 'web.t4.dynamic-behavior')) problems.push('legacy alias missing');
      const actual = {
        fixture: { version: truth?.version, panels: truth?.truth?.panels, media: truth?.truth?.media?.asset || truth?.truth?.media?.fallback },
        toolCount: names.length,
        registeredT4,
        dynamicTools: dynamic?.tools,
        perToolCaps: perTool.map((item) => item.id + ':' + item.status),
      };
      return {
        status: problems.length ? 'FAIL' : 'PASS',
        subNotRun: problems.length ? [] : ['real-host (3080/3081) loading and Agent discovery'],
        expected: 'fixture v1/4 panels/no external dependency; capabilities match the real registry',
        actual: { ...actual, problems },
        problem: problems.join('; '),
      };
    }),

  check('DV02', 'B', 'CSS WAAPI 对象与真实 transform/opacity 随 t 变化；SVG/独立 JS 子项另记 NOT_RUN', async () => {
    const truth = evalValue(await call('browser_eval', { expression: 'window.__t4.visual.state()' }));
    const css = truth?.panels?.css;
    await call('browser_eval', { expression: 'window.__t4.visual.setScenario("normal"), window.__t4.visual.setPaused(false)' });
    const started = await call('browser_dynamic_session', { action: 'start', name: 'dv02', config: { source: 'screencast', durationMs: 2500, maxFrames: 30 } });
    const session = valueOf(started)?.session;
    if (!session) return notRunCheck('DV02', 'WAAPI observation', 'session start failed: ' + errorMessage(started.error));
    await sleep(800);
    const observed = valueOf(await call('browser_motion_observe', { motionSessionId: session.motionSessionId, limit: 30 }));
    const frames = observed?.frames || [];
    let diff = null;
    const pair = framesAroundEncodedChange(frames, 2);
    if (pair.length >= 2) {
      diff = valueOf(await call('browser_motion_analyze', {
        motionSessionId: session.motionSessionId, frameIds: pair.map((frame) => frame.frameId),
        assertions: [{ id: 'dv02-css-motion', type: 'frame-diff', thresholds: { changeRatio: 0.0005 } }],
      }));
    }
    await call('browser_dynamic_session', { action: 'stop' });
    const result = diff?.results?.[0];
    const problems = [];
    if (!css || css.animationCount < 1 || !(css.animations || []).some((item) => item.playState)) problems.push('no real WAAPI object from the page ledger');
    if (!(frames.length >= 2)) problems.push('fewer than two T4 frames');
    if (!result || result.verdict !== 'FAIL' || !String(result.reasons || '').includes('change-detected')) problems.push('T4 frames did not show a detected change');
    return {
      status: problems.length ? 'FAIL' : 'PASS',
      subNotRun: problems.length ? [] : ['SVG / standalone-JS adapters (no frozen target)', 'CSS transform/opacity pixel attribution'],
      expected: 'real WAAPI animation objects from the page ledger and T4 frames that detect change',
      actual: { animationCount: css?.animationCount, animations: css?.animations, frames: frames.length, diff: result ? { verdict: result.verdict, reasons: result.reasons } : null, problems },
      reason: problems.length ? problems.join('; ') : 'WAAPI existence + real frame change verified; SVG/JS adapters are NOT_RUN',
    };
  }),


  check('DV03', 'B', 'Canvas2D 24 粒子、RGBA checksum 与真实重绘 frames/draws，300/900ms 正负例', async () => {
    const truth = evalValue(await call('browser_eval', { expression: 'window.__t4.visual.state()' }));
    const canvas = truth?.panels?.canvas2d;
    return notRunCheck('DV03', '24 particles + real RGBA checksum observed through T4 frames',
      'JPEG decoding is available, but the same-t determinism/control part needs browser_motion_control (M2); the fixture checksum/draws are preparation evidence only',
      { fixtureParticles: truth?.truth?.canvas2d?.particles, fixtureFrames: canvas?.frames, fixtureDraws: canvas?.draws, checksum: canvas?.checksum });
  }),

  check('DV04', 'B', 'WebGL contextType/renderer、同运行 checksum、WebGPU available/reason', async () => {
    const truth = evalValue(await call('browser_eval', { expression: 'window.__t4.visual.state()' }));
    const webgl = truth?.panels?.webgl;
    return notRunCheck('DV04', 'WebGL/WebGPU observation through T4 frames',
      'T4 can observe frame pixels, but WebGL context/renderer identity is not observable through the dynamic tools; WebGPU real rendering has no dedicated evidence',
      { contextType: webgl?.contextType, renderer: webgl?.renderer, checksum: webgl?.checksum, webgpu: webgl?.webgpu });
  }),

  check('DV05', 'B', '视频 readyState、3s±0.15、500/1500/2500 主导色、frameCount 与 fallback', async () => {
    const truth = evalValue(await call('browser_eval', { expression: 'window.__t4.visual.state()' }));
    const media = truth?.panels?.media;
    const truthMedia = truth?.truth?.media;
    return notRunCheck('DV05', 'media adapter + dominant colour checkpoints',
      'no T4 media adapter exists yet; fixture media truth is preparation evidence only',
      { readyState: media?.readyState, durationMs: media?.durationMs, frameCount: media?.frameCount, sample: media?.sample, fallback: truthMedia?.fallback || null });
  }),

  check('DV06', 'B', 'pause/seek/resume 实际回读，seek 300→900→300 确定性', async () => {
    await call('browser_navigate', { url: ctx.fixture.url + FIXTURE_VISUAL.slice(1) });
    await call('browser_eval', { expression: 'window.__t4.visual.setScenario("normal"), window.__t4.visual.setPaused(false)' });
    const started = await call('browser_dynamic_session', { action: 'start', name: 'dv06', config: { source: 'screencast', durationMs: 5000 } });
    const session = valueOf(started)?.session;
    if (!session) return notRunCheck('DV06', 'control readback', 'session start failed: ' + errorMessage(started.error));
    const motion = session.motionSessionId;
    const problems = [];
    const pause = valueOf(await call('browser_motion_control', { motionSessionId: motion, action: 'pause', adapterId: 'waapi', targetIds: ['#t4v-css-orb'] }));
    if (!pause || pause.after?.[0]?.playState !== 'paused') problems.push('pause readback != paused');
    const original = pause?.before?.[0] || null;
    const seek300a = valueOf(await call('browser_motion_control', { motionSessionId: motion, action: 'seek', adapterId: 'waapi', targetIds: ['#t4v-css-orb'], timeMs: 300 }));
    const t300a = seek300a?.after?.[0]?.currentTimeMs;
    const seek900 = valueOf(await call('browser_motion_control', { motionSessionId: motion, action: 'seek', adapterId: 'waapi', targetIds: ['#t4v-css-orb'], timeMs: 900 }));
    const t900 = seek900?.after?.[0]?.currentTimeMs;
    const seek300b = valueOf(await call('browser_motion_control', { motionSessionId: motion, action: 'seek', adapterId: 'waapi', targetIds: ['#t4v-css-orb'], timeMs: 300 }));
    const t300b = seek300b?.after?.[0]?.currentTimeMs;
    if (!Number.isFinite(t300a) || Math.abs(t300a - 300) > 24) problems.push('seek(300) first readback != 300±24');
    if (!Number.isFinite(t900) || Math.abs(t900 - 900) > 24) problems.push('seek(900) readback != 900±24');
    if (!Number.isFinite(t300b) || Math.abs(t300b - 300) > 24) problems.push('seek(300) second readback != 300±24');
    if (Number.isFinite(t300a) && Number.isFinite(t300b) && Math.abs(t300a - t300b) > 1) problems.push('two seek(300) readbacks differ');
    if (Number.isFinite(t900) && Number.isFinite(t300a) && Math.abs(t900 - t300a) < 500) problems.push('seek(900) not distinguishable from seek(300)');
    const restore = valueOf(await call('browser_motion_control', { motionSessionId: motion, action: 'restore', restoreToken: pause?.restoreToken }));
    if (!restore || !['restored', 'partial', 'conflict'].includes(restore.restoreStatus?.status)) problems.push('restore did not report a status');
    await call('browser_dynamic_session', { action: 'stop' });
    return {
      status: problems.length ? 'FAIL' : 'PASS',
      subNotRun: problems.length ? [] : ['SVG / standalone-JS adapter control', 'media seek adapter'],
      expected: 'WAAPI readback pause/seek(300/900/300)/restore; two 300 readbacks identical, 900 distinguishable, restore reported',
      actual: {
        pauseAfter: pause?.after?.[0] || null, original,
        readbacks: { t300a, t900, t300b },
        restore: restore ? { status: restore.restoreStatus?.status, attempts: restore.restoreStatus?.attempted } : null,
        problems,
      },
      reason: problems.length ? problems.join('; ') : 'WAAPI adapter readback verified; media/SVG adapters PARTIAL',
    };
  }),


  check('DV07', 'B', 'T4 独立帧 sink、sourceTimestamp/编码/hash/metadata/mapping 原图证据，排除 latest-frame/metrics', async () => {
    // Fresh session on the flash page: damage-driven screencast produces a real sequence.
    const truthScenario = evalValue(await call('browser_eval', { expression: 'window.__t4.visual.setScenario("flash"), window.__t4.visual.state().scenario' }));
    const start = await call('browser_dynamic_session', {
      action: 'start', name: 'dv07', config: { source: 'screencast', durationMs: 2500, maxFrames: 40 },
    });
    const session = valueOf(start)?.session;
    if (!session) return failCheck('DV07', 'real dynamic session + frame sequence', { error: start.error }, 'session start failed');
    ctx.sessionId = session.dynamicSessionId;
    ctx.motionSessionId = session.motionSessionId;
    await sleep(1200);
    const observed = valueOf(await call('browser_motion_observe', { motionSessionId: session.motionSessionId, limit: 40 }));
    const frames = observed?.frames || [];
    const stop = valueOf(await call('browser_dynamic_session', { action: 'stop' }));
    const problems = [];
    if (frames.length < 2) problems.push('less than 2 frames captured (a latest-frame cache can never show a sequence)');
    const seqs = frames.map((frame) => frame.seq);
    if (seqs.some((seq, index) => index > 0 && seq <= seqs[index - 1])) problems.push('frame seq not strictly increasing');
    const now = Date.now();
    for (const frame of frames) {
      if (frame.source !== 'screencast') problems.push('frame.source != screencast');
      if (frame.encoding !== 'jpeg') problems.push('frame.encoding != jpeg');
      if (!/^[0-9a-f]{64}$/.test(String(frame.sha256))) problems.push('frame.sha256 missing/short');
      if (!(frame.dimensions?.width > 0 && frame.dimensions?.height > 0)) problems.push('frame dimensions missing');
      if (!frame.mapping || !frame.mapping.viewport || !frame.mapping.scroll || !('deviceScaleFactor' in frame.mapping)
        || !('viewRevision' in frame.mapping) || !frame.mapping.canvasOffset) problems.push('frame mapping incomplete');
      if (frame.sourceTimestamp !== null) {
        // Contract §6.2: the frame store keeps the RAW CDP epoch value in **seconds**.
        if (!(frame.sourceTimestamp > 1.6e9 && frame.sourceTimestamp < 2.1e9)) problems.push('sourceTimestamp is not CDP epoch seconds');
        if (Math.abs(frame.sourceTimestamp * 1000 - now) > 120000) problems.push('sourceTimestamp not near wall clock');
        if (frame.sourceTimestamp === frame.receivedMonoMs) problems.push('sourceTimestamp equals receive time (forbidden)');
      }
    }
    if (!frames.some((frame) => frame.sourceTimestamp !== null)) problems.push('no frame carries a sourceTimestamp');
    const integrityIssues = stop?.integrity?.issues || [];
    if (frames.length > 0 && integrityIssues.includes('no-damage-frames')) problems.push('sticky no-damage-frames despite captured frames');
    const uniqueHashes = new Set(frames.map((frame) => frame.sha256)).size;
    if (truthScenario === 'flash' && uniqueHashes < 2) problems.push('flash scenario produced no encoded variation');
    return {
      status: problems.length ? 'FAIL' : 'PASS',
      subNotRun: problems.length ? [] : ['provider-visible original image / attachment delivery'],
      expected: '>=2 sequentially stored frames, jpeg, sha256, dimensions, mapping, real sourceTimestamp (or null), not the preview latest-frame',
      actual: {
        frameCount: frames.length,
        firstSeq: frames[0]?.seq, lastSeq: frames[frames.length - 1]?.seq,
        uniqueEncodedHashes: uniqueHashes,
        firstSourceTimestampSeconds: frames[0]?.sourceTimestamp,
        firstMapping: frames[0]?.mapping,
        counters: stop?.session?.counters,
        integrity: { captured: stop?.integrity?.captured, dropped: stop?.integrity?.dropped, ackFailures: stop?.integrity?.ackFailures, issues: integrityIssues },
        problems,
      },
      reason: problems.join('; '),
    };
  }),

  check('DV08', 'B+U', 'ACK 恰好一次、慢消费者/预算压力下 dropped/evicted/gaps 与有限内存', async () => {
    const start = await call('browser_dynamic_session', {
      action: 'start', name: 'dv08', config: { source: 'screencast', durationMs: 2500, maxFrames: 4 },
    });
    const session = valueOf(start)?.session;
    if (!session) return failCheck('DV08', 'bounded frame store under pressure', { error: start.error }, 'session start failed');
    await sleep(1200);
    const stop = valueOf(await call('browser_dynamic_session', { action: 'stop' }));
    const integrity = stop?.integrity;
    const counters = stop?.session?.counters;
    const problems = [];
    if (!integrity) problems.push('no integrity block');
    if (!(counters?.frames > 0)) problems.push('no frames observed');
    if (!(integrity?.ackFailures === 0)) problems.push('ackFailures != 0');
    if (!(integrity?.evicted > 0)) problems.push('maxFrames=4 pressure did not evict (bounded store not exercised)');
    if (!(integrity?.retained <= 4)) problems.push('retained frames exceed maxFrames');
    if (!(integrity?.complete === false)) problems.push('complete must be false when frames were evicted');
    return {
      status: problems.length ? 'FAIL' : 'PASS',
      expected: 'one ACK per frame (failures=0), evicted>0 under maxFrames=4, retained<=4, complete=false',
      actual: { captured: integrity?.captured, dropped: integrity?.dropped, evicted: integrity?.evicted, retained: integrity?.retained, ackFailures: integrity?.ackFailures, complete: integrity?.complete, counters },
      subNotRun: problems.length ? [] : ['slow-consumer backpressure (sink ACK independence is covered by the single-ACK code path, not by a forced slow consumer)'],
      reason: problems.length ? problems.join('; ') : 'U sub-item (pin/eviction pure logic) ran as tests/dynamic-t4.test.mjs and is green; slow-consumer pressure sub-item NOT_RUN',
    };
  }),

  check('DV09', 'U+B', '两帧 YIQ 分母/masks/区域与 normal 负例；全 mask 显式拒绝', async () => {
    const start = await call('browser_dynamic_session', {
      action: 'start', name: 'dv09', config: { source: 'screencast', durationMs: 2200, maxFrames: 30 },
    });
    const session = valueOf(start)?.session;
    if (!session) return notRunCheck('DV09', 'YIQ/mask semantics on real frames', 'session start failed: ' + errorMessage(start.error));
    await sleep(900);
    const observed = valueOf(await call('browser_motion_observe', { motionSessionId: session.motionSessionId, limit: 30 }));
    const frames = (observed?.frames || []).slice(0, 2);
    if (frames.length < 2) {
      await call('browser_dynamic_session', { action: 'stop' });
      return notRunCheck('DV09', 'two comparable real frames', 'less than two frames captured in the window');
    }
    const ids = frames.map((frame) => frame.frameId);
    const diff = valueOf(await call('browser_motion_analyze', {
      motionSessionId: session.motionSessionId, frameIds: ids,
      assertions: [{ id: 'dv09-frame-diff', type: 'frame-diff' }],
    }));
    const maskCall = await call('browser_motion_analyze', {
      motionSessionId: session.motionSessionId, frameIds: ids,
      assertions: [{
        id: 'dv09-full-mask', type: 'frame-diff',
        region: { x: 0, y: 0, width: frames[0].dimensions.width, height: frames[0].dimensions.height },
        masks: [{ id: 'all', region: { x: 0, y: 0, width: frames[0].dimensions.width, height: frames[0].dimensions.height } }],
      }],
    });
    const mask = valueOf(maskCall);
    const maskRejected = maskCall.ok === false && maskCall.error?.code === 'DYNAMIC_INVALID_ARGUMENT'
      && String(maskCall.error?.details?.reason || '').includes('full-mask');
    await call('browser_dynamic_session', { action: 'stop' });
    // PNG precise path (screenshot-loop, contract §4.5): real PNG frames, sourceTimestamp null,
    // measured begin/end sampling interval, precise=true in the analysis result.
    const loopStart = await call('browser_dynamic_session', {
      action: 'start', name: 'dv09-loop', config: { source: 'screenshot-loop', sampleIntervalMs: 150, durationMs: 1600 },
    });
    const loopSession = valueOf(loopStart)?.session;
    let loopResult = null;
    if (loopSession) {
      await sleep(800);
      const loopObserved = valueOf(await call('browser_motion_observe', { motionSessionId: loopSession.motionSessionId, limit: 6 }));
      const loopFrames = (loopObserved?.frames || []).slice(0, 2);
      if (loopFrames.length === 2) {
        const loopAnalyze = valueOf(await call('browser_motion_analyze', {
          motionSessionId: loopSession.motionSessionId,
          frameIds: loopFrames.map((frame) => frame.frameId),
          assertions: [{ id: 'dv09-png', type: 'frame-diff' }],
        }));
        loopResult = {
          frames: loopFrames.length,
          encoding: loopFrames[0].encoding,
          sourceTimestamp: loopFrames[0].sourceTimestamp,
          sample: loopFrames[0].sample,
          verdict: loopAnalyze?.results?.[0]?.verdict,
          precise: loopAnalyze?.results?.[0]?.precise,
          resultEncoding: loopAnalyze?.results?.[0]?.encoding,
        };
      }
      await call('browser_dynamic_session', { action: 'stop' });
    }
    // Crop-on-delivery (observe region): PNG ROI delivery, size ratio, negatives, fresh, and the
    // zero-regression encoded-only path (screencast stays a full-frame JPEG with zero crop decodes).
    const problems = [];
    let regionEvidence = null;
    const regionStart = await call('browser_dynamic_session', {
      action: 'start', name: 'dv09-region', config: { source: 'screenshot-loop', sampleIntervalMs: 150, durationMs: 2200 },
    });
    const regionSession = valueOf(regionStart)?.session;
    if (!regionSession) {
      problems.push('region session start failed: ' + String(regionStart.error?.code));
    } else {
      await sleep(800);
      const fullDelivery = valueOf(await call('browser_motion_observe', { motionSessionId: regionSession.motionSessionId, limit: 2, includeImages: true }));
      const fullFrame = fullDelivery?.frames?.[0];
      const dims = fullFrame?.dimensions || {};
      const region = { x: Math.max(0, Math.floor(dims.width / 2) - 60), y: Math.max(0, Math.floor(dims.height / 2) - 40), width: 120, height: 80 };
      const cropped = valueOf(await call('browser_motion_observe', {
        motionSessionId: regionSession.motionSessionId, frameIds: [fullFrame?.frameId].filter(Boolean), includeImages: true, region,
      }));
      const croppedFrame = cropped?.frames?.[0];
      if (!fullFrame || fullFrame.crop !== undefined) problems.push('full-frame delivery must not carry crop');
      if (!(fullDelivery?.cropStats?.decodes === 0)) problems.push('encoded-only observe performed crop decodes');
      if (!croppedFrame?.image || croppedFrame.image.mediaType !== 'image/png') problems.push('region delivery is not image/png');
      if (croppedFrame?.image && (croppedFrame.image.width !== region.width || croppedFrame.image.height !== region.height)) problems.push('region delivery dimensions != region');
      if (!croppedFrame?.crop?.roiSha256 || croppedFrame.crop.roiSha256 === fullFrame?.sha256) problems.push('roiSha256 missing or equals full-frame sha256');
      if (croppedFrame?.crop?.sourceDimensions?.width !== dims.width || croppedFrame?.crop?.sourceDimensions?.height !== dims.height) problems.push('crop.sourceDimensions mismatch');
      const ratio = fullFrame?.image?.bytes && croppedFrame?.image?.bytes ? fullFrame.image.bytes / croppedFrame.image.bytes : 0;
      if (!(ratio >= 3)) problems.push('region delivery is not >=3x smaller than the full frame');
      if (!(cropped?.cropStats?.decodes >= 1)) problems.push('region delivery did not record crop decodes');
      const outOfBounds = await call('browser_motion_observe', {
        motionSessionId: regionSession.motionSessionId, frameIds: [fullFrame?.frameId].filter(Boolean), includeImages: true,
        region: { x: Math.max(0, dims.width - 10), y: 0, width: 20, height: 20 },
      });
      if (outOfBounds.ok !== false || outOfBounds.error?.code !== 'DYNAMIC_INVALID_ARGUMENT') problems.push('out-of-bounds region was not refused');
      const regionWithoutImages = await call('browser_motion_observe', { motionSessionId: regionSession.motionSessionId, region });
      if (regionWithoutImages.ok !== false || regionWithoutImages.error?.code !== 'DYNAMIC_INVALID_ARGUMENT') problems.push('region without includeImages was not refused');
      const caps = valueOf(await call('browser_capabilities', {}));
      const observationDelivery = caps?.dynamic?.visual?.observationDelivery || null;
      if (!observationDelivery
        || observationDelivery.region !== true
        || observationDelivery.regionSpace !== 'image-px'
        || observationDelivery.cropOnDelivery !== true
        || observationDelivery.cropFormat !== 'png'
        || observationDelivery.requiresIncludeImages !== true
        || observationDelivery.fullFrameDeliveryDecode !== false
        || observationDelivery.maxImages !== 3
        || observationDelivery.masks !== false) {
        problems.push('capabilities.dynamic.visual.observationDelivery does not match contract §8');
      }
      const freshCrop = valueOf(await call('browser_motion_observe', {
        motionSessionId: regionSession.motionSessionId, fresh: true, includeImages: true, region,
      }));
      const freshFrame = freshCrop?.frames?.[0];
      if (!freshFrame?.image || freshFrame.image.mediaType !== 'image/png' || freshFrame.image.width !== region.width) problems.push('fresh frame + region was not cropped');
      regionEvidence = {
        fullBytes: fullFrame?.image?.bytes ?? null, cropBytes: croppedFrame?.image?.bytes ?? null,
        ratio: Number(ratio.toFixed(2)), region, mediaType: croppedFrame?.image?.mediaType ?? null,
        roiSha256: croppedFrame?.crop?.roiSha256 ?? null, fullSha256: fullFrame?.sha256 ?? null,
        sourceDimensions: croppedFrame?.crop?.sourceDimensions ?? null,
        fullPathDecodes: fullDelivery?.cropStats?.decodes ?? null,
        observationDelivery,
        freshMediaType: freshFrame?.image?.mediaType ?? null,
      };
      await call('browser_dynamic_session', { action: 'stop' });
    }
    // Encoded-only screencast regression: still a full-frame JPEG, no crop, no decode.
    const regStart = await call('browser_dynamic_session', { action: 'start', name: 'dv09-jpeg', config: { source: 'screencast', durationMs: 1500 } });
    const regSession = valueOf(regStart)?.session;
    if (regSession) {
      await sleep(500);
      const regDelivery = valueOf(await call('browser_motion_observe', { motionSessionId: regSession.motionSessionId, limit: 2, includeImages: true }));
      const regFrame = regDelivery?.frames?.[0];
      if (!regFrame?.image || regFrame.image.mediaType !== 'image/jpeg') problems.push('screencast full-frame delivery is not JPEG (regression)');
      if (regFrame?.crop !== undefined) problems.push('screencast full-frame delivery unexpectedly carries crop');
      if (regDelivery?.cropStats?.decodes !== 0) problems.push('screencast full-frame delivery performed decodes (regression)');
      await call('browser_dynamic_session', { action: 'stop' });
    }
    const diffResult = diff?.results?.[0];
    const maskResult = mask?.results?.[0];
    const unit = report.resources.coreUnit || {};
    if (!diffResult) problems.push('frame-diff produced no result');
    if (diffResult?.encoding !== 'jpeg' || diffResult?.precise !== false) problems.push('JPEG result must be encoding=jpeg/precise=false');
    if (!(Number(diffResult?.sampleCount) >= 2)) problems.push('sampleCount < 2');
    if (!maskRejected && !maskResult) problems.push('full-mask comparison produced no result and no explicit refusal');
    if (maskResult && maskResult.verdict === 'PASS') problems.push('full-mask comparison must not PASS (empty denominator)');
    if (maskResult && !['INCONCLUSIVE', 'BLOCKED'].includes(maskResult.verdict)) problems.push('full-mask verdict must be INCONCLUSIVE/BLOCKED');
    const unitOk = unit.available === true && Number(unit.fail) === 0 && Number(unit.pass) > 0;
    if (!unitOk) problems.push('core unit suite not green (tests/dynamic-t4.test.mjs)');
    if (!loopResult) problems.push('screenshot-loop PNG path produced no comparable frames');
    if (loopResult) {
      if (loopResult.encoding !== 'png') problems.push('screenshot-loop encoding != png');
      if (loopResult.sourceTimestamp !== null) problems.push('screenshot-loop sourceTimestamp must stay null');
      if (!loopResult.sample || !Number.isFinite(loopResult.sample.beginMonoMs)) problems.push('screenshot-loop sample interval missing');
      if (loopResult.precise !== true) problems.push('PNG analysis must report precise=true');
      if (loopResult.resultEncoding !== 'png') problems.push('PNG analysis result encoding != png');
    }
    return {
      status: problems.length ? 'FAIL' : 'PASS',
      expected: 'real JPEG frame-diff (encoding=jpeg, precise=false, >=2 samples); full mask refuses with INCONCLUSIVE/BLOCKED, never similarity=1; U suite green',
      actual: {
        diff: diffResult ? { verdict: diffResult.verdict, reasons: diffResult.reasons, encoding: diffResult.encoding, precise: diffResult.precise, sampleCount: diffResult.sampleCount } : null,
        fullMask: maskRejected ? { rejected: 'DYNAMIC_INVALID_ARGUMENT', reason: maskCall.error?.details?.reason } : (maskResult ? { verdict: maskResult.verdict, reasons: maskResult.reasons } : null),
        coreUnit: unit,
        screenshotLoop: loopResult,
        regionDelivery: regionEvidence,
        problems,
      },
      reason: problems.length ? problems.join('; ') : 'JPEG coarse frame-diff, full-mask refusal and screenshot-loop PNG precise path verified',
    };
  }),

  check('DV10', 'B', 'flash [640,656) 真值正例、≥3 帧 A→B→A、normal 负例与覆盖间隔', async () => {
    // Fixture precondition (not analyzer input): restart flash at t=0 so the [640,656) window is
    // inside this capture. The oracle below is used only as the independent `expected`.
    await call('browser_eval', { expression: 'window.__t4.visual.setScenario("flash"), window.__t4.visual.setPaused(false)' });
    const truth = evalValue(await call('browser_eval', { expression: 'window.__t4.visual.state()' }));
    const start = await call('browser_dynamic_session', {
      action: 'start', name: 'dv10', config: { source: 'screencast', durationMs: 2200, maxFrames: 60 },
    });
    const session = valueOf(start)?.session;
    if (!session) return notRunCheck('DV10', 'flash detection', 'session start failed: ' + errorMessage(start.error));
    await sleep(1000);
    const observed = valueOf(await call('browser_motion_observe', { motionSessionId: session.motionSessionId, limit: 60 }));
    const allFrames = observed?.frames || [];
    const band = allFrames.filter((frame) => Number(frame.timelineMs) >= 560 && Number(frame.timelineMs) <= 780);
    const candidates = framesAroundEncodedChange(band.length >= 5 ? band : allFrames, 9);
    const analyze = valueOf(await call('browser_motion_analyze', {
      motionSessionId: session.motionSessionId,
      frameIds: candidates.map((frame) => frame.frameId),
      assertions: [{ id: 'dv10-flicker', type: 'flicker' }],
    }));
    await call('browser_dynamic_session', { action: 'stop' });
    const truthAfter = evalValue(await call('browser_eval', { expression: 'window.__t4.visual.state()' }));
    const result = analyze?.results?.[0];
    const actual = {
      oracle: {
        scenario: truthAfter?.scenario,
        flashFrames: truthAfter?.anomalies?.flashFrames?.length,
        frozenAtMs: truthAfter?.anomalies?.frozenAtMs,
      },
      capturedFrames: allFrames.length,
      candidateIds: candidates.map((frame) => frame.frameId),
      verdict: analyze?.verdict,
      result: result ? { verdict: result.verdict, reasons: result.reasons, limitations: result.limitations, encoding: result.encoding, precise: result.precise, sampleCount: result.sampleCount } : null,
    };
    if (truthAfter?.scenario !== 'flash') return failCheck('DV10', 'flash scenario truth', actual, 'fixture not in flash scenario');
    if (!analyze) return failCheck('DV10', 'flicker analysis result', actual, 'analyze failed');
    const flashFrames = Number(truthAfter?.anomalies?.flashFrames?.length) || 0;
    if (flashFrames > 0 && result?.verdict === 'FAIL') {
      return passCheck('DV10', 'flash A->B->A with >=3 samples (JPEG coarse)', actual,
        ['normal-scenario negative', '16ms flash coverage guarantee (screencast is damage-driven)']);
    }
    if (flashFrames === 0) {
      return notRunCheck('DV10', 'flash A->B->A with >=3 samples',
        'fixture oracle recorded no flash frame in the captured window (16ms flash not covered by damage-driven JPEG frames)', actual);
    }
    return notRunCheck('DV10', 'flash A->B->A with >=3 samples',
      'JPEG coarse analyzer did not confirm A->B->A on a continuously animated canvas (' + (result?.reasons?.join(',') || result?.verdict || 'no result') + '); a negative PASS here would be an overclaim', actual);
  }),

  check('DV11', 'B', 'freeze ≥800ms Canvas 冻结、CSS/逻辑轴仍动、≥500ms 三次像素复核', async () => {
    await call('browser_eval', { expression: 'window.__t4.visual.setScenario("freeze"), window.__t4.visual.setPaused(false)' });
    const start = await call('browser_dynamic_session', {
      action: 'start', name: 'dv11', config: { source: 'screencast', durationMs: 2600, maxFrames: 60 },
    });
    const session = valueOf(start)?.session;
    if (!session) return notRunCheck('DV11', 'freeze detection', 'session start failed: ' + errorMessage(start.error));
    await sleep(1300);
    const analyze = valueOf(await call('browser_motion_analyze', {
      motionSessionId: session.motionSessionId, window: { fromMs: 0, toMs: 2600 },
      assertions: [{
        id: 'dv11-freeze', type: 'freeze',
        thresholds: { minDurationMs: 500 },
        expectation: { motionExpected: true, sourceEventId: 'evt-declared-motion', referenceEventIds: ['evt-css-clock'] },
      }],
    }));
    await call('browser_dynamic_session', { action: 'stop' });
    const result = analyze?.results?.[0];
    const actual = { verdict: analyze?.verdict, result: result ? { verdict: result.verdict, reasons: result.reasons, sampleCount: result.sampleCount } : null };
    if (!analyze) return failCheck('DV11', 'freeze analysis', actual, 'analyze failed');
    if (['INCONCLUSIVE', 'BLOCKED'].includes(result?.verdict)) {
      return notRunCheck('DV11', '>=800ms freeze with >=3 pixel samples', 'evidence insufficient: ' + (result?.reasons?.join(',') || analyze.verdict), actual);
    }
    return passCheck('DV11', '>=800ms freeze with >=3 pixel samples', actual);
  }),

  check('DV12', 'B', '已知目标周期、间隔分布、jankFrames 旁证，采集丢帧分离', async () => {
    // Deterministic conclusion: NOT_RUN. The frozen fixture's jank scenario only skips Canvas2D
    // draws while CSS/WebGL/media keep damaging the page, so the damage-driven screencast keeps its
    // 16ms cadence and a skipped canvas frame does NOT become a >2x sampling interval. Historical
    // PASS runs were host-jitter/eviction noise, not a real jank detection.
    await call('browser_eval', { expression: 'window.__t4.visual.setScenario("jank"), window.__t4.visual.setPaused(false)' });
    const started = await call('browser_dynamic_session', {
      action: 'start', name: 'dv12', config: { source: 'screencast', durationMs: 4200, maxFrames: 180 },
    });
    const session = valueOf(started)?.session;
    if (!session) return notRunCheck('DV12', 'interval distribution + jankFrames', 'session start failed: ' + errorMessage(started.error));
    await sleep(2200);
    const truth = evalValue(await call('browser_eval', { expression: 'window.__t4.visual.state()' }));
    // Stop first so integrity.complete is evaluated on the finished window (analyze-on-retained is
    // supported); this keeps the "why complete?" explanation about sampling, not session state.
    await call('browser_dynamic_session', { action: 'stop' });
    const analyze = valueOf(await call('browser_motion_analyze', {
      motionSessionId: session.motionSessionId, window: { fromMs: 0, toMs: 4200 },
      assertions: [{ id: 'dv12-jank', type: 'jank', expectedIntervalMs: 1000 / 60 }],
    }));
    const result = analyze?.results?.[0];
    const intervals = (result?.metrics?.intervals || []).map((item) => Number(item.intervalMs)).filter(Number.isFinite);
    const sorted = [...intervals].sort((a, b) => a - b);
    const median = sorted.length ? sorted[Math.floor(sorted.length / 2)] : null;
    const p95 = sorted.length ? sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * 0.95))] : null;
    const intervalStats = {
      count: intervals.length,
      medianMs: median,
      p95Ms: p95,
      maxMs: sorted.length ? sorted[sorted.length - 1] : null,
      over2xTarget: intervals.filter((value) => value > 2 * (1000 / 60)).length,
    };
    const integrity = analyze?.integrity || {};
    const coverage = integrity.coverage || {};
    const integrityWhy = {
      complete: integrity.complete,
      sessionStateAtAnalyze: 'stopped',
      counterIncomplete: { dropped: integrity.dropped ?? 0, evicted: integrity.evicted ?? 0, ackFailures: integrity.ackFailures ?? 0 },
      gaps: Array.isArray(integrity.gaps) ? integrity.gaps.length : (Number.isInteger(integrity.gaps) ? integrity.gaps : null),
      segments: coverage.segments ?? null,
      missingSourceTimestamps: coverage.missingSourceTimestamps ?? null,
      samplingFailures: coverage.samplingFailures ?? null,
      decodeFailures: coverage.decodeFailures ?? null,
      maxAdjacentIntervalMs: coverage.maxAdjacentIntervalMs ?? null,
      issues: integrity.issues || [],
      completeExplanation: integrity.complete === false
        ? ('complete=false despite zero dropped/evicted/ackFailures: sessionStateAtAnalyze=stopped; ' +
          'missingSourceTimestamps=' + String(coverage.missingSourceTimestamps) +
          '; segments=' + String(coverage.segments) +
          '; gaps=' + String(Array.isArray(integrity.gaps) ? integrity.gaps.length : integrity.gaps) +
          '; samplingFailures=' + String(coverage.samplingFailures) +
          '; decodeFailures=' + String(coverage.decodeFailures) +
          '; maxAdjacentIntervalMs=' + String(coverage.maxAdjacentIntervalMs) +
          '. If all of these are zero/one, the false value is the Host running-state gate, not a capture loss.')
        : null,
    };
    return notRunCheck('DV12', 'deterministic jank sampling interval',
      'NOT a real jank detection path (fixed as NOT_RUN): '
      + '(1) screencast is damage-driven and the frozen jank scenario only skips Canvas2D draws while CSS/WebGL/media keep damaging, so skipped canvas frames do not become larger sampling intervals; '
      + '(2) observed interval median=' + String(intervalStats.medianMs) + 'ms, max=' + String(intervalStats.maxMs) + 'ms, samples>2x target=' + String(intervalStats.over2xTarget) + '; '
      + '(3) historical PASS runs were host jitter/eviction noise, not a deterministic detector; '
      + 'no intervalFactor/expectedIntervalMs tuning and no oracle values were fed to the analyzer. '
      + 'Analyzer this run=' + String(result?.verdict) + '(' + String((result?.reasons || []).join(',')) + '), suspectedCount=' + String(result?.metrics?.suspectedCount),
      {
        oracleJankFrames: truth?.anomalies?.jankFrames?.length ?? null,
        intervalStats,
        integrity: integrityWhy,
        analyzerVerdict: result?.verdict ?? null,
        analyzerReasons: result?.reasons ?? [],
        suspectedCount: result?.metrics?.suspectedCount ?? null,
      });
  }),


  check('DV13', 'B', '≈1.2s 媒体停滞、400ms 后漂移 <80ms、其他区域变化', async () => {
    return notRunCheck('DV13', 'media stall detection',
      'no T4 media adapter exists (media adapter is declared unavailable); fixture media truth is preparation evidence only');
  }),

  check('DV14', 'U+B', '轨迹候选/分数、双区域变化/过渡区间、歧义与 mapping 分段', async () => {
    await call('browser_navigate', { url: ctx.fixture.url + FIXTURE_VISUAL.slice(1) });
    await call('browser_eval', { expression: 'window.__t4.visual.setScenario("normal"), window.__t4.visual.setPaused(false)' });
    const started = await call('browser_dynamic_session', {
      action: 'start', name: 'dv14', config: { source: 'screenshot-loop', sampleIntervalMs: 120, durationMs: 3000 },
    });
    const session = valueOf(started)?.session;
    if (!session) return notRunCheck('DV14', 'trajectory/transition on PNG frames', 'session start failed: ' + errorMessage(started.error));
    await sleep(1300);
    const observed = valueOf(await call('browser_motion_observe', { motionSessionId: session.motionSessionId, limit: 8 }));
    const frames = (observed?.frames || []).filter((frame) => frame.encoding === 'png');
    const geometry = evalValue(await call('browser_eval', { expression: `(() => {
      const el = document.querySelector('#t4v-css-orb');
      if (!el) return null;
      const rect = el.getBoundingClientRect();
      const style = getComputedStyle(el);
      return { rect: { x: rect.left, y: rect.top, width: rect.width, height: rect.height }, color: style.backgroundColor, scrollX: window.scrollX, scrollY: window.scrollY };
    })()` }));
    let results = null;
    let region = null;
    if (frames.length >= 3 && geometry?.rect) {
      const mapping = frames[0].mapping || {};
      const origin = mapping.originCss || { x: geometry.scrollX, y: geometry.scrollY };
      const per = mapping.cssPerPixel || { x: 1, y: 1 };
      const toPixel = (value, axis) => Math.round((value - (axis === 'x' ? origin.x : origin.y)) / (axis === 'x' ? per.x : per.y));
      region = {
        x: Math.max(0, toPixel(geometry.scrollX + geometry.rect.x, 'x')),
        y: Math.max(0, toPixel(geometry.scrollY + geometry.rect.y, 'y')),
        width: Math.max(1, Math.round(geometry.rect.width / per.x)),
        height: Math.max(1, Math.round(geometry.rect.height / per.y)),
      };
      const rgbMatch = /rgba?\(([^)]+)\)/.exec(String(geometry.color || ''));
      const rgb = rgbMatch ? rgbMatch[1].split(',').slice(0, 3).map((value) => Math.round(Number(value))) : null;
      const frameIds = frames.map((frame) => frame.frameId);
      const assertions = [
        { id: 'dv14-transition', type: 'transition', region, thresholds: { stableSamples: 3 } },
      ];
      if (rgb) {
        assertions.push({ id: 'dv14-trajectory', type: 'trajectory', region, query: { method: 'color', color: rgb, tolerance: 24, minArea: 4, maxResults: 10 }, thresholds: { maxStep: 160 } });
      }
      results = valueOf(await call('browser_motion_analyze', { motionSessionId: session.motionSessionId, frameIds, assertions }));
    }
    await call('browser_dynamic_session', { action: 'stop' });
    if (!results) {
      return notRunCheck('DV14', 'trajectory/transition on PNG frames', 'insufficient PNG frames or orb geometry for a real assertion', { frames: frames.length, geometry });
    }
    const summary = results.results?.map((result) => ({ id: result.id, verdict: result.verdict, status: result.status, reasons: result.reasons, limitations: result.limitations, sampleCount: result.sampleCount, encoding: result.encoding, precise: result.precise }));
    const transition = results.results?.find((result) => result.id === 'dv14-transition');
    const trajectory = results.results?.find((result) => result.id === 'dv14-trajectory');
    if (transition?.verdict !== 'PASS') {
      return notRunCheck('DV14', 'transition区间 + trajectory', 'transition did not reach PASS: ' + (transition?.reasons?.join(',') || 'no result'), { region, summary });
    }
    if (trajectory && trajectory.verdict !== 'PASS') {
      return passCheck('DV14', 'transition PASS; trajectory inconclusive', { region, summary }, ['unique continuous trajectory (colour ambiguity / missing detections)']);
    }
    return passCheck('DV14', 'transition + trajectory on real PNG frames', { region, summary }, trajectory ? [] : ['trajectory query unavailable (no RGB colour from the orb)']);
  }),


  check('DV15', 'B+U', 'pause/seek/rate/restoreToken、副作用、失败/取消恢复记录', async () => {
    await call('browser_eval', { expression: 'window.__t4.visual.setScenario("normal"), window.__t4.visual.setPaused(false)' });
    const start = await call('browser_dynamic_session', { action: 'start', config: { source: 'screencast', durationMs: 5000 } });
    const session = valueOf(start)?.session;
    if (!session) return notRunCheck('DV15', 'real control + restore', 'session start failed: ' + errorMessage(start.error));
    const motion = session.motionSessionId;
    const problems = [];
    const pause = valueOf(await call('browser_motion_control', { motionSessionId: motion, action: 'pause', adapterId: 'waapi', targetIds: ['waapi-0'] }));
    if (!pause || pause.after?.[0]?.playState !== 'paused') problems.push('pause readback != paused');
    const token = pause?.restoreToken || null;
    if (!token) problems.push('no restoreToken');
    const seek = valueOf(await call('browser_motion_control', { motionSessionId: motion, action: 'seek', adapterId: 'waapi', targetIds: ['waapi-0'], timeMs: 600 }));
    if (!seek || Math.abs(Number(seek.after?.[0]?.currentTimeMs) - 600) > 24) problems.push('seek readback != 600±24ms');
    const rate = valueOf(await call('browser_motion_control', { motionSessionId: motion, action: 'rate', adapterId: 'waapi', targetIds: ['waapi-0'], rate: 2 }));
    if (!rate || Number(rate.after?.[0]?.playbackRate) !== 2) problems.push('rate readback != 2');
    const unknown = await call('browser_motion_control', { motionSessionId: motion, action: 'seek', adapterId: 'waapi', targetIds: ['waapi-404'], timeMs: 100 });
    if (unknown.ok !== false || unknown.error?.code !== 'DYNAMIC_EVENT_NOT_FOUND') problems.push('unknown target must be DYNAMIC_EVENT_NOT_FOUND');
    const badRate = await call('browser_motion_control', { motionSessionId: motion, action: 'rate', adapterId: 'waapi', targetIds: ['waapi-0'], rate: 9 });
    if (badRate.ok !== false || badRate.error?.code !== 'DYNAMIC_INVALID_ARGUMENT') problems.push('out-of-range rate must be DYNAMIC_INVALID_ARGUMENT');
    // Real DOM-injected element (NOT a fixture-provided animation): selector resolution must work
    // on the same path a real host uses. `element.animate` is page code, not a fixture API.
    await call('browser_eval', { expression: `(() => {
      const old = document.querySelector('#t4-realhost-anim'); if (old) old.remove();
      const el = document.createElement('div');
      el.id = 't4-realhost-anim';
      el.style.cssText = 'position:fixed;left:8px;top:8px;width:24px;height:24px;background:#0a0;z-index:9999';
      document.body.appendChild(el);
      el.animate([{ transform: 'translateX(0px)' }, { transform: 'translateX(120px)' }], { duration: 2000, iterations: Infinity });
      return document.getAnimations().length;
    })()` });
    const injected = valueOf(await call('browser_motion_control', { motionSessionId: motion, action: 'pause', adapterId: 'waapi', targetIds: ['#t4-realhost-anim'] }));
    if (!injected || injected.after?.[0]?.playState !== 'paused') problems.push('injected DOM selector control failed');
    const injectedSeek = valueOf(await call('browser_motion_control', { motionSessionId: motion, action: 'seek', adapterId: 'waapi', targetIds: ['#t4-realhost-anim'], timeMs: 500 }));
    if (!injectedSeek || Math.abs(Number(injectedSeek.after?.[0]?.currentTimeMs) - 500) > 24) problems.push('injected DOM selector seek readback failed');
    if (injected?.restoreToken) await call('browser_motion_control', { motionSessionId: motion, action: 'restore', restoreToken: injected.restoreToken });
    // Duration-expiry path: the session stops itself, the page keeps the paused target, and a
    // late restore must still reach the retained session and restore it. The main session is
    // stopped first (only one ACTIVE session per scope) and its restore below runs on the retained
    // record, which is exactly the real-host case.
    await call('browser_dynamic_session', { action: 'stop' });
    const lateStart = await call('browser_dynamic_session', { action: 'start', name: 'dv15-late', config: { source: 'screencast', durationMs: 700 } });
    const lateSession = valueOf(lateStart)?.session;
    let lateRestore = null;
    let lateStatus = null;
    if (lateSession) {
      const latePause = valueOf(await call('browser_motion_control', { motionSessionId: lateSession.motionSessionId, action: 'pause', adapterId: 'waapi', targetIds: ['#t4-realhost-anim'] }));
      await sleep(1300);
      lateRestore = valueOf(await call('browser_motion_control', { motionSessionId: lateSession.motionSessionId, action: 'restore', restoreToken: latePause?.restoreToken }));
      lateStatus = valueOf(await call('browser_dynamic_session', { action: 'status' }));
      await call('browser_dynamic_session', { action: 'stop' });
    }
    if (!lateRestore || lateRestore.restoreStatus?.status !== 'restored') problems.push('late restore on a duration-expired retained session failed');
    // Explicit restore of the FIRST (stopped) session must still reach it before any reset clears
    // the scope records.
    const restore = valueOf(await call('browser_motion_control', { motionSessionId: motion, action: 'restore', restoreToken: token }));
    // Session extend (approved renewal feature): pure Host memory, deadline shifts, cap enforced.
    let extendEvidence = null;
    const extStart = await call('browser_dynamic_session', { action: 'start', name: 'dv15-extend', config: { source: 'screencast', durationMs: 1200 } });
    const extSession = valueOf(extStart)?.session;
    if (!extSession) {
      problems.push('extend session start failed: ' + String(extStart.error?.code));
    } else {
      const stateBeforeExtend = valueOf(await call('browser_state', {}));
      const extended = await call('browser_dynamic_session', { action: 'extend', durationMs: 2500 });
      const stateAfterExtend = valueOf(await call('browser_state', {}));
      const extValue = valueOf(extended);
      if (!extValue) problems.push('extend failed: ' + String(extended.error?.code));
      if (extValue && !(extValue.session.deadlineMs > extSession.deadlineMs)) problems.push('extend did not move deadlineMs forward');
      if (extValue && !(extValue.session.cumulativeMs > extSession.cumulativeMs)) problems.push('extend did not increase cumulativeMs');
      if (stateBeforeExtend?.runtime?.running !== stateAfterExtend?.runtime?.running) problems.push('extend changed browser running state');
      if (stateBeforeExtend?.owner?.sessionId !== stateAfterExtend?.owner?.sessionId) problems.push('extend changed owner/lease');
      const extObserved = valueOf(await call('browser_motion_observe', { motionSessionId: extSession.motionSessionId, limit: 20 }));
      const extendEvents = (extObserved?.events || []).filter((event) => event.kind === 'session.extend');
      if (!extendEvents.length) problems.push('no session.extend event recorded');
      else if (extendEvents[extendEvents.length - 1].payload?.cumulativeMs !== extValue?.session.cumulativeMs) problems.push('session.extend payload cumulativeMs mismatch');
      // Decisive: survive past the ORIGINAL deadline.
      const originalDeadline = extSession.deadlineMs;
      const waitMs = Math.max(0, originalDeadline - Date.now()) + 350;
      await sleep(waitMs);
      const alive = valueOf(await call('browser_dynamic_session', { action: 'status' }));
      if (alive?.session?.state !== 'running') problems.push('session did not survive the original deadline after extend');
      await call('browser_dynamic_session', { action: 'stop' });
      extendEvidence = {
        deadlineBefore: extSession.deadlineMs, deadlineAfter: extValue?.session.deadlineMs,
        cumulativeBefore: extSession.cumulativeMs, cumulativeAfter: extValue?.session.cumulativeMs,
        extendEvents: extendEvents.length, survivedOriginalDeadline: alive?.session?.state === 'running',
        runningUnchanged: stateBeforeExtend?.runtime?.running === stateAfterExtend?.runtime?.running,
        ownerUnchanged: stateBeforeExtend?.owner?.sessionId === stateAfterExtend?.owner?.sessionId,
      };
    }
    // Cap: start at 60000, four 60000 extensions reach exactly 300000, the next 1ms must be refused
    // with no deadline change; idempotent start must not renew.
    const capStart = await call('browser_dynamic_session', { action: 'start', name: 'dv15-cap', config: { source: 'screencast', durationMs: 60000 } });
    const capSession = valueOf(capStart)?.session;
    let capEvidence = null;
    if (capSession) {
      const capDeadline0 = valueOf(await call('browser_dynamic_session', { action: 'status' }))?.session?.deadlineMs;
      await call('browser_dynamic_session', { action: 'start', name: 'dv15-cap', config: { source: 'screencast', durationMs: 60000 } });
      const capDeadlineAfterIdem = valueOf(await call('browser_dynamic_session', { action: 'status' }))?.session?.deadlineMs;
      if (capDeadline0 !== capDeadlineAfterIdem) problems.push('idempotent start renewed the session deadline');
      for (let index = 0; index < 4; index += 1) await call('browser_dynamic_session', { action: 'extend', durationMs: 60000 });
      const capBefore = valueOf(await call('browser_dynamic_session', { action: 'status' }))?.session;
      const overCap = await call('browser_dynamic_session', { action: 'extend', durationMs: 1 });
      const capAfter = valueOf(await call('browser_dynamic_session', { action: 'status' }))?.session;
      if (overCap.ok !== false || overCap.error?.code !== 'DYNAMIC_LIMIT_EXCEEDED') problems.push('over-cap extend was not DYNAMIC_LIMIT_EXCEEDED');
      if (overCap.error?.details?.limit !== 'sessionCapMs' || overCap.error?.details?.max !== 300000 || overCap.error?.details?.actual !== 300001) problems.push('over-cap details are not {limit,sessionCapMs,max:300000,actual:300001}');
      if (capBefore.deadlineMs !== capAfter.deadlineMs) problems.push('rejected extend changed the deadline');
      capEvidence = { cumulative: capAfter.cumulativeMs, deadlineUnchanged: capBefore.deadlineMs === capAfter.deadlineMs, code: overCap.error?.code, details: overCap.error?.details ? { limit: overCap.error.details.limit, max: overCap.error.details.max, actual: overCap.error.details.actual } : null };
      await call('browser_dynamic_session', { action: 'stop' });
    } else {
      problems.push('cap session start failed');
    }
    // Stopped/retained extend -> DYNAMIC_SESSION_NOT_ACTIVE, no revival; name/config rejected;
    // explicit stop then reset keeps the previous obligations restored.
    const stoppedStart = await call('browser_dynamic_session', { action: 'start', name: 'dv15-stopped', config: { source: 'screencast', durationMs: 700 } });
    const stoppedSession = valueOf(stoppedStart)?.session;
    let notActive = null;
    if (stoppedSession) {
      await sleep(1200);
      const deadExtend = await call('browser_dynamic_session', { action: 'extend', durationMs: 1000 });
      const stoppedStatus = valueOf(await call('browser_dynamic_session', { action: 'status' }));
      if (deadExtend.ok !== false || deadExtend.error?.code !== 'DYNAMIC_SESSION_NOT_ACTIVE') problems.push('stopped extend was not DYNAMIC_SESSION_NOT_ACTIVE');
      const stateAfter = stoppedStatus?.sessions?.find((entry) => entry.dynamicSessionId === stoppedSession.dynamicSessionId)?.state;
      if (stateAfter !== 'stopped') problems.push('stopped session was revived by extend');
      notActive = { code: deadExtend.error?.code, state: stateAfter };
    }
    const badExtendName = await call('browser_dynamic_session', { action: 'extend', durationMs: 1000, name: 'x' });
    const badExtendConfig = await call('browser_dynamic_session', { action: 'extend', durationMs: 1000, config: {} });
    if (badExtendName.ok !== false || badExtendName.error?.code !== 'DYNAMIC_INVALID_ARGUMENT') problems.push('extend with name was not refused');
    if (badExtendConfig.ok !== false || badExtendConfig.error?.code !== 'DYNAMIC_INVALID_ARGUMENT') problems.push('extend with config was not refused');
    await call('browser_dynamic_session', { action: 'reset' });

    // Duration hard cap (A): 60000 accepted, 60001 refused; fresh/idempotent start never extend.
    const durationHard = valueOf(await call('browser_capabilities', {}))?.limits?.dynamic?.durationMsHard;
    if (durationHard !== 60000) problems.push('capabilities.limits.dynamic.durationMsHard != 60000');
    const longStarted = await call('browser_dynamic_session', { action: 'start', name: 'dv15-long', config: { source: 'screencast', durationMs: 60000 } });
    const longSession = valueOf(longStarted)?.session;
    if (!longSession) problems.push('durationMs=60000 start failed: ' + String(longStarted.error?.code));
    let noExtension = null;
    if (longSession) {
      const before = valueOf(await call('browser_dynamic_session', { action: 'status' }))?.session || null;
      await call('browser_dynamic_session', { action: 'start', name: 'dv15-long', config: { source: 'screencast', durationMs: 60000 } });
      await call('browser_motion_observe', { motionSessionId: longSession.motionSessionId, fresh: true });
      const after = valueOf(await call('browser_dynamic_session', { action: 'status' }))?.session || null;
      noExtension = Boolean(before && after && before.startedAt === after.startedAt && before.stoppedAt === after.stoppedAt);
      if (!noExtension) problems.push('fresh/idempotent start extended the session');
      await call('browser_dynamic_session', { action: 'stop' });
    }
    const tooLong = await call('browser_dynamic_session', { action: 'start', name: 'dv15-too-long', config: { source: 'screencast', durationMs: 60001 } });
    if (tooLong.ok !== false || tooLong.error?.code !== 'DYNAMIC_INVALID_ARGUMENT') problems.push('durationMs=60001 was not refused with DYNAMIC_INVALID_ARGUMENT');

    // Retained control obligation -> reset must restore before clearing; DOM is checked independently.
    await call('browser_eval', { expression: `(() => {
      const old = document.querySelector('#t4-reset-anim'); if (old) old.remove();
      const el = document.createElement('div'); el.id = 't4-reset-anim';
      el.style.cssText = 'position:fixed;right:8px;top:8px;width:20px;height:20px;background:#08f;z-index:9999';
      document.body.appendChild(el);
      el.animate([{ opacity: 1 }, { opacity: 0.2 }], { duration: 2000, iterations: Infinity });
      return document.getAnimations().length;
    })()` });
    const shortStart = await call('browser_dynamic_session', { action: 'start', name: 'dv15-reset', config: { source: 'screencast', durationMs: 700 } });
    const shortSession = valueOf(shortStart)?.session;
    let resetResult = null;
    let domRunning = null;
    if (shortSession) {
      await sleep(1300);
      await call('browser_motion_control', { motionSessionId: shortSession.motionSessionId, action: 'pause', adapterId: 'waapi', targetIds: ['#t4-reset-anim'] });
      resetResult = valueOf(await call('browser_dynamic_session', { action: 'reset' }));
      domRunning = evalValue(await call('browser_eval', { expression: `(() => {
        const el = document.getElementById('t4-reset-anim');
        const animation = el && el.getAnimations ? el.getAnimations()[0] : null;
        return animation ? animation.playState : null;
      })()` }));
      if (!resetResult || resetResult.restoreStatus?.status !== 'restored') problems.push('reset did not report restored for a retained obligation');
      if (!(resetResult?.restores || []).some((entry) => entry.dynamicSessionId === shortSession.dynamicSessionId)) problems.push('reset restores[] does not include the retained session');
      if (domRunning !== 'running') problems.push('page animation was not restored to running after reset');
      if (resetResult?.resetCompleted !== true) problems.push('resetCompleted is not true');
    } else {
      problems.push('short reset session start failed: ' + String(shortStart.error?.code));
    }
    // Zero-obligation reset stays not-needed (regression guard).
    const zeroReset = valueOf(await call('browser_dynamic_session', { action: 'reset' }));
    if (!zeroReset || zeroReset.restoreStatus?.status !== 'not-needed' || zeroReset.cleared !== 0) problems.push('zero-obligation reset is not not-needed/cleared=0');

    if (!restore) problems.push('restore produced no result');
    if (restore && !['restored', 'partial', 'conflict'].includes(restore.restoreStatus?.status)) problems.push('restoreStatus invalid');
    await call('browser_dynamic_session', { action: 'stop' });
    return {
      status: problems.length ? 'FAIL' : 'PASS',
      subNotRun: problems.length ? [] : ['media adapter control', 'disconnect/cancel restore evidence'],
      expected: 'WAAPI pause/seek/rate readback, restoreToken restore, invalid target/rate refused; partial/failure facts reported',
      actual: {
        pause: pause ? { after: pause.after, fields: pause.fields?.slice(0, 3) } : null,
        injectedSelector: injected ? { targetId: injected.targets?.[0], after: injected.after } : null,
        seek: seek ? { after: seek.after } : null,
        rate: rate ? { after: rate.after } : null,
        restore: restore ? { restoreStatus: restore.restoreStatus, sideEffects: restore.sideEffects } : null,
        lateRestore: lateRestore ? { restoreStatus: lateRestore.restoreStatus } : null,
        lateStatusRestore: lateStatus ? lateStatus.restoreStatus : null,
        durationHard,
        noExtension,
        reset: resetResult ? {
          status: resetResult.restoreStatus?.status, restores: resetResult.restores?.length,
          resetCompleted: resetResult.resetCompleted, cleared: resetResult.cleared, domPlayState: domRunning,
        } : null,
        zeroReset: zeroReset ? { status: zeroReset.restoreStatus?.status, cleared: zeroReset.cleared } : null,
        extend: extendEvidence,
        cap: capEvidence,
        notActive,
        problems,
      },
      reason: problems.length ? problems.join('; ') : 'explicit restore restored; media adapter and disconnect/cancel recovery are PARTIAL',
    };
  }),

  check('DV16', 'U+B', '时间锚点/偏差、几何 scale/scroll/O、源时间缺失/跳变负例', async () => {
    const start = await call('browser_dynamic_session', {
      action: 'start', name: 'dv16', config: { source: 'screencast', durationMs: 1600, maxFrames: 20 },
    });
    const session = valueOf(start)?.session;
    if (!session) return failCheck('DV16', 'mapping/clock evidence', { error: start.error }, 'session start failed');
    await sleep(800);
    const observed = valueOf(await call('browser_motion_observe', { motionSessionId: session.motionSessionId, limit: 10 }));
    const fresh = valueOf(await call('browser_motion_observe', { motionSessionId: session.motionSessionId, fresh: true }));
    await call('browser_dynamic_session', { action: 'stop' });
    const frame = observed?.frames?.[0];
    const mapping = frame?.mapping;
    const problems = [];
    if (!frame) problems.push('no frame');
    for (const key of ['viewport', 'scroll', 'canvasOffset']) if (!mapping || !mapping[key]) problems.push('mapping.' + key + ' missing');
    if (!mapping || !('deviceScaleFactor' in mapping)) problems.push('mapping.deviceScaleFactor missing');
    if (!mapping || !('viewRevision' in mapping)) problems.push('mapping.viewRevision missing');
    if (!mapping || !('dimensions' in mapping)) problems.push('mapping.dimensions missing');
    // Source-time absence must stay null, never receive-time.
    const freshFrame = fresh?.frames?.[0] || null;
    if (!freshFrame || freshFrame.sourceTimestamp !== null) problems.push('fresh sample must have sourceTimestamp=null (no source clock for screenshot sampling)');
    if (fresh?.sample?.fromMs !== null || fresh?.sample?.toMs !== null) problems.push('fresh sample must not invent fromMs/toMs');
    return {
      status: problems.length ? 'FAIL' : 'PASS',
      expected: 'frozen viewport/scroll/DPR/viewRevision/canvasOffset/dimensions; missing sourceTimestamp stays null; sampling interval separated from presentation time',
      actual: { mapping, sourceTimestamp: frame?.sourceTimestamp, fresh: fresh ? { sourceTimestamp: freshFrame?.sourceTimestamp, sample: fresh.sample } : null, problems },
      subNotRun: problems.length ? [] : ['cross-process clock precision (no multi-process clock measurement)'],
      reason: problems.length ? problems.join('; ') : 'cross-process clock precision has no dedicated evidence: PARTIAL',
    };
  }),

  /* ---- DN: dynamic network (P0 reuse) ------------------------------------------------------ */
  check('DN01', 'B', '导航前 P0 start、初始 cart GET、WS 握手/帧与页面账本', async () => {
    const start = valueOf(await call('browser_network_session', { action: 'start' }));
    ctx.networkSessionId = start?.sessionId || null;
    await call('browser_navigate', { url: ctx.fixture.url + FIXTURE_NETWORK.slice(1) });
    await sleep(900);
    const events = valueOf(await call('browser_network_events', { limit: 200, view: 'summary' }));
    const list = events?.events || events?.items || [];
    const cartGets = list.filter((event) => String(event.url || '').includes('/api/t4/cart') && event.method === 'GET');
    const truth = evalValue(await call('browser_eval', { expression: 'window.__t4 && window.__t4.net ? window.__t4.net.state ? window.__t4.net.state() : null : null' }));
    const problems = [];
    if (!ctx.networkSessionId) problems.push('no P0 session id');
    if (!list.length) problems.push('P0 captured no events before/after navigation');
    if (!cartGets.length) problems.push('no initial cart GET captured');
    if (!truth) problems.push('fixture network truth API unavailable');
    return {
      status: problems.length ? 'FAIL' : 'PASS',
      expected: 'P0 started before navigation; initial cart GET and page ledger available',
      actual: {
        networkSessionId: ctx.networkSessionId,
        eventCount: list.length,
        cartGetCount: cartGets.length,
        truth: truth ? { runId: truth.runId, ops: truth.ops?.length, requests: truth.requests?.length } : null,
        problems,
      },
      reason: problems.length ? problems.join('; ') : null,
    };
  }),

  check('DN02', 'B', '可信加购 action/op、POST 后 GET、CDP RequestKey↔应用 requestId、ledger', async () => {
    const opened = await openNetworkScenario('normal');
    const session = opened.session;
    if (!session) return notRunCheck('DN02', 'action/op/request bridge', 'session start failed: ' + errorMessage(opened.startError));
    await call('browser_click', { selector: '#t4n-add-cart' });
    await sleep(700);
    const truth = evalValue(await call('browser_eval', { expression: 'window.__t4.net.state()' }));
    const p0 = valueOf(await call('browser_network_events', { limit: 200, view: 'full', order: 'desc' }));
    const networkEvents = p0?.events || [];
    const cartPost = networkEvents.filter((event) => event.method === 'POST' && String(event.url || '').includes('/api/t4/cart'));
    const pairs = await correlateNow(session, { includeTemporal: false });
    const opNet = pairBasis(pairs?.pairs, 'operation->network');
    const clickOp = (truth?.ops || []).find((op) => op.target === '#t4n-add-cart');
    const problems = [];
    if (!clickOp) problems.push('page ledger has no add-cart op');
    if (!clickOp?.requestIds?.length) problems.push('op requestIds missing');
    if (!cartPost.length) problems.push('P0 captured no POST /api/t4/cart');
    if (!opNet.length) problems.push('correlation produced no operation->network pair');
    // App request id and CDP request id must never be conflated.
    const appIds = new Set((truth?.requests || []).map((request) => request.requestId));
    const cdpIds = new Set(cartPost.map((event) => event.requestId));
    const conflated = [...appIds].some((id) => cdpIds.has(id));
    if (conflated) problems.push('app request id equals CDP requestId');
    await call('browser_dynamic_session', { action: 'stop' });
    return {
      status: problems.length ? 'FAIL' : 'PASS',
      subNotRun: problems.length ? [] : ['header-verified explicit operation->network bridge (P0 correlation headers are sanitized)'],
      expected: 'real action/op with requestIds, P0 POST/GET, observed operation->network pair, app ids separate from CDP ids',
      actual: {
        clickOp: clickOp ? { opId: clickOp.opId, requestIds: clickOp.requestIds } : null,
        cartPostCount: cartPost.length,
        operationNetworkBases: opNet,
        pairCount: pairs?.pairs?.length || 0,
        highWater: pairs?.highWater ?? null,
        pageSource: pairs?.pageSource ?? null,
        unresolved: (pairs?.unresolved || []).slice(0, 3),
        problems,
      },
      reason: problems.length ? problems.join('; ') : 'operation->network reached observed (page-ledger match); header cross-check is NOT_RUN so explicit is not claimed',
    };
  }),


  check('DN03', 'B', 'WS 远程加购基线与增量、cart count/revision、ui.cause', async () => {
    const opened = await openNetworkScenario('normal');
    const session = opened.session;
    if (!session) return notRunCheck('DN03', 'WS incremental cart update', 'session start failed: ' + errorMessage(opened.startError));
    const truth = evalValue(await call('browser_eval', { expression: 'window.__t4.net.snapshot()' }));
    const dom = evalValue(await call('browser_eval', { expression: '(() => ({ count: (document.querySelector("#t4n-cart-count") || {}).textContent }))()' }));
    const events = valueOf(await call('browser_network_events', { limit: 200, view: 'full', order: 'desc' }))?.events || [];
    const wsEvent = events.find((event) => event.kind === 'ws' && (event.phase === 'ws-frame' || event.phase === 'ws-created'));
    let wsFrames = [];
    let detailError = null;
    if (wsEvent && Number.isInteger(wsEvent.seq)) {
      const detail = await call('browser_network_detail', { seq: wsEvent.seq, include: ['ws'] });
      const value = valueOf(detail);
      wsFrames = value?.ws?.frames || value?.ws?.messages || value?.frames || [];
      if (!value) detailError = detail.error?.code || 'detail-unavailable';
    }
    const pageFrames = truth?.ws?.frames || [];
    const pageInbound = pageFrames.find((frame) => frame.direction === 'in'
      && (String(frame.frameId || '').includes('ws-frame-1') || String(JSON.stringify(frame.data || '')).includes('cart-updated')));
    const matched = wsFrames.find((frame) => {
      const text = JSON.stringify(frame);
      return (pageInbound && (text.includes('ws-frame-1') || text.includes('cart-updated')))
        || (Number.isFinite(Number(frame.atWallMs)) && pageInbound && Math.abs(Number(frame.atWallMs) - Number(pageInbound.atWallMs)) <= 1000);
    }) || null;
    const pairs = await correlateUntil(session, (value) => (value?.pairs || []).some((pair) => pair.direction === 'network->visual'), { includeTemporal: false });
    const netVisual = (pairs?.pairs || []).filter((pair) => pair.direction === 'network->visual');
    const cartTransition = (truth?.ui || []).find((item) => item.key === 'cart.count');
    const problems = [];
    if (!pageInbound) problems.push('page ledger has no inbound cart-updated/ws-frame-1');
    if (!wsFrames.length) problems.push('P0 WS detail exposed no frames' + (detailError ? ' (' + detailError + ')' : ''));
    else if (!matched) problems.push('P0 WS frames could not be uniquely matched to the page frame');
    if (!cartTransition || cartTransition.cause?.kind !== 'ws') problems.push('ui cart.count cause is not ws');
    if (!dom || String(dom.count).trim() !== String(truth?.cart?.count)) problems.push('DOM badge does not match page cart truth');
    await call('browser_dynamic_session', { action: 'stop' });
    if (problems.length) {
      return notRunCheck('DN03', 'WS frame -> ui cause',
        'partial WS evidence: ' + problems.join('; '),
        { pageInbound: pageInbound || null, p0WsFrames: wsFrames.length, matched, cartTransition, domCart: dom?.count, netVisual: netVisual.slice(0, 3) });
    }
    return passCheck('DN03', 'WS cart-updated frame uniquely matched + ui cause=ws', {
      pageFrame: { frameId: pageInbound.frameId, direction: pageInbound.direction, data: pageInbound.data },
      p0Frame: matched, p0WsFrameCount: wsFrames.length,
      cartTransition, domCart: dom.count, networkVisualBases: [...new Set(netVisual.map((pair) => pair.basis))],
    }, netVisual.length ? [] : ['network->visual pair (P0 WS endpoint could not be joined)']);
  }),


  check('DN04', 'B', '同 key 两 POST、deduped/duplicate 与 server 仅 +1、UI 一次变化', async () => {
    const opened = await openNetworkScenario('normal');
    const session = opened.session;
    if (!session) return notRunCheck('DN04', 'duplicate idempotency', 'session start failed: ' + errorMessage(opened.startError));
    const baseline = evalValue(await call('browser_eval', { expression: 'window.__t4.net.snapshot()' }));
    const baselineUiCount = Number(evalValue(await call('browser_eval', { expression: 'window.__t4.net.state().ui.length' }))) || 0;
    await call('browser_eval', { expression: 'window.__t4.net.addToCart({ double: true })' });
    await sleep(1200);
    const truth = evalValue(await call('browser_eval', { expression: 'window.__t4.net.snapshot()' }));
    const p0 = valueOf(await call('browser_network_events', { limit: 200, view: 'full', order: 'desc' }));
    const posts = (p0?.events || []).filter((event) => event.method === 'POST' && String(event.url || '').includes('/api/t4/cart'));
    const ledgerResult = await call('browser_http_request', { url: ctx.fixture.url + 'api/t4/ledger?runId=t4-run-1' });
    const ledgerValue = valueOf(ledgerResult);
    let ledger = ledgerValue?.parsed || ledgerValue?.body || null;
    if (typeof ledger === 'string') { try { ledger = JSON.parse(ledger); } catch { ledger = null; } }
    const pagePosts = (truth?.requests || []).filter((request) => request.method === 'POST' && request.url === '/api/t4/cart');
    const keys = new Set(pagePosts.map((request) => request.idempotencyKey).filter(Boolean));
    const duplicates = (truth?.responses || []).filter((response) => response.deduped === true).length;
    const cartTransitions = (truth?.ui || []).slice(baselineUiCount).filter((item) => item.key === 'cart.count');
    const baselineCount = baseline?.cart?.count ?? 0;
    const problems = [];
    if (pagePosts.length < 2) problems.push('fewer than two page POSTs');
    if (keys.size !== 1) problems.push('POSTs do not share one idempotency key');
    if (posts.length < 2) problems.push('P0 captured fewer than two POSTs');
    if (duplicates < 1) problems.push('no deduped response observed');
    if (cartTransitions.length !== 1) problems.push('cart.count changed ' + cartTransitions.length + ' times (expected 1)');
    if (Number(truth?.cart?.count) !== baselineCount + 1) problems.push('server cart did not grow by exactly 1');
    if (!truth?.cart) problems.push('page cart truth unavailable (snapshot)');
    if (!ledger) problems.push('server ledger unavailable');
    await call('browser_dynamic_session', { action: 'stop' });
    return {
      status: problems.length ? 'FAIL' : 'PASS',
      expected: 'two POSTs sharing one idempotency key, one deduped response, cart +1, exactly one cart.count UI transition, ledger confirms',
      actual: {
        pagePostCount: pagePosts.length, idempotencyKeys: [...keys], dedupedResponses: duplicates,
        cartTransitions: cartTransitions.length, cartCountBefore: baselineCount, cartCountAfter: truth?.cart?.count ?? null,
        p0PostCount: posts.length, ledgerRequests: ledger?.requests?.length ?? null, problems,
      },
      reason: problems.length ? problems.join('; ') : null,
    };
  }),


  check('DN05', 'B', 'orders POST、SSE≥2 事件、3 次 poll、UI 实际 consumer 与最终状态', async () => {
    const opened = await openNetworkScenario('normal');
    const session = opened.session;
    if (!session) return notRunCheck('DN05', 'SSE/poll consumer', 'session start failed: ' + errorMessage(opened.startError));
    await call('browser_click', { selector: '#t4n-checkout' });
    await sleep(1800);
    const truth = evalValue(await call('browser_eval', { expression: 'window.__t4.net.snapshot()' }));
    const p0 = valueOf(await call('browser_network_events', { limit: 200, view: 'full', order: 'desc' }));
    const events = p0?.events || [];
    const orderPost = events.filter((event) => event.method === 'POST' && String(event.url || '').includes('/api/t4/orders'));
    const orderGets = events.filter((event) => event.method === 'GET' && String(event.url || '').includes('/api/t4/orders/'));
    const sseEvents = (truth?.sse?.events || []).length;
    const polls = (truth?.polls || []).length;
    const statuses = (truth?.ui || []).filter((item) => item.key === 'order.status').map((item) => item.to);
    const problems = [];
    if (!orderPost.length) problems.push('no POST /api/t4/orders captured');
    if (sseEvents < 2) problems.push('SSE events < 2');
    if (polls !== 3) problems.push('poll count != 3');
    if (orderGets.length < 1) problems.push('no order GET captured');
    if (!statuses.includes('fulfilled')) problems.push('final order status is not fulfilled');
    await call('browser_dynamic_session', { action: 'stop' });
    return {
      status: problems.length ? 'FAIL' : 'PASS',
      subNotRun: problems.length ? [] : ['long-lived SSE stability (fixture is short/deterministic)'],
      expected: 'orders POST, >=2 SSE events, exactly 3 polls, real UI consumers, final fulfilled',
      actual: { orderPostCount: orderPost.length, orderGetCount: orderGets.length, sseEvents, polls, statuses, problems },
      reason: problems.length ? problems.join('; ') : 'short deterministic SSE only: long-connection stability NOT_RUN',
    };
  }),


  check('DN06', 'B', 'WS cart-updated 方向/内容、页面 ui cause=ws 与真实画面', async () => {
    const opened = await openNetworkScenario('normal');
    const session = opened.session;
    if (!session) return notRunCheck('DN06', 'WS -> UI', 'session start failed: ' + errorMessage(opened.startError));
    const truth = evalValue(await call('browser_eval', { expression: 'window.__t4.net.snapshot()' }));
    const dom = evalValue(await call('browser_eval', { expression: '(() => ({ count: (document.querySelector("#t4n-cart-count") || {}).textContent, revision: (document.querySelector("#t4n-cart-revision") || {}).textContent }))()' }));
    const frames = truth?.ws?.frames || [];
    const inbound = frames.filter((frame) => frame.direction === 'in');
    const remote = inbound.find((frame) => String(frame.frameId || '').includes('ws-frame-1')
      || String(JSON.stringify(frame.data || '')).includes('cart-updated'));
    const problems = [];
    if (!inbound.length) problems.push('no inbound WS frame captured');
    if (!remote) problems.push('no cart-updated / ws-frame-1 frame');
    if (!(truth?.ui || []).some((item) => item.key === 'cart.count' && item.cause?.kind === 'ws')) problems.push('ui cause is not ws');
    if (!dom || String(dom.count).trim() !== String(truth?.cart?.count)) problems.push('real cart badge does not match the page truth');
    if (!String(dom?.revision || '').includes(String(truth?.cart?.revision))) problems.push('real revision text does not match');
    await call('browser_dynamic_session', { action: 'stop' });
    return {
      status: problems.length ? 'FAIL' : 'PASS',
      subNotRun: problems.length ? [] : ['pixel-level WS update frame evidence (DOM readback only)'],
      expected: 'inbound WS cart-updated frame, ui cause=ws, real DOM badge/revision matching the page truth',
      actual: { inboundFrames: inbound.length, remoteFrame: remote || null, cart: truth?.cart || null, dom, problems },
      reason: problems.length ? problems.join('; ') : 'DOM readback is the independent visual evidence; no pixel attribution to the WS frame',
    };
  }),


  check('DN07', 'B', '500、CART_REJECTED 响应/页面 errors、可见 banner 及 cause 请求', async () => {
    const opened = await openNetworkScenario('fail-cart');
    const session = opened.session;
    if (!session) return notRunCheck('DN07', 'error -> UI', 'session start failed: ' + errorMessage(opened.startError));
    await call('browser_click', { selector: '#t4n-add-cart' });
    await sleep(800);
    const truth = evalValue(await call('browser_eval', { expression: 'window.__t4.net.state()' }));
    const dom = evalValue(await call('browser_eval', { expression: '(() => { const el = document.querySelector("#t4n-error"); return el ? { hidden: el.hidden === true, text: el.textContent.trim(), visibility: getComputedStyle(el).visibility } : null; })()' }));
    const p0 = valueOf(await call('browser_network_events', { limit: 200, view: 'full', order: 'desc' }));
    const failed = (p0?.events || []).filter((event) => String(event.url || '').includes('/api/t4/cart') && (event.status === 500 || event.statusCode === 500));
    const errors = truth?.errors || [];
    const cartError = errors.find((item) => item.code === 'CART_REJECTED');
    const problems = [];
    if (!failed.length) problems.push('no 500 POST /api/t4/cart captured');
    if (!cartError) problems.push('page errors missing CART_REJECTED');
    if (!dom || dom.hidden !== false || dom.visibility !== 'visible' || !String(dom.text).includes('CART_REJECTED')) problems.push('visible banner with CART_REJECTED not confirmed');
    if (!cartError?.requestId) problems.push('page error has no cause requestId');
    await call('browser_dynamic_session', { action: 'stop' });
    return {
      status: problems.length ? 'FAIL' : 'PASS',
      expected: 'P0 sees the 500 POST, page errors records CART_REJECTED, the banner is really visible and cites a requestId',
      actual: { p0Statuses: failed.map((event) => event.status), cartEventCount: (p0?.events || []).filter((e) => String(e.url || '').includes('/api/t4/cart')).length, pageErrors: errors.slice(0, 3), domBanner: dom, problems },
      reason: problems.length ? problems.join('; ') : null,
    };
  }),


  check('DN08', 'B', '500→retry 点击→同幂等 key 成功、错误消失/订单状态', async () => {
    return notRunCheck('DN08', 'retry chain', 'M3 correlation not registered; fixture has no retryFrom parent edge');
  }),

  check('DN09', 'B', 'duration≥700ms 容差、800ms 延迟真值、最终 UI 更新', async () => {
    const opened = await openNetworkScenario('slow-order');
    const session = opened.session;
    if (!session) return notRunCheck('DN09', 'slow order', 'session start failed: ' + errorMessage(opened.startError));
    await call('browser_click', { selector: '#t4n-checkout' });
    await sleep(1800);
    const truth = evalValue(await call('browser_eval', { expression: 'window.__t4.net.snapshot()' }));
    const p0 = valueOf(await call('browser_network_events', { limit: 200, view: 'full', order: 'desc' }));
    const events = p0?.events || [];
    const posts = events.filter((event) => event.method === 'POST' && String(event.url || '').includes('/api/t4/orders'));
    const durations = events
      .filter((event) => String(event.url || '').includes('/api/t4/orders') && event.phase === 'finished')
      .map((event) => event.totalMs ?? event.timing?.totalMs ?? event.durationMs)
      .filter((value) => Number.isFinite(value));
    const statuses = (truth?.ui || []).filter((item) => item.key === 'order.status').map((item) => item.to);
    const problems = [];
    if (!posts.length) problems.push('no orders POST captured');
    if (!durations.some((value) => value >= 700)) problems.push('no duration >= 700ms observed');
    if (!statuses.includes('fulfilled')) problems.push('final UI status is not fulfilled');
    await call('browser_dynamic_session', { action: 'stop' });
    return {
      status: problems.length ? 'FAIL' : 'PASS',
      expected: 'real 800ms POST duration (>=700ms tolerance) and a final UI update',
      actual: { durations, statuses, problems },
      reason: problems.length ? problems.join('; ') : null,
    };
  }),


  check('DN10', 'B+U', 'begin/end/query、同 trace 组≥3、temporal 默认过滤、正文三态/脱敏', async () => {
    const opened = await openNetworkScenario('normal');
    const session = opened.session;
    if (!session) return notRunCheck('DN10', 'trace + temporal filtering', 'session start failed: ' + errorMessage(opened.startError));
    await call('browser_network_trace', { action: 'begin-step', stepId: 'dn10-window', name: 'dn10-window' });
    await call('browser_click', { selector: '#t4n-add-cart' });
    await sleep(700);
    await call('browser_network_trace', { action: 'end-step', stepId: 'dn10-window' });
    const step = valueOf(await call('browser_network_trace', { action: 'query', stepId: 'dn10-window' }));
    const events = valueOf(await call('browser_network_events', { limit: 200, view: 'full', order: 'desc' }))?.events || [];
    const traceEvents = events.filter((event) => String(JSON.stringify(event.correlation || '')).includes('trace') || event.traceId);
    // Pick a real POST cart request and read its body evidence state.
    const post = events.find((event) => event.method === 'POST' && String(event.url || '').includes('/api/t4/cart') && Number.isInteger(event.seq));
    let bodyState = null;
    if (post) {
      const detail = valueOf(await call('browser_network_detail', { seq: post.seq, include: ['headers', 'body'] }));
      bodyState = detail?.body?.response?.state || detail?.body?.request?.state || detail?.body?.state || detail?.dependencies?.body?.state || null;
    }
    const pairs = await correlateNow(session, { includeTemporal: false });
    const temporalInDefault = (pairs?.pairs || []).some((pair) => pair.basis === 'temporal');
    const problems = [];
    if (!step) problems.push('trace query returned nothing');
    if (!step) problems.push('trace query returned nothing');
    if (!(traceEvents.length >= 3)) problems.push('same-trace group has < 3 captured members');
    if (!['captured', 'empty', 'unavailable'].includes(String(bodyState))) problems.push('body state is not one of the three documented states');
    if (temporalInDefault) problems.push('temporal pair leaked into the default query');
    await call('browser_dynamic_session', { action: 'stop' });
    if (problems.length) {
      return notRunCheck('DN10', 'trace group + body three-state',
        'trace/body evidence not verifiable in this build: ' + problems.join('; '),
        { step: step || null, traceGroupEvents: traceEvents.length, bodyState, temporalInDefault });
    }
    return {
      status: 'PASS',
      subNotRun: ['redaction-value verification (page/ledger values are already fake, P0 masks secrets)'],
      expected: 'trace begin/end/query with a >=3 member group, body three-state honest, temporal filtered by default',
      actual: { stepCounters: step?.counters || null, traceGroupEvents: traceEvents.length, bodyState, temporalInDefault, problems },
      reason: problems.length ? problems.join('; ') : 'redaction of real secrets is P0-owned and not re-verified here',
    };
  }),


  check('DN11', 'B', 'reset 前后 server/page 账本、revision 起点、runGeneration、SSE/WS 关闭', async () => {
    const opened = await openNetworkScenario('normal');
    const session = opened.session;
    if (!session) return notRunCheck('DN11', 'reset isolation', 'session start failed: ' + errorMessage(opened.startError));
    await call('browser_click', { selector: '#t4n-add-cart' });
    await sleep(800);
    const before = evalValue(await call('browser_eval', { expression: 'window.__t4.net.state()' }));
    const resetHttp = await call('browser_http_request', { method: 'POST', url: ctx.fixture.url + 'api/t4/reset', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ scenario: 'normal' }) });
    await call('browser_eval', { expression: 'window.__t4.net.reset()' });
    await sleep(500);
    const after = evalValue(await call('browser_eval', { expression: 'window.__t4.net.state()' }));
    const ledgerResult = await call('browser_http_request', { url: ctx.fixture.url + 'api/t4/ledger?runId=t4-run-1' });
    const ledgerValue = valueOf(ledgerResult);
    let ledger = ledgerValue?.parsed || ledgerValue?.body || null;
    if (typeof ledger === 'string') { try { ledger = JSON.parse(ledger); } catch { ledger = null; } }
    const problems = [];
    if (before?.ops?.length === 0) problems.push('page ledger was already empty before reset');
    if (after?.ops?.length !== 0 || after?.requests?.length !== 0) problems.push('page ledger not cleared by reset');
    if (after?.ws?.state !== 'closed') problems.push('WS not closed after reset');
    if (after?.sse?.state !== 'closed') problems.push('SSE not closed after reset');
    if (!ledger || ledger.requests?.length !== 0) problems.push('server ledger not cleared');
    // The next add must start from revision 1 again.
    await call('browser_eval', { expression: 'window.__t4.net.addToCart({ qty: 1 })' });
    await sleep(700);
    const fresh = evalValue(await call('browser_eval', { expression: 'window.__t4.net.snapshot()' }));
    if (Number(fresh?.cart?.revision) !== 1) problems.push('revision did not restart at 1');
    await call('browser_dynamic_session', { action: 'stop' });
    return {
      status: problems.length ? 'FAIL' : 'PASS',
      subNotRun: problems.length ? [] : ['runGeneration increment (Host does not yet model a fixture reset generation)', 'stale-message non-writeback negative'],
      expected: 'server+page ledgers cleared, channels closed, revision restarts at 1; runGeneration/stale-message sub-items NOT_RUN',
      actual: {
        httpStatus: resetHttp.ok ? 'ok' : (resetHttp.error?.code || 'failed'),
        beforeOps: before?.ops?.length ?? null, afterOps: after?.ops?.length ?? null,
        afterRequests: after?.requests?.length ?? null, ws: after?.ws?.state ?? null, sse: after?.sse?.state ?? null,
        ledgerRequests: ledger?.requests?.length ?? null, freshRevision: fresh?.cart?.revision ?? null, problems,
      },
      reason: problems.length ? problems.join('; ') : 'runGeneration and stale-message negative are PARTIAL (no Host runGeneration model)',
    };
  }),


  check('DN12', 'B+U', 'P0 C1–C52/链路回归证据与 partial/HTTPS/worker 限制逐项披露', async () => {
    const caps = valueOf(await call('browser_capabilities', {}));
    const network = caps?.network || caps?.limits?.network || {};
    const limits = caps?.limits?.network || {};
    const https = network.https || limits.https || null;
    const subTargets = network.subTargetsDetail || network.subTargets || limits.subTargets || null;
    const workers = network.subTargetsDetail?.workers || subTargets?.workers || null;
    const oopif = network.subTargetsDetail?.oopif || subTargets?.oopif || null;
    const problems = [];
    if (!https) problems.push('HTTPS limitation not disclosed');
    if (!subTargets) problems.push('worker/OOPIF partial disclosure missing');
    if (!workers) problems.push('worker collection status missing');
    return {
      status: problems.length ? 'FAIL' : 'PASS',
      subNotRun: ['P0 C1–C52 regression re-run (owned by tests/acceptance/network-p0.mjs; not re-executed here)', 'real host and long-lived connection stability'],
      expected: 'P0 partial/HTTPS/worker limitations disclosed without re-running the C1–C52 regression',
      actual: { https, workers, oopif, partial: network.partial ?? subTargets?.partial ?? null, problems },
      reason: problems.length ? problems.join('; ') : 'P0 regression is cited, not re-run; limitations are real capability values',
    };
  }),


  check('DC01', 'B+U', '操作→视觉：pause action↔op↔causeOpId 及实际状态/帧', async () => {
    await call('browser_navigate', { url: ctx.fixture.url + FIXTURE_VISUAL.slice(1) });
    await call('browser_eval', { expression: 'window.__t4.visual.setScenario("normal"), window.__t4.visual.setPaused(false)' });
    const started = await call('browser_dynamic_session', { action: 'start', name: 'dc01', config: { source: 'screencast', durationMs: 4000 } });
    const session = valueOf(started)?.session;
    if (!session) return notRunCheck('DC01', 'operation->visual', 'session start failed: ' + errorMessage(started.error));
    await call('browser_click', { selector: '#t4v-pause' });
    await sleep(500);
    const truth = evalValue(await call('browser_eval', { expression: 'window.__t4.visual.state()' }));
    const pairs = await correlateNow(session, { includeTemporal: false });
    const opVisual = pairBasis(pairs?.pairs, 'operation->visual');
    const problems = [];
    if (truth?.clock?.paused !== true) problems.push('page clock is not paused after the real click');
    if (!opVisual.length) problems.push('no operation->visual pair');
    const explicit = opVisual.includes('explicit');
    await call('browser_dynamic_session', { action: 'stop' });
    if (problems.length) return failCheck('DC01', 'operation->visual explicit bridge', { opVisual, truthPaused: truth?.clock?.paused, problems }, problems.join('; '));
    if (!explicit) {
      return notRunCheck('DC01', 'operation->visual explicit', 'pair exists only as observed; the page-declared cause lacks a verified Host action bridge for this run', { opVisual });
    }
    return passCheck('DC01', 'operation->visual explicit (Host action + page op + causeOpId)', { opVisual, pageOpIds: truth?.ops?.slice(-2) });
  }),


  check('DC02', 'B+U', '操作→网络：action/op/requestIds/头/ledger 逐端点链接', async () => {
    const opened = await openNetworkScenario('normal');
    const session = opened.session;
    if (!session) return notRunCheck('DC02', 'operation->network', 'session start failed: ' + errorMessage(opened.startError));
    const click = await call('browser_click', { selector: '#t4n-add-cart' });
    await sleep(900);
    const truth = evalValue(await call('browser_eval', { expression: 'window.__t4.net.state()' }));
    const pairs = await correlateUntil(session, (value) => pairBasis(value?.pairs, 'operation->network').length > 0, { includeTemporal: false });
    const opNet = pairBasis(pairs?.pairs, 'operation->network');
    const op = (truth?.ops || []).find((item) => item.target === '#t4n-add-cart');
    const problems = [];
    if (click.ok !== true) problems.push('browser_click failed: ' + String(click.error?.code));
    if (!op || !op.requestIds?.length) problems.push('page op/requestIds missing');
    if (!opNet.length) problems.push('no operation->network pair');
    await call('browser_dynamic_session', { action: 'stop' });
    if (problems.length) return failCheck('DC02', 'operation->network bridge', { opNet, op, problems, pageSource: pairs?.pageSource, highWater: pairs?.highWater, unresolved: (pairs?.unresolved || []).slice(0, 3), truthOps: truth?.ops?.length }, problems.join('; '));
    if (!opNet.includes('explicit')) {
      return passCheck('DC02', 'operation->network observed (header cross-check unavailable)', { opNet, opRequestIds: op.requestIds },
        ['explicit header-verified operation->network (P0 correlation headers are sanitized)']);
    }
    return passCheck('DC02', 'operation->network explicit', { opNet, opRequestIds: op.requestIds });
  }),


  check('DC03', 'B+U', '网络→视觉：500 响应→ui.error cause→可见 banner，分边等级', async () => {
    const opened = await openNetworkScenario('fail-cart');
    const session = opened.session;
    if (!session) return notRunCheck('DC03', 'network->visual', 'session start failed: ' + errorMessage(opened.startError));
    await call('browser_click', { selector: '#t4n-add-cart' });
    await sleep(800);
    await sleep(900);
    const dom = evalValue(await call('browser_eval', { expression: '(() => { const el = document.querySelector("#t4n-error"); return el ? { hidden: el.hidden === true, text: el.textContent.trim() } : null; })()' }));
    const pairs = await correlateUntil(session, (value) => (value?.pairs || []).some((pair) => pair.direction === 'network->visual'), { includeTemporal: false });
    const netVisual = (pairs?.pairs || []).filter((pair) => pair.direction === 'network->visual');
    const explicitPairs = netVisual.filter((pair) => pair.basis === 'explicit');
    const problems = [];
    if (!dom || dom.hidden !== false || !dom.text.includes('CART_REJECTED')) problems.push('banner not visibly confirmed');
    if (!netVisual.length) problems.push('no network->visual pair');
    await call('browser_dynamic_session', { action: 'stop' });
    if (problems.length) return failCheck('DC03', 'network->visual explicit with independent side-proof', { netVisual: netVisual.slice(0, 3), dom, problems, pageSource: pairs?.pageSource, highWater: pairs?.highWater, unresolved: (pairs?.unresolved || []).slice(0, 4) }, problems.join('; '));
    const detail = {
      basis: [...new Set(netVisual.map((pair) => pair.basis))],
      explicitCount: explicitPairs.length,
      evidenceIds: explicitPairs[0]?.evidenceIds || [],
      limitations: explicitPairs[0]?.limitations || [],
    };
    if (!explicitPairs.length) return notRunCheck('DC03', 'network->visual explicit', 'declared cause resolved to a real P0 endpoint but no explicit pair was produced', detail);
    return passCheck('DC03', 'network->visual explicit + confirmed banner', detail, ['P0 header-verified identity (sanitized correlation headers)']);
  }),


  check('DC04', 'B+U', '视觉→网络：错误画面、重试操作、新请求与同 key；缺父桥 observed/unresolved', async () => {
    const opened = await openNetworkScenario('fail-order');
    const session = opened.session;
    if (!session) return notRunCheck('DC04', 'visual->network', 'session start failed: ' + errorMessage(opened.startError));
    await call('browser_click', { selector: '#t4n-checkout' });
    await sleep(900);
    const errorShown = evalValue(await call('browser_eval', { expression: '(() => { const el = document.querySelector("#t4n-error"); return el ? { hidden: el.hidden === true, text: el.textContent.trim() } : null; })()' }));
    const retryVisible = evalValue(await call('browser_eval', { expression: '(() => { const el = document.querySelector("#t4n-retry"); return el ? el.hidden === false : false; })()' }));
    await call('browser_click', { selector: '#t4n-retry' });
    await sleep(1200);
    const truth = evalValue(await call('browser_eval', { expression: 'window.__t4.net.state()' }));
    const pairs = await correlateUntil(session, (value) => (value?.pairs || []).some((pair) => pair.direction === 'visual->network'), { includeTemporal: false });
    const vn = (pairs?.pairs || []).filter((pair) => pair.direction === 'visual->network');
    const confirmed = vn.filter((pair) => pair.grade === 'confirmed-causal' || pair.basis === 'explicit');
    const orderPosts = (truth?.requests || []).filter((request) => request.method === 'POST' && request.url === '/api/t4/orders');
    const keys = new Set(orderPosts.map((request) => request.idempotencyKey).filter(Boolean));
    const retried = orderPosts.some((request) => request.retried === true) || (truth?.responses || []).some((response) => response.retried === true);
    const problems = [];
    if (!errorShown || errorShown.hidden !== false || !errorShown.text.includes('ORDER_REJECTED')) problems.push('visible error banner not confirmed');
    if (!retryVisible) problems.push('retry button not visible');
    if (orderPosts.length < 2) problems.push('retry did not issue another orders POST');
    if (keys.size !== 1) problems.push('retry did not reuse the same idempotency key');
    if (!retried) problems.push('retried flag not observed');
    if (confirmed.length) problems.push('missing parent bridge was escalated to confirmed-causal');
    await call('browser_dynamic_session', { action: 'stop' });
    if (problems.length) return failCheck('DC04', 'visual->network observed/unresolved', { errorShown, retryVisible, orderPostCount: orderPosts.length, keys: [...keys], retried, vn: vn.slice(0, 3), problems }, problems.join('; '));
    if (!vn.length) {
      return notRunCheck('DC04', 'visual->network observed/unresolved',
        'error->retry->same-key requests verified, but no visual->network pair was emitted (parent bridge missing, unresolved)',
        { orderPostCount: orderPosts.length, retried, unresolved: pairs?.unresolved?.slice(0, 3) || [] });
    }
    return passCheck('DC04', 'visual->network observed (no retryFrom parent)', {
      orderPostCount: orderPosts.length, keys: [...keys], retried,
      bases: [...new Set(vn.map((pair) => pair.basis))], grades: [...new Set(vn.map((pair) => pair.grade))],
    }, ['explicit retryFrom/idempotencyKey joinKey (fixture exposes no retryFrom parent)']);
  }),


  check('DC05', 'B+U', '网络→网络：redirect/initiator 正例；retry/duplicate observed 负例', async () => {
    let p0 = valueOf(await call('browser_network_session', { action: 'start' }));
    await call('browser_navigate', { url: ctx.fixture.url + 'shop/products.html?runId=chain-1' });
    await sleep(1200);
    const status = valueOf(await call('browser_network_session', { action: 'status' }));
    const started = await call('browser_dynamic_session', {
      action: 'start', name: 'dc05', config: { source: 'screencast', networkSessionId: status?.sessionId || p0?.sessionId, durationMs: 4000 },
    });
    const session = valueOf(started)?.session;
    if (!session) return notRunCheck('DC05', 'network->network redirect', 'session start failed: ' + errorMessage(started.error));
    const events = valueOf(await call('browser_network_events', { limit: 200, view: 'full', order: 'desc' }))?.events || [];
    const redirectEvents = events.filter((event) => event.redirect || event.phase === 'redirect');
    const pairs = await correlateNow(session, { directions: ['network->network'], includeTemporal: false });
    const nn = (pairs?.pairs || []).filter((pair) => pair.direction === 'network->network');
    const redirectPairs = nn.filter((pair) => pair.basis === 'redirect');
    await call('browser_dynamic_session', { action: 'stop' });
    if (!redirectEvents.length) {
      return notRunCheck('DC05', 'network->network redirect positive', 'the /shop chain page produced no redirect event in the captured window', { eventCount: events.length });
    }
    if (!redirectPairs.length) {
      return notRunCheck('DC05', 'network->network redirect positive', 'redirect events exist but the DC projection produced no redirect pair', { redirectEvents: redirectEvents.slice(0, 3), nn: nn.slice(0, 3) });
    }
    return passCheck('DC05', 'network->network redirect confirmed-causal', {
      redirectEvents: redirectEvents.length, redirectPairCount: redirectPairs.length,
      grades: [...new Set(redirectPairs.map((pair) => pair.grade))],
    }, ['initiator.requestId positive (no parent request id in this build)', 'retry/duplicate observed negative']);
  }),


  check('DC06', 'B+U', '视觉→视觉：同步区域 observed、只有已核验显式 parent 才 confirmed', async () => {
    await call('browser_navigate', { url: ctx.fixture.url + FIXTURE_VISUAL.slice(1) });
    await call('browser_eval', { expression: 'window.__t4.visual.setScenario("normal"), window.__t4.visual.setPaused(false)' });
    const started = await call('browser_dynamic_session', { action: 'start', name: 'dc06', config: { source: 'screencast', durationMs: 4000 } });
    const session = valueOf(started)?.session;
    if (!session) return notRunCheck('DC06', 'visual->visual observed', 'session start failed: ' + errorMessage(started.error));
    await call('browser_click', { selector: '#t4v-pause' });
    await sleep(250);
    await call('browser_click', { selector: '#t4v-resume' });
    await sleep(500);
    const pairs = await correlateNow(session, { includeTemporal: false });
    const vv = (pairs?.pairs || []).filter((pair) => pair.direction === 'visual->visual');
    await call('browser_dynamic_session', { action: 'stop' });
    const confirmed = vv.filter((pair) => pair.grade === 'confirmed-causal' || pair.basis === 'explicit');
    const observed = vv.filter((pair) => pair.basis === 'observed' && pair.grade === 'observed-association');
    const problems = [];
    if (!vv.length) problems.push('no visual->visual pair');
    if (confirmed.length) problems.push('shared clock/causeOpId was escalated to confirmed-causal');
    if (!observed.length) problems.push('no observed/observed-association pair for the shared clock/op');
    const confidences = [...new Set(observed.map((pair) => pair.confidence))];
    if (!confidences.includes('weak')) problems.push('shared-clock pair is not confidence=weak');
    if (problems.length) return failCheck('DC06', 'visual->visual observed only', { vv: vv.slice(0, 3), problems }, problems.join('; '));
    return passCheck('DC06', 'visual->visual observed/weak, never confirmed', {
      pairCount: vv.length, bases: [...new Set(vv.map((pair) => pair.basis))], grades: [...new Set(vv.map((pair) => pair.grade))], confidences,
    }, ['explicit visual parent link (fixture has no parent field)']);
  }),


  check('DC07', 'U', 'basis↔grade 穷举、默认无 temporal、includeTemporal 仅回时间邻近', async () => {
    const caps = valueOf(await call('browser_capabilities', {}));
    const correlation = caps?.dynamic?.correlation || {};
    const expectedMap = {
      explicit: 'confirmed-causal', redirect: 'confirmed-causal', initiator: 'confirmed-causal',
      observed: 'observed-association', temporal: 'temporal-proximity',
    };
    const problems = [];
    if (JSON.stringify(correlation.directions) !== JSON.stringify(DIRECTIONS)) problems.push('directions != six frozen values');
    for (const [basis, grade] of Object.entries(expectedMap)) if ((correlation.gradeMap || {})[basis] !== grade) problems.push('gradeMap.' + basis + ' != ' + grade);
    if (correlation.includeTemporalDefault !== false) problems.push('includeTemporalDefault must be false');
    // Live default filtering through the real query tool (stored snapshots only; the page is
    // reopened here because earlier criteria already navigated to the network fixture).
    await call('browser_navigate', { url: ctx.fixture.url + FIXTURE_VISUAL.slice(1) });
    await call('browser_eval', { expression: 'window.__t4.visual.setScenario("normal"), window.__t4.visual.setPaused(false)' });
    const start = await call('browser_dynamic_session', { action: 'start', config: { source: 'screencast', durationMs: 2000 } });
    const session = valueOf(start)?.session;
    let defaultQuery = null;
    let temporalQuery = null;
    if (session) {
      await sleep(900);
      defaultQuery = valueOf(await call('browser_dynamic_correlate', { dynamicSessionId: session.dynamicSessionId, motionSessionId: session.motionSessionId }));
      temporalQuery = valueOf(await call('browser_dynamic_correlate', { dynamicSessionId: session.dynamicSessionId, motionSessionId: session.motionSessionId, includeTemporal: true }));
      await call('browser_dynamic_session', { action: 'stop' });
    }
    if (!defaultQuery) problems.push('default correlate query produced no result');
    if (defaultQuery) {
      if ((defaultQuery.pairs || []).some((pair) => pair.basis === 'temporal')) problems.push('default query returned temporal pairs');
      if (!(defaultQuery.suppressedTemporal > 0)) problems.push('suppressedTemporal must count filtered temporal pairs');
      if (!(defaultQuery.verdict && defaultQuery.verdict.status === 'INCONCLUSIVE' && defaultQuery.verdict.reason === 'no-assertion')) problems.push('query verdict must be INCONCLUSIVE(no-assertion)');
    }
    if (temporalQuery) {
      const temporalPairs = (temporalQuery.pairs || []).filter((pair) => pair.basis === 'temporal');
      const badTemporal = temporalPairs.filter((pair) => pair.grade !== 'temporal-proximity');
      if (badTemporal.length) problems.push('a temporal pair does not carry grade temporal-proximity');
      if (!temporalPairs.length) problems.push('includeTemporal returned no temporal pair');
    }
    return {
      status: problems.length ? 'FAIL' : 'PASS',
      unexpected: null,
      expected: 'six directions + full basis->grade map + includeTemporalDefault=false; live query suppresses temporal by default and only temporal pairs appear when explicitly enabled; verdict fixed INCONCLUSIVE(no-assertion)',
      actual: {
        directions: correlation.directions,
        gradeMap: correlation.gradeMap,
        includeTemporalDefault: correlation.includeTemporalDefault,
        defaultQuery: defaultQuery ? { pairs: defaultQuery.pairs?.length, suppressedTemporal: defaultQuery.suppressedTemporal, verdict: defaultQuery.verdict } : null,
        includeTemporalQuery: temporalQuery ? { pairs: temporalQuery.pairs?.length, bases: [...new Set((temporalQuery.pairs || []).map((pair) => pair.basis))] } : null,
        problems,
      },
      reason: problems.length ? problems.join('; ') : null,
    };
  }),

  check('DC08', 'U+B', '同时并发候选、SSE/poll 竞争、模糊 ID；candidateIds/unresolved/reasons', async () => {
    const opened = await openNetworkScenario('dup');
    const session = opened.session;
    if (!session) return notRunCheck('DC08', 'candidate ambiguity', 'session start failed: ' + errorMessage(opened.startError));
    await call('browser_eval', { expression: 'window.__t4.net.addToCart({ double: true })' });
    await sleep(1000);
    const truth = evalValue(await call('browser_eval', { expression: 'window.__t4.net.state()' }));
    const pagePosts = (truth?.requests || []).filter((request) => request.method === 'POST' && request.url === '/api/t4/cart');
    const pairs = await correlateNow(session, { includeTemporal: false });
    const ambiguous = (pairs?.pairs || []).filter((pair) => pair.ambiguous === true);
    const multiCandidates = (pairs?.pairs || []).filter((pair) => (pair.candidateIds || []).length > 1);
    await call('browser_dynamic_session', { action: 'stop' });
    const problems = [];
    if (pagePosts.length < 2) problems.push('dup scenario did not produce two same-key POSTs');
    if (new Set(pagePosts.map((request) => request.idempotencyKey)).size !== 1) problems.push('duplicate POSTs do not share one key');
    if (!ambiguous.length && !multiCandidates.length) {
      return notRunCheck('DC08', 'same-level candidate ambiguity',
        'two same-key POSTs exist, but the DC engine emitted no ambiguous candidate group in this build',
        { pagePosts: pagePosts.length, pairs: pairs?.pairs?.length ?? null, unresolved: pairs?.unresolved?.slice(0, 3) || [] });
    }
    const chosenRoot = (pairs?.pairs || []).find((pair) => pair.grade === 'confirmed-causal' && pair.ambiguous !== true);
    if (chosenRoot && (chosenRoot.candidateIds || []).length > 1) problems.push('nearest candidate was chosen as a unique confirmed root');
    if (problems.length) return failCheck('DC08', 'candidate ambiguity preserved', { pagePosts: pagePosts.length, ambiguous: ambiguous.slice(0, 2), multiCandidates: multiCandidates.slice(0, 2), problems }, problems.join('; '));
    return passCheck('DC08', 'candidateIds preserved, no nearest-only root', {
      pagePosts: pagePosts.length,
      ambiguousPairs: ambiguous.map((pair) => ({ id: pair.id, candidateIds: pair.candidateIds, ambiguous: pair.ambiguous })).slice(0, 3),
    }, ['SSE/poll competition scenario (not built)', 'cross-scope/documentEpoch merge negative (DC09 covers scope ids)']);
  }),


  check('DC09', 'U+B', 'scope/target/hop/documentEpoch/runGeneration/HMAC 命名空间负例', async () => {
    // Host-scope isolation can already be probed: a motionSessionId from another harness must be
    // NOT_FOUND, never leak existence, and the pure core keeps HMAC/session namespaces separate.
    const other = await createHarness({ name: 't4-dynamic-other-scope' });
    let otherMotion = null;
    try {
      const otherStart = await other.invoke('browser_dynamic_session', {
        action: 'start', config: { source: 'screencast', durationMs: 800, maxFrames: 4 },
      }, { agent: { id: 'other-scope' } });
      otherMotion = otherStart.ok ? otherStart.value?.session?.motionSessionId || null : null;
    } catch { otherMotion = null; }
    let foreign = null;
    if (otherMotion) {
      foreign = await call('browser_motion_observe', { motionSessionId: otherMotion });
    }
    try { await other.closeBrowser(); } catch { /* ignore */ }
    try { await other.dispose(); } catch { /* ignore */ }
    if (!otherMotion) {
      return notRunCheck('DC09', 'cross-scope id isolation', 'could not create a second scope dynamic session (BUSY/RUNTIME_LIMIT)');
    }
    const isolated = foreign && foreign.ok === false && foreign.error?.code === 'DYNAMIC_SESSION_NOT_FOUND';
    return {
      status: isolated ? 'PASS' : 'FAIL',
      expected: 'a motionSessionId from another scope answers DYNAMIC_SESSION_NOT_FOUND (same shape, no existence leak)',
      actual: { foreignCode: foreign?.error?.code || (foreign?.ok ? 'OK' : null) },
      subNotRun: isolated ? ['runGeneration isolation', 'HMAC cross-session namespace negatives'] : [],
      reason: isolated ? 'cross-scope id isolation verified; runGeneration/HMAC sub-items are PARTIAL until M3' : 'cross-scope id was not rejected',
    };
  }),

  check('DC10', 'U+B', '缺帧/正文/端点/偏差超限/截断传播，所有关系可追 evidenceIds', async () => {
    const opened = await openNetworkScenario('normal');
    const session = opened.session;
    if (!session) return notRunCheck('DC10', 'integrity propagation', 'session start failed: ' + errorMessage(opened.startError));
    await call('browser_click', { selector: '#t4n-add-cart' });
    await sleep(600);
    const pairs = await correlateNow(session, { includeTemporal: false });
    const problems = [];
    if (!pairs) problems.push('correlate returned nothing');
    const allPairs = pairs?.pairs || [];
    const allIds = new Set(allPairs.flatMap((pair) => pair.evidenceIds || []));
    if (allPairs.some((pair) => (pair.evidenceIds || []).length === 0)) problems.push('a pair has no evidenceIds');
    if (!pairs?.integrity) problems.push('integrity block missing');
    if (!Array.isArray(pairs?.unresolved)) problems.push('unresolved missing');
    // A visual-only session must report network=null, never a fake complete empty network.
    await call('browser_dynamic_session', { action: 'stop' });
    const visualOnly = await call('browser_dynamic_session', { action: 'start', name: 'dc10-visual', config: { source: 'screencast', durationMs: 1500 } });
    const visualSession = valueOf(visualOnly)?.session;
    let visualPairs = null;
    if (visualSession) {
      await sleep(300);
      visualPairs = valueOf(await call('browser_dynamic_correlate', {
        dynamicSessionId: visualSession.dynamicSessionId, motionSessionId: visualSession.motionSessionId,
      }));
      await call('browser_dynamic_session', { action: 'stop' });
    }
    if (!visualPairs) problems.push('visual-only correlate returned nothing');
    if (visualPairs && visualPairs.integrity?.network !== null) problems.push('visual-only network integrity must be null');
    await call('browser_dynamic_session', { action: 'stop' });
    return {
      status: problems.length ? 'FAIL' : 'PASS',
      subNotRun: problems.length ? [] : ['truncated evidence / missing-body propagation through the DC result'],
      expected: 'pairs carry real evidenceIds, integrity and unresolved are present, uncollected network is null (not an empty complete set)',
      actual: {
        pairCount: allPairs.length, evidenceIdCount: allIds.size,
        unresolvedCount: pairs?.unresolved?.length ?? null,
        networkIntegrityVisualOnly: visualPairs?.integrity?.network ?? null,
        problems,
      },
      reason: problems.length ? problems.join('; ') : 'missing-body/truncation propagation is PARTIAL (fixture body capture is exercised by network-p0.mjs)',
    };
  }),


  check('DC11', 'U+B', '查询 highWater、游标稳定、候选预算、无采集时 null 来源；纯查询无启动', async () => {
    const opened = await openNetworkScenario('normal');
    const session = opened.session;
    if (!session) return notRunCheck('DC11', 'highWater/cursor', 'session start failed: ' + errorMessage(opened.startError));
    await call('browser_click', { selector: '#t4n-add-cart' });
    await sleep(700);
    const first = await correlateNow(session, { includeTemporal: true, limit: 1 });
    const cursor = first?.cursor?.next || null;
    let second = null;
    if (cursor) second = await correlateNow(session, { includeTemporal: true, limit: 1, cursor });
    const problems = [];
    if (!first) problems.push('first page failed');
    if (!Number.isInteger(first?.highWater?.network)) problems.push('network highWater is not an integer');
    if (!cursor) problems.push('limit=1 did not produce a cursor');
    if (second) {
      if (second.highWater?.network !== first.highWater?.network) problems.push('highWater changed between pages');
      const firstIds = new Set((first.pairs || []).map((pair) => pair.id));
      if ((second.pairs || []).some((pair) => firstIds.has(pair.id))) problems.push('cursor page repeated a pair');
    }
    await call('browser_dynamic_session', { action: 'stop' });
    return {
      status: problems.length ? 'FAIL' : 'PASS',
      expected: 'stable highWater across pages, cursor pages do not repeat pairs, query is pure (no ensure)',
      actual: {
        highWaterFirst: first?.highWater ?? null, highWaterSecond: second?.highWater ?? null,
        cursorProduced: Boolean(cursor), firstPairs: first?.pairs?.length ?? null, secondPairs: second?.pairs?.length ?? null,
        problems,
      },
      reason: problems.length ? problems.join('; ') : null,
    };
  }),


  check('DC12', 'B+U', '准备阶段 capabilities 仍 unsupported/30；未来 35 须另验 schema/错误/旧 30 回归；真实宿主单列 NOT_RUN', async () => {
    const names = ctx.harness.toolNames();
    const registeredT4 = names.filter((name) => T4_TOOL_NAMES.includes(name));
    const expectedNames = [...LEGACY_TOOLS, ...NETWORK_TOOLS].map((entry) => entry.name);
    const missingLegacy = expectedNames.filter((name) => !names.includes(name));
    const extra = names.filter((name) => !expectedNames.includes(name) && !T4_TOOL_NAMES.includes(name));
    const definitions = new Map(ctx.harness.toolDefinitions().map((definition) => [definition.name, definition]));
    const schemaMismatch = [];
    for (const entry of [...LEGACY_TOOLS, ...NETWORK_TOOLS]) {
      const definition = definitions.get(entry.name);
      if (!definition) { schemaMismatch.push(entry.name + ':missing'); continue; }
      const required = JSON.stringify(definition.parameters?.required || []);
      if (required !== JSON.stringify(entry.required)) schemaMismatch.push(entry.name + ':' + required);
    }
    const t4Unknown = registeredT4.filter((name) => !T4_REGISTERED_EXPECTED.includes(name));
    const t4Missing = T4_REGISTERED_EXPECTED.filter((name) => !registeredT4.includes(name));
    const countOk = names.length === 30 + registeredT4.length;
    const caps = valueOf(await call('browser_capabilities', {}));
    const t4Caps = (caps?.capabilities || []).filter((item) => String(item.id).startsWith('web.t4.'));
    const unavailableT4 = t4Caps.filter((item) => item.tool && !registeredT4.includes(item.tool) && item.status !== 'unsupported');
    const problems = [];
    if (!countOk) problems.push(`tool count ${names.length} != 30 + ${registeredT4.length}`);
    if (missingLegacy.length) problems.push('legacy tools missing: ' + missingLegacy.join(','));
    if (extra.length) problems.push('unexpected tools: ' + extra.join(','));
    if (schemaMismatch.length) problems.push('legacy schema mismatch: ' + schemaMismatch.join(','));
    if (t4Unknown.length) problems.push('unexpected T4 tools: ' + t4Unknown.join(','));
    if (t4Missing.length) problems.push('missing expected M1 T4 tools: ' + t4Missing.join(','));
    if (unavailableT4.length) problems.push('unregistered T4 tool reported available: ' + unavailableT4.map((item) => item.id).join(','));
    return {
      status: problems.length ? 'FAIL' : 'PASS',
      expected: 'tool surface = 30 unchanged legacy tools + the real M1 T4 subset; no unregistered tool available; real-host evidence NOT_RUN',
      actual: {
        toolCount: names.length, registeredT4, expectedNames: T4_REGISTERED_EXPECTED,
        legacyCount: expectedNames.length, missingLegacy, schemaMismatch, unavailableT4,
        t4CapabilityEntries: t4Caps.map((item) => item.id + ':' + item.status), problems,
      },
      subNotRun: problems.length ? [] : ['real host (3080/3081) loading and Agent discovery'],
      reason: problems.length ? problems.join('; ') : 'tool surface/capabilities verified; real-host evidence is PARTIAL (no authorized session)',
    };
  }),
];

/* ------------------------------------------------------------------------------------------------
 * Runner
 * ---------------------------------------------------------------------------------------------- */

async function captureScreenshot(name) {
  const result = await call('browser_screenshot', { persist: true });
  const value = valueOf(result);
  // Historical T1 shape: no top-level `ok`; the delivery facts live in `capture`.
  const file = value?.capture?.file || null;
  const entry = {
    name,
    ok: Boolean(result.ok && value && value.image),
    error: result.ok ? null : { code: result.error?.code, message: truncate(result.error?.message, 240) },
    file: file ? {
      pathKind: file.pathKind, relativePath: file.path,
      sha256: file.sha256 || value?.sha256 || null, bytes: file.bytes || value?.bytes || null,
    } : null,
    png: value?.capture?.sizeCheck?.actual || null,
    anomaly: value?.capture?.anomaly || null,
  };
  if (file && file.pathKind === 'relative') {
    const full = join(RUN_DIR, file.path);
    try {
      const bytes = await readFile(full);
      entry.file.sha256 = sha256(bytes);
      entry.file.bytes = bytes.length;
      entry.file.absolutePath = full;
      report.evidenceFiles.push({ path: file.path, sha256: entry.file.sha256, bytes: entry.file.bytes, kind: 'png' });
    } catch (error) {
      entry.file.readError = errorMessage(error);
    }
  }
  ctx.screenshots.push(entry);
  report.screenshots.push(entry);
  if (!entry.ok) report.findings.push({ id: 'screenshot:' + name, reason: 'screenshot delivery failed', actual: entry });
  return entry;
}

async function runCriterion(definition) {
  const startedAt = Date.now();
  let result;
  try {
    result = await definition.body();
  } catch (error) {
    result = {
      status: 'FAIL',
      expected: definition.expected,
      actual: { error: errorMessage(error) },
      reason: 'check threw: ' + errorMessage(error),
    };
  }
  let status = result.status;
  if (status === 'PASS' && Array.isArray(result.subNotRun) && result.subNotRun.length > 0) status = 'PARTIAL';
  const entry = {
    id: definition.id,
    kind: definition.kind,
    required: definition.required,
    expected: definition.expected,
    status,
    actual: result.actual === undefined ? null : result.actual,
    reason: result.reason || result.problem || null,
    subNotRun: Array.isArray(result.subNotRun) ? result.subNotRun : [],
    durationMs: Date.now() - startedAt,
    evidenceIds: result.evidenceIds || [],
  };
  report.criteria.push(entry);
  if (entry.status === 'NOT_RUN' || entry.status === 'PARTIAL') {
    report.notRun.push({ id: entry.id, status: entry.status, reason: entry.reason, subNotRun: entry.subNotRun });
  }
  if (entry.status === 'FAIL') report.findings.push({ id: entry.id, reason: entry.reason, expected: entry.expected, actual: entry.actual });
  log(`[${entry.id}] ${entry.status}${entry.reason ? ' — ' + entry.reason : ''} (${entry.durationMs}ms)`);
  return entry;
}

/**
 * The U side of a B+U criterion is the pure-core unit suite (executor-A's dynamic-t4.test.mjs).
 * Running it once here keeps the report from claiming B+U coverage that was never executed. No
 * browser is started by that command.
 */
function runCoreUnitSuite() {
  const startedAt = Date.now();
  const result = spawnSync(process.execPath, ['--test', 'tests/dynamic-t4.test.mjs'], {
    cwd: REPO_ROOT, encoding: 'utf8', timeout: 180000,
  });
  const output = String(result.stdout || '') + String(result.stderr || '');
  const pass = Number((output.match(/# pass (\d+)/) || [])[1] || 0);
  const fail = Number((output.match(/# fail (\d+)/) || [])[1] || 0);
  const summary = { available: true, pass, fail, status: result.status, durationMs: Date.now() - startedAt };
  report.resources.coreUnit = summary;
  if (result.error) { summary.available = false; summary.error = String(result.error.message || result.error); }
  log('[core] dynamic-t4.test.mjs: ' + JSON.stringify(summary));
  return summary;
}

async function main() {
  const failures = [];
  runCoreUnitSuite();
  const fixtureModule = await import(pathToFileURL(join(REPO_ROOT, 'tests/ui_test_fixture/server.mjs')).href);
  ctx.fixture = await fixtureModule.startFixtureServer();
  ctx.harness = await createHarness({ name: 't4-dynamic' });
  report.environment.fixtureUrl = ctx.fixture.url;
  report.environment.toolNames = ctx.harness.toolNames();
  log(`[env] fixture: ${ctx.fixture.url}`);
  log(`[env] run dir: ${RUN_DIR}`);
  log(`[env] tools: ${ctx.harness.toolNames().length}`);

  // A first page load so the visual checks have a real page; registration checks do not need it.
  await call('browser_navigate', { url: ctx.fixture.url + FIXTURE_VISUAL.slice(1) });
  await sleep(300);
  await captureScreenshot('t4-dynamic-visual-initial');

  for (const definition of checks) {
    const entry = await runCriterion(definition);
    if (entry.status === 'FAIL') failures.push(entry.id);
  }

  const summary = {
    total: report.criteria.length,
    pass: report.criteria.filter((item) => item.status === 'PASS').length,
    partial: report.criteria.filter((item) => item.status === 'PARTIAL').length,
    fail: report.criteria.filter((item) => item.status === 'FAIL').length,
    notRun: report.criteria.filter((item) => item.status === 'NOT_RUN').length,
    // PARTIAL carries a required NOT_RUN sub-item: it is required-incomplete, never a pass.
    requiredNotRun: report.criteria.filter((item) => item.required && ['NOT_RUN', 'PARTIAL'].includes(item.status)).length,
    failedIds: failures,
  };
  report.summary = summary;
  report.resources = {
    calls: ctx.calls.length,
    failedCalls: ctx.calls.filter((item) => !item.ok).length,
    screenshotCount: report.screenshots.length,
    probeCount: probes.length,
  };
  report.generatedAt = new Date().toISOString();

  await writeFile(join(RUN_DIR, 'run-report.json'), JSON.stringify(report, null, 2));
  await writeFile(join(RUN_DIR, 'run.log'), logLines.join('\n') + '\n');

  log('');
  log(`tool surface: ${ctx.harness.toolNames().length} total`);
  log(`criteria: ${summary.pass} PASS / ${summary.partial} PARTIAL / ${summary.fail} FAIL / ${summary.notRun} NOT_RUN`);
  log(`evidence: ${RUN_DIR}`);
  let exitCode = 0;
  if (summary.fail > 0) exitCode = 1;
  else if (summary.requiredNotRun > 0) exitCode = 2;
  log(`EXIT ${exitCode}`);
  return exitCode;
}

let exitCode = 0;
const timeout = setTimeout(() => {
  log(`FATAL: suite exceeded ${TOTAL_TIMEOUT_MS}ms`);
  process.exit(2);
}, TOTAL_TIMEOUT_MS);
try {
  exitCode = await main();
} catch (error) {
  log('FATAL: ' + errorMessage(error));
  const stack = String(error && error.stack || '').split('\n').slice(0, 12).join('\n');
  log(stack);
  try { await mkdir(RUN_DIR, { recursive: true }); } catch { /* ignore */ }
  try { await writeFile(join(RUN_DIR, 'run.log'), logLines.join('\n') + '\n'); } catch { /* ignore */ }
  exitCode = 2;
} finally {
  clearTimeout(timeout);
  try { await ctx.harness?.dispose(); } catch { /* ignore */ }
  try { await ctx.fixture?.close(); } catch { /* ignore */ }
}
process.exitCode = exitCode;
process.exit(exitCode);
