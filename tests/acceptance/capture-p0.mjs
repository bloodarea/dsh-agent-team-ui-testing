#!/usr/bin/env node
/**
 * P0 capture acceptance suite (docs/capture-p0.md; C1–C13).
 *
 * Drives the *real* plugin (index.js) through the fake-Cordis harness in this directory, with the
 * plugin's own headless Chromium and the repository loopback fixture. Every assertion is a PNG
 * pixel truth (decoded independently through capture-p0.js) or a filesystem fact — never "the tool
 * said it worked" and never eyeballing.
 *
 * Run: node tests/acceptance/capture-p0.mjs
 * Exit: 0 = every required check passed, 1 = a check failed, 2 = the environment is unusable.
 *
 * Evidence: tests/acceptance/runs/capture-p0-<ISO>-<pid>/{report.json,run.log,*.png}
 *
 * Isolation:
 *  - The run creates its own capture output root (`mkdtemp`) and sets DSH_UI_TESTING_CAPTURE_DIR
 *    *before* importing harness.mjs, so nothing is written into the repository and the harness does
 *    not install a second root (`captureTempRoot()` must be undefined here).
 *  - Each harness gets its own page target; cleanup closes every browser, waits for this process's
 *    Chromium children to exit and removes the temporary profiles and the capture root.
 *  - The suite is repeatable: two consecutive runs must both exit 0 (C12).
 */
import { createHash } from 'node:crypto';
import { existsSync, statSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(HERE, '..', '..');
const DEFAULT_CHROME = '/opt/google/chrome/chrome';
const TOTAL_TIMEOUT_MS = Number(process.env.DSH_CAPTURE_P0_TIMEOUT_MS) > 0
  ? Number(process.env.DSH_CAPTURE_P0_TIMEOUT_MS)
  : 240000;
const FIXTURE_PAGE = '/capture-p0.html';
const BLANK_PAGE = '/blank.html';

const STARTED_AT = new Date();
const STAMP = STARTED_AT.toISOString().replace(/[:.]/g, '-');
const EVIDENCE_DIR = join(HERE, 'runs', `capture-p0-${STAMP}-${process.pid}`);

const logLines = [];
function log(line) {
  logLines.push(line);
  console.log(line);
}

/* ------------------------------------------------------------------------------------------------
 * Report plumbing
 * ---------------------------------------------------------------------------------------------- */

function jsonSafe(value, depth = 0) {
  if (value === undefined) return null;
  if (value === null || typeof value !== 'object') {
    if (typeof value === 'number' && !Number.isFinite(value)) return `[number ${String(value)}]`;
    if (typeof value === 'string' && value.length > 4000) return value.slice(0, 4000) + `…[${value.length} chars]`;
    return value;
  }
  if (depth > 6) return '[depth-limit]';
  if (Buffer.isBuffer(value)) return `[Buffer ${value.length} bytes]`;
  if (Array.isArray(value)) return value.slice(0, 60).map((item) => jsonSafe(item, depth + 1));
  const out = {};
  for (const [key, child] of Object.entries(value)) out[key] = jsonSafe(child, depth + 1);
  return out;
}

const report = {
  schemaVersion: 1,
  suite: 'capture-p0',
  generatedAt: STARTED_AT.toISOString(),
  command: 'node tests/acceptance/capture-p0.mjs',
  environment: {},
  probes: [],
  findings: [],
  observations: {},
};

let currentProbe = null;

function beginProbe(id, title, expected) {
  currentProbe = { id, title, expected, status: 'running', startedAt: Date.now(), checks: [], findings: [] };
  report.probes.push(currentProbe);
  log(`\n== ${id} — ${title}`);
}

function check(label, pass, actual, expected, { advisory = false } = {}) {
  const entry = { label, expected: jsonSafe(expected), actual: jsonSafe(actual), pass: Boolean(pass), advisory };
  currentProbe.checks.push(entry);
  const tag = entry.pass ? 'PASS' : (advisory ? 'WARN' : 'FAIL');
  log(`  [${tag}] ${label}`);
  if (!entry.pass) log(`         actual: ${JSON.stringify(entry.actual).slice(0, 700)}`);
  return entry;
}

function finding(id, severity, summary) {
  const entry = { id, severity, summary };
  report.findings.push(entry);
  if (currentProbe) currentProbe.findings.push(entry);
  log(`  [FINDING ${id}/${severity}] ${summary}`);
}

async function runProbe(id, title, expected, fn) {
  beginProbe(id, title, expected);
  try {
    await fn();
    const required = currentProbe.checks.filter((item) => !item.advisory);
    const failed = required.filter((item) => !item.pass);
    currentProbe.status = failed.length ? 'fail' : 'pass';
    currentProbe.actual = failed.length
      ? `${failed.length}/${required.length} 项必需检查失败：${failed.map((item) => item.label).join('；')}`
      : `${required.length}/${required.length} 项必需检查通过`;
  } catch (error) {
    currentProbe.status = 'fail';
    currentProbe.actual = `probe 抛出异常：${error && error.message ? error.message : String(error)}`;
    currentProbe.error = jsonSafe({ name: error?.name, message: String(error?.message || error), stack: String(error?.stack || '').split('\n').slice(0, 8) });
    log(`  [FAIL] probe threw: ${currentProbe.actual}`);
  } finally {
    currentProbe.durationMs = Date.now() - currentProbe.startedAt;
  }
}

/* ------------------------------------------------------------------------------------------------
 * Assertion helpers
 * ---------------------------------------------------------------------------------------------- */

const sha256 = (buffer) => createHash('sha256').update(buffer).digest('hex');
const sleep = (ms) => new Promise((resolve) => { setTimeout(resolve, ms); });

function errorInfo(result) {
  return result && result.threw
    ? {
      name: result.error?.name,
      code: result.error?.code,
      category: result.error?.category,
      retryable: result.error?.retryable,
      message: String(result.error?.message || ''),
      details: result.error?.details,
    }
    : { threw: false, value: result?.value };
}

function hasErrorCode(result, code) {
  return result?.threw === true && result.error?.code === code;
}

async function waitForEval(harness, expression, predicate, { timeoutMs = 8000, label = expression } = {}) {
  const startedAt = Date.now();
  let last;
  while (Date.now() - startedAt < timeoutMs) {
    const result = await harness.invoke('browser_eval', { expression });
    last = result?.value?.value;
    if (predicate(last)) return last;
    await sleep(50);
  }
  throw new Error(`timed out waiting for ${label} (last=${JSON.stringify(jsonSafe(last))})`);
}

function pixelAt(decoded, x, y) {
  const { channels, width, data } = decoded;
  const base = (y * width + x) * channels;
  if (channels === 4) return { r: data[base], g: data[base + 1], b: data[base + 2], a: data[base + 3] };
  if (channels === 3) return { r: data[base], g: data[base + 1], b: data[base + 2], a: 255 };
  if (channels === 2) return { r: data[base], g: data[base], b: data[base], a: data[base + 1] };
  return { r: data[base], g: data[base], b: data[base], a: 255 };
}

/** Every pixel equals `expected` (channels compared per color model). */
function everyPixelIs(decoded, expected) {
  for (let y = 0; y < decoded.height; y += 1) {
    for (let x = 0; x < decoded.width; x += 1) {
      const pixel = pixelAt(decoded, x, y);
      if (pixel.r !== expected.r || pixel.g !== expected.g || pixel.b !== expected.b) {
        return { ok: false, at: { x, y }, pixel };
      }
      if (expected.a !== undefined && decoded.channels >= 2 && pixel.a !== expected.a) {
        return { ok: false, at: { x, y }, pixel };
      }
    }
  }
  return { ok: true };
}

/**
 * Stripe statistics for a hard black/white 1-CSS-px stripe pattern: how many pixels are exactly
 * black / exactly white / anything else (anti-aliasing or resampling would create "other"), plus
 * the number of colour transitions along each row (re-rastering doubles them at scale 2).
 */
function stripeStats(decoded) {
  let black = 0;
  let white = 0;
  let other = 0;
  const transitionsPerRow = [];
  const runLengths = [];
  for (let y = 0; y < decoded.height; y += 1) {
    let transitions = 0;
    let previous = null;
    let run = 0;
    for (let x = 0; x < decoded.width; x += 1) {
      const pixel = pixelAt(decoded, x, y);
      const isBlack = pixel.r === 0 && pixel.g === 0 && pixel.b === 0;
      const isWhite = pixel.r === 255 && pixel.g === 255 && pixel.b === 255;
      if (isBlack) black += 1;
      else if (isWhite) white += 1;
      else other += 1;
      const tone = isBlack ? 'k' : isWhite ? 'w' : 'o';
      if (previous !== null && tone !== previous) {
        transitions += 1;
        runLengths.push(run);
        run = 0;
      }
      run += 1;
      previous = tone;
    }
    runLengths.push(run);
    transitionsPerRow.push(transitions);
  }
  const total = black + white + other;
  const sortedRuns = runLengths.sort((a, b) => a - b);
  const medianRun = sortedRuns[Math.floor(sortedRuns.length / 2)] ?? 0;
  const distinctRuns = [...new Set(sortedRuns)];
  return {
    width: decoded.width,
    height: decoded.height,
    black,
    white,
    other,
    otherRatio: total ? other / total : 1,
    transitionsMedian: transitionsPerRow.sort((a, b) => a - b)[Math.floor(transitionsPerRow.length / 2)] ?? 0,
    medianRun,
    distinctRuns: distinctRuns.slice(0, 8),
  };
}

async function listFilesRecursive(dir) {
  const out = [];
  let entries;
  try { entries = await readdir(dir, { withFileTypes: true }); } catch { return out; }
  for (const entry of entries) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...await listFilesRecursive(full));
    else out.push(full);
  }
  return out.sort();
}

function relativeFiles(root, files) {
  return files.map((file) => (file.startsWith(root) ? file.slice(root.length).replace(/^[/\\]/, '') : file));
}

/* ------------------------------------------------------------------------------------------------
 * Main
 * ---------------------------------------------------------------------------------------------- */

const state = {
  harnesses: [],
  fixture: undefined,
  captureRoot: undefined,
  profilesBefore: [],
  cleanupResult: undefined,
  finished: false,
};

async function main() {
  await mkdir(EVIDENCE_DIR, { recursive: true });

  // ---- environment ---------------------------------------------------------------------------
  const chromeBin = process.env.DSH_UI_TESTING_CHROME || DEFAULT_CHROME;
  if (!existsSync(chromeBin)) {
    log(`[env] FATAL: Chromium 不存在：${chromeBin}（可用 DSH_UI_TESTING_CHROME 覆盖）`);
    report.environment.error = 'chromium-unavailable';
    await writeReport(2);
    return 2;
  }

  // The run owns its capture root: set it BEFORE importing harness.mjs so the harness keeps it.
  state.captureRoot = await mkdtemp(join(tmpdir(), 'dsh-ui-testing-capture-p0-'));
  process.env.DSH_UI_TESTING_CAPTURE_DIR = state.captureRoot;

  const harnessModule = await import(pathToFileURL(join(HERE, 'harness.mjs')).href);
  const {
    createHarness, scanPluginChromeProcesses, isProcessAlive, snapshotProfileDirs, captureTempRoot,
    createFakeSessionsService, createFakeWorkspaceRegistry,
  } = harnessModule;
  const { startFixtureServer } = await import(pathToFileURL(join(REPO_ROOT, 'tests/ui_test_fixture/server.mjs')).href);
  const { decodePng, expectedPixelSize, inspectPng } = await import(pathToFileURL(join(REPO_ROOT, 'capture-p0.js')).href);

  state.profilesBefore = await snapshotProfileDirs();
  state.repoOutputBefore = existsSync(join(REPO_ROOT, 'output'));
  state.fixture = await startFixtureServer();
  const pageUrl = new URL(FIXTURE_PAGE, state.fixture.url).href;
  const blankUrl = new URL(BLANK_PAGE, state.fixture.url).href;

  report.environment = {
    suite: 'capture-p0',
    node: process.version,
    platform: `${process.platform}/${process.arch}`,
    repoRoot: REPO_ROOT,
    chromeBin,
    captureRoot: state.captureRoot,
    captureRootIsAbsolute: state.captureRoot.startsWith('/'),
    harnessCaptureRoot: captureTempRoot() ?? null,
    fixtureUrl: state.fixture.url,
    pageUrl,
    blankUrl,
    timeoutMs: TOTAL_TIMEOUT_MS,
    evidenceDir: EVIDENCE_DIR,
    compareScope: 'downscaled/reencoded 只依据附件 ref 暴露的元数据（width/height/mediaType/bytes/sha256）；缺失字段不推断为“内容相同”。',
    repoOutputBefore: state.repoOutputBefore,
  };
  log(`[env] chrome=${chromeBin}`);
  log(`[env] fixture=${state.fixture.url}`);
  log(`[env] captureRoot=${state.captureRoot} harnessCaptureRoot=${report.environment.harnessCaptureRoot}`);

  const harness = await createHarness({ name: 'capture-p0' });
  state.harnesses.push(harness);

  const openPage = async (url, title) => {
    const nav = await harness.invoke('browser_navigate', { url });
    if (!nav.ok) throw new Error('navigate failed: ' + JSON.stringify(errorInfo(nav)));
    await waitForEval(harness, 'document.readyState', (value) => value === 'complete', { label: 'readyState complete' });
    if (title) await waitForEval(harness, 'document.title', (value) => value === title, { label: `title ${title}` });
  };

  const capture = async (args, label) => {
    const startedAt = Date.now();
    const result = await harness.invoke('browser_screenshot', args);
    const value = result.value || {};
    if (result.ok && value.image) {
      const bytes = Buffer.from(String(value.image), 'base64');
      if (label) await writeFile(join(EVIDENCE_DIR, label), bytes);
      return { result, value, bytes, durationMs: Date.now() - startedAt };
    }
    return { result, value, bytes: Buffer.alloc(0), durationMs: Date.now() - startedAt };
  };

  await openPage(pageUrl, 'P0 Capture Fixture');

  // ---- C1: default capture -------------------------------------------------------------------
  await runProbe('C1-default-capture', '默认截图：尺寸/结构/映射/落盘/权限', '默认 1280x800，inspectPng+CRC ok，sizeCheck.ok，file 相对路径且 sha256 三方一致、权限 0600', async () => {
    const { result, value, bytes } = await capture({}, 'c1-default.png');
    const cap = value.capture || {};
    check('C1 截图成功且交付 base64', result.ok === true && typeof value.image === 'string' && value.image.length > 0, errorInfo(result));
    check('C1 返回 viewport = 1280x800', JSON.stringify(value.viewport) === JSON.stringify({ width: 1280, height: 800 }), value.viewport);
    check('C1 PNG 尺寸 1280x800', cap.png?.width === 1280 && cap.png?.height === 800, cap.png);
    const inspected = inspectPng(bytes, { checkCrc: true });
    check('C1 独立 inspectPng(bytes) 结构/CRC ok', inspected.ok === true && inspected.width === 1280 && inspected.height === 800, inspected);
    check('C1 capture.png.crc = ok 且 chunks ≥ 3', cap.png?.crc === 'ok' && cap.png?.chunks >= 3, { crc: cap.png?.crc, chunks: cap.png?.chunks });
    check('C1 capture.request.scale = 1 且 coordinateSpace = document-css-px', cap.request?.scale === 1 && cap.request?.coordinateSpace === 'document-css-px', cap.request);
    check('C1 mapping.coordinateSpace = document-css-px 且纯 JSON', cap.mapping?.coordinateSpace === 'document-css-px' && JSON.stringify(JSON.parse(JSON.stringify(cap.mapping))) === JSON.stringify(cap.mapping), cap.mapping);
    check('C1 sizeCheck.ok = true 且 upscaled = false', cap.sizeCheck?.ok === true && cap.sizeCheck?.upscaled === false, cap.sizeCheck);
    const expected = expectedPixelSize({ width: 1280, height: 800, scale: 1, deviceScaleFactor: 1 });
    check('C1 expected 与 PNG 一致（round(css×scale×dsf)）', cap.expected?.width === expected.width && cap.expected?.height === expected.height && cap.expected?.pixelsPerCssPixel === 1, { expected: cap.expected, computed: expected });

    const file = cap.file || {};
    check('C1 file.path 是相对路径且以 .png 结尾', typeof file.path === 'string' && file.path.endsWith('.png') && !file.path.startsWith('/'), file);
    const diskPath = file.path ? join(state.captureRoot, file.path) : '';
    const diskExists = Boolean(file.path) && existsSync(diskPath);
    const diskBytes = diskExists ? await readFile(diskPath) : Buffer.alloc(0);
    const base64Sha = sha256(bytes);
    check('C1 file.sha256 === sha256(返回 base64) === sha256(磁盘文件)', diskExists && file.sha256 === base64Sha && sha256(diskBytes) === base64Sha && value.sha256 === base64Sha,
      { file: file.sha256, base64: base64Sha, disk: diskExists ? sha256(diskBytes) : null });
    check('C1 磁盘文件与返回字节完全一致（同一份字节，无二次编码）', diskExists && Buffer.compare(diskBytes, bytes) === 0, { diskBytes: diskBytes.length, base64Bytes: bytes.length });
    check('C1 文件权限 0600', diskExists && (statSync(diskPath).mode & 0o777) === 0o600, diskExists ? (statSync(diskPath).mode & 0o777).toString(8) : null);
    check('C1 file.bytes/width/height/mode/noClobber 一致', file.bytes === bytes.length && file.width === 1280 && file.height === 800 && file.mode === '0600' && file.noClobber === true, file);
    check('C1 env 根 -> persistence=persistent / pathKind=relative / root=env / ephemeral=false',
      file.persistence === 'persistent' && file.pathKind === 'relative' && file.root === 'env' && file.ephemeral === false, file);
    check('C1 request.persist=false（默认不主动要求留存，env 使其持久）', cap.request?.persist === false, cap.request);

    const env = cap.environment || {};
    const sourceOk = env.headless === true
      ? env.headlessSource === 'product' || env.headlessSource === 'userAgent'
      : env.headless === false
        ? env.headlessSource === 'product' || env.headlessSource === 'userAgent'
        : env.headless === null && env.headlessSource === null;
    check('C1 environment：headless 与 headlessSource 一致（枚举 product|userAgent|null）', sourceOk, { headless: env.headless, headlessSource: env.headlessSource });
    check('C1 environment：pageDevicePixelRatio 为数值或 null，dsf 来源为 runtime-override', (typeof env.pageDevicePixelRatio === 'number' || env.pageDevicePixelRatio === null) && env.deviceScaleFactor === 1 && env.deviceScaleFactorSource === 'runtime-override', env);
    check('C1 warnings 只含封闭词表', Array.isArray(cap.warnings) && cap.warnings.every((word) => [
      'content_uniform', 'content_transparent', 'model_image_downscaled', 'attachment_reencoded',
      'blank_check_skipped', 'capture_file_unavailable', 'attachment_unavailable', 'capture_beyond_viewport',
    ].includes(word)), cap.warnings);
    check('C1 无附件服务 -> base64-fallback + attachment_unavailable', value.imageDelivery === 'base64-fallback' && value.attachmentId === null && cap.warnings?.includes('attachment_unavailable') && cap.delivery?.image === null, { imageDelivery: value.imageDelivery, warnings: cap.warnings });
  });

  // ---- C2: scale 2 re-rasterisation ----------------------------------------------------------
  await runProbe('C2-scale2-reraster', 'scale=2 重新光栅化（条纹不出现灰阶）', '2560x1600；条纹区域 scale1=120x40、scale2=240x80，纯黑/纯白像素占比 >99%，转变数随 scale 翻倍', async () => {
    const { result, value, bytes } = await capture({ scale: 2 }, 'c2-scale2.png');
    const cap = value.capture || {};
    check('C2 scale2 截图成功', result.ok === true, errorInfo(result));
    check('C2 scale2 PNG 2560x1600', cap.png?.width === 2560 && cap.png?.height === 1600, cap.png);
    check('C2 scale2 sizeCheck.ok', cap.sizeCheck?.ok === true, cap.sizeCheck);
    check('C2 scale2 inspectPng ok', inspectPng(bytes).ok === true, inspectPng(bytes));
    check('C2 scale2 expected = 2560x1600, ppcp = 2', cap.expected?.width === 2560 && cap.expected?.height === 1600 && cap.expected?.pixelsPerCssPixel === 2, cap.expected);
    check('C2 anomaly.checked=true 时 maxDelta 是数字（内容页非纯色）', cap.anomaly?.checked === true && typeof cap.anomaly?.maxDelta === 'number' && cap.anomaly.maxDelta > 0, cap.anomaly);

    const stripesRegion = { x: 20, y: 100, width: 120, height: 40 };
    const one = await capture({ region: stripesRegion, scale: 1 }, 'c2-stripes-scale1.png');
    const two = await capture({ region: stripesRegion, scale: 2 }, 'c2-stripes-scale2.png');
    check('C2 条纹区域 scale1 = 120x40', one.value.capture?.png?.width === 120 && one.value.capture?.png?.height === 40, one.value.capture?.png || errorInfo(one.result));
    check('C2 条纹区域 scale2 = 240x80', two.value.capture?.png?.width === 240 && two.value.capture?.png?.height === 80, two.value.capture?.png || errorInfo(two.result));

    const decodedOne = decodePng(one.bytes);
    const decodedTwo = decodePng(two.bytes);
    check('C2 两区域都可解码（8-bit RGB/RGBA）', decodedOne.ok === true && decodedTwo.ok === true, { one: decodedOne.ok, two: decodedTwo.ok });
    const statsOne = decodedOne.ok ? stripeStats(decodedOne) : null;
    const statsTwo = decodedTwo.ok ? stripeStats(decodedTwo) : null;
    check('C2 scale1 条纹只有纯黑/纯白（灰阶占比 <1%）', statsOne && statsOne.black > 0 && statsOne.white > 0 && statsOne.otherRatio < 0.01, statsOne);
    check('C2 scale2 条纹只有纯黑/纯白（灰阶占比 <1%，证明重新光栅化而非位图放大）', statsTwo && statsTwo.black > 0 && statsTwo.white > 0 && statsTwo.otherRatio < 0.01, statsTwo);
    // Re-rasterisation, not a bitmap upscale: the stripe *runs* widen to `scale` device pixels per
    // CSS pixel while staying pure black/white. A bilinear upscale of a 1px pattern would show grey
    // (otherRatio) and a nearest-neighbour upscale would also widen runs, so the pair of facts
    // (pure colours + run width = scale) is what the evidence claims.
    check('C2 条纹 run 宽度 = scale 个设备像素（1 CSS px 重新光栅化）',
      statsOne?.medianRun === 1 && statsTwo?.medianRun === 2,
      { scale1: { medianRun: statsOne?.medianRun, distinctRuns: statsOne?.distinctRuns }, scale2: { medianRun: statsTwo?.medianRun, distinctRuns: statsTwo?.distinctRuns } });
  });

  // ---- C3: lossless region crop --------------------------------------------------------------
  await runProbe('C3-region-crop', 'region 无损裁剪（无缩放/重采样）', '#cap-red 中心 20x20 全为 255,0,0；#cap-blue 中心 20x20 全为 0,128,255', async () => {
    const red = await capture({ region: { x: 30, y: 30, width: 20, height: 20 } }, 'c3-red-crop.png');
    const blue = await capture({ region: { x: 130, y: 30, width: 20, height: 20 } }, 'c3-blue-crop.png');
    check('C3 红色裁剪 20x20', red.value.capture?.png?.width === 20 && red.value.capture?.png?.height === 20, red.value.capture?.png || errorInfo(red.result));
    check('C3 蓝色裁剪 20x20', blue.value.capture?.png?.width === 20 && blue.value.capture?.png?.height === 20, blue.value.capture?.png || errorInfo(blue.result));
    const decodedRed = decodePng(red.bytes);
    const decodedBlue = decodePng(blue.bytes);
    const redTruth = decodedRed.ok ? everyPixelIs(decodedRed, { r: 255, g: 0, b: 0 }) : { ok: false, decode: decodedRed };
    const blueTruth = decodedBlue.ok ? everyPixelIs(decodedBlue, { r: 0, g: 128, b: 255 }) : { ok: false, decode: decodedBlue };
    check('C3 红色裁剪每个像素都是 255,0,0', redTruth.ok === true, redTruth);
    check('C3 蓝色裁剪每个像素都是 0,128,255', blueTruth.ok === true, blueTruth);
    check('C3 裁剪 mapping 记录文档坐标原点', red.value.capture?.mapping?.originCss?.x === 30 && red.value.capture?.mapping?.originCss?.y === 30, red.value.capture?.mapping);
  });

  // ---- C4: fractional scale ------------------------------------------------------------------
  await runProbe('C4-fractional-scale', '小数 scale 与连续 1–4 范围', '101x50 @1.25 -> 126x63；@1.5 -> 152x75；@1.11 合法且尺寸 = round(101×1.11)×round(50×1.11)', async () => {
    const region = { x: 0, y: 0, width: 101, height: 50 };
    const f125 = await capture({ region, scale: 1.25 }, 'c4-101x50-1.25.png');
    const f15 = await capture({ region, scale: 1.5 }, 'c4-101x50-1.5.png');
    check('C4 101x50 @1.25 = 126x63', f125.value.capture?.png?.width === 126 && f125.value.capture?.png?.height === 63, f125.value.capture?.png || errorInfo(f125.result));
    check('C4 101x50 @1.5 = 152x75', f15.value.capture?.png?.width === 152 && f15.value.capture?.png?.height === 75, f15.value.capture?.png || errorInfo(f15.result));
    check('C4 1.25/1.5 sizeCheck.ok', f125.value.capture?.sizeCheck?.ok === true && f15.value.capture?.sizeCheck?.ok === true, { f125: f125.value.capture?.sizeCheck, f15: f15.value.capture?.sizeCheck });

    const f111 = await capture({ region, scale: 1.11 }, 'c4-101x50-1.11.png');
    const expected111 = expectedPixelSize({ width: 101, height: 50, scale: 1.11, deviceScaleFactor: 1 });
    check('C4 scale=1.11 合法（连续 1–4，不得 INVALID_ARGUMENT）', f111.result.ok === true, errorInfo(f111.result));
    check('C4 scale=1.11 尺寸 = 实现公式 round(101×1.11)×round(50×1.11)', f111.value.capture?.png?.width === expected111.width && f111.value.capture?.png?.height === expected111.height,
      { actual: f111.value.capture?.png, computed: expected111 });
    check('C4 scale=1.11 sizeCheck.ok', f111.value.capture?.sizeCheck?.ok === true, f111.value.capture?.sizeCheck);
  });

  // ---- C5: document coordinates + scroll -----------------------------------------------------
  await runProbe('C5-document-scroll', '文档坐标 + 滚动映射（截图不改变滚动）', 'scrollTo(0,400) 后 region{20,1500,40,40} -> 40x40 全 0,255,0；scroll.y=400；截图前后 scrollY 不变；视口外有 capture_beyond_viewport', async () => {
    await harness.invoke('browser_eval', { expression: 'window.scrollTo(0, 400)' });
    await waitForEval(harness, 'window.scrollY', (value) => value === 400, { label: 'scrollY 400' });
    const before = await harness.invoke('browser_eval', { expression: '({ x: window.scrollX, y: window.scrollY })' });
    const shot = await capture({ region: { x: 20, y: 1500, width: 40, height: 40 } }, 'c5-doc-green.png');
    const after = await harness.invoke('browser_eval', { expression: '({ x: window.scrollX, y: window.scrollY })' });
    const cap = shot.value.capture || {};
    check('C5 截图成功 40x40', shot.result.ok === true && cap.png?.width === 40 && cap.png?.height === 40, cap.png || errorInfo(shot.result));
    const decoded = decodePng(shot.bytes);
    const truth = decoded.ok ? everyPixelIs(decoded, { r: 0, g: 255, b: 0 }) : { ok: false, decode: decoded };
    check('C5 文档坐标裁剪每像素都是 0,255,0', truth.ok === true, truth);
    check('C5 capture.environment.scroll.y = 400', cap.environment?.scroll?.y === 400, cap.environment?.scroll);
    check('C5 截图前后 scrollY 不变', before.value?.value?.y === 400 && after.value?.value?.y === 400, { before: before.value?.value, after: after.value?.value });
    check('C5 视口外 region 的 warnings 含 capture_beyond_viewport', cap.warnings?.includes('capture_beyond_viewport') === true, cap.warnings);
  });

  // ---- C6: live preview not broken by the capture --------------------------------------------
  await runProbe('C6-frame-pipeline', '高 DPI 截图不破坏实时预览帧管线', '截图后页面变化仍出 JPEG 帧（1280x800），host.captured 增长', async () => {
    const metricsBefore = await harness.request({ method: 'GET', path: '/plugins/ui-testing/metrics' });
    const capturedBefore = metricsBefore.json?.host?.captured ?? 0;
    await capture({ scale: 2 }, 'c6-scale2-before-frame.png');
    // A still page emits no screencast frames (event-driven pipeline) and a PNG capture is not a
    // compositor damage event, so drive one real DOM change and require a new frame for it.
    await harness.invoke('browser_eval', { expression: "document.body.style.backgroundColor = document.body.style.backgroundColor === 'rgb(254, 254, 254)' ? '#ffffff' : '#fefefe'" });
    let frame;
    const startedAt = Date.now();
    while (Date.now() - startedAt < 5000) {
      frame = await harness.request({ method: 'GET', path: '/plugins/ui-testing/frame?since=0' });
      const metricsNow = await harness.request({ method: 'GET', path: '/plugins/ui-testing/metrics' });
      if (frame.statusCode === 200 && frame.json && !frame.json.pending && (metricsNow.json?.host?.captured ?? 0) > capturedBefore) break;
      await sleep(100);
    }
    const metricsAfter = await harness.request({ method: 'GET', path: '/plugins/ui-testing/metrics' });
    const capturedAfter = metricsAfter.json?.host?.captured ?? 0;
    check('C6 GET /frame 返回 200', frame?.statusCode === 200, { statusCode: frame?.statusCode, body: frame?.body?.slice(0, 200) });
    const imageBytes = frame?.json?.image ? Buffer.from(String(frame.json.image), 'base64') : Buffer.alloc(0);
    const jpeg = imageBytes.length > 4 && imageBytes[0] === 0xff && imageBytes[1] === 0xd8;
    check('C6 /frame 载荷是 JPEG（image/jpeg 魔数）', jpeg, { bytes: imageBytes.length, magic: imageBytes.subarray(0, 4).toString('hex'), pending: frame?.json?.pending ?? null });
    check('C6 帧尺寸 1280x800（不可解析时退化为 bytes>0）', (frame?.json?.width === 1280 && frame?.json?.height === 800) || imageBytes.length > 0, { width: frame?.json?.width, height: frame?.json?.height, bytes: imageBytes.length });
    check('C6 host.captured 计数增长', capturedAfter > capturedBefore, { before: capturedBefore, after: capturedAfter });
    check('C6 /frame 仍带 state 且 running', frame?.json?.state?.running === true || frame?.json?.pending === true, { state: frame?.json?.state && { running: frame.json.state.running } });
    finding('C6-frame-json', 'info', 'GET /frame 是 JSON 投影（image 为 base64 JPEG），HTTP content-type 为 application/json；本检查以 JPEG 魔数而非响应头证明 image/jpeg 帧。');
  });

  // ---- C7: blank-page detection --------------------------------------------------------------
  await runProbe('C7-blank-detection', '空白识别（只告警不报错）', 'blank.html -> content_uniform + anomaly.uniform=true 且仍交付文件；回到内容页不再告警', async () => {
    await openPage(blankUrl, 'blank');
    const blank = await capture({}, 'c7-blank.png');
    const blankCap = blank.value.capture || {};
    check('C7 空白页截图成功（不抛错）', blank.result.ok === true, errorInfo(blank.result));
    check('C7 warnings 含 content_uniform', blankCap.warnings?.includes('content_uniform') === true, blankCap.warnings);
    check('C7 anomaly.checked=true 且 uniform=true', blankCap.anomaly?.checked === true && blankCap.anomaly?.uniform === true, blankCap.anomaly);
    check('C7 全同色图 anomaly.maxDelta === 0（数字）', typeof blankCap.anomaly?.maxDelta === 'number' && blankCap.anomaly.maxDelta === 0, blankCap.anomaly?.maxDelta);
    check('C7 空白图仍交付图片与文件', typeof blank.value.image === 'string' && blank.value.image.length > 0 && typeof blankCap.file?.path === 'string', { image: Boolean(blank.value.image), file: blankCap.file });

    await openPage(pageUrl, 'P0 Capture Fixture');
    const content = await capture({}, 'c7-content.png');
    check('C7 内容页 warnings 不含 content_uniform', content.value.capture?.warnings?.includes('content_uniform') !== true, content.value.capture?.warnings);
    check('C7 内容页 anomaly.uniform=false', content.value.capture?.anomaly?.uniform === false, content.value.capture?.anomaly);
  });

  // ---- C8: safe writes / no clobber ----------------------------------------------------------
  await runProbe('C8-safe-write', '安全写入与防覆盖', '../escape.png、/tmp/x.png、a\\b.png、x.jpg -> OUTPUT_PATH_INVALID；预置 out -> OUTPUT_EXISTS 且字节不变；子目录创建；默认名唯一', async () => {
    const filesBefore = await listFilesRecursive(state.captureRoot);
    for (const [label, out] of [['../escape.png', '../escape.png'], ['/tmp/x.png', '/tmp/x.png'], ['a\\b.png', 'a\\b.png'], ['x.jpg', 'x.jpg']]) {
      const bad = await harness.invoke('browser_screenshot', { out });
      check(`C8 out=${label} -> OUTPUT_PATH_INVALID`, hasErrorCode(bad, 'OUTPUT_PATH_INVALID') && bad.error?.category === 'input' && bad.error?.retryable === false, errorInfo(bad));
    }
    const filesAfter = await listFilesRecursive(state.captureRoot);
    check('C8 非法 out 不新增任何文件', relativeFiles(state.captureRoot, filesAfter).length === relativeFiles(state.captureRoot, filesBefore).length,
      { before: relativeFiles(state.captureRoot, filesBefore), after: relativeFiles(state.captureRoot, filesAfter) });

    // Pre-place an output file, then ask for the same path: it must never be overwritten.
    const preOut = 'pre/placed.png';
    await mkdir(join(state.captureRoot, 'pre'), { recursive: true });
    const preBytes = Buffer.from('PRE-PLACED-CONTENT-DO-NOT-OVERWRITE');
    await writeFile(join(state.captureRoot, preOut), preBytes);
    const preSha = sha256(preBytes);
    const exists = await harness.invoke('browser_screenshot', { out: preOut });
    check('C8 已存在 out -> OUTPUT_EXISTS', hasErrorCode(exists, 'OUTPUT_EXISTS') && exists.error?.category === 'output' && exists.error?.retryable === false, errorInfo(exists));
    const preAfter = await readFile(join(state.captureRoot, preOut));
    check('C8 OUTPUT_EXISTS 后预置文件 sha256 不变', sha256(preAfter) === preSha, { before: preSha, after: sha256(preAfter) });

    const sub = await harness.invoke('browser_screenshot', { out: 'sub/dir/shot.png' });
    check('C8 out=sub/dir/shot.png 成功且目录被创建', sub.ok === true && sub.value?.capture?.file?.path === 'sub/dir/shot.png' && existsSync(join(state.captureRoot, 'sub/dir')),
      { file: sub.value?.capture?.file, error: errorInfo(sub) });

    const d1 = await harness.invoke('browser_screenshot', {});
    const d2 = await harness.invoke('browser_screenshot', {});
    check('C8 未传 out 的两次调用 file.path 不同（默认唯一命名）', d1.ok && d2.ok && typeof d1.value?.capture?.file?.path === 'string'
      && typeof d2.value?.capture?.file?.path === 'string' && d1.value.capture.file.path !== d2.value.capture.file.path,
    { first: d1.value?.capture?.file?.path, second: d2.value?.capture?.file?.path });
    check('C8 默认名形如 output/capture/<actionId>.png', /^output\/capture\/[0-9a-f-]{36}\.png$/.test(String(d1.value?.capture?.file?.path || '')), d1.value?.capture?.file?.path);
  });

  // ---- C9: argument validation + structured errors ------------------------------------------
  await runProbe('C9-arguments', '参数与结构化错误（无副作用）', 'scale 0/0.05/4.001/5/字符串/NaN、region 宽 0/负/字符串 -> INVALID_ARGUMENT 且不新增文件；超预算 -> CAPTURE_TOO_LARGE；details 无绝对路径', async () => {
    const filesBefore = await listFilesRecursive(state.captureRoot);
    // Legal explicit range is 0.1–4 (docs/viewport-control.md §6.1, Lead freeze 2026-11-01), so the
    // below-minimum probe is 0.05; 0.999 is a LEGAL continuous scale now (asserted by C4's 1.11 case).
    const invalidScales = [[0, '0'], [0.05, '0.05'], [4.001, '4.001'], [5, '5'], ['2', "'2'"], [Number.NaN, 'NaN']];
    for (const [value, label] of invalidScales) {
      const bad = await harness.invoke('browser_screenshot', { scale: value });
      check(`C9 scale=${label} -> INVALID_ARGUMENT`, hasErrorCode(bad, 'INVALID_ARGUMENT') && bad.error?.category === 'input' && bad.error?.retryable === false && typeof bad.error?.message === 'string' && bad.error.message.startsWith('[INVALID_ARGUMENT]'), errorInfo(bad));
    }
    for (const [region, label] of [
      [{ x: 0, y: 0, width: 0, height: 10 }, 'width 0'],
      [{ x: 0, y: 0, width: 10, height: -5 }, 'height 负'],
      [{ x: 0, y: 0, width: '10', height: 10 }, "width 字符串"],
      [{ x: 0, y: 0, width: 10 }, '缺 height'],
      ['not-an-object', 'region 非对象'],
    ]) {
      const bad = await harness.invoke('browser_screenshot', { region });
      check(`C9 region ${label} -> INVALID_ARGUMENT`, hasErrorCode(bad, 'INVALID_ARGUMENT'), errorInfo(bad));
    }
    const filesAfter = await listFilesRecursive(state.captureRoot);
    check('C9 非法参数不新增截图文件', relativeFiles(state.captureRoot, filesAfter).length === relativeFiles(state.captureRoot, filesBefore).length,
      { before: relativeFiles(state.captureRoot, filesBefore).length, after: relativeFiles(state.captureRoot, filesAfter).length });

    const tooBig = await harness.invoke('browser_screenshot', { region: { x: 0, y: 0, width: 4000, height: 4001 }, scale: 1 });
    check('C9 4000x4001 -> CAPTURE_TOO_LARGE（category=resource）', hasErrorCode(tooBig, 'CAPTURE_TOO_LARGE') && tooBig.error?.category === 'resource' && tooBig.error?.retryable === false, errorInfo(tooBig));
    check('C9 CAPTURE_TOO_LARGE details 含 expected/max', tooBig.error?.details?.expected?.pixels === 16004000 && tooBig.error?.details?.max === 16000000,
      { expected: tooBig.error?.details?.expected, max: tooBig.error?.details?.max });

    const errorList = [
      ['OUTPUT_PATH_INVALID', await harness.invoke('browser_screenshot', { out: '../escape.png' })],
      ['CAPTURE_TOO_LARGE', tooBig],
      ['INVALID_ARGUMENT', await harness.invoke('browser_screenshot', { scale: 9 })],
    ];
    for (const [code, result] of errorList) {
      const info = errorInfo(result);
      const serialized = JSON.stringify(result.error?.details || {});
      check(`C9 ${code} details 不含绝对路径（/home/、/tmp/）`, !/\/home\/|\/tmp\/|\/private\/var\//.test(serialized), { details: result.error?.details });
      check(`C9 ${code} 携带 code/category/retryable/message`, info.code === code && typeof info.category === 'string' && typeof info.retryable === 'boolean' && typeof info.message === 'string' && info.message.length > 0, info);
    }
  });

  // ---- C10: original vs delivered image ------------------------------------------------------
  await runProbe('C10-attachment-compare', '原始 vs Agent 接收尺寸（附件对比）', 'webp + 半尺寸附件 -> downscaled/reencoded 警告；delivery.original 等于 PNG；无附件服务 -> base64-fallback', async () => {
    class FakeAttachment {
      constructor(fields) { Object.assign(this, fields); }
    }
    const attached = await createHarness({
      name: 'capture-p0-attachments',
      attachments: {
        async saveImage(input) {
          return new FakeAttachment({
            id: 'capture-p0-image', attachmentId: 'capture-p0-image', mediaType: 'image/webp',
            bytes: 2048, width: 640, height: 400, name: input.name,
          });
        },
      },
    });
    state.harnesses.push(attached);
    try {
      await attached.invoke('browser_navigate', { url: pageUrl });
      await waitForEval(attached, 'document.readyState', (value) => value === 'complete', { label: 'readyState complete' });
      const shot = await attached.invoke('browser_screenshot');
      const cap = shot.value?.capture || {};
      check('C10 附件截图成功', shot.ok === true, errorInfo(shot));
      check('C10 imageDelivery=attachment 且附件已投影', shot.value?.imageDelivery === 'attachment' && shot.value?.attachmentId === 'capture-p0-image', { imageDelivery: shot.value?.imageDelivery, attachmentId: shot.value?.attachmentId });
      check('C10 delivery.original.{width,height} 等于 PNG 尺寸', cap.delivery?.original?.width === cap.png?.width && cap.delivery?.original?.height === cap.png?.height, { original: cap.delivery?.original, png: cap.png });
      check('C10 delivery.downscaled=true 且 warnings 含 model_image_downscaled', cap.delivery?.downscaled === true && cap.warnings?.includes('model_image_downscaled') === true, { delivery: cap.delivery, warnings: cap.warnings });
      check('C10 delivery.reencoded=true 且 warnings 含 attachment_reencoded（mediaType 不同）', cap.delivery?.reencoded === true && cap.warnings?.includes('attachment_reencoded') === true, { delivery: cap.delivery, warnings: cap.warnings });
      check('C10 delivery.image 记录附件元数据（不含本地路径）', cap.delivery?.image?.mediaType === 'image/webp' && cap.delivery?.image?.width === 640 && cap.delivery?.image?.height === 400 && !JSON.stringify(cap.delivery).includes(state.captureRoot), cap.delivery?.image);
      finding('C10-compare-scope', 'info', report.environment.compareScope);
    } finally {
      try { await attached.closeBrowser(); } catch { /* ignore */ }
      try { await attached.dispose(); } catch { /* ignore */ }
    }

    const plain = await harness.invoke('browser_screenshot', {});
    check('C10 无附件服务 -> base64-fallback、delivery.image=null、attachment_unavailable', plain.value?.imageDelivery === 'base64-fallback'
      && plain.value?.capture?.delivery?.image === null && plain.value?.capture?.warnings?.includes('attachment_unavailable') === true,
    { imageDelivery: plain.value?.imageDelivery, delivery: plain.value?.capture?.delivery, warnings: plain.value?.capture?.warnings });
  });

  // ---- C11: capability discovery -------------------------------------------------------------
  await runProbe('C11-capabilities', '能力探测（声明 vs 观测，不启动浏览器）', 'capture{version,transport,coordinateSpace,scaleRange,maxOutputPixels,supports,output,observed} + limits.capture；observed 先 null 后非 null；无 URL/绝对路径；关闭页面后仍可读', async () => {
    const fresh = await createHarness({ name: 'capture-p0-caps' });
    state.harnesses.push(fresh);
    try {
      const cold = await fresh.invoke('browser_capabilities');
      const captureBlock = cold.value?.capture || {};
      // Explicit scale range is 0.1–4 and an omitted scale follows the shared view.scale
      // (docs/viewport-control.md §6.1/§6.2, Lead freeze 2026-11-01) — the old [1,4] bound was the
      // pre-viewport contract.
      check('C11 冷启动 capabilities.capture 声明完整', captureBlock.version === 1 && captureBlock.transport === 'cdp-page-capture-screenshot'
        && captureBlock.coordinateSpace === 'document-css-px' && JSON.stringify(captureBlock.scaleRange) === '[0.1,4]'
        && captureBlock.defaultScaleSource === 'view.scale' && captureBlock.defaultScale === 1
        && captureBlock.maxOutputPixels === 16000000 && captureBlock.supports?.region === true && captureBlock.supports?.noClobber === true
        && captureBlock.output?.defaultMode === 'staging' && captureBlock.output?.noClobber === true
        && captureBlock.output?.workspaceRoot === '<workspace>', captureBlock);
      check('C11 limits.capture 声明完整', cold.value?.limits?.capture?.maxRegionPixels === 16000000 && cold.value?.limits?.capture?.noClobber === true
        && cold.value?.limits?.capture?.env === 'DSH_UI_TESTING_CAPTURE_DIR', cold.value?.limits?.capture);
      check('C11 首次截图前 observed = null', captureBlock.observed === null, captureBlock.observed);
      check('C11 冷启动不创建 page（runtime.running=false）', cold.value?.runtime?.running === false, cold.value?.runtime?.running);

      await fresh.invoke('browser_navigate', { url: pageUrl });
      await waitForEval(fresh, 'document.readyState', (value) => value === 'complete', { label: 'readyState complete' });
      const shot = await fresh.invoke('browser_screenshot', { scale: 2 });
      check('C11 截图成功（observed 前置）', shot.ok === true, errorInfo(shot));
      const warm = await fresh.invoke('browser_capabilities');
      const observed = warm.value?.capture?.observed;
      check('C11 截图后 observed 非 null 且含 png/尺寸校验事实', observed && observed.png?.width === 2560 && observed.png?.height === 1600
        && observed.sizeCheck?.ok === true && observed.scale === 2 && typeof observed.anomaly?.checked === 'boolean'
        && (observed.file === null || typeof observed.file?.relativePath === 'string'), observed);
      check('C11 observed.file 是 {persistence, relativePath}（持久时为相对路径）',
        !observed?.file || (observed.file.persistence === 'persistent' && typeof observed.file.relativePath === 'string'
          && !String(observed.file.relativePath).startsWith('/')), observed?.file);

      await fresh.closeBrowser();
      const coldAfterClose = await fresh.invoke('browser_capabilities');
      check('C11 关闭页面后仍返回 capture 声明（不启动浏览器）', coldAfterClose.value?.capture?.version === 1 && coldAfterClose.value?.runtime?.running === false, { running: coldAfterClose.value?.runtime?.running, captureVersion: coldAfterClose.value?.capture?.version });
      const serialized = JSON.stringify({ capture: warm.value?.capture, limits: warm.value?.limits?.capture });
      check('C11 capture 声明/observed 不含页 URL 原文与绝对路径', !serialized.includes(pageUrl) && !serialized.includes(state.captureRoot) && !serialized.includes('/home/'),
        { hasUrl: serialized.includes(pageUrl), hasRoot: serialized.includes(state.captureRoot), hasHome: serialized.includes('/home/') });
      // 30 tools: 10 T1 (9 historical + browser_viewport) + 7 T2 + 6 T3 + 7 network.
      check('C11 30 工具与 web.t1.* 投影（带 tool 的 web.t1.* 为 10 项）', warm.value?.capabilities?.filter((item) => item.id.startsWith('web.t1.') && item.tool).length === 10,
        warm.value?.capabilities?.filter((item) => item.id.startsWith('web.t1.') && item.tool).map((item) => item.id));
    } finally {
      try { await fresh.closeBrowser(); } catch { /* ignore */ }
      try { await fresh.dispose(); } catch { /* ignore */ }
    }
  });

  // ---- C14: staging (default) vs persistent (out / persist / env) -----------------------------
  await runProbe('C14-staging-persist', '暂存/持久语义：默认不落工作区', '默认写插件暂存根并返回绝对路径；out/persist:true/env 才持久；legacy 无根时持久请求被拒；dispose 删除暂存根；capabilities 声明 staging', async () => {
    const envBefore = process.env.DSH_UI_TESTING_CAPTURE_DIR;
    const repoOutputBefore = existsSync(join(REPO_ROOT, 'output'));
    const cwdRoot = await mkdtemp(join(tmpdir(), 'dsh-ui-testing-c14-cwd-'));
    const countFiles = async (dir) => (await listFilesRecursive(dir)).length;
    try {
      // ---- C14a: no env + no out/persist -> staging --------------------------------------
      delete process.env.DSH_UI_TESTING_CAPTURE_DIR;
      const staging = await capture({}, 'c14a-staging.png');
      const stagingFile = staging.value.capture?.file || {};
      check('C14a 默认（无 env/out/persist）persistence=staging', stagingFile.persistence === 'staging', stagingFile);
      check('C14a pathKind=absolute / root=staging / ephemeral=true',
        stagingFile.pathKind === 'absolute' && stagingFile.root === 'staging' && stagingFile.ephemeral === true, stagingFile);
      check('C14a 暂存路径是绝对路径且文件存在', typeof stagingFile.path === 'string' && stagingFile.path.startsWith('/') && existsSync(stagingFile.path), stagingFile.path);
      const stagingDisk = stagingFile.path && existsSync(stagingFile.path) ? await readFile(stagingFile.path) : Buffer.alloc(0);
      check('C14a 暂存文件 0600 且 sha256(base64)=磁盘=返回值',
        stagingFile.path && existsSync(stagingFile.path) && (statSync(stagingFile.path).mode & 0o777) === 0o600
          && sha256(stagingDisk) === sha256(staging.bytes) && stagingFile.sha256 === sha256(staging.bytes),
        { mode: stagingFile.path && existsSync(stagingFile.path) ? (statSync(stagingFile.path).mode & 0o777).toString(8) : null });
      check('C14a 默认调用不落工作区（仓库与 cwd 无 output/）',
        existsSync(join(REPO_ROOT, 'output')) === repoOutputBefore && !existsSync(join(cwdRoot, 'output')),
        { repoOutputBefore, repoOutputAfter: existsSync(join(REPO_ROOT, 'output')), cwdOutput: existsSync(join(cwdRoot, 'output')) });
      check('C14a capture.request.persist=false', staging.value.capture?.request?.persist === false, staging.value.capture?.request);

      const stagingDir = stagingFile.path ? dirname(stagingFile.path) : null;

      // ---- C14b: legacy (no exec.agent) default is staging too ---------------------------
      const legacy = await harness.invoke('browser_screenshot');
      check('C14b legacy 默认调用同样 staging（不再 file=null/capture_file_unavailable）',
        legacy.ok === true && legacy.value?.capture?.file?.persistence === 'staging'
          && legacy.value?.capture?.warnings?.includes('capture_file_unavailable') !== true,
        { file: legacy.value?.capture?.file, warnings: legacy.value?.capture?.warnings, error: errorInfo(legacy) });

      // ---- C14c: legacy + persist/out -> OUTPUT_PATH_INVALID(root_unknown), zero files -----
      const stagingBefore = stagingDir ? await countFiles(stagingDir) : 0;
      const legacyPersist = await harness.invoke('browser_screenshot', { persist: true });
      check('C14c legacy persist:true -> OUTPUT_PATH_INVALID(root_unknown)',
        hasErrorCode(legacyPersist, 'OUTPUT_PATH_INVALID') && legacyPersist.error?.details?.reason === 'root_unknown'
          && legacyPersist.error?.category === 'input' && legacyPersist.error?.retryable === false, errorInfo(legacyPersist));
      const legacyOut = await harness.invoke('browser_screenshot', { out: 'x.png' });
      check('C14c legacy out -> OUTPUT_PATH_INVALID(root_unknown)',
        hasErrorCode(legacyOut, 'OUTPUT_PATH_INVALID') && legacyOut.error?.details?.reason === 'root_unknown', errorInfo(legacyOut));

      // ---- C14d: persist must be boolean --------------------------------------------------
      for (const [value, label] of [['true', "'true'"], [1, '1'], [{}, 'object']]) {
        const bad = await harness.invoke('browser_screenshot', { persist: value });
        check(`C14d persist=${label} -> INVALID_ARGUMENT`, hasErrorCode(bad, 'INVALID_ARGUMENT') && bad.error?.category === 'input', errorInfo(bad));
      }
      check('C14c/C14d 被拒后暂存根无新增文件', stagingDir ? (await countFiles(stagingDir)) === stagingBefore : false,
        { before: stagingBefore, after: stagingDir ? await countFiles(stagingDir) : null });

      // ---- C14e: workspace cwd root (persist:true / out), then env root -------------------
      const cwdHarness = await createHarness({
        name: 'capture-p0-c14-cwd',
        sessions: createFakeSessionsService({ cwd: cwdRoot }),
        workspaceRegistry: createFakeWorkspaceRegistry({ path: cwdRoot, id: 'capture-p0-c14' }),
      });
      state.harnesses.push(cwdHarness);
      const execCwd = { agent: { id: 'c14-cwd-agent', session: { header: { cwd: cwdRoot } } } };
      await cwdHarness.invoke('browser_navigate', { url: pageUrl }, execCwd);
      await waitForEval(cwdHarness, 'document.readyState', (value) => value === 'complete', { label: 'c14 readyState' });

      const persisted = await cwdHarness.invoke('browser_screenshot', { persist: true }, execCwd);
      const persistedFile = persisted.value?.capture?.file || {};
      check('C14e persist:true 写入会话 cwd（persistent/relative/workspace）',
        persisted.ok === true && persistedFile.persistence === 'persistent' && persistedFile.pathKind === 'relative'
          && persistedFile.root === 'workspace' && persistedFile.ephemeral === false,
        { file: persistedFile, error: errorInfo(persisted) });
      check('C14e persist:true 默认名 output/capture/<actionId>.png 且文件真实存在',
        /^output\/capture\/[0-9a-f-]{36}\.png$/.test(String(persistedFile.path || ''))
          && existsSync(join(cwdRoot, String(persistedFile.path || ''))), persistedFile.path);

      const outShot = await cwdHarness.invoke('browser_screenshot', { out: 'sub/x.png' }, execCwd);
      const outFile = outShot.value?.capture?.file || {};
      check('C14e out=sub/x.png 写入 cwd 且 pathKind=relative',
        outShot.ok === true && outFile.path === 'sub/x.png' && outFile.persistence === 'persistent'
          && outFile.pathKind === 'relative' && outFile.root === 'workspace' && existsSync(join(cwdRoot, 'sub/x.png')),
        { file: outFile, error: errorInfo(outShot) });

      process.env.DSH_UI_TESTING_CAPTURE_DIR = envBefore;
      const envShot = await cwdHarness.invoke('browser_screenshot', { persist: true }, execCwd);
      const envFile = envShot.value?.capture?.file || {};
      check('C14e env 存在时 root=env 且相对 env 根',
        envShot.ok === true && envFile.root === 'env' && envFile.persistence === 'persistent'
          && envFile.pathKind === 'relative' && existsSync(join(envBefore, String(envFile.path || ''))),
        { file: envFile, error: errorInfo(envShot) });

      // ---- C14f: dispose removes the staging root ---------------------------------------
      delete process.env.DSH_UI_TESTING_CAPTURE_DIR;
      const stagingHarness = await createHarness({ name: 'capture-p0-c14-staging' });
      let stagingRootPath = null;
      try {
        await stagingHarness.invoke('browser_navigate', { url: pageUrl });
        await waitForEval(stagingHarness, 'document.readyState', (value) => value === 'complete', { label: 'c14f readyState' });
        const shot = await stagingHarness.invoke('browser_screenshot');
        const absolute = shot.value?.capture?.file?.path;
        stagingRootPath = shot.value?.capture?.file?.persistence === 'staging' && absolute ? dirname(absolute) : null;
        check('C14f 独立 harness 暂存根存在', Boolean(stagingRootPath) && existsSync(stagingRootPath), { path: absolute });
      } finally {
        try { await stagingHarness.closeBrowser(); } catch { /* ignore */ }
        try { await stagingHarness.dispose(); } catch { /* ignore */ }
      }
      check('C14f 插件 dispose 后暂存根被删除', Boolean(stagingRootPath) && !existsSync(stagingRootPath), stagingRootPath);

      // ---- C14g: capabilities declaration ------------------------------------------------
      const caps = await harness.invoke('browser_capabilities');
      const output = caps.value?.capture?.output || {};
      check('C14g capture.output.defaultMode=staging / persistRules 三项 / ephemeral=true',
        output.defaultMode === 'staging' && output.ephemeral === true
          && JSON.stringify(output.persistRules) === JSON.stringify(['out', 'persist:true', 'DSH_UI_TESTING_CAPTURE_DIR'])
          && output.stagingRoot === '<tmp>/dsh-ui-testing-capture-*' && output.workspaceRoot === '<workspace>', output);
      const limitsCapture = caps.value?.limits?.capture || {};
      check('C14g limits.capture 声明 staging/persistParam/pathKind',
        limitsCapture.staging === true && limitsCapture.persistParam === true
          && JSON.stringify(limitsCapture.pathKind) === JSON.stringify(['relative', 'absolute']), limitsCapture);
      const observed = caps.value?.capture?.observed;
      check('C14g observed.file 在 staging 时 relativePath=null 且只含 persistence/relativePath',
        observed?.file && observed.file.persistence === 'staging' && observed.file.relativePath === null
          && Object.keys(observed.file).sort().join(',') === 'persistence,relativePath', observed?.file);
      const captureJson = JSON.stringify({ capture: caps.value?.capture, limits: caps.value?.limits?.capture });
      check('C14g capture 声明与 observed 不含绝对路径', !captureJson.includes('/tmp/') && !captureJson.includes(REPO_ROOT),
        { hasTmp: captureJson.includes('/tmp/'), hasRepo: captureJson.includes(REPO_ROOT) });
    } finally {
      if (envBefore === undefined) delete process.env.DSH_UI_TESTING_CAPTURE_DIR;
      else process.env.DSH_UI_TESTING_CAPTURE_DIR = envBefore;
      await rm(cwdRoot, { recursive: true, force: true }).catch(() => {});
    }
  });

  // ---- C13: captureBeyondViewport must not leave layout changes -------------------------------
  await runProbe('C13-layout-stability', 'captureBeyondViewport 副作用（截图前后布局一致）', '视口外 region 截图前后 scrollX/Y、视口尺寸、#cap-red/#cap-doc-green/#cap-fixed 的 rect 完全不变', async () => {
    await harness.invoke('browser_eval', { expression: 'window.scrollTo(0, 0)' });
    await waitForEval(harness, 'window.scrollY', (value) => value === 0, { label: 'scrollY 0' });
    const readLayout = async () => {
      const result = await harness.invoke('browser_eval', {
        expression: `(() => {
          const box = (id) => { const element = document.getElementById(id); if (!element) return null; const r = element.getBoundingClientRect(); return { x: r.x, y: r.y, width: r.width, height: r.height }; };
          return { scrollX: window.scrollX, scrollY: window.scrollY, innerWidth: window.innerWidth, innerHeight: window.innerHeight,
            red: box('cap-red'), green: box('cap-doc-green'), fixed: box('cap-fixed') };
        })()`,
      });
      return result.value?.value;
    };
    const before = await readLayout();
    const shot = await capture({ region: { x: 20, y: 1500, width: 40, height: 40 } }, 'c13-outside-viewport.png');
    const after = await readLayout();
    check('C13 视口外截图成功 40x40', shot.result.ok === true && shot.value.capture?.png?.width === 40 && shot.value.capture?.png?.height === 40, shot.value.capture?.png || errorInfo(shot.result));
    check('C13 截图前后布局读数完整', Boolean(before && after && before.red && before.green && before.fixed), { before, after });
    const same = (key) => JSON.stringify(before?.[key]) === JSON.stringify(after?.[key]);
    check('C13 scrollX/scrollY 不变', same('scrollX') && same('scrollY'), { before: [before?.scrollX, before?.scrollY], after: [after?.scrollX, after?.scrollY] });
    check('C13 视口尺寸不变', same('innerWidth') && same('innerHeight'), { before: [before?.innerWidth, before?.innerHeight], after: [after?.innerWidth, after?.innerHeight] });
    check('C13 #cap-red rect 不变', same('red'), { before: before?.red, after: after?.red });
    check('C13 #cap-doc-green rect 不变', same('green'), { before: before?.green, after: after?.green });
    check('C13 #cap-fixed rect 不变（position:fixed 未受 captureBeyondViewport 影响）', same('fixed'), { before: before?.fixed, after: after?.fixed });
    report.observations.layoutStability = {
      conclusion: '已测 Chrome/本页未观察到持久布局变化；不推广为所有页面无副作用（position:fixed 的瞬时影响只在截图期间可能发生，本探针只比较截图前后的稳定读数）。',
      before: jsonSafe(before),
      after: jsonSafe(after),
    };
  });

  // ---- C15: canvas-space composite (P0-C v2, docs/viewport-control.md §6.1) --------------------
  await runProbe('C15-canvas-composite', 'Canvas 空间截图：O=0 原路径 / O≠0 白底合成（mapping/blank/16M）',
    'O=0 保持单次 CDP PNG 不合成；O≠0 默认与负 region 都按 canvas CSS 合成：四边 blank 纯白、内容按 -O 平移、capture.canvas/mapping.canvas/contentRect/blank/composite:true 齐全；全 blank region 全白且 pageCapture=null；16M 按最终合成图拒绝；截图后复位', async () => {
      const setView = (patch) => harness.invoke('browser_viewport', { action: 'set', ...patch });

      await openPage(pageUrl, 'P0 Capture Fixture');
      const baseline = await setView({ width: 800, height: 600, scale: 1, x: 0, y: 0 });
      check('C15 基准 800×600/C=0/O=0',
        baseline.ok === true && baseline.value?.view?.canvasX === 0 && baseline.value?.view?.canvasY === 0
          && baseline.value?.offset?.x === 0 && baseline.value?.offset?.y === 0,
        { view: baseline.value?.view, offset: baseline.value?.offset }, { width: 800, height: 600, offset: 0 });

      // ---- O = 0: old single-CDP-PNG path, explicitly not composited ------------------------
      const plain = await capture({}, 'c15-o0.png');
      const plainCap = plain.value.capture || {};
      check('C15 O=0：composite=false、pageCapture=null，request/mapping 仍是 document-css-px',
        plain.result.ok === true && plainCap.composite === false && plainCap.pageCapture === null
          && plainCap.request?.space === 'canvas-css-px' && plainCap.request?.coordinateSpace === 'document-css-px'
          && plainCap.mapping?.coordinateSpace === 'document-css-px'
          && plainCap.mapping?.canvas?.composite === false
          && plainCap.mapping?.canvas?.offsetX === 0 && plainCap.mapping?.canvas?.offsetY === 0,
        { composite: plainCap.composite, pageCapture: plainCap.pageCapture, request: plainCap.request, mapping: plainCap.mapping },
        { composite: false, coordinateSpace: 'document-css-px' });
      check('C15 O=0 PNG 800×600 且 canvas.offset=0、content 来自实测',
        plainCap.png?.width === 800 && plainCap.png?.height === 600
          && plainCap.canvas?.x === 0 && plainCap.canvas?.y === 0
          && Number.isFinite(plainCap.canvas?.contentWidth) && Number.isFinite(plainCap.canvas?.contentHeight),
        { png: plainCap.png, canvas: plainCap.canvas }, { width: 800, height: 600, offset: 0 });

      // ---- O ≠ 0: composite ---------------------------------------------------------------
      const negative = await setView({ canvasX: -100, canvasY: -50 });
      check('C15 canvasX=-100/canvasY=-50 生效（C 权威、S 仍 0）',
        negative.ok === true && negative.value?.view?.canvasX === -100 && negative.value?.view?.canvasY === -50
          && negative.value?.view?.x === 0 && negative.value?.view?.y === 0,
        { view: negative.value?.view, offset: negative.value?.offset }, { canvas: { x: -100, y: -50 }, scroll: { x: 0, y: 0 } });

      const composed = await capture({}, 'c15-canvas.png');
      const cap = composed.value.capture || {};
      const decoded = decodePng(composed.bytes);
      check('C15 O≠0 默认 800×600、composite:true（重编码已披露）、canvas-css-px',
        composed.result.ok === true && cap.png?.width === 800 && cap.png?.height === 600
          && cap.composite === true && cap.canvas?.composite === true
          && cap.canvas?.source === 'cdp-page-capture-screenshot'
          && cap.request?.coordinateSpace === 'canvas-css-px'
          && cap.mapping?.coordinateSpace === 'canvas-css-px',
        { png: cap.png, composite: cap.composite, canvas: cap.canvas, request: cap.request, mapping: cap.mapping?.coordinateSpace },
        { composite: true, coordinateSpace: 'canvas-css-px' });
      check('C15 capture.canvas：C/S/O、content、blank=#ffffff',
        cap.canvas?.x === -100 && cap.canvas?.y === -50
          && cap.canvas?.scrollX === 0 && cap.canvas?.scrollY === 0
          && cap.canvas?.offsetX === -100 && cap.canvas?.offsetY === -50
          && cap.canvas?.contentWidth === 800 && cap.canvas?.contentHeight === 2600
          && cap.canvas?.blank === '#ffffff',
        cap.canvas, 'C/S/O + content');
      check('C15 mapping.canvas / contentRect / blank / cssPerPixel 齐全',
        cap.mapping?.canvas?.offsetX === -100 && cap.mapping?.canvas?.offsetY === -50
          && JSON.stringify(cap.mapping?.contentRect) === JSON.stringify({ x: 0, y: 0, width: 700, height: 550 })
          && cap.mapping?.blank === 'outside-content'
          && cap.mapping?.cssPerPixel?.x === 1 && cap.mapping?.cssPerPixel?.y === 1,
        { canvas: cap.mapping?.canvas, contentRect: cap.mapping?.contentRect, blank: cap.mapping?.blank, cssPerPixel: cap.mapping?.cssPerPixel },
        'mapping canvas fields');
      check('C15 pageCapture 记录真实页面 clip = canvas∩content',
        JSON.stringify(cap.pageCapture?.clip) === JSON.stringify({ x: 0, y: 0, width: 700, height: 550 })
          && cap.pageCapture?.width === 700 && cap.pageCapture?.height === 550,
        cap.pageCapture, { clip: { x: 0, y: 0, width: 700, height: 550 } });
      check('C15 合成 PNG 可独立解码为 800×600 RGBA', decoded.ok === true && decoded.width === 800 && decoded.height === 600,
        decoded.ok ? { width: decoded.width, height: decoded.height, channels: decoded.channels } : decoded, { width: 800, height: 600 });
      const safePixel = (x, y) => (decoded.ok ? pixelAt(decoded, x, y) : null);
      const isWhite = (p) => Boolean(p) && p.r === 255 && p.g === 255 && p.b === 255;
      check('C15 四边 blank 纯白（左 100 / 上 50 / 右 100 / 下 50）',
        isWhite(safePixel(10, 300)) && isWhite(safePixel(400, 10)) && isWhite(safePixel(790, 300)) && isWhite(safePixel(400, 590)),
        { left: safePixel(10, 300), top: safePixel(400, 10), right: safePixel(790, 300), bottom: safePixel(400, 590) }, 'white blank');
      check('C15 内容按 -O 平移：#cap-red → 图像 (120,70)+、#cap-blue → (220,70)+',
        JSON.stringify(safePixel(130, 80)) === JSON.stringify({ r: 255, g: 0, b: 0, a: 255 })
          && safePixel(230, 80)?.r === 0 && safePixel(230, 80)?.g === 128 && safePixel(230, 80)?.b === 255,
        { red: safePixel(130, 80), blue: safePixel(230, 80) }, { red: [255, 0, 0], blue: [0, 128, 255] });
      // scale 2 on the same composite geometry: output=round(800×2)×round(600×2), content/blank
      // scaled by the same factor (docs/viewport-control.md §6.1 step 2).
      const scaled = await capture({ scale: 2 }, 'c15-canvas-scale2.png');
      const scaledCap = scaled.value.capture || {};
      const scaledDecoded = decodePng(scaled.bytes);
      const scaledAt = (x, y) => (scaledDecoded.ok ? pixelAt(scaledDecoded, x, y) : null);
      check('C15 合成 + scale=2：1600×1200、左 200/上 100 blank、#cap-red 落在 (240,140)',
        scaled.result.ok === true && scaledDecoded.ok === true
          && scaledDecoded.width === 1600 && scaledDecoded.height === 1200
          && isWhite(scaledAt(10, 600)) && isWhite(scaledAt(800, 10))
          && scaledAt(250, 150)?.r === 255 && scaledAt(250, 150)?.g === 0 && scaledAt(250, 150)?.b === 0
          && scaledCap.mapping?.cssPerPixel?.x === 0.5,
        scaledDecoded.ok
          ? { size: [scaledDecoded.width, scaledDecoded.height], left: scaledAt(10, 600), top: scaledAt(800, 10), red: scaledAt(250, 150), cssPerPixel: scaledCap.mapping?.cssPerPixel }
          : scaledDecoded,
        { size: [1600, 1200], red: [255, 0, 0], cssPerPixel: 0.5 });

      const composedDisk = cap.file?.path ? join(state.captureRoot, cap.file.path) : '';
      check('C15 合成字节与落盘文件一致（sha256 同一份）',
        Boolean(composedDisk) && existsSync(composedDisk)
          && sha256(composed.bytes) === cap.file?.sha256
          && sha256(await readFile(composedDisk)) === cap.file?.sha256,
        { file: cap.file?.sha256, base64: sha256(composed.bytes), disk: existsSync(composedDisk) ? sha256(await readFile(composedDisk)) : null }, 'same bytes');

      // ---- negative explicit region -------------------------------------------------------
      const negativeRegion = await capture({ region: { x: -200, y: -100, width: 300, height: 200 } }, 'c15-region-negative.png');
      const nrCap = negativeRegion.value.capture || {};
      const nrDecoded = decodePng(negativeRegion.bytes);
      const nrAt = (x, y) => (nrDecoded.ok ? pixelAt(nrDecoded, x, y) : null);
      check('C15 负 region 按 canvas 合成：300×200、contentRect={0,0,100,100}、pageCapture.clip 同值',
        negativeRegion.result.ok === true && nrCap.png?.width === 300 && nrCap.png?.height === 200
          && JSON.stringify(nrCap.contentRect) === JSON.stringify({ x: 0, y: 0, width: 100, height: 100 })
          && JSON.stringify(nrCap.pageCapture?.clip) === JSON.stringify({ x: 0, y: 0, width: 100, height: 100 })
          && nrCap.mapping?.coordinateSpace === 'canvas-css-px',
        { png: nrCap.png, contentRect: nrCap.contentRect, pageCapture: nrCap.pageCapture }, 'negative region');
      check('C15 负 region 像素：blank 纯白、#cap-red 落在 (230,130)',
        isWhite(nrAt(10, 10)) && nrAt(230, 130)?.r === 255 && nrAt(230, 130)?.g === 0 && nrAt(230, 130)?.b === 0,
        { blank: nrAt(10, 10), red: nrAt(230, 130) }, { blank: 'white', red: [255, 0, 0] });

      // ---- fully blank region -------------------------------------------------------------
      const blankRegion = await capture({ region: { x: -500, y: -100, width: 100, height: 100 } }, 'c15-region-blank.png');
      const brCap = blankRegion.value.capture || {};
      const brDecoded = decodePng(blankRegion.bytes);
      const blankAll = brDecoded.ok ? everyPixelIs(brDecoded, { r: 255, g: 255, b: 255 }) : { ok: false };
      check('C15 全 blank region：100×100 全白、pageCapture=null、contentRect 0×0、composite=true',
        blankRegion.result.ok === true && brCap.png?.width === 100 && brCap.png?.height === 100
          && blankAll.ok === true && brCap.pageCapture === null
          && brCap.contentRect?.width === 0 && brCap.contentRect?.height === 0
          && brCap.composite === true,
        { png: brCap.png, pageCapture: brCap.pageCapture, contentRect: brCap.contentRect, every: blankAll }, 'all blank');

      // ---- positive O beyond the scroll max ----------------------------------------------
      const viewportFacts = await harness.invoke('browser_eval', {
        expression: '({ maxY: document.documentElement.scrollHeight - window.innerHeight })',
      });
      const maxY = viewportFacts.value?.value?.maxY;
      const beyond = await setView({ canvasX: 0, canvasY: maxY + 57 });
      check('C15 建立正向 O=57（canvasY=maxY+57 → S 停在 maxY）',
        beyond.ok === true && beyond.value?.offset?.y === 57 && beyond.value?.view?.y === maxY,
        { view: beyond.value?.view, offset: beyond.value?.offset, maxY }, { offsetY: 57 });
      const beyondShot = await capture({}, 'c15-beyond.png');
      const beyondCap = beyondShot.value.capture || {};
      // pageCapture.clip 是 canvas/document 坐标（clip.y = C = maxY + 57）；内容在输出里贴到 y=0，
      // 底部 57px 是 blank。这是“正向 O 露 blank”的几何真值。
      check('C15 正向 O：pageCapture.clip.y=C=maxY+57、高 543、offsetY=57（底部 57px blank）',
        beyondShot.result.ok === true
          && beyondCap.pageCapture?.clip?.y === maxY + 57 && beyondCap.pageCapture?.clip?.height === 543
          && beyondCap.contentRect?.y === maxY + 57 && beyondCap.contentRect?.height === 543
          && beyondCap.canvas?.offsetY === 57 && beyondCap.canvas?.y === maxY + 57,
        { clip: beyondCap.pageCapture?.clip, contentRect: beyondCap.contentRect, canvas: beyondCap.canvas, maxY },
        { clipY: maxY + 57, clipHeight: 543, offsetY: 57 });

      // ---- 16M budget on the final composited image --------------------------------------
      const filesBefore = (await listFilesRecursive(state.captureRoot)).length;
      await setView({ width: 4096, height: 4096 });
      const tooLarge = await capture({}, 'c15-too-large.png');
      check('C15 16M 预算按最终合成图：4096×4096 + O≠0 → CAPTURE_TOO_LARGE 且不写文件',
        hasErrorCode(tooLarge.result, 'CAPTURE_TOO_LARGE')
          && (await listFilesRecursive(state.captureRoot)).length === filesBefore,
        { error: errorInfo(tooLarge.result), filesBefore, filesAfter: (await listFilesRecursive(state.captureRoot)).length }, 'CAPTURE_TOO_LARGE');

      // ---- restore ------------------------------------------------------------------------
      await setView({ width: 800, height: 600, canvasX: 0, canvasY: 0 });
      const restored = (await harness.invoke('browser_viewport', { action: 'get' })).value?.view;
      check('C15 复位 view 800×600/C=0/O=0（供后续探针）',
        restored?.width === 800 && restored?.height === 600
          && restored?.canvasX === 0 && restored?.canvasY === 0 && restored?.x === 0 && restored?.y === 0,
        restored, { width: 800, height: 600, canvas: 0 });
    });

  // ---- C12: cleanup / repeatability ----------------------------------------------------------
  await runProbe('C12-cleanup-repeatable', '清理与可重复性（无状态残留）', '关闭全部浏览器、本进程 Chromium 子进程退出、profile 与临时 capture 根删除；两次连续运行都 exit 0', async () => {
    const result = await cleanupResources('suite-complete');
    state.cleanupResult = result;
    check('C12 关闭所有 harness 且无错误', result.closedHarnesses.length === state.harnesses.length && result.errors.length === 0, { closed: result.closedHarnesses, errors: result.errors });
    check('C12 本进程的 Chromium 子进程全部退出', result.leftoverChromePids.length === 0, result.leftoverChromePids);
    check('C12 本次运行的临时 profile 全部删除', result.leftoverProfileDirs.length === 0, result.leftoverProfileDirs);
    check('C12 临时 capture 根已删除', !existsSync(state.captureRoot), state.captureRoot);
    check('C12 本次运行没有在仓库里创建 output/（默认落盘在临时根）',
      existsSync(join(REPO_ROOT, 'output')) === state.repoOutputBefore,
      { repoOutputBefore: state.repoOutputBefore, repoOutputAfter: existsSync(join(REPO_ROOT, 'output')) });
    finding('C12-two-runs', 'info', '本脚本按“每次运行独立 capture 根 + 独立 Chromium profile”设计；连续两次运行的必需项计数记录在报告 runIndex 与本次交接中（外部执行）。');
  });

  report.observations.captureRoot = state.captureRoot;
  await writeReport();
  return report.summary.exitCode;
}

/* ------------------------------------------------------------------------------------------------
 * Cleanup
 * ---------------------------------------------------------------------------------------------- */

async function cleanupResources(reason) {
  if (state.cleanupResult) return state.cleanupResult;
  const result = {
    reason,
    closedHarnesses: [],
    killedPids: [],
    removedProfileDirs: [],
    leftoverProfileDirs: [],
    leftoverChromePids: [],
    fixtureClosed: false,
    captureRootRemoved: false,
    errors: [],
  };
  for (const harness of state.harnesses) {
    try { await harness.closeBrowser(); result.closedHarnesses.push(harness.name); }
    catch (error) { result.errors.push(`close ${harness.name}: ${error && error.message ? error.message : String(error)}`); }
  }
  await sleep(1200);
  for (const harness of state.harnesses) {
    try { await harness.dispose(); } catch (error) { result.errors.push(`dispose ${harness.name}: ${error && error.message ? error.message : String(error)}`); }
  }
  const harnessModule = await import(pathToFileURL(join(HERE, 'harness.mjs')).href);
  const stray = harnessModule.scanPluginChromeProcesses().filter((proc) => proc.parentPid === process.pid);
  for (const proc of stray) {
    try { process.kill(proc.pid, 'SIGTERM'); } catch { /* ignore */ }
  }
  if (stray.length) await sleep(1200);
  for (const proc of stray) {
    if (harnessModule.isProcessAlive(proc.pid)) {
      try { process.kill(proc.pid, 'SIGKILL'); } catch { /* ignore */ }
    }
    if (!harnessModule.isProcessAlive(proc.pid)) result.killedPids.push(proc.pid);
  }
  await sleep(300);
  const profilesAfter = await harnessModule.snapshotProfileDirs();
  const created = profilesAfter.filter((dir) => !state.profilesBefore.includes(dir));
  for (const dir of created) {
    if (!dir.startsWith(tmpdir())) continue;
    try { await rm(dir, { recursive: true, force: true }); result.removedProfileDirs.push(dir); }
    catch (error) { result.errors.push(`rm profile ${dir}: ${error && error.message ? error.message : String(error)}`); }
  }
  result.leftoverProfileDirs = (await harnessModule.snapshotProfileDirs()).filter((dir) => !state.profilesBefore.includes(dir));
  result.leftoverChromePids = stray.filter((proc) => harnessModule.isProcessAlive(proc.pid)).map((proc) => proc.pid);
  if (state.fixture) {
    try { await state.fixture.close(); result.fixtureClosed = true; }
    catch (error) { result.errors.push(`fixture close: ${error && error.message ? error.message : String(error)}`); }
  }
  if (state.captureRoot) {
    try { await rm(state.captureRoot, { recursive: true, force: true }); result.captureRootRemoved = !existsSync(state.captureRoot); }
    catch (error) { result.errors.push(`rm capture root: ${error && error.message ? error.message : String(error)}`); }
  }
  log(`\n[cleanup] ${reason}: ${JSON.stringify(jsonSafe(result))}`);
  return result;
}

/* ------------------------------------------------------------------------------------------------
 * Report
 * ---------------------------------------------------------------------------------------------- */

async function writeReport(overrideExitCode) {
  const required = report.probes
    .filter((probe) => probe.status !== 'skip')
    .flatMap((probe) => probe.checks.filter((item) => !item.advisory));
  const failed = required.filter((item) => !item.pass);
  report.summary = {
    probes: report.probes.length,
    passed: report.probes.filter((probe) => probe.status === 'pass').length,
    failed: report.probes.filter((probe) => probe.status === 'fail').length,
    requiredChecks: required.length,
    failedChecks: failed.length,
    findings: report.findings.length,
    exitCode: overrideExitCode !== undefined ? overrideExitCode : (failed.length > 0 ? 1 : 0),
  };
  report.resources = state.cleanupResult || { reason: 'not-run' };
  await mkdir(EVIDENCE_DIR, { recursive: true });
  await writeFile(join(EVIDENCE_DIR, 'report.json'), JSON.stringify(report, null, 2));
  await writeFile(join(EVIDENCE_DIR, 'run.log'), logLines.join('\n') + '\n');
  log(`\nprobes=${report.summary.probes} pass=${report.summary.passed} fail=${report.summary.failed} requiredChecks=${report.summary.requiredChecks} failedChecks=${report.summary.failedChecks} findings=${report.summary.findings}`);
  log(`evidence: ${EVIDENCE_DIR}`);
  log(`EXIT ${report.summary.exitCode}`);
}

const watchdog = setTimeout(async () => {
  if (state.finished) return;
  log(`\n[watchdog] HARD TIMEOUT after ${TOTAL_TIMEOUT_MS}ms — cleaning up and exiting 2`);
  try { await cleanupResources('hard-timeout'); } catch { /* ignore */ }
  try { await writeReport(); } catch { /* ignore */ }
  process.exit(2);
}, TOTAL_TIMEOUT_MS);
watchdog.unref?.();

let exitCode = 0;
try {
  exitCode = await main();
} catch (error) {
  log(`\n[fatal] ${error && error.message ? error.message : String(error)}`);
  console.error(error);
  report.fatal = jsonSafe({ name: error?.name, message: String(error?.message || error), stack: String(error?.stack || '').split('\n').slice(0, 12) });
  const envUnavailable = error && (error.code === 'UNSUPPORTED' || String(error.message || '').includes('chromium-unavailable'));
  try { await cleanupResources('fatal-error'); } catch { /* ignore */ }
  try { await writeReport(envUnavailable ? 2 : 1); } catch { /* ignore */ }
  exitCode = envUnavailable ? 2 : 1;
} finally {
  state.finished = true;
  clearTimeout(watchdog);
}
process.exitCode = exitCode;
